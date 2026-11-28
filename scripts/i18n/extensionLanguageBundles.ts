/**
 * @file scripts/i18n/extensionLanguageBundles.ts
 * 文件职责：在扩展构建期生成界面语言包产物：en-US 与 zh-TW 输出 100% 离线无损的 compact-v1 紧凑包，其余五语按固定远程基线输出紧凑 delta-v1 增量包。
 * 主要内容：提供点分消息键嵌套压缩与繁體旧文案的字符映射、短语规则加最小多段编辑补丁编码，并在构建期逐项回环校验还原结果与完整词典完全一致；对五种远程增量语言校验固定基线长度与 SHA-256 摘要并生成嵌套键增量。
 * 模块边界：仅供 WXT 构建与单测调用，不进入浏览器运行时代码；不修改 userscript 固定语言文件或核心词典定义。
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createUiLanguageBundleFiles} from '../../src/core/i18n/bundles';
import {
    createDeltaUiLanguageBundle,
    expandCompactUiLanguageBundle,
    isRemoteDeltaUiLanguage,
    REMOTE_LANGUAGE_BASE_ASSETS,
    type CompactLegacyTextCodec,
    type CompactUiLanguageBundle,
    type LegacyTextPatch,
    type NestedMessageCatalog,
} from '../../src/core/i18n/remoteLanguagePacks';
import type {MessageCatalog, UiLanguageBundle} from '../../src/core/i18n/types';

const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function canNestKey(key: string): boolean {
    if (!key || key.startsWith('.') || key.endsWith('.') || key.includes('..')) return false;
    return key.split('.').every(segment => !RESERVED_SEGMENTS.has(segment));
}

/** 将点分消息键无损压缩为嵌套 JSON 树；前缀冲突使用空字符串键保留，确保与 flattenMessageCatalog 严格互逆。 */
export function nestMessageCatalog(catalog: MessageCatalog): NestedMessageCatalog {
    const root: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(catalog)) {
        if (!canNestKey(key)) {
            root[key] = value;
            continue;
        }
        const parts = key.split('.');
        let cursor = root;
        for (let i = 0; i < parts.length - 1; i += 1) {
            const segment = parts[i]!;
            const existing = cursor[segment];
            if (typeof existing === 'string') {
                cursor[segment] = {'': existing};
            } else if (!existing || typeof existing !== 'object') {
                cursor[segment] = {};
            }
            cursor = cursor[segment] as Record<string, unknown>;
        }
        const leaf = parts[parts.length - 1]!;
        const existingLeaf = cursor[leaf];
        if (existingLeaf && typeof existingLeaf === 'object') {
            (existingLeaf as Record<string, unknown>)[''] = value;
        } else {
            cursor[leaf] = value;
        }
    }
    return root as NestedMessageCatalog;
}

function isBmpSingleChar(code: number): boolean {
    return code < 0xd800 || code > 0xdfff;
}

/** 计算 UTF-16 级最小多段编辑三元组 [skip, del, ins, ...]，并合并间隔 <= 5 字符的邻近补丁以最小化 JSON 体积。 */
function diffLegacyHunks(base: string, target: string): Array<number | string> {
    let prefix = 0;
    const minLen = Math.min(base.length, target.length);
    while (prefix < minLen && base.charCodeAt(prefix) === target.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    while (suffix < base.length - prefix && suffix < target.length - prefix
        && base.charCodeAt(base.length - 1 - suffix) === target.charCodeAt(target.length - 1 - suffix)) {
        suffix += 1;
    }
    const left = base.slice(prefix, base.length - suffix);
    const right = target.slice(prefix, target.length - suffix);
    if (left.length === 0 && right.length === 0) return [];

    const n = left.length;
    const m = right.length;
    if (n * m > 40_000) return [prefix, n, right];

    const stride = m + 1;
    const dp = new Uint16Array((n + 1) * stride);
    for (let i = n - 1; i >= 0; i -= 1) {
        const leftCode = left.charCodeAt(i);
        const row = i * stride;
        const nextRow = (i + 1) * stride;
        for (let j = m - 1; j >= 0; j -= 1) {
            if (leftCode === right.charCodeAt(j)) {
                dp[row + j] = dp[nextRow + j + 1]! + 1;
            } else {
                const down = dp[nextRow + j]!;
                const across = dp[row + j + 1]!;
                dp[row + j] = down >= across ? down : across;
            }
        }
    }

    const raw: Array<[number, number, string]> = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && left.charCodeAt(i) === right.charCodeAt(j)) {
            i += 1;
            j += 1;
            continue;
        }
        const startI = i;
        const startJ = j;
        while (i < n || j < m) {
            if (i < n && j < m && left.charCodeAt(i) === right.charCodeAt(j)) break;
            if (i < n && (j === m || dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!)) i += 1;
            else j += 1;
        }
        raw.push([prefix + startI, i - startI, right.slice(startJ, j)]);
    }

    const merged: Array<[number, number, string]> = [];
    for (const hunk of raw) {
        const previous = merged[merged.length - 1];
        if (previous) {
            const previousEnd = previous[0] + previous[1];
            const gap = hunk[0] - previousEnd;
            if (gap <= 5) {
                previous[1] += gap + hunk[1];
                previous[2] += base.slice(previousEnd, hunk[0]) + hunk[2];
                continue;
            }
        }
        merged.push([...hunk]);
    }

    const flat: Array<number | string> = [];
    let cursor = 0;
    for (const [start, del, ins] of merged) {
        flat.push(start - cursor, del, ins);
        cursor = start + del;
    }
    return flat;
}

