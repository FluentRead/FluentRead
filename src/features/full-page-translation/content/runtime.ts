/**
 * @file src/features/full-page-translation/content/runtime.ts
 * 文件职责：实现全文翻译的页面级会话引擎，负责候选发现、可见性调度、批量请求、动态 DOM 重扫、失败重试、缓存复用和恢复原文；显式翻译与增量扫描共用 man7 手册段落准备，完整恢复与卸载清理对应包装。
 * 主要内容：已提交与在途结果复用原译文槽同步当前全局显示模式，显式快捷覆盖保持冻结；精确相同译文和有同目标语言证据的排版回显保留原文且不重复展示；以增量计数发布完成与失败摘要，仅对本会话失败目标重试和定位；维护 FullPageSession、AbortController、Intersection/Mutation 观察器、弹窗优先调度、精确属性写入过滤、候选所有权和生命周期重试；对变化来源等待安静窗口、跳过持续变化的计数，并清理延迟重扫，只有真实宿主删除启动候选与断连观察根回收，重连前保留已排队 DOM 记录，实际翻译 owner 通过公共端口为其开放根安装译文样式，SPA 切换刷新全部活观察根的站点属性依赖，同批重复属性变化只处理一次；按时间片派发并在全文结果提交前让出主线程，合并同段 DOM 写入并在重挂时复用同批布局读数与单文本来源快照；合成行内段在延迟 loading 前后都按精确来源节点、HTML 和 Text 槽识别自身迁移；已拥有状态的发现候选直接登记复验，取消记录命中后才提取原文，避免整批重扫重复计算熔断签名；连续滚动时限频派发当前可见候选，空闲后恢复预取，按阅读进度撤回离开预取区的待派发候选，冻结请求/展示配置与识别范围，在弹窗关闭后继续正文，按实际节点阶段发布进度及工具栏结果；悬浮按候选停留而非每次移动计时，同段复用冻结的独立服务与快捷方案配置，到期复验最新命中并在路由切换取消；同目标预检单独读取受保护规则约束的行内代码语言上下文，发送与渲染仍只使用可翻译文本槽；恢复单个所有者或全文时重置篇章证据，统一恢复原文并清理重挂预算及孤儿产物；向局部翻译开放单候选 translateTarget 与单个译文所有者的恢复入口。
 * 模块边界：这是 content 侧编排层，不实现 provider 协议、纯候选算法或底层状态存储；自动应用外壳许可在重试重新解析和所有者切换时保留来源，不降级为手动解析；翻译调用经 app client，发现规则来自 core/translation，渲染与状态分别交给 renderer、liveTextRender 和 state。
 * 动态保护：按钮标签属性变化重判来源，类型或提交名称失去资格时立即恢复和取消旧请求；合成段 loading 来源复验在惰性文档中复制子节点，只比较 HTML 并保留真实节点身份；独立扫描根按各自冷却就绪执行，新增就绪根可提前唤醒等待，扫描与选择均遵守时间片。
 * 多段准备：AI 多段开启时为一批相邻候选保留最小准备容量，实际网络请求并发继续由 client 队列和后台调度器约束。
 * 诊断接线：仅当前全文会话的真实失败进入共享分类器；成功、恢复和换路由清除，完整根扫描没有任何候选时提示无正文，目标语预检和离屏等待不影响候选存在证据。
 */
import {resetPageDiscourseContext} from '@/src/services/translation/context/pageDiscourse';
import {cloneTranslationElementInert} from '@/src/core/translation/inertClone';
import {prepareManpageContent, restoreManpageContent} from './manpagePreparation';
import {resolveTranslationToolbarStatus, countFullPageTranslationWork} from '../toolbarStatus';
import {hasDistinctTargetTranslation as hasDistinctTranslation} from '@/src/core/translation/targetResult';
import {getFullPageTranslationStateRevision, getFullPageTranslationDiagnostic, notifyFullPageTranslationDiagnostic, notifyFullPageTranslationState, notifyTranslationToolbarStatus} from './stateNotification';
import {diagnoseFailure, type Diagnostic} from '@/src/services/diagnostics';
import type {FrameTranslationState} from './frameSession';
import { checkConfig } from "@/src/features/full-page-translation/content/configCheck";
import {insertFailedTip} from '@/src/features/full-page-translation/ui/translationIndicators';
import {scheduleTranslationLoadingIndicator} from './loadingIndicator';
import {syncModalTranslationHint} from '../ui/modalProgressHint';
import { styles } from "@/src/core/config/constants";
import {
    extractTranslationText,
    extractTranslationTextFromNodes,
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    getComposedParent,
    getCurrentTranslationCore,
    getOpenShadowRoots,
    getTranslationCandidateKey,
    resolveTranslationCandidateAtPoint,
    selectPreferredTranslationCandidate,
} from "@/src/core/translation/public";
import type {
    TranslationCandidate,
    TranslationScope,
} from "@/src/core/translation/public";
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import { config } from "@/src/services/config/store";
import type { FullPageTranslationMode } from "@/src/core/config/model";
import { consumeEagerTranslationBudget } from "@/src/features/full-page-translation/content/eagerTranslation";
import {cancelTranslationQueueSession, createTranslationQueueSession} from "@/src/services/translation/queue";
import {
    finishFullPageTranslationProgress,
    getFullPageTranslationProgress,
    startFullPageTranslationProgress,
    updateFullPageTranslationProgress,
} from '@/src/features/full-page-translation/progress';
import {bindFullPageOutcomeRecovery, getFullPageOutcomeSummary, getFullPageModalOutcomePhases, registerFullPageOutcomeTarget} from './outcomeSession';
import {
    appendBilingualTranslation,
    materializeCandidate,
    materializeVisualTranslationCandidate,
} from "@/src/features/full-page-translation/content/renderer";
import {renderLiveTextResult} from "@/src/features/full-page-translation/content/liveTextRender";
import {ensureTranslationTruncationLayout} from "@/src/features/full-page-translation/content/layout";
import {blocksBilingualRemountCandidate, createBilingualRemountCapitulationRegistry,
    createRemovedTranslationOwnerResolver, createBilingualRemountPreparationBatch, forgetBilingualRemountCandidate, stabilizeBilingualArtifact,
    transferEquivalentBilingualOwners as adoptEquivalentBilingualOwners, type RemovedTranslationOwnerResolver}
    from '@/src/features/full-page-translation/content/bilingualRemount';
import {refreshTranslationDisplayMode as refreshBilingualTranslationSkeleton, syncTranslationDisplayMode} from './displayMode';
import {isAnchorNearViewport, TranslationSourceStabilityGate} from './sourceStabilityGate';
import {transferEquivalentSyntheticBilingualSegments} from
    '@/src/features/full-page-translation/content/syntheticRemount';
import {
    beginBilingualArtifactHostWriteGesture, beginTranslation,
    detachFailedTranslationUi,
    discardTranslation,
    getOwnedTranslationCandidateAtPoint, getTranslationState,
    isTranslationApplicationShellPolicyCurrent,
    resolveTranslationStateNode,
    getTranslationOwnersForRemovedNode,
    markTranslationComplete,
    markTranslationError,
    resetAllBilingualArtifactHostWriteBudgets,
    resetBilingualArtifactHostWriteBudget,
    restoreTranslation,
    createBilingualTranslationReplay,
    setBilingualContent,
    setBilingualArtifactCapitulationHandler,
    setBilingualLifecycleExternalManager,
    setBilingualOwnerRemountHandler,
    setBilingualSkeletonRefreshHandler,
    setRenderedStyleAttribute,
    setRetryWrapper,
    isTranslationLayoutOverrideMutation,
    type TranslationState,
} from "@/src/features/full-page-translation/content/state";
import {
    captureFullPageTranslationConfig,
    getFullPageTranslationCandidateConcurrency,
    getTranslationInvocationIdentity,
    waitForCaller,
    type FullPageTranslationConfigSnapshot, type FullPageTranslationSessionCache,
    type PageTranslationConfigOverrides,
} from '@/src/features/full-page-translation/content/translationRequest';
import {
    startFullPageTitleTranslation,
    stopFullPageTitleTranslation,
} from '@/src/features/full-page-translation/content/titleTranslation';
import {
    createFullPageScrollController,
    withFullPageViewportAnchor,
} from '@/src/features/full-page-translation/content/viewportStability';
import {noteFullPageScroll, queueFullPageCandidate, queueFullPageFailedCandidate, removeFullPagePending, createFullPageDispatchPlan, type FullPageDispatchPlan} from '@/src/features/full-page-translation/content/fullPageQueue';
import {FULL_PAGE_PREFETCH_MARGIN_PX} from '@/src/features/full-page-translation/content/fullPagePriority';
import {
    createLifecycleRetry, sameLifecycleRetry, createAcceptedUnchangedCompletion, readAcceptedUnchangedCompletion,
    type AcceptedUnchangedCompletion, canKeepTranslationAttempt,
    getCandidateTranslationTextProtectionOptions,
    isTranslationCandidateCurrent as candidateIsCurrent,
    inheritTranslationApplicationShellPolicy,
    isTranslationStateCandidateCurrent, createTranslationMutationStabilityChecks,
    isTranslationStateSourceCurrent as attemptSourceIsCurrent,
    TRANSLATION_ARTIFACT_SELECTOR,
    getCurrentTranslationStateTextNodes,
    getTranslationStateProtectionBoundary,
    getTranslationTextProtectionOptions,
    hasCurrentTranslationSource,
    isOwnCurrentArtifactAddition, isOwnStateArtifactMutation,
    isOwnSingleTextSlotMove,
    isTranslationArtifactCurrent,
    isTranslationArtifact,
    mutationTouchesCurrentTranslationArtifact,
    normalizeComparableText,
    statefulSourceAndTextSlotsAreCurrent,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    createTranslationRequest,
    type TranslationResult,
} from '@/src/features/full-page-translation/content/liveTextTranslation';
import {restorePageTranslationContent, consumeOrphanedOwnerClassMutation, isTextEquivalentHostReplacement, normalizeOrphanedSingleSlots, normalizeOrphanedTranslationArtifacts, normalizeOrphanedTranslationOwner}
    from '@/src/features/full-page-translation/content/orphanArtifacts';
