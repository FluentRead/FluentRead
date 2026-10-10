/**
 * @file src/features/input-translation/content/inputBox.ts
 * 文件职责：提供输入框快捷翻译使用的纯 DOM 判定与提交守卫，统一处理非敏感 input、textarea、contenteditable 编辑宿主（含富文本编辑器）和 Shadow DOM 深层焦点。
 * 主要内容：定义三连空格/等号/减号触发类型，包含活动元素查找、原生控件与编辑宿主识别、文本与值快照读取、原生控件选区读取、请求提交有效性判断、键盘匹配，以及本次实际插入字符区间的清理。
 * 模块边界：该模块不注册事件、不发送翻译请求也不改变控件值；编辑宿主的光标度量与原生编辑写回位于 editableHost.ts，content/index.ts 负责生命周期与写回编排，后台 handler 负责翻译，函数保持可单测且不持有全局状态。
 */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel']);
const EDITABLE_HOST_VALUES = new Set(['', 'true', 'plaintext-only']);
// 代码编辑器常用连续空格缩进，整段替换还会破坏语法树与光标映射，保持由宿主自行处理。
const CODE_EDITOR_SELECTOR = '.cm-content, .cm-editor, .monaco-editor, .ace_editor, .CodeMirror';
// Slate 在空编辑器内渲染可见占位文本；占位存在时编辑内容为空，不能把提示语当作原文。
const EDITOR_PLACEHOLDER_SELECTOR = '[data-slate-placeholder]';
const IGNORED_EDITABLE_CHARACTERS = /[\u200B\uFEFF]/g;

export {
    normalizeInputBoxTranslationInterval,
} from '@/src/core/config/inputTranslation';

export type InputBoxTrigger = 'triple_space' | 'triple_equal' | 'triple_dash';

export interface InputBoxSelection {
    start: number;
    end: number;
}

/** 找到 Shadow DOM 内真正获得焦点的元素。 */
export function getDeepActiveElement(rootDocument: Document = document): Element | null {
    let activeElement: Element | null = rootDocument.activeElement;

    while (activeElement?.shadowRoot?.activeElement) {
        activeElement = activeElement.shadowRoot.activeElement;
    }

    return activeElement;
}
/** 判断元素是否是原生 input/textarea 控件。 */
export function isFormControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
    const tagName = element.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea';
}

/**
 * 判断元素是否是可参与翻译的 contenteditable 编辑宿主，包括富文本编辑器。
 * 富文本写回不直接改写 innerText/innerHTML，而是交给 editableHost.ts 的原生编辑路径，
 * 由编辑器自己更新模型；只读声明和代码编辑器保持不参与。
 */
export function isEditableHost(element: Element): element is HTMLElement {
    const value = element.getAttribute('contenteditable');
    if (value === null || !EDITABLE_HOST_VALUES.has(value.toLowerCase())) return false;
    if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false;
    return !element.closest(CODE_EDITOR_SELECTOR);
}

/** 判断元素是否是可翻译的文本输入目标。 */
export function isInputElement(element: Element | null): element is HTMLElement {
    if (!element) return false;
    if ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) return false;
    if ('readOnly' in element && Boolean((element as HTMLInputElement | HTMLTextAreaElement).readOnly)) return false;

    const tagName = element.tagName.toLowerCase();
    if (tagName === 'input') {
        return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type.toLowerCase());
    }
    if (tagName === 'textarea') return true;

    return isEditableHost(element);
}

/** 统一编辑器内部的零宽占位与不换行空格，避免宿主表示差异进入原文或打断三连判定。 */
export function normalizeEditableText(text: string): string {
    return text.replace(IGNORED_EDITABLE_CHARACTERS, '').replace(/\u00A0/g, ' ');
}

/** 获取输入目标中的纯文本；编辑宿主按可见换行读取并剔除编辑器占位。 */
export function getInputBoxText(element: HTMLElement): string {
    if (isFormControl(element)) return element.value;
    if (element.querySelector(EDITOR_PLACEHOLDER_SELECTOR)) return '';

    return normalizeEditableText(element.innerText || element.textContent || '');
}

