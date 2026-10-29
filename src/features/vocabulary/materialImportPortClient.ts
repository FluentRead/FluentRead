/**
 * @file src/features/vocabulary/materialImportPortClient.ts
 * 文件职责：为学习材料分片恢复提供单请求在途的端口客户端。
 * 主要内容：对二进制帧执行有界 Base64 编码，关联请求与响应，断线时明确返回结果未知。
 * 模块边界：由调用方保存恢复能力、选择文件和管理页面生命周期；不自行重试、接触 IndexedDB 或安装浏览器监听。
 */
import type {Capability, Frame, Manifest, MaterialImportProgress} from './materialImportStage';
import {MATERIAL_IMPORT_MAX_FRAMES, type MaterialImportResult, type MaterialOperationGuard} from './materialProtocol';
import {MAX_FRAME_BYTES, snapshotMaterialImportCapability} from './materialImportPort';

interface Events<T extends (...args: never[])=>void> {addListener(listener:T):void;removeListener(listener:T):void}
export interface MaterialImportClientPort {
  onMessage:Events<(message:unknown)=>void>;
  onDisconnect:Events<()=>void>;
  postMessage(message:unknown):void;
  disconnect():void;
}
export type MaterialImportStatus = {state:'open'|'sealed';nextSeq:number}|{state:'committed';result:MaterialImportResult};

/** 断线可能发生在后台事务提交之前或之后；调用方须使用原能力重新查询。 */
export class MaterialImportPortDisconnectedError extends Error {
  constructor() {super('材料恢复连接已断开，请使用原会话查询结果。');this.name='MaterialImportPortDisconnectedError';}
}

/** 不使用未绑定的 btoa 或展开超大数组，限制一次消息的编码开销。 */
function encodeFrame(frame:Frame):Omit<Frame,'bytes'> & {base64:string} {
  const {seq,record,part,total,recordBytes,bytes}=frame;
  if(!(bytes instanceof Uint8Array))throw Error('材料恢复分片无效');
  const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!.call(bytes) as number;
  if(byteLength===0||byteLength>MAX_FRAME_BYTES)throw Error('材料恢复分片无效');
  let binary='';
  for(let i=0;i<byteLength;i+=8192)binary+=String.fromCharCode(...Uint8Array.prototype.subarray.call(bytes,i,Math.min(i+8192,byteLength)));
  return {seq,record,part,total,recordBytes,base64:btoa(binary)};
}

/** 只允许一个在途请求；断连后绝不自动重放可能已提交的操作。 */
export function createMaterialImportPortClient(port:MaterialImportClientPort) {
  let nextId=0,closed=false;
  let pending:{id:number;action:string;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void;onProgress?:(progress:MaterialImportProgress)=>void;lastDone:number;total?:number}|undefined;
  const closeListeners=()=>{
    try{port.onMessage.removeListener(onMessage);}catch{/* 另一个监听仍须移除。 */}
    try{port.onDisconnect.removeListener(onDisconnect);}catch{/* 端口可能已经被浏览器释放。 */}
  };
  const onDisconnect=()=>{
    if(closed)return;
    closed=true;closeListeners();const active=pending;pending=undefined;
    active?.reject(new MaterialImportPortDisconnectedError());
  };
  const disconnect=()=>{onDisconnect();try{port.disconnect();}catch{/* 浏览器可能已关闭端口。 */}};
  const onMessage=(value:unknown)=>{
    if(closed)return;
    if(!value||typeof value!=='object'||Array.isArray(value)){disconnect();return;}
    const response=value as {id?:unknown;ok?:unknown;data?:unknown;error?:unknown;progress?:unknown};
    if(!pending||response.id!==pending.id){disconnect();return;}
    if(Object.hasOwn(response,'progress')){
      const progress=response.progress;
      if(!pending.onProgress||Object.keys(response).length!==2||!Object.hasOwn(response,'id')||!progress||typeof progress!=='object'||Array.isArray(progress)
          ||Object.keys(progress).length!==2||!Object.hasOwn(progress,'done')||!Object.hasOwn(progress,'total')){disconnect();return;}
      const {done,total}=progress as {done?:unknown;total?:unknown};
      if(typeof done!=='number'||typeof total!=='number'||!Number.isSafeInteger(done)||!Number.isSafeInteger(total)
          ||done<=pending.lastDone||done>total||total>MATERIAL_IMPORT_MAX_FRAMES||(pending.total!==undefined&&pending.total!==total)){disconnect();return;}
      pending.lastDone=done;pending.total=total;
      try{pending.onProgress({done,total});}catch{disconnect();}
      return;
    }
    if(typeof response.ok!=='boolean'){disconnect();return;}
    const active=pending;pending=undefined;
    if(response.ok)active.resolve(response.data);
    else if(active.action==='begin'&&response.error==='capacity-exceeded')active.reject(Object.assign(new Error('材料备份超出当前恢复容量，请保留原材料和备份文件。'),{name:'MaterialBackupCapacityError'}));
    else active.reject(new Error('材料恢复操作失败，请查询当前会话后重试。'));
  };
  try {
    port.onDisconnect.addListener(onDisconnect);
    if(!closed)port.onMessage.addListener(onMessage);
    // 注册期间同步断连时，监听可能在关闭回调之后才被加入。
    if(closed)closeListeners();
  } catch(error) {disconnect();closeListeners();throw error;}
  function request<T>(action:string,fields:Record<string,unknown>={},onProgress?:(progress:MaterialImportProgress)=>void):Promise<T>{
    if(closed)return Promise.reject(new MaterialImportPortDisconnectedError());
    if(pending)return Promise.reject(new Error('材料恢复请求尚未完成。'));
    if(nextId>=Number.MAX_SAFE_INTEGER){disconnect();return Promise.reject(new MaterialImportPortDisconnectedError());}
    const id=++nextId;
    return new Promise<T>((resolve,reject)=>{
      pending={id,action,resolve:value=>resolve(value as T),reject,onProgress,lastDone:0};
      try{port.postMessage({id,action,...fields});}catch{disconnect();}
    });
  }
  return {
    begin:async(capability:Capability,manifest:Manifest,guard:MaterialOperationGuard,deadline:number)=>{
      const cap=snapshotMaterialImportCapability(capability);
      const {records,frames,bytes,digest}=manifest,{generation,capturedAt}=guard;
      return request<MaterialImportStatus>('begin',{capability:cap,manifest:{records,frames,bytes,digest},guard:{generation,capturedAt},deadline});
    },
    resume:async(capability:Capability)=>request<MaterialImportStatus>('resume',{capability:snapshotMaterialImportCapability(capability)}),
    append:async(frame:Frame)=>request<{nextSeq:number}>('append',{frame:encodeFrame(frame)}),
    seal:(onProgress?:(progress:MaterialImportProgress)=>void)=>request<{state:'sealed'}>('seal',onProgress?{progress:true}:{},onProgress),
    status:()=>request<MaterialImportStatus>('status'),
    commit:(onProgress?:(progress:MaterialImportProgress)=>void)=>request<MaterialImportResult>('commit',onProgress?{progress:true}:{},onProgress),
    discard:()=>request<'discarded'|'committed'>('discard'),
    acknowledge:()=>request<'released-or-unavailable'>('acknowledge'),
    close:disconnect,
  };
}
