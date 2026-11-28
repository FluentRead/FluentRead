<!--
 * @file src/features/video-subtitle/local-media/LocalMediaTranscriptionPanel.vue
 * 文件职责：提供本地音视频导入、离线 AI 语音转写、双语字幕同步预览、逐句循环精听与多格式字幕导出工作台。
 * 主要内容：支持拖拽或选择受限格式的本地音视频文件，复用 Whisper 或本机 Qwen3 ASR 协议离线识别并批量翻译，在原生播放器上叠加双语/单语字幕，结合句子时间轴实现逐句跳转、单句循环、句末暂停及 SRT/WebVTT/Markdown 导出。
 * 模块边界：不修改全局配置或网页播放器，所有临时对象 URL、取消信号与后台推理流在更换文件、重置或卸载时立即释放。
 -->
<template>
  <section class="fr-local-media-studio" data-local-media-studio aria-labelledby="fr-local-media-title">
    <header class="fr-local-media-header">
      <div>
        <h3 id="fr-local-media-title">{{ t('video.localMedia.title') }}</h3>
        <p class="fr-local-media-subtitle">{{ t('video.localMedia.description') }}</p>
      </div>
      <div v-if="selectedFile" class="fr-local-media-file-meta">
        <span class="fr-local-media-file-name" data-local-media-filename>{{ selectedFile.name }}</span>
        <span class="fr-local-media-file-size">{{ formatMediaBytes(selectedFile.size) }}</span>
        <button type="button" class="fr-local-media-btn" data-local-media-action="clear" @click="clearFile">
          {{ t('video.localMedia.clearFile') }}
        </button>
      </div>
    </header>

    <p v-if="!extensionDomSupported" class="fr-local-media-warning" role="status">
      {{ t('video.localMedia.unsupportedBrowser') }}
    </p>

    <div
      v-if="!selectedFile"
      class="fr-local-media-dropzone"
      :class="{'is-dragging': dragging}"
      data-local-media-dropzone
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        ref="fileInput"
        type="file"
        class="fr-local-media-file-input"
        data-local-media-input
        :accept="LOCAL_MEDIA_ACCEPT_ATTRIBUTE"
        :disabled="!canOperate"
        :aria-label="t('video.localMedia.chooseFile')"
        @change="onFileInputChange"
      />
      <p class="fr-local-media-drop-title">{{ t('video.localMedia.dropHint') }}</p>
      <p class="fr-local-media-drop-formats">{{ t('video.localMedia.formatsHint') }}</p>
      <button
        type="button"
        class="fr-local-media-btn is-primary"
        data-local-media-action="pick"
        :disabled="!canOperate"
        @click="openFilePicker"
      >
        {{ t('video.localMedia.chooseFile') }}
      </button>
    </div>

    <div v-if="selectedFile" class="fr-local-media-workspace">
      <div class="fr-local-media-toolbar">
        <button
          v-if="!busy"
          type="button"
          class="fr-local-media-btn is-primary"
          data-local-media-action="transcribe"
          :disabled="!canOperate"
          @click="startTranscription"
        >
          {{ snapshot.cues.length ? t('video.localMedia.retranscribe') : t('video.localMedia.startTranscribe') }}
        </button>
        <button
          v-else
          type="button"
          class="fr-local-media-btn is-danger"
          data-local-media-action="cancel"
          @click="cancelWork"
        >
          {{ t('video.localMedia.cancel') }}
        </button>

        <button
          v-if="!busy && snapshot.cues.length && snapshot.translatedCount < snapshot.totalCues"
          type="button"
          class="fr-local-media-btn"
          data-local-media-action="translate-pending"
          @click="retryPendingTranslations"
        >
          {{ t('video.localMedia.retryTranslations') }}
        </button>

        <label class="fr-local-media-inline-field">
          <span>{{ t('video.localMedia.displayMode') }}</span>
          <select :value="displayMode" data-local-media-display-mode :aria-label="t('video.localMedia.displayMode')" @change="onDisplayModeChange">
            <option value="bilingual">{{ t('video.localMedia.modeBilingual') }}</option>
            <option value="translation-only">{{ t('video.localMedia.modeTranslated') }}</option>
            <option value="original-only">{{ t('video.localMedia.modeOriginal') }}</option>
            <option value="off">{{ t('video.localMedia.modeOff') }}</option>
          </select>
        </label>
      </div>

      <div v-if="busy || snapshot.phase === 'ready'" class="fr-local-media-status-bar" role="status" data-local-media-status>
        <span>{{ statusText }}</span>
        <progress v-if="busy" class="fr-local-media-progress" :value="Math.round(snapshot.progress * 100)" max="100" />
      </div>

      <div class="fr-local-media-player-stage" :data-media-kind="mediaKind">
        <video
          v-if="mediaKind === 'video'"
          ref="mediaElement"
          class="fr-local-media-video"
          data-local-media-player
          controls
          playsinline
          :src="objectUrl"
          @timeupdate="onTimeUpdate"
        />
        <audio
          v-else
          ref="mediaElement"
          class="fr-local-media-audio"
          data-local-media-player
          controls
          :src="objectUrl"
          @timeupdate="onTimeUpdate"
        />
        <div
          v-if="displayMode !== 'off' && activeCue"
          class="fr-local-media-overlay"
          data-local-media-overlay
          aria-live="polite"
        >
          <p v-if="displayMode !== 'translation-only'" class="fr-local-media-overlay-source" data-local-media-cue-source>
            {{ activeCue.text }}
          </p>
          <p v-if="displayMode !== 'original-only' && activeCueTranslation" class="fr-local-media-overlay-translation" data-local-media-cue-translation>
            {{ activeCueTranslation }}
          </p>
        </div>
      </div>

      <div v-if="sentences.length" class="fr-local-media-learning" data-local-media-learning>
        <div class="fr-local-media-learning-bar">
          <strong>{{ t('video.localMedia.sentenceLearning') }}</strong>
          <div class="fr-local-media-learning-controls">
            <button type="button" class="fr-local-media-btn" data-local-media-action="prev-sentence" :disabled="activeSentenceIndex <= 0" @click="stepSentence(-1)">
              {{ t('video.learning.previous') }}
            </button>
            <button type="button" class="fr-local-media-btn" data-local-media-action="replay-sentence" @click="replayActiveSentence">
              {{ t('video.learning.replay') }}
            </button>
            <button type="button" class="fr-local-media-btn" data-local-media-action="next-sentence" :disabled="activeSentenceIndex >= sentences.length - 1" @click="stepSentence(1)">
              {{ t('video.learning.next') }}
            </button>
            <button type="button" class="fr-local-media-btn" :class="{'is-active': playbackAssist === 'loop'}" data-local-media-action="toggle-loop" :aria-pressed="playbackAssist === 'loop'" @click="togglePlaybackAssist('loop')">
              {{ t('video.learning.loop') }}
            </button>
            <button type="button" class="fr-local-media-btn" :class="{'is-active': playbackAssist === 'pause'}" data-local-media-action="toggle-pause" :aria-pressed="playbackAssist === 'pause'" @click="togglePlaybackAssist('pause')">
              {{ t('video.learning.pause') }}
            </button>
          </div>
        </div>

        <ol class="fr-local-media-sentence-list" data-local-media-sentences>
          <li
            v-for="(item, idx) in sentenceRows"
            :key="item.sentence.id"
            class="fr-local-media-sentence-item"
            :class="{'is-current': idx === activeSentenceIndex}"
          >
            <button
              type="button"
              class="fr-local-media-sentence-btn"
              :data-sentence-index="idx"
              :aria-current="idx === activeSentenceIndex ? 'true' : undefined"
              @click="selectSentence(idx)"
            >
              <time class="fr-local-media-time">{{ formatMediaTimestamp(item.sentence.startMs) }}</time>
              <span class="fr-local-media-sentence-texts">
                <span class="fr-local-media-sentence-source">{{ item.sentence.text }}</span>
                <span v-if="item.translation" class="fr-local-media-sentence-translation">{{ item.translation }}</span>
              </span>
            </button>
          </li>
        </ol>

        <div class="fr-local-media-export-bar" data-local-media-export>
          <label class="fr-local-media-inline-field">
            <span>{{ t('video.localMedia.exportMode') }}</span>
            <select :value="exportMode" data-local-media-export-mode :aria-label="t('video.localMedia.exportMode')" @change="onExportModeChange">
              <option value="bilingual">{{ t('video.localMedia.modeBilingual') }}</option>
              <option value="original">{{ t('video.localMedia.modeOriginal') }}</option>
              <option value="translated">{{ t('video.localMedia.modeTranslated') }}</option>
            </select>
          </label>
          <label class="fr-local-media-inline-field">
            <span>{{ t('video.exportFormat') }}</span>
            <select :value="exportFormat" data-local-media-export-format :aria-label="t('video.exportFormat')" @change="onExportFormatChange">
              <option value="srt">SRT</option>
              <option value="vtt">WebVTT</option>
              <option value="md">Markdown</option>
            </select>
          </label>
          <button
            type="button"
            class="fr-local-media-btn"
            data-local-media-action="export"
            :disabled="!canExport"
            @click="exportSubtitles"
          >
            {{ t('video.localMedia.exportAction') }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="errorMessage" class="fr-local-media-error" role="alert" data-local-media-error>{{ errorMessage }}</p>
  </section>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref} from 'vue';
