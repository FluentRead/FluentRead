/**
 * @file src/features/vocabulary/materialBackupOpfsSave.ts
 * 文件职责：为已有下载完成确认能力的浏览器提供私有临时文件形式的材料备份保存目标。
 * 主要内容：逐块写入临时文件，在完整性校验后启动下载，仅在下载确认完成后报告保存，并在确定终态后清理。
 * 模块边界：不申请浏览器权限、不实现下载监听、不假定文件或对象 URL 零拷贝；调用方负责提供跨页面互斥锁和可证明下载终态的适配器。
 */
import type {MaterialBackupSaveTarget, MaterialBackupWritable} from './materialBackupSave';

const PREFIX='fluentread-material-backup-v1-';
const FILE_PATTERN=/^fluentread-material-backup-v1-(\d{13})-([a-f0-9]{32})\.tmp$/u;
export function materialBackupTemporaryFileTime(name:string):number|undefined {
    const match=FILE_PATTERN.exec(name);
    return match ? Number(match[1]) : undefined;
}
const cancelled=()=>new DOMException('材料导出已取消','AbortError');
export type MaterialBackupDownloadTerminal='complete'|'interrupted';
/** 仅用于能确认尚未调用浏览器下载接口的失败。 */
export class MaterialBackupDownloadNotStartedError extends Error {
    constructor(message:string,cause?:unknown){super(message);this.name='MaterialBackupDownloadNotStartedError';if(cause!==undefined)Object.assign(this,{cause});}
}
export interface MaterialBackupOpfsDownload {
    /** 返回后必须能够观察到终态，包括下载在 start 返回前已结束的情况。拒绝表示尚未启动下载。 */
    wait():Promise<MaterialBackupDownloadTerminal>;
    cancel():Promise<void>;
}
export interface MaterialBackupOpfsPlatform {
    /** 锁必须跨同源上下文共享，并在上下文终止后自动释放。 */
    acquire(name:string):Promise<(()=>void)|undefined>;
    /** 必须只创建新文件；遇到同名文件时拒绝，不覆盖已有条目。 */
    create(name:string):Promise<MaterialBackupWritable & {file():Promise<Blob>}>;
    remove(name:string):Promise<void>;
    /** 在已校验的写入关闭后持久化完成标记，供中断后识别可取回的文件。 */
    markReady?(name:string,file:Blob):Promise<void>;
    objectURL(file:Blob):string;
    revokeURL(url:string):void;
    /** 拒绝时下载状态视为未知，调用方保留 URL 和源文件。 */
    startDownload(url:string, name:string):Promise<MaterialBackupOpfsDownload>;
    randomId():string;
    now():number;
}
/** 创建后持有文件锁，直到下载终态及临时文件清理均已确定。 */
export async function createMaterialBackupOpfsTarget(filename:string,platform:MaterialBackupOpfsPlatform,options:{startTimeoutMs?:number}={}):Promise<MaterialBackupSaveTarget> {
    const startTimeoutMs=options.startTimeoutMs ?? 30000;
    if(!Number.isSafeInteger(startTimeoutMs)||startTimeoutMs<1)throw new Error('材料备份下载启动时限无效');
    const id=platform.randomId(), now=platform.now();
    if (!filename || filename.length>255 || !/^[a-f0-9]{32}$/u.test(id) || !Number.isSafeInteger(now) || now<1000000000000 || now>9999999999999) throw new Error('材料备份临时文件参数无效');
    const name=`${PREFIX}${now}-${id}.tmp`, release=await platform.acquire(name);
    if (!release) throw new Error('材料备份临时文件正在使用');
    let writable:Awaited<ReturnType<MaterialBackupOpfsPlatform['create']>>;
    try {writable=await platform.create(name);} catch(error) {release();throw error;}
    let stage:'writing'|'committing'|'done'|'unknown'='writing', open=true, url:string|undefined, inFlight:Promise<void>|undefined;
    let cleanupTask:Promise<void>|undefined;
    const canCleanup=()=>stage!=='unknown'&&stage!=='done';
    const cleanup=():Promise<void>=>cleanupTask ??= (async()=>{
        if (inFlight) await inFlight.catch(()=>{});
        if (open) {await writable.abort();open=false;}
        if (url!==undefined) {platform.revokeURL(url);url=undefined;}
        await platform.remove(name);
        release();stage='done';
    })();
    return {
        async write(chunk) {
            if(stage!=='writing'||inFlight) throw new Error('材料备份写入状态无效');
            const task=writable.write(chunk);inFlight=task;
            try {await task;} finally {if(inFlight===task)inFlight=undefined;}
        },
        async commit(signal) {
            if(stage!=='writing'||inFlight) throw new Error('材料备份提交状态无效');
            stage='committing';
            try {
                if(signal.aborted) throw cancelled();
                await writable.close();open=false;
                if(signal.aborted) throw cancelled();
                const file=await writable.file();
                await platform.markReady?.(name,file);
                url=platform.objectURL(file);
                if(signal.aborted) throw cancelled();
                let download:MaterialBackupOpfsDownload;
                const pendingStart=Promise.resolve().then(()=>platform.startDownload(url!,filename));
                let abandoned=false;
                try {
                    download=await new Promise<MaterialBackupOpfsDownload>((resolve,reject)=>{
                        let settled=false;
                        const finish=(fn:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancelStart);fn();};
                        const cancelStart=()=>finish(()=>{abandoned=true;reject(cancelled());});
                        const timer=setTimeout(()=>finish(()=>{abandoned=true;reject(new Error('下载启动超时'));}),startTimeoutMs);
                        signal.addEventListener('abort',cancelStart,{once:true});
                        void pendingStart.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
                    });
                }
                catch(error) {
                    if(error instanceof MaterialBackupDownloadNotStartedError)throw error;
                    // 启动请求失败不证明浏览器没有接收请求；保留源文件和 URL。
                    stage='unknown';
                    if(abandoned)void pendingStart.then(async late=>{
                        try {
                            void Promise.resolve().then(()=>late.cancel()).catch(()=>{});
                            const terminal=await late.wait();
                            if(terminal==='complete'||terminal==='interrupted')await cleanup();
                        }catch{/* 无法确认终态时保留文件与锁。 */}
                    },async error=>{if(error instanceof MaterialBackupDownloadNotStartedError)try{await cleanup();}catch{/* 清理失败后保留剩余文件。 */}});
                    throw Object.assign(new Error('无法确认材料备份下载是否已开始，临时文件已保留，请检查浏览器下载'),{cause:error});
                }
                let cancelTask:Promise<void>|undefined;
                const cancel=()=>{cancelTask ??= Promise.resolve().then(()=>download.cancel());void cancelTask.catch(()=>{});};
                signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
                let terminal:MaterialBackupDownloadTerminal;
                try {terminal=await download.wait();}
                catch(error) {stage='unknown';throw error;}
                finally {signal.removeEventListener('abort',cancel);}
                if(terminal!=='complete'&&terminal!=='interrupted'){stage='unknown';throw new Error('无法确认材料备份下载状态');}
                if(terminal==='interrupted') throw signal.aborted?cancelled():new Error('材料备份下载中断');
                try {await cleanup();} catch(error) {stage='unknown';throw Object.assign(new Error('材料备份已下载，但临时文件清理失败'),{name:'MaterialBackupOpfsCleanupError',cause:error});}
                return 'saved';
            } catch(error) {
                if(canCleanup()) await cleanup();
                throw error;
            }
        },
        async abort() {if(stage==='unknown'||stage==='done')return;if(stage==='committing')throw new Error('材料备份提交尚未结束');await cleanup();},
    };
}
