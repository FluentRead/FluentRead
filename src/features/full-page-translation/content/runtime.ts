/**
 * @file src/features/full-page-translation/content/runtime.ts
 * 文件职责：实现全文翻译的页面级会话引擎，负责候选发现、可见性调度、批量请求、动态 DOM 重扫、失败重试、缓存复用和恢复原文。
 * 主要内容：维护 FullPageSession、AbortController、Intersection/Mutation 观察器、弹窗优先调度、精确属性写入过滤、候选所有权和生命周期重试；冻结配置与识别范围，在弹窗关闭后继续正文，按实际节点阶段发布进度及工具栏结果。
 * 模块边界：这是 content 侧编排层，不实现 provider 协议、纯候选算法或底层状态存储；翻译调用经 app client，发现规则来自 core/translation，渲染与状态分别交给 renderer 和 state。
 */
import {resolveTranslationToolbarStatus, countFullPageTranslationWork} from '../toolbarStatus';
import {getFullPageTranslationStateRevision, notifyFullPageTranslationState, notifyTranslationToolbarStatus} from './stateNotification';
import type {FrameTranslationState} from './frameSession';
import { checkConfig } from "@/src/app/translation/check";
import {insertFailedTip, insertLoadingSpinner} from '@/src/features/full-page-translation/ui/translationIndicators';
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
    TranslationDiscoveryStep,
} from "@/src/core/translation/public";
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import { config } from "@/src/services/config/store";
import type { FullPageTranslationMode } from "@/src/core/config/model";
import { consumeEagerTranslationBudget } from "@/src/features/full-page-translation/content/eagerTranslation";
import {normalizeMaxConcurrentTranslations} from "@/src/core/config/scheduling";
import {
    cancelTranslationQueueSession,
    createTranslationQueueSession,
} from "@/src/services/translation/queue";
import {
    finishFullPageTranslationProgress,
    startFullPageTranslationProgress,
    updateFullPageTranslationProgress,
} from '@/src/features/full-page-translation/progress';
import {
    appendBilingualTranslation,
    appendSingleTranslationSlots,
} from "@/src/features/full-page-translation/content/renderer";
import {ensureTranslationTruncationLayout} from "@/src/features/full-page-translation/content/layout";
import {blocksBilingualRemountCandidate, createBilingualRemountCapitulationRegistry,
    createRemovedTranslationOwnerResolver, forgetBilingualRemountCandidate, stabilizeBilingualArtifact,
    transferEquivalentBilingualOwners as adoptEquivalentBilingualOwners, type RemovedTranslationOwnerResolver}
    from '@/src/features/full-page-translation/content/bilingualRemount';
import {refreshBilingualTranslationSkeleton} from '@/src/features/full-page-translation/content/bilingualReplay';
import {transferEquivalentSyntheticBilingualSegments} from
    '@/src/features/full-page-translation/content/syntheticRemount';
import {
    beginBilingualArtifactHostWriteGesture, beginTranslation,
    detachFailedTranslationUi,
    discardTranslation,
    getOwnedTranslationCandidateAtPoint, getTranslationState,
    resolveTranslationStateNode,
    getTranslationOwnersForRemovedNode,
    markTranslationComplete,
    markTranslationError,
    resetAllBilingualArtifactHostWriteBudgets,
    resetBilingualArtifactHostWriteBudget,
    restoreAllTranslations,
    restoreTranslation,
    setBilingualContent,
    setBilingualArtifactCapitulationHandler,
    setBilingualLifecycleExternalManager,
    setBilingualOwnerRemountHandler,
    setRenderedStyleAttribute,
    setRetryWrapper,
    setLiveTranslationSourceSnapshot,
    setSingleTextSlotHosts,
    setSpinner,
    setTextSlotsApplied,
    isTranslationLayoutOverrideMutation,
    type TranslationState,
} from "@/src/features/full-page-translation/content/state";
import {
    captureFullPageTranslationConfig,
    getTranslationInvocationIdentity,
    type FullPageTranslationCacheEntry,
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
    type FullPageScrollController,
} from '@/src/features/full-page-translation/content/viewportStability';
import {
    canKeepTranslationAttempt,
    getCandidateTranslationTextProtectionOptions,
    isTranslationCandidateCurrent as candidateIsCurrent,
    getCurrentTranslationStateSourceText,
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
    reboundLiveTextResult,
    statefulSourceAndTextSlotsAreCurrent,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    createTranslationRequest,
    type TranslationResult,
} from '@/src/features/full-page-translation/content/liveTextTranslation';
import {consumeOrphanedOwnerClassMutation, isTextEquivalentHostReplacement, normalizeOrphanedSingleSlots, normalizeOrphanedTranslationArtifacts, normalizeOrphanedTranslationOwner}
    from '@/src/features/full-page-translation/content/orphanArtifacts';
