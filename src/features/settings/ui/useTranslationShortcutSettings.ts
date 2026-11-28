/**
 * @file src/features/settings/ui/useTranslationShortcutSettings.ts
 * 文件职责：协调全文、悬浮和划词的快捷键设置草稿、额外快捷方案、点选保留键冲突与录制弹窗生命周期。
 * 主要内容：共用三种快捷键的延迟调度和显示解析；每个草稿保留所属配置及原模式，重复选择只保留一个计时器，换分区、配置替换和作用域卸载及时关闭并恢复仍归本次编辑所有的临时模式，确认时重新校验冲突。
 * 模块边界：只编排 Vue 状态与提示，不保存配置、不注册网页手势、不执行翻译；持久化仍由 SettingsSections 的统一链路负责，按键解析归 core/hotkey。
 */
import {onScopeDispose, ref, watch, type Ref} from 'vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveVideoSubtitleModeHotkey} from '@/src/core/config/videoSubtitleShortcut';
import {resolveWritingHotkey} from '@/src/core/config/writing';
import {resolveCommandPaletteHotkey} from '@/src/core/config/commandPalette';
import {findEnabledQuickTranslationHotkeyConflict, quickTranslationActionKey, inputBoxTranslationTriggerHotkey} from '@/src/core/config/quickTranslation';
import {canonicalizeHotkey, parseHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {useUiI18n} from '@/src/ui/i18n';

const selectionShortcutTriggers = new Set(['Control', 'Alt', 'Shift', 'custom']);
type ShortcutKind = 'page' | 'hover' | 'selection';
const kinds: readonly ShortcutKind[] = ['page', 'hover', 'selection'];

export function useTranslationShortcutSettings(config: Ref<Config>, isActive: (kind: ShortcutKind) => boolean = () => true,
    isApplyingExternalConfig: () => boolean = () => false) {
    const {t, translateLegacy} = useUiI18n();
    const showCustomHotkeyDialog = ref(false);
    const showCustomMouseHotkeyDialog = ref(false);
    const showCustomSelectionHotkeyDialog = ref(false);
    const previousFullPageHotkey = ref<string | null>(null);
    const previousMouseHotkey = ref<string | null>(null);
    const previousSelectionTrigger = ref<string | null>(null);
    const drafts = {
        page: {mode: 'floatingBallHotkey', custom: 'customFloatingBallHotkey', fallback: 'Alt+T', visible: showCustomHotkeyDialog, previous: previousFullPageHotkey},
        hover: {mode: 'hotkey', custom: 'customHotkey', fallback: 'Control', visible: showCustomMouseHotkeyDialog, previous: previousMouseHotkey},
        selection: {mode: 'selectionTranslatorTrigger', custom: 'customSelectionTranslatorHotkey', fallback: 'icon', visible: showCustomSelectionHotkeyDialog, previous: previousSelectionTrigger},
    } as const;
    const owners: Record<ShortcutKind, {config: Config; mode: string; custom: string} | null> = {page: null, hover: null, selection: null};
    const timers: Record<ShortcutKind, ReturnType<typeof setTimeout> | null> = {page: null, hover: null, selection: null};
    let disposed = false;
    const available = (kind: ShortcutKind): boolean => !disposed && isActive(kind);

    function quickTranslationConflictMessage(hotkey: string, excludeInputBox = false): string {
        const canonical = canonicalizeHotkey(hotkey).toLowerCase();
        const reserved = resolveReservedClickSelectionHotkey(config.value);
        if (reserved && canonical === reserved.toLowerCase()) {
            return t('quickTranslation.legacyConflictEdit', {feature: translateLegacy('两点选取')});
        }
        const conflict = findEnabledQuickTranslationHotkeyConflict(config.value.quickTranslationProfiles, hotkey);
        if (conflict) {
            return t('quickTranslation.conflictProfile', {group: t(`quickTranslation.heading.${quickTranslationActionKey(conflict.action)}`)});
        }
        const reservedInput = excludeInputBox
            ? ''
            : inputBoxTranslationTriggerHotkey(
                config.value.inputBoxTranslationTrigger,
                config.value.customInputBoxTranslationHotkey,
            );
        if (reservedInput && canonical === canonicalizeHotkey(reservedInput).toLowerCase()) {
            return t('quickTranslation.legacyConflictEdit', {feature: translateLegacy('输入框翻译')});
        }
        const reservedVideoSubtitle = config.value.videoSubtitleModeHotkeyEnabled
            ? resolveVideoSubtitleModeHotkey(config.value.videoSubtitleModeHotkey, config.value.customVideoSubtitleModeHotkey)
            : '';
        if (reservedVideoSubtitle && canonical === canonicalizeHotkey(reservedVideoSubtitle).toLowerCase()) {
            return t('quickTranslation.legacyConflictEdit', {feature: t('video.modeShortcut.title')});
        }
        const reservedWriting = resolveWritingHotkey(config.value.writing);
        if (reservedWriting && canonical === canonicalizeHotkey(reservedWriting).toLowerCase()) {
            return t('quickTranslation.legacyConflictEdit', {feature: translateLegacy('写作助手')});
        }
        const reservedCommandPalette = config.value.commandPaletteEnabled
            ? resolveCommandPaletteHotkey(config.value.commandPaletteHotkey, config.value.customCommandPaletteHotkey)
            : '';
        if (reservedCommandPalette && canonical === canonicalizeHotkey(reservedCommandPalette).toLowerCase()) {
            return t('quickTranslation.legacyConflictEdit', {feature: t('commandPalette.title')});
        }
        return '';
    }
    function clearTimer(kind: ShortcutKind): void {
        if (timers[kind] !== null) clearTimeout(timers[kind]!);
        timers[kind] = null;
    }
    function setMode(kind: ShortcutKind, value: string): void {
        config.value[drafts[kind].mode] = value;
        if (kind === 'selection') config.value.selectionTranslatorHotkey = selectionShortcutTriggers.has(value) ? value : 'none';
    }
    function closeDraft(kind: ShortcutKind, restore: boolean): void {
        const draft = drafts[kind], owner = owners[kind], previous = draft.previous.value;
        clearTimer(kind);
        draft.visible.value = false;
        draft.previous.value = null;
        owners[kind] = null;
        // 清除归属后再写配置，同步 watcher 不会重复恢复；旧配置和用户的新选择都不能被取消覆盖。
        if (restore && owner?.config === config.value && previous !== null
            && config.value[draft.mode] === 'custom' && !config.value[draft.custom]) setMode(kind, previous);
    }
    function openDialog(kind: ShortcutKind): void {
        if (!available(kind)) return;
        clearTimer(kind);
        const draft = drafts[kind];
        owners[kind] = {config: config.value, mode: config.value[draft.mode], custom: config.value[draft.custom]};
        if (!config.value[draft.custom] && draft.previous.value === null && config.value[draft.mode] === 'custom') {
            draft.previous.value = draft.fallback;
        }
        draft.visible.value = true;
    }
    function changeMode(kind: ShortcutKind, value: string): void {
        if (!available(kind)) return;
        const draft = drafts[kind];
        const hotkey = kind === 'selection'
            ? (value === 'custom' ? config.value[draft.custom] : '')
            : resolveConfiguredHotkey(value, config.value[draft.custom]);
        const conflict = quickTranslationConflictMessage(hotkey);
        if (conflict) {ElMessage.warning(conflict); return;}
        if (value !== 'custom' || config.value[draft.custom]) {
            closeDraft(kind, false);
            setMode(kind, value);
            return;
        }
        if (draft.previous.value === null) {
            draft.previous.value = config.value[draft.mode] === 'custom' ? draft.fallback : config.value[draft.mode];
        }
        // 空的划词自定义值会被持久化规范化为 icon。确认前保留已生效的触发方式，
        // 录制意图只归本地草稿所有，避免保存回声提前关闭弹窗。
        const mode = kind === 'selection' ? draft.previous.value! : value;
        owners[kind] = {config: config.value, mode, custom: config.value[draft.custom]};
        setMode(kind, mode);
        clearTimer(kind);
        timers[kind] = setTimeout(() => {
            timers[kind] = null;
            const owner = owners[kind];
            if (available(kind) && owner?.config === config.value
                && config.value[draft.mode] === owner.mode && !config.value[draft.custom]) openDialog(kind);
        }, 100);
    }
    function displayName(kind: ShortcutKind): string {
        const value = config.value[drafts[kind].custom];
        if (!value) return '';
        if (value === 'none') return translateLegacy('已禁用');
        const parsed = parseHotkey(value);
        return parsed.isValid ? parsed.displayName : value;
    }
    function confirm(kind: ShortcutKind, hotkey: string): void {
        if (!available(kind) || owners[kind]?.config !== config.value || quickTranslationConflictMessage(hotkey)) return;
        config.value[drafts[kind].custom] = hotkey === 'none' ? '' : hotkey;
        setMode(kind, hotkey === 'none' ? (kind === 'selection' ? 'icon' : 'none') : 'custom');
        closeDraft(kind, false);
        ElMessage({message: hotkey === 'none'
            ? t(kind === 'selection' ? 'quickTranslation.selectionShortcutDisabled' : 'quickTranslation.shortcutDisabled')
            : t(kind === 'selection' ? 'quickTranslation.selectionShortcutSet' : 'quickTranslation.shortcutSet', {shortcut: displayName(kind)}),
        type: 'success', duration: 2000});
    }
    // 只观察模式、录制值、配置身份和所在分区；无关设置修改不重新调度录制弹窗。
    watch(() => [config.value, config.value.floatingBallHotkey, config.value.customFloatingBallHotkey,
        config.value.hotkey, config.value.customHotkey, config.value.selectionTranslatorTrigger,
        config.value.customSelectionTranslatorHotkey, ...kinds.map(kind => isActive(kind))], () => {
        for (const kind of kinds) {
            const owner = owners[kind];
            if (!owner) continue;
            const draft = drafts[kind];
            if (!available(kind)) closeDraft(kind, true);
            else if (owner.config !== config.value || config.value[draft.mode] !== owner.mode) closeDraft(kind, false);
            else if (isApplyingExternalConfig() && config.value[draft.custom] !== owner.custom) closeDraft(kind, false);
            else if (timers[kind] !== null && config.value[draft.custom]) {
                closeDraft(kind, false);
                // 外部完整快照已经决定触发方式；只把本地等待期间录入的值启用为自定义。
                if (kind === 'selection') setMode(kind, 'custom');
            }
        }
    }, {flush: 'sync'});
    onScopeDispose(() => {disposed = true; for (const kind of kinds) closeDraft(kind, true);});

    function handleInputBoxTranslationTriggerChange(value: string): void {
        if (!available('page')) return;
        const hotkey = inputBoxTranslationTriggerHotkey(value, config.value.customInputBoxTranslationHotkey);
        if (value === 'custom' && !hotkey) return;
        const conflictMessage = hotkey ? quickTranslationConflictMessage(hotkey, true) : '';
        if (conflictMessage) {ElMessage.warning(conflictMessage); return;}
        config.value.inputBoxTranslationTrigger = value;
    }
    const validateCustomFullPageHotkey = (hotkey: string) => quickTranslationConflictMessage(hotkey);
    const validateCustomMouseHotkey = (hotkey: string) => quickTranslationConflictMessage(hotkey);
    const validateCustomSelectionHotkey = (hotkey: string) => quickTranslationConflictMessage(hotkey);
    const handleHotkeyChange = (value: string) => changeMode('page', value);
    const handleMouseHotkeyChange = (value: string) => changeMode('hover', value);
    const handleSelectionTriggerChange = (value: string) => changeMode('selection', value);
    const openCustomHotkeyDialog = () => openDialog('page');
    const openCustomMouseHotkeyDialog = () => openDialog('hover');
    const openCustomSelectionHotkeyDialog = () => openDialog('selection');
    const handleCustomHotkeyCancel = () => closeDraft('page', true);
    const handleCustomMouseHotkeyCancel = () => closeDraft('hover', true);
    const handleCustomSelectionHotkeyCancel = () => closeDraft('selection', true);
    const handleCustomHotkeyConfirm = (hotkey: string) => confirm('page', hotkey);
    const handleCustomMouseHotkeyConfirm = (hotkey: string) => confirm('hover', hotkey);
    const handleCustomSelectionHotkeyConfirm = (hotkey: string) => confirm('selection', hotkey);
    const getCustomHotkeyDisplayName = () => displayName('page');
    const getCustomMouseHotkeyDisplayName = () => displayName('hover');
    const getCustomSelectionHotkeyDisplayName = () => displayName('selection');
    return {getCustomHotkeyDisplayName, getCustomMouseHotkeyDisplayName, getCustomSelectionHotkeyDisplayName,
        handleCustomHotkeyCancel, handleCustomHotkeyConfirm, handleCustomMouseHotkeyCancel, handleCustomMouseHotkeyConfirm,
        handleCustomSelectionHotkeyCancel, handleCustomSelectionHotkeyConfirm, handleHotkeyChange,
        handleInputBoxTranslationTriggerChange, handleMouseHotkeyChange, handleSelectionTriggerChange,
        openCustomHotkeyDialog, openCustomMouseHotkeyDialog, openCustomSelectionHotkeyDialog,
        quickTranslationConflictMessage, showCustomHotkeyDialog, showCustomMouseHotkeyDialog, showCustomSelectionHotkeyDialog,
        validateCustomFullPageHotkey, validateCustomMouseHotkey, validateCustomSelectionHotkey};
}
