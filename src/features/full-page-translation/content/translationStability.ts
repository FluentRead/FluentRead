/**
 * @file src/features/full-page-translation/content/translationStability.ts
 * 文件职责：提供动态页面翻译的语义稳定性判断、轻量完成证据复验和实时文本槽重绑定，隔离 React/虚拟列表重建造成的生命周期噪声。
 * 主要内容：判断原文与译文工件是否仍完整，排队行内候选逐一复验全部来源节点及顺序，在保留宿主链接焦点管理的前提下决定是否保留当前翻译 generation，并在逐槽核对当前来源后把异步结果映射到实时 Text 节点与空白边界；仅译文复验读取本代精确来源槽，避免数字邻接文字时误判父节点为纯数值；同值完成证明排除同步语言跳过和符合补充检测资格的长未知正文，避免将本地原文回填认证为供应商结果；重挂提取原文和文本槽时共享单文本读取，多槽仍保留独立的链接标识符与属性标签提取政策；按钮型 input 的译文写在标签属性上，另按已记录属性值复验其时效与自身写入。
 * 模块边界：本文件不读取配置、不监听 DOM、不执行 provider 请求；回退来源 HTML 比对只在惰性文档中复制，不激活来源资源；自动应用外壳候选和轻量完成证据必须重新认证原策略，runtime 通过回调提供当前来源与槽位快照。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {cloneTranslationElementInert} from '@/src/core/translation/inertClone';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {getSupplementalLanguageCandidate} from '@/src/core/language/supplement';
import type {TranslationScope} from '@/src/core/translation/public';
import {
    collectLiveTranslationTextSlots,
    createTranslationTextProtectionCache,
    extractTranslationText,
    getComposedParent,
    getCurrentTranslationCore,
    getTranslationCandidateKey,
    isProtectedDescendantElement,
    isTranslationTextElementProtected,
    type TranslationCandidate,
    type TranslationTextProtectionCache,
    type TranslationTextProtectionOptions,
    type TranslationTextSlot,
} from '@/src/core/translation/public';
import {
    BILINGUAL_ARTIFACT_SELECTOR,
    OWNED_SINGLE_TEXT_SOURCE_SELECTOR,
    getTranslationOverflowGenerationIdentity,
    getTranslationState,
    isTranslationApplicationShellPolicyCurrent,
    inlineCodeReplaySourceIsCurrent,
    getTranslationSourceStructureSignature,
    isBilingualArtifactDriftOnly,
    isTranslationSourceStructureOverflow,
    isTrustedBilingualArtifactWithHostClass,
    type TranslationState,
} from './state';

export interface FullPageLifecycleRetry {
    owner: HTMLElement;
    source: string;
    kind: TranslationCandidate["kind"];
    reason: string;
    applicationShellPolicyId?: string;
    attempts: number;
    completion?: AcceptedUnchangedCompletion;
}
export function createLifecycleRetry(
    candidate: TranslationCandidate,
    source: string,
    attempts: number,
    completion?: AcceptedUnchangedCompletion,
): FullPageLifecycleRetry {
    return {
        owner: candidate.element,
        source: normalizeComparableText(source),
        kind: candidate.kind,
        reason: candidate.reason,
        ...(candidate.applicationShellPolicyId ? {applicationShellPolicyId: candidate.applicationShellPolicyId} : {}),
        attempts, completion,
    };
}

export function sameLifecycleRetry(
    previous: FullPageLifecycleRetry | undefined,
    candidate: TranslationCandidate,
    source: string,
): boolean {
    return Boolean(previous &&
        previous.owner === candidate.element &&
        previous.source === source &&
        previous.kind === candidate.kind &&
        previous.applicationShellPolicyId === candidate.applicationShellPolicyId &&
        previous.reason === candidate.reason);
}

/** Lightweight result proof. No TranslationState, controller, candidate or credential retained. */
export interface AcceptedUnchangedCompletion {
    reason: 'accepted-result-identical';
    sources: readonly string[];
    outputs: readonly string[];
    sourceNodes: readonly Text[];
    sourceStructureSignature: string;
    scope?: TranslationScope;
    allowTopLevelApplicationShell: boolean;
    applicationShellPolicyId?: string;
    sessionId: number;
    renderCommitGeneration: number;
    generation: number;
    configIdentity: string;
    configuredService: string;
    targetLanguage: string;
    completedAtUnixMs: number;
}
interface CompletionConfig {
    sessionId: number;
    renderCommitGeneration: number;
    configIdentity: string;
    service: string;
    targetLanguage: string;
    excludedLanguages?: readonly string[];
}
export function createAcceptedUnchangedCompletion(owner: HTMLElement, candidate: TranslationCandidate,
    state: TranslationState, generation: number, sources: readonly string[], outputs: readonly string[],
    config: CompletionConfig): AcceptedUnchangedCompletion | undefined {
    if (owner !== candidate.element || !isTranslationApplicationShellPolicyCurrent(owner, state) ||
        state.applicationShellPolicyId !== candidate.applicationShellPolicyId ||
        state.syntheticSegment || candidate.nodes?.length || state.mode !== 'bilingual' ||
        state.kind !== 'content' || state.controller.signal.aborted || state.generation !== generation ||
        sources.length !== 1 || outputs.length !== 1 || sources[0] !== state.sourceText ||
        state.sourceTextNodes?.length !== 1 || !state.sourceStructureSignature ||
        isTranslationSourceStructureOverflow(state.sourceStructureSignature) ||
        sources[0]!.length > 2048 || outputs[0]!.length > 2048 ||
        // 三美元公式会由请求链在本地回填，不能据此认证 provider 的相同结果。
        sources[0]!.includes('$$$') ||
        !hasDistinctTranslation('', outputs[0]) || hasDistinctTranslation(sources[0]!, outputs[0]) ||
        shouldSkipTranslationForTarget(sources[0]!, config.targetLanguage, config.excludedLanguages) ||
        // 长未知正文可能由补充预检在本地回填，单凭同值结果不能证明 provider 已返回。
        getSupplementalLanguageCandidate(sources[0]!) !== undefined ||
        !['freeTranslation', 'microsoft', 'google'].includes(config.service)) return undefined;
    return {reason: 'accepted-result-identical', sources: [...sources], outputs: [...outputs],
        sourceNodes: [...state.sourceTextNodes], sourceStructureSignature: state.sourceStructureSignature,
        scope: state.scope, allowTopLevelApplicationShell: state.allowTopLevelApplicationShell === true,
        ...(state.applicationShellPolicyId ? {applicationShellPolicyId: state.applicationShellPolicyId} : {}),
        sessionId: config.sessionId, renderCommitGeneration: config.renderCommitGeneration, generation,
        configIdentity: config.configIdentity, configuredService: config.service,
        targetLanguage: config.targetLanguage, completedAtUnixMs: Date.now()};
}
/** Same-epoch identical semantic state may reuse a historical accepted result; never new live dispatch proof. */
export function readAcceptedUnchangedCompletion(owner: HTMLElement, record: FullPageLifecycleRetry | undefined,
    query: {sessionId: number; currentSessionId?: number; renderCommitGeneration?: number;
        configIdentity?: string; source: string; cancelled: boolean}) {
    const proof = record?.completion;
    const unavailable = {status: 'unavailable', reason: 'no-current-accepted-completion'} as const;
    if (!record || !proof || record.owner !== owner || !owner.isConnected || query.cancelled || getTranslationState(owner) ||
        query.sessionId !== query.currentSessionId || proof.sessionId !== query.currentSessionId ||
        proof.renderCommitGeneration !== query.renderCommitGeneration || proof.configIdentity !== query.configIdentity ||
        normalizeComparableText(query.source) !== record.source ||
        !isTranslationCandidateCurrent({element: owner, kind: record.kind, reason: record.reason,
            scope: proof.scope, applicationShellPolicyId: proof.applicationShellPolicyId,
            ...(proof.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {})})) return unavailable;
    const core = getCurrentTranslationCore(proof.scope);
    const slots = collectLiveTranslationTextSlots(owner, core.shouldStayOriginal, undefined,
        getTranslationTextProtectionOptions(proof.allowTopLevelApplicationShell, owner));
    if (slots.length !== proof.sourceNodes.length || slots.some((slot, i) =>
        slot.node !== proof.sourceNodes[i] || slot.source !== proof.sources[i]) ||
        getTranslationSourceStructureSignature(owner, proof.allowTopLevelApplicationShell, proof.sourceNodes,
            proof.scope) !== proof.sourceStructureSignature || owner.querySelector(TRANSLATION_ARTIFACT_SELECTOR)) return unavailable;
    return {status: 'available', reason: proof.reason, sessionId: proof.sessionId, generation: proof.generation,
        renderCommitGeneration: proof.renderCommitGeneration, sources: [...proof.sources], outputs: [...proof.outputs],
        source: query.source, sourceCurrent: true, configuredService: proof.configuredService,
        targetLanguage: proof.targetLanguage, completedAtUnixMs: proof.completedAtUnixMs,
        requestBoundary: 'accepted-same-session-result-reuse', upstreamDispatchAndRoute: 'unavailable'} as const;
}

