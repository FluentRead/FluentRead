/**
 * @file tests/quickProfileSettingsLifecycle.test.ts
 * 文件职责：验证实际快捷翻译设置模板的草稿合并、控件与录制会话归属、容量和配置选项。
 * 主要内容：执行真实缓存客户端模板，覆盖隐藏、缓存、配置替换、方案重用、字段变化、录制容量/冲突及模型、语言、展示、术语偏好。
 * 模块边界：Linkedom 保留实际节点树，展示控件与焦点为受控端口；不调用翻译或验证系统输入法。
 */
import {parseHTML} from 'linkedom'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {customModelString} from '@/src/core/config/catalog'
import {createQuickTranslationProfile, type QuickTranslationAction, type QuickTranslationProfile} from '@/src/core/config/quickTranslation'

import * as runtime from 'vue'
import QuickTranslationProfiles from '@/src/features/settings/ui/QuickTranslationProfiles.vue'
let app: import('vue').App, document: Document, win: any, focused: Element | null
let state: Record<string, any>, props: Record<string, any>, shown: import('vue').Ref<boolean>
let events: Map<Element, Record<string, any>>
const recorderPort = vi.hoisted(() => ({actual: false}))
const warning=vi.fn(),info=vi.fn(),updates = vi.fn(), focus = vi.fn(), selectionRange = vi.fn()
let capabilities: Record<string, unknown>
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: runtime.ref('zh-CN'), t: (key: string) => key, translateLegacy: (text: string) => text})}))
vi.mock('element-plus', () => ({ElIcon: {render: () => null}, ElMessage: {warning: (...args: unknown[]) => warning(...args), info: (...args: unknown[]) => info(...args)}}))
vi.mock('@/src/platform/browser/capabilities', () => ({get browserCapabilities() {return capabilities}}))
vi.mock('@/src/ui/components/CustomHotkeyInput.vue', async importOriginal => {const actual = await importOriginal<{default: runtime.Component}>();return {__esModule: true, default: {setup(_: unknown, {attrs}: any) {const instance = runtime.getCurrentInstance()!;return () => recorderPort.actual ? runtime.h(actual.default, attrs) : runtime.h('div', {...attrs, class: 'recorder-port', 'data-session-key': instance.vnode.key})}}}})
vi.mock('@/src/ui/components/GlossaryLibrarySelect.vue', () => ({default: {setup(_: unknown, {attrs}: any) {return () => runtime.h('div', {...attrs, class: 'glossary-port'})}}}))
vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {render: () => null}}))
async function settle() {await runtime.nextTick();await Promise.resolve();await runtime.nextTick()}
beforeEach(async () => {
  vi.clearAllMocks();recorderPort.actual=false;capabilities = runtime.reactive({browser: 'chrome', areaTranslation: true, imageTranslation: true});events = new Map();const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document;focused = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [key, value] of Object.entries({document, window: win, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLElement: win.HTMLElement, Event: win.Event, Node: win.Node})) vi.stubGlobal(key, value)

})
afterEach(async () => {app?.unmount();await settle();vi.unstubAllGlobals()})
async function mount(values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  const component = QuickTranslationProfiles as runtime.Component, source = runtime.shallowReactive({active: true, context: {}, contextKey: 'service-a', ...values});shown = runtime.ref(true)
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



function p(overrides: Partial<QuickTranslationProfile> = {}): QuickTranslationProfile {return {...createQuickTranslationProfile('hover'),id:'quick-1',enabled:true,hotkey:'F5',...overrides}}
function eventOf(el: Element, name='onUpdate:modelValue') {const fn=events.get(el)?.[name];expect(fn,name).toBeTypeOf('function');return fn}
function control(field: string,id='quick-1') {return document.querySelector(`[data-testid="quick-profile-${field}-${id}"]`)!}
function card(id='quick-1') {return document.querySelector(`[data-profile-id="${id}"]`)!}
function recorder() {return document.querySelector('.recorder-port[data-model-value="true"]')!}
async function settleRecorder() {for(let i=0;i<60;i++){await settle();if(recorder())return;await new Promise(resolve=>setTimeout(resolve,5))}}
async function expand(id='quick-1') {eventOf(card(id).querySelector('.profile-summary')!,'onClick')();await settle()}
async function record(id?:string) {if(id)eventOf(control('hotkey',id),'onClick')();else eventOf(document.querySelector('.add-button')!,'onClick')();await settleRecorder();expect(recorder()).not.toBeNull()}
async function mountQuick(config=runtime.reactive(new Config()),profiles:QuickTranslationProfile[]=[p()],action:QuickTranslationAction='hover',autoAck=true,values:Record<string,unknown>={}) {
  config.service='openai';config.model.openai='gpt-4o';config.paragraphCopyEnabled=false;await mount({config,profiles:runtime.reactive(profiles),action,...values},{'onUpdate:profiles':(next:QuickTranslationProfile[])=>{updates(next);if(autoAck)props.profiles=runtime.reactive(next)}})
}
function latest():QuickTranslationProfile[] {return updates.mock.calls.at(-1)?.[0] || props.profiles}
function invalidate(reason:string) {if(reason==='hidden')props.active=false;if(reason==='cached')shown.value=false;if(reason==='unmount')app.unmount();if(reason==='config')props.config=runtime.reactive(new Config());if(reason==='action')props.action='full-page'}
describe('快捷方案保留已开启的两点选取组合',()=>{
  it('真实录制模板随点选启停显示冲突并阻止确认，解除后可保存',async()=>{
    recorderPort.actual=true;const cfg=runtime.reactive(new Config());Object.assign(cfg,{on:false,selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionClickSelectHotkey:'Alt+D'});
    await mountQuick(cfg,[]);(document.querySelector('.add-button') as HTMLElement).click();
    for(let i=0;i<60&&!document.querySelector('.custom-hotkey-dialog');i++){await settle();await new Promise(resolve=>setTimeout(resolve,5))}
    expect(document.querySelector('.custom-hotkey-dialog')).not.toBeNull();
    (document.querySelector('.preset-button[aria-label="Alt+D"]') as HTMLElement).click();await settle();expect(document.querySelector('.hotkey-status[role="alert"]')).toBeNull();
    cfg.selectionClickSelectEnabled=true;await settle();expect(document.querySelector('.hotkey-status[role="alert"]')?.textContent).toContain('quickTranslation.legacyConflictEdit');
    expect(document.querySelector('.custom-hotkey-dialog .primary-button')?.hasAttribute('disabled')).toBe(true);expect(updates).not.toHaveBeenCalled();
    cfg.selectionClickSelectEnabled=false;await settle();expect(document.querySelector('.hotkey-status[role="alert"]')).toBeNull();
    (document.querySelector('.custom-hotkey-dialog .primary-button') as HTMLElement).click();await settle();expect(latest()[0]).toMatchObject({hotkey:'Alt+D',enabled:true});
  })
  for(const action of ['hover','full-page','section'] as const){
    it.each(['enable','record'] as const)(`${action} %s 不得静默抢占两点选取`,async operation=>{
      const cfg=runtime.reactive(new Config());Object.assign(cfg,{on:false,selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionClickSelectEnabled:true,selectionClickSelectHotkey:'Alt+Shift+S'});
      await mountQuick(cfg,operation==='enable'?[p({action,enabled:false,hotkey:'Alt+Shift+S'})]:[],action);
      if(operation==='enable')eventOf(card().querySelector('input.profile-switch')!)(true);
      else {await record();expect.soft(state.recorderActions.validate('alt+shift+s')).toBeTruthy();eventOf(recorder(),'onConfirm')('Alt+Shift+S')}
      expect(updates).not.toHaveBeenCalled();expect(warning).toHaveBeenCalled();expect(cfg.selectionClickSelectEnabled).toBe(true);
    })
  }
  it.each([{selectionClickSelectEnabled:false},{selectionTranslatorMode:'disabled'},{disableSelectionTranslator:true}])('已停用的点选入口不阻止录制：%j',async patch=>{
    const cfg=runtime.reactive(new Config());Object.assign(cfg,{selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionClickSelectEnabled:true},patch);
    await mountQuick(cfg,[]);await record();eventOf(recorder(),'onConfirm')('Alt+Shift+S');expect(latest()[0]).toMatchObject({hotkey:'Alt+Shift+S',enabled:true});
  })
})
describe('实际快捷方案缓存模板与最新草稿',()=>{
  it('八个编辑器重复取得语言选项时共享同一个已翻译目录',async()=>{
    await mountQuick(undefined,Array.from({length:8},(_,i)=>p({id:`quick-${i+1}`,hotkey:`Alt+Shift+${String.fromCharCode(65+i)}`})));const before=props.profiles.map((profile:QuickTranslationProfile)=>state.languageOptions(profile))
    state.expandedIds=new Set(props.profiles.map((profile:QuickTranslationProfile)=>profile.id));await settle();expect(document.querySelectorAll('.profile-editor')).toHaveLength(8)
    const after=props.profiles.map((profile:QuickTranslationProfile)=>state.languageOptions(profile));expect(new Set([...before,...after]).size).toBe(1)
  })
  it.each(['hidden','cached','unmount','config','action'])('%s 后旧服务/语言/开关/删除与录制回调不修改配置',async reason=>{
    await mountQuick();await expand();const service=eventOf(control('service')),target=eventOf(control('target')),toggle=eventOf(card().querySelector('input.profile-switch')!),remove=eventOf(card().querySelector('.delete-button')!,'onClick');await record('quick-1');const confirm=eventOf(recorder(),'onConfirm');invalidate(reason);await settle();service('microsoft');target('ja');toggle(false);remove();confirm('F9');expect(updates).not.toHaveBeenCalled()
  })
  it('连续服务和语言修改在父级回传前合并，旧回传不能覆盖最新草稿',async()=>{
    await mountQuick(undefined,[p()], 'hover',false);await expand();const service=eventOf(control('service')),target=eventOf(control('target'));service('microsoft');const first=latest();target('ja');const second=latest();expect(second[0]).toMatchObject({service:'microsoft',targetLanguage:'ja'});props.profiles=runtime.reactive(first);await settle();expect(control('target').getAttribute('data-model-value')).toBe('ja');props.profiles=runtime.reactive(second);await settle();props.profiles=runtime.reactive(first);await settle();expect(control('target').getAttribute('data-model-value')).toBe('ja')
  })
  it('同 ID 外部替换、删除重建不复活旧控件',async()=>{
    await mountQuick();await expand();const old=eventOf(control('target'));props.profiles=runtime.reactive([p({service:'microsoft'})]);await settle();old('ja');expect(updates).not.toHaveBeenCalled();eventOf(control('target'))('ja');await settle();const removed=eventOf(control('service'));props.profiles=[];await settle();props.profiles=runtime.reactive([p()]);await settle();await expand();removed('deepseek');expect(latest()[0].service).not.toBe('deepseek')
  })
  it('方案移到另一动作或删除时立即关闭录制，并清除旧展开身份',async()=>{
    await mountQuick();await expand();await record('quick-1');props.profiles[0].action='section';await settle();expect(recorder()).toBeNull();expect(document.querySelector('.profile-card')).toBeNull();props.profiles[0].action='hover';await settle();expect(card().querySelector('.profile-editor')).toBeNull();await expand();eventOf(card().querySelector('.delete-button')!,'onClick')();await settle();props.profiles=runtime.reactive([p()]);await settle();expect(card().querySelector('.profile-editor')).toBeNull()
  })
  it('字段变化后再恢复旧值，旧事件仍然失效；无关字段事件保留',async()=>{
    await mountQuick();await expand();const old=eventOf(control('target'));eventOf(control('target'))('ja');await settle();eventOf(control('target'))('');await settle();updates.mockClear();old('en');expect(updates).not.toHaveBeenCalled();eventOf(control('target'))('en');expect(latest()[0].targetLanguage).toBe('en')
  })
  it('折叠后重新展开不复活被销毁的编辑控件',async()=>{
    await mountQuick();await expand();const old=eventOf(control('target'));await expand();await expand();old('ja');expect(updates).not.toHaveBeenCalled();eventOf(control('target'))('ja');expect(latest()[0].targetLanguage).toBe('ja')
  })
  it('相同服务保留独立模型，新模型跟随服务选择被固定，取消模型不恢复服务继承',async()=>{
    await mountQuick(undefined,[p({service:'openai',model:'private-model'})]);await expand();eventOf(control('service'))('openai');expect(updates).not.toHaveBeenCalled();expect(props.profiles[0].model).toBe('private-model');eventOf(control('service'))('');await settle();eventOf(control('model'))('gpt-4o');await settle();expect(latest()[0]).toMatchObject({service:'openai',model:'gpt-4o'});eventOf(control('model'))('');expect(latest()[0]).toMatchObject({service:'openai',model:''})
  })
  it('模型旧事件不能借用新服务，改变默认服务也不能借用旧默认模型',async()=>{
    await mountQuick();await expand();const model=eventOf(control('model'));props.config.service='deepseek';await settle();model('gpt-4o');expect(updates).not.toHaveBeenCalled();props.config.service='openai';await settle();model('gpt-4o');expect(updates).not.toHaveBeenCalled();eventOf(control('service'))('microsoft');await settle();model('gpt-4o');expect(latest()[0]).toMatchObject({service:'microsoft',model:''})
  })
  it('拒绝未知服务、模型、语言、枚举和非布尔开关，不把无效值当成继承',async()=>{
    await mountQuick(undefined,[p({action:'full-page'})],'full-page');await expand();for(const field of ['service','model','target','display','range']){eventOf(control(field))(true);eventOf(control(field))('unknown-value')};eventOf(card().querySelector('input.profile-switch')!)('false');expect(updates).not.toHaveBeenCalled();eventOf(control('range'))('all');expect(latest()[0].fullPageMode).toBe('all')
  })
  it('移除自定义服务后拒绝旧选择，保留旧选择显示并允许恢复继承',async()=>{
    const cfg=runtime.reactive(new Config());cfg.customOpenAIProviders=[{id:'custom:local',name:'Local',endpoint:'http://localhost/v1',models:['private-model']}];await mountQuick(cfg,[p({service:'custom:local',model:'private-model'})]);await expand();const old=eventOf(control('service')),model=eventOf(control('model'));cfg.customOpenAIProviders=[];await settle();expect(card().classList.contains('is-unavailable')).toBe(true);old('custom:local');model('private-model');expect(updates).not.toHaveBeenCalled();eventOf(control('service'))('');expect(latest()[0]).toMatchObject({service:'',model:''})
  })
  it('键盘删除当前方案后聚焦相邻方案，删除最后一项回到添加按钮',async()=>{
    await mountQuick(undefined,[p(),p({id:'quick-2',hotkey:'F6'})]);await expand();
    const remove=card().querySelector<HTMLButtonElement>('.delete-button')!;remove.focus();remove.click();await settle();
    expect(card()).toBeNull();expect(focused).toBe(card('quick-2').querySelector('.profile-summary'));
    await expand('quick-2');const last=card('quick-2').querySelector<HTMLButtonElement>('.delete-button')!;last.focus();last.click();await settle();
    expect(document.querySelector('.profile-card')).toBeNull();expect(focused).toBe(document.querySelector('.add-button'));expect(latest()).toEqual([]);
  })
  it('有效的显示方式、启停和术语选择完整往返，重复或非法术语不发布',async()=>{
    const cfg=runtime.reactive(new Config());cfg.glossaryEnabled=true;cfg.glossaryLibraries=[{id:'terms',name:'Terms',enabled:true,domains:[],sourceLanguage:'auto',targetLanguage:'zh-Hans',entries:[]}];
    await mountQuick(cfg);await expand();eventOf(card().querySelector('input.profile-switch')!)(false);await settle();expect(latest()[0].enabled).toBe(false);
    eventOf(card().querySelector('input.profile-switch')!)(true);await settle();expect(latest()[0].enabled).toBe(true);
    eventOf(control('display'))('translation-only');await settle();expect(latest()[0].displayMode).toBe('translation-only');
    eventOf(control('display'))('bilingual');await settle();expect(latest()[0].displayMode).toBe('bilingual');
    const glossary=()=>eventOf(card().querySelector('.glossary-port')!);glossary()(['terms']);await settle();expect(latest()[0].glossaryIds).toEqual(['terms']);
    updates.mockClear();glossary()(['unknown']);glossary()([true]);expect(updates).not.toHaveBeenCalled();glossary()(null);await settle();expect(latest()[0].glossaryIds).toBeNull();
  })
  it('保留未知旧目标语言与自定义默认模型，显示系统冲突并可恢复语言继承',async()=>{
    const cfg=runtime.reactive(new Config());await mountQuick(cfg,[p({hotkey:'Ctrl+C',targetLanguage:'xx-legacy',model:'saved-private-model'})]);
    cfg.model.openai=customModelString;cfg.customModel.openai='private-default';await expand();
    expect(card().querySelector('.service-summary strong')?.textContent).toContain('saved-private-model');
    expect(card().querySelector('.service-summary small')?.textContent).toContain('xx-legacy');expect(card().querySelector('.field-warning')).not.toBeNull();
    eventOf(control('model'))('private-default');await settle();expect(latest()[0].model).toBe('private-default');
    eventOf(control('target'))('');await settle();expect(latest()[0].targetLanguage).toBe('');expect(card().querySelector('.service-summary small')?.textContent).not.toContain('xx-legacy');
  })
  it('Google 快捷方案支持切换并保留仅译文等显示方式，旧服务回调失效',async()=>{
    await mountQuick(undefined,[p({displayMode:'translation-only'})]);await expand();const old=eventOf(control('display'));eventOf(control('service'))('google');await settle();old('bilingual');expect(latest()[0].displayMode).toBe('translation-only');expect(control('display').getAttribute('data-model-value')).toBe('translation-only');eventOf(control('display'))('bilingual');await settle();expect(latest()[0].displayMode).toBe('bilingual');eventOf(control('display'))('translation-only');await settle();expect(latest()[0].displayMode).toBe('translation-only')
  })
  it('术语只接受当前库，复制输入数组并保留继承、停用语义',async()=>{
    const cfg=runtime.reactive(new Config());cfg.glossaryEnabled=true;cfg.glossaryLibraries=[{id:'terms',name:'Terms',enabled:true,sourceLanguage:'',targetLanguage:'',domains:[],entries:[]}];await mountQuick(cfg);await expand();const port=()=>card().querySelector('.glossary-port')!;eventOf(port())(['gone']);eventOf(port())('terms');expect(updates).not.toHaveBeenCalled();const ids=['terms'];eventOf(port())(ids);ids.push('later');await settle();expect(latest()[0].glossaryIds).toEqual(['terms']);eventOf(port())([]);await settle();expect(latest()[0].glossaryIds).toEqual([]);eventOf(port())(null);expect(latest()[0].glossaryIds).toBeNull()
  })
  it('旧术语事件不能借用改变后的模型或被删除的库',async()=>{
    const cfg=runtime.reactive(new Config());cfg.glossaryEnabled=true;cfg.glossaryLibraries=[{id:'terms',name:'Terms',enabled:true,sourceLanguage:'',targetLanguage:'',domains:[],entries:[]}];await mountQuick(cfg);await expand();const old=eventOf(card().querySelector('.glossary-port')!);eventOf(control('model'))('gpt-4o');await settle();old(['terms']);expect(latest()[0].glossaryIds).toBeUndefined();const next=eventOf(card().querySelector('.glossary-port')!);cfg.glossaryLibraries=[];await settle();next(['terms']);expect(latest()[0].glossaryIds).toBeUndefined()
  })
})
describe('录制会话、容量与完整冲突',()=>{
  it.each(['hover','full-page','section'] as const)('%s 在确认时复验八项容量，其他动作独立计数',async action=>{
    const profiles=Array.from({length:7},(_,i)=>p({id:`saved-${i}`,action,hotkey:`Alt+Shift+${String.fromCharCode(65+i)}`}));await mountQuick(undefined,profiles,action);await record();const confirm=eventOf(recorder(),'onConfirm');props.profiles=runtime.reactive([...props.profiles,p({id:'eighth',action,hotkey:'F6'})]);await settle();confirm('F9');expect(updates).not.toHaveBeenCalled();expect(warning).toHaveBeenCalledWith('quickTranslation.capacityLimit');expect(props.profiles).toHaveLength(8)
  })
  it('新增不会受其他动作八项限制，确认开启已记录的方案并保留其他项',async()=>{
    const others=Array.from({length:8},(_,i)=>p({id:`page-${i}`,action:'full-page',hotkey:`Alt+Shift+${String.fromCharCode(65+i)}`}));await mountQuick(undefined,others);await record();eventOf(recorder(),'onConfirm')('F9');await settle();expect(latest()).toHaveLength(9);expect(latest().at(-1)).toMatchObject({action:'hover',hotkey:'F9',enabled:true});expect(recorder()).toBeNull()
  })
  it('旧确认、取消和 model false 不能借用新录制会话',async()=>{
    await mountQuick();await expand();await record('quick-1');const old=recorder(),confirm=eventOf(old,'onConfirm'),cancel=eventOf(old,'onCancel'),close=eventOf(old);cancel();await settle();await record();const key=recorder().getAttribute('data-session-key');confirm('F9');cancel();close(false);await settle();expect(recorder().getAttribute('data-session-key')).toBe(key);expect(updates).not.toHaveBeenCalled();eventOf(recorder(),'onConfirm')('F9');expect(latest()).toHaveLength(2)
  })
  it('录制中服务和语言修改保留，确认只更新所属方案快捷键',async()=>{
    await mountQuick();await expand();await record('quick-1');const confirm=eventOf(recorder(),'onConfirm');eventOf(control('service'))('microsoft');await settle();eventOf(control('target'))('ja');await settle();confirm('F9');expect(latest()[0]).toMatchObject({service:'microsoft',targetLanguage:'ja',hotkey:'F9'})
  })
  it('外部修改快捷键或替换同 ID 方案使录制立即失效',async()=>{
    await mountQuick();await expand();await record('quick-1');const confirm=eventOf(recorder(),'onConfirm');props.profiles[0].hotkey='F6';await settle();expect(recorder()).toBeNull();confirm('F9');expect(updates).not.toHaveBeenCalled();await record('quick-1');const old=eventOf(recorder(),'onConfirm');props.profiles=runtime.reactive([p({hotkey:'F6'})]);await settle();expect(recorder()).toBeNull();old('F9');expect(updates).not.toHaveBeenCalled()
  })
  it.each(['paragraph','area','section','input','hover','page'])('录制与启用均复验 %s 旧入口冲突',async kind=>{
    await mountQuick(undefined,[p({enabled:false,hotkey:'F9'})]);const cfg=props.config;if(kind==='paragraph'){cfg.paragraphCopyEnabled=true;cfg.paragraphCopyHotkey='custom';cfg.customParagraphCopyHotkey='F9'}if(kind==='area'){cfg.selectionAreaEnabled=true;cfg.selectionAreaHotkey='custom';cfg.customSelectionAreaHotkey='F9'}if(kind==='section'){cfg.sectionTranslationHotkeyEnabled=true;cfg.sectionTranslationHotkey='custom';cfg.customSectionTranslationHotkey='F9'}if(kind==='input')cfg.inputBoxTranslationTrigger='ctrl_enter';if(kind==='hover'){cfg.hotkey='custom';cfg.customHotkey='F9'}if(kind==='page'){cfg.floatingBallHotkey='custom';cfg.customFloatingBallHotkey='F9'}await expand();await record('quick-1');eventOf(recorder(),'onConfirm')(kind==='input'?'Ctrl+Enter':'F9');expect(updates).not.toHaveBeenCalled();expect(warning).toHaveBeenCalled();eventOf(recorder(),'onCancel')();await settle();if(kind==='input'){props.profiles[0].hotkey='Ctrl+Enter';await settle()}eventOf(card().querySelector('input.profile-switch')!)(true);expect(updates).not.toHaveBeenCalled()
  })
  it('停用段落复制后其旧组合允许使用；跨动作重复快捷键仍拒绝',async()=>{
    const cfg=runtime.reactive(new Config());await mountQuick(cfg,[p(),p({id:'other',action:'section',hotkey:'F9'})]);cfg.paragraphCopyEnabled=false;await expand();await record('quick-1');eventOf(recorder(),'onConfirm')('F9');expect(updates).not.toHaveBeenCalled();eventOf(recorder(),'onConfirm')('Alt+C');expect(latest()[0].hotkey).toBe('Alt+C')
  })
  it('拒绝无效/空的新录制和错误类型，编辑清除会停用方案，划词优先提示只在启用时显示',async()=>{
    await mountQuick();await record();const confirm=eventOf(recorder(),'onConfirm');for(const value of ['none','',true,'garbage'])confirm(value);expect(updates).not.toHaveBeenCalled();eventOf(recorder(),'onCancel')();await settle();await expand();await record('quick-1');eventOf(recorder(),'onConfirm')('none');await settle();expect(latest()[0]).toMatchObject({hotkey:'',enabled:false});eventOf(card().querySelector('input.profile-switch')!)(true);expect(latest()[0].enabled).toBe(false);props.config.disableSelectionTranslator=false;props.config.selectionTranslatorMode='bilingual';props.config.selectionTranslatorTrigger='custom';props.config.customSelectionTranslatorHotkey='F9';await record('quick-1');eventOf(recorder(),'onConfirm')('F9');expect(info).toHaveBeenCalledWith('quickTranslation.selectionPrecedence')
  })
  it('实际录制子组件随方案和旧入口配置即时复验冲突，合法后才能保存',async()=>{
    recorderPort.actual=true;await mountQuick(undefined,[p(),p({id:'other',action:'section',hotkey:'F9'})]);await expand();
    (control('hotkey') as HTMLElement).click();
    for(let i=0;i<60&&!document.querySelector('.custom-hotkey-dialog');i++){await settle();await new Promise(resolve=>setTimeout(resolve,5))}
    expect(document.querySelector('.custom-hotkey-dialog')).not.toBeNull();
    (document.querySelector('.preset-button[aria-label="F9"]') as HTMLElement).click();await settle();
    expect(document.querySelector('.hotkey-status[role="alert"]')?.textContent).toContain('quickTranslation.duplicate');
    expect(document.querySelector('.custom-hotkey-dialog .primary-button')?.hasAttribute('disabled')).toBe(true);
    props.profiles[1].hotkey='F10';await settle();expect(document.querySelector('.hotkey-status[role="alert"]')).toBeNull();
    props.config.hotkey='custom';props.config.customHotkey='F9';await settle();
    expect(document.querySelector('.hotkey-status[role="alert"]')?.textContent).toContain('quickTranslation.legacyConflictEdit');
    expect(updates).not.toHaveBeenCalled();props.config.hotkey='none';await settle();
    expect(document.querySelector('.custom-hotkey-dialog .primary-button')?.hasAttribute('disabled')).toBe(false);
    (document.querySelector('.custom-hotkey-dialog .primary-button') as HTMLElement).click();await settle();
    expect(latest()[0]).toMatchObject({hotkey:'F9',enabled:true});expect(updates).toHaveBeenCalledOnce();expect(document.querySelector('.custom-hotkey-dialog')).toBeNull();
  })
  it('隐藏、配置替换或新录制使旧延迟焦点无效，用户移动焦点后不抢回',async()=>{
    await mountQuick();await expand();const trigger=control('hotkey') as HTMLElement;trigger.focus();await record('quick-1');const outside=document.createElement('button');document.body.append(outside);focused=outside;eventOf(recorder(),'onCancel')();focus.mockClear();await settle();expect(focus).not.toHaveBeenCalled();trigger.focus();await record('quick-1');eventOf(recorder(),'onCancel')();props.active=false;focus.mockClear();await settle();expect(focus).not.toHaveBeenCalled()
  })
})
