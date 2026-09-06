/**
 * @file src/features/hover-translation/content/index.ts
 * 文件职责：实现按住配置快捷键并移动鼠标触发的悬浮翻译手势控制器，统一管理按键集合、平台差异、节流采样和启停清理。
 * 主要内容：定义可注入的配置、常量与依赖接口，提供快捷键字符串规范化和匹配函数，并在 mountHoverTranslationContentFeature 中监听 keydown、keyup、mousemove、blur 与 abort，显式区分单次切换和连续移动手势；手势绑定开始时的快捷键配置，取消后不得由后续移动复活。
 * 模块边界：该模块只识别手势和调用注入的 handleTranslation/cancelPending，不读取具体翻译服务或创建译文；配置源、站点禁用判断和全文运行时由 app composition root 提供。
 */
export interface HoverTranslationContentConfig {
    on?: boolean;
    hotkey?: string;
    customHotkey?: string;
    mouseHoverTranslationDelay?: number;
}

export interface HoverTranslationGestureConstants {
    TwoFinger: string;
    ThreeFinger: string;
    FourFinger: string;
    DoubleClick: string;
    LongPress: string;
    MiddleClick: string;
    DoubleClickScreen: string;
    TripleClickScreen: string;
}

export interface HoverTranslationInvocation {
    delayMs?: number;
    continuous?: boolean;
}

export interface HoverTranslationContentDependencies {
    config: HoverTranslationContentConfig;
    constants: HoverTranslationGestureConstants;
    document: Document;
    window: Window;
    navigator: Navigator;
    isSiteDisabled: () => boolean;
    getCenterPoint: (touches: TouchList, requiredTouches: number) => { x: number; y: number } | null | undefined;
    handleTranslation: (
        mouseX: number,
        mouseY: number,
        invocation?: HoverTranslationInvocation,
    ) => void;
    cancelPendingHoverTranslation: () => void;
    noteBilingualHostGesture: () => void;
    hasActiveSelectionTranslationCandidate: () => boolean;
    getConfiguredSelectionHotkey: () => string;
    getCustomSelectionHotkey: () => string | undefined;
    matchesSelectionTranslatorShortcut: (event: KeyboardEvent) => boolean;
    shouldReserveSelectionShortcut: (event: KeyboardEvent) => boolean;
}

interface HoverTranslationScreenState {
    mouseX: number;
    mouseY: number;
    hotkeyPressed: boolean;
    otherKeyPressed: boolean;
    hasSlideTranslation: boolean;
    gestureHotkey: string;
}

const SPECIAL_KEYS: Record<string, string> = {
    escape: 'escape',
    enter: 'enter',
    space: 'space',
    tab: 'tab',
    backspace: 'backspace',
    delete: 'delete',
    insert: 'insert',
    home: 'home',
    end: 'end',
    pageup: 'pageup',
    pagedown: 'pagedown',
    arrowup: 'arrowup',
    arrowdown: 'arrowdown',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
};

export function normalizeHoverHotkeyParts(hotkeyString: string | undefined): string[] {
    if (!hotkeyString || hotkeyString === 'none') return [];

    return hotkeyString.split('+')
        .map(key => {
            const value = key.trim().toLowerCase();
            if (value === 'ctrl') return 'control';
            if (value === 'option') return 'alt';
            return value;
        })
        .filter(Boolean);
}

export function matchesPressedHotkeyParts(
    hotkeyParts: string[],
    pressed: ReadonlySet<string>,
): boolean {
    return hotkeyParts.length > 0
        && hotkeyParts.every(key => pressed.has(key))
        && hotkeyParts.length === pressed.size;
}

function addPressedKey(event: KeyboardEvent, pressed: Set<string>, isMac: boolean): void {
    if (event.altKey) pressed.add('alt');
    if (event.ctrlKey) pressed.add('control');
    if (event.metaKey && !isMac) pressed.add('control');
    if (event.shiftKey) pressed.add('shift');

    const key = event.key.toLowerCase();
    const code = event.code?.toLowerCase();
    if (code && code.startsWith('key')) {
        pressed.add(code.slice(3).toLowerCase());
    } else if (key.length === 1) {
        pressed.add(key);
    } else if (/^f\d+$/.test(key)) {
        pressed.add(key);
    } else if (SPECIAL_KEYS[key]) {
        pressed.add(SPECIAL_KEYS[key]);
    }
}

function removeReleasedKey(event: KeyboardEvent, pressed: Set<string>, isMac: boolean): void {
    const releasedKey = event.key.toLowerCase();
    const releasedCode = event.code?.toLowerCase();
    if (releasedCode && releasedCode.startsWith('key')) {
        pressed.delete(releasedCode.slice(3).toLowerCase());
    } else if (releasedKey.length === 1) {
        pressed.delete(releasedKey);
    } else if (/^f\d+$/.test(releasedKey)) {
        pressed.delete(releasedKey);
    } else if (SPECIAL_KEYS[releasedKey]) {
        pressed.delete(SPECIAL_KEYS[releasedKey]);
    }

    if (!event.altKey) pressed.delete('alt');
    if (!event.ctrlKey && (isMac || !event.metaKey)) pressed.delete('control');
    if (!event.shiftKey) pressed.delete('shift');
}

