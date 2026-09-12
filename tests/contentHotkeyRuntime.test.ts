import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {
        harness: {enabled: false, trigger: 'click', customHotkey: 'Alt+R'},
        on: true,
        floatingBallHotkey: 'Alt+T',
        customFloatingBallHotkey: '',
        selectionTranslatorTrigger: 'direct',
        selectionTranslatorMode: 'bilingual',
        disableSelectionTranslator: false,
        customSelectionTranslatorHotkey: '',
        to: 'zh',
    },
    autoTranslateEnglishPage: vi.fn(),
    isFullPageTranslationActive: vi.fn(),
    restoreOriginalContent: vi.fn(),
    toggleFloatingBallTranslation: vi.fn(),
    matchesConfiguredHotkey: vi.fn(() => false),
    shouldClaimConfiguredHotkey: vi.fn((
        _event: KeyboardEvent,
        _configured: string,
        _custom: string,
        hasCandidate?: () => boolean,
    ) => hasCandidate?.() ?? false),
    getSelection: vi.fn<() => Selection | null>(() => null),
}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/core/hotkey', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/src/core/hotkey')>(),
    matchesConfiguredHotkey: mocks.matchesConfiguredHotkey,
    shouldClaimConfiguredHotkey: mocks.shouldClaimConfiguredHotkey,
}));
vi.mock('@/src/app/content/features', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    isFullPageTranslationActive: mocks.isFullPageTranslationActive,
    isSameLanguage: vi.fn(() => false),
    readSelectionText: vi.fn((_range: Range, value: string) => value),
    restoreOriginalContent: mocks.restoreOriginalContent,
    shouldIgnoreSelection: vi.fn(() => false),
    toggleFloatingBallTranslation: mocks.toggleFloatingBallTranslation,
}));

type Listener = (event: Record<string, unknown>) => void;

function createDocumentStub() {
    const listeners = new Map<string, Listener[]>();
    return {
        document: {
            addEventListener: vi.fn((type: string, listener: Listener) => {
                const current = listeners.get(type) ?? [];
                current.push(listener);
                listeners.set(type, current);
            }),
            getElementById: vi.fn(() => null),
        },
        listeners,
    };
}

function keyboardEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        isTrusted: true,
        repeat: false,
        key: 't',
        code: 'KeyT',
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.assign(mocks.config, {
        harness: {enabled: false, trigger: 'click', customHotkey: 'Alt+R'},
        on: true,
        floatingBallHotkey: 'Alt+T',
        customFloatingBallHotkey: '',
        selectionTranslatorTrigger: 'direct',
        selectionTranslatorMode: 'bilingual',
        disableSelectionTranslator: false,
        customSelectionTranslatorHotkey: '',
        to: 'zh',
    });
    mocks.isFullPageTranslationActive.mockReturnValue(false);
    mocks.toggleFloatingBallTranslation.mockReturnValue(true);
    mocks.getSelection.mockReturnValue(null);

    const {document, listeners} = createDocumentStub();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {
        getSelection: mocks.getSelection,
        addEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {platform: 'MacIntel'});
    vi.stubGlobal('process', {env: {NODE_ENV: 'test'}});
    Object.defineProperty(document, '__listeners', {value: listeners});
});

function visibleSelection(text: string): Selection {
    const rect = {width: 160, height: 24};
    const range = {
        getClientRects: () => [rect],
        getBoundingClientRect: () => rect,
    };
    return {
        rangeCount: 1,
        isCollapsed: false,
        toString: () => text,
        getRangeAt: () => range,
    } as unknown as Selection;
}

