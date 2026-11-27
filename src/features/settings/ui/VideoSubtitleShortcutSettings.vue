<!--
 * @file src/features/settings/ui/VideoSubtitleShortcutSettings.vue
 * 文件职责：在视频翻译设置中提供视频字幕显示模式切换快捷键的开关、预设组合键、自定义快捷键录制与切换方式选择，让用户在看视频时不必用鼠标点击播放器图标也能快速切换双语、仅原文、仅译文或关闭字幕。
 * 主要内容：绑定 videoSubtitleModeHotkeyEnabled、videoSubtitleModeHotkey、customVideoSubtitleModeHotkey 与 videoSubtitleModeHotkeyAction，复用 useHotkeyDraft 与 CustomHotkeyInput 管理草稿与生命周期，并对悬浮、全文、划词、两点选取、圈选、段落复制、局部翻译、输入框翻译、智能高亮与快捷翻译方案的按键占用做冲突校验。
 * 模块边界：本组件只修改传入的 config 对象并给出冲突或保存反馈，不持久化配置、不注册网页键盘监听，也不操作播放器 DOM；快捷键与模式转移规则归 core/config/videoSubtitleShortcut，播放器运行时响应归 features/video-subtitle/content。
 -->
<template>
  <SettingsGroup :title="t('video.modeShortcut.title')" :description="t('video.modeShortcut.description')">
    <SettingsItem
      :label="t('video.modeShortcut.enabled')"
      :description="t('video.modeShortcut.enabledDescription', {shortcut: hotkeyDisplayName})"
      :disabled="!props.config.videoTranslationEnabled"
    >
      <el-switch
        :model-value="props.config.videoSubtitleModeHotkeyEnabled"
        class="settings-toggle"
        data-testid="video-subtitle-mode-hotkey-enabled"
        :aria-label="t('video.modeShortcut.enabled')"
        :disabled="!props.config.videoTranslationEnabled"
        @change="handleEnabledChange"
      />
    </SettingsItem>
    <SettingsItem
      :label="t('video.modeShortcut.hotkey')"
      :description="t('video.modeShortcut.hotkeyDescription')"
      :disabled="!hotkeyControlsEnabled"
    >
      <div class="hotkey-config">
        <el-select
          :model-value="props.config.videoSubtitleModeHotkey"
          data-testid="video-subtitle-mode-hotkey"
          :aria-label="t('video.modeShortcut.hotkey')"
          :disabled="!hotkeyControlsEnabled"
          @change="handleHotkeyChange"
        >
          <el-option v-for="item in VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
          <el-option value="custom" :label="t('video.modeShortcut.hotkeyCustom')" />
        </el-select>
        <div v-if="props.config.videoSubtitleModeHotkey === 'custom'" class="video-subtitle-hotkey-custom">
          <span v-if="props.config.customVideoSubtitleModeHotkey" class="video-subtitle-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
          <span v-else class="video-subtitle-hotkey-text video-subtitle-hotkey-placeholder">{{ t('video.modeShortcut.hotkeyCustomEmpty') }}</span>
          <el-button
            size="small"
            text
            :disabled="!hotkeyControlsEnabled"
            :aria-label="t('video.modeShortcut.hotkeyEdit')"
            :title="t('video.modeShortcut.hotkeyEdit')"
            @click="openCustomHotkeyDialog"
          >
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
    </SettingsItem>
    <SettingsItem
      :label="t('video.modeShortcut.action')"
      :description="t(`video.modeShortcut.action.${props.config.videoSubtitleModeHotkeyAction}Description`)"
      :disabled="!hotkeyControlsEnabled"
    >
      <el-select
        v-model="props.config.videoSubtitleModeHotkeyAction"
        data-testid="video-subtitle-mode-hotkey-action"
        :aria-label="t('video.modeShortcut.action')"
        :disabled="!hotkeyControlsEnabled"
      >
        <el-option
          v-for="action in VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS"
          :key="action"
          :value="action"
          :label="t(`video.modeShortcut.action.${action}`)"
        />
      </el-select>
    </SettingsItem>
  </SettingsGroup>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customVideoSubtitleModeHotkey"
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
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS,
    VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS,
    resolveVideoSubtitleModeHotkey,
    videoSubtitleModeHotkeyDisplayName,
} from '@/src/core/config/videoSubtitleShortcut';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy';
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation';
import {canonicalizeHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {
    findEnabledQuickTranslationHotkeyConflict,
    quickTranslationActionKey,
    inputBoxTranslationTriggerHotkey,
} from '@/src/core/config/quickTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import {useHotkeyDraft} from './useHotkeyDraft';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const hotkeyControlsEnabled = computed(() => props.config.videoTranslationEnabled && props.config.videoSubtitleModeHotkeyEnabled);
const {active: hotkeyEditorActive, showCustomHotkeyDialog, isCurrentDraft, openCustomHotkeyDialog, closeCustomHotkeyDialog, commitHotkeyDraft} = useHotkeyDraft(
    () => props.config,
    {mode: 'videoSubtitleModeHotkey', custom: 'customVideoSubtitleModeHotkey'},
    () => props.active && hotkeyControlsEnabled.value,
);
const hotkeyDisplayName = computed(() => videoSubtitleModeHotkeyDisplayName(
    props.config.videoSubtitleModeHotkey,
    props.config.customVideoSubtitleModeHotkey,
));

/** 列出已被其他功能占用的快捷键，避免一次按键同时触发字幕切换和其他网页动作。 */
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
            hotkey: props.config.informationHighlight?.hotkeyEnabled === true
                ? props.config.informationHighlight.hotkey ?? ''
                : '',
            feature: t('informationHighlight.title'),
        },
        {hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger, props.config.customInputBoxTranslationHotkey), feature: translateLegacy('输入框翻译')},
    ];
}

