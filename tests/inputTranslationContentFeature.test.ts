import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    createInputTranslationContentFeature,
    inputBoxTranslationConfigKey,
    isInputBoxTranslationEnabled,
    setInputBoxText,
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
        innerText: '',
        textContent: '',
        type: 'text',
        isContentEditable: false,
        style: {},
        children: [] as any[],
        classList: fakeClassList(),
        dispatchEvent: vi.fn(),
        appendChild: vi.fn((child: any) => element.children.push(child)),
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
    const sendMessage = vi.fn(overrides.sendMessage || (async () => ({
        success: true,
        translatedText: '你好',
    })));
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

afterEach(() => {
    vi.useRealTimers();
});

describe('input translation content feature', () => {
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
        })).toBe(JSON.stringify([true, 'ctrl_enter', 'en']));
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'ctrl_enter'}, false)).toBe(true);
        expect(isInputBoxTranslationEnabled({on: false, inputBoxTranslationTrigger: 'ctrl_enter'}, false)).toBe(false);
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'disabled'}, false)).toBe(false);
        expect(isInputBoxTranslationEnabled({on: true, inputBoxTranslationTrigger: 'ctrl_enter'}, true)).toBe(false);
    });

    it('只写回 input、textarea 和 plaintext-only，不破坏富文本子结构', () => {
        const input = fakeElement('input');
        setInputBoxText(input, 'translated');
        expect(input.value).toBe('translated');
        expect(input.dispatchEvent).toHaveBeenCalledTimes(2);

        const password = fakeElement('input');
        password.type = 'password';
        password.value = 'Secret42';
        setInputBoxText(password, '不应覆盖');
        expect(password.value).toBe('Secret42');
        expect(password.dispatchEvent).not.toHaveBeenCalled();

        const plaintext = fakeElement('div', {contenteditable: 'plaintext-only'});
        plaintext.isContentEditable = true;
        setInputBoxText(plaintext, '正文');
        expect(plaintext.innerText).toBe('正文');
        expect(plaintext.dispatchEvent).toHaveBeenCalledTimes(1);

        const inlineWidget = {id: 'mention'};
        const rich = fakeElement('div', {contenteditable: 'true'});
        rich.isContentEditable = true;
        rich.innerText = '保留富文本草稿';
        rich.children.push(inlineWidget);
        setInputBoxText(rich, '不应覆盖');
        expect(rich.innerText).toBe('保留富文本草稿');
        expect(rich.children).toEqual([inlineWidget]);
        expect(rich.dispatchEvent).not.toHaveBeenCalled();

        const plain = fakeElement('div');
        setInputBoxText(plain, 'skip');
        expect(plain.innerText).toBe('');
        expect(plain.dispatchEvent).not.toHaveBeenCalled();
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
            text: 'Hello',
            targetLang: 'zh',
        });
        expect(input.value).toBe('你好');
        expect(tooltipRecords.map(record => record.options.mode)).toEqual(['closed', 'closed']);
        expect(tooltipRecords.at(-1).ui.shadowHost.setAttribute).toHaveBeenCalledWith('data-fluent-read-ui', 'input-tooltip');
    });

    it.each([
        ['password', (element: any) => { element.type = 'password'; }],
        ['rich contenteditable', (element: any) => {
            element.tagName = 'DIV';
            element.getAttribute = vi.fn((name: string) => name === 'contenteditable' ? 'true' : null);
            element.isContentEditable = true;
        }],
    ])('发送前重新校验控件资格，异步期间变为 %s 时不发送或写回', async (_label, mutate) => {
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

        expect(sendMessage).not.toHaveBeenCalled();
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

    it('三连击只在同一输入目标连续命中时触发，并清理触发符号', async () => {
        const {config, fakeDocument, sendMessage} = mountHarness({
            config: {inputBoxTranslationTrigger: 'triple_equal'},
        });
        const first = fakeElement('input');
        first.value = 'Hello===';
        const second = fakeElement('input');
        second.value = 'Other===';

        fakeDocument.activeElement = first;
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        fakeDocument.activeElement = second;
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        await fakeDocument.emit('keydown', trustedKey({key: '=', code: 'Equal'}));
        const third = trustedKey({key: '=', code: 'Equal'});
        await fakeDocument.emit('keydown', third);

        expect(config.inputBoxTranslationTrigger).toBe('triple_equal');
        expect(third.preventDefault).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'Other'}));
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
        expect(harness.sendMessage).not.toHaveBeenCalled();
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
        expect(failed.logger.error).toHaveBeenCalledWith('微软翻译失败:', expect.any(Error));

        const defaultFailure = mountHarness({
            sendMessage: async () => undefined,
        });
        const defaultFailedInput = fakeElement('input');
        defaultFailedInput.value = 'Hello';
        defaultFailure.fakeDocument.activeElement = defaultFailedInput;
        await defaultFailure.fakeDocument.emit('keydown', trustedKey({key: 'Enter', ctrlKey: true}));
        expect(defaultFailure.logger.error).toHaveBeenCalledWith('微软翻译失败:', expect.any(Error));

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

    it('tooltip 创建异常走外层降级提示路径', async () => {
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

        expect(logger.error).toHaveBeenCalledWith('输入框翻译失败:', expect.any(Error));
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
