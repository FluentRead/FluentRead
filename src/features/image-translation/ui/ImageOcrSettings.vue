<!--
 * @file src/features/image-translation/ui/ImageOcrSettings.vue
 * 文件职责：提供图片与圈选共用的紧凑语言包管理界面，突出当前源语言需要的资源和可继续使用的状态。
 * 主要内容：嵌入资源框时突出当前识别方式，备用模型与语言包管理按需展开，任务和错误会自动展开；独立使用时保留完整语言摘要与列表，用统一选择器设置原文语言，按当前识别语言准备缺失包；下载中的语言包在名称下方显示真实进度条和百分比；重开页面读取后台任务快照，完成时更新共享状态，保留单包重试和移除。
 * 模块边界：组件只通过既有后台消息管理语言包，不创建 Worker、不写缓存、不持有下载任务；下载进度只读取后台转存的变化事件；关闭页面只停止状态订阅，后台仍负责去重、串行下载和部分成功持久化。
 -->
<template>
  <section class="image-ocr-section" :class="{'is-embedded': props.embedded}" :aria-labelledby="`${props.idPrefix}-ocr-pack-title`" data-testid="ocr-language-manager">
    <div v-if="!browserCapabilities.imageOcr" class="image-ocr-unavailable" role="status">
      <strong>当前浏览器暂不支持图片翻译与 OCR</strong>
      <p>{{ t('ocr.packs.unavailable') }}</p>
    </div>
    <template v-else>
      <MangaModelSettings v-if="props.showManga" />
      <component :is="props.embedded ? 'details' : 'div'" class="image-ocr-engine-details" :open="props.embedded ? engineExpanded : undefined" @toggle="engineExpanded = ($event.target as HTMLDetailsElement).open">
        <summary v-if="props.embedded" class="image-ocr-engine-summary">
          <div><strong :id="`${props.idPrefix}-ocr-pack-title`">{{ translateLegacy('轻量识别') }}</strong><small>Tesseract · {{ translateLegacy(activeEngine ? '当前使用' : '备用识别') }}</small></div>
          <span v-if="initialized" class="image-ocr-count">{{ t('ocr.packs.count', {count: downloadedCodes.length, total: languagePacks.length}) }}</span>
        </summary>
        <header v-else class="image-ocr-heading settings-card-heading">
          <div class="settings-card-heading-copy"><h2 :id="`${props.idPrefix}-ocr-pack-title`">{{ props.compact ? translateLegacy('Tesseract（轻量模型）') : t('ocr.packs.title') }}</h2><p v-if="!props.compact">{{ t('ocr.packs.description') }}</p></div>
          <div v-if="!props.compact" class="image-ocr-source">
            <label :for="`${props.idPrefix}-ocr-source`">{{ t('area.settings.sourceLanguage') }}</label>
            <UiSelect :id="`${props.idPrefix}-ocr-source`" :aria-label="t('area.settings.sourceLanguage')" :title="t('area.settings.sourceLanguageDescription')" :model-value="props.sourceLanguage" @update:model-value="emit('update:sourceLanguage', $event)">
              <el-option v-if="!IMAGE_OCR_SOURCE_LANGUAGES.some(item => item.value === props.sourceLanguage)" :value="props.sourceLanguage" :label="props.sourceLanguage" disabled />
              <el-option v-for="language in IMAGE_OCR_SOURCE_LANGUAGES" :key="language.value" :value="language.value" :label="translateLegacy(language.label)" />
            </UiSelect>
          </div>
          <span v-if="initialized" class="image-ocr-count">{{ t('ocr.packs.count', {count: downloadedCodes.length, total: languagePacks.length}) }}</span>
        </header>
        <div class="image-ocr-recommendation" :data-ready="requiredReady">
          <div class="image-ocr-summary">
            <strong>{{ t(requiredReady ? 'ocr.packs.ready' : 'ocr.packs.required') }}</strong>
            <p data-i18n-ignore>{{ requiredLabels }}</p>
            <small v-if="!props.embedded">{{ t(props.sourceLanguage === 'auto' ? 'ocr.packs.autoHint' : 'ocr.packs.languageHint') }}</small>
          </div>
          <span v-if="props.embedded && requiredReady" class="image-ocr-ready" role="status">{{ t('ocr.packs.readyAction') }}</span>
          <button v-else type="button" class="image-ocr-primary-action" :disabled="!initialized || requiredReady || requiredBusy" @click="downloadLanguages(requiredCodes)">
            <span v-if="requiredBusy" class="image-ocr-spinner" aria-hidden="true" />
            {{ t(requiredReady ? 'ocr.packs.readyAction' : requiredBusy ? 'ocr.packs.preparing' : 'ocr.packs.prepare') }}
          </button>
        </div>
        <p v-if="!initialized && !statusError" class="image-ocr-notice" role="status">{{ t('ocr.packs.loading') }}</p>
        <div v-if="statusError" class="image-ocr-notice image-ocr-error" role="alert">
          <span>{{ t('ocr.packs.statusError') }}</span><button type="button" @click="refreshStatus">{{ translateLegacy('重试') }}</button>
        </div>
        <component :is="props.embedded ? 'details' : 'div'" class="image-ocr-language-details" :open="props.embedded ? languagesExpanded : undefined" @toggle="languagesExpanded = ($event.target as HTMLDetailsElement).open">
          <summary v-if="props.embedded">{{ translateLegacy('语言包管理') }}</summary>
          <div class="image-ocr-pack-list" role="list">
            <article v-for="pack in visiblePacks" :key="pack.code" class="image-ocr-pack-card" role="listitem" :data-language="pack.code" :data-state="stateOf(pack.code)">
              <div class="image-ocr-pack-icon" data-i18n-ignore aria-hidden="true">{{ pack.icon }}</div>
              <div class="image-ocr-pack-copy">
                <div class="image-ocr-pack-title"><strong data-i18n-ignore>{{ pack.label }}</strong><span v-if="requiredCodes.includes(pack.code)" class="image-ocr-required">{{ t('ocr.packs.inUse') }}</span></div>
                <small data-i18n-ignore>{{ pack.size }}<template v-if="pack.code === 'jpn'"> · {{ t('ocr.packs.vertical') }}</template></small>
                <DownloadProgress v-if="stateOf(pack.code) === 'downloading' || progress[pack.code]" class="image-ocr-pack-progress" detail="percent" :progress="progress[pack.code]" :label="t('ocr.packs.downloadNamed', {name: pack.label})" />
                <p v-if="states[pack.code]?.phase === 'error'" class="image-ocr-error" role="alert" data-i18n-ignore>{{ translateLegacy(states[pack.code]?.error || '语言包下载失败') }}</p>
                <p v-if="actionErrors[pack.code]" class="image-ocr-error" role="alert" data-i18n-ignore>{{ actionErrors[pack.code] }}</p>
              </div>
              <div class="image-ocr-pack-action">
                <span class="image-ocr-pack-status" :class="{ready: downloadedCodes.includes(pack.code)}" role="status">
                  <span v-if="isBusy(pack.code)" class="image-ocr-spinner" aria-hidden="true" />
                  {{ stateLabel(pack.code) }}
                </span>
                <button v-if="downloadedCodes.includes(pack.code)" type="button" class="image-ocr-download-button image-ocr-remove" :disabled="!initialized || isBusy(pack.code)" :aria-label="t('ocr.packs.removeNamed', {name: pack.label})" @click="removeLanguage(pack.code)">{{ t('ocr.packs.remove') }}</button>
                <button v-else type="button" class="image-ocr-download-button" :disabled="!initialized || isBusy(pack.code)" :aria-label="t('ocr.packs.downloadNamed', {name: pack.label})" @click="downloadLanguages([pack.code])">
                  {{ translateLegacy(states[pack.code]?.phase === 'error' ? '重试' : '下载') }}
                </button>
              </div>
            </article>
          </div>
          <button v-if="optionalCount" type="button" class="image-ocr-more" :aria-expanded="showAll" @click="showAll = !showAll">{{ t(showAll ? 'ocr.packs.less' : 'ocr.packs.more', {count: optionalCount}) }} <span aria-hidden="true">{{ showAll ? '−' : '+' }}</span></button>
        </component>
        <footer v-if="!props.embedded || hasActiveTasks" class="image-ocr-footnote"><p v-if="!props.embedded">{{ t('ocr.packs.shared') }}</p><p>{{ t(hasActiveTasks ? 'ocr.packs.background' : 'ocr.packs.sizeHint') }}</p></footer>
      </component>
    </template>
  </section>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import MangaModelSettings from './MangaModelSettings.vue';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {useUiI18n} from '@/src/ui/i18n';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue';
