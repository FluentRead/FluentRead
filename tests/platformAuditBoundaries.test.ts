/**
 * @file tests/platformAuditBoundaries.test.ts
 * 文件职责：验证平台摘要、标识、编译能力及本地推理探测的完整输入与生命周期边界。
 * 主要内容：真实内存 WASM/gzip 响应、受控 GPU 驱动和初始化并发，覆盖失败后重试及资源释放。
 * 模块边界：不启动浏览器、模型或真实 GPU，不访问网络或账号；仅测试共享平台模块。
 */
import {createHash} from 'node:crypto';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256Hex} from '@/src/shared/function/sha256';
import {configureOnnxWasmBackend, loadCompressedWasmBinary, withCompressedWasmBinary, type OnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {applyRuntimeBrowserConstraints, browserBuildTargetFromEnv, browserCapabilities, browserCapabilityBuildMarker, readRuntimeUserAgent, resolveBrowserCapabilities} from '@/src/platform/browser/capabilities';
import {isBrowserTabId} from '@/src/platform/browser/ids';
import {supportsHunyuanTranslation} from '@/src/platform/browser/localTranslationSupport';

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const unavailable = {available: false, info: ''};
const fetchBytes = (bytes: Uint8Array = wasm) => vi.fn(async () => new Response(asArrayBufferBytes(bytes)));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
async function compressed(bytes: Uint8Array) {
    return new Uint8Array(await new Response(new Blob([asArrayBufferBytes(bytes)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('浏览器二进制接口的字节输入', () => {
    it('复用普通缓冲区及其视图范围', async () => {
        const bytes = Uint8Array.of(8, 1, 2, 9).subarray(1, 3);
        const input = asArrayBufferBytes(bytes);
        expect(input.buffer).toBe(bytes.buffer);
        expect(input.byteOffset).toBe(bytes.byteOffset);
        expect(new Uint8Array(await new Blob([input]).arrayBuffer())).toEqual(Uint8Array.of(1, 2));
    });

    it('仅复制共享视图包含的字节', async () => {
        const bytes = new Uint8Array(new SharedArrayBuffer(4));
        bytes.set([8, 1, 2, 9]);
        const input = asArrayBufferBytes(bytes.subarray(1, 3));
        expect(input.buffer).toBeInstanceOf(ArrayBuffer);
        bytes[1] = 3;
        expect(new Uint8Array(await new Response(input).arrayBuffer())).toEqual(Uint8Array.of(1, 2));
    });
});

describe('摘要与浏览器 ID 输入边界', () => {
    it.each(['', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), '\uD800', '\uDC00', 'a\u0000中🙂e\u0301', '🙂中文'.repeat(100_000)])('UTF-8 摘要与原生结果一致 %#', value => {
        expect(sha256Hex(value)).toBe(createHash('sha256').update(value).digest('hex'));
        expect(sha256Hex(value)).toMatch(/^[0-9a-f]{64}$/);
    });
    it.each([undefined, null, 1, {}, true])('拒绝非法标量与普通对象输入 %#', value => {
        expect(() => sha256Hex(value as unknown as string)).toThrow();
    });
    it('保留底层字节输入的运行时兼容性且不修改调用方 view', () => {
        const input = new Uint8Array([77, 0, 97, 98, 99, 77]);
        const view = input.subarray(1, 5);
        expect(sha256Hex(view as unknown as string)).toBe(createHash('sha256').update(view).digest('hex'));
        expect(input).toEqual(new Uint8Array([77, 0, 97, 98, 99, 77]));
    });
    it('摘要不做 Unicode 或换行规范化，避免合并不同缓存与签名身份', () => {
        expect(sha256Hex('é')).not.toBe(sha256Hex('e\u0301'));
        expect(sha256Hex('a\r\nb')).not.toBe(sha256Hex('a\nb'));
    });
    it.each([0, -0, 1, Number.MAX_SAFE_INTEGER])('接受合法 tab/window ID %#', id => { expect(isBrowserTabId(id)).toBe(true); });
    it.each([-1, -0.1, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', 0n, null, undefined, {}, new Number(0)])('拒绝缺失、非法或来源类型错误的 ID %#', id => { expect(isBrowserTabId(id)).toBe(false); });
});

describe('浏览器构建与运行能力契约', () => {
    it('规范化不受土耳其语大小写影响', () => {
        const original = String.prototype.toLocaleLowerCase;
        vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) { return original.call(this, 'tr'); });
        expect(resolveBrowserCapabilities({browser: ' FIREFOX ', manifestVersion: 2}).extensionDom).toBe(true);
        expect(browserBuildTargetFromEnv({BROWSER: 'FIREFOX'})).toEqual({browser: 'firefox', manifestVersion: 2});
    });
    it('仅提供确定的构建支持范围，不从 UA 打开功能', () => {
        for (const [browser, manifestVersion, dom, translator] of [
            ['chrome', 3, true, true], ['edge', 3, true, false], ['firefox', 2, true, false],
            ['firefox', 3, false, false], ['chrome', 2, false, false], ['edge', 2, false, false],
            ['userscript', 2, false, false], ['unknown', 3, false, false], ['', 2, false, false],
        ] as const) {
            const result = resolveBrowserCapabilities({browser, manifestVersion});
            expect(result).toMatchObject({extensionDom: dom, imageOcr: dom, imageTranslation: dom, areaTranslation: dom, selectionTtsExtensionPlayback: dom, chromeTranslation: translator, selectionTtsPageFallback: true});
            expect(result.offscreenDocument).toBe(dom && browser !== 'firefox');
            expect(Object.isFrozen(result)).toBe(true);
        }
    });
    it('Chrome 包在 Edge 上收紧翻译能力，Firefox 包在 Thunderbird 上收紧 DOM 能力', () => {
        const chrome = resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3});
        const firefox = resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 2});
        for (const ua of ['Edg/130', 'EdgA/130', 'EdgiOS/130']) {
            expect(applyRuntimeBrowserConstraints(chrome, ua)).toMatchObject({browser: 'edge', extensionDom: true, chromeTranslation: false});
        }
        expect(applyRuntimeBrowserConstraints(chrome, 'Thunderbird/130')).toBe(chrome);
        expect(applyRuntimeBrowserConstraints(firefox, 'Edg/130')).toBe(firefox);
        expect(applyRuntimeBrowserConstraints(firefox, 'Firefox/130')).toBe(firefox);
        expect(applyRuntimeBrowserConstraints(firefox, 'Thunderbird/130')).toMatchObject({browser: 'thunderbird', extensionDom: false});
    });
    it('环境缺失和非法 MV 安全回退，合法 MV 保持原值', () => {
        expect(browserBuildTargetFromEnv()).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: 'edge'})).toEqual({browser: 'edge', manifestVersion: 3});
        expect(browserBuildTargetFromEnv({BROWSER: 'chrome'})).toEqual({browser: 'chrome', manifestVersion: 3});
        expect(browserBuildTargetFromEnv({BROWSER: 'firefox', MANIFEST_VERSION: 3})).toEqual({browser: 'firefox', manifestVersion: 3});
        expect(browserBuildTargetFromEnv({BROWSER: 'chrome', MANIFEST_VERSION: 2})).toEqual({browser: 'chrome', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: 2, MANIFEST_VERSION: 4} as unknown as Partial<ImportMetaEnv>)).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: ' '})).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(readRuntimeUserAgent({})).toBe('');
        expect(readRuntimeUserAgent({navigator: {userAgent: 0}})).toBe('');
        expect(readRuntimeUserAgent({navigator: {userAgent: 'Edg/130'}})).toBe('Edg/130');
        expect(Object.isFrozen(browserCapabilities)).toBe(true);
        expect(browserCapabilities.buildTargetMarker).toBe(browserCapabilityBuildMarker);
    });
});

