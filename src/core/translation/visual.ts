/**
 * @file src/core/translation/visual.ts
 *
 * 文件职责：为缺少语义段落边界的大型网页容器选择有界的悬浮翻译文本范围。
 * 主要内容：保留光标命中的文本偏移，按句子和视觉间距组合有限文本块，过滤受保护文本，并输出可由渲染层物化的 range。
 * 模块边界：本文件只读取页面 DOM 和布局信息，不改写宿主节点、不读取配置、不调用 provider；临时 wrapper 的创建与恢复由渲染和状态模块负责。
 */

import {
    findTextPointAtPoint,
    getElementTagName,
    isTextInNestedTranslationTooltip,
} from './dom';
import {createTranslationTextProtectionCache, isTranslationTextNodeProtected, normalizeTranslationText} from './text';
import type {TranslationCandidate, TranslationTextRange} from './types';

const HOVER_REFINEMENT_THRESHOLD = 4096;
const HOVER_CHUNK_LIMIT = 1600;
const HOVER_DISCOVERY_CHARACTER_LIMIT = 16_384;
const HOVER_SENTENCE_LIMIT = 256;

const semanticBoundaryTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li',
    'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'tr', 'ul',
]);

interface TextEntry {
    node: Text;
    start: number;
    end: number;
}

interface SentenceRange {
    start: number;
    end: number;
}

interface RectMetrics {
    top: number;
    bottom: number;
    height: number;
}

export interface VisualTranslationRangeResult {
    range: TranslationTextRange;
    sourceText: string;
}

function collectTextEntries(
    owner: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
): TextEntry[] {
    const document = owner.ownerDocument;
    if (!document?.createTreeWalker) return [];
    const entries: TextEntry[] = [];
    const walker = document.createTreeWalker(owner, 4);
    const protectionCache = createTranslationTextProtectionCache();
    let offset = 0;
    let current = walker.nextNode();
    while (current) {
        const node = current as Text;
        if (!isTextInNestedTranslationTooltip(node, owner) &&
            !isTranslationTextNodeProtected(node, shouldStayOriginal, undefined, undefined, protectionCache)) {
            const value = node.data;
            if (value) {
                entries.push({node, start: offset, end: offset + value.length});
                offset += value.length;
            }
        }
        current = walker.nextNode();
    }
    return entries;
}

function segmentSentences(text: string): SentenceRange[] {
    try {
        const Segmenter = (Intl as typeof Intl & {
            Segmenter?: new (locales?: string | string[], options?: {granularity?: string}) => {
                segment(value: string): Iterable<{index: number; segment: string}>;
            };
        }).Segmenter;
        if (Segmenter) {
            const segmenter = new Segmenter(undefined, {granularity: 'sentence'});
            const ranges = Array.from(segmenter.segment(text), ({index, segment}) => ({
                start: index,
                end: index + segment.length,
            }));
            if (ranges.length > 0) return ranges;
        }
    } catch {
        // Fall back to punctuation boundaries when Intl.Segmenter is unavailable.
    }

    const ranges: SentenceRange[] = [];
    let start = 0;
    const boundary = /[.!?。！？]+(?:["'\u2019\u201d)\]]+)?(?:\s+|$)/gu;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(text))) {
        const end = match.index + match[0].length;
        if (normalizeTranslationText(text.slice(start, end))) ranges.push({start, end});
        start = end;
    }
    if (start < text.length && normalizeTranslationText(text.slice(start))) {
        ranges.push({start, end: text.length});
    }
    return ranges.length > 0 ? ranges : [{start: 0, end: text.length}];
}

function splitLongSentence(text: string, sentence: SentenceRange, caret: number): SentenceRange {
    if (sentence.end - sentence.start <= HOVER_CHUNK_LIMIT) return sentence;
    const value = text.slice(sentence.start, sentence.end);
    const boundaries: number[] = [0];
    try {
        const Segmenter = (Intl as typeof Intl & {
            Segmenter?: new (locales?: string | string[], options?: {granularity?: string}) => {
                segment(value: string): Iterable<{index: number; segment: string}>;
            };
        }).Segmenter;
        if (Segmenter) {
            const wordSegmenter = new Segmenter(undefined, {granularity: 'word'});
            for (const item of wordSegmenter.segment(value)) {
                const end = item.index + item.segment.length;
                if (end > boundaries.at(-1)! && end < value.length) boundaries.push(end);
            }
        }
    } catch {
        // Character boundaries below remain deterministic and safe.
    }
    for (let offset = HOVER_CHUNK_LIMIT; offset < value.length; offset += HOVER_CHUNK_LIMIT) {
        if (boundaries.at(-1)! < offset) boundaries.push(offset);
    }
    if (boundaries.at(-1)! !== value.length) boundaries.push(value.length);

    const absoluteCaret = Math.max(sentence.start, Math.min(caret, sentence.end));
    const caretInValue = absoluteCaret - sentence.start;
    let selectedStart = 0;
    let selectedEnd = value.length;
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
        if (caretInValue >= boundaries[index]! && caretInValue <= boundaries[index + 1]!) {
            selectedStart = boundaries[index]!;
            selectedEnd = boundaries[index + 1]!;
            break;
        }
    }
    return {start: sentence.start + selectedStart, end: sentence.start + selectedEnd};
}

