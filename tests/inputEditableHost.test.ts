import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    EDITABLE_PASTE_SETTLE_LIMIT_MS,
    insertIntoEditableCaretState,
    isSameEditableCaretState,
    readEditableCaretState,
    replaceEditableText,
} from '@/src/features/input-translation/content/editableHost';

/** 按文档顺序截取 root 内到 (endNode, endOffset) 为止的文本，模拟浏览器 Range.toString。 */
function textBefore(root: Node, endNode: Node, endOffset: number): string {
    let text = '';
    let done = false;
    const visit = (node: Node) => {
        if (done) return;
        if (node === endNode) {
            text += node.nodeType === 3
                ? (node as Text).data.slice(0, endOffset)
                : Array.from(node.childNodes).slice(0, endOffset).map(child => child.textContent).join('');
            done = true;
            return;
        }
        if (node.nodeType === 3) {
            text += (node as Text).data;
            return;
        }
        Array.from(node.childNodes).forEach(visit);
    };
    visit(root);
    return text;
}

/** linkedom 的 Range 不支持 setEnd/toString，这里只实现编辑宿主度量所需的最小行为。 */
class FakeRange {
    root: Node | null = null;
    startContainer: Node | null = null;
    startOffset = 0;
    endContainer: Node | null = null;
    endOffset = 0;
    ended = false;

    get collapsed(): boolean {
        return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }

    selectNodeContents(node: Node): void {
        this.root = node;
        this.startContainer = node;
        this.startOffset = 0;
        this.endContainer = node;
        this.endOffset = node.childNodes.length;
        this.ended = false;
    }

    setEnd(node: Node, offset: number): void {
        this.endContainer = node;
        this.endOffset = offset;
        this.ended = true;
    }

    setStart(node: Node, offset: number): void {
        this.startContainer = node;
        this.startOffset = offset;
    }

    collapse(toStart: boolean): void {
        if (toStart) {
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
        } else {
            this.startContainer = this.endContainer;
            this.startOffset = this.endOffset;
        }
        this.ended = true;
    }

    cloneRange(): FakeRange {
        return Object.assign(new FakeRange(), this);
    }

    toString(): string {
        const end = this.ended ? textBefore(this.root!, this.endContainer!, this.endOffset) : this.root!.textContent || '';
        return end.slice(textBefore(this.root!, this.startContainer!, this.startOffset).length);
    }
}

class FakeDataTransfer {
    data = new Map<string, string>();
    setData(type: string, value: string): void { this.data.set(type, value); }
    getData(type: string): string { return this.data.get(type) ?? ''; }
}

function editorPage(html: string, options: {selectionEvents?: boolean} = {}) {
    const parsed = parseHTML(`<html><body>${html}<p id="outside">outside</p></body></html>`);
    const {document} = parsed;
    // linkedom 的内建构造器优先于 window 自有属性；独立包装可真实模拟浏览器 API 缺失与 targetRanges。
    const browserOverrides = new Map<PropertyKey, unknown>();
    const window = new Proxy(parsed.window, {
        get: (target, key) => browserOverrides.has(key) ? browserOverrides.get(key) : Reflect.get(target, key),
        set: (_target, key, value) => { browserOverrides.set(key, value); return true; },
    });
    Object.defineProperty(document, 'defaultView', {value: window, configurable: true});
    const element = document.querySelector<HTMLElement>('[contenteditable]')!;
    element.focus = vi.fn();
    Object.defineProperty(document, 'activeElement', {value: element, writable: true});
    const selection = {
        ranges: [] as FakeRange[],
        get rangeCount() { return this.ranges.length; },
        get isCollapsed() {
            const range = this.ranges[0];
            return !!range && range.startContainer === range.endContainer && range.startOffset === range.endOffset;
        },
        get focusNode() { return this.ranges[0]?.endContainer; },
        get focusOffset() { return this.ranges[0]?.endOffset || 0; },
        toString() { return this.ranges[0]?.toString() || ''; },
        removeAllRanges: vi.fn(() => { selection.ranges = []; }),
        addRange: vi.fn((range: FakeRange) => {
            selection.ranges.push(range);
            if (options.selectionEvents !== false) {
                setTimeout(() => document.dispatchEvent(new window.Event('selectionchange')), 1);
            }
        }),
        getRangeAt: (index: number) => selection.ranges[index],
    };
    document.getSelection = vi.fn(() => selection) as never;
    document.createRange = vi.fn(() => new FakeRange()) as never;
    const execCommand = vi.fn((_command: string, _ui: boolean, text: string) => {
        const range = selection.ranges[0];
        if (range?.collapsed) {
            const container = range.startContainer!;
            if (container.nodeType === 3) {
                const node = container as Text;
                node.data = `${node.data.slice(0, range.startOffset)}${text}${node.data.slice(range.startOffset)}`;
            } else container.insertBefore(document.createTextNode(text), container.childNodes[range.startOffset] || null);
            return true;
        }
        if (text === '' && range?.startContainer?.nodeType === 3 && range.startContainer === range.endContainer) {
            const node = range.startContainer as Text;
            node.data = `${node.data.slice(0, range.startOffset)}${node.data.slice(range.endOffset)}`;
            return true;
        }
        element.textContent = text;
        return true;
    });
    document.execCommand = execCommand as never;
    Object.assign(window, {
        DataTransfer: FakeDataTransfer,
        InputEvent: class extends window.Event {
            inputType: string;
            data: string | null;
            dataTransfer: DataTransfer | null;
            targetRanges: StaticRange[];
            constructor(type: string, init: InputEventInit) {
                super(type, init);
                this.inputType = init.inputType!;
                this.data = init.data!;
                this.dataTransfer = init.dataTransfer ?? null;
                this.targetRanges = init.targetRanges!;
            }
            getTargetRanges() { return this.targetRanges; }
        },
        StaticRange: class {
            constructor(init: StaticRangeInit) { Object.assign(this, init); }
        },
        ClipboardEvent: class extends window.Event {
            clipboardData: FakeDataTransfer;
            constructor(type: string, init: EventInit & {clipboardData: FakeDataTransfer}) {
                super(type, init);
                this.clipboardData = init.clipboardData;
            }
        },
    });
    return {document, window, element, selection, execCommand};
}

