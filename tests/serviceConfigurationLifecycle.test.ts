import * as runtime from 'vue'
import ServiceConfiguration from '@/src/features/settings/ui/services/ServiceConfiguration.vue'
import {readFileSync} from 'node:fs'
import {parseHTML} from 'linkedom'
import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation'
import {defaultOption, options} from '@/src/core/config/catalog'
import {diagnoseFailure, getDiagnosticText} from '@/src/services/diagnostics'
import {translate} from '@/src/core/i18n'

// 使用实际客户端 SFC 的 setup；只替换与原 SSR 夹具相同的外部端口。
vi.mock('@/src/platform/browser/freeProviderPermissions', () => ({readFreePoolAccess: (...args: unknown[]) => readAccess(...args)}))
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: unknown[]) => send(...args)}}}))
vi.mock('@/src/services/config/store', () => ({waitForConfigPersistenceQueue: () => queue(), requestConfigSave: (...args: unknown[]) => save(...args)}))
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => (globalThis as any)[key].uiI18n}))
vi.mock('@/src/platform/chatgpt-plan/buildMode', () => ({chatGPTPlanDevelopmentEnabled: false}))
vi.mock('element-plus', () => ({ElMessage: {success: (...args: unknown[]) => feedback(...args)}, ElTabs: {}, ElTabPane: {}}))
vi.mock('element-plus/es/components/tabs/style/css', () => ({}))
vi.mock('@/src/platform/browser/chromeTranslationPreparationRequest', () => ({chromeTranslationPreparationStore: {
  get: (...args: unknown[]) => read(...args), clear: (...args: unknown[]) => clear(...args), subscribe: (callback: (value: unknown) => void) => {
    const item = {callback, stopped: false}; subscriptions.push(item); return () => {item.stopped = true}
  },
}}))
vi.mock('@/src/features/settings/model/chromeTranslationPreparation', () => ({
  ChromeTranslationPreparationError: class extends Error {code: unknown; params: unknown; constructor(code: unknown, message: string, params: unknown) {super(message); this.code = code; this.params = params}},
  prepareChromeTranslationInPage: (...args: unknown[]) => prepare(...args),
  resolveChromeTranslationPreparationPair: (from: string, to: string) => ({sourceLanguage: from === 'auto' ? 'en' : from, targetLanguage: to}),
  getChromeTranslationPreparationLanguageLabel: (language: string) => language,
}))
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/components/SegmentedControl.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/ui/components/DownloadProgress.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/PromptTemplateEditor.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/FreeTranslationSettings.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/ApiKeyList.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/ModelVisionSettings.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/RequestLimitSettings.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/RequestHeaderSettings.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/CompositeTranslationSettings.vue', () => ({default: {render: () => null}}))
vi.mock('@/src/features/settings/ui/services/ServiceRepairReturn.vue', () => ({default: {render: () => null}}))
const key = '__frServiceConfigurationLifecycle'
let app: import('vue').App, state: Record<string, any>
let props: {config: Config; service: string; active: boolean; selectedModelThinking: boolean; compute: Record<string, any>;
  options: typeof options; isValidAzureEndpoint: (value: string) => boolean; customProvider?: {id: string; name: string; endpoint: string; models: string[]}}
let visible: import('vue').Ref<boolean>
let uiLanguage: import('vue').Ref<string>, uiBundleRevision: import('vue').Ref<number>
let uiCatalogs: Map<string, Record<string, string>>
const readAccess = vi.fn()
const send = vi.fn(), save = vi.fn(), queue = vi.fn(), read = vi.fn(), clear = vi.fn(), prepare = vi.fn(), confirm = vi.fn(), feedback = vi.fn(), emitDelete = vi.fn(), emitProvider = vi.fn()
const subscriptions: {callback: (value: any) => void; stopped: boolean}[] = []
const releases: (() => void)[] = [], jobs: Promise<unknown>[] = [], confirmations: {resolve: (value?: unknown) => void; reject: (error: unknown) => void}[] = []
function pending() {let resolve!: (value?: any) => void, reject!: (error: unknown) => void
  const promise = new Promise<any>((yes, no) => {resolve = yes;reject = no});releases.push(() => resolve());return {promise, resolve, reject}}
async function settle() {for (let i = 0; i < 16; i++) await Promise.resolve();await runtime.nextTick();await runtime.nextTick()}
function check(single = false) {const job = (single ? state.testSingleApiKey(0) : state.testConnection()) as Promise<void>;jobs.push(job);return job}
function messages() {return send.mock.calls.filter(([message]) => message.type === 'testTranslationService')}
function mutate(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'cached') visible.value = false
  if (reason === 'unmount') app.unmount()
  if (reason === 'config') props.config = runtime.reactive(Object.assign(new Config(), {apiKeys: {...props.config.apiKeys}, token: {...props.config.token}}))
  if (reason === 'service') props.service = 'openai'
  if (reason === 'key') props.config.token.deepseek = 'changed-fixture'
}
function openAction(kind: 'reset' | 'delete') {if (kind === 'reset') state.resetCustomTemplate();else state.confirmDeleteProvider()}
async function acceptAction(index = 0) {
  if (state.serviceActionButtons) state.serviceActionButtons.confirm()
  else confirmations[index]?.resolve()
  await settle()
}
beforeEach(async () => {
  vi.clearAllMocks();subscriptions.length = 0;releases.length = 0;jobs.length = 0;confirmations.length = 0
  readAccess.mockReset();readAccess.mockResolvedValue({supported:false,grantedIds:FREE_TRANSLATION_PROVIDERS.map(p=>p.id),preferredGrant:null})
  queue.mockResolvedValue(undefined);save.mockResolvedValue(undefined);read.mockResolvedValue(null);clear.mockResolvedValue(undefined)
  send.mockResolvedValue({success: true, durationMs: 25});prepare.mockResolvedValue({sourceLanguage: 'en', targetLanguage: 'zh'})
  confirm.mockImplementation(() => {const item = pending();confirmations.push(item);return item.promise})
  uiLanguage = runtime.ref('zh-CN');uiBundleRevision = runtime.ref(0);uiCatalogs = new Map()
  const uiI18n = {language: uiLanguage, bundleRevision: uiBundleRevision, translateLegacy: (text: string) => text,
    t: (name: string, params?: Record<string, string | number>) => {
      void uiBundleRevision.value
      const template = uiCatalogs.get(uiLanguage.value)?.[name] ?? (name.startsWith('diagnostics.') ? translate(name, 'zh-CN', params) : name)
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, field) => params?.[field] === undefined ? placeholder : String(params[field]))
    }}
  Object.assign(globalThis, {[key]: {readAccess, send, save, queue, read, clear, prepare, confirm, feedback, subscriptions, uiI18n}})
  const component = {...ServiceConfiguration, render: () => null}
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
    remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
    setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
    setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]})
  const config = runtime.reactive(new Config());config.model.deepseek = 'future-vision';config.apiKeys.deepseek = ['fixture-first', 'fixture-second'];config.token.deepseek = 'fixture-first'
  props = runtime.reactive({config, service: 'deepseek', active: true, selectedModelThinking: false, options, isValidAzureEndpoint: () => true,
    compute: {showAI: true, showModel: true, showToken: true, requireApiKey: true, showServiceSecret: false}, customProvider: undefined})
  visible = runtime.ref(true);app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
    ? runtime.h(component as runtime.Component, {...props, 'onDelete:custom-provider': emitDelete, 'onUpdate:custom-provider': emitProvider,
      ref: (vm: any) => {if (vm) state = vm.$.setupState}}) : runtime.h({render: () => null}, {key: 'other'})})})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};app.mount({});await settle()
  vi.stubGlobal('window', {setTimeout, clearTimeout})
})
afterEach(async () => {
  app?.unmount();for (const release of releases) release();await settle();await Promise.allSettled(jobs)
  delete (globalThis as any)[key];vi.unstubAllGlobals();vi.useRealTimers()
})

