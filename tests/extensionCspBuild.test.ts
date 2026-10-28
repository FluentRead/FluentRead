import {describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createContext, runInContext} from 'node:vm';
import {extensionCspBuildPlugin, patchExtensionVendorSource, type ExtensionVendorSource} from '../scripts/testing/extension-csp-build';
import {defuddleEntityBuildPlugin, patchDefuddleEntitySource, replaceDefuddleEntityDecoder} from '../scripts/testing/defuddle-entity-build';
import {decodeTextareaHtml} from '../src/shared/text/htmlEntities';

const require = createRequire(import.meta.url);
const tesseractRequire = createRequire(require.resolve('tesseract.js'));
const transformersRequire = createRequire(require.resolve('@huggingface/transformers-kokoro'));
const sources: Record<ExtensionVendorSource, string> = {
    'tesseract-worker': require.resolve('tesseract.js/dist/worker.min.js'),
    'regenerator-runtime': tesseractRequire.resolve('regenerator-runtime/runtime.js'),
    'jszip': require.resolve('jszip/dist/jszip.min.js'),
    'pdfjs-main': require.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
    'pdfjs-worker': require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
    'fontkit': path.join(path.dirname(require.resolve('@pdf-lib/fontkit')), 'fontkit.es.js'),
    'lodash-root': createRequire(require.resolve('element-plus')).resolve('lodash-es/_root.js'),
    'onnx-asyncify': path.join(path.dirname(transformersRequire.resolve('onnxruntime-web/webgpu')), 'ort-wasm-simd-threaded.asyncify.mjs'),
};
const original = (kind: ExtensionVendorSource) => fs.readFileSync(sources[kind], 'utf8');
const patched = (kind: ExtensionVendorSource) => patchExtensionVendorSource(kind, original(kind));
const sandbox = (values: Record<string, unknown> = {}) => createContext(values, {codeGeneration: {strings: false, wasm: false}});

