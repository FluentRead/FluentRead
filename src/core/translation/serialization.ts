/**
 * @file src/core/translation/serialization.ts
 *
 * 文件职责：把候选 DOM 安全序列化为可翻译文本槽，并在异步请求后依据源快照恢复到仍然匹配的真实节点。
 * 主要内容：定义 TranslationTextSlot、TranslationSourceSnapshot 与样式覆盖规则，重导出独立的纯文本槽协议，负责活节点收集（排除候选内的独立 tooltip）、译文写入克隆、可无损拍平骨架的整段原文重建与整块译文纯文本降级、隐藏/编辑/宿主 metadata 省略、链接实际颜色与可见公式骨架保全、译文产物过滤，以及支持同批样式/几何读数复用，识别 line-clamp 与溢出截断并提供临时解除截断的样式覆盖规则。 可核对的公开符号包括 TranslationTextSlot、TranslationSourceSnapshot、SerializedTranslationSlots、TranslationStyleOverride、translationTruncationStyleOverrides、serializeTranslationSlots、parseTranslationSlots、createTranslationSourceSnapshot、buildWholeBlockTranslationSource。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {createTranslationTextProtectionCache, isIdentifierLikeText, isTranslationTextNodeProtected, normalizeTranslationText} from './text';
import type {TranslationTextProtectionCache} from './text';
import type {TranslationLayoutMeasurements, TranslationLayoutStyle} from './layoutMeasurements';
import {
    hasContentEditableMarker,
    isForeignTranslationBoundary,
    isHardPruneTag,
    isHiddenTranslationElement,
    isIconFontElement,
    isTextInNestedTranslationTooltip,
    isTranslationTooltip,
} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {cloneTranslationElementInert} from './inertClone';

const translationArtifactSelector = [
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '[data-fr-translation-owned="true"]',
].join(',');

// 与 renderer 的本地公式白名单保持一致；内部 aria-hidden 常指可视排版副本，
// 交给公式净化器去掉辅助 MathML/TeX，不能按普通隐藏正文逐节点丢弃。
const sourceFormulaSelector = 'math, mjx-container, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .katex, .mwe-math-element, .ltx_Math';

export interface TranslationTextSlot {
    node: Text;
    prefix: string;
    suffix: string;
    source: string;
}

export interface TranslationSourceSnapshot {
    clone: HTMLElement;
    slots: TranslationTextSlot[];
}

export {serializeTranslationSlots, parseTranslationSlots, type SerializedTranslationSlots} from './slotProtocol';

export interface TranslationStyleOverride {
    property: string;
    value: string;
    priority: string;
}

export const translationTruncationStyleOverrides: readonly TranslationStyleOverride[] = [
    {property: '-webkit-line-clamp', value: 'unset', priority: 'important'},
    {property: 'line-clamp', value: 'unset', priority: 'important'},
    {property: 'max-height', value: 'unset', priority: 'important'},
];

/** 固定高度且内容向外溢出的自然流容器需要暂时恢复为内容高度。 */
export const translationHeightStyleOverrides: readonly TranslationStyleOverride[] = [
    {property: 'height', value: 'auto', priority: 'important'},
];


const naturalFlowDisplays = new Set([
    'block', 'flow-root', 'flex', 'grid', 'inline-block', 'inline-flex', 'inline-grid',
]);

function getLayoutStyle(element: HTMLElement, measurements?: TranslationLayoutMeasurements): TranslationLayoutStyle | undefined {
    if (measurements) return measurements.style(element);
    try {
        return element.ownerDocument?.defaultView?.getComputedStyle(element);
    } catch {
        return undefined;
    }
}

function isPositionedStyle(style: TranslationLayoutStyle): boolean {
    const position = String(style.position || '').trim().toLowerCase();
    if (['absolute', 'fixed', 'sticky'].includes(position)) return true;
    // 独立变换不合并进 computed transform；视觉位移不能作为自然流扩高的依据。
    for (const property of ['transform', 'translate', 'rotate', 'scale'] as const) {
        const value = String(style[property] || '').trim().toLowerCase();
        if (value !== '' && value !== 'none') return true;
    }
    return false;
}

