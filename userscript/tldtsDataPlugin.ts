/**
 * @file userscript/tldtsDataPlugin.ts
 * 文件职责：仅为独立完整 userscript 无损压缩锁定 tldts 的生成式后缀规则表。
 * 主要内容：核对版本、精确模块路径与静态导出，以 gzip 编码完整规则并同步恢复原 typed arrays；独立版比较隔离压缩器与现有紧凑编码，原调用默认保留 Base64。
 * 模块边界：不改变后缀匹配算法、规则、许可或 API；普通脚本、Greasy Fork 与扩展目标不启用。
 */
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {gzipLargeStandaloneUserscriptData, gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact} from './buildDataEncoding';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

/** 只编码锁定版本的纯数据模块；结构漂移时拒绝构建，不压缩或执行库算法。 */
export function createUserscriptTldtsDataCompressionPlugin(root: string, enabled = false, compact = false, standalone = false): Plugin {
    let sourcePath = '';
    if (enabled) {
        const require = createRequire(resolve(root, 'package.json'));
        const manifestPath = require.resolve('tldts/package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {name?: unknown; version?: unknown};
        if (manifest.name !== 'tldts' || manifest.version !== '7.4.10') {
            throw new Error('Standalone suffix data requires locked tldts 7.4.10');
        }
        sourcePath = normalizePath(realpathSync(resolve(dirname(manifestPath), 'dist/es6/src/data/trie.js')));
    }
    return {
        name: 'compress-standalone-tldts-data',
        enforce: 'pre',
        transform(code, id) {
            // 不去掉 query 或虚拟模块前缀，避免 raw/proxy 与其它模块误入转换。
            if (!enabled || normalizePath(id) !== sourcePath) return null;
            const unsupported = () => new Error('Standalone suffix data must be the seven locked static trie exports');
            const diagnostics = ts.transpileModule(code, {
                fileName: id,
                reportDiagnostics: true,
                compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext},
            }).diagnostics!;
            if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw unsupported();
            const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const names = ['nodeFlags', 'edgeStart', 'edgeLength', 'edgeChild', 'labelText', 'rulesRoot', 'exceptionsRoot'];
            const arrayTypes = ['Uint8Array', 'Uint16Array', 'Uint8Array', 'Uint16Array'];
            const arrayLengths = [622, 623, 10216, 10216];
            if (source.statements.length !== names.length) throw unsupported();
            const values: Array<number[] | string | number> = [];
            for (const [index, statement] of source.statements.entries()) {
                if (!ts.isVariableStatement(statement)
                    || !statement.modifiers || statement.modifiers.length !== 1
                    || statement.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword
                    || !(statement.declarationList.flags & ts.NodeFlags.Const)
                    || statement.declarationList.declarations.length !== 1) throw unsupported();
                const declaration = statement.declarationList.declarations[0];
                if (!ts.isIdentifier(declaration.name) || declaration.name.text !== names[index]
                    || !declaration.initializer) throw unsupported();
                const initializer = declaration.initializer;
                if (index < arrayTypes.length) {
                    if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression)
                        || initializer.expression.text !== arrayTypes[index] || initializer.typeArguments?.length
                        || initializer.arguments?.length !== 1 || !ts.isArrayLiteralExpression(initializer.arguments[0])) throw unsupported();
                    const elements = initializer.arguments[0].elements;
                    if (elements.length !== arrayLengths[index]) throw unsupported();
                    const maximum = arrayTypes[index] === 'Uint8Array' ? 255 : 65535;
                    values.push(elements.map(element => {
                        if (!ts.isNumericLiteral(element)) throw unsupported();
                        const value = Number(element.text);
                        if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw unsupported();
                        return value;
                    }));
                } else if (index === arrayTypes.length) {
                    if (!(ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))) throw unsupported();
                    values.push(initializer.text);
                } else {
                    if (!ts.isNumericLiteral(initializer)) throw unsupported();
                    const value = Number(initializer.text);
                    if (!Number.isSafeInteger(value) || value < 0 || value >= arrayLengths[0]) throw unsupported();
                    values.push(value);
                }
            }
            const tableByteLength = arrayLengths.reduce((size, length, index) =>
                size + length * (arrayTypes[index] === 'Uint16Array' ? 2 : 1), 0);
            // JSON string bytes retain escaped lone surrogates; numeric arrays use an explicit LE layout.
            const labels = Buffer.from(JSON.stringify(values[arrayTypes.length]), 'utf8');
            const payload = new Uint8Array(tableByteLength + labels.byteLength);
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const offsets = [0];
            let offset = 0;
            for (let index = 0; index < arrayTypes.length; index++) {
                for (const value of values[index] as number[]) {
                    if (arrayTypes[index] === 'Uint8Array') payload[offset++] = value;
                    else {view.setUint16(offset, value, true); offset += 2;}
                }
                offsets.push(offset);
            }
            payload.set(labels, tableByteLength);
            const bytes = gzipUserscriptBuildData(payload, undefined, compact);
            const digest = createHash('sha256').update(code).digest('hex');
            const emit = (encoded: Buffer) => {
                const compressed = compact ? encodeUserscriptDataCompact(encoded) : encoded.toString('base64');
                return {
                    code: [
                        code.slice(0, source.statements[0].getStart(source)),
                        '/* Non-code locked tldts data; source sha256 ' + digest + '. */',
                        "import {inflateBytesWithPako, decodeUtf8WithPako} from '@/userscript/pakoBundled';",
                        ...(compact ? ["import {decodeUserscriptData} from '@/userscript/dataEncoding';"] : []),
                        'export const [' + names.slice(0, arrayTypes.length + 1).join(', ') + '] = (() => {',
                        ...(compact ? ['    const bytes = decodeUserscriptData(' + JSON.stringify(compressed) + ');'] : [
                            '    const binary = atob(' + JSON.stringify(compressed) + ');',
                            '    const bytes = new Uint8Array(binary.length);',
                            '    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);',
                        ]),
                        '    const data = inflateBytesWithPako(bytes);',
                        '    if (data.byteLength !== ' + payload.byteLength + ') throw new Error("Invalid locked suffix data length");',
                        '    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);',
                        '    const nodeFlags = new Uint8Array(data.subarray(' + offsets[0] + ', ' + offsets[1] + '));',
                        '    const edgeStart = new Uint16Array(' + arrayLengths[1] + ');',
                        '    for (let index = 0; index < edgeStart.length; index++) edgeStart[index] = view.getUint16(' + offsets[1] + ' + index * 2, true);',
                        '    const edgeLength = new Uint8Array(data.subarray(' + offsets[2] + ', ' + offsets[3] + '));',
                        '    const edgeChild = new Uint16Array(' + arrayLengths[3] + ');',
                        '    for (let index = 0; index < edgeChild.length; index++) edgeChild[index] = view.getUint16(' + offsets[3] + ' + index * 2, true);',
                        '    const labelText = JSON.parse(decodeUtf8WithPako(data.subarray(' + tableByteLength + ')));',
                        '    if (typeof labelText !== "string") throw new Error("Invalid locked suffix labels");',
                        '    return [nodeFlags, edgeStart, edgeLength, edgeChild, labelText];',
                        '})();',
                        'export const rulesRoot = ' + values[5] + ';',
                        'export const exceptionsRoot = ' + values[6] + ';',
                    ].join('\n'),
                    map: null,
                };
            };
            // worker 为构建期隔离进程，输出已验证；若未优于当前紧凑 Pako 则沿用后者。
            return standalone ? gzipLargeStandaloneUserscriptData(payload, root)
                .then(candidate => emit(candidate.byteLength < bytes.byteLength ? candidate : bytes)) : emit(bytes);
        },
    };
}
