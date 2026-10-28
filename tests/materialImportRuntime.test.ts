import {afterEach, describe, expect, it, vi} from 'vitest';
import {installMaterialImportRuntime} from '@/src/app/background/materialImportRuntime';
import {PORT_NAME} from '@/src/features/vocabulary/materialImportPort';

vi.mock('webextension-polyfill',()=>({default:{}}));

function event<T extends (...args:any[])=>void>() {
  const listeners=new Set<T>();
  return {listeners,addListener:(fn:T)=>{listeners.add(fn);},removeListener:(fn:T)=>{listeners.delete(fn);},fire:(...args:Parameters<T>)=>{for(const listener of [...listeners])listener(...args);}};
}

const capability={id:'0d9f6f7a-6ad5-4d90-b31f-c0289b5d9e7f',token:'a'.repeat(64)};
const manifest={records:0,frames:0,bytes:0,digest:'0'.repeat(64)};
const guard={generation:0,capturedAt:1};
function fixture() {
  const onConnect=event<(port:any)=>void>(), notifications:unknown[]=[];
  const runtime={id:'fixture',getURL:(path:string)=>`chrome-extension://fixture/${path.replace(/^\//u,'')}`,onConnect,
    sendMessage:vi.fn(async (message:unknown)=>{notifications.push(message);})};
  const privateContext={value:false};
  let notify:()=>void=()=>undefined;
  const unsubscribe=vi.fn();
  const stage={observeCommitted:vi.fn((listener:()=>void)=>{notify=listener;return unsubscribe;}),
    beginRecoverable:vi.fn(async()=>capability),resume:vi.fn(async()=>undefined),append:vi.fn(async()=>({nextSeq:1})),
    seal:vi.fn(async()=>undefined),commit:vi.fn(async()=>({inserted:1,updated:0,skipped:0})),
    status:vi.fn(async()=>({state:'open',nextSeq:0})),discard:vi.fn(async()=> 'discarded'),acknowledge:vi.fn(async()=> 'released-or-unavailable'),cleanup:vi.fn(async()=>({sessions:0,receipts:0}))};
  const closeDatabase=vi.fn(),createStage=vi.fn(()=>({stage,close:closeDatabase}));
  const deps={runtime,isPrivateContext:()=>privateContext.value,createStage,ready:Promise.resolve()};
  const port=(sender:unknown={id:'fixture',url:'chrome-extension://fixture/options.html'},name=PORT_NAME)=>{
    const onMessage=event<(message:unknown)=>void>(),onDisconnect=event<()=>void>(),messages:unknown[]=[];
    const result={name,sender,onMessage,onDisconnect,postMessage:vi.fn((message:unknown)=>{messages.push(message);}),disconnect:vi.fn(()=>onDisconnect.fire())};
    return {port:result,onMessage,onDisconnect,messages};
  };
  return {deps,runtime,privateContext,createStage,closeDatabase,stage,unsubscribe,port,notify:()=>notify(),notifications};
}

