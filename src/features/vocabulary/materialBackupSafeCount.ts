/**
 * @file src/features/vocabulary/materialBackupSafeCount.ts
 * 文件职责：为材料备份流程提供一致的安全整数边界校验。
 * 主要内容：检查备份字节和分片数量是否保持安全整数精度，并保留调用方指定的超限错误说明。
 * 模块边界：不执行计数累加、分配存储或选择恢复容量；调用方负责在原操作顺序中传入已计算的数值。
 */
import {MaterialError} from './materialModel';

/** Guard backup byte and frame counts against precision loss. */
export function assertMaterialBackupSafeCount(value:number, message:string):void {
    if (!Number.isSafeInteger(value)) throw new MaterialError('limit-exceeded',message);
}
