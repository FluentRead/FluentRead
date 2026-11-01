<!--
 * @file src/features/settings/ui/SelectionSettings.vue
 * 文件职责：作为统一划词翻译的设置入口，说明翻译卡片与按需学习，并提供即时预览。
 * 主要内容：用共享预览布局说明卡片的单词与句子效果，以单行选择器提供默认自动与指定词典来源，组织触发、AI 学习与朗读分区及页内导航；再启用时检查保留的点选快捷键，避免静默丢失入口；预览与来源选择不发送查询请求。
 * 模块边界：仅编辑父级配置副本，沿用 SettingsSections 的保存和快捷键校验；不建立第二份存储或调用供应商。
 -->
<template>
  <div class="selection-settings">
    <SettingsGroup data-settings-anchor="presentation" data-settings-anchor-label="翻译卡片">
      <FeatureEnableCard v-model="enabled" title="启用划词翻译" description="选中文字后查看翻译卡片，查词或按需学习句子" />
      <SettingsPreviewLayout class="selection-setup" label="划词效果预览">
        <div class="selection-choices">
          <h2>翻译卡片</h2>
          <p>先看译文，再按需读懂、分析句法、学用法或练习</p>
          <p class="selection-mode-note">{{ t('featureServices.selectionHint') }}</p>
        </div>
        <template #preview><div class="selection-preview">
          <div class="selection-preview-tabs" role="group" aria-label="预览内容">
            <button type="button" :aria-pressed="!sentence" @click="sentence = false">单词</button>
            <button type="button" :aria-pressed="sentence" @click="sentence = true">句子</button>
          </div>
          <div class="selection-preview-source" data-i18n-ignore>{{ sentence ? sentenceSource : 'curious' }}</div>
          <div class="selection-preview-translation" data-i18n-ignore>{{ sentence ? sentenceTranslation : '好奇的；求知欲强的' }}</div>
            <div v-if="!sentence" class="selection-preview-word" data-i18n-ignore><span class="selection-pos">形容词 · adj.</span><span data-i18n-ignore>/ˈkjʊəriəs/</span><p data-i18n-ignore>Eager to know or learn something.</p><small>想了解或学习某事；在这里描述读者的求知欲。</small></div>
            <ReadingAnswer v-else :text="sentenceAnalysis" :source-text="sentenceSource" />
        </div></template>
      </SettingsPreviewLayout>
      <SettingsItem :label="t('selection.dictionary.source')" :help="t('selection.dictionary.help')" data-settings-anchor="dictionary" :data-settings-anchor-label="t('selection.dictionary.source')">
        <UiSelect v-model="config.selectionDictionarySource" :filterable="false" :aria-label="t('selection.dictionary.source')" data-testid="selection-dictionary-source">
          <ElOption v-for="option in dictionarySourceOptions" :key="option.value" :value="option.value" :label="option.label" :disabled="option.value === 'ecdict-local' && browserCapabilities.browser === 'userscript'" />
        </UiSelect>
      </SettingsItem>
    </SettingsGroup>
    <slot />
    <HarnessSettings :config="config" @navigate="emit('navigate', $event)" />
    <div data-settings-anchor="speech" data-settings-anchor-label="朗读设置"><slot name="advanced" /></div>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import {ElMessage, ElOption} from 'element-plus';
import {findClickSelectionHotkeyConflict, normalizeClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {WORD_DICTIONARY_SOURCE_OPTIONS} from '@/src/core/config/selectionDictionary';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {useUiI18n} from '@/src/ui/i18n';
const {t, translateLegacy} = useUiI18n();
import type {Config} from '@/src/core/config/model';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SettingsPreviewLayout from './components/SettingsPreviewLayout.vue';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import HarnessSettings from './HarnessSettings.vue';
import {sentenceAnalysis, sentenceSource, sentenceTranslation} from '@/src/core/config/selectionPreview';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
const props = defineProps<{config: Config}>();
const emit = defineEmits<{navigate: [section: string]}>();
const sentence = ref(false);
const dictionarySourceOptions = computed(() => WORD_DICTIONARY_SOURCE_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 'auto' ? t('selection.dictionary.auto')
    : option.value === 'ecdict-local' ? t('selection.dictionary.local') : translateLegacy(option.label),
})));
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


</script>
<style scoped>
.selection-choices, .selection-preview { min-width:0; }
.selection-choices h2 { margin:0 0 6px; font-size:16px; color:var(--ink); }
.selection-choices p { margin:0 0 18px; color:var(--muted); font-size:12px; line-height:1.7; }
.selection-choices .selection-mode-note { margin:16px 0 0; font-size:11px; }
.selection-preview { color:var(--ink); }
.selection-preview-tabs { display:flex; gap:6px; margin:14px 0; }
.selection-preview-tabs button { font:inherit; font-size:11px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--muted); cursor:pointer; }
.selection-preview-tabs button[aria-pressed=true] { color:var(--brand); border-color:var(--brand); }
.selection-preview-source { font-size:16px; line-height:1.6; overflow-wrap:anywhere; }
.selection-preview-translation { margin:10px 0 16px; font-size:13px; line-height:1.7; }
.selection-preview-word { border-top:1px solid var(--line); padding-top:14px; font-size:12px; }
.selection-pos { display:inline-block; background:color-mix(in srgb, var(--brand) 10%, transparent); color:var(--brand); padding:3px 7px; border-radius:5px; margin-right:10px; }
.selection-preview-word p { line-height:1.7; }
button:focus-visible, summary:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
@media (any-pointer: coarse) {
  .selection-preview-tabs button { min-width:44px; min-height:44px; padding:8px 12px; font-size:13px; }
}
</style>
