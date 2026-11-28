/**
 * @file src/features/full-page-translation/content/syntheticRemount.ts
 * 文件职责：当宿主保留候选容器却以 source-only 子节点替换已物化的行内双语片段时，在同一 observer 检查点原子接回可信译文。
 * 主要内容：从当前宿主解析唯一等价 inline-run、复验文本与安全结构、迁移实时来源节点并延续原状态/熔断预算。
 * 模块边界：只处理 mutation.target 就是原候选宿主的 synthetic 换代；仅认证完整段落的自动外壳策略不能迁移为内联片段；普通 block owner 与祖先 clone 继续由 bilingualRemount 处理。
 */
import {
    collectLiveTranslationTextSlots,
    extractTranslationTextFromNodes,
    getCurrentTranslationCore,
    getTranslationCandidateKey,
    type TranslationCandidate,
    type TranslationTextProtectionOptions,
} from '@/src/core/translation/public';
import {
    consumeBilingualArtifactHostWriteBudget,
    discardTranslation,
    getTranslationOwnersForRemovedNode,
    getTranslationSourceStructureSignature,
    getTranslationState,
    isTrustedBilingualArtifactWithHostClass,
    setBilingualContent,
    setRenderedStyleAttribute,
    type TranslationState,
} from './state';
import {nodeAtPath, nodePathWithin} from './bilingualRemountMatching';

const SYNTHETIC_REMOUNT_MAX_HOST_CHILDREN = 512;
type SyntheticTranslationCandidate = TranslationCandidate & {nodes: readonly ChildNode[]};

export interface SyntheticBilingualRemountTransfer {
    owner: HTMLElement;
    previousHost: HTMLElement;
    replacementHost: HTMLElement;
}

export interface SyntheticBilingualRemountResult {
    transfers: SyntheticBilingualRemountTransfer[];
    capitulations: Array<{owner: HTMLElement; state: TranslationState; host: HTMLElement; boundary: Node}>;
}

function normalizeComparableText(text: string): string {
    return text.replace(/[\s\u3000]+/gu, ' ').trim();
}

function protectionOptions(
    owner: HTMLElement,
    allowTopLevelApplicationShell: boolean,
): TranslationTextProtectionOptions {
    return allowTopLevelApplicationShell
        ? {allowTopLevelApplicationShell: true, protectedElement: owner}
        : {protectedElement: owner};
}

function candidateStructureSignature(
    document: Document,
    nodes: readonly ChildNode[],
    state: TranslationState,
): string {
    const segment = document.createElement('span');
    nodes.forEach((node) => segment.appendChild(node.cloneNode(true)));
    const core = getCurrentTranslationCore(state.scope);
    const options = core.textOptions(protectionOptions(segment, state.allowTopLevelApplicationShell === true));
    const textNodes = collectLiveTranslationTextSlots(
        segment,
        core.shouldStayOriginal,
        segment,
        options,
    ).map((slot) => slot.node);
    return getTranslationSourceStructureSignature(
        segment,
        state.allowTopLevelApplicationShell === true,
        textNodes,
        state.scope,
    );
}

function equivalentInlineCandidate(host: HTMLElement, state: TranslationState): SyntheticTranslationCandidate | null {
    // 自动应用外壳策略目前只认证完整段落，不能把它转成没有对应策略的内联片段。
    if (state.applicationShellPolicyId) return null;
    if (host.childNodes.length > SYNTHETIC_REMOUNT_MAX_HOST_CHILDREN) return null;
    const core = getCurrentTranslationCore(state.scope);
    const candidates = new Map<Node, SyntheticTranslationCandidate>();
    Array.from(host.childNodes).forEach((node) => {
        const candidate = core.resolve(node);
        if (candidate?.element === host && candidate.kind === state.kind &&
            Boolean(candidate.allowTopLevelApplicationShell) ===
                Boolean(state.allowTopLevelApplicationShell) && candidate.nodes?.length &&
            candidate.nodes.every((source) => source.parentNode === host)) {
            candidates.set(getTranslationCandidateKey(candidate), candidate as SyntheticTranslationCandidate);
        }
    });
    const matches = Array.from(candidates.values()).filter((candidate) => {
        const options = core.textOptions(protectionOptions(host, state.allowTopLevelApplicationShell === true));
        return normalizeComparableText(extractTranslationTextFromNodes(
            candidate.nodes!,
            core.shouldStayOriginal,
            undefined,
            options,
        )) === normalizeComparableText(state.sourceText) &&
            candidateStructureSignature(host.ownerDocument, candidate.nodes!, state) ===
                state.sourceStructureSignature;
    });
    return matches.length === 1 ? matches[0]! : null;
}

