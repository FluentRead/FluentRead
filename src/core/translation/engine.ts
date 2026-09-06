/**
 * @file src/core/translation/engine.ts
 *
 * 文件职责：实现 DOM 节点到 TranslationCandidate 的核心解析引擎，协调安全守卫、站点适配器、布局边界和文本有效性。
 * 主要内容：按正文/全部节点范围协调候选；定义 TranslationCandidateCore、候选优选与键值函数，记录发现步骤和原因，处理 hover 屏障、适配优先级、快照省略、缓存及坐标命中，保证全文与悬浮共享决策。 可核对的公开符号包括 TranslationCoreInspection、TranslationDiscoveryStep、getTranslationCandidateKey、selectPreferredTranslationCandidate、TranslationCandidateCore。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {
    composedAncestors,
    evaluateElementHardGuard,
    evaluateHardGuard,
    findElementsAtPoint,
    findNodeAtPoint,
    getComposedParent,
    isDocumentSurface,
    isExtensionElementSelf,
    isTopLevelApplicationShell,
    maxComposedAncestorDepth,
} from './dom';
import type {HardGuardResult} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {
    classifyGenericCandidate,
    findTranslationControlOwner,
    getDirectInlineRuns,
    getAllScopeCandidateKind,
    hasStructuralAncestor,
    isBlockBoundary,
    isSemanticHeadingElement,
    isStructuralContainer,
    isTranslationControlElement,
} from './layout';
import {
    createTranslationTextProtectionCache,
    hasMeaningfulTranslationTextInNodes,
    isTranslationTextElementProtected,
} from './text';
import type {TranslationTextProtectionCache} from './text';
import type {
    AdapterContext,
    AdapterDecision,
    TranslationCandidate,
    TranslationCoreOptions,
    TranslationSiteAdapter,
    TranslationScope,
} from './types';
import {
    findAdapterPrunedAncestor,
    inheritCachedFlag,
    partitionInlineRunAtBarriers,
    readCachedFlagOr,
} from './internal';

const maxHoverBarrierDiscoverySteps = 256;
/**
 * Shadow DOM 的坐标命中 API 属于宿主页面实现，异常组件可能把同一个 host
 * 再次返回给嵌套 root。坐标解析必须有独立于祖先扫描的深度上限，避免递归耗尽
 * content script 的调用栈并让页面看起来失去响应。
 */
const maxPointResolutionDepth = 64;

interface AdapterDecisionResult {
    decision: AdapterDecision;
    adapterId?: string;
}

interface AdapterPrunedAncestor {
    reason: string;
    adapterId?: string;
}

/** 仅在一次同步悬浮或检查调用内有效的缓存集合。 */
interface ResolutionEvaluationContext {
    textProtectionCache: TranslationTextProtectionCache;
    textProtectionOptions?: TranslationTextProtectionOptions;
    topLevelApplicationShellBypassed: boolean;
    hardGuards: WeakMap<Element, HardGuardResult>;
    adapterDecisions: WeakMap<Element, AdapterDecisionResult>;
    adapterPrunedAncestors: WeakMap<Element, AdapterPrunedAncestor | null>;
    extensionElements: WeakMap<Element, boolean>;
    structuralContainers: WeakMap<Element, boolean>;
    structuralAncestors: WeakMap<Element, boolean>;
}

function createResolutionEvaluationContext(
    textProtectionOptions?: TranslationTextProtectionOptions,
): ResolutionEvaluationContext {
    return {
        textProtectionCache: createTranslationTextProtectionCache(),
        textProtectionOptions,
        topLevelApplicationShellBypassed: false,
        hardGuards: new WeakMap(),
        adapterDecisions: new WeakMap(),
        adapterPrunedAncestors: new WeakMap(),
        extensionElements: new WeakMap(),
        structuralContainers: new WeakMap(),
        structuralAncestors: new WeakMap(),
    };
}

function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === 'function');
}

function asHTMLElement(element: Element | null | undefined): HTMLElement | null {
    if (!element || element.nodeType !== 1) return null;
    return element as HTMLElement;
}

function currentURL(): URL {
    const href = globalThis.location?.href ?? 'https://invalid.local/';
    try {
        return new URL(href);
    } catch {
        return new URL('https://invalid.local/');
    }
}

export interface TranslationCoreInspection {
    candidate: TranslationCandidate | null;
}

