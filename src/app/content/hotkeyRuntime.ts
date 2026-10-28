/**
 * @file src/app/content/hotkeyRuntime.ts
 * 文件职责：在宿主页面统一接管 FluentRead 的键盘与鼠标快捷手势，并按配置、站点禁用状态和冲突优先级路由到相应翻译动作。
 * 主要内容：复用 core 记录组合键并仲裁两点选取及划词优先级，将待回退的全文手势绑定主键/code 与全文、划词、悬浮快捷键身份；额外组合、不可用状态、失焦、中止和文档路由变化取消旧手势，同语言选区默认跳过，中英双向划词可保留反向候选。
 * 模块边界：这里判定并分派手势，不实现语言检测算法、翻译请求、UI 挂载或配置持久化；具体动作由注入/导入的 feature 公共函数完成。
 */
import {config} from '@/src/services/config/store';
import {matchesClickSelectionShortcut} from '@/src/core/config/clickSelection';
import {shouldSkipChineseSelection, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {readSelectionText, selectionReverseTarget, shouldIgnoreSelection} from '@/src/features/selection-translation/core';
import {
    addPressedHotkeyEventKey,
    canonicalizeHotkey,
    deletePressedHotkeyEventKey,
    matchesConfiguredHotkey,
    normalizeHotkeyEventKey,
    parseHotkey,
    resolveConfiguredHotkey,
    shouldClaimConfiguredHotkey,
} from '@/src/core/hotkey';
import {
    autoTranslateEnglishPage,
    isFullPageTranslationActive,
    restoreOriginalContent,
} from '@/src/features/full-page-translation/public';

/** 悬浮、快捷翻译与邮件 frame 共享的划词快捷键仲裁端口，组合根整体注入，避免逐项重复接线。 */
export interface SelectionShortcutPorts {
    getConfiguredSelectionHotkey(): string;
    getCustomSelectionHotkey(): string | undefined;
    hasActiveSelectionTranslationCandidate(): boolean;
    matchesSelectionTranslatorShortcut(event: KeyboardEvent): boolean;
    shouldReserveSelectionShortcut(event: KeyboardEvent): boolean;
}
export interface ContentHotkeyRuntime {readonly selectionShortcutPorts: SelectionShortcutPorts; installFloatingBallHotkey(signal: AbortSignal): () => void}

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

    const hasActiveSelectionTranslationCandidate = (): boolean => {
        if (!isSelectionTranslatorEnabled()) return false;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
        const selectionHost = document.getElementById('fluent-read-selection-translator-container');
        if (selectionHost && selection.containsNode(selectionHost, true)) return false;

        const range = selection.getRangeAt(0);
        const text = readSelectionText(range, selection.toString());
        const canReverse = config.selectionTranslatorBidirectional
            && Boolean(selectionReverseTarget(text, config.to, config.from));
        if (!text || text.length > 4096 || (shouldSkipChineseSelection(text, config.to) && !canReverse)
            || (shouldSkipTranslationForTarget(text, config.to) && !canReverse)) return false;

        if (shouldIgnoreSelection(range)) return false;
        if (Array.from(range.getClientRects()).some((rect) => rect.width > 0 || rect.height > 0)) return true;
        const bounds = range.getBoundingClientRect();
        return bounds.width > 0 || bounds.height > 0;
    };

    const shouldReserveSelectionShortcut = (event: KeyboardEvent): boolean => {
        // 两点选取尚未产生选区，先占有自己的快捷键，防止同轮触发悬浮或全文翻译。
        if (options.selectionAvailable !== false && !isSiteDisabled() && matchesClickSelectionShortcut(event, config)) return true;
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

    const matchesSelectionTranslatorShortcut = (event: KeyboardEvent): boolean => (isSelectionTranslatorEnabled() && matchesConfiguredHotkey(event, getConfiguredSelectionHotkey(), config.customSelectionTranslatorHotkey));

    const toggleFullPageTranslation = options.toggleFullPage ?? (() => {
        // 快捷键必须读取全文会话真值，不能把悬浮球组件的局部状态当成另一份真源。
        // 否则快捷键触发后，右键菜单和 Popup 仍可能认为页面未翻译并再次启动会话。
        if (isFullPageTranslationActive()) restoreOriginalContent();
        else autoTranslateEnglishPage();
    });

    const installFloatingBallHotkey = (signal: AbortSignal): (() => void) => {
        const hotkeysPressed = new Set<string>();
        const hotkeyByCode = new Map<string, string>();
        let pendingFullPageToggle: {key: string; code: string; shortcuts: readonly [string, string, string]} | undefined;
        const resetKeyboardGesture = () => { pendingFullPageToggle = undefined; hotkeysPressed.clear(); hotkeyByCode.clear(); };
        const isDev = process.env.NODE_ENV === 'development';
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

        const configuredParts = (): string[] => {
            const parsed = parseHotkey(resolveConfiguredHotkey(config.floatingBallHotkey, config.customFloatingBallHotkey));
            if (!parsed.isValid) return [];
            return [...parsed.modifiers.map((key) => key === 'ctrl' ? 'control' : key), parsed.key];
        };

        const shortcutIdentity = (configured: string | undefined, custom?: string): string => {
            const resolved = resolveConfiguredHotkey(configured, custom);
            return !resolved || resolved === 'none' ? '' : canonicalizeHotkey(resolved) || resolved;
        };
        const configuredIdentities = (): readonly [string, string, string] => [
            shortcutIdentity(config.floatingBallHotkey, config.customFloatingBallHotkey),
            shortcutIdentity(getConfiguredSelectionHotkey(), config.customSelectionTranslatorHotkey),
            shortcutIdentity(config.hotkey, config.customHotkey),
        ];
        const discardUnavailableGesture = (event: KeyboardEvent): boolean => {
            if (!config.on || isSiteDisabled()
                || event.metaKey || normalizeHotkeyEventKey(event) === 'meta') {
                resetKeyboardGesture();
                return true;
            }
            if (pendingFullPageToggle) {
                const identities = configuredIdentities();
                if (pendingFullPageToggle.shortcuts.some((shortcut, index) => shortcut !== identities[index])) {
                    resetKeyboardGesture();
                    return true;
                }
            }
            return false;
        };

        if (isDev) {
            console.log(`[FluentRead] 设置悬浮球快捷键: ${config.floatingBallHotkey}, 系统: ${isMac ? 'macOS' : '其他'}`);
        }

        document.addEventListener('keydown', (event) => {
            if (!event.isTrusted) return;
            if (discardUnavailableGesture(event) || event.repeat) return;

            // 划词与全文快捷键冲突时，有有效选区的划词翻译拥有本次按键。
            if (shouldReserveSelectionShortcut(event)) {
                resetKeyboardGesture();
                return;
            }

            if (event.altKey) hotkeysPressed.add('alt');
            if (event.ctrlKey) hotkeysPressed.add('control');
            if (event.shiftKey) hotkeysPressed.add('shift');
            addPressedHotkeyEventKey(event, hotkeysPressed, hotkeyByCode);

            const parts = configuredParts();
            if (parts.length === 0
                || !parts.every((key) => hotkeysPressed.has(key))
                || parts.length !== hotkeysPressed.size) {
                // 额外可信非重复按键作废整轮回退，不能让它自己的 keyup 消费主键手势。
                pendingFullPageToggle = undefined;
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            if (matchesSelectionTranslatorShortcut(event)) {
                pendingFullPageToggle = matchesConfiguredHotkey(event, config.hotkey, config.customHotkey)
                    ? undefined
                    : {key: normalizeHotkeyEventKey(event), code: event.code || '', shortcuts: configuredIdentities()};
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
            if (discardUnavailableGesture(event)) return;
            const pending = pendingFullPageToggle;
            // 同一物理主键优先；无 code 时才退回 core 保存/归一化的逻辑键。
            // Shift/Option 先释放会改变 key 和修饰标志，不能重新匹配原组合来消费 pending。
            const releasedKey = (event.code && hotkeyByCode.get(event.code)) || normalizeHotkeyEventKey(event);
            if (pending && (pending.code && event.code ? pending.code === event.code : pending.key === releasedKey)) {
                pendingFullPageToggle = undefined;
                if (!hasActiveSelectionTranslationCandidate()) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleFullPageTranslation();
                }
            }
            deletePressedHotkeyEventKey(event, hotkeysPressed, hotkeyByCode);
            if (!event.altKey) hotkeysPressed.delete('alt');
            if (!event.ctrlKey) hotkeysPressed.delete('control');
            if (!event.shiftKey) hotkeysPressed.delete('shift');
        }, {signal, capture: true});

        document.addEventListener('fluentread-route-change', resetKeyboardGesture, {signal});
        window.addEventListener('blur', resetKeyboardGesture, {signal});
        signal.addEventListener('abort', resetKeyboardGesture, {once: true});
        return resetKeyboardGesture;
    };

    const selectionShortcutPorts: SelectionShortcutPorts = {getConfiguredSelectionHotkey, hasActiveSelectionTranslationCandidate,
        getCustomSelectionHotkey: () => config.customSelectionTranslatorHotkey, matchesSelectionTranslatorShortcut, shouldReserveSelectionShortcut};
    return {selectionShortcutPorts, installFloatingBallHotkey};
}
