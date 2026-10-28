/**
 * @file src/features/vocabulary/materialBackupBrowserSave.ts
 * 文件职责：为支持私有文件和下载 API 的扩展页面接入材料备份保存目标。
 * 主要内容：在用户手势内请求可选权限、逐块写入 OPFS，并通过下载事件和查询确认终态后清理；不确定时保留源文件。
 * 模块边界：不触发备份读取、不修改材料，不保证页面卸载后下载继续；权限或平台不可用时由调用方选择回退方式。
 */
import browser from 'webextension-polyfill';
import {createMaterialBackupOpfsTarget, materialBackupTemporaryFileTime, MaterialBackupDownloadNotStartedError, type MaterialBackupOpfsPlatform, type MaterialBackupOpfsDownload, type MaterialBackupDownloadTerminal} from './materialBackupOpfsSave';
import type {MaterialBackupSaveTarget, MaterialBackupWritable} from './materialBackupSave';

interface DownloadDelta {id:number;state?:{current?:string}}
interface DownloadItem {id:number;state:string}
interface DownloadEvent<T> {addListener(listener:(event:T)=>void):void;removeListener(listener:(event:T)=>void):void}
export interface MaterialBrowserDownloads {
    download(options:{url:string;filename:string}):Promise<number>;
    search(query:{id:number}):Promise<DownloadItem[]>;
    cancel(id:number):Promise<void>;
    onChanged:DownloadEvent<DownloadDelta>;
    onErased:DownloadEvent<number>;
}
export interface MaterialBrowserBackupEnvironment {
    requestPermission():Promise<boolean>;
    directory():Promise<FileSystemDirectoryHandle>;
    locks:LockManager;
    downloads:MaterialBrowserDownloads;
    randomId():string;
    now():number;
    objectURL(file:Blob):string;
    revokeURL(url:string):void;
}
export type MaterialBrowserBackupChoice = {status:'ready';target:MaterialBackupSaveTarget}|{status:'denied'|'unavailable'};

const TEMP_DIRECTORY='fluentread-material-backups';
const notFound=(error:unknown)=>error instanceof DOMException&&error.name==='NotFoundError';
async function exists(dir:FileSystemDirectoryHandle,name:string):Promise<boolean> {
    try {await dir.getFileHandle(name);return true;}catch(error){if(notFound(error))return false;throw error;}
}
async function readySize(dir:FileSystemDirectoryHandle,name:string):Promise<number|undefined> {
    try {
        const marker=await (await dir.getFileHandle(`${name}.ready`)).getFile();
        if(marker.size>256)return undefined;
        const value:unknown=JSON.parse(await marker.text());
        if(!value||typeof value!=='object')return undefined;
        const record=value as {v?:unknown;size?:unknown};
        return record.v===1&&typeof record.size==='number'&&Number.isSafeInteger(record.size)&&record.size>0?record.size:undefined;
    } catch(error){if(notFound(error)||error instanceof SyntaxError)return undefined;throw error;}
}

