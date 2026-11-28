<!--
 * @file src/features/settings/ui/ParagraphCopySettings.vue
 * 文件职责：在翻译交互设置中提供"复制鼠标所指段落"的开关、触发快捷键与复制内容口径，让用户不必先选中文字也能取走一整段。
 * 主要内容：绑定 paragraphCopyEnabled、paragraphCopyHotkey、customParagraphCopyHotkey 与 paragraphCopyContent，提供预设与自定义录制入口，并对悬浮、全文、划词、两点选取、圈选、局部翻译、输入框翻译和快捷翻译方案的占用给出冲突提示。
 * 模块边界：本组件只修改传入的 config 对象并提示冲突，不持久化配置、不监听网页按键、不访问剪贴板；快捷键归一化归 core/config/paragraphCopy，复制行为归 features/paragraph-copy。
 -->
<template>
  <SettingsGroup :title="t('paragraphCopy.settings.title')" :description="t('paragraphCopy.settings.description')">
    <template #heading-extra>
      <el-switch v-model="props.config.paragraphCopyEnabled" class="settings-toggle" :aria-label="t('paragraphCopy.settings.enabled')" />
    </template>
    <template v-if="props.config.paragraphCopyEnabled">
      <SettingsItem :label="t('paragraphCopy.settings.hotkey')" :description="t('paragraphCopy.settings.hotkeyDescription')">
        <div class="hotkey-config">
          <el-select :model-value="props.config.paragraphCopyHotkey" data-testid="paragraph-copy-hotkey" :aria-label="t('paragraphCopy.settings.hotkey')" @change="handleHotkeyChange">
            <el-option v-for="item in PARAGRAPH_COPY_HOTKEY_OPTIONS" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
            <el-option value="custom" :label="t('paragraphCopy.settings.hotkeyCustom')" />
          </el-select>
          <div v-if="props.config.paragraphCopyHotkey === 'custom'" class="paragraph-copy-hotkey-custom">
            <span v-if="props.config.customParagraphCopyHotkey" class="paragraph-copy-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
            <span v-else class="paragraph-copy-hotkey-text paragraph-copy-hotkey-placeholder">{{ t('paragraphCopy.settings.hotkeyCustomEmpty') }}</span>
            <el-button size="small" type="text" :aria-label="t('paragraphCopy.settings.hotkeyEdit')" :title="t('paragraphCopy.settings.hotkeyEdit')" @click="openCustomHotkeyDialog">
              <el-icon><Edit /></el-icon>
            </el-button>
          </div>
        </div>
      </SettingsItem>
      <SettingsItem :label="t('paragraphCopy.settings.content')" :description="t(`paragraphCopy.settings.content.${props.config.paragraphCopyContent}Description`)">
        <el-select v-model="props.config.paragraphCopyContent" data-testid="paragraph-copy-content" :aria-label="t('paragraphCopy.settings.content')">
          <el-option v-for="mode in PARAGRAPH_COPY_CONTENT_MODES" :key="mode" :value="mode" :label="t(`paragraphCopy.settings.content.${mode}`)" />
        </el-select>
      </SettingsItem>
    </template>
  </SettingsGroup>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customParagraphCopyHotkey"
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
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    PARAGRAPH_COPY_CONTENT_MODES,
    PARAGRAPH_COPY_HOTKEY_OPTIONS,
    paragraphCopyHotkeyDisplayName,
} from '@/src/core/config/paragraphCopy';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {resolveCommandPaletteHotkey} from '@/src/core/config/commandPalette';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation';
import {resolveVideoSubtitleModeHotkey} from '@/src/core/config/videoSubtitleShortcut';
import {resolveWritingHotkey} from '@/src/core/config/writing';
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
const {active: hotkeyEditorActive, showCustomHotkeyDialog, isCurrentDraft, openCustomHotkeyDialog, closeCustomHotkeyDialog, commitHotkeyDraft} = useHotkeyDraft(
    () => props.config, {mode: 'paragraphCopyHotkey', custom: 'customParagraphCopyHotkey'}, () => props.active && props.config.paragraphCopyEnabled,
);
const hotkeyDisplayName = computed(() => paragraphCopyHotkeyDisplayName(
    props.config.paragraphCopyHotkey,
    props.config.customParagraphCopyHotkey,
));

/** 列出已被其他功能占用的快捷键，避免一次按键同时触发复制和翻译。 */
function reservedHotkeyOwners(): {hotkey: string; feature: string}[] {
    return [
        {hotkey: resolveReservedClickSelectionHotkey(props.config), feature: translateLegacy('两点选取')},
        {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), feature: t('popup.hoverTranslation')},
        {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), feature: t('quickTranslation.commonFullPageShortcut')},
        {
            // 划词已停用时它的旧快捷键不再接管按键，不应阻止段落复制使用同一个组合键。
            hotkey: props.config.selectionTranslatorMode === 'disabled'
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
            hotkey: props.config.commandPaletteEnabled
                ? resolveCommandPaletteHotkey(props.config.commandPaletteHotkey, props.config.customCommandPaletteHotkey)
                : '',
            feature: translateLegacy('全局命令面板'),
        },
        {hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger, props.config.customInputBoxTranslationHotkey), feature: translateLegacy('输入框翻译')},
        {hotkey: resolveWritingHotkey(props.config.writing), feature: translateLegacy('写作助手')},
    ];
}

/** 供自定义录制对话框实时校验；返回空字符串表示可以使用。 */
function findHotkeyConflict(hotkey: string): string {
    // 清除录制将回到默认组合键，也要检查默认入口是否已被其他功能占用。
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_PARAGRAPH_COPY_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find(item => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('paragraphCopy.settings.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles, resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

function handleHotkeyChange(value: string): void {
    if (!hotkeyEditorActive.value) return;
    if (value === 'custom' && !props.config.customParagraphCopyHotkey) {openCustomHotkeyDialog();return;}
    const conflict = findHotkeyConflict(value === 'custom' ? props.config.customParagraphCopyHotkey : value);
    if (conflict) {ElMessage.warning(conflict);return;}
    closeCustomHotkeyDialog();
    props.config.paragraphCopyHotkey = value;
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {closeCustomHotkeyDialog();return;}
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    // 清除录制回到默认入口；提交前同样校验默认组合的占用。
    if (!commitHotkeyDraft(canonical ? 'custom' : DEFAULT_PARAGRAPH_COPY_HOTKEY, canonical)) return;
    ElMessage({message: t('paragraphCopy.settings.hotkeySet', {shortcut: hotkeyDisplayName.value}), type: 'success', duration: 2000});
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
</script>

<style scoped>
.hotkey-config { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.paragraph-copy-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line, #e7e9f0); border-radius: 8px; }
.paragraph-copy-hotkey-text { font-size: 12px; color: var(--ink, #172033); }
.paragraph-copy-hotkey-placeholder { color: var(--muted, #737c8f); }
</style>
