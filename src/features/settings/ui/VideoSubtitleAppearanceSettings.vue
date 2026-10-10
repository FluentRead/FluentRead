<!--
 * @file src/features/settings/ui/VideoSubtitleAppearanceSettings.vue
 * 文件职责：提供视频字幕外观设置，并用同一套 CSS 变量展示隔离的实时预览。
 * 主要内容：左侧在等高预览区内用正常视频比例呈现字幕样式，滚动调整时保持预览可见；右侧选择显示内容、皮肤并按字号与位置、颜色与布局分组调整字幕，字号允许 80–500% 与整数自定义输入，支持恢复默认并保留所有外观配置。
 * 模块边界：只编辑传入 Config 草稿；保存由 SettingsSections 统一处理，播放器实际应用由 content 层负责。
 -->
<template>
  <SettingsGroup class="video-subtitle-appearance-group" title="视频字幕外观" description="外观只影响 FluentRead 字幕，不改变 YouTube/X 原生字幕">
    <SettingsPreviewLayout class="video-subtitle-appearance-panel" label="视频字幕效果预览" sticky-preview data-video-subtitle-appearance>
      <template #preview>
        <div class="subtitle-preview-scene" :data-position="config.videoSubtitleAppearance.position" :data-auto-bottom="config.videoSubtitleAppearance.autoBottom" data-video-subtitle-preview-scene>
        <div v-if="config.videoSubtitleVisible" class="subtitle-live-preview" :style="previewStyle" data-video-subtitle-preview>
          <span v-if="config.videoSubtitleDisplayMode !== 'translation-only'" data-i18n-ignore>Video subtitle preview</span>
          <b v-if="config.videoSubtitleDisplayMode !== 'original-only'" data-i18n-ignore>视频字幕预览</b>
        </div>
        <span v-else class="subtitle-preview-hidden">字幕已隐藏</span>
      </div>
        <p class="subtitle-appearance-hint">切换显示内容、皮肤或位置，左侧示例立即更新</p>
      </template>
      <div class="subtitle-display-preferences">
        <SettingsItem label="显示 FluentRead 字幕" description="临时隐藏字幕时保留翻译设置" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoSubtitleVisible" aria-label="显示 FluentRead 视频字幕" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem label="字幕显示模式" description="选择原文和译文的呈现方式" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible">
          <SegmentedControl v-model="config.videoSubtitleDisplayMode" :options="displayModeOptions" label="视频字幕显示模式" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible" />
        </SettingsItem>
      </div>
      <div class="appearance-panel-heading">
        <div><strong>字幕皮肤</strong><p>选择一个起点，再按需要微调</p></div>
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


      <div class="subtitle-appearance-advanced">
        <h3>微调字幕外观</h3>
        <p class="subtitle-appearance-hint">大多数视频使用默认值即可；只有位置或可读性不合适时再调整</p>
        <div class="subtitle-appearance-controls">
          <div class="subtitle-appearance-control-group">
            <strong>字号与位置</strong>
            <label><span>字号 <b>{{ config.videoSubtitleAppearance.fontScale }}%</b></span><input v-model.number="config.videoSubtitleAppearance.fontScale" type="range" :min="VIDEO_SUBTITLE_FONT_SCALE_RANGE.min" :max="VIDEO_SUBTITLE_FONT_SCALE_RANGE.max" step="10" aria-label="字幕字号" /><input :value="config.videoSubtitleAppearance.fontScale" type="number" :min="VIDEO_SUBTITLE_FONT_SCALE_RANGE.min" :max="VIDEO_SUBTITLE_FONT_SCALE_RANGE.max" step="1" :aria-label="translateControlLabel('字幕字号')" @change="updateFontScale" /></label>
            <label><span>位置</span><UiSelect v-model="config.videoSubtitleAppearance.position" aria-label="字幕位置"><ElOption value="bottom" :label="translateControlLabel('底部')" /><ElOption value="center" :label="translateControlLabel('中部')" /><ElOption value="top" :label="translateControlLabel('顶部')" /></UiSelect></label>
            <label><span>底部偏移 <b>{{ config.videoSubtitleAppearance.position === 'bottom' && config.videoSubtitleAppearance.autoBottom ? 'X 自动' : `${config.videoSubtitleAppearance.bottomOffset}%` }}</b></span><input v-model.number="config.videoSubtitleAppearance.bottomOffset" type="range" min="0" max="25" step="1" aria-label="字幕底部偏移" @input="config.videoSubtitleAppearance.autoBottom = false" /></label>
            <label v-if="config.videoSubtitleAppearance.position === 'bottom'"><span>X 字幕自动贴底</span><input v-model="config.videoSubtitleAppearance.autoBottom" type="checkbox" aria-label="X 字幕自动贴底" /></label>
          </div>
          <div class="subtitle-appearance-control-group">
            <strong>颜色与布局</strong>
            <label><span>原文颜色</span><ElColorPicker :model-value="config.videoSubtitleAppearance.textColor" aria-label="原文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.textColor = value }" /></label>
            <label><span>译文颜色</span><ElColorPicker :model-value="config.videoSubtitleAppearance.translationColor" aria-label="译文颜色" @update:model-value="value => { if (value) config.videoSubtitleAppearance.translationColor = value }" /></label>
            <label><span>背景透明度 <b>{{ config.videoSubtitleAppearance.backgroundOpacity }}%</b></span><input v-model.number="config.videoSubtitleAppearance.backgroundOpacity" type="range" min="0" max="95" step="1" aria-label="字幕背景透明度" /></label>
            <label><span>行距 <b>{{ config.videoSubtitleAppearance.lineSpacing.toFixed(2) }}</b></span><input v-model.number="config.videoSubtitleAppearance.lineSpacing" type="range" min="1" max="2" step="0.01" aria-label="字幕行距" /></label>
            <label><span>最大宽度 <b>{{ config.videoSubtitleAppearance.maxWidth }}%</b></span><input v-model.number="config.videoSubtitleAppearance.maxWidth" type="range" min="40" max="100" step="1" aria-label="字幕最大宽度" /></label>
          </div>
        </div>
      </div>
    </SettingsPreviewLayout>
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
  VIDEO_SUBTITLE_FONT_SCALE_RANGE,
  normalizeVideoSubtitleAppearance,
  getVideoSubtitleAppearanceCssVars,
  VIDEO_SUBTITLE_SKINS,
} from '@/src/core/config/videoSubtitleAppearance';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import SettingsPreviewLayout from './components/SettingsPreviewLayout.vue';

