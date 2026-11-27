/**
 * @file scripts/i18n/scopedChineseCatalogPlugin.ts
 * 文件职责：在构建非页面扩展入口（内容脚本、受限子 frame、后台脚本）时，自动裁剪不可达的简体中文界面目录条目。
 * 主要内容：先以轻量占位模块跳过完整 zh-CN 及其 15 份子目录的重复解析与打包，再在 generateBundle 阶段用 TypeScript AST 解析准确提取解码后的字符串字面量、模板片段、点分键前缀与段内动态前缀，彻底消除正则字面量引号导致的失同步漏裁与段内模板键误裁。
 * 模块边界：仅供 WXT 的 content-script 与 background 构建组使用；所有扩展页面（popup/options/document/sidepanel/learning 等）保留完整 zhCNMessages 共享块。
 */

import ts from 'typescript';
import type {Plugin} from 'vite';
import {zhCNMessages} from '../../src/core/i18n/messages/zh-CN';

const ZH_CN_MODULE_PATTERN = /[\\/]src[\\/]core[\\/]i18n[\\/]messages[\\/]zh-CN(?:\.ts)?$/u;
const ZH_CN_RELATIVE_IMPORTER = /[\\/]src[\\/]core[\\/]i18n[\\/]index\.ts$/u;
const VIRTUAL_SCOPED_ZH_CN_ID = '\0fluentread-scoped-zh-cn';
const SENTINEL = '__FLUENTREAD_SCOPED_ZH_CN_CATALOG__';

interface IndexedChineseEntry {
    readonly key: string;
    readonly value: string;
    readonly pluralBase: string | null;
    readonly dotPrefixes: readonly string[];
    readonly hasHan: boolean;
}

