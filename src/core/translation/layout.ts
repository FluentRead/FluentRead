/**
 * @file src/core/translation/layout.ts
 *
 * 文件职责：判定页面元素的语义块、内联关系和可重组边界，为候选引擎选择合理翻译粒度并保护页面布局；站点非原子行内容器保留直属正文，受信 man 手册说明段在悬浮和全文中共享正文块边界，并在通用层识别旧式连续换行分段容器（含 inline font/span 包装）。
 * 主要内容：按统一的按钮语义（原生 button、按钮型 input、ARIA 控件角色、按钮类名）与呈标签形态的交互外壳区分正文与控件；识别 heading、block、inline、纯文本正文 pre、结构标签、嵌入式 aside、可选放开的侧边栏区域和 reparent 边界，保持交互控件对内部标签的翻译所有权，并在 tooltip 边界停止向外归属，限制直接子节点探测数量，复验已渲染候选时把已验证原文槽视为透明包装，提供候选目标、旧式双 br 分段屏障及内联 run 相关的布局函数。 可核对的公开符号包括 isSemanticHeadingElement、getElementDisplay、isBlockBoundary、isStructuralContainer、hasStructuralAncestor、isTranslationControlElement、findTranslationControlOwner、hasDirectReadableText、hasReadableBlockChild、collectDoubleBrParagraphBarriers。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {
    getComposedParent,
    getElementTagName,
    getTranslatableControlValueAttribute,
    isTranslationTooltip,
    isDocumentSurface,
    isPlainTextDocumentPre,
    isProtectedTextElement,
    maxComposedAncestorDepth,
} from './dom';
import {
    hasMeaningfulTranslationTextInNodes,
} from './text';
import type {TranslationTextProtectionCache} from './text';
import type {TranslationTextProtectionOptions} from './dom';
import type {TranslationCandidateKind, TranslationScope} from './types';
import {isPreparedManpageParagraph} from './manpage';

// 这些上限把同步布局分类限制为有界工作；超限时按保守边界处理，避免大型页面阻塞主线程。
const maxDirectRunNodes = 2048;
const maxBlockChildrenToProbe = 128;

const semanticBlockTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
    'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody',
    'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

// 即使站点样式把这些元素设为 inline 或 display:contents，它们仍是语义内容单元。
// 将其移入合成内联 run wrapper 会破坏直接子选择器，甚至重挂整块文档区域
// （MDN 就以 display:contents 渲染 <main>）。通用 <div> 仍按实际布局判断，
// 因为透明 div wrapper 很常见；其余语义块均作为安全的重挂边界。
const semanticReparentBoundaryTags = new Set(
    [...semanticBlockTags].filter((tag) => tag !== 'div'),
);

const inlineTags = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'em', 'font', 'i', 'img',
    'mark', 'q', 'ruby', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
    'wbr',
]);

// 旧式静态网页与 CMS 常把整篇按 <br><br> 分段的正文放进透明 inline <font>/<span> 包装中。
const genericBrInlineWrapperTags = new Set(['font', 'span']);
const minGenericDoubleBrParagraphs = 3;

const inlineDisplays = new Set([
    'inline', 'inline-block', 'inline-flex', 'inline-grid', 'ruby', 'ruby-base',
    'ruby-base-container', 'ruby-text', 'ruby-text-container',
]);

const structuralTags = new Set(['aside', 'footer', 'header', 'nav']);
const semanticHeadingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const embeddedAsideClassTokens = new Set([
    'admonition', 'callout', 'caution', 'important', 'note', 'notice', 'tip', 'warning',
]);

/**
 * 标题是作者明确提供的内容地标。页面可能把标题放在语义 `<header>`，甚至导航外壳中，
 * 因此结构祖先不能屏蔽标题本身；硬守卫与站点裁剪决策仍具有更高优先级。
 */
export function isSemanticHeadingElement(element: Element): boolean {
    return semanticHeadingTags.has(getElementTagName(element));
}

export function getElementDisplay(element: Element): string {
    try {
        const view = element.ownerDocument?.defaultView;
        return view?.getComputedStyle(element).display.trim().toLowerCase() ?? '';
    } catch {
        return '';
    }
}

