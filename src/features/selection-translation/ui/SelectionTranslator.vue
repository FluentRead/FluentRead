<!--
 * @file src/features/selection-translation/ui/SelectionTranslator.vue
 * 文件职责：实现划词翻译的主要页面组件，覆盖选区捕获、图标/小点/快捷键/直接弹出、翻译与词卡展示、朗读、收藏词书、重试和关闭。
 * 主要内容：组件管理可信手势、已关闭选区与选择丢失宽限、请求 token、弹窗定位、空白拖动、边角缩放和主题，以纯中文选区过滤统一划词和翻译卡片入口，其他文本保留保守同语言预检，以独立点击、延迟悬停和快捷键复用选区入口打开 Harness 阅读卡，按模型相关配置刷新阅读缓存，协调翻译、词典与 TTS，并把滚轮交互限制在自身 Shadow UI 内。
 * 模块边界：组件只通过公共客户端和 runtime 消息触达后台，不直接持有 provider、IndexedDB 或 Offscreen 资源；纯选区算法在 core，活动 Range 通过回调交给 content/runtime 管理 modal 挂载所有权，词书协议独立维护。
 -->
<template>
  <div v-ui-i18n v-show="showIndicator || showTooltip || noticeMessage || copySuccess" class="fr-selection-translator-root" :data-display-delay="selectionSettings.delay" @pointerdown.stop @wheel.stop.passive="handleUiWheel">
    <div v-if="showIndicator && !showTooltip && readingIndicatorEnabled" ref="reading-indicator-ref" class="fr-reading-indicator" :class="{'fr-dark-theme': isDarkTheme}" :style="readingIndicatorStyle" role="group" aria-label="选区操作" @pointerdown.prevent.stop>
      <button v-if="selectionSettings.mode !== 'disabled'" type="button" aria-label="打开划词翻译" @click="openTooltip()">翻译</button>
      <button v-for="action in readingActions" :key="action.id" type="button" :class="{'is-default': action.id === readingPreferences.defaultAction}" :data-default-action="action.id === readingPreferences.defaultAction ? 'true' : undefined" :aria-label="`${action.label}选中文本`" @pointerenter="scheduleReadingHover($event, action.id)" @pointerleave="cancelReadingHover" @click="openReading(action.id)">{{ action.label }}</button>
      <button v-if="!isPrivateContext" class="fr-reading-history-entry" type="button" aria-label="阅读记录" title="阅读记录" @click="openReadingHistory"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 5.8V10l2.7 1.8" /></svg><span>记录</span></button>
    </div>
    <button v-else-if="showIndicator && !showTooltip" class="fr-selection-indicator" :class="`fr-selection-indicator--${triggerMode}`" :style="indicatorStyle" type="button" aria-label="打开划词翻译" title="打开划词翻译" @pointerdown.prevent.stop @click="openTooltip()">
      <span class="fr-selection-indicator-glyph" aria-hidden="true">↗</span>
    </button>

    <section v-if="showTooltip" ref="tooltip-ref" class="fr-translation-tooltip" :class="{ 'fr-dark-theme': isDarkTheme, 'fr-reading-tooltip': readingMode, 'fr-popup-manipulating': popupManipulating }" :data-placement="popupPlacement" :style="tooltipStyle" role="dialog" :aria-label="readingMode ? '阅读理解' : '划词翻译结果'" @pointerdown.stop="beginPopupGesture" @pointermove="movePopupGesture" @pointerup="stopPopupGesture" @pointercancel="stopPopupGesture" @lostpointercapture="stopPopupGesture">
      <header class="fr-tooltip-header">
        <div class="fr-tooltip-title">
          <img class="fr-tooltip-brand-icon" :src="selectionTranslatorIconUrl" alt="" aria-hidden="true" />
          <span>{{ readingMode ? '阅读理解' : isWordSelection ? '单词学习卡' : '翻译结果' }}</span>
        </div>
        <div class="fr-tooltip-actions">
          <button v-if="readingEnabled && !readingMode" class="fr-mode-btn" type="button" @click="openReading()">{{ readingDefaultActionLabel }}</button>
          <button v-if="readingMode && selectionSettings.mode !== 'disabled'" class="fr-mode-btn" type="button" @click="openTooltip()">翻译</button>
          <button
            v-if="!readingMode && config.vocabularyBookEnabled && isWordSelection && !isPrivateContext"
            class="fr-action-btn fr-vocabulary-btn"
            :class="{ 'fr-saved': isVocabularySaved }"
            type="button"
            :disabled="vocabularyBusy || !vocabularyAnswer"
            :title="vocabularyButtonTitle"
            :aria-label="vocabularyButtonTitle"
            :aria-pressed="isVocabularySaved"
            @click="saveVocabularyEntry"
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.7 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.3l-5.72 3.02 1.09-6.38-4.63-4.51 6.4-.93L12 2.7Z" /></svg></button>
          <button class="fr-close-btn" type="button" title="关闭" aria-label="关闭翻译结果" @click="closeTooltip">×</button>
        </div>
      </header>

      <div v-if="readingSelection" v-show="readingMode" class="fr-tooltip-content fr-reading-content">
        <ReadingPanel :selection="readingSelection" :preferences="readingPreferences" :active="readingMode" :initial-action="readingInitialAction" :history-only="readingHistoryOnly" :source-language="selectionSettings.from" :target-language="selectionSettings.to" :playing-source-text="isPlaying && currentAudioKind === 'source' ? currentAudioText : ''" :model-revision="readingModelRevision" :vocabulary-enabled="config.vocabularyBookEnabled" :private-context="isPrivateContext" :animations="config.animations" @play-source="toggleAudio($event, 'source')" @source-change="stopAudio()" @resize="schedulePositionUpdate" />
      </div>
      <div v-show="!readingMode" class="fr-tooltip-content" aria-live="polite">
        <div v-if="isLoading && !translationResult && !wordCard && !wordCardError" class="fr-loading-state"><span :class="['fr-loading-spinner', { 'fr-static': !config.animations }]" aria-hidden="true" /><span>正在查询…</span></div>
        <div v-else-if="error && !translationResult && !wordCard" class="fr-error-state"><span>{{ error }}</span><button type="button" @click="retryTranslation">重试</button></div>
        <div v-else class="fr-translation-container">
          <section v-if="isWordSelection && (wordCard || isWordCardLoading)" class="fr-word-learning-card" aria-label="单词学习卡">
            <div v-if="isWordCardLoading && !wordCard" class="fr-word-card-loading"><span :class="['fr-loading-spinner', { 'fr-static': !config.animations }]" aria-hidden="true" /><span>正在查词…</span></div>
            <template v-else-if="wordCard">
              <div class="fr-word-heading">
                <div>
                  <h3>{{ selectedText }}</h3>
                  <span class="fr-word-normalized" v-if="selectedText.toLowerCase() !== wordCard.normalizedWord">词典词形：{{ wordCard.word }}</span>
                </div>
                <div class="fr-word-heading-actions">
                  <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('source') }" data-copy-kind="source" type="button" :title="copyButtonTitle('source')" :aria-label="copyButtonTitle('source')" @click="copyText(selectedText, 'source')">
                    <svg v-if="isCopied('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    <span>{{ isCopied('source') ? '已复制' : '复制' }}</span>
                  </button>
                  <button v-if="wordCard.phonetics.length === 0" class="fr-text-audio-btn fr-word-heading-audio" type="button" :aria-label="wordAudioLabel({ text: wordCard.word })" :title="wordAudioLabel({ text: wordCard.word })" @click="toggleWordAudio({ text: wordCard.word })">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                  </button>
                </div>
              </div>
              <div v-if="wordCard.phonetics.length > 0" class="fr-word-pronunciations" aria-label="发音">
                <div v-for="(pronunciation, index) in wordCard.phonetics.slice(0, 4)" :key="`${pronunciation.text || ''}-${pronunciation.audio || ''}-${index}`" class="fr-word-pronunciation">
                  <span class="fr-word-pronunciation-label">{{ pronunciation.label || (index === 0 ? '发音' : '变体') }}</span>
                  <span class="fr-word-ipa">{{ pronunciation.text || '点击播放' }}</span>
                  <button class="fr-text-audio-btn" type="button" :aria-label="wordAudioLabel(pronunciation)" :title="wordAudioLabel(pronunciation)" @click="toggleWordAudio(pronunciation)">
                    <svg v-if="isCurrentWordAudio(pronunciation)" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                  </button>
                </div>
              </div>
              <div v-if="translationResult" class="fr-word-translation">
                <div class="fr-word-translation-header">
                  <span class="fr-text-label">译文</span>
                  <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('translation') }" data-copy-kind="translation" type="button" :title="copyButtonTitle('translation')" :aria-label="copyButtonTitle('translation')" @click="copyText(translationResult, 'translation')">
                    <svg v-if="isCopied('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    <span>{{ isCopied('translation') ? '已复制' : '复制' }}</span>
                  </button>
                </div>
                <pre>{{ translationResult }}</pre>
              </div>
              <div v-else-if="isLoading" class="fr-word-translation-loading">正在翻译释义…</div>
              <div v-if="wordCard.meanings.length > 0" class="fr-word-meaning-toolbar">
                <span>英文释义 · 中文辅助</span>
                <button type="button" @click="showChineseSupport = !showChineseSupport">{{ showChineseSupport ? '隐藏中文辅助' : '显示中文辅助' }}</button>
              </div>
              <div v-if="wordCard.meanings.length > 0" class="fr-word-meanings">
                <div v-for="meaning in wordCard.meanings.slice(0, 4)" :key="meaning.partOfSpeech" class="fr-word-meaning">
                  <strong>{{ meaning.partOfSpeech }}</strong>
                  <ol>
                    <li v-for="definition in meaning.definitions.slice(0, 4)" :key="`${meaning.partOfSpeech}-${definition.definition}`">
                      <span class="fr-word-definition-en">{{ definition.definition }}</span>
                      <span v-if="showChineseSupport && definition.translatedDefinition && definition.translatedDefinition !== definition.definition" class="fr-word-definition-zh">{{ definition.translatedDefinition }}</span>
                      <em v-if="definition.example">
                        <span class="fr-word-example-en">例句：{{ definition.example }}</span>
                        <span v-if="showChineseSupport && definition.translatedExample && definition.translatedExample !== definition.example" class="fr-word-example-zh">译：{{ definition.translatedExample }}</span>
                      </em>
                    </li>
                  </ol>
                </div>
              </div>
              <div v-else class="fr-word-empty">暂未找到详细释义，可查看译文。</div>
              <footer class="fr-word-card-footer">
                <span>数据来自开放词典</span>
                <a v-for="source in wordCard.sources" :key="source.id" :href="source.url" target="_blank" rel="noreferrer">{{ source.label }}</a>
              </footer>
            </template>
          </section>
          <div v-if="isWordSelection && wordCardError" class="fr-word-fallback-note">{{ wordCardError }}，已保留普通翻译。</div>
          <div v-if="selectionSettings.mode === 'bilingual' && !isWordCardVisible" class="fr-text-block fr-original-text">
            <div class="fr-text-block-header">
              <span class="fr-text-label">原文</span>
              <div class="fr-text-actions">
                <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('source') }" data-copy-kind="source" type="button" :title="copyButtonTitle('source')" :aria-label="copyButtonTitle('source')" @click="copyText(selectedText, 'source')">
                  <svg v-if="isCopied('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  <span>{{ isCopied('source') ? '已复制' : '复制' }}</span>
                </button>
                <button class="fr-text-audio-btn" type="button" :aria-label="audioLabel('source')" :title="audioLabel('source')" @click="toggleAudio(selectedText, 'source')">
                  <svg v-if="isCurrentAudio('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                </button>
              </div>
            </div>
            <pre>{{ selectedText }}</pre>
          </div>
          <div v-if="(selectionSettings.mode === 'bilingual' || selectionSettings.mode === 'translation-only') && !isWordCardVisible" class="fr-text-block fr-translation-result">
            <div class="fr-text-block-header">
              <span class="fr-text-label">译文</span>
              <div class="fr-text-actions">
                <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('translation') }" data-copy-kind="translation" type="button" :title="copyButtonTitle('translation')" :aria-label="copyButtonTitle('translation')" @click="copyText(translationResult, 'translation')">
                  <svg v-if="isCopied('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  <span>{{ isCopied('translation') ? '已复制' : '复制' }}</span>
                </button>
                <button class="fr-text-audio-btn" type="button" :aria-label="audioLabel('translation')" :title="audioLabel('translation')" @click="toggleAudio(translationResult, 'translation')">
                  <svg v-if="isCurrentAudio('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                </button>
              </div>
            </div>
            <pre>{{ translationResult }}</pre>
          </div>
          <div v-if="error && (translationResult || wordCard)" class="fr-inline-error"><span>{{ error }}</span><button type="button" @click="retryTranslation">重试</button></div>
          <div v-if="isPlaying" class="fr-playing-status"><span>正在播放{{ currentAudioKind === 'source' ? '原文' : currentAudioKind === 'word' ? '单词' : '译文' }}</span><button type="button" aria-label="停止播放" title="停止播放" @click="stopAudioFromUi">停止</button></div>
        </div>
      </div>
      <template v-if="!readingMode">
        <div v-for="edge in popupResizeEdges" :key="edge" class="fr-popup-resize-handle" :class="`fr-popup-resize-${edge}`" :data-resize-edge="edge" aria-hidden="true" />
      </template>
    </section>

    <div v-if="noticeMessage" class="fr-action-toast" :class="{ 'fr-dark-theme': isDarkTheme }" role="status"><span>{{ noticeMessage }}</span><button v-if="noticeAction === 'open-vocabulary'" type="button" @click="openVocabularyBook">查看</button><button v-else-if="noticeAction === 'open-local-tts'" type="button" @click="openLocalTtsSettings">设置</button></div>
    <div v-else-if="copySuccess" class="fr-copy-success-toast" :class="{ 'fr-dark-theme': isDarkTheme }" role="status">{{ copySuccessMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import browser from 'webextension-polyfill';
import { config, subscribeConfig } from '@/src/services/config/store';
import { translateText } from '@/src/app/translation/client';
import {detectlang, shouldSkipChineseSelection, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import { matchesConfiguredHotkey, matchesModifierOnlyHotkey, resolveConfiguredHotkey } from '@/src/core/hotkey';
import { isSingleEnglishWord, normalizeEnglishWord, type WordCardData, type WordPronunciation } from '@/src/features/selection-translation/services/wordDictionary';
import { calculateReadingPopupLayout, calculateSelectionPopupPosition, chooseSelectionRect, getSelectionPresentationDelayRemaining, readSelectionText, normalizeSpeechLanguage, reconcileSelectionPresentation, resolveSelectionDictionaryFallback, resolveSelectionVocabularyAnswer, SelectionRequestTokenGate, shouldIgnoreSelection, summarizeSelectionContext, type SelectionAnswerCandidate, type SelectionContentRequest, type SelectionRect } from '@/src/features/selection-translation/core';
import {
  createSelectionTtsClientRequestId,
} from '@/src/features/selection-translation/protocol';
import { createSelectionTtsContentController } from '@/src/features/selection-translation/content/selectionTtsContentController';
import { setSelectionContextMenuHandler } from '@/src/features/selection-translation/content/contextMenuBridge';
import { VOCABULARY_BOOK_CHANGED_MESSAGE, VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse } from '@/src/features/vocabulary/protocol';
import {ReadingPanel, captureReadingSelection, type ReadingSelection} from '@/src/features/reading-assistant/public';
import {HARNESS_ACTIONS, getHarnessModelCacheKey, normalizeHarnessPreferences, type HarnessActionId} from '@/src/core/config/harness';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{
  onSelectionRangeChange?: (range: Range | null) => void;
}>();
const {t} = useUiI18n();

type SelectionTrigger = 'direct' | 'icon' | 'dot' | 'shortcut';
type AudioKind = 'source' | 'translation' | 'word';
type CopyKind = 'source' | 'translation';
interface SelectionSnapshot { text: string; range: Range; anchor: SelectionRect; isForward: boolean; }

const tooltipRef = useTemplateRef<HTMLElement>('tooltip-ref');
const readingIndicatorRef = useTemplateRef<HTMLElement>('reading-indicator-ref');
const selectionTranslatorIconUrl = browser.runtime.getURL('/icon/128.png');
const selectedText = ref('');
const activeContentRequest = ref<SelectionContentRequest | null>(null);
const translationAnswer = ref<SelectionAnswerCandidate | null>(null);
const dictionaryAnswer = ref<SelectionAnswerCandidate | null>(null);
const translationResult = ref('');
const isLoading = ref(false);
const error = ref('');
const showIndicator = ref(false);
const showTooltip = ref(false);
const readingMode = ref(false);
const readingInitialAction = ref<HarnessActionId>('meaning');
const readingHistoryOnly = ref(false);
const readingSelection = ref<ReadingSelection | null>(null);
const copySuccess = ref(false);
const copiedTextKind = ref<CopyKind | null>(null);
const isDarkTheme = ref(false);
const indicatorStyle = ref<Record<string, string>>({});
const readingIndicatorStyle = ref<Record<string, string>>({visibility: 'hidden'});
const tooltipStyle = ref<Record<string, string>>({});
const popupPlacement = ref<'top' | 'bottom'>('top');
const snapshot = ref<SelectionSnapshot | null>(null);
const isPlaying = ref(false);
const currentAudioKind = ref<AudioKind | null>(null);
const currentAudioText = ref('');
const currentAudioKey = ref('');
const wordCard = ref<WordCardData | null>(null);
const isWordCardLoading = ref(false);
const wordCardError = ref('');
const showChineseSupport = ref(true);
const noticeMessage = ref('');
const noticeAction = ref<'open-vocabulary' | 'open-local-tts' | null>(null);
const isVocabularySaved = ref(false);
const vocabularyBusy = ref(false);

let readingHoverTimer: number | null = null;
let selectionFrame: number | null = null;
let positionFrame: number | null = null;
let selectionLossTimer: number | null = null;
let selectionPresentationTimer: number | null = null;
let selectionPresentationVersion = 0;
let selectionSettledAt = 0;
let pendingSelectionPresentation: 'indicator' | 'tooltip' | null = null;
let translationAbortController: AbortController | null = null;
let translationRequestId = 0;
let wordLookupRequestId = 0;
let copyTimer: number | null = null;
const vocabularyLookupGate = new SelectionRequestTokenGate();
const vocabularySaveGate = new SelectionRequestTokenGate();
let contentRequestGeneration = 0;
let noticeTimer: number | null = null;
let lastTrustedSelectionInteractionAt = 0;
const TRUSTED_SELECTION_INTERACTION_GRACE_MS = 1_500;
let audio: HTMLAudioElement | null = null;
let audioUrl = '';
let utterance: SpeechSynthesisUtterance | null = null;
const ttsContentController = createSelectionTtsContentController({
  createClientRequestId: createSelectionTtsClientRequestId,
  stopRemote: (clientRequestId) => browser.runtime.sendMessage({
    type: 'selectionTtsStop',
    clientRequestId,
  }),
});
let isSelecting = false;
let dismissedSelection: SelectionSnapshot | null = null;
let pendingSelectionShortcutUntil = 0;
let selectionShortcutHeld = false;
let uiPointerInteraction = false;
let suppressSelectionUntil = 0;
let systemThemeMedia: MediaQueryList | null = null;
let unsubscribeConfig: (() => void) | null = null;
let releaseContextMenuHandler: (() => void) | null = null;
let tooltipResizeObserver: ResizeObserver | null = null;
const selectionConfigVersion = ref(0);
const readingPreferences = computed(() => {
  selectionConfigVersion.value;
  return normalizeHarnessPreferences(config.harness, config.customOpenAIProviders);
});
// 配置通知也包含外观等无关变更，只有模型输入变化才使阅读结果失效。
const readingModelRevision = ref(0);
watch(() => {
  selectionConfigVersion.value;
  return getHarnessModelCacheKey(config);
}, () => { readingModelRevision.value += 1; });
const readingEnabled = computed(() => readingPreferences.value.enabled);
const readingIndicatorEnabled = computed(() => readingEnabled.value && readingPreferences.value.trigger !== 'shortcut');
const readingActions = computed(() => HARNESS_ACTIONS.filter(action => readingPreferences.value.actions.includes(action.id)));
const readingDefaultActionLabel = computed(() => HARNESS_ACTIONS.find(action => action.id === readingPreferences.value.defaultAction)!.label);

watch(() => snapshot.value?.range ?? null, (range) => {
  props.onSelectionRangeChange?.(range);
}, { flush: 'post' });

const selectionShortcutTriggers = new Set(['Control', 'Alt', 'Shift', 'custom']);
const selectionSettings = computed(() => {
  // `config` 与内容脚本运行时共享，且会在 Vue 外部变更；用本地响应式版本让 Popup/Options
  // 的配置变化立即刷新当前选词界面，无需重新加载页面。
  selectionConfigVersion.value;
  return {
    trigger: config.selectionTranslatorTrigger,
    customHotkey: config.customSelectionTranslatorHotkey,
    delay: config.selectionTranslatorDelay,
    mode: config.selectionTranslatorMode,
    theme: config.theme,
    from: config.from,
    to: config.to,
    service: config.service,
    model: `${config.model?.[config.service] || ''}:${config.customModel?.[config.service] || ''}`,
  };
});
const selectionShortcutConfig = computed(() => selectionShortcutTriggers.has(selectionSettings.value.trigger)
  && selectionSettings.value.mode !== 'disabled'
  ? selectionSettings.value.trigger
  : 'none');
const selectionShortcut = computed(() => {
  const resolved = resolveConfiguredHotkey(selectionShortcutConfig.value, selectionSettings.value.customHotkey);
  return resolved === 'none' ? '' : resolved;
});
const triggerMode = computed<SelectionTrigger>(() => {
  if (selectionSettings.value.mode === 'disabled' && readingEnabled.value) return 'icon';
  if (selectionShortcut.value) return 'shortcut';
  if (selectionSettings.value.trigger === 'direct' || selectionSettings.value.trigger === 'dot') return selectionSettings.value.trigger;
  return 'icon';
});
const UI_SELECTION_SUPPRESSION_MS = 350;
const SELECTION_LOSS_GRACE_MS = 160;
const PENDING_SELECTION_SHORTCUT_MS = 250;

const selectedWord = computed(() => normalizeEnglishWord(selectedText.value));
const isWordSelection = computed(() => Boolean(selectedWord.value) && (selectionSettings.value.from === 'auto' || /^en(?:-|$)/i.test(selectionSettings.value.from)));
const isWordCardVisible = computed(() => isWordSelection.value && wordCard.value !== null);
const isPrivateContext = browser.extension.inIncognitoContext === true;
const currentContentRequest = computed<SelectionContentRequest | null>(() => {
  const request = activeContentRequest.value;
  if (!request || snapshot.value?.text !== request.text || selectedText.value !== request.text || config.to !== request.targetLanguage) return null;
  return request;
});
const vocabularyAnswer = computed(() => resolveSelectionVocabularyAnswer(currentContentRequest.value, translationAnswer.value, dictionaryAnswer.value));
const vocabularyButtonTitle = computed(() => {
  if (vocabularyBusy.value) return '正在保存到单词本';
  if (!vocabularyAnswer.value) return '译文准备完成后可收藏';
  if (isVocabularySaved.value) return '已收藏；再次点击更新当前阅读上下文';
  return '收藏到单词本';
});
const copySuccessMessage = computed(() => copiedTextKind.value === 'source' ? '已复制原文' : '已复制译文');

function updateTheme(): void {
  isDarkTheme.value = config.theme === 'dark' || (config.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function toSelectionRect(rect: DOMRect | DOMRectReadOnly): SelectionRect {
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
}

function isExtensionSelection(selection: Selection): boolean {
  const host = document.getElementById('fluent-read-selection-translator-container');
  return Boolean(host && selection.containsNode(host, true));
}

function readSelectionSnapshot(): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || isExtensionSelection(selection)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const text = readSelectionText(range, selection.toString());
  if (!text || text.length > 4096) return null;

  if (shouldIgnoreSelection(range)) return null;
  const rects = Array.from(range.getClientRects()).map(toSelectionRect).filter(rect => rect.width > 0 || rect.height > 0);
  const visualRects = rects.length > 0 ? rects : [toSelectionRect(range.getBoundingClientRect())];
  const isForward = selection.anchorNode === range.startContainer && selection.anchorOffset === range.startOffset;
  const anchor = chooseSelectionRect(visualRects, isForward);
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) return null;
  return { text, range, anchor, isForward };
}

function scheduleSelectionRead(shortcutTriggered = false): void {
  if (shortcutTriggered) pendingSelectionShortcutUntil = performance.now() + PENDING_SELECTION_SHORTCUT_MS;
  if (isSelecting || isSelectionReadSuppressed()) return;
  if (selectionFrame !== null) return;
  selectionFrame = window.requestAnimationFrame(() => {
    selectionFrame = null;
    const shouldTriggerShortcut = pendingSelectionShortcutUntil >= performance.now();
    pendingSelectionShortcutUntil = 0;
    if (!isSelecting && !isSelectionReadSuppressed()) applySelection(readSelectionSnapshot(), shouldTriggerShortcut);
  });
}

function suppressSelectionRead(duration = UI_SELECTION_SUPPRESSION_MS): void {
  suppressSelectionUntil = Math.max(suppressSelectionUntil, performance.now() + duration);
  if (selectionFrame !== null) {
    window.cancelAnimationFrame(selectionFrame);
    selectionFrame = null;
  }
}

function isSelectionReadSuppressed(): boolean {
  return uiPointerInteraction || performance.now() < suppressSelectionUntil;
}

function isSelectionInTargetLanguage(text: string): boolean {
  return shouldSkipChineseSelection(text, config.to) || shouldSkipTranslationForTarget(text, config.to);
}

function isSameSelection(left: SelectionSnapshot | null, right: SelectionSnapshot): boolean {
  if (!left || left.text !== right.text) return false;
  return left.range.startContainer === right.range.startContainer
    && left.range.startOffset === right.range.startOffset
    && left.range.endContainer === right.range.endContainer
    && left.range.endOffset === right.range.endOffset;
}

function cancelSelectionLoss(): void {
  if (selectionLossTimer === null) return;
  window.clearTimeout(selectionLossTimer);
  selectionLossTimer = null;
}

function cancelSelectionPresentation(): void {
  cancelReadingHover();
  if (selectionPresentationTimer !== null) {
    window.clearTimeout(selectionPresentationTimer);
    selectionPresentationTimer = null;
  }
  pendingSelectionPresentation = null;
  selectionPresentationVersion += 1;
}

function clearCopyFeedback(): void {
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  copyTimer = null;
  copySuccess.value = false;
  copiedTextKind.value = null;
}

function resetSelectionContentState(clearSelectionText = false): void {
  translationRequestId += 1;
  translationAbortController?.abort();
  translationAbortController = null;
  wordLookupRequestId += 1;
  isLoading.value = false;
  activeContentRequest.value = null;
  translationAnswer.value = null;
  dictionaryAnswer.value = null;
  translationResult.value = '';
  error.value = '';
  wordCard.value = null;
  isWordCardLoading.value = false;
  wordCardError.value = '';
  showChineseSupport.value = true;
  clearCopyFeedback();
  vocabularyLookupGate.invalidate();
  vocabularySaveGate.invalidate();
  isVocabularySaved.value = false;
  vocabularyBusy.value = false;
  if (clearSelectionText) selectedText.value = '';
  stopAudio();
}

function revealSelectionPresentation(
  presentation: 'indicator' | 'tooltip',
  expectedVersion: number,
): void {
  if (expectedVersion !== selectionPresentationVersion
    || pendingSelectionPresentation !== presentation
    || !snapshot.value) return;

  const expectedSelection = snapshot.value;
  const currentSelection = readSelectionSnapshot();
  if (!currentSelection) { hideAll(); return; }
  if (!isSameSelection(expectedSelection, currentSelection)) {
    applySelection(currentSelection);
    return;
  }

  snapshot.value = currentSelection;
  pendingSelectionPresentation = null;
  if (presentation === 'tooltip') {
    openTooltip();
    return;
  }
  showIndicator.value = true;
  showTooltip.value = false;
  updatePosition(false);
}

function scheduleSelectionPresentation(presentation: 'indicator' | 'tooltip'): void {
  if (!snapshot.value) return;
  if (selectionPresentationTimer !== null) {
    window.clearTimeout(selectionPresentationTimer);
    selectionPresentationTimer = null;
  }
  pendingSelectionPresentation = presentation;
  const expectedVersion = ++selectionPresentationVersion;
  const remaining = getSelectionPresentationDelayRemaining(
    selectionSettings.value.delay,
    selectionSettledAt,
    performance.now(),
  );
  if (remaining === 0) {
    revealSelectionPresentation(presentation, expectedVersion);
    return;
  }
  selectionPresentationTimer = window.setTimeout(() => {
    selectionPresentationTimer = null;
    revealSelectionPresentation(presentation, expectedVersion);
  }, remaining);
}

function scheduleSelectionLoss(): void {
  if (!snapshot.value) return;
  if (selectionLossTimer !== null) return;
  selectionLossTimer = window.setTimeout(() => {
    selectionLossTimer = null;
    if (isSelecting || isSelectionReadSuppressed()) return;
    const recoveredSelection = readSelectionSnapshot();
    if (recoveredSelection) {
      applySelection(recoveredSelection);
      return;
    }
    hideAll();
  }, SELECTION_LOSS_GRACE_MS);
}

function applySelection(next: SelectionSnapshot | null, shortcutTriggered = false, readingTriggered = false, forced = false): void {
  if (!next) {
    if (!isSelecting) scheduleSelectionLoss();
    return;
  }
  if (!shortcutTriggered && isSameSelection(dismissedSelection, next)) return;
  dismissedSelection = null;
  cancelSelectionLoss();
  // 右键菜单是用户明确下达的指令：即使选区已是目标语言也照常出卡片，不静默丢弃。
  if (!forced && shouldSkipChineseSelection(next.text, config.to)) { hideAll(); return; }
  if (isSameSelection(snapshot.value, next)) {
    if (readingTriggered) openReading();
    else if (forced) openTooltip(true);
    else if (shortcutTriggered) scheduleSelectionPresentation('tooltip');
    return;
  }
  if (!forced && !readingEnabled.value && isSelectionInTargetLanguage(next.text)) { hideAll(); return; }
  cancelSelectionPresentation();
  selectionSettledAt = performance.now();
  resetSelectionContentState();
  readingMode.value = false;
  readingSelection.value = null;
  readingIndicatorStyle.value = {visibility: 'hidden'};
  resetPopupGeometry();
  snapshot.value = next;
  selectedText.value = next.text;
  const waitingForShortcut = !shortcutTriggered && !readingIndicatorEnabled.value
    && (triggerMode.value === 'shortcut' || selectionSettings.value.mode === 'disabled');
  showIndicator.value = false;
  showTooltip.value = false;
  updatePosition(false);
  if (readingTriggered) { openReading(); return; }
  if (forced) { openTooltip(true); return; }
  if (waitingForShortcut) return;
  scheduleSelectionPresentation(shortcutTriggered || triggerMode.value === 'direct' ? 'tooltip' : 'indicator');
}

// 指针只在本卡片内捕获；页面原有文本、按钮和滚动条不参与拖动。
const popupResizeEdges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const popupManipulating = ref(false);
let manualPopupPosition: {left: number; top: number} | null = null;
let manualPopupSize: {width: number; height: number} | null = null;
let popupGesture: {pointerId: number; x: number; y: number; rect: DOMRect; edge: string; element: HTMLElement} | null = null;

function stopPopupGesture(event?: PointerEvent): void {
  const gesture = popupGesture;
  if (event && gesture && event.pointerId !== gesture.pointerId) return;
  popupGesture = null;
  popupManipulating.value = false;
  if (gesture?.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);
}

function resetPopupGeometry(): void {
  stopPopupGesture();
  manualPopupPosition = null;
  manualPopupSize = null;
}

function applyManualPopupGeometry(): void {
  const element = tooltipRef.value;
  if (!element || !manualPopupPosition) return;
  const widthLimit = Math.max(1, window.innerWidth - 24);
  const heightLimit = Math.max(1, window.innerHeight - 24);
  const width = Math.min(manualPopupSize?.width ?? element.getBoundingClientRect().width, widthLimit);
  const height = Math.min(manualPopupSize?.height ?? element.getBoundingClientRect().height, heightLimit);
  const left = Math.max(12, Math.min(manualPopupPosition.left, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(manualPopupPosition.top, window.innerHeight - height - 12));
  manualPopupPosition = {left, top};
  if (manualPopupSize) manualPopupSize = {width, height};
  tooltipStyle.value = {
    left: `${left}px`, top: `${top}px`, visibility: 'visible',
    maxWidth: `${widthLimit}px`, maxHeight: `${manualPopupSize ? heightLimit : Math.min(520, heightLimit)}px`,
    ...(manualPopupSize ? {width: `${width}px`, height: `${height}px`} : {}),
  };
}

function beginPopupGesture(event: PointerEvent): void {
  const element = tooltipRef.value;
  const target = event.target;
  if (!event.isTrusted || !event.isPrimary || event.button !== 0 || readingMode.value || !element || !(target instanceof HTMLElement)) return;
  if (target.closest('button, a, input, textarea, select, [contenteditable]')) return;
  const edge = target.dataset.resizeEdge ?? '';
  const blank = target.matches('.fr-translation-tooltip, .fr-tooltip-content, .fr-translation-container, .fr-text-block');
  if (!edge && !target.closest('.fr-tooltip-header') && !blank) return;
  // 不截获内容滚动条上的按下。
  if (!edge && blank && event.clientX >= target.getBoundingClientRect().left + target.clientLeft + target.clientWidth) return;
  event.preventDefault();
  stopPopupGesture();
  const rect = element.getBoundingClientRect();
  popupGesture = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, edge, element};
  element.setPointerCapture(event.pointerId);
  popupManipulating.value = true;
}

function movePopupGesture(event: PointerEvent): void {
  const gesture = popupGesture;
  if (!event.isTrusted || !gesture || event.pointerId !== gesture.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  const {rect, edge} = gesture;
  if (!edge) {
    manualPopupPosition = {left: rect.left + dx, top: rect.top + dy};
  } else {
    const minWidth = Math.min(280, window.innerWidth - 24);
    const minHeight = Math.min(140, window.innerHeight - 24);
    let {left, top, right, bottom} = rect;
    if (edge.includes('w')) left = Math.max(12, Math.min(rect.left + dx, right - minWidth));
    if (edge.includes('e')) right = Math.min(window.innerWidth - 12, Math.max(rect.right + dx, left + minWidth));
    if (edge.includes('n')) top = Math.max(12, Math.min(rect.top + dy, bottom - minHeight));
    if (edge.includes('s')) bottom = Math.min(window.innerHeight - 12, Math.max(rect.bottom + dy, top + minHeight));
    manualPopupPosition = {left, top};
    manualPopupSize = {width: right - left, height: bottom - top};
  }
  applyManualPopupGeometry();
}

watch(readingMode, resetPopupGeometry);

function updatePosition(refreshSelection = true): void {
  const current = snapshot.value;
  if (!current) return;
  const rects = refreshSelection
    ? Array.from(current.range.getClientRects()).map(toSelectionRect).filter(rect => rect.width > 0 || rect.height > 0)
    : [];
  const anchor = refreshSelection
    ? chooseSelectionRect(rects.length > 0 ? rects : [current.anchor], current.isForward)
    : current.anchor;
  if (!anchor) return;
  current.anchor = anchor;
  indicatorStyle.value = { left: `${anchor.right}px`, top: `${anchor.bottom}px` };
  if (showIndicator.value && !showTooltip.value && readingEnabled.value) void nextTick(() => {
    const indicator = readingIndicatorRef.value;
    if (!indicator || !snapshot.value) return;
    const rect = indicator.getBoundingClientRect();
    const position = calculateSelectionPopupPosition(snapshot.value.anchor, {width: rect.width, height: rect.height}, {width: window.innerWidth, height: window.innerHeight});
    readingIndicatorStyle.value = {left: `${position.left}px`, top: `${position.top}px`, visibility: 'visible'};
  });
  if (showTooltip.value) void nextTick(() => {
    const tooltip = tooltipRef.value;
    if (!tooltip || !snapshot.value) return;
    if (!readingMode.value && manualPopupPosition) { applyManualPopupGeometry(); return; }
    if (readingMode.value) {
      const layout = calculateReadingPopupLayout(snapshot.value.anchor, {width: window.innerWidth, height: window.innerHeight});
      tooltipStyle.value = {left: `${layout.left}px`, top: `${layout.top}px`, width: `${layout.width}px`, height: `${layout.height}px`, visibility: 'visible'};
      popupPlacement.value = layout.placement;
      return;
    }
    const rect = tooltip.getBoundingClientRect();
    const position = calculateSelectionPopupPosition(snapshot.value.anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight });
    tooltipStyle.value = { left: `${position.left}px`, top: `${position.top}px`, visibility: 'visible' };
    popupPlacement.value = position.placement;
  });
}

function schedulePositionUpdate(): void {
  if (!showIndicator.value && !showTooltip.value) return;
  if (positionFrame !== null) return;
  positionFrame = window.requestAnimationFrame(() => { positionFrame = null; updatePosition(); });
}

function openTooltip(forced = false): void {
  if (selectionSettings.value.mode === 'disabled' && readingEnabled.value) { openReading(); return; }
  if (!snapshot.value || (!forced && isSelectionInTargetLanguage(snapshot.value.text))) { hideAll(); return; }
  cancelSelectionPresentation();
  const wasVisible = showTooltip.value;
  showIndicator.value = true;
  showTooltip.value = true;
  readingMode.value = false;
  tooltipStyle.value = {left: tooltipStyle.value.left, top: tooltipStyle.value.top, visibility: wasVisible ? 'visible' : 'hidden'};
  if (!wasVisible || error.value || !activeContentRequest.value) void requestSelectionContent(snapshot.value.text);
  schedulePositionUpdate();
}

function cancelReadingHover(): void {
  if (readingHoverTimer !== null) window.clearTimeout(readingHoverTimer);
  readingHoverTimer = null;
}

function scheduleReadingHover(event: PointerEvent, action: HarnessActionId): void {
  cancelReadingHover();
  if (!event.isTrusted || event.pointerType !== 'mouse' || readingPreferences.value.trigger !== 'hover' || !snapshot.value) return;
  const expected = snapshot.value;
  readingHoverTimer = window.setTimeout(() => {
    readingHoverTimer = null;
    const current = readSelectionSnapshot();
    if (!readingEnabled.value || readingPreferences.value.trigger !== 'hover' || !showIndicator.value || showTooltip.value
      || !current || !isSameSelection(expected, current) || !isSameSelection(snapshot.value, current)) return;
    openReading(action);
  }, readingPreferences.value.hoverDelay);
}

function openReading(action: HarnessActionId = readingPreferences.value.defaultAction): void {
  if (!readingPreferences.value.actions.includes(action)) return;
  readingHistoryOnly.value = false;
  readingInitialAction.value = action;
  openReadingCard();
}

function openReadingHistory(): void {
  readingHistoryOnly.value = true;
  openReadingCard();
}

function openReadingCard(): void {
  if (!snapshot.value || !readingEnabled.value) return;
  if (shouldSkipChineseSelection(snapshot.value.text, config.to)) { hideAll(); return; }
  cancelSelectionPresentation();
  cancelSelectionLoss();
  translationAbortController?.abort();
  stopAudio();
  if (!readingSelection.value) {
    readingSelection.value = captureReadingSelection(snapshot.value.range, snapshot.value.text,
      readingPreferences.value.contextMode === 'paragraph' ? readingPreferences.value.maxContextChars : 0);
  }
  const wasVisible = showTooltip.value;
  readingMode.value = true;
  showIndicator.value = true;
  showTooltip.value = true;
  if (!wasVisible) tooltipStyle.value = {visibility: 'hidden'};
  schedulePositionUpdate();
}

function shouldUseWordCard(text: string): boolean {
  return isSingleEnglishWord(text) && (config.from === 'auto' || /^en(?:-|$)/i.test(config.from));
}

function beginSelectionContentRequest(text: string): SelectionContentRequest {
  resetSelectionContentState();
  const request = { text, targetLanguage: config.to, generation: ++contentRequestGeneration };
  activeContentRequest.value = request;
  return request;
}

function isContentRequestCurrent(request: SelectionContentRequest): boolean {
  const current = currentContentRequest.value;
  return Boolean(current && current.generation === request.generation && current.text === request.text && current.targetLanguage === request.targetLanguage);
}

function dictionaryDefinitions(card: WordCardData, targetLanguage: string): string {
  return resolveSelectionDictionaryFallback(targetLanguage, card.meanings.flatMap(meaning => meaning.definitions).map(definition => definition.translatedDefinition));
}

function requestSelectionContent(text: string): void {
  const request = beginSelectionContentRequest(text);
  void requestTranslation(request);
  if (shouldUseWordCard(text)) {
    void requestWordCard(request);
    void refreshVocabularySaved(request);
  }
  else {
    wordLookupRequestId += 1;
    wordCard.value = null;
    isWordCardLoading.value = false;
    wordCardError.value = '';
    dictionaryAnswer.value = null;
    isVocabularySaved.value = false;
    vocabularyBusy.value = false;
  }
}

async function refreshVocabularySaved(request: SelectionContentRequest): Promise<void> {
  const word = normalizeEnglishWord(request.text);
  if (!word || !config.vocabularyBookEnabled || isPrivateContext) {
    vocabularyLookupGate.invalidate();
    isVocabularySaved.value = false;
    return;
  }
  const requestToken = vocabularyLookupGate.begin();
  try {
    const response = await browser.runtime.sendMessage({type: VOCABULARY_BOOK_MESSAGE, action: 'getByTerm', term: word, sourceLanguage: 'en'}) as VocabularyBookResponse<unknown | null>;
    if (!vocabularyLookupGate.isCurrent(requestToken) || !isContentRequestCurrent(request)) return;
    isVocabularySaved.value = response?.success === true && Boolean(response.data);
  } catch {
    if (vocabularyLookupGate.isCurrent(requestToken)) isVocabularySaved.value = false;
  }
}

function selectionContextText(): string {
  const range = snapshot.value?.range;
  if (!range) return '';
  const boundary = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const prose = boundary?.closest('p, li, blockquote, dd, dt, figcaption, article') || boundary?.parentElement;
  let selectedIndex: number | undefined;
  if (prose?.contains(range.startContainer)) {
    try {
      const prefix = document.createRange();
      prefix.selectNodeContents(prose);
      prefix.setEnd(range.startContainer, range.startOffset);
      selectedIndex = prefix.toString().replace(/\s+/gu, ' ').trimStart().length;
    } catch { selectedIndex = undefined; }
  }
  return summarizeSelectionContext(prose?.textContent || '', selectedText.value, 500, selectedIndex);
}

function pageSourceUrl(): string {
  try {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

async function saveVocabularyEntry(event: MouseEvent): Promise<void> {
  if (!event.isTrusted) return;
  const contentRequest = currentContentRequest.value;
  const answer = vocabularyAnswer.value;
  if (!contentRequest || !selectedWord.value || !answer || vocabularyBusy.value || isPrivateContext) return;
  const wasSaved = isVocabularySaved.value;
  vocabularyBusy.value = true;
  const requestToken = vocabularySaveGate.begin();
  try {
    const response = await browser.runtime.sendMessage({
      type: VOCABULARY_BOOK_MESSAGE,
      action: 'upsert',
      input: {
        term: contentRequest.text,
        sourceLanguage: 'en',
        targetLanguage: contentRequest.targetLanguage,
        translation: answer,
        phonetic: wordCard.value?.phonetics.find(item => item.text)?.text || '',
        partOfSpeech: wordCard.value?.meanings.map(meaning => meaning.partOfSpeech) || [],
        context: {text: selectionContextText(), sourceUrl: pageSourceUrl(), pageTitle: document.title, capturedAt: Date.now()},
      },
    }) as VocabularyBookResponse<unknown>;
    if (!vocabularySaveGate.isCurrent(requestToken) || !isContentRequestCurrent(contentRequest)) return;
    if (!response?.success || !response.data) throw new Error(response?.success ? '保存失败' : response?.error?.message || '保存失败');
    isVocabularySaved.value = true;
    showNotice(wasSaved ? '已更新当前阅读上下文' : '已加入单词本', 'open-vocabulary');
  } catch (cause) {
    if (vocabularySaveGate.isCurrent(requestToken)) showNotice(cause instanceof Error ? `保存失败：${cause.message}` : '保存失败，未写入单词本');
  } finally {
    if (vocabularySaveGate.isCurrent(requestToken)) vocabularyBusy.value = false;
  }
}

function showNotice(message: string, action: 'open-vocabulary' | 'open-local-tts' | null = null): void {
  noticeMessage.value = message;
  noticeAction.value = action;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { noticeMessage.value = ''; noticeAction.value = null; }, 2600);
}

function openVocabularyBook(): void {
  void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-vocabulary'});
  noticeMessage.value = '';
  noticeAction.value = null;
}

function openLocalTtsSettings(): void {
  void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-translation'});
  noticeMessage.value = '';
  noticeAction.value = null;
}

async function requestTranslation(request: SelectionContentRequest): Promise<void> {
  const text = request.text;
  translationAbortController?.abort();
  const controller = new AbortController();
  translationAbortController = controller;
  const requestId = ++translationRequestId;
  isLoading.value = true;
  error.value = '';
  try {
    const result = await translateText(text, document.title, { signal: controller.signal, targetLanguage: request.targetLanguage });
    if (requestId !== translationRequestId || !isContentRequestCurrent(request)) return;
    translationResult.value = result;
    translationAnswer.value = {...request, answer: result};
  } catch (cause) {
    if (requestId !== translationRequestId || !isContentRequestCurrent(request)) return;
    if (cause instanceof Error && cause.name === 'AbortError') return;
    console.error('Selection translation error:', cause);
    error.value = '翻译失败，请重试';
  } finally {
    if (translationAbortController === controller) translationAbortController = null;
    if (requestId === translationRequestId) isLoading.value = false;
  }
}

function retryTranslation(): void {
  if (!snapshot.value) return;
  requestSelectionContent(snapshot.value.text);
}

async function requestWordCard(request: SelectionContentRequest): Promise<void> {
  const text = request.text;
  const word = normalizeEnglishWord(text);
  if (!word) return;
  const requestId = ++wordLookupRequestId;
  isWordCardLoading.value = true;
  wordCardError.value = '';
  try {
    const response = await browser.runtime.sendMessage({ type: 'selectionWordLookup', word, targetLanguage: request.targetLanguage }) as {
      success?: boolean;
      data?: WordCardData | null;
    };
    if (requestId !== wordLookupRequestId || !isContentRequestCurrent(request)) return;
    if (!response?.success || !response.data) {
      wordCard.value = null;
      dictionaryAnswer.value = null;
      wordCardError.value = '暂未找到这个单词的词典条目';
    } else {
      wordCard.value = response.data;
      dictionaryAnswer.value = {...request, answer: dictionaryDefinitions(response.data, request.targetLanguage)};
    }
  } catch (cause) {
    if (requestId !== wordLookupRequestId || !isContentRequestCurrent(request)) return;
    console.warn('Selection word lookup unavailable:', cause);
    wordCard.value = null;
    dictionaryAnswer.value = null;
    wordCardError.value = '词典服务暂时不可用';
  } finally {
    if (requestId === wordLookupRequestId) isWordCardLoading.value = false;
  }
}

function isCopied(kind: CopyKind): boolean {
  return copiedTextKind.value === kind;
}

function copyButtonTitle(kind: CopyKind): string {
  const label = kind === 'source' ? '原文' : '译文';
  return isCopied(kind) ? `已复制${label}` : `复制${label}`;
}

async function copyText(text: string, kind: CopyKind): Promise<void> {
  const value = text.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedTextKind.value = kind;
    copySuccess.value = true;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copySuccess.value = false;
      copiedTextKind.value = null;
      copyTimer = null;
    }, 1500);
  } catch (cause) { console.error('Copy selection text failed:', cause); }
}

function sourceLanguage(text: string): string { return normalizeSpeechLanguage(config.from === 'auto' ? detectlang(text) : config.from, 'en-US'); }
function translationLanguage(): string { return normalizeSpeechLanguage(config.to, 'zh-CN'); }
function speechLanguage(text: string, kind: AudioKind): string { return kind === 'translation' ? translationLanguage() : sourceLanguage(text); }

function selectVoice(language: string): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in window)) return undefined;
  const voices = window.speechSynthesis.getVoices();
  const normalized = language.toLowerCase();
  const exact = voices.filter(voice => voice.lang.toLowerCase() === normalized);
  const preferredNames = normalized.startsWith('en-')
    ? ['ava', 'aria', 'jenny', 'samantha', 'google us english', 'zira']
    : normalized.startsWith('zh-')
      ? ['xiaoxiao', 'ting-ting', 'tingting', 'huihui']
      : [];
  const preferred = exact.find(voice => preferredNames.some(name => voice.name.toLowerCase().includes(name)));
  if (preferred) return preferred;
  if (exact.length > 0) return exact[0];
  const base = language.split('-')[0]?.toLowerCase();
  return voices.find(voice => voice.lang.toLowerCase().startsWith(`${base}-`) || voice.lang.toLowerCase() === base);
}

