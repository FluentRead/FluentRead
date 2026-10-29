import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {createStage as createProductStage, type Capability, type Frame, type Manifest} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';
import type {MaterialOperationGuard} from '@/src/features/vocabulary/materialProtocol';

let serial=0;
const names=new Set<string>(), open:Dexie[]=[];
const opts={frameBytes:128,recordBytes:1024*1024,totalBytes:2*1024*1024,frameCount:10000,totalFrames:10000,slots:256,inflight:8,ttlMs:1000,receiptTtlMs:10000};
type TestStageOptions=Parameters<typeof createProductStage>[1] & {beforeAppend?:()=>Promise<void>};
function createStage(db:MaterialDatabase, options:TestStageOptions={}) {
  const {beforeAppend,...productOptions}=options;
  if(beforeAppend){
    // 测试侧延迟认证事务的回包，模拟 IDB 结果迟到；真实写事务仍由产品负责。
    const transaction=db.transaction.bind(db) as (...args:any[])=>Promise<any>;
    db.transaction=((...args:any[])=>{
      const result=transaction(...args);
      return args[0]==='r'&&args[1]?.name==='stageSessions'&&typeof args[2]==='function'
        ? Promise.resolve(result).then(async value=>{await beforeAppend();return value;}) : result;
    }) as typeof db.transaction;
  }
  const stage=createProductStage(db,productOptions), clock=options.clock??Date.now, ttl=options.limits?.ttlMs??30*60*1000;
  // 测试便捷入口仍走实际的可恢复协议；能力在发送之前由调用方创建。
  const begin=(manifest:Manifest,guard:MaterialOperationGuard,request:{signal?:AbortSignal}={})=>
    stage.beginRecoverable(manifest,guard,createMaterialImportCapability(),{deadline:clock()+Math.min(ttl,5*60*1000),signal:request.signal});
  return {...stage,begin,frames:db.table<any,[string,number]>('stageFrames'),sessions:db.table<any,string>('stageSessions'),receipts:db.table<any,string>('stageReceipts'),budgets:db.table<any,string>('stageBudget'),limits:{...opts,...options.limits}};
}
const lengthBytes=(n:number)=>new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
function frameRecords(records:unknown[], frameBytes:number):{manifest:Manifest;frames:Frame[]}{
  const output:Frame[]=[],hash=sha256.create(),encoder=new TextEncoder();let bytes=0;
  for(let record=0;record<records.length;record++){
    const encoded=encoder.encode(JSON.stringify(records[record])),total=Math.ceil(encoded.length/frameBytes);
    hash.update(lengthBytes(encoded.length));hash.update(encoded);bytes+=encoded.length;
    for(let part=0;part<total;part++)output.push({seq:output.length,record,part,total,recordBytes:encoded.length,bytes:encoded.slice(part*frameBytes,(part+1)*frameBytes)});
  }
  return {manifest:{records:records.length,frames:output.length,bytes,digest:bytesToHex(hash.digest())},frames:output};
}

function database(name=`material-stage-test-${++serial}`){names.add(name);const db=new MaterialDatabase(name);open.push(db);return db;}
function legacyDatabase(name:string){const db=new Dexie(name);db.version(1).stores({materials:'id,&identityKey,*aliases,updatedAt',meta:'key'});open.push(db);return db as unknown as MaterialDatabase;}
function instance(clock={now:100}, extra:Parameters<typeof createStage>[1]={}){
  const db=database(),stage=createStage(db,{limits:opts,clock:()=>clock.now,...extra});return {db,stage,repo:new MaterialRepository(db),clock};
}
afterEach(async()=>{for(const db of open.splice(0))db.close();for(const name of names)await Dexie.delete(name);names.clear();});
async function material(id:string,at=10){
  const x=instance();return x.repo.capture({source:{kind:'article',url:`https://example.test/${id}`,title:id},reference:{kind:'note',id:`note-${id}`,note:`note ${id}`},capturedAt:at},at);
}
async function upload(stage:ReturnType<typeof createStage>, records:unknown[], cap?:Capability){
  const input=frameRecords(records,stage.limits.frameBytes),token=cap??await stage.begin(input.manifest,{generation:0,capturedAt:100});
  for(const frame of input.frames)await stage.append(token,frame);
  return {token,input};
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};

describe('clearing materials and import staging',()=>{
  it('rolls back acknowledgement if a reentrant clock invalidates its receipt and budget',async()=>{
    const db=database();let armed=false,triggered=false,cap!:Capability,stage!:ReturnType<typeof createStage>;
    const writes:PromiseLike<unknown>[]=[];
    stage=createStage(db,{limits:opts,clock:()=>{
      if(armed&&!triggered&&Dexie.currentTransaction){
        triggered=true;
        const deletion=stage.receipts.delete(cap.id),adjustment=stage.budgets.put({key:'stage',reserved:0,reservedFrames:0,slots:0});
        void deletion.catch(()=>{});void adjustment.catch(()=>{});writes.push(deletion,adjustment);
      }
      return 100;
    }});
    const empty=frameRecords([],opts.frameBytes).manifest;
    cap=await stage.begin(empty,{generation:0,capturedAt:100});await stage.seal(cap);await stage.commit(cap);
    armed=true;
    await expect(stage.acknowledge(cap)).rejects.toThrow('budget corruption');
    await Promise.allSettled(writes);expect(triggered).toBe(true);
    expect(await stage.receipts.get(cap.id)).toBeDefined();expect(await stage.budgets.get('stage')).toMatchObject({slots:1});
  });
  it.each(['bytes','frames'] as const)('rolls back a commit if a reentrant progress observer corrupts the %s budget',async dimension=>{
    const target=instance(),record=await material(`reentrant-budget-${dimension}`),{token,input}=await upload(target.stage,[record]);
    await target.stage.seal(token);
    let queued=false;const writes:PromiseLike<unknown>[]=[];
    const progress=()=>{
      if(queued)return;queued=true;
      // Simulate a reentrant same-transaction observer damaging persisted metadata.
      writes.push(target.stage.sessions.update(token.id,{[dimension]:0}),target.stage.budgets.update('stage',{[dimension==='bytes'?'reserved':'reservedFrames']:0}));
    };
    await expect(target.stage.commit(token,{onProgress:progress})).rejects.toThrow('budget corruption');
    await Promise.allSettled(writes);
    expect(queued).toBe(true);
    expect(await target.repo.get(record.id)).toBeNull();
    expect(await target.stage.receipts.count()).toBe(0);
    expect(await target.stage.frames.count()).toBe(input.frames.length);
    expect(await target.stage.sessions.get(token.id)).toMatchObject({bytes:input.manifest.bytes,frames:input.manifest.frames,phase:'sealed'});
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:input.manifest.bytes,reservedFrames:input.manifest.frames});
  });
  it.each(['throw','async-reject','function'] as const)('keeps a real import valid when a progress observer returns %s',async mode=>{
    const target=instance(),record=await material(`progress-observer-${mode}`),{token}=await upload(target.stage,[record]);
    const observer=vi.fn(()=>{if(mode==='throw')throw Error('observer failed');if(mode==='async-reject')return Promise.reject(Error('observer failed'));return ()=>{};});
    await target.stage.seal(token,{onProgress:observer});
    expect(observer).toHaveBeenCalled();expect((await target.stage.status(token)).state).toBe('sealed');
    expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    expect(await target.repo.get(record.id)).not.toBeNull();
  });
  it('isolates non-promise function results from commit and cleanup observers',async()=>{
    const clock={now:100},db=database(),cleanupObserver=vi.fn(()=>()=>{}),stage=createStage(db,{limits:opts,clock:()=>clock.now,onCleanupCorruption:cleanupObserver});
    const notified=vi.fn(()=>()=>{}),stop=stage.observeCommitted(notified),empty=frameRecords([],opts.frameBytes).manifest;
    const done=await stage.begin(empty,{generation:0,capturedAt:100});await stage.seal(done);await stage.commit(done);
    expect(notified).toHaveBeenCalledOnce();
    const corrupt=await stage.begin(empty,{generation:0,capturedAt:100});await stage.sessions.update(corrupt.id,{expiresAt:NaN});
    expect(await stage.cleanup()).toMatchObject({sessions:1,corruptSessions:1});expect(cleanupObserver).toHaveBeenCalledOnce();stop();
  });
  it('rejects a missing capability and malformed persisted owner hashes without exposing session data',async()=>{
    const target=instance(),payload=frameRecords([],opts.frameBytes),cap=await target.stage.begin(payload.manifest,{generation:0,capturedAt:100});
    await expect(target.stage.resume(undefined as unknown as Capability)).rejects.toThrow('session unavailable');
    for(const ownerHash of ['a','a'.repeat(65)]){
      await target.stage.sessions.update(cap.id,{ownerHash});
      await expect(target.stage.resume(cap)).rejects.toThrow('session unavailable');
    }
    expect(await target.stage.frames.count()).toBe(0);
  });
  it('rejects corrupt stored session expiry before reserving capacity for another import',async()=>{
    const target=instance(),payload=frameRecords([],opts.frameBytes),cap=await target.stage.begin(payload.manifest,{generation:0,capturedAt:100});
    await target.stage.sessions.update(cap.id,{expiresAt:NaN});
    await expect(target.stage.begin(payload.manifest,{generation:0,capturedAt:100})).rejects.toThrow('invalid expiry');
    expect(await target.stage.sessions.count()).toBe(1);
    expect(await target.stage.budgets.get('stage')).toMatchObject({slots:1,reserved:0,reservedFrames:0});
  });
  it('reports only real increasing frame reads during seal and commit without claiming a transaction result',async()=>{
    const target=instance(),record=await material('progress'),{token,input}=await upload(target.stage,[record]);
    expect(input.frames.length).toBeGreaterThan(1);
    const sealed:Array<{done:number;total:number}>=[],committing:Array<{done:number;total:number}>=[];
    await target.stage.seal(token,{onProgress:progress=>sealed.push(progress)});
    expect(sealed[0]).toEqual({done:1,total:input.frames.length});
    expect(sealed.at(-1)).toEqual({done:input.frames.length,total:input.frames.length});
    expect(sealed.every((value,index)=>index===0||value.done>sealed[index-1].done)).toBe(true);
    expect((await target.stage.status(token)).state).toBe('sealed');
    expect(await target.stage.commit(token,{onProgress:progress=>committing.push(progress)})).toEqual({inserted:1,updated:0,skipped:0});
    expect(committing[0]).toEqual({done:1,total:input.frames.length});
    expect(committing.at(-1)).toEqual({done:input.frames.length,total:input.frames.length});
    expect(await target.repo.get(record.id)).not.toBeNull();
  });
  it.each(['seal','commit'] as const)('rolls back %s if the caller disconnects during real progress',async phase=>{
    const target=instance(),record=await material(`cancel-progress-${phase}`),{token}=await upload(target.stage,[record]);
    if(phase==='commit')await target.stage.seal(token);
    const controller=new AbortController(),reported=vi.fn(()=>controller.abort());
    await expect(target.stage[phase](token,{signal:controller.signal,onProgress:reported})).rejects.toThrow();
    expect(reported).toHaveBeenCalledOnce();
    await vi.waitFor(async()=>expect(await target.db.materials.count()).toBe(0));
    expect((await target.stage.status(token)).state).toBe(phase==='commit'?'sealed':'open');
  });
  it.each(['seal','commit'] as const)('does not treat 100%% %s frame progress as a successful transaction',async phase=>{
    const target=instance(),record=await material(`corrupt-progress-${phase}`),{token,input}=await upload(target.stage,[record]);
    if(phase==='commit')await target.stage.seal(token);
    const first=await target.stage.frames.get([token.id,0]);first.bytes=first.bytes.slice();
    const changed=first.bytes.indexOf('x'.charCodeAt(0));expect(changed).toBeGreaterThanOrEqual(0);first.bytes[changed]='y'.charCodeAt(0);
    await target.stage.frames.put(first);
    const reported:Array<{done:number;total:number}>=[];
    await expect(target.stage[phase](token,{onProgress:progress=>reported.push(progress)})).rejects.toThrow();
    expect(reported.at(-1)).toEqual({done:input.frames.length,total:input.frames.length});
    expect(await target.db.materials.count()).toBe(0);
    expect((await target.stage.status(token)).state).toBe(phase==='commit'?'sealed':'open');
  });
  it('rejects overlapping record applications without leaking writes',async()=>{
    const target=instance(),record=await material('consumer-guard'),guard={generation:0,capturedAt:100};
    await expect(target.repo.importRecords(async apply=>{
      const first=apply(record),second=apply(record);await Promise.all([first,second]);
    },100,guard)).rejects.toThrow('材料导入顺序或数量无效');
    expect(await target.db.materials.count()).toBe(0);
  });
  it('rejects record applications after the consumer finishes',async()=>{
    const target=instance(),record=await material('consumer-late'),guard={generation:0,capturedAt:100};
    let late!:(item:unknown)=>Promise<void>;
    expect(await target.repo.importRecords(async apply=>{late=apply;await apply(record);},100,guard)).toEqual({inserted:1,updated:0,skipped:0});
    await expect(late(record)).rejects.toThrow('材料导入顺序或数量无效');
  });
  it('rejects an unawaited record application without leaking writes',async()=>{
    const target=instance(),record=await material('consumer-unawaited'),guard={generation:0,capturedAt:100};
    let pending:Promise<void>|undefined;
    const another={...record,identityKey:'ignored',source:{...record.source,url:'https://example.test/unawaited'}};
    await expect(target.repo.importRecords(async apply=>{pending=apply(another);void pending.catch(()=>{});},100,guard)).rejects.toThrow('材料导入尚未完成');
    await pending?.catch(()=>{});expect(await Dexie.ignoreTransaction(()=>target.db.materials.count())).toBe(0);
  });
  it('rolls back an import that exceeds the record limit',async()=>{
    const target=instance(),record=await material('consumer-limit');
    await expect(target.repo.importRecords(async apply=>{
      await apply(record);for(let i=0;i<10000;i++)await apply(null);
    },100,{generation:0,capturedAt:100})).rejects.toThrow('材料导入顺序或数量无效');
    expect(await target.db.materials.count()).toBe(0);
  });
  it('atomically clears pending private frames across connections while retaining receipts and replay tombstones',async()=>{
    const clock={now:100},target=instance(clock),peer=database(target.db.name),repository=new MaterialRepository(peer);
    const guard={generation:0,capturedAt:100},empty=frameRecords([],opts.frameBytes).manifest;
    const capability=()=>({id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))});
    const completed=capability();await target.stage.beginRecoverable(empty,guard,completed,{deadline:1000});
    await target.stage.seal(completed);const result=await target.stage.commit(completed);
    const pending=capability(), payload=frameRecords([{note:'private staging note'}],opts.frameBytes);
    await target.stage.beginRecoverable(payload.manifest,guard,pending,{deadline:1000});
    await target.stage.append(pending,payload.frames[0]);
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(2);
    await target.stage.budgets.put({key:'stage',reserved:999,reservedFrames:999,slots:-1});
    await repository.clear(101);
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:1});
    expect(await target.stage.status(completed)).toEqual({state:'committed',result});
    expect(await target.stage.beginRecoverable(empty,guard,completed,{deadline:1000})).toEqual(completed);
    expect(await target.db.table('stageStarts').count()).toBe(2);
    await expect(target.stage.append(pending,payload.frames[0])).rejects.toThrow('session unavailable');
    await expect(target.stage.beginRecoverable(payload.manifest,guard,pending,{deadline:1000})).rejects.toThrow('session unavailable');
    await expect(target.stage.beginRecoverable(empty,guard,capability(),{deadline:1000})).rejects.toThrow('stale operation');
    await target.stage.acknowledge(completed);expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
    clock.now=102;const fresh=capability();await target.stage.beginRecoverable(empty,{generation:1,capturedAt:102},fresh,{deadline:1000});
    expect(await target.stage.status(fresh)).toEqual({state:'open',nextSeq:0});
  });
  it('rejects an authenticated append delayed across clear without recreating private frames',async()=>{
    const ready=deferred(),gate=deferred(),target=instance({now:100},{beforeAppend:()=>{ready.resolve();return gate.promise;}});
    const peer=database(target.db.name),repository=new MaterialRepository(peer),payload=frameRecords([{note:'delayed private note'}],opts.frameBytes);
    const cap=await target.stage.begin(payload.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(cap,payload.frames[0]);await ready.promise;
    await repository.clear(101);gate.resolve();
    await expect(pending).rejects.toThrow('session unavailable');
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);
    expect((await target.stage.budgets.get('stage'))?.slots??0).toBe(0);
  });
  it('rolls back material, frame, session and budget changes together when cleanup fails',async()=>{
    const target=instance(),record=await target.repo.capture({source:{kind:'article',url:'https://example.test/clear-rollback',title:'preserve'},capturedAt:10},10);
    const {token}=await upload(target.stage,[{note:'private staged data'}]);
    const fail=()=>{throw Error('injected stage budget failure');};target.stage.budgets.hook('deleting',fail);
    try{await expect(target.repo.clear(101)).rejects.toThrow('injected stage budget failure');}
    finally{target.stage.budgets.hook('deleting').unsubscribe(fail);}
    expect(await target.repo.get(record.id)).not.toBeNull();expect(await target.stage.frames.count()).toBe(1);
    expect(await target.stage.sessions.count()).toBe(1);expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
    expect(await target.repo.generation()).toBe(0);expect(await target.stage.status(token)).toMatchObject({state:'open'});
    await target.repo.clear(101);expect(await target.stage.frames.count()).toBe(0);expect(await target.repo.get(record.id)).toBeNull();
  });
  it('clears an empty staged session despite a missing or corrupt reservation',async()=>{
    const target=instance(),record=await target.repo.capture({source:{kind:'article',url:'https://example.test/clear-budget',title:'preserve'},capturedAt:10},10);
    const empty=frameRecords([],opts.frameBytes).manifest,cap=await target.stage.begin(empty,{generation:0,capturedAt:100});
    const budget=await target.stage.budgets.get('stage');expect(budget).toMatchObject({reserved:0,reservedFrames:0,slots:1});
    await target.stage.budgets.delete('stage');
    await target.repo.clear(101);
    expect(await target.stage.sessions.count()).toBe(0);expect(await target.stage.budgets.get('stage')).toBeUndefined();
    expect(await target.repo.get(record.id)).toBeNull();
    await expect(target.stage.status(cap)).rejects.toThrow('session unavailable');
  });
});