export interface LiveTextResultSnapshot {
    sources: readonly string[];
    translations: readonly string[];
    nodes: readonly Text[];
    slots: readonly {node: Text; text: string}[];
}

export interface ReboundLiveTextResult {
    nodes: readonly Text[];
    slots: readonly {node: Text; text: string}[];
}

export const TRANSLATION_ARTIFACT_SELECTOR = [
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
].join(',');

export function normalizeComparableText(text: string): string {
    return text.replace(/[\s\u3000]+/g, ' ').trim();
}

export function isTranslationStateSourceCurrent(node: HTMLElement, state: TranslationState): boolean {
    return normalizeComparableText(getCurrentTranslationStateSourceText(node, state)) ===
        normalizeComparableText(state.sourceText);
}

export function getTranslationTextProtectionOptions(
    allowTopLevelApplicationShell: boolean | undefined,
    protectedElement: Element,
): TranslationTextProtectionOptions | undefined {
    return allowTopLevelApplicationShell === true
        ? {allowTopLevelApplicationShell: true, protectedElement}
        : undefined;
}

export function getTranslationStateProtectionBoundary(
    node: HTMLElement,
    state: TranslationState,
): HTMLElement | undefined {
    return state.syntheticSegment ? node : undefined;
}

export function getCandidateTranslationTextProtectionOptions(
    candidate: TranslationCandidate,
): TranslationTextProtectionOptions | undefined {
    return getTranslationTextProtectionOptions(
        candidate.allowTopLevelApplicationShell,
        candidate.element,
    );
}

