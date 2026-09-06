/**
 * @file src/core/translation/serialization.ts
 *
 * 文件职责：把候选 DOM 安全序列化为可翻译文本槽，并在异步请求后依据源快照恢复到仍然匹配的真实节点。
 * 主要内容：定义 TranslationTextSlot、TranslationSourceSnapshot 与样式覆盖规则，负责槽位编码解析、活节点收集（排除候选内的独立 tooltip）、译文写入克隆、宿主 metadata 省略、译文产物过滤，以及查找 line-clamp 祖先并应用临时解除截断的样式。 可核对的公开符号包括 TranslationTextSlot、TranslationSourceSnapshot、SerializedTranslationSlots、TranslationStyleOverride、translationTruncationStyleOverrides、serializeTranslationSlots、parseTranslationSlots、createTranslationSourceSnapshot。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {isTranslationTextNodeProtected} from './text';
import {isIconFontElement, isTextInNestedTranslationTooltip, isTranslationTooltip} from './dom';
import type {TranslationTextProtectionOptions} from './dom';

const translationArtifactSelector = [
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '[data-fr-translation-owned="true"]',
].join(',');

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

export interface SerializedTranslationSlots {
    payload: string;
    starts: readonly string[];
    ends: readonly string[];
}

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

const maxTranslationTruncationAncestorDepth = 16;

function hashSlotSources(sources: readonly string[]): string {
    let hash = 2166136261;
    for (const source of sources) {
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 0xff;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * 将多个纯文本槽编码为一次服务请求。确定性 nonce 使整段缓存 key 保持稳定；
 * 若源文本已包含完全相同的哨兵标记，则追加冲突后缀。
 */
export function serializeTranslationSlots(
    sources: readonly string[],
    requestedNonce = hashSlotSources(sources),
): SerializedTranslationSlots {
    let nonce = requestedNonce.replace(/[^a-z0-9_-]/giu, '') || 'slots';
    let collision = 0;
    const hasCollision = (candidate: string) => sources.some((source, index) =>
        source.includes(`___FLUENTREAD_${candidate}_${index}_BEGIN___`) ||
        source.includes(`___FLUENTREAD_${candidate}_${index}_END___`));
    while (hasCollision(nonce)) {
        collision += 1;
        nonce = `${requestedNonce}_${collision}`.replace(/[^a-z0-9_-]/giu, '');
    }

    const starts = sources.map((_, index) => `___FLUENTREAD_${nonce}_${index}_BEGIN___`);
    const ends = sources.map((_, index) => `___FLUENTREAD_${nonce}_${index}_END___`);
    const payload = sources.map((source, index) => `${starts[index]}${source}${ends[index]}`).join('\n');
    return {payload, starts, ends};
}

/** 严格按顺序为每个槽接受一个结果；标记外出现正文或代码围栏时整包拒绝。 */
export function parseTranslationSlots(
    packet: SerializedTranslationSlots,
    translated: string,
): string[] | null {
    if (packet.starts.length !== packet.ends.length) return null;
    const countMarker = (marker: string): number => {
        let count = 0;
        let offset = 0;
        while (marker && offset <= translated.length - marker.length) {
            const next = translated.indexOf(marker, offset);
            if (next < 0) break;
            count += 1;
            offset = next + marker.length;
        }
        return count;
    };
    if ([...packet.starts, ...packet.ends].some((marker) => !marker || countMarker(marker) !== 1)) {
        return null;
    }
    const results: string[] = [];
    let cursor = 0;
    for (let index = 0; index < packet.starts.length; index += 1) {
        const start = packet.starts[index];
        const end = packet.ends[index];
        if (!start || !end) return null;
        const startIndex = translated.indexOf(start, cursor);
        if (startIndex < 0 || translated.slice(cursor, startIndex).trim()) return null;
        const valueStart = startIndex + start.length;
        const endIndex = translated.indexOf(end, valueStart);
        if (endIndex < 0) return null;
        if (translated.indexOf(start, valueStart) >= 0 && translated.indexOf(start, valueStart) < endIndex) return null;
        results.push(translated.slice(valueStart, endIndex));
        cursor = endIndex + end.length;
    }
    return translated.slice(cursor).trim() ? null : results;
}

