/**
 * @file scripts/i18n/scopedChineseCatalogPlugin.ts
 * 文件职责：在构建非页面扩展入口（内容脚本、受限子 frame、后台脚本）时，自动裁剪不可达的简体中文界面目录条目。
 * 主要内容：先以轻量占位模块跳过完整 zh-CN 及其 15 份子目录的重复解析与打包，再在 generateBundle 阶段用 TypeScript 词法扫描器（ts.createScanner）准确提取解码后的字符串字面量、嵌套模板片段、点分键前缀与段内动态前缀，同时以字符/双字索引加速中文子串匹配，彻底消除正则字面量引号导致的失同步漏裁与整棵 AST 构树开销。
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
    readonly valueLength: number;
    readonly firstCode: number;
    readonly firstBigram: number;
    readonly lastBigram: number;
    readonly pluralBase: string | null;
    readonly dotPrefixes: readonly string[];
    readonly hasHan: boolean;
}

const HAN_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/u;
const KEY_TOKEN_PATTERN = /[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+/gu;
const DOT_PREFIX_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\.$/u;
const STEM_PREFIX_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/u;

const SK = ts.SyntaxKind;
const TOKEN_TABLE_SIZE = 512;

/** 可直接引导正则字面量（/ 或 /=）的前置词法单元（不含 this/true/false/null/super 等值表达式）。 */
const REGEX_BEFORE_TOKEN_TABLE = new Uint8Array(TOKEN_TABLE_SIZE);
for (const kind of [
    SK.OpenParenToken,
    SK.OpenBracketToken,
    SK.OpenBraceToken,
    SK.CloseBraceToken,
    SK.CommaToken,
    SK.SemicolonToken,
    SK.ColonToken,
    SK.QuestionToken,
    SK.EqualsGreaterThanToken,
    SK.DotDotDotToken,
    SK.PlusToken,
    SK.MinusToken,
    SK.AsteriskToken,
    SK.AsteriskAsteriskToken,
    SK.SlashToken,
    SK.PercentToken,
    SK.AmpersandToken,
    SK.BarToken,
    SK.CaretToken,
    SK.TildeToken,
    SK.ExclamationToken,
    SK.LessThanToken,
    SK.LessThanEqualsToken,
    SK.GreaterThanToken,
    SK.GreaterThanEqualsToken,
    SK.EqualsEqualsToken,
    SK.ExclamationEqualsToken,
    SK.EqualsEqualsEqualsToken,
    SK.ExclamationEqualsEqualsToken,
    SK.LessThanLessThanToken,
    SK.GreaterThanGreaterThanToken,
    SK.GreaterThanGreaterThanGreaterThanToken,
    SK.AmpersandAmpersandToken,
    SK.BarBarToken,
    SK.QuestionQuestionToken,
    SK.EqualsToken,
    SK.PlusEqualsToken,
    SK.MinusEqualsToken,
    SK.AsteriskEqualsToken,
    SK.AsteriskAsteriskEqualsToken,
    SK.SlashEqualsToken,
    SK.PercentEqualsToken,
    SK.LessThanLessThanEqualsToken,
    SK.GreaterThanGreaterThanEqualsToken,
    SK.GreaterThanGreaterThanGreaterThanEqualsToken,
    SK.AmpersandEqualsToken,
    SK.BarEqualsToken,
    SK.CaretEqualsToken,
    SK.AmpersandAmpersandEqualsToken,
    SK.BarBarEqualsToken,
    SK.QuestionQuestionEqualsToken,
    SK.TemplateHead,
    SK.TemplateMiddle,
    SK.ReturnKeyword,
    SK.ThrowKeyword,
    SK.CaseKeyword,
    SK.DeleteKeyword,
    SK.VoidKeyword,
    SK.TypeOfKeyword,
    SK.YieldKeyword,
    SK.AwaitKeyword,
    SK.InKeyword,
    SK.InstanceOfKeyword,
    SK.NewKeyword,
    SK.ElseKeyword,
    SK.DoKeyword,
    SK.ExportKeyword,
    SK.DefaultKeyword,
    SK.ExtendsKeyword,
]) {
    if (kind < TOKEN_TABLE_SIZE) REGEX_BEFORE_TOKEN_TABLE[kind] = 1;
}

