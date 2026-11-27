/**
 * @file src/features/document-translation/services/pdfBinaryDataFactory.ts
 * 文件职责：为 PDF.js 6 提供受限二进制数据工厂，按需经国内外多镜像下载并校验 CMap 与标准字体，同时保持图像解码 WASM 仅从本地加载。
 * 主要内容：绑定 pdfjs-dist 固定版本 168 份 .bcmap 与 14 份标准字体的字节长度及 SHA-256 清单，支持内存缓存与 CacheStorage 持久化；独立桌面端自定义本地根目录时优先读取本地资源。
 * 模块边界：只向 PDF.js 提供只读字节流，不下载或执行远程脚本/WASM；wasmUrl 分支永远只读取扩展自有本地资源。
 */

import {buildNpmAssetMirrorUrls, detectPreferredMirrorLocale} from '@/src/core/assets/mirrors';
import {fetchVerifiedAsset, type VerifiedAssetCacheDependencies} from '@/src/platform/assets/verifiedAssetCache';
import manifest from './pdfBinaryDataManifest.json';

type PdfBinaryAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

interface ManifestEntry {
    readonly bytes: number;
    readonly sha256: string;
}

interface PdfBinaryManifest {
    readonly version: string;
    readonly cmaps: Readonly<Record<string, ManifestEntry>>;
    readonly standard_fonts: Readonly<Record<string, ManifestEntry>>;
}

const typedManifest = manifest as PdfBinaryManifest;

export const PDFJS_REMOTE_ASSET_VERSION = typedManifest.version;
export const PDFJS_REMOTE_ASSET_CACHE = `fluentread-pdfjs-assets-${typedManifest.version}-v1`;

const memoryAssetCache = new Map<string, Uint8Array<ArrayBuffer>>();
const inFlightMemoryAssets = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const MAX_MEMORY_CACHE_ENTRIES = 64;
const FETCH_LOCAL_SCHEME_PATTERN = /^(?:https?|chrome-extension|moz-extension|safari-web-extension):/iu;

function readMemoryAsset(key: string): Uint8Array<ArrayBuffer> | undefined {
    const existing = memoryAssetCache.get(key);
    if (!existing) return undefined;
    // 命中后刷新 LRU 顺序，避免常用 CMap/字体被较晚打开的冷门字体挤出。
    memoryAssetCache.delete(key);
    memoryAssetCache.set(key, existing);
    return existing;
}

function writeMemoryAsset(key: string, bytes: Uint8Array<ArrayBuffer>): void {
    memoryAssetCache.delete(key);
    memoryAssetCache.set(key, bytes);
    while (memoryAssetCache.size > MAX_MEMORY_CACHE_ENTRIES) {
        const oldestKey = memoryAssetCache.keys().next().value!;
        memoryAssetCache.delete(oldestKey);
    }
}

