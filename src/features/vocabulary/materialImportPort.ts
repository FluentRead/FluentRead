/**
 * @file src/features/vocabulary/materialImportPort.ts
 * 文件职责：验证并处理学习材料恢复端口的分帧协议。
 * 主要内容：注入来源权限与暂存仓库，限制端口、消息、帧和并发；断线取消时保留结果未知语义。
 * 模块边界：不安装浏览器监听器、不读取文件、不负责数据库事务通知；实际后台接线须注入可信来源及隐私判断。
 */
import type {Capability, Frame, Manifest} from '@/src/features/vocabulary/materialImportStage';
import type {MaterialOperationGuard} from '@/src/features/vocabulary/materialProtocol';
import {MATERIAL_IMPORT_FRAME_BYTES} from '@/src/features/vocabulary/materialProtocol';

export const PORT_NAME='fluentReadMaterialsImportV1';
export const MAX_FRAME_BYTES=MATERIAL_IMPORT_FRAME_BYTES;
export const MAX_BASE64_LENGTH=Math.ceil(MAX_FRAME_BYTES/3)*4;

/** 调用方在开始恢复之前持有能力，以便断线后查询真实结果。 */
export function createMaterialImportCapability():Capability {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {id:crypto.randomUUID(),token};
}

type Sender={id?:string;url?:string;incognito?:boolean;tab?:{id?:number;incognito?:boolean}};
type Events<T extends (...args:any[])=>void>={addListener(fn:T):void;removeListener(fn:T):void};
export type MaterialImportPort={name:string;sender?:Sender;onMessage:Events<(message:unknown)=>void>;onDisconnect:Events<()=>void>;postMessage(message:unknown):void;disconnect():void};
type Stage={
  observeCommitted(listener:()=>void):()=>void;
  beginRecoverable(manifest:Manifest,guard:MaterialOperationGuard,cap:Capability,options:{deadline:number;signal:AbortSignal}):Promise<Capability>;
  resume(cap:Capability,options:{signal:AbortSignal}):Promise<void>;
  append(cap:Capability,frame:Frame,options:{signal:AbortSignal}):Promise<{nextSeq:number}>;
  seal(cap:Capability,options:{signal:AbortSignal}):Promise<void>;
  commit(cap:Capability,options:{signal:AbortSignal}):Promise<{inserted:number;updated:number;skipped:number}>;
  status(cap:Capability,options:{signal:AbortSignal}):Promise<unknown>;
  discard(cap:Capability,options:{signal:AbortSignal}):Promise<unknown>;
  acknowledge(cap:Capability,options:{signal:AbortSignal}):Promise<unknown>;
};
const obj=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function snapshotMaterialImportCapability(value:unknown):Capability {
  if(!obj(value))throw Error('invalid');
  const {id,token}=value;
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)||typeof token!=='string'||!/^[0-9a-f]{64}$/u.test(token))throw Error('invalid');
  return {id,token};
}
/** Reject noncanonical encoding before handing the bounded decoded frame to stage. */
export function decodeWireFrame(value:unknown):Frame {
  if(!obj(value))throw Error('invalid');
  const {seq,record,part,total,recordBytes,base64}=value;
  if(!integer(seq)||!integer(record)||!integer(part)||!integer(total)||total<1||part>=total||!integer(recordBytes)||recordBytes<1||typeof base64!=='string'||base64.length===0||base64.length>MAX_BASE64_LENGTH||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))throw Error('invalid');
  let decoded:string;try{decoded=atob(base64);}catch{throw Error('invalid');}
  if(decoded.length===0||decoded.length>MAX_FRAME_BYTES||btoa(decoded)!==base64)throw Error('invalid');
  const bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
  return {seq,record,part,total,recordBytes,bytes};
}

type RequestSnapshot =
  | {action:'begin';capability:Capability;manifest:Manifest;guard:MaterialOperationGuard;deadline:number}
  | {action:'resume';capability:Capability}
  | {action:'append';frame:Frame}
  | {action:'seal'|'status'|'commit'|'discard'|'acknowledge'};

/** 仅保留协议字段，避免在异步等待中持有调用者附加的大对象。 */
function snapshotRequest(input:Record<string,unknown>):RequestSnapshot {
  const action=input.action;
  if(action==='begin') {
    const manifestInput=input.manifest,guardInput=input.guard,deadline=input.deadline;
    if(!obj(manifestInput)||!obj(guardInput)||!integer(deadline))throw Error('invalid');
    const {records,frames,bytes,digest}=manifestInput,{generation,capturedAt}=guardInput;
    if(!integer(records)||!integer(frames)||!integer(bytes)||typeof digest!=='string'||digest.length!==64
      ||!integer(generation)||typeof capturedAt!=='number'||!Number.isFinite(capturedAt))throw Error('invalid');
    return {action,capability:snapshotMaterialImportCapability(input.capability),manifest:{records,frames,bytes,digest},guard:{generation,capturedAt},deadline};
  }
  if(action==='resume')return {action,capability:snapshotMaterialImportCapability(input.capability)};
  if(action==='append')return {action,frame:decodeWireFrame(input.frame)};
  if(action==='seal'||action==='status'||action==='commit'||action==='discard'||action==='acknowledge')return {action};
  throw Error('invalid');
}

/**
 * `stage` is the real candidate. A port is bound to one capability only after
 * begin/resume succeeds. One operation is in-flight per port; no queue exists.
 * Disconnect requests cancellation, but cannot prove an IDB commit rolled back.
 */
