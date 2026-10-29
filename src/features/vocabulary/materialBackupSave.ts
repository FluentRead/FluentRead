/**
 * @file src/features/vocabulary/materialBackupSave.ts
 * 文件职责：为经完整性校验的材料备份提供可取消的本地保存目标。
 * 主要内容：在用户动作中同步调用文件选择器并逐块写入，或在缺少选择器时将完整备份分块缓存后交给下载器；保存、仅发起下载和失败分别返回不同结果。
 * 模块边界：不打开浏览器端口、不校验文件摘要或声称下载已完成；调用方须先校验完整传输，下载器须如实报告状态；内存缓存随文件大小增长，浏览器下载兼容性由接线和验收决定。
 */
import {MaterialError} from './materialModel';
import {MATERIAL_READ_FRAME_BYTES} from './materialReadTransport';

export type MaterialBackupSaveState = 'saved'|'initiated';
export interface MaterialBackupWritable {
    write(chunk:Uint8Array):Promise<void>;
    close():Promise<void>;
    abort(reason?:unknown):Promise<void>;
}
export interface MaterialBackupSavePlatform {
    /** 调用时必须仍处于浏览器用户激活事件中。 */
    pick?: (options:{suggestedName:string; types:Array<{description:string;accept:Record<string,string[]>}>}) => Promise<{createWritable():Promise<MaterialBackupWritable>}>;
    /** 仅有完成证明时才返回 saved，返回后不再持有 parts；调用方负责浏览器内存与下载兼容性。 */
    downloadBuffered?: (name:string, parts:readonly Uint8Array[], signal:AbortSignal) => Promise<MaterialBackupSaveState>;
}
export interface MaterialBackupSaveTarget {
    write(chunk:Uint8Array):Promise<void>;
    commit(signal:AbortSignal):Promise<MaterialBackupSaveState>;
    abort(reason?:unknown):Promise<void>;
}
export type MaterialBackupConsumer = (consume:(chunk:Uint8Array)=>Promise<void>,signal:AbortSignal)=>Promise<void>;

function cancelled():DOMException {return new DOMException('材料导出已取消','AbortError');}
function check(signal:AbortSignal):void {if (signal.aborted) throw cancelled();}

/** 选择器或权限请求无法中断时，立即交还取消结果并清理迟到的保存目标。 */
export function waitForMaterialBackupTarget(pending:Promise<MaterialBackupSaveTarget>,signal?:AbortSignal,onLateCleanupError?:(error:unknown)=>void):Promise<MaterialBackupSaveTarget> {
    return new Promise((resolve,reject)=>{
        let settled=false,abandoned=false;
        const abort=()=>{
            if(settled)return;
            settled=true;abandoned=true;signal?.removeEventListener('abort',abort);reject(cancelled());
        };
        signal?.addEventListener('abort',abort,{once:true});
        void Promise.resolve(pending).then(target=>{
            if(abandoned){
                void Promise.resolve().then(()=>target.abort()).catch(error=>{
                    try {onLateCleanupError?.(error);} catch {/* 报告回调不能生成未处理拒绝。 */}
                });
                return;
            }
            settled=true;signal?.removeEventListener('abort',abort);resolve(target);
        },error=>{
            if(abandoned)return;
            settled=true;signal?.removeEventListener('abort',abort);reject(error);
        });
        if(signal?.aborted)abort();
    });
}

