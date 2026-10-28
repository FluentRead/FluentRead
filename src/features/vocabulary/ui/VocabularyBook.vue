<!--
 * @file src/features/vocabulary/ui/VocabularyBook.vue
 * 撤销归属：后台事务保存删除快照并保留 24 小时的恢复期限，页面只持票据；失败时提示未确认，不自动重放。
 * 文件职责：组织内容优先的学习收藏列表与主动复习，协调句子听读、解释保存、筛选与文件操作。
 * 主要内容：相同译文保留原文且不重复展示；把复习作为列表主操作，收藏开关与文件动作收进管理菜单；搜索与类型筛选合为一行，每条收藏直接提供学习入口；筛选排序独立于搜索输入，正文索引按需建立并限制文本字符总量，超预算词条继续完整匹配；界面文案订阅共享语言与资源修订，缓存期间首次加载的语言也能自动更新。配置、数据和朗读沿用已有消息协议，后台进度保持播放状态、结束或停止才释放，页面音频失败按在线与浏览器两级有限回退并合并重复错误通知；音频恢复后复验代次再解码，浏览器语音只接受当前话语的开始事件；收藏面板或文档隐藏时延后普通读取并停止到期扫描，恢复可见后串行读取，已接受的保存继续结算；确认开始即占用操作状态，等待、菜单让步及响应后校验生命周期，拒绝迟到请求、文件下载和已卸载界面更新。
 * 模块边界：UI 不直接访问 Dexie 或上传学习数据；完整备份进入备份与恢复页，收藏文件只包含本领域数据，数据库操作集中在后台 repository/handler，上下文和来源只有用户明确选择时才导出。
 -->
