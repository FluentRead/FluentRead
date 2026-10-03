<!--
@file src/features/settings/ui/ReadingAssistanceSettings.vue
文件职责：作为翻译设置的首项，提供双语逐句高亮开关和可立即体验的阅读示例。
主要内容：开启后先示范第一组句子的同步高亮，允许指针与键盘逐句体验；仅译文模式提供切回双语的入口，高亮外观直达界面风格。
模块边界：只编辑父级 Config 草稿和发出导航事件；示例不发起翻译，不向宿主网页写入节点或样式。
-->
<template>
  <SettingsGroup :title="t('options.panel.reading')">
    <SettingsItem id="translation-sentence-highlight" :label="t('settings.general.bilingualSentenceHighlight')" :description="t('settings.general.bilingualSentenceHighlightDescription')">
      <el-switch v-model="config.bilingualSentenceHighlightEnabled" class="settings-toggle" :aria-label="t('settings.general.bilingualSentenceHighlight')" />
    </SettingsItem>
    <div class="reading-assistance-example">
      <p v-if="config.display !== 1" class="reading-assistance-note">
        {{ t('settings.translationStyle.bilingualOnly') }}
        <button type="button" @click="config.display = 1">{{ t('settings.translationStyle.switchToBilingual') }}</button>
      </p>
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
      <button type="button" class="reading-assistance-style-link" @click="emit('configureStyle')">{{ t('sentenceHighlight.openStyles') }} →</button>
    </div>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import type {Config} from '@/src/core/config/model'
import {useUiI18n} from '@/src/ui/i18n'
import '@/src/ui/styles/translation-display.css'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import TranslationStylePreview from './components/TranslationStylePreview.vue'
defineProps<{config: Config}>()
const emit = defineEmits<{'configureStyle': []}>()
const {t} = useUiI18n()
const pageTheme = ref<'light' | 'dark'>('light')
</script>
<style scoped>
.reading-assistance-example { display: grid; gap: 12px; padding: 0 16px 16px; }
.reading-assistance-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: 12px; }
.reading-assistance-note button, .reading-assistance-style-link { justify-self: start; border: 0; border-radius: 8px; padding: 8px 10px; color: var(--brand-strong); background: var(--brand-soft); cursor: pointer; font: inherit; font-size: 12px; }
.reading-assistance-style-link:focus-visible, .reading-assistance-note button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
</style>