export function isBlockBoundary(element: Element): boolean {
    const tag = getElementTagName(element);
    if (isPreparedManpageParagraph(element)) return true;
    if (isPlainTextDocumentPre(element)) return true;
    if (semanticReparentBoundaryTags.has(tag)) return true;
    const display = getElementDisplay(element);
    if (display) {
        if (display === 'none') return false;
        // 透明布局 div 仍是 DOM 所有权边界；即使自身不生成盒子，把它移到合成 span 下
        // 也会改变 grid/flex 的直接子节点和 CSS 选择器结果。
        if (display === 'contents') return tag === 'div';
        if (inlineDisplays.has(display) || display.startsWith('inline')) return false;
        return true;
    }
    if (inlineTags.has(tag)) return false;
    return semanticBlockTags.has(tag);
}

function hasComposedAncestor(
    element: Element,
    predicate: (ancestor: Element) => boolean,
): boolean {
    let current: Element | null = getComposedParent(element);
    let depth = 0;
    while (current && !isDocumentSurface(current)) {
        depth += 1;
        // 祖先过深而无法安全分类时，不授予内容上下文例外；发现流程使用相同的硬深度上限。
        if (depth > maxComposedAncestorDepth) return false;
        if (predicate(current)) return true;
        current = getComposedParent(current);
    }
    return false;
}

function hasArticleAncestor(element: Element): boolean {
    return hasComposedAncestor(element, (ancestor) =>
        getElementTagName(ancestor) === 'article' ||
        ancestor.getAttribute('role')?.trim().toLowerCase() === 'article');
}

function hasMainAncestor(element: Element): boolean {
    return hasComposedAncestor(element, (ancestor) =>
        getElementTagName(ancestor) === 'main' ||
        ancestor.getAttribute('role')?.trim().toLowerCase() === 'main');
}

function isEmbeddedContentAside(element: Element): boolean {
    if (hasArticleAncestor(element)) return true;
    if (!hasMainAncestor(element)) return false;
    if (element.getAttribute('role')?.trim().toLowerCase() === 'note') return true;
    return Array.from(element.classList).some((token) =>
        embeddedAsideClassTokens.has(token.toLowerCase()));
}

/** 侧边栏翻译开启后，aside 与 nav 不再被当作只读页面框架。 */
export interface StructuralRegionOptions {
    includeSidebarRegions?: boolean;
}

/** An enabled nav/aside owns its descendants even when nested in a header or footer shell. */
export function isIncludedSidebarRegion(
    element: Element,
    regionOptions?: StructuralRegionOptions,
): boolean {
    return regionOptions?.includeSidebarRegions === true &&
        ['aside', 'nav'].includes(getElementTagName(element));
}

export function isStructuralContainer(
    element: Element,
    regionOptions?: StructuralRegionOptions,
): boolean {
    const tag = getElementTagName(element);
    if (!structuralTags.has(tag)) return false;
    // 用户显式要求翻译侧边栏时，只放开侧栏与导航；header/footer 仍是页面框架。
    if (regionOptions?.includeSidebarRegions && (tag === 'aside' || tag === 'nav')) return false;
    // 导航即使挂在文章内容内，仍属于页面框架控件。
    if (tag === 'nav') return true;
    // article 拥有其相关 aside；文档引擎也会在没有 article 的 <main> 下输出 note/callout
    // aside（例如 Swift DocC 的 <aside class="note">）。通用 main 级 aside 仍视为结构区域，
    // 因为其中常包含相关工具等页面框架。header/footer 同样保持为框架区域：文章 header
    // 经常混合可读 H1、元数据和编辑工具，H1 例外会单独分类。
    if (tag === 'aside' && isEmbeddedContentAside(element)) return false;
    return true;
}

export function hasStructuralAncestor(
    element: Element,
    regionOptions?: StructuralRegionOptions,
): boolean {
    if (isIncludedSidebarRegion(element, regionOptions)) return false;
    let current: Element | null = getComposedParent(element);
    let depth = 0;
    while (current && !isDocumentSurface(current)) {
        depth += 1;
        // 对恶意超深子树保守按结构区域处理；全文发现也会通过同一硬深度守卫裁剪它。
        if (depth > maxComposedAncestorDepth) return true;
        if (isIncludedSidebarRegion(current, regionOptions)) return false;
        if (isStructuralContainer(current, regionOptions)) return true;
        current = getComposedParent(current);
    }
    return false;
}

