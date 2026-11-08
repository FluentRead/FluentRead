import './helpers/vueDomFixture';
/**
 * @file tests/readingPanelStreamingResize.test.ts
 * 文件职责：执行阅读面板真实 Vue setup 与客户端模板，验证流式正文不重复要求父卡片测量。
 * 主要内容：逐次刷新回答与结构变化、同帧首次回答/完成/错误、用户阅读位置、晚到译文、隐藏/替换/卸载的迟到响应；统一导航顶栏的唯一传送工具、正文外追问的焦点与输入法连续性、菜单边界和监听清理，以及真实表单/按钮事件。
 * 模块边界：仅控制后台流端口、展示子组件与 DOM 几何；不复制阅读业务，不请求模型，不声称真实浏览器性能。
 */
import {readFileSync} from 'node:fs';
import {parse, compileStyle} from 'vue/compiler-sfc';
import * as runtime from 'vue';
import ReadingPanel from '@/src/features/reading-assistant/ui/ReadingPanel.vue';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';
import {buildReadingEvidence} from '@/src/core/harness/evidence';
import type {ReadingProgress, ReadingRequest, ReadingResponse} from '@/src/features/reading-assistant/types';

const materialTransport = vi.hoisted(() => ({sendMessage: vi.fn(), actualRuntime: undefined as any}));
vi.mock('webextension-polyfill', () => ({default: {get runtime() {return materialTransport.actualRuntime ?? {sendMessage: materialTransport.sendMessage};}, extension: {inIncognitoContext: false}}}));

const readingPorts = vi.hoisted(() => ({client: {} as any, translateLegacy: ((text: string) => text) as (text: string) => string}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => readingPorts.translateLegacy(text)})}));
vi.mock('@/src/features/reading-assistant/client', () => ({
  streamReading: (...args: unknown[]) => readingPorts.client.streamReading(...args),
  getHarnessSession: async () => null, listHarnessSessions: async () => ({sessions: [], hasMore: false}),
  saveLearningMemory: (...args: unknown[]) => readingPorts.client.saveLearningMemory(...args),
}));
vi.mock('@/src/features/reading-assistant/ui/ReadingAnswer.vue', () => ({default: {props: ['text'], setup: (props: {text: string}) => () => runtime.h('div', {'data-reading-answer': ''}, props.text)}}));
const filename = 'src/features/reading-assistant/ui/ReadingPanel.vue';
const scopeId = (ReadingPanel as unknown as {__scopeId: string}).__scopeId;
const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
const compiledStyle = compileStyle({source: descriptor.styles[0].content, filename, id: scopeId, scoped: true});

type HostNode=Node & {__readingProps?:Record<string,any>;__readingEvents?:Record<string,EventListener>};
type StreamCall={request:ReadingRequest;callbacks:{progress:(progress:ReadingProgress)=>void;result:(response:ReadingResponse)=>void;error:(error:Error)=>void};cancel:ReturnType<typeof vi.fn>};
let dispose:(()=>void)|undefined;
const frames=new Map<number,FrameRequestCallback>();let frameId=0;
const flushFrame=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(callback=>callback(16));};
const tick=async()=>{await runtime.nextTick();await runtime.nextTick();};
afterEach(async()=>{dispose?.();dispose=undefined;await tick();expect(frames.size).toBe(0);vi.unstubAllGlobals();frames.clear();});

async function mountPanel(overrides:Record<string,unknown>={}) {
  const {document,window}=parseHTML('<html><body></body></html>');
  const view={innerHeight:800,innerWidth:390,getComputedStyle:()=>({direction:'ltr'}),addEventListener:document.addEventListener.bind(document),removeEventListener:document.removeEventListener.bind(document),dispatchEvent:document.dispatchEvent.bind(document)};
  Object.defineProperty(document,'defaultView',{configurable:true,value:view});
  vi.stubGlobal('document',document);
  vi.stubGlobal('CustomEvent',window.CustomEvent);
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  const calls:StreamCall[]=[],resize=vi.fn(),errors=vi.fn();
  const materialCaptures: any[] = [];
  const sendMessage=vi.fn(async(request: any): Promise<any> => {
    if (request.type === 'fluentReadMaterials') {
      if (request.action === 'capture') materialCaptures.push(request.input);
      return {success:true,data:request.action === 'generation' ? 0 : {id:'material-fixture'}};
    }
    return {success:true};
  }),writeClipboard=vi.fn(async(_text:string)=>undefined),playSource=vi.fn();
  materialTransport.sendMessage.mockReset().mockImplementation(sendMessage);
  const saveLearningMemory=vi.fn(async(_memory: {kind: string; content: string})=>({id:'memory-fixture'}));
  const translateLegacy=vi.fn((text:string)=>text);
  vi.stubGlobal('navigator',{clipboard:{writeText:writeClipboard}});
  readingPorts.translateLegacy = translateLegacy;
  readingPorts.client = {streamReading: (request: ReadingRequest, callbacks: StreamCall['callbacks']) => {
    const call = {request, callbacks, cancel: vi.fn()}; calls.push(call); return {cancel: call.cancel};
  }, saveLearningMemory};
  const remove=(node:HostNode)=>node.parentNode?.removeChild(node);
  const insert=(node:HostNode,parent:HostNode,anchor?:HostNode|null)=>parent.insertBefore(node,anchor||null);
  const renderer=runtime.createRenderer<HostNode,HostNode>({
    patchProp:(node,key,_previous,value)=>{
      (node.__readingProps||={})[key]=value;
      if(key.startsWith('on')) {
        if(key.includes(':'))return;
        const name=key.slice(2).replace(/(?:Once|Passive|Capture)$/u,'').toLowerCase();
        const listeners=node.__readingEvents||={};if(listeners[key])node.removeEventListener(name,listeners[key]);
        if(value){listeners[key]=event=>{for(const fn of Array.isArray(value)?value:[value])fn(event);};node.addEventListener(name,listeners[key]);}
      } else if(node.nodeType===1) {
        if(key==='value')(node as HTMLInputElement).value=value??'';
        else if(key.startsWith('aria-') && value != null)(node as Element).setAttribute(key,String(value));
        else if(value===null||value===undefined||value===false)(node as Element).removeAttribute(key);
        else (node as Element).setAttribute(key,value===true?'':String(value));
      }
    },
    insert,remove,createElement:tag=>runtime.markRaw(document.createElement(tag)) as unknown as HostNode,
    createText:text=>document.createTextNode(text) as unknown as HostNode,createComment:text=>document.createComment(text) as unknown as HostNode,
    setText:(node,text)=>{node.nodeValue=text;},setElementText:(node,text)=>{node.textContent=text;},
    parentNode:node=>node.parentNode as HostNode|null,nextSibling:node=>node.nextSibling as HostNode|null,
    querySelector:selector=>document.querySelector(selector) as unknown as HostNode|null,setScopeId:(node,id)=>(node as Element).setAttribute(id,''),
    insertStaticContent:(html,parent,anchor)=>{
      const holder=document.createElement('template');holder.innerHTML=html;
      const nodes=[...holder.content.childNodes] as unknown as HostNode[];nodes.forEach(node=>insert(node,parent,anchor));return [nodes[0],nodes.at(-1)!];
    },
  });
  const host=document.createElement('div'), mountRoot=document.createElement('div'), toolsTarget=document.createElement('div');
  toolsTarget.className='fr-study-reading-tools';host.append(toolsTarget,mountRoot);document.body.append(host);
  const props=runtime.reactive({toolsTarget:runtime.markRaw(toolsTarget) as unknown as HTMLElement|null,selection:{text:'Practice helps.',sentence:'Practice helps.',context:'Practice helps every day.'},
    preferences:{...DEFAULT_HARNESS_PREFERENCES,enabled:true},active:true,targetLanguage:'zh-CN',sourceLanguage:'en',
    vocabularyEnabled:true,privateContext:false,animations:false,historyOnly:false,externalNavigation:undefined as boolean|undefined,
    sourceTranslation:undefined as {source:string;text:string;pending?:boolean}|undefined,...overrides});
  let panel:any;
  const app=renderer.createApp({setup:()=>()=>runtime.h(ReadingPanel,{...props,onResize:resize,onPlaySource:playSource,ref:(instance:any)=>{if(instance)panel=instance.$.setupState;}})});
  app.config.warnHandler=()=>undefined;app.config.errorHandler=errors;
  app.mount(mountRoot as unknown as HostNode);dispose=()=>app.unmount();await tick();
  expect(errors).not.toHaveBeenCalled();
  const viewport=host.querySelector('.fr-reading-result') as unknown as HTMLElement;
  if(viewport){Object.defineProperty(viewport,'scrollTop',{configurable:true,writable:true,value:0});Object.defineProperty(panel.answerBody,'offsetTop',{configurable:true,value:100});}
  const finish=(text:string,call=calls.at(-1)!)=>call.callbacks.result({success:true,text,service:'deepseek',model:'fixture-model'});
  return {host,toolsTarget,panel,props,calls,resize,viewport,finish,errors,window,sendMessage,materialCaptures,writeClipboard,playSource,translateLegacy,saveLearningMemory,styles:compiledStyle.code,unmount:()=>{dispose?.();dispose=undefined;}};
}

