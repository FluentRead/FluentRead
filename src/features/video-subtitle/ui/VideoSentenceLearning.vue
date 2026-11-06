<!--
 * @file src/features/video-subtitle/ui/VideoSentenceLearning.vue
 * 文件职责：在现有播放器上提供可关闭的完整句学习面板，连接原始字幕、主动播放控制和现有收藏。
 * 主要内容：以双语阅读卡呈现原句、可选本地读音、译文和按需讲解；服务与后台错误仅在错误展示边界本地化，字幕、译文与模型正文保留原值；索引跟随播放、合并快速换句的翻译请求，读音独立跟随固定句或历史句、失败可单独重试、收起时取消且不新增请求；短高换句只归顶自有整卡滚动区，按配置身份管理自动译文、人工草稿与准确的异步收藏状态。
 * 语义边界：规则与主动 AI 共用无损优化器，句内切分使用明确的原 cue 回放包络；模型失败保留当前结果，材料与配置变化取消旧请求。
 * 材料关联：完整句收藏与问答引用归于可靠视频来源与原始时间，关闭、更换句子和隐私状态禁止迟到关联。
 * 模块边界：不创建或定位播放器，学习键只接受包含当前视频的显式逻辑播放器及面板自身，菜单让位限定已验证同视频范围；不采集音频或计算掌握状态，翻译沿用注入服务，卸载取消控制与迟到回写。
 -->
