/**
 * @file src/features/full-page-translation/content/outcomeSession.ts
 * 文件职责：把全文会话的增量目标状态连接到失败定位和局部重试端口。
 * 主要内容：只订阅本会话已登记的目标，移除失联目标；操作前再次检查当前会话和弹窗资格，结束时释放阶段订阅。
 * 模块边界：不发起翻译和创建会话；重试由运行时登记的回调完成，进度发布由组合方注入。
 */
import {createFullPageOutcomeRegistry} from '../core/outcomes';
import {setFullPageFailureActions} from '../progress';
import {getTranslationState, subscribeTranslationStateChanges} from './state';
import {isWithinTranslationModal} from './modalPriority';

interface OutcomeSession {
    active: boolean;
    progressSessionId: number;
    outcomes: ReturnType<typeof createFullPageOutcomeRegistry<HTMLElement>>;
    statefulAncestorsByTarget: WeakMap<HTMLElement, readonly Element[]>;
    modal: Parameters<typeof isWithinTranslationModal>[0] | null;
}

function isRecoverable(session: OutcomeSession, node: HTMLElement): boolean {
    return node.isConnected && getTranslationState(node)?.phase === 'error'
        && (!session.modal || isWithinTranslationModal(session.modal, node));
}

/** 旧悬浮失败没有本会话恢复端口；只有已登记请求或同身份成功结果纳入摘要。 */
export function registerFullPageOutcomeTarget(session: OutcomeSession, node: HTMLElement, identity: string): void {
    const state = node.isConnected ? getTranslationState(node) : undefined;
    const phase = state?.translationInvocationIdentity === identity
        && (state.phase !== 'error' || session.outcomes.has(node)) ? state.phase : undefined;
    session.outcomes.update(node, phase);
}

export function getFullPageOutcomeSummary(session: OutcomeSession) {
    const counts = session.outcomes.snapshot();
    return {...counts, retryable: session.outcomes.countFailures(node => isRecoverable(session, node)),
        phases: [counts.loading ? 'loading' : '', counts.failed ? 'error' : '', counts.completed ? 'translated' : '']};
}

/** 弹窗工具栏只看本会话拥有的内部目标，独立快捷方案不改变全文状态。 */
export function* getFullPageModalOutcomePhases(session: OutcomeSession, targets: Iterable<HTMLElement>, identity: string) {
    for (const target of targets) {
        if (!target.isConnected || !session.outcomes.has(target) || !session.modal || !isWithinTranslationModal(session.modal, target)) continue;
        const state = getTranslationState(target);
        if (state?.translationInvocationIdentity === identity) yield state.phase;
    }
}

export function bindFullPageOutcomeRecovery(session: OutcomeSession, isCurrent: () => boolean, publish: () => void): () => void {
    const current = () => session.active && isCurrent();
    const stop = subscribeTranslationStateChanges((node, state) => {
        if (!current() || !session.statefulAncestorsByTarget.has(node) || !session.outcomes.has(node)) return;
        session.outcomes.update(node, node.isConnected ? state?.phase : undefined);
        publish();
    });
    setFullPageFailureActions(session.progressSessionId, (action) => {
        if (!current()) return 0;
        const eligible = (node: HTMLElement) => isRecoverable(session, node);
        if (action === 'retry') return session.outcomes.retry(eligible);
        const target = session.outcomes.firstFailure(eligible);
        if (!target) return 0;
        target.scrollIntoView({block: 'center', behavior: 'auto'});
        return 1;
    });
    return stop;
}
