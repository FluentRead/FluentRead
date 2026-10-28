/**
 * @file tests/readingWritingUiBehavior.test.ts
 * 文件职责：运行阅读与写作小组件的真实 Vue 客户端模板、输入和键盘行为。
 * 主要内容：偏好草稿、语言过滤、语法/引文导航、词高亮、解释保存所有权和浮层资源清理。
 * 模块边界：DOM 布局、浏览器消息与观察器为受控端口，不复制组件方法或访问私有 setup。
 */
import {parseHTML} from 'linkedom';
import {createRenderer, h, nextTick, shallowReactive, markRaw, type App, type Component} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import WritingChoices from '@/src/features/writing-assistant/ui/WritingChoices.vue';
import WritingLanguagePicker from '@/src/features/writing-assistant/ui/WritingLanguagePicker.vue';
import WritingPopover from '@/src/features/writing-assistant/ui/WritingPopover.vue';
import WritingStyleEditor from '@/src/features/writing-assistant/ui/WritingStyleEditor.vue';
import SpeechFollowText from '@/src/features/selection-translation/ui/SpeechFollowText.vue';
import SentenceAnalysis from '@/src/features/reading-assistant/ui/SentenceAnalysis.vue';
import ReadingEvidence from '@/src/features/reading-assistant/ui/ReadingEvidence.vue';
import ReadingAnswer from '@/src/features/reading-assistant/ui/ReadingAnswer.vue';
import {buildReadingEvidence} from '@/src/core/harness/evidence';
import SavedExplanation from '@/src/features/vocabulary/ui/SavedExplanation.vue';
import CollectionEntry from '@/src/features/vocabulary/ui/CollectionEntry.vue';
import type {VocabularyEntry} from '@/src/features/vocabulary/learningModel';
import {normalizeWritingPreferences} from '@/src/core/config/writing';
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';

