import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    matchesPressedHotkeyParts,
    mountHoverTranslationContentFeature,
    normalizeHoverHotkeyParts,
    type HoverTranslationContentDependencies,
} from '@/src/features/hover-translation/content';

type Listener = (event: any) => unknown;

class FakeTarget {
    listeners = new Map<string, Listener[]>();

    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        expect(options).toBeTruthy();
    }

    emit(type: string, event: Record<string, unknown> = {}): void {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }
}

function trustedEvent(event: Record<string, unknown> = {}): any {
    return {
        isTrusted: true,
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        button: 0,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...event,
    };
}

function mountHarness(overrides: Partial<HoverTranslationContentDependencies> = {}) {
    const documentTarget = new FakeTarget();
    const windowTarget = new FakeTarget();
    const config = {
        on: true,
        hotkey: 'Control',
        customHotkey: '',
        mouseHoverTranslationDelay: 120,
    };
    const deps: HoverTranslationContentDependencies = {
        config,
        constants: {
            TwoFinger: 'twoFinger',
            ThreeFinger: 'threeFinger',
            FourFinger: 'fourFinger',
            DoubleClick: 'doubleClick',
            LongPress: 'longPress',
            MiddleClick: 'middleClick',
            DoubleClickScreen: 'doubleClickScreen',
            TripleClickScreen: 'tripleClickScreen',
        },
        document: documentTarget as unknown as Document,
        window: windowTarget as unknown as Window,
        navigator: {platform: 'MacIntel'} as Navigator,
        isSiteDisabled: () => false,
        getCenterPoint: vi.fn(() => ({x: 7, y: 9})),
        handleTranslation: vi.fn(),
        noteBilingualHostGesture: vi.fn(),
        cancelPendingHoverTranslation: vi.fn(),
        hasActiveSelectionTranslationCandidate: vi.fn(() => false),
        getConfiguredSelectionHotkey: () => 'Control',
        getCustomSelectionHotkey: () => '',
        matchesSelectionTranslatorShortcut: vi.fn(() => false),
        shouldReserveSelectionShortcut: vi.fn(() => false),
        ...overrides,
    };
    const controller = new AbortController();

    const resetKeyboardGesture = mountHoverTranslationContentFeature(deps, controller.signal);

    return {deps, documentTarget, windowTarget, controller, resetKeyboardGesture};
}

afterEach(() => {
    vi.useRealTimers();
});

