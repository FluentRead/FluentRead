/**
 * @file src/core/translation/engine.ts
 *
 * 文件职责：实现 DOM 节点到 TranslationCandidate 的核心解析引擎，协调安全守卫、站点适配器、布局边界和文本有效性。
 * 主要内容：按正文/全部节点范围协调候选；定义 TranslationCandidateCore、候选优选与键值函数，记录发现步骤和原因，按站点规则把显式换行拆为两种入口一致的内联候选，处理编辑器坐标命中屏障、hover 屏障、适配优先级、快照省略、缓存及坐标命中；同步只读批量解析复用全部范围及无站点适配/应用外壳例外的普通正文祖先守卫和文本保护，涉及显式外壳权限或站点重定向目标时独立解析；无元素子节点的非文档表面不重复探测不可能成立的内联分段，仍由完整候选分类复验文本和保护；悬浮命中独立后代的包裹层时禁止回退吞并整个容器，让独立 tooltip 不抢占外层控件候选，保证全文与悬浮共享决策。 可核对的公开符号包括 TranslationCoreInspection、TranslationDiscoveryStep、getTranslationCandidateKey、selectPreferredTranslationCandidate、TranslationCandidateCore。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，坐标命中栈与祖先守卫只在单次同步解析中复用，不跨手势缓存；不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {isTranslationTooltip} from './dom';
import {
    composedAncestors,
    evaluateElementHardGuard,
    evaluateHardGuard,
    findElementsAtPoint,
    findNodeAtPoint,
    getComposedParent,
    getTranslatableControlValueAttribute,
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
    isIncludedSidebarRegion,
    isBlockBoundary,
    isSemanticHeadingElement,
    isStructuralContainer,
    type StructuralRegionOptions,
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
import {resolveVisualTranslationRange} from './visual';

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

interface InlineRunResolution {
    candidate: TranslationCandidate | null;
    /** 已有独立后代或探测预算耗尽时，不能再把当前容器整体当作回退候选。 */
    blocksWholeCandidate: boolean;
}

interface InlineRunSummary {
    candidates: TranslationCandidate[];
    blocksWholeCandidate: boolean;
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
    adapterContext?: AdapterContext;
    adapterPrunedAncestors: WeakMap<Element, AdapterPrunedAncestor | null>;
    extensionElements: WeakMap<Element, boolean>;
    structuralContainers: WeakMap<Element, boolean>;
    structuralAncestors: WeakMap<Element, boolean>;
    inlineRuns: WeakMap<Element, InlineRunSummary>;
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
        inlineRuns: new WeakMap(),
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
    /** 正文范围下是否把侧边栏与导航当作可翻译内容。 */
    readonly includeSidebarRegions: boolean;
    readonly adapters: readonly TranslationSiteAdapter[];
    private readonly context: AdapterContext;
    private readonly discoveredCandidateChildBarriers = new WeakMap<Element, ReadonlySet<Element>>();

