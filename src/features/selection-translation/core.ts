/**
 * @file src/features/selection-translation/core.ts
 * 文件职责：聚合导出划词翻译的纯交互、方向状态、开放 Shadow DOM 选区解析、受保护内容过滤与弹窗锚点定位领域模块。
 * 主要内容：作为纯导出门面，统一转发 domain/directionAndState、domain/shadowSelection、domain/selectionFilter 与 domain/popupPosition 的全部公开函数与类型。
 * 模块边界：仅作模块再导出，不含可执行业务逻辑，不监听 document selection、不发消息、不渲染 Vue 或播放音频。
 */

export {
    selectionReverseTarget,
    selectionTargetShortLabel,
    buildSelectionTargetOptions,
    resolveSelectionDirection,
    SelectionRequestTokenGate,
    canUseBundledDictionaryFallback,
    resolveSelectionDictionaryFallback,
    resolveSelectionVocabularyAnswer,
    getSelectionPresentationDelayRemaining,
    reconcileSelectionPresentation,
    isSameLanguage,
    normalizeSpeechLanguage,
    type SelectionContentRequest,
    type SelectionTargetLanguageOption,
    type SelectionDirectionInput,
    type SelectionDirection,
    type SelectionAnswerCandidate,
    type SelectionPresentationState,
    type SelectionPresentationTrigger,
} from './domain/directionAndState';

export {
    collectEventShadowRoots,
    resolveActiveSelection,
    type ResolvedSelection,
    type ResolveActiveSelectionOptions,
} from './domain/shadowSelection';

export {
    normalizeSelectionText,
    summarizeSelectionContext,
    readSelectionParts,
    readSelectionText,
    translateSelectionParts,
    isSelectionExcludedTagName,
    getEditableSelectionRoot,
    shouldIgnoreSelection,
    type SelectionTextPart,
} from './domain/selectionFilter';

export {
    chooseSelectionRect,
    getSelectionPopupAnchor,
    calculateSelectionPopupPosition,
    type SelectionRect,
    type PopupSize,
    type ViewportSize,
    type PopupPosition,
    type SelectionPopupPositionOptions,
} from './domain/popupPosition';
