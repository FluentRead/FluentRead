/**
 * @file tests/featureMenuSettingsLifecycle.test.ts
 * 文件职责：验证实际功能服务分配和右键菜单设置的旧事件归属、值校验、预览与凭据读取范围。
 * 主要内容：执行真实缓存客户端模板，覆盖隐藏、缓存、配置替换、选项权限变化、九种功能模型和五项菜单入口；验证B站免费阅读选择、固定模型及写作能力边界。
 * 模块边界：Linkedom 保留实际节点树，展示控件与焦点为受控端口；不调用翻译或验证系统输入法。
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseHTML} from 'linkedom'
import vue from '@vitejs/plugin-vue'
import {createServer, type ViteDevServer} from 'vite'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import ts from 'typescript'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {createApiKeyRequirementKey} from '@/src/core/config/validation'
import {BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation'

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
let server: ViteDevServer, app: import('vue').App, document: Document, win: any, focused: Element | null
let state: Record<string, any>, props: Record<string, any>, shown: import('vue').Ref<boolean>
let events: Map<Element, Record<string, any>>
const updates = vi.fn(), focus = vi.fn(), selectionRange = vi.fn()
const featurePath = 'src/features/settings/ui/FeatureServiceSettings.vue', menuPath = 'src/features/settings/ui/ContextMenuSettings.vue'
let capabilities: Record<string, unknown>
async function settle() {await runtime.nextTick();await Promise.resolve();await runtime.nextTick()}
beforeEach(async () => {
  vi.clearAllMocks();capabilities = runtime.reactive({browser: 'chrome', areaTranslation: true, imageTranslation: true});(globalThis as any).__featureMenuCapabilities = capabilities;events = new Map();const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document;focused = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [key, value] of Object.entries({document, window: win, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLElement: win.HTMLElement, Event: win.Event, Node: win.Node})) vi.stubGlobal(key, value)
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent', resolve: {alias: {'@': process.cwd()}}, server: {hmr: false, middlewareMode: true},
    ssr: {noExternal: ['element-plus', '@element-plus/icons-vue']}, plugins: [{name: 'prompt-profile-controlled-ports', enforce: 'pre', resolveId(id) {
      if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0prompt-i18n'
      if (id === 'element-plus') return '\0prompt-element'
      if (/\/src\/platform\/browser\/capabilities(?:\.ts)?$/u.test(id)) return '\0feature-menu-capabilities'
      if (id === '@element-plus/icons-vue') return '\0prompt-icons'
      if (id.endsWith('.vue') && !/\/(?:FeatureServiceSettings|ContextMenuSettings|SettingsDisclosure)\.vue$/u.test(id)) return '\0prompt-display'
      return null
    }, load(id) {
      if (id === '\0prompt-i18n') return "import {ref} from 'vue';export const useUiI18n = () => ({language: ref('zh-CN'), t: key => key, translateLegacy: text => text})"
      if (id === '\0prompt-element') return "import {h, getCurrentInstance} from 'vue';export const ElPopover = {setup(_, {attrs, slots}) {const instance = getCurrentInstance();return () => h('div', {...attrs, 'data-timing-port-key': instance.vnode.key}, [slots.reference?.(), slots.default?.()])}}"
      if (id === '\0feature-menu-capabilities') return 'export const browserCapabilities = globalThis.__featureMenuCapabilities;'
      if (id === '\0prompt-icons') return 'export const ArrowDown = {}, WarningFilled = {}'
      if (id === '\0prompt-display') return "import {h} from 'vue';export default {setup(_, {slots}) {return () => h('div', null, [slots.copy?.(), slots.default?.()])}}"
      return null
    }}, vue()]})
})
afterEach(async () => {app?.unmount();await settle();await server?.close();delete (globalThis as any).__featureMenuCapabilities;vi.unstubAllGlobals()})
async function compile(path: string) {
  const filename = resolve(path), {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
  const bindings = compileScript(descriptor, {id: 'prompt-profile-test'}).bindings
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'prompt-profile-test', compilerOptions: {mode: 'function', cacheHandlers: true, bindingMetadata: bindings, expressionPlugins: ['typescript']}})
  expect(template.errors).toEqual([])
  const component = (await server.ssrLoadModule(`/${path}`)).default;component.ssrRender = undefined
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime)
  return component
}
async function mount(path: string, values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  if (path === featurePath) await compile('src/features/settings/ui/components/SettingsDisclosure.vue')
  const component = await compile(path), source = runtime.shallowReactive({active: true, context: {}, contextKey: 'service-a', ...values});shown = runtime.ref(true)
  const renderer = runtime.createRenderer({patchProp(el: any, key: string, previous: any, next: any) {
    const handlers = events.get(el) || {};events.set(el, handlers)
    if (/^on[A-Z]/u.test(key)) {handlers[key] = next;const event = key.slice(2).toLowerCase();if (previous) el.removeEventListener(event, previous);if (next) el.addEventListener(event, next);return}
    if (key === 'value' || key === 'modelValue' || key === 'model-value') {el.value = next ?? '';el.setAttribute('data-model-value', String(next ?? ''));return}
    if (key === 'class') {el.className = next ?? '';return}
    if (next === false || next === undefined || next === null) el.removeAttribute(key);else el.setAttribute(key, String(next))
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
    createElement: tag => {const el = document.createElement(tag) as any;el.focus = (options: unknown) => {focus(options);focused = el}
      if (tag === 'textarea') {el.selectionStart = 0;el.selectionEnd = 0;el.setSelectionRange = (start: number, end: number) => {selectionRange(start, end);el.selectionStart = start;el.selectionEnd = end}}
      return el}, createText: text => document.createTextNode(text), createComment: text => document.createComment(text), setText: (n: any, text: string) => {n.nodeValue = text},
    setElementText: (el: any, text: string) => {el.textContent = text}, parentNode: (n: any) => n.parentNode, nextSibling: (n: any) => n.nextSibling,
    querySelector: selector => document.querySelector(selector), setScopeId: () => {}, cloneNode: (n: any) => n.cloneNode(true),
    insertStaticContent: (html: string, parent: any, anchor: any) => {const t = document.createElement('template');t.innerHTML = html;const first = t.content.firstChild!, last = t.content.lastChild!;parent.insertBefore(t.content, anchor);return [first, last]}})
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component, {...source, ...listeners, ref: (vm: any) => {if (vm) {state = vm.$.setupState;props = vm.$.props}}}) : runtime.h({render: () => null}, {key: 'other'})})})
  const control = {setup(_props: unknown, {attrs}: any) {return () => runtime.h('input', attrs)}}
  app.component('el-switch', control);app.component('el-select', control);app.component('el-option', {render: () => null})
  app.component('el-icon', {render: () => null})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};app.mount(document.getElementById('app')!);await settle()
}

const services = [{value: 'openai', label: 'OpenAI'}, {value: 'microsoft', label: 'Microsoft'}, {value: 'deepseek', label: 'DeepSeek'}, {value: 'gone', label: 'Gone', disabled: true}]
function eventOf(el: Element, name = 'onUpdate:modelValue') {const fn = events.get(el)?.[name];expect(fn, name).toBeTypeOf('function');return fn}
function featureControl(id: string) {return document.querySelector(`[data-feature-service="${id}"] input`)!}
function menuControl(id: string) {return document.querySelector(`[data-context-menu-entry="${id}"] input`)!}
function master() {return document.querySelector('input')!}
function invalidate(reason: string) {if (reason === 'hidden') props.active = false;if (reason === 'cached') shown.value = false;if (reason === 'unmount') app.unmount();if (reason === 'config') props.config = runtime.reactive(new Config())}
function snapshot(config: Config) {return {service: config.service, hover: config.hoverTranslationService, selection: config.selectionTranslationService, input: config.inputBoxTranslationService, inputModel: config.inputBoxTranslationModel, reading: {...config.harness}, writing: {...config.writing}, master: config.contextMenuEnabled, entries: {...config.contextMenuEntries}, image: config.imageTranslationContextMenuEnabled}}
async function mountFeature(config = runtime.reactive(new Config()), values: Record<string, unknown> = {}) {await mount(featurePath, {config, serviceOptions: services, ...values}, {'onConfigure-service': updates})}
async function mountMenu(config: Config = runtime.reactive(Object.assign(new Config(), {disableImageTranslator: false, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual'})), values: Record<string, unknown> = {}) {await mount(menuPath, {config, ...values})}

describe('功能服务分配实际缓存模板归属', () => {
  it('默认展开并显示继承摘要，独立服务的缺配置状态仍可发现且不改变配置', async () => {
    const config = runtime.reactive(new Config()); config.service = 'microsoft'; config.harness.enabled = false; config.writing.enabled = false; await mountFeature(config)
    expect(document.querySelector('details.feature-services')?.hasAttribute('open')).toBe(true)
    expect(state.summaryServices).toBe('featureServices.followDefault')
    expect(state.summaryWarning).toBe('')
    config.selectionTranslationService = 'openai'; await settle()
    const snapshot = JSON.stringify(config)
    expect(state.summaryServices).toBe('featureServices.selection')
    expect(state.summaryWarning).toContain('API Key')
    expect(document.querySelector('.feature-services-status')?.textContent).toBe('featureServices.needsSetup')
    expect(JSON.stringify(config)).toBe(snapshot)
    config.token.openai = 'fixture'; await settle()
    expect(state.summaryWarning).toBe('')
    expect(document.querySelector('.feature-services-status')?.textContent).toBe('featureServices.selection')
    expect(config.selectionTranslationService).toBe('openai')
    expect(updates).not.toHaveBeenCalled()
  })
  it('折叠时仍提示继承服务的缺凭据与已开启 AI 功能的能力问题', async () => {
    const config = runtime.reactive(new Config()); config.service = 'microsoft'; config.harness.enabled = false; config.writing.enabled = false; await mountFeature(config)
    const disclosure = document.querySelector('details.feature-services')!
    disclosure.removeAttribute('open')
    expect(state.summaryWarning).toBe('')
    config.harness.enabled = true; await settle()
    expect(state.summaryWarning).toContain('featureServices.reading')
    config.harness.enabled = false; config.writing.enabled = true; await settle()
    expect(state.summaryWarning).toBe('featureServices.writing · featureServices.needsAi')
    expect(document.querySelector('[data-feature-service="writing"] .feature-service-warning')?.textContent).toBe('featureServices.needsAi')
    expect(document.querySelector('.feature-services-status')?.getAttribute('title')).toBe(state.summaryWarning)
    expect(disclosure.hasAttribute('open')).toBe(false)
    config.writing.enabled = false; config.service = 'openai'; await settle()
    expect(state.summaryWarning).toContain('API Key')
    config.token.openai = 'fixture'; await settle()
    expect(state.summaryWarning).toBe('')
  })
  it('旧套餐默认继承使用目录名称，不重新开放选项且父级标签优先', async () => {
    const config = runtime.reactive(new Config());config.service = 'chatgptPlan';config.model.chatgptPlan = 'saved-account-model';await mountFeature(config)
    const before = JSON.stringify(config)
    expect(state.serviceLabel(config.service)).toBe('ChatGPT 套餐')
    expect(featureControl('hover').getAttribute('data-model-value')).toBe('')
    expect(state.rows.find((row: any) => row.feature.id === 'hover').choices.some((item: any) => item.value === 'chatgptPlan')).toBe(false)
    eventOf(featureControl('hover'))('chatgptPlan');expect(config.hoverTranslationService).toBe('');expect(JSON.stringify(config)).toBe(before)
    props.serviceOptions = services.map(item => item.value === 'openai' ? {...item, label: '父级自定义显示名称'} : item);await settle()
    expect(state.serviceLabel('openai')).toBe('父级自定义显示名称');expect(state.serviceLabel('unknown-saved-service')).toBe('unknown-saved-service')
    expect(JSON.stringify(config)).toBe(before);expect(updates).not.toHaveBeenCalled()
  })
  it('B站可分配给阅读并显示固定模型免密钥，写作选择事件不能越过能力限制', async () => {
    const config = runtime.reactive(new Config()); config.service = 'openai'; config.harness.model = 'unused-reader'
    await mountFeature(config, {serviceOptions: [...services, {value: 'bilibili', label: 'B站翻译'}]})
    expect(state.rows.find((row: any) => row.feature.id === 'reading').choices.some((item: any) => item.value === 'bilibili')).toBe(true)
    expect(state.rows.find((row: any) => row.feature.id === 'writing').choices.some((item: any) => item.value === 'bilibili')).toBe(false)
    eventOf(featureControl('writing'))('bilibili'); expect(config.writing.service).toBe('')
    eventOf(featureControl('reading'))('bilibili'); await settle()
    expect(config.harness.service).toBe('bilibili'); expect(config.harness.model).toBe('')
    expect(featureControl('reading').closest('[data-feature-service]')?.parentElement?.querySelector('.feature-service-model')?.textContent).toBe(BILIBILI_FREE_TRANSLATION_MODEL)
    expect(document.querySelector('[data-feature-service="reading"] .feature-service-warning')).toBeNull()
  })
  it('默认B站可直接继承阅读，写作继承和残留独立B站选择显示能力警告并能恢复AI', async () => {
    const config = runtime.reactive(new Config()); config.service = 'bilibili'
    await mountFeature(config, {serviceOptions: [...services, {value: 'bilibili', label: 'B站翻译'}]})
    expect(document.querySelector('[data-feature-service="reading"] .feature-service-warning')).toBeNull()
    expect(document.querySelector('[data-feature-service="writing"] .feature-service-warning')?.textContent).toBe('featureServices.needsAi')
    config.writing.service = 'bilibili'; await settle()
    expect(document.querySelector('[data-feature-service="writing"] .feature-service-warning')?.textContent).toBe('featureServices.aiOnly')
    expect(state.rows.find((row: any) => row.feature.id === 'writing').choices.find((item: any) => item.value === 'bilibili')?.disabled).toBe(true)
    eventOf(featureControl('writing'))('openai'); await settle(); expect(config.writing.service).toBe('openai')
    expect(document.querySelector('[data-feature-service="writing"] .feature-service-warning')?.textContent).toContain('API Key')
  })
  it.each(['hidden', 'cached', 'unmount', 'config'])('%s 后旧选择和配置连接事件失效', async reason => {
    await mountFeature();const choose = eventOf(featureControl('input')), connect = eventOf(document.querySelector('[data-feature-service="input"] button')!, 'onClick');invalidate(reason);await settle();const before = snapshot(props.config)
    choose('openai');connect();expect(snapshot(props.config)).toEqual(before);expect(updates).not.toHaveBeenCalled()
  })
  it('拒绝未知/停用服务和 AI 功能的机器翻译，普通功能可以选择机器翻译并跟随默认', async () => {
    await mountFeature();const before = snapshot(props.config)
    eventOf(featureControl('reading'))('microsoft');eventOf(featureControl('writing'))('gone');eventOf(featureControl('input'))('missing');eventOf(featureControl('hover'))(true);expect(snapshot(props.config)).toEqual(before)
    eventOf(featureControl('hover'))('microsoft');expect(props.config.hoverTranslationService).toBe('microsoft');await settle();eventOf(featureControl('hover'))('');expect(props.config.hoverTranslationService).toBe('')
  })
  it('旧选择在目录权限变化后不能写入，停用的已选项继续展示并允许恢复继承', async () => {
    const config = runtime.reactive(new Config());config.hoverTranslationService = 'gone';await mountFeature(config)
    const old = eventOf(featureControl('hover'));props.serviceOptions = [{value: 'openai', label: 'OpenAI', disabled: true}];await settle();old('openai');expect(config.hoverTranslationService).toBe('gone')
    expect(featureControl('hover').getAttribute('data-model-value')).toBe('gone');eventOf(featureControl('hover'))('');expect(config.hoverTranslationService).toBe('')
  })
  it('配置连接定位捕获当前有效服务，不因外部默认或分配变化跳到另一项', async () => {
    const config = runtime.reactive(new Config());config.service = 'openai';await mountFeature(config);const old = eventOf(document.querySelector('[data-feature-service="hover"] button')!, 'onClick')
    config.hoverTranslationService = 'microsoft';await settle();old();expect(updates).not.toHaveBeenCalled();eventOf(document.querySelector('[data-feature-service="hover"] button')!, 'onClick')();expect(updates).toHaveBeenCalledWith('microsoft')
  })
  it('九项分配保留输入/阅读/写作模型清理与重复选择保留语义', async () => {
    const config = runtime.reactive(new Config());config.service = 'openai';config.inputBoxTranslationService = 'openai';config.inputBoxTranslationModel = 'input-model';config.harness.service = 'openai';config.harness.model = 'reading-model';config.writing.service = 'openai';config.writing.model = 'writing-model';await mountFeature(config)
    expect(document.querySelectorAll('[data-feature-service]').length).toBe(9);for (const id of ['input', 'reading', 'writing']) eventOf(featureControl(id))('openai');expect([config.inputBoxTranslationModel,config.harness.model,config.writing.model]).toEqual(['input-model','reading-model','writing-model'])
    for (const id of ['input', 'reading', 'writing']) eventOf(featureControl(id))('deepseek');expect([config.inputBoxTranslationModel,config.harness.model,config.writing.model]).toEqual(['','','']);expect(config.service).toBe('openai')
  })
  it('凭据按功能独立模型计算，每次渲染不枚举其他配置或模型', async () => {
    const config = runtime.reactive(new Config());config.service = 'openai';config.model.openai = 'main';config.inputBoxTranslationModel = 'input';config.requireApiKey[createApiKeyRequirementKey('openai','input')] = false;let fields = 0, models = 0
    for (let i = 0;i < 1000;i++) Object.defineProperty(config,`unrelated${i}`,{enumerable:true, configurable:true,get:()=>{fields++;return ''}})
    for (let i = 0;i < 500;i++) Object.defineProperty(config.model,`unrelated${i}`,{enumerable:true, configurable:true,get:()=>{models++;return ''}})
    await mountFeature(config);expect(document.querySelector('[data-feature-service="input"] .feature-service-warning')).toBeNull();expect(document.querySelector('[data-feature-service="hover"] .feature-service-warning')).not.toBeNull();expect({fields,models}).toEqual({fields:0,models:0})
    config.requireApiKey[createApiKeyRequirementKey('openai','input')] = true;await settle();expect(document.querySelector('[data-feature-service="input"] .feature-service-warning')).not.toBeNull()
  })
  it('普通未声明 active 调用正常，机器服务继承的 AI 警告不妨碍恢复兼容服务', async () => {
    const config = runtime.reactive(new Config());config.service = 'microsoft';await mountFeature(config,{active:undefined});expect(document.querySelector('[data-feature-service="reading"] .feature-service-warning')?.textContent).toBe('featureServices.needsAi');expect(document.querySelector('[data-feature-service="writing"] .feature-service-warning')?.textContent).toBe('featureServices.needsAi')
    eventOf(featureControl('reading'))('openai');expect(config.harness.service).toBe('openai')
  })
})

describe('右键入口实际缓存模板与能力门禁', () => {
  it.each(['hidden', 'cached', 'unmount', 'config'])('%s 后旧总开关与入口事件失效', async reason => {
    await mountMenu();const change = eventOf(master()), page = eventOf(menuControl('translatePage')), image = eventOf(menuControl('translateImage'));invalidate(reason);await settle();const before = snapshot(props.config)
    change(false);page(false);image(false);expect(snapshot(props.config)).toEqual(before)
  })
  it('总开关关闭后旧入口事件不能改偏好，重新开启保留已保存的入口', async () => {
    await mountMenu();const change = eventOf(menuControl('translatePage'));eventOf(master())(false);await settle();change(false);expect(props.config.contextMenuEntries.translatePage).toBeUndefined();expect(document.querySelectorAll('[data-context-menu-action]').length).toBe(0)
    eventOf(master())(true);await settle();expect(document.querySelector('[data-context-menu-action="translatePage"]')).not.toBeNull()
  })
  it.each(['selection','image','area'])('%s 的前置条件在事件发出前再校验', async kind => {
    const config = runtime.reactive(new Config());config.disableImageTranslator = false;config.disableSelectionTranslator = false;config.selectionTranslatorMode = 'bilingual';config.selectionAreaEnabled = true;config.contextMenuEntries.translateArea = true;await mountMenu(config);const id = kind === 'selection' ? 'translateSelection' : kind === 'image' ? 'translateImage' : 'translateArea', old = eventOf(menuControl(id))
    if (kind === 'selection') config.disableSelectionTranslator = true;if (kind === 'image') capabilities.imageTranslation = false;if (kind === 'area') config.selectionAreaEnabled = false;await settle();old(false)
    expect(kind === 'image' ? config.imageTranslationContextMenuEnabled : config.contextMenuEntries[id]).not.toBe(false);expect(menuControl(id).hasAttribute('disabled')).toBe(true)
  })
  it('未知 ID、非布尔值不写，图片开关保持单一来源且恢复后预览完整', async () => {
    await mountMenu();eventOf(master())('false');eventOf(menuControl('translatePage'))('false');state.writeEntryPreference('unknown',true);expect(props.config.contextMenuEnabled).toBe(true);expect(props.config.contextMenuEntries).toEqual({})
    eventOf(menuControl('translateImage'))(false);await settle();expect(props.config.imageTranslationContextMenuEnabled).toBe(false);expect(props.config.contextMenuEntries.translateImage).toBeUndefined();expect(document.querySelector('[data-context-menu-action="translateImage"]')).toBeNull()
    eventOf(menuControl('translateImage'))(true);await settle();expect(document.querySelectorAll('[data-context-menu-entry]').length).toBe(5);expect(document.querySelector('[data-context-menu-action="translateImage"]')).not.toBeNull()
  })
  it.each(['translatePage','translateImage'])('%s 偏好被外部更新后，旧事件不能借用新控件', async id => {
    await mountMenu();const old = eventOf(menuControl(id));if(id==='translateImage') props.config.imageTranslationContextMenuEnabled = false;else props.config.contextMenuEntries = {[id]:false};await settle();old(true);expect(menuControl(id).getAttribute('data-model-value')).toBe('false');eventOf(menuControl(id))(true);await settle();expect(menuControl(id).getAttribute('data-model-value')).toBe('true')
  })
  it('入口名全部保留，普通默认调用允许开关且前置不可用时保留用户偏好', async () => {
    const config = runtime.reactive(new Config());config.selectionAreaEnabled = true;await mountMenu(config,{active:undefined});eventOf(menuControl('translateArea'))(true);await settle();expect(config.contextMenuEntries.translateArea).toBe(true);expect(document.querySelector('[data-context-menu-action="translateArea"]')).not.toBeNull();config.selectionAreaEnabled = false;await settle();expect(config.contextMenuEntries.translateArea).toBe(true);expect(document.querySelector('[data-context-menu-action="translateArea"]')).toBeNull()
  })
})
