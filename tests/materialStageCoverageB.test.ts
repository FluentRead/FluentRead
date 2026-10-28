import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase} from '@/src/features/vocabulary/materialRepository';
import {createStage, type Frame} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';

const names:string[]=[];
const connections:MaterialDatabase[]=[];
afterEach(async()=>{for(const db of connections.splice(0))db.close();for(const name of names.splice(0))await Dexie.delete(name);vi.restoreAllMocks();});
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

describe('material staging transaction boundaries',()=>{
  it('rejects an append when a completed transfer is sealed during its transport delay',async()=>{
    const ready=deferred(),gate=deferred();let blocked=false;
    const x=make({beforeAppend:async()=>{if(blocked){ready.resolve();await gate.promise;}}});
    const cap=await x.begin();await x.stage.append(cap,x.frame);blocked=true;
    const pending=x.stage.append(cap,x.frame);await ready.promise;
    await x.stage.seal(cap);gate.resolve();
    await expect(pending).rejects.toThrow('session sealed');
    expect(await x.db.table('stageFrames').count()).toBe(1);
    expect(await x.stage.status(cap)).toEqual({state:'sealed',nextSeq:1});
  });
  it('rejects a second commit while another admitted operation holds the only inflight slot',async()=>{
    const ready=deferred(),gate=deferred();let blocked=false;
    const x=make({limits:{...limits,inflight:1},beforeAppend:async()=>{if(blocked){ready.resolve();await gate.promise;}}});
    const first=await x.begin(),second=await x.begin();await x.stage.append(second,x.frame);await x.stage.seal(second);
    blocked=true;const pending=x.stage.append(first,x.frame);await ready.promise;
    await expect(x.stage.commit(second)).rejects.toThrow('backpressure: receiver busy');
    gate.resolve();await pending;
    expect(await x.stage.status(second)).toEqual({state:'sealed',nextSeq:1});
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