import type {Config, VideoSubtitleDisplayMode} from '@/src/core/config/model';
import {useUiI18n} from '@/src/ui/i18n';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {translateVideoText} from '@/src/services/translation/client';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';
import {buildVideoSentenceTimeline, createVideoSentenceTimeIndex} from '../content/sentenceTimeline';
import type {SubtitleExportFormat} from '../content/subtitleExport';
import {
    LOCAL_MEDIA_ACCEPT_ATTRIBUTE,
    formatMediaBytes,
    formatMediaTimestamp,
    validateLocalMediaFile,
    type LocalMediaKind,
} from './mediaValidation';
import type {LocalMediaDecodePorts} from './audioDecoder';
import {
    LocalMediaTranscriptionSession,
    buildLocalMediaExport,
    type LocalMediaExportMode,
    type LocalMediaSessionSnapshot,
} from './transcriptionService';

const props = withDefaults(defineProps<{
    config: Config;
    active?: boolean;
    sendMessage?: (message: unknown) => Promise<unknown>;
    translateText?: (text: string, signal: AbortSignal, sourceLanguage?: string) => Promise<string>;
    downloadFile?: (filename: string, content: string, mime: string) => void;
    decodePorts?: LocalMediaDecodePorts;
}>(), {
    active: true,
});

