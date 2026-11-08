/**
 * @file src/features/full-page-translation/content/sentenceHighlight.ts
 * 文件职责：在双语段落中定位鼠标下的句子，并同步绘制原文和译文的文字范围。
 * 主要内容：沿命中节点祖先读取共享状态索引，每次复核双语工件的身份与在位关系；分帧收集文字、保留原始偏移并限制文字量，同一超限段落在失效前不重复收集；较长段落按浏览器光标位置缩小待验证范围，读取实时矩形并使用原生 Highlight 绘制；离开、选择、滚动、节点变化和卸载时取消收集并释放范围与监听器。
 * 模块边界：仅消费 state 登记、renderer 创建的双语容器，不拆分宿主文本、不更改排版、不调用 provider；旧浏览器缺少绘制能力时安全停用。
 */
import {alignBilingualSentences, type SentenceSpan} from '@/src/core/translation/sentenceAlignment';
import {findTextPointAtPoint} from '@/src/core/translation/public';
import {getTranslationState} from './state';

export const BILINGUAL_HIGHLIGHT_NAME = 'fluentread-bilingual-sentence';
const wrapperSelector = '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';
const excludedSelector = 'script, style, textarea, input, select, button, svg, math, mjx-container, .katex, [hidden], [aria-hidden="true"], [translate="no" i]:not(html, body), [contenteditable]:not([contenteditable="false"]), [data-fr-translation-owned="true"]';
// 文字范围较少时直接检查矩形，省去建立索引和额外的浏览器光标查询。
const minRangesForCaretLookup = 16;
interface TextRun {node: Text; start: number; end: number}
interface TextMap {text: string; runs: TextRun[]}
interface Pair {source: Range[]; translation: Range[]}
interface IndexedRange {range: Range; pair: Pair}
type HighlightView = Window & typeof globalThis & {
    Highlight?: new (...ranges: Range[]) => Set<Range>;
    CSS?: {highlights?: Map<string, Set<Range>>};
};

function textCollector(root: Element, maxLength: number): () => TextMap | null | undefined {
    const chunks: string[] = [];
    const runs: TextRun[] = [];
    const siblings: Node[] = [];
    const preservesLineBreaks = new WeakSet<Element>();
    let length = 0;
    let next: Node | undefined = root;
    return () => {
        const started = performance.now();
        // 深层和稀疏段落仍完整收集；每帧限制节点数与时间，不能仅靠末尾字符检查。
        for (let steps = 0; next && steps < 16_384; steps++) {
            if (steps && steps % 64 === 0 && performance.now() - started >= 4) break;
            const node: Node = next;
            if (node !== root && node.nextSibling) siblings.push(node.nextSibling);
            next = siblings.pop();
            let text = '';
            if (node.nodeType === 3) text = (node as Text).data;
            else if (node.nodeType === 1) {
                const element = node as Element;
                if (element !== root && element.matches(excludedSelector)) continue;
                const style = root.ownerDocument.defaultView!.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
                if (element.tagName === 'BR') text = '\n';
                else if (element.firstChild) {
                    const collapse = style.whiteSpaceCollapse;
                    if (collapse ? /^(?:preserve|preserve-breaks|break-spaces)$/u.test(collapse)
                        : /^(?:pre|pre-wrap|pre-line|break-spaces)$/u.test(style.whiteSpace)) {
                        preservesLineBreaks.add(element);
                    }
                    if (next) siblings.push(next);
                    next = element.firstChild;
                }
            }
            if (!text) continue;
            if (text.length > maxLength - length) return null;
            if (node.nodeType === 3) {
                // 折叠的源码换行不构成句界；等长替换保证分句偏移仍对应原始 DOM Range。
                if (!preservesLineBreaks.has(node.parentElement!)) text = text.replace(/[\r\n]/gu, ' ');
                runs.push({node: node as Text, start: length, end: length + text.length});
            }
            chunks.push(text);
            length += text.length;
        }
        return next ? undefined : {text: chunks.join(''), runs};
    };
}

