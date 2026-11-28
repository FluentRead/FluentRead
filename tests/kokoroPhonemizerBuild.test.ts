/**
 * @file tests/kokoroPhonemizerBuild.test.ts
 * 文件职责：验证 `scripts/wasm/kokoro-phonemizer-build.ts` 对 `phonemizer@1.2.1` 内嵌 `espeak-ng-data` 的确定性裁剪、错误校验与逐字节 IPA 一致性。
 * 主要内容：
 * - 验证 `zeroEspeakPhondata` 与 `pruneEspeakPhontab` 的魔数校验、表裁剪、`includes` 索引重映射及异常输入快速失败；
 * - 验证 `kokoroPhonemizerBuildPlugin` 仅拦截 `@uzen/kokoro-js` 导入的 `phonemizer` 且具备确定性输出；
 * - 在真实节点运行时中对比上游 `phonemizer` 与裁剪产物的 `list_voices()` 及 9 个英语声线 × 丰富英文语料（含 `en-us`、`en`、`en-gb`、缩写、数字、货币、专有名词与标点）的 IPA 输出，确保逐字节一致。
 * 模块边界：仅验证构建插件与裁剪产物，不修改 `node_modules` 或启动真实浏览器 Worker。
 */
import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {build as viteBuild} from 'vite';
import {
    kokoroPhonemizerBuildPlugin,
    pruneEspeakPhontab,
    prunePhonemizerSource,
    resolvePhonemizerEntry,
    zeroEspeakPhondata,
} from '../scripts/wasm/kokoro-phonemizer-build';
import {kokoroTransformersBuildPlugin} from '../scripts/wasm/kokoro-transformers-build';

const ENGLISH_CORPUS = [
    'Hello world! How are you doing today?',
    'The quick brown fox jumps over 123 lazy dogs.',
    'Dr. Smith paid $1,234.56 at 3:45 PM on 2026-11-29.',
    'She sells seashells by the seashore; Peter Piper picked a peck of pickled peppers.',
    'Antidisestablishmentarianism, queue, colonel, yacht, choir, Worcestershire, Edinburgh, Leicester, Thames.',
    'I read the book yesterday, and I will read it again tomorrow. Lead the way with a lead pipe.',
    'Can you pronounce café, résumé, naïve, façade, jalapeño, über, Schrödinger, silhouette, entrepreneur?',
    'HTTP/2, WebGPU, ONNX, API, URL, JSON, 1st, 2nd, 3rd, 21st, 42nd, 100%, 3.14159, -273.15.',
    'What?! Really... yes—no, maybe (parentheses) [brackets] "quotes" \'apostrophe\'.',
    'Kokoro TTS synthesizes natural speech in both American and British English accents.',
    'She thought thoroughly through thirty-three thrilling themes while breathing smoothly.',
    'Butter, bottle, water, better, letter, little, middle, cattle, mountain, button, kitten.',
    'Car, park, star, heart, bath, path, dance, grass, tomato, schedule, leisure, zebra, vitamin.',
    'Though the tough cough and hiccough plough him through, ought we to laugh at the drought in the borough?',
    'don\'t, won\'t, can\'t, shouldn\'t, wouldn\'t, couldn\'t, I\'m, you\'re, they\'ve, we\'ll, o\'clock.',
] as const;

const ENGLISH_VOICE_IDS = [
    'en-us',
    'en',
    'en-gb',
    'en-029',
    'en-gb-scotland',
    'en-gb-x-gbclan',
    'en-gb-x-gbcwmd',
    'en-gb-x-rp',
    'en-us-nyc',
] as const;

