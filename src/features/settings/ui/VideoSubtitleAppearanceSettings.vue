<!--
 * @file src/features/settings/ui/VideoSubtitleAppearanceSettings.vue
 * 文件职责：提供视频原语言与字幕外观设置，并用同一套 CSS 变量展示隔离的实时预览。
 * 主要内容：选择可扩展皮肤、调整字号/颜色/位置/背景/行距/宽度和底部偏移，支持恢复默认。
 * 模块边界：只编辑传入 Config 草稿；保存由 SettingsSections 统一处理，播放器实际应用由 content 层负责。
 -->
<template>
  <SettingsGroup title="视频字幕外观" description="外观只影响 FluentRead 字幕，不改变 YouTube/X 原生字幕。">
    <div class="video-subtitle-appearance-panel" data-video-subtitle-appearance>
      <div class="appearance-panel-heading">
        <div><strong>字幕皮肤</strong><p>选择一个起点，再按需要微调。</p></div>
        <button type="button" class="appearance-reset-button" @click="resetAppearance">恢复默认</button>
      </div>
      <div class="subtitle-skin-grid" role="radiogroup" aria-label="视频字幕皮肤">
        <button
          v-for="skin in VIDEO_SUBTITLE_SKINS"
          :key="skin.id"
          type="button"
          class="subtitle-skin-option"
          :class="{ selected: config.videoSubtitleAppearance.skin === skin.id }"
          :aria-checked="config.videoSubtitleAppearance.skin === skin.id"
          role="radio"
          :data-skin="skin.id"
          @click="selectSkin(skin.id)"
        >
          <span class="subtitle-skin-swatch" :data-skin="skin.id" :style="skinSwatchStyle(skin)"><b>Ab</b><em>译文</em></span>
          <strong>{{ skin.label }}</strong>
          <small>{{ skin.description }}</small>
        </button>
      </div>

      <div class="subtitle-preview-scene" :data-position="config.videoSubtitleAppearance.position" :data-auto-bottom="config.videoSubtitleAppearance.autoBottom" data-video-subtitle-preview-scene>
        <div class="subtitle-live-preview" :style="previewStyle" data-video-subtitle-preview>
          <span>Video subtitle preview</span>
          <b>视频字幕预览</b>
        </div>
      </div>

      <details class="subtitle-appearance-advanced">
        <summary>高级调整</summary>
        <div class="subtitle-appearance-controls">
          <label><span>字号 <b>{{ config.videoSubtitleAppearance.fontScale }}%</b></span><input v-model.number="config.videoSubtitleAppearance.fontScale" type="range" min="80" max="160" step="10" aria-label="字幕字号" /></label>
          <label><span>底部偏移 <b>{{ config.videoSubtitleAppearance.position === 'bottom' && config.videoSubtitleAppearance.autoBottom ? 'X 自动' : `${config.videoSubtitleAppearance.bottomOffset}%` }}</b></span><input v-model.number="config.videoSubtitleAppearance.bottomOffset" type="range" min="0" max="25" step="1" aria-label="字幕底部偏移" @input="config.videoSubtitleAppearance.autoBottom = false" /></label>
          <label v-if="config.videoSubtitleAppearance.position === 'bottom'"><span>X 字幕自动贴底</span><input v-model="config.videoSubtitleAppearance.autoBottom" type="checkbox" aria-label="X 字幕自动贴底" /></label>
          <label><span>背景透明度 <b>{{ config.videoSubtitleAppearance.backgroundOpacity }}%</b></span><input v-model.number="config.videoSubtitleAppearance.backgroundOpacity" type="range" min="0" max="95" step="1" aria-label="字幕背景透明度" /></label>
          <label><span>行距 <b>{{ config.videoSubtitleAppearance.lineSpacing.toFixed(2) }}</b></span><input v-model.number="config.videoSubtitleAppearance.lineSpacing" type="range" min="1" max="2" step="0.01" aria-label="字幕行距" /></label>
          <label><span>最大宽度 <b>{{ config.videoSubtitleAppearance.maxWidth }}%</b></span><input v-model.number="config.videoSubtitleAppearance.maxWidth" type="range" min="40" max="100" step="1" aria-label="字幕最大宽度" /></label>
          <label><span>位置</span><UiSelect v-model="config.videoSubtitleAppearance.position" aria-label="字幕位置"><ElOption value="bottom" :label="translateControlLabel('底部')" /><ElOption value="center" :label="translateControlLabel('中部')" /><ElOption value="top" :label="translateControlLabel('顶部')" /></UiSelect></label>
          <label><span>原文颜色</span><ElColorPicker :model-value="config.videoSubtitleAppearance.textColor" aria-label="原文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.textColor = value }" /></label>
          <label><span>译文颜色</span><ElColorPicker :model-value="config.videoSubtitleAppearance.translationColor" aria-label="译文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.translationColor = value }" /></label>
        </div>
      </details>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption, ElColorPicker} from 'element-plus';
import 'element-plus/es/components/color-picker/style/css';
import {useUiI18n as useControlI18n} from '@/src/ui/i18n';
const {translateLegacy: translateControlLabel} = useControlI18n();

