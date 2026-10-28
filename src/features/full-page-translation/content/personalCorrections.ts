/**
 * @file src/features/full-page-translation/content/personalCorrections.ts
 * 文件职责：把读者主动确认的校订记忆接入安全的网页翻译单元，提供双语编辑、预览及两种显示模式下撤销后的可逆渲染端口。
 * 主要内容：按材料摘要、源目标语言及最近标题构造匹配身份，在 provider 请求前查找精确校订，取消后不将查询失败误作普通降级；以弱映射保留服务底稿，复用活动所有者索引与当前模式重绘端口，失效刷新不继续读取；标题、移动或 SPA 材料变化时以无 IO 观察立即恢复旧语境的个人结果，普通结构变更先有界探查局部索引，避免逐节点枚举全页译文。
 * 模块边界：只处理全文功能内部的 DOM 所有权与公共记忆服务适配，不持久化阅读历史、不改变请求队列、不把个人结果写入供应商缓存；含代码、公式等不能安全拍平的单元不开放编辑。
 */
import {createMaterialId, type CorrectionQuery} from '@/src/core/personal-corrections/public';
import {personalCorrections} from '@/src/services/personal-corrections/public';
import {config} from '@/src/services/config/store';
import {buildWholeBlockTranslationSource, createTranslationSourceSnapshot, getCurrentTranslationCore} from '@/src/core/translation/public';
import {getTranslationOwnersForIndexedNode, getTranslationOwnersWithin, getTranslationState, setBilingualContent, restoreTranslation, subscribeTranslationStateChanges, type TranslationState} from './state';
import {statefulSourceAndTextSlotsAreCurrent, isTranslationArtifactCurrent} from './translationStability';
import {refreshTranslationPresentation} from './displayMode';
import {withFullPageViewportAnchor} from './viewportStability';

export interface PersonalCorrectionSnapshot {
    query: CorrectionQuery;
    recordId?: string;
    recordRevision?: number;
    translation?: string;
    baseline?: readonly string[];
    enableGeneration?: number;
}
export interface PersonalCorrectionPair extends CorrectionQuery {
    translation: string;
    apply(translation: string, recordId?: string): boolean;
    isCurrent(): boolean;
}
const metadata = new WeakMap<TranslationState, PersonalCorrectionSnapshot>();
const metadataOwnerRefs = new Set<WeakRef<HTMLElement>>();
const metadataRefsByOwner = new WeakMap<HTMLElement, WeakRef<HTMLElement>>();
let enableGeneration = 0;
let refreshRevision = 0;
export function isPersonalCorrectionEnabled(): boolean {return config.on === true && config.personalCorrectionsEnabled === true;}

function headingSource(heading: HTMLElement): string {
    const state = getTranslationState(heading);
    if (state && statefulSourceAndTextSlotsAreCurrent(heading, state)) return state.sourceText;
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(artifact => artifact.remove());
    return clone.textContent ?? '';
}

/** 只使用当前单元之前的最近标题；不同指代的章节不会默认为相同上下文。 */
export function readPersonalCorrectionContext(node: HTMLElement): string {
    let cursor: Element | null = node;
    for (let depth = 0; cursor && depth < 20; depth++, cursor = cursor.parentElement) {
        let sibling = cursor.previousElementSibling;
        for (let count = 0; sibling && count < 50; count++, sibling = sibling.previousElementSibling) {
            if (sibling.matches('h1,h2,h3,h4,h5,h6')) return headingSource(sibling as HTMLElement).trim().slice(0, 512);
        }
    }
    return '';
}

export async function lookupPersonalCorrection(node: HTMLElement, source: string, sourceLanguage: string,
    targetLanguage: string, signal?: AbortSignal): Promise<PersonalCorrectionSnapshot | undefined> {
    if (signal?.aborted) throw new DOMException('校订匹配已取消', 'AbortError');
    const href = globalThis.location?.href;
    if (!href || !/^https?:/u.test(href) || import.meta.env.BROWSER === 'userscript' || !isPersonalCorrectionEnabled()) return undefined;
    const generation = enableGeneration;
    const query: CorrectionQuery = {source, sourceLanguage, targetLanguage,
        context: readPersonalCorrectionContext(node), materialId: createMaterialId(href)};
    let match;
    try { match = await personalCorrections.lookup(query); }
    catch {
        if (signal?.aborted) throw new DOMException('校订匹配已取消', 'AbortError');
        return undefined; // 未取消的记忆读取失败不阻断正常翻译。
    }
    if (signal?.aborted) throw new DOMException('校订匹配已取消', 'AbortError');
    if (!isPersonalCorrectionEnabled() || generation !== enableGeneration) return undefined;
    return {query, enableGeneration: generation, ...(match.exact ? {recordId: match.exact.id, recordRevision: match.exact.revision, translation: match.exact.translation} : {})};
}

