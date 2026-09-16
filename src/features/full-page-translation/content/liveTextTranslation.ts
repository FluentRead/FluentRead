/**
 * @file src/features/full-page-translation/content/liveTextTranslation.ts
 * 文件职责：按候选类型、展示模式和识别范围选择文本槽请求，保留异步提交所需的来源与译文快照。
 * 主要内容：为正文双语构造文本快照，对多槽候选按 DOM 边界重建整段原文并整块请求、整段译文回填首个槽位，为交互控件和仅译文模式构造带前后缀的实时 Text 槽结果，为按钮型 input 构造属性替换结果，统一传递取消、重试、范围与会话参数。
 * 模块边界：本文件不管理 DOM 状态、不决定候选、不监听 mutation；runtime 负责 generation 校验和最终渲染。
 */
import {
    collectLiveTranslationTextSlots,
    getCurrentTranslationCore,
    getTranslatableControlValueAttribute,
    normalizeTranslationText,
} from '@/src/core/translation/public';
import type {TranslationScope, TranslationTextProtectionOptions, TranslationTextSlot} from '@/src/core/translation/public';
import type {TranslationQueueSession} from '@/src/services/translation/queue';
import {
    translateTextSlots,
    type FullPageTranslationConfigSnapshot,
    type FullPageTranslationSessionCache,
} from './translationRequest';

export interface LiveTextTranslationResult {
    kind: 'live-text';
    complete: boolean;
    changed: boolean;
    sources: readonly string[];
    translations: readonly string[];
    nodes: readonly Text[];
    slots: readonly {node: Text; text: string}[];
}

export interface ControlValueTranslationResult {
    kind: 'control-value';
    /** 承载按钮标签的属性名；恢复原文与复验都以同一属性为准。 */
    attribute: string;
    complete: boolean;
    changed: boolean;
    sources: readonly string[];
    translations: readonly string[];
    /** 写回宿主属性的最终文本。 */
    text: string;
}

/**
 * 整块请求中会隔开两侧文字的替换元素：它们自身不产出可译文本，却会在渲染上留下
 * 一个词边界。漏掉时 one<br>two 这类相邻槽位会被粘成 onetwo，引擎无法正确断句。
 */
const wholeBlockBoundaryTags = new Set([
    'br', 'hr', 'img', 'picture', 'video', 'audio', 'canvas', 'svg', 'iframe',
    'object', 'embed', 'input', 'select', 'textarea', 'math',
]);

/**
 * 为一个多槽候选重建整段原文：内联格式（加粗、链接、斜体）的边界无缝拼接，
 * 保证 Hello <b>world</b>! 仍是 Hello world!；<br> 换成换行，替换元素、受保护
 * 或省略的文本换成空格，避免把被格式切开的相邻文字误粘成一个词。
 * 内部仅读取传入 DOM 计算文本，不修改节点，也不发起请求。
 */
export function buildWholeBlockSourceText(root: HTMLElement, slots: readonly TranslationTextSlot[]): string {
    const slotIndex = new Map<Text, number>();
    slots.forEach((slot, index) => slotIndex.set(slot.node, index));
    // 1 | 4 分别是 SHOW_ELEMENT 与 SHOW_TEXT，避免依赖可能缺失的 NodeFilter 全局。
    const walker = root.ownerDocument.createTreeWalker(root, 1 | 4);
    const parts: string[] = [];
    let pending = '';
    let current = walker.nextNode();
    while (current) {
        if (current.nodeType === 1) {
            const tag = (current as Element).localName;
            if (tag === 'br') pending = '\n';
            else if (pending !== '\n' && wholeBlockBoundaryTags.has(tag)) pending = ' ';
        } else {
            const index = slotIndex.get(current as Text);
            if (index === undefined) {
                if (!pending) pending = ' ';
            } else {
                const slot = slots[index]!;
                const text = `${slot.prefix}${slot.source}${slot.suffix}`;
                const previous = parts.at(-1);
                if (pending === '\n') {
                    if (previous && !/\n$/u.test(previous) && !/^\n/u.test(text)) parts.push('\n');
                } else if (pending === ' ' && previous && !/\s$/u.test(previous) && !/^\s/u.test(text)) {
                    parts.push(' ');
                }
                pending = '';
                parts.push(text);
            }
        }
        current = walker.nextNode();
    }
    return parts.join('');
}

/**
 * 把多槽候选改成一次整块请求：整段原文作为单个 origin 送出，整段译文落到首个槽位、
 * 其余槽位留空，由 applyTranslationsToSnapshot 按纯文本渲染。跨语系翻译时逐片段请求
 * 会得到脱离上下文的碎片译文，这里以牺牲内联格式换取通顺的整段译文。
 * 返回 null 表示整块请求不可用（无译文），调用方仍按槽位请求；译文与原段相同时
 * 返回原文数组，让上层直接判定为未变化，不再重复请求。
 */
