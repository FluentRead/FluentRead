/**
 * @file src/features/full-page-translation/content/sectionTranslation.ts
 * 文件职责：把全文翻译引擎限定在用户点选或划选的网页区域内执行，负责多区域候选去重、译文状态盘点、按阅读位置排序的批量翻译，以及只恢复所选区域的原文。
 * 主要内容：导出区域盘点、手动切换与只补齐未译内容的自动翻译接口；按译文所有者索引发现待翻译、失败与需切换方案的段落，冻结局部快捷方案请求配置；预览按步数限流，完整发现和阅读位置测量按时间片推进，以有界在途数接入共享翻译队列；区域再次确认、入口卸载或全页恢复时取消精确的在途请求，保留已提交译文，并按请求身份和原文快照记住无需翻译的候选。
 * 模块边界：本文件只编排区域级调用，按旧状态重建候选时保留自动外壳策略来源；单个候选的请求、渲染、状态机和全文会话协作全部复用 runtime 的 translateTarget 与 restoreTranslationOwner；不监听手势、不绘制高亮，也不决定提示文案。
 */
import {checkConfig} from '@/src/features/full-page-translation/content/configCheck';
import {
    getComposedParent,
    getCurrentTranslationCore,
    getTranslationCandidateKey,
    getTranslatableControlValueAttribute,
    maxComposedAncestorDepth,
    selectPreferredTranslationCandidate,
    type TranslationCandidate,
    type TranslationScope,
} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {normalizeMaxConcurrentTranslations} from '@/src/core/config/model';
import {restoreTranslationOwner, translateTarget, type TranslationTargetOutcome} from './runtime';
import {getTranslationOwnersWithin, getTranslationState, resolveTranslationStateNode, subscribeTranslationStateChanges, type TranslationState} from './state';
import {getHoverTranslationRequestSession} from './requestSession';
import {
    captureFullPageTranslationConfig,
    getTranslationInvocationIdentity,
    type FullPageTranslationConfigSnapshot,
    type PageTranslationConfigOverrides,
} from './translationRequest';

/** 悬停预览只盘点有限的 DOM 步数，整页级容器也不会在移动鼠标时卡顿；点击时再完整盘点。 */
export const SECTION_PREVIEW_DISCOVERY_STEPS = 4000;

/** 单个生成器步仍由候选核心保证安全；区域层在最多 200 步或 8ms 后让出事件循环。 */
const SECTION_WORK_SLICE_STEPS = 200;
const SECTION_WORK_SLICE_MS = 8;

/**
 * - translate：区域内还有待翻译段落；
 * - restore：区域内段落都已翻译或正在翻译，点击恢复原文；
 * - settled：区域内段落都已确认无需翻译（例如已是目标语言）；
 * - empty：区域内没有可翻译的文字。
 */
export type TranslationSectionAction = 'translate' | 'restore' | 'settled' | 'empty';

export interface TranslationSectionSummary {
    /** 区域内发现的候选段落数；预算耗尽时为下限。 */
    readonly total: number;
    /** 已翻译或正在翻译的段落数。 */
    readonly active: number;
    /** 仍待翻译的段落数；已确认无需翻译的段落不计入。 */
    readonly pending: number;
    /** 发现步数超过预算，total、active 与 pending 都只是下限。 */
    readonly truncated: boolean;
    readonly action: TranslationSectionAction;
}

export interface TranslationSectionResult {
    /** blocked 表示翻译前的配置检查未通过，检查本身已向页面提示原因。 */
    readonly action: 'translated' | 'restored' | 'settled' | 'empty' | 'blocked' | 'cancelled';
    readonly translated: number;
    readonly failed: number;
    /** 已是目标语言或没有有效文字、因此未发出请求的段落数。 */
    readonly unchanged: number;
    readonly restored: number;
}

interface SectionDiscovery {
    candidates: TranslationCandidate[];
    truncated: boolean;
}