const ports = vi.hoisted(() => ({send: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default:{runtime:{sendMessage:ports.send}}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t:(key:string) => key, translateLegacy:(text:string) => text})}));
let doc: Document, win: any;
const apps = new Set<App>();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
class ResizePort {
  static all: ResizePort[] = [];
  observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {ResizePort.all.push(this);}
}
class MutationPort {
  static all: MutationPort[] = [];
  observe = vi.fn(); disconnect = vi.fn();
  constructor(readonly callback: MutationCallback) {MutationPort.all.push(this);}
}
async function flush() {for(let i=0;i<4;i++) await nextTick();}
function flushFrames() {const pending=[...frames.values()]; frames.clear(); pending.forEach(callback=>callback(0));}
function rect(left:number, top:number, width:number, height:number): DOMRect {return {left,top,right:left+width,bottom:top+height,width,height,x:left,y:top,toJSON:()=>({})};}
beforeEach(() => {
  const parsed=parseHTML('<html><body><main></main></body></html>'); doc=parsed.document as unknown as Document; win=parsed.window;
  for(const key of ['Node','Element','HTMLElement','HTMLButtonElement','SVGElement','Event','MutationObserver']) vi.stubGlobal(key,win[key]);
  vi.stubGlobal('window',win); vi.stubGlobal('document',doc);
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('ResizeObserver',ResizePort); vi.stubGlobal('MutationObserver',MutationPort);
  vi.stubGlobal('innerWidth',1000); vi.stubGlobal('innerHeight',800); vi.stubGlobal('visualViewport',undefined);
  ports.send.mockReset(); ResizePort.all=[]; MutationPort.all=[]; frames.clear(); frameId=0;
});
afterEach(async()=>{apps.forEach(app=>app.unmount()); apps.clear(); await flush(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function mount(component:Component, initial:Record<string,any>, wrapperClass='') {
  const props=shallowReactive(initial); const host=doc.createElement('div'); host.className=wrapperClass; doc.body.append(host);
  const renderer=createRenderer<Node,Element>({
    createElement:(tag,ns)=>markRaw(ns==='svg'?doc.createElementNS('http://www.w3.org/2000/svg',tag):doc.createElement(tag)),
    createText:text=>doc.createTextNode(text),createComment:text=>doc.createComment(text),
    insert:(node,parent,anchor)=>parent.insertBefore(node,anchor||null),remove:node=>node.parentNode?.removeChild(node),
    setText:(node,text)=>{node.nodeValue=text;},setElementText:(node,text)=>{node.textContent=text;},
    parentNode:node=>node.parentNode as Element|null,nextSibling:node=>node.nextSibling,setScopeId:(node,id)=>node.setAttribute(id,''),
    patchProp(node,key,old,value){
      if(/^on[A-Z]/u.test(key)){const type=key.slice(2).toLowerCase(); if(old)node.removeEventListener(type,old);if(value)node.addEventListener(type,value);}
      else if(key==='value') (node as HTMLInputElement).value=value??'';
      else if(key==='style') {const style=(node as HTMLElement).style;if(typeof value==='string')style.cssText=value;else {for(const k of Object.keys(old||{})) if(!(k in (value||{})))style.removeProperty(k);Object.assign(style,value||{});}}
      else if(value==null||value===false&&key==='disabled')node.removeAttribute(key);
      else node.setAttribute(key,String(value));
    },
    insertStaticContent(html,parent,anchor){const box=doc.createElement('div');box.innerHTML=html;const first=box.firstChild!,last=box.lastChild!;while(box.firstChild)parent.insertBefore(box.firstChild,anchor||null);return[first,last];},
  });
  const app=renderer.createApp({setup:()=>()=>h(component,props)});apps.add(app);app.mount(host);
  return {host,props,unmount(){app.unmount();apps.delete(app);}};
}
function button(host:Element,text:string){const found=[...host.querySelectorAll('button')].find(node=>node.textContent===text);expect(found).toBeTruthy();return found!;}
async function click(node:Element){expect(node.hasAttribute('disabled')).toBe(false);node.dispatchEvent(new win.Event('click',{bubbles:true,cancelable:true}));await flush();}
async function input(node:Element,value:string){(node as HTMLInputElement).value=value;node.dispatchEvent(new win.Event('input',{bubbles:true}));await flush();}
async function key(node:Element,value:string){const event=new win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:value});node.dispatchEvent(event);await flush();return event;}
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

describe('writing choice and language controls',()=>{
  it('retains roving keyboard selection, wrapping and explicit clicks without a configured match',async()=>{
    const update=vi.fn();const ui=mount(WritingChoices,{modelValue:'missing',label:'Preference',options:[{value:'a',label:'A'},{value:'b',label:'B'},{value:'c',label:'C'}],'onUpdate:modelValue':update});
    const a=button(ui.host,'A');expect(a.getAttribute('tabindex')).toBe('0');
    for(const [pressed,expected] of [['ArrowLeft','c'],['ArrowUp','c'],['ArrowRight','b'],['ArrowDown','b'],['Home','a'],['End','c']]){await key(a,pressed);expect(update).toHaveBeenLastCalledWith(expected);}
    const calls=update.mock.calls.length;expect((await key(a,'Enter')).defaultPrevented).toBe(false);expect(update).toHaveBeenCalledTimes(calls);
    await click(button(ui.host,'B'));expect(update).toHaveBeenLastCalledWith('b');ui.props.modelValue='b';await flush();expect(button(ui.host,'B').getAttribute('aria-checked')).toBe('true');
    ui.props.disabled=true;await flush();expect([...ui.host.querySelectorAll('button')].every(node=>node.hasAttribute('disabled'))).toBe(true);
  });
  it('filters reply and reference languages including inherited labels and empty search results',async()=>{
    const select=vi.fn(),cancel=vi.fn();const ui=mount(WritingLanguagePicker,{modelValue:'target',targetLabel:'Inherited Mandarin',onSelect:select,onCancel:cancel});
    await input(ui.host.querySelector('input')!,'Inherited');expect(ui.host.querySelectorAll('[role="option"]')).toHaveLength(1);
    await click(ui.host.querySelector('[role="option"]')!);expect(select).toHaveBeenCalledWith('target');
    await input(ui.host.querySelector('input')!,'not-a-language');expect(ui.host.textContent).toContain('没有匹配的语言');
    ui.props.reference=true;ui.props.modelValue='ui';await input(ui.host.querySelector('input')!,'');
    expect(ui.host.textContent).toContain('writing.referenceDescription');expect(ui.host.querySelector('[aria-selected="true"]')?.textContent).toContain('Inherited Mandarin');
    await click(button(ui.host,'返回草稿'));expect(cancel).toHaveBeenCalledOnce();ui.props.disabled=true;await flush();expect(ui.host.querySelector('[role="option"]')?.hasAttribute('disabled')).toBe(true);
  });
  it('keeps style edits local until apply and requires nonempty custom tone and role',async()=>{
    const apply=vi.fn(),cancel=vi.fn();const {length,style,tone,role}=normalizeWritingPreferences({});const original={length,style,tone,role};const ui=mount(WritingStyleEditor,{modelValue:original,actionLabel:'Save and rewrite',onApply:apply,onCancel:cancel});
    await click(button(ui.host,'应用'));expect(apply).toHaveBeenCalledWith(expect.objectContaining({tone:original.tone,role:original.role}));
    await click(ui.host.querySelector('section:nth-child(1) button:last-child')!);await click(ui.host.querySelector('section:nth-child(2) button:last-child')!);
    const customs=[...ui.host.querySelectorAll('button')].filter(node=>node.textContent==='自定义');await click(customs[0]);await click(customs[1]);
    expect(button(ui.host,'Save and rewrite').hasAttribute('disabled')).toBe(true);
    await input(ui.host.querySelector('[aria-label="自定义语气"]')!,' Patient ');await input(ui.host.querySelector('[aria-label="自定义角色"]')!,' Maintainer ');
    expect(original.tone).toBe(normalizeWritingPreferences({}).tone);await click(button(ui.host,'Save and rewrite'));expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({tone:'Patient',role:'Maintainer'}));
    await click(button(ui.host,'取消'));await click(button(ui.host,'返回草稿'));expect(cancel).toHaveBeenCalledTimes(2);
    ui.props.saving=true;await flush();expect(button(ui.host,'正在保存…').hasAttribute('disabled')).toBe(true);
    const custom=mount(WritingStyleEditor,{modelValue:{...original,tone:'Patient',role:'Maintainer'},actionLabel:'Apply custom'});
    expect((custom.host.querySelector('[aria-label="自定义语气"]') as HTMLInputElement).value).toBe('Patient');
  });
});

