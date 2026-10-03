import {describe, expect, it, vi} from 'vitest';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {instrumentWasmDiagnostics, splitTesseractWasm, packageTesseractWasm} from '../scripts/wasm/package-diagnostics';

const adapter = readFileSync(new URL('../scripts/wasm/diagnostics.js', import.meta.url), 'utf8');
const createLog = () => {
    const output = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
    const write = runInNewContext(`${adapter}\nfluentReadWasmStderr`, {console: output});
    return {output, write};
};

describe('packaged WASM diagnostic severity', () => {
    it('拆分真实 OCR 内核后 WASM 字节完全一致，JS 不再携带 Base64 内核', () => {
        const source = readFileSync(new URL('../public/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js', import.meta.url), 'utf8');
        const {code, wasm} = splitTesseractWasm(source);
        const original = source.match(/"data:application\/octet-stream;base64,([A-Za-z0-9+/]+={0,2})"/)![1];
        expect(wasm.equals(Buffer.from(original, 'base64'))).toBe(true);
        expect(WebAssembly.validate(wasm)).toBe(true);
        expect(code).not.toContain(original);
        expect(code.length).toBeLessThan(150_000);
        expect(Buffer.byteLength(code) + wasm.length).toBeLessThan(Buffer.byteLength(source) - 900_000);
    });

    it('本地 WASM 路径相对于扩展 Worker 解析，并保留显式 locateFile', () => {
        const source = '(function(TesseractCore = {})  { const binary = "data:application/octet-stream;base64,AGFzbQEAAAA="; return TesseractCore; })';
        const {code} = splitTesseractWasm(source);
        for (const origin of ['chrome-extension://fixture', 'moz-extension://fixture']) {
            const core = runInNewContext(code, {URL, self: {location: {href: `${origin}/fluent-read-ocr/worker/worker.min.js`}}});
            const module = core();
            expect(module.locateFile('tesseract-core-simd-lstm.wasm', 'ignored/'))
                .toBe(`${origin}/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm`);
            expect(module.locateFile('another.dat', 'prefix/')).toBe('prefix/another.dat');
            const locateFile = vi.fn();
            expect(core({locateFile}).locateFile).toBe(locateFile);
        }
    });

    it.each(['', 'function(TesseractCore = {})  {}',
        'function(TesseractCore = {})  {"data:application/octet-stream;base64,A=="}',
        'function(TesseractCore = {})  {"data:application/octet-stream;base64,YWJj"}',
        'function(TesseractCore = {})  {"data:application/octet-stream;base64,AGFzbQEAAAA=";"data:application/octet-stream;base64,AGFzbQEAAAA="}'])
    ('不猜测陌生或损坏的 vendor 内核格式 %#', source => {
        expect(() => splitTesseractWasm(source)).toThrow(/Unsupported|Invalid/);
    });

    it('打包同时输出原始 WASM 与诊断 glue，原 vendor 文件保持不变', () => {
        const root = mkdtempSync(join(tmpdir(), 'fluentread-ocr-package-test-'));
        try {
            mkdirSync(join(root, 'scripts/wasm'), {recursive: true});
            writeFileSync(join(root, 'scripts/wasm/diagnostics.js'), adapter);
            const source = new URL('../public/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js', import.meta.url);
            const original = readFileSync(source, 'utf8');
            const result = packageTesseractWasm(root, source.pathname);
            expect(readFileSync(result.wasm).equals(splitTesseractWasm(original).wasm)).toBe(true);
            expect(readFileSync(result.glue, 'utf8')).toContain('n=b.printErr||fluentReadWasmStderr');
            expect(readFileSync(source, 'utf8')).toBe(original);
        } finally {
            rmSync(root, {recursive: true, force: true});
        }
    });

    it('保留 ONNX 原始严重级别，去除终端颜色并保留性能警告', () => {
        const {output, write} = createLog();
        const warning = '2026-09-13 15:13:13.499400 [W:onnxruntime:, session_state.cc:1280 VerifyEachNodeIsAssignedToAnEp] Some nodes were not assigned to the preferred execution providers';
        write(`\u001b[0;93m${warning}\u001b[m`);
        expect(output.warn).toHaveBeenCalledWith(warning);
        for (const [severity, level] of [['V', 'debug'], ['I', 'info'], ['E', 'error'], ['F', 'error']] as const) {
            const text = `[${severity}:onnxruntime:Default] diagnostic`;
            write(text);
            expect(output[level]).toHaveBeenCalledWith(text);
        }
        expect(output.error).toHaveBeenCalledTimes(2);
    });

    it('浏览器 CPU 厂商未知的已知提示仅进入 debug，错误、其他 vendor 和多行失败保持可见', () => {
        const {output,write}=createLog();
        const prefix='2026-10-03 23:48:59.693198 [W:onnxruntime:Default, cpuid_info.cc:91 LogEarlyWarning] ';
        const known=prefix+'Unknown CPU vendor. cpuinfo_vendor value: 0';
        write(known);expect(output.debug).toHaveBeenCalledWith(known);expect(output.warn).not.toHaveBeenCalled();expect(output.error).not.toHaveBeenCalled();
        for (const warning of [known.replace('value: 0','value: 15'),known.replace('LogEarlyWarning','AnotherWarning'),known+' additional details']) {
            write(warning);expect(output.warn).toHaveBeenCalledWith(warning);
        }
        for (const error of [known.replace('[W:','[E:'),known+'\nFailed loading model',known+'\nAborted(out of memory)']) {
            write(error);expect(output.error).toHaveBeenCalledWith(error);
        }
    });

    it('仅把已知 LSTM 旧参数和分辨率提示降为 debug，未知警告与失败保持可见', () => {
        const {output, write} = createLog();
        for (const parameter of ['language_model_ngram_on', 'segsearch_max_char_wh_ratio', 'language_model_ngram_space_delimited_language', 'language_model_ngram_scale_factor', 'language_model_use_sigmoidal_certainty', 'language_model_ngram_nonmatch_score', 'classify_integer_matcher_multiplier', 'assume_fixed_pitch_char_segment', 'chop_enable', 'allow_blob_division']) {
            write(`Warning: Parameter not found: ${parameter}`);
        }
        write('Estimating resolution as 225');
        expect(output.debug).toHaveBeenCalledTimes(11);
        write('Warning: Parameter not found: future_required_parameter');
        expect(output.warn).toHaveBeenCalledWith('Warning: Parameter not found: future_required_parameter');
        for (const text of [
            'Error opening data file eng.traineddata',
            'Aborted(out of memory)',
            'Warning: Parameter not found: allow_blob_division\nFailed loading language',
            'Estimating resolution as 225\nError loading model',
            'unexpected [W:onnxruntime:Default] failure',
            '[W:onnxruntime:Default] warning\nError loading model',
        ]) {
            write(text);
            expect(output.error).toHaveBeenCalledWith(text);
        }
        expect(output.error).toHaveBeenCalledTimes(6);
    });

    it('在引擎闭包内适配 stderr，不替换外部 console，拒绝陌生 glue 格式', async () => {
        const glue = 'var core = async function(moduleArg = {}) { const stderr = console.error.bind(console); stderr(moduleArg.message); return moduleArg; }; core;';
        const output = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
        const error = output.error;
        const core = runInNewContext(instrumentWasmDiagnostics(glue, 'onnx', adapter), {console: output});
        const args = {message: '[W:onnxruntime:Default] warning', wasmBinary: new Uint8Array([0, 97, 115, 109])};
        expect(await core(args)).toBe(args);
        expect(output.warn).toHaveBeenCalledWith(args.message);
        expect(output.error).toBe(error);
        output.error('outside engine');
        expect(output.error).toHaveBeenCalledWith('outside engine');
        expect(() => instrumentWasmDiagnostics('new vendor format', 'onnx', adapter)).toThrow('Unsupported');
        expect(() => instrumentWasmDiagnostics(`${glue}\n${glue}`, 'onnx', adapter)).toThrow('Unsupported');
        const ocr = readFileSync(new URL('../public/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js', import.meta.url), 'utf8');
        expect(instrumentWasmDiagnostics(ocr, 'tesseract', adapter)).toContain('n=b.printErr||fluentReadWasmStderr');
    });
});