/** 这个调用会在返回 Promise 之前同步启动可用的浏览器选择器。 */
export async function chooseMaterialBackupTarget(name:string, platform:MaterialBackupSavePlatform):Promise<MaterialBackupSaveTarget> {
    if (typeof name !== 'string' || !name || name.length > 255) throw new MaterialError('invalid-input','材料备份文件名无效');
    if (platform.pick) {
        const handle = await platform.pick({suggestedName:name,types:[{description:'JSON',accept:{'application/json':['.json']}}]});
        const writable = await handle.createWritable();
        return {
            write:chunk=>writable.write(chunk),
            async commit() {await writable.close();return 'saved';},
            abort:reason=>writable.abort(reason),
        };
    }
    if (!platform.downloadBuffered) throw new MaterialError('storage-error','当前浏览器无法保存材料备份');
    const download = platform.downloadBuffered, parts:Uint8Array[] = [];
    let size = 0, finished = false, current:Uint8Array|undefined, used = 0;
    const release = () => {parts.length = 0;current = undefined;used = 0;size = 0;};
    return {
        async write(chunk) {
            if (finished) throw new MaterialError('storage-error','材料备份保存已结束');
            if (!Number.isSafeInteger(size + chunk.byteLength)) throw new MaterialError('limit-exceeded','材料备份超出当前保存容量限制');
            for (let offset = 0; offset < chunk.byteLength;) {
                current ??= new Uint8Array(64 * 1024);
                const length = Math.min(current.length-used,chunk.byteLength-offset);
                current.set(chunk.subarray(offset,offset+length),used);used += length;offset += length;
                if (used === current.length) {parts.push(current);current = undefined;used = 0;}
            }
            size += chunk.byteLength;
        },
        async commit(signal) {
            if (finished) throw new MaterialError('storage-error','材料备份保存已结束');
            finished = true;
            try {
                check(signal);
                if (current && used) parts.push(current.subarray(0,used));
                const state = await download(name,parts,signal);
                if (state !== 'saved' && state !== 'initiated') throw new MaterialError('storage-error','材料备份下载状态无效');
                return state;
            } finally {release();}
        },
        async abort() {finished = true;release();},
    };
}

/** 仅在 consume 确认完整成功、全部写入结束后提交；失败时等待底层写入及清理。 */
export async function saveMaterialBackup(target:MaterialBackupSaveTarget, receive:MaterialBackupConsumer, options:{signal?:AbortSignal} = {}):Promise<{state:MaterialBackupSaveState;bytes:number}> {
    const controller = new AbortController(), caller = options.signal;
    const abort = () => controller.abort();
    caller?.addEventListener('abort',abort,{once:true});
    if (caller?.aborted) abort();
    let pending:Promise<void>|undefined, failed = false, failure:unknown, bytes = 0, accepting = true;
    let writeFailedBeforeCancel = false, writeFailure:unknown;
    const reject = (error:unknown):Promise<void> => {
        if (!failed) {failed = true;failure = error;}
        const rejected = Promise.reject(error);void rejected.catch(()=>{});return rejected;
    };
    const consume = (chunk:Uint8Array):Promise<void> => {
        if (!accepting) return reject(new MaterialError('invalid-input','材料备份接收已结束'));
        if (failed) return reject(failure);
        if (pending) return reject(new MaterialError('invalid-input','材料备份写入顺序无效'));
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > MATERIAL_READ_FRAME_BYTES
            || !Number.isSafeInteger(bytes + chunk.byteLength)) return reject(new MaterialError('invalid-input','材料备份分片无效'));
        const copy = chunk.slice();
        const work = Promise.resolve().then(async()=>{check(controller.signal);await target.write(copy);check(controller.signal);bytes += copy.byteLength;});
        pending = work;
        void work.then(()=>{if(pending===work)pending=undefined;},error=>{
            if(!controller.signal.aborted && !writeFailedBeforeCancel){writeFailedBeforeCancel=true;writeFailure=error;}
            if(!failed){failed=true;failure=error;}if(pending===work)pending=undefined;
        });
        return work;
    };
    try {
        check(controller.signal);
        await receive(consume,controller.signal);
        accepting = false;
        check(controller.signal);
        if (pending) throw new MaterialError('invalid-input','材料备份写入尚未完成');
        if (failed) throw failure;
        // 一旦开始提交，取消可能已经来不及；只依据提交结果报告保存状态。
        const state = await target.commit(controller.signal);
        return {state,bytes};
    } catch (error) {
        accepting = false;
        // 写入错误已被观察后才取消时，传输层的取消不能掩盖它。
        let cause=error;
        if(writeFailedBeforeCancel){
            try {if((error as {name?:unknown}|null)?.name==='AbortError')cause=writeFailure;}
            catch {/* 不可信错误的 name 属性不能阻止清理或覆盖原错误。 */}
        }
        controller.abort();
        const cleanup = Promise.resolve().then(()=>target.abort(cause));
        const settled = await Promise.allSettled(pending ? [cleanup,pending] : [cleanup]);
        if (settled[0].status === 'rejected') throw Object.assign(new Error('材料备份未完成，清理失败，请检查保存位置是否存在不完整文件'),{name:'MaterialBackupSaveCleanupError',cause});
        throw cause;
    } finally {caller?.removeEventListener('abort',abort);}
}