describe('实际服务连接配置的活跃生命周期与确认归属', () => {
  it('Safari免费检查仅请求已授权线路，未授权项不计作provider故障',async()=>{
    props.service='freeTranslation';props.compute.showToken=false;await settle();readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:{id:'google',origins:[]}})
    await check();expect(messages().map(([message])=>message.freeProviderId)).toEqual(['microsoft']);expect(Object.keys(state.freeProviderChecks)).toEqual(['microsoft']);expect(state.connectionTestState).toBe('success')
    send.mockClear();readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});await check();expect(messages()).toHaveLength(0);expect(state.freeProviderChecks).toEqual({});expect(state.connectionTestState).toBe('idle');expect(state.connectionTestMessage).toBe('safari.freePool.permissionState');expect(state.connectionTestTitle).toBe('safari.freePool.permissionState')
  })
  it('Safari零授权提示随语言资源更新且不发provider检查',async()=>{
    props.service='freeTranslation';props.compute.showToken=false;await settle();readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});await check();
    expect(messages()).toHaveLength(0);uiLanguage.value='fr-FR';uiCatalogs.set('fr-FR',{'safari.freePool.permissionState':'Autorisation nécessaire'});uiBundleRevision.value++;await settle();
    expect(state.connectionTestMessage).toBe('Autorisation nécessaire');expect(state.connectionTestTitle).toBe('Autorisation nécessaire');expect(state.connectionTestState).toBe('idle');
  })
  it('免费连接检查跳过目录已移除的线路且不计入失败', async () => {
    props.service = 'freeTranslation';props.compute.showToken = false
    props.config.disabledTranslationServices = ['myMemory'];await settle()
    readAccess.mockResolvedValue({supported: true, grantedIds: ['myMemory', 'microsoft'], preferredGrant: null})
    await check()
    expect(readAccess.mock.calls.at(-1)?.[0]).not.toContain('myMemory')
    expect(messages().map(([message]) => message.freeProviderId)).toEqual(['microsoft'])
    expect(Object.keys(state.freeProviderChecks)).toEqual(['microsoft'])
    expect(state.connectionTestState).toBe('success')
  })
  it('Safari授权变更优先于逐路冷却，撤销后不显示旧诊断且仅重查当前授权线路', async () => {
    vi.useFakeTimers();props.service = 'freeTranslation';props.compute.showToken = false;await settle()
    readAccess.mockResolvedValue({supported: true, grantedIds: ['microsoft'], preferredGrant: null})
    send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1200})})
    await check();expect(state.connectionTestDiagnostic.code).toBe('rate-limit');expect(Object.keys(state.freeProviderChecks)).toEqual(['microsoft'])
    readAccess.mockResolvedValue({supported: true, grantedIds: [], preferredGrant: {id: 'microsoft', origins: []}});send.mockClear()
    await check();expect(messages()).toHaveLength(0);expect(state.connectionTestDiagnostic).toBeNull()
    expect(state.freeProviderChecks).toEqual({});expect(state.connectionTestState).toBe('idle');expect(state.connectionTestMessage).toBe('safari.freePool.permissionState')
    readAccess.mockResolvedValue({supported: true, grantedIds: ['google'], preferredGrant: null})
    await check();expect(messages().map(([message]) => message.freeProviderId)).toEqual(['google'])
    expect(state.connectionTestDiagnostic).toBeNull();expect(state.connectionTestState).toBe('success');expect(Object.keys(state.freeProviderChecks)).toEqual(['google'])
    readAccess.mockResolvedValue({supported: true, grantedIds: ['microsoft'], preferredGrant: null});send.mockClear()
    await check();expect(messages()).toHaveLength(0);expect(state.freeProviderChecks.microsoft.status).toBe('error')
    await vi.advanceTimersByTimeAsync(1200);await check()
    expect(messages().map(([message]) => message.freeProviderId)).toEqual(['microsoft']);expect(state.connectionTestDiagnostic).toBeNull();expect(state.connectionTestState).toBe('success')
  })
  it('Safari权限读取失败保留明确权限提示，不暴露原始详情或误记供应商故障', async () => {
    props.service = 'freeTranslation';props.compute.showToken = false;await settle()
    readAccess.mockRejectedValueOnce(Object.assign(new Error('private-site-permission-detail'), {code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE', kind: 'bad-request'}))
    await check();expect(messages()).toHaveLength(0);expect(state.freeProviderChecks).toEqual({});expect(state.connectionTestDiagnostic).toBeNull()
    expect(state.connectionTestState).toBe('error');expect(state.connectionTestMessage).toBe('safari.freePool.error')
    expect(state.connectionTestMessage).not.toContain('private-site-permission-detail')
    expect(readAccess.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(state.connectionTestBusy).toBe(false)
    uiLanguage.value = 'fr-FR';uiCatalogs.set('fr-FR', {'safari.freePool.error': 'Accès indisponible'});uiBundleRevision.value++;await settle()
    expect(state.connectionTestMessage).toBe('Accès indisponible');expect(messages()).toHaveLength(0)
    readAccess.mockResolvedValueOnce({supported: true, grantedIds: ['google'], preferredGrant: null})
    await check();expect(messages().map(([message]) => message.freeProviderId)).toEqual(['google']);expect(state.connectionTestState).toBe('success')
  })
  it('Safari权限读取等待可取消，迟到授权快照不再发连接测试',async()=>{
    props.service='freeTranslation';props.compute.showToken=false;await settle();const gate=pending();readAccess.mockReturnValue(gate.promise);let ended=false;const job=check().then(()=>{ended=true});await settle();expect(readAccess).toHaveBeenCalledOnce();props.active=false;await settle();expect(ended).toBe(true);gate.resolve({supported:true,grantedIds:['microsoft'],preferredGrant:null});await job;expect(messages()).toHaveLength(0)
  })
  it('公开套餐旧配置没有设置页签，直接测试或提示词操作也不发消息或修改配置', async () => {
    props.config.model.chatgptPlan = 'saved-account-model';props.config.system_role.chatgptPlan = 'saved-system';props.config.user_role.chatgptPlan = 'saved-user'
    props.service = 'chatgptPlan';props.compute.showToken = false;await settle()
    const saved = JSON.stringify(props.config)
    expect(state.settingsTabs).toEqual({translation: false, prompts: false, requests: false, 'custom-request': false})
    expect(state.connectionTestDisabled).toBe(true)
    await state.testConnection();state.activeSettingsTab = 'prompts';await settle();state.resetCustomTemplate();state.syncPromptTemplates();await settle()
    expect(state.serviceActionOpen).toBe(false);expect(send).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(queue).not.toHaveBeenCalled()
    expect(JSON.stringify(props.config)).toBe(saved)
  })
  it('当前模型限额随请求体实际模型变化，选择器模型继续用于其他设置', async () => {
    props.service = 'ollama';props.config.model.ollama = 'gemma3:4b';props.config.customBody.ollama = '{"model":" qwen3:8b "}';await settle()
    expect(state.effectiveModelLabel).toBe('gemma3:4b');expect(state.requestLimitModel).toBe('qwen3:8b')
    props.config.customBody.ollama = '{"model":"{{model}}"}';await settle();expect(state.requestLimitModel).toBe('{{model}}')
    props.config.customBody.ollama = '{invalid';await settle();expect(state.requestLimitModel).toBe('gemma3:4b')
    props.service = 'gemini';props.config.model.gemini = 'gemini-2.5-pro';props.config.customBody.gemini = '{"model":"ignored"}';await settle()
    expect(state.requestLimitModel).toBe('gemini-2.5-pro')
  })

  it.each(['queue', 'save', 'response'])('单Key检查在%s的隐藏、缓存停用或卸载后立即收束且不写迟到结果', async phase => {
    for (const reason of ['hidden', 'cached', 'unmount']) {
      if (reason === 'cached') {props.active = true;await settle()}
      if (reason === 'unmount') {visible.value = true;await settle()}
      const stalled = pending();if (phase === 'queue') queue.mockReturnValueOnce(stalled.promise)
      if (phase === 'save') save.mockReturnValueOnce(stalled.promise)
      if (phase === 'response') send.mockReturnValueOnce(stalled.promise)
      let ended = false;const job = check(true).then(() => {ended = true});await settle();mutate(reason);await settle()
      expect(ended).toBe(true);expect(state.connectionTestBusy).toBe(false);expect(state.connectionTestState).toBe('idle')
      const result = JSON.stringify(state.apiKeyChecks);stalled.resolve({success: true});await job;expect(JSON.stringify(state.apiKeyChecks)).toBe(result)
    }
  })
  it('配置对象替换即使指纹相同也取消旧检查，旧队列不得保存新对象', async () => {
    const waiting = pending();queue.mockReturnValueOnce(waiting.promise);const job = check();await settle();mutate('config');await settle()
    waiting.resolve();await job;expect(save).not.toHaveBeenCalled();expect(messages()).toHaveLength(0);expect(state.connectionTestBusy).toBe(false)
  })
  it('正常多Key检查按先保存后请求执行，停止后保留已完成结果并拒绝旧请求', async () => {
    const second = pending();send.mockResolvedValueOnce({success: true, durationMs: 7}).mockReturnValueOnce(second.promise)
    const job = check();await settle();expect(save).toHaveBeenCalledOnce();expect(messages()).toHaveLength(2)
    expect(state.apiKeyChecks[0]).toMatchObject({status: 'success', durationMs: 7});state.stopApiKeyChecks();await settle()
    expect(state.connectionTestBusy).toBe(false);expect(state.apiKeyChecks[1].status).toBe('idle');second.resolve({success: true});await job
    expect(state.apiKeyChecks[1].status).toBe('idle');expect(state.apiKeyChecks[0].status).toBe('success')
  })
  it('隐藏时不开始检查或编辑密钥、策略、邮箱及自定义服务', async () => {
    props.active = false;await settle();const before = JSON.stringify(props.config);state.myMemoryEmailDraft = 'new@example.com'
    state.commitMyMemoryEmail();state.updateApiKey(0, 'late');state.removeApiKey(0);state.addApiKey();state.setApiKeyRotationEnabled(false)
    state.setApiKeyRequirement({target: {value: 'optional'}});state.updateCustomProvider('name', 'late');await check();await check(true)
    expect(JSON.stringify(props.config)).toBe(before);expect(props.compute.requireApiKey).toBe(true);expect(emitProvider).not.toHaveBeenCalled();expect(queue).not.toHaveBeenCalled()
  })
  it('免费检查覆盖全目录，隐藏时结束三项在途等待，迟到结果不再排队其余服务', async () => {
    props.service = 'freeTranslation';props.compute.showToken = false;await settle();const delayed = pending();send.mockReturnValue(delayed.promise)
    let ended = false;const job = check().then(() => {ended = true});await settle();expect(messages()).toHaveLength(3)
    props.active = false;await settle();expect(ended).toBe(true);delayed.resolve({success: true});await job;expect(messages()).toHaveLength(3)
    props.active = true;send.mockResolvedValue({success: true});await settle();send.mockClear();await check()
    expect(messages().map(([message]) => message.freeProviderId)).toEqual(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id))
  })
  it('Chrome待准备提示只在活跃Chrome服务订阅，旧读和通知不能覆盖新代际', async () => {
    expect(read).not.toHaveBeenCalled();expect(subscriptions).toHaveLength(0)
    const first = pending();read.mockReturnValueOnce(first.promise);props.service = 'chromeTranslator';await settle();expect(subscriptions).toHaveLength(1)
    subscriptions[0].callback({sourceLanguage: 'fr', targetLanguage: 'zh'});await settle();first.resolve({sourceLanguage: 'de', targetLanguage: 'zh'});await settle()
    expect(state.pendingChromePreparation.sourceLanguage).toBe('fr');props.active = false;await settle();expect(subscriptions[0].stopped).toBe(true)
    props.active = true;read.mockResolvedValueOnce({sourceLanguage: 'es', targetLanguage: 'zh'});await settle();subscriptions[0].callback({sourceLanguage: 'de', targetLanguage: 'zh'});await settle()
    expect(state.pendingChromePreparation.sourceLanguage).toBe('es');props.service = 'deepseek';await settle();expect(subscriptions[1].stopped).toBe(true)
  })
  it('Chrome点击立即启动准备，隐藏可中断忽略取消的准备，迟到状态不写界面', async () => {
    props.service = 'chromeTranslator';props.compute.showToken = false;await settle();const delayed = pending();prepare.mockReturnValueOnce(delayed.promise)
    let ended = false;const job = check().then(() => {ended = true});expect(prepare).toHaveBeenCalledOnce();expect(queue).toHaveBeenCalledOnce()
    const input = prepare.mock.calls[0][0];await settle();props.active = false;await settle();expect(input.signal.aborted).toBe(true);expect(ended).toBe(true)
    const before = state.connectionTestMessage;input.onStatus({phase: 'verifying', sourceLanguage: 'en', targetLanguage: 'zh'});delayed.resolve({sourceLanguage: 'en', targetLanguage: 'zh'});await job
    expect(state.connectionTestMessage).toBe(before);expect(clear).not.toHaveBeenCalled()
  })
  it('Chrome准备成功不被挂起的提示清理阻塞，清理只接收已完成语言对', async () => {
    props.service = 'chromeTranslator';props.compute.showToken = false;await settle();const delayed = pending();clear.mockReturnValueOnce(delayed.promise)
    let ended = false;const job = check().then(() => {ended = true});await settle();expect(ended).toBe(true)
    expect(state.connectionTestState).toBe('success');expect(clear).toHaveBeenCalledWith({sourceLanguage: 'en', targetLanguage: 'zh'});delayed.resolve();await job
  })
  it('Chrome总等待预算从点击起计，配置保存耗时也在五分钟内', async () => {
    props.service = 'chromeTranslator';props.compute.showToken = false;await settle();vi.useFakeTimers()
    const waiting = pending(), delayed = pending();queue.mockReturnValueOnce(waiting.promise);prepare.mockReturnValueOnce(delayed.promise)
    let ended = false;const job = check().then(() => {ended = true});await settle();await vi.advanceTimersByTimeAsync(5000)
    waiting.resolve();await settle();await vi.advanceTimersByTimeAsync(294999);expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1);await settle();expect(ended).toBe(true);expect(prepare.mock.calls[0][0].signal.aborted).toBe(true)
    expect(state.connectionTestMessage).toBe('settings.services.chromePreparation.error.timeout');expect(vi.getTimerCount()).toBe(0)
    delayed.resolve({sourceLanguage: 'en', targetLanguage: 'zh'});await job;expect(state.connectionTestState).toBe('error')
  })
  it.each(['queue', 'save', 'response'])('服务%s超时退出，后续重试成功且没有残留计时器', async phase => {
    vi.useFakeTimers();const delayed = pending();if (phase === 'queue') queue.mockReturnValueOnce(delayed.promise)
    if (phase === 'save') save.mockReturnValueOnce(delayed.promise);if (phase === 'response') send.mockReturnValueOnce(delayed.promise)
    let ended = false;const job = check(true).then(() => {ended = true});await settle()
    const timeoutMs = phase === 'response' ? 45000 : 10000
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);await settle()
    expect(ended).toBe(false);expect(state.connectionTestBusy).toBe(true);expect(state.connectionTestState).toBe('testing')
    expect(messages()).toHaveLength(phase === 'response' ? 1 : 0)
    await vi.advanceTimersByTimeAsync(1);await settle();expect(ended).toBe(true)
    expect(state.connectionTestBusy).toBe(false);expect(state.connectionTestState).toBe('error');expect(vi.getTimerCount()).toBe(0)
    expect(state.connectionTestDiagnostic.code).toBe(phase === 'response' ? 'timeout' : 'configuration-save')
    expect(state.apiKeyChecks[0]).toMatchObject({status: 'error', error: getDiagnosticText(state.connectionTestDiagnostic).title})
    delayed.resolve({success: true});await job;await settle()
    expect(state.connectionTestState).toBe('error');expect(state.apiKeyChecks[0].status).toBe('error');expect(vi.getTimerCount()).toBe(0)
    await check(true);await settle()
    expect(state.connectionTestState).toBe('success');expect(state.connectionTestBusy).toBe(false)
    expect(state.apiKeyChecks[0]).toMatchObject({status: 'success', durationMs: 25})
    expect(messages()).toHaveLength(phase === 'response' ? 2 : 1);expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['401 invalid_api_key request-body-secret https://private.example/path?token=fixture', 'authentication'],
    ['429 rate limit account-secret', 'rate-limit'],
    ['model not found: confidential-model', 'model-configuration'],
    ['Failed to fetch https://private.example/private-document', 'network'],
  ])('密钥失败按真实原因 %s 展示安全分类，重试保留服务与已有字段', async (error, code) => {
    const before = JSON.stringify(props.config)
    send.mockResolvedValueOnce({success: false, error})
    await check(true)
    expect(state.connectionTestDiagnostic.code).toBe(code)
    expect(state.apiKeyChecks[0].error).toBe(getDiagnosticText(state.connectionTestDiagnostic).title)
    expect(JSON.stringify([state.apiKeyChecks, state.connectionTestMessage, state.connectionTestDiagnostic])).not.toContain('secret')
    expect(JSON.stringify([state.apiKeyChecks, state.connectionTestMessage, state.connectionTestDiagnostic])).not.toContain('private.example')
    await check(true)
    expect(state.connectionTestState).toBe('success');expect(state.connectionTestDiagnostic).toBeNull()
    expect(JSON.stringify(props.config)).toBe(before);expect(props.service).toBe('deepseek')
  })
  it('供应商要求冷却时仅禁用手动重试、不安排自动请求，离开服务释放计时器', async () => {
    vi.useFakeTimers()
    send.mockResolvedValueOnce({success: false, error: 'private-secret', diagnostic: {...diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1200}), titleKey: 'private-secret', actions: ['refresh']}})
    await check(true);expect(state.connectionTestDiagnostic.code).toBe('rate-limit');expect(state.connectionRetryWaiting).toBe(true)
    expect(state.connectionTestDisabled).toBe(true);await check(true);await check();expect(messages()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1200);await settle();expect(state.connectionRetryWaiting).toBe(false);expect(messages()).toHaveLength(1)
    await check(true);expect(messages()).toHaveLength(2);expect(state.connectionTestState).toBe('success')
    send.mockRejectedValueOnce(Object.assign(new Error('429'), {retryAfterMs: 1200}));await check(true)
    props.service = 'openai';await settle();expect(state.connectionTestDiagnostic).toBeNull();expect(state.connectionRetryWaiting).toBe(false);expect(vi.getTimerCount()).toBe(0)
  })
  it('超出 32 位的 Retry-After 分段等待完整截止时间，切换或取消会清理后续唤醒', async () => {
    vi.useFakeTimers();const maximumSegment = 2_147_483_647, cooldown = maximumSegment + 1200
    send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: cooldown})})
    await check(true);expect(state.connectionRetryWaiting).toBe(true);expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1);await settle();expect(state.connectionRetryWaiting).toBe(true)
    await check(true);expect(messages()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(maximumSegment - 1);await settle()
    expect(state.connectionRetryWaiting).toBe(true);expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1199);await settle();expect(state.connectionRetryWaiting).toBe(true)
    await vi.advanceTimersByTimeAsync(1);await settle();expect(state.connectionRetryWaiting).toBe(false);expect(vi.getTimerCount()).toBe(0)
    expect(messages()).toHaveLength(1);await check(true);expect(messages()).toHaveLength(2)
    send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: cooldown})})
    await check(true);state.stopApiKeyChecks();expect(vi.getTimerCount()).toBe(0);expect(state.connectionRetryWaiting).toBe(false)
    send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: cooldown})})
    await check(true);props.service = 'google';await settle();expect(vi.getTimerCount()).toBe(0);expect(state.connectionRetryWaiting).toBe(false)
    props.service = 'deepseek';await settle()
    send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: cooldown})})
    await check(true);app.unmount();expect(vi.getTimerCount()).toBe(0);expect(state.connectionRetryWaiting).toBe(false)
  })
  it('免费供应商超长 Retry-After 直接核对截止时间，32 位边界前后都不会提前请求', async () => {
    vi.useFakeTimers();const maximumSegment = 2_147_483_647, cooldown = maximumSegment + 1200
    props.service = 'freeTranslation';props.compute.showToken = false;await settle()
    send.mockImplementation(async message => message.freeProviderId === 'microsoft'
      ? {success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: cooldown})}
      : {success: true, durationMs: 1})
    await check();expect(state.connectionRetryWaiting).toBe(false)
    await vi.advanceTimersByTimeAsync(maximumSegment);send.mockClear();await check()
    expect(messages().some(([message]) => message.freeProviderId === 'microsoft')).toBe(false)
    await vi.advanceTimersByTimeAsync(1199);send.mockClear();await check()
    expect(messages().some(([message]) => message.freeProviderId === 'microsoft')).toBe(false)
    await vi.advanceTimersByTimeAsync(1);send.mockClear();await check()
    expect(messages().some(([message]) => message.freeProviderId === 'microsoft')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('配置保存失败不请求供应商，安全解释并允许用户手动重试', async () => {
    save.mockRejectedValueOnce(new Error('storage denied apiKey=fixture-private-secret'))
    await check(true);expect(messages()).toHaveLength(0)
    expect(state.connectionTestDiagnostic.code).toBe('configuration-save')
    expect(state.connectionTestMessage).not.toContain('fixture-private-secret')
    await check(true);expect(messages()).toHaveLength(1);expect(state.connectionTestState).toBe('success')
  })
  it('免费目录的逐路错误与普通无 Key 服务都只保留安全分类', async () => {
    props.service = 'freeTranslation';props.compute.showToken = false;await settle()
    send.mockResolvedValue({success: false, error: '401 api key expired https://private.example?token=private-secret'})
    await check()
    expect(state.connectionTestDiagnostic.code).toBe('authentication')
    for (const result of Object.values(state.freeProviderChecks) as {error: string}[]) expect(result.error).toBe(getDiagnosticText({code: 'authentication'}).title)
    expect(JSON.stringify(state.freeProviderChecks)).not.toContain('private-secret')
    props.service = 'google';await settle();await check()
    expect(state.connectionTestMessage).toBe(getDiagnosticText({code: 'authentication'}).title)
  })
  it.each(['key', 'free', 'standalone'])('%s 已有错误响应语言切换及迟到语言包，保持诊断、配置和重试截止时间', async mode => {
    vi.useFakeTimers()
    if (mode !== 'key') {props.service = mode === 'free' ? 'freeTranslation' : 'google';props.compute.showToken = false;await settle()}
    const configuration = JSON.stringify(props.config)
    send.mockResolvedValue({success: false, error: 'private-secret https://private.example/token',
      diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1200})})
    await check(mode === 'key');await settle()
    const requests = messages().length, timers = vi.getTimerCount()
    const displayedErrors = () => mode === 'key' ? [state.apiKeyChecks[0].error]
      : mode === 'free' ? Object.values(state.freeProviderChecks).map((result: any) => result.error) : [state.connectionTestMessage]
    const chinese = getDiagnosticText({code: 'rate-limit'}).title
    expect(displayedErrors().every(error => error === chinese)).toBe(true)
    uiLanguage.value = 'fr-FR';await settle()
    expect(displayedErrors().every(error => error === chinese)).toBe(true)
    const french = JSON.parse(readFileSync(resolve('src/core/i18n/messages/self-help/fr-FR.json'), 'utf8'))
    uiCatalogs.set('fr-FR', {...french, 'settings.services.keys.failed': 'Échec contrôlé', 'settings.services.keys.summary': '{passed} réussis, {failed} échoués'})
    uiBundleRevision.value++;await settle()
    expect(displayedErrors().every(error => error === french['diagnostics.rate-limit.title'])).toBe(true)
    expect(state.connectionRepairText.title).toBe(french['diagnostics.rate-limit.title'])
    if (mode === 'key') expect(state.connectionTestMessage).toBe('Échec contrôlé')
    if (mode === 'free') expect(state.connectionTestMessage).toBe(`0 réussis, ${FREE_TRANSLATION_PROVIDERS.length} échoués`)
    uiLanguage.value = 'es-ES';await settle()
    // 旧语言资源的迟到修订不能把当前语言重新改成法语。
    uiCatalogs.set('fr-FR', {...french, 'diagnostics.rate-limit.title': 'stale French title'});uiBundleRevision.value++;await settle()
    expect(displayedErrors().every(error => error === chinese)).toBe(true)
    const spanish = JSON.parse(readFileSync(resolve('src/core/i18n/messages/self-help/es-ES.json'), 'utf8'))
    uiCatalogs.set('es-ES', spanish);uiBundleRevision.value++;await settle()
    expect(displayedErrors().every(error => error === spanish['diagnostics.rate-limit.title'])).toBe(true)
    expect(state.connectionTestDiagnostic.code).toBe('rate-limit');expect(messages()).toHaveLength(requests)
    expect(JSON.stringify(props.config)).toBe(configuration);expect(vi.getTimerCount()).toBe(timers)
    expect(JSON.stringify([state.apiKeyChecks, state.freeProviderChecks, state.connectionTestMessageState])).not.toContain('private-secret')
    await vi.advanceTimersByTimeAsync(1199);await settle()
    if (mode !== 'free') expect(state.connectionRetryWaiting).toBe(true)
    await vi.advanceTimersByTimeAsync(1);await settle()
    expect(state.connectionRetryWaiting).toBe(false);expect(vi.getTimerCount()).toBe(0);expect(messages()).toHaveLength(requests)
  })
  it('免费目录中单路限流独立冷却，健康的启用服务不会被展示为整体故障或阻塞手动检查', async () => {
    vi.useFakeTimers();props.service = 'freeTranslation';props.compute.showToken = false;props.config.freeTranslationOrder = ['google'];await settle()
    send.mockImplementation(async message => message.freeProviderId === 'microsoft'
      ? {success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1200})}
      : {success: true, durationMs: 10})
    await check();expect(state.connectionTestDiagnostic).toBeNull();expect(state.connectionRetryWaiting).toBe(false);expect(state.connectionTestDisabled).toBe(false)
    expect(state.freeProviderChecks.microsoft.status).toBe('error');expect(state.freeProviderChecks.google.status).toBe('success')
    send.mockClear();await check()
    expect(messages().some(([message]) => message.freeProviderId === 'microsoft')).toBe(false)
    expect(messages().some(([message]) => message.freeProviderId === 'google')).toBe(true)
    expect(state.connectionTestDiagnostic).toBeNull();expect(props.config.freeTranslationOrder).toEqual(['google'])
    await vi.advanceTimersByTimeAsync(1200);send.mockClear();await check()
    expect(messages().some(([message]) => message.freeProviderId === 'microsoft')).toBe(true)
  })
  it('普通无 Key 服务检查可手动停止，迟到供应商结果不能重新打开失败状态', async () => {
    props.service = 'google';props.compute.showToken = false;await settle()
    const delayed = pending();send.mockReturnValueOnce(delayed.promise)
    const job = check();await settle();expect(state.connectionTestBusy).toBe(true);expect(state.connectionTestDisabled).toBe(false)
    state.stopApiKeyChecks();await settle();expect(state.connectionTestBusy).toBe(false);expect(state.connectionTestState).toBe('idle')
    delayed.resolve({success: false, error: '401 private-secret'});await job
    expect(state.connectionTestState).toBe('idle');expect(state.connectionTestDiagnostic).toBeNull()
  })
  it('修复入口只在当前活跃诊断定位字段，模型错误定位实际模型选择器', async () => {
    const focus = vi.fn(), scrollIntoView = vi.fn(), modelFocus = vi.fn()
    const field = {focus, scrollIntoView}, model = {focus: modelFocus, scrollIntoView}
    state.configurationRoot = {querySelector: () => field, closest: () => ({querySelector: () => model})}
    send.mockResolvedValueOnce({success: false, error: '401 invalid key'});await check(true)
    state.focusConnectionConfiguration();expect(focus).toHaveBeenCalledWith({preventScroll: true})
    send.mockResolvedValueOnce({success: false, error: 'model not found'});await check(true)
    state.focusConnectionConfiguration();expect(modelFocus).toHaveBeenCalledOnce()
    props.active = false;await settle();state.focusConnectionConfiguration();expect(modelFocus).toHaveBeenCalledOnce()
  })
  it('非法或已经不存在的密钥行不写配置、重置检查或发出请求', async () => {
    const before = JSON.stringify(props.config)
    for (const index of [-1, 2.5, 99]) {state.updateApiKey(index, 'late');state.removeApiKey(index);await state.testSingleApiKey(index)}
    expect(JSON.stringify(props.config)).toBe(before);expect(queue).not.toHaveBeenCalled()
  })
  it('恢复确认中的模板编辑、离开页签及删除确认中的服务重命名会关闭旧确认', async () => {
    props.compute.showCustomOpenAI = true;props.customProvider = {id: 'deepseek', name: 'Fixture', endpoint: 'https://fixture.invalid/', models: []}
    state.activeSettingsTab = 'prompts';await settle();openAction('reset');props.config.system_role.deepseek = 'newer-edit';await settle();await acceptAction()
    expect(props.config.system_role.deepseek).toBe('newer-edit');expect(feedback).not.toHaveBeenCalled()
    openAction('reset');state.activeSettingsTab = 'translation';await settle();await acceptAction(1);expect(props.config.system_role.deepseek).toBe('newer-edit')
    openAction('delete');props.customProvider.name = 'New label';await settle();await acceptAction(2);expect(emitDelete).not.toHaveBeenCalled()
  })
  it.each(['reset', 'delete'] as const)('%s所属确认在隐藏、缓存停用、卸载、配置或服务改变后不操作新对象', async kind => {
    for (const reason of ['hidden', 'cached', 'config', 'service', 'unmount']) {
      props.active = true;visible.value = true;props.service = 'deepseek';props.compute.showCustomOpenAI = true
      props.customProvider = {id: 'deepseek', name: 'Fixture', endpoint: 'https://fixture.invalid/', models: []}
      props.config.system_role.deepseek = 'keep-system';props.config.user_role.deepseek = 'keep-user';props.config.system_role.openai = 'other-system';await settle()
      if (kind === 'reset') state.activeSettingsTab = 'prompts';await settle();const start = confirmations.length;openAction(kind);mutate(reason);await settle()
      const before = JSON.stringify(props.config);await acceptAction(start);expect(JSON.stringify(props.config)).toBe(before);expect(emitDelete).not.toHaveBeenCalled()
    }
  })
  it('可见确认只执行一次，恢复所属模板、取消删除，并拒绝旧按钮句柄操作新确认', async () => {
    props.compute.showCustomOpenAI = true;props.customProvider = {id: 'deepseek', name: 'Fixture', endpoint: 'https://fixture.invalid/', models: []}
    state.activeSettingsTab = 'prompts';await settle();props.config.system_role.deepseek = 'changed';openAction('reset');await acceptAction()
    expect(props.config.system_role.deepseek).toBe(defaultOption.system_role);expect(props.config.user_role.deepseek).toBe(defaultOption.user_role);expect(feedback).toHaveBeenCalledOnce()
    // 旧版本无所属按钮句柄，以上恢复行为仍与它比较。
    if (!state.serviceActionButtons) return
    openAction('delete');const old = state.serviceActionButtons;old.cancel();openAction('reset');old.confirm();old.cancel()
    expect(state.serviceActionOpen).toBe(true);expect(emitDelete).not.toHaveBeenCalled();state.serviceActionButtons.cancel()
    openAction('delete');state.serviceActionButtons.confirm();state.serviceActionButtons.confirm();expect(emitDelete).toHaveBeenCalledOnce()
  })
})

