/**
 * @file src/shared/dom/editingTarget.ts
 * 文件职责：判断一次键盘事件是否发生在用户正在输入文字的场景，让网页快捷键在输入框、可编辑区域和无法读取的封闭组件里自动让行。
 * 主要内容：导出 isEditingInPage、isTypingKeystroke 和 deepActiveElement；识别原生表单控件、contenteditable、ARIA 输入角色，逐层穿过可读取的 ShadowRoot 找到真实焦点，并把无法读取内部状态的自定义元素或非原生可聚焦宿主保守视为输入场景。
 * 模块边界：本文件只读取事件路径与 document 焦点，不注册监听、不解析快捷键，也不阻止事件；是否响应按键由调用方的 feature 决定。
 */

const TYPING_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'];
// 这些标签天生可聚焦；焦点停在它们上面不代表用户正在输入文字。
const NATIVE_FOCUSABLE_TAGS = ['A', 'AREA', 'AUDIO', 'BUTTON', 'DETAILS', 'EMBED', 'IFRAME', 'LABEL', 'OBJECT', 'SUMMARY', 'VIDEO'];

function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as Element | null;
    if (!element || typeof (element as Element).getAttribute !== 'function') return false;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName)) return true;
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

/** 焦点停在无法读取的封闭 ShadowRoot 宿主或自定义元素上时，保守当作输入场景放行按键。 */
function isOpaqueFocusHost(element: Element): boolean {
    if (['BODY', 'HTML'].includes(element.tagName)) return false;
    if (element.tagName.includes('-')) return true;
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