<template>
  <div class="vocabulary-book">
    <VocabularyStudy v-if="studyEntry" :key="studyEntry.id" :entry="studyEntry" :reference="entryTranslation(studyEntry)" :playing="playingEntryId === studyEntry.id" @updated="replaceEntry" @close="selectedEntryId = ''" @speak="toggleEntrySpeech(studyEntry)" @navigate="emit('navigate', $event)" />
    <template v-else>
    <div v-if="!reviewActive && !entries.length && betaEnabled && !selectionTranslatorEnabled" class="selection-reminder" role="note">
      <span>{{ t('learning.collection.emptyHint') }}</span>
      <button type="button" @click="emit('navigate', 'settings-selection')">前往开启</button>
    </div>


    <div v-if="loadError" class="error-state" role="alert">
      <span>{{ loadError }}</span><button type="button" @click="loadEntries">重试</button>
    </div>

    <template v-else>
      <section v-if="reviewActive" class="review-shell" aria-live="polite">
        <header class="review-header">
          <div><span class="eyebrow">主动回忆</span><strong>{{ reviewPosition }} / {{ reviewTotal }}</strong></div>
          <button type="button" :disabled="actionBusy" @click="finishReview">退出本轮</button>
        </header>

        <div v-if="currentReview" class="review-card">
          <span class="status-pill" :class="`status-${currentReview.status}`">{{ currentReview.status === 'new' ? translateControlLabel('新收藏') : statusLabel(currentReview.status) }}</span>
          <div v-if="!reviewAnswerVisible" class="review-prompt">
            <p v-if="currentClozeContext" class="cloze-context" data-i18n-ignore>{{ currentClozeContext }}</p>
            <h3 v-else data-i18n-ignore>{{ currentReview.term }}</h3>
            <small>{{ currentClozeContext ? '回忆空缺处的表达和含义' : '回忆它的含义，并想想可以怎样使用' }}</small>
          </div>

          <textarea v-if="!reviewAnswerVisible" v-model="recallDraft" class="recall-draft" rows="2" maxlength="400" aria-label="我的回忆" placeholder="试着写下答案或一个用法，再核对…" @keydown.stop />
          <button v-if="!reviewAnswerVisible" class="reveal-button" type="button" @click="reviewAnswerVisible = true">显示答案 <kbd>Space</kbd></button>

          <div v-else class="review-answer">
            <div class="answer-heading"><h3 data-i18n-ignore>{{ currentReview.term }}</h3><button class="vocabulary-speak" type="button" :aria-label="playingEntryId === currentReview.id ? '停止朗读' : '朗读原文'" :title="playingEntryId === currentReview.id ? '停止朗读' : '朗读原文'" @click="toggleEntrySpeech(currentReview)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7h4l4-3v12l-4-3H3z" /><path :d="playingEntryId === currentReview.id ? 'M14 7v6m3-6v6' : 'M14 7a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12'" /></svg></button><span v-if="currentReview.phonetic">{{ currentReview.phonetic }}</span></div>
            <p v-if="recallDraft" class="recall-attempt">你的回忆：<span data-i18n-ignore>{{ recallDraft }}</span></p>
            <span v-if="!entryTranslation(currentReview) || hasDistinctTranslation(currentReview.term, entryTranslation(currentReview))" class="answer-reference-label">收藏时的参考内容</span>
            <ReadingAnswer v-if="hasDistinctTranslation(currentReview.term, entryTranslation(currentReview))" :text="entryTranslation(currentReview)" />
            <p v-else-if="!entryTranslation(currentReview)" class="answer-translation">尚未保存参考内容。可以先进入学习页理解这个表达，再回来复习。</p>
            <button type="button" class="study-entry-button" @click="openStudy(currentReview)">{{ t(isVocabularySentence(currentReview) ? 'learning.collection.listenLearn' : 'learning.collection.learnUsage') }}</button>
            <p v-if="latestContext(currentReview)?.text && latestContext(currentReview)?.text !== currentReview.term" class="answer-context" data-i18n-ignore>{{ latestContext(currentReview)?.text }}</p>
            <VocabularySource :context="vocabularySourceContext(currentReview)" />
            <div class="review-actions">
              <button type="button" class="again" :disabled="actionBusy" @click="rateReview('again')"><span>1</span><strong>忘了</strong><small>约 10 分钟后</small></button>
              <button type="button" class="good" :disabled="actionBusy" @click="rateReview('good')"><span>2</span><strong>记得</strong><small>{{ goodIntervalLabel(currentReview) }}</small></button>
            </div>
          </div>
        </div>

        <div v-else class="review-complete">
          <span aria-hidden="true">✓</span>
          <h3>本轮复习完成</h3>
          <p>复习 {{ reviewStats.reviewed }} 个 · 记得 {{ reviewStats.good }} 个 · 忘了 {{ reviewStats.again }} 个</p>
          <button type="button" @click="finishReview">{{ t('learning.collection.back') }}</button>
        </div>
      </section>

      <template v-else>
        <section class="collection-tools" :aria-label="t('learning.collection.actions')">
          <div class="collection-overview">
            <h2>{{ t('learning.collection.count', {count: entries.length}) }}</h2>
            <span v-if="entries.length">{{ reviewPlan.length ? t('learning.collection.reviewHelp') : t('learning.collection.upToDate') }}</span>
          </div>
          <div class="collection-management">
            <button v-if="entries.length" class="start-review" type="button" :disabled="loading || actionBusy || reviewPlan.length === 0" @click="startReview"><UiIcon name="book" :size="15" />{{ reviewPlan.length ? t('learning.collection.review', {count: reviewPlan.length}) : t('learning.collection.reviewDone') }}</button>
            <details ref="moreMenu" class="book-more" name="fluentread-collection-popover" @keydown.esc.stop.prevent="closeMoreMenuAndFocus">
              <summary :aria-label="t('learning.collection.manage')"><UiIcon name="sliders" :size="14" />{{ t('learning.collection.manage') }}</summary>
              <div class="book-more-menu">
                <div class="collection-switches">
                  <FeatureEnableCard class="vocabulary-saving-control" :title="t('learning.collection.setting')" :description="t('learning.collection.settingHelp')" :model-value="betaEnabled" :disabled="configBusy" @update:model-value="setBetaEnabled" />
                  <FeatureEnableCard class="vocabulary-reencounter-control vocabulary-saving-control" :title="t('reencounter.setting')" :description="t(reencounterSupported ? 'reencounter.settingHelp' : 'reencounter.unsupported')" :model-value="reencounterEnabled" :disabled="configBusy || !reencounterSupported" @update:model-value="setReencounterEnabled" />
                </div>
                <button type="button" :disabled="actionBusy || loading" @click="closeMoreMenuAndFocus(); importInput?.click()">导入收藏</button>
                <button type="button" :disabled="actionBusy || loading || !filteredEntries.length" @click="closeMoreMenuAndFocus(); exportCollection()">导出当前列表</button>
                <button type="button" :disabled="actionBusy || !entries.length" @click="exportAnki">导出到 Anki</button>
                <button type="button" :disabled="loading" @click="closeMoreMenuAndFocus(); loadEntries(); loadUndoTickets()">{{ loading ? '读取中…' : '刷新列表' }}</button>
                <button type="button" class="danger" :disabled="actionBusy || (entries.length === 0 && undoTickets.length === 0)" @click="clearVocabulary">{{ t('learning.collection.clear') }}</button>
              </div>
            </details>
          </div>
          <input ref="importInput" type="file" accept=".json,application/json" hidden aria-label="导入收藏文件" @change="importCollection" />
        </section>

        <section v-if="undoTickets.length" class="recent-deletions" :aria-label="t('learning.collection.recentDeleted', {count: undoTickets.length})">
          <div class="recent-deletions-heading">
            <h3>{{ t('learning.collection.recentDeleted', {count: undoTickets.length}) }}</h3>
            <p>{{ t(isUserscriptBuild ? 'learning.collection.undoScriptNotice' : 'learning.collection.undoExtensionNotice') }}</p>
          </div>
          <div v-for="ticket in undoTickets" :key="ticket.id" class="recent-deletion-row">
            <span class="recent-deletion-term" data-i18n-ignore>{{ ticket.term }}</span>
            <div class="recent-deletion-actions">
              <button class="recent-deletion-restore" type="button" :disabled="actionBusy" @click="undoRemove(ticket)">{{ t('learning.collection.restoreDeleted') }}</button>
              <button type="button" :disabled="actionBusy" @click="discardUndo(ticket)">{{ t('learning.collection.discardUndo') }}</button>
            </div>
          </div>
        </section>
        <section v-if="entries.length" class="toolbar" aria-label="搜索与筛选收藏">
          <label class="search-field"><span aria-hidden="true"><UiIcon name="search" :size="16" /></span><input v-model.trim="query" type="search" aria-label="搜索收藏" placeholder="搜索原文、译文或解释" /></label>
          <UiSelect v-model="kindFilter" class="collection-type" :aria-label="t('learning.collection.type')">
            <ElOption v-for="filter in collectionKinds" :key="filter.value" :value="filter.value" :label="translateControlLabel(filter.label)" />
          </UiSelect>
          <details class="book-filter" name="fluentread-collection-popover" @keydown.esc.stop.prevent="($event.currentTarget as HTMLDetailsElement).open = false">
            <summary><UiIcon name="sliders" :size="14" />{{ t('learning.collection.filter') }}<span v-if="statusFilter !== 'all' || sortOrder !== 'recent'" aria-label="已调整筛选"> ·</span></summary>
            <div class="filter-panel">
          <label>掌握状态</label>
          <UiSelect v-model="statusFilter" aria-label="掌握状态">
            <ElOption value="all" :label="translateControlLabel('全部状态')" />
            <ElOption value="due" :label="translateControlLabel('待复习')" />
            <ElOption value="new" :label="`${translateControlLabel('新收藏')} ${statusCounts.new}`" />
            <ElOption value="learning" :label="translateControlLabel('学习中')" />
            <ElOption value="familiar" :label="translateControlLabel('熟悉')" />
            <ElOption value="mastered" :label="translateControlLabel('已掌握')" />
          </UiSelect>
          <label>排序方式</label>
          <UiSelect v-model="sortOrder" aria-label="排序方式">
            <ElOption value="due" :label="translateControlLabel('按复习时间')" />
            <ElOption value="recent" :label="translateControlLabel('按最近收藏')" />
            <ElOption value="term" :label="translateControlLabel('按字母顺序')" />
          </UiSelect>
              <button v-if="filtersActive" type="button" class="reset-filters" @click="resetFilters">{{ t('learning.collection.reset') }}</button>
            </div>
          </details>
        </section>
        <div v-if="entries.length && filtersActive" class="collection-results" role="status"><span>{{ t('learning.collection.matches', {count: filteredEntries.length}) }}</span><button type="button" @click="resetFilters">{{ t('learning.collection.reset') }}</button></div>

        <section v-if="loading && entries.length === 0" class="empty-state"><span class="loading-ring" /><p>{{ t('learning.collection.loading') }}</p></section>
        <section v-else-if="entries.length === 0" class="empty-state">
          <span aria-hidden="true"><UiIcon name="book" :size="28" /></span>
          <h3>{{ t(betaEnabled ? 'learning.collection.emptyTitle' : 'learning.collection.offEmptyTitle') }}</h3>
          <p>{{ t(betaEnabled ? 'learning.collection.emptyHint' : 'learning.collection.enableHelp') }}</p>
          <button v-if="!betaEnabled" type="button" :disabled="configBusy" @click="setBetaEnabled(true)">{{ t('learning.collection.enable') }}</button>
          <button type="button" class="empty-secondary" @click="emit('navigate', 'settings-data')">从备份恢复</button>
        </section>
        <section v-else-if="filteredEntries.length === 0" class="empty-state"><span aria-hidden="true"><UiIcon name="search" :size="28" /></span><h3>没有匹配的词条</h3><p>{{ t('learning.collection.noMatchesHelp') }}</p><button type="button" @click="resetFilters">{{ t('learning.collection.reset') }}</button></section>

        <section v-else class="word-list" aria-label="收藏的单词与句子">
          <CollectionEntry v-for="entry in pagedEntries" :key="entry.id" :entry="entry" :translation="entryTranslation(entry)" :playing="playingEntryId === entry.id" :speech-phase="playingEntryId === entry.id ? speechPhase : 'idle'" :busy="actionBusy" :status="entry.status === 'new' && isVocabularySentence(entry) ? '新收藏' : statusLabel(entry.status)" :review="nextReviewLabel(entry)" @study="openStudy(entry)" @speak="toggleEntrySpeech(entry)" @copy="copyEntry(entry, $event)" @mastery="entry.status === 'mastered' ? relearn(entry) : setMastered(entry)" @remove="removeEntry(entry)" @updated="replaceEntry" />

          <nav v-if="pageCount > 1" class="pagination" aria-label="单词本分页">
            <button type="button" :disabled="page <= 1" @click="page -= 1">上一页</button>
            <span>第 {{ page }} / {{ pageCount }} 页 · 共 {{ filteredEntries.length }} 个</span>
            <button type="button" :disabled="page >= pageCount" @click="page += 1">下一页</button>
          </nav>
        </section>

      </template>
    </template>

    </template>

    <div v-if="toastMessage" class="book-toast" role="status">
      <span>{{ toastMessage }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import {downloadTextFile as downloadFile} from '@/src/shared/dom/downloadTextFile';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import UiIcon from '@/src/ui/components/UiIcon.vue'
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {applyInterfaceTheme} from '@/src/ui/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n';
import {ElOption} from 'element-plus';

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue';
import VocabularyStudy from './VocabularyStudy.vue';
import CollectionEntry from './CollectionEntry.vue';
import VocabularySource from './VocabularySource.vue';
import {vocabularySourceContext, vocabularySourceLink} from '../source';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
import {ElMessageBox} from 'element-plus';
import browser from 'webextension-polyfill';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {createSelectionTtsClientRequestId, createSelectionTtsContentController, normalizeSpeechLanguage} from '@/src/features/selection-translation/speech/public';
import {normalizeLocalTtsMode} from '@/src/core/config/localTts';
import {
  config as runtimeConfig,
  configReady,
  requestConfigPatch,
  subscribeConfig,
} from '@/src/services/config/store';
import {
  vocabularyReviewCloze,
  isVocabularySentence,
  vocabularyImportNeedsConfirmation,
  buildAnkiTsv,
  advanceVocabularyReviewSession,
  createVocabularyLifecycleGuard,
  createVocabularyReviewSession,
  reconcileVocabularyReviewSession,
  vocabularyReviewSessionProgress,
  VOCABULARY_BOOK_CHANGED_MESSAGE,
  VOCABULARY_BOOK_MESSAGE,
  type VocabularyBookChangedMessage,
  type VocabularyBookExport,
  type VocabularyBookRequest,
  type VocabularyBookResponse,
  type VocabularyContext,
  type VocabularyEntry,
  type VocabularyImportResult,
  type VocabularyUndoTicket,
  type VocabularyReviewResult,
  type VocabularyReviewSessionState,
  type VocabularyScheduledReviewRating,
  type VocabularyStatus,
} from '@/src/features/vocabulary/learningModel';

const props = defineProps<{isVisible?: () => boolean}>();
const keptAliveVisible = ref(true);
const documentVisible = ref(true);
const viewVisible = computed(() => (props.isVisible?.() ?? true) && keptAliveVisible.value && documentVisible.value);
const emit = defineEmits<{ navigate: [section: string] }>();
const {t, translateLegacy: translateControlLabel} = useUiI18n();
const isUserscriptBuild = import.meta.env.BROWSER === 'userscript' || browserCapabilities.browser === 'userscript';
const reencounterSupported = browserCapabilities.browser !== 'userscript';
const betaEnabled = ref(false);
const reencounterEnabled = ref(false);
const selectionTranslatorEnabled = ref(false);
const targetLanguageKey = ref('');
const configBusy = ref(false);
const entries = ref<VocabularyEntry[]>([]);
const selectedEntryId = ref('');
const studyEntry = computed(() => {
  const entryId = selectedEntryId.value;
  if (entryId === '') return undefined;
  return entries.value.find(entry => entry.id === entryId);
});
const recallDraft = ref('');
const loading = ref(false);
const actionBusy = ref(false);
const loadError = ref('');
const query = ref('');
const kindFilter = ref<'all' | 'sentence' | 'expression'>('all');
const collectionKinds = [{value:'all' as const, label:'全部收藏'}, {value:'sentence' as const, label:'句子'}, {value:'expression' as const, label:'单词与短语'}];
const importInput = ref<HTMLInputElement>();
const statusFilter = ref<'all' | 'due' | VocabularyStatus>('all');
const sortOrder = ref<'due' | 'recent' | 'term'>('recent');
const filtersActive = computed(() => Boolean(query.value || kindFilter.value !== 'all' || statusFilter.value !== 'all' || sortOrder.value !== 'recent'));
function resetFilters(): void { query.value = ''; kindFilter.value = 'all'; statusFilter.value = 'all'; sortOrder.value = 'recent'; }
const page = ref(1);
const pageSize = 50;
const reviewBatchSize = 20;
const reviewQueue = ref<VocabularyEntry[]>([]);
const reviewIndex = ref(0);
const reviewAnswerVisible = ref(false);
const reviewStarted = ref(false);
const reviewStats = ref({ reviewed: 0, good: 0, again: 0 });
const toastMessage = ref('');
const undoTickets = shallowRef<VocabularyUndoTicket[]>([]);
let undoReadEpoch = 0;
let undoRefreshPending = false;
let undoReadsInFlight = 0;
const moreMenu = ref<HTMLDetailsElement | null>(null);
const currentTime = ref(Date.now());
const lifecycle = createVocabularyLifecycleGuard();
const playingEntryId = ref('');
const speechPhase = ref<'idle' | 'requesting' | 'playing'>('idle');
const speechController = createSelectionTtsContentController({
  createClientRequestId: () => createSelectionTtsClientRequestId(),
  stopRemote: clientRequestId => browser.runtime.sendMessage({type: 'selectionTtsStop', clientRequestId}),
});
let entryAudio: HTMLAudioElement | null = null;
let entryAudioUrl = '';
let entryAudioContext: AudioContext | null = null;
let entryAudioSource: AudioBufferSourceNode | null = null;
let entryUtterance: SpeechSynthesisUtterance | null = null;
let speechRequestGeneration = 0;
let entrySpeechWatchdog: number | null = null;
let toastTimer: number | null = null;
let timeRefreshTimer: number | null = null;
let darkMedia: MediaQueryList | null = null;
let loadRequestGeneration = 0;
let completedLoadGeneration = 0;
let loadLoopPromise: Promise<void> | null = null;
let configured = false;
let readEpoch = 0;

const reviewActive = computed(() => reviewStarted.value);
const reviewSessionProgress = computed(() => vocabularyReviewSessionProgress(reviewSessionState()));
const currentReview = computed(() => reviewSessionProgress.value.current);
const reviewTotal = computed(() => reviewSessionProgress.value.total);
const reviewPosition = computed(() => reviewSessionProgress.value.position);
const dueEntries = computed(() => entries.value
  .filter(entry => entry.nextReviewAt !== null && entry.nextReviewAt <= currentTime.value)
  .sort((left, right) => (left.nextReviewAt || 0) - (right.nextReviewAt || 0)));
const reviewPlan = computed(() => {
  const scheduled = dueEntries.value.filter(entry => entry.status !== 'new').slice(0, reviewBatchSize);
  const fresh = dueEntries.value
    .filter(entry => entry.status === 'new')
    .slice(0, Math.min(10, reviewBatchSize - scheduled.length));
  return [...scheduled, ...fresh];
});
const statusCounts = computed(() => entries.value.reduce((counts, entry) => {
  counts[entry.status] += 1;
  return counts;
}, { new: 0, learning: 0, familiar: 0, mastered: 0 }));
const orderedEntries = computed(() => {
  const filtered = entries.value.filter(entry => {
    if (kindFilter.value === 'sentence' && !isVocabularySentence(entry)) return false;
    if (kindFilter.value === 'expression' && isVocabularySentence(entry)) return false;
    if (statusFilter.value === 'due' && !(entry.nextReviewAt !== null && entry.nextReviewAt <= currentTime.value)) return false;
    if (statusFilter.value !== 'all' && statusFilter.value !== 'due' && entry.status !== statusFilter.value) return false;
    return true;
  });
  return filtered.sort((left, right) => {
    if (sortOrder.value === 'term') return left.normalizedTerm.localeCompare(right.normalizedTerm);
    if (sortOrder.value === 'recent') return right.lastSeenAt - left.lastSeenAt;
    return (left.nextReviewAt ?? Number.MAX_SAFE_INTEGER) - (right.nextReviewAt ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt;
  });
});
function entrySearchText(entry: VocabularyEntry): string {
  return [
    entry.term,
    entry.normalizedTerm,
    entry.note || '',
    ...Object.values(entry.translations).map(item => item.text),
    ...entry.contexts.map(context => `${context.text} ${context.pageTitle || ''}`),
  ].join(' ').toLocaleLowerCase();
}
// 只限制额外保留的小写文本，不限制可搜索的数据。UTF-16 文本载荷最多约 8 MiB，Map 自身另计。
const SEARCH_INDEX_CHARACTER_LIMIT = 4 * 1024 * 1024;
const searchActive = computed(() => Boolean(query.value));
const searchIndex = computed(() => {
  const indexed = new Map<VocabularyEntry, string>();
  if (!searchActive.value) return indexed;
  let remaining = SEARCH_INDEX_CHARACTER_LIMIT;
  for (const entry of orderedEntries.value) {
    if (remaining === 0) break;
    const text = entrySearchText(entry);
    if (text.length > remaining) break;
    indexed.set(entry, text);
    remaining -= text.length;
  }
  return indexed;
});
const filteredEntries = computed(() => {
  const keyword = query.value.toLocaleLowerCase();
  // 空搜索也读取空索引，释放上一次搜索保留的文本和词条引用；非空输入仅依赖布尔态。
  const indexed = searchIndex.value;
  if (!keyword) return orderedEntries.value;
  return orderedEntries.value.filter(entry => (indexed.get(entry) ?? entrySearchText(entry)).includes(keyword));
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredEntries.value.length / pageSize)));
const pagedEntries = computed(() => filteredEntries.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const currentClozeContext = computed(() => currentReview.value ? vocabularyReviewCloze(currentReview.value) : '');
watch([() => currentReview.value?.id, () => currentReview.value?.updatedAt], () => { recallDraft.value = ''; });
watch(selectedEntryId, () => stopEntrySpeech());
function openStudy(entry: VocabularyEntry): void {
  finishReview();
  selectedEntryId.value = entry.id;
}


watch([query, statusFilter, sortOrder, kindFilter], () => { page.value = 1; });
watch(pageCount, count => { if (page.value > count) page.value = count; });
watch([query, statusFilter, sortOrder, kindFilter, page, reviewStarted], () => stopEntrySpeech());
watch(entries, items => { if (playingEntryId.value && !items.some(entry => entry.id === playingEntryId.value)) stopEntrySpeech(); });

function releaseEntryAudio(): void {
  if (entryAudioSource) { try { entryAudioSource.stop(); } catch { /* 音源可能已经结束 */ } entryAudioSource.disconnect(); entryAudioSource = null; }
  if (entryAudio) { entryAudio.pause(); entryAudio.removeAttribute('src'); entryAudio = null; }
  if (entryAudioUrl) URL.revokeObjectURL(entryAudioUrl);
  entryAudioUrl = '';
}

function prepareEntryAudioContext(): AudioContext | null {
  try {
    if (!entryAudioContext || entryAudioContext.state === 'closed') entryAudioContext = new window.AudioContext();
    // 必须在用户点击的同步调用栈内 resume；合成网络请求完成后再创建上下文会失去手势授权。
    void entryAudioContext.resume().catch(() => undefined);
    return entryAudioContext;
  } catch { return null; }
}

async function playEntryAudioBytes(bytes: Uint8Array, contentType: string, generation: number, fallback: 'google' | 'browser' = 'google'): Promise<'playing' | 'stale' | 'fallback'> {
  if (generation !== speechRequestGeneration) return 'stale';
  if (entryAudioContext && entryAudioContext.state !== 'closed') {
    await entryAudioContext.resume();
    if (generation !== speechRequestGeneration) return 'stale';
    const encoded = new Uint8Array(bytes.byteLength);
    encoded.set(bytes);
    const buffer = await entryAudioContext.decodeAudioData(encoded.buffer as ArrayBuffer);
    if (generation !== speechRequestGeneration) return 'stale';
    const source = entryAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(entryAudioContext.destination);
    source.onended = () => { if (entryAudioSource === source) stopEntrySpeech(false); };
    entryAudioSource = source;
    source.start();
    speechPhase.value = 'playing';
    return 'playing';
  }
  const audioUrl = URL.createObjectURL(new Blob([bytes], {type: contentType || 'audio/mpeg'}));
  entryAudioUrl = audioUrl;
  const audio = new Audio(audioUrl);
  entryAudio = audio;
  audio.onended = () => { if (entryAudio === audio) stopEntrySpeech(false); };
  let failureHandled = false;
  const handleFailure = (cause: unknown): void => {
    if (failureHandled || entryAudio !== audio || generation !== speechRequestGeneration) return;
    failureHandled = true;
    const entry = entries.value.find(item => item.id === playingEntryId.value);
    if (!entry) { stopEntrySpeech(false); return; }
    // 同一次播放的 error 事件和 play() 拒绝共享一次交接；Google 音频失败后直接进入浏览器回退。
    if (fallback === 'browser') speakEntryWithBrowser(entry, generation, speechErrorText(cause));
    else void fallbackEntrySpeech(entry, generation, speechErrorText(cause));
  };
  audio.onerror = () => handleFailure(new Error(t('learning.collection.speechPageAudioNotStarted')));
  try { await audio.play(); } catch (cause) { handleFailure(cause); }
  if (failureHandled) return 'fallback';
  if (generation !== speechRequestGeneration || entryAudio !== audio) return 'stale';
  speechPhase.value = 'playing';
  return 'playing';
}

function stopEntrySpeech(notifyRemote = true): void {
  speechRequestGeneration += 1;
  if (entrySpeechWatchdog !== null) window.clearTimeout(entrySpeechWatchdog);
  entrySpeechWatchdog = null;
  speechController.stop(notifyRemote);
  releaseEntryAudio();
  if (entryUtterance && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  entryUtterance = null;
  playingEntryId.value = '';
  speechPhase.value = 'idle';
}

function speakEntryWithBrowser(entry: VocabularyEntry, generation = speechRequestGeneration, failureContext = ''): boolean {
  if (generation !== speechRequestGeneration) return false;
  if (entryUtterance) return true;
  if (normalizeLocalTtsMode(runtimeConfig.selectionTtsMode) === 'local-only') {
    stopEntrySpeech(false); showToast('本地语音生成失败，请重试'); return false;
  }
  // 远端失败后的结束消息或 page.play 的迟到拒绝不能再停止或重复当前浏览器回退。
  speechController.stop(false);
  releaseEntryAudio();
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    stopEntrySpeech(false);
    showToast('当前环境无法朗读，请稍后重试。'); return false;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(entry.term);
    utterance.lang = normalizeSpeechLanguage(entry.sourceLanguage);
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => voice.lang.toLowerCase() === utterance.lang.toLowerCase()) ?? null;
    utterance.onstart = () => {
      if (entryUtterance !== utterance) return;
      speechPhase.value = 'playing';
      if (entrySpeechWatchdog !== null) window.clearTimeout(entrySpeechWatchdog);
      entrySpeechWatchdog = null;
    };
    utterance.onend = () => { if (entryUtterance === utterance) stopEntrySpeech(false); };
    utterance.onerror = event => {
      if (entryUtterance === utterance) {
        stopEntrySpeech(false);
        showToast(t('learning.collection.speechBrowserStartFailed', {
          error: event.error ? `：${event.error}` : '', details: failureContext ? `；${failureContext}` : '',
        }), false, 10000);
      }
    };
    entryUtterance = utterance;
    playingEntryId.value = entry.id;
    window.speechSynthesis.speak(utterance);
    entrySpeechWatchdog = window.setTimeout(() => {
      if (entryUtterance !== utterance) return;
      window.speechSynthesis.cancel();
      entryUtterance = null;
      playingEntryId.value = '';
      entrySpeechWatchdog = null;
      showToast(t('learning.collection.speechBrowserNotStarted', {details: failureContext ? `；${failureContext}` : ''}), false, 10000);
    }, 8000);
    return true;
  } catch (cause) { if (generation === speechRequestGeneration) { entryUtterance = null; playingEntryId.value = ''; showToast(t('learning.collection.speechBrowserCallFailed', {
    error: speechErrorText(cause), details: failureContext ? `；${failureContext}` : '',
  }), false, 10000); } return false; }
}

function speechErrorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause || '未知错误');
}