it('直接传入普通配置与 provider 对象时仍保留确认身份，不要求调用方额外代理', async () => {
  visible.value = false;await settle()
  const config = runtime.toRaw(props.config)
  const provider = {id: 'custom:raw', name: 'Raw provider', endpoint: 'https://raw.example', models: ['raw-model']}
  config.customOpenAIProviders = [provider];config.system_role[provider.id] = 'raw-system';config.user_role[provider.id] = 'raw-user'
  props = runtime.shallowReactive({...props, config, service: provider.id, customProvider: provider,
    compute: runtime.reactive({...props.compute, showCustomOpenAI: true})})
  visible.value = true;await settle();state.activeSettingsTab = 'prompts';await settle()
  state.resetCustomTemplate();await settle();expect(state.serviceActionOpen).toBe(true)
  state.serviceActionButtons.confirm();await settle();expect(config.system_role[provider.id]).toBe(defaultOption.system_role)
  expect(config.user_role[provider.id]).toBe(defaultOption.user_role)
  state.confirmDeleteProvider();await settle();expect(state.serviceActionOpen).toBe(true)
  state.serviceActionButtons.confirm();await settle();expect(emitDelete).toHaveBeenCalledTimes(1)
})


// 独立客户端夹具执行同一个父 SFC 的完整模板；仅子模块的加载与生命周期为受控端口。
// 实际 Vite 动态 import 受控返回 deferred；模块求值阶段若变为静态加载，仍立即计入加载断言。
type ServiceClientNode = {tag: string; props: Record<string, unknown>; parent?: ServiceClientNode; children: ServiceClientNode[];
  style: Record<string, unknown>; value?: unknown; addEventListener: () => void; removeEventListener: () => void}
