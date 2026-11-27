<!--
 * @file src/features/settings/ui/VideoSubtitleAppearanceSettings.vue
 * 文件职责：提供视频字幕外观的分层设置，左侧展示隔离的实时视频预览，右侧按“显示偏好 → 紧凑皮肤网格 → 默认折叠的微调面板”递进组织。
 * 主要内容：皮肤卡片在深色视频底板上呈现真实字幕质感（解决透明/毛玻璃皮肤在浅色背景下难以辨认的问题），微调区默认折叠并统一使用滑块+行内百分比框、开关与成组取色控件；完整保留整体与译文独立字号、双语上下顺序、逐字高亮、读音标注、轮廓样式/颜色/粗细、背景显隐与恢复默认。
 * 模块边界：只编辑传入 Config 草稿；保存由 SettingsSections 统一处理，播放器实际应用由 content 层负责。
 -->
<template>
  <SettingsGroup class="video-subtitle-appearance-group" title="视频字幕外观">
    <template #heading-extra>
      <button type="button" class="appearance-reset-button" @click="resetAppearance">恢复默认</button>
    </template>
    <SettingsPreviewLayout class="video-subtitle-appearance-panel" label="视频字幕效果预览" sticky-preview data-video-subtitle-appearance>
      <template #preview>
        <div class="subtitle-preview-scene" :data-position="config.videoSubtitleAppearance.position" :data-auto-bottom="config.videoSubtitleAppearance.autoBottom" data-video-subtitle-preview-scene>
          <div v-if="config.videoSubtitleVisible" class="subtitle-live-preview" :style="previewStyle" data-video-subtitle-preview>
            <template v-for="line in previewOrder" :key="line">
              <template v-if="line === 'original' && config.videoSubtitleDisplayMode !== 'translation-only'">
                <span :class="{ 'subtitle-preview-karaoke': config.videoSubtitleAppearance.karaoke }" :data-text="previewOriginal" :lang="config.videoSubtitleAppearance.readingAnnotation ? 'ja' : 'en'" data-i18n-ignore>{{ previewOriginal }}</span>
                <small v-if="config.videoSubtitleAppearance.readingAnnotation" class="subtitle-preview-reading" lang="ja-Latn" data-video-subtitle-reading-preview data-i18n-ignore>kyō wa ii tenki desu ne.</small>
              </template>
              <b v-if="line === 'translation' && config.videoSubtitleDisplayMode !== 'original-only'" :class="{ 'subtitle-preview-karaoke': config.videoSubtitleAppearance.karaoke }" :data-text="previewTranslation" data-i18n-ignore>{{ previewTranslation }}</b>
            </template>
          </div>
          <span v-else class="subtitle-preview-hidden">字幕已隐藏</span>
        </div>
        <p v-if="config.videoSubtitleAppearance.readingAnnotation" class="subtitle-appearance-hint" data-video-subtitle-reading-sample>{{ t('video.readingAnnotation.previewSample') }}</p>
      </template>

      <div class="subtitle-display-preferences">
        <SettingsItem :label="translateControlLabel('显示 FluentRead 字幕').replace('FluentRead', t('common.brand'))" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoSubtitleVisible" :aria-label="translateControlLabel('显示 FluentRead 视频字幕').replace('FluentRead', t('common.brand'))" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem class="subtitle-mode-item" label="字幕显示模式" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible">
          <SegmentedControl v-model="config.videoSubtitleDisplayMode" :options="displayModeOptions" data-video-subtitle-display-mode label="视频字幕显示模式" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible" />
        </SettingsItem>
        <SettingsItem class="subtitle-order-item" :label="t('video.bilingualOrder')" :description="config.videoSubtitleDisplayMode !== 'bilingual' ? t('video.bilingualOrderHint') : ''" :disabled="!orderAvailable">
          <SegmentedControl v-model="config.videoSubtitleAppearance.bilingualOrder" :options="bilingualOrderOptions" :label="t('video.bilingualOrder')" compact :disabled="!orderAvailable" data-video-subtitle-order />
        </SettingsItem>
        <SettingsItem class="subtitle-reading-item" :label="t('video.readingAnnotation.label')" :help="`${t('video.readingAnnotation.description')} · ${t('video.readingAnnotation.approximation')}`" :disabled="!readingAvailable">
          <template #description>
            <small>{{ readingDescription }} <button v-if="readingNeedsOriginal" type="button" class="subtitle-reading-show-original" :disabled="!readingAvailable" data-video-subtitle-reading-show-original @click="showReading">{{ t('settings.translationStyle.switchToBilingual') }}</button></small>
          </template>
          <el-switch v-model="config.videoSubtitleAppearance.readingAnnotation" :aria-label="t('video.readingAnnotation.label')" :disabled="!readingAvailable" data-video-subtitle-reading-annotation />
        </SettingsItem>
        <SettingsItem class="subtitle-karaoke-item" label="逐字高亮" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible">
          <el-switch v-model="config.videoSubtitleAppearance.karaoke" aria-label="视频字幕逐字高亮" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible" data-video-subtitle-karaoke />
        </SettingsItem>
      </div>

      <section class="subtitle-skin-section" aria-label="视频字幕皮肤">
        <header class="appearance-panel-heading">
          <strong>字幕皮肤</strong>
          <span>{{ currentSkinLabel }}</span>
        </header>
        <div class="subtitle-skin-grid" role="radiogroup" aria-label="视频字幕皮肤">
          <button
            v-for="skin in VIDEO_SUBTITLE_SKINS"
            :key="skin.id"
            type="button"
            class="subtitle-skin-option"
            :class="{ selected: config.videoSubtitleAppearance.skin === skin.id }"
            :aria-checked="config.videoSubtitleAppearance.skin === skin.id"
            :title="skin.description"
            role="radio"
            :data-skin="skin.id"
            @click="selectSkin(skin.id)"
          >
            <span class="subtitle-skin-stage" aria-hidden="true">
              <span class="subtitle-skin-swatch" :data-skin="skin.id" :style="skinSwatchStyle(skin)"><b>Ab</b><em>译文</em></span>
            </span>
            <strong>{{ skin.label }}</strong>
          </button>
        </div>
      </section>

      <details class="subtitle-appearance-advanced" data-testid="subtitle-appearance-advanced">
        <summary>
          <span>{{ t('settings.video.advancedAppearance') }}</span>
          <small>{{ advancedCustomized ? t('settings.disclosure.customized') : t('settings.disclosure.default') }}</small>
        </summary>
        <div class="subtitle-appearance-controls">
          <div class="subtitle-control-card">
            <strong class="subtitle-control-card-title">字号与排版</strong>
            <label class="subtitle-slider-field">
              <span class="subtitle-field-head"><span>字号</span></span>
              <span class="subtitle-slider-row">
                <input v-model.number="config.videoSubtitleAppearance.fontScale" type="range" :min="VIDEO_SUBTITLE_FONT_SCALE_RANGE.min" :max="VIDEO_SUBTITLE_FONT_SCALE_RANGE.max" step="10" aria-label="字幕字号" />
                <span class="subtitle-percent-pill">
                  <input :value="config.videoSubtitleAppearance.fontScale" type="number" :min="VIDEO_SUBTITLE_FONT_SCALE_RANGE.min" :max="VIDEO_SUBTITLE_FONT_SCALE_RANGE.max" step="1" :aria-label="translateControlLabel('字幕字号')" @change="updateFontScale" />
                  <span aria-hidden="true">%</span>
                </span>
              </span>
            </label>
            <div class="subtitle-compact-pair">
              <label class="subtitle-slider-field">
                <span class="subtitle-field-head"><span>行距</span><b>{{ config.videoSubtitleAppearance.lineSpacing.toFixed(2) }}</b></span>
                <input v-model.number="config.videoSubtitleAppearance.lineSpacing" type="range" min="1" max="2" step="0.01" aria-label="字幕行距" />
              </label>
              <label class="subtitle-slider-field">
                <span class="subtitle-field-head"><span>最大宽度</span><b>{{ config.videoSubtitleAppearance.maxWidth }}%</b></span>
                <input v-model.number="config.videoSubtitleAppearance.maxWidth" type="range" min="40" max="100" step="1" aria-label="字幕最大宽度" />
              </label>
            </div>
          </div>

          <div class="subtitle-control-card">
            <strong class="subtitle-control-card-title">位置</strong>
            <div class="subtitle-inline-field">
              <span>位置</span>
              <UiSelect v-model="config.videoSubtitleAppearance.position" aria-label="字幕位置">
                <ElOption value="bottom" :label="translateControlLabel('底部')" />
                <ElOption value="center" :label="translateControlLabel('中部')" />
                <ElOption value="top" :label="translateControlLabel('顶部')" />
              </UiSelect>
            </div>
            <label class="subtitle-slider-field">
              <span class="subtitle-field-head"><span>底部偏移</span><b>{{ config.videoSubtitleAppearance.position === 'bottom' && config.videoSubtitleAppearance.autoBottom ? translateControlLabel('自动') : `${config.videoSubtitleAppearance.bottomOffset}%` }}</b></span>
              <input v-model.number="config.videoSubtitleAppearance.bottomOffset" type="range" min="0" max="25" step="1" aria-label="字幕底部偏移" @input="config.videoSubtitleAppearance.autoBottom = false" />
            </label>
            <label v-if="config.videoSubtitleAppearance.position === 'bottom'" class="subtitle-switch-row subtitle-auto-bottom-toggle">
              <span>{{ translateControlLabel('移动端 / X 自动贴底') }}</span>
              <el-switch v-model="config.videoSubtitleAppearance.autoBottom" class="settings-toggle" :aria-label="translateControlLabel('移动端 / X 自动贴底')" />
            </label>
          </div>

          <div class="subtitle-control-card">
            <strong class="subtitle-control-card-title">颜色、轮廓与背景</strong>
            <div class="subtitle-color-row">
              <label class="subtitle-color-chip">
                <span>原文颜色</span>
                <ElColorPicker :model-value="config.videoSubtitleAppearance.textColor" aria-label="原文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.textColor = value }" />
              </label>
              <label class="subtitle-color-chip">
                <span>译文颜色</span>
                <ElColorPicker :model-value="config.videoSubtitleAppearance.translationColor" aria-label="译文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.translationColor = value }" />
              </label>
            </div>
            <div class="subtitle-outline-row">
              <label class="subtitle-outline-style">
                <span>{{ t('video.appearance.outlineStyle') }}</span>
                <UiSelect v-model="config.videoSubtitleAppearance.outlineStyle" :aria-label="t('video.appearance.outlineStyle')">
                  <ElOption value="skin" :label="t('video.appearance.outlineStyle.skin')" />
                  <ElOption value="stroke" :label="t('video.appearance.outlineStyle.stroke')" />
                  <ElOption value="shadow" :label="t('video.appearance.outlineStyle.shadow')" />
                  <ElOption value="none" :label="t('video.appearance.outlineStyle.none')" />
                </UiSelect>
              </label>
              <label class="subtitle-color-chip" :class="{ disabled: !customOutlineAvailable }">
                <span>{{ t('video.appearance.outlineColor') }}</span>
                <ElColorPicker :model-value="config.videoSubtitleAppearance.outlineColor" :aria-label="t('video.appearance.outlineColor')" :disabled="!customOutlineAvailable" show-alpha color-format="hex" @update:model-value="value => { if (value) config.videoSubtitleAppearance.outlineColor = value }" />
              </label>
            </div>
            <label class="subtitle-slider-field" :class="{ disabled: !customOutlineAvailable }">
              <span class="subtitle-field-head"><span>{{ t('video.appearance.outlineWidth') }}</span><b>{{ config.videoSubtitleAppearance.outlineWidth }}px</b></span>
              <input v-model.number="config.videoSubtitleAppearance.outlineWidth" type="range" :min="VIDEO_SUBTITLE_OUTLINE_WIDTH_RANGE.min" :max="VIDEO_SUBTITLE_OUTLINE_WIDTH_RANGE.max" :step="VIDEO_SUBTITLE_OUTLINE_WIDTH_RANGE.step" :aria-label="t('video.appearance.outlineWidth')" :disabled="!customOutlineAvailable" />
            </label>
            <label class="subtitle-switch-row subtitle-background-toggle">
              <span>{{ t('video.appearance.backgroundVisible') }}</span>
              <el-switch v-model="config.videoSubtitleAppearance.backgroundVisible" class="settings-toggle" :aria-label="t('video.appearance.backgroundVisible')" />
            </label>
            <label class="subtitle-slider-field" :class="{ disabled: !config.videoSubtitleAppearance.backgroundVisible }">
              <span class="subtitle-field-head"><span>背景透明度</span><b>{{ config.videoSubtitleAppearance.backgroundOpacity }}%</b></span>
              <input v-model.number="config.videoSubtitleAppearance.backgroundOpacity" type="range" min="0" max="95" step="1" aria-label="字幕背景透明度" :disabled="!config.videoSubtitleAppearance.backgroundVisible" />
            </label>
          </div>
        </div>
      </details>
    </SettingsPreviewLayout>
  </SettingsGroup>
