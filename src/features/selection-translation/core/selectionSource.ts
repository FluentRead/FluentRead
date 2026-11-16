/**
 * @file src/features/selection-translation/core/selectionSource.ts
 * 文件职责：读取浏览器原生文本控件及组合 DOM 的用户选区，冻结文字与来源边界供划词卡片校验。
 * 主要内容：沿活动 Shadow Root 定位输入控件，读取 selectionStart/selectionEnd，保留独立的 DOM 定位锚点；从可信交互路径和活动根读取原生 Selection，兼容支持根级选区 API 的浏览器。控件值只在当前明确选中范围内提取，密码及不支持选区的控件不参与读取。
 * 模块边界：不修改文本、选区、焦点或宿主属性，不注册事件、不调用翻译、不创建 UI；传入的交互路径由组件维护。
 */
import {getComposedParent, getElementTagName, maxComposedAncestorDepth} from '@/src/core/translation/dom';

export type SelectionTextControl = HTMLInputElement | HTMLTextAreaElement;
export interface TextControlSelection {
    element: SelectionTextControl;
    value: string;
    text: string;
    start: number;
    end: number;
    isForward: boolean;
}

export function getSelectionActiveElement(document: Document): Element | null {
    let active = document.activeElement ?? null;
    const seen = new Set<Element>();
    while (active && !seen.has(active)) {
        seen.add(active);
        const inner = active.shadowRoot?.activeElement;
        if (!inner) break;
        active = inner;
    }
    return active;
}

export function isSelectionTextControl(element: Element | null): element is SelectionTextControl {
    return Boolean(element && ['input', 'textarea'].includes(getElementTagName(element)));
}

function isControlSourceAllowed(element: SelectionTextControl): boolean {
    if (element.disabled || getElementTagName(element) === 'input'
        && !['text', 'search', 'url', 'tel'].includes(element.type)) return false;
    let depth = 0;
    for (let current: Element | null = element; current; current = getComposedParent(current)) {
        if (++depth > maxComposedAncestorDepth || current.matches('[data-fluent-read-ui],#fluent-read-selection-translator-container,.fluent-read-bilingual-content')) return false;
    }
    return true;
}

export function readTextControlSelection(element: SelectionTextControl): TextControlSelection | null {
    if (!isControlSourceAllowed(element)) return null;
    const start = element.selectionStart, end = element.selectionEnd;
    if (start === null || end === null || start >= end) return null;
    const value = element.value;
    const text = value.slice(start, end);
    if (!text.trim()) return null;
    return {element, value, text, start, end, isForward: element.selectionDirection !== 'backward'};
}

/** 卡片接管焦点后仍以冻结来源复核，不依赖原生高亮继续存在。 */
export function isTextControlSelectionCurrent(source: TextControlSelection, document: Document): boolean {
    return source.element.isConnected && source.element.ownerDocument === document
        && isControlSourceAllowed(source.element) && source.element.value === source.value;
}

export function readNativeSelection(view: Pick<Window, 'getSelection'>, document: Document, interactionPath: readonly EventTarget[] = []): Selection | null {
    const roots = new Set<Document | ShadowRoot>();
    const active = getSelectionActiveElement(document);
    const candidates = [...interactionPath, ...(active ? [active] : [])];
    for (const candidate of candidates) {
        const node = candidate as Node;
        const root = node.getRootNode?.();
        if (root?.nodeType === 11) roots.add(root as ShadowRoot);
        if (node.nodeType === 11) roots.add(node as ShadowRoot);
    }
    for (const root of roots) {
        try {
            const getSelection = (root as ShadowRoot & {getSelection?: () => Selection | null}).getSelection;
            const selection = getSelection?.call(root);
            if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim()) return selection;
        } catch { /* 根已失效时继续读取当前文档的原生选区。 */ }
    }
    return view.getSelection();
}