export interface TranslationDiscoveryStep {
    element: Element;
    phase: 'enter' | 'exit';
    candidate?: TranslationCandidate;
}

interface DiscoveryFrame {
    element: Element;
    phase: 'enter' | 'children' | 'exit';
    lightIndex: number;
    shadowIndex: number;
    shadowRoot: ShadowRoot | null;
    descendantHasCandidate: boolean;
    candidateChildBarriers: Set<Element>;
    ownAdapter?: ReturnType<TranslationCandidateCore['adapterDecision']>;
    forcedCandidate?: TranslationCandidate;
    forcedAtomic?: boolean;
    exitCandidates?: TranslationCandidate[];
    exitIndex: number;
    checkAncestors: boolean;
    insideStructural: boolean;
    pruned: boolean;
}

export function getTranslationCandidateKey(candidate: TranslationCandidate): Node {
    return candidate.nodes?.find((node) => node.nodeType === 1 || node.nodeType === 3) ?? candidate.element;
}

/** 当候选共享同一 DOM key 时，适配器的精确决策优先于通用候选。 */
export function selectPreferredTranslationCandidate(
    existing: TranslationCandidate | undefined,
    incoming: TranslationCandidate,
): TranslationCandidate {
    if (!existing) return incoming;
    if (existing.adapterId && !incoming.adapterId) return existing;
    if (incoming.adapterId && !existing.adapterId) return incoming;
    return existing;
}

/** 候选发现门面；翻译调度与渲染仍留在 runtime 端口。 */
export class TranslationCandidateCore {
    readonly url: URL;
    readonly scope: TranslationScope;
    readonly adapters: readonly TranslationSiteAdapter[];
    private readonly context: AdapterContext;
    private readonly discoveredCandidateChildBarriers = new WeakMap<Element, ReadonlySet<Element>>();

    constructor(options: TranslationCoreOptions = {}) {
        this.url = options.url ?? currentURL();
        this.scope = options.scope ?? 'content';
        // 全部节点是用户显式选择的通用界面范围，不继承站点的正文白名单、控件裁剪与
        // 元数据排除。脚本、表单输入、代码、隐藏区域等保护仍由统一 DOM 硬守卫负责。
        this.adapters = (this.scope === 'all' ? [] : options.adapters ?? [])
            .map((adapter, index) => ({adapter, index}))
            .filter(({adapter}) => {
                try {
                    return adapter.matches(this.url);
                } catch {
                    return false;
                }
            })
            .sort((left, right) =>
                (right.adapter.priority ?? 0) - (left.adapter.priority ?? 0) || left.index - right.index)
            .map(({adapter}) => adapter);
        this.context = {url: this.url};
    }

    private candidateResolutionMetadata(
        evaluationContext?: ResolutionEvaluationContext,
    ): Pick<TranslationCandidate, 'allowTopLevelApplicationShell' | 'scope'> {
        return {
            ...(this.scope === 'all' ? {scope: this.scope} : {}),
            ...(evaluationContext?.topLevelApplicationShellBypassed === true
                ? {allowTopLevelApplicationShell: true}
                : {}),
        };
    }

    private adapterDecision(
        element: Element,
        evaluationContext?: ResolutionEvaluationContext,
    ): AdapterDecisionResult {
        const cached = evaluationContext?.adapterDecisions.get(element);
        if (cached) return cached;

        for (const adapter of this.adapters) {
            try {
                const decision = adapter.decide(element, this.context);
                if (decision.kind !== 'pass') {
                    const result = {decision, adapterId: adapter.id};
                    evaluationContext?.adapterDecisions.set(element, result);
                    return result;
                }
            } catch {
                // 过期的第三方适配器不能中断通用候选发现。
            }
        }
        const result: AdapterDecisionResult = {decision: {kind: 'pass'}};
        evaluationContext?.adapterDecisions.set(element, result);
        return result;
    }

    /**
     * 站点可以选择只翻译自己明确声明的 target。该策略只收紧通用回退，
     * 不会阻止适配器返回的 force-target，因此全文与悬浮仍共享同一白名单。
     */
    private allowsGenericCandidates(): boolean {
        return !this.adapters.some((adapter) => adapter.genericCandidatePolicy === 'targets-only');
    }

    shouldStayOriginal = (element: Element): boolean => this.adapters.some((adapter) => {
        try {
            return adapter.shouldStayOriginal?.(element, this.context) === true;
        } catch {
            return false;
        }
    });

