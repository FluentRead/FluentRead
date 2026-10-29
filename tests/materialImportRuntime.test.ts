import {afterEach, describe, expect, it, vi} from 'vitest';
import browser from 'webextension-polyfill';
import * as materialStage from '@/src/features/vocabulary/materialImportStage';
import {MaterialDatabase} from '@/src/features/vocabulary/materialRepository';
import {installBrowserMaterialImportRuntime, installMaterialImportRuntime, MATERIAL_IMPORT_CLEANUP_ALARM} from '@/src/app/background/materialImportRuntime';
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
    onStartup:event<()=>void>(),onInstalled:event<()=>void>(),
    sendMessage:vi.fn(async (message:unknown)=>{notifications.push(message);})};
  const privateContext={value:false};
  let notify:()=>void=()=>undefined, notifyCorruption:()=>void=()=>undefined;
  const unsubscribe=vi.fn();
  const stage={observeCommitted:vi.fn((listener:()=>void)=>{notify=listener;return unsubscribe;}),
    beginRecoverable:vi.fn(async()=>capability),resume:vi.fn(async()=>undefined),append:vi.fn(async()=>({nextSeq:1})),
    seal:vi.fn(async()=>undefined),commit:vi.fn(async()=>({inserted:1,updated:0,skipped:0})),
    status:vi.fn(async()=>({state:'open',nextSeq:0})),discard:vi.fn(async()=> 'discarded'),acknowledge:vi.fn(async()=> 'released-or-unavailable'),cleanup:vi.fn(async()=>({sessions:0,receipts:0}))};
  const closeDatabase=vi.fn(),createStage=vi.fn((onCleanupCorruption:()=>void)=>{notifyCorruption=onCleanupCorruption;return {stage,close:closeDatabase};});
  const deps={runtime,isPrivateContext:()=>privateContext.value,createStage,ready:Promise.resolve()};
  const port=(sender:unknown={id:'fixture',url:'chrome-extension://fixture/options.html'},name=PORT_NAME)=>{
    const onMessage=event<(message:unknown)=>void>(),onDisconnect=event<()=>void>(),messages:unknown[]=[];
    const result={name,sender,onMessage,onDisconnect,postMessage:vi.fn((message:unknown)=>{messages.push(message);}),disconnect:vi.fn(()=>onDisconnect.fire())};
    return {port:result,onMessage,onDisconnect,messages};
  };
  return {deps,runtime,privateContext,createStage,closeDatabase,stage,unsubscribe,port,notify:()=>notify(),notifyCorruption:()=>notifyCorruption(),notifications};
}

function maintenanceFixture() {
  const onAlarm=event<(alarm:{name:string})=>void>();
  const state:{marker:boolean; period?:number}={marker:false};
  const alarms={onAlarm,
    get:vi.fn(async()=>state.period===undefined?undefined:{periodInMinutes:state.period}),
    create:vi.fn(async(_name:string,{periodInMinutes}:{periodInMinutes:number})=>{state.period=periodInMinutes;})};
  const storage={get:vi.fn(async()=>({fluentreadMaterialImportMaintenance:state.marker})),
    set:vi.fn(async()=>{state.marker=true;})};
  return {state,alarms,storage,warn:vi.fn()};
}

