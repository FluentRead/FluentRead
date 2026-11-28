/**
 * @file tests/fontkitSlimBuild.test.ts
 * 文件职责：验证 scripts/testing/fontkit-slim-build.ts 对 @pdf-lib/fontkit 的裁剪安全性、SHA-256 锁定、真实字体嵌入等价性与体积收益。
 * 主要内容：核对插件同时支持原始源码与 CSP 适配后源码并拒绝上游未审核变更；在禁 eval 沙箱中加载裁剪后 fontkit 并接入 pdf-lib，使用真实 WOFF2（Noto Sans SC）和 TTF（Liberation Sans）验证字符集、宽度测量、变体选择符与子集字节与未裁剪版本逐项等价，同时度量 Rolldown 压缩与 DEFLATE-9 体积收益。
 * 模块边界：纯离线构建期与沙箱单元测试，不修改 node_modules 原文件，不发起网络请求。
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createContext, runInContext} from 'node:vm';
import {deflateRawSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import originalFontkit from '@pdf-lib/fontkit';
import {patchExtensionVendorSource} from '../scripts/testing/extension-csp-build';
import {
    applyFontkitSlimTransforms,
    FONTKIT_CSP_PATCHED_SHA256,
    FONTKIT_RAW_SHA256,
    fontkitSlimBuildPlugin,
    slimFontkitSource,
} from '../scripts/testing/fontkit-slim-build';

const require = createRequire(import.meta.url);
const fontkitPath = path.join(path.dirname(require.resolve('@pdf-lib/fontkit')), 'fontkit.es.js');
const pakoModule = createRequire(require.resolve('@pdf-lib/fontkit'))('pako');
const notoWoff2Bytes = new Uint8Array(fs.readFileSync(new URL('../assets/pdf-fonts/FluentReadNotoSansSC-Regular.woff2', import.meta.url)));
const liberationTtfBytes = new Uint8Array(fs.readFileSync(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));

function loadFontkitInNoEvalSandbox(source: string): {fontkit: typeof originalFontkit; iconv: {decode: (buf: Buffer, enc: string) => string; encode: (str: string, enc: string) => Buffer; encodingExists: (enc: string) => boolean}} {
    const context = createContext({
        Uint8Array,
        ArrayBuffer,
        TextEncoder,
        TextDecoder,
        Buffer,
        console,
        setTimeout,
        clearTimeout,
        pako: pakoModule,
    }, {codeGeneration: {strings: false, wasm: false}});
    const runnable = source
        .replace("import pako from 'pako';", '')
        .replace('export default fontkit;', 'globalThis.__fontkit = fontkit; globalThis.__iconv = lib;');
    runInContext(runnable, context);
    return {fontkit: context.__fontkit, iconv: context.__iconv};
}

async function embedAndMeasure(
    fk: typeof originalFontkit,
    fontBytes: Uint8Array,
    samples: readonly string[],
): Promise<{
    characterSet: number[];
    widths: number[];
    pdfBytes: Uint8Array;
}> {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.registerFontkit(fk as never);
    const font = await pdf.embedFont(fontBytes, {subset: true, features: {liga: false}});
    const page = pdf.addPage([600, 400]);
    const widths: number[] = [];
    let y = 360;
    for (const sample of samples) {
        widths.push(font.widthOfTextAtSize(sample, 12));
        page.drawText(sample, {x: 40, y, size: 12, font});
        y -= 24;
    }
    const pdfBytes = await pdf.save({useObjectStreams: false});
    return {
        characterSet: font.getCharacterSet(),
        widths,
        pdfBytes,
    };
}

describe('fontkit slim build plugin', () => {
    const rawSource = fs.readFileSync(fontkitPath, 'utf8');
    const cspPatchedSource = patchExtensionVendorSource('fontkit', rawSource);

    it('锁定原始与 CSP 适配后两份 SHA-256，不改写 node_modules，拒绝上游变更', () => {
        expect(FONTKIT_RAW_SHA256).toHaveLength(64);
        expect(FONTKIT_CSP_PATCHED_SHA256).toHaveLength(64);
        expect(FONTKIT_RAW_SHA256).not.toBe(FONTKIT_CSP_PATCHED_SHA256);

        const slimFromRaw = slimFontkitSource(rawSource);
        const slimFromCsp = slimFontkitSource(cspPatchedSource);
        expect(fs.readFileSync(fontkitPath, 'utf8')).toBe(rawSource);

        const rawBytes = Buffer.byteLength(rawSource, 'utf8');
        for (const slimmed of [slimFromRaw, slimFromCsp]) {
            expect(Buffer.byteLength(slimmed, 'utf8')).toBeLessThan(rawBytes - 300_000);
            expect(slimmed).not.toContain('var cp936 = [');
            expect(slimmed).not.toContain('var cp949 = [');
            expect(slimmed).not.toContain('var cp950 = [');
            expect(slimmed).not.toContain('var eucjp = [');
            expect(slimmed).not.toContain('var shiftjis = [');
            expect(slimmed).not.toContain('var big5Added = [');
            expect(slimmed).not.toContain('function DBCSCodec(');
            expect(slimmed).not.toContain('function Utf7Codec(');
            expect(slimmed).not.toContain('function IconvLiteEncoderStream(');
            expect(slimmed).not.toContain('var extendNode = function extendNode(');
            expect(slimmed).toContain('"macroman":');
            expect(slimmed).toContain('"iso88591":');
            expect(slimmed).toContain('"windows1252":');
        }
        // CSP 适配后的裁剪副本也不包含任何字符串代码执行入口
        expect(slimFromCsp).not.toMatch(/\b(?:new\s+)?Function\s*\(/u);

        expect(() => slimFontkitSource(`${rawSource}\n`)).toThrow(/Unsupported @pdf-lib\/fontkit source/u);
        expect(() => slimFontkitSource(slimFromCsp)).toThrow(/Unsupported @pdf-lib\/fontkit source/u);
        expect(() => applyFontkitSlimTransforms('missing markers')).toThrow(/Missing or ambiguous fontkit slim marker/u);
        expect(() => applyFontkitSlimTransforms(rawSource.replace('"macroman": {', '"macroman_removed": {')))
            .toThrow(/Missing or ambiguous fontkit SBCS table entry: macroman/u);
    });

    it('Vite transform 钩子仅匹配 @pdf-lib/fontkit/dist/fontkit.es.js 并忽略虚拟与 query 模块', () => {
        const plugin = fontkitSlimBuildPlugin();
        expect(plugin.name).toBe('fluentread-fontkit-slim');
        expect(plugin.enforce).toBe('pre');
        expect(plugin.apply).toBe('build');

        const transform = plugin.transform as (source: string, id: string) => {code: string; map: null} | undefined;
        expect(transform(cspPatchedSource, '\0virtual/@pdf-lib/fontkit/dist/fontkit.es.js')).toBeUndefined();
        expect(transform(cspPatchedSource, `${fontkitPath}?commonjs-proxy`)).toBeUndefined();
        expect(transform('export default 1;', '/src/features/document-translation/services/pdfReadingFont.ts')).toBeUndefined();

        const posixResult = transform(cspPatchedSource, fontkitPath);
        expect(posixResult?.code).toBe(slimFontkitSource(cspPatchedSource));
        expect(posixResult?.map).toBeNull();

        const windowsPath = fontkitPath.replace(/\//gu, '\\');
        expect(transform(cspPatchedSource, windowsPath)?.code).toBe(posixResult?.code);
    });

    it('保留全部 OpenType/Mac/Latin1 单字节编码等价性，并拒绝已剥离的传统 DBCS/UTF-7 编码', () => {
        const originalLoaded = loadFontkitInNoEvalSandbox(cspPatchedSource);
        const slimLoaded = loadFontkitInNoEvalSandbox(slimFontkitSource(cspPatchedSource));

        const allBytes = Buffer.from(Array.from({length: 256}, (_, index) => index));
        const retainedEncodings = [
            'utf8', 'utf16le', 'utf16be', 'ascii', 'latin1', 'iso-8859-1', 'windows-1252', 'cp1252',
            'macroman', 'macintosh', 'maccenteuro', 'macgreek', 'maccyrillic', 'maciceland',
            'macturkish', 'maccroatian', 'macromania', 'macthai', 'iso-8859-6', 'iso-8859-8',
        ];
        for (const encoding of retainedEncodings) {
            expect(slimLoaded.iconv.encodingExists(encoding)).toBe(true);
            if (encoding !== 'utf16le' && encoding !== 'utf16be' && encoding !== 'utf8') {
                expect(slimLoaded.iconv.decode(allBytes, encoding)).toBe(originalLoaded.iconv.decode(allBytes, encoding));
            }
        }
        expect(Array.from(slimLoaded.iconv.encode('FluentReadNotoSansSC-Regular', 'macroman')))
            .toEqual(Array.from(originalLoaded.iconv.encode('FluentReadNotoSansSC-Regular', 'macroman')));

        for (const stripped of ['shift-jis', 'gb18030', 'cp936', 'cp949', 'big5', 'euc-jp', 'utf-7', 'koi8-r', 'cp437']) {
            expect(slimLoaded.iconv.encodingExists(stripped)).toBe(false);
        }
    });

    it('在禁 eval 沙箱中接入 pdf-lib，对真实 Noto Sans SC WOFF2（含 ASCII/CJK/希腊数学/变体选择符）与 Liberation Sans TTF 与未裁剪版本字节等价', async () => {
        const {fontkit: slimFontkit} = loadFontkitInNoEvalSandbox(slimFontkitSource(cspPatchedSource));

        // 1. 真实 FluentReadNotoSansSC-Regular.woff2：ASCII + CJK + 希腊字母 + 数学符号 + 变体选择符
        const notoSamples = [
            'FluentRead PDF Export 2026',
            '中文双语阅读与文档翻译测试',
            'α + β = γ, ∑ ∫ ≠ ≤ ≥ ∞ π Δ',
            '邊\u{E0100} 漢',
        ];
        const origNoto = await embedAndMeasure(originalFontkit, notoWoff2Bytes, notoSamples);
        const slimNoto = await embedAndMeasure(slimFontkit, notoWoff2Bytes, notoSamples);
        expect(slimNoto.characterSet).toEqual(origNoto.characterSet);
        expect(slimNoto.widths).toEqual(origNoto.widths);
        expect(slimNoto.widths.every(width => width > 0)).toBe(true);
        // 核对真实字体元数据与子集流逐字节一致（去除 pdf-lib 随机 6 字母子集前缀差异，直接比较 fontkit 原始子集输出）
        const origNotoFont = originalFontkit.create(Buffer.from(notoWoff2Bytes));
        const slimNotoFont = slimFontkit.create(Buffer.from(notoWoff2Bytes));
        expect(slimNotoFont.postscriptName).toBe(origNotoFont.postscriptName);
        expect(slimNotoFont.fullName).toBe(origNotoFont.fullName);
        expect(slimNotoFont.characterSet).toEqual(origNotoFont.characterSet);

        const encodeSubset = async (font: ReturnType<typeof originalFontkit.create>, text: string) => {
            const run = font.layout(text, {liga: false});
            const subset = font.createSubset();
            for (const glyph of run.glyphs) subset.includeGlyph(glyph);
            return new Promise<Buffer>(resolve => {
                const chunks: Buffer[] = [];
                subset.encodeStream()
                    .on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)))
                    .on('end', () => resolve(Buffer.concat(chunks)));
            });
        };
        const origNotoSubset = await encodeSubset(origNotoFont, notoSamples.join(' '));
        const slimNotoSubset = await encodeSubset(slimNotoFont, notoSamples.join(' '));
        expect(slimNotoSubset.byteLength).toBeGreaterThan(2000);
        expect(Buffer.compare(slimNotoSubset, origNotoSubset)).toBe(0);

        // 2. 真实 LiberationSans-Regular.ttf（含 MacRoman name 记录）
        const ttfSamples = ['Liberation Sans 142', 'Café résumé naïve — “quotes”'];
        const origTtf = await embedAndMeasure(originalFontkit, liberationTtfBytes, ttfSamples);
        const slimTtf = await embedAndMeasure(slimFontkit, liberationTtfBytes, ttfSamples);
        expect(slimTtf.characterSet).toEqual(origTtf.characterSet);
        expect(slimTtf.widths).toEqual(origTtf.widths);
        const origTtfFont = originalFontkit.create(Buffer.from(liberationTtfBytes));
        const slimTtfFont = slimFontkit.create(Buffer.from(liberationTtfBytes));
        expect(slimTtfFont.postscriptName).toBe(origTtfFont.postscriptName);
        expect(slimTtfFont.fullName).toBe(origTtfFont.fullName);
        const origTtfSubset = await encodeSubset(origTtfFont, ttfSamples.join(' '));
        const slimTtfSubset = await encodeSubset(slimTtfFont, ttfSamples.join(' '));
        expect(Buffer.compare(slimTtfSubset, origTtfSubset)).toBe(0);
    }, 20_000);

    it('经 Rolldown 生产压缩后显著缩减原始与 DEFLATE-9 体积', async () => {
        const rolldownPath = createRequire(require.resolve('vite')).resolve('rolldown');
        const {rolldown} = await import(/* @vite-ignore */ pathToFileURL(rolldownPath).href);

        const bundleMinified = async (source: string) => {
            const bundle = await rolldown({
                input: '\0fontkit-entry',
                external: ['pako'],
                plugins: [{
                    name: 'mem-fontkit',
                    resolveId(id: string) {
                        if (id === '\0fontkit-entry') return id;
                    },
                    load(id: string) {
                        if (id === '\0fontkit-entry') return source;
                    },
                }],
            });
            try {
                const {output} = await bundle.generate({format: 'es', minify: true});
                const code = output[0].code;
                return {
                    minBytes: Buffer.byteLength(code, 'utf8'),
                    zipBytes: deflateRawSync(code, {level: 9}).length,
                };
            } finally {
                await bundle.close();
            }
        };

        const before = await bundleMinified(cspPatchedSource);
        const after = await bundleMinified(slimFontkitSource(cspPatchedSource));
        expect(before.minBytes - after.minBytes).toBeGreaterThan(240_000);
        expect(before.zipBytes - after.zipBytes).toBeGreaterThan(140_000);
    });
});
