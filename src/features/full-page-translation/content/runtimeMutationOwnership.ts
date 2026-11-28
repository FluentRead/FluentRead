/**
 * @file src/features/full-page-translation/content/runtimeMutationOwnership.ts
 *
 * 文件职责：封装全文翻译会话的候选索引维护、用户取消记忆、来源提取与重试重解析，以及扩展自有 DOM 变更（MutationRecord）精确归属判定。
 * 主要内容：导出候选观察与 owner 键值索引辅助、用户取消记录与校验、candidateLifecycleSource/resolveFullPageRetryCandidate，以及 resolveStatefulMutationTarget、isIntactLoadingSyntheticChildList 和 isOwnTranslationMutation。
 * 模块边界：仅操作传入的 FullPageSession 集合与只读 DOM 快照，不调度计时器、不修改宿主 DOM，也不持有模块级会话单例。
 */

import {cloneTranslationElementInert} from '@/src/core/translation/inertClone';
import {
    getCurrentTranslationCore,
    getTranslationCandidateKey,
    type TranslationCandidate,
} from '@/src/core/translation/public';
import type {FullPageSession} from './fullPageSession';
import {removeFullPagePending} from './fullPageQueue';
import {
    allMutationNodesMatch,
    asHTMLElement,
    isElementNode,
    isOwnSyntheticSegmentMarkerMutation,
    mutationTargetElement,
} from './mutationObservation';
import {consumeOrphanedOwnerClassMutation} from './orphanArtifacts';
import {
    getTranslationState,
    isTranslationLayoutOverrideMutation,
    type TranslationState,
} from './state';
import {
    extractCandidateSourceText as candidateSourceText,
    getCandidateTranslationTextProtectionOptions,
    getCurrentTranslationStateTextNodes,
    inheritTranslationApplicationShellPolicy,
    isOwnCurrentArtifactAddition,
    isOwnSingleTextSlotMove,
    isOwnStateArtifactMutation,
    isTranslationArtifact,
    normalizeComparableText,
    statefulSourceAndTextSlotsAreCurrent,
    TRANSLATION_ARTIFACT_SELECTOR,
} from './translationStability';

export function removeCandidateObservation(session: FullPageSession, key: Node): void {
    const anchor = session.candidateAnchors.get(key);
    if (!anchor) return;
    session.candidateAnchors.delete(key);
    const observed = session.observedCandidates.get(anchor);
    observed?.delete(key);
    if (observed?.size === 0) {
        session.observedCandidates.delete(anchor);
        session.observer.unobserve(anchor);
    }
}

export function addCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    let keys = session.candidateOwnerKeys.get(owner);
    if (!keys) {
        keys = new Set();
        session.candidateOwnerKeys.set(owner, keys);
    }
    keys.add(key);
}

export function removeCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    const keys = session.candidateOwnerKeys.get(owner);
    keys?.delete(key);
    if (keys?.size === 0) session.candidateOwnerKeys.delete(owner);
}

export function forgetScheduledCandidate(
    session: FullPageSession | undefined,
    candidate: TranslationCandidate,
    onProgressChange: (session: FullPageSession) => void,
): void {
    if (!session) return;
    const key = getTranslationCandidateKey(candidate);
    const removedPending = removeFullPagePending(session, key, candidate);
    if (session.scheduled.get(key) !== candidate) {
        if (removedPending) onProgressChange(session);
        return;
    }
    session.scheduled.delete(key);
    removeCandidateObservation(session, key);
    removeCandidateOwnerKey(session, candidate.element, key);
    onProgressChange(session);
}

export function removeScheduledForStateTarget(
    session: FullPageSession,
    target: HTMLElement,
    onProgressChange: (session: FullPageSession) => void,
): void {
    const state = getTranslationState(target);
    const host = state?.syntheticSegment ? target.parentElement : target;
    const candidateElements = new Set<HTMLElement>([target]);
    if (host) candidateElements.add(host);
    for (const element of candidateElements) {
        const keys = session.candidateOwnerKeys.get(element);
        if (!keys) continue;
        for (const key of Array.from(keys)) {
            const candidate = session.scheduled.get(key);
            if (!candidate) continue;
            const matches = candidate.element === target || candidate.element === host ||
                Boolean(candidate.nodes?.some((node) => target.contains(node)));
            if (matches) forgetScheduledCandidate(session, candidate, onProgressChange);
        }
    }
}

export function candidateLifecycleSource(candidate: TranslationCandidate): string {
    try {
        const core = getCurrentTranslationCore(candidate.scope);
        const protectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
        return normalizeComparableText(candidateSourceText(candidate, core, protectionOptions));
    } catch {
        return normalizeComparableText(candidate.element.textContent ?? '');
    }
}