/** 调用方只在命中文本条目后使用，因此条目表必然非空。 */
function offsetToBoundary(
    entries: readonly TextEntry[],
    offset: number,
): {node: Text; offset: number} {
    const clamped = Math.max(0, Math.min(offset, entries.at(-1)!.end));
    let selected = entries.at(-1)!;
    for (const entry of entries) {
        if (clamped > entry.end) continue;
        selected = entry;
        break;
    }
    return {node: selected.node, offset: Math.max(0, Math.min(clamped - selected.start, selected.node.data.length))};
}

/** 句子与选区都是非空区间；这里只处理 Range 能力缺失或边界被宿主拒绝的情况。 */
function createRange(
    owner: HTMLElement,
    entries: readonly TextEntry[],
    start: number,
    end: number,
): Range | null {
    const startBoundary = offsetToBoundary(entries, start);
    const endBoundary = offsetToBoundary(entries, end);
    try {
        const range = owner.ownerDocument.createRange();
        if (typeof range.setStart !== 'function' || typeof range.setEnd !== 'function') return null;
        range.setStart(startBoundary.node, startBoundary.offset);
        range.setEnd(endBoundary.node, endBoundary.offset);
        return range;
    } catch {
        return null;
    }
}

function sourceTextForRange(entries: readonly TextEntry[], start: number, end: number): string {
    return normalizeTranslationText(entries.map((entry) => {
        const overlapStart = Math.max(start, entry.start);
        const overlapEnd = Math.min(end, entry.end);
        return overlapStart < overlapEnd
            ? entry.node.data.slice(overlapStart - entry.start, overlapEnd - entry.start)
            : '';
    }).join(''));
}

function rangeMetrics(range: Range): RectMetrics[] {
    try {
        return Array.from(range.getClientRects())
            .map((rect) => ({top: rect.top, bottom: rect.bottom, height: rect.height}))
            .filter((rect) => Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.height > 0)
            .sort((left, right) => left.top - right.top);
    } catch {
        return [];
    }
}

/**
 * 句子分段连续覆盖全文（Intl.Segmenter 与标点回退都会把尾随空白并入前一句），
 * 相邻句之间没有可供判断的空行文本，只能依据实际行盒间距识别视觉段落。
 */
function hasVisualBreak(
    previousMetrics: readonly RectMetrics[],
    nextMetrics: readonly RectMetrics[],
): boolean {
    const previousRect = previousMetrics.at(-1);
    const nextRect = nextMetrics[0];
    if (!previousRect || !nextRect) return false;
    return nextRect.top - previousRect.bottom > Math.max(8, previousRect.height * 1.6);
}

function sentenceIndexAt(ranges: readonly SentenceRange[], offset: number): number {
    const containing = ranges.findIndex((range) => offset >= range.start && offset <= range.end);
    if (containing >= 0) return containing;
    const following = ranges.findIndex((range) => range.start > offset);
    return following >= 0 ? following : Math.max(0, ranges.length - 1);
}

