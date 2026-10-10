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
        selectionTranslatorBidirectional: false,
        from: 'auto',
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
vi.mock('@/src/features/full-page-translation/public', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    isFullPageTranslationActive: mocks.isFullPageTranslationActive,
    restoreOriginalContent: mocks.restoreOriginalContent,
}));
vi.mock('@/src/features/selection-translation/core', async importOriginal => ({
    ...await importOriginal<typeof import('@/src/features/selection-translation/core')>(),
    readSelectionText: vi.fn((_range: Range, value: string) => value),
    shouldIgnoreSelection: vi.fn(() => false),
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
        selectionTranslatorBidirectional: false,
        from: 'auto',
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
    it('仅右键触发不占用划词快捷键', async () => {
        mocks.config.selectionTranslatorTrigger = 'contextMenu';
        mocks.config.customSelectionTranslatorHotkey = 'Ctrl+Shift+Y';
        mocks.getSelection.mockReturnValue(visibleSelection('Selected English text'));
        mocks.shouldClaimConfiguredHotkey.mockImplementationOnce((
            _event: KeyboardEvent,
            configured: string,
        ) => configured !== 'none');
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const ports = createContentHotkeyRuntime(() => false).selectionShortcutPorts;
        expect(ports.getConfiguredSelectionHotkey()).toBe('none');
        expect(ports.shouldReserveSelectionShortcut(keyboardEvent() as unknown as KeyboardEvent)).toBe(false);
        expect(mocks.shouldClaimConfiguredHotkey).toHaveBeenCalledWith(expect.anything(), 'none', 'Ctrl+Shift+Y', expect.any(Function));
    });

    it('划词关闭、全局关闭或站点禁用时不向 quick 暴露残留划词快捷键和候选', async () => {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const getSelection = vi.fn(() => { throw new Error('disabled path must not inspect selection'); });
        vi.stubGlobal('window', {getSelection, addEventListener: vi.fn()});
        mocks.config.selectionTranslatorTrigger = 'Control';

        mocks.config.selectionTranslatorMode = 'disabled';
        let runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.selectionShortcutPorts.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.selectionTranslatorMode = 'bilingual';
        mocks.config.disableSelectionTranslator = true;
        expect(runtime.selectionShortcutPorts.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.disableSelectionTranslator = false;
        mocks.config.on = false;
        expect(runtime.selectionShortcutPorts.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);

        mocks.config.on = true;
        runtime = createContentHotkeyRuntime(() => true);
        expect(runtime.selectionShortcutPorts.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(getSelection).not.toHaveBeenCalled();
    });

    it('受支持邮件 frame 把全文动作交给顶层且不预留未挂载的划词手势', async () => {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const toggleFullPage = vi.fn();
        const runtime = createContentHotkeyRuntime(() => false, {toggleFullPage, selectionAvailable: false});
        expect(runtime.selectionShortcutPorts.getConfiguredSelectionHotkey()).toBe('none');
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);
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

describe('全文快捷键与录制器使用同一逻辑按键', () => {
    async function installFullPageHotkey() {
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const toggleFullPage = vi.fn();
        createContentHotkeyRuntime(() => false, {toggleFullPage}).installFloatingBallHotkey(new AbortController().signal);
        const listeners = (document as typeof document & {__listeners: Map<string, Listener[]>}).__listeners;
        // 同一用例可安装多个独立运行时，只驱动最近一次安装的监听器。
        return {toggleFullPage, keydown: listeners.get('keydown')!.at(-1)!, keyup: listeners.get('keyup')!.at(-1)!};
    }

    it('Shift 数字按录制的数字匹配，先松开 Shift 时仍按物理键清除按键状态', async () => {
        Object.assign(mocks.config, {floatingBallHotkey: 'custom', customFloatingBallHotkey: 'Alt+Shift+1'});
        const {toggleFullPage, keydown, keyup} = await installFullPageHotkey();
        keydown(keyboardEvent({key: 'Alt', code: 'AltLeft'}));
        keydown(keyboardEvent({key: 'Shift', code: 'ShiftLeft', shiftKey: true}));
        keydown(keyboardEvent({key: '!', code: 'Digit1', shiftKey: true}));
        expect(toggleFullPage).toHaveBeenCalledOnce();

        keyup(keyboardEvent({key: 'Shift', code: 'ShiftLeft', shiftKey: false}));
        keyup(keyboardEvent({key: '1', code: 'Digit1', shiftKey: false}));
        keydown(keyboardEvent({key: 'Shift', code: 'ShiftLeft', shiftKey: true}));
        keydown(keyboardEvent({key: '!', code: 'Digit1', shiftKey: true}));
        expect(toggleFullPage).toHaveBeenCalledTimes(2);
    });

    it('macOS Option 字形回退到物理键，非 QWERTY 布局按实际字符而非物理位置匹配', async () => {
        Object.assign(mocks.config, {floatingBallHotkey: 'custom', customFloatingBallHotkey: 'Alt+/'});
        const optionGlyph = await installFullPageHotkey();
        optionGlyph.keydown(keyboardEvent({key: '÷', code: 'Slash'}));
        expect(optionGlyph.toggleFullPage).toHaveBeenCalledOnce();

        Object.assign(mocks.config, {floatingBallHotkey: 'Alt+T', customFloatingBallHotkey: ''});
        const dvorak = await installFullPageHotkey();
        // Dvorak 的 T 位于 QWERTY K 键；原物理 T 键输出 y，不能误触发。
        dvorak.keydown(keyboardEvent({key: 'y', code: 'KeyT'}));
        dvorak.keyup(keyboardEvent({key: 'y', code: 'KeyT'}));
        expect(dvorak.toggleFullPage).not.toHaveBeenCalled();
        dvorak.keydown(keyboardEvent({key: 't', code: 'KeyK'}));
        expect(dvorak.toggleFullPage).toHaveBeenCalledOnce();
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

        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(true);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event as unknown as KeyboardEvent)).toBe(true);
    });

    it.each([
        ['Добро пожаловать на наш сайт.', 'ru', 'en'],
        ['Bonjour et bienvenue sur notre site.', 'fr', 'en'],
        ['Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.', 'de', 'en'],
        ['GPT-6 Sol 모델의 새로운 기능을 소개합니다.', 'ko', 'ja'],
        ['云端模型清单允许清空，且不再连带拒掉无关偏好的保存 (84522b3)', 'zh-Hans', 'zh-Hant'],
    ])('多语言同目标选区 %s 不占用快捷键，切换到 %s 以外的目标后立即恢复', async (text, target, other) => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.config.to = target;
        mocks.getSelection.mockReturnValue(visibleSelection(text));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);
        mocks.config.to = other;
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(true);
    });

    it('夹带外语句子、歧义短词和纯共享汉字的选区保留划词快捷键', async () => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        for (const [text, target] of [
            ['GPT-6 Sol の新しいモデルを発表しました。This English sentence needs translation.', 'ja'],
            ['Settings', 'en'],
            ['日本国立大学', 'ja'],
        ] as const) {
            mocks.config.to = target;
            mocks.getSelection.mockReturnValue(visibleSelection(text));
            expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate(), text).toBe(true);
        }
    });

    it('明确日文与日语目标相同时不占用划词快捷键', async () => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.config.to = 'ja';
        mocks.getSelection.mockReturnValue(visibleSelection('今日は良い天気です。'));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        const event = keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false});

        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event as unknown as KeyboardEvent)).toBe(false);
    });
});

 describe('统一划词快捷键优先级', () => {
    it('总开关关闭后旧学习开关不占用按键，重新启用统一入口后恢复', async () => {
        mocks.config.selectionTranslatorMode = 'disabled';
        mocks.config.harness = {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'};
        mocks.matchesConfiguredHotkey.mockReturnValue(true);
        mocks.getSelection.mockReturnValue(visibleSelection('Today’s learning plan is complete.'));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const event = keyboardEvent({key: 'r', code: 'KeyR'}) as unknown as KeyboardEvent;
        const runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(false);
        expect(runtime.selectionShortcutPorts.matchesSelectionTranslatorShortcut(event)).toBe(false);
        mocks.config.selectionTranslatorMode = 'bilingual';
        mocks.config.selectionTranslatorTrigger = 'custom';
        mocks.config.customSelectionTranslatorHotkey = 'Alt+R';
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(true);
        expect(runtime.selectionShortcutPorts.matchesSelectionTranslatorShortcut(event)).toBe(true);
        expect(createContentHotkeyRuntime(() => true).selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(false);
        expect(createContentHotkeyRuntime(() => false, {selectionAvailable: false}).selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.getSelection.mockReturnValue(null);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(keyboardEvent({key: 'r', code: 'KeyR'}) as unknown as KeyboardEvent)).toBe(false);
    });
});

describe('纯中文选区不占用划词或翻译卡片快捷键', () => {
    it.each(['你好', '你好，世界！123 🎉', '繁體中文'])('跳过 %s，但切换外语目标后恢复', async text => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.getSelection.mockReturnValue(visibleSelection(text));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        const event = keyboardEvent() as unknown as KeyboardEvent;
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(false);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.config.harness = {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'};
        mocks.matchesConfiguredHotkey.mockReturnValue(true);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(event)).toBe(false);
        mocks.config.to = 'en';
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(true);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(keyboardEvent() as unknown as KeyboardEvent)).toBe(true);
    });

    it('中英双向入口统一按划词快捷键判定，不受旧学习快捷键改变', async () => {
        mocks.config.selectionTranslatorTrigger = 'Control';
        mocks.config.selectionTranslatorBidirectional = true;
        mocks.getSelection.mockReturnValue(visibleSelection('你好，世界！'));
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(() => false);
        expect(runtime.selectionShortcutPorts.hasActiveSelectionTranslationCandidate()).toBe(true);
        mocks.config.harness = {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'};
        mocks.matchesConfiguredHotkey.mockReturnValue(true);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(keyboardEvent() as unknown as KeyboardEvent)).toBe(true);
    });
});

