import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({connect:vi.fn()}));
vi.mock('webextension-polyfill',()=>({default:{runtime:{connect:mocks.connect},extension:{inIncognitoContext:false}}}));

import {restoreLargeMaterialBackup} from '@/src/features/vocabulary/materialBackupRestore';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {makePortBridge,PORT_NAME,type MaterialImportPort} from '@/src/features/vocabulary/materialImportPort';
import {MaterialDatabase} from '@/src/features/vocabulary/materialRepository';

class Events<T extends (...args:any[])=>void> {
  listeners=new Set<T>();
  addListener(listener:T){this.listeners.add(listener);}
  removeListener(listener:T){this.listeners.delete(listener);}
  emit(...args:Parameters<T>){for(const listener of [...this.listeners])listener(...args);}
}
class Port implements MaterialImportPort {
  name=PORT_NAME;sender={id:'fixture',url:'chrome-extension://fixture/options.html'};
  onMessage=new Events<(message:unknown)=>void>();onDisconnect=new Events<()=>void>();
  peer!:Port;closed=false;beforeSend?:(message:unknown)=>void;
  postMessage(message:unknown){if(this.closed)throw Error('closed');const copy=structuredClone(message);this.beforeSend?.(copy);this.peer.onMessage.emit(copy);}
  disconnect(){if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.emit();this.peer.onDisconnect.emit();}
}

it('completes real framed restoration when observed work spans multiple idle windows',async()=>{
  const db=new MaterialDatabase(`material-progress-integration-${crypto.randomUUID()}`),stage=createStage(db),notify=vi.fn();
  const bridge=makePortBridge(stage,{isTrustedSender:sender=>sender?.id==='fixture',isPrivateContext:()=>false,onCommitted:notify});
  const server=new Port(),client=new Port();server.peer=client;client.peer=server;
  mocks.connect.mockImplementation(({name}:{name:string})=>{expect(name).toBe(PORT_NAME);expect(bridge.attach(server)).toBe(true);return client;});

  // Only 30-second idle timers use a virtual clock. IndexedDB, file reads,
  // transport messages and the actual transaction all run normally.
  const originalSet=globalThis.setTimeout.bind(globalThis),originalClear=globalThis.clearTimeout.bind(globalThis);
  const timers=new Map<object,{at:number;run:()=>void}>();let now=0,fired=0;
  const set=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:(...values:unknown[])=>void,ms?:number,...args:unknown[])=>{
    if(ms!==30_000)return originalSet(callback,ms,...args);
    const token={};timers.set(token,{at:now+ms,run:()=>callback(...args)});return token as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear=vi.spyOn(globalThis,'clearTimeout').mockImplementation(((handle:ReturnType<typeof setTimeout>)=>{
    if(timers.delete(handle as object))return;originalClear(handle);
  }) as typeof clearTimeout);
  const advance=(duration:number)=>{
    const end=now+duration;
    for(;;){const due=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;
      now=due[1].at;timers.delete(due[0]);fired++;due[1].run();}
    now=end;
  };
  const progress:Array<{done:number;total:number}>=[];
  server.beforeSend=message=>{
    if(!message||typeof message!=='object'||!('progress' in message))return;
    progress.push((message as {progress:{done:number;total:number}}).progress);
    advance(20_000);
  };
  const timestamp=Date.now(),record={id:'fixture',identityKey:'article:https://example.test/',kind:'article',source:{kind:'article',url:'https://example.test/'},title:'Fixture',topics:[],
    references:Array.from({length:20},(_,index)=>({kind:'note',id:`note-${index}`,note:'x'.repeat(12_000)})),createdAt:timestamp,updatedAt:timestamp,lastReadAt:timestamp,archivedAt:null};
  const file=new Blob([JSON.stringify({format:'fluentread-learning-materials',version:1,exportedAt:timestamp,materials:[record]})]);
  try {
    const result=await restoreLargeMaterialBackup(file,{generation:0,capturedAt:timestamp},{onCapability:()=>{}});
    expect(result).toMatchObject({kind:'committed',result:{inserted:1,updated:0,skipped:0}});
    expect(progress).toEqual([{done:1,total:2},{done:2,total:2},{done:1,total:2},{done:2,total:2}]);
    expect(now).toBe(80_000);expect(fired).toBe(0);expect(notify).toHaveBeenCalledOnce();
    const stored=await db.materials.get('fixture');expect(stored?.references).toHaveLength(20);
    expect(stored?.references[19].note).toBe('x'.repeat(12_000));
  } finally {
    bridge.dispose();client.disconnect();set.mockRestore();clear.mockRestore();await db.delete();mocks.connect.mockReset();
  }
});