const HAN_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/u;
const KEY_TOKEN_PATTERN = /[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+/gu;
const DOT_PREFIX_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\.$/u;
const STEM_PREFIX_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/u;

const indexedEntries: readonly IndexedChineseEntry[] = Object.entries(zhCNMessages).map(([key, value]) => {
    const pluralIndex = key.indexOf('.plural.');
    const pluralBase = pluralIndex > 0 ? key.slice(0, pluralIndex) : null;
    const dotPrefixes: string[] = [];
    let dot = key.indexOf('.');
    while (dot > 0) {
        dotPrefixes.push(key.slice(0, dot + 1));
        dot = key.indexOf('.', dot + 1);
    }
    return {
        key,
        value,
        pluralBase,
        dotPrefixes,
        hasHan: HAN_PATTERN.test(value),
    };
});

/** 通过真实 JS AST 提取所有解码后的字符串字面量、模板片段、点分键与动态拼接前缀，免疫正则字面量中的引号失同步。 */
function extractBundleLookupIndex(code: string): {
    readonly exactStrings: ReadonlySet<string>;
    readonly keyTokens: ReadonlySet<string>;
    readonly dotPrefixes: ReadonlySet<string>;
    readonly stemPrefixes: readonly string[];
    readonly hanStrings: ReadonlySet<string>;
    readonly hanCorpus: string;
    readonly asciiLiterals: ReadonlySet<string>;
} {
    const exactStrings = new Set<string>();
    const keyTokens = new Set<string>();
    const dotPrefixes = new Set<string>();
    const stemPrefixSet = new Set<string>();
    const hanStrings = new Set<string>();
    const asciiLiterals = new Set<string>();
    const hanSegments: string[] = [];

    const recordText = (text: string, allowDynamicPrefix: boolean): void => {
        if (!text) return;
        exactStrings.add(text);
        if (HAN_PATTERN.test(text)) {
            hanStrings.add(text);
            hanSegments.push(text);
        } else if (text.length <= 160) {
            asciiLiterals.add(text);
        }
        KEY_TOKEN_PATTERN.lastIndex = 0;
        let tokenMatch = KEY_TOKEN_PATTERN.exec(text);
        while (tokenMatch) {
            keyTokens.add(tokenMatch[0]!);
            tokenMatch = KEY_TOKEN_PATTERN.exec(text);
        }
        if (DOT_PREFIX_PATTERN.test(text)) {
            dotPrefixes.add(text);
        } else if (allowDynamicPrefix && STEM_PREFIX_PATTERN.test(text)) {
            stemPrefixSet.add(text);
        }
    };

    const sourceFile = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            recordText(node.text, false);
            return;
        }
        if (ts.isTemplateExpression(node)) {
            recordText(node.head.text, true);
            for (const span of node.templateSpans) {
                visit(span.expression);
                recordText(span.literal.text, false);
            }
            return;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            if (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left)) {
                recordText(node.left.text, true);
                visit(node.right);
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return {
        exactStrings,
        keyTokens,
        dotPrefixes,
        stemPrefixes: [...stemPrefixSet],
        hanStrings,
        hanCorpus: hanSegments.join('\n'),
        asciiLiterals,
    };
}

/** 根据当前构建组的非 i18n 代码筛选所有可能被 translate() 或 translateLegacyText() 命中的中文条目。 */
export function selectReachableChineseMessages(bundleCode: string): Record<string, string> {
    const {exactStrings, keyTokens, dotPrefixes, stemPrefixes, hanStrings, hanCorpus, asciiLiterals} = extractBundleLookupIndex(bundleCode);
    const result: Record<string, string> = {};

    for (const entry of indexedEntries) {
        if (exactStrings.has(entry.key)
            || keyTokens.has(entry.key)
            || (entry.pluralBase !== null && (exactStrings.has(entry.pluralBase) || keyTokens.has(entry.pluralBase)))) {
            result[entry.key] = entry.value;
            continue;
        }
        let matchedPrefix = false;
        for (const prefix of entry.dotPrefixes) {
            if (dotPrefixes.has(prefix)) {
                matchedPrefix = true;
                break;
            }
        }
        if (!matchedPrefix && stemPrefixes.length > 0) {
            for (const stem of stemPrefixes) {
                if (entry.key.startsWith(stem)) {
                    matchedPrefix = true;
                    break;
                }
            }
        }
        if (matchedPrefix) {
            result[entry.key] = entry.value;
            continue;
        }
        if (entry.value.length > 0) {
            if (entry.hasHan) {
                if (hanStrings.has(entry.value) || hanCorpus.includes(entry.value)) {
                    result[entry.key] = entry.value;
                }
            } else if (asciiLiterals.has(entry.value)) {
                result[entry.key] = entry.value;
            }
        }
    }

    return result;
}

function serializeCatalogLiteral(catalog: Record<string, string>): string {
    return JSON.stringify(JSON.stringify(catalog))
        .replace(/\u2028/gu, '\\u2028')
        .replace(/\u2029/gu, '\\u2029');
}

export function scopedChineseCatalogBuildPlugin(): Plugin {
    return {
        name: 'fluentread-scoped-chinese-catalog',
        enforce: 'pre',
        resolveId(source: string, importer?: string) {
            if (ZH_CN_MODULE_PATTERN.test(source)) return VIRTUAL_SCOPED_ZH_CN_ID;
            if ((source === './messages/zh-CN' || source === './messages/zh-CN.ts')
                && importer && ZH_CN_RELATIVE_IMPORTER.test(importer)) {
                return VIRTUAL_SCOPED_ZH_CN_ID;
            }
            return null;
        },
        load(id: string) {
            if (id !== VIRTUAL_SCOPED_ZH_CN_ID) return null;
            return `export const zhCNMessages = JSON.parse("${SENTINEL}");\n`;
        },
        generateBundle(_options, bundle) {
            const chunks = Object.values(bundle).filter(
                (item): item is Extract<typeof item, {type: 'chunk'}> => item.type === 'chunk' && typeof item.code === 'string',
            );
            const targetChunks = chunks.filter(chunk => chunk.code.includes(SENTINEL));
            if (targetChunks.length === 0) return;

            const combinedCode = chunks
                .map(chunk => chunk.code.replaceAll(SENTINEL, ''))
                .join('\n');
            const pruned = selectReachableChineseMessages(combinedCode);
            const replacement = serializeCatalogLiteral(pruned);
            const quotedSentinelPattern = new RegExp(`(["'\`])${SENTINEL}\\1`, 'gu');

            for (const chunk of targetChunks) {
                chunk.code = chunk.code.replace(quotedSentinelPattern, () => replacement);
                if (chunk.code.includes(SENTINEL)) {
                    throw new Error(`Failed to inject scoped zh-CN catalog into ${chunk.fileName}`);
                }
            }
        },
    };
}
