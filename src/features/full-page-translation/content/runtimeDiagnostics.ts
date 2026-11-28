/**
 * @file src/features/full-page-translation/content/runtimeDiagnostics.ts
 *
 * 文件职责：管理全文翻译会话的内容发现标记、失败诊断记录及防抖微任务进度与工具栏状态发布。
 * 主要内容：提供 createFullPageDiagnosticTracker 维护每个 FullPageSession 的发现与失败诊断映射，以及 scheduleFullPageProgressPublish 统一发布弹窗优先进度、失败计数和工具栏状态。
 * 模块边界：仅协调全文翻译会话的只读摘要与进度通知，不执行 DOM 翻译、不触发网络请求，也不持有全局会话单例。
 */

import {diagnoseFailure, type Diagnostic} from '@/src/services/diagnostics';
import {config} from '@/src/services/config/store';
import {updateFullPageTranslationProgress} from '@/src/features/full-page-translation/progress';
import {countFullPageTranslationWork, resolveTranslationToolbarStatus} from '../toolbarStatus';
import {syncModalTranslationHint} from '../ui/modalProgressHint';
import type {FullPageSession} from './fullPageSession';
import {isWithinTranslationModal} from './modalPriority';
import {getFullPageModalOutcomePhases, getFullPageOutcomeSummary} from './outcomeSession';
import {getTranslationState, type TranslationState} from './state';
import {notifyFullPageTranslationDiagnostic, notifyTranslationToolbarStatus} from './stateNotification';
import {getTranslationInvocationIdentity} from './translationRequest';

export interface FullPageFailureDiagnostic {
    diagnostic: Diagnostic;
    state: TranslationState;
    retryAt?: number;
}

export interface FullPageDiagnosticTracker {
    markDiscovered(session: FullPageSession): void;
    recordFailure(session: FullPageSession, node: HTMLElement, failure: FullPageFailureDiagnostic): void;
    syncFailure(session: FullPageSession, isCurrentSession: (session: FullPageSession) => boolean): void;
    clearSession(session: FullPageSession): void;
    notifyNoContentIfEmpty(session: FullPageSession): void;
}

export function createFullPageDiagnosticTracker(): FullPageDiagnosticTracker {
    // 只记录当前路由是否真实发现过候选；目标语言预检和离屏调度均不能把正文误判为空。
    const sessionsWithDiscoveredContent = new WeakSet<FullPageSession>();
    const sessionFailureDiagnostics = new WeakMap<FullPageSession, Map<HTMLElement, FullPageFailureDiagnostic>>();
    const sessionPublishedFailureDiagnostic = new WeakMap<FullPageSession, FullPageFailureDiagnostic>();

    return {
        markDiscovered(session) {
            sessionsWithDiscoveredContent.add(session);
        },
        recordFailure(session, node, failure) {
            const failures = sessionFailureDiagnostics.get(session) ?? new Map();
            failures.delete(node);
            failures.set(node, failure);
            sessionFailureDiagnostics.set(session, failures);
        },
        /** 按仍真实失败的 owner 保留最近分类；其他段成功、最后失败恢复或局部取消均不误用旧错误。 */
        syncFailure(session, isCurrentSession) {
            const failures = sessionFailureDiagnostics.get(session);
            if (!failures || !isCurrentSession(session) || !session.active) return;
            let latest: FullPageFailureDiagnostic | undefined;
            for (const [node, failure] of failures) {
                if (!node.isConnected || getTranslationState(node) !== failure.state || failure.state.phase !== 'error') {
                    failures.delete(node);
                } else {
                    latest = failure;
                }
            }
            if (!latest) {
                sessionFailureDiagnostics.delete(session);
                sessionPublishedFailureDiagnostic.delete(session);
                notifyFullPageTranslationDiagnostic(undefined);
                return;
            }
            if (sessionPublishedFailureDiagnostic.get(session) === latest) return;
            sessionPublishedFailureDiagnostic.set(session, latest);
            const {retryAfterMs: _originalWait, ...diagnostic} = latest.diagnostic;
            const remaining = Math.max(0, (latest.retryAt ?? 0) - Date.now());
            notifyFullPageTranslationDiagnostic({...diagnostic, ...(remaining > 0 ? {retryAfterMs: remaining} : {})});
        },
        clearSession(session) {
            sessionsWithDiscoveredContent.delete(session);
            sessionFailureDiagnostics.delete(session);
            sessionPublishedFailureDiagnostic.delete(session);
        },
        notifyNoContentIfEmpty(session) {
            if (!sessionsWithDiscoveredContent.has(session) && session.statefulTargetsByAncestor.size === 0) {
                notifyFullPageTranslationDiagnostic(diagnoseFailure(undefined, {reason: 'no-content'}));
            }
        },
    };
}

export function scheduleFullPageProgressPublish(
    session: FullPageSession,
    isCurrentSession: (session: FullPageSession) => boolean,
    diagnostics: FullPageDiagnosticTracker,
): void {
    if (!session.active || session.progressPublishScheduled) return;
    session.progressPublishScheduled = true;
    queueMicrotask(() => {
        session.progressPublishScheduled = false;
        if (!session.active || !isCurrentSession(session)) return;

        const modal = session.modal;
        const eligible = (node: Node) => !modal || isWithinTranslationModal(modal, node);
        let scheduled = session.scheduled;
        let pending = session.pending.size;
        if (modal) {
            scheduled = new Map();
            for (const [key, candidate] of session.scheduled) {
                if (eligible(candidate.element)) scheduled.set(key, candidate);
            }
            pending = 0;
            for (const candidate of session.pending.values()) {
                if (eligible(candidate.element)) pending += 1;
            }
        }
        const work = countFullPageTranslationWork(session.inFlightCandidates, scheduled, pending);
        const deferred = session.scheduled.size - scheduled.size;
        const outcomes = getFullPageOutcomeSummary(session);
        diagnostics.syncFailure(session, isCurrentSession);
        const busy = work.running > 0 || work.queued > 0;
        // 普通页面直接用增量摘要；弹窗仅惰性检查其内部目标，不预先分配整页数组。
        const status = resolveTranslationToolbarStatus(busy, !modal ? outcomes.phases : getFullPageModalOutcomePhases(
            session,
            session.statefulTargetsByAncestor.get(document.documentElement) ?? [],
            getTranslationInvocationIdentity(session.translationConfig),
        ));
        notifyTranslationToolbarStatus(session.modal && status === 'translated' ? 'idle' : status);
        const modalPhase = session.modal ? busy ? 'translating' : 'waiting' : 'none';
        syncModalTranslationHint(session.modal, modalPhase, config.translationProgressPanelEnabled === true);
        updateFullPageTranslationProgress(session.progressSessionId, {
            ...work,
            deferred,
            modalPhase,
            completed: outcomes.completed,
            failed: outcomes.failed,
            retryable: outcomes.retryable,
        });
    });
}
