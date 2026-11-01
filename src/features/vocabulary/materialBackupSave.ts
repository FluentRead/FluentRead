/**
 * @file src/features/vocabulary/materialBackupSave.ts
 * 文件职责：为经完整性校验的材料备份提供可取消的本地保存目标。
 * 主要内容：在用户动作中同步调用文件选择器并逐块写入；回退仅缓冲有限字节，超额后迁移到落盘目标，保存、仅发起下载和失败分别返回不同结果。
 * 模块边界：不打开浏览器端口、不校验文件摘要或声称下载已完成；调用方须先校验完整传输，落盘与下载的兼容性及终态由平台适配器负责。
 */
import {MaterialError} from './materialModel';
import {assertMaterialBackupSafeCount} from './materialBackupSafeCount';
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
    /** 缓冲预算用尽后创建落盘目标；不限制整份备份的字节数。 */
    spill?: (name:string) => Promise<MaterialBackupSaveTarget>;
}
export interface MaterialBackupSaveTarget {
    /** 批量迁移在各次原子写入前复验信号；已经开始的写入仍须结算。 */
    write(chunk:Uint8Array,signal?:AbortSignal):Promise<void>;
    commit(signal:AbortSignal):Promise<MaterialBackupSaveState>;
    abort(reason?:unknown):Promise<void>;
}
export type MaterialBackupConsumer = (consume:(chunk:Uint8Array)=>Promise<void>,signal:AbortSignal)=>Promise<void>;
/** 限制应用持有的原始字节，不作为整份备份或浏览器总内存上限。 */
export const MATERIAL_BACKUP_BUFFER_BYTES = 8 * 1024 * 1024;

function cancelled():DOMException {return new DOMException('材料导出已取消','AbortError');}
function check(signal?:AbortSignal,locallyCancelled=false):void {if (locallyCancelled || signal?.aborted) throw cancelled();}
function removeAbortListener(signal:AbortSignal|undefined, listener:()=>void):void {
    try {signal?.removeEventListener('abort',listener);} catch {/* Preserve the operation result. */}
}

