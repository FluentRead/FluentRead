<!--
 * @file src/features/reading-assistant/ui/ReadingPanel.vue
 * 文件职责：在原有划词卡内提供读懂、拆句、用法、练习和连续追问，保持阅读上下文与原生选区体验。
 * 主要内容：按原文与配置复用各学习动作的已完成回答，显式重新生成；统一呈现 Markdown、原文朗读、句子收藏和 30 天问答记录，并以代次隔离过期请求。
 * 模块边界：不持有模型密钥、不扫描页面、不直接请求供应商；记录由后台会话仓库保存，父划词组件负责选区、位置和 Shadow UI 生命周期。
 -->
<template>
  <div class="fr-reading" data-reading-panel>
    <div class="fr-reading-navigation">
      <template v-if="showRecords">
        <button type="button" aria-label="返回当前阅读" @click="closeRecords">‹ 返回当前阅读</button>
        <span>阅读记录</span>
      </template>
      <template v-else>
        <span>{{ historicalText ? '继续上次阅读' : '理解选中的文字' }}</span>
        <button v-if="!privateContext" type="button" @click="openRecords">阅读记录</button>
      </template>
    </div>
    <section v-if="showRecords" class="fr-reading-records fr-reading-scroll" aria-label="阅读记录">
      <p class="fr-reading-hint">选择一条，继续上次的问答。记录仅保存在本机 30 天。</p>
      <div class="fr-reading-session-list">
        <button v-for="item in sessions" :key="item.id" type="button" class="fr-reading-session" @click="restoreSession(item.id)">
          <span data-i18n-ignore>{{ item.text }}</span>
          <small>{{ actionLabelFor(item.intent) }} · {{ formatDate(item.updatedAt) }} · {{ item.turnCount }} 轮<span>继续阅读 ›</span></small>
        </button>
        <p v-if="!sessions.length && !recordsLoading && !recordsError" class="fr-reading-empty">还没有阅读记录。选中一段文字，点击读懂或拆句，问答会自动保存在这里。</p>
        <p v-if="recordsLoading" class="fr-reading-hint" role="status">正在读取…</p>
        <p v-if="recordsError" class="fr-reading-error" role="alert">{{ recordsError }}<button type="button" @click="loadMoreSessions">重试</button></p>
        <button v-if="hasMoreSessions" :disabled="recordsLoading" type="button" class="fr-reading-more" @click="loadMoreSessions">加载更多</button>
      </div>
    </section>
    <template v-else>
    <div class="fr-reading-source">
      <p data-i18n-ignore>{{ activeText }}</p>
      <div class="fr-reading-source-tools">
      <button v-if="!historicalText && selection.sentence !== selection.text && !wholeSentence" type="button" @click="expandSentence">理解整句</button>
      <span v-else-if="wholeSentence">已展开到整句</span>
      <button type="button" class="fr-reading-speak" :aria-label="playingSourceText === activeText ? '停止朗读' : '朗读原文'" :title="playingSourceText === activeText ? '停止朗读' : '朗读原文'" :aria-pressed="playingSourceText === activeText" @click="emit('play-source', activeText)">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path v-if="playingSourceText !== activeText" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path v-else d="M16 8v8m4-8v8"/></svg>
      </button>
      <button v-if="canSaveWord" type="button" :aria-label="saved ? '已收藏原文' : '收藏原文'" :disabled="saving || saved" @click="saveWord">{{ saved ? '已收藏' : '收藏' }}</button>
      </div>
    </div>
    <div class="fr-reading-actions" role="group" aria-label="学习方式">
      <button v-for="action in actions" :key="action.id" type="button" :aria-pressed="intent === action.id" @click="startAction(action.id)">{{ action.label }}</button>
      <button type="button" class="fr-reading-regenerate" :disabled="busy" title="重新生成当前学习方式的回答" @click="regenerate">重新生成</button>
    </div>
    <div ref="answerScroll" class="fr-reading-scroll fr-reading-result" aria-live="polite" aria-atomic="false">
      <details v-if="priorAnswers.length" class="fr-reading-session-detail">
        <summary data-i18n-ignore>{{ t("reading.priorTurns", {count: priorAnswers.length}) }}</summary>
        <article v-for="turn in priorAnswers" :key="turn.id" class="fr-reading-turn">
          <p class="fr-reading-question"><span data-i18n-ignore>{{ turn.question || translateLegacy(actionLabelFor(turn.intent)) }}</span><small>{{ statusLabel(turn.status) }}</small></p>
          <ReadingAnswer :text="turn.answer" />
        </article>
      </details>
      <p v-if="currentQuestion" class="fr-reading-question" data-i18n-ignore>{{ currentQuestion }}</p>
      <p v-if="busy" class="fr-reading-status" role="status"><span class="fr-reading-pulse" :class="{'fr-reading-static': !animations}" aria-hidden="true" /><span data-i18n-ignore>{{ t("reading.generatingAction", {action: translateLegacy(actionLabel)}) }}</span><button type="button" @click="stop">停止</button></p>
      <div v-if="error" class="fr-reading-error" role="alert">
        <p>{{ error }}</p>
        <div><button type="button" @click="retry">重试</button><button type="button" @click="openSettings('settings-services')">设置模型</button></div>
      </div>
      <p v-if="stopped && !busy" class="fr-reading-status" role="status">已停止<button type="button" @click="retry">继续生成</button></p>
      <div v-if="answer" class="fr-reading-answer" :aria-busy="busy">
        <ReadingAnswer :text="answer" />
      </div>
      <p v-if="!busy && !answer && !error && !stopped" class="fr-reading-hint">选一种方式，理解这段表达。</p>
    <footer v-if="answer && !busy" class="fr-reading-footer">
      <span :title="model">{{ model }}<small v-if="memoryCount" data-i18n-ignore> · {{ t("reading.memoryReferences", {count: memoryCount}) }}</small></span>
      <button type="button" @click="copyAnswer">{{ copied ? '已复制' : '复制' }}</button>
      <button v-if="preferences.memoryEnabled && !privateContext && !stopped && !error" type="button" :disabled="remembering || remembered" title="将这段原文与回答保存为长期学习记忆" @click="rememberLearning">{{ remembered ? '已记住' : '记住要点' }}</button>
    </footer>
    </div>
    <form class="fr-reading-followup" @submit.prevent="ask">
      <input v-model="question" :disabled="busy" maxlength="1000" aria-label="继续追问" :placeholder="intent === 'practice' ? '写下你的练习答案…' : '继续问这句话…'" @keydown.stop @keyup.stop @input="feedback = ''" />
      <button type="submit" :disabled="busy || !question.trim()" aria-label="发送追问" title="发送追问">↑</button>
    </form>
    <p v-if="feedback" class="fr-reading-feedback" role="status">{{ feedback }}</p>
    <p v-if="sessionWarning" class="fr-reading-feedback" role="status">{{ sessionWarning }}</p>
    </template>
    <div class="fr-reading-context"><span>{{ privateContext ? '隐私模式：不保存记录' : '阅读记录保存在本机 30 天' }}</span><button type="button" aria-label="打开翻译卡设置" @click="openSettings()">设置</button></div>
  </div>
