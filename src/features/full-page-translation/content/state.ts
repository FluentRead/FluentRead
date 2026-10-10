/**
 * @file src/features/full-page-translation/content/state.ts
 * 文件职责：维护每个被翻译 DOM 节点的可恢复状态、请求代次、译文工件和共享布局覆盖所有权，确保重复翻译、宿主变更和移除节点都能安全收敛。
 * 主要内容：包含 WeakMap 状态索引、begin/complete/error/discard 状态机、spinner/译文/retry/仅译文槽节点登记、无主槽原文解包、兼容字体标记与链接提示的译文复验及有界重挂、离线模板仅省略外层属性自比较并保留内容与复制工件复验、已提交译文的前后位置及骨架重放换行快照、含固定高度 line-clamp 的共享样式租约、同批布局与来源保护读数复用及写入失效（释放最后一个旧祖先租约也立即失效）、祖先观察器引用计数、文本槽回写、按钮型 input 标签属性的原值记录与回滚、逐父节点单次读取子列表的移除子树所有者枚举、按真实状态变更发布增量阶段通知，以及沿用当前 owner 快照并保护各滚动面的全量恢复。
 * 模块边界：该模块不发现候选、不请求翻译也不生成译文 HTML；runtime 负责会话编排，renderer 负责内容创建，本文件仅拥有 DOM 状态与可逆样式资源，避免跨 session 误删新结果。
 */
import {getTranslatableControlValueAttribute, isTranslationTooltip} from "@/src/core/translation/dom";
import {clearTranslationFailedHost} from "@/src/features/full-page-translation/core/hostMarkers";
import {withFullPageRestorationAnchors} from './viewportStability';
import {
    hasTranslationHeightOverflow,
    isTranslationHeightBoundary,
    translationHeightStyleOverrides,
} from "@/src/core/translation/serialization";
import {
    collectLiveTranslationTextSlots,
    createTranslationLayoutMeasurements,
    createTranslationTextProtectionCache,
    getComposedParent,
    getCurrentTranslationCore,
    hasActiveTranslationLineClamp,
    hasActiveTranslationTruncation,
    isProtectedDescendantElement,
    isTranslationTextElementProtected,
    translationTruncationStyleOverrides,
    type TranslationCandidate,
    type TranslationScope,
    type TranslationLayoutMeasurements,
    type TranslationTextProtectionCache,
} from "@/src/core/translation/public";

/**
 * 指定节点翻译的生命周期状态。
 *
 * 这里使用真实 DOM 节点作为 WeakMap 的 key，而不是 outerHTML。
 * outerHTML 会因为属性、站点重渲染或相同段落而产生身份冲突；
 * 节点状态则可以准确绑定到本次用户操作的目标。
 */
type TranslationDisplayMode = "bilingual" | "single";
type TranslationPhase = "loading" | "translated" | "error";
type TranslationTargetKind = "content" | "control";

export interface TranslationLayoutStyleOverride {
    property: string;
    value: string;
    priority: string;
}

export interface BilingualTranslationReplay {
    sources: readonly string[];
    translations: readonly string[];
    targetLanguage: string;
    style: number;
    /** 首次提交已冻结的换行选项，骨架重放不得跟随后改的全局设置。 */
    longParagraphLineBreak?: boolean;
}

interface TranslationLayoutPropertySnapshot {
    property: string;
    overrideValue: string;
    overridePriority: string;
    originalValue: string;
    originalPriority: string;
    appliedValue: string;
    appliedPriority: string;
}

interface SharedTranslationLayoutOverride {
    originalStyleAttribute: string | null;
    renderedStyleAttribute: string | null;
    properties: TranslationLayoutPropertySnapshot[];
    owners: Set<WeakRef<HTMLElement>>;
    canRestoreExactStyleAttribute: boolean;
}

type TranslationLayoutObserverRoot = Document | ShadowRoot;

interface TranslationLayoutRootObserver {
    observer: MutationObserver;
    owners: Set<WeakRef<HTMLElement>>;
    releaseResizeListener: () => void;
}

export interface TranslationState {
    mode: TranslationDisplayMode;
    /** 内容块使用上下双语；按钮等交互控件只替换内部可见文字。 */
    kind: TranslationTargetKind;
    phase: TranslationPhase;
    generation: number;
    sourceText: string;
    /** 创建请求时可见的文本槽节点身份，早于任何实时替换。 */
    sourceTextNodes?: readonly Text[];
    sourceHTML: string;
    /** 忽略普通展示属性，但保留输出骨架、保护槽位置与安全链接语义的有界结构快照。 */
    sourceStructureSignature?: string;
    /** 结构快照溢出时冻结 owner 根语义与完整原文 HTML，避免延迟 mutation 改写旧代身份。 */
    sourceOverflowGenerationIdentity?: string;
    /** 有界结构快照溢出后，任一真实来源 mutation 都使当前译文失效。 */
    sourceStructureDirty?: boolean;
    /** 仅快捷方案使用；用于区分同一节点上的不同服务/模型/展示请求。 */
    translationInvocationIdentity?: string;
    /** runtime 为直接内联 run 创建的临时 wrapper；所有退出路径都会移除。 */
    syntheticSegment: boolean;
    /** 显式翻译候选可穿过 body 直接子级的应用级 no-translate 外壳。 */
    allowTopLevelApplicationShell?: boolean;
    /** 创建候选时的识别范围，恢复和宿主重挂沿用同一文本保护规则。 */
    scope?: TranslationScope;
    /** 添加加载指示器之前捕获的精确直接子节点。 */
    syntheticSourceNodes?: readonly ChildNode[];
    /** materialize 前的候选宿主；synthetic 解包后的熔断身份继续绑定到这里。 */
    syntheticHost?: HTMLElement;
    /** 翻译开始前的内联 style 属性，用于可条件恢复。 */
    originalStyleAttribute: string | null;
    /** 翻译开始前的 class 属性；恢复时避免留下空 class。 */
    originalClassAttribute: string | null;
    /** tooltip 内外的控件翻译没有 wrapper，用可恢复标记覆盖完整请求生命周期。 */
    originalTooltipTranslationAttribute?: string | null;
    /** 插件完成渲染后记录的 style 属性；undefined 表示尚未改动样式。 */
    renderedStyleAttribute?: string | null;
    /** 插件完成渲染后记录的 class 属性，用于过滤自身添加 bilingual class 的 mutation。 */
    renderedClassAttribute?: string | null;
    /** 翻译只改动原始 Text 节点，DOM 结构仍保持实时。 */
    textSlotsApplied?: boolean;
    /** 控件翻译直接修改原 Text 节点；恢复时需要把节点内容写回原值。 */
    originalTextValues: Array<{node: Text; value: string}>;
    /**
     * 按钮型 input 的标签存放在 value 属性而非 Text 节点里，译文只能整体改写属性。
     * 记录属性名、原值和插件写入的译文，使恢复原文只回滚插件自己的写入，
     * 宿主页在此期间改写过同一属性时保持宿主权威。
     */
    controlValue?: {attribute: string; original: string; translated?: string};
    /** 实时文本槽渲染器写入的精确值。 */
    translatedTextValues?: WeakMap<Text, string>;
    /** 单译文或控件渲染执行时可见且可翻译的 Text 节点。 */
    translatedTextNodes?: readonly Text[];
    /** 仅译文 content 的视觉替换槽；每个 host 的轻 DOM 仍保存宿主原 Text。 */
    singleTextSlotHosts?: Array<{host: HTMLElement; source: Text; sourceValue: string}>;
    controller: AbortController;
    spinner?: HTMLElement;
    /** 完成前已移除的 spinner，仅用于精确识别随后送达的 MutationRecord。 */
    settledSpinner?: HTMLElement;
    bilingualContent?: HTMLElement;
    /** 最后一次提交时译文位于来源之前；重挂沿用此快照，不读取后改的全局配置。 */
    bilingualBeforeSource?: boolean;
    /** 插件首次提交的可信译文模板；宿主改写当前 wrapper 时只从该离线模板重建。 */
    bilingualContentTemplate?: HTMLElement;
    /** 失败态的重试控件；用于区分扩展写入与宿主移除。 */
    retryWrapper?: HTMLElement;
    /** 双语 wrapper 最后一次由插件写入的 HTML，用于区分宿主重绘和插件自身 mutation。 */
    bilingualHTML?: string;
    /** 包含 class/lang/dir/translate 等外层属性的完整 wrapper 快照。 */
    bilingualOuterHTML?: string;
    /** 可在不再次访问 provider 的情况下，按当前安全 DOM 骨架重放的译文槽。 */
    bilingualReplay?: BilingualTranslationReplay;
    /** 本次翻译租用裁剪样式的候选节点或祖先节点。 */
    layoutOverrideElements?: Set<HTMLElement>;
    /** 为新启用的 line-clamp 或重挂行为而观察的有界 composed 祖先。 */
    layoutWatchElements?: Set<HTMLElement>;
    /** 双语布局租约生效期间保留的 Document/ShadowRoot 观察器。 */
    layoutObserverRoots?: Set<TranslationLayoutObserverRoot>;
}

interface TranslationAttempt {
    state: TranslationState;
    generation: number;
}

const states = new WeakMap<HTMLElement, TranslationState>();
// 反向所有权索引让移除处理只遍历受影响子树；WeakRef 不会为索引额外延长 DOM 节点生命周期。
const activeNodeRefs = new Set<WeakRef<HTMLElement>>();
const activeRefsByNode = new WeakMap<HTMLElement, WeakRef<HTMLElement>>();
const ownersByIndexedNode = new WeakMap<Node, Set<WeakRef<HTMLElement>>>();
const indexedNodesByOwner = new WeakMap<HTMLElement, Set<Node>>();
const sharedLayoutOverrides = new WeakMap<HTMLElement, SharedTranslationLayoutOverride>();
// 同步布局批次只在真实样式写入或发现宿主改写后失效；共享租约新增 owner 不改布局。
let layoutStyleVersion = 0;
const layoutMeasurementVersions = new WeakMap<TranslationLayoutMeasurements, number>();

function synchronizeTranslationLayoutMeasurements(measurements: TranslationLayoutMeasurements): void {
    if (layoutMeasurementVersions.get(measurements) === layoutStyleVersion) return;
    measurements.invalidate();
    layoutMeasurementVersions.set(measurements, layoutStyleVersion);
}
const layoutObserversByRoot = new WeakMap<TranslationLayoutObserverRoot, TranslationLayoutRootObserver>();
const pendingLayoutRefreshes = new WeakMap<HTMLElement, {removedNodes: Set<Node>}>();
let bilingualOwnerRemountHandler: ((mutations: readonly MutationRecord[]) => void) | undefined;
let bilingualArtifactCapitulationHandler:
    ((owner: HTMLElement, state: TranslationState) => void) | undefined;
let bilingualLifecycleExternallyManaged: (() => boolean) | undefined;
/**
 * 用已提交的原文/译文重建译文骨架。宿主只改写了会复制进骨架的装饰性属性时，
 * 可译文本未变，应刷新骨架而不是撤下译文。实现留在 bilingualReplay，避免 state 反向依赖。
 */
let bilingualSkeletonRefreshHandler: ((owner: HTMLElement, state: TranslationState) => boolean) | undefined;
const maxTranslationLayoutAncestorDepth = 16;
const BILINGUAL_ARTIFACT_SELECTOR =
    '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';
