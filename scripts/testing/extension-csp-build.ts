import {createHash} from 'node:crypto';
import fs from 'node:fs';
import type {Plugin} from 'vite';

/**
 * 固定版本依赖的扩展 CSP 适配。原始依赖、许可证及 WASM 字节保持不变；只在构建副本中
 * 使用现代浏览器原生全局与现有解释执行分支，避免发布包携带字符串代码执行入口。
 * 每个完整输入均锁定 SHA-256；上游升级须重新审查，不能猜测替换压缩后的任意代码。
 */
const SOURCE_SHA256 = {
    'tesseract-worker': '38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842',
    'regenerator-runtime': 'e4fa2bcc7507e23fb226bad104bd3c526149ebc9891afbc4bb3a4a0c88afded3',
    'jszip': 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e',
    'pdfjs-main': '081d3b6f426d38a8029766f8839f505e9cbf2c81a71d62c26eada142e6c21ae4',
    'pdfjs-worker': 'bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d',
    'fontkit': '62ad9c769e6a7a9028b0c711504908f0a231955b39619aaabd56dd4eabe800be',
    'lodash-root': 'df58ff96c454ca91ace20d20e6af49b354c70dfba7e737adc00cd23e8ff77168',
    'onnx-asyncify': '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9',
} as const;
export type ExtensionVendorSource = keyof typeof SOURCE_SHA256;

function replaceOnce(source: string, before: string, after: string): string {
    if (source.split(before).length !== 2) throw new Error('Missing or ambiguous extension CSP patch match');
    return source.replace(before, after);
}

/**
 * 根据固定 glue 的输入/输出契约独立实现静态闭包，不再生成函数源码。对照上游非 JIT
 * 入口核对调用种类：https://github.com/emscripten-core/emscripten/blob/main/src/lib/libemval.js
 * 保留方法 this、构造、cast、类型转换及析构引用；函数调用使用 undefined 保留原 JIT 的 this。
 */
const ONNX_INVOKER = `function Pb(a,b,c){var [d,...e]=Jg(a,b>>>0);var f=d.Sc.bind(d),h=e.map(m=>m.Rc.bind(m)),isVoid=d.ee;
var k=function(handle,methodName,destructorsRef,args){
var receiver,target;if(c===0||c===2)target=R(handle);else if(c===1){receiver=R(handle);target=receiver[Mg(methodName)]}
var values=h.map((read,index)=>read(args+8*index)),result;
switch(c){case 0:result=Reflect.apply(target,undefined,values);break;
case 1:result=Reflect.apply(target,receiver,values);break;
case 2:result=Reflect.construct(target,values);break;
case 3:result=values[values.length-1];break;
default:throw new Error('Unsupported Emscripten invocation kind');}
if(!isVoid)return Kg(f,destructorsRef,result);
};
return Ig(Object.defineProperty(k,"name",{value:\`methodCaller<(\${e.map(m=>m.name)}) => \${d.name}>\`}))}`;