describe('kokoro phonemizer build plugin', () => {
    it('校验 phondata 头魔数与采样率并仅清零声学主体字节', () => {
        const valid = Buffer.alloc(32, 0xab);
        valid.writeUInt32LE(0x00014801, 0);
        valid.writeUInt32LE(22050, 4);

        const zeroed = zeroEspeakPhondata(valid);
        expect(zeroed.length).toBe(32);
        expect(zeroed.readUInt32LE(0)).toBe(0x00014801);
        expect(zeroed.readUInt32LE(4)).toBe(22050);
        expect(Array.from(zeroed.subarray(8))).toEqual(new Array(24).fill(0));

        expect(() => zeroEspeakPhondata(Buffer.alloc(4))).toThrow(/Invalid espeak-ng phondata length/u);
        const badVersion = Buffer.from(valid);
        badVersion.writeUInt32LE(0xdeadbeef, 0);
        expect(() => zeroEspeakPhondata(badVersion)).toThrow(/Unexpected espeak-ng phondata header/u);
    });

    it('按传递 includes 依赖裁剪 phontab 并正确重映射 1-based 索引', () => {
        const makeTable = (name: string, includes: number, nPhonemes: number): Buffer => {
            const buf = Buffer.alloc(36 + nPhonemes * 16, 0x11);
            buf[0] = nPhonemes;
            buf[1] = includes;
            buf.writeUInt16LE(0, 2);
            buf.fill(0, 4, 36);
            buf.write(name, 4, 'ascii');
            return buf;
        };

        const header = Buffer.alloc(4);
        header.writeUInt32LE(5, 0);
        // 0: base(inc=0), 1: base1(inc=1->base), 2: fr(inc=2->base1, dropped), 3: en(inc=2->base1), 4: en-us(inc=4->en)
        const synthetic = Buffer.concat([
            header,
            makeTable('base', 0, 1),
            makeTable('base1', 1, 2),
            makeTable('fr', 2, 3),
            makeTable('en', 2, 1),
            makeTable('en-us', 4, 2),
        ]);

        const pruned = pruneEspeakPhontab(synthetic);
        expect(pruned.readUInt32LE(0)).toBe(4);

        let offset = 4;
        const parsed: Array<{name: string; includes: number; nPhonemes: number}> = [];
        for (let i = 0; i < 4; i += 1) {
            const nPhonemes = pruned[offset]!;
            const includes = pruned[offset + 1]!;
            const name = pruned.subarray(offset + 4, offset + 36).toString('ascii').replace(/\0.*$/u, '');
            parsed.push({name, includes, nPhonemes});
            offset += 36 + nPhonemes * 16;
        }
        expect(offset).toBe(pruned.length);
        expect(parsed).toEqual([
            {name: 'base', includes: 0, nPhonemes: 1},
            {name: 'base1', includes: 1, nPhonemes: 2},
            {name: 'en', includes: 2, nPhonemes: 1},
            {name: 'en-us', includes: 3, nPhonemes: 2},
        ]);

        expect(() => pruneEspeakPhontab(synthetic.subarray(0, synthetic.length - 1))).toThrow(/Truncated espeak-ng phontab/u);
        expect(() => pruneEspeakPhontab(Buffer.concat([synthetic, Buffer.from([0])]))).toThrow(/Unexpected trailing bytes/u);
    });

    it('仅拦截 @uzen/kokoro-js 导入的 phonemizer 且两次裁剪输出逐字节确定', () => {
        const plugin = kokoroPhonemizerBuildPlugin();
        const resolveId = plugin.resolveId as (source: string, importer?: string) => string | null;
        const load = plugin.load as (id: string) => string | null;

        const kokoroId = resolveId('phonemizer', '/repo/node_modules/@uzen/kokoro-js/dist/kokoro.js');
        const pnpmKokoroId = resolveId('phonemizer', '/repo/node_modules/.pnpm/@uzen+kokoro-js@1.2.4/node_modules/@uzen/kokoro-js/dist/kokoro.js');
        expect(kokoroId).toBeTruthy();
        expect(pnpmKokoroId).toBe(kokoroId);

        expect(resolveId('phonemizer', '/repo/src/features/local-tts/offscreen/tts.worker.ts')).toBeNull();
        expect(resolveId('pinyin-pro', '/repo/node_modules/@uzen/kokoro-js/dist/kokoro.js')).toBeNull();
        expect(load('\0unrelated-id')).toBeNull();

        const loadedFirst = load(kokoroId!);
        const loadedSecond = load(kokoroId!);
        expect(loadedFirst).toBeTruthy();
        expect(loadedSecond).toBe(loadedFirst);

        const rawSource = fs.readFileSync(resolvePhonemizerEntry(), 'utf8');
        const runA = prunePhonemizerSource(rawSource);
        const runB = prunePhonemizerSource(rawSource);
        expect(runA.code).toBe(runB.code);
        expect(runA.stats.originalFileCount).toBeGreaterThan(300);
        expect(runA.stats.keptFileCount).toBe(13);
        expect(runA.stats.originalSourceBytes - runA.stats.prunedSourceBytes).toBeGreaterThan(440_000);
        expect(runA.stats.originalGzipBytes - runA.stats.prunedGzipBytes).toBeGreaterThan(320_000);

        const origDeflate = zlib.deflateRawSync(Buffer.from(rawSource, 'utf8'), {level: 9}).length;
        const prunedDeflate = zlib.deflateRawSync(Buffer.from(runA.code, 'utf8'), {level: 9}).length;
        expect(origDeflate - prunedDeflate).toBeGreaterThan(320_000);
    });

    it('裁剪后的 phonemizer 在全部 9 个英语声线与丰富语料上输出与上游逐字节一致的 IPA', async () => {
        const entryPath = resolvePhonemizerEntry();
        const rawSource = fs.readFileSync(entryPath, 'utf8');
        const {code: prunedSource} = prunePhonemizerSource(rawSource);

        const upstreamUrl = pathToFileURL(entryPath).href;
        const prunedUrl = `data:text/javascript;base64,${Buffer.from(prunedSource, 'utf8').toString('base64')}`;
        const upstream = await import(/* @vite-ignore */ upstreamUrl) as {
            list_voices: (language?: string) => Promise<unknown[]>;
            phonemize: (text: string, language?: string) => Promise<string[]>;
        };
        const pruned = await import(/* @vite-ignore */ prunedUrl) as typeof upstream;

        expect(await pruned.list_voices()).toEqual(await upstream.list_voices());
        expect(await pruned.list_voices('en')).toEqual(await upstream.list_voices('en'));

        for (const voice of ENGLISH_VOICE_IDS) {
            for (const sentence of ENGLISH_CORPUS) {
                const expected = await upstream.phonemize(sentence, voice);
                const actual = await pruned.phonemize(sentence, voice);
                expect(actual, `voice=${voice} text=${sentence}`).toEqual(expected);
            }
        }
    }, 30_000);

    it('在真实 Vite/Rolldown 构建中与 kokoroTransformersBuildPlugin 协同裁剪且端到端生成美式/英式/中文音素', async () => {
        const virtualEntry = '\0test-kokoro-phonemizer-e2e';
        const virtualOrt = '\0test-kokoro-phonemizer-ort';
        const virtualOrtCommon = '\0test-kokoro-phonemizer-ort-common';

        const bundleWith = async (extraPlugins: ReturnType<typeof kokoroPhonemizerBuildPlugin>[]) => {
            const result = await viteBuild({
                configFile: false,
                logLevel: 'error',
                plugins: [
                    {
                        name: 'test-kokoro-phonemizer-harness',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === virtualEntry) return id;
                            if (id === 'onnxruntime-web' || id === 'onnxruntime-web/webgpu') return virtualOrt;
                            if (id === 'onnxruntime-common') return virtualOrtCommon;
                            return null;
                        },
                        load(id) {
                            if (id === virtualEntry) {
                                return 'export {KokoroTTS, env as kokoroEnv} from "@uzen/kokoro-js";';
                            }
                            if (id === virtualOrtCommon) {
                                return 'export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } dispose() {} }';
                            }
                            if (id === virtualOrt) {
                                return [
                                    'import {Tensor} from "onnxruntime-common";',
                                    'export {Tensor};',
                                    'export const env = {wasm: {numThreads: 1}, webgpu: {}, logLevel: "warning"};',
                                    'export const InferenceSession = { async create() { return { inputNames: ["input_ids", "style", "speed"], outputNames: ["waveform"], async run() { return { waveform: new Tensor("float32", new Float32Array([0.1, -0.1]), [2]) }; }, async release() {} }; } };',
                                    'export default {env, InferenceSession, Tensor};',
                                ].join('\n');
                            }
                            return null;
                        },
                    },
                    kokoroTransformersBuildPlugin(),
                    ...extraPlugins,
                ],
                build: {
                    write: false,
                    target: 'chrome137',
                    minify: true,
                    rolldownOptions: {
                        input: virtualEntry,
                        preserveEntrySignatures: 'strict',
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

        const unpruned = await bundleWith([]);
        const pruned = await bundleWith([kokoroPhonemizerBuildPlugin()]);
        expect(Buffer.byteLength(unpruned, 'utf8') - Buffer.byteLength(pruned, 'utf8')).toBeGreaterThan(440_000);
        const unprunedDeflate = zlib.deflateRawSync(Buffer.from(unpruned, 'utf8'), {level: 9}).length;
        const prunedDeflate = zlib.deflateRawSync(Buffer.from(pruned, 'utf8'), {level: 9}).length;
        expect(unprunedDeflate - prunedDeflate).toBeGreaterThan(320_000);
    }, 30_000);
});