type LocalModule = {__esModule: true; default: import('vue').Component}
type LocalPropsSnapshot = {config: Config; context: unknown; service: string; active: boolean}
type RepairFixture = {href?: string; disabled?: boolean; initialNavigation?: boolean;
  beforeSettle?: (fixture: {source: any; shown: import('vue').Ref<boolean>; stop: () => void; document: Document}) => void}
async function mountServiceClient(initialService = 'freeTranslation', development = false, repair?: RepairFixture) {
  vi.useFakeTimers()
  const snapshots: LocalPropsSnapshot[] = [], childProps: LocalPropsSnapshot[] = []
  const mounted = vi.fn(), unmounted = vi.fn(), clientErrors: unknown[] = []
  const localPort = runtime.defineComponent({
    name: 'LocalModelLifecyclePort', props: {config: Object, context: null, service: String, active: Boolean},
    setup(child) {
      runtime.onMounted(() => {
        mounted()
        snapshots.push({config: child.config as Config, context: child.context, service: child.service!, active: child.active})
        childProps.push(child as LocalPropsSnapshot)
      })
      runtime.onUnmounted(unmounted)
      return () => runtime.h('section', {'data-local-model-port': '', 'data-active': String(child.active)})
    },
  })
  // 动态 import 返回模块命名空间；Vue 据此取 default，不能用无标记普通对象代替。
  const localModule: LocalModule = {__esModule: true, default: localPort}
  const gates: {promise: Promise<LocalModule>; resolve: (value: LocalModule) => void; reject: (error: unknown) => void}[] = []
  let evaluating = true
  const requestLocal = vi.fn(() => {
    if (evaluating) return localModule
    let resolve!: (value: LocalModule) => void, reject!: (error: unknown) => void
    const promise = new Promise<LocalModule>((yes, no) => {resolve = yes;reject = no})
    const gate = {promise, resolve, reject};gates.push(gate)
    return promise
  })
  const display = runtime.defineComponent({setup: (_, {slots}) => () => runtime.h('div', slots.default?.())})
  const chatGPTPort = runtime.defineComponent({setup: () => () => runtime.h('section', {'data-chatgpt-plan-port': ''})})
  const requestChatGPT = vi.fn(() => ({__esModule: true, default: chatGPTPort}))
  vi.resetModules()
  vi.doMock('@/src/platform/chatgpt-plan/buildMode', () => ({chatGPTPlanDevelopmentEnabled: development}))
  vi.doMock('@/src/features/settings/ui/LocalTranslationModelSettings.vue', () => requestLocal())
  const inputPort = (tag: string) => runtime.defineComponent({inheritAttrs:false,setup:(_, {attrs,slots})=>()=>runtime.h(tag,attrs,[slots.default?.(),slots.tools?.(),slots.help?.(),slots.content?.()])})
  vi.doMock('@/src/features/settings/ui/services/ApiKeyList.vue', () => ({default:inputPort('api-key-list-port')}))
  vi.doMock('@/src/features/settings/ui/services/PromptTemplateEditor.vue', () => ({default:inputPort('prompt-editor-port')}))
  vi.doMock('@/src/features/settings/ui/components/SegmentedControl.vue', () => ({default:inputPort('segmented-control-port')}))
  vi.doMock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default:inputPort('field-help-port')}))
  // 保留真实请求限制父子组件和折叠容器；叶子数值控件提供公开输入端口。
  vi.doMock('@/src/features/settings/ui/services/RequestLimitSettings.vue', () => vi.importActual('@/src/features/settings/ui/services/RequestLimitSettings.vue'))
  vi.doMock('@/src/features/settings/ui/services/RequestLimitFields.vue', () => ({default: inputPort('request-limit-fields-port')}))
  vi.doMock('@/src/features/settings/ui/services/ChatGPTPlanSettings.vue', () => requestChatGPT())
  vi.doMock('element-plus', () => ({ElMessage: {success: feedback}, ElTabs: display, ElTabPane: display}))
  let repairDocument: Document | undefined, focusElement: Element | ServiceClientNode | null, fallbackHeading: HTMLElement | undefined
  if (repair) {
    const parsed = parseHTML('<html><body><button data-section="settings-services" aria-current="page">Services</button><input><h4 tabindex="-1">Current service</h4></body></html>')
    repairDocument = parsed.document;focusElement = repair.initialNavigation ? repairDocument.querySelector('[data-section]') : repairDocument.body
    Object.defineProperty(repairDocument, 'activeElement', {get: () => focusElement, configurable: true})
    Object.defineProperty(repairDocument, 'visibilityState', {value: 'visible', writable: true})
    fallbackHeading = repairDocument.querySelector<HTMLElement>('h4')!
    fallbackHeading.getClientRects = () => [1] as unknown as DOMRectList
    fallbackHeading.focus = vi.fn(() => {focusElement = fallbackHeading!;repairDocument!.dispatchEvent(new parsed.window.Event('focusin'))})
    // 真实返回组件监听 Window 的页面生命周期；使用同一文档的事件目标，定时器仍由全局 fake clock 提供。
    vi.stubGlobal('window', parsed.window)
    vi.stubGlobal('document', repairDocument);vi.stubGlobal('location', {href: repair.href || 'chrome-extension://fixture/options.html?returnTabId=7&service=freeTranslation'})
  }
  vi.doMock('@/src/features/settings/ui/services/ServiceRepairReturn.vue', () => repair
    ? vi.importActual('@/src/features/settings/ui/services/ServiceRepairReturn.vue') : {default: display})
  const component = (await import('@/src/features/settings/ui/services/ServiceConfiguration.vue')).default
  evaluating = false
  function node(tag: string): ServiceClientNode {
    const result = {tag, props: {}, children: [], style: {}, addEventListener: () => {}, removeEventListener: () => {}} as ServiceClientNode
    if (repairDocument) Object.assign(result, {focus: vi.fn(() => {focusElement = result;repairDocument!.dispatchEvent(new (repairDocument!.defaultView as any).Event('focusin'))}),
      getClientRects: () => [1], getAttribute: (key: string) => result.props[key] ?? null,
      closest: () => ({querySelector: () => fallbackHeading})})
    if (repairDocument) Object.defineProperties(result, {disabled: {get: () => result.props.disabled === true}, isConnected: {get: () => Boolean(result.parent)}})
    return result
  }
  function remove(n: ServiceClientNode) {
    if (n.parent) {const list = n.parent.children, index = list.indexOf(n);if (index >= 0) list.splice(index, 1)}
    n.parent = undefined
  }
  function insert(n: ServiceClientNode, parent: ServiceClientNode, anchor?: ServiceClientNode | null) {
    remove(n);const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, n);n.parent = parent
  }
  const renderer = runtime.createRenderer<ServiceClientNode, ServiceClientNode>({
    patchProp: (n, key, _before, value) => {n.props[key] = value}, insert, remove,
    createElement: node, createText: value => Object.assign(node('#text'), {value}), createComment: () => node('#comment'),
    setText: (n, value) => {n.value = value}, setElementText: (n, value) => {n.value = value},
    parentNode: n => n.parent || null,
    nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    querySelector: () => null, setScopeId: () => {}, cloneNode: n => ({...n, children: []}),
    insertStaticContent: (_html, parent, anchor) => {
      const start = node('#static-start'), end = node('#static-end');insert(start, parent, anchor);insert(end, parent, anchor);return [start, end]
    },
  })
  const connectionTarget = node('section')
  const emitted = {thinking:vi.fn(),provider:vi.fn(),remove:vi.fn()}
  const source = runtime.shallowReactive({...props, config: runtime.reactive(new Config()), service: initialService, connectionActionTarget: connectionTarget,
    active: true, 'onUpdate:model-thinking':emitted.thinking, 'onUpdate:custom-provider':emitted.provider, 'onRemove:service':emitted.remove, compute: {showAI: false, showModel: false, showToken: false, requireApiKey: false, showServiceSecret: false} as Record<string,any>})
  if (repair?.disabled) source.compute = {showAI: true, showModel: true, showToken: true, requireApiKey: true, showServiceSecret: false}
  const shown = runtime.ref(true), host = node('#host')
  const clientApp = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component as runtime.Component, source) : runtime.h({render: () => null}, {key: 'other-client'})})})
  clientApp.config.errorHandler = error => {clientErrors.push(error)}
  clientApp.config.warnHandler = () => {}
  let stopped = false
  const stop = () => {if (!stopped) {stopped = true;clientApp.unmount()}}
  const finish = async () => {stop();for (const gate of gates) gate.resolve(localModule);await settle();vi.advanceTimersByTime(200);await settle()}
  try {clientApp.mount(host);if (repairDocument) repair?.beforeSettle?.({source, shown, stop, document: repairDocument});await settle()}
  catch (error) {await finish();throw error}
  const resolveLocal = (index = 0) => {expect(gates[index]).toBeDefined();gates[index].resolve(localModule)}
  function localNodes(n = host): ServiceClientNode[] {return n.children.flatMap(child => [
    ...(Object.hasOwn(child.props, 'data-local-model-port') ? [child] : []), ...localNodes(child),
  ])}
  function descendants(n: ServiceClientNode): ServiceClientNode[] {return [n, ...n.children.flatMap(descendants)]}
  const allNodes = () => [...descendants(host), ...descendants(connectionTarget)]
  return {source, shown, host, emitted, requestLocal, requestChatGPT, gates, snapshots, childProps, mounted, unmounted, clientErrors, resolveLocal, localNodes, allNodes, stop, finish, repairDocument, fallbackHeading}
}