export async function personalCorrectionIsCurrent(snapshot?: PersonalCorrectionSnapshot, node?: HTMLElement): Promise<boolean> {
    if (import.meta.env.BROWSER === 'userscript') return true;
    if (!snapshot?.recordId) return true;
    if (!isPersonalCorrectionEnabled() || (snapshot.enableGeneration !== undefined && snapshot.enableGeneration !== enableGeneration)) return false;
    try {
        const {exact} = await personalCorrections.lookup(snapshot.query);
        return isPersonalCorrectionEnabled() && (snapshot.enableGeneration === undefined || snapshot.enableGeneration === enableGeneration)
            && exact?.id === snapshot.recordId && exact.revision === snapshot.recordRevision
            && (!node || snapshot.query.materialId === createMaterialId(globalThis.location.href)
                && snapshot.query.context === readPersonalCorrectionContext(node));
    } catch { return false; }
}

export function registerPersonalCorrectionResult(node: HTMLElement, state: TranslationState,
    snapshot: PersonalCorrectionSnapshot | undefined): void {
    if (import.meta.env.BROWSER === 'userscript' || !isPersonalCorrectionEnabled()) return;
    if (!snapshot || (snapshot.enableGeneration !== undefined && snapshot.enableGeneration !== enableGeneration)) return;
    metadata.set(state, snapshot);
    let reference = metadataRefsByOwner.get(node);
    if (!reference) {
        reference = new WeakRef(node);
        metadataRefsByOwner.set(node, reference);
    }
    metadataOwnerRefs.add(reference);
    if (state.bilingualReplay) state.bilingualReplay.personalCorrectionId = snapshot.recordId;
    const content = state.bilingualContent;
    if (content) {
        if (snapshot.recordId) content.setAttribute('data-fr-personal-correction', 'true');
        else content.removeAttribute('data-fr-personal-correction');
        setBilingualContent(node, content, state.bilingualReplay);
    }
}

function ownsPair(node: HTMLElement, state: TranslationState, snapshot: PersonalCorrectionSnapshot): boolean {
    return getTranslationState(node) === state && node.isConnected
        && metadata.get(state) === snapshot && isTranslationArtifactCurrent(node, state)
        && statefulSourceAndTextSlotsAreCurrent(node, state);
}
function currentPair(node: HTMLElement, state: TranslationState, snapshot: PersonalCorrectionSnapshot): boolean {
    return isPersonalCorrectionEnabled() && (snapshot.enableGeneration === undefined || snapshot.enableGeneration === enableGeneration)
        && ownsPair(node, state, snapshot) && snapshot.query.materialId === createMaterialId(globalThis.location.href)
        && snapshot.query.context === readPersonalCorrectionContext(node);
}

/** 活动状态是两种显示模式共同的归属入口，不依赖某种译文工件仍存在于 DOM。 */
function* correctionOwners(root: Node = document) {
    for (const node of getTranslationOwnersWithin(root)) {
        const state = getTranslationState(node)!;
        const snapshot = metadata.get(state);
        if (snapshot) yield {node, state, snapshot};
    }
}

function isWithinComposedRoot(root: Node, owner: HTMLElement): boolean {
    for (let ancestor: Node | null = owner; ancestor; ancestor = ancestor.parentNode ?? (ancestor as ShadowRoot).host ?? null) {
        if (ancestor === root) return true;
    }
    return false;
}

/** 宿主可以把已有 owner 移入 closed 根；每批次按当前根筛选一次，弱引用不延长 owner 或 metadata 生命周期。 */
function closedCorrectionOwners(): HTMLElement[] {
    const owners: HTMLElement[] = [];
    for (const reference of metadataOwnerRefs) {
        const owner = reference.deref();
        if (!owner || !metadata.has(getTranslationState(owner)!)) {metadataOwnerRefs.delete(reference); continue;}
        let root = owner.getRootNode();
        while (root.nodeType === 11 && (root as ShadowRoot).host) {
            const shadow = root as ShadowRoot;
            if (shadow.mode === 'closed') {owners.push(owner); break;}
            root = shadow.host.getRootNode();
        }
    }
    return owners;
}

