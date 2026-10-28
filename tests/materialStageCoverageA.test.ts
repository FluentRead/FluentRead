import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';

const databases:MaterialDatabase[]=[];
const clock={now:100};
const manifest={records:0,frames:0,bytes:0,digest:bytesToHex(sha256(new Uint8Array()))};
const guard={generation:0,capturedAt:100};
function setup(){
  const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);
  const stage=createStage(db,{clock:()=>clock.now,limits:{ttlMs:1000,receiptTtlMs:10000}});
  return {db,stage,begin:(cap=createMaterialImportCapability())=>stage.beginRecoverable(manifest,guard,cap,{deadline:1000})};
}
afterEach(async()=>{vi.restoreAllMocks();const opened=databases.splice(0),names=new Set(opened.map(db=>db.name));for(const db of opened)db.close();for(const name of names)await Dexie.delete(name);clock.now=100;});

describe('material staging stored metadata boundaries',()=>{
  it('rejects a missing capability before touching storage',async()=>{
    const {db,stage}=setup();
    await expect(stage.resume(null as never)).rejects.toThrow('session unavailable');
    expect(db.isOpen()).toBe(false);
  });
  it('rejects corrupt expiry in any existing session before reserving a second session',async()=>{
    const {db,begin}=setup();const first=await begin();
    await db.table('stageSessions').update(first.id,{expiresAt:NaN});
    expect(await db.table('stageSessions').get(first.id)).toMatchObject({expiresAt:NaN});
    await expect(begin()).rejects.toThrow('invalid expiry');
    expect(await db.table('stageSessions').count()).toBe(1);
    expect(await db.table('stageBudget').get('stage')).toMatchObject({slots:1});
  });
  it('stops reading session metadata after the first corrupted record',async()=>{
    const {db,begin}=setup(), ids=(await Promise.all([begin(),begin(),begin()])).map(cap=>cap.id).sort();
    await db.table('stageSessions').update(ids[1],{expiresAt:NaN});
    const read:string[]=[];
    const track=(row:{id:string}|undefined)=>{if(row)read.push(row.id);return row;};
    db.table('stageSessions').hook('reading',track);
    try {await expect(begin()).rejects.toThrow('invalid expiry');}
    finally {db.table('stageSessions').hook('reading').unsubscribe(track);}
    // Dexie 的 until 不向 each 交付触发停止的那条记录。
    expect(read).toEqual(ids.slice(0,1));
    expect(await db.table('stageSessions').count()).toBe(3);
    expect(await db.table('stageBudget').get('stage')).toMatchObject({slots:3});
  });
  it.each([
    {bytes:NaN,frames:0}, {bytes:0,frames:NaN}, {bytes:-1,frames:0}, {bytes:0,frames:-1},
  ])('rejects corrupt session reservation fields without changing the budget: %j',async fields=>{
    const {db,begin}=setup();const first=await begin();
    await db.table('stageSessions').update(first.id,fields);
    await expect(begin()).rejects.toThrow('budget corruption');
    expect(await db.table('stageSessions').count()).toBe(1);
    expect(await db.table('stageBudget').get('stage')).toMatchObject({slots:1,reserved:0,reservedFrames:0});
  });
  it.each(['bytes','frames'] as const)('rejects overflow in the summed %s reservations',async field=>{
    const {db,begin}=setup();const first=await begin(),second=await begin();
    await db.table('stageSessions').update(first.id,{[field]:Number.MAX_SAFE_INTEGER});
    await db.table('stageSessions').update(second.id,{[field]:1});
    await db.table('stageBudget').update('stage',{[field==='bytes'?'reserved':'reservedFrames']:Number.MAX_SAFE_INTEGER});
    await expect(begin()).rejects.toThrow('budget corruption');
    expect(await db.table('stageSessions').count()).toBe(2);
    expect((await db.table('stageBudget').get('stage')).slots).toBe(2);
  });
  it('refuses to use a persisted session id when the replay record disappears',async()=>{
    const {db,begin}=setup();const first=await begin();
    await db.table('stageStarts').delete(first.id);
    await expect(begin(first)).rejects.toThrow('session unavailable');
    expect(await db.table('stageSessions').count()).toBe(1);
  });
  it('does not reattach to a receipt with corrupt expiry even with the original token',async()=>{
    const {db,stage,begin}=setup();const cap=await begin();
    await stage.seal(cap);await stage.commit(cap);
    await db.table('stageReceipts').update(cap.id,{expiresAt:NaN});
    await expect(stage.resume(cap)).rejects.toThrow('invalid expiry');
    await expect(begin(cap)).rejects.toThrow('invalid expiry');
    expect(await db.table('stageReceipts').count()).toBe(1);
  });
  it.each(['', 'a'.repeat(65), '\0'.repeat(64)])('rejects corrupt stored owner hash: %j',async ownerHash=>{
    const {db,stage,begin}=setup();const cap=await begin();
    await db.table('stageSessions').update(cap.id,{ownerHash});
    await expect(stage.resume(cap)).rejects.toThrow('session unavailable');
    expect(await db.table('stageSessions').count()).toBe(1);
  });
  it('evicts a stale admission hint after material data is cleared',async()=>{
    const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);
    const stage=createStage(db,{clock:()=>clock.now,limits:{ttlMs:1000,slots:1}}),repo=new MaterialRepository(db);
    const first=createMaterialImportCapability();await stage.beginRecoverable(manifest,guard,first,{deadline:150});
    await repo.clear(101);clock.now=151;await stage.cleanup();
    const second=createMaterialImportCapability();await stage.beginRecoverable(manifest,{generation:1,capturedAt:151},second,{deadline:1000});
    await expect(stage.status(second)).resolves.toEqual({state:'open',nextSeq:0});
    await expect(stage.status(first)).rejects.toThrow('session unavailable');
    expect(await db.table('stageSessions').count()).toBe(1);
  });
  it('rejects replay if the start and session are removed between the read and write transactions',async()=>{
    const {db,stage,begin}=setup(),cap=await begin();
    const transaction=db.transaction.bind(db) as (...args:any[])=>Promise<unknown>;
    const spy=vi.spyOn(db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(transaction(...args)).then(async value=>{
      await transaction('rw',[db.table('stageStarts'),db.table('stageSessions'),db.table('stageBudget')],async()=>{
        await db.table('stageStarts').delete(cap.id);await db.table('stageSessions').delete(cap.id);
        await db.table('stageBudget').put({key:'stage',reserved:0,reservedFrames:0,slots:0});
      });
      return value;
    })) as never);
    try{await expect(stage.beginRecoverable(manifest,guard,cap,{deadline:1000})).rejects.toThrow('session unavailable');}
    finally{spy.mockRestore();}
    expect(await db.table('stageStarts').count()).toBe(0);
    expect(await db.table('stageSessions').count()).toBe(0);
    expect(await db.table('stageBudget').get('stage')).toMatchObject({slots:0});
  });
  it.each([3,4])('rolls back when a new start deadline expires at clock check %i',async expirationCheck=>{
    const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);let calls=0;
    const stage=createStage(db,{clock:()=>++calls>=expirationCheck?1000:100,limits:{ttlMs:1000}});
    await expect(stage.beginRecoverable(manifest,guard,createMaterialImportCapability(),{deadline:1000})).rejects.toThrow('session unavailable');
    expect(await db.table('stageStarts').count()).toBe(0);expect(await db.table('stageSessions').count()).toBe(0);
    expect(await db.table('stageBudget').count()).toBe(0);
  });
  it('rejects an existing start if its deadline expires while re-reading its session',async()=>{
    const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);let calls=0,armed=false;
    const stage=createStage(db,{clock:()=>armed&&++calls>=4?1000:100,limits:{ttlMs:1000}}),cap=createMaterialImportCapability();
    await stage.beginRecoverable(manifest,guard,cap,{deadline:1000});armed=true;
    await expect(stage.beginRecoverable(manifest,guard,cap,{deadline:1000})).rejects.toThrow('session unavailable');
    expect(await db.table('stageStarts').count()).toBe(1);expect(await db.table('stageSessions').count()).toBe(1);
  });
  it('does not write a frame when the transport hook synchronously aborts, and permits retry',async()=>{
    const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);
    const controller=new AbortController();let first=true;
    const stage=createStage(db,{clock:()=>clock.now,limits:{ttlMs:1000},beforeAppend:async()=>{if(first){first=false;controller.abort();}}});
    const bytes=new TextEncoder().encode('{}'),hash=sha256.create();hash.update(new Uint8Array([0,0,0,bytes.length]));hash.update(bytes);
    const input={records:1,frames:1,bytes:bytes.length,digest:bytesToHex(hash.digest())};
    const frame={seq:0,record:0,part:0,total:1,recordBytes:bytes.length,bytes},cap=createMaterialImportCapability();
    await stage.beginRecoverable(input,guard,cap,{deadline:1000});
    await expect(stage.append(cap,frame,{signal:controller.signal})).rejects.toThrow('cancelled');
    expect(await db.table('stageFrames').count()).toBe(0);
    expect(await stage.status(cap)).toEqual({state:'open',nextSeq:0});
    await expect(stage.append(cap,frame)).resolves.toEqual({nextSeq:1});
    expect(await db.table('stageFrames').count()).toBe(1);
  });
  it('cancels a seal queued behind a database lock without sealing the session',async()=>{
    const {db,stage,begin}=setup(),cap=await begin(),peer=new MaterialDatabase(db.name);databases.push(peer);await peer.open();
    let release!:()=>void,entered!:()=>void;
    const hold=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);
    const lock=peer.transaction('rw',peer.table('stageSessions'),async()=>{entered();await Dexie.waitFor(hold);});
    await ready;const controller=new AbortController(),transaction=vi.spyOn(db,'transaction');
    try {
      const pending=Dexie.ignoreTransaction(()=>stage.seal(cap,{signal:controller.signal}));
      const rejected=expect(pending).rejects.toThrow('cancelled');
      await vi.waitFor(()=>expect(transaction).toHaveBeenCalledOnce());
      controller.abort();await rejected;
    } finally {release();await lock;transaction.mockRestore();}
    await vi.waitFor(async()=>expect(await stage.status(cap)).toEqual({state:'open',nextSeq:0}));
    await vi.waitFor(async()=>expect(await stage.seal(cap)).toBeUndefined());
    expect(await stage.status(cap)).toEqual({state:'sealed',nextSeq:0});
  });
  it('releases the seal admission when starting its database transaction throws synchronously',async()=>{
    const {db,stage,begin}=setup(),cap=await begin();
    const transaction=vi.spyOn(db,'transaction').mockImplementationOnce(()=>{throw Error('database unavailable');});
    try {await expect(stage.seal(cap)).rejects.toThrow('database unavailable');}
    finally {transaction.mockRestore();}
    expect(await stage.status(cap)).toEqual({state:'open',nextSeq:0});
    await stage.seal(cap);
    expect(await stage.status(cap)).toEqual({state:'sealed',nextSeq:0});
  });
  it('rolls back a cancelled empty import after material processing and before creating a receipt',async()=>{
    const {db,stage,begin}=setup(),cap=await begin(),controller=new AbortController();
    await stage.seal(cap);
    const original=MaterialRepository.prototype.importRecords;
    const spy=vi.spyOn(MaterialRepository.prototype,'importRecords').mockImplementationOnce(function(this:MaterialRepository,...args:Parameters<MaterialRepository['importRecords']>){
      return original.apply(this,args).then(result=>{controller.abort();return result;});
    });
    try {await expect(stage.commit(cap,{signal:controller.signal})).rejects.toThrow();}
    finally {spy.mockRestore();}
    expect(await db.table('stageReceipts').count()).toBe(0);
    expect(await stage.status(cap)).toEqual({state:'sealed',nextSeq:0});
    await expect(stage.commit(cap)).resolves.toEqual({inserted:0,updated:0,skipped:0});
  });
  it('rejects a replacement owner while an existing transfer holds the session',async()=>{
    const db=new MaterialDatabase(`material-stage-a-${crypto.randomUUID()}`);databases.push(db);
    let release!:()=>void,started!:()=>void;
    const held=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);
    const stage=createStage(db,{clock:()=>clock.now,limits:{ttlMs:1000},beforeAppend:async()=>{started();await held;}});
    const bytes=new TextEncoder().encode('{}'),hash=sha256.create();hash.update(new Uint8Array([0,0,0,bytes.length]));hash.update(bytes);
    const input={records:1,frames:1,bytes:bytes.length,digest:bytesToHex(hash.digest())};
    const frame={seq:0,record:0,part:0,total:1,recordBytes:bytes.length,bytes},owner=createMaterialImportCapability();
    await stage.beginRecoverable(input,guard,owner,{deadline:1000});
    const pending=stage.append(owner,frame);await ready;
    const replacement={...createMaterialImportCapability(),id:owner.id};
    const tokenHash=(token:string)=>bytesToHex(sha256(new TextEncoder().encode(token)));
    try {
      await db.table('stageSessions').update(owner.id,{ownerHash:tokenHash(replacement.token)});
      await stage.resume(replacement);
      await expect(stage.append(replacement,frame)).rejects.toThrow('session unavailable');
      await expect(stage.commit(replacement)).rejects.toThrow('session unavailable');
      expect(await db.table('stageFrames').count()).toBe(0);
    } finally {
      await db.table('stageSessions').update(owner.id,{ownerHash:tokenHash(owner.token)});
      release();
    }
    await expect(pending).resolves.toEqual({nextSeq:1});
    expect(await db.table('stageFrames').count()).toBe(1);
  });
  it('isolates a callable rejected observer thenable from a successful material commit',async()=>{
    const {stage,begin}=setup(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),cap=await begin();
    const stop=stage.observeCommitted(()=>Object.assign(()=>{}, {then:(_resolve:unknown,reject:(error:Error)=>void)=>reject(Error('private observer error'))}));
    await stage.seal(cap);
    try {
      await expect(stage.commit(cap)).resolves.toEqual({inserted:0,updated:0,skipped:0});
      await vi.waitFor(()=>expect(warn).toHaveBeenCalledOnce());
      expect(warn).toHaveBeenCalledWith('[FluentRead] 学习材料变更通知失败');
    } finally {stop();}
  });
});