/** 已确认无需翻译的候选及当时的原文快照；原文变化后快照不再相等，记忆自动失效。 */
const settledCandidates = new WeakMap<Node, {text: string; identity: string}>();

interface SectionOperation {
    roots: readonly Element[];
    controller: AbortController;
    identity: string;
    planned: number;
    active: number;
    discovering: boolean;
    restoredOnCancel: number;
    attempts: Map<HTMLElement, TranslationState>;
    expectedStates: Map<TranslationCandidate, TranslationState | undefined>;
    changedSourceKeys: WeakSet<Node>;
    allowedAncestors: Set<TranslationCandidate>;
    isCurrent(): boolean;
}

/** 以真实区域节点隔离正在扫描或派发的操作；旧操作收尾不得清除后来接管的操作。 */
const sectionOperations = new WeakMap<Element, SectionOperation>();
/** 自动补齐不能打断父子区域中已确认的操作；只保留当前在途实例，完成即移除。 */
const activeSectionOperations = new Set<SectionOperation>();

function isWithinSection(root: Element, node: Node): boolean {
    let current: Node | null = node;
    for (let depth = 0; current && depth <= maxComposedAncestorDepth; depth += 1) {
        if (current === root) return true;
        current = getComposedParent(current as Element);
    }
    return false;
}

/** 单个区域保持原有调用方式；多区域去掉重复与已由所选祖先完整覆盖的节点。 */
function sectionRoots(selection: Element | readonly Element[]): readonly Element[] {
    const roots = [...new Set(Array.isArray(selection) ? selection as Element[] : [selection as Element])];
    if (roots.length < 2) return roots;
    const selected = new Set(roots);
    return roots.filter(root => {
        let current: Element | null = getComposedParent(root);
        for (let depth = 1; current && depth <= maxComposedAncestorDepth; depth += 1) {
            if (current !== root && selected.has(current)) return false;
            current = getComposedParent(current);
        }
        return true;
    });
}

function sameSelection(roots: readonly Element[], operation: SectionOperation): boolean {
    return roots.length === operation.roots.length && roots.every(root => operation.roots.includes(root));
}

/** 延迟派发只接受当前仍在点选区域内的来源；仅显式的既有祖先 owner 可扩大到原文整段。 */
function isCandidateWithinSection(candidate: TranslationCandidate, operation: SectionOperation): boolean {
    return operation.roots.some(root => {
        const boundary = operation.allowedAncestors.has(candidate) && isWithinSection(candidate.element, root)
            ? candidate.element : root;
        return isWithinSection(boundary, candidate.element)
            && !candidate.nodes?.some(node => !isWithinSection(boundary, node));
    });
}

function rememberPending(operation: SectionOperation | undefined, candidate: TranslationCandidate,
    state: TranslationState | undefined): void {
    if (!operation) return;
    operation.expectedStates.set(candidate, state);
    // 有状态的新错误/方案属于当前合法快照；恢复到无状态的来源保留后来接管标记。
    if (state) operation.changedSourceKeys.delete(getTranslationCandidateKey(candidate));
}

function candidateSnapshot(candidate: TranslationCandidate): string {
    // 按钮型 input 的来源是 value 属性；textContent 为空不能识别宿主改写其标签。
    const attribute = candidate.kind === 'control' && getTranslatableControlValueAttribute(candidate.element);
    if (attribute) return candidate.element.getAttribute(attribute) ?? '';
    // join 会把 null 视为空串，无需逐个兜底。
    return (candidate.nodes?.length ? candidate.nodes : [candidate.element]).map((node) => node.textContent).join('');
}

/**
 * 正文范围会把 header/footer/nav/aside 当作页面框架整体跳过；用户显式点选这些区域时，
 * 说明它们就是想读的内容，因此改用全部节点范围。
 */
function resolveSectionScope(root: Element): TranslationScope {
    if (config.translationScope === 'all') return 'all';
    return getCurrentTranslationCore('content').isWithinStructuralRegion(root) ? 'all' : 'content';
}