describe('hover translation content feature', () => {
    it.each(['blur', 'config-change', 'right-button', 'middle-button'])('长按在 %s 时保留宿主手势，不触发迟到翻译', reason => {
        vi.useFakeTimers();
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.hotkey = deps.constants.LongPress;
        documentTarget.emit('mousedown', trustedEvent({
            clientX: 10, clientY: 20,
            button: reason === 'right-button' ? 2 : reason === 'middle-button' ? 1 : 0,
        }));
        if (reason === 'blur') windowTarget.emit('blur');
        if (reason === 'config-change') deps.config.hotkey = deps.constants.DoubleClick;

        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('可信 mousemove 与 scroll 即使未按热键也推进宿主手势代次', () => {
        const {deps, documentTarget} = mountHarness();

        documentTarget.emit('mousemove', trustedEvent());
        documentTarget.emit('scroll', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({isTrusted: false}));

        expect(deps.noteBilingualHostGesture).toHaveBeenCalledTimes(2);
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('外部仲裁器可重置旧悬浮手势并取消其待执行翻译', () => {
        const {deps, resetKeyboardGesture, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));

        resetKeyboardGesture();
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('标准化组合键并要求按键集合精确匹配', () => {
        expect(normalizeHoverHotkeyParts(undefined)).toEqual([]);
        expect(normalizeHoverHotkeyParts('none')).toEqual([]);
        expect(normalizeHoverHotkeyParts(' Ctrl + Option + A ')).toEqual(['control', 'alt', 'a']);
        expect(matchesPressedHotkeyParts([], new Set())).toBe(false);
        expect(matchesPressedHotkeyParts(['control'], new Set(['control']))).toBe(true);
        expect(matchesPressedHotkeyParts(['control'], new Set(['control', 'c']))).toBe(false);
    });

    it.each([
        {label: '0ms', delayMs: 0},
        {label: '120ms', delayMs: 120},
    ] as const)('$label 移动手势每次都显式传 continuous=true，keyup 不重复触发', ({delayMs}) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.mouseHoverTranslationDelay = delayMs;
        const keydown = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});

        windowTarget.emit('keydown', keydown);
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 26}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(keydown.preventDefault).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenNthCalledWith(1, 10, 20, {
            delayMs,
            continuous: true,
        });
        expect(deps.handleTranslation).toHaveBeenNthCalledWith(2, 10, 26, {
            delayMs,
            continuous: true,
        });
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
    });

    it('未移动时在释放完整快捷键后触发一次当前位置翻译', () => {
        const {deps, windowTarget} = mountHarness();

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        const keyup = trustedEvent({key: 'Control', code: 'ControlLeft'});
        windowTarget.emit('keyup', keyup);

        expect(keyup.preventDefault).toHaveBeenCalledOnce();
        expect(keyup.stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledWith(0, 0);
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it('站点禁用、非可信事件、重复按键和 macOS Command 都不会触发', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => true});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 1, clientY: 2}));
        documentTarget.emit('dblclick', trustedEvent({clientX: 1, clientY: 2}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();

        const enabled = mountHarness();
        enabled.windowTarget.emit('keydown', {...trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}), isTrusted: false});
        enabled.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true, repeat: true}));
        enabled.windowTarget.emit('keydown', trustedEvent({key: 'Meta', code: 'MetaLeft', metaKey: true}));
        enabled.documentTarget.emit('mousemove', {...trustedEvent({clientX: 1, clientY: 2}), isTrusted: false});
        enabled.windowTarget.emit('keyup', {...trustedEvent({key: 'Control', code: 'ControlLeft'}), isTrusted: false});
        enabled.windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(enabled.deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('额外按键、窗口失焦和有效选区会取消已进入候选态的悬浮翻译', () => {
        const hasSelection = vi.fn(() => true);
        const {deps, documentTarget, windowTarget} = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keydown', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        documentTarget.emit('pointerdown', {...trustedEvent(), isTrusted: false});

        const pointerHarness = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        pointerHarness.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        pointerHarness.documentTarget.emit('pointerdown', trustedEvent());
        expect(pointerHarness.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const idlePointer = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        idlePointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(idlePointer.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();

        const customSelectionPointer = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: hasSelection,
        });
        customSelectionPointer.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        customSelectionPointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(customSelectionPointer.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const disabledPointer = mountHarness({
            isSiteDisabled: () => true,
            hasActiveSelectionTranslationCandidate: hasSelection,
        });
        disabledPointer.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        disabledPointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(disabledPointer.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();

        const selectionDragStart = mountHarness({
            hasActiveSelectionTranslationCandidate: () => false,
        });
        selectionDragStart.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        selectionDragStart.documentTarget.emit('pointerdown', trustedEvent());
        expect(selectionDragStart.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const blurHarness = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        blurHarness.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        blurHarness.windowTarget.emit('blur');
        expect(blurHarness.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
    });

    it('额外组合键取消后，移动和先释放额外键都不能恢复本轮悬浮手势', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keydown', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 50, clientY: 60, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[50, 60, {delayMs: 120, continuous: true}]]);
    });

    it.each(['Control', 'Shift'])('释放 Control+Shift 的 %s 后，鼠标移动不再触发连续翻译', (released) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.hotkey = 'Control+Shift';
        windowTarget.emit('keydown', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true, shiftKey: true}));
        windowTarget.emit('keyup', trustedEvent({
            key: released,
            code: `${released}Left`,
            ctrlKey: released !== 'Control',
            shiftKey: released !== 'Shift',
        }));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        windowTarget.emit('keyup', trustedEvent({key: released === 'Control' ? 'Shift' : 'Control'}));

        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[10, 20, {delayMs: 120, continuous: true}]]);
    });

    it('macOS Command 打断已有 Control 手势，释放 Command 后也不能恢复翻译', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        const command = trustedEvent({key: 'Meta', code: 'MetaLeft', ctrlKey: true, metaKey: true});
        windowTarget.emit('keydown', command);
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true, metaKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Meta', code: 'MetaLeft', ctrlKey: true}));
        // 同时按另一侧 Control 也不能让已经取消的同轮手势重新进入候选。
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlRight', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlRight', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalled();
        expect(command.preventDefault).not.toHaveBeenCalled();
        expect(command.stopPropagation).not.toHaveBeenCalled();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[30, 40]]);
    });

    it('纯 Control 组合的单次切换等到最后一个键释放，不因缺少 metaKey 提前触发', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.hotkey = 'Control+x';
        windowTarget.emit('keydown', trustedEvent({key: 'x', code: 'KeyX', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX', ctrlKey: true}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it.each(['move', 'release'])('快捷键配置改变后，旧手势的 %s 不触发新配置翻译', (completion) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        deps.config.hotkey = 'Alt';
        if (completion === 'move') documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('临时禁用期间释放按键后，再启用不能复活旧悬浮手势', () => {
        let disabled = false;
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => disabled});
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        disabled = true;
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        disabled = false;
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('划词快捷键未匹配时，有选区也不会取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'Alt',
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('selectionchange', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(deps.handleTranslation).toHaveBeenCalledWith(12, 24, {
            delayMs: 120,
            continuous: true,
        });
    });

    it('selectionchange 在划词快捷键匹配且存在有效选区时取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('selectionchange', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('mousemove 触发前发现有效选区时取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });


    it('支持字母、功能键、特殊键、非 macOS meta 映射和 selection shortcut stopPropagation 分支', () => {
        const functionKey = mountHarness({navigator: {platform: 'Win32'} as Navigator});
        functionKey.deps.config.hotkey = 'F1';
        functionKey.windowTarget.emit('keydown', trustedEvent({key: 'F1', code: 'F1'}));
        functionKey.windowTarget.emit('keyup', trustedEvent({key: 'F1', code: 'F1'}));
        expect(functionKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const singleCharacter = mountHarness();
        singleCharacter.deps.config.hotkey = 'x';
        singleCharacter.windowTarget.emit('keydown', trustedEvent({key: 'x', code: ''}));
        singleCharacter.windowTarget.emit('keyup', trustedEvent({key: 'x', code: ''}));
        singleCharacter.windowTarget.emit('keydown', trustedEvent({key: 'x', code: 'KeyX'}));
        singleCharacter.windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX'}));
        expect(singleCharacter.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const specialKey = mountHarness();
        specialKey.deps.config.hotkey = 'Escape';
        specialKey.windowTarget.emit('keydown', trustedEvent({key: 'Escape', code: 'Escape'}));
        specialKey.windowTarget.emit('keyup', trustedEvent({key: 'Escape', code: 'Escape'}));
        expect(specialKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const metaKey = mountHarness({navigator: {platform: 'Win32'} as Navigator});
        metaKey.deps.config.hotkey = 'Control';
        metaKey.windowTarget.emit('keydown', trustedEvent({key: 'Meta', code: 'MetaLeft', metaKey: true}));
        metaKey.windowTarget.emit('keyup', trustedEvent({key: 'Meta', code: 'MetaLeft'}));
        expect(metaKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const selectionShortcut = mountHarness({matchesSelectionTranslatorShortcut: () => true});
        const event = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});
        selectionShortcut.windowTarget.emit('keydown', event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).not.toHaveBeenCalled();

        const customCombo = mountHarness();
        customCombo.deps.config.hotkey = 'custom';
        customCombo.deps.config.customHotkey = 'Alt+Shift+x';
        customCombo.windowTarget.emit('keydown', trustedEvent({
            key: 'x',
            code: 'KeyX',
            altKey: true,
            shiftKey: true,
        }));
        customCombo.windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX'}));
        expect(customCombo.deps.handleTranslation).toHaveBeenCalledWith(0, 0);
    });

    it('划词明确预留快捷键时清空 hover 状态并不阻止后续 selection 监听', () => {
        const {deps, windowTarget} = mountHarness({shouldReserveSelectionShortcut: () => true});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('支持触摸、双击、长按、中键和屏幕连击触发，并在 abort 时清理计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget, controller} = mountHarness();

        deps.config.hotkey = 'twoFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 2}, {clientX: 3, clientY: 4}]}));
        deps.config.hotkey = 'threeFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 2}, {clientX: 3, clientY: 4}, {clientX: 5, clientY: 6}]}));
        deps.config.hotkey = 'fourFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{}, {}, {}, {}]}));
        deps.config.hotkey = 'disabledGesture';
        documentTarget.emit('touchstart', trustedEvent({touches: [{}, {}]}));
        expect(deps.getCenterPoint).toHaveBeenCalledTimes(3);

        deps.config.hotkey = 'doubleClick';
        documentTarget.emit('dblclick', {...trustedEvent({clientX: 0, clientY: 0}), isTrusted: false});
        documentTarget.emit('dblclick', trustedEvent({clientX: 8, clientY: 9}));
        deps.config.hotkey = 'middleClick';
        documentTarget.emit('mousedown', {...trustedEvent({button: 1, clientX: 0, clientY: 0}), isTrusted: false});
        documentTarget.emit('mousedown', trustedEvent({button: 0, clientX: 0, clientY: 0}));
        documentTarget.emit('mousedown', trustedEvent({button: 1, clientX: 11, clientY: 13}));
        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 21, clientY: 34}));
        vi.advanceTimersByTime(500);

        deps.config.hotkey = 'doubleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 55, clientY: 89}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 55, clientY: 89}]}));
        deps.config.hotkey = 'tripleClickScreen';
        documentTarget.emit('touchstart', {...trustedEvent({touches: [{clientX: 0, clientY: 0}]}), isTrusted: false});
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}, {clientX: 1, clientY: 1}]}));
        deps.config.hotkey = 'middleClick';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}]}));
        deps.config.hotkey = undefined;
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}]}));
        deps.config.hotkey = 'tripleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));

        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 30}));
        documentTarget.emit('mouseup', trustedEvent());
        controller.abort();

        expect(deps.handleTranslation).toHaveBeenCalledWith(7, 9);
        expect(deps.handleTranslation).toHaveBeenCalledWith(8, 9);
        expect(deps.handleTranslation).toHaveBeenCalledWith(11, 13);
        expect(deps.handleTranslation).toHaveBeenCalledWith(21, 34);
        expect(deps.handleTranslation).toHaveBeenCalledWith(55, 89);
        expect(deps.handleTranslation).toHaveBeenCalledWith(5, 8);
        expect(vi.mocked(deps.handleTranslation).mock.calls.every(call => call.length === 2)).toBe(true);
    });

    it('中键和屏幕连击在站点禁用时被 guard 拦截', () => {
        const {deps, documentTarget} = mountHarness({isSiteDisabled: () => true});

        deps.config.hotkey = 'middleClick';
        documentTarget.emit('mousedown', trustedEvent({button: 1, clientX: 1, clientY: 1}));
        deps.config.hotkey = 'doubleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 1}]}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('双击和 mouseup 在站点禁用或非可信事件时被 guard 拦截', () => {
        const disabled = mountHarness({isSiteDisabled: () => true});
        disabled.deps.config.hotkey = 'doubleClick';
        disabled.documentTarget.emit('dblclick', trustedEvent({clientX: 1, clientY: 1}));
        disabled.documentTarget.emit('mouseup', trustedEvent());

        const untrusted = mountHarness();
        untrusted.documentTarget.emit('mouseup', {...trustedEvent(), isTrusted: false});

        expect(disabled.deps.handleTranslation).not.toHaveBeenCalled();
        expect(untrusted.deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('长按开始后移动超过阈值会取消本次长按翻译', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 30}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('长按开始后仅 Y 轴移动超过阈值也会取消本次长按翻译', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 5, clientY: 30}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('mouseup 会清理尚未触发的长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mouseup', trustedEvent());
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('重复 mousedown 会替换上一轮长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousedown', trustedEvent({clientX: 2, clientY: 3}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledWith(2, 3);
    });

    it('abort 会清理尚未触发的长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget, controller} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        controller.abort();
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('配置关闭时仍记录状态但不拦截事件、不触发翻译', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.on = false;
        const keydown = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});

        windowTarget.emit('keydown', keydown);
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(keydown.preventDefault).not.toHaveBeenCalled();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });
});
