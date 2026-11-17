/**
 * @file scripts/testing/dictionary-script-build.ts
 * 文件职责：把词典脚本引擎的固定 WASM 保留为随包资源，避免 classic background 内联大段 Base64。
 * 主要内容：仅适配固定 QuickJS 浏览器加载器的默认文件定位表达式，原样交付算法和许可；表达式变化立即失败。
 * 模块边界：构建期静态资源装配，不下载或修改引擎、不改变 CSP、不执行用户脚本。
 */
import {resolve} from 'node:path';
export function dictionaryScriptBuildPlugin() {
    return {name: 'fluentread-dictionary-script-wasm', enforce: 'pre' as const, transform(code: string, id: string) {
        if (!/quickjs-wasmfile-release-sync\/dist\/emscripten-module\.browser\.mjs$/.test(id.replaceAll('\\', '/'))) return null;
        const expression = '(new URL("emscripten-module.wasm",import.meta.url)).href';
        if (!code.includes(expression)) throw new Error('QuickJS browser WASM loader changed');
        return {code: code.replace(expression, '(globalThis.location.origin+"/dictionary/quickjs.wasm")'), map: null};
    }};
}
export function dictionaryScriptAssets(root: string): {absoluteSrc: string; relativeDest: string}[] {
    return [
        {absoluteSrc: resolve(root, 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm'), relativeDest: 'dictionary/quickjs.wasm'},
        ...['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync', 'lzo1x'].map(name => ({absoluteSrc: resolve(root, 'node_modules', name, 'LICENSE'), relativeDest: `third-party-notices/${name.replaceAll('/', '-')}-MIT.txt`})),
    ];
}