/** 为繁體中文旧文案构建 100% 离线可逆的字符映射 + 短语规则 + 最小编辑补丁编码。 */
function encodeTraditionalChineseLegacyText(legacyText: MessageCatalog): CompactLegacyTextCodec {
    const entries = Object.entries(legacyText);
    const charSubs = new Map<string, Map<string, number>>();
    const charSame = new Map<string, number>();

    for (const [source, target] of entries) {
        const hunks = diffLegacyHunks(source, target);
        let cursor = 0;
        for (let i = 0; i < hunks.length; i += 3) {
            const skip = hunks[i] as number;
            const del = hunks[i + 1] as number;
            const ins = hunks[i + 2] as string;
            for (let pos = cursor; pos < cursor + skip; pos += 1) {
                const ch = source[pos]!;
                charSame.set(ch, (charSame.get(ch) ?? 0) + 1);
            }
            if (del === ins.length) {
                for (let offset = 0; offset < del; offset += 1) {
                    const s = source[cursor + skip + offset]!;
                    const t = ins[offset]!;
                    if (!isBmpSingleChar(s.charCodeAt(0)) || !isBmpSingleChar(t.charCodeAt(0))) continue;
                    if (s === t) {
                        charSame.set(s, (charSame.get(s) ?? 0) + 1);
                    } else {
                        let targets = charSubs.get(s);
                        if (!targets) {
                            targets = new Map();
                            charSubs.set(s, targets);
                        }
                        targets.set(t, (targets.get(t) ?? 0) + 1);
                    }
                }
            }
            cursor += skip + del;
        }
        for (let pos = cursor; pos < source.length; pos += 1) {
            const ch = source[pos]!;
            charSame.set(ch, (charSame.get(ch) ?? 0) + 1);
        }
    }

    const charTable = new Map<string, string>();
    const charPairs: Array<[string, string]> = [];
    for (const [sourceChar, targets] of charSubs) {
        let bestTarget = '';
        let bestCount = 0;
        for (const [targetChar, count] of targets) {
            if (count > bestCount || (count === bestCount && targetChar < bestTarget)) {
                bestTarget = targetChar;
                bestCount = count;
            }
        }
        if (bestCount > (charSame.get(sourceChar) ?? 0)) {
            charTable.set(sourceChar, bestTarget);
            charPairs.push([sourceChar, bestTarget]);
        }
    }
    charPairs.sort(([a], [b]) => (a < b ? -1 : 1));
    const charMap: [string, string] = [
        charPairs.map(([from]) => from).join(''),
        charPairs.map(([, to]) => to).join(''),
    ];

    let predicted = entries.map(([source]) => {
        let out = '';
        for (let i = 0; i < source.length; i += 1) {
            const ch = source[i]!;
            out += charTable.get(ch) ?? ch;
        }
        return out;
    });

    const phraseCounts = new Map<string, number>();
    for (let idx = 0; idx < entries.length; idx += 1) {
        const pred = predicted[idx]!;
        const target = entries[idx]![1];
        if (pred === target) continue;
        const hunks = diffLegacyHunks(pred, target);
        let cursor = 0;
        for (let i = 0; i < hunks.length; i += 3) {
            const skip = hunks[i] as number;
            const del = hunks[i + 1] as number;
            const ins = hunks[i + 2] as string;
            const pos = cursor + skip;
            if (del >= 2 && del <= 6 && ins.length <= 6) {
                const pair = `${pred.slice(pos, pos + del)}\0${ins}`;
                phraseCounts.set(pair, (phraseCounts.get(pair) ?? 0) + 1);
            }
            if (del === 1 && ins.length >= 1 && ins.length <= 3) {
                if (pos > 0) {
                    const pair = `${pred.slice(pos - 1, pos + 1)}\0${pred[pos - 1]}${ins}`;
                    phraseCounts.set(pair, (phraseCounts.get(pair) ?? 0) + 1);
                }
                if (pos + 1 < pred.length) {
                    const pair = `${pred.slice(pos, pos + 2)}\0${ins}${pred[pos + 1]}`;
                    phraseCounts.set(pair, (phraseCounts.get(pair) ?? 0) + 1);
                }
            }
            cursor = pos + del;
        }
    }

    const candidates = [...phraseCounts.entries()]
        .filter(([, count]) => count >= 5)
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
        .map(([pair]) => pair.split('\0') as [string, string]);

    const phrases: Array<[string, string]> = [];
    for (const [from, to] of candidates) {
        let savedBytes = -(Buffer.byteLength(from) + Buffer.byteLength(to) + 7);
        for (let idx = 0; idx < entries.length; idx += 1) {
            const current = predicted[idx]!;
            if (!current.includes(from)) continue;
            const target = entries[idx]![1];
            const next = current.split(from).join(to);
            const beforeCost = current === target ? 0 : Buffer.byteLength(JSON.stringify(diffLegacyHunks(current, target))) + 2;
            const afterCost = next === target ? 0 : Buffer.byteLength(JSON.stringify(diffLegacyHunks(next, target))) + 2;
            savedBytes += beforeCost - afterCost;
        }
        if (savedBytes > 20) {
            phrases.push([from, to]);
            predicted = predicted.map(current => (current.includes(from) ? current.split(from).join(to) : current));
        }
    }

    const auto: string[] = [];
    const patch: Record<string, LegacyTextPatch> = {};
    for (let idx = 0; idx < entries.length; idx += 1) {
        const [source, target] = entries[idx]!;
        const pred = predicted[idx]!;
        if (pred === target) {
            auto.push(source);
        } else {
            const hunks = diffLegacyHunks(pred, target);
            patch[source] = JSON.stringify(hunks).length < JSON.stringify(target).length ? hunks : target;
        }
    }
    return {charMap, phrases, auto, patch};
}

