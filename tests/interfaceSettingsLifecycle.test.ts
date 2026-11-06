import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseHTML} from 'linkedom'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
vi.mock('@/src/platform/browser/translationSidepanel', () => ({canOpenTranslationSidepanel: () => false}))

// 实际 SFC setup/watch/KeepAlive；原生弹窗和缓存由隔离生产扩展另验。
import * as runtime from 'vue'
import InterfaceSettings from '@/src/features/settings/ui/InterfaceSettings.vue'
import PopupPreview from '@/src/features/settings/ui/components/PopupPreview.vue'
import {popupQuickFeatureIconPaths} from '@/src/ui/popupQuickFeatureIcons'
let document: Document, win: any, host: HTMLElement
let app: import('vue').App, state: Record<string, any>
let props: {config: Record<string, any>; active: boolean; activePanel?: string}, visible: import('vue').Ref<boolean>
let cache: import('vue').Ref<string[]>, status: import('vue').Ref<{font: string; status: string}>
let capabilities: {browser: string}
const feedback = vi.fn(), clear = vi.fn(), refresh = vi.fn(), retry = vi.fn()
vi.mock('element-plus', () => ({ElMessage: (...args: unknown[]) => feedback(...args)}))
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}))
vi.mock('@/src/platform/browser/capabilities', () => ({get browserCapabilities() {return capabilities}}))
vi.mock('@/src/ui/interfaceAppearance', () => ({
  get availableInterfaceFonts() {return cache},get cachedInterfaceFonts() {return cache},get interfaceFontLoadState() {return status},
  clearInterfaceFont: (...args: unknown[]) => clear(...args),refreshInterfaceFontAvailability: (...args: unknown[]) => refresh(...args),retryInterfaceFont: (...args: unknown[]) => retry(...args),
}))
vi.mock('@/src/features/settings/ui/components/SettingsPanel.vue', () => ({default: {props:['name','active'],setup:(props:any,{slots}:any)=>()=>!props.active||props.active===props.name?runtime.h('section',slots.default?.()):null}}))
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/InterfaceSkinPreview.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/PopupLayoutPreview.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/VideoSentenceLearningAppearanceSettings.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/TranslationLoadingStyleSettings.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/TranslationStyleSettings.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/SentenceHighlightStyleSettings.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/PopupLayoutPreviewItem.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
function deferred() {let resolve!: () => void;let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {resolve = yes;reject = no});return {promise, resolve, reject}}
async function settle() {await runtime.nextTick();await runtime.nextTick()}
function mountPoint() {const root = document.createElement('div');document.body.append(root);return root}
function createTestRenderer() {
  return runtime.createRenderer<any, any>({
    patchProp(el,key,_previous,value) {
      if (/^on[A-Z]/u.test(key)) {const event=key.slice(2).toLowerCase();el.__events??=new Map();const prior=el.__events.get(event);if(prior)el.removeEventListener(event,prior);if(value){const listener=(event:Event)=>{for(const handler of Array.isArray(value)?value:[value])handler(event)};el.__events.set(event,listener);el.addEventListener(event,listener)}}
      else if(key==='style')Object.assign(el.style,value||{})
      else if(key==='value')el.value=value??''
      else if(key==='checked')el.checked=!!value
      else if(value==null||value===false&&!key.startsWith('aria-'))el.removeAttribute(key)
      else el.setAttribute(key,String(value))
    }, insert:(node,parent,anchor)=>parent.insertBefore(node,anchor||null),remove:node=>node.remove(),
    createElement:(tag,ns)=>ns==='svg'?document.createElementNS('http://www.w3.org/2000/svg',tag):document.createElement(tag),
    createText:text=>document.createTextNode(text),createComment:text=>document.createComment(text),setText:(node,text)=>{node.nodeValue=text},setElementText:(node,text)=>{node.textContent=text},
    parentNode:node=>node.parentNode,nextSibling:node=>node.nextSibling,setScopeId:(node,id)=>node.setAttribute(id,''),
    insertStaticContent(html,parent,anchor){const box=document.createElement('div');box.innerHTML=html;const first=box.firstChild!,last=box.lastChild!;while(box.firstChild)parent.insertBefore(box.firstChild,anchor||null);return[first,last]},
  })
}
function configure(app: import('vue').App) {
  app.component('el-dialog',{props:['modelValue'],emits:['update:modelValue'],setup:(props:any,{slots,emit}:any)=>()=>props.modelValue?runtime.h('section',{role:'dialog'},[runtime.h('button',{'data-dialog-dismiss':'',onClick:()=>emit('update:modelValue',false)},'Close'),slots.default?.(),slots.footer?.()]):null})
  app.component('el-button',{setup:(_:unknown,{attrs,slots}:any)=>()=>runtime.h('button',attrs,slots.default?.())})
  app.config.warnHandler=()=>{}
}
function begin(font = 'inter') {state.confirmClearFont(font)}
async function accept() {await state.performClearFont();await settle()}
async function cancel() {state.closeFontClearDialog();await settle()}
function open() {return state.fontClearDialogOpen}
function mutate(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'config') props.config = {...props.config}
  if (reason === 'font') props.config.interfaceFont = 'roboto'
  if (reason === 'panel') props.activePanel = 'layout'
  if (reason === 'cached') visible.value = false
  if (reason === 'unmount') app.unmount()
}
beforeEach(async () => {
  vi.clearAllMocks()
  cache = runtime.ref(['system', 'inter', 'noto-sans-sc', 'noto-serif-sc']);status = runtime.ref({font: 'system', status: 'system'})
  clear.mockResolvedValue(undefined);refresh.mockResolvedValue(undefined);retry.mockReturnValue(undefined)
  capabilities = runtime.reactive({browser: 'chrome'})
  const parsed = parseHTML('<html><body></body></html>');document=parsed.document;win=parsed.window
  for (const [name,value] of Object.entries({document,window:win,Node:win.Node,Element:win.Element,HTMLElement:win.HTMLElement,Event:win.Event})) vi.stubGlobal(name,value)
  const component = InterfaceSettings as runtime.Component
  const renderer = createTestRenderer()
  props = runtime.reactive({active: true, config: {interfaceFont: 'inter', interfaceSkin: 'default',
    interfaceVisibility: {popupQuickFeatures: true, popupSiteRule: true, popupFooter: true},
    popupModuleOrder: ['translation', 'siteRule', 'quickFeatures', 'footer'],
    popupQuickFeatureOrder: ['hover', 'selection', 'appearance', 'image', 'document', 'highlight'],
    popupQuickFeatureVisibility: {hover: true, selection: true, appearance: false, image: true, document: true, highlight: true},
    informationHighlight: {mode: 'surprisal-local', density: 'high', color: 'mint', style: 'underline'}}})
  visible = runtime.ref(true);app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
    ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState}}) : runtime.h({render: () => null}, {key: 'other'})})})
  configure(app);host=mountPoint();app.mount(host);await settle()
})
afterEach(async () => {app?.unmount();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs()})

