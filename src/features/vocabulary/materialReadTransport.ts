/** Bounded, acknowledged transport for a single authorized material read. */
import {sha256} from '@noble/hashes/sha256';

export const MATERIAL_READ_PORT_NAME = 'fluentread-material-read-v1';
export const MATERIAL_READ_FRAME_BYTES = 24 * 1024;
export const MATERIAL_READ_MESSAGE_BYTES = 40 * 1024;
const VERSION = 1;

type Events<T extends (...args: never[]) => void> = {addListener(listener:T):void;removeListener(listener:T):void};
export interface MaterialReadPort {
  onMessage: Events<(message:unknown)=>void>;
  onDisconnect: Events<()=>void>;
  postMessage(message:unknown):void;
  disconnect():void;
}
export interface MaterialReadOptions {signal?:AbortSignal;idleTimeoutMs?:number}

function digestHex(bytes:Uint8Array):string {return Array.from(bytes, byte=>byte.toString(16).padStart(2,'0')).join('');}
function encode(bytes:Uint8Array):string {
  let value='';
  for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(value);
}
function decode(value:unknown, length:unknown):Uint8Array {
  if(typeof value!=='string'||!Number.isSafeInteger(length)||typeof length!=='number'||length<1||length>MATERIAL_READ_FRAME_BYTES||value.length!==Math.ceil(length/3)*4)throw Error('Invalid material read frame');
  let binary:string;
  try {binary=atob(value);} catch {throw Error('Invalid material read frame');}
  if(binary.length!==length||btoa(binary)!==value)throw Error('Invalid material read frame');
  const bytes=new Uint8Array(length);
  for(let i=0;i<length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
function record(value:unknown, keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid material read message');
  const object=value as Record<string,unknown>, actual=Object.keys(object);
  if(actual.length!==keys.length||keys.some(key=>!Object.hasOwn(object,key))||object.v!==VERSION)throw Error('Invalid material read message');
  return object;
}

/** Single-message mailbox. A full mailbox or a message during processing is a protocol violation. */
function channel(port:MaterialReadPort, options:MaterialReadOptions) {
  const timeout=options.idleTimeoutMs??30_000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>2_147_483_647) {
    try {port.disconnect();} catch {/* The port may already be gone. */}
    throw Error('Invalid material read timeout');
  }
  let timer:ReturnType<typeof setTimeout>|undefined, closed=false, accepting=true, pending:unknown, hasPending=false, wake:(()=>void)|undefined;
  const controller=new AbortController();
  let failure:Error|undefined;
  const failureListeners=new Set<(reason:Error)=>void>();
  const closeListeners=()=>{
    if(timer!==undefined)clearTimeout(timer);
    options.signal?.removeEventListener('abort',onAbort);
    try {port.onMessage.removeListener(onMessage);} catch {}
    try {port.onDisconnect.removeListener(onDisconnect);} catch {}
  };
  const fail=(error:Error)=>{
    if(closed)return;
    closed=true;failure=error;closeListeners();
    for(const listener of failureListeners)listener(error);
    failureListeners.clear();wake=undefined;controller.abort();
    try {port.disconnect();} catch {}
  };
  const touch=()=>{if(timer!==undefined)clearTimeout(timer);timer=setTimeout(()=>fail(Error('Material read timed out')),timeout);};
  const onAbort=()=>fail(Error('Material read cancelled'));
  const onDisconnect=()=>fail(Error('Material read disconnected'));
  const onMessage=(message:unknown)=>{
    if(closed)return;
    if(!accepting||hasPending){fail(Error('Unexpected material read message'));return;}
    pending=message;hasPending=true;touch();wake?.();wake=undefined;
  };
  try {
    port.onDisconnect.addListener(onDisconnect);
    if(!closed)port.onMessage.addListener(onMessage);
    if(options.signal?.aborted)onAbort();else options.signal?.addEventListener('abort',onAbort,{once:true});
    if(closed)closeListeners();else touch();
  } catch(error) {fail(Error('Material read listener failed'));closeListeners();throw error;}
  return {
    signal:controller.signal,
    async next():Promise<unknown> {
      if(closed)throw failure??Error('Material read disconnected');
      if(!hasPending)await new Promise<void>((resolve,reject)=>{
        const onFailure=(error:Error)=>{wake=undefined;reject(error);};
        failureListeners.add(onFailure);
        wake=()=>{failureListeners.delete(onFailure);resolve();};
      });
      if(closed)throw failure??Error('Material read disconnected');
      const result=pending;pending=undefined;hasPending=false;return result;
    },
    async guard<T>(value:PromiseLike<T>):Promise<T> {
      // Always observe the supplied work, even if it triggered cancellation synchronously.
      const work=Promise.resolve(value);
      if(closed) {void work.catch(()=>{});throw failure??Error('Material read disconnected');}
      return new Promise<T>((resolve,reject)=>{
        const onFailure=(error:Error)=>reject(error);
        failureListeners.add(onFailure);
        work.then(result=>{failureListeners.delete(onFailure);resolve(result);},error=>{failureListeners.delete(onFailure);reject(error);});
      });
    },
    assertOpen(){if(closed)throw failure??Error('Material read disconnected');},
    pause(){accepting=false;},
    send(message:unknown){if(closed)throw Error('Material read disconnected');touch();try {port.postMessage(message);} catch {fail(Error('Material read send failed'));throw Error('Material read send failed');}},
    resume(){accepting=true;},
    fail,
    close(){if(closed)return;closed=true;closeListeners();},
  };
}

/** The producer must authorize the port and supply revision-checked chunks.
 * A source factory receives a signal that also aborts on peer disconnect or timeout.
 */
export async function sendMaterialRead(port:MaterialReadPort, source:AsyncIterable<Uint8Array>|((signal:AbortSignal)=>AsyncIterable<Uint8Array>), options:MaterialReadOptions={}):Promise<void> {
  const pipe=channel(port,options), hash=sha256.create();
  let iterator:AsyncIterator<Uint8Array>|undefined, seq=0, bytes=0, complete=false;
  const buffer=new Uint8Array(MATERIAL_READ_FRAME_BYTES);
  const flushDelay=Math.min(25,Math.floor((options.idleTimeoutMs??30_000)/2));
  let used=0, blocks=0, bufferedAt=0;
  const flush=async()=>{
    if(!used)return;
    const part=buffer.subarray(0,used);
    if(!Number.isSafeInteger(seq+1)||!Number.isSafeInteger(bytes+part.length))throw Error('Material read is too large');
    hash.update(part);bytes+=part.length;
    const message={v:VERSION,type:'frame',seq,length:part.length,data:encode(part)};
    if(JSON.stringify(message).length>MATERIAL_READ_MESSAGE_BYTES)throw Error('Material read frame is too large');
    pipe.resume();pipe.send(message);
    const ack=record(await pipe.next(),['v','type','seq']);
    if(ack.type!=='ack'||ack.seq!==seq)throw Error('Invalid material read acknowledgement');
    pipe.pause();seq++;used=0;blocks=0;bufferedAt=0;
  };
  try {
    pipe.assertOpen();pipe.pause();
    iterator=(typeof source==='function'?source(pipe.signal):source)[Symbol.asyncIterator]();
    for(;;) {
      pipe.assertOpen();
      const pending=iterator.next();
      let next:IteratorResult<Uint8Array>;
      if(used) {
        // Avoid waiting for many slow reads before delivering the first frame.
        const flushNow=Symbol('flush');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
          const candidate=await pipe.guard(Promise.race([pending,new Promise<typeof flushNow>(resolve=>{timer=setTimeout(()=>resolve(flushNow),Math.max(0,flushDelay-(performance.now()-bufferedAt)));})]));
          if(candidate===flushNow) {await flush();next=await pipe.guard(pending);}
          else next=candidate;
        } finally {if(timer!==undefined)clearTimeout(timer);}
      } else next=await pipe.guard(pending);
      if(next.done)break;
      if(!(next.value instanceof Uint8Array)||next.value.length===0)throw Error('Invalid material read bytes');
      for(let offset=0;offset<next.value.length;) {
        const length=Math.min(buffer.length-used,next.value.length-offset);
        if(!used)bufferedAt=performance.now();
        buffer.set(next.value.subarray(offset,offset+length),used);used+=length;offset+=length;
        if(used===buffer.length)await flush();
      }
      if(used&&(++blocks>=16||performance.now()-bufferedAt>=flushDelay))await flush();
    }
    await flush();
    pipe.resume();pipe.send({v:VERSION,type:'end',seq,bytes,digest:digestHex(hash.digest())});
    const ack=record(await pipe.next(),['v','type','seq']);
    if(ack.type!=='done'||ack.seq!==seq)throw Error('Invalid material read completion');
    complete=true;
  } catch(error) {pipe.fail(error instanceof Error?error:Error('Material read failed'));throw error;}
  finally {
    pipe.close();
    if(!complete&&iterator?.return) {try {void Promise.resolve(iterator.return()).catch(()=>{});} catch {/* Cleanup must not hide the original error. */}}
    if(complete) {try {port.disconnect();} catch {/* The peer may already have closed the dedicated port. */}}
  }
}

