import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {createStage,createImportCapability} from '@/src/features/vocabulary/materialImportStage';
import {MaterialDatabase,MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {attachReadingStreamPort} from '@/src/features/reading-assistant/streamPort';
import {createWritingHandler} from '@/src/features/writing-assistant/background';
import {decodeWireFrame,makePortBridge,MAX_BASE64_LENGTH,MAX_FRAME_BYTES,PORT_NAME,type MaterialImportPort} from '@/src/features/vocabulary/materialImportPort';

let serial=0;const dbs:MaterialDatabase[]=[];const names:string[]=[];
const bridges:Array<ReturnType<typeof makePortBridge>>=[];
const trackedBridge=(...args:Parameters<typeof makePortBridge>)=>{const bridge=makePortBridge(...args);bridges.push(bridge);return bridge;};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
class EventHub<T extends (...args:any[])=>void>{listeners=new Set<T>();addListener=(f:T)=>{this.listeners.add(f);};removeListener=(f:T)=>{this.listeners.delete(f);};emit(...args:Parameters<T>){for(const f of [...this.listeners])f(...args);}}
class MockPort implements MaterialImportPort{
  name=PORT_NAME;sender:any={id:'fixture',url:'chrome-extension://fixture/options.html',tab:{incognito:false}};
  onMessage=new EventHub<(value:unknown)=>void>();onDisconnect=new EventHub<()=>void>();
  output:any[]=[];disconnected=false;waiters=new Map<number,(value:any)=>void>();
  constructor(readonly serialization:'json'|'clone'='json'){}
  wire<T>(value:T):T{return this.serialization==='json'?JSON.parse(JSON.stringify(value)):structuredClone(value);}
  postMessage(value:any){if(this.disconnected)throw Error('disconnected');const data=this.wire(value);this.output.push(data);const wake=this.waiters.get(data.id);if(wake){this.waiters.delete(data.id);wake(data);}}
  disconnect(){if(this.disconnected)return;this.disconnected=true;this.onDisconnect.emit();}
  emit(value:unknown){this.onMessage.emit(this.wire(value));}
  request(id:number,body:Record<string,unknown>){const promise=new Promise<any>(resolve=>this.waiters.set(id,resolve));this.emit({id,...body});return promise;}
}
function harness(serialization:'json'|'clone'='json',beforeAppend?:()=>Promise<void>){
  const name=`port-bridge-${++serial}`;names.push(name);const db=new MaterialDatabase(name);dbs.push(db);
  const stage=createStage(db,{clock:()=>100,limits:{frameBytes:MAX_FRAME_BYTES,ttlMs:1000,receiptTtlMs:10000},beforeAppend});
  const bridge=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false});
  const port=new MockPort(serialization);expect(bridge.attach(port)).toBe(true);return {db,stage,bridge,port,repo:new MaterialRepository(db)};
}
function dataRecord(){return '{"id":"n","source":{"kind":"article","url":"https://example.test/a"},"title":"A","topics":[],"references":[{"kind":"note","id":"p","note":"PRIVATE_FIXTURE_CONTENT"}],"createdAt":-0,"updatedAt":12,"lastReadAt":11,"archivedAt":null}';}
function frames(raw=dataRecord()){
  const bytes=new TextEncoder().encode(raw),hash=sha256.create();const n=bytes.length;
  hash.update(new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]));hash.update(bytes);
  return {manifest:{records:1,frames:1,bytes:n,digest:bytesToHex(hash.digest())},frame:{seq:0,record:0,part:0,total:1,recordBytes:n,base64:Buffer.from(bytes).toString('base64')}};
}
const emptyManifest=()=>({records:0,frames:0,bytes:0,digest:bytesToHex(sha256(new Uint8Array()))});
afterEach(async()=>{for(const bridge of bridges.splice(0))bridge.dispose();for(const db of dbs.splice(0))db.close();for(const name of names.splice(0))await Dexie.delete(name);});

const trustSender=(sender:any)=>{if(!sender?.url||sender.id!=='fixture')return false;try{const u=new URL(sender.url);return u.protocol==='chrome-extension:'&&u.host==='fixture'&&u.pathname==='/options.html';}catch{return false;}};