const SINGLE_TEXT_SLOT_SELECTOR = '.fluent-read-single-slot[data-fr-translation-owned="true"]';
const MAX_BILINGUAL_ARTIFACT_REPAIRS_PER_WINDOW = 3;
const SOURCE_STRUCTURE_ATTRIBUTES = [
    'href', 'title', 'role', 'translate', 'lang', 'dir', 'contenteditable',
    'hidden', 'inert', 'aria-hidden', 'data-notranslate',
] as const;
const SOURCE_STRUCTURE_NODE_BUDGET = 4096;
const SOURCE_STRUCTURE_DEPTH_BUDGET = 128;
const SOURCE_STRUCTURE_CHARACTER_BUDGET = 131_072;
const SOURCE_STRUCTURE_OVERFLOW = 'overflow';
const SOURCE_MUTATION_ANCESTOR_DEPTH_BUDGET = 512;
const OUTPUT_OMITTED_TAGS = new Set(['iframe', 'object', 'script', 'style', 'template', 'xmp']);
interface BilingualArtifactRejectionBudget {
    identity: string;
    overflowGenerationIdentity?: string;
    repairs: number;
    /** 内容/关键属性篡改跨 pointer 手势累计，防止宿主每次输入都重启反馈环。 */
    tamperRepairs: number;
    gesture: number;
    capitulated: boolean;
}
let bilingualArtifactRejectionBudgets = new WeakMap<HTMLElement, BilingualArtifactRejectionBudget>();
let bilingualArtifactWriteGesture = 0;

export function setBilingualOwnerRemountHandler(
    handler: ((mutations: readonly MutationRecord[]) => void) | undefined,
): void {
    bilingualOwnerRemountHandler = handler;
}

export function setBilingualArtifactCapitulationHandler(
    handler: ((owner: HTMLElement, state: TranslationState) => void) | undefined,
): void {
    bilingualArtifactCapitulationHandler = handler;
}

export function setBilingualLifecycleExternalManager(handler: (() => boolean) | undefined): void {
    const hadManager = bilingualLifecycleExternallyManaged !== undefined;
    bilingualLifecycleExternallyManaged = handler;
    // 接管期间旧根的 records 不属于独立管理器；明确交还时重登记当前根并释放旧租约。
    if (hadManager && !handler?.()) {
        activeNodeRefs.forEach((ref) => {
            const owner = ref.deref();
            if (owner) scheduleTranslationLayoutRefresh(owner);
        });
    }
}

export function setBilingualSkeletonRefreshHandler(
    handler: ((owner: HTMLElement, state: TranslationState) => boolean) | undefined,
): void {
    bilingualSkeletonRefreshHandler = handler;
}

/**
 * class/style/data-* 等展示性抖动不应使译文失效；标签层级、文本位置、
 * href/title 以及会复制到译文骨架的 code/notranslate/公式内容必须保持。
 */
export function getTranslationSourceStructureSignature(
    node: HTMLElement,
    allowTopLevelApplicationShell = false,
    sourceTextNodes?: readonly Text[],
    scope?: TranslationScope,
    protectionCache: TranslationTextProtectionCache = createTranslationTextProtectionCache(),
): string {
    if ((node as Node).nodeType !== 1 || !node.childNodes) return node.innerHTML;
    const tokens: Array<string | readonly [string, string]> = [];
    let tokenCharacters = 0;
    const pushToken = (token: string | readonly [string, string]): boolean => {
        tokenCharacters += typeof token === 'string' ? token.length : token[0].length + token[1].length;
        if (tokenCharacters > SOURCE_STRUCTURE_CHARACTER_BUDGET) return false;
        tokens.push(token);
        return true;
    };
    const protectionOptions = allowTopLevelApplicationShell
        ? {allowTopLevelApplicationShell: true, protectedElement: node}
        : {protectedElement: node};
    const translatableTextNodes = sourceTextNodes ? new WeakSet(sourceTextNodes) : undefined;
    const shouldStayOriginal = getCurrentTranslationCore(scope).shouldStayOriginal;
    const preservesWhitespace = (text: Text): boolean => {
        const parent = text.parentElement;
        if (!parent) return false;
        return Boolean(parent.closest('pre, textarea'));
    };
    type PendingNode = {current: Node; depth: number; close?: string};
    const pending: PendingNode[] = [{current: node, depth: 0}];
    let visited = 0;
    while (pending.length > 0) {
        const {current, depth, close} = pending.pop()!;
        if (close) {
            if (!pushToken(close)) return SOURCE_STRUCTURE_OVERFLOW;
            continue;
        }
        visited += 1;
        if (visited > SOURCE_STRUCTURE_NODE_BUDGET || depth > SOURCE_STRUCTURE_DEPTH_BUDGET) {
            return SOURCE_STRUCTURE_OVERFLOW;
        }
        if (current.nodeType === 3) {
            const raw = (current as Text).data;
            if (raw.length > SOURCE_STRUCTURE_CHARACTER_BUDGET - tokenCharacters) {
                return SOURCE_STRUCTURE_OVERFLOW;
            }
            const collapsed = raw.replace(/[\s\u3000]+/gu, ' ');
            const text = raw !== collapsed && preservesWhitespace(current as Text)
                ? raw
                : collapsed;
            if (text && !pushToken([
                raw.trim().length === 0
                    ? 'whitespace'
                    : translatableTextNodes
                    ? (translatableTextNodes.has(current as Text) ? 'text' : 'protected-text')
                    : ((current as Text).parentElement && !isTranslationTextElementProtected(
                        (current as Text).parentElement!,
                        shouldStayOriginal,
                        protectionCache,
                        protectionOptions,
                    ) ? 'text' : 'protected-text'),
                text,
            ])) return SOURCE_STRUCTURE_OVERFLOW;
            continue;
        }
        if (current.nodeType !== 1) continue;
        const element = current as Element;
        if (element !== node && (isTranslationTooltip(element) || element.matches('[data-fr-translation-owned="true"]'))) continue;
        if (element !== node && OUTPUT_OMITTED_TAGS.has(element.localName)) {
            if (!pushToken('omitted:' + (element.namespaceURI ?? '') + ':' + element.localName)) return SOURCE_STRUCTURE_OVERFLOW;
            continue;
        }
        if (!pushToken('open:' + (element.namespaceURI ?? '') + ':' + element.localName)) return SOURCE_STRUCTURE_OVERFLOW;
        for (const name of SOURCE_STRUCTURE_ATTRIBUTES) {
            const value = element.getAttribute(name);
            if (value !== null && !pushToken([name, value])) return SOURCE_STRUCTURE_OVERFLOW;
        }
        const semanticClasses = ['notranslate', 'sr-only', 'visually-hidden']
            .filter((name) => element.classList.contains(name));
        if (semanticClasses.length > 0 &&
            !pushToken(['semantic-class', semanticClasses.join(' ')])) return SOURCE_STRUCTURE_OVERFLOW;
        if (pending.length + current.childNodes.length > SOURCE_STRUCTURE_NODE_BUDGET) {
            return SOURCE_STRUCTURE_OVERFLOW;
        }
        pending.push({current, depth, close: 'close:' + element.localName});
        for (let index = current.childNodes.length - 1; index >= 0; index -= 1) {
            const child = current.childNodes.item(index);
            if (child) pending.push({current: child, depth: depth + 1});
        }
    }
    return JSON.stringify(tokens);
}

export function isTranslationSourceStructureOverflow(signature: string | undefined): boolean {
    return signature === SOURCE_STRUCTURE_OVERFLOW;
}

export function getTranslationOverflowGenerationIdentity(
    owner: HTMLElement,
): string {
    const clone = owner.cloneNode(true) as HTMLElement;
    Array.from(clone.querySelectorAll('[data-fr-translation-owned="true"]'))
        .forEach((artifact) => artifact.remove());
    Array.from(clone.querySelectorAll<HTMLElement>('*')).forEach((element) => {
        const semanticClasses = semanticStructureClasses(element.getAttribute('class'));
        if (semanticClasses) element.setAttribute('class', semanticClasses);
        else element.removeAttribute('class');
        const semanticStyle = semanticVisibilityStyleValues(element, element.getAttribute('style'));
        element.removeAttribute('style');
        if (semanticStyle.display) element.style.display = semanticStyle.display;
        if (semanticStyle.visibility) element.style.visibility = semanticStyle.visibility;
    });
    return JSON.stringify([
        clone.innerHTML,
        SOURCE_STRUCTURE_ATTRIBUTES.map((name) => [name, owner.getAttribute(name)]),
        semanticStructureClasses(owner.getAttribute('class')),
        semanticVisibilityStyle(owner, owner.getAttribute('style')),
    ]);
}

function getStylePropertyPriority(style: CSSStyleDeclaration, property: string): string {
    return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(property) : "";
}

function forEachActiveNode(callback: (node: HTMLElement, state: TranslationState) => void): void {
    for (const ref of activeNodeRefs) {
        const node = ref.deref();
        if (!node) {
            activeNodeRefs.delete(ref);
            continue;
        }
        const state = states.get(node);
        if (!state) {
            activeNodeRefs.delete(ref);
            continue;
        }
        callback(node, state);
    }
}

function trackActiveNode(node: HTMLElement): WeakRef<HTMLElement> {
    const existing = activeRefsByNode.get(node);
    if (existing) return existing;
    const ref = new WeakRef(node);
    activeRefsByNode.set(node, ref);
    activeNodeRefs.add(ref);
    return ref;
}

function clearOwnershipIndex(owner: HTMLElement): void {
    const indexedNodes = indexedNodesByOwner.get(owner);
    if (!indexedNodes) return;
    const ownerRef = activeRefsByNode.get(owner);

    indexedNodes.forEach((indexedNode) => {
        const owners = ownersByIndexedNode.get(indexedNode);
        // 稳定的 WeakRef 就是索引键；清理一个段落不应遍历同一祖先的全部段落。
        // 失效引用由索引读取入口清理，不把全文恢复退化成 O(段落数²)。
        if (ownerRef) owners?.delete(ownerRef);
        if (owners?.size === 0) ownersByIndexedNode.delete(indexedNode);
    });
    indexedNodesByOwner.delete(owner);
}

function refreshOwnershipIndex(owner: HTMLElement, state: TranslationState): void {
    // 重建节点集合，但复用仍有效的反向索引桶；每类产物直接写入 Set。
    const indexedNodes = new Set<Node>();
    indexedNodes.add(owner);
    if (state.spinner) indexedNodes.add(state.spinner);
    if (state.bilingualContent) indexedNodes.add(state.bilingualContent);
    if (state.retryWrapper) indexedNodes.add(state.retryWrapper);
    state.singleTextSlotHosts?.forEach(({host}) => indexedNodes.add(host));
    state.layoutOverrideElements?.forEach((element) => indexedNodes.add(element));
    state.layoutWatchElements?.forEach((element) => indexedNodes.add(element));
    const previousIndexedNodes = indexedNodesByOwner.get(owner);
    const ownerRef = trackActiveNode(owner);
    previousIndexedNodes?.forEach((indexedNode) => {
        if (indexedNodes.has(indexedNode)) return;
        const owners = ownersByIndexedNode.get(indexedNode);
        owners?.delete(ownerRef);
        if (owners?.size === 0) ownersByIndexedNode.delete(indexedNode);
    });
    indexedNodesByOwner.set(owner, indexedNodes);

    indexedNodes.forEach((indexedNode) => {
        let owners = ownersByIndexedNode.get(indexedNode);
        if (!owners) {
            owners = new Set<WeakRef<HTMLElement>>();
            ownersByIndexedNode.set(indexedNode, owners);
        }
        // 保留原来 clear/re-add 的枚举顺序，同时避免单 owner 桶删除后重新分配。
        owners.delete(ownerRef);
        owners.add(ownerRef);
    });
}

