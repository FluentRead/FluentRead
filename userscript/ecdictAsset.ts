/**
 * @file userscript/ecdictAsset.ts
 * 文件职责：为油猴脚本构建提供离线可选词库（ECDICT）的零开销空桩，避免在单文件脚本中混入扩展专用的 CacheStorage/SHA-256 镜像下载器。
 * 主要内容：保持与 src/features/selection-translation/services/ecdictAsset.ts 相同的公开签名；油猴版本直接跳过本地离线词库缓存，由既有选词翻译流程处理。
 * 模块边界：仅供 userscript/vite.config.ts 构建期别名替换使用，不引入任何网络请求、加密哈希或存储依赖。
 */

export type EcdictCompactRow = readonly [string, string, string, string];

export function canCacheOptionalEcdict(): boolean {
    return false;
}

export async function readCachedFullEcdict(): Promise<EcdictCompactRow[] | null> {
    return null;
}

export async function downloadFullEcdict(): Promise<EcdictCompactRow[]> {
    throw new Error('Optional dictionary cache unavailable');
}