export function resolveFullPageRetryCandidate(
    candidate: TranslationCandidate,
    retryRoot?: Node,
): TranslationCandidate | null {
    const core = getCurrentTranslationCore(candidate.scope);
    const key = getTranslationCandidateKey(candidate);
    const starts = [retryRoot, key, candidate.element];
    const visited = new Set<Node>();

    for (const start of starts) {
        if (!start || visited.has(start) || !start.isConnected) continue;
        visited.add(start);
        const fresh = inheritTranslationApplicationShellPolicy(candidate, core.resolve(start));
        if (fresh?.element.isConnected) return fresh;
    }

    if (!candidate.element.isConnected) return null;
    return inheritTranslationApplicationShellPolicy(candidate, core.inspect(candidate.element).candidate);
}

export function rememberUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
    target: HTMLElement,
    state: TranslationState,
): void {
    const source = normalizeComparableText(state.sourceText || candidateLifecycleSource(candidate));
    const remember = (node: Node | null | undefined) => {
        if (node) session.userCancelledCandidates.set(node, source);
    };

    // 精确候选以元素作为 key；合成行内段以首个来源节点作为 key，因此需保留
    // 所有已捕获来源节点，才能跨过 restoreTranslation() 对片段的解包过程。
    remember(getTranslationCandidateKey(candidate));
    if (!candidate.nodes?.length) remember(candidate.element);
    state.sourceTextNodes?.forEach((node) => remember(node));
    state.syntheticSourceNodes?.forEach((node) => remember(node));
    remember(target);
}

export function isUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
): boolean {
    let source: string | undefined;
    const identities = [
        getTranslationCandidateKey(candidate),
        ...(candidate.nodes ?? []),
    ];
    let cancelled = false;
    identities.forEach((identity) => {
        const cancelledSource = session.userCancelledCandidates.get(identity);
        if (cancelledSource === undefined) return;
        source ??= candidateLifecycleSource(candidate);
        if (cancelledSource === source) {
            cancelled = true;
        } else {
            // 宿主复用同一 DOM 节点承载了不同内容，之前的用户取消不能屏蔽新原文。
            session.userCancelledCandidates.delete(identity);
        }
    });
    return cancelled;
}

export function resolveStatefulMutationTarget(element: Element): HTMLElement | false {
    let current: Element | null = element;
    while (current) {
        const htmlCurrent = asHTMLElement(current);
        if (htmlCurrent && getTranslationState(htmlCurrent)) return htmlCurrent;
        current = current.parentElement;
    }
    return false;
}

/**
 * materialize 的 childList 可在延迟 spinner 创建前送达；尚未创建允许零产物，已登记则必须保持唯一归属。
 * 这些真实 childList 记录会在 beginTranslation 之后、异步 provider 仍待完成时送达。
 * 只有本 generation 捕获的精确来源所有权、HTML 和 Text 槽身份都保持完整时才接受；
 * 任何宿主插入（包括伪装成 FluentRead 产物的节点）都必然无法通过至少一项检查，
 * 并继续进入 stale/重启路径。
 */
export function isIntactLoadingSyntheticChildList(
    target: HTMLElement,
    state: TranslationState,
): boolean {
    if (!state.syntheticSegment || !target.matches('[data-fr-translation-segment="true"]')) return false;
    const spinner = state.spinner;
    if (spinner !== undefined && (spinner.parentNode !== target || !spinner.matches('[data-fr-translation-owned="true"]'))) return false;

    const expectedSourceNodes = state.syntheticSourceNodes;
    if (!expectedSourceNodes) return false;
    const currentSourceNodes = Array.from(target.childNodes).filter((node) => node !== spinner);
    if (currentSourceNodes.length !== expectedSourceNodes.length ||
        currentSourceNodes.some((node, index) => node !== expectedSourceNodes[index])) return false;

    const artifacts = Array.from(target.querySelectorAll(TRANSLATION_ARTIFACT_SELECTOR));
    if (artifacts.length !== (spinner === undefined ? 0 : 1) || (spinner !== undefined && artifacts[0] !== spinner)) return false;

    const sourceClone = cloneTranslationElementInert(target, false);
    currentSourceNodes.forEach((node) => sourceClone.appendChild(sourceClone.ownerDocument.importNode(node, true)));
    if (sourceClone.innerHTML !== state.sourceHTML) return false;

    const expectedTextNodes = state.sourceTextNodes ?? [];
    const currentTextNodes = getCurrentTranslationStateTextNodes(target, state);
    return currentTextNodes.length === expectedTextNodes.length &&
        currentTextNodes.every((node, index) => node === expectedTextNodes[index]);
}

