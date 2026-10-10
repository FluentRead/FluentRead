/**
 * @file src/features/full-page-translation/content/liveTextTranslation.ts
 * 文件职责：按候选类型、展示模式和识别范围选择文本槽请求，保留异步提交所需的来源与译文快照。
 * 主要内容：精确相同译文和有同目标语言证据的排版回显保留原文且不重复展示；冻结整个请求与回退链路的配置，为正文双语构造文本快照，对可无损拍平的多槽候选重建整段原文并整块请求、整段译文回填首个槽位，为交互控件和仅译文模式构造带前后缀的实时 Text 槽结果，为按钮型 input 构造属性替换结果，统一传递取消、重试、范围与会话参数。
 * 模块边界：本文件不管理 DOM 状态、不决定候选、不监听 mutation；runtime 负责 generation 校验和最终渲染。
 */
import {
    buildWholeBlockTranslationSource,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    getCurrentTranslationCore,
    getTranslatableControlValueAttribute,
    normalizeTranslationText,
} from '@/src/core/translation/public';
import type {TranslationScope, TranslationTextProtectionOptions} from '@/src/core/translation/public';
import {hasDistinctTargetTranslation as hasDistinctTranslation} from '@/src/core/translation/targetResult';
import type {TranslationQueueSession} from '@/src/services/translation/queue';
import {copyFullPageTranslationConfigSnapshot} from './translationConfigSnapshot';
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

/** 宿主以 pre 系列保留源码换行时，文本里的换行也是可见断行，整段原文需要原样保留。 */
function preservesSourceNewlines(node: HTMLElement): boolean {
    try {
        const whiteSpace = node.ownerDocument.defaultView?.getComputedStyle(node).whiteSpace ?? '';
        return /^(?:pre|pre-wrap|pre-line|break-spaces)$/u.test(whiteSpace);
    } catch {
        return false;
    }
}

/**
 * 把多槽候选改成一次整块请求：整段原文作为单个 origin 送出，整段译文落到首个槽位、
 * 其余槽位留空，由 applyTranslationsToSnapshot 按纯文本渲染。跨语系翻译时逐片段请求
 * 会得到脱离上下文的碎片译文，这里以牺牲译文侧的内联格式换取通顺的整段译文。
 * 只有骨架可无损拍平（无行内代码、受保护术语、公式、图片等）时才整块请求；
 * 返回 null 表示整块请求不可用，调用方仍按槽位请求；译文与原段相同时返回原文数组，
 * 让上层直接判定为未变化，不再重复请求。
 */
async function translateSnapshotAsWholeBlock(
    node: HTMLElement,
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    forceFailedRequest = false,
    scope?: TranslationScope,
): Promise<string[] | null> {
    const core = getCurrentTranslationCore(scope);
    // 与提交时的渲染骨架使用同一套省略规则；隐藏文字、tooltip 等不会被当成受保护内容。
    const skeleton = createTranslationSourceSnapshot(node, core.shouldStayOriginal, undefined,
        protectionOptions, core.shouldOmitFromTranslation);
    if (skeleton.slots.length !== origins.length ||
        skeleton.slots.some((slot, index) => slot.source !== origins[index])) return null;
    const source = buildWholeBlockTranslationSource(skeleton, {preserveNewlines: preservesSourceNewlines(node)});
    if (!source) return null;
    const [translation = ''] = await translateTextSlots(
        [source], snapshot, signal, queueSession, fullPageSession, forceFailedRequest,
        ...(fullPageSession && snapshot.enableAIMultiSegment ? [node] : []),
    );
    if (!normalizeTranslationText(translation)) return null;
    if (!hasDistinctTranslation(source, translation, snapshot.targetLanguage)) return [...origins];
    return origins.map((_, index) => index === 0 ? translation : '');
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
        ...(fullPageSession && snapshot.enableAIMultiSegment ? [node] : []),
    );
    const text = translations[0] ?? source;
    return {
        kind: 'control-value',
        attribute,
        complete: translations.length === 1,
        changed: hasDistinctTranslation(source, text, snapshot.targetLanguage),
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
        ...(fullPageSession && snapshot.enableAIMultiSegment ? [node] : []),
    );
    const changed = translations.some((translation, index) =>
        hasDistinctTranslation(origins[index]!, translation, snapshot.targetLanguage),
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
    snapshot = copyFullPageTranslationConfigSnapshot(snapshot);
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
        const wholeBlock = await translateSnapshotAsWholeBlock(node, origins, snapshot, signal, queueSession,
            fullPageSession, protectionOptions, forceFailedRequest, scope);
        if (wholeBlock) return {kind: 'snapshot', sources: origins, translations: wholeBlock};
    }
    const translations = await translateTextSlots(origins, snapshot, signal, queueSession,
        fullPageSession, forceFailedRequest,
        ...(fullPageSession && snapshot.enableAIMultiSegment ? [node] : []));
    return {kind: 'snapshot', sources: origins, translations};
}