export function patchExtensionVendorSource(kind: ExtensionVendorSource, original: string): string {
    if (createHash('sha256').update(original).digest('hex') !== SOURCE_SHA256[kind]) {
        throw new Error(`Unsupported ${kind} source: review extension CSP packaging before upgrading`);
    }
    let source = original;
    switch (kind) {
        case 'tesseract-worker':
            source = replaceOnce(source, 'Function("r","regeneratorRuntime = r")(i)', 'globalThis.regeneratorRuntime=i');
            return replaceOnce(source, 'new Function("return this")()', 'globalThis');
        case 'regenerator-runtime':
            return replaceOnce(source, 'Function("r", "regeneratorRuntime = r")(runtime)', 'globalThis.regeneratorRuntime = runtime');
        case 'lodash-root':
            return replaceOnce(source, "Function('return this')()", 'globalThis');
        case 'jszip':
            // JSZip 自身只传函数；不支持历史 setImmediate 字符串回调，避免将字符串编译成代码。
            return replaceOnce(source, '"function"!=typeof e&&(e=new Function(""+e));',
                'if("function"!=typeof e)throw new TypeError("setImmediate callback must be a function");');
        case 'pdfjs-main':
            // 此构建仅运行于浏览器；Node require 回退不可达，浏览器全局由原生 globalThis 提供。
            source = replaceOnce(source, `Function('return require("' + name + '")')()`, 'undefined');
            source = replaceOnce(source, "Function('return this')()", 'globalThis');
            return replaceOnce(source, 'function isEvalSupported() {\n  try {\n    new Function("");\n    return true;\n  } catch {\n    return false;\n  }\n}',
                'function isEvalSupported() { return false; }');
        case 'pdfjs-worker':
            source = replaceOnce(source, `Function('return require("'+e+'")')()`, 'undefined');
            source = replaceOnce(source, 'Function("return this")()', 'globalThis');
            source = replaceOnce(source, 'function isEvalSupported(){try{new Function("");return!0}catch{return!1}}', 'function isEvalSupported(){return!1}');
            // PDF.js 自带 PostScriptEvaluator 完整解释执行路径；始终使用扩展 CSP 允许的路径。
            return replaceOnce(source, 'if(t&&FeatureTest.isEvalSupported){const e=(new PostScriptCompiler).compile(o,r,s);if(e)return new Function("src","srcOffset","dest","destOffset",e)}', '');
        case 'fontkit':
            source = replaceOnce(source, "bound = Function('binder', 'return function (' + boundArgs.join(',') + '){ return binder.apply(this,arguments); }')(binder);",
                "bound = function () { return binder.apply(this, arguments); };\n  Object.defineProperty(bound, 'length', {value: boundLength});");
            // get-intrinsic 的内部兼容表不对外导出，fontkit 不使用 eval intrinsic。
            return replaceOnce(source, "'%eval%': eval,", "'%eval%': undefined$1,");
        case 'onnx-asyncify': {
            const start = source.indexOf('function Pb(a,b,c){');
            const end = source.indexOf('function Rb(a,b){', start);
            if (start < 0 || end < 0) throw new Error('Missing pinned ONNX method invoker');
            return source.slice(0, start) + ONNX_INVOKER + source.slice(end);
        }
    }
}

/** WXT 构建内的模块与 ?url worker 资源均适配；不改 node_modules 或源码仓库中的 vendor。 */
export function extensionCspBuildPlugin(): Plugin {
    return {
        name: 'fluentread-extension-csp-vendor',
        enforce: 'pre',
        apply: 'build',
        load(id) {
            const file = id.split('?')[0].replace(/\\/g, '/');
            if (!/(?:^|\/)pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs$/.test(file)
                || !new URLSearchParams(id.split('?')[1] ?? '').has('url')) return;
            const source = patchExtensionVendorSource('pdfjs-worker', fs.readFileSync(file, 'utf8'));
            // 仅在构建产物真正引用 URL 时保留资源；其他入口可能加载模块但被摇树移除。
            const reference = this.emitFile({type: 'asset', name: 'pdf.worker.min.mjs', source, needsCodeReference: true});
            return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
        },
        transform(source, id) {
            if (id.includes('\0') || id.includes('?')) return;
            const file = id.replace(/\\/g, '/');
            const modules: [RegExp, ExtensionVendorSource][] = [
                [/(?:^|\/)regenerator-runtime\/runtime\.js$/, 'regenerator-runtime'],
                [/(?:^|\/)jszip\/dist\/jszip\.min\.js$/, 'jszip'],
                [/(?:^|\/)pdfjs-dist\/legacy\/build\/pdf\.mjs$/, 'pdfjs-main'],
                [/(?:^|\/)@pdf-lib\/fontkit\/dist\/fontkit\.es\.js$/, 'fontkit'],
                [/(?:^|\/)lodash-es\/_root\.js$/, 'lodash-root'],
            ];
            const match = modules.find(([pattern]) => pattern.test(file));
            if (match) return {code: patchExtensionVendorSource(match[1], source), map: null};
        },
    };
}
