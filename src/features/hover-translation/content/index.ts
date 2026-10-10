/**
 * @file src/features/hover-translation/content/index.ts
 * 文件职责：实现按住配置快捷键并移动鼠标触发的悬浮翻译手势控制器，统一管理按键集合、平台差异、节流采样和启停清理。
 * 主要内容：定义可注入的配置、常量与依赖接口，按配置原值复用鼠标快捷键的规范化结果，在 mountHoverTranslationContentFeature 中监听键盘、鼠标与触摸并区分单次切换和连续移动；仅使用可信鼠标采样的位置，换路由、隐藏或离页时清除位置与手势，仲裁、失焦和中止统一撤销键盘状态、长按、触摸连击及运行时延迟，触摸手势绑定开始时的快捷键配置。
 * 模块边界：该模块只识别手势和调用注入的 handleTranslation/cancelPending，不读取具体翻译服务或创建译文；配置源、站点禁用判断和全文运行时由 app composition root 提供。
 */
import {addPressedHotkeyEventKey, deletePressedHotkeyEventKey} from '@/src/core/hotkey';

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
    gestureSharedWithSelection: boolean;
}

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

function addPressedKey(event: KeyboardEvent, pressed: Set<string>, keyByCode: Map<string, string>, isMac: boolean): void {
    if (event.altKey) pressed.add('alt');
    if (event.ctrlKey) pressed.add('control');
    if (event.metaKey && !isMac) pressed.add('control');
    if (event.shiftKey) pressed.add('shift');
    addPressedHotkeyEventKey(event, pressed, keyByCode);
}