/** 小变更只探查已有节点索引；大子树至多读取 64 个节点后沿用活动 owner 判断，不展开全部宿主 DOM。 */
function hasCorrectionOwnerWithin(root: Node, readClosedOwners: () => readonly HTMLElement[]): boolean {
    const stack = [root];
    let visited = 0;
    while (stack.length) {
        if (visited++ === 64) return !correctionOwners(root).next().done;
        const node = stack.pop()!;
        const ownsCorrection = getTranslationOwnersForIndexedNode(node).some(owner => {
            // 索引也登记布局祖先；仅有祖先租约不能把另一分支的个人译文判为本子树所有。
            return metadata.has(getTranslationState(owner)!) && isWithinComposedRoot(root, owner);
        });
        if (ownsCorrection) return true;
        const sibling = node !== root ? node.nextSibling : null;
        if (sibling) stack.push(sibling);
        if (node.firstChild) stack.push(node.firstChild);
        const shadow = node.nodeType === 1 ? (node as Element).shadowRoot : null;
        if (shadow) stack.push(shadow);
    }
    return readClosedOwners().some(owner => isWithinComposedRoot(root, owner));
}

function applyCorrection(node: HTMLElement, state: TranslationState, snapshot: PersonalCorrectionSnapshot,
    translation: string, recordId?: string): boolean {
    if (!translation.trim() || !currentPair(node, state, snapshot)) return false;
    const replay = state.bilingualReplay!;
    replay.translations = replay.sources.map((_, index) => index === 0 ? translation : '');
    replay.personalCorrectionId = recordId;
    return withFullPageViewportAnchor(() => refreshTranslationPresentation(node, state), [node]);
}

/** 语境或材料变化使旧个人结果立即失效；旧服务底稿也属于旧语境，此时恢复原文。 */
export function invalidateStalePersonalCorrectionContexts(): void {
    for (const {node, state, snapshot} of correctionOwners()) {
        if (state.bilingualReplay?.personalCorrectionId && ownsPair(node, state, snapshot) && !currentPair(node, state, snapshot)) {
            withFullPageViewportAnchor(() => restoreTranslation(node), [node]);
        }
    }
}

/** 只对标题或包含个人单元的宿主结构变化做无 IO 失效检查，不订阅阅读文字或请求翻译。 */
export function watchPersonalCorrectionContext(signal: AbortSignal): () => void {
    if (signal.aborted) return () => {};
    const headings = 'h1,h2,h3,h4,h5,h6';
    const observer = new MutationObserver(mutations => {
        let closedOwners: readonly HTMLElement[] | undefined;
        const readClosedOwners = () => closedOwners ??= closedCorrectionOwners();
        const relevant = mutations.some(mutation => {
            const target = mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement;
            if (target?.closest('[data-fr-translation-owned="true"]')) return false;
            if (target?.closest(headings)) return true;
            return mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].some(node => {
                if (node.nodeType !== 1) return false;
                const element = node as Element;
                if (element.matches('[data-fr-translation-owned="true"]')) return false;
                return element.matches(headings) || Boolean(element.querySelector(headings)) || hasCorrectionOwnerWithin(element, readClosedOwners);
            });
        });
        if (relevant) invalidateStalePersonalCorrectionContexts();
    });
    observer.observe(document, {subtree: true, childList: true, characterData: true});
    const unsubscribeStates = subscribeTranslationStateChanges((node, state) => {
        if (state && metadata.has(state)) return;
        const reference = metadataRefsByOwner.get(node);
        if (reference) metadataOwnerRefs.delete(reference);
    });
    document.addEventListener('fluentread-route-change', invalidateStalePersonalCorrectionContexts);
    const dispose = () => {
        observer.disconnect();
        unsubscribeStates();
        document.removeEventListener('fluentread-route-change', invalidateStalePersonalCorrectionContexts);
        signal.removeEventListener('abort', dispose);
    };
    signal.addEventListener('abort', dispose, {once: true});
    return dispose;
}

