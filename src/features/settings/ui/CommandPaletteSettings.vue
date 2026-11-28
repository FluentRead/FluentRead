<!--
 * @file src/features/settings/ui/CommandPaletteSettings.vue
 * 文件职责：在通用设置中提供全局命令面板的开关、预设快捷键、自定义组合键录制及跨功能按键冲突校验。
 * 主要内容：绑定 commandPaletteEnabled、commandPaletteHotkey 与 customCommandPaletteHotkey，复用 useHotkeyDraft 与 CustomHotkeyInput 管理录制草稿与生命周期，校验与悬浮、全文、划词、两点选取、圈选、段落复制、局部翻译、视频字幕模式、智能高亮及快捷翻译方案的按键冲突。
 * 模块边界：只负责配置字段编辑与冲突提示反馈，不持久化存储、不注册内容页键盘监听，也不直接打开命令面板。
-->
<template>
  <SettingsGroup
    :title="t('commandPalette.settings.title')"
    :description="t('commandPalette.settings.description')"
    data-testid="command-palette-settings"
  >
    <SettingsItem
      :label="t('commandPalette.settings.enabled')"
      :description="t('commandPalette.settings.enabledDescription', {shortcut: hotkeyDisplayName})"
    >
      <el-switch
        :model-value="props.config.commandPaletteEnabled"
        class="settings-toggle"
        data-testid="command-palette-enabled"
        :aria-label="t('commandPalette.settings.enabled')"
        @change="handleEnabledChange"
      />
    </SettingsItem>
    <SettingsItem
      :label="t('commandPalette.settings.hotkey')"
      :description="t('commandPalette.settings.hotkeyDescription')"
      :disabled="!props.config.commandPaletteEnabled"
    >
      <div class="hotkey-config">
        <el-select
          :model-value="props.config.commandPaletteHotkey"
          data-testid="command-palette-hotkey"
          :aria-label="t('commandPalette.settings.hotkey')"
          :disabled="!props.config.commandPaletteEnabled"
          @change="handleHotkeyChange"
        >
          <el-option
            v-for="item in COMMAND_PALETTE_HOTKEY_OPTIONS"
            :key="item.value"
            :value="item.value"
            :label="item.label"
            data-i18n-ignore
          />
          <el-option value="custom" :label="t('commandPalette.settings.hotkeyCustom')" />
        </el-select>
        <div v-if="props.config.commandPaletteHotkey === 'custom'" class="command-palette-hotkey-custom">
          <span v-if="props.config.customCommandPaletteHotkey" class="command-palette-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
          <span v-else class="command-palette-hotkey-text command-palette-hotkey-placeholder">{{ t('commandPalette.settings.hotkeyCustomEmpty') }}</span>
          <el-button
            size="small"
            text
            :disabled="!props.config.commandPaletteEnabled"
            :aria-label="t('commandPalette.settings.hotkeyEdit')"
            :title="t('commandPalette.settings.hotkeyEdit')"
            @click="openCustomHotkeyDialog"
          >
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
    </SettingsItem>
  </SettingsGroup>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customCommandPaletteHotkey"
    :validate="findHotkeyConflict"
    @confirm="handleCustomHotkeyConfirm"
    @cancel="handleCustomHotkeyCancel"
  />
</template>

