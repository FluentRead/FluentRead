/**
 * @file src/features/full-page-translation/content/mutationObservation.ts
 * 文件职责：为全文翻译组合 DOM 观察选项，并计算突发变化的扫描边界、安全节点目标和本片就绪扫描根。
 * 主要内容：按既有 matches/tagName/style 契约识别元素，保留 ShadowRoot 的宿主观察目标并按宿主连接性释放失效根；保留通用保护、话题标签 rel、按钮标签及资格、产物完整性属性，合并网站依赖；复杂选择器取消属性过滤，校验合成段身份标记，按断言批量判定增删节点，按检查点去重同节点同属性的变化，并按树包含关系合并扫描根。
 * 模块边界：仅生成选项、读取传入节点的树关系并按注入时钟消费根队列，不创建观察器或计时器、不读取全局 DOM、配置或页面会话；标记核验只接收最小状态，不反向依赖翻译状态实现。
 */
import {getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

export function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === "function");
}
export function asHTMLElement(node: unknown): HTMLElement | null {
    if (!node || typeof node !== "object" || (node as Node).nodeType !== 1) return null;
    const element = node as HTMLElement;
    return typeof element.tagName === "string" && typeof element.style === "object" ? element : null;
}

export function mutationTargetElement(node: Node): Element | null {
    if (isElementNode(node)) return node;
    if (node.nodeType === 11) {
        const host = (node as ShadowRoot).host;
        if (isElementNode(host)) return host;
    }
    return node.parentElement;
}

/** ShadowRoot 的观察生命周期跟随宿主；普通 Fragment 不作为活页面的发现入口。 */
export function isConnectedMutationRoot(node: Node): boolean {
    return node.nodeType === 11 && 'host' in node
        ? (node as ShadowRoot).host.isConnected
        : node.isConnected;
}

interface MutationRescanRoots {
    dirtyRoots: Set<Node>;
    broadRescanRoots: WeakSet<Node>;
    broadRescanCooldowns: WeakMap<Node, number>;
}

/**
 * 一个时间片只检查初始排队根一次，冷却根轮转到末尾，断连根直接释放。
 * 根选择也使用八毫秒预算；推进过发现后可能同步出现新根，因此下一片先复查，
 * 只有纯冷却检查片才按最早到期时刻等待。调用方负责真正的扫描和计时器。
 */
export function createMutationRescanSelector(
    queue: MutationRescanRoots,
    now: () => number,
    discoveryInProgress: boolean,
) {
    const startedAt = now();
    let rootsToCheck = queue.dirtyRoots.size;
    let earliestRescan = Infinity;
    let discoveredInSlice = discoveryInProgress;
    const shouldYield = () => now() - startedAt >= 8;
    return {
        shouldYield,
        take(): Node | null {
            while (rootsToCheck > 0) {
                const root = queue.dirtyRoots.values().next().value as Node | undefined;
                if (!root) { rootsToCheck = 0; break; }
                queue.dirtyRoots.delete(root);
                rootsToCheck -= 1;
                if (isConnectedMutationRoot(root)) {
                    const notBefore = queue.broadRescanRoots.has(root)
                        ? queue.broadRescanCooldowns.get(root) ?? 0 : 0;
                    if (now() >= notBefore) {
                        discoveredInSlice = true;
                        return root;
                    }
                    queue.dirtyRoots.add(root);
                    earliestRescan = Math.min(earliestRescan, notBefore);
                }
                if (shouldYield()) break;
            }
            return null;
        },
        delay: () => !discoveredInSlice && rootsToCheck === 0 && earliestRescan !== Infinity
            ? Math.max(16, earliestRescan - now()) : 16,
    };
}

/** 同一 observer 检查点只能读取最终 DOM；自有写入过滤后再标记，不吞掉后续真实宿主变化。 */
export function createTranslationAttributeMutationFilter(): (element: Element, attribute: string) => boolean {
    const checked = new WeakMap<Element, Set<string>>();
    return (element, attribute) => {
        let attributes = checked.get(element);
        if (attributes?.has(attribute)) return false;
        if (!attributes) {
            attributes = new Set();
            checked.set(element, attributes);
        }
        attributes.add(attribute);
        return true;
    };
}

export function createTranslationMutationObserverOptions(adapters: readonly TranslationSiteAdapter[]): MutationObserverInit {
    const attributeFilter = getSiteAdapterAttributeFilter(adapters, [
        'style', 'class', 'role', 'open', 'aria-modal', 'hidden', 'inert', 'contenteditable', 'aria-hidden', 'translate',
        'lang', 'dir', 'href', 'rel', 'title', 'value', 'type', 'name', 'data-notranslate', 'data-fr-translation-owned',
    ]);
    return {
        childList: true, subtree: true, characterData: true, characterDataOldValue: true,
        attributes: true, attributeOldValue: true,
        ...(attributeFilter === null ? {} : {attributeFilter}),
    };
}

/**
 * 全属性站点也会观察到本代合成段的身份标记。只承认真实 owner 的首次写入，
 * 并复验宿主与来源槽；普通页面节点伪造同名属性仍进入宿主 mutation 路径。
 * 来源校验由调用方延迟提供，避免为无关属性遍历正文。
 */
export function isOwnSyntheticSegmentMarkerMutation(
    mutation: MutationRecord,
    target: HTMLElement,
    state: {syntheticSegment: boolean; syntheticHost?: HTMLElement},
    sourceIsCurrent: () => boolean,
): boolean {
    return mutation.type === 'attributes' && mutation.attributeName === 'data-fr-translation-segment' &&
        mutation.target === target && mutation.oldValue === null && state.syntheticSegment &&
        state.syntheticHost === target.parentElement && target.getAttribute('data-fr-translation-segment') === 'true' &&
        sourceIsCurrent();
}

/**
 * 判断一次 childList 变更的增删节点是否全部满足断言，且至少有一个节点。
 * mutation 风暴下每条记录都会走到这里，因此不为两份 NodeList 构造中间数组。
 */
export function allMutationNodesMatch(
    mutation: MutationRecord,
    predicate: (node: Node) => boolean,
): boolean {
    let seen = 0;
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
        for (const node of list) {
            seen += 1;
            if (!predicate(node)) return false;
        }
    }
    return seen > 0;
}

/** 脏根合并以真实树包含关系为准，异常或缺失 contains 时不吞掉待扫描根。 */
export function mutationRootContains(ancestor: Node, descendant: Node): boolean {
    if (ancestor === descendant) return true;
    try { return typeof ancestor.contains === 'function' && ancestor.contains(descendant); }
    catch { return false; }
}

/** 突发变更只能扩展到所属 document 或 ShadowRoot，不能丢失另一棵树。 */
export function collapseMutationRescanRoot(node: Node): Node {
    const root = node.getRootNode();
    return root.nodeType === 9 ? (root as Document).documentElement : root;
}