const props = defineProps<{config: Config}>();
// 设置页会整体替换草稿；始终读取最新 prop，避免卡片继续编辑旧配置。
const config = computed(() => props.config);
const displayModeOptions = [{value: 'bilingual', label: '双语'}, {value: 'translation-only', label: '仅译文'}, {value: 'original-only', label: '仅原文'}];
const previewStyle = computed(() => getVideoSubtitleAppearanceCssVars(config.value.videoSubtitleAppearance) as CSSProperties);

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

/* 保留圆角裁切，同时让固定预览跟随外层设置工作区滚动。 */
.video-subtitle-appearance-group :deep(.settings-group-body) { overflow:clip; }
.appearance-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.appearance-panel-heading strong { color: var(--ink); font-size: 13px; }
.appearance-panel-heading p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.appearance-reset-button { border: 0; color: var(--brand-strong); background: transparent; font-size: 11px; cursor: pointer; }
.subtitle-skin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.subtitle-skin-option { display: grid; gap: 5px; min-width: 0; padding: 8px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); background: var(--surface-soft); text-align: left; cursor: pointer; }
.subtitle-skin-option.selected { border-color: var(--brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 18%, transparent); }
.subtitle-skin-option strong { font-size: 11px; }
.subtitle-skin-option small { color: var(--muted); font-size: 10px; line-height: 1.35; }
.subtitle-skin-swatch { display: flex; align-items: baseline; justify-content: space-between; padding: 7px; border-radius: 7px; color: #fff; background: rgba(16, 18, 24, .72); font-size: 13px; }
.subtitle-skin-swatch b, .subtitle-skin-swatch em { paint-order: stroke fill; }
.subtitle-skin-swatch em { color: var(--skin-translation-color); font-size: 10px; font-style: normal; }
.subtitle-skin-swatch[data-skin="clean"] { color: #1f2937; background: rgba(255, 255, 255, .85); }
.subtitle-skin-swatch[data-skin="terminal"] { font-family: ui-monospace, monospace; background: rgba(4, 20, 16, .9); }
.subtitle-preview-scene { position: relative; aspect-ratio: 16 / 9; margin-top: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(135deg, #263449, #111827 58%, #4b3149); }
.subtitle-preview-scene::before { position: absolute; inset: 16% 12% auto; height: 34%; border-radius: 999px; background: rgba(255,255,255,.1); content: ''; filter: blur(18px); }
.subtitle-live-preview { position: absolute; left: 50%; display: grid; justify-items: center; gap: 3px; box-sizing: border-box; width: min(96%, var(--fluent-read-video-subtitle-max-width)); max-height: calc(100% - 24px); overflow: auto; overflow-wrap: anywhere; max-width: var(--fluent-read-video-subtitle-max-width); padding: 8px 12px; border: 1px solid var(--fluent-read-video-subtitle-border); border-radius: 6px; color: var(--fluent-read-video-subtitle-text-color); background: var(--fluent-read-video-subtitle-background); box-shadow: var(--fluent-read-video-subtitle-shadow); backdrop-filter: var(--fluent-read-video-subtitle-backdrop-filter); font-family: var(--fluent-read-video-subtitle-font-family); font-size: var(--fluent-read-video-subtitle-preview-font-size); line-height: var(--fluent-read-video-subtitle-line-spacing); -webkit-text-stroke: var(--fluent-read-video-subtitle-text-stroke); text-shadow: var(--fluent-read-video-subtitle-text-shadow); paint-order: stroke fill; transform: translateX(-50%); }
.subtitle-preview-scene[data-position="bottom"] .subtitle-live-preview { max-height:calc(100% - var(--fluent-read-video-subtitle-bottom-offset) - 12px); bottom: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-preview-scene[data-position="bottom"][data-auto-bottom="true"] .subtitle-live-preview { max-height:calc(100% - 24px); bottom: 12px; }
.subtitle-preview-scene[data-position="center"] .subtitle-live-preview { top: 50%; transform: translate(-50%, -50%); }
.subtitle-preview-scene[data-position="top"] .subtitle-live-preview { max-height:calc(100% - var(--fluent-read-video-subtitle-bottom-offset) - 12px); top: var(--fluent-read-video-subtitle-bottom-offset); }
.subtitle-live-preview > span { color: var(--fluent-read-video-subtitle-text-color); }
.subtitle-live-preview > span, .subtitle-live-preview > b { paint-order: stroke fill; }
.subtitle-live-preview b { color: var(--fluent-read-video-subtitle-translation-color); font-weight: 650; }
.subtitle-appearance-advanced { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
.subtitle-appearance-advanced h3 { margin:0; color:var(--ink); font-size:13px; }
.subtitle-appearance-hint { margin: 6px 0 0; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.subtitle-appearance-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding-top: 12px; }
.subtitle-appearance-control-group { display: grid; align-content: start; gap: 10px; min-width: 0; }
.subtitle-appearance-control-group > strong { color: var(--ink); font-size: 11px; }
.subtitle-appearance-controls label { display: grid; gap: 5px; color: var(--muted); font-size: 11px; }
.subtitle-appearance-controls label span { display: flex; justify-content: space-between; gap: 8px; }
.subtitle-appearance-controls b { color: var(--ink); font-weight: 650; }
.subtitle-appearance-controls input[type="range"] { width: 100%; accent-color: var(--brand); }
.subtitle-appearance-controls input[type="number"] { width: 100%; min-height: 30px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); }
.subtitle-appearance-controls select { min-height: 30px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); }
@media (max-width: 640px) {
  .subtitle-skin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .subtitle-appearance-controls { grid-template-columns: minmax(0, 1fr); }
}
.subtitle-display-preferences { margin-bottom:18px; border-bottom:1px solid var(--line); }
.subtitle-display-preferences :deep(.settings-item) { padding:0 0 16px; grid-template-columns:minmax(0,1fr) auto; gap:12px; }
.subtitle-display-preferences :deep(.settings-item + .settings-item) { grid-template-columns:minmax(0,1fr); }
.subtitle-display-preferences :deep(.settings-item-control) { width:100%; }
.subtitle-preview-hidden { position:absolute; inset:0; display:grid; place-items:center; color:#d1d5db; font-size:13px; }
.appearance-reset-button:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
</style>