import {bindFullPageRequestSessionAttempt, createAbortError, getHoverTranslationRequestSession, invalidateContextSensitiveRequestCache, invalidateFullPageRequestSessionCache, invalidateHoverTranslationRequestSession, resetHoverTranslationRequestSession} from '@/src/features/full-page-translation/content/requestSession';
import {resetFullPageRouteSession} from './routeLifecycle';
import type {HoverTranslationInvocation} from './hoverScheduler';
import {resolveFullPageVisibilityAnchor} from './visibilityAnchor';
import {createHoverRemountDispatch} from './hoverRemountDispatch';
import {personalCorrectionIsCurrent, registerPersonalCorrectionResult} from './personalCorrections';
import {getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {isElementNode, asHTMLElement, mutationTargetElement, isConnectedMutationRoot, allMutationNodesMatch, createMutationRescanSelector, createTranslationAttributeMutationFilter, createTranslationMutationObserverOptions, isOwnSyntheticSegmentMarkerMutation, mutationRootContains as nodeContains, collapseMutationRescanRoot as broadRescanRoot} from './mutationObservation';
import {isWithinTranslationModal, mayChangeTranslationModal} from './modalPriority';
import {refreshModalSession} from './modalSession';
import {createAttributeMutationBatch} from './attributeMutationBatch';
import {prepareTranslationStyleRoot} from './styleRoots';
import {createFullPageSessionState, type FullPageSession} from './fullPageSession';
const translationSourceStability = new TranslationSourceStabilityGate<FullPageSession>({
    isCurrent: session => session.active && fullPageSession === session,
    resolve: resolveFullPageRetryCandidate, discover: scheduleDiscoveredCandidate, source: candidateLifecycleSource,
    queue: queueFullPageCandidate, drain: scheduleFullPageDrain,
});
export type TranslationTargetOutcome =
    | {status: "committed" | "failed" | "owned"}
    | {status: "unchanged"; source: string; attemptNode?: HTMLElement; completion?: AcceptedUnchangedCompletion}
    | {
        status: "stale" | "not-current" | "empty";
        retryRoot?: Node;
        /** 尝试 owner，用于在较新的 generation 接管后拒绝旧重试。 */
        attemptNode?: HTMLElement;
        /** 仅在未取消的悬浮请求确认 owner 已脱离时允许受限重挂重试。 */
        detachedHoverAttempt?: boolean;
    };
const BROAD_RESCAN_COOLDOWN_MS = 1_000;
const mutationRescanWakeTimes = new WeakMap<FullPageSession, number>();
const CANDIDATE_PRUNE_BUDGET_MS = 4;
const STATEFUL_ATTRIBUTE_DEBOUNCE_MS = 500;
const FULL_PAGE_LIFECYCLE_RETRY_LIMIT = 2;

const hoverRemountDispatch = createHoverRemountDispatch({
    isAvailable: () => document.visibilityState !== 'hidden' && config.on !== false,
    isFullPageActive: () => fullPageSession?.active === true,
    captureCommitGuard: () => {const session = getHoverTranslationRequestSession(), generation = session.renderCommitGeneration; return () => getHoverTranslationRequestSession() === session && session.renderCommitGeneration === generation;},
    currentScope: () => config.translationScope,
    resolve: (x, y, scope) => getOwnedTranslationCandidateAtPoint(document, x, y) ?? resolveTranslationCandidateAtPoint(x, y, scope),
    captureConfig: overrides => captureFullPageTranslationConfig({...overrides,
        service: overrides.service?.trim() || config.hoverTranslationService || config.service}),
    identity: getTranslationInvocationIdentity, checkConfig, noteGesture: beginBilingualArtifactHostWriteGesture,
    translate: (candidate, snapshot, continuous) => translateTarget(candidate, snapshot.displayMode, continuous, undefined, snapshot),
    hasState: candidate => {const node = resolveTranslationStateNode(candidate); return Boolean(node && getTranslationState(node));},
    warn: error => console.warn('[FluentRead] hover translation failed:', error),
});
let fullPageSession: FullPageSession | null = null;
// 只记录当前路由是否真实发现过候选；目标语言预检和离屏调度均不能把正文误判为空。
const sessionsWithDiscoveredContent = new WeakSet<FullPageSession>();
type FullPageFailureDiagnostic = {diagnostic: Diagnostic; state: TranslationState; retryAt?: number};
const sessionFailureDiagnostics = new WeakMap<FullPageSession, Map<HTMLElement, FullPageFailureDiagnostic>>();
const sessionPublishedFailureDiagnostic = new WeakMap<FullPageSession, FullPageFailureDiagnostic>();
/** 按仍真实失败的 owner 保留最近分类；其他段成功、最后失败恢复或局部取消均不误用旧错误。 */
function syncFullPageFailureDiagnostic(session: FullPageSession): void {
    const failures = sessionFailureDiagnostics.get(session);
    if (!failures || fullPageSession !== session || !session.active) return;
    let latest: FullPageFailureDiagnostic | undefined;
    for (const [node, failure] of failures) {
        if (!node.isConnected || getTranslationState(node) !== failure.state || failure.state.phase !== 'error') failures.delete(node);
        else latest = failure;
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
}
let hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
setBilingualLifecycleExternalManager(() => fullPageSession?.active === true);
setBilingualOwnerRemountHandler((mutations) => transferEquivalentBilingualOwners(undefined, mutations));
// 宿主改写 title/href 等骨架属性时优先重建骨架复用已提交译文，而不是撕下译文重译。
setBilingualSkeletonRefreshHandler((owner, state) => refreshBilingualTranslationSkeleton(owner, state));
setBilingualArtifactCapitulationHandler((owner, state) => {
    const session = fullPageSession?.active ? fullPageSession : undefined;
    const sessionIdentity = session ? getTranslationInvocationIdentity(session.translationConfig) : undefined;
    const registry = session && state.translationInvocationIdentity === sessionIdentity
        ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations;
    const identityOwner = state.syntheticSegment ? state.syntheticHost : owner;
    const boundary = identityOwner?.parentNode;
    if (boundary) registry.remember(boundary, owner, state);
});
export type PageTranslationInvocation = PageTranslationConfigOverrides & {fullPageMode?: FullPageTranslationMode; scope?: TranslationScope};

function scheduleFullPageProgressPublish(session: FullPageSession): void {
    if (!session.active || session.progressPublishScheduled) return;
    session.progressPublishScheduled = true;
    queueMicrotask(() => {
        session.progressPublishScheduled = false;
        if (!session.active || fullPageSession !== session) return;

        const modal = session.modal;
        const eligible = (node: Node) => !modal || isWithinTranslationModal(modal, node);
        let scheduled = session.scheduled;
        let pending = session.pending.size;
        if (modal) {
            scheduled = new Map();
            for (const [key, candidate] of session.scheduled) if (eligible(candidate.element)) scheduled.set(key, candidate);
            pending = 0;
            for (const candidate of session.pending.values()) if (eligible(candidate.element)) pending += 1;
        }
        const work = countFullPageTranslationWork(session.inFlightCandidates, scheduled, pending);
        const deferred = session.scheduled.size - scheduled.size;
        const outcomes = getFullPageOutcomeSummary(session);
        syncFullPageFailureDiagnostic(session);
        const busy = work.running > 0 || work.queued > 0;
        // 普通页面直接用增量摘要；弹窗仅惰性检查其内部目标，不预先分配整页数组。
        const status = resolveTranslationToolbarStatus(busy, !modal ? outcomes.phases : getFullPageModalOutcomePhases(
            session, session.statefulTargetsByAncestor.get(document.documentElement) ?? [], getTranslationInvocationIdentity(session.translationConfig)));
        notifyTranslationToolbarStatus(session.modal && status === 'translated' ? 'idle' : status);
        const modalPhase = session.modal ? busy ? 'translating' : 'waiting' : 'none';
        syncModalTranslationHint(session.modal, modalPhase, config.translationProgressPanelEnabled === true);
        updateFullPageTranslationProgress(session.progressSessionId, {...work, deferred, modalPhase, completed: outcomes.completed, failed: outcomes.failed, retryable: outcomes.retryable});
    });
}

function candidateSourceText(
    candidate: TranslationCandidate,
    core: ReturnType<typeof getCurrentTranslationCore>,
    protectionOptions: ReturnType<typeof getCandidateTranslationTextProtectionOptions>,
): string {
    if (candidate.visualRange) {
        if (candidate.visualSourceText) return candidate.visualSourceText;
        try {
            const range = candidate.element.ownerDocument.createRange();
            range.setStart(candidate.visualRange.startContainer, candidate.visualRange.startOffset);
            range.setEnd(candidate.visualRange.endContainer, candidate.visualRange.endOffset);
            return range.toString();
        } catch {
            return '';
        }
    }
    if (candidate.nodes?.length) {
        return extractTranslationTextFromNodes(
            candidate.nodes,
            core.shouldStayOriginal,
            undefined,
            protectionOptions,
        );
    }
    return extractTranslationText(
        candidate.element,
        core.shouldStayOriginal,
        candidate.manualChunk ? candidate.element : undefined,
        protectionOptions,
    );
}
function transferEquivalentBilingualOwners(session: FullPageSession | undefined, mutations: readonly MutationRecord[]): RemovedTranslationOwnerResolver {
    const resolveRemovedOwners = createRemovedTranslationOwnerResolver();
    const sessionIdentity = session ? getTranslationInvocationIdentity(session.translationConfig) : undefined;
    const synthetic = transferEquivalentSyntheticBilingualSegments(
        mutations, ensureTranslationTruncationLayout, resolveRemovedOwners);
    synthetic.transfers.forEach(({owner, previousHost, replacementHost}) => {
        if (!session) return;
        unregisterSessionStatefulTarget(session, owner);
        registerSessionStatefulTarget(session, replacementHost, owner);
        removeScheduledForStateTarget(session, previousHost);
    });
    synthetic.capitulations.forEach(({owner, state, boundary}) => {
        (session && state.translationInvocationIdentity === sessionIdentity
            ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations)
            .remember(boundary, owner, state);
    });
    const result = adoptEquivalentBilingualOwners(mutations, createBilingualRemountPreparationBatch(), resolveRemovedOwners);
    result.transfers.forEach(({previousOwner, replacementOwner}) => {
        if (!session) return;
        unregisterSessionStatefulTarget(session, previousOwner); removeScheduledForStateTarget(session, previousOwner);
        if (getTranslationState(replacementOwner)?.translationInvocationIdentity === sessionIdentity) registerSessionStatefulTarget(session, replacementOwner, replacementOwner);
    });
    result.capitulations.forEach(({previousOwner, replacementOwner, boundary}) => {
        const state = getTranslationState(previousOwner);
        if (state) {
            (session && state.translationInvocationIdentity === sessionIdentity
                ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations)
                .remember(boundary, replacementOwner, state);
        }
    });
    return resolveRemovedOwners;
}
function discardStaleAttempt(
    node: HTMLElement,
    state: TranslationState,
): Node | undefined {
    const rescanRoot = state.syntheticSegment ? node.parentElement : node;
    if (getTranslationState(node) === state) {
        withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
    }
    return rescanRoot?.isConnected ? rescanRoot : undefined;
}

function markFailedTranslation(
    node: HTMLElement,
    candidate: TranslationCandidate,
    attempt: NonNullable<ReturnType<typeof beginTranslation>>,
    spinner: HTMLElement | undefined,
    error: unknown,
    owner?: FullPageSession, snapshot?: FullPageTranslationConfigSnapshot,
): TranslationTargetOutcome {
    if (!node.isConnected ||
        !attemptSourceIsCurrent(node, attempt.state) ||
        !markTranslationError(node, attempt.state, attempt.generation, false)) {
        return {
            status: "stale",
            retryRoot: discardStaleAttempt(node, attempt.state),
            attemptNode: node,
        };
    }
    const retryIsCurrent = () => node.isConnected && getTranslationState(node) === attempt.state && attempt.state.phase === 'error'
        && (!owner || owner.active && fullPageSession === owner);
    if (owner?.active && fullPageSession === owner) {
        const diagnostic = diagnoseFailure(error, {online: typeof navigator === 'undefined' ? undefined : navigator.onLine});
        if (diagnostic.code !== 'cancelled') {
            const failures = sessionFailureDiagnostics.get(owner) ?? new Map();
            failures.delete(node);
            failures.set(node, {diagnostic, state: attempt.state, ...(diagnostic.retryAfterMs ? {retryAt: Date.now() + diagnostic.retryAfterMs} : {})});
            sessionFailureDiagnostics.set(owner, failures);
            syncFullPageFailureDiagnostic(owner);
        }
    }
    const retry = (): boolean => {
        if (!retryIsCurrent()) return false;
        if (owner) return queueFullPageFailedCandidate(owner, candidate, attempt.state.sourceText,
            () => { scheduleFullPageProgressPublish(owner); scheduleFullPageDrain(owner); }, retryIsCurrent);
        const retrySnapshot = snapshot?.requestOverridesApplied ? snapshot : undefined;
        void translateTarget(candidate,
            retrySnapshot?.displayMode ?? (config.display === styles.bilingualTranslation ? "bilingual" : "single"),
            false, undefined, retrySnapshot, true);
        return true;
    };
    const retryWrapper = withFullPageViewportAnchor(() => {
        spinner?.remove();
        return insertFailedTip(node, error instanceof Error ? error.message : String(error || "翻译失败"), retry);
    }, [node]);
    if (owner?.active) {
        owner.outcomes.setRetry(node, retry);
        scheduleFullPageProgressPublish(owner);
    }
    setRetryWrapper(node, retryWrapper);
    setRenderedStyleAttribute(node);
    return {status: "failed"};
}

async function renderTranslation(
    node: HTMLElement,
    candidate: TranslationCandidate,
    attempt: NonNullable<ReturnType<typeof beginTranslation>>,
    request: Promise<TranslationResult>,
    snapshot: FullPageTranslationConfigSnapshot,
    requestSession: FullPageTranslationSessionCache, requestCommitGeneration: number,
    owner?: FullPageSession,
): Promise<TranslationTargetOutcome> {
    const { state, generation } = attempt;

    const staleOutcome = (detachedHoverAttempt = false): TranslationTargetOutcome => ({
        status: "stale",
        retryRoot: discardStaleAttempt(node, state),
        attemptNode: node,
        ...(detachedHoverAttempt ? {detachedHoverAttempt: true} : {}),
    });
    const detachedLayoutAttempt = () => !owner && !node.isConnected && state.layoutDetachedDiscard === true &&
        (requestSession.renderCommitGeneration ?? 0) === requestCommitGeneration;

    try {
        const result = await request;
        // 缓存命中/批量响应会在同一个微任务检查点完成很多段。给每个全文提交独立的
        // 浏览器任务，让输入与绘制能够穿插；让出后仍须复验取消、generation 和宿主节点。
        if (owner) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        if (state.controller.signal.aborted) return staleOutcome(detachedLayoutAttempt());
        if (import.meta.env.BROWSER !== 'userscript' && !await waitForCaller(
            personalCorrectionIsCurrent(result.personalCorrection, node), state.controller.signal,
        )) {
            // 旧节点脱离后章节上下文可能已不可读；不使用旧校订，而让通过身份复核的新节点重新查询。
            const detached = !owner && !node.isConnected && (requestSession.renderCommitGeneration ?? 0) === requestCommitGeneration &&
                (state.layoutDetachedDiscard === true || (!state.controller.signal.aborted && getTranslationState(node) === state));
            return staleOutcome(detached);
        }
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome(
            detachedLayoutAttempt());
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();
        const spinner = state.spinner;

        // 目标文本即使不变，class/role/可见性变化也可能把所有权移到另一语义块。
        // 提交前必须复验原 owner；行内段及纯文本 flex/grid 已物化到自有 owner，
        // 此时复核自有段的受保护来源和下方新骨架槽，不再把旧父元素当作同一候选。
        if (!node.isConnected) return staleOutcome(!owner);
        if (!attemptSourceIsCurrent(node, state) ||
            (node === candidate.element && !candidate.nodes?.length && !candidateIsCurrent(candidate))) return staleOutcome();

        if (result.kind === 'snapshot' && (result.staleInlineCode ||
            (result.inlineCodePacket && !result.inlineCodePacket.isCurrent()))) return staleOutcome();

        // 交互控件、仅译文正文和按钮属性共用替换式渲染；提交细节由渲染模块负责。
        if (result.kind === "control-value" || result.kind === "live-text") {
            const commit = renderLiveTextResult(node, state, generation, result,
                candidate.scope, snapshot.targetLanguage);
            if (commit === "committed") {
                if (state.kind === 'content') {
                    state.bilingualReplay = createBilingualTranslationReplay(result.sources, result.translations, snapshot);
                    syncTranslationDisplayMode(node, state, config.display, false, config.translationBeforeOriginal);
                }
                return {status: "committed"};
            }
            if (commit === "stale") return staleOutcome();
            if (commit === "unchanged") {
                return {status: "unchanged", source: state.sourceText, attemptNode: node};
            }
            return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
        }

        if (result.sources.length === 0 || result.translations.length !== result.sources.length) {
            withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
        }
        if (!result.translations.some((translation, index) =>
            hasDistinctTranslation(result.sources[index] ?? '', translation, snapshot.targetLanguage))) {
            const completion = owner && fullPageSession === owner && owner.scheduled.get(getTranslationCandidateKey(candidate)) === candidate
                ? createAcceptedUnchangedCompletion(node, candidate, state, generation, result.sources, result.translations,
                    {...snapshot, sessionId: owner.progressSessionId, renderCommitGeneration: requestCommitGeneration,
                        configIdentity: getTranslationInvocationIdentity(snapshot)}) : undefined;
            const discarded = withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "unchanged", source: state.sourceText, attemptNode: node, completion: discarded ? completion : undefined};
        }

        // 在提交时才构建输出骨架，因此宿主属性和安全结构（例如链接 href 从 /a
        // 变为 /b）来自当前 DOM；provider 译文仍绑定请求创建时捕获的精确有序原文。
        const core = getCurrentTranslationCore(candidate.scope);
        const freshSnapshot = createTranslationSourceSnapshot(
            node, core.shouldStayOriginal,
            getTranslationStateProtectionBoundary(node, state),
            getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
            core.shouldOmitFromTranslation,
        );
        const freshSources = freshSnapshot.slots.map((slot) => slot.source);
        if (freshSources.length !== result.sources.length ||
            freshSources.some((source, index) => source !== result.sources[index])) {
            return staleOutcome();
        }
        const translatedText = applyTranslationsToSnapshot(freshSnapshot, result.translations);
        if (!markTranslationComplete(node, state, generation, false)) {
            return staleOutcome();
        }
        // The host may have rebuilt equivalent source nodes while the provider
        // was loading. Rebase the committed generation to the live snapshot so
        // a deferred layout reevaluation does not mistake that harmless remount
        // for a second source edit.
        state.sourceTextNodes = getCurrentTranslationStateTextNodes(node, state);
        // 原文和输出骨架的只读校验完成后才撤下 loading；避免“先删 spinner → 强制
        // 重排校验 → 插译文 → 再重排”。两项 DOM 写入共用一次锚点事务。
        const content = withFullPageViewportAnchor(() => {
            spinner?.remove();
            state.sourceHTML = node.innerHTML;
            return appendBilingualTranslation(node, translatedText, {
                sourceSkeleton: freshSnapshot.clone, targetLanguage: snapshot.targetLanguage,
                style: snapshot.style, sourceText: result.sources.join('\n'),
                longParagraphLineBreak: snapshot.longParagraphLineBreak, translationBeforeOriginal: snapshot.translationBeforeOriginal,
            });
        }, [node]);
        setBilingualContent(node, content, createBilingualTranslationReplay(result.sources, result.translations,
            {...snapshot, inlineCodeTexts: result.inlineCodePacket?.codeTexts,
                inlineCodeClasses: result.inlineCodePacket?.codeClasses,
                inlineCodeSourceTexts: result.inlineCodePacket?.sourceTexts}));
        setRenderedStyleAttribute(node);
        if (import.meta.env.BROWSER !== 'userscript') registerPersonalCorrectionResult(node, state, result.personalCorrection);
        syncTranslationDisplayMode(node, state, config.display, false, config.translationBeforeOriginal);
        return {status: "committed"};
    } catch (error) {
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome(detachedLayoutAttempt());
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();
        if (node === candidate.element && !candidate.nodes?.length && !candidateIsCurrent(candidate)) return staleOutcome();
        return markFailedTranslation(node, candidate, attempt, state.spinner, error, owner, snapshot);
    }
}

function removeCandidateObservation(session: FullPageSession, key: Node): void {
    const anchor = session.candidateAnchors.get(key);
    if (!anchor) return;
    session.candidateAnchors.delete(key);
    const observed = session.observedCandidates.get(anchor);
    observed?.delete(key);
    if (observed?.size === 0) {
        session.observedCandidates.delete(anchor);
        session.observer.unobserve(anchor);
    }
}

function addCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    let keys = session.candidateOwnerKeys.get(owner);
    if (!keys) {
        keys = new Set();
        session.candidateOwnerKeys.set(owner, keys);
    }
    keys.add(key);
}

function removeCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    const keys = session.candidateOwnerKeys.get(owner);
    keys?.delete(key);
    if (keys?.size === 0) session.candidateOwnerKeys.delete(owner);
}

function unregisterSessionStatefulTarget(session: FullPageSession | undefined, target: HTMLElement, preserveOutcome = false): void {
    if (!session) return;
    if (!preserveOutcome) session.outcomes.update(target);
    const ancestors = session.statefulAncestorsByTarget.get(target);
    if (!ancestors) return;
    scheduleFullPageProgressPublish(session);
    session.statefulAncestorsByTarget.delete(target);
    for (const ancestor of ancestors) {
        const targets = session.statefulTargetsByAncestor.get(ancestor);
        targets?.delete(target);
        if (targets?.size === 0) session.statefulTargetsByAncestor.delete(ancestor);
    }
}

function rememberUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
    target: HTMLElement,
    state: TranslationState,
): void {
    const source = normalizeComparableText(state.sourceText || candidateLifecycleSource(candidate));
    const remember = (node: Node | null | undefined) => {
        if (node) session.userCancelledCandidates.set(node, source);
    };

    // 精确候选以元素作为 key；合成行内段以首个来源节点作为 key，因此需保留
    // 所有已捕获来源节点，才能跨过 restoreTranslation() 对片段的解包过程。
    remember(getTranslationCandidateKey(candidate));
    if (!candidate.nodes?.length) remember(candidate.element);
    state.sourceTextNodes?.forEach((node) => remember(node));
    state.syntheticSourceNodes?.forEach((node) => remember(node));
    remember(target);
}

function isUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
): boolean {
    let source: string | undefined;
    const identities = [
        getTranslationCandidateKey(candidate),
        ...(candidate.nodes ?? []),
    ];
    let cancelled = false;
    identities.forEach((identity) => {
        const cancelledSource = session.userCancelledCandidates.get(identity);
        if (cancelledSource === undefined) return;
        source ??= candidateLifecycleSource(candidate);
        if (cancelledSource === source) {
            cancelled = true;
        } else {
            // 宿主复用同一 DOM 节点承载了不同内容，之前的用户取消不能屏蔽新原文。
            session.userCancelledCandidates.delete(identity);
        }
    });
    return cancelled;
}

function registerSessionStatefulTarget(
    session: FullPageSession | undefined,
    candidateOwner: HTMLElement,
    target: HTMLElement,
): void {
    prepareTranslationStyleRoot(target);
    if (!session?.active) return;
    unregisterSessionStatefulTarget(session, target, true);
    const ancestors: Element[] = [];
    let current: Element | null = candidateOwner;
    let depth = 0;
    while (current && depth < 512) {
        depth += 1;
        ancestors.push(current);
        let targets = session.statefulTargetsByAncestor.get(current);
        if (!targets) {
            targets = new Set();
            session.statefulTargetsByAncestor.set(current, targets);
        }
        targets.add(target);
        current = getComposedParent(current);
    }
    session.statefulAncestorsByTarget.set(target, ancestors);
    registerFullPageOutcomeTarget(session, target, getTranslationInvocationIdentity(session.translationConfig));
    scheduleFullPageProgressPublish(session);
}

function refreshCandidateVisibilityBinding(
    session: FullPageSession,
    key: Node,
    candidate: TranslationCandidate,
): void {
    if (session.translationMode === "all" || (session.modal && isWithinTranslationModal(session.modal, candidate.element)) || consumeEagerTranslationBudget(session, key, candidate)) {
        // “翻译到网页底部”和免滚动预翻译都只绕过视口门禁，不操纵页面滚动位置；初次扫描和后续 mutation 发现的内容都进入同一受限队列。
        removeCandidateObservation(session, key);
        queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        scheduleFullPageDrain(session);
        return;
    }

    const target = asHTMLElement(candidate.element);
    const nextAnchor = target?.isConnected ? resolveFullPageVisibilityAnchor(target) : null;
    const currentAnchor = session.candidateAnchors.get(key) ?? null;

    if (currentAnchor === nextAnchor && (nextAnchor !== null || session.pending.has(key))) return;
    removeCandidateObservation(session, key);

    if (!nextAnchor) {
        // 已可见候选的 display:contents 子树重建时仍应保持 pending；若它仍在等待
        // 旧锚点，直接调度是唯一不会丢失可见性的回退方式。
        if (!session.pending.has(key)) {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        }
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
        return;
    }

    let observed = session.observedCandidates.get(nextAnchor);
    const alreadyObserved = Boolean(observed);
    if (!observed) {
        observed = new Map();
        session.observedCandidates.set(nextAnchor, observed);
    }
    observed.set(key, candidate);
    session.candidateAnchors.set(key, nextAnchor);
    session.observer.observe(nextAnchor);
    // observe() 对已观察且仍可见的元素不会再次派发入视口事件。增量发现
    // 可能在首个同容器候选完成后才登记其余歌词行，此时直接唤醒新候选。
    if (session.visibleCandidateAnchors.has(nextAnchor) &&
        (alreadyObserved || isAnchorNearViewport(nextAnchor))) {
        queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        scheduleFullPageDrain(session);
    } else if (!alreadyObserved) {
        session.visibleCandidateAnchors.delete(nextAnchor);
    }
    scheduleFullPageProgressPublish(session);
}

function forgetCandidate(session: FullPageSession | undefined, candidate: TranslationCandidate): void {
    if (!session) return;
    const key = getTranslationCandidateKey(candidate);
    const removedPending = removeFullPagePending(session, key, candidate);
    if (session.scheduled.get(key) !== candidate) {
        if (removedPending) scheduleFullPageProgressPublish(session);
        return;
    }
    session.scheduled.delete(key);
    removeCandidateObservation(session, key);
    removeCandidateOwnerKey(session, candidate.element, key);
    scheduleFullPageProgressPublish(session);
}

