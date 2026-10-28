/**
 * @file src/features/vocabulary/materialImportStage.ts
 * 文件职责：在材料数据库中暂存分片，并与材料和结果回执原子提交。
 * 主要内容：按能力校验会话，限制帧、并发和存储预算，支持幂等重试、取消、恢复、过期清理和真实提交后的无正文通知。
 * 模块边界：只处理已拆分并验证的记录帧；不读取备份文件、不校验消息发送者，也不保证旧 JSON 格式已被完整解析。
 */
import Dexie from 'dexie';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import type {MaterialImportResult, MaterialOperationGuard} from '@/src/features/vocabulary/materialProtocol';
import {MATERIAL_IMPORT_FRAME_BYTES, MATERIAL_IMPORT_MAX_RECORD_BYTES, MATERIAL_IMPORT_MAX_TOTAL_BYTES, MATERIAL_IMPORT_MAX_FRAMES} from '@/src/features/vocabulary/materialProtocol';
import {materialImportCapacity} from '@/src/features/vocabulary/materialImportCapacity';

export interface Manifest {records:number; frames:number; bytes:number; digest:string}
export interface Frame {seq:number; record:number; part:number; total:number; recordBytes:number; bytes:Uint8Array}
export interface Capability {id:string; token:string}
type Phase = 'open' | 'sealed';
interface Session extends Manifest {id:string; ownerHash:string; phase:Phase; guard:MaterialOperationGuard; nextSeq:number; nextRecord:number; nextPart:number; currentTotal:number; currentBytes:number; receivedBytes:number; expiresAt:number}
interface StoredFrame extends Frame {session:string}
interface Receipt {id:string; ownerHash:string; result:MaterialImportResult; expiresAt:number}
interface RecoverableStart extends Manifest {id:string; ownerHash:string; guard:MaterialOperationGuard; expiresAt:number}
interface Budget {key:string; reserved:number; reservedFrames:number; slots:number}
export interface Limits {frameBytes:number; recordBytes:number; totalBytes:number; frameCount:number; totalFrames:number; slots:number; inflight:number; ttlMs:number; receiptTtlMs:number}
const DEFAULTS:Limits={frameBytes:MATERIAL_IMPORT_FRAME_BYTES, recordBytes:MATERIAL_IMPORT_MAX_RECORD_BYTES, totalBytes:MATERIAL_IMPORT_MAX_FRAMES*MATERIAL_IMPORT_FRAME_BYTES, frameCount:MATERIAL_IMPORT_MAX_FRAMES, totalFrames:200000, slots:256, inflight:8, ttlMs:30*60*1000, receiptTtlMs:7*24*60*60*1000};
const capacityError=()=>Object.assign(new Error('stage budget exceeded'),{name:'MaterialBackupCapacityError'});
// All existing production databases have at most this many sessions and receipts.
// Keeping the bound independent of a lower current limit still permits recovery.
const MAX_TRACKED_SLOTS=256;
const encoder=new TextEncoder();
// Read the actual typed-array size even if a direct caller shadows its public properties.
const typedArrayByteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
const lengthBytes=(n:number)=>new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
const hashToken=(token:string)=>bytesToHex(sha256(encoder.encode(token)));
const validInteger=(n:number)=>Number.isSafeInteger(n)&&n>=0;
// Maximize payload over the available frames and per-record capacity without
// rounding or overflow, including a partial final frame for each record.
const withinCapacity=(bytes:number,count:number,records:number,frameBytes:number,recordBytes:number)=>{
  const frames=BigInt(count),items=BigInt(records),frame=BigInt(frameBytes),record=BigInt(recordBytes);
  const fullCapacity=items*(record/frame),full=frames<fullCapacity?frames:fullCapacity;
  const remaining=frames-full,partial=remaining<items?remaining:items;
  return BigInt(bytes)<=full*frame+partial*(record%frame);
};
const equalBytes=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const secureEqual=(a:string,b:string)=>{let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;};
const requireCapability=(input:Capability):Capability=>{
  if(!input)throw Error('session unavailable');
  const id=input.id;
  if(typeof id!=='string'||id.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))throw Error('session unavailable');
  const token=input.token;
  if(typeof token!=='string'||token.length!==64||!/^[0-9a-f]{64}$/u.test(token))throw Error('session unavailable');
  return {id,token};
};
const owner=(row:{ownerHash:string}|undefined, cap:Capability)=>!!row&&secureEqual(row.ownerHash,hashToken(cap.token));
const framesRange=(id:string)=>[[id,Dexie.minKey],[id,Dexie.maxKey]] as [[string, typeof Dexie.minKey],[string, typeof Dexie.maxKey]];
// Shared by stage instances in this one JavaScript runtime. A production
// background receiver must additionally bind its port lifetime to a signal.
type ActiveAppend={ownerHash:string;controller:AbortController};
const activeByDatabase=new Map<string,Map<string,ActiveAppend>>();
// Resume reads are separate from payload slots and reject immediately when full.
const resumesByDatabase=new Map<string,number>();
const admissionsByDatabase=new Map<string,Map<string,{ownerHash:string;expiresAt:number}>>();
type ControlLane={count:number;ids:Set<string>};
const controlsByDatabase=new Map<string,Map<string,ControlLane>>();
// A receiver normally owns one stage; sharing by database also covers another
// stage instance in this runtime. Worker restarts cannot replay notifications.
const commitObserversByDatabase=new Map<string,Set<{listener:()=>void}>>();
function observeDatabaseCommit(name:string,listener:()=>void):()=>void {
  if(typeof listener!=='function')throw new TypeError('commit observer must be a function');
  let observers=commitObserversByDatabase.get(name);
  if(!observers){observers=new Set();commitObserversByDatabase.set(name,observers);}
  const entry={listener};observers.add(entry);
  return ()=>{
    observers!.delete(entry);
    if(observers!.size===0&&commitObserversByDatabase.get(name)===observers)commitObserversByDatabase.delete(name);
  };
}
function notifyDatabaseCommit(name:string):void {
  const observers=commitObserversByDatabase.get(name);if(!observers)return;
  const failed=()=>{try{console.warn('[FluentRead] 学习材料变更通知失败');}catch{/* Diagnostics must not change a committed result. */}};
  for(const entry of [...observers]){
    if(!observers.has(entry))continue;
    try {
      // Avoid unhandled rejections from accidentally async observers; do not
      // include observer errors, which may contain private material content.
      const outcome:unknown=entry.listener();
      if(outcome&&(typeof outcome==='object'||typeof outcome==='function'))void Promise.resolve(outcome).catch(failed);
    } catch {failed();}
  }
}
function takeControl(name:string,kind:string,id:string|undefined,limit:number):()=>void {
  let lanes=controlsByDatabase.get(name);if(!lanes){lanes=new Map();controlsByDatabase.set(name,lanes);}
  let lane=lanes.get(kind);if(!lane){lane={count:0,ids:new Set()};lanes.set(kind,lane);}
  if(id&&lane.ids.has(id))throw Error('backpressure: control operation pending');
  if(lane.count>=limit)throw Error('backpressure: control receiver busy');
  lane.count++;if(id)lane.ids.add(id);
  let released=false;
  return ()=>{
    if(released)return;released=true;
    lane!.count--;if(id)lane!.ids.delete(id);
    if(lane!.count===0){lanes!.delete(kind);if(lanes!.size===0)controlsByDatabase.delete(name);}
  };
}
function activeFor(name:string){let entries=activeByDatabase.get(name);if(!entries){entries=new Map();activeByDatabase.set(name,entries);}return entries;}
function waitWithAbort<T>(work:Promise<T>,signal:AbortSignal|undefined,message='cancelled'):Promise<T>{
  if(!signal)return work;
  if(signal.aborted)return Promise.reject(Error(message));
  return new Promise<T>((resolve,reject)=>{
    const onAbort=()=>{signal.removeEventListener('abort',onAbort);reject(Error(message));};
    signal.addEventListener('abort',onAbort,{once:true});
    work.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});
    if(signal.aborted)onAbort();
  });
}
export function createStage(db:MaterialDatabase, options:{limits?:Partial<Limits>; clock?:()=>number; onCleanupCorruption?:()=>void; estimate?:()=>Promise<unknown>}={}) {
  const limits={...DEFAULTS,...options.limits};
  const onCleanupCorruption=options.onCleanupCorruption;
  if(onCleanupCorruption!==undefined&&typeof onCleanupCorruption!=='function')throw TypeError('invalid cleanup observer');
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value)||value<=0) throw Error('invalid limits');
  // Each digest prefix is an unsigned 32-bit record length. Larger values would wrap.
  if(limits.recordBytes>0xffffffff||limits.slots>MAX_TRACKED_SLOTS)throw Error('invalid limits');
  const frames=db.table<StoredFrame,[string,number]>('stageFrames');
  const sessions=db.table<Session,string>('stageSessions');
  const receipts=db.table<Receipt,string>('stageReceipts');
  const budgets=db.table<Budget,string>('stageBudget');
  const starts=db.table<RecoverableStart,string>('stageStarts');
  const repo=new MaterialRepository(db);
  const clock=options.clock??Date.now;
  const estimate=options.estimate;
  if(estimate!==undefined&&typeof estimate!=='function')throw TypeError('invalid capacity estimator');
  async function estimateLimit(signal:AbortSignal|undefined):Promise<{limit:number;sampledAt?:number}>{
    const fallback={limit:Math.min(limits.totalBytes,MATERIAL_IMPORT_MAX_TOTAL_BYTES)};
    if(signal?.aborted)throw Error('cancelled');
    if(!estimate)return fallback;
    let release:()=>void;
    try{release=takeControl(db.name,'estimate',undefined,limits.inflight);}catch{return fallback;}
    const sampledAt=clock();
    const work=Promise.resolve().then(()=>estimate());
    // Keep the lane occupied until the underlying API settles even after timeout.
    void work.then(release,release);
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(result:{limit:number;sampledAt?:number}|undefined)=>{
        if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(result)resolve(result);else reject(Error('cancelled'));
      };
      const abort=()=>finish(undefined);
      const timer=setTimeout(()=>finish(fallback),2000);
      signal?.addEventListener('abort',abort,{once:true});
      work.then(value=>finish({limit:Math.min(limits.totalBytes,materialImportCapacity(value)),sampledAt}),()=>finish(fallback));
      if(signal?.aborted)abort();
    });
  }
  // Shared in this runtime; cache hits are only admission hints.
  function admission(){let entries=admissionsByDatabase.get(db.name);if(!entries){entries=new Map();admissionsByDatabase.set(db.name,entries);}return entries;}
  function forget(id:string){const entries=admissionsByDatabase.get(db.name);entries?.delete(id);if(entries?.size===0)admissionsByDatabase.delete(db.name);}
  function remember(id:string,ownerHash:string,expiresAt:number){
    const admitted=admission();
    for(const [key,row] of admitted)if(row.expiresAt<=clock())admitted.delete(key);
    if(!admitted.has(id)&&admitted.size>=limits.slots)admitted.delete(admitted.keys().next().value!);
    admitted.set(id,{ownerHash,expiresAt});
  }
  const getBudget=async(allowInvalidExpiry=false)=>{
    const stored=await budgets.get('stage');
    const budget=stored??{key:'stage',reserved:0,reservedFrames:0,slots:0};
    // 持久数据不可信：NaN、字符串或超出安全整数范围的计数会绕过大小比较。
    if(!budget||!validInteger(budget.reserved)||!validInteger(budget.reservedFrames)||!validInteger(budget.slots))throw Error('budget corruption');
    // 同一写事务内核对有界元数据，既防止丢失预算行或少计造成超额预约，
    // 也不扫描含材料正文的帧。count 先拒绝异常超限，最多读取 256 个 session。
    const [sessionCount,receiptCount]=await Promise.all([sessions.count(),receipts.count()]);
    if(!validInteger(sessionCount)||!validInteger(receiptCount)||sessionCount>MAX_TRACKED_SLOTS||receiptCount>MAX_TRACKED_SLOTS-sessionCount)throw Error('budget corruption');
    let reserved=0,reservedFrames=0;
    // Dexie 游标回调可能吞掉异常；捕获后停止遍历，再在事务内抛出。
    let failed=false, failure:unknown;
    await sessions.toCollection().until(session=>{
      try {
        if(!validInteger(session.bytes)||!validInteger(session.frames)||session.bytes>Number.MAX_SAFE_INTEGER-reserved||session.frames>Number.MAX_SAFE_INTEGER-reservedFrames)throw Error('budget corruption');
        if(!allowInvalidExpiry&&!validInteger(session.expiresAt))throw Error('invalid expiry');
        reserved+=session.bytes;reservedFrames+=session.frames;
        return false;
      } catch(error) {failed=true;failure=error;return true;}
    }).each(()=>{});
    if(failed)throw failure;
    if(budget.reserved!==reserved||budget.reservedFrames!==reservedFrames||budget.slots!==sessionCount+receiptCount)throw Error('budget corruption');
    return budget;
  };
  const reserveBudget=(budget:Budget,bytes:number,count:number,maxTotal:number)=>{
    // 减法比较既防止求和丢失精度，也允许回收超过新限额的旧预约。
    if(bytes>maxTotal-budget.reserved||count>limits.totalFrames-budget.reservedFrames||budget.slots>=limits.slots)throw capacityError();
    budget.reserved+=bytes;budget.reservedFrames+=count;budget.slots++;
  };
  const releaseSessionBudget=(budget:Budget,s:Pick<Session,'bytes'|'frames'>,releaseSlot:boolean)=>{
    if(!validInteger(s.bytes)||!validInteger(s.frames)||s.bytes>budget.reserved||s.frames>budget.reservedFrames||(releaseSlot&&budget.slots<1))throw Error('budget corruption');
    budget.reserved-=s.bytes;budget.reservedFrames-=s.frames;if(releaseSlot)budget.slots--;
  };
  const removeFrames=async(id:string)=>{const [lower,upper]=framesRange(id);await frames.where('[session+seq]').between(lower,upper,true,true).delete();};
  const assertSession=(row:Session|undefined,cap:Capability)=>{if(!owner(row,cap))throw Error('session unavailable');if(!validInteger(row!.expiresAt))throw Error('invalid expiry');if(row!.expiresAt<=clock())throw Error('session expired');return row!;};
  const assertReceipt=(row:Receipt|undefined,cap:Capability)=>{if(!owner(row,cap))throw Error('session unavailable');if(!validInteger(row!.expiresAt))throw Error('invalid expiry');if(row!.expiresAt<=clock())throw Error('receipt expired');return row!;};
  async function guardTransaction<T>(signal:AbortSignal|undefined,task:()=>Promise<T>):Promise<T>{
    const tx=Dexie.currentTransaction;
    const onAbort=()=>{try{tx?.abort();}catch{/* It may already be committed. */}};
    signal?.addEventListener('abort',onAbort,{once:true});
    try{if(signal?.aborted){onAbort();throw Error('cancelled');}return await task();}
    finally{signal?.removeEventListener('abort',onAbort);}
  }
  function runControl<T>(kind:string,id:string|undefined,signal:AbortSignal|undefined,task:()=>Promise<T>):Promise<T>{
    if(signal?.aborted)return Promise.reject(Error('cancelled'));
    const release=takeControl(db.name,kind,id,limits.inflight);
    let operation:Promise<T>;
    try{operation=Promise.resolve(task());}catch(error){release();return Promise.reject(error);}
    // The caller may cancel promptly, but the slot remains reserved until the
    // actual IndexedDB work has settled, including any orphan cleanup.
    void operation.then(release,release);
    return waitWithAbort(operation,signal,'cancelled; operation outcome may be unknown');
  }
  async function admit(cap:Capability,signal:AbortSignal|undefined):Promise<void>{
    if(signal?.aborted)throw Error('cancelled');
    const admitted=admissionsByDatabase.get(db.name)?.get(cap.id);
    if(!admitted||admitted.expiresAt<=clock()||!secureEqual(admitted.ownerHash,hashToken(cap.token)))await resume(cap,{signal});
    if(signal?.aborted)throw Error('cancelled');
  }
  // The caller retains this capability and the full request before sending.
  // The start record prevents reuse after discard or acknowledgement until the
  // fixed deadline; expiry and clock rollback do not provide permanent replay protection.
  async function beginRecoverable(manifest:Manifest,guard:MaterialOperationGuard,capInput:Capability,options:{deadline:number;signal?:AbortSignal}):Promise<Capability>{
    const cap=requireCapability(capInput),signal=options?.signal,deadline=options?.deadline,now=clock();
    if(signal?.aborted)throw Error('cancelled');
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw Error('invalid manifest or guard');
    const {records,frames:count,bytes,digest}=manifest,guardSnapshot=guard&&{generation:guard.generation,capturedAt:guard.capturedAt};
    if (!validInteger(records)||records>10000||!validInteger(count)||count>limits.frameCount||!validInteger(bytes)||bytes>limits.totalBytes||typeof digest!=='string'||digest.length!==64||!/^([0-9a-f]{64})$/u.test(digest)||
      (records===0&&(count!==0||bytes!==0))||(records>0&&(count<records||bytes<count||!withinCapacity(bytes,count,records,limits.frameBytes,limits.recordBytes)))||!guardSnapshot||!validInteger(guardSnapshot.generation)||!Number.isFinite(guardSnapshot.capturedAt)||guardSnapshot.capturedAt<0||guardSnapshot.capturedAt>now+60000||!Number.isSafeInteger(deadline)||deadline<=now||deadline>now+limits.ttlMs)throw Error('invalid manifest, guard or deadline');
    return runControl('begin',cap.id,signal,async()=>{
      // Existing starts and receipts must remain recoverable even if the storage
      // estimation API is unavailable or never settles.
      const existing=await db.transaction('r',starts,()=>starts.get(cap.id));
      const capacity=existing?undefined:await estimateLimit(signal);
      const expiresAt=await db.transaction('rw',[db.meta,sessions,receipts,budgets,starts],async()=>guardTransaction(signal,async()=>{
        if(deadline<=clock())throw Error('session unavailable');
        const previous=await starts.get(cap.id);
        if(deadline<=clock())throw Error('session unavailable');
        if(previous){
          if(!validInteger(previous.expiresAt))throw Error('invalid expiry');
          if(!owner(previous,cap)||previous.expiresAt!==deadline||previous.records!==records||previous.frames!==count||previous.bytes!==bytes||previous.digest!==digest||previous.guard.generation!==guardSnapshot.generation||previous.guard.capturedAt!==guardSnapshot.capturedAt)throw Error('session unavailable');
          const receipt=await receipts.get(cap.id);
          const row=receipt?assertReceipt(receipt,cap):assertSession(await sessions.get(cap.id),cap);
          if(deadline<=clock())throw Error('session unavailable');
          return row.expiresAt;
        }
        // A caller-provided id must never overwrite a legacy session or receipt.
        if(await sessions.get(cap.id)||await receipts.get(cap.id))throw Error('session unavailable');
        if(!capacity)throw Error('session unavailable');
        const state=await db.meta.get('state');
        if((state?.generation??0)!==guardSnapshot.generation||guardSnapshot.capturedAt<=(state?.clearedAt??0))throw Error('stale operation');
        const budget=await getBudget();
        if(capacity.sampledAt!==undefined&&(clock()<capacity.sampledAt||clock()-capacity.sampledAt>5000))throw Error('capacity estimate expired');
        reserveBudget(budget,bytes,count,capacity.limit);
        if(await starts.count()>=limits.slots)throw capacityError();
        if(deadline<=clock())throw Error('session unavailable');
        const ownerHash=hashToken(cap.token),sessionExpiry=clock()+limits.ttlMs;
        await budgets.put(budget);
        await starts.add({id:cap.id,ownerHash,records,frames:count,bytes,digest,guard:guardSnapshot,expiresAt:deadline});
        await sessions.add({id:cap.id,ownerHash,records,frames:count,bytes,digest,phase:'open',guard:guardSnapshot,nextSeq:0,nextRecord:0,nextPart:0,currentTotal:0,currentBytes:0,receivedBytes:0,expiresAt:sessionExpiry});
        if(deadline<=clock())throw Error('session unavailable');
        return sessionExpiry;
      }));
      remember(cap.id,hashToken(cap.token),expiresAt);return cap;
    });
  }
  // Cold authentication has a separate bounded lane so unknown capabilities
  // cannot occupy an already-admitted owner's payload or control slot.
  async function authenticate(cap:Capability,signal:AbortSignal|undefined,allowMissing=false):Promise<boolean>{
    if(signal?.aborted)throw Error('cancelled');
    const current=resumesByDatabase.get(db.name)??0;
    if(current>=limits.inflight)throw Error('backpressure: resume busy');
    resumesByDatabase.set(db.name,current+1);
    const release=()=>{
      const remaining=resumesByDatabase.get(db.name)!-1;
      if(remaining===0)resumesByDatabase.delete(db.name);else resumesByDatabase.set(db.name,remaining);
    };
    let authentication:Promise<Session|Receipt|undefined>;
    try {authentication=Promise.resolve(db.transaction('r',sessions,receipts,async()=>{
      const receipt=await receipts.get(cap.id);
      if(receipt)return assertReceipt(receipt,cap);
      const session=await sessions.get(cap.id);
      if(!session&&allowMissing)return undefined;
      return assertSession(session,cap);
    }));} catch(error){release();throw error;}
    // Abort stops the caller, not an uncooperative IndexedDB read. Keep the
    // cold-authentication slot until the underlying read actually settles.
    void authentication.then(release,release);
    const row=await waitWithAbort(authentication,signal);
    if(signal?.aborted)throw Error('cancelled');
    if(!row)return false;
    remember(cap.id,row.ownerHash,row.expiresAt);return true;
  }
  // Explicit reattachment after receiver restart: no payload or unbounded queue.
  async function resume(input:Capability, options:{signal?:AbortSignal}={}):Promise<void>{
    await authenticate(requireCapability(input),options.signal);
  }
  async function append(capInput:Capability,input:Frame,requestOptions:{signal?:AbortSignal}={}):Promise<{nextSeq:number}> {
    const cap=requireCapability(capInput),callerSignal=requestOptions.signal;
    // 已取消的请求无需复制分片或启动读取事务。
    if(callerSignal?.aborted)throw Error('cancelled');
    const admittedOwner=admissionsByDatabase.get(db.name)?.get(cap.id);
    if(!admittedOwner||admittedOwner.expiresAt<=clock()||!secureEqual(admittedOwner.ownerHash,hashToken(cap.token)))throw Error('session unavailable: resume required');
    const active=activeFor(db.name);
    const ownerHash=hashToken(cap.token),previous=active.get(cap.id);
    if(previous){if(!secureEqual(previous.ownerHash,ownerHash))throw Error('session unavailable');throw Error('backpressure: append already pending');}
    if(active.size>=limits.inflight)throw Error('backpressure: receiver busy');
    const controller=new AbortController();active.set(cap.id,{ownerHash,controller});
    let authentication:Promise<void>|undefined;
    const onCallerAbort=()=>controller.abort();
    if(callerSignal?.aborted)onCallerAbort();else callerSignal?.addEventListener('abort',onCallerAbort,{once:true});
    try {
      if(!input||typeof input!=='object')throw Error('invalid frame');
      const {seq,record,part,total,recordBytes,bytes}=input;
      if(!(bytes instanceof Uint8Array))throw Error('invalid frame');
      let byteLength:number;
      try {byteLength=typedArrayByteLength.call(bytes);} catch {throw Error('invalid frame');}
      if(byteLength===0||byteLength>limits.frameBytes||!validInteger(seq)||!validInteger(record)||!validInteger(part)||!Number.isSafeInteger(total)||total<1||part>=total||!Number.isSafeInteger(recordBytes)||recordBytes<1||recordBytes>limits.recordBytes)throw Error('invalid frame');
      // Snapshot only the bounded protocol fields before any async boundary.
      // Extra properties must not be read, copied, or stored outside the budget.
      const frame:Frame={seq,record,part,total,recordBytes,bytes:new Uint8Array(bytes)};
      // Authenticate the owner before starting the write transaction.
      authentication=Promise.resolve(db.transaction('r',sessions,async()=>{const s=assertSession(await sessions.get(cap.id),cap);if(s.phase!=='open')throw Error('session sealed');}));
      // A blocked IndexedDB transaction cannot be assumed to stop on abort.
      // Return promptly to the caller but keep its admission slot until the
      // underlying authentication has actually settled.
      await waitWithAbort(authentication,controller.signal);
      const result=await db.transaction('rw',frames,sessions,async()=>{
        const tx=Dexie.currentTransaction;
        const onAbort=()=>{try{tx?.abort();}catch{/* transaction may already be committed */}};
        controller.signal.addEventListener('abort',onAbort,{once:true});
        try {
        if(controller.signal.aborted){onAbort();throw Error('cancelled');}
        const s=assertSession(await sessions.get(cap.id),cap);
        if(s.phase!=='open')throw Error('session sealed');
        if(frame.seq<s.nextSeq){
          const existing=await frames.get([cap.id,frame.seq]);
          if(!existing||existing.record!==frame.record||existing.part!==frame.part||existing.total!==frame.total||existing.recordBytes!==frame.recordBytes||!equalBytes(existing.bytes,frame.bytes))throw Error('conflicting duplicate');
          s.expiresAt=clock()+limits.ttlMs;await sessions.put(s);
          return {nextSeq:s.nextSeq};
        }
        if(frame.seq!==s.nextSeq||frame.record!==s.nextRecord||frame.part!==s.nextPart||frame.seq>=s.frames||frame.record>=s.records)throw Error('out of order');
        if(frame.part===0){s.currentTotal=frame.total;s.currentBytes=0;}
        if(frame.total!==s.currentTotal||s.currentBytes+frame.bytes.length>frame.recordBytes||s.receivedBytes+frame.bytes.length>s.bytes)throw Error('invalid frame length');
        s.currentBytes+=frame.bytes.length;s.receivedBytes+=frame.bytes.length;
        if(frame.part===frame.total-1){if(s.currentBytes!==frame.recordBytes)throw Error('incomplete record');s.nextRecord++;s.nextPart=0;s.currentTotal=0;s.currentBytes=0;}
        else s.nextPart++;
        s.nextSeq++;s.expiresAt=clock()+limits.ttlMs;
        await frames.add({...frame,session:cap.id});await sessions.put(s);
        return {nextSeq:s.nextSeq};
        } finally {controller.signal.removeEventListener('abort',onAbort);}
      });
      const current=admissionsByDatabase.get(db.name)?.get(cap.id);
      if(current&&secureEqual(current.ownerHash,ownerHash))remember(cap.id,ownerHash,clock()+limits.ttlMs);
      return result;
    } finally {
      callerSignal?.removeEventListener('abort',onCallerAbort);
      const release=()=>{active.delete(cap.id);if(active.size===0&&activeByDatabase.get(db.name)===active)activeByDatabase.delete(db.name);};
      if(authentication) void authentication.then(release,release); else release();
    }
  }
  // Walk IDB frames sequentially, hold at most one bounded record plus one frame.
  // Decoding/JSON.parse can allocate additional memory proportional to that record.
  async function consume(s:Session,onRecord:(item:unknown)=>Promise<void>):Promise<void>{
    const hash=sha256.create();let seq=0,totalBytes=0;
    for(let record=0;record<s.records;record++){
      const first=await frames.get([s.id,seq]);
      if(!first||first.record!==record||first.part!==0||first.total<1||first.recordBytes>limits.recordBytes)throw Error('missing or invalid record');
      const recordBytes=first.recordBytes,total=first.total;
      const assembled=new Uint8Array(recordBytes);let offset=0;
      hash.update(lengthBytes(recordBytes));
      for(let part=0;part<total;part++){
        const item=await frames.get([s.id,seq++]);
        if(!item||item.record!==record||item.part!==part||item.total!==total||item.recordBytes!==recordBytes||!item.bytes.length||item.bytes.length>limits.frameBytes||offset+item.bytes.length>recordBytes)throw Error('missing or invalid frame');
        assembled.set(item.bytes,offset);hash.update(item.bytes);offset+=item.bytes.length;
      }
      if(offset!==recordBytes)throw Error('incomplete record');
      totalBytes+=recordBytes;
      // Byte representation is protocol-defined UTF-8 JSON generated by the caller.
      const item=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(assembled));
      await onRecord(item);
    }
    if(seq!==s.frames||totalBytes!==s.bytes||bytesToHex(hash.digest())!==s.digest)throw Error('incomplete or corrupt backup');
  }
  async function seal(capInput:Capability, options:{signal?:AbortSignal}={}):Promise<void>{
    const cap=requireCapability(capInput),signal=options.signal;
    await admit(cap,signal);
    return runControl('seal',cap.id,signal,()=>db.transaction('rw',frames,sessions,async()=>guardTransaction(signal,async()=>{
      const s=assertSession(await sessions.get(cap.id),cap);
      if(s.phase==='sealed')return;
      if(s.nextSeq!==s.frames||s.nextRecord!==s.records||s.nextPart!==0||s.receivedBytes!==s.bytes)throw Error('incomplete transfer');
      await consume(s,async()=>{});
      s.phase='sealed';s.expiresAt=clock()+limits.ttlMs;await sessions.put(s);
    })));
  }
  async function commit(capInput:Capability, options:{signal?:AbortSignal}={}):Promise<MaterialImportResult>{
    // Snapshot mutable caller-owned options before the first asynchronous step.
    const cap=requireCapability(capInput),signal=options.signal;
    if(signal?.aborted)throw Error('cancelled');
    const admitted=admissionsByDatabase.get(db.name)?.get(cap.id);
    if(!admitted||admitted.expiresAt<=clock()||!secureEqual(admitted.ownerHash,hashToken(cap.token)))await resume(cap,{signal});
    if(signal?.aborted)throw Error('cancelled');
    const active=activeFor(db.name),ownerHash=hashToken(cap.token),previous=active.get(cap.id);
    if(previous){if(!secureEqual(previous.ownerHash,ownerHash))throw Error('session unavailable');throw Error('backpressure: operation already pending');}
    if(active.size>=limits.inflight)throw Error('backpressure: receiver busy');
    const controller=new AbortController();active.set(cap.id,{ownerHash,controller});
    const onCallerAbort=()=>controller.abort();
    if(signal?.aborted)onCallerAbort();else signal?.addEventListener('abort',onCallerAbort,{once:true});
    const release=()=>{
      signal?.removeEventListener('abort',onCallerAbort);
      active.delete(cap.id);
      if(active.size===0&&activeByDatabase.get(db.name)===active)activeByDatabase.delete(db.name);
    };
    let createdReceipt=false;
    let operation:Promise<MaterialImportResult>;
    try {operation=Promise.resolve(db.transaction('rw',[db.materials,db.meta,frames,sessions,receipts,budgets],async()=>{
      const tx=Dexie.currentTransaction;
      let cancelled=false;
      const onAbort=()=>{cancelled=true;try{tx?.abort();}catch{/* transaction may already be committed */}};
      controller.signal.addEventListener('abort',onAbort,{once:true});
      try {
        if(controller.signal.aborted){onAbort();throw Error('cancelled');}
        const existing=await receipts.get(cap.id);
        if(existing)return {...assertReceipt(existing,cap).result};
        const s=assertSession(await sessions.get(cap.id),cap);
        if(s.phase!=='sealed')throw Error('session not sealed');
        const now=clock();
        // The nested material transaction shares the outer transaction and
        // keeps one capacity count for the whole ordered import, including an
        // empty backup's generation/clear guard.
        const result=await repo.importRecords(async apply => {
          await consume(s,async item=>{
            if(cancelled)throw Error('cancelled');
            await apply(item);
            if(cancelled)throw Error('cancelled');
          });
        },now,s.guard);
        if(cancelled)throw Error('cancelled');
        const budget=await getBudget();releaseSessionBudget(budget,s,false);
        await receipts.add({id:s.id,ownerHash:s.ownerHash,result,expiresAt:now+limits.receiptTtlMs});
        await removeFrames(s.id);await sessions.delete(s.id);await budgets.put(budget);
        createdReceipt=true;
        return {...result};
      } finally {controller.signal.removeEventListener('abort',onAbort);}
    })).then(result=>{if(createdReceipt)notifyDatabaseCommit(db.name);return result;});}
    catch(error){release();throw error;}
    // An abort cannot prove whether a transaction has already committed.
    // Hold the admission slot until it really settles; callers must query the
    // receipt before retrying after a cancelled or disconnected response.
    void operation.then(release,release);
    const result=await waitWithAbort(operation,controller.signal,'cancelled; commit outcome may be unknown');
    // Keep the bounded admission hint for this owner after commit. It is only
    // a hint: every receipt operation still checks the database transaction.
    // Dropping it here would force a valid ACK to share cold authentication
    // with arbitrary capabilities immediately after the result is returned.
    return result;
  }
  async function status(capInput:Capability, options:{signal?:AbortSignal}={}):Promise<{state:'open'|'sealed';nextSeq:number}|{state:'committed';result:MaterialImportResult}>{
    const cap=requireCapability(capInput),signal=options.signal;
    await admit(cap,signal);
    return runControl('status',cap.id,signal,()=>db.transaction('r',sessions,receipts,async()=>guardTransaction(signal,async()=>{
      const receipt=await receipts.get(cap.id);
      if(receipt)return {state:'committed' as const,result:{...assertReceipt(receipt,cap).result}};
      const s=assertSession(await sessions.get(cap.id),cap);return {state:s.phase,nextSeq:s.nextSeq};
    })));
  }
  async function discard(capInput:Capability, options:{signal?:AbortSignal}={}):Promise<'discarded'|'committed'>{
    const cap=requireCapability(capInput),signal=options.signal;
    await admit(cap,signal);
    return runControl('discard',cap.id,signal,async()=>{
      const result=await db.transaction('rw',frames,sessions,receipts,budgets,async()=>guardTransaction(signal,async()=>{
        const receipt=await receipts.get(cap.id);if(receipt){assertReceipt(receipt,cap);return 'committed' as const;}
        const s=assertSession(await sessions.get(cap.id),cap),budget=await getBudget();
        releaseSessionBudget(budget,s,true);
        await removeFrames(s.id);await sessions.delete(s.id);await budgets.put(budget);return 'discarded' as const;
      }));
      if(result==='discarded'){forget(cap.id);activeByDatabase.get(db.name)?.get(cap.id)?.controller.abort();}
      return result;
    });
  }
  // Call only after the result is safely retained by the caller. A missing
  // receipt is deliberately ambiguous: it may have been acknowledged already,
  // expired and cleaned up, or never existed. No tombstone is retained.
  async function acknowledge(capInput:Capability, options:{signal?:AbortSignal}={}):Promise<'released-or-unavailable'>{
    const cap=requireCapability(capInput),signal=options.signal;
    if(signal?.aborted)throw Error('cancelled');
    const admitted=admissionsByDatabase.get(db.name)?.get(cap.id);
    if(!admitted||admitted.expiresAt<=clock()||!secureEqual(admitted.ownerHash,hashToken(cap.token))){
      // Missing remains deliberately ambiguous for idempotent retries; wrong
      // tokens and expired extant records still fail during authentication.
      if(!await authenticate(cap,signal,true))return 'released-or-unavailable';
    }
    return runControl('acknowledge',cap.id,signal,async()=>{
      const removed=await db.transaction('rw',sessions,receipts,budgets,async()=>guardTransaction(signal,async()=>{
        const receipt=await receipts.get(cap.id);
        if(!receipt){
          const session=await sessions.get(cap.id);
          if(session){assertSession(session,cap);throw Error('receipt not committed');}
          return false;
        }
        assertReceipt(receipt,cap);
        const budget=await getBudget();if(budget.slots<1)throw Error('budget corruption');budget.slots--;
        await receipts.delete(cap.id);await budgets.put(budget);return true;
      }));
      if(removed)forget(cap.id);
      return 'released-or-unavailable' as const;
    });
  }
  async function cleanup(options:{signal?:AbortSignal}={}):Promise<{sessions:number;receipts:number;corruptSessions?:number;corruptReceipts?:number;corruptStarts?:number}>{
    const signal=options.signal;
    return runControl('cleanup',undefined,signal,async()=>{
      const expiredIds:string[]=[];
      const result=await db.transaction('rw',[frames,sessions,receipts,budgets,starts],async()=>guardTransaction(signal,async()=>{
        const now=clock(),budget=await getBudget(true),all=await sessions.toArray();
        // 缺失/损坏 expiry 不会出现在 IndexedDB 索引中；未提交且不可恢复的
        // 会话必须连同私密帧一并清理，已提交回执和防重放记录仍保留。
        const expired=all.filter(s=>!validInteger(s.expiresAt)||s.expiresAt<=now),corruptSessions=expired.filter(s=>!validInteger(s.expiresAt)).length;
        for(const s of expired){releaseSessionBudget(budget,s,true);await removeFrames(s.id);await sessions.delete(s.id);expiredIds.push(s.id);}
        const allReceipts=await receipts.toArray(),startCount=await starts.count();
        if(!validInteger(startCount)||startCount>MAX_TRACKED_SLOTS)throw Error('start corruption');
        const allStarts=await starts.toArray();
        const expiredReceipts=allReceipts.filter(r=>validInteger(r.expiresAt)&&r.expiresAt<=now);
        const expiredStarts=allStarts.filter(s=>validInteger(s.expiresAt)&&s.expiresAt<=now);
        const corruptReceipts=allReceipts.filter(r=>!validInteger(r.expiresAt)).length;
        const corruptStarts=allStarts.filter(s=>!validInteger(s.expiresAt)).length;
        const count=expiredReceipts.length;if(count>budget.slots)throw Error('budget corruption');budget.slots-=count;
        await receipts.bulkDelete(expiredReceipts.map(r=>r.id));
        await starts.bulkDelete(expiredStarts.map(s=>s.id));
        await budgets.put(budget);
        if((corruptSessions||corruptReceipts||corruptStarts)&&onCleanupCorruption){
          // 通知绑定到真正的 IDB 提交事件：等待方可能已取消，回滚不得报告。
          Dexie.currentTransaction?.on('complete',()=>{
            const failed=()=>{try{console.warn('[FluentRead] 材料恢复清理诊断失败');}catch{/* 已提交事务不受诊断影响。 */}};
            try{
              const outcome:unknown=onCleanupCorruption();
              if(outcome&&(typeof outcome==='object'||typeof outcome==='function'))void Promise.resolve(outcome).catch(failed);
            }catch{failed();}
          });
        }
        return {sessions:expired.length,receipts:count,...(corruptSessions?{corruptSessions}:{}),...(corruptReceipts?{corruptReceipts}:{}),...(corruptStarts?{corruptStarts}:{})};
      }));
      for(const id of expiredIds){forget(id);activeByDatabase.get(db.name)?.get(id)?.controller.abort();}
      return result;
    });
  }
  return {beginRecoverable,resume,append,seal,commit,status,discard,acknowledge,cleanup,
    observeCommitted:(listener:()=>void)=>observeDatabaseCommit(db.name,listener)};
}