import {createFullPageRequestSessionState, disposeFullPageRequestSession, getHoverTranslationRequestSession, invalidateContextSensitiveRequestCache, invalidateFullPageRequestSessionCache, invalidateFullPageRequestSessionForRoute, invalidateHoverTranslationRequestSession, resetHoverTranslationRequestSession, type FullPageRequestSessionState} from '@/src/features/full-page-translation/content/requestSession';
import {getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {createTranslationMutationObserverOptions, isOwnSyntheticSegmentMarkerMutation, mutationRootContains as nodeContains, collapseMutationRescanRoot as broadRescanRoot} from './mutationObservation';
import {isWithinTranslationModal, mayChangeTranslationModal} from './modalPriority';
import {refreshModalSession, type ModalPrioritySession} from './modalSession';
const TRANSLATION_ARTIFACT_SELECTOR = [
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
].join(",");
type TranslationTargetOutcome =
    | {status: "committed" | "failed" | "owned"}
    | {status: "unchanged"; source: string; attemptNode?: HTMLElement}
    | {
        status: "stale" | "not-current" | "empty";
        retryRoot?: Node;
        /** 尝试 owner，用于在较新的 generation 接管后拒绝旧重试。 */
        attemptNode?: HTMLElement;
    };
interface FullPageLifecycleRetry {
    owner: HTMLElement;
    source: string;
    kind: TranslationCandidate["kind"];
    reason: string;
    attempts: number;
}
interface FullPageSession extends FullPageRequestSessionState, ModalPrioritySession {
    translationMode: FullPageTranslationMode;
    scope: TranslationScope;
    /** 会话启动时冻结所有会改变译文或 DOM 表达的配置，防止设置热更新混入当前页面。 */
    translationConfig: FullPageTranslationConfigSnapshot;
    progressSessionId: number;
    progressPublishScheduled: boolean;
    observer: IntersectionObserver;
    mutationObserver: MutationObserver;
    shadowEventController: AbortController;
    pending: Map<Node, TranslationCandidate>;
    /** 可见性锚点 -> 等待该锚点进入视口的候选。 */
    observedCandidates: Map<HTMLElement, Map<Node, TranslationCandidate>>;
    /** 候选 key -> 实际的 IntersectionObserver 目标，该目标可以是后代元素。 */
    candidateAnchors: Map<Node, HTMLElement>;
    /** 候选元素 -> 候选 key；与可见性锚点分开保存，便于精确清理。 */
    candidateOwnerKeys: Map<HTMLElement, Set<Node>>;
    /** 宿主 owner/祖先 -> 其下活跃翻译目标，避免 mutation 时全局扫描状态。 */
    statefulTargetsByAncestor: Map<Element, Set<HTMLElement>>;
    /** 活跃目标 -> 上述索引中为它登记的精确祖先 key。 */
    statefulAncestorsByTarget: WeakMap<HTMLElement, readonly Element[]>;
    /** provider 请求在途时失效候选的有界即时重试记录。 */
    lifecycleRetries: WeakMap<Node, FullPageLifecycleRetry>;
    /** 限定在本次全文会话内的 provider/语言“无需变更”判定。 */
    unchangedCandidates: WeakMap<Node, FullPageLifecycleRetry>;
    /**
     * 用户在本次全文会话中显式恢复的候选标识。来源快照允许真实宿主编辑
     * 清除取消墓碑，同时让扩展自身产生的恢复 mutation 继续排除该片段。
     */
    userCancelledCandidates: Map<Node, string>;
    /** 用户滚动期间暂停新增翻译/重排，等待虚拟列表稳定后再继续。 */
    scrollController: FullPageScrollController;
    /** 宿主连续拒绝 wrapper 后，对稳定边界内的同源候选停止写 DOM。 */
    bilingualRemountCapitulations: ReturnType<typeof createBilingualRemountCapitulationRegistry>;
    /**
     * 本次全文会话已经请求过的翻译结果。宿主框架可能在样式/布局 mutation 后
     * 重新挂载同一段正文；此缓存避免生命周期抖动再次发出相同 provider 请求。
     */
    translationSlotCache: Map<string, FullPageTranslationCacheEntry>;
    draining: boolean;
    flushTimer: number | null;
    dirtyRoots: Set<Node>;
    mutationFlushTimer: number | null;
    activeDiscovery: {root: Node; steps: Generator<TranslationDiscoveryStep>} | null;
    broadRescanRoots: WeakSet<Node>;
    dirtyRootsBroadMode: boolean;
    pruneTimer: number | null;
    pruneIterator: Iterator<TranslationCandidate> | null;
    pruneRequested: boolean;
    statefulAttributeTimers: Map<HTMLElement, number>;
    statefulAttributeRescanTargets: WeakSet<HTMLElement>;
}
const BROAD_RESCAN_COOLDOWN_MS = 1_000;
const CANDIDATE_PRUNE_BUDGET_MS = 4;
const STATEFUL_ATTRIBUTE_DEBOUNCE_MS = 500;
const FULL_PAGE_LIFECYCLE_RETRY_LIMIT = 2;

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let fullPageSession: FullPageSession | null = null;
let hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
setBilingualLifecycleExternalManager(() => fullPageSession?.active === true);
setBilingualOwnerRemountHandler((mutations) => transferEquivalentBilingualOwners(undefined, mutations));
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

        const eligible = (candidate: TranslationCandidate) => !session.modal || isWithinTranslationModal(session.modal, candidate.element);
        const scheduled = session.modal ? new Map([...session.scheduled].filter(([, candidate]) => eligible(candidate))) : session.scheduled;
        const pending = session.modal ? [...session.pending.values()].filter(eligible).length : session.pending.size;
        const work = countFullPageTranslationWork(session.inFlightCandidates, scheduled, pending);
        const deferred = session.scheduled.size - scheduled.size;
        const busy = work.running > 0 || work.queued > 0;
        const targets = session.statefulTargetsByAncestor.get(document.documentElement) ?? [];
        const status = resolveTranslationToolbarStatus(busy, Array.from(targets, target => target.isConnected &&
            (!session.modal || isWithinTranslationModal(session.modal, target)) ? getTranslationState(target)?.phase ?? '' : ''));
        notifyTranslationToolbarStatus(session.modal && status === 'translated' ? 'idle' : status);
        const modalPhase = session.modal ? busy ? 'translating' : 'waiting' : 'none';
        syncModalTranslationHint(session.modal, modalPhase, config.translationProgressPanelEnabled === true);
        updateFullPageTranslationProgress(session.progressSessionId, {...work, deferred, modalPhase});
    });
}

function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === "function");
}
function asHTMLElement(node: unknown): HTMLElement | null {
    if (!node || typeof node !== "object" || (node as Node).nodeType !== 1) return null;
    const element = node as HTMLElement;
    return typeof element.tagName === "string" && typeof element.style === "object" ? element : null;
}
function translateNode(
    node: unknown,
    displayMode: "bilingual" | "single",
    slide: boolean,
    owner?: FullPageSession,
): void {
    const target = asHTMLElement(node);
    if (!target) return;
    const candidate = getCurrentTranslationCore(owner?.scope ?? config.translationScope).resolve(target);
    if (candidate) void translateTarget(candidate, displayMode, slide, owner);
}