import {ocrLanguageDownloadId, type DownloadProgress as DownloadProgressValue} from '@/src/core/download/progress';
import {watchDownloadProgress} from '@/src/platform/storage/downloadProgress';
import {
  IMAGE_OCR_LANGUAGE_PACKS, IMAGE_OCR_SOURCE_LANGUAGES, IMAGE_OCR_LANGUAGE_STATE_KEY, getImageOcrEngine, getRequiredImageOcrLanguages,
  normalizeImageOcrLanguageCodes, type ImageOcrLanguageCode, type ImageOcrDownloadState, type ImageOcrStatusResponse,
} from '../ocrLanguages';

const props = withDefaults(defineProps<{idPrefix?: string; sourceLanguage?: string; showManga?: boolean; compact?: boolean; embedded?: boolean; active?: boolean}>(), {idPrefix: 'image', sourceLanguage: 'auto', showManga: false, compact: false, embedded: false, active: true});
const emit = defineEmits<{'update:sourceLanguage': [language: string]}>();
const {t, translateLegacy} = useUiI18n();
const languagePacks = computed(() => IMAGE_OCR_LANGUAGE_PACKS.map(pack => ({...pack, label: translateLegacy(pack.label), size: translateLegacy(pack.size)})));
const requiredCodes = computed(() => getRequiredImageOcrLanguages(props.sourceLanguage));
const requiredLabels = computed(() => requiredCodes.value.map(code => languagePacks.value.find(pack => pack.code === code)!.label).join(' · '));
const downloadedCodes = ref<ImageOcrLanguageCode[]>([]);
const states = ref<Partial<Record<ImageOcrLanguageCode, ImageOcrDownloadState>>>({});
const actionErrors = ref<Partial<Record<ImageOcrLanguageCode, string>>>({});
// 后台任务快照每 1.5 秒读取一次；字节进度来自实时事件，下载结束时立即补读一次状态。
const progress = ref<Partial<Record<ImageOcrLanguageCode, DownloadProgressValue>>>({});
const showAll = ref(false);
const primaryCodes = computed(() => new Set([...requiredCodes.value, ...downloadedCodes.value,
  ...IMAGE_OCR_LANGUAGE_PACKS.filter(pack => states.value[pack.code] || actionErrors.value[pack.code]).map(pack => pack.code)]));