export function getTranslationState(node: HTMLElement): TranslationState | undefined {
    return states.get(node);
}

/** 将文本槽候选映射回持有翻译状态的祖先；普通候选仍直接使用自身节点。 */
export function resolveTranslationStateNode(candidate: TranslationCandidate): HTMLElement | null {
    if (!candidate.nodes?.length) return candidate.element;
    let current = candidate.nodes[0]?.parentElement ?? null;
    while (current) {
        if (current.matches('[data-fr-translation-segment="true"]') && states.has(current)) return current;
        current = current.parentElement;
    }
    return null;
}

/** 旧版 WebView 的 DOM 选择器不支持 :has；复用候选层的 tooltip 判定。 */
function hasTranslationTooltip(node: HTMLElement): boolean {
    const selector = '[role="tooltip"], .tooltip';
    let ancestor = node.closest?.(selector) ?? null;
    while (ancestor) {
        if (isTranslationTooltip(ancestor)) return true;
        ancestor = ancestor.parentElement?.closest(selector) ?? null;
    }
    for (const descendant of node.querySelectorAll?.(selector) ?? []) {
        if (isTranslationTooltip(descendant)) return true;
    }
    return false;
}

type TranslationStateChangeListener = (node: HTMLElement, state: TranslationState | undefined) => void;
const translationStateChangeListeners = new Set<TranslationStateChangeListener>();

/** 仅交付成功的状态变更，供全文会话增量计数；取消订阅后不再持有页面运行时。 */
export function subscribeTranslationStateChanges(listener: TranslationStateChangeListener): () => void {
    translationStateChangeListeners.add(listener);
    return () => { translationStateChangeListeners.delete(listener); };
}
function notifyTranslationStateChange(node: HTMLElement, state: TranslationState | undefined): void {
    for (const listener of translationStateChangeListeners) {
        try { listener(node, state); } catch { /* 展示订阅异常不能阻断恢复原文。 */ }
    }
}

/**
 * 开始一次新的节点翻译请求。
 * loading 状态不能重复发起请求；error 状态可以被调用方先恢复后重试。
 */
export function beginTranslation(
    node: HTMLElement,
    mode: TranslationDisplayMode,
    kind: TranslationTargetKind = "content",
    syntheticSegment = false,
    sourceText = node.textContent ?? "",
    sourceTextNodes?: readonly Text[],
    allowTopLevelApplicationShell = false,
    translationInvocationIdentity?: string,
    scope?: TranslationScope,
): TranslationAttempt | null {
    const previous = states.get(node);
    if (previous?.phase === "loading") return null;

    previous?.controller.abort();

    const originalTextValues: Array<{node: Text; value: string}> = [];
    if ((mode === "single" || kind === "control") && node.ownerDocument?.createTreeWalker) {
        const textWalker = node.ownerDocument.createTreeWalker(node, 4);
        let textNode = textWalker.nextNode();
        while (textNode) {
            originalTextValues.push({node: textNode as Text, value: textNode.nodeValue ?? ""});
            textNode = textWalker.nextNode();
        }
    }

    const controlValueAttribute = getTranslatableControlValueAttribute(node);
    const sourceHTML = node.innerHTML;
    const sourceStructureSignature = getTranslationSourceStructureSignature(
        node,
        allowTopLevelApplicationShell,
        sourceTextNodes?.length ? sourceTextNodes : undefined,
        scope,
    );
    const state: TranslationState = {
        mode,
        kind,
        phase: "loading",
        generation: (previous?.generation ?? 0) + 1,
        sourceText,
        sourceTextNodes: sourceTextNodes ? [...sourceTextNodes] : undefined,
        sourceHTML,
        sourceStructureSignature,
        sourceOverflowGenerationIdentity: isTranslationSourceStructureOverflow(sourceStructureSignature)
            ? getTranslationOverflowGenerationIdentity(node) : undefined,
        translationInvocationIdentity,
        scope,
        syntheticSegment,
        allowTopLevelApplicationShell: allowTopLevelApplicationShell || undefined,
        syntheticSourceNodes: syntheticSegment ? Array.from(node.childNodes) : undefined,
        syntheticHost: syntheticSegment ? node.parentElement ?? undefined : undefined,
        originalStyleAttribute: node.getAttribute("style"),
        originalClassAttribute: node.getAttribute("class"),
        originalTextValues,
        controlValue: controlValueAttribute
            ? {attribute: controlValueAttribute, original: node.getAttribute(controlValueAttribute) ?? ""}
            : undefined,
        controller: new AbortController(),
    };

    if (hasTranslationTooltip(node)) {
        state.originalTooltipTranslationAttribute = previous?.originalTooltipTranslationAttribute !== undefined
            ? previous.originalTooltipTranslationAttribute
            : node.getAttribute('data-fr-tooltip-translation-active');
        node.setAttribute('data-fr-tooltip-translation-active', 'true');
    }
    states.set(node, state);
    trackActiveNode(node);
    refreshOwnershipIndex(node, state);
    notifyTranslationStateChange(node, state);
    return { state, generation: state.generation };
}

/**
 * 异步请求返回后，确认它仍然属于当前节点的当前一代请求。
 * sourceHTML 的检查应在移除扩展自己的 spinner 后调用。
 */
export function isCurrentTranslation(
    node: HTMLElement,
    state: TranslationState,
    generation: number,
    validateSourceHTML = true,
): boolean {
    return (
        states.get(node) === state &&
        state.generation === generation &&
        !state.controller.signal.aborted &&
        node.isConnected &&
        (!validateSourceHTML || node.innerHTML === state.sourceHTML)
    );
}

export function markTranslationComplete(
    node: HTMLElement,
    state: TranslationState,
    generation: number,
    validateSourceHTML = true,
): boolean {
    return transitionPhase(node, state, generation, "translated", validateSourceHTML);
}

export function markTranslationError(
    node: HTMLElement,
    state: TranslationState,
    generation: number,
    validateSourceHTML = true,
): boolean {
    // 失败结果也不能覆盖站点在请求期间写入的新内容。
    // 调用方会先移除插件自己的 spinner，再进行这次快照校验。
    return transitionPhase(node, state, generation, "error", validateSourceHTML);
}

function transitionPhase(
    node: HTMLElement,
    state: TranslationState,
    generation: number,
    phase: Extract<TranslationPhase, "translated" | "error">,
    validateSourceHTML: boolean,
): boolean {
    if (!isCurrentTranslation(node, state, generation, validateSourceHTML)) return false;
    state.phase = phase;
    state.settledSpinner = state.spinner;
    state.spinner = undefined;
    refreshOwnershipIndex(node, state);
    notifyTranslationStateChange(node, state);
    return true;
}

type TranslationArtifactKey = "spinner" | "bilingualContent" | "retryWrapper";

function setArtifact(
    node: HTMLElement,
    key: TranslationArtifactKey,
    artifact: HTMLElement,
): void {
    const state = states.get(node);
    if (!state) return;
    state[key] = artifact;
    refreshOwnershipIndex(node, state);
}

export function setSpinner(node: HTMLElement, spinner: HTMLElement): void {
    setArtifact(node, "spinner", spinner);
}

export function setBilingualContent(
    node: HTMLElement,
    content: HTMLElement,
    replay?: BilingualTranslationReplay,
    trustedTemplate?: HTMLElement,
): void {
    setArtifact(node, "bilingualContent", content);
    const state = states.get(node);
    if (state) {
        state.bilingualHTML = content.innerHTML;
        state.bilingualOuterHTML = content.outerHTML;
        state.bilingualBeforeSource = content === node.firstChild;
        state.bilingualContentTemplate = (trustedTemplate ?? content).cloneNode(true) as HTMLElement;
        if (state.syntheticSegment) {
            state.syntheticHost = node.parentElement ?? state.syntheticHost;
            state.syntheticSourceNodes = Array.from(node.childNodes).filter((child) =>
                child.nodeType !== 1 || !(child as Element).matches('[data-fr-translation-owned="true"]'));
            const sourceClone = node.cloneNode(false) as HTMLElement;
            state.syntheticSourceNodes.forEach((child) => sourceClone.appendChild(child.cloneNode(true)));
            state.sourceHTML = sourceClone.innerHTML;
        }
        if (replay) state.bilingualReplay = {
            ...replay,
            sources: [...replay.sources],
            translations: [...replay.translations],
        };
        state.sourceStructureSignature = getTranslationSourceStructureSignature(
            node,
            state.allowTopLevelApplicationShell === true,
            state.sourceTextNodes?.length ? state.sourceTextNodes : undefined,
            state.scope,
        );
        state.sourceOverflowGenerationIdentity = isTranslationSourceStructureOverflow(
            state.sourceStructureSignature,
        ) ? getTranslationOverflowGenerationIdentity(node) : undefined;
        state.sourceStructureDirty = false;
    }
}

export function setRetryWrapper(node: HTMLElement, wrapper: HTMLElement): void {
    setArtifact(node, "retryWrapper", wrapper);
}

/**
 * 宿主页只移除了扩展的失败 UI 时，保留错误墓碑，避免通用发现把永久服务错误
 * 变成自动重试；真实源文变更或用户明确操作仍可清除该状态。
 */
export function detachFailedTranslationUi(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    if (states.get(node) !== state || state.phase !== "error") return false;
    removeExtensionNode(state.retryWrapper);
    state.retryWrapper = undefined;
    if (state.originalTooltipTranslationAttribute !== undefined &&
        node.getAttribute('data-fr-tooltip-translation-active') === 'true') {
        if (state.originalTooltipTranslationAttribute === null) node.removeAttribute('data-fr-tooltip-translation-active');
        else node.setAttribute('data-fr-tooltip-translation-active', state.originalTooltipTranslationAttribute);
    }
    restoreOriginalStyle(node, state);
    restoreOriginalClass(node, state);
    state.renderedStyleAttribute = node.getAttribute("style");
    state.renderedClassAttribute = node.getAttribute("class");
    refreshOwnershipIndex(node, state);
    return true;
}

/**
 * 记录插件完成渲染后的内联样式。
 *
 * 恢复时只有当节点仍保持这个值，才会写回原始样式；如果网站已经
 * 修改过 style，则保留网站的新值，避免翻译恢复覆盖宿主页面更新。
 */
export function setRenderedStyleAttribute(node: HTMLElement): void {
    const state = states.get(node);
    if (state) {
        state.renderedStyleAttribute = node.getAttribute("style");
        state.renderedClassAttribute = node.getAttribute("class");
    }
}