it('copies and saves readable source quotes without leaking model citation IDs or external markers', async () => {
  const {panel,calls,finish,writeClipboard,saveLearningMemory}=await mountPanel();
  const source=buildReadingEvidence(calls[0].request.selection.text,calls[0].request.selection.context)[0];
  finish(`It helps. [[cite:${source.id}|Practice helps.]]\n\n[[external]] Background. [[cite:invented|Unverified text.]]`);
  await tick();
  await panel.copyAnswer();
  const copied=writeClipboard.mock.calls[0][0];
  expect(copied).toContain('【reading.evidence.label】 Practice helps.');
  expect(copied).toContain('【reading.evidence.unverified】 Unverified text.');
  expect(copied).toContain('【reading.evidence.external】 Background.');
  expect(copied).not.toMatch(/\[\[cite:|\[\[external\]\]|fr-[a-z0-9]+-[sc]\d/u);
  await panel.rememberLearning();
  expect(saveLearningMemory).toHaveBeenCalledOnce();
  const note=saveLearningMemory.mock.calls[0][0].content;
  expect(note).toContain('【reading.evidence.label】 Practice helps.');
  expect(note).not.toContain('[[cite:');
});

describe('reading material associations through the public capture port',()=>{
  const material = {source:{kind:'article',url:'https://source.test/private-material',title:'Original source'},locator:{kind:'text',quote:'Practice helps.'}};
  const selection = {text:'Practice helps.',sentence:'Practice helps.',context:'Practice helps every day.',material};
  it.each([false,true])('associates only a successfully persisted session and keeps source metadata outside model input (success=%s)',async success=>{
    const {calls,materialCaptures}=await mountPanel({selection});
    expect(calls[0].request.selection).toEqual({text:'Practice helps.',context:'Practice helps every day.',sentence:''});
    expect(JSON.stringify(calls[0].request)).not.toContain('source.test');
    expect(JSON.stringify(calls[0].request)).not.toContain('material');
    expect(materialCaptures).toEqual([]);
    calls[0].callbacks.result(success ? {success:true,text:'Explanation',service:'deepseek',model:'fixture',sessionId:'persisted-session'} : {success:false,error:'session failed'});
    await tick();
    if (success) {
      await vi.waitFor(()=>expect(materialCaptures).toHaveLength(1));
      expect(materialCaptures[0]).toMatchObject({...material,reference:{kind:'session',id:'persisted-session',excerpt:'Practice helps.'}});
      expect(materialCaptures[0].reference.note).toBeUndefined();
    } else expect(materialCaptures).toEqual([]);
  });
  it.each([false,true])('associates vocabulary only after the real save response succeeds (success=%s)',async success=>{
    const {panel,sendMessage,materialCaptures}=await mountPanel({selection});
    const transport = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async request=>request.type==='fluentReadVocabularyBook' ? success ? {success:true,data:{id:'saved-entry'}} : {success:false,error:{message:'save failed'}} : transport(request));
    await panel.saveWord();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'fluentReadVocabularyBook',action:'upsert'}));
    expect(materialCaptures).toHaveLength(success ? 1 : 0);
    if (success) expect(materialCaptures[0].reference).toEqual({kind:'vocabulary',id:'saved-entry',excerpt:'Practice helps.'});
  });
  it.each([false,true])('associates a learning note only after its authoritative save succeeds (success=%s)',async success=>{
    const {panel,finish,saveLearningMemory,materialCaptures}=await mountPanel({selection});
    finish('Readable explanation'); await tick();
    if (!success) saveLearningMemory.mockRejectedValueOnce(new Error('note save failed'));
    await panel.rememberLearning();
    expect(saveLearningMemory).toHaveBeenCalledOnce();
    expect(materialCaptures).toHaveLength(success ? 1 : 0);
    if (success) expect(materialCaptures[0].reference).toEqual({kind:'memory',id:'memory-fixture',excerpt:'Practice helps.'});
    expect(JSON.stringify(saveLearningMemory.mock.calls[0][0])).not.toContain('source.test');
  });
});