<template>
  <section ref="panel" class="fr-video-learning" :class="{'is-collapsed': !expanded}" :style="appearanceStyle" :data-learning-layout="appearance.layout" role="region" :aria-label="t('video.learning.title')" tabindex="-1"
    :data-learning-sentence-id="sentence?.id" :data-learning-sentence-index="index" :data-learning-pinned="pinned"
    :data-start-ms="sentence?.startMs" :data-end-ms="sentence?.endMs" @click.stop @pointerdown.stop>
    <header class="fr-video-learning-header">
      <div class="fr-video-learning-heading" data-learning-drag-handle :title="t('video.learning.drag')"><svg class="fr-video-learning-grip" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01" /></svg><strong>{{ t('video.learning.title') }}</strong></div>
      <div class="fr-video-learning-header-actions">
        <button type="button" class="fr-video-learning-icon fr-video-learning-help-toggle" data-learning-action="help" :aria-label="t('video.learning.help')" :title="t('video.learning.help')" :aria-expanded="helpOpen" @click="helpOpen = !helpOpen">?</button>
        <button type="button" class="fr-video-learning-icon" data-learning-action="appearance" :aria-label="t('video.learning.appearance')" :title="t('video.learning.appearance')" @click="openAppearance"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 6h8M15 6h2M3 14h2M9 14h8M12 3v6M6 11v6" /></svg></button>
        <button type="button" class="fr-video-learning-icon" data-learning-action="collapse" :aria-label="t(expanded ? 'video.learning.collapse' : 'video.learning.expand')" :title="t(expanded ? 'video.learning.collapse' : 'video.learning.expand')" :aria-expanded="expanded" @click="expanded = !expanded"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true" :class="{'is-flipped': !expanded}"><path d="m5 12 5-5 5 5" /></svg></button>
        <button type="button" class="fr-video-learning-icon" data-learning-action="close" :aria-label="t('video.learning.close')" :title="t('video.learning.close')" @click="emit('close')"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg></button>
      </div>
    </header>
    <button v-if="!expanded && sentence" type="button" class="fr-video-learning-peek" data-learning-peek @click="expanded = true">{{ sentence.text }}</button>
    <div ref="body" v-show="expanded" class="fr-video-learning-body">
      <template v-if="sentence">
        <div class="fr-video-learning-position"><span>{{ index + 1 }} <span class="fr-video-learning-dim">/ {{ sentences.length }}</span> · {{ timeLabel }}</span><span v-if="!sentence.complete" class="fr-video-learning-badge">{{ t('video.learning.fragment') }}</span></div>
        <p class="fr-video-learning-original" data-learning-original>{{ sentence.text }}</p>
        <p class="fr-video-learning-hint" data-learning-timing-precision>{{ t('video.learning.cueEnvelope') }}</p>
        <div v-if="browserCapabilities.extensionDom" class="fr-video-learning-semantic" :aria-busy="semanticBusy">
          <p v-if="!semanticPrivacyAllowed" class="fr-video-learning-hint" data-learning-semantic-privacy role="status">{{ t(semanticPrivacyKey) }}</p>
          <button v-else-if="!semanticEnabled" type="button" class="fr-video-learning-text-button" data-learning-action="segment-configure" @click="openSemanticSettings">{{ t('video.learning.configureSegmentation') }}</button>
          <template v-else>
            <button type="button" class="fr-video-learning-text-button" data-learning-action="segment" :disabled="semanticBusy" @click="segmentCurrentGroup">{{ t(semanticBusy ? 'video.learning.segmenting' : semanticOverrides.has(sentence.sourceKey) ? 'video.learning.resegment' : 'video.learning.segment') }}</button>
            <button v-if="semanticBusy" type="button" class="fr-video-learning-text-button" data-learning-action="segment-cancel" @click="cancelSemanticRequest">{{ t('video.learning.cancelSegmentation') }}</button>
          </template>
          <p v-if="semanticStatus" class="fr-video-learning-status" data-learning-semantic-status role="status" aria-live="polite">{{ semanticStatus }}</p>
        </div>
        <p v-if="readingText" class="fr-video-learning-reading" :lang="`${readingLanguage}-Latn`" :aria-label="t(`video.readingAnnotation.${readingLanguage}`)" data-learning-reading>{{ readingText }}</p>
        <div v-if="readingError" class="fr-video-learning-reading-error" role="status" data-learning-reading-error><span>{{ t('video.readingAnnotation.error') }}</span><button type="button" class="fr-video-learning-text-button" data-learning-action="retry-reading" @click="loadReadingAnnotation">{{ t('video.readingAnnotation.retry') }}</button></div>
        <div class="fr-video-learning-follow"><span :class="{'is-pinned': pinned}"><i aria-hidden="true"></i>{{ t(pinned ? 'video.learning.pinned' : 'video.learning.follow') }}</span><button v-if="pinned" type="button" class="fr-video-learning-text-button" data-learning-action="follow" @click="returnToCurrent">{{ t('video.learning.returnCurrent') }}</button></div>
        <div class="fr-video-learning-card" :aria-busy="translating && !translationEdited">
          <div class="fr-video-learning-card-heading"><span>{{ t('video.learning.translationTitle') }}</span><button type="button" class="fr-video-learning-text-button" :data-learning-action="editingTranslation ? 'done-translation' : 'edit-translation'" @click="editTranslation">{{ t(editingTranslation ? 'video.learning.done' : 'video.learning.edit') }}</button></div>
          <textarea v-if="editingTranslation" ref="translationEditor" v-model="translation" data-learning-translation :aria-label="t('video.learning.translation')" :placeholder="t('video.learning.editPlaceholder')" rows="2" maxlength="6000" @focus="pinCurrent" @input="onTranslationInput" />
          <p v-else class="fr-video-learning-translation" data-learning-translation-display :aria-busy="translating && !translationEdited" :class="{'is-loading': translating && !translation}">{{ translation || (translating ? t('video.learning.translating') : '') }}</p>
          <div v-if="translationError" class="fr-video-learning-inline-error" role="alert"><span>{{ translateLegacy(translationError) }}</span><button type="button" class="fr-video-learning-text-button" @click="loadTranslation">{{ t('video.retryTranslation') }}</button></div>
        </div>
        <p class="fr-video-learning-mode-caption">{{ t('video.learning.mode') }}</p>
        <div class="fr-video-learning-mode" role="group" :aria-label="t('video.learning.mode')">
          <button type="button" data-learning-action="normal" :aria-pressed="mode === 'off'" @click="normal">{{ t('video.learning.normal') }}</button>
          <button type="button" data-learning-action="loop" :aria-pressed="mode === 'loop'" @click="toggleMode('loop')">{{ t('video.learning.loopSource') }}</button>
          <button type="button" data-learning-action="pause-at-end" :aria-pressed="mode === 'pause'" @click="toggleMode('pause')">{{ t('video.learning.pauseSource') }}</button>
        </div>
        <div v-if="explanation || explaining || editingExplanation || explanationStopped" class="fr-video-learning-card fr-video-learning-explanation">
          <div class="fr-video-learning-card-heading"><span>{{ t('video.learning.explanationTitle') }}</span><span v-if="explaining" class="fr-video-learning-dim">{{ t('video.learning.explaining') }}</span><span v-else-if="explanationStopped" class="fr-video-learning-dim">{{ t('video.learning.stoppedShort') }}</span><button v-if="explaining" type="button" class="fr-video-learning-text-button" data-learning-action="stop-explanation" @click="stopExplanation">{{ t('video.learning.stop') }}</button><button v-else type="button" class="fr-video-learning-text-button" :data-learning-action="editingExplanation ? 'done-explanation' : 'edit-explanation'" @click="editExplanation">{{ t(editingExplanation ? 'video.learning.done' : 'video.learning.edit') }}</button></div>
          <textarea v-if="editingExplanation" ref="explanationEditor" v-model="explanation" data-learning-explanation :aria-label="t('video.learning.explanation')" rows="3" maxlength="2000" @focus="pinCurrent" />
          <div v-else data-learning-explanation-display :aria-busy="explaining"><ReadingAnswer v-if="explanation" :text="explanation" /><p v-else class="is-loading">{{ t(explanationStopped ? 'video.learning.stoppedShort' : 'video.learning.explaining') }}</p></div>
        </div>
        <details class="fr-video-learning-context" @toggle="onContextToggle"><summary>{{ t('video.learning.context') }}</summary><p v-if="sentence.previousText">{{ sentence.previousText }}</p><p class="is-current">{{ sentence.text }}</p><p v-if="sentence.nextText">{{ sentence.nextText }}</p></details>
        <p v-if="saved" role="status" class="fr-video-learning-status fr-video-learning-saved-status"><span>{{ t('video.learning.savedShort') }}</span><button type="button" class="fr-video-learning-text-button" data-learning-action="library" @click="openLibrary">{{ t('video.learning.library') }} ↗</button></p>
        <p v-if="helpOpen" class="fr-video-learning-hint" data-learning-help>{{ t('video.learning.hint') }}</p>
        <p v-if="notice" role="status" class="fr-video-learning-status">{{ notice }}</p>
        <p v-if="error" role="alert" class="fr-video-learning-inline-error">{{ translateLegacy(error) }}</p>
      </template>
      <p v-else class="fr-video-learning-empty">{{ t('video.learning.empty') }}</p>
    </div>
    <nav v-if="sentence" v-show="expanded" class="fr-video-learning-navigation" :aria-label="t('video.learning.replaySource')">
      <button type="button" class="fr-video-learning-icon" data-learning-action="previous" :aria-label="t('video.learning.previous')" :title="t('video.learning.previous')" :disabled="index <= 0" @click="step(-1)"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
      <button type="button" class="fr-video-learning-replay" data-learning-action="play" @click="replay"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 4 9 6-9 6Z" /></svg>{{ t('video.learning.replaySource') }}</button>
      <button type="button" class="fr-video-learning-icon" data-learning-action="next" :aria-label="t('video.learning.next')" :title="t('video.learning.next')" :disabled="index >= sentences.length - 1" @click="step(1)"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
    </nav>
    <footer v-if="sentence" v-show="expanded" class="fr-video-learning-footer">
      <div class="fr-video-learning-footer-actions">
        <button type="button" class="fr-video-learning-explain" data-learning-action="explain" :disabled="explaining" @click="explain">{{ t(explanation ? 'video.learning.explanationAgain' : 'video.learning.explain') }}</button>
        <button type="button" class="fr-video-learning-save" data-learning-action="save" :data-learning-saved="saved" :disabled="saved || saving || explaining || !translation.trim() || (translating && !translationEdited)" :title="!translation.trim() ? t('video.learning.editPlaceholder') : undefined" @click="save"><svg v-if="saved" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg>{{ t(saving ? 'video.learning.saving' : saved ? 'video.learning.savedShort' : savedSnapshot ? 'video.learning.update' : 'video.learning.save') }}</button>
      </div>
    </footer>
  </section>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import {useUiI18n} from '@/src/ui/i18n';
