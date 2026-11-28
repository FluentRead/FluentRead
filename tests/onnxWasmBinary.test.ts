/**
 * @file tests/onnxWasmBinary.test.ts
 * 文件职责：验证压缩 ONNX WASM 的有限重试、gzip 解压、格式校验和初始化后引用释放。
 * 主要内容：使用内存 Response 模拟扩展资源，覆盖成功、失败与不支持解压环境。
 * 模块边界：只验证共享加载器，不启动真实模型或浏览器 Worker。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {build as viteBuild} from 'vite';
import {kokoroTransformersBuildPlugin} from '../scripts/wasm/kokoro-transformers-build';
import {sharedOnnxBuildPlugin} from '../scripts/wasm/manga-onnx-build';
import {
    assertOnnxWasmRuntimeSupported,
    configureOnnxWasmBackend,
    isOnnxJspiUnsupportedError,
    loadCompressedWasmBinary,
    ONNX_WASM_JSPI_UNSUPPORTED_CODE,
    resolveOnnxWasmAssetPaths,
    resolveOnnxWasmVariant,
    supportsOnnxJspi,
    supportsOnnxWasmRuntime,
    withCompressedWasmBinary,
} from '@/src/shared/onnx/wasmBinary';

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
    it('所有 ONNX Worker 和公共资源 hook 共享同一匹配版本的 runtime MJS 与原始 WASM（按目标浏览器区分 JSPI/Asyncify）', () => {
        const workers = [
            source('src/features/local-translation/offscreen/translation.worker.ts'),
            source('src/features/video-subtitle/offscreen/transcription.worker.ts'),
            source('src/features/local-tts/offscreen/tts.worker.ts'),
        ];
        for (const content of workers) {
            expect(content).toContain('resolveOnnxWasmAssetPaths(');
            expect(content).not.toContain("ort-wasm-simd-threaded.mjs'");
            expect(content).not.toContain("ort-wasm-simd-threaded.wasm'");
        }
        const whisper = workers[1]!;
        expect(whisper).toContain("device: 'webgpu'");
        expect(whisper).toContain('withCompressedWasmBinary(wasm');
        const tts = workers[2]!;
        expect(tts).toMatch(/paceLocalInitialization\(\(\) => wasm\s*\? withCompressedWasmBinary\(wasm,/u);
        expect(tts).not.toContain("device === 'wasm' && wasm");

        const wxt = source('wxt.config.ts');
        expect(wxt).toContain('resolveOnnxWasmVariant');
        expect(wxt).toContain('ort-wasm-simd-threaded.${onnxVariant}.mjs');
        expect(wxt).toContain('ort-wasm-simd-threaded.${onnxVariant}.wasm');

        expect(resolveOnnxWasmVariant()).toBe('jspi');
        vi.stubGlobal('__FLUENTREAD_ONNX_WASM_VARIANT__', 'asyncify');
        expect(resolveOnnxWasmVariant()).toBe('asyncify');
        vi.stubGlobal('__FLUENTREAD_ONNX_WASM_VARIANT__', 'jspi');
        expect(resolveOnnxWasmVariant()).toBe('jspi');
        vi.unstubAllGlobals();

        expect(resolveOnnxWasmAssetPaths(p => `chrome-extension://id/${p}`, {variant: 'jspi'})).toEqual({
            mjs: 'chrome-extension://id/fluent-read-ai/ort-wasm-simd-threaded.jspi.mjs',
            wasm: 'chrome-extension://id/fluent-read-ai/ort-wasm-simd-threaded.jspi.wasm',
        });
        expect(resolveOnnxWasmAssetPaths(p => `safari-web-extension://id/${p}`, {variant: 'asyncify'})).toEqual({
            mjs: 'safari-web-extension://id/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs',
            wasm: 'safari-web-extension://id/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm',
        });
    });

    it('检测 WebAssembly JSPI 能力并按打包变体在缺少 JSPI 时快速拒绝', () => {
        vi.stubGlobal('WebAssembly', {Suspending: function () {}, promising: function () {}});
        expect(supportsOnnxJspi()).toBe(true);
        expect(supportsOnnxWasmRuntime('jspi')).toBe(true);
        expect(supportsOnnxWasmRuntime('asyncify')).toBe(true);
        expect(() => assertOnnxWasmRuntimeSupported('jspi')).not.toThrow();

        vi.stubGlobal('WebAssembly', {});
        expect(supportsOnnxJspi()).toBe(false);
        expect(supportsOnnxWasmRuntime('jspi')).toBe(false);
        expect(supportsOnnxWasmRuntime('asyncify')).toBe(true);
        expect(() => assertOnnxWasmRuntimeSupported('asyncify')).not.toThrow();
        expect(() => assertOnnxWasmRuntimeSupported('jspi')).toThrow(ONNX_WASM_JSPI_UNSUPPORTED_CODE);

        const throwingWasm = Object.defineProperty({}, 'Suspending', {get() { throw new Error('blocked'); }});
        vi.stubGlobal('WebAssembly', throwingWasm);
        expect(supportsOnnxJspi()).toBe(false);

        expect(isOnnxJspiUnsupportedError(new Error(`${ONNX_WASM_JSPI_UNSUPPORTED_CODE}: missing`))).toBe(true);
        expect(isOnnxJspiUnsupportedError(new Error('other error'))).toBe(false);
        expect(isOnnxJspiUnsupportedError('not-an-error')).toBe(false);
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

describe('kokoro modular transformers build plugin', () => {
    it('仅重定向 Kokoro 专用 transformers 入口与内部浏览器空桩，不影响 v3.8.1 Worker', () => {
        const plugin = kokoroTransformersBuildPlugin();
        const resolveId = plugin.resolveId as (source: string, importer?: string) => string | null;
        const load = plugin.load as (id: string) => string | null;

        const directId = resolveId('@huggingface/transformers-kokoro', '/repo/src/features/local-tts/offscreen/tts.worker.ts');
        const kokoroJsId = resolveId('@huggingface/transformers', '/repo/node_modules/@uzen/kokoro-js/dist/kokoro.js');
        const pnpmKokoroId = resolveId('@huggingface/transformers', '/repo/node_modules/.pnpm/@uzen+kokoro-js@1.2.4/node_modules/@uzen/kokoro-js/dist/kokoro.js');
        expect(directId).toBeTruthy();
        expect(kokoroJsId).toBe(directId);
        expect(pnpmKokoroId).toBe(directId);

        // 其他 Worker 使用 @huggingface/transformers v3.8.1，绝不能被拦截。
        expect(resolveId('@huggingface/transformers', '/repo/src/features/local-translation/offscreen/translation.worker.ts')).toBeNull();
        expect(resolveId('@huggingface/transformers', '/repo/src/features/video-subtitle/offscreen/transcription.worker.ts')).toBeNull();
        expect(resolveId('@huggingface/transformers', '/repo/src/features/information-highlight/offscreen/worker.ts')).toBeNull();

        const entryCode = load(directId!);
        expect(entryCode).toContain('StyleTextToSpeech2Model');
        expect(entryCode).toContain('AutoTokenizer');
        expect(entryCode).toContain('MODEL_TYPE_MAPPING');
        expect(entryCode).toContain('registerTaskMappings');

        const kokoroSrcImporter = resolve(
            realpathSync(resolve(process.cwd(), 'node_modules/@huggingface/transformers-kokoro')),
            'src/env.js',
        );
        const emptyStub = resolveId('node:fs', kokoroSrcImporter);
        const streamStub = resolveId('node:stream', kokoroSrcImporter);
        const streamPromisesStub = resolveId('node:stream/promises', kokoroSrcImporter);
        const jinjaStub = resolveId('@huggingface/jinja', kokoroSrcImporter);
        expect(emptyStub).toBeTruthy();
        expect(resolveId('onnxruntime-node', kokoroSrcImporter)).toBe(emptyStub);
        expect(load(emptyStub!)).toContain('export default {}');
        expect(load(streamStub!)).toContain('Readable');
        expect(load(streamPromisesStub!)).toContain('pipeline');
        expect(load(jinjaStub!)).toContain('export class Template');

        // 浏览器空桩仅限 @huggingface/transformers@4.2.0/src/ 内部使用。
        expect(resolveId('node:fs', '/repo/src/features/local-tts/offscreen/tts.worker.ts')).toBeNull();
        expect(resolveId('@huggingface/jinja', '/repo/src/features/local-translation/offscreen/translation.worker.ts')).toBeNull();
        expect(load('\0unrelated-virtual-id')).toBeNull();
    });

    it('在真实 Vite/Rolldown 构建中裁剪无关模型架构并端到端运行 KokoroTTS 推理与释放', async () => {
        const virtualEntry = '\0test-kokoro-runtime-entry';
        const virtualOrt = '\0test-kokoro-fake-ort';
        const virtualOrtCommon = '\0test-kokoro-fake-ort-common';
        const virtualPhonemizer = '\0test-kokoro-fake-phonemizer';
        const virtualPinyin = '\0test-kokoro-fake-pinyin';

        const bundleWith = async (extraPlugins: ReturnType<typeof kokoroTransformersBuildPlugin>[], fakeRuntime: boolean) => {
            const result = await viteBuild({
                configFile: false,
                logLevel: 'error',
                plugins: [
                    {
                        name: 'test-kokoro-harness',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === virtualEntry) return id;
                            if (!fakeRuntime) return null;
                            if (id === 'onnxruntime-web' || id === 'onnxruntime-web/webgpu') return virtualOrt;
                            if (id === 'onnxruntime-common') return virtualOrtCommon;
                            if (id === 'phonemizer') return virtualPhonemizer;
                            if (id === 'pinyin-pro') return virtualPinyin;
                            return null;
                        },
                        load(id) {
                            if (id === virtualEntry) {
                                return [
                                    'import {KokoroTTS, env as kokoroEnv} from "@uzen/kokoro-js";',
                                    'import {env as tfEnv, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio} from "@huggingface/transformers-kokoro";',
                                    'export {KokoroTTS, kokoroEnv, tfEnv, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio};',
                                ].join('\n');
                            }
                            if (id === virtualOrtCommon) {
                                return 'export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } dispose() {} }';
                            }
                            if (id === virtualOrt) {
                                return [
                                    'import {Tensor} from "onnxruntime-common";',
                                    'export {Tensor};',
                                    'export const env = {wasm: {numThreads: 1, wasmPaths: undefined}, webgpu: {}, logLevel: "warning"};',
                                    'export const InferenceSession = {',
                                    '  async create(buffer, options) {',
                                    '    globalThis.__kokoroTestOrtCalls.push({kind: "create", byteLength: buffer.byteLength, options});',
                                    '    return {',
                                    '      inputNames: ["input_ids", "style", "speed"],',
                                    '      outputNames: ["waveform"],',
                                    '      async run(feeds) {',
                                    '        globalThis.__kokoroTestOrtCalls.push({kind: "run", feedKeys: Object.keys(feeds), inputIds: Array.from(feeds.input_ids.data, Number), styleDims: feeds.style.dims, speed: Array.from(feeds.speed.data)});',
                                    '        return {waveform: new Tensor("float32", new Float32Array([0.25, -0.25, 0.5]), [3])};',
                                    '      },',
                                    '      async release() { globalThis.__kokoroTestOrtCalls.push({kind: "release"}); },',
                                    '    };',
                                    '  },',
                                    '};',
                                    'export default {env, InferenceSession, Tensor};',
                                ].join('\n');
                            }
                            if (id === virtualPhonemizer) return 'export const phonemize = async (text) => [text];';
                            if (id === virtualPinyin) return 'export const pinyin = (text) => [text];';
                            return null;
                        },
                    },
                    ...(fakeRuntime ? [] : [sharedOnnxBuildPlugin()]),
                    ...extraPlugins,
                ],
                build: {
                    write: false,
                    target: 'chrome137',
                    minify: true,
                    rolldownOptions: {
                        input: virtualEntry,
                        preserveEntrySignatures: 'strict',
                        external: fakeRuntime ? [] : ['onnxruntime-web', 'onnxruntime-web/webgpu', 'onnxruntime-common', 'phonemizer', 'pinyin-pro'],
                        output: {format: 'es', codeSplitting: false},
                    },
                },
            });
            const first = Array.isArray(result) ? result[0]! : result;
            if (!('output' in first)) throw new Error('Expected RollupOutput from viteBuild');
            const chunk = first.output.find((item): item is Extract<typeof item, {type: 'chunk'}> => item.type === 'chunk');
            if (!chunk) throw new Error('Missing entry chunk from viteBuild');
            return chunk.code;
        };

        const baselineCode = await bundleWith([], false);
        const modularCode = await bundleWith([kokoroTransformersBuildPlugin()], false);
        expect(Buffer.byteLength(baselineCode, 'utf8') - Buffer.byteLength(modularCode, 'utf8')).toBeGreaterThan(250_000);
        for (const removedSymbol of ['BertModel', 'GPT2Model', 'WhisperModel', 'CLIPModel', 'ImageFeatureExtractor']) {
            expect(baselineCode).toContain(removedSymbol);
            expect(modularCode).not.toContain(removedSymbol);
        }
        expect(modularCode).toContain('StyleTextToSpeech2Model');

        const runnableCode = await bundleWith([kokoroTransformersBuildPlugin()], true);
        const ortCalls: Array<Record<string, unknown>> = [];
        const savedProcess = globalThis.process;
        const savedSelf = (globalThis as {self?: unknown}).self;
        const savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'constructor');
        const savedFetch = globalThis.fetch;
        (globalThis as Record<string, unknown>).__kokoroTestOrtCalls = ortCalls;
        (globalThis as {self?: unknown}).self = globalThis;
        Object.defineProperty(globalThis, 'constructor', {value: {name: 'DedicatedWorkerGlobalScope'}, configurable: true});
        Object.defineProperty(globalThis, 'process', {value: undefined, configurable: true, writable: true});

        let mod: Record<string, any>;
        try {
            mod = await import(`data:text/javascript;base64,${Buffer.from(runnableCode, 'utf8').toString('base64')}`);
        } finally {
            Object.defineProperty(globalThis, 'process', {value: savedProcess, configurable: true, writable: true});
            if (savedDescriptor) Object.defineProperty(globalThis, 'constructor', savedDescriptor);
            else delete (globalThis as {constructor?: unknown}).constructor;
            if (savedSelf === undefined) delete (globalThis as {self?: unknown}).self;
            else (globalThis as {self?: unknown}).self = savedSelf;
        }

        try {
            mod.tfEnv.allowLocalModels = false;
            mod.kokoroEnv.allowLocalModels = true;
            expect(mod.tfEnv.allowLocalModels).toBe(true);
            mod.tfEnv.allowLocalModels = false;
            mod.tfEnv.allowRemoteModels = true;
            mod.tfEnv.useBrowserCache = false;
            mod.tfEnv.useWasmCache = false;
            mod.kokoroEnv.wasmPaths = {mjs: 'ort.mjs', wasm: 'ort.wasm'};
            expect(mod.tfEnv.backends.onnx.wasm.wasmPaths).toEqual({mjs: 'ort.mjs', wasm: 'ort.wasm'});

            const voiceBytes = new Float32Array(512 * 256).fill(0.1).buffer;
            const mockFiles: Record<string, string> = {
                'config.json': JSON.stringify({model_type: 'style_text_to_speech_2', architectures: ['StyleTextToSpeech2Model']}),
                'tokenizer_config.json': JSON.stringify({tokenizer_class: 'PreTrainedTokenizer', model_max_length: 512}),
                'tokenizer.json': JSON.stringify({
                    version: '1.0',
                    truncation: null,
                    padding: null,
                    added_tokens: [],
                    normalizer: null,
                    pre_tokenizer: {type: 'Split', pattern: {Regex: ''}, behavior: 'Isolated', invert: false},
                    post_processor: {
                        type: 'TemplateProcessing',
                        single: [{SpecialToken: {id: '$', type_id: 0}}, {Sequence: {id: 'A', type_id: 0}}, {SpecialToken: {id: '$', type_id: 0}}],
                        pair: [],
                        special_tokens: {$: {id: '$', ids: [0], tokens: ['$']}},
                    },
                    decoder: null,
                    model: {type: 'WordLevel', vocab: {$: 0, h: 1, i: 2}, unk_token: '$'},
                }),
            };
            const fakeFetch = async (input: RequestInfo | URL) => {
                const url = String(input);
                for (const [name, body] of Object.entries(mockFiles)) {
                    if (url.endsWith(`/${name}`)) return new Response(body, {status: 200, headers: {'content-type': 'application/json'}});
                }
                if (url.endsWith('.onnx')) return new Response(new Uint8Array([1, 2, 3, 4]), {status: 200});
                if (url.endsWith('.bin')) return new Response(voiceBytes, {status: 200});
                return new Response('not found', {status: 404});
            };
            mod.tfEnv.fetch = fakeFetch;
            globalThis.fetch = fakeFetch as typeof fetch;

            const tts = await mod.KokoroTTS.from_pretrained('hexgrad/Kokoro-82M-v1.1-zh', {
                dtype: 'fp32',
                device: 'wasm',
                model_file_name: 'model',
                voicePath: 'https://example.test/voices',
            });
            const audio = await tts.generate('hi', {voice: 'af_maple', speed: 1.25});
            expect(audio.sampling_rate).toBe(24_000);
            expect(Array.from(audio.audio)).toEqual([0.25, -0.25, 0.5]);
            expect(() => tts.tokenizer.apply_chat_template([], {chat_template: '{{ messages }}'}))
                .toThrow('Chat templates are not bundled in the Kokoro TTS runtime.');
            await tts.model.dispose();

            expect(ortCalls).toEqual([
                {kind: 'create', byteLength: 4, options: {logSeverityLevel: 3, executionProviders: ['wasm']}},
                {kind: 'run', feedKeys: ['input_ids', 'style', 'speed'], inputIds: [0, 1, 2, 0], styleDims: [1, 256], speed: [1.25]},
                {kind: 'release'},
            ]);
        } finally {
            globalThis.fetch = savedFetch;
            delete (globalThis as Record<string, unknown>).__kokoroTestOrtCalls;
        }
    }, 30_000);
});