function isHeightBoundaryStyle(element: HTMLElement, style: TranslationLayoutStyle): boolean {
    if (element === element.ownerDocument?.documentElement || element === element.ownerDocument?.body) return true;
    const overflowY = String(style.overflowY || style.overflow || '').trim().toLowerCase();
    return ['auto', 'scroll'].includes(overflowY) || isPositionedStyle(style);
}

/** 不向文档表面、滚动容器或脱离自然流的定位边界扩展固定高度。 */
export function isTranslationHeightBoundary(element: HTMLElement, measurements?: TranslationLayoutMeasurements): boolean {
    const style = getLayoutStyle(element, measurements);
    return !style || isHeightBoundaryStyle(element, style);
}

function hasGeometryOverflow(element: HTMLElement, branch: HTMLElement, measurements?: TranslationLayoutMeasurements): boolean {
    try {
        const elementRect = measurements ? measurements.rect(element) : element.getBoundingClientRect();
        const branchRect = measurements ? measurements.rect(branch) : branch.getBoundingClientRect();
        if (!elementRect || !branchRect) return false;
        return branchRect.top < elementRect.top - 1 || branchRect.bottom > elementRect.bottom + 1;
    } catch {
        return false;
    }
}

/**
 * 判定固定高度自然流容器是否因翻译分支实际变高而需要扩高。
 * branch 必须是通向翻译 owner 的直接 composed 子元素；定位/变换分支不作为依据。
 */
export function hasTranslationHeightOverflow(element: HTMLElement, branch: HTMLElement, measurements?: TranslationLayoutMeasurements): boolean {
    // 每个候选的布局复核都会走到这里；同一元素只取一次计算样式，
    // 避免为 boundary、branch 和高度判定重复触发三次样式重算。
    const style = getLayoutStyle(element, measurements);
    if (!style || isHeightBoundaryStyle(element, style)) return false;
    const branchStyle = element === branch ? style : getLayoutStyle(branch, measurements);
    if (!branchStyle || isPositionedStyle(branchStyle)) return false;
    const overflowY = String(style.overflowY || style.overflow || '').trim().toLowerCase();
    if (['hidden', 'clip'].includes(overflowY)) return false;
    const height = Number.parseFloat(String(style.height || ''));
    const display = String(style.display || '').trim().toLowerCase();
    if (!Number.isFinite(height) || height <= 0 || !naturalFlowDisplays.has(display)) return false;
    try {
        if (element === branch && element.scrollHeight > element.clientHeight + 1) return true;
    } catch {
        // 某些测试/宿主 DOM 没有完整 layout API，继续使用几何检查。
    }
    return hasGeometryOverflow(element, branch, measurements);
}

type TranslationTextSlotParts = Omit<TranslationTextSlot, 'node'>;

function translationTextSlotParts(
    node: Text,
    shouldStayOriginal: ((element: Element) => boolean) | undefined,
    ignoredExtensionElement: Element | undefined,
    protectionOptions: TranslationTextProtectionOptions | undefined,
    protectionCache: TranslationTextProtectionCache,
): TranslationTextSlotParts | null {
    const value = node.nodeValue ?? '';
    // 纯空白会让槽位正则反复回溯；短文本沿用原路径，长文本先用同一 Unicode 空白规则快速排除。
    if (value.length >= 64 && !/\S/u.test(value)) return null;
    const match = value.match(/^(\s*)([\s\S]*?\S)(\s*)$/u);
    if (!match || isTranslationTextNodeProtected(
        node,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
        protectionCache,
    )) return null;
    // 纯网址、域名及其他链接标识符只作为可见骨架保留。把它们逐槽发送给
    // 翻译服务既浪费请求，也会把正常的原样返回误判成翻译失败。
    if (isIdentifierLikeText(match[2]) && node.parentElement?.closest('a[href]')) return null;
    return {prefix: match[1], source: match[2], suffix: match[3]};
}

