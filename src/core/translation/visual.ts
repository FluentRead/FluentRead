/**
 * @file src/core/translation/visual.ts
 *
 * 文件职责：为缺少语义段落边界的大型网页容器选择有界的悬浮翻译文本范围。
 * 主要内容：沿用当前网站规则的精确禁译覆盖，从光标命中的 Text 向前后按节点跳数和字符预算收集局部窗口，保留原始文本偏移，按句子、词边界和视觉间距组合至多 1600 字符的文本块，硬边界不拆开代理对；过滤受保护文本并输出可由渲染层物化的 range。
 * 模块边界：本文件只读取页面 DOM 和布局信息，不改写宿主节点、不读取配置、不调用 provider；临时 wrapper 的创建与恢复由渲染和状态模块负责。
 */

import {
    findTextPointAtPoint,
    getElementTagName,
    isTextInNestedTranslationTooltip,
} from './dom';
import {createTranslationTextProtectionCache, isTranslationTextNodeProtected, normalizeTranslationText} from './text';
import type {TranslationCandidate, TranslationTextRange} from './types';
import type {TranslationTextProtectionOptions} from './dom';

const HOVER_REFINEMENT_THRESHOLD = 4096;
const HOVER_CHUNK_LIMIT = 1600;
const HOVER_DISCOVERY_CHARACTER_LIMIT = 16_384;
const HOVER_DISCOVERY_SIDE_STEPS = 1024;
const HOVER_SENTENCE_LIMIT = 256;

const semanticBoundaryTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li',
    'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'tr', 'ul',
]);

interface TextEntry {
    node: Text;
    nodeOffset: number;
    value: string;
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

// UTF-16 偏移对应 DOM Range；只在硬边界落到代理对中间时向外或向内对齐。
const surrogatePair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
function alignTextOffset(value: string, offset: number, roundUp: boolean): number {
    return surrogatePair.test(value.slice(offset - 1, offset + 1)) ? offset + (roundUp ? 1 : -1) : offset;
}

/** 每次父子或兄弟跳转都消耗预算，空元素和深层回溯同样受限；不枚举整个子树。 */
function* neighbouringNodes(anchor: Node, owner: HTMLElement, backwards: boolean): Generator<Node, boolean> {
    let current = anchor;
    let remaining = HOVER_DISCOVERY_SIDE_STEPS;
    while (remaining-- > 0) {
        if (backwards) {
            if (current.previousSibling) {
                current = current.previousSibling;
                while (current.lastChild && --remaining > 0) current = current.lastChild;
            } else current = current.parentNode!;
            if (current === owner) return true;
        } else if (current.firstChild) current = current.firstChild;
        else {
            while (current !== owner && !current.nextSibling && --remaining > 0) current = current.parentNode!;
            if (current === owner) return true;
            if (remaining <= 0) return false;
            current = current.nextSibling!;
        }
        yield current;
    }
    return false;
}

function collectTextEntries(
    owner: HTMLElement,
    anchor: Text,
    pointOffset: number,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionOptions?: TranslationTextProtectionOptions,
): {entries: TextEntry[]; caret: number; anchorRange: SentenceRange; cropped: boolean} | null {
    const protectionCache = createTranslationTextProtectionCache();
    const readable = (node: Text) => !isTextInNestedTranslationTooltip(node, owner) &&
        !isTranslationTextNodeProtected(node, shouldStayOriginal, undefined, protectionOptions, protectionCache);
    if (!readable(anchor)) return null;
    const anchorText = anchor.data;
    if (!anchorText) return null;
    const caretInNode = Math.max(0, Math.min(pointOffset, anchorText.length));
    const nodeOffset = anchorText.length <= HOVER_DISCOVERY_CHARACTER_LIMIT ? 0 : alignTextOffset(
        anchorText, Math.max(0, Math.min(caretInNode - HOVER_DISCOVERY_CHARACTER_LIMIT / 2,
            anchorText.length - HOVER_DISCOVERY_CHARACTER_LIMIT)), true,
    );
    const anchorEnd = alignTextOffset(anchorText, Math.min(anchorText.length,
        nodeOffset + HOVER_DISCOVERY_CHARACTER_LIMIT), false);
    const anchorEntry = {node: anchor, nodeOffset, value: anchorText.slice(nodeOffset, anchorEnd)};
    let characters = anchorEntry.value.length;
    let cropped = characters < anchorText.length;
    const sideEntries = (backwards: boolean, limit: number) => {
        const result: Array<Omit<TextEntry, 'start' | 'end'>> = [];
        const cursor = neighbouringNodes(anchor, owner, backwards);
        let step = cursor.next();
        for (; !step.done; step = cursor.next()) {
            if (limit <= 0) break;
            const node = step.value;
            if (node.nodeType !== 3 || !readable(node as Text)) continue;
            const text = node as Text;
            const value = text.data;
            const start = backwards ? alignTextOffset(value, Math.max(0, value.length - limit), true) : 0;
            const end = backwards ? value.length : alignTextOffset(value, Math.min(value.length, limit), false);
            const selected = value.slice(start, end);
            if (!selected) continue;
            if (selected.length < value.length) cropped = true;
            result.push({node: text, nodeOffset: start, value: selected});
            limit -= selected.length; characters += selected.length;
        }
        if (!step.done || !step.value) cropped = true;
        return backwards ? result.reverse() : result;
    };
    const before = sideEntries(true, Math.min(HOVER_DISCOVERY_CHARACTER_LIMIT / 2,
        HOVER_DISCOVERY_CHARACTER_LIMIT - characters));
    const beforeLength = characters - anchorEntry.value.length;
    const after = sideEntries(false, HOVER_DISCOVERY_CHARACTER_LIMIT - characters);
    const entries: TextEntry[] = [];
    let offset = 0;
    for (const entry of [...before, anchorEntry, ...after]) {
        entries.push({...entry, start: offset, end: offset + entry.value.length});
        offset += entry.value.length;
    }
    return {entries, caret: beforeLength + caretInNode - nodeOffset, cropped,
        anchorRange: {start: beforeLength, end: beforeLength + anchorEntry.value.length}};
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
        // 正则命中至少一个句末标点，截取范围必定包含非空白字符。
        ranges.push({start, end});
        start = end;
    }
    if (start < text.length && normalizeTranslationText(text.slice(start))) {
        ranges.push({start, end: text.length});
    }
    return ranges.length > 0 ? ranges : [{start: 0, end: text.length}];
}