describe('committed material change notifications',()=>{
  it('notifies once after a new commit, including other stage instances, without passing private data',async()=>{
    const target=instance(),peerDb=database(target.db.name),peer=createStage(peerDb,{limits:opts,clock:()=>100});
    await peerDb.open();
    const local=vi.fn(),other=vi.fn();
    const stopLocal=target.stage.observeCommitted(local),stopOther=peer.observeCommitted(other);
    const {token}=await upload(target.stage,[await material('notify')]);await target.stage.seal(token);
    expect(local).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled();
    expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    expect(local).toHaveBeenCalledOnce();expect(local).toHaveBeenCalledWith();
    expect(other).toHaveBeenCalledOnce();expect(other).toHaveBeenCalledWith();
    expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    expect(local).toHaveBeenCalledOnce();expect(other).toHaveBeenCalledOnce();
    stopLocal();stopLocal();stopOther();
    const next=await upload(target.stage,[await material('notify-next')]);await target.stage.seal(next.token);await target.stage.commit(next.token);
    expect(local).toHaveBeenCalledOnce();expect(other).toHaveBeenCalledOnce();
  });
  it('honors observer removal during notification and refuses non-function subscribers',async()=>{
    const target=instance(),called=vi.fn();let stopSecond=()=>{};
    expect(()=>target.stage.observeCommitted(null as never)).toThrow('commit observer must be a function');
    const stopFirst=target.stage.observeCommitted(()=>stopSecond());
    stopSecond=target.stage.observeCommitted(called);
    try {
      const {token}=await upload(target.stage,[]);await target.stage.seal(token);await target.stage.commit(token);
      expect(called).not.toHaveBeenCalled();
    } finally {stopFirst();stopSecond();}
  });
  it('does not notify a rolled-back transaction and isolates observer failures from successful commits',async()=>{
    const target=instance(),successful=vi.fn(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const stopBad=target.stage.observeCommitted(()=>{throw Error('private observer details');});
    const stopGood=target.stage.observeCommitted(successful);
    try {
      const first=await upload(target.stage,[await material('rollback-notify')]);await target.stage.seal(first.token);
      const fail=()=>{throw Error('injected rollback');};target.db.materials.hook('creating',fail);
      try{await expect(target.stage.commit(first.token)).rejects.toThrow('injected rollback');}
      finally{target.db.materials.hook('creating').unsubscribe(fail);}
      expect(successful).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();
      expect(await target.stage.commit(first.token)).toEqual({inserted:1,updated:0,skipped:0});
      expect(successful).toHaveBeenCalledOnce();expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls.flat().join(' ')).not.toContain('private observer details');
    } finally {stopBad();stopGood();warn.mockRestore();}
  });
  it('notifies a real commit even when the caller loses the result to cancellation',async()=>{
    const target=instance(),observed=vi.fn(),stop=target.stage.observeCommitted(observed);
    const {token}=await upload(target.stage,[await material('late-commit-notify')]);await target.stage.seal(token);
    const controller=new AbortController(),original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(value=>{controller.abort();return value;})) as never);
    try {
      await expect(target.stage.commit(token,{signal:controller.signal})).rejects.toThrow('cancelled');
      await vi.waitFor(()=>expect(observed).toHaveBeenCalledOnce());
      expect(await target.stage.status(token)).toMatchObject({state:'committed'});
      expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
      expect(observed).toHaveBeenCalledOnce();
    } finally {transaction.mockRestore();stop();}
  });
  it.each([
    ['before','none'],['after','none'],['before','before'],['after','before'],['before','after'],['after','after'],
  ] as const)('releases append slot when registration throws %s installation and removal throws %s native removal',async (mode,removeMode)=>{
    const target=instance(),input=frameRecords([{note:'public'}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const signal=new AbortController(),failure=Error('registration failed'),nativeAdd=signal.signal.addEventListener.bind(signal.signal),nativeRemove=signal.signal.removeEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')nativeAdd(type,listener,options);throw failure;});
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(removeMode!=='before')nativeRemove(type,listener,options);if(removeMode!=='none')throw Error('removal failed');});
    try {
      await expect(target.stage.append(token,input.frames[0],{signal:signal.signal})).rejects.toBe(failure);
      expect(await target.stage.frames.count()).toBe(0);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
      const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();if(listener)nativeRemove('abort',listener);
      expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    } finally {const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();if(listener)nativeRemove('abort',listener);}
  });
  it.each(['before','after'] as const)('preserves appended frame and releases slot when signal removal throws %s native removal',async mode=>{
    const target=instance(),input=frameRecords([{note:'public'}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const signal=new AbortController(),native=signal.signal.removeEventListener.bind(signal.signal);
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('removal failed');});
    try {
      expect(await target.stage.append(token,input.frames[0],{signal:signal.signal})).toEqual({nextSeq:1});
      expect(await target.stage.frames.count()).toBe(1);const listener=remove.mock.calls[0]?.[1];remove.mockRestore();if(listener)native('abort',listener);
      expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    } finally {const listener=remove.mock.calls[0]?.[1];remove.mockRestore();if(listener)native('abort',listener);}
  });
  it.each(['before','after'] as const)('holds an append slot until cancelled authentication settles when signal removal throws %s native removal',async mode=>{
    const gate=deferred();let entered=false,finished=false;
    const target=instance({now:100},{beforeAppend:async()=>{entered=true;await gate.promise;finished=true;}});
    const input=frameRecords([{note:'public'}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const signal=new AbortController(),native=signal.signal.removeEventListener.bind(signal.signal);
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('removal failed');});
    const pending=target.stage.append(token,input.frames[0],{signal:signal.signal});void pending.catch(()=>{});
    try {
      await vi.waitFor(()=>expect(entered).toBe(true),{timeout:3000});signal.abort();await expect(pending).rejects.toThrow('cancelled');
      await expect(target.stage.append(token,input.frames[0])).rejects.toThrow('backpressure: append already pending');
      gate.resolve();await vi.waitFor(()=>expect(finished).toBe(true),{timeout:3000});
      await vi.waitFor(async()=>expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1}),{timeout:3000});
      expect(await target.stage.frames.count()).toBe(1);
    } finally {signal.abort();gate.resolve();remove.mockRestore();}
  });
  it('observes late authentication failure if cancellation occurs while starting resume',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),{token}=await upload(target.stage,[]),signal=new AbortController(),gate=deferred();let entered=false;
    const original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>{
      const work=original(...args);signal.abort();
      return Promise.resolve(work).then(async()=>{entered=true;await gate.promise;throw Error('late read failure');});
    }) as never);
    try {
      await expect(target.stage.resume(token,{signal:signal.signal})).rejects.toThrow('cancelled');
      await vi.waitFor(()=>expect(entered).toBe(true),{timeout:3000});
      await expect(target.stage.resume(token)).rejects.toThrow('backpressure: resume busy');
      gate.resolve();await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {gate.resolve();transaction.mockRestore();}
  });
  it.each(['before','after'] as const)('settles a successful resume when signal removal throws %s native removal',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]),signal=new AbortController(),native=signal.signal.removeEventListener.bind(signal.signal);
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('cleanup failed');});
    try {
      await expect(target.stage.resume(token,{signal:signal.signal})).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
      const listener=remove.mock.calls[0]?.[1];remove.mockRestore();if(listener)native('abort',listener);
      await expect(target.stage.resume(token)).resolves.toBeUndefined();
    } finally {const listener=remove.mock.calls[0]?.[1];remove.mockRestore();if(listener)native('abort',listener);}
  });
  it.each(['before','after'] as const)('preserves a resume failure when signal removal throws %s native removal',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]),signal=new AbortController(),original=Error('read failed'),native=signal.signal.removeEventListener.bind(signal.signal);
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('cleanup failed');});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>Promise.reject(original) as never);
    try {
      await expect(target.stage.resume(token,{signal:signal.signal})).rejects.toBe(original);
      const listener=remove.mock.calls[0]?.[1];remove.mockRestore();transaction.mockRestore();if(listener)native('abort',listener);
      await expect(target.stage.resume(token)).resolves.toBeUndefined();
    } finally {const listener=remove.mock.calls[0]?.[1];remove.mockRestore();transaction.mockRestore();if(listener)native('abort',listener);}
  });
  it.each(['before','after'] as const)('keeps the resume lane while cancelled authentication settles when removal throws %s native removal',async mode=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),{token}=await upload(target.stage,[]),signal=new AbortController(),gate=deferred();let entered=false;
    const native=signal.signal.removeEventListener.bind(signal.signal),original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('cleanup failed');});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(async value=>{entered=true;await gate.promise;return value;})) as never);
    const pending=target.stage.resume(token,{signal:signal.signal});void pending.catch(()=>{});
    try {
      await vi.waitFor(()=>expect(entered).toBe(true),{timeout:3000});signal.abort();await expect(pending).rejects.toThrow('cancelled');
      await expect(target.stage.resume(token)).rejects.toThrow('backpressure: resume busy');gate.resolve();
      await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {signal.abort();gate.resolve();remove.mockRestore();transaction.mockRestore();}
  });
  it.each([
    ['before','none'],['after','none'],['before','before'],['after','before'],['before','after'],['after','after'],
  ] as const)('keeps the resume lane if registration throws %s install and removal throws %s native removal',async (mode,removeMode)=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),{token}=await upload(target.stage,[]),signal=new AbortController(),gate=deferred(),failure=Error('registration failed');let entered=false;
    const nativeAdd=signal.signal.addEventListener.bind(signal.signal),nativeRemove=signal.signal.removeEventListener.bind(signal.signal),original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')nativeAdd(type,listener,options);throw failure;});
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(removeMode!=='before')nativeRemove(type,listener,options);if(removeMode!=='none')throw Error('cleanup failed');});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(async value=>{entered=true;await gate.promise;return value;})) as never);
    try {
      await expect(target.stage.resume(token,{signal:signal.signal})).rejects.toBe(failure);
      await vi.waitFor(()=>expect(entered).toBe(true),{timeout:3000});
      await expect(target.stage.resume(token)).rejects.toThrow('backpressure: resume busy');
      const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();if(listener)nativeRemove('abort',listener);
      gate.resolve();await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();transaction.mockRestore();if(listener)nativeRemove('abort',listener);gate.resolve();}
  });
  it.each(['before','after'] as const)('preserves resume cancellation when signal aborts %s registration then throws',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]),signal=new AbortController(),native=signal.signal.addEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);signal.abort();throw Error('registration failed');});
    try {
      await expect(target.stage.resume(token,{signal:signal.signal})).rejects.toThrow('cancelled');
      add.mockRestore();await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {add.mockRestore();}
  });
  it.each(['append','commit','resume'] as const)('preserves a signal state getter failure during %s',async action=>{
    const target=instance(),input=frameRecords(action==='append'?[{note:'public'}]:[],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    if(action==='commit')await target.stage.seal(token);
    const signal=new AbortController(),failure=Error('signal state failed');let reads=0;
    const throwAt=action==='commit'?3:2;
    Object.defineProperty(signal.signal,'aborted',{configurable:true,get(){if(++reads===throwAt)throw failure;return false;}});
    try {
      const work=action==='append'?target.stage.append(token,input.frames[0],{signal:signal.signal}):action==='commit'?target.stage.commit(token,{signal:signal.signal}):target.stage.resume(token,{signal:signal.signal});
      await expect(work).rejects.toBe(failure);
      delete (signal.signal as unknown as {aborted?:boolean}).aborted;
      if(action==='append')expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
      else if(action==='commit')await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
      else await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {delete (signal.signal as unknown as {aborted?:boolean}).aborted;}
  });
  it.each(['append','commit','resume'] as const)('preserves a %s registration error when rechecking signal state also throws',async action=>{
    const target=instance(),input=frameRecords(action==='append'?[{note:'public'}]:[],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    if(action==='commit')await target.stage.seal(token);
    const signal=new AbortController(),failure=Error('registration failed');let reads=0;
    const throwAt=action==='commit'?4:3;
    Object.defineProperty(signal.signal,'aborted',{configurable:true,get(){if(++reads===throwAt)throw Error('signal state failed');return false;}});
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation(()=>{throw failure;});
    try {
      const work=action==='append'?target.stage.append(token,input.frames[0],{signal:signal.signal}):action==='commit'?target.stage.commit(token,{signal:signal.signal}):target.stage.resume(token,{signal:signal.signal});
      await expect(work).rejects.toBe(failure);expect(reads).toBe(throwAt);
      delete (signal.signal as unknown as {aborted?:boolean}).aborted;add.mockRestore();
      if(action==='append')expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
      else if(action==='commit')await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
      else await vi.waitFor(async()=>expect(await target.stage.resume(token)).toBeUndefined(),{timeout:3000});
    } finally {delete (signal.signal as unknown as {aborted?:boolean}).aborted;add.mockRestore();}
  });
  it.each(['append','commit'] as const)('preserves observed %s cancellation before reading a throwing signal getter',async action=>{
    const target=instance(),input=frameRecords(action==='append'?[{note:'public'}]:[],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    if(action==='commit')await target.stage.seal(token);
    const signal=new AbortController(),native=signal.signal.addEventListener.bind(signal.signal),getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
    let reads=0;const throwAt=action==='commit'?4:3;
    Object.defineProperty(signal.signal,'aborted',{configurable:true,get(){if(++reads===throwAt)throw Error('signal state failed');return getter.call(signal.signal);}});
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{native(type,listener,options);signal.abort();});
    const transaction=vi.spyOn(target.db,'transaction');
    try {
      const work=action==='append'?target.stage.append(token,input.frames[0],{signal:signal.signal}):target.stage.commit(token,{signal:signal.signal});
      await expect(work).rejects.toThrow('cancelled');expect(reads).toBe(throwAt-1);expect(transaction).not.toHaveBeenCalled();
      delete (signal.signal as unknown as {aborted?:boolean}).aborted;add.mockRestore();transaction.mockRestore();
      if(action==='append')expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
      else await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {delete (signal.signal as unknown as {aborted?:boolean}).aborted;add.mockRestore();transaction.mockRestore();}
  });
  it('detects commit cancellation on the final state check before registration',async()=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    const signal=new AbortController();let reads=0;
    Object.defineProperty(signal.signal,'aborted',{configurable:true,get(){return ++reads===3;}});
    const transaction=vi.spyOn(target.db,'transaction');
    try {
      await expect(target.stage.commit(token,{signal:signal.signal})).rejects.toThrow('cancelled');
      expect(transaction).not.toHaveBeenCalled();
      delete (signal.signal as unknown as {aborted?:boolean}).aborted;transaction.mockRestore();
      await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {delete (signal.signal as unknown as {aborted?:boolean}).aborted;transaction.mockRestore();}
  });
  it.each(['append','commit'] as const)('detects %s cancellation before a listener is installed and registration returns normally',async action=>{
    const target=instance(),input=frameRecords(action==='append'?[{note:'public'}]:[],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    if(action==='commit')await target.stage.seal(token);
    const signal=new AbortController(),native=signal.signal.addEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{signal.abort();native(type,listener,options);});
    const transaction=vi.spyOn(target.db,'transaction');
    try {
      const work=action==='append'?target.stage.append(token,input.frames[0],{signal:signal.signal}):target.stage.commit(token,{signal:signal.signal});
      await expect(work).rejects.toThrow('cancelled');expect(transaction).not.toHaveBeenCalled();
      add.mockRestore();transaction.mockRestore();
      if(action==='append'){
        expect(await target.stage.frames.count()).toBe(0);
        expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
      } else {
        expect(await target.stage.receipts.count()).toBe(0);expect((await target.stage.sessions.get(token.id))?.phase).toBe('sealed');
        await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
      }
    } finally {add.mockRestore();transaction.mockRestore();}
  });
  it.each(['before','after'] as const)('preserves append cancellation when signal aborts %s registration then throws',async mode=>{
    const target=instance(),input=frameRecords([{note:'public'}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const signal=new AbortController(),failure=Error('registration failed'),native=signal.signal.addEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);signal.abort();throw failure;});
    const transaction=vi.spyOn(target.db,'transaction');
    try {
      await expect(target.stage.append(token,input.frames[0],{signal:signal.signal})).rejects.toThrow('cancelled');
      expect(transaction).not.toHaveBeenCalled();add.mockRestore();transaction.mockRestore();
      expect(await target.stage.frames.count()).toBe(0);
      expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    } finally {add.mockRestore();transaction.mockRestore();}
  });
  it.each(['before','after'] as const)('preserves commit cancellation when signal aborts %s registration then throws',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    const signal=new AbortController(),failure=Error('registration failed'),native=signal.signal.addEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);signal.abort();throw failure;});
    const transaction=vi.spyOn(target.db,'transaction');
    try {
      await expect(target.stage.commit(token,{signal:signal.signal})).rejects.toThrow('cancelled');
      expect(transaction).not.toHaveBeenCalled();add.mockRestore();transaction.mockRestore();
      expect(await target.stage.receipts.count()).toBe(0);expect((await target.stage.sessions.get(token.id))?.phase).toBe('sealed');
      await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {add.mockRestore();transaction.mockRestore();}
  });
  it('releases the commit slot if caller signal listener removal throws',async()=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    const signal=new AbortController();
    const native=signal.signal.removeEventListener.bind(signal.signal);let calls=0;
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{native(type,listener,options);calls++;throw Error('cleanup failed');});
    try {
      expect(await target.stage.commit(token,{signal:signal.signal})).toEqual({inserted:0,updated:0,skipped:0});
      expect(calls).toBe(1);
      await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {remove.mockRestore();}
  });
  it('preserves synchronous transaction failure if caller signal listener removal throws',async()=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    const signal=new AbortController(),original=Error('db failed');
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation(()=>{throw Error('cleanup failed');});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>{throw original;});
    try {
      await expect(target.stage.commit(token,{signal:signal.signal})).rejects.toBe(original);
      transaction.mockRestore();remove.mockRestore();
      await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {transaction.mockRestore();remove.mockRestore();}
  });
  it.each(['before','after'] as const)('releases cancelled commit when signal removal throws %s native removal',async mode=>{
    const target=instance(),record=await material('signal-cleanup-'+mode),{token}=await upload(target.stage,[record]);await target.stage.seal(token);
    const controller=new AbortController(),native=controller.signal.removeEventListener.bind(controller.signal);
    const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('cleanup failed');});
    const reported=vi.fn(()=>controller.abort());
    try {
      await expect(target.stage.commit(token,{signal:controller.signal,onProgress:reported})).rejects.toThrow('cancelled');
      expect(reported).toHaveBeenCalled();
      expect(await target.stage.status(token)).toMatchObject({state:'sealed'});
      expect(await target.stage.receipts.count()).toBe(0);expect(await target.repo.get(record.id)).toBeNull();
      await vi.waitFor(async()=>expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0}));
      expect(await target.repo.get(record.id)).not.toBeNull();
    } finally {remove.mockRestore();}
  });
  it.each([
    ['before','none'],['after','none'],['before','before'],['after','before'],['before','after'],['after','after'],
  ] as const)('releases the commit slot when registration throws %s installation and removal throws %s native removal',async (mode,removeMode)=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    const signal=new AbortController(),original=Error('registration failed');
    const nativeAdd=signal.signal.addEventListener.bind(signal.signal),nativeRemove=signal.signal.removeEventListener.bind(signal.signal);
    const add=vi.spyOn(signal.signal,'addEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')nativeAdd(type,listener,options);throw original;});
    const remove=vi.spyOn(signal.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(removeMode!=='before')nativeRemove(type,listener,options);if(removeMode!=='none')throw Error('cleanup failed');});
    try {
      await expect(target.stage.commit(token,{signal:signal.signal})).rejects.toBe(original);
      expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
      const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();
      if(listener)nativeRemove('abort',listener);
      await expect(target.stage.commit(token)).resolves.toEqual({inserted:0,updated:0,skipped:0});
    } finally {
      const listener=remove.mock.calls[0]?.[1];add.mockRestore();remove.mockRestore();
      if(listener)nativeRemove('abort',listener);
    }
  });
  it('releases the commit slot and abort listener when a transaction throws synchronously',async()=>{
    const target=instance(),observed=vi.fn(),stop=target.stage.observeCommitted(observed);
    const {token}=await upload(target.stage,[await material('sync-transaction')]);await target.stage.seal(token);
    const signal=new AbortController(),remove=vi.spyOn(signal.signal,'removeEventListener');
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>{throw Error('sync transaction failure');});
    try {
      await expect(target.stage.commit(token,{signal:signal.signal})).rejects.toThrow('sync transaction failure');
      expect(observed).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
      expect(await target.stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
      expect(observed).toHaveBeenCalledOnce();
    } finally {transaction.mockRestore();remove.mockRestore();stop();}
  });
  it('keeps concurrent commits isolated and handles a rejected async observer even if logging fails',async()=>{
    const target=instance(),isolated=instance(),observed=vi.fn(),other=vi.fn();
    const stop=target.stage.observeCommitted(observed),stopOther=isolated.stage.observeCommitted(other);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{throw Error('diagnostic unavailable');});
    const stopAsync=target.stage.observeCommitted(async()=>{throw Error('private observer details');});
    try {
      const a=await upload(target.stage,[await material('parallel-a')]);await target.stage.seal(a.token);
      const b=await upload(target.stage,[await material('parallel-b')]);await target.stage.seal(b.token);
      const results=await Promise.all([target.stage.commit(a.token),target.stage.commit(b.token)]);
      expect(results).toEqual([{inserted:1,updated:0,skipped:0},{inserted:1,updated:0,skipped:0}]);
      expect(observed).toHaveBeenCalledTimes(2);expect(other).not.toHaveBeenCalled();
      await vi.waitFor(()=>expect(warn).toHaveBeenCalledTimes(2));
      expect(await target.stage.commit(a.token)).toEqual(results[0]);expect(observed).toHaveBeenCalledTimes(2);
    } finally {stop();stopOther();stopAsync();warn.mockRestore();}
  });
});