/** 克隆 owner 接管前只撤销本 generation 真正持有的展示写入，保留宿主新增 class/style。 */
export function restoreClonedTranslationOwnerPresentation(
    previousOwner: HTMLElement,
    replacementOwner: HTMLElement,
    state: TranslationState,
    layoutElementPairs: readonly (readonly [HTMLElement, HTMLElement])[] = [[previousOwner, replacementOwner]],
): void {
    if (states.get(previousOwner) !== state) return;
    clearTranslationFailedHost(replacementOwner);
    layoutElementPairs.forEach(([previousElement, replacementElement]) => {
        if (state.layoutOverrideElements?.has(previousElement)) {
            const override = sharedLayoutOverrides.get(previousElement);
            override?.properties.forEach((property) => {
                if (getStylePropertyValue(replacementElement.style, property.property) !== property.appliedValue ||
                    getStylePropertyPriority(replacementElement.style, property.property) !== property.appliedPriority) return;
                if (property.originalValue) {
                    replacementElement.style.setProperty(
                        property.property,
                        property.originalValue,
                        property.originalPriority,
                    );
                } else replacementElement.style.removeProperty(property.property);
            });
            if (replacementElement.getAttribute('style') === '') replacementElement.removeAttribute('style');
        }
    });
}

function bilingualArtifactRejectionIdentity(
    sourceText: string,
    sourceStructureSignature: string | undefined,
    translationInvocationIdentity: string | undefined,
    scope?: TranslationScope,
): string {
    return JSON.stringify([
        sourceText.replace(/[\s\u3000]+/gu, ' ').trim(),
        sourceStructureSignature ?? '',
        translationInvocationIdentity ?? '',
        scope ?? 'content',
    ]);
}

export function isBilingualArtifactHostWriteBudgetCapitulated(
    owner: HTMLElement,
    sourceText: string,
    sourceStructureSignature: string,
    translationInvocationIdentity: string | undefined,
    scope?: TranslationScope,
): boolean {
    const budget = bilingualArtifactRejectionBudgets.get(owner);
    return Boolean(budget?.capitulated && budget.identity === bilingualArtifactRejectionIdentity(
        sourceText,
        sourceStructureSignature,
        translationInvocationIdentity,
        scope,
    ) && (!isTranslationSourceStructureOverflow(sourceStructureSignature) ||
        budget.overflowGenerationIdentity === getTranslationOverflowGenerationIdentity(owner)));
}

export function hasBilingualArtifactHostWriteBudget(owner: HTMLElement): boolean {
    return bilingualArtifactRejectionBudgets.has(owner);
}

/** 每次真实 hover 手势开启新代次；同一手势内的 observer 自反馈继续共享熔断预算。 */
export function beginBilingualArtifactHostWriteGesture(): void {
    bilingualArtifactWriteGesture += 1;
}

/** 同一 owner/语义 generation 的自反馈写回有界，已熔断状态不会被下一手势自动解锁。 */
export function consumeBilingualArtifactHostWriteBudget(
    owner: HTMLElement,
    state: TranslationState,
    persistentTamper = false,
): boolean {
    const identity = bilingualArtifactRejectionIdentity(
        state.sourceText, state.sourceStructureSignature, state.translationInvocationIdentity, state.scope);
    const overflowGenerationIdentity = state.sourceOverflowGenerationIdentity;
    let budget = bilingualArtifactRejectionBudgets.get(owner);
    if (!budget || budget.identity !== identity ||
        budget.overflowGenerationIdentity !== overflowGenerationIdentity) {
        budget = {identity, overflowGenerationIdentity, repairs: 0, tamperRepairs: 0,
            gesture: bilingualArtifactWriteGesture, capitulated: false};
        bilingualArtifactRejectionBudgets.set(owner, budget);
    }
    if (budget.capitulated) return false;
    if (persistentTamper) {
        if (budget.tamperRepairs >= MAX_BILINGUAL_ARTIFACT_REPAIRS_PER_WINDOW) {
            budget.capitulated = true;
            return false;
        }
        budget.tamperRepairs += 1;
        return true;
    }
    if (budget.gesture !== bilingualArtifactWriteGesture) {
        budget.gesture = bilingualArtifactWriteGesture;
        budget.repairs = 0;
    }
    if (budget.repairs >= MAX_BILINGUAL_ARTIFACT_REPAIRS_PER_WINDOW) {
        budget.capitulated = true;
        return false;
    }
    budget.repairs += 1;
    return true;
}

export function resetBilingualArtifactHostWriteBudget(owner: HTMLElement): void {
    bilingualArtifactRejectionBudgets.delete(owner);
}

export function resetAllBilingualArtifactHostWriteBudgets(): void {
    bilingualArtifactRejectionBudgets = new WeakMap();
}

/** 整块 owner 换代时共享手势 lineage；精确 copied wrapper 不计为新的宿主拒绝。 */
export function inheritBilingualArtifactRepairBudget(
    previousOwner: HTMLElement,
    replacementOwner: HTMLElement,
    previousState: TranslationState,
    replacementState: TranslationState,
    consumeRepair: boolean | 'tamper' = true,
): boolean {
    const identity = bilingualArtifactRejectionIdentity(
        previousState.sourceText,
        previousState.sourceStructureSignature,
        previousState.translationInvocationIdentity,
        previousState.scope,
    );
    const overflowGenerationIdentity = previousState.sourceOverflowGenerationIdentity;
    const existing = bilingualArtifactRejectionBudgets.get(previousOwner);
    const budget = existing?.identity === identity &&
        existing.overflowGenerationIdentity === overflowGenerationIdentity
        ? existing
        : {identity, overflowGenerationIdentity, repairs: 0, tamperRepairs: 0,
            gesture: bilingualArtifactWriteGesture, capitulated: false};
    bilingualArtifactRejectionBudgets.set(replacementOwner, budget);
    if (budget.capitulated) return false;
    return consumeRepair === false || consumeBilingualArtifactHostWriteBudget(
        replacementOwner,
        replacementState,
        consumeRepair === 'tamper',
    );
}

export type BilingualArtifactRepairResult =
    | 'repaired'
    /** 属性漂移：工件仍是本代译文，保留原样且不重写宿主 DOM。 */
    | 'tolerated'
    | 'rejected-after-write'
    | 'not-repairable'
    | 'capitulated';

function currentBilingualSourceStructureMatches(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    if (isTranslationSourceStructureOverflow(state.sourceStructureSignature)) {
        return getTranslationOverflowGenerationIdentity(node) === state.sourceOverflowGenerationIdentity;
    }
    let currentSourceNodes: Text[] | undefined;
    if (state.syntheticSegment) {
        currentSourceNodes = collectLiveTranslationTextSlots(
            node,
            getCurrentTranslationCore(state.scope).shouldStayOriginal,
            node,
            state.allowTopLevelApplicationShell === true
                ? {allowTopLevelApplicationShell: true, protectedElement: node}
                : {protectedElement: node},
        ).map((slot) => slot.node);
    }
    const matches = getTranslationSourceStructureSignature(
        node,
        state.allowTopLevelApplicationShell === true,
        currentSourceNodes,
        state.scope,
    ) === state.sourceStructureSignature;
    if (matches && currentSourceNodes) {
        state.sourceTextNodes = currentSourceNodes;
        state.syntheticSourceNodes = Array.from(node.childNodes).filter((child) =>
            child.nodeType !== 1 || !(child as Element).matches('[data-fr-translation-owned="true"]'));
    }
    return matches;
}

/**
 * roving tabindex 组件会为新出现的链接补写 -1/0。它不改变译文、链接目的地
 * 或可见性，不能被当成宿主删除译文。Font Rendering 的粗体修正会在
 * wrapper 及行内后代添加 ultimate-bold-correct 属性或 class；这同样只是字体标记。
 * ShortPixel 也会给新插入的译文及其后代补写值为 1 的 data-spai-bg-prepared；
 * 该扫描标记不改变正文，不能让每次插入都消耗译文修复预算。只在精确 HTML
 * 不同时克隆比较。漂移判定可额外忽略链接 title 的增删改，
 * 但 href、事件、可见性与其他属性仍须保持，不能把所有属性变化都当作页面装饰。
 */
function bilingualContentMatchesWithHostTabOrder(
    artifact: HTMLElement,
    state: TranslationState,
    allowLinkTitleDrift = false,
): boolean {
    if (state.bilingualHTML === undefined) return false;
    if (artifact.innerHTML === state.bilingualHTML) return true;
    const template = state.bilingualContentTemplate;
    if (!template || template.innerHTML !== state.bilingualHTML) return false;
    const current = artifact.cloneNode(true) as HTMLElement;
    const expected = template.cloneNode(true) as HTMLElement;
    for (const clone of [current, expected]) {
        for (const element of Array.from(clone.querySelectorAll('[data-spai-bg-prepared="1"]'))) {
            element.removeAttribute('data-spai-bg-prepared');
        }
        if (allowLinkTitleDrift) {
            for (const link of Array.from(clone.querySelectorAll('a[href][title]'))) {
                link.removeAttribute('title');
            }
        }
        for (const element of Array.from(clone.querySelectorAll('[ultimate-bold-correct], .ultimate-bold-correct'))) {
            if (element.getAttribute('ultimate-bold-correct') === '') element.removeAttribute('ultimate-bold-correct');
            if (element.classList.contains('ultimate-bold-correct')) {
                element.classList.remove('ultimate-bold-correct');
                if (!element.getAttribute('class')) element.removeAttribute('class');
            }
        }
        for (const link of Array.from(clone.querySelectorAll('a[href][tabindex]'))) {
            const tabIndex = link.getAttribute('tabindex');
            if (tabIndex !== '-1' && tabIndex !== '0') return false;
            link.removeAttribute('tabindex');
        }
    }
    return current.innerHTML === expected.innerHTML;
}

export function isTrustedBilingualArtifactWithHostClass(
    artifact: HTMLElement,
    state: TranslationState,
): boolean {
    return bilingualContentMatchesWithHostTabOrder(artifact, state) &&
        bilingualWrapperAttributesMatch(artifact, state);
}

/**
 * 仅链接提示和已有焦点/字体兼容标记可以漂移。宿主可能只改译文副本的 href
 * 或隐藏属性而不改原文，此时来源签名不会变化，必须继续修复，不能等待源文重放。
 */
function bilingualContentMatchesSnapshot(artifact: HTMLElement, state: TranslationState): boolean {
    return bilingualContentMatchesWithHostTabOrder(artifact, state, true);
}

/**
 * wrapper 自身的标记与 lang/dir/translate/style 等外层属性仍与可信快照一致。
 * 外层属性决定译文语义与所有权，被改写仍按篡改处理；容忍只覆盖 wrapper
 * **内部**复制链接的提示属性漂移。
 */
function bilingualWrapperAttributesMatch(artifact: HTMLElement, state: TranslationState): boolean {
    const template = state.bilingualContentTemplate;
    if (!template || !artifact.matches(BILINGUAL_ARTIFACT_SELECTOR)) return false;
    // 模板外层与自身比较恒真；内容快照和复制工件复验仍由原有路径执行。
    if (artifact === template) return true;
    const templateAttributes = new Map(Array.from(template.attributes, ({name, value}) => [name, value]));
    for (const {name, value} of Array.from(artifact.attributes)) {
        if (name === 'ultimate-bold-correct' && value === '') continue;
        if (name === 'data-spai-bg-prepared' && value === '1') continue;
        if (name !== 'class' && templateAttributes.get(name) !== value) return false;
    }
    for (const [name, value] of templateAttributes) {
        if (name === 'ultimate-bold-correct' && value === '') continue;
        if (name === 'data-spai-bg-prepared' && value === '1') continue;
        if (name !== 'class' && artifact.getAttribute(name) !== value) return false;
    }
    const trustedClasses = new Set(Array.from(template.classList).filter((name) => name !== 'ultimate-bold-correct'));
    if (Array.from(trustedClasses).some((name) => !artifact.classList.contains(name))) return false;
    const addedClasses = Array.from(artifact.classList).filter((name) => !trustedClasses.has(name));
    return !addedClasses.some((name) => name.startsWith('fluent-read-') ||
        semanticStructureClasses(name).length > 0);
}

