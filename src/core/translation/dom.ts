/**
 * @file src/core/translation/dom.ts
 *
 * 文件职责：封装翻译候选发现使用的 composed tree 遍历与不可覆盖安全守卫，识别扩展 DOM、脚本、表单、图标字体、Scribble 代码表格、纯文本正文及禁止翻译区域。
 * 主要内容：提供 Shadow DOM 父级与祖先遍历、硬裁剪标签、受保护文本元素、text/plain 顶层 pre、独立 tooltip 边界、隐藏/可编辑/no-translate 判断，并限制祖先深度以避免异常页面结构拖垮扫描。 可核对的公开符号包括 maxComposedAncestorDepth、getComposedParent、isDocumentSurface、isExtensionElement、isExtensionElementSelf、isHardPruneTag、isProtectedTextElement、isPlainTextDocumentPre、hasNoTranslateMarker、isTopLevelApplicationShell。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

const extensionSelector = [
    '#fluent-read-floating-ball-container',
    '#fluent-read-selection-translator-container',
    '#fluent-read-translation-status-container',
    '[data-fluent-read-ui]',
    '.fluent-read-video-ui',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '.fluent-read-bilingual-content',
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
].join(',');

const hardPruneTags = new Set([
    'head', 'script', 'style', 'noscript', 'iframe', 'input', 'textarea',
    'select', 'option', 'math', 'svg', 'canvas', 'audio', 'video', 'object',
    'template', 'xmp',
]);

const protectedTextTags = new Set([
    ...hardPruneTags,
    'pre', 'code', 'kbd', 'samp', 'var',
]);

/**
 * 宿主页可能构造恶意的超深节点树。依赖祖先的安全检查同步执行，因此单次查询必须
 * 设置上限；超过上限时保守裁剪，避免让渲染线程阻塞数百毫秒。
 */
export const maxComposedAncestorDepth = 512;

export function getComposedParent(element: Element): Element | null {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.() as {host?: Element};
    return root?.host?.nodeType === 1 ? root.host : null;
}

export function* composedAncestors(element: Element): Generator<Element> {
    let current: Element | null = element;
    while (current) {
        yield current;
        current = getComposedParent(current);
    }
}

export function isDocumentSurface(element: Element): boolean {
    const owner = element.ownerDocument;
    return element === owner?.documentElement || element === owner?.body;
}

export function isExtensionElement(element: Element): boolean {
    return Boolean(element.matches(extensionSelector) || element.closest(extensionSelector));
}

export function isExtensionElementSelf(element: Element): boolean {
    return element.matches(extensionSelector);
}

export function isHardPruneTag(element: Element): boolean {
    return hardPruneTags.has(element.tagName.toLowerCase());
}

/** 纯文本文档由浏览器包装为顶层 pre；其内容是正文，不是 HTML 页面中的代码块。 */
export function isPlainTextDocumentPre(element: Element): boolean {
    if (element.tagName.toLowerCase() !== 'pre') return false;
    const document = element.ownerDocument;
    const contentType = document?.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    return contentType === 'text/plain' && element.parentElement === document?.body;
}

export function isProtectedTextElement(element: Element): boolean {
    // Scribble/Racket 文档使用 table.RktBlk 展示代码，而不是 pre/code。只保护
    // 明确的代码表格；普通表格或正文上同名的 class 不能扩大成不翻译区域。
    return (element.tagName.toLowerCase() === 'table' && element.classList.contains('RktBlk')) ||
        (protectedTextTags.has(element.tagName.toLowerCase()) && !isPlainTextDocumentPre(element));
}

export function hasNoTranslateMarker(element: Element): boolean {
    return element.classList.contains('notranslate') ||
        element.getAttribute('translate')?.toLowerCase() === 'no' ||
        element.getAttribute('data-notranslate') === 'true';
}

/**
 * 显式翻译可有限穿过应用级 no-translate 外壳，但不能把这个例外扩大到局部区域。
 * 直接挂在 body 下是刻意保守的边界：嵌套 no-translate 容器仍代表页面作者明确保护的内容。
 */
export function isTopLevelApplicationShell(element: Element): boolean {
    const body = element.ownerDocument?.body;
    return Boolean(
        body &&
        element.parentElement === body &&
        hasNoTranslateMarker(element),
    );
}

