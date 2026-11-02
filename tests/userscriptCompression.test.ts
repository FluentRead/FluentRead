import {gzipSync, gunzipSync} from 'node:zlib';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {inflateGzipBase64} from '@/userscript/compression';
import {encodeUserscriptData} from '@/userscript/buildDataEncoding';
import {inflateWithPako as inflateWithBundledPako} from '@/userscript/pakoBundled';
import {inflateBytesWithPako as inflateBytesWithBundledPako, decodeUtf8WithPako as decodeUtf8WithBundledPako} from '@/userscript/pakoBundled';

/** 模拟 Safari Userscripts 中解压流在读取阶段异步拒绝，而不是模拟真实隔离世界。 */
class RejectingDecompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;

    constructor() {
        const stream = new TransformStream<Uint8Array, Uint8Array>({
            transform() {throw new TypeError('Invalid type should be ArrayBuffer');},
        });
        this.readable = stream.readable;
        this.writable = stream.writable;
    }
}

describe('userscript compressed assets', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('inflates real gzip data with the browser stream API', async () => {
        const source = 'FluentRead 样式和 English settings';
        const encoded = gzipSync(source).toString('base64');
        const ungzip = vi.fn();
        vi.stubGlobal('pako', {ungzip});
        await expect(inflateGzipBase64(encoded)).resolves.toBe(source);
        expect(ungzip).not.toHaveBeenCalled();
    });

    it.each([
        {encoding: 'Base64', encode: (bytes: Buffer) => bytes.toString('base64')},
        {encoding: 'ASCII85', encode: (bytes: Buffer) => encodeUserscriptData(bytes)},
    ])('falls back to pako when the stream asynchronously rejects $encoding data', async ({encode}) => {
        const source = 'FluentRead 样式和设置 🦦';
        const ungzip = vi.fn(inflateWithBundledPako);
        vi.stubGlobal('DecompressionStream', RejectingDecompressionStream);
        vi.stubGlobal('pako', {ungzip});

        await expect(inflateGzipBase64(encode(gzipSync(source)))).resolves.toBe(source);
        expect(ungzip).toHaveBeenCalledOnce();
    });

    it('falls back to pako when constructing the stream throws', async () => {
        const ungzip = vi.fn(inflateWithBundledPako);
        vi.stubGlobal('DecompressionStream', class {constructor() {throw new TypeError('stream unavailable');}});
        vi.stubGlobal('pako', {ungzip});

        await expect(inflateGzipBase64(gzipSync('constructor recovery').toString('base64'))).resolves.toBe('constructor recovery');
        expect(ungzip).toHaveBeenCalledOnce();
    });

    it('keeps fallback gzip errors visible and can decode a later valid asset', async () => {
        const corrupted = gzipSync('damaged');
        corrupted[corrupted.length - 8] ^= 1;
        vi.stubGlobal('DecompressionStream', RejectingDecompressionStream);
        vi.stubGlobal('pako', {ungzip: inflateWithBundledPako});

        await expect(inflateGzipBase64(corrupted.toString('base64'))).rejects.toBe('incorrect data check');
        await expect(inflateGzipBase64(gzipSync('recovered').toString('base64'))).resolves.toBe('recovered');
    });

    it('reports a missing pako dependency when stream decompression fails', async () => {
        vi.stubGlobal('DecompressionStream', RejectingDecompressionStream);
        vi.stubGlobal('pako', undefined);

        await expect(inflateGzipBase64(gzipSync('unavailable').toString('base64')))
            .rejects.toThrow('当前浏览器缺少 gzip 解压能力');
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

    it.each([false, true])('restores standalone ASCII85 static gzip data with legacy fallback=%s', async fallback => {
        const source = 'FluentRead 静态 CSS / JSON / JPEG URL e\u0301 🦦 العربية'.repeat(2000);
        const encoded = encodeUserscriptData(gzipSync(source));
        expect(encoded.startsWith('~85:')).toBe(true);
        if (fallback) {vi.stubGlobal('DecompressionStream', undefined); vi.stubGlobal('pako', {ungzip: (bytes: Uint8Array) => gunzipSync(bytes).toString('utf8')});}
        await expect(inflateGzipBase64(encoded)).resolves.toBe(source);
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
        const original = Uint8Array.from(padded);
        const view = padded.subarray(3, 3 + compressed.length);
        vi.stubGlobal('pako', undefined);

        expect(view.byteOffset).toBe(3);
        expect(inflateWithBundledPako(view)).toBe(source);
        expect(Array.from(padded)).toEqual(Array.from(original));
    });

    it('rejects an invalid gzip header without poisoning a later valid decode', () => {
        vi.stubGlobal('pako', undefined);
        let failure: unknown;
        try { inflateWithBundledPako(new Uint8Array([0xff, 0xff, 0xff, 0xff])); }
        catch (cause) { failure = cause; }

        expect(failure).toBe('incorrect header check');
        expect(inflateWithBundledPako(gzipSync('FluentRead header recovery'))).toBe('FluentRead header recovery');
    });

    it.each([
        {label: 'Unicode', source: 'FluentRead 简体／繁體 e\u0301 👩🏽‍💻 🧪 العربية'},
        {label: 'empty', source: ''},
        // pako 2.1.0 默认输出块为 64KiB；让非 BMP 字符跨该边界，同时覆盖大于 16KiB 的文本。
        {label: 'UTF-8 across 16KiB and 64KiB', source: 'a'.repeat(65_535) + '🧪汉字' + 'e\u0301'.repeat(8_000)},
    ])('preserves $label text through the real packaged gzip fallback', ({source}) => {
        vi.stubGlobal('pako', undefined);

        expect(inflateWithBundledPako(gzipSync(source))).toBe(source);
    });

    it('rejects a corrupt gzip CRC without retaining failure in a later valid decode', () => {
        const source = 'FluentRead 校验完整性 🧪';
        const gzip = gzipSync(source);
        const corrupted = Uint8Array.from(gzip);
        // gzip 尾部八字节是 CRC32 与输入长度，只翻转 CRC，不改变压缩正文。
        corrupted[corrupted.length - 8] ^= 1;
        vi.stubGlobal('pako', undefined);
        let failure: unknown;
        try { inflateWithBundledPako(corrupted); }
        catch (cause) { failure = cause; }

        // 锁定官方 pako 的既有失败契约是原始字符串，不能在换入口时吞掉或包装。
        expect(failure).toBe('incorrect data check');
        expect(inflateWithBundledPako(gzip)).toBe(source);
    });
});


describe('userscript packaged binary gzip data', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
        {label: 'Unicode UTF-8 bytes', source: Uint8Array.from(Buffer.from('FluentRead 简体／繁體 e\u0301 👩🏽‍💻 🧪 العربية', 'utf8'))},
        {label: 'empty bytes', source: new Uint8Array()},
        {label: 'NUL and invalid UTF-8 bytes', source: Uint8Array.from([0, 255, 254, 128, 192, 193, 237, 160, 128, 240, 0])},
        {label: 'binary across 16KiB and 64KiB', source: Uint8Array.from({length: 65_540}, (_, index) => index % 256)},
    ])('preserves $label through the real packaged binary decoder', ({source}) => {
        // 独立二进制入口无需管理器 global 或浏览器流 API，也不能先转换为 UTF-8 字符串。
        const managerUngzip = vi.fn(() => {throw new Error('must not use manager global');});
        vi.stubGlobal('pako', {ungzip: managerUngzip}); vi.stubGlobal('DecompressionStream', undefined);
        const restored = inflateBytesWithBundledPako(gzipSync(source));

        expect(restored.constructor).toBe(Uint8Array); expect(Object.getPrototypeOf(restored)).toBe(Uint8Array.prototype);
        expect(restored.byteLength).toBe(source.byteLength);
        expect(Array.from(restored)).toEqual(Array.from(source));
        expect(Buffer.from(restored.buffer, restored.byteOffset, restored.byteLength)).toEqual(Buffer.from(source));
        expect(restored).not.toBe(source); expect(managerUngzip).not.toHaveBeenCalled();
    });

    it('propagates binary gzip CRC failure and decodes later valid binary and text independently', () => {
        const source = Uint8Array.from([0, 255, 128, 237, 160, 128, 1, 254]);
        const gzip = gzipSync(source); const corrupted = Uint8Array.from(gzip);
        corrupted[corrupted.length - 8] ^= 1;
        vi.stubGlobal('pako', undefined); vi.stubGlobal('DecompressionStream', undefined);
        let failure: unknown;
        try { inflateBytesWithBundledPako(corrupted); }
        catch (cause) { failure = cause; }

        expect(failure).toBe('incorrect data check');
        const restored = inflateBytesWithBundledPako(gzip);
        expect(restored.constructor).toBe(Uint8Array); expect(Array.from(restored)).toEqual(Array.from(source));
        // 同一锁定 ungzip 的 string 端口继续保持原语义，不受前一 binary 失败影响。
        expect(inflateWithBundledPako(gzipSync('FluentRead 字符串端口 🧪'))).toBe('FluentRead 字符串端口 🧪');
    });
});