import {afterEach} from 'vitest';

describe('受支持的 F9 全文快捷键使用真实 core 仲裁', () => {
    // 只在本组用例内绑定真实匹配函数，不改变既有测试依赖的 hoisted mock 行为。
    let restoreCoreMocks: (() => void) | undefined;

    beforeEach(async () => {
        const previousMatches = mocks.matchesConfiguredHotkey.getMockImplementation();
        const previousClaim = mocks.shouldClaimConfiguredHotkey.getMockImplementation();
        const hoverDescriptors = ['hotkey', 'customHotkey', 'mouseHoverTranslationDelay'].map(key => ({
            key,
            descriptor: Object.getOwnPropertyDescriptor(mocks.config, key),
        }));
        restoreCoreMocks = () => {
            mocks.matchesConfiguredHotkey.mockReset();
            mocks.shouldClaimConfiguredHotkey.mockReset();
            if (previousMatches) mocks.matchesConfiguredHotkey.mockImplementation(previousMatches);
            if (previousClaim) mocks.shouldClaimConfiguredHotkey.mockImplementation(previousClaim);
            for (const {key, descriptor} of hoverDescriptors) {
                if (descriptor) Object.defineProperty(mocks.config, key, descriptor);
                else Reflect.deleteProperty(mocks.config, key);
            }
        };

        const core = await vi.importActual<typeof import('@/src/core/hotkey')>('@/src/core/hotkey');
        // 原 mock 的参数推断较窄；仅调整类型视图，运行时仍是同一个 spy。
        vi.mocked(mocks.matchesConfiguredHotkey as unknown as typeof core.matchesConfiguredHotkey)
            .mockReset().mockImplementation(core.matchesConfiguredHotkey);
        vi.mocked(mocks.shouldClaimConfiguredHotkey as unknown as typeof core.shouldClaimConfiguredHotkey)
            .mockReset().mockImplementation(core.shouldClaimConfiguredHotkey);
        Object.assign(mocks.config, {
            floatingBallHotkey: 'custom',
            customFloatingBallHotkey: 'F9',
            selectionTranslatorTrigger: 'custom',
            customSelectionTranslatorHotkey: 'F9',
            hotkey: 'none',
            customHotkey: '',
            mouseHoverTranslationDelay: 0,
        });
    });

    afterEach(() => {
        restoreCoreMocks?.();
        restoreCoreMocks = undefined;
    });

    class HotkeyTestTarget {
        private readonly listeners = new Map<string, Array<{listener: Listener; signal?: AbortSignal}>>();

        addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void {
            const listeners = this.listeners.get(type) ?? [];
            listeners.push({listener, signal: options?.signal});
            this.listeners.set(type, listeners);
        }

        emit(type: string, event: Record<string, unknown> = {}): void {
            for (const {listener, signal} of this.listeners.get(type) ?? []) {
                if (!signal?.aborted) listener(event);
            }
        }

        lastListener(type: string): Listener {
            const listener = this.listeners.get(type)?.at(-1)?.listener;
            if (!listener) throw new Error(`未安装 ${type} 监听器`);
            return listener;
        }
    }

    function f9Event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return keyboardEvent({key: 'F9', code: 'F9', altKey: false, ...overrides});
    }

    async function installRuntime(isSiteDisabled: () => boolean = () => false) {
        const documentTarget = Object.assign(new HotkeyTestTarget(), {getElementById: vi.fn(() => null)});
        const windowTarget = Object.assign(new HotkeyTestTarget(), {
            getSelection: mocks.getSelection,
            location: {href: 'https://fixture.test/article'},
        });
        vi.stubGlobal('document', documentTarget);
        vi.stubGlobal('window', windowTarget);
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(isSiteDisabled);
        const controller = new AbortController();
        runtime.installFloatingBallHotkey(controller.signal);
        return {runtime, controller, documentTarget, windowTarget};
    }

    it.each(['F9', 'custom'])('%s 全文配置与划词 F9 共用且 hover none 时仅在 keyup 翻译或恢复', async configured => {
        Object.assign(mocks.config, {
            floatingBallHotkey: configured,
            customFloatingBallHotkey: configured === 'custom' ? 'F9' : '',
        });
        const {runtime, documentTarget} = await installRuntime();
        const down = f9Event();
        expect(runtime.selectionShortcutPorts.matchesSelectionTranslatorShortcut(down as unknown as KeyboardEvent)).toBe(true);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(down as unknown as KeyboardEvent)).toBe(false);

        documentTarget.emit('keydown', down);
        documentTarget.emit('keydown', f9Event({repeat: true}));
        expect(down.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
        expect(mocks.matchesConfiguredHotkey).toHaveBeenCalledWith(down, 'none', '');

        const up = f9Event();
        documentTarget.emit('keyup', up);
        expect(up.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();

        mocks.isFullPageTranslationActive.mockReturnValue(true);
        documentTarget.emit('keydown', f9Event());
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.toggleFloatingBallTranslation).not.toHaveBeenCalled();
    });

    it('真实 core 拒绝不匹配的划词 F10，全文 F9 在 keydown 直接执行且不检查选区', async () => {
        mocks.config.customSelectionTranslatorHotkey = 'F10';
        mocks.getSelection.mockReturnValue(visibleSelection('Selected English text'));
        const {runtime, documentTarget} = await installRuntime();
        const down = f9Event();
        expect(runtime.selectionShortcutPorts.matchesSelectionTranslatorShortcut(down as unknown as KeyboardEvent)).toBe(false);
        expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(down as unknown as KeyboardEvent)).toBe(false);
        documentTarget.emit('keydown', down);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.getSelection).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    });

    it.each(['keydown', 'keyup'])('有效选区在 %s 出现时优先于共用 F9 的全文动作，清除后新手势仍能触发', async phase => {
        const {runtime, documentTarget} = await installRuntime();
        const down = f9Event();
        if (phase === 'keydown') {
            mocks.getSelection.mockReturnValue(visibleSelection('Selected English text'));
            expect(runtime.selectionShortcutPorts.shouldReserveSelectionShortcut(down as unknown as KeyboardEvent)).toBe(true);
        }
        documentTarget.emit('keydown', down);
        if (phase === 'keyup') {
            expect(down.preventDefault).toHaveBeenCalledOnce();
            mocks.getSelection.mockReturnValue(visibleSelection('Selected English text'));
        } else {
            expect(down.preventDefault).not.toHaveBeenCalled();
        }
        const up = f9Event();
        documentTarget.emit('keyup', up);
        expect(up.preventDefault).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        mocks.getSelection.mockReturnValue(null);
        // 迟到的释放事件不能复活已经被选区取消的 pending。
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keydown', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it('全文、划词与 hover 共用 custom F9 时真实 hover 控制器只执行一次，全文不抢占', async () => {
        Object.assign(mocks.config, {hotkey: 'custom', customHotkey: 'F9'});
        const {runtime, controller, documentTarget, windowTarget} = await installRuntime();
        const {mountHoverTranslationContentFeature} = await import('@/src/features/hover-translation/content');
        const handleTranslation = vi.fn();
        mountHoverTranslationContentFeature({
            config: mocks.config,
            constants: {
                TwoFinger: 'twoFinger', ThreeFinger: 'threeFinger', FourFinger: 'fourFinger',
                DoubleClick: 'doubleClick', LongPress: 'longPress', MiddleClick: 'middleClick',
                DoubleClickScreen: 'doubleClickScreen', TripleClickScreen: 'tripleClickScreen',
            },
            document: documentTarget as unknown as Document,
            window: windowTarget as unknown as Window,
            navigator,
            isSiteDisabled: () => false,
            getCenterPoint: () => null,
            handleTranslation,
            cancelPendingHoverTranslation: vi.fn(),
            noteBilingualHostGesture: vi.fn(),
            ...runtime.selectionShortcutPorts,
        }, controller.signal);
        documentTarget.emit('mousemove', {isTrusted: true, clientX: 0, clientY: 0});

        const down = f9Event();
        // 分别驱动 window/document 的实际监听器；即使收到事件，全文自己的仲裁也必须成立。
        windowTarget.emit('keydown', down);
        documentTarget.emit('keydown', down);
        expect(handleTranslation).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.matchesConfiguredHotkey).toHaveBeenCalledWith(down, 'custom', 'F9');
        const up = f9Event();
        windowTarget.emit('keyup', up);
        documentTarget.emit('keyup', up);
        expect(handleTranslation).toHaveBeenCalledOnce();
        expect(handleTranslation).toHaveBeenCalledWith(0, 0);
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        mocks.getSelection.mockReturnValue(visibleSelection('Selected English text'));
        const selectedDown = f9Event();
        windowTarget.emit('keydown', selectedDown);
        documentTarget.emit('keydown', selectedDown);
        const selectedUp = f9Event();
        windowTarget.emit('keyup', selectedUp);
        documentTarget.emit('keyup', selectedUp);
        expect(handleTranslation).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
    });

    it.each(['modifier', 'nonmodifier'])('F9 按下前已有额外 %s 按键时不消费或排队，完整释放后恢复', async extra => {
        const {documentTarget} = await installRuntime();
        const prefix = extra === 'modifier'
            ? {key: 'Control', code: 'ControlLeft', ctrlKey: true}
            : {key: 'c', code: 'KeyC'};
        documentTarget.emit('keydown', keyboardEvent({altKey: false, ...prefix}));
        const down = f9Event({ctrlKey: extra === 'modifier'});
        documentTarget.emit('keydown', down);
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(down.stopPropagation).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event({ctrlKey: extra === 'modifier'}));
        documentTarget.emit('keyup', keyboardEvent({altKey: false, ...prefix, ctrlKey: false}));
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        documentTarget.emit('keydown', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each(['blur', 'abort'])('%s 清除共用 F9 的 pending，迟到 keyup 不执行全文动作', async reason => {
        const {runtime, controller, documentTarget, windowTarget} = await installRuntime();
        const down = f9Event();
        documentTarget.emit('keydown', down);
        expect(down.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        const capturedKeyup = documentTarget.lastListener('keyup');
        if (reason === 'blur') windowTarget.emit('blur');
        else controller.abort();

        // 故意直接调用已捕获的 listener，独立证明 abort reset，而非仅靠 signal 跳过派发。
        capturedKeyup(f9Event());
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        if (reason === 'abort') runtime.installFloatingBallHotkey(new AbortController().signal);
        documentTarget.emit('keydown', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each(['Control', 'Alt', 'Shift'])('非法全文配置 %s 在直写或 custom 模式均拒绝，修正为 F9 后恢复', async modifier => {
        const core = await vi.importActual<typeof import('@/src/core/hotkey')>('@/src/core/hotkey');
        expect(core.parseHotkey(modifier).isValid).toBe(false);
        const {documentTarget} = await installRuntime();
        for (const configured of [modifier, 'custom']) {
            mocks.config.floatingBallHotkey = configured;
            mocks.config.customFloatingBallHotkey = configured === 'custom' ? modifier : '';
            const down = keyboardEvent({
                key: modifier,
                code: `${modifier}Left`,
                ctrlKey: modifier === 'Control',
                altKey: modifier === 'Alt',
                shiftKey: modifier === 'Shift',
            });
            documentTarget.emit('keydown', down);
            expect(down.preventDefault).not.toHaveBeenCalled();
            expect(down.stopPropagation).not.toHaveBeenCalled();
            documentTarget.emit('keyup', keyboardEvent({
                key: modifier, code: `${modifier}Left`, ctrlKey: false, altKey: false, shiftKey: false,
            }));
        }
        expect(mocks.getSelection).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        Object.assign(mocks.config, {floatingBallHotkey: 'F9', customFloatingBallHotkey: ''});
        documentTarget.emit('keydown', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each(['config.on', 'siteDisabled'])('%s 禁用时不消费 F9、不读取选区或执行全文，重新启用后恢复', async disabledBy => {
        let siteDisabled = disabledBy === 'siteDisabled';
        mocks.config.on = disabledBy !== 'config.on';
        const {documentTarget} = await installRuntime(() => siteDisabled);
        const down = f9Event();
        const up = f9Event();
        documentTarget.emit('keydown', down);
        documentTarget.emit('keyup', up);
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(down.stopPropagation).not.toHaveBeenCalled();
        expect(up.preventDefault).not.toHaveBeenCalled();
        expect(mocks.getSelection).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();

        siteDisabled = false;
        mocks.config.on = true;
        documentTarget.emit('keydown', f9Event());
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        documentTarget.emit('keyup', f9Event());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });
});

describe('全文 pending 手势绑定主键、配置身份与页面生命周期', () => {
    let restoreCoreMocks: (() => void) | undefined;

    beforeEach(async () => {
        const previousMatches = mocks.matchesConfiguredHotkey.getMockImplementation();
        const previousClaim = mocks.shouldClaimConfiguredHotkey.getMockImplementation();
        const hoverDescriptors = ['hotkey', 'customHotkey'].map(key => ({
            key, descriptor: Object.getOwnPropertyDescriptor(mocks.config, key),
        }));
        restoreCoreMocks = () => {
            mocks.matchesConfiguredHotkey.mockReset();
            mocks.shouldClaimConfiguredHotkey.mockReset();
            if (previousMatches) mocks.matchesConfiguredHotkey.mockImplementation(previousMatches);
            if (previousClaim) mocks.shouldClaimConfiguredHotkey.mockImplementation(previousClaim);
            for (const {key, descriptor} of hoverDescriptors) {
                if (descriptor) Object.defineProperty(mocks.config, key, descriptor);
                else Reflect.deleteProperty(mocks.config, key);
            }
        };
        const core = await vi.importActual<typeof import('@/src/core/hotkey')>('@/src/core/hotkey');
        vi.mocked(mocks.matchesConfiguredHotkey as unknown as typeof core.matchesConfiguredHotkey)
            .mockReset().mockImplementation(core.matchesConfiguredHotkey);
        vi.mocked(mocks.shouldClaimConfiguredHotkey as unknown as typeof core.shouldClaimConfiguredHotkey)
            .mockReset().mockImplementation(core.shouldClaimConfiguredHotkey);
        Object.assign(mocks.config, {
            floatingBallHotkey: 'F9', customFloatingBallHotkey: '',
            selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: 'F9',
            hotkey: 'none', customHotkey: '',
        });
    });

    afterEach(() => {
        restoreCoreMocks?.();
        restoreCoreMocks = undefined;
    });

    class PendingGestureTarget {
        readonly registrations = new Map<string, Array<{listener: Listener; signal?: AbortSignal}>>();

        addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void {
            const registrations = this.registrations.get(type) ?? [];
            registrations.push({listener, signal: options?.signal});
            this.registrations.set(type, registrations);
        }

        emit(type: string, event: Record<string, unknown> = {}): void {
            for (const {listener, signal} of this.registrations.get(type) ?? []) {
                if (!signal?.aborted) listener(event);
            }
        }
    }

    function pendingKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return keyboardEvent({key: 'F9', code: 'F9', altKey: false, ...overrides});
    }

    async function installPendingRuntime(isSiteDisabled: () => boolean = () => false) {
        const documentTarget = Object.assign(new PendingGestureTarget(), {getElementById: vi.fn(() => null)});
        const windowTarget = Object.assign(new PendingGestureTarget(), {getSelection: mocks.getSelection});
        vi.stubGlobal('document', documentTarget);
        vi.stubGlobal('window', windowTarget);
        const {createContentHotkeyRuntime} = await import('@/src/app/content/hotkeyRuntime');
        const runtime = createContentHotkeyRuntime(isSiteDisabled);
        const controller = new AbortController();
        runtime.installFloatingBallHotkey(controller.signal);
        return {runtime, controller, documentTarget, windowTarget};
    }

    function expectNoFullPageAction(): void {
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    }

    function expectFreshF9Recovery(documentTarget: PendingGestureTarget): void {
        documentTarget.emit('keydown', pendingKey());
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    }

    it.each(['nonmodifier', 'modifier'])('F9 pending 后额外 %s keydown 作废整轮，额外键释放与 F9 释放均不翻译', async extra => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey());
        expectNoFullPageAction();
        const extraKey = extra === 'modifier'
            ? {key: 'Control', code: 'ControlLeft', ctrlKey: true}
            : {key: 'x', code: 'KeyX'};
        const extraDown = pendingKey(extraKey);
        documentTarget.emit('keydown', extraDown);
        expect(extraDown.preventDefault).not.toHaveBeenCalled();
        const extraUp = pendingKey({...extraKey, ctrlKey: false});
        documentTarget.emit('keyup', extraUp);
        expect(extraUp.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey());
        expectNoFullPageAction();
        expectFreshF9Recovery(documentTarget);
    });

    it.each([
        ['full-none', {floatingBallHotkey: 'none'}],
        ['full-change', {floatingBallHotkey: 'custom', customFloatingBallHotkey: 'F10'}],
        ['selection-change', {customSelectionTranslatorHotkey: 'F10'}],
        ['selection-disabled', {selectionTranslatorMode: 'disabled'}],
        ['hover-change', {hotkey: 'custom', customHotkey: 'F10'}],
        ['hover-shared', {hotkey: 'custom', customHotkey: 'F9'}],
    ])('pending 后 %s 的快捷键身份改变使旧 F9 释放失效，恢复配置后新手势正常', async (_name, update) => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey());
        Object.assign(mocks.config, update);
        const staleUp = pendingKey();
        documentTarget.emit('keyup', staleUp);
        expect(staleUp.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        Object.assign(mocks.config, {
            floatingBallHotkey: 'F9', customFloatingBallHotkey: '',
            selectionTranslatorMode: 'bilingual', customSelectionTranslatorHotkey: 'F9',
            hotkey: 'none', customHotkey: '',
        });
        documentTarget.emit('keyup', pendingKey());
        expectNoFullPageAction();
        expectFreshF9Recovery(documentTarget);
    });

    it.each([
        ['config.on', 'keydown'], ['config.on', 'keyup'],
        ['siteDisabled', 'keydown'], ['siteDisabled', 'keyup'],
        ['macMeta', 'keydown'], ['macMeta', 'keyup'],
    ])('pending 后 %s 在 %s 被观察到时清除旧状态，再可用也不复活旧 F9', async (unavailable, phase) => {
        let siteDisabled = false;
        const {documentTarget} = await installPendingRuntime(() => siteDisabled);
        documentTarget.emit('keydown', pendingKey());
        if (unavailable === 'config.on') mocks.config.on = false;
        if (unavailable === 'siteDisabled') siteDisabled = true;
        const unavailableEvent = unavailable === 'macMeta'
            ? pendingKey({key: 'Meta', code: 'MetaLeft', metaKey: phase === 'keydown'})
            : pendingKey({key: 'x', code: 'KeyX'});
        documentTarget.emit(phase, unavailableEvent);
        expect(unavailableEvent.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        mocks.config.on = true;
        siteDisabled = false;
        documentTarget.emit('keyup', pendingKey());
        expectNoFullPageAction();
        expectFreshF9Recovery(documentTarget);
    });

    it.each([
        ['unrelated', {key: 'x', code: 'KeyX'}],
        ['same-key-different-code', {key: 'F9', code: 'F10'}],
    ])('%s keyup 不消费 pending，只有起始 F9 code 的释放可执行', async (_name, release) => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey());
        const unrelatedUp = pendingKey(release);
        documentTarget.emit('keyup', unrelatedUp);
        expect(unrelatedUp.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it('同一主键 code 在 keyup 的 key 字符改变时仍只消费一次', async () => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey());
        documentTarget.emit('keyup', pendingKey({key: 'Unidentified'}));
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each(['keydown', 'keyup'])('%s 缺少 code 时使用真实 core 的逻辑主键回退', async missingCodeAt => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey({code: missingCodeAt === 'keydown' ? '' : 'F9'}));
        const unrelatedUp = pendingKey({key: 'x', code: ''});
        documentTarget.emit('keyup', unrelatedUp);
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey({code: missingCodeAt === 'keyup' ? '' : 'F9'}));
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each([
        {
            name: 'Shift-first digit', hotkey: 'Alt+Shift+1',
            prefix: [
                {key: 'Alt', code: 'AltLeft', altKey: true},
                {key: 'Shift', code: 'ShiftLeft', altKey: true, shiftKey: true},
            ],
            mainDown: {key: '!', code: 'Digit1', altKey: true, shiftKey: true},
            modifierUp: {key: 'Shift', code: 'ShiftLeft', altKey: true},
            mainUp: {key: '1', code: 'Digit1', altKey: true},
            remainingUp: [{key: 'Alt', code: 'AltLeft'}],
        },
        {
            name: 'Option-first glyph', hotkey: 'Alt+/',
            prefix: [{key: 'Alt', code: 'AltLeft', altKey: true}],
            mainDown: {key: '÷', code: 'Slash', altKey: true},
            modifierUp: {key: 'Alt', code: 'AltLeft'},
            mainUp: {key: '/', code: 'Slash'},
            remainingUp: [],
        },
        {
            name: 'Shift-first symbol', hotkey: 'Ctrl+Shift+?',
            prefix: [
                {key: 'Control', code: 'ControlLeft', ctrlKey: true},
                {key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true},
            ],
            mainDown: {key: '?', code: 'Slash', ctrlKey: true, shiftKey: true},
            modifierUp: {key: 'Shift', code: 'ShiftLeft', ctrlKey: true},
            mainUp: {key: '/', code: 'Slash', ctrlKey: true},
            remainingUp: [{key: 'Control', code: 'ControlLeft'}],
        },
    ])('$name 不在修饰键释放时翻译，仍按录制时的主键 code 释放执行', async gesture => {
        Object.assign(mocks.config, {
            floatingBallHotkey: 'custom', customFloatingBallHotkey: gesture.hotkey,
            customSelectionTranslatorHotkey: gesture.hotkey,
        });
        const {runtime, documentTarget} = await installPendingRuntime();
        for (const event of gesture.prefix) documentTarget.emit('keydown', pendingKey(event));
        const down = pendingKey(gesture.mainDown);
        expect(runtime.selectionShortcutPorts.matchesSelectionTranslatorShortcut(down as unknown as KeyboardEvent)).toBe(true);
        documentTarget.emit('keydown', down);
        expectNoFullPageAction();
        const modifierUp = pendingKey(gesture.modifierUp);
        documentTarget.emit('keyup', modifierUp);
        expect(modifierUp.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey(gesture.mainUp));
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        for (const event of gesture.remainingUp) documentTarget.emit('keyup', pendingKey(event));
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();

        mocks.autoTranslateEnglishPage.mockClear();
        Object.assign(mocks.config, {floatingBallHotkey: 'F9', customFloatingBallHotkey: '', customSelectionTranslatorHotkey: 'F9'});
        expectFreshF9Recovery(documentTarget);
    });

    it.each(['preset-to-custom', 'modifier-alias-order'])('%s 仅改变配置表达形式时保留相同语义手势', async representation => {
        if (representation === 'modifier-alias-order') {
            Object.assign(mocks.config, {
                floatingBallHotkey: 'custom', customFloatingBallHotkey: 'Ctrl+Alt+F9',
                customSelectionTranslatorHotkey: 'Ctrl+Alt+F9',
            });
        }
        const {documentTarget} = await installPendingRuntime();
        const flags = representation === 'modifier-alias-order' ? {ctrlKey: true, altKey: true} : {};
        documentTarget.emit('keydown', pendingKey(flags));
        if (representation === 'preset-to-custom') {
            Object.assign(mocks.config, {floatingBallHotkey: 'custom', customFloatingBallHotkey: ' f9 ', customSelectionTranslatorHotkey: ' f9 '});
        } else {
            Object.assign(mocks.config, {customFloatingBallHotkey: 'Option+Control+f9', customSelectionTranslatorHotkey: 'Alt+Control+F9'});
        }
        // hover=none 时未采用的 custom 草稿不改变 resolved 身份。
        Object.assign(mocks.config, {customHotkey: 'F10'});
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it('document 的非冒泡 route-change 清 pending，监听器受安装 signal 约束', async () => {
        const {controller, documentTarget, windowTarget} = await installPendingRuntime();
        const routeRegistration = documentTarget.registrations.get('fluentread-route-change')?.at(-1);
        expect(routeRegistration?.signal).toBe(controller.signal);
        expect(windowTarget.registrations.has('fluentread-route-change')).toBe(false);
        documentTarget.emit('keydown', pendingKey());
        documentTarget.emit('fluentread-route-change', {isTrusted: false, bubbles: false});
        const staleUp = pendingKey();
        documentTarget.emit('keyup', staleUp);
        expect(staleUp.preventDefault).not.toHaveBeenCalled();
        expectNoFullPageAction();
        expectFreshF9Recovery(documentTarget);
        controller.abort();
        documentTarget.emit('fluentread-route-change', {isTrusted: false, bubbles: false});
        documentTarget.emit('keydown', pendingKey());
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it.each(['untrusted', 'repeat'])('%s 的额外 keydown 不污染或取消真实 F9 手势', async ignored => {
        const {documentTarget} = await installPendingRuntime();
        documentTarget.emit('keydown', pendingKey());
        documentTarget.emit('keydown', pendingKey({
            key: 'x', code: 'KeyX', isTrusted: ignored !== 'untrusted', repeat: ignored === 'repeat',
        }));
        expectNoFullPageAction();
        documentTarget.emit('keyup', pendingKey());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });
});
