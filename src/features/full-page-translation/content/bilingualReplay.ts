/**
 * @file src/features/full-page-translation/content/bilingualReplay.ts
 * 文件职责：在 provider 文本槽未变化时，按宿主最新安全 DOM 骨架原子重放已提交双语译文。
 * 主要内容：复验自动外壳许可与可重放槽、构建最新快照、沿用提交时的换行选项就地刷新 wrapper，并把状态重绑到实时 Text 节点。
 * 模块边界：本文件不监听 DOM、不调 provider、不管理会话；runtime 决定何时重放及何时熔断。
 */
import {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    getCurrentTranslationCore,
    type TranslationTextProtectionOptions,
} from '@/src/core/translation/public';
import {refreshBilingualTranslation} from './renderer';
import {
    isOwnedBilingualArtifactAttached,
    inlineCodeReplaySourceIsCurrent,
    isTranslationApplicationShellPolicyCurrent,
    setBilingualContent,
    setRenderedStyleAttribute,
    type TranslationState,
} from './state';

function protectionOptions(
    node: HTMLElement,
    state: TranslationState,
): TranslationTextProtectionOptions {
    return state.allowTopLevelApplicationShell === true
        ? {allowTopLevelApplicationShell: true, protectedElement: node}
        : {protectedElement: node};
}

export function refreshBilingualTranslationSkeleton(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    const replay = state.bilingualReplay;
    const content = state.bilingualContent;
    // 只要求“工件仍是我们的且仍在位”。宿主改写工件内部属性会让严格工件校验失败，
    // 但可译文本未变，按当前 DOM 重建骨架并复用已提交译文才是正确的恢复路径；
    // 要求精确工件相等会把它误判成“需要重新请求”。
    if (state.phase !== 'translated' || state.mode !== 'bilingual' || state.kind !== 'content' ||
        !replay || !content || !isTranslationApplicationShellPolicyCurrent(node, state) ||
        !inlineCodeReplaySourceIsCurrent(node, state) || !isOwnedBilingualArtifactAttached(node, state)) return false;

    const core = getCurrentTranslationCore(state.scope);
    const boundary = state.syntheticSegment ? node : undefined;
    const options = core.textOptions(protectionOptions(node, state));
    const snapshot = createTranslationSourceSnapshot(
        node,
        core.shouldStayOriginal,
        boundary,
        options,
        core.shouldOmitFromTranslation,
    );
    const sources = snapshot.slots.map((slot) => slot.source);
    if (sources.length !== replay.sources.length ||
        sources.some((source, index) => source !== replay.sources[index])) return false;

    const translatedHTML = applyTranslationsToSnapshot(snapshot, replay.translations);
    refreshBilingualTranslation(node, content, translatedHTML, {
        sourceSkeleton: snapshot.clone,
        targetLanguage: replay.targetLanguage,
        style: replay.style,
        longParagraphLineBreak: replay.longParagraphLineBreak,
        translationBeforeOriginal: replay.translationBeforeOriginal,
        sourceText: replay.sources.join('\n'),
        ...(import.meta.env.BROWSER !== 'userscript' ? {personalCorrectionId: replay.personalCorrectionId} : {}),
    });
    state.sourceTextNodes = collectLiveTranslationTextSlots(
        node,
        core.shouldStayOriginal,
        boundary,
        options,
    ).map((slot) => slot.node);
    setBilingualContent(node, content, replay);
    setRenderedStyleAttribute(node);
    return true;
}
