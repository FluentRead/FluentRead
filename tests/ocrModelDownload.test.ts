/**
 * @file tests/ocrModelDownload.test.ts
 * 文件职责：验证 OCR 语言包的带进度预下载确实把解压后的模型写进 Tesseract.js 的缓存，并且任何失败都不会阻断随后的正常加载。
 * 主要内容：覆盖缓存查询与写入、跳过已缓存模型、并行模型合并为一条字节进度、下载地址与 Tesseract.js 默认地址一致，以及断网、损坏数据、存储不可用和取消时的静默回退。
 * 模块边界：使用内存 IndexedDB 和假的 fetch，不联网、不启动 Tesseract Worker。
 */
import {readFileSync} from 'node:fs';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {gzipSync} from 'node:zlib';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {listCachedOcrModelFiles, removeOcrModelFiles, writeOcrModelFile} from '@/src/features/image-translation/services/ocrModelCache';
import {getOcrModelFileUrl, prefetchOcrModelFiles} from '@/src/features/image-translation/services/ocrModelDownload';

afterEach(() => vi.unstubAllGlobals());

function readStored(key: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const read = request.result.transaction('keyval').objectStore('keyval').get(key);
            read.onsuccess = () => { request.result.close(); resolve(read.result); };
        };
    });
}

function gzipResponse(bytes: number[], headers: Record<string, string> = {}): Response {
    const body = gzipSync(new Uint8Array(bytes));
    return new Response(asArrayBufferBytes(body), {headers: {'Content-Type': 'application/gzip', 'Content-Length': String(body.byteLength), ...headers}});
}

describe('OCR 模型缓存读写', () => {
    it('按 Tesseract.js 的缓存键写入、查询并删除指定模型', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        expect(await listCachedOcrModelFiles(['eng', 'jpn'])).toEqual([]);
        await writeOcrModelFile('eng', new Uint8Array([1, 2, 3]));
        expect(await listCachedOcrModelFiles(['eng', 'jpn'])).toEqual(['eng']);
        expect(await readStored('fluent-read-image-ocr/eng.traineddata')).toEqual(new Uint8Array([1, 2, 3]));
        await removeOcrModelFiles(['eng']);
        expect(await listCachedOcrModelFiles(['eng'])).toEqual([]);
    });
});

describe('OCR 语言包预下载', () => {
    it('下载地址与 Tesseract.js 仅 LSTM 引擎的默认语言数据地址保持一致', () => {
        expect(getOcrModelFileUrl('jpn_vert')).toBe('https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn_vert/4.0.0_best_int/jpn_vert.traineddata.gz');
        // 升级 Tesseract.js 时如果默认地址或缓存键变了，这里会先失败，提醒同步预下载。
        const worker = readFileSync('node_modules/tesseract.js/src/worker-script/index.js', 'utf8');
        expect(worker).toContain('`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`');
        expect(worker).toContain("`${path}/${lang}.traineddata${gzip ? '.gz' : ''}`");
        expect(worker).toContain("readCache(`${cachePath || '.'}/${lang}.traineddata`)");
        expect(readFileSync('node_modules/tesseract.js/src/worker-script/browser/cache.js', 'utf8')).toContain("require('idb-keyval')");
    });

    it('只下载缺失的模型，把并行模型合并成一条进度，并写入解压后的数据', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        await writeOcrModelFile('eng', new Uint8Array([9]));
        const fetcher = vi.fn(async (url: string) => gzipResponse(url.includes('jpn_vert') ? [4, 5, 6, 7] : [1, 2, 3]));
        vi.stubGlobal('fetch', fetcher);
        const reports: Array<{loaded: number; total: number}> = [];
        await prefetchOcrModelFiles(['jpn', 'jpn_vert', 'eng'], {onProgress: progress => reports.push(progress)});

        expect(fetcher.mock.calls.map(call => call[0])).toEqual([getOcrModelFileUrl('jpn'), getOcrModelFileUrl('jpn_vert')]);
        expect(await readStored('fluent-read-image-ocr/jpn.traineddata')).toEqual(new Uint8Array([1, 2, 3]));
        expect(await readStored('fluent-read-image-ocr/jpn_vert.traineddata')).toEqual(new Uint8Array([4, 5, 6, 7]));
        expect(await readStored('fluent-read-image-ocr/eng.traineddata')).toEqual(new Uint8Array([9]));
        // 进度按压缩包的真实字节计：两个响应头都到达后才有总量，结束时已接收量等于总量。
        const last = reports.at(-1)!;
        expect(last.total).toBeGreaterThan(0);
        expect(last.loaded).toBe(last.total);
        expect(reports.every((item, index) => index === 0 || item.loaded >= reports[index - 1].loaded)).toBe(true);
        expect(reports.every(item => item.total === 0 || item.loaded <= item.total)).toBe(true);

        // 全部已缓存时不联网，也不产生进度。
        fetcher.mockClear();
        reports.length = 0;
        await prefetchOcrModelFiles(['jpn', 'jpn_vert', 'eng'], {onProgress: progress => reports.push(progress)});
        expect(fetcher).not.toHaveBeenCalled();
        expect(reports).toEqual([]);
    });

    it('断网、损坏数据和取消都静默结束，已成功的模型仍然保留', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.includes('/kor/')) throw new Error('offline');
            if (url.includes('/fra/')) return new Response('not gzip', {headers: {'Content-Type': 'application/gzip'}});
            return gzipResponse([7, 7]);
        }));
        await expect(prefetchOcrModelFiles(['kor', 'fra', 'rus'])).resolves.toBeUndefined();
        expect(await listCachedOcrModelFiles(['kor', 'fra', 'rus'])).toEqual(['rus']);

        const controller = new AbortController();
        controller.abort();
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(prefetchOcrModelFiles(['spa'], {signal: controller.signal})).resolves.toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('缓存无法读取时不做无用的下载，写入失败也不抛错', async () => {
        const failure = new Error('storage unavailable');
        const broken = () => { const request: any = {error: failure}; queueMicrotask(() => request.onerror()); return request; };
        const fetcher = vi.fn(async () => gzipResponse([1]));
        vi.stubGlobal('fetch', fetcher);
        vi.stubGlobal('indexedDB', {open: broken});
        await expect(listCachedOcrModelFiles(['eng'])).rejects.toThrow('storage unavailable');
        await expect(prefetchOcrModelFiles(['eng'])).resolves.toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();

        // 查询成功但随后写入失败：下载照常发生，错误留给 Tesseract.js 的加载路径。
        const real = new IDBFactory();
        let opens = 0;
        vi.stubGlobal('indexedDB', {open: (name: string) => ++opens === 1 ? real.open(name) : broken()});
        const reports: Array<{loaded: number; total: number}> = [];
        await expect(prefetchOcrModelFiles(['eng'], {onProgress: progress => reports.push(progress)})).resolves.toBeUndefined();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(reports.length).toBeGreaterThan(0);
        vi.stubGlobal('indexedDB', real);
        expect(await listCachedOcrModelFiles(['eng'])).toEqual([]);
    });
});
