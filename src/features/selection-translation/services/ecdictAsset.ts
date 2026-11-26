/**
 * @file src/features/selection-translation/services/ecdictAsset.ts
 * 文件职责：在词卡首次需要离线词库时，通过国内外四路冗余镜像下载固定版本的纯 JSON 数据并校验后缓存。
 * 主要内容：复用统一多镜像优选排序与有界流校验，限制响应体积与下载时长、验证 SHA-256、复用 CacheStorage 中的可信副本，并允许镜像失败后自动回退重试。
 * 模块边界：只处理可选词库资产，不传输查询词、不解析词义，也不加载远程脚本或 WASM。
 */
import {buildGithubAssetMirrorUrls, detectPreferredMirrorLocale} from '@/src/core/assets/mirrors';
import {
    canUseVerifiedAssetCache,
    downloadVerifiedAsset,
    readVerifiedCachedAsset,
    type VerifiedAssetSpec,
} from '@/src/platform/assets/verifiedAssetCache';

export type EcdictCompactRow = readonly [string, string, string, string];

const REPOSITORY = 'FluentRead/FluentRead';
const REVISION = '0c0336c1d77574f1706eeb49c9256cc000531b4f';
const RESOURCE = 'public/ecdict-core.json';
const FULL_BYTES = 3_913_556;
const FULL_SHA256 = 'b0f0768e6730dfd07b895527ff56169f4d44904c58532b4cdd750aa97374071a';
const CACHE_NAME = 'fluentread-optional-dictionary-v1';
const CACHE_KEY = `https://fluentread.app/__optional_assets__/ecdict/${FULL_SHA256}.json`;
const DOWNLOAD_TIMEOUT_MS = 12_000;

function ecdictAssetSpec(): VerifiedAssetSpec {
    return {
        id: 'optional-ecdict',
        cacheName: CACHE_NAME,
        cacheKey: CACHE_KEY,
        bytes: FULL_BYTES,
        sha256: FULL_SHA256,
        contentType: 'application/json',
        urls: buildGithubAssetMirrorUrls(REPOSITORY, REVISION, RESOURCE, detectPreferredMirrorLocale()),
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
    };
}

function decodeRows(bytes: Uint8Array<ArrayBuffer>): EcdictCompactRow[] {
    // VerifiedAssetCache 已保证精确字节数与固定 SHA-256 摘要，直接解码不可变 JSON。
    return JSON.parse(new TextDecoder().decode(bytes)) as EcdictCompactRow[];
}

export function canCacheOptionalEcdict(): boolean {
    return canUseVerifiedAssetCache();
}

/** 只读取已校验的本地副本；缓存损坏时删除，下次可重新下载。 */
export async function readCachedFullEcdict(): Promise<EcdictCompactRow[] | null> {
    if (!canCacheOptionalEcdict()) return null;
    const bytes = await readVerifiedCachedAsset(ecdictAssetSpec());
    return bytes ? decodeRows(bytes) : null;
}

/** 后台下载不含用户查询词的固定词库资产；按国内外多镜像顺序故障转移。 */
export async function downloadFullEcdict(): Promise<EcdictCompactRow[]> {
    if (!canCacheOptionalEcdict()) throw new Error('Optional dictionary cache unavailable');
    try {
        const bytes = await downloadVerifiedAsset(ecdictAssetSpec());
        return decodeRows(bytes);
    } catch (error) {
        throw new Error('Optional dictionary sources unavailable', {cause: error});
    }
}
