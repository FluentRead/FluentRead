<!--
 * @file src/features/settings/ui/VideoSentenceLearningAppearanceSettings.vue
 * 文件职责：在界面风格中心独立提供完整句学习的外观设置，左侧预览、右侧调整。
 * 主要内容：复用品牌粉与深灰面板，实时展示紧凑或舒适布局、背景不透明度、字号、宽度和默认四角位置；恢复默认只改变该面板配置。
 * 模块边界：只编辑父级传入的 Config 草稿，保存和重开持久化沿用设置中心既有配置管线；预览不播放视频、不发送翻译请求，不保存拖动位置。
 -->
<template>
  <SettingsGroup class="video-learning-appearance-group" id="video-sentence-learning-appearance" :title="t('video.learningAppearance.title')" :description="t('video.learningAppearance.description')" data-settings-anchor="video-learning" :data-settings-anchor-label="t('video.learningAppearance.title')" data-video-sentence-learning-appearance>
    <template #heading-extra>
      <button type="button" class="learning-appearance-reset" data-video-learning-reset @click="resetAppearance">{{ t('video.learningAppearance.reset') }}</button>
    </template>
    <SettingsPreviewLayout :label="t('video.learningAppearance.preview')" sticky-preview>
      <template #preview>
        <div class="learning-preview-scene" :data-position="appearance.position" :data-layout="appearance.layout" data-video-learning-preview-scene>
          <span class="learning-preview-video-label" aria-hidden="true">Sea otters</span>
          <div class="learning-preview-card" :data-layout="appearance.layout" :style="previewStyle" data-video-learning-preview>
            <header><strong><i aria-hidden="true" /><span>{{ t('video.learning.title') }}</span></strong><span class="learning-preview-header-actions" aria-hidden="true"><span class="learning-preview-header-tools"><span>?</span><span>☷</span><span>⌃</span><span>×</span></span></span></header>
            <div class="learning-preview-content">
              <span class="learning-preview-meta">3 / 24 · 0:12–0:16</span>
              <p class="learning-preview-original" data-i18n-ignore>Sea otters have strong teeth.</p>
              <p class="learning-preview-translation">{{ t('video.learningAppearance.sampleTranslation') }}</p>
              <span class="learning-preview-follow">{{ t('video.learning.follow') }}</span>
              <span class="learning-preview-mode-caption">{{ t('video.learning.mode') }}</span>
              <div class="learning-preview-assistance" aria-hidden="true"><span class="selected">{{ t('video.learning.normal') }}</span><span>{{ t('video.learning.loop') }}</span><span>{{ t('video.learning.pause') }}</span></div>
              <div class="learning-preview-replay" aria-hidden="true" data-video-learning-preview-playback><span>‹</span><strong>▷ {{ t('video.learning.replay') }}</strong><span>›</span></div>
            </div>
            <footer aria-hidden="true"><span>{{ t('video.learning.explain') }}</span><strong>{{ t('video.learning.save') }}</strong></footer>
          </div>
        </div>
      </template>
      <div class="learning-appearance-controls">
        <SettingsItem stacked :label="t('video.learningAppearance.layout')">
          <SegmentedControl v-model="appearance.layout" :options="layoutOptions" :label="t('video.learningAppearance.layout')" data-video-learning-layout />
        </SettingsItem>
        <label class="learning-appearance-range"><span>{{ t('video.learningAppearance.opacity') }}<b>{{ appearance.backgroundOpacity }}%</b></span><input v-model.number="appearance.backgroundOpacity" type="range" :min="ranges.backgroundOpacity.min" :max="ranges.backgroundOpacity.max" step="1" :aria-label="t('video.learningAppearance.opacity')" data-video-learning-opacity /></label>
        <label class="learning-appearance-range"><span>{{ t('video.learningAppearance.fontScale') }}<b>{{ appearance.fontScale }}%</b></span><input v-model.number="appearance.fontScale" type="range" :min="ranges.fontScale.min" :max="ranges.fontScale.max" step="1" :aria-label="t('video.learningAppearance.fontScale')" data-video-learning-font-scale /></label>
        <label class="learning-appearance-range"><span>{{ t('video.learningAppearance.width') }}<b>{{ appearance.width }} px</b></span><input v-model.number="appearance.width" type="range" :min="ranges.width.min" :max="ranges.width.max" step="10" :aria-label="t('video.learningAppearance.width')" data-video-learning-width /></label>
        <div class="learning-appearance-position">
          <strong>{{ t('video.learningAppearance.position') }}</strong>
          <div class="learning-position-grid" role="radiogroup" :aria-label="t('video.learningAppearance.position')">
            <button v-for="position in positionOptions" :key="position.value" type="button" role="radio" :class="{selected: appearance.position === position.value}" :aria-checked="appearance.position === position.value" :data-video-learning-position="position.value" @click="appearance.position = position.value">{{ position.label }}</button>
          </div>
          <p class="learning-appearance-hint">{{ t('video.learningAppearance.dragHint') }}</p>
        </div>
      </div>
    </SettingsPreviewLayout>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {computed, type CSSProperties} from 'vue';