function collectSlots(
    root: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
    protectionCache = createTranslationTextProtectionCache(),
): TranslationTextSlot[] {
    const slots: TranslationTextSlot[] = [];
    const document = root.ownerDocument;
    if (!document?.createTreeWalker) return slots;
    const walker = document.createTreeWalker(root, 4);
    let current = walker.nextNode();
    while (current) {
        const node = current as Text;
        const parts = translationTextSlotParts(
            node,
            shouldStayOriginal,
            ignoredExtensionElement,
            protectionOptions,
            protectionCache,
        );
        if (parts && !isTextInNestedTranslationTooltip(node, root)) slots.push({node, ...parts});
        current = walker.nextNode();
    }
    return slots;
}

function collectSnapshotSlots(
    liveRoot: HTMLElement,
    cloneRoot: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): TranslationTextSlot[] {
    const document = liveRoot.ownerDocument;
    if (!document?.createTreeWalker) return [];

    // cloneNode(true) 会保留文本节点的文档顺序；同步遍历两棵树可在线性复杂度内
    // 将每个实时槽映射到克隆节点，无需为每个槽重建兄弟索引路径。
    const liveWalker = document.createTreeWalker(liveRoot, 4);
    const cloneWalker = document.createTreeWalker(cloneRoot, 4);
    const slots: TranslationTextSlot[] = [];
    const protectionCache = createTranslationTextProtectionCache();
    let liveNode = liveWalker.nextNode();
    let cloneNode = cloneWalker.nextNode();
    while (liveNode && cloneNode) {
        const parts = translationTextSlotParts(
            liveNode as Text,
            shouldStayOriginal,
            ignoredExtensionElement,
            protectionOptions,
            protectionCache,
        );
        if (parts && !isTextInNestedTranslationTooltip(liveNode, liveRoot)) slots.push({node: cloneNode as Text, ...parts});
        liveNode = liveWalker.nextNode();
        cloneNode = cloneWalker.nextNode();
    }
    return slots;
}

/**
 * 构建本地 DOM 骨架，只暴露可翻译文本槽。因此服务响应永远不能改写链接地址、
 * 行内代码、明确退出翻译的内容、属性或带宿主页事件的节点。
 */
export function createTranslationSourceSnapshot(
    node: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
    shouldOmitFromTranslation?: (element: Element) => boolean,
): TranslationSourceSnapshot {
    const clone = cloneTranslationElementInert(node);
    // 外部译文属于展示产物，不是需要保留的 code/notranslate 原文。连同其已接管
    // 的最小来源单元一起省略，防止 sanitizer 去掉标记后再次展示一份旧译文。
    if (isForeignTranslationBoundary(node)) {
        clone.replaceChildren();
        return {clone, slots: []};
    }
    // 每个槽都依据实时 composed tree 判断。脱离文档的克隆已失去站点选择器、继承
    // contenteditable 和 CSS 可见性规则所需的外部祖先，只能作为映射后的输出骨架。
    const slots = collectSnapshotSlots(
        node,
        clone,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    );
    // 先完成文本槽映射，再依据实时状态裁剪展示副本。仅从 provider 槽排除还不够：
    // sanitizer 会去掉宿主 class/hidden/style，并展开 textarea 等非内联标签，
    // 原本隐藏的辅助文字和编辑内容因此会意外出现在双语译文中。
    const liveElements = node.querySelectorAll('*');
    const clonedElements = clone.querySelectorAll('*');
    const omittedElements = new WeakSet<Element>();
    const formulaElements = new WeakSet<Element>();
    liveElements.forEach((element, index) => {
        const parent = element.parentElement;
        if (parent && omittedElements.has(parent)) {
            omittedElements.add(element);
            return;
        }
        if (parent && formulaElements.has(parent)) {
            formulaElements.add(element);
            return;
        }
        const formula = element.matches(sourceFormulaSelector);
        if (isTranslationTooltip(element) || isForeignTranslationBoundary(element) ||
            isHiddenTranslationElement(element) || hasContentEditableMarker(element) ||
            isIconFontElement(element) || shouldOmitFromTranslation?.(element) ||
            (!formula && isHardPruneTag(element))) {
            clonedElements[index]!.remove();
            omittedElements.add(element);
        } else if (formula) {
            formulaElements.add(element);
        } else if (element.localName === 'a') {
            // 克隆脱离页面后会失去 class、祖先选择器与继承的颜色；在本地骨架上
            // 固化原链接的实际颜色，renderer 只放行这一项，不复制宿主的整段样式。
            try {
                const color = element.ownerDocument.defaultView?.getComputedStyle(element).color;
                if (color) (clonedElements[index] as HTMLElement).style.color = color;
            } catch {
                // 已卸载或受限文档无法读样式时，克隆仍保留来源的内联颜色。
            }
        }
    });
    clone.querySelectorAll(translationArtifactSelector).forEach((child) => child.remove());
    return {clone, slots};
}

