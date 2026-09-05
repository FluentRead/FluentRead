<!--
 * @file src/features/settings/ui/VideoLocalModelSettings.vue
 * 文件职责：提供本地视频字幕模型选择与下载管理，向用户呈现模型是否可用。
 * 主要内容：常驻展示 Tiny/Base 下载卡片与视频缓存操作栏，呈现缓存读取、下载状态与错误反馈，并在组件卸载时移除存储监听。
 * 模块边界：通过视频 feature 公共配置和后台消息获取模型，不直接执行识别、下载模型权重或操作网页播放器。
 -->
<template>
  <SettingsItem label="视频原语言" description="X 视频字幕使用的原语言；自动检测适合大多数视频。">
    <el-select v-model="config.videoSourceLanguage" aria-label="视频原语言" :disabled="!config.videoTranslationEnabled" placeholder="请选择视频原语言">
      <el-option v-for="item in VIDEO_SOURCE_LANGUAGE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
    </el-select>
  </SettingsItem>
  <SettingsItem label="本地 AI 字幕模型" description="X 没有原生字幕时使用；模型和音频都保留在浏览器本地。" :disabled="!config.videoTranslationEnabled || !browserCapabilities.offscreenDocument">
    <el-select v-model="config.videoLocalModel" aria-label="本地 AI 字幕模型" :disabled="!config.videoTranslationEnabled || !browserCapabilities.offscreenDocument" placeholder="请选择本地模型">
      <el-option v-for="item in modelOptions" :key="item.value" class="select-left" :label="item.label" :value="item.value" />
    </el-select>
  </SettingsItem>
  <section class="video-model-management" aria-labelledby="video-model-management-title">
    <div class="video-model-download-heading">
      <div>
        <h3 id="video-model-management-title">下载本地模型</h3>
        <p class="video-model-status" role="status">{{ !modelStateLoaded ? '正在读取模型状态…' : downloaded.includes(config.videoLocalModel) ? '当前模型已下载，可直接生成。' : '选择下方模型下载，即可生成 AI 字幕。' }}</p>
      </div>
      <span class="video-model-local-badge"><Cpu aria-hidden="true" />本地运行</span>
    </div>
    <p v-if="!browserCapabilities.offscreenDocument" class="capability-warning" role="status">当前浏览器不支持本地 AI 字幕，无法下载或运行本地模型。</p>
    <div class="video-model-list" aria-label="本地 Whisper 模型下载">
      <article v-for="item in modelOptions" :key="item.value" class="video-model-card" :class="{ selected: item.value === config.videoLocalModel }">
        <div class="video-model-card-heading">
          <span class="video-model-icon" aria-hidden="true"><Cpu /></span>
          <strong>{{ item.label }}</strong>
          <span v-if="item.value === config.videoLocalModel" class="video-model-selected">当前选择</span>
        </div>
        <p class="video-model-description">{{ item.description }}</p>
        <div class="video-model-card-footer">
          <span class="video-model-availability" role="status">
            <Check v-if="downloaded.includes(item.value)" aria-hidden="true" />
            {{ !modelStateLoaded ? '读取中…' : downloaded.includes(item.value) ? '可离线使用' : downloading.includes(item.value) ? '正在下载模型' : '尚未下载' }}
          </span>
          <button type="button" class="video-model-download-button" :aria-label="t(downloaded.includes(item.value) ? 'video.modelDownloadedAria' : 'video.modelDownloadAria', {model: translateLegacy(item.label)})" :disabled="!modelStateLoaded || downloaded.includes(item.value) || downloading.includes(item.value) || !config.videoTranslationEnabled || !browserCapabilities.offscreenDocument" @click="config.videoLocalModel = item.value; download(item.value)">
            <component :is="downloaded.includes(item.value) ? Check : downloading.includes(item.value) ? Loading : Download" :class="{ 'is-loading': downloading.includes(item.value) }" aria-hidden="true" />
            {{ downloaded.includes(item.value) ? '已下载' : downloading.includes(item.value) ? '下载中…' : '下载模型' }}
          </button>
        </div>
      </article>
    </div>
    <p class="video-model-guidance">首次下载需要联网；识别速度取决于 CPU 和内存。支持桌面 Chrome / Edge，Firefox 可使用原生字幕翻译。</p>
    <p v-if="downloadError" class="video-model-error" role="alert">{{ downloadError }}</p>
  </section>
  <section class="video-ai-cache-panel" data-video-ai-cache aria-labelledby="video-ai-cache-title">
    <div class="video-ai-cache-copy">
      <div class="video-ai-cache-heading">
        <Files aria-hidden="true" />
        <h3 id="video-ai-cache-title">已识别视频缓存</h3>
        <span class="video-ai-cache-status" role="status">{{ cacheStats ? t('video.cacheCount', {count: cacheStats.entries}) : cacheError ? '读取失败' : '读取中…' }}</span>
      </div>
      <p>最多保留 32 个视频、7 天；只保存字幕文字和时间，不保存音频。</p>
      <p v-if="cacheError" class="video-model-error" role="alert">{{ cacheError }}</p>
    </div>
    <button type="button" class="video-model-download-button video-ai-cache-clear" :disabled="clearingCache || !cacheStats || cacheStats.entries === 0" @click="clearVideoAiCache">
      <Delete aria-hidden="true" />{{ clearingCache ? '清除中…' : '清除缓存' }}
    </button>
  </section>