    /** 双语快照省略宿主元数据；原文保护仍由 shouldStayOriginal 独立负责。 */
    shouldOmitFromTranslation = (element: Element): boolean => this.adapters.some((adapter) => {
        try {
            return adapter.shouldOmitFromTranslation?.(element, this.context) === true;
        } catch {
            return false;
        }
    });

    shouldIgnoreMutation = (element: Element): boolean => this.adapters.some((adapter) => {
        try {
            return adapter.shouldIgnoreMutation?.(element, this.context) === true;
        } catch {
            return false;
        }
    });

    private hasAdapterPrunedAncestor(
        element: Element,
        evaluationContext?: ResolutionEvaluationContext,
    ): AdapterPrunedAncestor | null {
        if (evaluationContext?.adapterPrunedAncestors.has(element)) {
            return evaluationContext.adapterPrunedAncestors.get(element) ?? null;
        }

        const {result, inspected} = findAdapterPrunedAncestor(
            composedAncestors(element),
            maxComposedAncestorDepth,
            (ancestor) => this.adapterDecision(ancestor, evaluationContext),
        );
        if (result) {
            evaluationContext?.adapterPrunedAncestors.set(element, result);
            return result;
        }
        inspected.forEach((ancestor) => evaluationContext?.adapterPrunedAncestors.set(ancestor, null));
        return null;
    }

    private evaluateResolutionElementHardGuard(
        element: Element,
        evaluationContext: ResolutionEvaluationContext,
    ): HardGuardResult {
        const guard = evaluateElementHardGuard(element);
        const protectionOptions = evaluationContext.textProtectionOptions;
        if (guard.reason === 'inherited-no-translate' &&
            protectionOptions?.allowTopLevelApplicationShell === true &&
            element !== protectionOptions.protectedElement &&
            isTopLevelApplicationShell(element)) {
            evaluationContext.topLevelApplicationShellBypassed = true;
            return {prune: false};
        }
        return guard;
    }

    private primeResolutionAncestry(
        element: Element,
        evaluationContext: ResolutionEvaluationContext,
    ): void {
        if (evaluationContext.hardGuards.has(element) &&
            evaluationContext.structuralAncestors.has(element)) return;

        // 先收集完整 composed 祖先链，再自根向命中节点回填继承守卫和结构缓存，避免逐层重复上溯。
        const chain: Element[] = [];
        let current: Element | null = element;
        while (current && chain.length < maxComposedAncestorDepth) {
            chain.push(current);
            current = getComposedParent(current);
        }
        // 祖先链过深时直接缓存保守裁剪，不评估或缓存不完整的链前缀，也不再进入
        // 后续适配器祖先扫描。
        if (current) {
            evaluationContext.hardGuards.set(element, {
                prune: true,
                reason: 'ancestor-depth-limit',
            });
            return;
        }

        const ownGuards = chain.map((item) =>
            this.evaluateResolutionElementHardGuard(item, evaluationContext));
        let inheritedGuard: HardGuardResult = {prune: false};
        for (let index = chain.length - 1; index >= 0; index -= 1) {
            const item = chain[index]!;
            const ownGuard = ownGuards[index]!;
            inheritedGuard = ownGuard.prune ? ownGuard : inheritedGuard;
            evaluationContext.hardGuards.set(item, inheritedGuard);

            const parent = getComposedParent(item);
            const hasStructuralAncestor = Boolean(parent && !isDocumentSurface(parent) && (
                this.isStructuralContainerForResolution(parent, evaluationContext) ||
                evaluationContext.structuralAncestors.get(parent) === true
            ));
            evaluationContext.structuralAncestors.set(item, hasStructuralAncestor);
        }
    }

    private hardGuard(
        element: Element,
        evaluationContext?: ResolutionEvaluationContext,
    ): HardGuardResult {
        if (!evaluationContext) return evaluateHardGuard(element);
        this.primeResolutionAncestry(element, evaluationContext);
        // primeResolutionAncestry 的正常、缓存命中与超深路径都会为命中元素写入结果。
        return evaluationContext.hardGuards.get(element)!;
    }

