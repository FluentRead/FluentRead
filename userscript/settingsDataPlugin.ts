/**
 * @file userscript/settingsDataPlugin.ts
 * 文件职责：在 userscript 构建时无损压缩固定设置数据，完整设置版再压缩学习、语言、词库、导航和同步字段等静态目录。
 * 主要内容：只从指定 const 的字面量 AST 读取 JSON 类型，拒绝计算、重复键和特殊原型键；以既有 ASCII85 或 standalone 的 Base91 保存完整 gzip 字节；AI 超时目录只接受已登记的中文 const 引用，分别压缩两份字面量并在还原聚合表时接回同一中文对象；原地替换初始化值，同步还原所有文本、类型和顺序；皮肤与字体注册表通过同一插件校验两个具名导出数组，保留文件注释、既有 Map 与函数。
 * 模块边界：不执行源模块、不压缩可执行逻辑，不改远程语言资源；标准版只压缩完整消费的样式与界面注册表，避免目录表示阻止原有裁剪；沿用 pako，消费函数保持原实现，Greasy Fork 保留可读数据。
 */
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact, encodeUserscriptData} from './buildDataEncoding';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

type Json = string | number | boolean | null | Json[] | {[key: string]: Json};

function literal(node: ts.Expression, allowNumericKeys = true): Json {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, allowNumericKeys);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) {
        const value = Number(node.text);
        if (Number.isFinite(value)) return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => literal(element, allowNumericKeys));
    if (ts.isObjectLiteralExpression(node)) {
        const result: {[key: string]: Json} = {};
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)
                || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || allowNumericKeys && ts.isNumericLiteral(property.name))) {
                throw new Error('Standalone settings data requires literal object properties');
            }
            const key = ts.isNumericLiteral(property.name) ? String(Number(property.name.text)) : property.name.text;
            if (key === '__proto__' || Object.prototype.hasOwnProperty.call(result, key)) {
                throw new Error('Standalone settings data contains a duplicate or prototype key');
            }
            Object.defineProperty(result, key, {value: literal(property.initializer, allowNumericKeys), enumerable: true});
        }
        return result;
    }
    throw new Error('Standalone settings data requires JSON literals');
}