function sourceSlotHostSet(slots: NonNullable<TranslationState['singleTextSlotHosts']>): Set<Element> {
    return new Set(slots.map(({host}) => host));
}

/** 已渲染 owner 的范围复验读取精确来源槽，其他站点与 DOM 保护边界保持有效。 */
function getStatefulCandidateTextProtectionOptions(
    candidate: TranslationCandidate,
    state: TranslationState | undefined,
): TranslationTextProtectionOptions | undefined {
    if (!state?.singleTextSlotHosts?.length ||
        !statefulSourceAndTextSlotsAreCurrent(candidate.element, state) ||
        !state.singleTextSlotHosts.every(({host, source}) => host.childNodes.length === 1 &&
            host.firstChild === source && host.matches(OWNED_SINGLE_TEXT_SOURCE_SELECTOR))) {
        return undefined;
    }
    return {
        sourceTextSlotHosts: sourceSlotHostSet(state.singleTextSlotHosts),
        ...getCandidateTranslationTextProtectionOptions(candidate),
    };
}

/** 复验已有候选的身份与站点边界，读取原文槽而不把译文布局误当作来源。 */
export function isTranslationCandidateCurrent(candidate: TranslationCandidate): boolean {
    const core = getCurrentTranslationCore(candidate.scope);
    if (!candidate.element.isConnected || !isTranslationApplicationShellPolicyCurrent(candidate.element, candidate)) return false;
    if (candidate.manualChunk) {
        return candidate.element.matches('[data-fr-translation-segment="true"][data-fr-translation-manual="true"]') &&
            Boolean(candidate.element.parentElement?.isConnected);
    }
    if (candidate.nodes?.length) {
        if (candidate.nodes.some((node) => node.parentNode !== candidate.element)) return false;
        const fresh = core.resolve(getTranslationCandidateKey(candidate));
        return Boolean(fresh && fresh.element === candidate.element &&
            fresh.kind === candidate.kind &&
            fresh.allowTopLevelApplicationShell === candidate.allowTopLevelApplicationShell &&
            // 首节点相同仍可能已新增、重排或分出独立后代；接受旧集合会漏译，
            // 随后的物化还可能把旧节点搬过宿主新插入的内容，改变原文顺序。
            fresh.nodes?.length === candidate.nodes.length &&
            fresh.nodes.every((node, index) => node === candidate.nodes![index]));
    }
    const textProtectionOptions = getStatefulCandidateTextProtectionOptions(candidate, getTranslationState(candidate.element));
    const fresh = textProtectionOptions
        ? core.inspect(candidate.element, textProtectionOptions).candidate
        : candidate.allowTopLevelApplicationShell === true
            ? core.resolve(candidate.element)
            : core.inspect(candidate.element).candidate;
    return Boolean(
        fresh?.element === candidate.element &&
        fresh.kind === candidate.kind &&
        fresh.allowTopLevelApplicationShell === candidate.allowTopLevelApplicationShell,
    );
}