import type {Config} from '@/src/core/config/model';
import {DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE, VIDEO_SENTENCE_LEARNING_APPEARANCE_RANGES, getVideoSentenceLearningAppearanceCssVars, type VideoSentenceLearningPosition} from '@/src/core/config/videoSentenceLearningAppearance';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SettingsPreviewLayout from './components/SettingsPreviewLayout.vue';
import SegmentedControl from './components/SegmentedControl.vue';

const props = defineProps<{config: Config}>();
const {t} = useUiI18n();
// 保存或恢复历史会替换整份草稿；继续绑定当前 prop，避免修改旧对象。
const appearance = computed(() => props.config.videoSentenceLearningAppearance);
const ranges = VIDEO_SENTENCE_LEARNING_APPEARANCE_RANGES;
const previewStyle = computed(() => getVideoSentenceLearningAppearanceCssVars(appearance.value) as CSSProperties);
const layoutOptions = computed(() => ['compact', 'comfortable'].map(value => ({value, label: t(`video.learningAppearance.${value}`)})));
const positionOptions = computed(() => (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as VideoSentenceLearningPosition[]).map(value => ({value, label: t(`video.learningAppearance.${value}`)})));
function resetAppearance(): void {Object.assign(appearance.value, DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);}
</script>
<style scoped>
.video-learning-appearance-group :deep(.settings-group-body) { overflow:clip; }
.learning-preview-scene { position:relative; min-height:400px; overflow:hidden; border:1px solid var(--line); border-radius:12px; background:linear-gradient(160deg,#193b48,#14212a 52%,#697470); }
.learning-preview-scene[data-layout="comfortable"] { min-height:460px; }
.learning-preview-scene::before { position:absolute; inset:62% -10% -18%; border-radius:50%; background:linear-gradient(145deg,#76877b,#384f58); content:''; }
.learning-preview-video-label { position:absolute; left:20px; bottom:18px; color:#fff; font-size:20px; opacity:.9; }
.learning-preview-card { position:absolute; top:12px; right:12px; box-sizing:border-box; width:min(calc(var(--fluent-read-video-learning-width) * .75),calc(100% - 24px)); overflow:hidden; border:1px solid rgba(255,255,255,.13); border-radius:12px; color:#f1f1f3; background:var(--fluent-read-video-learning-background); box-shadow:0 8px 24px rgba(0,0,0,.25); font-family:system-ui,sans-serif; font-size:13px; line-height:var(--fluent-read-video-learning-line-height); }
.learning-preview-scene[data-position="top-left"] .learning-preview-card { right:auto; left:12px; }
.learning-preview-scene[data-position="bottom-left"] .learning-preview-card { top:auto; right:auto; bottom:12px; left:12px; }
.learning-preview-scene[data-position="bottom-right"] .learning-preview-card { top:auto; bottom:12px; }
.learning-preview-card header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px var(--fluent-read-video-learning-padding); border-bottom:1px solid rgba(255,255,255,.1); }
.learning-preview-card header strong { display:flex; align-items:center; gap:6px; min-width:0; font-weight:600; }
.learning-preview-card header strong span { min-width:0; overflow-wrap:anywhere; }
.learning-preview-header-actions { flex:none; }
.learning-preview-card header i { width:6px; height:6px; flex:none; border-radius:50%; background:#ef4776; }
.learning-preview-card header > span,.learning-preview-meta { color:#b5b5bd; font-size:.85em; }
.learning-preview-header-actions,.learning-preview-header-tools { display:flex; align-items:center; gap:2px; }
.learning-preview-header-actions span > :is(span,b) { display:inline-flex; align-items:center; justify-content:center; width:16px; min-width:16px; height:22px; font-size:12px; font-weight:400; }
.learning-preview-card[data-layout="compact"] .learning-preview-mode-caption { display:none; }
.learning-preview-follow,.learning-preview-mode-caption { color:#b5b5bd; font-size:11px; }
.learning-preview-content { display:grid; gap:var(--fluent-read-video-learning-gap); padding:var(--fluent-read-video-learning-padding); }
.learning-preview-card p { margin:0; overflow-wrap:anywhere; }
.learning-preview-original { font-size:var(--fluent-read-video-learning-original-font-size); font-weight:550; }
.learning-preview-translation { color:#d5d5db; font-size:var(--fluent-read-video-learning-font-size); }
.learning-preview-replay { display:grid; grid-template-columns:24px minmax(0,1fr) 24px; align-items:center; gap:6px; text-align:center; }
.learning-preview-replay strong { padding:5px; border:1px solid rgba(239,71,118,.3); border-radius:7px; color:#ffb3c6; background:rgba(239,71,118,.17); font-size:.9em; }
.learning-preview-assistance { display:flex; align-items:center; justify-content:space-between; gap:2px; padding:3px; border-radius:7px; color:#c4c4cb; background:rgba(0,0,0,.2); font-size:.8em; }
.learning-preview-assistance span { padding:3px 6px; }
.learning-preview-assistance .selected { border-radius:5px; background:rgba(255,255,255,.12); }
.learning-preview-card footer { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; align-items:center; padding:8px var(--fluent-read-video-learning-padding); border-top:1px solid rgba(255,255,255,.1); text-align:center; font-size:.85em; }
.learning-preview-card footer span,.learning-preview-card footer strong { padding:5px 2px; border:1px solid rgba(255,255,255,.15); border-radius:6px; }
.learning-preview-card footer strong { border-color:#ef4776; color:#fff; background:#ef4776; font-weight:550; }
.learning-appearance-hint { margin:10px 0 0; color:var(--muted); font-size:11px; line-height:1.5; }
.learning-appearance-controls { display:grid; gap:18px; }
.learning-appearance-controls :deep(.settings-item) { padding:0; border:0; }
.learning-appearance-controls :deep(.settings-item-control) { justify-content:flex-end; }
.learning-appearance-range { display:grid; gap:9px; }
.learning-appearance-range > span { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--ink); font-size:12px; }
.learning-appearance-range b { color:var(--muted); font-size:11px; font-weight:500; }
.learning-appearance-range input { width:100%; margin:0; accent-color:var(--brand); cursor:pointer; }
.learning-appearance-position > strong { color:var(--ink); font-size:12px; font-weight:500; }
.learning-position-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; margin-top:10px; }
.learning-position-grid button { padding:8px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:var(--surface-soft); cursor:pointer; font-size:12px; }
.learning-position-grid button.selected { border-color:var(--brand); color:var(--brand-strong); background:color-mix(in srgb,var(--brand) 10%,var(--surface)); }
.learning-position-grid button:focus-visible,.learning-appearance-reset:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.learning-appearance-reset { margin-left:auto; padding:5px 10px; border:1px solid var(--line); border-radius:8px; color:var(--brand-strong); background:var(--surface); cursor:pointer; font:inherit; font-size:12px; font-weight:600; }
.learning-appearance-reset:hover { border-color:var(--brand); background:var(--brand-soft); }
</style>