export interface TranslationTextProtectionOptions {
    /** 已有翻译的精确来源槽；只穿过真实 host 的扩展标记和自有 translate=no，其他保护仍生效。 */
    sourceTextSlotHosts?: ReadonlySet<Element>;
    /** 仅显式选中/悬浮翻译允许穿过 body 直接子级的应用外壳。 */
    allowTopLevelApplicationShell?: boolean;
    /** 显式命中的元素自身仍是保护边界，不能因为它的 marker 被放行。 */
    protectedElement?: Element;
}

/** 同一次样式读取同时识别不可见节点和以连字作为字形索引的图标，避免候选热路径重复查询样式。 */
function getPresentationProtection(element: Element): 'hidden' | 'icon-font' | undefined {
    const htmlElement = element as HTMLElement;
    if (htmlElement.hidden || htmlElement.inert || element.hasAttribute('inert')) return 'hidden';
    if (element.getAttribute('aria-hidden') === 'true') return 'hidden';
    if (element.classList.contains('sr-only') || element.classList.contains('visually-hidden')) return 'hidden';

    try {
        const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
        if (!style) return undefined;
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return 'hidden';
        // 只检查首选字体；正文把图标字体列为 fallback 时仍需翻译。字体家族而非文本内容
        // 决定 settings 等词是字形索引，不能按单词或宽泛的 class 名裁剪正文。
        const primaryFamily = (style.fontFamily || '').split(',')[0]!.trim()
            .replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
        if (/^(?:google symbols|fontawesome|(?:material (?:icons|symbols)|font awesome)(?: .+)?)$/.test(primaryFamily)) {
            return 'icon-font';
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export function hasHiddenMarker(element: Element): boolean {
    return getPresentationProtection(element) === 'hidden';
}

/** 图标连字属于宿主展示结构；译文骨架不能在丢失字体样式后将其当作普通文字显示。 */
export function isIconFontElement(element: Element): boolean {
    return getPresentationProtection(element) === 'icon-font';
}

function hasContentEditableMarker(element: Element): boolean {
    const attribute = element.getAttribute('contenteditable');
    return (attribute !== null && attribute.toLowerCase() !== 'false') ||
        (element as HTMLElement).isContentEditable;
}

/**
 * MathJax v2/v3 与 KaTeX 会把公式渲染为普通 span/div，而不是原生 MathML。
 * 这些生成树必须作为宿主页拥有的原子内容保留：翻译或物化内部 span 后，恢复操作
 * 可能删除可见公式，只留下隐藏的 TeX 源脚本。
 */
export function isMathRendererElement(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    return tagName === 'mjx-container' ||
        element.classList.contains('MathJax_Display') ||
        element.classList.contains('MathJax') ||
        element.classList.contains('MathJax_Preview') ||
        element.classList.contains('katex');
}

/**
 * 后代文本守卫刻意保持局部生效。受保护的内联子节点不能进入服务请求，
 * 但不应因此拒绝包含它的可读段落。
 */
export function isProtectedDescendantElement(
    element: Element,
    ignoreExtensionSelf = false,
    options?: TranslationTextProtectionOptions,
): boolean {
    const ownSourceSlot = options?.sourceTextSlotHosts?.has(element) === true;
    const ownNoTranslateMarker = ownSourceSlot &&
        element.getAttribute('translate')?.toLowerCase() === 'no' &&
        !element.classList.contains('notranslate') && element.getAttribute('data-notranslate') !== 'true';
    return (!ignoreExtensionSelf && !ownSourceSlot && isExtensionElementSelf(element)) ||
        isProtectedTextElement(element) ||
        isMathRendererElement(element) ||
        (hasNoTranslateMarker(element) && !ownNoTranslateMarker &&
            !(options?.allowTopLevelApplicationShell === true &&
                element !== options.protectedElement &&
                isTopLevelApplicationShell(element))) ||
        hasContentEditableMarker(element) ||
        getPresentationProtection(element) !== undefined;
}

export interface HardGuardResult {
    prune: boolean;
    reason?: string;
}

export function evaluateElementHardGuard(element: Element): HardGuardResult {
    if (isExtensionElementSelf(element)) return {prune: true, reason: 'fluentread-owned'};
    if (isHardPruneTag(element)) return {prune: true, reason: `protected-tag:${element.tagName.toLowerCase()}`};
    if (isMathRendererElement(element)) return {prune: true, reason: 'math-renderer'};
    if (hasNoTranslateMarker(element)) return {prune: true, reason: 'inherited-no-translate'};
    if (hasContentEditableMarker(element)) return {prune: true, reason: 'contenteditable'};
    const presentationProtection = getPresentationProtection(element);
    if (presentationProtection) return {prune: true, reason: presentationProtection};
    return {prune: false};
}

/**
 * 初次发现、悬浮解析、DOM 变更和开放 Shadow DOM 共用同一组硬守卫；
 * 站点适配器不能覆盖这些安全边界。
 */
export function evaluateHardGuard(element: Element): HardGuardResult {
    let depth = 0;
    for (const current of composedAncestors(element)) {
        depth += 1;
        if (depth > maxComposedAncestorDepth) {
            return {prune: true, reason: 'ancestor-depth-limit'};
        }
        const guard = evaluateElementHardGuard(current);
        if (guard.prune) return guard;
    }
    return {prune: false};
}

function collectImmediateOpenShadowRoots(root: Node): ShadowRoot[] {
    const result: ShadowRoot[] = [];
    const collect = (element: Element) => {
        if (element.shadowRoot) result.push(element.shadowRoot);
    };

    if (root.nodeType === 1) collect(root as Element);
    const document = root.ownerDocument ?? (root.nodeType === 9 ? root as Document : globalThis.document);
    if (!document?.createTreeWalker) return result;
    const walker = document.createTreeWalker(root, 1);
    let current = walker.nextNode();
    while (current) {
        if (current.nodeType === 1) collect(current as Element);
        current = walker.nextNode();
    }
    return result;
}

export function getOpenShadowRoots(root: Node): ShadowRoot[] {
    // 逐层发现嵌套的开放 Shadow Root；closed root 不可见，也不应尝试穿透。
    const result: ShadowRoot[] = [];
    const seen = new Set<ShadowRoot>();
    const pending: Node[] = [root];
    for (let index = 0; index < pending.length; index += 1) {
        const pendingRoot = pending[index]!;
        for (const shadowRoot of collectImmediateOpenShadowRoots(pendingRoot)) {
            if (seen.has(shadowRoot)) continue;
            seen.add(shadowRoot);
            result.push(shadowRoot);
            pending.push(shadowRoot);
        }
    }
    return result;
}

export function safeMatches(element: Element, selector: string): boolean {
    try {
        return element.matches(selector);
    } catch {
        return false;
    }
}

export function safeClosest(element: Element, selector: string): Element | null {
    try {
        return element.closest(selector);
    } catch {
        return null;
    }
}

export function findElementsAtPoint(root: Document | ShadowRoot, x: number, y: number): Element[] {
    const pointRoot = root as Document & {elementsFromPoint?: (x: number, y: number) => Element[]};
    if (typeof pointRoot.elementsFromPoint === 'function') return pointRoot.elementsFromPoint(x, y);
    const singlePointRoot = root as Document & {elementFromPoint?: (x: number, y: number) => Element | null};
    if (typeof singlePointRoot.elementFromPoint !== 'function') return [];
    const element = singlePointRoot.elementFromPoint(x, y);
    return element ? [element] : [];
}

export function findNodeAtPoint(root: Document | ShadowRoot, x: number, y: number): Node | null {
    const document = root.nodeType === 9 ? root as Document : root.ownerDocument;
    try {
        const caretPosition = document?.caretPositionFromPoint?.(x, y);
        if (caretPosition?.offsetNode && root.contains(caretPosition.offsetNode)) return caretPosition.offsetNode;
    } catch {
        // Firefox 风格的光标命中 API 是可选能力，也可能拒绝 Shadow Root。
    }
    try {
        const range = document?.caretRangeFromPoint?.(x, y);
        if (range?.startContainer && root.contains(range.startContainer)) return range.startContainer;
    } catch {
        // Chromium 风格的光标命中 API 同样是可选能力。
    }
    return null;
}


/** tooltip 是独立临时阅读面；不能参与外层按钮的来源或几何所有权。 */
export function isTranslationTooltip(element: Element): boolean {
    return element.getAttribute('role') === 'tooltip' ||
        (element.classList.contains('tooltip') && Array.from(element.children)
            .some(child => child.classList.contains('tooltip-inner')));
}

/** 相对于本次候选，排除嵌套 tooltip 的文本，仍允许 tooltip 自身独立翻译。 */
export function isTextInNestedTranslationTooltip(node: Node, root: Element): boolean {
    let current = node.parentElement;
    let depth = 0;
    while (current && current !== root) {
        if (isTranslationTooltip(current)) return true;
        if (++depth > maxComposedAncestorDepth) return true;
        current = current.parentElement;
    }
    return false;
}