/** 自动重试重新解析后仍携带原站点许可，不能降级为手动悬浮的外壳例外。 */
export function inheritTranslationApplicationShellPolicy(
    previous: Pick<TranslationCandidate, 'applicationShellPolicyId'>,
    candidate: TranslationCandidate | null,
): TranslationCandidate | null {
    if (!candidate || !previous.applicationShellPolicyId) return candidate;
    return getCurrentTranslationCore(candidate.scope).isApplicationShellPolicyCurrent(candidate.element, previous.applicationShellPolicyId)
        ? {...candidate, applicationShellPolicyId: previous.applicationShellPolicyId} : null;
}


/** 已有 state 的正文范围复验；调用者在任何可能写入 DOM 的操作前使批次失效。 */
export function isTranslationStateCandidateCurrent(owner: HTMLElement, state: TranslationState): boolean {
    return isTranslationCandidateCurrent({element: owner, kind: state.kind,
        reason: 'site-boundary-change', scope: state.scope, applicationShellPolicyId: state.applicationShellPolicyId,
        ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {})});
}

/** 同一 observer 只读阶段分别缓存边界与来源；精确 owner/state 不同或发生写入就重新读取。 */
export function createTranslationMutationStabilityChecks() {
    type Read = {owner: HTMLElement; scope?: boolean; source?: boolean};
    let reads = new WeakMap<TranslationState, Read>();
    const read = (owner: HTMLElement, state: TranslationState, key: 'scope' | 'source',
        check: (owner: HTMLElement, state: TranslationState) => boolean): boolean => {
        let previous = reads.get(state);
        if (!previous || previous.owner !== owner) {
            previous = {owner};
            reads.set(state, previous);
        }
        return previous[key] ?? (previous[key] = check(owner, state));
    };
    return {
        scopeIsCurrent: (owner: HTMLElement, state: TranslationState) =>
            read(owner, state, 'scope', isTranslationStateCandidateCurrent),
        sourceIsCurrent: (owner: HTMLElement, state: TranslationState) =>
            read(owner, state, 'source', statefulSourceAndTextSlotsAreCurrent),
        invalidate: () => {reads = new WeakMap();},
    };
}