function removeReleasedKey(event: KeyboardEvent, pressed: Set<string>, keyByCode: Map<string, string>, isMac: boolean): void {
    deletePressedHotkeyEventKey(event, pressed, keyByCode);
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
        gestureSharedWithSelection: false,
    };
    const mouseHotkeysPressed = new Set<string>();
    const mouseHotkeyByCode = new Map<string, string>();
    // (0,0) 是合法坐标；首次可信指针事件之前不能把初始值当作当前位置。
    let pointerPositionKnown = false;
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    let touchCount = 0;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    let touchGestureHotkey = '';
    const isMac = /Mac|iPod|iPhone|iPad/.test(runtimeNavigator.platform);
    const noteExternalHostGesture = (event: Event) => {
        if (event.isTrusted) deps.noteBilingualHostGesture();
    };
    rootDocument.addEventListener('mousemove', noteExternalHostGesture, {signal, capture: true, passive: true});
    rootDocument.addEventListener('scroll', noteExternalHostGesture, {signal, capture: true, passive: true});

    let mouseShortcutRaw: string | undefined;
    let mouseShortcut = {parts: [] as string[], identity: ''};
    const getConfiguredMouseShortcut = () => {
        const raw = deps.config.hotkey === 'custom' ? deps.config.customHotkey : deps.config.hotkey;
        if (raw !== mouseShortcutRaw) {
            mouseShortcutRaw = raw;
            const parts = normalizeHoverHotkeyParts(raw).sort();
            mouseShortcut = {parts, identity: parts.join('+')};
        }
        return mouseShortcut;
    };
    const getConfiguredSelectionHotkeyParts = () => {
        const hotkey = deps.getConfiguredSelectionHotkey();
        return normalizeHoverHotkeyParts(hotkey === 'custom' ? deps.getCustomSelectionHotkey() : hotkey);
    };

    const matchesPressed = (hotkeyParts: string[]) => matchesPressedHotkeyParts(hotkeyParts, mouseHotkeysPressed);

    const resetHoverHotkeyState = () => {
        screen.hotkeyPressed = false;
        screen.otherKeyPressed = false;
        screen.hasSlideTranslation = false;
        screen.gestureHotkey = '';
        screen.gestureSharedWithSelection = false;
        mouseHotkeysPressed.clear();
        mouseHotkeyByCode.clear();
    };
    const resetTouchGesture = () => {
        clearTimeout(touchTimer);
        touchTimer = undefined;
        touchCount = 0;
        touchGestureHotkey = '';
    };
    const cancelLongPress = () => {
        if (longPressTimer !== undefined) clearTimeout(longPressTimer);
        longPressTimer = undefined;
    };
    const cancelAndResetHoverHotkeyState = () => {
        resetHoverHotkeyState();
        cancelLongPress();
        resetTouchGesture();
        deps.cancelPendingHoverTranslation();
    };
    const forgetPointerAndCancelGesture = () => {
        pointerPositionKnown = false;
        cancelAndResetHoverHotkeyState();
    };
    rootDocument.addEventListener('fluentread-route-change', forgetPointerAndCancelGesture, {signal});
    rootDocument.addEventListener('visibilitychange', () => {
        if (rootDocument.visibilityState === 'hidden') forgetPointerAndCancelGesture();
    }, {signal});
    rootDocument.addEventListener('mouseout', event => {
        if (event.isTrusted && event.relatedTarget === null) forgetPointerAndCancelGesture();
    }, {signal});
    rootDocument.addEventListener('mouseover', event => {
        if (!event.isTrusted) return;
        screen.mouseX = event.clientX;
        screen.mouseY = event.clientY;
        pointerPositionKnown = true;
    }, {signal});
    const discardUnavailableHoverGesture = (): boolean => {
        const unavailable = deps.isSiteDisabled()
            || (screen.hotkeyPressed && (!deps.config.on || screen.gestureHotkey !== getConfiguredMouseShortcut().identity));
        if (unavailable && (screen.hotkeyPressed || mouseHotkeysPressed.size > 0 ||
            longPressTimer !== undefined || touchCount > 0)) {
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

    rootWindow.addEventListener('blur', forgetPointerAndCancelGesture, { signal });

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
            cancelAndResetHoverHotkeyState();
            screen.otherKeyPressed = true;
            return;
        }

        // 步骤 1：记录当前可信按键集合，只有与配置完全一致时才进入悬浮候选态。
        addPressedKey(event, mouseHotkeysPressed, mouseHotkeyByCode, isMac);
        if (matchesPressed(getConfiguredMouseShortcut().parts) && !screen.otherKeyPressed) {
            if (!screen.hotkeyPressed) screen.gestureSharedWithSelection = matchesSelectionShortcut;
            screen.hotkeyPressed = true;
            screen.otherKeyPressed = false;
            screen.gestureHotkey = getConfiguredMouseShortcut().identity;
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
        removeReleasedKey(event, mouseHotkeysPressed, mouseHotkeyByCode, isMac);
        if (discardUnavailableHoverGesture()) return;

        if (screen.hotkeyPressed && mouseHotkeysPressed.size === 0 && !screen.otherKeyPressed && !screen.hasSlideTranslation) {
            if (deps.config.on && pointerPositionKnown) {
                event.preventDefault();
                // 共享归属绑定手势开始；释放修饰键后仍须让 Document 清理划词/全文按键状态。
                if (!screen.gestureSharedWithSelection) event.stopPropagation();
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
        pointerPositionKnown = true;
        if (longPressTimer !== undefined
            && (Math.abs(event.clientX - longPressStart.x) > 10 || Math.abs(event.clientY - longPressStart.y) > 10)) {
            cancelLongPress();
        }
        // 额外按键已取消的手势保持作废，释放组合键的一部分也不能再启动新任务。
        // hasSlideTranslation 仍保留至完整释放，避免把连续移动的结尾误当成单次切换。
        if (screen.hotkeyPressed && !screen.otherKeyPressed && matchesPressed(getConfiguredMouseShortcut().parts)) {
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
        cancelLongPress();
    }, { signal });

    rootDocument.addEventListener('mousedown', event => {
        if (!event.isTrusted) return;
        if (deps.isSiteDisabled()) return;
        if (deps.config.hotkey === deps.constants.LongPress && event.button === 0) {
            cancelLongPress();
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

    rootDocument.addEventListener('touchstart', event => {
        if (!event.isTrusted) return;
        const hotkey = deps.config.hotkey || '';
        if (!deps.config.on || deps.isSiteDisabled() ||
            ![deps.constants.DoubleClickScreen, deps.constants.TripleClickScreen].includes(hotkey) ||
            event.touches.length !== 1) {
            resetTouchGesture();
            return;
        }
        if (touchGestureHotkey !== hotkey) resetTouchGesture();
        touchGestureHotkey = hotkey;

        const requiredTouches = deps.config.hotkey === deps.constants.DoubleClickScreen ? 2 : 3;
        touchCount += 1;

        if (touchCount === 1) {
            touchTimer = setTimeout(resetTouchGesture, 500);
        } else if (touchCount === requiredTouches) {
            resetTouchGesture();
            deps.handleTranslation(event.touches[0].clientX, event.touches[0].clientY);
        }
    }, { signal });

    signal.addEventListener('abort', cancelAndResetHoverHotkeyState, { once: true });
    return cancelAndResetHoverHotkeyState;
}
