/**
 * @file src/features/hover-translation/content/index.ts
 * 文件职责：实现按住配置快捷键并移动鼠标触发的悬浮翻译手势控制器，统一管理按键集合、平台差异、节流采样和启停清理。
 * 主要内容：定义可注入的配置、常量与依赖接口，从可信鼠标进入、移动或按下采集位置，复用快捷键解析并按绘制帧合并连续采样；区分单次切换、连续移动和触摸手势，配置变化、仲裁、离开视口、失焦、页面隐藏与卸载统一撤销待执行工作及失效坐标。
 * 模块边界：该模块只识别手势和调用注入的 handleTranslation/cancelPending，不读取具体翻译服务或创建译文；配置源、站点禁用判断和全文运行时由 app composition root 提供。
 */
import {addPressedHotkeyEventKey, deletePressedHotkeyEventKey, parseHotkey} from '@/src/core/hotkey';

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
    subscribeConfig?: (listener: () => void) => () => void;
}

interface HoverTranslationScreenState {
    mouseX: number;
    mouseY: number;
    pointerKnown: boolean;
    hotkeyPressed: boolean;
    otherKeyPressed: boolean;
    hasSlideTranslation: boolean;
    gestureHotkey: string;
    gestureSharedWithSelection: boolean;
}

export function normalizeHoverHotkeyParts(hotkeyString: string | undefined): string[] {
    if (!hotkeyString || hotkeyString === 'none') return [];

    // 普通键使用录制器共用的解析器，保证字面量「+」等合法自定义键不会被分隔符吞掉。
    const parsed = parseHotkey(hotkeyString);
    if (parsed.isValid) return [...parsed.modifiers.map(key => key === 'ctrl' ? 'control' : key), parsed.key];

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
    if (signal.aborted) return () => {};
    const rootDocument = deps.document;
    const rootWindow = deps.window;
    const runtimeNavigator = deps.navigator;
    const screen: HoverTranslationScreenState = {
        mouseX: 0,
        mouseY: 0,
        pointerKnown: false,
        hotkeyPressed: false,
        otherKeyPressed: false,
        hasSlideTranslation: false,
        gestureHotkey: '',
        gestureSharedWithSelection: false,
    };
    const rememberMousePosition = (event: Pick<MouseEvent, 'clientX' | 'clientY'>) => {
        screen.mouseX = event.clientX;
        screen.mouseY = event.clientY;
        screen.pointerKnown = true;
    };
    const mouseHotkeysPressed = new Set<string>();
    const mouseHotkeyByCode = new Map<string, string>();
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    let touchCount = 0;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    let touchGestureHotkey = '';
    let hoverFrame: number | undefined;
    let hoverPointDirty = false;
    let hoverFrameGeneration = 0;
    let lastHoverX: number | undefined;
    let lastHoverY: number | undefined;
    let hasHoverWork = false;
    const isMac = /Mac|iPod|iPhone|iPad/.test(runtimeNavigator.platform);
    const noteExternalHostGesture = (event: Event) => {
        if (!signal.aborted && event.isTrusted) deps.noteBilingualHostGesture();
    };
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
    let selectionShortcutRaw: string | undefined;
    let selectionShortcutParts: string[] = [];
    const getConfiguredSelectionHotkeyParts = () => {
        const hotkey = deps.getConfiguredSelectionHotkey();
        const raw = hotkey === 'custom' ? deps.getCustomSelectionHotkey() : hotkey;
        if (raw !== selectionShortcutRaw) {
            selectionShortcutRaw = raw;
            selectionShortcutParts = normalizeHoverHotkeyParts(raw);
        }
        return selectionShortcutParts;
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
    const cancelHoverFrame = () => {
        if (hoverFrame !== undefined) rootWindow.cancelAnimationFrame(hoverFrame);
        hoverFrame = undefined;
        hoverPointDirty = false;
        hoverFrameGeneration += 1;
    };
    const cancelHoverWork = () => {
        cancelHoverFrame();
        deps.cancelPendingHoverTranslation();
        hasHoverWork = false;
    };
    const invokeTranslation: HoverTranslationContentDependencies['handleTranslation'] = (x, y, invocation) => {
        hasHoverWork = true;
        if (invocation) deps.handleTranslation(x, y, invocation);
        else deps.handleTranslation(x, y);
    };
    const hasHoverGestureOrWork = () => screen.hotkeyPressed || screen.otherKeyPressed || mouseHotkeysPressed.size > 0
        || longPressTimer !== undefined || touchCount > 0 || hoverFrame !== undefined || hasHoverWork;
    const cancelAndResetHoverHotkeyState = () => {
        const active = hasHoverGestureOrWork();
        resetHoverHotkeyState();
        lastHoverX = lastHoverY = undefined;
        cancelLongPress();
        resetTouchGesture();
        if (active) cancelHoverWork();
    };
    const invalidatePointerGesture = () => {
        cancelAndResetHoverHotkeyState();
        screen.pointerKnown = false;
    };
    let routeHref = rootWindow.location.href;
    const invalidateRouteGesture = () => {
        if (routeHref === rootWindow.location.href) return;
        routeHref = rootWindow.location.href;
        invalidatePointerGesture();
    };
    const discardUnavailableHoverGesture = (): boolean => {
        const unavailable = signal.aborted || rootDocument.hidden || !deps.config.on || deps.isSiteDisabled()
            || (screen.hotkeyPressed && screen.gestureHotkey !== getConfiguredMouseShortcut().identity);
        if (unavailable && hasHoverGestureOrWork()) {
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
        cancelHoverWork();
        return true;
    };

    rootDocument.addEventListener('selectionchange', cancelHoverForActiveSelection, { signal });

    rootWindow.addEventListener('blur', invalidatePointerGesture, { signal });
    rootWindow.addEventListener('pagehide', invalidatePointerGesture, { signal });
    rootWindow.addEventListener('popstate', invalidateRouteGesture, { signal });
    rootWindow.addEventListener('hashchange', invalidateRouteGesture, { signal });
    rootDocument.addEventListener('fluentread-route-change', invalidateRouteGesture, { signal });
    rootDocument.addEventListener('visibilitychange', () => {
        if (rootDocument.hidden) invalidatePointerGesture();
    }, { signal });
    rootDocument.addEventListener('mouseover', event => {
        if (!signal.aborted && event.isTrusted) rememberMousePosition(event);
    }, { signal });
    rootDocument.addEventListener('mouseout', event => {
        if (event.isTrusted && event.relatedTarget === null) invalidatePointerGesture();
    }, { signal });
    rootDocument.addEventListener('mouseleave', event => {
        if (event.isTrusted) invalidatePointerGesture();
    }, { signal });
    rootDocument.addEventListener('pointercancel', event => {
        if (event.isTrusted) invalidatePointerGesture();
    }, { signal });
    rootDocument.addEventListener('touchcancel', event => {
        if (event.isTrusted) invalidatePointerGesture();
    }, { signal });
    rootDocument.addEventListener('scroll', event => {
        if (!event.isTrusted) return;
        cancelLongPress();
        if (hoverFrame !== undefined || hasHoverWork) cancelHoverWork();
        // 坐标仍属于当前视口，但滚动已经换掉其下方内容；下一次移动或单次热键须重新识别目标。
        lastHoverX = lastHoverY = undefined;
    }, { signal, capture: true, passive: true });

    rootWindow.addEventListener('keydown', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        if (event.repeat) return;
        if (isMac && event.metaKey) {
            if (screen.hotkeyPressed) {
                screen.otherKeyPressed = true;
                cancelHoverWork();
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
            cancelHoverWork();
        }
    }, { signal, capture: true });

    rootDocument.addEventListener('pointerdown', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        // 内容脚本可能在鼠标静止时挂载。可信鼠标点击也提供位置；触摸/笔输入不能借用鼠标快捷键。
        if (event.pointerType === 'mouse') rememberMousePosition(event);
        if (!screen.hotkeyPressed || !matchesPressed(getConfiguredSelectionHotkeyParts())) return;
        // 步骤 1：pointerdown 发生在新选区形成之前；共享划词快捷键已按下时先把拖选手势交给划词功能。
        screen.hotkeyPressed = false;
        screen.otherKeyPressed = true;
        screen.hasSlideTranslation = false;
        cancelHoverWork();
    }, { signal, capture: true });

    rootWindow.addEventListener('keyup', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        cancelHoverForActiveSelection();
        removeReleasedKey(event, mouseHotkeysPressed, mouseHotkeyByCode, isMac);

        // 完整快捷键开始释放时提交本帧最新位置，保留已经停留目标的延迟；帧回调不能在松手后再启动工作。
        if (screen.hotkeyPressed && !matchesPressed(getConfiguredMouseShortcut().parts)) {
            if (hoverPointDirty && !screen.otherKeyPressed && screen.pointerKnown
                && (screen.mouseX !== lastHoverX || screen.mouseY !== lastHoverY)) {
                invokeTranslation(screen.mouseX, screen.mouseY, {
                    delayMs: deps.config.mouseHoverTranslationDelay,
                    continuous: true,
                });
                lastHoverX = screen.mouseX;
                lastHoverY = screen.mouseY;
            }
            cancelHoverFrame();
        }

        if (screen.hotkeyPressed && screen.pointerKnown && mouseHotkeysPressed.size === 0 && !screen.otherKeyPressed && !screen.hasSlideTranslation) {
            if (deps.config.on) {
                event.preventDefault();
                // 共享归属绑定手势开始；释放修饰键后仍须让 Document 清理划词/全文按键状态。
                if (!screen.gestureSharedWithSelection) event.stopPropagation();
                invokeTranslation(screen.mouseX, screen.mouseY);
            }
        }

        if (mouseHotkeysPressed.size === 0) {
            resetHoverHotkeyState();
            lastHoverX = lastHoverY = undefined;
        }
    }, { signal, capture: true });

    const longPressStart = { x: 0, y: 0 };
    const dispatchContinuousHover = () => {
        if (cancelHoverForActiveSelection()) return;
        hoverPointDirty = false;
        lastHoverX = screen.mouseX;
        lastHoverY = screen.mouseY;
        const generation = hoverFrameGeneration;
        invokeTranslation(screen.mouseX, screen.mouseY, {
            delayMs: deps.config.mouseHoverTranslationDelay,
            continuous: true,
        });
        if (generation !== hoverFrameGeneration || signal.aborted) return;
        // 首点立即响应；同一绘制帧内其余移动只保留最后位置，减少候选识别和配置快照的重复开销。
        hoverFrame = rootWindow.requestAnimationFrame(() => {
            if (generation !== hoverFrameGeneration) return;
            hoverFrame = undefined;
            if (discardUnavailableHoverGesture() || !hoverPointDirty || !screen.pointerKnown
                || !screen.hotkeyPressed || screen.otherKeyPressed || !matchesPressed(getConfiguredMouseShortcut().parts)) return;
            dispatchContinuousHover();
        });
    };

    rootDocument.addEventListener('mousemove', event => {
        if (!event.isTrusted) return;
        if (signal.aborted) return;
        noteExternalHostGesture(event);
        rememberMousePosition(event);
        // 完全空闲时仅记录位置与宿主交互；已有手势或待工作才需要读取页面/配置状态并执行取消。
        if (!hasHoverGestureOrWork()) return;
        if (discardUnavailableHoverGesture()) return;
        if (longPressTimer !== undefined
            && (Math.abs(event.clientX - longPressStart.x) > 10 || Math.abs(event.clientY - longPressStart.y) > 10)) {
            cancelLongPress();
        }
        // 额外按键已取消的手势保持作废，释放组合键的一部分也不能再启动新任务。
        // hasSlideTranslation 仍保留至完整释放，避免把连续移动的结尾误当成单次切换。
        if (screen.hotkeyPressed && !screen.otherKeyPressed && matchesPressed(getConfiguredMouseShortcut().parts)) {
            screen.hasSlideTranslation = true;
            // 连续移动与延迟是两个独立维度。0ms 只是立即响应，不能退化成
            // “再次命中已译句子就恢复原文”的单次切换手势。
            hoverPointDirty = screen.mouseX !== lastHoverX || screen.mouseY !== lastHoverY;
            if (!hoverPointDirty) return;
            if (hoverFrame === undefined) dispatchContinuousHover();
        }
    }, { signal, capture: true, passive: true });

    rootDocument.addEventListener('touchstart', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
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

        if (coordinate) invokeTranslation(coordinate.x, coordinate.y);
    }, { signal, capture: true, passive: true });

    rootDocument.addEventListener('dblclick', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        if (deps.config.hotkey === deps.constants.DoubleClick && deps.config.on) {
            invokeTranslation(event.clientX, event.clientY);
        }
    }, { signal, passive: true });

    rootDocument.addEventListener('mouseup', event => {
        if (!event.isTrusted) return;
        cancelLongPress();
    }, { signal });

    rootDocument.addEventListener('mousedown', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        if (deps.config.hotkey === deps.constants.LongPress && event.button === 0) {
            cancelLongPress();
            longPressStart.x = event.clientX;
            longPressStart.y = event.clientY;
            longPressTimer = setTimeout(() => {
                longPressTimer = undefined;
                if (!discardUnavailableHoverGesture() && deps.config.hotkey === deps.constants.LongPress) {
                    invokeTranslation(event.clientX, event.clientY);
                }
            }, 500);
        }
    }, { signal });

    rootDocument.addEventListener('mousedown', event => {
        if (!event.isTrusted) return;
        if (discardUnavailableHoverGesture()) return;
        if (deps.config.hotkey === deps.constants.MiddleClick && deps.config.on && event.button === 1) {
            invokeTranslation(event.clientX, event.clientY);
        }
    }, { signal });

    rootDocument.addEventListener('touchstart', event => {
        if (!event.isTrusted) return;
        const hotkey = deps.config.hotkey || '';
        if (discardUnavailableHoverGesture() ||
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
            invokeTranslation(event.touches[0].clientX, event.touches[0].clientY);
        }
    }, { signal, passive: true });

    const getGestureConfig = () => [deps.config.on, deps.config.hotkey, deps.config.customHotkey,
        deps.config.mouseHoverTranslationDelay, deps.isSiteDisabled()] as const;
    let gestureConfig = getGestureConfig();
    const unsubscribeConfig = deps.subscribeConfig?.(() => {
        const current = getGestureConfig();
        if (current.every((value, index) => value === gestureConfig[index])) return;
        gestureConfig = current;
        cancelAndResetHoverHotkeyState();
    });
    signal.addEventListener('abort', () => {
        invalidatePointerGesture();
        unsubscribeConfig?.();
    }, { once: true });
    return cancelAndResetHoverHotkeyState;
}