export function mountHoverTranslationContentFeature(
    deps: HoverTranslationContentDependencies,
    signal: AbortSignal,
): () => void {
    const rootDocument = deps.document;
    const rootWindow = deps.window;
    const runtimeNavigator = deps.navigator;
    const screen: HoverTranslationScreenState = {
        mouseX: 0,
        mouseY: 0,
        hotkeyPressed: false,
        otherKeyPressed: false,
        hasSlideTranslation: false,
        gestureHotkey: '',
    };
    const mouseHotkeysPressed = new Set<string>();
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    const isMac = /Mac|iPod|iPhone|iPad/.test(runtimeNavigator.platform);
    const noteExternalHostGesture = (event: Event) => {
        if (event.isTrusted) deps.noteBilingualHostGesture();
    };
    rootDocument.addEventListener('mousemove', noteExternalHostGesture, {signal, capture: true, passive: true});
    rootDocument.addEventListener('scroll', noteExternalHostGesture, {signal, capture: true, passive: true});

    const getConfiguredMouseHotkeyParts = () => normalizeHoverHotkeyParts(
        deps.config.hotkey === 'custom' ? deps.config.customHotkey : deps.config.hotkey,
    );
    const getConfiguredSelectionHotkeyParts = () => {
        const hotkey = deps.getConfiguredSelectionHotkey();
        return normalizeHoverHotkeyParts(hotkey === 'custom' ? deps.getCustomSelectionHotkey() : hotkey);
    };

    const matchesPressed = (hotkeyParts: string[]) => matchesPressedHotkeyParts(hotkeyParts, mouseHotkeysPressed);
    const configuredGestureHotkey = () => getConfiguredMouseHotkeyParts().sort().join('+');

    const resetHoverHotkeyState = () => {
        screen.hotkeyPressed = false;
        screen.otherKeyPressed = false;
        screen.hasSlideTranslation = false;
        screen.gestureHotkey = '';
        mouseHotkeysPressed.clear();
    };
    const cancelAndResetHoverHotkeyState = () => {
        resetHoverHotkeyState();
        deps.cancelPendingHoverTranslation();
    };
    const discardUnavailableHoverGesture = (): boolean => {
        const unavailable = deps.isSiteDisabled()
            || (screen.hotkeyPressed && (!deps.config.on || screen.gestureHotkey !== configuredGestureHotkey()));
        if (unavailable && (screen.hotkeyPressed || mouseHotkeysPressed.size > 0)) {
            cancelAndResetHoverHotkeyState();
        }
        return unavailable;
    };

    const cancelHoverForActiveSelection = (): boolean => {
        if (!screen.hotkeyPressed || !matchesPressed(getConfiguredSelectionHotkeyParts())) return false;
        if (!deps.hasActiveSelectionTranslationCandidate()) return false;
        screen.hotkeyPressed = false;
        screen.otherKeyPressed = true;
        screen.hasSlideTranslation = false;
        deps.cancelPendingHoverTranslation();
        return true;
    };

    rootDocument.addEventListener('selectionchange', cancelHoverForActiveSelection, { signal });

    rootWindow.addEventListener('blur', () => {
        resetHoverHotkeyState();
        if (longPressTimer !== undefined) clearTimeout(longPressTimer);
        longPressTimer = undefined;
        deps.cancelPendingHoverTranslation();
    }, { signal });

    rootWindow.addEventListener('keydown', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        if (event.repeat) return;
        if (isMac && event.metaKey) {
            if (screen.hotkeyPressed) {
                screen.otherKeyPressed = true;
                deps.cancelPendingHoverTranslation();
            }
            return;
        }

        const matchesSelectionShortcut = deps.matchesSelectionTranslatorShortcut(event);
        if (deps.shouldReserveSelectionShortcut(event)) {
            resetHoverHotkeyState();
            screen.otherKeyPressed = true;
            return;
        }

        // 步骤 1：记录当前可信按键集合，只有与配置完全一致时才进入悬浮候选态。
        addPressedKey(event, mouseHotkeysPressed, isMac);
        if (matchesPressed(getConfiguredMouseHotkeyParts()) && !screen.otherKeyPressed) {
            screen.hotkeyPressed = true;
            screen.otherKeyPressed = false;
            screen.gestureHotkey = configuredGestureHotkey();
            if (deps.config.on) {
                event.preventDefault();
                if (!matchesSelectionShortcut) event.stopPropagation();
            }
        } else if (screen.hotkeyPressed) {
            // 步骤 2：Ctrl+C 等额外组合键会作废已排队的悬浮翻译。
            screen.otherKeyPressed = true;
            deps.cancelPendingHoverTranslation();
        }
    }, { signal, capture: true });

    rootDocument.addEventListener('pointerdown', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (!screen.hotkeyPressed || !matchesPressed(getConfiguredSelectionHotkeyParts())) return;
        // 步骤 1：pointerdown 发生在新选区形成之前；共享划词快捷键已按下时先把拖选手势交给划词功能。
        screen.hotkeyPressed = false;
        screen.otherKeyPressed = true;
        screen.hasSlideTranslation = false;
        deps.cancelPendingHoverTranslation();
    }, { signal, capture: true });

    rootWindow.addEventListener('keyup', event => {
        if (!event.isTrusted) return;
        removeReleasedKey(event, mouseHotkeysPressed, isMac);
        if (discardUnavailableHoverGesture()) return;

        if (screen.hotkeyPressed && mouseHotkeysPressed.size === 0 && !screen.otherKeyPressed && !screen.hasSlideTranslation) {
            if (deps.config.on) {
                event.preventDefault();
                event.stopPropagation();
                deps.handleTranslation(screen.mouseX, screen.mouseY);
            }
        }

        if (mouseHotkeysPressed.size === 0) resetHoverHotkeyState();
    }, { signal, capture: true });

    const longPressStart = { x: 0, y: 0 };

    rootDocument.addEventListener('mousemove', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        screen.mouseX = event.clientX;
        screen.mouseY = event.clientY;
        if (longPressTimer !== undefined
            && (Math.abs(event.clientX - longPressStart.x) > 10 || Math.abs(event.clientY - longPressStart.y) > 10)) {
            clearTimeout(longPressTimer);
            longPressTimer = undefined;
        }
        // 额外按键已取消的手势保持作废，释放组合键的一部分也不能再启动新任务。
        // hasSlideTranslation 仍保留至完整释放，避免把连续移动的结尾误当成单次切换。
        if (screen.hotkeyPressed && !screen.otherKeyPressed && matchesPressed(getConfiguredMouseHotkeyParts())) {
            if (cancelHoverForActiveSelection()) return;
            screen.hasSlideTranslation = true;
            // 连续移动与延迟是两个独立维度。0ms 只是立即响应，不能退化成
            // “再次命中已译句子就恢复原文”的单次切换手势。
            deps.handleTranslation(
                screen.mouseX,
                screen.mouseY,
                {
                    delayMs: deps.config.mouseHoverTranslationDelay,
                    continuous: true,
                },
            );
        }
    }, { signal });

    rootDocument.addEventListener('touchstart', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        let coordinate;
        switch (deps.config.hotkey) {
            case deps.constants.TwoFinger:
                coordinate = deps.getCenterPoint(event.touches, 2);
                break;
            case deps.constants.ThreeFinger:
                coordinate = deps.getCenterPoint(event.touches, 3);
                break;
            case deps.constants.FourFinger:
                coordinate = deps.getCenterPoint(event.touches, 4);
                break;
            default:
                return;
        }

        if (deps.config.on && coordinate) deps.handleTranslation(coordinate.x, coordinate.y);
    }, { signal, capture: true });

    rootDocument.addEventListener('dblclick', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (deps.config.hotkey === deps.constants.DoubleClick && deps.config.on) {
            deps.handleTranslation(event.clientX, event.clientY);
        }
    }, { signal });

    rootDocument.addEventListener('mouseup', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (longPressTimer !== undefined) clearTimeout(longPressTimer);
        longPressTimer = undefined;
    }, { signal });

    rootDocument.addEventListener('mousedown', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (deps.config.hotkey === deps.constants.LongPress && event.button === 0) {
            if (longPressTimer !== undefined) clearTimeout(longPressTimer);
            longPressStart.x = event.clientX;
            longPressStart.y = event.clientY;
            longPressTimer = setTimeout(() => {
                longPressTimer = undefined;
                if (!deps.isSiteDisabled() && deps.config.on && deps.config.hotkey === deps.constants.LongPress) {
                    deps.handleTranslation(event.clientX, event.clientY);
                }
            }, 500);
        }
    }, { signal });

    rootDocument.addEventListener('mousedown', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (deps.config.hotkey === deps.constants.MiddleClick && deps.config.on && event.button === 1) {
            deps.handleTranslation(event.clientX, event.clientY);
        }
    }, { signal });

    let touchCount = 0;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    rootDocument.addEventListener('touchstart', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (![deps.constants.DoubleClickScreen, deps.constants.TripleClickScreen].includes(deps.config.hotkey || '')
            || event.touches.length !== 1) return;

        const requiredTouches = deps.config.hotkey === deps.constants.DoubleClickScreen ? 2 : 3;
        touchCount += 1;

        if (touchCount === 1) {
            touchTimer = setTimeout(() => { touchCount = 0; }, 500);
        } else if (touchCount === requiredTouches) {
            clearTimeout(touchTimer);
            touchCount = 0;
            if (deps.config.on) deps.handleTranslation(event.touches[0].clientX, event.touches[0].clientY);
        }
    }, { signal });

    signal.addEventListener('abort', () => {
        resetHoverHotkeyState();
        if (longPressTimer !== undefined) clearTimeout(longPressTimer);
        clearTimeout(touchTimer);
    }, { once: true });
    return cancelAndResetHoverHotkeyState;
}