<script setup lang="ts">
import {computed, defineAsyncComponent} from 'vue';
import {Edit} from '@element-plus/icons-vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {
    COMMAND_PALETTE_HOTKEY_OPTIONS,
    DEFAULT_COMMAND_PALETTE_HOTKEY,
    commandPaletteHotkeyDisplayName,
    resolveCommandPaletteHotkey,
} from '@/src/core/config/commandPalette';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy';
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation';
import {resolveVideoSubtitleModeHotkey} from '@/src/core/config/videoSubtitleShortcut';
import {
    findEnabledQuickTranslationHotkeyConflict,
    inputBoxTranslationTriggerHotkey,
    quickTranslationActionKey,
} from '@/src/core/config/quickTranslation';
import {canonicalizeHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {useUiI18n} from '@/src/ui/i18n';
import {useHotkeyDraft} from './useHotkeyDraft';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();

const {
    active: hotkeyEditorActive,
    showCustomHotkeyDialog,
    isCurrentDraft,
    openCustomHotkeyDialog,
    closeCustomHotkeyDialog,
    commitHotkeyDraft,
} = useHotkeyDraft(
    () => props.config,
    {mode: 'commandPaletteHotkey', custom: 'customCommandPaletteHotkey'},
    () => props.active && props.config.commandPaletteEnabled,
);

const hotkeyDisplayName = computed(() => commandPaletteHotkeyDisplayName(
    props.config.commandPaletteHotkey,
    props.config.customCommandPaletteHotkey,
));

function reservedHotkeyOwners(): {hotkey: string; feature: string}[] {
    return [
        {hotkey: resolveReservedClickSelectionHotkey(props.config), feature: translateLegacy('两点选取')},
        {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), feature: t('popup.hoverTranslation')},
        {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), feature: t('quickTranslation.commonFullPageShortcut')},
        {
            hotkey: props.config.selectionTranslatorMode === 'disabled' || props.config.disableSelectionTranslator === true
                ? ''
                : resolveConfiguredHotkey(props.config.selectionTranslatorTrigger, props.config.customSelectionTranslatorHotkey),
            feature: t('popup.selectionTranslation'),
        },
        {
            hotkey: props.config.selectionAreaEnabled
                ? resolveAreaTranslationHotkey(props.config.selectionAreaHotkey, props.config.customSelectionAreaHotkey)
                : '',
            feature: t('popup.areaTranslation'),
        },
        {
            hotkey: props.config.paragraphCopyEnabled
                ? resolveParagraphCopyHotkey(props.config.paragraphCopyHotkey, props.config.customParagraphCopyHotkey)
                : '',
            feature: t('paragraphCopy.settings.title'),
        },
        {
            hotkey: props.config.sectionTranslationHotkeyEnabled
                ? resolveSectionTranslationHotkey(props.config.sectionTranslationHotkey, props.config.customSectionTranslationHotkey)
                : '',
            feature: t('sectionTranslation.settings.title'),
        },
        {
            hotkey: props.config.videoSubtitleModeHotkeyEnabled
                ? resolveVideoSubtitleModeHotkey(props.config.videoSubtitleModeHotkey, props.config.customVideoSubtitleModeHotkey)
                : '',
            feature: t('video.modeShortcut.title'),
        },
        {
            hotkey: props.config.informationHighlight?.hotkeyEnabled === true
                ? props.config.informationHighlight.hotkey ?? ''
                : '',
            feature: t('informationHighlight.title'),
        },
        {
            hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger, props.config.customInputBoxTranslationHotkey),
            feature: translateLegacy('输入框翻译'),
        },
    ];
}

function findHotkeyConflict(hotkey: string): string {
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_COMMAND_PALETTE_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find((item) => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('commandPalette.settings.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles ?? [], resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

function handleEnabledChange(enabled: string | number | boolean): void {
    if (!props.active || typeof enabled !== 'boolean') return;
    if (enabled) {
        const conflict = findHotkeyConflict(resolveCommandPaletteHotkey(
            props.config.commandPaletteHotkey,
            props.config.customCommandPaletteHotkey,
        ));
        if (conflict) {
            ElMessage.warning(conflict);
            return;
        }
    }
    props.config.commandPaletteEnabled = enabled;
}

function handleHotkeyChange(value: string): void {
    if (!hotkeyEditorActive.value) return;
    if (value === 'custom' && !props.config.customCommandPaletteHotkey) {
        openCustomHotkeyDialog();
        return;
    }
    const conflict = findHotkeyConflict(value === 'custom' ? props.config.customCommandPaletteHotkey : value);
    if (conflict) {
        ElMessage.warning(conflict);
        return;
    }
    closeCustomHotkeyDialog();
    props.config.commandPaletteHotkey = value;
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {
        closeCustomHotkeyDialog();
        return;
    }
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    if (!commitHotkeyDraft(canonical ? 'custom' : DEFAULT_COMMAND_PALETTE_HOTKEY, canonical)) return;
    ElMessage({
        message: t('commandPalette.settings.hotkeySet', {shortcut: hotkeyDisplayName.value}),
        type: 'success',
        duration: 2000,
    });
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
</script>

<style scoped>
.hotkey-config { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.command-palette-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line, #e7e9f0); border-radius: 8px; }
.command-palette-hotkey-text { font-size: 12px; color: var(--ink, #172033); }
.command-palette-hotkey-placeholder { color: var(--muted, #737c8f); }
</style>
