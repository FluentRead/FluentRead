import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialImportStageDatabase, createStage as createProductStage, type Capability, type Frame, type Manifest} from '@/src/features/vocabulary/materialImportStage';

let serial=0;
const names=new Set<string>(), open:MaterialDatabase[]=[];
const opts={frameBytes:128,recordBytes:1024*1024,totalBytes:2*1024*1024,frameCount:10000,totalFrames:10000,slots:256,inflight:8,ttlMs:1000,receiptTtlMs:10000};
function createStage(db:MaterialImportStageDatabase, options:Parameters<typeof createProductStage>[1]={}) {
  return {...createProductStage(db,options), frames:db.table<any,[string,number]>('stageFrames'), sessions:db.table<any,string>('stageSessions'), receipts:db.table<any,string>('stageReceipts'), budgets:db.table<any,string>('stageBudget'), limits:{...opts,...options.limits}};
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

function database(name=`material-stage-test-${++serial}`){names.add(name);const db=new MaterialImportStageDatabase(name);open.push(db);return db;}
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
  it('does not notify a rolled-back transaction and isolates observer failures from successful commits',async()=>{
    const target=instance(),successful=vi.fn(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const stopBad=target.stage.observeCommitted(()=>{throw Error('private observer details');});
    const stopGood=target.stage.observeCommitted(successful);
    try {
      const first=await upload(target.stage,[await material('rollback-notify')]);await target.stage.seal(first.token);
      await expect(target.stage.commit(first.token,{onApplied:()=>{throw Error('injected rollback');}})).rejects.toThrow('injected rollback');
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

describe('isolated same-database material staging',()=>{
  it('rejects record limits that do not fit the 32-bit digest length prefix',()=>{
    const target=instance(),max=0xffffffff;
    // The protocol's 4-byte prefix cannot distinguish these two lengths.
    expect(lengthBytes(1)).toEqual(lengthBytes(max+2));
    expect(()=>createProductStage(target.db,{limits:{recordBytes:max}})).not.toThrow();
    expect(()=>createProductStage(target.db,{limits:{recordBytes:max+1}})).toThrow('invalid limits');
  });
  it('rejects impossible manifests before either begin method reserves shared budget',async()=>{
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
      await expect(target.stage.begin(manifest,guard)).rejects.toThrow('invalid manifest');
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
    await expect(target.stage.begin(impossible,guard)).rejects.toThrow('invalid manifest');
    await expect(target.stage.beginRecoverable(impossible,guard,cap,{deadline:1000})).rejects.toThrow('invalid manifest');
    const feasible={...impossible,bytes:9};
    const session=await target.stage.begin(feasible,guard);await target.stage.discard(session);
    expect(await target.stage.beginRecoverable(feasible,guard,cap,{deadline:1000})).toEqual(cap);
    await target.stage.discard(cap);
  });
  it('checks large manifest capacities without overflowing intermediate products',async()=>{
    const max=Number.MAX_SAFE_INTEGER,recordMax=0xffffffff,guard={generation:0,capturedAt:100};
    const target=instance({now:100},{limits:{...opts,frameBytes:max,recordBytes:recordMax,totalBytes:max}});
    const cap={id:crypto.randomUUID(),token:bytesToHex(crypto.getRandomValues(new Uint8Array(32)))};
    const impossible={records:2,frames:2,bytes:recordMax*2+1,digest:'0'.repeat(64)};
    await expect(target.stage.begin(impossible,guard)).rejects.toThrow('invalid manifest');
    await expect(target.stage.beginRecoverable(impossible,guard,cap,{deadline:1000})).rejects.toThrow('invalid manifest');
    const feasible={...impossible,bytes:recordMax*2};
    const session=await target.stage.begin(feasible,guard);await target.stage.discard(session);
    expect(await target.stage.beginRecoverable(feasible,guard,cap,{deadline:1000})).toEqual(cap);
    await target.stage.discard(cap);
  });
  it('admits empty backups and possible arbitrary subdivisions at capacity boundaries',async()=>{
    const target=instance({now:100},{limits:{...opts,recordBytes:256,totalBytes:4096}}),guard={generation:0,capturedAt:100};
    const cases=[{records:0,frames:0,bytes:0},{records:1,frames:2,bytes:256},{records:2,frames:3,bytes:3}];
    for(const input of cases){
      const manifest={...input,digest:'0'.repeat(64)};
      const legacy=await target.stage.begin(manifest,guard);await target.stage.discard(legacy);
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
    const legacy=await target.stage.begin(empty,guard);await expect(target.stage.beginRecoverable(empty,guard,legacy,{deadline:1000})).rejects.toThrow('session unavailable');
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
    const name=`material-stage-test-${++serial}`;names.add(name);const old=new MaterialDatabase(name);open.push(old);const repo=new MaterialRepository(old);
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
  it('releases only acknowledged receipts so completed imports no longer exhaust slots',async()=>{
    const target=instance({now:100},{limits:{...opts,slots:2}}),empty=frameRecords([],opts.frameBytes).manifest,guard={generation:0,capturedAt:100};
    const a=await target.stage.begin(empty,guard),b=await target.stage.begin(empty,guard);
    await target.stage.seal(a);await target.stage.seal(b);
    const result=await target.stage.commit(a);await target.stage.commit(b);
    await expect(target.stage.begin(empty,guard)).rejects.toThrow('stage budget exceeded');
    expect(await target.stage.status(a)).toEqual({state:'committed',result});
    expect(await target.stage.acknowledge(a)).toBe('released-or-unavailable');
    expect(await target.stage.status(b)).toEqual({state:'committed',result});
    expect((await target.stage.budgets.get('stage'))?.slots).toBe(1);
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
  it('rolls back a mid-commit failure and cancellation, then allows retry of the sealed transfer',async()=>{
    const target=instance(),{token}=await upload(target.stage,[await material('alpha'),await material('bravo')]);await target.stage.seal(token);
    await expect(target.stage.commit(token,{onApplied:i=>{if(i===0)throw Error('injected failure');}})).rejects.toThrow('injected failure');
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
    const controller=new AbortController();
    await expect(target.stage.commit(token,{signal:controller.signal,onApplied:i=>{if(i===0)controller.abort();}})).rejects.toThrow();
    expect(await target.db.materials.count()).toBe(0);expect(await target.stage.receipts.count()).toBe(0);
    expect(await target.stage.commit(token)).toEqual({inserted:2,updated:0,skipped:0});
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
    await expect(target.stage.commit(token)).rejects.toThrow('导入期间材料已清空');
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
  it('settles a pending append when its underlying producer never resolves and the session is discarded',async()=>{
    const target=instance({now:100},{beforeAppend:()=>new Promise<void>(()=>{})}),input=frameRecords([await material('alpha')],opts.frameBytes);
    const token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(token,input.frames[0]);
    expect(await target.stage.discard(token)).toBe('discarded');
    const outcome=await Promise.race([pending.then(()=> 'accepted',error=>error.message),new Promise<string>(resolve=>setTimeout(()=>resolve('blocked'),50))]);
    expect(outcome).toBe('cancelled');
    expect(await target.stage.frames.count()).toBe(0);expect((await target.stage.budgets.get('stage'))?.reserved).toBe(0);
  });
  it('checks ownership before a blocking producer and aborts it when another connection discards the session',async()=>{
    const ready=deferred();let calls=0;
    const target=instance({now:100},{beforeAppend:()=>{calls++;ready.resolve();return new Promise<void>(()=>{});}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const wrong={...token,token:'0'.repeat(64)};
    await expect(target.stage.append(wrong,input.frames[0])).rejects.toThrow('session unavailable');expect(calls).toBe(0);
    const pending=target.stage.append(token,input.frames[0]);const outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;
    const secondDb=database(target.db.name),second=createStage(secondDb,{limits:opts,clock:()=>100});await secondDb.open();
    await expect(second.append(wrong,input.frames[0])).rejects.toThrow('session unavailable');
    await expect(second.discard(wrong)).rejects.toThrow('session unavailable');
    expect(await second.discard(token)).toBe('discarded');
    expect(await outcome).toBe('cancelled');expect(await target.stage.frames.count()).toBe(0);
  });
  it('settles a non-cooperative append on caller abort and permits a later authorized retry',async()=>{
    const ready=deferred(),target=instance({now:100},{beforeAppend:()=>{ready.resolve();return new Promise<void>(()=>{});}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const controller=new AbortController(),pending=target.stage.append(token,input.frames[0],{signal:controller.signal});
    const outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;controller.abort();
    expect(await outcome).toBe('cancelled');expect(await target.stage.status(token)).toEqual({state:'open',nextSeq:0});
    const db2=database(target.db.name),second=createStage(db2,{limits:opts,clock:()=>100});await db2.open();
    expect(await second.append(token,input.frames[0])).toEqual({nextSeq:1});
  });
  it('aborts a pending non-cooperative append when another connection cleans up its expired session',async()=>{
    const ready=deferred(),clock={now:100},target=instance(clock,{beforeAppend:()=>{ready.resolve();return new Promise<void>(()=>{});}});
    const input=frameRecords([await material('alpha')],opts.frameBytes),token=await target.stage.begin(input.manifest,{generation:0,capturedAt:100});
    const pending=target.stage.append(token,input.frames[0]),outcome=pending.then(()=> 'accepted',error=>error.message);await ready.promise;
    const db2=database(target.db.name),second=createStage(db2,{limits:opts,clock:()=>clock.now});await db2.open();clock.now+=opts.ttlMs;
    expect(await second.cleanup()).toEqual({sessions:1,receipts:0});expect(await outcome).toBe('cancelled');
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
    await expect(other.stage.commit(second.token)).rejects.toThrow('导入期间材料已清空');
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
    await stage.discard(b);const c=await stage.begin(empty,guard);
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
    const result=await target.stage.commit(token,{onApplied:i=>{if(i===0)setTimeout(()=>{
      beganDuringCommit=!commitDone;clearPromise=otherRepo.clear(101);discardPromise=otherStage.discard(token);started.resolve();
    },0);}});
    commitDone=true;await started.promise;expect(beganDuringCommit).toBe(true);await clearPromise;
    expect(await discardPromise).toBe('committed');
    expect(result.inserted).toBe(80);expect(await target.db.materials.count()).toBe(0);
    expect(await target.stage.status(token)).toEqual({state:'committed',result});
    expect(await target.stage.commit(token)).toEqual(result);expect(await target.db.materials.count()).toBe(0);
  },20000);
  it('preserves existing material data across a simulated v1-to-v2 Dexie schema upgrade',async()=>{
    const name=`material-stage-test-${++serial}`;names.add(name);const old=new MaterialDatabase(name);open.push(old);const repo=new MaterialRepository(old);
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
    await repo.clear(101);
    await expect(stage.commit(second.token)).rejects.toThrow('导入期间材料已清空');
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
  it('starts a new session TTL when its blocked creation actually reaches storage',async()=>{
    const clock={now:100},target=instance(clock),manifest=frameRecords([],opts.frameBytes).manifest,other=database(target.db.name);await other.open();
    const hold=deferred(),ready=deferred();
    const locking=other.transaction('rw',other.meta,async()=>{ready.resolve();await Dexie.waitFor(hold.promise);});await ready.promise;
    const pending=Dexie.ignoreTransaction(()=>target.stage.begin(manifest,{generation:0,capturedAt:100}));
    clock.now+=opts.ttlMs+1;hold.resolve();await locking;
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
  it('removes a committed but undelivered begin after cancellation wins the acknowledgement race',async()=>{
    const target=instance(), manifest=frameRecords([],opts.frameBytes).manifest, controller=new AbortController();
    const original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(value=>{controller.abort();return value;})) as never);
    await expect(target.stage.begin(manifest,{generation:0,capturedAt:100},{signal:controller.signal})).rejects.toThrow('cancelled');
    await vi.waitFor(async()=>expect(await target.stage.sessions.count()).toBe(0));
    expect(await target.stage.budgets.get('stage')).toMatchObject({reserved:0,reservedFrames:0,slots:0});
  });
  it('reports failed abandoned-session cleanup and allows later TTL recovery',async()=>{
    const clock={now:100},target=instance(clock), manifest=frameRecords([],opts.frameBytes).manifest, controller=new AbortController();
    const fail=()=>{throw new DOMException('simulated quota','QuotaExceededError');};
    target.stage.sessions.hook('deleting',fail);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const original=target.db.transaction.bind(target.db) as (...args:any[])=>Promise<unknown>;
    vi.spyOn(target.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(value=>{controller.abort();return value;})) as never);
    try{
      await expect(target.stage.begin(manifest,{generation:0,capturedAt:100},{signal:controller.signal})).rejects.toThrow('cancelled');
      await vi.waitFor(()=>expect(warn).toHaveBeenCalledWith('[FluentRead] Abandoned material import cleanup failed; the session requires expiry cleanup.'));
      expect(await target.stage.sessions.count()).toBe(1);
      target.stage.sessions.hook('deleting').unsubscribe(fail);clock.now+=opts.ttlMs;
      expect(await target.stage.cleanup()).toEqual({sessions:1,receipts:0});
      expect(await target.stage.sessions.count()).toBe(0);
    }finally{target.stage.sessions.hook('deleting').unsubscribe(fail);warn.mockRestore();}
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