export async function translateTarget(candidate: TranslationCandidate, displayMode: "bilingual" | "single", slide: boolean,
    owner?: FullPageSession,
    translationConfigOverride?: FullPageTranslationConfigSnapshot,
    forceFailedRequest = false,
): Promise<TranslationTargetOutcome> {
    if (!candidate.element.isConnected) return {status: "not-current"};
    const statefulSession = owner?.active ? owner : fullPageSession?.active ? fullPageSession : undefined;
    statefulSession?.unchangedCandidates.delete(getTranslationCandidateKey(candidate));
    const remountCapitulations = statefulSession?.bilingualRemountCapitulations ?? hoverBilingualRemountCapitulations;
    const translationConfig = owner?.active ? owner.translationConfig
        : translationConfigOverride ?? captureFullPageTranslationConfig();
    const requestOwner = statefulSession?.active && getTranslationInvocationIdentity(statefulSession.translationConfig) === getTranslationInvocationIdentity(translationConfig) ? statefulSession : undefined;
    const requestSession = requestOwner ?? getHoverTranslationRequestSession(); const requestCommitGeneration = requestSession.renderCommitGeneration ?? 0;
    const existingNode = resolveTranslationStateNode(candidate);
    const current = existingNode ? getTranslationState(existingNode) : undefined;
    if (!isTranslationApplicationShellPolicyCurrent(candidate.element, candidate) ||
        (current && existingNode && !isTranslationApplicationShellPolicyCurrent(existingNode, current))) {
        if (existingNode && current) {
            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
        }
        return {status: 'not-current'};
    }
    if (current?.applicationShellPolicyId && !candidate.applicationShellPolicyId) {
        candidate = {...candidate, applicationShellPolicyId: current.applicationShellPolicyId};
    }
    if (existingNode && (current?.phase === "loading" || current?.phase === "translated")) {
        const nextIdentity = getTranslationInvocationIdentity(translationConfig);
        const shouldSwitchProfile = Boolean(nextIdentity && current.translationInvocationIdentity !== nextIdentity);
        if (current.phase === "loading" && !shouldSwitchProfile) return {status: "owned"};
        const retryAnchor = candidate.nodes?.[0] ?? existingNode;

        // 连续滑动是 ensure-visible，不是单次 toggle。内存中的 translated
        // 只有在原文快照和真实译文工件都完整时才能短路；宿主仅删除
        // wrapper 时先原子重挂，不发起新请求。
        if (current.phase === "translated" && slide && !shouldSwitchProfile) {
            const disposition = stabilizeBilingualArtifact(
                existingNode, current, remountCapitulations, ensureTranslationTruncationLayout);
            if (disposition === 'current') return {status: "committed"};
            // 结构签名或工件属性被宿主改写、但可译文本未变时，按当前 DOM 重建骨架
            // 并复用已提交译文；不能因此撤下译文重新请求。
            if (refreshBilingualTranslationSkeleton(existingNode, current)) return {status: 'committed'};

            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
            if (disposition === 'capitulated') return {status: 'owned'};
            if (!retryAnchor.isConnected) {
                return {status: "not-current", retryRoot: candidate.element.isConnected ? candidate.element : undefined};
            }
            const refreshedCandidate = inheritTranslationApplicationShellPolicy(candidate, getCurrentTranslationCore(candidate.scope).resolve(retryAnchor));
            return refreshedCandidate
                ? translateTarget(
                    refreshedCandidate,
                    displayMode,
                    slide,
                    owner,
                    translationConfigOverride,
                    forceFailedRequest,
                )
                : {status: "not-current", retryRoot: candidate.element.isConnected ? candidate.element : undefined};
        }

        if (statefulSession?.active && fullPageSession === statefulSession) {
            rememberUserCancelledCandidate(statefulSession, candidate, existingNode, current);
        }
        unregisterSessionStatefulTarget(statefulSession, existingNode);
        resetPageDiscourseContext();
        withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
        if (shouldSwitchProfile && retryAnchor.isConnected) {
            const refreshedCandidate = inheritTranslationApplicationShellPolicy(candidate, getCurrentTranslationCore(candidate.scope).resolve(retryAnchor));
            if (refreshedCandidate) return translateTarget(
                refreshedCandidate, displayMode, slide, owner, translationConfigOverride, forceFailedRequest);
        }
        return {status: current.phase === "loading" ? "owned" : "committed"};
    }
    if (current?.phase === "error" && existingNode) {
        if (slide && current.translationInvocationIdentity === getTranslationInvocationIdentity(translationConfig)) return {status: 'owned'};
        if (current.syntheticSegment) {
            const sourceNodes = Array.from(existingNode.childNodes).filter((node) =>
                !isElementNode(node) || !node.matches('[data-fr-translation-owned="true"]'),
            );
            const sourceAnchor = sourceNodes.find((node) =>
                normalizeComparableText(node.textContent ?? node.nodeValue ?? "").length > 0,
            ) ?? sourceNodes[0];
            const retryRoot = existingNode.parentElement ?? undefined;
            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
            if (!sourceAnchor?.isConnected) return {status: "not-current", retryRoot};
            const refreshedCandidate = inheritTranslationApplicationShellPolicy(candidate, getCurrentTranslationCore(candidate.scope).resolve(sourceAnchor));
            if (!refreshedCandidate) return {status: "not-current", retryRoot};
            return translateTarget(
                refreshedCandidate, displayMode, slide, owner, translationConfigOverride, forceFailedRequest);
        }
        unregisterSessionStatefulTarget(statefulSession, existingNode);
        withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
    }

    if (!candidateIsCurrent(candidate)) {
        return {
            status: "not-current",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }

    const core = getCurrentTranslationCore(candidate.scope);
    const candidateProtectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
    const sourceText = candidateSourceText(candidate, core, candidateProtectionOptions);
    if (!normalizeComparableText(sourceText)) {
        return {
            status: "empty",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }
    // 安静窗口由自动全文 owner 负责重新派发；手动悬浮没有该队列，不能静默吞掉已明确请求的新来源。
    if (owner?.active && translationSourceStability.blocks(candidate, sourceText, owner)) return {status: 'unchanged', source: sourceText};
    if (slide && displayMode === 'bilingual' && blocksBilingualRemountCandidate(remountCapitulations, candidate.element, sourceText,
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(translationConfig), candidate.nodes, candidate.scope)) return {status: 'owned'};
    if (!slide) {
        resetBilingualArtifactHostWriteBudget(candidate.element);
        forgetBilingualRemountCandidate(remountCapitulations, candidate.element, sourceText,
            candidate.allowTopLevelApplicationShell === true, getTranslationInvocationIdentity(translationConfig),
            candidate.nodes, candidate.scope);
    }

    // 同语言检测只是节流优化；不确定、短 Latin 与纯 Han 必须 fail-open，
    // 否则日中混合标题或法德短文会在 provider 之前静默漏译。
    if (shouldSkipTranslationForTarget(
            candidateSourceText(candidate, core, {...candidateProtectionOptions, includeInlineCodeForLanguage: true}),
            translationConfig.targetLanguage, translationConfig.excludedLanguages)) {
        return {status: "unchanged", source: sourceText};
    }

    if (candidate.visualRange) {
        const visualCandidate = withFullPageViewportAnchor(
            () => materializeVisualTranslationCandidate(candidate),
            [candidate.element],
        );
        if (!visualCandidate) {
            return {
                status: "not-current",
                retryRoot: candidate.element.isConnected ? candidate.element : undefined,
            };
        }
        candidate = visualCandidate;
    }

    const materialized = candidate.nodes?.length && !candidate.manualChunk
        ? withFullPageViewportAnchor(() => materializeCandidate(candidate, displayMode === 'bilingual'), [candidate.element])
        : materializeCandidate(candidate, displayMode === 'bilingual');
    if (!materialized) {
        return {
            status: "not-current",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }
    const {node, synthetic} = materialized;
    normalizeOrphanedTranslationOwner(node);

    const kind = candidate.kind;
    // 捕获每个候选中可翻译 Text 节点的精确身份。renderer 可能在提交后只替换受保护的
    // MathJax/KaTeX 子节点；仅比较原文无法区分这种无害事务与同文本宿主/链接替换，
    // 后者会使已渲染快照失效。
    const sourceTextNodes = collectLiveTranslationTextSlots(
        node,
        core.shouldStayOriginal,
        synthetic ? node : undefined,
        getTranslationTextProtectionOptions(candidate.allowTopLevelApplicationShell, node),
    ).map((slot) => slot.node);
    const attempt = beginTranslation(
        node,
        displayMode,
        kind,
        synthetic,
        sourceText,
        sourceTextNodes,
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(translationConfig),
        candidate.scope,
        candidate.applicationShellPolicyId,
    );
    if (!attempt) {
        if (synthetic) {
            withFullPageViewportAnchor(() => node.replaceWith(...Array.from(node.childNodes)), [node]);
        }
        return {status: "owned"};
    }
    // 请求必须在 spinner 插入前创建；微软 HTML 克隆和文本节点快照不能把
    // 插件自己的 loading 元素送到服务端。
    const requestProtectionOptions = getTranslationTextProtectionOptions(candidate.allowTopLevelApplicationShell, node);
    const queueSession = createTranslationQueueSession();
    const signal = attempt.state.controller.signal;
    const releaseRequestSession = bindFullPageRequestSessionAttempt(requestSession, attempt.state.controller);
    const cancelQueuedRequest = () => cancelTranslationQueueSession(queueSession, createAbortError());
    signal.addEventListener('abort', cancelQueuedRequest, {once: true});
    const request = waitForCaller(createTranslationRequest(
        node,
        kind,
        displayMode,
        translationConfig,
        signal,
        queueSession,
        requestSession,
        requestProtectionOptions,
        forceFailedRequest,
        candidate.scope,
        () => getTranslationState(node) === attempt.state ? attempt.state.spinner : undefined,
    ), signal)
        .finally(() => { signal.removeEventListener('abort', cancelQueuedRequest); });
    if (synthetic) node.setAttribute('data-fr-translation-segment', 'true');
    const cancelLoading = scheduleTranslationLoadingIndicator(node, attempt.state, Boolean(owner));
    registerSessionStatefulTarget(statefulSession, candidate.element, node);
    const outcome = await renderTranslation(
        node,
        candidate,
        attempt,
        request.finally(cancelLoading),
        translationConfig,
        requestSession,
        requestCommitGeneration,
        requestOwner,
    ).finally(() => {
        releaseRequestSession();
        if (statefulSession) scheduleFullPageProgressPublish(statefulSession);
    });
    if ((outcome.status === "stale" || outcome.status === "not-current" || outcome.status === "empty" ||
        outcome.status === "unchanged") && (!getTranslationState(node) || getTranslationState(node) === attempt.state)) {
        unregisterSessionStatefulTarget(statefulSession, node);
    }
    return outcome;
}

function candidateLifecycleSource(candidate: TranslationCandidate): string {
    try {
        const core = getCurrentTranslationCore(candidate.scope);
        const protectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
        return normalizeComparableText(candidateSourceText(candidate, core, protectionOptions));
    } catch {
        return normalizeComparableText(candidate.element.textContent ?? "");
    }
}

function resolveFullPageRetryCandidate(
    candidate: TranslationCandidate,
    retryRoot?: Node,
): TranslationCandidate | null {
    const core = getCurrentTranslationCore(candidate.scope);
    const key = getTranslationCandidateKey(candidate);
    const starts = [retryRoot, key, candidate.element];
    const visited = new Set<Node>();

    for (const start of starts) {
        if (!start || visited.has(start) || !start.isConnected) continue;
        visited.add(start);
        const fresh = inheritTranslationApplicationShellPolicy(candidate, core.resolve(start));
        if (fresh?.element.isConnected) return fresh;
    }

    if (!candidate.element.isConnected) return null;
    return inheritTranslationApplicationShellPolicy(candidate, core.inspect(candidate.element).candidate);
}

function finalizeFullPageCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
    outcome: TranslationTargetOutcome,
): void {
    const originalKey = getTranslationCandidateKey(candidate);

    // mutation 重启或更新的发现 generation 可能已替换 scheduled 条目；
    // 旧 provider 结果不能删除新 owner，也不能替它重新排队。
    if (!session.active || fullPageSession !== session || session.scheduled.get(originalKey) !== candidate) return;

    if (outcome.status !== "stale" && outcome.status !== "not-current" && outcome.status !== "empty") {
        session.lifecycleRetries.delete(originalKey);
        if (outcome.status === "unchanged") {
            if (outcome.attemptNode && session.statefulAttributeTimers.has(outcome.attemptNode)) {
                session.statefulAttributeRescanTargets.add(outcome.attemptNode);
            }
            session.unchangedCandidates.set(
                originalKey,
                createLifecycleRetry(candidate, outcome.source, 0, outcome.completion),
            );
        } else {
            session.unchangedCandidates.delete(originalKey);
        }
        forgetCandidate(session, candidate);
        return;
    }

    session.unchangedCandidates.delete(originalKey);

    // 新的悬浮/全文 generation 已拥有同一节点，其完成结果才是权威；
    // 旧 generation 不得重复发起请求。
    if (outcome.attemptNode && getTranslationState(outcome.attemptNode)) {
        session.lifecycleRetries.delete(originalKey);
        forgetCandidate(session, candidate);
        return;
    }

    // mutation 流水线会刻意防抖 class/style 变化，应保留这次唯一重扫，
    // 不要再用即时重试与其竞争。
    if (outcome.attemptNode && session.statefulAttributeTimers.has(outcome.attemptNode)) {
        session.statefulAttributeRescanTargets.add(outcome.attemptNode);
        forgetCandidate(session, candidate);
        return;
    }

    const fresh = resolveFullPageRetryCandidate(candidate, outcome.retryRoot);
    if (fresh && candidate.element.isConnected && (
        fresh.element !== candidate.element ||
        fresh.kind !== candidate.kind ||
        getTranslationCandidateKey(fresh) !== originalKey
    )) {
        // 同一实时 DOM 子树改变了语义所有权，这是新的 DOM generation；缓存身份
        // 已含完整原文。只有真正依赖周边内容的 AI 上下文结果需全量失效，普通
        // 服务继续按槽复用，避免一个局部 mutation 冲掉整页去重。
        invalidateContextSensitiveRequestCache(session);
    }
    const retryCandidate = fresh ?? candidate;
    const retryKey = fresh ? getTranslationCandidateKey(fresh) : originalKey;
    const source = candidateLifecycleSource(retryCandidate);
    const previous = session.lifecycleRetries.get(retryKey) ?? session.lifecycleRetries.get(originalKey);
    const attempts = sameLifecycleRetry(previous, retryCandidate, source)
        ? previous!.attempts + 1
        : 1;
    const retryState = createLifecycleRetry(retryCandidate, source, attempts);

    if (retryKey !== originalKey) session.lifecycleRetries.delete(originalKey);
    session.unchangedCandidates.delete(retryKey);
    session.lifecycleRetries.set(retryKey, retryState);
    forgetCandidate(session, candidate);

    if (attempts > FULL_PAGE_LIFECYCLE_RETRY_LIMIT) return;

    if (fresh) {
        scheduleDiscoveredCandidate(session, fresh);
        if (session.scheduled.get(retryKey) === fresh) {
            // 原候选已经通过可见性门禁，应直接重试新解析出的 owner；
            // 若 IntersectionObserver 不再派发，重新观察可能永远等待。
            queueFullPageCandidate(session, retryKey, fresh, candidateLifecycleSource(fresh));
            scheduleFullPageDrain(session);
        }
        return;
    }

    if (outcome.retryRoot?.isConnected) enqueueFullPageRescan(session, outcome.retryRoot);
}

function scheduleFullPageDrain(session: FullPageSession): void {
    if (!session.active || session.flushTimer !== null) return;
    session.flushTimer = window.setTimeout(() => {
        session.flushTimer = null;
        drainFullPage(session);
    }, session.scrollController.isScrolling ? 120 : 0);
}

function refreshFullPageModal(session: FullPageSession): void {
    refreshModalSession(session, {
        forget: candidate => forgetCandidate(session, candidate),
        unregister: target => unregisterSessionStatefulTarget(session, target),
        discover: candidate => scheduleDiscoveredCandidate(session, candidate),
        promote: (key, candidate) => refreshCandidateVisibilityBinding(session, key, candidate),
        rescan: root => enqueueFullPageRescan(session, root),
        publish: () => scheduleFullPageProgressPublish(session),
        drain: () => scheduleFullPageDrain(session),
    });
}

function drainFullPage(session: FullPageSession): void {
    if (!session.active || session.draining) return;
    const scrolling = session.scrollController.isScrolling;
    refreshFullPageModal(session);
    session.draining = true;
    const maxConcurrent = getFullPageTranslationCandidateConcurrency(session.translationConfig, config.maxConcurrentTranslations);
    const startedAt = performance.now();
    let scrollingDispatches = 0;
    let needsAnotherSlice = false;

    // 有空闲槽时才集中测量锚点；一轮派发内复用，避免 loading 写入后重复读取布局。
    let plan: FullPageDispatchPlan | undefined;
    while (session.active && session.inFlightCandidates.size < maxConcurrent && session.pending.size > 0) {
        plan ??= createFullPageDispatchPlan(session, {now: Date.now(), viewportHeight: window.innerHeight, visibleOnly: scrolling,
            isEligible: candidate => !session.modal || isWithinTranslationModal(session.modal, candidate.element),
            resolveSource: candidateLifecycleSource});
        const selection = plan.next();
        if (!selection) break;
        const {key, candidate, priority} = selection;
        if (session.pendingMetadata.get(key)?.retryIsCurrent?.() === false) {
            forgetCandidate(session, candidate);
            continue;
        }
        const forceFailedRequest = session.pendingMetadata.get(key)?.forceFailedRequest === true;
        removeFullPagePending(session, key, candidate);
        session.inFlightCandidates.set(key, candidate);
        if (priority.band === 'background') session.foregroundDispatchesSinceBackground = 0;
        else session.foregroundDispatchesSinceBackground += 1;
        void translateTarget(candidate, session.translationConfig.displayMode, !forceFailedRequest, session, undefined, forceFailedRequest)
            .then(
                (outcome) => finalizeFullPageCandidate(session, candidate, outcome),
                (error) => {
                    // 意外 runtime 异常保留原有终止行为；provider 失败会由
                    // translateTarget 显式表示，并在到达此处前渲染重试 UI。
                    if (session.active && fullPageSession === session) {
                        const diagnostic = diagnoseFailure(error, {online: typeof navigator === 'undefined' ? undefined : navigator.onLine});
                        notifyFullPageTranslationDiagnostic(diagnostic.code === 'cancelled' ? undefined : diagnostic);
                    }
                    forgetCandidate(session, candidate);
                },
            )
            .finally(() => {
                if (session.inFlightCandidates.get(key) === candidate) {
                    session.inFlightCandidates.delete(key);
                }
                if (session.active) {
                    scheduleFullPageProgressPublish(session);
                    scheduleFullPageDrain(session);
                }
            });
        // 每个 120ms 滚动批次最多三个可见候选，保留原生合批，仍受原并发上限与 8ms 切片约束。
        if ((scrolling && ++scrollingDispatches >= 3) || performance.now() - startedAt >= 8) {
            needsAnotherSlice = session.inFlightCandidates.size < maxConcurrent && session.pending.size > 0;
            break;
        }
    }
    session.draining = false;
    if (needsAnotherSlice) scheduleFullPageDrain(session);
    scheduleFullPageProgressPublish(session);
}

function scheduleDiscoveredCandidate(session: FullPageSession, candidate: TranslationCandidate): void {
    sessionsWithDiscoveredContent.add(session);
    if (getFullPageTranslationDiagnostic()?.code === 'no-content') notifyFullPageTranslationDiagnostic(undefined);
    const target = asHTMLElement(candidate.element);
    if (!session.active || !target || !target.isConnected) return;
    const key = getTranslationCandidateKey(candidate);
    if (isUserCancelledCandidate(session, candidate)) {
        // 用户显式取消后的恢复 mutation 仍会被全文会话观察到。丢弃重新发现的候选前
        // 必须移除旧队列条目，否则延迟的可见性回调会再次引入它。
        const queuedCandidate = session.scheduled.get(key);
        if (queuedCandidate) {
            forgetCandidate(session, queuedCandidate);
        } else if (session.pending.get(key) === candidate) {
            removeFullPagePending(session, key, candidate);
            removeCandidateObservation(session, key);
            scheduleFullPageProgressPublish(session);
        }
        return;
    }
    if (session.scope === 'all') {
        let ancestor = getComposedParent(target);
        while (ancestor) {
            const ancestorState = getTranslationState(ancestor as HTMLElement);
            if (ancestorState) {
                registerSessionStatefulTarget(session, ancestor as HTMLElement, ancestor as HTMLElement);
                return;
            }
            ancestor = getComposedParent(ancestor);
        }
    }
    const targetState = getTranslationState(target);
    if (targetState) {
        // 悬浮翻译可能在全文会话创建前提交此状态。只把它加入本会话的观察型祖先索引，
        // 不替换状态的 generation/controller 所有权，使祖先硬门禁仍能恢复它，
        // 正常会话清理也能删除该索引。
        registerSessionStatefulTarget(session, candidate.element, target);
        // 祖先 class/style mutation 可能改变翻译目标内实际可见的标签。发现流程仍会到达
        // 同一候选，因此安排防抖后的来源/文本槽检查，不静默跳过也不无条件重试。
        scheduleStatefulAttributeReevaluation(session, target);
        // loading/error/translated 对通用发现都属于终态；显式来源/结构 mutation
        // 会通过 observer 重新启动它们。
        return;
    }
    if (session.translationConfig.displayMode === 'bilingual' && blocksBilingualRemountCandidate(
        session.bilingualRemountCapitulations,
        target,
        candidateLifecycleSource(candidate),
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(session.translationConfig),
        candidate.nodes,
        candidate.scope,
    )) return;
    const unchanged = session.unchangedCandidates.get(key);
    const cappedRetry = session.lifecycleRetries.get(key);
    if (unchanged || (cappedRetry && cappedRetry.attempts > FULL_PAGE_LIFECYCLE_RETRY_LIMIT)) {
        const source = candidateLifecycleSource(candidate);
        if (sameLifecycleRetry(unchanged ?? cappedRetry, candidate, source)) return;
        session.unchangedCandidates.delete(key);
        session.lifecycleRetries.delete(key);
    }

    // 很大的祖先仍在后续帧切片中发现时，精确后代可能已经完成。完成后 scheduled 条目会
    // 被有意遗忘，因此接受迟到的通用候选前还要检查共享 key 上的状态。
    const keyedTarget = asHTMLElement(key);
    if (keyedTarget && getTranslationState(keyedTarget)) {
        registerSessionStatefulTarget(session, candidate.element, keyedTarget);
        scheduleStatefulAttributeReevaluation(session, keyedTarget);
        return;
    }

    // 后序发现可能在祖先上产生通用行内段，而其首节点同时是精确 adapter 目标的 key。
    // 必须保留站点的显式决策，否则 GitHub 的 `.markdown-title` 候选会被合成父段替代，
    // 标题自身将永远无法拥有译文 wrapper。
    const existing = session.scheduled.get(key);
    if (existing) {
        if (selectPreferredTranslationCandidate(existing, candidate) === existing) {
            // 稳定候选可能比用作 IO 目标的已渲染后代存活更久；hydration 与显示变化
            // 必须刷新锚点，但不能替换 scheduled/pending 所有权。
            refreshCandidateVisibilityBinding(session, key, existing);
            return;
        }
        removeCandidateObservation(session, key);
        removeCandidateOwnerKey(session, existing.element, key);
        if (session.pending.has(key)) {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        }
    }
    session.scheduled.set(key, candidate);
    addCandidateOwnerKey(session, target, key);
    refreshCandidateVisibilityBinding(session, key, candidate);
    scheduleFullPageProgressPublish(session);
}

/**
 * React/Vue 页面每个滚动帧可能产生数百个 style/class mutation。observer 回调
 * 保持 O(records)，合并重叠脏子树后以短任务发现，使宿主输入/滚动回调持续运行。
 */
function enqueueFullPageRescan(session: FullPageSession, changedNode: Node): void {
    if (!session.active) return;
    const root = changedNode.nodeType === 3 ? changedNode.parentElement : changedNode;
    if (!root || !isConnectedMutationRoot(root)) return;

    const dirtyRoot: Node = root;

    // React/Reddit mutation 风暴期间限制单条记录的工作量；不相交根积累到一定数量后，
    // 一次增量根扫描比二次复杂度的两两合并更便宜，同时保持正确性。
    if (session.dirtyRootsBroadMode) {
        const collapsed = broadRescanRoot(dirtyRoot);
        session.dirtyRoots.add(collapsed);
        session.broadRescanRoots.add(collapsed);
    } else if (session.dirtyRoots.size >= 32) {
        const collapsedRoots = new Set<Node>(
            [...session.dirtyRoots, dirtyRoot].map(broadRescanRoot),
        );
        session.dirtyRoots.clear();
        collapsedRoots.forEach((collapsed) => {
            session.dirtyRoots.add(collapsed);
            session.broadRescanRoots.add(collapsed);
        });
        // 一轮突发越过合并阈值后，只加入其宽范围 Document/ShadowRoot，使新 mutation
        // 在本批完全排空前保持 O(1)；绝不丢弃另一棵 composed tree 的根。
        session.dirtyRootsBroadMode = true;
    } else {
        for (const existing of session.dirtyRoots) {
            if (nodeContains(existing, dirtyRoot)) return;
            if (nodeContains(dirtyRoot, existing)) session.dirtyRoots.delete(existing);
        }
        session.dirtyRoots.add(dirtyRoot);
    }
    const queuedRoot = session.dirtyRootsBroadMode ? broadRescanRoot(dirtyRoot) : dirtyRoot;
    const notBefore = session.broadRescanRoots.has(queuedRoot)
        ? session.broadRescanCooldowns.get(queuedRoot) ?? 0 : 0;
    scheduleMutationRescan(session, Math.max(50, notBefore - performance.now()));
}

/** 新就绪根只提前唤醒，不因后续 mutation 推迟已有任务或重复轮询冷却根。 */
function scheduleMutationRescan(session: FullPageSession, delay: number): void {
    const wakeAt = performance.now() + delay;
    if (session.mutationFlushTimer !== null) {
        if ((mutationRescanWakeTimes.get(session) ?? 0) <= wakeAt) return;
        window.clearTimeout(session.mutationFlushTimer);
    }
    mutationRescanWakeTimes.set(session, wakeAt);
    session.mutationFlushTimer = window.setTimeout(() => flushMutationRescans(session), delay);
}

/** 扩大范围仅重建展示类型变化或新增可译 Text 槽的 owner，其余正文和在途请求保持不变。 */
function upgradeFullPageTargetScope(session: FullPageSession, target: HTMLElement, state: TranslationState): boolean {
    if (session.scope !== 'all' || state.scope === 'all') return false;
    const core = getCurrentTranslationCore('all');
    const changesKind = state.kind === 'content' && core.resolve(target)?.kind === 'control';
    const previousNodes = new Set(state.sourceTextNodes);
    const expandsText = collectLiveTranslationTextSlots(target, core.shouldStayOriginal,
        getTranslationStateProtectionBoundary(target, state),
        getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, target),
    ).some((slot) => !previousNodes.has(slot.node));
    if (!changesKind && !expandsText) return false;
    const root = state.syntheticSegment ? target.parentElement : target;
    unregisterSessionStatefulTarget(session, target);
    removeScheduledForStateTarget(session, target);
    withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    if (root?.isConnected) enqueueFullPageRescan(session, root);
    return true;
}

function flushMutationRescans(session: FullPageSession): void {
    session.mutationFlushTimer = null;
    mutationRescanWakeTimes.delete(session);
    if (!session.active) return;
    const selection = createMutationRescanSelector(session, () => performance.now(), session.activeDiscovery !== null);

    while (session.activeDiscovery || session.dirtyRoots.size > 0) {
        if (!session.activeDiscovery) {
            const root = selection.take();
            if (!root) break;
            normalizeOrphanedTranslationArtifacts(root);
            normalizeOrphanedSingleSlots(root);
            if (!isConnectedMutationRoot(root)) continue;
            const core = getCurrentTranslationCore(session.scope);
            prepareManpageContent(root, core.url, core.adapters);
            session.activeDiscovery = {
                root,
                steps: core.discoverSteps(root),
            };
        }

        const active = session.activeDiscovery;
        if (!isConnectedMutationRoot(active.root)) {
            session.activeDiscovery = null;
            continue;
        }
        const step = active.steps.next();
        if (step.done) {
            if (active.root === document.documentElement && document.readyState !== 'loading'
                && !sessionsWithDiscoveredContent.has(session) && session.statefulTargetsByAncestor.size === 0) {
                notifyFullPageTranslationDiagnostic(diagnoseFailure(undefined, {reason: 'no-content'}));
            }
            if (session.broadRescanRoots.has(active.root)) {
                session.broadRescanCooldowns.set(active.root, performance.now() + BROAD_RESCAN_COOLDOWN_MS);
            }
            session.activeDiscovery = null;
            continue;
        }
        if (step.value.element.shadowRoot) observeFullPageRoot(session, step.value.element.shadowRoot);
        if (step.value.phase === "enter") {
            const statefulStepTarget = asHTMLElement(step.value.element);
            const statefulStepState = statefulStepTarget
                ? getTranslationState(statefulStepTarget)
                : undefined;
            if (statefulStepTarget && statefulStepState) {
                if (upgradeFullPageTargetScope(session, statefulStepTarget, statefulStepState)) continue;
                const candidateOwner = statefulStepState.syntheticSegment
                    ? asHTMLElement(statefulStepTarget.parentElement) ?? statefulStepTarget
                    : statefulStepTarget;
                registerSessionStatefulTarget(session, candidateOwner, statefulStepTarget);
                // 合成 owner 会被普通候选发现刻意硬剪枝；祖先 class/style 重扫时仍需
                // 复验其实时原文，避免标签可见性变化后长期漏译。
                scheduleStatefulAttributeReevaluation(session, statefulStepTarget);
            }
        }
        if (step.value.candidate) scheduleDiscoveredCandidate(session, step.value.candidate);

        // 每一步最多代表一个已访问元素；即使脏根覆盖整个 Reddit/Wikipedia DOM，
        // 也要在很小的帧预算后让出执行权。
        if (selection.shouldYield()) break;
    }

    if (session.activeDiscovery || session.dirtyRoots.size > 0) {
        scheduleMutationRescan(session, selection.delay());
    } else {
        session.dirtyRootsBroadMode = false;
    }
    scheduleFullPageDrain(session);
}

function observeFullPageRoot(session: FullPageSession, root: Node): void {
    if (!isConnectedMutationRoot(root) || session.roots.has(root)) return;
    session.roots.add(root);
    session.modalDirty = true;
    session.mutationObserver.observe(root, createTranslationMutationObserverOptions(getCurrentTranslationCore(session.scope).adapters));
}

/** 路由切换刷新所有活树的属性依赖；卸载组件后断开旧 ShadowRoot，避免会话强引用累积。 */
function refreshFullPageObservationRoots(session: FullPageSession, refreshOptions = false): void {
    let removed = false;
    for (const root of session.roots) {
        if (isConnectedMutationRoot(root)) continue;
        session.roots.delete(root);
        session.dirtyRoots.delete(root);
        if (session.activeDiscovery?.root === root) session.activeDiscovery = null;
        removed = true;
    }
    if (!removed && !refreshOptions) return;
    // MutationObserver 没有 unobserve。重连前接住已排队记录，不能因清理一个
    // 卸载组件而丢掉同一任务内活页面上的正文/保护变化。只换属性选项无需断开。
    const pending = removed ? session.mutationObserver.takeRecords() : [];
    if (removed) session.mutationObserver.disconnect();
    const options = createTranslationMutationObserverOptions(getCurrentTranslationCore(session.scope).adapters);
    session.roots.forEach(root => session.mutationObserver.observe(root, options));
    if (pending.length) processFullPageMutations(session, pending);
}

function resolveStatefulMutationTarget(element: Element): HTMLElement | false {
    let current: Element | null = element;
    while (current) {
        const htmlCurrent = asHTMLElement(current);
        if (htmlCurrent && getTranslationState(htmlCurrent)) return htmlCurrent;
        current = current.parentElement;
    }
    return false;
}

/**
 * materialize 的 childList 可在延迟 spinner 创建前送达；尚未创建允许零产物，已登记则必须保持唯一归属。
 * 这些真实 childList 记录会在 beginTranslation 之后、异步 provider 仍待完成时送达。
 * 只有本 generation 捕获的精确来源所有权、HTML 和 Text 槽身份都保持完整时才接受；
 * 任何宿主插入（包括伪装成 FluentRead 产物的节点）都必然无法通过至少一项检查，
 * 并继续进入 stale/重启路径。
 */
function isIntactLoadingSyntheticChildList(
    target: HTMLElement,
    state: TranslationState,
): boolean {
    if (!state.syntheticSegment || !target.matches('[data-fr-translation-segment="true"]')) return false;
    const spinner = state.spinner;
    if (spinner !== undefined && (spinner.parentNode !== target || !spinner.matches('[data-fr-translation-owned="true"]'))) return false;

    const expectedSourceNodes = state.syntheticSourceNodes;
    if (!expectedSourceNodes) return false;
    const currentSourceNodes = Array.from(target.childNodes).filter((node) => node !== spinner);
    if (currentSourceNodes.length !== expectedSourceNodes.length ||
        currentSourceNodes.some((node, index) => node !== expectedSourceNodes[index])) return false;

    const artifacts = Array.from(target.querySelectorAll(TRANSLATION_ARTIFACT_SELECTOR));
    if (artifacts.length !== (spinner === undefined ? 0 : 1) || (spinner !== undefined && artifacts[0] !== spinner)) return false;

    const sourceClone = cloneTranslationElementInert(target, false);
    currentSourceNodes.forEach((node) => sourceClone.appendChild(sourceClone.ownerDocument.importNode(node, true)));
    if (sourceClone.innerHTML !== state.sourceHTML) return false;

    const expectedTextNodes = state.sourceTextNodes ?? [], currentTextNodes = getCurrentTranslationStateTextNodes(target, state);
    return currentTextNodes.length === expectedTextNodes.length &&
        currentTextNodes.every((node, index) => node === expectedTextNodes[index]);
}

function isOwnMutation(
    mutation: MutationRecord,
    loadingSyntheticChecks: WeakMap<TranslationState, boolean>,
): boolean {
    const mutationElement = mutationTargetElement(mutation.target);
    // 框架在 hover/render 时会重复写入相同属性。相同值没有来源或展示变化，
    // 不能让一次 setAttribute 事务把控件/仅译文恢复后再从缓存重新渲染。
    // oldValue 为 null 时仍走完整复验，兼容不提供旧值的观察器实现。
    if (mutation.type === "attributes" && mutationElement && mutation.attributeName &&
        mutation.oldValue !== null &&
        mutation.oldValue === mutationElement.getAttribute(mutation.attributeName)) return true;
    if (mutation.type === "attributes" && mutationElement && (
        (mutation.attributeName === "style" && isTranslationLayoutOverrideMutation(mutationElement as HTMLElement)) ||
        (mutation.attributeName === "class" && consumeOrphanedOwnerClassMutation(mutationElement as HTMLElement)))) return true;
    // 不能用“位于任意插件节点内”作为判断：站点可能直接改写双语 wrapper
    // 的文本，必须让这类 mutation 进入 stale/retranslate 分支。加载/错误节点
    // 没有宿主正文，才可以直接视为插件自身变化。
    if (mutation.type !== "childList" &&
        isElementNode(mutation.target) &&
        mutation.target.matches('[data-fr-translation-owned="true"]') &&
        !mutation.target.matches('.fluent-read-bilingual-content')) return true;
    const target = mutationElement ? resolveStatefulMutationTarget(mutationElement) : false;
    const state = target ? getTranslationState(target as HTMLElement) : undefined;
    if (!target || !state) return false;
    if (isOwnSyntheticSegmentMarkerMutation(mutation, target, state,
        () => statefulSourceAndTextSlotsAreCurrent(target, state))) return true;
    if (isOwnStateArtifactMutation(mutation, target, state)) return true;
    if (state.phase === "error") {
        // 失败 UI 是扩展拥有的状态，不是宿主编辑；若缺少此分支，其 class mutation
        // 会恢复并重扫目标，使永久 provider 错误变成自动无限重试。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.renderedClassAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.renderedStyleAttribute;
        }
        if (mutation.type === "childList") {
            return allMutationNodesMatch(mutation, isTranslationArtifact) &&
                mutationElement === target &&
                state.retryWrapper?.parentNode === target;
        }
        return false;
    }
    if (state.phase === "loading") {
        // 手动重试会在 beginTranslation 创建下一 generation 前立即移除旧失败 class。
        // mutation 异步送达，因此需依据新快照识别这次清理。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.originalClassAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.originalStyleAttribute;
        }
        if (mutation.type === "childList" && mutationElement === target) {
            const cached = loadingSyntheticChecks.get(state);
            if (cached !== undefined) return cached;
            const intact = isIntactLoadingSyntheticChildList(target, state);
            loadingSyntheticChecks.set(state, intact);
            return intact;
        }
        return false;
    }
    if (state.phase !== "translated") return false;
    if (isOwnSingleTextSlotMove(mutation, target, state)) return true;
    if (state.mode === "single" && mutation.type === "characterData") {
        const textNode = mutation.target as Text;
        return state.textSlotsApplied === true &&
            state.translatedTextValues?.get(textNode) === (textNode.nodeValue ?? "");
    }
    if (state.bilingualContent?.isConnected) {
        const wrapper = state.bilingualContent;
        const mutationParent = isElementNode(mutation.target)
            ? mutation.target
            : mutation.target.parentElement;

        // wrapper 内部的变化只有在内容仍等于插件最后写入的快照时才算插件自身；
        // 如果站点脚本改写了译文，必须让后续分支恢复并重新排队。
        if (mutationParent && (mutationParent === wrapper || wrapper.contains(mutationParent))) {
            return wrapper.outerHTML === state.bilingualOuterHTML;
        }

        // 插件会先插入 loading，完成后再移除 loading 并插入译文 wrapper。
        // 这两类 childList mutation 都可能落在宿主节点上；只要所有增删节点
        // 都是扩展 artifact，且插件自己的最终快照仍然存在，就不能触发重译。
        // 若 wrapper 已被宿主移除，则保留 false，让后续逻辑恢复并重新排队。
        if (mutation.type === "childList" && allMutationNodesMatch(mutation, isTranslationArtifact)) {
            return state.bilingualContent?.parentNode === target &&
                state.bilingualContent.outerHTML === state.bilingualOuterHTML;
        }

        // 双语渲染会临时修改宿主节点的 style；只有值仍是插件记录的值时才忽略。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.renderedStyleAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.renderedClassAttribute;
        }
    }
    return isOwnCurrentArtifactAddition(mutation, state);
}