/** 读取原生输入控件当前选区；编辑宿主的光标由 editableHost.ts 按文本度量读取。 */
export function getInputBoxSelection(element: HTMLElement): InputBoxSelection | null {
    if (!isFormControl(element)) return null;
    const valueLength = element.value.length;
    if (element.selectionStart === null || element.selectionEnd === null) return null;
    const start = typeof element.selectionStart === 'number'
        ? element.selectionStart
        : valueLength;
    const end = typeof element.selectionEnd === 'number'
        ? element.selectionEnd
        : start;
    return {start, end};
}

/** 计算一次触发键默认插入后，输入框将拥有的值和选区。 */
export function getInputBoxValueAfterInsertion(
    value: string,
    selection: InputBoxSelection,
    symbol: string,
): {value: string; selection: InputBoxSelection} {
    const start = Math.max(0, Math.min(selection.start, value.length));
    const end = Math.max(start, Math.min(selection.end, value.length));
    return {
        value: `${value.slice(0, start)}${symbol}${value.slice(end)}`,
        selection: {start: start + symbol.length, end: start + symbol.length},
    };
}

/** 只移除本次触发实际插入的字符区间，保留用户原有的同类符号。 */
export function removeInsertedTriggerSymbols(
    value: string,
    trigger: string,
    start: number,
    count = 2,
): string {
    const triggerSymbol = trigger === 'triple_space'
        ? ' '
        : trigger === 'triple_equal'
            ? '='
            : trigger === 'triple_dash'
                ? '-'
                : '';
    if (!triggerSymbol || count <= 0) return value;
    const safeStart = Math.max(0, Math.min(start, value.length));
    const end = safeStart + (triggerSymbol.length * count);
    const inserted = value.slice(safeStart, end);
    if (inserted !== triggerSymbol.repeat(count)) return value;
    return `${value.slice(0, safeStart)}${value.slice(end)}`;
}

/**
 * 获取输入目标的提交快照。原生控件保留原始值；编辑宿主比较完整 DOM 序列化，
 * 无需读取会触发布局的 innerText，仍能保护首尾空白、段落、链接与格式变化。
 * 返回值只用于相等比较，不是翻译原文；最小 DOM 适配器无 innerHTML 时沿用文本快照。
 */
export function getInputBoxValueSnapshot(element: HTMLElement): string {
    if (isFormControl(element)) return element.value;

    const markup = element.innerHTML;
    return typeof markup === 'string'
        ? markup
        : element.innerText || element.textContent || '';
}

export interface InputBoxTranslationCommitState {
    signal: AbortSignal;
    expectedValue: string;
    currentValue: string;
    expectedConfigGeneration: number;
    currentConfigGeneration: number;
    isEnabled: boolean;
    isSiteDisabled: boolean;
    expectedEditGeneration?: number;
    currentEditGeneration?: number;
}

/** 判断一个异步输入框翻译结果是否仍可安全写回页面。 */
export function canCommitInputBoxTranslation(state: InputBoxTranslationCommitState): boolean {
    return !state.signal.aborted
        && state.isEnabled
        && !state.isSiteDisabled
        && state.currentConfigGeneration === state.expectedConfigGeneration
        && (state.expectedEditGeneration === undefined
            || state.currentEditGeneration === state.expectedEditGeneration)
        && state.currentValue === state.expectedValue;
}

/** 判断一次键盘事件是否匹配当前的三连击触发方式。 */
export function matchesInputBoxTrigger(event: KeyboardEvent, trigger: InputBoxTrigger): boolean {
    switch (trigger) {
        case 'triple_space':
            return event.key === ' ' || event.code === 'Space';
        case 'triple_equal':
            return event.key === '=' || (event.code === 'Equal' && !event.shiftKey);
        case 'triple_dash':
            return event.key === '-' || (event.code === 'Minus' && !event.shiftKey);
        default:
            return false;
    }
}