/**
 * 明确的按钮语义：原生 button、按钮型 input，以及 ARIA 明确声明为操作控件的角色。
 * 这些元素的文字是操作名而不是正文，宿主样式通常把它们钉在固定高度的一行里，
 * 因此无论识别范围是正文还是全部节点，都必须整体归属为控件并采用替换式译文。
 */
const nativeControlTags = new Set(['button']);

const nativeControlRoles = new Set([
    'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'switch', 'option', 'treeitem', 'radio', 'checkbox',
]);

/**
 * Bootstrap、Primer、Tailwind 生态统一用 `btn`/`button` 这两个精确 class token 标记
 * 按钮化的链接与容器（如 GitHub 的 `a.btn.btn-primary`）。token 是全等匹配，
 * 因此 `btn-group`、`button-label` 等包装类不会被误判；这类元素也从不出现在正文行内，
 * 可以安全地充当控件所有权边界。
 */
const buttonClassTokens = new Set(['btn', 'button']);

function hasButtonClassToken(element: Element): boolean {
    return Array.from(element.classList)
        .some((token) => buttonClassTokens.has(token.toLowerCase()));
}

export function isTranslationControlElement(element: Element): boolean {
    const tag = getElementTagName(element);
    if (nativeControlTags.has(tag)) return true;
    if (getTranslatableControlValueAttribute(element)) return true;
    const role = element.getAttribute('role')?.trim().toLowerCase();
    if (role) return nativeControlRoles.has(role);
    return hasButtonClassToken(element);
}

const allScopeControlRoles = new Set([
    'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'treeitem', 'option', 'checkbox', 'radio', 'switch',
]);
const allScopeControlTags = new Set(['a', 'button', 'label', 'summary', 'legend']);
const allScopeProseTags = new Set([
    'article', 'p', 'blockquote', 'address', 'figcaption', 'li', 'dt', 'dd', 'td', 'th',
]);
const allScopeUIRoles = new Set([
    'navigation', 'menu', 'menubar', 'tablist', 'tree', 'toolbar', 'listbox',
]);

function isAllScopeControl(element: Element): boolean {
    return allScopeControlTags.has(getElementTagName(element)) ||
        allScopeControlRoles.has(element.getAttribute('role')?.trim().toLowerCase() ?? '');
}

/**
 * 交互外壳：链接、表单标签、折叠摘要以及被作者手动设为可 Tab 聚焦的容器。
 * 它们既可能是工具栏里的操作标签，也可能是 FAQ 问句这类正文，因此不能像原生按钮那样
 * 无条件替换，必须再通过"标签形态"判定。`tabindex="-1"` 只用于程序化聚焦（模态、跳转锚点），
 * 不代表可操作，排除后可避免把整段内容区当成控件。
 */
function hasFocusableTabIndex(element: Element): boolean {
    const value = element.getAttribute('tabindex');
    if (value === null) return false;
    const index = Number.parseInt(value.trim(), 10);
    return Number.isFinite(index) && index >= 0;
}

function isInteractiveSurface(element: Element): boolean {
    return isAllScopeControl(element) || hasFocusableTabIndex(element);
}

// 控件标签是操作名，不是句子。超出该长度或带句末标点的文本按正文处理，保留双语对照。
const maxControlLabelLength = 64;
const sentenceEndingPattern = /[.!?。！？；;]$/u;

/**
 * 正文里的链接、FAQ 折叠标题等交互外壳仍然是要读的内容，双语对照有价值；
 * 工具栏里的短标签则和按钮一样受固定尺寸约束，插入第二行会撑破宿主布局。
 * 以"无可读块级子节点 + 标签形态文本"区分两者，避免把整段正文误判成控件。
 */
function isControlLabelSurface(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    if (hasReadableBlockChild(element, shouldStayOriginal, protectionCache, protectionOptions)) return false;
    // Element 的 textContent 恒为字符串（仅 Document/Doctype 为 null）。
    const text = element.textContent!.replace(/[\s\u3000]+/gu, ' ').trim();
    return text.length > 0 && text.length <= maxControlLabelLength && !sentenceEndingPattern.test(text);
}