function removeScheduledForStateTarget(session: FullPageSession, target: HTMLElement): void {
    const state = getTranslationState(target);
    const host = state?.syntheticSegment ? target.parentElement : target;
    const candidateElements = new Set<HTMLElement>([target]);
    if (host) candidateElements.add(host);
    for (const element of candidateElements) {
        const keys = session.candidateOwnerKeys.get(element);
        if (!keys) continue;
        for (const key of Array.from(keys)) {
            const candidate = session.scheduled.get(key);
            if (!candidate) continue;
            const matches = candidate.element === target || candidate.element === host ||
                Boolean(candidate.nodes?.some((node) => target.contains(node)));
            if (matches) forgetCandidate(session, candidate);
        }
    }
}

function runDisconnectedCandidatePrune(session: FullPageSession): void {
    session.pruneTimer = null;
    if (!session.active) return;
    if (!session.pruneIterator) {
        session.pruneIterator = session.scheduled.values();
        session.pruneRequested = false;
        refreshFullPageObservationRoots(session);
    }
    const startedAt = performance.now();

    while (session.pruneIterator) {
        const next = session.pruneIterator.next();
        if (next.done) {
            session.pruneIterator = null;
            if (session.pruneRequested && session.pruneTimer === null) {
                session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 0);
            }
            return;
        }
        const candidate = next.value;
        if (!candidate.element.isConnected || candidate.nodes?.some((node) => !node.isConnected)) {
            forgetCandidate(session, candidate);
        } else {
            const key = getTranslationCandidateKey(candidate);
            const anchor = session.candidateAnchors.get(key);
            if (anchor && !anchor.isConnected) {
                refreshCandidateVisibilityBinding(session, key, candidate);
            }
        }
        if (performance.now() - startedAt >= CANDIDATE_PRUNE_BUDGET_MS) break;
    }

    if (session.pruneIterator && session.pruneTimer === null) {
        session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 16);
    }
}

