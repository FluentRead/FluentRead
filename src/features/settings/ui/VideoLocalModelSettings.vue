<!--
 * @file src/features/settings/ui/VideoLocalModelSettings.vue
 * 文件职责：提供本地视频字幕识别方式、浏览器模型下载、本机 Qwen 服务地址与字幕缓存管理。
 * 主要内容：紧凑卡片选择 Tiny/Base/Small，呈现质量、体积、推荐、可用状态和真实下载字节；设备与缓存说明收进悬停/焦点帮助，下载来源始终自动处理且不展示供应方与换源信息；失败可重试，命令结束重读权威缓存；停用时移除 UI 监听，旧配置事件及迟到回包不进入新视图。
 * 模块边界：沿用设置草稿及显式保存，不在加载/切换时探测本机服务；通过视频 feature 公共配置和后台消息获取浏览器模型状态，不直接执行识别或操作网页播放器；下载进度只读取后台转存的变化事件。
 -->
<template>
  <section class="video-model-management" aria-labelledby="video-model-management-title">
    <div class="video-model-download-heading">
      <div>
        <div class="video-model-title"><h3 id="video-model-management-title">{{ translateLegacy('识别模型') }}</h3><FieldHelp :content="t('video.modelDeviceHint')" :label="translateLegacy('本地字幕模型使用说明')" /></div>
        <p v-if="config.videoTranscriptionProvider !== 'native-qwen'" class="video-model-status" role="status">{{ !modelStateLoaded ? '正在读取模型状态…' : downloaded.includes(config.videoLocalModel) ? '当前模型已下载，可直接生成' : t('video.modelChoiceHint') }}</p>
      </div>
    </div>
    <p v-if="!browserCapabilities.extensionDom" class="capability-warning" role="status">当前浏览器不支持本地 AI 字幕，无法下载或运行本地模型</p>
    <fieldset class="video-asr-provider" :disabled="!active || !config.videoTranslationEnabled || !browserCapabilities.extensionDom">
      <legend>识别方式</legend>
      <label><input :checked="config.videoTranscriptionProvider === 'browser'" :onChange="providerControls.chooseBrowser" type="radio" name="video-asr-provider" value="browser" /> 浏览器内 Whisper</label>
      <label><input :checked="config.videoTranscriptionProvider === 'native-qwen'" :onChange="providerControls.chooseNative" type="radio" name="video-asr-provider" value="native-qwen" /> 本机 Qwen3 ASR</label>
      <div v-if="config.videoTranscriptionProvider === 'native-qwen'" class="video-native-asr-settings">
        <label>本机服务地址 <input :value="config.videoNativeAsrBaseUrl" :onInput="providerControls.inputEndpoint" type="url" maxlength="512" placeholder="http://127.0.0.1:8000" /></label>
        <p>固定模型：Qwen/Qwen3-ASR-1.7B。使用标准 vLLM 音频转写接口，仅允许 127.0.0.1 或 [::1]，服务需由你事先启动。</p>
        <p>保存设置不会探测端口、启动服务或下载权重。开始 AI 字幕后才发送音频到所填本机地址；失败会报错，不自动切回 Whisper。</p>
        <p>该接口返回文本，字幕时间按音频窗口估计，并非字级对齐；此处不代表模型已经加载或已使用 GPU。</p>
      </div>
    </fieldset>
    <div v-if="config.videoTranscriptionProvider !== 'native-qwen'" class="video-model-list" role="radiogroup" aria-label="本地 AI 字幕模型">
      <article v-for="item in modelCards" :key="item.value" class="video-model-card" :class="{ selected: item.value === config.videoLocalModel, disabled: !active || !config.videoTranslationEnabled || !browserCapabilities.extensionDom }" :onClick="item.choose">
        <label class="video-model-choice">
          <input v-model="item.selection.value" type="radio" name="video-local-model" :value="item.value" :aria-label="item.label" :disabled="!active || !config.videoTranslationEnabled || !browserCapabilities.extensionDom" />
          <span class="video-model-card-heading">
            <strong>{{ item.label }}</strong>
            <span v-if="item.value === recommendedModel" class="video-model-recommended">推荐</span>
          </span>
        </label>
        <p class="video-model-description">{{ item.description }}</p>
        <p class="video-model-size">{{ t('modelCache.downloadSize', {size: item.downloadSizeMb}) }}</p>
        <div class="video-model-card-footer">
          <div v-if="isDownloading(item.value)" class="video-model-progress">
            <DownloadProgress :progress="progress[item.value]" :label="t('video.aiDownloadingModel')" :data-video-model-progress="item.value" />
          </div>
          <span v-else class="video-model-availability" :class="{'is-ready': downloaded.includes(item.value)}" role="status">
            <Check v-if="downloaded.includes(item.value)" aria-hidden="true" />
            {{ !modelStateLoaded ? '读取中…' : downloaded.includes(item.value) ? '可离线使用' : '尚未下载' }}
          </span>
          <button v-if="downloaded.includes(item.value)" type="button" class="video-model-download-button video-model-remove" :disabled="!active || removing.includes(item.value)" :aria-label="t('modelCache.removeNamed', {name: translateLegacy(item.label)})" :title="t('modelCache.removeNamed', {name: translateLegacy(item.label)})" @click.stop="item.remove()"><component :is="removing.includes(item.value) ? Loading : Delete" :class="{'is-loading': removing.includes(item.value)}" aria-hidden="true" /></button>
          <button v-else type="button" class="video-model-download-button primary" :aria-label="t('video.modelDownloadAria', {model: translateLegacy(item.label)})" :disabled="!active || !modelStateLoaded || isDownloading(item.value) || !config.videoTranslationEnabled || !browserCapabilities.extensionDom" @click.stop="item.download()">
            <component :is="isDownloading(item.value) ? Loading : Download" :class="{ 'is-loading': isDownloading(item.value) }" aria-hidden="true" />
            {{ isDownloading(item.value) ? '下载中…' : failedDownloads.includes(item.value) ? t('video.downloadRetry') : '下载模型' }}
          </button>
        </div>
      </article>
    </div>
    <p v-if="downloadError || modelReadError" class="video-model-error" role="alert">{{ downloadError || modelReadError }}</p>
  </section>
  <section class="video-ai-cache-panel" data-video-ai-cache aria-labelledby="video-ai-cache-title">
    <div class="video-ai-cache-copy">
      <div class="video-ai-cache-heading">
        <h3 id="video-ai-cache-title">已识别视频缓存</h3>
        <span class="video-ai-cache-status" role="status">{{ cacheStats ? t('video.cacheCount', {count: cacheStats.entries}) : cacheError ? '读取失败' : '读取中…' }}</span>
        <FieldHelp :content="translateLegacy('最多保留 32 个视频、7 天；只保存字幕文字和时间，不保存音频')" :label="translateLegacy('视频字幕缓存说明')" />
      </div>
      <p v-if="cacheError" class="video-model-error" role="alert">{{ cacheError }}</p>
    </div>
    <button type="button" class="video-model-download-button video-ai-cache-clear" :disabled="!active || clearingCache || !cacheStats || cacheStats.entries === 0" :onClick="cacheActions.clear">
      <Delete aria-hidden="true" />{{ clearingCache ? '清除中…' : '清除缓存' }}
    </button>
  </section>
