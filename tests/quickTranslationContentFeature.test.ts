import {afterEach, describe, expect, it, vi} from 'vitest';
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation';
import {
    mountQuickTranslationContentFeature,
    type QuickTranslationContentDependencies,
} from '@/src/features/quick-translation/public';

type Listener = (event: any) => unknown;

class FakeTarget {
    listeners = new Map<string, Listener[]>();
    visibilityState = 'visible';
    options = new Map<string, Array<boolean | AddEventListenerOptions | undefined>>();

    addEventListener(
        type: string,
        listener: Listener,
        options?: boolean | AddEventListenerOptions,
    ): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        this.options.set(type, [...(this.options.get(type) ?? []), options]);
    }

    emit(type: string, event: Record<string, unknown> = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
}

function profile(
    id: string,
    action: QuickTranslationProfile['action'],
    hotkey: string,
    overrides: Partial<QuickTranslationProfile> = {},
): QuickTranslationProfile {
    return {
        id,
        enabled: true,
        action,
        hotkey,
        service: `${id}-service`,
        model: `${id}-model`,
        targetLanguage: id === 'hover-y' ? 'ja' : 'zh',
        displayMode: 'inherit',
        fullPageMode: 'inherit',
        ...overrides,
    };
}

function keyboardEvent(overrides: Record<string, unknown> = {}): any {
    return {
        isTrusted: true,
        repeat: false,
        key: 't',
        code: 'KeyT',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...overrides,
    };
}

function pointerEvent(overrides: Record<string, unknown> = {}): any {
    return {
        isTrusted: true,
        clientX: 0,
        clientY: 0,
        ...overrides,
    };
}

function mountHarness(
    overrides: Partial<QuickTranslationContentDependencies> = {},
    controller = new AbortController(),
    seedPointer = true,
) {
    const hoverT = profile('hover-t', 'hover', 'Ctrl+T');
    const hoverY = profile('hover-y', 'hover', 'Ctrl+Y');
    const fullPage = profile('page-u', 'full-page', 'Ctrl+U');
    const windowTarget = new FakeTarget();
    const documentTarget = new FakeTarget();
    const deps: QuickTranslationContentDependencies = {
        config: {
            on: true,
            quickTranslationProfiles: [hoverT, hoverY, fullPage],
            mouseHoverTranslationDelay: 90,
        },
        window: windowTarget as unknown as Window,
        document: documentTarget as unknown as Document,
        isSiteDisabled: () => false,
        isProfileAvailable: () => true,
        shouldReserveSelectionShortcut: vi.fn(() => false),
        getConfiguredSelectionHotkey: () => 'none',
        getCustomSelectionHotkey: () => '',
        hasActiveSelectionTranslationCandidate: vi.fn(() => false),
        resetLegacyKeyboardGestures: vi.fn(),
        cancelPendingHoverTranslation: vi.fn(),
        runHover: vi.fn(),
        runFullPage: vi.fn(),
        runSection: vi.fn(),
        isEditing: vi.fn(() => false),
        ...overrides,
    };
    mountQuickTranslationContentFeature(deps, controller.signal);
    // (0,0) 是合法的已知坐标；没有任何可信样本的情况由冷启动用例单独验证。
    if (seedPointer) documentTarget.emit('mouseover', pointerEvent());
    return {controller, deps, documentTarget, fullPage, hoverT, hoverY, windowTarget};
}

afterEach(() => vi.useRealTimers());

