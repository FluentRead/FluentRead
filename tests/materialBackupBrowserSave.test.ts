import {afterEach,describe,expect,it,vi} from 'vitest';
const browserMock=vi.hoisted(()=>({permissions:{request:vi.fn()},extension:{inIncognitoContext:false},tabs:{getCurrent:vi.fn(async()=>({incognito:false}))},downloads:undefined as unknown}));
vi.mock('webextension-polyfill',()=>({default:browserMock}));
import {beginFirefoxMaterialBackup,beginFirefoxRecoveredMaterialBackup,beginMaterialBrowserBackup,beginRecoveredMaterialBackup,createMaterialBrowserOpfsPlatform,listFirefoxMaterialBackupLeftovers,listMaterialBackupLeftovers,prepareFirefoxMaterialBackupContext,removeFirefoxMaterialBackupLeftover,removeMaterialBackupLeftover,startObservedMaterialDownload,type MaterialBrowserBackupEnvironment,type MaterialBrowserDownloads} from '@/src/features/vocabulary/materialBackupBrowserSave';
import {saveMaterialBackup} from '@/src/features/vocabulary/materialBackupSave';

const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function downloads(){
    const changed=new Set<(event:{id:number;state?:{current?:string}})=>void>(),erased=new Set<(id:number)=>void>();
    const api:MaterialBrowserDownloads={download:vi.fn(async()=>7),search:vi.fn(async()=>[{id:7,state:'in_progress'}]),cancel:vi.fn(async()=>{}),onChanged:{addListener:listener=>{changed.add(listener);},removeListener:listener=>{changed.delete(listener);}},onErased:{addListener:listener=>{erased.add(listener);},removeListener:listener=>{erased.delete(listener);}}};
    return {api,changed,erased,emit:(id:number,state:string)=>changed.forEach(listener=>listener({id,state:{current:state}})),erase:(id:number)=>erased.forEach(listener=>listener(id))};
}
function filesystem(){
    const files=new Map<string,Uint8Array[]>(),deleted:string[]=[];let held=0;
    const dir={getFileHandle:vi.fn(async(name:string,options?:{create?:boolean})=>{
        if(!files.has(name)){if(!options?.create)throw new DOMException('missing','NotFoundError');files.set(name,[]);}
        return {createWritable:async()=>({write:async(chunk:Uint8Array|string)=>{files.get(name)!.push(typeof chunk==='string'?new TextEncoder().encode(chunk):chunk.slice());},close:async()=>{},abort:async()=>{files.set(name,[]);}}),getFile:async()=>new Blob(files.get(name))};
    }),removeEntry:vi.fn(async(name:string)=>{if(!files.has(name))throw new DOMException('missing','NotFoundError');files.delete(name);deleted.push(name);}),async *values(){for(const name of files.keys())yield {kind:'file',name};}};
    const names=new Set<string>();
    const root={getDirectoryHandle:async()=>dir},locks={request:async(name:string,_options:unknown,callback:(lock:unknown)=>Promise<void>)=>{
        if(names.has(name)){await callback(null);return;}names.add(name);held++;try{await callback({name});}finally{held--;names.delete(name);}
    }};
    return {files,deleted,dir,root,locks,get held(){return held;}};
}
function fixture(){
    const d=downloads(),fs=filesystem(),permission=vi.fn(async()=>true),urls:Blob[]=[];
    const env:MaterialBrowserBackupEnvironment={requestPermission:permission,directory:async()=>fs.root as unknown as FileSystemDirectoryHandle,locks:fs.locks as unknown as LockManager,downloads:d.api,randomId:()=> 'a'.repeat(32),now:()=>1700000000000,objectURL:file=>{urls.push(file);return 'blob:test';},revokeURL:vi.fn()};
    return {d,fs,permission,urls,env};
}
afterEach(async()=>{vi.stubEnv('BROWSER','firefox');browserMock.extension.inIncognitoContext=true;await prepareFirefoxMaterialBackupContext();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();browserMock.extension.inIncognitoContext=false;browserMock.tabs.getCurrent.mockReset().mockResolvedValue({incognito:false});Object.defineProperty(browserMock,'downloads',{configurable:true,writable:true,value:undefined});});
describe('browser material backup target',()=>{
    it('requests permission synchronously before any caller can await',async()=>{
        const f=fixture(),gate=deferred<boolean>();f.permission.mockReturnValueOnce(gate.promise);
        const choice=beginMaterialBrowserBackup('backup.json',f.env);expect(f.permission).toHaveBeenCalledOnce();expect(f.fs.files.size).toBe(0);
        gate.resolve(false);expect(await choice).toEqual({status:'denied'});expect(f.fs.files.size).toBe(0);
    });
    it('does not access the Firefox downloads API before optional permission is granted',async()=>{
        const f=fixture(),gate=deferred<boolean>();f.permission.mockReturnValueOnce(gate.promise);let granted=false,reads=0;
        Object.defineProperty(f.env,'downloads',{get(){reads++;if(!granted)throw Error('not granted');return f.d.api;}});
        const choice=beginMaterialBrowserBackup('backup.json',f.env);expect(reads).toBe(0);granted=true;gate.resolve(true);
        const result=await choice;expect(result.status).toBe('ready');expect(reads).toBe(1);if(result.status==='ready')await result.target.abort();
    });
    it('writes bounded chunks to OPFS and removes them only after the browser confirms completion',async()=>{
        const f=fixture(),choice=await beginMaterialBrowserBackup('backup.json',f.env);expect(choice.status).toBe('ready');if(choice.status!=='ready')return;
        const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1,2]));await consume(new Uint8Array([3]));});await tick();
        expect(f.fs.files.size).toBe(2);expect(f.d.api.download).toHaveBeenCalledWith({url:'blob:test',filename:'backup.json'});expect([...new Uint8Array(await f.urls[0].arrayBuffer())]).toEqual([1,2,3]);expect(f.fs.deleted).toHaveLength(0);
        f.d.emit(7,'complete');expect(await work).toEqual({state:'saved',bytes:3});await tick();expect(f.fs.files.size).toBe(0);expect(f.fs.held).toBe(0);expect(f.env.revokeURL).toHaveBeenCalledWith('blob:test');expect(f.d.changed.size).toBe(0);expect(f.d.erased.size).toBe(0);
    });
    it('rejects filename collisions without modifying an existing file',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([9])]);
        await expect(beginMaterialBrowserBackup('backup.json',f.env)).rejects.toThrow('已存在');expect(f.fs.files.get(name)?.[0][0]).toBe(9);expect(f.fs.deleted).toHaveLength(0);
    });
    it('observes a completed event emitted before download returns its id',async()=>{
        const f=downloads(),gate=deferred<number>();vi.mocked(f.api.download).mockReturnValueOnce(gate.promise);
        const opening=startObservedMaterialDownload(f.api,'blob:test','backup.json');f.emit(7,'complete');gate.resolve(7);
        const download=await opening;expect(await download.wait()).toBe('complete');expect(f.api.search).not.toHaveBeenCalled();expect(f.changed.size).toBe(0);expect(f.erased.size).toBe(0);
    });
    it('queries the download after startup to recover events missed before listener registration',async()=>{
        const f=downloads();vi.mocked(f.api.search).mockResolvedValueOnce([{id:7,state:'complete'}]);const d=await startObservedMaterialDownload(f.api,'blob:test','backup.json');expect(await d.wait()).toBe('complete');expect(f.api.search).toHaveBeenCalledWith({id:7});
    });
    it('treats a removed download or failed query as unknown and retains its OPFS file',async()=>{
        for(const mode of ['erased','query'] as const){const f=fixture();if(mode==='query')vi.mocked(f.d.api.search).mockRejectedValueOnce(Error('query failed'));
            const choice=await beginMaterialBrowserBackup('backup.json',f.env);if(choice.status!=='ready')throw Error('not ready');const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));});await tick();if(mode==='erased')f.d.erase(7);
            await expect(work).rejects.toThrow('无法确认材料备份下载状态');expect(f.fs.files.size).toBe(2);expect(f.fs.deleted).toHaveLength(0);expect(f.env.revokeURL).not.toHaveBeenCalled();expect(f.fs.held).toBe(1);
        }
    });
    it('keeps the file and URL if starting the download fails ambiguously',async()=>{
        const f=fixture();vi.mocked(f.d.api.download).mockRejectedValueOnce(Error('ipc failure'));const choice=await beginMaterialBrowserBackup('backup.json',f.env);if(choice.status!=='ready')throw Error('not ready');
        await expect(saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));})).rejects.toThrow('无法确认材料备份下载是否已开始');expect(f.fs.files.size).toBe(2);expect(f.fs.deleted).toHaveLength(0);expect(f.d.changed.size).toBe(0);expect(f.d.erased.size).toBe(0);
    });
    it('allows cancellation while the initial download state query is stuck',async()=>{
        const f=fixture(),pending=deferred<{id:number;state:string}[]>();vi.mocked(f.d.api.search).mockReturnValueOnce(pending.promise);
        const choice=await beginMaterialBrowserBackup('backup.json',f.env),controller=new AbortController();if(choice.status!=='ready')throw Error('not ready');
        const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});await tick();controller.abort();await tick();
        expect(f.d.api.cancel).toHaveBeenCalledWith(7);f.d.emit(7,'interrupted');await expect(work).rejects.toMatchObject({name:'AbortError'});
        expect(f.fs.files.size).toBe(0);pending.resolve([]);
    });
    it('preserves the source when a download state query times out',async()=>{
        vi.useFakeTimers();try{
            const f=fixture(),pending=deferred<{id:number;state:string}[]>();vi.mocked(f.d.api.search).mockReturnValueOnce(pending.promise);
            const choice=await beginMaterialBrowserBackup('backup.json',f.env);if(choice.status!=='ready')throw Error('not ready');
            const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));});void work.catch(()=>{});await tick();
            await vi.advanceTimersByTimeAsync(30000);await expect(work).rejects.toThrow('无法确认材料备份下载状态');expect(f.fs.files.size).toBe(2);expect(f.fs.held).toBe(1);pending.resolve([]);
        }finally{vi.useRealTimers();}
    });
    it('holds the temporary data after cancellation until interruption is confirmed',async()=>{
        const f=fixture(),choice=await beginMaterialBrowserBackup('backup.json',f.env),controller=new AbortController();if(choice.status!=='ready')throw Error('not ready');const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});await tick();controller.abort();await tick();expect(f.d.api.cancel).toHaveBeenCalledWith(7);expect(f.fs.files.size).toBe(2);f.d.emit(7,'interrupted');await expect(work).rejects.toMatchObject({name:'AbortError'});expect(f.fs.files.size).toBe(0);
    });
    it('reports unknown and keeps the source if browser cancellation fails',async()=>{
        const f=fixture(),choice=await beginMaterialBrowserBackup('backup.json',f.env),controller=new AbortController();if(choice.status!=='ready')throw Error('not ready');
        vi.mocked(f.d.api.cancel).mockRejectedValueOnce(Error('cancel failed'));
        const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});void work.catch(()=>{});await tick();controller.abort();
        await expect(work).rejects.toThrow('无法确认材料备份下载状态');expect(f.fs.files.size).toBe(2);expect(f.fs.deleted).toHaveLength(0);
    });
    it('reports unknown if cancellation never reaches a browser terminal state',async()=>{
        vi.useFakeTimers();try{
            const f=fixture(),choice=await beginMaterialBrowserBackup('backup.json',f.env),controller=new AbortController();if(choice.status!=='ready')throw Error('not ready');
            const work=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});void work.catch(()=>{});await tick();controller.abort();await tick();
            await vi.advanceTimersByTimeAsync(30000);await expect(work).rejects.toThrow('无法确认材料备份下载状态');expect(f.fs.files.size).toBe(2);
        }finally{vi.useRealTimers();}
    });
    it('rejects invalid polling intervals and missing download state',async()=>{
        const d=downloads();await expect(startObservedMaterialDownload(d.api,'x','n',0)).rejects.toThrow('查询间隔');vi.mocked(d.api.search).mockResolvedValueOnce([]);const started=await startObservedMaterialDownload(d.api,'x','n');await expect(started.wait()).rejects.toThrow('无法确认');
    });
    it('does not overwrite an existing file when access lookup fails',async()=>{
        const f=fixture();f.fs.dir.getFileHandle.mockRejectedValueOnce(new DOMException('denied','SecurityError'));const platform=createMaterialBrowserOpfsPlatform(f.env);await expect(platform.create('candidate')).rejects.toMatchObject({name:'SecurityError'});expect(f.fs.dir.getFileHandle).toHaveBeenCalledOnce();
    });
    it('lists only owned files and lets the user recover and explicitly remove a completed temporary backup',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'b'.repeat(32)+'.tmp',partial='fluentread-material-backup-v1-1700000000001-'+ 'c'.repeat(32)+'.tmp';
        f.fs.files.set(name,[new Uint8Array([1,2,3])]);f.fs.files.set(`${name}.ready`,[new TextEncoder().encode('{"v":1,"size":3}')]);
        f.fs.files.set(partial,[new Uint8Array([4])]);f.fs.files.set('unrelated',[new Uint8Array([5])]);
        const root=f.fs.root as unknown as FileSystemDirectoryHandle,locks=f.fs.locks as unknown as LockManager;
        const listed=await listMaterialBackupLeftovers(root);expect(listed).toMatchObject({truncated:false,failed:0});expect(listed.items).toEqual([{name:partial,createdAt:1700000000001,bytes:1,ready:false},{name,createdAt:1700000000000,bytes:3,ready:true}]);
        await expect(beginRecoveredMaterialBackup(partial,'backup.json',f.env)).rejects.toThrow('未完成或无法验证');
        const recovery=beginRecoveredMaterialBackup(name,'backup.json',f.env);expect(f.permission).toHaveBeenCalledTimes(2);const choice=await recovery;if(choice.status!=='ready')throw Error('not ready');
        await expect(removeMaterialBackupLeftover(root,locks,name)).rejects.toThrow('正在使用');
        const work=choice.target.commit(new AbortController().signal);await tick();f.d.emit(7,'complete');expect(await work).toBe('saved');await tick();
        expect(f.fs.files.has(name)).toBe(true);expect(f.fs.files.has(`${name}.ready`)).toBe(true);
        await removeMaterialBackupLeftover(root,locks,name);expect(f.fs.files.has(name)).toBe(false);expect(f.fs.files.has(`${name}.ready`)).toBe(false);expect(f.fs.files.has('unrelated')).toBe(true);
    });
    it('does not treat a size-mismatched completion marker as a recoverable backup',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'b'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);f.fs.files.set(`${name}.ready`,[new TextEncoder().encode('{"v":1,"size":2}')]);
        const list=await listMaterialBackupLeftovers(f.fs.root as unknown as FileSystemDirectoryHandle);expect(list.items[0].ready).toBe(false);
        await expect(beginRecoveredMaterialBackup(name,'backup.json',f.env)).rejects.toThrow('未完成或无法验证');expect(f.fs.files.has(name)).toBe(true);
    });
    it('uses the Firefox production entry points only after a user gesture grants the optional permission',async()=>{
        const f=fixture(),gate=deferred<boolean>();let granted=false;
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:async()=>f.fs.root},locks:f.fs.locks});
        vi.stubGlobal('crypto',{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
        vi.stubGlobal('URL',{createObjectURL:()=> 'blob:test',revokeObjectURL:vi.fn()});
        expect(await prepareFirefoxMaterialBackupContext()).toBe(true);
        browserMock.permissions.request.mockImplementation(()=>gate.promise);
        Object.defineProperty(browserMock,'downloads',{configurable:true,get(){return granted?f.d.api:undefined;},set(){}});
        const opening=beginFirefoxMaterialBackup('backup.json');expect(browserMock.permissions.request).toHaveBeenCalledWith({permissions:['downloads']});granted=true;gate.resolve(true);
        const choice=await opening;if(choice.status!=='ready')throw Error('not ready');
        const saved=saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));});await tick();f.d.emit(7,'complete');expect((await saved).state).toBe('saved');
        expect((await listFirefoxMaterialBackupLeftovers()).items).toEqual([]);
        const name='fluentread-material-backup-v1-1700000000000-'+ 'd'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);f.fs.files.set(`${name}.ready`,[new TextEncoder().encode('{"v":1,"size":1}')]);
        browserMock.permissions.request.mockResolvedValue(true);
        const recovery=await beginFirefoxRecoveredMaterialBackup(name,'backup.json');if(recovery.status!=='ready')throw Error('not ready');await expect(recovery.target.write(new Uint8Array([9]))).rejects.toThrow('不能改写');await recovery.target.abort();
        await removeFirefoxMaterialBackupLeftover(name);expect(f.fs.files.has(name)).toBe(false);
        Object.defineProperty(browserMock,'downloads',{configurable:true,writable:true,value:undefined});
    });
    it('waits for the actual Firefox tab privacy state even when downloads permission is already granted',async()=>{
        const f=fixture(),privacy=deferred<{incognito:boolean}>(),directory=vi.fn(async()=>f.fs.root);
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:directory},locks:f.fs.locks});
        vi.stubGlobal('crypto',{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
        expect(await prepareFirefoxMaterialBackupContext()).toBe(true);
        browserMock.permissions.request.mockResolvedValue(true);browserMock.tabs.getCurrent.mockReturnValue(privacy.promise);
        browserMock.downloads=f.d.api;
        const opening=beginFirefoxMaterialBackup('backup.json');
        expect(browserMock.permissions.request).toHaveBeenCalledOnce();await tick();expect(directory).not.toHaveBeenCalled();
        privacy.resolve({incognito:false});const choice=await opening;if(choice.status!=='ready')throw Error('not ready');
        expect(directory).toHaveBeenCalledOnce();await choice.target.abort();
    });
    it('never opens OPFS from a private or unidentifiable Firefox tab',async()=>{
        const f=fixture(),directory=vi.fn(async()=>f.fs.root),name='fluentread-material-backup-v1-1700000000000-'+ 'd'.repeat(32)+'.tmp';
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:directory},locks:f.fs.locks});
        browserMock.permissions.request.mockResolvedValue(true);browserMock.downloads=f.d.api;
        for(const tab of [{incognito:true},undefined,{}] as const){
            browserMock.tabs.getCurrent.mockResolvedValue(tab as never);
            expect(await prepareFirefoxMaterialBackupContext()).toBe(false);
            await expect(listFirefoxMaterialBackupLeftovers()).rejects.toThrow('隐私');
            await expect(removeFirefoxMaterialBackupLeftover(name)).rejects.toThrow('隐私');
            await expect(beginFirefoxMaterialBackup('backup.json')).rejects.toThrow('隐私');
            await expect(beginFirefoxRecoveredMaterialBackup(name,'backup.json')).rejects.toThrow('隐私');
        }
        browserMock.tabs.getCurrent.mockRejectedValue(Error('tab query failed'));
        await expect(listFirefoxMaterialBackupLeftovers()).rejects.toThrow('隐私');
        await expect(beginFirefoxRecoveredMaterialBackup(name,'backup.json')).rejects.toThrow('隐私');
        expect(browserMock.permissions.request).not.toHaveBeenCalled();expect(directory).not.toHaveBeenCalled();expect(f.fs.files.size).toBe(0);
    });
    it('does not prompt while the privacy preflight is pending and rejects stale preflight results',async()=>{
        const f=fixture(),first=deferred<{incognito:boolean}>(),second=deferred<{incognito:boolean}>();
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:async()=>f.fs.root},locks:f.fs.locks});
        browserMock.tabs.getCurrent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const older=prepareFirefoxMaterialBackupContext(),newer=prepareFirefoxMaterialBackupContext();
        await expect(beginFirefoxMaterialBackup('backup.json')).rejects.toMatchObject({name:'MaterialBackupContextError'});expect(browserMock.permissions.request).not.toHaveBeenCalled();
        second.resolve({incognito:true});expect(await newer).toBe(false);first.resolve({incognito:false});expect(await older).toBe(false);
        await expect(beginFirefoxMaterialBackup('backup.json')).rejects.toThrow('隐私');expect(browserMock.permissions.request).not.toHaveBeenCalled();
    });
    it('does not let an older failed preflight invalidate a newer successful one',async()=>{
        const f=fixture(),olderTab=deferred<{incognito:boolean}>(),newerTab=deferred<{incognito:boolean}>();
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:async()=>f.fs.root},locks:f.fs.locks});
        browserMock.tabs.getCurrent.mockReturnValueOnce(olderTab.promise).mockReturnValueOnce(newerTab.promise);
        const older=prepareFirefoxMaterialBackupContext(),newer=prepareFirefoxMaterialBackupContext();
        newerTab.resolve({incognito:false});expect(await newer).toBe(true);
        olderTab.reject(Error('old query failed'));expect(await older).toBe(false);
        browserMock.tabs.getCurrent.mockResolvedValue({incognito:false});browserMock.permissions.request.mockResolvedValue(false);
        const choice=beginFirefoxMaterialBackup('backup.json');expect(browserMock.permissions.request).toHaveBeenCalledOnce();
        expect(await choice).toEqual({status:'denied'});
    });
    it('does not let an older operation privacy failure invalidate a newer successful preflight',async()=>{
        const f=fixture(),olderTab=deferred<{incognito:boolean}>();
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:async()=>f.fs.root},locks:f.fs.locks});
        expect(await prepareFirefoxMaterialBackupContext()).toBe(true);
        browserMock.permissions.request.mockResolvedValue(true);browserMock.tabs.getCurrent.mockReturnValueOnce(olderTab.promise);
        const older=beginFirefoxMaterialBackup('backup.json');
        expect(await prepareFirefoxMaterialBackupContext()).toBe(true);
        olderTab.reject(Error('old query failed'));await expect(older).rejects.toMatchObject({name:'MaterialBackupContextError'});
        browserMock.permissions.request.mockResolvedValue(false);
        const choice=beginFirefoxMaterialBackup('backup.json');expect(browserMock.permissions.request).toHaveBeenCalledTimes(2);
        expect(await choice).toEqual({status:'denied'});expect(f.fs.files.size).toBe(0);
    });
    it('fails closed when the extension context is private or changes while checking the tab',async()=>{
        const f=fixture(),directory=vi.fn(async()=>f.fs.root),privacy=deferred<{incognito:boolean}>();
        vi.stubEnv('BROWSER','firefox');vi.stubGlobal('navigator',{storage:{getDirectory:directory},locks:f.fs.locks});
        browserMock.permissions.request.mockResolvedValue(true);browserMock.downloads=f.d.api;
        expect(await prepareFirefoxMaterialBackupContext()).toBe(true);
        browserMock.tabs.getCurrent.mockReturnValueOnce(privacy.promise);
        const opening=beginFirefoxMaterialBackup('backup.json');expect(browserMock.permissions.request).toHaveBeenCalledOnce();
        browserMock.extension.inIncognitoContext=true;privacy.resolve({incognito:false});await expect(opening).rejects.toThrow('隐私');
        await expect(beginFirefoxMaterialBackup('backup.json')).rejects.toThrow('隐私');
        await expect(listFirefoxMaterialBackupLeftovers()).rejects.toThrow('隐私');
        expect(browserMock.permissions.request).toHaveBeenCalledOnce();expect(directory).not.toHaveBeenCalled();
    });
    it('reports unavailable browser capabilities without requesting downloads access',async()=>{
        vi.stubEnv('BROWSER','chrome');expect(await prepareFirefoxMaterialBackupContext()).toBe(false);expect(browserMock.tabs.getCurrent).not.toHaveBeenCalled();expect(await beginFirefoxMaterialBackup('backup.json')).toEqual({status:'unavailable'});
        expect(await beginFirefoxRecoveredMaterialBackup('invalid','backup.json')).toEqual({status:'unavailable'});
        await expect(listFirefoxMaterialBackupLeftovers()).rejects.toThrow('无法查看');await expect(removeFirefoxMaterialBackupLeftover('invalid')).rejects.toThrow('无法清理');expect(browserMock.permissions.request).not.toHaveBeenCalled();
    });
    it('bounds and rejects unsafe cleanup and recovery requests',async()=>{
        const f=fixture(),root=f.fs.root as unknown as FileSystemDirectoryHandle,locks=f.fs.locks as unknown as LockManager;
        await expect(listMaterialBackupLeftovers(root,0)).rejects.toThrow('数量无效');await expect(removeMaterialBackupLeftover(root,locks,'../other')).rejects.toThrow('文件名无效');
        await expect(beginRecoveredMaterialBackup('../other','backup.json',f.env)).rejects.toThrow('文件名无效');expect(f.permission).not.toHaveBeenCalled();
        const name='fluentread-material-backup-v1-1700000000000-'+ 'b'.repeat(32)+'.tmp';f.permission.mockResolvedValueOnce(false);expect(await beginRecoveredMaterialBackup(name,'backup.json',f.env)).toEqual({status:'denied'});
        f.permission.mockImplementationOnce(()=>{throw Error('permission failed');});await expect(beginMaterialBrowserBackup('backup.json',f.env)).rejects.toThrow('permission failed');
    });
    it('rejects invalid or erased downloads instead of reporting completion',async()=>{
        const f=downloads();vi.mocked(f.api.download).mockResolvedValueOnce(-1);await expect(startObservedMaterialDownload(f.api,'x','n')).rejects.toThrow('标识无效');expect(f.changed.size).toBe(0);
        vi.mocked(f.api.search).mockResolvedValueOnce([{id:7,state:'unexpected'}]);const started=await startObservedMaterialDownload(f.api,'x','n');await expect(started.wait()).rejects.toThrow('无法确认');
        const completed=downloads();vi.mocked(completed.api.search).mockResolvedValueOnce([{id:7,state:'complete'}]);const done=await startObservedMaterialDownload(completed.api,'x','n');expect(await done.wait()).toBe('complete');await done.cancel();expect(completed.api.cancel).not.toHaveBeenCalled();
    });
    it('ignores malformed, oversized, and inaccessible completion markers',async()=>{
        const f=fixture(),root=f.fs.root as unknown as FileSystemDirectoryHandle;
        const names=Array.from({length:5},(_,i)=>`fluentread-material-backup-v1-170000000000${i}-${String(i).repeat(32)}.tmp`);
        for(const name of names)f.fs.files.set(name,[new Uint8Array([1])]);
        const contents=['{broken','null','{"v":1,"size":0}','{"v":1,"size":"1"}','x'.repeat(257)];
        for(let i=0;i<names.length;i++)f.fs.files.set(`${names[i]}.ready`,[new TextEncoder().encode(contents[i])]);
        const list=await listMaterialBackupLeftovers(root);expect(list.items).toHaveLength(5);expect(list.items.every(item=>!item.ready)).toBe(true);
        expect((await listMaterialBackupLeftovers(root,2)).truncated).toBe(true);
    });
    it('never starts a browser download when listener installation fails',async()=>{
        const d=downloads();d.api.onErased.addListener=()=>{throw Error('listener unavailable');};
        await expect(startObservedMaterialDownload(d.api,'x','n')).rejects.toThrow('下载监听不可用');expect(d.api.download).not.toHaveBeenCalled();expect(d.changed.size).toBe(0);
    });
    it('removes the verified temporary file if listeners fail before browser download is invoked',async()=>{
        const f=fixture();f.d.api.onErased.addListener=()=>{throw Error('listener unavailable');};
        const choice=await beginMaterialBrowserBackup('backup.json',f.env);if(choice.status!=='ready')throw Error('not ready');
        await expect(saveMaterialBackup(choice.target,async consume=>{await consume(new Uint8Array([1]));})).rejects.toThrow('下载监听不可用');
        expect(f.d.api.download).not.toHaveBeenCalled();expect(f.fs.files.size).toBe(0);expect(f.env.revokeURL).toHaveBeenCalledOnce();await tick();expect(f.fs.held).toBe(0);
    });
    it('reports a marker write failure and aborts the uncommitted marker',async()=>{
        const f=fixture(),original=f.fs.dir.getFileHandle.getMockImplementation()!,abort=vi.fn(async()=>{});
        f.fs.dir.getFileHandle.mockImplementation(async(name,options)=>name.endsWith('.ready')&&options?.create
            ? {createWritable:async()=>({write:async()=>{throw Error('disk full');},close:async()=>{},abort})} as never
            : original(name,options));
        const platform=createMaterialBrowserOpfsPlatform(f.env);
        await expect(platform.markReady!('candidate',new Blob(['data']))).rejects.toThrow('disk full');expect(abort).toHaveBeenCalledOnce();
        await expect(platform.markReady!('candidate',new Blob())).rejects.toThrow('临时文件无效');
    });
    it('rejects a download when permission is granted but the browser omits its API',async()=>{
        const f=fixture();Object.defineProperty(f.env,'downloads',{value:undefined});
        expect(await beginMaterialBrowserBackup('backup.json',f.env)).toEqual({status:'unavailable'});
        const name='fluentread-material-backup-v1-1700000000000-'+ 'b'.repeat(32)+'.tmp';expect(await beginRecoveredMaterialBackup(name,'backup.json',f.env)).toEqual({status:'unavailable'});
    });
    it('recognizes that no browser download was invoked when the API disappears or throws',async()=>{
        for(const throwing of [false,true]){
            const f=fixture();Object.defineProperty(f.env,'downloads',{get(){if(throwing)throw Error('permission revoked');return undefined;}});
            const platform=createMaterialBrowserOpfsPlatform(f.env);
            expect(()=>platform.startDownload('blob:test','backup.json')).toThrow('下载接口不可用');expect(f.d.api.download).not.toHaveBeenCalled();
        }
    });
    it('preserves unknown status even when permission revocation breaks listener cleanup',async()=>{
        const d=downloads();d.api.onChanged.removeListener=()=>{throw Error('revoked');};d.api.onErased.removeListener=()=>{throw Error('revoked');};
        vi.mocked(d.api.search).mockResolvedValueOnce([]);const download=await startObservedMaterialDownload(d.api,'blob:test','backup.json');await expect(download.wait()).rejects.toThrow('无法确认');
    });
    it('removes a newly created empty file when creating its writer fails',async()=>{
        const f=fixture(),original=f.fs.dir.getFileHandle.getMockImplementation()!;
        f.fs.dir.getFileHandle.mockImplementation(async(name,options)=>{
            const handle=await original(name,options);return name==='candidate'&&options?.create?{...handle,createWritable:async()=>{throw Error('no writer');}}:handle;
        });
        const platform=createMaterialBrowserOpfsPlatform(f.env);await expect(platform.create('candidate')).rejects.toThrow('no writer');expect(f.fs.files.has('candidate')).toBe(false);
    });
    it('propagates a marker deletion failure without claiming temporary cleanup succeeded',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);f.fs.files.set(`${name}.ready`,[new Uint8Array([2])]);
        const original=f.fs.dir.removeEntry.getMockImplementation()!;f.fs.dir.removeEntry.mockImplementation(async entry=>{if(entry.endsWith('.ready'))throw new DOMException('denied','SecurityError');await original(entry);});
        await expect(removeMaterialBackupLeftover(f.fs.root as unknown as FileSystemDirectoryHandle,f.fs.locks as unknown as LockManager,name)).rejects.toMatchObject({name:'SecurityError'});expect(f.fs.files.has(name)).toBe(false);expect(f.fs.files.has(`${name}.ready`)).toBe(true);
    });
    it('shows list failures for inaccessible temporary data and safely handles a missing directory',async()=>{
        const f=fixture(),root=f.fs.root as unknown as FileSystemDirectoryHandle,name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);
        f.fs.dir.getFileHandle.mockRejectedValueOnce(new DOMException('denied','SecurityError'));expect(await listMaterialBackupLeftovers(root)).toMatchObject({items:[],failed:1});
        const missing={getDirectoryHandle:async()=>{throw new DOMException('missing','NotFoundError');}} as unknown as FileSystemDirectoryHandle;
        expect(await listMaterialBackupLeftovers(missing)).toEqual({items:[],truncated:false,failed:0});
    });
    it('does not treat a marker with a read error as evidence of a completed backup',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);
        const original=f.fs.dir.getFileHandle.getMockImplementation()!;f.fs.dir.getFileHandle.mockImplementation(async(entry,options)=>entry===`${name}.ready`?{getFile:async()=>{throw new DOMException('denied','SecurityError');}} as never:original(entry,options));
        const list=await listMaterialBackupLeftovers(f.fs.root as unknown as FileSystemDirectoryHandle);expect(list).toMatchObject({items:[],failed:1});
    });
    it('propagates a synchronous permission error when recovering a backup',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.permission.mockImplementationOnce(()=>{throw Error('permission failed');});
        await expect(beginRecoveredMaterialBackup(name,'backup.json',f.env)).rejects.toThrow('permission failed');expect(f.fs.files.size).toBe(0);
    });
    it('does not let a late search failure override a confirmed completion',async()=>{
        const d=downloads(),pending=deferred<{id:number;state:string}[]>();vi.mocked(d.api.search).mockReturnValueOnce(pending.promise);
        const started=await startObservedMaterialDownload(d.api,'x','n'),queued=[...d.changed][0];d.emit(7,'complete');expect(await started.wait()).toBe('complete');
        queued({id:7,state:{current:'interrupted'}});pending.reject(Error('late state query'));await tick();expect(await started.wait()).toBe('complete');
    });
    it('ignores a previously queued poll after the download has completed',async()=>{
        vi.useFakeTimers();try{
            const d=downloads(),schedule=vi.spyOn(globalThis,'setTimeout');const started=await startObservedMaterialDownload(d.api,'x','n',42);await tick();
            const callback=schedule.mock.calls.find(([,delay])=>delay===42)?.[0];expect(typeof callback).toBe('function');d.emit(7,'complete');expect(await started.wait()).toBe('complete');
            (callback as ()=>void)();await tick();expect(d.api.search).toHaveBeenCalledTimes(1);
        }finally{vi.useRealTimers();}
    });
    it('reports inability to clean the temporary file when writer creation and removal both fail',async()=>{
        const f=fixture(),original=f.fs.dir.getFileHandle.getMockImplementation()!;
        f.fs.dir.getFileHandle.mockImplementation(async(name,options)=>{const handle=await original(name,options);return name==='candidate'&&options?.create?{...handle,createWritable:async()=>{throw Error('no writer');}}:handle;});
        f.fs.dir.removeEntry.mockRejectedValueOnce(Error('disk unavailable'));
        await expect(createMaterialBrowserOpfsPlatform(f.env).create('candidate')).rejects.toMatchObject({name:'MaterialBackupInitializationCleanupError',message:'创建备份时未能清理新建的空临时文件，请在临时文件列表检查。'});expect(f.fs.files.has('candidate')).toBe(true);expect(f.fs.files.get('candidate')).toEqual([]);
    });
    it('does not claim a completion marker exists when both writing and abort fail',async()=>{
        const f=fixture(),original=f.fs.dir.getFileHandle.getMockImplementation()!;
        f.fs.dir.getFileHandle.mockImplementation(async(name,options)=>name.endsWith('.ready')&&options?.create?{createWritable:async()=>({write:async()=>{throw Error('write failed');},close:async()=>{},abort:async()=>{throw Error('abort failed');}})} as never:original(name,options));
        await expect(createMaterialBrowserOpfsPlatform(f.env).markReady!('candidate',new Blob(['data']))).rejects.toThrow('write failed');
    });
    it('surfaces a failure to delete completion metadata rather than hiding it',async()=>{
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);f.fs.files.set(`${name}.ready`,[new Uint8Array([2])]);
        const original=f.fs.dir.removeEntry.getMockImplementation()!;f.fs.dir.removeEntry.mockImplementation(async entry=>{if(entry.endsWith('.ready'))throw Error('permission revoked');await original(entry);});
        await expect(createMaterialBrowserOpfsPlatform(f.env).remove(name)).rejects.toThrow('permission revoked');expect(f.fs.files.has(`${name}.ready`)).toBe(true);
    });
    it('surfaces inaccessible storage and detects deletion that did not take effect',async()=>{
        const denied={getDirectoryHandle:async()=>{throw new DOMException('denied','SecurityError');}} as unknown as FileSystemDirectoryHandle;
        await expect(listMaterialBackupLeftovers(denied)).rejects.toMatchObject({name:'SecurityError'});
        const f=fixture(),name='fluentread-material-backup-v1-1700000000000-'+ 'a'.repeat(32)+'.tmp';f.fs.files.set(name,[new Uint8Array([1])]);f.fs.dir.removeEntry.mockResolvedValue(undefined);
        await expect(removeMaterialBackupLeftover(f.fs.root as unknown as FileSystemDirectoryHandle,f.fs.locks as unknown as LockManager,name)).rejects.toThrow('无法确认材料备份临时文件已删除');
    });
    it('sorts files with the same creation time deterministically',async()=>{
        const f=fixture(),prefix='fluentread-material-backup-v1-1700000000000-',first=prefix+'a'.repeat(32)+'.tmp',second=prefix+'b'.repeat(32)+'.tmp';f.fs.files.set(second,[new Uint8Array([2])]);f.fs.files.set(first,[new Uint8Array([1])]);
        expect((await listMaterialBackupLeftovers(f.fs.root as unknown as FileSystemDirectoryHandle)).items.map(item=>item.name)).toEqual([first,second]);
    });
});