</template>

<script lang="ts" setup>
import {useUiI18n} from '@/src/ui/i18n';
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import browser from 'webextension-polyfill';
import {Check, Delete, Download, Loading} from '@element-plus/icons-vue';
import {
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
  VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY,
  VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
  normalizeVideoLocalTranscriptionModels,
  VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
  type VideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/domain/public';
import type {Config} from '@/src/core/config/model';
import {videoModelDownloadId, type DownloadProgress as DownloadProgressValue} from '@/src/core/download/progress';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {watchDownloadProgress} from '@/src/platform/storage/downloadProgress';
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue';
import FieldHelp from './components/FieldHelp.vue';

const {t, translateLegacy} = useUiI18n();
const props = withDefaults(defineProps<{config: Config; active?: boolean; context?: unknown}>(), {active: true});
// 设置页会整体替换草稿；始终读取最新 prop，避免卡片继续编辑旧配置。
const config = computed(() => props.config);
// 同一草稿内切换识别方式也更换操作身份，旧控件和异步回包不能跨方式复活。
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.context, props.config.videoTranscriptionProvider]);
const providerControls = computed(() => {
  const current = capture(), target = props.config;
  const editable = () => current() && target.videoTranslationEnabled && browserCapabilities.extensionDom;
  const choose = (value: 'browser' | 'native-qwen') => {if (editable()) target.videoTranscriptionProvider = value;};
  // 直接绑定本次渲染的闭包，不用在触发时重新读取最新 computed 的 v-model 包装器。
  return {
    chooseBrowser: () => choose('browser'),
    chooseNative: () => choose('native-qwen'),
    inputEndpoint: (event: Event) => {
      if (editable() && target.videoTranscriptionProvider === 'native-qwen') target.videoNativeAsrBaseUrl = (event.target as HTMLInputElement).value;
    },
  };
});
const modelOptions = VIDEO_LOCAL_TRANSCRIPTION_MODELS;
const modelCopy: Record<VideoLocalTranscriptionModel, [string, string]> = {
  tiny: ['video.modelTinyName', 'video.modelTinyHint'],
  base: ['video.modelBaseName', 'video.modelBaseHint'],
  small: ['video.modelSmallName', 'video.modelSmallHint'],
};
const modelCards = computed(() => {
  const current = capture(), target = props.config;
  return modelOptions.map(item => ({
    ...item,
    label: t(modelCopy[item.value][0]),
    description: t(modelCopy[item.value][1]),
    selection: computed({get: () => target.videoLocalModel, set: (value: VideoLocalTranscriptionModel) => selectModel(value, current, target)}),
    choose: () => selectModel(item.value, current, target),
    download: () => {
      selectModel(item.value, current, target);
      return download(item.value, current);
    },
    remove: () => removeModel(item.value, current),
  }));
});
const cacheActions = computed(() => {
  const current = capture();
  return {clear: () => clearVideoAiCache(current)};
});
// 与播放器内的首次下载确认使用同一推荐，避免两处给出不同建议。
const recommendedModel = VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL;
const downloaded = ref<VideoLocalTranscriptionModel[]>([]);
const modelStateLoaded = ref(false);
// 本页发起的请求与播放器里发起、仍在进行的下载都算“下载中”；后者只能从实时进度事件得知。
const downloading = ref<VideoLocalTranscriptionModel[]>([]);
const observedDownloads = ref<VideoLocalTranscriptionModel[]>([]);
const progress = ref<Partial<Record<VideoLocalTranscriptionModel, DownloadProgressValue>>>({});
const downloadError = ref('');
const failedDownloads = ref<VideoLocalTranscriptionModel[]>([]);
let stopObserving: (() => void) | undefined;
const modelReadError = ref('');
const removing = ref<VideoLocalTranscriptionModel[]>([]);
const cacheStats = ref<{entries: number; bytes: number; maxEntries: number; ttlMs: number} | null>(null);
const cacheError = ref('');
const clearingCache = ref(false);
const mounted = ref(false);
// 记录已交给后台、尚未回包的各模型下载；视图停用不会取消这些任务。
const pendingDownloads = ref(new Set<VideoLocalTranscriptionModel>());
let modelGeneration = 0;
let cacheGeneration = 0;

