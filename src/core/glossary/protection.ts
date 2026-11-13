/**
 * @file src/core/glossary/protection.ts
 * 文件职责：把原文命中的术语保护为独立占位符，并在翻译结果中原位填回指定译法。
 * 主要内容：共享词边界与大小写规则，规范写法只用于定位并映射回原文，保留未命中字符与空译法的原始写法；长词优先、重复出现独立编号，避开内部槽标记及调用方指定的语法范围，严格检查丢失、重复和未知占位符；可选观察器报告已经接受的匹配供文档纯算法复用，不再扫描正文。
 * 模块边界：纯文本转换，不接触宿主 DOM、存储或翻译服务；译法按字面填入，不再次参与替换。
 * 字面范围：调用方可提供原文范围保护键帽等不适用词边界的字素；既有术语匹配优先，槽标记和排除范围仍不可覆盖。
 * 嵌套恢复：数学/术语保护后再叠加字素保护时，先精确移除原文已有的完整外层标记，再检查未知片段，避免把紧邻段落结束槽的合法标记误判为损坏。
 */
import {findGlossaryMatches} from './match';
import {sha256Hex} from '@/src/shared/function/sha256';
import {findEmojiLiteralRanges} from '@/src/core/translation/emojiLiterals';

export type GlossaryProtectionEntry = Readonly<{source: string; target: string; caseSensitive: boolean}>;
/** 已接受的匹配；范围以送翻文本的 UTF-16 偏移计，条目保留原对象身份。 */
export interface GlossaryProtectedMatch {
    readonly token: string;
    readonly start: number;
    readonly end: number;
    readonly value: string;
    readonly entry: GlossaryProtectionEntry;
}

export class GlossaryPlaceholderError extends Error {
    readonly code = 'GLOSSARY_PLACEHOLDER_INVALID';
    readonly retryable = false;
    constructor() {
        super('翻译服务未完整保留术语、表情符号等受保护内容，请重试或切换翻译服务');
        this.name = 'GlossaryPlaceholderError';
    }
}

/** 免费池在每条候选线路获胜前验证完整标记；丢失、重复或串入别段标记的结果应换线。 */
export function validateGlossaryProtectedTokens(origin: string, result: unknown, tokens?: readonly string[]): void {
    if (!tokens?.length) return;
    if (typeof result !== 'string' || tokens.some(token => origin.split(token).length !== result.split(token).length)) {
        throw new GlossaryPlaceholderError();
    }
    // 已知完整标记后的英文属于正文；先按精确身份移除，再检查剩余的未知或损坏标记。
    let remainder = result;
    for (const token of tokens) remainder = remainder.replaceAll(token, '');
    if ([...remainder.matchAll(/__FRTERM_[a-z0-9_]+/giu)].some(([token]) => !origin.includes(token))) {
        throw new GlossaryPlaceholderError();
    }
}

/** Unicode NFC 除组合附加符外，仅现代 Hangul L/V/T 可跨字母合成。 */
function composesHangul(cluster: string, character: string): boolean {
    const next = character.charCodeAt(0);
    if (next < 0x1161 || next > 0x11c2) return false;
    const normalized = cluster.normalize('NFC');
    const last = normalized.charCodeAt(normalized.length - 1);
    return (last >= 0x1100 && last <= 0x1112 && next >= 0x1161 && next <= 0x1175)
        || (last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 0 && next >= 0x11a8 && next <= 0x11c2);
}

/** 只为非 NFC 原文建立边界；不可拆开的组合内部没有映射，不能截断并改写半个原字符。 */
function normalizeMatchText(original: string): {text: string; offsets?: (number | undefined)[]} {
    const text = original.normalize('NFC');
    if (text === original) return {text};
    const offsets: (number | undefined)[] = [];
    let cluster = '';
    let start = 0;
    let cursor = 0;
    let normalizedCursor = 0;
    const flush = () => {
        const normalized = cluster.normalize('NFC');
        offsets[normalizedCursor] = start;
        if (normalized === cluster) {
            for (let index = 1; index < cluster.length; index += 1) offsets[normalizedCursor + index] = start + index;
        }
        normalizedCursor += normalized.length;
        offsets[normalizedCursor] = cursor;
        start = cursor;
        cluster = '';
    };
    for (const character of original) {
        if (cluster && !/^\p{M}$/u.test(character) && !composesHangul(cluster, character)) flush();
        cluster += character;
        cursor += character.length;
    }
    flush();
    return {text, offsets};
}