export function makePortBridge(stage:Stage, options:{isTrustedSender:(sender:Sender|undefined)=>boolean;isPrivateContext:()=>boolean;onCommitted:()=>void;maxPorts?:number;idleTimeoutMs?:number}) {
  const maxPorts=options.maxPorts??8,idleTimeoutMs=options.idleTimeoutMs??30_000;
  if(!Number.isSafeInteger(maxPorts)||maxPorts<1||!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<1||idleTimeoutMs>2_147_483_647)throw Error('invalid bridge limits');
  let ports=0,disposed=false;
  const stops=new Set<()=>void>();
  const attached=new WeakMap<MaterialImportPort,boolean>();
  const unsubscribe=stage.observeCommitted(()=>options.onCommitted());
  function trusted(port:MaterialImportPort):boolean {
    try{return port.name===PORT_NAME&&port.sender?.incognito!==true&&port.sender?.tab?.incognito!==true&&!options.isPrivateContext()&&options.isTrustedSender(port.sender);}catch{return false;}
  }
  return {attach(port:MaterialImportPort):boolean {
    // runtime.onConnect is shared with reading/writing streams: unrelated
    // names belong to their own listeners and must not be closed here.
    if(port.name!==PORT_NAME)return false;
    const existing=attached.get(port);if(existing!==undefined)return existing;
    if(disposed||!trusted(port)||ports>=maxPorts){try{port.disconnect();}catch{}return false;}
    ports++;attached.set(port,true);
    const controller=new AbortController();let closed=false,busy=false,lastSeen=-1,failures=0,bound:Capability|undefined;
    let idleTimer:ReturnType<typeof setTimeout>|undefined;
    const clearIdle=()=>{if(idleTimer!==undefined)clearTimeout(idleTimer);idleTimer=undefined;};
    const close=()=>{if(closed)return;closed=true;attached.set(port,false);clearIdle();controller.abort();try{port.onMessage.removeListener(onMessage);}catch{}try{port.onDisconnect.removeListener(close);}catch{}stops.delete(stop);ports--;};
    const stop=()=>{close();try{port.disconnect();}catch{}};
    // Idle means no operation is in flight; never infer a live commit has failed
    // solely because a timer elapsed. Its caller may disconnect to cancel.
    const armIdle=()=>{clearIdle();if(!closed&&!busy)idleTimer=setTimeout(stop,idleTimeoutMs);};
    const send=(message:unknown)=>{if(closed)return;try{port.postMessage(message);}catch{stop();}};
    const onMessage=(input:unknown)=>{
      if(closed)return;
      if(!trusted(port)||busy||!obj(input)){
        // Port 发送队列不提供背压；违例立即断连，已经开始的提交结果需要查询回执。
        stop();return;
      }
      let id:unknown;
      try{id=input.id;}catch{stop();return;}
      if(!integer(id)){stop();return;}
      // Reusing an id could misassociate an early busy reply with a pending
      // operation; disconnect and recover by capability instead.
      if(id<=lastSeen){stop();return;}
      lastSeen=id;
      busy=true;clearIdle();
      let request:RequestSnapshot;
      try {request=snapshotRequest(input);} catch {stop();return;}
      input=undefined; // 不让异步回调持有调用者附加的未知字段。
      void (async()=>{
        let result:unknown;
        let failure:'operation-failed'|'capacity-exceeded'='operation-failed';
        try {
          const signal=controller.signal;
          if(request.action==='begin'){
            if(bound)throw Error('invalid');
            const {capability,manifest,guard,deadline}=request;
            try {await stage.beginRecoverable(manifest,guard,capability,{deadline,signal});}
            catch(error) {
              // Only begin admission guarantees rollback before reporting this category.
              if(error instanceof Error&&error.name==='MaterialBackupCapacityError')failure='capacity-exceeded';
              throw error;
            }
            // 断线可能发生在事务提交后；相同能力须重新查询实际状态。
            const status=await stage.status(capability,{signal});
            if(!closed){bound=capability;result=status;}
          }else if(request.action==='resume'){
            if(bound)throw Error('invalid');
            const {capability}=request;
            await stage.resume(capability,{signal});
            const status=await stage.status(capability,{signal});
            if(!closed){bound=capability;result=status;}
          }else {
            if(!bound)throw Error('invalid');
            switch(request.action){
              case 'append':result=await stage.append(bound,request.frame,{signal});break;
              case 'seal':await stage.seal(bound,{signal});result={state:'sealed'};break;
              case 'status':result=await stage.status(bound,{signal});break;
              case 'commit':result=await stage.commit(bound,{signal});break;
              case 'discard':result=await stage.discard(bound,{signal});if(result==='discarded')bound=undefined;break;
              case 'acknowledge':result=await stage.acknowledge(bound,{signal});bound=undefined;break;
            }
          }
          send({id,ok:true,data:result});
        } catch {
          // 同一连接最多返回三次失败；后续断连由调用方使用原能力查询状态。
          if(!closed&&++failures<=3)send({id,ok:false,error:failure});else if(!closed)stop();
        }
        finally {busy=false;armIdle();}
      })();
    };
    stops.add(stop);
    try {
      port.onDisconnect.addListener(close);
      if(closed){try{port.onDisconnect.removeListener(close);}catch{}return false;}
      port.onMessage.addListener(onMessage);
      if(closed){try{port.onMessage.removeListener(onMessage);}catch{}return false;}
      armIdle();return true;
    } catch {stop();try{port.onMessage.removeListener(onMessage);}catch{}try{port.onDisconnect.removeListener(close);}catch{}return false;}
  },dispose(){if(disposed)return;disposed=true;for(const stop of [...stops])stop();unsubscribe();},get activePorts(){return ports;}};
}