/** Deliver verified frames one at a time. Treat data as complete only after this resolves. */
export async function receiveMaterialRead(port:MaterialReadPort, onChunk:(chunk:Uint8Array, signal:AbortSignal)=>void|Promise<void>, options:MaterialReadOptions={}):Promise<void> {
  const pipe=channel(port,options), hash=sha256.create();
  let seq=0, bytes=0;
  try {
    for(;;) {
      const incoming=await pipe.next();
      const type=(incoming as {type?:unknown}|null)?.type;
      if(type==='frame') {
        const message=record(incoming,['v','type','seq','length','data']);
        if(message.seq!==seq||!Number.isSafeInteger(seq+1))throw Error('Invalid material read sequence');
        const chunk=decode(message.data,message.length);
        if(!Number.isSafeInteger(bytes+chunk.length))throw Error('Material read is too large');
        hash.update(chunk);bytes+=chunk.length;
        pipe.pause();
        await pipe.guard(Promise.resolve().then(()=>{pipe.assertOpen();return onChunk(chunk,pipe.signal);}));
        pipe.resume();pipe.send({v:VERSION,type:'ack',seq});seq++;
      } else if(type==='end') {
        const message=record(incoming,['v','type','seq','bytes','digest']);
        if(message.seq!==seq||message.bytes!==bytes||message.digest!==digestHex(hash.digest()))throw Error('Invalid material read completion');
        pipe.send({v:VERSION,type:'done',seq});return;
      } else throw Error('Invalid material read message');
    }
  } catch(error) {pipe.fail(error instanceof Error?error:Error('Material read failed'));throw error;}
  finally {pipe.close();}
}