const {t} = useUiI18n();
const extensionDomSupported = computed(() => browserCapabilities.extensionDom);
const canOperate = computed(() => props.active && props.config.videoTranslationEnabled && extensionDomSupported.value);

const fileInput = ref<HTMLInputElement | null>(null);
const mediaElement = ref<HTMLMediaElement | null>(null);
const dragging = ref(false);
const selectedFile = ref<File | null>(null);
const baseName = ref('local-media');
const mediaKind = ref<LocalMediaKind>('video');
const objectUrl = ref('');
const validationError = ref('');
const currentTimeMs = ref(0);
const activeSentenceIndex = ref(0);
const playbackAssist = ref<'off' | 'loop' | 'pause'>('off');
const displayMode = ref<VideoSubtitleDisplayMode | 'off'>('bilingual');
const exportMode = ref<LocalMediaExportMode>('bilingual');
const exportFormat = ref<SubtitleExportFormat>('srt');

const snapshot = ref<LocalMediaSessionSnapshot>({
    phase: 'idle',
    progress: 0,
    windowIndex: 0,
    windowCount: 0,
    translatedCount: 0,
    failedTranslationCount: 0,
    totalCues: 0,
    durationMs: 0,
    cues: [],
    error: '',
});

const session = new LocalMediaTranscriptionSession({
    send: message => (props.sendMessage ?? sendRuntimeMessage)(message),
    translate: (text, signal, sourceLanguage) => (props.translateText ?? translateVideoText)(text, signal, sourceLanguage),
    getModel: () => props.config.videoLocalModel,
    getSourceLanguage: () => props.config.videoSourceLanguage || 'auto',
    getTargetLanguage: () => props.config.to,
    getProvider: () => props.config.videoTranscriptionProvider,
    getNativeBaseUrl: () => props.config.videoNativeAsrBaseUrl,
    decode: props.decodePorts,
    onUpdate: next => {
        snapshot.value = next;
    },
});

const busy = computed(() => ['checking', 'decoding', 'transcribing', 'translating'].includes(snapshot.value.phase));
const errorMessage = computed(() => validationError.value || snapshot.value.error);