function selectModel(model: VideoLocalTranscriptionModel, current: () => boolean, target: Config): void {
  if (!current() || target.videoTranscriptionProvider === 'native-qwen' || !target.videoTranslationEnabled || !browserCapabilities.extensionDom) return;
  target.videoLocalModel = model;
}

function isDownloading(model: VideoLocalTranscriptionModel): boolean {
  return !downloaded.value.includes(model) && (downloading.value.includes(model) || observedDownloads.value.includes(model) || pendingDownloads.value.has(model));
}

function handleDownloadProgress(id: string, next: DownloadProgressValue | undefined): void {
  const model = modelOptions.find(item => videoModelDownloadId(item.value) === id)!.value;
  progress.value = {...progress.value, [model]: next};
  if (next) {
    if (!observedDownloads.value.includes(model)) observedDownloads.value = [...observedDownloads.value, model];
    return;
  }
  // 结束事件不说明成败；不是本页发起的下载需要重新读取已下载列表。
  const external = observedDownloads.value.includes(model) && !downloading.value.includes(model);
  observedDownloads.value = observedDownloads.value.filter(item => item !== model);
  if (external) void refresh();
}

async function refresh(force = false): Promise<void> {
  const current = capture();
  if (!current() || props.config.videoTranscriptionProvider === 'native-qwen' || !force && (downloading.value.length || removing.value.length)) return;
  const request = ++modelGeneration;
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE}) as {success?: boolean; models?: unknown} | undefined;
    if (!current() || request !== modelGeneration) return;
    if (response?.success !== true || !Array.isArray(response.models)) throw new Error('无法读取模型缓存，请重试');
    downloaded.value = normalizeVideoLocalTranscriptionModels(response.models);
    modelReadError.value = '';
  } catch {
    if (current() && request === modelGeneration) {
      modelReadError.value = '无法读取模型缓存，请重试';
    }
  } finally {
    if (current() && request === modelGeneration) modelStateLoaded.value = true;
  }
}