describe('WASM 头部、响应与初始化队列', () => {
    it.each(['runtime.wasm', 'runtime.wasm?revision=1', 'runtime.wasm#fixture', 'chrome-extension://fixture/runtime.wasm?x=1#y'])('无解压器也加载带修饰的原始资源 %#', async url => {
        vi.stubGlobal('DecompressionStream', undefined);
        const fetchImpl = fetchBytes();
        await expect(loadCompressedWasmBinary(url, {fetchImpl})).resolves.toEqual(wasm);
        expect(fetchImpl).toHaveBeenCalledWith(url, {cache: 'no-store'});
    });
    it.each([wasm.subarray(0, 4), wasm.subarray(0, 7), new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]), new Uint8Array([0, 97, 115, 109, 1, 1, 0, 0]), new Uint8Array([0, 97, 115, 0, 1, 0, 0, 0])])('拒绝截断或错误的头部，损坏资源只读一次 %#', async bytes => {
        const fetchImpl = fetchBytes(bytes);
        await expect(loadCompressedWasmBinary('invalid.wasm', {fetchImpl})).rejects.toMatchObject({message: 'ONNX_WASM_BINARY_LOAD_FAILED:invalid.wasm', cause: {message: 'ONNX_WASM_BINARY_INVALID:invalid.wasm'}});
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('gzip 解压后同样验证完整版本头部', async () => {
        await expect(loadCompressedWasmBinary('runtime.wasm.gz', {fetchImpl: fetchBytes(await compressed(wasm))})).resolves.toEqual(wasm);
        await expect(loadCompressedWasmBinary('runtime.wasm.gz', {fetchImpl: fetchBytes(await compressed(wasm.subarray(0, 4)))})).rejects.toMatchObject({cause: {message: 'ONNX_WASM_BINARY_INVALID:runtime.wasm.gz'}});
    });
    it('大输入保持精确 buffer view，验证成本不扫描全部模型数据', async () => {
        const buffer = new ArrayBuffer(8 * 1024 * 1024);
        const bytes = new Uint8Array(buffer); bytes.set(wasm); bytes[bytes.length - 1] = 123;
        const response = {ok: true, arrayBuffer: vi.fn(async () => buffer)} as unknown as Response;
        const result = await loadCompressedWasmBinary('large.wasm', {fetchImpl: vi.fn(async () => response)});
        expect(result.buffer).toBe(buffer);
        expect(result.byteOffset).toBe(0);
        expect(result.byteLength).toBe(buffer.byteLength);
        expect(result[result.byteLength - 1]).toBe(123);
        expect(bytes.subarray(0, 8)).toEqual(wasm);
    });
    it('Response 仅交付源 view 的范围，不包含原 buffer 前后数据', async () => {
        const envelope = new Uint8Array(32); envelope.fill(77); envelope.set(wasm, 12);
        await expect(loadCompressedWasmBinary('runtime.wasm', {fetchImpl: fetchBytes(envelope.subarray(12, 20))})).resolves.toEqual(wasm);
    });
    it.each([[undefined, 2], [NaN, 2], [Infinity, 2], [-4, 1], [1.9, 1], [99, 3]] as const)('有限重试次数 %#', async (maxAttempts, expected) => {
        const fetchImpl = vi.fn(async () => { throw new Error('temporary'); });
        await expect(loadCompressedWasmBinary('runtime.wasm', {fetchImpl, maxAttempts})).rejects.toMatchObject({cause: {message: 'temporary'}});
        expect(fetchImpl).toHaveBeenCalledTimes(expected);
    });
    it('默认 fetch 保持 globalThis 接收者，读取失败和 5xx 能重试', async () => {
        let receiver: unknown;
        const fetchImpl = vi.fn(function (this: unknown) { receiver = this; return Promise.resolve(new Response(wasm)); });
        vi.stubGlobal('fetch', fetchImpl);
        await expect(loadCompressedWasmBinary('runtime.wasm')).resolves.toEqual(wasm);
        expect(receiver).toBe(globalThis);
        const readFailure = {ok: true, arrayBuffer: async () => { throw new Error('read'); }} as unknown as Response;
        const retry = vi.fn().mockResolvedValueOnce(readFailure).mockResolvedValueOnce(new Response(null, {status: 503})).mockResolvedValueOnce(new Response(wasm));
        await expect(loadCompressedWasmBinary('runtime.wasm', {fetchImpl: retry, maxAttempts: 3})).resolves.toEqual(wasm);
        expect(retry).toHaveBeenCalledTimes(3);
    });
    it('404、无解压器、缺失 body 与损坏 gzip 不重试', async () => {
        const missing = vi.fn(async () => new Response(null, {status: 404}));
        await expect(loadCompressedWasmBinary('missing.wasm', {fetchImpl: missing})).rejects.toMatchObject({cause: {message: 'HTTP_404'}});
        expect(missing).toHaveBeenCalledTimes(1);
        const noBody = vi.fn(async () => new Response(null));
        await expect(loadCompressedWasmBinary('missing.gz', {fetchImpl: noBody})).rejects.toMatchObject({cause: {message: 'ONNX_WASM_BINARY_BODY_MISSING'}});
        const broken = fetchBytes(new Uint8Array([1, 2, 3]));
        await expect(loadCompressedWasmBinary('bad.gz', {fetchImpl: broken})).rejects.toMatchObject({cause: {message: 'ONNX_WASM_BINARY_DECOMPRESSION_FAILED:bad.gz'}});
        vi.stubGlobal('DecompressionStream', undefined);
        const unsupported = fetchBytes();
        await expect(loadCompressedWasmBinary('old.gz', {fetchImpl: unsupported})).rejects.toMatchObject({cause: {message: 'ONNX_WASM_DECOMPRESSION_UNSUPPORTED'}});
        for (const fn of [noBody, broken, unsupported]) expect(fn).toHaveBeenCalledTimes(1);
    });
    it('静态路径关闭 proxy 并保留调用方线程数', () => {
        const backend: OnnxWasmBackend = {numThreads: 2, proxy: true, wasmPaths: 'old/'};
        configureOnnxWasmBackend(backend, {mjs: 'x.mjs', wasm: 'x.wasm'});
        expect(backend).toEqual({numThreads: 2, proxy: false, wasmPaths: {mjs: 'x.mjs', wasm: 'x.wasm'}});
    });
    it('同后端串行、不同后端独立，成功后只加载一次且释放 buffer', async () => {
        const backend: OnnxWasmBackend = {}, other: OnnxWasmBackend = {};
        const hold = deferred<string>(), entered = deferred<void>();
        const fetchImpl = fetchBytes();
        const first = withCompressedWasmBinary(backend, 'x.wasm', async () => { expect(backend.wasmBinary).toEqual(wasm); entered.resolve(); return hold.promise; }, {fetchImpl});
        const secondInit = vi.fn(async () => { expect(backend.wasmBinary).toBeUndefined(); return 'second'; });
        const second = withCompressedWasmBinary(backend, 'x.wasm', secondInit, {fetchImpl});
        await entered.promise;
        await expect(withCompressedWasmBinary(other, 'x.wasm', async () => 'independent', {fetchImpl})).resolves.toBe('independent');
        expect(secondInit).not.toHaveBeenCalled();
        hold.resolve('first');
        await expect(first).resolves.toBe('first'); await expect(second).resolves.toBe('second');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(backend.wasmBinary).toBeUndefined(); expect(other.wasmBinary).toBeUndefined();
    });
    it('下载和初始化失败后队列仍允许重新加载', async () => {
        const backend: OnnxWasmBackend = {};
        const fetchImpl = fetchBytes();
        await expect(withCompressedWasmBinary(backend, 'bad.wasm', async () => 'never', {fetchImpl: fetchBytes(new Uint8Array())})).rejects.toThrow('LOAD_FAILED');
        await expect(withCompressedWasmBinary(backend, 'x.wasm', async () => { throw new Error('init'); }, {fetchImpl})).rejects.toThrow('init');
        expect(backend.wasmBinary).toBeUndefined();
        await expect(withCompressedWasmBinary(backend, 'x.wasm', async () => 'recovered', {fetchImpl})).resolves.toBe('recovered');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    it('清理 setter 抛错也释放初始化队列', async () => {
        let binary: OnnxWasmBackend['wasmBinary']; let failCleanup = true;
        const backend: OnnxWasmBackend = {get wasmBinary() { return binary; }, set wasmBinary(value) { if (value === undefined && failCleanup) { failCleanup = false; throw new Error('cleanup'); } binary = value; }};
        const first = withCompressedWasmBinary(backend, 'x.wasm', async () => 'ready', {fetchImpl: fetchBytes()});
        const firstRejected = expect(first).rejects.toThrow('cleanup');
        const initialize = vi.fn(async () => 'next');
        const second = withCompressedWasmBinary(backend, 'x.wasm', initialize, {fetchImpl: fetchBytes()});
        await firstRejected;
        for (let n = 0; n < 10; n++) await Promise.resolve();
        expect(initialize).toHaveBeenCalledTimes(1);
        await expect(second).resolves.toBe('next');
        expect(backend.wasmBinary).toBeUndefined();
    });
});

describe('WebGPU 驱动探测与 CPU 回退', () => {
    it.each(['HeadlessChrome/130', 'HeadlessEdge/130', 'Firefox/130', 'custom-agent'])('有真实硬件适配器时不因 UA 误关闭 %#', async userAgent => {
        const requestAdapter = vi.fn(async () => ({isFallbackAdapter: false, info: {vendor: 'fixture hardware', architecture: 'metal', device: '0', description: 'integrated'}}));
        vi.stubGlobal('navigator', {userAgent, gpu: {requestAdapter}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: 'fixture hardware / metal / 0 / integrated'});
        expect(requestAdapter).toHaveBeenCalledWith({powerPreference: 'high-performance'});
    });
    it('只读取一次适配器信息，不请求设备', async () => {
        const info = vi.fn(() => ({vendor: 'hardware'})), requestDevice = vi.fn();
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => ({get info() { return info(); }, requestDevice})}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: 'hardware'});
        expect(info).toHaveBeenCalledTimes(1); expect(requestDevice).not.toHaveBeenCalled();
    });
    it.each([undefined, {}, {gpu: {}}, {gpu: {requestAdapter: 'not callable'}}, {gpu: {requestAdapter: async () => null}}, {gpu: {requestAdapter: () => { throw new Error('sync'); }}}, {gpu: {requestAdapter: async () => { throw new Error('async'); }}}, {get gpu() { throw new Error('policy'); }}])('缺失能力或驱动异常安全回退 %#', async navigator => {
        vi.stubGlobal('navigator', navigator); await expect(probeWebGpu()).resolves.toEqual(unavailable);
    });
    it.each([{isFallbackAdapter: true}, {info: {isFallbackAdapter: true}}, ...['SwiftShader', 'software renderer', 'llvmpipe', 'fallback adapter'].map(description => ({info: {description}}))])('软件适配器不能误报硬件 %#', async adapter => {
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => adapter}}); await expect(probeWebGpu()).resolves.toEqual(unavailable);
    });
    it('诊断信息可选；读取信息抛错也安全回退并清除计时器', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => ({})}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: ''});
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => ({get info() { throw new Error('info'); }})}});
        await expect(probeWebGpu()).resolves.toEqual(unavailable);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['resolve', 'reject'] as const)('探测有截止时间，迟到的驱动结果不会改变回退或产生未处理异常 %s', async ending => {
        vi.useFakeTimers(); const driver = deferred<{} | null>();
        vi.stubGlobal('navigator', {gpu: {requestAdapter: () => driver.promise}});
        const probe = probeWebGpu(); await vi.advanceTimersByTimeAsync(1_999);
        expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(1);
        await expect(probe).resolves.toEqual(unavailable);
        if (ending === 'resolve') driver.resolve({}); else driver.reject(new Error('late'));
        await Promise.resolve(); await expect(probe).resolves.toEqual(unavailable);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('memory64 必要能力检查', () => {
    it.each([true, false])('使用零页模块并遵从真实验证结果 %s', supported => {
        const validate = vi.fn(() => supported), Memory = vi.fn();
        vi.stubGlobal('WebAssembly', {validate, Memory});
        expect(supportsHunyuanTranslation()).toBe(supported);
        expect(validate).toHaveBeenCalledWith(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]));
        expect(Memory).not.toHaveBeenCalled();
    });
    it.each([undefined, {}, {validate: 3}, {validate: () => { throw new Error('policy'); }}])('能力缺失或验证异常不使设置/下载链路抛错 %#', wasmRuntime => {
        vi.stubGlobal('WebAssembly', wasmRuntime); expect(supportsHunyuanTranslation()).toBe(false);
    });
});
