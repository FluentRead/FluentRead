import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const editable = vi.hoisted(() => ({
    replaceEditableText: vi.fn(),
    readEditableCaretState: vi.fn(),
}));

vi.mock('@/src/features/input-translation/content/editableHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/src/features/input-translation/content/editableHost')>(),
    replaceEditableText: editable.replaceEditableText,
    readEditableCaretState: editable.readEditableCaretState,
}));

import {
    createInputTranslationContentFeature,
    inputBoxTranslationConfigKey,
    isInputBoxTranslationEnabled,
    setInputBoxText,
    INPUT_TRANSLATION_TIMEOUT_MS,
    type InputTranslationContentConfig,
} from '@/src/features/input-translation/content';

type Listener = (event: any) => unknown;

class FakeDocument {
    activeElement: Element | null = null;
    listeners = new Map<string, Listener[]>();

    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        expect(options).toBeTruthy();
    }

    async emit(type: string, event: Record<string, unknown>): Promise<void> {
        for (const listener of this.listeners.get(type) || []) await listener(event);
    }

    createElement(tagName: string): any {
        return fakeElement(tagName);
    }
}

function fakeClassList() {
    const values = new Set<string>();
    return {
        values,
        add: vi.fn((name: string) => values.add(name)),
        remove: vi.fn((...names: string[]) => names.forEach(name => values.delete(name))),
    };
}

function fakeElement(tagName: string, attributes: Record<string, string> = {}): any {
    const element: any = {
        tagName: tagName.toUpperCase(),
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        innerText: '',
        textContent: '',
        type: 'text',
        isContentEditable: false,
        style: {},
        children: [] as any[],
        classList: fakeClassList(),
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn((type: string, listener: Listener) => {
            element.listeners ||= new Map<string, Listener[]>();
            const listeners = element.listeners.get(type) || [];
            listeners.push(listener);
            element.listeners.set(type, listeners);
        }),
        appendChild: vi.fn((child: any) => element.children.push(child)),
        closest: vi.fn(() => null),
        querySelector: vi.fn(() => null),
        getAttribute: vi.fn((name: string) => attributes[name] ?? null),
        setAttribute: vi.fn(),
        getBoundingClientRect: vi.fn(() => ({left: 10, width: 80, bottom: 20})),
    };
    return element;
}

function trustedKey(event: Record<string, unknown> = {}): any {
    return {
        isTrusted: true,
        key: '',
        code: '',
        ctrlKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...event,
    };
}

function createUiFactory(records: any[]) {
    return vi.fn(async (_ctx: unknown, options: any) => {
        const container = fakeElement('div');
        const ui: any = {
            shadowHost: fakeElement('div'),
            mounted: null,
            remove: vi.fn(),
            mount: vi.fn(() => {
                ui.mounted = options.onMount(container);
            }),
        };
        records.push({options, container, ui});
        return ui;
    });
}

function mountHarness(overrides: {
    config?: Partial<InputTranslationContentConfig>;
    isSiteDisabled?: () => boolean;
    sendMessage?: (message: unknown) => Promise<unknown>;
    generation?: () => number;
    createUi?: any;
} = {}) {
    const fakeDocument = new FakeDocument();
    const tooltipRecords: any[] = [];
    const config: InputTranslationContentConfig = {
        on: true,
        inputBoxTranslationTrigger: 'ctrl_enter',
        inputBoxTranslationTarget: 'zh',
        animations: false,
        ...overrides.config,
    };
    const sendMessage = vi.fn((message: any) => message.type === 'fluentReadTranslationCancel'
        ? Promise.resolve({success: true})
        : (overrides.sendMessage || (async () => ({success: true, translatedText: '你好'})))(message));
    const logger = {error: vi.fn()};
    const feature = createInputTranslationContentFeature({
        context: {onInvalidated: vi.fn()} as any,
        config,
        document: fakeDocument as unknown as Document,
        isSiteDisabled: overrides.isSiteDisabled || (() => false),
        readConfigGeneration: overrides.generation || (() => 0),
        sendMessage,
        createUi: overrides.createUi || createUiFactory(tooltipRecords) as any,
        logger,
    });
    const controller = new AbortController();
    feature.mount(controller.signal);

    return {config, controller, fakeDocument, feature, logger, sendMessage, tooltipRecords};
}