describe('extension dependency CSP packaging', () => {
    it('固定 Defuddle UMD 入口并只替换实体解码，保留默认导出的构造器', () => {
        const sourcePath = require.resolve('defuddle');
        const source = fs.readFileSync(sourcePath, 'utf8');
        const result = patchDefuddleEntitySource(source);
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
        expect(result).not.toContain('e.decodeHTMLEntities=function(t,e){const r=t.createElement("textarea");return r.innerHTML=e,r.value}');
        expect(() => patchDefuddleEntitySource(source + '\n')).toThrow(/Unsupported Defuddle source/);
        const anchor = 'e.decodeHTMLEntities=function(t,e){const r=t.createElement("textarea");return r.innerHTML=e,r.value}';
        expect(replaceDefuddleEntityDecoder(anchor)).toBe('e.decodeHTMLEntities=function(t,e){return __fluentreadDecodeTextareaHtml(e,t)}');
        expect(() => replaceDefuddleEntityDecoder('missing')).toThrow(/Missing or ambiguous/);
        expect(() => replaceDefuddleEntityDecoder(anchor + anchor)).toThrow(/Missing or ambiguous/);
        const plugin = defuddleEntityBuildPlugin();
        const transform = plugin.transform as (source: string, id: string) => {code: string} | undefined;
        expect(transform(source, '\0virtual')).toBeUndefined();
        expect(transform(source, sourcePath + '?commonjs-proxy')).toBeUndefined();
        expect(transform(source, sourcePath)?.code).toBe(result);

        const context = sandbox({__fluentreadDecodeTextareaHtml: decodeTextareaHtml});
        runInContext(result.replace(/^import[^\n]+\n/u, '')
            .replace('export default module.exports;', 'globalThis.fixtureDefuddle = module.exports;'), context);
        expect(context.fixtureDefuddle).toBeTypeOf('function');
        expect(Object.getOwnPropertyNames(context.fixtureDefuddle.prototype))
            .toEqual(Object.getOwnPropertyNames(require('defuddle').prototype));
    });

    it.each(Object.keys(sources) as ExtensionVendorSource[])('固定完整 %s 源码，拒绝上游变化且不修改原依赖', kind => {
        const source = original(kind);
        const result = patchExtensionVendorSource(kind, source);
        expect(result).not.toBe(source);
        expect(fs.readFileSync(sources[kind], 'utf8')).toBe(source);
        expect(result).not.toMatch(/\b(?:new\s+)?Function\s*\(/);
        expect(() => patchExtensionVendorSource(kind, `${source}\n`)).toThrow(/Unsupported/);
        expect(() => patchExtensionVendorSource(kind, result)).toThrow(/Unsupported/);
    });

    it('JSZip 在禁用字符串代码执行的上下文中保留异步压缩和解压', async () => {
        const context = sandbox({module: {exports: {}}, exports: {}, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, Promise});
        context.self = context;
        runInContext(patched('jszip'), context);
        const Zip = context.module.exports;
        const input = new Zip();
        input.file('hello.txt', '你好 Firefox');
        const bytes = await input.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
        const restored = await Zip.loadAsync(bytes, {checkCRC32: true});
        expect(await restored.file('hello.txt').async('string')).toBe('你好 Firefox');
    });

    it('fontkit 在禁用 eval 的上下文中仍可解析、布局和生成真实字体子集', async () => {
        const context = sandbox({Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Buffer, console, setTimeout, clearTimeout,
            pako: createRequire(require.resolve('@pdf-lib/fontkit'))('pako')});
        runInContext(patched('fontkit').replace("import pako from 'pako';", '')
            .replace('export default fontkit;', 'globalThis.fixtureFontkit=fontkit;'), context);
        const font = context.fixtureFontkit.create(new Uint8Array(fs.readFileSync(new URL('../public/pdfjs/standard_fonts/LiberationSans-Regular.ttf', import.meta.url))));
        const run = font.layout('Firefox 142');
        expect(run.glyphs.length).toBe(11);
        const subset = font.createSubset();
        run.glyphs.forEach((glyph: unknown) => subset.includeGlyph(glyph));
        const bytes = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            subset.encodeStream().on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)))
                .on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
        });
        expect(bytes.byteLength).toBeGreaterThan(1000);
        expect(bytes.byteLength).toBeLessThan(font.stream.buffer.length);
    });

    it('PDF 主模块和 Worker 都固定走解释执行，不保留 JIT 或动态 require', () => {
        expect(patched('pdfjs-main')).toContain('function isEvalSupported() { return false; }');
        const worker = patched('pdfjs-worker');
        expect(worker).toContain('function isEvalSupported(){return!1}');
        expect(worker).toContain('new PostScriptEvaluator(o)');
        expect(worker).not.toContain('new Function');
    });

    it('regenerator 和 lodash 保留现代浏览器全局且无需编译字符串', () => {
        const context = sandbox({module: {exports: {}}});
        runInContext(`'use strict';${patched('regenerator-runtime')}`, context);
        expect(context.regeneratorRuntime.wrap).toBeTypeOf('function');
        const root = patched('lodash-root').replace("import freeGlobal from './_freeGlobal.js';", 'var freeGlobal=undefined;')
            .replace('export default root;', 'globalThis.fixtureRoot=root;');
        runInContext(root, context);
        expect(context.fixtureRoot).toBe(context.fixtureRoot.globalThis);
    });

    it('模块 transform 仅匹配固定依赖，?url PDF Worker 生成静态资源引用', async () => {
        const plugin = extensionCspBuildPlugin();
        const transform = plugin.transform as (source: string, id: string) => {code: string} | undefined;
        expect(transform('const x=1;', '/src/business.ts')).toBeUndefined();
        expect(transform('wrapper', '\0/vendor/jszip/dist/jszip.min.js')).toBeUndefined();
        expect(transform('wrapper', `${sources.jszip}?commonjs-proxy`)).toBeUndefined();
        expect(transform(original('jszip'), sources.jszip)?.code).toBe(patched('jszip'));
        const emitFile = vi.fn(() => 'fixture');
        const load = plugin.load as (this: unknown, id: string) => string | undefined;
        expect(load.call({emitFile}, sources['pdfjs-worker'])).toBeUndefined();
        expect(load.call({emitFile}, `${sources['pdfjs-worker']}?url`)).toBe('export default import.meta.ROLLUP_FILE_URL_fixture;');
        expect(emitFile).toHaveBeenCalledWith({type: 'asset', name: 'pdf.worker.min.mjs', source: patched('pdfjs-worker'), needsCodeReference: true});
    });

    it('摇树删除未使用的 PDF Worker，实际引用时保留 CSP 安全的资源', async () => {
        const {rollup} = createRequire(require.resolve('vite'))('rollup');
        const build = async (used: boolean) => {
            const bundle = await rollup({
                input: 'fixture-entry',
                plugins: [{
                    name: 'fixture',
                    resolveId(id: string) {
                        if (id === 'fixture-entry') return '\0fixture-entry';
                        if (id === 'fixture-worker') return `${sources['pdfjs-worker']}?url`;
                    },
                    load(id: string) {
                        if (id === '\0fixture-entry') return `import worker from 'fixture-worker'; export const value = ${used ? 'worker' : '1'};`;
                    },
                }, extensionCspBuildPlugin()],
            });
            try {
                return (await bundle.generate({format: 'es'})).output;
            } finally {
                await bundle.close();
            }
        };
        expect((await build(false)).filter((file: {type: string}) => file.type === 'asset')).toHaveLength(0);
        const output = await build(true);
        const assets = output.filter((file: {type: string}) => file.type === 'asset');
        expect(assets).toHaveLength(1);
        expect(assets[0].source).toBe(patched('pdfjs-worker'));
        expect(output.find((file: {type: string}) => file.type === 'chunk').code).toContain(assets[0].fileName);
    });
});