describe('reading panel streaming resize boundaries through actual setup and template',()=>{
  it.each([false,true])('preserves scoped followup nodes, IME input and stopped keyboard propagation in both layouts (external=%s)',async externalNavigation=>{
    const {host,panel,props,calls,window,finish,styles}=await mountPanel({externalNavigation});
    vi.stubGlobal('Event',window.Event);
    finish('Completed explanation');await tick();
    panel.question='Draft';panel.feedback='Saved';panel.sessionWarning='Session warning';await tick();
    const form=host.querySelector('.fr-reading-followup')!;
    const input=form.querySelector('input') as unknown as HTMLInputElement;
    const button=form.querySelector('button')!;
    expect(form.parentNode).toBe(host.querySelector('[data-reading-panel]'));
    expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
    for(const element of [form,input,button,...host.querySelectorAll('.fr-reading-feedback')]) expect(element.hasAttribute(scopeId)).toBe(true);
    for(const fragment of ['.fr-reading-followup input','.fr-reading-followup button','.fr-reading-feedback']){
      const selector=[...styles.matchAll(/([^{}]+)\{([^{}]+)\}/gu)].find(([,rule])=>rule.trim().startsWith(fragment))![1].trim();
      expect(host.querySelector(selector)).not.toBeNull();
    }
    const propagated=vi.fn();host.addEventListener('keydown',propagated);host.addEventListener('keyup',propagated);
    for(const type of ['keydown','keyup']) input.dispatchEvent(new window.Event(type,{bubbles:true}));
    expect(propagated).not.toHaveBeenCalled();
    input.dispatchEvent(new window.Event('compositionstart'));input.value='输入中的问题';
    input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();
    expect(panel.question).toBe('Draft');expect(panel.feedback).toBe('');
    input.dispatchEvent(new window.Event('compositionend'));await tick();expect(panel.question).toBe('输入中的问题');
    const submitted=new window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(submitted);await tick();
    expect(submitted.defaultPrevented).toBe(true);expect(calls).toHaveLength(2);expect(calls[1].request.question).toBe('输入中的问题');
    expect(input.hasAttribute('disabled')).toBe(true);expect(button.hasAttribute('disabled')).toBe(true);
    props.preferences.service='bilibili';await tick();expect(host.querySelector('.fr-reading-followup')).toBeNull();
    props.preferences.service='deepseek';await tick();expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
  });

  it('keeps standalone controls while external navigation teleports unique tools and reserves followup outside the answer scroller',async()=>{
    const {host,toolsTarget,props,calls,viewport,finish,styles}=await mountPanel({externalNavigation:false});
    const root=host.querySelector('[data-reading-panel]')!;
    expect(host.querySelector('.fr-reading-toolbar')?.parentNode).toBe(root);
    expect(host.querySelector('.fr-reading-followup')?.parentNode).toBe(root);
    const summary=host.querySelector('summary[aria-label="更多操作"]')!;
    const summaryRule=[...styles.matchAll(/([^{}]+)\{([^{}]+)\}/gu)].find(([,selector,body])=>selector.includes('summary') && body.includes('width: 32px') && body.includes('height: 32px'))!;
    expect(summaryRule).toBeDefined();expect(summary.matches(summaryRule[1].trim())).toBe(true);
    props.externalNavigation=true;await tick();
    expect(host.querySelector('.fr-reading-toolbar')).toBeNull();
    expect(host.querySelectorAll('.fr-reading-tools')).toHaveLength(1);
    expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
    expect(host.querySelectorAll('summary[aria-label="更多操作"]')).toHaveLength(1);
    expect(toolsTarget.contains(host.querySelector('.fr-reading-tools'))).toBe(true);
    expect(viewport.querySelector('.fr-reading-tools')).toBeNull();
    expect(host.querySelector('.fr-reading-inline-controls')).toBeNull();
    expect(viewport.contains(host.querySelector('.fr-reading-followup'))).toBe(false);
    expect(host.querySelector('.fr-reading-followup')?.parentNode).toBe(root);
    expect(host.querySelector('.fr-reading-status')).not.toBeNull();
    calls[0].callbacks.progress({kind:'text',text:'Heading\nFirst answer paragraph'});await tick();
    expect(host.querySelector('.fr-reading-body > .fr-reading-status')).toBeNull();
    expect(host.querySelector('.fr-reading-controls button[aria-label="停止"]')).not.toBeNull();
    expect(host.querySelector('.fr-reading-controls [role="status"]')).not.toBeNull();
    expect([...root.children].indexOf(host.querySelector('.fr-reading-followup')!)).toBeGreaterThan([...root.children].indexOf(viewport));
    finish('Complete answer');await tick();
    expect(host.querySelector('.fr-reading-controls button[aria-label="停止"]')).toBeNull();
    expect(host.querySelectorAll('.fr-reading-footer')).toHaveLength(1);
    expect(host.querySelectorAll('.fr-reading-tool-list button')).toHaveLength(5);
    props.externalNavigation=false;await tick();
    expect(host.querySelector('.fr-reading-toolbar')?.parentNode).toBe(root);
    expect(host.querySelector('.fr-reading-followup')?.parentNode).toBe(root);
    expect(host.querySelectorAll('.fr-reading-tools')).toHaveLength(1);
    expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it.each([false,true])('retains the focused composing input outside a constrained answer scroller across navigation changes (external=%s)',async externalNavigation=>{
    const {host,panel,props,calls,viewport,window,finish}=await mountPanel({externalNavigation});
    vi.stubGlobal('Event',window.Event);
    finish('Completed explanation');await tick();
    panel.question='Draft';await tick();
    const root=host.querySelector('[data-reading-panel]')!;
    const form=host.querySelector('.fr-reading-followup')!;
    const input=form.querySelector('input') as unknown as HTMLInputElement;
    // Linkedom has no focus manager: a detached input loses this scoped DOM focus port.
    Object.defineProperty(host.ownerDocument,'activeElement',{configurable:true,get:()=>input.isConnected ? input : null});
    input.dispatchEvent(new window.Event('focusin',{bubbles:true}));
    input.dispatchEvent(new window.Event('compositionstart'));input.value='尚未提交的追问';
    input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();
    expect(panel.question).toBe('Draft');
    Object.defineProperty(viewport,'clientHeight',{configurable:true,value:80});
    Object.defineProperty(viewport,'scrollHeight',{configurable:true,value:600});
    viewport.scrollTop=180;viewport.dispatchEvent(new window.Event('scroll'));
    for(const navigation of [!externalNavigation,externalNavigation]) {
      props.externalNavigation=navigation;
      props.sourceTranslation={source:'Practice helps.',text:'晚到的译文'};
      await tick();
      expect(host.querySelector('.fr-reading-followup')).toBe(form);
      expect(host.querySelector('input[aria-label="继续追问"]')).toBe(input);
      expect(form.parentNode).toBe(root);expect(viewport.contains(input)).toBe(false);
      expect(host.ownerDocument.activeElement).toBe(input);expect(input.value).toBe('尚未提交的追问');
      expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
      expect(input.hasAttribute('disabled')).toBe(false);expect(panel.question).toBe('Draft');
    }
    input.dispatchEvent(new window.Event('compositionend'));await tick();
    expect(panel.question).toBe('尚未提交的追问');expect(calls).toHaveLength(1);
  });

  it('bounds the teleported menu above or below its trigger and releases sizing listeners on close, view switches and unmount',async()=>{
    const {host,panel,props,window,unmount}=await mountPanel({externalNavigation:true});
    const details=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    const summary=details.querySelector('summary')!;
    const menu=details.querySelector('.fr-reading-tool-list') as HTMLElement;
    Object.defineProperty(summary,'offsetHeight',{configurable:true,value:32});
    Object.defineProperty(menu,'scrollHeight',{configurable:true,value:320});
    let rect={left:310,right:342,width:32,top:740,bottom:772,height:32};
    summary.getBoundingClientRect=()=>rect as DOMRect;
    details.getBoundingClientRect=()=>rect as DOMRect;
    const view=details.ownerDocument.defaultView!;
    const add=vi.spyOn(view,'addEventListener'), remove=vi.spyOn(view,'removeEventListener');
    const open=()=>{details.open=true;details.dispatchEvent(new window.Event('toggle'));};
    open();
    expect(menu.style.top).toBe('auto');expect(menu.style.bottom).toBe('36px');expect(menu.style.maxHeight).toBe('310px');
    expect(add).toHaveBeenCalledWith('resize',panel.fitToolsMenu);
    rect={left:310,right:342,width:32,top:20,bottom:52,height:32};view.dispatchEvent(new window.Event('resize'));
    expect(menu.style.top).toBe('36px');expect(menu.style.bottom).toBe('auto');expect(menu.style.maxHeight).toBe('310px');
    rect={left:260,right:324,width:64,top:620,bottom:684,height:64};view.dispatchEvent(new window.Event('resize'));
    expect(menu.style.top).toBe('auto');expect(menu.style.maxHeight).toBe('302px');expect(menu.style.width).toBe('183px');
    panel.dismissToolsOutside({target:menu.querySelector('button')});expect(details.open).toBe(true);
    const focus=vi.fn();summary.focus=focus;
    panel.dismissToolsOutside({target:host.querySelector('input')});
    expect(details.open).toBe(false);expect(focus).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('resize',panel.fitToolsMenu);
    open();props.active=false;await tick();
    expect(details.open).toBe(false);expect(host.querySelector('.fr-reading-controls')).toBeNull();
    props.active=true;await tick();
    const current=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    current.open=true;current.dispatchEvent(new window.Event('toggle'));
    props.historyOnly=true;await tick();
    expect(current.open).toBe(false);expect(host.querySelector('.fr-reading-controls')).toBeNull();
    props.historyOnly=false;await tick();
    const final=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    final.open=true;final.dispatchEvent(new window.Event('toggle'));
    remove.mockClear();unmount();await tick();
    expect(remove).toHaveBeenCalledWith('resize',panel.fitToolsMenu);
    expect(host.querySelector('.fr-reading-tools')).toBeNull();
  });

  it.each([
    {name:'short keyboard viewport',visual:{offsetLeft:0,offsetTop:0,width:390,height:280},safe:{left:0,top:0,right:390,bottom:280},
      rect:{left:310,right:342,width:32,top:60,bottom:92,height:32},direction:'ltr',insets:[0,0,0,0],up:false},
    {name:'offset viewport with safe insets',visual:{offsetLeft:120,offsetTop:180,width:200,height:260},safe:{left:128,top:186,right:316,bottom:430},
      rect:{left:135,right:167,width:32,top:365,bottom:397,height:32},direction:'ltr',insets:[6,4,10,8],up:true},
    {name:'scaled trigger in a narrow offset viewport',visual:{offsetLeft:100,offsetTop:200,width:220,height:300},safe:{left:100,top:200,right:320,bottom:500},
      rect:{left:260,right:324,width:64,top:410,bottom:474,height:64},direction:'ltr',insets:[0,0,0,0],up:true},
    {name:'RTL inline-end anchor',visual:{offsetLeft:0,offsetTop:0,width:390,height:280},safe:{left:0,top:0,right:390,bottom:280},
      rect:{left:30,right:62,width:32,top:60,bottom:92,height:32},direction:'rtl',insets:[0,0,0,0],up:false},
  ])('keeps the teleported menu within the actual visible bounds: $name',async({visual,safe,rect,direction,insets,up})=>{
    const {host,window,viewport,errors}=await mountPanel({externalNavigation:true});
    const details=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    const summary=details.querySelector('summary')!;
    const menu=details.querySelector('.fr-reading-tool-list') as HTMLElement;
    // Linkedom loses the first inline-style write when creating its backing attribute; do not prefill any measured size.
    menu.setAttribute('style','');
    Object.defineProperty(summary,'offsetHeight',{configurable:true,value:32});
    Object.defineProperty(menu,'scrollHeight',{configurable:true,value:320});
    summary.getBoundingClientRect=()=>rect as DOMRect;
    details.getBoundingClientRect=()=>rect as DOMRect;
    const view=details.ownerDocument.defaultView!;
    Object.defineProperty(view,'visualViewport',{configurable:true,value:visual});
    Object.defineProperty(view,'document',{configurable:true,value:details.ownerDocument});
    vi.spyOn(view,'getComputedStyle').mockReturnValue({direction,paddingTop:`${insets[0]}px`,paddingRight:`${insets[1]}px`,
      paddingBottom:`${insets[2]}px`,paddingLeft:`${insets[3]}px`} as CSSStyleDeclaration);
    const focus=vi.fn();summary.focus=focus;viewport.scrollTop=41;
    details.open=true;details.dispatchEvent(new window.Event('toggle'));
    expect(errors).not.toHaveBeenCalled();expect(details.open).toBe(true);
    expect(menu.style.top==='auto').toBe(up);
    // Interpret the resulting CSS box in viewport coordinates, rather than recomputing the fitting algorithm.
    const scale=rect.height/32,width=Number.parseFloat(menu.style.width)*scale,height=Number.parseFloat(menu.style.maxHeight)*scale;
    const left=rect.left+Number.parseFloat(menu.style.left)*scale;
    const top=up ? rect.bottom-Number.parseFloat(menu.style.bottom)*scale-height : rect.top+Number.parseFloat(menu.style.top)*scale;
    expect(width).toBeGreaterThan(0);expect(height).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(safe.left+12);expect(left+width).toBeLessThanOrEqual(safe.right-12);
    expect(top).toBeGreaterThanOrEqual(safe.top+8);expect(top+height).toBeLessThanOrEqual(safe.bottom-8);
    if(direction==='rtl') expect(left).toBe(rect.left);
    expect(viewport.scrollTop).toBe(41);expect(focus).not.toHaveBeenCalled();
  });

  it('enters records without restoring focus to the removed menu trigger and keeps source viewing focused on the answer',async()=>{
    const {host,window,viewport,panel}=await mountPanel({externalNavigation:true});
    const details=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    const summary=details.querySelector('summary')!;const focus=vi.fn();summary.focus=focus;
    const button=(text:string)=>[...details.querySelectorAll('button')].find(element=>element.textContent===text)!;
    const sourceFocus=vi.fn();viewport.focus=sourceFocus;
    details.open=true;button('reading.viewSource').dispatchEvent(new window.Event('click',{bubbles:true}));await tick();
    expect(details.open).toBe(false);expect(sourceFocus).toHaveBeenCalledWith({preventScroll:true});expect(focus).not.toHaveBeenCalled();
    details.open=true;button('阅读记录').dispatchEvent(new window.Event('click',{bubbles:true}));await tick();
    expect(panel.showRecords).toBe(true);expect(host.querySelector('.fr-reading-controls')).toBeNull();expect(focus).not.toHaveBeenCalled();
    panel.closeRecords();await tick();
    expect(host.querySelectorAll('.fr-reading-tools')).toHaveLength(1);
  });

  it('returns from records to the generating action without cancelling or duplicating its request',async()=>{
    const {host,panel,props,calls,finish}=await mountPanel({externalNavigation:true});
    calls[0].callbacks.progress({kind:'text',text:'Partial explanation'});await tick();
    props.historyOnly=true;await tick();
    expect(panel.showRecords).toBe(true);expect(host.querySelector('.fr-reading-controls')).toBeNull();
    props.historyOnly=false;await tick();
    expect(panel.showRecords).toBe(false);expect(panel.busy).toBe(true);
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Partial explanation');
    expect(host.querySelectorAll('.fr-reading-tools')).toHaveLength(1);
    expect(calls).toHaveLength(1);expect(calls[0].cancel).not.toHaveBeenCalled();
    calls[0].callbacks.progress({kind:'text',text:'Continued explanation'});await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Continued explanation');
    finish('Completed explanation');await tick();
    expect(panel.busy).toBe(false);expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Completed explanation');
    expect(calls).toHaveLength(1);expect(calls[0].cancel).not.toHaveBeenCalled();
  });

  it('runs external tools and followup through real DOM events while preserving manual scrolling and request ownership',async()=>{
    const {host,panel,calls,resize,viewport,window,finish,sendMessage,writeClipboard,playSource,translateLegacy,props}=await mountPanel({externalNavigation:true});
    const click=(element:Element)=>element.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
    const button=(text:string)=>[...host.querySelectorAll('button')].find(element=>element.textContent===text)!;
    flushFrame();flushFrame();
    calls[0].callbacks.progress({kind:'text',text:'Visible streamed answer'});await tick();resize.mockClear();
    const toolsRenders=()=>translateLegacy.mock.calls.filter(([text])=>text==='更多操作').length;
    const beforeChunks=toolsRenders();
    viewport.scrollTop=7;viewport.dispatchEvent(new window.Event('wheel',{bubbles:true}));
    const followUpUpdates=vi.spyOn(runtime.vModelText as {beforeUpdate:NonNullable<typeof runtime.vModelText.beforeUpdate>},'beforeUpdate');
    try {
      for(let index=0;index<8;index++){calls[0].callbacks.progress({kind:'text',text:`Stream paragraph ${index}`});await tick();expect(viewport.scrollTop).toBe(7);}
      expect(followUpUpdates).not.toHaveBeenCalled();
    } finally {followUpUpdates.mockRestore();}
    expect(resize).not.toHaveBeenCalled();
    expect(toolsRenders()).toBe(beforeChunks);
    click(host.querySelector('.fr-reading-controls button[aria-label="停止"]')!);await tick();
    expect(calls[0].cancel).toHaveBeenCalledOnce();expect(panel.stopped).toBe(true);
    calls[0].callbacks.progress({kind:'text',text:'Late stopped result'});await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Stream paragraph 7');
    click(button('重新生成'));await tick();expect(calls).toHaveLength(2);
    finish('Complete explanation');await tick();
    click(button('复制'));await tick();expect(writeClipboard).toHaveBeenCalledWith('Practice helps.\n\nComplete explanation');
    click(button('收藏原文'));await tick();expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({action:'upsert',input:expect.objectContaining({term:'Practice helps.'})}));
    click(button('朗读原文'));await tick();expect(playSource).toHaveBeenCalledWith('Practice helps.');
    click(button('设置'));await tick();expect(sendMessage).toHaveBeenCalledWith({type:'openOptionsPage',section:'settings-selection'});
    const focusViewport=vi.fn();viewport.focus=focusViewport;viewport.scrollTop=15;
    click(button('reading.viewSource'));await tick();expect(viewport.scrollTop).toBe(0);
    expect(focusViewport).toHaveBeenCalledWith({preventScroll:true});expect(calls).toHaveLength(2);
    const details=host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
    const summary=details.querySelector('summary')!;const focus=vi.fn();summary.focus=focus;details.open=true;
    const escape=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});summary.dispatchEvent(escape);
    expect(details.open).toBe(false);expect(focus).toHaveBeenCalledWith({preventScroll:true});
    const input=host.querySelector('input[aria-label="继续追问"]') as unknown as HTMLInputElement;
    input.value='Why does practice help?';input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();
    const submit=host.querySelector('button[type="submit"]')!;expect(submit.hasAttribute('disabled')).toBe(false);
    const form=host.querySelector('.fr-reading-followup')!;const submitEvent=new window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(submitEvent);await tick();
    expect(submitEvent.defaultPrevented).toBe(true);expect(calls).toHaveLength(3);
    expect(calls[2].request.question).toBe('Why does practice help?');
    expect(calls[2].request.history).toEqual([{question:'读懂',answer:'Complete explanation'}]);
    expect(input.value).toBe('');expect(submit.hasAttribute('disabled')).toBe(true);
    form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();expect(calls).toHaveLength(3);
    const owner=calls[2];props.selection={text:'Replacement.',sentence:'Replacement.',context:'Replacement context.'};await tick();
    owner.callbacks.progress({kind:'text',text:'Late previous followup'});owner.callbacks.result({success:true,text:'Late followup complete',service:'deepseek',model:'fixture'});await tick();
    expect(owner.cancel).toHaveBeenCalledOnce();expect(host.querySelector('[data-reading-answer]')).toBeNull();
    expect(host.querySelectorAll('.fr-reading-tools')).toHaveLength(1);expect(host.querySelectorAll('.fr-reading-followup')).toHaveLength(1);
    expect(host.querySelector('.fr-reading-source p')?.textContent).toBe('Replacement.');
  });

  it('keeps external source comparison collapsed while late translations and answer chunks preserve the user reading position',async()=>{
    const {host,calls,props,panel,viewport,window,resize,finish}=await mountPanel({externalNavigation:true,
      sourceTranslation:{source:'Practice helps.',text:'',pending:true}});
    flushFrame();flushFrame();
    const source=host.querySelector('.fr-reading-source') as unknown as HTMLElement;
    expect(source.style.display).toBe('none');
    expect(viewport.scrollTop).toBe(0);
    calls[0].callbacks.progress({kind:'text',text:'First answer'});await tick();resize.mockClear();
    viewport.scrollTop=37;viewport.dispatchEvent(new window.Event('wheel',{bubbles:true}));
    Object.defineProperty(panel.answerBody,'offsetTop',{configurable:true,value:250});
    props.sourceTranslation={source:'Practice helps.',text:'练习有帮助。'};await tick();
    expect(viewport.scrollTop).toBe(37);
    expect(source.style.display).toBe('none');
    expect(host.querySelector('.fr-reading-source p')?.textContent).toBe('Practice helps.');
    expect(host.querySelector('.fr-reading-translation p')?.textContent).toBe('练习有帮助。');
    for(let index=0;index<8;index++){calls[0].callbacks.progress({kind:'text',text:`Answer paragraph ${index}`});await tick();expect(viewport.scrollTop).toBe(37);}
    expect(resize).not.toHaveBeenCalled();
    finish('Completed explanation');await tick();
    expect(viewport.scrollTop).toBe(37);expect(source.style.display).toBe('none');expect(calls).toHaveLength(1);
  });

  it('expands and returns from the source through rendered controls without losing the answer or an unsent question',async()=>{
    const {host,calls,viewport,window,finish,props}=await mountPanel({externalNavigation:true,
      sourceTranslation:{source:'Practice helps.',text:'练习有帮助。'}});
    flushFrame();flushFrame();finish('Completed explanation');await tick();
    const source=host.querySelector('.fr-reading-source') as unknown as HTMLElement;
    const input=host.querySelector('input[aria-label="继续追问"]') as unknown as HTMLInputElement;
    const click=(element:Element)=>element.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
    const focus=vi.fn();viewport.focus=focus;
    input.value='My unsent question';input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();
    viewport.scrollTop=59;
    click([...host.querySelectorAll('.fr-reading-tool-list button')].find(button=>button.textContent==='reading.viewSource')!);
    await tick();
    expect(source.style.display).not.toBe('none');
    expect(viewport.scrollTop).toBe(0);expect(focus).toHaveBeenLastCalledWith({preventScroll:true});
    expect(source.querySelector('p')?.textContent).toBe('Practice helps.');
    expect(source.querySelector('.fr-reading-translation p')?.textContent).toBe('练习有帮助。');
    expect(calls).toHaveLength(1);
    props.sourceTranslation={source:'Practice helps.',text:'更新的完整译文。'};await tick();
    expect(viewport.scrollTop).toBe(0);expect(source.querySelector('.fr-reading-translation p')?.textContent).toBe('更新的完整译文。');
    click(host.querySelector('button[aria-label="返回当前阅读"]')!);await tick();
    expect(source.style.display).toBe('none');expect(viewport.scrollTop).toBe(0);
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Completed explanation');
    expect(input.value).toBe('My unsent question');expect(calls).toHaveLength(1);
    expect(host.querySelector('button[aria-label="返回当前阅读"]')).toBeNull();
  });

  it.each(['hidden','replacement','unmount'] as const)('rejects a queued source expansion after %s without focusing or scrolling the stale viewport',async reason=>{
    const {host,props,viewport,window,unmount,calls}=await mountPanel({externalNavigation:true});
    flushFrame();flushFrame();
    const focus=vi.fn();viewport.focus=focus;viewport.scrollTop=61;
    const sourceButton=[...host.querySelectorAll('.fr-reading-tool-list button')].find(button=>button.textContent==='reading.viewSource')!;
    sourceButton.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
    if(reason==='hidden')props.active=false;
    else if(reason==='replacement')props.selection={text:'Practice helps.',sentence:'Practice helps.',context:'A new captured context.'};
    else unmount();
    await tick();
    expect(focus).not.toHaveBeenCalled();expect(viewport.scrollTop).toBe(61);
    expect(calls[0].cancel).toHaveBeenCalledOnce();
    if(reason==='replacement')expect((host.querySelector('.fr-reading-source') as unknown as HTMLElement).style.display).toBe('none');
  });

  it('collapses an explicitly opened source on a new action and preserves standalone source comparison',async()=>{
    const {host,panel,calls,props,viewport,window,finish}=await mountPanel({externalNavigation:true,
      sourceTranslation:{source:'Practice helps.',text:'练习有帮助。'}});
    flushFrame();flushFrame();finish('Completed explanation');await tick();
    viewport.focus=vi.fn();panel.showSource();await tick();
    expect((host.querySelector('.fr-reading-source') as unknown as HTMLElement).style.display).not.toBe('none');
    panel.startAction('grammar');await tick();flushFrame();flushFrame();
    expect(calls).toHaveLength(2);expect(calls[1].request.intent).toBe('grammar');
    expect((host.querySelector('.fr-reading-source') as unknown as HTMLElement).style.display).toBe('none');
    expect(viewport.scrollTop).toBe(0);
    props.externalNavigation=false;await tick();
    const source=host.querySelector('.fr-reading-source') as unknown as HTMLElement;
    expect(source.style.display).not.toBe('none');
    expect(source.querySelector('p')?.textContent).toBe('Practice helps.');
    expect(source.querySelector('.fr-reading-translation p')?.textContent).toBe('练习有帮助。');
    expect(host.querySelector('button[aria-label="返回当前阅读"]')).toBeNull();
    viewport.scrollTop=63;viewport.dispatchEvent(new window.Event('wheel',{bubbles:true}));
    panel.showSource();expect(viewport.scrollTop).toBe(0);expect(calls).toHaveLength(2);
  });

  it('renders every flushed chunk while only answer presence and completion notify the parent',async()=>{
    const {host,calls,resize,viewport,finish,errors}=await mountPanel();
    flushFrame();flushFrame();resize.mockClear();
    for(let index=1;index<=40;index++) {
      const text=`Streaming answer ${index}`;calls[0].callbacks.progress({kind:'text',text});await tick();
      expect(host.querySelector('[data-reading-answer]')?.textContent).toBe(text);
      expect(resize).toHaveBeenCalledTimes(1);
      expect(viewport.scrollTop).toBe(100);
    }
    finish('Final answer');await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Final answer');
    expect(host.querySelector('.fr-reading-footer')).not.toBeNull();expect(resize).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps same-flush first answer/error and retry transitions visible without redundant text resizes',async()=>{
    const {host,calls,resize,panel}=await mountPanel();flushFrame();flushFrame();resize.mockClear();
    calls[0].callbacks.progress({kind:'text',text:'A partial answer'});calls[0].callbacks.error(new Error('Connection stopped'));await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('A partial answer');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Connection stopped');expect(resize).toHaveBeenCalledOnce();
    panel.retry();await tick();expect(calls).toHaveLength(2);expect(resize).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-reading-answer]')).toBeNull();expect(host.querySelector('[role="alert"]')).toBeNull();
    calls[1].callbacks.progress({kind:'text',text:'First retry answer'});calls[1].callbacks.result({success:true,text:'Finished retry',service:'deepseek',model:'fixture'});await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Finished retry');
    expect(host.querySelector('.fr-reading-footer')).not.toBeNull();expect(resize).toHaveBeenCalledTimes(3);
  });

  it('starts on activation and preserves ownership when the parent switches actions during the first resize',async()=>{
    const {host,calls,props,resize,panel}=await mountPanel({active:false});
    expect(calls).toHaveLength(0);expect(resize).not.toHaveBeenCalled();
    props.active=true;await tick();expect(calls).toHaveLength(1);flushFrame();flushFrame();resize.mockClear();
    const first=calls[0];resize.mockImplementationOnce(()=>panel.startAction('grammar'));
    first.callbacks.progress({kind:'text',text:'First answer triggers a parent action switch'});await tick();
    expect(calls).toHaveLength(2);expect(calls[1].request.intent).toBe('grammar');expect(first.cancel).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-reading-answer]')).toBeNull();expect(resize).toHaveBeenCalledTimes(2);
    first.callbacks.progress({kind:'text',text:'Late previous action'});first.callbacks.error(new Error('Late previous error'));await tick();
    expect(resize).toHaveBeenCalledTimes(2);expect(host.querySelector('[role="alert"]')).toBeNull();
    calls[1].callbacks.progress({kind:'text',text:'Grammar partial'});calls[1].callbacks.error(new Error('Grammar interrupted'));await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Grammar partial');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Grammar interrupted');expect(resize).toHaveBeenCalledTimes(3);
  });

  it('preserves manual source scrolling and late translation answer offsets during chunk updates',async()=>{
    const {host,calls,panel,props,viewport,window,resize,finish}=await mountPanel({sourceTranslation:{source:'Practice helps.',text:'',pending:true}});
    Object.defineProperty(panel.answerBody,'offsetTop',{configurable:true,get:()=>host.querySelector('.fr-reading-translation p')?.textContent==='练习有帮助。'?160:100});
    flushFrame();flushFrame();viewport.scrollTop=120;
    props.sourceTranslation={source:'Practice helps.',text:'练习有帮助。'};await tick();expect(viewport.scrollTop).toBe(180);
    calls[0].callbacks.progress({kind:'text',text:'First answer'});await tick();resize.mockClear();
    viewport.scrollTop=0;viewport.dispatchEvent(new window.Event('wheel',{bubbles:true}));
    for(let index=0;index<12;index++){calls[0].callbacks.progress({kind:'text',text:`Manual reading ${index}`});await tick();expect(viewport.scrollTop).toBe(0);}
    expect(resize).not.toHaveBeenCalled();finish('Manual reading complete');await tick();expect(viewport.scrollTop).toBe(0);
    expect(host.querySelector('.fr-reading-source p')?.textContent).toBe('Practice helps.');
    expect(host.querySelector('.fr-reading-translation p')?.textContent).toBe('练习有帮助。');
  });

  it('rejects old stream work after hide, reactivation, source replacement and unmount',async()=>{
    const {host,calls,props,resize,panel,unmount}=await mountPanel();flushFrame();flushFrame();
    const hidden=calls[0];hidden.callbacks.progress({kind:'text',text:'Visible partial'});await tick();
    props.active=false;await tick();expect(hidden.cancel).toHaveBeenCalledOnce();resize.mockClear();
    hidden.callbacks.progress({kind:'text',text:'Late hidden'});hidden.callbacks.result({success:true,text:'Late complete',service:'deepseek',model:'fixture'});await tick();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe('Visible partial');expect(resize).not.toHaveBeenCalled();
    props.active=true;await tick();expect(calls).toHaveLength(2);const replaced=calls[1];
    props.selection={text:'Another source.',sentence:'Another source.',context:'Another source in context.'};await tick();resize.mockClear();
    replaced.callbacks.progress({kind:'text',text:'Old source delta'});replaced.callbacks.error(new Error('Old source error'));await tick();
    expect(host.querySelector('.fr-reading-source p')?.textContent).toBe('Another source.');
    expect(host.querySelector('[data-reading-answer]')).toBeNull();expect(resize).not.toHaveBeenCalled();
    panel.startAction('meaning');await tick();const removed=calls.at(-1)!;unmount();resize.mockClear();
    removed.callbacks.progress({kind:'text',text:'After unmount'});removed.callbacks.error(new Error('After unmount'));await tick();
    expect(removed.cancel).toHaveBeenCalledOnce();expect(resize).not.toHaveBeenCalled();expect(host.querySelector('[data-reading-panel]')).toBeNull();expect(host.querySelector('.fr-reading-controls')).toBeNull();
  });
});