describe('material import background registration',()=>{
  afterEach(()=>vi.restoreAllMocks());

  it('does not begin after disposal reenters the trusted-sender privacy check',async()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never),p=f.port();
    f.runtime.onConnect.fire(p.port);
    vi.spyOn(f.deps,'isPrivateContext').mockImplementationOnce(()=>{dispose();return false;});
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await Promise.resolve();await Promise.resolve();
    expect(f.stage.cleanup).not.toHaveBeenCalled();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();
    expect(p.messages).toHaveLength(0);expect(f.closeDatabase).toHaveBeenCalledOnce();
  });

  it('cancels readiness when the port disconnects during abort-listener registration',async()=>{
    const f=fixture();let ready!:()=>void;
    f.deps.ready=new Promise<void>(resolve=>{ready=resolve;});
    const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();
    f.runtime.onConnect.fire(p.port);
    const add=AbortSignal.prototype.addEventListener;let interrupted=false;
    const registration=vi.spyOn(AbortSignal.prototype,'addEventListener').mockImplementation(function(this:AbortSignal,...args:Parameters<AbortSignal['addEventListener']>){
      if(!interrupted&&args[0]==='abort'){interrupted=true;p.port.disconnect();}
      return add.apply(this,args);
    });
    try {
      p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
      await Promise.resolve();ready();await Promise.resolve();await Promise.resolve();
      expect(interrupted).toBe(true);expect(f.stage.cleanup).not.toHaveBeenCalled();
      expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(p.messages).toHaveLength(0);
    } finally {registration.mockRestore();dispose();}
  });

  it('does not recreate a stage when maintenance finishes scheduling after disposal',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;
    let finish!:()=>void;
    m.alarms.create.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{finish=resolve;});});
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.alarms.create).toHaveBeenCalledOnce());
    dispose();finish();
    await vi.waitFor(()=>expect(m.warn).toHaveBeenCalledOnce());
    expect(f.createStage).not.toHaveBeenCalled();expect(f.stage.cleanup).not.toHaveBeenCalled();
  });

  it('never begins if the port disconnects while attaching a cleanup cancellation listener',async()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never),p=f.port();
    f.runtime.onConnect.fire(p.port);
    const add=AbortSignal.prototype.addEventListener;let registrations=0,intercepted=false,wasAborted=false;
    vi.spyOn(AbortSignal.prototype,'addEventListener').mockImplementation(function(this:AbortSignal,...args:Parameters<AbortSignal['addEventListener']>){
      if(args[0]==='abort'&&++registrations===4){intercepted=true;p.port.disconnect();wasAborted=this.aborted;}
      return add.apply(this,args);
    });
    try {
      p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
      await vi.waitFor(()=>expect(intercepted).toBe(true));
      expect(wasAborted).toBe(true);
      await Promise.resolve();await Promise.resolve();
      expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(p.messages).toHaveLength(0);
    } finally {vi.restoreAllMocks();dispose();}
  });

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

  it.each(['corruptSessions','corruptReceipts','corruptStarts'] as const)('reports %s without disclosing stored data',async key=>{
    const f=fixture(),m=maintenanceFixture();
    f.stage.cleanup.mockImplementationOnce(async()=>{f.notifyCorruption();return {sessions:0,receipts:0,[key]:1};});
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never),p=f.port();
    f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));
    expect(p.messages[0]).toMatchObject({ok:true});
    expect(m.warn).toHaveBeenCalledOnce();
    expect(m.warn).toHaveBeenCalledWith('[FluentRead] 材料恢复暂存元数据损坏，请检查材料与备份。');
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain(capability.token);
    dispose();
  });

  it('does not turn a completed cleanup into a failed restore when diagnostics are unavailable',async()=>{
    const f=fixture(),m=maintenanceFixture();
    f.stage.cleanup.mockImplementationOnce(async()=>{f.notifyCorruption();return {sessions:1,receipts:0,corruptSessions:1};});
    m.warn.mockImplementation(()=>{throw Error('diagnostic sink unavailable');});
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never),p=f.port();
    f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));
    expect(p.messages[0]).toMatchObject({ok:true});
    expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();expect(m.warn).toHaveBeenCalledOnce();
    dispose();
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
  it('routes discard and acknowledgement through the same readiness and privacy gate',async()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never);
    for(const action of ['discard','acknowledge'] as const){
      const p=f.port();f.runtime.onConnect.fire(p.port);
      p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
      await vi.waitFor(()=>expect(p.messages).toHaveLength(1));
      p.onMessage.fire({id:2,action});await vi.waitFor(()=>expect(p.messages).toHaveLength(2));
      expect(p.messages[1]).toMatchObject({ok:true});p.onDisconnect.fire();
    }
    expect(f.stage.discard).toHaveBeenCalledOnce();expect(f.stage.acknowledge).toHaveBeenCalledOnce();dispose();
  });
  it('does not allow notification transport failure to change an already committed result',()=>{
    const f=fixture();f.runtime.sendMessage.mockImplementation(()=>{throw Error('transport unavailable');});
    const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
    expect(()=>f.notify()).not.toThrow();expect(f.runtime.sendMessage).toHaveBeenCalledOnce();dispose();
  });
  it('stops pending readiness waits when the runtime is disposed',async()=>{
    const f=fixture();let ready!:()=>void;f.deps.ready=new Promise<void>(resolve=>{ready=resolve;});
    const dispose=installMaterialImportRuntime(f.deps as never),p=f.port();f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});dispose();ready();
    await Promise.resolve();await Promise.resolve();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(f.stage.cleanup).not.toHaveBeenCalled();
  });
  it('wires the browser composition root and disposes its lazy service',async()=>{
    const f=fixture(),m=maintenanceFixture();
    Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false},alarms:m.alarms,storage:{local:m.storage}});
    installBrowserMaterialImportRuntime(Promise.resolve());
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());
    const denied=f.port({id:'fixture',url:'chrome-extension://fixture/popup.html'});f.runtime.onConnect.fire(denied.port);
    expect(denied.port.disconnect).toHaveBeenCalledOnce();
    const trusted=f.port();f.runtime.onConnect.fire(trusted.port);expect(trusted.port.disconnect).not.toHaveBeenCalled();
    // Idempotent install returns the existing browser composition root's disposer.
    const dispose=installMaterialImportRuntime(f.deps as never);dispose();expect(f.runtime.onConnect.listeners.size).toBe(0);
  });
  it('injects a lazy origin quota estimate and handles unavailable browser APIs',async()=>{
    const f=fixture(),m=maintenanceFixture();
    const storage={estimate:vi.fn(async()=>({quota:800_000_000,usage:12_000_000}))};
    vi.stubGlobal('navigator',{storage});
    const create=vi.spyOn(materialStage,'createStage');
    Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false},alarms:m.alarms,storage:{local:m.storage}});
    installBrowserMaterialImportRuntime(Promise.resolve());
    try {
      await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());
      expect(storage.estimate).not.toHaveBeenCalled();
      const p=f.port();f.runtime.onConnect.fire(p.port);
      expect(create).toHaveBeenCalledOnce();expect(storage.estimate).not.toHaveBeenCalled();
      const options=create.mock.calls[0][1]!;
      expect(await options.estimate!()).toEqual({quota:800_000_000,usage:12_000_000});
      expect(storage.estimate).toHaveBeenCalledOnce();
      vi.stubGlobal('navigator',{});
      await expect(options.estimate!()).rejects.toThrow('storage estimate unavailable');
      vi.stubGlobal('navigator',undefined);
      await expect(options.estimate!()).rejects.toThrow('storage estimate unavailable');
    } finally {installMaterialImportRuntime(f.deps as never)();vi.unstubAllGlobals();}
  });
  it('does not access quota or material storage for a private browser context',async()=>{
    const f=fixture(),m=maintenanceFixture(),estimate=vi.fn(async()=>({quota:800_000_000,usage:0}));
    vi.stubGlobal('navigator',{storage:{estimate}});
    const create=vi.spyOn(materialStage,'createStage');
    Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:true},alarms:m.alarms,storage:{local:m.storage}});
    installBrowserMaterialImportRuntime(Promise.resolve());
    try {
      const p=f.port();f.runtime.onConnect.fire(p.port);
      expect(p.port.disconnect).toHaveBeenCalledOnce();expect(create).not.toHaveBeenCalled();expect(estimate).not.toHaveBeenCalled();
      expect(m.storage.get).not.toHaveBeenCalled();
    } finally {installMaterialImportRuntime(f.deps as never)();vi.unstubAllGlobals();}
  });
  it('closes the browser database if its stage cannot initialize',async()=>{
    const f=fixture(),m=maintenanceFixture();
    Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false},alarms:m.alarms,storage:{local:m.storage}});
    const create=vi.spyOn(materialStage,'createStage').mockImplementationOnce(()=>{throw Error('cannot initialize');});
    const close=vi.spyOn(MaterialDatabase.prototype,'close');
    installBrowserMaterialImportRuntime(Promise.resolve());await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());
    const p=f.port();f.runtime.onConnect.fire(p.port);
    expect(create).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(p.port.disconnect).toHaveBeenCalledOnce();
    installMaterialImportRuntime(f.deps as never)();
  });
  it('releases stage resources even when a listener cannot be unregistered',()=>{
    const f=fixture(),m=maintenanceFixture(),dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    const p=f.port();f.runtime.onConnect.fire(p.port);
    vi.spyOn(m.alarms.onAlarm,'removeListener').mockImplementation(()=>{throw Error('removed');});
    vi.spyOn(f.runtime.onStartup,'removeListener').mockImplementation(()=>{throw Error('removed');});
    vi.spyOn(f.runtime.onInstalled,'removeListener').mockImplementation(()=>{throw Error('removed');});
    expect(()=>dispose()).not.toThrow();expect(f.unsubscribe).toHaveBeenCalledOnce();expect(f.closeDatabase).toHaveBeenCalledOnce();
  });
  it('rejects an unverifiable sender even if its disconnect operation fails',()=>{
    const f=fixture(),dispose=installMaterialImportRuntime(f.deps as never),p=f.port();
    Object.defineProperty(p.port,'sender',{get(){throw Error('sender inaccessible');}});
    p.port.disconnect.mockImplementation(()=>{throw Error('already closed');});
    expect(()=>f.runtime.onConnect.fire(p.port)).not.toThrow();expect(f.createStage).not.toHaveBeenCalled();dispose();
  });
  it('continues rejecting a failed initialization when closing the database and port also fail',()=>{
    const f=fixture();f.stage.observeCommitted.mockImplementationOnce(()=>{throw Error('stage init');});
    f.closeDatabase.mockImplementationOnce(()=>{throw Error('db closed');});
    const dispose=installMaterialImportRuntime(f.deps as never),broken=f.port();
    broken.port.disconnect.mockImplementation(()=>{throw Error('port closed');});
    expect(()=>f.runtime.onConnect.fire(broken.port)).not.toThrow();
    const good=f.port();f.runtime.onConnect.fire(good.port);expect(f.createStage).toHaveBeenCalledTimes(2);
    expect(good.port.disconnect).not.toHaveBeenCalled();dispose();
  });
});