/** 全部节点仍把完整段落/标题交给正文渲染；导航列表和应用标签使用原位文本槽。 */
export function getAllScopeCandidateKind(element: Element): TranslationCandidateKind {
    if (isPreparedManpageParagraph(element)) return 'content';
    if (isSemanticHeadingElement(element)) return 'content';
    if (isStructuralContainer(element) ||
        allScopeUIRoles.has(element.getAttribute('role')?.trim().toLowerCase() ?? '')) return 'control';
    if (!allScopeProseTags.has(getElementTagName(element)) &&
        element.getAttribute('role')?.trim().toLowerCase() !== 'article' &&
        !hasArticleAncestor(element)) return 'control';
    return hasComposedAncestor(element, (ancestor) =>
        isStructuralContainer(ancestor) ||
        isAllScopeControl(ancestor) ||
        allScopeUIRoles.has(ancestor.getAttribute('role')?.trim().toLowerCase() ?? ''))
        ? 'control'
        : 'content';
}

/**
 * 内联强调和链接沿用最近正文/控件的文本所有权，避免扩大范围后把现有段落细分成嵌套
 * 译文。普通应用 div/span 不形成该语义边界，因此独立标签仍可作为原位控件发现。
 */
function hasAllScopeSemanticOwner(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    let crossedUIBoundary = false;
    return hasComposedAncestor(element, (ancestor) => {
        crossedUIBoundary = crossedUIBoundary || isStructuralContainer(ancestor) ||
            allScopeUIRoles.has(ancestor.getAttribute('role')?.trim().toLowerCase() ?? '');
        return !crossedUIBoundary && (
            isAllScopeControl(ancestor) ||
            getAllScopeCandidateKind(ancestor) === 'content' ||
            collectDoubleBrParagraphBarriers(ancestor, shouldStayOriginal, protectionCache, protectionOptions) !== null
        );
    });
}

/**
 * 控件内的 flex/grid 标签属于同一个交互语义单元，不能因为生成块盒就成为双语段落。
 * 使用 composed 祖先也能覆盖开放 Shadow DOM 中的标签；保持与核心硬守卫相同的深度上限。
 */
export function findTranslationControlOwner(element: Element): Element | null {
    let current: Element | null = element;
    let depth = 0;
    while (current && !isDocumentSurface(current)) {
        if (depth > maxComposedAncestorDepth) return null;
        if (isTranslationTooltip(current)) return null;
        if (isTranslationControlElement(current)) return current;
        current = getComposedParent(current);
        depth += 1;
    }
    return null;
}

/**
 * 可点击卡片或菜单项可能包含独立操作按钮；这些边界不能被外层控件整块吞并。
 * 扫描超限时同样选择拆分标签，避免对异常宽深控件执行无界探测。
 */
function hasNestedTranslationControl(element: Element): boolean {
    const pending: Element[] = [element];
    let visited = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current !== element && isTranslationControlElement(current)) return true;
        visited += 1;
        const children = current.children;
        const shadowChildren = current.shadowRoot?.children;
        if (visited + pending.length + children.length + (shadowChildren?.length ?? 0) > maxDirectRunNodes) return true;
        pending.push(...Array.from(children), ...Array.from(shadowChildren ?? []));
    }
    return false;
}

export function hasDirectReadableText(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    if (element.childNodes.length > maxDirectRunNodes) return false;
    const inlineNodes = Array.from(element.childNodes).filter((child) =>
        child.nodeType === 3 || (child.nodeType === 1 && !isBlockBoundary(child as Element)));
    return hasMeaningfulTranslationTextInNodes(
        inlineNodes,
        shouldStayOriginal,
        protectionCache,
        protectionOptions,
    );
}

export function hasReadableBlockChild(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    if (element.children.length > maxBlockChildrenToProbe) return true;
    return Array.from(element.children).some((child) => {
        // flex/grid 会把自有原文槽 blockify；已验证的槽是渲染包装，不是独立正文块。
        // 只信任调用方完成来源与节点身份校验后提供的集合，不按 class 放行。
        if (protectionOptions?.sourceTextSlotHosts?.has(child)) return false;
        if (!isBlockBoundary(child)) return false;
        return hasMeaningfulTranslationTextInNodes(
            [child],
            shouldStayOriginal,
            protectionCache,
            protectionOptions,
        );
    });
}

const doubleBrBarrierCaches = new WeakMap<TranslationTextProtectionCache, WeakMap<Element, ReadonlySet<Element> | null>>();