function isCurrentAudio(kind: AudioKind, key = currentAudioText.value): boolean {
  return isPlaying.value && currentAudioKind.value === kind && currentAudioKey.value === key;
}
function audioLabel(kind: AudioKind): string {
  const label = kind === 'source' ? '原文' : kind === 'translation' ? '译文' : '单词';
  return isCurrentAudio(kind) ? `停止播放${label}` : `播放${label}`;
}
function wordAudioKey(pronunciation: WordPronunciation): string {
  return pronunciation.audio || pronunciation.text || wordCard.value?.word || selectedText.value;
}
function wordAudioLabel(pronunciation: WordPronunciation): string {
  const label = pronunciation.label || '单词发音';
  return isCurrentWordAudio(pronunciation) ? `停止播放${label}` : `播放${label}`;
}
function isCurrentWordAudio(pronunciation: WordPronunciation): boolean {
  return isCurrentAudio('word', wordAudioKey(pronunciation));
}

function releasePageAudio(): void {
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio = null; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = '';
}

function stopAudio(notifyRemote = true): void {
  ttsContentController.stop(notifyRemote);
  releasePageAudio();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  utterance = null;
  isPlaying.value = false;
  currentAudioKind.value = null;
  currentAudioText.value = '';
  currentAudioKey.value = '';
}

