/**
 * @file tests/promptSyncLifecycle.test.ts
 * 文件职责：通过实际 ServiceConfiguration 模板控件与确认端口验证服务设置的操作归属。
 * 主要内容：覆盖原生合批开关的服务范围、默认状态、独立修改和失活事件；验证提示词同步的来源编辑或删除、配置和服务切换、页签和活跃生命周期、目标列表重算、重复确认及旧按钮。
 * 模块边界：编译真实客户端 SFC setup 与缓存模板并实际挂载，Element Plus 和浏览器为受控端口；不访问 setup 私有函数、不证明真实浏览器或存储。
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseHTML} from 'linkedom'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import ts from 'typescript'
import vue from '@vitejs/plugin-vue'
import {createServer, type Plugin, type ViteDevServer} from 'vite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {defaultOption, options, services, servicesType} from '@/src/core/config/catalog'

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
const fixtureKey = '__frPromptSyncLifecycle'
const clientModules = new Map<string, string>()
const sourceId = 'custom:sync-source', removedId = 'custom:sync-removed', secondId = 'custom:sync-second', addedId = 'custom:sync-added'
let server: ViteDevServer, app: import('vue').App | undefined, document: Document, win: any
let props: Record<string, any>, visible: import('vue').Ref<boolean>, fixture: Record<string, any>
let events: Map<Element, Record<string, any>>
const feedback = vi.fn(), send = vi.fn(), save = vi.fn(), queue = vi.fn(), deleted = vi.fn()
type Confirmation = {accept: () => void; cancel: () => void; dismiss: () => void; title: string; message: string; confirmLabel: string; cancelLabel: string}
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick();await runtime.nextTick()}
function translated(key: string, count?: number) {return count === undefined ? key : `${key} count=${count}`}
function configured(): Config {
  const config = new Config()
  config.customOpenAIProviders = [sourceId, removedId, secondId].map(id => ({id, name: id, endpoint: 'https://fixture.invalid/v1', models: []}))
  for (const id of [...servicesType.AI, services.microsoft, sourceId, removedId, secondId, 'custom:orphan']) {
    config.system_role[id] = `system:${id}`;config.user_role[id] = `user:${id}`
  }
  return config
}
function eventOf(element: Element | null) {
  expect(element).not.toBeNull();const handler = events.get(element!)?.onClick;expect(handler).toBeTypeOf('function')
  return () => handler(new win.Event('click'))
}
function syncButton() {return document.querySelector('[data-testid="prompt-sync-all"]') as HTMLButtonElement}
async function openSync() {syncButton().click();await settle();return confirmation()}
function confirmation(): Confirmation {
  const dialog = document.querySelector('[data-confirmation-port]')
  if (dialog) {
    const buttons = dialog.querySelectorAll('button'), port = fixture.dialogs.at(-1)
    const instance = port.instance
    return {accept: eventOf(buttons[1]), cancel: eventOf(buttons[0]), dismiss: () => instance.emit('update:modelValue', false), title: dialog.getAttribute('data-title')!,
      message: dialog.querySelector('p')!.textContent!, confirmLabel: buttons[1].textContent!, cancelLabel: buttons[0].textContent!}
  }
  // 同一公共确认端口兼容修复前 main 的 MessageBox，让失效用例比较配置写入行为。
  const box = fixture.messageBoxes.at(-1);expect(box).toBeDefined()
  return {accept: box.accept, cancel: box.cancel, dismiss: box.cancel, title: box.title, message: box.message,
    confirmLabel: box.options.confirmButtonText, cancelLabel: box.options.cancelButtonText}
}
function snapshot() {return JSON.stringify(props.config)}
beforeEach(async () => {
  vi.clearAllMocks();app = undefined;events = new Map();clientModules.clear()
  const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document
  fixture = {feedback, send, save, queue, messageBoxes: [], tabs: [], dialogs: []}
  fixture.confirm = (message: string, title: string, options: unknown) => new Promise((accept, reject) => {
    fixture.messageBoxes.push({message, title, options, accept, cancel: () => reject('cancel')})
  })
  ;(globalThis as any)[fixtureKey] = fixture
  vi.stubGlobal('window', win)
  const mocks: Plugin = {name: 'prompt-sync-client-sfc-ports', enforce: 'pre', resolveId(id) {
    if (clientModules.has(id)) return id
    if (id.endsWith('.vue') && !id.endsWith('ServiceConfiguration.vue')) return '\0prompt-sync-child'
    if (id === 'webextension-polyfill') return '\0prompt-sync-browser'
    if (id === 'element-plus') return '\0prompt-sync-element'
    if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0prompt-sync-i18n'
    if (/\/src\/services\/config\/store(?:\.ts)?$/u.test(id)) return '\0prompt-sync-config'
    if (/\/src\/platform\/browser\/chromeTranslationPreparationRequest(?:\.ts)?$/u.test(id)) return '\0prompt-sync-chrome-store'
    if (/\/src\/features\/settings\/model\/chromeTranslationPreparation(?:\.ts)?$/u.test(id)) return '\0prompt-sync-chrome-preparation'
    return null
  }, load(id) {
    if (clientModules.has(id)) return clientModules.get(id)
    if (id === '\0prompt-sync-child') return 'export default {render: () => null}'
    if (id === '\0prompt-sync-browser') return `export default {runtime: {sendMessage: globalThis.${fixtureKey}.send}}`
    if (id === '\0prompt-sync-config') return `export const {queue: waitForConfigPersistenceQueue, save: requestConfigSave} = globalThis.${fixtureKey}`
    if (id === '\0prompt-sync-i18n') return "import {ref} from 'vue';export const useUiI18n = () => ({language: ref('zh-CN'), t: (key, params) => params?.count === undefined ? key : key + ' count=' + params.count, translateLegacy: text => text})"
    if (id === '\0prompt-sync-element') return `import {computed, h, inject, provide} from 'vue';
      export const ElMessage = {success: globalThis.${fixtureKey}.feedback}, ElMessageBox = {confirm: globalThis.${fixtureKey}.confirm};
      export const ElTabs = {props: ['modelValue'], emits: ['update:modelValue'], setup(props, {slots, emit}) {
        provide('prompt-sync-tab', computed(() => props.modelValue));globalThis.${fixtureKey}.tabs.push({select: tab => emit('update:modelValue', tab)});
        return () => h('div', slots.default?.())}};
      export const ElTabPane = {props: ['name'], setup(props, {slots}) {const tab = inject('prompt-sync-tab');return () => tab.value === props.name ? h('section', slots.default?.()) : null}};`
    if (id === '\0prompt-sync-chrome-store') return 'export const chromeTranslationPreparationStore = {get: async () => null, clear: async () => {}, subscribe: () => () => {}}'
    if (id === '\0prompt-sync-chrome-preparation') return `export class ChromeTranslationPreparationError extends Error {}
      export const prepareChromeTranslationInPage = () => {throw new Error('unexpected preparation')};
      export const resolveChromeTranslationPreparationPair = (from, to) => ({sourceLanguage: from === 'auto' ? 'en' : from, targetLanguage: to});
      export const getChromeTranslationPreparationLanguageLabel = language => language;`
    return null
  }}
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent', plugins: [mocks, vue()],
    resolve: {alias: {'@': resolve(process.cwd())}}, ssr: {noExternal: ['webextension-polyfill', 'element-plus']}, server: {hmr: false, middlewareMode: true}})
})
afterEach(async () => {
  try {app?.unmount();for (const box of fixture.messageBoxes) box.cancel();await settle();await server?.close()}
  finally {delete (globalThis as any)[fixtureKey];vi.unstubAllGlobals();clientModules.clear()}
  expect(document.querySelector('[data-confirmation-port]')).toBeNull()
  expect(send).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(queue).not.toHaveBeenCalled()
})
async function mount(raw = false) {
  const filename = resolve('src/features/settings/ui/services/ServiceConfiguration.vue')
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
  const script = compileScript(descriptor, {id: 'prompt-sync-public', inlineTemplate: false})
  const clientId = `${filename}.lifecycle-client.ts`
  clientModules.set(clientId, script.content)
  const component = (await server.ssrLoadModule(clientId)).default
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'prompt-sync-public',
    compilerOptions: {mode: 'function', cacheHandlers: true, bindingMetadata: script.bindings, expressionPlugins: ['typescript']}})
  expect(template.errors).toEqual([])
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime)
  const renderer = runtime.createRenderer({patchProp(element: any, key: string, previous: any, next: any) {
    if (/^on[A-Z]/u.test(key)) {
      const handlers = events.get(element) || {};handlers[key] = next;events.set(element, handlers)
      const name = key.slice(2).toLowerCase();if (previous) element.removeEventListener(name, previous);if (next) element.addEventListener(name, next);return
    }
    if (key === 'class') {element.className = next ?? '';return}
    if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(key))) element.removeAttribute(key)
    else element.setAttribute(key, String(next))
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
    createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    setText: (node: any, value) => {node.nodeValue = value}, setElementText: (node: any, value) => {node.textContent = value},
    parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling, querySelector: value => document.querySelector(value),
    setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true), insertStaticContent: (html, parent: any, anchor: any) => {
      const template = document.createElement('template');template.innerHTML = html;const first = template.content.firstChild!, last = template.content.lastChild!
      parent.insertBefore(template.content, anchor);return [first, last]
    }})
  const config = raw ? configured() : runtime.reactive(configured())
  props = runtime.shallowReactive({config, service: sourceId, active: true, selectedModelThinking: false, options, isValidAzureEndpoint: () => true,
    compute: runtime.reactive({showAI: true, showModel: false, showToken: false, showCustomOpenAI: true}), customProvider: config.customOpenAIProviders[0]})
  visible = runtime.ref(true)
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
    ? runtime.h(component, {...props, 'onDelete:custom-provider': deleted}) : runtime.h({render: () => null}, {key: 'other'})})})
  app.component('el-button', {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('button', attrs, slots.default?.())}})
  app.component('el-input', {render: () => null})
  app.component('el-switch', {inheritAttrs: false, props: ['modelValue'], setup(switchProps: {modelValue?: boolean}, {attrs}: any) {
    return () => runtime.h('button', {...attrs, role: 'switch', 'aria-checked': switchProps.modelValue === true})
  }})
  app.component('el-dialog', {props: ['modelValue', 'title'], emits: ['update:modelValue'], setup(dialogProps: {modelValue?: boolean; title?: string}, {slots}: any) {
    fixture.dialogs.push({instance: runtime.getCurrentInstance()})
    return () => dialogProps.modelValue ? runtime.h('div', {'data-confirmation-port': 'true', 'data-title': dialogProps.title}, [slots.default?.(), slots.footer?.()]) : null
  }})
  app.config.warnHandler = () => {};app.mount(document.getElementById('app')!);await settle()
}

describe('原生合批设置的实际模板与服务归属', () => {
  async function select(service: string) {
    props.service = service;props.customProvider = undefined
    props.compute = runtime.reactive({showAI: false, showModel: false, showToken: false, showCustomOpenAI: false})
    await settle()
  }
  function toggle() {
    const element = document.querySelector('[data-native-batch-toggle]')
    expect(element).not.toBeNull()
    const handler = events.get(element!)?.['onUpdate:modelValue']
    expect(handler).toBeTypeOf('function')
    return {element: element!, update: handler as (enabled: boolean) => void}
  }
  it.each([services.google, services.microsoft, services.deepL, services.azureTranslator, services.googleCloudTranslation])('%s 默认开启，实际开关只修改当前服务偏好', async service => {
    await mount();await select(service)
    const defaultService = props.config.service, original = {...props.config.nativeBatchTranslationEnabled}
    expect(document.querySelector('[data-native-batch-service]')?.getAttribute('data-native-batch-service')).toBe(service)
    expect(toggle().element.getAttribute('aria-label')).toBe('settings.services.nativeBatch.label')
    expect(toggle().element.getAttribute('aria-checked')).toBe('true')
    toggle().update(false);await settle()
    expect(props.config.nativeBatchTranslationEnabled).toEqual({...original, [service]: false})
    expect(toggle().element.getAttribute('aria-checked')).toBe('false')
    expect(props.config.service).toBe(defaultService);expect(props.config.enableAIMultiSegment).toBe(false)
    toggle().update(true);await settle();expect(props.config.nativeBatchTranslationEnabled).toEqual(original)
  })
  it('切换配置服务后保留各自开关状态，其他服务不出现开关', async () => {
    await mount();await select(services.google);toggle().update(false);await settle()
    await select(services.microsoft);expect(toggle().element.getAttribute('aria-checked')).toBe('true')
    await select(services.google);expect(toggle().element.getAttribute('aria-checked')).toBe('false')
    for (const service of [services.bilibili, services.deeplx, services.freeTranslation, services.tencent, services.openai, sourceId]) {
      await select(service)
      expect(document.querySelector('[data-native-batch-service]'), service).toBeNull()
      expect(document.querySelector('[data-native-batch-toggle]'), service).toBeNull()
    }
  })
  it.each(['hidden', 'cached', 'unmount', 'config', 'service', 'tab'])('%s 后旧开关事件不修改原配置或当前配置', async reason => {
    await mount();await select(services.google)
    const old = toggle().update, original = props.config
    if (reason === 'hidden') props.active = false
    if (reason === 'cached') visible.value = false
    if (reason === 'unmount') app!.unmount()
    if (reason === 'config') props.config = runtime.reactive(configured())
    if (reason === 'service') await select(services.microsoft)
    if (reason === 'tab') fixture.tabs.at(-1).select('translation')
    await settle();const before = snapshot(), originalBefore = JSON.stringify(original)
    old(false);await settle()
    expect(snapshot()).toBe(before);expect(JSON.stringify(original)).toBe(originalBefore)
  })
  it.each(['hidden', 'cached', 'config', 'service', 'tab'])('%s 往返后旧开关事件不能复活，当前开关仍可修改', async reason => {
    await mount();await select(services.google)
    const old = toggle().update, original = props.config
    if (reason === 'hidden') props.active = false
    if (reason === 'cached') visible.value = false
    if (reason === 'config') props.config = runtime.reactive(configured())
    if (reason === 'service') await select(services.microsoft)
    if (reason === 'tab') fixture.tabs.at(-1).select('translation')
    await settle()
    if (reason === 'hidden') props.active = true
    if (reason === 'cached') visible.value = true
    if (reason === 'config') props.config = original
    if (reason === 'service') await select(services.google)
    if (reason === 'tab') fixture.tabs.at(-1).select('requests')
    await settle();const before = snapshot()
    old(false);await settle();expect(snapshot()).toBe(before)
    toggle().update(false);await settle();expect(props.config.nativeBatchTranslationEnabled.google).toBe(false)
  })
})

describe('提示词同步的实际按钮与确认归属', () => {
  it.each(['hidden', 'cached', 'unmount', 'config', 'service', 'tab', 'ai-off', 'system', 'user', 'provider', 'source-removed', 'source-replaced'])('%s 后旧确认不得写入原配置或当前配置', async reason => {
    await mount();const original = props.config, old = await openSync()
    if (reason === 'hidden') props.active = false
    if (reason === 'cached') visible.value = false
    if (reason === 'unmount') app!.unmount()
    if (reason === 'config') props.config = runtime.reactive(configured())
    if (reason === 'service') props.service = services.openai
    if (reason === 'tab') fixture.tabs.at(-1).select('requests')
    if (reason === 'ai-off') props.compute.showAI = false
    if (reason === 'system') props.config.system_role[sourceId] = 'newer-system'
    if (reason === 'user') props.config.user_role[sourceId] = 'newer-user'
    if (reason === 'provider') props.customProvider = {...props.customProvider}
    if (reason === 'source-removed') props.config.customOpenAIProviders.splice(0, 1)
    if (reason === 'source-replaced') props.config.customOpenAIProviders[0] = {...props.config.customOpenAIProviders[0]}
    await settle();const before = snapshot(), originalBefore = JSON.stringify(original)
    old.accept();old.accept();old.cancel();old.dismiss();await settle()
    expect(snapshot()).toBe(before);expect(JSON.stringify(original)).toBe(originalBefore);expect(feedback).not.toHaveBeenCalled()
    expect(document.querySelector('[data-confirmation-port]')).toBeNull()
  })
  it('确认时重新计算目标，删除的目标不重建，新目标参与同步，非 AI 和孤立键保留', async () => {
    await mount();const old = await openSync()
    props.config.customOpenAIProviders.splice(1, 2)
    for (const id of [removedId, secondId]) {delete props.config.system_role[id];delete props.config.user_role[id]}
    props.config.customOpenAIProviders.push({id: addedId, name: 'Added', endpoint: 'https://fixture.invalid/v1', models: []})
    props.config.system_role[services.deepseek] = 'edited-target';await settle();old.accept();await settle()
    for (const id of [...servicesType.AI, addedId]) {
      expect(props.config.system_role[id]).toBe(`system:${sourceId}`);expect(props.config.user_role[id]).toBe(`user:${sourceId}`)
    }
    for (const id of [removedId, secondId]) {expect(props.config.system_role[id]).toBeUndefined();expect(props.config.user_role[id]).toBeUndefined()}
    for (const id of [sourceId, services.microsoft, 'custom:orphan']) {
      expect(props.config.system_role[id]).toBe(`system:${id}`);expect(props.config.user_role[id]).toBe(`user:${id}`)
    }
    expect(feedback).toHaveBeenCalledWith(translated('settings.services.prompts.syncDone', servicesType.AI.size + 1))
  })
  it('原生按钮重复点击只开一个确认，确认与关闭事件重复到达只写一次', async () => {
    await mount();const oldEntry = eventOf(syncButton());oldEntry();oldEntry();await settle()
    expect(fixture.messageBoxes.length + document.querySelectorAll('[data-confirmation-port]').length).toBe(1)
    const old = confirmation();old.accept();await settle();const system = props.config.system_role, user = props.config.user_role
    props.config.system_role[services.openai] = 'later-target';const before = snapshot()
    old.accept();old.cancel();old.dismiss();oldEntry();await settle()
    expect(snapshot()).toBe(before);expect(props.config.system_role).toBe(system);expect(props.config.user_role).toBe(user)
    expect(feedback).toHaveBeenCalledOnce();expect(document.querySelector('[data-confirmation-port]')).toBeNull()
  })
  it.each(['config', 'service', 'tab', 'hidden', 'cached', 'source'])('%s 往返后原按钮与确认不能复活或关闭新确认', async reason => {
    await mount();const oldEntry = eventOf(syncButton()), old = await openSync(), original = props.config
    if (reason === 'config') props.config = runtime.reactive(configured())
    if (reason === 'service') props.service = services.openai
    if (reason === 'tab') fixture.tabs.at(-1).select('requests')
    if (reason === 'hidden') props.active = false
    if (reason === 'cached') visible.value = false
    if (reason === 'source') props.config.system_role[sourceId] = 'intermediate-edit'
    await settle()
    if (reason === 'config') props.config = original
    if (reason === 'service') {props.service = sourceId;await settle();fixture.tabs.at(-1).select('prompts')}
    if (reason === 'tab') fixture.tabs.at(-1).select('prompts')
    if (reason === 'hidden') props.active = true
    if (reason === 'cached') visible.value = true
    if (reason === 'source') props.config.system_role[sourceId] = `system:${sourceId}`
    await settle();oldEntry();await settle();expect(document.querySelector('[data-confirmation-port]')).toBeNull()
    const current = await openSync(), before = snapshot();old.accept();old.cancel();old.dismiss();await settle()
    expect(snapshot()).toBe(before);expect(feedback).not.toHaveBeenCalled();expect(document.querySelector('[data-confirmation-port]')).not.toBeNull()
    current.accept();await settle();expect(feedback).toHaveBeenCalledOnce()
  })
  it.each(['config', 'service', 'tab', 'hidden', 'cached', 'source'])('未打开确认前捕获的入口在%s 往返后也不能复活', async reason => {
    await mount();const oldEntry = eventOf(syncButton()), original = props.config
    if (reason === 'config') props.config = runtime.reactive(configured())
    if (reason === 'service') props.service = services.openai
    if (reason === 'tab') fixture.tabs.at(-1).select('requests')
    if (reason === 'hidden') props.active = false
    if (reason === 'cached') visible.value = false
    if (reason === 'source') props.config.user_role[sourceId] = 'intermediate-edit'
    await settle()
    if (reason === 'config') props.config = original
    if (reason === 'service') {props.service = sourceId;await settle();fixture.tabs.at(-1).select('prompts')}
    if (reason === 'tab') fixture.tabs.at(-1).select('prompts')
    if (reason === 'hidden') props.active = true
    if (reason === 'cached') visible.value = true
    if (reason === 'source') props.config.user_role[sourceId] = `user:${sourceId}`
    await settle();const before = snapshot();oldEntry();await settle()
    expect(snapshot()).toBe(before);expect(fixture.messageBoxes).toHaveLength(0);expect(document.querySelector('[data-confirmation-port]')).toBeNull()
    const current = await openSync();current.accept();await settle();expect(feedback).toHaveBeenCalledOnce()
  })
  it.each(['reset', 'delete'])('同步使用原有翻译文案，取消不写；旧同步确认不能操作后来打开的 %s 确认', async kind => {
    await mount();expect(syncButton().textContent).toContain('settings.services.prompts.syncAll')
    const old = await openSync(), before = snapshot()
    expect(old.title).toBe('settings.services.prompts.syncConfirmTitle')
    expect(old.message).toBe(translated('settings.services.prompts.syncConfirmMessage', servicesType.AI.size + 2))
    expect(old.confirmLabel).toBe('settings.services.prompts.syncConfirmAction');expect(old.cancelLabel).toBe('settings.services.prompts.syncCancel')
    old.cancel();await settle();expect(snapshot()).toBe(before)
    const button = kind === 'reset' ? [...document.querySelectorAll('button')].find(button => button.textContent === '恢复默认模板')!
      : document.querySelector('[data-testid="custom-service-delete"]') as HTMLButtonElement
    button.click();await settle();const current = confirmation();old.accept();old.dismiss();await settle()
    expect(snapshot()).toBe(before);expect(feedback).not.toHaveBeenCalled();expect(deleted).not.toHaveBeenCalled();expect(document.querySelector('[data-confirmation-port]')).not.toBeNull()
    current.accept();current.accept();await settle()
    if (kind === 'reset') {expect(props.config.system_role[sourceId]).toBe(defaultOption.system_role);expect(props.config.user_role[sourceId]).toBe(defaultOption.user_role)}
    else {expect(snapshot()).toBe(before);expect(deleted).toHaveBeenCalledOnce()}
    expect(props.config.system_role[services.openai]).toBe(`system:${services.openai}`)
  })
  it.each(['custom', 'builtin'])('普通配置对象的 %s AI 来源保持身份并支持全部服务同步', async kind => {
    await mount(true)
    if (kind === 'builtin') {props.service = services.deepseek;props.customProvider = undefined;await settle();fixture.tabs.at(-1).select('prompts');await settle()}
    const source = props.service
    const old = await openSync();old.accept();await settle()
    for (const id of [...servicesType.AI, sourceId, removedId, secondId]) {
      expect(props.config.system_role[id]).toBe(`system:${source}`);expect(props.config.user_role[id]).toBe(`user:${source}`)
    }
    expect(feedback).toHaveBeenCalledWith(translated('settings.services.prompts.syncDone', servicesType.AI.size + 2))
  })
})