</template>

<script lang="ts" setup>
import {useUiI18n} from '@/src/ui/i18n';
import {onMounted, onUnmounted, ref} from 'vue';
import browser from 'webextension-polyfill';
import {Check, Cpu, Delete, Download, Files, Loading} from '@element-plus/icons-vue';
import SettingsItem from './components/SettingsItem.vue';
import {
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
  VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY,
  VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
  normalizeVideoLocalTranscriptionModels,
  type VideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/public';
import {VIDEO_SOURCE_LANGUAGE_OPTIONS} from '@/src/core/config/model';
import type {Config} from '@/src/core/config/model';
import {browserCapabilities} from '@/src/platform/browser/capabilities';

const {t, translateLegacy} = useUiI18n();
const props = defineProps<{config: Config}>();
const config = props.config;
const modelOptions = VIDEO_LOCAL_TRANSCRIPTION_MODELS;
const downloaded = ref<VideoLocalTranscriptionModel[]>([]);
const modelStateLoaded = ref(false);
const downloading = ref<VideoLocalTranscriptionModel[]>([]);
const downloadError = ref('');
const cacheStats = ref<{entries: number; bytes: number; maxEntries: number; ttlMs: number} | null>(null);
const cacheError = ref('');
const clearingCache = ref(false);

async function refresh(): Promise<void> {
  const stored = await browser.storage.local.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
  downloaded.value = normalizeVideoLocalTranscriptionModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]);
  modelStateLoaded.value = true;
}

async function download(model: VideoLocalTranscriptionModel): Promise<void> {
  if (!browserCapabilities.offscreenDocument) {
    downloadError.value = '当前浏览器不支持本地 AI 字幕。';
    return;
  }
  if (downloaded.value.includes(model) || downloading.value.includes(model)) return;
  downloadError.value = '';
  downloading.value = [...downloading.value, model];
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadPrepareLocalVideoModel', model}) as {success?: boolean; models?: unknown; error?: string} | undefined;
    if (!response?.success) throw new Error(response?.error || '模型下载失败');
    downloaded.value = normalizeVideoLocalTranscriptionModels(response.models);
  } catch (error) {
    downloadError.value = error instanceof Error ? t('video.modelDownloadError', {error: translateLegacy(error.message)}) : '模型下载失败，请检查网络后重试。';
  } finally {
    downloading.value = downloading.value.filter(item => item !== model);
  }
}

async function refreshCacheStats(): Promise<void> {
  const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE}) as {success?: boolean; stats?: typeof cacheStats.value} | undefined;
  if (!response?.success || !response.stats) throw new Error('无法读取已识别字幕缓存，请重试。');
  cacheStats.value = response.stats;
  cacheError.value = '';
}