function stopAudioFromUi(): void { stopAudio(); }

function base64ToBlobUrl(audioBase64: string, contentType: string): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

interface EdgeSpeechResult {
  handled: boolean;
  errorCode?: string;
}

async function playEdgeSpeech(text: string, language: string, kind: AudioKind, requestId: number): Promise<EdgeSpeechResult> {
  // 后台可能把播放权交给 Offscreen，也可能返回音频字节供当前页面播放；每一步都用代次校验
  // 丢弃旧请求，仅由当前代次在远端播放失败后继续降级到浏览器语音。
  const remoteRequest = ttsContentController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({
      type: 'selectionTts',
      text,
      language,
      clientRequestId: remoteRequest.clientRequestId,
    }) as {
      success?: boolean;
      audioBase64?: string;
      contentType?: string;
      transport?: 'offscreen' | 'page';
      errorCode?: unknown;
    };
    const remoteResult = ttsContentController.completeRemoteRequest(remoteRequest, response);
    if (remoteResult === 'stale') return {handled: true};
    if (remoteResult === 'failed') return {
      handled: false,
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
    };
    if (remoteResult === 'offscreen') {
      currentAudioKind.value = kind;
      currentAudioText.value = text;
      isPlaying.value = true;
      return {handled: true};
    }
    if (!response.audioBase64) return {
      handled: false,
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
    };
    const nextAudioUrl = base64ToBlobUrl(response.audioBase64, response.contentType || 'audio/mpeg');
    const nextAudio = new Audio(nextAudioUrl);
    nextAudio.preload = 'auto';
    nextAudio.onended = () => { if (audio === nextAudio) { releasePageAudio(); stopAudio(); } };
    nextAudio.onerror = () => {
      if (audio !== nextAudio) return;
      releasePageAudio();
      isPlaying.value = false;
      currentAudioKind.value = null;
      currentAudioText.value = '';
    };
    audio = nextAudio;
    audioUrl = nextAudioUrl;
    currentAudioKind.value = kind;
    currentAudioText.value = text;
    currentAudioKey.value = text;
    isPlaying.value = true;
    try {
      await nextAudio.play();
      return {handled: true};
    } catch (cause) {
      if (audio === nextAudio) releasePageAudio();
      if (ttsContentController.isCurrentGeneration(requestId)) {
        isPlaying.value = false;
        currentAudioKind.value = null;
        currentAudioText.value = '';
      }
      if (ttsContentController.isCurrentGeneration(requestId)) console.warn('Page audio unavailable, trying browser speech:', cause);
      return {handled: false};
    }
  } catch (cause) {
    const isCurrent = ttsContentController.rejectRemoteRequest(remoteRequest);
    if (isCurrent) console.warn('Edge TTS unavailable, trying browser speech:', cause);
    return {handled: !isCurrent};
  }
}