import {isHarnessService} from '@/src/core/config/harness';
import {config, subscribeConfig} from '@/src/services/config/store';
import {getVideoSentenceLearningAppearanceCssVars, normalizeVideoSentenceLearningAppearance} from '@/src/core/config/videoSentenceLearningAppearance';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
import {streamReading} from '@/src/features/reading-assistant/public';
import {beginMaterialCapture, completeMaterialCapture, type MaterialSelection} from '@/src/features/vocabulary/material/public';
import {VOCABULARY_BOOK_MESSAGE, normalizeLearningSourceText, type VocabularyBookResponse, type VocabularyUpsertInput} from '@/src/features/vocabulary/public';
import type {VideoSubtitleCue} from '../content/youtubeSubtitleData';
import {buildVideoSentenceTimeline} from '../content/sentenceTimeline';
import {buildSemanticLearningTimeline, createSemanticLearningTimeIndex, semanticSourceKey} from '../content/semanticLearningTimeline';
import {VideoSemanticSession} from '../content/semanticSession';
import {requestVideoSemanticBoundaries} from '../content/semanticClient';
import type {SemanticUnit} from '../semanticSegmentation';
import {getVideoTranslationConfigFingerprint} from '../content/subtitleLogic';
import {SentencePlaybackController, type SentencePlaybackMode} from '../content/sentencePlayback';
import {getYoutubeSubtitleControlsScope} from '../content/youtubeControlsScope';
import {VideoReadingAnnotationSession} from '../content/readingAnnotationSession';
import {annotateVideoReading} from '../content/readingAnnotationClient';