/** 监听先于启动，查询补齐 ID 返回前的事件；记录消失或查询失败时状态未知。 */
export async function startObservedMaterialDownload(api:MaterialBrowserDownloads,url:string,filename:string,pollMs=30000):Promise<MaterialBackupOpfsDownload> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('下载查询间隔无效');
    let id:number|undefined, settled=false, timer:ReturnType<typeof setTimeout>|undefined, cancelTimer:ReturnType<typeof setTimeout>|undefined;
    const early=new Map<number,MaterialBackupDownloadTerminal|'erased'>();
    let resolve!:(value:MaterialBackupDownloadTerminal)=>void, reject!:(error:Error)=>void;
    const result=new Promise<MaterialBackupDownloadTerminal>((yes,no)=>{resolve=yes;reject=no;});void result.catch(()=>{});
    const cleanup=()=>{if(timer!==undefined)clearTimeout(timer);if(cancelTimer!==undefined)clearTimeout(cancelTimer);try{api.onChanged.removeListener(changed);}catch{/* 权限可能已被撤销。 */}try{api.onErased.removeListener(erased);}catch{/* 权限可能已被撤销。 */}};
    const finish=(state:MaterialBackupDownloadTerminal|'erased')=>{
        if(settled)return;settled=true;cleanup();
        if(state==='erased')reject(new Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'));else resolve(state);
    };
    const remember=(eventId:number,state:MaterialBackupDownloadTerminal|'erased')=>{
        if(id===undefined){if(early.size<256)early.set(eventId,state);return;}
        if(eventId===id)finish(state);
    };
    const changed=(event:DownloadDelta)=>{const state=event.state?.current;if(state==='complete'||state==='interrupted')remember(event.id,state);};
    const erased=(eventId:number)=>remember(eventId,'erased');
    try {api.onChanged.addListener(changed);api.onErased.addListener(erased);}catch(error){cleanup();throw new MaterialBackupDownloadNotStartedError('材料备份下载监听不可用，请重试',error);}
    const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(Object.assign(new Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'),{cause:error}));};
    const poll=async()=>{
        if(settled||id===undefined)return;
        try {
            let deadline:ReturnType<typeof setTimeout>|undefined;
            const entries=await Promise.race([
                api.search({id}),
                new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('下载状态查询超时')),30000);}),
            ]).finally(()=>{if(deadline!==undefined)clearTimeout(deadline);});if(settled)return;
            const item=entries.find(entry=>entry.id===id);
            if(!item){finish('erased');return;}
            if(item.state==='complete'||item.state==='interrupted'){finish(item.state);return;}
            if(item.state!=='in_progress'){fail(new Error('下载状态无效'));return;}
            timer=setTimeout(()=>{void poll();},pollMs);
        } catch(error){fail(error);}
    };
    try {
        const started=await api.download({url,filename});
        if(!Number.isSafeInteger(started)||started<0)throw new Error('下载标识无效');
        id=started;
        const state=early.get(id);early.clear();if(state)finish(state);
        if(!settled)void poll();
        return {wait:()=>result,async cancel(){
            if(settled)return;
            cancelTimer ??= setTimeout(()=>fail(new Error('下载取消状态未确认')),30000);
            try {await api.cancel(started);}catch(error){fail(error);throw error;}
        }};
    } catch(error) {
        // 调用失败也可能发生在浏览器接收请求之后；上层必须保留临时文件。
        cleanup();throw error;
    }
}

async function acquireLock(locks:LockManager,name:string):Promise<(()=>void)|undefined> {
    let release!:()=>void, resolve!:(value:(()=>void)|undefined)=>void, reject!:(reason:unknown)=>void;
    const acquired=new Promise<(()=>void)|undefined>((yes,no)=>{resolve=yes;reject=no;});
    const hold=new Promise<void>(done=>{release=done;});
    const request=locks.request(`fluentread-material-backup:${name}`,{ifAvailable:true},async lock=>{
        if(!lock){resolve(undefined);return;}
        resolve(release);await hold;
    });
    void request.catch(reject);
    return acquired;
}