function rangesFor(map: TextMap, span: SentenceSpan): Range[] {
    const ranges: Range[] = [];
    let first = 0;
    let last = map.runs.length;
    while (first < last) {
        const middle = (first + last) >>> 1;
        if (map.runs[middle].end <= span.start) first = middle + 1;
        else last = middle;
    }
    for (let index = first; index < map.runs.length && map.runs[index].start < span.end; index++) {
        const run = map.runs[index];
        const start = Math.max(span.start, run.start);
        const end = Math.min(span.end, run.end);
        const range = run.node.ownerDocument.createRange();
        range.setStart(run.node, start - run.start);
        range.setEnd(run.node, end - run.start);
        ranges.push(range);
    }
    return ranges;
}

/** 同一 Text 节点内的范围按句序递增，可用光标偏移二分定位。 */
function indexRanges(pairs: Pair[]): Map<Node, IndexedRange[]> {
    const index = new Map<Node, IndexedRange[]>();
    for (const pair of pairs) {
        for (const range of [...pair.source, ...pair.translation]) {
            const node = range.startContainer;
            const entries = index.get(node);
            if (entries) entries.push({range, pair});
            else index.set(node, [{range, pair}]);
        }
    }
    return index;
}

function containsPoint(range: Range, x: number, y: number): boolean {
    for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right &&
            y >= rect.top && y <= rect.bottom) return true;
    }
    return false;
}

function pairAtCaret(index: ReadonlyMap<Node, IndexedRange[]>, hit: Element, x: number, y: number): Pair | undefined {
    const point = findTextPointAtPoint(hit.getRootNode() as Document | ShadowRoot, x, y);
    if (!point || !hit.contains(point.node)) return;
    const entries = index.get(point.node);
    if (!entries) return;
    let first = 0;
    let last = entries.length;
    while (first < last) {
        const middle = (first + last) >>> 1;
        if (entries[middle].range.endOffset < point.offset) first = middle + 1;
        else last = middle;
    }
    for (let i = first; i < entries.length && entries[i].range.startOffset <= point.offset; i++) {
        const {range, pair} = entries[i];
        // 光标会吸附到字符边缘或行尾，仍以当前绘制矩形为准。
        if (containsPoint(range, x, y)) return pair;
    }
}

/** 只认真实状态持有的直属工件；DOM 上复制的公开标记不能建立翻译所有权。 */
function ownedBilingualContent(owner: Element): HTMLElement | undefined {
    const state = getTranslationState(owner as HTMLElement);
    if (!state || state.phase !== 'translated' || state.mode !== 'bilingual' || state.kind !== 'content') return;
    const wrapper = state.bilingualContent;
    return wrapper?.parentElement === owner && wrapper.matches(wrapperSelector) ? wrapper : undefined;
}

function ownerFor(target: Element): {owner: Element; wrapper: HTMLElement} | null {
    const translation = target.closest(wrapperSelector);
    if (translation) {
        const owner = translation.parentElement;
        if (!owner || ownedBilingualContent(owner) !== translation) return null;
        return {owner, wrapper: translation as HTMLElement};
    }
    if (target.closest(excludedSelector)) return null;
    for (let owner: Element | null = target; owner; owner = owner.parentElement) {
        const wrapper = ownedBilingualContent(owner);
        if (wrapper) return {owner, wrapper};
    }
    return null;
}

