/**
 * @file src/features/full-page-translation/content/eagerTranslation.ts
 * 文件职责：按用户设定的字符预算，让全文会话在页面开头的一段内容上跳过视口门禁，不等待滚动即可排队翻译。
 * 主要内容：统计候选宿主或内联 run 的字符量，在会话首次请求时冻结预算并按发现顺序扣减，跳过已排队候选的重复扣减，预算耗尽后交还给视口驱动的常规调度。
 * 模块边界：本文件只做预算判定，不发起翻译请求、不操作 IntersectionObserver、不持有会话生命周期；预算随会话对象被回收，调度仍由 full-page runtime 拥有。
 */
import type {TranslationCandidate} from '@/src/core/translation/public';
import {normalizeEagerTranslationCharacters} from '@/src/core/config/pageTranslation';
import {config} from '@/src/services/config/store';

/** 只依赖会话的排队集合，便于在测试中用最小对象验证扣减规则。 */
export interface EagerTranslationBudgetSession {
    pending: Map<Node, TranslationCandidate>;
    scheduled: Map<Node, TranslationCandidate>;
}

const sessionBudgets = new WeakMap<EagerTranslationBudgetSession, number>();

/** 候选在页面中的字符量；内联 run 只统计自己持有的节点。 */
export function candidateTextLength(candidate: TranslationCandidate): number {
    const nodes = candidate.nodes;
    if (nodes && nodes.length > 0) {
        return nodes.reduce((total, node) => total + (node.textContent?.length ?? 0), 0);
    }
    return candidate.element.textContent?.length ?? 0;
}

/** 会话遇到第一个候选时冻结预算，之后的设置改动留给下一次全文翻译。 */
export function getEagerTranslationBudget(session: EagerTranslationBudgetSession): number {
    const budget = sessionBudgets.get(session);
    if (budget !== undefined) return budget;
    const initial = normalizeEagerTranslationCharacters(config.eagerTranslationCharacters);
    sessionBudgets.set(session, initial);
    return initial;
}

/**
 * 页面开头的内容不必等待滚动。预算按发现顺序扣减，用尽后后续候选继续走
 * 视口门禁，因此长页面不会因为这一项而整页发出请求。
 */
export function consumeEagerTranslationBudget(
    session: EagerTranslationBudgetSession,
    key: Node,
    candidate: TranslationCandidate,
): boolean {
    const budget = getEagerTranslationBudget(session);
    if (budget <= 0) return false;
    // 重新绑定同一候选不应二次扣减预算，否则页面变动会提前耗尽额度。
    if (session.pending.has(key) || session.scheduled.has(key)) return true;
    sessionBudgets.set(session, Math.max(0, budget - candidateTextLength(candidate)));
    return true;
}