const statusText = computed(() => {
    const state = snapshot.value;
    if (state.phase === 'checking') return t('video.localMedia.phaseChecking');
    if (state.phase === 'decoding') return t('video.localMedia.phaseDecoding');
    if (state.phase === 'transcribing') {
        return t('video.localMedia.phaseTranscribing', {
            current: state.windowIndex,
            total: Math.max(1, state.windowCount),
        });
    }
    if (state.phase === 'translating') {
        return t('video.localMedia.phaseTranslating', {
            current: state.translatedCount,
            total: Math.max(1, state.totalCues),
        });
    }
    return t('video.localMedia.phaseReady', {count: state.totalCues});
});

const activeCue = computed(() => {
    const time = currentTimeMs.value;
    return snapshot.value.cues.find(cue => time >= cue.startMs && time < cue.startMs + cue.durationMs) ?? null;
});

const activeCueTranslation = computed(() => {
    const cue = activeCue.value;
    if (!cue?.translation) return '';
    return displayMode.value === 'bilingual' && cue.translation === cue.text ? '' : cue.translation;
});

const sentences = computed(() => buildVideoSentenceTimeline(snapshot.value.cues));
const sentenceIndex = computed(() => createVideoSentenceTimeIndex(sentences.value));

const sentenceRows = computed(() => sentences.value.map(sentence => {
    const translatedParts = sentence.cueIndices
        .map(cueIndex => snapshot.value.cues[cueIndex]?.translation?.trim() || '')
        .filter(Boolean);
    return {
        sentence,
        translation: translatedParts.join(' '),
    };
}));

const canExport = computed(() => {
    if (busy.value || snapshot.value.cues.length === 0) return false;
    if (exportMode.value === 'translated') return snapshot.value.translatedCount > 0;
    return true;
});

function revokeCurrentUrl(): void {
    if (objectUrl.value) {
        URL.revokeObjectURL(objectUrl.value);
        objectUrl.value = '';
    }
}

function openFilePicker(): void {
    fileInput.value?.click();
}

function loadFile(file: File): void {
    validationError.value = '';
    const check = validateLocalMediaFile(file);
    if (!check.ok) {
        validationError.value = check.code === 'empty'
            ? t('video.localMedia.errorEmpty')
            : check.code === 'tooLarge'
                ? t('video.localMedia.errorTooLarge')
                : t('video.localMedia.errorUnsupported');
        return;
    }
    session.reset();
    revokeCurrentUrl();
    selectedFile.value = file;
    baseName.value = check.baseName;
    mediaKind.value = check.kind;
    objectUrl.value = URL.createObjectURL(file);
    currentTimeMs.value = 0;
    activeSentenceIndex.value = 0;
    playbackAssist.value = 'off';
}

function onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) loadFile(file);
}

function onDrop(event: DragEvent): void {
    dragging.value = false;
    if (!canOperate.value) return;
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
}

function clearFile(): void {
    session.reset();
    revokeCurrentUrl();
    selectedFile.value = null;
    validationError.value = '';
    currentTimeMs.value = 0;
    activeSentenceIndex.value = 0;
    playbackAssist.value = 'off';
}

function onDisplayModeChange(event: Event): void {
    displayMode.value = (event.target as HTMLSelectElement).value as VideoSubtitleDisplayMode | 'off';
}

function onExportModeChange(event: Event): void {
    exportMode.value = (event.target as HTMLSelectElement).value as LocalMediaExportMode;
}

function onExportFormatChange(event: Event): void {
    exportFormat.value = (event.target as HTMLSelectElement).value as SubtitleExportFormat;
}

function startTranscription(): void {
    if (!canOperate.value) return;
    validationError.value = '';
    void session.transcribe(selectedFile.value!, displayMode.value !== 'original-only');
}

function cancelWork(): void {
    session.cancel();
}

function retryPendingTranslations(): void {
    void session.translatePending();
}

function seekToSentence(index: number): void {
    const target = sentences.value[index];
    const media = mediaElement.value!;
    media.currentTime = target.startMs / 1000;
    currentTimeMs.value = target.startMs;
    void media.play?.().catch(() => undefined);
}

function selectSentence(index: number): void {
    activeSentenceIndex.value = index;
    seekToSentence(index);
}

function stepSentence(delta: number): void {
    selectSentence(activeSentenceIndex.value + delta);
}

