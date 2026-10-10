/**
 * @file tests/informationHighlightSettingsLifecycle.test.ts
 * 文件职责：验证智能高亮独立设置分组的真实父子模板、回退操作归属和按需模型读取。
 * 主要内容：执行 Settings、Preferences 与 ModelCard 的 Vue setup 和客户端模板，覆盖模式后插槽、标题标签的可访问触发配置和 Escape 关闭调用、只改偏好的关键词回退，以及配置替换、隐藏、缓存停用、卸载和迟到读取。
 * 模块边界：使用受控浏览器消息、Element Plus 展示端口与 Linkedom 节点树；不下载模型、不启用网页、不把受控提示端口视为真实浏览器的浮层交互或 GPU 证据。
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
import {getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel'
import type {InformationHighlightModelStatus} from '@/src/features/information-highlight/protocol'
import {INFORMATION_HIGHLIGHT_COLORS, INFORMATION_HIGHLIGHT_PALETTES, informationHighlightOpacity} from '@/src/features/information-highlight/domain/presentation'

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
const key = '__fluentReadInformationHighlightSettingsLifecycle'
const folder = 'src/features/settings/ui/'
const realComponents = ['InformationHighlightSettings', 'InformationHighlightPreferences', 'InformationHighlightModelCard', 'InformationHighlightPreview', 'SettingsGroup']
let server: ViteDevServer | undefined, app: import('vue').App | undefined
let document: Document, props: {config: Config; active?: boolean}
let shown: import('vue').Ref<boolean>, events: Map<Element, Record<string, any>>
const tooltips: {props: Record<string, any>; hide: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn>}[] = []
const previewStory = '认真阅读长文时，可以先观察段落中的观点与线索，再回到数字、条件和细节。文字依旧完整，颜色只是帮助视线停留，café 👨‍👩‍👧‍👦。\n\n同一段文字可以有不同侧重。试着调整配色与浓淡，找到自己舒服的阅读节奏。'
const Tooltip = runtime.defineComponent({props: {content: String, trigger: [Array, String], disabled: Boolean, teleported: Boolean, persistent: Boolean,
  showAfter: Number, hideAfter: Number, placement: String, effect: String, popperClass: String}, setup(props, {slots, expose}) {
  const hide = vi.fn(), onClose = vi.fn(); tooltips.push({props, hide, onClose}); expose({hide, onClose})
  return () => runtime.h('span', {'data-tooltip-port': ''}, [slots.default?.(), runtime.h('span', {'data-tooltip-content-port': '', class: props.popperClass}, props.content)])
}})
// 只替代 Element Plus 浮层展示；确认/取消内容、生命周期和消息仍由真实产品组件执行。
const Dialog = runtime.defineComponent({inheritAttrs: false, props: {modelValue: Boolean, closeOnPressEscape: {type: Boolean, default: true}, closeOnClickModal: Boolean},
  emits: ['update:modelValue', 'close'], setup(props, {attrs, slots, emit}) {
    return () => props.modelValue ? runtime.h('div', {...attrs, 'data-controlled-model-dialog': '', onKeydown: (event: {key: string}) => {
      if (event.key === 'Escape' && props.closeOnPressEscape) {emit('update:modelValue', false); emit('close')}
    }}, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null
  }})
const send = vi.fn((_message: {type: string; modelId?: InformationHighlightModelId}) => Promise.resolve({success: true, status: model()}))
function model(overrides: Partial<InformationHighlightModelStatus> = {}): InformationHighlightModelStatus {
  return {modelId: 'qwen2.5-0.5b', phase: 'absent', downloaded: false, initialized: false, downloadedBytes: 0, totalBytes: 490043908,
    supported: true, modelName: 'Qwen2.5 0.5B', downloadSizeBytes: 490043908, ...overrides}
}
function modelFor(modelId?: InformationHighlightModelId, overrides: Partial<InformationHighlightModelStatus> = {}) {
  const selected = getInformationHighlightModel(modelId)
  return model({modelId: selected.id, modelName: selected.name, totalBytes: selected.bytes, downloadSizeBytes: selected.bytes, ...overrides})
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes}); return {promise, resolve}}
async function settle() {for (let i = 0; i < 8; i++) {await Promise.resolve(); await runtime.nextTick()}}
function element(selector: string): Element {const current = document.querySelector(selector); expect(current, selector).not.toBeNull(); return current!}
function event(selector: string, name = 'onClick'): (...args: unknown[]) => unknown {
  const callback = events.get(element(selector))?.[name]; expect(callback, `${selector} ${name}`).toBeTypeOf('function'); return callback
}
function modeSelect() {return event('[data-information-highlight-mode-select]', 'onUpdate:modelValue')}
function card(modelId: InformationHighlightModelId) {return `section[data-information-highlight-model-id="${modelId}"]`}
function modelChoice(modelId: InformationHighlightModelId) {return event(`[data-information-highlight-model-choice="${modelId}"]`, 'onChange')}
function cardEvent(modelId: InformationHighlightModelId, action: 'download' | 'remove' | 'pause') {return event(`${card(modelId)} [data-information-highlight-${action}]`)}
function commands(type: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL' | 'REMOVE_INFORMATION_HIGHLIGHT_MODEL') {return send.mock.calls.filter(([message]) => message.type === type).map(([message]) => message)}
function messages() {return send.mock.calls.map(([message]) => message.type)}
function expectOnlyReads() {expect(messages().every(type => type === 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS')).toBe(true)}

beforeEach(async () => {
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']}); send.mockReset(); send.mockImplementation(async message => ({success: true, status: modelFor(message.modelId)}))
  events = new Map(); tooltips.length = 0; document = parseHTML('<html><body><div id="app"></div></body></html>').document as unknown as Document
  Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'})
  vi.stubGlobal('document', document); Object.assign(globalThis, {[key]: {send, Tooltip, Dialog, previewStory}})
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(),
    resolve: {alias: {'@': resolve(process.cwd())}}, ssr: {noExternal: ['webextension-polyfill', 'element-plus']},
    server: {hmr: false, middlewareMode: true}, plugins: [{name: 'information-highlight-settings-controlled-ports', enforce: 'pre', resolveId(id) {
      if (id === 'webextension-polyfill') return '\0highlight-settings-browser'
      if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0highlight-settings-i18n'
      if (id === 'element-plus') return '\0highlight-settings-options'
      if (id.endsWith('/UiSelect.vue')) return '\0highlight-settings-select'
      if (id.endsWith('.vue') && !realComponents.some(name => id.endsWith(`/${name}.vue`))) return '\0highlight-settings-display'
      return null
    }, load(id) {
      if (id === '\0highlight-settings-browser') return `export default {runtime: {sendMessage: globalThis.${key}.send}}`
      if (id === '\0highlight-settings-i18n') return `export const useUiI18n = () => ({t: (key, params) => key === 'informationHighlight.preview.story' ? globalThis.${key}.previewStory : params ? key + ' ' + JSON.stringify(params) : key});`
      if (id === '\0highlight-settings-options') return `import {h} from 'vue';export const ElOption = {render: () => null}; export const ElSwitch = {inheritAttrs: false, setup(_, {attrs}) {return () => h('button', attrs)}}; export const ElTooltip = globalThis.${key}.Tooltip; export const ElDialog = globalThis.${key}.Dialog;`
      if (id === '\0highlight-settings-select') return "import {h} from 'vue';export default {setup(_, {attrs, slots}) {return () => h('div', attrs, slots.default?.())}};"
      if (id === '\0highlight-settings-display') return 'export default {render: () => null};'
      return null
    }}, vue()]})
})
afterEach(async () => {
  app?.unmount(); app = undefined; await settle(); await server?.close(); server = undefined
  delete (globalThis as Record<string, unknown>)[key]; vi.unstubAllGlobals(); vi.useRealTimers()
})
async function compile(relative: string) {
  const filename = resolve(relative), {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
  const script = compileScript(descriptor, {id: 'information-highlight-settings-client'})
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'information-highlight-settings-client',
    compilerOptions: {mode: 'function', cacheHandlers: true, bindingMetadata: script.bindings, expressionPlugins: ['typescript']}})
  expect(template.errors).toEqual([])
  const component = (await server!.ssrLoadModule(`/${relative}`)).default; component.ssrRender = undefined
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime)
  return component
}
async function mount(mode: 'keywords' | 'surprisal-local' = 'surprisal-local', active: boolean | undefined = true) {
  for (const name of realComponents.filter(name => name !== 'InformationHighlightSettings')) {
    await compile(`${folder}${name === 'SettingsGroup' ? 'components/' : ''}${name}.vue`)
  }
  const component = await compile(`${folder}InformationHighlightSettings.vue`)
  props = runtime.reactive({config: new Config(), active}); props.config.on = false
  props.config.informationHighlight = {enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, model: 'qwen2.5-0.5b', mode, density: 'high', color: 'blue', style: 'underline', intensity: 'standard'}; shown = runtime.ref(true)
  const renderer = runtime.createRenderer<Node, Element>({patchProp(el, name, _previous, value) {
    const handlers = events.get(el) || {}; events.set(el, handlers)
    if (/^on[A-Z]/u.test(name)) {handlers[name] = value; return}
    if (name === 'class') {el.setAttribute('class', value || ''); return}
    if (name === 'style') {const style = (el as HTMLElement).style; style.cssText = ''; Object.assign(style, value || {}); return}
    if (value === false || value === undefined || value === null) el.removeAttribute(name); else el.setAttribute(name, String(value))
  }, insert: (child, parent, anchor = null) => parent.insertBefore(child, anchor), remove: child => child.parentNode?.removeChild(child),
    createElement: tag => document.createElement(tag), createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
    setText: (node, text) => {node.nodeValue = text}, setElementText: (el, text) => {el.textContent = text},
    parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling, querySelector: selector => document.querySelector(selector),
    setScopeId: (el, id) => el.setAttribute(id, ''), cloneNode: node => node.cloneNode(true), insertStaticContent: (html, parent, anchor) => {
      const template = document.createElement('template'); template.innerHTML = html
      const first = template.content.firstChild!, last = template.content.lastChild!; parent.insertBefore(template.content, anchor); return [first, last]
    }})
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component, props) : runtime.h({render: () => null}, {key: 'other'})})})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()}); app.config.warnHandler = () => {}
  app.mount(document.getElementById('app')!); await settle()
}

describe('信息高亮设置真实父子模板与生命周期', () => {
  it('两个模型卡分别显示大小和资源状态，原生单选仅保存选择；下载和删除都先确认', async () => {
    const downloaded = new Set<InformationHighlightModelId>()
    send.mockImplementation(async message => {
      const selected = getInformationHighlightModel(message.modelId)
      if (message.type === 'PREPARE_INFORMATION_HIGHLIGHT_MODEL') downloaded.add(selected.id)
      if (message.type === 'REMOVE_INFORMATION_HIGHLIGHT_MODEL') downloaded.delete(selected.id)
      return {success: true, status: modelFor(selected.id, {downloaded: downloaded.has(selected.id), phase: downloaded.has(selected.id) ? 'ready' : 'absent', downloadedBytes: downloaded.has(selected.id) ? selected.bytes : 0})}
    })
    await mount(); const q2 = element(card('qwen2.5-0.5b')), q3 = element(card('qwen3-0.6b'))
    expect(document.querySelectorAll('[data-testid="information-highlight-model-card"]')).toHaveLength(2)
    expect(element(`${card('qwen2.5-0.5b')} [data-information-highlight-download]`).textContent).toContain('490 MB')
    expect(element(`${card('qwen3-0.6b')} [data-information-highlight-download]`).textContent).toContain('579 MB')
    expect(document.querySelector('.highlight-model-status')).toBeNull(); expect(document.querySelector('.highlight-model-privacy')).toBeNull()
    expect(element('[data-information-highlight-mode-select]').closest('label')!.querySelector('small')).toBeNull()
    const radios = [...document.querySelectorAll('[data-information-highlight-model-radio]')]
    expect(radios).toHaveLength(2); expect(radios.every(radio => radio.getAttribute('type') === 'radio')).toBe(true)
    expect(new Set(radios.map(radio => radio.getAttribute('name'))).size).toBe(1); expect(radios[0].getAttribute('name')).toBeTruthy()
    expect(document.querySelector('[data-information-highlight-model-select]')).toBeNull()
    modelChoice('qwen3-0.6b')(); await settle(); expect(props.config.informationHighlight.model).toBe('qwen3-0.6b'); expect(q3.querySelector('strong')?.textContent).toBe('Qwen3 0.6B')
    expect(element(card('qwen2.5-0.5b'))).toBe(q2); expect(element(card('qwen3-0.6b'))).toBe(q3); expectOnlyReads()
    cardEvent('qwen3-0.6b', 'download')(); await settle(); expect(commands('PREPARE_INFORMATION_HIGHLIGHT_MODEL')).toHaveLength(0)
    const dialog = element('[data-information-highlight-model-dialog]')
    expect(dialog.getAttribute('data-information-highlight-model-id')).toBe('qwen3-0.6b'); expect(dialog.getAttribute('data-information-highlight-action')).toBe('prepare')
    expect(dialog.textContent).toContain('Qwen3 0.6B'); expect(dialog.textContent).toContain('579 MB')
    const confirm = event('[data-information-highlight-confirm]'); const pending = confirm(); await confirm(); await pending; await settle()
    expect(commands('PREPARE_INFORMATION_HIGHLIGHT_MODEL')).toEqual([{type: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen3-0.6b'}])
    expect(document.querySelector('[data-information-highlight-model-dialog]')).toBeNull()
    expect(q3.querySelectorAll('.highlight-model-actions button')).toHaveLength(1)
    expect(element(`${card('qwen3-0.6b')} [data-information-highlight-remove]`).textContent).toBe('informationHighlight.model.remove')
    expect(q2.querySelector('[data-information-highlight-remove]')).toBeNull(); expect(q2.querySelector('[data-information-highlight-download]')).not.toBeNull()
    expect(document.querySelector('.highlight-model-ready')).toBeNull(); expect(document.querySelector('.highlight-model-status')).toBeNull()
    cardEvent('qwen3-0.6b', 'remove')(); await settle(); event('[data-information-highlight-cancel]')(); await settle()
    expect(commands('REMOVE_INFORMATION_HIGHLIGHT_MODEL')).toHaveLength(0); expect(element(`${card('qwen3-0.6b')} [data-information-highlight-remove]`)).toBeTruthy()
    cardEvent('qwen3-0.6b', 'remove')(); await settle(); await event('[data-information-highlight-confirm]')(); await settle()
    expect(commands('REMOVE_INFORMATION_HIGHLIGHT_MODEL')).toEqual([{type: 'REMOVE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen3-0.6b'}])
    expect(element(`${card('qwen3-0.6b')} [data-information-highlight-download]`).textContent).toContain('579 MB')
    expect(props.config.informationHighlight.model).toBe('qwen3-0.6b'); expect(props.config.on).toBe(false)
  })
  it.each(['cancel', 'close', 'escape'] as const)('续传也需二次确认，%s 关闭不会发送命令，缓存确认按钮失效', async reason => {
    send.mockImplementation(async message => ({success: true, status: modelFor(message.modelId, message.modelId === 'qwen3-0.6b' ? {phase: 'paused', downloadedBytes: 20} : {})}))
    await mount(); expect(element(`${card('qwen3-0.6b')} [data-information-highlight-download]`).textContent).toBe('informationHighlight.model.resume')
    cardEvent('qwen3-0.6b', 'download')(); await settle(); const oldConfirm = event('[data-information-highlight-confirm]')
    expectOnlyReads(); expect(element('[data-information-highlight-confirm]').textContent).toBe('informationHighlight.model.resume')
    if (reason === 'escape') event('[data-controlled-model-dialog]', 'onKeydown')({key: 'Escape'})
    else event(`[data-information-highlight-${reason}]`)()
    await settle(); expect(document.querySelector('[data-information-highlight-model-dialog]')).toBeNull(); await oldConfirm(); expectOnlyReads()
    cardEvent('qwen3-0.6b', 'download')(); await settle(); await event('[data-information-highlight-confirm]')(); await settle()
    expect(commands('PREPARE_INFORMATION_HIGHLIGHT_MODEL')).toEqual([{type: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen3-0.6b'}]); expect(props.config.on).toBe(false)
  })
  it.each(['selection', 'configuration', 'preferences', 'hidden', 'cached', 'unmounted'] as const)('%s 变更撤销旧确认，迟到确认和关闭不操作新归属', async reason => {
    await mount(); cardEvent('qwen2.5-0.5b', 'download')(); await settle()
    const oldConfirm = event('[data-information-highlight-confirm]'), oldCancel = event('[data-information-highlight-cancel]'), original = props.config
    if (reason === 'selection') modelChoice('qwen3-0.6b')()
    else if (reason === 'configuration') {const next = new Config(); next.on = false; next.informationHighlight = {...props.config.informationHighlight}; props.config = next}
    else if (reason === 'preferences') props.config.informationHighlight = {...props.config.informationHighlight}
    else if (reason === 'hidden') props.active = false
    else if (reason === 'cached') shown.value = false
    else {app!.unmount(); app = undefined}
    await settle(); expect(document.querySelector('[data-information-highlight-model-dialog]')).toBeNull(); await oldConfirm(); expectOnlyReads(); expect(original.on).toBe(false)
    if (reason === 'unmounted') return
    if (reason === 'hidden') props.active = true; else if (reason === 'cached') shown.value = true
    await settle(); cardEvent('qwen3-0.6b', 'download')(); await settle(); oldCancel(); await settle()
    expect(element('[data-information-highlight-model-dialog]').getAttribute('data-information-highlight-model-id')).toBe('qwen3-0.6b')
    await oldConfirm(); await event('[data-information-highlight-confirm]')(); await settle()
    expect(commands('PREPARE_INFORMATION_HIGHLIGHT_MODEL')).toEqual([{type: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen3-0.6b'}]); expect(props.config.on).toBe(false)
  })
  it('六套配色直接呈现真实浓淡色阶，单击后即时预览并只保存阅读偏好', async () => {
    await mount('keywords'); event('[data-information-highlight-style="heatmap"]')(); await settle()
    expect(document.querySelectorAll('[data-information-highlight-color]')).toHaveLength(6)
    expect(document.querySelectorAll('[data-information-highlight-style]')).toHaveLength(3)
    for (const color of INFORMATION_HIGHLIGHT_COLORS) {
      const button = element(`[data-information-highlight-color="${color}"]`), shades = [...button.querySelectorAll('[data-information-highlight-palette-sample]')]
      expect(shades).toHaveLength(5)
      expect(new Set(shades.map(shade => shade.getAttribute('style'))).size).toBe(5)
      event(`[data-information-highlight-color="${color}"]`)(); await settle()
      expect(props.config.informationHighlight.color).toBe(color)
      expect(button.getAttribute('aria-pressed')).toBe('true'); expect(button.querySelector('svg')).not.toBeNull()
      expect(document.querySelectorAll('[data-information-highlight-color][aria-pressed="true"]')).toHaveLength(1)
      const preview = element('[data-testid="information-highlight-preview"]') as HTMLElement
      expect(preview.getAttribute('data-information-highlight-preview-color')).toBe(color)
      expect(preview.style.getPropertyValue('--highlight-preview-rgb')).toBe(INFORMATION_HIGHLIGHT_PALETTES[color].rgb)
    }
    expect(send).not.toHaveBeenCalled(); expect(props.config.on).toBe(false)
  })
  it('首行开关只写入自动高亮偏好，不触发模型请求，停用视图后旧回调无效', async () => {
    await mount('keywords'); const control = element('[data-information-highlight-enabled]')
    expect(control.getAttribute('aria-label')).toBe('informationHighlight.enabled')
    const toggle = event('[data-information-highlight-enabled]', 'onUpdate:modelValue')
    toggle(true); await settle(); expect(props.config.informationHighlight).toEqual({enabled: true, hotkey: 'Alt+H', hotkeyEnabled: true, model: 'qwen2.5-0.5b', mode: 'keywords', density: 'high', color: 'blue', style: 'underline', intensity: 'standard'})
    props.active = false; await settle(); toggle(false); expect(props.config.informationHighlight.enabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
  it('颜色浓度三档即时改变预览、色阶卡与样例的透明度，只保存 intensity', async () => {
    await mount('keywords'); event('[data-information-highlight-style="heatmap"]')(); await settle()
    expect(document.querySelectorAll('[data-information-highlight-intensity]')).toHaveLength(3)
    const top = () => Math.max(...[...document.querySelectorAll('[data-information-highlight-preview-level]')].map(mark => Number((mark as HTMLElement).style.getPropertyValue('--highlight-preview-opacity'))))
    const seen: number[] = []
    for (const intensity of ['soft', 'standard', 'strong'] as const) {
      event(`[data-information-highlight-intensity="${intensity}"]`)(); await settle()
      expect(props.config.informationHighlight.intensity).toBe(intensity)
      expect(element(`[data-information-highlight-intensity="${intensity}"]`).getAttribute('aria-pressed')).toBe('true')
      expect(document.querySelectorAll('[data-information-highlight-intensity][aria-pressed="true"]')).toHaveLength(1)
      expect(top()).toBe(informationHighlightOpacity('heatmap', 7, intensity)); seen.push(top())
      expect(element('[data-information-highlight-color="rose"] [data-information-highlight-palette-sample]:last-child').getAttribute('style')).toContain(String(informationHighlightOpacity('heatmap', 7, intensity)))
    }
    expect(seen[0]).toBeLessThan(seen[1]); expect(seen[1]).toBeLessThan(seen[2])
    expect(props.config.informationHighlight).toMatchObject({mode: 'keywords', density: 'high', color: 'blue', style: 'heatmap'}); expect(send).not.toHaveBeenCalled()
  })
  it('预览可切换到未高亮的原文对比，文字完全相同，切回后恢复高亮且不写配置', async () => {
    await mount('keywords'); event('[data-information-highlight-style="heatmap"]')(); await settle()
    const passage = () => [...document.querySelectorAll('.highlight-preview-text')].map(paragraph => paragraph.textContent).join('\n\n')
    const marks = () => document.querySelectorAll('[data-information-highlight-preview-level]').length
    const before = marks(), saved = JSON.stringify(props.config.informationHighlight); expect(before).toBeGreaterThan(0)
    expect(element('[data-information-highlight-preview-view="highlighted"]').getAttribute('aria-pressed')).toBe('true')
    event('[data-information-highlight-preview-view="original"]')(); await settle()
    expect(marks()).toBe(0); expect(passage()).toBe(previewStory)
    expect(element('[data-information-highlight-preview-view="original"]').getAttribute('aria-pressed')).toBe('true')
    expect(element('.highlight-preview-legend').getAttribute('class')).toContain('is-hidden')
    event('[data-information-highlight-preview-view="highlighted"]')(); await settle()
    expect(marks()).toBe(before); expect(passage()).toBe(previewStory); expect(JSON.stringify(props.config.informationHighlight)).toBe(saved); expect(send).not.toHaveBeenCalled()
  })
  it('热力预览按密度改变覆盖与浓淡，切换三种样式保留完整示意原文和 Unicode', async () => {
    await mount('keywords'); event('[data-information-highlight-style="heatmap"]')(); await settle()
    const passage = () => [...document.querySelectorAll('.highlight-preview-text')].map(paragraph => paragraph.textContent).join('\n\n')
    const marks = () => [...document.querySelectorAll('[data-information-highlight-preview-level]')]
    const counts: number[] = []
    for (const density of ['low', 'medium', 'high']) {
      event(`[data-information-highlight-density="${density}"]`)(); await settle(); counts.push(marks().length)
      expect(passage()).toBe(previewStory)
      expect(element('[data-testid="information-highlight-preview"]').getAttribute('data-information-highlight-preview-density')).toBe(density)
    }
    expect(counts[0]).toBeLessThan(counts[1]); expect(counts[1]).toBeLessThan(counts[2])
    expect(new Set(marks().map(mark => mark.getAttribute('data-information-highlight-preview-level'))).size).toBeGreaterThan(4)
    for (const mark of marks()) {
      const level = Number(mark.getAttribute('data-information-highlight-preview-level'))
      expect(String((mark as HTMLElement).style.getPropertyValue('--highlight-preview-opacity'))).toBe(String(informationHighlightOpacity('heatmap', level)))
    }
    expect(document.querySelector('.highlight-preview-legend')).not.toBeNull()
    for (const style of ['background', 'underline']) {
      event(`[data-information-highlight-style="${style}"]`)(); await settle()
      expect(passage()).toBe(previewStory); expect(document.querySelector('.highlight-preview-legend')).toBeNull()
      expect(element('[data-testid="information-highlight-preview"]').getAttribute('data-information-highlight-preview-style')).toBe(style)
      expect(marks().every(mark => String((mark as HTMLElement).style.getPropertyValue('--highlight-preview-opacity')) === String(informationHighlightOpacity(style as 'background' | 'underline', 7)))).toBe(true)
    }
    expect(element('[data-testid="information-highlight-preview"] figcaption').textContent).toBe('informationHighlight.preview.caption')
    expect(send).not.toHaveBeenCalled(); expect(props.config.on).toBe(false)
  })
  it('标题辅助插槽保留原始标题，三个标签是原生按钮并声明悬停、聚焦和点击提示', async () => {
    await mount('keywords')
    const heading = element('#information-highlight-settings .settings-group-heading'), title = element('#information-highlight-settings h2')
    expect(title.textContent).toBe('informationHighlight.title'); expect(heading.querySelectorAll('h2')).toHaveLength(1)
    expect(title.nextElementSibling).toBe(element('.information-highlight-tags'))
    expect(element('.information-highlight-tags').nextElementSibling?.textContent).toBe('informationHighlight.description')
    expect(tooltips).toHaveLength(3)
    for (const [index, tag] of ['keywords', 'surprisal', 'reading'].entries()) {
      const button = element(`[data-information-highlight-tag="${tag}"]`)
      expect(button.tagName).toBe('BUTTON'); expect(button.getAttribute('type')).toBe('button'); expect(button.getAttribute('tabindex')).not.toBe('-1')
      expect(button.getAttribute('aria-label')).toBe(`informationHighlight.tags.${tag}`); expect(button.textContent).toBe(`informationHighlight.tags.${tag}`)
      expect(button.hasAttribute('disabled')).toBe(false)
      expect(tooltips[index].props).toMatchObject({content: `informationHighlight.tags.${tag}.help`, trigger: ['hover', 'focus', 'click'],
        disabled: false, persistent: false, teleported: false, placement: 'bottom', showAfter: 150, hideAfter: 100, popperClass: 'fluentread-information-highlight-tag-popper'})
    }
    expect(send).not.toHaveBeenCalled(); expect(props.config.on).toBe(false)
  })
  it('Escape 调用现有提示延迟关闭和立即隐藏端口，不移动焦点或改偏好；其他键不关闭', async () => {
    await mount('keywords'); const before = {...props.config.informationHighlight}, stopPropagation = vi.fn()
    event('[data-information-highlight-tag="surprisal"]', 'onKeydown')({key: 'Enter', stopPropagation})
    expect(stopPropagation).not.toHaveBeenCalled(); expect(tooltips.every(tooltip => tooltip.hide.mock.calls.length === 0)).toBe(true)
    event('[data-information-highlight-tag="surprisal"]', 'onKeydown')({key: 'Escape', stopPropagation})
    expect(stopPropagation).toHaveBeenCalledOnce()
    for (const tooltip of tooltips) {expect(tooltip.onClose).toHaveBeenCalledOnce(); expect(tooltip.hide).toHaveBeenCalledOnce()}
    expect(props.config.informationHighlight).toEqual(before); expect(send).not.toHaveBeenCalled(); expect(props.config.on).toBe(false)
  })
  it.each(['hidden', 'cached', 'unmounted'] as const)('%s 撤销提示触发所有权；卸载后的旧 Escape 不触碰已移除的提示', async reason => {
    await mount('keywords'); const button = element('[data-information-highlight-tag="keywords"]'), escape = event('[data-information-highlight-tag="keywords"]', 'onKeydown')
    if (reason === 'hidden') props.active = false
    else if (reason === 'cached') shown.value = false
    else {app!.unmount(); app = undefined}
    await settle()
    for (const tooltip of tooltips) {expect(tooltip.onClose).toHaveBeenCalledOnce(); expect(tooltip.hide).toHaveBeenCalledOnce()}
    if (reason === 'unmounted') {
      escape({key: 'Escape', stopPropagation: vi.fn()})
      for (const tooltip of tooltips) {expect(tooltip.onClose).toHaveBeenCalledOnce(); expect(tooltip.hide).toHaveBeenCalledOnce()}
      expect(document.querySelector('[data-tooltip-content-port]')).toBeNull()
    } else {
      expect(button.hasAttribute('disabled')).toBe(true); expect(tooltips.every(tooltip => tooltip.props.disabled === true)).toBe(true)
      if (reason === 'hidden') props.active = true; else shown.value = true
      await settle(); expect(button.hasAttribute('disabled')).toBe(false); expect(tooltips.every(tooltip => tooltip.props.disabled === false)).toBe(true)
      for (const tooltip of tooltips) {expect(tooltip.onClose).toHaveBeenCalledOnce(); expect(tooltip.hide).toHaveBeenCalledOnce()}
    }
    expect(send).not.toHaveBeenCalled(); expect(props.config.informationHighlight.mode).toBe('keywords')
  })
  it('关键词模式不挂载模型卡；改成本地模式后只读取状态，模型卡在模式与密度之间', async () => {
    await mount('keywords'); expect(document.querySelector('[data-testid="information-highlight-model-card"]')).toBeNull(); expect(send).not.toHaveBeenCalled()
    modeSelect()('surprisal-local'); await settle()
    const cards = element('[data-information-highlight-models]'), preferences = element('[data-testid="information-highlight-preferences"]')
    const mode = element('[data-information-highlight-mode-select]').closest('label')!, density = element('[data-information-highlight-density="low"]').closest('.highlight-field')!
    expect(cards.parentElement).toBe(preferences); expect(mode.nextElementSibling).toBe(cards); expect(cards.nextElementSibling).toBe(density)
    expect(cards.querySelectorAll('[data-testid="information-highlight-model-card"]')).toHaveLength(2)
    expect(send.mock.calls.map(([message]) => message)).toEqual([{type: 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', modelId: 'qwen2.5-0.5b'}, {type: 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', modelId: 'qwen3-0.6b'}]); expect(props.config.on).toBe(false)
    vi.advanceTimersByTime(15000); await settle(); expect(send).toHaveBeenCalledTimes(4); expectOnlyReads()
  })
  it('分析方式选择器切回关键词只替换偏好模式，保留其余设置并停止模型轮询', async () => {
    await mount(); const original = props.config.informationHighlight
    modeSelect()('keywords'); await settle()
    expect(props.config.informationHighlight).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, model: 'qwen2.5-0.5b', mode: 'keywords', density: 'high', color: 'blue', style: 'underline', intensity: 'standard'})
    expect(props.config.informationHighlight).not.toBe(original); expect(original.mode).toBe('surprisal-local'); expect(props.config.on).toBe(false)
    expect(document.querySelector('[data-testid="information-highlight-model-card"]')).toBeNull()
    vi.advanceTimersByTime(60000); await settle(); expect(messages()).toEqual(['GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS'])
  })
  it.each(['configuration', 'preferences'] as const)('%s 替换后旧关键词回调失效，当前回调仍可写入', async reason => {
    await mount(); const old = modeSelect(), oldConfig = props.config, oldPreferences = props.config.informationHighlight
    if (reason === 'configuration') {
      const replacement = new Config(); replacement.on = false; replacement.informationHighlight = {...oldPreferences, color: 'mint'}; props.config = replacement
      await settle()
    } else props.config.informationHighlight = {...oldPreferences, color: 'mint'}
    old('keywords'); expect(props.config.informationHighlight).toEqual({...oldPreferences, color: 'mint'}); expect(oldPreferences.mode).toBe('surprisal-local')
    expect(oldConfig.informationHighlight.mode).toBe('surprisal-local')
    await settle(); modeSelect()('keywords'); await settle(); expect(props.config.informationHighlight.mode).toBe('keywords'); expect(props.config.on).toBe(false); expectOnlyReads()
  })
  it.each(['hidden', 'cached', 'unmounted'] as const)('%s 后旧父回调和真实按钮不能写入；重新进入也不能复用旧回调', async reason => {
    await mount(); const old = modeSelect(), oldButton = modelChoice('qwen3-0.6b'), before = {...props.config.informationHighlight}
    if (reason === 'hidden') props.active = false
    else if (reason === 'cached') shown.value = false
    else {app!.unmount(); app = undefined}
    await settle(); old('keywords'); oldButton(); expect(props.config.informationHighlight).toEqual(before)
    vi.advanceTimersByTime(60000); await settle(); expect(messages()).toEqual(['GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS'])
    if (reason !== 'unmounted') {
      if (reason === 'hidden') props.active = true; else shown.value = true
      await settle(); old('keywords'); oldButton(); expect(props.config.informationHighlight).toEqual(before)
      modeSelect()('keywords'); await settle(); expect(props.config.informationHighlight.mode).toBe('keywords')
    }
    expectOnlyReads()
  })
  it('初始隐藏不读模型或允许回退，显现后只读资源；未声明 active 时遵循默认可操作', async () => {
    await mount('surprisal-local', false); const hidden = modeSelect(); hidden('keywords'); expect(send).not.toHaveBeenCalled(); expect(props.config.informationHighlight.mode).toBe('surprisal-local')
    props.active = undefined; await settle(); hidden('keywords'); expect(props.config.informationHighlight.mode).toBe('surprisal-local')
    expect(new Set(send.mock.calls.map(([message]) => message.modelId))).toEqual(new Set(['qwen2.5-0.5b', 'qwen3-0.6b'])); expectOnlyReads(); modeSelect()('keywords'); await settle()
    expect(props.config.informationHighlight.mode).toBe('keywords'); expect(props.config.on).toBe(false); expectOnlyReads()
  })
  it('模型读取已就绪不自动下载或启页，外观修改不重新挂载资源卡', async () => {
    send.mockImplementation(async message => ({success: true, status: modelFor(message.modelId, {phase: 'ready', downloaded: true, initialized: true})}))
    await mount(); const q2 = element(card('qwen2.5-0.5b')), q3 = element(card('qwen3-0.6b'))
    expect(document.querySelector('.highlight-model-ready')).toBeNull(); expect(document.querySelectorAll('[data-information-highlight-remove]')).toHaveLength(2); expect(document.querySelector('.highlight-model-status')).toBeNull(); expect(props.config.on).toBe(false)
    event('[data-information-highlight-color="mint"]')(); await settle()
    expect(element(card('qwen2.5-0.5b'))).toBe(q2); expect(element(card('qwen3-0.6b'))).toBe(q3); expectOnlyReads()
  })
  it('离开本地模式后迟到 ready 不挂回模型卡或启页，重新选择只发新的状态读取', async () => {
    const query = deferred<{success: boolean; status: InformationHighlightModelStatus}>(); send.mockReturnValueOnce(query.promise)
    await mount(); modeSelect()('keywords'); await settle()
    query.resolve({success: true, status: model({phase: 'ready', downloaded: true, initialized: true})}); await settle()
    expect(document.querySelector('[data-testid="information-highlight-model-card"]')).toBeNull(); expect(props.config.informationHighlight.mode).toBe('keywords'); expect(props.config.on).toBe(false)
    vi.advanceTimersByTime(60000); await settle(); expect(send).toHaveBeenCalledTimes(2)
    modeSelect()('surprisal-local'); await settle(); expect(messages()).toEqual(Array(4).fill('GET_INFORMATION_HIGHLIGHT_MODEL_STATUS'))
    expect(element('[data-testid="information-highlight-model-card"]')).toBeTruthy(); expect(props.config.on).toBe(false)
  })
})