export function getCurrentTranslationStateSourceText(node: HTMLElement, state: TranslationState): string {
    if (!isTranslationApplicationShellPolicyCurrent(node, state)) return '';
    return extractTranslationText(
        node,
        getCurrentTranslationCore(state.scope).shouldStayOriginal,
        getTranslationStateProtectionBoundary(node, state),
        getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
    );
}

export function getCurrentTranslationStateTextNodes(
    node: HTMLElement, state: TranslationState, protectionCache?: TranslationTextProtectionCache,
): Text[] {
    if (!isTranslationApplicationShellPolicyCurrent(node, state)) return [];
    return collectLiveTranslationTextSlots(
        node,
        getCurrentTranslationCore(state.scope).shouldStayOriginal,
        getTranslationStateProtectionBoundary(node, state),
        getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
        state.syntheticSegment || state.allowTopLevelApplicationShell === true ? undefined : protectionCache,
    ).map((slot) => slot.node);
}

/** 单个直接 Text 的已验证槽就是完整原文；复杂骨架仍按原文提取政策复核。 */
export function getCurrentTranslationStateSourceSnapshot(
    node: HTMLElement, state: TranslationState, protectionCache?: TranslationTextProtectionCache,
): {
    sourceText: string;
    sourceTextNodes: Text[];
} {
    const sourceTextNodes = getCurrentTranslationStateTextNodes(node, state, protectionCache);
    const singleText = node.childNodes.length === 1 && sourceTextNodes.length === 1 &&
        node.firstChild === sourceTextNodes[0];
    return {
        sourceText: singleText ? normalizeComparableText(sourceTextNodes[0]!.data)
            : getCurrentTranslationStateSourceText(node, state),
        sourceTextNodes,
    };
}

/** 同一次重挂 prepare 只读批次共享普通 owner 的资格读数；提交写入前结束使用。 */
export function createCurrentTranslationStateSourceSnapshotBatch(): (
    node: HTMLElement, state: TranslationState,
) => {sourceText: string; sourceTextNodes: Text[]} {
    const caches = new Map<ReturnType<typeof getCurrentTranslationCore>, TranslationTextProtectionCache>();
    return (node, state) => {
        if (state.syntheticSegment || state.allowTopLevelApplicationShell === true) {
            return getCurrentTranslationStateSourceSnapshot(node, state);
        }
        const core = getCurrentTranslationCore(state.scope);
        let cache = caches.get(core);
        if (!cache) {
            cache = createTranslationTextProtectionCache();
            caches.set(core, cache);
        }
        return getCurrentTranslationStateSourceSnapshot(node, state, cache);
    };
}

function sourceHTMLWithoutDirectBilingualArtifacts(node: HTMLElement): string {
    const clone = cloneTranslationElementInert(node);
    Array.from(clone.children)
        .filter((child) => child.matches(BILINGUAL_ARTIFACT_SELECTOR))
        .forEach((child) => child.remove());
    return clone.innerHTML;
}