async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return promise;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('编辑宿主光标度量', () => {
    it('按 textContent 口径读取折叠光标，并忽略零宽占位与不换行空格差异', () => {
        const {document, element} = editorPage('<div contenteditable="true"><p>Hello <b>wor</b>ld​</p><p>two</p></div>');
        const bold = element.querySelector('b')!.firstChild!;
        document.getSelection = vi.fn(() => ({isCollapsed: true, focusNode: bold, focusOffset: 2})) as never;

        const state = readEditableCaretState(element);

        expect(state).toEqual({text: 'Hello worldtwo', caret: 8});
        expect(insertIntoEditableCaretState(state!, ' ')).toEqual({text: 'Hello wo rldtwo', caret: 9});
        expect(isSameEditableCaretState(state, {text: 'Hello worldtwo', caret: 8})).toBe(true);
        expect(isSameEditableCaretState(state, {text: 'Hello worldtwo', caret: 7})).toBe(false);
        expect(isSameEditableCaretState(state, {text: 'Hello world', caret: 8})).toBe(false);
        expect(isSameEditableCaretState(null, {text: '', caret: 0})).toBe(false);
    });

    it('光标以元素子节点偏移表示时同样能计算前缀', () => {
        const {document, element} = editorPage('<div contenteditable="true"><p>One</p><p>Two</p></div>');
        document.getSelection = vi.fn(() => ({isCollapsed: true, focusNode: element, focusOffset: 1})) as never;
        expect(readEditableCaretState(element)).toEqual({text: 'OneTwo', caret: 3});
    });

    it('没有选区、选中范围、缺少焦点节点或光标不在宿主内时拒绝度量', () => {
        const {document, element} = editorPage('<div contenteditable="true">Hello</div>');
        const text = element.firstChild!;
        const outside = document.getElementById('outside')!.firstChild!;
        for (const selection of [
            null,
            {isCollapsed: false, focusNode: text, focusOffset: 1},
            {isCollapsed: true, focusNode: null, focusOffset: 0},
            {isCollapsed: true, focusNode: outside, focusOffset: 1},
        ]) {
            document.getSelection = vi.fn(() => selection) as never;
            expect(readEditableCaretState(element)).toBeNull();
        }
    });

    it('Shadow DOM 编辑宿主优先读取所在 shadowRoot 的选区，缺失时回到文档选区', () => {
        const {document, element} = editorPage('<div contenteditable="true">Hello</div>');
        const text = element.firstChild!;
        const documentSelection = vi.fn(() => ({isCollapsed: true, focusNode: text, focusOffset: 5}));
        document.getSelection = documentSelection as never;
        const rootSelection = vi.fn(() => ({isCollapsed: true, focusNode: text, focusOffset: 2}) as unknown as Selection | null);
        element.getRootNode = vi.fn(() => ({getSelection: rootSelection})) as never;

        expect(readEditableCaretState(element)?.caret).toBe(2);
        expect(documentSelection).not.toHaveBeenCalled();

        rootSelection.mockReturnValueOnce(null);
        expect(readEditableCaretState(element)?.caret).toBe(5);

        element.getRootNode = vi.fn(() => ({})) as never;
        expect(readEditableCaretState(element)?.caret).toBe(5);
    });
});