function playBrowserSpeech(text: string, language: string, kind: AudioKind): boolean {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
  try {
    const nextUtterance = new SpeechSynthesisUtterance(text);
    nextUtterance.lang = language;
    nextUtterance.voice = selectVoice(language) ?? null;
    nextUtterance.onend = () => { if (utterance === nextUtterance) stopAudio(); };
    nextUtterance.onerror = event => { if (utterance === nextUtterance && event.error !== 'canceled' && event.error !== 'interrupted') stopAudio(); };
    utterance = nextUtterance;
    currentAudioKind.value = kind;
    currentAudioText.value = text;
    currentAudioKey.value = text;
    isPlaying.value = true;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(nextUtterance);
    return true;
  } catch (cause) { console.warn('Browser speech synthesis unavailable:', cause); return false; }
}

async function playGoogleFallback(text: string, language: string, kind: AudioKind): Promise<void> {
  // 优先让 Offscreen 持有播放；只有仍属当前代次的请求才能退回页面音频 URL，避免停止后又响起。
  const requestId = ttsContentController.currentGeneration();
  const remoteRequest = ttsContentController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({
      type: 'selectionTtsGoogle',
      text,
      language,
      clientRequestId: remoteRequest.clientRequestId,
    }) as {
      success?: boolean;
      transport?: 'offscreen' | 'page';
    };
    const remoteResult = ttsContentController.completeRemoteRequest(remoteRequest, response);
    if (remoteResult === 'stale') return;
    if (remoteResult === 'offscreen') {
      currentAudioKind.value = kind;
      currentAudioText.value = text;
      isPlaying.value = true;
      return;
    }
  } catch (cause) {
    const isCurrent = ttsContentController.rejectRemoteRequest(remoteRequest);
    if (!isCurrent) return;
    console.warn('Offscreen Google TTS unavailable, trying page audio:', cause);
  }

  if (!ttsContentController.isCurrentGeneration(requestId)) return;
  const speechUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(language)}&client=tw-ob&q=${encodeURIComponent(text)}`;
  const nextAudio = new Audio(speechUrl);
  nextAudio.preload = 'auto';
  nextAudio.onended = () => { if (audio === nextAudio) { releasePageAudio(); stopAudio(); } };
  nextAudio.onerror = () => {
    if (audio !== nextAudio) return;
    console.warn('Fallback speech audio failed');
    releasePageAudio();
    stopAudio(false);
  };
  audio = nextAudio;
  currentAudioKind.value = kind;
  currentAudioText.value = text;
  currentAudioKey.value = text;
  isPlaying.value = true;
  try {
    await nextAudio.play();
  } catch {
    if (audio === nextAudio) releasePageAudio();
    if (ttsContentController.isCurrentGeneration(requestId)) stopAudio(false);
  }
}

async function playExternalAudio(url: string, text: string, kind: AudioKind, key: string, requestId: number): Promise<boolean> {
  if (!ttsContentController.isCurrentGeneration(requestId)) return true;
  const nextAudio = new Audio(url);
  audio = nextAudio;
  currentAudioKind.value = kind;
  currentAudioText.value = text;
  currentAudioKey.value = key;
  isPlaying.value = true;
  nextAudio.onended = () => { if (audio === nextAudio) stopAudio(); };
  nextAudio.onerror = () => {
    if (audio !== nextAudio) return;
    audio = null;
    nextAudio.removeAttribute('src');
    isPlaying.value = false;
  };
  try {
    await nextAudio.play();
    return true;
  } catch (cause) {
    if (audio === nextAudio) {
      audio = null;
      nextAudio.removeAttribute('src');
      isPlaying.value = false;
    }
    if (ttsContentController.isCurrentGeneration(requestId)) console.warn('Dictionary pronunciation audio unavailable:', cause);
    return false;
  }
}

async function toggleAudio(text: string, kind: AudioKind): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) return;
  if (isCurrentAudio(kind) && currentAudioText.value === cleanText) { stopAudio(); return; }
  stopAudio();
  const language = speechLanguage(cleanText, kind);
  const requestId = ttsContentController.currentGeneration();
  isPlaying.value = true;
  currentAudioKind.value = kind;
  currentAudioText.value = cleanText;
  currentAudioKey.value = cleanText;
  const edgeResult = await playEdgeSpeech(cleanText, language, kind, requestId);
  if (edgeResult.handled || !ttsContentController.isCurrentGeneration(requestId)) return;
  if (edgeResult.errorCode === 'local-tts-model-not-downloaded') {
    showNotice(t('selectionTts.localModelNotDownloaded'), 'open-local-tts');
  } else if (edgeResult.errorCode === 'local-tts-language-unsupported') {
    showNotice(t('selectionTts.languageUnsupported'));
  }
  if (config.selectionTtsMode === 'local-only') return;
  if (!playBrowserSpeech(cleanText, language, kind)) await playGoogleFallback(cleanText, language, kind);
}

function handleSelectionTtsState(message: unknown): true | undefined {
  const state = ttsContentController.matchRemoteState(message);
  if (!state) return undefined;

  const text = currentAudioText.value;
  const kind = currentAudioKind.value;
  const language = kind && text ? speechLanguage(text, kind) : '';
  if (state === 'ended' || state === 'stopped') {
    stopAudio(false);
    return true;
  }
  if (state === 'error') {
    stopAudio(false);
    if (text && kind && !playBrowserSpeech(text, language, kind)) void playGoogleFallback(text, language, kind);
    return true;
  }
  return undefined;
}

async function toggleWordAudio(pronunciation: WordPronunciation): Promise<void> {
  const word = wordCard.value?.word || selectedWord.value || selectedText.value;
  const cleanText = word.trim();
  if (!cleanText) return;
  const key = wordAudioKey(pronunciation);
  if (isCurrentAudio('word', key)) { stopAudio(); return; }
  stopAudio();
  const requestId = ttsContentController.currentGeneration();
  isPlaying.value = true;
  currentAudioKind.value = 'word';
  currentAudioText.value = cleanText;
  currentAudioKey.value = key;
  const externalAudio = pronunciation.audio;
  if (externalAudio) {
    const externalStarted = await playExternalAudio(externalAudio, cleanText, 'word', key, requestId);
    if (externalStarted || !ttsContentController.isCurrentGeneration(requestId)) return;
  }
  const edgeStarted = await playEdgeSpeech(cleanText, 'en-US', 'word', requestId);
  if (edgeStarted || !ttsContentController.isCurrentGeneration(requestId)) return;
  if (!playBrowserSpeech(cleanText, 'en-US', 'word')) playGoogleFallback(cleanText, 'en-US', 'word');
}

/** 右键“翻译选中文本”：直接按当前选区出卡片，跳过触发方式与延迟设置。 */
function translateSelectionFromContextMenu(): boolean {
  const next = readSelectionSnapshot();
  if (!next) return false;
  suppressSelectionUntil = 0;
  isSelecting = false;
  applySelection(next, true, false, true);
  return showTooltip.value;
}

function closeTooltip(): void { hideAll(); }
function hideAll(): void {
  resetPopupGeometry();
  // 保留关闭时的选区身份，避免按钮保留原生选区时 pointerup / selectionchange 再次打开卡片。
  dismissedSelection = snapshot.value ?? readSelectionSnapshot() ?? dismissedSelection;
  lastTrustedSelectionInteractionAt = 0;
  if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
  selectionFrame = null;
  cancelSelectionLoss();
  cancelSelectionPresentation();
  selectionSettledAt = 0;
  resetSelectionContentState(true);
  readingMode.value = false;
  readingSelection.value = null;
  showIndicator.value = false;
  showTooltip.value = false;
  snapshot.value = null;
  pendingSelectionShortcutUntil = 0;
  isVocabularySaved.value = false;
  vocabularyBusy.value = false;
}
function isInsideUi(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  if (!node) return false;
  const host = document.getElementById('fluent-read-selection-translator-container');
  const root = node.getRootNode();
  return Boolean(node === host || host?.contains(node) || root === host?.shadowRoot);
}
function matchesSelectionModifierOnPointer(event: PointerEvent): boolean {
  const shortcut = selectionShortcut.value;
  if (!['Control', 'Alt', 'Shift'].includes(shortcut)) return false;
  const modifierState = {
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    key: shortcut === 'Control' ? 'Control' : shortcut === 'Alt' ? 'Alt' : 'Shift',
  };
  return matchesModifierOnlyHotkey(modifierState, shortcut);
}
function handlePointerDown(event: PointerEvent): void {
  if (!event.isTrusted) return;
  lastTrustedSelectionInteractionAt = Date.now();
  if (isInsideUi(event.target)) {
    uiPointerInteraction = true;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  uiPointerInteraction = false;
  suppressSelectionUntil = 0;
  isSelecting = event.button === 0;
  pendingSelectionShortcutUntil = 0;
  hideAll();
}
function handlePointerUp(event: PointerEvent): void {
  if (!event.isTrusted) return;
  lastTrustedSelectionInteractionAt = Date.now();
  if (uiPointerInteraction || isInsideUi(event.target)) {
    uiPointerInteraction = false;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  uiPointerInteraction = false;
  const completedSelectionGesture = isSelecting;
  isSelecting = false;
  if (!completedSelectionGesture || event.button !== 0) return;
  scheduleSelectionRead(matchesSelectionModifierOnPointer(event) || selectionShortcutHeld);
}
function handlePointerCancel(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (uiPointerInteraction || isInsideUi(event.target)) {
    uiPointerInteraction = false;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  isSelecting = false;
  hideAll();
}
function handleSelectionChange(event: Event): void {
  if (readingMode.value && isInsideUi(document.activeElement)) return;
  if (!event.isTrusted) return;
  // 新的拖选/双击可以再次选中同一段；单纯点击保留旧选区的按钮不能解除关闭状态。
  if (isSelecting && dismissedSelection) {
    const current = readSelectionSnapshot();
    if (!current || !isSameSelection(dismissedSelection, current)) dismissedSelection = null;
  }
  if (Date.now() - lastTrustedSelectionInteractionAt > TRUSTED_SELECTION_INTERACTION_GRACE_MS) return;
  if (!isSelectionReadSuppressed()) scheduleSelectionRead(selectionShortcutHeld);
}
// 仅在扩展 UI 内拦住滚轮冒泡；document 级 wheel 会抑制 Chromium 对同节点派发 legacy mousewheel，导致旧播放器收不到音量手势。
function handleUiWheel(): void { suppressSelectionRead(); }
function handleScroll(event: Event): void {
  if (isInsideUi(event.target)) {
    suppressSelectionRead();
    return;
  }
  schedulePositionUpdate();
}
function handleKeydown(event: KeyboardEvent): void {
  if (!event.isTrusted) return;
  lastTrustedSelectionInteractionAt = Date.now();
  if (isInsideUi(event.target)) {
    suppressSelectionRead();
    if (event.key === 'Escape' && snapshot.value) hideAll();
    return;
  }
  if (event.key === 'Escape' && snapshot.value) { hideAll(); return; }
  if (event.repeat || event.isComposing) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (readingEnabled.value && readingPreferences.value.trigger === 'shortcut'
    && matchesConfiguredHotkey(event, 'custom', readingPreferences.value.customHotkey)) {
    const current = readSelectionSnapshot();
    if (!current) return;
    if (shouldSkipChineseSelection(current.text, config.to)) { hideAll(); return; }
    event.preventDefault();
    event.stopPropagation();
    applySelection(current, true, true);
    return;
  }
  const matchesSelectionShortcut = matchesConfiguredHotkey(event, selectionShortcutConfig.value, selectionSettings.value.customHotkey);
  if (!matchesSelectionShortcut) return;
  selectionShortcutHeld = true;
  const currentSelection = readSelectionSnapshot();
  if (currentSelection) {
    if (isSelectionInTargetLanguage(currentSelection.text)) { hideAll(); return; }
    event.preventDefault();
    event.stopPropagation();
    applySelection(currentSelection, true);
    return;
  }
  if (!snapshot.value) {
    scheduleSelectionRead(true);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  scheduleSelectionPresentation('tooltip');
}

function handleKeyup(): void {
  selectionShortcutHeld = false;
}

function handleWindowBlur(): void {
  stopPopupGesture();
  cancelReadingHover();
  selectionShortcutHeld = false;
  pendingSelectionShortcutUntil = 0;
}

function handleSelectionSettingsMessage(message: unknown): undefined {
  if (!message || typeof message !== 'object') return undefined;
  const type = (message as { type?: unknown }).type;
  if (type !== 'updateSelectionTranslatorSettings' && type !== 'updateSelectionTranslatorMode') return undefined;
  selectionConfigVersion.value += 1;
  return undefined;
}

function handleVocabularyBookChanged(message: unknown): undefined {
  if (!message || typeof message !== 'object' || (message as {type?: unknown}).type !== VOCABULARY_BOOK_CHANGED_MESSAGE) return undefined;
  const request = currentContentRequest.value;
  if (request && isWordSelection.value) void refreshVocabularySaved(request);
  return undefined;
}

onMounted(() => {
  updateTheme();
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMedia.addEventListener('change', updateTheme);
  browser.runtime.onMessage.addListener(handleSelectionSettingsMessage);
  browser.runtime.onMessage.addListener(handleVocabularyBookChanged);
  releaseContextMenuHandler = setSelectionContextMenuHandler(translateSelectionFromContextMenu);
  unsubscribeConfig = subscribeConfig(() => { selectionConfigVersion.value += 1; });
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', handlePointerCancel, true);
  document.addEventListener('selectionchange', handleSelectionChange);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('keyup', handleKeyup, true);
  window.addEventListener('blur', handleWindowBlur);
  browser.runtime.onMessage.addListener(handleSelectionTtsState);
  window.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', schedulePositionUpdate);
  watch(tooltipRef, (tooltip) => {
    stopPopupGesture();
    tooltipResizeObserver?.disconnect();
    tooltipResizeObserver = null;
    if (!tooltip || typeof ResizeObserver === 'undefined') return;
    tooltipResizeObserver = new ResizeObserver(schedulePositionUpdate);
    tooltipResizeObserver.observe(tooltip);
  }, { flush: 'post' });
  watch(() => JSON.stringify(readingPreferences.value), () => { hideAll(); });
  watch(() => [
    selectionSettings.value.theme,
    selectionSettings.value.trigger,
    selectionSettings.value.customHotkey,
    selectionSettings.value.delay,
    selectionSettings.value.mode,
    selectionSettings.value.to,
    selectionSettings.value.from,
    selectionSettings.value.service,
    selectionSettings.value.model,
    config.vocabularyBookEnabled,
  ] as const, (nextSettings, previousSettings) => {
    const themeChanged = !previousSettings || nextSettings[0] !== previousSettings[0];
    const triggerChanged = !previousSettings
      || nextSettings[1] !== previousSettings[1]
      || nextSettings[2] !== previousSettings[2];
    const delayChanged = !previousSettings || nextSettings[3] !== previousSettings[3];
    const languageChanged = !previousSettings
      || nextSettings[5] !== previousSettings[5]
      || nextSettings[6] !== previousSettings[6];
    const translationProviderChanged = !previousSettings
      || nextSettings[7] !== previousSettings[7]
      || nextSettings[8] !== previousSettings[8];
    if (themeChanged) updateTheme();
    if (!snapshot.value) return;
    if (languageChanged && readingMode.value) { hideAll(); return; }
    if (languageChanged && (shouldSkipChineseSelection(snapshot.value.text, config.to)
      || (!readingEnabled.value && isSelectionInTargetLanguage(snapshot.value.text)))) { hideAll(); return; }
    if (languageChanged || translationProviderChanged) resetSelectionContentState();
    if (triggerChanged) {
      const nextPresentation = reconcileSelectionPresentation({
        showIndicator: showIndicator.value,
        showTooltip: showTooltip.value,
      }, triggerMode.value, true);
      cancelSelectionPresentation();
      showIndicator.value = false;
      showTooltip.value = false;
      if (nextPresentation.showTooltip) scheduleSelectionPresentation('tooltip');
      else if (nextPresentation.showIndicator) scheduleSelectionPresentation('indicator');
      return;
    }
    if (delayChanged && pendingSelectionPresentation) {
      scheduleSelectionPresentation(pendingSelectionPresentation);
      return;
    }
    if (languageChanged || translationProviderChanged) {
      if (showTooltip.value && !readingMode.value) void requestSelectionContent(snapshot.value.text);
    }
    if (previousSettings && nextSettings[9] !== previousSettings[9] && showTooltip.value && isWordSelection.value) {
      const request = currentContentRequest.value;
      if (request) void refreshVocabularySaved(request);
    }
  });
});

onBeforeUnmount(() => {
  releaseContextMenuHandler?.();
  releaseContextMenuHandler = null;
  stopPopupGesture();
  if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
  if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
  cancelSelectionLoss();
  cancelSelectionPresentation();
  clearCopyFeedback();
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  systemThemeMedia?.removeEventListener('change', updateTheme);
  browser.runtime.onMessage.removeListener(handleSelectionSettingsMessage);
  browser.runtime.onMessage.removeListener(handleVocabularyBookChanged);
  unsubscribeConfig?.();
  unsubscribeConfig = null;
  tooltipResizeObserver?.disconnect();
  tooltipResizeObserver = null;
  document.removeEventListener('pointerdown', handlePointerDown, true);
  document.removeEventListener('pointerup', handlePointerUp, true);
  document.removeEventListener('pointercancel', handlePointerCancel, true);
  document.removeEventListener('selectionchange', handleSelectionChange);
  document.removeEventListener('keydown', handleKeydown, true);
  document.removeEventListener('keyup', handleKeyup, true);
  window.removeEventListener('blur', handleWindowBlur);
  browser.runtime.onMessage.removeListener(handleSelectionTtsState);
  window.removeEventListener('scroll', handleScroll, true);
  window.removeEventListener('resize', schedulePositionUpdate);
  resetSelectionContentState(true);
});
</script>

<style scoped>
.fr-selection-translator-root { position: fixed; inset: 0; z-index: 2147483647; width: 100vw; height: 100vh; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #25252a; }
.fr-selection-indicator, .fr-translation-tooltip, .fr-copy-success-toast, .fr-action-toast { pointer-events: auto; }
.fr-reading-indicator { position: fixed; display: flex; align-items: center; gap: 2px; max-width: calc(100vw - 24px); overflow-x: auto; box-sizing: border-box; padding: 3px; border-radius: 10px; border: 1px solid #eadfe5; background: #fff; box-shadow: 0 4px 16px #35242d1a; pointer-events: auto; }
.fr-reading-indicator button { flex: none; white-space: nowrap; }
.fr-reading-indicator .fr-reading-history-entry { display: flex; align-items: center; gap: 3px; padding-inline: 7px; color: #8d858b; border-left: 1px solid #eadfe5; border-radius: 0 7px 7px 0; }
.fr-reading-history-entry svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.fr-reading-indicator button, .fr-mode-btn { padding: 4px 9px; border: 0; border-radius: 7px; color: #985674; background: transparent; font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; cursor: pointer; }
.fr-reading-indicator button:hover, .fr-mode-btn:hover { background: #f9eaf0; }
.fr-reading-indicator button.is-default { background: #f8e4ed; color: #923758; font-weight: 650; }
.fr-reading-indicator button:focus-visible, .fr-mode-btn:focus-visible { outline: 2px solid #bd5d85; outline-offset: 1px; }
.fr-reading-indicator.fr-dark-theme { background: #2c2730; border-color: #544351; }
.fr-dark-theme .fr-mode-btn, .fr-reading-indicator.fr-dark-theme button { color: #e5a8c0; }
.fr-reading-indicator.fr-dark-theme button.is-default { background: #583344; color: #ffd6e6; }
.fr-selection-indicator { position: fixed; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; transform: translate(-50%, -50%); background: #ef4b86; color: #fff; box-shadow: 0 2px 7px rgba(204, 40, 104, .28), 0 0 0 2px rgba(255, 255, 255, .94); cursor: pointer; transition: transform .14s ease, box-shadow .14s ease; }
.fr-selection-indicator--dot { width: 8px; height: 8px; }
.fr-selection-indicator--dot .fr-selection-indicator-glyph { display: none; }
.fr-selection-indicator:hover, .fr-selection-indicator:focus-visible { transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 4px 14px rgba(204, 40, 104, .4), 0 0 0 3px rgba(255, 255, 255, .95); outline: none; }
.fr-selection-indicator-glyph { font-size: 10px; font-weight: 700; line-height: 1; }
.fr-translation-tooltip, .fr-translation-tooltip * { box-sizing: border-box; }
.fr-translation-tooltip { position: fixed; display: flex; flex-direction: column; width: min(388px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 20px)); overflow: hidden; border: 1px solid rgba(35, 35, 43, .1); border-radius: 14px; background: #fff; box-shadow: 0 8px 28px rgba(35, 33, 43, .14); -webkit-user-select: none; user-select: none; }
.fr-translation-tooltip:not(.fr-reading-tooltip) > .fr-tooltip-header { cursor: move; touch-action: none; }
.fr-popup-manipulating, .fr-popup-manipulating * { cursor: grabbing !important; user-select: none !important; }
.fr-popup-resize-handle { position: absolute; z-index: 2; touch-action: none; }
.fr-popup-resize-n, .fr-popup-resize-s { left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.fr-popup-resize-n { top: 0; } .fr-popup-resize-s { bottom: 0; }
.fr-popup-resize-e, .fr-popup-resize-w { top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.fr-popup-resize-e { right: 0; } .fr-popup-resize-w { left: 0; }
.fr-popup-resize-ne, .fr-popup-resize-nw, .fr-popup-resize-se, .fr-popup-resize-sw { width: 12px; height: 12px; }
.fr-popup-resize-ne { top: 0; right: 0; cursor: nesw-resize; }
.fr-popup-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
.fr-popup-resize-se { bottom: 0; right: 0; cursor: nwse-resize; }
.fr-popup-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
.fr-popup-resize-se::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 5px; height: 5px; border-right: 2px solid #95858d; border-bottom: 2px solid #95858d; }
.fr-reading-tooltip { display: flex; flex-direction: column; height: min(520px, calc(100vh - 24px)); }
.fr-reading-tooltip > .fr-tooltip-header { flex: none; }
.fr-reading-tooltip > .fr-reading-content { flex: 1; min-height: 0; max-height: none; overflow: hidden; padding: 0; }
.fr-tooltip-header { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 7px; border-bottom: 1px solid rgba(44, 43, 53, .08); font-size: 15px; font-weight: 750; }
.fr-tooltip-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.fr-tooltip-brand-icon { display: block; flex: none; width: 18px; height: 18px; border-radius: 5px; object-fit: contain; opacity: .78; }
.fr-tooltip-title span { overflow: hidden; color: #292832; letter-spacing: -.02em; text-overflow: ellipsis; white-space: nowrap; }
.fr-tooltip-actions { flex: none; display: flex; align-items: center; gap: 4px; }
.fr-action-btn, .fr-close-btn, .fr-text-audio-btn, .fr-playing-status button { border: 0; background: transparent; color: #777780; cursor: pointer; }
.fr-action-btn { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 10px; }
.fr-action-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.fr-action-btn:hover, .fr-action-btn:focus-visible { background: #f7eaf0; color: #d63f76; outline: none; }
.fr-action-btn:disabled { cursor: not-allowed; opacity: .38; }
.fr-vocabulary-btn.fr-saved { color: #ef4b86; }
.fr-vocabulary-btn.fr-saved svg { fill: currentColor; stroke: currentColor; }
.fr-close-btn { width: 30px; height: 30px; font-size: 21px; line-height: 1; border-radius: 10px; }
.fr-close-btn:hover, .fr-close-btn:focus-visible { background: #f1f1f5; color: #303038; outline: none; }
.fr-tooltip-content { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 12px; scrollbar-color: rgba(108, 105, 112, .4) transparent; scrollbar-width: thin; }
.fr-translation-container { display: grid; gap: 10px; }
.fr-loading-state, .fr-error-state { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 80px; color: #777780; font-size: 13px; }
.fr-error-state { flex-direction: column; color: #c43b63; }
.fr-error-state button { border: 1px solid currentColor; border-radius: 7px; padding: 4px 10px; background: transparent; color: inherit; cursor: pointer; }
.fr-loading-spinner { width: 18px; height: 18px; border: 2px solid #f5bfd3; border-top-color: #ef4b86; border-radius: 50%; animation: fr-spin .7s linear infinite; }
.fr-loading-spinner.fr-static { animation: none; }
@keyframes fr-spin { to { transform: rotate(360deg); } }
.fr-word-learning-card { padding: 1px 1px 0; color: #39363d; }
.fr-word-card-loading { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 74px; color: #77747c; font-size: 13px; }
.fr-word-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-height: 58px; padding: 4px 1px 14px; border-bottom: 1px solid #eeecee; }
.fr-word-heading > div:first-child { min-width: 0; }
.fr-word-heading h3 { margin: 0; color: #292832; font-size: 27px; font-weight: 700; letter-spacing: -.035em; line-height: 1.08; overflow-wrap: anywhere; user-select: text; }
.fr-word-normalized { display: block; margin-top: 5px; color: #aaa1a6; font-size: 10px; }
.fr-word-heading-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.fr-word-heading-audio { background: #f8f5f6; color: #9b8d94; }
.fr-word-pronunciations { display: grid; gap: 0; margin-top: 10px; padding-bottom: 10px; border-bottom: 1px solid #eeecee; }
.fr-word-pronunciation { display: flex; align-items: center; gap: 8px; min-height: 29px; padding: 3px 1px; border-bottom: 1px solid #f2f0f1; }
.fr-word-pronunciation:last-child { border-bottom: 0; }
.fr-word-pronunciation-label { min-width: 34px; color: #a36b7b; font-size: 10px; font-weight: 700; }
.fr-word-ipa { color: #4a454c; font-family: Georgia, "Times New Roman", serif; font-size: 14px; }
.fr-word-pronunciation .fr-text-audio-btn { margin-left: auto; }
.fr-word-translation { margin-top: 12px; padding: 1px 1px 12px; border-bottom: 1px solid #eeecee; color: #3a363d; }
.fr-word-translation-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.fr-word-translation .fr-text-label { margin: 0; }
.fr-word-translation pre { overflow-wrap: anywhere; margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 18px; font-weight: 700; line-height: 1.3; user-select: text; }
.fr-word-translation-loading, .fr-word-empty { margin-top: 12px; color: #9a9298; font-size: 12px; }
.fr-word-meaning-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; color: #9a9298; font-size: 11px; font-weight: 700; }
.fr-word-meaning-toolbar button { border: 0; padding: 3px 0; background: transparent; color: #9e5d71; cursor: pointer; font: inherit; font-weight: 600; }
.fr-word-meaning-toolbar button:hover, .fr-word-meaning-toolbar button:focus-visible { color: #7f4156; text-decoration: underline; outline: none; }
.fr-word-meanings { display: grid; gap: 16px; margin-top: 14px; }
.fr-word-meaning-toolbar + .fr-word-meanings { margin-top: 8px; }
.fr-word-meaning { color: #454149; font-size: 12.5px; line-height: 1.52; }
.fr-word-meaning > strong { display: inline-flex; padding: 3px 7px; border: 1px solid #ead8de; border-radius: 6px; background: #fbf5f6; color: #9e5d71; font-size: 10px; font-weight: 700; }
.fr-word-meaning ol { margin: 7px 0 0; padding: 0; list-style: none; counter-reset: definition; }
.fr-word-meaning li { position: relative; padding-left: 21px; }
.fr-word-meaning li::before { position: absolute; top: 0; left: 0; width: 14px; color: #b5adb2; content: counter(definition); counter-increment: definition; font-size: 11px; text-align: right; }
.fr-word-meaning li + li { margin-top: 9px; }
.fr-word-definition-en, .fr-word-example-en { display: block; }
.fr-word-definition-zh, .fr-word-example-zh { display: block; margin-top: 3px; color: #9a7f89; font-size: 11.5px; }
.fr-word-meaning em { display: block; margin-top: 4px; padding-left: 8px; border-left: 2px solid #ead8de; color: #74676d; font-size: 11px; font-style: normal; line-height: 1.45; }
.fr-word-card-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px; margin-top: 16px; padding-top: 10px; border-top: 1px solid #eeecee; color: #aaa1a6; font-size: 10px; }
.fr-word-card-footer a { color: #9e5d71; text-decoration: none; }
.fr-word-card-footer a:hover, .fr-word-card-footer a:focus-visible { text-decoration: underline; }
.fr-word-fallback-note, .fr-inline-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: #a56578; font-size: 11px; }
.fr-word-fallback-note { padding: 6px 8px; border-radius: 7px; background: #fff8fa; }
.fr-inline-error button, .fr-word-fallback-note button { border: 1px solid currentColor; border-radius: 6px; padding: 2px 7px; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
.fr-text-block { padding: 2px 1px 4px; }
.fr-text-block + .fr-text-block { padding-top: 10px; border-top: 1px solid rgba(127, 127, 140, .16); }
.fr-original-text { color: #666570; }
.fr-translation-result { color: #39373d; }
.fr-text-block-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; }
.fr-text-label { margin: 0; color: #9797a4; font-size: 11px; font-weight: 750; letter-spacing: .01em; }
.fr-text-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.fr-text-copy-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 0 8px; border: 1px solid rgba(126, 113, 121, .12); border-radius: 9px; background: rgba(255, 255, 255, .45); color: #8c8188; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; line-height: 1; white-space: nowrap; transition: background .14s ease, border-color .14s ease, color .14s ease, transform .14s ease; }
.fr-text-copy-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.fr-text-copy-btn:hover, .fr-text-copy-btn:focus-visible { border-color: rgba(214, 63, 118, .35); background: #fff; color: #d63f76; outline: none; transform: translateY(-1px); }
.fr-text-copy-btn.fr-copied { border-color: rgba(214, 63, 118, .2); background: rgba(255, 255, 255, .72); color: #b85c7b; }
.fr-text-copy-btn:disabled { cursor: not-allowed; opacity: .42; transform: none; }
.fr-text-audio-btn { position: static; display: grid; flex: none; width: 36px; height: 28px; place-items: center; border: 1px solid rgba(126, 113, 121, .12); border-radius: 9px; background: rgba(255, 255, 255, .45); color: #8c8188; transition: background .14s ease, border-color .14s ease, color .14s ease, transform .14s ease; }
.fr-text-audio-btn svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.fr-text-audio-btn:hover, .fr-text-audio-btn:focus-visible { border-color: rgba(214, 63, 118, .25); background: rgba(255, 255, 255, .72); color: #d63f76; outline: none; transform: translateY(-1px); }
.fr-text-block pre { overflow-wrap: anywhere; margin: 9px 0 0; overflow: auto; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 15.5px; line-height: 1.55; user-select: text; }
.fr-playing-status { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; color: #777780; font-size: 12px; }
.fr-playing-status button { border: 1px solid #e8a4bc; border-radius: 7px; padding: 3px 8px; color: #d83e70; }
.fr-copy-success-toast { position: fixed; right: 18px; bottom: 18px; padding: 9px 13px; border-radius: 9px; background: #2c2c35; color: #fff; font-size: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.fr-action-toast { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px; padding: 9px 13px; border-radius: 9px; background: #2c2c35; color: #fff; font-size: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.fr-action-toast button { padding: 0; border: 0; color: #ffc2d5; background: transparent; cursor: pointer; font: inherit; font-weight: 700; }
.fr-dark-theme { border-color: #44444e; background: rgba(40, 40, 48, .98); color: #f1f1f4; }
.fr-reading-tooltip.fr-dark-theme { background: #282830; }
.fr-dark-theme .fr-tooltip-header { border-color: #4b4b56; }
.fr-dark-theme .fr-tooltip-title span { color: #f1edf1; }
.fr-dark-theme .fr-tooltip-brand-icon { opacity: .86; }
.fr-dark-theme .fr-action-btn:hover, .fr-dark-theme .fr-close-btn:hover { background: #50505b; color: #fff; }
.fr-dark-theme .fr-text-copy-btn { border-color: #554e56; background: rgba(61, 57, 64, .72); color: #c4b8bf; }
.fr-dark-theme .fr-text-copy-btn:hover, .fr-dark-theme .fr-text-copy-btn:focus-visible { border-color: #c96a8b; background: #553846; color: #ffd9e7; }
.fr-dark-theme .fr-text-copy-btn.fr-copied { border-color: #98617a; background: rgba(93, 52, 71, .62); color: #f2bdcd; }
.fr-dark-theme .fr-text-audio-btn { border-color: #554e56; background: rgba(61, 57, 64, .72); color: #c4b8bf; }
.fr-dark-theme .fr-text-audio-btn:hover, .fr-dark-theme .fr-text-audio-btn:focus-visible { border-color: #c96a8b; background: #553846; color: #ffd9e7; }
.fr-dark-theme .fr-original-text { color: #d0d0d7; }
.fr-dark-theme .fr-translation-result { color: #f1ecef; }
.fr-dark-theme .fr-word-learning-card { background: transparent; }
.fr-dark-theme .fr-word-heading, .fr-dark-theme .fr-word-pronunciations, .fr-dark-theme .fr-word-translation, .fr-dark-theme .fr-word-card-footer { border-color: #4b4148; }
.fr-dark-theme .fr-word-heading h3, .fr-dark-theme .fr-word-meaning, .fr-dark-theme .fr-word-translation { color: #f2e8ed; }
.fr-dark-theme .fr-word-meaning-toolbar { color: #c8aab5; }
.fr-dark-theme .fr-word-meaning-toolbar button { color: #f0b9cb; }
.fr-dark-theme .fr-word-heading-audio { background: #4a454b; color: #d5c4cb; }
.fr-dark-theme .fr-word-pronunciation { border-color: #443a42; }
.fr-dark-theme .fr-word-pronunciation-label { color: #e0a7b9; }
.fr-dark-theme .fr-word-ipa { color: #f0dce4; }
.fr-dark-theme .fr-word-meaning > strong { border-color: #684b58; background: #493842; color: #ffd9e7; }
.fr-dark-theme .fr-word-meaning em { border-color: #684b58; }
.fr-dark-theme .fr-word-meaning em, .fr-dark-theme .fr-word-definition-zh, .fr-dark-theme .fr-word-example-zh, .fr-dark-theme .fr-word-translation-loading, .fr-dark-theme .fr-word-empty { color: #c8aab5; }
.fr-dark-theme .fr-word-fallback-note { background: #4a303b; }
@media (prefers-reduced-motion: reduce) { .fr-selection-indicator, .fr-loading-spinner { transition: none; animation: none; } }
</style>
