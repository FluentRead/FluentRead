/**
 * @file src/features/full-page-translation/content/requestSession.ts
 * 文件职责：持有全文翻译会话级请求复用的取消域、活动队列会话与结果缓存生命周期。
 * 主要内容：创建共享 AbortSignal，统一结束底层请求，并在有效 AI 页面上下文或相邻多段来源变化时失效请求结果。
 * 模块边界：本文件不执行翻译、不管理候选或 DOM；translationRequest 负责填充缓存，runtime 只调用这里的生命周期入口。
 */
import {servicesType} from '@/src/core/config/catalog';
import {
    cancelTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';
import {
    clearFullPageTranslationRequestCache,
    type FullPageTranslationCacheEntry,
    type FullPageTranslationConfigSnapshot,
    type FullPageTranslationRequestCacheEntry,
    type FullPageTranslationSessionCache,
} from '@/src/features/full-page-translation/content/translationRequest';

export interface FullPageRequestSessionState {
    translationRequestCache: Map<string, FullPageTranslationRequestCacheEntry>;
    requestController: AbortController;
    requestSignal: AbortSignal;
    requestQueueSessions: Set<TranslationQueueSession>;
    requestControllers: Set<AbortController>;
    pageContextGeneration: number;
    renderCommitGeneration: number;
}

interface FullPageRequestCacheState extends FullPageRequestSessionState {
    translationSlotCache: Map<string, FullPageTranslationCacheEntry>;
}

export function createFullPageRequestSessionState(): FullPageRequestSessionState {
    const requestController = new AbortController();
    return {
        translationRequestCache: new Map(),
        requestController,
        requestSignal: requestController.signal,
        requestQueueSessions: new Set(),
        requestControllers: new Set(),
        pageContextGeneration: 0,
        renderCommitGeneration: 0,
    };
}

type HoverTranslationRequestSession = FullPageRequestSessionState & FullPageTranslationSessionCache;
function createHoverTranslationRequestSession(): HoverTranslationRequestSession {
    return {active: true, translationSlotCache: new Map(), retainSettledResults: false,
        allowAIMultiSegment: false, allowNativeBatch: false, ...createFullPageRequestSessionState()};
}
let hoverTranslationRequestSession = createHoverTranslationRequestSession();
export function getHoverTranslationRequestSession(): HoverTranslationRequestSession {
    return hoverTranslationRequestSession;
}
export function invalidateHoverTranslationRequestSession(): void {
    invalidateFullPageRequestSessionForRoute(hoverTranslationRequestSession);
}
export function resetHoverTranslationRequestSession(reason: Error): void {
    hoverTranslationRequestSession.active = false;
    disposeFullPageRequestSession(hoverTranslationRequestSession, reason);
    hoverTranslationRequestSession.translationSlotCache.clear();
    hoverTranslationRequestSession = createHoverTranslationRequestSession();
}

/** 使当前页面已结算结果失效；仍有消费者的在途请求可结束，但不能再次被重挂复用。 */
export function invalidateFullPageRequestSessionCache(session: FullPageRequestCacheState): void {
    session.pageContextGeneration += 1;
    clearFullPageTranslationRequestCache(session);
    session.translationSlotCache.clear();
}

export function invalidateFullPageRequestSessionForRoute(session: FullPageRequestCacheState): void {
    session.renderCommitGeneration += 1;
    invalidateFullPageRequestSessionCache(session);
}

export function invalidateContextSensitiveRequestCache(
    session: FullPageRequestCacheState & {translationConfig: FullPageTranslationConfigSnapshot},
): void {
    const snapshot = session.translationConfig;
    if ((snapshot.enableAIContext || snapshot.enableAIMultiSegment)
        && servicesType.isUseAIContext(snapshot.service, snapshot.model)) {
        session.pageContextGeneration += 1;
        clearFullPageTranslationRequestCache(session, true);
        session.translationSlotCache.clear();
    }
}

export function disposeFullPageRequestSession(
    session: FullPageRequestSessionState,
    reason: Error,
): void {
    clearFullPageTranslationRequestCache(session);
    session.requestController.abort();
    session.requestControllers.forEach((controller) => controller.abort());
    session.requestControllers.clear();
    session.requestQueueSessions.forEach((queueSession) => {
        cancelTranslationQueueSession(queueSession, reason);
    });
    session.requestQueueSessions.clear();
}
