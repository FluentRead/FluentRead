/**
 * @file userscript/characterDataPlugin.ts
 * 文件职责：在 userscript 构建期无损压缩语言识别的静态字符串数据，保留共享 core 的原始导出契约。
 * 主要内容：仅接受两份明确数据表中的导出 const 字符串；Unicode 字表沿用相邻码点差值，功能词列表直接 gzip，以 ASCII85 或独立版 Base91 编码完整压缩字节，生成同步还原的普通模块。
 * 模块边界：不压缩可执行源码，不修改生成文件；Greasy Fork 保留可读数据，扩展不使用本插件。
 */
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptData, encodeUserscriptDataCompact} from './buildDataEncoding';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

/** 只处理两份权威纯数据表；数据文件出现逻辑时拒绝构建，避免把代码当成压缩资源。 */
export function createUserscriptCharacterDataCompressionPlugin(root: string, enabled = true, standalone = false): Plugin {
    const sourceModes = new Map([
        [normalizePath(resolve(root, 'src/core/language/chineseVariants.ts')), 'delta'],
        [normalizePath(resolve(root, 'src/core/language/functionWordData.ts')), 'strings'],
    ]);
    return {
        name: 'compress-userscript-character-data',
        enforce: 'pre',
        transform(code, id) {
            const sourcePath = normalizePath(id.split('?')[0]);
            const mode = sourceModes.get(sourcePath);
            if (!enabled || !mode) return null;
            const source = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true);
            const names: string[] = [];
            const tables: Array<number[] | string> = [];
            const unsupported = () => new Error('Userscript language data must contain only exported const strings');
            for (const statement of source.statements) {
                if (!ts.isVariableStatement(statement)
                    || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
                    || !(statement.declarationList.flags & ts.NodeFlags.Const)) throw unsupported();
                for (const declaration of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(declaration.name) || !declaration.initializer
                        || !(ts.isStringLiteral(declaration.initializer) || ts.isNoSubstitutionTemplateLiteral(declaration.initializer))
                        || names.includes(declaration.name.text)) throw unsupported();
                    names.push(declaration.name.text);
                    if (mode === 'strings') {
                        tables.push(declaration.initializer.text);
                        continue;
                    }
                    let previous = 0;
                    tables.push(Array.from(declaration.initializer.text, (character) => {
                        const point = character.codePointAt(0)!;
                        const delta = point - previous;
                        previous = point;
                        return delta;
                    }));
                }
            }
            if (!names.length) throw unsupported();
            const compressed = (standalone ? encodeUserscriptDataCompact : encodeUserscriptData)(gzipUserscriptBuildData(Buffer.from(JSON.stringify(tables)), undefined, standalone));
            const digest = createHash('sha256').update(code).digest('hex');
            return {
                code: [
                    code.slice(0, source.statements[0].getStart(source)),
                    '/* Non-code language data; source sha256 ' + digest + '. */',
                    "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                    "import {decodeUserscriptData} from '@/userscript/dataEncoding';",
                    'const bytes = decodeUserscriptData(' + JSON.stringify(compressed) + ');',
                    ...(mode === 'strings' ? ['const characterTables = JSON.parse(inflateWithPako(bytes));'] : [
                        'const characterTables = JSON.parse(inflateWithPako(bytes)).map((deltas) => {',
                        '    let point = 0;',
                        '    return deltas.map((delta) => {',
                        '        point += delta;',
                        // fromCharCode 避免给旧内核新增 String.fromCodePoint 依赖；完整保留补充平面字符。
                        '        return point > 0xFFFF',
                        '            ? String.fromCharCode(0xD800 + ((point - 0x10000) >> 10), 0xDC00 + ((point - 0x10000) & 0x3FF))',
                        '            : String.fromCharCode(point);',
                        "    }).join('');",
                        '});',
                    ]),
                    ...names.map((name, index) => 'export const ' + name + ' = characterTables[' + index + '];'),
                ].join('\n'),
                map: null,
            };
        },
    };
}