async function toggleEntrySpeech(entry: VocabularyEntry): Promise<void> {
  const wasPlaying = playingEntryId.value === entry.id;
  stopEntrySpeech();
  if (wasPlaying) return;
  prepareEntryAudioContext();
  const generation = speechRequestGeneration;
  playingEntryId.value = entry.id;
  speechPhase.value = 'requesting';
  const remote = speechController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({type: 'selectionTts', text: entry.term, language: normalizeSpeechLanguage(entry.sourceLanguage), clientRequestId: remote.clientRequestId}) as {success?: boolean; transport?: 'offscreen' | 'page'; audioBase64?: string; contentType?: string; error?: string; errorCode?: string};
    const result = speechController.completeRemoteRequest(remote, response);
    if (result === 'stale' || generation !== speechRequestGeneration) return;
    if (result === 'offscreen') { speechPhase.value = 'playing'; return; }
    if (result === 'failed' || !response.audioBase64) {
      const primaryError = response.error && !/取消|已取消|aborted|cancelled/iu.test(response.error) ? response.error : t('learning.collection.speechOnlineNoAudio');
      await fallbackEntrySpeech(entry, generation, primaryError);
      return;
    }
    const binary = atob(response.audioBase64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    await playEntryAudioBytes(bytes, response.contentType || 'audio/mpeg', generation);
  } catch (cause) {
    const current = speechController.rejectRemoteRequest(remote);
    if (current && generation === speechRequestGeneration) await fallbackEntrySpeech(entry, generation,
      t('learning.collection.speechOnlineRequestFailed', {error: speechErrorText(cause)}));
  }
}