/** 传入缓存只可在判定参数相同的同步只读阶段复用；写 DOM 后必须换新。 */
export function collectLiveTranslationTextSlots(
    node: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
    protectionCache?: TranslationTextProtectionCache,
): TranslationTextSlot[] {
    return collectSlots(
        node,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
        protectionCache,
    );
}

/**
 * 整块请求只接受能被纯文本完整表达的骨架：除文本槽和空白外，只允许链接、强调等
 * 不承载独立内容的内联包装与 <br>。行内代码、notranslate 术语、公式、图片、删除线
 * 或块级结构一旦出现，纯文本译文就会吞掉它们，此时必须保留逐槽骨架。
 */
const wholeBlockInlineTags = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'data', 'dfn', 'em', 'font', 'i', 'ins',
    'mark', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr',
]);

/** 上下标只有 [1]、[note 2] 这类脚注标记能并入正文；指数或化学式拍平后会被读错。 */
const wholeBlockFootnoteMarker = /^\[[^[\]]{1,24}\]$/u;

export interface WholeBlockTranslationSourceOptions {
    /** 宿主以 pre、pre-wrap 等方式保留源码换行时，文本里的换行本身就是可见断行。 */
    preserveNewlines?: boolean;
}

/**
 * 为多槽快照重建整段原文，供一次整块请求使用；骨架无法无损拍平时返回 null，
 * 调用方继续逐槽请求。内联包装无缝拼接（Hello <b>world</b>! 仍是 Hello world!），
 * 源码空白折叠为单个空格，<br> 转为换行。只读取脱离文档的克隆，不修改节点。
 */
export function buildWholeBlockTranslationSource(
    snapshot: TranslationSourceSnapshot,
    options: WholeBlockTranslationSourceOptions = {},
): string | null {
    const document = snapshot.clone.ownerDocument;
    if (snapshot.slots.length < 2 || !document?.createTreeWalker) return null;
    const slots = new Map(snapshot.slots.map((slot) => [slot.node, slot] as const));
    // 1 | 4 分别是 SHOW_ELEMENT 与 SHOW_TEXT，避免依赖可能缺失的 NodeFilter 全局。
    const walker = document.createTreeWalker(snapshot.clone, 1 | 4);
    const parts: string[] = [];
    let newlines = 0;
    let space = false;
    const addGap = (whitespace: string) => {
        if (!whitespace) return;
        if (options.preserveNewlines && whitespace.includes('\n')) newlines += whitespace.split('\n').length - 1;
        else space = true;
    };
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current.nodeType === 1) {
            const element = current as Element;
            const tag = element.localName;
            if (tag === 'br') {
                newlines += 1;
                continue;
            }
            if (!wholeBlockInlineTags.has(tag) || element.matches(sourceFormulaSelector)) return null;
            if ((tag === 'sup' || tag === 'sub') &&
                !wholeBlockFootnoteMarker.test(normalizeTranslationText(element.textContent ?? ''))) return null;
            continue;
        }
        const slot = slots.get(current as Text);
        if (!slot) {
            // 非槽位文本只能是排版空白；受保护但仍显示的文字无法写进纯文本译文。
            if (normalizeTranslationText(current.nodeValue ?? '')) return null;
            addGap(current.nodeValue ?? '');
            continue;
        }
        addGap(slot.prefix);
        if (parts.length > 0 && newlines > 0) parts.push('\n'.repeat(newlines));
        else if (parts.length > 0 && space) parts.push(' ');
        newlines = 0;
        space = false;
        parts.push(slot.source.replace(/\s+/gu, (whitespace) =>
            options.preserveNewlines && whitespace.includes('\n') ? '\n' : ' '));
        addGap(slot.suffix);
    }
    return parts.join('');
}