async function download(model: VideoLocalTranscriptionModel, current = capture()): Promise<void> {
  if (!current() || props.config.videoTranscriptionProvider === 'native-qwen') return;
  if (!browserCapabilities.extensionDom) {
    downloadError.value = '当前浏览器不支持本地 AI 字幕';
    return;
  }
  if (pendingDownloads.value.has(model) || downloaded.value.includes(model) || isDownloading(model)) return;
  modelGeneration++;
  downloadError.value = '';
  failedDownloads.value = failedDownloads.value.filter(item => item !== model);
  progress.value = {...progress.value, [model]: undefined};
  downloading.value = [...downloading.value, model];
  pendingDownloads.value.add(model);
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadPrepareLocalVideoModel', model, preference: 'auto'}) as {success?: boolean; models?: unknown; error?: string} | undefined;
    if (!current()) return;
    if (!response?.success) throw new Error(response?.error || '模型下载失败');
  } catch {
    if (current()) {
      failedDownloads.value = [...failedDownloads.value, model];
      downloadError.value = translateLegacy('模型下载失败，请检查网络后重试');
    }
  } finally {
    pendingDownloads.value.delete(model);
    if (current()) {
      downloading.value = downloading.value.filter(item => item !== model);
      observedDownloads.value = observedDownloads.value.filter(item => item !== model);
    }
    // 命令结算后新视图独立重读权威状态，不移交旧回包或错误。
    if (active.value) await refresh();
  }
}

async function removeModel(model: VideoLocalTranscriptionModel, current = capture()): Promise<void> {
  if (!current() || props.config.videoTranscriptionProvider === 'native-qwen' || removing.value.includes(model)) return;
  modelGeneration++;
  removing.value.push(model);
  downloadError.value = '';
  failedDownloads.value = failedDownloads.value.filter(item => item !== model);
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadRemoveLocalVideoModel', model}) as {success?: boolean; error?: string; models?: unknown} | undefined;
    if (!current()) return;
    if (!response?.success) throw new Error(response?.error || t('modelCache.removeFailed'));
  } catch (error) { if (current()) downloadError.value = error instanceof Error ? translateLegacy(error.message) : t('modelCache.removeFailed'); }
  finally {
    if (current()) {
      removing.value = removing.value.filter(item => item !== model);
      await refresh();
    }
  }
}

async function refreshCacheStats(): Promise<void> {
  const current = capture();
  const request = ++cacheGeneration;
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE}) as {success?: boolean; stats?: typeof cacheStats.value} | undefined;
    if (!current() || request !== cacheGeneration) return;
    if (!response?.success || !response.stats) throw new Error('无法读取已识别字幕缓存，请重试');
    cacheStats.value = response.stats;
    cacheError.value = '';
  } catch (error) {
    if (current() && request === cacheGeneration) cacheError.value = error instanceof Error ? error.message : '无法读取已识别字幕缓存，请重试';
  }
}

async function clearVideoAiCache(current = capture()): Promise<void> {
  if (!current() || clearingCache.value) return;
  cacheGeneration++;
  clearingCache.value = true;
  cacheError.value = '';
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE}) as {success?: boolean; error?: string} | undefined;
    if (!current()) return;
    if (!response?.success) throw new Error(response?.error || '清除已识别字幕失败');
    await refreshCacheStats();
  } catch (error) {
    if (current()) cacheError.value = error instanceof Error ? error.message : '清除已识别字幕失败，请重试';
  } finally {
    if (current()) clearingCache.value = false;
  }
}

watch(() => [mounted.value, revision.value], () => {
  stopObserving?.();
  stopObserving = undefined;
  modelGeneration++;
  cacheGeneration++;
  downloading.value = [];
  removing.value = [];
  observedDownloads.value = [];
  progress.value = {};
  downloadError.value = '';
  failedDownloads.value = [];
  modelReadError.value = '';
  modelStateLoaded.value = false;
  clearingCache.value = false;
  cacheError.value = '';
  if (!mounted.value || !active.value) return;
  const current = capture();
  const handleStorageChange = (changes: Record<string, browser.Storage.StorageChange>, areaName: string) => {
    if (current() && areaName === 'local' && changes[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]) void refresh();
  };
  // 回到设置时重新核对模型文件与字幕统计；Cache Storage 丢失文件不会触发 storage.onChanged。
  const refreshVisibleCacheStats = () => {
    if (current() && !clearingCache.value && document.visibilityState !== 'hidden') {
      void refresh();
      void refreshCacheStats();
    }
  };
  browser.storage.onChanged.addListener(handleStorageChange);
  const stopProgress = watchDownloadProgress(modelOptions.map(item => videoModelDownloadId(item.value)), (id, next) => {
    if (current()) handleDownloadProgress(id, next);
  });
  document.addEventListener('visibilitychange', refreshVisibleCacheStats);
  window.addEventListener('focus', refreshVisibleCacheStats);
  stopObserving = () => {
    browser.storage.onChanged.removeListener(handleStorageChange);
    stopProgress();
    document.removeEventListener('visibilitychange', refreshVisibleCacheStats);
    window.removeEventListener('focus', refreshVisibleCacheStats);
  };
  void refresh(true);
  void refreshCacheStats();
}, {flush: 'sync'});
onMounted(() => {mounted.value = true;});
onUnmounted(() => {mounted.value = false;});
</script>