async function fallbackEntrySpeech(entry: VocabularyEntry, generation: number, primaryError = ''): Promise<void> {
  if (normalizeLocalTtsMode(runtimeConfig.selectionTtsMode) === 'local-only') {
    if (generation === speechRequestGeneration) {
      stopEntrySpeech(false);
      showToast(primaryError || t('learning.collection.speechFailed'), false, 10000);
    }
    return;
  }
  const googleError = await speakEntryWithGoogle(entry, generation);
  if (googleError === null || generation !== speechRequestGeneration) return;
  const failureContext = [primaryError ? t('learning.collection.speechOnlineSynthesis', {error: primaryError}) : '',
    t('learning.collection.speechGoogleFallback', {error: googleError})].filter(Boolean).join('；');
  if (!speakEntryWithBrowser(entry, generation, failureContext)) {
    showToast(t('learning.collection.speechFailedDetail', {details: failureContext}), false, 10000);
  }
}

async function speakEntryWithGoogle(entry: VocabularyEntry, generation: number): Promise<string | null> {
  if (generation !== speechRequestGeneration) return t('learning.collection.speechCancelled');
  releaseEntryAudio();
  const remote = speechController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({type: 'selectionTtsGoogle', text: entry.term,
      language: normalizeSpeechLanguage(entry.sourceLanguage), clientRequestId: remote.clientRequestId}) as {success?: boolean; transport?: 'offscreen' | 'page'; audioBase64?: string; contentType?: string; error?: string};
    const result = speechController.completeRemoteRequest(remote, response);
    if (generation !== speechRequestGeneration) return t('learning.collection.speechCancelled');
    if (result === 'offscreen') { playingEntryId.value = entry.id; speechPhase.value = 'playing'; return null; }
    if (result === 'stale') return t('learning.collection.speechCancelled');
    if (result === 'page' && response.audioBase64) {
      const binary = atob(response.audioBase64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const playback = await playEntryAudioBytes(bytes, response.contentType || 'audio/mpeg', generation, 'browser');
      return playback === 'stale' ? t('learning.collection.speechCancelled') : null;
    }
    return response.error || t('learning.collection.speechGoogleNoAudio');
  } catch (cause) {
    speechController.rejectRemoteRequest(remote);
    return speechErrorText(cause);
  }
}

function handleEntrySpeechState(message: unknown): undefined {
  const state = speechController.matchRemoteState(message);
  if (state === 'error') {
    const entry = entries.value.find(item => item.id === playingEntryId.value);
    if (entry) speakEntryWithBrowser(entry);
    else stopEntrySpeech(false);
  } else if (state === 'ended' || state === 'stopped') stopEntrySpeech(false);
  return undefined;
}

async function requestVocabulary<T>(request: VocabularyBookRequest): Promise<T> {
  const response = await browser.runtime.sendMessage(request) as VocabularyBookResponse<T>;
  if (!response?.success) throw Object.assign(new Error(response?.error?.message || '单词本操作失败'), {code: response?.error?.code});
  return response.data;
}

function applyTheme(): void {
  const dark = runtimeConfig.theme === 'dark'
    || (runtimeConfig.theme === 'auto' && Boolean(darkMedia?.matches));
  applyInterfaceTheme(dark);
}

function scheduleTimeRefresh(): void {
  if (timeRefreshTimer !== null) window.clearTimeout(timeRefreshTimer);
  timeRefreshTimer = null;
  if (!lifecycle.isActive() || !configured || !viewVisible.value) return;
  const timestamp = Date.now();
  currentTime.value = timestamp;

  const nearestDueAt = entries.value.reduce((nearest, entry) => {
    if (entry.nextReviewAt === null || entry.nextReviewAt <= timestamp) return nearest;
    return Math.min(nearest, entry.nextReviewAt);
  }, Number.POSITIVE_INFINITY);
  const untilNextMinute = 60_000 - (timestamp % 60_000);
  const untilNearestDue = nearestDueAt - timestamp;
  const delay = Math.max(100, Math.min(untilNextMinute, untilNearestDue));
  timeRefreshTimer = window.setTimeout(scheduleTimeRefresh, delay + 20);
}

function handleVisibilityChange(): void {
  if (!lifecycle.isActive()) return;
  documentVisible.value = document.visibilityState !== 'hidden';
  if (!documentVisible.value) stopEntrySpeech();
}

function canReadEntries(): boolean {
  return lifecycle.isActive() && configured && viewVisible.value && !actionBusy.value;
}

// 暂停不等于卸载：普通读取延后，已接受写入仍通过原来的 lifecycle 接纳结果。
watch(viewVisible, visible => {
  readEpoch += 1;
  scheduleTimeRefresh();
  if (visible && configured) {void loadEntries(); void loadUndoTickets();}
}, {flush: 'sync'});
watch(actionBusy, busy => {
  if (busy) {readEpoch += 1; undoReadEpoch += 1; if (undoReadsInFlight) undoRefreshPending = true;}
  else {void flushPendingEntries(); if (undoRefreshPending) void loadUndoTickets();}
}, {flush: 'sync'});

async function loadEntries(): Promise<void> {
  if (!lifecycle.isActive()) return;
  loadRequestGeneration += 1;
  // 隐藏或写入期间只记待办，不能等待未来恢复，否则持有 actionBusy 的保存会自锁。
  if (canReadEntries()) await flushPendingEntries();
}

