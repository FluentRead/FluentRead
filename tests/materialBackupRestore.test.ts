import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MaterialImportResult} from '@/src/features/vocabulary/materialProtocol';

const mocks=vi.hoisted(()=>({prepare:vi.fn(),send:vi.fn(),connect:vi.fn(),client:vi.fn(),port:{},private:false}));
vi.mock('@/src/features/vocabulary/materialBackupReader',()=>({prepareMaterialBackup:mocks.prepare,sendMaterialBackup:mocks.send}));
vi.mock('@/src/features/vocabulary/materialImportPortClient',()=>({createMaterialImportPortClient:mocks.client}));
vi.mock('webextension-polyfill',()=>({default:{runtime:{connect:mocks.connect},extension:{get inIncognitoContext(){return mocks.private;}}}}));
import {acknowledgeMaterialBackup, discardMaterialBackup, queryMaterialBackup, restoreLargeMaterialBackup} from '@/src/features/vocabulary/materialBackupRestore';

const result:MaterialImportResult={inserted:1,updated:0,skipped:0};
const prepared={manifest:{records:1,frames:1,bytes:2,digest:'0'.repeat(64)},plan:{records:[{length:2}]}};
const file=new Blob(['{}']);
const guard={generation:4,capturedAt:100};
const capability={id:'00000000-0000-4000-8000-000000000000',token:'a'.repeat(64)};
function client() {
  type Progress=(value:{done:number;total:number})=>void;
  return {begin:vi.fn(async()=>({state:'open',nextSeq:0})),append:vi.fn(async()=>({nextSeq:1})),seal:vi.fn(async(_progress?:Progress)=>({state:'sealed'})),commit:vi.fn(async(_progress?:Progress)=>result),discard:vi.fn(async()=> 'discarded'),resume:vi.fn(async()=>({state:'committed',result})),status:vi.fn(async()=>({state:'committed',result})),acknowledge:vi.fn(async()=> 'released-or-unavailable'),close:vi.fn()};
}
function deferred<T>() {let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
let active:ReturnType<typeof client>;
beforeEach(()=>{vi.clearAllMocks();mocks.private=false;active=client();mocks.client.mockReturnValue(active);mocks.connect.mockReturnValue(mocks.port);mocks.prepare.mockResolvedValue(prepared);mocks.send.mockResolvedValue(undefined);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('material backup recovery orchestration',()=>{
  it.each(['before','after'] as const)('preserves a completed restore when signal listener removal throws %s removal',async mode=>{
    vi.useFakeTimers();
    const controller=new AbortController(),native=controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
      if(mode==='after')native(type,listener,options);
      throw Error('listener cleanup failed');
    });
    let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    expect(out).toEqual({kind:'committed',result,capability:cap});
    expect(active.commit).toHaveBeenCalledOnce();expect(active.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the original request failure if listener removal throws',async()=>{
    const controller=new AbortController(),failure=Error('begin failed');
    vi.spyOn(controller.signal,'removeEventListener').mockImplementation(()=>{throw Error('listener cleanup failed');});
    active.begin.mockRejectedValueOnce(failure);
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',error:failure,cleanupPending:true});
    expect(active.close).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();
  });
  it('finishes cancellation and observes a late request rejection even if listener removal throws',async()=>{
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>();
    vi.spyOn(controller.signal,'removeEventListener').mockImplementation(()=>{throw Error('listener cleanup failed');});
    active.begin.mockImplementationOnce(()=>begin.promise);
    const pending=restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    await vi.waitFor(()=>expect(active.begin).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({kind:'cancelled',cleanupPending:true});
    expect(active.close).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();
    begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it.each(['before','after'] as const)('cleans up and observes late work when signal registration throws %s registration',async mode=>{
    vi.useFakeTimers();
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>(),failure=Error('listener registration failed');
    const native=controller.signal.addEventListener.bind(controller.signal),remove=vi.spyOn(controller.signal,'removeEventListener');
    vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
      if(mode==='after')native(type,listener,options);
      throw failure;
    });
    active.begin.mockImplementationOnce(()=>begin.promise);
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',error:failure,cleanupPending:true});
    expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(active.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it('keeps observed cancellation if signal registration aborts and then throws',async()=>{
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>(),native=controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
      native(type,listener,options);controller.abort();throw Error('listener registration failed');
    });
    active.begin.mockImplementationOnce(()=>begin.promise);
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    expect(out).toMatchObject({kind:'cancelled',cleanupPending:true});expect(active.close).toHaveBeenCalledOnce();
    begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it('prioritizes cancellation when registration aborts before installing a listener and throws',async()=>{
    vi.useFakeTimers();
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>(),remove=vi.spyOn(controller.signal,'removeEventListener');
    vi.spyOn(controller.signal,'addEventListener').mockImplementation(()=>{controller.abort();throw Error('listener registration failed');});
    active.begin.mockImplementationOnce(()=>begin.promise);
    let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    expect(out).toEqual({kind:'cancelled',cleanupPending:true,capability:cap});
    expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);expect(active.close).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();
    begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it.each(['return','throw'] as const)('removes a listener installed after synchronous cancellation when registration will %s',async mode=>{
    vi.useFakeTimers();
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>();
    const nativeAdd=controller.signal.addEventListener.bind(controller.signal),nativeRemove=controller.signal.removeEventListener.bind(controller.signal);
    let installed=false,removedAfterInstall=false;
    vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
      if(installed){removedAfterInstall=true;installed=false;}
      nativeRemove(type,listener,options);
    });
    vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
      controller.abort();
      if(typeof listener==='function')listener.call(controller.signal,new Event('abort'));
      else listener?.handleEvent(new Event('abort'));
      nativeAdd(type,listener,options);installed=true;
      if(mode==='throw')throw Error('registration failed after cancellation');
    });
    active.begin.mockImplementationOnce(()=>begin.promise);
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    expect(out).toMatchObject({kind:'cancelled',cleanupPending:true});
    expect(removedAfterInstall).toBe(true);expect(installed).toBe(false);expect(vi.getTimerCount()).toBe(0);
    expect(active.close).toHaveBeenCalledOnce();begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it('cleans up the timer and preserves a setup failure if the signal status getter throws twice',async()=>{
    vi.useFakeTimers();
    const controller=new AbortController(),begin=deferred<{state:string;nextSeq:number}>(),failure=Error('signal status failed');
    let armed=false,reads=0;
    vi.spyOn(controller.signal,'aborted','get').mockImplementation(()=>{
      if(armed&&reads++<2)throw failure;
      return false;
    });
    active.begin.mockImplementationOnce(()=>{armed=true;return begin.promise;});
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',error:failure,cleanupPending:true});
    expect(vi.getTimerCount()).toBe(0);expect(active.close).toHaveBeenCalledOnce();
    begin.reject(Error('late begin failure'));await Promise.resolve();
  });
  it('saves capability before begin, validates all frames before commit, and releases only after acknowledgement',async()=>{
    const phases:string[]=[];let received:any;
    mocks.prepare.mockImplementation(async()=>{phases.push('prepare');return prepared;});
    active.begin.mockImplementation(async()=>{phases.push('begin');return {state:'open',nextSeq:0};});
    mocks.send.mockImplementation(async(_file,_plan,emit)=>{phases.push('send');await emit({seq:0});phases.push('verified');});
    active.seal.mockImplementation(async()=>{phases.push('seal');return {state:'sealed'};});
    active.commit.mockImplementation(async()=>{phases.push('commit');return result;});
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{phases.push('capability');received=value;}});
    expect(out).toEqual({kind:'committed',result,capability:received});expect(phases).toEqual(['prepare','capability','begin','send','verified','seal','commit']);
    expect(active.begin).toHaveBeenCalledWith(received,prepared.manifest,guard,expect.any(Number));expect(active.close).toHaveBeenCalledOnce();expect(active.acknowledge).not.toHaveBeenCalled();
    await acknowledgeMaterialBackup(received);expect(active.resume).toHaveBeenCalledWith(received);expect(active.acknowledge).toHaveBeenCalledOnce();
  });
  it('retains the original session capability if the published copy changes during recovery',async()=>{
    const gate=deferred<void>();let published:{id:string;token:string}|undefined;
    mocks.send.mockImplementationOnce(async()=>gate.promise);
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:value=>{published=value;}});
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    const started={...published!};
    published!.id='modified';published!.token='modified';
    gate.resolve();
    const outcome=await pending;
    expect(outcome).toEqual({kind:'committed',result,capability:started});
    expect(outcome.kind==='committed'&&outcome.capability).not.toBe(published);
    expect(active.begin).toHaveBeenCalledWith(started,prepared.manifest,guard,expect.any(Number));
    expect(active.commit).toHaveBeenCalledOnce();expect(active.close).toHaveBeenCalledOnce();
  });
  it('does not seal or commit after full source verification fails and discards the staged session',async()=>{
    mocks.send.mockRejectedValue(Error('file changed'));const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:false});expect(active.discard).toHaveBeenCalledOnce();expect(active.seal).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();
  });
  it('discards emitted frames if the actual reader detects a size change before sealing',async()=>{
    const reader=await vi.importActual<typeof import('@/src/features/vocabulary/materialBackupReader')>('@/src/features/vocabulary/materialBackupReader');
    class ChangingAfterAppend extends Blob {
      changed=false;
      get size(){return super.size+Number(this.changed);}
    }
    const source=new ChangingAfterAppend(['{"format":"fluentread-learning-materials","version":1,"materials":[{"a":1}]}']);
    mocks.prepare.mockImplementation(reader.prepareMaterialBackup);
    mocks.send.mockImplementation(reader.sendMaterialBackup);
    active.append.mockImplementation(async()=>{source.changed=true;return {nextSeq:1};});
    const out=await restoreLargeMaterialBackup(source,guard,{onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:false,error:expect.objectContaining({message:'备份文件在读取过程中改变'})});
    expect(active.append).toHaveBeenCalledOnce();expect(active.discard).toHaveBeenCalledOnce();
    expect(active.seal).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([true,false])('handles an unreadable error name while preserving discard status: %s',async discarded=>{
    const failure=Error('read failed');
    Object.defineProperty(failure,'name',{get(){throw Error('error metadata inaccessible');}});
    mocks.send.mockRejectedValueOnce(failure);
    if(!discarded)active.discard.mockRejectedValueOnce(Error('disconnect'));
    let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:!discarded,error:expect.objectContaining({name:'Error',message:'材料恢复操作失败'})});
    if(!discarded)expect(out).toMatchObject({capability:cap});
    else expect(out).not.toHaveProperty('capability');
    expect(active.discard).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('keeps the capability when begin is interrupted and never assumes a session was discarded',async()=>{
    const block=deferred<any>(),controller=new AbortController();active.begin.mockReturnValue(block.promise);
    let cap:any;const pending=restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    await vi.waitFor(()=>expect(active.begin).toHaveBeenCalledOnce());controller.abort();
    const out=await pending;expect(out).toEqual({kind:'cancelled',cleanupPending:true,capability:cap});expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
    block.resolve({state:'open',nextSeq:0});await Promise.resolve();expect(active.commit).not.toHaveBeenCalled();
  });
  it('preserves the capability when begin synchronously aborts before the wait is installed',async()=>{
    const controller=new AbortController();active.begin.mockImplementationOnce(async()=>{controller.abort();return {state:'open',nextSeq:0};});let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    expect(out).toEqual({kind:'cancelled',cleanupPending:true,capability:cap});expect(active.discard).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('marks a timed out commit unknown and permits reconnecting with the original capability',async()=>{
    vi.useFakeTimers();const block=deferred<MaterialImportResult>();active.commit.mockReturnValue(block.promise);let cap:any;
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    await vi.advanceTimersByTimeAsync(0);expect(active.commit).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({kind:'unknown',capability:cap,commitDispatched:true});expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
    expect(await queryMaterialBackup(cap)).toEqual({state:'committed',result});expect(active.resume).toHaveBeenCalledWith(cap);block.resolve(result);
  });
  it('allows slow seal and commit while validated work progresses, then reports only the actual commit result',async()=>{
    vi.useFakeTimers();const seal=deferred<{state:'sealed'}>(),commit=deferred<MaterialImportResult>();
    mocks.prepare.mockResolvedValueOnce({...prepared,manifest:{...prepared.manifest,frames:2}});
    let sealProgress!:(progress:{done:number;total:number})=>void,commitProgress!:(progress:{done:number;total:number})=>void;
    active.seal.mockImplementationOnce(progress=>{sealProgress=progress!;return seal.promise;});
    active.commit.mockImplementationOnce(progress=>{commitProgress=progress!;return commit.promise;});
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    await vi.advanceTimersByTimeAsync(0);expect(active.seal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);sealProgress({done:1,total:2});await vi.advanceTimersByTimeAsync(20_000);
    expect(active.commit).not.toHaveBeenCalled();sealProgress({done:2,total:2});seal.resolve({state:'sealed'});
    await vi.advanceTimersByTimeAsync(0);expect(active.commit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);commitProgress({done:1,total:2});await vi.advanceTimersByTimeAsync(20_000);
    commitProgress({done:2,total:2});commit.resolve(result);await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({kind:'committed',result});expect(active.close).toHaveBeenCalledOnce();
  });
  it('ignores late progress from a completed seal while commit is pending',async()=>{
    vi.useFakeTimers();const commit=deferred<MaterialImportResult>();let sealProgress!:(value:{done:number;total:number})=>void;
    active.seal.mockImplementationOnce(async progress=>{sealProgress=progress!;return {state:'sealed'};});
    active.commit.mockReturnValueOnce(commit.promise);
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    await vi.advanceTimersByTimeAsync(0);expect(active.commit).toHaveBeenCalledOnce();
    sealProgress({done:1,total:1});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({kind:'unknown',commitDispatched:true});
    commit.resolve(result);expect(active.close).toHaveBeenCalledOnce();
  });
  it.each(['seal','commit'] as const)('rejects inconsistent %s progress without claiming a commit result',async phase=>{
    if(phase==='seal')active.seal.mockImplementationOnce(async progress=>{progress!({done:1,total:2});return {state:'sealed'};});
    else active.commit.mockImplementationOnce(async progress=>{progress!({done:1,total:2});return result;});
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    if(phase==='seal'){
      expect(out).toMatchObject({kind:'failed',cleanupPending:false,error:{message:'材料恢复进度无效'}});
      expect(active.discard).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();
    } else {
      expect(out).toMatchObject({kind:'unknown',commitDispatched:true});expect(active.discard).not.toHaveBeenCalled();
    }
    expect(active.close).toHaveBeenCalledOnce();
  });
  it('still times out a stalled seal without inferring a committed result',async()=>{
    vi.useFakeTimers();const seal=deferred<{state:'sealed'}>();active.seal.mockReturnValueOnce(seal.promise);
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    await vi.advanceTimersByTimeAsync(0);expect(active.seal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({kind:'failed',error:{name:'TimeoutError'},cleanupPending:true});
    expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();seal.resolve({state:'sealed'});
  });
  it('does not treat 100% frame progress as a committed result if commit stalls',async()=>{
    vi.useFakeTimers();const commit=deferred<MaterialImportResult>();
    active.commit.mockImplementationOnce(progress=>{progress!({done:1,total:1});return commit.promise;});
    let capability:unknown;const pending=restoreLargeMaterialBackup(file,guard,{onCapability:value=>{capability=value;}});
    await vi.advanceTimersByTimeAsync(0);expect(active.commit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({kind:'unknown',capability,commitDispatched:true});
    expect(active.close).toHaveBeenCalledOnce();expect(active.discard).not.toHaveBeenCalled();commit.resolve(result);
  });
  it('cancels a progressing seal without starting a later commit',async()=>{
    vi.useFakeTimers();const seal=deferred<{state:'sealed'}>(),controller=new AbortController();
    active.seal.mockImplementationOnce(progress=>{progress!({done:1,total:1});return seal.promise;});
    const pending=restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:()=>{}});
    await vi.advanceTimersByTimeAsync(0);expect(active.seal).toHaveBeenCalledOnce();controller.abort();
    expect(await pending).toMatchObject({kind:'cancelled',cleanupPending:true});expect(active.commit).not.toHaveBeenCalled();
    seal.resolve({state:'sealed'});await vi.advanceTimersByTimeAsync(0);expect(active.commit).not.toHaveBeenCalled();
  });
  it('aborts an in-flight append without claiming cleanup or dispatching commit',async()=>{
    const block=deferred<any>(),controller=new AbortController();active.append.mockReturnValue(block.promise);
    mocks.send.mockImplementation(async(_file,_plan,emit)=>{await emit({seq:0});});let cap:any;
    const pending=restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    await vi.waitFor(()=>expect(active.append).toHaveBeenCalledOnce());controller.abort();
    expect(await pending).toEqual({kind:'cancelled',cleanupPending:true,capability:cap});expect(active.discard).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
    block.resolve({nextSeq:1});await Promise.resolve();
  });
  it('reports unknown if discard cannot be confirmed',async()=>{
    mocks.send.mockRejectedValue(Error('broken input'));active.discard.mockRejectedValue(Error('disconnect'));
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});expect(out).toMatchObject({kind:'failed',cleanupPending:true,capability:expect.any(Object)});expect(active.commit).not.toHaveBeenCalled();
  });
  it('rejects oversized reservations before opening any port',async()=>{
    mocks.prepare.mockRejectedValue(Object.assign(new Error('材料备份超过当前恢复容量限制'),{name:'MaterialBackupCapacityError'}));
    const cap=vi.fn(),out=await restoreLargeMaterialBackup(file,guard,{onCapability:cap});
    expect(out).toMatchObject({kind:'failed',error:expect.objectContaining({name:'MaterialBackupCapacityError'}),cleanupPending:false});expect(cap).not.toHaveBeenCalled();expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('clears the saved capability when begin receives a confirmed capacity rejection',async()=>{
    const error=Object.assign(new Error('容量不足'),{name:'MaterialBackupCapacityError'});
    active.begin.mockRejectedValueOnce(error);const onCapability=vi.fn();
    expect(await restoreLargeMaterialBackup(file,guard,{onCapability})).toEqual({kind:'failed',error,cleanupPending:false});
    expect(onCapability).toHaveBeenCalledOnce();expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('keeps the capability when cancellation races a capacity rejection during begin',async()=>{
    const controller=new AbortController();let capability:unknown;
    active.begin.mockImplementationOnce(()=>{
      controller.abort();
      return Promise.reject(Object.assign(new Error('容量不足'),{name:'MaterialBackupCapacityError'}));
    });
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{capability=value;}});
    expect(capability).toBeDefined();
    expect(out).toEqual({kind:'cancelled',cleanupPending:true,capability});
    expect(active.discard).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([true,false])('handles append quota failure according to whether discard succeeds: %s',async discarded=>{
    const error=Object.assign(new Error('quota'),{name:'QuotaExceededError'});let cap:unknown;
    active.append.mockRejectedValueOnce(error);mocks.send.mockImplementationOnce(async(_file,_plan,emit)=>{await emit({seq:0});});
    if(!discarded)active.discard.mockRejectedValueOnce(Error('disconnect'));
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    expect(out).toEqual({kind:'failed',error,cleanupPending:!discarded,...(!discarded?{capability:cap}:{})});
    expect(active.discard).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();
  });
  it('preserves the capability if commit reports a quota failure',async()=>{
    active.commit.mockRejectedValueOnce(Object.assign(new Error('quota'),{name:'QuotaExceededError'}));let cap:unknown;
    expect(await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}})).toEqual({kind:'unknown',capability:cap,commitDispatched:true});
    expect(active.discard).not.toHaveBeenCalled();
  });
  it('does not discard or misreport a commit which wins the explicit discard race',async()=>{
    active.resume.mockResolvedValueOnce({state:'open',nextSeq:0} as any);active.discard.mockResolvedValueOnce('committed' as any);
    const state=await discardMaterialBackup({id:'00000000-0000-4000-8000-000000000000',token:'a'.repeat(64)});
    expect(state).toEqual({state:'committed',result});expect(active.status).toHaveBeenCalledOnce();expect(active.close).toHaveBeenCalledOnce();
  });
  it('refuses private context before opening a port',async()=>{
    mocks.private=true;const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:false});expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('does not start scanning or opening a port when already cancelled',async()=>{
    const controller=new AbortController();controller.abort();const onCapability=vi.fn();
    expect(await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability})).toEqual({kind:'cancelled',cleanupPending:false});
    expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.connect).not.toHaveBeenCalled();expect(onCapability).not.toHaveBeenCalled();
  });
  it('checks cancellation after scanning, before opening a session',async()=>{
    const controller=new AbortController();mocks.prepare.mockImplementation(async()=>{controller.abort();return prepared;});
    const onCapability=vi.fn();expect(await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability})).toEqual({kind:'cancelled',cleanupPending:false});
    expect(onCapability).not.toHaveBeenCalled();expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('checks cancellation after handing the capability to the caller',async()=>{
    const controller=new AbortController();let generated:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{generated=value;controller.abort();}});
    expect(generated).toEqual(expect.objectContaining({id:expect.any(String),token:expect.any(String)}));
    expect(out).toEqual({kind:'cancelled',cleanupPending:false});expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([undefined,{state:'open',nextSeq:1},{state:'committed',result}] as const)('does not write frames for an unexpected begin result %#',async state=>{
    active.begin.mockResolvedValueOnce(state as never);let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    expect(out).toEqual({kind:'unknown',capability:cap,commitDispatched:false});expect(mocks.send).not.toHaveBeenCalled();expect(active.seal).not.toHaveBeenCalled();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([undefined,{inserted:-1,updated:0,skipped:0},{inserted:1.5,updated:0,skipped:0},{inserted:1,updated:Infinity,skipped:0}] as const)('reports an invalid committed result as unknown %#',async value=>{
    active.commit.mockResolvedValueOnce(value as never);let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:v=>{cap=v;}});
    expect(out).toEqual({kind:'unknown',capability:cap,commitDispatched:true});expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('discards an opened session when sealing fails without sending a commit',async()=>{
    active.seal.mockRejectedValueOnce(Error('cannot seal'));const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:false,error:expect.objectContaining({message:'cannot seal'})});
    expect(active.discard).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('cleans up if starting seal throws synchronously',async()=>{
    active.seal.mockImplementationOnce(()=>{throw Error('cannot start seal');});
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:()=>{}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:false,error:expect.objectContaining({message:'cannot start seal'})});
    expect(active.discard).toHaveBeenCalledOnce();expect(active.commit).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('retains the capability when a failed send races a completed commit during discard',async()=>{
    mocks.send.mockRejectedValueOnce(Error('send failed'));active.discard.mockResolvedValueOnce('committed' as never);let cap:unknown;
    const out=await restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    expect(out).toMatchObject({kind:'failed',cleanupPending:true,capability:cap});expect(active.commit).not.toHaveBeenCalled();
  });
  it('reports cancellation during a pending commit as unknown and ignores its late rejection',async()=>{
    const controller=new AbortController(),block=deferred<MaterialImportResult>();active.commit.mockReturnValueOnce(block.promise);let cap:unknown;
    const pending=restoreLargeMaterialBackup(file,guard,{signal:controller.signal,onCapability:value=>{cap=value;}});
    await vi.waitFor(()=>expect(active.commit).toHaveBeenCalledOnce());controller.abort();
    expect(await pending).toEqual({kind:'unknown',capability:cap,commitDispatched:true});expect(active.discard).not.toHaveBeenCalled();
    block.reject(Error('late disconnect'));await Promise.resolve();
  });
  it('returns a timeout during an unopened begin without asserting cleanup',async()=>{
    vi.useFakeTimers();const block=deferred<{state:'open';nextSeq:number}>();active.begin.mockReturnValueOnce(block.promise);let cap:unknown;
    const pending=restoreLargeMaterialBackup(file,guard,{onCapability:value=>{cap=value;}});
    await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({kind:'failed',cleanupPending:true,capability:cap,error:expect.objectContaining({name:'TimeoutError'})});
    expect(active.discard).not.toHaveBeenCalled();block.resolve({state:'open',nextSeq:0});await Promise.resolve();
  });
  it.each([undefined,{state:'invalid'},{state:'committed',result:{inserted:-1,updated:0,skipped:0}}] as const)('rejects invalid resumed states %#',async state=>{
    active.resume.mockResolvedValueOnce(state as never);
    await expect(queryMaterialBackup(capability)).rejects.toThrow('材料恢复状态不可用');expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([{state:'open',nextSeq:0},{state:'sealed'},{state:'committed',result:{inserted:-1,updated:0,skipped:0}},undefined] as const)('does not acknowledge an uncommitted or invalid receipt %#',async state=>{
    active.resume.mockResolvedValueOnce(state as never);
    await expect(acknowledgeMaterialBackup(capability)).rejects.toThrow('材料恢复回执不可用');
    expect(active.acknowledge).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('returns an already committed receipt without discarding it',async()=>{
    expect(await discardMaterialBackup(capability)).toEqual({state:'committed',result});
    expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([undefined,{state:'invalid'},{state:'committed',result:{inserted:-1,updated:0,skipped:0}}] as const)('does not discard with an invalid resumed state %#',async state=>{
    active.resume.mockResolvedValueOnce(state as never);
    await expect(discardMaterialBackup(capability)).rejects.toThrow('材料恢复状态不可用');expect(active.discard).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it('returns a confirmed discard for a sealed session',async()=>{
    active.resume.mockResolvedValueOnce({state:'sealed'} as never);expect(await discardMaterialBackup(capability)).toEqual({state:'discarded'});
    expect(active.discard).toHaveBeenCalledOnce();expect(active.close).toHaveBeenCalledOnce();
  });
  it('rejects an unrecognized discard acknowledgement',async()=>{
    active.resume.mockResolvedValueOnce({state:'open',nextSeq:0} as never);active.discard.mockResolvedValueOnce('unexpected' as never);
    await expect(discardMaterialBackup(capability)).rejects.toThrow('材料恢复状态不可用');expect(active.status).not.toHaveBeenCalled();expect(active.close).toHaveBeenCalledOnce();
  });
  it.each([undefined,{state:'open',nextSeq:1},{state:'committed',result:{inserted:-1,updated:0,skipped:0}}] as const)('rejects an invalid receipt after a commit/discard race %#',async state=>{
    active.resume.mockResolvedValueOnce({state:'open',nextSeq:0} as never);active.discard.mockResolvedValueOnce('committed' as never);active.status.mockResolvedValueOnce(state as never);
    await expect(discardMaterialBackup(capability)).rejects.toThrow('材料恢复状态不可用');expect(active.close).toHaveBeenCalledOnce();
  });
});
