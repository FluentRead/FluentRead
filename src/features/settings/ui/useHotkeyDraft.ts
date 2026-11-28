/**
 * @file src/features/settings/ui/useHotkeyDraft.ts
 * 文件职责：管理段落复制、局部翻译、圈选与输入框翻译快捷键录制的配置归属和组件生命周期。
 * 主要内容：录制保留已保存的入口，按配置对象、两个字段、功能上下文及激活状态验证草稿；隐藏、缓存停用、卸载或外部变更时关闭，确认先释放草稿再提交。
 * 模块边界：只管理 Vue 草稿和所属配置字段，不解析按键、不决定默认键或冲突、不持久化配置；这些策略与反馈由调用组件负责。
 */
import {computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import type {Config} from '@/src/core/config/model';

type HotkeyFields =
    | {mode: 'inputBoxTranslationTrigger'; custom: 'customInputBoxTranslationHotkey'}
    | {mode: 'paragraphCopyHotkey'; custom: 'customParagraphCopyHotkey'}
    | {mode: 'sectionTranslationHotkey'; custom: 'customSectionTranslationHotkey'}
    | {mode: 'selectionAreaHotkey'; custom: 'customSelectionAreaHotkey'}
    | {mode: 'videoSubtitleModeHotkey'; custom: 'customVideoSubtitleModeHotkey'}
    | {mode: 'commandPaletteHotkey'; custom: 'customCommandPaletteHotkey'};

export function useHotkeyDraft(getConfig: () => Config, fields: HotkeyFields, getAvailable: () => boolean, getContext?: () => boolean) {
    const showCustomHotkeyDialog = ref(false);
    const viewActive = ref(true);
    const active = computed(() => viewActive.value && getAvailable());
    let draft: {config: Config; mode: string; custom: string; context: boolean | undefined} | null = null;

    function isCurrentDraft(): boolean {
        const config = getConfig();
        return active.value && showCustomHotkeyDialog.value && draft !== null && draft.config === config
            && draft.mode === config[fields.mode] && draft.custom === config[fields.custom] && draft.context === getContext?.();
    }
    function closeCustomHotkeyDialog(): void {
        draft = null;
        showCustomHotkeyDialog.value = false;
    }
    function openCustomHotkeyDialog(): void {
        if (!active.value || isCurrentDraft()) return;
        const config = getConfig();
        draft = {config, mode: config[fields.mode], custom: config[fields.custom], context: getContext?.()};
        showCustomHotkeyDialog.value = true;
    }
    function commitHotkeyDraft(mode: string, custom: string): boolean {
        if (!isCurrentDraft()) {closeCustomHotkeyDialog();return false;}
        const config = draft!.config;
        closeCustomHotkeyDialog();
        config[fields.custom] = custom;
        config[fields.mode] = mode;
        return true;
    }
    watch(() => [active.value, getConfig(), getConfig()[fields.mode], getConfig()[fields.custom], getContext?.()], () => {
        if (draft && !isCurrentDraft()) closeCustomHotkeyDialog();
    });
    onActivated(() => {viewActive.value = true;});
    onDeactivated(() => {viewActive.value = false;closeCustomHotkeyDialog();});
    onBeforeUnmount(() => {viewActive.value = false;closeCustomHotkeyDialog();});
    return {active, showCustomHotkeyDialog, isCurrentDraft, openCustomHotkeyDialog, closeCustomHotkeyDialog, commitHotkeyDraft};
}