/** 选择器或权限请求无法中断时，立即交还取消结果并清理迟到的保存目标。 */
export function waitForMaterialBackupTarget(pending:Promise<MaterialBackupSaveTarget>,signal?:AbortSignal,onLateCleanupError?:(error:unknown)=>void):Promise<MaterialBackupSaveTarget> {
    return new Promise((resolve,reject)=>{
        let settled=false,abandoned=false;
        const abort=()=>{
            if(settled)return;
            settled=true;abandoned=true;removeAbortListener(signal,abort);reject(cancelled());
        };
        void Promise.resolve(pending).then(target=>{
            if(abandoned){
                void Promise.resolve().then(()=>target.abort()).catch(error=>{
                    try {onLateCleanupError?.(error);} catch {/* 报告回调不能生成未处理拒绝。 */}
                });
                return;
            }
            settled=true;removeAbortListener(signal,abort);resolve(target);
        },error=>{
            if(abandoned)return;
            settled=true;removeAbortListener(signal,abort);reject(error);
        });
        try {
            if(signal?.aborted)abort();
            else {
                try {signal?.addEventListener('abort',abort,{once:true});}
                catch(error) {
                    let aborted=false;
                    if(!settled)try {aborted=signal?.aborted===true;} catch {/* Preserve the first failure. */}
                    if(aborted)abort();
                    throw error;
                }
                if(!settled&&signal?.aborted)abort();
            }
        } catch(error) {
            if(!settled){settled=true;abandoned=true;removeAbortListener(signal,abort);reject(error);}
        }
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
    let size = 0, finished = false, writing = false, current:Uint8Array|undefined, used = 0;
    let disk:MaterialBackupSaveTarget|undefined;
    let pending:Promise<void>|undefined;
    let writeFailed=false,writeFailure:unknown;
    const release = () => {parts.length = 0;current = undefined;used = 0;size = 0;};
    return {
        async write(chunk,signal) {
            if (finished) throw new MaterialError('storage-error','材料备份保存已结束');
            if (writing) throw new MaterialError('storage-error','材料备份写入尚未结束');
            if (writeFailed) throw writeFailure;
            check(signal);
            const nextSize = size + chunk.byteLength;
            assertMaterialBackupSafeCount(nextSize,'材料备份超出当前保存容量限制');
            if (disk || size + chunk.byteLength > MATERIAL_BACKUP_BUFFER_BYTES) {
                if (!disk && !platform.spill) throw Object.assign(new MaterialError('limit-exceeded','当前浏览器无法为大备份创建临时文件。请使用支持直接保存或私有文件存储的浏览器重试，原材料未更改。'),{name:'MaterialBackupBufferCapacityError'});
                writing = true;
                const work = Promise.resolve().then(async()=>{
                    check(signal,finished);
                    if (!disk) {
                        disk = await platform.spill!(name);
                        check(signal,finished);
                        for (const part of parts) {check(signal,finished);await disk.write(part,signal);}
                        if (current && used) {check(signal,finished);await disk.write(current.subarray(0,used),signal);}
                        release();
                    }
                    check(signal,finished);
                    await disk.write(chunk,signal);
                });
                pending = work;
                try {await work;size = nextSize;}
                catch(error){writeFailed=true;writeFailure=error;}
                finally {writing = false;pending = undefined;}
                if(writeFailed)throw writeFailure;
                return;
            }
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
            if (writing) throw new MaterialError('storage-error','材料备份写入尚未结束');
            if (writeFailed) throw writeFailure;
            finished = true;
            try {
                check(signal);
                if (disk) return await disk.commit(signal);
                if (current && used) parts.push(current.subarray(0,used));
                const state = await download(name,parts,signal);
                if (state !== 'saved' && state !== 'initiated') throw new MaterialError('storage-error','材料备份下载状态无效');
                return state;
            } finally {release();}
        },
        async abort(reason) {finished = true;try {await pending?.catch(()=>{});await disk?.abort(reason);} finally {release();}},
    };
}

/** 仅在 consume 确认完整成功、全部写入结束后提交；失败时等待底层写入及清理。 */
export async function saveMaterialBackup(target:MaterialBackupSaveTarget, receive:MaterialBackupConsumer, options:{signal?:AbortSignal} = {}):Promise<{state:MaterialBackupSaveState;bytes:number}> {
    const controller = new AbortController(), caller = options.signal;
    const abort = () => controller.abort();
    let state:MaterialBackupSaveState;
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
        const work = Promise.resolve().then(async()=>{check(controller.signal);await target.write(copy,controller.signal);check(controller.signal);bytes += copy.byteLength;});
        pending = work;
        void work.then(()=>{if(pending===work)pending=undefined;},error=>{
            if(!controller.signal.aborted && !writeFailedBeforeCancel){writeFailedBeforeCancel=true;writeFailure=error;}
            if(!failed){failed=true;failure=error;}if(pending===work)pending=undefined;
        });
        return work;
    };
    try {
        if(caller?.aborted)abort();
        else {
            try {caller?.addEventListener('abort',abort,{once:true});}
            catch(error) {
                let aborted=controller.signal.aborted;
                if(!aborted)try {aborted=caller?.aborted===true;} catch {/* Preserve the first failure. */}
                if(aborted)throw cancelled();
                throw error;
            }
            check(controller.signal);
            if(caller?.aborted)abort();
        }
        check(controller.signal);
        await receive(consume,controller.signal);
        accepting = false;
        check(controller.signal);
        if (pending) throw new MaterialError('invalid-input','材料备份写入尚未完成');
        if (failed) throw failure;
        // 一旦开始提交，取消可能已经来不及；只依据提交结果报告保存状态。
        state = await target.commit(controller.signal);
    } catch (error) {
        accepting = false;
        // 写入错误已被观察后才取消时，传输层的取消不能掩盖它。
        let cause=error;
        if(writeFailedBeforeCancel){
            try {if((error as {name?:unknown}|null)?.name==='AbortError')cause=writeFailure;}
            catch {/* 不可信错误的 name 属性不能阻止清理或覆盖原错误。 */}
        }
        // 失败后由内部信号终止工作；等待写入或保存目标清理时释放调用方监听。
        removeAbortListener(caller,abort);
        controller.abort();
        const cleanup = Promise.resolve().then(()=>target.abort(cause));
        const settled = await Promise.allSettled(pending ? [cleanup,pending] : [cleanup]);
        if (settled[0].status === 'rejected') throw Object.assign(new Error('材料备份未完成，清理失败，请检查保存位置是否存在不完整文件'),{name:'MaterialBackupSaveCleanupError',cause});
        throw cause;
    }
    removeAbortListener(caller,abort);
    return {state,bytes};
}