async function translateSnapshotAsWholeBlock(
    node: HTMLElement,
    parts: readonly TranslationTextSlot[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    forceFailedRequest = false,
): Promise<string[] | null> {
    const source = buildWholeBlockSourceText(node, parts);
    const [translation] = await translateTextSlots(
        [source], snapshot, signal, queueSession, fullPageSession, forceFailedRequest,
    );
    if (!translation) return null;
    if (normalizeTranslationText(translation) === normalizeTranslationText(source)) {
        return parts.map((part) => part.source);
    }
    return parts.map((_, index) => index === 0 ? translation : '');
}

/**
 * 按钮型 input 没有可写入的 Text 节点，只能整体替换属性文本。
 * 这与其他控件的产品语义一致：按钮尺寸由宿主样式钉死，只呈现译文，不做双语对照。
 */
export async function translateControlValue(
    node: HTMLElement,
    attribute: string,
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    forceFailedRequest = false,
): Promise<ControlValueTranslationResult> {
    const source = node.getAttribute(attribute) ?? '';
    const translations = await translateTextSlots(
        [source], snapshot, signal, queueSession, fullPageSession, forceFailedRequest,
    );
    const text = translations[0] ?? source;
    return {
        kind: 'control-value',
        attribute,
        complete: translations.length === 1,
        changed: normalizeTranslationText(text) !== normalizeTranslationText(source),
        sources: [source],
        translations,
        text,
    };
}

export async function translateLiveText(
    node: HTMLElement,
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    forceFailedRequest = false,
    scope?: TranslationScope,
): Promise<LiveTextTranslationResult> {
    const parts = collectLiveTranslationTextSlots(
        node,
        getCurrentTranslationCore(scope).shouldStayOriginal,
        undefined,
        protectionOptions,
    );
    if (parts.length === 0) return {
        kind: 'live-text',
        complete: false,
        changed: false,
        sources: [],
        translations: [],
        nodes: [],
        slots: [],
    };

    const origins = parts.map((part) => part.source);
    const translations = await translateTextSlots(
        origins,
        snapshot,
        signal,
        queueSession,
        fullPageSession,
        forceFailedRequest,
    );
    const changed = translations.some((translation, index) =>
        translation.replace(/[\s\u3000]+/gu, ' ').trim() !== (origins[index] || '').replace(/[\s\u3000]+/gu, ' ').trim(),
    );

    return {
        kind: 'live-text',
        complete: translations.length === origins.length,
        changed,
        sources: origins,
        translations,
        nodes: parts.map((part) => part.node),
        slots: parts.map((part, index) => ({
            node: part.node,
            text: `${part.prefix}${translations[index] ?? part.source}${part.suffix}`,
        })),
    };
}

export type TranslationResult = LiveTextTranslationResult | ControlValueTranslationResult | {
    kind: 'snapshot';
    sources: readonly string[];
    translations: readonly string[];
};

/** 统一冻结候选范围；异步期间其他会话的范围变化不能改变本次请求的文本槽。 */
export async function createTranslationRequest(
    node: HTMLElement,
    kind: 'content' | 'control',
    mode: 'bilingual' | 'single',
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    forceFailedRequest = false,
    scope?: TranslationScope,
): Promise<TranslationResult> {
    const controlValueAttribute = getTranslatableControlValueAttribute(node);
    if (controlValueAttribute) {
        return translateControlValue(node, controlValueAttribute, snapshot, signal,
            queueSession, fullPageSession, forceFailedRequest);
    }
    if (kind === 'control' || mode === 'single') {
        return translateLiveText(node, snapshot, signal, queueSession, fullPageSession,
            protectionOptions, forceFailedRequest, scope);
    }
    const parts = collectLiveTranslationTextSlots(node, getCurrentTranslationCore(scope).shouldStayOriginal,
        undefined, protectionOptions);
    const origins = parts.map((part) => part.source);
    if (origins.length === 0) return {kind: 'snapshot', sources: [], translations: []};
    if (parts.length > 1) {
        const wholeBlock = await translateSnapshotAsWholeBlock(node, parts, snapshot, signal, queueSession,
            fullPageSession, forceFailedRequest);
        if (wholeBlock) return {kind: 'snapshot', sources: origins, translations: wholeBlock};
    }
    const translations = await translateTextSlots(origins, snapshot, signal, queueSession,
        fullPageSession, forceFailedRequest);
    return {kind: 'snapshot', sources: origins, translations};
}
