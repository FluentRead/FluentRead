/**
 * @file src/core/translation/dom.ts
 *
 * 文件职责：封装翻译候选发现使用的 composed tree 遍历与不可覆盖安全守卫，识别扩展 DOM、其他翻译器已接管的段落、脚本、表单、图标字体、代码及禁止翻译区域。
 * 主要内容：提供抗表单命名属性遮蔽的标签读取、Shadow DOM 父级与祖先遍历、硬裁剪标签、按钮型 input 的可译标签属性判定、受保护文本元素、text/plain 顶层 pre、独立 tooltip 边界、隐藏/可编辑/no-translate 判断，并限制祖先深度以避免异常页面结构拖垮扫描。 可核对的公开符号包括 maxComposedAncestorDepth、getComposedParent、isDocumentSurface、isExtensionElementSelf、getTranslatableControlValueAttribute、isHardPruneTag、isProtectedTextElement、isPlainTextDocumentPre、hasNoTranslateMarker、isDocumentSurfaceNoTranslateShell、isTopLevelApplicationShell。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

/** 表单命名控件可遮蔽 tagName；沿原型读取原生 getter，不能把输入节点当作字符串。 */
export function getElementTagName(element: Element): string {
    const name = element.tagName;
    if (typeof name === 'string') return name.toLowerCase();
    let prototype = Object.getPrototypeOf(element);
    while (prototype) {
        const getter = Object.getOwnPropertyDescriptor(prototype, 'tagName')?.get;
        if (getter) return getter.call(element).toLowerCase();
        prototype = Object.getPrototypeOf(prototype);
    }
    return '';
}

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

const foreignTranslationWrapperClass = 'immersive-translate-target-wrapper';

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

export function isExtensionElementSelf(element: Element): boolean {
    return element.matches(extensionSelector);
}

/**
 * 外部译文可能插在原文的直属 font wrapper 中。该父节点才是已被接管的
 * 最小原文单元，不能沿 querySelector 把整篇文章或整个页面都视为已翻译。
 * 不把它标为 FluentRead owned：只停止本插件在这里写入，清理时绝不删除对方 DOM。
 * 该判断位于每个文本节点的祖先守卫热路径上；Blink 的 `querySelector(':scope > …')`
 * 会匹配整棵后代树，因此直接检查直属子元素，避免长文章的祖先检查随正文规模二次增长。
 */
export function isForeignTranslationBoundary(element: Element): boolean {
    if (element.classList.contains(foreignTranslationWrapperClass)) return true;
    if (isDocumentSurface(element)) return false;
    const children = element.children;
    for (let index = 0; index < children.length; index += 1) {
        if (children[index]!.classList.contains(foreignTranslationWrapperClass)) return true;
    }
    return false;
}

const valueControlInputTypes = new Set(['button', 'reset', 'submit']);

/**
 * 按钮型 input 的可见文字来自 value 属性：浏览器按固定尺寸绘制标签，元素内没有任何可写入的
 * Text 节点，因此它既不能走双语行，也不能走文本槽替换，只能改写属性本身。
 *
 * 产品安全边界：
 * - text/search/password/email 等输入框的 value 是用户数据，任何情况下都不触碰。
 * - 具名 submit 的 value 会随表单一起提交（Rails 的 `name="commit"` 是典型用法），
 *   改写会把"评论"变成服务端无法识别的动作，因此只翻译不参与表单数据的按钮标签。
 * - 空 value 由浏览器渲染本地化默认标签（提交/重置），写入译文反而制造不一致。
 */
export function getTranslatableControlValueAttribute(element: Element): 'value' | null {
    if (getElementTagName(element) !== 'input') return null;
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (!valueControlInputTypes.has(type)) return null;
    if (type === 'submit' && (element.getAttribute('name') ?? '').trim() !== '') return null;
    return (element.getAttribute('value') ?? '').trim() === '' ? null : 'value';
}

export function isHardPruneTag(element: Element): boolean {
    // 按钮型 input 是页面上的操作入口，与 button 同属交互控件；其余表单元素继续整体裁剪。
    if (getTranslatableControlValueAttribute(element)) return false;
    return hardPruneTags.has(getElementTagName(element));
}

/** 纯文本文档由浏览器包装为顶层 pre；其内容是正文，不是 HTML 页面中的代码块。 */
export function isPlainTextDocumentPre(element: Element): boolean {
    if (getElementTagName(element) !== 'pre') return false;
    const document = element.ownerDocument;
    const contentType = document?.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    return contentType === 'text/plain' && element.parentElement === document?.body;
}