/**
 * 整块译文：整段译文落在首个槽位、其余槽位为空。此时逐槽骨架已不对应任何译文，
 * 直接输出纯译文：否则整段译文会被塞进首个内联元素（链接、加粗）的样式里，并留下
 * 一串空的内联骨架。只有骨架可无损拍平时才降级，含代码、公式等内容的段落即使
 * 其余槽位恰好为空也保留原骨架。空槽判定按“规范化后为空”，以覆盖空格、换行与 &nbsp;。
 */
function isWholeBlockTranslation(snapshot: TranslationSourceSnapshot, translations: readonly string[]): boolean {
    return translations.length === snapshot.slots.length
        && Boolean(normalizeTranslationText(translations[0] ?? ''))
        && translations.slice(1).every((translation) => !normalizeTranslationText(translation))
        && buildWholeBlockTranslationSource(snapshot) !== null;
}

/**
 * 按纯文本写入整块译文，译文中的换行还原为 <br>，其余内联骨架全部移除。
 * 服务返回的首尾换行不对应任何原文断行，先去掉，避免译文前后多出空行。
 */
function renderWholeBlockTranslation(clone: HTMLElement, translation: string): void {
    const document = clone.ownerDocument;
    const nodes: Node[] = [];
    translation.trim().split(/\r?\n/u).forEach((line, index) => {
        if (index > 0) nodes.push(document.createElement('br'));
        if (line) nodes.push(document.createTextNode(line));
    });
    clone.replaceChildren(...nodes);
}

/** 只修改脱离文档的快照文本节点；没有对应译文的槽位保持原文。 */
export function applyTranslationsToSnapshot(
    snapshot: TranslationSourceSnapshot,
    translations: readonly string[],
): string {
    if (isWholeBlockTranslation(snapshot, translations)) {
        renderWholeBlockTranslation(snapshot.clone, translations[0]!);
        return snapshot.clone.innerHTML;
    }
    snapshot.slots.forEach((slot, index) => {
        const translation = translations[index];
        if (translation !== undefined) slot.node.nodeValue = `${slot.prefix}${translation}${slot.suffix}`;
    });
    return snapshot.clone.innerHTML;
}

function isActiveLineClampValue(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized || ['none', 'normal', 'auto', 'unset', 'initial'].includes(normalized)) return false;
    const lineCount = Number.parseFloat(normalized);
    return Number.isFinite(lineCount) && lineCount > 0;
}

export function hasActiveTranslationLineClamp(element: HTMLElement, measurements?: TranslationLayoutMeasurements): boolean {
    try {
        const style = getLayoutStyle(element, measurements);
        if (!style) return false;
        return [
            style.webkitLineClamp,
            style.getPropertyValue('-webkit-line-clamp'),
            style.getPropertyValue('line-clamp'),
        ].some(isActiveLineClampValue);
    } catch {
        return false;
    }
}

export function hasActiveTranslationTruncation(element: HTMLElement, measurements?: TranslationLayoutMeasurements): boolean {
    if (hasActiveTranslationLineClamp(element, measurements)) return true;
    try {
        const style = getLayoutStyle(element, measurements);
        if (!style) return false;
        const maxHeight = style.maxHeight.trim().toLowerCase();
        if (!maxHeight || ['none', 'auto', 'unset', 'initial', 'max-content'].includes(maxHeight)) return false;
        const overflow = (style.overflowY || style.overflow).trim().toLowerCase();
        return ['hidden', 'clip'].includes(overflow) &&
            element.scrollHeight > element.clientHeight + 1;
    } catch {
        return false;
    }
}
