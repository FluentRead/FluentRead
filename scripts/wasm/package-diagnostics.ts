import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {patchExtensionVendorSource} from '../testing/extension-csp-build';

// Core 与 Worker 均来自锁定的 npm 包。校验原始字节后只适配本地加载、异常清理和诊断出口。
const OCR_CORE_SHA256 = 'e48e2f02ddae3716c8dd24bf41cd290d4efa96892d689cdc4013c2545d63f469';
const OCR_WASM_SHA256 = '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea';
const OCR_WORKER_SHA256 = '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d';
const OCR_WASM_FILE = 'tesseract-core-simd-lstm.wasm';
const OCR_CORE_FACTORY = 'async function(moduleArg={}){';

export function resolveTesseractSources(root: string) {
    const sdk = createRequire(path.resolve(root, 'package.json')).resolve('tesseract.js/package.json');
    const core = createRequire(sdk);
    return {
        glue: core.resolve('tesseract.js-core/tesseract-core-simd-lstm.js'),
        wasm: core.resolve(`tesseract.js-core/${OCR_WASM_FILE}`),
        worker: path.resolve(path.dirname(sdk), 'dist/worker.min.js'),
    };
}

function requirePinnedSource(source: string | Buffer, digest: string, name: string): void {
    if (createHash('sha256').update(source).digest('hex') !== digest) {
        throw new Error(`Unsupported ${name} source: review OCR packaging before upgrading`);
    }
}

function replaceOnce(source: string, before: string, after: string): string {
    if (source.split(before).length !== 2) throw new Error('Missing or ambiguous pinned OCR patch match');
    return source.replace(before, after);
}

// importScripts 从 worker/ 执行，Emscripten 默认按 Worker 的 URL 查找 WASM。
// 保留调用方提供的 locateFile，扩展默认从兄弟 core/ 路径加载。
export function useLocalTesseractWasm(source: string): string {
    const locate = `moduleArg.locateFile ||= (file, prefix) => file === ${JSON.stringify(OCR_WASM_FILE)}
        ? new URL('../core/' + file, self.location.href).href : prefix + file;`;
    return replaceOnce(source, OCR_CORE_FACTORY, `${OCR_CORE_FACTORY}\n${locate}\n`);
}

/** 打包官方分离版的 WASM 与经过诊断适配的 glue，保持扩展现有 corePath。 */
export function packageTesseractWasm(root: string, sourcePath: string): {glue: string; wasm: string} {
    const source = fs.readFileSync(sourcePath, 'utf8');
    requirePinnedSource(source, OCR_CORE_SHA256, 'tesseract.js-core 7.0.0 glue');
    const wasm = path.join(path.dirname(sourcePath), OCR_WASM_FILE);
    requirePinnedSource(fs.readFileSync(wasm), OCR_WASM_SHA256, 'tesseract.js-core 7.0.0 WASM');
    // FS.writeFile 已取得 stream 后，数据校验或写入失败仍必须 close。
    const corrected = replaceOnce(source,
        'a=x.open(a,c.flags,c.mode);"string"==typeof b',
        'a=x.open(a,c.flags,c.mode);try{"string"==typeof b');
    const local = useLocalTesseractWasm(replaceOnce(corrected,
        'ArrayBuffer.isView(b)?x.write(a,b,0,b.byteLength,void 0,c.Fh):r("Unsupported data type");x.close(a)},cwd:',
        'if(!ArrayBuffer.isView(b))throw Error("Unsupported data type");x.write(a,b,0,b.byteLength,void 0,c.Fh)}finally{x.close(a)}},cwd:'));
    const outputDirectory = path.resolve(root, '.wxt/packaged-wasm');
    const glue = path.join(outputDirectory, `${OCR_WASM_FILE}.js`);
    const adapter = fs.readFileSync(path.resolve(root, 'scripts/wasm/diagnostics.js'), 'utf8');
    fs.mkdirSync(outputDirectory, {recursive: true});
    fs.writeFileSync(glue, instrumentWasmDiagnostics(local, 'tesseract', adapter));
    return {glue, wasm};
}