async function clearVideoAiCache(): Promise<void> {
  if (clearingCache.value) return;
  clearingCache.value = true;
  cacheError.value = '';
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE}) as {success?: boolean; error?: string} | undefined;
    if (!response?.success) throw new Error(response?.error || '清除已识别字幕失败。');
    await refreshCacheStats();
  } catch (error) {
    cacheError.value = error instanceof Error ? error.message : '清除已识别字幕失败，请重试。';
  } finally {
    clearingCache.value = false;
  }
}

function handleStorageChange(changes: Record<string, browser.Storage.StorageChange>, areaName: string): void {
  if (areaName === 'local' && changes[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]) void refresh().catch(() => { downloadError.value = '无法读取模型缓存，请重试。'; });
}

onMounted(() => {
  void refresh().catch(() => { modelStateLoaded.value = true; downloadError.value = '无法读取模型缓存，请重试。'; });
  void refreshCacheStats().catch((error) => { cacheError.value = error instanceof Error ? error.message : '无法读取已识别字幕缓存，请重试。'; });
  browser.storage.onChanged.addListener(handleStorageChange);
});
onUnmounted(() => browser.storage.onChanged.removeListener(handleStorageChange));
</script>

<style scoped>
.video-model-management {
  display: grid;
  gap: 14px;
  padding: 18px 16px;
  border-top: 1px solid var(--line);
}

.video-model-download-heading,
.video-model-card-heading,
.video-model-card-footer,
.video-ai-cache-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.video-model-download-heading,
.video-model-card-footer { justify-content: space-between; }
.video-model-download-heading { align-items: flex-start; }
h3 { margin: 0; color: var(--ink); font-size: 12.5px; font-weight: 700; line-height: 1.5; }
.video-model-status { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.video-model-local-badge,
.video-model-availability,
.video-model-download-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.video-model-local-badge { flex: none; padding: 5px 8px; border-radius: 6px; color: var(--muted); background: var(--surface-soft); font-size: 10px; }
svg { width: 15px; height: 15px; flex: none; }
.video-model-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.video-model-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.video-model-card.selected { border-color: var(--brand); background: color-mix(in srgb, var(--brand-soft) 25%, var(--surface)); }
.video-model-card-heading { flex-wrap: wrap; gap: 8px; }
.video-model-card-heading strong { color: var(--ink); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.video-model-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 8px; color: var(--muted); background: var(--surface-soft); }
.selected .video-model-icon { color: var(--brand-strong); background: var(--brand-soft); }
.video-model-icon svg { width: 18px; height: 18px; }
.video-model-selected { padding: 3px 6px; border-radius: 5px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; line-height: 1.4; white-space: nowrap; }
.video-model-description { flex: 1; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; }
.video-model-availability { justify-content: flex-start; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.video-model-download-button {
  flex: none;
  min-height: 32px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}
.video-model-download-button:hover:not(:disabled) { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-soft); }
.video-model-download-button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.video-model-download-button:disabled { color: var(--muted); background: var(--surface-soft); opacity: .65; cursor: default; }
.video-model-guidance { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.65; }
.video-model-error { margin: 0; color: var(--el-color-danger); font-size: 11px; line-height: 1.5; }
.video-ai-cache-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px 20px;
  margin: 0 16px 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
}
.video-ai-cache-copy { display: grid; gap: 7px; min-width: 0; flex: 1 1 260px; }
.video-ai-cache-heading { flex-wrap: wrap; gap: 8px; color: var(--muted); }
.video-ai-cache-copy > p { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.65; }
.video-ai-cache-copy > .video-model-error { color: var(--el-color-danger); }
.video-ai-cache-status { padding: 3px 7px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: var(--surface); font-size: 10px; line-height: 1.4; }
.capability-warning { margin: 6px 0 0; color: var(--el-color-danger); font-size: 11px; line-height: 1.5; }
.is-loading { animation: video-model-spin 1s linear infinite; }
@keyframes video-model-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-loading { animation: none; } }
@media (max-width: 480px) {
  .video-model-management { padding: 16px 12px; }
  .video-model-download-heading { flex-wrap: wrap; }
  .video-model-card { padding: 12px; }
  .video-ai-cache-panel { margin: 0 12px 12px; padding: 12px; }
  .video-ai-cache-clear { width: 100%; }
}
</style>
