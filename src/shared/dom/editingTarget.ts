/**
 * @file src/shared/dom/editingTarget.ts
 * 文件职责：判断一次键盘事件是否发生在用户正在输入文字的场景，让网页快捷键在输入框、可编辑区域和无法读取的封闭组件里自动让行，同时不误拦播放器进度条、复选框或开放 ShadowRoot 自定义控件。
 * 主要内容：导出 isEditingInPage、isTypingKeystroke 和 deepActiveElement；识别文本输入型表单控件、contenteditable 与 ARIA 输入角色，排除滑块/勾选等非文本 input 类型，逐层穿过开放 ShadowRoot 找到真实焦点，并为具有明确非输入角色的自定义元素放行快捷键，其余封闭自定义元素继续保守保护。
 * 模块边界：本文件只读取事件路径与 document 焦点，不注册监听、不解析快捷键，也不阻止事件；是否响应按键由调用方的 feature 决定。
 */

const TYPING_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'];
const NON_TYPING_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
]);
const NON_TYPING_CUSTOM_ROLES = new Set([
    'slider',
    'button',
    'switch',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'tab',
]);
// 这些标签天生可聚焦；焦点停在它们上面不代表用户正在输入文字（文本型 INPUT 已由 isTypingTarget 先行拦下）。
const NATIVE_FOCUSABLE_TAGS = ['A', 'AREA', 'AUDIO', 'BUTTON', 'DETAILS', 'EMBED', 'IFRAME', 'INPUT', 'LABEL', 'OBJECT', 'SUMMARY', 'VIDEO'];

function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as Element | null;
    if (!element || typeof (element as Element).getAttribute !== 'function') return false;
    if (element.tagName === 'INPUT') {
        const inputType = (element.getAttribute('type') ?? '').trim().toLowerCase();
        return !NON_TYPING_INPUT_TYPES.has(inputType);
    }
    if (['TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName)) return true;
    if ((element as HTMLElement).isContentEditable) return true;
    if (element.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]')) return true;
    const role = element.getAttribute('role');
    return typeof role === 'string' && TYPING_ROLES.includes(role.toLowerCase());
}

/** 逐层穿过可读取的 ShadowRoot，找到真正持有焦点的元素。 */
export function deepActiveElement(pageDocument: Document): Element | null {
    let focused = pageDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    return focused;
}

/** 焦点停在无法读取的封闭 ShadowRoot 宿主或无明确非输入角色的自定义元素上时，保守当作输入场景放行按键。 */
function isOpaqueFocusHost(element: Element): boolean {
    if (['BODY', 'HTML'].includes(element.tagName)) return false;
    if (element.shadowRoot) return false;
    if (element.tagName.includes('-')) {
        const role = element.getAttribute('role');
        return !(typeof role === 'string' && NON_TYPING_CUSTOM_ROLES.has(role.trim().toLowerCase()));
    }
    if (element.hasAttribute('tabindex')) return false;
    return !NATIVE_FOCUSABLE_TAGS.includes(element.tagName);
}

/** 判断按键是否发生在输入场景：事件路径或当前焦点落在可输入元素上时返回 true。 */
export function isEditingInPage(event: KeyboardEvent, pageDocument: Document = document): boolean {
    if (typeof event.composedPath === 'function' && event.composedPath().some(isTypingTarget)) return true;
    const focused = deepActiveElement(pageDocument);
    return Boolean(focused) && (isTypingTarget(focused) || isOpaqueFocusHost(focused!));
}

/**
 * 判断按键是否是用户正在输入的字符：输入法组合期间，或在输入场景内按下不含 Control/Alt/Meta 的组合
 * （如 Shift+1、F9、数字）。页面级快捷键遇到这类按键必须让行，不能 preventDefault 吞掉字符。
 */
export function isTypingKeystroke(event: KeyboardEvent, pageDocument: Document = document): boolean {
    if (event.isComposing || event.keyCode === 229) return true;
    return !event.ctrlKey && !event.altKey && !event.metaKey && isEditingInPage(event, pageDocument);
}
