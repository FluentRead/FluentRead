/**
 * @file src/features/vocabulary/materialImportPortClient.ts
 * 文件职责：为学习材料分片恢复提供单请求在途的端口客户端。
 * 主要内容：对二进制帧执行有界 Base64 编码，关联请求与响应，断线时明确返回结果未知。
 * 模块边界：由调用方保存恢复能力、选择文件和管理页面生命周期；不自行重试、接触 IndexedDB 或安装浏览器监听。
 */
import type {Capability, Frame, Manifest} from './materialImportStage';
import type {MaterialImportResult, MaterialOperationGuard} from './materialProtocol';
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
  let pending:{id:number;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void}|undefined;
  const closeListeners=()=>{port.onMessage.removeListener(onMessage);port.onDisconnect.removeListener(onDisconnect);};
  const onDisconnect=()=>{
    if(closed)return;
    closed=true;closeListeners();const active=pending;pending=undefined;
    active?.reject(new MaterialImportPortDisconnectedError());
  };
  const disconnect=()=>{onDisconnect();try{port.disconnect();}catch{/* 浏览器可能已关闭端口。 */}};
  const onMessage=(value:unknown)=>{
    if(closed)return;
    if(!value||typeof value!=='object'||Array.isArray(value)){disconnect();return;}
    const response=value as {id?:unknown;ok?:unknown;data?:unknown};
    if(!pending||response.id!==pending.id||typeof response.ok!=='boolean'){disconnect();return;}
    const active=pending;pending=undefined;
    if(response.ok)active.resolve(response.data);else active.reject(new Error('材料恢复操作失败，请查询当前会话后重试。'));
  };
  port.onMessage.addListener(onMessage);port.onDisconnect.addListener(onDisconnect);
  function request<T>(action:string,fields:Record<string,unknown>={}):Promise<T>{
    if(closed)return Promise.reject(new MaterialImportPortDisconnectedError());
    if(pending)return Promise.reject(new Error('材料恢复请求尚未完成。'));
    if(nextId>=Number.MAX_SAFE_INTEGER){disconnect();return Promise.reject(new MaterialImportPortDisconnectedError());}
    const id=++nextId;
    return new Promise<T>((resolve,reject)=>{
      pending={id,resolve:value=>resolve(value as T),reject};
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
    seal:()=>request<{state:'sealed'}>('seal'),
    status:()=>request<MaterialImportStatus>('status'),
    commit:()=>request<MaterialImportResult>('commit'),
    discard:()=>request<'discarded'|'committed'>('discard'),
    acknowledge:()=>request<'released-or-unavailable'>('acknowledge'),
    close:disconnect,
  };
}
