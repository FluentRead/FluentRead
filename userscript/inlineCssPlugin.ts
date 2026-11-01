/**
 * @file userscript/inlineCssPlugin.ts
 * 文件职责：在 userscript 出口无损压缩作为 JavaScript 字符串导入的内联样式。
 * 主要内容：只接受 Vite 已转换为单个 default 字符串导出的项目 CSS 模块，用既有 ASCII85 或 standalone 的 Base91 保存完整 gzip 字节，复用 pako 同步还原完整 UTF-8 文本；小样式与可读源码版本沿用原模块。
 * 模块边界：不压缩可执行源码、不改动共享 CSS 或扩展构建，不添加解压依赖与异步加载边界。
 */
import {resolve} from 'node:path';
import {gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact, encodeUserscriptData} from './buildDataEncoding';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

export function createUserscriptInlineCssCompressionPlugin(root: string, enabled = true, compact = false): Plugin {
    const sourceRoot = `${normalizePath(resolve(root, 'src'))}/`;
    return {
        name: 'compress-userscript-inline-css',
        enforce: 'post',
        transform: {
            order: 'post',
            handler(code, id) {
                const [path, query] = id.split('?', 2);
                if (!enabled || !normalizePath(path).startsWith(sourceRoot) || !path.endsWith('.css')
                    || !new URLSearchParams(query).has('inline')) return null;
                const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
                if (source.statements.length !== 1) return null;
                const statement = source.statements[0];
                if (!ts.isExportAssignment(statement) || statement.isExportEquals
                    || !(ts.isStringLiteral(statement.expression) || ts.isNoSubstitutionTemplateLiteral(statement.expression))) return null;
                const css = statement.expression.text;
                const compressed = (compact ? encodeUserscriptDataCompact : encodeUserscriptData)(gzipUserscriptBuildData(Buffer.from(css, 'utf8'), undefined, compact));
                const restored = "import {inflateWithPako} from '@/userscript/pakoRuntime';\n"
                    + "import {decodeUserscriptData} from '@/userscript/dataEncoding';\n"
                    + `export default inflateWithPako(decodeUserscriptData(${JSON.stringify(compressed)}));`;
                return Buffer.byteLength(restored) < Buffer.byteLength(code) ? {code: restored, map: null} : null;
            },
        },
    };
}