function computeDoubleBrParagraphBarriers(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): ReadonlySet<Element> | null {
    // 至少两组双 <br> 才会产生三段；沿 firstChild/nextSibling 单趟扫描并在超限时立即退出，
    // 避免在宽容器上分配 childNodes/children 集合，也不对普通节点触发 getComputedStyle。
    let count = 0;
    let barriers: Set<Element> | null = null;
    let firstBr: Element | null = null;
    for (let child = element.firstChild; child; child = child.nextSibling) {
        count += 1;
        if (count > maxDirectRunNodes) return null;
        if (child.nodeType === 1 && getElementTagName(child as Element) === 'br') {
            const br = child as Element;
            if (!firstBr) {
                firstBr = br;
            } else {
                barriers ??= new Set();
                barriers.add(firstBr);
                barriers.add(br);
            }
            continue;
        }
        if ((child.nodeType === 3 && !/\S/u.test((child as Text).data)) || child.nodeType === 8) {
            continue;
        }
        firstBr = null;
    }
    if (!barriers || barriers.size < 4) return null;

    const tag = getElementTagName(element);
    if (!isBlockBoundary(element) && !genericBrInlineWrapperTags.has(tag)) return null;

    let paragraphs = 0;
    let current: ChildNode[] = [];
    const flushParagraph = () => {
        if (current.length > 0 && (
            current.some((node) => node.nodeType === 1 &&
                (node as Element).matches('[data-fr-translation-segment="true"]')) ||
            hasMeaningfulTranslationTextInNodes(current, shouldStayOriginal, protectionCache, protectionOptions)
        )) {
            paragraphs += 1;
        }
        current = [];
    };

    for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && (barriers.has(child as Element) || isBlockBoundary(child as Element))) {
            flushParagraph();
            continue;
        }
        current.push(child);
    }
    flushParagraph();
    return paragraphs >= minGenericDoubleBrParagraphs ? barriers : null;
}

/**
 * 识别由连续 `<br>`（至少两个直接子级换行标签，中间仅隔空白或注释）构成的旧式段落边界。
 * 只有分出至少三段有效内容或已物化分段槽时才返回屏障集合，避免拆开常规双段评论、短推文或诗行。
 */
export function collectDoubleBrParagraphBarriers(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
): ReadonlySet<Element> | null {
    let cache: WeakMap<Element, ReadonlySet<Element> | null> | undefined;
    if (protectionCache) {
        cache = doubleBrBarrierCaches.get(protectionCache);
        if (!cache) {
            cache = new WeakMap();
            doubleBrBarrierCaches.set(protectionCache, cache);
        }
        if (cache.has(element)) return cache.get(element)!;
    }
    const result = computeDoubleBrParagraphBarriers(element, shouldStayOriginal, protectionCache, protectionOptions);
    cache?.set(element, result);
    return result;
}

/**
 * 只切分混合块的直接内联内容。块级子节点作为屏障并保留自己的候选；受保护的内联节点
 * 以原子源结构留在 run 中，但其文本不会进入翻译请求。
 */
export function getDirectInlineRuns(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    skipStructuralAncestorCheck = false,
    isAdditionalBarrier?: (element: Element) => boolean,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    scope: TranslationScope = 'content',
    allowInlineContainer = false,
    regionOptions?: StructuralRegionOptions,
): ChildNode[][] {
    if (scope === 'content' && (isDocumentSurface(element) || isStructuralContainer(element, regionOptions) ||
        (!skipStructuralAncestorCheck && hasStructuralAncestor(element, regionOptions)))) return [];
    if (shouldStayOriginal?.(element) || isProtectedTextElement(element) ||
        (scope === 'content' && !allowInlineContainer && !isBlockBoundary(element))) return [];
    // 控件只能走保留宿主标签/图标的实时文本槽路径，不能拆出会增加第二行的内联段落。
    const controlOwner = findTranslationControlOwner(element);
    if (controlOwner && !hasNestedTranslationControl(controlOwner)) return [];
    if (element.childNodes.length > maxDirectRunNodes) return [];
    if (!hasDirectReadableText(element, shouldStayOriginal, protectionCache, protectionOptions)) return [];
    const hasBlockBarrier = hasReadableBlockChild(element, shouldStayOriginal, protectionCache, protectionOptions);
    const hasAdditionalBarrier = !hasBlockBarrier && isAdditionalBarrier &&
        Array.from(element.children).some((child) => isAdditionalBarrier(child));
    if (!hasBlockBarrier && !hasAdditionalBarrier &&
        !(scope === 'all' && isDocumentSurface(element))) return [];

    const runs: ChildNode[][] = [];
    let current: ChildNode[] = [];
    const flush = () => {
        if (current.length > 0 &&
            hasMeaningfulTranslationTextInNodes(
                current,
                shouldStayOriginal,
                protectionCache,
                protectionOptions,
            )) {
            runs.push(current);
        }
        current = [];
    };

    for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 1 &&
            (isBlockBoundary(child as Element) || isAdditionalBarrier?.(child as Element))) {
            flush();
            continue;
        }
        current.push(child);
    }
    flush();
    return runs;
}