    constructor(options: TranslationCoreOptions = {}) {
        this.url = options.url ?? currentURL();
        this.scope = options.scope ?? 'content';
        this.includeSidebarRegions = options.includeSidebarRegions === true;
        // 全部节点默认绕过站点正文边界，仅保留显式适用于全部范围的规则（如模型名称）。
        // 脚本、表单输入、代码、隐藏区域等保护仍由统一 DOM 硬守卫负责。
        this.adapters = (options.adapters ?? [])
            .filter(adapter => this.scope !== 'all' || adapter.allScopes === true)
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

    private structuralRegionOptions(): StructuralRegionOptions | undefined {
        return this.includeSidebarRegions ? {includeSidebarRegions: true} : undefined;
    }

    /**
     * 判断元素本身或其祖先是否属于正文范围下保持原文的页面框架（header/footer/nav/aside）。
     * 全文翻译据此跳过框架；用户显式点选框架区域时，调用方可据此改用全部节点范围。
     */
    isWithinStructuralRegion(element: Element): boolean {
        if (this.scope !== 'content') return false;
        const options = this.structuralRegionOptions();
        return isStructuralContainer(element, options) || hasStructuralAncestor(element, options);
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
                const decision = adapter.decide(element, this.adapterContextForResolution(evaluationContext));
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

    private adapterContextForResolution(evaluationContext?: ResolutionEvaluationContext): AdapterContext {
        return evaluationContext?.adapterContext ?? this.context;
    }

    shouldStayOriginal = (element: Element): boolean => this.shouldStayOriginalWithContext(element, this.context);

    private shouldStayOriginalWithContext(element: Element, context: AdapterContext): boolean {
        return this.adapters.some((adapter) => {
            try {
                return adapter.shouldStayOriginal?.(element, context) === true;
            } catch {
                return false;
            }
        });
    }

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
            evaluationContext.hardGuards.get(item) ?? this.evaluateResolutionElementHardGuard(item, evaluationContext));
        let inheritedGuard: HardGuardResult = {prune: false};
        for (let index = chain.length - 1; index >= 0; index -= 1) {
            const item = chain[index]!;
            const ownGuard = ownGuards[index]!;
            inheritedGuard = ownGuard.prune ? ownGuard : inheritedGuard;
            evaluationContext.hardGuards.set(item, inheritedGuard);

            // 全部节点范围不使用正文结构祖先；完整硬守卫仍由上方祖先链评估。
            const parent = this.scope === 'all' ? null : getComposedParent(item);
            const hasStructuralAncestor = Boolean(parent && !isDocumentSurface(parent) && (
                !isIncludedSidebarRegion(item, this.structuralRegionOptions()) &&
                !isIncludedSidebarRegion(parent, this.structuralRegionOptions()) &&
                (this.isStructuralContainerForResolution(parent, evaluationContext) ||
                    evaluationContext.structuralAncestors.get(parent) === true)
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
        const result = isStructuralContainer(element, this.structuralRegionOptions());
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
            () => hasStructuralAncestor(element, this.structuralRegionOptions()),
        );
    }

    inspect(element: Element, textProtectionOptions?: TranslationTextProtectionOptions): TranslationCoreInspection {
        const evaluationContext = createResolutionEvaluationContext(textProtectionOptions);
        // 只在此同步只读 inspect 生效；resolve/discover 与不同 owner 不共享。
        evaluationContext.adapterContext = {...this.context, closestSelectorMisses: new WeakMap()};
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
        const adapterContext = this.adapterContextForResolution(evaluationContext);
        const shouldStayOriginal = evaluationContext?.adapterContext
            ? (item: Element) => this.shouldStayOriginalWithContext(item, adapterContext)
            : this.shouldStayOriginal;
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
                shouldStayOriginal,
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
            shouldStayOriginal,
            evaluationContext !== undefined,
            textProtectionCache,
            evaluationContext?.textProtectionOptions,
            this.scope,
            this.structuralRegionOptions(),
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

    /** 显式站点换行规则与普通内联 run 共用边界和预算，宿主 br 始终留在原位。 */
    private splitForcedCandidate(
        candidate: TranslationCandidate,
        decision: AdapterDecision,
        textProtectionCache: TranslationTextProtectionCache,
        evaluationContext?: ResolutionEvaluationContext,
    ): TranslationCandidate[] {
        if (decision.kind !== 'force-target' || !decision.splitOnBr) return [candidate];
        // 未出现显式换行时仍使用完整段落；超宽节点由下层预算拒绝物化。
        if (candidate.element.childNodes.length <= 2048 &&
            !Array.from(candidate.element.children).some((child) => child.localName === 'br')) return [candidate];
        const runs = getDirectInlineRuns(
            candidate.element, this.shouldStayOriginal, true,
            (child) => child.localName === 'br' || isTranslationControlElement(child),
            textProtectionCache, evaluationContext?.textProtectionOptions, this.scope,
        );
        return runs.map((nodes) => ({...candidate, nodes, sourceLine: true}));
    }

    private inlineRunCandidates(
        element: Element,
        skipStructuralAncestorCheck: boolean,
        textProtectionCache: TranslationTextProtectionCache,
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
            this.structuralRegionOptions(),
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
    ): InlineRunResolution | null {
        // 内联分段必须存在元素屏障；没有元素子节点时 getDirectInlineRuns 必定为空。
        // 全部范围的 html/body 是独立例外：只有直接 Text 时也需要产出内联 run。
        // 这里只省略分段探测，后续 inspect 仍完整核对保护、原文有效性与候选归属。
        if (element.children.length === 0 && !isDocumentSurface(element)) return null;
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
        let summary = evaluationContext.inlineRuns.get(element);
        if (!summary) {
            const childBarriers = this.probeHoverCandidateChildBarriers(
                element,
                this.discoveredCandidateChildBarriers.get(element),
                explicitContainer,
            );
            summary = {
                candidates: this.inlineRunCandidates(
                    element, true, evaluationContext.textProtectionCache, childBarriers, evaluationContext,
                ),
                blocksWholeCandidate: childBarriers.size > 0,
            };
            evaluationContext.inlineRuns.set(element, summary);
        }
        const {candidates, blocksWholeCandidate} = summary;
        if (candidates.length === 0) return {candidate: null, blocksWholeCandidate};
        let direct: Node | null = start;
        while (direct && direct !== element && direct.parentNode !== element) direct = direct.parentNode;
        const candidate = !direct || direct === element
            ? candidates[0]!
            : candidates.find((candidate) => candidate.nodes!.includes(direct as ChildNode)) ?? null;
        return {candidate, blocksWholeCandidate};
    }

    private probeHoverCandidateChildBarriers(
        element: Element,
        discoveredBarriers?: ReadonlySet<Element>,
        includeBlockChildren = false,
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
            // 通用候选已由 layout.ts 拒绝可读块子节点；显式非原子容器还需复核这些
            // 子树是否拥有候选，否则 force-target 的回退路径仍可能吞掉整组段落。
            if (!includeBlockChildren && isBlockBoundary(child)) continue;
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
                // discoverSteps 会把脏子树提升到所属控件边界重扫，因此步骤里也会出现兄弟节点
                // 甚至父级自身的候选。只有落在该子节点内部的候选才代表它自己拥有翻译目标；
                // 否则父级内联 run 会被自己的成员当成屏障切掉，导致发现与悬浮解析结果不一致。
                if (step.candidate && (step.candidate.element === child ||
                    child.contains(step.candidate.element))) {
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
        return this.resolveWithContext(start);
    }

    /** 仅在同一同步只读阶段复用；写 DOM 或让出任务后必须重新创建。 */
    createSynchronousResolver(): (start: Node | null | undefined) => TranslationCandidate | null {
        const context = createResolutionEvaluationContext();
        const shellAncestry = new WeakMap<Element, boolean>();
        return start => {
            if (this.scope === 'all') return this.resolveWithContext(start, context);
            // 站点适配器可以把命中重定向到另一棵子树，仍使用每次命中的独立权限上下文。
            if (this.adapters.length > 0) return this.resolveWithContext(start);
            let current: Element | null = start?.nodeType === 3
                ? (start as Text).parentElement : isElementNode(start) ? start : null;
            const chain: Element[] = [];
            while (current && !shellAncestry.has(current) && chain.length < maxComposedAncestorDepth) {
                chain.push(current);
                if (isTopLevelApplicationShell(current)) break;
                current = getComposedParent(current);
            }
            // 应用外壳上显式命中与命中其正文拥有不同 protectedElement；超深链也独立保守解析。
            const isolated = current !== null && (shellAncestry.get(current) ?? true);
            for (const element of chain) shellAncestry.set(element, isolated);
            // 无外壳的通用正文不可能用到 allowTopLevelApplicationShell，故可共享普通保护结果。
            return this.resolveWithContext(start, isolated ? undefined : context);
        };
    }

    private resolveWithContext(
        start: Node | null | undefined,
        sharedContext?: ResolutionEvaluationContext,
    ): TranslationCandidate | null {
        if (!start) return null;
        const hit = start;
        let current: Element | null = start.nodeType === 3
            ? (start as Text).parentElement
            : isElementNode(start) ? start : null;
        if (!current) return null;
        const evaluationContext = sharedContext ?? createResolutionEvaluationContext(this.scope === 'content' ? {
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
            const guard = this.hardGuard(current, evaluationContext);
            const guardReason = guard.reason;
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
            // 当前元素已经由继承硬守卫拒绝，内联屏障与子树探测不可能产生候选。
            // 仍向上寻找合法宿主，并保留上面的适配器裁剪边界。
            if (guard.prune) {
                current = getComposedParent(current);
                continue;
            }
            const ownDecision = this.adapterDecision(current, evaluationContext).decision;
            if (ownDecision.kind === 'force-target' && ownDecision.atomic !== false) {
                const exact = this.inspectWithTextProtectionCache(
                    current,
                    textProtectionCache,
                    evaluationContext,
                ).candidate;
                if (exact) {
                    const candidates = this.splitForcedCandidate(exact, ownDecision, textProtectionCache, evaluationContext);
                    if (!ownDecision.splitOnBr) return exact;
                    if (hit === exact.element) return candidates[0] ?? null;
                    return candidates.find((candidate) => !candidate.nodes || candidate.nodes.some((node) =>
                        node === hit || node.contains(hit))) ?? null;
                }
            }
            // 混合直接内容必须解析为全文遍历产出的同一个 run；这样原子适配目标旁的普通文本
            // 也不会回退成整个父容器。
            const inlineRun = this.resolveInlineRun(current, hit, evaluationContext);
            if (inlineRun?.candidate) return inlineRun.candidate;
            // “命中独立后代的包裹层”不同于“没有内联段落”。后者可以尝试普通块，
            // 前者若继续 inspect，会绕过已有屏障，把间接包裹的列表再次合成整段。
            if (inlineRun?.blocksWholeCandidate) return null;
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
                insideStructural: this.scope === 'content' &&
                    hasStructuralAncestor(rootElement, this.structuralRegionOptions()),
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
                                !isIncludedSidebarRegion(child, this.structuralRegionOptions()) &&
                                (frame.insideStructural ||
                                    isStructuralContainer(frame.element, this.structuralRegionOptions())),
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
                                !isIncludedSidebarRegion(shadowChild, this.structuralRegionOptions()) &&
                                (frame.insideStructural ||
                                    isStructuralContainer(frame.element, this.structuralRegionOptions())),
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
                            : this.splitForcedCandidate(frame.forcedCandidate, frame.ownAdapter!.decision, textProtectionCache);
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
                    if (parent && hasCandidate && !isTranslationTooltip(frame.element)) {
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
        // 一次坐标解析是同步只读阶段：每个 root 的原生命中栈只读取一次，
        // 普通正文的祖先守卫也可复用；下一次手势重新读取，避免缓存动态页面。
        const hitStacks = new Map<Document | ShadowRoot, Element[]>();
        const elementsAtPoint = (currentRoot: Document | ShadowRoot): Element[] => {
            let elements = hitStacks.get(currentRoot);
            if (!elements) {
                elements = findElementsAtPoint(currentRoot, x, y);
                hitStacks.set(currentRoot, elements);
            }
            return elements;
        };
        const resolve = this.createSynchronousResolver();
        // 编辑器是真实命中屏障：caret API 可能返回相邻辅助文本，命中栈也包含
        // 整个表单。必须先检查最上层元素，避免跳过输入框后翻译其父容器。
        const hitRoots = new Set<Document | ShadowRoot>();
        let hitRoot: Document | ShadowRoot | null = root;
        while (hitRoot && !hitRoots.has(hitRoot) && hitRoots.size <= maxPointResolutionDepth) {
            hitRoots.add(hitRoot);
            const hit: Element | undefined = elementsAtPoint(hitRoot)[0];
            if (!hit) break;
            const guard = evaluateHardGuard(hit);
            if (guard.reason === 'contenteditable' ||
                guard.reason === 'protected-tag:textarea' ||
                guard.reason === 'protected-tag:select' ||
                guard.reason === 'protected-tag:option' ||
                (guard.reason === 'protected-tag:input' && !getTranslatableControlValueAttribute(hit))) {
                return null;
            }
            hitRoot = hit.shadowRoot;
        }
        const visitedRoots = new Set<Document | ShadowRoot>();
        const resolveInRoot = (currentRoot: Document | ShadowRoot, depth: number): TranslationCandidate | null => {
            if (depth > maxPointResolutionDepth || visitedRoots.has(currentRoot)) return null;
            visitedRoots.add(currentRoot);

            const pointedNode = findNodeAtPoint(currentRoot, x, y);
            if (pointedNode) {
                const pointedCandidate = resolve(pointedNode);
                if (pointedCandidate) return this.refineHoverCandidate(pointedCandidate, currentRoot, x, y);
            }

            for (const element of elementsAtPoint(currentRoot)) {
                if (element.shadowRoot) {
                    const shadowCandidate = resolveInRoot(element.shadowRoot, depth + 1);
                    if (shadowCandidate) return shadowCandidate;
                }
                const candidate = resolve(element);
                if (candidate) return this.refineHoverCandidate(candidate, currentRoot, x, y);
            }
            return null;
        };

        return resolveInRoot(root, 0);
    }

    private refineHoverCandidate(
        candidate: TranslationCandidate,
        root: Document | ShadowRoot,
        x: number,
        y: number,
    ): TranslationCandidate {
        const visual = resolveVisualTranslationRange(candidate, root, x, y, this.shouldStayOriginal);
        return visual ? {
            ...candidate,
            visualRange: visual.range,
            visualSourceText: visual.sourceText,
            reason: 'visual-text-chunk',
        } : candidate;
    }
}
