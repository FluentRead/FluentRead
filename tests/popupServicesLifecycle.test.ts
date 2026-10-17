/**
 * @file tests/popupServicesLifecycle.test.ts
 * 文件职责：验证实际 Popup 服务选择模板的事件归属、面板焦点、独立模型与凭据读取范围。
 * 主要内容：执行真实缓存客户端模板，覆盖隐藏、缓存、配置替换、选择会话切换、查询、目录权限、九种功能模型和默认继承；验证B站免费阅读选项、固定模型与写作拒绝边界；通过实际抽屉祖先与受控 DOM 几何验证进入/返回的局部滚动及同步、迟到、焦点保护。
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
let scrollPort: HTMLElement | undefined
const scrollWrites: number[] = []
const updates = vi.fn(), focus = vi.fn(), selectionRange = vi.fn()
const popupPath = 'src/app/popup/PopupServices.vue'
let capabilities: Record<string, unknown>
async function settle() {await runtime.nextTick();await Promise.resolve();await runtime.nextTick()}
beforeEach(async () => {
  vi.clearAllMocks();scrollPort=undefined;scrollWrites.length=0;capabilities = runtime.reactive({browser: 'chrome', areaTranslation: true, imageTranslation: true});(globalThis as any).__featureMenuCapabilities = capabilities;events = new Map();const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document;focused = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [key, value] of Object.entries({document, window: win, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLElement: win.HTMLElement, Event: win.Event, Node: win.Node})) vi.stubGlobal(key, value)
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent', resolve: {alias: {'@': process.cwd()}}, server: {hmr: false, middlewareMode: true},
    ssr: {noExternal: ['element-plus', '@element-plus/icons-vue']}, plugins: [{name: 'prompt-profile-controlled-ports', enforce: 'pre', resolveId(id) {
      if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0prompt-i18n'
      if (id === 'element-plus') return '\0prompt-element'
      if (/\/src\/platform\/browser\/capabilities(?:\.ts)?$/u.test(id)) return '\0feature-menu-capabilities'
      if (id === '@element-plus/icons-vue') return '\0prompt-icons'
      if (id.endsWith('.vue') && !/\/(?:PopupServices)\.vue$/u.test(id)) return '\0prompt-display'
      return null
    }, load(id) {
      if (id === '\0prompt-i18n') return "import {ref} from 'vue';export const useUiI18n = () => ({language: ref('zh-CN'), t: (key, params) => params?.model ? `${key} ${params.model}` : key, translateLegacy: text => text})"
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
  const component = await compile(path), source = runtime.shallowReactive({active: true, context: {}, contextKey: 'service-a', ...values});shown = runtime.ref(true)
  const renderer = runtime.createRenderer({patchProp(el: any, key: string, previous: any, next: any) {
    const handlers = events.get(el) || {};events.set(el, handlers)
    if (/^on[A-Z]/u.test(key)) {handlers[key] = next;const event = key.slice(2).toLowerCase();if (previous) el.removeEventListener(event, previous);if (next) el.addEventListener(event, next);return}
    if (key === 'value' || key === 'modelValue' || key === 'model-value') {el.value = next ?? '';el.setAttribute('data-model-value', String(next ?? ''));return}
    if (key === 'class') {el.className = next ?? '';return}
    if (next === false || next === undefined || next === null) el.removeAttribute(key);else el.setAttribute(key, String(next))
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
    createElement: tag => {const el = document.createElement(tag) as any;el.focus = (options: unknown) => {focus(options);focused = el};el.getBoundingClientRect=()=>geometry(el)
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
function eventOf(el: Element, name = 'onClick') {const fn = events.get(el)?.[name];expect(fn, name).toBeTypeOf('function');return fn}
function row(id: string) {return document.querySelector(`[data-feature-service="${id}"]`)!}
function option(id: string) {return document.querySelector(`[data-service-choice="${id}"]`)!}
function invalidate(reason: string) {if (reason === 'hidden') props.active = false;if (reason === 'cached') shown.value = false;if (reason === 'unmount') app.unmount();if (reason === 'config') props.config = runtime.reactive(new Config())}
function snapshot(config: Config) {return {service: config.service, hover: config.hoverTranslationService, selection: config.selectionTranslationService, input: config.inputBoxTranslationService, inputModel: config.inputBoxTranslationModel, reading: {...config.harness}, writing: {...config.writing}}}
// 待配置的服务收在折叠的更多区；夹具默认填好凭据，让 OpenAI 与 DeepSeek 留在常用区供事件归属用例直接点击。
async function mountPopup(config = runtime.reactive(new Config()), values: Record<string, unknown> = {}, credentials = true) {config.service = 'openai';if (credentials) for (const id of ['openai', 'deepseek']) config.token[id] ||= 'test-only-key';await mount(popupPath, {config, serviceOptions: services, ...values}, {onClose: updates})}
async function open(id: string) {const el = row(id) as HTMLElement;el.focus();eventOf(el)();await settle();expect(document.querySelector('[data-service-picker]')?.getAttribute('data-service-picker')).toBe(id)}
async function search(keyword: string) {const input = document.querySelector('input[type="search"]') as HTMLInputElement;input.value = keyword;eventOf(input, 'onInput')({target: input});await settle()}
function pickerBack() {return eventOf(document.querySelector('.service-picker-back')!)}
function rect(top: number, height: number) {return {top,bottom:top+height,left:0,right:280,width:280,height,x:0,y:top,toJSON:()=>({top,height})} as DOMRect}
function geometry(el: Element): DOMRect {
  if(el===scrollPort)return rect(100,206)
  if(el.matches('.popup-service-toolbar'))return rect(100,46)
  const id=el.getAttribute('data-feature-service')
  if(id){const index=[...document.querySelectorAll('[data-feature-service]')].indexOf(el);return rect(154+index*64-(scrollPort?.scrollTop||0),48)}
  return rect(170-(scrollPort?.scrollTop||0),46)
}
function attachOwnedScroller() {
  const drawer=document.createElement('div');drawer.className='popup-services-drawer'
  const body=document.createElement('div');body.className='el-drawer__body';drawer.append(body);document.body.append(drawer);body.append(document.getElementById('app')!)
  let top=0;Object.defineProperties(body,{clientTop:{value:0},clientHeight:{value:206},scrollTop:{get:()=>top,set:value=>{top=Math.max(0,value);scrollWrites.push(top)}}})
  body.getBoundingClientRect=()=>rect(100,206);scrollPort=body;document.body.scrollTop=79
  return body
}
function expectTargetVisible(el: Element) {const box=geometry(el);expect(box.top).toBeGreaterThanOrEqual(146);expect(box.bottom).toBeLessThanOrEqual(306);expect(document.body.scrollTop).toBe(79)}


describe('Popup 服务选择实际缓存模板', () => {
  it('实际选择视图同步清掉抽屉旧滚动，返回后默认行可见且不滚动宿主',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();scroller.scrollTop=840;const source=row('default') as HTMLElement;source.focus();eventOf(source)()
    expect(scroller.scrollTop).toBe(0);await settle();expectTargetVisible(document.querySelector('input')!);expect(focus).toHaveBeenLastCalledWith({preventScroll:true})
    scroller.scrollTop=1222;pickerBack()();expect(scroller.scrollTop).toBe(0);await settle()
    expectTargetVisible(row('default'));expect(focused).toBe(row('default'))
  })
  it('从底部功能返回时只在当前drawer内让源行避开sticky toolbar',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('writing');scroller.scrollTop=1222;pickerBack()();await settle()
    expect(scroller.scrollTop).toBeGreaterThan(0);expectTargetVisible(row('writing'));expect(focused).toBe(row('writing'))
  })
  it('用户在转场前已掌握外部焦点，同步和渲染后都不滚动或聚焦',async()=>{
    await mountPopup();const scroller=attachOwnedScroller(),outside=document.createElement('button');document.body.append(outside);focused=outside;scroller.scrollTop=340;scrollWrites.length=0;focus.mockClear()
    eventOf(row('writing'))();expect(scrollWrites).toEqual([]);await settle();expect(scroller.scrollTop).toBe(340);expect(scrollWrites).toEqual([]);expect(focus).not.toHaveBeenCalled()
    pickerBack()();expect(scrollWrites).toEqual([]);await settle();expect(scroller.scrollTop).toBe(340);expect(focused).toBe(outside)
  })
  it('用户在转场后主动移走焦点，nextTick不再调整滚动或抢焦点',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('writing');pickerBack()();scroller.scrollTop=77
    const outside=document.createElement('button');document.body.append(outside);focused=outside;scrollWrites.length=0;focus.mockClear();await settle()
    expect(scrollWrites).toEqual([]);expect(scroller.scrollTop).toBe(77);expect(focus).not.toHaveBeenCalled();expect(document.body.scrollTop).toBe(79)
  })
  it.each(['hidden','cached','unmount','config'])('同步转场后 %s，迟到渲染任务不再滚动旧容器',async reason=>{
    await mountPopup();const scroller=attachOwnedScroller();const source=row('writing') as HTMLElement;source.focus();eventOf(source)();expect(scroller.scrollTop).toBe(0)
    scroller.scrollTop=91;scrollWrites.length=0;invalidate(reason);await settle();expect(scrollWrites).toEqual([]);expect(scroller.scrollTop).toBe(91);expect(document.body.scrollTop).toBe(79)
  })
  it('返回后立即打开另一个会话，旧源行任务不能滚动新picker',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('writing');pickerBack()();state.openPicker(state.fields.find((field:any)=>field.id==='reading'))
    scrollWrites.length=0;await settle();expect(scroller.scrollTop).toBe(0);expect(scrollWrites).toEqual([]);expect(document.querySelector('[data-service-picker]')?.getAttribute('data-service-picker')).toBe('reading')
  })
  it('转场后当前面板被移到另一drawer，不对旧或新滚动容器误写',async()=>{
    await mountPopup();const old=attachOwnedScroller();await open('writing');pickerBack()();old.scrollTop=73;const other=document.createElement('div');other.className='el-drawer__body';old.parentElement!.append(other);other.append(document.getElementById('app')!)
    other.scrollTop=64;scrollWrites.length=0;await settle();expect(old.scrollTop).toBe(73);expect(other.scrollTop).toBe(64);expect(scrollWrites).toEqual([]);expect(document.body.scrollTop).toBe(79)
  })

  it.each([{label:'部分被标题遮住',top:40,expected:24},{label:'完整滚到标题上方',top:200,expected:24},{label:'已经完整可见',top:0,expected:0}])('视口恢复时搜索框$label，只调整当前抽屉并保留查询与焦点',async({top,expected})=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('default');await search('gpt')
    const input=document.querySelector('input[type="search"]') as HTMLInputElement,heading=document.querySelector('.service-picker-heading') as HTMLElement
    heading.getBoundingClientRect=()=>rect(100,46);scroller.scrollTop=top;scrollWrites.length=0;focus.mockClear()
    state.revealFocusedSearch(()=>true);await settle()
    expect(scroller.scrollTop).toBe(expected);expect(scrollWrites).toEqual(top===expected?[]:[expected])
    expect(document.querySelector('input[type="search"]')).toBe(input);expect(input.value).toBe('gpt');expect(focused).toBe(input)
    expectTargetVisible(input);expect(focus).not.toHaveBeenCalled()
  })
  it('视口恢复任务等待渲染时用户移走焦点，不滚动也不重新聚焦搜索框',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('default');await search('gpt')
    const heading=document.querySelector('.service-picker-heading') as HTMLElement;heading.getBoundingClientRect=()=>rect(100,46)
    scroller.scrollTop=200;scrollWrites.length=0;focus.mockClear();state.revealFocusedSearch(()=>true)
    const outside=document.createElement('button');document.body.append(outside);focused=outside;await settle()
    expect(scrollWrites).toEqual([]);expect(scroller.scrollTop).toBe(200);expect(focused).toBe(outside);expect(focus).not.toHaveBeenCalled();expect(document.body.scrollTop).toBe(79)
  })
  it('仍在短视口时不为搜索框重置用户查看服务列表的位置',async()=>{
    await mountPopup();const scroller=attachOwnedScroller();await open('default');await search('gpt')
    const modal=document.createElement('div');modal.className='popup-drawer-modal';modal.setAttribute('data-fluent-read-popup-short','');scroller.parentElement!.before(modal);modal.append(scroller.parentElement!)
    scroller.scrollTop=200;scrollWrites.length=0;focus.mockClear();state.revealFocusedSearch(()=>true);await settle()
    expect(scrollWrites).toEqual([]);expect(scroller.scrollTop).toBe(200);expect(focused).toBe(document.querySelector('input[type="search"]'));expect(focus).not.toHaveBeenCalled();expect(document.body.scrollTop).toBe(79)
  })

  it('阅读选择面板允许免密钥B站并显示固定模型，写作面板不提供该服务', async () => {
    const config = runtime.reactive(new Config()); config.harness.model = 'unused-reader'; config.model.bilibili = 'unused-default'
    await mountPopup(config, {serviceOptions: [...services, {value: 'bilibili', label: 'B站翻译'}]}, false)
    await open('reading'); expect(option('bilibili')).not.toBeNull(); expect(option('bilibili').hasAttribute('disabled')).toBe(false)
    expect(option('bilibili').querySelector('.service-choice-setup')).toBeNull()
    eventOf(option('bilibili'))(); await settle(); expect(config.harness.service).toBe('bilibili')
    expect(row('reading').textContent).toContain(BILIBILI_FREE_TRANSLATION_MODEL)
    expect(row('reading').querySelector('.assignment-warning')).toBeNull()
    await open('reading'); expect(document.querySelector('.service-picker-warning')).toBeNull(); pickerBack()(); await settle()
    await open('writing'); expect(document.querySelector('[data-service-choice="bilibili"]')).toBeNull()
  })
  it('默认B站阅读继承无警告，写作继承及残留独立选择保留禁用状态并可恢复AI', async () => {
    const config = runtime.reactive(new Config())
    await mountPopup(config, {serviceOptions: [...services, {value: 'bilibili', label: 'B站翻译'}]}); config.service = 'bilibili'; await settle()
    expect(row('reading').querySelector('.assignment-warning')).toBeNull(); expect(row('reading').textContent).toContain(BILIBILI_FREE_TRANSLATION_MODEL)
    expect(row('writing').querySelector('.assignment-warning')?.getAttribute('aria-label')).toBe('featureServices.writing · featureServices.aiOnly')
    config.writing.service = 'bilibili'; await settle(); await open('writing')
    expect(option('bilibili').hasAttribute('disabled')).toBe(true)
    const unchanged = config.writing.service; eventOf(option('bilibili'))(); expect(config.writing.service).toBe(unchanged)
    expect(document.querySelector('.service-picker-warning')?.textContent).toBe('featureServices.writing · featureServices.aiOnly')
    eventOf(option('openai'))(); await settle(); expect(config.writing.service).toBe('openai')
    expect(row('writing').querySelector('.assignment-warning')).toBeNull()
  })
  it.each(['hidden', 'cached', 'unmount', 'config'])('%s 后旧选项、返回、输入与关闭事件全部失效', async reason => {
    await mountPopup();await open('input');const choose = eventOf(option('deepseek')), close = eventOf(document.querySelector('.service-panel-close')!), back = pickerBack(), input = document.querySelector('input')!, type = eventOf(input,'onInput');invalidate(reason);await settle();const before = snapshot(props.config)
    choose();back();type({target:input});close();expect(snapshot(props.config)).toEqual(before);expect(updates).not.toHaveBeenCalled()
  })
  it('旧选项不能借用后来打开的功能，关闭和返回不能关闭后来的面板', async () => {
    await mountPopup();await open('input');const choose=eventOf(option('deepseek')), close=eventOf(document.querySelector('.service-panel-close')!), back=pickerBack();back();await settle();await open('reading');const before=snapshot(props.config)
    choose();close();back();await settle();expect(snapshot(props.config)).toEqual(before);expect(updates).not.toHaveBeenCalled();expect(document.querySelector('[data-service-picker]')?.getAttribute('data-service-picker')).toBe('reading')
    eventOf(option('deepseek'))();await settle();expect(props.config.harness.service).toBe('deepseek');expect(props.config.inputBoxTranslationService).toBe('');expect(props.config.service).toBe('openai')
  })
  it('概览旧打开和关闭事件在面板往返后失效', async () => {
    await mountPopup();const oldOpen=eventOf(row('hover')), oldClose=eventOf(document.querySelector('.service-panel-close')!);await open('input');pickerBack()();await settle();oldOpen();oldClose();await settle();expect(document.querySelector('[data-service-picker]')).toBeNull();expect(updates).not.toHaveBeenCalled();eventOf(document.querySelector('.service-panel-close')!)();expect(updates).toHaveBeenCalledOnce()
  })
  it('关闭通知同步使所属控件失效，父级随后重新开启可操作', async () => {
    await mountPopup();await open('input');const choose=eventOf(option('deepseek')), close=eventOf(document.querySelector('.service-panel-close')!);close();choose();close();expect(updates).toHaveBeenCalledOnce();expect(props.config.inputBoxTranslationService).toBe('');props.active=false;await settle();props.active=true;await settle();await open('input');eventOf(option('deepseek'))();expect(props.config.inputBoxTranslationService).toBe('deepseek')
  })
  it.each(['selected','inherited-default'])('外部 %s 变化关闭旧会话并保留新真值', async kind => {
    await mountPopup();await open('hover');const choose=eventOf(option('deepseek'));if(kind==='selected') props.config.hoverTranslationService='microsoft';else props.config.service='microsoft';await settle();choose();expect(document.querySelector('[data-service-picker]')).toBeNull();expect(props.config.hoverTranslationService).toBe(kind==='selected'?'microsoft':'');expect(props.config.service).toBe(kind==='selected'?'openai':'microsoft');await open('hover');eventOf(option('deepseek'))();expect(props.config.hoverTranslationService).toBe('deepseek')
  })
  it('复验当前目录与 AI 能力，停用已选项显示且允许回到继承', async () => {
    const config=runtime.reactive(new Config());config.harness.service='gone';await mountPopup(config);await open('reading');expect(option('gone').hasAttribute('disabled')).toBe(true);expect(document.querySelector('[data-service-choice="microsoft"]')).toBeNull();const choose=eventOf(option('deepseek'));props.serviceOptions=[{value:'deepseek',label:'DeepSeek',disabled:true}];await settle();choose();expect(config.harness.service).toBe('gone');eventOf(option(''))();await settle();expect(config.harness.service).toBe('')
  })
  it('旧搜索结果与折叠条目不跨查询或展开状态写入', async () => {
    await mountPopup();await open('input');const choose=eventOf(option('deepseek'));await search('Microsoft');choose();expect(props.config.inputBoxTranslationService).toBe('');expect(option('microsoft')).not.toBeNull();eventOf(option('microsoft'))();expect(props.config.inputBoxTranslationService).toBe('microsoft')
  })
  it.each(['reading','input'])('已删除自定义供应商不能由旧 %s 选项重新分配', async id => {
    const config=runtime.reactive(new Config());config.customOpenAIProviders=[{id:'custom:local',name:'Local',endpoint:'http://localhost/v1',models:['unique-needle']}];await mountPopup(config,{serviceOptions:[...services,{value:'custom:local',label:'Local'}]});await open(id);await search('unique-needle');const choose=eventOf(option('custom:local'));config.customOpenAIProviders=[];await settle();choose();expect(config.harness.service).toBe('');expect(config.inputBoxTranslationService).toBe('')
  })
  it('十行分配和独立模型清理保持原语义，重复选择不清理模型', async () => {
    const config=runtime.reactive(new Config());config.inputBoxTranslationService='openai';config.inputBoxTranslationModel='input-model';config.harness.service='openai';config.harness.model='reading-model';config.writing.service='openai';config.writing.model='writing-model';await mountPopup(config);expect(document.querySelectorAll('[data-feature-service]').length).toBe(10)
    for(const [id,read] of [['input',()=>config.inputBoxTranslationModel],['reading',()=>config.harness.model],['writing',()=>config.writing.model]] as const){await open(id);eventOf(option('openai'))();await settle();expect(read()).toContain('model');await open(id);eventOf(option('deepseek'))();await settle();expect(read()).toBe('')}
    for(const id of ['hover','selection','image','video','document','area']) {await open(id);eventOf(option('microsoft'))();await settle();expect(row(id).textContent).toContain('Microsoft')}
    await open('default');expect(document.querySelector('[data-service-choice=""]')).toBeNull();eventOf(option('microsoft'))();await settle();expect(config.service).toBe('microsoft');expect(config.harness.service).toBe('deepseek')
  })
  it('凭据使用独立模型并避免枚举无关配置，模型变化更新对应提示', async () => {
    const config=runtime.reactive(new Config());config.model.openai='main';config.inputBoxTranslationModel='input';config.requireApiKey[createApiKeyRequirementKey('openai','input')]=false;let fields=0,models=0
    for(let i=0;i<1000;i++) Object.defineProperty(config,`unrelated${i}`,{enumerable:true,configurable:true,get:()=>{fields++;return ''}})
    for(let i=0;i<500;i++) Object.defineProperty(config.model,`unrelated${i}`,{enumerable:true,configurable:true,get:()=>{models++;return ''}})
    await mountPopup(config, {}, false);expect(row('input').querySelector('.assignment-warning')).toBeNull();expect(row('hover').querySelector('.assignment-warning')).not.toBeNull();expect({fields,models}).toEqual({fields:0,models:0});config.requireApiKey[createApiKeyRequirementKey('openai','input')]=true;await settle();expect(row('input').querySelector('.assignment-warning')).not.toBeNull();expect({fields,models}).toEqual({fields:0,models:0})
  })
  it('搜索支持配置模型、自定义模型和服务名，AI 面板排除机器服务', async () => {
    const config=runtime.reactive(new Config());config.customModels.deepseek=['unique-needle'];await mountPopup(config);await open('input');await search('unique needle');expect(option('deepseek').textContent).toContain('unique-needle');await search('Microsoft');expect(option('microsoft')).not.toBeNull();pickerBack()();await settle();await open('reading');await search('Microsoft');expect(document.querySelector('[data-service-choice="microsoft"]')).toBeNull()
  })
  it('当前查询输入、清空与更多服务收起正常，旧控制不能改新面板', async () => {
    await mountPopup(undefined,{serviceOptions:[...services,{value:'ollama',label:'Ollama'}]});await open('input');const oldMore=eventOf(document.querySelector('.service-picker-more')!), oldType=eventOf(document.querySelector('input')!,'onInput');expect(option('ollama')).not.toBeNull();oldMore();await settle();expect(option('ollama')).toBeNull();await search('OpenAI');const clear=eventOf(document.querySelector('.service-picker-search button')!);clear();await settle();expect((document.querySelector('input') as HTMLInputElement).value).toBe('');pickerBack()();await settle();await open('reading');oldMore();oldType({target:document.querySelector('input')});await settle();expect(document.querySelector('[data-service-picker]')?.getAttribute('data-service-picker')).toBe('reading');expect((document.querySelector('input') as HTMLInputElement).value).toBe('');expect(option('ollama')).not.toBeNull()
  })
  it('当前 ArrowDown 和列表方向键导航只访问可用条目，Escape 返回概览', async () => {
    await mountPopup();await open('input');const prevent=vi.fn(), stop=vi.fn(), input=document.querySelector('input')!;eventOf(input,'onKeydown')({key:'ArrowDown',preventDefault:prevent});expect(focused).toBe(option(''));const list=document.querySelector('[role="listbox"]')!, nav=eventOf(list,'onKeydown');nav({key:'End',target:option(''),preventDefault:prevent});expect(focused).toBe(option('microsoft'));nav({key:'ArrowDown',target:option('microsoft'),preventDefault:prevent});expect(focused).toBe(option(''));nav({key:'Home',target:option('microsoft'),preventDefault:prevent});expect(focused).toBe(option(''));nav({key:'ArrowUp',target:option(''),preventDefault:prevent});expect(focused).toBe(option('microsoft'));nav({key:'x',target:option(''),preventDefault:prevent});expect(prevent).toHaveBeenCalledTimes(5);eventOf(document.querySelector('.popup-service-panel')!,'onKeydown')({key:'Escape',stopPropagation:stop});await settle();expect(stop).toHaveBeenCalledOnce();expect(document.querySelector('[data-service-picker]')).toBeNull()
  })
  it('返回后只恢复所属行，用户主动移走焦点或重开面板时旧任务不抢焦点', async () => {
    await mountPopup();await open('input');expect(focused).toBe(document.querySelector('input'));pickerBack()();await settle();expect(focused).toBe(row('input'));eventOf(row('input'))();const outside=document.createElement('button');document.body.append(outside);focused=outside;focus.mockClear();await settle();expect(focus).not.toHaveBeenCalled();expect(focused).toBe(outside);pickerBack()();await settle();expect(focused).toBe(outside)
  })
  it('回退后尚未渲染便隐藏、替换配置或再次打开，不执行过期焦点任务', async () => {
    await mountPopup();await open('input');pickerBack()();props.active=false;focus.mockClear();await settle();expect(focus).not.toHaveBeenCalled();props.active=true;await settle();await open('input');pickerBack()();state.openPicker(state.fields.find((f:any)=>f.id==='reading'));focus.mockClear();await settle();expect(document.querySelector('[data-service-picker]')?.getAttribute('data-service-picker')).toBe('reading');expect(focused).not.toBe(row('input'))
  })
  it('未声明 active 的普通使用允许默认服务选择', async () => {
    await mountPopup(undefined,{active:undefined});await open('default');eventOf(option('microsoft'))();await settle();expect(props.config.service).toBe('microsoft')
  })
  it.each(['hidden','cached','unmount','config'])('打开后渲染前 %s，不执行旧面板的延迟焦点', async reason => {
    await mountPopup();const el=row('input') as HTMLElement;el.focus();eventOf(el)();invalidate(reason);focus.mockClear();await settle();expect(focus).not.toHaveBeenCalled()
  })
  it('文档独立模型凭据与网页默认分离，父级模型更新使提示重新计算', async () => {
    const config=runtime.reactive(new Config());config.documentService='openai';config.documentModel.openai='document-model';config.model.openai='default-model';config.requireApiKey[createApiKeyRequirementKey('openai','document-model')]=false;await mountPopup(config, {}, false);expect(row('document').querySelector('.assignment-warning')).toBeNull();expect(row('document').textContent).toContain('document-model');expect(row('default').querySelector('.assignment-warning')).not.toBeNull();config.documentModel.openai='other-model';await settle();expect(row('document').querySelector('.assignment-warning')).not.toBeNull()
  })
  it('AI 能力提示属于对应功能，不把写作助手称作默认 AI 讲解', async () => {
    await mountPopup();props.config.service='microsoft';await settle();expect(row('writing').querySelector('.assignment-warning')?.getAttribute('aria-label')).toBe('featureServices.writing · featureServices.aiOnly');expect(row('reading').querySelector('.assignment-warning')?.getAttribute('aria-label')).toBe('featureServices.reading · featureServices.aiOnly');await open('writing');expect(document.querySelector('.service-picker-warning')?.textContent).toBe('featureServices.writing · featureServices.aiOnly')
  })
  it('默认 active 调用关闭后可重新激活缓存组件，旧会话不复活', async () => {
    await mountPopup(undefined,{active:undefined});await open('input');const old=eventOf(option('deepseek'));eventOf(document.querySelector('.service-panel-close')!)();shown.value=false;await settle();shown.value=true;await settle();old();expect(props.config.inputBoxTranslationService).toBe('');await open('input');eventOf(option('deepseek'))();await settle();expect(props.config.inputBoxTranslationService).toBe('deepseek');expect(updates).toHaveBeenCalledOnce()
  })
})
