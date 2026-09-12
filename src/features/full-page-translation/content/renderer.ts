/**
 * @file src/features/full-page-translation/content/renderer.ts
 * 文件职责：把翻译返回的受限 HTML 或纯文本安全插入原页面，构造 FluentRead 双语与仅译文节点，同时保护链接属性并触发布局截断修复。
 * 主要内容：包含 URL 协议白名单、可复制属性集合、递归节点净化、本地公式可视骨架的受限克隆与辅助副本排除、DocumentFragment 创建、不改写宿主 class 的双语 wrapper、可选的译文前置与长段落按句换行，以及通过 Shadow DOM 保留宿主原文的仅译文文本槽。
 * 模块边界：本文件只负责安全渲染，不发起翻译或管理请求状态；服务调用归 runtime，节点所有权归 state，配置仅用于展示选项，任意脚本、事件属性和危险链接都不得穿过净化边界。
 */
import { options } from "@/src/core/config/catalog";
import { config } from "@/src/services/config/store";
import {ensureTranslationTruncationLayout} from "@/src/features/full-page-translation/content/layout";
import {applyLongParagraphLineBreaks} from "@/src/core/translation/lineBreak";

/**
 * 译文允许保留的内联元素。
 * 翻译服务返回的结构不是可信 HTML，因此不直接把响应写入 innerHTML。
 */
