/**
 * @file src/features/input-translation/content/editableHost.ts
 * 文件职责：为输入框翻译提供 contenteditable 编辑宿主（含 Lexical、ProseMirror、Draft.js、Slate、Quill 等富文本编辑器）的光标度量与原生编辑写回。
 * 主要内容：按 textContent 口径读取编辑宿主文本与折叠光标偏移，推算一次触发键插入后的期望状态；写回时按替换、首尾插入或清理触发符选择范围并等待编辑器同步模型选区，先交给标准 beforeinput 模型路径，空文本删除再尝试 cut，
 * 再派发只含纯文本的合成粘贴交给编辑器自身处理，未被接管时退回浏览器原生编辑命令；被接管后只确认预期文本，避免超时后的重复写入，保留编辑器模型、撤销历史与宿主事件链。
 * 模块边界：不注册长期监听、不发送翻译请求，也不直接改写 innerText/innerHTML；资格判定与文本归一化来自 inputBox.ts，
 * 请求所有权、快照校验和提示 UI 由 content/index.ts 通过 isCurrent 回调提供。
 */
import {getDeepActiveElement, normalizeEditableText} from './inputBox';

export interface EditableCaretState {
    /** 归一化后的 textContent，只用于连续性比较，不作为翻译原文。 */
    text: string;
    /** 折叠光标之前的归一化字符数。 */
    caret: number;
}

export type EditableReplacementResult = 'replaced' | 'stale' | 'unsupported';

/** 选中全文后最多等待 selectionchange 的时间；未触发时仍继续校验选区。 */
export const EDITABLE_SELECTION_SYNC_TIMEOUT_MS = 120;
/** selectionchange 之后留给编辑器防抖同步模型选区的时间（Slate 使用 0ms 防抖）。 */
export const EDITABLE_SELECTION_SETTLE_MS = 16;
/** 合成粘贴被接管后检查请求状态的间隔与 DOM 同步上限。 */
export const EDITABLE_PASTE_POLL_MS = 20;
export const EDITABLE_PASTE_SETTLE_LIMIT_MS = 300;

type SelectionRoot = Node & {getSelection?: () => Selection | null};

function readEditableText(element: HTMLElement): string {
    return normalizeEditableText(element.textContent || '');
}

/** 读取编辑宿主所在树的选区；Chromium 的开放 Shadow DOM 通过 shadowRoot.getSelection 暴露真实光标。 */
function getEditableSelection(element: HTMLElement): Selection | null {
    const root = element.getRootNode() as SelectionRoot;
    if (root !== element.ownerDocument && typeof root.getSelection === 'function') {
        const rootSelection = root.getSelection();
        if (rootSelection) return rootSelection;
    }
    return element.ownerDocument.getSelection();
}

/** 以宿主 textContent 的归一化字符口径度量任意 Range 边界，允许编辑器改写节点表示。 */
function readEditableBoundaryOffset(element: HTMLElement, node: Node, offset: number): number {
    const prefix = element.ownerDocument.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(node, offset);
    return normalizeEditableText(prefix.toString()).length;
}

/** 读取编辑宿主文本与折叠光标位置；选区不在宿主内或不是折叠光标时返回 null。 */
export function readEditableCaretState(element: HTMLElement): EditableCaretState | null {
    const selection = getEditableSelection(element);
    const focusNode = selection?.focusNode;
    if (!selection || !selection.isCollapsed || !focusNode || !element.contains(focusNode)) return null;

    return {
        text: readEditableText(element),
        caret: readEditableBoundaryOffset(element, focusNode, selection.focusOffset),
    };
}

/** 推算宿主按默认行为在光标处插入一个触发符号后的状态。 */
export function insertIntoEditableCaretState(state: EditableCaretState, symbol: string): EditableCaretState {
    return {
        text: `${state.text.slice(0, state.caret)}${symbol}${state.text.slice(state.caret)}`,
        caret: state.caret + symbol.length,
    };
}

export function isSameEditableCaretState(
    current: EditableCaretState | null,
    expected: EditableCaretState,
): boolean {
    return current !== null && current.text === expected.text && current.caret === expected.caret;
}

