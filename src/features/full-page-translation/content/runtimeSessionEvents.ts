/**
 * @file src/features/full-page-translation/content/runtimeSessionEvents.ts
 *
 * 文件职责：集中绑定全文翻译会话在文档与窗口上的开放 ShadowRoot 发现、滚动节流及弹窗状态 rAF 合并监听，并随会话 AbortSignal 统一释放。
 * 主要内容：导出 attachFullPageSessionEvents，过滤扩展自身 UI 触发的 transitionend/animationend 噪声，将 resize 与动画结束合并到单帧刷新，而原生 close/toggle 立即同步复验弹窗。
 * 模块边界：仅负责会话级 DOM/Window 事件接线与动画帧取消，不执行候选翻译或修改翻译状态表。
 */

import type {FullPageSession} from './fullPageSession';
import {noteFullPageScroll} from './fullPageQueue';
import {isElementNode} from './mutationObservation';

export interface FullPageSessionEventCallbacks {
    isCurrentSession: (session: FullPageSession) => boolean;
    observeRoot: (session: FullPageSession, root: Node) => void;
    enqueueRescan: (session: FullPageSession, root: Node) => void;
    refreshModal: (session: FullPageSession) => void;
    scheduleDrain: (session: FullPageSession) => void;
}

const OWNED_TRANSITION_SELECTOR = '[data-fr-translation-owned="true"], [data-fluent-read-ui], [id^="fluent-read-"]';

export function attachFullPageSessionEvents(
    session: FullPageSession,
    callbacks: FullPageSessionEventCallbacks,
): void {
    const signal = session.shadowEventController.signal;
    const isActive = () => session.active && callbacks.isCurrentSession(session);

    document.addEventListener('fluentread-open-shadow-root', (event) => {
        if (!isActive()) return;
        const host = isElementNode(event.target as Node) ? event.target as Element : null;
        const shadowRoot = host?.shadowRoot;
        if (!shadowRoot) return;
        callbacks.observeRoot(session, shadowRoot);
        callbacks.enqueueRescan(session, shadowRoot);
        callbacks.refreshModal(session);
    }, {capture: true, signal});

    document.addEventListener('scroll', () => noteFullPageScroll(session, isActive, () => {
        session.scrollController.note();
        callbacks.scheduleDrain(session);
    }), {capture: true, passive: true, signal});

    let modalRefreshFrame: number | undefined;
    const cancelModalRefreshFrame = () => {
        if (modalRefreshFrame !== undefined) {
            window.cancelAnimationFrame(modalRefreshFrame);
            modalRefreshFrame = undefined;
        }
    };
    const scheduleModalRefresh = (event?: Event) => {
        if (!isActive()) return;
        if (event && (event.type === 'transitionend' || event.type === 'animationend')) {
            const target = event.target;
            if (isElementNode(target as Node) && (target as Element).closest(OWNED_TRANSITION_SELECTOR)) return;
        }
        session.modalDirty = true;
        if (event && (event.type === 'close' || event.type === 'toggle')) {
            cancelModalRefreshFrame();
            callbacks.refreshModal(session);
            return;
        }
        if (modalRefreshFrame !== undefined) return;
        modalRefreshFrame = window.requestAnimationFrame(() => {
            modalRefreshFrame = undefined;
            if (!isActive()) return;
            callbacks.refreshModal(session);
        });
    };
    signal.addEventListener('abort', cancelModalRefreshFrame, {once: true});
    // close 不冒泡，capture 覆盖原生 dialog；CSS 过渡结束补足尚无尺寸的入场帧。
    // 事件仅触发只读复验，不能凭合成 close 事件放行仍打开的公告。
    for (const eventName of ['close', 'toggle', 'transitionend', 'animationend']) {
        document.addEventListener(eventName, scheduleModalRefresh, {capture: true, signal});
    }
    window.addEventListener('resize', scheduleModalRefresh, {passive: true, signal});
}
