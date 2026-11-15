/**
 * @file tests/personalCorrectionUiRuntime.test.ts
 * 文件职责：验证校订网页入口的焦点选择、封闭 Shadow UI 和卸载所有权。
 * 主要内容：指针及快捷键、输入与重复触发保护、动态原文失效、迟到挂载拒绝与有限宿主修复。
 * 模块边界：使用真实 DOM 事件和受控 UI 挂载端口；不证明真实浏览器键盘信任或视觉布局。
 */
import {parseHTML} from 'linkedom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mountPersonalCorrections,unmountPersonalCorrections} from '@/src/features/personal-corrections/public';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';

const mocks=vi.hoisted(()=>({shadow:vi.fn(),ui:{remove:vi.fn(),shadowHost:{isConnected:true}}}));
vi.mock('@/src/platform/shadow-ui',()=>({createVueShadowUi:mocks.shadow}));
vi.mock('@/src/features/personal-corrections/ui/PersonalCorrectionPanel.vue',()=>({default:{}}));
vi.mock('@/src/services/personal-corrections/public',()=>({personalCorrections:{}}));
let document:Document,window:ReturnType<typeof parseHTML>['window'];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function deferred<T>() {let resolve!: (value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture() {
  let current=true;const abort=new AbortController(),ctx={isInvalid:false} as ContentScriptContext;
  const pair={source:'Original.',translation:'译文。',sourceLanguage:'en',targetLanguage:'zh-CN',context:'chapter',materialId:'material-'+'a'.repeat(64),apply:vi.fn(()=>true),isCurrent:()=>current};
  const service={list:vi.fn(async()=>({entries:[],projects:[],memberships:[]})),lookup:vi.fn(async()=>({suggestions:[],conflicts:[]}))};
  const ports={readPair:vi.fn(()=>pair),listVisiblePairs:vi.fn(()=>[pair]),refreshVisible:vi.fn(),service:service as any};
  const dispose=mountPersonalCorrections(ctx,abort.signal,ports);
  const props=()=>mocks.shadow.mock.calls.at(-1)?.[1].props;
  function event(type='pointerover',selector='.nested',fields:Record<string,unknown>={}){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{isTrusted:true},fields);document.querySelector(selector)!.dispatchEvent(e);return e;}
  return {abort,ctx,ports,pair,props,dispose,event,setCurrent:(value:boolean)=>{current=value;}};
}
beforeEach(()=>{vi.clearAllMocks();mocks.ui.shadowHost.isConnected=true;mocks.ui.remove.mockReset();mocks.shadow.mockResolvedValue(mocks.ui);
  const dom=parseHTML('<html><body><div id="translated"><span class="fluent-read-bilingual-content"><b class="nested">译文。</b></span></div><p id="other">Other</p><input id="input"><div contenteditable="true" id="editable">Editing</div></body></html>');document=dom.document;window=dom.window;
  for(const [name,value] of Object.entries({document,window,Element:window.Element,HTMLElement:window.HTMLElement,MutationObserver:window.MutationObserver}))vi.stubGlobal(name,value);
});
afterEach(async()=>{unmountPersonalCorrections();await flush();vi.unstubAllGlobals();});
describe('personal correction content lifecycle',()=>{
  it('defers a reentrant activation until previous Shadow UI cleanup has finished',async()=>{
    const old=fixture();old.event();await flush();let successor:ReturnType<typeof fixture>|undefined;
    mocks.ui.remove.mockImplementationOnce(()=>{unmountPersonalCorrections();successor=fixture();});
    old.abort.abort();await flush();successor!.event();await flush();expect(mocks.shadow).toHaveBeenCalledTimes(1);
    const next=fixture();next.event();await flush();expect(mocks.shadow).toHaveBeenCalledTimes(2);
    unmountPersonalCorrections();expect(mocks.ui.remove).toHaveBeenCalledTimes(2);
  });
  it('discovers only translated pairs, mounts one closed Shadow UI and opens from a genuine keyboard-shaped gesture',async()=>{
    const f=fixture();f.event('pointerover','#other');expect(mocks.shadow).not.toHaveBeenCalled();f.event();f.event();await flush();
    expect(mocks.shadow).toHaveBeenCalledTimes(1);expect(mocks.shadow.mock.calls[0][1]).toMatchObject({hostId:'fluent-read-personal-corrections',mode:'closed'});
    const key=f.event('keydown','#other',{code:'KeyE',key:'e',altKey:true,shiftKey:true});await flush();expect(key.defaultPrevented).toBe(true);expect(f.props().controller.state.open).toBe(true);
    f.props().controller.setDraft('未保存的草稿');f.event('keydown','#other',{code:'KeyE',key:'e',altKey:true,shiftKey:true});expect(f.props().controller.state.draft).toBe('未保存的草稿');
    f.event();expect(f.ports.readPair).toHaveBeenCalledTimes(2);f.dispose();f.dispose();expect(mocks.ui.remove).toHaveBeenCalledTimes(1);expect(f.props().controller.state.open).toBe(false);
    f.event();expect(mocks.shadow).toHaveBeenCalledTimes(1);
  });
  it('supports focusin, ignores editable fields, modifiers, repeats and consumed events',async()=>{
    const f=fixture();f.event('focusin');await flush();const controller=f.props().controller;
    for(const fields of [{isTrusted:false},{repeat:true},{altKey:false},{shiftKey:false},{ctrlKey:true},{metaKey:true},{code:'KeyQ'}])f.event('keydown','#other',{code:'KeyE',altKey:true,shiftKey:true,...fields});
    f.event('keydown','#input',{code:'KeyE',altKey:true,shiftKey:true});f.event('keydown','#editable',{code:'KeyE',altKey:true,shiftKey:true});expect(controller.state.open).toBe(false);
    document.querySelector('#editable')!.setAttribute('contenteditable','plaintext-only');f.event('keydown','#editable',{code:'KeyE',altKey:true,shiftKey:true});expect(controller.state.open).toBe(false);
    document.querySelector('#other')!.setAttribute('data-fluent-read-ui','other-editor');f.event('keydown','#other',{code:'KeyE',altKey:true,shiftKey:true});document.querySelector('#other')!.removeAttribute('data-fluent-read-ui');expect(controller.state.open).toBe(false);
    const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{isTrusted:true,code:'KeyE',altKey:true,shiftKey:true});event.preventDefault();document.querySelector('#other')!.dispatchEvent(event);expect(controller.state.open).toBe(false);
    f.event('keydown','.nested',{code:'KeyE',altKey:true,shiftKey:true});await flush();expect(controller.state.open).toBe(true);
  });
  it('hides a stale pair when original text is removed and guards later shortcuts',async()=>{
    const f=fixture();f.event();await flush();const controller=f.props().controller;await controller.open(f.pair);f.setCurrent(false);document.querySelector('.nested')!.textContent='Changed';await flush();
    expect(controller.state.candidate).toBeNull();expect(controller.state.open).toBe(false);f.event('keydown','#other',{code:'KeyE',altKey:true,shiftKey:true});expect(controller.state.open).toBe(false);
    f.setCurrent(true);f.event();await flush();f.setCurrent(false);f.event('pointerover','#other');expect(controller.state.candidate).toBeNull();
    f.setCurrent(true);f.event();f.setCurrent(false);f.event('keydown','#other',{code:'KeyE',altKey:true,shiftKey:true});expect(controller.state.candidate).toBeNull();
  });
  it('observes the same translated element again after its previous pair became stale',async()=>{
    const f=fixture();f.event();await flush();const controller=f.props().controller;
    await controller.open(f.pair);f.setCurrent(false);document.querySelector('.nested')!.textContent='First replacement';await flush();
    expect(controller.state.candidate).toBeNull();expect(controller.state.open).toBe(false);
    f.setCurrent(true);f.event();await flush();expect(controller.state.candidate).toBe(f.pair);await controller.open(f.pair);
    f.setCurrent(false);document.querySelector('.nested')!.textContent='Second replacement';await flush();
    expect(controller.state.candidate).toBeNull();expect(controller.state.open).toBe(false);
  });
  it('ignores an old observer callback delivered after another translated pair takes ownership',async()=>{
    // 受控平台端口递送已断开观察器的迟到回调；不改运行时内部状态，也不声称原生 disconnect 会保留记录。
    const observers:Array<{callback:MutationCallback;observe:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}> = [];
    class Observer {
      observe=vi.fn();disconnect=vi.fn();
      constructor(public callback:MutationCallback){observers.push(this);}
    }
    vi.stubGlobal('MutationObserver',Observer);
    const f=fixture();f.event();await flush();const controller=f.props().controller;
    const nextElement=document.createElement('span');nextElement.className='fluent-read-bilingual-content next-translation';document.body.append(nextElement);
    let nextCurrent=true;const nextPair={...f.pair,isCurrent:()=>nextCurrent};
    f.setCurrent(false);f.ports.readPair.mockReturnValueOnce(nextPair);f.event('pointerover','.next-translation');await flush();
    expect(observers).toHaveLength(2);expect(observers[0].disconnect).toHaveBeenCalledOnce();await controller.open(nextPair);
    observers[0].callback([],observers[0] as unknown as MutationObserver);
    expect(controller.state.candidate).toBe(nextPair);expect(controller.state.open).toBe(true);
    nextCurrent=false;observers[1].callback([],observers[1] as unknown as MutationObserver);
    expect(controller.state.candidate).toBeNull();expect(controller.state.open).toBe(false);expect(observers[1].disconnect).toHaveBeenCalledOnce();
  });
  it('refuses invalid or duplicate owners and late UI creation after cancellation',async()=>{
    const aborted=new AbortController();aborted.abort();mountPersonalCorrections({isInvalid:false} as ContentScriptContext,aborted.signal,{} as any);
    mountPersonalCorrections({isInvalid:true} as ContentScriptContext,new AbortController().signal,{} as any);expect(mocks.shadow).not.toHaveBeenCalled();
    const pending=deferred<any>();mocks.shadow.mockReturnValueOnce(pending.promise);const f=fixture();const ignored=mountPersonalCorrections(f.ctx,new AbortController().signal,f.ports);ignored();f.event();f.event();expect(mocks.shadow).toHaveBeenCalledTimes(1);
    f.abort.abort();pending.resolve(mocks.ui);await flush();expect(mocks.ui.remove).toHaveBeenCalledTimes(1);f.event();expect(mocks.shadow).toHaveBeenCalledTimes(1);
    const next=fixture();next.event();await flush();expect(mocks.shadow).toHaveBeenCalledTimes(2);
  });
  it('limits rejected mounts and repairs, while revoked handles still release listeners and singletons',async()=>{
    mocks.shadow.mockRejectedValue(new Error('revoked'));const f=fixture();f.event();await flush();f.event();await flush();f.event();await flush();expect(mocks.shadow).toHaveBeenCalledTimes(2);f.dispose();
    mocks.shadow.mockResolvedValue(mocks.ui);const next=fixture();next.event();await flush();mocks.ui.shadowHost.isConnected=false;mocks.ui.remove.mockImplementation(()=>{throw new Error('revoked');});next.event();await flush();next.event();await flush();
    expect(mocks.shadow).toHaveBeenCalledTimes(4);expect(()=>next.dispose()).not.toThrow();mocks.ui.shadowHost.isConnected=true;const newer=fixture();newer.event();await flush();expect(mocks.shadow).toHaveBeenCalledTimes(5);
  });
  it('lets a failed keyboard-open mount retry without retaining an invisible editor',async()=>{
    mocks.shadow.mockRejectedValueOnce(new Error('mount unavailable'));const f=fixture();f.event('keydown','.nested',{code:'KeyE',altKey:true,shiftKey:true});await flush();expect(f.props().controller.state.open).toBe(false);
    f.event('keydown','.nested',{code:'KeyE',altKey:true,shiftKey:true});await flush();expect(mocks.shadow).toHaveBeenCalledTimes(2);expect(f.props().controller.state.open).toBe(true);
  });
  it('moves observation between translated pairs and supports direct content in an open ShadowRoot',async()=>{
    const f=fixture();f.event();await flush();const host=document.createElement('div');document.body.append(host);const root=host.attachShadow({mode:'open'}),content=document.createElement('span');content.className='fluent-read-bilingual-content';content.textContent='Shadow译文';root.append(content);
    const event=new window.Event('pointerover',{bubbles:true});Object.assign(event,{composedPath:()=>[content,root,host,document.body,document]});document.dispatchEvent(event);await flush();expect(f.ports.readPair).toHaveBeenLastCalledWith(content);
    f.setCurrent(false);document.querySelector('.nested')!.textContent='Old pair mutation';await flush();expect(f.props().controller.state.candidate).toBe(f.pair);content.textContent='Current pair mutation';await flush();expect(f.props().controller.state.candidate).toBeNull();
  });
  it('ignores absent pairs, disconnected results, invalid contexts and direct text events',async()=>{
    const f=fixture();f.ports.readPair.mockReturnValueOnce(null as any);f.event();f.setCurrent(false);f.event();expect(mocks.shadow).not.toHaveBeenCalled();
    Object.assign(f.ctx,{isInvalid:true});f.event();f.event('keydown','#other',{code:'KeyE',altKey:true,shiftKey:true});expect(mocks.shadow).not.toHaveBeenCalled();Object.assign(f.ctx,{isInvalid:false});
    const text=document.querySelector('#other')!.firstChild!;const e=new window.Event('pointerover',{bubbles:true});text.dispatchEvent(e);expect(mocks.shadow).not.toHaveBeenCalled();
    f.setCurrent(true);f.event();await flush();Object.assign(f.ctx,{isInvalid:true});document.querySelector('.nested')!.textContent='mutate';await flush();expect(f.props().controller.state.candidate).toBe(f.pair);
  });
});