/** 确认选区仍完整覆盖编辑宿主；编辑器同步后可能把边界改写到内部文本节点，因此按文本比较。 */
function selectionCoversEditable(element: HTMLElement, selection: Selection): boolean {
    if (selection.rangeCount < 1) return false;
    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer)
        && element.contains(range.endContainer)
        && normalizeEditableText(range.toString()) === readEditableText(element);
}

/** 等待编辑器处理本次选区变化；Draft.js、Lexical、Slate 等在 selectionchange 后才同步模型选区。 */
function waitForSelectionSync(document: Document, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const complete = (synced: boolean) => {
            clearTimeout(timer);
            clearTimeout(settleTimer);
            document.removeEventListener('selectionchange', finish);
            signal?.removeEventListener('abort', abort);
            resolve(synced);
        };
        const finish = () => {
            clearTimeout(timer);
            document.removeEventListener('selectionchange', finish);
            settleTimer = setTimeout(() => complete(true), EDITABLE_SELECTION_SETTLE_MS);
        };
        const abort = () => complete(false);
        const timer = setTimeout(finish, EDITABLE_SELECTION_SYNC_TIMEOUT_MS);
        document.addEventListener('selectionchange', finish);
        signal?.addEventListener('abort', abort, {once: true});
    });
}

/** beforeinput 让编辑器在提交前同步模型选区；execCommand 在 Chromium 中可能只派发 input，使模型与 DOM 分离。 */
function dispatchEditableBeforeInput(element: HTMLElement, range: Range, text: string): boolean {
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.InputEvent !== 'function') return false;
    // 部分编辑器会延后提交折叠光标处的单字符 insertText；此时再 paste 会在下一次输入重放该字符。
    // 单个非换行字符使用明确的替换意图，其他文本保留 insertText 的原始换行口径。
    const replaceCharacter = range.collapsed && text.length === 1 && !/[\r\n]/.test(text);
    let dataTransfer: DataTransfer | null = null;
    if (replaceCharacter) {
        if (typeof view.DataTransfer !== 'function') return false;
        dataTransfer = new view.DataTransfer();
        dataTransfer.setData('text/plain', text);
    }
    const targetRanges = typeof view.StaticRange === 'function' ? [new view.StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
    })] : [];
    const event = new view.InputEvent('beforeinput', {
        inputType: text === '' ? 'deleteContentBackward' : replaceCharacter ? 'insertReplacementText' : 'insertText',
        data: text === '' || replaceCharacter ? null : text,
        dataTransfer,
        targetRanges,
        bubbles: true,
        cancelable: true,
        composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
}

/** 合成剪贴板事件只使用内存中的纯文本 DataTransfer，返回页面是否接管；cut 不访问系统剪贴板。 */
function dispatchEditableClipboard(element: HTMLElement, type: 'paste' | 'cut', text: string): boolean {
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.DataTransfer !== 'function' || typeof view.ClipboardEvent !== 'function') return false;
    const clipboardData = new view.DataTransfer();
    clipboardData.setData('text/plain', text);
    const event = new view.ClipboardEvent(type, {
        clipboardData,
        bubbles: true,
        cancelable: true,
        composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
}

/** 编辑器可能把换行渲染成块节点；textContent 的比较仅在确认写入时忽略这种表示差异。 */
function comparableEditableText(text: string): string {
    return normalizeEditableText(text).replace(/[\r\n]/g, '');
}

/** 等待被接管的粘贴落到 DOM；同步写入立即确认，异步写入由临时观察器唤醒，取消时释放所有等待。 */
function waitForEditableChange(
    element: HTMLElement,
    before: string,
    expected: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
): Promise<EditableReplacementResult> {
    return new Promise((resolve) => {
        let observer: MutationObserver | undefined;
        let checkTimer: ReturnType<typeof setTimeout> | undefined;
        let limitTimer: ReturnType<typeof setTimeout> | undefined;
        const complete = (result: EditableReplacementResult) => {
            clearTimeout(checkTimer);
            clearTimeout(limitTimer);
            observer?.disconnect();
            signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        const check = (): boolean => {
            if (signal?.aborted) {
                complete('stale');
                return true;
            }
            const current = readEditableText(element);
            if (current !== before) {
                complete(comparableEditableText(current) === comparableEditableText(expected) ? 'replaced' : 'stale');
                return true;
            }
            if (!isCurrent()) {
                complete('stale');
                return true;
            }
            return false;
        };
        const abort = () => complete('stale');
        if (check()) return;
        signal?.addEventListener('abort', abort, {once: true});
        const Observer = element.ownerDocument.defaultView?.MutationObserver;
        if (Observer) {
            observer = new Observer(() => { check(); });
            observer.observe(element, {childList: true, characterData: true, subtree: true});
        }
        const poll = () => {
            if (!check()) checkTimer = setTimeout(poll, EDITABLE_PASTE_POLL_MS);
        };
        checkTimer = setTimeout(poll, EDITABLE_PASTE_POLL_MS);
        limitTimer = setTimeout(() => complete('unsupported'), EDITABLE_PASTE_SETTLE_LIMIT_MS);
    });
}

/**
 * 用编辑器自己的编辑路径把选定范围替换为 text；首尾的空选区实现双语插入并保留原文结构。
 * 步骤：聚焦并选定范围 → 等待编辑器同步选区 → beforeinput（空文本再经 cut）→ 合成纯文本粘贴 → 未被接管时退回原生编辑命令。
 * isCurrent 在聚焦、选区改变与任何写入前重新校验；signal 能立即中断选区同步与 DOM 等待，并同步恢复仍由本次写回占用的选区。
 * 被接管的粘贴若未确认预期结果就返回 unsupported，不再次原生写入，避免慢编辑器随后提交导致重复插入。
 */
export async function replaceEditableText(
    element: HTMLElement,
    text: string,
    isCurrent: () => boolean,
    selectionMode: 'all' | 'start' | 'end' | 'trigger' = 'all',
    triggerSymbol = '',
    signal?: AbortSignal,
): Promise<EditableReplacementResult> {
    if (signal?.aborted || !isCurrent()) return 'stale';
    const document = element.ownerDocument;
    const selection = getEditableSelection(element);
    if (!selection) return 'unsupported';

    const range = document.createRange();
    range.selectNodeContents(element);
    let triggerCaret = 0;
    if (selectionMode === 'end') range.collapse(false);
    if (selectionMode === 'start') range.collapse(true);
    if (selectionMode === 'trigger') {
        // 连按的前两次已经进入宿主，只删除本次光标前的两个符号，不重写原文格式。
        const node = selection.focusNode;
        const offset = selection.focusOffset;
        if (!selection.isCollapsed || !node || node.nodeType !== 3 || !element.contains(node)
            || !triggerSymbol || normalizeEditableText((node.textContent || '').slice(offset - 2, offset)) !== triggerSymbol.repeat(2)) {
            return 'unsupported';
        }
        triggerCaret = readEditableCaretState(element)!.caret;
        range.setStart(node, offset - 2);
        range.setEnd(node, offset);
    }
    const selectedText = normalizeEditableText(range.toString());
    const before = readEditableText(element);
    const expected = selectionMode === 'all' ? text
        : selectionMode === 'start' ? `${text}${before}`
            : selectionMode === 'end' ? `${before}${text}`
                : `${before.slice(0, triggerCaret - selectedText.length)}${text}${before.slice(triggerCaret)}`;
    const selectionMatches = () => {
        if (selectionMode === 'all') return selectionCoversEditable(element, selection);
        if (selectionMode === 'end' || selectionMode === 'start') {
            const caret = readEditableCaretState(element);
            return caret !== null && caret.caret === (selectionMode === 'start' ? 0 : caret.text.length);
        }
        if (selection.rangeCount < 1) return false;
        const currentRange = selection.getRangeAt(0);
        return element.contains(currentRange.startContainer)
            && element.contains(currentRange.endContainer)
            && normalizeEditableText(selection.toString()) === selectedText
            && readEditableBoundaryOffset(element, currentRange.startContainer, currentRange.startOffset) === triggerCaret - selectedText.length
            && readEditableBoundaryOffset(element, currentRange.endContainer, currentRange.endOffset) === triggerCaret;
    };

    const beforeMarkup = element.innerHTML;
    const previousRanges = Array.from({length: selection.rangeCount}, (_, index) => {
        const previous = selection.getRangeAt(index);
        // Range 是 live 对象，节点移除会重定位端点；保留原节点引用才能识别模型重渲染。
        return {range: previous.cloneRange(), start: previous.startContainer, end: previous.endContainer};
    });
    const restoreOwnedSelection = () => {
        // 用户已移动光标、内容已改变或编辑器重新创建了原节点时，尊重当前编辑状态。
        if (!previousRanges.length || getDeepActiveElement(document) !== element
            || readEditableText(element) !== before || element.innerHTML !== beforeMarkup || !selectionMatches()
            || !previousRanges.every(previous => element.contains(previous.start) && element.contains(previous.end))) return;
        selection.removeAllRanges();
        previousRanges.forEach(previous => selection.addRange(previous.range));
    };
    // abort 回调必须同步还原，保证下一次用户键盘/IME 的默认编辑继续发生在原光标。
    signal?.addEventListener('abort', restoreOwnedSelection, {once: true});
    let result: EditableReplacementResult = 'unsupported';
    try {
        result = await (async (): Promise<EditableReplacementResult> => {
            // 步骤 1：先注册等待再改选区，确保捕获本次 selectionchange。
            element.focus({preventScroll: true});
            if (signal?.aborted || !isCurrent()) return 'stale';
            const synced = waitForSelectionSync(document, signal);
            selection.removeAllRanges();
            selection.addRange(range);
            if (!await synced || signal?.aborted || !isCurrent() || !selectionMatches()) return 'stale';

            // Slate 等编辑器会在 beforeinput 中同步刷新防抖/节流的模型选区；粘贴事件本身未必会同步。
            const inputHandled = dispatchEditableBeforeInput(element, selection.getRangeAt(0), text);
            if (inputHandled || readEditableText(element) !== before) {
                return await waitForEditableChange(element, before, expected, () => isCurrent() && selectionMatches(), signal);
            }
            if (signal?.aborted || !isCurrent() || !selectionMatches()) return 'stale';

            if (text === '') {
                // 空粘贴在部分编辑器中是被接管的无操作；beforeinput/cut 明确表达删除意图。
                // 每条模型路径只在未被接管、内容与选区均仍属本次请求时继续下一条路径。
                const cut = dispatchEditableClipboard(element, 'cut', '');
                if (cut || readEditableText(element) !== before) {
                    return await waitForEditableChange(element, before, expected, () => isCurrent() && selectionMatches(), signal);
                }
                if (signal?.aborted || !isCurrent() || !selectionMatches()) return 'stale';
            }

            // 步骤 2：富文本编辑器通常在 paste 中 preventDefault 并按自身模型插入多段文本。
            if (dispatchEditableClipboard(element, 'paste', text)) {
                return await waitForEditableChange(element, before, expected, () => isCurrent() && selectionMatches(), signal);
            }
            const afterPaste = readEditableText(element);
            if (afterPaste !== before) {
                return signal?.aborted ? 'stale'
                    : comparableEditableText(afterPaste) === comparableEditableText(expected) ? 'replaced' : 'stale';
            }

            // paste 的同步宿主回调即使未 preventDefault，也可能取消请求或移动选区。
            // 两种粘贴结果都须在原生写入前重新核对，不能让 fallback 覆盖新编辑。
            if (signal?.aborted || !isCurrent() || !selectionMatches()) return 'stale';

            // 步骤 3：普通 contenteditable 不处理模型事件，使用进入浏览器撤销栈的原生编辑命令。
            if (typeof document.execCommand !== 'function'
                || !document.execCommand(text === '' ? 'delete' : 'insertText', false, text)) return 'unsupported';
            if (signal?.aborted) return 'stale';
            return comparableEditableText(readEditableText(element)) === comparableEditableText(expected) ? 'replaced' : 'unsupported';
        })();
        return result;
    } finally {
        signal?.removeEventListener('abort', restoreOwnedSelection);
        if (result !== 'replaced') restoreOwnedSelection();
    }
}
