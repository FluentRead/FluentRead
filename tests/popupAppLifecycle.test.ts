/**
 * @file tests/popupAppLifecycle.test.ts
 * 文件职责：执行实际 Popup 与站点按钮客户端模板，验证生命周期、页面竞态、缓存事件及焦点归属。
 * 主要内容：保持真实 Vue/KeepAlive、缓存和诊断模板，受控浏览器、持久化及展示端口覆盖延迟回复、失活、消息来源、诊断动作失败、状态切换、抽屉和弹窗；真实服务选择子组件以布局端口验证键盘恢复时仅修正所属 scroller 的搜索外框；网站保存执行真实共享 store，验证同 tick 草稿捕获与在途确认的字段归属。
 * 模块边界：Linkedom 保留节点/事件树，动画、Element Plus、外部存储和浏览器为受控端口，普通 UI 用例控制保存端口；真实样式与浏览器流程另行验证。
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseHTML} from 'linkedom'
import {createServer, type ViteDevServer} from 'vite'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import ts from 'typescript'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config, normalizeConfig} from '@/src/core/config/model'
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials'
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage'
import {createPopupTabSource} from '@/src/app/popup/sourceTab'
import {getDiagnosticUiText} from '@/src/services/diagnostics'

const runtime=createRequire(import.meta.url)('vue') as typeof import('vue')
const popupCompileOptions={
  script:{id:'popup-client-fixture',inlineTemplate:false},
  template:{id:'popup-client-fixture',compilerOptions:{cacheHandlers:true}},
  typescript:{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}},
  transition:{pattern:/<\/?Transition\b/gu,replacement:'OwnedTransition'},
}
type PopupCompilation=Readonly<{source:string;options:string;code:string;templateErrors:readonly unknown[]}>
const popupCompilations=new Map<string,PopupCompilation>()
function compilePopupClient(file:string):string{
  const source=readFileSync(file,'utf8')
  // bindingMetadata 由同一源码和 script 选项推导；其余编译、Transition 改写选项全部进入键。
  const options=JSON.stringify([file,{...popupCompileOptions,transition:{...popupCompileOptions.transition,pattern:String(popupCompileOptions.transition.pattern)}}])
  let compiled=popupCompilations.get(file)
  if(!compiled||compiled.source!==source||compiled.options!==options){
    const {descriptor}=parse(source,{filename:file}),script=compileScript(descriptor,popupCompileOptions.script)
    const templateSource=descriptor.template!.content.replace(popupCompileOptions.transition.pattern,tag=>tag.replace('Transition',popupCompileOptions.transition.replacement))
    const template=compileTemplate({...popupCompileOptions.template,source:templateSource,filename:file,
      compilerOptions:{...popupCompileOptions.template.compilerOptions,bindingMetadata:script.bindings}})
    const code=script.content.replace('export default','const fixtureComponent =')+'\n'+template.code+'\nfixtureComponent.render=render;export default fixtureComponent;'
    compiled=Object.freeze({source,options,code:ts.transpileModule(code,popupCompileOptions.typescript).outputText,templateErrors:Object.freeze([...template.errors])})
    // 保留每次 loader 的模板错误断言；失败产物不进入缓存。
    expect(compiled.templateErrors).toEqual([])
    if(popupCompilations.size>=3&&!popupCompilations.has(file))popupCompilations.delete(popupCompilations.keys().next().value!)
    popupCompilations.set(file,compiled)
  }else expect(compiled.templateErrors).toEqual([])
  // 只共享不可变代码和编译诊断；Vite 服务、模块执行、组件及端口仍逐例新建。
  return compiled.code
}
let server:ViteDevServer,app:import('vue').App,document:Document,win:any,state:Record<string,any>,focused:Element|null,shown:import('vue').Ref<boolean>,events:Map<Element,Record<string,any>>
let viewport:HTMLElement & {width:number;height:number;offsetLeft:number;offsetTop:number},viewportFrames:Map<number,FrameRequestCallback>
let executeServicePicker=false
function flushViewport(){const pending=[...viewportFrames.values()];viewportFrames.clear();for(const callback of pending)callback(0)}
const readAccess=vi.fn(),requestAccess=vi.fn()
let permissionEvents:Set<(change:'added'|'removed')=>void>
let locale:import('vue').Ref<string>,bundleRevision:import('vue').Ref<number>,localized:boolean,englishLoaded:boolean
const catalogs=Object.fromEntries(['zh-CN','en-US'].map(id=>[id,JSON.parse(readFileSync(resolve('src/core/i18n/messages/settings-copy',id+'.json'),'utf8')).messages]))
function permissionEvent(kind:'added'|'removed'){for(const listener of permissionEvents)listener(kind)}
function permissionText(key:string,params:Record<string,unknown>={}){void bundleRevision.value;if(!localized)return key;const id=locale.value==='en-US'&&englishLoaded?'en-US':'zh-CN';let text=catalogs[id][key]||key;for(const[k,v]of Object.entries(params))text=text.replaceAll('{'+k+'}',String(v));return text}
const close=vi.fn(),noticeFocus=vi.fn(),patches=vi.fn(),getTab=vi.fn(),getSourceTab=vi.fn(),send=vi.fn(),createTab=vi.fn(),openOptions=vi.fn(),runtimeSend=vi.fn(),reloadTab=vi.fn()
let config:Config,subscribe:(value:Config)=>void,tabEvents:Record<string,Set<(...args:any[])=>void>>,runtimeEvents:Set<(...args:any[])=>void>
type ConfigStore = typeof import('@/src/services/config/store')
type ConfigSender = NonNullable<Parameters<ConfigStore['requestConfigPatch']>[1]>
type ConfigWireMessage = Parameters<ConfigSender>[0]
let persistenceStore:ConfigStore|undefined,persistenceUnsubscribe:(()=>void)|undefined
let persistenceGates:Array<ReturnType<typeof deferred<void>>> = []
function tabEvent(name:string,...args:any[]){for(const listener of tabEvents[name])listener(...args)}
function runtimeEvent(message:unknown,sender:unknown){for(const listener of runtimeEvents)listener(message,sender)}
function deferred<T=unknown>() {let resolve!: (value:T)=>void,reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function settle(){await runtime.nextTick();await Promise.resolve();await runtime.nextTick()}
async function drain(){for(let i=0;i<10;i++)await settle()}
function expectCollapsedDiagnostic(){
  expect(document.querySelector('[data-diagnostic-details-toggle]')?.getAttribute('aria-expanded')).toBe('false')
  const notice=document.querySelector('.fluentread-diagnostic')!;expect(notice.querySelectorAll('button')).toHaveLength(1);expect(notice.querySelector('[data-diagnostic-details-toggle]')!.getAttribute('aria-haspopup')).toBe('dialog')
  for(const selector of ['[data-diagnostic-details]','.diagnostic-actions','.diagnostic-report','[data-diagnostic-primary]','[data-diagnostic-preview]','[data-diagnostic-dismiss]'])expect(notice.querySelector(selector)).toBeNull()
}
async function openDiagnosticDetails(){
  expectCollapsedDiagnostic();await eventOf(document.querySelector('[data-diagnostic-details-toggle]')!)();await drain()
  expect(document.querySelector('[data-diagnostic-details-toggle]')!.getAttribute('aria-expanded')).toBe('true');expect(document.querySelector('[data-diagnostic-details]')).not.toBeNull()
}
async function openFeature(name:string){eventOf(document.querySelector(`[data-popup-quick-feature="${name}"]`)!)();for(let i=0;i<100;i++){await drain();if(document.querySelector('.drawer-header > button'))return;await new Promise(resolve=>setTimeout(resolve,2))}throw new Error('实际抽屉端口未挂载')}
function eventOf(el:Element,name='onClick'){const fn=events.get(el)?.[name];expect(fn,name).toBeTypeOf('function');return fn}
function button(name:string){return document.querySelector(`[data-testid="${name}"]`)!}
function commands(){return send.mock.calls.filter(call=>call[1].type==='contextMenuTranslate')}
beforeEach(async()=>{
  permissionEvents=new Set();locale=runtime.ref('zh-CN');bundleRevision=runtime.ref(0);localized=false;englishLoaded=false;
  vi.clearAllMocks();executeServicePicker=false;for(const mock of [getTab,getSourceTab,send,createTab,openOptions,runtimeSend,patches,reloadTab,readAccess,requestAccess])mock.mockReset();events=new Map();runtimeEvents=new Set();tabEvents={onUpdated:new Set(),onActivated:new Set(),onRemoved:new Set()};const parsed=parseHTML('<html><body><div id="app"></div></body></html>');win=parsed.window;document=win.document;focused=document.body
  vi.stubGlobal('location',{search:''})
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused});win.close=close;win.matchMedia=()=>({matches:false,onchange:null})
  viewport=Object.assign(document.createElement('div'),{width:320,height:600,offsetLeft:0,offsetTop:0});win.visualViewport=viewport;win.innerWidth=320;win.innerHeight=600;viewportFrames=new Map();let frame=0
  win.requestAnimationFrame=vi.fn((callback:FrameRequestCallback)=>{viewportFrames.set(++frame,callback);return frame});win.cancelAnimationFrame=vi.fn((id:number)=>viewportFrames.delete(id))
  for(const [key,value]of Object.entries({document,window:win,HTMLElement:win.HTMLElement,Event:win.Event,Node:win.Node,navigator:{languages:['zh-CN'],onLine:true}}))vi.stubGlobal(key,value)
  config=new Config();config.uiLanguageSetupCompleted=true;config.on=true;config.service='google';config.alwaysTranslateDomains=[];config.disabledExtensionDomains=[]
  getTab.mockResolvedValue([{id:7,windowId:3,url:'https://example.com/a'}]);send.mockImplementation(async(_id,message)=>message.type==='getFullPageTranslationState'?{isTranslated:false,documentToken:'popup-fixture-document'}:{status:'success',isTranslated:message.action==='fullPage',documentToken:'popup-fixture-document'});createTab.mockResolvedValue({id:8});openOptions.mockResolvedValue(undefined);runtimeSend.mockResolvedValue({success:true})
  getSourceTab.mockResolvedValue({id:7,windowId:3,url:'https://example.com/a'})
  ;(globalThis as any).__popupFixture={permissionEvents,locale,bundleRevision,permissionText,readAccess,requestAccess,config,getTab,getSourceTab,send,createTab,openOptions,runtimeSend,reloadTab,patches,tabEvents,runtimeEvents,subscribe:(fn:typeof subscribe)=>{subscribe=fn},runtime,capabilities:runtime.reactive({browser:'chrome',areaTranslation:true,imageTranslation:true})}
  // popup 测试控制组件事件与轮询，不使用文件观察或热更新。
  server=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'silent',server:{watch:null},resolve:{alias:{'@':process.cwd()}},ssr:{noExternal:['webextension-polyfill']},plugins:[{name:'popup-owned-client',enforce:'pre',resolveId(id){
    if(/(?:\/|^)Popup(?:App|SiteRule)\.vue$/u.test(id)||(executeServicePicker&&/(?:\/|^)PopupServices\.vue$/u.test(id)))return resolve('src/app/popup',id.split('/').at(-1)!)+'.owned.ts'
    if(/(?:\/|^)DiagnosticNotice\.vue$/u.test(id))return resolve('src/features/self-help/ui/DiagnosticNotice.vue')+'.owned.ts'
    if(id==='webextension-polyfill')return '\0popup-browser'
    if(/\/src\/services\/config\/store(?:\.ts)?$/u.test(id))return '\0popup-config'
    if(/\/src\/platform\/storage\/configStorageRuntime(?:\.ts)?$/u.test(id))return '\0popup-storage'
    if(/\/src\/platform\/storage\/credentialContext(?:\.ts)?$/u.test(id))return '\0popup-credential-context'
    if(/\/src\/ui\/i18n(?:\.ts)?$/u.test(id))return '\0popup-i18n'
    if(/\/src\/ui\/interfaceAppearance(?:\.ts)?$/u.test(id))return '\0popup-appearance'
    if(/\/src\/platform\/browser\/freeProviderPermissions(?:\.ts)?$/u.test(id))return '\0popup-permissions'
    if(/\/src\/platform\/browser\/capabilities(?:\.ts)?$/u.test(id))return '\0popup-capabilities'
    if(id.endsWith('/PopupDrawer')||id.endsWith('/PopupDrawer.ts'))return '\0popup-drawer'
    if(id==='@element-plus/icons-vue')return '\0popup-icons'
    if(id.endsWith('.vue'))return '\0popup-display'
    return null
  },load(id){
    if(id.endsWith('.vue.owned.ts')){
      const componentPath=id.slice(0,-9),file=componentPath.startsWith('/src/')?resolve(componentPath.slice(1)):componentPath
      return compilePopupClient(file)
    }
    if(id==='\0popup-browser')return "const f=globalThis.__popupFixture;export default {tabs:{query:f.getTab,get:f.getSourceTab,sendMessage:f.send,create:f.createTab,reload:f.reloadTab,...Object.fromEntries(Object.entries(f.tabEvents).map(([name,set])=>[name,{addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)}]))},runtime:{id:'fixture-extension',onMessage:{addListener:fn=>f.runtimeEvents.add(fn),removeListener:fn=>f.runtimeEvents.delete(fn)},getManifest:()=>({version:'0.0.35'}),getURL:p=>'extension://'+p,sendMessage:f.runtimeSend,openOptionsPage:f.openOptions}}"
    if(id==='\0popup-config')return "const f=globalThis.__popupFixture;export const config=f.config;export const configReady=Promise.resolve();export const subscribeConfig=fn=>{f.subscribe(fn);return()=>{}};export const requestConfigPatch=async value=>f.patches(value);export const handoffPendingConfigPatches=async()=>{}"
    if(id==='\0popup-storage')return 'export const configStorage=globalThis.__popupFixture.persistencePort'
    if(id==='\0popup-credential-context')return 'export const isTrustedCredentialStorageContext=()=>true'
    if(id==='\0popup-i18n')return "const f=globalThis.__popupFixture;export const useUiI18n=()=>({language:f.locale,bundleRevision:f.bundleRevision,t:f.permissionText,translateLegacy:text=>text})"
    if(id==='\0popup-appearance')return 'export const applyInterfaceFont=()=>{},applyInterfaceSkin=()=>{}'
    if(id==='\0popup-permissions')return 'export const readFreePoolAccess=globalThis.__popupFixture.readAccess,requestFreeProviderAccess=globalThis.__popupFixture.requestAccess;export const subscribeFreeProviderAccessChanges=fn=>{globalThis.__popupFixture.permissionEvents.add(fn);return()=>globalThis.__popupFixture.permissionEvents.delete(fn)}'
    if(id==='\0popup-capabilities')return 'export const browserCapabilities=globalThis.__popupFixture.capabilities'
    if(id==='\0popup-icons')return 'export const Setting={render:()=>null}'
    if(id==='\0popup-drawer')return "import {h,Teleport} from 'vue';export default {setup(_, {attrs,slots}){return()=>attrs.modelValue||attrs['model-value']?h(Teleport,{to:'body'},h('div',{class:'popup-drawer-modal'},h('div',{...attrs,class:['drawer-port',attrs.class]},h('div',{class:'el-drawer__body'},slots.default?.())))):null}}"
    if(id==='\0popup-display')return "import {h} from 'vue';export default {setup(_, {attrs,slots}){return()=>h('div',attrs,slots.default?.())}}"
    return null
  }}]})
})
afterEach(async()=>{app?.unmount();await settle();persistenceUnsubscribe?.();for(const gate of persistenceGates)gate.resolve();persistenceGates=[];if(persistenceStore){await persistenceStore.waitForConfigPersistenceQueue();await persistenceStore.flushConfigHistory()}persistenceUnsubscribe=undefined;persistenceStore=undefined;await server?.close();delete(globalThis as any).__popupFixture;vi.useRealTimers();vi.unstubAllGlobals()})
async function attachPersistence(gates:Array<ReturnType<typeof deferred<void>>> = []) {
  persistenceGates=gates
  const initial=normalizeConfig(state.config),records=new Map<string,unknown>([['local:config',{...sanitizeConfigCredentials(initial),__fluentConfigRevision:10}],['local:credentials',extractConfigCredentials(initial)]])
  const port:ConfigStoragePort={writeOwner:false,getItem:async<T>(key:string)=>(records.get(key)??null) as T|null,setItem:async<T>(key:string,value:T)=>{records.set(key,structuredClone(value))},removeItem:async(key:string)=>{records.delete(key)},watch:()=>()=>{}}
  ;(globalThis as any).__popupFixture.persistencePort=port
  persistenceStore=await server.ssrLoadModule('/src/services/config/store.ts?popup-persistence') as ConfigStore;await persistenceStore.configReady
  const messages:ConfigWireMessage[]=[]
  const sender:ConfigSender=vi.fn(async message=>{
    const index=messages.length;messages.push(structuredClone(message));await gates[index]?.promise
    records.set('local:config',{...records.get('local:config') as Record<string,unknown>,...message.config,__fluentConfigRevision:11+index})
    return {success:true,revision:11+index}
  })
  patches.mockImplementation(value=>persistenceStore!.requestConfigPatch(value,sender));persistenceUnsubscribe=persistenceStore.subscribeConfig(value=>subscribe(value))
  return {records,messages,sender,store:persistenceStore}
}
async function mount(){
  const component=(await server.ssrLoadModule('/src/app/popup/PopupApp.vue')).default;shown=runtime.ref(true)
  const renderer=runtime.createRenderer({patchProp(el:any,key:string,previous:any,next:any){const handlers=events.get(el)||{};events.set(el,handlers);if(/^on[A-Z]/u.test(key)){handlers[key]=next;const name=key.slice(2).toLowerCase();if(previous)el.removeEventListener(name,previous);if(next)el.addEventListener(name,next);return}if(key==='class'){el.className=next??'';return}if(next===undefined||next===null||(next===false&&!/^(?:aria-|data-)/u.test(key)))el.removeAttribute(key);else el.setAttribute(key,String(next))},
    insert:(child:any,parent:any,anchor:any=null)=>parent.insertBefore(child,anchor),remove:(child:any)=>child.parentNode?.removeChild(child),createElement:tag=>{const el=document.createElement(tag) as any;el.focus=()=>{noticeFocus();focused=el};
      // Linkedom has no layout: model an in-view 24px status anchor inside the real 560px Popup shell.
      el.getBoundingClientRect=()=>el.classList.contains('popup-shell')?{top:0,bottom:560,left:0,right:320,width:320,height:560}:{top:230,bottom:254,left:272,right:296,width:24,height:24};return el},createText:text=>document.createTextNode(text),createComment:text=>document.createComment(text),setText:(node:any,text)=>{node.nodeValue=text},setElementText:(el:any,text)=>{el.textContent=text},parentNode:(node:any)=>node.parentNode,nextSibling:(node:any)=>node.nextSibling,querySelector:selector=>document.querySelector(selector),setScopeId:()=>{},cloneNode:(node:any)=>node.cloneNode(true),insertStaticContent:(html,parent:any,anchor:any)=>{const template=document.createElement('template');template.innerHTML=html;const first=template.content.firstChild!,last=template.content.lastChild!;parent.insertBefore(template.content,anchor);return[first,last]}})
  // 保留真实模板事件；Transition 的 CSS 动画为展示端口，生产截图验证真实动画。
  app=renderer.createApp({setup:()=>()=>runtime.h(runtime.KeepAlive,null,{default:()=>shown.value?runtime.h(component,{ref:(vm:any)=>{if(vm)state=vm.$.setupState}}):runtime.h({render:()=>null},{key:'other'})})});app.component('OwnedTransition',{setup:(_:unknown,{slots}:any)=>()=>slots.default?.()});app.config.warnHandler=()=>{};app.mount(document.getElementById('app')!);await drain()
}
async function focusedServiceSearchAtCompact(scrollTop = 22, naturalTop = 92) {
  executeServicePicker=true;await mount();eventOf(document.querySelector('.provider-summary')!)()
  for(let i=0;i<100&&!document.querySelector('[data-feature-service="default"]');i++){await drain();await new Promise(resolve=>setTimeout(resolve,2))}
  const assignment=document.querySelector<HTMLElement>('[data-feature-service="default"]')!;assignment.focus();eventOf(assignment)();await drain()
  const input=document.querySelector<HTMLInputElement>('input[type="search"]')!;input.value='micro';eventOf(input,'onInput')({target:input});await drain()
  Object.assign(viewport,{height:80});viewport.dispatchEvent(new win.Event('resize'));flushViewport();await drain()
  const border=input.closest<HTMLElement>('.service-picker-search')!,heading=document.querySelector<HTMLElement>('.service-picker-heading')!
  const scroller=input.closest<HTMLElement>('.el-drawer__body')!;let offset=scrollTop
  // 布局端口复现生产：body top16、heading bottom72、search top70、真实scrollTop22；setter保留浏览器0边界。
  Object.defineProperties(scroller,{clientTop:{configurable:true,value:0},clientHeight:{configurable:true,value:229},
    scrollTop:{configurable:true,get:()=>offset,set:(value:number)=>{offset=Math.max(0,value)}}})
  const rect=(top:number,bottom:number)=>({top,bottom,left:20,right:284,x:20,y:top,width:264,height:bottom-top,toJSON(){return this}}) as DOMRect
  scroller.getBoundingClientRect=()=>rect(16,245);heading.getBoundingClientRect=()=>{const top=Math.max(16,naturalTop-56-offset);return rect(top,top+56)}
  // naturalTop默认92对应生产真实滚动22px后的top70，非正常flow无间距的假设。
  border.getBoundingClientRect=()=>rect(naturalTop-offset,naturalTop+48-offset)
  return {input,border,heading,scroller,focusCalls:noticeFocus.mock.calls.length}
}
function growServiceViewport(height=263){Object.assign(viewport,{height});viewport.dispatchEvent(new win.Event('resize'));flushViewport()}
describe('实际 Popup 缓存模板与页面操作',()=>{
  it('搜索恢复到普通高度仅回退所属抽屉2px，让完整border离开动态吸顶标题',async()=>{
    const f=await focusedServiceSearchAtCompact();const picker=document.querySelector('[data-service-picker]')
    const hostScroll=vi.fn();win.scrollTo=hostScroll
    expect(f.scroller.scrollTop).toBe(22);expect(f.border.getBoundingClientRect().top).toBeLessThan(f.heading.getBoundingClientRect().bottom)
    growServiceViewport();await drain()
    expect(f.scroller.scrollTop).toBe(20);expect(f.border.getBoundingClientRect().top).toBe(72);expect(f.heading.getBoundingClientRect().bottom).toBe(72)
    growServiceViewport(300);await drain();expect(f.scroller.scrollTop).toBe(20)
    expect(document.querySelector('input[type="search"]')).toBe(f.input);expect(document.querySelector('[data-service-picker]')).toBe(picker)
    expect(f.input.value).toBe('micro');expect(document.activeElement).toBe(f.input);expect(noticeFocus).toHaveBeenCalledTimes(f.focusCalls);expect(hostScroll).not.toHaveBeenCalled()
  })
  it('仅剩2px可回退时按真实容器clamp到0，至少保留完整搜索border且不滚宿主',async()=>{
    const f=await focusedServiceSearchAtCompact(2,72);growServiceViewport();await drain()
    expect(f.scroller.scrollTop).toBe(0);expect(f.border.getBoundingClientRect().top).toBe(f.heading.getBoundingClientRect().bottom)
    // border与header紧邻，focus ring不作为可通过滚动分离的边界。
    expect(f.border.getBoundingClientRect().top-2).toBeLessThan(f.heading.getBoundingClientRect().bottom)
    expect(f.input.value).toBe('micro');expect(document.activeElement).toBe(f.input);expect(noticeFocus).toHaveBeenCalledTimes(f.focusCalls)
  })
  it('视口同高或缩小时不重置滚动，普通高度扩大也只在搜索确被标题遮住时修正',async()=>{
    const f=await focusedServiceSearchAtCompact();growServiceViewport(80);await drain();expect(f.scroller.scrollTop).toBe(22)
    growServiceViewport(58);await drain();expect(f.scroller.scrollTop).toBe(22)
    f.border.getBoundingClientRect=()=>({top:100,bottom:148,left:20,right:284,width:264,height:48}) as DOMRect
    growServiceViewport();await drain();expect(f.scroller.scrollTop).toBe(22)
    f.border.getBoundingClientRect=()=>({top:92-f.scroller.scrollTop,bottom:140-f.scroller.scrollTop,left:20,right:284,width:264,height:48}) as DOMRect
    growServiceViewport(300);await drain();expect(f.scroller.scrollTop).toBe(20);expect(noticeFocus).toHaveBeenCalledTimes(f.focusCalls)
  })
  it('键盘恢复后的异步修正不能抢回用户已移走的焦点或重置未聚焦长列表',async()=>{
    const f=await focusedServiceSearchAtCompact(),outside=document.createElement('button');document.body.appendChild(outside)
    // 非 renderer 创建的节点也接入既有焦点端口，Linkedom 的原生 focus 本身不更新 activeElement。
    outside.focus=()=>{focused=outside}
    growServiceViewport();outside.focus();await drain();expect(f.scroller.scrollTop).toBe(22);expect(document.activeElement).toBe(outside)
    growServiceViewport(300);await drain();expect(f.scroller.scrollTop).toBe(22);expect(document.activeElement).toBe(outside)
  })
  it.each(['close','back','config','unmount'] as const)('%s使已排队的恢复修正失效，不触碰旧搜索滚动',async reason=>{
    const f=await focusedServiceSearchAtCompact();growServiceViewport()
    if(reason==='close')eventOf(document.querySelector('.service-panel-close')!)()
    else if(reason==='back')eventOf(document.querySelector('.service-picker-back')!)()
    else if(reason==='config')state.config={...state.config,service:'microsoft'}
    else app.unmount()
    // Back 自己的合法视图转场会重置到0；先记下转场完成的所属滚动值，再确保迟到恢复不追加位移。
    const afterAction=f.scroller.scrollTop;await drain();expect(f.scroller.scrollTop).toBe(afterAction)
  })

  it('真实服务搜索在键盘 viewport 变化时保留输入，清除、返回与关闭仍属当前抽屉',async()=>{
    executeServicePicker=true;await mount();eventOf(document.querySelector('.provider-summary')!)()
    for(let i=0;i<100&&!document.querySelector('[data-feature-service="default"]');i++){await drain();await new Promise(resolve=>setTimeout(resolve,2))}
    const assignment=document.querySelector<HTMLElement>('[data-feature-service="default"]')!;expect(assignment).not.toBeNull();assignment.focus();eventOf(assignment)();await drain()
    const input=document.querySelector<HTMLInputElement>('input[type="search"]')!;expect(input).not.toBeNull();input.value='micro';eventOf(input,'onInput')({target:input});await drain()
    expect(document.querySelector('[data-service-choice="microsoft"]')).not.toBeNull()
    Object.assign(viewport,{height:220,offsetTop:40});viewport.dispatchEvent(new win.Event('resize'));viewport.dispatchEvent(new win.Event('scroll'));flushViewport();await drain()
    expect(document.querySelector('input[type="search"]')).toBe(input);expect(input.value).toBe('micro')
    const overlay=document.querySelector<HTMLElement>('.popup-drawer-modal')!;expect(overlay.style.getPropertyValue('--fluent-read-drawer-height')).toBe('220px')
    const picker=document.querySelector('[data-service-picker]'),focusCalls=noticeFocus.mock.calls.length
    Object.assign(viewport,{width:592,height:80,offsetTop:0});viewport.dispatchEvent(new win.Event('resize'));flushViewport();await drain()
    expect(overlay.hasAttribute('data-fluent-read-popup-short')).toBe(true)
    expect(document.querySelector('[data-service-picker]')).toBe(picker);expect(document.querySelector('input[type="search"]')).toBe(input);expect(input.value).toBe('micro')
    expect(noticeFocus).toHaveBeenCalledTimes(focusCalls)
    Object.assign(viewport,{width:360,height:263});viewport.dispatchEvent(new win.Event('resize'));flushViewport();await drain()
    expect(overlay.hasAttribute('data-fluent-read-popup-short')).toBe(false);expect(input.value).toBe('micro');expect(noticeFocus).toHaveBeenCalledTimes(focusCalls)
    eventOf(document.querySelector('.service-picker-search button')!)();await drain();expect(input.value).toBe('');expect(focused).toBe(input)
    eventOf(document.querySelector('.service-picker-back')!)();await drain();expect(document.querySelector('[data-service-picker]')).toBeNull()
    const current=document.querySelector<HTMLElement>('[data-feature-service="default"]')!;current.focus();eventOf(current)();await drain()
    Object.assign(viewport,{height:80});viewport.dispatchEvent(new win.Event('resize'));flushViewport();expect(overlay.hasAttribute('data-fluent-read-popup-short')).toBe(true)
    eventOf(document.querySelector('.service-panel-close')!)();await drain();expect(state.drawerVisible).toBe(false);expect(overlay.hasAttribute('data-fluent-read-popup-viewport')).toBe(false);expect(overlay.hasAttribute('data-fluent-read-popup-short')).toBe(false)
  })
  it('只在打开的实际 teleport 遮罩跟随键盘可见边界，根 popup 固有尺寸不变',async()=>{
    await mount();const rootStyle=document.documentElement.getAttribute('style'),bodyStyle=document.body.getAttribute('style'),add=vi.spyOn(viewport,'addEventListener'),remove=vi.spyOn(viewport,'removeEventListener')
    expect(document.querySelector('.popup-drawer-modal')).toBeNull();expect(add).not.toHaveBeenCalled()
    await openFeature('hover');const overlay=document.querySelector<HTMLElement>('body > .popup-drawer-modal')!
    expect(overlay).not.toBeNull();expect(overlay.hasAttribute('data-fluent-read-popup-viewport')).toBe(true)
    expect(overlay.style.getPropertyValue('--fluent-read-drawer-height')).toBe('600px');expect(add).toHaveBeenCalledTimes(2)
    Object.assign(viewport,{width:300,height:220,offsetLeft:10,offsetTop:45});viewport.dispatchEvent(new win.Event('resize'));viewport.dispatchEvent(new win.Event('scroll'))
    expect(viewportFrames.size).toBe(1);flushViewport()
    expect(overlay.style.getPropertyValue('--fluent-read-drawer-left')).toBe('10px');expect(overlay.style.getPropertyValue('--fluent-read-drawer-top')).toBe('45px')
    expect(overlay.style.getPropertyValue('--fluent-read-drawer-width')).toBe('300px');expect(overlay.style.getPropertyValue('--fluent-read-drawer-height')).toBe('220px')
    expect(document.documentElement.getAttribute('style')).toBe(rootStyle);expect(document.body.getAttribute('style')).toBe(bodyStyle)
    viewport.dispatchEvent(new win.Event('resize'));expect(viewportFrames.size).toBe(1);eventOf(document.querySelector('.drawer-header > button')!)();await drain()
    expect(remove).toHaveBeenCalledTimes(2);expect(viewportFrames.size).toBe(0);expect(overlay.hasAttribute('data-fluent-read-popup-viewport')).toBe(false)
    viewport.dispatchEvent(new win.Event('resize'));expect(viewportFrames.size).toBe(0)
  })
  it.each(['cached','pagehide','unmount'] as const)('%s 释放抽屉 viewport 订阅与已排队帧，旧遮罩不能回写',async reason=>{
    await mount();await openFeature('selection');const overlay=document.querySelector<HTMLElement>('.popup-drawer-modal')!,remove=vi.spyOn(viewport,'removeEventListener')
    viewport.dispatchEvent(new win.Event('scroll'));const queued=[...viewportFrames.values()];expect(queued).toHaveLength(1)
    if(reason==='cached')shown.value=false;else if(reason==='pagehide')win.dispatchEvent(new win.Event('pagehide'));else app.unmount()
    await drain();expect(remove).toHaveBeenCalledTimes(2);expect(viewportFrames.size).toBe(0)
    Object.assign(viewport,{height:100});queued.forEach(callback=>callback(0));expect(overlay.hasAttribute('data-fluent-read-popup-viewport')).toBe(false)
    if(reason==='cached'){shown.value=true;await drain();expect(state.drawerVisible).toBe(false);await openFeature('selection');expect(document.querySelector<HTMLElement>('.popup-drawer-modal')!.style.getPropertyValue('--fluent-read-drawer-height')).toBe('100px')}
  })
  it('缺少 VisualViewport 时用布局边界打开抽屉，恢复页面事件可更新且关闭释放',async()=>{
    win.visualViewport=undefined;await mount();await openFeature('hover');const overlay=document.querySelector<HTMLElement>('.popup-drawer-modal')!
    expect(overlay.style.getPropertyValue('--fluent-read-drawer-width')).toBe('320px');expect(overlay.style.getPropertyValue('--fluent-read-drawer-height')).toBe('600px')
    win.innerHeight=250;win.dispatchEvent(new win.Event('pageshow'));flushViewport();expect(overlay.style.getPropertyValue('--fluent-read-drawer-height')).toBe('250px')
    eventOf(document.querySelector('.drawer-header > button')!)();await drain();win.dispatchEvent(new win.Event('resize'));expect(viewportFrames.size).toBe(0)
  })
  async function safariFree(granted: string[] = []) {
    config.service='freeTranslation';config.freeTranslationOrder=['microsoft','google'];(globalThis as any).__popupFixture.capabilities.browser='safari'
    readAccess.mockResolvedValue({supported:true,grantedIds:granted,preferredGrant:{id:'microsoft',origins:['https://edge.microsoft.com/*']}})
    await mount();await drain()
  }
  it('Safari授权是新译click的同步首个副作用，仅一次单线路请求；完整复核后才发页面动作',async()=>{
    await safariFree();const gate=deferred<boolean>();requestAccess.mockReturnValue(gate.promise)
    const queries=getTab.mock.calls.length,reads=readAccess.mock.calls.length,order=[...state.config.freeTranslationOrder]
    const pending=eventOf(button('page-translation'))()
    expect(requestAccess).toHaveBeenCalledWith('microsoft');expect(getTab).toHaveBeenCalledTimes(queries);expect(readAccess).toHaveBeenCalledTimes(reads);expect(commands()).toHaveLength(0)
    eventOf(button('section-translation'))();expect(requestAccess).toHaveBeenCalledTimes(1)
    readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:{id:'google',origins:[]}});gate.resolve(true);await pending;await drain()
    expect(commands().map(call=>call[1].action)).toEqual(['fullPage']);expect(state.config.freeTranslationOrder).toEqual(order)
    readAccess.mockClear();requestAccess.mockClear();await eventOf(button('page-translation'))();expect(commands().at(-1)![1].action).toBe('restore');expect(readAccess).not.toHaveBeenCalled();expect(requestAccess).not.toHaveBeenCalled()
  })
  it.each(['denied','partial','throws','rejects'] as const)('Safari授权%s不继续、不尝试第二线路，保留配置顺序',async result=>{
    await safariFree();const before=JSON.stringify(state.config.freeTranslationOrder)
    requestAccess.mockImplementation(()=>{if(result==='throws')throw Error('fixture');if(result==='rejects')return Promise.reject(Error('fixture'));return Promise.resolve(result!=='denied')})
    await eventOf(button('page-translation'))();await drain();expect(commands()).toHaveLength(0);expect(requestAccess).toHaveBeenCalledWith('microsoft');expect(JSON.stringify(state.config.freeTranslationOrder)).toBe(before)
    expect(state.freePoolBusy).toBe(false);expect(state.freePoolError||state.notice).toMatch(/safari\.freePool\.(?:error|requestDenied)/)
    if(result==='denied'||result==='partial')expect(document.querySelector('[data-testid="safari-free-pool"]')?.textContent).toContain('safari.freePool.requestDenied')
  })
  it.each(['language','service','tab','cached','unmount'] as const)('Safari授权等待期间%s失效，迟到许可不能翻译',async reason=>{
    await safariFree();const gate=deferred<boolean>();requestAccess.mockReturnValue(gate.promise);const pending=eventOf(button('page-translation'))()
    if(reason==='language')state.config.to='ja'
    if(reason==='service')state.config.service='microsoft'
    if(reason==='tab'){getTab.mockResolvedValue([{id:8,windowId:3,url:'https://example.net/b'}]);tabEvent('onActivated',{tabId:8,windowId:3})}
    if(reason==='cached')shown.value=false
    if(reason==='unmount')app.unmount()
    await drain();gate.resolve(true);await pending;await drain();expect(commands()).toHaveLength(0)
  })
  it('Safari权限读取异常明确反馈且不request；已授权与Chrome固定服务不请求权限',async()=>{
    config.service='freeTranslation';(globalThis as any).__popupFixture.capabilities.browser='safari';readAccess.mockRejectedValue(Error('API unavailable'));await mount();await drain()
    expect(document.querySelector('[data-testid="safari-free-pool"]')?.textContent).toContain('safari.freePool.error');await eventOf(button('page-translation'))();expect(requestAccess).not.toHaveBeenCalled();expect(commands()).toHaveLength(0)
    state.config.service='google';await drain();await eventOf(button('page-translation'))();expect(commands()).toHaveLength(1);expect(requestAccess).not.toHaveBeenCalled()
  })
  it.each([false,true])('Safari诊断重试先同步授权并保留root恢复再译语义：已有译文=%s',async translated=>{
    await safariFree();runtimeEvent({type:'fullPageTranslationState',isTranslated:translated,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'configuration'}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain();
    await openDiagnosticDetails();
    const gate=deferred<boolean>();requestAccess.mockImplementation(()=>{permissionEvent('added');return gate.promise});
    const retry=[...document.querySelectorAll('.diagnostic-actions button')].find(node=>node.textContent==='重试')!;const pending=eventOf(retry)();
    expect(requestAccess).toHaveBeenCalledWith('microsoft');expect(commands()).toHaveLength(0);
    readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null});gate.resolve(true);await pending;await drain();
    expect(commands().map(call=>call[1].action)).toEqual(translated?['restore','fullPage']:['fullPage']);
  })
  it('Safari诊断已授权重试的来源等待同样可被撤权取消',async()=>{
    await safariFree(['microsoft']);runtimeEvent({type:'fullPageTranslationState',isTranslated:false,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'configuration'}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain();
    await openDiagnosticDetails();
    const gate=deferred<any>();getTab.mockReturnValue(gate.promise);const retry=[...document.querySelectorAll('.diagnostic-actions button')].find(node=>node.textContent==='重试')!;const pending=eventOf(retry)();await drain();
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');gate.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain();expect(commands()).toHaveLength(0);
  })
  it('P2 mounted revoke refreshes actual access and permits explicit reauthorization',async()=>{
    await safariFree(['microsoft']);expect(state.freePoolAccess.grantedIds).toEqual(['microsoft'])
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}})
    permissionEvent('removed');await drain();expect(state.freePoolAccess.grantedIds).toEqual([])
    expect(document.querySelector('[data-testid="safari-free-pool"]')?.textContent).toContain('safari.freePool.needsAccess')
    requestAccess.mockResolvedValue(false);await eventOf(button('page-translation'))();expect(requestAccess).toHaveBeenCalledTimes(1);expect(commands()).toHaveLength(0)
  })
  it('P2 external grant refreshes available set without auto translation',async()=>{
    await safariFree();readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null})
    permissionEvent('added');await drain();expect(state.freePoolAccess.grantedIds).toEqual(['microsoft']);expect(commands()).toHaveLength(0);expect(requestAccess).not.toHaveBeenCalled()
  })
  it('P2 own synchronous added and focus retain the first click then translate exactly once',async()=>{
    await safariFree();const gate=deferred<boolean>()
    requestAccess.mockImplementation(()=>{permissionEvent('added');win.dispatchEvent(new win.Event('focus'));return gate.promise})
    const before=readAccess.mock.calls.length,pending=eventOf(button('page-translation'))()
    expect(requestAccess).toHaveBeenCalledTimes(1);expect(readAccess).toHaveBeenCalledTimes(before);expect(commands()).toHaveLength(0)
    readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null});gate.resolve(true);await pending;await drain()
    expect(commands().map(call=>call[1].action)).toEqual(['fullPage']);expect(state.freePoolBusy).toBe(false)
  })
  it('P2 removal during grant discards late granted result and retains explicit retry',async()=>{
    await safariFree();const gate=deferred<boolean>();requestAccess.mockReturnValue(gate.promise)
    const pending=eventOf(button('page-translation'))();permissionEvent('removed');await drain();readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null});gate.resolve(true);await pending;await drain()
    expect(commands()).toHaveLength(0);expect(state.freePoolAccess.grantedIds).toEqual([]);expect(state.freePoolBusy).toBe(false)
  })
  it('P2 removal after grant while source-tab lookup waits cancels the continuation',async()=>{
    await safariFree();const tab=deferred<any>();getTab.mockReturnValue(tab.promise);requestAccess.mockResolvedValue(true);readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null})
    const pending=eventOf(button('page-translation'))();await drain();expect(state.freePoolBusy).toBe(true);expect(commands()).toHaveLength(0)
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');await drain();tab.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain();expect(commands()).toHaveLength(0)
  })
  it('P2 already granted translation waiting for source tab is invalidated by removal',async()=>{
    await safariFree(['microsoft']);const tab=deferred<any>();getTab.mockReturnValue(tab.promise)
    const pending=eventOf(button('page-translation'))();await drain();expect(commands()).toHaveLength(0);expect(requestAccess).not.toHaveBeenCalled()
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');await drain();tab.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain();expect(commands()).toHaveLength(0)
  })
  it('P2 already granted section on translated page is invalidated by removal',async()=>{
    await safariFree(['microsoft']);state.pageState.translated=true;await drain();const tab=deferred<any>();getTab.mockReturnValue(tab.promise)
    const pending=eventOf(button('section-translation'))();await drain();expect(commands()).toHaveLength(0)
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');await drain();tab.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain();expect(commands()).toHaveLength(0)
  })
  it('P2 removal does not cancel pending restore-original action',async()=>{
    await safariFree(['microsoft']);state.pageState.translated=true;await drain();const tab=deferred<any>();getTab.mockReturnValue(tab.promise)
    const pending=eventOf(button('page-translation'))();await drain();permissionEvent('removed');await drain();tab.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain()
    expect(commands().map(call=>call[1].action)).toEqual(['restore']);expect(requestAccess).not.toHaveBeenCalled()
  })
  it('P2 removal does not cancel a different service pending page action',async()=>{
    await safariFree(['microsoft']);state.config.service='google';await drain();const tab=deferred<any>();getTab.mockReturnValue(tab.promise)
    const pending=eventOf(button('page-translation'))();await drain();permissionEvent('removed');await drain();tab.resolve([{id:7,windowId:3,url:'https://example.com/a'}]);await pending;await drain()
    expect(commands().map(call=>call[1].action)).toEqual(['fullPage']);expect(requestAccess).not.toHaveBeenCalled()
  })
  it('P2 removed invalidates an older access read',async()=>{
    const gate=deferred<any>();config.service='freeTranslation';config.freeTranslationOrder=['microsoft'];(globalThis as any).__popupFixture.capabilities.browser='safari';readAccess.mockReturnValueOnce(gate.promise)
    await mount();readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');await drain()
    gate.resolve({supported:true,grantedIds:['microsoft'],preferredGrant:null});await drain();expect(state.freePoolAccess.grantedIds).toEqual([])
  })
  it('P2 native event absence still refreshes on focus and visible return',async()=>{
    await safariFree(['microsoft']);readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}})
    win.dispatchEvent(new win.Event('focus'));await drain();expect(state.freePoolAccess.grantedIds).toEqual([])
    readAccess.mockResolvedValue({supported:true,grantedIds:['microsoft'],preferredGrant:null});Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new win.Event('visibilitychange'));await drain();expect(state.freePoolAccess.grantedIds).toEqual(['microsoft'])
  })
  it('P2 cached inactive popup rechecks on reactivation and releases event listener on close',async()=>{
    await safariFree(['microsoft']);shown.value=false;await drain();const before=readAccess.mock.calls.length
    readAccess.mockResolvedValue({supported:true,grantedIds:[],preferredGrant:{id:'microsoft',origins:[]}});permissionEvent('removed');await drain();expect(readAccess).toHaveBeenCalledTimes(before)
    shown.value=true;await drain();expect(state.freePoolAccess.grantedIds).toEqual([]);app.unmount();await drain();expect(permissionEvents.size).toBe(0)
    const closed=readAccess.mock.calls.length;permissionEvent('added');win.dispatchEvent(new win.Event('focus'));expect(readAccess).toHaveBeenCalledTimes(closed)
  })
  it('P2 denial updates after language switch and delayed lazy bundle without another request',async()=>{
    localized=true;await safariFree();requestAccess.mockResolvedValue(false);await eventOf(button('page-translation'))();await drain()
    expect(state.freePoolStatus).toBe(catalogs['zh-CN']['safari.freePool.requestDenied']);const reads=readAccess.mock.calls.length
    locale.value='en-US';await drain();englishLoaded=true;bundleRevision.value++;await drain()
    expect(state.freePoolStatus).toBe(catalogs['en-US']['safari.freePool.requestDenied']);expect(readAccess).toHaveBeenCalledTimes(reads);expect(requestAccess).toHaveBeenCalledTimes(1)
  })
  it('Popup 来源解析接受零和安全整数，无参数继续查询活动网页',async()=>{
    const query=vi.fn(async()=>[{id:99}]),get=vi.fn(async(id:number)=>({id}));const normal=createPopupTabSource('?other=1',{query,get})
    expect(normal).toMatchObject({fixed:false,sourceTabId:null});await expect(normal.getTab()).resolves.toEqual({id:99});query.mockResolvedValueOnce([]);await expect(normal.getTab()).resolves.toBeUndefined()
    for(const id of [0,7,Number.MAX_SAFE_INTEGER]){const source=createPopupTabSource(`?sourceTabId=${id}`,{query,get});expect(source).toMatchObject({fixed:true,sourceTabId:id});await expect(source.getTab()).resolves.toEqual({id})}
    expect(query).toHaveBeenCalledTimes(2)
  })
  it('后台授权来源覆盖查询参数并固定操作网页',async()=>{
    const query=vi.fn(async()=>[{id:99}]),get=vi.fn(async(id:number)=>({id}));const source=createPopupTabSource('?sourceTabId=99',{query,get},7)
    expect(source).toMatchObject({fixed:true,sourceTabId:7});await expect(source.getTab()).resolves.toEqual({id:7});expect(query).not.toHaveBeenCalled()
  })
  it('错误或重复的来源参数与失效来源不回退到活动网页',async()=>{
    const query=vi.fn(async()=>[{id:99}]),get=vi.fn(async(_id:number)=>({id:7}));for(const search of ['?sourceTabId=','?sourceTabId=-1','?sourceTabId=1.5','?sourceTabId=Infinity','?sourceTabId=NaN','?sourceTabId=00','?sourceTabId=9007199254740992','?sourceTabId=7&sourceTabId=8']){const source=createPopupTabSource(search,{query,get});expect(source).toMatchObject({fixed:true,sourceTabId:null});await expect(source.getTab()).rejects.toThrow('无效的 Popup 来源标签页')}
    expect(get).not.toHaveBeenCalled();get.mockRejectedValueOnce(new Error('closed source'));await expect(createPopupTabSource('?sourceTabId=7',{query,get}).getTab()).rejects.toThrow('closed source');expect(query).not.toHaveBeenCalled()
  })
  it('固定来源面板固定来源网页，翻译/恢复不受其它窗口或活动标签页影响',async()=>{
    win.location.search='?sourceTabId=7';getTab.mockResolvedValue([{id:99,windowId:10,url:'extension://popup.html'}]);await mount()
    expect(state.currentSiteDomain).toBe('example.com');expect(getTab).not.toHaveBeenCalled();expect(getSourceTab).toHaveBeenCalledWith(7)
    const reads=getSourceTab.mock.calls.length;tabEvent('onActivated',{tabId:8,windowId:3});tabEvent('onActivated',{tabId:99,windowId:10});tabEvent('onUpdated',8,{status:'loading'},{id:8,windowId:3,active:true});tabEvent('onRemoved',8);await drain();expect(getSourceTab).toHaveBeenCalledTimes(reads)
    await eventOf(button('page-translation'))();await drain();await eventOf(button('page-translation'))();await drain()
    expect(commands().map(call=>[call[0],call[1].action])).toEqual([[7,'fullPage'],[7,'restore']]);expect(getTab).not.toHaveBeenCalled()
    getSourceTab.mockResolvedValue({id:7,windowId:4,url:'https://example.net/b'});tabEvent('onUpdated',7,{url:'https://example.net/b'},{id:7,windowId:4,active:false});await drain();expect(state.currentSiteDomain).toBe('example.net')
  })
  it('固定来源面板文档入口读取来源 PDF，源网页关闭后不切换到其它网页',async()=>{
    win.location.search='?sourceTabId=7';getSourceTab.mockResolvedValue({id:7,windowId:3,url:'https://example.com/paper.pdf'});await mount()
    await eventOf(document.querySelector('[data-feature="document-translation"]')!)();expect(createTab).toHaveBeenCalledWith({url:'extension://document.html#pdf=https%3A%2F%2Fexample.com%2Fpaper.pdf'});expect(getTab).not.toHaveBeenCalled()
    createTab.mockClear();close.mockClear();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});getSourceTab.mockRejectedValue(new Error('source removed'));tabEvent('onRemoved',7);await drain();expect(state.currentTabId).toBeNull();expect(state.currentSiteDomain).toBe('')
    await eventOf(document.querySelector('[data-feature="document-translation"]')!)();expect(createTab).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(getTab).not.toHaveBeenCalled();warn.mockRestore()
  })
  it.each(['keywords','surprisal-local'] as const)('信息高亮 %s 偏好与旧入口配置不进入 Popup，也不启动页面或模型消息',async mode=>{
    config.informationHighlight.mode=mode;Object.assign(config.popupQuickFeatureVisibility,{highlight:true});(config.popupQuickFeatureOrder as string[]).push('highlight')
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});await mount()
    expect(document.querySelector('[data-popup-quick-feature="highlight"]')).toBeNull()
    expect(document.querySelector('[data-information-highlight-drawer]')).toBeNull()
    expect(state.visiblePopupQuickFeatureIds).not.toContain('highlight')
    await openFeature('hover');state.config.informationHighlight.mode=mode==='keywords'?'surprisal-local':'keywords';state.config.on=false;state.config.on=true
    getTab.mockResolvedValue([{id:8,windowId:3,url:'https://example.net/b'}]);tabEvent('onUpdated',7,{status:'loading'},{id:7,windowId:3,active:true});await drain()
    vi.advanceTimersByTime(10000);await drain()
    const messages=[...send.mock.calls.map(call=>call[1]),...runtimeSend.mock.calls.map(call=>call[0])]
    expect(messages.filter(message=>String(message?.type).includes('INFORMATION_HIGHLIGHT'))).toEqual([])
  })
  it('启动状态晚到不覆盖完成的翻译；原有站点规则也不让读取自行失效',async()=>{
    config.alwaysTranslateDomains=['example.com'];const old=deferred();send.mockImplementationOnce(()=>old.promise);await mount();await eventOf(button('page-translation'))();old.resolve({isTranslated:false});await drain();expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');expect(commands()).toHaveLength(1)
  })
  it('已有始终翻译站点仍接受真实启动状态，恢复按钮与页面一致',async()=>{
    config.alwaysTranslateDomains=['example.com'];send.mockResolvedValueOnce({isTranslated:true});await mount();expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');await eventOf(button('page-translation'))();expect(commands()[0][1].action).toBe('restore')
  })
  it('真实运行时结果仅接受当前扩展、顶层frame和当前文档，卸载后解除订阅',async()=>{
    await mount();expect(runtimeEvents.size).toBe(1)
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    const failure={type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'authentication',actions:['export'],titleKey:'PRIVATE',message:'PRIVATE body'}}
    for(const rejected of [
      {...sender,id:'other-extension'}, {...sender,frameId:1}, {...sender,tab:{id:8,url:sender.url}},
      {...sender,url:'https://example.com/old'}, {...sender,tab:{id:7,url:'https://example.com/old'}},
    ]){runtimeEvent(failure,rejected);await drain();expect(button('page-translation').getAttribute('aria-pressed')).toBe('false');expect(document.querySelector('.fluentread-diagnostic')).toBeNull()}
    runtimeEvent({...failure,type:'other-state'},sender);await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull()
    runtimeEvent({...failure,documentToken:'old-document-at-same-url'},sender);await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull()
    runtimeEvent({...failure,documentToken:undefined},sender);await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull()
    runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'translated',documentToken:'popup-fixture-document'},sender);await drain()
    expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');expect(document.querySelector('.first-use-hint')!.textContent).toContain('译文已显示')
    runtimeEvent(failure,sender);await drain()
    const diagnostic=document.querySelector('.fluentread-diagnostic')!;expect(diagnostic.getAttribute('data-diagnostic-code')).toBe('authentication');expect(diagnostic.textContent).toContain('服务验证失败');expect(diagnostic.textContent).not.toContain('PRIVATE');expectCollapsedDiagnostic()
    shown.value=false;await drain();runtimeEvent({type:'fullPageTranslationState',isTranslated:false,toolbarStatus:'idle',documentToken:'popup-fixture-document'},sender);expect(state.pageTranslated).toBe(true)
    app.unmount();expect(runtimeEvents.size).toBe(0)
  })
  it('实际诊断动作遇到设置、刷新和重试失败时保留可见的安全恢复入口',async()=>{
    await mount()
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    const publish=async(code:string)=>{runtimeEvent({type:'fullPageTranslationState',isTranslated:false,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code}},sender);await drain();expectCollapsedDiagnostic();await openDiagnosticDetails()}
    const action=(id:string)=>{const node=document.querySelector(`[data-diagnostic-action="${id}"]`);expect(node).not.toBeNull();return eventOf(node!)}
    await publish('authentication');createTab.mockRejectedValueOnce(Error('PRIVATE service tab error'));action('services')();await drain()
    expect(document.querySelector('.notice')!.getAttribute('role')).toBe('alert');expect(document.querySelector('.notice')!.textContent).toContain('无法打开设置');expect(document.querySelector('[data-diagnostic-code="authentication"]')).not.toBeNull();expect(close).not.toHaveBeenCalled()
    await publish('context-invalid');getTab.mockRejectedValueOnce(Error('PRIVATE query error'));action('refresh')();await drain()
    expect(document.querySelector('.notice')!.textContent).toContain('原网页已关闭');expect(document.querySelector('[data-diagnostic-code="context-invalid"]')).not.toBeNull();expect(reloadTab).not.toHaveBeenCalled()
    reloadTab.mockRejectedValueOnce(Error('PRIVATE reload error'));action('refresh')();await drain()
    expect(document.querySelector('.notice')!.textContent).toContain('无法刷新网页');expect(close).not.toHaveBeenCalled()
    await publish('timeout');send.mockRejectedValueOnce(Error('Failed to fetch PRIVATE provider body'));action('retry')();await drain()
    expect(document.querySelector('[data-diagnostic-code="network"]')).not.toBeNull();expect(document.querySelector('.fluentread-diagnostic')!.textContent).toContain('服务连接失败');expect(document.body.textContent).not.toContain('PRIVATE');expect(button('page-translation').hasAttribute('disabled')).toBe(false)
    expectCollapsedDiagnostic();await openDiagnosticDetails();eventOf(document.querySelector('[data-diagnostic-dismiss]')!)();await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull();expect(focused).toBe(button('page-translation'))
  })
  it.each(['cached','pagehide','service','unmount'] as const)('打开的诊断浮层在%s上下文失效时卸载并释放document/window监听',async reason=>{
    await mount();runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'authentication'}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain()
    const addDocument=vi.spyOn(document,'addEventListener'),removeDocument=vi.spyOn(document,'removeEventListener')
    // Linkedom通过window代理提供事件方法，属性描述符不存在；包住真实端口而非spyOn不存在的描述符。
    const addWindow=vi.fn(win.addEventListener.bind(win)),removeWindow=vi.fn(win.removeEventListener.bind(win))
    win.addEventListener=addWindow;win.removeEventListener=removeWindow
    await openDiagnosticDetails();await eventOf(document.querySelector('[data-diagnostic-preview]')!)();await drain()
    const documentOwners=addDocument.mock.calls.filter(call=>['pointerdown','focusin','scroll'].includes(call[0] as string)),windowOwners=addWindow.mock.calls.filter(call=>call[0]==='resize')
    expect(documentOwners).toHaveLength(3);expect(windowOwners).toHaveLength(1);expect(document.querySelector('.diagnostic-report')).not.toBeNull()
    if(reason==='cached')shown.value=false
    if(reason==='pagehide')win.dispatchEvent(new win.Event('pagehide'))
    if(reason==='service')state.config.service='openai'
    if(reason==='unmount')app.unmount()
    await drain();expect(document.querySelector('[data-diagnostic-details]')).toBeNull();expect(document.querySelector('.diagnostic-report')).toBeNull()
    for(const [type,listener]of documentOwners)expect(removeDocument).toHaveBeenCalledWith(type,listener,true)
    for(const [type,listener]of windowOwners)expect(removeWindow).toHaveBeenCalledWith(type,listener)
    if(reason==='cached'){shown.value=true;await drain();expect(document.querySelector('[data-diagnostic-details]')).toBeNull()}
  })
  it('权威计数同步保留真实鉴权诊断与报告预览，并继续允许打开当前服务设置',async()=>{
    await mount()
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'authentication'}},sender);await drain()
    await openDiagnosticDetails();const previewButton=document.querySelector('[data-diagnostic-preview]')!
    eventOf(previewButton)();await drain()
    const preview=document.querySelector('.diagnostic-report pre')!,before=preview.textContent
    expect(before).toContain('authentication');expect(document.querySelector('[data-diagnostic-code="authentication"]')).not.toBeNull()
    subscribe(normalizeConfig({...config,count:config.count+1}));await drain()
    expect(state.config.count).toBe(config.count+1)
    expect(document.querySelector('[data-diagnostic-code="authentication"]')).not.toBeNull()
    expect(document.querySelector('.diagnostic-report pre')).toBe(preview);expect(document.querySelector('.diagnostic-report pre')!.textContent).toBe(before)
    const repair=document.querySelector('[data-diagnostic-primary][data-diagnostic-action="services"]')!
    eventOf(repair)();await drain()
    expect(createTab).toHaveBeenCalledWith({url:expect.stringContaining('options.html?service=google')});expect(close).toHaveBeenCalledOnce()
  })
  it('无正文诊断直达适配目标并携带固定来源，普通导航不附加来源且服务参数不丢失',async()=>{
    win.location.search='?sourceTabId=7';getTab.mockResolvedValue([{id:99,url:'https://other.example/'}]);await mount()
    runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'no-content'}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain()
    expectCollapsedDiagnostic();await openDiagnosticDetails();const inspect=document.querySelector('[data-diagnostic-primary][data-diagnostic-action="site-settings"]')!;await eventOf(inspect)();await drain()
    let url=new URL(createTab.mock.calls.at(-1)![0].url);expect(url.hash).toBe('#settings-sites');expect(url.searchParams.get('target')).toBe('adaptation');expect(url.searchParams.get('returnTabId')).toBe('7');expect(url.searchParams.has('service')).toBe(false);expect(getTab).not.toHaveBeenCalled()
    createTab.mockClear();await state.openOptions('settings-sites','adaptation');url=new URL(createTab.mock.calls[0][0].url);expect(url.searchParams.get('target')).toBe('adaptation');expect(url.searchParams.has('returnTabId')).toBe(false)
    createTab.mockClear();await state.openOptions('settings-services','connections','openai');url=new URL(createTab.mock.calls[0][0].url);expect(url.searchParams.get('service')).toBe('openai');expect(url.searchParams.get('target')).toBe('connections');expect(url.searchParams.get('returnTabId')).toBe('7')
  })
  it.each(['nested','hidden','independent'] as const)('诊断状态入口在%s网站模块布局下仍唯一归属翻译区，保留既有模块顺序',async layout=>{
    if(layout==='hidden')config.interfaceVisibility.popupSiteRule=false
    if(layout==='independent')config.popupModuleOrder=['siteRule','translation','quickFeatures','footer']
    await mount();runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'authentication'}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain()
    const translation=document.querySelector('[data-popup-module="translation"]')!,meta=translation.querySelector('.translation-meta')!,notice=document.querySelector('.fluentread-diagnostic')!
    expect(document.querySelectorAll('.fluentread-diagnostic')).toHaveLength(1);expect(notice.parentElement).toBe(meta);expect(notice.closest('[data-popup-module="translation"]')).toBe(translation);expectCollapsedDiagnostic()
    expect(translation.querySelectorAll('[data-diagnostic-details-toggle]')).toHaveLength(1)
    const site=document.querySelector('[data-popup-module="siteRule"]')
    if(layout==='nested'){expect(site?.parentElement).toBe(meta);expect(site?.nextElementSibling).toBe(notice)}
    else if(layout==='hidden')expect(site).toBeNull()
    else {expect(site).not.toBeNull();expect(site!.closest('[data-popup-module="translation"]')).toBeNull();expect(meta.querySelector('[data-popup-module="siteRule"]')).toBeNull()}
    const expected=config.popupModuleOrder.filter(id=>layout!=='hidden'||id!=='siteRule')
    expect([...document.querySelectorAll('[data-popup-module]')].map(el=>el.getAttribute('data-popup-module'))).toEqual(expected)
    expect(document.querySelector('.popup-shell')!.getAttribute('data-popup-module-order')).toBe(config.popupModuleOrder.join(','))
  })
  it.each(['authentication','model-configuration','configuration'])('%s修复后明确重试恢复旧会话再翻译，不改变主按钮正常恢复语义',async code=>{
    await mount();runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code}},{id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0});await drain()
    expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');expect(commands()).toHaveLength(0)
    await openDiagnosticDetails();const retry=document.querySelector('.diagnostic-actions [data-diagnostic-action="retry"]')!;await eventOf(retry)();await drain()
    expect(commands().map(call=>[call[0],call[1].action])).toEqual([[7,'restore'],[7,'fullPage']]);expect(button('page-translation').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.fluentread-diagnostic')).toBeNull();await eventOf(button('page-translation'))();await drain();expect(commands().at(-1)![1].action).toBe('restore')
  })
  it('首次使用、翻译中和真实完成提示在实际模板中跟随七种界面语言切换',async()=>{
    await mount()
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    for(const locale of ['zh-CN','en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES']){
      state.config.uiLanguage=locale;await drain()
      for(const [toolbarStatus,key]of [['idle','first-use-start'],['translating','first-use-translating'],['translated','first-use-ready']]as const){
        runtimeEvent({type:'fullPageTranslationState',isTranslated:toolbarStatus!=='idle',toolbarStatus,documentToken:'popup-fixture-document'},sender);await drain()
        expect(document.querySelector('.first-use-hint')!.textContent).toBe(getDiagnosticUiText(key,locale))
      }
    }
  })
  it.each(['service','key','endpoint'] as const)('真实%s配置变更使旧诊断和报告预览失效',async change=>{
    config.service='openai';config.apiKeys.openai=['fixture-key-before'];config.token.openai='fixture-key-before';await mount()
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'popup-fixture-document',diagnostic:{code:'authentication'}},sender);await drain()
    await openDiagnosticDetails();const preview=document.querySelector('[data-diagnostic-preview]')!
    eventOf(preview)();await drain();expect(document.querySelector('.diagnostic-report pre')).not.toBeNull()
    if(change==='service')state.config.service='bing'
    if(change==='key'){state.config.apiKeys.openai=['fixture-key-after'];state.config.token.openai='fixture-key-after'}
    if(change==='endpoint')state.config.proxy.openai='https://changed-endpoint.example/v1'
    await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull();expect(document.querySelector('.diagnostic-report pre')).toBeNull()
    expect(document.body.textContent).not.toMatch(/fixture-key-before|fixture-key-after|changed-endpoint/)
  })
  it.each([
    {surface:'toolbar',loading:'no-receiver'}, {surface:'toolbar',loading:'old-token'},
    {surface:'embedded',loading:'no-receiver'}, {surface:'embedded',loading:'old-token'},
  ])('$surface 同URL刷新在loading为$loading时通过complete重新握手接收新文档结果',async({surface,loading})=>{
    if(surface==='embedded')win.location.search='?sourceTabId=7'
    await mount()
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    if(loading==='no-receiver')send.mockRejectedValueOnce(Error('Could not establish connection. Receiving end does not exist.'))
    else send.mockResolvedValueOnce({status:'success',isTranslated:false,toolbarStatus:'idle',documentToken:'popup-fixture-document'})
    tabEvent('onUpdated',7,{status:'loading'},{id:7,windowId:3,active:true});await drain()
    const result={type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'error',documentToken:'refreshed-document',diagnostic:{code:'authentication'}}
    runtimeEvent(result,sender);await drain();expect(button('page-translation').getAttribute('aria-pressed')).toBe('false');expect(document.querySelector('.fluentread-diagnostic')).toBeNull()
    send.mockImplementation(async(_id,message)=>message.type==='getFullPageTranslationState'?{status:'success',isTranslated:false,toolbarStatus:'idle',documentToken:'refreshed-document'}:{status:'success',isTranslated:message.action==='fullPage',documentToken:'refreshed-document'})
    tabEvent('onUpdated',7,{status:'complete'},{id:7,windowId:3,active:true});await drain()
    runtimeEvent({...result,documentToken:'popup-fixture-document'},sender);await drain();expect(document.querySelector('.fluentread-diagnostic')).toBeNull()
    runtimeEvent(result,sender);await drain()
    expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');expect(document.querySelector('[data-diagnostic-code="authentication"]')).not.toBeNull();expect(commands()).toHaveLength(0)
    expect(send.mock.calls.filter(call=>call[1].type==='getFullPageTranslationState')).toHaveLength(5)
  })
  it('complete时接收端尚未就绪，未知新令牌广播只触发当前文档只读握手后显示真实结果',async()=>{
    win.location.search='?sourceTabId=7';await mount()
    for(const status of ['loading','complete']){send.mockRejectedValueOnce(Error('Receiving end does not exist'));tabEvent('onUpdated',7,{status},{id:7,windowId:3,active:true});await drain()}
    const snapshot={status:'success',isTranslated:true,toolbarStatus:'translated',documentToken:'late-ready-document'}
    send.mockResolvedValueOnce(snapshot)
    const sender={id:'fixture-extension',url:'https://example.com/a',tab:{id:7,url:'https://example.com/a'},frameId:0}
    runtimeEvent({type:'fullPageTranslationState',isTranslated:true,toolbarStatus:'translating',documentToken:'late-ready-document'},sender);await drain()
    expect(button('page-translation').getAttribute('aria-pressed')).toBe('true');expect(document.querySelector('.first-use-hint')!.textContent).toContain('译文已显示')
    expect(commands()).toHaveLength(0);expect(send).toHaveBeenLastCalledWith(7,{type:'getFullPageTranslationState'},{frameId:0})
  })
  it('局部等待期间锁定实际按钮，连续旧事件只发送一次并只关闭一次',async()=>{
    await mount();const query=deferred<Array<{id:number;url:string}>>();getTab.mockReturnValueOnce(query.promise);const click=eventOf(button('section-translation')),pending=click();await click();await settle();expect(button('page-translation').hasAttribute('disabled')).toBe(true);query.resolve([{id:7,url:'https://example.com/a'}]);await pending;expect(commands()).toHaveLength(1);expect(close).toHaveBeenCalledOnce()
  })
  it.each(['off','site','hide','cached','unmount'])('%s 使等待查询的页面/局部操作失效，不发消息或关闭',async reason=>{
    await mount();const query=deferred<Array<{id:number;url:string}>>();getTab.mockReturnValueOnce(query.promise);const pending=eventOf(button('section-translation'))();if(reason==='off')state.config.on=false;if(reason==='site')state.config.disabledExtensionDomains=['example.com'];if(reason==='hide')win.dispatchEvent(new win.Event('pagehide'));if(reason==='cached')shown.value=false;if(reason==='unmount')app.unmount();await settle();query.resolve([{id:7,url:'https://example.com/a'}]);await pending;await settle();expect(commands()).toHaveLength(0);expect(close).not.toHaveBeenCalled()
  })
  it('旧翻译按钮在状态切换、再次恢复后仍不能借用新的意图',async()=>{
    await mount();const old=eventOf(button('page-translation'));await old();await settle();await old();expect(commands()).toHaveLength(1);await eventOf(button('page-translation'))();await settle();await old();expect(commands().map(call=>call[1].action)).toEqual(['fullPage','restore'])
  })
  it('活动标签页切换后不把旧页面的恢复操作发送给新页面',async()=>{
    send.mockResolvedValueOnce({isTranslated:true});await mount();getTab.mockResolvedValue([{id:8,url:'https://example.net/b'}]);send.mockResolvedValueOnce({isTranslated:false});await eventOf(button('page-translation'))();await drain();expect(commands()).toHaveLength(0);expect(state.currentSiteDomain).toBe('example.net');expect(button('page-translation').getAttribute('aria-pressed')).toBe('false')
  })
  it('子组件缓存的旧站点按钮不通过新 props 和新父回调修改新页面',async()=>{
    await mount();const old=eventOf(document.querySelector('[data-setting="disable-extension-site"]')!);getTab.mockResolvedValue([{id:8,url:'https://example.net/b'}]);await state.hydrateCurrentSite();await drain();old();await settle();expect(state.config.disabledExtensionDomains).toEqual([]);eventOf(document.querySelector('[data-setting="disable-extension-site"]')!)();await settle();expect(state.config.disabledExtensionDomains).toEqual(['example.net'])
  })
  it('禁用优先于始终/全局自动翻译，保留偏好并用提示说明网站范围',async()=>{
    config.alwaysTranslateDomains=['example.com'];config.autoTranslate=true;config.disabledExtensionDomains=['example.com'];await mount()
    const always=document.querySelector('[data-setting="always-translate-site"]')!,disabled=document.querySelector('[data-setting="disable-extension-site"]')!
    expect(always.getAttribute('aria-checked')).toBe('false');expect(always.textContent).toContain('自动翻译已暂停');expect(always.getAttribute('title')).toContain('恢复扩展后继续自动翻译');expect(always.getAttribute('aria-description')).toContain('子域名');expect(disabled.getAttribute('title')).toContain('禁用优先于自动翻译')
    eventOf(disabled)();await drain();expect(state.config.alwaysTranslateDomains).toEqual(['example.com']);expect(state.config.disabledExtensionDomains).toEqual([]);expect(document.querySelector('[data-setting="always-translate-site"]')!.getAttribute('aria-checked')).toBe('true')
  })
  it('禁用按钮可中断在途翻译，规则保存期间锁定两个开关并等待真实反馈',async()=>{
    await mount();const reply=deferred(),commit=deferred();send.mockReturnValueOnce(reply.promise);const pending=eventOf(button('page-translation'))();await drain()
    const disabled=document.querySelector('[data-setting="disable-extension-site"]')!;expect(disabled.hasAttribute('disabled')).toBe(false);patches.mockReturnValueOnce(commit.promise);eventOf(disabled)();await drain()
    expect(state.pageState.busy).toBe(false);expect(state.pageState.savingRule).toBe(true);expect(document.querySelectorAll('.site-rule-saving')).toHaveLength(2);expect(state.notice).toBe('');expect(patches).toHaveBeenCalledWith(expect.objectContaining({disabledExtensionDomains:['example.com']}))
    for(const element of document.querySelectorAll('.site-rule-button')) {expect(element.hasAttribute('disabled')).toBe(true);expect(element.getAttribute('aria-busy')).toBe('true')}
    reply.resolve({status:'success',isTranslated:true});await pending;await drain();expect(state.pageTranslated).toBe(false);commit.resolve(undefined);await drain()
    expect(state.pageState.savingRule).toBe(false);expect(state.notice).toBe('已在 example.com 禁用扩展');expect(document.querySelector('.notice')?.getAttribute('role')).toBe('status')
  })
  it('站点保存失败显示可访问错误并回读权威配置，不能声称保存或启动翻译',async()=>{
    await mount();const commit=deferred();patches.mockReturnValueOnce(commit.promise);eventOf(document.querySelector('[data-setting="always-translate-site"]')!)();await drain();expect(commands()).toHaveLength(0)
    // 配置服务失败时回读权威存储并订阅回滚，展示层只负责真实反馈。
    subscribe({...config,alwaysTranslateDomains:[]} as Config);commit.reject(Error('write failed'));await drain()
    expect(state.pageState.savingRule).toBe(false);expect(state.config.alwaysTranslateDomains).toEqual([]);expect(state.notice).toBe('未能保存 example.com 的网站设置，请重试');expect(document.querySelector('.notice')?.getAttribute('role')).toBe('alert');expect(commands()).toHaveLength(0)
  })
  it('站点保存保留同 tick 尚未由 post watcher 提交的其他用户草稿',async()=>{
    await mount();const {messages,records}=await attachPersistence()
    state.config.to='ja';state.config.nativeBatchTranslationEnabled.google=false;state.config.alwaysTranslateDomains=['example.com'];await state.persistSiteRulePatch({alwaysTranslateDomains:['example.com']});await drain()
    expect(messages).toHaveLength(1);expect(messages[0].config).toMatchObject({to:'ja',nativeBatchTranslationEnabled:{google:false},alwaysTranslateDomains:['example.com']})
    expect(records.get('local:config')).toMatchObject({to:'ja',nativeBatchTranslationEnabled:{google:false},alwaysTranslateDomains:['example.com']});expect(state.config.to).toBe('ja');expect(state.config.alwaysTranslateDomains).toEqual(['example.com'])
  })
  it('共享 store 同步捕获嵌套草稿，旧 ACK 不覆盖等待期间的新草稿',async()=>{
    await mount();const first=deferred<void>(),second=deferred<void>(),{messages,records}=await attachPersistence([first,second])
    const nestedDraft=state.config.nativeBatchTranslationEnabled
    state.config.to='ja';state.config.nativeBatchTranslationEnabled.google=false;state.config.alwaysTranslateDomains=['example.com'];const pending=state.persistSiteRulePatch({alwaysTranslateDomains:['example.com']})
    // 不等待微任务就修改同一个嵌套对象；生产 requestConfigPatch 必须已复制前一份字段值。
    nestedDraft.google=true;state.config.to='fr';state.config.nativeBatchTranslationEnabled.google=true;await drain()
    expect(messages).toHaveLength(1);expect(messages[0].config).toMatchObject({to:'ja',nativeBatchTranslationEnabled:{google:false},alwaysTranslateDomains:['example.com']});expect(patches).toHaveBeenCalledTimes(2)
    first.resolve();await pending;await drain()
    expect(state.config.to).toBe('fr');expect(state.config.nativeBatchTranslationEnabled.google).toBe(true);expect(messages).toHaveLength(2);expect(messages[1].config).toMatchObject({to:'fr',nativeBatchTranslationEnabled:{google:true}});expect(messages[1].config).not.toHaveProperty('alwaysTranslateDomains')
    second.resolve();await persistenceStore!.waitForConfigPersistenceQueue();await drain()
    expect(records.get('local:config')).toMatchObject({to:'fr',nativeBatchTranslationEnabled:{google:true},alwaysTranslateDomains:['example.com']});expect(state.config.alwaysTranslateDomains).toEqual(['example.com'])
  })
  it.each(['url','loading','activate','remove'])('%s 导航事件使已发出的旧翻译回复失效',async kind=>{
    await mount();const reply=deferred();send.mockImplementationOnce(()=>reply.promise);const pending=eventOf(button('page-translation'))();await drain();expect(commands()).toHaveLength(1)
    getTab.mockResolvedValue([{id:kind==='activate'||kind==='remove'?8:7,windowId:3,url:'https://example.net/b'}]);if(kind==='activate')tabEvent('onActivated',{tabId:8,windowId:3});else if(kind==='remove')tabEvent('onRemoved',7);else tabEvent('onUpdated',7,kind==='url'?{url:'https://example.net/b'}:{status:'loading'},{id:7,windowId:3,active:true})
    await drain();reply.resolve({status:'success',isTranslated:true});await pending;await drain();expect(state.currentSiteDomain).toBe('example.net');expect(button('page-translation').getAttribute('aria-pressed')).toBe('false');expect(close).not.toHaveBeenCalled()
  })
  it('状态查询途中连续导航仍取最后页面，完成时重新握手，标题和其它窗口事件不查询',async()=>{
    await mount();const first=deferred<Array<{id:number;windowId:number;url:string}>>();getTab.mockReturnValueOnce(first.promise);tabEvent('onUpdated',7,{status:'loading'},{id:7,windowId:3,active:true});getTab.mockResolvedValue([{id:7,windowId:3,url:'https://example.net/c'}]);tabEvent('onUpdated',7,{url:'https://example.net/c'},{id:7,windowId:3,active:true});await drain();first.resolve([{id:7,windowId:3,url:'https://example.com/b'}]);await drain();expect(state.currentSiteDomain).toBe('example.net')
    const queries=getTab.mock.calls.length;tabEvent('onUpdated',7,{title:'new title'},{id:7,windowId:3,active:true});tabEvent('onUpdated',9,{status:'complete'},{id:9,windowId:4,active:true});tabEvent('onUpdated',9,{status:'loading'},{id:9,windowId:4,active:true});tabEvent('onActivated',{tabId:9,windowId:4});tabEvent('onRemoved',9);await drain();expect(getTab).toHaveBeenCalledTimes(queries)
    tabEvent('onUpdated',7,{status:'complete'},{id:7,windowId:3,active:true});await drain();expect(getTab).toHaveBeenCalledTimes(queries+1)
    shown.value=false;await drain();tabEvent('onUpdated',7,{status:'loading'},{id:7,windowId:3,active:true});tabEvent('onUpdated',7,{status:'complete'},{id:7,windowId:3,active:true});expect(getTab).toHaveBeenCalledTimes(queries+1);app.unmount();expect(Object.values(tabEvents).map(set=>set.size)).toEqual([0,0,0])
  })
  it('抽屉关闭再打开、字段改回及暂停后旧控件均不能借用新会话',async()=>{
    await mount();await openFeature('hover');const hover=eventOf(button('hover-enable')),oldClose=eventOf(document.querySelector('.drawer-header > button')!);const initial=state.config.hotkey;state.config.hotkey='Shift';state.config.hotkey=initial;await drain();hover();expect(state.config.hotkey).toBe(initial)
    eventOf(document.querySelector('.drawer-header > button')!)();await drain();eventOf(document.querySelector('[data-popup-quick-feature="hover"]')!)();await drain();oldClose();expect(state.drawerVisible).toBe(true);eventOf(button('hover-enable'))();await drain();expect(state.config.hotkey).toBe('none');const disabledHover=eventOf(button('hover-enable'));state.config.on=false;state.config.on=true;await drain();disabledHover();expect(state.drawerVisible).toBe(false);expect(state.config.hotkey).toBe('none')
  })
  it('实际显示模式保留 Google 保存偏好，并阻止旧服务和旧划词模式按钮',async()=>{
    config.display=0;config.popupQuickFeatureVisibility.appearance=true;config.selectionTranslatorMode='bilingual';config.disableSelectionTranslator=false;await mount();await openFeature('appearance');const translated=()=>document.querySelector('[aria-label="翻译模式"] button')!;expect(translated().getAttribute('aria-pressed')).toBe('true');expect(translated().hasAttribute('disabled')).toBe(true);state.config.display=1;await drain();eventOf(translated())();expect(state.config.display).toBe(1);state.config.service='bing';await drain();const enabled=eventOf(translated());state.config.service='google';state.config.service='bing';await drain();enabled();expect(state.config.display).toBe(1);eventOf(translated())();expect(state.config.display).toBe(0)
    eventOf(document.querySelector('[data-popup-quick-feature="selection"]')!)();await drain();const mode=eventOf(document.querySelector('.chips.two button')!);eventOf(button('selection-enable'))();await drain();mode();expect(state.config.selectionTranslatorMode).toBe('disabled');expect(state.config.disableSelectionTranslator).toBe(true);eventOf(button('selection-enable'))();await drain();expect(state.config.selectionTranslatorMode).toBe(state.config.selectionTranslatorModeBeforeDisable)
  })
  it('图片抽屉复验平台能力，旧能力回调失效，恢复后新按钮生效',async()=>{
    config.selectionAreaEnabled=false;await mount();await openFeature('image');const area=eventOf(document.querySelector('[aria-label="启用或关闭圈选翻译"]')!),caps=(globalThis as any).__popupFixture.capabilities;caps.areaTranslation=false;caps.areaTranslation=true;await drain();area();expect(state.config.selectionAreaEnabled).toBe(false);eventOf(document.querySelector('[aria-label="启用或关闭圈选翻译"]')!)();expect(state.config.selectionAreaEnabled).toBe(true)
  })
  it('缓存清理独占请求；失活旧回复不能释放重新激活后的新请求',async()=>{
    await mount();const first=deferred(),second=deferred();runtimeSend.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const cached=eventOf(document.querySelector('footer button')!),pending=cached();await cached();expect(runtimeSend).toHaveBeenCalledOnce();expect(document.querySelector('footer button')!.hasAttribute('disabled')).toBe(true);shown.value=false;await drain();shown.value=true;await drain();cached();expect(runtimeSend).toHaveBeenCalledOnce();const newer=eventOf(document.querySelector('footer button')!)();expect(runtimeSend).toHaveBeenCalledTimes(2);first.resolve({success:true});await pending;await drain();expect(state.clearingCache).toBe(true);expect(state.notice).toBe('');second.resolve({success:true});await newer;expect(state.clearingCache).toBe(false);expect(state.notice).toBe('全部翻译缓存已清除')
  })
  it('缓存失败与暂停均有确定结束状态，失败只显示当前会话通知',async()=>{
    await mount();const error=vi.spyOn(console,'error').mockImplementation(()=>{});runtimeSend.mockResolvedValueOnce({success:false,error:'fixture'});await eventOf(document.querySelector('footer button')!)();expect(state.notice).toBe('缓存清除失败');expect(state.clearingCache).toBe(false);const reply=deferred();runtimeSend.mockReturnValueOnce(reply.promise);const pending=eventOf(document.querySelector('footer button')!)();state.config.on=false;reply.resolve({success:true});await pending;expect(state.clearingCache).toBe(false);expect(state.notice).toBe('全部翻译缓存已清除');error.mockRestore()
  })
  it('赞赏打开不抢新焦点，旧遮罩不能关闭新弹窗；Tab/Escape 保持焦点归属',async()=>{
    await mount();const outsider=document.createElement('button');document.body.appendChild(outsider);const pending=eventOf(document.querySelector('.donation-button')!)();focused=outsider;await pending;expect(focused).toBe(outsider);const oldOverlay=eventOf(document.querySelector('.donation-overlay')!),oldClose=eventOf(document.querySelector('.donation-close')!);oldClose();expect(focused).toBe(outsider);await drain();await eventOf(document.querySelector('.donation-button')!)();await drain();const overlay=document.querySelector('.donation-overlay')!;oldOverlay({target:overlay,currentTarget:overlay});expect(state.donationVisible).toBe(true);focused=outsider;const tab=new win.Event('keydown',{cancelable:true});Object.assign(tab,{key:'Tab',shiftKey:false});document.dispatchEvent(tab);expect(focused).toBe(document.querySelector('.donation-close'));const reverse=new win.Event('keydown',{cancelable:true});Object.assign(reverse,{key:'Tab',shiftKey:true});document.dispatchEvent(reverse);expect(focused).toBe(document.querySelector('.donation-kofi'));const escape=new win.Event('keydown',{cancelable:true});Object.assign(escape,{key:'Escape'});document.dispatchEvent(escape);expect(state.donationVisible).toBe(false);expect(focused).toBe(document.querySelector('.donation-button'))
  })
  it('赞赏的未完成焦点任务在关闭/失活后失效，缓存按钮不能重新打开',async()=>{
    await mount();const cached=eventOf(document.querySelector('.donation-button')!),pending=cached();state.donationVisible=false;await pending;expect(focused).toBe(document.body);await drain();await eventOf(document.querySelector('.donation-button')!)();const before=focused;shown.value=false;await drain();shown.value=true;await drain();cached();await drain();expect(state.donationVisible).toBe(false);expect(focused).toBe(before)
  })
  it.each(['settings','document'])('%s 的 API 失败可恢复，关闭后旧成功不关闭新会话',async target=>{
    await mount();const selector=target==='settings'?'.settings-button':'[data-feature="document-translation"]',api=target==='settings'?openOptions:createTab;api.mockRejectedValueOnce(new Error('fixture'));await eventOf(document.querySelector(selector)!)();expect(state.noticeType).toBe('error');expect(close).not.toHaveBeenCalled();const reply=deferred();api.mockReturnValueOnce(reply.promise);const cached=eventOf(document.querySelector(selector)!),pending=cached();await drain();expect(api).toHaveBeenCalledTimes(2);shown.value=false;await drain();shown.value=true;await drain();reply.resolve(undefined);await pending;cached();expect(api).toHaveBeenCalledTimes(2);expect(close).not.toHaveBeenCalled();await eventOf(document.querySelector(selector)!)();expect(close).toHaveBeenCalledOnce()
  })
})
