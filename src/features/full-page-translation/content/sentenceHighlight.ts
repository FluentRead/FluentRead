/**
 * @file src/features/full-page-translation/content/sentenceHighlight.ts
 * 文件职责：在双语段落中定位鼠标下的句子，并同步绘制原文和译文的文字范围。
 * 主要内容：分帧收集文字和不可拆分的行内公式，保留原始偏移；以真实范围和公式位置定位原译句子，较长段落沿用光标索引；离开、选择、滚动、节点变化和卸载时释放范围和公式绘制标记。
 * 模块边界：仅消费 state 登记、renderer 创建的双语容器，不拆分宿主文本或公式、不更改排版、不调用 provider；旧浏览器缺少绘制能力时安全停用。
 */
import {findTextPointAtPoint} from '@/src/core/translation/dom';
import {alignBilingualSentences, type SentenceSpan} from '@/src/core/translation/sentenceAlignment';
import {getTranslationState} from './state';

export const BILINGUAL_HIGHLIGHT_NAME = 'fluentread-bilingual-sentence';
const formulaAttribute = 'data-fr-bilingual-sentence-formula';
const wrapperSelector = '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';
const formulaSelector = 'math, mjx-container, .katex';
const excludedSelector = 'script, style, textarea, input, select, button, svg, math[display="block" i], mjx-container[display="true" i], .katex-display, [hidden], [aria-hidden="true"], [translate="no" i]:not(html, body), [contenteditable]:not([contenteditable="false"]), [data-fr-translation-owned="true"]';
// 文字范围较少时直接检查矩形，省去建立索引和额外的浏览器光标查询。
const minRangesForCaretLookup = 16;
interface TextRun {node: Text | Element; start: number; end: number}
interface TextMap {text: string; runs: TextRun[]}
interface Pair {source: Range[]; translation: Range[]; formulas: Element[]}
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
            let run: Text | Element | undefined;
            if (node.nodeType === 3) {
                run = node as Text;
                text = run.data;
                // 折叠的源码换行不构成句界；等长替换保证分句偏移仍对应原始 DOM Range。
                if (!preservesLineBreaks.has(node.parentElement!)) text = text.replace(/[\r\n]/gu, ' ');
            } else if (node.nodeType === 1) {
                const element = node as Element;
                if (element !== root && element.matches(excludedSelector)) continue;
                const style = root.ownerDocument.defaultView!.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
                if (element.matches(formulaSelector)) {
                    if (/^block(?:\s|$)/u.test(style.display)) continue;
                    // 公式占一个逻辑字符。内部标点和隐藏的渲染副本不参与分句。
                    text = '\uFFFC';
                    run = element;
                } else if (element.tagName === 'BR') text = '\n';
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
            if (run) runs.push({node: run, start: length, end: length + text.length});
            chunks.push(text);
            length += text.length;
        }
        return next ? undefined : {text: chunks.join(''), runs};
    };
}

function rangesFor(map: TextMap, span: SentenceSpan, formulas: Element[]): Range[] {
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
        if (run.node.nodeType === 1) {
            formulas.push(run.node as Element);
            continue;
        }
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

function containsPoint(subject: Range | Element, x: number, y: number): boolean {
    for (const rect of subject.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right &&
            y >= rect.top && y <= rect.bottom) return true;
    }
    return false;
}

/** MathJax/KaTeX 的可视子树和无障碍副本命中同一外层公式。 */
function formulaForHit(target: Element): Element | null {
    let formula = target.closest(formulaSelector);
    while (formula) {
        const outer = formula.parentElement?.closest(formulaSelector);
        if (!outer) break;
        formula = outer;
    }
    return formula;
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
    let indexedFormulas: Map<Element, Pair> | undefined;
    let collecting: {wrapper: Element; source: () => TextMap | null | undefined; sourceMap?: TextMap;
        translation?: () => TextMap | null | undefined} | undefined;
    let active: Pair | undefined;
    let pending: {event: PointerEvent; target: Element | null} | null = null;
    let frame: number | null = null;
    const ownerAncestors: Node[] = [];
    const observer = new view.MutationObserver(records => {
        if (owner && (!owner.isConnected || records.some(record => record.attributeName !== formulaAttribute
            && (owner!.contains(record.target) || ownerAncestors.some(ancestor => record.target.contains(ancestor)))))) clear();
    });
    function unpaint(): void {
        paint.clear();
        for (const formula of active?.formulas ?? []) formula.removeAttribute(formulaAttribute);
        active = undefined;
    }
    function clear(): void {
        observer.disconnect();
        unpaint();
        owner = null;
        ownerWrapper = null;
        ownerAncestors.length = 0;
        pairs = [];
        indexedRanges = undefined;
        indexedFormulas = undefined;
        collecting = undefined;
        pending = null;
        if (frame !== null) view!.cancelAnimationFrame(frame);
        frame = null;
    }
    const flush = (): void => {
        frame = null;
        const point = pending;
        if (!point || point.event.buttons || document.getSelection()?.isCollapsed === false) return clear();
        const {event, target: hit} = point;
        const formula = hit && formulaForHit(hit);
        const next = hit && ownerFor(formula ?? hit);
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
                    pairs = alignBilingualSentences(source.text, translation.text).map(({source: sourceSpan, translation: translationSpan}) => {
                        const formulas: Element[] = [];
                        const pair = {source: rangesFor(source, sourceSpan, formulas), translation: rangesFor(translation, translationSpan, formulas), formulas};
                        for (const element of formulas) (indexedFormulas ??= new Map()).set(element, pair);
                        return pair;
                    });
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
        // 公式命中只能使用它自身的句对，不能借用相邻文字范围。
        const pair = formula
            ? (containsPoint(formula, clientX, clientY) ? indexedFormulas?.get(formula) : undefined)
            : (indexedRanges && pairAtCaret(indexedRanges, hit, clientX, clientY))
                ?? pairs.find(({source, translation}) => source.some(hitsPoint) || translation.some(hitsPoint));
        if (pair !== active) {
            unpaint();
            active = pair;
            if (pair) {
                for (const range of [...pair.source, ...pair.translation]) paint.add(range);
                for (const element of pair.formulas) element.setAttribute(formulaAttribute, 'true');
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