function* discoverInScope(root: Element, scope: TranslationScope, maxSteps: number): Generator<void, SectionDiscovery> {
    const unique = new Map<Node, TranslationCandidate>();
    let steps = 0;
    for (const step of getCurrentTranslationCore(scope).discoverSteps(root)) {
        steps += 1;
        if (steps > maxSteps) return {candidates: [...unique.values()], truncated: true};
        if (step.candidate) {
            const key = getTranslationCandidateKey(step.candidate);
            unique.set(key, selectPreferredTranslationCandidate(unique.get(key), step.candidate));
        }
        yield;
    }
    return {candidates: [...unique.values()], truncated: false};
}

function* discoverSectionCandidates(root: Element, maxSteps: number): Generator<void, SectionDiscovery> {
    const scope = resolveSectionScope(root);
    const discovery = yield* discoverInScope(root, scope, maxSteps);
    // 站点规则只放行指定目标、或区域内全是界面控件时，正文范围可能一无所获；
    // 用户已经明确点选了这块区域，此时改用全部节点范围，安全守卫仍然生效。
    if (discovery.candidates.length > 0 || discovery.truncated || scope === 'all') return discovery;
    return yield* discoverInScope(root, 'all', maxSteps);
}

function finishSynchronousWork<T>(work: Generator<void, T>): T {
    let next = work.next();
    while (!next.done) next = work.next();
    return next.value;
}

/** 小区域在首个 await 前发现并派发；大区域等待期间，abort 同时移除 timer 和监听器。 */
function runSectionWork<T>(work: Generator<void, T>, operation: SectionOperation): T | Promise<T | undefined> | undefined {
    const consume = (): IteratorResult<void, T> | undefined => {
        const startedAt = performance.now();
        for (let steps = 0; steps < SECTION_WORK_SLICE_STEPS; steps += 1) {
            if (!operation.isCurrent()) { operation.controller.abort(); return undefined; }
            const next = work.next();
            if (next.done || performance.now() - startedAt >= SECTION_WORK_SLICE_MS) return next;
        }
        return {done: false, value: undefined};
    };
    const first = consume();
    if (!first || first.done) return first?.value;
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: T | undefined): void => {
            if (timer !== undefined) clearTimeout(timer);
            operation.controller.signal.removeEventListener('abort', cancelled);
            resolve(value);
        };
        const cancelled = (): void => finish(undefined);
        const advance = (): void => {
            timer = undefined;
            try {
                const next = consume();
                if (!next || next.done) finish(next?.value);
                else timer = setTimeout(advance, 0);
            } catch (error) {
                operation.controller.signal.removeEventListener('abort', cancelled);
                reject(error);
            }
        };
        operation.controller.signal.addEventListener('abort', cancelled, {once: true});
        timer = setTimeout(advance, 0);
    });
}

function isSettled(candidate: TranslationCandidate, identity: () => string): boolean {
    const settled = settledCandidates.get(getTranslationCandidateKey(candidate));
    return Boolean(settled && settled.text === candidateSnapshot(candidate) && settled.identity === identity());
}

/** 失败或切换方案时按所有者状态重建候选；合成行内段沿用首个来源文本节点定位。 */
function translationOwnerCandidate(owner: HTMLElement): TranslationCandidate {
    const state = getTranslationState(owner)!;
    return {
        element: owner,
        kind: state.kind,
        reason: 'section-retry',
        ...(state.scope ? {scope: state.scope} : {}),
        ...(state.syntheticSegment && state.sourceTextNodes?.length ? {nodes: state.sourceTextNodes} : {}),
        ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {}),
        ...(state.applicationShellPolicyId ? {applicationShellPolicyId: state.applicationShellPolicyId} : {}),
    };
}

/** 点选范围落在一个已翻译的更大段落内部时，该段落就是这块区域的译文所有者。 */
function findActiveAncestorOwner(root: Element): HTMLElement | null {
    for (let current = getComposedParent(root); current; current = getComposedParent(current)) {
        const phase = getTranslationState(current as HTMLElement)?.phase;
        if (phase === 'loading' || phase === 'translated') return current as HTMLElement;
    }
    return null;
}