export function readPersonalCorrectionPair(element: Element): PersonalCorrectionPair | null {
    if (!isPersonalCorrectionEnabled()) return null;
    const content = element.closest<HTMLElement>('.fluent-read-bilingual-content');
    const node = content?.parentElement;
    const state = node ? getTranslationState(node) : undefined;
    let snapshot = state ? metadata.get(state) : undefined;
    if (!snapshot && node && state?.bilingualReplay?.sourceLanguage && state.phase === 'translated'
        && state.mode === 'bilingual' && state.kind === 'content' && isTranslationArtifactCurrent(node, state)
        && statefulSourceAndTextSlotsAreCurrent(node, state) && /^https?:/u.test(globalThis.location.href)) {
        // 开启后允许校订已经显示的服务译文；沿用该次请求语言，只准备当前指向段落，不查询记忆或重译整页。
        const core = getCurrentTranslationCore(state.scope);
        const skeleton = createTranslationSourceSnapshot(node, core.shouldStayOriginal, state.syntheticSegment ? node : undefined,
            {protectedElement: node, ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {})}, core.shouldOmitFromTranslation);
        const replay = state.bilingualReplay;
        const source = skeleton.slots.length === replay.sources.length && skeleton.slots.every((slot, index) => slot.source === replay.sources[index])
            ? replay.sources.length === 1 && !skeleton.clone.firstElementChild ? replay.sources[0]
                : buildWholeBlockTranslationSource(skeleton, {preserveNewlines: typeof getComputedStyle === 'function' && /^(?:pre|break-spaces)/u.test(getComputedStyle(node).whiteSpace)}) : null;
        if (source) {
            snapshot = {query: {source, sourceLanguage: replay.sourceLanguage!, targetLanguage: replay.targetLanguage,
                context: readPersonalCorrectionContext(node), materialId: createMaterialId(globalThis.location.href)},
                baseline: [...replay.translations], enableGeneration};
            registerPersonalCorrectionResult(node, state, snapshot);
        }
    }
    if (!node || !state?.bilingualReplay || !snapshot || !currentPair(node, state, snapshot)) return null;
    const isCurrent = () => currentPair(node, state, snapshot);
    return {...snapshot.query, translation: state.bilingualReplay.translations.join(''), isCurrent,
        apply: (translation, recordId) => applyCorrection(node, state, snapshot, translation, recordId)};
}

export function listVisiblePersonalCorrectionPairs(query: CorrectionQuery): PersonalCorrectionPair[] {
    const pairs: PersonalCorrectionPair[] = [];
    for (const element of document.querySelectorAll('.fluent-read-bilingual-content')) {
        const pair = readPersonalCorrectionPair(element);
        if (pair && pair.source === query.source && pair.sourceLanguage === query.sourceLanguage
            && pair.targetLanguage === query.targetLanguage && pair.context === query.context
            && pair.materialId === query.materialId) pairs.push(pair);
    }
    return pairs;
}

/** 关闭时取消旧启用代次，保留持久记忆；只恢复仍由本功能拥有的个人结果。 */
export function disableVisiblePersonalCorrections(): void {
    enableGeneration += 1;
    refreshRevision += 1;
    for (const {node, state, snapshot} of correctionOwners()) {
        if (!ownsPair(node, state, snapshot)) {
            // 宿主已经改写的内容保持宿主权威，但旧个人底稿不得在后续骨架修复时重新采用。
            if (state.bilingualReplay?.personalCorrectionId) {
                state.bilingualReplay.personalCorrectionId = undefined;
                if (snapshot.baseline) state.bilingualReplay.translations = [...snapshot.baseline];
                else state.bilingualReplay = undefined;
            }
            metadata.delete(state);
            continue;
        }
        if (state.bilingualReplay?.personalCorrectionId) {
            if (snapshot.baseline && snapshot.query.materialId === createMaterialId(globalThis.location.href)
                && snapshot.query.context === readPersonalCorrectionContext(node)) {
                state.bilingualReplay.translations = [...snapshot.baseline];
                state.bilingualReplay.personalCorrectionId = undefined;
                withFullPageViewportAnchor(() => refreshTranslationPresentation(node, state), [node]);
            } else withFullPageViewportAnchor(() => restoreTranslation(node), [node]);
        }
        metadata.delete(state);
    }
    metadataOwnerRefs.clear();
}
/** 修改或删除后即时回滚可见个人译文；没有服务底稿的重用单元恢复原文，留给现有翻译入口重译。 */
export async function refreshVisiblePersonalCorrections(): Promise<void> {
    if (!isPersonalCorrectionEnabled()) {disableVisiblePersonalCorrections(); return;}
    const revision = ++refreshRevision;
    invalidateStalePersonalCorrectionContexts();
    for (const {node, state, snapshot} of correctionOwners()) {
        if (!currentPair(node, state, snapshot)) continue;
        let match;
        try { match = await personalCorrections.lookup(snapshot.query); }
        catch { if (revision !== refreshRevision) return; continue; }
        if (revision !== refreshRevision) return;
        if (!isPersonalCorrectionEnabled()) {disableVisiblePersonalCorrections(); return;}
        if (!currentPair(node, state, snapshot)) continue;
        if (match.exact) {
            applyCorrection(node, state, snapshot, match.exact.translation, match.exact.id);
        } else if (state.bilingualReplay?.personalCorrectionId) {
            if (snapshot.baseline) {
                state.bilingualReplay.translations = [...snapshot.baseline];
                state.bilingualReplay.personalCorrectionId = undefined;
                withFullPageViewportAnchor(() => refreshTranslationPresentation(node, state), [node]);
            } else withFullPageViewportAnchor(() => restoreTranslation(node), [node]);
        }
    }
}
