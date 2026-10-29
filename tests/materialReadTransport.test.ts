import {describe, expect, it, vi} from 'vitest';
import {MATERIAL_READ_FRAME_BYTES, MATERIAL_READ_MESSAGE_BYTES, addMaterialReadCount, receiveMaterialRead, sendMaterialRead, type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';

function pair() {
  type Listener=(value:unknown)=>void;
  const states=[{messages:new Set<Listener>(),disconnects:new Set<()=>void>(),closed:false},{messages:new Set<Listener>(),disconnects:new Set<()=>void>(),closed:false}];
  const sent:unknown[][]=[[],[]];
  const ports=states.map((state,index)=>({
    onMessage:{addListener(fn:Listener){state.messages.add(fn);},removeListener(fn:Listener){state.messages.delete(fn);}},
    onDisconnect:{addListener(fn:()=>void){state.disconnects.add(fn);},removeListener(fn:()=>void){state.disconnects.delete(fn);}},
    postMessage(value:unknown){if(state.closed)throw Error('closed');sent[index].push(value);queueMicrotask(()=>{for(const fn of states[1-index].messages)fn(value);});},
    disconnect(){if(state.closed)return;state.closed=true;states[1-index].closed=true;queueMicrotask(()=>{for(const side of states)for(const fn of side.disconnects)fn();});},
  })) as MaterialReadPort[];
  return {ports,states,sent};
}
async function* chunks(...items:Uint8Array[]) {yield* items;}
const bytes=(count:number)=>Uint8Array.from({length:count},(_,index)=>index%251);

describe('material read transport',()=>{
  it('checks sequence and byte counters at the safe integer boundary',()=>{
    expect(addMaterialReadCount(Number.MAX_SAFE_INTEGER-1,1,'Material read is too large')).toBe(Number.MAX_SAFE_INTEGER);
    expect(()=>addMaterialReadCount(Number.MAX_SAFE_INTEGER,1,'Material read is too large')).toThrow('Material read is too large');
    expect(()=>addMaterialReadCount(Number.MAX_SAFE_INTEGER,1,'Invalid material read sequence')).toThrow('Invalid material read sequence');
  });
  it('streams large content with one frame in flight and validates completion',async()=>{
    const {ports,states,sent}=pair(), input=bytes(MATERIAL_READ_FRAME_BYTES*3+17), output:Uint8Array[]=[];
    const received=receiveMaterialRead(ports[1],async chunk=>{output.push(chunk);await Promise.resolve();});
    await Promise.all([sendMaterialRead(ports[0],chunks(input)),received]);
    expect(Buffer.concat(output.map(x=>Buffer.from(x)))).toEqual(Buffer.from(input));
    expect(sent[0]).toHaveLength(5);expect(sent[1]).toHaveLength(5);
    for(const message of sent[0])expect(JSON.stringify(message).length).toBeLessThanOrEqual(MATERIAL_READ_MESSAGE_BYTES);
    expect(states.every(s=>s.messages.size===0&&s.disconnects.size===0)).toBe(true);
  });
  it('coalesces small chunks without changing byte order or exceeding the frame limit',async()=>{
    const {ports,sent}=pair(), result:Uint8Array[]=[];
    async function* source(){for(let i=0;i<101;i++)yield new Uint8Array([i]);}
    await Promise.all([receiveMaterialRead(ports[1],chunk=>{result.push(chunk);}),sendMaterialRead(ports[0],source())]);
    expect(Buffer.concat(result.map(chunk=>Buffer.from(chunk)))).toEqual(Buffer.from(Array.from({length:101},(_,i)=>i)));
    expect(sent[0].filter((message:any)=>message.type==='frame')).toHaveLength(7);
    expect(result.every(chunk=>chunk.length<=MATERIAL_READ_FRAME_BYTES)).toBe(true);
  });
  it('flushes a buffered partial frame while a slow source waits and still times out',async()=>{
    vi.useFakeTimers();try {
      const {ports}=pair(), received:Uint8Array[]=[];
      const consumer=receiveMaterialRead(ports[1],chunk=>{received.push(chunk);},{idleTimeoutMs:1000});
      const producer=sendMaterialRead(ports[0],async function* (signal){
        yield new Uint8Array([1]);
        await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
      },{idleTimeoutMs:100});
      const failure=expect(producer).rejects.toThrow('timed out'), disconnected=expect(consumer).rejects.toThrow('disconnected');
      await vi.advanceTimersByTimeAsync(30);expect(received).toEqual([new Uint8Array([1])]);
      await vi.advanceTimersByTimeAsync(100);await failure;await disconnected;
    } finally {vi.useRealTimers();}
  });
  it('flushes by elapsed time even when slow chunks continue arriving',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});try {
      const {ports}=pair(), received:Uint8Array[]=[];
      async function* source(){for(let i=0;i<8;i++){yield new Uint8Array([i]);await new Promise(resolve=>setTimeout(resolve,10));}}
      const all=Promise.all([receiveMaterialRead(ports[1],chunk=>{received.push(chunk);}),sendMaterialRead(ports[0],source())]);
      await vi.advanceTimersByTimeAsync(30);
      expect(received.length).toBeGreaterThan(0);expect(received[0].length).toBeLessThan(8);
      await vi.advanceTimersByTimeAsync(100);await all;
      expect(Buffer.concat(received.map(chunk=>Buffer.from(chunk)))).toEqual(Buffer.from([0,1,2,3,4,5,6,7]));
    } finally {vi.useRealTimers();}
  });
  it('cancels buffered data before the next slow source read settles',async()=>{
    const {ports,sent}=pair(),controller=new AbortController();let started!:()=>void;
    const blocked=new Promise<void>(resolve=>{started=resolve;});
    const producer=sendMaterialRead(ports[0],async function* (signal){yield new Uint8Array([1]);started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},{signal:controller.signal});
    await blocked;controller.abort();await expect(producer).rejects.toThrow('cancelled');expect(sent[0]).toEqual([]);
  });
  it.each(['ack','disconnect'] as const)('observes a prefetched rejection while a timed frame awaits %s',async outcome=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const unhandled:unknown[] = [], onUnhandled = (error:unknown) => {unhandled.push(error);};
    process.on('unhandledRejection',onUnhandled);
    try {
      const {ports}=pair(), output:Uint8Array[]=[];
      let rejectRead!:(error:Error)=>void, releaseAck:(()=>void)|undefined;
      const waiting = new Promise<void>((_resolve,reject)=>{rejectRead=reject;});
      const original = ports[1].postMessage.bind(ports[1]);
      ports[1].postMessage=message=>{
        if ((message as {type?:string}).type==='ack') releaseAck=()=>original(message);
        else original(message);
      };
      const consumer=receiveMaterialRead(ports[1],chunk=>{output.push(chunk);});
      const consumerResult=consumer.catch(error=>error);
      const producer=sendMaterialRead(ports[0],async function*(){yield new Uint8Array([7]);await waiting;});
      const producerResult=producer.catch(error=>error);
      await vi.advanceTimersByTimeAsync(30);
      expect(output).toEqual([new Uint8Array([7])]);expect(releaseAck).toBeDefined();
      const failure=Error('prefetched read failed');rejectRead(failure);
      await vi.advanceTimersByTimeAsync(1);
      if(outcome==='ack') releaseAck!(); else ports[1].disconnect();
      await vi.advanceTimersByTimeAsync(1);
      const error=await producerResult;
      if(outcome==='ack') expect(error).toBe(failure); else expect(error.message).toContain('disconnected');
      expect((await consumerResult).message).toContain('disconnected');
      await vi.advanceTimersByTimeAsync(1);expect(unhandled).toEqual([]);
    } finally {process.removeListener('unhandledRejection',onUnhandled);vi.useRealTimers();}
  });
  it('keeps failure subscriptions bounded across many acknowledged frames',async()=>{
    const {ports}=pair(), original=Promise.prototype.then, add=Set.prototype.add, seen=new Map<Promise<unknown>,number>();
    let largestSet=0;
    Set.prototype.add=function(this:Set<unknown>,value:unknown){const result=add.call(this,value);if(typeof value==='function')largestSet=Math.max(largestSet,this.size);return result;} as typeof Set.prototype.add;
    Promise.prototype.then=function(this:Promise<unknown>,onFulfilled,onRejected){
      seen.set(this,(seen.get(this)??0)+1);
      return original.call(this,onFulfilled,onRejected);
    } as typeof Promise.prototype.then;
    try {
      const receiver=receiveMaterialRead(ports[1],()=>{});
      async function* frames(){for(let i=0;i<8192;i++)yield new Uint8Array([i%256]);}
      await Promise.all([sendMaterialRead(ports[0],frames()),receiver]);
    } finally {Promise.prototype.then=original;Set.prototype.add=add;}
    expect(largestSet).toBeLessThan(20);
    // A shared never-settled rejection promise formerly received one reaction per frame.
    expect(Math.max(0,...seen.values())).toBeLessThan(20);
  });
  it('rejects an empty source block without starving timers or consuming further blocks',async()=>{
    const {ports}=pair();let reads=0, cleaned=false;
    async function* source(){try {for(;;){reads++;yield new Uint8Array();}}finally{cleaned=true;}}
    await expect(sendMaterialRead(ports[0],source())).rejects.toThrow('bytes');
    await Promise.resolve();expect(reads).toBe(1);expect(cleaned).toBe(true);
  });
  it('keeps the port alive until the asynchronously delivered final acknowledgement arrives',async()=>{
    const {ports,states}=pair();const original=ports[1].postMessage;let deliver:(()=>void)|undefined;
    ports[1].postMessage=message=>{
      if((message as {type?:string}).type==='done')deliver=()=>original(message);
      else original(message);
    };
    const receiver=receiveMaterialRead(ports[1],()=>{}),sender=sendMaterialRead(ports[0],chunks(bytes(1)));
    await receiver;expect(deliver).toBeDefined();expect(states[0].closed).toBe(false);
    deliver!();await sender;expect(states[0].closed).toBe(true);
  });
  it('closes a dedicated port when sender setup receives an invalid timeout',async()=>{
    const {ports,states}=pair();await expect(sendMaterialRead(ports[0],chunks(),{idleTimeoutMs:Infinity})).rejects.toThrow('timeout');
    expect(states[0].closed).toBe(true);
  });
  it('keeps the invalid-timeout error if a stale port throws while being closed',async()=>{
    const {ports}=pair();
    ports[0].disconnect=()=>{throw Error('extension context invalidated');};
    await expect(sendMaterialRead(ports[0],chunks(),{idleTimeoutMs:0})).rejects.toThrow('Invalid material read timeout');
  });
  it('supports empty streams',async()=>{
    const {ports}=pair();await Promise.all([receiveMaterialRead(ports[1],()=>{throw Error('unexpected');}),sendMaterialRead(ports[0],chunks())]);
  });
  it.each([
    {v:1,type:'frame',seq:1,length:1,data:'YQ=='},
    {v:1,type:'frame',seq:0,length:1,data:'YQ'},
    {v:1,type:'frame',seq:0,length:1,data:'YR=='},
    {v:1,type:'frame',seq:0,length:1,data:'%%%='},
    {v:1,type:'frame',seq:0,length:0,data:''},
    {v:1,type:'frame',seq:0,length:MATERIAL_READ_FRAME_BYTES+1,data:'a'},
    {v:2,type:'frame',seq:0,length:1,data:'YQ=='},
    {v:1,type:'frame',seq:0,length:1,data:'YQ==',extra:true},
    {v:1,type:'end',seq:0,bytes:0,digest:'bad'},
    {v:1,type:'unknown'},
    null,
  ])('rejects invalid or incomplete messages %#',async message=>{
    const {ports,states}=pair();const result=receiveMaterialRead(ports[1],()=>{});
    ports[0].postMessage(message);await expect(result).rejects.toThrow();
    expect(states[1].messages.size).toBe(0);expect(states[1].disconnects.size).toBe(0);
  });
  it('rejects a second frame while a consumer has not acknowledged the first',async()=>{
    const {ports}=pair();let unblock!:()=>void;const processing=new Promise<void>(resolve=>{unblock=resolve;});
    const result=receiveMaterialRead(ports[1],()=>processing);
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await new Promise(resolve=>setTimeout(resolve,0));
    ports[0].postMessage({v:1,type:'frame',seq:1,length:1,data:'Yg=='});
    await expect(result).rejects.toThrow('Unexpected');unblock();
  });
  it('rejects bad acknowledgement and disconnects the peer',async()=>{
    const {ports}=pair();const producer=sendMaterialRead(ports[0],chunks(bytes(1)));
    await new Promise(resolve=>setTimeout(resolve,0));ports[1].postMessage({v:1,type:'ack',seq:1});
    await expect(producer).rejects.toThrow('acknowledgement');
  });
  it('cancels an in-progress producer and cleans up listeners',async()=>{
    const {ports,states}=pair(), controller=new AbortController();let release!:()=>void;
    const source={async *[Symbol.asyncIterator](){await new Promise<void>(resolve=>{release=resolve;});yield bytes(1);}};
    const result=sendMaterialRead(ports[0],source,{signal:controller.signal});controller.abort();
    await expect(result).rejects.toThrow('cancelled');release();
    expect(states[0].messages.size).toBe(0);expect(states[0].disconnects.size).toBe(0);
  });
  it('rejects disconnection and timeout',async()=>{
    const first=pair(), disconnected=receiveMaterialRead(first.ports[1],()=>{});first.ports[0].disconnect();await expect(disconnected).rejects.toThrow('disconnected');
    vi.useFakeTimers();try {const second=pair(), timed=receiveMaterialRead(second.ports[1],()=>{},{idleTimeoutMs:10});const assertion=expect(timed).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(10);await assertion;} finally {vi.useRealTimers();}
  });
  it('detects corrupted stream digest after delivering a frame',async()=>{
    const {ports}=pair(), output:Uint8Array[]=[];
    const result=receiveMaterialRead(ports[1],chunk=>{output.push(chunk);});
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await new Promise(resolve=>setTimeout(resolve,0));
    ports[0].postMessage({v:1,type:'end',seq:1,bytes:1,digest:'wrong'});
    await expect(result).rejects.toThrow('completion');expect(output).toHaveLength(1);
  });
  it('rejects invalid final acknowledgements',async()=>{
    const {ports}=pair();const result=sendMaterialRead(ports[0],chunks());
    await new Promise(resolve=>setTimeout(resolve,0));ports[1].postMessage({v:1,type:'done',seq:1});
    await expect(result).rejects.toThrow('completion');
  });
  it('rejects invalid timeout and producer chunks',async()=>{
    const invalidTimeout=pair();await expect(receiveMaterialRead(invalidTimeout.ports[1],()=>{},{idleTimeoutMs:0})).rejects.toThrow('timeout');
    expect(invalidTimeout.states[1].closed).toBe(true);
    const {ports}=pair();async function* invalid(){yield 'not bytes' as unknown as Uint8Array;}
    await expect(sendMaterialRead(ports[0],invalid())).rejects.toThrow('bytes');
  });
  it('stops waiting for an in-progress consumer when cancelled',async()=>{
    const {ports}=pair(), controller=new AbortController();let release!:()=>void;
    const result=receiveMaterialRead(ports[1],()=>new Promise<void>(resolve=>{release=resolve;}),{signal:controller.signal});
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await new Promise(resolve=>setTimeout(resolve,0));controller.abort();
    await expect(result).rejects.toThrow('cancelled');release();
  });
  it('observes a late consumer rejection after cancellation without acknowledging the frame',async()=>{
    const {ports,sent}=pair(),controller=new AbortController();let rejectWork!:(error:Error)=>void,started!:()=>void;
    const startedWork=new Promise<void>(resolve=>{started=resolve;});
    const unhandled:unknown[]=[],onUnhandled=(error:unknown)=>{unhandled.push(error);};
    process.on('unhandledRejection',onUnhandled);
    try {
      const consumer=receiveMaterialRead(ports[1],()=>{started();return new Promise<void>((_resolve,reject)=>{rejectWork=reject;});},{signal:controller.signal});
      const producer=sendMaterialRead(ports[0],chunks(bytes(1))).catch(error=>error);
      await startedWork;controller.abort();
      await expect(consumer).rejects.toThrow('cancelled');
      rejectWork(Error('late consumer failure'));expect((await producer).message).toContain('disconnected');
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(unhandled).toEqual([]);expect(sent[1]).toEqual([]);
    } finally {process.removeListener('unhandledRejection',onUnhandled);}
  });
  it('preserves cancellation if a consumer finishes immediately before its acknowledgement is sent',async()=>{
    const {ports,sent}=pair(),controller=new AbortController();
    const result=receiveMaterialRead(ports[1],()=>{
      // Two microtasks model a user cancellation arriving after the guarded
      // callback resolves but before the awaiting receiver resumes.
      queueMicrotask(()=>queueMicrotask(()=>controller.abort()));
    },{signal:controller.signal});
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await expect(result).rejects.toThrow('cancelled');
    expect(sent[1]).toEqual([]);
  });
  it('preserves a protocol violation arriving between consumer completion and acknowledgement',async()=>{
    const {ports,sent}=pair();
    const result=receiveMaterialRead(ports[1],()=>{
      queueMicrotask(()=>ports[0].postMessage({v:1,type:'frame',seq:1,length:1,data:'Yg=='}));
    });
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await expect(result).rejects.toThrow('Unexpected material read message');
    expect(sent[1]).toEqual([]);
  });
  it('keeps a protocol failure if the caller cancels after the failure',async()=>{
    const {ports}=pair(),controller=new AbortController();let started!:()=>void;
    const consuming=new Promise<void>(resolve=>{started=resolve;});
    const result=receiveMaterialRead(ports[1],()=>{started();return new Promise<void>(()=>{});},{signal:controller.signal});
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await consuming;
    ports[0].postMessage({v:1,type:'frame',seq:1,length:1,data:'Yg=='});queueMicrotask(()=>controller.abort());
    await expect(result).rejects.toMatchObject({name:'Error',message:'Unexpected material read message'});
  });
  it('honors cancellation by another port listener before a received frame is processed',async()=>{
    const {ports,sent}=pair(),controller=new AbortController(),consume=vi.fn();
    const result=receiveMaterialRead(ports[1],consume,{signal:controller.signal});
    // Another listener may react to the same browser message before the
    // awaiting receiver resumes in its next microtask.
    ports[1].onMessage.addListener(()=>controller.abort());
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await expect(result).rejects.toThrow('cancelled');
    expect(consume).not.toHaveBeenCalled();expect(sent[1]).toEqual([]);
  });
  it('honors cancellation by another port listener before an acknowledgement is processed',async()=>{
    const {ports,sent}=pair(),controller=new AbortController();
    const receiver=receiveMaterialRead(ports[1],()=>{}).catch(error=>error);
    const producer=sendMaterialRead(ports[0],chunks(bytes(1)),{signal:controller.signal});
    ports[0].onMessage.addListener(()=>controller.abort());
    await expect(producer).rejects.toThrow('cancelled');await receiver;
    expect(sent[0].filter((message:any)=>message.type==='end')).toHaveLength(0);
  });
  it('aborts a cooperative producer when the peer disconnects',async()=>{
    const {ports}=pair();let aborted=false;
    const result=sendMaterialRead(ports[0],async function* (signal){
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
      yield bytes(1);
    });
    ports[1].disconnect();await expect(result).rejects.toThrow('disconnected');expect(aborted).toBe(true);
  });
  it('rejects unexpected data while the producer is obtaining a chunk',async()=>{
    const {ports}=pair();let release!:()=>void;
    async function* delayed(){await new Promise<void>(resolve=>{release=resolve;});yield bytes(1);}
    const result=sendMaterialRead(ports[0],delayed());ports[1].postMessage({v:1,type:'ack',seq:0});
    await expect(result).rejects.toThrow('Unexpected');release();
  });
  it('cleans listeners even if registration synchronously disconnects or then throws',async()=>{
    for(const shouldThrow of [false,true]) {
      const {ports,states}=pair(), port=ports[0], original=port.onDisconnect.addListener;
      port.onDisconnect.addListener=(listener)=>{listener();original(listener);if(shouldThrow)throw Error('registration');};
      await expect(receiveMaterialRead(port,()=>{})).rejects.toThrow();
      expect(states[0].messages.size).toBe(0);expect(states[0].disconnects.size).toBe(0);
    }
  });
  it('does not start a producer if already cancelled',async()=>{
    const {ports}=pair(), controller=new AbortController();controller.abort();const factory=vi.fn(async function* (){yield bytes(1);});
    await expect(sendMaterialRead(ports[0],factory,{signal:controller.signal})).rejects.toThrow('cancelled');expect(factory).not.toHaveBeenCalled();
  });
  it('observes a rejected source promise when cancellation happens synchronously inside next',async()=>{
    const {ports}=pair(), controller=new AbortController(), cleanup=vi.fn();
    const source={ [Symbol.asyncIterator](){return {
      next(){controller.abort();return Promise.reject(Error('late source error'));},
      return:async()=>{cleanup();return {done:true as const,value:undefined};},
    };} };
    await expect(sendMaterialRead(ports[0],source,{signal:controller.signal})).rejects.toThrow('cancelled');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('keeps the cancellation reason if a source factory cancels synchronously',async()=>{
    const {ports}=pair(), controller=new AbortController(), cleanup=vi.fn();
    const source=()=>{controller.abort();return { [Symbol.asyncIterator](){return {
      next:async()=>({done:true as const,value:undefined}),
      return:async()=>{cleanup();return {done:true as const,value:undefined};},
    };} };};
    await expect(sendMaterialRead(ports[0],source,{signal:controller.signal})).rejects.toThrow('cancelled');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('aborts a cooperative consumer while it is processing',async()=>{
    const {ports}=pair(), controller=new AbortController();let aborted=false;
    const result=receiveMaterialRead(ports[1],(_chunk,signal)=>new Promise<void>(resolve=>{
      signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});
    }),{signal:controller.signal});
    ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await new Promise(resolve=>setTimeout(resolve,0));controller.abort();
    await expect(result).rejects.toThrow('cancelled');expect(aborted).toBe(true);
  });
  it('runs iterator cleanup after a producer failure',async()=>{
    const {ports}=pair(), cleanup=vi.fn();
    const source={ [Symbol.asyncIterator](){return {next:async()=>{throw Error('read failed');},return:async()=>{cleanup();return {done:true as const,value:undefined};}};} };
    await expect(sendMaterialRead(ports[0],source)).rejects.toThrow('read failed');expect(cleanup).toHaveBeenCalledOnce();
  });
  it('signals a cooperative stalled source on timeout',async()=>{
    vi.useFakeTimers();try {
      const {ports}=pair();let aborted=false;
      const result=sendMaterialRead(ports[0],async function* (signal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));yield bytes(1);},{idleTimeoutMs:10});
      const assertion=expect(result).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(10);await assertion;expect(aborted).toBe(true);
    } finally {vi.useRealTimers();}
  });
  it('rejects a malformed acknowledgement and duplicate frame bursts',async()=>{
    const first=pair(), producer=sendMaterialRead(first.ports[0],chunks(bytes(1)));
    await new Promise(resolve=>setTimeout(resolve,0));first.ports[1].postMessage(null);
    await expect(producer).rejects.toThrow('message');
    const second=pair(), consumer=receiveMaterialRead(second.ports[1],()=>{});
    const frame={v:1,type:'frame',seq:0,length:1,data:'YQ=='};
    second.ports[0].postMessage(frame);second.ports[0].postMessage(frame);
    await expect(consumer).rejects.toThrow('Unexpected');
  });
  it('preserves the initial error if cancellation cleanup throws',async()=>{
    const {ports}=pair();
    const source={ [Symbol.asyncIterator](){return {next:async()=>{throw Error('read failed');},return(){throw Error('cleanup failed');}};} };
    await expect(sendMaterialRead(ports[0],source)).rejects.toThrow('read failed');
  });
  it('preserves non-Error failures from source creation and consumer callbacks',async()=>{
    const first=pair(), sourceError={message:'source unavailable'};
    await expect(sendMaterialRead(first.ports[0],()=>{throw sourceError;})).rejects.toBe(sourceError);
    const second=pair(), consumerError={message:'destination unavailable'};
    const consumer=receiveMaterialRead(second.ports[1],()=>{throw consumerError;});
    second.ports[0].postMessage({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await expect(consumer).rejects.toBe(consumerError);
  });
  it('cleans the other listener when the browser rejects one listener removal',async()=>{
    const {ports,states}=pair(), original=ports[0].onMessage.removeListener;
    ports[0].onMessage.removeListener=listener=>{original(listener);throw Error('context invalidated');};
    const result=receiveMaterialRead(ports[0],()=>{});ports[1].disconnect();
    await expect(result).rejects.toThrow('disconnected');
    expect(states[0].messages.size).toBe(0);expect(states[0].disconnects.size).toBe(0);
  });
  it('ignores an already queued message after cancellation and handles a disconnected port',async()=>{
    const {ports,states}=pair(), controller=new AbortController();
    const result=receiveMaterialRead(ports[0],()=>{throw Error('must not process late message');},{signal:controller.signal});
    const listener=[...states[0].messages][0];
    ports[0].disconnect=()=>{throw Error('already disconnected');};
    controller.abort();listener({v:1,type:'frame',seq:0,length:1,data:'YQ=='});
    await expect(result).rejects.toThrow('cancelled');expect(states[0].messages.size).toBe(0);
  });
  it('continues cleanup if browser disconnection listener removal fails',async()=>{
    const {ports,states}=pair(), original=ports[0].onDisconnect.removeListener;
    ports[0].onDisconnect.removeListener=listener=>{original(listener);throw Error('context invalidated');};
    const result=receiveMaterialRead(ports[0],()=>{});ports[1].disconnect();
    await expect(result).rejects.toThrow('disconnected');
    expect(states[0].messages.size).toBe(0);expect(states[0].disconnects.size).toBe(0);
  });
  it('completes successfully even when the browser has already closed the port',async()=>{
    const {ports}=pair(), original=ports[0].disconnect;
    ports[0].disconnect=()=>{original();throw Error('context invalidated');};
    await Promise.all([sendMaterialRead(ports[0],chunks()),receiveMaterialRead(ports[1],()=>{})]);
  });
  it('rejects sends that fail synchronously',async()=>{
    const {ports}=pair();ports[0].postMessage=()=>{throw Error('post failed');};
    await expect(sendMaterialRead(ports[0],chunks(bytes(1)))).rejects.toThrow('send failed');
  });
  it('rejects consumer failures and notifies the producer',async()=>{
    const {ports}=pair();const consumer=receiveMaterialRead(ports[1],()=>{throw Error('consumer failed');});
    const producer=sendMaterialRead(ports[0],chunks(bytes(1)));
    await expect(consumer).rejects.toThrow('consumer failed');await expect(producer).rejects.toThrow('disconnected');
  });
});
