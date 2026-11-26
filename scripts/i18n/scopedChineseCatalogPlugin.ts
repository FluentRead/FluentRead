/**
 * @file scripts/i18n/scopedChineseCatalogPlugin.ts
 * 文件职责：在构建非页面扩展入口（内容脚本、受限子 frame、后台脚本）时，自动裁剪不可达的简体中文界面目录条目。
 * 主要内容：先以轻量占位模块跳过完整 zh-CN 及其 15 份子目录的重复解析与打包，再在 generateBundle 阶段用单次线性扫描建立键令牌集、动态前缀集与中文语料切片，仅注入可达条目并通过 JSON.parse 快速初始化。
 * 模块边界：仅供 WXT 的 content-script 与 background 构建组使用；所有扩展页面（popup/options/document/sidepanel/learning 等）保留完整 zhCNMessages 共享块。
 */

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
    readonly prefixes: readonly string[];
    readonly hasHan: boolean;
}

const HAN_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/u;

const indexedEntries: readonly IndexedChineseEntry[] = Object.entries(zhCNMessages).map(([key, value]) => {
    const pluralIndex = key.indexOf('.plural.');
    const pluralBase = pluralIndex > 0 ? key.slice(0, pluralIndex) : null;
    const prefixes: string[] = [];
    let dot = key.indexOf('.');
    while (dot > 0) {
        prefixes.push(key.slice(0, dot + 1));
        dot = key.indexOf('.', dot + 1);
    }
    return {
        key,
        value,
        pluralBase,
        prefixes,
        hasHan: HAN_PATTERN.test(value),
    };
});

/** 单次扫描提取点分键令牌、动态拼接前缀与含中文字符串语料，将数千次全文扫描降为 O(n) + O(1) 查表。 */
function extractBundleLookupIndex(code: string): {
    readonly keyTokens: ReadonlySet<string>;
    readonly dynamicPrefixes: ReadonlySet<string>;
    readonly hanStrings: ReadonlySet<string>;
    readonly hanCorpus: string;
    readonly asciiLiterals: ReadonlySet<string>;
} {
    const keyTokens = new Set<string>();
    const tokenPattern = /[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+/gu;
    let tokenMatch = tokenPattern.exec(code);
    while (tokenMatch) {
        keyTokens.add(tokenMatch[0]!);
        tokenMatch = tokenPattern.exec(code);
    }

    const dynamicPrefixes = new Set<string>();
    const prefixPattern = /[`'"]([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\.)(?:[`'"]|\$\{)/gu;
    let prefixMatch = prefixPattern.exec(code);
    while (prefixMatch) {
        dynamicPrefixes.add(prefixMatch[1]!);
        prefixMatch = prefixPattern.exec(code);
    }

    const hanStrings = new Set<string>();
    const asciiLiterals = new Set<string>();
    const hanSegments: string[] = [];
    const literalPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/gu;
    let literalMatch = literalPattern.exec(code);
    while (literalMatch) {
        const raw = literalMatch[1] ?? literalMatch[2] ?? literalMatch[3] ?? '';
        if (raw.length > 0) {
            if (HAN_PATTERN.test(raw)) {
                hanStrings.add(raw);
                hanSegments.push(raw);
            } else if (raw.length <= 160) {
                asciiLiterals.add(raw);
            }
        }
        literalMatch = literalPattern.exec(code);
    }

    return {
        keyTokens,
        dynamicPrefixes,
        hanStrings,
        hanCorpus: hanSegments.join('\n'),
        asciiLiterals,
    };
}

/** 根据当前构建组的非 i18n 代码筛选所有可能被 translate() 或 translateLegacyText() 命中的中文条目。 */
export function selectReachableChineseMessages(bundleCode: string): Record<string, string> {
    const {keyTokens, dynamicPrefixes, hanStrings, hanCorpus, asciiLiterals} = extractBundleLookupIndex(bundleCode);
    const result: Record<string, string> = {};

    for (const entry of indexedEntries) {
        if (keyTokens.has(entry.key) || (entry.pluralBase !== null && keyTokens.has(entry.pluralBase))) {
            result[entry.key] = entry.value;
            continue;
        }
        let matchedPrefix = false;
        for (const prefix of entry.prefixes) {
            if (dynamicPrefixes.has(prefix)) {
                matchedPrefix = true;
                break;
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