export function createUserscriptSettingsDataPlugin(root: string, enabled: boolean, fullOptions = true): Plugin {
    const targets = new Map<string, {names: readonly string[]; appearance?: boolean;
        sharedLocale?: {table: string; key: string; reference: string}}>([
        [normalizePath(resolve(root, 'src/core/config/translationAppearance.ts')), {names: ['TRANSLATION_STYLE_PRESETS']}],
        [normalizePath(resolve(root, 'src/core/config/interfaceAppearance.ts')), {names: ['interfaceSkinOptions', 'interfaceFontOptions'], appearance: true}],
    ]);
    if (fullOptions) {
        targets.set(normalizePath(resolve(root, 'src/core/harness/promptLocales.ts')), {names: ['HARNESS_TRANSLATED_PROMPTS']});
        targets.set(normalizePath(resolve(root, 'src/core/config/catalog.ts')), {names: ['localizedTargetLanguageLabels']});
        targets.set(normalizePath(resolve(root, 'src/core/glossary/builtins.ts')), {names: ['BUILTIN_GLOSSARIES']});
        targets.set(normalizePath(resolve(root, 'src/core/config/videoSubtitleAppearance.ts')), {names: ['VIDEO_SUBTITLE_SKINS']});
        targets.set(normalizePath(resolve(root, 'src/features/settings/model/chromeTranslationPreparation.ts')), {names: ['TEST_SAMPLES']});
        targets.set(normalizePath(resolve(root, 'src/core/i18n/messages/aiRequestTimeout.ts')), {
            names: ['aiRequestTimeoutChineseMessages', 'aiRequestTimeoutMessages'],
            sharedLocale: {table: 'aiRequestTimeoutMessages', key: 'zh-CN', reference: 'aiRequestTimeoutChineseMessages'},
        });
        targets.set(normalizePath(resolve(root, 'src/core/config/driveSync.ts')), {names: ['VISIBLE_FIELDS']});
        targets.set(normalizePath(resolve(root, 'src/features/settings/model/navigation.ts')), {names: ['settingsPagePanels', 'settingsSearchTargets']});
        targets.set(normalizePath(resolve(root, 'src/core/config/translationLoadingStyle.ts')), {names: ['translationLoadingStyleOptions']});
        targets.set(normalizePath(resolve(root, 'src/core/config/freeTranslation.ts')), {names: ['FREE_TRANSLATION_PROVIDERS']});
        targets.set(normalizePath(resolve(root, 'src/core/language/catalog.ts')), {names: ['translationLanguageOptions']});
        targets.set(normalizePath(resolve(root, 'src/core/language/partOfSpeech.ts')), {names: ['PARTS']});
        targets.set(normalizePath(resolve(root, 'src/core/config/sentenceHighlight.ts')), {names: ['SENTENCE_HIGHLIGHT_STYLES']});
        targets.set(normalizePath(resolve(root, 'src/core/config/selectionTts.ts')), {names: ['SELECTION_TTS_VOICE_OPTIONS']});
    }
    return {
        name: 'standalone-settings-data', enforce: 'pre',
        transform(code, id) {
            const target = targets.get(normalizePath(id.split('?')[0]));
            if (!enabled || !target) return null;
            // 注册表只接受唯一物理模块；保留其它既有设置表的 query-id 契约。
            if (target.appearance && id.includes('?')) return null;
            const unsupported = () => new Error('Userscript appearance registries must be unique exported const literal arrays');
            try {
                const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
                // TypeScript 会恢复部分错误语法；先拒绝诊断，不能把损坏源码重新编码成合法数据。
                if ((source as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics.length) {
                    throw new Error('Standalone settings data source has syntax errors');
                }
                const declarations = source.statements.filter(ts.isVariableStatement)
                    .flatMap(statement => [...statement.declarationList.declarations]
                        .filter(declaration => ts.isIdentifier(declaration.name) && target.names.includes(declaration.name.text))
                        .map(declaration => ({declaration, constant: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
                            exported: Boolean(statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))})));
                if (code.includes('__fluentreadInflateSettingsData') || code.includes('__fluentreadDecodeSettingsData')
                    || target.names.some(name => declarations.filter(entry => entry.declaration.name.getText(source) === name).length !== 1)
                    || declarations.some(entry => !entry.constant || !entry.declaration.initializer || target.appearance && !entry.exported)) {
                    throw new Error(`Standalone settings data declaration changed: ${target.names.join(', ')}`);
                }
                let transformed = code;
                for (const entry of [...declarations].sort((left, right) => right.declaration.pos - left.declaration.pos)) {
                    const initializer = entry.declaration.initializer!;
                    const shared = target.sharedLocale?.table === entry.declaration.name.getText(source) ? target.sharedLocale : undefined;
                    let data: Json;
                    if (shared) {
                        const reference = declarations.find(item => item.declaration.name.getText(source) === shared.reference)!;
                        const referenceData = literal(reference.declaration.initializer!);
                        if (!reference.exported || reference.declaration.pos >= entry.declaration.pos || !referenceData
                            || typeof referenceData !== 'object' || Array.isArray(referenceData) || !ts.isObjectLiteralExpression(initializer)) {
                            throw new Error('Standalone shared locale requires an earlier exported const JSON object');
                        }
                        let references = 0;
                        const properties = initializer.properties.map(property => {
                            if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || property.name.text !== shared.key) return property;
                            if (!ts.isIdentifier(property.initializer) || property.initializer.text !== shared.reference) {
                                throw new Error('Standalone shared locale reference changed');
                            }
                            references += 1;
                            return ts.factory.updatePropertyAssignment(property, property.name, ts.factory.createNull());
                        });
                        if (references !== 1) throw new Error('Standalone shared locale reference changed');
                        // literal 仍拒绝任意标识符与可执行表达式；只有上面逐字核对的已知引用改为占位。
                        data = literal(ts.factory.updateObjectLiteralExpression(initializer, properties));
                    } else data = literal(initializer, !target.appearance);
                    if (target.appearance && (!Array.isArray(data) || !data.length)) throw unsupported();
                    const json = JSON.stringify(data);
                    const compressed = gzipUserscriptBuildData(Buffer.from(json), undefined, fullOptions);
                    if (target.appearance && JSON.stringify(JSON.parse(gunzipSync(compressed).toString('utf8'))) !== json) throw unsupported();
                    // 和原字面量一样，未被消费的表不应触发还原；整个闭包只还原固定数据，无外部写入。
                    const encoded = fullOptions ? encodeUserscriptDataCompact(compressed) : encodeUserscriptData(compressed);
                    const decoded = `JSON.parse(__fluentreadInflateSettingsData(__fluentreadDecodeSettingsData(${JSON.stringify(encoded)})))`;
                    const value = shared
                        ? `/* @__PURE__ */ (() => {const data = ${decoded}; data[${JSON.stringify(shared.key)}] = ${shared.reference}; return data;})()`
                        : `/* @__PURE__ */ (() => ${decoded})()`;
                    transformed = transformed.slice(0, initializer.getStart(source)) + value + transformed.slice(initializer.end);
                }
                const importCode = "import {inflateWithPako as __fluentreadInflateSettingsData} from '@/userscript/pakoRuntime';\n"
                    + "import {decodeUserscriptData as __fluentreadDecodeSettingsData} from '@/userscript/dataEncoding';\n";
                const insertion = target.appearance ? source.statements[0].getStart(source) : 0;
                return {code: transformed.slice(0, insertion) + importCode + transformed.slice(insertion), map: null};
            } catch (error) {
                if (target.appearance) throw unsupported();
                throw error;
            }
        },
    };
}
