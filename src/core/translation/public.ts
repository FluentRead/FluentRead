/**
 * @file src/core/translation/public.ts
 *
 * 文件职责：作为翻译候选核心的唯一公共入口，稳定暴露创建函数、类型和经过批准的 DOM、布局、序列化能力。
 * 主要内容：导出 createTranslationCore、TranslationCandidateCore、站点 registry、语言解析、文本槽序列化及声明式适配器，隐藏 internal.ts 等实现细节。 可核对的公开符号包括 createTranslationCore、聚合导出。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

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
    getOpenShadowRoots,
    isProtectedDescendantElement,
    isTopLevelApplicationShell,
} from './dom';
export type {TranslationTextProtectionOptions} from './dom';
export {
    createTranslationTextProtectionCache,
    extractTranslationText,
    extractTranslationTextFromNodes,
    isClearlyTargetLanguage,
    getMinimumTranslationTextLength,
    isMeaningfulTranslationText,
    isTranslationTextElementProtected,
    setMinimumTranslationTextLength,
} from './text';
export type {TranslationTextProtectionCache} from './text';
export {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    findTranslationTruncationAncestors,
    hasActiveTranslationLineClamp,
    hasActiveTranslationTruncation,
    parseTranslationSlots,
    removeTranslationTruncation,
    serializeTranslationSlots,
    translationTruncationStyleOverrides,
} from './serialization';
export type {
    SerializedTranslationSlots,
    TranslationSourceSnapshot,
    TranslationStyleOverride,
    TranslationTextSlot,
} from './serialization';
export {createDeclarativeAdapter} from './adapters/declarative';
export {
    getCurrentTranslationCore,
    setCurrentTranslationAdapters,
    setCurrentTranslationSidebarRegions,
    resolveTranslationCandidate,
    resolveTranslationCandidateAtPoint,
} from './current';
export type * from './types';
