/**
 * @file src/core/translation/engineDiscovery.ts
 *
 * 文件职责：封装增量后序发现帧构建、扫描根提升以及坐标命中屏障与递归查找算法，降低 TranslationCandidateCore 主体复杂度。
 * 主要内容：定义 DiscoveryFrame 结构与 createDiscoveryFrame 工厂，实现脏子树根提升 resolveDiscoveryRoots，以及带编辑器命中屏障和深度上限的 resolveCandidateAtPoint。
 * 模块边界：仅依赖同级 core/translation 纯 DOM 判定模块，通过回调与 engine.ts 协作，不持有持久缓存或操作页面状态。
 */

import {
    evaluateHardGuard,
    findElementsAtPoint,
    findNodeAtPoint,
    getTranslatableControlValueAttribute,
    isDocumentSurface,
} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {findTranslationControlOwner} from './layout';
import {isTranslationTextElementProtected} from './text';
import type {TranslationTextProtectionCache} from './text';
import type {TranslationCandidate, TranslationScope} from './types';
import {
    type AdapterDecisionResult,
    type AdapterPrunedAncestor,
    isElementNode,
} from './engineAncestry';

/**
 * Shadow DOM 的坐标命中 API 属于宿主页面实现，异常组件可能把同一个 host
 * 再次返回给嵌套 root。坐标解析必须有独立于祖先扫描的深度上限，避免递归耗尽
 * content script 的调用栈并让页面看起来失去响应。
 */
const maxPointResolutionDepth = 64;

export interface DiscoveryFrame {
    element: Element;
    phase: 'enter' | 'children' | 'exit';
    lightIndex: number;
    shadowIndex: number;
    shadowRoot: ShadowRoot | null;
    descendantHasCandidate: boolean;
    candidateChildBarriers: Set<Element>;
    ownAdapter?: AdapterDecisionResult;
    forcedCandidate?: TranslationCandidate;
    forcedAtomic?: boolean;
    exitCandidates?: TranslationCandidate[];
    exitIndex: number;
    checkAncestors: boolean;
    insideStructural: boolean;
    pruned: boolean;
}

export function createDiscoveryFrame(
    element: Element,
    checkAncestors: boolean,
    insideStructural: boolean,
): DiscoveryFrame {
    return {
        element,
        phase: 'enter',
        lightIndex: 0,
        shadowIndex: 0,
        shadowRoot: null,
        descendantHasCandidate: false,
        candidateChildBarriers: new Set(),
        exitIndex: 0,
        checkAncestors,
        insideStructural,
        pruned: false,
    };
}

export interface DiscoveryRootResolutionDeps {
    scope: TranslationScope;
    hasAdapters: boolean;
    textOptions: () => TranslationTextProtectionOptions | undefined;
    shouldStayOriginal: (element: Element) => boolean;
    adapterDecision: (element: Element) => AdapterDecisionResult;
    hasAdapterPrunedAncestor: (element: Element) => AdapterPrunedAncestor | null;
}

export function resolveDiscoveryRoots(
    root: Node,
    promoteExplicitOwner: boolean,
    textProtectionCache: TranslationTextProtectionCache,
    deps: DiscoveryRootResolutionDeps,
): {roots: Element[]; initialAdapter?: AdapterDecisionResult} {
    const roots: Element[] = [];
    let initialAdapter: AdapterDecisionResult | undefined;
    if (isElementNode(root)) {
        // 动态控件可能先只有图标，再把文字写入内层 flex 标签。该标签本身不再是
        // 正文候选，因此局部重扫应回到同一控件边界；被明确保护的脏子树不能提升。
        const controlOwner = findTranslationControlOwner(root);
        let scanRoot = controlOwner && controlOwner !== root &&
            !evaluateHardGuard(root, deps.textOptions()).prune && !deps.hasAdapterPrunedAncestor(root)
            ? controlOwner : root;
        if (promoteExplicitOwner && scanRoot === root && !controlOwner && deps.scope === 'content' && deps.hasAdapters) {
            initialAdapter = deps.adapterDecision(root);
            if (initialAdapter.decision.kind === 'pass' &&
                !evaluateHardGuard(root, deps.textOptions()).prune && !deps.hasAdapterPrunedAncestor(root) &&
                !isTranslationTextElementProtected(root, deps.shouldStayOriginal, textProtectionCache, deps.textOptions())) {
                // 硬守卫已验证整条 composed 祖先链不超过预算。这里只走 light DOM，
                // 不跨 ShadowRoot；遇到最近显式决策即停止，不越过原子目标或重定向。
                // 仅入口提升扫描根，完整遍历的子 frame 仍以自身决定边界和首段 run。
                let ancestor = root.parentElement;
                while (ancestor && !isDocumentSurface(ancestor)) {
                    const ownAdapter = deps.adapterDecision(ancestor);
                    const decision = ownAdapter.decision;
                    if (decision.kind !== 'pass') {
                        if (decision.kind === 'force-target' && decision.atomic === false &&
                            (decision.target ?? ancestor) === ancestor) {
                            scanRoot = ancestor;
                            initialAdapter = ownAdapter;
                        }
                        break;
                    }
                    ancestor = ancestor.parentElement;
                }
            }
        }
        roots.push(scanRoot);
    } else if ('children' in root) {
        const children = (root as Document | ShadowRoot).children;
        for (let index = 0; index < children.length; index += 1) {
            const child = children.item(index);
            if (child) roots.push(child);
        }
    }
    return {roots, initialAdapter};
}

export function resolveCandidateAtPoint(
    root: Document | ShadowRoot,
    x: number,
    y: number,
    textOptions: TranslationTextProtectionOptions | undefined,
    resolve: (start: Node | null | undefined) => TranslationCandidate | null,
    refineHoverCandidate: (candidate: TranslationCandidate, currentRoot: Document | ShadowRoot, x: number, y: number) => TranslationCandidate,
): TranslationCandidate | null {
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
    // 编辑器是真实命中屏障：caret API 可能返回相邻辅助文本，命中栈也包含
    // 整个表单。必须先检查最上层元素，避免跳过输入框后翻译其父容器。
    const hitRoots = new Set<Document | ShadowRoot>();
    let hitRoot: Document | ShadowRoot | null = root;
    while (hitRoot && !hitRoots.has(hitRoot) && hitRoots.size <= maxPointResolutionDepth) {
        hitRoots.add(hitRoot);
        const hit: Element | undefined = elementsAtPoint(hitRoot)[0];
        if (!hit) break;
        const guard = evaluateHardGuard(hit, textOptions);
        if (guard.reason === 'contenteditable' ||
            guard.reason === 'excluded-tag' ||
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
            if (pointedCandidate) return refineHoverCandidate(pointedCandidate, currentRoot, x, y);
        }

        for (const element of elementsAtPoint(currentRoot)) {
            if (element.shadowRoot) {
                const shadowCandidate = resolveInRoot(element.shadowRoot, depth + 1);
                if (shadowCandidate) return shadowCandidate;
            }
            const candidate = resolve(element);
            if (candidate) return refineHoverCandidate(candidate, currentRoot, x, y);
        }
        return null;
    };

    return resolveInRoot(root, 0);
}
