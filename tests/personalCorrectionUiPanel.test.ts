/**
 * @file tests/personalCorrectionUiPanel.test.ts
 * 文件职责：执行真实 Vue 校订模板验证用户可编辑、可预览、可撤销及可删除的界面流程。
 * 主要内容：原译文纯文本、页签侧紧凑语言与底部范围、按需项目创建、候选差异、显式项目加入、管理状态、帮助悬停与聚焦、分层 Escape、滚动定位及卸载清理。
 * 模块边界：自有 linkedom 渲染器执行真实客户端模板和封闭根内事件，以确定几何验证定位分支；真实浏览器截图验收另行执行。
 */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {App} from 'vue';
import type {PersonalCorrectionRecord} from '@/src/core/personal-corrections/public';
import {createUiI18nPlugin} from '@/src/ui/i18n';
import {translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import './helpers/vueDomFixture';

const mocks=vi.hoisted(()=>({config:{theme:'auto',interfaceSkin:'default',uiLanguage:'zh-CN'},listeners:new Set<(value:any)=>void>(),stop:vi.fn()}));
vi.mock('@/src/services/config/store',()=>({config:mocks.config,configReady:Promise.resolve(),getConfigRevision:()=>0,requestConfigPatch:vi.fn(),subscribeConfig:(fn:(value:any)=>void)=>{mocks.listeners.add(fn);return()=>{mocks.listeners.delete(fn);mocks.stop();};}}));
vi.mock('webextension-polyfill',()=>({default:{runtime:{sendMessage:vi.fn()}}}));
vi.mock('@/src/platform/i18n/uiLanguageBundles',()=>({ensureUiLanguageBundle:async()=>true}));
registerAllUiLanguageBundles();
const runtime=createRequire(import.meta.url)('vue') as typeof import('vue');
let component:any,app:App|undefined,document:Document,window:ReturnType<typeof parseHTML>['window'],focused:HTMLElement|null;
let mediaListener:((event:{matches:boolean})=>void)|undefined;const removeMedia=vi.fn();
const settle=async()=>{for(let i=0;i<4;i++){await Promise.resolve();await runtime.nextTick();}};
const mid='material-'+'a'.repeat(64),pid='00000000-0000-4000-8000-000000000002';
function entry(patch:Partial<PersonalCorrectionRecord>={}):PersonalCorrectionRecord{return {id:'00000000-0000-4000-8000-000000000001',scope:{kind:'material',id:mid,label:'文章'},source:'He opened the bank.',translation:'他开设了银行。',sourceLanguage:'en',targetLanguage:'zh-CN',context:'Finance',revision:1,...patch};}
beforeAll(async()=>{component=(await import('@/src/features/personal-corrections/ui/PersonalCorrectionPanel.vue')).default;expect(component.render).toBeTypeOf('function');});
beforeEach(()=>{vi.clearAllMocks();mocks.config.theme='auto';mocks.config.uiLanguage='zh-CN';mocks.listeners.clear();focused=null;mediaListener=undefined;const dom=parseHTML('<html><body><button id="outside">Outside</button><div id="app"></div></body></html>');document=dom.document;window=dom.window;
  Object.defineProperty(document,'activeElement',{get:()=>focused,configurable:true});window.HTMLElement.prototype.focus=function(){focused=this;};
  Object.defineProperty(window,'visualViewport',{value:undefined,writable:true,configurable:true});window.innerWidth=1024;window.innerHeight=768;
  window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:20,y:300,left:20,top:300,right:340,bottom:324,width:320,height:24,toJSON:()=>({})};};
  window.matchMedia=()=>({matches:false,addEventListener:(_type:string,fn:any)=>{mediaListener=fn;},removeEventListener:removeMedia}) as any;
  for(const [name,value]of Object.entries({document,window,HTMLElement:window.HTMLElement,Element:window.Element,Event:window.Event,Node:window.Node,MutationObserver:window.MutationObserver,NodeFilter:{SHOW_TEXT:4}}))vi.stubGlobal(name,value);
});
afterEach(async()=>{app?.unmount();app=undefined;await settle();vi.useRealTimers();vi.unstubAllGlobals();});
async function mount(patch:Record<string,unknown>={},closedShadow=false){
  const state=runtime.shallowReactive({candidate:null,open:false,managing:false,busy:false,loading:false,error:'',notice:'',source:'He opened the bank.',currentTranslation:'他打开了河岸。',draft:'他开设了银行。',scopeId:'material',context:'Finance',sourceLanguage:'en',targetLanguage:'zh-CN',materialId:mid,materialLabel:'文章',projectName:'',entries:[],projects:[],suggestions:[],conflicts:[],affected:[],previewed:false,editing:null,undoToken:'',activeProjectId:'',...patch});
  const controller={state,open:vi.fn(()=>{state.open=true;}),close:vi.fn(()=>{state.open=false;}),setDraft:vi.fn((value:string)=>{state.draft=value;}),setScope:vi.fn((value:string)=>{state.scopeId=value;}),preview:vi.fn(()=>{state.previewed=true;}),save:vi.fn(),undo:vi.fn(),remove:vi.fn(),edit:vi.fn(),suggest:vi.fn(),createProject:vi.fn(),activateProject:vi.fn()};
  const renderer=runtime.createRenderer<Node,HTMLElement>({
    patchProp(node,key,old,value){if(/^on[A-Z]/u.test(key)){const event=key.slice(2).toLowerCase();if(old)node.removeEventListener(event,old);if(value)node.addEventListener(event,value);}else if(key==='style'){for(const [name,item]of Object.entries(value??{}))node.style.setProperty(name,String(item));}else if(key==='value'){(node as HTMLInputElement).value=value??'';}else if(value==null||(value===false&&!/^(?:aria-|data-)/u.test(key)))node.removeAttribute(key);else node.setAttribute(key,String(value));},
    insert:(node,parent,anchor)=>parent.insertBefore(node,anchor||null),remove:node=>node.parentNode?.removeChild(node),
    createElement:tag=>{const element=runtime.markRaw(document.createElement(tag));if(tag==='select')Object.defineProperty(element,'value',{value:'',writable:true,configurable:true});return element;},
    createText:text=>document.createTextNode(text),createComment:text=>document.createComment(text),setText:(node,text)=>{node.nodeValue=text;},setElementText:(node,text)=>{node.textContent=text;},parentNode:node=>node.parentNode as HTMLElement|null,nextSibling:node=>node.nextSibling,setScopeId:(node,id)=>node.setAttribute(id,''),
    insertStaticContent:(content,parent,anchor)=>{const template=document.createElement('template');template.innerHTML=content;const first=template.content.firstChild!,last=template.content.lastChild!;parent.insertBefore(template.content,anchor||null);return[first,last];},
  });
  const container=document.querySelector<HTMLElement>('#app')!;
  const root=closedShadow?container.attachShadow({mode:'closed'}):document;
  if(closedShadow)Object.defineProperty(root,'activeElement',{get:()=>focused,configurable:true});
  app=renderer.createApp(component,{controller});app.config.warnHandler=()=>undefined;app.use(createUiI18nPlugin());app.mount(closedShadow?root as any:container);await settle();
  const get=(selector:string)=>{const node=root.querySelector<HTMLElement>(selector);expect(node).not.toBeNull();return node!;};
  const click=async(selector:string)=>{get(selector).dispatchEvent(new window.Event('click',{bubbles:true}));await settle();};
  const key=async(key:string,shiftKey=false)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key,shiftKey});get('[data-testid=correction-dialog]').dispatchEvent(event);await settle();return event;};
  const event=async(node:HTMLElement,type:string)=>{node.dispatchEvent(new window.Event(type,{bubbles:false}));await settle();};
  return {state,controller,get,click,key,event,root,container};
}
describe('actual personal correction panel',()=>{
  it('switches all seven languages in the mounted panel while preserving project names, chapters and editable content',async()=>{
    const project='设置';
    const f=await mount({open:true,source:'校订译文',draft:'编辑译文',context:'',projects:[{id:pid,label:project}],entries:[entry({scope:{kind:'project',id:pid,label:project}})]});
    for(const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES','zh-CN'] as UiLanguage[]){
      mocks.config.uiLanguage=language;for(const fn of mocks.listeners)fn(mocks.config);await settle();
      await vi.waitFor(()=>expect(f.get('.tabs button').textContent).toBe(translateLegacyText('编辑译文',language)));
      expect(f.get('[data-testid=correction-source]').textContent).toBe('校订译文');
      expect((f.get('[data-testid=correction-translation]') as HTMLTextAreaElement).value).toBe('编辑译文');
      expect(f.get(`option[value="${pid}"]`).textContent).toBe(translate('personalCorrections.projectName',language,{name:project}));
      f.state.scopeId=pid;await settle();expect(f.get('[data-testid=correction-scope]').title).toBe(project);
      f.state.scopeId='material';await settle();expect(f.get('[data-testid=correction-scope]').title).toBe(translate('personalCorrections.currentPage',language));
      if(language==='en-US')expect(f.get('[data-testid=correction-language]').textContent).toBe('English → Simplified Chinese');
      await f.event(f.get('[data-testid=correction-scope-help]'),'mouseenter');
      expect(f.get('.scope-tooltip-context').textContent).toBe(translate('personalCorrections.noChapter',language));
      f.state.context='所在章节 · 用户正文';await settle();expect(f.get('.scope-tooltip-context').textContent).toBe('所在章节 · 用户正文');
      f.state.managing=true;await settle();expect(f.get('.record-meta > span').textContent).toBe(translate('personalCorrections.projectName',language,{name:project}));
      f.state.managing=false;f.state.context='';await settle();
    }
  });
  it('opens from accessible entry, edits text without parsing markup, previews then confirms, and restores prior focus',async()=>{
    const outside=document.querySelector<HTMLElement>('#outside')!;outside.focus();const f=await mount({candidate:{source:'source'}});await f.click('[data-testid=correction-entry]');expect(focused).toBe(f.get('[data-testid=correction-translation]'));
    const input=f.get('[data-testid=correction-translation]') as HTMLTextAreaElement;input.value='<img src=x onerror=alert(1)>修订';input.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();expect(f.controller.setDraft).toHaveBeenCalledWith(input.value);
    expect(f.get('[data-testid=correction-save]').hasAttribute('disabled')).toBe(true);await f.click('[data-testid=correction-preview]');expect(f.controller.preview).toHaveBeenCalledTimes(1);expect(f.get('[data-testid=correction-preview-result]').querySelector('img')).toBeNull();
    await f.click('[data-testid=correction-save]');expect(f.controller.save).toHaveBeenCalledTimes(1);await f.click('[data-testid=correction-close]');expect(focused).toBe(outside);expect(document.querySelector('[role=dialog]')).toBeNull();
  });
  it('keeps friendly language names beside the tabs and the compact scope in the footer without changing language identity',async()=>{
    const longProject='论文相关网页'.repeat(10);const f=await mount({open:true,undoToken:'retained-undo',projects:[{id:pid,label:longProject}]});const language=f.get('[data-testid=correction-language]'),scope=f.get('[data-testid=correction-scope]');
    expect(language.closest('nav.tabs')).not.toBeNull();expect(language.textContent).toBe('English → 简体中文');expect(language.title).toContain('en → zh-CN');expect(f.state.sourceLanguage).toBe('en');expect(f.state.targetLanguage).toBe('zh-CN');expect(f.root.querySelector('.panel-body .language-row,.panel-body .language-pair,.panel-body .scope-row')).toBeNull();
    expect(scope.closest('footer .scope-row')).not.toBeNull();expect(scope.title).toBe('仅当前网页');expect(f.get('label[for=correction-scope]').textContent).toBe('使用范围');expect(f.get('.new-project').closest('footer')).toBe(f.get('[data-testid=correction-undo]').closest('footer'));expect(f.get('.new-project').hasAttribute('open')).toBe(false);
    f.state.sourceLanguage='auto';f.state.targetLanguage='zh-TW';await settle();expect(language.textContent).toBe('自动检测 → 繁體中文');expect(f.state.targetLanguage).toBe('zh-TW');
    f.state.sourceLanguage='de';f.state.targetLanguage='custom-language';f.state.scopeId=pid;await settle();expect(language.textContent).toBe('Deutsch → custom-language');expect(language.title).toContain('de → custom-language');expect(scope.title).toBe(longProject);
    f.state.scopeId='removed-project';await settle();expect(scope.title).toBe('项目');await f.click('[data-testid=correction-manage]');expect(language.closest('nav.tabs')).not.toBeNull();expect(f.root.querySelector('footer .scope-row')).toBeNull();
  });
  it('displays original/current diff, exact affected sentences, approximate references and explicit project actions',async()=>{
    const saved=entry(),project=entry({id:pid,scope:{kind:'project',id:pid,label:'论文'}});const f=await mount();f.state.open=true;f.state.projects=[{id:pid,label:'论文'}] as any;f.state.suggestions=[saved] as any;f.state.conflicts=[project] as any;f.state.previewed=true;f.state.affected=[{source:saved.source,translation:'旧译文'}] as any;await settle();
    expect(f.get('[data-testid=correction-affected-count]').textContent).toContain('1 处');expect(document.querySelector('.diff')!.textContent).toContain('已保存的原句');
    expect(f.get('[data-testid=correction-scope] option[value=material]').textContent).toBe('仅当前网页');expect(document.querySelector('.new-project summary')!.textContent).toBe('新建项目');expect(document.querySelector('.scope-hint,.context')).toBeNull();
    await f.click('.suggestions article button');expect(f.controller.suggest).toHaveBeenCalledWith(saved);await f.click('.conflict button');expect(f.controller.edit).toHaveBeenCalledWith(project);
    const scope=f.get('[data-testid=correction-scope]') as HTMLSelectElement;scope.value=pid;scope.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();expect(f.controller.setScope).toHaveBeenCalledWith(pid);
    await f.click('[data-testid=correction-project-join]');expect(f.controller.activateProject).toHaveBeenCalledWith(pid);f.state.activeProjectId=pid;await settle();await f.click('[data-testid=correction-project-leave]');expect(f.controller.activateProject).toHaveBeenCalledWith(null);
    f.get('.new-project').setAttribute('open','');const name=f.get('[data-testid=correction-project-name]') as HTMLInputElement;name.value='新论文';name.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();expect(f.state.projectName).toBe('新论文');await f.click('[data-testid=correction-project-create]');expect(f.controller.createProject).toHaveBeenCalledTimes(1);
    f.state.context='';await settle();await f.event(f.get('[data-testid=correction-scope-help]'),'mouseenter');expect(f.get('.scope-tooltip-context').textContent).toBe('此处没有章节标题');
  });
  it('keeps scope explanations in a closed-root tooltip, supports hover transfer and focused help, and layers Escape',async()=>{
    vi.useFakeTimers();document.querySelector<HTMLElement>('#outside')!.focus();const f=await mount({open:true},true);const help=f.get('[data-testid=correction-scope-help]');
    expect(f.container.shadowRoot).toBeNull();expect(f.root.querySelector('.scope-hint,.context,[role=tooltip]')).toBeNull();expect(help.closest('.scope-row')).not.toBeNull();expect(help.getAttribute('aria-expanded')).toBe('false');expect(help.hasAttribute('aria-describedby')).toBe(false);
    await f.event(help,'mouseenter');const tooltip=f.get('[data-testid=correction-scope-tooltip]');expect(tooltip.id).toBe(help.getAttribute('aria-describedby'));expect(tooltip.getAttribute('role')).toBe('tooltip');expect(help.getAttribute('aria-expanded')).toBe('true');
    expect(tooltip.parentElement).toBe(f.get('.correction-ui'));expect(tooltip.closest('.panel-body,.correction-panel')).toBeNull();expect(tooltip.textContent).toContain('当前网页');expect(tooltip.textContent).toContain('主动加入同一项目');expect(tooltip.textContent).toContain('原句、翻译语言');expect(tooltip.textContent).toContain('章节标题须完全相同');expect(f.get('.scope-tooltip-context').textContent).toBe('Finance');expect(tooltip.style.top).toBe('270px');
    await f.event(help,'mouseleave');await f.event(tooltip,'mouseenter');vi.advanceTimersByTime(120);await settle();expect(f.root.querySelector('[role=tooltip]')).not.toBeNull();await f.event(tooltip,'mouseleave');vi.advanceTimersByTime(120);await settle();expect(f.root.querySelector('[role=tooltip]')).toBeNull();
    help.focus();await f.event(help,'focus');await f.event(help,'mouseleave');vi.advanceTimersByTime(200);await settle();expect(f.root.querySelector('[role=tooltip]')).not.toBeNull();expect((await f.key('Escape')).defaultPrevented).toBe(true);expect(f.state.open).toBe(true);expect(f.controller.close).not.toHaveBeenCalled();expect(f.root.querySelector('[role=tooltip]')).toBeNull();expect(help.hasAttribute('aria-describedby')).toBe(false);
    await f.event(help,'focus');focused=null;await f.event(help,'blur');expect(f.root.querySelector('[role=tooltip]')).toBeNull();expect((await f.key('Escape')).defaultPrevented).toBe(true);expect(f.controller.close).toHaveBeenCalledTimes(1);expect(f.state.open).toBe(false);
  });
  it('keeps help inside a narrow visual viewport and repositions on closed-root panel scroll and viewport changes',async()=>{
    const viewport=document.createElement('div') as unknown as HTMLElement&{width:number;height:number;offsetLeft:number;offsetTop:number};Object.assign(viewport,{width:390,height:380,offsetLeft:12,offsetTop:18});Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
    const add=vi.spyOn(viewport,'addEventListener'),remove=vi.spyOn(viewport,'removeEventListener');const f=await mount({open:true},true);const help=f.get('[data-testid=correction-scope-help]');let anchor={left:380,top:20,bottom:44};
    help.getBoundingClientRect=()=>({...anchor,right:anchor.left+24,width:24,height:24,x:anchor.left,y:anchor.top,toJSON:()=>({})});
    const originalRect=window.HTMLElement.prototype.getBoundingClientRect;window.HTMLElement.prototype.getBoundingClientRect=function(){if(!this.classList.contains('scope-tooltip'))return originalRect.call(this);const width=Math.min(320,Number.parseFloat(this.style.maxWidth)),height=Math.min(200,Number.parseFloat(this.style.maxHeight));return {x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON:()=>({})};};
    await f.event(help,'mouseenter');const tooltip=f.get('[role=tooltip]');expect(tooltip.style.left).toBe('74px');expect(tooltip.style.top).toBe('50px');expect(tooltip.style.maxWidth).toBe('374px');expect(tooltip.style.maxHeight).toBe('364px');expect(add).toHaveBeenCalledWith('resize',expect.any(Function));expect(add).toHaveBeenCalledWith('scroll',expect.any(Function));
    anchor={left:3,top:370,bottom:394};f.get('.panel-body').dispatchEvent(new window.Event('scroll',{bubbles:true}));await settle();expect(tooltip.style.left).toBe('20px');expect(tooltip.style.top).toBe('164px');
    Object.assign(viewport,{width:160,height:120,offsetLeft:10,offsetTop:30});viewport.dispatchEvent(new window.Event('resize'));await settle();expect(tooltip.style.maxWidth).toBe('144px');expect(tooltip.style.maxHeight).toBe('104px');expect(tooltip.style.left).toBe('18px');expect(tooltip.style.top).toBe('38px');
    Object.assign(viewport,{offsetLeft:20,offsetTop:40});viewport.dispatchEvent(new window.Event('scroll'));await settle();expect(tooltip.style.left).toBe('28px');expect(tooltip.style.top).toBe('48px');
    f.state.managing=true;await settle();expect(f.root.querySelector('[role=tooltip]')).toBeNull();expect(remove).toHaveBeenCalledWith('resize',expect.any(Function));expect(remove).toHaveBeenCalledWith('scroll',expect.any(Function));
  });
  it('releases help listeners and ignores late hover, focus, scroll and ticks after close, view switch or unmount',async()=>{
    vi.useFakeTimers();const add=vi.fn(window.addEventListener),remove=vi.fn(window.removeEventListener);window.addEventListener=add;window.removeEventListener=remove;const f=await mount({open:true});let help=f.get('[data-testid=correction-scope-help]');
    help.dispatchEvent(new window.Event('mouseenter'));f.state.open=false;await settle();expect(document.querySelector('[role=tooltip]')).toBeNull();const position=add.mock.calls.find(([type])=>type==='resize')![1] as EventListener;expect(remove).toHaveBeenCalledWith('resize',position);position(new window.Event('resize'));
    const registrations=add.mock.calls.length;await f.event(help,'mouseenter');await f.event(help,'focus');await f.event(help,'mouseleave');expect(add.mock.calls).toHaveLength(registrations);f.state.open=true;help.dispatchEvent(new window.Event('mouseenter'));await settle();expect(document.querySelector('[role=tooltip]')).toBeNull();
    help=f.get('[data-testid=correction-scope-help]');await f.event(help,'mouseenter');await f.event(help,'blur');position(new window.Event('resize'));f.state.managing=true;help.dispatchEvent(new window.Event('mouseenter'));await settle();expect(document.querySelector('[role=tooltip]')).toBeNull();
    f.state.managing=false;await settle();help=f.get('[data-testid=correction-scope-help]');help.dispatchEvent(new window.Event('mouseenter'));app!.unmount();app=undefined;await settle();const afterUnmount=add.mock.calls.length,timers=vi.getTimerCount();await f.event(help,'mouseenter');await f.event(help,'focus');await f.event(help,'mouseleave');position(new window.Event('resize'));expect(add.mock.calls).toHaveLength(afterUnmount);expect(document.querySelector('[role=tooltip]')).toBeNull();expect(vi.getTimerCount()).toBe(timers);
  });
  it('manages edit/delete/undo, keeps unrelated materials read-only and presents explicit loading, error and success states',async()=>{
    const f=await mount();f.state.open=true;f.state.loading=true;await settle();expect(document.querySelector('[role=status]')!.textContent).toContain('读取');await f.click('[data-testid=correction-manage]');expect(document.querySelector('.empty')).toBeNull();
    f.state.loading=false;await settle();expect(document.querySelector('.empty')).not.toBeNull();const saved=entry(),other=entry({id:pid,scope:{kind:'material',id:'material-'+'b'.repeat(64),label:'其他材料'},context:''});f.state.entries=[saved,other] as any;f.state.undoToken='token';f.state.error='校订版本已更新';f.state.notice='已保存';await settle();
    expect(f.get(`[data-correction-edit="${pid}"]`).hasAttribute('disabled')).toBe(true);expect(f.get('[data-testid=correction-error]').getAttribute('role')).toBe('alert');expect(f.get('[data-testid=correction-notice]').textContent).toBe('已保存');
    await f.click(`[data-correction-edit="${saved.id}"]`);await f.click(`[data-correction-delete="${saved.id}"]`);await f.click('[data-testid=correction-undo]');expect(f.controller.edit).toHaveBeenCalledWith(saved);expect(f.controller.remove).toHaveBeenCalledWith(saved);expect(f.controller.undo).toHaveBeenCalledTimes(1);
    f.state.busy=true;await settle();expect(f.get('[data-testid=correction-close]').hasAttribute('disabled')).toBe(true);expect(f.get('[data-testid=correction-undo]').hasAttribute('disabled')).toBe(true);
    f.state.busy=false;await f.click('.tabs button');expect(f.state.managing).toBe(false);f.state.busy=true;await settle();expect(f.get('[data-testid=correction-save]').textContent).toContain('保存中');f.state.busy=false;
    f.state.managing=true;f.state.entries=[entry({id:pid,scope:{kind:'project',id:pid,label:'论文'}})] as any;await settle();expect(document.querySelector('.record-meta')!.textContent).toContain('项目：论文');
    f.state.managing=true;f.state.entries=[];f.state.undoToken='';f.state.busy=true;await settle();expect((await f.key('Tab')).defaultPrevented).toBe(false);
  });
  it('traps Tab at dialog endpoints, leaves interior keys alone and closes only its own Escape',async()=>{
    const f=await mount();f.state.open=true;f.state.previewed=true;await settle();const first=f.get('[data-testid=correction-close]'),last=f.get('[data-testid=correction-save]');first.focus();expect((await f.key('Tab',true)).defaultPrevented).toBe(true);expect(focused).toBe(last);
    last.focus();expect((await f.key('Tab')).defaultPrevented).toBe(true);expect(focused).toBe(first);f.get('[data-testid=correction-translation]').focus();expect((await f.key('Tab')).defaultPrevented).toBe(false);expect((await f.key('ArrowDown')).defaultPrevented).toBe(false);
    expect((await f.key('Escape')).defaultPrevented).toBe(true);expect(f.controller.close).toHaveBeenCalledTimes(1);
  });
  it('keeps collapsed project inputs out of the focus loop and admits them only after explicit expansion',async()=>{
    const f=await mount({open:true,draft:'',previewed:false,undoToken:'retained-undo'});const first=f.get('[data-testid=correction-close]'),summary=f.get('.new-project > summary');first.focus();await f.key('Tab',true);expect(focused).toBe(summary);expect((await f.key('Tab')).defaultPrevented).toBe(true);expect(focused).toBe(first);
    f.get('.new-project').setAttribute('open','');first.focus();await f.key('Tab',true);const create=f.get('[data-testid=correction-project-create]');expect(focused).toBe(create);f.get('[data-testid=correction-project-name]').focus();expect((await f.key('Tab')).defaultPrevented).toBe(false);create.focus();expect((await f.key('Tab')).defaultPrevented).toBe(true);expect(focused).toBe(first);
  });
  it('closes successful project creation to expose explicit joining, while preserving failed input and its visible error',async()=>{
    const f=await mount({open:true,projectName:'论文',undoToken:'retained-undo'});const details=f.get('.new-project');details.setAttribute('open','');f.controller.createProject.mockImplementation(()=>{f.state.projects=[{id:pid,label:'论文'}] as any;f.state.scopeId=pid;f.state.projectName='';});
    await f.click('[data-testid=correction-project-create]');expect(details.hasAttribute('open')).toBe(false);expect(focused).toBe(f.get('[data-testid=correction-scope]'));expect(f.get('[data-testid=correction-project-join]').textContent).toContain('加入');expect(f.state.activeProjectId).toBe('');expect(f.controller.activateProject).not.toHaveBeenCalled();
    details.setAttribute('open','');f.state.projectName='未保存项目';f.controller.createProject.mockImplementation(()=>{f.state.error='项目创建失败，请重试。';});await f.click('[data-testid=correction-project-create]');expect(details.hasAttribute('open')).toBe(true);expect(f.state.projectName).toBe('未保存项目');expect(f.get('[data-testid=correction-error]').textContent).toBe('项目创建失败，请重试。');
    f.state.error='';f.controller.createProject.mockImplementation(()=>undefined);await f.click('[data-testid=correction-project-create]');expect(details.hasAttribute('open')).toBe(true);expect(f.state.projectName).toBe('未保存项目');
  });
  it.each(['close','manage','replace','unmount'])('does not collapse or focus a stale project creation after %s',async change=>{
    const f=await mount({open:true,projectName:'论文'});const details=f.get('.new-project'),create=f.get('[data-testid=correction-project-create]');details.setAttribute('open','');let finish!:()=>void;
    f.controller.createProject.mockImplementation(()=>new Promise<void>(resolve=>{finish=()=>{f.state.projectName='';resolve();};}) as any);await f.click('[data-testid=correction-project-create]');
    if(change==='close'||change==='replace')f.state.open=false;else if(change==='manage')f.state.managing=true;else{app!.unmount();app=undefined;}await settle();
    if(change==='replace'){f.state.open=true;await settle();f.get('.new-project').setAttribute('open','');}const currentFocus=focused;finish();await settle();expect(focused).toBe(currentFocus);expect(details.hasAttribute('open')).toBe(true);
    if(change==='replace')expect(f.get('.new-project').hasAttribute('open')).toBe(true);else{const calls=f.controller.createProject.mock.calls.length;await f.event(create,'click');expect(f.controller.createProject).toHaveBeenCalledTimes(calls);}
    if(change==='close'){f.state.open=true;create.dispatchEvent(new window.Event('click'));await settle();expect(f.controller.createProject).toHaveBeenCalledTimes(1);}
  });
  it('supports already-open lazy mounts and does not steal focus when the opening is immediately canceled',async()=>{
    const f=await mount({open:true,managing:true});expect(focused).toBe(f.get('[data-testid=correction-manage]'));f.state.open=false;await settle();
    f.state.managing=false;f.state.open=true;await Promise.resolve();f.state.open=false;await settle();expect(document.querySelector('[role=dialog]')).toBeNull();
    f.state.open=true;await settle();focused=null;expect((await f.key('Tab')).defaultPrevented).toBe(false);
  });
  it('ignores late keyboard events retained on an already-unmounted dialog',async()=>{
    const f=await mount({open:true});const dialog=f.get('[data-testid=correction-dialog]');app!.unmount();app=undefined;await settle();const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:'Tab'});expect(()=>dialog.dispatchEvent(event)).not.toThrow();expect(event.defaultPrevented).toBe(false);
  });
  it('follows system/config theme changes, focuses management and releases observers without reviving a closed dialog',async()=>{
    const outside=document.querySelector<HTMLElement>('#outside')!;outside.focus();const f=await mount();f.state.open=true;await settle();mediaListener!({matches:true});await settle();expect(document.querySelector('.correction-ui')!.classList.contains('dark')).toBe(true);
    for(const fn of mocks.listeners)fn({theme:'light',interfaceSkin:'minimal'});await settle();expect(document.querySelector('.correction-ui')!.classList.contains('dark')).toBe(false);for(const fn of mocks.listeners)fn({theme:'dark',interfaceSkin:'default'});await settle();expect(document.querySelector('.correction-ui')!.classList.contains('dark')).toBe(true);
    f.state.entries=[entry()] as any;f.state.managing=true;await settle();expect(focused).toBe(document.querySelector('[data-correction-edit]'));f.state.managing=false;await settle();expect(focused).toBe(document.querySelector('textarea'));
    outside.remove();f.state.open=false;await settle();f.state.managing=true;await settle();app!.unmount();app=undefined;expect(mocks.stop).toHaveBeenCalledTimes(2);expect(mocks.listeners.size).toBe(0);expect(removeMedia).toHaveBeenCalledWith('change',expect.any(Function));
  });
});
