/**
 * @file tests/onnxWasmBinary.test.ts
 * 文件职责：验证压缩 ONNX WASM 的有限重试、gzip 解压、格式校验和初始化后引用释放。
 * 主要内容：使用内存 Response 模拟扩展资源，覆盖成功、失败与不支持解压环境。
 * 模块边界：只验证共享加载器，不启动真实模型或浏览器 Worker。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {configureOnnxWasmBackend, loadCompressedWasmBinary, withCompressedWasmBinary} from '@/src/shared/onnx/wasmBinary';

const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function source(relativePath: string): string {
    return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('compressed ONNX WASM loader', () => {
    it('三个 ONNX Worker 和公共资源 hook 共享同一匹配版本的 runtime MJS 与原始 WASM', () => {
        const sources = [
            source('src/features/local-translation/offscreen/translation.worker.ts'),
            source('src/features/video-subtitle/offscreen/transcription.worker.ts'),
            source('wxt.config.ts'),
        ];
        for (const content of sources) {
            expect(content).toContain('ort-wasm-simd-threaded.asyncify.mjs');
            expect(content).toContain('ort-wasm-simd-threaded.asyncify.wasm');
            expect(content).not.toContain("ort-wasm-simd-threaded.mjs'");
            expect(content).not.toContain("ort-wasm-simd-threaded.wasm'");
        }
        const whisper = sources[1]!;
        expect(whisper).toContain("device: 'webgpu'");
        expect(whisper).toContain('withCompressedWasmBinary(wasm');
        const tts = source('src/features/local-tts/offscreen/tts.worker.ts');
        const wxt = sources[2]!;
        expect(wxt).toContain('ort-wasm-simd-threaded.asyncify.mjs');
        expect(wxt).toContain('ort-wasm-simd-threaded.asyncify.wasm');
        expect(tts).toContain('ort-wasm-simd-threaded.asyncify.mjs');
        expect(tts).toContain('ort-wasm-simd-threaded.asyncify.wasm');
        expect(tts).toMatch(/paceLocalInitialization\(\(\) => wasm\s*\? withCompressedWasmBinary\(wasm,/u);
        expect(tts).not.toContain("device === 'wasm' && wasm");
    });

    it('无解压能力时加载原始 WASM，拒绝损坏资源且初始化后释放引用', async () => {
        vi.stubGlobal('DecompressionStream', undefined);
        const fetchImpl = vi.fn(async () => new Response(wasmBytes));
        const backend: {wasmBinary?: ArrayBufferLike | Uint8Array} = {};
        await withCompressedWasmBinary(backend, 'runtime.wasm', async () => {
            expect(backend.wasmBinary).toEqual(wasmBytes);
        }, {fetchImpl});
        expect(backend.wasmBinary).toBeUndefined();
        const invalidFetch = vi.fn(async () => new Response('invalid'));
        await expect(loadCompressedWasmBinary('runtime.wasm', {fetchImpl: invalidFetch}))
            .rejects.toMatchObject({cause: {message: 'ONNX_WASM_BINARY_INVALID:runtime.wasm'}});
        expect(invalidFetch).toHaveBeenCalledTimes(1);
    });

    it('解压 gzip WASM，并在瞬时读取失败后只重试一次', async () => {
        const compressed = await gzip(wasmBytes);
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new Error('temporary read failure'))
            .mockResolvedValueOnce(new Response(compressed, {headers: {'content-encoding': 'gzip'}}));

        await expect(loadCompressedWasmBinary('chrome-extension://test/wasm.gz', {fetchImpl})).resolves.toEqual(wasmBytes);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl).toHaveBeenLastCalledWith('chrome-extension://test/wasm.gz', {cache: 'no-store'});

        const oneAttemptFetch = vi.fn().mockResolvedValue(new Response(compressed));
        await expect(loadCompressedWasmBinary('wasm.gz', {fetchImpl: oneAttemptFetch, maxAttempts: 0})).resolves.toEqual(wasmBytes);
        expect(oneAttemptFetch).toHaveBeenCalledTimes(1);

        const globalFetch = vi.fn().mockResolvedValue(new Response(compressed));
        vi.stubGlobal('fetch', globalFetch);
        await expect(loadCompressedWasmBinary('global-wasm.gz')).resolves.toEqual(wasmBytes);
        expect(globalFetch).toHaveBeenCalledTimes(1);
    });

    it('对无效二进制直接返回稳定错误，不重复请求损坏的静态资源', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

        await expect(loadCompressedWasmBinary('wasm.gz', {fetchImpl, maxAttempts: 9}))
            .rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:wasm.gz');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        // gzip 本身合法也不能把错误页或截断的数据交给 ORT 初始化。
        for (const invalid of [new Uint8Array([0, 1]), new TextEncoder().encode('not a WASM module')]) {
            const compressed = await gzip(invalid);
            const invalidFetch = vi.fn(async () => new Response(compressed));
            await expect(loadCompressedWasmBinary('invalid.gz', {fetchImpl: invalidFetch}))
                .rejects.toMatchObject({cause: {message: 'ONNX_WASM_BINARY_INVALID:invalid.gz'}});
            expect(invalidFetch).toHaveBeenCalledTimes(1);
        }
    });

    it('对缺少响应体、损坏 gzip 和 404 不做无意义重试，对 5xx 保留有限重试', async () => {
        const emptyBodyFetch = vi.fn().mockResolvedValue(new Response(null));
        await expect(loadCompressedWasmBinary('empty.gz', {fetchImpl: emptyBodyFetch})).rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:empty.gz');
        expect(emptyBodyFetch).toHaveBeenCalledTimes(1);

        const brokenGzipFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
        await expect(loadCompressedWasmBinary('broken.gz', {fetchImpl: brokenGzipFetch})).rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:broken.gz');
        expect(brokenGzipFetch).toHaveBeenCalledTimes(1);

        const notFoundFetch = vi.fn().mockResolvedValue(new Response(null, {status: 404}));
        await expect(loadCompressedWasmBinary('missing.gz', {fetchImpl: notFoundFetch})).rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:missing.gz');
        expect(notFoundFetch).toHaveBeenCalledTimes(1);

        const serverFetch = vi.fn().mockResolvedValue(new Response(null, {status: 503}));
        await expect(loadCompressedWasmBinary('server.gz', {fetchImpl: serverFetch, maxAttempts: 9})).rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:server.gz');
        expect(serverFetch).toHaveBeenCalledTimes(3);
    });

    it('在初始化成功和失败后都清空 wasmBinary 引用', async () => {
        const compressed = await gzip(wasmBytes);
        const fetchImpl = vi.fn(async () => new Response(compressed));
        const backend: {wasmBinary?: ArrayBufferLike | Uint8Array} = {};

        await withCompressedWasmBinary(backend, 'wasm.gz', async () => {
            expect(backend.wasmBinary).toBeInstanceOf(Uint8Array);
            return 'ready';
        }, {fetchImpl});
        expect(backend.wasmBinary).toBeUndefined();
        await withCompressedWasmBinary(backend, 'wasm.gz', async () => 'already-ready', {fetchImpl});
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const failedBackend: {wasmBinary?: ArrayBufferLike | Uint8Array} = {};
        await expect(withCompressedWasmBinary(failedBackend, 'wasm.gz', async () => {
            expect(failedBackend.wasmBinary).toBeInstanceOf(Uint8Array);
            throw new Error('init failed');
        }, {fetchImpl})).rejects.toThrow('init failed');
        expect(failedBackend.wasmBinary).toBeUndefined();
    });

    it('为同一后端串行化并发初始化，且只下载一次二进制', async () => {
        const compressed = await gzip(wasmBytes);
        const fetchImpl = vi.fn(async () => new Response(compressed));
        const backend: {wasmBinary?: ArrayBufferLike | Uint8Array} = {};
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const first = withCompressedWasmBinary(backend, 'wasm.gz', async () => {
            await hold;
            return 'first';
        }, {fetchImpl});
        const second = withCompressedWasmBinary(backend, 'wasm.gz', async () => 'second', {fetchImpl});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        release();
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(backend.wasmBinary).toBeUndefined();
    });

    it('配置静态 MJS 和 gzip WASM 路径，并关闭代理 Worker', () => {
        const backend: {proxy?: boolean; wasmPaths?: {mjs: string; wasm: string}} = {};
        configureOnnxWasmBackend(backend, {mjs: 'runtime.mjs', wasm: 'binary.wasm.gz'});
        expect(backend).toEqual({proxy: false, wasmPaths: {mjs: 'runtime.mjs', wasm: 'binary.wasm.gz'}});
    });

    it('解压能力缺失时按配置的尝试次数失败', async () => {
        const compressed = await gzip(wasmBytes);
        const fetchImpl = vi.fn(async () => new Response(compressed));
        vi.stubGlobal('DecompressionStream', undefined);

        await expect(loadCompressedWasmBinary('wasm.gz', {fetchImpl, maxAttempts: 1}))
            .rejects.toThrow('ONNX_WASM_BINARY_LOAD_FAILED:wasm.gz');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
