/**
 * @file src/features/vocabulary/materialImportCapacity.ts
 * 文件职责：根据设备存储估计计算材料恢复的保守暂存预算。
 * 主要内容：限制协议容量，为最终材料写入和存储开销预留空间，估计不可用时采用固定回退值。
 * 模块边界：纯函数不读取设备、不预约空间；真实配额失败必须由数据库事务处理。
 */
import {MATERIAL_IMPORT_FRAME_BYTES, MATERIAL_IMPORT_MAX_FRAMES, MATERIAL_IMPORT_MAX_TOTAL_BYTES} from './materialProtocol';

const HEADROOM_BYTES = 128 * 1024 * 1024;
const SPACE_MULTIPLIER = 3;

/** 估计是全 origin 的瞬时提示，并不保证后续写入一定成功。 */
export function materialImportCapacity(estimate: unknown): number {
    try {
        if (!estimate || typeof estimate !== 'object') return MATERIAL_IMPORT_MAX_TOTAL_BYTES;
        const {quota, usage} = estimate as {quota?: unknown; usage?: unknown};
        if (typeof quota !== 'number' || typeof usage !== 'number'
            || !Number.isFinite(quota) || !Number.isFinite(usage)
            || quota < 0 || usage < 0 || quota > Number.MAX_SAFE_INTEGER || usage > Number.MAX_SAFE_INTEGER)
            return MATERIAL_IMPORT_MAX_TOTAL_BYTES;
        const free = Math.max(0, Math.floor(quota) - Math.ceil(usage) - HEADROOM_BYTES);
        return Math.min(MATERIAL_IMPORT_MAX_FRAMES * MATERIAL_IMPORT_FRAME_BYTES, Math.floor(free / SPACE_MULTIPLIER));
    } catch {
        return MATERIAL_IMPORT_MAX_TOTAL_BYTES;
    }
}