const optionalCount = computed(() => languagePacks.value.filter(pack => !primaryCodes.value.has(pack.code)).length);
const visiblePacks = computed(() => languagePacks.value.filter(pack => showAll.value || primaryCodes.value.has(pack.code)));
const initialized = ref(false);
const statusError = ref(false);
const requiredReady = computed(() => initialized.value && requiredCodes.value.every(code => downloadedCodes.value.includes(code)));
const requiredBusy = computed(() => requiredCodes.value.some(isBusy));
const hasActiveTasks = computed(() => IMAGE_OCR_LANGUAGE_PACKS.some(pack => isBusy(pack.code)));
const hasPackErrors = computed(() => Object.values(states.value).some(state => state?.phase === 'error') || Object.values(actionErrors.value).some(Boolean));
const activeEngine = computed(() => getImageOcrEngine(props.sourceLanguage, props.active ? 'tesseract' : 'paddle') === 'tesseract');
const engineExpanded = ref(activeEngine.value);
const languagesExpanded = ref(false);
watch(activeEngine, active => {engineExpanded.value = active || hasActiveTasks.value || statusError.value || hasPackErrors.value;});
// 开始任务或失败时展开；完成后保留展开状态，便于查看结果并继续管理。
watch([hasActiveTasks, hasPackErrors, statusError], feedback => {
  if (feedback.some(Boolean)) {engineExpanded.value = true; languagesExpanded.value = true;}
});
let disposed = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | undefined;
let stopWatch: (() => void) | undefined;
let stopWatchingProgress: (() => void) | undefined;