function scheduleDisconnectedCandidatePrune(session: FullPageSession): void {
    if (!session.active) return;
    session.pruneRequested = true;
    if (session.pruneTimer !== null || session.pruneIterator) return;
    session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 0);
}

function discardOwnersRemovedByHost(
    session: FullPageSession,
    removedNodes: readonly Node[],
    resolveRemovedOwners: RemovedTranslationOwnerResolver = getTranslationOwnersForRemovedNode,
    beforeHostWrite?: () => void,
): {removedAny: boolean; shouldRescan: boolean} {
    const owners = new Set<HTMLElement>();
    let shouldRescan = false;
    removedNodes.forEach((removed) => {
        const syntheticParent = removed.parentElement;
        const syntheticState = syntheticParent?.matches('[data-fr-translation-segment="true"]')
            ? getTranslationState(syntheticParent as HTMLElement)
            : undefined;
        // materializeCandidate 会在 MutationObserver 送达前把直属行内段移入自有片段；
        // 后代翻译 owner 仍存活于该精确片段中，不能当作宿主删除。
        if (removed.isConnected && syntheticState?.syntheticSegment === true) return;
        resolveRemovedOwners(removed).forEach((owner) => owners.add(owner));
    });
    if (owners.size > 0) beforeHostWrite?.();
    owners.forEach((owner) => {
        const state = getTranslationState(owner);
        if (!state) {
            unregisterSessionStatefulTarget(session, owner);
            return;
        }
        const removedOnlyFailureUi = state.phase === "error" &&
            owner.isConnected &&
            Boolean(state.retryWrapper) &&
            removedNodes.length === 1 &&
            removedNodes[0] === state.retryWrapper;
        const attributeTimer = session.statefulAttributeTimers.get(owner);
        if (attributeTimer !== undefined) {
            window.clearTimeout(attributeTimer.timer);
            if (attributeTimer.boundaryTimer !== undefined) window.clearTimeout(attributeTimer.boundaryTimer);
            session.statefulAttributeTimers.delete(owner);
        }
        session.statefulAttributeRescanTargets.delete(owner);
        if (removedOnlyFailureUi) {
            // 保留错误墓碑；否则框架移除重试子节点后，下一次无关 mutation 会永远
            // 自动请求同一个持续失败的 provider。
            removeScheduledForStateTarget(session, owner);
            detachFailedTranslationUi(owner, state);
            return;
        }
        const disposition = state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content'
            ? stabilizeBilingualArtifact(owner, state, session.bilingualRemountCapitulations, ensureTranslationTruncationLayout) : 'retry';
        if (disposition === 'current') return;
        if (disposition === 'capitulated') {
            unregisterSessionStatefulTarget(session, owner);
            removeScheduledForStateTarget(session, owner);
            withFullPageViewportAnchor(() => discardTranslation(owner, state), [owner]);
            shouldRescan = true;
            return;
        }
        if (canKeepTranslationAttempt(owner, state, attemptSourceIsCurrent,
            statefulSourceAndTextSlotsAreCurrent)) {
            // 虚拟列表可能在请求仍进行时替换 spinner 或来源 Text，但当前
            // tweet/段落的语义原文没有变化。保留当前 generation，让结果提交到
            // 新的实时 DOM；否则每次滚动都会先 abort 再重新翻译。
            return;
        }
        if (session.scrollController.defer(owner)) {
            // 滚动期间虚拟列表可能暂时拆掉当前 wrapper/来源节点。把重启推迟到
            // scroll idle，避免用户看到原文、译文来回闪烁并避免取消正在进行的请求。
            return;
        }
        unregisterSessionStatefulTarget(session, owner);
        shouldRescan = true;
        removeScheduledForStateTarget(session, owner);
        // 宿主删除具有权威性：清除扩展状态/产物，但不重新挂回框架有意移除的旧来源节点。
        withFullPageViewportAnchor(() => discardTranslation(owner, state), [owner]);
    });
    return {removedAny: owners.size > 0, shouldRescan};
}

