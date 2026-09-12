/**
 * @file src/app/content/hotkeyRuntime.ts
 * 文件职责：在宿主页面统一接管 FluentRead 的键盘与鼠标快捷手势，并按配置、站点禁用状态和冲突优先级路由到相应翻译动作。
 * 主要内容：规范化特殊按键，监听 keydown/keyup、pointer 与 touch 状态，匹配悬浮、全文、划词、翻译卡片和区域快捷键，以纯中文选区过滤和保守同语言预检处理选择文本占用与默认行为阻止，并提供 dispose 清理监听器。
 * 模块边界：这里判定并分派手势，不实现语言检测算法、翻译请求、UI 挂载或配置持久化；具体动作由注入/导入的 feature 公共函数完成。
 */
import {config} from '@/src/services/config/store';
import {shouldSkipChineseSelection, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {matchesConfiguredHotkey, shouldClaimConfiguredHotkey} from '@/src/core/hotkey';
import {
    autoTranslateEnglishPage,
    isFullPageTranslationActive,
    readSelectionText,
    restoreOriginalContent,
    shouldIgnoreSelection,
} from './features';

const SPECIAL_KEYS: Readonly<Record<string, string>> = {
    escape: 'escape',
    enter: 'enter',
    space: 'space',
    tab: 'tab',
    backspace: 'backspace',
    delete: 'delete',
    arrowup: 'arrowup',
    arrowdown: 'arrowdown',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
    home: 'home',
    end: 'end',
    pageup: 'pageup',
    pagedown: 'pagedown',
    insert: 'insert',
};

export interface ContentHotkeyRuntime {
    getConfiguredSelectionHotkey(): string;
    hasActiveSelectionTranslationCandidate(): boolean;
    matchesSelectionTranslatorShortcut(event: KeyboardEvent): boolean;
    shouldReserveSelectionShortcut(event: KeyboardEvent): boolean;
    installFloatingBallHotkey(signal: AbortSignal): () => void;
}

/** 为单个 document 创建隔离的键盘状态，避免页面失效后残留按键组合。 */
export function createContentHotkeyRuntime(isSiteDisabled: () => boolean,
    options: {toggleFullPage?: () => void; selectionAvailable?: boolean} = {}): ContentHotkeyRuntime {
    const activeSelectionCandidateByEvent = new WeakMap<KeyboardEvent, boolean>();
    const isSelectionTranslatorEnabled = (): boolean => options.selectionAvailable !== false && !isSiteDisabled() && config.on && config.selectionTranslatorMode !== 'disabled' && config.disableSelectionTranslator !== true;

    const getConfiguredSelectionHotkey = (): string => {
        if (!isSelectionTranslatorEnabled()) return 'none';
        const trigger = config.selectionTranslatorTrigger;
        return ['Control', 'Alt', 'Shift', 'custom'].includes(trigger) ? trigger : 'none';
    };

    const isReadingShortcut = (event: KeyboardEvent): boolean => options.selectionAvailable !== false
        && !isSiteDisabled() && config.on && config.harness?.enabled && config.harness.trigger === 'shortcut'
        && matchesConfiguredHotkey(event, 'custom', config.harness.customHotkey);

    const hasActiveSelectionTranslationCandidate = (reading = false): boolean => {
        if (!reading && !isSelectionTranslatorEnabled()) return false;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
        const selectionHost = document.getElementById('fluent-read-selection-translator-container');
        if (selectionHost && selection.containsNode(selectionHost, true)) return false;

        const range = selection.getRangeAt(0);
        const text = readSelectionText(range, selection.toString());
        if (!text || text.length > 4096 || shouldSkipChineseSelection(text, config.to)
            || (!reading && shouldSkipTranslationForTarget(text, config.to))) return false;

        if (shouldIgnoreSelection(range)) return false;
        if (Array.from(range.getClientRects()).some((rect) => rect.width > 0 || rect.height > 0)) return true;
        const bounds = range.getBoundingClientRect();
        return bounds.width > 0 || bounds.height > 0;
    };

    const shouldReserveSelectionShortcut = (event: KeyboardEvent): boolean => {
        if (isReadingShortcut(event)) return hasActiveSelectionTranslationCandidate(true);
        if (!isSelectionTranslatorEnabled()) return false;
        return shouldClaimConfiguredHotkey(
            event,
            getConfiguredSelectionHotkey(),
            config.customSelectionTranslatorHotkey,
            () => {
                const cached = activeSelectionCandidateByEvent.get(event);
                if (cached !== undefined) return cached;
                const candidate = hasActiveSelectionTranslationCandidate();
                activeSelectionCandidateByEvent.set(event, candidate);
                return candidate;
            },
        );
    };

    const matchesSelectionTranslatorShortcut = (event: KeyboardEvent): boolean => isReadingShortcut(event)
        || (isSelectionTranslatorEnabled() && matchesConfiguredHotkey(event, getConfiguredSelectionHotkey(), config.customSelectionTranslatorHotkey));

    const toggleFullPageTranslation = options.toggleFullPage ?? (() => {
        // 快捷键必须读取全文会话真值，不能把悬浮球组件的局部状态当成另一份真源。
        // 否则快捷键触发后，右键菜单和 Popup 仍可能认为页面未翻译并再次启动会话。
        if (isFullPageTranslationActive()) restoreOriginalContent();
        else autoTranslateEnglishPage();
    });

    const installFloatingBallHotkey = (signal: AbortSignal): (() => void) => {
        const hotkeysPressed = new Set<string>();
        let pendingFullPageToggle = false;
        const resetKeyboardGesture = () => { pendingFullPageToggle = false; hotkeysPressed.clear(); };
        const isDev = process.env.NODE_ENV === 'development';
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

        const configuredParts = (): string[] => {
            const configured = config.floatingBallHotkey === 'custom'
                ? config.customFloatingBallHotkey
                : config.floatingBallHotkey;
            if (!configured || configured === 'none') return [];
            return configured.split('+').map((key) => {
                const normalized = key.toLowerCase();
                if (normalized === 'ctrl') return 'control';
                if (normalized === 'option') return 'alt';
                return normalized;
            });
        };

        const addEventKey = (event: KeyboardEvent): void => {
            const key = event.key.toLowerCase();
            const code = event.code?.toLowerCase();
            if (code?.startsWith('key')) hotkeysPressed.add(code.slice(3).toLowerCase());
            else if (key.length === 1 || /^f\d+$/.test(key)) hotkeysPressed.add(key);
            else if (SPECIAL_KEYS[key]) hotkeysPressed.add(SPECIAL_KEYS[key]);
        };

        const removeEventKey = (event: KeyboardEvent): void => {
            const key = event.key.toLowerCase();
            const code = event.code?.toLowerCase();
            if (code?.startsWith('key')) hotkeysPressed.delete(code.slice(3).toLowerCase());
            else if (key.length === 1 || /^f\d+$/.test(key)) hotkeysPressed.delete(key);
            else if (SPECIAL_KEYS[key]) hotkeysPressed.delete(SPECIAL_KEYS[key]);
        };

        if (isDev) {
            console.log(`[FluentRead] 设置悬浮球快捷键: ${config.floatingBallHotkey}, 系统: ${isMac ? 'macOS' : '其他'}`);
        }

        document.addEventListener('keydown', (event) => {
            if (!event.isTrusted) return;
            if (isSiteDisabled() || event.repeat || (isMac && event.metaKey)) return;

            // 划词与全文快捷键冲突时，有有效选区的划词翻译拥有本次按键。
            if (shouldReserveSelectionShortcut(event)) {
                pendingFullPageToggle = false;
                hotkeysPressed.clear();
                return;
            }

            if (event.altKey) hotkeysPressed.add('alt');
            if (event.ctrlKey) hotkeysPressed.add('control');
            if (event.metaKey && !isMac) hotkeysPressed.add('control');
            if (event.shiftKey) hotkeysPressed.add('shift');
            addEventKey(event);

            const parts = configuredParts();
            if (parts.length === 0
                || !parts.every((key) => hotkeysPressed.has(key))
                || parts.length !== hotkeysPressed.size
                || !config.on) return;

            event.preventDefault();
            event.stopPropagation();
            if (matchesSelectionTranslatorShortcut(event)) {
                pendingFullPageToggle = !matchesConfiguredHotkey(event, config.hotkey, config.customHotkey);
                return;
            }

            toggleFullPageTranslation();
            if (isDev) {
                const activeHotkey = config.floatingBallHotkey === 'custom'
                    ? config.customFloatingBallHotkey
                    : config.floatingBallHotkey;
                console.log(`[FluentRead] 触发悬浮球翻译，快捷键: ${activeHotkey}`);
            }
        }, {signal, capture: true});

        document.addEventListener('keyup', (event) => {
            if (!event.isTrusted) return;
            if (isSiteDisabled()) return;
            if (pendingFullPageToggle) {
                pendingFullPageToggle = false;
                if (config.on && !hasActiveSelectionTranslationCandidate()) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleFullPageTranslation();
                }
            }
            removeEventKey(event);
            if (!event.altKey) hotkeysPressed.delete('alt');
            if (!event.ctrlKey) hotkeysPressed.delete('control');
            if (!event.metaKey) hotkeysPressed.delete('control');
            if (!event.shiftKey) hotkeysPressed.delete('shift');
        }, {signal, capture: true});

        window.addEventListener('blur', resetKeyboardGesture, {signal});
        signal.addEventListener('abort', resetKeyboardGesture, {once: true});
        return resetKeyboardGesture;
    };

    return {
        getConfiguredSelectionHotkey,
        hasActiveSelectionTranslationCandidate,
        matchesSelectionTranslatorShortcut,
        shouldReserveSelectionShortcut,
        installFloatingBallHotkey,
    };
}