describe('material stage Port bridge',()=>{
  it('attaches the same live Port only once without interrupting it',async()=>{
    const {bridge,port}=harness();
    expect(bridge.attach(port)).toBe(true);expect(bridge.activePorts).toBe(1);
    expect(port.onMessage.listeners.size).toBe(1);expect(port.onDisconnect.listeners.size).toBe(1);
    expect(await port.request(1,{action:'status'})).toMatchObject({ok:false});
    expect(port.disconnected).toBe(false);port.disconnect();expect(bridge.activePorts).toBe(0);
    expect(bridge.attach(port)).toBe(false);expect(bridge.activePorts).toBe(0);
  });
  it('bounds errors from well-formed but unavailable capabilities',async()=>{
    const {stage,port:initial}=harness();initial.disconnect();
    const failing={...stage,resume:async()=>{throw Error('PRIVATE_FAILURE_DETAILS');}};
    const bridge=trackedBridge(failing,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false});
    const port=new MockPort(),cap=createImportCapability();expect(bridge.attach(port)).toBe(true);
    for(let id=1;id<=10000;id++){
      port.emit({id,action:'resume',capability:cap});
      for(let i=0;i<5;i++)await Promise.resolve();
    }
    expect(port.disconnected).toBe(true);expect(port.output.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(port.output)).not.toContain('PRIVATE_FAILURE_DETAILS');expect(bridge.activePorts).toBe(0);
  });
  it('retains a committed receipt after the failure limit closes the Port',async()=>{
    const {bridge,port}=harness(),cap=createImportCapability(),manifest=emptyManifest();
    const begin={action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000};
    await port.request(1,begin);await port.request(2,{action:'seal'});
    expect(await port.request(3,{action:'commit'})).toMatchObject({ok:true});
    for(let id=4;id<=6;id++)expect(await port.request(id,begin)).toMatchObject({ok:false,error:'operation-failed'});
    port.emit({id:7,...begin});await vi.waitFor(()=>expect(port.disconnected).toBe(true));
    const next=new MockPort();expect(bridge.attach(next)).toBe(true);
    expect(await next.request(1,{action:'resume',capability:cap})).toMatchObject({ok:true,data:{state:'committed',result:{inserted:0}}});next.disconnect();
  });
  it('disconnects a flood of malformed actions without accumulating responses',()=>{
    const {port,bridge}=harness();
    for(let id=1;id<=10000;id++)port.emit({id,action:'unknown'});
    expect(port.disconnected).toBe(true);expect(port.output).toHaveLength(0);expect(bridge.activePorts).toBe(0);
  });
  it.each(['message','disconnect'] as const)('rolls back listeners and capacity when %s registration throws',which=>{
    const {stage,port:initial}=harness();initial.disconnect();
    const bridge=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,maxPorts:1});
    const broken=new MockPort(),hub=which==='message'?broken.onMessage:broken.onDisconnect;
    const add=hub.addListener;
    vi.spyOn(hub,'addListener').mockImplementation((listener:any)=>{add(listener);throw Error('registration failed');});
    expect(bridge.attach(broken)).toBe(false);expect(broken.disconnected).toBe(true);
    expect(broken.onMessage.listeners.size).toBe(0);expect(broken.onDisconnect.listeners.size).toBe(0);expect(bridge.activePorts).toBe(0);
    const good=new MockPort();expect(bridge.attach(good)).toBe(true);good.disconnect();
  });
  it('does not retain a listener if disconnect occurs during registration',()=>{
    const {stage,port:initial}=harness();initial.disconnect();
    const bridge=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,maxPorts:1});
    const broken=new MockPort(),add=broken.onDisconnect.addListener;
    vi.spyOn(broken.onDisconnect,'addListener').mockImplementation(listener=>{listener();add(listener);});
    expect(bridge.attach(broken)).toBe(false);expect(broken.onMessage.listeners.size).toBe(0);
    expect(broken.onDisconnect.listeners.size).toBe(0);expect(bridge.activePorts).toBe(0);
  });
  it('releases capacity if the port disconnects while its message listener is registered',()=>{
    const {stage,port:initial}=harness();initial.disconnect();
    const bridge=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,maxPorts:1});
    const broken=new MockPort(),add=broken.onMessage.addListener;
    vi.spyOn(broken.onMessage,'addListener').mockImplementation(listener=>{broken.disconnect();add(listener);});
    expect(bridge.attach(broken)).toBe(false);expect(bridge.activePorts).toBe(0);
    expect(broken.onMessage.listeners.size).toBe(0);expect(broken.onDisconnect.listeners.size).toBe(0);
    const next=new MockPort();expect(bridge.attach(next)).toBe(true);next.disconnect();
  });
  it('rejects wrong extension, URL, frame, incognito, private context and idle-port exhaustion before stage calls',async()=>{
    const {stage,bridge,port}=harness();const spy=vi.spyOn(stage,'status');
    const denied=[{}, {id:'other',url:'chrome-extension://fixture/options.html'}, {id:'fixture',url:'chrome-extension://other/options.html'}, {id:'fixture',url:'https://fixture/options.html'}, {id:'fixture',url:'chrome-extension://fixture/options.html.evil'}, {id:'fixture',url:'chrome-extension://fixture/popup.html'}, {id:'fixture',url:'chrome-extension://fixture/options.html',tab:{incognito:true}}, {id:'fixture',url:'chrome-extension://fixture/options.html',incognito:true}];
    for(const sender of denied){const fake=new MockPort();fake.sender=sender;expect(bridge.attach(fake)).toBe(false);expect(fake.disconnected).toBe(true);}
    const fake=new MockPort();fake.name='other';expect(bridge.attach(fake)).toBe(false);expect(fake.disconnected).toBe(false);
    let privateMode=false;const separate=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>privateMode,maxPorts:1});const one=new MockPort(),two=new MockPort();expect(separate.attach(one)).toBe(true);expect(separate.attach(two)).toBe(false);privateMode=true;one.emit({id:1,action:'status'});expect(one.disconnected).toBe(true);expect(separate.activePorts).toBe(0);expect(spy).not.toHaveBeenCalled();
    port.disconnect();expect(bridge.activePorts).toBe(0);
  });
  it('strictly bounds and canonicalizes base64 before decoding, including 128 KiB exact boundary',()=>{
    const shape={seq:0,record:0,part:0,total:1,recordBytes:1};
    for(const base64 of ['', 'A', 'Zh==', 'A===','AA=A','AA--','AAAA\n','A'.repeat(MAX_BASE64_LENGTH+4)])expect(()=>decodeWireFrame({...shape,base64})).toThrow('invalid');
    expect(decodeWireFrame({...shape,base64:'Zg=='}).bytes).toEqual(new Uint8Array([102]));
    const max=Buffer.alloc(MAX_FRAME_BYTES,7).toString('base64');expect(max.length).toBe(MAX_BASE64_LENGTH);expect(decodeWireFrame({...shape,recordBytes:MAX_FRAME_BYTES,base64:max}).bytes.byteLength).toBe(MAX_FRAME_BYTES);
    const tooMany=Buffer.alloc(MAX_FRAME_BYTES+1,7).toString('base64');expect(()=>decodeWireFrame({...shape,recordBytes:MAX_FRAME_BYTES+1,base64:tooMany})).toThrow('invalid');
  });
  it.each(['json','clone'] as const)('uses real repository and ordered idempotent frames across %s serialization, retaining -0',async mode=>{
    const {port,repo}=harness(mode),cap=createImportCapability(),{manifest,frame}=frames();
    expect(await port.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000})).toMatchObject({ok:true,data:{state:'open'}});
    expect(await port.request(2,{action:'append',frame})).toMatchObject({ok:true,data:{nextSeq:1}});
    expect(await port.request(3,{action:'append',frame})).toMatchObject({ok:true,data:{nextSeq:1}});
    expect(await port.request(4,{action:'append',frame:{...frame,base64:'Zg=='}})).toMatchObject({ok:false});
    expect(await port.request(5,{action:'seal'})).toMatchObject({ok:true});
    const committed=await port.request(6,{action:'commit'});expect(committed).toMatchObject({ok:true,data:{inserted:1,updated:0,skipped:0}});
    const records=await repo.list();expect(records).toHaveLength(1);expect(Object.is(records[0].createdAt,-0)).toBe(true);expect(records[0].references[0].note).toBe('PRIVATE_FIXTURE_CONTENT');
    expect(await port.request(7,{action:'status'})).toMatchObject({ok:true,data:{state:'committed',result:{inserted:1}}});
    expect(await port.request(8,{action:'acknowledge'})).toMatchObject({ok:true,data:'released-or-unavailable'});
    expect(JSON.stringify(port.output)).not.toContain(cap.token);expect(JSON.stringify(port.output)).not.toContain('PRIVATE_FIXTURE_CONTENT');port.disconnect();
  });
  it('does not queue messages on a busy port and closes listener references',async()=>{
    const block=deferred(),started=deferred(),{port,bridge,stage}=harness('json',()=>{started.resolve();return block.promise;}),cap=createImportCapability(),{manifest,frame}=frames();
    await port.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});
    port.emit({id:2,action:'append',frame});await started.promise;
    port.emit({id:3,action:'status'});expect(port.disconnected).toBe(true);expect(port.output.some(row=>row.id===3)).toBe(false);
    block.resolve();await vi.waitFor(()=>expect(port.onMessage.listeners.size).toBe(0));expect(port.onDisconnect.listeners.size).toBe(0);expect(bridge.activePorts).toBe(0);
    await vi.waitFor(async()=>expect(await stage.status(cap)).toMatchObject({state:'open',nextSeq:0}));
  });
  it('closes on duplicate IDs while an operation is pending rather than emitting a misleading busy reply',async()=>{
    const block=deferred(),started=deferred(),{port,bridge}=harness('json',()=>{started.resolve();return block.promise;}),cap=createImportCapability(),{manifest,frame}=frames();
    await port.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});
    port.emit({id:2,action:'append',frame});await started.promise;port.emit({id:2,action:'append',frame});
    expect(port.disconnected).toBe(true);expect(port.output.some(row=>row.id===2)).toBe(false);expect(bridge.activePorts).toBe(0);block.resolve();
  });
  it('notifies a real late commit after disconnect and recovers its receipt without notifying twice',async()=>{
    const h=harness(),cap=createImportCapability(),{manifest,frame}=frames(),changed=vi.fn();
    h.port.disconnect();const bridge=trackedBridge(h.stage,{isTrustedSender:trustSender,onCommitted:changed,isPrivateContext:()=>false});
    const first=new MockPort();expect(bridge.attach(first)).toBe(true);
    await first.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});
    await first.request(2,{action:'append',frame});await first.request(3,{action:'seal'});
    const original=h.db.transaction.bind(h.db) as (...args:any[])=>Promise<unknown>;
    const transaction=vi.spyOn(h.db,'transaction').mockImplementationOnce(((...args:any[])=>Promise.resolve(original(...args)).then(value=>{first.disconnect();return value;})) as never);
    try{
      first.emit({id:4,action:'commit'});await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce());
      expect(first.output.some(row=>row.id===4)).toBe(false);
      const second=new MockPort();expect(bridge.attach(second)).toBe(true);
      expect(await second.request(1,{action:'resume',capability:cap})).toMatchObject({ok:true,data:{state:'committed',result:{inserted:1}}});
      expect(await second.request(2,{action:'commit'})).toMatchObject({ok:true,data:{inserted:1}});
      expect(changed).toHaveBeenCalledOnce();second.disconnect();
    }finally{transaction.mockRestore();}
  });
  it('recovers a committed result after a lost response with the same capability and does not replay',async()=>{
    const h=harness(),{manifest,frame}=frames(),cap=createImportCapability();const finished=deferred(),release=deferred(),changed=vi.fn();
    const realCommit=h.stage.commit;const wrapped={...h.stage,commit:async(...args:Parameters<typeof realCommit>)=>{const result=await realCommit(...args);finished.resolve();await release.promise;return result;}};
    h.port.disconnect();const bridge=trackedBridge(wrapped,{isTrustedSender:trustSender,onCommitted:changed,isPrivateContext:()=>false});const first=new MockPort();expect(bridge.attach(first)).toBe(true);
    await first.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});await first.request(2,{action:'append',frame});await first.request(3,{action:'seal'});
    first.emit({id:4,action:'commit'});await finished.promise;expect(changed).toHaveBeenCalledOnce();first.emit({id:5,action:'status'});expect(first.disconnected).toBe(true);release.resolve();await new Promise(r=>setTimeout(r,0));
    expect(first.output.some(row=>row.id===4)).toBe(false);
    // Reload stage module to discard its per-runtime admission cache, then open
    // a fresh connection to the same IndexedDB before querying the receipt.
    vi.resetModules();const fresh=await import('@/src/features/vocabulary/materialImportStage');
    const restartedDb=new MaterialDatabase(h.db.name);dbs.push(restartedDb);await restartedDb.open();
    const restarted=fresh.createStage(restartedDb,{clock:()=>100,limits:{frameBytes:MAX_FRAME_BYTES,ttlMs:1000,receiptTtlMs:10000}});
    const restartedBridge=trackedBridge(restarted,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false});
    const second=new MockPort();expect(restartedBridge.attach(second)).toBe(true);
    expect(await second.request(5,{action:'resume',capability:cap})).toMatchObject({ok:true,data:{state:'committed',result:{inserted:1}}});
    expect(await second.request(6,{action:'commit'})).toMatchObject({ok:true,data:{inserted:1}});expect(await h.repo.list()).toHaveLength(1);expect(changed).toHaveBeenCalledOnce();
    second.disconnect();const third=new MockPort();expect(restartedBridge.attach(third)).toBe(true);
    expect(await third.request(7,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000})).toMatchObject({ok:true,data:{state:'committed',result:{inserted:1}}});
    await third.request(8,{action:'acknowledge'});third.disconnect();
  });
  it('closes on a flooded busy port without queuing replies and can reconnect safely',async()=>{
    const block=deferred(),started=deferred(),h=harness('json',()=>{started.resolve();return block.promise;}),cap=createImportCapability(),{manifest,frame}=frames();
    await h.port.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});
    h.port.emit({id:2,action:'append',frame});await started.promise;
    for(let id=3;id<10003;id++)h.port.emit({id,action:'status'});
    expect(h.port.disconnected).toBe(true);expect(h.port.output).toHaveLength(1);expect(h.bridge.activePorts).toBe(0);
    block.resolve();const recovered=new MockPort();expect(h.bridge.attach(recovered)).toBe(true);
    expect(await recovered.request(1,{action:'resume',capability:cap})).toMatchObject({ok:true,data:{state:'open',nextSeq:0}});
    recovered.disconnect();
  });
  it('preserves the actual reading and writing listeners in a shared onConnect fanout',async()=>{
    const {bridge,port}=harness();
    const reading=new MockPort();reading.name='fluentReadHarnessStream';
    const readingHandler={handle:vi.fn(async()=>({success:true,text:'read',model:'m',service:'s'}))};
    expect(bridge.attach(reading)).toBe(false);attachReadingStreamPort(reading,readingHandler as any);
    reading.emit({requestId:'read-1'});await vi.waitFor(()=>expect(reading.output).toContainEqual(expect.objectContaining({type:'result',requestId:'read-1'})));
    expect(readingHandler.handle).toHaveBeenCalledOnce();expect(reading.disconnected).toBe(true);
    const writing=new MockPort();writing.name='fluentReadWritingStream';
    const run=vi.fn(async()=>({success:true as const,text:'write',service:'s',model:'m'}));
    const writer=createWritingHandler({extensionId:'fixture',optionsUrl:'chrome-extension://fixture/options.html',ready:Promise.resolve(),eligibility:()=>undefined,run});
    expect(bridge.attach(writing)).toBe(false);writer.connect(writing);
    writing.emit({type:'fluentReadWriting',action:'run',requestId:'write-1',intent:'draft',instruction:'Write',draft:'',context:'',language:'en',tone:'natural',history:[]});
    await vi.waitFor(()=>expect(writing.output).toContainEqual(expect.objectContaining({type:'result',requestId:'write-1',response:expect.objectContaining({success:true,text:'write'})})));
    expect(run).toHaveBeenCalledOnce();writing.disconnect();expect(bridge.activePorts).toBe(1);port.disconnect();
  });
  it('reclaims only idle ports and allows capability-based reconnect',async()=>{
    vi.useFakeTimers();
    try{
      const {stage,port:original}=harness(),cap=createImportCapability(),manifest=emptyManifest();original.disconnect();
      const bridge=trackedBridge(stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,maxPorts:1,idleTimeoutMs:100});
      const idle=new MockPort(),rejected=new MockPort();expect(bridge.attach(idle)).toBe(true);expect(bridge.attach(rejected)).toBe(false);
      await vi.advanceTimersByTimeAsync(99);expect(idle.disconnected).toBe(false);await vi.advanceTimersByTimeAsync(1);
      expect(idle.disconnected).toBe(true);expect(bridge.activePorts).toBe(0);const replacement=new MockPort();expect(bridge.attach(replacement)).toBe(true);replacement.disconnect();
      // Held operation outlives the idle window, and is not aborted merely for
      // being slow; once it returns, the next idle window releases the port.
      const started=deferred(),release=deferred();
      const stub={...stage,beginRecoverable:async()=>{started.resolve();await release.promise;return cap;},status:async()=>({state:'open',nextSeq:0})};
      const busyBridge=trackedBridge(stub,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,idleTimeoutMs:100});
      const busy=new MockPort();expect(busyBridge.attach(busy)).toBe(true);
      const pending=busy.request(1,{action:'begin',capability:cap,manifest,guard:{generation:0,capturedAt:100},deadline:1000});await started.promise;
      await vi.advanceTimersByTimeAsync(500);expect(busy.disconnected).toBe(false);release.resolve();expect(await pending).toMatchObject({ok:true});
      await vi.advanceTimersByTimeAsync(100);expect(busy.disconnected).toBe(true);expect(busyBridge.activePorts).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it('reconnects using the same capability after an idle timeout',async()=>{
    const h=harness(),cap=createImportCapability();h.port.disconnect();
    const bridge=trackedBridge(h.stage,{isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false,idleTimeoutMs:60});
    const first=new MockPort();expect(bridge.attach(first)).toBe(true);
    expect(await first.request(1,{action:'begin',capability:cap,manifest:emptyManifest(),guard:{generation:0,capturedAt:100},deadline:1000})).toMatchObject({ok:true,data:{state:'open',nextSeq:0}});
    await vi.waitFor(()=>expect(first.disconnected).toBe(true),{timeout:1000,interval:10});
    const second=new MockPort();expect(bridge.attach(second)).toBe(true);
    expect(await second.request(1,{action:'resume',capability:cap})).toMatchObject({ok:true,data:{state:'open',nextSeq:0}});
    second.disconnect();
  });
  it('rejects invalid bridge limits and closes when the response cannot be delivered',async()=>{
    const h=harness();const options={isTrustedSender:trustSender,onCommitted:()=>{},isPrivateContext:()=>false};
    expect(()=>trackedBridge(h.stage,{...options,idleTimeoutMs:0})).toThrow('invalid bridge limits');
    expect(()=>trackedBridge(h.stage,{...options,idleTimeoutMs:2_147_483_648})).toThrow('invalid bridge limits');
    expect(()=>trackedBridge(h.stage,{...options,maxPorts:0})).toThrow('invalid bridge limits');
    const failing=new MockPort();expect(h.bridge.attach(failing)).toBe(true);
    vi.spyOn(failing,'postMessage').mockImplementation(()=>{throw Error('delivery failed');});
    failing.emit({id:1,action:'status'});
    await vi.waitFor(()=>expect(failing.disconnected).toBe(true));expect(h.bridge.activePorts).toBe(1);h.port.disconnect();
  });
  it('closes on invalid request IDs without sending repeatable error responses',()=>{
    const {port,bridge}=harness();port.emit({id:null,action:'unknown'});
    for(let i=0;i<10000;i++)port.emit({id:null,action:'unknown'});
    expect(port.disconnected).toBe(true);expect(port.output).toHaveLength(0);expect(bridge.activePorts).toBe(0);
  });
  it('disconnects malformed messages while retaining operation errors for valid requests',async()=>{
    const {port,bridge}=harness();port.emit({id:1,action:'resume',capability:{id:'bad',token:'x'}});
    expect(port.disconnected).toBe(true);expect(port.output).toHaveLength(0);
    const second=new MockPort();expect(bridge.attach(second)).toBe(true);
    const cap=createImportCapability();await second.request(1,{action:'begin',capability:cap,manifest:emptyManifest(),guard:{generation:0,capturedAt:100},deadline:1000});
    expect(await second.request(2,{action:'acknowledge'})).toMatchObject({ok:false});
    second.emit({id:3,action:'append',frame:{seq:0,record:0,part:0,total:1,recordBytes:1,bytes:new Uint8Array([1])}});
    expect(second.disconnected).toBe(true);expect(second.output).toHaveLength(2);
  });
});