    private isExtensionElementForResolution(
        element: Element,
        evaluationContext: ResolutionEvaluationContext,
    ): boolean {
        if (evaluationContext.extensionElements.has(element)) {
            return evaluationContext.extensionElements.get(element) === true;
        }
        const chain: Element[] = [];
        let current: Element | null = element;
        while (current && !evaluationContext.extensionElements.has(current)) {
            chain.push(current);
            // 旧实现使用的 Element.closest() 不会跨越 ShadowRoot，这里保留相同的所有权边界。
            current = current.parentElement;
        }
        let inherited = inheritCachedFlag(current, evaluationContext.extensionElements);
        for (let index = chain.length - 1; index >= 0; index -= 1) {
            inherited = inherited || isExtensionElementSelf(chain[index]!);
            evaluationContext.extensionElements.set(chain[index]!, inherited);
        }
        return evaluationContext.extensionElements.get(element) === true;
    }

    private isStructuralContainerForResolution(
        element: Element,
        evaluationContext: ResolutionEvaluationContext,
    ): boolean {
        if (this.scope === 'all') return false;
        const cached = evaluationContext.structuralContainers.get(element);
        if (cached !== undefined) return cached;
        const result = isStructuralContainer(element);
        evaluationContext.structuralContainers.set(element, result);
        return result;
    }

    private hasStructuralAncestorForResolution(
        element: Element,
        evaluationContext: ResolutionEvaluationContext,
    ): boolean {
        this.primeResolutionAncestry(element, evaluationContext);
        return readCachedFlagOr(
            evaluationContext.structuralAncestors,
            element,
            () => hasStructuralAncestor(element),
        );
    }

    inspect(element: Element, textProtectionOptions?: TranslationTextProtectionOptions): TranslationCoreInspection {
        const evaluationContext = createResolutionEvaluationContext(textProtectionOptions);
        return this.inspectWithTextProtectionCache(
            element,
            evaluationContext.textProtectionCache,
            evaluationContext,
        );
    }

    private inspectWithTextProtectionCache(
        element: Element,
        textProtectionCache: TranslationTextProtectionCache,
        evaluationContext?: ResolutionEvaluationContext,
    ): TranslationCoreInspection {
        const hardGuard = this.hardGuard(element, evaluationContext);
        if (hardGuard.prune) {
            return {candidate: null};
        }

        const pruned = this.hasAdapterPrunedAncestor(element, evaluationContext);
        if (pruned) {
            return {candidate: null};
        }

        const {decision, adapterId} = this.adapterDecision(element, evaluationContext);
        if (decision.kind === 'skip-self') {
            return {candidate: null};
        }
        if (decision.kind === 'force-target') {
            const target = asHTMLElement(decision.target ?? element);
            if (!target || !hasMeaningfulTranslationTextInNodes(
                [target],
                this.shouldStayOriginal,
                textProtectionCache,
                evaluationContext?.textProtectionOptions,
            ) ||
                this.hardGuard(target, evaluationContext).prune) {
                return {candidate: null};
            }
            const candidate: TranslationCandidate = {
                element: target,
                kind: decision.candidateKind ?? (findTranslationControlOwner(target) ? 'control' : 'content'),
                reason: decision.reason,
                adapterId,
                ...this.candidateResolutionMetadata(evaluationContext),
            };
            return {candidate};
        }

        if (!this.allowsGenericCandidates()) {
            return {candidate: null};
        }

        if (this.scope === 'content' && evaluationContext &&
            this.hasStructuralAncestorForResolution(element, evaluationContext) &&
            !isSemanticHeadingElement(element)) {
            return {candidate: null};
        }
        const classification = classifyGenericCandidate(
            element,
            this.shouldStayOriginal,
            evaluationContext !== undefined,
            textProtectionCache,
            evaluationContext?.textProtectionOptions,
            this.scope,
        );
        if (!classification) {
            return {candidate: null};
        }
        const candidate: TranslationCandidate = {
            element: element as HTMLElement,
            kind: classification.kind,
            reason: classification.reason,
            ...this.candidateResolutionMetadata(evaluationContext),
        };
        return {candidate};
    }

