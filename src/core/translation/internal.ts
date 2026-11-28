/**
 * @file src/core/translation/internal.ts
 *
 * 文件职责：保存候选引擎内部可独立测试的缓存继承与适配裁剪祖先查找算法。
 * 主要内容：定义 AncestorAdapterDecision 与 AdapterPrunedAncestorResult 内部结构，提供 inheritCachedFlag 和 findAdapterPrunedAncestor，降低 engine 的祖先遍历复杂度。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

/** 站点适配器对祖先节点给出的最小决策形状。 */
export interface AncestorAdapterDecision {
    decision: {
        kind: string;
        reason?: string;
    };
    adapterId?: string;
}

export interface AdapterPrunedAncestorResult<T> {
    result: {reason: string; adapterId?: string} | null;
    inspected: T[];
}

/** 从祖先缓存继承布尔标记；null 表示已经到达当前 DOM 树边界。 */
export function inheritCachedFlag<T extends object>(
    current: T | null,
    flags: WeakMap<T, boolean>,
): boolean {
    if (current === null) return false;
    return flags.get(current) === true;
}

/**
 * 在有界祖先链中查找站点适配器的 prune 决策。
 *
 * 该函数是 engine 的内部纯算法边界：公开解析入口通常会先被 DOM hard guard
 * 截断，但这里仍保留独立深度上限，防止未来调用顺序调整后出现无界祖先遍历。
 */
export function findAdapterPrunedAncestor<T>(
    ancestors: Iterable<T>,
    maximumDepth: number,
    decide: (ancestor: T) => AncestorAdapterDecision,
): AdapterPrunedAncestorResult<T> {
    const inspected: T[] = [];
    let depth = 0;

    for (const ancestor of ancestors) {
        depth += 1;
        if (depth > maximumDepth) {
            return {result: {reason: 'ancestor-depth-limit'}, inspected};
        }

        inspected.push(ancestor);
        const {decision, adapterId} = decide(ancestor);
        if (decision.kind === 'prune-subtree') {
            return {
                result: {reason: decision.reason || 'adapter-pruned', adapterId},
                inspected,
            };
        }
    }

    return {result: null, inspected};
}