describe('编辑宿主原生写回', () => {
    it('beforeinput 文本输入让旧模型光标按本次全选范围同步，并且只提交一次译文', async () => {
        const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
        const model = {text: 'Hello', start: 5, end: 5};
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener('beforeinput', event => {
            const input = event as InputEvent;
            expect(input.inputType).toBe('insertText');
            expect(input.data).toBe('Bonjour');
            expect(input.dataTransfer).toBeNull();
            const [target] = input.getTargetRanges();
            model.start = textBefore(page.element, target.startContainer, target.startOffset).length;
            model.end = textBefore(page.element, target.endContainer, target.endOffset).length;
            const translated = input.data!;
            event.preventDefault();
            model.text = `${model.text.slice(0, model.start)}${translated}${model.text.slice(model.end)}`;
            page.element.textContent = model.text;
        });

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(model).toEqual({text: 'Bonjour', start: 0, end: 5});
        expect(page.element.textContent).toBe('Bonjour');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['start', 'end'] as const)('beforeinput 在 %s 空范围插入双语译文，保留原文格式', async position => {
        const page = editorPage('<div contenteditable="true"><b>中文</b><a href="https://example.test">链接</a></div>');
        const markup = page.element.innerHTML;
        page.element.addEventListener('beforeinput', event => {
            const input = event as InputEvent;
            expect(input.inputType).toBe('insertText');
            const [range] = input.getTargetRanges();
            expect(range.startContainer).toBe(range.endContainer);
            expect(range.startOffset).toBe(range.endOffset);
            event.preventDefault();
            const node = page.document.createTextNode(input.data!);
            if (position === 'start') page.element.insertBefore(node, page.element.firstChild);
            else page.element.appendChild(node);
        });

        await expect(settle(replaceEditableText(page.element, '\nEnglish', () => true, position))).resolves.toBe('replaced');
        expect(page.element.innerHTML).toBe(position === 'start' ? `\nEnglish${markup}` : `${markup}\nEnglish`);
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['all', 'start', 'end'] as const)('beforeinput 纯文本 %s 写入逐字保留多行和空行，不变成额外段落间隔', async position => {
        const page = editorPage('<div contenteditable="true"><b>中文</b><a href="https://example.test">链接</a></div>');
        const original = page.element.textContent!;
        const bold = page.element.querySelector('b');
        const link = page.element.querySelector('a');
        const translation = 'First line.\n\nSecond line.\n';
        const insert = position === 'start' ? `${translation}\n\n`
            : position === 'end' ? `\n\n${translation}` : translation;
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener('beforeinput', event => {
            const input = event as InputEvent;
            expect(input.inputType).toBe('insertText');
            expect(input.data).toBe(insert);
            expect(input.dataTransfer).toBeNull();
            event.preventDefault();
            const node = page.document.createTextNode(input.data!);
            if (position === 'start') page.element.insertBefore(node, page.element.firstChild);
            else if (position === 'end') page.element.appendChild(node);
            else page.element.textContent = node.textContent;
        });

        await expect(settle(replaceEditableText(page.element, insert, () => true, position))).resolves.toBe('replaced');
        expect(page.element.textContent).toBe(position === 'start' ? insert + original
            : position === 'end' ? original + insert : insert);
        if (position !== 'all') {
            expect(page.element.querySelector('b')).toBe(bold);
            expect(page.element.querySelector('a')).toBe(link);
        }
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['start', 'end'] as const)('折叠光标 %s 写入单字符使用明确替换事件，不留下原生输入的延后字符', async position => {
        for (const character of ['a', '中', ' ']) {
            const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
            const bold = page.element.querySelector('b');
            const pendingNativeCharacters: string[] = [];
            const paste = vi.fn();
            page.element.addEventListener('paste', paste);
            page.element.addEventListener('beforeinput', event => {
                const input = event as InputEvent;
                if (input.inputType === 'insertText') {
                    pendingNativeCharacters.push(input.data!);
                    return;
                }
                expect(input.inputType).toBe('insertReplacementText');
                expect(input.data).toBeNull();
                expect(input.dataTransfer!.getData('text/plain')).toBe(character);
                const [range] = input.getTargetRanges();
                expect(range.startOffset).toBe(range.endOffset);
                event.preventDefault();
                const node = page.document.createTextNode(input.dataTransfer!.getData('text/plain'));
                if (position === 'start') page.element.insertBefore(node, page.element.firstChild);
                else page.element.appendChild(node);
            });

            await expect(settle(replaceEditableText(page.element, character, () => true, position))).resolves.toBe('replaced');
            expect(page.element.textContent).toBe(position === 'start' ? character + 'Hello' : 'Hello' + character);
            expect(page.element.querySelector('b')).toBe(bold);
            expect(pendingNativeCharacters).toEqual([]);
            expect(paste).not.toHaveBeenCalled();
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('选中全文写入单字符仍用 insertText；缺少单字符替换所需数据接口时不先派发可能延后提交的 insertText', async () => {
        const whole = editorPage('<div contenteditable="true">Hello</div>');
        whole.element.addEventListener('beforeinput', event => {
            const input = event as InputEvent;
            expect(input.inputType).toBe('insertText');
            expect(input.data).toBe('a');
            event.preventDefault();
            whole.element.textContent = input.data;
        });
        await expect(settle(replaceEditableText(whole.element, 'a', () => true))).resolves.toBe('replaced');

        for (const position of ['start', 'end'] as const) {
            const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
            Object.assign(page.window, {DataTransfer: undefined});
            const input = vi.fn();
            page.element.addEventListener('beforeinput', input);
            await expect(settle(replaceEditableText(page.element, 'a', () => true, position))).resolves.toBe('replaced');
            expect(page.element.innerHTML).toBe(position === 'start' ? 'a<b>Hello</b>' : '<b>Hello</b>a');
            expect(input).not.toHaveBeenCalled();
            expect(page.execCommand).toHaveBeenCalledWith('insertText', false, 'a');
        }
    });

    it.each(['start', 'end'] as const)('单个换行在 %s 光标保持 insertText 原始数据，不经富文本段落拆分', async position => {
        for (const newline of ['\n', '\r']) {
            const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
            const bold = page.element.querySelector('b');
            page.element.addEventListener('beforeinput', event => {
                const input = event as InputEvent;
                expect(input.inputType).toBe('insertText');
                expect(input.data).toBe(newline);
                expect(input.dataTransfer).toBeNull();
                event.preventDefault();
                const node = page.document.createTextNode(input.data!);
                if (position === 'start') page.element.insertBefore(node, page.element.firstChild);
                else page.element.appendChild(node);
            });
            await expect(settle(replaceEditableText(page.element, newline, () => true, position))).resolves.toBe('replaced');
            expect(page.element.textContent).toBe(position === 'start' ? newline + 'Hello' : 'Hello' + newline);
            expect(page.element.querySelector('b')).toBe(bold);
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('beforeinput 文本输入被接管后等待异步模型提交，不派发第二次 paste', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener('beforeinput', event => {
            const translated = (event as InputEvent).data!;
            event.preventDefault();
            setTimeout(() => { page.element.textContent = translated; }, 35);
        });

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('beforeinput 文本输入被接管但未提交时保留原文，不通过 paste/native 重复写入', async () => {
        const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener('beforeinput', event => event.preventDefault());

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('unsupported');
        expect(page.element.innerHTML).toBe('<b>Hello</b>');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('beforeinput 文本输入同步提交但未 preventDefault 时按预期文本确认，不重复插入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener('beforeinput', event => {
            page.element.textContent = (event as InputEvent).data!;
        });

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['start', 'end'] as const)('双语输出只选中 %s 空范围，保留原文加粗节点和链接', async position => {
        const page = editorPage('<div contenteditable="true"><b>中文</b><a href="https://example.test">链接</a></div>');
        const bold = page.element.querySelector('b');
        const link = page.element.querySelector('a');
        page.element.addEventListener('paste', event => {
            expect(page.selection.isCollapsed).toBe(true);
            expect(page.selection.toString()).toBe('');
            event.preventDefault();
            const node = page.document.createTextNode((event as ClipboardEvent).clipboardData!.getData('text/plain'));
            if (position === 'start') page.element.insertBefore(node, page.element.firstChild);
            else page.element.appendChild(node);
        });
        await expect(settle(replaceEditableText(page.element, position === 'start' ? 'English\n' : '\nEnglish', () => true, position))).resolves.toBe('replaced');
        expect(page.element.textContent).toBe(position === 'start' ? 'English\n中文链接' : '中文链接\nEnglish');
        expect(page.element.querySelector('b')).toBe(bold);
        expect(page.element.querySelector('a')).toBe(link);
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('追加等待期间光标移到正文时不写入', async () => {
        const page = editorPage('<div contenteditable="true">中文</div>');
        page.document.addEventListener('selectionchange', () => {
            const range = new FakeRange();
            range.selectNodeContents(page.element);
            range.setEnd(page.element.firstChild!, 1);
            range.collapse(false);
            page.selection.ranges = [range];
        });
        await expect(settle(replaceEditableText(page.element, '\nEnglish', () => true, 'end'))).resolves.toBe('stale');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each([['=', '===', '='], [' ', ' \u00a0\u00a0', ' ']])('清理本次光标前的两个触发符 %s，不删除原文已有符号和格式', async (symbol, suffix, retained) => {
        const page = editorPage(`<div contenteditable="true"><b>原文${suffix}</b></div>`);
        const text = page.element.querySelector('b')!.firstChild! as Text;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, text.data.length);
        caret.collapse(false);
        page.selection.ranges = [caret];
        page.execCommand.mockReturnValue(false);
        page.element.addEventListener('paste', event => {
            expect(page.selection.toString()).toBe(suffix.slice(-2));
            event.preventDefault();
            text.data = text.data.slice(0, -2);
        });
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', symbol))).resolves.toBe('replaced');
        expect(page.element.innerHTML).toBe(`<b>原文${retained}</b>`);
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('原生编辑器未接管模型事件时通过原生删除清理触发符，保留格式与源符号', async () => {
        const page = editorPage('<div contenteditable="true"><b>原文===</b></div>');
        const text = page.element.querySelector('b')!.firstChild!;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 5);
        caret.collapse(false);
        page.selection.ranges = [caret];
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('replaced');
        expect(page.element.innerHTML).toBe('<b>原文=</b>');
        expect(page.execCommand).toHaveBeenCalledOnce();
        expect(page.execCommand).toHaveBeenCalledWith('delete', false, '');
        expect(paste).toHaveBeenCalledOnce();
    });

    it('删除 beforeinput 提供准确静态范围，由模型提交触发符清理，不再调用粘贴或原生命令', async () => {
        const page = editorPage('<div contenteditable="true"><b>原文===</b></div>');
        const text = page.element.querySelector('b')!.firstChild! as Text;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 5);
        caret.collapse(false);
        page.selection.ranges = [caret];
        const clipboard = vi.fn();
        page.element.addEventListener('cut', clipboard);
        page.element.addEventListener('paste', clipboard);
        page.element.addEventListener('beforeinput', event => {
            const input = event as InputEvent;
            expect(input.inputType).toBe('deleteContentBackward');
            expect(input.data).toBeNull();
            expect(input.getTargetRanges()).toMatchObject([{startContainer: text, startOffset: 3, endContainer: text, endOffset: 5}]);
            event.preventDefault();
            text.data = '原文=';
        });

        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('replaced');
        expect(page.element.innerHTML).toBe('<b>原文=</b>');
        expect(clipboard).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['beforeinput', 'cut'] as const)('删除 %s 被接管后等待异步模型提交，不触发第二次删除', async source => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener(source, event => {
            event.preventDefault();
            if (source === 'cut') {
                const clipboard = (event as ClipboardEvent).clipboardData!;
                expect(clipboard.getData('text/plain')).toBe('');
                clipboard.setData('text/plain', page.selection.toString());
            }
            setTimeout(() => { page.element.textContent = ''; }, 30);
        });

        await expect(settle(replaceEditableText(page.element, '', () => true))).resolves.toBe('replaced');
        expect(page.element.textContent).toBe('');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['beforeinput', 'cut'] as const)('删除 %s 被接管但未提交时保留宿主，不再 fallback', async source => {
        const page = editorPage('<div contenteditable="true"><b>Hello</b></div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener(source, event => event.preventDefault());

        await expect(settle(replaceEditableText(page.element, '', () => true))).resolves.toBe('unsupported');
        expect(page.element.innerHTML).toBe('<b>Hello</b>');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['beforeinput', 'cut'] as const)('删除 %s 已同步提交但未 preventDefault 时仍不重复删除', async source => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.element.addEventListener(source, () => { page.element.textContent = ''; });

        await expect(settle(replaceEditableText(page.element, '', () => true))).resolves.toBe('replaced');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['beforeinput', 'cut'] as const)('删除 %s 宿主回调取消请求或移动选区时停在该路径', async source => {
        for (const change of ['abort', 'stale', 'selection']) {
            const page = editorPage('<div contenteditable="true">Hello</div>');
            const controller = new AbortController();
            let current = true;
            const paste = vi.fn();
            page.element.addEventListener('paste', paste);
            page.element.addEventListener(source, () => {
                if (change === 'abort') controller.abort();
                else if (change === 'stale') current = false;
                else page.selection.removeAllRanges();
            });
            await expect(settle(replaceEditableText(page.element, '', () => current, 'all', '', controller.signal))).resolves.toBe('stale');
            expect(page.element.textContent).toBe('Hello');
            expect(paste).not.toHaveBeenCalled();
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('删除事件构造器缺失时保留标准降级路径，StaticRange 缺失时交给编辑器读取当前选区', async () => {
        const noRange = editorPage('<div contenteditable="true">Hello</div>');
        Object.assign(noRange.window, {StaticRange: undefined});
        noRange.element.addEventListener('beforeinput', event => {
            expect((event as InputEvent).getTargetRanges()).toEqual([]);
            event.preventDefault();
            noRange.element.textContent = '';
        });
        await expect(settle(replaceEditableText(noRange.element, '', () => true))).resolves.toBe('replaced');

        const noInput = editorPage('<div contenteditable="true">Hello</div>');
        Object.assign(noInput.window, {InputEvent: undefined});
        noInput.element.addEventListener('cut', event => {
            event.preventDefault();
            noInput.element.textContent = '';
        });
        await expect(settle(replaceEditableText(noInput.element, '', () => true))).resolves.toBe('replaced');
        expect(noInput.execCommand).not.toHaveBeenCalled();

        const noWindow = editorPage('<div contenteditable="true">Hello</div>');
        Object.defineProperty(noWindow.document, 'defaultView', {value: null});
        await expect(settle(replaceEditableText(noWindow.element, '', () => true))).resolves.toBe('replaced');
        expect(noWindow.execCommand).toHaveBeenCalledWith('delete', false, '');
    });

    it('光标前符号不匹配或为空时不会删除原文', async () => {
        const page = editorPage('<div contenteditable="true">原文</div>');
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(page.element.firstChild!, 2);
        caret.collapse(false);
        page.selection.ranges = [caret];
        await expect(replaceEditableText(page.element, '', () => true, 'trigger', '=')).resolves.toBe('unsupported');
        await expect(replaceEditableText(page.element, '', () => true, 'trigger', '')).resolves.toBe('unsupported');
        Object.defineProperty(page.element.firstChild!, 'textContent', {value: null});
        await expect(replaceEditableText(page.element, '', () => true, 'trigger', '=')).resolves.toBe('unsupported');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('清理触发符缺少可靠文本光标时保留宿主内容', async () => {
        const page = editorPage('<div contenteditable="true">原文</div>');
        await expect(replaceEditableText(page.element, '', () => true, 'trigger', '=')).resolves.toBe('unsupported');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('清理触发符等待时用户选中另一处同样符号，不删除该处原文', async () => {
        const page = editorPage('<div contenteditable="true">Hello== world==</div>');
        const text = page.element.firstChild!;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 7);
        caret.collapse(false);
        page.selection.ranges = [caret];
        const paste = vi.fn();
        page.element.addEventListener('paste', paste);
        page.document.addEventListener('selectionchange', () => {
            const other = new FakeRange();
            other.selectNodeContents(page.element);
            other.setStart(text, 13);
            other.setEnd(text, 15);
            page.selection.ranges = [other];
        });
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('stale');
        expect(page.element.textContent).toBe('Hello== world==');
        expect(paste).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('编辑器同步把触发范围终点换成元素偏移时仍按同一字符位置清理', async () => {
        const page = editorPage('<div contenteditable="true"><b>Hello==</b></div>');
        const text = page.element.querySelector('b')!.firstChild! as Text;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 7);
        caret.collapse(false);
        page.selection.ranges = [caret];
        page.execCommand.mockReturnValue(false);
        page.document.addEventListener('selectionchange', () => {
            const synced = new FakeRange();
            synced.selectNodeContents(page.element);
            synced.setStart(text, 5);
            synced.setEnd(page.element, 1);
            page.selection.ranges = [synced];
        });
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            text.data = 'Hello';
        });
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('replaced');
        expect(page.element.innerHTML).toBe('<b>Hello</b>');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['empty', 'start-outside', 'end-outside', 'text'] as const)('触发符清理同步期间选区改变为 %s 时保留原文', async change => {
        const page = editorPage('<div contenteditable="true">Hello==</div>');
        const text = page.element.firstChild!;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 7);
        caret.collapse(false);
        page.selection.ranges = [caret];
        page.document.addEventListener('selectionchange', () => {
            if (change === 'empty') {
                page.selection.ranges = [];
                return;
            }
            const changed = new FakeRange();
            changed.selectNodeContents(page.element);
            changed.setStart(text, 5);
            changed.setEnd(text, 7);
            if (change === 'start-outside') changed.startContainer = page.document.getElementById('outside');
            else if (change === 'end-outside') changed.endContainer = page.document.getElementById('outside');
            else changed.setEnd(text, 6);
            page.selection.ranges = [changed];
        });
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('stale');
        expect(page.element.textContent).toBe('Hello==');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('Firefox 式多范围选区合起来相同但首段终点不匹配时拒绝清理', async () => {
        const page = editorPage('<div contenteditable="true">Hello== world==</div>');
        const text = page.element.firstChild!;
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(text, 7);
        caret.collapse(false);
        page.selection.ranges = [caret];
        page.selection.toString = () => page.selection.ranges.map(range => range.toString()).join('');
        page.document.addEventListener('selectionchange', () => {
            const first = new FakeRange();
            first.selectNodeContents(page.element);
            first.setStart(text, 5);
            first.setEnd(text, 6);
            const second = new FakeRange();
            second.selectNodeContents(page.element);
            second.setStart(text, 14);
            second.setEnd(text, 15);
            page.selection.ranges = [first, second];
        });
        await expect(settle(replaceEditableText(page.element, '', () => true, 'trigger', '='))).resolves.toBe('stale');
        expect(page.element.textContent).toBe('Hello== world==');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('编辑器同步接管纯文本粘贴时不再调用 insertText，并先选中全文再等待选区同步', async () => {
        const page = editorPage('<div contenteditable="true"><p>Hello <b>world</b></p></div>');
        const pasted: string[] = [];
        page.element.addEventListener('paste', (event: Event) => {
            const data = (event as ClipboardEvent).clipboardData!;
            pasted.push(data.getData('text/plain'));
            expect(page.selection.ranges[0].toString()).toBe('Hello world');
            event.preventDefault();
            page.element.textContent = data.getData('text/plain');
        });

        const result = await settle(replaceEditableText(page.element, '你好\n世界', () => true));

        expect(result).toBe('replaced');
        expect(pasted).toEqual(['你好\n世界']);
        expect(page.element.focus).toHaveBeenCalledWith({preventScroll: true});
        expect(page.selection.removeAllRanges).toHaveBeenCalledOnce();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('编辑器异步渲染粘贴结果时轮询等待，不会重复插入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', (event: Event) => {
            event.preventDefault();
            setTimeout(() => { page.element.textContent = 'Bonjour'; }, 45);
        });

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('普通 contenteditable 不处理合成粘贴时退回原生 insertText', async () => {
        const page = editorPage('<div contenteditable="true"></div>');

        await expect(settle(replaceEditableText(page.element, 'Hello', () => true))).resolves.toBe('replaced');
        expect(page.execCommand).toHaveBeenCalledWith('insertText', false, 'Hello');
        expect(page.element.textContent).toBe('Hello');
    });

    it('原生 insertText 不可用时报告 unsupported，不改写 DOM', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.execCommand.mockReturnValue(false);

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('unsupported');
        expect(page.element.textContent).toBe('Hello');
    });

    it('缺少原生编辑 API 或宿主阻止了实际写入时不报告成功', async () => {
        const missing = editorPage('<div contenteditable="true">Hello</div>');
        missing.document.execCommand = undefined as never;
        await expect(settle(replaceEditableText(missing.element, 'Bonjour', () => true))).resolves.toBe('unsupported');

        const blocked = editorPage('<div contenteditable="true">Hello</div>');
        blocked.execCommand.mockImplementation(() => true);
        await expect(settle(replaceEditableText(blocked.element, 'Bonjour', () => true))).resolves.toBe('unsupported');
        expect(blocked.element.textContent).toBe('Hello');
    });

    it('原生写入期间取消请求不报告成功', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const controller = new AbortController();
        page.execCommand.mockImplementation(() => {
            page.element.textContent = 'Bonjour';
            controller.abort();
            return true;
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal))).resolves.toBe('stale');
    });

    it('页面拦截粘贴但未确认写入时保留原文，不冒险原生插入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', (event: Event) => event.preventDefault());

        const running = replaceEditableText(page.element, 'Bonjour', () => true);
        await vi.advanceTimersByTimeAsync(EDITABLE_PASTE_SETTLE_LIMIT_MS - 40);
        expect(page.execCommand).not.toHaveBeenCalled();

        await expect(settle(running)).resolves.toBe('unsupported');
        expect(page.execCommand).not.toHaveBeenCalled();
        expect(page.element.textContent).toBe('Hello');
    });

    it('慢编辑器超过同步上限后只提交一次，不与原生 fallback 重复插入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            setTimeout(() => { page.element.textContent = 'Bonjour'; }, EDITABLE_PASTE_SETTLE_LIMIT_MS + 50);
        });

        const running = replaceEditableText(page.element, 'Bonjour', () => true);
        await vi.advanceTimersByTimeAsync(EDITABLE_PASTE_SETTLE_LIMIT_MS + 20);
        await expect(running).resolves.toBe('unsupported');
        expect(page.element.textContent).toBe('Hello');
        await vi.runAllTimersAsync();
        expect(page.element.textContent).toBe('Bonjour');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('同步接管粘贴时立即确认结果，无额外轮询延迟', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            page.element.textContent = 'Bonjour';
        });
        const running = replaceEditableText(page.element, 'Bonjour', () => true);
        await vi.advanceTimersByTimeAsync(17);
        await expect(running).resolves.toBe('replaced');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('异步 DOM 写入由观察器及时确认，并释放观察器与计时器', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const disconnect = vi.spyOn(page.window.MutationObserver.prototype, 'disconnect');
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            setTimeout(() => { page.element.textContent = 'Bonjour'; }, 45);
        });
        const running = replaceEditableText(page.element, 'Bonjour', () => true);
        await vi.advanceTimersByTimeAsync(62);
        await expect(running).resolves.toBe('replaced');
        expect(disconnect).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        disconnect.mockRestore();
    });

    it('粘贴不声明接管但已同步写入时不重复原生插入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', () => { page.element.textContent = 'Bonjour'; });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['request', 'selection', 'signal'] as const)('未接管粘贴回调改变 %s 时也不能继续原生插入', async change => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const controller = new AbortController();
        let current = true;
        page.element.addEventListener('paste', () => {
            if (change === 'request') current = false;
            else if (change === 'selection') page.selection.ranges = [];
            else controller.abort();
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => current, 'all', '', controller.signal))).resolves.toBe('stale');
        expect(page.element.textContent).toBe('Hello');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each([true, false])('粘贴期间出现非预期用户文本时返回 stale，接管状态 %s', async intercepted => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', event => {
            if (intercepted) event.preventDefault();
            page.element.textContent = '用户正在输入';
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('stale');
        expect(page.element.textContent).toBe('用户正在输入');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('模型把换行渲染成段落时仍能确认预期纯文本', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            page.element.innerHTML = '<p>Bonjour</p><p>monde</p>';
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour\nmonde', () => true))).resolves.toBe('replaced');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('已失效请求在任何聚焦与选区变更前拒绝写入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const controller = new AbortController();
        controller.abort();
        await expect(replaceEditableText(page.element, 'Bonjour', () => false)).resolves.toBe('stale');
        await expect(replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal)).resolves.toBe('stale');
        expect(page.element.focus).not.toHaveBeenCalled();
        expect(page.selection.removeAllRanges).not.toHaveBeenCalled();
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('focus 回调取消请求时不改变宿主选区', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        let current = true;
        vi.mocked(page.element.focus).mockImplementation(() => { current = false; });
        await expect(replaceEditableText(page.element, 'Bonjour', () => current)).resolves.toBe('stale');
        expect(page.selection.removeAllRanges).not.toHaveBeenCalled();
    });

    it.each([false, true])('取消选区同步会立即释放监听与计时器，selectionchange 已到达 %s', async selectionEvents => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents});
        const controller = new AbortController();
        const running = replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal);
        if (selectionEvents) await vi.advanceTimersByTimeAsync(2);
        controller.abort();
        await expect(running).resolves.toBe('stale');
        expect(vi.getTimerCount()).toBe(0);
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it.each(['selection', 'paste'] as const)('取消 %s 等待在默认输入前同步恢复原光标', async stage => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents: false});
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(page.element.firstChild!, 2);
        caret.collapse(false);
        page.selection.ranges = [caret];
        const controller = new AbortController();
        page.element.addEventListener('paste', event => event.preventDefault());
        const running = replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal);
        expect(page.selection.toString()).toBe('Hello');
        if (stage === 'paste') await vi.advanceTimersByTimeAsync(136);
        controller.abort();
        expect(readEditableCaretState(page.element)).toEqual({text: 'Hello', caret: 2});
        await expect(running).resolves.toBe('stale');
        expect(page.element.textContent).toBe('Hello');
        expect(page.execCommand).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['unsupported', 'stale'] as const)('写回 %s 后恢复仍属于扩展的选区', async result => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents: false});
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(page.element.firstChild!, 2);
        caret.collapse(false);
        page.selection.ranges = [caret];
        let current = true;
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            if (result === 'stale') current = false;
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => current))).resolves.toBe(result);
        expect(readEditableCaretState(page.element)).toEqual({text: 'Hello', caret: 2});
    });

    it('宿主失焦后取消不再修改选区，避免 Selection API 把焦点拉回旧编辑器', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents: false});
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(page.element.firstChild!, 2);
        caret.collapse(false);
        page.selection.ranges = [caret];
        const controller = new AbortController();
        const running = replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal);
        const writingRange = page.selection.ranges[0];
        const other = page.document.getElementById('outside');
        Object.assign(page.document, {activeElement: other});
        controller.abort();
        expect(page.selection.ranges[0]).toBe(writingRange);
        expect(page.document.activeElement).toBe(other);
        await expect(running).resolves.toBe('stale');
        expect(page.selection.addRange).toHaveBeenCalledOnce();
    });

    it.each(['caret', 'content', 'markup', 'start-node', 'end-node'] as const)('取消时用户改变 %s 不再还原旧选区', async change => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents: false});
        const caret = new FakeRange();
        caret.selectNodeContents(page.element);
        caret.setEnd(page.element.firstChild!, 2);
        caret.collapse(false);
        if (change === 'end-node') caret.setStart(page.element, 0);
        page.selection.ranges = [caret];
        const controller = new AbortController();
        const running = replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal);
        if (change === 'caret') {
            const moved = caret.cloneRange();
            moved.setEnd(page.element.firstChild!, 3);
            moved.collapse(false);
            page.selection.ranges = [moved];
        } else if (change === 'content') {
            page.element.textContent = '用户新输入';
        } else if (change === 'markup') {
            page.element.innerHTML = '<b>Hello</b>';
        } else {
            // 替换等值节点时原 HTML 不变，仍须检查触发前边界节点是否还连接。
            const savedEnd = page.element.firstChild!;
            // cloneRange 保存的终点通过节点迁移失效，同时保持当前全选仍覆盖同一文本。
            page.element.removeChild(savedEnd);
            page.element.appendChild(page.document.createTextNode('Hello'));
        }
        const beforeAbort = page.selection.ranges[0];
        controller.abort();
        expect(page.selection.ranges[0]).toBe(beforeAbort);
        await expect(running).resolves.toBe('stale');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('取消异步粘贴等待会立即释放观察器与计时器', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        const controller = new AbortController();
        const disconnect = vi.spyOn(page.window.MutationObserver.prototype, 'disconnect');
        page.element.addEventListener('paste', event => event.preventDefault());
        const running = replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal);
        await vi.advanceTimersByTimeAsync(17);
        controller.abort();
        await expect(running).resolves.toBe('stale');
        expect(disconnect).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(page.execCommand).not.toHaveBeenCalled();
        disconnect.mockRestore();
    });

    it('取消同步粘贴不论是否接管都不报告成功', async () => {
        for (const intercepted of [false, true]) {
            const page = editorPage('<div contenteditable="true">Hello</div>');
            const controller = new AbortController();
            page.element.addEventListener('paste', event => {
                if (intercepted) event.preventDefault();
                page.element.textContent = 'Bonjour';
                controller.abort();
            });
            await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true, 'all', '', controller.signal))).resolves.toBe('stale');
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('缺少 MutationObserver 时保留兼容检查并尊重请求取消', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>');
        Object.assign(page.window, {MutationObserver: undefined});
        let current = true;
        page.element.addEventListener('paste', event => {
            event.preventDefault();
            setTimeout(() => { current = false; }, 5);
        });
        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => current))).resolves.toBe('stale');
        expect(page.execCommand).not.toHaveBeenCalled();
    });

    it('拦截粘贴后若请求失效或选区被改动，不再退回原生插入', async () => {
        for (const change of ['request', 'selection'] as const) {
            const page = editorPage('<div contenteditable="true">Hello</div>');
            let current = true;
            page.element.addEventListener('paste', (event: Event) => {
                event.preventDefault();
                if (change === 'request') current = false;
                else page.selection.ranges = [];
            });

            await expect(settle(replaceEditableText(page.element, 'Bonjour', () => current))).resolves.toBe('stale');
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('等待选区同步期间请求失效或用户改变选区时不写入', async () => {
        const cases: Array<(page: ReturnType<typeof editorPage>) => {isCurrent: () => boolean}> = [
            () => ({isCurrent: () => false}),
            (page) => {
                page.document.addEventListener('selectionchange', () => { page.selection.ranges = []; });
                return {isCurrent: () => true};
            },
            (page) => {
                page.document.addEventListener('selectionchange', () => {
                    const partial = new FakeRange();
                    partial.selectNodeContents(page.element);
                    partial.setEnd(page.element.firstChild!, 2);
                    page.selection.ranges = [partial];
                });
                return {isCurrent: () => true};
            },
            (page) => {
                page.document.addEventListener('selectionchange', () => {
                    const outside = new FakeRange();
                    outside.selectNodeContents(page.document.getElementById('outside')!);
                    page.selection.ranges = [outside];
                });
                return {isCurrent: () => true};
            },
            (page) => {
                page.document.addEventListener('selectionchange', () => {
                    const escaped = new FakeRange();
                    escaped.selectNodeContents(page.element);
                    escaped.endContainer = page.document.getElementById('outside');
                    page.selection.ranges = [escaped];
                });
                return {isCurrent: () => true};
            },
        ];
        for (const setup of cases) {
            const page = editorPage('<div contenteditable="true">Hello</div>');
            const paste = vi.fn();
            page.element.addEventListener('paste', paste);
            const {isCurrent} = setup(page);

            await expect(settle(replaceEditableText(page.element, 'Bonjour', isCurrent))).resolves.toBe('stale');
            expect(paste).not.toHaveBeenCalled();
            expect(page.execCommand).not.toHaveBeenCalled();
        }
    });

    it('selectionchange 未触发时按超时继续校验并写入', async () => {
        const page = editorPage('<div contenteditable="true">Hello</div>', {selectionEvents: false});

        await expect(settle(replaceEditableText(page.element, 'Bonjour', () => true))).resolves.toBe('replaced');
        expect(page.execCommand).toHaveBeenCalledOnce();
    });

    it('缺少剪贴板事件构造器或窗口时直接使用原生插入，没有选区时报告 unsupported', async () => {
        const noClipboard = editorPage('<div contenteditable="true">Hello</div>');
        Object.assign(noClipboard.window, {ClipboardEvent: undefined});
        await expect(settle(replaceEditableText(noClipboard.element, 'Bonjour', () => true))).resolves.toBe('replaced');

        const noDataTransfer = editorPage('<div contenteditable="true">Hello</div>');
        Object.assign(noDataTransfer.window, {DataTransfer: undefined});
        await expect(settle(replaceEditableText(noDataTransfer.element, 'Bonjour', () => true))).resolves.toBe('replaced');

        const detached = editorPage('<div contenteditable="true">Hello</div>');
        Object.defineProperty(detached.document, 'defaultView', {value: null});
        await expect(settle(replaceEditableText(detached.element, 'Bonjour', () => true))).resolves.toBe('replaced');

        const noSelection = editorPage('<div contenteditable="true">Hello</div>');
        noSelection.document.getSelection = vi.fn(() => null) as never;
        await expect(settle(replaceEditableText(noSelection.element, 'Bonjour', () => true))).resolves.toBe('unsupported');
        expect(noSelection.element.focus).not.toHaveBeenCalled();
    });
});