export function isOwnTranslationMutation(
    mutation: MutationRecord,
    loadingSyntheticChecks: WeakMap<TranslationState, boolean>,
): boolean {
    const mutationElement = mutationTargetElement(mutation.target);
    // 框架在 hover/render 时会重复写入相同属性。相同值没有来源或展示变化，
    // 不能让一次 setAttribute 事务把控件/仅译文恢复后再从缓存重新渲染。
    // oldValue 为 null 时仍走完整复验，兼容不提供旧值的观察器实现。
    if (mutation.type === 'attributes' && mutationElement && mutation.attributeName &&
        mutation.oldValue !== null &&
        mutation.oldValue === mutationElement.getAttribute(mutation.attributeName)) return true;
    if (mutation.type === 'attributes' && mutationElement && (
        (mutation.attributeName === 'style' && isTranslationLayoutOverrideMutation(mutationElement as HTMLElement)) ||
        (mutation.attributeName === 'class' && consumeOrphanedOwnerClassMutation(mutationElement as HTMLElement)))) return true;
    // 不能用“位于任意插件节点内”作为判断：站点可能直接改写双语 wrapper
    // 的文本，必须让这类 mutation 进入 stale/retranslate 分支。加载/错误节点
    // 没有宿主正文，才可以直接视为插件自身变化。
    if (mutation.type !== 'childList' &&
        isElementNode(mutation.target) &&
        mutation.target.matches('[data-fr-translation-owned="true"]') &&
        !mutation.target.matches('.fluent-read-bilingual-content')) return true;
    const target = mutationElement ? resolveStatefulMutationTarget(mutationElement) : false;
    const state = target ? getTranslationState(target as HTMLElement) : undefined;
    if (!target || !state) return false;
    if (isOwnSyntheticSegmentMarkerMutation(mutation, target, state,
        () => statefulSourceAndTextSlotsAreCurrent(target, state))) return true;
    if (isOwnStateArtifactMutation(mutation, target, state)) return true;
    if (state.phase === 'error') {
        // 失败 UI 是扩展拥有的状态，不是宿主编辑；若缺少此分支，其 class mutation
        // 会恢复并重扫目标，使永久 provider 错误变成自动无限重试。
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'class') {
            return target.getAttribute('class') === state.renderedClassAttribute;
        }
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'style') {
            return target.getAttribute('style') === state.renderedStyleAttribute;
        }
        if (mutation.type === 'childList') {
            return allMutationNodesMatch(mutation, isTranslationArtifact) &&
                mutationElement === target &&
                state.retryWrapper?.parentNode === target;
        }
        return false;
    }
    if (state.phase === 'loading') {
        // 手动重试会在 beginTranslation 创建下一 generation 前立即移除旧失败 class。
        // mutation 异步送达，因此需依据新快照识别这次清理。
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'class') {
            return target.getAttribute('class') === state.originalClassAttribute;
        }
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'style') {
            return target.getAttribute('style') === state.originalStyleAttribute;
        }
        if (mutation.type === 'childList' && mutationElement === target) {
            const cached = loadingSyntheticChecks.get(state);
            if (cached !== undefined) return cached;
            const intact = isIntactLoadingSyntheticChildList(target, state);
            loadingSyntheticChecks.set(state, intact);
            return intact;
        }
        return false;
    }
    if (state.phase !== 'translated') return false;
    if (isOwnSingleTextSlotMove(mutation, target, state)) return true;
    if (state.mode === 'single' && mutation.type === 'characterData') {
        const textNode = mutation.target as Text;
        return state.textSlotsApplied === true &&
            state.translatedTextValues?.get(textNode) === (textNode.nodeValue ?? '');
    }
    if (state.bilingualContent?.isConnected) {
        const wrapper = state.bilingualContent;
        const mutationParent = isElementNode(mutation.target)
            ? mutation.target
            : mutation.target.parentElement;

        // wrapper 内部的变化只有在内容仍等于插件最后写入的快照时才算插件自身；
        // 如果站点脚本改写了译文，必须让后续分支恢复并重新排队。
        if (mutationParent && (mutationParent === wrapper || wrapper.contains(mutationParent))) {
            return wrapper.outerHTML === state.bilingualOuterHTML;
        }

        // 插件会先插入 loading，完成后再移除 loading 并插入译文 wrapper。
        // 这两类 childList mutation 都可能落在宿主节点上；只要所有增删节点
        // 都是扩展 artifact，且插件自己的最终快照仍然存在，就不能触发重译。
        // 若 wrapper 已被宿主移除，则保留 false，让后续逻辑恢复并重新排队。
        if (mutation.type === 'childList' && allMutationNodesMatch(mutation, isTranslationArtifact)) {
            return state.bilingualContent?.parentNode === target &&
                state.bilingualContent.outerHTML === state.bilingualOuterHTML;
        }

        // 双语渲染会临时修改宿主节点的 style；只有值仍是插件记录的值时才忽略。
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'style') {
            return target.getAttribute('style') === state.renderedStyleAttribute;
        }
        if (mutation.type === 'attributes' && mutationElement === target && mutation.attributeName === 'class') {
            return target.getAttribute('class') === state.renderedClassAttribute;
        }
    }
    return isOwnCurrentArtifactAddition(mutation, state);
}
