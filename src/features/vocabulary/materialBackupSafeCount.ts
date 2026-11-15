/**
 * @file src/features/vocabulary/materialBackupSafeCount.ts
 * 文件职责：为材料备份流程提供一致的安全整数边界校验。
 * 主要内容：检查备份字节和分片数量的安全整数精度，提供接收端累计字节的纯计算，并保留两条调用路径原有的错误类型和说明。
 * 模块边界：不分配存储、不移动流游标或选择恢复容量；接收方在数据交接成功后才提交已校验的下一计数。
 */
import {MaterialError} from './materialModel';

/** Guard backup byte and frame counts against precision loss. */
export function assertMaterialBackupSafeCount(value:number, message:string):void {
    if (!Number.isSafeInteger(value)) throw new MaterialError('limit-exceeded',message);
}

/** 在交接当前分片前检查下一计数，不需要分配超过整数上限的实际备份。 */
export function nextMaterialBackupExportByteCount(bytes:number,count:number):number {
    const next=bytes+count;
    if(!Number.isSafeInteger(next))throw Error('材料备份过大');
    return next;
}