const allowedTags = new Set([
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "em", "font",
    "code", "i", "kbd", "mark", "q", "ruby", "samp", "small", "span",
    "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

const blockedTags = new Set([
    "iframe", "object", "script", "style", "template", "xmp",
]);

function isSafeHref(value: string): boolean {
    try {
        const url = new URL(value, document.baseURI);
        return ["http:", "https:", "mailto:"].includes(url.protocol);
    } catch {
        return false;
    }
}

function copySafeAttributes(source: Element, target: HTMLElement): void {
    if (source.tagName.toLowerCase() === "a") {
        const href = source.getAttribute("href");
        if (href && isSafeHref(href)) target.setAttribute("href", href);

        const title = source.getAttribute("title");
        if (title) target.setAttribute("title", title);
    }
}

// 公式只能来自本地快照，不能根据 provider 返回的 HTML 升级信任。
const formulaSelector = 'math, mjx-container, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .katex, .mwe-math-element, .ltx_Math';
const formulaTags = new Set((
    'span div nobr img math semantics annotation mi mn mo mrow mfrac msqrt mroot mstyle merror ' +
    'mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts ' +
    'mprescripts none mtable mtr mtd mlabeledtr mtext mspace svg g defs path use rect line polyline ' +
    'polygon circle ellipse'
).split(' '));
const formulaAttributes = new Set((
    'class title role aria-hidden alt width height viewbox preserveaspectratio jax size s texclass d transform x y x1 y1 ' +
    'x2 y2 cx cy r rx ry points fill stroke stroke-width opacity focusable display mathvariant ' +
    'mathsize mathcolor mathbackground displaystyle scriptlevel stretchy symmetric largeop movablelimits ' +
    'accent accentunder fence separator form lspace rspace minsize maxsize linethickness bevelled ' +
    'rowalign columnalign rowspacing columnspacing columnspan rowspan depth voffset encoding '
).trim().split(' '));
let formulaCloneSequence = 0;

/** 保留公式排版所需的惰性节点，丢弃脚本、外部 SVG 引用、事件和可聚焦控件。 */
function cloneSourceFormula(source: Element): Element | null {
    const ids = new Map<string, string>();
    const prefix = `fr-formula-${++formulaCloneSequence}-`;
    for (const element of [source, ...Array.from(source.querySelectorAll('[id]'))]) {
        const id = element.getAttribute('id');
        if (id) ids.set(id, `${prefix}${ids.size}`);
    }
    const clone = (element: Element): Element | null => {
        // 译文只保留可视排版，避免辅助 MathML/TeX 副本重复显示或再次排版。
        if (element.matches('.MJX_Assistive_MathML, mjx-assistive-mml, .katex-mathml, annotation, annotation-xml')) return null;
        const tag = element.localName.toLowerCase();
        // MathJax CHTML 使用无脚本语义的 mjx-* 自定义排版元素。
        if (!formulaTags.has(tag) && !allowedTags.has(tag) && !/^mjx-[a-z0-9-]+$/u.test(tag)) return null;
        const target = document.createElementNS(element.namespaceURI, element.localName);
        for (const {name, value} of Array.from(element.attributes)) {
            const lower = name.toLowerCase();
            if (lower === 'id') {
                target.setAttribute('id', ids.get(value)!);
            } else if (lower === 'href' || lower === 'xlink:href') {
                if (tag === 'use' && /^#[\w.:-]+$/u.test(value)) {
                    target.setAttributeNS(lower === 'xlink:href' ? 'http://www.w3.org/1999/xlink' : null,
                        name, `#${ids.get(value.slice(1)) ?? value.slice(1)}`);
                }
            } else if (lower === 'src' && tag === 'img') {
                try {
                    const url = new URL(value, document.baseURI || undefined);
                    if (['http:', 'https:'].includes(url.protocol)) target.setAttribute('src', url.href);
                } catch { /* 非法图片地址不能进入克隆。 */ }
            } else if (lower === 'style') {
                // 公式布局需要 renderer 的字体、尺寸与相对定位；不接受 URL、转义或执行语法。
                const safe = value.split(';').filter((declaration) => {
                    const [property, ...parts] = declaration.split(':');
                    return /^(?:--[a-z0-9-]+|[a-z-]+)$/iu.test(property.trim()) && parts.length > 0 &&
                        !/(?:url|expression|behavior|binding|import|javascript|[\\<>@])/iu.test(parts.join(':')) &&
                        !/^(?:position)\s*:\s*(?:fixed|sticky)/iu.test(declaration.trim());
                }).join(';');
                if (safe) target.setAttribute('style', safe);
            } else if (formulaAttributes.has(lower) || /^data-(?:mjx|mml|c)(?:-|$)/u.test(lower)) {
                if (!/(?:url\s*\(|javascript:)/iu.test(value)) target.setAttribute(name, value);
            }
        }
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) target.appendChild(document.createTextNode((child as Text).data));
            else if (child.nodeType === Node.ELEMENT_NODE) {
                const safe = clone(child as Element);
                if (safe) target.appendChild(safe);
            }
        }
        return target;
    };
    return clone(source);
}

function sanitizeNode(node: Node, sourceSkeleton = false): Node[] {
    if (node.nodeType === Node.TEXT_NODE) {
        return [document.createTextNode(node.nodeValue ?? "")];
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return [];

    const source = node as Element;
    const tag = source.tagName.toLowerCase();
    if (blockedTags.has(tag)) return [];

    if (sourceSkeleton && source.matches(formulaSelector)) {
        const formula = cloneSourceFormula(source);
        return formula ? [formula] : [];
    }
    const children = Array.from(source.childNodes).flatMap((child) => sanitizeNode(child, sourceSkeleton));

    // 不在白名单中的结构只展开其安全文本/内联子节点，避免丢失译文内容。
    if (!allowedTags.has(tag)) return children;

    const target = document.createElement(tag);
    copySafeAttributes(source, target);
    children.forEach((child) => target.appendChild(child));
    return [target];
}

/**
 * 将服务响应解析为安全的 DocumentFragment。
 * DOMParser 使用独立文档解析，随后只迁移白名单节点和安全属性。
 */
function createSafeTranslationFragment(text: string): DocumentFragment {
    const parsed = new DOMParser().parseFromString(text || "", "text/html");
    const fragment = document.createDocumentFragment();
    Array.from(parsed.body.childNodes)
        .flatMap((node) => sanitizeNode(node))
        .forEach((node) => fragment.appendChild(node));
    return fragment;
}

/**
 * 双语模式：译文仍放在目标段落内部，以保持现有 DOM 断言和页面布局习惯；
 * 但具体节点由状态机保存，恢复时只移除这一份 wrapper。
 */
export interface BilingualTranslationRenderOptions {
    /** 全文会话启动时冻结的目标语言；普通悬浮翻译缺省仍读取当前配置。 */
    targetLanguage?: string;
    /** 全文会话启动时冻结的长段落换行开关；缺省读取当前配置。 */
    longParagraphLineBreak?: boolean;
    /** 全文会话启动时冻结的译文位置；缺省读取当前配置。 */
    translationBeforeOriginal?: boolean;
    /** 仅接受本地 createTranslationSourceSnapshot 的克隆，文本槽已经安全写入。 */
    sourceSkeleton?: HTMLElement;
    /** 全文会话启动时冻结的译文样式。 */
    style?: number;
}

export interface SingleTranslationSlot {
    node: Text;
    text: string;
}

/**
 * 仅译文模式不再改写宿主 Text.nodeValue。React、GitHub relative-time
 * 等动态组件会把被改写的文本立即校正回原文，与 MutationObserver
 * 重译形成无限往返。这里把原 Text 移入轻 DOM，但只渲染闭合
 * ShadowRoot 中的译文：宿主仍能读到原 textContent 和原节点身份，
 * 用户看到的则是可选中、可复制且继承页面样式的译文。
 */
export function appendSingleTranslationSlots(
    owner: HTMLElement,
    slots: readonly SingleTranslationSlot[],
    renderOptions: BilingualTranslationRenderOptions = {},
): HTMLElement[] {
    if (slots.some(({node}) => !node.parentNode || !owner.contains(node))) return [];
    const hosts: HTMLElement[] = [];
    for (const slot of slots) {
        const parent = slot.node.parentNode!;

        const host = owner.ownerDocument.createElement("span");
        host.classList.add("fluent-read-single-slot");
        host.setAttribute("data-fr-translation-owned", "true");
        host.setAttribute("translate", "no");
        host.setAttribute("aria-label", slot.text);
        host.lang = (renderOptions.targetLanguage ?? config.to) || "";
        host.dir = "auto";

        const shadow = host.attachShadow({mode: "closed"});
        const translated = owner.ownerDocument.createElement("span");
        translated.setAttribute("data-fr-translation-owned", "true");
        translated.setAttribute("translate", "no");
        translated.lang = host.lang;
        translated.dir = "auto";
        translated.textContent = slot.text;
        shadow.appendChild(translated);

        parent.insertBefore(host, slot.node);
        host.appendChild(slot.node);
        hosts.push(host);
    }
    return hosts;
}

function createBilingualTranslationContent(
    node: HTMLElement,
    text: string,
    renderOptions: BilingualTranslationRenderOptions = {},
): HTMLElement {
    const content = node.ownerDocument.createElement("span");
    content.classList.add("fluent-read-bilingual-content");
    content.setAttribute("data-fr-translation-owned", "true");
    content.setAttribute("translate", "no");
    content.lang = (renderOptions.targetLanguage ?? config.to) || "";
    content.dir = "auto";

    const styleValue = renderOptions.style ?? config.style;
    const style = options.styles.find((item) => item.value === styleValue && !item.disabled);
    if (style?.class) content.classList.add(style.class);

    // 本地骨架已把 provider 输出写为文本节点，直接做白名单迁移以保留公式命名空间。
    // 其他调用方传入的 HTML 仍经过 DOMParser，并使用更严格的普通内联白名单。
    const fragment = renderOptions.sourceSkeleton
        ? document.createDocumentFragment()
        : createSafeTranslationFragment(text);
    if (renderOptions.sourceSkeleton) {
        Array.from(renderOptions.sourceSkeleton.childNodes)
            .flatMap((child) => sanitizeNode(child, true))
            .forEach((child) => fragment.appendChild(child));
    }
    content.appendChild(fragment);
    // 换行只作用于本次渲染出的译文容器，原文 DOM 不受影响。
    if (renderOptions.longParagraphLineBreak ?? config.longParagraphLineBreakEnabled) {
        applyLongParagraphLineBreaks(content);
    }
    return content;
}

export function appendBilingualTranslation(
    node: HTMLElement,
    text: string,
    renderOptions: BilingualTranslationRenderOptions = {},
): HTMLElement {
    const content = createBilingualTranslationContent(node, text, renderOptions);
    // clone/remount 可能复制轻 DOM wrapper 却丢失 WeakMap；只替换直属工件。
    Array.from(node.children)
        .filter((child) => child.matches(
            '.fluent-read-bilingual-content[data-fr-translation-owned="true"]',
        ))
        .forEach((child) => child.remove());
    ensureTranslationTruncationLayout(node);
    // 译文在先只改变插入位置；节点所有权、恢复和重挂载仍按同一个 wrapper 处理。
    if (renderOptions.translationBeforeOriginal ?? config.translationBeforeOriginal) {
        node.insertBefore(content, node.firstChild);
    } else {
        node.appendChild(content);
    }
    return content;
}

/** 来源骨架变化但 provider 槽未变时，就地更新 wrapper，避免原文帧和重复请求。 */
export function refreshBilingualTranslation(
    node: HTMLElement,
    content: HTMLElement,
    text: string,
    renderOptions: BilingualTranslationRenderOptions = {},
): HTMLElement {
    const replacement = createBilingualTranslationContent(node, text, renderOptions);
    Array.from(content.attributes).forEach(({name}) => content.removeAttribute(name));
    Array.from(replacement.attributes).forEach(({name, value}) => content.setAttribute(name, value));
    content.replaceChildren(...Array.from(replacement.childNodes));
    ensureTranslationTruncationLayout(node);
    return content;
}