type TranslationTextSlotParts = Omit<TranslationTextSlot, 'node'>;

function translationTextSlotParts(
    node: Text,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): TranslationTextSlotParts | null {
    const value = node.nodeValue ?? '';
    const match = value.match(/^(\s*)([\s\S]*?\S)(\s*)$/u);
    if (!match || isTranslationTextNodeProtected(
        node,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    )) return null;
    return {prefix: match[1], source: match[2], suffix: match[3]};
}

function collectSlots(
    root: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
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
    let liveNode = liveWalker.nextNode();
    let cloneNode = cloneWalker.nextNode();
    while (liveNode && cloneNode) {
        const parts = translationTextSlotParts(
            liveNode as Text,
            shouldStayOriginal,
            ignoredExtensionElement,
            protectionOptions,
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
    const clone = node.cloneNode(true) as HTMLElement;
    // 每个槽都依据实时 composed tree 判断。脱离文档的克隆已失去站点选择器、继承
    // contenteditable 和 CSS 可见性规则所需的外部祖先，只能作为映射后的输出骨架。
    const slots = collectSnapshotSlots(
        node,
        clone,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    );
    // 先完成文本槽映射，再依据实时状态移除图标和显式 metadata。译文 sanitizer 不继承
    // 宿主 CSS，保留图标连字会显示 account_circle 等实现文本；原 DOM 和事件完全不动。
    const liveElements = node.querySelectorAll('*');
    const clonedElements = clone.querySelectorAll('*');
    liveElements.forEach((element, index) => {
        if (isTranslationTooltip(element) || isIconFontElement(element) || shouldOmitFromTranslation?.(element)) {
            clonedElements[index]!.remove();
        }
    });
    clone.querySelectorAll(translationArtifactSelector).forEach((child) => child.remove());
    return {clone, slots};
}

export function collectLiveTranslationTextSlots(
    node: HTMLElement,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): TranslationTextSlot[] {
    return collectSlots(
        node,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    );
}

/** 只修改脱离文档的快照文本节点；没有对应译文的槽位保持原文。 */
export function applyTranslationsToSnapshot(
    snapshot: TranslationSourceSnapshot,
    translations: readonly string[],
): string {
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

export function hasActiveTranslationLineClamp(element: HTMLElement): boolean {
    try {
        const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
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

export function hasActiveTranslationTruncation(element: HTMLElement): boolean {
    if (hasActiveTranslationLineClamp(element)) return true;
    try {
        const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
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

/**
 * 译文段落可能位于独立的 line-clamp wrapper 内。沿短且有界的祖先链查找，使渲染
 * 能临时租用每个生效的裁剪容器，同时不让候选发现产生样式写入。首个译文解除裁剪后，
 * 共享同一容器的兄弟候选仍需识别并复用已有租约。
 */
export function findTranslationTruncationAncestors(
    node: HTMLElement,
    hasExistingOverride: (element: HTMLElement) => boolean = () => false,
): HTMLElement[] {
    const result: HTMLElement[] = [];
    let current = node.parentElement;
    let depth = 0;
    while (current && current !== node.ownerDocument?.body && depth < maxTranslationTruncationAncestorDepth) {
        depth += 1;
        if (hasExistingOverride(current) || hasActiveTranslationTruncation(current)) result.push(current);
        current = current.parentElement;
    }
    return result;
}

export function removeTranslationTruncation(node: HTMLElement): void {
    translationTruncationStyleOverrides.forEach(({property, value, priority}) => {
        node.style.setProperty(property, value, priority);
    });
}