/** 可直接开启表达式位置（如对象字面量、函数/类表达式）的前置词法单元。 */
const EXPR_PREFIX_TOKEN_TABLE = new Uint8Array(TOKEN_TABLE_SIZE);
for (const kind of [
    SK.OpenParenToken,
    SK.OpenBracketToken,
    SK.CommaToken,
    SK.QuestionToken,
    SK.DotDotDotToken,
    SK.PlusToken,
    SK.MinusToken,
    SK.AsteriskToken,
    SK.AsteriskAsteriskToken,
    SK.SlashToken,
    SK.PercentToken,
    SK.AmpersandToken,
    SK.BarToken,
    SK.CaretToken,
    SK.TildeToken,
    SK.ExclamationToken,
    SK.LessThanToken,
    SK.LessThanEqualsToken,
    SK.GreaterThanToken,
    SK.GreaterThanEqualsToken,
    SK.EqualsEqualsToken,
    SK.ExclamationEqualsToken,
    SK.EqualsEqualsEqualsToken,
    SK.ExclamationEqualsEqualsToken,
    SK.LessThanLessThanToken,
    SK.GreaterThanGreaterThanToken,
    SK.GreaterThanGreaterThanGreaterThanToken,
    SK.AmpersandAmpersandToken,
    SK.BarBarToken,
    SK.QuestionQuestionToken,
    SK.EqualsToken,
    SK.PlusEqualsToken,
    SK.MinusEqualsToken,
    SK.AsteriskEqualsToken,
    SK.AsteriskAsteriskEqualsToken,
    SK.SlashEqualsToken,
    SK.PercentEqualsToken,
    SK.LessThanLessThanEqualsToken,
    SK.GreaterThanGreaterThanEqualsToken,
    SK.GreaterThanGreaterThanGreaterThanEqualsToken,
    SK.AmpersandEqualsToken,
    SK.BarEqualsToken,
    SK.CaretEqualsToken,
    SK.AmpersandAmpersandEqualsToken,
    SK.BarBarEqualsToken,
    SK.QuestionQuestionEqualsToken,
    SK.TemplateHead,
    SK.TemplateMiddle,
    SK.ReturnKeyword,
    SK.ThrowKeyword,
    SK.DeleteKeyword,
    SK.VoidKeyword,
    SK.TypeOfKeyword,
    SK.YieldKeyword,
    SK.AwaitKeyword,
    SK.InKeyword,
    SK.InstanceOfKeyword,
    SK.NewKeyword,
    SK.ExtendsKeyword,
]) {
    if (kind < TOKEN_TABLE_SIZE) EXPR_PREFIX_TOKEN_TABLE[kind] = 1;
}

/** 结合优先级高于或左结合等于二元 + 的前置词法单元：其后的字符串字面量不会成为后续 + 的左操作数。 */
const BLOCKS_LEFT_OF_PLUS_TABLE = new Uint8Array(TOKEN_TABLE_SIZE);
for (const kind of [
    SK.DotToken,
    SK.QuestionDotToken,
    SK.PlusToken,
    SK.MinusToken,
    SK.AsteriskToken,
    SK.SlashToken,
    SK.PercentToken,
    SK.AsteriskAsteriskToken,
    SK.ExclamationToken,
    SK.TildeToken,
    SK.PlusPlusToken,
    SK.MinusMinusToken,
    SK.TypeOfKeyword,
    SK.VoidKeyword,
    SK.DeleteKeyword,
    SK.AwaitKeyword,
]) {
    if (kind < TOKEN_TABLE_SIZE) BLOCKS_LEFT_OF_PLUS_TABLE[kind] = 1;
}