function resolveSectionAction(total: number, active: number, pending: number): TranslationSectionAction {
    if (pending > 0) return 'translate';
    if (active > 0) return 'restore';
    return total > 0 ? 'settled' : 'empty';
}

function* summarize(roots: readonly Element[], maxSteps: number, snapshot: () => FullPageTranslationConfigSnapshot,
    compareInvocation: boolean, operation?: SectionOperation, ensureOnly = false): Generator<void, {summary: TranslationSectionSummary; pending: TranslationCandidate[]}> {
    // 新候选和默认恢复不比较请求身份；避免每次预览都归一化、散列整份词库。
    let identity: string | undefined;
    const invocationIdentity = (): string => identity ??= getTranslationInvocationIdentity(snapshot());
    const needsProfileSwitch = (owner: HTMLElement): boolean => !ensureOnly && compareInvocation
        && getTranslationState(owner)?.translationInvocationIdentity !== invocationIdentity();
    const activeOwners = new Set<Node>();
    const pending = new Map<Node, TranslationCandidate>();
    const settledOwners = new Set<Node>();
    let truncated = false;
    for (const root of roots) {
        const ancestor = findActiveAncestorOwner(root);
        if (ancestor) {
            if (needsProfileSwitch(ancestor)) {
                const candidate = translationOwnerCandidate(ancestor);
                operation?.allowedAncestors.add(candidate);
                rememberPending(operation, candidate, getTranslationState(ancestor));
                pending.set(ancestor, candidate);
            } else {
                activeOwners.add(ancestor);
            }
            yield;
            continue;
        }
        // Step 1: 从译文所有者索引盘点区域内已有译文；失败段落直接作为待重试项。
        for (const owner of getTranslationOwnersWithin(root)) {
            const state = getTranslationState(owner);
            // 所有者列表是本轮快照；让帧期间恢复的节点已失去状态，不能重建旧请求。
            if (state) {
                if (ensureOnly && state.phase === 'error') {
                    settledOwners.add(owner);
                } else if (state.phase === 'error' || needsProfileSwitch(owner)) {
                    const candidate = translationOwnerCandidate(owner);
                    pending.set(owner, candidate);
                    rememberPending(operation, candidate, state);
                } else activeOwners.add(owner);
            }
            yield;
        }
        // Step 2: 候选发现补齐尚未翻译的段落，并跳过已由所有者覆盖或已确认无需翻译的候选。
        const discovery = yield* discoverSectionCandidates(root, Math.max(1, Math.floor(maxSteps / roots.length)));
        truncated ||= discovery.truncated;
        const {candidates} = discovery;
        for (const candidate of candidates) {
            const owner = resolveTranslationStateNode(candidate);
            if (!owner || (!activeOwners.has(owner) && !pending.has(owner) && !settledOwners.has(owner))) {
                // 自动补齐不循环重试失败段落，错误保留给页面上的显式重试入口。
                if (ensureOnly && owner && getTranslationState(owner)?.phase === 'error') settledOwners.add(owner);
                else if (isSettled(candidate, invocationIdentity)) settledOwners.add(getTranslationCandidateKey(candidate));
                else {
                    pending.set(owner ?? getTranslationCandidateKey(candidate), candidate);
                    rememberPending(operation, candidate, owner ? getTranslationState(owner) : undefined);
                }
            }
            yield;
        }
    }
    const active = activeOwners.size;
    const total = active + pending.size + settledOwners.size;
    // 预算耗尽时剩余部分未知：没有看到任何段落也不能断言“没有文字”，先按翻译提示。
    const action = truncated && total === 0 ? 'translate' : resolveSectionAction(total, active, pending.size);
    return {summary: {total, active, pending: pending.size, truncated, action}, pending: [...pending.values()]};
}