/**
 * 工件信任等级：'trusted' 与提交快照及已有兼容例外一致；'drift' 仅多出链接
 * title 漂移，其他属性、结构和文本仍与可信模板一致；其余按篡改处理。
 */
function bilingualArtifactTrust(
    artifact: HTMLElement,
    state: TranslationState,
): 'trusted' | 'drift' | 'tampered' {
    if (isTrustedBilingualArtifactWithHostClass(artifact, state)) return 'trusted';
    return bilingualWrapperAttributesMatch(artifact, state) &&
        bilingualContentMatchesSnapshot(artifact, state) ? 'drift' : 'tampered';
}

/**
 * 工件归属与在位：wrapper 仍是本代的直属工件且仍然挂载。用于区分两种情形——
 * “工件漂移但仍是我们的”（可本地重建）与“工件被移除或替换”。
 */
export function isOwnedBilingualArtifactAttached(node: HTMLElement, state: TranslationState): boolean {
    const wrapper = state.bilingualContent;
    if (!wrapper || wrapper.parentNode !== node || !wrapper.isConnected) return false;
    if (!wrapper.matches(BILINGUAL_ARTIFACT_SELECTOR)) return false;
    const directWrappers = Array.from(node.children).filter((child) =>
        child.matches(BILINGUAL_ARTIFACT_SELECTOR));
    return directWrappers.length === 1 && directWrappers[0] === wrapper;
}

/**
 * 宿主把工件改写成了“属性漂移”形态：外层属性完好，内部只发生链接提示属性变化。
 * 站点脚本会在指针划过译文里的链接时反复增删 title，按篡改处理就会与站点互相
 * 覆盖，最终耗尽持久预算并撤下译文；这类写入必须按当前工件保留。
 */
export function isBilingualArtifactDriftOnly(node: HTMLElement, state: TranslationState): boolean {
    if (state.phase !== 'translated' || state.mode !== 'bilingual' || state.kind !== 'content') return false;
    const wrapper = state.bilingualContent;
    return Boolean(wrapper && isOwnedBilingualArtifactAttached(node, state) &&
        bilingualArtifactTrust(wrapper, state) === 'drift');
}

/**
 * 宿主保留 owner 和完全相同的原文结构，但在 React/Vue commit 中删除了
 * 未知子节点时，在 MutationObserver 的同一个渲染检查点内重挂已有译文。
 * 只接受精确 sourceHTML 和译文 HTML 快照；任一不符都交回 runtime 走正常重译。
 */
export function tryRepairBilingualTranslationArtifact(
    node: HTMLElement,
    state: TranslationState,
    reconcileLayout?: (owner: HTMLElement) => boolean,
): BilingualArtifactRepairResult {
    if (
        states.get(node) !== state ||
        state.phase !== 'translated' ||
        state.mode !== 'bilingual' ||
        state.kind !== 'content' ||
        !node.isConnected ||
        state.sourceStructureDirty ||
        !currentBilingualSourceStructureMatches(node, state)
    ) return 'not-repairable';

    const wrapper = state.bilingualContent;
    const directOwnedArtifacts = Array.from(node.children)
        .filter((child) => child.matches('[data-fr-translation-owned="true"]')) as HTMLElement[];
    const directWrappers = directOwnedArtifacts.filter((child) => child.matches(BILINGUAL_ARTIFACT_SELECTOR));
    const currentArtifact = directOwnedArtifacts.length === 1 && directWrappers.length === 1
        ? directWrappers[0] : undefined;
    if (currentArtifact) {
        const trust = bilingualArtifactTrust(currentArtifact, state);
        if (trust === 'trusted') {
            state.bilingualContent = currentArtifact;
            state.bilingualOuterHTML = currentArtifact.outerHTML;
            refreshOwnershipIndex(node, state);
            return 'repaired';
        }
        // 链接提示属性漂移不影响目的地、可见性、结构和文本，不需要重建：
        // 站点脚本会在指针划过译文里的链接时反复增删 title，若每次都重写宿主 DOM，
        // 就会与站点互相覆盖并最终耗尽预算、撤下译文。这里既不重写也不计费，
        // 需要与新 DOM 同步时由 refreshBilingualTranslationSkeleton 按需重建。
        if (trust === 'drift') {
            state.bilingualContent = currentArtifact;
            refreshOwnershipIndex(node, state);
            return 'tolerated';
        }
    }
    const detachedTrustedWrapper = wrapper?.parentNode === null &&
        isTrustedBilingualArtifactWithHostClass(wrapper, state) ? wrapper : undefined;
    const trustedTemplate = state.bilingualContentTemplate;
    if (!trustedTemplate || !isTrustedBilingualArtifactWithHostClass(trustedTemplate, state)) {
        return 'not-repairable';
    }
    if (isTranslationSourceStructureOverflow(state.sourceStructureSignature)) {
        rebindOverflowSourceTextNodes(node, state);
    }
    const artifactWasTampered = directOwnedArtifacts.length > 0 ||
        Boolean(wrapper && wrapper.parentNode !== null) || Boolean(wrapper && !detachedTrustedWrapper);
    if (!consumeBilingualArtifactHostWriteBudget(node, state, artifactWasTampered)) {
        directOwnedArtifacts.forEach((artifact) => artifact.remove());
        if (wrapper?.parentNode) wrapper.remove();
        return 'capitulated';
    }

    directOwnedArtifacts.forEach((artifact) => artifact.remove());
    if (wrapper?.parentNode) wrapper.remove();
    const content = detachedTrustedWrapper ?? trustedTemplate.cloneNode(true) as HTMLElement;
    node.appendChild(content);
    if (reconcileLayout && !reconcileLayout(node)) {
        content.remove();
        return 'rejected-after-write';
    }
    state.bilingualContent = content;
    state.bilingualOuterHTML = content.outerHTML;
    state.renderedStyleAttribute = node.getAttribute('style');
    state.renderedClassAttribute = node.getAttribute('class');
    refreshOwnershipIndex(node, state);
    return 'repaired';
}

function getStylePropertyValue(style: CSSStyleDeclaration, property: string): string {
    return style.getPropertyValue(property) ?? "";
}

function semanticStructureClasses(value: string | null): string {
    if (!value) return '';
    const names = new Set(value.split(/\s+/u));
    return [
        'notranslate', 'sr-only', 'visually-hidden',
        'MathJax_Display', 'MathJax', 'MathJax_Preview', 'katex',
    ].filter((name) => names.has(name)).join(' ');
}

function semanticVisibilityStyle(element: Element, value: string | null): string {
    const {display, visibility} = semanticVisibilityStyleValues(element, value);
    return JSON.stringify([display, visibility]);
}

function semanticVisibilityStyleValues(
    element: Element,
    value: string | null,
): {display: string; visibility: string} {
    const probe = element.ownerDocument.createElement('span');
    probe.setAttribute('style', value ?? '');
    return {display: probe.style.display, visibility: probe.style.visibility};
}

function isWithinTranslationArtifact(node: Node, state: TranslationState): boolean {
    return [state.spinner, state.settledSpinner, state.bilingualContent, state.retryWrapper]
        .some((artifact) => Boolean(artifact && (node === artifact || artifact.contains(node))));
}

function rebindOverflowSourceTextNodes(owner: HTMLElement, state: TranslationState): void {
    const protectionOptions = state.allowTopLevelApplicationShell === true
        ? {allowTopLevelApplicationShell: true, protectedElement: owner}
        : {protectedElement: owner};
    state.sourceTextNodes = collectLiveTranslationTextSlots(
        owner,
        getCurrentTranslationCore(state.scope).shouldStayOriginal,
        state.syntheticSegment ? owner : undefined,
        protectionOptions,
    ).map((slot) => slot.node);
}

function dirtyOverflowOwnerForMutation(
    owner: HTMLElement,
    state: TranslationState,
    mutation: MutationRecord,
): boolean | undefined {
    if (state.phase !== 'translated' || state.mode !== 'bilingual' || state.kind !== 'content' ||
        !isTranslationSourceStructureOverflow(state.sourceStructureSignature)) return;
    if (isWithinTranslationArtifact(mutation.target, state)) return false;
    if (mutation.type === 'childList') {
        const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
        if (changed.length > 0 && changed.every((node) => isWithinTranslationArtifact(node, state))) return false;
    }
    if (mutation.type === 'attributes' && mutation.attributeName === 'style' &&
        semanticVisibilityStyle(mutation.target as Element, mutation.oldValue) ===
            semanticVisibilityStyle(mutation.target as Element,
                (mutation.target as Element).getAttribute('style'))) return false;
    if (mutation.type === 'attributes' && mutation.attributeName === 'class' &&
        semanticStructureClasses(mutation.oldValue) ===
            semanticStructureClasses((mutation.target as Element).getAttribute('class'))) return false;
    if (getTranslationOverflowGenerationIdentity(owner) === state.sourceOverflowGenerationIdentity) {
        rebindOverflowSourceTextNodes(owner, state);
        return false;
    }
    state.sourceStructureDirty = true;
    return true;
}

function stateOwnerForMutation(
    mutation: MutationRecord,
    fallbackOwners: Set<WeakRef<HTMLElement>>,
): HTMLElement | undefined {
    let current = mutation.target.nodeType === 1
        ? mutation.target as Element
        : mutation.target.parentElement;
    let depth = 0;
    while (current && depth < SOURCE_MUTATION_ANCESTOR_DEPTH_BUDGET) {
        depth += 1;
        if (states.has(current as HTMLElement)) return current as HTMLElement;
        if (current.parentElement) current = current.parentElement;
        else {
            const root = current.getRootNode?.();
            current = root && root.nodeType === 11 ? (root as ShadowRoot).host : null;
        }
    }
    if (!current) return;

    let closest: HTMLElement | undefined;
    fallbackOwners.forEach((ref) => {
        const owner = ref.deref();
        if (!owner || !states.has(owner)) {
            fallbackOwners.delete(ref);
            return;
        }
        if (owner !== mutation.target && !owner.contains(mutation.target)) return;
        if (!closest || closest.contains(owner)) closest = owner;
    });
    return closest;
}

function currentTranslationOwnerIsProtected(
    owner: HTMLElement,
    state: TranslationState,
): boolean {
    const identityOwner = state.syntheticSegment ? state.syntheticHost : owner;
    if (!identityOwner?.isConnected) return true;
    const options = state.allowTopLevelApplicationShell === true
        ? {allowTopLevelApplicationShell: true, protectedElement: identityOwner}
        : {protectedElement: identityOwner};
    let current: Element | null = identityOwner;
    let depth = 0;
    while (current && depth < SOURCE_MUTATION_ANCESTOR_DEPTH_BUDGET) {
        if (isProtectedDescendantElement(current, false, options)) return true;
        current = getComposedParent(current);
        depth += 1;
    }
    return current !== null;
}