describe('material import background registration',()=>{
  afterEach(()=>vi.restoreAllMocks());

  it('ignores unrelated ports, rejects untrusted or private senders before creating the stage',()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never);
    const other=f.port(undefined,'reading-stream');f.runtime.onConnect.fire(other.port);
    expect(other.port.disconnect).not.toHaveBeenCalled();expect(f.createStage).not.toHaveBeenCalled();
    for(const sender of [null,{}, {id:'wrong',url:'chrome-extension://fixture/options.html'},
      {id:'fixture',url:'chrome-extension://fixture/popup.html'}, {id:'fixture',url:'https://fixture/options.html'},
      {id:'fixture',url:'chrome-extension://fixture/options.html',incognito:true},
      {id:'fixture',url:'chrome-extension://fixture/options.html',tab:{incognito:true}}]) {
      const p=f.port(sender);f.runtime.onConnect.fire(p.port);expect(p.port.disconnect).toHaveBeenCalledOnce();
    }
    f.privateContext.value=true;const privatePort=f.port();f.runtime.onConnect.fire(privatePort.port);
    expect(privatePort.port.disconnect).toHaveBeenCalledOnce();expect(f.createStage).not.toHaveBeenCalled();
    dispose();expect(f.runtime.onConnect.listeners.size).toBe(0);
  });

  it('installs once per runtime, creates one stage only for authorized settings ports, and rechecks privacy',async()=>{
    const f=fixture(),first=installMaterialImportRuntime(f.deps as never),second=installMaterialImportRuntime(f.deps as never);
    expect(f.runtime.onConnect.listeners.size).toBe(1);
    const p=f.port({id:'fixture',url:'chrome-extension://fixture/options.html?panel=materials#backup'});
    f.runtime.onConnect.fire(p.port);expect(f.createStage).toHaveBeenCalledOnce();expect(p.port.disconnect).not.toHaveBeenCalled();
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));
    expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();
    f.privateContext.value=true;p.onMessage.fire({id:2,action:'status'});
    expect(p.port.disconnect).toHaveBeenCalledOnce();
    first();second();expect(f.runtime.onConnect.listeners.size).toBe(0);expect(f.unsubscribe).toHaveBeenCalledOnce();expect(f.closeDatabase).toHaveBeenCalledOnce();
  });

  it('closes a failed initialization and allows the next trusted port to retry',()=>{
    const f=fixture();
    f.stage.observeCommitted.mockImplementationOnce(()=>{throw Error('initialization failed');});
    const dispose=installMaterialImportRuntime(f.deps as never),failed=f.port();
    f.runtime.onConnect.fire(failed.port);
    expect(failed.port.disconnect).toHaveBeenCalledOnce();expect(f.closeDatabase).toHaveBeenCalledOnce();
    const retry=f.port();f.runtime.onConnect.fire(retry.port);
    expect(retry.port.disconnect).not.toHaveBeenCalled();expect(f.createStage).toHaveBeenCalledTimes(2);
    dispose();expect(f.closeDatabase).toHaveBeenCalledTimes(2);
  });

  it('waits for readiness and shares a pending cleanup, then retries a failure',async()=>{
    const f=fixture();let ready!:()=>void,finish!:()=>void;
    f.deps.ready=new Promise<void>(resolve=>{ready=resolve;});
    const waiting=new Promise<void>(resolve=>{finish=resolve;});
    f.stage.cleanup.mockImplementationOnce(async()=>{await waiting;throw Error('cleanup failed');});
    const dispose=installMaterialImportRuntime(f.deps as never),a=f.port(),b=f.port();
    f.runtime.onConnect.fire(a.port);f.runtime.onConnect.fire(b.port);
    const begin={action:'begin',capability,manifest,guard,deadline:10_000};
    a.onMessage.fire({id:1,...begin});b.onMessage.fire({id:1,...begin});
    await Promise.resolve();expect(f.stage.cleanup).not.toHaveBeenCalled();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();
    ready();await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledOnce());
    expect(f.stage.beginRecoverable).not.toHaveBeenCalled();finish();
    await vi.waitFor(()=>expect(a.messages).toHaveLength(1));await vi.waitFor(()=>expect(b.messages).toHaveLength(1));
    expect(a.messages[0]).toMatchObject({ok:false});expect(b.messages[0]).toMatchObject({ok:false});
    a.onMessage.fire({id:2,...begin});await vi.waitFor(()=>expect(a.messages).toHaveLength(2));
    expect(f.stage.cleanup).toHaveBeenCalledTimes(2);expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();dispose();
  });

  it('does not start cleanup after a pending operation disconnects or becomes private',async()=>{
    const f=fixture();let ready!:()=>void;f.deps.ready=new Promise<void>(resolve=>{ready=resolve;});
    const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});p.onDisconnect.fire();
    f.privateContext.value=true;ready();await Promise.resolve();await Promise.resolve();
    expect(f.stage.cleanup).not.toHaveBeenCalled();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();dispose();
  });

  it('fails a hung cleanup without claiming completion, and permits a later retry',async()=>{
    vi.useFakeTimers();
    try {
      const f=fixture();f.stage.cleanup.mockImplementationOnce(()=>new Promise(()=>{}));
      const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
      const begin={action:'begin',capability,manifest,guard,deadline:10_000};p.onMessage.fire({id:1,...begin});
      await vi.advanceTimersByTimeAsync(0);expect(f.stage.cleanup).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);expect(p.messages[0]).toMatchObject({ok:false});
      expect(f.stage.beginRecoverable).not.toHaveBeenCalled();p.onMessage.fire({id:2,...begin});
      await vi.advanceTimersByTimeAsync(0);expect(f.stage.cleanup).toHaveBeenCalledTimes(2);
      expect(p.messages[1]).toMatchObject({ok:true});dispose();
    } finally {vi.useRealTimers();}
  });

  it('bounds a hung configuration wait and can retry once configuration becomes ready',async()=>{
    vi.useFakeTimers();
    try {
      const f=fixture();let ready!:()=>void;f.deps.ready=new Promise<void>(resolve=>{ready=resolve;});
      const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
      const begin={action:'begin',capability,manifest,guard,deadline:10_000};p.onMessage.fire({id:1,...begin});
      await vi.advanceTimersByTimeAsync(30_000);expect(p.messages[0]).toMatchObject({ok:false});
      expect(f.stage.cleanup).not.toHaveBeenCalled();ready();await vi.advanceTimersByTimeAsync(0);
      p.onMessage.fire({id:2,...begin});await vi.advanceTimersByTimeAsync(0);
      expect(p.messages[1]).toMatchObject({ok:true});expect(f.stage.cleanup).toHaveBeenCalledOnce();dispose();
    } finally {vi.useRealTimers();}
  });

  it('returns a generic failure when configuration readiness rejects',async()=>{
    const f=fixture();f.deps.ready=Promise.reject(Error('private config failure'));
    const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toEqual([{id:1,ok:false,error:'operation-failed'}]));
    expect(f.stage.cleanup).not.toHaveBeenCalled();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();dispose();
  });

  it('broadcasts only after a delayed stage commit, including after a port disconnect',async()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never);
    let complete!:()=>void;
    const pending=new Promise<void>(resolve=>{complete=resolve;});
    f.stage.commit.mockImplementation(async()=>{await pending;f.notify();return {inserted:1,updated:0,skipped:0};});
    const p=f.port();f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));
    p.onMessage.fire({id:2,action:'commit'});
    await vi.waitFor(()=>expect(f.stage.commit).toHaveBeenCalledOnce());
    p.onDisconnect.fire();expect(f.notifications).toEqual([]);
    complete();await vi.waitFor(()=>expect(f.notifications).toHaveLength(1));
    expect(f.notifications).toEqual([{type:'fluentReadMaterialsChanged'}]);
    dispose();expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});