/** 生成扩展实际加载的 worker，保留完整 vendor 和 LICENSE 说明，不修改原始锁定资源。 */
export function packageTesseractWorker(root: string, sourcePath: string): string {
    let source = fs.readFileSync(sourcePath, 'utf8');
    requirePinnedSource(source, OCR_WORKER_SHA256, 'tesseract.js 7.0.0 worker');
    source = patchExtensionVendorSource('tesseract-worker', source);
    // 让 dispatch 的 Promise 错误出口观察到异步 Core 工厂失败，保留 worker/job 身份。
    source = replaceOnce(source,
        'c=t.sent,r.progress({workerId:n,status:f,progress:0}),c({TesseractProgress:function(t){p.progress({workerId:n,jobId:i,status:"recognizing text",progress:Math.max(0,(t-30)/70)})}}).then((function(t){l=t,r.progress({workerId:n,status:f,progress:1}),r.resolve({loaded:!0})})),t.next=12;break;case 11:',
        'return c=t.sent,r.progress({workerId:n,status:f,progress:0}),t.abrupt("return",c({TesseractProgress:function(t){p.progress({workerId:n,jobId:i,status:"recognizing text",progress:Math.max(0,(t-30)/70)})}}).then((function(t){l=t,r.progress({workerId:n,status:f,progress:1}),r.resolve({loaded:!0})})));case 11:');
    source = replaceOnce(source,
        'case 30:-1===b&&r.reject("initialization failed"),r.progress',
        'case 30:if(-1===b){r.reject("initialization failed");t.next=38;break}r.progress');
    // 保存成功后才取得还原责任；在输出转换、SetVariable、图片/原生识别失败时也还原，先还原再发终态。
    source = replaceOnce(source,
        'n=e.payload,o=n.image,a=n.options,s=n.output;try{if(u={}',
        'n=e.payload,o=n.image,a=n.options,s=n.output;var fluentReadParametersSaved=!1,fluentReadRecognitionFailed=!1;try{try{if(u={}');
    source = replaceOnce(source, 'for(O.SaveParameters(),y=0,d=Object.keys(u);',
        'for(O.SaveParameters(),fluentReadParametersSaved=!0,y=0,d=Object.keys(u);');
    source = replaceOnce(source, ',Object.keys(u).length>0&&O.RestoreParameters(),r.resolve(j)}catch(t)',
        '}catch(fluentReadRecognitionError){fluentReadRecognitionFailed=!0;throw fluentReadRecognitionError}finally{if(fluentReadParametersSaved){if(fluentReadRecognitionFailed){try{O.RestoreParameters()}catch(fluentReadRestoreError){}}else O.RestoreParameters()}}r.resolve(j)}catch(t)');
    // palette/mask 的读取位置与像素位置不同。保留 bitfield mask 读取，随后按 BMP 声明的偏移解码。
    source = replaceOnce(source, 'i.prototype.parseRGBA=function(){var t=',
        'i.prototype.parseRGBA=function(){3!==this.compress&&(this.pos=this.offset);var t=');
    source = replaceOnce(source, 'this.pos+=4);for(var e=[0,0,0],r=0;r<16;r++)',
        'this.pos+=4);this.pos=this.offset;for(var e=[0,0,0],r=0;r<16;r++)');
    source = replaceOnce(source, 'this.pos+=4;for(var t=this.height-1;t>=0;t--)for(var e=this.bottom_up?',
        'this.pos+=4;this.pos=this.offset;for(var t=this.height-1;t>=0;t--)for(var e=this.bottom_up?');
    const output = path.resolve(root, '.wxt/packaged-wasm/worker.min.js');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, source);
    return output;
}

/** 仅适配锁定依赖的浏览器 stderr 出口，保留 vendor 文件和 WASM 二进制原样。 */
export function instrumentWasmDiagnostics(source: string, runtime: 'onnx' | 'tesseract', adapter: string): string {
    const factory = runtime === 'onnx'
        ? /(?:async function\(moduleArg = \{\}\) \{|async function ortWasmThreaded\(moduleArg=\{\}\)\{)/g
        : /async function\(moduleArg=\{\}\)\{/g;
    const stderr = 'console.error.bind(console)';
    // 格式变化必须在构建时失败，避免升级后静默失去分级或替换错误位置。
    if ([...source.matchAll(factory)].length !== 1 || source.split(stderr).length !== 2) {
        throw new Error(`Unsupported ${runtime} WASM diagnostic glue`);
    }
    const result = source.replace(factory, match => `${match}\n${adapter}\n`).replace(stderr, 'fluentReadWasmStderr');
    // ORT 的 pthread 分支还有单独的 stderr 转发；只改 vendor 源中的出口，不能改适配器本身。
    return runtime === 'onnx'
        ? result.replace(/console\.error\(([a-z])\)/g, 'fluentReadWasmStderr($1)')
        : result;
}

export function packageWasmDiagnostics(root: string, sourcePath: string, fileName: string, runtime: 'onnx' | 'tesseract'): string {
    const adapter = fs.readFileSync(path.resolve(root, 'scripts/wasm/diagnostics.js'), 'utf8');
    const original = fs.readFileSync(sourcePath, 'utf8');
    const source = runtime === 'onnx' && fileName === 'ort-wasm-simd-threaded.asyncify.mjs'
        ? patchExtensionVendorSource('onnx-asyncify', original) : original;
    const output = path.resolve(root, '.wxt/packaged-wasm', fileName);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, instrumentWasmDiagnostics(source, runtime, adapter));
    return output;
}
