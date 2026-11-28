/**
 * @file src/features/document-translation/ui/richPreviewSync.ts
 * 文件职责：让 HTML、Markdown、纯文本与 ePub 章节的隔离预览在译文逐段到达时原位更新，并提供按片段 ID 的增量 DOM 补丁与滚动目录高亮追踪。
 * 主要内容：支持通过 patchRichPreviewSegments 按 data-segment-id 就地更新已变化的译文节点并切换等待态；提供整页 DOM 差异同步 syncRichPreview、按文档规模调节的节流间隔 richPreviewInterval、标题目录收集与平滑跳转、翻译忙态标记、滚动进度读取，以及基于视口偏移的当前活跃标题定位 findActiveRichHeadingId 与 findActiveRichOutlineIndex。
 * 模块边界：只做安全 DOM 同步与读取，不生成预览 HTML、不发起翻译、不执行脚本也不注入未转义 HTML；预览框不可访问或结构不匹配时返回 false，由上层退回整页同步或重载。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';

interface PreviewFrame {contentDocument?: Document | null}
type PreviewParser = (html: string) => Document | null;

function sameKind(current: Node, next: Node): boolean {
    return current.nodeType === next.nodeType && current.nodeName === next.nodeName;
}

function syncAttributes(current: Element, next: Element): void {
    for (const name of current.getAttributeNames()) if (!next.hasAttribute(name)) current.removeAttribute(name);
    for (const name of next.getAttributeNames()) {
        const value = next.getAttribute(name)!;
        if (current.getAttribute(name) !== value) current.setAttribute(name, value);
    }
}

/** 按位置逐个比对子节点：同类节点就地更新，不同类的整棵替换，多出来的删除。 */
export function syncPreviewChildren(current: Node, next: Node): void {
    const owner = current.ownerDocument!;
    const nextChildren = Array.from(next.childNodes);
    nextChildren.forEach((nextChild, index) => {
        const currentChild = current.childNodes[index];
        if (!currentChild) {current.appendChild(owner.importNode(nextChild, true)); return;}
        if (!sameKind(currentChild, nextChild)) {current.replaceChild(owner.importNode(nextChild, true), currentChild); return;}
        if (currentChild.nodeType === 1) {
            syncAttributes(currentChild as Element, nextChild as Element);
            syncPreviewChildren(currentChild, nextChild);
        } else if (currentChild.nodeValue !== nextChild.nodeValue) currentChild.nodeValue = nextChild.nodeValue;
    });
    while (current.childNodes.length > nextChildren.length) current.removeChild(current.lastChild!);
}

const browserParser: PreviewParser = html => typeof DOMParser === 'undefined' ? null : new DOMParser().parseFromString(html, 'text/html');

/**
 * 把预览框的正文同步为给定 HTML 的正文。预览框尚未载入、不可访问或无法解析时返回 false。
 */
export function syncRichPreview(frame: PreviewFrame | null | undefined, html: string, parse: PreviewParser = browserParser): boolean {
    const body = frame?.contentDocument?.body;
    const next = body ? parse(html)?.body : null;
    if (!body || !next) return false;
    syncAttributes(body, next);
    syncPreviewChildren(body, next);
    return true;
}

export interface RichPreviewSegmentPatch {
    id: number;
    source?: string;
    translation: string;
}

export interface PatchRichPreviewOptions {
    mode: 'source' | 'bilingual' | 'translated';
    format?: 'markdown' | 'txt' | 'html' | 'epub';
}

function setMultilineText(element: Element, text: string): void {
    const doc = element.ownerDocument!;
    while (element.firstChild) element.removeChild(element.firstChild);
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');
    lines.forEach((line, index) => {
        if (index > 0) element.appendChild(doc.createElement('br'));
        element.appendChild(doc.createTextNode(line));
    });
}