describe('material import Port client',()=>{
  class ClientPort {
    onMessage=new EventHub<(value:unknown)=>void>();
    onDisconnect=new EventHub<()=>void>();
    sent:unknown[]=[];closed=false;
    postMessage(value:unknown){if(this.closed)throw Error('closed');this.sent.push(structuredClone(value));}
    disconnect(){if(this.closed)return;this.closed=true;this.onDisconnect.emit();}
  }
  it.each(['onMessage','onDisconnect'] as const)('cleans partial client listener registration when %s throws',async which=>{
    const {createMaterialImportPortClient}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),hub=port[which] as EventHub<(value:unknown)=>void>,add=hub.addListener;
    vi.spyOn(hub,'addListener').mockImplementation(listener=>{add(listener);throw Error('registration failed');});
    expect(()=>createMaterialImportPortClient(port)).toThrow('registration failed');
    expect(port.closed).toBe(true);expect(port.onMessage.listeners.size).toBe(0);expect(port.onDisconnect.listeners.size).toBe(0);
  });
  it.each(['onMessage','onDisconnect'] as const)('closes cleanly when disconnect fires during %s registration',async which=>{
    const {createMaterialImportPortClient,MaterialImportPortDisconnectedError}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),hub=port[which] as EventHub<(value:unknown)=>void>,add=hub.addListener;
    vi.spyOn(hub,'addListener').mockImplementation(listener=>{add(listener);port.disconnect();});
    const client=createMaterialImportPortClient(port);
    expect(port.onMessage.listeners.size).toBe(0);expect(port.onDisconnect.listeners.size).toBe(0);
    await expect(client.status()).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);
    expect(port.onMessage.listeners.size).toBe(0);expect(port.onDisconnect.listeners.size).toBe(0);
  });
  it.each(['onMessage','onDisconnect'] as const)('removes late listeners when %s disconnects and then registration throws',async which=>{
    const {createMaterialImportPortClient}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),hub=port[which] as EventHub<(value:unknown)=>void>,add=hub.addListener;
    vi.spyOn(hub,'addListener').mockImplementation(listener=>{
      if(which==='onDisconnect')listener(undefined);else port.disconnect();
      add(listener);throw Error('registration failed');
    });
    expect(()=>createMaterialImportPortClient(port)).toThrow('registration failed');
    expect(port.closed).toBe(true);expect(port.onMessage.listeners.size).toBe(0);expect(port.onDisconnect.listeners.size).toBe(0);
  });
  it('rejects an in-flight request even when one listener cannot be removed',async()=>{
    const {createMaterialImportPortClient,MaterialImportPortDisconnectedError}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),client=createMaterialImportPortClient(port);
    const pending=client.commit();vi.spyOn(port.onMessage,'removeListener').mockImplementation(()=>{throw Error('removed externally');});
    port.disconnect();await expect(pending).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);
    expect(port.onDisconnect.listeners.size).toBe(0);
  });
  it('snapshots only protocol data and bounds binary frame encoding',async()=>{
    const {createMaterialImportPortClient}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),client=createMaterialImportPortClient(port),cap=createImportCapability();
    const pending=client.begin({...cap,secret:'do not send'} as typeof cap,{...emptyManifest(),extra:'do not send'} as ReturnType<typeof emptyManifest>,{generation:0,capturedAt:100},1000);
    expect(port.sent).toEqual([{id:1,action:'begin',capability:cap,manifest:emptyManifest(),guard:{generation:0,capturedAt:100},deadline:1000}]);
    port.onMessage.emit({id:1,ok:true,data:{state:'open',nextSeq:0}});expect(await pending).toEqual({state:'open',nextSeq:0});
    const backing=new Uint8Array([7,8,9,10]);const next=client.append({seq:0,record:0,part:0,total:1,recordBytes:2,bytes:backing.subarray(1,3)});
    expect(port.sent[1]).toEqual({id:2,action:'append',frame:{seq:0,record:0,part:0,total:1,recordBytes:2,base64:'CAk='}});
    backing[1]=0;port.onMessage.emit({id:2,ok:true,data:{nextSeq:1}});expect(await next).toEqual({nextSeq:1});
    await expect(client.append({seq:0,record:0,part:0,total:1,recordBytes:1,bytes:new Uint8Array(MAX_FRAME_BYTES+1)})).rejects.toThrow('材料恢复分片无效');
    client.close();expect(port.closed).toBe(true);
  });
  it('never queues concurrent requests and treats a disconnect during commit as an unknown outcome',async()=>{
    const {createMaterialImportPortClient,MaterialImportPortDisconnectedError}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),client=createMaterialImportPortClient(port);
    const commit=client.commit();await expect(client.status()).rejects.toThrow('材料恢复请求尚未完成');expect(port.sent).toEqual([{id:1,action:'commit'}]);
    port.disconnect();await expect(commit).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);
    await expect(client.status()).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);
    expect(port.onMessage.listeners.size).toBe(0);expect(port.onDisconnect.listeners.size).toBe(0);
  });
  it('closes on misassociated responses and propagates the sanitized failure',async()=>{
    const {createMaterialImportPortClient,MaterialImportPortDisconnectedError}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort(),client=createMaterialImportPortClient(port);
    const failed=client.status();port.onMessage.emit({id:1,ok:false,error:'PRIVATE_FIXTURE'});
    await expect(failed).rejects.toThrow('材料恢复操作失败，请查询当前会话后重试。');
    const waiting=client.status();port.onMessage.emit({id:1,ok:true,data:{state:'sealed'}});
    await expect(waiting).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);expect(port.closed).toBe(true);
  });
  it('runs a JSON-serialized client and bridge against the real stage and sends one commit notification',async()=>{
    const {createMaterialImportPortClient}=await import('@/src/features/vocabulary/materialImportPortClient');
    const h=harness(),changed=vi.fn(),bridge=trackedBridge(h.stage,{isTrustedSender:trustSender,onCommitted:changed,isPrivateContext:()=>false});
    const server=new MockPort('json'),clientPort=new ClientPort(),closeClient=clientPort.disconnect.bind(clientPort);
    clientPort.postMessage=(value:unknown)=>{clientPort.sent.push(structuredClone(value));server.emit(value);};
    clientPort.disconnect=()=>{closeClient();server.disconnect();};
    server.onDisconnect.addListener(()=>closeClient());
    server.postMessage=(value:unknown)=>clientPort.onMessage.emit(JSON.parse(JSON.stringify(value)));
    expect(bridge.attach(server)).toBe(true);const client=createMaterialImportPortClient(clientPort),cap=createImportCapability();
    expect(await client.begin(cap,emptyManifest(),{generation:0,capturedAt:100},1000)).toEqual({state:'open',nextSeq:0});
    expect(await client.seal()).toEqual({state:'sealed'});expect(await client.commit()).toEqual({inserted:0,updated:0,skipped:0});
    expect(changed).toHaveBeenCalledOnce();expect(await client.commit()).toEqual({inserted:0,updated:0,skipped:0});expect(changed).toHaveBeenCalledOnce();
    client.close();bridge.dispose();h.bridge.dispose();h.port.disconnect();
  });
  it('reports a send failure as disconnected without automatically retrying',async()=>{
    const {createMaterialImportPortClient,MaterialImportPortDisconnectedError}=await import('@/src/features/vocabulary/materialImportPortClient');
    const port=new ClientPort();vi.spyOn(port,'postMessage').mockImplementation(()=>{throw Error('sensitive');});const client=createMaterialImportPortClient(port);
    await expect(client.commit()).rejects.toBeInstanceOf(MaterialImportPortDisconnectedError);expect(port.closed).toBe(true);expect(port.postMessage).toHaveBeenCalledOnce();
  });
});