describe('实际界面字体设置与所属确认', () => {
  it('取消和重复打开不清除缓存、不改字体，重复请求只保留一次确认', async () => {
    begin();const operation = state.pendingClear;begin();expect(open()).toBe(true);expect(state.pendingClear).toBe(operation);expect(clear).not.toHaveBeenCalled()
    await cancel();expect(clear).not.toHaveBeenCalled();expect(props.config.interfaceFont).toBe('inter')
  })
  it('确认清除当前字体只执行一次，成功回到系统字体并反馈', async () => {
    begin();await accept();await accept();expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith('inter');expect(props.config.interfaceFont).toBe('system')
    expect(feedback).toHaveBeenCalledTimes(1);expect(state.clearingFont).toBe(null);expect(open()).toBe(false)
  })
  it('清除另一个已下载字体保留当前方案，失败反馈后可以重试', async () => {
    clear.mockRejectedValueOnce(new Error('cache denied'));begin('noto-serif-sc');await accept()
    expect(props.config.interfaceFont).toBe('inter');expect(feedback.mock.calls[0][0].type).toBe('error')
    begin('noto-serif-sc');await accept();expect(feedback.mock.calls.at(-1)?.[0].type).toBe('success')
    expect(props.config.interfaceFont).toBe('inter')
  })
  it('确认期间缓存或下载状态改变时重验清除资格', async () => {
    begin();status.value = {font: 'inter', status: 'loading'};await accept()
    expect(clear).not.toHaveBeenCalled();expect(props.config.interfaceFont).toBe('inter')
  })
  it('新确认框的旧按钮句柄不能确认或取消后来打开的另一个字体', async () => {
    // 这是新增所属确认框的回归约束，旧源码的服务 Promise 没有这些按钮句柄。
    begin();const old = state.fontClearActions;await cancel();begin('noto-serif-sc')
    old.cancel();await old.confirm();expect(open()).toBe(true);expect(clear).not.toHaveBeenCalled()
    await state.fontClearActions.confirm();expect(clear).toHaveBeenCalledWith('noto-serif-sc')
    expect(props.config.interfaceFont).toBe('inter')
  })
  it.each(['hidden', 'config', 'font', 'panel', 'cached', 'unmount'])('%s 后关闭确认，迟到确认无效；可见的新配置允许新确认', async reason => {
    begin();mutate(reason);await settle()
    // 旧版本的服务确认仍由自身 promise 收到迟到同意；新版本的所属确认已关闭。
    await accept();expect(clear).not.toHaveBeenCalled();expect(open()).toBe(false)
    expect(props.config.interfaceFont).toBe(reason === 'font' ? 'roboto' : 'inter')
    begin();expect(open()).toBe(reason === 'config' || reason === 'font')
    if (open()) await cancel()
  })
  it.each(['hidden', 'config', 'font', 'cached', 'unmount'])('已确认清除的成功在 %s 后不再写配置或显示反馈', async reason => {
    const pending = deferred();clear.mockReturnValueOnce(pending.promise);begin();const job = accept()
    await settle();expect(clear).toHaveBeenCalledOnce();mutate(reason);await settle();pending.resolve();await job
    expect(feedback).not.toHaveBeenCalled();expect(props.config.interfaceFont).toBe(reason === 'font' ? 'roboto' : 'inter')
    expect(state.clearingFont).toBe(null)
  })
  it.each(['hidden', 'config', 'font', 'cached', 'unmount'])('已确认清除的失败在 %s 后不再显示旧反馈', async reason => {
    const pending = deferred();clear.mockReturnValueOnce(pending.promise);begin();const job = accept()
    await settle();mutate(reason);await settle();pending.reject(new Error('late failure'));await job
    expect(feedback).not.toHaveBeenCalled();expect(state.clearingFont).toBe(null)
  })
  it('隐藏期间不选择、重试或排队清除，激活后允许新的操作', async () => {
    props.active = false;await settle();state.selectInterfaceFont('roboto');status.value = {font: 'inter', status: 'error'}
    state.selectInterfaceFont('inter');begin();expect(retry).not.toHaveBeenCalled();expect(open()).toBe(false)
    expect(props.config.interfaceFont).toBe('inter');props.active = true;await settle();state.selectInterfaceFont('inter')
    expect(retry).toHaveBeenCalledOnce();state.selectInterfaceFont('roboto');expect(props.config.interfaceFont).toBe('roboto')
    expect(refresh).toHaveBeenCalledTimes(2)
  })
  it('字体清除容量保留共享中文，系统与无独占资源的方案不提供清除', () => {
    expect(state.canClearFont('system')).toBe(false);expect(state.canClearFont('noto-sans-sc')).toBe(false)
    expect(state.canClearFont('inter')).toBe(true);expect(state.clearFontSize('system')).toBe('0 B')
    expect(state.clearFontSize('inter')).toMatch(/(KB|MB)$/)
  })
  it('布局修改只在所属界面生效；合法顺序和显隐仍按注册表归一化', async () => {
    props.active = false;await settle();const previous = JSON.stringify(props.config)
    state.setPopupModuleOrder(['footer']);state.setPopupModuleVisibility('quickFeatures', false)
    state.setPopupQuickFeatureOrder(['image']);state.setPopupQuickFeatureVisibility('image', false)
    expect(JSON.stringify(props.config)).toBe(previous)
    props.active = true;props.activePanel = 'layout';await settle();state.setPopupModuleOrder(['footer', 'footer', 'unknown'])
    state.setPopupModuleVisibility('quickFeatures', false);state.setPopupQuickFeatureOrder(['image', 'image', 'unknown'])
    state.setPopupQuickFeatureVisibility('image', false)
    expect(props.config.popupModuleOrder[0]).toBe('footer');expect(props.config.popupModuleOrder).toHaveLength(4)
    expect(props.config.interfaceVisibility.popupQuickFeatures).toBe(false);expect(props.config.popupQuickFeatureOrder).toHaveLength(5)
    expect(props.config.popupQuickFeatureVisibility.image).toBe(false)
  })
  it('布局键盘导航在隐藏时不抢焦点，激活后支持方向键和 Home/End', async () => {
    const focus = [vi.fn(), vi.fn()], preventDefault = vi.fn()
    const key = (value: string) => ({key: value, preventDefault,
      currentTarget: {querySelectorAll: () => focus.map(fn => ({focus: fn}))}} as unknown as KeyboardEvent)
    props.active = false;await settle();state.handleLayoutTabKeydown(key('End'))
    expect(preventDefault).not.toHaveBeenCalled();expect(focus[1]).not.toHaveBeenCalled()
    props.active = true;props.activePanel = 'layout';await settle()
    for (const value of ['End', 'Home', 'ArrowRight', 'ArrowLeft']) state.handleLayoutTabKeydown(key(value))
    expect(preventDefault).toHaveBeenCalledTimes(4);expect(focus[0]).toHaveBeenCalledTimes(2);expect(focus[1]).toHaveBeenCalledTimes(2)
    state.handleLayoutTabKeydown(key('Escape'));expect(preventDefault).toHaveBeenCalledTimes(4)
    expect(state.activeLayoutPanel).toBe('popupModule')
  })
  it('皮肤单选组支持四方向循环和 Home/End，并聚焦到新选中项', async () => {
    const options: {value: string}[] = state.groupedSkinOptions.flatMap((group: {options: {value: string}[]}) => group.options)
    const focus = options.map(() => vi.fn()), preventDefault = vi.fn()
    const key = (value: string) => ({key: value, preventDefault,
      currentTarget: {querySelectorAll: () => focus.map((fn, index) => ({dataset: {skin: options[index].value}, focus: fn}))}} as unknown as KeyboardEvent)
    expect(state.handleSkinKeydown).toBeTypeOf('function')
    state.handleSkinKeydown(key('ArrowRight'))
    expect(props.config.interfaceSkin).toBe(options[1].value);expect(focus[1]).toHaveBeenCalledOnce()
    state.handleSkinKeydown(key('ArrowDown'));expect(props.config.interfaceSkin).toBe(options[2].value)
    state.handleSkinKeydown(key('ArrowUp'));expect(props.config.interfaceSkin).toBe(options[1].value)
    state.handleSkinKeydown(key('Home'));expect(props.config.interfaceSkin).toBe(options[0].value)
    state.handleSkinKeydown(key('ArrowLeft'));expect(props.config.interfaceSkin).toBe(options.at(-1)!.value)
    state.handleSkinKeydown(key('ArrowRight'));expect(props.config.interfaceSkin).toBe(options[0].value)
    state.handleSkinKeydown(key('End'));expect(props.config.interfaceSkin).toBe(options.at(-1)!.value)
    state.handleSkinKeydown(key('Escape'));expect(preventDefault).toHaveBeenCalledTimes(7)
  })
  it('皮肤控件失活或离开所属分类时不改配置、不抢焦点，恢复后仍可选择', async () => {
    const focus = vi.fn(), preventDefault = vi.fn()
    const key = {key: 'End', preventDefault, currentTarget: {querySelectorAll: () => [{dataset: {skin: 'compact'}, focus}]}} as unknown as KeyboardEvent
    expect(state.selectInterfaceSkin).toBeTypeOf('function')
    props.active = false;await settle();state.selectInterfaceSkin('compact');state.handleSkinKeydown(key)
    expect(props.config.interfaceSkin).toBe('default');expect(focus).not.toHaveBeenCalled();expect(preventDefault).not.toHaveBeenCalled()
    props.active = true;props.activePanel = 'layout';await settle();state.selectInterfaceSkin('compact');state.handleSkinKeydown(key)
    expect(props.config.interfaceSkin).toBe('default')
    props.activePanel = 'skin';await settle();state.selectInterfaceSkin('compact');expect(props.config.interfaceSkin).toBe('compact')
    state.selectInterfaceSkin('unknown');expect(props.config.interfaceSkin).toBe('compact')
    visible.value = false;await settle();state.handleSkinKeydown(key);expect(focus).not.toHaveBeenCalled()
  })
  it('扩展和 userscript 的 Popup 布局均隐藏历史高亮入口，不写回非法 id 或改动阅读偏好', async () => {
    expect(state.popupQuickFeatureEditorItems.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
    const saved = JSON.stringify(props.config)
    state.setPopupQuickFeatureVisibility('highlight', false); expect(JSON.stringify(props.config)).toBe(saved)
    capabilities.browser = 'userscript'; await settle()
    expect(state.popupQuickFeatureEditorItems.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
    state.setPopupQuickFeatureVisibility('highlight', false)
    expect(JSON.stringify(props.config)).toBe(saved)
    capabilities.browser = 'chrome'; await settle()
    expect(state.popupQuickFeatureEditorItems.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
  })
  it('所有皮肤样例与传入布局都不预览已移除的高亮或未知入口，保留传入对象', async () => {
    const component = PopupPreview as runtime.Component
    let preview: Record<string, any> = {}
    const inputs = runtime.reactive({skin: {value: 'default'}, quickFeatures: undefined as undefined | {id: string; label: string}[]})
    const previewApp = createTestRenderer().createApp({setup: () => () => runtime.h(component, {...inputs, ref: (vm: any) => {if (vm) preview = vm.$.setupState}})})
    previewApp.provide(runtime.ssrContextKey, {modules: new Set<string>()}); previewApp.config.warnHandler = () => {}
    try {
      previewApp.mount(mountPoint()); await settle()
      expect(preview.orderedQuickFeatures.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
      capabilities.browser = 'userscript'; await settle()
      expect(preview.orderedQuickFeatures.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
      inputs.quickFeatures = [{id: 'highlight', label: 'Saved extension preference'}, {id: 'selection', label: 'Selection'}, {id: 'future', label: 'Unknown'}]; await settle()
      expect(preview.orderedQuickFeatures.map((item: {id: string}) => item.id)).toEqual(['selection'])
      capabilities.browser = 'chrome'; await settle()
      expect(preview.orderedQuickFeatures.map((item: {id: string}) => item.id)).toEqual(['selection'])
      expect(inputs.quickFeatures.map(item => item.id)).toEqual(['highlight', 'selection', 'future'])
    } finally {previewApp.unmount()}
  })
  it('userscript 构建条件独立阻止高亮配置与预览，并移除专属图标数据', async () => {
    app.unmount();vi.stubEnv('BROWSER','userscript')
    const saved = JSON.stringify(props.config)
    const component = InterfaceSettings as runtime.Component
    app = createTestRenderer().createApp({setup: () => () => runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState}})})
    configure(app);host=mountPoint();app.mount(host);await settle()
    expect(capabilities.browser).toBe('chrome')
    expect(state.popupQuickFeatureEditorItems.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
    state.setPopupQuickFeatureVisibility('highlight', false); expect(JSON.stringify(props.config)).toBe(saved)
    const previewComponent = PopupPreview as runtime.Component
    let preview: Record<string, any> = {}
    const previewApp = createTestRenderer().createApp({setup: () => () => runtime.h(previewComponent,
      {skin: {value: 'default'}, ref: (vm: any) => {if (vm) preview = vm.$.setupState}})})
    previewApp.provide(runtime.ssrContextKey, {modules: new Set<string>()}); previewApp.config.warnHandler = () => {}
    try {
      previewApp.mount(mountPoint()); await settle()
      expect(preview.orderedQuickFeatures.some((item: {id: string}) => item.id === 'highlight')).toBe(false)
      expect(popupQuickFeatureIconPaths).not.toHaveProperty('highlight')
    } finally {previewApp.unmount()}
  })
  it.each(['missing', 'empty', 'embedded'] as const)('实际 Popup 预览图标 %s 时复用官方脚本资源或扩展回退', async kind => {
    const original = Object.getOwnPropertyDescriptor(globalThis, '__FLUENTREAD_ICON_DATA__')
    const officialIcon = `data:image/png;base64,${readFileSync(resolve(process.cwd(), 'public/icon/64.png')).toString('base64')}`
    try {
      if (kind === 'missing') delete globalThis.__FLUENTREAD_ICON_DATA__
      else Object.defineProperty(globalThis, '__FLUENTREAD_ICON_DATA__', {configurable: true, writable: true, value: kind === 'empty' ? '' : officialIcon})
      const component = PopupPreview as runtime.Component
      const previewApp = createTestRenderer().createApp({render: () => runtime.h(component, {skin: {value: 'default'}})})
      previewApp.config.warnHandler = () => {}
      const root = mountPoint();previewApp.mount(root);await settle()
      const logos = root.querySelectorAll('img.preview-logo')
      expect(logos).toHaveLength(1)
      expect(logos[0].getAttribute('src')).toBe(kind === 'embedded' ? officialIcon : '/icon/128.png')
      expect(logos[0].getAttribute('width')).toBe('32')
      expect(logos[0].getAttribute('height')).toBe('32')
      previewApp.unmount()
    } finally {
      if (original) Object.defineProperty(globalThis, '__FLUENTREAD_ICON_DATA__', original)
      else delete globalThis.__FLUENTREAD_ICON_DATA__
    }
  })
})

async function dispatchUi(node: Element, type: string, values: Record<string, unknown> = {}) {
  const event = new win.Event(type, {bubbles: true, cancelable: true});Object.assign(event, values);
  node.dispatchEvent(event);await settle();return event;
}
it('selects a skin and font, retries a failed download, and confirms or cancels cache removal through rendered controls', async () => {
  props.activePanel = 'skin';await settle();
  const skin = host.querySelector('[data-skin="compact"]')!;await dispatchUi(skin, 'click');expect(props.config.interfaceSkin).toBe('compact');expect(skin.getAttribute('aria-checked')).toBe('true');
  await dispatchUi(skin, 'keydown', {key: 'Home'});expect(props.config.interfaceSkin).toBe('default');
  props.activePanel = 'font';await settle();
  await dispatchUi(host.querySelector('[data-font="roboto"] input')!, 'change');expect(props.config.interfaceFont).toBe('roboto');
  status.value = {font: 'roboto', status: 'error'};await settle();await dispatchUi(host.querySelector('[data-font="roboto"] .is-error button')!, 'click');expect(retry).toHaveBeenCalledOnce();
  status.value = {font: 'system', status: 'system'};await settle();
  await dispatchUi(host.querySelector('[data-font="inter"] .interface-font-clear')!, 'click');expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await dispatchUi([...host.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='settings.interface.font.clearConfirmCancel')!, 'click');expect(host.querySelector('[role="dialog"]')).toBeNull();expect(clear).not.toHaveBeenCalled();
  await dispatchUi(host.querySelector('[data-font="inter"] .interface-font-clear')!, 'click');await dispatchUi(host.querySelector('[role="dialog"] button[type="primary"]')!, 'click');
  expect(clear).toHaveBeenCalledWith('inter');expect(props.config.interfaceFont).toBe('roboto');expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it('reorders and hides actual layout cards, then restores their order and keyboard focus without mutating hidden feature slots', async () => {
  props.activePanel = 'layout';await settle();
  Object.defineProperty(document, 'hasFocus', {configurable: true, value: () => true});
  const focus = vi.spyOn(win.HTMLElement.prototype, 'focus').mockImplementation(() => {});
  const moduleCard = (id: string) => host.querySelector(`[data-popup-layout-module="${id}"]`)!;
  await dispatchUi(moduleCard('translation').querySelector('.popup-layout-handle')!, 'keydown', {key: 'ArrowDown'});
  expect(props.config.popupModuleOrder.slice(0, 2)).toEqual(['siteRule', 'translation']);
  await dispatchUi(moduleCard('siteRule').querySelector('.popup-layout-hide')!, 'click', {detail: 0});
  expect(props.config.interfaceVisibility.popupSiteRule).toBe(false);expect(moduleCard('siteRule')).toBeNull();expect(focus).toHaveBeenCalledWith({preventScroll: true});
  const modules = host.querySelector('.popup-layout-editor--popupModule')!;
  await dispatchUi(modules.querySelector('.popup-layout-add')!, 'click', {detail: 0});expect(props.config.interfaceVisibility.popupSiteRule).toBe(true);
  await dispatchUi(modules.querySelector('.popup-layout-toolbar button')!, 'click');expect(props.config.popupModuleOrder).toEqual(['translation', 'siteRule', 'quickFeatures', 'footer']);
  await dispatchUi(host.querySelector('#popup-layout-features-tab')!, 'click');expect(host.querySelector('#popup-layout-features-tab')?.getAttribute('aria-selected')).toBe('true');
  const feature = host.querySelector('[data-popup-quick-feature-layout="hover"] .popup-layout-handle')!;
  await dispatchUi(feature, 'keydown', {key: 'ArrowRight'});expect(props.config.popupQuickFeatureOrder.slice(0, 3)).toEqual(['selection', 'hover', 'appearance']);
  await dispatchUi(feature, 'keydown', {key: 'ArrowLeft'});expect(props.config.popupQuickFeatureOrder[0]).toBe('hover');
  await dispatchUi(moduleCard('quickFeatures').querySelector('.popup-layout-hide')!, 'click', {detail: 1});expect(host.querySelector('.popup-layout-section-hidden')).not.toBeNull();
  await dispatchUi(host.querySelector('.popup-layout-section-hidden button')!, 'click');expect(props.config.interfaceVisibility.popupQuickFeatures).toBe(true);
  expect(modules.querySelector('.popup-layout-announcement')?.textContent).toContain('settings.interface.popupLayout');
});
it('drags actual module and feature cards using their geometry and rejects dragging a card action', async () => {
  props.activePanel = 'layout';await settle();
  win.getComputedStyle = () => ({gridTemplateColumns: '100px 100px'});
  const transfer = {setData: vi.fn(), effectAllowed: '', dropEffect: ''};
  const geometry = {left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40};
  const modules = host.querySelector('.popup-layout-editor--popupModule')!;
  const first = modules.querySelector('[data-popup-layout-module="translation"]')!, last = modules.querySelector('[data-popup-layout-module="footer"]')!;
  Object.defineProperty(last, 'getBoundingClientRect', {value: () => geometry});
  await dispatchUi(first, 'dragstart', {dataTransfer: transfer});expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'translation');
  await dispatchUi(last, 'dragover', {dataTransfer: transfer, clientY: 30});expect(last.classList.contains('drop-after')).toBe(true);
  await dispatchUi(last, 'dragleave', {relatedTarget: last.firstChild});expect(last.classList.contains('drop-after')).toBe(true);
  await dispatchUi(last, 'dragleave', {relatedTarget: null});expect(last.classList.contains('drop-after')).toBe(false);
  await dispatchUi(last, 'drop', {dataTransfer: transfer, clientY: 30});expect(props.config.popupModuleOrder.at(-1)).toBe('translation');expect(modules.querySelector('.dragging')).toBeNull();
  await dispatchUi(last.querySelector('.popup-layout-hide')!, 'dragstart', {dataTransfer: transfer});expect(modules.querySelector('.dragging')).toBeNull();
  await dispatchUi(host.querySelector('#popup-layout-features-tab')!, 'click');
  const features = host.querySelector('.popup-layout-editor--quickFeature')!, source = features.querySelector('[data-popup-quick-feature-layout="hover"]')!, target = features.querySelector('[data-popup-quick-feature-layout="image"]')!;
  Object.defineProperty(target, 'getBoundingClientRect', {value: () => geometry});
  await dispatchUi(source, 'dragstart', {dataTransfer: transfer});await dispatchUi(target, 'dragover', {dataTransfer: transfer, clientX: 80});await dispatchUi(target, 'drop', {dataTransfer: transfer, clientX: 80});
  expect(props.config.popupQuickFeatureOrder).toEqual(['selection', 'image', 'appearance', 'hover', 'document']);
  await dispatchUi(source, 'dragstart', {dataTransfer: transfer});await dispatchUi(features, 'keydown', {key: 'Escape'});expect(features.querySelector('.dragging')).toBeNull();
  await dispatchUi(source, 'dragend');expect(features.querySelector('.dragging')).toBeNull();
});

it('moves layout cards through visible arrow controls and returns to the module tab, then closes font confirmation through dialog chrome',async()=>{
  props.activePanel='layout';await settle();
  const card=()=>host.querySelector('[data-popup-layout-module="translation"]')!;
  const arrows=()=>card().querySelectorAll<HTMLButtonElement>('.popup-layout-move-buttons button');
  expect(arrows()[0].disabled).toBe(true);await dispatchUi(arrows()[1],'click');expect(props.config.popupModuleOrder.slice(0,2)).toEqual(['siteRule','translation']);
  await dispatchUi(arrows()[0],'click');expect(props.config.popupModuleOrder[0]).toBe('translation');
  await dispatchUi(host.querySelector('#popup-layout-features-tab')!,'click');await dispatchUi(host.querySelector('#popup-layout-modules-tab')!,'click');
  expect(host.querySelector('#popup-layout-modules-tab')?.getAttribute('aria-selected')).toBe('true');
  props.activePanel='font';await settle();await dispatchUi(host.querySelector('[data-font="inter"] .interface-font-clear')!,'click');
  await dispatchUi(host.querySelector('[data-dialog-dismiss]')!,'click');expect(host.querySelector('[role="dialog"]')).toBeNull();expect(clear).not.toHaveBeenCalled();
  await dispatchUi(host.querySelector('[data-font="inter"] .interface-font-clear')!,'click');await dispatchUi(host.querySelector('[role="dialog"] button[type="primary"]')!,'click');expect(clear).toHaveBeenCalledOnce();
});
