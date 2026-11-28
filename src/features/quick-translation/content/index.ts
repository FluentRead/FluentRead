/**
 * @file src/features/quick-translation/content/index.ts
 * 文件职责：识别额外快捷翻译方案的可信键鼠手势，并把命中的完整方案转交给注入的悬停、全文或局部容器选择执行器。
 * 主要内容：监听 capture 阶段的 keydown/keyup，冻结单次悬停方案并在执行前复验，按绘制帧合并可信鼠标坐标；处理划词优先、额外按键以及路由切换、页面隐藏、失焦和指针离开时的生命周期清理。
 * 模块边界：本模块不读取配置 store、不解析服务模型、不发起翻译；配置快照、站点资格和翻译执行器都由 content composition root 注入。
 */
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation';
import {
    matchesConfiguredHotkey,
    normalizeHotkeyEventKey,
    parseHotkey,
    resolveConfiguredHotkey,
} from '@/src/core/hotkey';

export interface QuickTranslationContentConfig {
    on?: boolean;
    quickTranslationProfiles: readonly QuickTranslationProfile[];
    mouseHoverTranslationDelay?: number;
}

export interface QuickTranslationContentDependencies {
    config: QuickTranslationContentConfig;
    window: Window;
    document: Document;
    isSiteDisabled: () => boolean;
    isProfileAvailable: (profile: QuickTranslationProfile) => boolean;
    shouldReserveSelectionShortcut: (event: KeyboardEvent) => boolean;
    getConfiguredSelectionHotkey: () => string;
    getCustomSelectionHotkey: () => string | undefined;
    hasActiveSelectionTranslationCandidate: () => boolean;
    resetLegacyKeyboardGestures: () => void;
    cancelPendingHoverTranslation: () => void;
    runHover: (
        profile: QuickTranslationProfile,
        mouseX: number,
        mouseY: number,
        invocation?: {delayMs?: number; continuous?: boolean},
    ) => void | Promise<void>;
    runFullPage: (profile: QuickTranslationProfile) => void | Promise<void>;
    runSection: (profile: QuickTranslationProfile) => void;
    isEditing: (event: KeyboardEvent) => boolean;
}

interface ActiveHoverGesture {
    profile: QuickTranslationProfile;
    identity: string;
    keys: ReadonlySet<string>;
    moved: boolean;
    conflictsWithSelectionShortcut: boolean;
}

const selectionModifierKeys: Readonly<Record<string, string>> = {
    Control: 'ctrl',
    Alt: 'alt',
    Shift: 'shift',
};

function addPressedKeys(
    event: KeyboardEvent,
    pressedKeys: Set<string>,
    pressedKeyByCode: Map<string, string>,
): void {
    if (event.ctrlKey) pressedKeys.add('ctrl');
    if (event.altKey) pressedKeys.add('alt');
    if (event.shiftKey) pressedKeys.add('shift');
    if (event.metaKey) pressedKeys.add('meta');
    const key = normalizeHotkeyEventKey(event);
    if (key) {
        pressedKeys.add(key);
        if (event.code) pressedKeyByCode.set(event.code, key);
    }
}

function removeReleasedKey(
    event: KeyboardEvent,
    pressedKeys: Set<string>,
    pressedKeyByCode: Map<string, string>,
): string {
    const key = (event.code && pressedKeyByCode.get(event.code)) || normalizeHotkeyEventKey(event);
    if (key) pressedKeys.delete(key);
    if (event.code) pressedKeyByCode.delete(event.code);
    if (!event.ctrlKey) pressedKeys.delete('ctrl');
    if (!event.altKey) pressedKeys.delete('alt');
    if (!event.shiftKey) pressedKeys.delete('shift');
    if (!event.metaKey) pressedKeys.delete('meta');
    return key;
}

const parsedHotkeyKeysCache = new Map<string, ReadonlySet<string> | null>();

function getExpectedHotkeyKeys(hotkey: string): ReadonlySet<string> | null {
    const cached = parsedHotkeyKeysCache.get(hotkey);
    if (cached !== undefined) return cached;
    const parsed = parseHotkey(hotkey);
    const result = parsed.isValid ? new Set([...parsed.modifiers, parsed.key]) : null;
    if (parsedHotkeyKeysCache.size >= 128) parsedHotkeyKeysCache.clear();
    parsedHotkeyKeysCache.set(hotkey, result);
    return result;
}