function restartStatefulTarget(session: FullPageSession, target: HTMLElement): boolean {
    const attributeTimer = session.statefulAttributeTimers.get(target);
    if (attributeTimer !== undefined) {
        window.clearTimeout(attributeTimer.timer);
        if (attributeTimer.boundaryTimer !== undefined) window.clearTimeout(attributeTimer.boundaryTimer);
        session.statefulAttributeTimers.delete(target);
    }
    session.statefulAttributeRescanTargets.delete(target);
    unregisterSessionStatefulTarget(session, target);
    const state = getTranslationState(target);
    if (!state) return false;
    if (session.scrollController.defer(target)) {
        return false;
    }
    const disposition = state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content'
        ? stabilizeBilingualArtifact(target, state, session.bilingualRemountCapitulations, ensureTranslationTruncationLayout) : 'retry';
    if (disposition === 'current') {
        registerSessionStatefulTarget(session, target, target);
        return false;
    }
    if (disposition === 'capitulated') {
        removeScheduledForStateTarget(session, target);
        withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
        return true;
    }
    // 显式来源/结构 mutation 属于新的 DOM generation；缓存仍按完整文本身份
    // 复用，只有依赖周边页面内容的 AI 上下文结果需全量失效。
    invalidateContextSensitiveRequestCache(session);
    const rescanRoot = state.syntheticSegment ? target.parentElement : target;
    removeScheduledForStateTarget(session, target);

    if (state.phase === "loading") {
        withFullPageViewportAnchor(() => discardTranslation(target, state), [target]);
    } else {
        withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    }
    if (rescanRoot?.isConnected) enqueueFullPageRescan(session, rescanRoot);
    return true;
}

function scheduleStatefulAttributeReevaluation(
    session: FullPageSession,
    target: HTMLElement,
    checkBoundary = false,
): void {
    const currentTimer = session.statefulAttributeTimers.get(target);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer.timer);
    const scheduledState = getTranslationState(target);
    const scheduledPhase = scheduledState?.phase;
    const rescanRoot = scheduledState?.syntheticSegment ? target.parentElement : target;

    const timer = window.setTimeout(() => {
        const pending = session.statefulAttributeTimers.get(target);
        if (pending?.timer !== timer) return;
        session.statefulAttributeTimers.delete(target);
        if (pending.boundaryTimer !== undefined) window.clearTimeout(pending.boundaryTimer);
        if (!session.active) return;
        const state = getTranslationState(target);
        if (!state) {
            if (session.statefulAttributeRescanTargets.has(target) && rescanRoot?.isConnected) {
                session.statefulAttributeRescanTargets.delete(target);
                enqueueFullPageRescan(session, rescanRoot);
            }
            return;
        }
        session.statefulAttributeRescanTargets.delete(target);
        if (!target.isConnected) return;
        if (pending.boundaryTimer !== undefined && restoreStatefulTargetOutsideScope(session, target)) return;

        // A class/style reevaluation can be armed while the provider is still
        // loading. If the host replaces equivalent source Text nodes before
        // the request settles, do not let that old timer reinterpret the now
        // successfully committed translation as stale.
        if (scheduledState === state && scheduledPhase === "loading" &&
            hasCurrentTranslationSource(target, state, attemptSourceIsCurrent)) return;

        // 同时比较逻辑来源与精确文本槽身份，使纯 class/style 抖动保持低成本，
        // 又能发现同文本标签或行内链接替换。实时 single/control 文本槽比较本
        // generation 写入的值，而不是其旧原文。
        const shouldReconcileBilingualLayout =
            state.phase === "translated" &&
            state.mode === "bilingual" &&
            state.kind === "content" &&
            state.bilingualContent?.isConnected;
        if (shouldReconcileBilingualLayout && !ensureTranslationTruncationLayout(target)) {
            restartStatefulTarget(session, target);
            return;
        }
        let sourceCurrent = statefulSourceAndTextSlotsAreCurrent(target, state);
        if (!sourceCurrent && withFullPageViewportAnchor(() =>
            refreshBilingualTranslationSkeleton(target, state), [target])) sourceCurrent = true;
        if ((sourceCurrent &&
            (state.phase !== 'translated' || isTranslationArtifactCurrent(target, state))) ||
            canKeepTranslationAttempt(target, state, attemptSourceIsCurrent,
                statefulSourceAndTextSlotsAreCurrent)) return;
        restartStatefulTarget(session, target);
    }, STATEFUL_ATTRIBUTE_DEBOUNCE_MS);
    const pending = {timer, boundaryTimer: currentTimer?.boundaryTimer};
    // 来源/布局仍按最后一次变化防抖；边界检查按首次变化到期，避免动画一直延后清理。
    if (checkBoundary && pending.boundaryTimer === undefined) {
        const boundaryTimer = window.setTimeout(() => {
            const current = session.statefulAttributeTimers.get(target);
            if (current?.boundaryTimer !== boundaryTimer) return;
            delete current.boundaryTimer;
            if (!session.active) return;
            if (restoreStatefulTargetOutsideScope(session, target)) {
                window.clearTimeout(current.timer);
                session.statefulAttributeTimers.delete(target);
                session.statefulAttributeRescanTargets.delete(target);
            }
        }, STATEFUL_ATTRIBUTE_DEBOUNCE_MS);
        pending.boundaryTimer = boundaryTimer;
    }
    session.statefulAttributeTimers.set(target, pending);
}

function resolveStatefulMutationTargets(
    session: FullPageSession,
    element: Element,
): HTMLElement[] {
    const targets = new Set<HTMLElement>();
    const direct = resolveStatefulMutationTarget(element);
    if (direct) targets.add(direct);
    const descendants = session.statefulTargetsByAncestor.get(element);
    if (descendants) {
        for (const target of Array.from(descendants)) {
            if (getTranslationState(target)) targets.add(target);
            else unregisterSessionStatefulTarget(session, target);
        }
    }
    return [...targets];
}

/** 结构或属性关系变化后，先取消已不在正文范围内的旧候选，再扫描新候选。 */
function restoreStatefulTargetOutsideScope(session: FullPageSession, target: HTMLElement,
    checks?: ReturnType<typeof createTranslationMutationStabilityChecks>): boolean {
    const state = getTranslationState(target);
    if (!state || state.syntheticSegment || (checks?.scopeIsCurrent(target, state) ??
        isTranslationStateCandidateCurrent(target, state))) return false;
    checks?.invalidate();
    unregisterSessionStatefulTarget(session, target);
    removeScheduledForStateTarget(session, target);
    withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    return true;
}

function createFullPageMutationObserver(
    getSession: () => FullPageSession,
): MutationObserver {
    return new MutationObserver((mutations) => processFullPageMutations(getSession(), mutations));
}

function processFullPageMutations(session: FullPageSession, mutations: readonly MutationRecord[]): void {
    if (!session.active || fullPageSession !== session) return;
    const core = getCurrentTranslationCore(session.scope);
    const siteAttributes = getSiteAdapterAttributeFilter(core.adapters);
    // materialize 较宽行内段时，每个被移动来源节点都可能排入一条 childList 记录。
    // 精确快照在本次回调内稳定，因此每个 loading generation 只校验一次，
    // 避免进行 O(records) 次克隆。
    const loadingSyntheticChecks = new WeakMap<TranslationState, boolean>();
    // MathJax v2 单次回调可能产生数百条直属父级记录。实时 DOM 此时已处于回调
    // 最终状态，因此每个有状态来源/文本槽快照只比较一次，不为每条
    // Preview <-> staging-span 记录反复遍历很长的 P。
    const shouldCheckAttribute = createTranslationAttributeMutationFilter();
    const resolveRemovedOwners = transferEquivalentBilingualOwners(session, mutations);
    const stabilityReads = createTranslationMutationStabilityChecks();
    const attributeBatch = createAttributeMutationBatch({
        resolveTargets: root => resolveStatefulMutationTargets(session, root),
        readState: getTranslationState,
        restoreOutsideScope: target => restoreStatefulTargetOutsideScope(session, target, reads),
        sourceIsCurrent: (target, state) => reads.sourceIsCurrent(target, state),
        isArtifact: isTranslationArtifact,
        refreshSkeleton: (target, state) => withFullPageViewportAnchor(() =>
            (reads.invalidate(), refreshBilingualTranslationSkeleton(target, state)), [target]),
        restart: target => {
            reads.invalidate();
            restartStatefulTarget(session, target);
        },
        rescan: root => enqueueFullPageRescan(session, root),
        schedule: (target, boundary) => scheduleStatefulAttributeReevaluation(session, target, boundary),
        isActive: () => session.active && fullPageSession === session,
        hasTargetsOnlyAdapter: core.adapters.some(adapter => adapter.genericCandidatePolicy === 'targets-only'),
    });
    const reads = {
        ...stabilityReads,
        invalidate: () => {
            stabilityReads.invalidate();
            attributeBatch.invalidate();
        },
    };
    const siteChildListAdapters = core.adapters.filter(adapter => adapter.childListRescanRoot);
    const siteChildListRoots = siteChildListAdapters.length ? new WeakSet<Element>() : null;
    for (const mutation of mutations) {
        if (isOwnMutation(mutation, loadingSyntheticChecks)) continue;
        const mutationElement = mutationTargetElement(mutation.target);
        if (mutation.type === 'attributes' && mutationElement && mutation.attributeName &&
            !shouldCheckAttribute(mutationElement, mutation.attributeName)) continue;
        // spinner、译文写入和普通属性/文本变化不会让候选脱离文档。
        // 只有真实宿主删除才启动全队列的分片清理，避免每次渲染遍历离屏候选。
        if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
            scheduleDisconnectedCandidatePrune(session);
        }
        if (mayChangeTranslationModal(mutation, session.modal)) session.modalDirty = true;
        const siteAttributeMutation = mutation.type === 'attributes' && mutation.attributeName !== null &&
            (siteAttributes === null || siteAttributes.includes(mutation.attributeName));
        const controlAttributeMutation = mutation.type === 'attributes' &&
            (mutation.attributeName === 'value' || mutation.attributeName === 'type' || mutation.attributeName === 'name');
        // 默认新增观察的三个属性只影响 input；站点显式声明的依赖仍按其规则处理。
        if (controlAttributeMutation && mutationElement?.localName !== 'input' && !siteAttributeMutation) continue;
        if (!siteAttributeMutation && mutation.type === 'attributes' && (mutation.attributeName === 'aria-modal' ||
            (mutation.attributeName === 'open' && mutationElement?.localName === 'dialog'))) {
            enqueueFullPageRescan(session, mutation.target); continue;
        }
        const preservesContext = isTextEquivalentHostReplacement(mutation);
        const removedOwners = mutation.type === "childList"
            ? discardOwnersRemovedByHost(session, Array.from(mutation.removedNodes), resolveRemovedOwners, reads.invalidate)
            : {removedAny: false, shouldRescan: false};
        if (removedOwners.shouldRescan && mutationElement) enqueueFullPageRescan(session, mutationElement);
        if (mutationElement && core.shouldIgnoreMutation(mutationElement) &&
            !siteAttributeMutation && !resolveStatefulMutationTarget(mutationElement)) continue;
        if (!preservesContext) invalidateContextSensitiveRequestCache(session);
        if (mutation.type === "childList") {
            for (const adapter of siteChildListAdapters) {
                const root = adapter.childListRescanRoot?.(mutation, {url: core.url});
                if (root && root.ownerDocument === document && root.isConnected && !siteChildListRoots!.has(root)) {
                    siteChildListRoots!.add(root);
                    enqueueFullPageRescan(session, root);
                }
            }
            if (core.adapters.length && mutationElement) {
                const affectedRoot = siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement;
                for (const target of resolveStatefulMutationTargets(session, affectedRoot)) restoreStatefulTargetOutsideScope(session, target, reads);
            }
            const changedTarget = mutationElement ? resolveStatefulMutationTarget(mutationElement) : false;
            const changedState = changedTarget ? getTranslationState(changedTarget) : undefined;

            // 宿主直属 childList 可能只是受保护 renderer 事务。可翻译来源与精确
            // Text 槽不变时保留 loading/error/translated 所有权；旧行为会在
            // MathJax v2 于父 P 替换脱离文档且无 class 的 staging span 后移除
            // 已提交 wrapper。扩展当前产物内部或移除它的 mutation 仍属于
            // 权威宿主篡改，必须立即重启。
            if (changedTarget && changedState) {
                const touchesArtifact = isTranslationArtifact(mutation.target) ||
                    mutationTouchesCurrentTranslationArtifact(mutation, changedState);
                let sourceAndSlotsCurrent = reads.sourceIsCurrent(changedTarget, changedState);
                if (!touchesArtifact && !sourceAndSlotsCurrent && withFullPageViewportAnchor(() =>
                    (reads.invalidate(), refreshBilingualTranslationSkeleton(changedTarget, changedState)), [changedTarget])) {
                    sourceAndSlotsCurrent = true;
                }
                const canKeepAttempt = canKeepTranslationAttempt(
                    changedTarget,
                    changedState,
                    attemptSourceIsCurrent,
                    statefulSourceAndTextSlotsAreCurrent,
                    !touchesArtifact || isTranslationArtifactCurrent(changedTarget, changedState),
                );
                if ((touchesArtifact || !sourceAndSlotsCurrent) && !canKeepAttempt) {
                    reads.invalidate();
                    restartStatefulTarget(session, changedTarget);
                }
            }

            // 纯删除可能把原结构容器变成有效段落，因此所有情况都要重新分类 mutation 目标。
            enqueueFullPageRescan(session, mutation.target);

            // 扫描 mutation 目标已经覆盖全部新增后代；逐个排入子节点会把一次 React
            // commit 扩大为数十个冗余脏根。
        } else if (mutation.type === "characterData") {
            const target = mutation.target.parentElement
                ? resolveStatefulMutationTarget(mutation.target.parentElement)
                : false;
            if (target) {
                const state = getTranslationState(target);
                const touchesArtifact = isTranslationArtifact(mutation.target);
                let sourceCurrent = state && reads.sourceIsCurrent(target, state);
                if (state && !touchesArtifact && !sourceCurrent && withFullPageViewportAnchor(() =>
                    (reads.invalidate(), refreshBilingualTranslationSkeleton(target, state)), [target])) sourceCurrent = true;
                if (!state || touchesArtifact || !sourceCurrent || !canKeepTranslationAttempt(
                    target,
                    state,
                    attemptSourceIsCurrent,
                    statefulSourceAndTextSlotsAreCurrent,
                )) {
                    reads.invalidate();
                    restartStatefulTarget(session, target);
                }
            } else {
                // hydration 框架常在不新增 Element 的情况下追加/替换 Text 节点，
                // 此时需重新分类其最近语义块。
                enqueueFullPageRescan(session, mutation.target);
            }
        } else if (mutation.type === "attributes") {
            if (!mutationElement) continue;

            // input 的资格影响真实表单值；失去资格不能等待滚动停止再恢复。
            // 保留宿主已改写的 value，并由既有 state 恢复逻辑取消在途结果。
            if (mutationElement.localName === 'input' && controlAttributeMutation) {
                const target = asHTMLElement(mutationElement);
                if (target && getTranslationState(target)?.controlValue) {
                    restoreStatefulTargetOutsideScope(session, target, reads);
                }
            }

            // 相邻选择器可能影响兄弟正文；不能穷举的关系选择器保守重扫文档，
            // 后续发现仍受既有帧预算、去重与广域重扫冷却约束。
            const affectedRoot = siteAttributeMutation
                ? siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement
                : mutationElement;
            attributeBatch.process(affectedRoot, mutationElement, mutation.target, mutation.attributeName, siteAttributeMutation);
        }
    }
    refreshFullPageModal(session);
    attributeBatch.flush();
}