/** 盘点区域状态，供选择模式的标签显示“翻译/恢复原文/无需翻译”及段落数。 */
export function inspectTranslationSection(
    selection: Element | readonly Element[],
    maxSteps: number = SECTION_PREVIEW_DISCOVERY_STEPS,
    overrides?: PageTranslationConfigOverrides,
): TranslationSectionSummary {
    const roots = sectionRoots(selection);
    const operation = roots.length ? sectionOperations.get(roots[0]) : undefined;
    if (operation?.isCurrent() && sameSelection(roots, operation) && (!overrides || operation.identity === getTranslationInvocationIdentity(captureFullPageTranslationConfig(overrides)))) {
        // 未派发项同样属于这次已确认的区域操作；再次确认的标签和实际取消/恢复保持一致。
        return {total: operation.planned, active: operation.active, pending: 0, truncated: operation.discovering, action: 'restore'};
    }
    return finishSynchronousWork(summarize(roots, maxSteps, () => captureFullPageTranslationConfig(overrides), Boolean(overrides))).summary;
}

/** 视口内的段落先翻译，其次是下方即将读到的内容，最后才是已经滚过的上方内容。 */
function* orderByReadingPosition(candidates: readonly TranslationCandidate[]): Generator<void, TranslationCandidate[]> {
    const viewportHeight = window.innerHeight;
    const measurements = new Map<Element, DOMRect>();
    const ranked = [];
    for (const [index, candidate] of candidates.entries()) {
        let rect = measurements.get(candidate.element);
        if (!rect) { rect = candidate.element.getBoundingClientRect(); measurements.set(candidate.element, rect); }
        const band = rect.bottom <= 0 ? 2 : rect.top >= viewportHeight ? 1 : 0;
        ranked.push({candidate, index, band, distance: band === 2 ? -rect.bottom : rect.top});
        yield;
    }
    return ranked
        .sort((left, right) => left.band - right.band || left.distance - right.distance || left.index - right.index)
        .map(({candidate}) => candidate);
}

const EMPTY_TALLY = {translated: 0, failed: 0, unchanged: 0, restored: 0} as const;

function translatePendingCandidates(pending: readonly TranslationCandidate[],
    translationConfig: FullPageTranslationConfigSnapshot, operation: SectionOperation): Promise<TranslationSectionResult> {
    if (!checkConfig(translationConfig)) return Promise.resolve({action: 'blocked', ...EMPTY_TALLY});
    return new Promise((resolve, reject) => {
        const tally = {translated: 0, failed: 0, unchanged: 0, restored: 0};
        let cursor = 0, inFlight = 0, finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (action: 'translated' | 'cancelled'): void => {
            if (finished) return;
            finished = true;
            if (timer !== undefined) clearTimeout(timer);
            operation.controller.signal.removeEventListener('abort', cancelled);
            resolve({action, ...tally, restored: operation.restoredOnCancel});
        };
        const cancelled = (): void => finish('cancelled');
        const schedule = (): void => {
            if (!finished && timer === undefined) timer = setTimeout(() => {
                try { dispatch(); }
                catch (error) { reject(error); operation.controller.abort(); }
            }, 0);
        };
        const dispatch = (): void => {
            timer = undefined;
            if (!operation.isCurrent()) { operation.controller.abort(); finish('cancelled'); return; }
            const startedAt = performance.now();
            const startCursor = cursor;
            const maxConcurrent = normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations);
            while (cursor < pending.length && inFlight < maxConcurrent) {
                if (cursor > startCursor && performance.now() - startedAt >= SECTION_WORK_SLICE_MS) break;
                const candidate = pending[cursor++];
                const previousOwner = resolveTranslationStateNode(candidate);
                const previousState = previousOwner ? getTranslationState(previousOwner) : undefined;
                // 让帧期间被悬浮/另一方案接管或恢复的候选，不得由旧区域计划再次切换。
                if (!isCandidateWithinSection(candidate, operation) || previousState !== operation.expectedStates.get(candidate)
                    || operation.changedSourceKeys.has(getTranslationCandidateKey(candidate))) continue;
                const source = candidateSnapshot(candidate);
                inFlight += 1;
                const request = translateTarget(candidate, translationConfig.displayMode, false, undefined,
                    translationConfig, previousState?.phase === 'error');
                const owner = resolveTranslationStateNode(candidate);
                const state = owner ? getTranslationState(owner) : undefined;
                if (owner && state?.phase === 'loading' && state !== previousState) operation.attempts.set(owner, state);
                const complete = (outcome: TranslationTargetOutcome): void => {
                    if (owner && operation.attempts.get(owner) === state) operation.attempts.delete(owner);
                    inFlight -= 1;
                    if (!operation.isCurrent()) { operation.controller.abort(); finish('cancelled'); return; }
                    if (outcome.status === 'committed') tally.translated += 1;
                    else if (outcome.status === 'failed') tally.failed += 1;
                    else if (outcome.status === 'unchanged' || outcome.status === 'empty') {
                        tally.unchanged += 1;
                        settledCandidates.set(getTranslationCandidateKey(candidate), {text: source, identity: operation.identity});
                    }
                    if (cursor >= pending.length && inFlight === 0) finish('translated');
                    else schedule();
                };
                void request.then(complete, () => complete({status: 'failed'}));
            }
            if (cursor >= pending.length && inFlight === 0) finish('translated');
            else if (cursor < pending.length && inFlight < maxConcurrent) schedule();
        };
        operation.controller.signal.addEventListener('abort', cancelled, {once: true});
        dispatch();
    });
}