function pressedKeysExactlyMatchHotkey(pressedKeys: ReadonlySet<string>, hotkey: string): boolean {
    const expectedKeys = getExpectedHotkeyKeys(hotkey);
    if (!expectedKeys || expectedKeys.size !== pressedKeys.size) return false;
    for (const key of expectedKeys) {
        if (!pressedKeys.has(key)) return false;
    }
    return true;
}

function configuredSelectionModifier(
    configuredHotkey: string,
    customHotkey: string | undefined,
): string {
    const resolved = resolveConfiguredHotkey(configuredHotkey, customHotkey);
    return selectionModifierKeys[resolved] ?? '';
}

function configuredSelectionPrimaryKey(
    configuredHotkey: string,
    customHotkey: string | undefined,
): string {
    const parsed = parseHotkey(resolveConfiguredHotkey(configuredHotkey, customHotkey));
    return parsed.isValid ? parsed.key : '';
}

function profileIdentity(profile: QuickTranslationProfile): string {
    return JSON.stringify([profile.id, profile.enabled, profile.action, profile.hotkey,
        profile.service, profile.model, profile.targetLanguage, profile.displayMode, profile.fullPageMode, profile.glossaryIds]);
}

function enabledProfiles(config: QuickTranslationContentConfig): readonly QuickTranslationProfile[] {
    return config.quickTranslationProfiles.filter((profile) => profile.enabled && Boolean(profile.hotkey));
}

function claimKeyboardEvent(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
}

/**
 * 挂载额外快捷翻译手势。依赖中的 config 保持引用语义，因此设置层原位更新配置时，
 * 下一次 keydown 会直接读取最新的启用状态和方案顺序。
 */
