/**
 * @file src/features/selection-translation/services/ecdictAsset.ts
 * 文件职责：在词卡首次需要扩展词库时，下载固定版本的纯 JSON 数据并校验后缓存。
 * 主要内容：限制响应体积与下载时长、验证 SHA-256、复用 CacheStorage 中的可信副本，并允许镜像失败后重试。
 * 模块边界：只处理可选词库资产，不传输查询词、不解析词义，也不加载远程脚本或 WASM。
 */
import {cancelResponseReader, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';

export type EcdictCompactRow = readonly [string, string, string, string];

const REVISION = '0c0336c1d77574f1706eeb49c9256cc000531b4f';
const RESOURCE = 'public/ecdict-core.json';
const FULL_BYTES = 3_913_556;
const FULL_SHA256 = 'b0f0768e6730dfd07b895527ff56169f4d44904c58532b4cdd750aa97374071a';
const CACHE_NAME = 'fluentread-optional-dictionary-v1';
const CACHE_KEY = `https://fluentread.app/__optional_assets__/ecdict/${FULL_SHA256}.json`;
const DOWNLOAD_TIMEOUT_MS = 12_000;
const SOURCES = [
    `https://cdn.jsdmirror.com/gh/FluentRead/FluentRead@${REVISION}/${RESOURCE}`,
    `https://raw.githubusercontent.com/FluentRead/FluentRead/${REVISION}/${RESOURCE}`,
    `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${REVISION}/${RESOURCE}`,
] as const;

export function canCacheOptionalEcdict(): boolean {
    return typeof globalThis.caches?.open === 'function' && typeof globalThis.crypto?.subtle?.digest === 'function';
}

async function verifiedRows(bytes: Uint8Array): Promise<EcdictCompactRow[]> {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
        byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== FULL_SHA256) throw new Error('Optional dictionary integrity mismatch');
    // readBounded 已保证字节数；固定摘要绑定仓库审计过的完整 JSON，
    // 无须在每次缓存命中时再次遍历 20,000 行验证相同的不可变结构。
    return JSON.parse(new TextDecoder().decode(bytes)) as EcdictCompactRow[];
}

async function readBounded(response: Response): Promise<Uint8Array> {
    if (!response.ok) {cancelUnreadResponseBody(response); throw new Error(`Optional dictionary HTTP ${response.status}`);}
    if (!response.body) throw new Error('Optional dictionary response body missing');
    const reader = response.body.getReader();
    const bytes = new Uint8Array(FULL_BYTES);
    let offset = 0;
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (offset + value.byteLength > FULL_BYTES) throw new Error('Optional dictionary response too large');
            bytes.set(value, offset);
            offset += value.byteLength;
        }
    } finally {
        cancelResponseReader(reader);
    }
    if (offset !== FULL_BYTES) throw new Error('Optional dictionary response incomplete');
    return bytes;
}

/** 只读取已校验的本地副本；缓存损坏时删除，下次可重新下载。 */
export async function readCachedFullEcdict(): Promise<EcdictCompactRow[] | null> {
    if (!canCacheOptionalEcdict()) return null;
    try {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(CACHE_KEY);
        if (!response) return null;
        try {
            return await verifiedRows(await readBounded(response));
        } catch {
            await cache.delete(CACHE_KEY).catch(() => {});
            return null;
        }
    } catch {
        return null;
    }
}

/** 后台下载不含用户查询词的固定词库资产；镜像不可用时继续尝试下一个来源。 */
export async function downloadFullEcdict(): Promise<EcdictCompactRow[]> {
    if (!canCacheOptionalEcdict()) throw new Error('Optional dictionary cache unavailable');
    let lastError: unknown;
    for (const url of SOURCES) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        try {
            const response = await runtimeFetch(url, {
                credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
            });
            const bytes = await readBounded(response);
            const rows = await verifiedRows(bytes);
            try {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(CACHE_KEY, new Response(bytes, {headers: {'Content-Type': 'application/json'}}));
            } catch {
                // 当前后台会话仍可使用已校验的数据；下次再尝试持久化。
            }
            return rows;
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error('Optional dictionary sources unavailable', {cause: lastError});
}