const indexedEntries: readonly IndexedChineseEntry[] = Object.entries(zhCNMessages).map(([key, value]) => {
    const pluralIndex = key.indexOf('.plural.');
    const pluralBase = pluralIndex > 0 ? key.slice(0, pluralIndex) : null;
    const dotPrefixes: string[] = [];
    let dot = key.indexOf('.');
    while (dot > 0) {
        dotPrefixes.push(key.slice(0, dot + 1));
        dot = key.indexOf('.', dot + 1);
    }
    const valueLength = value.length;
    return {
        key,
        value,
        valueLength,
        firstCode: valueLength > 0 ? value.charCodeAt(0) : 0,
        firstBigram: valueLength >= 2 ? ((value.charCodeAt(0) << 16) | value.charCodeAt(1)) : 0,
        lastBigram: valueLength >= 3 ? ((value.charCodeAt(valueLength - 2) << 16) | value.charCodeAt(valueLength - 1)) : 0,
        pluralBase,
        dotPrefixes,
        hasHan: HAN_PATTERN.test(value),
    };
});

/** 通过 TypeScript 词法扫描器提取所有解码后的字符串字面量、嵌套模板片段、点分键与动态拼接前缀，免疫正则字面量引号失同步并避免整棵 AST 构树。 */
function extractBundleLookupIndex(code: string): {
    readonly exactStrings: ReadonlySet<string>;
    readonly keyTokens: ReadonlySet<string>;
    readonly dotPrefixes: ReadonlySet<string>;
    readonly stemPrefixes: readonly string[];
    readonly hanStrings: ReadonlySet<string>;
    readonly hanCorpus: string;
    readonly hanChars: ReadonlySet<number>;
    readonly hanBigrams: ReadonlySet<number>;
    readonly asciiLiterals: ReadonlySet<string>;
} {
    const exactStrings = new Set<string>();
    const keyTokens = new Set<string>();
    const dotPrefixes = new Set<string>();
    const stemPrefixSet = new Set<string>();
    const hanStrings = new Set<string>();
    const asciiLiterals = new Set<string>();

    const recordText = (text: string, allowDynamicPrefix: boolean): void => {
        if (!text) return;
        const hasDot = text.includes('.');
        if (!exactStrings.has(text)) {
            exactStrings.add(text);
            if (HAN_PATTERN.test(text)) {
                hanStrings.add(text);
            } else if (text.length <= 160) {
                asciiLiterals.add(text);
            }
            if (hasDot) {
                KEY_TOKEN_PATTERN.lastIndex = 0;
                let tokenMatch = KEY_TOKEN_PATTERN.exec(text);
                while (tokenMatch) {
                    keyTokens.add(tokenMatch[0]!);
                    tokenMatch = KEY_TOKEN_PATTERN.exec(text);
                }
                if (DOT_PREFIX_PATTERN.test(text)) {
                    dotPrefixes.add(text);
                }
            }
        }
        if (allowDynamicPrefix && hasDot && !dotPrefixes.has(text) && STEM_PREFIX_PATTERN.test(text)) {
            stemPrefixSet.add(text);
        }
    };

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
    const templateBraceDepths: number[] = [];
    const braceStack: Array<'stmt' | 'expr'> = [];
    const parenControlStack: Array<'for' | 'control' | 'expr'> = [];
    const parenNestingStack: number[] = [];
    let pendingBraceKind: 'stmt' | 'expr' | null = null;
    let pendingBraceParenDepth = 0;
    let canStartRegex = true;
    let prevPrevToken: ts.SyntaxKind = SK.Unknown;
    let prevToken: ts.SyntaxKind = SK.Unknown;
    let prevWasDot = false;
    let pendingLiteral: string | null = null;
    let pendingCanBeLeftOfPlus = false;

    const isExprPrefix = (kind: ts.SyntaxKind): boolean => {
        if (kind < TOKEN_TABLE_SIZE && EXPR_PREFIX_TOKEN_TABLE[kind] === 1) return true;
        if (kind === SK.ColonToken && braceStack[braceStack.length - 1] === 'expr') return true;
        return false;
    };

    let token = scanner.scan();
    while (token !== SK.EndOfFileToken) {
        let closedTemplate = false;
        if ((token === SK.SlashToken || token === SK.SlashEqualsToken) && canStartRegex) {
            token = scanner.reScanSlashToken();
        } else if (token === SK.CloseBraceToken && templateBraceDepths.length > 0) {
            const topIndex = templateBraceDepths.length - 1;
            const depth = templateBraceDepths[topIndex]!;
            if (depth === 0) {
                closedTemplate = true;
                token = scanner.reScanTemplateToken(false);
                if (token === SK.TemplateTail) {
                    templateBraceDepths.pop();
                }
            } else {
                templateBraceDepths[topIndex] = depth - 1;
            }
        }

        if (pendingLiteral !== null) {
            recordText(pendingLiteral, pendingCanBeLeftOfPlus && token === SK.PlusToken);
            pendingLiteral = null;
        }

        const effectiveToken = prevWasDot ? SK.Identifier : token;
        if (token === SK.StringLiteral || token === SK.NoSubstitutionTemplateLiteral) {
            pendingLiteral = scanner.getTokenValue();
            const blockedByPrev = prevToken < TOKEN_TABLE_SIZE
                && BLOCKS_LEFT_OF_PLUS_TABLE[prevToken] === 1
                && !((prevToken === SK.PlusPlusToken || prevToken === SK.MinusMinusToken) && scanner.hasPrecedingLineBreak());
            pendingCanBeLeftOfPlus = !blockedByPrev;
            canStartRegex = false;
        } else if (token === SK.TemplateHead) {
            recordText(scanner.getTokenValue(), true);
            templateBraceDepths.push(0);
            canStartRegex = true;
        } else if (token === SK.TemplateMiddle) {
            recordText(scanner.getTokenValue(), false);
            canStartRegex = true;
        } else if (token === SK.TemplateTail) {
            recordText(scanner.getTokenValue(), false);
            canStartRegex = false;
        } else if (token === SK.OpenBraceToken) {
            if (templateBraceDepths.length > 0) {
                templateBraceDepths[templateBraceDepths.length - 1]! += 1;
            }
            if (parenNestingStack.length > 0) {
                parenNestingStack[parenNestingStack.length - 1]! += 1;
            }
            if (pendingBraceKind !== null && parenControlStack.length === pendingBraceParenDepth) {
                braceStack.push(pendingBraceKind);
                pendingBraceKind = null;
            } else {
                braceStack.push(isExprPrefix(prevToken) ? 'expr' : 'stmt');
            }
            canStartRegex = true;
        } else if (token === SK.CloseBraceToken && !closedTemplate) {
            if (parenNestingStack.length > 0 && parenNestingStack[parenNestingStack.length - 1]! > 0) {
                parenNestingStack[parenNestingStack.length - 1]! -= 1;
            }
            const closedKind = braceStack.length > 0 ? braceStack.pop()! : 'stmt';
            canStartRegex = closedKind !== 'expr';
        } else if (token === SK.OpenBracketToken) {
            if (parenNestingStack.length > 0) {
                parenNestingStack[parenNestingStack.length - 1]! += 1;
            }
            canStartRegex = true;
        } else if (token === SK.CloseBracketToken) {
            if (parenNestingStack.length > 0 && parenNestingStack[parenNestingStack.length - 1]! > 0) {
                parenNestingStack[parenNestingStack.length - 1]! -= 1;
            }
            canStartRegex = false;
        } else if (token === SK.OpenParenToken) {
            if (prevToken === SK.ForKeyword || (prevToken === SK.AwaitKeyword && prevPrevToken === SK.ForKeyword)) {
                parenControlStack.push('for');
            } else if (prevToken === SK.IfKeyword || prevToken === SK.WhileKeyword || prevToken === SK.WithKeyword) {
                parenControlStack.push('control');
            } else {
                parenControlStack.push('expr');
            }
            parenNestingStack.push(0);
            canStartRegex = true;
        } else if (token === SK.CloseParenToken) {
            if (parenNestingStack.length > 0) parenNestingStack.pop();
            canStartRegex = parenControlStack.length > 0 ? parenControlStack.pop()! !== 'expr' : false;
        } else if (token === SK.SemicolonToken) {
            if (parenControlStack.length > 0
                && parenControlStack[parenControlStack.length - 1] === 'for'
                && parenNestingStack[parenNestingStack.length - 1] === 0) {
                parenControlStack[parenControlStack.length - 1] = 'control';
            }
            pendingBraceKind = null;
            canStartRegex = true;
        } else if (effectiveToken === SK.FunctionKeyword || effectiveToken === SK.ClassKeyword) {
            const isExpr = isExprPrefix(prevToken)
                || (prevToken === SK.AsyncKeyword && isExprPrefix(prevPrevToken));
            pendingBraceKind = isExpr ? 'expr' : 'stmt';
            pendingBraceParenDepth = parenControlStack.length;
            canStartRegex = false;
        } else if (effectiveToken === SK.OfKeyword) {
            const inForHeaderTop = parenControlStack[parenControlStack.length - 1] === 'for'
                && parenNestingStack[parenNestingStack.length - 1] === 0;
            const prevEndsForOfLhs = prevToken === SK.Identifier
                || prevToken === SK.OfKeyword
                || prevToken === SK.CloseBracketToken
                || prevToken === SK.CloseBraceToken
                || prevToken === SK.CloseParenToken;
            canStartRegex = inForHeaderTop && prevEndsForOfLhs;
        } else {
            canStartRegex = effectiveToken < TOKEN_TABLE_SIZE && REGEX_BEFORE_TOKEN_TABLE[effectiveToken] === 1;
        }

        prevWasDot = token === SK.DotToken || token === SK.QuestionDotToken;
        prevPrevToken = prevToken;
        prevToken = effectiveToken;
        token = scanner.scan();
    }

    if (pendingLiteral !== null) {
        recordText(pendingLiteral, false);
    }

    const hanCorpus = [...hanStrings].join('\n');
    const hanChars = new Set<number>();
    const hanBigrams = new Set<number>();
    for (let i = 0; i < hanCorpus.length; i += 1) {
        const c0 = hanCorpus.charCodeAt(i);
        hanChars.add(c0);
        if (i + 1 < hanCorpus.length) {
            hanBigrams.add((c0 << 16) | hanCorpus.charCodeAt(i + 1));
        }
    }

    return {
        exactStrings,
        keyTokens,
        dotPrefixes,
        stemPrefixes: [...stemPrefixSet],
        hanStrings,
        hanCorpus,
        hanChars,
        hanBigrams,
        asciiLiterals,
    };
}

/** 根据当前构建组的非 i18n 代码筛选所有可能被 translate() 或 translateLegacyText() 命中的中文条目。 */
export function selectReachableChineseMessages(bundleCode: string): Record<string, string> {
    const {
        exactStrings,
        keyTokens,
        dotPrefixes,
        stemPrefixes,
        hanStrings,
        hanCorpus,
        hanChars,
        hanBigrams,
        asciiLiterals,
    } = extractBundleLookupIndex(bundleCode);
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
        if (entry.valueLength > 0) {
            if (entry.hasHan) {
                if (hanStrings.has(entry.value)) {
                    result[entry.key] = entry.value;
                } else if (entry.valueLength === 1) {
                    if (hanChars.has(entry.firstCode)) result[entry.key] = entry.value;
                } else if (entry.valueLength === 2) {
                    if (hanBigrams.has(entry.firstBigram)) result[entry.key] = entry.value;
                } else if (hanBigrams.has(entry.firstBigram)
                    && hanBigrams.has(entry.lastBigram)
                    && hanCorpus.includes(entry.value)) {
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