function restoreSection(roots: readonly Element[]): number {
    const owners = new Set<HTMLElement>();
    for (const root of roots) {
        getTranslationOwnersWithin(root).forEach(owner => owners.add(owner));
        const ancestor = findActiveAncestorOwner(root);
        if (ancestor) owners.add(ancestor);
    }
    let restored = 0;
    owners.forEach((owner) => {
        if (restoreTranslationOwner(owner)) restored += 1;
    });
    return restored;
}

/**
 * 对点选区域执行一次“翻译或恢复原文”：区域内还有待翻译段落就翻译它们（失败段落一并重试），
 * 否则恢复区域内的全部译文。点击时完整盘点，不受悬停预览的步数预算影响。
 */
export function toggleTranslationSection(selection: Element | readonly Element[], overrides?: PageTranslationConfigOverrides,
    signal?: AbortSignal): Promise<TranslationSectionResult> {
    return runTranslationSection(selection, overrides, signal, false);
}

/**
 * 自动规则只补齐区域内的新内容，保持现有译文、在途请求与手动选择的方案。
 * 失败段落仍显示原有重试入口，不由页面变更驱动无限重试；父子区域正在执行时本次让位。
 */
export function ensureTranslationSection(selection: Element | readonly Element[], overrides?: PageTranslationConfigOverrides,
    signal?: AbortSignal): Promise<TranslationSectionResult> {
    return runTranslationSection(selection, overrides, signal, true);
}

