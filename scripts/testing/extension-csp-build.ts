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
    'pdfjs-main': '2792b7c390ad6d5f4245d326b70deebbc990fa4bcac691412f6df886abb9e867',
    'pdfjs-worker': 'b4c8353ded0d88d2e2009574a29eb4e0c3ff7e942ecdf51ef5f71566a9667f31',
    'fontkit': '62ad9c769e6a7a9028b0c711504908f0a231955b39619aaabd56dd4eabe800be',
    'lodash-root': 'df58ff96c454ca91ace20d20e6af49b354c70dfba7e737adc00cd23e8ff77168',
    'onnx-asyncify': '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9',
    'zod-v4-schemas': 'd466582c022b08a3f9eb1a65d5970d8ca25064d73a5a838d76414ae36440a76b',
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
        case 'zod-v4-schemas':
            // 直接选择 Zod 自带的非 JIT 解析路径，避免对象 schema 在初始化时探测 eval。
            return replaceOnce(source, 'const jit = !core.globalConfig.jitless;', 'const jit = false;');
        case 'jszip':
            // JSZip 自身只传函数；不支持历史 setImmediate 字符串回调，避免将字符串编译成代码。
            return replaceOnce(source, '"function"!=typeof e&&(e=new Function(""+e));',
                'if("function"!=typeof e)throw new TypeError("setImmediate callback must be a function");');
        case 'pdfjs-main':
            // PDF.js 6 已移除字符串代码生成；旧浏览器 polyfill 的全局回退替换为原生全局。
            return replaceOnce(source, "Function('return this')()", 'globalThis');
        case 'pdfjs-worker':
            source = replaceOnce(source, 'Function("return this")()', 'globalThis');
            // 保留 PostScript 解释执行策略。图片解码仍可使用预编译的本地 WASM。
            source = replaceOnce(source, 'try{if(e.useWasm){const e=buildPostScriptWasmFunction(s,a,r);if(e)return setArity(e,i,o)}}catch{}warn("Failed to compile PostScript function to wasm, falling back to JS");', '');
            return replaceOnce(source, ':PSStackBasedInterpreter.build(r,t,n)}(s,a,r),i,o)', ':PSStackBasedInterpreter.build(r,t,n)}(s,a,r,!0),i,o)');
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
                [/(?:^|\/)zod\/v4\/core\/schemas\.js$/, 'zod-v4-schemas'],
            ];
            const match = modules.find(([pattern]) => pattern.test(file));
            if (match) return {code: patchExtensionVendorSource(match[1], source), map: null};
        },
    };
}