    private inlineRunCandidates(
        element: Element,
        skipStructuralAncestorCheck = false,
        textProtectionCache = createTranslationTextProtectionCache(),
        candidateChildBarriers?: ReadonlySet<Element>,
        evaluationContext?: ResolutionEvaluationContext,
    ): TranslationCandidate[] {
        if (!this.allowsGenericCandidates()) {
            const decision = this.adapterDecision(element, evaluationContext).decision;
            if (decision.kind !== 'force-target' || decision.atomic !== false ||
                (decision.target ?? element) !== element) return [];
        }
        const candidates: TranslationCandidate[] = [];
        const atomicTargetCache = new WeakMap<Element, boolean>();
        const protectionOptions = evaluationContext?.textProtectionOptions;
        const isAtomicAdapterTarget = (candidate: Element): boolean => {
            const cached = atomicTargetCache.get(candidate);
            if (cached !== undefined) return cached;
            const decision = this.adapterDecision(candidate, evaluationContext).decision;
            const target = decision.kind === 'force-target' ? decision.target ?? candidate : null;
            const result = decision.kind === 'force-target' && decision.atomic !== false && target === candidate;
            atomicTargetCache.set(candidate, result);
            return result;
        };
        const isDirectRunBarrier = (candidate: Element): boolean =>
            candidateChildBarriers?.has(candidate) === true ||
            isAtomicAdapterTarget(candidate) || isTranslationControlElement(candidate) ||
            (this.scope === 'all' && isTranslationTextElementProtected(
                candidate, this.shouldStayOriginal, textProtectionCache, protectionOptions,
            ));
        for (const run of getDirectInlineRuns(
            element,
            this.shouldStayOriginal,
            skipStructuralAncestorCheck,
            isDirectRunBarrier,
            textProtectionCache,
            protectionOptions,
            this.scope,
        )) {
            const partitions = partitionInlineRunAtBarriers(
                run,
                (node) => isElementNode(node) && isDirectRunBarrier(node),
            );
            for (const nodes of partitions) {
                if (hasMeaningfulTranslationTextInNodes(
                    nodes,
                    this.shouldStayOriginal,
                    textProtectionCache,
                    protectionOptions,
                )) {
                    candidates.push({
                        element: element as HTMLElement,
                        nodes,
                        kind: this.scope === 'all' ? getAllScopeCandidateKind(element)
                            : findTranslationControlOwner(element) ? 'control' : 'content',
                        reason: 'generic-inline-run',
                        ...this.candidateResolutionMetadata(evaluationContext),
                    });
                }
            }
        }
        return candidates;
    }

    private genericCandidateForDiscovery(
        element: Element,
        insideStructural: boolean,
        textProtectionCache: TranslationTextProtectionCache,
    ): TranslationCandidate | null {
        if (!this.allowsGenericCandidates()) return null;
        if (this.scope === 'content' && insideStructural && !isSemanticHeadingElement(element)) return null;
        const classification = classifyGenericCandidate(
            element,
            this.shouldStayOriginal,
            true,
            textProtectionCache,
            undefined,
            this.scope,
        );
        if (!classification) return null;
        return {
            element: element as HTMLElement,
            kind: classification.kind,
            reason: classification.reason,
            ...this.candidateResolutionMetadata(),
        };
    }

    private resolveInlineRun(
        element: Element,
        start: Node,
        evaluationContext: ResolutionEvaluationContext,
    ): TranslationCandidate | null {
        const decision = this.adapterDecision(element, evaluationContext).decision;
        const explicitContainer = decision.kind === 'force-target' && decision.atomic === false &&
            (decision.target ?? element) === element;
        if (this.scope === 'content' && (isDocumentSurface(element) || (!explicitContainer && (
            this.isStructuralContainerForResolution(element, evaluationContext) ||
            this.hasStructuralAncestorForResolution(element, evaluationContext) ||
            !isBlockBoundary(element))) ||
            element.children.length === 0)) {
            return null;
        }
        // 优先探测全文后序发现记录的所有权屏障，再在统一严格预算内复核每个内联子节点；
        // 即使页面实时变更，也能保持两种发现结果一致，而不会在指针处理中无限遍历子树。
        const candidates = this.inlineRunCandidates(
            element,
            true,
            evaluationContext.textProtectionCache,
            this.probeHoverCandidateChildBarriers(
                element,
                this.discoveredCandidateChildBarriers.get(element),
            ),
            evaluationContext,
        );
        if (candidates.length === 0) return null;
        let direct: Node | null = start;
        while (direct && direct !== element && direct.parentNode !== element) direct = direct.parentNode;
        if (!direct || direct === element) return candidates[0]!;
        return candidates.find((candidate) => candidate.nodes?.includes(direct as ChildNode)) ?? null;
    }