export interface GenericClassification {
    kind: 'content' | 'control';
    reason: string;
}

/**
 * 页面发现与悬浮共用的纯本地候选分类；刻意将边界分类与渲染布局分离。
 */
export function classifyGenericCandidate(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    skipStructuralAncestorCheck = false,
    protectionCache?: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    scope: TranslationScope = 'content',
    regionOptions?: StructuralRegionOptions,
): GenericClassification | null {
    const semanticHeading = isSemanticHeadingElement(element);
    if (isDocumentSurface(element) || (scope === 'content' && (isStructuralContainer(element, regionOptions) ||
        (!skipStructuralAncestorCheck && hasStructuralAncestor(element, regionOptions) && !semanticHeading)))) {
        return null;
    }
    if (shouldStayOriginal?.(element)) return null;

    // 按钮型 input 的标签写在 value 属性里，元素内部没有任何 Text 节点，因此必须先于
    // 表单文本保护判定，交由控件属性渲染路径处理。
    if (getTranslatableControlValueAttribute(element)) {
        return {kind: 'control', reason: 'generic-control-value'};
    }
    if (isProtectedTextElement(element)) return null;

    // 全部节点范围保持既有的"整页即界面"判定；正文范围只放开呈标签形态的交互外壳，
    // 让同一排工具栏里的按钮、链接和表单标签得到一致的替换式译文。
    const interactiveControl = (scope === 'all' && isAllScopeControl(element)) ||
        (isInteractiveSurface(element) &&
            isControlLabelSurface(element, shouldStayOriginal, protectionCache, protectionOptions));
    if (isTranslationControlElement(element) ||
        (interactiveControl && !hasAllScopeSemanticOwner(element, shouldStayOriginal, protectionCache, protectionOptions))) {
        // 内层按钮保留独立候选，避免外层控件吞并独立操作。
        if (hasNestedTranslationControl(element)) return null;
        if (!hasMeaningfulTranslationTextInNodes(
            [element],
            shouldStayOriginal,
            protectionCache,
            protectionOptions,
        )) return null;
        return {kind: 'control', reason: 'generic-control'};
    }

    const block = isBlockBoundary(element);
    if (!block && (scope === 'content' ||
        hasAllScopeSemanticOwner(element, shouldStayOriginal, protectionCache, protectionOptions))) return null;
    // GitHub Primer 等组件用 display:flex 的 span 排版按钮标签。后序发现必须等到
    // 控件本身再选 control，否则标签会抢先成为 content 并在固定高度按钮里插入双语行。
    const controlOwner = findTranslationControlOwner(element);
    if (controlOwner && !hasNestedTranslationControl(controlOwner)) return null;
    if (!hasMeaningfulTranslationTextInNodes(
        [element],
        shouldStayOriginal,
        protectionCache,
        protectionOptions,
    )) return null;
    // 含可读块级子节点的容器是结构边界，不是回退目标。若悬浮时选中它，实际命中位于
    // header/aside 子节点时可能误翻译整个应用外壳。
    if (hasReadableBlockChild(element, shouldStayOriginal, protectionCache, protectionOptions)) return null;
    return {
        kind: controlOwner ? 'control' : scope === 'all' ? getAllScopeCandidateKind(element) : 'content',
        reason: controlOwner ? 'generic-control-label' : block ? 'generic-readable-block' : 'generic-readable-label',
    };
}