describe('committed cleanup corruption notifications',()=>{
  it('notifies when the transaction commits even if its reply is delayed past cancellation',async()=>{
    const notified=vi.fn(),target=instance({now:100},{onCleanupCorruption:notified});
    const {token}=await upload(target.stage,[{note:'private staged note'}]);
    await target.stage.sessions.update(token.id,{expiresAt:NaN});
    const original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    const committed=deferred(),deliver=deferred(),controller=new AbortController();
    const spy=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(async value=>{committed.resolve();await deliver.promise;return value;})) as never);
    try{
      const pending=target.stage.cleanup({signal:controller.signal});
      await committed.promise;expect(notified).toHaveBeenCalledOnce();expect(notified).toHaveBeenCalledWith();
      controller.abort();await expect(pending).rejects.toThrow('cancelled');deliver.resolve();
      expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);
      expect(notified).toHaveBeenCalledOnce();
    }finally{deliver.resolve();spy.mockRestore();}
  });
  it('never notifies a rolled-back cleanup and notifies exactly once on retry',async()=>{
    const notified=vi.fn(),target=instance({now:100},{onCleanupCorruption:notified});
    const {token}=await upload(target.stage,[{note:'private staged note'}]);
    await target.stage.sessions.update(token.id,{expiresAt:NaN});
    const fail=()=>{throw Error('injected cleanup failure');};target.stage.frames.hook('deleting',fail);
    try{await expect(target.stage.cleanup()).rejects.toThrow('injected cleanup failure');}
    finally{target.stage.frames.hook('deleting').unsubscribe(fail);}
    expect(notified).not.toHaveBeenCalled();expect(await target.stage.frames.count()).toBe(1);
    expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0,corruptSessions:1});
    expect(notified).toHaveBeenCalledOnce();expect(await target.stage.frames.count()).toBe(0);
  });
  it('rolls back expired private frames and receipts if the final cleanup budget update fails',async()=>{
    const target=instance(),imported=await material('cleanup-committed');
    const committed=await upload(target.stage,[imported]);await target.stage.seal(committed.token);
    const result=await target.stage.commit(committed.token);
    const pending=await upload(target.stage,[{note:'private pending cleanup'}]);
    target.clock.now+=opts.receiptTtlMs;
    const starts=target.db.table<any,string>('stageStarts');
    const snapshot={frames:await target.stage.frames.toArray(),sessions:await target.stage.sessions.toArray(),
      receipts:await target.stage.receipts.toArray(),starts:await starts.toArray(),budget:await target.stage.budgets.get('stage')};
    expect(snapshot.frames).toHaveLength(pending.input.frames.length);
    expect(new TextDecoder().decode(snapshot.frames[0].bytes)).toContain('private pending cleanup');
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};
    target.stage.budgets.hook('updating',fail);
    try{await expect(target.stage.cleanup()).rejects.toThrow('simulated quota');}
    finally{target.stage.budgets.hook('updating').unsubscribe(fail);}
    expect(await target.stage.frames.toArray()).toEqual(snapshot.frames);
    expect(await target.stage.sessions.toArray()).toEqual(snapshot.sessions);
    expect(await target.stage.receipts.toArray()).toEqual(snapshot.receipts);
    expect(await starts.toArray()).toEqual(snapshot.starts);
    expect(await target.stage.budgets.get('stage')).toEqual(snapshot.budget);
    expect(await target.repo.get(imported.id)).not.toBeNull();
    expect(result).toEqual({inserted:1,updated:0,skipped:0});
    expect(await target.stage.cleanup()).toMatchObject({sessions:1,receipts:1});
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
    expect(await target.repo.get(imported.id)).not.toBeNull();
  });
  it('does not report ordinary expiry as corruption',async()=>{
    const notified=vi.fn(),clock={now:100},target=instance(clock,{onCleanupCorruption:notified});
    await upload(target.stage,[{note:'ordinary staged note'}]);clock.now+=opts.ttlMs;
    expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0});expect(notified).not.toHaveBeenCalled();
  });
  it.each(['throw','reject'] as const)('isolates %s from the committed cleanup without private diagnostics',async failure=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const target=instance({now:100},{onCleanupCorruption:failure==='throw'?()=>{throw Error('PRIVATE_DETAILS');}:async()=>{throw Error('PRIVATE_DETAILS');}});
    try{
      const {token}=await upload(target.stage,[{note:'private staged note'}]);await target.stage.sessions.update(token.id,{expiresAt:NaN});
      expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0,corruptSessions:1});
      await vi.waitFor(()=>expect(warn).toHaveBeenCalledOnce());
      expect(warn).toHaveBeenCalledWith('[FluentRead] 材料恢复清理诊断失败');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_DETAILS');expect(await target.stage.frames.count()).toBe(0);
    }finally{warn.mockRestore();}
  });
  it('rejects an invalid cleanup observer before opening storage',()=>{
    const db=database();expect(()=>createProductStage(db,{onCleanupCorruption:null as never})).toThrow('invalid cleanup observer');
    expect(db.isOpen()).toBe(false);
  });
  it('keeps a committed cleanup successful when its diagnostic logger also throws',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{throw Error('logger unavailable');});
    const target=instance({now:100},{onCleanupCorruption:()=>{throw Error('private diagnostic');}});
    try{
      const {token}=await upload(target.stage,[{note:'private staged note'}]);
      await target.stage.sessions.update(token.id,{expiresAt:NaN});
      expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0,corruptSessions:1});
      expect(warn).toHaveBeenCalledOnce();expect(await target.stage.frames.count()).toBe(0);
    }finally{warn.mockRestore();}
  });
});