export function mountQuickTranslationContentFeature(
    deps: QuickTranslationContentDependencies,
    signal: AbortSignal,
): void {
    let activeHover: ActiveHoverGesture | null = null;
    let claimedHotkey = '';
    let suppressedSelectionPrefixGesture = false;
    let selectionShortcutReserved = false;
    let mouseX = 0;
    let mouseY = 0;
    // 键盘不会携带坐标，首次触发必须等待可信指针样本，而不能命中默认 (0,0)。
    let pointerPositionKnown = false;
    const pressedKeys = new Set<string>();
    const pressedKeyByCode = new Map<string, string>();
    let hoverFrame: number | undefined;
    let hoverPointDirty = false;
    let hoverFrameGeneration = 0;
    let lastHoverX: number | undefined;
    let lastHoverY: number | undefined;
    const cancelHoverFrame = () => {
        if (hoverFrame !== undefined) deps.window.cancelAnimationFrame(hoverFrame);
        hoverFrame = undefined;
        hoverPointDirty = false;
        hoverFrameGeneration += 1;
    };

    const isAvailable = () => deps.config.on !== false && !deps.isSiteDisabled();
    const clearActiveHover = (cancelPending: boolean) => {
        cancelHoverFrame();
        lastHoverX = lastHoverY = undefined;
        activeHover = null;
        if (cancelPending) deps.cancelPendingHoverTranslation();
    };

    const hoverIsCurrent = (gesture: ActiveHoverGesture): boolean => {
        const current = deps.config.quickTranslationProfiles.find(profile => profile.id === gesture.profile.id);
        return Boolean(current && current.enabled && deps.isProfileAvailable(current)
            && profileIdentity(current) === gesture.identity);
    };
    const dispatchContinuousHover = (gesture: ActiveHoverGesture) => {
        if (!isAvailable() || !hoverIsCurrent(gesture)
            || (gesture.conflictsWithSelectionShortcut && deps.hasActiveSelectionTranslationCandidate())) {
            clearActiveHover(true);
            return;
        }
        hoverPointDirty = false;
        lastHoverX = mouseX;
        lastHoverY = mouseY;
        const generation = hoverFrameGeneration;
        void deps.runHover(gesture.profile, mouseX, mouseY,
            {delayMs: deps.config.mouseHoverTranslationDelay, continuous: true});
        if (generation !== hoverFrameGeneration) return;
        hoverFrame = deps.window.requestAnimationFrame(() => {
            if (generation !== hoverFrameGeneration) return;
            hoverFrame = undefined;
            if (hoverPointDirty) dispatchContinuousHover(gesture);
        });
    };

    const onKeydown = (event: KeyboardEvent) => {
        if (signal.aborted || !event.isTrusted) return;
        if (event.isComposing || event.keyCode === 229) {
            cancelGestureAndPressedKeys();
            return;
        }
        if (suppressedSelectionPrefixGesture) {
            deps.resetLegacyKeyboardGestures();
            claimKeyboardEvent(event);
            if (!event.repeat) addPressedKeys(event, pressedKeys, pressedKeyByCode);
            return;
        }
        if (claimedHotkey) {
            claimKeyboardEvent(event);
            if (!event.repeat) {
                addPressedKeys(event, pressedKeys, pressedKeyByCode);
                clearActiveHover(true);
            }
            return;
        }
        if (event.repeat) return;
        if (!isAvailable()) {
            pressedKeys.clear();
            pressedKeyByCode.clear();
            selectionShortcutReserved = false;
            return;
        }

        addPressedKeys(event, pressedKeys, pressedKeyByCode);
        const reservedByCurrentEvent = deps.shouldReserveSelectionShortcut(event);
        if (reservedByCurrentEvent) selectionShortcutReserved = true;

        const profile = enabledProfiles(deps.config).find((candidate) => deps.isProfileAvailable(candidate)
            && (
            pressedKeysExactlyMatchHotkey(pressedKeys, candidate.hotkey)
            && matchesConfiguredHotkey(event, candidate.hotkey)
            && ((candidate.action !== 'section' && candidate.action !== 'hover') || !deps.isEditing(event))
        ));
        if (!profile) return;

        const selectionModifierPressed = pressedKeys.has(configuredSelectionModifier(
            deps.getConfiguredSelectionHotkey(),
            deps.getCustomSelectionHotkey(),
        ));
        if (selectionModifierPressed) {
            selectionShortcutReserved = deps.hasActiveSelectionTranslationCandidate();
        }

        // shouldReserveSelectionShortcut 是现有划词运行时的最终资格判断；只有它确认
        // 当前事件和有效选区都应由划词消费时，才把事件完整留给既有划词监听器。
        if (selectionShortcutReserved) {
            activeHover = null;
            if (!reservedByCurrentEvent) {
                deps.resetLegacyKeyboardGestures();
                claimKeyboardEvent(event);
                suppressedSelectionPrefixGesture = true;
            }
            return;
        }

        deps.resetLegacyKeyboardGestures();
        claimKeyboardEvent(event);
        claimedHotkey = profile.hotkey;
        if (profile.action === 'full-page') {
            void deps.runFullPage(profile);
            return;
        }
        if (profile.action === 'section') {
            deps.cancelPendingHoverTranslation();
            deps.runSection(profile);
            return;
        }

        activeHover = {
            profile: {...profile, ...(Array.isArray(profile.glossaryIds) ? {glossaryIds: [...profile.glossaryIds]} : {})},
            identity: profileIdentity(profile),
            keys: new Set(pressedKeys),
            moved: false,
            conflictsWithSelectionShortcut: matchesConfiguredHotkey(
                event,
                deps.getConfiguredSelectionHotkey(),
                deps.getCustomSelectionHotkey() ?? '',
            ),
        };
    };

    const onKeyup = (event: KeyboardEvent) => {
        if (signal.aborted || !event.isTrusted) return;
        if (event.isComposing || event.keyCode === 229) {
            cancelGestureAndPressedKeys();
            return;
        }
        const releasedKey = removeReleasedKey(event, pressedKeys, pressedKeyByCode);
        if (suppressedSelectionPrefixGesture) {
            const selectionModifier = configuredSelectionModifier(
                deps.getConfiguredSelectionHotkey(),
                deps.getCustomSelectionHotkey(),
            );
            if (releasedKey !== selectionModifier) claimKeyboardEvent(event);
            if (pressedKeys.size === 0) {
                suppressedSelectionPrefixGesture = false;
                selectionShortcutReserved = false;
            }
            return;
        }
        if (!claimedHotkey) {
            if (selectionShortcutReserved && !configuredSelectionModifier(
                deps.getConfiguredSelectionHotkey(), deps.getCustomSelectionHotkey(),
            )) {
                const selectionKey = configuredSelectionPrimaryKey(
                    deps.getConfiguredSelectionHotkey(), deps.getCustomSelectionHotkey(),
                );
                if (selectionKey === releasedKey) selectionShortcutReserved = false;
            }
            if (pressedKeys.size === 0) selectionShortcutReserved = false;
            return;
        }
        claimKeyboardEvent(event);
        if (!isAvailable()) {
            clearActiveHover(true);
            if (pressedKeys.size === 0) {
                claimedHotkey = '';
                selectionShortcutReserved = false;
            }
            return;
        }
        if (activeHover && !hoverIsCurrent(activeHover)) clearActiveHover(true);
        if (activeHover && activeHover.keys.has(releasedKey)) {
            const gesture = activeHover;
            // 松键时提交本帧尚未采样的末点，并留下已派发的候选停留计时。
            if (gesture.moved && hoverPointDirty) dispatchContinuousHover(gesture);
            clearActiveHover(false);
            if (!gesture.moved) {
                if (gesture.conflictsWithSelectionShortcut
                    && deps.hasActiveSelectionTranslationCandidate()) {
                    deps.cancelPendingHoverTranslation();
                } else if (pointerPositionKnown) {
                    void deps.runHover(gesture.profile, mouseX, mouseY);
                }
            }
        }
        if (pressedKeys.size === 0) {
            claimedHotkey = '';
            selectionShortcutReserved = false;
        }
    };

    const onMousemove = (event: MouseEvent) => {
        if (signal.aborted || !event.isTrusted) return;
        mouseX = event.clientX;
        mouseY = event.clientY;
        pointerPositionKnown = true;
        if (!activeHover) return;
        if (!isAvailable() || !hoverIsCurrent(activeHover)) {
            clearActiveHover(true);
            return;
        }
        if (activeHover.conflictsWithSelectionShortcut
            && deps.hasActiveSelectionTranslationCandidate()) {
            clearActiveHover(true);
            return;
        }

        activeHover.moved = true;
        hoverPointDirty = mouseX !== lastHoverX || mouseY !== lastHoverY;
        if (hoverPointDirty && hoverFrame === undefined) dispatchContinuousHover(activeHover);
    };

    const cancelGesture = () => clearActiveHover(true);
    const onSelectionchange = () => {
        if (signal.aborted) return;
        const selectionModifierPressed = pressedKeys.has(configuredSelectionModifier(
            deps.getConfiguredSelectionHotkey(),
            deps.getCustomSelectionHotkey(),
        ));
        const activeHoverConflicts = activeHover?.conflictsWithSelectionShortcut === true;
        if (!selectionModifierPressed && !activeHoverConflicts) return;
        const hasCandidate = deps.hasActiveSelectionTranslationCandidate();
        if (selectionModifierPressed) selectionShortcutReserved = hasCandidate;
        if (!hasCandidate) return;
        cancelGesture();
    };
    const cancelGestureAndPressedKeys = () => {
        pressedKeys.clear();
        pressedKeyByCode.clear();
        claimedHotkey = '';
        suppressedSelectionPrefixGesture = false;
        selectionShortcutReserved = false;
        cancelGesture();
    };
    const onBlur = () => {
        if (signal.aborted) return;
        pointerPositionKnown = false;
        cancelGestureAndPressedKeys();
    };
    const onRouteChange = () => {
        if (signal.aborted) return;
        pointerPositionKnown = false;
        cancelGestureAndPressedKeys();
    };
    const onVisibilitychange = () => {if (deps.document.visibilityState === 'hidden') onRouteChange();};
    const onMouseout = (event: MouseEvent) => {if (event.isTrusted && event.relatedTarget === null) onRouteChange();};
    const onMouseover = (event: MouseEvent) => {
        if (signal.aborted || !event.isTrusted) return;
        mouseX = event.clientX;
        mouseY = event.clientY;
        pointerPositionKnown = true;
    };
    const onPointerdown = (event: PointerEvent) => {
        if (signal.aborted || !event.isTrusted) return;
        cancelGesture();
    };

    const onCompositionstart = () => {
        if (signal.aborted) return;
        cancelGestureAndPressedKeys();
    };

    if (signal.aborted) {
        cancelGestureAndPressedKeys();
        return;
    }

    deps.window.addEventListener('keydown', onKeydown, {capture: true, signal});
    deps.window.addEventListener('keyup', onKeyup, {capture: true, signal});
    deps.window.addEventListener('blur', onBlur, {signal});
    deps.document.addEventListener('compositionstart', onCompositionstart, {capture: true, signal});
    deps.document.addEventListener('mousemove', onMousemove, {passive: true, signal});
    deps.document.addEventListener('selectionchange', onSelectionchange, {signal});
    deps.document.addEventListener('pointerdown', onPointerdown, {capture: true, signal});
    deps.document.addEventListener('fluentread-route-change', onRouteChange, {signal});
    deps.document.addEventListener('visibilitychange', onVisibilitychange, {signal});
    deps.document.addEventListener('mouseout', onMouseout, {signal});
    deps.document.addEventListener('mouseover', onMouseover, {signal});
    signal.addEventListener('abort', cancelGestureAndPressedKeys, {once: true});
}
