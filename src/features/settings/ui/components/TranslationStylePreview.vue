<!--
@file src/features/settings/ui/components/TranslationStylePreview.vue
文件职责：在设置页模拟一段真实网页，用网页实际注入的译文样式表展示当前样式预设、外观微调与双语逐句高亮的效果。
主要内容：绘制带地址栏的迷你浏览器与浅色、深色网页切换，按“译文在原文之前”设置排列原文和译文，并以指针和键盘焦点同步高亮对应句子；
底部说明当前样式、是否已自定义外观以及需要额外交互的样式提示。
模块边界：只接收类名、外观声明和开关状态并展示，不读写配置、不发起翻译；网页配色只影响预览，不改变扩展界面或网站本身。
-->
<template>
  <figure class="translation-style-preview" :data-page-theme="pageTheme">
    <div class="translation-style-preview-toolbar">
      <strong>{{ t('settings.translationStyle.previewTitle') }}</strong>
      <SegmentedControl
        class="translation-style-preview-theme"
        :model-value="pageTheme"
        :options="pageThemeOptions"
        :label="t('settings.translationStyle.pageTheme')"
        @update:model-value="selectPageTheme"
      />
    </div>
    <div
      class="translation-style-preview-page bilingual-highlight-preview"
      :class="{ 'is-bilingual-highlight-enabled': highlightEnabled }"
      :data-bilingual-highlight-enabled="String(highlightEnabled)"
      :data-fr-bilingual-sentence-highlight-style="normalizeSentenceHighlightStyle(highlightStyle)"
      data-testid="bilingual-highlight-preview"
      data-i18n-ignore
      @pointerleave="activeSentence = null"
    >
      <p class="translation-style-preview-paragraph">
        <template v-for="block in blockOrder" :key="block">
          <span v-if="block === 'source'" class="translation-style-preview-source" data-testid="bilingual-highlight-preview-source"><span
            v-for="(sentence, index) in ['Reading should feel calm and effortless. ', 'Move over a sentence to find its translation.']"
            :key="index"
            :class="{ 'is-sentence-highlighted': highlightEnabled && activeSentence === index }"
            :tabindex="highlightEnabled ? 0 : -1"
            :style="highlightEnabled && activeSentence === index ? highlightAppearanceStyle : undefined"
            @pointerenter="activeSentence = index"
            @focus="activeSentence = index"
            @blur="activeSentence = null"
          >{{ sentence }}</span></span>
          <span
            v-else
            class="fluent-read-bilingual-content"
            :class="styleClass"
            :style="appearanceStyle"
            lang="zh-CN"
            data-testid="bilingual-highlight-preview-translation"
          ><span class="fluent-read-translation-text"><span
            v-for="(sentence, index) in ['阅读应该轻松、自然。', '将光标移到某个句子上，即可找到对应译文。']"
            :key="index"
            :class="{ 'is-sentence-highlighted': highlightEnabled && activeSentence === index }"
            :tabindex="highlightEnabled ? 0 : -1"
            :style="highlightEnabled && activeSentence === index ? highlightAppearanceStyle : undefined"
            @pointerenter="activeSentence = index"
            @focus="activeSentence = index"
            @blur="activeSentence = null"
          >{{ sentence }}</span></span></span>
        </template>
      </p>
    </div>
    <figcaption class="translation-style-preview-caption">
      <strong>{{ caption }}</strong>
      <span v-if="customized" class="translation-style-preview-badge">{{ t('settings.translationStyle.customized') }}</span>
      <small v-if="hint">{{ hint }}</small>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useUiI18n} from '@/src/ui/i18n'
import {normalizeSentenceHighlightStyle, getSentenceHighlightAppearanceStyle, type SentenceHighlightStyle, type SentenceHighlightAppearance} from '@/src/core/config/sentenceHighlight'
import '@/src/ui/styles/bilingual-sentence-highlight.css'
import SegmentedControl from './SegmentedControl.vue'

type PreviewPageTheme = 'light' | 'dark'

const props = defineProps<{
  styleClass: string
  appearanceStyle: Record<string, string>
  highlightEnabled: boolean
  highlightStyle?: SentenceHighlightStyle
  highlightAppearance?: SentenceHighlightAppearance
  initialSentence?: number
  translationBeforeOriginal: boolean
  pageTheme: PreviewPageTheme
  caption: string
  customized: boolean
  hint?: string
}>()

const emit = defineEmits<{
  'update:pageTheme': [value: PreviewPageTheme]
}>()

const {t} = useUiI18n()
const activeSentence = ref<number | null>(null)
const highlightAppearanceStyle = computed(() => getSentenceHighlightAppearanceStyle(props.highlightStyle, props.highlightAppearance))
watch(() => [props.highlightEnabled, props.initialSentence] as const, ([enabled, sentence]) => {
  activeSentence.value = enabled && sentence !== undefined ? sentence : null
}, {immediate: true})
// 与网页一致：译文容器插在原文所在的块内，并遵循“译文在原文之前”偏好。
const blockOrder = computed(() => props.translationBeforeOriginal ? ['translation', 'source'] : ['source', 'translation'])
const pageThemeOptions = computed(() => [
  {value: 'light', label: t('settings.translationStyle.pageThemeLight')},
  {value: 'dark', label: t('settings.translationStyle.pageThemeDark')},
])

function selectPageTheme(value: string | number): void {
  emit('update:pageTheme', value === 'dark' ? 'dark' : 'light')
}
</script>

<style scoped>
.translation-style-preview {
  display: grid;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-soft);
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 14px 32px -24px rgba(15, 23, 42, .45);
}

.translation-style-preview-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 8px 7px 12px;
  border-bottom: 1px solid var(--line);
}
.translation-style-preview-toolbar > strong { color: var(--ink); font-size: 11.5px; }

.translation-style-preview-theme.segmented-control {
  width: auto;
  flex: none;
  padding: 2px;
  border-radius: 9px;
}

.translation-style-preview-theme :deep(button) {
  min-height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 10px;
}

/* 预览模拟网站本身的配色，不跟随扩展皮肤，避免误判网页上的实际效果。 */
.translation-style-preview-page {
  --translation-preview-page: #fff;
  --translation-preview-ink: #1f2328;
  min-width: 0;
  padding: 14px 16px;
  color: var(--translation-preview-ink);
  background: var(--translation-preview-page);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  transition: background-color 180ms ease, color 180ms ease;
}

.translation-style-preview[data-page-theme="dark"] .translation-style-preview-page {
  --translation-preview-page: #17191e;
  --translation-preview-ink: #e6e8ec;
}
.translation-style-preview-paragraph { margin: 0; }

.bilingual-highlight-preview span:focus-visible {
  outline: 1px solid var(--brand);
  outline-offset: 2px;
}

.translation-style-preview-caption {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--line);
  color: var(--ink);
  background: var(--surface);
  font-size: 11.5px;
  line-height: 1.45;
}

.translation-style-preview-badge {
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-size: 10px;
  font-weight: 700;
}

.translation-style-preview-caption small {
  flex-basis: 100%;
  color: var(--muted);
  font-size: 10.5px;
}

@media (max-width: 460px) {
  .translation-style-preview-page { padding: 14px 14px 12px; }
}
</style>