describe('isolated same-database material staging',()=>{
  it('rejects a non-function capacity estimator before opening storage',()=>{
    const db=database();expect(()=>createProductStage(db,{estimate:null as never})).toThrow('invalid capacity estimator');
    expect(db.isOpen()).toBe(false);
  });
  it('preserves data and refuses unbounded corrupted start tombstones during cleanup',async()=>{
    const target=instance(),input=frameRecords([{note:'private staged note'}],opts.frameBytes);
    const cap=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await target.stage.append(cap,input.frames[0]);
    const starts=target.db.table('stageStarts');
    await starts.bulkPut(Array.from({length:256},(_,i)=>({id:`corrupt-${i}`,expiresAt:1})));
    target.clock.now=1101;
    await expect(target.stage.cleanup()).rejects.toThrow('start corruption');
    expect(await target.stage.sessions.count()).toBe(1);expect(await target.stage.frames.count()).toBe(1);
    expect(await starts.count()).toBe(257);expect(await target.stage.budgets.get('stage')).toMatchObject({slots:1});
  });
  it.each([0,-1,0.5,NaN,Infinity,257,Number.MAX_SAFE_INTEGER+1])('rejects invalid resource limits before opening a receiver: %s',value=>{
    const target=instance();
    expect(()=>createProductStage(target.db,{limits:{slots:value}})).toThrow('invalid limits');
  });
  it.each([undefined,null,[],1,'not-a-manifest'])('rejects invalid recovery manifest shapes: %s',async value=>{
    const target=instance(),cap=createMaterialImportCapability();
    await expect(target.stage.beginRecoverable(value as never,{generation:0,capturedAt:100},cap,{deadline:500})).rejects.toThrow('invalid manifest');
    expect(await target.stage.sessions.count()).toBe(0);
  });
  it.each([
    {reserved:NaN,reservedFrames:0,slots:0},
    {reserved:0,reservedFrames:Infinity,slots:0},
    {reserved:0,reservedFrames:0,slots:-1},
    {reserved:0,reservedFrames:0,slots:0.5},
    {reserved:0,reservedFrames:Number.MAX_SAFE_INTEGER+1,slots:0},
    {reserved:'not-a-number',reservedFrames:0,slots:0},
  ])('rejects a corrupted shared budget before reserving another import: %o',async values=>{
    const target=instance(),manifest=frameRecords([],opts.frameBytes).manifest;
    await target.stage.budgets.put({key:'stage',...values});
    const capability={id:'00000000-0000-4000-8000-000000000000',token:'a'.repeat(64)};
    await expect(target.stage.beginRecoverable(manifest,{generation:0,capturedAt:100},capability,{deadline:500})).rejects.toThrow('budget corruption');
    expect(await target.stage.sessions.count()).toBe(0);
  });
  it('rejects an orphaned safe-integer budget instead of reserving against it',async()=>{
    const target=instance({now:100},{limits:{...opts,totalBytes:Number.MAX_SAFE_INTEGER}});
    await target.stage.budgets.put({key:'stage',reserved:Number.MAX_SAFE_INTEGER,reservedFrames:0,slots:0});
    const input=frameRecords([{}],opts.frameBytes);
    await expect(target.stage.begin(input.manifest,{generation:0,capturedAt:100})).rejects.toThrow('budget corruption');
    expect(await target.stage.sessions.count()).toBe(0);
    expect((await target.stage.budgets.get('stage')).reserved).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each(['missing','zero','undercounted'] as const)('rejects %s budget rows across independent connections without creating a second session',async kind=>{
    const target=instance({now:100},{limits:{...opts,totalBytes:2}}),input=frameRecords([{}],opts.frameBytes);
    expect(input.manifest.bytes).toBe(2);
    const first=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    if(kind==='missing')await target.stage.budgets.delete('stage');
    else if(kind==='zero')await target.stage.budgets.put({key:'stage',reserved:0,reservedFrames:0,slots:0});
    else await target.stage.budgets.put({key:'stage',reserved:1,reservedFrames:1,slots:1});
    const db2=database(target.db.name);await db2.open();
    const second=createStage(db2,{limits:{...opts,totalBytes:2},clock:()=>100});
    await expect(second.begin(input.manifest,{generation:0,capturedAt:100})).rejects.toThrow('budget corruption');
    expect(await target.stage.sessions.count()).toBe(1);expect((await target.stage.status(first)).state).toBe('open');
    await target.repo.clear(101);expect(await target.stage.sessions.count()).toBe(0);
  });
  it('rejects undercounted receipt slots before starting a second recovery',async()=>{
    const target=instance({now:100},{limits:{...opts,slots:2}}),empty=frameRecords([],opts.frameBytes).manifest;
    const first=await target.stage.begin(empty,{generation:0,capturedAt:100});await target.stage.seal(first);await target.stage.commit(first);
    await target.stage.budgets.put({key:'stage',reserved:0,reservedFrames:0,slots:0});
    const db2=database(target.db.name);await db2.open();const second=createStage(db2,{limits:{...opts,slots:2},clock:()=>100});
    await expect(second.begin(empty,{generation:0,capturedAt:100})).rejects.toThrow('budget corruption');
    expect(await target.stage.sessions.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(1);
    await target.repo.clear(101);expect((await target.stage.budgets.get('stage')).slots).toBe(1);
  });
  it('serializes concurrent reservations from independent database connections',async()=>{
    const target=instance({now:100},{limits:{...opts,totalBytes:2}}),input=frameRecords([{}],opts.frameBytes);
    const otherDb=database(target.db.name);await otherDb.open();
    const other=createStage(otherDb,{limits:{...opts,totalBytes:2},clock:()=>100});
    const guard={generation:0,capturedAt:100};
    const outcomes=await Promise.allSettled([target.stage.begin(input.manifest,guard),other.begin(input.manifest,guard)]);
    expect(outcomes.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item=>item.status==='rejected')).toHaveLength(1);
    expect(await target.stage.sessions.count()).toBe(1);
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:2,reservedFrames:1,slots:1});
  });
  it('rejects an unbounded corrupted session table before iterating metadata and allows explicit clear',async()=>{
    const target=instance(),rows=Array.from({length:257},(_,i)=>({id:`damaged-${i}`,bytes:0,frames:0,expiresAt:1000}));
    await target.stage.sessions.bulkPut(rows);await target.stage.budgets.put({key:'stage',reserved:0,reservedFrames:0,slots:257});
    const read=vi.fn((value:unknown)=>value);target.stage.sessions.hook('reading',read);
    try {await expect(target.stage.cleanup()).rejects.toThrow('budget corruption');expect(read).not.toHaveBeenCalled();}
    finally {target.stage.sessions.hook('reading').unsubscribe(read);}
    expect(await target.stage.sessions.count()).toBe(257);
    await target.repo.clear(101);expect(await target.stage.sessions.count()).toBe(0);
  });
  it.each([NaN,undefined,-1,1.5])('removes only uncommitted sessions with an invalid expiration: %s',async expiry=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes);
    const bad=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await target.stage.append(bad,input.frames[0]);
    const good=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const empty=frameRecords([],opts.frameBytes).manifest,done=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(done);const result=await target.stage.commit(done);
    await target.stage.sessions.update(bad.id,{expiresAt:expiry});
    await expect(target.stage.status(bad)).rejects.toThrow('invalid expiry');
    target.clock.now=150;
    expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0,corruptSessions:1});
    expect(await target.stage.frames.count()).toBe(0);
    expect(await target.stage.status(good)).toEqual({state:'open',nextSeq:0});
    expect(await target.stage.status(done)).toEqual({state:'committed',result});
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:input.manifest.bytes,reservedFrames:input.manifest.frames,slots:2});
  });
  it.each([NaN,undefined,-1,1.5])('does not trust or delete a committed receipt with an invalid expiration: %s',async expiry=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest;
    const cap=await target.stage.begin(empty,{generation:0,capturedAt:100});await target.stage.seal(cap);await target.stage.commit(cap);
    await target.stage.receipts.update(cap.id,{expiresAt:expiry});
    await expect(target.stage.status(cap)).rejects.toThrow('invalid expiry');
    await expect(target.stage.acknowledge(cap)).rejects.toThrow('invalid expiry');
    target.clock.now+=opts.receiptTtlMs;
    expect(await target.stage.cleanup()).toEqual({sessions:0,receipts:0,corruptReceipts:1});
    expect(await target.stage.receipts.count()).toBe(1);expect((await target.stage.budgets.get('stage')).slots).toBe(1);
  });
  it.each([NaN,undefined,-1,1.5])('retains and reports an invalid start tombstone instead of allowing replay: %s',async expiry=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap=await target.stage.begin(empty,guard);await target.stage.discard(cap);
    await target.db.table('stageStarts').update(cap.id,{expiresAt:expiry});
    expect(await target.stage.cleanup()).toEqual({sessions:0,receipts:0,corruptStarts:1});
    expect(await target.db.table('stageStarts').get(cap.id)).toBeDefined();
    await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).rejects.toThrow('invalid expiry');
  });
  it('rolls back a commit and expiry cleanup when a shared budget is corrupted, then clears private data safely',async()=>{
    const target=instance(),{token,input}=await upload(target.stage,[await material('corrupt-budget')]);
    await target.stage.seal(token);
    await target.stage.budgets.update('stage',{reserved:NaN});
    await expect(target.stage.commit(token)).rejects.toThrow('budget corruption');
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
    expect(await target.stage.frames.count()).toBe(input.frames.length);expect((await target.stage.status(token)).state).toBe('sealed');
    target.clock.now+=opts.ttlMs;
    await expect(target.stage.cleanup()).rejects.toThrow('budget corruption');
    expect(await target.stage.frames.count()).toBe(input.frames.length);expect(await target.stage.sessions.count()).toBe(1);
    await target.repo.clear(target.clock.now);
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);
    expect(await target.stage.budgets.get('stage')).toBeUndefined();
  });
  it('refuses to release corrupted session or receipt counts and preserves all staged data',async()=>{
    const target=instance(),first=await upload(target.stage,[await material('corrupt-session')]);
    await target.stage.sessions.update(first.token.id,{bytes:-1});
    await expect(target.stage.discard(first.token)).rejects.toThrow('budget corruption');
    expect(await target.stage.frames.count()).toBe(first.input.frames.length);
    expect(await target.stage.sessions.count()).toBe(1);
    target.clock.now+=opts.ttlMs;
    await expect(target.stage.cleanup()).rejects.toThrow('budget corruption');
    expect(await target.stage.frames.count()).toBe(first.input.frames.length);
    await target.repo.clear(target.clock.now);

    target.clock.now++;
    const empty=frameRecords([],opts.frameBytes).manifest;
    const committed=await target.stage.begin(empty,{generation:1,capturedAt:target.clock.now});
    await target.stage.seal(committed);await target.stage.commit(committed);
    await target.stage.budgets.update('stage',{slots:0});
    await expect(target.stage.acknowledge(committed)).rejects.toThrow('budget corruption');
    expect(await target.stage.receipts.count()).toBe(1);
    target.clock.now+=opts.receiptTtlMs;
    await expect(target.stage.cleanup()).rejects.toThrow('budget corruption');
    expect(await target.stage.receipts.count()).toBe(1);
    await target.repo.clear(target.clock.now);
    expect((await target.stage.budgets.get('stage')).slots).toBe(1);
    expect(await target.stage.cleanup()).toEqual({sessions:0,receipts:1});
  });
  it('allows an older reservation above a reduced limit to be discarded before accepting new work',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const smaller=createStage(target.db,{limits:{...opts,totalBytes:1},clock:()=>100});
    await expect(smaller.begin(frameRecords([],opts.frameBytes).manifest,{generation:0,capturedAt:100})).rejects.toThrow('stage budget exceeded');
    expect(await smaller.discard(token)).toBe('discarded');
    const next=await smaller.begin(frameRecords([],opts.frameBytes).manifest,{generation:0,capturedAt:100});
    expect(await smaller.discard(next)).toBe('discarded');
  });
  it('permits existing sessions to be released after the configured slot limit decreases',async()=>{
    const clock={now:100},target=instance(clock,{limits:{...opts,slots:2}}),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);
    const smaller=createStage(target.db,{limits:{...opts,slots:1},clock:()=>clock.now});
    await expect(smaller.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    expect(await smaller.discard(a)).toBe('discarded');expect(await smaller.discard(b)).toBe('discarded');
    expect((await smaller.budgets.get('stage')).slots).toBe(0);
    clock.now+=opts.ttlMs;expect(await smaller.cleanup()).toEqual({sessions:0,receipts:0});
    const next=await smaller.begin(empty,guard);expect(await smaller.discard(next)).toBe('discarded');
  });
  it('rejects pre-cancelled operations without reading payloads or starting database work',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const controller=new AbortController();controller.abort();
    const transaction=vi.spyOn(target.db,'transaction');
    const frame={...input.frames[0]};Object.defineProperty(frame,'bytes',{get(){throw Error('payload unexpectedly read');}});
    const operations=[
      ()=>target.stage.beginRecoverable(input.manifest,{generation:0,capturedAt:100},token,{deadline:500,signal:controller.signal}),
      ()=>target.stage.resume(token,{signal:controller.signal}),
      ()=>target.stage.append(token,frame,{signal:controller.signal}),
      ()=>target.stage.seal(token,{signal:controller.signal}),
      ()=>target.stage.status(token,{signal:controller.signal}),
      ()=>target.stage.commit(token,{signal:controller.signal}),
      ()=>target.stage.discard(token,{signal:controller.signal}),
      ()=>target.stage.acknowledge(token,{signal:controller.signal}),
      ()=>target.stage.cleanup({signal:controller.signal}),
    ];
    for(const operation of operations)await expect(operation()).rejects.toThrow('cancelled');
    expect(transaction).not.toHaveBeenCalled();transaction.mockRestore();
    expect(await target.stage.frames.count()).toBe(0);expect((await target.stage.status(token)).state).toBe('open');
  });
  it('rejects record limits that do not fit the 32-bit digest length prefix',()=>{
    const target=instance(),max=0xffffffff;
    // The protocol's 4-byte prefix cannot distinguish these two lengths.
    expect(lengthBytes(1)).toEqual(lengthBytes(max+2));
    expect(()=>createProductStage(target.db,{limits:{recordBytes:max}})).not.toThrow();
    expect(()=>createProductStage(target.db,{limits:{recordBytes:max+1}})).toThrow('invalid limits');
  });
  it('rejects impossible manifests before reserving shared budget',async()=>{
    const target=instance({now:100},{limits:{...opts,recordBytes:256,totalBytes:4096}}),guard={generation:0,capturedAt:100};
    const cases=[
      {records:1,frames:1,bytes:129}, // a single frame cannot exceed its limit
      {records:1,frames:3,bytes:2}, // every frame must contain bytes
      {records:1,frames:3,bytes:257}, // a record cannot exceed its limit
      {records:2,frames:5,bytes:513}, // combined record limit
    ];
    for(const input of cases){
      const manifest={...input,digest:'0'.repeat(64)};
      const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
      await expect(target.stage.beginRecoverable(manifest,guard,cap,{deadline:1000})).rejects.toThrow('invalid manifest');
    }
    expect(await target.stage.budgets.get('stage')).toBeUndefined();
    expect(await target.stage.sessions.count()).toBe(0);
    expect(await target.db.table('stageStarts').count()).toBe(0);
  });
  it('accounts for partial final frames in each record',async()=>{
    const target=instance({now:100},{limits:{...opts,frameBytes:4,recordBytes:5,totalBytes:32}}),guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    // Two 5-byte records need four frames, not three.
    const impossible={records:2,frames:3,bytes:10,digest:'0'.repeat(64)};
    await expect(target.stage.beginRecoverable(impossible,guard,cap,{deadline:1000})).rejects.toThrow('invalid manifest');
    const feasible={...impossible,bytes:9};
    expect(await target.stage.beginRecoverable(feasible,guard,cap,{deadline:1000})).toEqual(cap);
    await target.stage.discard(cap);
  });
  it('checks large manifest capacities without overflowing intermediate products',async()=>{
    const max=Number.MAX_SAFE_INTEGER,recordMax=0xffffffff,guard={generation:0,capturedAt:100};
    const target=instance({now:100},{limits:{...opts,frameBytes:max,recordBytes:recordMax,totalBytes:max}});
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    const impossible={records:2,frames:2,bytes:recordMax*2+1,digest:'0'.repeat(64)};
    await expect(target.stage.beginRecoverable(impossible,guard,cap,{deadline:1000})).rejects.toThrow('invalid manifest');
    const feasible={...impossible,bytes:recordMax*2};
    // Geometry accepts the feasible value, then the conservative capacity gate rejects it.
    await expect(target.stage.beginRecoverable(feasible,guard,cap,{deadline:1000})).rejects.toMatchObject({name:'MaterialBackupCapacityError'});
  });
  it('admits empty backups and possible arbitrary subdivisions at capacity boundaries',async()=>{
    const target=instance({now:100},{limits:{...opts,recordBytes:256,totalBytes:4096}}),guard={generation:0,capturedAt:100};
    const cases=[{records:0,frames:0,bytes:0},{records:1,frames:2,bytes:256},{records:2,frames:3,bytes:3}];
    for(const input of cases){
      const manifest={...input,digest:'0'.repeat(64)};
      const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
      expect(await target.stage.beginRecoverable(manifest,guard,cap,{deadline:1000})).toEqual(cap);
      await target.stage.discard(cap);
    }
  });
  it('recovers an undelivered begin with the same caller capability and reserves once',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    expect(await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).toEqual(cap); // response lost
    const other=database(target.db.name);await other.open();vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage'),restarted=fresh.createStage(other,{limits:opts,clock:()=>100});
    expect(await restarted.beginRecoverable(empty,guard,cap,{deadline:1000})).toEqual(cap);
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);expect(await target.stage.sessions.count()).toBe(1);
  });
  it('never recreates a discarded recoverable session while its request identity is retained',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000});await target.stage.discard(cap);
    await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).rejects.toThrow('session unavailable');
    expect(await target.stage.sessions.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('rejects conflicting retries and ID collisions without overwriting live state',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000});
    const attempts=[{manifest:empty,guard,cap:{...cap,token:'0'.repeat(64)},deadline:1000},{manifest:{...empty,digest:'f'.repeat(64)},guard,cap,deadline:1000},{manifest:empty,guard:{...guard,capturedAt:101},cap,deadline:1000},{manifest:empty,guard:{...guard,generation:1},cap,deadline:1000},{manifest:empty,guard,cap,deadline:999}];
    for(const x of attempts)await expect(target.stage.beginRecoverable(x.manifest,x.guard,x.cap,{deadline:x.deadline})).rejects.toThrow('session unavailable');
    const legacy=await target.stage.begin(empty,guard);
    await target.db.table('stageStarts').delete(legacy.id); // 未记录开始请求的历史会话不得被覆盖。
    await expect(target.stage.beginRecoverable(empty,guard,legacy,{deadline:1000})).rejects.toThrow('session unavailable');
    expect(await target.stage.sessions.count()).toBe(2);expect((await target.stage.budgets.get('stage'))?.slots).toBe(2);
  });
  it('retries a committed begin until acknowledgement, then prevents recreation until deadline',async()=>{
    const clock={now:100},target=instance(clock),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000});await target.stage.seal(cap);const result=await target.stage.commit(cap);
    expect(await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).toEqual(cap);expect(await target.stage.status(cap)).toEqual({state:'committed',result});
    await target.stage.acknowledge(cap);await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).rejects.toThrow('session unavailable');
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);clock.now=1000;await target.stage.cleanup();
    await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).rejects.toThrow('deadline');
  });
  it('serializes same-capability begins across independent receiver instances',async()=>{
    const target=instance(),other=database(target.db.name);await other.open();vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage'),second=fresh.createStage(other,{limits:opts,clock:()=>100});
    const empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100},cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    expect(await Promise.all([target.stage.beginRecoverable(empty,guard,cap,{deadline:1000}),second.beginRecoverable(empty,guard,cap,{deadline:1000})])).toEqual([cap,cap]);
    expect(await target.stage.sessions.count()).toBe(1);expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
  });
  it('caps retained request identities independently and releases them at expiry',async()=>{
    const clock={now:100},target=instance(clock,{limits:{...opts,slots:1}}),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const make=()=>({id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}),a=make(),b=make();
    await target.stage.beginRecoverable(empty,guard,a,{deadline:200});await target.stage.discard(a);
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
    await expect(target.stage.beginRecoverable(empty,guard,b,{deadline:200})).rejects.toThrow('stage budget exceeded');
    clock.now=200;await target.stage.cleanup();expect(await target.stage.beginRecoverable(empty,guard,b,{deadline:300})).toEqual(b);
  });
  it('preserves a committed recoverable begin when cancellation wins the response race',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100},controller=new AbortController();
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    const original=target.db.transaction.bind(target.db),spy=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve((original as any)(...args)).then(value=>{controller.abort();return value;})) as never);
    await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000,signal:controller.signal})).rejects.toThrow('cancelled');spy.mockRestore();
    expect(await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).toEqual(cap);expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
  });
  it('returns promptly on locked recoverable begin cancellation while holding its shared begin lane',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),other=database(target.db.name);await other.open();const hold=deferred(),ready=deferred();
    const lock=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100},cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))},controller=new AbortController();
    const pending=Dexie.ignoreTransaction(()=>target.stage.beginRecoverable(empty,guard,cap,{deadline:1000,signal:controller.signal}));await new Promise(resolve=>setTimeout(resolve,20));controller.abort();
    try{await expect(pending).rejects.toThrow('cancelled');await expect(Dexie.ignoreTransaction(()=>target.stage.begin(empty,guard))).rejects.toThrow('backpressure');}finally{hold.resolve();await lock;}
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.beginRecoverable(empty,guard,cap,{deadline:1000}))).toEqual(cap));
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
  });
  it('rolls back recoverable creation if its deadline passes during an asynchronous write',async()=>{
    const clock={now:100},target=instance(clock),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))},starts=target.db.table('stageStarts'),entered=deferred(),release=deferred();
    const original=starts.add.bind(starts),spy=vi.spyOn(starts as any,'add').mockImplementation(async (...args:any[])=>{const result=await (original as any)(...args);entered.resolve();await Dexie.waitFor(release.promise);return result;});
    const pending=target.stage.beginRecoverable(empty,guard,cap,{deadline:200});await entered.promise;clock.now=200;release.resolve();
    await expect(pending).rejects.toThrow('session unavailable');spy.mockRestore();expect(await starts.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.slots??0).toBe(0);
  });
  it('documents same-capability revival after expiry cleanup and wall-clock rollback',async()=>{
    const clock={now:100},target=instance(clock),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    await target.stage.beginRecoverable(empty,guard,cap,{deadline:200});await target.stage.discard(cap);clock.now=200;await target.stage.cleanup();clock.now=100;
    expect(await target.stage.beginRecoverable(empty,guard,cap,{deadline:200})).toEqual(cap); // known limitation, not replay protection
  });
  it('snapshots all recoverable begin arguments while its transaction waits',async()=>{
    const target=instance(),other=database(target.db.name);await other.open();const hold=deferred(),ready=deferred();
    const lock=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const manifest=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100},cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))},options={deadline:1000};
    const original={manifest:{...manifest},guard:{...guard},cap:{...cap}};
    const pending=Dexie.ignoreTransaction(()=>target.stage.beginRecoverable(manifest,guard,cap,options));
    manifest.digest='f'.repeat(64);guard.generation=5;cap.token='0'.repeat(64);options.deadline=999;hold.resolve();await lock;
    expect(await pending).toEqual(original.cap);
    expect(await target.stage.beginRecoverable(original.manifest,original.guard,original.cap,{deadline:1000})).toEqual(original.cap);
  });
  it('upgrades an existing v1 database and retains its materials with recoverable starts',async()=>{
    const name=`material-stage-test-${++serial}`;names.add(name);const old=legacyDatabase(name);const repo=new MaterialRepository(old);
    await repo.capture({source:{kind:'article',url:'https://example.test/v1-recoverable',title:'v1'},capturedAt:10},10);
    const db=database(name);await db.open();const stage=createStage(db,{limits:opts,clock:()=>100});
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))},empty=frameRecords([],opts.frameBytes).manifest;
    await stage.beginRecoverable(empty,{generation:0,capturedAt:100},cap,{deadline:1000});
    expect((await new MaterialRepository(db).list()).map(item=>item.title)).toContain('v1');expect(await db.table('stageStarts').count()).toBe(1);
  });
  it('rolls back start, session and reservation if start ledger insertion fails',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))},starts=target.db.table('stageStarts');
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};starts.hook('creating',fail);
    try{await expect(target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).rejects.toThrow('simulated quota');}finally{starts.hook('creating').unsubscribe(fail);}
    expect(await starts.count()).toBe(0);expect(await target.stage.sessions.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.slots??0).toBe(0);
    expect(await target.stage.beginRecoverable(empty,guard,cap,{deadline:1000})).toEqual(cap);
  });
  it('releases acknowledged receipt capacity while retaining start tombstones until expiry',async()=>{
    const target=instance({now:100},{limits:{...opts,slots:2}}),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);
    await target.stage.seal(a);await target.stage.seal(b);
    const result=await target.stage.commit(a);await target.stage.commit(b);
    await expect(target.stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    expect(await target.stage.status(a)).toEqual({state:'committed',result});
    expect(await target.stage.acknowledge(a)).toBe('released-or-unavailable');
    expect(await target.stage.status(b)).toEqual({state:'committed',result});
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
    // 已确认结果释放回执槽位，但开始请求的防重放记录必须保留至 deadline。
    await expect(target.stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    target.clock.now+=opts.ttlMs;expect(await target.stage.cleanup()).toEqual({sessions:0,receipts:0});
    expect(await target.stage.begin(empty,guard)).toEqual(expect.objectContaining({id:expect.any(String)}));
  });
  it('authenticates receipt release, refuses open sessions and leaves expired receipts for cleanup',async()=>{
    const clock={now:100},target=instance(clock),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);
    await expect(target.stage.acknowledge(a)).rejects.toThrow('receipt not committed');
    await expect(target.stage.acknowledge({...a,token:'0'.repeat(64)})).rejects.toThrow('session unavailable');
    await target.stage.seal(a);await target.stage.commit(a);
    await expect(target.stage.acknowledge({...a,token:'0'.repeat(64)})).rejects.toThrow('session unavailable');
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(2);
    clock.now+=opts.receiptTtlMs;
    await expect(target.stage.acknowledge(a)).rejects.toThrow('receipt expired');
    expect(await target.stage.receipts.count()).toBe(1);
    expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:1});
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
    expect(await target.stage.acknowledge(a)).toBe('released-or-unavailable');
    expect(await target.stage.acknowledge({...b,token:'0'.repeat(64)})).toBe('released-or-unavailable');
  });
  it('retries a lost confirmation after restart without decrementing the budget twice',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);const result=await target.stage.commit(token);
    expect(await target.stage.status(token)).toEqual({state:'committed',result});
    await target.stage.acknowledge(token); // response lost
    vi.resetModules();const fresh=await import('@/src/features/vocabulary/materialImportStage');
    const restarted=fresh.createStage(target.db,{limits:opts,clock:()=>100});
    expect(await restarted.acknowledge(token)).toBe('released-or-unavailable');
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
    await expect(restarted.status(token)).rejects.toThrow('session unavailable');
    await expect(restarted.commit(token)).rejects.toThrow('session unavailable');
  });
  it('does not double-release a receipt acknowledged by a different runtime',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);await target.stage.commit(token);
    vi.resetModules();const fresh=await import('@/src/features/vocabulary/materialImportStage');
    const restarted=fresh.createStage(target.db,{limits:opts,clock:()=>100});
    expect(await restarted.acknowledge(token)).toBe('released-or-unavailable');
    // 原运行时仍可能缓存授权提示，但事务必须核实回执是否存在。
    expect(await target.stage.acknowledge(token)).toBe('released-or-unavailable');
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('rolls back both receipt deletion and slot release if the budget write fails',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);const result=await target.stage.commit(token);
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};target.stage.budgets.hook('updating',fail);
    try {await expect(target.stage.acknowledge(token)).rejects.toThrow('simulated quota');} finally {target.stage.budgets.hook('updating').unsubscribe(fail);}
    expect(await target.stage.status(token)).toEqual({state:'committed',result});expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
    expect(await target.stage.acknowledge(token)).toBe('released-or-unavailable');expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('cancels during a locked acknowledgement without releasing the control slot or deleting late',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);const result=await target.stage.commit(token);
    const other=database(target.db.name);await other.open();const hold=deferred(),ready=deferred();
    const lock=other.transaction('rw',other.table('stageReceipts'),async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const controller=new AbortController(),pending=Dexie.ignoreTransaction(()=>target.stage.acknowledge(token,{signal:controller.signal}));
    await new Promise(resolve=>setTimeout(resolve,20));controller.abort();
    try {await expect(pending).rejects.toThrow('cancelled');await expect(Dexie.ignoreTransaction(()=>target.stage.acknowledge(token))).rejects.toThrow('backpressure');}
    finally {hold.resolve();await lock;}
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.status(token))).toEqual({state:'committed',result}));
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.acknowledge(token))).toBe('released-or-unavailable'));
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('handles cancellation after acknowledgement commits and repeated independent receivers',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);await target.stage.commit(token);
    const controller=new AbortController(),original=target.db.transaction.bind(target.db);
    const spy=vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve((original as any)(...args)).then(value=>{controller.abort();return value;})) as never);
    await expect(target.stage.acknowledge(token,{signal:controller.signal})).rejects.toThrow('cancelled');spy.mockRestore();
    const secondDb=database(target.db.name);await secondDb.open();vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage'),second=fresh.createStage(secondDb,{limits:opts,clock:()=>100});
    expect(await second.acknowledge(token)).toBe('released-or-unavailable');expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('serializes simultaneous acknowledgements across separate runtime module instances',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);await target.stage.commit(token);
    const secondDb=database(target.db.name);await secondDb.open();vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage'),second=fresh.createStage(secondDb,{limits:opts,clock:()=>100});
    expect(await Promise.all([target.stage.acknowledge(token),second.acknowledge(token)])).toEqual(['released-or-unavailable','released-or-unavailable']);
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
  });
  it('bounds pending acknowledgements and retains slots for cancelled uncooperative work',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),empty=frameRecords([],opts.frameBytes).manifest,token=await target.stage.begin(empty,{generation:0,capturedAt:100});
    await target.stage.seal(token);const result=await target.stage.commit(token);
    let finish!:(value:boolean)=>void;const held=new Promise<boolean>(resolve=>{finish=resolve;});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>held as never);
    const controller=new AbortController(),requestOptions:{signal?:AbortSignal}={signal:controller.signal};
    const pending=target.stage.acknowledge(token,requestOptions);await vi.waitFor(()=>expect(transaction).toHaveBeenCalledOnce());requestOptions.signal=undefined;controller.abort();
    await expect(pending).rejects.toThrow('cancelled');await expect(target.stage.acknowledge(token)).rejects.toThrow('backpressure');
    const unknown={id:crypto.randomUUID(),token:'0'.repeat(64)};
    // Unknown credentials use cold authentication rather than consuming or
    // being blocked by the admitted owner's acknowledgement lane.
    await expect(target.stage.acknowledge(unknown)).resolves.toBe('released-or-unavailable');
    expect(await target.stage.status(token)).toEqual({state:'committed',result});
    finish(false);await vi.waitFor(async()=>expect(await target.stage.acknowledge(token)).toBe('released-or-unavailable'));
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('does not let a wrong token for a known ID take the owner acknowledgement slot',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),empty=frameRecords([],opts.frameBytes).manifest;
    const cap=await target.stage.begin(empty,{generation:0,capturedAt:100});await target.stage.seal(cap);await target.stage.commit(cap);
    const other=database(target.db.name);await other.open();const hold=deferred(),ready=deferred();
    const lock=other.transaction('rw',other.table('stageReceipts'),async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const wrong={...cap,token:(cap.token[0]==='0'?'1':'0')+cap.token.slice(1)};
    const failed=Dexie.ignoreTransaction(()=>target.stage.acknowledge(wrong)).then(()=> 'unexpected success',error=>String(error.message));
    const owner=Dexie.ignoreTransaction(()=>target.stage.acknowledge(cap)).then(value=>value,error=>`error:${error.message}`);
    try {
      const state=await Promise.race([owner,new Promise<string>(resolve=>setTimeout(()=>resolve('waiting for database'),30))]);
      expect(state).toBe('waiting for database');
    } finally {hold.resolve();await lock;}
    expect(await failed).toContain('session unavailable');
    expect(await owner).toBe('released-or-unavailable');
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(0);
  });
  it('releases cold authentication capacity when opening the database transaction throws synchronously',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}});
    const unknown={id:crypto.randomUUID(),token:'0'.repeat(64)};
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>{throw Error('synchronous transaction failure');});
    await expect(target.stage.acknowledge(unknown)).rejects.toThrow('synchronous transaction failure');
    transaction.mockRestore();
    await expect(target.stage.acknowledge(unknown)).resolves.toBe('released-or-unavailable');
  });
  it('snapshots acknowledgement capability while waiting on a write lock',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);await target.stage.seal(a);await target.stage.seal(b);
    await target.stage.commit(a);const bResult=await target.stage.commit(b);
    const other=database(target.db.name);await other.open();const hold=deferred(),ready=deferred();
    const lock=other.transaction('rw',other.table('stageReceipts'),async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const mutable={...a},pending=Dexie.ignoreTransaction(()=>target.stage.acknowledge(mutable));mutable.id=b.id;mutable.token=b.token;hold.resolve();await lock;
    expect(await pending).toBe('released-or-unavailable');expect(await target.stage.status(b)).toEqual({state:'committed',result:bResult});
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
  });
  it('commits the same records, order, collision and updatedAt outcomes as one legacy import',async()=>{
    const alpha=await material('alpha'),beta=await material('beta');
    const first={...alpha,updatedAt:11},newer={...alpha,title:'new alpha',updatedAt:12};
    const records=[first,newer,beta,{bad:true}];
    const reference=instance(),target=instance();
    const legacy=await reference.repo.importData({format:'fluentread-learning-materials',version:1,materials:records},100,{generation:0,capturedAt:100});
    const {token}=await upload(target.stage,records);await target.stage.seal(token);
    expect(await target.stage.commit(token)).toEqual(legacy);
    const stable=(items:any[])=>items.sort((a,b)=>a.identityKey.localeCompare(b.identityKey));
    expect(stable((await target.repo.exportData()).materials)).toEqual(stable((await reference.repo.exportData()).materials));
    expect(await target.stage.status(token)).toEqual({state:'committed',result:legacy});
    expect(await target.stage.frames.count()).toBe(0);
    expect((await target.stage.budgets.get('stage'))?.reserved).toBe(0);
  });
  it('enforces authenticated ownership and does not expose status or permit mutations to another token',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100}),wrong={...token,token:'0'.repeat(64)};
    await expect(target.stage.status(wrong)).rejects.toThrow('session unavailable');
    await expect(target.stage.append(wrong,input.frames[0])).rejects.toThrow('session unavailable');
    await expect(target.stage.seal(wrong)).rejects.toThrow('session unavailable');
    await expect(target.stage.commit(wrong)).rejects.toThrow('session unavailable');
    await expect(target.stage.discard(wrong)).rejects.toThrow('session unavailable');
    await expect(target.stage.status({...token,token:'x'.repeat(1024*1024)})).rejects.toThrow('session unavailable');
    await expect(target.stage.status({...token,id:'x'.repeat(1024*1024)})).rejects.toThrow('session unavailable');
    expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
  });
  it('requires ordered frames, accepts identical retry, rejects conflicting retry and copies caller bytes',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    expect(input.frames.length).toBeGreaterThan(1);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await expect(target.stage.append(token,input.frames[1])).rejects.toThrow('out of order');
    const original=input.frames[0].bytes.slice();
    expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    input.frames[0].bytes.fill(0);
    expect((await target.stage.frames.get([token.id,0]))?.bytes).toEqual(original);
    expect(await target.stage.append(token,{...input.frames[0],bytes:original})).toEqual({nextSeq:1});
    await expect(target.stage.append(token,input.frames[0])).rejects.toThrow('conflicting duplicate');
    expect(await target.stage.frames.count()).toBe(1);
    for(const frame of input.frames.slice(1))await target.stage.append(token,frame);
    await target.stage.seal(token);expect((await target.stage.commit(token)).inserted).toBe(1);
  });
  it('stores only budgeted frame fields and ignores extra data on retries',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const frame={...input.frames[0],extra:new Uint8Array(8*1024*1024)};
    let seqReads=0;
    Object.defineProperty(frame,'seq',{enumerable:true,get(){return ++seqReads===1?0:99;}});
    Object.defineProperty(frame,'unrelated',{enumerable:true,get(){throw Error('extra field read');}});
    expect(await target.stage.append(token,frame)).toEqual({nextSeq:1});
    expect(seqReads).toBe(1);
    const stored=await target.stage.frames.get([token.id,0]);
    expect(Object.keys(stored).sort()).toEqual(['bytes','part','record','recordBytes','seq','session','total'].sort());
    expect((await target.stage.budgets.get('stage'))?.reserved).toBe(input.manifest.bytes);
    expect(await target.stage.append(token,{...input.frames[0],extra:'different'} as Frame)).toEqual({nextSeq:1});
    await expect(target.stage.append(token,{...input.frames[0],bytes:new Uint8Array([91,93])})).rejects.toThrow('conflicting duplicate');
    await target.stage.seal(token);
    expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:1});
  });
  it('keeps the original protocol fields and bytes when the caller mutates a pending frame',async()=>{
    const gate=deferred(),ready=deferred(),target=instance({now:100},{beforeAppend:()=>{ready.resolve();return gate.promise;}});
    const input=frameRecords([{}],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const original=input.frames[0],frame={...original,bytes:original.bytes.slice()};
    const pending=target.stage.append(token,frame);await ready.promise;
    frame.seq=99;frame.record=99;frame.part=99;frame.total=100;frame.recordBytes=100;frame.bytes.fill(0);
    gate.resolve();expect(await pending).toEqual({nextSeq:1});
    const stored=await target.stage.frames.get([token.id,0]);
    expect(stored).toMatchObject({...original,session:token.id});expect(stored.bytes).toEqual(original.bytes);
    expect(await target.stage.append(token,original)).toEqual({nextSeq:1});
    await target.stage.seal(token);expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:1});
  });
  it('rejects an oversized byte view even if its public size and copy method are shadowed',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const bytes=new Uint8Array(opts.frameBytes+1);
    Object.defineProperties(bytes,{length:{value:1},byteLength:{value:1},slice:{value(){throw Error('caller copy method used');}}});
    await expect(target.stage.append(token,{...input.frames[0],bytes})).rejects.toThrow('invalid frame');
    const detached=new Uint8Array([123,125]);structuredClone(detached.buffer,{transfer:[detached.buffer]});
    await expect(target.stage.append(token,{...input.frames[0],bytes:detached})).rejects.toThrow('invalid frame');
    const proxy=new Proxy(new Uint8Array([123,125]),{});
    await expect(target.stage.append(token,{...input.frames[0],bytes:proxy})).rejects.toThrow('invalid frame');
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
    await target.stage.append(token,input.frames[0]);await target.stage.seal(token);
    expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:1});
  });
  it('rejects invalid frame sizes, incomplete and corrupt transfers',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await expect(target.stage.append(token,{...input.frames[0],bytes:new Uint8Array(opts.frameBytes+1)})).rejects.toThrow('invalid frame');
    await expect(target.stage.seal(token)).rejects.toThrow('incomplete transfer');
    await expect(target.stage.commit(token)).rejects.toThrow('session not sealed');
    expect(await target.db.materials.count()).toBe(0);
    await target.stage.discard(token);
    const broken={...input.manifest,digest:'0'.repeat(64)},bad=await target.stage.begin(broken,{generation:0,capturedAt:100});
    for(const f of input.frames)await target.stage.append(bad,f);
    await expect(target.stage.seal(bad)).rejects.toThrow('incomplete or corrupt backup');
    expect(await target.db.materials.count()).toBe(0);
  });
  it('rolls back rejected multipart lengths so a valid retry can finish',async()=>{
    const target=instance({now:100},{limits:{...opts,frameBytes:4}}),input=frameRecords([{a:1}],4);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const [first,last]=input.frames;
    expect(await target.stage.append(token,first)).toEqual({nextSeq:1});
    await expect(target.stage.append(token,{...last,total:3})).rejects.toThrow('invalid frame length');
    await expect(target.stage.append(token,{...last,recordBytes:6})).rejects.toThrow('invalid frame length');
    await expect(target.stage.append(token,{...last,bytes:last.bytes.slice(0,2)})).rejects.toThrow('incomplete record');
    expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:1});
    expect(await target.stage.frames.count()).toBe(1);
    expect(await target.stage.append(token,last)).toEqual({nextSeq:2});
    await target.stage.seal(token);
    expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:1});
  });
  it('rejects multipart data exceeding the declared transfer budget and retains the first frame',async()=>{
    const target=instance({now:100},{limits:{...opts,frameBytes:4}}),input=frameRecords([{a:1}],4);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100}),[first,last]=input.frames;
    await target.stage.append(token,{...first,recordBytes:8});
    await expect(target.stage.append(token,{...last,recordBytes:8,bytes:new Uint8Array(4)})).rejects.toThrow('invalid frame length');
    expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:1});
    expect(await target.stage.frames.count()).toBe(1);
    await target.stage.discard(token);
    expect(await target.stage.frames.count()).toBe(0);
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:0});
  });
  it('rejects malformed frame payloads and treats repeated seal as idempotent',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes),cap=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await expect(target.stage.append(cap,null as never)).rejects.toThrow('invalid frame');
    await expect(target.stage.append(cap,{...input.frames[0],bytes:'{}' as never})).rejects.toThrow('invalid frame');
    expect(await target.stage.frames.count()).toBe(0);
    await target.stage.append(cap,input.frames[0]);await target.stage.seal(cap);
    await expect(target.stage.seal(cap)).resolves.toBeUndefined();
    await expect(target.stage.append(cap,input.frames[0])).rejects.toThrow('session sealed');
    expect(await target.stage.commit(cap)).toEqual({inserted:0,updated:0,skipped:1});
  });
  it('rechecks sealed frames during commit and rolls back all earlier writes on corruption',async()=>{
    const target=instance(),input=frameRecords([await material('alpha'),await material('bravo')],1024);
    const stage=createStage(target.db,{limits:{...opts,frameBytes:1024},clock:()=>target.clock.now});
    const token=await stage.begin(input.manifest,{generation:0,capturedAt:100});
    for(const f of input.frames)await stage.append(token,f);await stage.seal(token);
    const last=input.frames.find(f=>f.record===1&&f.part===0)!;
    const stored=(await stage.frames.get([token.id,last.seq]))!;
    const text=new TextDecoder().decode(stored.bytes),edited=text.replace('bravo','brav0');
    expect(edited).not.toBe(text);await stage.frames.put({...stored,bytes:new TextEncoder().encode(edited)});
    await expect(stage.commit(token)).rejects.toThrow('incomplete or corrupt backup');
    expect(await target.db.materials.count()).toBe(0);expect(await stage.receipts.count()).toBe(0);
    expect((await stage.status(token)).state).toBe('sealed');
  });
  it.each(['missing-first','wrong-record','wrong-part','wrong-total','empty-frame','short-record'] as const)(
    'rejects independently corrupted staged frames at seal: %s',async mutation=>{
      const target=instance(),input=frameRecords([await material('tampered-frame')],opts.frameBytes);
      expect(input.frames.length).toBeGreaterThan(1);
      const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
      for(const frame of input.frames)await target.stage.append(token,frame);
      const first=await target.stage.frames.get([token.id,0]),last=await target.stage.frames.get([token.id,input.frames.length-1]);
      if(mutation==='missing-first')await target.stage.frames.delete([token.id,0]);
      else if(mutation==='wrong-record')await target.stage.frames.put({...first,record:1});
      else if(mutation==='wrong-part')await target.stage.frames.put({...first,part:1});
      else if(mutation==='wrong-total')await target.stage.frames.put({...first,total:0});
      else if(mutation==='empty-frame')await target.stage.frames.put({...last,bytes:new Uint8Array(0)});
      else await target.stage.frames.put({...last,bytes:last.bytes.slice(1)});
      await expect(target.stage.seal(token)).rejects.toThrow();
      expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
      expect((await target.stage.status(token)).state).toBe('open');
    },
  );
  it('rolls back a mid-commit failure and cancellation, then allows retry of the sealed transfer',async()=>{
    const target=instance(),{token}=await upload(target.stage,[await material('alpha'),await material('bravo')]);await target.stage.seal(token);
    const notified=vi.fn(),stop=target.stage.observeCommitted(notified);
    let written=0;
    const fail=function(this:{onsuccess?:(id:string)=>void}){if(written===1)throw Error('injected failure');this.onsuccess=()=>written++;};
    target.db.materials.hook('creating',fail);
    try{await expect(target.stage.commit(token)).rejects.toThrow('injected failure');}
    finally{target.db.materials.hook('creating').unsubscribe(fail);}
    expect(written).toBe(1);
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);expect(notified).not.toHaveBeenCalled();
    const controller=new AbortController();
    let cancelledAfterWrite=false;
    const cancel=function(this:{onsuccess?:(id:string)=>void}){this.onsuccess=()=>{cancelledAfterWrite=true;controller.abort();};};
    target.db.materials.hook('creating',cancel);
    try{await expect(target.stage.commit(token,{signal:controller.signal})).rejects.toThrow();}
    finally{target.db.materials.hook('creating').unsubscribe(cancel);}
    expect(cancelledAfterWrite).toBe(true);
    await vi.waitFor(async()=>expect(await target.stage.status(token)).toMatchObject({state:'sealed'}));
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);expect(notified).not.toHaveBeenCalled();
    expect(await target.stage.commit(token)).toEqual({inserted:2,updated:0,skipped:0});
    expect(notified).toHaveBeenCalledOnce();stop();
  });
  it('rolls back both materials and receipt if the receipt store rejects the transaction',async()=>{
    const target=instance(),{token}=await upload(target.stage,[await material('alpha'),await material('bravo')]);await target.stage.seal(token);
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};
    target.stage.receipts.hook('creating',fail);
    await expect(target.stage.commit(token)).rejects.toThrow('simulated quota');
    target.stage.receipts.hook('creating').unsubscribe(fail);
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
    expect((await target.stage.status(token)).state).toBe('sealed');
    expect(await target.stage.commit(token)).toEqual({inserted:2,updated:0,skipped:0});
  });
  it('does not advance the sequence if a simulated frame-store quota error aborts its transaction',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};
    target.stage.frames.hook('creating',fail);
    await expect(target.stage.append(token,input.frames[0])).rejects.toThrow('simulated quota');
    target.stage.frames.hook('creating').unsubscribe(fail);
    expect(await target.stage.frames.count()).toBe(0);
    expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
    expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
  });
  it('rejects stale clear generation without reviving records; newer edits still win at commit',async()=>{
    const target=instance(),records=[await material('alpha')],{token}=await upload(target.stage,records);await target.stage.seal(token);
    await target.repo.clear(101);
    await expect(target.stage.commit(token)).rejects.toThrow('session unavailable');
    expect(await target.db.materials.count()).toBe(0);
    const newer=instance(),next=await upload(newer.stage,records);await newer.stage.seal(next.token);
    await newer.repo.capture({source:{kind:'article',url:'https://example.test/alpha',title:'current'},capturedAt:90},90);
    expect(await newer.stage.commit(next.token)).toEqual({inserted:0,updated:0,skipped:1});
    expect((await newer.repo.list())[0].title).toBe('current');
  });
  it('returns the same commit receipt after reconnect, response loss and later clear without replaying writes',async()=>{
    const target=instance(),{token}=await upload(target.stage,[await material('alpha')]);await target.stage.seal(token);
    const result=await target.stage.commit(token);
    const name=target.db.name;target.db.close();
    const reopened=database(name),stage=createStage(reopened,{limits:opts,clock:()=>target.clock.now}),repo=new MaterialRepository(reopened);
    expect(await stage.status(token)).toEqual({state:'committed',result});
    expect(await stage.commit(token)).toEqual(result);expect(await repo.db.materials.count()).toBe(1);
    await repo.clear(101);expect(await stage.status(token)).toEqual({state:'committed',result});
    expect(await stage.commit(token)).toEqual(result);expect(await repo.db.materials.count()).toBe(0);
    expect(await stage.discard(token)).toBe('committed');
    await expect(stage.status({...token,token:'wrong owner'})).rejects.toThrow('session unavailable');
    await expect(stage.commit({...token,token:'wrong owner'})).rejects.toThrow('session unavailable');
  });
  it('resumes a partially uploaded session after reconnect with its owner capability',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await target.stage.append(token,input.frames[0]);const name=target.db.name;target.db.close();
    const reopened=database(name),stage=createStage(reopened,{limits:opts,clock:()=>target.clock.now});
    expect(await stage.status(token)).toEqual({state:'open',nextSeq:1});
    expect(await stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    for(const frame of input.frames.slice(1))await stage.append(token,frame);
    await stage.seal(token);expect((await stage.commit(token)).inserted).toBe(1);
  });
  it('enforces in-process backpressure and rejects delayed writes after cancellation',async()=>{
    const gate=deferred(),target=instance({now:100},{beforeAppend:()=>gate.promise}),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(token,input.frames[0]);
    await expect(target.stage.append(token,input.frames[0])).rejects.toThrow('backpressure');
    expect(await target.stage.discard(token)).toBe('discarded');gate.resolve();
    await expect(pending).rejects.toThrow('cancelled');
    expect(await target.stage.frames.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.reserved).toBe(0);
  });
  it('settles a pending append when its underlying authentication remains unresolved and the session is discarded',async()=>{
    const ready=deferred(),gate=deferred(),target=instance({now:100},{beforeAppend:()=>{ready.resolve();return gate.promise;}}),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(token,input.frames[0]);await ready.promise;
    expect(await target.stage.discard(token)).toBe('discarded');
    const outcome=await Promise.race([pending.then(()=> 'accepted',error=>error.message),new Promise<string>(resolve=>setTimeout(()=>resolve('blocked'),50))]);
    expect(outcome).toBe('cancelled');
    gate.resolve();
    expect(await target.stage.frames.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.reserved).toBe(0);
  });
  it('checks ownership before delayed authentication and aborts it when another connection discards the session',async()=>{
    const ready=deferred(),gate=deferred();let calls=0;
    const target=instance({now:100},{beforeAppend:()=>{calls++;ready.resolve();return gate.promise;}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const wrong={...token,token:'0'.repeat(64)};
    await expect(target.stage.append(wrong,input.frames[0])).rejects.toThrow('session unavailable');expect(calls).toBe(0);
    const pending=target.stage.append(token,input.frames[0]);const outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;
    const secondDb=database(target.db.name),second=createStage(secondDb,{limits:opts,clock:()=>100});await secondDb.open();
    await expect(second.append(wrong,input.frames[0])).rejects.toThrow('session unavailable');
    await expect(second.discard(wrong)).rejects.toThrow('session unavailable');
    expect(await second.discard(token)).toBe('discarded');
    expect(await outcome).toBe('cancelled');gate.resolve();expect(await target.stage.frames.count()).toBe(0);
  });
  it('keeps an aborted append slot until its delayed authentication settles, then permits retry',async()=>{
    const ready=deferred(),gate=deferred(),target=instance({now:100},{beforeAppend:()=>{ready.resolve();return gate.promise;}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const controller=new AbortController(),pending=target.stage.append(token,input.frames[0],{signal:controller.signal});
    const outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;controller.abort();
    expect(await outcome).toBe('cancelled');expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
    const db2=database(target.db.name),second=createStage(db2,{limits:opts,clock:()=>100});await db2.open();
    await expect(second.append(token,input.frames[0])).rejects.toThrow('backpressure');
    gate.resolve();
    await vi.waitFor(async()=>expect(await second.append(token,input.frames[0])).toEqual({nextSeq:1}));
  });
  it('aborts a pending non-cooperative append when another connection cleans up its expired session',async()=>{
    const ready=deferred(),gate=deferred(),clock={now:100},target=instance(clock,{beforeAppend:()=>{ready.resolve();return gate.promise;}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(token,input.frames[0]),outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;
    const db2=database(target.db.name),second=createStage(db2,{limits:opts,clock:()=>clock.now});await db2.open();clock.now+=opts.ttlMs;
    expect(await second.cleanup()).toEqual({sessions:1,receipts:0});expect(await outcome).toBe('cancelled');gate.resolve();
    expect(await target.stage.frames.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.reserved).toBe(0);
  });
  it('rolls back an append when its caller aborts during the frame transaction',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const controller=new AbortController(),abort=()=>{controller.abort();};target.stage.frames.hook('creating',abort);
    await expect(target.stage.append(token,input.frames[0],{signal:controller.signal})).rejects.toThrow();
    target.stage.frames.hook('creating').unsubscribe(abort);
    expect(await target.stage.frames.count()).toBe(0);expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
    expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
  });
  it('rejects concurrent frames across database connections, then accepts an identical retry',async()=>{
    const gate=deferred(),target=instance({now:100},{beforeAppend:()=>gate.promise}),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const secondDb=database(target.db.name),second=createStage(secondDb,{limits:opts,clock:()=>100});await secondDb.open();
    const delayed=target.stage.append(token,input.frames[0]);
    await expect(second.append(token,input.frames[0])).rejects.toThrow('backpressure');
    gate.resolve();expect(await delayed).toEqual({nextSeq:1});
    expect(await second.append(token,input.frames[0])).toEqual({nextSeq:1});
    expect(await target.stage.frames.count()).toBe(1);expect((await target.stage.budgets.get('stage'))?.reserved).toBe(input.manifest.bytes);
  });
  it('limits aggregate in-flight frames across different sessions before copying more payloads',async()=>{
    const gate=deferred(),target=instance({now:100},{limits:{...opts,inflight:2},beforeAppend:()=>gate.promise});
    const input=frameRecords([await material('alpha')],opts.frameBytes),guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(input.manifest,guard),b=await target.stage.begin(input.manifest,guard),c=await target.stage.begin(input.manifest,guard);
    const first=target.stage.append(a,input.frames[0]),second=target.stage.append(b,input.frames[0]);
    await expect(target.stage.append(c,input.frames[0])).rejects.toThrow('backpressure: receiver busy');
    gate.resolve();expect(await first).toEqual({nextSeq:1});expect(await second).toEqual({nextSeq:1});
    expect(await target.stage.append(c,input.frames[0])).toEqual({nextSeq:1});expect(await target.stage.frames.count()).toBe(3);
  });
  it('reserves a shared byte budget and releases reservations and receipts on expiry',async()=>{
    const clock={now:100},target=instance(clock),input=frameRecords([await material('alpha')],opts.frameBytes);
    const tinyLimit=input.manifest.bytes+1;
    const stage=createStage(target.db,{limits:{...opts,totalBytes:tinyLimit},clock:()=>clock.now});
    const a=await stage.begin(input.manifest,{generation:0,capturedAt:100});
    await expect(stage.begin(input.manifest,{generation:0,capturedAt:100})).rejects.toThrow('stage budget exceeded');
    await stage.append(a,input.frames[0]);clock.now+=opts.ttlMs;
    await expect(stage.status(a)).rejects.toThrow('session expired');
    expect(await stage.cleanup()).toEqual({sessions:1,receipts:0});
    expect(await stage.frames.count()).toBe(0);expect((await stage.budgets.get('stage'))?.reserved).toBe(0);
    const b=await stage.begin(input.manifest,{generation:0,capturedAt:clock.now});
    for(const f of input.frames)await stage.append(b,f);await stage.seal(b);await stage.commit(b);
    clock.now+=opts.receiptTtlMs;expect(await stage.cleanup()).toEqual({sessions:0,receipts:1});
    await expect(stage.status(b)).rejects.toThrow('session unavailable');
  });
  it('supports an empty transfer while enforcing the generation guard and idempotent receipt',async()=>{
    const target=instance(),{token}=await upload(target.stage,[]);await target.stage.seal(token);
    expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:0});
    expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:0});
    const other=instance(),second=await upload(other.stage,[]);await other.stage.seal(second.token);await other.repo.clear(101);
    await expect(other.stage.commit(second.token)).rejects.toThrow('session unavailable');
  });
  it('bounds zero-byte sessions and retained receipts by a shared slot budget',async()=>{
    const clock={now:100},target=instance(clock);
    const stage=createStage(target.db,{limits:{...opts,slots:2},clock:()=>clock.now});
    const empty=frameRecords([],opts.frameBytes).manifest, guard={generation:0,capturedAt:100};
    const a=await stage.begin(empty,guard),b=await stage.begin(empty,guard);
    await expect(stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    await stage.seal(a);await stage.commit(a);
    // A durable receipt continues to occupy a slot until its expiry.
    await expect(stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    await stage.discard(b);await expect(stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    clock.now+=opts.ttlMs;expect(await stage.cleanup()).toEqual({sessions:0,receipts:0});
    const c=await stage.begin(empty,guard);
    expect((await stage.budgets.get('stage'))?.slots).toBe(2);
    clock.now+=opts.ttlMs;expect(await stage.cleanup()).toEqual({sessions:1,receipts:0});
    expect((await stage.budgets.get('stage'))?.slots).toBe(1);
    clock.now+=opts.receiptTtlMs;expect(await stage.cleanup()).toEqual({sessions:0,receipts:1});
    expect((await stage.budgets.get('stage'))?.slots).toBe(0);
    await expect(stage.status(c)).rejects.toThrow('session unavailable');
  });
  it('bounds the global reserved frame count even when the byte budget has room',async()=>{
    const target=instance(),input=frameRecords([await material('alpha')],opts.frameBytes);
    const stage=createStage(target.db,{limits:{...opts,totalFrames:input.manifest.frames},clock:()=>target.clock.now});
    const guard={generation:0,capturedAt:100},a=await stage.begin(input.manifest,guard);
    await expect(stage.begin(input.manifest,guard)).rejects.toThrow('stage budget exceeded');
    expect(await stage.discard(a)).toBe('discarded');
    const b=await stage.begin(input.manifest,guard);expect((await stage.status(b)).state).toBe('open');
  });
  it('serializes a concurrent clear behind an in-flight atomic commit and retains its historical receipt',async()=>{
    const target=instance(),template=await material('base');
    const records=Array.from({length:80},(_,i)=>({...template,id:`id-${i}`,title:`item ${i}`,
      source:{kind:'article',url:`https://example.test/item-${i}`,title:`item ${i}`}}));
    const {token}=await upload(target.stage,records);await target.stage.seal(token);
    const other=database(target.db.name),otherStage=createStage(other,{limits:opts,clock:()=>target.clock.now});await other.open();
    const otherRepo=new MaterialRepository(other),started=deferred();
    let clearPromise:Promise<void>|undefined,discardPromise:Promise<'discarded'|'committed'>|undefined,commitDone=false,beganDuringCommit=false;
    let scheduled=false;
    const schedule=function(this:{onsuccess?:(id:string)=>void}){this.onsuccess=()=>{if(!scheduled){scheduled=true;setTimeout(()=>{
      beganDuringCommit=!commitDone;clearPromise=otherRepo.clear(101);discardPromise=otherStage.discard(token);started.resolve();
    },0);}};};
    target.db.materials.hook('creating',schedule);
    let result:Awaited<ReturnType<typeof target.stage.commit>>;
    try{result=await target.stage.commit(token);}
    finally{target.db.materials.hook('creating').unsubscribe(schedule);}
    commitDone=true;await started.promise;expect(beganDuringCommit).toBe(true);await clearPromise;
    expect(await discardPromise).toBe('committed');
    expect(result.inserted).toBe(80);expect(await target.db.materials.count()).toBe(0);
    expect(await target.stage.status(token)).toEqual({state:'committed',result});
    expect(await target.stage.commit(token)).toEqual(result);expect(await target.db.materials.count()).toBe(0);
  },20000);
  it('preserves existing material data across a simulated v1-to-v2 Dexie schema upgrade',async()=>{
    const name=`material-stage-test-${++serial}`;names.add(name);const old=legacyDatabase(name);const repo=new MaterialRepository(old);
    await repo.capture({source:{kind:'article',url:'https://example.test/preupgrade',title:'before'},capturedAt:10},10);
    expect(old.isOpen()).toBe(true);
    const newer=database(old.name),stage=createStage(newer,{limits:opts,clock:()=>100});
    await newer.open();
    // fake-indexeddb dispatches versionchange; Dexie closes the older handle.
    expect(old.isOpen()).toBe(false);
    expect((await new MaterialRepository(newer).list())[0].title).toBe('before');
    const empty=frameRecords([],opts.frameBytes),token=await stage.begin(empty.manifest,{generation:0,capturedAt:100});
    await stage.seal(token);expect(await stage.commit(token)).toEqual({inserted:0,updated:0,skipped:0});
    // The old Dexie schema can reopen a newer database in this fixture and
    // continue writing the shared material store; it must not drop staging.
    await old.open();expect(old.isOpen()).toBe(true);
    await repo.capture({source:{kind:'article',url:'https://example.test/legacy-write',title:'legacy'},capturedAt:20},20);
    expect((await new MaterialRepository(newer).list()).map(item=>item.title).sort()).toEqual(['before','legacy']);
    expect(await stage.receipts.count()).toBe(1);
    const original=(await repo.list()).find(item=>item.title==='before')!;
    const backup={...original,updatedAt:15};
    const first=await upload(stage,[backup]);await stage.seal(first.token);
    await repo.capture({source:{kind:'article',url:'https://example.test/preupgrade',title:'before'},capturedAt:20},20);
    expect(await stage.commit(first.token)).toEqual({inserted:0,updated:0,skipped:1});
    expect((await repo.get(original.id))?.updatedAt).toBe(20);
    const second=await upload(stage,[backup]);await stage.seal(second.token);
    await new MaterialRepository(newer).clear(101);
    await expect(stage.commit(second.token)).rejects.toThrow('session unavailable');
    expect(await newer.materials.count()).toBe(0);
  });
});

describe('adversarial admission and mutable caller input',()=>{
  it('validates and uses a single capability snapshot in every session operation',async()=>{
    const target=instance(),input=frameRecords([{}],opts.frameBytes),guard={generation:0,capturedAt:100};
    const capability={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    async function withChangingCapability<T>(cap:Capability,operation:(value:Capability)=>Promise<T>):Promise<T>{
      let ids=0,tokens=0;
      const changing={
        get id(){if(++ids>1)throw Error('id read again');return cap.id;},
        get token(){if(++tokens>1)throw Error('token read again');return cap.token;},
      };
      const result=await operation(changing);
      expect([ids,tokens]).toEqual([1,1]);return result;
    }
    expect(await withChangingCapability(capability,cap=>target.stage.beginRecoverable(input.manifest,guard,cap,{deadline:1000}))).toEqual(capability);
    await withChangingCapability(capability,cap=>target.stage.resume(cap));
    expect(await withChangingCapability(capability,cap=>target.stage.append(cap,input.frames[0]))).toEqual({nextSeq:1});
    await withChangingCapability(capability,cap=>target.stage.seal(cap));
    expect(await withChangingCapability(capability,cap=>target.stage.commit(cap))).toEqual({inserted:0,updated:0,skipped:1});
    expect(await withChangingCapability(capability,cap=>target.stage.status(cap))).toEqual({state:'committed',result:{inserted:0,updated:0,skipped:1}});
    expect(await withChangingCapability(capability,cap=>target.stage.acknowledge(cap))).toBe('released-or-unavailable');
    const other=await target.stage.begin(input.manifest,guard);
    expect(await withChangingCapability(other,cap=>target.stage.discard(cap))).toBe('discarded');

    const invalid={get id(){return 'invalid';},get token():string{throw Error('token should not be read');}};
    await expect(target.stage.resume(invalid)).rejects.toThrow('session unavailable');
    await expect(target.stage.resume({id:crypto.randomUUID(),token:'a'.repeat(1024*1024)})).rejects.toThrow('session unavailable');
  });
  it('rejects arbitrary sessions and wrong tokens without taking slots or copying frames',async()=>{
    const target=instance(),input=frameRecords([await material('attack')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    let copies=0;const payload=new Uint8Array(input.frames[0].bytes);
    payload.slice=()=>{copies++;throw Error('unauthenticated copy');};
    const badFrame={...input.frames[0],bytes:payload};
    const attacks=Array.from({length:100},()=>target.stage.append({id:crypto.randomUUID(),token:'0'.repeat(64)},badFrame).catch(e=>e.message));
    attacks.push(target.stage.append({...token,token:'0'.repeat(64)},badFrame).catch(e=>e.message));
    const valid=target.stage.append(token,input.frames[0]);
    expect((await Promise.all(attacks)).every(x=>x.includes('session unavailable'))).toBe(true);
    expect(await valid).toEqual({nextSeq:1});expect(copies).toBe(0);
  });
  it('refreshes durable expiry when acknowledging an identical frame retry',async()=>{
    const clock={now:100},target=instance(clock),input=frameRecords([await material('retry')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    await target.stage.append(token,input.frames[0]);
    clock.now+=opts.ttlMs-1;
    expect(await target.stage.append(token,input.frames[0])).toEqual({nextSeq:1});
    clock.now+=1;
    expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:1});
    for(const frame of input.frames.slice(1))await target.stage.append(token,frame);
    await target.stage.seal(token);
  });
  it('snapshots a manifest and guard before database awaits',async()=>{
    const target=instance(),manifest=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const pending=target.stage.begin(manifest,guard);
    manifest.bytes=1;manifest.frames=1;guard.generation=999;guard.capturedAt=0;
    const cap=await pending,row=await target.stage.sessions.get(cap.id);
    expect(row).toMatchObject({bytes:0,frames:0,guard:{generation:0,capturedAt:100}});
    expect(await target.stage.discard(cap)).toBe('discarded');
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:0});
  });
  it('snapshots the caller capability before asynchronous operations',async()=>{
    const target=instance(),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);
    const mutable={...a},pending=target.stage.discard(mutable);
    mutable.id=b.id;mutable.token=b.token;
    expect(await pending).toBe('discarded');
    await expect(target.stage.status(a)).rejects.toThrow('session unavailable');
    expect(await target.stage.status(b)).toEqual({state:'open',nextSeq:0});
  });
  it('does not create an orphan when begin is cancelled behind an IDB write lock',async()=>{
    const target=instance(), input=frameRecords([],opts.frameBytes), other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred();
    const locking=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});
    await ready.promise;
    const controller=new AbortController();
    const pending=Dexie.ignoreTransaction(()=>target.stage.begin(input.manifest,{generation:0,capturedAt:100},{signal:controller.signal})).then(()=> 'created',e=>e.message);
    controller.abort();
    try {expect(await Promise.race([pending,new Promise<string>(r=>setTimeout(()=>r('timeout'),100))])).toContain('cancelled');}
    finally {hold.resolve();await locking;await pending;}
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.sessions.count())).toBe(0));
    expect(await Dexie.ignoreTransaction(()=>target.stage.budgets.get('stage'))).toBeUndefined();
  });
  it('rejects a recoverable start whose deadline expires behind the database write lock',async()=>{
    const clock={now:100},target=instance(clock),other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred(),manifest=frameRecords([],opts.frameBytes).manifest;
    const cap=createMaterialImportCapability(),guard={generation:0,capturedAt:100};
    const locking=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const pending=Dexie.ignoreTransaction(()=>target.stage.beginRecoverable(manifest,guard,cap,{deadline:200}));
    const rejected=expect(pending).rejects.toThrow('session unavailable');
    clock.now=200;hold.resolve();await locking;
    await rejected;
    expect(await target.stage.sessions.count()).toBe(0);expect(await target.stage.budgets.get('stage')).toBeUndefined();
    expect(await target.db.table('stageStarts').count()).toBe(0);
  });
  it('starts a new session TTL when its blocked creation actually reaches storage',async()=>{
    const clock={now:100},target=instance(clock),manifest=frameRecords([],opts.frameBytes).manifest,other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred();
    const locking=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const pending=Dexie.ignoreTransaction(()=>target.stage.begin(manifest,{generation:0,capturedAt:100}));
    clock.now+=Math.floor(opts.ttlMs/2);hold.resolve();await locking;
    const token=await pending;
    expect(await Dexie.ignoreTransaction(()=>target.stage.status(token))).toEqual({state:'open',nextSeq:0});
    expect((await Dexie.ignoreTransaction(()=>target.stage.sessions.get(token.id))).expiresAt).toBe(clock.now+opts.ttlMs);
    await Dexie.ignoreTransaction(()=>target.stage.discard(token));
  });
  it('bounds cancelled begin requests until their underlying work and cleanup settle',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:2}}), manifest=frameRecords([],opts.frameBytes).manifest;
    const first=deferred(),second=deferred();
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>first.promise as never).mockImplementationOnce(()=>second.promise as never);
    const a=new AbortController(),b=new AbortController();
    const pendingA=target.stage.begin(manifest,{generation:0,capturedAt:100},{signal:a.signal});
    const pendingB=target.stage.begin(manifest,{generation:0,capturedAt:100},{signal:b.signal});
    a.abort();b.abort();await expect(pendingA).rejects.toThrow('cancelled');await expect(pendingB).rejects.toThrow('cancelled');
    expect(transaction).toHaveBeenCalledTimes(2);
    await expect(target.stage.begin(manifest,{generation:0,capturedAt:100})).rejects.toThrow('backpressure');
    first.resolve();second.resolve();
    await vi.waitFor(async()=>{const cap=await target.stage.begin(manifest,{generation:0,capturedAt:100});await target.stage.discard(cap);});
  });
  it('keeps admitted operations separate from saturated cold authentication',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:2}}),manifest=frameRecords([],opts.frameBytes).manifest;
    const valid=await target.stage.begin(manifest,{generation:0,capturedAt:100}),other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred();
    const locking=other.transaction('rw',other.table('stageSessions'),async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const transaction=vi.spyOn(target.db,'transaction');
    const fake=()=>({id:crypto.randomUUID(),token:'0'.repeat(64)});
    const first=Dexie.ignoreTransaction(()=>target.stage.status(fake())).then(()=> 'accepted',e=>e.message);
    const second=Dexie.ignoreTransaction(()=>target.stage.status(fake())).then(()=> 'accepted',e=>e.message);
    await vi.waitFor(()=>expect(transaction).toHaveBeenCalledTimes(2));
    await expect(Dexie.ignoreTransaction(()=>target.stage.status(fake()))).rejects.toThrow('resume busy');
    const pending=Dexie.ignoreTransaction(()=>target.stage.seal(valid));
    await vi.waitFor(()=>expect(transaction).toHaveBeenCalledTimes(3));
    hold.resolve();await locking;
    expect((await Promise.all([first,second])).every(message=>message.includes('session unavailable'))).toBe(true);
    await pending;expect((await Dexie.ignoreTransaction(()=>target.stage.status(valid))).state).toBe('sealed');
  });
  it('limits status calls per session and in total without blocking a separate seal lane',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:2}}), manifest=frameRecords([],opts.frameBytes).manifest;
    const a=await target.stage.begin(manifest,{generation:0,capturedAt:100}),b=await target.stage.begin(manifest,{generation:0,capturedAt:100}),c=await target.stage.begin(manifest,{generation:0,capturedAt:100});
    let resolveA!:(v:{state:'open';nextSeq:number})=>void,resolveB!:(v:{state:'open';nextSeq:number})=>void;
    const first=new Promise<{state:'open';nextSeq:number}>(r=>{resolveA=r;}),second=new Promise<{state:'open';nextSeq:number}>(r=>{resolveB=r;});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>first as never).mockImplementationOnce(()=>second as never);
    const controller=new AbortController(),requestOptions:{signal?:AbortSignal}={signal:controller.signal};
    const p1=target.stage.status(a,requestOptions),p2=target.stage.status(b);
    await vi.waitFor(()=>expect(transaction).toHaveBeenCalledTimes(2));requestOptions.signal=undefined;controller.abort();
    await expect(p1).rejects.toThrow('cancelled');
    await expect(target.stage.status(a)).rejects.toThrow('backpressure');
    await expect(target.stage.status(c)).rejects.toThrow('backpressure');
    await target.stage.seal(c);expect(await target.stage.sessions.get(c.id)).toMatchObject({phase:'sealed'});
    resolveA({state:'open',nextSeq:0});resolveB({state:'open',nextSeq:0});expect(await p2).toEqual({state:'open',nextSeq:0});
    await vi.waitFor(async()=>expect(await target.stage.status(a)).toEqual({state:'open',nextSeq:0}));
  });
  it('limits concurrent seal and discard calls independently',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}}),manifest=frameRecords([],opts.frameBytes).manifest;
    const a=await target.stage.begin(manifest,{generation:0,capturedAt:100}),b=await target.stage.begin(manifest,{generation:0,capturedAt:100});
    const held=deferred();const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>held.promise as never);
    const controller=new AbortController(), pending=target.stage.seal(a,{signal:controller.signal});
    await vi.waitFor(()=>expect(transaction).toHaveBeenCalledOnce());controller.abort();await expect(pending).rejects.toThrow('cancelled');
    await expect(target.stage.seal(a)).rejects.toThrow('backpressure');await expect(target.stage.seal(b)).rejects.toThrow('backpressure');
    expect(await target.stage.discard(b)).toBe('discarded');
    held.resolve();await vi.waitFor(async()=>{await target.stage.seal(a);});
  });
  it('bounds cleanup while preserving its slot after caller cancellation',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:1}});
    let finish!:(value:{sessions:number;receipts:number})=>void;
    const held=new Promise<{sessions:number;receipts:number}>(resolve=>{finish=resolve;});
    const transaction=vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>held as never);
    const controller=new AbortController(),pending=target.stage.cleanup({signal:controller.signal});
    await vi.waitFor(()=>expect(transaction).toHaveBeenCalledOnce());controller.abort();await expect(pending).rejects.toThrow('cancelled');
    await expect(target.stage.cleanup()).rejects.toThrow('backpressure');
    finish({sessions:0,receipts:0});await vi.waitFor(async()=>expect(await target.stage.cleanup()).toEqual({sessions:0,receipts:0}));
  });
  it('reuses one transaction-scoped capacity count when importing many new records',async()=>{
    const target=instance(), sample=await material('bulk-source');
    const records=Array.from({length:100},(_,i)=>({...sample,id:`record-${i}`,source:{kind:'article',url:`https://example.test/bulk-${i}`,title:'bulk'}}));
    const {token}=await upload(target.stage,records);await target.stage.seal(token);
    const count=vi.spyOn(target.db.materials,'count');
    expect(await target.stage.commit(token)).toEqual({inserted:100,updated:0,skipped:0});
    expect(count).toHaveBeenCalledTimes(1);
  });
  it('returns on cancellation during a blocked commit and never commits after its lock clears',async()=>{
    const target=instance(), input=frameRecords([await material('commit-blocked')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    for(const frame of input.frames)await target.stage.append(token,frame);await target.stage.seal(token);
    const other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred();
    const locking=other.transaction('rw',other.table('stageSessions'),async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});
    await ready.promise;
    const controller=new AbortController(), commitOptions:{signal?:AbortSignal}={signal:controller.signal};
    const pending=Dexie.ignoreTransaction(()=>target.stage.commit(token,commitOptions)).then(()=> 'committed',e=>e.message);
    commitOptions.signal=undefined;controller.abort();
    try {
      const outcome=await Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve('timeout'),100))]);
      expect(outcome).toContain('cancelled');
    } finally {hold.resolve();await locking;await pending;}
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.status(token))).toEqual({state:'sealed',nextSeq:input.frames.length}));
    expect(await Dexie.ignoreTransaction(()=>target.db.materials.count())).toBe(0);
    expect(await Dexie.ignoreTransaction(()=>target.stage.receipts.count())).toBe(0);
    await vi.waitFor(async()=>expect(await Dexie.ignoreTransaction(()=>target.stage.commit(token))).toEqual({inserted:1,updated:0,skipped:0}));
  });
  it.each(['complete','abort'] as const)('removes the original caller signal listener after options mutate on %s',async outcome=>{
    const gate=deferred(),ready=deferred();
    const target=instance({now:100},{beforeAppend:()=>{ready.resolve();return gate.promise;}});
    const input=frameRecords([await material('signal-options')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const controller=new AbortController(), replacement=new AbortController();
    const add=vi.spyOn(controller.signal,'addEventListener'), remove=vi.spyOn(controller.signal,'removeEventListener');
    const requestOptions:{signal?:AbortSignal}={signal:controller.signal};
    const pending=target.stage.append(token,input.frames[0],requestOptions);
    await ready.promise;
    const listener=add.mock.calls.find(([type])=>type==='abort')?.[1];expect(listener).toBeDefined();
    requestOptions.signal=replacement.signal;
    if(outcome==='abort'){
      controller.abort();await expect(pending).rejects.toThrow('cancelled');gate.resolve();
    }else{
      gate.resolve();expect(await pending).toEqual({nextSeq:1});
    }
    expect(remove).toHaveBeenCalledWith('abort',listener);
  });
  it('requires explicit bounded reattachment after the admission cache is lost',async()=>{
    const target=instance(),input=frameRecords([await material('resume')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage');
    const restarted=fresh.createStage(target.db,{limits:opts,clock:()=>100});
    await expect(restarted.append(token,input.frames[0])).rejects.toThrow('resume required');
    await expect(restarted.resume({...token,token:'0'.repeat(64)})).rejects.toThrow('session unavailable');
    await restarted.resume(token);
    expect(await restarted.append(token,input.frames[0])).toEqual({nextSeq:1});
    await restarted.discard(token);
    await expect(restarted.append(token,input.frames[0])).rejects.toThrow('resume required');
  });
  it('retains the commit admission slot while an uncooperative transaction remains unsettled',async()=>{
    const target=instance(), input=frameRecords([],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});await target.stage.seal(token);
    let finish!:(value:{inserted:number;updated:number;skipped:number})=>void;
    const blocked=new Promise<{inserted:number;updated:number;skipped:number}>(resolve=>{finish=resolve;});
    vi.spyOn(target.db,'transaction').mockImplementationOnce(()=>blocked as never);
    const controller=new AbortController();
    const pending=target.stage.commit(token,{signal:controller.signal});controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(target.stage.commit(token)).rejects.toThrow('backpressure');
    finish({inserted:0,updated:0,skipped:0});
    await vi.waitFor(async()=>expect(await target.stage.commit(token)).toEqual({inserted:0,updated:0,skipped:0}));
  });
  it('reauthenticates sealed transfers and durable receipts after receiver restart',async()=>{
    const target=instance(), input=frameRecords([await material('restart-commit')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    for(const frame of input.frames)await target.stage.append(token,frame);await target.stage.seal(token);
    vi.resetModules();
    const fresh=await import('@/src/features/vocabulary/materialImportStage');
    const restarted=fresh.createStage(target.db,{limits:opts,clock:()=>100});
    expect(await restarted.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    vi.resetModules();
    const freshAgain=await import('@/src/features/vocabulary/materialImportStage');
    const restartedAgain=freshAgain.createStage(target.db,{limits:opts,clock:()=>100});
    expect(await restartedAgain.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    expect(await target.db.materials.count()).toBe(1);
  });
  it('returns on cancellation during a blocked authentication read without releasing its active slot early',async()=>{
    const target=instance(), input=frameRecords([await material('blocked-auth')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const other=database(target.db.name), stage=createStage(other,{limits:opts,clock:()=>100});
    await other.open();
    const hold=deferred(), ready=deferred();
    const locking=target.db.transaction('rw',target.stage.sessions,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});
    await ready.promise;
    const controller=new AbortController();
    const pending=stage.append(token,input.frames[0],{signal:controller.signal}).then(()=> 'accepted',e=>e.message);
    controller.abort();
    try {
      const outcome=await Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve('timeout'),100))]);
      expect(outcome).toBe('cancelled');
      await expect(stage.append(token,input.frames[0])).rejects.toThrow('backpressure');
    } finally {hold.resolve();await locking;}
    await vi.waitFor(async()=>expect(await stage.append(token,input.frames[0])).toEqual({nextSeq:1}));
    await stage.discard(token);
  });
  it('aborts a blocked append write and does not stage it after the lock is released',async()=>{
    const ready=deferred(),start=deferred(),hold=deferred(),locked=deferred();
    const target=instance({now:100},{beforeAppend:()=>{ready.resolve();return start.promise;}});
    const input=frameRecords([await material('blocked-write')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const other=database(target.db.name), stage=createStage(other,{limits:opts,clock:()=>100});
    await other.open();
    const controller=new AbortController();
    const pending=target.stage.append(token,input.frames[0],{signal:controller.signal}).then(()=> 'accepted',e=>e.name);
    await ready.promise;
    const locking=other.transaction('rw',stage.sessions,async()=>{locked.resolve();await Dexie.waitFor(hold.promise);});
    await locked.promise;start.resolve();
    await new Promise<void>(resolve=>setTimeout(resolve,10));controller.abort();
    try {
      const outcome=await Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve('timeout'),100))]);
      expect(outcome).toBe('AbortError');
    } finally {hold.resolve();await locking.catch(error=>{throw Error(`lock rejected: ${error}`);});}
    expect(await Dexie.ignoreTransaction(()=>stage.status(token))).toEqual({state:'open',nextSeq:0});
    expect(await Dexie.ignoreTransaction(()=>stage.append(token,input.frames[0]))).toEqual({nextSeq:1});
    await Dexie.ignoreTransaction(()=>stage.discard(token));
  });
  it('caps cold resume requests separately and keeps admitted traffic independent',async()=>{
    const target=instance({now:100},{limits:{...opts,inflight:2}}),input=frameRecords([await material('resume-limit')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const db2=database(target.db.name),second=createStage(db2,{limits:{...opts,inflight:2},clock:()=>100});await db2.open();
    const hold=deferred(),ready=deferred();
    const locking=target.db.transaction('rw',target.stage.sessions,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});
    await ready.promise;
    const a=second.resume({id:crypto.randomUUID(),token:'0'.repeat(64)}).catch(e=>e.message);
    const b=second.resume({id:crypto.randomUUID(),token:'0'.repeat(64)}).catch(e=>e.message);
    await expect(second.resume({id:crypto.randomUUID(),token:'0'.repeat(64)})).rejects.toThrow('resume busy');
    const valid=second.append(token,input.frames[0]);
    hold.resolve();await locking;
    expect((await Promise.all([a,b])).every(x=>x.includes('session unavailable'))).toBe(true);
    expect(await valid).toEqual({nextSeq:1});
  });
});

describe('dynamic staging capacity',()=>{
  const large:Manifest={records:3,frames:2511,bytes:328773783,digest:'0'.repeat(64)};
  const guard={generation:0,capturedAt:100};
  const request={deadline:10000};
  const bigEstimate=()=>Promise.resolve({quota:2*1024**3,usage:0});
  it('reserves a 329 MB manifest with sufficient estimated space without allocating payloads',async()=>{
    const db=database(),stage=createStage(db,{clock:()=>100,estimate:bigEstimate}),cap=createMaterialImportCapability();
    await expect(stage.beginRecoverable(large,guard,cap,request)).resolves.toEqual(cap);
    expect(await stage.budgets.get('stage')).toMatchObject({reserved:large.bytes,reservedFrames:large.frames,slots:1});
    await stage.discard(cap);expect(await stage.budgets.get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:0});
  });
  it.each([undefined,()=>Promise.reject(Error('private failure')),()=>Promise.resolve({quota:NaN,usage:0})])('uses a conservative fallback for unavailable or invalid estimates',async estimate=>{
    const db=database(),stage=createStage(db,{clock:()=>100,estimate}),cap=createMaterialImportCapability();
    await expect(stage.beginRecoverable(large,guard,cap,request)).rejects.toMatchObject({name:'MaterialBackupCapacityError'});
    expect(await stage.sessions.count()).toBe(0);expect(await stage.budgets.get('stage')).toBeUndefined();
  });
  it('rejects reservations exceeding a low valid estimate with no writes',async()=>{
    const db=database(),stage=createStage(db,{clock:()=>100,estimate:async()=>({quota:128*1024**2+3000,usage:0})});
    const manifest={records:1,frames:1,bytes:1001,digest:'0'.repeat(64)};
    await expect(stage.beginRecoverable(manifest,guard,createMaterialImportCapability(),request)).rejects.toMatchObject({name:'MaterialBackupCapacityError'});
    expect(await stage.sessions.count()).toBe(0);expect(await db.table('stageStarts').count()).toBe(0);
  });
  it('serializes competing reservations from independent database connections',async()=>{
    const db=database(),peer=database(db.name),estimate=async()=>({quota:128*1024**2+3000,usage:0});
    const a=createStage(db,{clock:()=>100,estimate}),b=createStage(peer,{clock:()=>100,estimate});
    const manifest={records:1,frames:1,bytes:600,digest:'0'.repeat(64)};
    const results=await Promise.allSettled([a.beginRecoverable(manifest,guard,createMaterialImportCapability(),request),b.beginRecoverable(manifest,guard,createMaterialImportCapability(),request)]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(results.find(x=>x.status==='rejected')).toMatchObject({reason:{name:'MaterialBackupCapacityError'}});
    expect(await a.budgets.get('stage')).toMatchObject({reserved:600,slots:1});
  });
  it('rejects an estimate invalidated by clock rollback without creating a session',async()=>{
    const clock={now:100},db=database(),stage=createStage(db,{clock:()=>clock.now,estimate:async()=>{clock.now=99;return {quota:2*1024**3,usage:0};}});
    await expect(stage.beginRecoverable(large,guard,createMaterialImportCapability(),request)).rejects.toThrow('capacity estimate expired');
    expect(await stage.sessions.count()).toBe(0);expect(await stage.budgets.get('stage')).toBeUndefined();
  });
  it('rejects an estimate that became stale before the write transaction',async()=>{
    const clock={now:100},db=database(),entered=deferred(),release=deferred();
    const stage=createStage(db,{clock:()=>clock.now,estimate:async()=>{entered.resolve();await release.promise;return {quota:2*1024**3,usage:0};}});
    const pending=stage.beginRecoverable(large,guard,createMaterialImportCapability(),request);
    await entered.promise;clock.now=5200;release.resolve();
    await expect(pending).rejects.toThrow('capacity estimate expired');
    expect(await stage.sessions.count()).toBe(0);expect(await stage.budgets.get('stage')).toBeUndefined();
  });
  it('rolls back the reservation if IndexedDB rejects the session write for quota',async()=>{
    const db=database(),stage=createStage(db,{clock:()=>100,estimate:bigEstimate});
    const fail=()=>{throw new DOMException('quota','QuotaExceededError');};stage.sessions.hook('creating',fail);
    try{await expect(stage.beginRecoverable(large,guard,createMaterialImportCapability(),request)).rejects.toMatchObject({name:'QuotaExceededError'});}
    finally{stage.sessions.hook('creating').unsubscribe(fail);}
    expect(await stage.sessions.count()).toBe(0);expect(await stage.budgets.get('stage')).toBeUndefined();expect(await db.table('stageStarts').count()).toBe(0);
  });
  it('cancels while estimating without reserving storage',async()=>{
    const db=database(),started=deferred(),blocked=deferred(),controller=new AbortController();
    const stage=createStage(db,{clock:()=>100,estimate:async()=>{started.resolve();await blocked.promise;return {quota:2*1024**3,usage:0};}});
    const pending=stage.beginRecoverable(large,guard,createMaterialImportCapability(),{...request,signal:controller.signal});
    await started.promise;controller.abort();await expect(pending).rejects.toThrow('cancelled');blocked.resolve();
    expect(await stage.sessions.count()).toBe(0);expect(await stage.budgets.get('stage')).toBeUndefined();
  });
  it('recovers existing sessions and receipts without calling a stalled estimator',async()=>{
    const db=database(),estimate=vi.fn(bigEstimate),stage=createStage(db,{clock:()=>100,estimate});
    const manifest=frameRecords([],128).manifest,cap=createMaterialImportCapability();
    await stage.beginRecoverable(manifest,guard,cap,request);
    estimate.mockImplementation(()=>new Promise(()=>{}));
    await expect(stage.beginRecoverable(manifest,guard,cap,request)).resolves.toEqual(cap);
    await stage.seal(cap);await stage.commit(cap);
    await expect(stage.beginRecoverable(manifest,guard,cap,request)).resolves.toEqual(cap);
    expect(estimate).toHaveBeenCalledTimes(1);
  });
  it.each(['before','after'] as const)('settles and releases the begin lane when estimate listener removal throws %s native removal',async mode=>{
    const db=database(),blocked=deferred(),started=deferred(),controller=new AbortController();
    const estimate=vi.fn(async()=>{started.resolve();await blocked.promise;return {quota:2*1024**3,usage:0};});
    const stage=createStage(db,{clock:()=>100,estimate,limits:{inflight:1}}),signal=controller.signal;
    const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
    let registrations=0,inner:EventListenerOrEventListenerObject|null=null;
    const addSpy=vi.spyOn(signal,'addEventListener').mockImplementation((type,listener,options)=>{
      if(type==='abort'&&++registrations===2)inner=listener;add(type,listener,options);
    });
    const removeSpy=vi.spyOn(signal,'removeEventListener').mockImplementation((type,listener,options)=>{
      if(listener===inner){if(mode==='after')remove(type,listener,options);throw Error('estimate removal failed');}
      remove(type,listener,options);
    });
    const empty=frameRecords([],128).manifest;
    try{
      const cap=createMaterialImportCapability(),pending=stage.beginRecoverable(empty,guard,cap,{...request,signal});
      await started.promise;expect(inner).not.toBeNull();blocked.resolve();
      await expect(pending).resolves.toEqual(cap);
      await expect(stage.beginRecoverable(empty,guard,createMaterialImportCapability(),request)).resolves.toBeDefined();
      expect(estimate).toHaveBeenCalledTimes(2);
    }finally{blocked.resolve();if(inner)remove('abort',inner);addSpy.mockRestore();removeSpy.mockRestore();}
  });
  it.each(['before','after','abort'] as const)('cleans an estimate registration that throws %s',async mode=>{
    const db=database(),blocked=deferred(),controller=new AbortController(),error=Error('estimate registration failed');
    const estimate=vi.fn(async()=>{await blocked.promise;return {quota:2*1024**3,usage:0};});
    const stage=createStage(db,{clock:()=>100,estimate,limits:{inflight:1}}),signal=controller.signal;
    const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
    let registrations=0,inner:EventListenerOrEventListenerObject|null=null;
    const addSpy=vi.spyOn(signal,'addEventListener').mockImplementation((type,listener,options)=>{
      if(type==='abort'&&++registrations===2){
        inner=listener;if(mode!=='before')add(type,listener,options);
        if(mode==='abort')controller.abort();throw error;
      }
      add(type,listener,options);
    });
    const removeSpy=vi.spyOn(signal,'removeEventListener');
    const timerSpy=vi.spyOn(globalThis,'setTimeout'),clearSpy=vi.spyOn(globalThis,'clearTimeout');
    const empty=frameRecords([],128).manifest;
    try{
      const pending=stage.beginRecoverable(empty,guard,createMaterialImportCapability(),{...request,signal});
      if(mode==='abort')await expect(pending).rejects.toThrow('cancelled');
      else await expect(pending).rejects.toBe(error);
      expect(inner).not.toBeNull();expect(removeSpy).toHaveBeenCalledWith('abort',inner);
      const timerIndex=timerSpy.mock.calls.findIndex(([,delay])=>delay===2000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      expect(clearSpy).toHaveBeenCalledWith(timerSpy.mock.results[timerIndex].value);
      // The failed outer request must not free the underlying estimator's lane early.
      await vi.waitFor(async()=>expect(await stage.beginRecoverable(empty,guard,createMaterialImportCapability(),request)).toBeDefined());
      expect(estimate).toHaveBeenCalledTimes(1);
      blocked.resolve();await vi.waitFor(async()=>{
        await stage.beginRecoverable(empty,guard,createMaterialImportCapability(),request);
        expect(estimate).toHaveBeenCalledTimes(2);
      });
    }finally{blocked.resolve();if(inner)remove('abort',inner);addSpy.mockRestore();removeSpy.mockRestore();timerSpy.mockRestore();clearSpy.mockRestore();}
  });
  it.each(['pre-aborted','silent-abort','silent-abort-on-throw','getter-error','abort-then-getter-error'] as const)(
    'handles a caller-modified estimate signal: %s',async mode=>{
      const db=database(),controller=new AbortController(),signal=controller.signal,blocked=deferred(),error=Error('signal getter failed');
      const stage=createStage(db,{clock:()=>100,estimate:async()=>{await blocked.promise;return {quota:2*1024**3,usage:0};}});
      const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
      let registrations=0,reads=0,inner:EventListenerOrEventListenerObject|null=null;
      const getter=vi.spyOn(signal,'aborted','get');
      if(mode==='pre-aborted')getter.mockImplementation(()=>++reads>=6);
      const addSpy=vi.spyOn(signal,'addEventListener').mockImplementation((type,listener,options)=>{
        if(type==='abort'&&++registrations===2){
          inner=listener;add(type,listener,options);
          if(mode==='silent-abort'||mode==='silent-abort-on-throw')getter.mockReturnValue(true);
          if(mode==='getter-error')getter.mockImplementation(()=>{throw error;});
          if(mode==='abort-then-getter-error')getter.mockImplementation(()=>{controller.abort();throw error;});
          if(mode==='silent-abort-on-throw')throw Error('registration failed');
          return;
        }
        add(type,listener,options);
      });
      try{
        const pending=stage.beginRecoverable(frameRecords([],128).manifest,guard,createMaterialImportCapability(),{...request,signal});
        if(mode==='getter-error')await expect(pending).rejects.toBe(error);
        else await expect(pending).rejects.toThrow('cancelled');
        expect(await stage.sessions.count()).toBe(0);
      }finally{blocked.resolve();if(inner)remove('abort',inner);addSpy.mockRestore();getter.mockRestore();}
    },
  );
  it('bounds stalled estimators and falls back after timeout',async()=>{
    const blocked=deferred(),estimate=vi.fn(()=>blocked.promise.then(()=>({quota:2*1024**3,usage:0})));
    try{
      const db=database(),stage=createStage(db,{clock:()=>100,estimate,limits:{inflight:1}}),empty=frameRecords([],128).manifest;
      const first=stage.beginRecoverable(empty,guard,createMaterialImportCapability(),request);
      await first;
      await stage.beginRecoverable(empty,guard,createMaterialImportCapability(),request);
      expect(estimate).toHaveBeenCalledTimes(1);
      blocked.resolve();await Promise.resolve();await Promise.resolve();
    } finally{blocked.resolve();}
  });
});

describe('guarded stage transactions with exceptional signal cleanup',()=>{
  it.each(['before','after'] as const)('commits seal when signal removal throws %s native removal',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]),controller=new AbortController();
    const native=controller.signal.removeEventListener.bind(controller.signal),failure=Error('signal removal failed');
    const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw failure;});
    try {
      await expect(target.stage.seal(token,{signal:controller.signal})).resolves.toBeUndefined();
      expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'sealed'});
      controller.abort();expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'sealed'});
    } finally {remove.mockRestore();}
  });
  it.each(['before','after'] as const)('preserves incomplete-transfer failure when signal removal throws %s native removal',async mode=>{
    const target=instance(),record=await material(`guard-signal-${mode}`),input=frameRecords([record],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100}),controller=new AbortController();
    const native=controller.signal.removeEventListener.bind(controller.signal),failure=Error('signal removal failed');
    const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw failure;});
    try {
      await expect(target.stage.seal(token,{signal:controller.signal})).rejects.toThrow('incomplete transfer');
      expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'open',nextSeq:0});
    } finally {remove.mockRestore();}
  });
  it.each(['before','after'] as const)('rolls back cancellation when signal removal throws %s native removal',async mode=>{
    const target=instance(),record=await material(`guard-cancel-${mode}`),{token}=await upload(target.stage,[record]);
    const controller=new AbortController(),native=controller.signal.removeEventListener.bind(controller.signal);
    const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{if(mode==='after')native(type,listener,options);throw Error('signal removal failed');});
    const progress=vi.fn(()=>controller.abort());
    try {
      await expect(target.stage.seal(token,{signal:controller.signal,onProgress:progress})).rejects.toThrow('cancelled');
      expect(progress).toHaveBeenCalled();
      expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'open'});
    } finally {remove.mockRestore();}
    await vi.waitFor(async()=>expect(await target.stage.seal(token)).toBeUndefined());
    expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'sealed'});
  });
});