function mutationChangesDescendantEligibility(mutation: MutationRecord): boolean {
    if (mutation.type !== 'attributes' || mutation.target.nodeType !== 1) return false;
    if (mutation.attributeName === 'class') {
        return semanticStructureClasses(mutation.oldValue) !==
            semanticStructureClasses((mutation.target as Element).getAttribute('class'));
    }
    if (mutation.attributeName === 'style') {
        return semanticVisibilityStyle(mutation.target as Element, mutation.oldValue) !==
            semanticVisibilityStyle(
                mutation.target as Element,
                (mutation.target as Element).getAttribute('style'),
            );
    }
    return true;
}

function scheduleTranslationLayoutRefresh(owner: HTMLElement, removedNodes: readonly Node[] = []): void {
    let pending = pendingLayoutRefreshes.get(owner);
    if (pending) {
        removedNodes.forEach((node) => pending?.removedNodes.add(node));
        return;
    }

    pending = {removedNodes: new Set(removedNodes)};
    pendingLayoutRefreshes.set(owner, pending);
    const flush = () => {
        if (pendingLayoutRefreshes.get(owner) !== pending) return;
        pendingLayoutRefreshes.delete(owner);
        const state = states.get(owner);
        if (!state) return;
        // 外部管理器拥有来源/工件生命周期；独立状态仍拥有布局租约。resize 可只
        // 改变媒体查询而不产生 mutation，此时只复核在位的已提交工件，不恢复/中止。
        if (bilingualLifecycleExternallyManaged?.()) {
            if (owner.isConnected && state.phase === 'translated' && state.mode === 'bilingual' &&
                state.kind === 'content' && state.bilingualContent?.parentNode === owner) {
                ensureTranslationTruncationLayout(owner);
            }
            return;
        }

        // 从当前检查点起，在所有 MutationObserver 回调之后执行；这样全文观察器可以先
        // 注销自己的索引，再由独立悬浮翻译释放共享状态。
        if (!owner.isConnected) {
            discardTranslation(owner, state);
            return;
        }
        if (state.kind === 'content' && currentTranslationOwnerIsProtected(owner, state)) {
            restoreTranslation(owner);
            return;
        }
        if (state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content') {
            if (!currentBilingualSourceStructureMatches(owner, state)) {
                // 结构签名包含 title/href 等会写入骨架的属性。宿主只改写这些属性时
                // 可译文本未变，重建骨架并复用已提交译文，不能直接把译文撕下来：
                // 悬停预览会反复增删链接 title，否则每次划过都会丢译文并重新请求。
                if (bilingualSkeletonRefreshHandler?.(owner, state)) return;
                restoreTranslation(owner);
                return;
            }
            const repair = tryRepairBilingualTranslationArtifact(owner, state);
            if (repair !== 'repaired' && repair !== 'tolerated') {
                if (repair === 'capitulated') bilingualArtifactCapitulationHandler?.(owner, state);
                restoreTranslation(owner);
                return;
            }
        }
        if (state.sourceStructureDirty) {
            restoreTranslation(owner);
            return;
        }

        const expectedArtifact = state.phase === "translated" && state.mode === "bilingual"
            ? state.bilingualContent
            : state.phase === "loading"
                ? state.spinner
                : state.phase === "error"
                    ? state.retryWrapper
                    : undefined;
        if (expectedArtifact && expectedArtifact.parentNode !== owner) {
            const repair = tryRepairBilingualTranslationArtifact(owner, state);
            if (repair === 'repaired' || repair === 'capitulated') return;
            restoreTranslation(owner);
            return;
        }

        if (state.phase === "translated" && state.mode === "bilingual" &&
            state.kind === "content" && state.bilingualContent?.parentNode === owner &&
            !ensureTranslationTruncationLayout(owner)) {
            restoreTranslation(owner);
        }
    };
    const enqueue = globalThis.queueMicrotask ?? ((callback: VoidFunction) => Promise.resolve().then(callback));
    enqueue(flush);
}

function createTranslationLayoutRootObserver(root: TranslationLayoutObserverRoot): TranslationLayoutRootObserver | undefined {
    const document = root.nodeType === 9 ? root as Document : (root as ShadowRoot).ownerDocument;
    const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const target = root.nodeType === 9 ? (root as Document).documentElement : root;
    if (typeof Observer !== "function" || !target) return undefined;
    const owners = new Set<WeakRef<HTMLElement>>();

    const observer = new Observer((mutations) => {
        if (bilingualLifecycleExternallyManaged?.()) return;
        bilingualOwnerRemountHandler?.(mutations);
        mutations.forEach((mutation) => {
            const mutationOwner = stateOwnerForMutation(mutation, owners);
            if (mutationOwner) {
                const state = states.get(mutationOwner);
                if (state) dirtyOverflowOwnerForMutation(mutationOwner, state, mutation);
                scheduleTranslationLayoutRefresh(mutationOwner);
            }
            if (mutation.type === "childList") {
                mutation.removedNodes.forEach((removed) => {
                    getTranslationOwnersForRemovedNode(removed)
                        .forEach((owner) => scheduleTranslationLayoutRefresh(owner, [removed]));
                });
                return;
            }
            if (mutation.type !== "attributes" || mutation.target.nodeType !== 1) return;

            const element = mutation.target as HTMLElement;
            const override = sharedLayoutOverrides.get(element);
            if (mutation.attributeName === "style" && override &&
                element.getAttribute("style") === override.renderedStyleAttribute) return;

            getTranslationOwnersForIndexedNode(element).forEach((owner) => {
                const state = states.get(owner);
                if (state && (element === owner || state.layoutWatchElements?.has(element))) {
                    scheduleTranslationLayoutRefresh(owner);
                }
            });
            if (mutationChangesDescendantEligibility(mutation)) {
                owners.forEach((ref) => {
                    const owner = ref.deref();
                    const state = owner ? states.get(owner) : undefined;
                    if (!owner || !state) {
                        owners.delete(ref);
                        return;
                    }
                    const identityOwner = state.syntheticSegment ? state.syntheticHost : owner;
                    if (identityOwner && element.contains(identityOwner)) {
                        scheduleTranslationLayoutRefresh(owner);
                    }
                });
            }
        });
    });
    observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["style", "class", ...SOURCE_STRUCTURE_ATTRIBUTES],
        characterData: true,
    });
    // 只在有活动译文时响应真实窗口尺寸变化；不轮询、不观察尺寸写入，避免布局反馈循环。
    const view = document.defaultView;
    const handleResize = () => {
        owners.forEach((ref) => {
            const owner = ref.deref();
            if (owner) scheduleTranslationLayoutRefresh(owner);
        });
    };
    view?.addEventListener("resize", handleResize);
    return {observer, owners, releaseResizeListener: () => view?.removeEventListener("resize", handleResize)};
}

function retainTranslationLayoutRoot(owner: HTMLElement, root: TranslationLayoutObserverRoot): void {
    let observerState = layoutObserversByRoot.get(root);
    if (!observerState) {
        observerState = createTranslationLayoutRootObserver(root);
        if (!observerState) return;
        layoutObserversByRoot.set(root, observerState);
    }
    observerState.owners.add(trackActiveNode(owner));
}

function releaseTranslationLayoutRoot(owner: HTMLElement, root: TranslationLayoutObserverRoot): void {
    const observerState = layoutObserversByRoot.get(root);
    if (!observerState) return;
    const ownerRef = activeRefsByNode.get(owner);
    if (ownerRef) observerState.owners.delete(ownerRef);
    // 只需知道是否还有活跃 owner。找到第一个便停止，最后一次释放才会扫掉剩余死引用。
    for (const ref of observerState.owners) {
        const candidate = ref.deref();
        if (candidate && states.has(candidate)) return;
        observerState.owners.delete(ref);
    }
    observerState.observer.disconnect();
    observerState.releaseResizeListener();
    layoutObserversByRoot.delete(root);
}

function restoreSharedTranslationLayoutOverride(
    element: HTMLElement,
    override: SharedTranslationLayoutOverride,
): void {
    layoutStyleVersion += 1;
    if (override.canRestoreExactStyleAttribute &&
        element.getAttribute("style") === override.renderedStyleAttribute) {
        if (override.originalStyleAttribute === null) element.removeAttribute("style");
        else element.setAttribute("style", override.originalStyleAttribute);
    } else {
        override.properties.forEach((property) => {
            const currentValue = getStylePropertyValue(element.style, property.property);
            const currentPriority = getStylePropertyPriority(element.style, property.property);
            if (currentValue !== property.appliedValue || currentPriority !== property.appliedPriority) return;
            if (property.originalValue) {
                element.style.setProperty(
                    property.property,
                    property.originalValue,
                    property.originalPriority,
                );
            } else {
                element.style.removeProperty(property.property);
            }
        });
        if (override.originalStyleAttribute === null && element.getAttribute("style") === "") {
            element.removeAttribute("style");
        }
    }
    sharedLayoutOverrides.delete(element);
}

function liveSharedTranslationLayoutOverride(
    element: HTMLElement,
): SharedTranslationLayoutOverride | undefined {
    let override = sharedLayoutOverrides.get(element);
    if (!override) return undefined;
    const disconnectedOwners: HTMLElement[] = [];
    override.owners.forEach((ref) => {
        const owner = ref.deref();
        if (!owner || !states.has(owner)) override?.owners.delete(ref);
        else if (!owner.isConnected) disconnectedOwners.push(owner);
    });
    disconnectedOwners.forEach((owner) => {
        const state = states.get(owner);
        if (state) discardTranslation(owner, state);
    });
    override = sharedLayoutOverrides.get(element);
    if (!override) return undefined;
    if (override.owners.size > 0) return override;
    restoreSharedTranslationLayoutOverride(element, override);
    return undefined;
}

export function hasTranslationLayoutOverride(element: HTMLElement): boolean {
    return liveSharedTranslationLayoutOverride(element) !== undefined;
}

function translationLayoutAncestorChain(owner: HTMLElement): HTMLElement[] {
    const ancestors: HTMLElement[] = [];
    let current = getComposedParent(owner);
    let depth = 0;
    while (current && current !== owner.ownerDocument.body && depth < maxTranslationLayoutAncestorDepth) {
        depth += 1;
        const HTMLElementConstructor = current.ownerDocument.defaultView?.HTMLElement;
        if (HTMLElementConstructor && current instanceof HTMLElementConstructor) {
            ancestors.push(current as HTMLElement);
        }
        current = getComposedParent(current);
    }
    return ancestors;
}

function translationLayoutObserverRoots(
    owner: HTMLElement,
    watchElements: ReadonlySet<HTMLElement>,
): Set<TranslationLayoutObserverRoot> {
    const roots = new Set<TranslationLayoutObserverRoot>();
    for (const element of [owner, ...watchElements]) {
        const root = element.getRootNode();
        if (root.nodeType === 9) roots.add(root as Document);
        else if (root.nodeType === 11 && "host" in root) roots.add(root as ShadowRoot);
    }
    return roots;
}

function updateTranslationLayoutObservers(
    owner: HTMLElement,
    state: TranslationState,
    watchElements: ReadonlySet<HTMLElement>,
): void {
    const previousRoots = state.layoutObserverRoots ?? new Set<TranslationLayoutObserverRoot>();
    const nextRoots = translationLayoutObserverRoots(owner, watchElements);
    previousRoots.forEach((root) => {
        if (!nextRoots.has(root)) releaseTranslationLayoutRoot(owner, root);
    });
    nextRoots.forEach((root) => {
        if (!previousRoots.has(root)) retainTranslationLayoutRoot(owner, root);
    });
    state.layoutObserverRoots = nextRoots;
}