it('expands the selected phrase to its sentence through the tool and lets the parent dismiss only an open menu',async()=>{
  const ui=await mountPanel({selection:{text:'Practice',sentence:'Practice helps every day.',context:'Practice helps every day.'}});
  const details=ui.host.querySelector('.fr-reading-tools') as unknown as HTMLDetailsElement;
  const summary=details.querySelector('summary')!;const focus=vi.fn();summary.focus=focus;
  expect(ui.panel.dismissTools()).toBe(false);details.open=true;expect(ui.panel.dismissTools()).toBe(true);expect(details.open).toBe(false);expect(focus).toHaveBeenCalledWith({preventScroll:true});
  const button=[...ui.host.querySelectorAll('button')].find(node=>node.textContent==='理解整句')!;expect(button).toBeTruthy();button.dispatchEvent(new ui.window.Event('click',{bubbles:true}));await tick();
  expect(ui.calls).toHaveLength(2);expect(ui.calls[0].cancel).toHaveBeenCalledOnce();expect(ui.calls[1].request.selection.text).toBe('Practice helps every day.');expect(ui.host.querySelector('.fr-reading-source p')?.textContent).toBe('Practice helps every day.');
});
it('uses toolbar, prior-turn and service-repair buttons while keeping old answers and failed transport ownership explicit',async()=>{
  const ui=await mountPanel();const click=async(text:string)=>{const button=[...ui.host.querySelectorAll('button')].find(node=>node.textContent===text);expect(button,`button ${text}`).toBeTruthy();button!.dispatchEvent(new ui.window.Event('click',{bubbles:true}));await tick();};
  ui.finish('First meaning');await tick();await click('句法');expect(ui.calls.at(-1)?.request.intent).toBe('grammar');ui.finish('Grammar explanation');await tick();
  const turn=ui.host.querySelector('.fr-reading-turn-toggle')!;expect(turn).toBeTruthy();const count=ui.calls.length;turn.dispatchEvent(new ui.window.Event('click',{bubbles:true}));await tick();expect(turn.getAttribute('aria-expanded')).toBe('true');expect(ui.host.textContent).toContain('First meaning');expect(ui.calls).toHaveLength(count);
  readingPorts.client.streamReading=()=>{throw new Error('Port unavailable');};await click('重新生成');expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain('Port unavailable');
  await click('设置模型');expect(ui.sendMessage).toHaveBeenCalledWith({type:'openOptionsPage',section:'settings-services'});
  ui.props.preferences.service='bilibili';await tick();await click('切换服务');expect(ui.sendMessage).toHaveBeenCalledWith({type:'openOptionsPage',section:'settings-selection'});
});


