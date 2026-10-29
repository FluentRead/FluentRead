/**
 * @file tests/materialBackupExportRuntime.test.ts
 * 文件职责：验证材料导出后台监听的安装和关闭边界。
 * 主要内容：覆盖安装幂等、可信来源、监听登记失败和释放数据库连接。
 * 模块边界：使用浏览器运行时替身，不证明真实扩展或文件系统行为。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach,describe,expect,it,vi} from 'vitest';
import browser from 'webextension-polyfill';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {installBrowserMaterialBackupExportRuntime,installMaterialBackupExportRuntime} from '@/src/app/background/materialBackupExportRuntime';
import {MATERIAL_BACKUP_EXPORT_PORT_NAME} from '@/src/features/vocabulary/materialBackupExportProtocol';

vi.mock('webextension-polyfill',()=>({default:{}}));
vi.mock('@/src/features/vocabulary/repository',()=>({vocabularyBook:{list:vi.fn(async()=>[])}}));
type Fn=(...args:any[])=>void;
function event<T extends Fn>(){const listeners=new Set<T>();return {listeners,addListener(fn:T){listeners.add(fn);},removeListener(fn:T){listeners.delete(fn);},fire(...args:Parameters<T>){for(const fn of [...listeners])fn(...args);}};}
function fixture(){
    const runtime={id:'abc',getURL:(path:string)=>`chrome-extension://abc/${path.replace(/^\//u,'')}`,onConnect:event<(port:any)=>void>()};
    const close=vi.fn(),repository={db:{close},openSnapshot:vi.fn(async()=>({revision:0,ids:[] as string[]})),readSnapshotRecord:vi.fn(async()=>null),checkSnapshot:vi.fn(async()=>{})};
    const options={runtime,repository,ready:Promise.resolve(),isPrivateContext:()=>false};
    const port=(sender:unknown={id:'abc',url:'chrome-extension://abc/options.html'},name=MATERIAL_BACKUP_EXPORT_PORT_NAME)=>{
        const onDisconnect=event<()=>void>(),onMessage=event<(message:unknown)=>void>();
        const disconnect=vi.fn(()=>onDisconnect.fire());return {name,sender,onDisconnect,onMessage,postMessage:vi.fn(),disconnect};
    };
    return {runtime,repository,close,options,port};
}
afterEach(()=>vi.restoreAllMocks());

describe('material backup export runtime',()=>{
    it('installs once, rejects untrusted senders, and releases listeners and the database',async()=>{
        const f=fixture(),stop=installMaterialBackupExportRuntime(f.options as never);
        expect(installMaterialBackupExportRuntime(f.options as never)).toBe(stop);expect(f.runtime.onConnect.listeners.size).toBe(1);
        const other=f.port(undefined,'unrelated');f.runtime.onConnect.fire(other);expect(other.disconnect).not.toHaveBeenCalled();
        const denied=f.port({id:'abc',url:'https://example.test/options.html'});f.runtime.onConnect.fire(denied);expect(denied.disconnect).toHaveBeenCalledOnce();
        const accepted=f.port();f.runtime.onConnect.fire(accepted);expect(accepted.disconnect).not.toHaveBeenCalled();
        await stop();await stop();expect(accepted.disconnect).toHaveBeenCalledOnce();expect(f.runtime.onConnect.listeners.size).toBe(0);expect(f.close).toHaveBeenCalledOnce();
        expect(f.repository.openSnapshot).not.toHaveBeenCalled();
        const next=installMaterialBackupExportRuntime(f.options as never);expect(next).not.toBe(stop);await next();expect(f.close).toHaveBeenCalledTimes(2);
    });
    it('rejects private contexts before touching repository data',async()=>{
        const f=fixture(),stop=installMaterialBackupExportRuntime({...f.options,isPrivateContext:()=>true} as never),port=f.port();
        f.runtime.onConnect.fire(port);expect(port.disconnect).toHaveBeenCalledOnce();expect(f.repository.openSnapshot).not.toHaveBeenCalled();await stop();
    });
    it('releases partially registered resources while preserving registration errors',async()=>{
        const f=fixture(),failure=Error('registration failed'),add=f.runtime.onConnect.addListener.bind(f.runtime.onConnect);
        f.runtime.onConnect.addListener=listener=>{add(listener);throw failure;};
        expect(()=>installMaterialBackupExportRuntime(f.options as never)).toThrow(failure);
        expect(f.runtime.onConnect.listeners.size).toBe(0);await vi.waitFor(()=>expect(f.close).toHaveBeenCalledOnce());
    });
    it('retries a failed database close before installing another runtime',async()=>{
        const f=fixture(),stop=installMaterialBackupExportRuntime(f.options as never);f.close.mockImplementationOnce(()=>{throw Error('close failed');});
        await expect(stop()).rejects.toThrow('close failed');expect(f.runtime.onConnect.listeners.size).toBe(0);
        expect(f.close).toHaveBeenCalledOnce();const next=installMaterialBackupExportRuntime(f.options as never);expect(next).not.toBe(stop);expect(f.close).toHaveBeenCalledTimes(2);await next();expect(f.close).toHaveBeenCalledTimes(3);
    });
    it('retains an inert listener when removal fails and automatically cleans it on the next install',async()=>{
        const f=fixture(),stop=installMaterialBackupExportRuntime(f.options as never),remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect),failure=Error('listener removal failed');
        f.runtime.onConnect.removeListener=()=>{throw failure;};
        await expect(stop()).rejects.toBe(failure);expect(f.runtime.onConnect.listeners.size).toBe(1);expect(f.close).toHaveBeenCalledOnce();
        expect(()=>installMaterialBackupExportRuntime(f.options as never)).toThrow(failure);
        const port=f.port();f.runtime.onConnect.fire(port);expect(port.disconnect).not.toHaveBeenCalled();expect(f.repository.openSnapshot).not.toHaveBeenCalled();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialBackupExportRuntime(f.options as never);expect(fresh).not.toBe(stop);
        expect(f.runtime.onConnect.listeners.size).toBe(1);expect(f.close).toHaveBeenCalledOnce();await fresh();expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('recovers on the next browser installation when both add and removal failed',async()=>{
        const f=fixture(),add=f.runtime.onConnect.addListener.bind(f.runtime.onConnect),remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect);
        const adding=Error('add failed'),removing=Error('remove failed');
        f.runtime.onConnect.addListener=fn=>{add(fn);throw adding;};f.runtime.onConnect.removeListener=()=>{throw removing;};
        Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false}});
        expect(()=>installBrowserMaterialBackupExportRuntime(Promise.resolve())).toThrow(adding);
        await vi.waitFor(()=>expect(f.runtime.onConnect.listeners.size).toBe(1));await new Promise(resolve=>setTimeout(resolve,0));
        expect(()=>installBrowserMaterialBackupExportRuntime(Promise.resolve())).toThrow(removing);
        f.runtime.onConnect.addListener=add;f.runtime.onConnect.removeListener=remove;
        const stop=installBrowserMaterialBackupExportRuntime(Promise.resolve());expect(f.runtime.onConnect.listeners.size).toBe(1);
        const port=f.port();f.runtime.onConnect.fire(port);expect(port.disconnect).not.toHaveBeenCalled();await stop();expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('does not reinstall while a failed listener removal still has a draining read',async()=>{
        const f=fixture();let finish!:(value:{revision:number;ids:string[]})=>void,began!:()=>void;
        const pending=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        f.repository.openSnapshot.mockImplementationOnce(()=>{began();return pending;});
        const stop=installMaterialBackupExportRuntime(f.options as never),port=f.port();f.runtime.onConnect.fire(port);port.onMessage.fire({v:1,type:'start',operation:'export'});await started;
        const remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect),failure=Error('remove failed');f.runtime.onConnect.removeListener=()=>{throw failure;};
        const stopping=stop();void stopping.catch(()=>{});expect(()=>installMaterialBackupExportRuntime(f.options as never)).toThrow('等待未完成读取');expect(f.close).not.toHaveBeenCalled();
        finish({revision:0,ids:[]});await expect(stopping).rejects.toBe(failure);expect(f.close).toHaveBeenCalledOnce();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialBackupExportRuntime(f.options as never);expect(f.runtime.onConnect.listeners.size).toBe(1);await fresh();
    });
    it('retains cleanup ownership when listener removal and database close both fail',async()=>{
        const f=fixture(),stop=installMaterialBackupExportRuntime(f.options as never),remove=f.runtime.onConnect.removeListener.bind(f.runtime.onConnect);
        const closeError=Error('close failed'),removeError=Error('remove failed');f.close.mockImplementationOnce(()=>{throw closeError;});f.runtime.onConnect.removeListener=()=>{throw removeError;};
        await expect(stop()).rejects.toBe(closeError);expect(f.runtime.onConnect.listeners.size).toBe(1);
        expect(()=>installMaterialBackupExportRuntime(f.options as never)).toThrow(removeError);expect(f.close).toHaveBeenCalledOnce();
        f.runtime.onConnect.removeListener=remove;const fresh=installMaterialBackupExportRuntime(f.options as never);expect(f.close).toHaveBeenCalledTimes(2);expect(f.runtime.onConnect.listeners.size).toBe(1);await fresh();
    });
    it('keeps the repository and installation lease until a cancelled underlying read ends',async()=>{
        const f=fixture();let finish!:(value:{revision:number;ids:string[]})=>void,started!:()=>void;
        const pending=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
        f.repository.openSnapshot.mockImplementationOnce(()=>{started();return pending;});
        const stop=installMaterialBackupExportRuntime(f.options as never),port=f.port();f.runtime.onConnect.fire(port);
        port.onMessage.fire({v:1,type:'start',operation:'export'});await began;
        let closed=false;const stopping=stop().then(()=>{closed=true;});
        await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);expect(f.close).not.toHaveBeenCalled();
        expect(installMaterialBackupExportRuntime(f.options as never)).toBe(stop);
        finish({revision:0,ids:[]});await stopping;expect(f.close).toHaveBeenCalledOnce();
        const next=installMaterialBackupExportRuntime(f.options as never);expect(next).not.toBe(stop);await next();
    });
    it('assembles the browser entry without opening storage before a trusted request',async()=>{
        const f=fixture();Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false}});
        const stop=installBrowserMaterialBackupExportRuntime(Promise.resolve());
        expect(installBrowserMaterialBackupExportRuntime(Promise.resolve())).toBe(stop);expect(f.runtime.onConnect.listeners.size).toBe(1);
        const denied=f.port({id:'wrong',url:'chrome-extension://abc/options.html'});f.runtime.onConnect.fire(denied);expect(denied.disconnect).toHaveBeenCalledOnce();
        await stop();expect(f.runtime.onConnect.listeners.size).toBe(0);
    });
    it('loads the legacy vocabulary only when a trusted export actually opens its snapshot',async()=>{
        await Dexie.delete('FluentReadMaterials');vi.mocked(vocabularyBook.list).mockClear();
        const f=fixture();Object.assign(browser,{runtime:f.runtime,extension:{inIncognitoContext:false}});
        const stop=installBrowserMaterialBackupExportRuntime(Promise.resolve());
        try {
            const port=f.port();f.runtime.onConnect.fire(port);expect(vocabularyBook.list).not.toHaveBeenCalled();
            port.onMessage.fire({v:1,type:'start',operation:'export'});
            await vi.waitFor(()=>expect(vocabularyBook.list).toHaveBeenCalledWith({order:'recent'}));
        } finally {await stop();await Dexie.delete('FluentReadMaterials');}
    });
});