import {computed} from 'vue';
import type {CSSProperties} from 'vue';
import type {Config} from '@/src/core/config/model';
import {
  DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
  getVideoSubtitleAppearanceCssVars,
  VIDEO_SUBTITLE_SKINS,
} from '@/src/core/config/videoSubtitleAppearance';
import SettingsGroup from './components/SettingsGroup.vue';

const props = defineProps<{config: Config}>();
const config = props.config;
const previewStyle = computed(() => getVideoSubtitleAppearanceCssVars(config.videoSubtitleAppearance) as CSSProperties);

function resetAppearance(): void {
  Object.assign(config.videoSubtitleAppearance, {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE});
}

function selectSkin(skinId: typeof VIDEO_SUBTITLE_SKINS[number]['id']): void {
  const skin = VIDEO_SUBTITLE_SKINS.find((item) => item.id === skinId)!;
  Object.assign(config.videoSubtitleAppearance, {
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
.video-subtitle-appearance-panel { padding: 14px 16px 18px; border-top: 1px solid var(--line); }
.appearance-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.appearance-panel-heading strong { color: var(--ink); font-size: 13px; }
.appearance-panel-heading p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.appearance-reset-button { border: 0; color: var(--brand-strong); background: transparent; font-size: 11px; cursor: pointer; }
.subtitle-skin-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.subtitle-skin-option { display: grid; gap: 5px; min-width: 0; padding: 8px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); background: var(--surface-soft); text-align: left; cursor: pointer; }
.subtitle-skin-option.selected { border-color: var(--brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 18%, transparent); }
.subtitle-skin-option strong { font-size: 11px; }
.subtitle-skin-option small { color: var(--muted); font-size: 10px; line-height: 1.35; }
.subtitle-skin-swatch { display: flex; align-items: baseline; justify-content: space-between; padding: 7px; border-radius: 7px; color: #fff; background: rgba(16, 18, 24, .72); font-size: 13px; }
.subtitle-skin-swatch b, .subtitle-skin-swatch em { paint-order: stroke fill; }
.subtitle-skin-swatch em { color: var(--skin-translation-color); font-size: 10px; font-style: normal; }
.subtitle-skin-swatch[data-skin="clean"] { color: #1f2937; background: rgba(255, 255, 255, .85); }
.subtitle-skin-swatch[data-skin="terminal"] { font-family: ui-monospace, monospace; background: rgba(4, 20, 16, .9); }
.subtitle-preview-scene { position: relative; min-height: 180px; margin-top: 14px; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(135deg, #263449, #111827 58%, #4b3149); }
.subtitle-preview-scene::before { position: absolute; inset: 16% 12% auto; height: 34%; border-radius: 999px; background: rgba(255,255,255,.1); content: ''; filter: blur(18px); }
.subtitle-live-preview { position: absolute; left: 50%; display: grid; justify-items: center; gap: 3px; width: min(96%, var(--fluent-read-video-subtitle-max-width)); max-width: var(--fluent-read-video-subtitle-max-width); padding: 8px 12px; border: 1px solid var(--fluent-read-video-subtitle-border); border-radius: 6px; color: var(--fluent-read-video-subtitle-text-color); background: var(--fluent-read-video-subtitle-background); box-shadow: var(--fluent-read-video-subtitle-shadow); backdrop-filter: var(--fluent-read-video-subtitle-backdrop-filter); font-family: var(--fluent-read-video-subtitle-font-family); font-size: var(--fluent-read-video-subtitle-preview-font-size); line-height: var(--fluent-read-video-subtitle-line-spacing); -webkit-text-stroke: var(--fluent-read-video-subtitle-text-stroke); text-shadow: var(--fluent-read-video-subtitle-text-shadow); paint-order: stroke fill; transform: translateX(-50%); }
.subtitle-preview-scene[data-position="bottom"] .subtitle-live-preview { bottom: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-preview-scene[data-position="bottom"][data-auto-bottom="true"] .subtitle-live-preview { bottom: 12px; }
.subtitle-preview-scene[data-position="center"] .subtitle-live-preview { top: 50%; transform: translate(-50%, -50%); }
.subtitle-preview-scene[data-position="top"] .subtitle-live-preview { top: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-live-preview > span { color: var(--fluent-read-video-subtitle-text-color); }
.subtitle-live-preview > span, .subtitle-live-preview > b { paint-order: stroke fill; }
.subtitle-live-preview b { color: var(--fluent-read-video-subtitle-translation-color); font-weight: 650; }
.subtitle-appearance-advanced { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
.subtitle-appearance-advanced summary { color: var(--ink); font-size: 12px; cursor: pointer; }
.subtitle-appearance-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; padding-top: 12px; }
.subtitle-appearance-controls label { display: grid; gap: 5px; color: var(--muted); font-size: 11px; }
.subtitle-appearance-controls label span { display: flex; justify-content: space-between; gap: 8px; }
.subtitle-appearance-controls b { color: var(--ink); font-weight: 650; }
.subtitle-appearance-controls input[type="range"] { width: 100%; accent-color: var(--brand); }
.subtitle-appearance-controls select { min-height: 30px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); }
@media (max-width: 640px) { .subtitle-skin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
