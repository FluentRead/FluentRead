<!--
 * @file src/features/settings/ui/SectionTranslationSettings.vue
 * 文件职责：在翻译交互设置中介绍局部翻译（点选网页中的一块区域、只翻译这部分）的用法，并提供进入选择模式的快捷键开关、预设组合、自定义录制、独立快捷方案和已记住区域的规则管理。
 * 主要内容：展示功能说明与操作方式，绑定 sectionTranslationHotkeyEnabled、sectionTranslationHotkey 与 customSectionTranslationHotkey，对悬浮、全文、划词、两点选取、圈选、段落复制、输入框翻译和快捷翻译方案的占用给出冲突提示，录制期间保留原有组合，隐藏或配置变更时关闭所属草稿。
 * 模块边界：本组件只修改传入的 config 对象并提示冲突，不持久化配置、不监听网页按键，也不执行翻译；快捷键归一化归 core/config/sectionTranslation，选择模式与区域翻译归 features/section-translation 与全文翻译 feature。
 -->
<template>
  <SettingsGroup :title="t('sectionTranslation.settings.title')" :description="t('sectionTranslation.settings.description')">
    <SettingsItem :label="t('sectionTranslation.settings.hotkeyEnabled')" :description="t('sectionTranslation.settings.hotkeyEnabledDescription', {shortcut: hotkeyDisplayName})" :help="t('sectionTranslation.settings.usage')">
      <el-switch v-model="props.config.sectionTranslationHotkeyEnabled" class="settings-toggle" :aria-label="t('sectionTranslation.settings.hotkeyEnabled')" @change="handleEnabledChange" />
    </SettingsItem>
    <SettingsItem :label="t('sectionTranslation.settings.hotkey')" :description="t('sectionTranslation.settings.hotkeyDescription')" :disabled="!props.config.sectionTranslationHotkeyEnabled">
      <div class="hotkey-config">
        <el-select :model-value="props.config.sectionTranslationHotkey" data-testid="section-translation-hotkey" :aria-label="t('sectionTranslation.settings.hotkey')" :disabled="!props.config.sectionTranslationHotkeyEnabled" @change="handleHotkeyChange">
          <el-option v-for="item in SECTION_TRANSLATION_HOTKEY_OPTIONS" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
          <el-option value="custom" :label="t('sectionTranslation.settings.hotkeyCustom')" />
        </el-select>
        <div v-if="props.config.sectionTranslationHotkey === 'custom'" class="section-translation-hotkey-custom">
          <span v-if="props.config.customSectionTranslationHotkey" class="section-translation-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
          <span v-else class="section-translation-hotkey-text section-translation-hotkey-placeholder">{{ t('sectionTranslation.settings.hotkeyCustomEmpty') }}</span>
          <el-button size="small" text :disabled="!props.config.sectionTranslationHotkeyEnabled" :aria-label="t('sectionTranslation.settings.hotkeyEdit')" :title="t('sectionTranslation.settings.hotkeyEdit')" @click="openCustomHotkeyDialog">
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
    </SettingsItem>
    <SectionTranslationRules :config="props.config" :active="props.active" />
    <QuickTranslationProfiles :active="props.active" :config="props.config" action="section" :profiles="props.config.quickTranslationProfiles"
      @update:profiles="props.config.quickTranslationProfiles = $event" />
  </SettingsGroup>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customSectionTranslationHotkey"
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
    DEFAULT_SECTION_TRANSLATION_HOTKEY,
    SECTION_TRANSLATION_HOTKEY_OPTIONS,
    resolveSectionTranslationHotkey,
    sectionTranslationHotkeyDisplayName,
} from '@/src/core/config/sectionTranslation';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy';
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

const SectionTranslationRules = defineAsyncComponent(() => import('./SectionTranslationRules.vue'));
const QuickTranslationProfiles = defineAsyncComponent(() => import('./QuickTranslationProfiles.vue'));
const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const {active: hotkeyEditorActive, showCustomHotkeyDialog, isCurrentDraft, openCustomHotkeyDialog, closeCustomHotkeyDialog, commitHotkeyDraft} = useHotkeyDraft(
    () => props.config, {mode: 'sectionTranslationHotkey', custom: 'customSectionTranslationHotkey'}, () => props.active && props.config.sectionTranslationHotkeyEnabled,
);
const hotkeyDisplayName = computed(() => sectionTranslationHotkeyDisplayName(
    props.config.sectionTranslationHotkey,
    props.config.customSectionTranslationHotkey,
));

/** 列出已被其他功能占用的快捷键，避免一次按键同时进入选择模式又触发翻译或复制。 */
function reservedHotkeyOwners(): {hotkey: string; feature: string}[] {
    return [
        {hotkey: resolveReservedClickSelectionHotkey(props.config), feature: translateLegacy('两点选取')},
        {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), feature: t('popup.hoverTranslation')},
        {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), feature: t('quickTranslation.commonFullPageShortcut')},
        {
            // 划词已停用时它的旧快捷键不再接管按键，不应阻止局部翻译使用同一个组合键。
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
            hotkey: props.config.paragraphCopyEnabled
                ? resolveParagraphCopyHotkey(props.config.paragraphCopyHotkey, props.config.customParagraphCopyHotkey)
                : '',
            feature: t('paragraphCopy.settings.title'),
        },
        {hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger), feature: translateLegacy('输入框翻译')},
    ];
}

/** 供自定义录制对话框与预设切换实时校验；返回空字符串表示可以使用。 */
function findHotkeyConflict(hotkey: string): string {
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_SECTION_TRANSLATION_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find(item => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('sectionTranslation.settings.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles, resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

/** 开启时若当前组合已被占用，保持关闭并说明原因，避免一次按键触发两个功能。 */
function handleEnabledChange(enabled: string | number | boolean): void {
    if (enabled !== true) return;
    const conflict = findHotkeyConflict(resolveSectionTranslationHotkey(
        props.config.sectionTranslationHotkey,
        props.config.customSectionTranslationHotkey,
    ));
    if (!conflict) return;
    props.config.sectionTranslationHotkeyEnabled = false;
    ElMessage.warning(conflict);
}

function handleHotkeyChange(value: string): void {
    if (!hotkeyEditorActive.value) return;
    if (value === 'custom' && !props.config.customSectionTranslationHotkey) {openCustomHotkeyDialog();return;}
    const conflict = findHotkeyConflict(value === 'custom' ? props.config.customSectionTranslationHotkey : value);
    if (conflict) {ElMessage.warning(conflict);return;}
    closeCustomHotkeyDialog();
    props.config.sectionTranslationHotkey = value;
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {closeCustomHotkeyDialog();return;}
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    // 清除录制回到默认入口；提交前同样校验默认组合的占用。
    if (!commitHotkeyDraft(canonical ? 'custom' : DEFAULT_SECTION_TRANSLATION_HOTKEY, canonical)) return;
    ElMessage({message: t('sectionTranslation.settings.hotkeySet', {shortcut: hotkeyDisplayName.value}), type: 'success', duration: 2000});
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
</script>

<style scoped>
.hotkey-config { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.section-translation-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line, #e7e9f0); border-radius: 8px; }
.section-translation-hotkey-text { font-size: 12px; color: var(--ink, #172033); }
.section-translation-hotkey-placeholder { color: var(--muted, #737c8f); }
</style>
