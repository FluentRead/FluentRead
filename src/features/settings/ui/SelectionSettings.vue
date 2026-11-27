<!--
 * @file src/features/settings/ui/SelectionSettings.vue
 * 文件职责：作为统一划词翻译的设置入口，按“总开关 → 词典与触发 → AI 深入讲解 → 朗读”递进组织，关闭总开关时收起下属配置。
 * 主要内容：去除静态说明型预览框以保持页面聚焦；以单行选择器提供默认自动与指定词典来源，再启用时检查保留的点选快捷键避免静默丢失入口；朗读设置按需折叠展开。
 * 模块边界：仅编辑父级配置副本，沿用 SettingsSections 的保存和快捷键校验；不建立第二份存储或调用供应商。
 -->
<template>
  <div class="selection-settings">
    <SettingsGroup data-settings-anchor="presentation" data-settings-anchor-label="划词翻译">
      <FeatureEnableCard v-model="enabled" title="启用划词翻译" description="选中文字后查看译文、查词或按需进行 AI 讲解" />
      <template v-if="enabled">
        <SettingsItem :label="t('selection.dictionary.source')" :help="t('selection.dictionary.help')" data-settings-anchor="dictionary" :data-settings-anchor-label="t('selection.dictionary.source')">
          <UiSelect v-model="dictionarySource" :filterable="false" :aria-label="t('selection.dictionary.source')" data-testid="selection-dictionary-source">
            <ElOption v-for="option in dictionarySourceOptions" :key="option.value" :value="option.value" :label="option.label" :disabled="option.value === 'ecdict-local' && browserCapabilities.browser === 'userscript'" />
          </UiSelect>
        </SettingsItem>
        <DictionaryWorkspaceSettings v-if="extensionDictionaryWorkspace && config.selectionDictionaryWorkspace" :config="config" />
      </template>
    </SettingsGroup>
    <template v-if="enabled">
      <slot />
      <HarnessSettings :config="config" />
      <div data-settings-anchor="speech" data-settings-anchor-label="朗读设置">
        <SettingsDisclosure :title="t('settings.experience.speechTitle')" :status="ttsStatusLabel">
          <slot name="advanced" />
        </SettingsDisclosure>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import {ElMessage, ElOption} from 'element-plus';
import {findClickSelectionHotkeyConflict, normalizeClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {WORD_DICTIONARY_SOURCE_OPTIONS} from '@/src/core/config/selectionDictionary';
import {normalizeLocalTtsMode} from '@/src/core/config/localTts';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {useUiI18n} from '@/src/ui/i18n';
const {t, translateLegacy} = useUiI18n();
import type {Config} from '@/src/core/config/model';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsDisclosure from './components/SettingsDisclosure.vue';
import SettingsItem from './components/SettingsItem.vue';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import HarnessSettings from './HarnessSettings.vue';
import DictionaryWorkspaceSettings from './DictionaryWorkspaceSettings.vue';

const props = defineProps<{config: Config}>();
const extensionDictionaryWorkspace = import.meta.env.BROWSER !== 'userscript';
const dictionarySourceOptions = computed(() => [...WORD_DICTIONARY_SOURCE_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 'auto' ? t('selection.dictionary.auto')
    : option.value === 'ecdict-local' ? t('selection.dictionary.local') : translateLegacy(option.label),
})), ...(extensionDictionaryWorkspace ? props.config.selectionDictionaryWorkspace?.recipes || [] : []).map(recipe => ({value: `recipe:${recipe.id}`, label: recipe.name}))]);
const dictionarySource = computed({get: () => extensionDictionaryWorkspace && props.config.selectionDictionaryRecipe ? `recipe:${props.config.selectionDictionaryRecipe}` : props.config.selectionDictionarySource,
  set: (value: string) => {
    if (extensionDictionaryWorkspace && value.startsWith('recipe:')) props.config.selectionDictionaryRecipe = value.slice(7);
    else {props.config.selectionDictionaryRecipe = ''; props.config.selectionDictionarySource = value as Config['selectionDictionarySource'];}
  }});
const previousMode = ref(props.config.selectionTranslatorMode === 'translation-only' ? 'translation-only' : 'bilingual');
const enabled = computed({get: () => props.config.selectionTranslatorMode !== 'disabled', set: (value: boolean) => {
  if (value && props.config.selectionClickSelectEnabled) {
    const owner = findClickSelectionHotkeyConflict({...props.config,
      selectionTranslatorMode: previousMode.value, disableSelectionTranslator: false},
      normalizeClickSelectionHotkey(props.config.selectionClickSelectHotkey));
    if (owner) {ElMessage.warning(t('quickTranslation.legacyConflictEdit', {feature: translateLegacy(owner)}));return;}
  }
  if (!value && props.config.selectionTranslatorMode !== 'disabled') previousMode.value = props.config.selectionTranslatorMode;
  props.config.selectionTranslatorMode = value ? previousMode.value : 'disabled';
  props.config.disableSelectionTranslator = !value;
}});
const ttsStatusLabel = computed(() => {
  const mode = normalizeLocalTtsMode(props.config.selectionTtsMode);
  return t(`settings.localTts.${mode === 'online-first' ? 'onlineFirst' : mode === 'local-first' ? 'localFirst' : mode === 'online-only' ? 'onlineOnly' : 'localOnly'}`);
});
</script>
<style scoped>
.selection-settings :deep(.speech-settings) {
  border: 0;
  margin: 0;
  border-radius: 0;
}
.selection-settings :deep(.speech-settings > .settings-group-heading) {
  display: none;
}
</style>
