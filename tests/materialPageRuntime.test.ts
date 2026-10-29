import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {describe,expect,it,vi} from 'vitest';
import browser from 'webextension-polyfill';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {installBrowserMaterialPageRuntime,installMaterialPageRuntime} from '@/src/app/background/materialPageRuntime';
import {MATERIAL_PAGE_PORT_NAME} from '@/src/features/vocabulary/materialPageProtocol';
import {receiveMaterialRead,type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';

vi.mock('webextension-polyfill',()=>({default:{}}));
type Fn=(...args:any[])=>void;
class Events<T extends Fn>{listeners=new Set<T>();addListener(fn:T){this.listeners.add(fn);}removeListener(fn:T){this.listeners.delete(fn);}fire(...args:Parameters<T>){for(const fn of [...this.listeners])fn(...args);}}
class Port{
    name=MATERIAL_PAGE_PORT_NAME;sender={id:'fixture',url:'chrome-extension://fixture/options.html'};
    onMessage=new Events<(value:unknown)=>void>();onDisconnect=new Events<()=>void>();peer!:Port;closed=false;
    postMessage(value:unknown){if(this.closed)throw Error('closed');this.peer.onMessage.fire(value);}
    disconnect(){if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.fire();this.peer.onDisconnect.fire();}
}
const pair=()=>{const server=new Port(),client=new Port();server.peer=client;client.peer=server;return [server,client] as const;};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture(){
    const onConnect=new Events<(port:Port)=>void>(),runtime={id:'fixture',getURL:(path:string)=>`chrome-extension://fixture/${path.replace(/^\//u,'')}`,onConnect};
    const repository={db:{close:vi.fn()},openSnapshot:vi.fn(async()=>({revision:1,ids:[] as string[]})),readSnapshotRecord:vi.fn(async()=>null),checkSnapshot:vi.fn(async()=>{})};
    const createRepository=vi.fn(()=>repository),isPrivateContext=vi.fn(()=>false);
    return {runtime,repository,createRepository,isPrivateContext,options:{runtime,createRepository,isPrivateContext,ready:Promise.resolve()}};
}

describe('material page background runtime',()=>{
    it('does not start a repository read when disposal reenters snapshot revision access',async()=>{
        const f=fixture();let dispose!:()=>Promise<void>,stopping!:Promise<void>;
        f.repository.openSnapshot.mockResolvedValueOnce({ids:['id'],get revision(){stopping=dispose();return 1;}});
        dispose=installMaterialPageRuntime(f.options as never);
        try {
            const [server,client]=pair();f.runtime.onConnect.fire(server);
            const reading=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
            client.postMessage({v:1,type:'start',operation:'open',options:{}});
            expect(await reading).toBeInstanceOf(Error);await stopping;
            expect(f.repository.readSnapshotRecord).not.toHaveBeenCalled();expect(f.repository.db.close).toHaveBeenCalledOnce();
            expect(f.runtime.onConnect.listeners.size).toBe(0);
        } finally {await dispose();}
    });
    it('removes a partially installed listener when registering it fails, and can reinstall',async()=>{
        const f=fixture(),add=f.runtime.onConnect.addListener.bind(f.runtime.onConnect),failure=Error('listener registration failed');
        f.runtime.onConnect.addListener=fn=>{add(fn);throw failure;};
        expect(()=>installMaterialPageRuntime(f.options as never)).toThrow(failure);
        await tick();expect(f.runtime.onConnect.listeners.size).toBe(0);
        f.runtime.onConnect.addListener=add;
        const dispose=installMaterialPageRuntime(f.options as never);
        expect(f.runtime.onConnect.listeners.size).toBe(1);await dispose();
        expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('installs once without opening storage and ignores unrelated or untrusted ports',async()=>{
        const f=fixture(),dispose=installMaterialPageRuntime(f.options as never);
        expect(installMaterialPageRuntime(f.options as never)).toBe(dispose);expect(f.runtime.onConnect.listeners.size).toBe(1);
        const [unrelated]=pair();unrelated.name='unrelated';f.runtime.onConnect.fire(unrelated);expect(unrelated.closed).toBe(false);
        const [untrusted]=pair();untrusted.sender.url='https://example.test/options.html';f.runtime.onConnect.fire(untrusted);
        expect(untrusted.closed).toBe(true);expect(f.createRepository).not.toHaveBeenCalled();await dispose();
        expect(f.runtime.onConnect.listeners.size).toBe(0);expect(f.repository.db.close).not.toHaveBeenCalled();
    });
    it('constructs the repository only after a trusted handshake and closes it on disposal',async()=>{
        const f=fixture(),dispose=installMaterialPageRuntime(f.options as never),[server,client]=pair();f.runtime.onConnect.fire(server);
        expect(f.createRepository).not.toHaveBeenCalled();const chunks:Uint8Array[]=[];
        const read=receiveMaterialRead(client as MaterialReadPort,value=>{chunks.push(value);});
        client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;await tick();
        expect(f.createRepository).toHaveBeenCalledOnce();expect(f.repository.openSnapshot).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])))).toContain('"type":"complete","count":0');
        await dispose();await dispose();expect(f.repository.db.close).toHaveBeenCalledOnce();expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('uses the lazily constructed repository to read each record for the query and page',async()=>{
        const f=fixture();f.repository.openSnapshot.mockResolvedValue({revision:1,ids:['one']});
        f.repository.readSnapshotRecord.mockResolvedValue({id:'one',identityKey:'article:https://example.test/',kind:'article',title:'one',
            source:{kind:'article',url:'https://example.test/'},topics:[],references:[],createdAt:1,updatedAt:1,lastReadAt:1,archivedAt:null} as never);
        const dispose=installMaterialPageRuntime(f.options as never),[server,client]=pair();f.runtime.onConnect.fire(server);
        const chunks:Uint8Array[]=[];const read=receiveMaterialRead(client as MaterialReadPort,value=>{chunks.push(value);});
        client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;await tick();
        expect(f.repository.readSnapshotRecord).toHaveBeenCalledTimes(2);
        expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])))).toContain('"count":1');await dispose();
    });
    it('fails closed for incognito and readiness failures without constructing storage',async()=>{
        const f=fixture();f.isPrivateContext.mockReturnValue(true);let dispose=installMaterialPageRuntime(f.options as never),[server]=pair();
        f.runtime.onConnect.fire(server);expect(server.closed).toBe(true);expect(f.createRepository).not.toHaveBeenCalled();await dispose();
        f.isPrivateContext.mockReturnValue(false);dispose=installMaterialPageRuntime({...f.options,ready:Promise.reject(Error('private'))} as never);
        const [next,client]=pair();f.runtime.onConnect.fire(next);client.postMessage({v:1,type:'start',operation:'open',options:{}});await tick();
        expect(next.closed).toBe(true);expect(f.createRepository).not.toHaveBeenCalled();await dispose();
    });
    it('closes a repository created while disposal reenters its factory',async()=>{
        const f=fixture();let dispose!:()=>Promise<void>;
        f.createRepository.mockImplementation(()=>{dispose();return f.repository;});
        dispose=installMaterialPageRuntime(f.options as never);const [server,client]=pair();f.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage({v:1,type:'start',operation:'open',options:{}});expect(await read).toBeInstanceOf(Error);
        await dispose();expect(f.repository.db.close).toHaveBeenCalledOnce();expect(f.repository.openSnapshot).not.toHaveBeenCalled();
        expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('retains ownership when closing a repository created during disposal fails',async()=>{
        const f=fixture();let dispose!:()=>Promise<void>,stopping!:Promise<void>;const failure=Error('close failed');f.repository.db.close.mockImplementationOnce(()=>{throw failure;});
        f.createRepository.mockImplementation(()=>{stopping=dispose();return f.repository;});
        dispose=installMaterialPageRuntime(f.options as never);const [server,client]=pair();f.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);client.postMessage({v:1,type:'start',operation:'open',options:{}});
        expect(await read).toBeInstanceOf(Error);await expect(stopping).rejects.toBe(failure);expect(f.repository.db.close).toHaveBeenCalledOnce();
        const fresh=installMaterialPageRuntime(f.options as never);expect(f.repository.db.close).toHaveBeenCalledTimes(2);await fresh();
    });
    it('installs the browser runtime and creates the real repository only for a trusted read',async()=>{
        const f=fixture();Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false}});
        const legacy=vi.spyOn(vocabularyBook,'list').mockResolvedValue([]);
        installBrowserMaterialPageRuntime(Promise.resolve());
        const dispose=installMaterialPageRuntime(f.options as never);
        try{
            const [server,client]=pair();f.runtime.onConnect.fire(server);const chunks:Uint8Array[]=[];
            const read=receiveMaterialRead(client as MaterialReadPort,value=>{chunks.push(value);});
            client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;await tick();
            expect(legacy).toHaveBeenCalledOnce();
            expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])))).toContain('"type":"complete","count":0');
        }finally{await dispose();legacy.mockRestore();await Dexie.delete('FluentReadMaterials');}
    });
    it('waits for a cancelled underlying read before closing the database or permitting reinstall',async()=>{
        const f=fixture();let finish!:(snapshot:{revision:number;ids:string[]})=>void,began!:()=>void;
        const held=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        f.repository.openSnapshot.mockImplementationOnce(async()=>{began();return held;});
        const dispose=installMaterialPageRuntime(f.options as never),[server,client]=pair();f.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage({v:1,type:'start',operation:'open',options:{}});await started;
        let settled=false;const draining=dispose().then(()=>{settled=true;});await tick();
        expect(await read).toBeInstanceOf(Error);expect(settled).toBe(false);expect(f.repository.db.close).not.toHaveBeenCalled();
        expect(installMaterialPageRuntime(f.options as never)).toBe(dispose);expect(f.runtime.onConnect.listeners.size).toBe(0);
        finish({revision:1,ids:[]});await draining;expect(settled).toBe(true);expect(f.repository.db.close).toHaveBeenCalledOnce();
        const next=installMaterialPageRuntime(f.options as never);expect(next).not.toBe(dispose);await next();
    });
    it('reports listener removal and database cleanup failures after draining',async()=>{
        const f=fixture();let dispose=installMaterialPageRuntime(f.options as never);
        const remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect),failure=Error('listener unavailable');
        f.runtime.onConnect.removeListener=fn=>{remove(fn);throw failure;};
        await expect(dispose()).rejects.toBe(failure);
        f.runtime.onConnect.removeListener=remove;
        dispose=installMaterialPageRuntime(f.options as never);await dispose();
        const other=fixture(),stop=installMaterialPageRuntime(other.options as never),[server,client]=pair();other.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{});client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;await tick();
        const closeFailure=Error('database close failed');other.repository.db.close.mockImplementationOnce(()=>{throw closeFailure;});
        await expect(stop()).rejects.toBe(closeFailure);
        const retry=installMaterialPageRuntime(other.options as never);expect(retry).not.toBe(stop);expect(other.repository.db.close).toHaveBeenCalledTimes(2);await retry();
    });
    it('keeps the lease after removal fails and safely permits reinstall after a successful retry',async()=>{
        const f=fixture(),dispose=installMaterialPageRuntime(f.options as never);
        const remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect);
        const failure=Error('listener unavailable');f.runtime.onConnect.removeListener=()=>{throw failure;};
        await expect(dispose()).rejects.toBe(failure);expect(f.runtime.onConnect.listeners.size).toBe(1);
        expect(()=>installMaterialPageRuntime(f.options as never)).toThrow(failure);
        const [ignored]=pair();f.runtime.onConnect.fire(ignored);expect(ignored.closed).toBe(false);expect(f.createRepository).not.toHaveBeenCalled();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialPageRuntime(f.options as never);expect(fresh).not.toBe(dispose);expect(f.runtime.onConnect.listeners.size).toBe(1);
        const [server,client]=pair();f.runtime.onConnect.fire(server);
        const chunks:Uint8Array[]=[];const read=receiveMaterialRead(client as MaterialReadPort,value=>{chunks.push(value);});
        client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;
        expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])))).toContain('"type":"complete","count":0');
        await fresh();
    });
    it('recovers a browser runtime after both listener registration and removal failed',async()=>{
        const f=fixture(),add=f.runtime.onConnect.addListener.bind(f.runtime.onConnect),remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect);
        const adding=Error('add failed'),removing=Error('remove failed');f.runtime.onConnect.addListener=fn=>{add(fn);throw adding;};f.runtime.onConnect.removeListener=()=>{throw removing;};
        Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false}});
        expect(()=>installBrowserMaterialPageRuntime(Promise.resolve())).toThrow(adding);await tick();expect(f.runtime.onConnect.listeners.size).toBe(1);
        expect(()=>installBrowserMaterialPageRuntime(Promise.resolve())).toThrow(removing);
        f.runtime.onConnect.addListener=add;f.runtime.onConnect.removeListener=remove;
        installBrowserMaterialPageRuntime(Promise.resolve());expect(f.runtime.onConnect.listeners.size).toBe(1);
        const stop=installMaterialPageRuntime(f.options as never);await stop();expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('does not reinstall a failed listener while its underlying read is draining',async()=>{
        const f=fixture();let finish!:(snapshot:{revision:number;ids:string[]})=>void,began!:()=>void;
        const held=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        f.repository.openSnapshot.mockImplementationOnce(async()=>{began();return held;});
        const stop=installMaterialPageRuntime(f.options as never),[server,client]=pair();f.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);client.postMessage({v:1,type:'start',operation:'open',options:{}});await started;
        const remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect),failure=Error('remove failed');f.runtime.onConnect.removeListener=()=>{throw failure;};
        const stopping=stop();void stopping.catch(()=>{});expect(()=>installMaterialPageRuntime(f.options as never)).toThrow('等待未完成读取');expect(f.repository.db.close).not.toHaveBeenCalled();expect(await read).toBeInstanceOf(Error);
        finish({revision:1,ids:[]});await expect(stopping).rejects.toBe(failure);expect(f.repository.db.close).toHaveBeenCalledOnce();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialPageRuntime(f.options as never);expect(f.runtime.onConnect.listeners.size).toBe(1);await fresh();
    });
    it('retries both listener removal and database close before reinstalling',async()=>{
        const f=fixture(),stop=installMaterialPageRuntime(f.options as never),[server,client]=pair();f.runtime.onConnect.fire(server);
        const read=receiveMaterialRead(client as MaterialReadPort,()=>{});client.postMessage({v:1,type:'start',operation:'open',options:{}});await read;await tick();
        const remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect),removeError=Error('remove failed'),closeError=Error('close failed');
        f.runtime.onConnect.removeListener=()=>{throw removeError;};f.repository.db.close.mockImplementationOnce(()=>{throw closeError;});
        await expect(stop()).rejects.toBe(closeError);expect(()=>installMaterialPageRuntime(f.options as never)).toThrow(removeError);expect(f.repository.db.close).toHaveBeenCalledOnce();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialPageRuntime(f.options as never);expect(f.repository.db.close).toHaveBeenCalledTimes(2);expect(f.runtime.onConnect.listeners.size).toBe(1);await fresh();
    });
});