function mutationTargetElement(node: Node): Element | null {
    if (isElementNode(node)) return node;
    if (node.nodeType === 11) {
        const host = (node as ShadowRoot).host;
        if (isElementNode(host)) return host;
    }
    return node.parentElement;
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
    const result = adoptEquivalentBilingualOwners(mutations, (_previousOwner, replacementOwner, state) => {
        const candidate = getCurrentTranslationCore(state.scope).resolve(replacementOwner);
        if (!candidate || candidate.element !== replacementOwner || candidate.kind !== state.kind ||
            Boolean(candidate.allowTopLevelApplicationShell) !== Boolean(state.allowTopLevelApplicationShell) ||
            normalizeComparableText(getCurrentTranslationStateSourceText(replacementOwner, state)) !==
                normalizeComparableText(state.sourceText)) return null;
        return {sourceTextNodes: getCurrentTranslationStateTextNodes(replacementOwner, state), reconcileLayout: ensureTranslationTruncationLayout};
    }, resolveRemovedOwners);
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
function createAbortError(): Error {
    try {
        return new DOMException('翻译已取消', 'AbortError');
    } catch {
        const error = new Error('翻译已取消');
        error.name = 'AbortError';
        return error;
    }
}

function attemptSourceIsCurrent(node: HTMLElement, state: TranslationState): boolean {
    return normalizeComparableText(getCurrentTranslationStateSourceText(node, state)) ===
        normalizeComparableText(state.sourceText);
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
    withFullPageViewportAnchor(() => spinner?.remove(), [node]);
    if (!node.isConnected ||
        !attemptSourceIsCurrent(node, attempt.state) ||
        !markTranslationError(node, attempt.state, attempt.generation, false)) {
        return {
            status: "stale",
            retryRoot: discardStaleAttempt(node, attempt.state),
            attemptNode: node,
        };
    }
    const retryWrapper = withFullPageViewportAnchor(() => insertFailedTip(
        node,
        error instanceof Error ? error.message : String(error || "翻译失败"),
        () => {
            const retryOwner = owner?.active ? owner : undefined;
            const retrySnapshot = snapshot?.requestOverridesApplied ? snapshot : undefined;
            void translateTarget(candidate,
                retryOwner?.translationConfig.displayMode ?? retrySnapshot?.displayMode ?? (config.display === styles.bilingualTranslation ? "bilingual" : "single"),
                false, retryOwner, retrySnapshot, true);
        },
    ), [node]);
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
    const spinner = state.spinner;

    const staleOutcome = (): TranslationTargetOutcome => ({
        status: "stale",
        retryRoot: discardStaleAttempt(node, state),
        attemptNode: node,
    });

    try {
        const result = await request;
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome();
        withFullPageViewportAnchor(() => spinner?.remove(), [node]);
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();

        // 目标文本即使不变，class/role/可见性变化也可能把所有权移到另一语义块。
        // 提交前必须复验原 owner；合成行内段因 materialize 已移动节点，
        // 所以下方改用其精确 Text 节点身份校验。
        if (!node.isConnected || !attemptSourceIsCurrent(node, state) ||
            (!candidate.nodes?.length && !candidateIsCurrent(candidate))) return staleOutcome();

        if (result.kind === "live-text") {
            const liveResult = result;
            if (!liveResult.complete) {
                withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
                return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
            }
            if (!liveResult.changed) {
                withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
                return liveResult.nodes.length === 0
                    ? {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node}
                    : {status: "unchanged", source: state.sourceText, attemptNode: node};
            }
            const currentNodes = getCurrentTranslationStateTextNodes(node, state);
            const currentParts = collectLiveTranslationTextSlots(
                node,
                getCurrentTranslationCore(candidate.scope).shouldStayOriginal,
                getTranslationStateProtectionBoundary(node, state),
                getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
            );
            const rebound = reboundLiveTextResult(currentNodes, liveResult, currentParts);
            if (!rebound) return staleOutcome();
            if (!markTranslationComplete(node, state, generation, false)) {
                return staleOutcome();
            }
            setLiveTranslationSourceSnapshot(node, rebound.nodes);
            if (state.mode === "single" && state.kind === "content") {
                const hosts = withFullPageViewportAnchor(() =>
                    appendSingleTranslationSlots(node, rebound.slots, {
                        targetLanguage: snapshot.targetLanguage,
                    }), [node]);
                if (hosts.length !== rebound.slots.length) return staleOutcome();
                setSingleTextSlotHosts(node, hosts);
            } else {
                withFullPageViewportAnchor(() => {
                    currentParts.forEach((part, index) => {
                        if (part.node.isConnected) {
                            part.node.nodeValue = `${part.prefix}${liveResult.translations[index] ?? part.source}${part.suffix}`;
                        }
                    });
                }, [node]);
                setTextSlotsApplied(node, rebound.nodes);
            }
            return {status: "committed"};
        }

        if (result.sources.length === 0 || result.translations.length !== result.sources.length) {
            withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
        }
        if (!result.translations.some((translation, index) =>
            normalizeComparableText(translation) !== normalizeComparableText(result.sources[index] ?? ""))) {
            withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "unchanged", source: state.sourceText, attemptNode: node};
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
        state.sourceHTML = node.innerHTML;

        const content = withFullPageViewportAnchor(() =>
            appendBilingualTranslation(node, translatedText, {
                sourceSkeleton: freshSnapshot.clone, targetLanguage: snapshot.targetLanguage,
                style: snapshot.style,
            }), [node]);
        setBilingualContent(node, content, {sources: result.sources, translations: result.translations,
            targetLanguage: snapshot.targetLanguage, style: snapshot.style});
        setRenderedStyleAttribute(node);
        return {status: "committed"};
    } catch (error) {
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome();
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();
        return markFailedTranslation(node, candidate, attempt, spinner, error, owner, snapshot);
    }
}


function materializeCandidate(candidate: TranslationCandidate): {node: HTMLElement; synthetic: boolean} | null {
    if (!candidate.nodes?.length) return {node: candidate.element, synthetic: false};
    if (candidate.nodes.some((node) => node.parentNode !== candidate.element)) return null;
    const first = candidate.nodes[0];
    if (!first) return null;
    const wrapper = candidate.element.ownerDocument.createElement('span');
    candidate.element.insertBefore(wrapper, first);
    candidate.nodes.forEach((node) => wrapper.appendChild(node));
    return {node: wrapper, synthetic: true};
}

function hasIntersectionLayoutBox(element: HTMLElement): boolean {
    if (typeof element.getClientRects !== "function") return false;
    try {
        const rects = element.getClientRects();
        for (let index = 0; index < rects.length; index += 1) {
            const rect = rects[index];
            if (rect && rect.width > 0 && rect.height > 0) return true;
        }
    } catch {
        // 脱离文档或自定义元素在重建布局时可能抛出异常。
    }
    return false;
}

/**
 * IntersectionObserver 无法可靠唤醒不生成布局盒的目标，典型情况是
 * `display: contents`。候选自身有布局盒时优先使用自身，否则按文档顺序遍历
 * 非扩展后代；找不到锚点时由调用方直接排队，并继续受全文 drain 并发限制。
 */
function resolveFullPageVisibilityAnchor(candidate: HTMLElement): HTMLElement | null {
    if (hasIntersectionLayoutBox(candidate)) return candidate;

    const pending: Element[] = [];
    const pushChildrenInReverse = (container: ParentNode) => {
        for (let index = container.children.length - 1; index >= 0; index -= 1) {
            const child = container.children.item(index);
            if (child) pending.push(child);
        }
    };
    pushChildrenInReverse(candidate);

    while (pending.length > 0) {
        const element = pending.pop();
        if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
        const htmlElement = asHTMLElement(element);
        if (htmlElement && hasIntersectionLayoutBox(htmlElement)) return htmlElement;

        // open Shadow DOM 既作为独立观察根参与全文翻译，也可能是宿主唯一的渲染盒。
        // 先压入 light DOM 子节点，使 LIFO 顺序优先访问 shadow 子节点。
        pushChildrenInReverse(element);
        if (element.shadowRoot) pushChildrenInReverse(element.shadowRoot);
    }
    return null;
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

function unregisterSessionStatefulTarget(session: FullPageSession | undefined, target: HTMLElement): void {
    if (!session) return;
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
    const source = candidateLifecycleSource(candidate);
    const identities = [
        getTranslationCandidateKey(candidate),
        ...(candidate.nodes ?? []),
    ];
    let cancelled = false;
    identities.forEach((identity) => {
        const cancelledSource = session.userCancelledCandidates.get(identity);
        if (cancelledSource === undefined) return;
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
    if (!session?.active) return;
    unregisterSessionStatefulTarget(session, target);
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
        session.pending.set(key, candidate);
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
        if (!session.pending.has(key)) session.pending.set(key, candidate);
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
        return;
    }

    let observed = session.observedCandidates.get(nextAnchor);
    if (!observed) {
        observed = new Map();
        session.observedCandidates.set(nextAnchor, observed);
    }
    observed.set(key, candidate);
    session.candidateAnchors.set(key, nextAnchor);
    session.observer.observe(nextAnchor);
    scheduleFullPageProgressPublish(session);
}

function forgetCandidate(session: FullPageSession | undefined, candidate: TranslationCandidate): void {
    if (!session) return;
    const key = getTranslationCandidateKey(candidate);
    const removedPending = session.pending.get(key) === candidate && session.pending.delete(key);
    if (session.scheduled.get(key) !== candidate) {
        if (removedPending) scheduleFullPageProgressPublish(session);
        return;
    }
    session.scheduled.delete(key);
    removeCandidateObservation(session, key);
    removeCandidateOwnerKey(session, candidate.element, key);
    scheduleFullPageProgressPublish(session);
}

async function translateTarget(candidate: TranslationCandidate, displayMode: "bilingual" | "single", slide: boolean,
    owner?: FullPageSession,
    translationConfigOverride?: FullPageTranslationConfigSnapshot,
    forceFailedRequest = false,
): Promise<TranslationTargetOutcome> {
    if (!candidate.element.isConnected) return {status: "not-current"};
    const statefulSession = owner?.active ? owner : fullPageSession?.active ? fullPageSession : undefined;
    const remountCapitulations = statefulSession?.bilingualRemountCapitulations ?? hoverBilingualRemountCapitulations;
    const translationConfig = owner?.active ? owner.translationConfig
        : translationConfigOverride ?? captureFullPageTranslationConfig();
    const requestOwner = statefulSession?.active && getTranslationInvocationIdentity(statefulSession.translationConfig) === getTranslationInvocationIdentity(translationConfig) ? statefulSession : undefined;
    const requestSession = requestOwner ?? getHoverTranslationRequestSession(); const requestCommitGeneration = requestSession.renderCommitGeneration ?? 0;
    const existingNode = resolveTranslationStateNode(candidate);
    const current = existingNode ? getTranslationState(existingNode) : undefined;
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

            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
            if (disposition === 'capitulated') return {status: 'owned'};
            if (!retryAnchor.isConnected) {
                return {status: "not-current", retryRoot: candidate.element.isConnected ? candidate.element : undefined};
            }
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(retryAnchor);
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
        withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
        if (shouldSwitchProfile && retryAnchor.isConnected) {
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(retryAnchor);
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
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(sourceAnchor);
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
    const sourceText = candidate.nodes?.length
        ? extractTranslationTextFromNodes(
            candidate.nodes,
            core.shouldStayOriginal,
            undefined,
            candidateProtectionOptions,
        )
        : extractTranslationText(
            candidate.element,
            core.shouldStayOriginal,
            undefined,
            candidateProtectionOptions,
        );
    if (!normalizeComparableText(sourceText)) {
        return {
            status: "empty",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }
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
    if (shouldSkipTranslationForTarget(sourceText, translationConfig.targetLanguage)) {
        return {status: "unchanged", source: sourceText};
    }

    const materialized = withFullPageViewportAnchor(() => materializeCandidate(candidate), [candidate.element]);
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
    );
    if (!attempt) {
        if (synthetic) {
            withFullPageViewportAnchor(() => node.replaceWith(...Array.from(node.childNodes)), [node]);
        }
        return {status: "owned"};
    }
    // 请求必须在 spinner 插入前创建；微软 HTML 克隆和文本节点快照不能把
    // 插件自己的 loading 元素送到服务端。
    const queueSession = createTranslationQueueSession();
    const signal = attempt.state.controller.signal;
    const cancelQueuedRequest = () => cancelTranslationQueueSession(queueSession, createAbortError());
    signal.addEventListener('abort', cancelQueuedRequest, {once: true});
    const request = createTranslationRequest(
        node,
        kind,
        displayMode,
        translationConfig,
        signal,
        queueSession,
        requestSession,
        getTranslationTextProtectionOptions(candidate.allowTopLevelApplicationShell, node),
        forceFailedRequest,
        candidate.scope,
    )
        .finally(() => signal.removeEventListener('abort', cancelQueuedRequest));
    if (synthetic) node.setAttribute('data-fr-translation-segment', 'true');
    const spinner = withFullPageViewportAnchor(() => insertLoadingSpinner(node), [node]);
    setSpinner(node, spinner);
    registerSessionStatefulTarget(statefulSession, candidate.element, node);
    const outcome = await renderTranslation(
        node,
        candidate,
        attempt,
        request,
        translationConfig,
        requestSession,
        requestCommitGeneration,
        requestOwner,
    ).finally(() => { if (statefulSession) scheduleFullPageProgressPublish(statefulSession); });
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
        return normalizeComparableText(candidate.nodes?.length
            ? extractTranslationTextFromNodes(
                candidate.nodes,
                core.shouldStayOriginal,
                undefined,
                protectionOptions,
            )
            : extractTranslationText(
                candidate.element,
                core.shouldStayOriginal,
                undefined,
                protectionOptions,
            ));
    } catch {
        return normalizeComparableText(candidate.element.textContent ?? "");
    }
}

function createLifecycleRetry(
    candidate: TranslationCandidate,
    source: string,
    attempts: number,
): FullPageLifecycleRetry {
    return {
        owner: candidate.element,
        source: normalizeComparableText(source),
        kind: candidate.kind,
        reason: candidate.reason,
        attempts,
    };
}

function sameLifecycleRetry(
    previous: FullPageLifecycleRetry | undefined,
    candidate: TranslationCandidate,
    source: string,
): boolean {
    return Boolean(previous &&
        previous.owner === candidate.element &&
        previous.source === source &&
        previous.kind === candidate.kind &&
        previous.reason === candidate.reason);
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
        const fresh = core.resolve(start);
        if (fresh?.element.isConnected) return fresh;
    }

    if (!candidate.element.isConnected) return null;
    return core.inspect(candidate.element).candidate ?? null;
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
                createLifecycleRetry(candidate, outcome.source, 0),
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
            session.pending.set(retryKey, fresh);
            scheduleFullPageDrain(session);
        }
        return;
    }

    if (outcome.retryRoot?.isConnected) enqueueFullPageRescan(session, outcome.retryRoot);
}