function isBusy(code: ImageOcrLanguageCode): boolean {
  return ['queued', 'downloading', 'removing'].includes(states.value[code]?.phase ?? '');
}
function stateOf(code: ImageOcrLanguageCode): string {
  return states.value[code]?.phase ?? (downloadedCodes.value.includes(code) ? 'ready' : 'available');
}
function stateLabel(code: ImageOcrLanguageCode): string {
  const state = stateOf(code);
  return state === 'available' ? '' : t(`ocr.packs.state.${state}`);
}
function refreshStatus(): Promise<void> {
  if (disposed) return Promise.resolve();
  if (refreshing) return refreshing;
  clearTimeout(pollTimer);
  refreshing = (async () => {
    try {
      const response = await browser.runtime.sendMessage({type: 'fluentReadImageOcrStatus'}) as ImageOcrStatusResponse | undefined;
      if (!response?.success || !Array.isArray(response.languages)) throw new Error('OCR state unavailable');
      if (disposed) return;
      downloadedCodes.value = normalizeImageOcrLanguageCodes(response.languages);
      states.value = response.states ?? {};
      initialized.value = true;
      statusError.value = false;
    } catch { if (!disposed) statusError.value = true; }
    finally {
      refreshing = undefined;
      // 仅设置页可见时读取微小快照，其他页面开始的下载也能同步；不创建新的 OCR 任务。
      if (!disposed) pollTimer = setTimeout(() => { if (document.visibilityState !== 'hidden') void refreshStatus(); }, 1500);
    }
  })();
  return refreshing;
}
function handleVisibility(): void { if (document.visibilityState !== 'hidden') void refreshStatus(); }
async function downloadLanguages(languages: ImageOcrLanguageCode[]): Promise<void> {
  if (!initialized.value || disposed) return;
  const pending = languages.filter(code => !downloadedCodes.value.includes(code) && !isBusy(code));
  if (!pending.length) return;
  for (const code of pending) {states.value[code] = {phase: 'queued'}; delete actionErrors.value[code];}
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadImageOcrDownload', languages: pending}) as ImageOcrStatusResponse | undefined;
    if (!response?.success) throw new Error(response?.error || '语言包下载失败');
  } catch (error) {
    if (!disposed) for (const code of pending) actionErrors.value[code] = translateLegacy(error instanceof Error ? error.message : '语言包下载失败');
  } finally {
    if (!disposed) {
      await refreshStatus();
      // 部分成功只保留失败行反馈，不把已下载的语言标为失败。
      for (const code of pending) if (downloadedCodes.value.includes(code) || states.value[code]?.phase === 'error') delete actionErrors.value[code];
    }
  }
}
async function removeLanguage(code: ImageOcrLanguageCode): Promise<void> {
  if (!initialized.value || isBusy(code)) return;
  states.value[code] = {phase: 'removing'};
  delete actionErrors.value[code];
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadImageOcrRemove', languages: [code]}) as ImageOcrStatusResponse | undefined;
    if (!response?.success) throw new Error(response?.error || t('modelCache.removeFailed'));
  } catch (error) { if (!disposed) actionErrors.value[code] = error instanceof Error ? translateLegacy(error.message) : t('modelCache.removeFailed'); }
  finally { if (!disposed) await refreshStatus(); }
}
onMounted(() => {
  if (!browserCapabilities.imageOcr) return;
  stopWatch = configStorage.watch(`local:${IMAGE_OCR_LANGUAGE_STATE_KEY}`, () => { void refreshStatus(); });
  stopWatchingProgress = watchDownloadProgress(IMAGE_OCR_LANGUAGE_PACKS.map(pack => ocrLanguageDownloadId(pack.code)), (id, next) => {
    const code = IMAGE_OCR_LANGUAGE_PACKS.find(pack => ocrLanguageDownloadId(pack.code) === id)!.code;
    progress.value = {...progress.value, [code]: next};
    if (!next) void refreshStatus();
  });
  document.addEventListener('visibilitychange', handleVisibility);
  void refreshStatus();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(pollTimer);
  stopWatch?.();
  stopWatchingProgress?.();
  document.removeEventListener('visibilitychange', handleVisibility);
});
</script>

<style scoped src="./image-ocr-settings.css"></style>