function isRefinableCandidate(candidate: TranslationCandidate): boolean {
    if (candidate.kind !== 'content' || candidate.nodes?.length || candidate.reason !== 'generic-readable-block') return false;
    return !semanticBoundaryTags.has(getElementTagName(candidate.element));
}

/** Find a bounded sentence/visual paragraph range for an oversized hover target. */
export function resolveVisualTranslationRange(
    candidate: TranslationCandidate,
    root: Document | ShadowRoot,
    x: number,
    y: number,
    shouldStayOriginal?: (element: Element) => boolean,
): VisualTranslationRangeResult | null {
    if (!isRefinableCandidate(candidate)) return null;
    const owner = candidate.element;
    const entries = collectTextEntries(owner, shouldStayOriginal);
    const text = entries.map((entry) => entry.node.data).join('');
    if (text.length <= HOVER_REFINEMENT_THRESHOLD || text.length > HOVER_DISCOVERY_CHARACTER_LIMIT) return null;

    const point = findTextPointAtPoint(root, x, y);
    // 条目只包含可译 Text；命中元素或受保护文本时自然找不到对应条目。
    const pointedEntry = point ? entries.find((entry) => entry.node === point.node) : undefined;
    if (!point || !pointedEntry) return null;
    const caret = pointedEntry.start + Math.max(0, Math.min(point.offset, pointedEntry.node.length));
    const allSentences = segmentSentences(text);
    const allSelectedIndex = sentenceIndexAt(allSentences, caret);
    const windowStart = Math.max(0, Math.min(
        allSelectedIndex - Math.floor(HOVER_SENTENCE_LIMIT / 2),
        Math.max(0, allSentences.length - HOVER_SENTENCE_LIMIT),
    ));
    const sentences = allSentences.slice(windowStart, windowStart + HOVER_SENTENCE_LIMIT);

    const selectedIndex = allSelectedIndex - windowStart;
    let selected = splitLongSentence(text, sentences[selectedIndex]!, caret);
    const metrics = new Map<number, RectMetrics[]>();
    const getMetrics = (index: number): RectMetrics[] => {
        const cached = metrics.get(index);
        if (cached) return cached;
        const range = createRange(owner, entries, sentences[index]!.start, sentences[index]!.end);
        const value = range ? rangeMetrics(range) : [];
        metrics.set(index, value);
        return value;
    };

    // Grow within the same visual paragraph, keeping requests bounded and centered on the hit.
    let startIndex = selectedIndex;
    let endIndex = selectedIndex;
    let totalLength = selected.end - selected.start;
    while (startIndex > 0 && totalLength < HOVER_CHUNK_LIMIT) {
        const previous = sentences[startIndex - 1]!;
        if (hasVisualBreak(getMetrics(startIndex - 1), getMetrics(startIndex))) break;
        if (selected.end - previous.start > HOVER_CHUNK_LIMIT) break;
        startIndex -= 1;
        selected = {start: sentences[startIndex]!.start, end: selected.end};
        totalLength = selected.end - selected.start;
    }
    while (endIndex + 1 < sentences.length && totalLength < HOVER_CHUNK_LIMIT) {
        const next = sentences[endIndex + 1]!;
        if (hasVisualBreak(getMetrics(endIndex), getMetrics(endIndex + 1))) break;
        if (next.end - selected.start > HOVER_CHUNK_LIMIT) break;
        endIndex += 1;
        selected = {start: selected.start, end: sentences[endIndex]!.end};
        totalLength = selected.end - selected.start;
    }

    const range = createRange(owner, entries, selected.start, selected.end);
    if (!range) return null;
    const sourceText = sourceTextForRange(entries, selected.start, selected.end);
    if (!sourceText) return null;
    return {
        range: {
            startContainer: range.startContainer as Text,
            startOffset: range.startOffset,
            endContainer: range.endContainer as Text,
            endOffset: range.endOffset,
        },
        sourceText,
    };
}