    private probeHoverCandidateChildBarriers(
        element: Element,
        discoveredBarriers?: ReadonlySet<Element>,
    ): ReadonlySet<Element> {
        const barriers = new Set<Element>();
        let remainingSteps = maxHoverBarrierDiscoverySteps;
        const children = Array.from(element.children);
        // 先复核既有屏障，因为只有它们的过期所有权会让悬浮结果偏离对脏子树的全新发现；
        // 未知子节点仍与它们共享同一总预算。
        const orderedChildren = discoveredBarriers
            ? [
                ...children.filter((child) => discoveredBarriers.has(child)),
                ...children.filter((child) => !discoveredBarriers.has(child)),
            ]
            : children;

        for (const child of orderedChildren) {
            // 原生块边界已由 layout.ts 切分直接内联 run。
            if (isBlockBoundary(child)) continue;
            if (remainingSteps <= 0) {
                // 有界悬浮探测耗尽预算时，绝不能仅因此移动尚未检查的子树。既有屏障也要
                // 保守保留；只有后续能重新验证实时子树时，才不再盲目信任旧结果。
                barriers.add(child);
                continue;
            }

            let ownsCandidate = false;
            let exhausted = false;
            for (const step of this.discoverSteps(child)) {
                remainingSteps -= 1;
                if (step.candidate) {
                    ownsCandidate = true;
                    break;
                }
                if (remainingSteps <= 0) {
                    exhausted = true;
                    break;
                }
            }
            if (ownsCandidate || exhausted) barriers.add(child);
        }
        return barriers;
    }

    resolve(start: Node | null | undefined): TranslationCandidate | null {
        if (!start) return null;
        const hit = start;
        let current: Element | null = start.nodeType === 3
            ? (start as Text).parentElement
            : isElementNode(start) ? start : null;
        if (!current) return null;
        const evaluationContext = createResolutionEvaluationContext(this.scope === 'content' ? {
            allowTopLevelApplicationShell: true,
            protectedElement: current,
        } : undefined);
        const textProtectionCache = evaluationContext.textProtectionCache;

        while (current && (this.scope === 'all' || !isDocumentSurface(current))) {
            if (current.matches('[data-fr-translation-segment="true"]')) {
                return {
                    element: current as HTMLElement,
                    kind: this.scope === 'all'
                        ? getAllScopeCandidateKind(getComposedParent(current) ?? current)
                        : findTranslationControlOwner(current) ? 'control' : 'content',
                    reason: 'owned-inline-run',
                    ...this.candidateResolutionMetadata(evaluationContext),
                };
            }
            // 命中扩展的双语 wrapper 时，继续映射回宿主页源节点。
            if (current.matches('.fluent-read-bilingual-content')) {
                current = current.parentElement;
                continue;
            }
            if (this.isExtensionElementForResolution(current, evaluationContext)) {
                current = getComposedParent(current);
                continue;
            }
            // 继承硬守卫适用于每个可能的祖先候选；遇到极深树时立即停止，避免反复上溯。
            const guardReason = this.hardGuard(current, evaluationContext).reason;
            if (guardReason === 'ancestor-depth-limit' || guardReason === 'foreign-translation') return null;
            // 外壳本身不是显式目标；避免在缺少更细粒度块边界的 SPA 中把整个应用根
            // 当作候选，同时允许继续向其上方寻找正常的页面结构。
            if (isTopLevelApplicationShell(current) &&
                current !== evaluationContext.textProtectionOptions?.protectedElement) {
                current = getComposedParent(current);
                continue;
            }
            // 全文发现会在遍历子节点前裁剪适配器拥有的受控子树；悬浮解析也必须先应用
            // 相同的继承裁剪，再尝试通用内联 run。否则命中 GitHub Quick Search 等区域时，
            // 可能解析出本应被 discover() 排除的对话框祖先。
            if (this.hasAdapterPrunedAncestor(current, evaluationContext)) return null;
            const ownDecision = this.adapterDecision(current, evaluationContext).decision;
            if (ownDecision.kind === 'force-target' && ownDecision.atomic !== false) {
                const exact = this.inspectWithTextProtectionCache(
                    current,
                    textProtectionCache,
                    evaluationContext,
                ).candidate;
                if (exact) return exact;
            }
            // 混合直接内容必须解析为全文遍历产出的同一个 run；这样原子适配目标旁的普通文本
            // 也不会回退成整个父容器。
            const inlineRun = this.resolveInlineRun(current, hit, evaluationContext);
            if (inlineRun) return inlineRun;
            const inspection = this.inspectWithTextProtectionCache(
                current,
                textProtectionCache,
                evaluationContext,
            );
            if (inspection.candidate) return inspection.candidate;
            if (this.isStructuralContainerForResolution(current, evaluationContext)) return null;
            current = getComposedParent(current);
        }
        return null;
    }