describe('quick translation content feature', () => {
    it('悬浮快捷方案等待可信指针样本，第一次纯键盘手势不翻译左上角', () => {
        const {deps, documentTarget, hoverT, windowTarget} = mountHarness({}, new AbortController(), false);
        const trigger = () => {
            windowTarget.emit('keydown', keyboardEvent());
            windowTarget.emit('keyup', keyboardEvent());
            windowTarget.emit('keyup', keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: false}));
        };
        documentTarget.emit('mouseover', pointerEvent({isTrusted: false, clientX: 99, clientY: 100}));
        trigger();
        expect(deps.runHover).not.toHaveBeenCalled();
        documentTarget.emit('mouseover', pointerEvent({clientX: 21, clientY: 35}));
        trigger();
        expect(deps.runHover).toHaveBeenCalledOnce();
        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 21, 35);
    });

    it.each(['route', 'hidden', 'pointer-exit', 'blur'])(
        '快捷方案在 %s 后取消待执行翻译，并清空旧按键和坐标', reason => {
            vi.useFakeTimers();
            const upstream = vi.fn();
            let pending: ReturnType<typeof setTimeout> | undefined;
            const {deps, documentTarget, hoverT, windowTarget} = mountHarness({
                runHover: vi.fn((_profile, _x, _y, invocation) => {
                    pending = setTimeout(upstream, invocation?.delayMs ?? 0);
                }),
                cancelPendingHoverTranslation: vi.fn(() => clearTimeout(pending)),
            });
            const press = () => windowTarget.emit('keydown', keyboardEvent());
            const release = () => {
                windowTarget.emit('keyup', keyboardEvent());
                windowTarget.emit('keyup', keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: false}));
            };
            press();
            documentTarget.emit('mousemove', pointerEvent({clientX: 10, clientY: 20}));
            if (reason === 'route') documentTarget.emit('fluentread-route-change');
            if (reason === 'hidden') {
                documentTarget.visibilityState = 'hidden';
                documentTarget.emit('visibilitychange');
                documentTarget.visibilityState = 'visible';
                documentTarget.emit('visibilitychange');
            }
            if (reason === 'pointer-exit') documentTarget.emit('mouseout', pointerEvent({relatedTarget: null}));
            if (reason === 'blur') windowTarget.emit('blur');
            release();
            press(); release();
            vi.advanceTimersByTime(500);
            expect(upstream).not.toHaveBeenCalled();
            expect(deps.runHover).toHaveBeenCalledOnce();
            documentTarget.emit('mousemove', pointerEvent({clientX: 31, clientY: 41}));
            expect(deps.runHover).toHaveBeenCalledOnce();
            press(); release();
            vi.advanceTimersByTime(500);
            expect(upstream).toHaveBeenCalledOnce();
            expect(deps.runHover).toHaveBeenLastCalledWith(hoverT, 31, 41);
        },
    );

    it('页面内切换元素、伪造离开和可见事件保留快捷方案手势', () => {
        const {deps, documentTarget, hoverT, windowTarget} = mountHarness();
        windowTarget.emit('keydown', keyboardEvent());
        documentTarget.emit('mouseout', pointerEvent({relatedTarget: {}}));
        documentTarget.emit('mouseout', pointerEvent({isTrusted: false, relatedTarget: null}));
        documentTarget.emit('visibilitychange');
        windowTarget.emit('keyup', keyboardEvent());
        expect(deps.runHover).toHaveBeenCalledOnce();
        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 0, 0);
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
    });

    it('中止后的生命周期事件和指针进入不会恢复已卸载的快捷方案', () => {
        const {controller, deps, documentTarget} = mountHarness();
        controller.abort();
        vi.mocked(deps.cancelPendingHoverTranslation).mockClear();
        documentTarget.emit('mouseover', pointerEvent());
        documentTarget.emit('fluentread-route-change');
        documentTarget.visibilityState = 'hidden';
        documentTarget.emit('visibilitychange');
        documentTarget.emit('mouseout', pointerEvent({relatedTarget: null}));
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(deps.runHover).not.toHaveBeenCalled();
    });

    it('把两个悬停快捷键分别路由到各自完整 profile，并在移动后不于 keyup 重复执行', () => {
        const {deps, documentTarget, hoverT, hoverY, windowTarget} = mountHarness();
        const firstKeydown = keyboardEvent();
        windowTarget.emit('keydown', firstKeydown);
        documentTarget.emit('mousemove', pointerEvent({clientX: 12, clientY: 34}));
        windowTarget.emit('keyup', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        const secondKeydown = keyboardEvent({key: 'y', code: 'KeyY'});
        windowTarget.emit('keydown', secondKeydown);
        documentTarget.emit('mousemove', pointerEvent({clientX: 56, clientY: 78}));
        windowTarget.emit('keyup', keyboardEvent({key: 'y', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).toHaveBeenNthCalledWith(1, hoverT, 12, 34, {delayMs: 90, continuous: true});
        expect(deps.runHover).toHaveBeenNthCalledWith(2, hoverY, 56, 78, {delayMs: 90, continuous: true});
        expect(deps.runHover).toHaveBeenCalledTimes(2);
        expect(firstKeydown.preventDefault).toHaveBeenCalledOnce();
        expect(firstKeydown.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(secondKeydown.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(deps.resetLegacyKeyboardGestures).toHaveBeenCalled();
    });

    it('全文方案在命中 keydown 时立即执行并阻止旧单例监听器', () => {
        const {deps, fullPage, windowTarget} = mountHarness();
        const keydown = keyboardEvent({key: 'u', code: 'KeyU'});

        windowTarget.emit('keydown', keydown);

        expect(deps.runFullPage).toHaveBeenCalledOnce();
        expect(deps.runFullPage).toHaveBeenCalledWith(fullPage);
        expect(deps.runHover).not.toHaveBeenCalled();
        expect(keydown.preventDefault).toHaveBeenCalledOnce();
        expect(keydown.stopImmediatePropagation).toHaveBeenCalledOnce();
    });

    it('悬停方案未移动时在释放组合键时使用最后可信坐标执行一次', () => {
        const {deps, documentTarget, hoverT, windowTarget} = mountHarness();
        documentTarget.emit('mousemove', pointerEvent({clientX: 21, clientY: 55}));
        documentTarget.emit('mousemove', pointerEvent({isTrusted: false, clientX: 99, clientY: 100}));
        windowTarget.emit('keydown', keyboardEvent());
        const keyup = keyboardEvent();

        windowTarget.emit('keyup', keyup);

        expect(deps.runHover).toHaveBeenCalledOnce();
        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 21, 55);
        expect(keyup.preventDefault).toHaveBeenCalledOnce();
        expect(keyup.stopImmediatePropagation).toHaveBeenCalledOnce();
    });

    it('移动后释放快捷键不会让旧手势清理取消已经排队的延迟翻译', () => {
        let delayedTranslationPending = false;
        const resetLegacyKeyboardGestures = vi.fn(() => { delayedTranslationPending = false; });
        const runHover = vi.fn(() => { delayedTranslationPending = true; });
        const {documentTarget, windowTarget} = mountHarness({resetLegacyKeyboardGestures, runHover});

        windowTarget.emit('keydown', keyboardEvent());
        documentTarget.emit('mousemove', pointerEvent({clientX: 12, clientY: 34}));
        expect(delayedTranslationPending).toBe(true);
        windowTarget.emit('keyup', keyboardEvent());

        expect(delayedTranslationPending).toBe(true);
        expect(resetLegacyKeyboardGestures).toHaveBeenCalledOnce();
        expect(runHover).toHaveBeenCalledOnce();
    });

    it('忽略全局关闭、站点禁用、空快捷键和单项禁用', () => {
        const globalOff = mountHarness();
        globalOff.deps.config.on = false;
        globalOff.windowTarget.emit('keydown', keyboardEvent());

        const siteOff = mountHarness({isSiteDisabled: () => true});
        siteOff.windowTarget.emit('keydown', keyboardEvent());

        const profilesOff = mountHarness();
        profilesOff.deps.config.quickTranslationProfiles = [
            profile('disabled', 'hover', 'Ctrl+T', {enabled: false}),
            profile('blank', 'hover', ''),
        ];
        const ignored = keyboardEvent();
        profilesOff.windowTarget.emit('keydown', ignored);

        expect(globalOff.deps.runHover).not.toHaveBeenCalled();
        expect(siteOff.deps.runHover).not.toHaveBeenCalled();
        expect(profilesOff.deps.runHover).not.toHaveBeenCalled();
        expect(ignored.preventDefault).not.toHaveBeenCalled();
    });

    it('当前浏览器不可用的服务方案不会接管快捷键', () => {
        const {deps, windowTarget} = mountHarness({isProfileAvailable: () => false});
        const event = keyboardEvent();

        windowTarget.emit('keydown', event);

        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('重复或不可信键盘事件不能触发方案，也不能推进可信手势', () => {
        const {deps, windowTarget} = mountHarness();
        windowTarget.emit('keydown', keyboardEvent({isTrusted: false}));
        windowTarget.emit('keydown', keyboardEvent({repeat: true}));
        windowTarget.emit('keyup', keyboardEvent());
        expect(deps.runHover).not.toHaveBeenCalled();

        windowTarget.emit('keydown', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent({isTrusted: false}));
        expect(deps.runHover).not.toHaveBeenCalled();
        windowTarget.emit('keyup', keyboardEvent());
        expect(deps.runHover).toHaveBeenCalledOnce();
    });

    it('已接管的重复 keydown 依然被拦截，但不会取消原本的悬停手势', () => {
        const {deps, hoverT, windowTarget} = mountHarness();
        windowTarget.emit('keydown', keyboardEvent());
        const repeated = keyboardEvent({repeat: true});

        windowTarget.emit('keydown', repeated);
        windowTarget.emit('keyup', keyboardEvent());

        expect(repeated.preventDefault).toHaveBeenCalledOnce();
        expect(repeated.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 0, 0);
    });

    it('支持 Option/Alt、Shift、数字、空格、功能键和无 code 特殊键的真实键序列', () => {
        const {deps, windowTarget} = mountHarness();
        const altDigit = profile('alt-digit', 'full-page', 'Alt+2');
        const shiftSpace = profile('shift-space', 'full-page', 'Shift+Space');
        const functionKey = profile('function', 'full-page', 'F9');
        const ctrlEnter = profile('ctrl-enter', 'full-page', 'Ctrl+Enter');
        deps.config.quickTranslationProfiles = [altDigit, shiftSpace, functionKey, ctrlEnter];

        windowTarget.emit('keydown', keyboardEvent({
            key: 'Option', code: 'AltLeft', ctrlKey: false, altKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Option', code: 'AltLeft', ctrlKey: false, altKey: false,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: false,
        }));

        windowTarget.emit('keydown', keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: false,
        }));

        windowTarget.emit('keydown', keyboardEvent({
            key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: ' ', code: 'Space', ctrlKey: false, shiftKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: false,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: ' ', code: 'Space', ctrlKey: false, shiftKey: false,
        }));

        windowTarget.emit('keydown', keyboardEvent({
            key: ' ', code: 'Space', ctrlKey: false, shiftKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: ' ', code: 'Space', ctrlKey: false, shiftKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: false,
        }));

        windowTarget.emit('keydown', keyboardEvent({
            key: 'F9', code: 'F9', ctrlKey: false,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'F9', code: 'F9', ctrlKey: false,
        }));

        windowTarget.emit('keydown', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: 'Enter', code: '', ctrlKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Enter', code: '', ctrlKey: false,
        }));

        expect(deps.runFullPage).toHaveBeenNthCalledWith(1, altDigit);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(2, altDigit);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(3, shiftSpace);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(4, shiftSpace);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(5, functionKey);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(6, ctrlEnter);
    });

    it('Meta/Command 别名不会绕过全局 Meta 禁用规则，且不会污染后续手势', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.quickTranslationProfiles = [profile('meta-t', 'hover', 'Meta+T')];

        windowTarget.emit('keydown', keyboardEvent({
            key: 'Command', code: 'MetaLeft', ctrlKey: false, metaKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: 't', code: 'KeyT', ctrlKey: false, metaKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 't', code: 'KeyT', ctrlKey: false, metaKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Meta', code: 'MetaLeft', ctrlKey: false, metaKey: false,
        }));

        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
    });

    it('非 QWERTY 布局按录制时的逻辑字符匹配，不按物理 code 串键', () => {
        const {deps, hoverY, windowTarget} = mountHarness();
        deps.config.quickTranslationProfiles = [hoverY];

        windowTarget.emit('keydown', keyboardEvent({key: 'y', code: 'KeyT'}));
        windowTarget.emit('keyup', keyboardEvent({key: 'y', code: 'KeyT'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));
        expect(deps.runHover).toHaveBeenCalledWith(hoverY, 0, 0);

        windowTarget.emit('keydown', keyboardEvent({key: 'f', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({key: 'f', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));
        expect(deps.runHover).toHaveBeenCalledTimes(1);
    });

    it('逻辑键未知时仍可用 code 执行功能键与特殊键方案', () => {
        const {deps, windowTarget} = mountHarness();
        const functionKey = profile('function', 'full-page', 'F9');
        const arrowKey = profile('arrow', 'full-page', 'Ctrl+ArrowDown');
        deps.config.quickTranslationProfiles = [functionKey, arrowKey];

        windowTarget.emit('keydown', keyboardEvent({
            key: 'Unidentified', code: 'F9', ctrlKey: false,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Unidentified', code: 'F9', ctrlKey: false,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: 'Unidentified', code: 'ArrowDown', ctrlKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Unidentified', code: 'ArrowDown', ctrlKey: true,
        }));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runFullPage).toHaveBeenNthCalledWith(1, functionKey);
        expect(deps.runFullPage).toHaveBeenNthCalledWith(2, arrowKey);
    });

    it('组合键命中前已按住或命中后追加的普通键都会使手势失效', () => {
        const beforeMatch = mountHarness();
        beforeMatch.windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        beforeMatch.windowTarget.emit('keydown', keyboardEvent({key: 'x', code: 'KeyX'}));
        const finalKey = keyboardEvent();
        beforeMatch.windowTarget.emit('keydown', finalKey);
        beforeMatch.windowTarget.emit('keyup', keyboardEvent());
        expect(beforeMatch.deps.runHover).not.toHaveBeenCalled();
        expect(finalKey.preventDefault).not.toHaveBeenCalled();

        const afterMatch = mountHarness();
        afterMatch.windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        afterMatch.windowTarget.emit('keydown', keyboardEvent());
        afterMatch.windowTarget.emit('keydown', keyboardEvent({key: 'x', code: 'KeyX'}));
        afterMatch.windowTarget.emit('keyup', keyboardEvent());
        expect(afterMatch.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(afterMatch.deps.runHover).not.toHaveBeenCalled();
    });

    it('命中划词预留快捷键时把可信事件和有效选区完整留给既有划词功能', () => {
        const reserve = vi.fn(() => true);
        const {deps, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: reserve,
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => true,
        });
        const event = keyboardEvent();

        windowTarget.emit('keydown', event);
        windowTarget.emit('keyup', keyboardEvent());

        expect(reserve).toHaveBeenCalledOnce();
        expect(deps.runHover).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    });

    it('划词的单修饰键是 quick 组合前缀时，整次手势都保留给划词', () => {
        const reserve = vi.fn((event: KeyboardEvent) => event.key.toLowerCase() === 'control');
        const {deps, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: reserve,
            getConfiguredSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: () => true,
        });

        const modifier = keyboardEvent({key: 'Control', code: 'ControlLeft'});
        const letter = keyboardEvent();
        const repeatedLetter = keyboardEvent({repeat: true});
        const extraLetter = keyboardEvent({key: 'x', code: 'KeyX'});
        windowTarget.emit('keydown', modifier);
        windowTarget.emit('keydown', letter);
        windowTarget.emit('keydown', repeatedLetter);
        windowTarget.emit('keydown', extraLetter);
        windowTarget.emit('keyup', keyboardEvent({key: 'x', code: 'KeyX'}));
        const letterUp = keyboardEvent();
        windowTarget.emit('keyup', letterUp);
        const modifierUp = keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        });
        windowTarget.emit('keyup', modifierUp);

        expect(reserve).toHaveBeenCalled();
        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
        expect(letter.preventDefault).toHaveBeenCalledOnce();
        expect(letter.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(repeatedLetter.preventDefault).toHaveBeenCalledOnce();
        expect(extraLetter.preventDefault).toHaveBeenCalledOnce();
        expect(letterUp.preventDefault).toHaveBeenCalledOnce();
        expect(letterUp.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(modifierUp.preventDefault).not.toHaveBeenCalled();
    });

    it('按住划词修饰键后才产生选区时，后续 quick 组合仍由划词优先', () => {
        let hasSelection = false;
        const {deps, documentTarget, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: () => false,
            getConfiguredSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        hasSelection = true;
        documentTarget.emit('selectionchange');
        const letter = keyboardEvent();

        windowTarget.emit('keydown', letter);
        windowTarget.emit('keyup', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
        expect(letter.preventDefault).toHaveBeenCalledOnce();
        expect(letter.stopImmediatePropagation).toHaveBeenCalledOnce();
    });

    it('浏览器未派发 selectionchange 时也在 quick 命中点复查单修饰键选区', () => {
        let hasSelection = false;
        const {deps, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: () => false,
            getConfiguredSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        hasSelection = true;

        const letter = keyboardEvent();
        windowTarget.emit('keydown', letter);

        expect(deps.runHover).not.toHaveBeenCalled();
        expect(letter.preventDefault).toHaveBeenCalledOnce();
    });

    it('单修饰键预留后选区静默消失时，quick 命中点会恢复正常路由', () => {
        let hasSelection = true;
        const {deps, hoverT, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: (event) => event.key === 'Control' && hasSelection,
            getConfiguredSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        hasSelection = false;

        windowTarget.emit('keydown', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 0, 0);
    });

    it('动态选区在组合键前收起会解除单修饰键预留', () => {
        let hasSelection = false;
        const {deps, documentTarget, hoverT, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: () => false,
            getConfiguredSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        hasSelection = true;
        documentTarget.emit('selectionchange');
        hasSelection = false;
        documentTarget.emit('selectionchange');

        windowTarget.emit('keydown', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 0, 0);
    });

    it('自定义划词组合不会仅凭 Ctrl 前缀预留其他 quick 组合', () => {
        const {deps, documentTarget, hoverY, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: () => false,
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => true,
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        documentTarget.emit('selectionchange');

        windowTarget.emit('keydown', keyboardEvent({key: 'y', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({key: 'y', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).toHaveBeenCalledWith(hoverY, 0, 0);
    });

    it('自定义划词 chord 的主键释放后不会误吞同一修饰键下的下一条 quick', () => {
        const {deps, hoverY, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: (event) => event.key.toLowerCase() === 't',
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => true,
        });
        const selectionKey = keyboardEvent();
        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        windowTarget.emit('keydown', selectionKey);
        windowTarget.emit('keyup', keyboardEvent());

        const quickKey = keyboardEvent({key: 'y', code: 'KeyY'});
        windowTarget.emit('keydown', quickKey);
        windowTarget.emit('keyup', keyboardEvent({key: 'y', code: 'KeyY'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(selectionKey.preventDefault).not.toHaveBeenCalled();
        expect(quickKey.preventDefault).toHaveBeenCalledOnce();
        expect(deps.runHover).toHaveBeenCalledWith(hoverY, 0, 0);
    });

    it('无效自定义划词配置在修饰键释放时安全清理预留状态', () => {
        const {deps, windowTarget} = mountHarness({
            shouldReserveSelectionShortcut: () => true,
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+NotAKey',
        });

        windowTarget.emit('keydown', keyboardEvent({key: 'Control', code: 'ControlLeft'}));
        windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));

        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
    });

    it('共享划词快捷键在选区于手势中变为有效时取消待执行悬停', () => {
        let hasSelection = false;
        const {deps, documentTarget, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent());
        hasSelection = true;

        documentTarget.emit('mousemove', pointerEvent({clientX: 8, clientY: 13}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.runHover).not.toHaveBeenCalled();
        windowTarget.emit('keyup', keyboardEvent());
        expect(deps.runHover).not.toHaveBeenCalled();
    });

    it('共享划词快捷键在 keyup 前才出现有效选区时仍优先留给划词', () => {
        let hasSelection = false;
        const {deps, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => hasSelection,
        });
        windowTarget.emit('keydown', keyboardEvent());
        hasSelection = true;

        windowTarget.emit('keyup', keyboardEvent());

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.runHover).not.toHaveBeenCalled();
    });

    it('未配置自定义划词键时不把 quick profile 误判为冲突', () => {
        const {deps, hoverT, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => undefined,
        });

        windowTarget.emit('keydown', keyboardEvent());
        windowTarget.emit('keyup', keyboardEvent());

        expect(deps.runHover).toHaveBeenCalledWith(hoverT, 0, 0);
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
    });

    it('手势期间关闭全局或当前服务时取消待执行悬停', () => {
        const keyupUnavailable = mountHarness();
        keyupUnavailable.windowTarget.emit('keydown', keyboardEvent());
        keyupUnavailable.deps.config.on = false;
        keyupUnavailable.windowTarget.emit('keyup', keyboardEvent());
        keyupUnavailable.windowTarget.emit('keyup', keyboardEvent({
            key: 'Control', code: 'ControlLeft', ctrlKey: false,
        }));
        expect(keyupUnavailable.deps.cancelPendingHoverTranslation).toHaveBeenCalledTimes(2);
        expect(keyupUnavailable.deps.runHover).not.toHaveBeenCalled();

        const moveUnavailable = mountHarness();
        moveUnavailable.windowTarget.emit('keydown', keyboardEvent());
        moveUnavailable.deps.config.on = false;
        moveUnavailable.documentTarget.emit('mousemove', pointerEvent({clientX: 4, clientY: 9}));
        moveUnavailable.windowTarget.emit('keyup', keyboardEvent());
        expect(moveUnavailable.deps.cancelPendingHoverTranslation).toHaveBeenCalledTimes(2);
        expect(moveUnavailable.deps.runHover).not.toHaveBeenCalled();
    });

    it('手势期间快捷键配置变为无效时，本次释放不会错触翻译', () => {
        const {deps, hoverT, windowTarget} = mountHarness();
        windowTarget.emit('keydown', keyboardEvent());
        hoverT.hotkey = 'Ctrl+NotAKey';

        windowTarget.emit('keyup', keyboardEvent());

        expect(deps.runHover).not.toHaveBeenCalled();
    });

    it('已接管手势中的无关 keyup 不会提前释放快捷键归属', () => {
        const available = mountHarness();
        available.windowTarget.emit('keydown', keyboardEvent());
        const unrelatedAvailable = keyboardEvent({key: 'x', code: 'KeyX'});
        available.windowTarget.emit('keyup', unrelatedAvailable);
        available.windowTarget.emit('keyup', keyboardEvent());
        expect(unrelatedAvailable.preventDefault).toHaveBeenCalledOnce();
        expect(available.deps.runHover).toHaveBeenCalledOnce();

        const unavailable = mountHarness();
        unavailable.windowTarget.emit('keydown', keyboardEvent());
        unavailable.deps.config.on = false;
        const unrelatedUnavailable = keyboardEvent({key: 'x', code: 'KeyX'});
        unavailable.windowTarget.emit('keyup', unrelatedUnavailable);
        unavailable.windowTarget.emit('keyup', keyboardEvent());
        expect(unrelatedUnavailable.preventDefault).toHaveBeenCalledOnce();
        expect(unavailable.deps.cancelPendingHoverTranslation).toHaveBeenCalledTimes(2);
        expect(unavailable.deps.runHover).not.toHaveBeenCalled();
    });

    it('组合键先释放修饰键时仍接管剩余按键的 repeat 与 keyup 尾事件', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.quickTranslationProfiles = [profile('alt-digit', 'full-page', 'Alt+2')];
        windowTarget.emit('keydown', keyboardEvent({
            key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: true,
        }));
        const modifierUp = keyboardEvent({
            key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: false,
        });
        const repeatedDigit = keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: false, repeat: true,
        });
        const digitUp = keyboardEvent({
            key: '2', code: 'Digit2', ctrlKey: false, altKey: false,
        });

        windowTarget.emit('keyup', modifierUp);
        windowTarget.emit('keydown', repeatedDigit);
        windowTarget.emit('keyup', digitUp);

        expect(deps.runFullPage).toHaveBeenCalledOnce();
        expect(modifierUp.preventDefault).toHaveBeenCalledOnce();
        expect(repeatedDigit.preventDefault).toHaveBeenCalledOnce();
        expect(digitUp.preventDefault).toHaveBeenCalledOnce();
    });

    it('macOS Option 变形字符仍按配置字母触发，释放后不再接管键盘', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.quickTranslationProfiles = [profile('option-letter', 'full-page', 'Alt+T')];
        windowTarget.emit('keydown', keyboardEvent({
            key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true,
        }));
        const transformedKeydown = keyboardEvent({
            key: '†', code: 'KeyT', ctrlKey: false, altKey: true,
        });
        windowTarget.emit('keydown', transformedKeydown);
        const modifierUp = keyboardEvent({
            key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: false,
        });
        const letterUp = keyboardEvent({
            key: 't', code: 'KeyT', ctrlKey: false, altKey: false,
        });
        windowTarget.emit('keyup', modifierUp);
        windowTarget.emit('keyup', letterUp);

        const unrelatedKeydown = keyboardEvent({
            key: 'x', code: 'KeyX', ctrlKey: false, altKey: false,
        });
        windowTarget.emit('keydown', unrelatedKeydown);

        expect(deps.runFullPage).toHaveBeenCalledOnce();
        expect(transformedKeydown.preventDefault).toHaveBeenCalledOnce();
        expect(modifierUp.preventDefault).toHaveBeenCalledOnce();
        expect(letterUp.preventDefault).toHaveBeenCalledOnce();
        expect(unrelatedKeydown.preventDefault).not.toHaveBeenCalled();
    });

    it('Shift 符号键先释放修饰键时按 keydown 身份清理，不残留接管状态', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.quickTranslationProfiles = [profile('shift-symbol', 'full-page', 'Shift+_')];
        windowTarget.emit('keydown', keyboardEvent({
            key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: true,
        }));
        windowTarget.emit('keydown', keyboardEvent({
            key: '_', code: 'Minus', ctrlKey: false, shiftKey: true,
        }));
        const modifierUp = keyboardEvent({
            key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: false,
        });
        const symbolUp = keyboardEvent({
            key: '-', code: 'Minus', ctrlKey: false, shiftKey: false,
        });
        windowTarget.emit('keyup', modifierUp);
        windowTarget.emit('keyup', symbolUp);

        const unrelatedKeydown = keyboardEvent({
            key: 'x', code: 'KeyX', ctrlKey: false, shiftKey: false,
        });
        windowTarget.emit('keydown', unrelatedKeydown);

        expect(deps.runFullPage).toHaveBeenCalledOnce();
        expect(modifierUp.preventDefault).toHaveBeenCalledOnce();
        expect(symbolUp.preventDefault).toHaveBeenCalledOnce();
        expect(unrelatedKeydown.preventDefault).not.toHaveBeenCalled();
    });

    it('selectionchange 只在快捷键冲突且已有有效选区时取消悬停手势', () => {
        const unrelated = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+Y',
            hasActiveSelectionTranslationCandidate: () => true,
        });
        unrelated.windowTarget.emit('keydown', keyboardEvent());
        unrelated.documentTarget.emit('selectionchange');
        unrelated.windowTarget.emit('keyup', keyboardEvent());
        expect(unrelated.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(unrelated.deps.runHover).toHaveBeenCalledOnce();

        const noCandidate = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => false,
        });
        noCandidate.windowTarget.emit('keydown', keyboardEvent());
        noCandidate.documentTarget.emit('selectionchange');
        noCandidate.windowTarget.emit('keyup', keyboardEvent());
        expect(noCandidate.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(noCandidate.deps.runHover).toHaveBeenCalledOnce();

        const conflicting = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Ctrl+T',
            hasActiveSelectionTranslationCandidate: () => true,
        });
        conflicting.windowTarget.emit('keydown', keyboardEvent());
        conflicting.documentTarget.emit('selectionchange');
        conflicting.windowTarget.emit('keyup', keyboardEvent());
        expect(conflicting.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(conflicting.deps.runHover).not.toHaveBeenCalled();
    });

    it('没有按住划词修饰键或冲突 quick 手势时不读取高成本选区候选', () => {
        const hasCandidate = vi.fn(() => true);
        const {documentTarget} = mountHarness({hasActiveSelectionTranslationCandidate: hasCandidate});

        documentTarget.emit('selectionchange');

        expect(hasCandidate).not.toHaveBeenCalled();
    });

    it('额外按键、pointerdown、blur 与 abort 都取消 pending 并清空手势', () => {
        const extra = mountHarness();
        extra.windowTarget.emit('keydown', keyboardEvent());
        extra.windowTarget.emit('keydown', keyboardEvent({key: 'x', code: 'KeyX'}));
        extra.windowTarget.emit('keyup', keyboardEvent());
        expect(extra.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(extra.deps.runHover).not.toHaveBeenCalled();

        const pointer = mountHarness();
        pointer.windowTarget.emit('keydown', keyboardEvent());
        pointer.documentTarget.emit('pointerdown', pointerEvent());
        pointer.windowTarget.emit('keyup', keyboardEvent());
        expect(pointer.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(pointer.deps.runHover).not.toHaveBeenCalled();

        const blurred = mountHarness();
        blurred.windowTarget.emit('keydown', keyboardEvent());
        blurred.windowTarget.emit('blur');
        blurred.windowTarget.emit('keyup', keyboardEvent());
        expect(blurred.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(blurred.deps.runHover).not.toHaveBeenCalled();

        const aborted = mountHarness();
        aborted.windowTarget.emit('keydown', keyboardEvent());
        aborted.controller.abort();
        aborted.windowTarget.emit('keyup', keyboardEvent());
        expect(aborted.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(aborted.deps.runHover).not.toHaveBeenCalled();
    });

    it('主键先释放后同一 chord 的额外按键仍取消已排队的延迟悬停', async () => {
        vi.useFakeTimers();
        try {
            let pendingTimer: number | undefined;
            const committed = vi.fn();
            const cancelPendingHoverTranslation = vi.fn(() => {
                if (pendingTimer !== undefined) clearTimeout(pendingTimer);
                pendingTimer = undefined;
            });
            const runHover = vi.fn((
                _profile: QuickTranslationProfile,
                _mouseX: number,
                _mouseY: number,
                invocation: {delayMs?: number} = {},
            ) => {
                pendingTimer = setTimeout(committed, invocation.delayMs ?? 0);
            });
            const {documentTarget, windowTarget} = mountHarness({
                cancelPendingHoverTranslation,
                runHover,
            });

            windowTarget.emit('keydown', keyboardEvent());
            documentTarget.emit('mousemove', pointerEvent({clientX: 12, clientY: 34}));
            windowTarget.emit('keyup', keyboardEvent());
            expect(cancelPendingHoverTranslation).not.toHaveBeenCalled();

            windowTarget.emit('keydown', keyboardEvent({key: 'x', code: 'KeyX'}));
            await vi.advanceTimersByTimeAsync(100);

            expect(cancelPendingHoverTranslation).toHaveBeenCalledOnce();
            expect(committed).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('忽略不可信 pointer，并在 abort 后让所有残留回调保持静默', () => {
        const untrusted = mountHarness();
        untrusted.windowTarget.emit('keydown', keyboardEvent());
        untrusted.documentTarget.emit('pointerdown', pointerEvent({isTrusted: false}));
        untrusted.windowTarget.emit('keyup', keyboardEvent());
        expect(untrusted.deps.runHover).toHaveBeenCalledOnce();
        expect(untrusted.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();

        const aborted = mountHarness();
        aborted.windowTarget.emit('keydown', keyboardEvent());
        aborted.controller.abort();
        const cancelCount = vi.mocked(aborted.deps.cancelPendingHoverTranslation).mock.calls.length;
        aborted.windowTarget.emit('blur');
        aborted.windowTarget.emit('keydown', keyboardEvent());
        aborted.windowTarget.emit('keyup', keyboardEvent());
        aborted.documentTarget.emit('mousemove', pointerEvent());
        aborted.documentTarget.emit('selectionchange');
        aborted.documentTarget.emit('pointerdown', pointerEvent());
        expect(aborted.deps.cancelPendingHoverTranslation).toHaveBeenCalledTimes(cancelCount);
        expect(aborted.deps.runHover).not.toHaveBeenCalled();
    });

    it('已 abort 的 signal 不安装任何监听器，但仍执行一次统一清理', () => {
        const controller = new AbortController();
        controller.abort();

        const {deps, documentTarget, windowTarget} = mountHarness({}, controller);

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(windowTarget.listeners.size).toBe(0);
        expect(documentTarget.listeners.size).toBe(0);
    });

    it('键盘监听器明确安装在 window capture 阶段', () => {
        const {windowTarget} = mountHarness();
        expect(windowTarget.options.get('keydown')?.[0]).toMatchObject({capture: true});
        expect(windowTarget.options.get('keyup')?.[0]).toMatchObject({capture: true});
    });
});


describe('局部快捷方案的容器选择路由', () => {
    it('按下时只进入容器选择，松开、长按和移动不会触发悬浮或全文', () => {
        const selected = profile('section-r', 'section', 'Ctrl+R');
        const {deps, windowTarget, documentTarget} = mountHarness({
            config: {on: true, quickTranslationProfiles: [selected]},
        });
        windowTarget.emit('keydown', keyboardEvent({key: 'r', code: 'KeyR'}));
        windowTarget.emit('keydown', keyboardEvent({key: 'r', code: 'KeyR', repeat: true}));
        documentTarget.emit('mousemove', pointerEvent({clientX: 20, clientY: 40}));
        windowTarget.emit('keyup', keyboardEvent({key: 'r', code: 'KeyR'}));
        windowTarget.emit('keyup', keyboardEvent({key: 'Control', code: 'ControlLeft', ctrlKey: false}));
        expect(deps.runSection).toHaveBeenCalledOnce();
        expect(deps.runSection).toHaveBeenCalledWith(selected);
        expect(deps.runHover).not.toHaveBeenCalled();
        expect(deps.runFullPage).not.toHaveBeenCalled();
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalled();
    });

    it('输入框内让行，不进入容器选择也不阻止网页输入', () => {
        const {deps, windowTarget} = mountHarness({isEditing: () => true, config: {
            on: true, quickTranslationProfiles: [profile('section-r', 'section', 'Ctrl+R')],
        }});
        const input = {tagName: 'INPUT', getAttribute: () => null};
        const event = keyboardEvent({key: 'r', code: 'KeyR', composedPath: () => [input]});
        windowTarget.emit('keydown', event);
        expect(deps.runSection).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});