/** 供自定义录制对话框、预设切换与开关启用实时校验；返回空字符串表示可以使用。 */
function findHotkeyConflict(hotkey: string): string {
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find(item => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('video.modeShortcut.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles ?? [], resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

/** 开启时若当前组合已被占用，保持关闭并说明原因。 */
function handleEnabledChange(enabled: string | number | boolean): void {
    if (!props.active || !props.config.videoTranslationEnabled || typeof enabled !== 'boolean') return;
    if (enabled) {
        const conflict = findHotkeyConflict(resolveVideoSubtitleModeHotkey(
            props.config.videoSubtitleModeHotkey,
            props.config.customVideoSubtitleModeHotkey,
        ));
        if (conflict) {
            ElMessage.warning(conflict);
            return;
        }
    }
    props.config.videoSubtitleModeHotkeyEnabled = enabled;
}

function handleHotkeyChange(value: string): void {
    if (!hotkeyEditorActive.value) return;
    if (value === 'custom' && !props.config.customVideoSubtitleModeHotkey) {openCustomHotkeyDialog();return;}
    const conflict = findHotkeyConflict(value === 'custom' ? props.config.customVideoSubtitleModeHotkey : value);
    if (conflict) {ElMessage.warning(conflict);return;}
    closeCustomHotkeyDialog();
    props.config.videoSubtitleModeHotkey = value;
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {closeCustomHotkeyDialog();return;}
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    // 清除录制回到默认入口；提交前同样校验默认组合的占用。
    if (!commitHotkeyDraft(canonical ? 'custom' : DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY, canonical)) return;
    ElMessage({message: t('video.modeShortcut.hotkeySet', {shortcut: hotkeyDisplayName.value}), type: 'success', duration: 2000});
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
</script>

<style scoped>
.hotkey-config { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.video-subtitle-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line, #e7e9f0); border-radius: 8px; }
.video-subtitle-hotkey-text { font-size: 12px; color: var(--ink, #172033); }
.video-subtitle-hotkey-placeholder { color: var(--muted, #737c8f); }
</style>