describe('全文翻译快捷键状态联动', () => {
    it('划词关闭、全局关闭或站点禁用时不向 quick 暴露残留划词快捷键和候选', async () => {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const getSelection = vi.fn(() => { throw new Error('disabled path must not inspect selection'); });
        vi.stubGlobal('window', {getSelection, addEventListener: vi.fn()});
        mocks.config.selectionTranslatorTrigger = 'Control';

        mocks.config.selectionTranslatorMode = 'disabled';
        let runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.selectionTranslatorMode = 'bilingual';
        mocks.config.disableSelectionTranslator = true;
        expect(runtime.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.disableSelectionTranslator = false;
        mocks.config.on = false;
        expect(runtime.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.on = true;
        runtime = createContentHotkeyRuntime(() => true);
        expect(runtime.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(getSelection).not.toHaveBeenCalled();
    });

    it('受支持邮件 frame 把全文动作交给顶层且不预留未挂载的划词手势', async () => {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const toggleFullPage = vi.fn();
        const runtime = createContentHotkeyRuntime(() => false, {toggleFullPage, selectionAvailable: false});
        expect(runtime.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);
        runtime.installFloatingBallHotkey(new AbortController().signal);
        const listeners = (document as typeof document & {__listeners: Map<string, Listener[]>}).__listeners;
        listeners.get('keydown')![0](keyboardEvent({key: 'Alt', code: 'AltLeft'}));
        listeners.get('keydown')![0](keyboardEvent());
        expect(toggleFullPage).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    });

    it('悬浮球存在时仍以全文会话真值切换，而不是驱动悬浮球局部状态', async () => {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        runtime.installFloatingBallHotkey(new AbortController().signal);

        const listeners = (document as typeof document & {__listeners: Map<string, Listener[]>}).__listeners;
        const keydown = listeners.get('keydown')?.[0];
        const keyup = listeners.get('keyup')?.[0];
        expect(keydown).toBeTypeOf('function');
        expect(keyup).toBeTypeOf('function');

        keydown!(keyboardEvent({key: 'Alt', code: 'AltLeft'}));
        keydown!(keyboardEvent());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.toggleFloatingBallTranslation).not.toHaveBeenCalled();

        keyup!(keyboardEvent({key: 't', code: 'KeyT', altKey: false}));
        keyup!(keyboardEvent({key: 'Alt', code: 'AltLeft', altKey: false}));
        mocks.isFullPageTranslationActive.mockReturnValue(true);

        keydown!(keyboardEvent({key: 'Alt', code: 'AltLeft'}));
        keydown!(keyboardEvent());
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.toggleFloatingBallTranslation).not.toHaveBeenCalled();
    });
});

describe('划词翻译快捷键语言预检', () => {
    it.each([
        'Hallo Welt.',
        'Bonjour le monde.',
    ])('短拉丁文本 %s 不会被猜成英语，仍保留划词快捷键', async (text) => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.config.to = 'en';
        mocks.getSelection.mockReturnValue(visibleSelection(text));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        const event = keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false});

        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(true);
        expect(runtime.shouldReserveSelectionShortcut(event as unknown as KeyboardEvent)).toBe(true);
    });

    it('明确日文与日语目标相同时不占用划词快捷键', async () => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.config.to = 'ja';
        mocks.getSelection.mockReturnValue(visibleSelection('今日は良い天気です。'));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        const event = keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false});

        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(runtime.shouldReserveSelectionShortcut(event as unknown as KeyboardEvent)).toBe(false);
    });
});

 describe('翻译卡片快捷键优先级', () => {
    it('在普通划词关闭时为 AI 阅读保留外语选区，禁用站点和不可用文档不占用', async () => {
        mocks.config.selectionTranslatorMode = 'disabled';
        mocks.config.harness = {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'};
        mocks.matchesConfiguredHotkey.mockReturnValue(true);
        mocks.getSelection.mockReturnValue(visibleSelection('Today’s learning plan is complete.'));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const event = keyboardEvent({key: 'r', code: 'KeyR'}) as unknown as KeyboardEvent;
        const runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.shouldReserveSelectionShortcut(event)).toBe(true);
        expect(runtime.matchesSelectionTranslatorShortcut(event)).toBe(true);
        expect(createContentHotkeyRuntime(() => true).shouldReserveSelectionShortcut(event)).toBe(false);
        expect(createContentHotkeyRuntime(() => false, {selectionAvailable: false}).shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.getSelection.mockReturnValue(null);
        expect(runtime.shouldReserveSelectionShortcut(event)).toBe(false);
    });
});

describe('纯中文选区不占用划词或翻译卡片快捷键', () => {
    it.each(['你好', '你好，世界！123 🎉', '繁體中文'])('跳过 %s，但切换外语目标后恢复', async text => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.getSelection.mockReturnValue(visibleSelection(text));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        const event = keyboardEvent() as unknown as KeyboardEvent;
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(runtime.shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.config.harness = {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'};
        mocks.matchesConfiguredHotkey.mockReturnValue(true);
        expect(runtime.shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.config.to = 'en';
        expect(runtime.hasActiveSelectionTranslationCandidate()).toBe(true);
        expect(runtime.shouldReserveSelectionShortcut(event)).toBe(true);
    });
});