const props = defineProps<{video: HTMLVideoElement; player?: HTMLElement; cues: VideoSubtitleCue[]; platform: 'youtube' | 'x'; sourceUrl?: string;
  title: string; sourceLanguage: string; targetLanguage: string; translate: (text: string, signal: AbortSignal) => Promise<string>}>();
const emit = defineEmits<{close: []}>();
const {t, translateLegacy} = useUiI18n();
const appearance = ref(normalizeVideoSentenceLearningAppearance(config.videoSentenceLearningAppearance));
const appearanceStyle = computed(() => getVideoSentenceLearningAppearanceCssVars(appearance.value));
const helpOpen = ref(false);
const semanticOverrides = ref(new Map<string, SemanticUnit[]>());
const semanticBusy = ref(false);
const semanticPrivacyAllowed = browserCapabilities.extensionDom && browser.extension?.inIncognitoContext === false;
const semanticPrivacyKey = browser.extension?.inIncognitoContext === true ? 'video.learning.segmentationPrivate' : 'video.learning.segmentationPrivacyUnknown';
const semanticReady = () => semanticPrivacyAllowed && config.videoSemanticSegmentationEnabled === true
  && !!config.videoSemanticSegmentationService && !!config.videoSemanticSegmentationModel
  && isHarnessService(config.videoSemanticSegmentationService, config.customOpenAIProviders);
const semanticEnabled = ref(semanticReady());
const semanticFeedback = ref<{sourceKey: string; message: string}>();
let semanticGeneration = 0;
const sentences = computed(() => buildSemanticLearningTimeline(props.cues, semanticOverrides.value));
const sentenceTimeIndex = computed(() => createSemanticLearningTimeIndex(sentences.value));
const index = ref(0);
const sentence = computed(() => sentences.value[index.value]);
const semanticStatus = computed(() => semanticBusy.value ? t('video.learning.segmenting')
  : semanticFeedback.value?.sourceKey === sentence.value?.sourceKey ? semanticFeedback.value?.message : '');
const mode = ref<SentencePlaybackMode>('off');
const translating = ref(false); const translation = ref(''); const translationEdited = ref(false); const translationError = ref('');
const explanation = ref(''); const explaining = ref(false); const saving = ref(false); const notice = ref(''); const error = ref('');
let controller: SentencePlaybackController | undefined;
let request: {cancel: () => void} | undefined;
let translationAbort: AbortController | undefined;
let translationTimer: ReturnType<typeof setTimeout> | undefined;
let deferredSentenceId: string | undefined;
let generation = 0; let active = true; let explanationGeneration = 0;
const pinned = ref(false); const expanded = ref(true); const editingTranslation = ref(false); const editingExplanation = ref(false); const explanationStopped = ref(false);
const translationEditor = ref<HTMLTextAreaElement>(); const explanationEditor = ref<HTMLTextAreaElement>();
const body = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const readingText = ref(''); const readingLanguage = ref(''); const readingError = ref(false);
const readingEnabled = ref(browserCapabilities.extensionDom && config.videoSubtitleAppearance.readingAnnotation === true && config.on && config.videoTranslationEnabled && config.videoSubtitleVisible);
const readingSession = new VideoReadingAnnotationSession(annotateVideoReading);
let readingGeneration = 0;
const savedSnapshot = ref('');
const snapshot = () => JSON.stringify([sentence.value?.id, translation.value.trim(), explanation.value.trim()]);
const saved = computed(() => !!savedSnapshot.value && savedSnapshot.value === snapshot());
const draftKey = () => JSON.stringify([sentence.value?.id, props.sourceLanguage, props.targetLanguage]);
type Draft = {translation: string; edited: boolean; revision: string; explanation: string; stopped: boolean; savedSnapshot: string};
const drafts = new Map<string, Draft>();
let translationRevision = getVideoTranslationConfigFingerprint(config);
const timeLabel = computed(() => {
  const format = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return sentence.value ? `${format(sentence.value.startMs)}–${format(sentence.value.endMs)}` : '';
});
const semanticRevision = () => JSON.stringify([props.sourceUrl, props.sourceLanguage, props.cues, config.videoSemanticSegmentationEnabled,
  config.videoSemanticSegmentationService, config.videoSemanticSegmentationModel, getVideoTranslationConfigFingerprint(config)]);