function releaseTranslationLayoutOverride(
    owner: HTMLElement,
    state: TranslationState,
    element: HTMLElement,
): void {
    const override = sharedLayoutOverrides.get(element);
    const ownerRef = activeRefsByNode.get(owner);
    if (override && ownerRef) override.owners.delete(ownerRef);
    if (override) {
        // 与共享观察器相同，只需找到一个存活租户就能确认还不能恢复样式。
        // 批量恢复同一裁剪容器的段落时，不能为每个段落重新扫描所有兄弟。
        for (const ref of override.owners) {
            const candidate = ref.deref();
            if (candidate && states.has(candidate)) break;
            override.owners.delete(ref);
        }
    }
    const restored = override?.owners.size === 0;
    if (restored) restoreSharedTranslationLayoutOverride(element, override!);
    state.layoutOverrideElements?.delete(element);
}

/**
 * 租用一个宿主元素的截断属性。首个所有者记录并应用覆盖，后续所有者共享该租约，
 * 因此恢复一个段落不会隐藏共用同一裁剪容器的已翻译兄弟段落。
 */
export function acquireTranslationLayoutOverride(
    owner: HTMLElement,
    element: HTMLElement,
    overrides: readonly TranslationLayoutStyleOverride[],
): boolean {
    const state = states.get(owner);
    if (!state) return false;
    const ownerRef = trackActiveNode(owner);

    const existing = liveSharedTranslationLayoutOverride(element);
    if (existing) {
        // 同一容器可能先解除 line-clamp，插入译文后才暴露固定高度；追加缺失属性，
        // 保留首个所有者的快照，不能把扩展已写入的样式重新当成宿主原样式。
        if (element.getAttribute("style") !== existing.renderedStyleAttribute) {
            existing.canRestoreExactStyleAttribute = false;
            layoutStyleVersion += 1;
        }
        overrides.filter(({property}) => !existing.properties.some((item) => item.property === property))
            .forEach(({property, value, priority}) => {
                const originalValue = getStylePropertyValue(element.style, property);
                const originalPriority = getStylePropertyPriority(element.style, property);
                layoutStyleVersion += 1;
                element.style.setProperty(property, value, priority);
                existing.properties.push({
                    property, overrideValue: value, overridePriority: priority, originalValue, originalPriority,
                    appliedValue: getStylePropertyValue(element.style, property),
                    appliedPriority: getStylePropertyPriority(element.style, property),
                });
            });
        existing.renderedStyleAttribute = element.getAttribute("style");
        existing.owners.add(ownerRef);
        (state.layoutOverrideElements ??= new Set()).add(element);
        refreshOwnershipIndex(owner, state);
        return true;
    }

    const originalStyleAttribute = element.getAttribute("style");
    const properties = overrides.map(({property, value, priority}) => {
        const originalValue = getStylePropertyValue(element.style, property);
        const originalPriority = getStylePropertyPriority(element.style, property);
        layoutStyleVersion += 1;
        element.style.setProperty(property, value, priority);
        return {
            property,
            overrideValue: value,
            overridePriority: priority,
            originalValue,
            originalPriority,
            appliedValue: getStylePropertyValue(element.style, property),
            appliedPriority: getStylePropertyPriority(element.style, property),
        };
    });
    const override: SharedTranslationLayoutOverride = {
        originalStyleAttribute,
        renderedStyleAttribute: element.getAttribute("style"),
        properties,
        owners: new Set([ownerRef]),
        canRestoreExactStyleAttribute: true,
    };
    sharedLayoutOverrides.set(element, override);
    (state.layoutOverrideElements ??= new Set()).add(element);
    refreshOwnershipIndex(owner, state);
    return true;
}

/** 仅在 style 属性精确相等时视为扩展写入，使同一微任务中的宿主页写入保持权威。 */
export function isTranslationLayoutOverrideMutation(element: HTMLElement): boolean {
    const override = sharedLayoutOverrides.get(element);
    return Boolean(override && element.getAttribute("style") === override.renderedStyleAttribute);
}

/** 先以宿主页样式写入为新基线，再让所有活动双语 wrapper 继续保持无截断。 */
export function reconcileTranslationLayoutOverrides(owner: HTMLElement): boolean {
    const state = states.get(owner);
    if (!state) return false;
    for (const element of state.layoutOverrideElements ?? []) {
        const override = liveSharedTranslationLayoutOverride(element);
        if (!override) continue;
        if (!element.isConnected || (element !== owner &&
            !state.layoutWatchElements?.has(element) && !element.contains(owner))) return false;

        if (element.getAttribute("style") !== override.renderedStyleAttribute) {
            override.canRestoreExactStyleAttribute = false;
            layoutStyleVersion += 1;
        }
        override.properties.forEach((property) => {
            const currentValue = getStylePropertyValue(element.style, property.property);
            const currentPriority = getStylePropertyPriority(element.style, property.property);
            if (currentValue === property.appliedValue && currentPriority === property.appliedPriority) return;
            property.originalValue = currentValue;
            property.originalPriority = currentPriority;
            layoutStyleVersion += 1;
            element.style.setProperty(
                property.property,
                property.overrideValue,
                property.overridePriority,
            );
            property.appliedValue = getStylePropertyValue(element.style, property.property);
            property.appliedPriority = getStylePropertyPriority(element.style, property.property);
        });
        override.renderedStyleAttribute = element.getAttribute("style");
    }
    return true;
}

/** 宿主把容器改为滚动/定位边界时，只撤销高度属性，保留同一容器的截断租约。 */
function releaseTranslationHeightOverride(element: HTMLElement): void {
    const override = sharedLayoutOverrides.get(element);
    const property = override?.properties.find((item) => item.property === "height");
    if (!override || !property) return;
    layoutStyleVersion += 1;
    if (element.getAttribute("style") !== override.renderedStyleAttribute) {
        override.canRestoreExactStyleAttribute = false;
    }
    if (getStylePropertyValue(element.style, "height") === property.appliedValue &&
        getStylePropertyPriority(element.style, "height") === property.appliedPriority) {
        if (property.originalValue) element.style.setProperty("height", property.originalValue, property.originalPriority);
        else element.style.removeProperty("height");
    }
    override.properties = override.properties.filter((item) => item !== property);
    override.renderedStyleAttribute = element.getAttribute("style");
    if (override.properties.length > 0) return;
    override.owners.forEach((ref) => {
        const owner = ref.deref();
        const state = owner ? states.get(owner) : undefined;
        if (owner && state) {
            state.layoutOverrideElements?.delete(element);
            refreshOwnershipIndex(owner, state);
        }
    });
    restoreSharedTranslationLayoutOverride(element, override);
}

/** 从内向外解除实际截断及高度溢出，保留滚动/定位边界，并释放重挂后过期的租约。 */
export function ensureTranslationTruncationLayout(
    owner: HTMLElement,
    measurements: TranslationLayoutMeasurements = createTranslationLayoutMeasurements(),
): boolean {
    const state = states.get(owner);
    if (!state || !owner.isConnected) return false;
    synchronizeTranslationLayoutMeasurements(measurements);

    const ancestors = translationLayoutAncestorChain(owner);
    const watchElements = new Set(ancestors);
    state.layoutWatchElements = watchElements;
    refreshOwnershipIndex(owner, state);
    updateTranslationLayoutObservers(owner, state, watchElements);

    const chain = [owner, ...ancestors];
    for (const element of Array.from(state.layoutOverrideElements ?? [])) {
        if (!chain.includes(element)) releaseTranslationLayoutOverride(owner, state, element);
    }
    // 先吸收宿主对已租用属性的改写；新增属性不能掩盖这些新的恢复基线。
    if (!reconcileTranslationLayoutOverrides(owner)) return false;
    synchronizeTranslationLayoutMeasurements(measurements);
    const hasBilingualContent = state.mode === "bilingual" && state.kind === "content" &&
        Boolean(owner.querySelector(BILINGUAL_ARTIFACT_SELECTOR));
    let heightBoundary = !hasBilingualContent;
    let branch = owner;
    for (const element of chain) {
        // 接管可能清理断开的最后旧租户并恢复裁剪；必须先收敛租约，再读取当前布局。
        if (sharedLayoutOverrides.has(element)) {
            acquireTranslationLayoutOverride(owner, element, []);
            synchronizeTranslationLayoutMeasurements(measurements);
        }
        const elementIsBoundary = isTranslationHeightBoundary(element, measurements);
        if (elementIsBoundary) {
            releaseTranslationHeightOverride(element);
            synchronizeTranslationLayoutMeasurements(measurements);
        }
        const truncation = hasActiveTranslationTruncation(element, measurements);
        if (truncation) {
            // 有些站点把 line-clamp 与固定 height、overflow:hidden 同时设在译文 owner 上。
            // 只解除行数限制仍会把中文裁在盒子外；此处一并恢复自然高度，并由租约负责还原。
            const overrides = hasActiveTranslationLineClamp(element, measurements)
                ? [...translationTruncationStyleOverrides, ...translationHeightStyleOverrides]
                : translationTruncationStyleOverrides;
            acquireTranslationLayoutOverride(owner, element, overrides);
            synchronizeTranslationLayoutMeasurements(measurements);
        }
        heightBoundary ||= elementIsBoundary;
        // 必须在解除当前内层 clamp 后读外层几何；先收集全部祖先会读到尚未展开的旧高度。
        if (!heightBoundary && hasTranslationHeightOverflow(element, branch, measurements)) {
            acquireTranslationLayoutOverride(owner, element, translationHeightStyleOverrides);
            synchronizeTranslationLayoutMeasurements(measurements);
        }
        branch = element;
    }
    refreshOwnershipIndex(owner, state);
    const reconciled = reconcileTranslationLayoutOverrides(owner);
    synchronizeTranslationLayoutMeasurements(measurements);
    return reconciled;
}

/** 同一同步挂载批次共享祖先读数；每次布局写入立即失效，不跨任务复用。 */
export function createTranslationTruncationLayoutBatch(): (owner: HTMLElement) => boolean {
    const measurements = createTranslationLayoutMeasurements();
    return (owner) => ensureTranslationTruncationLayout(owner, measurements);
}

function releaseTranslationLayoutOverrides(owner: HTMLElement, state: TranslationState): void {
    state.layoutObserverRoots?.forEach((root) => releaseTranslationLayoutRoot(owner, root));
    state.layoutObserverRoots?.clear();
    Array.from(state.layoutOverrideElements ?? [])
        .forEach((element) => releaseTranslationLayoutOverride(owner, state, element));
    state.layoutOverrideElements?.clear();
    state.layoutWatchElements?.clear();
}

function removeExtensionNode(node: Node | undefined): void {
    if (node?.parentNode) node.parentNode.removeChild(node);
}

function clearState(node: HTMLElement): void {
    states.delete(node);
    clearOwnershipIndex(node);
    const ref = activeRefsByNode.get(node);
    if (ref) activeNodeRefs.delete(ref);
    activeRefsByNode.delete(node);
    notifyTranslationStateChange(node, undefined);
}