export function statefulSourceAndTextSlotsAreCurrent(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    if (!isTranslationApplicationShellPolicyCurrent(node, state)) return false;
    if (!inlineCodeReplaySourceIsCurrent(node, state)) return false;
    // 双语模式不改写宿主 Text；保护区后代换代时保留已捕获来源，
    // 来源 Text 换代则只接受精确同构 HTML，避免误用旧链接或标签的译文。
    if (state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content') {
        const previousNodes = state.sourceTextNodes ?? [];
        if (isTranslationSourceStructureOverflow(state.sourceStructureSignature) &&
            !state.sourceStructureDirty && previousNodes.length > 0 &&
            previousNodes.every((text) => text.isConnected && node.contains(text)) &&
            normalizeComparableText(previousNodes.map((text) => text.data).join(' ')) ===
                normalizeComparableText(state.sourceText)) return true;
        if (normalizeComparableText(getCurrentTranslationStateSourceText(node, state)) !==
            normalizeComparableText(state.sourceText)) return false;
        const currentNodes = getCurrentTranslationStateTextNodes(node, state);
        if (isTranslationSourceStructureOverflow(state.sourceStructureSignature)) {
            if (state.sourceStructureDirty || getTranslationOverflowGenerationIdentity(
                node,
            ) !== state.sourceOverflowGenerationIdentity) return false;
        } else {
            const structureSignature = getTranslationSourceStructureSignature(
                node,
                state.allowTopLevelApplicationShell === true,
                currentNodes,
                state.scope,
            );
            if (state.sourceStructureSignature === undefined
                ? sourceHTMLWithoutDirectBilingualArtifacts(node) !== state.sourceHTML
                : structureSignature !== state.sourceStructureSignature) return false;
        }
        state.sourceTextNodes = currentNodes;
        return true;
    }

    const slotHosts = state.singleTextSlotHosts;
    if (slotHosts) {
        const previousNodes = state.sourceTextNodes ?? [];
        if (slotHosts.length !== previousNodes.length) return false;
        const core = getCurrentTranslationCore(state.scope);
        // 数字旁的原文可能已移入本代译文槽。复验祖先时必须读取这些精确来源，
        // 否则跳过槽后只剩数字，祖先会被误判成无需翻译的实时数值。
        const options = {
            ...getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
            sourceTextSlotHosts: sourceSlotHostSet(slotHosts),
        };
        const protectionCache = createTranslationTextProtectionCache();
        // 合成段仅忽略自己的扩展身份，其宿主和自身真实的 hidden/notranslate
        // 仍保持权威；共享祖先缓存避免逐个槽反复遍历完整祖先链。
        if (state.syntheticSegment) {
            const parent = getComposedParent(node);
            const protectedParent = parent ? isTranslationTextElementProtected(
                parent, core.shouldStayOriginal, protectionCache, options) : false;
            protectionCache.set(node, {
                depth: (parent ? protectionCache.get(parent)!.depth : 0) + 1,
                protected: protectedParent || isProtectedDescendantElement(node, true, options) ||
                    core.shouldStayOriginal(node),
            });
        }
        if (!slotHosts.every(({host, source, sourceValue}, index) =>
            previousNodes[index] === source && host.parentNode !== null && node.contains(host) &&
            host.contains(source) && source.data === sourceValue && host.parentElement !== null &&
            !isTranslationTextElementProtected(host.parentElement, core.shouldStayOriginal, protectionCache, options))) {
            return false;
        }
        // 已有槽保留原 Text，但新的正文可能通过 childList 或可见性变化加入。
        // 只放行本代登记的槽；其他新出现的可译 Text 仍使快照失效。
        const originalNodes = new Set(previousNodes);
        return collectLiveTranslationTextSlots(node, core.shouldStayOriginal,
            getTranslationStateProtectionBoundary(node, state), options)
            .every(({node: text}) => originalNodes.has(text));
    }

    const currentNodes = getCurrentTranslationStateTextNodes(node, state);
    const previousNodes = state.translatedTextNodes ?? state.sourceTextNodes ?? [];
    if (currentNodes.length !== previousNodes.length ||
        currentNodes.some((textNode, index) => textNode !== previousNodes[index])) return false;
    if ((state.kind === 'control' || state.mode === 'single') && state.textSlotsApplied) {
        // 按钮型 input 的译文写在属性上；宿主页把标签改回原值或换成别的动作时，
        // 当前译文即已失效，必须交回发现流程重新判定，而不是当作仍然生效。
        const controlValue = state.controlValue;
        if (controlValue?.translated !== undefined &&
            node.getAttribute(controlValue.attribute) !== controlValue.translated) return false;
        return currentNodes.every((textNode) =>
            state.translatedTextValues?.get(textNode) === textNode.data);
    }
    return normalizeComparableText(getCurrentTranslationStateSourceText(node, state)) ===
        normalizeComparableText(state.sourceText);
}