beforeEach(() => {
    editable.replaceEditableText.mockReset().mockResolvedValue('replaced');
    editable.readEditableCaretState.mockReset().mockReturnValue(null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('input translation content feature', () => {
    it('慢提示挂载不阻塞请求或提交，迟到 loading 不覆盖成功状态', async () => {
        const records: any[] = [];
        const base = createUiFactory(records);
        let release!: () => void;
        let first = true;
        const harness = mountHarness({createUi: async (context: unknown, options: unknown) => {
            const ui = await base(context, options);
            if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
            return ui;
        }});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(input.value).toBe('你好');
        expect(records.at(-1).ui.mounted.textContent).toContain('翻译成功');
        release();
        await vi.waitFor(() => expect(records[0].ui.remove).toHaveBeenCalledOnce());
        expect(records[0].ui.mount).not.toHaveBeenCalled();
    });

    it('重复触发沿用进行中请求，取消不等待后台响应且发送精确请求 ID', async () => {
        const harness = mountHarness({sendMessage: () => new Promise(() => {})});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        for (let count = 0; count < 5; count += 1) {
            await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        }
        expect(harness.sendMessage).toHaveBeenCalledOnce();
        const button = harness.tooltipRecords[0].ui.mounted.children.at(-1);
        const down = {preventDefault: vi.fn()};
        button.listeners.get('mousedown')[0](down);
        expect(down.preventDefault).toHaveBeenCalledOnce();
        button.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await running;
        expect(input.value).toBe('Hello');
        expect(harness.sendMessage).toHaveBeenLastCalledWith({type: 'fluentReadTranslationCancel',
            clientRequestId: harness.sendMessage.mock.calls[0][0].clientRequestId});
    });

    it.each([true, false])('富文本失焦后不抢回焦点或写入，focusout 事件=%s', async emitFocusOut => {
        let release!: (value: unknown) => void;
        const harness = mountHarness({sendMessage: () => new Promise(resolve => { release = resolve; })});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        const other = fakeElement('input');
        harness.fakeDocument.activeElement = other;
        if (emitFocusOut) await harness.fakeDocument.emit('focusout', {target: rich, relatedTarget: other});
        release({success: true, translatedText: '你好'});
        await running;
        expect(editable.replaceEditableText).not.toHaveBeenCalled();
        expect(harness.fakeDocument.activeElement).toBe(other);
    });

    it('无关输入事件不读取完整编辑器快照，其他输入框的 Esc 不吞键', async () => {
        const harness = mountHarness({sendMessage: () => new Promise(() => {})});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        const other = fakeElement('div', {contenteditable: 'true'});
        Object.defineProperty(other, 'innerText', {get: () => { throw new Error('unrelated layout read'); }});
        harness.fakeDocument.activeElement = other;
        await harness.fakeDocument.emit('input', {target: other});
        const escape = trustedKey({key: 'Escape'});
        await harness.fakeDocument.emit('keydown', escape);
        expect(escape.preventDefault).not.toHaveBeenCalled();
        harness.controller.abort();
        await running;
    });

    it('消息不返回时有界超时取消后台，重试使用新的请求 ID', async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const harness = mountHarness({sendMessage: async () => {
            if (++attempts === 1) return new Promise(() => {});
            return {success: true, translatedText: '你好'};
        }});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.advanceTimersByTimeAsync(INPUT_TRANSLATION_TIMEOUT_MS);
        await running;
        expect(input.value).toBe('Hello');
        expect(harness.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({type: 'fluentReadTranslationCancel'}));
        const retry = harness.tooltipRecords.at(-1).ui.mounted.children.at(-1);
        expect(retry.textContent).toBe('重试');
        retry.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await vi.advanceTimersByTimeAsync(0);
        expect(input.value).toBe('你好');
        const ids = harness.sendMessage.mock.calls.filter(([message]) => message.type === 'inputBoxTranslation').map(([message]) => message.clientRequestId);
        expect(new Set(ids).size).toBe(2);
        harness.controller.abort();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('提示跟随滚动和视口尺寸变化，卸载清理定位监听', async () => {
        const harness = mountHarness();
        const view: any = {innerWidth: 390, innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn()};
        (harness.fakeDocument as any).defaultView = view;
        const input = fakeElement('textarea');
        input.value = 'Hello';
        let rect = {left: 350, width: 80, top: 560, bottom: 590};
        input.getBoundingClientRect.mockImplementation(() => rect);
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const tooltip = harness.tooltipRecords.at(-1).ui.mounted;
        expect(tooltip.style.left).toBe('298px');
        const position = view.addEventListener.mock.calls.at(-2)[1];
        rect = {left: 0, width: 80, top: 100, bottom: 130};
        position();
        expect(tooltip.style.left).toBe('12px');
        expect(tooltip.style.top).toBe('142px');
        harness.controller.abort();
        expect(view.removeEventListener).toHaveBeenCalledWith('scroll', position, true);
        expect(view.removeEventListener).toHaveBeenCalledWith('resize', position);
    });

    it.each(['keydown', 'compositionstart', 'paste', 'cut', 'ctrl_key'])('恢复原文等待期间的 %s 能立即取消写入', async type => {
        const harness = mountHarness();
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        let signal!: AbortSignal;
        editable.replaceEditableText.mockImplementationOnce((_element, _text, _guard, _mode, _symbol, value) => {
            signal = value;
            return new Promise(resolve => value.addEventListener('abort', () => resolve('stale'), {once: true}));
        });
        const restore = harness.tooltipRecords.at(-1).ui.mounted.children.at(-1);
        restore.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
        restore.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        expect(editable.replaceEditableText).toHaveBeenCalledTimes(2);
        await harness.fakeDocument.emit(type === 'ctrl_key' ? 'keydown' : type,
            trustedKey({key: 'x', ctrlKey: type === 'ctrl_key', target: rich}));
        expect(signal.aborted).toBe(true);
    });

    it('完成后用户修改原文立即移除旧提示，迟到的自动移除不影响页面', async () => {
        vi.useFakeTimers();
        const harness = mountHarness();
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const success = harness.tooltipRecords.at(-1).ui;
        input.value = '继续写新草稿';
        await harness.fakeDocument.emit('input', {target: input});
        expect(success.remove).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(8000);
        expect(success.remove).toHaveBeenCalledOnce();
        expect(input.value).toBe('继续写新草稿');
    });

    it('提示尚无测量宽度时仍在视口内定位，滚动后使用真实尺寸', async () => {
        const records: any[] = [];
        const base = createUiFactory(records);
        const harness = mountHarness({createUi: async (context: unknown, options: any) => {
            const ui = await base(context, {...options, onMount: (container: HTMLElement) => {
                const tooltip = options.onMount(container);
                tooltip.getBoundingClientRect.mockReturnValue({width: 0, height: 0});
                return tooltip;
            }});
            return ui;
        }});
        const view: any = {innerWidth: 390, innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn()};
        (harness.fakeDocument as any).defaultView = view;
        const input = fakeElement('textarea');
        input.value = 'Hello';
        input.getBoundingClientRect.mockReturnValue({left: 350, width: 80, top: 560, bottom: 590});
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const tooltip = records.at(-1).ui.mounted;
        expect(tooltip.style.left).toBe('258px');
        expect(tooltip.style.top).toBe('504px');
        tooltip.getBoundingClientRect.mockReturnValue({width: 80, height: 20});
        view.addEventListener.mock.calls.at(-2)[1]();
        expect(tooltip.style.left).toBe('298px');
        harness.controller.abort();
    });

    it('原生控件失去写入所有权时不修改值或派发宿主输入事件', async () => {
        const input = fakeElement('textarea');
        input.value = '用户的新草稿';
        await expect(setInputBoxText(input, '旧译文', () => false)).resolves.toBe(false);
        expect(input.value).toBe('用户的新草稿');
        expect(input.dispatchEvent).not.toHaveBeenCalled();
    });

    it.each(['invalidate', 'unmount', 'config', 'disabled', 'site', 'readonly', 'disconnect'])
    ('宿主写入完成时发生 %s 不继续显示旧成功', async change => {
        let generation = 0;
        let siteDisabled = false;
        const harness = mountHarness({config: {animations: true}, generation: () => generation,
            isSiteDisabled: () => siteDisabled});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        editable.replaceEditableText.mockImplementationOnce(() => {
            if (change === 'invalidate') harness.feature.invalidate();
            if (change === 'unmount') harness.controller.abort();
            if (change === 'config') generation += 1;
            if (change === 'disabled') harness.config.on = false;
            if (change === 'site') siteDisabled = true;
            if (change === 'readonly') rich.getAttribute.mockImplementation((name: string) => name === 'contenteditable' ? 'false' : null);
            if (change === 'disconnect') rich.isConnected = false;
            return 'replaced';
        });
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(rich.classList.add).not.toHaveBeenCalledWith('fluent-input-success');
        expect(harness.tooltipRecords).toHaveLength(1);
        harness.controller.abort();
    });

    it('旧写入返回前宿主同步启动新请求，旧成功不拆新loading或样式', async () => {
        let secondRun!: Promise<void>;
        let request = 0;
        const harness = mountHarness({config: {animations: true}, sendMessage: async () => {
            if (request++ === 0) return {success: true, translatedText: '你好'};
            return new Promise(() => {});
        }});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        editable.replaceEditableText.mockImplementationOnce(() => {
            rich.innerText = '新的草稿';
            secondRun = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
            return 'replaced';
        });
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.tooltipRecords).toHaveLength(2));
        const current = harness.tooltipRecords.at(-1).ui;
        expect(current.remove).not.toHaveBeenCalled();
        expect(rich.classList.values.has('fluent-input-translating')).toBe(true);
        expect(rich.classList.values.has('fluent-input-success')).toBe(false);
        harness.controller.abort();
        await secondRun;
    });

    it.each(['control', 'editable'] as const)('三连触发的 %s 清理已被取消时不重新启动翻译', async kind => {
        for (const change of ['invalidate', 'config', 'disabled']) {
            let generation = 0;
            const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}, generation: () => generation});
            const input = kind === 'control' ? fakeElement('textarea') : fakeElement('div', {contenteditable: 'true'});
            input.value = input.innerText = '原文';
            input.selectionStart = input.selectionEnd = 2;
            let caret = {text: input.innerText, caret: 2};
            editable.readEditableCaretState.mockImplementation(() => caret);
            harness.fakeDocument.activeElement = input;
            const key = () => trustedKey({key: '=', code: 'Equal'});
            for (let count = 0; count < 2; count += 1) {
                await harness.fakeDocument.emit('keydown', key());
                input.value += '=';
                input.innerText += '=';
                input.selectionStart = input.selectionEnd = input.value.length;
                caret = {text: input.innerText, caret: input.innerText.length};
                await harness.fakeDocument.emit('input', {target: input});
            }
            const cancelCleanup = () => {
                if (change === 'invalidate') harness.feature.invalidate();
                if (change === 'config') generation += 1;
                if (change === 'disabled') harness.config.on = false;
            };
            if (kind === 'control') input.dispatchEvent.mockImplementationOnce(cancelCleanup);
            else editable.replaceEditableText.mockImplementationOnce(() => {cancelCleanup(); return 'replaced';});
            await harness.fakeDocument.emit('keydown', key());
            expect(harness.sendMessage).not.toHaveBeenCalled();
            harness.controller.abort();
        }
    });

    it('成功提示等待挂载时取消仍完整移除所有动画与迟到UI', async () => {
        vi.useFakeTimers();
        const records: any[] = [];
        const base = createUiFactory(records);
        let release!: () => void;
        let calls = 0;
        const harness = mountHarness({config: {animations: true}, createUi: async (context: unknown, options: unknown) => {
            const ui = await base(context, options);
            if (++calls === 2) await new Promise<void>(resolve => {release = resolve;});
            return ui;
        }});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(input.classList.values.has('fluent-input-success')).toBe(true);
        harness.feature.invalidate();
        expect(input.classList.values.size).toBe(0);
        release();
        await running;
        expect(records[1].ui.mount).not.toHaveBeenCalled();
        expect(records[1].ui.remove).toHaveBeenCalledOnce();
        harness.controller.abort();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('同步抛错的取消消息与宿主恢复异常不会变成未处理拒绝', async () => {
        const harness = mountHarness();
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        editable.replaceEditableText.mockRejectedValueOnce(new Error('host write failed'));
        const restore = harness.tooltipRecords.at(-1).ui.mounted.children.at(-1);
        restore.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await vi.waitFor(() => expect(harness.logger.error).toHaveBeenCalledWith('输入框翻译操作失败:', expect.any(Error)));
        harness.sendMessage.mockImplementation((message: any) => {
            if (message.type === 'fluentReadTranslationCancel') throw new Error('context gone');
            return new Promise(() => {});
        });
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'inputBoxTranslation'})));
        harness.controller.abort();
        await running;
    });

    it('继承服务变更作废输入请求键，独立服务忽略网页默认变更', () => {
        const base = {on: true, service: 'google', inputBoxTranslationTrigger: 'triple_slash', inputBoxTranslationTarget: 'en', inputBoxTranslationService: ''};
        expect(inputBoxTranslationConfigKey(base)).not.toBe(inputBoxTranslationConfigKey({...base, service: 'microsoft'}));
        const independent = {...base, inputBoxTranslationService: 'deepseek'};
        expect(inputBoxTranslationConfigKey(independent)).toBe(inputBoxTranslationConfigKey({...independent, service: 'microsoft'}));
    });

    it.each([
        {isComposing: true}, {keyCode: 229}, {repeat: true},
        {altKey: true}, {metaKey: true}, {shiftKey: true},
    ])('Ctrl+Enter 不接管组合输入、长按或额外快捷键 %j', async extra => {
        const harness = mountHarness();
        const input = fakeElement('textarea');
        input.value = '正在输入';
        harness.fakeDocument.activeElement = input;
        const event = trustedKey({key: 'Enter', ctrlKey: true, ...extra});

        await harness.fakeDocument.emit('keydown', event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(input.value).toBe('正在输入');
    });

    it.each([
        {isComposing: true}, {keyCode: 229}, {ctrlKey: true},
        {altKey: true}, {metaKey: true}, {shiftKey: true},
    ])('三连空格不吞掉 IME 选词或修饰键，并中断旧计数 %j', async extra => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_space'}});
        const input = fakeElement('textarea');
        input.value = '正在输入';
        harness.fakeDocument.activeElement = input;
        const space = () => trustedKey({key: ' ', code: 'Space'});
        await harness.fakeDocument.emit('keydown', space());
        await harness.fakeDocument.emit('keydown', space());
        const interrupted = trustedKey({key: ' ', code: 'Space', ...extra});
        await harness.fakeDocument.emit('keydown', interrupted);
        await harness.fakeDocument.emit('keydown', space());

        expect(interrupted.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(input.value).toBe('正在输入');
    });

    it.each(['success', 'error'])('切换输入目标后完整释放上个目标的 %s 动画类', async phase => {
        vi.useFakeTimers();
        const harness = mountHarness({
            config: {animations: true},
            sendMessage: async () => ({success: true, translatedText: phase === 'success' ? '翻译完成' : 'Hello'}),
        });
        const first = fakeElement('input');
        first.value = 'Hello';
        first.classList.add('host-owned');
        harness.fakeDocument.activeElement = first;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(first.classList.values.has(`fluent-input-${phase}`)).toBe(true);

        const second = fakeElement('input');
        second.value = 'Second';
        harness.fakeDocument.activeElement = second;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        harness.feature.invalidate();
        vi.runAllTimers();

        expect(first.classList.values).toEqual(new Set(['host-owned']));
        expect(second.classList.values).toEqual(new Set());
    });

    it('请求完成后卸载 feature 仍清理宿主上的完成动画和 tooltip', async () => {
        vi.useFakeTimers();
        const harness = mountHarness({config: {animations: true}});
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        harness.controller.abort();
        vi.runAllTimers();

        expect(input.classList.values).toEqual(new Set());
        expect(harness.tooltipRecords.at(-1).ui.remove).toHaveBeenCalledOnce();
    });

    it('生成配置 key 并判断 feature 是否可用', () => {
        expect(inputBoxTranslationConfigKey({
            on: true,
            inputBoxTranslationTrigger: 'ctrl_enter',
            inputBoxTranslationTarget: 'en',
        })).toBe(JSON.stringify([true, 'ctrl_enter', 'en', 'replace', 1000, 'freeTranslation', '', '', '']));
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'ctrl_enter'}, false)).toBe(true);
        expect(isInputBoxTranslationEnabled({on: false, inputBoxTranslationTrigger: 'ctrl_enter'}, false)).toBe(false);
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'disabled'}, false)).toBe(false);
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'ctrl_enter'}, true)).toBe(false);
    });

    it('配置 key 只跟踪选中服务的模型、连接和凭据指纹', () => {
        const base: any = {
            on: true,
            inputBoxTranslationTrigger: 'ctrl_enter',
            inputBoxTranslationTarget: 'en',
            inputBoxTranslationService: 'deeplx',
            model: {deeplx: 'model-a'},
            customModel: {deeplx: 'custom-a'},
            serviceRegion: {deeplx: 'cn', openai: 'global'},
            modelThinking: {deeplx: {'model-a': true}},
            requireApiKey: {
                'deeplx:model-a': true,
                'v2:["deeplx","model-a"]': true,
            },
            proxy: {deeplx: 'https://proxy-a'},
            token: {deeplx: 'token-a'},
            customHeaders: {deeplx: '{"x":"a"}'},
            customBody: {deeplx: '{"temperature":0}'},
            deeplx: 'https://deeplx-a',
        };
        const first = inputBoxTranslationConfigKey(base);
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, serviceRegion: {deeplx: 'sgp', openai: 'global'}}));
        expect(first).toBe(inputBoxTranslationConfigKey({...base, serviceRegion: {deeplx: 'cn', openai: 'cn'}}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, token: {deeplx: 'token-b'}}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, apiKeys: {deeplx: ['token-a', 'token-b']}}));
        expect(first).toBe(inputBoxTranslationConfigKey({...base, apiKeys: {openai: ['other-key']}}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, apiKeyRotationEnabled: {deeplx: true}}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, secret: {deeplx: 'secret'}}));
        expect(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'freeTranslation'})).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'freeTranslation', freeTranslationMode: 'race'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'newapi', newApiUrl: 'https://new-api'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'azureOpenai', azureOpenaiEndpoint: 'https://azure'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'youdao', youdaoAppKey: 'app', youdaoAppSecret: 'secret'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'tencent', tencentSecretId: 'id', tencentSecretKey: 'secret'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'deepL', deeplApiPlan: 'pro'}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: 'freeTranslation', freeTranslationOrder: ['youdao']}));
        expect(first).not.toBe(inputBoxTranslationConfigKey({...base, customOpenAIProviders: [{id: 'deeplx', endpoint: 'https://custom'}]}));
        expect(inputBoxTranslationConfigKey({...base, customOpenAIProviders: 'invalid'})).toContain('deeplx');
    });

    it('覆盖选中 provider 的直接连接分支', () => {
        const base: any = {
            on: true,
            inputBoxTranslationTrigger: 'ctrl_enter',
            inputBoxTranslationTarget: 'en',
            inputBoxTranslationService: 'microsoft',
        };
        for (const [service, extra] of [
            ['custom', {custom: 'https://custom'}],
            ['newapi', {newApiUrl: 'https://newapi'}],
            ['azureOpenai', {azureOpenaiEndpoint: 'https://azure'}],
            ['deeplx', {deeplx: 'https://deeplx'}],
            ['myMemory', {myMemoryEmail: 'user@example.com'}],
            ['youdao', {youdaoAppKey: 'app', youdaoAppSecret: 'secret'}],
            ['tencent', {tencentSecretId: 'id', tencentSecretKey: 'secret'}],
            ['huanYuan', {tencentSecretId: 'id', tencentSecretKey: 'secret'}],
            ['huanYuanTranslation', {tencentSecretId: 'id', tencentSecretKey: 'secret'}],
            ['deepL', {deeplApiPlan: 'pro'}],
            ['freeTranslation', {freeTranslationOrder: ['youdao']}],
            ['minimax', {minimaxBillingPlan: 'token-plan', minimaxRegion: 'global'}],
            ['mimo', {mimoBillingPlan: 'token-plan', mimoRegion: 'sgp'}],
            ['deepseek', {deepseekApiType: 'responses'}],
        ] as const) {
            expect(inputBoxTranslationConfigKey({...base, inputBoxTranslationService: service, ...extra})).not.toBe(
                inputBoxTranslationConfigKey(base),
            );
        }
    });

    it('原生控件同步写回，编辑宿主交给原生编辑路径且不直接改写子结构', async () => {
        const input = fakeElement('input');
        await expect(setInputBoxText(input, 'translated')).resolves.toBe(true);
        expect(input.value).toBe('translated');
        expect(input.dispatchEvent).toHaveBeenCalledTimes(2);

        let nativeSetterCalls = 0;
        const controlled = fakeElement('input');
        delete controlled.value;
        controlled._value = 'old';
        Object.setPrototypeOf(controlled, {
            get value() { return controlled._value; },
            set value(value: string) { nativeSetterCalls += 1; controlled._value = value; },
        });
        await setInputBoxText(controlled, 'native-set');
        expect(nativeSetterCalls).toBe(1);
        expect(controlled.value).toBe('native-set');

        const password = fakeElement('input');
        password.type = 'password';
        password.value = 'Secret42';
        await expect(setInputBoxText(password, '不应覆盖')).resolves.toBe(false);
        expect(password.value).toBe('Secret42');
        expect(password.dispatchEvent).not.toHaveBeenCalled();

        const inlineWidget = {id: 'mention'};
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = '保留富文本草稿';
        rich.children.push(inlineWidget);
        editable.replaceEditableText.mockImplementationOnce(async (_element: unknown, _text: string, isCurrent: () => boolean) => (
            isCurrent() ? 'replaced' : 'stale'
        ));
        await expect(setInputBoxText(rich, '译文')).resolves.toBe(true);
        expect(editable.replaceEditableText).toHaveBeenLastCalledWith(rich, '译文', expect.any(Function), 'all', '', undefined);
        expect(rich.innerText).toBe('保留富文本草稿');
        expect(rich.children).toEqual([inlineWidget]);
        expect(rich.dispatchEvent).not.toHaveBeenCalled();

        const plaintext = fakeElement('div', {contenteditable: 'plaintext-only'});
        editable.replaceEditableText.mockResolvedValueOnce('unsupported');
        await expect(setInputBoxText(plaintext, '正文')).resolves.toBe(false);

        const plain = fakeElement('div');
        await expect(setInputBoxText(plain, 'skip')).resolves.toBe(false);
        expect(plain.innerText).toBe('');
        expect(editable.replaceEditableText).toHaveBeenCalledTimes(2);
    });

    it.each(['append', 'prepend'] as const)('双语输出 %s 保留原文的首尾空白和段落，恢复后可以再次翻译', async mode => {
        const harness = mountHarness({config: {inputBoxTranslationOutputMode: mode}});
        const input = fakeElement('textarea');
        const original = '  中文原文。\n第二段。  ';
        input.value = original;
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(harness.sendMessage).toHaveBeenCalledWith({type: 'inputBoxTranslation', text: original, targetLang: 'zh', clientRequestId: expect.any(String)});
        expect(input.value).toBe(mode === 'append' ? `${original}\n你好` : `你好\n${original}`);
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        expect(input.value).toBe(mode === 'append' ? `${original}\n你好` : `你好\n${original}`);
        const button = harness.tooltipRecords.at(-1).ui.mounted.children.at(-1);
        await button.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await Promise.resolve();
        expect(input.value).toBe(original);
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(input.value).toBe(mode === 'append' ? `${original}\n你好` : `你好\n${original}`);
    });

    it('双语追加的富文本只向末尾插入译文，单行控件保留原文且不请求翻译', async () => {
        const harness = mountHarness({config: {inputBoxTranslationOutputMode: 'append'}});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = '原文';
        harness.fakeDocument.activeElement = rich;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(editable.replaceEditableText).toHaveBeenCalledWith(rich, '\n你好', expect.any(Function), 'end', '', expect.any(AbortSignal));
        await expect(setInputBoxText(rich, '译文', () => true, 'prepend')).resolves.toBe(true);
        expect(editable.replaceEditableText).toHaveBeenLastCalledWith(rich, '译文\n', expect.any(Function), 'start', '', undefined);
        await expect(setInputBoxText(fakeElement('textarea'), '译文', () => true, 'prepend')).resolves.toBe(true);
        const input = fakeElement('input');
        input.value = '单行原文';
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(input.value).toBe('单行原文');
        expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        expect(harness.tooltipRecords.at(-1).ui.mounted.textContent).toContain('双语追加需要支持换行');
        await expect(setInputBoxText(input, '译文', () => true, 'append')).resolves.toBe(false);
        await expect(setInputBoxText(fakeElement('textarea'), '译文', () => true, 'append')).resolves.toBe(true);
    });

    it('双语追加在用户继续编辑或切换输出方式后不写入迟到译文', async () => {
        let resolve!: (value: unknown) => void;
        let generation = 0;
        const harness = mountHarness({config: {inputBoxTranslationOutputMode: 'append'},
            generation: () => generation,
            sendMessage: () => new Promise(done => { resolve = done; })});
        const input = fakeElement('textarea');
        input.value = '原文';
        harness.fakeDocument.activeElement = input;
        const pending = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        const originalKey = inputBoxTranslationConfigKey(harness.config);
        harness.config.inputBoxTranslationOutputMode = 'replace';
        expect(inputBoxTranslationConfigKey(harness.config)).not.toBe(originalKey);
        generation += 1;
        input.value = '后来编辑的内容';
        resolve({success: true, translatedText: 'late'});
        await pending;
        expect(input.value).toBe('后来编辑的内容');
    });

    it('成功提示的恢复按钮只接受可信点击，并可恢复未编辑的原文', async () => {
        const harness = mountHarness();
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        const tooltip = harness.tooltipRecords.at(-1).ui.mounted;
        const restoreButton = tooltip.children.at(-1);
        const restore = restoreButton.listeners.get('click')[0];
        restore({isTrusted: false, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        expect(input.value).toBe('你好');
        restore({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        expect(input.value).toBe('Hello');

        let siteDisabled = false;
        const blocked = mountHarness({isSiteDisabled: () => siteDisabled});
        const blockedInput = fakeElement('input');
        blockedInput.value = 'Hello';
        blocked.fakeDocument.activeElement = blockedInput;
        await blocked.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const blockedButton = blocked.tooltipRecords.at(-1).ui.mounted.children.at(-1);
        siteDisabled = true;
        blockedButton.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        expect(blockedInput.value).toBe('你好');
    });

    it('Ctrl+Enter 触发 background 翻译，使用 closed Shadow DOM tooltip 并写回当前快照', async () => {
        const {fakeDocument, sendMessage, tooltipRecords} = mountHarness();
        const input = fakeElement('textarea');
        input.value = 'Hello';
        fakeDocument.activeElement = input;
        const event = trustedKey({key: 'Enter', ctrlKey: true});

        await fakeDocument.emit('keydown', event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith({
            type: 'inputBoxTranslation',
            clientRequestId: expect.any(String),
            text: 'Hello',
            targetLang: 'zh',
        });
        expect(input.value).toBe('你好');
        expect(tooltipRecords.map(record => record.options.mode)).toEqual(['closed', 'closed']);
        expect(tooltipRecords.at(-1).ui.shadowHost.setAttribute).toHaveBeenCalledWith('data-fluent-read-ui', 'input-tooltip');
    });

    it.each([
        ['password', (element: any) => { element.type = 'password'; }],
        ['readonly', (element: any) => { element.readOnly = true; }],
    ])('请求启动后变为 %s 时，即使提示仍在创建也不写回', async (_label, mutate) => {
        let releaseTooltip!: () => void;
        const tooltipBarrier = new Promise<void>((resolve) => { releaseTooltip = resolve; });
        const records: any[] = [];
        const baseFactory = createUiFactory(records);
        const createUi = vi.fn(async (context: unknown, options: unknown) => {
            await tooltipBarrier;
            return baseFactory(context, options);
        });
        const {fakeDocument, sendMessage} = mountHarness({createUi});
        const input = fakeElement('input');
        input.value = 'Secret42';
        fakeDocument.activeElement = input;

        const pending = fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await Promise.resolve();
        mutate(input);
        releaseTooltip();
        await pending;

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'inputBoxTranslation'}));
        expect(input.value).toBe('Secret42');
    });

    it('provider 返回前控件变成密码框时拒绝写回迟到译文', async () => {
        let resolveTranslation!: (value: unknown) => void;
        const {fakeDocument, sendMessage} = mountHarness({
            sendMessage: () => new Promise(resolve => { resolveTranslation = resolve; }),
        });
        const input = fakeElement('input');
        input.value = 'Public draft';
        fakeDocument.activeElement = input;

        const pending = fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        input.type = 'password';
        resolveTranslation({success: true, translatedText: '不应覆盖'});
        await pending;

        expect(input.value).toBe('Public draft');
    });

    it.each([
        ['ctrl_enter', [{key: 'Enter', code: 'Enter', ctrlKey: true}], 'Secret42'],
        ['triple_space', Array.from({length: 3}, () => ({key: ' ', code: 'Space'})), 'Secret42   '],
        ['triple_equal', Array.from({length: 3}, () => ({key: '=', code: 'Equal'})), 'Secret42==='],
        ['triple_dash', Array.from({length: 3}, () => ({key: '-', code: 'Minus'})), 'Secret42---'],
    ] as const)('开放 Shadow DOM 密码框不会被 %s 触发或发送', async (trigger, eventInputs, value) => {
        const {fakeDocument, sendMessage} = mountHarness({
            config: {inputBoxTranslationTrigger: trigger},
        });
        const password = fakeElement('input');
        password.type = 'password';
        password.value = value;
        const host = fakeElement('div');
        host.shadowRoot = {activeElement: password};
        fakeDocument.activeElement = host;
        const events = eventInputs.map((event) => trustedKey(event));

        for (const event of events) await fakeDocument.emit('keydown', event);

        expect(sendMessage).not.toHaveBeenCalled();
        expect(password.value).toBe(value);
        expect(events.every((event) => event.preventDefault.mock.calls.length === 0)).toBe(true);
    });

    it('三连击只在同一输入目标连续命中时触发，并只清理本次插入的触发符号', async () => {
        const {config, fakeDocument, sendMessage} = mountHarness({
            config: {inputBoxTranslationTrigger: 'triple_equal'},
        });
        const first = fakeElement('input');
        first.value = 'Hello';
        first.selectionStart = first.selectionEnd = first.value.length;
        const second = fakeElement('input');
        second.value = 'Other===';
        second.selectionStart = second.selectionEnd = second.value.length;

        fakeDocument.activeElement = first;
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        fakeDocument.activeElement = second;
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        second.value = 'Other====';
        second.selectionStart = second.selectionEnd = second.value.length;
        await fakeDocument.emit('input', {target: second});
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        second.value = 'Other=====';
        second.selectionStart = second.selectionEnd = second.value.length;
        await fakeDocument.emit('input', {target: second});
        const third = trustedKey({key: '=', code: 'Equal'});
        await fakeDocument.emit('keydown', third);

        expect(config.inputBoxTranslationTrigger).toBe('triple_equal');
        expect(third.preventDefault).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'Other==='}));
    });

    it('编辑宿主无法读取折叠光标时保留宿主输入，并处理 Shadow retarget 事件', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        const plain = fakeElement('div', {contenteditable: 'plaintext-only'});
        harness.fakeDocument.activeElement = plain;
        const key = () => trustedKey({key: '=', code: 'Equal'});
        await harness.fakeDocument.emit('keydown', key());
        await harness.fakeDocument.emit('keydown', key());
        const third = key();
        await harness.fakeDocument.emit('keydown', third);
        expect(third.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();

        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;
        const host = fakeElement('div');
        await harness.fakeDocument.emit('input', {
            target: host,
            composedPath: () => [input, host],
        });
        await harness.fakeDocument.emit('compositionstart', {});
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it.each(['replaced', 'unsupported', 'cancelled'] as const)('双语三连通过编辑器清理触发符，清理结果 %s 决定是否发送请求', async result => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationOutputMode: 'append'}});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = '原文=';
        let caret = {text: rich.innerText, caret: 3};
        editable.readEditableCaretState.mockImplementation(() => caret);
        harness.fakeDocument.activeElement = rich;
        for (let i = 0; i < 2; i += 1) {
            await harness.fakeDocument.emit('keydown', trustedKey({key: '='}));
            rich.innerText += '=';
            caret = {text: rich.innerText, caret: rich.innerText.length};
            await harness.fakeDocument.emit('input', {target: rich});
        }
        editable.replaceEditableText.mockImplementationOnce(async (_element, text, isCurrent, mode, symbol) => {
            expect(mode).toBe('trigger'); expect(symbol).toBe('='); expect(text).toBe('');
            expect(isCurrent()).toBe(true);
            rich.innerText = '用户后来编辑';
            expect(isCurrent()).toBe(false);
            rich.innerText = result === 'replaced' ? '原文=' : '原文===';
            if (result === 'cancelled') {
                await harness.fakeDocument.emit('keydown', trustedKey({key: 'Escape'}));
                expect(isCurrent()).toBe(false);
                return 'stale';
            }
            return result;
        });
        await harness.fakeDocument.emit('keydown', trustedKey({key: '='}));
        if (result === 'replaced') {
            expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({text: '原文='}));
            expect(editable.replaceEditableText).toHaveBeenLastCalledWith(rich, '\n你好', expect.any(Function), 'end', '', expect.any(AbortSignal));
        } else expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('多行控件的双语三连只清理本次符号并换行追加译文', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationOutputMode: 'append'}});
        const input = fakeElement('textarea');
        input.value = '原文=';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;
        for (let i = 0; i < 2; i += 1) {
            await harness.fakeDocument.emit('keydown', trustedKey({key: '='}));
            input.value += '=';
            input.selectionStart = input.selectionEnd = input.value.length;
            await harness.fakeDocument.emit('input', {target: input});
        }
        await harness.fakeDocument.emit('keydown', trustedKey({key: '='}));
        expect(input.value).toBe('原文=\n你好');
    });

    it('富文本编辑器三连触发冻结首次插入前的可见原文，并阻止第三键传给页面', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_space', uiLanguage: 'zh-CN'}});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello\u00A0world\n';
        let caret = {text: 'Hello world', caret: 11};
        editable.readEditableCaretState.mockImplementation(() => caret);
        harness.fakeDocument.activeElement = rich;
        const space = () => trustedKey({key: ' ', code: 'Space'});

        const first = space();
        await harness.fakeDocument.emit('keydown', first);
        rich.innerText = 'Hello world \n';
        caret = {text: 'Hello world ', caret: 12};
        await harness.fakeDocument.emit('input', {target: rich});
        await harness.fakeDocument.emit('selectionchange', {});
        await harness.fakeDocument.emit('keydown', space());
        rich.innerText = 'Hello world  \n';
        caret = {text: 'Hello world  ', caret: 13};
        await harness.fakeDocument.emit('input', {target: rich});
        const third = space();
        await harness.fakeDocument.emit('keydown', third);

        expect(first.preventDefault).not.toHaveBeenCalled();
        expect(third.preventDefault).toHaveBeenCalledOnce();
        expect(third.stopPropagation).toHaveBeenCalledOnce();
        expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'Hello world\n'}));
        expect(editable.replaceEditableText).toHaveBeenCalledWith(rich, '你好', expect.any(Function), 'all', '', expect.any(AbortSignal));
        const writeGuard = editable.replaceEditableText.mock.calls.at(-1)![2] as () => boolean;
        expect(writeGuard()).toBe(true);

        const tooltip = harness.tooltipRecords.at(-1).ui.mounted;
        expect(tooltip.textContent).toContain('翻译成功');
        const restore = tooltip.children.at(-1).listeners.get('click')[0];
        restore({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await vi.waitFor(() => expect(editable.replaceEditableText).toHaveBeenCalledTimes(3));
        expect(editable.replaceEditableText).toHaveBeenLastCalledWith(rich, 'Hello world\n', expect.any(Function), 'all', '', expect.any(AbortSignal));
        await vi.waitFor(() => expect(harness.tooltipRecords.at(-1).ui.remove).toHaveBeenCalled());
    });

    it('编辑宿主三连期间出现其他编辑、光标移动或切换目标时重新计数', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_dash'}});
        const rich = fakeElement('div', {contenteditable: 'true'});
        const other = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Draft';
        other.innerText = 'Other';
        let caret: {text: string; caret: number} | null = {text: 'Draft', caret: 5};
        editable.readEditableCaretState.mockImplementation(() => caret);
        harness.fakeDocument.activeElement = rich;
        const dash = () => trustedKey({key: '-', code: 'Minus'});

        // 第一次插入后用户把光标移回开头：selectionchange 立即作废序列。
        await harness.fakeDocument.emit('keydown', dash());
        caret = {text: 'Draft-', caret: 0};
        await harness.fakeDocument.emit('selectionchange', {});
        await harness.fakeDocument.emit('keydown', dash());
        // 非触发符号的编辑通过 input 事件作废序列。
        caret = {text: '-Draftx-', caret: 8};
        await harness.fakeDocument.emit('input', {target: rich});
        await harness.fakeDocument.emit('keydown', dash());
        // 切换到另一个编辑宿主后从头计数。
        caret = {text: '-Draftx--', caret: 9};
        harness.fakeDocument.activeElement = other;
        await harness.fakeDocument.emit('keydown', dash());
        // 宿主没有按默认行为插入触发符号时不能继续累计。
        await harness.fakeDocument.emit('keydown', dash());
        caret = null;
        const unreadable = dash();
        await harness.fakeDocument.emit('keydown', unreadable);
        // 从原生控件序列切到编辑宿主时同样重新计数。
        const input = fakeElement('input');
        input.value = 'Input';
        input.selectionStart = input.selectionEnd = 5;
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', dash());
        caret = {text: 'Other', caret: 5};
        harness.fakeDocument.activeElement = other;
        await harness.fakeDocument.emit('keydown', dash());
        caret = {text: 'Other-', caret: 6};
        harness.config.inputBoxTranslationTrigger = 'triple_equal';
        await harness.fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));

        expect(unreadable.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('编辑宿主写回失败时提示无法写入，请求已失效时只清理视觉状态', async () => {
        vi.useFakeTimers();
        const unsupported = mountHarness({config: {animations: true, uiLanguage: 'zh-CN'}});
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        unsupported.fakeDocument.activeElement = rich;
        editable.replaceEditableText.mockResolvedValueOnce('unsupported');
        await unsupported.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const errorTooltip = unsupported.tooltipRecords.at(-1);
        expect(errorTooltip.ui.mounted.children.at(-1).value).toBe('你好');
        expect(errorTooltip.ui.mounted.children.at(-1).readOnly).toBe(true);
        expect(errorTooltip.options.css).toContain('pointer-events: auto');
        expect(errorTooltip.ui.mounted.textContent).toContain('无法把译文写入当前编辑器');
        expect(rich.classList.values.has('fluent-input-error')).toBe(true);
        await vi.runAllTimersAsync();
        expect(errorTooltip.ui.remove).not.toHaveBeenCalled();
        const close = errorTooltip.ui.mounted.children.at(-2);
        close.listeners.get('click')[0]({isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn()});
        await vi.runAllTimersAsync();
        expect(errorTooltip.ui.remove).toHaveBeenCalled();
        expect(rich.classList.values.has('fluent-input-error')).toBe(false);

        const stale = mountHarness();
        const staleRich = fakeElement('div', {contenteditable: 'true'});
        staleRich.innerText = 'Hello';
        stale.fakeDocument.activeElement = staleRich;
        editable.replaceEditableText.mockImplementationOnce(async () => {
            stale.controller.abort();
            return 'stale';
        });
        await stale.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(stale.tooltipRecords).toHaveLength(1);
        expect(staleRich.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('恢复原文写回未完成时保留成功提示', async () => {
        const harness = mountHarness();
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.innerText = 'Hello';
        harness.fakeDocument.activeElement = rich;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const record = harness.tooltipRecords.at(-1);
        editable.replaceEditableText.mockResolvedValueOnce('stale');

        record.ui.mounted.children.at(-1).listeners.get('click')[0]({
            isTrusted: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });
        await vi.waitFor(() => expect(editable.replaceEditableText).toHaveBeenCalledTimes(2));
        await Promise.resolve();

        expect(record.ui.remove).not.toHaveBeenCalled();
    });

    it('Ctrl+Enter 与取消用的 Escape 被消费后不再传给页面快捷键', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        const harness = mountHarness({sendMessage: () => new Promise(resolve => { resolveMessage = resolve; })});
        const input = fakeElement('textarea');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const enter = trustedKey({key: 'Enter', ctrlKey: true});
        const running = harness.fakeDocument.emit('keydown', enter);
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        const escape = trustedKey({key: 'Escape'});
        await harness.fakeDocument.emit('keydown', escape);
        resolveMessage({success: true, translatedText: '你好'});
        await running;

        expect(enter.stopPropagation).toHaveBeenCalledOnce();
        expect(escape.stopPropagation).toHaveBeenCalledOnce();
        expect(input.value).toBe('Hello');
    });

    it('三连击期间选区改变会重置序列', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        input.selectionStart = input.selectionEnd = 0;
        await harness.fakeDocument.emit('selectionchange', {});
        input.value = 'Hello=';
        input.selectionStart = input.selectionEnd = input.value.length;
        await harness.fakeDocument.emit('input', {target: input});
        const next = trustedKey({key: '=', code: 'Equal'});
        await harness.fakeDocument.emit('keydown', next);
        expect(next.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('无活动输入目标的编辑事件和空触发序列会安全忽略', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        harness.fakeDocument.activeElement = fakeElement('div');
        await harness.fakeDocument.emit('selectionchange', {});
        await harness.fakeDocument.emit('input', {target: fakeElement('div')});
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('选区值与光标都稳定时 selectionchange 保留当前三连序列', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        input.value = 'Hello=';
        input.selectionStart = input.selectionEnd = input.value.length;
        await harness.fakeDocument.emit('selectionchange', {});
        const next = trustedKey({key: '=', code: 'Equal'});
        await harness.fakeDocument.emit('keydown', next);
        expect(next.preventDefault).not.toHaveBeenCalled();
    });

    it('选区值稳定但光标移动时也会重置三连序列', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        input.value = 'Hello=';
        input.selectionStart = input.selectionEnd = 0;
        await harness.fakeDocument.emit('input', {target: input});
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('原生输入控件无法提供选区时不接管触发键', async () => {
        const harness = mountHarness({config: {inputBoxTranslationTrigger: 'triple_equal'}});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = null;
        input.selectionEnd = null;
        harness.fakeDocument.activeElement = input;
        const event = trustedKey({key: '=', code: 'Equal'});
        await harness.fakeDocument.emit('keydown', event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('tooltip 创建时把位置限制在视口内，并在底部空间不足时移到上方', async () => {
        const harness = mountHarness();
        (harness.fakeDocument as any).defaultView = {innerWidth: 100, innerHeight: 100};
        const input = fakeElement('input');
        input.value = 'Hello';
        input.getBoundingClientRect = vi.fn(() => ({left: -100, width: 20, top: 90, bottom: 100}));
        harness.fakeDocument.activeElement = input;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        const tooltip = harness.tooltipRecords[0].ui.mounted;
        expect(tooltip.style.left).toBe('12px');
        expect(tooltip.style.top).toBe('34px');

        const noTop = fakeElement('input');
        noTop.value = 'World';
        noTop.getBoundingClientRect = vi.fn(() => ({left: 50, width: 20, bottom: 100}));
        harness.fakeDocument.activeElement = noTop;
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(harness.tooltipRecords.at(-1).ui.mounted.style.top).toBe('12px');
    });

    it('未知但未禁用的输入触发配置不会执行任何翻译动作', async () => {
        const {fakeDocument, sendMessage} = mountHarness({
            config: {inputBoxTranslationTrigger: 'manual-only'},
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        fakeDocument.activeElement = input;

        await fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(sendMessage).not.toHaveBeenCalled();
        expect(input.value).toBe('Hello');
    });

    it('空输入或清理触发符号后为空时不会请求 background', async () => {
        const empty = mountHarness();
        const emptyInput = fakeElement('input');
        emptyInput.value = '   ';
        empty.fakeDocument.activeElement = emptyInput;
        await empty.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(empty.sendMessage).not.toHaveBeenCalled();

        const trulyEmpty = mountHarness();
        const trulyEmptyInput = fakeElement('input');
        trulyEmptyInput.value = '';
        trulyEmpty.fakeDocument.activeElement = trulyEmptyInput;
        await trulyEmpty.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(trulyEmpty.sendMessage).not.toHaveBeenCalled();

        const symbolsOnly = mountHarness({config: {inputBoxTranslationTrigger: 'triple_dash'}});
        const symbolInput = fakeElement('input');
        symbolInput.value = '---';
        symbolsOnly.fakeDocument.activeElement = symbolInput;
        await symbolsOnly.fakeDocument.emit('keydown', trustedKey({key: '-', code: 'Minus'}));
        await symbolsOnly.fakeDocument.emit('keydown', trustedKey({key: '-', code: 'Minus'}));
        await symbolsOnly.fakeDocument.emit('keydown', trustedKey({key: '-', code: 'Minus'}));
        expect(symbolsOnly.sendMessage).not.toHaveBeenCalled();
    });

    it('禁用、站点禁用、非可信事件、非输入目标和重复三连击不会请求翻译', async () => {
        const disabled = mountHarness({config: {inputBoxTranslationTrigger: 'disabled'}});
        disabled.fakeDocument.activeElement = fakeElement('input');
        await disabled.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(disabled.sendMessage).not.toHaveBeenCalled();

        const siteDisabled = mountHarness({isSiteDisabled: () => true});
        siteDisabled.fakeDocument.activeElement = fakeElement('input');
        await siteDisabled.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(siteDisabled.sendMessage).not.toHaveBeenCalled();

        const inactive = mountHarness();
        inactive.fakeDocument.activeElement = fakeElement('div');
        await inactive.fakeDocument.emit('keydown', {...trustedKey({key: 'Enter', ctrlKey: true}), isTrusted: false});
        await inactive.fakeDocument.emit('keydown', trustedKey({key: 'Escape'}));
        await inactive.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(inactive.sendMessage).not.toHaveBeenCalled();

        const repeated = mountHarness({config: {inputBoxTranslationTrigger: 'triple_space'}});
        repeated.fakeDocument.activeElement = fakeElement('input');
        await repeated.fakeDocument.emit('keydown', trustedKey({key: ' ', code: 'Space', repeat: true}));
        expect(repeated.sendMessage).not.toHaveBeenCalled();
    });

    it('用户编辑、配置 generation 变化或 abort 后，异步结果不能覆盖输入框', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        let generation = 0;
        const pending = new Promise(resolve => { resolveMessage = resolve; });
        const {fakeDocument, controller} = mountHarness({
            generation: () => generation,
            sendMessage: () => pending,
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        fakeDocument.activeElement = input;

        const running = fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        input.value = 'Hello edited';
        generation = 1;
        controller.abort();
        resolveMessage({success: true, translatedText: '你好'});
        await running;

        expect(input.value).toBe('Hello edited');
        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('用户编辑后改回原文，旧请求仍不能覆盖当前输入', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        const pending = new Promise(resolve => { resolveMessage = resolve; });
        const harness = mountHarness({sendMessage: () => pending});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;

        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        input.value = 'Changed';
        await harness.fakeDocument.emit('input', {target: input});
        input.value = 'Hello';
        await harness.fakeDocument.emit('input', {target: input});
        resolveMessage({success: true, translatedText: '你好'});
        await running;

        expect(input.value).toBe('Hello');
    });

    it('Escape 会取消进行中的请求并保留用户输入', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        const pending = new Promise(resolve => { resolveMessage = resolve; });
        const harness = mountHarness({sendMessage: () => pending});
        const input = fakeElement('input');
        input.value = 'Hello';
        input.selectionStart = input.selectionEnd = input.value.length;
        harness.fakeDocument.activeElement = input;

        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        const escape = trustedKey({key: 'Escape'});
        await harness.fakeDocument.emit('keydown', escape);
        resolveMessage({success: true, translatedText: '你好'});
        await running;

        expect(escape.preventDefault).toHaveBeenCalledOnce();
        expect(input.value).toBe('Hello');
    });

    it('翻译期间仅因失焦产生的同值 change 不会取消请求', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        const pending = new Promise(resolve => { resolveMessage = resolve; });
        const harness = mountHarness({sendMessage: () => pending});
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        await harness.fakeDocument.emit('change', {target: input});
        resolveMessage({success: true, translatedText: '你好'});
        await running;

        expect(input.value).toBe('你好');
    });

    it('compositionstart 会取消进行中的请求，即使组合事件尚未改写文本', async () => {
        let resolveMessage: (value: unknown) => void = () => undefined;
        const pending = new Promise(resolve => { resolveMessage = resolve; });
        const harness = mountHarness({sendMessage: () => pending});
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
        await harness.fakeDocument.emit('compositionstart', {target: input});
        resolveMessage({success: true, translatedText: '你好'});
        await running;
        expect(input.value).toBe('Hello');
    });

    it('翻译成功返回前输入已变化时，成功结果不会写回', async () => {
        const harness = mountHarness({
            sendMessage: async () => {
                (harness.fakeDocument.activeElement as any).value = 'Changed';
                return {success: true, translatedText: '你好'};
            },
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(input.value).toBe('Changed');
        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('翻译成功返回前站点被禁用时，成功结果不会写回', async () => {
        let disabled = false;
        const harness = mountHarness({
            isSiteDisabled: () => disabled,
            sendMessage: async () => {
                disabled = true;
                return {success: true, translatedText: '你好'};
            },
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(input.value).toBe('Hello');
        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('旧请求返回时不能清理新请求拥有的视觉状态', async () => {
        let resolveFirst: (value: unknown) => void = () => undefined;
        const first = new Promise(resolve => { resolveFirst = resolve; });
        const sendMessage = vi.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce({success: true, translatedText: '第二次'});
        const harness = mountHarness({
            sendMessage,
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        const firstRun = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        while (sendMessage.mock.calls.length === 0) await Promise.resolve();
        input.value = 'Changed draft';
        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        resolveFirst({success: true, translatedText: '第一次'});
        await firstRun;

        expect(input.value).toBe('第二次');
    });

    it('tooltip 创建后若 signal 已失效，则移除临时 UI 并拒绝继续请求', async () => {
        let resolveUi: (value: any) => void = () => undefined;
        const tooltipRecords: any[] = [];
        const createUi = vi.fn((_ctx: unknown, options: any) => new Promise(resolve => {
            const ui = {
                shadowHost: fakeElement('div'),
                mounted: null,
                remove: vi.fn(),
                mount: vi.fn(),
            };
            tooltipRecords.push({options, ui});
            resolveUi = () => resolve(ui);
        }));
        const harness = mountHarness({createUi});
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        const running = harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        harness.controller.abort();
        resolveUi(undefined);
        await running;

        expect(tooltipRecords[0].ui.remove).toHaveBeenCalledOnce();
        expect(harness.sendMessage.mock.calls.some(([message]) => message.type === 'inputBoxTranslation')).toBe(false);
    });

    it('翻译返回相同文本或失败时不写回，并显示错误提示', async () => {
        const sameText = mountHarness({
            sendMessage: async () => ({success: true, translatedText: 'Hello'}),
        });
        const sameInput = fakeElement('input');
        sameInput.value = 'Hello';
        sameText.fakeDocument.activeElement = sameInput;
        await sameText.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(sameInput.value).toBe('Hello');

        const failed = mountHarness({
            sendMessage: async () => ({success: false, error: 'bad gateway'}),
        });
        const failedInput = fakeElement('input');
        failedInput.value = 'Hello';
        failed.fakeDocument.activeElement = failedInput;
        await failed.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(failedInput.value).toBe('Hello');
        expect(failed.logger.error).toHaveBeenCalledWith('输入框翻译失败:', expect.any(Error));

        const defaultFailure = mountHarness({
            sendMessage: async () => undefined,
        });
        const defaultFailedInput = fakeElement('input');
        defaultFailedInput.value = 'Hello';
        defaultFailure.fakeDocument.activeElement = defaultFailedInput;
        await defaultFailure.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(defaultFailure.logger.error).toHaveBeenCalledWith('输入框翻译失败:', expect.any(Error));

        const emptySuccess = mountHarness({
            sendMessage: async () => ({success: true}),
        });
        const emptySuccessInput = fakeElement('input');
        emptySuccessInput.value = 'Hello';
        emptySuccess.fakeDocument.activeElement = emptySuccessInput;
        await emptySuccess.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(emptySuccessInput.value).toBe('Hello');
    });

    it('翻译失败返回时若输入已经改变，只清理自己拥有的视觉状态', async () => {
        const harness = mountHarness({
            sendMessage: async () => {
                (harness.fakeDocument.activeElement as any).value = 'Changed';
                throw new Error('network failed');
            },
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(input.value).toBe('Changed');
        expect(harness.logger.error).not.toHaveBeenCalledWith('微软翻译失败:', expect.any(Error));
        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('tooltip 创建异常不影响译文提交', async () => {
        const logger = {error: vi.fn()};
        const fallbackRecords: any[] = [];
        const fallbackCreateUi = createUiFactory(fallbackRecords);
        const harness = mountHarness({
            createUi: vi.fn()
                .mockRejectedValueOnce(new Error('shadow failed'))
                .mockImplementation(fallbackCreateUi),
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;
        harness.logger.error = logger.error;

        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(logger.error).toHaveBeenCalledWith('输入框翻译提示创建失败:', expect.any(Error));
        expect(input.value).toBe('你好');
    });

    it('外层异常发生后若请求已经失效，只清理视觉状态不显示降级提示', async () => {
        const harness = mountHarness({
            createUi: vi.fn(async () => {
                harness.controller.abort();
                throw new Error('shadow failed');
            }),
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        harness.fakeDocument.activeElement = input;

        await harness.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));

        expect(harness.logger.error).not.toHaveBeenCalledWith('输入框翻译失败:', expect.any(Error));
        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
    });

    it('invalidate 只清理当前请求拥有的样式和 tooltip', async () => {
        vi.useFakeTimers();
        const {fakeDocument, feature, tooltipRecords} = mountHarness({config: {animations: true}});
        const input = fakeElement('input');
        input.value = 'Hello';
        fakeDocument.activeElement = input;

        await fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        feature.invalidate();
        vi.advanceTimersByTime(1000);

        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-translating');
        expect(tooltipRecords.length).toBeGreaterThan(0);
    });

    it('动画开启时成功状态会在所有权仍有效时自动清理', async () => {
        vi.useFakeTimers();
        const {fakeDocument} = mountHarness({config: {animations: true}});
        const input = fakeElement('input');
        input.value = 'Hello';
        fakeDocument.activeElement = input;

        await fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        vi.advanceTimersByTime(1000);

        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-success');
    });

    it('动画开启时错误状态会在所有权仍有效时自动清理', async () => {
        vi.useFakeTimers();
        const {fakeDocument} = mountHarness({
            config: {animations: true},
            sendMessage: async () => ({success: true, translatedText: 'Hello'}),
        });
        const input = fakeElement('input');
        input.value = 'Hello';
        fakeDocument.activeElement = input;

        await fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        vi.advanceTimersByTime(600);

        expect(input.classList.remove).toHaveBeenCalledWith('fluent-input-error');
    });
});