describe('reading source evidence and progress',()=>{
  it('renders rich answer blocks safely and retains evidence inside a grammar table',async()=>{
    const sourceText='Practice helps.';const sources=buildReadingEvidence(sourceText,'');const locate=vi.fn(()=> 'located' as const);
    const text=[
      '# Overview','', '### Details','', '> **Important** context','',
      '```html','<script>alert(1)</script>','```','',
      '3. first item','4. second item','', '- unordered item','',
      '[[external]] Background. [[cite:invented|Unverified text.]]','',
      '| Text | POS | Role | Meaning |','| --- | --- | --- | --- |',
      '| Practice | noun | subject | Practice |',
      `| helps | verb | predicate | Useful [[cite:${sources[0].id}|Practice helps.]] |`,
    ].join('\n');
    const ui=mount(ReadingAnswer,{text,sourceText,evidenceSources:sources,locateEvidence:locate});await flush();
    expect(ui.host.querySelector('h3')?.textContent).toBe('Overview');
    expect(ui.host.querySelector('h4')?.textContent).toBe('Details');
    expect(ui.host.querySelector('blockquote strong')?.textContent).toBe('Important');
    expect(ui.host.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
    expect(ui.host.querySelector('script')).toBeNull();
    expect(ui.host.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect([...ui.host.querySelectorAll('ol li')].map(item=>item.textContent)).toEqual(['first item','second item']);
    expect(ui.host.querySelector('ul li')?.textContent).toBe('unordered item');
    expect(ui.host.textContent).toContain('reading.evidence.external');
    expect(ui.host.querySelector('[data-evidence-state="unverified"]')?.textContent).toContain('Unverified text.');
    expect(ui.host.querySelector('.fr-reading-structure')).toBeNull();
    const citation=ui.host.querySelector('td button[data-reading-evidence]')!;expect(citation).toBeTruthy();
    await click(citation);expect(locate).toHaveBeenCalledWith({quote:sourceText,sourceText,kind:'selection',sourceOffset:0});
  });
  it('promotes the first grounded grammar table and retains a second one in the original answer flow',async()=>{
    const table='| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n| Cats | noun | subject | 猫 |\n| chase | verb | predicate | 追赶 |\n| mice | noun | object | 老鼠 |';
    const ui=mount(ReadingAnswer,{text:`### First\n${table}\n\nIntervening explanation.\n\n### Second\n${table}`,sourceText:'Cats chase mice.'});await flush();
    expect(ui.host.querySelector('.fr-reading-structure h3')?.textContent).toBe('结构分析');
    const analyses=ui.host.querySelectorAll('.fr-sentence-analysis');expect(analyses).toHaveLength(2);
    expect(ui.host.textContent!.indexOf('Intervening explanation.')).toBeLessThan(ui.host.textContent!.lastIndexOf('Cats'));
    expect(ui.host.querySelectorAll('table')).toHaveLength(0);
  });
  it('accepts the optional locator without Vue prop warnings and forwards citation clicks',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const sourceText='Practice helps.'; const sources=buildReadingEvidence(sourceText,'');
    const locate=vi.fn(()=> 'located' as const);
    const ui=mount(ReadingAnswer,{text:`It helps. [[cite:${sources[0].id}|Practice helps.]]`,sourceText,evidenceSources:sources,locateEvidence:locate});
    await flush();
    const evidence=ui.host.querySelector('button[data-reading-evidence]')!;
    expect(evidence).toBeTruthy();
    await click(evidence);
    expect(locate).toHaveBeenCalledOnce();
    expect(locate).toHaveBeenCalledWith({quote:sourceText,sourceText,kind:'selection',sourceOffset:0});
    expect(evidence.getAttribute('data-evidence-state')).toBe('located');
    ui.props.locateEvidence=undefined;await flush();await click(evidence);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(evidence.getAttribute('data-evidence-state')).toBe('unavailable');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('Invalid prop: type check failed for prop "locateEvidence"');
  });
  it('preserves exact text and offsets while showing estimated and boundary word highlights',async()=>{
    const ui=mount(SpeechFollowText,{text:'  Hello, world!',offset:5,progress:null});expect(ui.host.textContent).toBe('  Hello, world!');expect(ui.host.querySelector('.fr-speech-current')).toBeNull();
    ui.props.progress={start:7,end:12,estimated:true};await flush();expect(ui.host.querySelector('.fr-speech-current')?.textContent).toBe('Hello');expect(ui.host.querySelector('.fr-speech-current')?.getAttribute('title')).toContain('估算');
    ui.props.progress={start:14,end:19,estimated:false};await flush();expect(ui.host.querySelector('.fr-speech-current')?.textContent).toBe('world');expect(ui.host.querySelector('.fr-speech-current')?.getAttribute('title')).toContain('词边界');
  });
  it('uses validated citations, updates source state and preserves unavailable quote text',async()=>{
    const locate=vi.fn(()=> 'located');const citation={id:'q',kind:'citation',quote:'Original quote',sourceText:'Original quote',sourceKind:'selection',sourceStart:0};
    const ui=mount(ReadingEvidence,{citation,locateEvidence:locate});expect(ui.host.querySelector('button')?.getAttribute('data-evidence-state')).toBe('ready');
    await click(ui.host.querySelector('button')!);expect(locate).toHaveBeenCalledWith({quote: citation.quote,sourceText:citation.sourceText,kind:'selection',sourceOffset:0});expect(ui.host.querySelector('[role="status"]')?.classList.contains('is-located')).toBe(true);
    ui.props.sourceState='changed';await flush();expect(ui.host.textContent).toContain('reading.evidence.changed');ui.props.sourceState='located';await flush();expect(ui.host.querySelector('[role="status"]')).toBeNull();
    ui.props.locateEvidence=undefined;await flush();await click(ui.host.querySelector('button')!);expect(ui.host.textContent).toContain('unavailable');expect(ui.host.querySelector('button')?.getAttribute('title')).toBe(citation.quote);
  });
  it('renders sentence punctuation and navigation without changing source text',async()=>{
    const annotations=[{text:'We',start:2,end:4,part:describePartOfSpeech('pronoun'),role:'主语',meaning:'People'},{text:'learn',start:5,end:10,part:describePartOfSpeech('verb'),role:'谓语',meaning:'Study'}];
    const ui=mount(SentenceAnalysis,{source:'  We learn, daily.',annotations});
    expect(ui.host.querySelector('.fr-sentence-tokens')?.textContent).toContain(', daily.');
    const buttons=()=>[...ui.host.querySelectorAll('.fr-sentence-tokens button')];
    await click(buttons()[1]);expect(ui.host.querySelector('.fr-sentence-meaning')?.textContent).toBe('Study');
    for(const pressed of ['ArrowLeft','ArrowRight','Home','End'])await key(buttons()[0],pressed);
    expect((await key(buttons()[0],'Enter')).defaultPrevented).toBe(false);await key(ui.host.querySelector('.fr-sentence-tokens')!,'Home');
    ui.props.annotations=[{...annotations[0],part:{...annotations[0].part,label:'unknown'},role:'other'}];await flush();expect(ui.host.querySelector('.fr-sentence-token-meta')?.textContent).toBe('其他');
    ui.props.source='Changed';await flush();ui.props.annotations=[];await flush();expect(ui.host.querySelector('.fr-sentence-detail')).toBeNull();
  });
});

describe('saved explanation',()=>{
  it('opens the collection editor, cancels its draft and forwards a saved note through both real templates',async()=>{
    const entry:VocabularyEntry={id:'saved-art',term:'art',normalizedTerm:'art',identityKey:'en:art',sourceLanguage:'en',kind:'expression',
      translations:{'zh-cn':{text:'艺术',updatedAt:1}},contexts:[],note:'Original',phonetic:'',partOfSpeech:'',createdAt:1,updatedAt:1,lastSeenAt:1,
      encounterCount:1,masteryLevel:0,status:'new',nextReviewAt:1,lastReviewedAt:null,reviewCount:0,lapseCount:0,schemaVersion:1};
    const updated=vi.fn(),study=vi.fn(),remove=vi.fn();const ui=mount(CollectionEntry,{entry,translation:'艺术',playing:false,speechPhase:'idle',busy:false,status:'New',review:'Now',onUpdated:updated,onStudy:study,onRemove:remove});
    const focus=vi.spyOn(win.HTMLElement.prototype,'focus');
    const menu=ui.host.querySelector('details')!;menu.open=true;
    await click(button(ui.host,'编辑解释'));
    const editor=ui.host.querySelector('textarea')!;
    expect(menu.open).toBe(false);expect(focus.mock.contexts).toContain(editor);
    await input(editor,'Discarded draft');await click(button(ui.host,'取消'));
    expect(ui.host.querySelector('textarea')).toBeNull();expect(ui.host.querySelector('.entry-note')?.textContent).toBe('Original');expect(ports.send).not.toHaveBeenCalled();
    await click(button(ui.host,'编辑解释'));expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Original');
    const saved={...entry,note:'A saved explanation',updatedAt:2};ports.send.mockResolvedValueOnce({success:true,data:saved});
    await input(ui.host.querySelector('textarea')!,'A saved explanation');ui.host.querySelector('form')!.dispatchEvent(new win.Event('submit',{cancelable:true,bubbles:true}));await flush();
    expect(ports.send).toHaveBeenCalledWith({type:'fluentReadVocabularyBook',action:'updateNote',entryId:entry.id,note:saved.note});
    expect(updated).toHaveBeenCalledOnce();expect(updated).toHaveBeenCalledWith(saved);expect(ui.host.querySelector('textarea')).toBeNull();
    ui.props.entry=saved;await flush();expect(ui.host.querySelector('.entry-note')?.textContent).toBe(saved.note);
    await click(ui.host.querySelector('.entry-study')!);expect(study).toHaveBeenCalledOnce();
    await click(button(ui.host,'删除收藏'));expect(remove).toHaveBeenCalledOnce();expect(ports.send).toHaveBeenCalledOnce();
  });

  it.each(['success','error'] as const)('keeps a switched entry independent of the previous %s save',async outcome=>{
    const gate=deferred<any>(),updated=vi.fn();ports.send.mockReturnValueOnce(gate.promise);
    const ui=mount(SavedExplanation,{entry:{id:'a',note:'First'},onUpdated:updated});
    await click(button(ui.host,'编辑解释'));await input(ui.host.querySelector('textarea')!,'First draft');
    ui.host.querySelector('form')!.dispatchEvent(new win.Event('submit',{cancelable:true}));await flush();
    ui.props.entry={id:'b',note:'Second'};await flush();
    expect(ui.host.textContent).toContain('Second');expect(ui.host.querySelector('textarea')).toBeNull();
    ui.props.entry={id:'a'};await flush();await click(button(ui.host,'添加简短解释'));await input(ui.host.querySelector('textarea')!,'A new draft');
    if(outcome==='success')gate.resolve({success:true,data:{id:'a',note:'First draft'}});else gate.reject(new Error('Old failure'));
    await flush();expect(updated).not.toHaveBeenCalled();expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('A new draft');expect(button(ui.host,'保存解释').hasAttribute('disabled')).toBe(false);
  });

  it('edits, cancels, saves and clears original notes without changing other entry data',async()=>{
    const updated=vi.fn(),cancel=vi.fn();const entry={id:'a',note:'Original'};const ui=mount(SavedExplanation,{entry,onUpdated:updated,onCancel:cancel});
    await click(button(ui.host,'编辑解释'));await input(ui.host.querySelector('textarea')!,'Revised');await click(button(ui.host,'取消'));expect(cancel).toHaveBeenCalledOnce();
    await click(button(ui.host,'编辑解释'));expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Original');
    ports.send.mockResolvedValue({success:true,data:{id:'a',note:''}});await input(ui.host.querySelector('textarea')!,'');ui.host.querySelector('form')!.dispatchEvent(new win.Event('submit',{cancelable:true,bubbles:true}));await flush();
    expect(ports.send).toHaveBeenCalledWith(expect.objectContaining({action:'updateNote',entryId:'a',note:''}));expect(updated).toHaveBeenCalledWith({id:'a',note:''});
  });
  it.each(['error','non-error','negative','unmount'] as const)('retains drafts and respects the %s save outcome',async kind=>{
    const gate=deferred<any>(),updated=vi.fn();ports.send.mockReturnValue(gate.promise);
    const ui=mount(SavedExplanation,{entry:{id:'a'},initialEditing:true,onUpdated:updated});await input(ui.host.querySelector('textarea')!,'Keep me');
    const form=ui.host.querySelector('form')!;form.dispatchEvent(new win.Event('submit',{cancelable:true}));form.dispatchEvent(new win.Event('submit',{cancelable:true}));await flush();expect(ports.send).toHaveBeenCalledOnce();
    if(kind==='unmount'){ui.unmount();gate.resolve({success:true,data:{id:'a'}});}else if(kind==='negative')gate.resolve({success:false,error:{message:'Unable to save'}});else gate.reject(kind==='error'?new Error('Unable to save'):'unknown');
    await flush();expect(updated).not.toHaveBeenCalled();if(kind!=='unmount'){expect(ui.host.querySelector('[role="alert"]')).toBeTruthy();expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep me');}
  });
});

it('keeps sentence detail visible inside the result viewport and preserves already visible content',async()=>{
  const annotations=[{text:'We',start:0,end:2,part:describePartOfSpeech('pronoun'),role:'主语',meaning:'People'}];
  const ui=mount(SentenceAnalysis,{source:'We',annotations},'fr-reading-result');ui.host.scrollTop=0;ui.host.getBoundingClientRect=()=>rect(0,0,200,100);
  const detail=ui.host.querySelector('.fr-sentence-detail')!;detail.getBoundingClientRect=()=>rect(0,80,100,80);
  await click(ui.host.querySelector('button')!);expect(ui.host.scrollTop).toBe(68);
  detail.getBoundingClientRect=()=>rect(0,20,100,50);await click(ui.host.querySelector('button')!);expect(ui.host.scrollTop).toBe(68);
});

it('positions the real writing popover, coalesces observations and releases resources on close/unmount',async()=>{
  const anchor=doc.createElement('button');doc.querySelector('main')!.append(anchor);anchor.getBoundingClientRect=()=>rect(100,300,80,32);
  const ui=mount(WritingPopover,{active:true,anchor});const popover=ui.host.querySelector('.writing-popover') as HTMLElement;popover.getBoundingClientRect=()=>rect(0,0,200,100);
  await flush();flushFrames();await flush();expect(popover.style.top).toBe('192px');expect(popover.style.visibility).toBe('visible');
  ResizePort.all[0].callback([],{} as ResizeObserver);ResizePort.all[0].callback([],{} as ResizeObserver);expect(frames.size).toBe(1);flushFrames();
  ui.props.active=false;await flush();flushFrames();await flush();expect(MutationPort.all.every(observer=>observer.disconnect.mock.calls.length>0)).toBe(true);
  ui.props.active=true;await flush();ui.unmount();await flush();expect(frames.size).toBe(0);expect(ResizePort.all.every(observer=>observer.disconnect.mock.calls.length>0)).toBe(true);
});

it('resets initially editable explanation drafts for each entry without losing a current pending save',async()=>{
  const gate=deferred<any>();ports.send.mockReturnValue(gate.promise);
  const ui=mount(SavedExplanation,{entry:{id:'a',note:'Initial'},initialEditing:true});
  expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Initial');
  ui.props.entry={id:'b'};await flush();expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  ui.props.entry={id:'c',note:'Third'};await flush();expect((ui.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Third');
  ui.host.querySelector('form')!.dispatchEvent(new win.Event('submit',{cancelable:true}));await flush();
  ui.unmount();gate.reject(new Error('Unmounted'));await flush();
});

it('tracks host layout changes while ignoring its own positioning and card updates',async()=>{
  const anchor=doc.createElement('button');doc.querySelector('main')!.append(anchor);anchor.getBoundingClientRect=()=>rect(100,50,80,32);
  const ui=mount(WritingPopover,{active:true,anchor,width:400});const popover=ui.host.querySelector('.writing-popover') as HTMLElement;popover.getBoundingClientRect=()=>rect(0,0,200,100);
  await flush();flushFrames();await flush();expect(popover.style.top).toBe('90px');
  const [position,layout]=MutationPort.all;
  const record=(target:Node,type='attributes',addedNodes:Node[]=[],removedNodes:Node[]=[])=>({target,type,addedNodes,removedNodes} as unknown as MutationRecord);
  const emit=(records:MutationRecord[])=>layout.callback(records,{} as MutationObserver);
  emit([record(popover)]);expect(frames.size).toBe(0);
  emit([record(popover,'childList',[doc.createTextNode('Own content')])]);expect(frames.size).toBe(0);
  const own=doc.createElement('div');own.setAttribute('data-fluent-read-ui','');doc.body.append(own);
  emit([record(doc.body,'childList',[own])]);expect(frames.size).toBe(0);
  emit([record(doc.body,'childList',[],[])]);expect(frames.size).toBe(0);
  emit([record(doc.body,'childList',[doc.createElement('article')])]);expect(frames.size).toBe(1);flushFrames();
  emit([record(doc.body,'childList',[],[doc.createTextNode('Detached text')])]);expect(frames.size).toBe(1);flushFrames();
  const oldParent=anchor.parentElement!;const other=doc.createElement('section');doc.body.append(other);other.append(anchor);
  emit([record(doc.body,'childList',[other])]);expect(frames.size).toBe(1);expect(ResizePort.all[1].unobserve).toHaveBeenCalledWith(oldParent);flushFrames();
  emit([record(other,'childList',[anchor])]);expect(frames.size).toBe(1);flushFrames();
  const text=doc.createTextNode('Changed host');other.append(text);emit([record(text,'characterData')]);expect(frames.size).toBe(1);flushFrames();
  position.callback([],{} as MutationObserver);expect(frames.size).toBe(1);flushFrames();
  const writing=doc.createElement('div');writing.id='fluent-read-writing-assistant';doc.body.append(writing);
  writing.dispatchEvent(new win.Event('scroll',{bubbles:true}));expect(frames.size).toBe(0);
  other.dispatchEvent(new win.Event('scroll',{bubbles:true}));expect(frames.size).toBe(1);flushFrames();
  win.dispatchEvent(new win.Event('resize'));expect(frames.size).toBe(1);flushFrames();
  anchor.remove();emit([record(other,'childList',[],[anchor])]);flushFrames();expect(ResizePort.all[1].unobserve).toHaveBeenCalledWith(anchor);
  ui.props.anchor=undefined;emit([record(doc.body)]);await flush();flushFrames();
});

it('clamps popovers to the visual viewport and handles anchors that become available after mounting',async()=>{
  const viewport=new win.EventTarget();Object.assign(viewport,{offsetLeft:20,offsetTop:30,width:300,height:200});Object.defineProperty(win,'visualViewport',{configurable:true,value:viewport});
  const ui=mount(WritingPopover,{active:true});await flush();flushFrames();expect(ui.host.querySelector('.writing-popover')?.getAttribute('style')).toContain('hidden');
  const anchor=doc.createElement('button');doc.body.append(anchor);anchor.getBoundingClientRect=()=>rect(400,50,20,20);
  const popover=ui.host.querySelector('.writing-popover') as HTMLElement;popover.getBoundingClientRect=()=>rect(0,0,200,200);ui.props.anchor=anchor;await flush();flushFrames();await flush();
  expect(popover.style.top).toBe('42px');expect(popover.style.left).toBe('108px');
  viewport.dispatchEvent(new win.Event('resize'));viewport.dispatchEvent(new win.Event('scroll'));expect(frames.size).toBe(1);flushFrames();
  const immediate=mount(WritingPopover,{active:true,anchor});immediate.unmount();await flush();
});