const semanticSession = new VideoSemanticSession(requestVideoSemanticBoundaries, semanticRevision);
function cancelSemantics(): void { semanticGeneration++; semanticSession.cancel(); semanticBusy.value = false; }
function cancelSemanticRequest(): void {
  cancelSemantics();
  if (sentence.value) semanticFeedback.value = {sourceKey: sentence.value.sourceKey, message: t('video.learning.segmentationCancelled')};
}
function openSemanticSettings(): void {
  void sendRuntimeMessage({type: 'openOptionsPage', section: 'settings-video', target: 'video-semantic-segmentation'}).catch(() => undefined);
}
async function segmentCurrentGroup(): Promise<void> {
  const current = sentence.value;
  if (!current || semanticBusy.value || !semanticEnabled.value || !canTranslate()) return;
  const group = buildVideoSentenceTimeline(props.cues).find(item => item.id === current.playbackGroupId);
  if (!group) return;
  const sourceKey = semanticSourceKey(group, props.cues);
  const revision = semanticRevision(); const owner = ++semanticGeneration;
  const previousUnits = sentences.value.filter(item => item.sourceKey === sourceKey).map(item => [item.semanticStart, item.semanticEnd]);
  pinned.value = true; semanticBusy.value = true; semanticFeedback.value = undefined; error.value = '';
  try {
    const units = await semanticSession.request(group.cueIndices.map(at => props.cues[at]));
    if (!active || owner !== semanticGeneration || revision !== semanticRevision()) return;
    const next = new Map(semanticOverrides.value); next.set(sourceKey, units);
    if (next.size > 100) next.delete(next.keys().next().value!);
    semanticOverrides.value = next;
    const unchanged = JSON.stringify(previousUnits) === JSON.stringify(units.map(unit => [unit.start, unit.end]));
    semanticFeedback.value = {sourceKey, message: t(unchanged ? 'video.learning.segmentationUnchanged' : 'video.learning.segmentationUpdated')};
  } catch (cause) {
    if (active && owner === semanticGeneration && revision === semanticRevision() && !(cause instanceof DOMException && cause.name === 'AbortError')) {
      error.value = t(cause instanceof DOMException && cause.name === 'TimeoutError' ? 'video.learning.segmentationTimeout' : 'video.learning.segmentationFailed');
    }
  } finally { if (owner === semanticGeneration && revision === semanticRevision()) semanticBusy.value = false; }
}
watch([() => props.cues, () => props.sourceUrl, () => props.sourceLanguage], () => {
  cancelSemantics(); semanticFeedback.value = undefined; semanticOverrides.value = new Map();
}, {deep: true});
function cancelExplanation(): void { explanationGeneration++; request?.cancel(); request = undefined; explaining.value = false; }
function cancelTranslationTimer(): void { if (translationTimer !== undefined) clearTimeout(translationTimer); translationTimer = undefined; }
function cancelTranslation(): void { cancelTranslationTimer(); translationAbort?.abort(); translationAbort = undefined; translating.value = false; }
function cancelPending(): void { cancelSemantics(); generation++; cancelExplanation(); cancelTranslation(); }
function canTranslate(): boolean { return active && expanded.value && config.on && config.videoTranslationEnabled && config.videoSubtitleVisible; }
function scheduleTranslation(delay = 0): void {
  if (!canTranslate() || !sentence.value || translation.value || translationEdited.value) return;
  if (translating.value && translationAbort && !translationAbort.signal.aborted) return;
  if (!delay) { void loadTranslation(); return; }
  translating.value = true;
  translationTimer = setTimeout(() => { translationTimer = undefined; void loadTranslation(); }, delay);
}
function followPlayback(): void {
  if (pinned.value || mode.value !== 'off' || props.video.seeking) return;
  const current = sentenceTimeIndex.value.findIndexAtTime(props.video.currentTime * 1000, index.value);
  if (current >= 0 && current !== index.value) index.value = current;
}
function onSeeking(): void { if (!controller?.getState().sentence) pinned.value = false; }
function pinCurrent(): void { pinned.value = true; }
function onTranslationInput(): void { translationEdited.value = true; pinned.value = true; translationError.value = ''; cancelTranslation(); }
function editTranslation(): void { editingTranslation.value = !editingTranslation.value; if (editingTranslation.value) { pinCurrent(); void nextTick(() => { if (active && editingTranslation.value) translationEditor.value?.focus(); }); } }
function editExplanation(): void { editingExplanation.value = !editingExplanation.value; if (editingExplanation.value) { pinCurrent(); void nextTick(() => { if (active && editingExplanation.value) explanationEditor.value?.focus(); }); } }
function onContextToggle(event: Event): void { if ((event.target as HTMLDetailsElement).open) pinCurrent(); }
function returnToCurrent(): void { controller?.stop(); pinned.value = false; editingTranslation.value = false; editingExplanation.value = false; followPlayback(); }
function stopExplanation(): void { cancelExplanation(); explanationStopped.value = true; notice.value = t('video.learning.stopped'); }
function loadReadingAnnotation(): void {
  const current = ++readingGeneration;
  readingSession.cancelPending();
  readingText.value = ''; readingLanguage.value = ''; readingError.value = false;
  if (!active || !expanded.value || !readingEnabled.value || !sentence.value) return;
  const source = sentence.value.text;
  void readingSession.request(source, props.sourceLanguage || config.from || 'auto').then(result => {
    if (!active || current !== readingGeneration || !expanded.value || !readingEnabled.value || !result?.text) return;
    readingText.value = result.text; readingLanguage.value = result.language.split('-')[0];
  }).catch(() => {
    // 只提示仍属于当前句的失败；换句、收起和卸载导致的旧代次 AbortError 不得误报。
    if (active && current === readingGeneration && expanded.value && readingEnabled.value) readingError.value = true;
  });
}
watch([() => sentence.value?.id, () => props.sourceLanguage, expanded, readingEnabled, () => props.video, () => props.sourceUrl], (next, previous) => {
  if (previous && (next[4] !== previous[4] || next[5] !== previous[5])) readingSession.clear();
  loadReadingAnnotation();
}, {immediate: true});
watch(() => props.video, (video, previous) => {
  previous?.removeEventListener('timeupdate', followPlayback); previous?.removeEventListener('seeking', onSeeking);
  (previous?.ownerDocument?.defaultView ?? previous?.ownerDocument)?.removeEventListener('keydown', onPlayerKeydown, true);
  controller?.destroy(); pinned.value = false; mode.value = 'off';
  controller = new SentencePlaybackController(video, undefined, state => { mode.value = state.mode; });
  video.addEventListener('timeupdate', followPlayback); video.addEventListener('seeking', onSeeking);
  (video.ownerDocument?.defaultView ?? video.ownerDocument)?.addEventListener('keydown', onPlayerKeydown, true);
  followPlayback();
}, {immediate: true});
watch(sentences, (next, previous) => {
  const selected = previous?.[index.value];
  const retained = selected ? next.findIndex(item => item.id === selected.id) : -1;
  if (retained >= 0) { index.value = retained; return; }
  const sameSource = selected ? next.findIndex(item => item.sourceKey === selected.sourceKey
    && item.semanticStart <= selected.semanticStart && selected.semanticStart < item.semanticEnd) : -1;
  if (sameSource >= 0) { controller?.stop(); index.value = sameSource; return; }
  controller?.stop(); pinned.value = false; index.value = 0; followPlayback();
}, {immediate: true});
watch([() => sentence.value?.id, () => props.sourceLanguage, () => props.targetLanguage], (next, previous) => {
  if (previous?.[0]) {
    drafts.set(JSON.stringify(previous), {translation: translation.value, edited: translationEdited.value, revision: translationRevision, explanation: explaining.value ? '' : explanation.value, stopped: explanationStopped.value, savedSnapshot: savedSnapshot.value});
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  }
  cancelPending(); const draft = drafts.get(JSON.stringify(next));
  translationEdited.value = draft?.edited || false;
  translation.value = draft && (draft.edited || draft.revision === translationRevision) ? draft.translation : '';
  explanation.value = draft?.explanation || ''; explanationStopped.value = draft?.stopped || false; savedSnapshot.value = draft?.savedSnapshot || '';
  editingTranslation.value = false; editingExplanation.value = false; error.value = ''; notice.value = ''; translationError.value = '';
  scheduleTranslation(next[0] === deferredSentenceId ? 120 : 0); deferredSentenceId = undefined;
  if (next[0] !== previous?.[0]) void nextTick(() => {
    if (!active || !body.value) return;
    body.value.scrollTop = 0;
    if (panel.value?.closest('#fluent-read-video-learning-panel[data-short-height="true"]')) panel.value.scrollTop = 0;
  });
}, {immediate: true});
watch(expanded, (open) => {
  if (!open) cancelSemantics();
  if (open) scheduleTranslation();
  else if (translationTimer !== undefined) { cancelTranslationTimer(); translating.value = false; }
});
async function loadTranslation(): Promise<void> {
  cancelTranslationTimer();
  if (!sentence.value || !canTranslate() || translationEdited.value) return;
  translationAbort?.abort(); const abort = new AbortController(); translationAbort = abort;
  const owner = generation; const source = sentence.value.text; translationError.value = ''; translating.value = true;
  try {
    const result = await props.translate(source, abort.signal);
    if (active && owner === generation && translationAbort === abort && !abort.signal.aborted && !translationEdited.value) {
      if (!result.trim()) throw new Error(t('video.learning.translationFailed'));
      translation.value = result;
    }
  } catch (cause) {
    if (active && owner === generation && translationAbort === abort && !abort.signal.aborted) translationError.value = cause instanceof Error ? cause.message : t('video.learning.translationFailed');
  } finally { if (active && owner === generation && translationAbort === abort) translating.value = false; }
}
function step(direction: number): void {
  const next = Math.max(0, Math.min(sentences.value.length - 1, index.value + direction));
  if (next === index.value || !sentences.value[next]) return;
  deferredSentenceId = sentences.value[next].id;
  const samePlayback = sentence.value?.startMs === sentences.value[next].startMs
    && sentence.value?.endMs === sentences.value[next].endMs;
  pinned.value = true; index.value = next; controller?.select(sentences.value[next], mode.value, !samePlayback);
}
async function replay(): Promise<void> {
  if (!sentence.value) return;
  pinned.value = true; controller?.select(sentence.value, mode.value, true);
  const owner = generation;
  try { await props.video.play(); } catch { if (active && owner === generation) error.value = t('video.learning.playFailed'); }
}
function toggleMode(next: SentencePlaybackMode): void {
  if (!sentence.value) return;
  pinned.value = true;
  const selectedMode = mode.value === next ? 'off' : next;
  if (controller?.getState().sentence?.id === sentence.value.id) controller.setMode(selectedMode);
  else controller?.select(sentence.value, selectedMode, false);
}
function normal(): void { controller?.stop(); }
function openLibrary(): void { void sendRuntimeMessage({type: 'openOptionsPage', section: 'settings-vocabulary'}).catch(() => undefined); }
function openAppearance(): void { void sendRuntimeMessage({type: 'openOptionsPage', section: 'settings-interface', target: 'video-sentence-learning-appearance'}).catch(() => undefined); }
function videoMaterial(): MaterialSelection | undefined {
  const selected = sentence.value;
  return props.sourceUrl && selected ? {source: {kind: 'video', url: props.sourceUrl, title: props.title}, locator: {kind: 'video', quote: selected.text, startMs: Math.floor(selected.startMs), endMs: Math.ceil(selected.endMs)}} : undefined;
}
function explain(): void {
  if (!sentence.value || explaining.value) return;
  if (!config.harness.enabled || !config.harness.actions.includes('usage')) {
    notice.value = t('video.learning.enableExplain');
    void sendRuntimeMessage({type: 'openOptionsPage', section: 'settings-selection'}).catch(() => undefined); return;
  }
  cancelExplanation(); const owner = generation; const explanationOwner = explanationGeneration; const owns = () => active && owner === generation && explanationOwner === explanationGeneration;
  pinned.value = true; editingExplanation.value = false; explanationStopped.value = false; explanation.value = ''; error.value = ''; notice.value = ''; explaining.value = true;
  const context = config.harness.contextMode === 'paragraph'
    ? [sentence.value.previousText.slice(-800), sentence.value.text, sentence.value.nextText.slice(0, 800)].filter(Boolean).join('\n') : '';
  try {
    const materialOperation = beginMaterialCapture(videoMaterial(), browser.extension?.inIncognitoContext === true);
    request = streamReading({type: 'fluentReadHarness', action: 'run', requestId: crypto.randomUUID(), intent: 'usage', studyMode: 'sentence',
      selection: {text: sentence.value.text, context, sentence: ''}, question: '简短解释这个句子的含义与一个关键表达；只依据原句和允许参考的字幕语境。'}, {
      progress(progress) { if (owns() && progress.kind === 'text') explanation.value = progress.text; },
      result(result) { if (!owns()) return; request = undefined; explaining.value = false;
        if (result.success) {explanation.value = result.text; if (result.sessionId) void materialOperation.then(operation => completeMaterialCapture(operation, {kind: 'session', id: result.sessionId!, excerpt: operation?.selection.locator?.quote}, owns));} else error.value = result.error; },
      error(cause) { if (owns()) { request = undefined; explaining.value = false; error.value = cause.message; } },
    });
  } catch (cause) { explaining.value = false; error.value = cause instanceof Error ? cause.message : t('video.learning.explainFailed'); }
}
async function save(): Promise<void> {
  if (!sentence.value || saved.value || saving.value || explaining.value) return;
  if (!translation.value.trim()) { error.value = t('video.learning.editPlaceholder'); return; }
  if (!normalizeLearningSourceText(sentence.value.text) || explanation.value.length > 2000) { error.value = t('video.learning.tooLong'); return; }
  const selected = sentence.value; const selectedKey = draftKey(); const selectedSnapshot = snapshot(); saving.value = true; error.value = ''; pinned.value = true;
  const input: VocabularyUpsertInput = {sourceLanguage: props.sourceLanguage || 'auto', targetLanguage: props.targetLanguage,
    term: selected.text, kind: 'sentence', translation: translation.value.trim(), note: explanation.value.trim(),
    context: {text: [selected.previousText.slice(-800), selected.text, selected.nextText.slice(0, 800)].filter(Boolean).join('\n'), sourceUrl: props.sourceUrl, pageTitle: props.title,
      video: {platform: props.platform, startMs: Math.floor(selected.startMs), endMs: Math.ceil(selected.endMs)}}};
  try {
    const operation = beginMaterialCapture(videoMaterial(), browser.extension?.inIncognitoContext === true);
    const response = await sendRuntimeMessage({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input}) as VocabularyBookResponse;
    if (!response.success) throw new Error(response.error.message);
    const id = (response.data as {id?: unknown})?.id;
    if (typeof id === 'string') await operation.then(capture => completeMaterialCapture(capture, {kind: 'vocabulary', id, excerpt: selected.text}, () => active));
    if (active) {
      const draft = drafts.get(selectedKey); if (draft) draft.savedSnapshot = selectedSnapshot;
      if (selectedKey === draftKey()) { savedSnapshot.value = selectedSnapshot; notice.value = ''; }
    }
  } catch (cause) { if (active && selectedKey === draftKey()) error.value = cause instanceof Error ? cause.message : t('video.learning.saveFailed'); }
  finally { if (active) saving.value = false; }
}
function onPlayerKeydown(event: Event): void {
  const ownPanel = panel.value;
  const target = event.target;
  if (!ownPanel || !target || typeof (target as Node).nodeType !== 'number') return;
  const player = props.player?.contains(props.video) ? props.player : null;
  const insidePanel = ownPanel.contains(target as Node);
  if (!player && !insidePanel) return;
  const menu = player ? getYoutubeSubtitleControlsScope(player, props.video).querySelector<HTMLElement>('#fluent-read-video-subtitle-menu') : null;
  if (menu?.contains(target as Node) || (event as KeyboardEvent).key === 'Escape' && menu?.hidden === false) return;
  // 面板打开期间，焦点回到当前播放器也能继续学习；页面其他区域保留站点快捷键。
  const document = props.video.ownerDocument;
  const fullscreenPlayer = document?.fullscreenElement?.contains(props.video);
  const fullscreenPageFocus = fullscreenPlayer && (target === document.body || target === document.documentElement);
  if (!insidePanel && !player?.contains(target as Node) && !fullscreenPageFocus) return;
  onKeydown(event as KeyboardEvent);
}
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (!active || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || target?.closest?.('textarea,input,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
  const document = props.video.ownerDocument;
  if (event.key === 'Escape' && document?.fullscreenElement?.contains(props.video)) {
    if (!event.repeat) void document.exitFullscreen?.().catch(() => undefined);
    return;
  }
  const key = event.key.toLowerCase();
  if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key) && key !== 'r' && key !== 'q') return;
  // window capture 先于站点 document 监听，避免同键同时改速或跳转；长按只消费重复事件。
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat) return;
  if (event.key === 'Escape') emit('close');
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'ArrowRight') step(1);
  else if (key === 'r') toggleMode('loop');
  else toggleMode('pause');
}
// subscribeConfig 会立即发送当前快照；统计计数等无关变更不能取消首句或用户循环。
const learningConfigFingerprint = () => JSON.stringify([config.on, config.videoTranslationEnabled, config.videoSubtitleVisible,
  getVideoTranslationConfigFingerprint(config), config.harness, config.videoSemanticSegmentationEnabled,
  config.videoSemanticSegmentationService, config.videoSemanticSegmentationModel]);