function scheduleFullPageDrain(session: FullPageSession): void {
    if (!session.active || session.scrollController.isScrolling || session.flushTimer !== null) return;
    session.flushTimer = window.setTimeout(() => {
        session.flushTimer = null;
        drainFullPage(session);
    }, 0);
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
    if (!session.active || session.scrollController.isScrolling || session.draining) return;
    refreshFullPageModal(session);
    session.draining = true;
    const maxConcurrent = normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations);

    while (session.active && session.inFlightCandidates.size < maxConcurrent && session.pending.size > 0) {
        let entry: [Node, TranslationCandidate] | undefined;
        for (const pendingEntry of session.pending.entries()) {
            if (!session.inFlightCandidates.has(pendingEntry[0]) &&
                (!session.modal || isWithinTranslationModal(session.modal, pendingEntry[1].element))) {
                entry = pendingEntry;
                break;
            }
        }
        if (!entry) break;
        const [key, candidate] = entry;
        session.pending.delete(key);
        session.inFlightCandidates.set(key, candidate);
        void translateTarget(candidate, session.translationConfig.displayMode, true, session)
            .then(
                (outcome) => finalizeFullPageCandidate(session, candidate, outcome),
                () => {
                    // 意外 runtime 异常保留原有终止行为；provider 失败会由
                    // translateTarget 显式表示，并在到达此处前渲染重试 UI。
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
    }
    session.draining = false;
    scheduleFullPageProgressPublish(session);
}

function scheduleDiscoveredCandidate(session: FullPageSession, candidate: TranslationCandidate): void {
    const target = asHTMLElement(candidate.element);
    if (!session.active || !target || !target.isConnected) return;
    if (session.translationConfig.displayMode === 'bilingual' && blocksBilingualRemountCandidate(
        session.bilingualRemountCapitulations,
        target,
        candidateLifecycleSource(candidate),
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(session.translationConfig),
        candidate.nodes,
        candidate.scope,
    )) return;
    const key = getTranslationCandidateKey(candidate);
    if (isUserCancelledCandidate(session, candidate)) {
        // 用户显式取消后的恢复 mutation 仍会被全文会话观察到。丢弃重新发现的候选前
        // 必须移除旧队列条目，否则延迟的可见性回调会再次引入它。
        const queuedCandidate = session.scheduled.get(key);
        if (queuedCandidate) {
            forgetCandidate(session, queuedCandidate);
        } else if (session.pending.get(key) === candidate) {
            session.pending.delete(key);
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
        if (session.pending.has(key)) session.pending.set(key, candidate);
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
    if (!root) return;
    if (isElementNode(root) && !root.isConnected) return;

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
    if (session.mutationFlushTimer !== null) return;
    session.mutationFlushTimer = window.setTimeout(() => flushMutationRescans(session), 50);
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
    if (!session.active) return;
    const startedAt = performance.now();
    let nextDelay = 16;

    while (session.activeDiscovery || session.dirtyRoots.size > 0) {
        if (!session.activeDiscovery) {
            const iterator = session.dirtyRoots.values().next();
            const root = iterator.value as Node | undefined;
            if (!root) break;
            session.dirtyRoots.delete(root);
            if (isElementNode(root) && !root.isConnected) continue;
            const rescanNotBefore = session.broadRescanCooldowns.get(root) ?? 0;
            if (session.broadRescanRoots.has(root) && performance.now() < rescanNotBefore) {
                session.dirtyRoots.add(root);
                nextDelay = Math.max(16, rescanNotBefore - performance.now());
                break;
            }
            normalizeOrphanedTranslationArtifacts(root);
            normalizeOrphanedSingleSlots(root);
            if (isElementNode(root) && !root.isConnected) continue;
            session.activeDiscovery = {
                root,
                steps: getCurrentTranslationCore(session.scope).discoverSteps(root),
            };
        }

        const active = session.activeDiscovery;
        const step = active.steps.next();
        if (step.done) {
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
        if (performance.now() - startedAt >= 8) break;
    }

    if (session.activeDiscovery || session.dirtyRoots.size > 0) {
        session.mutationFlushTimer = window.setTimeout(() => flushMutationRescans(session), nextDelay);
    } else {
        session.dirtyRootsBroadMode = false;
    }
    scheduleFullPageDrain(session);
}

function observeFullPageRoot(session: FullPageSession, root: Node): void {
    if (session.roots.has(root)) return;
    session.roots.add(root);
    session.modalDirty = true;
    session.mutationObserver.observe(root, createTranslationMutationObserverOptions(getCurrentTranslationCore(session.scope).adapters));
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
 * materialize 行内段会把来源节点移入合成 span，再追加一个 loading spinner。
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
    if (!spinner || spinner.parentNode !== target || !spinner.matches('[data-fr-translation-owned="true"]')) {
        return false;
    }

    const expectedSourceNodes = state.syntheticSourceNodes;
    if (!expectedSourceNodes) return false;
    const currentSourceNodes = Array.from(target.childNodes).filter((node) => node !== spinner);
    if (currentSourceNodes.length !== expectedSourceNodes.length ||
        currentSourceNodes.some((node, index) => node !== expectedSourceNodes[index])) return false;

    const artifacts = Array.from(target.querySelectorAll(TRANSLATION_ARTIFACT_SELECTOR));
    if (artifacts.length !== 1 || artifacts[0] !== spinner) return false;

    const sourceClone = target.cloneNode(false) as HTMLElement;
    currentSourceNodes.forEach((node) => sourceClone.appendChild(node.cloneNode(true)));
    if (sourceClone.innerHTML !== state.sourceHTML) return false;

    const expectedTextNodes = state.sourceTextNodes ?? [];
    const currentTextNodes = getCurrentTranslationStateTextNodes(target, state);
    return currentTextNodes.length === expectedTextNodes.length &&
        currentTextNodes.every((node, index) => node === expectedTextNodes[index]);
}

function isOwnMutation(
    mutation: MutationRecord,
    loadingSyntheticChecks: WeakMap<TranslationState, boolean>,
): boolean {
    const exactMutationElement = mutationTargetElement(mutation.target);
    // 框架在 hover/render 时会重复写入相同属性。相同值没有来源或展示变化，
    // 不能让一次 setAttribute 事务把控件/仅译文恢复后再从缓存重新渲染。
    // oldValue 为 null 时仍走完整复验，兼容不提供旧值的观察器实现。
    if (mutation.type === "attributes" && exactMutationElement && mutation.attributeName &&
        mutation.oldValue !== null &&
        mutation.oldValue === exactMutationElement.getAttribute(mutation.attributeName)) return true;
    if (mutation.type === "attributes" && exactMutationElement && (
        (mutation.attributeName === "style" && isTranslationLayoutOverrideMutation(exactMutationElement as HTMLElement)) ||
        (mutation.attributeName === "class" && consumeOrphanedOwnerClassMutation(exactMutationElement as HTMLElement)))) return true;
    // 不能用“位于任意插件节点内”作为判断：站点可能直接改写双语 wrapper
    // 的文本，必须让这类 mutation 进入 stale/retranslate 分支。加载/错误节点
    // 没有宿主正文，才可以直接视为插件自身变化。
    if (mutation.type !== "childList" &&
        isElementNode(mutation.target) &&
        mutation.target.matches('[data-fr-translation-owned="true"]') &&
        !mutation.target.matches('.fluent-read-bilingual-content')) return true;
    const mutationElement = mutationTargetElement(mutation.target);
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
            const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
            return changedNodes.length > 0 &&
                changedNodes.every(isTranslationArtifact) &&
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
        if (mutation.type === "childList") {
            const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
            if (changedNodes.length > 0 && changedNodes.every(isTranslationArtifact)) {
                return state.bilingualContent?.parentNode === target &&
                    state.bilingualContent.outerHTML === state.bilingualOuterHTML;
            }
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
            window.clearTimeout(attributeTimer);
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
        window.clearTimeout(attributeTimer);
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
): void {
    const currentTimer = session.statefulAttributeTimers.get(target);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    const scheduledState = getTranslationState(target);
    const scheduledPhase = scheduledState?.phase;
    const rescanRoot = scheduledState?.syntheticSegment ? target.parentElement : target;

    const timer = window.setTimeout(() => {
        session.statefulAttributeTimers.delete(target);
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
    session.statefulAttributeTimers.set(target, timer);
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
function restoreStatefulTargetOutsideScope(session: FullPageSession, target: HTMLElement): boolean {
    const state = getTranslationState(target);
    if (!state || state.syntheticSegment || candidateIsCurrent({element: target, kind: state.kind,
        reason: 'site-boundary-change', scope: state.scope, ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {})})) return false;
    unregisterSessionStatefulTarget(session, target);
    removeScheduledForStateTarget(session, target);
    withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    return true;
}

function createFullPageMutationObserver(
    getSession: () => FullPageSession,
): MutationObserver {
    return new MutationObserver((mutations) => {
        const session = getSession();
        if (!session.active || fullPageSession !== session) return;
        scheduleDisconnectedCandidatePrune(session);
        const core = getCurrentTranslationCore(session.scope);
        const siteAttributes = getSiteAdapterAttributeFilter(core.adapters);
        // materialize 较宽行内段时，每个被移动来源节点都可能排入一条 childList 记录。
        // 精确快照在本次回调内稳定，因此每个 loading generation 只校验一次，
        // 避免进行 O(records) 次克隆。
        const loadingSyntheticChecks = new WeakMap<TranslationState, boolean>();
        // MathJax v2 单次回调可能产生数百条直属父级记录。实时 DOM 此时已处于回调
        // 最终状态，因此每个有状态来源/文本槽快照只比较一次，不为每条
        // Preview <-> staging-span 记录反复遍历很长的 P。
        const statefulChildListChecks = new WeakMap<TranslationState, boolean>();
        const resolveRemovedOwners = transferEquivalentBilingualOwners(session, mutations);
        for (const mutation of mutations) {
            if (isOwnMutation(mutation, loadingSyntheticChecks)) continue;
            if (mayChangeTranslationModal(mutation, session.modal)) session.modalDirty = true;
            const mutationElement = mutationTargetElement(mutation.target);
            const siteAttributeMutation = mutation.type === 'attributes' && mutation.attributeName !== null &&
                (siteAttributes === null || siteAttributes.includes(mutation.attributeName));
            if (!siteAttributeMutation && mutation.type === 'attributes' && (mutation.attributeName === 'aria-modal' ||
                (mutation.attributeName === 'open' && mutationElement?.localName === 'dialog'))) {
                enqueueFullPageRescan(session, mutation.target); continue;
            }
            const preservesContext = isTextEquivalentHostReplacement(mutation);
            const removedOwners = mutation.type === "childList"
                ? discardOwnersRemovedByHost(session, Array.from(mutation.removedNodes), resolveRemovedOwners)
                : {removedAny: false, shouldRescan: false};
            if (removedOwners.shouldRescan && mutationElement) enqueueFullPageRescan(session, mutationElement);
            if (mutationElement && core.shouldIgnoreMutation(mutationElement) &&
                !siteAttributeMutation && !resolveStatefulMutationTarget(mutationElement)) continue;
            if (!preservesContext) invalidateContextSensitiveRequestCache(session);
            if (mutation.type === "childList") {
                if (core.adapters.length && mutationElement) {
                    const affectedRoot = siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement;
                    for (const target of resolveStatefulMutationTargets(session, affectedRoot)) restoreStatefulTargetOutsideScope(session, target);
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
                    let sourceAndSlotsCurrent = statefulChildListChecks.get(changedState);
                    if (sourceAndSlotsCurrent === undefined) {
                        sourceAndSlotsCurrent = statefulSourceAndTextSlotsAreCurrent(changedTarget, changedState);
                        statefulChildListChecks.set(changedState, sourceAndSlotsCurrent);
                    }
                    if (!touchesArtifact && !sourceAndSlotsCurrent && withFullPageViewportAnchor(() =>
                        refreshBilingualTranslationSkeleton(changedTarget, changedState), [changedTarget])) {
                        sourceAndSlotsCurrent = true;
                        statefulChildListChecks.set(changedState, true);
                    }
                    const canKeepAttempt = canKeepTranslationAttempt(
                        changedTarget,
                        changedState,
                        attemptSourceIsCurrent,
                        statefulSourceAndTextSlotsAreCurrent,
                        !touchesArtifact || isTranslationArtifactCurrent(changedTarget, changedState),
                    );
                    if ((touchesArtifact || !sourceAndSlotsCurrent) && !canKeepAttempt) {
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
                    let sourceCurrent = state && statefulSourceAndTextSlotsAreCurrent(target, state);
                    if (state && !touchesArtifact && !sourceCurrent && withFullPageViewportAnchor(() =>
                        refreshBilingualTranslationSkeleton(target, state), [target])) sourceCurrent = true;
                    if (!state || touchesArtifact || !sourceCurrent || !canKeepTranslationAttempt(
                        target,
                        state,
                        attemptSourceIsCurrent,
                        statefulSourceAndTextSlotsAreCurrent,
                    )) {
                        restartStatefulTarget(session, target);
                    }
                } else {
                    // hydration 框架常在不新增 Element 的情况下追加/替换 Text 节点，
                    // 此时需重新分类其最近语义块。
                    enqueueFullPageRescan(session, mutation.target);
                }
            } else if (mutation.type === "attributes") {
                if (!mutationElement) continue;

                // 相邻选择器可能影响兄弟正文；不能穷举的关系选择器保守重扫文档，
                // 后续发现仍受既有帧预算、去重与广域重扫冷却约束。
                const affectedRoot = siteAttributeMutation
                    ? siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement
                    : mutationElement;
                const targets = resolveStatefulMutationTargets(session, affectedRoot);
                const directTargets = siteAttributeMutation
                    ? new Set(resolveStatefulMutationTargets(session, mutationElement))
                    : null;
                if (targets.length > 0) {
                    for (const target of targets) {
                        if (siteAttributeMutation && restoreStatefulTargetOutsideScope(session, target)) continue;
                        if (mutation.attributeName === "class" || mutation.attributeName === "style") {
                            scheduleStatefulAttributeReevaluation(session, target);
                        } else {
                            const state = getTranslationState(target);
                            // 关系选择器需要广域复验，但不相关节点的属性写入不应取消有效请求。
                            // 普通 owner 已在上面通过候选边界复验；focus 的合成段保持保守重扫，
                            // 因其来源已物化，不能只用原文相同推断仍命中显式正文 selector。
                            if (state && directTargets && !directTargets.has(target) &&
                                (!state.syntheticSegment || !core.adapters.some(adapter => adapter.genericCandidatePolicy === 'targets-only')) &&
                                statefulSourceAndTextSlotsAreCurrent(target, state)) continue;
                            if (state && !isTranslationArtifact(mutation.target) &&
                                !statefulSourceAndTextSlotsAreCurrent(target, state) &&
                                withFullPageViewportAnchor(() =>
                                    refreshBilingualTranslationSkeleton(target, state), [target])) continue;
                            restartStatefulTarget(session, target);
                        }
                    }
                } else {
                    // hidden/aria-hidden/style/class 变化可能让原先被屏蔽的子树重新可见。
                    enqueueFullPageRescan(session, mutationElement);
                }
                if (siteAttributeMutation) enqueueFullPageRescan(session, affectedRoot);
            }
        }
        refreshFullPageModal(session);
    });
}

function createFullPageSession(
    root: HTMLElement,
    invocation: PageTranslationInvocation = {},
    inheritedConfig?: FullPageTranslationConfigSnapshot,
): FullPageSession {
    let session!: FullPageSession;
    const observer = new IntersectionObserver((entries) => {
        if (!session.active || fullPageSession !== session) return;
        for (const entry of entries) {
            const node = entry.target as HTMLElement;
            if (!entry.isIntersecting) continue;
            const candidates = session.observedCandidates.get(node);
            candidates?.forEach((candidate, key) => session.pending.set(key, candidate));
        }
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
    }, {
        root: null,
        rootMargin: "600px 0px",
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
                session.mutationFlushTimer = window.setTimeout(
                    () => flushMutationRescans(session),
                    0,
                );
            }
        },
        afterIdle: () => scheduleFullPageDrain(session),
    });

    session = {
        active: true,
        modal: null,
        modalDirty: true,
        translationMode: invocation.fullPageMode ?? config.fullPageTranslationMode,
        scope: invocation.scope ?? config.translationScope,
        translationConfig: inheritedConfig ? {...inheritedConfig} : captureFullPageTranslationConfig(invocation),
        progressSessionId: startFullPageTranslationProgress(),
        progressPublishScheduled: false,
        observer,
        mutationObserver,
        shadowEventController: new AbortController(),
        roots: new Set(),
        pending: new Map(),
        scheduled: new Map(),
        observedCandidates: new Map(),
        candidateAnchors: new Map(),
        candidateOwnerKeys: new Map(),
        statefulTargetsByAncestor: new Map(),
        statefulAncestorsByTarget: new WeakMap(),
        lifecycleRetries: new WeakMap(),
        unchangedCandidates: new WeakMap(),
        userCancelledCandidates: new Map(),
        inFlightCandidates: new Map(),
        scrollController,
        bilingualRemountCapitulations: createBilingualRemountCapitulationRegistry(),
        translationSlotCache: new Map(),
        ...createFullPageRequestSessionState(),
        draining: false,
        flushTimer: null,
        dirtyRoots: new Set(),
        mutationFlushTimer: null,
        activeDiscovery: null,
        broadRescanRoots: new WeakSet([root]),
        broadRescanCooldowns: new WeakMap(),
        dirtyRootsBroadMode: false,
        pruneTimer: null,
        pruneIterator: null,
        pruneRequested: false,
        statefulAttributeTimers: new Map(),
        statefulAttributeRescanTargets: new WeakSet(),
    };
    return session;
}

function disposeFullPageSession(session: FullPageSession): void {
    session.active = false;
    syncModalTranslationHint(null, 'none', false);
    session.modal = null;
    session.modalDirty = false;
    disposeFullPageRequestSession(session, createAbortError());
    if (session.flushTimer !== null) window.clearTimeout(session.flushTimer);
    if (session.mutationFlushTimer !== null) window.clearTimeout(session.mutationFlushTimer);
    if (session.pruneTimer !== null) window.clearTimeout(session.pruneTimer);
    session.scrollController.dispose();
    session.statefulAttributeTimers.forEach((timer) => window.clearTimeout(timer));
    session.observer.disconnect();
    session.mutationObserver.disconnect();
    session.shadowEventController.abort();
    session.roots.clear();
    session.pending.clear();
    session.scheduled.clear();
    session.observedCandidates.clear();
    session.candidateAnchors.clear();
    session.candidateOwnerKeys.clear();
    session.statefulTargetsByAncestor.clear();
    session.statefulAncestorsByTarget = new WeakMap();
    session.inFlightCandidates.clear();
    session.userCancelledCandidates.clear();
    session.translationSlotCache.clear();
    session.dirtyRoots.clear();
    session.dirtyRootsBroadMode = false;
    session.activeDiscovery = null;
    session.pruneIterator = null;
    session.pruneRequested = false;
    session.statefulAttributeTimers.clear();
    session.statefulAttributeRescanTargets = new WeakSet();
    finishFullPageTranslationProgress(session.progressSessionId);
}

function stopFullPageSession(): void {
    const session = fullPageSession;
    if (!session) return;
    fullPageSession = null;
    disposeFullPageSession(session);
}
export function invalidateFullPageTranslationSessionCache(): void { if (fullPageSession?.active) invalidateFullPageRequestSessionCache(fullPageSession); }
export function resetFullPageTranslationRouteState(): void { hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry(); invalidateHoverTranslationRequestSession(); if (fullPageSession?.active) { fullPageSession.bilingualRemountCapitulations = createBilingualRemountCapitulationRegistry(); invalidateFullPageRequestSessionForRoute(fullPageSession); } resetAllBilingualArtifactHostWriteBudgets(); }

/**
 * 恢复全文翻译。全文和悬浮翻译共享同一份节点状态，因此这里无需再用
 * data-fr-node-id + innerHTML 覆盖页面，也能处理 Shadow DOM 和动态节点。
 */
export function restoreOriginalContent(): void {
    cancelPendingHoverTranslation();
    stopFullPageTitleTranslation();
    stopFullPageSession(); resetHoverTranslationRequestSession(createAbortError());
    hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
    resetAllBilingualArtifactHostWriteBudgets();
    withFullPageViewportAnchor(() => restoreAllTranslations());

    // 兼容升级前遗留的 wrapper/属性；新状态机不会依赖这些标记，但旧页面
    // 不应在扩展热更新后留下半截译文。
    const roots: Node[] = [document.documentElement, ...getOpenShadowRoots(document.documentElement)];
    for (const root of roots) {
        const queryRoot = root as Node & ParentNode;
        if (typeof queryRoot.querySelectorAll !== 'function') continue;
        // 用户可能在 clone/remount 后、50ms 发现批次运行前立即恢复。先解包
        // single-slot 中的 light DOM 原文，避免通用 orphan 删除把原文一并移除。
        normalizeOrphanedSingleSlots(root);
        const orphanOwners = new Set<Element>();
        queryRoot.querySelectorAll('[data-fr-translation-owned="true"]').forEach((element) => {
            const owner = element.parentElement;
            const htmlOwner = asHTMLElement(owner);
            if (htmlOwner && getTranslationState(htmlOwner)) return;
            if (owner) orphanOwners.add(owner);
            element.remove();
        });
        orphanOwners.forEach((owner) => {
            owner.classList.remove("fluent-read-bilingual", "fluent-read-failure");
        });
        queryRoot.querySelectorAll('[data-fr-translation-segment="true"]').forEach((segment) => {
            if (!segment.parentNode || getTranslationState(asHTMLElement(segment) as HTMLElement)) return;
            segment.replaceWith(...Array.from(segment.childNodes));
        });
    }
    notifyFullPageTranslationState(false);
}

/**
 * 启动全文翻译会话：根固定为 documentElement，使用较大的预取窗口和并发
 * 限制，并持续观察新增 DOM/open ShadowRoot。这样 body 被 SPA 替换后仍能
 * 继续工作，也不会一次性给整页发出数百个请求。
 */
export function autoTranslateEnglishPage(invocation: PageTranslationInvocation = {}, inheritedConfig?: FullPageTranslationConfigSnapshot): void {
    if (!checkConfig(invocation) || fullPageSession?.active) return;
    const root = document.documentElement;
    if (!root) return;

    const session = createFullPageSession(root, invocation, inheritedConfig);
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
    document.addEventListener('scroll', () => session.scrollController.note(), {
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
}
/** 仅共享无凭据的会话快照；旧 QQ 邮件 frame 使用同一目标语言、服务和展示设置。 */
export function getFullPageTranslationFrameState(): Omit<FrameTranslationState, 'enabled'> {
    const session = fullPageSession?.active ? fullPageSession : null;
    const revision = getFullPageTranslationStateRevision();
    return session ? {revision, sessionId: session.progressSessionId, translationConfig: {...session.translationConfig}, fullPageMode: session.translationMode, scope: session.scope} : {revision, sessionId: null};
}
export function isFullPageTranslationActive(): boolean {
    return fullPageSession?.active === true;
}
export function cancelPendingHoverTranslation(): void {
    if (hoverTimer === undefined) return;
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
}
/**
 * 处理鼠标悬浮/快捷键翻译。坐标只负责找到内容块，真正的翻译调用与全文
 * 会话共用 translateTarget，因此按钮、富文本和恢复行为不会出现两套规则。
 */
export function handleTranslation(
    mouseX: number,
    mouseY: number,
    invocation: PageTranslationConfigOverrides & {scope?: TranslationScope; delayMs?: number; continuous?: boolean} = {},
): void {
    const {delayMs = 0, continuous = false, scope = config.translationScope, ...translationOverrides} = invocation;
    if (continuous) beginBilingualArtifactHostWriteGesture();
    const translationConfig = captureFullPageTranslationConfig(translationOverrides); if (!checkConfig(translationConfig)) return;
    cancelPendingHoverTranslation();
    hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        const candidate = getOwnedTranslationCandidateAtPoint(document, mouseX, mouseY) ?? resolveTranslationCandidateAtPoint(mouseX, mouseY, scope);
        if (!candidate) return;
        void translateTarget(
            candidate,
            translationConfig.displayMode,
            continuous,
            undefined,
            translationConfig.requestOverridesApplied ? translationConfig : undefined,
        );
    }, delayMs);
}

export function handleBilingualTranslation(node: unknown, slide: boolean): void {
    translateNode(node, "bilingual", slide);
}