export function isProtectedTextElement(element: Element): boolean {
    // Scribble/Racket 文档使用 table.RktBlk 展示代码，而不是 pre/code。只保护
    // 明确的代码表格；普通表格或正文上同名的 class 不能扩大成不翻译区域。
    return (getElementTagName(element) === 'table' && element.classList.contains('RktBlk')) ||
        (protectedTextTags.has(getElementTagName(element)) && !isPlainTextDocumentPre(element));
}

export function hasNoTranslateMarker(element: Element): boolean {
    return element.classList.contains('notranslate') ||
        element.getAttribute('translate')?.toLowerCase() === 'no' ||
        element.getAttribute('data-notranslate') === 'true';
}

/**
 * 文档根表面（<html>/<body>）上的 no-translate 标记通常是 Weglot 等多语言框架
 * 为阻止浏览器自带翻译而设置的全局防护（典型如 <html translate="no">），并非页面
 * 作者针对具体正文的保护意图。用户显式发起翻译时，这类根级标记若参与祖先链裁剪，
 * 会导致整页任何文本节点上溯到根节点即被判 inherited-no-translate，从而整页失效。
 * 因此把"文档根表面自身携带 no-translate 标记"识别为可放行的框架级外壳；真正的
 * 局部保护（嵌套的 .notranslate / translate="no" 容器）不在此列，仍照常裁剪。
 */
export function isDocumentSurfaceNoTranslateShell(element: Element): boolean {
    return isDocumentSurface(element) && hasNoTranslateMarker(element);
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
        // 无障碍辅助文本常没有固定类名，而是绝对定位到 1px 裁剪盒。单独的 overflow
        // 或 clip 不能代表隐藏（正文卡片也会截断）；只识别同时满足全部条件的辅助盒。
        if ((style.position === 'absolute' || style.position === 'fixed') &&
            /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.width) &&
            /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.height) &&
            (style.overflow === 'hidden' || style.overflow === 'clip' ||
                (style.overflowX === 'hidden' && style.overflowY === 'hidden'))) {
            const clip = style.clip?.replace(/[\s,]+/gu, ' ').trim();
            const collapsedRect = /^rect\((0(?:px)?|1px) \1 \1 \1\)$/u.test(clip ?? '');
            if (collapsedRect || style.clipPath?.replace(/\s+/gu, '') === 'inset(50%)') return 'hidden';
        }
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

/** 图标连字属于宿主展示结构；译文骨架不能在丢失字体样式后将其当作普通文字显示。 */
export function isIconFontElement(element: Element): boolean {
    return getPresentationProtection(element) === 'icon-font';
}

/** 输出快照也必须依据实时可见性省略节点，不能依赖克隆后已经丢失的宿主样式。 */
export function isHiddenTranslationElement(element: Element): boolean {
    return getPresentationProtection(element) === 'hidden';
}

export function hasContentEditableMarker(element: Element): boolean {
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
    const tagName = getElementTagName(element);
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
        isForeignTranslationBoundary(element) ||
        isProtectedTextElement(element) ||
        isMathRendererElement(element) ||
        (hasNoTranslateMarker(element) && !ownNoTranslateMarker &&
            !isDocumentSurfaceNoTranslateShell(element) &&
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
    if (isForeignTranslationBoundary(element)) return {prune: true, reason: 'foreign-translation'};
    if (isHardPruneTag(element)) return {prune: true, reason: `protected-tag:${getElementTagName(element)}`};
    if (isMathRendererElement(element)) return {prune: true, reason: 'math-renderer'};
    if (hasNoTranslateMarker(element) && !isDocumentSurfaceNoTranslateShell(element)) {
        return {prune: true, reason: 'inherited-no-translate'};
    }
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

export interface TextPoint {
    node: Node;
    offset: number;
}

/** Preserve the caret offset when the browser exposes it; hover chunking uses the same hit test as hover resolution. */
export function findTextPointAtPoint(root: Document | ShadowRoot, x: number, y: number): TextPoint | null {
    const document = root.nodeType === 9 ? root as Document : root.ownerDocument;
    try {
        const caretPosition = document?.caretPositionFromPoint?.(x, y);
        if (caretPosition?.offsetNode && root.contains(caretPosition.offsetNode)) {
            return {node: caretPosition.offsetNode, offset: caretPosition.offset};
        }
    } catch {
        // Firefox 风格的光标命中 API 是可选能力，也可能拒绝 Shadow Root。
    }
    try {
        const range = document?.caretRangeFromPoint?.(x, y);
        if (range?.startContainer && root.contains(range.startContainer)) {
            return {node: range.startContainer, offset: range.startOffset};
        }
    } catch {
        // Chromium 风格的光标命中 API 同样是可选能力。
    }
    return null;
}

export function findNodeAtPoint(root: Document | ShadowRoot, x: number, y: number): Node | null {
    return findTextPointAtPoint(root, x, y)?.node ?? null;
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