export function protectGlossaryText(
    original: string,
    entries: readonly {source: string; target: string; caseSensitive: boolean}[],
    namespace = '0',
    excludedRanges: readonly {start: number; end: number}[] = [],
    onMatch?: (match: GlossaryProtectedMatch) => void,
    literalRanges: readonly {start: number; end: number}[] = [],
) {
    const text = original;
    let prefix = `__FRTERM_${sha256Hex(namespace + '\0' + text).slice(0, 12)}_`;
    while (text.includes(prefix)) prefix += 'x';
    const values = new Map<string, string>();
    const tokenPieces = new Map<string, number>();
    // 用户译法优先，但只能覆盖完整图形字素；半个肤色/ZWJ 序列保持原样，避免留下孤立修饰符。
    const emojiRanges = entries.length ? findEmojiLiteralRanges(original) : [];
    const emojiInteriors = emojiRanges.length ? new Uint8Array(original.length + 1) : undefined;
    for (const range of emojiRanges) emojiInteriors!.fill(1, range.start + 1, range.end);
    // 槽标记两侧的下划线不属于正文；拆开后短语仍可命中槽的首尾。
    const pieces = text.split(/(___FLUENTREAD_[a-z0-9_-]+?_\d+_(?:BEGIN|END)___)/giu);
    let offset = 0;
    let protectedOffset = 0;
    const protectedText = pieces.map((piece, index) => {
        const pieceOffset = offset;
        offset += piece.length;
        if (index % 2) {protectedOffset += piece.length; return piece;}
        const normalized = normalizeMatchText(piece);
        const occupied = findGlossaryMatches(normalized.text, entries).flatMap(range => {
            const start = normalized.offsets ? normalized.offsets[range.start] : range.start;
            const end = normalized.offsets ? normalized.offsets[range.end] : range.end;
            if (start === undefined || end === undefined) return [];
            if (emojiInteriors?.[pieceOffset + start] || emojiInteriors?.[pieceOffset + end]) return [];
            return [{...range, start, end}];
        });
        let blockedIndex = 0, literalEnd = -1;
        const literals = literalRanges.filter(range => Number.isInteger(range.start) && Number.isInteger(range.end)
            && range.start >= pieceOffset && range.end <= offset && range.start < range.end).sort((a, b) => a.start - b.start)
            .flatMap(range => {
                const start = range.start - pieceOffset, end = range.end - pieceOffset;
                while (occupied[blockedIndex] && occupied[blockedIndex]!.end <= start) blockedIndex++;
                if (start < literalEnd || occupied[blockedIndex] && occupied[blockedIndex]!.start < end) return [];
                literalEnd = end;
                return [{start, end, entry: {source: piece.slice(start, end), target: '', caseSensitive: true}}];
            });
        const matches = literals.length ? [...occupied, ...literals].sort((a, b) => a.start - b.start) : occupied;
        let cursor = 0;
        let output = '';
        for (const range of matches) {
            const {start, end} = range;
            if (excludedRanges.some(range => pieceOffset + start < range.end && range.start < pieceOffset + end)) continue;
            const token = `${prefix}${values.size}__`;
            const value = range.entry.target || piece.slice(start, end);
            values.set(token, value);
            tokenPieces.set(token, index);
            output += piece.slice(cursor, start);
            if (onMatch) {
                const protectedStart = protectedOffset + output.length;
                onMatch({token, start: protectedStart, end: protectedStart + token.length, value, entry: range.entry});
            }
            output += token;
            cursor = end;
        }
        const result = output + piece.slice(cursor);
        protectedOffset += result.length;
        return result;
    }).join('');
    return {
        text: values.size ? protectedText : original,
        tokens: [...values.keys()],
        restore(translated: unknown): string {
            if (typeof translated !== 'string') throw new GlossaryPlaceholderError();
            if (!values.size) return translated;
            const pattern = new RegExp(`${prefix}\\d+__`, 'gu');
            const counts = new Map<string, number>();
            for (const [token] of translated.matchAll(pattern)) counts.set(token, (counts.get(token) ?? 0) + 1);
            if (counts.size !== values.size || [...values.keys()].some(token => counts.get(token) !== 1)) {
                throw new GlossaryPlaceholderError();
            }
            if (pieces.length > 1) {
                const translatedPieces = translated.split(/(___FLUENTREAD_[a-z0-9_-]+?_\d+_(?:BEGIN|END)___)/giu);
                if (pieces.length !== translatedPieces.length
                    || pieces.some((piece, index) => index % 2 && piece !== translatedPieces[index])
                    || [...tokenPieces].some(([token, index]) => !translatedPieces[index].includes(token))) {
                    throw new GlossaryPlaceholderError();
                }
            }
            // 先确认没有损坏的同前缀标记；单次 callback 替换避免 $&、目标中的标记被再次解释。
            let remainder = translated.replace(pattern, '');
            for (const [known] of original.matchAll(/__FRTERM_[a-z0-9_]+?__/giu)) remainder = remainder.replaceAll(known, '');
            if (remainder.includes(prefix) || [...remainder.matchAll(/__FRTERM_[a-z0-9_]+/giu)]
                .some(([token]) => !original.includes(token))) throw new GlossaryPlaceholderError();
            return translated.replace(pattern, token => values.get(token)!);
        },
    };
}