<style scoped>
.video-model-management { display: grid; gap: 16px; padding: 20px; border-top: 1px solid var(--line); }
.video-model-download-heading, .video-model-title, .video-model-card-heading, .video-model-card-footer, .video-ai-cache-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.video-model-download-heading, .video-model-card-footer { justify-content: space-between; }
h3 { margin: 0; color: var(--ink); font-size: 13px; font-weight: 550; line-height: 1.5; }
.video-model-title { gap: 2px; }
.video-model-status { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
svg { width: 15px; height: 15px; flex: none; }
.video-model-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
.video-model-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); transition: border-color 150ms ease, background 150ms ease; }
.video-model-card:not(.disabled) { cursor: pointer; }
.video-asr-provider { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }
.video-asr-provider > label { display: flex; align-items: center; gap: 8px; }
.video-native-asr-settings { display: grid; gap: 8px; overflow-wrap: anywhere; }
.video-native-asr-settings label { display: grid; gap: 6px; }
.video-native-asr-settings input { width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.video-native-asr-settings p { margin: 0; color: var(--muted); line-height: 1.6; }
.video-model-card:not(.disabled):hover { border-color: var(--brand); }
.video-model-card.selected { border-color: var(--brand); background: color-mix(in srgb, var(--brand-soft) 24%, var(--surface)); }
.video-model-card:focus-within { outline: 2px solid var(--brand); outline-offset: 3px; }
.video-model-choice { display: flex; align-items: center; gap: 9px; min-width: 0; cursor: inherit; }
.video-model-choice input { width: 16px; height: 16px; flex: none; margin: 0; accent-color: var(--brand); cursor: inherit; }
.video-model-choice input:focus-visible { outline: none; }
.video-model-card-heading { flex-wrap: wrap; gap: 8px; }
.video-model-card-heading strong { color: var(--ink); font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.video-model-recommended { padding: 2px 6px; border-radius: 5px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; line-height: 1.5; white-space: nowrap; }
.video-model-description { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.video-model-size { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.video-model-card-footer { flex-wrap: wrap; gap: 10px; margin-top: auto; padding-top: 4px; }
.video-model-availability { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.video-model-availability.is-ready { color: var(--el-color-success); }
.video-model-progress { flex: 1 1 140px; min-width: 0; }
.video-model-download-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; min-height: 32px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--ink); background: var(--surface); font: inherit; font-size: 12px; font-weight: 550; cursor: pointer; transition: background 150ms ease, border-color 150ms ease; }
.video-model-download-button:hover:not(:disabled) { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-soft); }
.video-model-download-button.primary { border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft); }
.video-model-download-button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.video-model-download-button:disabled { color: var(--muted); border-color: var(--line); background: var(--surface-soft); opacity: .65; cursor: default; }
.video-model-remove { width: 32px; padding: 0; border-color: transparent; color: var(--muted); background: transparent; }
.video-model-error, .capability-warning { margin: 0; color: var(--el-color-danger); font-size: 12px; line-height: 1.55; }
.video-ai-cache-panel { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 20px; padding: 16px 20px; border-top: 1px solid var(--line); }
.video-ai-cache-copy { display: grid; gap: 6px; min-width: 0; flex: 1 1 200px; }
.video-ai-cache-heading { flex-wrap: wrap; gap: 6px; }
.video-ai-cache-status { color: var(--muted); font-size: 11px; line-height: 1.5; }
.is-loading { animation: video-model-spin 1s linear infinite; }
@keyframes video-model-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-loading { animation: none; } .video-model-card, .video-model-download-button { transition: none; } }
@media (max-width: 700px) { .video-model-management { padding: 16px 12px; } .video-ai-cache-panel { padding: 14px 12px; } }
@media (max-width: 480px) { .video-model-card { padding: 14px; } }
</style>