function mappedReplacement(
    mutation: MutationRecord,
    removedRoot: Node,
    previousHost: HTMLElement,
    state: TranslationState,
    addedRoots: readonly Node[],
): {host: HTMLElement; candidate: SyntheticTranslationCandidate} | null {
    if (mutation.target === previousHost) {
        const candidate = equivalentInlineCandidate(previousHost, state);
        return candidate ? {host: previousHost, candidate} : null;
    }
    const path = nodePathWithin(removedRoot, previousHost);
    if (!path) return null;
    const mapAddedRoot = (addedRoot: Node) => {
        const node = nodeAtPath(addedRoot, path);
        if (node?.nodeType !== 1) return null;
        const host = node as HTMLElement;
        if (!host.isConnected || host.localName !== previousHost.localName ||
            host.namespaceURI !== previousHost.namespaceURI) return null;
        const candidate = equivalentInlineCandidate(host, state);
        return candidate ? {host, candidate} : null;
    };
    const removedIndex = Array.from(mutation.removedNodes).indexOf(removedRoot as ChildNode);
    if (mutation.addedNodes.length === mutation.removedNodes.length && removedIndex >= 0) {
        const positional = mapAddedRoot(Array.from(mutation.addedNodes)[removedIndex]!);
        if (positional) return positional;
    }
    const matches = addedRoots.flatMap((addedRoot) => {
        const match = mapAddedRoot(addedRoot);
        return match ? [match] : [];
    });
    return matches.length === 1 ? matches[0]! : null;
}

export function transferEquivalentSyntheticBilingualSegments(
    mutations: readonly MutationRecord[],
    reconcileLayout: (owner: HTMLElement) => boolean,
    resolveRemovedOwners: (removed: Node) => readonly HTMLElement[] =
        getTranslationOwnersForRemovedNode,
): SyntheticBilingualRemountResult {
    const transfers: SyntheticBilingualRemountTransfer[] = [];
    const capitulations: SyntheticBilingualRemountResult['capitulations'] = [];
    const consumed = new Set<HTMLElement>();
    const addedByBoundary = new Map<Node, Node[]>();
    mutations.filter((mutation) => mutation.type === 'childList').forEach((mutation) => {
        const added = addedByBoundary.get(mutation.target) ?? [];
        added.push(...Array.from(mutation.addedNodes));
        addedByBoundary.set(mutation.target, added);
    });
    mutations.forEach((mutation) => {
        if (mutation.type !== 'childList' || ![1, 9, 11].includes(mutation.target.nodeType) ||
            !mutation.target.isConnected) return;
        Array.from(mutation.removedNodes).forEach((removed) => {
            resolveRemovedOwners(removed).forEach((owner) => {
                const state = getTranslationState(owner);
                const previousHost = state?.syntheticHost;
                if (consumed.has(owner) || owner.isConnected || !state || !previousHost ||
                    !state.syntheticSegment || state.phase !== 'translated' || state.mode !== 'bilingual' ||
                    state.kind !== 'content' || state.sourceStructureDirty) return;
                const content = state.bilingualContent;
                const template = state.bilingualContentTemplate;
                const replacement = mappedReplacement(
                    mutation,
                    removed,
                    previousHost,
                    state,
                    addedByBoundary.get(mutation.target)!,
                );
                if (!content || content.parentNode !== owner || !template ||
                    !isTrustedBilingualArtifactWithHostClass(content, state) ||
                    !replacement) return;
                const {host, candidate: {nodes: sourceNodes}} = replacement;
                consumed.add(owner);
                if (!consumeBilingualArtifactHostWriteBudget(owner, state)) {
                    state.syntheticHost = host;
                    state.syntheticSourceNodes = [...sourceNodes];
                    const boundary = host.parentNode;
                    if (boundary) capitulations.push({owner, state, host, boundary});
                    discardTranslation(owner, state);
                    return;
                }

                Array.from(owner.childNodes).filter((node) => node !== content).forEach((node) => node.remove());
                host.insertBefore(owner, sourceNodes[0]!);
                sourceNodes.forEach((node) => owner.insertBefore(node, state.bilingualBeforeSource ? null : content));
                state.syntheticHost = host;
                const core = getCurrentTranslationCore(state.scope);
                state.sourceTextNodes = collectLiveTranslationTextSlots(
                    owner,
                    core.shouldStayOriginal,
                    owner,
                    core.textOptions(protectionOptions(owner, state.allowTopLevelApplicationShell === true)),
                ).map((slot) => slot.node);
                setBilingualContent(owner, content, state.bilingualReplay, template);
                setRenderedStyleAttribute(owner);
                if (!reconcileLayout(owner)) {
                    discardTranslation(owner, state);
                    return;
                }
                transfers.push({owner, previousHost, replacementHost: host});
            });
        });
    });
    return {transfers, capitulations};
}