function unwrapSyntheticSegment(node: HTMLElement, state: TranslationState): void {
    if (!state.syntheticSegment || !node.parentNode) return;
    const parent = node.parentNode;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
}

function restoreOriginalStyle(node: HTMLElement, state: TranslationState): void {
    if (state.renderedStyleAttribute === undefined) return;
    if (node.getAttribute("style") !== state.renderedStyleAttribute ||
        state.originalStyleAttribute === state.renderedStyleAttribute) return;
    layoutStyleVersion += 1;

    if (state.originalStyleAttribute === null) {
        node.removeAttribute("style");
    } else {
        node.setAttribute("style", state.originalStyleAttribute);
    }
}

function restoreOriginalClass(node: HTMLElement, state: TranslationState): void {
    if (state.renderedClassAttribute === undefined) return;
    clearTranslationFailedHost(node);
}

/**
 * 恢复单个节点并清理状态。
 * 双语模式只移除译文节点；single/control 只恢复仍保持插件译值的 Text。
 * 宿主在翻译期间写入的新 DOM 或新文本永远不会被旧快照覆盖。
 */
export function restoreTranslation(node: HTMLElement): boolean {
    const state = states.get(node);
    if (!state) return false;
    teardownAttempt(node, state, true);
    return true;
}

/**
 * 丢弃一个已经失效的请求，但保留站点在请求期间写入的内容。
 * 这与 restoreTranslation 不同：它只适用于翻译结果尚未写回页面的情况。
 */
export function discardTranslation(
    node: HTMLElement,
    state: TranslationState,
): boolean {
    if (states.get(node) !== state) return false;
    teardownAttempt(node, state, false);
    return true;
}

/**
 * 宿主 innerHTML/cloneNode 只会复制 single-slot 的轻 DOM 原文，无法复制 closed
 * ShadowRoot。清理前解包这些无主槽，同时保留精确注册给活跃 owner 的真实槽。
 * 只查询当前 root；身份检查不因槽内包含其他活跃 owner 就把外层克隆误认为自有。
 */
export function unwrapUnownedSingleTextSlots(root: Node): void {
    const slots: Element[] = [];
    if (root.nodeType === 1 && (root as Element).matches(SINGLE_TEXT_SLOT_SELECTOR)) slots.push(root as Element);
    const queryRoot = root as Node & ParentNode;
    if (typeof queryRoot.querySelectorAll === 'function') {
        slots.push(...Array.from(queryRoot.querySelectorAll(SINGLE_TEXT_SLOT_SELECTOR)));
    }
    slots.forEach((slot) => {
        if (!slot.parentNode || states.has(slot as HTMLElement) ||
            getTranslationOwnersForIndexedNode(slot).some((owner) =>
                states.get(owner)?.singleTextSlotHosts?.some(({host}) => host === slot))) return;
        const parent = slot.parentNode;
        while (slot.firstChild) parent.insertBefore(slot.firstChild, slot);
        parent.removeChild(slot);
    });
}

function teardownAttempt(
    node: HTMLElement,
    state: TranslationState,
    restoreTextSlots: boolean,
): void {
    state.generation += 1;
    state.controller.abort();

    // 仅译文槽的轻 DOM 保存原始 Text 节点，必须在通用扩展产物
    // 清理之前解包。宿主已移除或移走的槽保持宿主权威，不重新插回。
    state.singleTextSlotHosts?.forEach(({host}) => {
        if (!node.contains(host) || !host.parentNode) return;
        const parent = host.parentNode;
        while (host.firstChild) parent.insertBefore(host.firstChild, host);
        parent.removeChild(host);
    });
    // 同一 owner 可能还活着，但所有旧槽已被宿主克隆替换。必须在通用 owned
    // 删除前抢先解包克隆原文；恢复原文入口也不能依赖稍后才执行的 discovery。
    unwrapUnownedSingleTextSlots(node);

    removeExtensionNode(state.spinner);
    removeExtensionNode(state.settledSpinner);
    removeExtensionNode(state.bilingualContent);
    removeExtensionNode(state.retryWrapper);
    Array.from(node.children ?? [])
        .filter((child) => child.matches('[data-fr-translation-owned="true"]') &&
            !child.matches(SINGLE_TEXT_SLOT_SELECTOR))
        .forEach((artifact) => artifact.remove());
    releaseTranslationLayoutOverrides(node, state);

    if (restoreTextSlots && state.textSlotsApplied) {
        state.originalTextValues.forEach(({node: textNode, value}) => {
            if (!node.contains(textNode)) return;
            const translatedValue = state.translatedTextValues?.get(textNode);
            if (translatedValue === undefined || textNode.nodeValue === translatedValue) {
                textNode.nodeValue = value;
            }
        });
        const controlValue = state.controlValue;
        if (controlValue?.translated !== undefined &&
            node.getAttribute(controlValue.attribute) === controlValue.translated) {
            node.setAttribute(controlValue.attribute, controlValue.original);
        }
    }

    if (state.originalTooltipTranslationAttribute !== undefined &&
        node.getAttribute('data-fr-tooltip-translation-active') === 'true') {
        if (state.originalTooltipTranslationAttribute === null) node.removeAttribute('data-fr-tooltip-translation-active');
        else node.setAttribute('data-fr-tooltip-translation-active', state.originalTooltipTranslationAttribute);
    }
    restoreOriginalStyle(node, state);
    restoreOriginalClass(node, state);
    clearState(node);
    unwrapSyntheticSegment(node, state);
}

/** 提交实时文本前，把恢复快照原子绑定到已校验的当前来源节点。 */
export function setLiveTranslationSourceSnapshot(node: HTMLElement, textNodes: readonly Text[]): void {
    const state = states.get(node);
    if (!state) return;
    state.sourceTextNodes = [...textNodes];
    state.sourceHTML = node.innerHTML;
    // 等价重挂可能已经替换请求创建时的 Text；原值必须在本次写译文前捕获，
    // 才能恢复实际提交节点并保留宿主最新的前后空白。
    state.originalTextValues = textNodes.map((textNode) => ({node: textNode, value: textNode.nodeValue ?? ""}));
}

export function setTextSlotsApplied(
    node: HTMLElement,
    translatedTextNodes?: readonly Text[],
): void {
    const state = states.get(node);
    if (state) {
        state.textSlotsApplied = true;
        state.translatedTextNodes = translatedTextNodes
            ? [...translatedTextNodes]
            : state.originalTextValues.map(({node: textNode}) => textNode);
        state.translatedTextValues = new WeakMap(
            state.originalTextValues.map(({node: textNode}) => [textNode, textNode.nodeValue ?? ""]),
        );
    }
}

/** 按钮型 input 的译文写入属性后没有 Text 槽；用空文本槽集合复用同一套已渲染判定。 */
export function setControlValueApplied(node: HTMLElement, text: string): void {
    const state = states.get(node);
    if (!state?.controlValue) return;
    state.controlValue = {...state.controlValue, translated: text};
    setTextSlotsApplied(node, []);
}

export function setSingleTextSlotHosts(
    node: HTMLElement,
    hosts: readonly HTMLElement[],
): void {
    const state = states.get(node);
    if (!state) return;
    const originalValues = new WeakMap(
        state.originalTextValues.map(({node: textNode, value}) => [textNode, value]),
    );
    state.singleTextSlotHosts = hosts.flatMap((host) => {
        const source = Array.from(host.childNodes).find((child): child is Text => child.nodeType === 3);
        if (!source) return [];
        return [{host, source, sourceValue: originalValues.get(source) ?? source.nodeValue ?? ""}];
    });
    refreshOwnershipIndex(node, state);
}

/**
 * 查找宿主页移除节点所关联的翻译状态，包括被移除的翻译目标，以及所有者仍连接时
 * 被移除的加载指示器或双语 wrapper。只遍历移除子树并查询增量维护的所有权索引，
 * 从不扫描无关的活动翻译；runtime 会在通用工件过滤之前调用这里。
 */
export function getTranslationOwnersForRemovedNode(removed: Node): HTMLElement[] {
    const owners = new Set<HTMLElement>();
    const stack: Node[] = [removed];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;

        getTranslationOwnersForIndexedNode(current).forEach((owner) => owners.add(owner));

        if (current.nodeType === 1) {
            const shadowRoot = (current as Element).shadowRoot;
            if (shadowRoot) stack.push(shadowRoot);
        }

        const children = current.childNodes;
        for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children.item(index);
            if (child) stack.push(child);
        }
    }

    return [...owners];
}

/** 只解析直接索引在该节点上的所有者，并延迟清理已失效的弱引用。 */
export function getTranslationOwnersForIndexedNode(indexedNode: Node): HTMLElement[] {
    const refs = ownersByIndexedNode.get(indexedNode);
    if (!refs) return [];
    const owners = new Set<HTMLElement>();
    refs.forEach((ref) => {
        const owner = ref.deref();
        if (!owner || !states.has(owner)) refs.delete(ref);
        else owners.add(owner);
    });
    if (refs.size === 0) ownersByIndexedNode.delete(indexedNode);
    return [...owners];
}

/** 沿组合树判断 node 是否位于 root 之内；ShadowRoot 内的节点经由宿主继续向上。 */
function isWithinComposedRoot(root: Node, node: Node): boolean {
    for (let current: Node | null = node; current; current = current.parentNode ?? (current as ShadowRoot).host ?? null) {
        if (current === root) return true;
    }
    return false;
}

/**
 * 列出组合树中位于 root 之内的全部译文所有者（翻译中、已翻译和失败态）。只遍历当前活动译文，
 * 不扫描 root 的整棵子树；仅译文槽和合成行内段不会出现在候选发现里，因此局部翻译以此盘点和恢复区域。
 */
export function getTranslationOwnersWithin(root: Node): HTMLElement[] {
    const owners: HTMLElement[] = [];
    forEachActiveNode((node) => {
        if (isWithinComposedRoot(root, node)) owners.push(node);
    });
    return owners;
}

/**
 * closed ShadowRoot 会把点击/悬停命中重定向到仅译文 slot host。借助已有所有权索引
 * 恢复一个仅供 runtime 识别当前状态的候选；恢复原文后仍由 core 重新解析真实候选。
 */
export function getOwnedTranslationCandidateAtPoint(
    root: Document,
    x: number,
    y: number,
): TranslationCandidate | null {
    if (typeof root.elementsFromPoint !== "function") return null;
    for (const element of root.elementsFromPoint(x, y)) {
        const owner = getTranslationOwnersForIndexedNode(element)
            .find((candidate) => candidate === element || candidate.contains(element));
        const state = owner ? states.get(owner) : undefined;
        if (!owner || !state) continue;
        return {
            element: owner,
            kind: state.kind,
            reason: "existing-translation-at-point",
            ...(state.scope ? {scope: state.scope} : {}),
            ...(state.syntheticSegment && state.sourceTextNodes?.length
                ? {nodes: state.sourceTextNodes} : {}),
            ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {}),
        };
    }
    return null;
}

/**
 * 恢复所有由指定节点翻译状态机管理的节点。
 * Set 只用于可枚举生命周期；真正的状态仍然存储在 WeakMap 中。
 */
export function restoreAllTranslations(): void {
    const nodes: HTMLElement[] = [];
    forEachActiveNode((node) => nodes.push(node));
    withFullPageRestorationAnchors(() => nodes.forEach((node) => restoreTranslation(node)), nodes);
}