export function createMaterialBrowserOpfsPlatform(env:MaterialBrowserBackupEnvironment):MaterialBackupOpfsPlatform {
    let folder:Promise<FileSystemDirectoryHandle>|undefined;
    const directory=()=>folder ??= env.directory().then(root=>root.getDirectoryHandle(TEMP_DIRECTORY,{create:true}));
    return {
        acquire:name=>acquireLock(env.locks,name),
        async create(name) {
            const dir=await directory();
            if(await exists(dir,name)||await exists(dir,`${name}.ready`))throw new Error('材料备份临时文件已存在');
            const file=await dir.getFileHandle(name,{create:true});
            let writer:FileSystemWritableFileStream;
            try {writer=await file.createWritable();} catch(error){
                try {await dir.removeEntry(name);}
                catch(cleanupError){throw Object.assign(new Error('创建备份时未能清理新建的空临时文件，请在临时文件列表检查。'),{name:'MaterialBackupInitializationCleanupError',cause:error,cleanupError});}
                throw error;
            }
            const target:MaterialBackupWritable & {file():Promise<Blob>}={write:chunk=>writer.write(chunk),close:()=>writer.close(),abort:reason=>writer.abort(reason),file:()=>file.getFile()};
            return target;
        },
        async markReady(name,file){
            if(!Number.isSafeInteger(file.size)||file.size<1)throw new Error('材料备份临时文件无效');
            const dir=await directory(),marker=await dir.getFileHandle(`${name}.ready`,{create:true}),writer=await marker.createWritable();
            try {await writer.write(JSON.stringify({v:1,size:file.size}));await writer.close();}
            catch(error){try{await writer.abort();}catch{/* 未完成标记不用于恢复。 */}throw error;}
        },
        async remove(name){const dir=await directory();await dir.removeEntry(name);try{await dir.removeEntry(`${name}.ready`);}catch(error){if(!notFound(error))throw error;}},
        objectURL:env.objectURL,revokeURL:env.revokeURL,
        startDownload:(url,name)=>{
            let downloads:MaterialBrowserDownloads;
            try {downloads=env.downloads;}catch(error){throw new MaterialBackupDownloadNotStartedError('材料备份下载接口不可用，请重试',error);}
            if(!downloads?.download||!downloads.search||!downloads.cancel||!downloads.onChanged||!downloads.onErased)throw new MaterialBackupDownloadNotStartedError('材料备份下载接口不可用，请重试');
            return startObservedMaterialDownload(downloads,url,name);
        },
        randomId:env.randomId,now:env.now,
    };
}

/** 不可在调用前等待其他 Promise：Firefox 将此请求绑定当前点击事件。 */
export function beginMaterialBrowserBackup(name:string,env:MaterialBrowserBackupEnvironment):Promise<MaterialBrowserBackupChoice> {
    let permission:Promise<boolean>;
    try {permission=env.requestPermission();}catch(error){return Promise.reject(error);}
    return permission.then(async allowed=>{
        if(!allowed)return {status:'denied' as const};
        const downloads=env.downloads;
        if(!downloads?.download||!downloads.search||!downloads.cancel||!downloads.onChanged||!downloads.onErased)return {status:'unavailable' as const};
        return {status:'ready' as const,target:await createMaterialBackupOpfsTarget(name,createMaterialBrowserOpfsPlatform(env))};
    });
}

function firefoxEnvironment():MaterialBrowserBackupEnvironment|undefined {
    if(import.meta.env.BROWSER!=='firefox'||typeof navigator==='undefined'||typeof navigator.storage?.getDirectory!=='function'
        ||typeof navigator.locks?.request!=='function'||typeof browser.permissions?.request!=='function') return undefined;
    return {
        requestPermission:()=>browser.permissions.request({permissions:['downloads']}),
        directory:()=>navigator.storage.getDirectory(),locks:navigator.locks,
        get downloads(){return browser.downloads as unknown as MaterialBrowserDownloads;},
        randomId:()=>crypto.randomUUID().replaceAll('-',''),now:()=>Date.now(),
        objectURL:file=>URL.createObjectURL(file),revokeURL:url=>URL.revokeObjectURL(url),
    };
}

/** Firefox 在缺少原生文件选择器时使用。用户点击中同步调用本函数。 */
export function beginFirefoxMaterialBackup(name:string):Promise<MaterialBrowserBackupChoice> {
    const env=firefoxEnvironment();
    return env ? beginMaterialBrowserBackup(name,env) : Promise.resolve({status:'unavailable'});
}

export interface MaterialBackupLeftover {name:string;createdAt:number;bytes:number;ready:boolean}
export interface MaterialBackupLeftoverList {items:MaterialBackupLeftover[];truncated:boolean;failed:number}