</template>

<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption, ElColorPicker} from 'element-plus';
import 'element-plus/es/components/color-picker/style/css';
import {useUiI18n as useControlI18n} from '@/src/ui/i18n';
const {t, translateLegacy: translateControlLabel} = useControlI18n();

import {computed, nextTick} from 'vue';
import type {CSSProperties} from 'vue';
import type {Config} from '@/src/core/config/model';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {
  DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
  VIDEO_SUBTITLE_FONT_SCALE_RANGE,
  VIDEO_SUBTITLE_OUTLINE_WIDTH_RANGE,
  normalizeVideoSubtitleAppearance,
  getVideoSubtitleAppearanceCssVars,
  VIDEO_SUBTITLE_SKINS,
} from '@/src/core/config/videoSubtitleAppearance';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import SettingsPreviewLayout from './components/SettingsPreviewLayout.vue';

const props = defineProps<{config: Config}>();
const config = computed(() => props.config);
const displayModeOptions = [{value: 'bilingual', label: '双语'}, {value: 'translation-only', label: '仅译文'}, {value: 'original-only', label: '仅原文'}];
const bilingualOrderOptions = computed(() => [{value: 'original-first', label: t('video.originalFirst')}, {value: 'translation-first', label: t('video.translationFirst')}]);
const customOutlineAvailable = computed(() => config.value.videoSubtitleAppearance.outlineStyle === 'stroke' || config.value.videoSubtitleAppearance.outlineStyle === 'shadow');
const subtitlesAvailable = computed(() => config.value.videoTranslationEnabled && config.value.videoSubtitleVisible);
const orderAvailable = computed(() => subtitlesAvailable.value && config.value.videoSubtitleDisplayMode === 'bilingual');
const readingAvailable = computed(() => subtitlesAvailable.value && browserCapabilities.extensionDom);
const readingNeedsOriginal = computed(() => browserCapabilities.extensionDom && config.value.videoSubtitleAppearance.readingAnnotation && config.value.videoSubtitleDisplayMode === 'translation-only');
const readingDescription = computed(() => t(!browserCapabilities.extensionDom ? 'video.readingAnnotation.unavailable'
  : config.value.videoSubtitleDisplayMode === 'translation-only' ? 'video.readingAnnotation.originalRequired' : 'video.readingAnnotation.explanation'));
