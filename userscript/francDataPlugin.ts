/**
 * @file userscript/francDataPlugin.ts
 * 文件职责：为标准版和独立完整 userscript 无损压缩锁定 franc-min 的生成式纯数据模块。
 * 主要内容：核对依赖版本与精确模块路径，拒绝非字符串表 AST，以 gzip 编码全部模型并在原模块求值时同步恢复；紧凑模式采用 Base91，独立版复用经过校验的隔离压缩 worker。
 * 模块边界：不处理检测算法或其他依赖模块，不修改依赖文件、许可、模型或 API；Greasy Fork 可读源码与扩展目标不启用。
 */
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {gzipLargeStandaloneUserscriptData, gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact} from './buildDataEncoding';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

/** 只编码一个锁定生成模块；结构或版本漂移时拒绝构建，禁止把可执行逻辑当成压缩数据。 */
export function createUserscriptFrancDataCompressionPlugin(root: string, enabled = false, compact = false, standalone = false): Plugin {
    let sourcePath = '';
    if (enabled) {
        const require = createRequire(resolve(root, 'package.json'));
        const indexPath = require.resolve('franc-min');
        const manifest = JSON.parse(readFileSync(resolve(dirname(indexPath), 'package.json'), 'utf8')) as {
            name?: unknown;
            version?: unknown;
        };
        if (manifest.name !== 'franc-min' || manifest.version !== '6.2.0') {
            throw new Error('Standalone franc data requires locked franc-min 6.2.0');
        }
        sourcePath = normalizePath(realpathSync(resolve(dirname(indexPath), 'data.js')));
    }
    return {
        name: 'compress-standalone-franc-data',
        enforce: 'pre',
        transform(code, id) {
            // 不去掉 query 或虚拟模块前缀，防止 raw/proxy 与其它入口误入此纯数据转换。
            if (!enabled || normalizePath(id) !== sourcePath) return null;
            const unsupported = () => new Error('Standalone franc data must be one exported const data object of model strings');
            const diagnostics = ts.transpileModule(code, {
                fileName: id,
                reportDiagnostics: true,
                compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext},
            }).diagnostics!;
            // 锁定 TypeScript 5.7.3 的 transpileWorker 总是返回 diagnostics 数组，类型定义仍标为可选。
            if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw unsupported();
            const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            if (source.statements.length !== 1) throw unsupported();
            const statement = source.statements[0];
            if (!ts.isVariableStatement(statement)
                || !statement.modifiers
                || statement.modifiers.length !== 1
                || statement.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword
                || !(statement.declarationList.flags & ts.NodeFlags.Const)
                || statement.declarationList.declarations.length !== 1) throw unsupported();
            const declaration = statement.declarationList.declarations[0];
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'data' || !declaration.initializer) throw unsupported();

            function readObject<T>(node: ts.Expression, readValue: (value: ts.Expression) => T): Record<string, T> {
                if (!ts.isObjectLiteralExpression(node) || !node.properties.length) throw unsupported();
                const result: Record<string, T> = {};
                for (const property of node.properties) {
                    if (!ts.isPropertyAssignment(property)
                        || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw unsupported();
                    const name = property.name.text;
                    if (name === '__proto__' || Object.prototype.hasOwnProperty.call(result, name)) throw unsupported();
                    result[name] = readValue(property.initializer);
                }
                return result;
            }
            const data = readObject(declaration.initializer, models => readObject(models, value => {
                if (!(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) throw unsupported();
                return value.text;
            }));
            if (JSON.stringify(Object.keys(data)) !== JSON.stringify(['Latin', 'Cyrillic', 'Arabic', 'Devanagari'])
                || Object.values(data).reduce((count, models) => count + Object.keys(models).length, 0) !== 66) throw unsupported();
            const digest = createHash('sha256').update(code).digest('hex');
            const emit = (bytes: Buffer) => {
                const compressed = compact ? encodeUserscriptDataCompact(bytes) : bytes.toString('base64');
                return {
                    code: [
                        code.slice(0, statement.getStart(source)),
                        '/* Non-code locked franc-min data; source sha256 ' + digest + '. */',
                        "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                        ...(compact ? ["import {decodeUserscriptData} from '@/userscript/dataEncoding';"] : []),
                        'export const data = (() => {',
                        ...(compact ? ['    const bytes = decodeUserscriptData(' + JSON.stringify(compressed) + ');'] : [
                            '    const binary = atob(' + JSON.stringify(compressed) + ');',
                            '    const bytes = new Uint8Array(binary.length);',
                            '    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);',
                        ]),
                        '    return JSON.parse(inflateWithPako(bytes));',
                        '})();',
                    ].join('\n'),
                    map: null,
                };
            };
            const input = Buffer.from(JSON.stringify(data));
            return standalone ? gzipLargeStandaloneUserscriptData(input, root).then(emit)
                : emit(gzipUserscriptBuildData(input));
        },
    };
}
