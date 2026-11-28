/**
 * @file src/core/translation/engineAncestry.ts
 *
 * 文件职责：封装翻译候选解析的同步评估上下文、排除选择器缓存与祖先链守卫预处理逻辑，避免引擎主体重复上溯 DOM 树。
 * 主要内容：提供 getCombinedExcludedSelector、createResolutionEvaluationContext、primeResolutionAncestry、isExtensionElementForResolution 与 isStructuralContainerForResolution 等无状态辅助函数与上下文类型。
 * 模块边界：仅服务于 src/core/translation/engine.ts 的同步只读解析阶段，不持有跨手势全局状态，也不修改 DOM 或触发网络请求。
 */

import {
    evaluateElementHardGuard,
    getComposedParent,
    isDocumentSurface,
    isExtensionElementSelf,
    isTopLevelApplicationShell,
    maxComposedAncestorDepth,
} from './dom';
import type {HardGuardResult, TranslationTextProtectionOptions} from './dom';
import {
    isIncludedSidebarRegion,
    isStructuralContainer,
    type StructuralRegionOptions,
} from './layout';
import {createTranslationTextProtectionCache} from './text';
import type {TranslationTextProtectionCache} from './text';
import type {
    AdapterContext,
    AdapterDecision,
    TranslationCandidate,
    TranslationScope,
} from './types';
import {inheritCachedFlag} from './internal';

const combinedExcludedSelectorsByDocument = new WeakMap<Document, Map<string, string | null>>();

export function getCombinedExcludedSelector(element: Element, selectors: readonly string[]): string | null {
    const document = element.ownerDocument;
    if (!document) return null;
    const cacheKey = selectors.join('\u0000');
    let documentCache = combinedExcludedSelectorsByDocument.get(document);
    if (!documentCache) {
        documentCache = new Map();
        combinedExcludedSelectorsByDocument.set(document, documentCache);
    }
    if (documentCache.has(cacheKey)) return documentCache.get(cacheKey) ?? null;

    const probe = document.createElement('div');
    const valid = selectors.filter((selector) => {
        try {
            probe.matches(selector);
            return true;
        } catch {
            return false;
        }
    });
    const combined = valid.length > 0 ? valid.join(',') : null;
    documentCache.set(cacheKey, combined);
    return combined;
}

export interface AdapterDecisionResult {
    decision: AdapterDecision;
    adapterId?: string;
}

export interface InlineRunResolution {
    candidate: TranslationCandidate | null;
    /** 已有独立后代或探测预算耗尽时，不能再把当前容器整体当作回退候选。 */
    blocksWholeCandidate: boolean;
}

export interface InlineRunSummary {
    candidates: TranslationCandidate[];
    blocksWholeCandidate: boolean;
}

export interface AdapterPrunedAncestor {
    reason: string;
    adapterId?: string;
}

/** 仅在一次同步悬浮或检查调用内有效的缓存集合。 */
export interface ResolutionEvaluationContext {
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

export function createResolutionEvaluationContext(
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

export function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === 'function');
}

export function asHTMLElement(element: Element | null | undefined): HTMLElement | null {
    if (!element || element.nodeType !== 1) return null;
    return element as HTMLElement;
}

export function currentURL(): URL {
    const href = globalThis.location?.href ?? 'https://invalid.local/';
    try {
        return new URL(href);
    } catch {
        return new URL('https://invalid.local/');
    }
}

function evaluateResolutionElementHardGuard(
    element: Element,
    evaluationContext: ResolutionEvaluationContext,
): HardGuardResult {
    const guard = evaluateElementHardGuard(element, evaluationContext.textProtectionOptions);
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

export function isStructuralContainerForResolution(
    element: Element,
    evaluationContext: ResolutionEvaluationContext,
    scope: TranslationScope,
    structuralRegionOptions?: StructuralRegionOptions,
): boolean {
    if (scope === 'all') return false;
    const cached = evaluationContext.structuralContainers.get(element);
    if (cached !== undefined) return cached;
    const result = isStructuralContainer(element, structuralRegionOptions);
    evaluationContext.structuralContainers.set(element, result);
    return result;
}

export function primeResolutionAncestry(
    element: Element,
    evaluationContext: ResolutionEvaluationContext,
    scope: TranslationScope,
    structuralRegionOptions?: StructuralRegionOptions,
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
        evaluationContext.hardGuards.get(item) ?? evaluateResolutionElementHardGuard(item, evaluationContext));
    let inheritedGuard: HardGuardResult = {prune: false};
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const item = chain[index]!;
        const ownGuard = ownGuards[index]!;
        inheritedGuard = ownGuard.prune ? ownGuard : inheritedGuard;
        evaluationContext.hardGuards.set(item, inheritedGuard);

        // 全部节点范围不使用正文结构祖先；完整硬守卫仍由上方祖先链评估。
        const parent = scope === 'all' ? null : getComposedParent(item);
        const hasStructuralAncestor = Boolean(parent && !isDocumentSurface(parent) && (
            !isIncludedSidebarRegion(item, structuralRegionOptions) &&
            !isIncludedSidebarRegion(parent, structuralRegionOptions) &&
            (isStructuralContainerForResolution(parent, evaluationContext, scope, structuralRegionOptions) ||
                evaluationContext.structuralAncestors.get(parent) === true)
        ));
        evaluationContext.structuralAncestors.set(item, hasStructuralAncestor);
    }
}

export function isExtensionElementForResolution(
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