export function installBilingualSentenceHighlight(document: Document): () => void {
    const view = document.defaultView as HighlightView | null;
    const registry = view?.CSS?.highlights;
    if (!view?.Highlight || !registry) return () => undefined;
    const paint = new view.Highlight();
    let owner: Element | null = null;
    let ownerWrapper: HTMLElement | null = null;
    let installed = true;
    let pairs: Pair[] = [];
    let indexedRanges: Map<Node, IndexedRange[]> | undefined;
    let collecting: {wrapper: Element; source: () => TextMap | null | undefined; sourceMap?: TextMap;
        translation?: () => TextMap | null | undefined} | undefined;
    let active: Pair | undefined;
    let pending: {event: PointerEvent; target: Element | null} | null = null;
    let frame: number | null = null;
    const ownerAncestors: Node[] = [];
    const observer = new view.MutationObserver(records => {
        if (owner && (!owner.isConnected || records.some(record => owner!.contains(record.target)
            || ownerAncestors.some(ancestor => record.target.contains(ancestor))))) clear();
    });
    function clear(): void {
        paint.clear();
        active = undefined;
        owner = null;
        ownerWrapper = null;
        ownerAncestors.length = 0;
        pairs = [];
        indexedRanges = undefined;
        collecting = undefined;
        pending = null;
        if (frame !== null) view!.cancelAnimationFrame(frame);
        frame = null;
        observer.disconnect();
    }
    const flush = (): void => {
        frame = null;
        const point = pending;
        if (!point || point.event.buttons || document.getSelection()?.isCollapsed === false) return clear();
        const {event, target: hit} = point;
        const next = hit && ownerFor(hit);
        if (!hit || !next?.owner.isConnected) return clear();
        if (next.owner !== owner || next.wrapper !== ownerWrapper) {
            clear();
            owner = next.owner;
            ownerWrapper = next.wrapper;
            const wrappers = Array.from(owner.children).filter(child => child.matches(wrapperSelector));
            if (wrappers.length !== 1) return clear();
            collecting = {wrapper: ownerWrapper, source: textCollector(owner, 100_000)};
            pending = point;
            // 收集期间也观察，避免跨帧使用已经变更或脱离页面的节点。
            // document 的观察不穿透 Shadow DOM；同时观察每层实际根及其宿主祖先。
            const options = {subtree: true, childList: true, characterData: true, attributes: true};
            let ancestor: Node = owner;
            while (true) {
                ownerAncestors.push(ancestor);
                const root = ancestor.getRootNode();
                observer.observe(root, options);
                if (root === document) break;
                ancestor = (root as ShadowRoot).host;
            }
        }
        if (collecting) {
            const source = collecting.sourceMap ?? collecting.source();
            if (source === undefined) {frame = view.requestAnimationFrame(flush); return;}
            if (source) {
                collecting.sourceMap = source;
                collecting.translation ??= textCollector(collecting.wrapper, 100_000 - source.text.length);
                const translation = collecting.translation();
                if (translation === undefined) {frame = view.requestAnimationFrame(flush); return;}
                if (translation) {
                    pairs = alignBilingualSentences(source.text, translation.text).map(pair => ({
                        source: rangesFor(source, pair.source), translation: rangesFor(translation, pair.translation),
                    }));
                    const rangeCount = pairs.reduce((total, pair) => total + pair.source.length + pair.translation.length, 0);
                    if (rangeCount >= minRangesForCaretLookup) indexedRanges = indexRanges(pairs);
                }
            }
            // 超限时保留当前所有者和观察器，等内容或所有者变化后再尝试。
            collecting = undefined;
        }
        pending = null;
        const {clientX, clientY} = event;
        const hitsPoint = (range: Range) => containsPoint(range, clientX, clientY);
        const pair = (indexedRanges && pairAtCaret(indexedRanges, hit, clientX, clientY))
            ?? pairs.find(({source, translation}) => source.some(hitsPoint) || translation.some(hitsPoint));
        if (pair !== active) {
            paint.clear();
            active = pair;
            if (pair) {
                for (const range of [...pair.source, ...pair.translation]) paint.add(range);
                registry.set(BILINGUAL_HIGHLIGHT_NAME, paint);
            }
        }
    };
    const move = (event: PointerEvent): void => {
        // composedPath 在事件派发后会清空，必须在当前事件内保留真实目标。
        const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
        pending = {event, target: target ?? null};
        if (frame === null) frame = view.requestAnimationFrame(flush);
    };
    const leave = (event: PointerEvent): void => {if (!event.relatedTarget) clear();};
    document.addEventListener('pointermove', move, {passive: true, capture: true});
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('scroll', clear, true);
    document.addEventListener('selectionchange', clear);
    view.addEventListener('blur', clear);
    view.addEventListener('resize', clear);
    view.addEventListener('pagehide', clear);
    return () => {
        if (!installed) return;
        installed = false;
        clear();
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerout', leave, true);
        document.removeEventListener('scroll', clear, true);
        document.removeEventListener('selectionchange', clear);
        view.removeEventListener('blur', clear);
        view.removeEventListener('resize', clear);
        view.removeEventListener('pagehide', clear);
        if (registry.get(BILINGUAL_HIGHLIGHT_NAME) === paint) registry.delete(BILINGUAL_HIGHLIGHT_NAME);
    };
}