    /**
     * 增量后序发现：每访问一个元素都会产出一步，包括被拒绝或裁剪的元素，
     * 使全文调用方可以执行帧预算而不改变候选语义。
     */
    *discoverSteps(root: Node): Generator<TranslationDiscoveryStep> {
        const visited = new Set<Element>();
        const textProtectionCache = createTranslationTextProtectionCache();
        const roots: Element[] = [];
        if (isElementNode(root)) {
            // 动态控件可能先只有图标，再把文字写入内层 flex 标签。该标签本身不再是
            // 正文候选，因此局部重扫应回到同一控件边界；被明确保护的脏子树不能提升。
            const controlOwner = findTranslationControlOwner(root);
            roots.push(controlOwner && controlOwner !== root &&
                !evaluateHardGuard(root).prune && !this.hasAdapterPrunedAncestor(root)
                ? controlOwner : root);
        } else if ('children' in root) {
            const children = (root as Document | ShadowRoot).children;
            for (let index = 0; index < children.length; index += 1) {
                const child = children.item(index);
                if (child) roots.push(child);
            }
        }
        for (const rootElement of roots) {
            const stack: DiscoveryFrame[] = [{
                element: rootElement,
                phase: 'enter',
                lightIndex: 0,
                shadowIndex: 0,
                shadowRoot: null,
                descendantHasCandidate: false,
                candidateChildBarriers: new Set(),
                exitIndex: 0,
                checkAncestors: true,
                insideStructural: this.scope === 'content' && hasStructuralAncestor(rootElement),
                pruned: false,
            }];

            while (stack.length > 0) {
                const frame = stack[stack.length - 1]!;

                if (frame.phase === 'enter') {
                    if (visited.has(frame.element)) {
                        stack.pop();
                        continue;
                    }
                    visited.add(frame.element);
                    isTranslationTextElementProtected(
                        frame.element,
                        this.shouldStayOriginal,
                        textProtectionCache,
                    );
                    const hardGuard = frame.checkAncestors
                        ? evaluateHardGuard(frame.element)
                        : evaluateElementHardGuard(frame.element);
                    const ownAdapter = this.adapterDecision(frame.element);
                    frame.ownAdapter = ownAdapter;
                    frame.shadowRoot = frame.element.shadowRoot;
                    frame.pruned = hardGuard.prune || ownAdapter.decision.kind === 'prune-subtree';
                    frame.phase = frame.pruned
                        ? 'exit'
                        : 'children';

                    if (ownAdapter.decision.kind === 'force-target' && !hardGuard.prune) {
                        frame.forcedCandidate = this.inspectWithTextProtectionCache(
                            frame.element,
                            textProtectionCache,
                        ).candidate ?? undefined;
                        frame.forcedAtomic = ownAdapter.decision.atomic !== false;
                        if (frame.forcedCandidate && ownAdapter.decision.atomic !== false) frame.phase = 'exit';
                    }
                    yield {element: frame.element, phase: 'enter'};
                    continue;
                }

                if (frame.phase === 'children') {
                    const child = frame.element.children.item(frame.lightIndex);
                    if (child) {
                        frame.lightIndex += 1;
                        stack.push({
                            element: child,
                            phase: 'enter',
                            lightIndex: 0,
                            shadowIndex: 0,
                            shadowRoot: null,
                            descendantHasCandidate: false,
                            candidateChildBarriers: new Set(),
                            exitIndex: 0,
                            checkAncestors: false,
                            insideStructural: this.scope === 'content' &&
                                (frame.insideStructural || isStructuralContainer(frame.element)),
                            pruned: false,
                        });
                        continue;
                    }

                    const shadowRoot = frame.shadowRoot;
                    const shadowChild = shadowRoot?.children.item(frame.shadowIndex) ?? null;
                    if (shadowChild) {
                        frame.shadowIndex += 1;
                        stack.push({
                            element: shadowChild,
                            phase: 'enter',
                            lightIndex: 0,
                            shadowIndex: 0,
                            shadowRoot: null,
                            descendantHasCandidate: false,
                            candidateChildBarriers: new Set(),
                            exitIndex: 0,
                            checkAncestors: false,
                            insideStructural: this.scope === 'content' &&
                                (frame.insideStructural || isStructuralContainer(frame.element)),
                            pruned: false,
                        });
                        continue;
                    }
                    frame.phase = 'exit';
                }

                if (!frame.exitCandidates) {
                    if (frame.forcedCandidate) {
                        frame.exitCandidates = frame.forcedAtomic === false && frame.descendantHasCandidate
                            ? this.inlineRunCandidates(
                                frame.element,
                                true,
                                textProtectionCache,
                                frame.candidateChildBarriers,
                            )
                            : [frame.forcedCandidate];
                    } else if (frame.ownAdapter?.decision.kind === 'skip-self' ||
                        frame.ownAdapter?.decision.kind === 'prune-subtree' ||
                        frame.pruned) {
                        frame.exitCandidates = [];
                    } else if (frame.descendantHasCandidate) {
                        frame.exitCandidates = frame.insideStructural
                            ? []
                            : this.inlineRunCandidates(
                                frame.element,
                                true,
                                textProtectionCache,
                                frame.candidateChildBarriers,
                            );
                    } else {
                        const candidate = this.genericCandidateForDiscovery(
                            frame.element,
                            frame.insideStructural,
                            textProtectionCache,
                        );
                        frame.exitCandidates = candidate ? [candidate] : this.scope === 'all'
                            ? this.inlineRunCandidates(
                                frame.element, true, textProtectionCache, frame.candidateChildBarriers,
                            )
                            : [];
                    }
                    this.discoveredCandidateChildBarriers.set(
                        frame.element,
                        frame.candidateChildBarriers,
                    );
                }

                const candidate = frame.exitCandidates[frame.exitIndex];
                frame.exitIndex += 1;
                const hasMore = frame.exitIndex < frame.exitCandidates.length;
                if (!hasMore) {
                    const hasCandidate = frame.descendantHasCandidate || frame.exitCandidates.length > 0;
                    stack.pop();
                    const parent = stack[stack.length - 1];
                    if (parent && hasCandidate) {
                        parent.descendantHasCandidate = true;
                        // 后序发现中，一旦直接子树已经拥有候选，祖先的合成内联 run
                        // 就不能再把该子树移动到第二个候选中。
                        if (frame.element.parentElement === parent.element) {
                            parent.candidateChildBarriers.add(frame.element);
                        }
                    }
                }
                yield candidate
                    ? {element: frame.element, phase: 'exit', candidate}
                    : {element: frame.element, phase: 'exit'};
            }
        }
    }