function flushPendingEntries(): Promise<void> | undefined {
  if (!canReadEntries() || completedLoadGeneration >= loadRequestGeneration) return;
  if (loadLoopPromise) return loadLoopPromise;
  loadLoopPromise = runLoadEntriesLoop().finally(() => {
    loadLoopPromise = null;
    // 覆盖循环退出到 finally 之间的新通知；失败代次已完成，不自动重试失败读取。
    return flushPendingEntries();
  });
  return loadLoopPromise;
}

async function runLoadEntriesLoop(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    while (canReadEntries() && completedLoadGeneration < loadRequestGeneration) {
      const generation = loadRequestGeneration;
      const epoch = readEpoch;
      try {
        const nextEntries = await requestVocabulary<VocabularyEntry[]>({ type: VOCABULARY_BOOK_MESSAGE, action: 'list' });
        if (canReadEntries() && epoch === readEpoch && generation === loadRequestGeneration) {
          entries.value = nextEntries;
          loadError.value = '';
          reconcileActiveReviewQueue();
        }
      } catch (cause) {
        if (canReadEntries() && epoch === readEpoch && generation === loadRequestGeneration) {
          loadError.value = cause instanceof Error ? cause.message : '无法读取本地单词本';
        }
      } finally {
        // 跨隐藏或写入的旧响应失效，保留待办，等可见且空闲后串行读取权威快照。
        if (epoch === readEpoch) completedLoadGeneration = generation;
      }
    }
  } finally {
    if (lifecycle.isActive()) {
      loading.value = false;
      scheduleTimeRefresh();
    }
  }
}

async function setBetaEnabled(enabled: boolean): Promise<void> {
  if (!lifecycle.isActive() || configBusy.value) return;
  configBusy.value = true;
  betaEnabled.value = enabled;
  try {
    await requestConfigPatch({vocabularyBookEnabled: enabled}, browser.runtime.sendMessage.bind(browser.runtime));
    showToast(enabled ? t('learning.collection.enabled') : '收藏入口已关闭，学习数据仍保留');
  } catch (cause) {
    if (!lifecycle.isActive()) return;
    betaEnabled.value = runtimeConfig.vocabularyBookEnabled === true;
    showToast(cause instanceof Error ? cause.message : '设置保存失败');
  } finally {
    if (lifecycle.isActive()) configBusy.value = false;
  }
}

async function setReencounterEnabled(enabled: boolean): Promise<void> {
  if (!lifecycle.isActive() || configBusy.value) return;
  configBusy.value = true; reencounterEnabled.value = enabled;
  try {
    await requestConfigPatch({vocabularyReencounterEnabled: enabled}, browser.runtime.sendMessage.bind(browser.runtime));
  } catch (cause) {
    if (!lifecycle.isActive()) return;
    reencounterEnabled.value = runtimeConfig.vocabularyReencounterEnabled === true;
    showToast(cause instanceof Error ? cause.message : t('reencounter.settingFailed'));
  } finally { if (lifecycle.isActive()) configBusy.value = false; }
}

function replaceEntry(next: VocabularyEntry): void {
  // 学习详情独立保存也会更新词条；拒绝保存前已经发出的列表响应。
  readEpoch += 1;
  const index = entries.value.findIndex(entry => entry.id === next.id);
  if (index < 0) entries.value = [next, ...entries.value];
  else entries.value.splice(index, 1, next);
  scheduleTimeRefresh();
}

function reviewSessionState(): VocabularyReviewSessionState {
  return {
    queue: reviewQueue.value,
    completed: reviewIndex.value,
    answerVisible: reviewAnswerVisible.value,
  };
}

function applyReviewSession(session: VocabularyReviewSessionState): void {
  reviewQueue.value = session.queue;
  reviewIndex.value = session.completed;
  reviewAnswerVisible.value = session.answerVisible;
}

function reconcileActiveReviewQueue(): void {
  if (!reviewActive.value || actionBusy.value) return;
  applyReviewSession(reconcileVocabularyReviewSession(
    reviewSessionState(),
    entries.value,
    Date.now(),
  ));
}

function startReview(): void {
  applyReviewSession(createVocabularyReviewSession(reviewPlan.value));
  reviewStats.value = { reviewed: 0, good: 0, again: 0 };
  reviewStarted.value = reviewQueue.value.length > 0;
}

function finishReview(): void {
  reviewStarted.value = false;
  applyReviewSession(createVocabularyReviewSession([]));
}

async function rateReview(rating: VocabularyScheduledReviewRating): Promise<void> {
  const entry = currentReview.value;
  if (!lifecycle.isActive() || !entry || actionBusy.value || !reviewAnswerVisible.value) return;
  actionBusy.value = true;
  try {
    const result = await requestVocabulary<VocabularyReviewResult>({
      type: VOCABULARY_BOOK_MESSAGE,
      action: 'review',
      entryId: entry.id,
      rating,
    });
    if (!lifecycle.isActive()) return;
    replaceEntry(result.entry);
    reviewStats.value.reviewed += 1;
    reviewStats.value[rating] += 1;
    applyReviewSession(advanceVocabularyReviewSession(reviewSessionState(), entry.id));
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : '复习记录保存失败');
  } finally {
    if (lifecycle.isActive()) {
      try {
        await loadEntries();
      } finally {
        if (lifecycle.isActive()) {
          actionBusy.value = false;
          reconcileActiveReviewQueue();
        }
      }
    }
  }
}

async function setMastered(entry: VocabularyEntry): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const result = await requestVocabulary<VocabularyReviewResult>({ type: VOCABULARY_BOOK_MESSAGE, action: 'setMastery', entryId: entry.id });
    if (!lifecycle.isActive()) return;
    replaceEntry(result.entry);
    showToast(`${entry.term} 已标记为掌握`);
  } catch (cause) { showToast(cause instanceof Error ? cause.message : '更新失败'); }
  finally { if (lifecycle.isActive()) actionBusy.value = false; }
}

async function relearn(entry: VocabularyEntry): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const result = await requestVocabulary<VocabularyReviewResult>({ type: VOCABULARY_BOOK_MESSAGE, action: 'relearn', entryId: entry.id });
    if (!lifecycle.isActive()) return;
    replaceEntry(result.entry);
    showToast(`${entry.term} 已回到学习队列`);
  } catch (cause) { showToast(cause instanceof Error ? cause.message : '更新失败'); }
  finally { if (lifecycle.isActive()) actionBusy.value = false; }
}

function isUndoTicket(value: unknown): value is VocabularyUndoTicket {
  if (!value || typeof value !== 'object') return false;
  const ticket = value as Partial<VocabularyUndoTicket>;
  return typeof ticket.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(ticket.id)
    && typeof ticket.term === 'string' && ticket.term.length > 0
    && typeof ticket.createdAt === 'number' && Number.isFinite(ticket.createdAt)
    && typeof ticket.expiresAt === 'number' && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > ticket.createdAt;
}

async function loadUndoTickets(): Promise<void> {
  if (!lifecycle.isActive()) return;
  if (!viewVisible.value || actionBusy.value) {undoRefreshPending = true; undoReadEpoch += 1; return;}
  undoRefreshPending = false;
  const epoch = ++undoReadEpoch;
  undoReadsInFlight += 1;
  try {
    const tickets = await requestVocabulary<VocabularyUndoTicket[]>({type: VOCABULARY_BOOK_MESSAGE, action: 'listUndo'});
    if (!Array.isArray(tickets) || !tickets.every(isUndoTicket)) throw new Error('invalid tickets');
    if (lifecycle.isActive() && viewVisible.value && !actionBusy.value && epoch === undoReadEpoch) undoTickets.value = tickets;
  } catch {
    if (lifecycle.isActive() && epoch === undoReadEpoch) showToast(t('learning.collection.undoListFailed'));
  } finally {
    undoReadsInFlight -= 1;
    if (undoRefreshPending && lifecycle.isActive() && viewVisible.value && !actionBusy.value) void loadUndoTickets();
  }
}

async function removeEntry(entry: VocabularyEntry): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  actionBusy.value = true;
  undoReadEpoch += 1;
  let requested = false;
  try {
    try { await ElMessageBox.confirm(translateLegacyText(
      t('learning.collection.deleteConfirm', {term: entry.term, notice: t(isUserscriptBuild ? 'learning.collection.undoScriptNotice' : 'learning.collection.undoExtensionNotice')}), normalizeUiLanguage(runtimeConfig.uiLanguage)),
      translateControlLabel('删除'), {type: 'warning', confirmButtonText: translateControlLabel('删除'), cancelButtonText: translateControlLabel('取消')}); }
    catch { return; }
    if (!lifecycle.isActive()) return;
    requested = true;
    const ticket = await requestVocabulary<VocabularyUndoTicket | null>({type: VOCABULARY_BOOK_MESSAGE, action: 'removeWithUndo', entryId: entry.id});
    if (!lifecycle.isActive()) return;
    if (ticket === null) {showToast(t('learning.collection.entryMissing')); return;}
    if (!isUndoTicket(ticket)) throw new Error('invalid ticket');
    entries.value = entries.value.filter(item => item.id !== entry.id);
    undoTickets.value = [ticket, ...undoTickets.value.filter(item => item.id !== ticket.id)];
    scheduleTimeRefresh();
    showToast(t('learning.collection.deletedRecoverable', {term:entry.term}));
  } catch (cause) {
    if (lifecycle.isActive()) showToast(cause instanceof Error && 'code' in cause && cause.code === 'limit-exceeded' ? t('learning.collection.undoCapacity') : t('learning.collection.deleteUnconfirmed'));
  } finally {
    if (lifecycle.isActive()) {
      actionBusy.value = false;
      if (requested) {void loadEntries(); void loadUndoTickets();}
    }
  }
}

