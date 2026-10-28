/**
 * @file src/features/vocabulary/materialBackupExportClient.ts
 * 文件职责：接收并校验后台分片发送的材料备份。
 * 主要内容：解析有界二进制数据帧与公开错误码，在传输摘要通过且成功终止后才报告完成。
 * 模块边界：不导入或访问后台仓库、不打开端口和文件；调用方必须先安装接收器再发送握手，并在错误时中止保存。
 */
import {MATERIAL_READ_FRAME_BYTES,receiveMaterialRead,type MaterialReadPort} from './materialReadTransport';
import {MATERIAL_BACKUP_EXPORT_ERROR_CODES,type MaterialBackupExportErrorCode} from './materialBackupExportProtocol';

export class MaterialBackupExportError extends Error {
    constructor(readonly code:MaterialBackupExportErrorCode) {
        super(code==='stale-operation'?'材料在导出期间已发生变化，请重试':'材料备份导出失败，请重试');
        this.name='MaterialBackupExportError';
    }
}
function aborted(signal?:AbortSignal):void {if(signal?.aborted)throw new DOMException('材料导出已取消','AbortError');}

/** 接收者必须先安装此函数的监听，再向后台发送 start。 */
export async function receiveMaterialBackupExport(port:MaterialReadPort, onChunk:(chunk:Uint8Array)=>Promise<void>, options:{signal?:AbortSignal;idleTimeoutMs?:number}={}):Promise<void> {
    let mode:'tag'|'length'|'data'|'error'|'done'|'failed' = 'tag', length = 0, lengthBytes = 0, remaining = 0;
    let failure:MaterialBackupExportErrorCode|undefined, bytes = 0;
    await receiveMaterialRead(port,async (chunk,signal)=>{
        for(let at=0;at<chunk.length;) {
            aborted(signal);
            if(mode === 'done' || mode === 'failed') throw Error('材料备份传输包含多余数据');
            if(mode === 'tag') {
                const tag=chunk[at++];
                if(tag===1){mode='length';length=0;lengthBytes=0;}
                else if(tag===2){if(!bytes)throw Error('材料备份传输不完整');mode='done';}
                else if(tag===3)mode='error';
                else throw Error('材料备份传输格式无效');
            } else if(mode === 'length') {
                length=length*256+chunk[at++];lengthBytes++;
                if(lengthBytes===4){if(!length||length>MATERIAL_READ_FRAME_BYTES)throw Error('材料备份分片长度无效');remaining=length;mode='data';}
            } else if(mode === 'data') {
                const count=Math.min(remaining,chunk.length-at);
                if(!Number.isSafeInteger(bytes+count))throw Error('材料备份过大');
                await onChunk(chunk.slice(at,at+count));aborted(signal);
                at+=count;remaining-=count;bytes+=count;
                if(!remaining)mode='tag';
            } else {
                const code=chunk[at++];
                if(code>=MATERIAL_BACKUP_EXPORT_ERROR_CODES.length)throw Error('材料备份错误代码无效');
                failure=MATERIAL_BACKUP_EXPORT_ERROR_CODES[code];mode='failed';
            }
        }
    },options);
    if(failure)throw new MaterialBackupExportError(failure);
    // 接收回调在异步消息处理时修改 mode；此函数在传输摘要确认后读取它。
    const complete=()=>mode==='done';
    if(!complete())throw Error('材料备份传输不完整');
}