    discover(root: Node): TranslationCandidate[] {
        const unique = new Map<Node, TranslationCandidate>();
        for (const {candidate} of this.discoverSteps(root)) {
            if (!candidate) continue;
            const key = getTranslationCandidateKey(candidate);
            const existing = unique.get(key);
            unique.set(key, selectPreferredTranslationCandidate(existing, candidate));
        }
        return [...unique.values()];
    }

    resolveAtPoint(root: Document | ShadowRoot, x: number, y: number): TranslationCandidate | null {
        const visitedRoots = new Set<Document | ShadowRoot>();
        const resolveInRoot = (currentRoot: Document | ShadowRoot, depth: number): TranslationCandidate | null => {
            if (depth > maxPointResolutionDepth || visitedRoots.has(currentRoot)) return null;
            visitedRoots.add(currentRoot);

            const pointedNode = findNodeAtPoint(currentRoot, x, y);
            if (pointedNode) {
                const pointedCandidate = this.resolve(pointedNode);
                if (pointedCandidate) return pointedCandidate;
            }

            for (const element of findElementsAtPoint(currentRoot, x, y)) {
                if (element.shadowRoot) {
                    const shadowCandidate = resolveInRoot(element.shadowRoot, depth + 1);
                    if (shadowCandidate) return shadowCandidate;
                }
                const candidate = this.resolve(element);
                if (candidate) return candidate;
            }
            return null;
        };

        return resolveInRoot(root, 0);
    }
}