const MARKDOWN_INLINE_SIGNAL = /[*_`~[\]$]/u;

type PatchPlan =
    | {
        kind: 'unit';
        target: Element;
        sourceEl: Element | null;
        translationEl: Element | null;
        referenceEl: Element;
        sourceText: string;
        translation: string;
        distinct: boolean;
    }
    | {
        kind: 'inline';
        translationTarget: Element;
        text: string;
    };

/**
 * 按片段 ID 原位补丁更新预览框内已变化的单元，避免长文档每到达几条译文就重建整篇 HTML 并运行 DOMParser。
 * 先全量校验再提交 DOM 写入（原子性），遇到模式变化、节点缺失、任务复选框、多段合并引用或含复杂 Markdown 行内语法时返回 false，交由上层退回 syncRichPreview。
 */
export function patchRichPreviewSegments(
    frame: PreviewFrame | null | undefined,
    updates: readonly RichPreviewSegmentPatch[],
    options: PatchRichPreviewOptions,
): boolean {
    const body = frame?.contentDocument?.body;
    if (!body) return false;
    const article = body.querySelector('article[data-reader-mode]');
    if (article && article.getAttribute('data-reader-mode') !== options.mode) return false;
    if (!article && options.mode !== 'bilingual') return false;
    if ((options.format === 'html' || options.format === 'epub') && options.mode !== 'bilingual') return false;
    if (updates.length === 0) return true;
    const doc = body.ownerDocument!;

    const plans: PatchPlan[] = [];
    for (const update of updates) {
        if (options.format === 'markdown' && MARKDOWN_INLINE_SIGNAL.test(update.translation)) return false;
        const target = body.querySelector(`[data-segment-id="${update.id}"]`);
        if (!target) return false;

        if (target.classList.contains('reader-unit')) {
            if (target.classList.contains('task-item') || target.getAttribute('data-multi-segment') === 'true') return false;
            const sourceEl = target.querySelector(':scope > .reader-source') ?? target.querySelector('.reader-source');
            const translationEl = target.querySelector(':scope > .reader-translation') ?? target.querySelector('.reader-translation');
            const referenceEl = sourceEl ?? translationEl;
            if (!referenceEl) return false;
            const sourceText = update.source ?? sourceEl?.textContent ?? '';
            const distinct = options.mode !== 'source' && hasDistinctTranslation(sourceText, update.translation);
            if (!distinct && !sourceEl && options.format === 'markdown' && MARKDOWN_INLINE_SIGNAL.test(sourceText)) return false;
            plans.push({kind: 'unit', target, sourceEl, translationEl, referenceEl, sourceText, translation: update.translation, distinct});
            continue;
        }

        const translationTarget = target.matches(TRANSLATION) ? target : target.querySelector(TRANSLATION);
        if (!translationTarget) return false;
        const trimmed = update.translation.trim();
        if (!trimmed || (update.source !== undefined && !hasDistinctTranslation(update.source, trimmed))) return false;
        plans.push({kind: 'inline', translationTarget, text: trimmed});
    }

    for (const plan of plans) {
        if (plan.kind === 'inline') {
            setMultilineText(plan.translationTarget, plan.text);
            continue;
        }
        plan.target.classList.toggle('is-pending', options.mode !== 'source' && !plan.distinct);
        const tag = plan.referenceEl.tagName.toLowerCase();
        const headingClass = plan.referenceEl.classList.contains('reader-heading') ? ' reader-heading' : '';
        if (plan.distinct) {
            if (options.mode === 'translated' && plan.sourceEl) plan.sourceEl.remove();
            let nextTranslation = plan.translationEl;
            if (!nextTranslation) {
                nextTranslation = doc.createElement(tag);
                nextTranslation.setAttribute('class', `reader-translation fluentread-translation${headingClass}`);
                plan.target.appendChild(nextTranslation);
            }
            setMultilineText(nextTranslation, plan.translation);
        } else {
            plan.translationEl?.remove();
            if (!plan.sourceEl) {
                const restored = doc.createElement(tag);
                restored.setAttribute('class', `reader-source${headingClass}`);
                setMultilineText(restored, plan.sourceText);
                plan.target.appendChild(restored);
            }
        }
    }

    return true;
}

/** 翻译进行中的刷新间隔：短文档四分之一秒一次，片段越多越慢，最长两秒。 */
export function richPreviewInterval(segmentCount: number): number {
    return Math.min(2000, Math.max(250, Math.round(segmentCount / 8)));
}

export interface RichOutlineItem {
    /** 标题在预览正文全部标题元素中的序号，用于跳转。 */
    index: number;
    level: number;
    source: string;
    /** 该标题的译文；尚未翻译或与原文相同时为空。 */
    translation: string;
}

const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const TRANSLATION = '[data-fluent-read-document-translation="true"],.fluentread-translation';
const headingText = (node: Element) => node.textContent!.replace(/\s+/gu, ' ').trim();

/**
 * 从预览框读出目录。Markdown 预览把译文放在紧随原文标题之后的同级标题里，HTML 与 ePub 把译文放在标题内部；
 * 两种结构都配成“原文 + 译文”一项，只有译文的阅读方式则直接以译文作为标题。
 */
export function collectRichOutline(frame: PreviewFrame | null | undefined): RichOutlineItem[] {
    const body = frame?.contentDocument?.body;
    if (!body) return [];
    const items: RichOutlineItem[] = [];
    let previous: Element | undefined;
    Array.from(body.querySelectorAll(HEADINGS)).forEach((heading, index) => {
        const last = items.at(-1);
        if (last && !last.translation && heading.matches(TRANSLATION) && heading.previousElementSibling === previous) last.translation = headingText(heading);
        else {
            const copy = heading.cloneNode(true) as Element;
            const inner = copy.querySelector(TRANSLATION);
            inner?.remove();
            const source = headingText(copy);
            if (source) items.push({index, level: Number(heading.tagName.slice(1)), source, translation: inner ? headingText(inner) : ''});
        }
        previous = heading;
    });
    return items;
}

function headingViewportTop(heading: Element, scrollTop: number): number {
    if (typeof heading.getBoundingClientRect === 'function') return heading.getBoundingClientRect().top;
    const offsetTop = (heading as Element & {offsetTop?: number}).offsetTop;
    return typeof offsetTop === 'number' ? offsetTop - scrollTop : 0;
}

/** 返回当前视口最接近顶部（含偏移容差）的目录标题序号；无标题或预览不可访问时返回 -1。 */
export function findActiveRichOutlineIndex(frame: PreviewFrame | null | undefined, offset = 80): number {
    const doc = frame?.contentDocument;
    const body = doc?.body;
    if (!body) return -1;
    const outline = collectRichOutline(frame);
    if (outline.length === 0) return -1;
    const headings = body.querySelectorAll(HEADINGS);
    const scrollTop = doc.scrollingElement?.scrollTop ?? 0;
    let activeIndex = outline[0].index;
    for (const item of outline) {
        const heading = headings[item.index];
        if (headingViewportTop(heading, scrollTop) <= offset) activeIndex = item.index;
        else break;
    }
    return activeIndex;
}

/** 返回当前视口活跃标题的 DOM id，无显式 id 时返回 `h${index}`，供侧栏目录高亮。 */
export function findActiveRichHeadingId(frame: PreviewFrame | null | undefined, offset = 80): string | null {
    const activeIndex = findActiveRichOutlineIndex(frame, offset);
    if (activeIndex < 0) return null;
    const heading = frame!.contentDocument!.body!.querySelectorAll(HEADINGS)[activeIndex];
    return heading.getAttribute('id') || `h${activeIndex}`;
}

/** 滚动到目录项对应的标题；预览已经变化、找不到该标题时返回 false。 */
export function scrollRichOutline(frame: PreviewFrame | null | undefined, index: number): boolean {
    const heading = frame?.contentDocument?.body?.querySelectorAll(HEADINGS)[index];
    if (!heading) return false;
    heading.scrollIntoView({block: 'start', behavior: 'smooth'});
    return true;
}

/** 在预览正文上标记翻译是否进行中；同步正文属性之后需要重新标记。 */
export function markRichPreviewBusy(frame: PreviewFrame | null | undefined, busy: boolean): void {
    frame?.contentDocument?.body?.toggleAttribute('data-translating', busy);
}

/** 预览框当前滚动到全文的什么位置（0 到 1）；无法读取时按开头处理。 */
export function richPreviewPosition(frame: PreviewFrame | null | undefined): number {
    const scroller = frame?.contentDocument?.scrollingElement;
    return scroller && scroller.scrollHeight > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / scroller.scrollHeight)) : 0;
}