const previewStyle = computed(() => getVideoSubtitleAppearanceCssVars(config.value.videoSubtitleAppearance) as CSSProperties);
const previewOrder = computed(() => config.value.videoSubtitleAppearance.bilingualOrder === 'translation-first' ? ['translation', 'original'] : ['original', 'translation']);
const previewOriginal = computed(() => config.value.videoSubtitleAppearance.readingAnnotation ? '今日はいい天気ですね。' : 'Video subtitle preview');
const previewTranslation = computed(() => config.value.videoSubtitleAppearance.readingAnnotation ? t('video.readingAnnotation.previewTranslation') : translateControlLabel('视频字幕预览'));

const currentSkin = computed(() => VIDEO_SUBTITLE_SKINS.find(item => item.id === config.value.videoSubtitleAppearance.skin) ?? VIDEO_SUBTITLE_SKINS[0]);
const currentSkinLabel = computed(() => currentSkin.value.label);
const advancedCustomized = computed(() => {
  const a = config.value.videoSubtitleAppearance;
  const s = currentSkin.value;
  return a.fontScale !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.fontScale
    || a.position !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.position
    || a.bottomOffset !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.bottomOffset
    || a.autoBottom !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.autoBottom
    || a.lineSpacing !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.lineSpacing
    || a.maxWidth !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.maxWidth
    || a.outlineStyle !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.outlineStyle
    || a.backgroundVisible !== DEFAULT_VIDEO_SUBTITLE_APPEARANCE.backgroundVisible
    || a.backgroundOpacity !== s.backgroundOpacity
    || a.textColor.toLowerCase() !== s.textColor.toLowerCase()
    || a.translationColor.toLowerCase() !== s.translationColor.toLowerCase();
});