async function runTranslationSection(selection: Element | readonly Element[], overrides: PageTranslationConfigOverrides | undefined,
    signal: AbortSignal | undefined, ensureOnly: boolean): Promise<TranslationSectionResult> {
    const roots = sectionRoots(selection);
    if (signal?.aborted || roots.some(root => root.isConnected === false)) return {action: 'cancelled', ...EMPTY_TALLY};
    if (ensureOnly && [...activeSectionOperations].some(operation => operation.isCurrent() && roots.some(root =>
        operation.roots.some(other => isWithinSection(root, other) || isWithinSection(other, root))))) {
        return {action: 'cancelled', ...EMPTY_TALLY};
    }
    const snapshot = captureFullPageTranslationConfig(overrides);
    const identity = getTranslationInvocationIdentity(snapshot);
    const previousOperations = new Set(roots.map(root => sectionOperations.get(root)));
    for (const previous of previousOperations) {
        if (previous?.isCurrent()) {
            previous.controller.abort();
            if (sameSelection(roots, previous) && (!overrides || previous.identity === identity)) {
                return {action: 'restored', ...EMPTY_TALLY, restored: previous.restoredOnCancel + restoreSection(roots)};
            }
        }
    }
    const requestSession = getHoverTranslationRequestSession();
    const generation = requestSession.renderCommitGeneration;
    const operation: SectionOperation = {roots, controller: new AbortController(), identity, planned: 0, active: 0, discovering: true,
        restoredOnCancel: 0, attempts: new Map(), expectedStates: new Map(), changedSourceKeys: new WeakSet(),
        allowedAncestors: new Set(),
        isCurrent: () => !operation.controller.signal.aborted && roots.every(root => root.isConnected !== false) && !requestSession.requestSignal.aborted
            && requestSession === getHoverTranslationRequestSession() && requestSession.renderCommitGeneration === generation};
    const cancel = (): void => operation.controller.abort();
    const cleanupAttempts = (): void => {
        for (const [owner, state] of operation.attempts) {
            if (getTranslationState(owner) === state && state.phase === 'loading' && restoreTranslationOwner(owner)) operation.restoredOnCancel += 1;
        }
        operation.attempts.clear();
    };
    operation.controller.signal.addEventListener('abort', cleanupAttempts, {once: true});
    // 复用共享状态通知，记录后来悬浮/全文/其它区域曾经接管的来源；即使恢复后状态回到
    // undefined，旧计划仍被排除。首个直接节点可能是 b/span，重试锚点则可能是内部 Text。
    const unsubscribe = subscribeTranslationStateChanges((owner, state, previousState) => {
        operation.changedSourceKeys.add(owner);
        const sourceState = state ?? previousState;
        if (sourceState?.syntheticSegment) {
            // 共享 key 跳过前缀 Comment，沿用首个 Element/Text；不另定义一套锚点语义。
            const candidate = {element: owner, kind: sourceState.kind, reason: 'section-state-change'};
            operation.changedSourceKeys.add(getTranslationCandidateKey({...candidate, nodes: sourceState.syntheticSourceNodes}));
            operation.changedSourceKeys.add(getTranslationCandidateKey({...candidate, nodes: sourceState.sourceTextNodes}));
        }
    });
    signal?.addEventListener('abort', cancel, {once: true});
    requestSession.requestSignal.addEventListener('abort', cancel, {once: true});
    roots.forEach(root => sectionOperations.set(root, operation));
    activeSectionOperations.add(operation);
    try {
        const work = runSectionWork(summarize(roots, Number.POSITIVE_INFINITY, () => snapshot, Boolean(overrides), operation, ensureOnly), operation);
        const inventory = work instanceof Promise ? await work : work;
        if (!inventory) return {action: 'cancelled', ...EMPTY_TALLY};
        const {summary, pending} = inventory;
        operation.planned = summary.total;
        operation.active = summary.active + summary.pending;
        operation.discovering = false;
        if (summary.action === 'translate') {
            const ordered = runSectionWork(orderByReadingPosition(pending), operation);
            const candidates = ordered instanceof Promise ? await ordered : ordered;
            if (!candidates) return {action: 'cancelled', ...EMPTY_TALLY};
            return await translatePendingCandidates(candidates, snapshot, operation);
        }
        if (summary.action === 'restore') return ensureOnly ? {action: 'settled', ...EMPTY_TALLY}
            : {action: 'restored', ...EMPTY_TALLY, restored: restoreSection(roots)};
        return {action: summary.action, ...EMPTY_TALLY};
    } finally {
        operation.controller.abort();
        activeSectionOperations.delete(operation);
        unsubscribe();
        signal?.removeEventListener('abort', cancel);
        requestSession.requestSignal.removeEventListener('abort', cancel);
        operation.controller.signal.removeEventListener('abort', cleanupAttempts);
        roots.forEach(root => {if (sectionOperations.get(root) === operation) sectionOperations.delete(root);});
    }
}