</template>

<script setup lang="ts">
import {useUiI18n} from "@/src/ui/i18n";
const {t, translateLegacy} = useUiI18n();
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import {HARNESS_ACTIONS, type HarnessActionId, type HarnessPreferences} from '@/src/core/config/harness';
import ReadingAnswer from './ReadingAnswer.vue';
import type {ReadingSelection, ReadingTurn} from '../types';
import {getHarnessSession, listHarnessSessions, streamReading, saveLearningMemory} from '../client';
import type {HarnessSession, HarnessSessionSummary, HarnessStoredTurnStatus} from '@/src/services/harness/sessionTypes';
import {normalizeLearningSourceText} from '@/src/features/vocabulary/public';
import {VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse} from '@/src/features/vocabulary/protocol';
import {detectlang} from '@/src/core/language/detect';

const props = defineProps<{
  selection: ReadingSelection;
  preferences: HarnessPreferences;
  active: boolean;
  initialAction?: HarnessActionId;
  historyOnly?: boolean;
  targetLanguage: string;
  vocabularyEnabled: boolean;
  privateContext: boolean;
  animations: boolean;
  playingSourceText?: string;
  sourceLanguage?: string;
  modelRevision?: number;
}>();
const emit = defineEmits<{resize: []; 'play-source': [text: string]; 'source-change': [text: string]}>();
const intent = ref<HarnessActionId>(props.initialAction || props.preferences.defaultAction);
const wholeSentence = ref(false);
const historicalText = ref('');
const historicalContext = ref('');
const sessionWarning = ref('');
const activeText = computed(() => historicalText.value || (wholeSentence.value ? props.selection.sentence : props.selection.text));
const actions = computed(() => HARNESS_ACTIONS.filter(action => props.preferences.actions.includes(action.id)));
const actionLabel = computed(() => HARNESS_ACTIONS.find(action => action.id === intent.value)?.label ?? '理解');
const question = ref('');
const currentQuestion = ref('');
const answer = ref('');
const busy = ref(false);
const stopped = ref(false);
const error = ref('');
const model = ref('');
const copied = ref(false);
const saved = ref(false);
const saving = ref(false);
const feedback = ref('');
const remembered = ref(false);
const remembering = ref(false);
const memoryCount = ref(0);
const sessions = ref<HarnessSessionSummary[]>([]);
const showRecords = ref(false);
const recordsLoading = ref(false);
const recordsError = ref('');
const answerScroll = ref<HTMLElement>();
const previousAnswers = ref<Array<ReadingTurn & {id: string; intent: HarnessActionId; status: HarnessStoredTurnStatus}>>([]);
const currentTurnKey = ref('');
const priorAnswers = computed(() => previousAnswers.value.filter(turn => turn.id !== currentTurnKey.value));
const sessionOffset = ref(0);
const hasMoreSessions = ref(false);
const actionLabels: Record<string, string> = {meaning: '读懂', grammar: '拆句', usage: '用法', practice: '练习'};
const statusLabels: Record<string, string> = {streaming: '进行中', completed: '已完成', stopped: '已停止', error: '失败'};
const actionLabelFor = (value: string) => actionLabels[value] || '学习';
const statusLabel = (value: string) => statusLabels[value] || '未知状态';
const formatDate = (value: number) => new Intl.DateTimeFormat(undefined, {month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(value);
const history: ReadingTurn[] = [];
const canSaveWord = computed(() => props.vocabularyEnabled && !props.privateContext && Boolean(normalizeLearningSourceText(activeText.value)));
interface CachedAnswer {
  id: string;
  answer: string;
  question: string;
  model: string;
  history: ReadingTurn[];
  lastHistory: ReadingTurn[];
  memoryCount: number;
  anchorTurnId: string;
  lastAnchorTurnId: string;
}
// 只在当前卡片内保留四个动作的成功结果；持久历史仍由后台的 30 天会话仓库负责。
const actionCache = new Map<HarnessActionId, CachedAnswer>();
const copyTurns = (turns: ReadingTurn[]) => turns.map(turn => ({...turn}));
let pendingId = '';
let generation = 0;
let lastQuestion = '';
let lastHistory: ReadingTurn[] = [];
let anchorTurnId = '';
let lastAnchorTurnId = '';
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let streamHandle: {cancel: () => void} | undefined;
let sessionId = '';
let recordsGeneration = 0;
let restoreEpoch = 0;

function cancelRequest(): void {
  generation += 1;
  streamHandle?.cancel();
  streamHandle = undefined;
  if (pendingId) void browser.runtime.sendMessage({type: 'fluentReadHarness', action: 'cancel', requestId: pendingId}).catch(() => undefined);
  pendingId = '';
  busy.value = false;
}
function stop(): void { cancelRequest(); stopped.value = true; }
function archiveAnswer(): void {
  if (!answer.value || !currentTurnKey.value) return;
  const turn = {id: currentTurnKey.value, question: currentQuestion.value, answer: answer.value, intent: intent.value, status: (busy.value || stopped.value ? 'stopped' : error.value ? 'error' : 'completed') as HarnessStoredTurnStatus};
  const existing = previousAnswers.value.findIndex(item => item.id === turn.id);
  if (existing >= 0) previousAnswers.value[existing] = turn;
  else previousAnswers.value.push(turn);
  if (previousAnswers.value.length > 60) previousAnswers.value.splice(0, previousAnswers.value.length - 60);
}
function rememberAnswer(): void {
  actionCache.set(intent.value, {id: currentTurnKey.value, answer: answer.value, question: currentQuestion.value, model: model.value, history: copyTurns(history), lastHistory: copyTurns(lastHistory), memoryCount: memoryCount.value, anchorTurnId, lastAnchorTurnId});
}
function restoreAnswer(cached: CachedAnswer): void {
  currentTurnKey.value = cached.id;
  answer.value = cached.answer;
  currentQuestion.value = cached.question;
  model.value = cached.model;
  memoryCount.value = cached.memoryCount;
  remembered.value = false;
  history.splice(0, history.length, ...copyTurns(cached.history));
  lastQuestion = cached.question;
  lastHistory = copyTurns(cached.lastHistory);
  anchorTurnId = cached.anchorTurnId;
  lastAnchorTurnId = cached.lastAnchorTurnId;
  error.value = ''; stopped.value = false; copied.value = false; feedback.value = '';
  void nextTick(() => { if (answerScroll.value) answerScroll.value.scrollTop = 0; });
}
async function run(prompt: string, turns: ReadingTurn[], retrying = false): Promise<void> {
  const requestAnchor = prompt ? (retrying ? lastAnchorTurnId : anchorTurnId) : '';
  if (!retrying) archiveAnswer();
  cancelRequest();
  const token = generation;
  const requestId = `reading-${crypto.randomUUID()}`;
  currentTurnKey.value = requestId;
  pendingId = requestId;
  lastQuestion = prompt;
  lastHistory = turns.map(turn => ({...turn}));
  lastAnchorTurnId = requestAnchor;
  anchorTurnId = '';
  answer.value = '';
  memoryCount.value = 0;
  remembered.value = false;
  currentQuestion.value = prompt;
  showRecords.value = false;
  void nextTick(() => { if (answerScroll.value) answerScroll.value.scrollTop = 0; });
  busy.value = true;
  error.value = '';
  stopped.value = false;
  copied.value = false;
  feedback.value = '';
  try {
    streamHandle = streamReading({
      type: 'fluentReadHarness', action: 'run', requestId,
      selection: {text: activeText.value, context: props.preferences.contextMode === 'paragraph' ? historicalContext.value || props.selection.context : '', sentence: ''},
      intent: intent.value, question: prompt, history: turns, ...(sessionId ? {sessionId} : {}),
      ...(sessionId && requestAnchor ? {anchorTurnId: requestAnchor} : {}),
    }, {
      progress: progress => {
        if (token !== generation) return;
        if (progress.kind === 'model') model.value = progress.model;
        if (progress.kind === 'text') answer.value = progress.text;
        if (progress.kind === 'session') { sessionId = progress.persistent ? (progress.sessionId || '') : ''; anchorTurnId = progress.persistent ? (progress.turnId || '') : ''; if (progress.warning) sessionWarning.value = progress.warning; }
        if (progress.kind === 'memory') { memoryCount.value = progress.count; if (progress.warning) feedback.value = progress.warning; }
      },
      result: response => {
        if (token !== generation) return;
        busy.value = false;
        pendingId = '';
        streamHandle = undefined;
        if (!response.success) { if (response.cancelled) stopped.value = true; else error.value = response.error; return; }
        currentQuestion.value = prompt;
        answer.value = response.text;
        model.value = response.model;
        if (response.sessionId) sessionId = response.sessionId;
        if (response.turnId) anchorTurnId = response.turnId;
        if (response.persistenceWarning) sessionWarning.value = response.persistenceWarning;
        memoryCount.value = response.memoryCount || 0;
        history.splice(0, history.length, ...turns, {question: prompt || actionLabel.value, answer: response.text});
        if (history.length > 4) history.splice(0, history.length - 4);
        rememberAnswer();
      },
      error: failure => {
        if (token !== generation) return;
        busy.value = false;
        pendingId = '';
        streamHandle = undefined;
        if (!stopped.value) error.value = failure.message;
      },
    });
  } catch (failure) {
    if (token === generation) { busy.value = false; pendingId = ''; error.value = failure instanceof Error ? failure.message : '请求失败，请重试。'; }
  }
}
function startAction(action: HarnessActionId, preserveHistory = true): void {
  if (!props.preferences.actions.includes(action)) return;
  if (preserveHistory && action === intent.value && busy.value) return;
  if (preserveHistory) archiveAnswer();
  cancelRequest();
  intent.value = action;
  showRecords.value = false;
  question.value = '';
  const cached = preserveHistory ? actionCache.get(action) : undefined;
  if (cached) { restoreAnswer(cached); return; }
  answer.value = '';
  currentQuestion.value = '';
  currentTurnKey.value = '';
  history.splice(0);
  if (!preserveHistory) { previousAnswers.value = []; actionCache.clear(); }
  void run('', []);
}
function regenerate(): void { if (!busy.value) void run('', []); }
async function restoreSession(id: string): Promise<void> {
  const restoreToken = ++restoreEpoch;
  const restoreGeneration = generation + 1;
  cancelRequest();
  let session: HarnessSession | null;
  try { session = await getHarnessSession(id); } catch { if (restoreToken === restoreEpoch && restoreGeneration === generation) recordsError.value = '读取记录失败，请重试。'; return; }
  if (restoreToken !== restoreEpoch || restoreGeneration !== generation || !showRecords.value || !props.active) return;
  if (!session) { recordsError.value = '这条记录已过期或已被删除。'; return; }
  actionCache.clear();
  previousAnswers.value = session.turns.slice(0, -1).map(turn => ({id: turn.id, question: turn.question, answer: turn.answer, intent: turn.intent, status: turn.status}));
  historicalText.value = session.text;
  historicalContext.value = session.context;
  sessionId = session.id;
  wholeSentence.value = false;
  const latest = session.turns.at(-1);
  currentTurnKey.value = latest?.id || '';
  // 仓库存的动作名称用于记录展示，不能在重试时变成用户的追问。
  currentQuestion.value = latest?.question === actionLabelFor(latest?.intent || session.intent) ? '' : latest?.question || '';
  answer.value = latest?.answer || '';
  const restoredIntent = latest?.intent || session.intent;
  intent.value = props.preferences.actions.includes(restoredIntent) ? restoredIntent : props.preferences.defaultAction;
  model.value = latest?.model || '';
  memoryCount.value = 0;
  remembered.value = false;
  history.splice(0, history.length, ...session.turns.filter(turn => turn.answer.trim()).slice(-4).map(turn => ({question: turn.question || actionLabelFor(turn.intent), answer: turn.answer})));
  lastQuestion = currentQuestion.value;
  lastHistory = session.turns.slice(0, -1).filter(turn => turn.answer.trim()).slice(-4).map(turn => ({question: turn.question, answer: turn.answer}));
  anchorTurnId = latest?.id || '';
  lastAnchorTurnId = session.turns.slice(0, -1).findLast(turn => turn.intent === intent.value && turn.answer.trim())?.id || '';
  for (let index = 0; index < session.turns.length; index += 1) {
    const turn = session.turns[index];
    if (turn.status !== 'completed' || !turn.answer.trim()) continue;
    const before = session.turns.slice(0, index).filter(item => item.answer.trim()).slice(-4).map(item => ({question: item.question, answer: item.answer}));
    actionCache.set(turn.intent, {id: turn.id, answer: turn.answer, question: turn.question === actionLabelFor(turn.intent) ? '' : turn.question, model: turn.model, history: [...before, {question: turn.question, answer: turn.answer}].slice(-4), lastHistory: before, memoryCount: 0, anchorTurnId: turn.id, lastAnchorTurnId: session.turns.slice(0, index).findLast(item => item.intent === turn.intent && item.answer.trim())?.id || ''});
  }
  error.value = latest?.status === 'error' ? '上次生成失败，已保留收到的内容，可以重试。' : '';
  stopped.value = latest?.status === 'stopped' || latest?.status === 'streaming'; saved.value = false;
  feedback.value = '已打开上次的问答，可以继续追问。';
  recordsError.value = ''; showRecords.value = false;
  void nextTick(() => { if (answerScroll.value) answerScroll.value.scrollTop = 0; });
}
function expandSentence(): void { wholeSentence.value = true; sessionId = ''; historicalText.value = ''; saved.value = false; startAction(intent.value, false); }
function ask(): void {
  const prompt = question.value.trim();
  if (!prompt || busy.value) return;
  question.value = '';
  void run(prompt, history.map(turn => ({...turn})));
}
function retry(): void { void run(lastQuestion, lastHistory, true); }
async function openSettings(section = 'settings-harness'): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section}) as {success?: unknown} | undefined;
    if (response?.success !== true) throw new Error('打开设置失败');
  } catch { feedback.value = section === 'settings-services' ? '打开设置失败，请从扩展菜单进入“翻译服务”。' : '打开设置失败，请从专项翻译进入“翻译卡”。'; }
}
async function copyAnswer(): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${activeText.value}\n\n${answer.value}`);
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1800);
  } catch { feedback.value = '复制失败，可以选中回答后复制。'; }
}
async function rememberLearning(): Promise<void> {
  if (!props.preferences.memoryEnabled || props.privateContext || busy.value || stopped.value || error.value || !answer.value || remembering.value) return;
  const owner = currentTurnKey.value;
  remembering.value = true;
  try {
    await saveLearningMemory({kind: 'lesson', content: `原文：${activeText.value.slice(0, 350)}\n${currentQuestion.value ? `问题：${currentQuestion.value.slice(0, 200)}\n` : ''}学习要点：${answer.value.slice(0, 1400)}`});
    if (currentTurnKey.value === owner) { remembered.value = true; feedback.value = '已保存到学习中心的“学习记忆”，可在那里编辑或删除。'; }
  } catch (failure) { if (currentTurnKey.value === owner) feedback.value = failure instanceof Error ? failure.message : '记忆未能保存，请重试。'; }
  finally { remembering.value = false; }
}
async function saveWord(): Promise<void> {
  if (!canSaveWord.value || saving.value) return;
  saving.value = true;
  const savingText = activeText.value;
  try {
    const response = await browser.runtime.sendMessage({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input: {
      sourceLanguage: props.sourceLanguage && props.sourceLanguage !== 'auto' ? props.sourceLanguage : detectlang(savingText), targetLanguage: props.targetLanguage, term: normalizeLearningSourceText(savingText),
      translation: answer.value, context: {text: historicalContext.value || props.selection.context || activeText.value},
    }}) as VocabularyBookResponse;
    if (!response.success) throw new Error(response.error.message);
    if (activeText.value === savingText) saved.value = true;
  } catch (failure) { if (activeText.value === savingText) feedback.value = failure instanceof Error ? failure.message : '收藏失败，请重试。'; }
  finally { saving.value = false; }
}
watch(() => JSON.stringify([props.preferences, props.targetLanguage, props.sourceLanguage, props.modelRevision]), () => { actionCache.clear(); cancelRequest(); stopped.value = true; feedback.value = '设置已更新，重新生成可使用新的设置。'; });
watch(() => JSON.stringify(props.selection), () => { actionCache.clear(); cancelRequest(); historicalText.value = ''; historicalContext.value = ''; previousAnswers.value = []; history.splice(0); sessionId = ''; question.value = ''; answer.value = ''; wholeSentence.value = false; saved.value = false; });
watch(activeText, text => { saved.value = false; emit('source-change', text); });
watch(() => [props.initialAction, props.historyOnly, props.active] as const, ([action, only, active], [oldAction, oldOnly, oldActive]) => {
  restoreEpoch += 1;
  if (!active) { emit('source-change', ''); if (busy.value) stop(); return; }
  if (only) openRecords();
  else if (action !== oldAction || oldOnly || !oldActive) startAction(action || props.preferences.defaultAction);
});
watch([busy, error, answer, stopped, feedback, wholeSentence], () => emit('resize'), {flush: 'post'});
async function loadMoreSessions(): Promise<void> {
  if (props.privateContext || recordsLoading.value) return;
  const token = recordsGeneration;
  recordsLoading.value = true; recordsError.value = '';
  try {
    const result = await listHarnessSessions(sessionOffset.value);
    if (token !== recordsGeneration) return;
    const known = new Set(sessions.value.map(session => session.id));
    sessions.value = [...sessions.value, ...result.sessions.filter(session => !known.has(session.id))];
    sessionOffset.value += result.sessions.length;
    hasMoreSessions.value = result.hasMore;
  } catch { if (token === recordsGeneration) recordsError.value = '读取记录失败，请重试。'; }
  finally { if (token === recordsGeneration) recordsLoading.value = false; }
}
function openRecords(): void {
  restoreEpoch += 1;
  showRecords.value = true;
  recordsGeneration += 1;
  recordsLoading.value = false;
  sessions.value = []; sessionOffset.value = 0; hasMoreSessions.value = false;
  void loadMoreSessions();
}
function closeRecords(): void { restoreEpoch += 1; showRecords.value = false; recordsError.value = ''; }
onMounted(() => {
  if (props.historyOnly) openRecords();
  else startAction(intent.value);
});
onBeforeUnmount(() => { recordsGeneration += 1; restoreEpoch += 1; cancelRequest(); emit('source-change', ''); clearTimeout(copyTimer); history.splice(0); actionCache.clear(); });
</script>

<style scoped>
.fr-reading { --fr-reading-line: #eee8ec; --fr-reading-muted: #857a84; --fr-reading-soft: #faf7f9; display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; padding: 10px 14px; overflow: hidden; color: #35333c; font: 13px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.fr-reading-navigation { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; color: var(--fr-reading-muted); font-size: 11px; }
.fr-reading-navigation button { color: #a64b6e; }
.fr-reading-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 2px 5px 4px 0; }
.fr-reading-records .fr-reading-hint { margin-top: 0; }
.fr-reading-session-list { display: grid; gap: 4px; padding-bottom: 8px; }
.fr-reading .fr-reading-session { display: grid; gap: 6px; width: 100%; padding: 10px; text-align: left; color: inherit; background: var(--fr-reading-soft); border: 1px solid var(--fr-reading-line); font-size: 12px; }
.fr-reading-session > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.fr-reading-session small { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px; color: var(--fr-reading-muted); font-size: 10px; }
.fr-reading-session small span { color: #a64b6e; }
.fr-reading-empty { padding: 16px 6px; color: var(--fr-reading-muted); font-size: 12px; }
.fr-reading-session-detail { margin: 0 0 12px; border-bottom: 1px solid var(--fr-reading-line); }
.fr-reading-session-detail summary { padding: 4px 0 7px; color: var(--fr-reading-muted); cursor: pointer; font-size: 11px; }
.fr-reading-turn { padding: 10px 0; border-top: 1px solid var(--fr-reading-line); overflow-wrap: anywhere; }
.fr-reading-turn small { margin-left: 8px; color: var(--fr-reading-muted); font-size: 10px; }
.fr-reading-turn p { margin: 3px 0; }
.fr-reading button, .fr-reading input { font: inherit; }
.fr-reading button { cursor: pointer; border: 0; background: none; color: #826573; padding: 3px 6px; border-radius: 6px; }
.fr-reading button:focus-visible, .fr-reading input:focus-visible { outline: 2px solid #cd527f; outline-offset: 2px; }
.fr-reading button:disabled { opacity: .5; cursor: default; }
.fr-reading-source { flex-shrink: 0; border-left: 2px solid #e6c3d0; padding: 0 0 0 10px; margin: 2px 0 10px; }
.fr-reading-source p { margin: 0; max-height: 58px; overflow: auto; font-size: 12px; color: #69616b; user-select: text; white-space: pre-wrap; overflow-wrap: anywhere; }
.fr-reading-source-tools { display: flex; align-items: center; gap: 10px; min-height: 25px; }
.fr-reading-source-tools button, .fr-reading-source-tools > span { font-size: 11px; color: #a64b6e; }
.fr-reading-source-tools .fr-reading-speak { margin-left: auto; display: inline-flex; align-items: center; padding: 5px; }
.fr-reading-speak[aria-pressed='true'] { background: var(--fr-reading-soft); }
.fr-reading-actions { flex-shrink: 0; display: flex; gap: 4px; padding-bottom: 10px; }
.fr-reading-actions button { flex: 1; color: #77707a; background: #f5f3f5; padding: 5px 2px; }
.fr-reading-actions button[aria-pressed='true'] { background: #f9e7ee; color: #9d3e61; font-weight: 600; }
.fr-reading-actions .fr-reading-regenerate { flex: 0 0 auto; background: none; padding: 5px; font-size: 10px; color: var(--fr-reading-muted); }
.fr-reading-status { display: flex; align-items: center; gap: 8px; color: #8b7981; font-size: 12px; }
.fr-reading-status button { margin-left: auto; }
.fr-reading-pulse { width: 6px; height: 6px; border-radius: 50%; background: #c76688; animation: fr-reading-breathe 1.4s ease-in-out infinite; }
.fr-reading-static { animation: none; }
.fr-reading-hint, .fr-reading-feedback { font-size: 12px; color: var(--fr-reading-muted); }
.fr-reading-feedback { flex-shrink: 0; margin: 5px 0 0; max-height: 40px; overflow: auto; }
.fr-reading-error { font-size: 12px; color: #b44753; background: #fff4f4; padding: 8px 10px; border-radius: 9px; }
.fr-reading-error p { margin: 0 0 4px; }
.fr-reading-question { margin: 0 0 10px; border-bottom: 1px solid var(--fr-reading-line); padding-bottom: 8px; color: #986077; user-select: text; overflow-wrap: anywhere; }
.fr-reading-answer { user-select: text; overflow-wrap: anywhere; }
.fr-reading-footer { display: flex; gap: 5px; align-items: center; margin: 8px 0; font-size: 11px; }
.fr-reading-footer > span { color: #9b9199; margin-right: auto; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-reading-followup { flex-shrink: 0; display: flex; gap: 6px; margin-top: 8px; padding: 5px 5px 5px 10px; border: 1px solid #eae2e7; border-radius: 11px; }
.fr-reading-followup input { min-width: 0; flex: 1; width: 100%; border: 0; outline: none; color: inherit; background: transparent; font-size: 12px; user-select: text; }
.fr-reading-followup input::placeholder { color: #a79ba4; font-size: 11px; }
.fr-reading-followup button { background: #b85579; color: white; width: 27px; height: 27px; line-height: 20px; }
.fr-reading-context { flex-shrink: 0; display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 10px; color: var(--fr-reading-muted); }
.fr-reading-context button { margin-left: auto; font-size: 10px; }
:global(.fr-dark-theme) .fr-reading { --fr-reading-line: #514651; --fr-reading-muted: #b6a9b5; --fr-reading-soft: #352f38; color: #e6e0e8; }
:global(.fr-dark-theme) .fr-reading-source p { color: #b5aab6; }
:global(.fr-dark-theme) .fr-reading-actions button { background: #38313c; color: #bdb0c1; }
:global(.fr-dark-theme) .fr-reading-actions button[aria-pressed='true'] { background: #50313f; color: #f1b6ce; }
:global(.fr-dark-theme) .fr-reading-followup { border-color: #554651; }
:global(.fr-dark-theme) .fr-reading-error { background: #482e35; color: #f5acb6; }
:global(.fr-dark-theme) .fr-reading-navigation button, :global(.fr-dark-theme) .fr-reading-source button, :global(.fr-dark-theme) .fr-reading-session small span, :global(.fr-dark-theme) .fr-reading-question { color: #e4a0bc; }
@media (max-height: 420px) { .fr-reading-source p { max-height: 30px; } .fr-reading-navigation { margin-bottom: 3px; } .fr-reading-source { margin-bottom: 6px; } .fr-reading-context { margin-top: 2px; } }
@keyframes fr-reading-breathe { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .fr-reading-pulse { animation: none; } }
</style>