function assertExactBundleEquality(language: string, expected: UiLanguageBundle, actual: UiLanguageBundle): void {
    const checkCatalog = (kind: string, expectedMap: MessageCatalog, actualMap: MessageCatalog) => {
        const expectedKeys = Object.keys(expectedMap);
        const actualKeys = Object.keys(actualMap);
        if (expectedKeys.length !== actualKeys.length) {
            throw new Error(`Compact i18n ${language}.${kind} key count mismatch: expected ${expectedKeys.length}, got ${actualKeys.length}`);
        }
        for (const key of expectedKeys) {
            if (!Object.hasOwn(actualMap, key) || actualMap[key] !== expectedMap[key]) {
                throw new Error(`Compact i18n ${language}.${kind} mismatch on key "${key}"`);
            }
        }
    };
    checkCatalog('messages', expected.messages, actual.messages);
    checkCatalog('legacyText', expected.legacyText, actual.legacyText);
    if (JSON.stringify(expected.legacyPatterns) !== JSON.stringify(actual.legacyPatterns)) {
        throw new Error(`Compact i18n ${language}.legacyPatterns mismatch`);
    }
}

function encodeOfflineCompactBundle(language: string, full: UiLanguageBundle): CompactUiLanguageBundle {
    const compact: CompactUiLanguageBundle = language === 'zh-TW'
        ? {
            format: 'compact-v1',
            messages: nestMessageCatalog(full.messages),
            legacyCodec: encodeTraditionalChineseLegacyText(full.legacyText),
            legacyPatterns: full.legacyPatterns,
        }
        : {
            format: 'compact-v1',
            messages: nestMessageCatalog(full.messages),
            legacyText: full.legacyText,
            legacyPatterns: full.legacyPatterns,
        };
    assertExactBundleEquality(language, full, expandCompactUiLanguageBundle(compact));
    return compact;
}

/** 生成扩展产物中的 i18n/*.json：en-US/zh-TW 输出离线无损 compact-v1，其余五语输出带固定基线摘要的嵌套键 delta-v1 增量文件。 */
export function createExtensionUiLanguageBundleFiles(root: string): Array<{relativeDest: string; contents: string}> {
    return createUiLanguageBundleFiles().map(({relativeDest, contents}) => {
        const language = relativeDest.slice('i18n/'.length, -'.json'.length);
        const full = JSON.parse(contents) as UiLanguageBundle;
        if (!isRemoteDeltaUiLanguage(language)) {
            return {
                relativeDest,
                contents: JSON.stringify(encodeOfflineCompactBundle(language, full)),
            };
        }
        const asset = REMOTE_LANGUAGE_BASE_ASSETS[language];
        const baselineRaw = readFileSync(resolve(root, asset.path));
        const actualSha256 = createHash('sha256').update(baselineRaw).digest('hex');
        if (baselineRaw.byteLength !== asset.bytes || actualSha256 !== asset.sha256) {
            throw new Error(`Pinned language base mismatch for ${language}: expected ${asset.bytes}/${asset.sha256}, got ${baselineRaw.byteLength}/${actualSha256}`);
        }
        const baseline = JSON.parse(baselineRaw.toString('utf8')) as UiLanguageBundle;
        const delta = createDeltaUiLanguageBundle(language, full, baseline);
        return {
            relativeDest,
            contents: JSON.stringify({
                ...delta,
                messages: nestMessageCatalog(delta.messages as MessageCatalog),
            }),
        };
    });
}