function replayActiveSentence(): void {
    seekToSentence(activeSentenceIndex.value);
}

function togglePlaybackAssist(mode: 'loop' | 'pause'): void {
    playbackAssist.value = playbackAssist.value === mode ? 'off' : mode;
}

function onTimeUpdate(): void {
    const media = mediaElement.value!;
    const ms = Math.max(0, media.currentTime * 1000);
    currentTimeMs.value = ms;

    const current = sentences.value[activeSentenceIndex.value];
    if (current && playbackAssist.value !== 'off' && ms >= current.endMs) {
        if (playbackAssist.value === 'loop') {
            media.currentTime = current.startMs / 1000;
            currentTimeMs.value = current.startMs;
            void media.play?.().catch(() => undefined);
            return;
        }
        media.pause?.();
        return;
    }

    if (playbackAssist.value === 'off') {
        const matchedIndex = sentenceIndex.value.findIndexAtTime(ms);
        if (matchedIndex >= 0) activeSentenceIndex.value = matchedIndex;
    }
}

function exportSubtitles(): void {
    if (!canExport.value) return;
    const output = buildLocalMediaExport(baseName.value, snapshot.value.cues, exportMode.value, exportFormat.value);
    (props.downloadFile ?? downloadTextFile)(output.filename, output.text, output.mime);
}

onBeforeUnmount(() => {
    session.destroy();
    revokeCurrentUrl();
});
</script>

<style scoped>
.fr-local-media-studio {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--fr-border, rgba(128, 128, 128, 0.25));
  border-radius: 12px;
  background: var(--fr-surface-subtle, rgba(127, 127, 127, 0.04));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fr-local-media-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}
.fr-local-media-header h3 {
  margin: 0;
  font-size: 15px;
}
.fr-local-media-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.8;
}
.fr-local-media-file-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.fr-local-media-file-name {
  font-weight: 600;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fr-local-media-dropzone {
  position: relative;
  border: 1.5px dashed var(--fr-border, rgba(128, 128, 128, 0.4));
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.fr-local-media-dropzone.is-dragging {
  border-color: var(--fr-accent, #2563eb);
  background: rgba(37, 99, 235, 0.06);
}
.fr-local-media-file-input {
  display: none;
}
.fr-local-media-drop-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}
.fr-local-media-drop-formats {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}
.fr-local-media-workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fr-local-media-toolbar,
.fr-local-media-learning-bar,
.fr-local-media-learning-controls,
.fr-local-media-export-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fr-local-media-learning-bar {
  justify-content: space-between;
}
.fr-local-media-inline-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.fr-local-media-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--fr-border, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.fr-local-media-btn.is-primary {
  background: var(--fr-accent, #2563eb);
  border-color: var(--fr-accent, #2563eb);
  color: #fff;
}
.fr-local-media-btn.is-danger {
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;
}
.fr-local-media-btn.is-active {
  border-color: var(--fr-accent, #2563eb);
  font-weight: 600;
}
.fr-local-media-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fr-local-media-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}
.fr-local-media-progress {
  width: 180px;
  height: 8px;
}
.fr-local-media-player-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fr-local-media-video,
.fr-local-media-audio {
  width: 100%;
  border-radius: 8px;
  background: #000;
}
.fr-local-media-audio {
  background: transparent;
}
.fr-local-media-overlay {
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.86);
  color: #fff;
  text-align: center;
}
.fr-local-media-overlay-source {
  margin: 0;
  font-size: 14px;
}
.fr-local-media-overlay-translation {
  margin: 4px 0 0;
  font-size: 14px;
  color: #fde047;
}
.fr-local-media-sentence-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fr-local-media-sentence-item.is-current .fr-local-media-sentence-btn {
  border-color: var(--fr-accent, #2563eb);
  background: rgba(37, 99, 235, 0.08);
}
.fr-local-media-sentence-btn {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--fr-border, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: inherit;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  cursor: pointer;
}
.fr-local-media-time {
  font-size: 11px;
  opacity: 0.7;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.fr-local-media-sentence-texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.fr-local-media-sentence-translation {
  opacity: 0.8;
  font-size: 12px;
}
.fr-local-media-warning,
.fr-local-media-error {
  margin: 0;
  font-size: 12px;
  color: #dc2626;
}
</style>