async function showReading(event: MouseEvent): Promise<void> {
  if (!readingAvailable.value || !readingNeedsOriginal.value) return;
  const button = event.currentTarget as HTMLButtonElement;
  const focusRoot = button.getRootNode() as Document | ShadowRoot;
  const controls = button.closest('.subtitle-display-preferences');
  const keepKeyboardFocus = focusRoot.activeElement === button;
  config.value.videoSubtitleDisplayMode = 'bilingual';
  if (!keepKeyboardFocus) return;
  await nextTick();
  if (controls?.isConnected && (!focusRoot.activeElement || focusRoot.activeElement === button || focusRoot.activeElement === button.ownerDocument.body)) {
    controls.querySelector<HTMLButtonElement>('[data-video-subtitle-display-mode] [aria-checked="true"]')?.focus();
  }
}

function updateFontScale(event: Event): void {
  const input = event.target as HTMLInputElement;
  config.value.videoSubtitleAppearance.fontScale = normalizeVideoSubtitleAppearance({fontScale: input.value}).fontScale;
  input.value = String(config.value.videoSubtitleAppearance.fontScale);
}

function resetAppearance(): void {
  Object.assign(config.value.videoSubtitleAppearance, {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE});
}

function selectSkin(skinId: typeof VIDEO_SUBTITLE_SKINS[number]['id']): void {
  const skin = VIDEO_SUBTITLE_SKINS.find((item) => item.id === skinId)!;
  Object.assign(config.value.videoSubtitleAppearance, {
    skin: skin.id,
    textColor: skin.textColor,
    translationColor: skin.translationColor,
    backgroundOpacity: skin.backgroundOpacity,
  });
}