export function mutationTouchesCurrentTranslationArtifact(
    mutation: MutationRecord,
    state: TranslationState,
): boolean {
    const artifacts = [state.spinner, state.bilingualContent, state.retryWrapper]
        .filter((node): node is HTMLElement => Boolean(node));
    if (artifacts.length === 0) return false;
    if (artifacts.some((artifact) =>
        mutation.target === artifact || artifact.contains(mutation.target))) return true;
    return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
        .some((node) => artifacts.some((artifact) =>
            node === artifact || artifact.contains(node) ||
            (node.nodeType === 1 && (node as Element).contains(artifact))));
}

export function isOwnSingleTextSlotMove(
    mutation: MutationRecord,
    target: HTMLElement,
    state: TranslationState,
): boolean {
    if (mutation.type !== 'childList' || !state.singleTextSlotHosts?.length ||
        mutation.target.nodeType !== 1) return false;
    const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
    if (changedNodes.length === 0) return false;
    // 原文移入自有槽会同时产生原父节点的移除记录和槽内的加入记录。
    // 两侧都必须匹配同一个原文节点，并继续校验完整来源，避免自身渲染触发重译。
    const slot = state.singleTextSlotHosts.find(({host, source}) => host === mutation.target ||
        (host.parentNode === mutation.target && mutation.addedNodes.length === 0 &&
            mutation.removedNodes.length === 1 && mutation.removedNodes[0] === source));
    return Boolean(slot && changedNodes.every((node) => node === slot.source) &&
        statefulSourceAndTextSlotsAreCurrent(target, state));
}

export function isOwnCurrentArtifactAddition(
    mutation: MutationRecord,
    state: TranslationState,
): boolean {
    return mutation.addedNodes.length > 0 && Array.from(mutation.addedNodes).every((node) =>
        node === state.spinner || node === state.retryWrapper ||
        state.singleTextSlotHosts?.some(({host}) => node === host) === true ||
        node === state.bilingualContent && state.bilingualContent.outerHTML === state.bilingualOuterHTML);
}

/** 精确识别所有目标的 spinner 事务，以及控件原位回写的最终 Text。 */
export function isOwnStateArtifactMutation(
    mutation: MutationRecord,
    target: HTMLElement,
    state: TranslationState,
): boolean {
    if (state.phase === 'translated' && mutation.type === 'childList' && mutation.target === target &&
        state.settledSpinner) {
        const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
        if (changed.length > 0 && changed.every((node) => node === state.settledSpinner)) return true;
    }
    if (state.phase === 'loading') return mutation.type === 'childList' && mutation.target === target &&
        state.spinner?.parentNode === target && mutation.removedNodes.length === 0 &&
        mutation.addedNodes.length > 0 && Array.from(mutation.addedNodes).every((node) => node === state.spinner) &&
        statefulSourceAndTextSlotsAreCurrent(target, state);
    if (state.kind !== 'control') return false;
    if (state.phase !== 'translated' || state.textSlotsApplied !== true) return false;
    if (mutation.type === 'characterData') {
        return state.translatedTextValues?.get(mutation.target as Text) === mutation.target.nodeValue;
    }
    // 属性型按钮标签的提交写入同样来自插件自身；只承认仍与已记录译文一致的那一次写入。
    const controlValue = state.controlValue;
    if (mutation.type === 'attributes' && controlValue?.translated !== undefined &&
        mutation.attributeName === controlValue.attribute && mutation.target === target) {
        return target.getAttribute(controlValue.attribute) === controlValue.translated;
    }
    return false;
}

export function isTranslationArtifact(node: Node): boolean {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(element &&
        (element.matches(TRANSLATION_ARTIFACT_SELECTOR) ||
            element.closest(TRANSLATION_ARTIFACT_SELECTOR)));
}

export function hasCurrentTranslationSource(
    node: HTMLElement,
    state: TranslationState,
    readSource: (node: HTMLElement, state: TranslationState) => boolean,
): boolean {
    if (state.syntheticSegment || state.kind !== 'content' || !node.isConnected ||
        !isTranslationApplicationShellPolicyCurrent(node, state)) return false;
    return readSource(node, state);
}

