import {gzipSync, gunzipSync} from 'node:zlib';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {inflateGzipBase64} from '@/userscript/compression';
import {inflateWithPako as inflateWithBundledPako} from '@/userscript/pakoBundled';

describe('userscript compressed assets', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('inflates real gzip data with the browser stream API', async () => {
        const source = 'FluentRead 样式和 English settings';
        const encoded = gzipSync(source).toString('base64');
        await expect(inflateGzipBase64(encoded)).resolves.toBe(source);
    });

    it('uses the preloaded pako global when an older browser lacks DecompressionStream', async () => {
        const source = 'FluentRead 旧浏览器样式';
        const encoded = gzipSync(source).toString('base64');
        const ungzip = vi.fn((bytes: Uint8Array) => gunzipSync(bytes).toString('utf8'));
        vi.stubGlobal('DecompressionStream', undefined);
        vi.stubGlobal('pako', {ungzip});

        await expect(inflateGzipBase64(encoded)).resolves.toBe(source);
        expect(ungzip).toHaveBeenCalledOnce();
    });

    it('inflates real gzip data with the packaged fallback without a manager global', () => {
        const source = 'FluentRead 独立脚本兼容旧内核';
        vi.stubGlobal('pako', undefined);

        expect(inflateWithBundledPako(gzipSync(source))).toBe(source);
    });

    it('respects the offset and length of a typed gzip input', () => {
        const source = 'FluentRead typed view 中文 🚀';
        const compressed = gzipSync(source);
        const padded = new Uint8Array(compressed.length + 8).fill(0xa5);
        padded.set(compressed, 3);

        expect(inflateWithBundledPako(padded.subarray(3, 3 + compressed.length))).toBe(source);
    });

    it('rejects invalid gzip headers and damaged checksums', () => {
        const compressed = gzipSync('FluentRead checksum');
        compressed[compressed.length - 8] ^= 1;

        expect(() => inflateWithBundledPako(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow('incorrect header check');
        expect(() => inflateWithBundledPako(compressed)).toThrow('incorrect data check');
    });
});
