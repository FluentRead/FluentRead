import 'fake-indexeddb/auto';
import Dexie, {type Transaction} from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createStage, type Frame} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';

const names:string[]=[];
const connections:MaterialDatabase[]=[];
const pendingDelays=new Set<()=>void>();
afterEach(async()=>{for(const release of pendingDelays)release();for(const db of connections.splice(0))db.close();for(const name of names.splice(0))await Dexie.delete(name);vi.restoreAllMocks();});
const limits={frameBytes:128,recordBytes:1024*1024,totalBytes:2*1024*1024,frameCount:10000,totalFrames:10000,slots:256,inflight:8,ttlMs:1000,receiptTtlMs:10000};
function make(options:Parameters<typeof createStage>[1]={}) {
  const name=`material-stage-b-${crypto.randomUUID()}`,db=new MaterialDatabase(name);names.push(name);connections.push(db);
  const stage=createStage(db,{limits,clock:()=>100,...options});
  const bytes=new TextEncoder().encode('{}'),hash=sha256.create();hash.update(new Uint8Array([0,0,0,bytes.length]));hash.update(bytes);
  const manifest={records:1,frames:1,bytes:bytes.length,digest:bytesToHex(hash.digest())};
  const frame:Frame={seq:0,record:0,part:0,total:1,recordBytes:bytes.length,bytes};
  const begin=async()=>{const cap=createMaterialImportCapability();await stage.beginRecoverable(manifest,{generation:0,capturedAt:100},cap,{deadline:1000});return cap;};
  return {db,stage,frame,begin};
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
// Delay the result of a real IDB authentication read only in this fixture;
// the transaction itself has already completed and does not block seal.
function delayNextAuthentication(db:MaterialDatabase) {
  const started=deferred(),gate=deferred(),transaction=db.transaction.bind(db);
  const spy=vi.spyOn(db,'transaction').mockImplementationOnce(((...args:unknown[])=>{
    if(args[0]!=='r')throw Error('expected authentication read');
    const result=(transaction as (...values:unknown[])=>Promise<unknown>)(...args);
    return Promise.resolve(result).then(async value=>{started.resolve();await gate.promise;return value;});
  }) as never);
  const release=()=>{gate.resolve();spy.mockRestore();pendingDelays.delete(release);};
  pendingDelays.add(release);return {started,release};
}
async function uploadMaterial(x:ReturnType<typeof make>) {
  const sourceName=`material-stage-b-source-${crypto.randomUUID()}`,sourceDb=new MaterialDatabase(sourceName);
  names.push(sourceName);connections.push(sourceDb);
  const record=await new MaterialRepository(sourceDb).capture({source:{kind:'article',url:'https://example.test/abort',title:'preserve'},reference:{kind:'note',id:'n',note:'private'}},10);
  const bytes=new TextEncoder().encode(JSON.stringify(record)),hash=sha256.create(),size=bytes.length;
  hash.update(new Uint8Array([(size>>>24)&255,(size>>>16)&255,(size>>>8)&255,size&255]));hash.update(bytes);
  const total=Math.ceil(size/limits.frameBytes),cap=createMaterialImportCapability();
  await x.stage.beginRecoverable({records:1,frames:total,bytes:size,digest:bytesToHex(hash.digest())},{generation:0,capturedAt:100},cap,{deadline:1000});
  for(let seq=0;seq<total;seq++)await x.stage.append(cap,{seq,record:0,part:seq,total,recordBytes:size,bytes:bytes.slice(seq*limits.frameBytes,(seq+1)*limits.frameBytes)});
  await x.stage.seal(cap);return {cap,total};
}

describe('material staging transaction boundaries',()=>{
  it('releases the capacity-estimation slot when the clock throws before the estimate starts',async()=>{
    let clockCalls=0;
    const estimate=vi.fn(async()=>({quota:2*1024**3,usage:0}));
    const x=make({clock:()=>{if(++clockCalls===2)throw Error('clock unavailable');return 100;},estimate,limits:{inflight:1}});
    const manifest={records:3,frames:2511,bytes:328773783,digest:'0'.repeat(64)},guard={generation:0,capturedAt:100},request={deadline:10000};
    const retry=createMaterialImportCapability();
    await expect(x.stage.beginRecoverable(manifest,guard,retry,request)).rejects.toThrow('clock unavailable');
    expect(estimate).not.toHaveBeenCalled();
    expect(await x.db.table('stageSessions').count()).toBe(0);
    await expect(x.stage.beginRecoverable(manifest,guard,retry,request)).resolves.toEqual(retry);
    expect(estimate).toHaveBeenCalledOnce();
    expect(await x.db.table('stageBudget').get('stage')).toMatchObject({reserved:manifest.bytes,reservedFrames:manifest.frames,slots:1});
    await expect(x.stage.discard(retry)).resolves.toBe('discarded');
  });
  it('rejects an append when a completed transfer is sealed after its authentication read',async()=>{
    const x=make(),cap=await x.begin();await x.stage.append(cap,x.frame);
    const delayed=delayNextAuthentication(x.db);
    const pending=x.stage.append(cap,x.frame);await delayed.started.promise;
    await x.stage.seal(cap);delayed.release();
    await expect(pending).rejects.toThrow('session sealed');
    expect(await x.db.table('stageFrames').count()).toBe(1);
    expect(await x.stage.status(cap)).toEqual({state:'sealed',nextSeq:1});
  });
  it('rejects a second commit while another admitted operation holds the only inflight slot',async()=>{
    const x=make({limits:{...limits,inflight:1}});
    const first=await x.begin(),second=await x.begin();await x.stage.append(second,x.frame);await x.stage.seal(second);
    const delayed=delayNextAuthentication(x.db),pending=x.stage.append(first,x.frame);await delayed.started.promise;
    await expect(x.stage.commit(second)).rejects.toThrow('backpressure: receiver busy');
    delayed.release();await pending;
    expect(await x.stage.status(second)).toEqual({state:'sealed',nextSeq:1});
  });
  it('rolls back a cancelled commit even if aborting the transaction throws',async()=>{
    const x=make(),controller=new AbortController();
    const {cap,total}=await uploadMaterial(x);
    let intercepted=false;
    const cancel=function(this:{onsuccess?:(id:string)=>void},_key:unknown,_obj:unknown,transaction:Transaction){
      this.onsuccess=()=>{
        const abort=vi.spyOn(Object.getPrototypeOf(transaction),'abort').mockImplementation(()=>{intercepted=true;throw Error('transaction abort failed');});
        try {controller.abort();} finally {abort.mockRestore();}
      };
    };
    x.db.materials.hook('creating',cancel);
    try{await expect(x.stage.commit(cap,{signal:controller.signal})).rejects.toThrow('cancelled');}
    finally{x.db.materials.hook('creating').unsubscribe(cancel);}
    await vi.waitFor(async()=>expect(await x.stage.status(cap)).toEqual({state:'sealed',nextSeq:total}));
    expect(intercepted).toBe(true);expect(await x.db.materials.count()).toBe(0);
    expect(await x.db.table('stageFrames').count()).toBe(total);expect(await x.db.table('stageReceipts').count()).toBe(0);
    expect(await x.stage.commit(cap)).toEqual({inserted:1,updated:0,skipped:0});
  });
  it('does not apply a record if cancellation wins while reading its last frame',async()=>{
    const x=make(),controller=new AbortController(),{cap,total}=await uploadMaterial(x);
    const frames=x.db.table('stageFrames');let reads=0,intercepted=false;
    const onRead=(row:Frame|undefined)=>{
      if(row&&++reads===total+1) {
        const transaction=Dexie.currentTransaction;
        if(!transaction)throw Error('missing transaction');
        const abort=vi.spyOn(Object.getPrototypeOf(transaction),'abort').mockImplementation(()=>{intercepted=true;throw Error('transaction abort failed');});
        try {controller.abort();} finally {abort.mockRestore();}
      }
      return row;
    };
    frames.hook('reading',onRead);
    try {await expect(x.stage.commit(cap,{signal:controller.signal})).rejects.toThrow('cancelled');}
    finally {frames.hook('reading').unsubscribe(onRead);}
    await vi.waitFor(async()=>expect(await x.stage.status(cap)).toEqual({state:'sealed',nextSeq:total}));
    expect(intercepted).toBe(true);expect(await x.db.materials.count()).toBe(0);
    expect(await frames.count()).toBe(total);expect(await x.db.table('stageReceipts').count()).toBe(0);
    expect(await x.stage.commit(cap)).toEqual({inserted:1,updated:0,skipped:0});
  });
  it('treats a cancelled cleanup as uncertain when transaction abort fails',async()=>{
    const x=make(),controller=new AbortController(),cap=await x.begin();await x.stage.append(cap,x.frame);
    const sessions=x.db.table('stageSessions');await sessions.update(cap.id,{expiresAt:0});
    let intercepted=false;
    const onRead=(row:{id:string}|undefined)=>{
      if(row?.id===cap.id&&!intercepted){
        const transaction=Dexie.currentTransaction;if(!transaction)throw Error('missing transaction');
        const abort=vi.spyOn(Object.getPrototypeOf(transaction),'abort').mockImplementation(()=>{intercepted=true;throw Error('transaction abort failed');});
        try{controller.abort();}finally{abort.mockRestore();}
      }
      return row;
    };
    sessions.hook('reading',onRead);
    try{await expect(x.stage.cleanup({signal:controller.signal})).rejects.toThrow('cancelled');}
    finally{sessions.hook('reading').unsubscribe(onRead);}
    expect(intercepted).toBe(true);
    await vi.waitFor(async()=>expect(await sessions.count()).toBe(0));
    expect(await x.db.table('stageFrames').count()).toBe(0);
    expect(await x.db.table('stageBudget').get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:0});
  });
  it('isolates rejection from a callable cleanup diagnostic thenable after the transaction commits',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const callback=vi.fn(()=>Object.assign(()=>{}, {then:(_resolve:unknown,reject:(error:Error)=>void)=>reject(Error('observer failed'))}));
    const x=make({onCleanupCorruption:callback});const cap=await x.begin();await x.stage.append(cap,x.frame);
    await x.db.table('stageSessions').update(cap.id,{expiresAt:NaN});
    expect(await x.stage.cleanup()).toEqual({sessions:1,receipts:0,corruptSessions:1});
    await vi.waitFor(()=>expect(warn).toHaveBeenCalledOnce());
    expect(await x.db.table('stageFrames').count()).toBe(0);
  });
});