async function undoRemove(ticket: VocabularyUndoTicket): Promise<void> {
  if (!lifecycle.isActive() || !ticket || actionBusy.value) return;
  actionBusy.value = true;
  undoReadEpoch += 1;
  try {
    const result = await requestVocabulary<'restored' | 'previously-restored' | 'expired' | 'missing'>({type: VOCABULARY_BOOK_MESSAGE, action: 'restoreUndo', undoId: ticket.id});
    if (!lifecycle.isActive()) return;
    if (result !== 'restored' && result !== 'previously-restored' && result !== 'expired' && result !== 'missing') throw new Error('unknown result');
    undoTickets.value = undoTickets.value.filter(item => item.id !== ticket.id);
    showToast(result === 'restored' ? t('learning.collection.deletedRestored') : result === 'previously-restored' ? t('learning.collection.restorePreviously') : t('learning.collection.restoreExpired'));
  } catch (cause) {
    if (lifecycle.isActive()) showToast(cause instanceof Error && 'code' in cause && cause.code === 'invalid-input' ? t('learning.collection.restoreConflict') : cause instanceof Error && 'code' in cause && cause.code === 'limit-exceeded' ? t('learning.collection.restoreCapacity') : t('learning.collection.undoUnconfirmed'));
  } finally {
    if (lifecycle.isActive()) {actionBusy.value = false; void loadEntries();}
  }
}

async function discardUndo(ticket: VocabularyUndoTicket): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  actionBusy.value = true;
  undoReadEpoch += 1;
  try {
    const discarded = await requestVocabulary<boolean>({type: VOCABULARY_BOOK_MESSAGE, action: 'discardUndo', undoId: ticket.id});
    if (!lifecycle.isActive()) return;
    if (discarded !== true) throw new Error('unknown discard result');
    undoTickets.value = undoTickets.value.filter(item => item.id !== ticket.id);
    showToast(t('learning.collection.undoDiscarded'));
  } catch (cause) {
    if (lifecycle.isActive()) showToast(cause instanceof Error && 'code' in cause && cause.code === 'invalid-input' ? t('learning.collection.undoBusy') : t('learning.collection.discardUnconfirmed'));
  } finally {
    if (lifecycle.isActive()) {actionBusy.value = false; void loadUndoTickets();}
  }
}

async function chooseAnkiContext(): Promise<boolean | null> {
  try {
    await ElMessageBox.confirm(
      '默认不导出收藏时的网页片段和来源。这些内容可能包含浏览隐私。',
      '导出到 Anki',
      {
        confirmButtonText: '不包含',
        cancelButtonText: '包含上下文',
        distinguishCancelAndClose: true,
        type: 'warning',
      },
    );
    return false;
  } catch (action) {
    return action === 'cancel' ? true : null;
  }
}

async function exportAnki(): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const includePrivateContext = await chooseAnkiContext();
    if (!lifecycle.isActive() || includePrivateContext === null) return;
    await closeMoreMenuAndFocus();
    if (!lifecycle.isActive()) return;
    const data = await requestVocabulary<VocabularyBookExport>({
      type: VOCABULARY_BOOK_MESSAGE,
      action: 'exportData',
      options: {includePrivateContext},
    });
    if (!lifecycle.isActive()) return;
    const rows = data.entries.map(entry => {
      const context = includePrivateContext ? entry.contexts.at(-1) : undefined;
      const source = vocabularySourceLink(context);
      return [
        entry.term,
        entryTranslation(entry),
        entry.note || '',
        context?.text || '',
        source.href || (source.timeLabel ? `${context?.pageTitle || '视频'} · ${source.timeLabel}` : ''),
        `fluentread ${entry.status}`,
      ];
    });
    const body = buildAnkiTsv(['Term', 'Meaning', 'Explanation', 'Context', 'Source', 'Tags'], rows);
    downloadFile(
      `fluentread-anki-${new Date().toISOString().slice(0, 10)}.tsv`,
      `\uFEFF${body}`,
      'text/tab-separated-values;charset=utf-8',
    );
    showToast(`已导出 ${rows.length} 个 Anki 词条`);
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : 'Anki 导出失败');
  } finally {
    if (lifecycle.isActive()) actionBusy.value = false;
  }
}

async function copyEntry(entry: VocabularyEntry, bilingual: boolean): Promise<void> {
  if (!lifecycle.isActive()) return;
  const paired = bilingual && hasDistinctTranslation(entry.term, entryTranslation(entry));
  const text = paired ? `${entry.term}\n${entryTranslation(entry)}` : entry.term;
  try {await navigator.clipboard.writeText(text); if (lifecycle.isActive()) showToast(paired ? '已复制原文与译文' : '已复制原文');}
  catch {if (lifecycle.isActive()) showToast('复制失败，可以选中原文后复制');}
}

