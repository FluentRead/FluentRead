<!--
@file src/features/settings/ui/ReadingAssistanceSettings.vue
文件职责：作为翻译设置的首项，提供双语逐句高亮的当前样式入口和可立即体验的阅读示例。
主要内容：桌面左侧展示可切换网页明暗的实时预览，右侧集中展示当前样式或“无”、说明与样式入口，以及默认关闭的个人校订开关，校订名称及说明直接使用七语资源；高亮开关合并在样式选择中，窄屏纵向排列，开启后允许指针与键盘逐句体验，仅译文模式提供切回双语的入口。
模块边界：只编辑父级 Config 草稿和发出导航事件；示例不发起翻译，不向宿主网页写入节点或样式。
-->
<template>
  <SettingsGroup class="reading-assistance-settings" :title="t('options.panel.reading')">
    <div class="reading-assistance-workspace">
      <div class="reading-assistance-example">
        <TranslationStylePreview
          style-class=""
          :appearance-style="{}"
          :highlight-enabled="config.bilingualSentenceHighlightEnabled"
          :highlight-style="config.bilingualSentenceHighlightStyle"
          :highlight-appearance="config.bilingualSentenceHighlightAppearance"
          :initial-sentence="0"
          :translation-before-original="config.translationBeforeOriginal"
          :page-theme="pageTheme"
          :caption="t(config.bilingualSentenceHighlightEnabled ? 'sentenceHighlight.tryHint' : 'sentenceHighlight.offHint')"
          :customized="false"
          @update:page-theme="pageTheme = $event"
        />
        <p v-if="config.display !== 1" class="reading-assistance-note" role="status">
          {{ t('settings.translationStyle.bilingualOnly') }}
          <button type="button" @click="config.display = 1">{{ t('settings.translationStyle.switchToBilingual') }}</button>
        </p>
      </div>
      <div class="reading-assistance-controls">
        <SettingsItem id="translation-sentence-highlight" :label="t('settings.general.bilingualSentenceHighlight')">
          <template #copy>
            <strong>{{ t('settings.general.bilingualSentenceHighlight') }}</strong>
            <small>{{ t('settings.general.bilingualSentenceHighlightDescription') }} <span data-testid="sentence-highlight-grouping-hint">{{ t('settings.general.bilingualSentenceHighlightGroupingHint') }}</span></small>
          </template>
          <button type="button" class="settings-navigation-link" data-testid="open-sentence-highlight-styles" :aria-label="`${t('sentenceHighlight.openStyles')}: ${currentStyleLabel}`" @click="emit('configureStyle')">
            <span data-testid="current-sentence-highlight-style" data-i18n-ignore :title="currentStyleLabel">{{ currentStyleLabel }}</span>
            <el-icon aria-hidden="true"><ArrowRight /></el-icon>
          </button>
        </SettingsItem>
        <SettingsItem v-if="personalCorrectionsSupported" id="personal-corrections-settings" :label="t('settings.personalCorrections.title')" :description="t('settings.personalCorrections.description')" :help="t('settings.personalCorrections.help')">
          <el-switch v-model="config.personalCorrectionsEnabled" class="settings-toggle" data-testid="personal-corrections-enabled" :aria-label="t('settings.personalCorrections.title')" />
        </SettingsItem>
      </div>
    </div>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue'
import {ArrowRight} from '@element-plus/icons-vue'
import type {Config} from '@/src/core/config/model'
import {SENTENCE_HIGHLIGHT_STYLES} from '@/src/core/config/sentenceHighlight'
import {useUiI18n} from '@/src/ui/i18n'
import '@/src/ui/styles/translation-display.css'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import TranslationStylePreview from './components/TranslationStylePreview.vue'
const props = defineProps<{config: Config}>()
const emit = defineEmits<{'configureStyle': []}>()
const {t} = useUiI18n()
const pageTheme = ref<'light' | 'dark'>('light')
const personalCorrectionsSupported = import.meta.env.BROWSER !== 'userscript'
const currentStyleLabel = computed(() => {
  if (!props.config.bilingualSentenceHighlightEnabled) return t('common.none')
  const profile = props.config.bilingualSentenceHighlightProfiles.find(item => item.id === props.config.activeSentenceHighlightProfileId)
  if (profile) return profile.name
  const style = SENTENCE_HIGHLIGHT_STYLES.find(item => item.value === props.config.bilingualSentenceHighlightStyle)
  return style ? t(style.labelKey) : t('sentenceHighlight.title')
})
</script>
<style scoped>
.reading-assistance-workspace { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 24px; padding: 20px; }
.reading-assistance-example { display: grid; min-width: 0; gap: 12px; }
.reading-assistance-controls { min-width: 0; }
.reading-assistance-controls :deep(.settings-item) { grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; min-height: 0; padding: 9px 0; }
.reading-assistance-controls :deep(.settings-item-control > .settings-navigation-link) { width: auto; max-width: 220px; }
.reading-assistance-controls .settings-navigation-link > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reading-assistance-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: 12px; }
.reading-assistance-note button { border: 0; border-radius: 8px; padding: 8px 10px; color: var(--brand-strong); background: var(--brand-soft); cursor: pointer; font: inherit; font-size: 12px; }
.reading-assistance-note button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (max-width: 850px) { .reading-assistance-workspace { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 20px; } }
@media (max-width: 480px) {
  .reading-assistance-workspace { padding: 12px; }
  .reading-assistance-controls :deep(.settings-item) { grid-template-columns: minmax(0, 1fr); }
  .reading-assistance-controls :deep(.settings-item-control > .settings-navigation-link) { max-width: 100%; }
}
</style>
