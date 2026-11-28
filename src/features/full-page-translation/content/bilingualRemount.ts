/**
 * @file src/features/full-page-translation/content/bilingualRemount.ts
 * 文件职责：在 React/Vue 等宿主框架等价重挂双语 owner 时，于同一 MutationObserver 检查点原子接管已提交译文。
 * 主要内容：按 childList 路径与结构索引配对新旧 owner，一次建立兄弟节点位置索引以线性核对行内片段，按正文/全部节点范围隔离熔断身份并校验原文/译文快照与直属工件，在同步布局映射阶段共享旧父节点位置索引，先读取候选再按已提交的原文前后位置统一挂载，最后核对布局，避免逐段交错读写触发全页重排；重建 WeakMap 状态并安全转移布局租约。
 * 模块边界：本文件不发起翻译请求、不发现候选也不持有页面会话；同步准备批次复验 owner、自动应用外壳许可和语义来源，移交状态保留策略来源，runtime 提供会话索引收尾。
 */
import {asHTMLElement, matchBilingualRemountOwners, nodeAtPath, nodePathWithin} from './bilingualRemountMatching';
import {disableBilingualRenderingContainment} from './renderingContainment';
import {
    beginTranslation,
    consumeBilingualArtifactHostWriteBudget,
    discardTranslation,
    getTranslationSourceStructureSignature,
    getTranslationOverflowGenerationIdentity,
    getTranslationOwnersForRemovedNode,
    getTranslationState,
    inlineCodeReplaySourceIsCurrent,
    isTranslationApplicationShellPolicyCurrent,
    hasBilingualArtifactHostWriteBudget,
    inheritBilingualArtifactRepairBudget,
    isBilingualArtifactHostWriteBudgetCapitulated,
    isTrustedBilingualArtifactWithHostClass,
    isTranslationSourceStructureOverflow,
    markTranslationComplete,
    restoreClonedTranslationOwnerPresentation,
    setBilingualContent,
    setRenderedStyleAttribute,
    tryRepairBilingualTranslationArtifact,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';
import {
    isBilingualArtifactKept,
    statefulSourceAndTextSlotsAreCurrent,
    createCurrentTranslationStateSourceSnapshotBatch,
    normalizeComparableText,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    collectLiveTranslationTextSlots,
    createCurrentTranslationResolverBatch,
    getCurrentTranslationCore,
    type TranslationScope,
} from '@/src/core/translation/public';

import {createTranslationTruncationLayoutBatch} from './layout';

const BILINGUAL_ARTIFACT_SELECTOR =
    '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';

export interface BilingualRemountPreparation {
    sourceTextNodes: readonly Text[];
    reconcileLayout: (owner: HTMLElement) => boolean;
}

/** 同一同步重挂批次先复验 owner 和精确来源，布局读数仅在该批次的提交阶段复用。 */
export function createBilingualRemountPreparationBatch(): (
    previousOwner: HTMLElement, replacementOwner: HTMLElement, state: TranslationState,
) => BilingualRemountPreparation | null {
    const reconcileRemountLayout = createTranslationTruncationLayoutBatch();
    const resolveRemountCandidate = createCurrentTranslationResolverBatch();
    const readRemountSource = createCurrentTranslationStateSourceSnapshotBatch();
    return (_previousOwner, replacementOwner, state) => {
        if (!isTranslationApplicationShellPolicyCurrent(replacementOwner, state)) return null;
        const candidate = resolveRemountCandidate(replacementOwner, state.scope);
        if (!candidate || candidate.element !== replacementOwner || candidate.kind !== state.kind ||
            Boolean(candidate.allowTopLevelApplicationShell) !== Boolean(state.allowTopLevelApplicationShell)) return null;
        const source = readRemountSource(replacementOwner, state);
        if (normalizeComparableText(source.sourceText) !== normalizeComparableText(state.sourceText)) return null;
        return {sourceTextNodes: source.sourceTextNodes, reconcileLayout: reconcileRemountLayout};
    };
}

export interface BilingualOwnerTransfer {
    previousOwner: HTMLElement;
    replacementOwner: HTMLElement;
}

export interface BilingualOwnerCapitulation extends BilingualOwnerTransfer {
    boundary: Node;
}

export interface BilingualRemountResult {
    transfers: BilingualOwnerTransfer[];
    capitulations: BilingualOwnerCapitulation[];
}

export type RemovedTranslationOwnerResolver = (removed: Node) => readonly HTMLElement[];

export function createRemovedTranslationOwnerResolver(): RemovedTranslationOwnerResolver {
    const cache = new WeakMap<Node, readonly HTMLElement[]>();
    return (removed) => {
        const cached = cache.get(removed);
        if (cached) return cached;
        const owners = getTranslationOwnersForRemovedNode(removed);
        cache.set(removed, owners);
        return owners;
    };
}

export interface BilingualRemountCapitulationRegistry {
    hasEntries: () => boolean;
    remember: (boundary: Node, owner: HTMLElement, state: TranslationState) => void;
    blocks: (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope?: TranslationScope,
    ) => boolean;
    forget: (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope?: TranslationScope,
    ) => void;
}

function syntheticRunIndexes(
    host: HTMLElement,
    sourceNodes: readonly Node[],
    segment?: HTMLElement,
): number[] | null {
    if (sourceNodes.length === 0) return null;
    if (segment?.parentNode === host && sourceNodes.every((node) => node.parentNode === segment)) {
        const start = Array.from(host.childNodes).indexOf(segment);
        return start < 0 ? null : sourceNodes.map((_node, index) => start + index);
    }
    if (!sourceNodes.every((node) => node.parentNode === host)) return null;
    const positions = new Map(Array.from(host.childNodes, (node, index) => [node, index] as const));
    const indexes = sourceNodes.map((node) => positions.get(node as ChildNode) ?? -1);
    return indexes.some((index) => index < 0) ? null : indexes;
}

function syntheticCandidateStructureSignature(
    owner: HTMLElement,
    nodes: readonly Node[],
    allowTopLevelApplicationShell: boolean,
    scope?: TranslationScope,
): string | null {
    const indexes = syntheticRunIndexes(owner, nodes);
    if (!indexes) return null;
    const segment = owner.ownerDocument.createElement('span');
    nodes.forEach((node) => segment.appendChild(node.cloneNode(true)));
    const core = getCurrentTranslationCore(scope);
    const protectionOptions = core.textOptions(allowTopLevelApplicationShell
        ? {allowTopLevelApplicationShell: true, protectedElement: segment}
        : {protectedElement: segment});
    const textNodes = collectLiveTranslationTextSlots(
        segment,
        core.shouldStayOriginal,
        segment,
        protectionOptions,
    ).map((slot) => slot.node);
    return JSON.stringify(['synthetic-run', indexes, getTranslationSourceStructureSignature(
        segment,
        allowTopLevelApplicationShell,
        textNodes,
        scope,
    )]);
}

function capitulationKey(
    owner: HTMLElement,
    path: readonly number[],
    sourceText: string,
    sourceStructureSignature: string,
    translationInvocationIdentity: string | undefined,
    overflowGenerationIdentity?: string,
    scope?: TranslationScope,
): string {
    return JSON.stringify([
        owner.namespaceURI,
        owner.localName,
        path,
        sourceText.replace(/[\s\u3000]+/gu, ' ').trim(),
        isTranslationSourceStructureOverflow(sourceStructureSignature)
            ? [sourceStructureSignature, overflowGenerationIdentity]
            : sourceStructureSignature,
        translationInvocationIdentity ?? '',
        scope ?? 'content',
    ]);
}

/** 以稳定 mutation 边界而不是短命 owner 作为熔断所有者，使后续同源换代也保持降级。 */
export function createBilingualRemountCapitulationRegistry(): BilingualRemountCapitulationRegistry {
    const blockedByBoundary = new WeakMap<Node, Set<string>>();
    let blockedEntries = 0;
    const visitBoundaryKeys = (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope: TranslationScope | undefined,
        visit: (boundary: Node, key: string) => boolean,
    ): boolean => {
        const path: number[] = [];
        const overflowGenerationIdentity = isTranslationSourceStructureOverflow(sourceStructureSignature)
            ? getTranslationOverflowGenerationIdentity(owner)
            : undefined;
        let current: Node = owner;
        let boundary: Node | null = owner.parentNode;
        let depth = 0;
        while (boundary && depth < 128) {
            const index = Array.from(boundary.childNodes).indexOf(current as ChildNode);
            path.unshift(index);
            const key = capitulationKey(
                owner,
                path,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                overflowGenerationIdentity,
                scope,
            );
            if (visit(boundary, key)) return true;
            current = boundary;
            boundary = boundary.parentNode;
            depth += 1;
        }
        return false;
    };
    return {
        hasEntries: () => blockedEntries > 0,
        remember(boundary, owner, state) {
            if (!state.sourceStructureSignature) return;
            let identityOwner = owner;
            let sourceStructureSignature = state.sourceStructureSignature;
            if (state.syntheticSegment) {
                const host = state.syntheticHost ?? owner.parentElement ?? undefined;
                const sourceNodes = state.syntheticSourceNodes ?? [];
                const indexes = host ? syntheticRunIndexes(host, sourceNodes, owner) : null;
                if (!host || !indexes) return;
                identityOwner = host;
                sourceStructureSignature = JSON.stringify([
                    'synthetic-run', indexes, state.sourceStructureSignature,
                ]);
            }
            const storageBoundary = boundary === identityOwner && identityOwner.parentNode
                ? identityOwner.parentNode : boundary;
            const path = nodePathWithin(storageBoundary, identityOwner);
            if (!path) return;
            let blocked = blockedByBoundary.get(storageBoundary);
            if (!blocked) {
                blocked = new Set<string>();
                blockedByBoundary.set(storageBoundary, blocked);
            }
            const key = capitulationKey(
                identityOwner,
                path,
                state.sourceText,
                sourceStructureSignature,
                state.translationInvocationIdentity,
                state.sourceOverflowGenerationIdentity,
                state.scope,
            );
            if (!blocked.has(key)) {
                blocked.add(key);
                blockedEntries += 1;
            }
        },
        blocks(owner, sourceText, sourceStructureSignature, translationInvocationIdentity, scope) {
            if (blockedEntries === 0) return false;
            return visitBoundaryKeys(
                owner,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                scope,
                (boundary, key) => blockedByBoundary.get(boundary)?.has(key) === true,
            );
        },
        forget(owner, sourceText, sourceStructureSignature, translationInvocationIdentity, scope) {
            if (blockedEntries === 0) return;
            visitBoundaryKeys(
                owner,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                scope,
                (boundary, key) => {
                    const blocked = blockedByBoundary.get(boundary);
                    if (!blocked?.delete(key)) return false;
                    blockedEntries -= 1;
                    if (blocked.size === 0) blockedByBoundary.delete(boundary);
                    return false;
                },
            );
        },
    };
}

export function blocksBilingualRemountCandidate(
    registry: BilingualRemountCapitulationRegistry,
    owner: HTMLElement,
    sourceText: string,
    allowTopLevelApplicationShell: boolean,
    translationInvocationIdentity: string | undefined,
    sourceNodes?: readonly Node[],
    scope?: TranslationScope,
): boolean {
    const registryHasEntries = registry.hasEntries();
    if (!registryHasEntries && !hasBilingualArtifactHostWriteBudget(owner)) return false;
    const sourceStructureSignature = sourceNodes?.length
        ? syntheticCandidateStructureSignature(owner, sourceNodes, allowTopLevelApplicationShell, scope)
        : getTranslationSourceStructureSignature(owner, allowTopLevelApplicationShell, undefined, scope);
    if (!sourceStructureSignature) return false;
    return isBilingualArtifactHostWriteBudgetCapitulated(
        owner,
        sourceText,
        sourceStructureSignature,
        translationInvocationIdentity,
        scope,
    ) || registryHasEntries && registry.blocks(
        owner,
        sourceText,
        sourceStructureSignature,
        translationInvocationIdentity,
        scope,
    );
}

export function forgetBilingualRemountCandidate(
    registry: BilingualRemountCapitulationRegistry,
    owner: HTMLElement,
    sourceText: string,
    allowTopLevelApplicationShell: boolean,
    translationInvocationIdentity: string | undefined,
    sourceNodes?: readonly Node[],
    scope?: TranslationScope,
): void {
    if (!registry.hasEntries()) return;
    registry.forget(
        owner,
        sourceText,
        sourceNodes?.length
            ? syntheticCandidateStructureSignature(owner, sourceNodes, allowTopLevelApplicationShell, scope) ?? ''
            : getTranslationSourceStructureSignature(owner, allowTopLevelApplicationShell, undefined, scope),
        translationInvocationIdentity,
        scope,
    );
}

export type BilingualArtifactDisposition = 'current' | 'retry' | 'capitulated';

/** 统一判定一次双语工件拒绝，确保重挂、重建与熔断只消费一格共享预算。 */
export function stabilizeBilingualArtifact(
    owner: HTMLElement,
    state: TranslationState,
    registry: BilingualRemountCapitulationRegistry,
    reconcileLayout?: (owner: HTMLElement) => boolean,
): BilingualArtifactDisposition {
    const repair = tryRepairBilingualTranslationArtifact(owner, state, reconcileLayout);
    const sourceCurrent = statefulSourceAndTextSlotsAreCurrent(owner, state);
    // 属性漂移（宿主改写复制链接的 title 等）不改变译文，仍算当前工件：
    // 继续走恢复流程会撤下译文并重新请求，正是“划过译文里的链接就丢译文”的来源。
    const artifactCurrent = isBilingualArtifactKept(owner, state);
    if (sourceCurrent && artifactCurrent) return 'current';

    let capitulated = repair === 'capitulated';
    if (!capitulated && owner.isConnected && repair === 'not-repairable' && sourceCurrent && !artifactCurrent &&
        state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content') {
        capitulated = !consumeBilingualArtifactHostWriteBudget(owner, state);
    }
    if (!capitulated) return 'retry';
    if (owner.parentNode) registry.remember(owner.parentNode, owner, state);
    return 'capitulated';
}

type BilingualTransferOutcome = 'transferred' | 'capitulated' | 'rejected';
interface PendingBilingualTransfer {finish: () => BilingualTransferOutcome;}

function tryTransferBilingualOwner(
    previousOwner: HTMLElement,
    replacementOwner: HTMLElement,
    layoutElementPairs: readonly (readonly [HTMLElement, HTMLElement])[],
    preparation: BilingualRemountPreparation,
): PendingBilingualTransfer | 'capitulated' | 'rejected' {
    const previousState = getTranslationState(previousOwner)!;
    const previousWrapper = previousState.bilingualContent!;
    const trustedTemplate = previousState.bilingualContentTemplate!;
    const directOwnedArtifacts = Array.from(replacementOwner.children).filter((child) =>
        child.matches('[data-fr-translation-owned="true"]')) as HTMLElement[];
    const copiedWrappers = directOwnedArtifacts.filter((child) =>
        child.matches(BILINGUAL_ARTIFACT_SELECTOR)) as HTMLElement[];

    const copiedContent = directOwnedArtifacts.length === 1 && copiedWrappers.length === 1 &&
        isTrustedBilingualArtifactWithHostClass(copiedWrappers[0]!, previousState)
        ? copiedWrappers[0] : undefined;
    const tamperedContent = directOwnedArtifacts.length > 0 && !copiedContent;
    const content = copiedContent ?? trustedTemplate.cloneNode(true) as HTMLElement;
    if (tamperedContent || copiedContent) directOwnedArtifacts.forEach((artifact) => artifact.remove());
    restoreClonedTranslationOwnerPresentation(
        previousOwner,
        replacementOwner,
        previousState,
        layoutElementPairs,
    );

    const attempt = beginTranslation(
        replacementOwner,
        'bilingual',
        'content',
        previousState.syntheticSegment,
        previousState.sourceText,
        preparation.sourceTextNodes,
        previousState.allowTopLevelApplicationShell === true,
        previousState.translationInvocationIdentity,
        previousState.scope,
        previousState.applicationShellPolicyId,
    );
    if (!attempt) return 'rejected';
    // 前置读取期间其他候选可能同步改写宿主；提交前以本次 begin 的新快照再次核对。
    if (isTranslationSourceStructureOverflow(previousState.sourceStructureSignature)
        ? attempt.state.sourceOverflowGenerationIdentity !== previousState.sourceOverflowGenerationIdentity
        : attempt.state.sourceStructureSignature !== previousState.sourceStructureSignature) {
        discardTranslation(replacementOwner, attempt.state);
        return 'rejected';
    }
    // 普通结构签名会折叠空白。整句代码协议还依赖本地捕获的精确文字；
    // 旧代码与新代码仅空白不同也不能复用旧句译文。
    if (!inlineCodeReplaySourceIsCurrent(replacementOwner, previousState)) {
        discardTranslation(replacementOwner, attempt.state);
        return 'rejected';
    }
    if (!markTranslationComplete(replacementOwner, attempt.state, attempt.generation)) {
        discardTranslation(replacementOwner, attempt.state);
        return 'rejected';
    }
    if (!inheritBilingualArtifactRepairBudget(
        previousOwner,
        replacementOwner,
        previousState,
        attempt.state,
        copiedContent ? false : tamperedContent ? 'tamper' : true,
    )) {
        if (previousState.syntheticSegment) {
            previousState.syntheticHost = attempt.state.syntheticHost;
            previousState.syntheticSourceNodes = attempt.state.syntheticSourceNodes;
        }
        discardTranslation(replacementOwner, attempt.state);
        return 'capitulated';
    }

    // 新宿主的宽度可能不同。先撤下旧占位再挂载并核对布局，不能让旧高度
    // 掩盖固定高度祖先的溢出；稍后的 setBilingualContent 同步清理可信模板。
    disableBilingualRenderingContainment(content);
    if (content.parentNode !== replacementOwner) {
        if (previousState.bilingualBeforeSource) replacementOwner.insertBefore(content, replacementOwner.firstChild);
        else replacementOwner.appendChild(content);
    }
    return {finish: () => {
        if (!preparation.reconcileLayout(replacementOwner)) {
            content.remove();
            discardTranslation(replacementOwner, attempt.state);
            return 'rejected';
        }
        // 同批工件写入和布局协调之间宿主仍可能同步修改新来源；只忽略本次
        // 实际将要登记的工件，再次核验后才能继承旧译文与 replay。
        if (!inlineCodeReplaySourceIsCurrent(replacementOwner, {
            ...previousState, bilingualContent: content, spinner: undefined,
        })) {
            content.remove();
            discardTranslation(replacementOwner, attempt.state);
            return 'rejected';
        }
        setBilingualContent(
            replacementOwner,
            content,
            previousState.bilingualReplay,
            trustedTemplate,
        );
        setRenderedStyleAttribute(replacementOwner);
        if (previousWrapper === content) previousState.bilingualContent = undefined;
        discardTranslation(previousOwner, previousState);
        return 'transferred';
    }};
}

export function transferEquivalentBilingualOwners(
    mutationInput: MutationRecord | readonly MutationRecord[],
    prepare: (
        previousOwner: HTMLElement,
        replacementOwner: HTMLElement,
        state: TranslationState,
    ) => BilingualRemountPreparation | null,
    resolveRemovedOwners: RemovedTranslationOwnerResolver = getTranslationOwnersForRemovedNode,
): BilingualRemountResult {
    const mutations: readonly MutationRecord[] = Array.isArray(mutationInput)
        ? mutationInput as readonly MutationRecord[]
        : [mutationInput as MutationRecord];
    const childListMutations = mutations.filter((mutation) => mutation.type === 'childList');
    if (!childListMutations.some((mutation) => mutation.addedNodes.length > 0) ||
        !childListMutations.some((mutation) => mutation.removedNodes.length > 0)) {
        return {transfers: [], capitulations: []};
    }

    const pairs = matchBilingualRemountOwners(childListMutations, resolveRemovedOwners);

    pairs.sort((left, right) => right.depth - left.depth);
    const adopted = new Set<HTMLElement>();
    const consumedPrevious = new Set<HTMLElement>();
    const layoutPathIndexes = new WeakMap<Node, Map<Node, number>>();
    const prepared: Array<(typeof pairs)[number] & {
        preparation: BilingualRemountPreparation;
        layoutElementPairs: Array<readonly [HTMLElement, HTMLElement]>;
    }> = [];
    // 先完成所有候选/布局映射读取，后续 append 不再穿插 resolve 的 computed-style 查询。
    pairs.forEach((pair) => {
        const {previousOwner, replacementOwner, previousRoot, replacementRoot} = pair;
        if (adopted.has(replacementOwner) || consumedPrevious.has(previousOwner)) return;
        const previousState = getTranslationState(previousOwner)!;
        const layoutElementPairs: Array<readonly [HTMLElement, HTMLElement]> = [];
        for (const previousElement of previousState.layoutOverrideElements ?? []) {
            const path = nodePathWithin(previousRoot, previousElement, layoutPathIndexes);
            if (!path) continue;
            const replacementElement = asHTMLElement(nodeAtPath(replacementRoot, path));
            if (!replacementElement || previousElement.localName !== replacementElement.localName ||
                previousElement.namespaceURI !== replacementElement.namespaceURI) return;
            layoutElementPairs.push([previousElement, replacementElement]);
        }
        const preparation = prepare(previousOwner, replacementOwner, previousState);
        if (!preparation) return;
        prepared.push({...pair, preparation, layoutElementPairs});
        adopted.add(replacementOwner);
        consumedPrevious.add(previousOwner);
    });
    const transfers: BilingualOwnerTransfer[] = [];
    const capitulations: BilingualOwnerCapitulation[] = [];
    const pending: Array<BilingualOwnerTransfer & PendingBilingualTransfer> = [];
    prepared.forEach(({previousOwner, replacementOwner, boundary, layoutElementPairs, preparation}) => {
        const outcome = tryTransferBilingualOwner(previousOwner, replacementOwner, layoutElementPairs, preparation);
        if (outcome === 'capitulated') capitulations.push({previousOwner, replacementOwner, boundary});
        else if (outcome !== 'rejected') pending.push({previousOwner, replacementOwner, finish: outcome.finish});
    });
    // 全部工件落位后再读取尺寸；正常段落无需写样式，只触发一次批量布局刷新。
    pending.forEach(({previousOwner, replacementOwner, finish}) => {
        if (finish() === 'transferred') transfers.push({previousOwner, replacementOwner});
    });
    return {transfers, capitulations};
}