/**
 * `phase=translated` 只是请求状态，不能代表页面上的译文仍然存在。
 * 动态页面可以保留 owner 却删除/移动 wrapper，也可以改写 wrapper 内容；
 * 连续悬浮只有在“当前 generation 的精确工件”仍完整时才能安全 no-op。
 */
export function isTranslationArtifactCurrent(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    if (state.phase !== 'translated') return false;
    // 控件在双语页面模式下仍采用原位 Text 回写，不会创建 bilingual wrapper。
    // 必须先按目标类型判断，否则延迟复验会把已提交控件误当成工件缺失并恢复原文。
    if (state.kind === 'control') return state.textSlotsApplied === true;

    if (state.mode === 'bilingual') {
        const wrapper = state.bilingualContent;
        const directWrappers = Array.from(node.children).filter((child) =>
            child.matches(BILINGUAL_ARTIFACT_SELECTOR));
        return Boolean(
            wrapper &&
            wrapper.parentNode === node &&
            wrapper.isConnected &&
            wrapper.matches(BILINGUAL_ARTIFACT_SELECTOR) &&
            state.bilingualHTML !== undefined &&
            state.bilingualOuterHTML !== undefined &&
            (wrapper.innerHTML === state.bilingualHTML && wrapper.outerHTML === state.bilingualOuterHTML ||
                isTrustedBilingualArtifactWithHostClass(wrapper, state)) &&
            directWrappers.length === 1 &&
            directWrappers[0] === wrapper,
        );
    }

    const hosts = state.singleTextSlotHosts;
    return Boolean(
        hosts &&
        hosts.length === state.sourceTextNodes?.length &&
        hosts.every(({host, source}) =>
            host.parentNode !== null &&
            host.isConnected &&
            node.contains(host) &&
            host.contains(source)),
    );
}

/**
 * 工件的译文内容仍是本代结果。比 isTranslationArtifactCurrent 宽一点：宿主只
 * 改写了复制进骨架的装饰性属性时仍算有效，避免站点悬停脚本反复写 title 就被
 * 当成篡改撤下译文。是否重建骨架由调用方另行决定。
 */
export function isBilingualArtifactKept(node: HTMLElement, state: TranslationState): boolean {
    return isTranslationArtifactCurrent(node, state) || isBilingualArtifactDriftOnly(node, state);
}

export function canKeepTranslationAttempt(
    node: HTMLElement,
    state: TranslationState,
    readSource: (node: HTMLElement, state: TranslationState) => boolean,
    readSlots: (node: HTMLElement, state: TranslationState) => boolean,
    artifactIntact = true,
): boolean {
    if (!hasCurrentTranslationSource(node, state, readSource)) return false;
    if (state.phase === 'loading') return true;
    return state.phase === 'translated' && artifactIntact &&
        isBilingualArtifactKept(node, state) &&
        readSlots(node, state);
}

export function reboundLiveTextResult(
    currentNodes: readonly Text[],
    result: LiveTextResultSnapshot,
    currentParts: readonly TranslationTextSlot[],
): ReboundLiveTextResult | null {
    // Text 身份不变不代表内容未变；宿主可在同一批更新中重新分配行内文本，
    // 使整段原文保持一致但每个 provider 槽已经不同。提交必须逐槽核对，
    // 并始终从当前前后缀构建展示值，避免把请求开始时的空白写回页面。
    if (currentNodes.length !== currentParts.length || currentParts.length !== result.sources.length ||
        currentParts.some((part, index) =>
            part.node !== currentNodes[index] || part.source !== result.sources[index])) return null;
    return {
        nodes: currentParts.map((part) => part.node),
        slots: currentParts.map((part, index) => ({
            node: part.node,
            text: `${part.prefix}${result.translations[index] ?? part.source}${part.suffix}`,
        })),
    };
}
