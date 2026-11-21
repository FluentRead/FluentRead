/**
 * @file src/features/full-page-translation/content/pageRuleDiagnosis.ts
 * 文件职责：解释当前选区首段的规则命中和翻译进度。
 * 主要内容：读取当前范围生效的适配器、选区所在来源、真实译文状态和会话调度结果；确认源文仍一致后才解释已恢复或无需改写。
 * 模块边界：只读当前 DOM 和现有会话，不请求翻译、不检查其他 frame、不回传原文或服务响应。
 */
import {composedAncestors, evaluateHardGuard, maxComposedAncestorDepth} from '@/src/core/translation/dom';
import {getCurrentTranslationCore, getTranslationCandidateKey} from '@/src/core/translation/public';
import {createTranslationTextProtectionCache, isTranslationTextElementProtected} from '@/src/core/translation/text';
import type {PageRuleDiagnosis, TranslationCandidate, TranslationScope} from '@/src/core/translation/types';
import type {FullPageSession} from './fullPageSession';
import {getTranslationState, resolveTranslationStateNode} from './state';
import {sameLifecycleRetry} from './translationStability';

export function readPageRuleSelection(document: Document): Node | undefined {
    if (import.meta.env.BROWSER === 'userscript') return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const start = range.startContainer;
    return start.childNodes[range.startOffset] ?? start;
}

function readOwnedPhase(element: Element) {
    let depth = 0;
    for (const ancestor of composedAncestors(element)) {
        if (++depth > maxComposedAncestorDepth) return;
        const phase = getTranslationState(ancestor as HTMLElement)?.phase;
        if (phase) return phase;
    }
}

function describeSelection(
    core: ReturnType<typeof getCurrentTranslationCore>, start: Node,
): {candidate: TranslationCandidate} | PageRuleDiagnosis['selection'] {
    const element = start.nodeType === 1 ? start as Element : start.parentElement;
    if (!element?.isConnected) return {reason: 'unrecognized'};
    const pruned = core.findAdapterPrunedAncestor(element);
    if (pruned?.adapterId) return {reason: 'rule-excluded', ruleId: pruned.adapterId, detail: pruned.reason};
    const options = core.textOptions();
    const guard = evaluateHardGuard(element, options);
    if (guard.prune) {
        const phase = guard.reason === 'fluentread-owned' ? readOwnedPhase(element) : undefined;
        return phase ? {reason: phase} : {reason: 'protected', detail: guard.reason};
    }

    let ruleId: string | undefined;
    const keepOriginal = (item: Element) => {
        ruleId = core.findOriginalProtectionAdapter(item)?.id;
        return ruleId !== undefined;
    };
    if (isTranslationTextElementProtected(element, keepOriginal, createTranslationTextProtectionCache(), options)) {
        return ruleId ? {reason: 'rule-protected', ruleId} : {reason: 'protected'};
    }
    // 解析可能上溯到祖先段落；受保护的行内节点需要先按与取词相同的规则判断。
    const candidate = core.resolve(start);
    if (candidate) return {candidate};
    const focus = core.adapters.find(adapter => adapter.genericCandidatePolicy === 'targets-only');
    return focus ? {reason: 'rule-focus', ruleId: focus.id} : {reason: 'unrecognized'};
}

type DiagnosisSession = Pick<FullPageSession,
    'scope' | 'translationConfig' | 'unchangedCandidates' | 'userCancelledCandidates' | 'scheduled' | 'inFlightCandidates'>;

export function diagnosePageRuleSelection(
    start: Node | undefined, defaultScope: TranslationScope, session: DiagnosisSession | undefined,
    readSource: (candidate: TranslationCandidate) => string,
    isLanguageFiltered: (candidate: TranslationCandidate, settings: DiagnosisSession['translationConfig']) => boolean,
): PageRuleDiagnosis {
    const core = getCurrentTranslationCore(session?.scope ?? defaultScope);
    const page = {scope: core.scope, ruleIds: core.adapters.map(adapter => adapter.id)};
    if (!start) return {...page, selection: {reason: 'no-selection'}};
    const diagnosis = describeSelection(core, start);
    if (!('candidate' in diagnosis)) return {...page, selection: diagnosis};
    const {candidate} = diagnosis;
    const hit = {ruleId: candidate.adapterId, detail: candidate.adapterId ? candidate.reason : undefined};
    const withReason = (reason: PageRuleDiagnosis['selection']['reason']): PageRuleDiagnosis => ({
        ...page,
        selection: {reason, ...hit},
    });
    const owner = resolveTranslationStateNode(candidate);
    const phase = owner && getTranslationState(owner)?.phase;
    if (phase) return withReason(phase);
    if (!session) return withReason('inactive');

    const key = getTranslationCandidateKey(candidate);
    if (session.inFlightCandidates.has(key)) return withReason('loading');
    if (session.scheduled.has(key)) return withReason('waiting');
    const cancelled = session.userCancelledCandidates.get(key) ?? session.userCancelledCandidates.get(start);
    const unchanged = session.unchangedCandidates.get(key);
    if (cancelled !== undefined || unchanged) {
        const source = readSource(candidate);
        if (cancelled === source) return withReason('restored');
        if (sameLifecycleRetry(unchanged, candidate, source)) {
            return withReason(isLanguageFiltered(candidate, session.translationConfig) ? 'language-filtered' : 'unchanged');
        }
    }
    return withReason('unscheduled');
}
