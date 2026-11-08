import {createHash} from 'node:crypto';
import type {Plugin} from 'vite';

// defuddle 的公开入口是 webpack 打包的 UMD，不是 dist/utils/dom.js；完整来源摘要固定后才允许适配。
const DEFUDDLE_SHA256 = 'f40075dc7b7b0460c16f77b9486a0ee66907a19677d2984e198e94356116a1e8';
const ORIGINAL_DECODER = 'e.decodeHTMLEntities=function(t,e){const r=t.createElement("textarea");return r.innerHTML=e,r.value}';
const REPLACEMENT_DECODER = 'e.decodeHTMLEntities=function(t,e){return __fluentreadDecodeTextareaHtml(e,t)}';

/** 只替换唯一定位点，缺失或重复均禁止构建。 */
export function replaceDefuddleEntityDecoder(source: string): string {
    if (source.split(ORIGINAL_DECODER).length !== 2) {
        throw new Error('Missing or ambiguous Defuddle entity decoder');
    }
    return source.replace(ORIGINAL_DECODER, REPLACEMENT_DECODER);
}

/** 在构建副本中替换唯一的实体解码入口，保留独立 UMD 模块的默认导出语义。 */
export function patchDefuddleEntitySource(original: string): string {
    if (createHash('sha256').update(original).digest('hex') !== DEFUDDLE_SHA256) {
        throw new Error('Unsupported Defuddle source: review entity decoding before upgrading');
    }
    const patched = replaceDefuddleEntityDecoder(original);
    // 局部 CommonJS module 保留 UMD 的默认导出；该包装只用于浏览器扩展等构建副本。
    return "import {decodeTextareaHtml as __fluentreadDecodeTextareaHtml} from '@/src/shared/text/htmlEntities';\n"
        + 'const module = {exports: {}}; const exports = module.exports;\n'
        + patched + '\nexport default module.exports;\n';
}

export function defuddleEntityBuildPlugin(): Plugin {
    return {
        name: 'fluentread-defuddle-entity-decoder',
        enforce: 'pre',
        apply: 'build',
        transform(source, id) {
            if (id.includes('\0') || id.includes('?')) return;
            const file = id.replace(/\\/g, '/');
            if (!/(?:^|\/)defuddle\/dist\/index\.js$/u.test(file)) return;
            return {code: patchDefuddleEntitySource(source), map: null};
        },
    };
}
