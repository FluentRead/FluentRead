/**
 * @file src/core/translation/public.ts
 *
 * 文件职责：作为翻译候选核心的唯一公共入口，稳定暴露创建函数、类型和经过批准的 DOM、布局、序列化能力。
 * 主要内容：相同译文保留原文且不重复展示；导出 createTranslationCore、TranslationCandidateCore、站点 registry、语言解析、译文字体族解析、文本槽序列化、同步布局测量上下文及声明式适配器，隐藏 internal.ts 等实现细节。 可核对的公开符号包括 createTranslationCore、聚合导出。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

export {hasDistinctTranslation} from './result';

import {TranslationCandidateCore} from './engine';
import {defaultTranslationAdapters} from './registry';
import type {TranslationCoreOptions} from './types';

export function createTranslationCore(options: TranslationCoreOptions = {}): TranslationCandidateCore {
    return new TranslationCandidateCore({
        ...options,
        adapters: options.adapters ?? defaultTranslationAdapters,
    });
}

export {
    getTranslationCandidateKey,
    selectPreferredTranslationCandidate,
    TranslationCandidateCore,
} from './engine';
export type {TranslationDiscoveryStep} from './engine';
export {
    evaluateHardGuard,
    getElementTagName,
    getComposedParent,
    maxComposedAncestorDepth,
    getOpenShadowRoots,
    getTranslatableControlValueAttribute,
    isProtectedDescendantElement,
    isTopLevelApplicationShell,
} from './dom';
export type {TranslationTextProtectionOptions} from './dom';
export {
    CJK_TRANSLATION_FONT_STACKS,
    detectTranslationTextScript,
    resolveTargetTranslationScript,
    resolveTranslationFontFamily,
} from './font';
export type {TranslationScript} from './font';
export {
    createTranslationTextProtectionCache,
    extractTranslationText,
    extractTranslationTextFromNodes,
    isMeaningfulTranslationText,
    isTranslationTextElementProtected,
    normalizeTranslationText,
    setMinimumTranslationTextLength,
} from './text';
export type {TranslationTextProtectionCache} from './text';
export {createTranslationLayoutMeasurements} from './layoutMeasurements';
export type {TranslationLayoutMeasurements} from './layoutMeasurements';
export {
    applyTranslationsToSnapshot,
    buildWholeBlockTranslationSource,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    hasActiveTranslationLineClamp,
    hasActiveTranslationTruncation,
    parseTranslationSlots,
    serializeTranslationSlots,
    translationTruncationStyleOverrides,
} from './serialization';
export type {
    SerializedTranslationSlots,
    TranslationSourceSnapshot,
    TranslationStyleOverride,
    TranslationTextSlot,
    WholeBlockTranslationSourceOptions,
} from './serialization';
export {createDeclarativeAdapter} from './adapters/declarative';
export {
    getCurrentTranslationCore,
    createCurrentTranslationResolverBatch,
    setCurrentTranslationAdapters,
    setCurrentTranslationSidebarRegions,
    resolveTranslationCandidateAtPoint,
} from './current';
export type * from './types';
export {findDocumentLiteralTerms} from './documentLiterals';
