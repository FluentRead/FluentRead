/**
 * @file src/features/full-page-translation/content/attributeMutationBatch.ts
 * 文件职责：协调一个 MutationObserver 检查点中的有状态 owner 属性复验，合并 class/style 的纯延迟排时。
 * 主要内容：按既有影响根枚举 owner，特殊 owner 和非布局属性仍即时检查硬边界；状态或骨架写入使局部根快照失效，合并边界检查意图，并在排时前复验会话、连接和 state 身份。
 * 模块边界：只维护当前回调的临时读数和排时意图；资格判断、状态读取、恢复、骨架刷新、重启、重扫和定时器均经 ports 调用，不发现候选、不读取配置、不创建持久状态，也不调用 provider。
 */
import type {TranslationState} from './state';

export interface AttributeMutationBatchPorts {
    resolveTargets(root: Element): HTMLElement[];
    readState(target: HTMLElement): TranslationState | undefined;
    restoreOutsideScope(target: HTMLElement): boolean;
    sourceIsCurrent(target: HTMLElement, state: TranslationState): boolean;
    isArtifact(node: Node): boolean;
    refreshSkeleton(target: HTMLElement, state: TranslationState): boolean;
    restart(target: HTMLElement): void;
    rescan(root: Element): void;
    schedule(target: HTMLElement, checkBoundary: boolean): void;
    isActive(): boolean;
    hasTargetsOnlyAdapter: boolean;
}

/** 每次 observer 回调新建一批；invalidate 必须与该回调的 DOM/状态写入同步调用。 */
export function createAttributeMutationBatch(ports: AttributeMutationBatchPorts) {
    let roots = new WeakMap<Element, {site: boolean; immediate: HTMLElement[]}>();
    let revision = 0;
    const deferred = new Map<HTMLElement, {state: TranslationState; checkBoundary: boolean}>();
    return {
        invalidate(): void {
            roots = new WeakMap();
            revision += 1;
        },
        process(root: Element, element: Element, mutationTarget: Node, attribute: string | null, site: boolean): void {
            const layout = attribute === 'class' || attribute === 'style';
            const cached = layout ? roots.get(root) : undefined;
            const targets = cached?.site === site ? cached.immediate : ports.resolveTargets(root);
            const startedRevision = revision;
            const immediate: HTMLElement[] = [];
            const direct = site && !layout ? new Set(ports.resolveTargets(element)) : null;
            if (targets.length > 0) {
                for (const target of targets) {
                    const state = ports.readState(target);
                    const deferBoundary = layout && Boolean(state && !state.syntheticSegment &&
                        state.allowTopLevelApplicationShell !== true);
                    if (layout && site && !deferBoundary) immediate.push(target);
                    if (site && !deferBoundary && ports.restoreOutsideScope(target)) continue;
                    if (layout) {
                        if (!state) continue;
                        const previous = deferred.get(target);
                        deferred.set(target, {state, checkBoundary:
                            (previous?.state === state && previous.checkBoundary) || (site && deferBoundary)});
                    } else {
                        const current = ports.readState(target);
                        // 非直属关系变化不能仅凭原文相同放过 focus 模式的合成 owner。
                        if (current && direct && !direct.has(target) &&
                            (!current.syntheticSegment || !ports.hasTargetsOnlyAdapter) &&
                            ports.sourceIsCurrent(target, current)) continue;
                        if (current && !ports.isArtifact(mutationTarget) &&
                            !ports.sourceIsCurrent(target, current) && ports.refreshSkeleton(target, current)) continue;
                        ports.restart(target);
                    }
                }
            } else if (cached?.site !== site) {
                // 缓存中的空列表表示延迟 owner 已合并，不能因此扩大原有扫描边界。
                ports.rescan(element);
            }
            if (layout && startedRevision === revision) roots.set(root, {site, immediate});
            if (site) ports.rescan(root);
        },
        flush(): void {
            if (ports.isActive()) {
                for (const [target, pending] of deferred) {
                    if (target.isConnected && ports.readState(target) === pending.state) {
                        ports.schedule(target, pending.checkBoundary);
                    }
                }
            }
            deferred.clear();
        },
    };
}