describe('material import expiry scheduling',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('does not create a database or alarm before a trusted begin and schedules before writing',async()=>{
    const f=fixture(),m=maintenanceFixture();
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalled());
    expect(f.createStage).not.toHaveBeenCalled();expect(m.alarms.create).not.toHaveBeenCalled();
    const p=f.port();f.runtime.onConnect.fire(p.port);
    p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));expect(p.messages[0]).toMatchObject({ok:true});
    expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);
    expect(m.storage.set.mock.invocationCallOrder[0]).toBeLessThan(m.alarms.create.mock.invocationCallOrder[0]);
    expect(m.alarms.create.mock.invocationCallOrder[0]).toBeLessThan(f.stage.beginRecoverable.mock.invocationCallOrder[0]);
    m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledTimes(2));
    expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);
    dispose();expect(m.alarms.onAlarm.listeners.size).toBe(0);
  });
  it('reconstructs a missing periodic alarm on worker restart without dropping the marker',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledOnce());
    expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);
    expect(m.alarms.create).toHaveBeenCalledOnce();
    expect(f.runtime.onStartup.listeners.size).toBe(1);expect(f.runtime.onInstalled.listeners.size).toBe(1);
    dispose();expect(f.runtime.onStartup.listeners.size).toBe(0);expect(f.runtime.onInstalled.listeners.size).toBe(0);
  });
  it.each(['onStartup','onInstalled'] as const)('recovers a lost alarm on browser %s',async eventName=>{
    const f=fixture(),m=maintenanceFixture();const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalled());expect(f.createStage).not.toHaveBeenCalled();
    m.state.marker=true;f.runtime[eventName].fire();
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledOnce());expect(m.state.period).toBe(60);dispose();
  });
  it('keeps the marker and refuses begin if alarm installation fails, then recovers after restart',async()=>{
    const f=fixture(),m=maintenanceFixture();let dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalled());m.alarms.create.mockRejectedValueOnce(Error('unavailable'));
    const p=f.port();f.runtime.onConnect.fire(p.port);p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));expect(p.messages[0]).toMatchObject({ok:false});
    expect(m.state.marker).toBe(true);expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(m.warn).toHaveBeenCalledOnce();dispose();
    dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.state.period).toBe(60));expect(m.state.marker).toBe(true);dispose();
  });
  it('refuses begin without writing if local marker storage fails',async()=>{
    const f=fixture(),m=maintenanceFixture();const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalled());m.storage.set.mockRejectedValueOnce(Error('unavailable'));
    const p=f.port();f.runtime.onConnect.fire(p.port);p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));expect(p.messages[0]).toMatchObject({ok:false});
    expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(m.alarms.create).not.toHaveBeenCalled();expect(m.warn).toHaveBeenCalledOnce();dispose();
  });
  it('does not open or schedule material maintenance in a private context',async()=>{
    const f=fixture(),m=maintenanceFixture();f.privateContext.value=true;m.state.marker=true;
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});await Promise.resolve();await Promise.resolve();
    expect(m.storage.get).not.toHaveBeenCalled();expect(m.alarms.create).not.toHaveBeenCalled();expect(f.createStage).not.toHaveBeenCalled();dispose();
  });
  it('retains a periodic retry and records a fixed warning when cleanup fails',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;f.stage.cleanup.mockRejectedValueOnce(Error('private user content'));
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.warn).toHaveBeenCalledOnce());
    expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);
    expect(m.warn.mock.calls[0][0]).not.toContain('private user content');dispose();
  });
  it.each(['storage','alarm'] as const)('retries %s lookup failures on the next alarm without opening the database early',async which=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;
    if(which==='storage')m.storage.get.mockRejectedValueOnce(Error('unavailable'));
    else m.alarms.get.mockRejectedValueOnce(Error('unavailable'));
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.warn).toHaveBeenCalledOnce());expect(f.createStage).not.toHaveBeenCalled();
    m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledOnce());expect(m.state.period).toBe(60);dispose();
  });
  it('replaces an obsolete alarm period before cleaning',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;m.state.period=120;
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledOnce());
    expect(m.alarms.create).toHaveBeenCalledWith(MATERIAL_IMPORT_CLEANUP_ALARM,{periodInMinutes:60});expect(m.state.period).toBe(60);dispose();
  });
  it('reports a failed config readiness without claiming cleanup, retaining the periodic plan',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;f.deps.ready=Promise.reject(Error('bad config'));
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.warn).toHaveBeenCalledOnce());
    expect(m.state.period).toBe(60);expect(f.createStage).not.toHaveBeenCalled();dispose();
  });
  it('bounds a hung marker lookup and retries maintenance on a later alarm',async()=>{
    vi.useFakeTimers();
    try {
      const f=fixture(),m=maintenanceFixture();m.state.marker=true;
      let release!:(value:{fluentreadMaterialImportMaintenance:boolean})=>void;
      m.storage.get.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
      const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
      await vi.advanceTimersByTimeAsync(30_000);expect(m.warn).toHaveBeenCalledOnce();expect(f.createStage).not.toHaveBeenCalled();
      m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});await vi.advanceTimersByTimeAsync(0);
      expect(f.stage.cleanup).toHaveBeenCalledOnce();expect(m.state.period).toBe(60);
      release({fluentreadMaterialImportMaintenance:true});await vi.advanceTimersByTimeAsync(0);
      expect(f.stage.cleanup).toHaveBeenCalledOnce();dispose();
    } finally {vi.useRealTimers();}
  });
  it('preserves cleanup and retry even if the diagnostic callback itself fails',async()=>{
    const f=fixture(),m=maintenanceFixture();m.state.marker=true;
    f.stage.cleanup.mockRejectedValueOnce(Error('failure'));m.warn.mockImplementation(()=>{throw Error('diagnostics unavailable');});
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.warn).toHaveBeenCalledOnce());
    m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});
    await vi.waitFor(()=>expect(f.stage.cleanup).toHaveBeenCalledTimes(2));expect(m.state.marker).toBe(true);dispose();
  });
  it('uses the browser diagnostic adapter without exposing the underlying error',async()=>{
    const f=fixture(),m=maintenanceFixture();m.storage.get.mockRejectedValueOnce(Error('private note text'));
    Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false},alarms:m.alarms,storage:{local:m.storage}});
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    installBrowserMaterialImportRuntime(Promise.resolve());await vi.waitFor(()=>expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0][0])).not.toContain('private note text');installMaterialImportRuntime(f.deps as never)();
  });
  it('ignores unrelated alarms and never opens materials after the context becomes private',async()=>{
    const f=fixture(),m=maintenanceFixture(),dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());m.state.marker=true;f.privateContext.value=true;
    m.alarms.onAlarm.fire({name:'unrelated'});m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM});f.runtime.onStartup.fire();
    await Promise.resolve();await Promise.resolve();expect(f.createStage).not.toHaveBeenCalled();expect(m.alarms.create).not.toHaveBeenCalled();dispose();
  });
  it('ignores queued startup and alarm callbacks after disposal',async()=>{
    const f=fixture(),m=maintenanceFixture();const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());
    const alarm=[...m.alarms.onAlarm.listeners][0],startup=[...f.runtime.onStartup.listeners][0];
    dispose();m.state.marker=true;alarm({name:MATERIAL_IMPORT_CLEANUP_ALARM});startup();
    await Promise.resolve();await Promise.resolve();expect(f.createStage).not.toHaveBeenCalled();expect(m.storage.get).toHaveBeenCalledOnce();
  });
  it('does not access materials if private-context checks fail during alarm or startup',async()=>{
    const f=fixture(),m=maintenanceFixture(),privacy=vi.fn(()=>false);
    const dispose=installMaterialImportRuntime({...f.deps,isPrivateContext:privacy,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalledOnce());m.state.marker=true;
    privacy.mockImplementation(()=>{throw Error('privacy status unavailable');});
    expect(()=>m.alarms.onAlarm.fire({name:MATERIAL_IMPORT_CLEANUP_ALARM})).not.toThrow();
    expect(()=>f.runtime.onStartup.fire()).not.toThrow();
    await Promise.resolve();expect(f.createStage).not.toHaveBeenCalled();dispose();
  });
  it('rejects new sessions if the alarm listener cannot be installed',async()=>{
    const f=fixture(),m=maintenanceFixture();vi.spyOn(m.alarms.onAlarm,'addListener').mockImplementation(()=>{throw Error('unavailable');});
    const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);expect(m.warn).toHaveBeenCalledOnce();
    const p=f.port();f.runtime.onConnect.fire(p.port);p.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(p.messages).toHaveLength(1));expect(p.messages[0]).toMatchObject({ok:false});
    expect(f.stage.beginRecoverable).not.toHaveBeenCalled();expect(m.storage.set).not.toHaveBeenCalled();dispose();
  });
  it.each(['set','create'] as const)('keeps the lease while a %s operation remains pending and rejects a cancelled queued begin',async which=>{
    vi.useFakeTimers();
    try {
      const f=fixture(),m=maintenanceFixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
      if(which==='set')m.storage.set.mockImplementationOnce(async()=>{await held;m.state.marker=true;});
      else m.alarms.create.mockImplementationOnce(async(_name,{periodInMinutes})=>{await held;m.state.period=periodInMinutes;});
      const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);await vi.advanceTimersByTimeAsync(0);
      const first=f.port(),second=f.port();f.runtime.onConnect.fire(first.port);f.runtime.onConnect.fire(second.port);
      const begin={action:'begin',capability,manifest,guard,deadline:10_000};first.onMessage.fire({id:1,...begin});
      await vi.advanceTimersByTimeAsync(0);second.onMessage.fire({id:1,...begin});await vi.advanceTimersByTimeAsync(30_001);
      expect(m.warn).toHaveBeenCalled();expect(f.stage.beginRecoverable).not.toHaveBeenCalled();
      second.onDisconnect.fire();release();await vi.advanceTimersByTimeAsync(0);
      expect(first.messages[0]).toMatchObject({ok:true});expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();
      expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);dispose();
    } finally {vi.useRealTimers();}
  });
  it.each(['set','create'] as const)('old worker late %s cannot disable a newer worker cleanup plan',async which=>{
    const f=fixture(),m=maintenanceFixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    if(which==='set')m.storage.set.mockImplementationOnce(async()=>{await held;m.state.marker=true;});
    else m.alarms.create.mockImplementationOnce(async(_name,{periodInMinutes})=>{await held;m.state.period=periodInMinutes;});
    const old=installMaterialImportRuntime({...f.deps,maintenance:m} as never);
    await vi.waitFor(()=>expect(m.storage.get).toHaveBeenCalled());
    const a=f.port();f.runtime.onConnect.fire(a.port);a.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(which==='set'?m.storage.set:m.alarms.create).toHaveBeenCalledOnce());
    a.onDisconnect.fire();old();
    const current=installMaterialImportRuntime({...f.deps,maintenance:m} as never),b=f.port();f.runtime.onConnect.fire(b.port);
    b.onMessage.fire({id:1,action:'begin',capability,manifest,guard,deadline:10_000});
    await vi.waitFor(()=>expect(b.messages).toHaveLength(1));expect(b.messages[0]).toMatchObject({ok:true});
    release();await new Promise(resolve=>setTimeout(resolve,0));
    expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();current();
  });
  it.each(['set','create'] as const)('bounds repeated abandoned requests while %s is hung and recovers capacity after settlement',async which=>{
    vi.useFakeTimers();
    try {
      const f=fixture(),m=maintenanceFixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
      if(which==='set')m.storage.set.mockImplementationOnce(async()=>{await held;m.state.marker=true;});
      else m.alarms.create.mockImplementationOnce(async(_name,{periodInMinutes})=>{await held;m.state.period=periodInMinutes;});
      const dispose=installMaterialImportRuntime({...f.deps,maintenance:m} as never);await vi.advanceTimersByTimeAsync(0);
      const begin={action:'begin',capability,manifest,guard,deadline:10_000},first=f.port();
      f.runtime.onConnect.fire(first.port);first.onMessage.fire({id:1,...begin});await vi.advanceTimersByTimeAsync(0);
      expect(which==='set'?m.storage.set:m.alarms.create).toHaveBeenCalledOnce();first.onDisconnect.fire();
      let failed=0;
      for(let i=0;i<40;i++){
        const next=f.port();f.runtime.onConnect.fire(next.port);next.onMessage.fire({id:1,...begin});
        await vi.advanceTimersByTimeAsync(0);
        if(next.messages.some(message=>(message as {ok?:boolean}).ok===false))failed++;
        next.onDisconnect.fire();
      }
      expect(failed).toBeGreaterThan(0);expect(f.stage.beginRecoverable).not.toHaveBeenCalled();
      // A flood cannot emit an unbounded number of identical backpressure warnings.
      expect(m.warn.mock.calls.length).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(30_001);expect(m.warn).toHaveBeenCalled();
      release();await vi.advanceTimersByTimeAsync(0);
      const final=f.port();f.runtime.onConnect.fire(final.port);final.onMessage.fire({id:1,...begin});
      await vi.advanceTimersByTimeAsync(0);expect(final.messages[0]).toMatchObject({ok:true});
      expect(f.stage.beginRecoverable).toHaveBeenCalledOnce();expect(m.state.marker).toBe(true);expect(m.state.period).toBe(60);dispose();
    } finally {vi.useRealTimers();}
  });
});