/** 列出限名的私有临时文件；ready 仅表示完整传输后成功关闭并写入标记。 */
export async function listMaterialBackupLeftovers(root:FileSystemDirectoryHandle,maxEntries=200):Promise<MaterialBackupLeftoverList> {
    if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1000)throw new Error('临时文件列表数量无效');
    let dir:FileSystemDirectoryHandle;
    try {dir=await root.getDirectoryHandle(TEMP_DIRECTORY);}catch(error){if(notFound(error))return {items:[],truncated:false,failed:0};throw error;}
    const result:MaterialBackupLeftoverList={items:[],truncated:false,failed:0};
    const entries=dir as FileSystemDirectoryHandle & {values():AsyncIterableIterator<FileSystemHandle>};
    for await(const entry of entries.values()) {
        const createdAt=materialBackupTemporaryFileTime(entry.name);
        if(createdAt===undefined||entry.kind!=='file')continue;
        if(result.items.length+result.failed>=maxEntries){result.truncated=true;break;}
        try {
            const file=await (await dir.getFileHandle(entry.name)).getFile(),size=await readySize(dir,entry.name);
            result.items.push({name:entry.name,createdAt,bytes:file.size,ready:size!==undefined&&size===file.size});
        } catch {result.failed++;}
    }
    result.items.sort((a,b)=>b.createdAt-a.createdAt||a.name.localeCompare(b.name));
    return result;
}

/** 用户明确确认后按单个文件清理；活动页面占用的锁不能强制解除。 */
export async function removeMaterialBackupLeftover(root:FileSystemDirectoryHandle,locks:LockManager,name:string):Promise<void> {
    if(materialBackupTemporaryFileTime(name)===undefined)throw new Error('材料备份临时文件名无效');
    const release=await acquireLock(locks,name);if(!release)throw new Error('材料备份临时文件正在使用，请等待下载结束');
    try {
        const dir=await root.getDirectoryHandle(TEMP_DIRECTORY);
        await dir.removeEntry(name);
        try {await dir.removeEntry(`${name}.ready`);}catch(error){if(!notFound(error))throw error;}
        if(await exists(dir,name)||await exists(dir,`${name}.ready`))throw new Error('无法确认材料备份临时文件已删除');
    } finally {release();}
}

/** 在点击回调中同步请求权限，重新下载已验证的临时文件；原文件保留供用户检查后清理。 */
export function beginRecoveredMaterialBackup(name:string,filename:string,env:MaterialBrowserBackupEnvironment):Promise<MaterialBrowserBackupChoice> {
    if(materialBackupTemporaryFileTime(name)===undefined)return Promise.reject(new Error('材料备份临时文件名无效'));
    let permission:Promise<boolean>;
    try {permission=env.requestPermission();}catch(error){return Promise.reject(error);}
    return permission.then(async allowed=>{
        if(!allowed)return {status:'denied' as const};
        const downloads=env.downloads;
        if(!downloads?.download||!downloads.search||!downloads.cancel||!downloads.onChanged||!downloads.onErased)return {status:'unavailable' as const};
        const platform:MaterialBackupOpfsPlatform={
            acquire:()=>acquireLock(env.locks,name),
            async create(){
                const dir=await (await env.directory()).getDirectoryHandle(TEMP_DIRECTORY),file=await (await dir.getFileHandle(name)).getFile(),size=await readySize(dir,name);
                if(size===undefined||file.size!==size)throw new Error('临时材料备份未完成或无法验证，不能取回');
                return {write:async()=>{throw new Error('不能改写临时备份');},close:async()=>{},abort:async()=>{},file:async()=>file};
            },
            remove:async()=>{},objectURL:env.objectURL,revokeURL:env.revokeURL,
            startDownload:(url,downloadName)=>startObservedMaterialDownload(downloads,url,downloadName),randomId:env.randomId,now:env.now,
        };
        return {status:'ready' as const,target:await createMaterialBackupOpfsTarget(filename,platform)};
    });
}

export async function listFirefoxMaterialBackupLeftovers():Promise<MaterialBackupLeftoverList> {
    const env=firefoxEnvironment();if(!env)throw new Error('当前浏览器无法查看材料备份临时文件');
    return listMaterialBackupLeftovers(await env.directory());
}
export async function removeFirefoxMaterialBackupLeftover(name:string):Promise<void> {
    const env=firefoxEnvironment();if(!env)throw new Error('当前浏览器无法清理材料备份临时文件');
    await removeMaterialBackupLeftover(await env.directory(),env.locks,name);
}
export function beginFirefoxRecoveredMaterialBackup(name:string,filename:string):Promise<MaterialBrowserBackupChoice> {
    const env=firefoxEnvironment();return env?beginRecoveredMaterialBackup(name,filename,env):Promise.resolve({status:'unavailable'});
}
