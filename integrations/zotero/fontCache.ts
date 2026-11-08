/**
 * @file integrations/zotero/fontCache.ts
 * 文件职责：为 Zotero 无 CacheStorage 的内容窗口提供 PDF 字体的会话复用与 profile 文件缓存。
 * 主要内容：把固定摘要字体映射为 Cache 的响应端口，私有目录内原子写入；下载、大小限制、摘要校验、损坏修复和取消仍由共享字体加载器处理，已验证字节只以副本交给调用方。
 * 模块边界：不访问 Zotero 全局、文献内容或凭据；宿主显式注入文件 API 和缓存目录，缓存不可用时仍可使用经过校验的会话字体。
 */
import {asArrayBufferBytes} from '../../src/shared/function/arrayBufferBytes';
import {createPdfReadingFontLoader, PDF_READING_FONT_BYTES, PDF_READING_FONT_CACHE_KEY,
    PDF_READING_FONT_SHA256} from '../../src/features/document-translation/services/pdfReadingFont';

export type ZoteroFontLoader = (signal?: AbortSignal) => Promise<Uint8Array>;

export interface ZoteroFontIO {
    read(path: string, options?: Record<string, unknown>): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array, options?: Record<string, unknown>): Promise<unknown>;
    exists(path: string): Promise<boolean>;
    makeDirectory(path: string, options?: Record<string, unknown>): Promise<unknown>;
    remove(path: string, options?: Record<string, unknown>): Promise<unknown>;
    /** 原生 IOUtils.write 没有权限选项；传入原生 API 时通过此端口收紧最终文件权限。 */
    setPermissions?(path: string, permissions: number): Promise<unknown>;
}

export interface ZoteroFontCacheOptions {
    io: ZoteroFontIO;
    directory: string;
    fetch?: typeof globalThis.fetch;
}

/** 只缓存底层完整性校验成功的结果；副本防止 PDF 导出器或调用方修改下一份文档使用的字体。 */
export function memoizeZoteroFontLoader(load: ZoteroFontLoader): ZoteroFontLoader {
    let verified: Uint8Array | undefined;
    return async signal => {
        signal?.throwIfAborted();
        if (!verified) {
            const bytes = await load(signal);
            signal?.throwIfAborted();
            verified = bytes.slice();
        }
        return verified.slice();
    };
}

/** 固定文件名与缓存键均来自共享版本；profile 内的旧字节也必须重新通过共享摘要校验。 */
export function createZoteroFontLoader(options: ZoteroFontCacheOptions): ZoteroFontLoader {
    const {io} = options;
    const separator = options.directory.includes('\\') && !options.directory.includes('/') ? '\\' : '/';
    const directory = options.directory.replace(/[\\/]+$/u, '');
    const path = `${directory}${separator}${PDF_READING_FONT_SHA256}.woff2`;
    const matches = (request: RequestInfo | URL) =>
        (typeof request === 'string' ? request : 'url' in request ? request.url : String(request)) === PDF_READING_FONT_CACHE_KEY;
    const cache: Pick<Cache, 'match' | 'put' | 'delete'> = {
        async match(request) {
            if (!matches(request) || !await io.exists(path)) return undefined;
            // 只多读一个字节就能让共享加载器识别超长文件，避免损坏文件导致无界内存分配。
            const bytes = await io.read(path, {maxBytes: PDF_READING_FONT_BYTES + 1});
            return new Response(asArrayBufferBytes(bytes), {headers: {'Content-Type': 'font/woff2'}});
        },
        async put(request, response) {
            if (!matches(request)) return;
            const bytes = new Uint8Array(await response.arrayBuffer());
            await io.makeDirectory(directory, {ignoreExisting: true, permissions: 0o700});
            await io.setPermissions?.(directory, 0o700);
            // 多窗口或取消后的迟到写入使用不同临时文件；最终路径始终只发布完整的已校验字体。
            const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
            try {
                await io.write(path, bytes, {tmpPath, flush: true, permissions: 0o600});
                await io.setPermissions?.(path, 0o600);
            } catch (error) {
                // 原生权限收紧失败时不留下权限不符的缓存；本次已校验字体仍由共享加载器返回。
                await io.remove(path, {ignoreAbsent: true}).catch(() => undefined);
                throw error;
            } finally {await io.remove(tmpPath, {ignoreAbsent: true}).catch(() => undefined);}
        },
        async delete(request) {
            if (!matches(request) || !await io.exists(path)) return false;
            await io.remove(path, {ignoreAbsent: true});
            return true;
        },
    };
    return memoizeZoteroFontLoader(createPdfReadingFontLoader({
        openCache: async () => cache,
        ...(options.fetch ? {fetch: options.fetch} : {}),
    }));
}