describe('ONNX static Emscripten invoker', () => {
    const setup = (kind: number, target: unknown, returnVoid = false, argumentCount = 2) => {
        const reads: number[] = [];
        const returnType = {name: 'result', ee: returnVoid, Sc: vi.fn(function (this: unknown, destructors: unknown, value: unknown) {
            expect(this).toBe(returnType);
            return {value, destructors};
        })};
        const types = [returnType, ...[0, 1].slice(0, argumentCount).map(index => ({name: `arg${index}`, Rc(pointer: number) {
            reads.push(pointer);
            return pointer === 100 ? 7 : 9;
        }}))];
        const Kg = vi.fn((convert, reference, value) => convert(reference, value));
        const context = sandbox({Jg: () => types, R: () => target, Mg: () => 'method', Kg, Ig: (fn: unknown) => fn});
        const source = patched('onnx-asyncify');
        const start = source.indexOf('function Pb('), end = source.indexOf('function Rb(', start);
        runInContext(`${source.slice(start, end)};globalThis.fixture=Pb(3,0,${kind});`, context);
        return {invoke: context.fixture, reads, Kg, returnType};
    };

    it('普通函数保留参数偏移、原 JIT 的 this 和返回转换', () => {
        const target = vi.fn(function (this: unknown, first: number, second: number) {expect(this).toBeUndefined(); return first + second;});
        const {invoke, reads, Kg} = setup(0, target);
        expect(invoke(1, 0, 88, 100)).toEqual({value: 16, destructors: 88});
        expect(reads).toEqual([100, 108]);
        expect(Kg).toHaveBeenCalledWith(expect.any(Function), 88, 16);
    });

    it('方法保留接收对象，构造器和 cast 保留原语义', () => {
        const receiver = {offset: 2, method(first: number, second: number) {return this.offset + first + second;}};
        expect(setup(1, receiver).invoke(1, 0, 4, 100).value).toBe(18);
        class Pair {sum: number; constructor(first: number, second: number) {this.sum = first + second;}}
        expect(setup(2, Pair).invoke(1, 0, 4, 100).value).toBeInstanceOf(Pair);
        expect(setup(3, undefined, false, 1).invoke(1, 0, 4, 100).value).toBe(7);
        expect(setup(3, undefined).invoke(1, 0, 4, 100).value).toBe(9);
    });

    it('void 不做返回转换，目标错误保留原异常并可重试', () => {
        const failure = new Error('target failed');
        const target = vi.fn().mockImplementationOnce(() => {throw failure;}).mockReturnValue(3);
        const {invoke, Kg} = setup(0, target, true);
        expect(() => invoke(1, 0, 4, 100)).toThrow(failure);
        expect(invoke(1, 0, 4, 100)).toBeUndefined();
        expect(Kg).not.toHaveBeenCalled();
    });

    it('方法属性读取失败时不提前转换实参，保留原 JIT 的求值顺序', () => {
        const failure = new Error('method lookup failed');
        const target = Object.defineProperty({}, 'method', {get() {throw failure;}});
        const {invoke, reads} = setup(1, target);
        expect(() => invoke(1, 0, 4, 100)).toThrow(failure);
        expect(reads).toEqual([]);
    });
});