function createFullPageSession(
    root: HTMLElement,
    settings: {translationMode: FullPageTranslationMode; scope: TranslationScope; translationConfig: FullPageTranslationConfigSnapshot},
    progressSessionId: number,
): FullPageSession {
    let session!: FullPageSession;
    const observer = new IntersectionObserver((entries) => {
        if (!session.active || fullPageSession !== session) return;
        for (const entry of entries) {
            const node = entry.target as HTMLElement;
            const candidates = session.observedCandidates.get(node);
            if (!candidates) continue;
            if (entry.isIntersecting) session.visibleCandidateAnchors.add(node);
            else session.visibleCandidateAnchors.delete(node);
            candidates.forEach((candidate, key) => {
                if (entry.isIntersecting) {
                    queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
                } else {
                    // 快速划过的内容退出预取区后继续观察，等再次进入时才派发。
                    // 只撤回 pending，不取消在途请求，也不遗忘 scheduled 的候选所有权。
                    removeFullPagePending(session, key, candidate);
                }
            });
        }
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
    }, {
        root: null,
        rootMargin: `${FULL_PAGE_PREFETCH_MARGIN_PX}px 0px`,
        threshold: 0.01,
    });
    const mutationObserver = createFullPageMutationObserver(() => session);
    const scrollController = createFullPageScrollController({
        isActive: () => session.active && fullPageSession === session,
        onIdle: (targets) => {
            targets.forEach((target) => {
                if (getTranslationState(target)) restartStatefulTarget(session, target);
            });
            if (session.dirtyRoots.size > 0 && session.mutationFlushTimer === null) {
                scheduleMutationRescan(session, 0);
            }
        },
        afterIdle: () => scheduleFullPageDrain(session),
    });

    session = createFullPageSessionState({root,
        translationMode: settings.translationMode,
        scope: settings.scope,
        translationConfig: settings.translationConfig,
        progressSessionId, observer, mutationObserver, scrollController,
        createAbortError, clearTimeout: timer => window.clearTimeout(timer),
        clearModalPresentation: () => syncModalTranslationHint(null, 'none', false),
        releaseSourceStability: current => translationSourceStability.dispose(current),
        finishProgress: finishFullPageTranslationProgress,
    });
    session.unsubscribeOutcomeChanges = bindFullPageOutcomeRecovery(session,
        () => fullPageSession === session, () => scheduleFullPageProgressPublish(session));
    return session;
}


function stopFullPageSession(): void {
    const session = fullPageSession;
    if (!session) return;
    fullPageSession = null;
    session.dispose();
}
export function invalidateFullPageTranslationSessionCache(): void { if (fullPageSession?.active) invalidateFullPageRequestSessionCache(fullPageSession); }
/** 新路由取消旧请求并重扫当前 DOM；旧页面的熔断和无需变更判定不能压住新页面。 */
export function resetFullPageTranslationRouteState(): void {
    notifyFullPageTranslationDiagnostic(undefined);
    if (fullPageSession) {
        sessionsWithDiscoveredContent.delete(fullPageSession);
        sessionFailureDiagnostics.delete(fullPageSession);
        sessionPublishedFailureDiagnostic.delete(fullPageSession);
    }
    cancelPendingHoverTranslation();
    translationSourceStability.reset();
    hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
    invalidateHoverTranslationRequestSession();
    resetFullPageRouteSession(fullPageSession, document.documentElement, {
        observe: (session, root) => {
            refreshFullPageObservationRoots(session, true);
            observeFullPageRoot(session, root);
        },
        rescan: enqueueFullPageRescan,
    });
    resetAllBilingualArtifactHostWriteBudgets();
}

/**
 * 恢复全文翻译。全文和悬浮翻译共享同一份节点状态，因此这里无需再用
 * data-fr-node-id + innerHTML 覆盖页面，也能处理 Shadow DOM 和动态节点。
 */
export function restoreOriginalContent(): void {
    cancelPendingHoverTranslation();
    stopFullPageTitleTranslation();
    stopFullPageSession(); resetHoverTranslationRequestSession(createAbortError());
    hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
    restorePageTranslationContent();
    restoreManpageContent();
    notifyFullPageTranslationState(false);
}

/**
 * 启动全文翻译会话：根固定为 documentElement，使用较大的预取窗口和并发
 * 限制，并持续观察新增 DOM/open ShadowRoot。这样 body 被 SPA 替换后仍能
 * 继续工作，也不会一次性给整页发出数百个请求。
 */
export function autoTranslateEnglishPage(invocation: PageTranslationInvocation = {}, inheritedConfig?: FullPageTranslationConfigSnapshot): number | undefined {
    if (fullPageSession?.active || !checkConfig(invocation, true)) return;
    const root = document.documentElement;
    if (!root) return;

    const core = getCurrentTranslationCore(invocation.scope ?? config.translationScope);
    prepareManpageContent(root, core.url, core.adapters);

    // 保持启动时快照，即使进度订阅者同步更新全局配置。
    const settings = {translationMode: invocation.fullPageMode ?? config.fullPageTranslationMode,
        scope: invocation.scope ?? config.translationScope,
        translationConfig: inheritedConfig ? {...inheritedConfig} : captureFullPageTranslationConfig(invocation)};
    // 进度订阅者可以同步恢复或启动新会话；旧调用在创建资源前让出所有权。
    const stateRevision = getFullPageTranslationStateRevision();
    const progressSessionId = startFullPageTranslationProgress();
    const progress = getFullPageTranslationProgress();
    if (fullPageSession?.active || progress.sessionId !== progressSessionId || !progress.active
        || getFullPageTranslationStateRevision() !== stateRevision) {
        finishFullPageTranslationProgress(progressSessionId);
        return;
    }
    let session: FullPageSession;
    try { session = createFullPageSession(root, settings, progressSessionId); }
    catch (error) { finishFullPageTranslationProgress(progressSessionId); throw error; }
    fullPageSession = session;
    // 标题不在正文候选范围内（<head> 属硬裁剪标签），单独随会话翻译并跟随 SPA 改写；
    // 高级设置可关闭，关闭后标签页保持原标题。
    if (config.pageTitleTranslationEnabled !== false) startFullPageTitleTranslation(session.translationConfig);
    document.addEventListener('fluentread-open-shadow-root', (event) => {
        if (!session.active || fullPageSession !== session) return;
        const host = isElementNode(event.target as Node) ? event.target as Element : null;
        const shadowRoot = host?.shadowRoot;
        if (!shadowRoot) return;
        observeFullPageRoot(session, shadowRoot);
        enqueueFullPageRescan(session, shadowRoot);
        refreshFullPageModal(session);
    }, {capture: true, signal: session.shadowEventController.signal});
    document.addEventListener('scroll', () => noteFullPageScroll(session, () => session.active && fullPageSession === session,
        () => {session.scrollController.note(); scheduleFullPageDrain(session);}), {
        capture: true,
        passive: true,
        signal: session.shadowEventController.signal,
    });
    const refreshModal = () => {
        if (!session.active || fullPageSession !== session) return;
        session.modalDirty = true;
        refreshFullPageModal(session);
    };
    // close 不冒泡，capture 覆盖原生 dialog；CSS 过渡结束补足尚无尺寸的入场帧。
    // 事件仅触发只读复验，不能凭合成 close 事件放行仍打开的公告。
    for (const event of ['close', 'toggle', 'transitionend', 'animationend']) {
        document.addEventListener(event, refreshModal, {capture: true, signal: session.shadowEventController.signal});
    }
    window.addEventListener('resize', refreshModal, {passive: true, signal: session.shadowEventController.signal});
    observeFullPageRoot(session, root);
    for (const shadowRoot of getOpenShadowRoots(root)) observeFullPageRoot(session, shadowRoot);
    refreshFullPageModal(session);
    enqueueFullPageRescan(session, root);
    notifyFullPageTranslationState(true);
    // 状态订阅者也可能同步替换当前会话；只返回本次仍然有效的所有权。
    return fullPageSession === session && session.active ? session.progressSessionId : undefined;
}
/** 当前全文会话的只读身份；与生命周期事件及页面内容无关。 */
export function getFullPageTranslationSessionId(): number | undefined {
    return fullPageSession?.active ? fullPageSession.progressSessionId : undefined;
}
/** 仅共享无凭据的会话快照；旧 QQ 邮件 frame 使用同一目标语言、服务和展示设置。 */
export function getFullPageTranslationFrameState(): Omit<FrameTranslationState, 'enabled'> {
    const session = fullPageSession?.active ? fullPageSession : null;
    const revision = getFullPageTranslationStateRevision();
    return session ? {revision, sessionId: session.progressSessionId, translationConfig: {...session.translationConfig}, fullPageMode: session.translationMode, scope: session.scope} : {revision, sessionId: null};
}
/** Reads only the exact current owner; missing evidence is never a completion claim. */
export function readFullPageUnchangedCompletion(owner: HTMLElement, sessionId: number, source: string) {
    const session = fullPageSession?.active ? fullPageSession : undefined;
    return readAcceptedUnchangedCompletion(owner, session?.unchangedCandidates.get(owner), {
        sessionId, currentSessionId: session?.progressSessionId, renderCommitGeneration: session?.renderCommitGeneration,
        configIdentity: session && getTranslationInvocationIdentity(session.translationConfig), source,
        cancelled: session?.userCancelledCandidates.has(owner) === true,
    });
}
export function isFullPageTranslationActive(): boolean {
    return fullPageSession?.active === true;
}
/** 局部恢复单个译文所有者；全文会话仍在时记为用户取消，避免滚动或 DOM 变化后被自动重译。 */
export function restoreTranslationOwner(owner: HTMLElement): boolean { hoverRemountDispatch.cancelOwner(owner);
    const state = getTranslationState(owner), session = fullPageSession?.active ? fullPageSession : undefined; if (!state) return false;
    resetPageDiscourseContext();
    if (session) rememberUserCancelledCandidate(session, {element: owner, kind: state.kind, reason: 'section-restore', ...(state.syntheticSegment && state.sourceTextNodes?.length ? {nodes: state.sourceTextNodes} : {})}, owner, state);
    unregisterSessionStatefulTarget(session, owner); return withFullPageViewportAnchor(() => restoreTranslation(owner), [owner]); }
export function cancelPendingHoverTranslation(): void {
    hoverRemountDispatch.scheduler.cancel();
}
/**
 * 处理鼠标悬浮/快捷键翻译。坐标只负责找到内容块，真正的翻译调用与全文
 * 会话共用 translateTarget，因此按钮、富文本和恢复行为不会出现两套规则。
 */
export function handleTranslation(
    mouseX: number,
    mouseY: number,
    invocation: HoverTranslationInvocation = {},
): void {
    const core = getCurrentTranslationCore(invocation.scope ?? config.translationScope);
    prepareManpageContent(document.documentElement, core.url, core.adapters);
    hoverRemountDispatch.scheduler.handle(mouseX, mouseY, invocation);
}