it('runs an actual userscript reading action from the rendered toolbar through the real client and owned stream port', async () => {
  const ui = await mountPanel();ui.finish('Initial answer');await tick();
  const {Config} = await import('@/src/core/config/model');const configuration = new Config();configuration.on = true;
  configuration.harness = {...configuration.harness, enabled: true, service: 'openai', model: 'fixture-reader'};
  const values = new Map<string, unknown>();const subscriptions = new Set<() => void>();
  vi.stubGlobal('window', new EventTarget());vi.stubGlobal('location', {href: 'https://reading.test/article'});
  vi.stubGlobal('GM', {getValue: (key: string, fallback: unknown) => values.get(key) ?? fallback,
    setValue: (key: string, value: unknown) => {values.set(key, value);}, listValues: () => [...values.keys()], deleteValue: (key: string) => values.delete(key)});
  const run = vi.fn(async (_request: ReadingRequest, _signal: AbortSignal, progress?: (value: ReadingProgress) => void): Promise<ReadingResponse> => {
    progress?.({kind: 'text', text: '语法讲解正在生成'});return {success: true, text: 'Practice 是主语，helps 是谓语。', service: 'openai', model: 'fixture-reader'};
  });
  vi.doMock('@/src/services/config/store', () => ({config: configuration, configReady: Promise.resolve(),
    subscribeConfig: (callback: () => void) => {subscriptions.add(callback);return () => subscriptions.delete(callback);}}));
  // 此案控制模型运行器；userscriptReadingRuntime.test 另执行实际 Harness 模型编排与 GM 持久化。
  vi.doMock('@/src/services/harness/runtime', () => ({createHarnessRuntime: () => ({run})}));
  const adapter = await import('@/userscript/browser');const {createUserscriptReadingRuntime} = await import('@/userscript/readingRuntime');
  const reading = createUserscriptReadingRuntime();adapter.setPlatformMessageHandler(Object.assign(reading.handle, {connect: reading.connect, dispose: reading.dispose}));
  const actual = await vi.importActual<typeof import('@/src/features/reading-assistant/client')>('@/src/features/reading-assistant/client');
  materialTransport.actualRuntime = adapter.default.runtime;readingPorts.client = actual;
  try {
    const action = [...ui.host.querySelectorAll<HTMLButtonElement>('.fr-reading-actions button')].find(button => button.getAttribute('aria-label') === '词性与句法')!;
    expect(action).toBeTruthy();action.dispatchEvent(new ui.window.Event('click', {bubbles:true}));
    await vi.waitFor(() => expect(ui.host.querySelector('[data-reading-answer]')?.textContent).toBe('Practice 是主语，helps 是谓语。'));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][0]).toMatchObject({intent: 'grammar', selection: {text: 'Practice helps.'}});
    expect((await actual.listHarnessSessions()).sessions).toHaveLength(1);expect(values.size).toBeGreaterThan(0);
    ui.unmount();expect(ui.host.querySelector('[data-reading-panel]')).toBeNull();
  } finally {
    adapter.resetPlatformMessageHandler();materialTransport.actualRuntime = undefined;
    vi.doUnmock('@/src/services/config/store');vi.doUnmock('@/src/services/harness/runtime');
    expect(subscriptions.size).toBe(0);
  }
});