describe('userscript packaged UTF-8 byte decoding', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
        {label: 'Unicode subarray with native decoder', source: 'FluentRead 简体／繁體 e\u0301 👩🏽‍💻 🧪 العربية\0', fallback: false},
        {label: 'Unicode subarray without TextDecoder', source: 'FluentRead 简体／繁體 e\u0301 👩🏽‍💻 🧪 العربية\0', fallback: true},
        {label: 'empty subarray without TextDecoder', source: '', fallback: true},
    ])('decodes $label through the actual packaged UTF-8 helper', ({source, fallback}) => {
        if (fallback) vi.stubGlobal('TextDecoder', undefined);
        const managerUngzip = vi.fn(() => {throw new Error('must not use manager global');});
        vi.stubGlobal('pako', {ungzip: managerUngzip});
        const bytes = Buffer.from(source, 'utf8'); const backing = new Uint8Array(bytes.byteLength + 9);
        backing.fill(0xff); backing.set(bytes, 3);
        const view = backing.subarray(3, 3 + bytes.byteLength); const original = Uint8Array.from(backing);
        expect(view.byteOffset).toBe(3);
        expect(decodeUtf8WithBundledPako(view)).toBe(source);
        expect(Array.from(backing)).toEqual(Array.from(original));
        expect(managerUngzip).not.toHaveBeenCalled();
    });
});