let configRevision = learningConfigFingerprint();
const unsubscribe = subscribeConfig(() => {
  semanticEnabled.value = semanticReady();
  readingEnabled.value = browserCapabilities.extensionDom && config.videoSubtitleAppearance.readingAnnotation === true && config.on && config.videoTranslationEnabled && config.videoSubtitleVisible;
  const nextAppearance = normalizeVideoSentenceLearningAppearance(config.videoSentenceLearningAppearance);
  if (JSON.stringify(nextAppearance) !== JSON.stringify(appearance.value)) appearance.value = nextAppearance;
  const next = learningConfigFingerprint(); if (next === configRevision) return;
  semanticOverrides.value = new Map(); semanticFeedback.value = undefined;
  configRevision = next; const nextTranslationRevision = getVideoTranslationConfigFingerprint(config);
  const translationChanged = translationRevision !== nextTranslationRevision; translationRevision = nextTranslationRevision;
  const wasExplaining = explaining.value; cancelPending(); controller?.stop(); pinned.value = editingTranslation.value || editingExplanation.value;
  if (translationChanged && !translationEdited.value) translation.value = '';
  if (wasExplaining) explanationStopped.value = true;
  scheduleTranslation(); notice.value = t('video.learning.settingsChanged');
});
onBeforeUnmount(() => { active = false; readingGeneration++; readingError.value = false; readingSession.destroy(); cancelPending(); controller?.destroy(); unsubscribe();
  (props.video.ownerDocument?.defaultView ?? props.video.ownerDocument)?.removeEventListener('keydown', onPlayerKeydown, true);
  props.video.removeEventListener('timeupdate', followPlayback); props.video.removeEventListener('seeking', onSeeking); });
</script>