function skinSwatchStyle(skin: typeof VIDEO_SUBTITLE_SKINS[number]): Record<string, string> {
  return {
    color: skin.textColor,
    background: `rgba(${skin.background}, ${skin.backgroundOpacity / 100})`,
    borderColor: skin.border,
    boxShadow: skin.shadow,
    fontFamily: skin.fontFamily,
    textShadow: skin.textShadow,
    WebkitTextStroke: skin.textStroke,
    '--skin-translation-color': skin.translationColor,
  };
}
</script>

<style scoped>
.video-subtitle-appearance-group :deep(.settings-group-body) { overflow: clip; }
.video-subtitle-appearance-panel { grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.15fr); }
.appearance-reset-button {
  margin-left: auto;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--brand-strong);
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease;
}
.appearance-reset-button:hover { border-color: var(--brand); background: var(--brand-soft); }
.appearance-reset-button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* 预览场景 */
.subtitle-preview-scene {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: radial-gradient(circle at 26% 24%, #354965, #141b2a 58%, #2a1d32);
}
.subtitle-live-preview {
  position: absolute; left: 50%; display: grid; justify-items: center; gap: 3px; box-sizing: border-box;
  width: min(96%, var(--fluent-read-video-subtitle-max-width)); max-height: calc(100% - 24px); overflow: auto; overflow-wrap: anywhere;
  max-width: var(--fluent-read-video-subtitle-max-width); padding: 8px 12px;
  border: 1px solid var(--fluent-read-video-subtitle-border); border-radius: 6px;
  color: var(--fluent-read-video-subtitle-text-color); background: var(--fluent-read-video-subtitle-background);
  box-shadow: var(--fluent-read-video-subtitle-shadow); backdrop-filter: var(--fluent-read-video-subtitle-backdrop-filter);
  font-family: var(--fluent-read-video-subtitle-font-family); font-size: var(--fluent-read-video-subtitle-preview-font-size);
  line-height: var(--fluent-read-video-subtitle-line-spacing);
  -webkit-text-stroke: var(--fluent-read-video-subtitle-text-stroke); text-shadow: var(--fluent-read-video-subtitle-text-shadow);
  paint-order: stroke fill; transform: translateX(-50%);
}
.subtitle-preview-scene[data-position="bottom"] .subtitle-live-preview { max-height: calc(100% - var(--fluent-read-video-subtitle-bottom-offset) - 12px); bottom: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-preview-scene[data-position="bottom"][data-auto-bottom="true"] .subtitle-live-preview { max-height: calc(100% - 24px); bottom: 12px; }
.subtitle-preview-scene[data-position="center"] .subtitle-live-preview { top: 50%; transform: translate(-50%, -50%); }
.subtitle-preview-scene[data-position="top"] .subtitle-live-preview { max-height: calc(100% - var(--fluent-read-video-subtitle-bottom-offset) - 12px); top: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-live-preview > span { order: 1; color: var(--fluent-read-video-subtitle-text-color); }
.subtitle-live-preview > span, .subtitle-live-preview > b { paint-order: stroke fill; }
.subtitle-live-preview b { order: var(--fluent-read-video-subtitle-translation-order, 3); color: var(--fluent-read-video-subtitle-translation-color); font-size: var(--fluent-read-video-subtitle-translation-font-scale, 100%); font-weight: 650; }
.subtitle-live-preview .subtitle-preview-reading { order: 2; color: var(--fluent-read-video-subtitle-text-color); font-size: max(12px, .72em); font-weight: 400; line-height: 1.35; overflow-wrap: anywhere; text-align: center; -webkit-text-stroke: 0; }
.subtitle-preview-hidden { position: absolute; inset: 0; display: grid; place-items: center; color: #d1d5db; font-size: 13px; }
.subtitle-appearance-hint { margin: 10px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }

/* 核心显示设置 */
.subtitle-display-preferences { margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.subtitle-display-preferences :deep(.settings-item) {
  min-height: 46px;
  padding: 10px 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}
.subtitle-display-preferences :deep(.settings-item:first-child) { padding-top: 0; }
.subtitle-display-preferences :deep(.settings-item-control) { width: auto; }
.subtitle-display-preferences :deep(.settings-item.subtitle-order-item),
.subtitle-display-preferences :deep(.settings-item.subtitle-mode-item) {
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.subtitle-display-preferences :deep(.settings-item.subtitle-order-item .settings-item-control),
.subtitle-display-preferences :deep(.settings-item.subtitle-mode-item .settings-item-control) {
  width: 100%;
  justify-content: stretch;
}
.subtitle-reading-show-original { padding: 0; border: 0; color: var(--brand-strong); background: transparent; cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 3px; }
.subtitle-reading-show-original:disabled { cursor: not-allowed; opacity: .55; }

/* 紧凑 4 列皮肤选择器 */
.subtitle-skin-section { display: grid; gap: 10px; }
.appearance-panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.appearance-panel-heading strong { color: var(--ink); font-size: 13px; font-weight: 600; }
.appearance-panel-heading span { color: var(--muted); font-size: 11.5px; }
.subtitle-skin-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.subtitle-skin-option {
  display: grid; gap: 6px; min-width: 0; padding: 6px;
  border: 1px solid var(--line); border-radius: 10px;
  color: var(--ink); background: var(--surface); text-align: center; cursor: pointer; font: inherit;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}
.subtitle-skin-option:hover { border-color: color-mix(in srgb, var(--brand) 50%, var(--line)); }
.subtitle-skin-option.selected { border-color: var(--brand); background: var(--brand-soft); box-shadow: inset 0 0 0 1px var(--brand); }
.subtitle-skin-option:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.subtitle-skin-option strong { font-size: 11.5px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subtitle-skin-option.selected strong { color: var(--brand-strong); }
.subtitle-skin-stage {
  display: grid; place-items: center; padding: 8px 6px; border-radius: 7px;
  background: linear-gradient(145deg, #27344a, #141b27);
}
.subtitle-skin-swatch {
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  min-width: 72%; max-width: 100%; padding: 4px 10px; border: 1px solid transparent; border-radius: 5px;
  font-size: 11px; line-height: 1.25; box-sizing: border-box;
}
.subtitle-skin-swatch b, .subtitle-skin-swatch em { paint-order: stroke fill; font-style: normal; }
.subtitle-skin-swatch b { font-weight: 600; }
.subtitle-skin-swatch em { color: var(--skin-translation-color); font-size: 10px; font-weight: 600; }

/* L2 默认折叠的微调区 */
.subtitle-appearance-advanced {
  margin-top: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
  overflow: hidden;
}
.subtitle-appearance-advanced > summary {
  display: flex; align-items: center; justify-content: flex-start; gap: 8px;
  padding: 11px 14px !important; border: 0 !important; border-radius: 0 !important;
  background: transparent !important; font-size: 12.5px; font-weight: 600;
}
.subtitle-appearance-advanced > summary small { margin-left: auto; color: var(--muted); font-size: 11.5px; font-weight: 500; }
.subtitle-appearance-advanced[open] > summary { margin-bottom: 0 !important; border-bottom: 1px solid var(--line) !important; }

.subtitle-appearance-controls { display: grid; gap: 12px; padding: 12px; }
.subtitle-control-card {
  display: grid; gap: 12px; padding: 12px 14px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
}
.subtitle-control-card-title { color: var(--ink); font-size: 12px; font-weight: 650; }
.subtitle-slider-field { display: grid; gap: 6px; min-width: 0; color: var(--ink); font-size: 12px; }
.subtitle-slider-field.disabled, .subtitle-color-chip.disabled { opacity: .5; pointer-events: none; }
.subtitle-field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.subtitle-field-head span { color: var(--muted); font-size: 11.5px; }
.subtitle-field-head b { color: var(--ink); font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.subtitle-slider-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.subtitle-slider-field input[type="range"] { width: 100%; min-width: 0; margin: 0; accent-color: var(--brand); cursor: pointer; }
.subtitle-percent-pill {
  display: inline-flex; align-items: center; gap: 2px; flex: none; width: 72px;
  padding: 4px 7px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--surface-soft); color: var(--ink); font-size: 11.5px;
}
.subtitle-percent-pill input {
  width: 100%; min-width: 0; border: 0; outline: 0; padding: 0;
  background: transparent; color: inherit; font: inherit; text-align: right; font-variant-numeric: tabular-nums;
}
.subtitle-percent-pill:focus-within { border-color: var(--brand); outline: 2px solid var(--brand-soft); }
.subtitle-compact-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
.subtitle-inline-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--muted); }
.subtitle-inline-field :deep(.el-select) { max-width: 180px; }
.subtitle-switch-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 32px; color: var(--ink); font-size: 12px; cursor: pointer;
}
.subtitle-color-row, .subtitle-outline-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: end; }
.subtitle-color-chip {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 38px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-soft); color: var(--ink); font-size: 11.5px; cursor: pointer;
}
.subtitle-outline-style { display: grid; gap: 5px; color: var(--muted); font-size: 11.5px; }

/* 逐字高亮动画 */
.subtitle-preview-karaoke { position: relative; --subtitle-preview-karaoke-color: var(--fluent-read-video-subtitle-text-color); color: color-mix(in srgb, var(--subtitle-preview-karaoke-color) 46%, transparent) !important; }
b.subtitle-preview-karaoke { --subtitle-preview-karaoke-color: var(--fluent-read-video-subtitle-translation-color); }
.subtitle-preview-karaoke::after { position: absolute; inset: 0; color: var(--subtitle-preview-karaoke-color); text-shadow: none; content: attr(data-text); content: attr(data-text) / ""; animation: subtitle-preview-karaoke 3.6s linear infinite; }
@keyframes subtitle-preview-karaoke {
  0% { clip-path: inset(-.3em 100% -.3em -.3em); }
  78%, 100% { clip-path: inset(-.3em -.3em -.3em -.3em); }
}

@media (max-width: 960px) {
  .video-subtitle-appearance-panel { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .subtitle-skin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .subtitle-compact-pair, .subtitle-color-row, .subtitle-outline-row { grid-template-columns: minmax(0, 1fr); }
}
</style>