describe('guard transaction registration failures',()=>{
  it.each(['normal','throw-after'] as const)('cleans an abort listener and rolls back when registration throws and removal is %s',async mode=>{
    const target=instance(),{token}=await upload(target.stage,[]),controller=new AbortController();
    const nativeAdd=controller.signal.addEventListener.bind(controller.signal),nativeRemove=controller.signal.removeEventListener.bind(controller.signal);
    const failure=Error('signal registration failed');let guardedListener:EventListenerOrEventListenerObject|null=null,callbacks=0;
    let wrapped:EventListener|null=null,queued:PromiseLike<unknown>|undefined;
    const add=vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
      if(Dexie.currentTransaction){
        guardedListener=listener;
        wrapped=event=>{callbacks++;if(typeof listener==='function')listener.call(controller.signal,event);else listener.handleEvent(event);};
        nativeAdd(type,wrapped,options);
        queued=target.stage.sessions.update(token.id,{phase:'sealed'});void Promise.resolve(queued).catch(()=>{});
        throw failure;
      }
      nativeAdd(type,listener,options);
    });
    const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
      nativeRemove(type,listener===guardedListener&&wrapped?wrapped:listener,options);
      if(listener===guardedListener&&mode==='throw-after')throw Error('signal removal failed');
    });
    try {
      await expect(target.stage.seal(token,{signal:controller.signal})).rejects.toBe(failure);
      expect(guardedListener).not.toBeNull();
      await Promise.allSettled(queued?[queued]:[]);
      expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'open'});
      expect(remove.mock.calls.some(([,listener])=>listener===guardedListener)).toBe(true);
      controller.abort();expect(callbacks).toBe(0);
    } finally {add.mockRestore();remove.mockRestore();}
    await expect(target.stage.seal(token)).resolves.toBeUndefined();
    expect(await target.stage.sessions.get(token.id)).toMatchObject({phase:'sealed'});
  });
});
