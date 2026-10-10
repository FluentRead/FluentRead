/**
 * @file tests/informationHighlightUiLifecycle.test.ts
 * 文件职责：执行信息高亮设置组件的真实 Vue 生命周期，验证偏好与模型操作归属。
 * 主要内容：覆盖模式仅保存配置、不可用状态、明确下载/暂停/删除、迟到状态、关闭视图与轮询合并。
 * 模块边界：模型消息使用受控端口，不下载实际资源；原生按钮和响应式布局由生产浏览器另行验证。
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import vue from '@vitejs/plugin-vue'
import {createServer, type ViteDevServer} from 'vite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {InformationHighlightModelStatus} from '@/src/features/information-highlight/protocol'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
const key = '__informationHighlightUiFixture'
let server: ViteDevServer, app: import('vue').App, state: Record<string, any>, props: Record<string, any>
const send = vi.fn(), confirm = vi.fn()
const ready = vi.fn(), preparing = vi.fn()
const model = (overrides: Partial<InformationHighlightModelStatus> = {}): InformationHighlightModelStatus => ({modelId: 'qwen2.5-0.5b', phase: 'absent', downloaded: false, initialized: false, downloadedBytes: 0, totalBytes: 490043908, supported: true, modelName: 'Qwen2.5 0.5B', downloadSizeBytes: 490043908, ...overrides})
function deferred<T = unknown>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
async function settle() {for (let i = 0; i < 8; i++) {await Promise.resolve(); await runtime.nextTick()}}
async function mount(name: 'InformationHighlightPreferences' | 'InformationHighlightModelCard') {
  const path = `/src/features/settings/ui/${name}.vue`
  const component = (await server.ssrLoadModule(path)).default
  component.ssrRender = undefined; component.render = () => null
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {}, remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]})
  props = runtime.reactive({active: true, modelId: 'qwen2.5-0.5b', config: {on: true, informationHighlight: {enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, model: 'qwen2.5-0.5b', mode: 'keywords', density: 'medium', color: 'amber', style: 'background', intensity: 'standard'}}, onReady: ready, onPreparing: preparing})
  app = renderer.createApp({setup: () => () => runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState}})})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()}); app.config.warnHandler = () => {}; app.mount({}); await settle()
}
beforeEach(async () => {
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']}); ready.mockReset(); preparing.mockReset(); send.mockReset(); confirm.mockReset(); confirm.mockResolvedValue(undefined); send.mockResolvedValue({success: true, status: model()})
  Object.assign(globalThis, {[key]: {send, confirm}})
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(), resolve: {alias: {'@': resolve(process.cwd(), '.')}}, ssr: {noExternal: ['webextension-polyfill', 'element-plus']}, server: {hmr: false, middlewareMode: true}, plugins: [{name: 'information-highlight-ui-mocks', enforce: 'pre', resolveId(id) {
    if (id === 'webextension-polyfill') return '\0information-browser'
    if (id === 'element-plus') return '\0information-elements'
    if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0information-i18n'
    if (id.endsWith('.vue') && !/InformationHighlight(?:Preferences|ModelCard)\.vue$/u.test(id)) return '\0information-child'
    return null
  }, load(id) {
    if (id === '\0information-elements') return `export const ElOption = {}, ElSwitch = {}; export const ElMessageBox = {confirm: globalThis.${key}.confirm};`
    if (id === '\0information-browser') return `export default {runtime: {sendMessage: globalThis.${key}.send}}`
    if (id === '\0information-i18n') return 'export const useUiI18n = () => ({t: key => key});'
    if (id === '\0information-child') return 'export default {}'
    return null
  }}, vue()]})
})
afterEach(async () => {app?.unmount(); await server?.close(); delete (globalThis as any)[key]; vi.useRealTimers(); vi.unstubAllGlobals()})

describe('信息高亮真实偏好组件', () => {
  it('设置偏好不依赖全局 Element Plus 注册：模式选择器与选项编译到明确的本地组件', () => {
    const filename = resolve(process.cwd(), 'src/features/settings/ui/InformationHighlightPreferences.vue')
    const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
    const script = compileScript(descriptor, {id: 'information-highlight-preferences'})
    const template = compileTemplate({source: descriptor.template!.content, filename, id: 'information-highlight-preferences', compilerOptions: {bindingMetadata: script.bindings}})
    expect(template.errors).toEqual([])
    expect(script.bindings?.UiSelect).toBeTruthy(); expect(script.bindings?.ElOption).toBeTruthy()
    expect(template.code).toContain('$setup["UiSelect"]'); expect(template.code).toContain('$setup["ElOption"]')
    expect(template.code).not.toMatch(/resolveComponent\("el-(?:select|option)"\)/u)
  })
  it('切换本地模式只改偏好，不读模型、不下载；各外观选项独立保存', async () => {
    await mount('InformationHighlightPreferences'); const original = props.config.informationHighlight
    state.actions.mode('surprisal-local'); await settle()
    expect(props.config.informationHighlight).toMatchObject({mode: 'surprisal-local', density: 'medium'}); expect(props.config.informationHighlight).not.toBe(original); expect(send).not.toHaveBeenCalled()
    state.actions.model('qwen3-0.6b'); await settle(); expect(props.config.informationHighlight.model).toBe('qwen3-0.6b');
    state.actions.model('unknown'); expect(props.config.informationHighlight.model).toBe('qwen3-0.6b');
    state.actions.model('qwen2.5-0.5b'); await settle();
    state.actions.mode('cloud'); expect(props.config.informationHighlight.mode).toBe('surprisal-local')
    expect(state.hotkeyDialog).toBe(false); state.actions.editHotkey(); expect(state.hotkeyDialog).toBe(true)
    props.config.floatingBallHotkey = 'Alt+T'; expect(state.hotkeyConflict('option+t')).toBe('informationHighlight.hotkey.conflict'); expect(state.hotkeyConflict('Alt+J')).toBe(''); expect(state.hotkeyConflict('')).toBe('')
    state.actions.hotkey('Alt+T'); expect(props.config.informationHighlight.hotkey).toBe('Alt+H'); expect(state.hotkeyDialog).toBe(true)
    state.actions.hotkey('alt+shift+j'); await settle(); expect(props.config.informationHighlight.hotkey).toBe('Alt+Shift+J'); expect(state.hotkeyDialog).toBe(false)
    state.actions.editHotkey(); state.actions.hotkey(undefined); await settle(); expect(props.config.informationHighlight.hotkey).toBe(''); expect(state.hotkeyDialog).toBe(false)
    state.actions.hotkey('Alt+H'); await settle(); state.actions.editHotkey(); state.closeHotkey(); expect(state.hotkeyDialog).toBe(false)
    state.actions.editHotkey(); state.actions.hotkeyEnabled(false); await settle(); expect(props.config.informationHighlight).toMatchObject({hotkeyEnabled: false, hotkey: 'Alt+H'}); expect(state.hotkeyDialog).toBe(false)
    state.actions.hotkeyEnabled(true); await settle(); expect(props.config.informationHighlight.hotkeyEnabled).toBe(true)
    state.actions.enabled(true); await settle(); expect(props.config.informationHighlight.enabled).toBe(true)
    state.actions.enabled('yes'); await settle(); expect(props.config.informationHighlight.enabled).toBe(false)
    state.densityChoices.find((item: any) => item.value === 'high').choose(); await settle(); state.colorChoices.find((item: any) => item.value === 'mint').choose(); await settle(); state.styleChoices.find((item: any) => item.value === 'underline').choose()
    expect(props.config.informationHighlight).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, model: 'qwen2.5-0.5b', mode: 'surprisal-local', density: 'high', color: 'mint', style: 'underline', intensity: 'standard'})
  })
  it('偏好更换、视图关闭又重开和卸载时，缓存控件不能借用新配置', async () => {
    await mount('InformationHighlightPreferences'); const oldMode = state.actions.mode, oldDensity = state.densityChoices[0].choose
    props.config.informationHighlight = {...props.config.informationHighlight, color: 'blue'}
    oldMode('surprisal-local'); oldDensity(); expect(props.config.informationHighlight.mode).toBe('keywords'); expect(props.config.informationHighlight.density).toBe('medium')
    await settle(); const color = state.colorChoices.find((item: any) => item.value === 'mint').choose; props.active = false; await settle(); props.active = true; await settle(); color()
    expect(props.config.informationHighlight.color).toBe('blue'); const style = state.styleChoices.find((item: any) => item.value === 'underline').choose; app.unmount(); style(); expect(props.config.informationHighlight.style).toBe('background')
  })
})
describe('信息高亮真实本地模型组件', () => {
  it('稳定资源每15秒读取，下载时每秒读取；隐藏页面停止，重新显示立即刷新并卸载监听', async () => {
    let visibilityChanged!: () => void
    const document = {visibilityState: 'visible', addEventListener: vi.fn((_type, callback) => {visibilityChanged = callback}), removeEventListener: vi.fn()}
    vi.stubGlobal('document', document)
    await mount('InformationHighlightModelCard'); expect(send).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(14999); await settle(); expect(send).toHaveBeenCalledOnce()
    send.mockResolvedValueOnce({success: true, status: model({phase: 'downloading', downloadedBytes: 20})})
    vi.advanceTimersByTime(1); await settle(); expect(send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000); await settle(); expect(send).toHaveBeenCalledTimes(3)
    document.visibilityState = 'hidden'; visibilityChanged(); vi.advanceTimersByTime(60000); await settle(); expect(send).toHaveBeenCalledTimes(3)
    document.visibilityState = 'visible'; visibilityChanged(); await settle(); expect(send).toHaveBeenCalledTimes(4)
    app.unmount(); expect(document.removeEventListener).toHaveBeenCalledWith('visibilitychange', visibilityChanged)
    vi.advanceTimersByTime(60000); await settle(); expect(send).toHaveBeenCalledTimes(4)
  })
  it('合法模型错误显示明确恢复原因和已有进度，完整文件重试不呈现下载中', async () => {
    send.mockResolvedValueOnce({success: true, status: model({phase: 'error', downloadedBytes: 20, errorCode: 'INFORMATION_HIGHLIGHT_MODEL_NETWORK'})})
    await mount('InformationHighlightModelCard')
    expect(state.error).toBe(false); expect(state.hasError).toBe(true); expect(state.showProgress).toBe(true)
    expect(state.errorLabel).toBe('informationHighlight.model.error.network')
    send.mockResolvedValueOnce({success: true, status: model({phase: 'error', downloaded: true, downloadedBytes: 490043908, errorCode: 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED'})})
    await state.actions.refresh(); expect(state.errorLabel).toBe('informationHighlight.model.error.runtime')
    const command = deferred(); send.mockReturnValueOnce(command.promise); const preparing = state.actions.prepare()
    expect(state.downloading).toBe(false); expect(state.displayPhase).toBe('error')
    command.resolve({success: true, status: model({phase: 'ready', downloaded: true})}); await preparing
  })
  it('删除操作显示正在删除，保留旧文件真值直到实际回复', async () => {
    send.mockResolvedValueOnce({success: true, status: model({phase: 'ready', downloaded: true})}); await mount('InformationHighlightModelCard')
    const command = deferred(); send.mockReturnValueOnce(command.promise); const removing = state.actions.remove()
    await settle(); expect(confirm).toHaveBeenCalledOnce(); expect(state.displayPhase).toBe('removing'); expect(state.status.downloaded).toBe(true)
    command.resolve({success: true, status: model()}); await removing
  })
  it('首次挂载只读状态，合并慢查询；周期读取显示真实字节进度', async () => {
    const query = deferred(); send.mockReturnValueOnce(query.promise); await mount('InformationHighlightModelCard')
    await state.actions.refresh(); vi.advanceTimersByTime(2000); await settle(); expect(send).toHaveBeenCalledOnce(); expect(state.reading).toBe(true)
    query.resolve({success: true, status: model({phase: 'downloading', downloadedBytes: 10})}); await settle()
    expect(state.downloading).toBe(true); expect(state.downloadProgress).toEqual({loaded: 10, total: 490043908})
    vi.advanceTimersByTime(1000); await settle(); expect(send.mock.calls.every(call => call[0].type === 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS')).toBe(true)
  })
  it('缺少 WebGPU 或隐藏视图时不能下载，迟到读取与关闭前按钮失效', async () => {
    send.mockResolvedValueOnce({success: true, status: model({supported: false})}); await mount('InformationHighlightModelCard')
    await state.actions.prepare(); expect(send).toHaveBeenCalledOnce()
    const oldPrepare = state.actions.prepare, query = deferred(); send.mockReturnValueOnce(query.promise); const pending = state.actions.refresh()
    props.active = false; await settle(); query.resolve({success: true, status: model({phase: 'ready', downloaded: true})}); await pending
    expect(state.status.supported).toBe(false); expect(state.reading).toBe(false); await oldPrepare(); vi.advanceTimersByTime(2000); await settle(); expect(send).toHaveBeenCalledTimes(2)
    props.active = true; await settle(); await oldPrepare(); expect(send).toHaveBeenCalledTimes(3)
  })
  it('明确下载会发命令且拒绝重复，暂停可抢占未完成下载，旧完成不恢复下载状态', async () => {
    await mount('InformationHighlightModelCard'); const prepare = deferred(), pause = deferred()
    send.mockReturnValueOnce(prepare.promise).mockReturnValueOnce(pause.promise)
    const starting = state.actions.prepare(); await settle(); await state.actions.prepare(); expect(state.downloading).toBe(true); expect(send).toHaveBeenCalledTimes(2)
    const pausing = state.actions.pause(); await settle(); expect(send).toHaveBeenLastCalledWith({type: 'PAUSE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen2.5-0.5b'})
    prepare.resolve({success: true, status: model({phase: 'ready', downloaded: true})}); await starting; expect(state.operation).toBe('pause'); expect(state.status.phase).toBe('absent')
    send.mockResolvedValueOnce({success: true, status: model({phase: 'paused', downloadedBytes: 20})}); pause.resolve({success: true, status: model({phase: 'paused', downloadedBytes: 20})}); await pausing; await settle()
    expect(state.downloading).toBe(false); expect(state.status.downloadedBytes).toBe(20)
    expect(ready).not.toHaveBeenCalled()
  })
  it('明确下载触发的一次 ready 事件在真实完成轮询后发生，单独读取已就绪状态不触发使用', async () => {
    await mount('InformationHighlightModelCard')
    send.mockResolvedValueOnce({success: true, status: model({phase: 'queued'})}).mockResolvedValueOnce({success: true, status: model({phase: 'downloading', downloadedBytes: 20})})
    await state.actions.prepare(); await settle(); expect(preparing).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled()
    send.mockResolvedValue({success: true, status: model({phase: 'ready', downloaded: true})})
    await state.actions.refresh(); expect(ready).toHaveBeenCalledOnce(); await state.actions.refresh(); expect(ready).toHaveBeenCalledOnce()
  })
  it('下载后的资源只能明确删除，旧读取不覆盖新命令，命令失败可重试', async () => {
    send.mockResolvedValueOnce({success: true, status: model({phase: 'ready', downloaded: true, initialized: true})}); await mount('InformationHighlightModelCard')
    const query = deferred(); send.mockReturnValueOnce(query.promise); const reading = state.actions.refresh()
    send.mockResolvedValueOnce({success: true, status: model()}); await state.actions.remove(); await settle()
    query.resolve({success: true, status: model({phase: 'ready', downloaded: true})}); await reading; expect(state.status.downloaded).toBe(false)
    send.mockResolvedValueOnce({success: true, status: model({phase: 'ready', downloaded: true})}); await state.actions.refresh();
    send.mockRejectedValueOnce(Error('remove')).mockResolvedValueOnce({success: false}); await state.actions.remove(); await settle(); expect(state.error).toBe(true); expect(state.operation).toBeNull()
    await state.actions.refresh(); expect(state.error).toBe(false)
    expect(send.mock.calls.filter(call => call[0].type === 'REMOVE_INFORMATION_HIGHLIGHT_MODEL')).toHaveLength(2)
  })
  it.each([{success: false}, null, {success: true, status: model({phase: 'unknown' as any})}, {success: true, status: model({downloadedBytes: -1})}, {success: true, status: {...model(), modelName: undefined}}])('无效资源回复 %j 显示错误且不下载', async response => {
    send.mockResolvedValueOnce(response); await mount('InformationHighlightModelCard'); expect(state.error).toBe(true); expect(state.status).toBeNull(); await state.actions.prepare(); expect(send).toHaveBeenCalledOnce()
  })
  it('删除需确认，取消保留模型；确认等待期间切换模型或关闭视图不会删除旧模型', async () => {
    send.mockResolvedValue({success: true, status: model({phase: 'ready', downloaded: true})}); await mount('InformationHighlightModelCard')
    confirm.mockRejectedValueOnce('cancel'); await state.actions.remove(); expect(send).toHaveBeenCalledOnce(); expect(state.status.downloaded).toBe(true)
    const dialog = deferred(); confirm.mockReturnValueOnce(dialog.promise); const removing = state.actions.remove(); await settle()
    expect(state.confirming).toBe(true); await state.actions.remove(); expect(confirm).toHaveBeenCalledTimes(2)
    props.active = false; await settle(); dialog.resolve(undefined); await removing
    expect(send).toHaveBeenCalledOnce(); expect(state.status.downloaded).toBe(true)
    props.active = true; await settle(); const oldRemove = state.actions.remove, nextDialog = deferred(); confirm.mockReturnValueOnce(nextDialog.promise)
    const nextRemoving = state.actions.remove(); await settle()
    send.mockResolvedValue({success: true, status: model({modelId: 'qwen3-0.6b', modelName: 'Qwen3 0.6B', downloadSizeBytes: 580000000})})
    props.modelId = 'qwen3-0.6b'; await settle(); await oldRemove(); nextDialog.resolve(undefined); await nextRemoving
    expect(send.mock.calls.filter(call => call[0].type === 'REMOVE_INFORMATION_HIGHLIGHT_MODEL')).toHaveLength(0)
    expect(state.status.modelId).toBe('qwen3-0.6b'); expect(state.confirming).toBe(false)
  })
  it('模型切换使旧查询与命令失效，所有消息带所选模型标识并拒绝不匹配的回复', async () => {
    const oldQuery = deferred(); send.mockReturnValueOnce(oldQuery.promise); await mount('InformationHighlightModelCard')
    send.mockResolvedValue({success: true, status: model({modelId: 'qwen3-0.6b', modelName: 'Qwen3 0.6B', downloadSizeBytes: 580000000})})
    props.modelId = 'qwen3-0.6b'; await settle()
    expect(send).toHaveBeenLastCalledWith({type: 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', modelId: 'qwen3-0.6b'})
    oldQuery.resolve({success: true, status: model({downloaded: true, phase: 'ready'})}); await settle(); expect(state.status.modelId).toBe('qwen3-0.6b'); expect(state.status.downloaded).toBe(false)
    const command = deferred(); send.mockReturnValueOnce(command.promise); const prepare = state.actions.prepare(); await settle()
    expect(send).toHaveBeenLastCalledWith({type: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL', modelId: 'qwen3-0.6b'})
    send.mockResolvedValue({success: true, status: model()}); props.modelId = 'qwen2.5-0.5b'; await settle()
    command.resolve({success: true, status: model({modelId: 'qwen3-0.6b', downloaded: true, phase: 'ready'})}); await prepare
    expect(state.status.modelId).toBe('qwen2.5-0.5b'); expect(ready).not.toHaveBeenCalled()
    send.mockResolvedValueOnce({success: true, status: model({modelId: 'qwen3-0.6b'})}); await state.actions.refresh(); expect(state.error).toBe(true); expect(state.status.modelId).toBe('qwen2.5-0.5b')
  })
  it('卸载后的查询异常和命令完成不再改变资源状态或启动轮询', async () => {
    await mount('InformationHighlightModelCard'); const query = deferred(); send.mockReturnValueOnce(query.promise); const pending = state.actions.refresh(); const old = state.actions.prepare
    app.unmount(); query.reject(Error('closed')); await pending; await old(); vi.advanceTimersByTime(3000); await settle(); expect(state.error).toBe(false); expect(send).toHaveBeenCalledTimes(2)
  })
})