describe('实际服务父模板的本地子模块按需加载', () => {
  it('单请求页签默认展开并保留表单与响应式摘要，多页签保持原 section', async () => {
    const h = await mountServiceClient('freeTranslation')
    try {
      const disclosure = () => h.allNodes().find(n => Object.hasOwn(n.props, 'data-service-request-disclosure'))!
      const fields = () => h.allNodes().find(n => n.props['data-testid'] === 'request-limit-settings')!
      const mode = () => h.allNodes().find(n => Object.hasOwn(n.props, 'data-request-limit-mode'))!
      const text = (n: ServiceClientNode): string => (n.value || '') + n.children.map(text).join('')
      const initialForm = fields(), initialDisclosure = disclosure()
      expect(initialDisclosure.tag).toBe('details');expect(initialDisclosure.props.open).toBe(true)
      expect(initialForm).toBeDefined();expect(text(initialDisclosure)).toContain('settings.requestLimits.followGlobal')
      ;(mode().props['onUpdate:modelValue'] as (value: unknown) => void)('custom');await settle()
      expect(h.source.config.serviceRequestLimits.freeTranslation.enabled).toBe(true)
      expect(disclosure()).toBe(initialDisclosure);expect(fields()).toBe(initialForm)
      expect(text(disclosure())).toContain('settings.requestLimits.custom')
      ;(mode().props['onUpdate:modelValue'] as (value: unknown) => void)('inherit');await settle()
      expect(text(disclosure())).toContain('settings.requestLimits.followGlobal')
      expect(fields()).toBe(initialForm)
      h.source.service = 'google';await settle()
      expect(disclosure()).not.toBe(initialDisclosure);expect(disclosure().props.open).toBe(true)
      h.source.service = 'deepseek';h.source.compute = {...h.source.compute, showAI: true, showModel: true};await settle()
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-service-request-disclosure'))).toBe(false)
      expect(h.allNodes().find(n => n.props.id === 'service-requests-settings')?.tag).toBe('section')
      expect(h.clientErrors).toEqual([]);expect(send).not.toHaveBeenCalled()
    } finally {await h.finish()}
  })
  it.each(['service', 'config', 'inactive'])('折叠请求表单在%s变化后拒绝旧模式与数值事件', async reason => {
    const h = await mountServiceClient('google')
    try {
      const mode = () => h.allNodes().find(n => Object.hasOwn(n.props, 'data-request-limit-mode'))!
      ;(mode().props['onUpdate:modelValue'] as (value: unknown) => void)('custom');await settle()
      const oldMode = mode().props['onUpdate:modelValue'] as (value: unknown) => void, owner = h.source.config
      const fields = h.allNodes().find(n => n.props.layout === 'service' && n.props['onUpdate:modelValue'])!
      const oldLimits = fields.props['onUpdate:modelValue'] as (value: unknown) => void, snapshot = JSON.stringify(owner.serviceRequestLimits)
      if (reason === 'service') h.source.service = 'microsoft'
      if (reason === 'config') h.source.config = runtime.reactive(new Config())
      if (reason === 'inactive') h.source.active = false
      await settle()
      oldMode('inherit');oldLimits({...owner.serviceRequestLimits.google.limits, maxConcurrentTranslations: 17});await settle()
      expect(JSON.stringify(owner.serviceRequestLimits)).toBe(snapshot)
      if (reason === 'config') expect(h.source.config.serviceRequestLimits).toEqual({})
      if (reason === 'service') expect(h.source.config.serviceRequestLimits.microsoft).toBeUndefined()
      expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it('公开套餐父模板没有根DOM或占位且不加载套餐子模块，保存的模型保持原值', async () => {
    const h = await mountServiceClient('chatgptPlan')
    try {
      h.source.config.model.chatgptPlan = 'saved-account-model';h.source.compute = {...h.source.compute, showAI: true, showModel: true};await settle()
      const saved = JSON.stringify(h.source.config)
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-connection-test-button') || Object.hasOwn(n.props, 'data-service-settings-tabs') || Object.hasOwn(n.props, 'data-configuration-group'))).toBe(false)
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-service-configuration-service') || Object.hasOwn(n.props, 'data-chatgpt-plan-port'))).toBe(false)
      expect(h.host.children.filter(n => !n.tag.startsWith('#'))).toEqual([]);expect(h.requestChatGPT).not.toHaveBeenCalled()
      h.source.service = 'google';await settle()
      expect(h.allNodes().some(n => n.props['data-service-configuration-service'] === 'google')).toBe(true)
      expect(h.requestChatGPT).not.toHaveBeenCalled()
      h.source.service = 'chatgptPlan';await settle()
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-service-configuration-service') || Object.hasOwn(n.props, 'data-chatgpt-plan-port'))).toBe(false)
      expect(h.host.children.filter(n => !n.tag.startsWith('#'))).toEqual([]);expect(h.requestChatGPT).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(JSON.stringify(h.source.config)).toBe(saved);expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it('显式开发模式的套餐仍显示原设置并通过既有连接测试消息', async () => {
    const h = await mountServiceClient('chatgptPlan', true)
    try {
      h.source.config.model.chatgptPlan = 'fixture-account-model';h.source.compute = {...h.source.compute, showAI: true};await settle()
      expect(h.requestChatGPT).toHaveBeenCalledOnce()
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-chatgpt-plan-port'))).toBe(true)
      const button = h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-test-button'))
      expect(button).toBeDefined()
      expect(h.allNodes().some(n => n.props['data-configuration-group'] === 'prompts')).toBe(true)
      expect(h.allNodes().some(n => n.props['data-configuration-group'] === 'requests')).toBe(true)
      await (button!.props.onClick as () => Promise<void>)();await settle();expect(messages()).toHaveLength(1);expect(messages()[0][0]).toMatchObject({type: 'testTranslationService', service: 'chatgptPlan'})
      expect(h.source.config.model.chatgptPlan).toBe('fixture-account-model');expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it('实际父模板显示可操作安全诊断，手动重试成功后收起且保留选择', async () => {
    const h = await mountServiceClient('google')
    try {
      const headerButton = () => h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-test-button'))!
      send.mockResolvedValueOnce({success: false, error: '401 private-secret https://private.example'})
      await (headerButton().props.onClick as () => Promise<void>)();await settle()
      const repair = h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-repair'))
      expect(repair?.props['data-diagnostic-code']).toBe('authentication')
      const retry = h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-retry'))
      expect(retry).toBeDefined();expect(retry?.props.disabled).toBe(false)
      expect(h.allNodes().map(n => n.value || '').join(' ')).not.toContain('private-secret')
      await (retry!.props.onClick as () => Promise<void>)();await settle()
      expect(h.allNodes().some(n => Object.hasOwn(n.props, 'data-connection-repair'))).toBe(false)
      expect(h.source.service).toBe('google');expect(messages()).toHaveLength(2);expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it.each(['freeTranslation', 'google'])('普通服务%s不加载本地子模块或挂载模型 UI', async service => {
    const h = await mountServiceClient(service)
    try {expect(h.requestLocal).not.toHaveBeenCalled();expect(h.mounted).not.toHaveBeenCalled();expect(h.localNodes()).toHaveLength(0)}
    finally {await h.finish()}
  })
  it('显式本地服务加载一次，正常返回复用已解析模块且创建新的所属实例', async () => {
    const h = await mountServiceClient()
    try {
      expect(h.requestLocal).not.toHaveBeenCalled();h.source.service = 'localTranslation';await settle()
      expect(h.requestLocal).toHaveBeenCalledOnce();expect(h.mounted).not.toHaveBeenCalled();expect(h.localNodes()).toHaveLength(0)
      h.resolveLocal();await settle();expect(h.mounted).toHaveBeenCalledOnce();expect(h.localNodes()).toHaveLength(1)
      expect(h.snapshots[0]).toMatchObject({config: h.source.config, context: h.source.config, service: 'localTranslation', active: true})
      h.source.service = 'google';await settle();expect(h.unmounted).toHaveBeenCalledOnce();expect(h.localNodes()).toHaveLength(0)
      h.source.service = 'localTranslation';await settle();expect(h.requestLocal).toHaveBeenCalledOnce();expect(h.mounted).toHaveBeenCalledTimes(2)
      expect(h.localNodes()).toHaveLength(1);expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it.each(['service', 'unmount'])('等待时%s移除父或条件节点，迟到模块不能挂载旧实例', async reason => {
    const h = await mountServiceClient('localTranslation')
    try {
      expect(h.requestLocal).toHaveBeenCalledOnce();expect(h.mounted).not.toHaveBeenCalled()
      if (reason === 'service') h.source.service = 'google';else h.stop()
      await settle();h.resolveLocal();await settle()
      expect(h.mounted).not.toHaveBeenCalled();expect(h.localNodes()).toHaveLength(0);expect(h.clientErrors).toEqual([])
      if (reason === 'service') {
        h.source.service = 'localTranslation';await settle();expect(h.requestLocal).toHaveBeenCalledOnce()
        expect(h.mounted).toHaveBeenCalledOnce();expect(h.snapshots[0].service).toBe('localTranslation')
      }
    } finally {await h.finish()}
  })
  it.each(['hidden', 'cached'])('等待时%s并替换配置，解析与返回都使用父模板当前归属', async reason => {
    const h = await mountServiceClient('localTranslation')
    try {
      expect(h.mounted).not.toHaveBeenCalled()
      const latest = runtime.reactive(new Config());latest.theme = 'dark';h.source.config = latest
      // 外部 props 先提交到等待中的父实例；同 job 直接移入 KeepAlive 不会提交新 VNode。
      await settle()
      if (reason === 'hidden') h.source.active = false;else h.shown.value = false
      await settle()
      const returning = reason === 'cached' ? runtime.reactive(new Config()) : latest
      if (reason === 'cached') h.source.config = returning
      h.resolveLocal();await settle()
      // KeepAlive 可在缓存容器内完成子挂载；每个实际挂载都必须是 inactive 且没有捕获旧配置。
      expect(h.snapshots.every(item => item.active === false && item.config === latest && item.context === latest)).toBe(true)
      if (reason === 'hidden') h.source.active = true;else h.shown.value = true
      await settle();expect(h.mounted).toHaveBeenCalledOnce();expect(h.localNodes()).toHaveLength(1)
      expect(h.childProps[0].active).toBe(true);expect(h.childProps[0].config).toBe(returning);expect(h.childProps[0].context).toBe(returning)
      expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
  it('模块 resolve 与隐藏在同一 job 时首次子挂载不会获得旧 active', async () => {
    const h = await mountServiceClient('localTranslation')
    try {
      expect(h.mounted).not.toHaveBeenCalled();h.resolveLocal();h.source.active = false;await settle()
      expect(h.mounted).toHaveBeenCalledOnce();expect(h.snapshots[0].active).toBe(false);expect(h.childProps[0].active).toBe(false)
      h.source.active = true;await settle();expect(h.childProps[0].active).toBe(true);expect(h.requestLocal).toHaveBeenCalledOnce()
    } finally {await h.finish()}
  })
  it('加载拒绝由 Vue 观察且没有未处理拒绝，切离后重进允许一次新加载', async () => {
    const h = await mountServiceClient('localTranslation'), unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {unhandled.push(error)}
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(h.mounted).not.toHaveBeenCalled();const failure = new Error('controlled local UI chunk rejection')
      h.gates[0].reject(failure);await settle();
      // Vitest 的真实 import mock 为工厂失败保留 cause；仍要求 Vue 只观察同一个原始拒绝。
      expect(h.clientErrors).toHaveLength(1);expect((h.clientErrors[0] as Error & {cause?: unknown}).cause ?? h.clientErrors[0]).toBe(failure);expect(h.mounted).not.toHaveBeenCalled()
      h.source.service = 'google';await settle();h.source.service = 'localTranslation';await settle()
      expect(h.requestLocal).toHaveBeenCalledTimes(2);expect(h.gates).toHaveLength(2)
      h.resolveLocal(1);await settle();expect(h.mounted).toHaveBeenCalledOnce();expect(h.localNodes()).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {process.off('unhandledRejection', onUnhandled);await h.finish()}
  })
})


describe('真实服务父组件与返回组件的修复焦点', () => {
  it('明确链接从默认导航直达 Teleport 检查按钮一次，不发检测消息或在同步后抢焦点', async () => {
    const h = await mountServiceClient('freeTranslation', false, {initialNavigation: true})
    const button = h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-test-button')) as any
    expect(h.clientErrors).toEqual([]);expect(button.focus).toHaveBeenCalledOnce();expect(h.repairDocument?.activeElement).toBe(button)
    expect(send).not.toHaveBeenCalled();h.source.config = runtime.reactive(new Config());await settle()
    h.shown.value = false;await settle();h.shown.value = true;await settle();expect(button.focus).toHaveBeenCalledOnce();await h.finish()
  })
  it('连接按钮禁用时当前可读标题保留焦点，标题与配置区域均有稳定负tabindex', async () => {
    const h = await mountServiceClient('openai', false, {href: 'chrome-extension://fixture/options.html?returnTabId=7&service=openai', disabled: true})
    expect(h.clientErrors).toEqual([]);expect(h.fallbackHeading?.focus).toHaveBeenCalledOnce();expect(h.fallbackHeading?.getAttribute('tabindex')).toBe('-1');expect(h.repairDocument?.activeElement).toBe(h.fallbackHeading);expect(h.allNodes().find(n => Object.hasOwn(n.props, 'data-service-configuration-service'))?.props.tabindex).toBe('-1');expect(send).not.toHaveBeenCalled();await h.finish()
  })
  it.each(['ordinary', 'mismatch', 'pointer', 'focus', 'hidden', 'context', 'service', 'inactive', 'unmount'])('%s 不执行旧修复焦点', async reason => {
    const h = await mountServiceClient('freeTranslation', false, {
      href: reason === 'ordinary' ? 'chrome-extension://fixture/options.html' : reason === 'mismatch' ? 'chrome-extension://fixture/options.html?returnTabId=7&service=openai' : undefined,
      beforeSettle({source, document, stop}) {
        if (reason === 'pointer') document.dispatchEvent(new (document.defaultView as any).Event('pointerdown'))
        if (reason === 'focus') {const input = document.querySelector('input')!;Object.defineProperty(document, 'activeElement', {value: input, configurable: true});document.dispatchEvent(new (document.defaultView as any).Event('focusin'))}
        if (reason === 'hidden') {Object.assign(document, {visibilityState: 'hidden'});document.dispatchEvent(new (document.defaultView as any).Event('visibilitychange'))}
        if (reason === 'context') source.config = runtime.reactive(new Config())
        if (reason === 'service') source.service = 'google'
        if (reason === 'inactive') source.active = false
        if (reason === 'unmount') stop()
      },
    })
    expect(h.clientErrors).toEqual([])
    for (const node of h.allNodes()) if ((node as any).focus) expect((node as any).focus).not.toHaveBeenCalled()
    expect(h.fallbackHeading?.focus).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();await h.finish()
  })
})


describe('连接限流修复的七语按钮', () => {
  it('真实模板冷却期间仅禁用重试，不把五种语言变成英文或重置截止时间', async () => {
    const h = await mountServiceClient('google')
    try {
      send.mockResolvedValueOnce({success: false, diagnostic: diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1200})})
      const header = h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-test-button'))!
      await (header.props.onClick as () => Promise<void>)();await settle()
      const retry = () => h.allNodes().find(n => Object.hasOwn(n.props, 'data-connection-retry'))!
      const text = (n: ServiceClientNode): string => String(n.value || '') + n.children.map(text).join('')
      for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
        const catalog = JSON.parse(readFileSync(resolve('src/core/i18n/messages/self-help', locale + '.json'), 'utf8')) as Record<string, string>
        uiCatalogs.set(locale, catalog);uiLanguage.value = locale;uiBundleRevision.value += 1;await settle()
        expect(retry().props.disabled).toBe(true);expect(text(retry())).toBe(catalog['diagnostics.action.retry'])
        expect(text(retry())).not.toContain('Retry shortly')
      }
      await vi.advanceTimersByTimeAsync(1200);await settle();expect(retry().props.disabled).toBe(false)
      expect(text(retry())).toBe(uiCatalogs.get('es-ES')!['diagnostics.action.retry']);expect(messages()).toHaveLength(1);expect(h.clientErrors).toEqual([])
    } finally {await h.finish()}
  })
})

describe('actual service field callback ownership', () => {
  it.each(['service','config','hidden','cached','unmount'] as const)('does not let an old proxy input update another configuration after %s', async boundary => {
    const h=await mountServiceClient('deepseek');
    try {
      h.source.compute={...h.source.compute,showAI:true,showProxy:true};await settle();
      const field=h.allNodes().find(node=>node.props['aria-label']==='代理地址');expect(field).toBeDefined();
      const oldUpdate=field!.props['onUpdate:modelValue'] as (value:string)=>void;
      if(boundary==='service')h.source.service='openai';
      else if(boundary==='config')h.source.config=runtime.reactive(new Config());
      else if(boundary==='hidden')h.source.active=false;
      else if(boundary==='cached')h.shown.value=false;
      else h.stop();
      await settle();const before={...h.source.config.proxy};oldUpdate('https://obsolete.example.test/');await settle();
      expect(h.source.config.proxy).toEqual(before);expect(h.clientErrors).toEqual([]);
    } finally {await h.finish()}
  })
})


function clientField(h: Awaited<ReturnType<typeof mountServiceClient>>, label:string) {
  const field=h.allNodes().find(node=>node.props['aria-label']===label);expect(field, label).toBeDefined();return field!;
}
async function updateClientField(h: Awaited<ReturnType<typeof mountServiceClient>>, label:string, value:unknown) {
  const field=clientField(h,label);expect(typeof field.props['onUpdate:modelValue']).toBe('function');(field.props['onUpdate:modelValue'] as (value:unknown)=>void)(value);await settle();
}
describe('actual service connection form fields',()=>{
  it.each([
    ['deepL','settings.services.deepl.plan','pro','deeplApiPlan',{}],
    ['minimax','MiniMax 计费方式','token-plan','minimaxBillingPlan',{showMiniMaxRegion:true}],
    ['minimax','MiniMax API 区域','global','minimaxRegion',{showMiniMaxRegion:true}],
    ['mimo','小米 MiMo 计费方式','token-plan','mimoBillingPlan',{showMiMoRegion:true}],
    ['mimo','小米 MiMo API 集群','sg','mimoRegion',{showMiMoRegion:true}],
    ['azureOpenai','settings.services.azure.endpoint','https://fixture.services.ai.azure.com/openai/v1/','azureOpenaiEndpoint',{showAzureOpenaiEndpoint:true}],
    ['deeplx','settings.services.deeplx.endpoint','https://fixture.example.test/translate','deeplx',{showDeepLX:true}],
    ['youdao','App Key','fixture-key','youdaoAppKey',{showYoudao:true}],
    ['youdao','App Secret','fixture-secret','youdaoAppSecret',{showYoudao:true}],
    ['tencent','Secret ID','fixture-id','tencentSecretId',{showTencent:true}],
    ['tencent','Secret Key','fixture-secret','tencentSecretKey',{showTencent:true}],
    ['newapi','接口地址','https://fixture.example.test/v1','newApiUrl',{showNewAPI:true}],
    ['deepseek','API 格式','responses','deepseekApiType',{showDeepseekApiType:true}],
  ] as const)('updates %s %s through its rendered widget and rejects its old field after external replacement',async(service,label,value,key,compute)=>{
    const h=await mountServiceClient(service);try{
      h.source.compute={...h.source.compute,...compute};await settle();const old=clientField(h,label).props['onUpdate:modelValue'] as (value:unknown)=>void;
      await updateClientField(h,label,value);expect(h.source.config[key]).toBe(value);
      const saved=h.source.config[key];old('obsolete');await settle();expect(h.source.config[key]).toBe(saved);
      const stale=clientField(h,label).props['onUpdate:modelValue'] as (value:unknown)=>void, external=new Config()[key];Object.assign(h.source.config,{[key]:external});await settle();stale(value);expect(h.source.config[key]).toBe(external);expect(h.clientErrors).toEqual([]);
    }finally{await h.finish()}
  })
  it('keeps service-map fields scoped and ignores a callback after either its value or record is replaced',async()=>{
    const h=await mountServiceClient('ollama');try{
      h.source.compute={...h.source.compute,showOllamaEndpoint:true};await settle();const old=clientField(h,'Ollama 服务地址').props['onUpdate:modelValue'] as (value:string)=>void;
      h.source.config.proxy.ollama='https://external.example.test/v1';await settle();old('https://obsolete.example.test/v1');expect(h.source.config.proxy.ollama).toBe('https://external.example.test/v1');
      const next=clientField(h,'Ollama 服务地址').props['onUpdate:modelValue'] as (value:string)=>void;h.source.config.proxy={...h.source.config.proxy};await settle();next('https://obsolete.example.test/v1');expect(h.source.config.proxy.ollama).toBe('https://external.example.test/v1');
      await updateClientField(h,'Ollama 服务地址','http://localhost:11434/v1/chat/completions');expect(h.source.config.proxy.ollama).toBe('http://localhost:11434/v1/chat/completions');expect(h.source.config.proxy.deepseek).toBeUndefined();
    }finally{await h.finish()}
  })
  it('validates and commits MyMemory contact email only after valid widget changes',async()=>{
    const h=await mountServiceClient('myMemory');try{
      await updateClientField(h,'MyMemory 联系邮箱','not-an-email');(clientField(h,'MyMemory 联系邮箱').props.onChange as ()=>void)();await settle();expect(h.source.config.myMemoryEmail).toBe('');expect(clientField(h,'MyMemory 联系邮箱').props['aria-invalid']).toBe(true);
      await updateClientField(h,'MyMemory 联系邮箱',' fixture@example.test ');(clientField(h,'MyMemory 联系邮箱').props.onChange as ()=>void)();await settle();expect(h.source.config.myMemoryEmail).toBe('fixture@example.test');expect(clientField(h,'MyMemory 联系邮箱').props['aria-invalid']).toBe(false);
      await updateClientField(h,'MyMemory 联系邮箱','');(clientField(h,'MyMemory 联系邮箱').props.onChange as ()=>void)();await settle();expect(h.source.config.myMemoryEmail).toBe('');
    }finally{await h.finish()}
  })
  it('updates paired cloud credentials and region without touching another service',async()=>{
    const h=await mountServiceClient('aliyunTranslation');try{
      h.source.compute={...h.source.compute,showToken:true,showServiceSecret:true,showServiceRegion:true,showCloudVendor:true,cloudCredentialLabels:{token:'Access Key ID',secret:'Access Key Secret'},defaultCloudRegion:'cn-hangzhou',cloudRegionOptions:[{value:'cn-hangzhou',label:'Hangzhou'},{value:'cn-shanghai',label:'Shanghai'}]};await settle();
      await updateClientField(h,'Access Key ID','fixture-id');await updateClientField(h,'Access Key Secret','fixture-secret');await updateClientField(h,'云服务区域','cn-shanghai');
      expect(h.source.config.token.aliyunTranslation).toBe('fixture-id');expect(h.source.config.apiKeys.aliyunTranslation).toEqual(['fixture-id']);expect(h.source.config.secret.aliyunTranslation).toBe('fixture-secret');expect(h.source.config.serviceRegion.aliyunTranslation).toBe('cn-shanghai');expect(h.source.config.token.openai).toBeUndefined();
    }finally{await h.finish()}
  })
  it('emits custom profile edits and Thinking for the current model, and preserves per-service JSON editors',async()=>{
    const h=await mountServiceClient('custom:fixture');try{
      h.source.customProvider={id:'custom:fixture',name:'Fixture',endpoint:'https://fixture.example.test',models:['model-a']};h.source.config.model['custom:fixture']='model-a';h.source.compute={...h.source.compute,showAI:true,showModel:true,showCustomOpenAI:true,showCustomBody:true};await settle();
      await updateClientField(h,'自定义服务名称','Renamed');await updateClientField(h,'自定义服务接口地址','https://renamed.example.test/v1');expect(h.emitted.provider.mock.calls).toEqual([[{name:'Renamed'}],[{endpoint:'https://renamed.example.test/v1'}]]);
      const thinking=clientField(h,'当前模型是否启用 Thinking').props['onUpdate:modelValue'] as (value:boolean)=>void;thinking(true);await settle();expect(h.emitted.thinking).toHaveBeenLastCalledWith(true);h.source.config.model['custom:fixture']='model-b';await settle();thinking(false);expect(h.emitted.thinking).toHaveBeenCalledOnce();
      await updateClientField(h,'自定义请求头','{"x-fixture":"yes"}');await updateClientField(h,'自定义请求体','{"temperature":0.2}');expect(h.source.config.customHeaders['custom:fixture']).toBe('{"x-fixture":"yes"}');expect(h.source.config.customBody['custom:fixture']).toBe('{"temperature":0.2}');
      await updateClientField(h,'自定义请求体','[]');expect(h.allNodes().some(node=>String(node.value).includes('请输入合法的 JSON 对象'))).toBe(true);
    }finally{await h.finish()}
  })
})


async function selectServiceTab(h: Awaited<ReturnType<typeof mountServiceClient>>, value:string) {
  const tabs=h.allNodes().find(node=>Object.hasOwn(node.props,'data-service-settings-tabs'));expect(tabs).toBeDefined();(tabs!.props['onUpdate:modelValue'] as (value:string)=>void)(value);await settle();
}
it('commits prompt edits through the current tab and leaves old prompt callbacks inactive after switching service',async()=>{
  const h=await mountServiceClient('deepseek');try{
    h.source.compute={...h.source.compute,showAI:true,showModel:true};await settle();await selectServiceTab(h,'prompts');
    const field=(role:string)=>h.allNodes().find(node=>node.tag==='prompt-editor-port'&&node.props.role===role)!;
    (field('system').props['onUpdate:modelValue'] as (value:string)=>void)('System fixture');await settle();(field('user').props['onUpdate:modelValue'] as (value:string)=>void)('User fixture');await settle();
    expect(h.source.config.system_role.deepseek).toBe('System fixture');expect(h.source.config.user_role.deepseek).toBe('User fixture');const stale=field('system').props['onUpdate:modelValue'] as (value:string)=>void;
    h.source.service='openai';await settle();const before=h.source.config.system_role.openai;stale('Wrong service');expect(h.source.config.system_role.openai).toBe(before);expect(h.source.config.system_role.deepseek).toBe('System fixture');
  }finally{await h.finish()}
})
it('updates API-key rotation and model authentication policies through their actual parent controls',async()=>{
  const h=await mountServiceClient('deepseek');try{
    h.source.compute={...h.source.compute,showAI:true,showToken:true,requireApiKey:true};h.source.config.apiKeys.deepseek=['fixture-first','fixture-second'];await settle();
    const radio=(value:string)=>h.allNodes().find(node=>node.tag==='input'&&node.props.value===value)!;
    (radio('single').props.onChange as ()=>void)();await settle();expect(h.source.config.apiKeyRotationEnabled.deepseek).toBe(false);
    (radio('rotation').props.onChange as ()=>void)();await settle();expect(h.source.config.apiKeyRotationEnabled.deepseek).toBe(true);
    await selectServiceTab(h,'custom-request');const policy=()=>h.allNodes().find(node=>Object.hasOwn(node.props,'data-api-key-auth-policy'))!;
    (policy().props['onUpdate:modelValue'] as (value:string)=>void)('optional');await settle();expect(h.source.compute.requireApiKey).toBe(false);
    (policy().props['onUpdate:modelValue'] as (value:string)=>void)('required');await settle();expect(h.source.compute.requireApiKey).toBe(true);
    h.source.compute={...h.source.compute,showServiceSecret:true,cloudCredentialLabels:{secret:'Service secret'}};await settle();await updateClientField(h,'当前模型是否需要 API Key',false);expect(h.source.compute.requireApiKey).toBe(false);expect(h.source.config.apiKeys.deepseek).toEqual(['fixture-first','fixture-second']);
  }finally{await h.finish()}
})

it('shows real Chrome model preparation phases on the current connection button and ignores late download updates',async()=>{
  const h=await mountServiceClient('chromeTranslator');try{
    const waiting=pending();prepare.mockReturnValueOnce(waiting.promise);
    uiCatalogs.set('zh-CN',{'settings.services.chromePreparation.statusDownloadingProgress':'{model} {percentage}%','settings.services.chromePreparation.statusDownloading':'Downloading {model}','settings.services.chromePreparation.statusInitializing':'Initializing','settings.services.chromePreparation.statusVerifying':'Verifying'});uiBundleRevision.value++;
    const button=h.allNodes().find(node=>Object.hasOwn(node.props,'data-connection-test-button'))!;const job=(button.props.onClick as ()=>Promise<void>)();await settle();expect(prepare).toHaveBeenCalledOnce();
    const input=prepare.mock.calls[0][0], text=()=>h.allNodes().map(node=>String(node.value??'')).join(' ');
    input.onStatus({phase:'initializing',sourceLanguage:'en',targetLanguage:'zh'});await settle();expect(text()).toContain('Initializing');
    input.onStatus({phase:'downloading',sourceLanguage:'en',targetLanguage:'zh',model:'language-detector'});await settle();expect(text()).toContain('Downloading');expect(text()).toContain('settings.services.chromePreparation.modelDetector');
    input.onStatus({phase:'downloading',sourceLanguage:'en',targetLanguage:'zh',model:'translator',loaded:.25});await settle();expect(text()).toContain('25%');expect(text()).toContain('settings.services.chromePreparation.modelTranslator');
    input.onStatus({phase:'verifying',sourceLanguage:'en',targetLanguage:'zh'});await settle();expect(text()).toContain('Verifying');
    waiting.resolve({sourceLanguage:'en',targetLanguage:'zh'});await job;await settle();const completed=text();expect(completed).toContain('settings.services.chromePreparation.titleReady');input.onStatus({phase:'downloading',sourceLanguage:'en',targetLanguage:'zh',model:'translator',loaded:.8});await settle();expect(text()).toBe(completed);expect(h.clientErrors).toEqual([]);
  }finally{await h.finish()}
})