async function exportCollection(): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value) return;
  const ids = new Set(filteredEntries.value.map(entry => entry.id));
  actionBusy.value = true;
  try {
    const data = await requestVocabulary<VocabularyBookExport>({type:VOCABULARY_BOOK_MESSAGE, action:'exportData', options:{includePrivateContext:false}});
    if (!lifecycle.isActive()) return;
    data.entries = data.entries.filter(entry => ids.has(entry.id));
    data.reviewLogs = data.reviewLogs.filter(log => ids.has(log.entryId));
    downloadFile(`fluentread-collection-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    showToast(`已导出 ${data.entries.length} 条收藏，包含译文、解释和复习记录`);
  } catch (cause) {if (lifecycle.isActive()) showToast(cause instanceof Error ? cause.message : '收藏导出失败');}
  finally {if (lifecycle.isActive()) actionBusy.value = false;}
}

async function importCollection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!lifecycle.isActive() || !file || actionBusy.value) return;
  actionBusy.value = true;
  try {
    if (vocabularyImportNeedsConfirmation(file.size)) {
      try {await ElMessageBox.confirm('这个收藏文件较大，读取可能需要一些时间。继续导入吗？', '导入收藏', {confirmButtonText:'继续导入', cancelButtonText:'取消'});} catch {return;}
    }
    if (!lifecycle.isActive()) return;
    const data = JSON.parse(await file.text());
    if (!lifecycle.isActive()) return;
    const result = await requestVocabulary<VocabularyImportResult>({type:VOCABULARY_BOOK_MESSAGE, action:'importData', data});
    if (!lifecycle.isActive()) return;
    await loadEntries();
    showToast(`已导入：新增 ${result.inserted} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条`);
  } catch (cause) {if (lifecycle.isActive()) showToast(cause instanceof SyntaxError ? t('learning.collection.fileReadFailed') : cause instanceof Error ? cause.message : '收藏导入失败');}
  finally {if (lifecycle.isActive()) actionBusy.value = false;}
}

async function clearVocabulary(): Promise<void> {
  if (!lifecycle.isActive() || actionBusy.value || (entries.value.length === 0 && undoTickets.value.length === 0)) return;
  actionBusy.value = true;
  try {
    try {
      await ElMessageBox.confirm(
        `${t('learning.collection.clearHelp')} ${t('learning.collection.clearUndoNotice')}`,
        t('learning.collection.clearTitle'),
        {confirmButtonText: '确认清空', cancelButtonText: '取消', type: 'warning'},
      );
    } catch {
      return;
    }
    if (!lifecycle.isActive()) return;
    await closeMoreMenuAndFocus();
    if (!lifecycle.isActive()) return;
    await requestVocabulary<boolean>({type: VOCABULARY_BOOK_MESSAGE, action: 'clear'});
    if (!lifecycle.isActive()) return;
    entries.value = [];
    undoReadEpoch += 1;
    undoTickets.value = [];
    finishReview();
    scheduleTimeRefresh();
    showToast(t('learning.collection.cleared'));
  } catch (cause) {
    showToast(cause instanceof Error && 'code' in cause && cause.code === 'invalid-input' ? t('learning.collection.undoBusy') : cause instanceof Error ? cause.message : '清空失败');
  } finally {
    if (lifecycle.isActive()) actionBusy.value = false;
  }
}

async function closeMoreMenuAndFocus(): Promise<void> {
  const details = moreMenu.value;
  if (!lifecycle.isActive() || !details) return;
  const visible = viewVisible.value, epoch = readEpoch;
  details.open = false;
  await nextTick();
  if (visible && viewVisible.value && epoch === readEpoch && lifecycle.isActive() && details.isConnected && moreMenu.value === details) details.querySelector<HTMLElement>('summary')?.focus();
}



function entryTranslation(entry: Pick<VocabularyEntry, 'translations'>): string {
  const preferred = entry.translations[targetLanguageKey.value];
  if (preferred?.text) return preferred.text;
  return Object.values(entry.translations).sort((left, right) => right.updatedAt - left.updatedAt)[0]?.text || '';
}
function latestContext(entry: VocabularyEntry): VocabularyContext | undefined { return entry.contexts[entry.contexts.length - 1]; }
function statusLabel(status: VocabularyStatus): string { return ({ new: '新词', learning: '学习中', familiar: '熟悉', mastered: '已掌握' })[status]; }
function nextReviewLabel(entry: VocabularyEntry): string {
  if (entry.nextReviewAt === null) return '未安排复习';
  const delta = entry.nextReviewAt - currentTime.value;
  if (delta <= 0) return '现在可以复习';
  if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.ceil(delta / 60000))} 分钟后`;
  if (delta < 24 * 60 * 60 * 1000) return `${Math.ceil(delta / 3600000)} 小时后`;
  return t('learning.dueDays', {count: Math.ceil(delta / 86400000)});
}
function normalizeLanguageKey(value: unknown): string {
  const normalized = String(value ?? '').trim().replaceAll('_', '-').toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : '';
}
function goodIntervalLabel(entry: VocabularyEntry): string {
  return ['1 天后', '1 天后', '3 天后', '7 天后', '14 天后', '30 天后'][Math.min(5, entry.masteryLevel + 1)] || '30 天后';
}
function showToast(message: string, _keepUndo = false, durationMs = _keepUndo ? 5000 : 2600): void {
  if (!lifecycle.isActive()) return;
  toastMessage.value = message;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = durationMs > 0 ? window.setTimeout(() => {toastMessage.value = '';}, durationMs) : null;
}

function handleVocabularyFocus(): void {
  if (lifecycle.isActive() && viewVisible.value && configured) {void loadEntries(); void loadUndoTickets();}
}

function handleBookChanged(message: unknown): undefined {
  if (lifecycle.isActive() && (message as VocabularyBookChangedMessage)?.type === VOCABULARY_BOOK_CHANGED_MESSAGE) {void loadEntries(); void loadUndoTickets();}
  return undefined;
}
// 缓存保留复习会话与已接受的保存，只有当前显示的页面处理全局复习按键。
onActivated(() => { keptAliveVisible.value = true; });
onDeactivated(() => { keptAliveVisible.value = false; });
function handleReviewKeyboard(event: KeyboardEvent): void {
  if (!viewVisible.value || !lifecycle.isActive() || !reviewActive.value || actionBusy.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches('input, textarea, select, button, a')) return;
  if (event.key === 'Escape') { event.preventDefault(); finishReview(); return; }
  if (event.code === 'Space' && currentReview.value && !reviewAnswerVisible.value) {
    event.preventDefault(); reviewAnswerVisible.value = true; return;
  }
  if (!reviewAnswerVisible.value) return;
  if (event.key === '1') { event.preventDefault(); void rateReview('again'); }
  if (event.key === '2') { event.preventDefault(); void rateReview('good'); }
}

let unsubscribeConfig: (() => void) | null = null;
onMounted(async () => {
  documentVisible.value = document.visibilityState !== 'hidden';
  darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  darkMedia.addEventListener('change', applyTheme);
  await lifecycle.runAfterReady(configReady, async () => {
    betaEnabled.value = runtimeConfig.vocabularyBookEnabled;
    reencounterEnabled.value = runtimeConfig.vocabularyReencounterEnabled;
    selectionTranslatorEnabled.value = runtimeConfig.selectionTranslatorMode !== 'disabled' || runtimeConfig.harness?.enabled === true;
    targetLanguageKey.value = normalizeLanguageKey(runtimeConfig.to);
    applyTheme();
    unsubscribeConfig = subscribeConfig(next => {
      betaEnabled.value = next.vocabularyBookEnabled;
      reencounterEnabled.value = next.vocabularyReencounterEnabled;
      selectionTranslatorEnabled.value = next.selectionTranslatorMode !== 'disabled' || next.harness?.enabled === true;
      targetLanguageKey.value = normalizeLanguageKey(next.to);
      applyTheme();
    });
    browser.runtime.onMessage.addListener(handleBookChanged);
    browser.runtime.onMessage.addListener(handleEntrySpeechState);
    window.addEventListener('keydown', handleReviewKeyboard);
    window.addEventListener('focus', handleVocabularyFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    documentVisible.value = document.visibilityState !== 'hidden';
    configured = true;
    await loadEntries();
    await loadUndoTickets();
  });
});

onBeforeUnmount(() => {
  lifecycle.dispose();
  stopEntrySpeech();
  unsubscribeConfig?.();
  browser.runtime.onMessage.removeListener(handleBookChanged);
  browser.runtime.onMessage.removeListener(handleEntrySpeechState);
  window.removeEventListener('keydown', handleReviewKeyboard);
  window.removeEventListener('focus', handleVocabularyFocus);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  darkMedia?.removeEventListener('change', applyTheme);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  if (timeRefreshTimer !== null) window.clearTimeout(timeRefreshTimer);
  if (entryAudioContext && entryAudioContext.state !== 'closed') void entryAudioContext.close().catch(() => undefined);
});
</script>

<style scoped>
.collection-tools { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.collection-overview { min-width:0; }
.collection-overview h2 { margin:0; color:var(--ink); font-size:18px; font-weight:650; line-height:1.5; }
.collection-overview > span { display:block; margin-top:4px; color:var(--muted); font-size:11px; line-height:1.7; }
.collection-management { display:flex; align-items:center; flex:none; gap:10px; }
.recent-deletions { padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
.recent-deletions-heading h3 { margin:0; color:var(--ink); font-size:12px; font-weight:600; }
.recent-deletions-heading p { margin:4px 0 0; color:var(--muted); font-size:11px; line-height:1.6; }
.recent-deletion-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:10px; }
.recent-deletion-term { min-width:0; color:var(--ink); font-size:12px; overflow-wrap:anywhere; }
.recent-deletion-actions { display:flex; flex:none; gap:4px; }
.recent-deletion-actions button { min-height:30px; padding:0 9px; border:0; border-radius:7px; color:var(--muted); background:transparent; cursor:pointer; font:inherit; font-size:12px; }
.recent-deletion-actions .recent-deletion-restore { color:var(--brand-strong); background:var(--brand-soft); }
.recent-deletion-actions button:hover:not(:disabled) { color:var(--brand-strong); background:var(--brand-soft); }
.recent-deletion-actions button:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.collection-switches { display:grid; gap:4px; padding:4px 0 10px; margin-bottom:6px; border-bottom:1px solid var(--line); }
.collection-switches .vocabulary-saving-control { margin:0; border:0; background:transparent; }
.vocabulary-saving-control :deep(button) { min-height:58px; padding:8px 10px; gap:12px; }
.vocabulary-saving-control :deep(.feature-enable-heading) { min-height:0; }
.vocabulary-saving-control :deep(strong) { font-size:12px; font-weight:600; }
.vocabulary-saving-control :deep(.feature-enable-description) { font-size:11px; line-height:1.5; }
.vocabulary-saving-control :deep(i) { width:32px; height:18px; padding:2px; }
.vocabulary-saving-control :deep(b) { width:12px; height:12px; }
.vocabulary-saving-control.enabled :deep(b) { transform:translateX(14px); }
.collection-tools button:focus-visible,.collection-tools summary:focus-visible,.book-filter summary:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.book-filter { position:relative; flex:none; }
.book-filter[open] > summary { color:var(--brand-strong); background:var(--brand-soft); }
.book-filter summary::-webkit-details-marker { display:none; }
.filter-panel { position:absolute; z-index:7; top:calc(100% + 5px); right:0; display:grid; gap:8px; box-sizing:border-box; width:230px; max-width:calc(100vw - 56px); padding:16px; border:1px solid var(--line); border-radius:10px; background:var(--surface); box-shadow:0 10px 28px #1720331a; }
.filter-panel > label { font-size:11px; color:var(--muted); }
.filter-panel > label:not(:first-child) { margin-top:5px; }
.collection-results { display:flex; align-items:center; gap:12px; color:var(--muted); font-size:11px; }
.collection-results button,.reset-filters { padding:0; border:0; background:transparent; color:var(--brand-strong); font:inherit; font-size:11px; cursor:pointer; }
.reset-filters { margin-top:6px; text-align:left; }
.recall-draft { display:block; width:100%; box-sizing:border-box; padding:12px; margin:16px 0; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:var(--surface-soft); font:inherit; resize:vertical; }
.recall-attempt { border-left:2px solid var(--brand); padding-left:12px; white-space:pre-wrap; }
.answer-reference-label { color:var(--muted); font-size:12px; }
.review-answer .study-entry-button { min-height: 32px; margin-top: 10px; padding: 0 11px; border: 1px solid var(--line); border-radius: 8px; color: var(--brand-strong); background: var(--surface-soft); cursor: pointer; font: inherit; font-size: 11px; }
.vocabulary-book { position: relative; display: grid; gap: 12px; color: var(--ink); }
.selection-reminder { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:0; color:var(--muted); font-size:11px; line-height:1.6; }
.selection-reminder button { flex:none; border:0; padding:0; color:var(--brand-strong); background:transparent; cursor:pointer; font:inherit; }
.start-review { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:36px; padding:0 14px; border:0; border-radius:8px; color:white; background:var(--brand); cursor:pointer; font:inherit; font-size:12px; font-weight:600; }
.start-review:disabled { color:var(--muted); background:var(--surface-soft); cursor:default; }
.book-more { position: relative; }
.book-more summary { display:flex; align-items:center; justify-content:center; gap:5px; min-width:48px; min-height:36px; padding:0 8px; border: 0; border-radius: 8px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; list-style: none; }
.book-more summary::-webkit-details-marker { display: none; }
.book-more[open] summary { border-color: color-mix(in srgb, var(--brand) 32%, var(--line)); color: var(--brand-strong); }
.book-more-menu { position: absolute; z-index: 5; top: calc(100% + 7px); right: 0; display: grid; box-sizing:border-box; width:310px; max-width:calc(100vw - 56px); padding:8px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: 0 12px 30px rgba(31, 40, 61, .14); }
.book-more-menu > button { min-height: 34px; padding: 0 9px; border: 0; border-radius: 8px; color: var(--ink); background: transparent; cursor: pointer; font-size:12px; font-weight:400; text-align:left; }
.book-more-menu > button:hover { color: var(--brand-strong); background: var(--brand-soft); }
.book-more-menu > button.danger { color: var(--fr-danger); }
/* 菜单独立于设置页的大型折叠标题，保留紧凑命中区域和自身图标。 */
.vocabulary-book .collection-tools .collection-management .book-more > summary {min-height:36px; padding:0 8px; margin:0; border:0; background:transparent; font-size:12px; font-weight:400; gap:5px;}
.vocabulary-book .toolbar details.book-filter[name] > summary {display:flex; align-items:center; list-style:none; cursor:pointer; min-height:36px; padding:0 9px; margin:0; border:0; background:transparent; font-size:12px; font-weight:400; gap:6px;}
.vocabulary-book .collection-tools .collection-management .book-more > summary::after,.vocabulary-book .toolbar details.book-filter[name] > summary::after {display:none; content:none;}
.toolbar {display:flex; align-items:center; gap:8px; padding:0; border:0; background:transparent;}
.search-field { flex:1; min-width:0; display: flex; height: 36px; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.search-field span { color: var(--muted); font-size: 17px; }
.collection-type { width:150px; flex:none; }
.search-field input { width: 100%; border: 0; outline: 0; color: var(--ink); background:transparent; font:inherit; font-size:12px; }
.toolbar select { min-width: 0; padding: 0 10px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink); background: var(--surface); font-size: 11px; }
.word-list { display:grid; margin-top:2px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.vocabulary-speak { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 5px; border: 0; border-radius: 7px; background: var(--brand-soft); color: var(--brand-strong); cursor: pointer; }
.vocabulary-speak svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.vocabulary-speak:hover, .vocabulary-speak:focus-visible { background: var(--brand-soft); outline: 2px solid color-mix(in srgb, var(--brand) 32%, var(--line)); outline-offset: 1px; }
.status-pill { display: inline-flex; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.status-new { color: var(--muted); background: var(--surface-soft); }
.status-learning { color: var(--muted); background: var(--surface-soft); }
.status-familiar { color: var(--muted); background: var(--surface-soft); }
.status-mastered { color: var(--muted); background: var(--surface-soft); }
button.danger { color: var(--fr-danger); }
button:disabled { cursor: not-allowed; opacity: .55; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding-top: 7px; }
.pagination button {min-height:30px; padding:0 9px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:var(--surface); cursor:pointer; font-size:12px;}
.pagination span { color: var(--muted); font-size: 11px; }
.eyebrow { display: block; margin-bottom: 5px; color: var(--brand-strong); font-size: 11px; font-weight: 600; letter-spacing: .1em; }
.empty-state { display: grid; min-height: 210px; place-items: center; align-content: center; gap: 7px; padding: 30px; border: 1px solid var(--line); border-radius: 14px; color: var(--muted); background: var(--surface-soft); text-align: center; }
.empty-state .empty-secondary { border:0; background:transparent; color:var(--muted); font-weight:400; }
.empty-state > span { font-size: 28px; }
.empty-state h3, .empty-state p { margin: 0; }
.empty-state h3 { color: var(--ink); font-size: 14px; }
.empty-state p { max-width: 420px; font-size: 11px; line-height: 1.55; }
.empty-state button { min-height: 32px; margin-top: 3px; padding: 0 11px; border: 1px solid color-mix(in srgb, var(--brand) 32%, var(--line)); border-radius: 9px; color: var(--brand-strong); background: var(--surface); cursor: pointer; font-size: 11px; font-weight: 600; }
.loading-ring { width: 24px; height: 24px; border: 2px solid color-mix(in srgb, var(--brand) 32%, var(--line)); border-top-color: var(--brand); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.error-state { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 14px; border: 1px solid color-mix(in srgb, var(--fr-danger) 32%, var(--line)); border-radius: 14px; color: var(--fr-danger); background: var(--fr-danger-soft); font-size: 11px; }
.error-state button { border: 0; color: inherit; background: transparent; cursor: pointer; font-weight: 600; }
.review-shell { padding: 0; background: transparent; }
.review-header { display: flex; align-items: center; justify-content: space-between; }
.review-header > div { display: flex; align-items: baseline; gap: 9px; }
.review-header .eyebrow { margin: 0; }
.review-header strong { font-size: 11px; }
.review-header button { border: 0; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; }
.review-card { position: relative; display: grid; min-height: 360px; margin-top: 14px; padding: 24px; border: 1px solid color-mix(in srgb, var(--brand) 32%, var(--line)); border-radius: 14px; background: var(--surface); place-items: center; align-content: center; text-align: center; box-shadow: none; }
.review-card > .status-pill { position: absolute; align-self: start; justify-self: start; }
.review-prompt { min-width: 0; max-width: 620px; }
.review-prompt h3 { margin: 0; overflow-wrap: anywhere; color: var(--ink); font-size: 34px; }
.review-prompt small { display: block; margin-top: 10px; color: var(--muted); font-size: 11px; }
.cloze-context { margin: 25px 0 0; overflow-wrap: anywhere; color: var(--ink); font-family: Georgia, serif; font-size: 20px; line-height: 1.65; }
.reveal-button { min-height: 43px; margin-top: 26px; padding: 0 18px; border: 0; border-radius: 12px; color: #fff; background: var(--brand); cursor: pointer; font-size: 11px; font-weight: 600; }
.reveal-button kbd { margin-left: 8px; padding: 2px 6px; border: 1px solid rgba(255,255,255,.35); border-radius: 5px; background: rgba(255,255,255,.12); font: inherit; font-size: 8px; }
.review-answer { width: min(100%, 620px); min-width: 0; margin-top: 20px; }
.answer-heading { display: flex; min-width: 0; align-items: baseline; justify-content: center; gap: 10px; }
.answer-heading h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--ink); font-size: 30px; }
.answer-heading span { color: var(--muted); font-family: Georgia, serif; font-size: 14px; }
.answer-translation { margin: 10px 0 0; overflow-wrap: anywhere; color: var(--brand-strong); font-size: 18px; font-weight: 600; white-space: pre-wrap; }
.answer-context { margin: 14px 0 0; padding: 10px 12px; overflow-wrap: anywhere; border-radius: 10px; color: var(--muted); background: var(--surface-soft); font-size: 11px; line-height: 1.55; text-align: left; }
.review-answer > a { display: inline-block; margin-top: 8px; color: var(--brand-strong); font-size: 11px; text-decoration: none; }
.review-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 22px; }
.review-actions button { display: grid; min-height: 60px; grid-template-columns: 22px 1fr; grid-template-rows: 1fr 1fr; padding: 9px 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); text-align: left; cursor: pointer; }
.review-actions button > span { grid-row: 1 / 3; align-self: center; color: var(--muted); font-size: 11px; }
.review-actions strong { font-size: 11px; }
.review-actions small { color: var(--muted); font-size: 8.5px; }
.review-actions .again:hover { border-color: color-mix(in srgb, var(--brand) 32%, var(--line)); background: var(--fr-danger-soft); }
.review-actions .good:hover { border-color: color-mix(in srgb, var(--fr-success) 32%, var(--line)); background: var(--fr-success-soft); }
.review-complete { display: grid; min-height: 340px; place-items: center; align-content: center; gap: 8px; }
.review-complete > span { display: grid; width: 54px; height: 54px; place-items: center; border-radius: 50%; color: #fff; background: var(--fr-success); font-size: 25px; }
.review-complete h3, .review-complete p { margin: 0; }
.review-complete p { color: var(--muted); font-size: 11px; }
.review-complete button { min-height: 38px; margin-top: 10px; padding: 0 15px; border: 0; border-radius: 11px; color: #fff; background: var(--brand); cursor: pointer; font-size: 11px; font-weight: 600; }
.book-toast { position: fixed; z-index: 30; right: 28px; bottom: 24px; display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 11px; color: #fff; background: #252a33; box-shadow: 0 12px 30px rgba(0,0,0,.2); font-size: 11px; }
.book-toast button { padding: 0; border: 0; color: #ffb8ce; background: transparent; cursor: pointer; font: inherit; font-weight: 600; }
@media (max-width: 560px) {
  .recent-deletion-row { align-items:flex-start; flex-wrap:wrap; gap:4px 12px; }
  .recent-deletion-term { flex:1 1 100%; }
  .collection-tools { align-items:flex-start; gap:12px; }
  .collection-management { flex:1; min-width:0; max-width:65%; gap:3px; flex-wrap:wrap; justify-content:flex-end; }
  .collection-management .book-more { max-width:100%; }
  .collection-overview h2 { font-size:16px; }
  .collection-overview > span { max-width:160px; }
  .toolbar { flex-wrap:wrap; }
  .search-field { flex-basis:100%; }
  .collection-type { flex:1; width:auto; }
  .book-filter { margin-left:auto; }
  .start-review { padding:0 10px; }
  .answer-heading {flex-wrap:wrap;}
  .book-more-menu { right: 0; left: auto; }
  .review-card { padding: 18px 13px; }
  .review-actions { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { .loading-ring { transition: none; animation: none; } }
</style>