function fetchLocalBytesViaXhr(url: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
            if ((xhr.status === 200 || xhr.status === 0) && xhr.response instanceof ArrayBuffer) {
                resolve(new Uint8Array(xhr.response));
                return;
            }
            reject(new Error(`Local PDF.js asset unavailable: HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error(`Local PDF.js asset unavailable: ${url}`));
        xhr.send(null);
    });
}

export interface PdfBinaryDataFactoryOptions {
    readonly preferLocalDataAssets?: boolean;
    readonly locale?: () => string;
    readonly deps?: VerifiedAssetCacheDependencies;
    readonly localFetch?: typeof fetch;
}

export interface PdfBinaryDataFactoryConstructor {
    new(params?: {
        cMapUrl?: string | null;
        standardFontDataUrl?: string | null;
        wasmUrl?: string | null;
    }): {
        fetch(request: {kind: PdfBinaryAssetKind; filename: string}): Promise<Uint8Array>;
    };
}

function getManifestEntry(kind: 'cMapUrl' | 'standardFontDataUrl', filename: string): {
    readonly directory: 'cmaps' | 'standard_fonts';
    readonly contentType: string;
    readonly entry: ManifestEntry;
} {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        throw new Error(`Invalid PDF.js binary asset filename: ${filename}`);
    }
    const directory = kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts';
    const table = kind === 'cMapUrl' ? typedManifest.cmaps : typedManifest.standard_fonts;
    const entry = Object.hasOwn(table, filename) ? table[filename] : undefined;
    if (!entry) {
        throw new Error(`Unsupported PDF.js binary asset: ${directory}/${filename}`);
    }
    const contentType = kind === 'cMapUrl'
        ? 'application/octet-stream'
        : filename.endsWith('.ttf')
            ? 'font/ttf'
            : 'application/octet-stream';
    return {directory, contentType, entry};
}

async function fetchLocalBytes(url: string, fetchImpl: typeof fetch, allowXhrFallback: boolean): Promise<Uint8Array<ArrayBuffer>> {
    // Zotero 等 Gecko 独立应用使用 chrome:// 本地协议，标准 fetch 会直接拒绝；按 PDF.js 原生做法回退 XHR 读取 ArrayBuffer。
    if (allowXhrFallback && !FETCH_LOCAL_SCHEME_PATTERN.test(url) && typeof XMLHttpRequest === 'function') {
        return fetchLocalBytesViaXhr(url);
    }
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Local PDF.js asset unavailable: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** 构造可传入 pdfjs-dist getDocument({BinaryDataFactory}) 的受限数据工厂。 */
export function createPdfBinaryDataFactory(options: PdfBinaryDataFactoryOptions = {}): PdfBinaryDataFactoryConstructor {
    const preferLocalDataAssets = options.preferLocalDataAssets === true;
    const getLocale = options.locale ?? detectPreferredMirrorLocale;
    const allowXhrFallback = !options.localFetch;
    const localFetch = options.localFetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

    return class FluentReadPdfBinaryDataFactory {
        readonly cMapUrl: string | null;
        readonly standardFontDataUrl: string | null;
        readonly wasmUrl: string | null;

        constructor(params: {
            cMapUrl?: string | null;
            standardFontDataUrl?: string | null;
            wasmUrl?: string | null;
        } = {}) {
            this.cMapUrl = params.cMapUrl ?? null;
            this.standardFontDataUrl = params.standardFontDataUrl ?? null;
            this.wasmUrl = params.wasmUrl ?? null;
        }

        async fetch({kind, filename}: {kind: PdfBinaryAssetKind; filename: string}): Promise<Uint8Array> {
            // 图像解码 WASM 永远只从扩展自身本地目录读取，绝不走网络。
            if (kind === 'wasmUrl') {
                if (!this.wasmUrl) throw new Error('Ensure that the `wasmUrl` API parameter is provided.');
                return fetchLocalBytes(`${this.wasmUrl}${filename}`, localFetch, allowXhrFallback);
            }
            if (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl') {
                throw new Error(`Unsupported PDF.js binary asset kind: ${String(kind)}`);
            }

            const {directory, contentType, entry} = getManifestEntry(kind, filename);
            const memoryKey = `${directory}/${filename}:${entry.sha256}`;
            const inMemory = readMemoryAsset(memoryKey);
            // PDF.js 会将返回的 Uint8Array 底层 buffer transfer 给 Worker，必须返回独立副本以保护内存缓存。
            if (inMemory) return inMemory.slice();

            const loadAsset = async (): Promise<Uint8Array<ArrayBuffer>> => {
                const localBase = this[kind];
                if (preferLocalDataAssets && localBase) {
                    try {
                        const localBytes = await fetchLocalBytes(`${localBase}${filename}`, localFetch, allowXhrFallback);
                        if (localBytes.byteLength === entry.bytes) {
                            writeMemoryAsset(memoryKey, localBytes);
                            return localBytes;
                        }
                    } catch {
                        // 自定义本地目录缺失时回退到受校验的固定版本多镜像下载。
                    }
                }

                const relativePath = `${directory}/${filename}`;
                const bytes = await fetchVerifiedAsset({
                    id: `pdfjs:${relativePath}`,
                    cacheName: PDFJS_REMOTE_ASSET_CACHE,
                    cacheKey: `https://fluentread.app/__optional_assets__/pdfjs/${PDFJS_REMOTE_ASSET_VERSION}/${relativePath}?sha256=${entry.sha256}`,
                    bytes: entry.bytes,
                    sha256: entry.sha256,
                    contentType,
                    urls: buildNpmAssetMirrorUrls('pdfjs-dist', PDFJS_REMOTE_ASSET_VERSION, relativePath, getLocale()),
                    timeoutMs: 12_000,
                }, options.deps);

                if (!options.deps) writeMemoryAsset(memoryKey, bytes);
                return bytes;
            };

            if (options.deps) return (await loadAsset()).slice();
            const existing = inFlightMemoryAssets.get(memoryKey);
            if (existing) return existing.then(bytes => bytes.slice());
            const pending = loadAsset().finally(() => {
                inFlightMemoryAssets.delete(memoryKey);
            });
            inFlightMemoryAssets.set(memoryKey, pending);
            return pending.then(bytes => bytes.slice());
        }
    };
}

/** 仅供测试清理会话内 PDF.js 纯数据内存缓存。 */
export function clearPdfBinaryDataMemoryCache(): void {
    memoryAssetCache.clear();
    inFlightMemoryAssets.clear();
}