function splitLongSentence(text: string, sentence: SentenceRange, caret: number, anchorRange: SentenceRange): SentenceRange {
    if (sentence.end - sentence.start <= HOVER_CHUNK_LIMIT) return sentence;
    // 长句优先在足够长的命中 Text 内构造上下文；短行内格式节点仍可拼成完整语义片段。
    const anchorStart = Math.max(sentence.start, anchorRange.start);
    const anchorEnd = Math.min(sentence.end, anchorRange.end);
    if (anchorRange.end - anchorRange.start >= HOVER_CHUNK_LIMIT && anchorStart < anchorEnd) {
        sentence = {start: anchorStart, end: anchorEnd};
    }
    const value = text.slice(sentence.start, sentence.end);
    const wordBoundaries: number[] = [0];
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
                if (end > wordBoundaries.at(-1)! && end < value.length) wordBoundaries.push(end);
            }
        }
    } catch {
        // Character boundaries below remain deterministic and safe.
    }
    wordBoundaries.push(value.length);
    const boundaries = [0];
    let wordIndex = 1;
    while (boundaries.at(-1)! < value.length) {
        const start = boundaries.at(-1)!;
        const limit = alignTextOffset(value, Math.min(value.length, start + HOVER_CHUNK_LIMIT), false);
        while (wordIndex < wordBoundaries.length && wordBoundaries[wordIndex]! <= limit) wordIndex++;
        const wordEnd = wordBoundaries[wordIndex - 1]!;
        boundaries.push(wordEnd > start ? wordEnd : limit);
    }

    const absoluteCaret = Math.max(sentence.start, Math.min(caret, sentence.end));
    const caretInValue = absoluteCaret - sentence.start;
    let selectedStart = 0;
    let selectedEnd = value.length;
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
        if (caretInValue < boundaries[index + 1]! || index + 2 === boundaries.length) {
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
    following: boolean,
): {node: Text; offset: number} {
    const clamped = Math.max(0, Math.min(offset, entries.at(-1)!.end));
    let selected = entries.at(-1)!;
    for (const entry of entries) {
        if (clamped > entry.end || (following && clamped === entry.end)) continue;
        selected = entry;
        break;
    }
    return {node: selected.node, offset: selected.nodeOffset + Math.max(0, Math.min(clamped - selected.start, selected.value.length))};
}

/** 句子与选区都是非空区间；这里只处理 Range 能力缺失或边界被宿主拒绝的情况。 */
function createRange(
    owner: HTMLElement,
    entries: readonly TextEntry[],
    start: number,
    end: number,
): Range | null {
    const startBoundary = offsetToBoundary(entries, start, true);
    const endBoundary = offsetToBoundary(entries, end, false);
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
            ? entry.value.slice(overlapStart - entry.start, overlapEnd - entry.start)
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
    const containing = ranges.findIndex((range) => offset >= range.start && offset < range.end);
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
    protectionOptions?: TranslationTextProtectionOptions,
): VisualTranslationRangeResult | null {
    if (!isRefinableCandidate(candidate)) return null;
    const owner = candidate.element;
    const point = findTextPointAtPoint(root, x, y);
    if (!point || point.node.nodeType !== 3 || !owner.contains(point.node)) return null;
    const collected = collectTextEntries(owner, point.node as Text, point.offset, shouldStayOriginal, protectionOptions);
    if (!collected) return null;
    const {entries, caret, anchorRange, cropped} = collected;
    const text = entries.map((entry) => entry.value).join('');
    if (text.length <= HOVER_REFINEMENT_THRESHOLD && !cropped) return null;
    const allSentences = segmentSentences(text);
    const allSelectedIndex = sentenceIndexAt(allSentences, caret);
    const windowStart = Math.max(0, Math.min(
        allSelectedIndex - Math.floor(HOVER_SENTENCE_LIMIT / 2),
        Math.max(0, allSentences.length - HOVER_SENTENCE_LIMIT),
    ));
    const sentences = allSentences.slice(windowStart, windowStart + HOVER_SENTENCE_LIMIT);

    const selectedIndex = allSelectedIndex - windowStart;
    let selected = splitLongSentence(text, sentences[selectedIndex]!, caret, anchorRange);
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
