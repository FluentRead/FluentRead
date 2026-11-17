<!--
 * @file src/features/reading-assistant/ui/ReadingPanel.vue
 * 文件职责：在划词卡内以内容为主呈现学习回答，复用父卡片导航、把次级操作送入顶栏固定槽、按需展开的原文译文对照与连续追问。
 * 主要内容：相同译文保留原文且不重复展示；按原文与配置复用各学习动作的已完成回答，显式重新生成；历史问答按轮次与问题摘要逐条展开，区分当前问答与旧回答，切换回答时收起历史；统一导航的学习卡默认收起原文与匹配译文，查看原文后可返回当前阅读，短回答不再保留一屏空白；独立面板仍在滚动区顶部展示对照内容，进入回答时滚过原文，译文晚到时保持回答位置，关闭局部浏览器滚动锚定以避免流式格式变化移动阅读位置；流式正文只更新内部滚动内容，回答出现或消失及状态变化才通知父卡片检查布局；重复点击当前动作保留位置和待发送追问；把原文朗读和 30 天问答记录收进次级操作，在回答下方区分原文收藏与学习笔记；原文收藏仅保存对应译文，笔记保存不依赖 AI 参考开关，让多语言动作标签按空间换行，统一呈现 Markdown，以局部主题变量保持正文、状态和操作文字的对比度，并以代次隔离过期请求，取消消息统一交给流客户端释放；冻结每轮许可原文身份，显示就近引用和来源状态，历史恢复保留引文而不授予当前网页定位权限，回写前核查页面归属。
 * 材料关联：只将会话或笔记标识与选中原句关联到本机材料，不复制回答正文；源快照不会发送给模型，取消与清空代次淘汰迟到写入。
 * 模块边界：不持有模型密钥、不扫描页面、不直接请求供应商；双布局在正文滚动区外复用同一追问节点，保留父 scoped 样式、Vue 输入法指令及键盘边界；按有效服务限制B站为基础读懂/用法，隐藏且拒绝未验证的追问，临时默认动作不改保存偏好；历史回答保留原动作与追问，按当前服务限制重试/再生成，父导航回写不重新请求；记录由后台会话仓库保存，日期格式器只在本组件同步模板每轮渲染内复用并在下轮重解系统默认值，父划词组件负责选区、位置和 Shadow UI 生命周期。
 -->
<template>
  <Teleport v-if="externalNavigation && toolsTarget && active && !showRecords" :to="toolsTarget">
    <div class="fr-reading-controls">
      <template v-if="busy && answer">
        <span class="fr-reading-accessible-status" role="status" data-i18n-ignore>{{ t("reading.generatingAction", {action: translateLegacy(actionLabel)}) }}</span>
        <button type="button" class="fr-reading-inline-stop" :aria-label="translateLegacy('停止')" :title="translateLegacy('停止')" @click="stop">停止</button>
      </template>
      <ReadingTools />
    </div>
  </Teleport>
  <div class="fr-reading" data-reading-panel @pointerdown="dismissToolsOutside" @focusin="dismissToolsOutside">
    <div v-if="showRecords" class="fr-reading-navigation">
      <button type="button" aria-label="返回当前阅读" @click="closeRecords">‹ 返回当前阅读</button>
      <span>阅读记录</span>
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
    <div v-if="!externalNavigation" class="fr-reading-toolbar">
      <div class="fr-reading-actions" role="group" aria-label="学习方式">
        <button v-for="action in actions" :key="action.id" type="button" :aria-label="action.label" :title="action.label" :aria-pressed="active && Boolean(currentTurnKey) && intent === action.id" @click="chooseAction(action.id)">{{ action.id === 'grammar' ? '句法' : action.label }}</button>
      </div>
      <ReadingTools />
    </div>
    <div ref="answerScroll" class="fr-reading-scroll fr-reading-result" :class="{'fr-reading-result-external': externalNavigation}" tabindex="-1" :aria-label="translateLegacy(actionLabel)" aria-live="polite" aria-atomic="false" @wheel.passive="cancelReadingPosition" @pointerdown="cancelReadingPosition" @keydown="cancelReadingPosition">
      <section v-show="!externalNavigation || sourceExpanded" class="fr-reading-source" :aria-label="translateLegacy('原文')">
        <button v-if="externalNavigation && sourceExpanded" class="fr-reading-source-return" type="button" data-i18n-ignore :aria-label="translateLegacy('返回当前阅读')" @click="returnToReading">‹ {{ translateLegacy('返回当前阅读') }}</button>
        <span>原文</span>
        <p data-i18n-ignore>{{ activeText }}</p>
        <div v-if="activeTranslation && (activeTranslation.pending || activeTranslation.error || hasDistinctTranslation(activeText, activeTranslation.text))" class="fr-reading-translation" :aria-label="translateLegacy('译文')">
          <span>{{ translateLegacy('译文') }}</span>
          <p v-if="hasDistinctTranslation(activeText, activeTranslation.text)" data-i18n-ignore>{{ activeTranslation.text }}</p>
          <p v-else role="status">{{ translateLegacy(activeTranslation.pending ? '正在翻译…' : activeTranslation.error || '翻译失败，请重试') }}</p>
        </div>
      </section>
      <div ref="answerBody" class="fr-reading-body" :class="{'fr-reading-body-external': externalNavigation}">
      <details v-if="priorAnswers.length" ref="historyDetails" class="fr-reading-session-detail">
        <summary data-i18n-ignore>{{ t("reading.priorTurns", {count: priorAnswers.length}) }}</summary>
        <div class="fr-reading-turn-list">
          <article v-for="(turn, index) in priorAnswers" :key="turn.id" class="fr-reading-turn">
            <button type="button" class="fr-reading-turn-toggle" :aria-expanded="expandedTurnId === turn.id" :aria-controls="`fr-reading-turn-${turn.id}`" @click="toggleHistoryTurn(turn.id)">
              <span class="fr-reading-turn-meta">
                <span data-i18n-ignore>{{ t('reading.turnNumber', {number: index + 1}) }} · {{ translateLegacy(actionLabelFor(turn.intent)) }}</span>
                <small v-if="turn.status !== 'completed'" class="fr-reading-turn-status">{{ statusLabel(turn.status) }}</small>
                <svg class="fr-reading-turn-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
              </span>
              <span class="fr-reading-turn-title" data-i18n-ignore>{{ turn.question || translateLegacy(actionLabelFor(turn.intent)) }}</span>
            </button>
            <div v-show="expandedTurnId === turn.id" :id="`fr-reading-turn-${turn.id}`" class="fr-reading-turn-answer">
              <span class="fr-reading-role" data-i18n-ignore>{{ t('reading.answerLabel') }}</span>
              <ReadingAnswer v-if="expandedTurnId === turn.id && turn.answer" :text="turn.answer" :source-text="activeText" :evidence-sources="turn.evidenceSources || evidenceSources" :locate-evidence="evidenceLocator" :evidence-state="evidenceState" />
              <p v-else class="fr-reading-hint" data-i18n-ignore>{{ t('reading.emptyAnswer') }}</p>
            </div>
          </article>
        </div>
      </details>
      <p v-if="priorAnswers.length" class="fr-reading-current-label" data-i18n-ignore>{{ t('reading.currentTurn') }}</p>
      <div v-if="currentQuestion" class="fr-reading-question">
        <span class="fr-reading-role" data-i18n-ignore>{{ t('reading.questionLabel') }}</span>
        <p data-i18n-ignore>{{ currentQuestion }}</p>
      </div>
      <p v-if="busy && (!externalNavigation || !answer)" class="fr-reading-status" role="status"><span class="fr-reading-pulse" :class="{'fr-reading-static': !animations}" aria-hidden="true" /><span data-i18n-ignore>{{ t("reading.generatingAction", {action: translateLegacy(actionLabel)}) }}</span><button type="button" @click="stop">停止</button></p>
      <div v-if="error" class="fr-reading-error" role="alert">
        <p>{{ error }}</p>
        <div><button type="button" :disabled="!retrySupported" :title="retrySupported ? undefined : generationHint" @click="retry">重试</button><button type="button" @click="openSettings('settings-services')">设置模型</button></div>
      </div>
      <p v-if="stopped && !busy" class="fr-reading-status" role="status">已停止<button type="button" :disabled="!retrySupported" :title="retrySupported ? undefined : generationHint" @click="retry">继续生成</button></p>
      <div v-if="answer" class="fr-reading-answer" :aria-busy="busy">
        <ReadingAnswer :text="answer" :source-text="activeText" :evidence-sources="evidenceSources" :locate-evidence="evidenceLocator" :evidence-state="evidenceState" />
      </div>
      <p v-if="!busy && !answer && !error && !stopped" class="fr-reading-hint">选一种方式，理解这段表达。</p>
    <footer v-if="answer && !busy" class="fr-reading-footer">
      <button type="button" @click="copyAnswer">{{ copied ? '已复制' : '复制' }}</button>
      <button v-if="canSaveWord" type="button" :disabled="saving || saved" :title="t('reading.saveSourceTitle')" @click="saveWord">{{ saved ? '已收藏原文' : '收藏原文' }}</button>
      <button v-if="saved" type="button" data-i18n-ignore @click="openLearningCollection">{{ t('reading.viewSaved') }}</button>
      <button v-if="!privateContext && !stopped && !error" type="button" data-i18n-ignore :disabled="remembering || remembered" :title="t('reading.saveNoteTitle')" @click="rememberLearning">{{ t(remembered ? 'reading.noteSavedButton' : 'reading.saveNote') }}</button>
      <button v-if="remembered" type="button" data-i18n-ignore @click="openLearningMemory">{{ t('reading.viewNotes') }}</button>
    </footer>
      </div>
    </div>
    <ReadingFollowUp />
    <p v-if="!followUpSupported || !actionSupported" class="fr-reading-feedback">{{ generationHint }}<button type="button" @click="openSettings()">{{ followUpSupported ? '设置' : '切换服务' }}</button></p>
    </template>
  </div>
</template>

<script setup lang="ts">
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {useUiI18n} from "@/src/ui/i18n";
import {useRenderDateFormatter} from '@/src/ui/dateFormat';
import {getSafeVisualViewportRect} from '@/src/platform/dom/visualViewport';
const {t, translateLegacy} = useUiI18n();
import {computed, getCurrentInstance, h, nextTick, onBeforeUnmount, onMounted, ref, vModelText, watch, withCtx, withDirectives, withKeys, withModifiers, type VNodeChild} from 'vue';
import browser from 'webextension-polyfill';
import {HARNESS_ACTIONS, isReadingActionSupported, isReadingFollowUpSupported, type HarnessActionId, type HarnessPreferences} from '@/src/core/config/harness';
import ReadingAnswer from './ReadingAnswer.vue';
import type {ReadingSelection, ReadingTurn} from '../types';
import {buildReadingEvidence, readingEvidenceText, type ReadingEvidenceSource} from '@/src/core/harness/evidence';
import type {ReadingEvidenceAnchor} from '../evidenceAnchor';
import {getHarnessSession, listHarnessSessions, streamReading, saveLearningMemory} from '../client';
import type {HarnessSession, HarnessSessionSummary, HarnessStoredTurnStatus} from '@/src/services/harness/sessionTypes';
import {normalizeLearningSourceText} from '@/src/features/vocabulary/public';
import {VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse} from '@/src/features/vocabulary/protocol';
import {detectlang} from '@/src/core/language/detect';
import {beginMaterialCapture, completeMaterialCapture} from '@/src/features/vocabulary/material/public';

const props = defineProps<{
  selection: ReadingSelection;
  preferences: HarnessPreferences;
  service?: string;
  active: boolean;
  initialAction?: HarnessActionId;
  historyOnly?: boolean;
  externalNavigation?: boolean;
  toolsTarget?: HTMLElement | null;
  targetLanguage: string;
  vocabularyEnabled: boolean;
  privateContext: boolean;
  animations: boolean;
  playingSourceText?: string;
  sourceLanguage?: string;
  modelRevision?: number;
  locateEvidence?: ReadingEvidenceAnchor['locate'];
  clearEvidence?: () => void;
  checkEvidence?: ReadingEvidenceAnchor['check'];
  sourceRevision?: number;
  sourceTranslation?: {source: string; text: string; pending?: boolean; error?: string};
}>();
const emit = defineEmits<{resize: []; 'play-source': [text: string]; 'source-change': [text: string]; 'view-change': [view: {action: HarnessActionId; history: boolean}]}>();
const effectiveService = computed(() => props.service || props.preferences.service);
const actions = computed(() => HARNESS_ACTIONS.filter(action => props.preferences.actions.includes(action.id) && isReadingActionSupported(effectiveService.value, action.id)));
const effectiveDefaultAction = computed(() => actions.value.find(action => action.id === props.preferences.defaultAction)?.id
  || actions.value.find(action => action.id === 'meaning')?.id || actions.value[0]?.id || 'meaning');
const followUpSupported = computed(() => isReadingFollowUpSupported(effectiveService.value));
const basicReadingHint = 'B站仅提供基础讲解，完整语法、练习和追问可切换 AI 服务';
const availableInitialAction = (action?: HarnessActionId) => actions.value.some(item => item.id === action) ? action! : effectiveDefaultAction.value;
const intent = ref<HarnessActionId>(availableInitialAction(props.initialAction));
const actionSupported = computed(() => actions.value.some(action => action.id === intent.value));
const generationHint = computed(() => !actionSupported.value && isReadingActionSupported(effectiveService.value, intent.value) ? '当前动作未启用，请在设置中开启。' : basicReadingHint);
const wholeSentence = ref(false);
const historicalText = ref('');
const historicalContext = ref('');
const sessionWarning = ref('');
const activeText = computed(() => historicalText.value || (wholeSentence.value ? props.selection.sentence : props.selection.text));
const requestEvidenceSources = computed(() => buildReadingEvidence(activeText.value, props.preferences.contextMode === 'paragraph'
  ? (historicalContext.value || props.selection.context).trim().slice(0, Math.min(4000, Math.max(0, props.preferences.maxContextChars))) : ''));
const evidenceSources = ref<readonly ReadingEvidenceSource[]>(requestEvidenceSources.value);
// 已保存记录没有当前 DOM 所有权；展示引用文字，禁止从历史记录定位到当前页面的相似句子。
const evidenceLocator = computed(() => historicalText.value || !props.active ? undefined : props.locateEvidence);
const evidenceState = computed(() => {
  void props.sourceRevision;
  void props.selection;
  return historicalText.value ? 'unavailable' : props.checkEvidence?.();
});
watch(() => props.sourceRevision, () => { props.clearEvidence?.(); if (busy.value) stop(); });
const activeTranslation = computed(() => props.sourceTranslation
  && props.sourceTranslation.source.replace(/\s+/gu, ' ').trim() === activeText.value.replace(/\s+/gu, ' ').trim()
  ? props.sourceTranslation : undefined);
const actionLabel = computed(() => HARNESS_ACTIONS.find(action => action.id === intent.value)?.label ?? '理解');
const question = ref('');
const currentQuestion = ref('');
const retrySupported = computed(() => actionSupported.value && (!currentQuestion.value || followUpSupported.value));
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
const sourceExpanded = ref(false);
watch([intent, showRecords], ([action, history]) => emit('view-change', {action, history}), {flush: 'post'});
const recordsLoading = ref(false);
const recordsError = ref('');
const answerScroll = ref<HTMLElement>();
const answerBody = ref<HTMLElement>();
let readingPositionFrame: number | undefined;
let readingPositionRevision = 0;
function cancelReadingPosition(): void {
  readingPositionRevision += 1;
  if (readingPositionFrame !== undefined) cancelAnimationFrame(readingPositionFrame);
  readingPositionFrame = undefined;
}
// 统一导航默认收起对照内容；独立面板仍滚过原文。只在进入回答时定位，不跟随流式文本滚动。
function resetReadingPosition(): void {
  if (props.externalNavigation) sourceExpanded.value = false;
  cancelReadingPosition();
  const revision = readingPositionRevision;
  const owner = currentTurnKey.value;
  const scrollToAnswer = () => {
    const viewport = answerScroll.value;
    const body = answerBody.value;
    if (revision !== readingPositionRevision || !props.active || showRecords.value || owner !== currentTurnKey.value || !viewport || !body) return;
    viewport.scrollTop = props.externalNavigation ? 0 : body.offsetTop;
  };
  void nextTick(() => {
    if (revision !== readingPositionRevision) return;
    if (typeof requestAnimationFrame !== 'function') { scrollToAnswer(); return; }
    // 父划词卡先在一帧中调整位置和尺寸，再由 Vue 更新样式；下一帧才使用最终宽度下的原文高度。
    readingPositionFrame = requestAnimationFrame(() => {
      readingPositionFrame = requestAnimationFrame(() => { readingPositionFrame = undefined; scrollToAnswer(); });
    });
  });
}
function setExternalSourceExpanded(expanded: boolean): void {
  cancelReadingPosition();
  closeTools();
  sourceExpanded.value = expanded;
  const viewport = answerScroll.value;
  const revision = readingPositionRevision;
  const owner = currentTurnKey.value;
  const source = activeText.value;
  // 展开后的 DOM 与父卡片布局先提交；过期查看操作不能抢走新回答或新选区的阅读位置。
  void nextTick(() => {
    if (revision !== readingPositionRevision || !props.active || !props.externalNavigation || showRecords.value
      || owner !== currentTurnKey.value || source !== activeText.value || sourceExpanded.value !== expanded
      || !viewport || viewport !== answerScroll.value) return;
    viewport.scrollTop = 0;
    viewport.focus({preventScroll: true});
  });
}
function showSource(): void {
  if (props.externalNavigation) { setExternalSourceExpanded(true); return; }
  cancelReadingPosition();
  closeTools();
  const viewport = answerScroll.value;
  if (!viewport) return;
  viewport.scrollTop = 0;
  viewport.focus({preventScroll: true});
}
function returnToReading(): void {
  if (props.externalNavigation) setExternalSourceExpanded(false);
}
// 普通译文晚到只修正上方内容的高度差；用户向上查看或操作后不改变其位置。
watch(activeTranslation, () => {
  if (props.externalNavigation && !sourceExpanded.value) return;
  const viewport = answerScroll.value;
  const body = answerBody.value;
  if (!props.active || showRecords.value || !viewport || !body) return;
  const top = viewport.scrollTop;
  const offset = top - body.offsetTop;
  if (offset < 0) return;
  const revision = readingPositionRevision;
  const owner = currentTurnKey.value;
  void nextTick(() => {
    if (revision === readingPositionRevision && owner === currentTurnKey.value && props.active && !showRecords.value
      && viewport === answerScroll.value && body === answerBody.value && viewport.scrollTop === top) {
      viewport.scrollTop = body.offsetTop + offset;
    }
  });
});
const toolsMenu = ref<HTMLDetailsElement>();
let toolsWindow: Window | undefined;
// 菜单位于卡片滚动区外；按实际缩放和可见窗口限制高度，短卡也能读完整菜单。
function fitToolsMenu(): void {
  const details = toolsMenu.value;
  if (!details?.open || !props.externalNavigation) return;
  const summary = details.querySelector('summary');
  const menu = details.querySelector<HTMLElement>('.fr-reading-tool-list');
  const view = details.ownerDocument.defaultView;
  if (!summary || !menu || !view) return;
  const rect = summary.getBoundingClientRect();
  const scale = rect.height > 0 ? rect.height / (summary.offsetHeight || rect.height) : 1;
  const viewport = getSafeVisualViewportRect(view);
  const below = Math.max(0, viewport.bottom - rect.bottom - 8);
  const above = Math.max(0, rect.top - viewport.top - 8);
  const upward = below < Math.min(310, menu.scrollHeight) * scale && above > below;
  const width = Math.min(204, Math.max(0, (viewport.width - 24) / scale));
  const origin = details.getBoundingClientRect();
  const naturalLeft = view.getComputedStyle(details).direction === 'rtl' ? rect.left : rect.right - width * scale;
  const left = Math.max(viewport.left + 12, Math.min(naturalLeft, viewport.right - 12 - width * scale));
  menu.style.width = `${width}px`;
  menu.style.insetInlineEnd = 'auto';
  menu.style.left = `${(left - origin.left) / scale}px`;
  menu.style.top = upward ? 'auto' : `${summary.offsetHeight + 4}px`;
  menu.style.bottom = upward ? `${summary.offsetHeight + 4}px` : 'auto';
  menu.style.maxHeight = `${Math.min(310, Math.max(0, (upward ? above : below) / scale - 4))}px`;
}
function stopToolsSizing(): void {
  toolsWindow?.removeEventListener('resize', fitToolsMenu);
  toolsWindow = undefined;
}
function toggleTools(): void {
  stopToolsSizing();
  if (!toolsMenu.value?.open || !props.externalNavigation) return;
  toolsWindow = toolsMenu.value.ownerDocument.defaultView || undefined;
  toolsWindow?.addEventListener('resize', fitToolsMenu);
  fitToolsMenu();
}
function closeTools(restoreFocus = false): void {
  stopToolsSizing();
  if (!toolsMenu.value) return;
  toolsMenu.value.open = false;
  if (restoreFocus) toolsMenu.value.querySelector('summary')?.focus({preventScroll: true});
}
function dismissTools(): boolean {
  if (!toolsMenu.value?.open) return false;
  closeTools(true);
  return true;
}
defineExpose({dismissTools, dismissToolsOutside, closeTools, stop,
  getCompletedAnswer: () => busy.value || stopped.value || error.value ? '' : answer.value});
function dismissToolsOutside(event: Event): void {
  if (toolsMenu.value?.open && !toolsMenu.value.contains(event.target as Node)) closeTools();
}
function closeToolsAfterAction(event: MouseEvent): void {
  if (toolsMenu.value?.open && (event.target as Element).closest('button')) closeTools(true);
}
// 两种布局共用同一组工具；统一导航将入口传送到父卡片顶栏固定槽，独立面板保留原有工具栏。
const ReadingTools = () => {
  const button = (label: string, onClick: () => unknown, attrs: Record<string, unknown> = {}) => h('button', {type: 'button', onClick, ...attrs}, translateLegacy(label));
  return h('details', {ref: toolsMenu, class: 'fr-reading-tools', onToggle: toggleTools, onKeydown: withKeys(withModifiers(() => closeTools(true), ['stop', 'prevent']), ['esc'])}, [
    h('summary', {'aria-label': translateLegacy('更多操作'), title: translateLegacy('更多操作')}, [
      h('svg', {viewBox: '0 0 24 24', width: 18, height: 18, fill: 'currentColor', 'aria-hidden': 'true'}, [5, 12, 19].map(cx => h('circle', {cx, cy: 12, r: 1.7}))),
    ]),
    h('div', {class: 'fr-reading-tool-list', onClick: closeToolsAfterAction}, [
      button(t('reading.viewSource'), showSource, {'data-i18n-ignore': '', onClick: (event: MouseEvent) => { event.stopPropagation(); showSource(); }}),
      button('重新生成', regenerate, {disabled: busy.value || !actionSupported.value, title: actionSupported.value ? undefined : generationHint.value}),
      button(props.playingSourceText === activeText.value ? '停止朗读' : '朗读原文', () => emit('play-source', activeText.value), {'aria-pressed': props.playingSourceText === activeText.value}),
      !historicalText.value && props.selection.sentence !== props.selection.text && !wholeSentence.value ? button('理解整句', expandSentence) : null,
      canSaveWord.value && (busy.value || !answer.value) ? button(saved.value ? '已收藏原文' : '收藏原文', saveWord, {disabled: saving.value || saved.value, title: t('reading.saveSourceTitle')}) : null,
      !props.privateContext ? button('阅读记录', openRecords) : null,
      button('设置', () => openSettings(), {'aria-label': translateLegacy('打开划词翻译设置')}),
      h('p', [translateLegacy(props.privateContext ? '隐私模式：不保存记录' : '阅读记录保存在本机 30 天'),
        model.value ? h('span', {'data-i18n-ignore': ''}, model.value) : null,
        memoryCount.value ? h('span', {'data-i18n-ignore': ''}, t('reading.memoryReferences', {count: memoryCount.value})) : null]),
    ]),
  ]);
};
// 两种布局始终在正文滚动区外挂载同一组追问节点；缩小视口或切换导航不替换输入及其输入法状态。
const ReadingFollowUp = withCtx(() => {
  const stopKey = (event: Event) => event.stopPropagation();
  const feedbackLine = (text: string) => text ? h('p', {class: 'fr-reading-feedback', role: 'status'}, text) : null;
  return [followUpSupported.value ? h('form', {class: 'fr-reading-followup', onSubmit: withModifiers(ask, ['prevent'])}, [
    withDirectives(h('input', {
      'onUpdate:modelValue': (value: string) => { question.value = value; }, disabled: busy.value || !actionSupported.value, maxlength: '1000', 'aria-label': '继续追问',
      placeholder: intent.value === 'practice' ? '写下你的练习答案…' : '继续问这句话…', onKeydown: stopKey, onKeyup: stopKey, onInput: () => { feedback.value = ''; },
    }), [[vModelText, question.value]]),
    h('button', {type: 'submit', disabled: busy.value || !actionSupported.value || !question.value.trim(), 'aria-label': '发送追问', title: '发送追问'}, '↑'),
  ]) : null, feedbackLine(feedback.value), feedbackLine(sessionWarning.value)];
}, getCurrentInstance()) as () => VNodeChild;
const previousAnswers = ref<Array<ReadingTurn & {id: string; intent: HarnessActionId; status: HarnessStoredTurnStatus; evidenceSources?: readonly ReadingEvidenceSource[]}>>([]);
const currentTurnKey = ref('');
const priorAnswers = computed(() => previousAnswers.value.filter(turn => turn.id !== currentTurnKey.value));
const historyDetails = ref<HTMLDetailsElement>();
const expandedTurnId = ref('');
function toggleHistoryTurn(id: string): void {
  cancelReadingPosition();
  expandedTurnId.value = expandedTurnId.value === id ? '' : id;
}
watch(currentTurnKey, () => {
  expandedTurnId.value = '';
  if (historyDetails.value) historyDetails.value.open = false;
});
const sessionOffset = ref(0);
const hasMoreSessions = ref(false);
const actionLabels: Record<string, string> = {meaning: '读懂', grammar: '词性与句法', usage: '用法', practice: '练习'};
const statusLabels: Record<string, string> = {streaming: '进行中', completed: '已完成', stopped: '已停止', error: '失败'};
const actionLabelFor = (value: string) => actionLabels[value] || '学习';
const statusLabel = (value: string) => statusLabels[value] || '未知状态';
const formatDate = useRenderDateFormatter({month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const history: ReadingTurn[] = [];
const canSaveWord = computed(() => props.vocabularyEnabled && !props.privateContext && Boolean(normalizeLearningSourceText(activeText.value)));
interface CachedAnswer {
  evidenceSources: readonly ReadingEvidenceSource[];
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
  cancelReadingPosition();
  props.clearEvidence?.();
  generation += 1;
  streamHandle?.cancel();
  streamHandle = undefined;
  busy.value = false;
}
function stop(): void { cancelRequest(); stopped.value = true; }
function sourceStillCurrent(): boolean {
  if (historicalText.value) return true;
  const status = props.checkEvidence?.();
  if (status !== 'changed' && status !== 'navigated') return true;
  stop();
  return false;
}
function archiveAnswer(): void {
  if (!answer.value || !currentTurnKey.value) return;
  const turn = {evidenceSources: evidenceSources.value, id: currentTurnKey.value, question: currentQuestion.value, answer: answer.value, intent: intent.value, status: (busy.value || stopped.value ? 'stopped' : error.value ? 'error' : 'completed') as HarnessStoredTurnStatus};
  const existing = previousAnswers.value.findIndex(item => item.id === turn.id);
  if (existing >= 0) previousAnswers.value[existing] = turn;
  else previousAnswers.value.push(turn);
  if (previousAnswers.value.length > 60) previousAnswers.value.splice(0, previousAnswers.value.length - 60);
}
function rememberAnswer(): void {
  actionCache.set(intent.value, {evidenceSources: evidenceSources.value, id: currentTurnKey.value, answer: answer.value, question: currentQuestion.value, model: model.value, history: copyTurns(history), lastHistory: copyTurns(lastHistory), memoryCount: memoryCount.value, anchorTurnId, lastAnchorTurnId});
}
function restoreAnswer(cached: CachedAnswer): void {
  evidenceSources.value = cached.evidenceSources;
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
  resetReadingPosition();
}
async function run(prompt: string, turns: ReadingTurn[], retrying = false): Promise<void> {
  if (!actionSupported.value || (prompt && !followUpSupported.value)) { feedback.value = generationHint.value; return; }
  const requestAnchor = prompt ? (retrying ? lastAnchorTurnId : anchorTurnId) : '';
  if (!retrying) archiveAnswer();
  cancelRequest();
  const token = generation;
  evidenceSources.value = requestEvidenceSources.value;
  const requestId = `reading-${crypto.randomUUID()}`;
  currentTurnKey.value = requestId;
  lastQuestion = prompt;
  lastHistory = turns.map(turn => ({...turn}));
  lastAnchorTurnId = requestAnchor;
  anchorTurnId = '';
  answer.value = '';
  memoryCount.value = 0;
  remembered.value = false;
  currentQuestion.value = prompt;
  showRecords.value = false;
  resetReadingPosition();
  busy.value = true;
  error.value = '';
  stopped.value = false;
  copied.value = false;
  feedback.value = '';
  try {
    const materialOperation = beginMaterialCapture(historicalText.value ? undefined : props.selection.material, props.privateContext);
    streamHandle = streamReading({
      type: 'fluentReadHarness', action: 'run', requestId,
      selection: {text: activeText.value, context: props.preferences.contextMode === 'paragraph' ? historicalContext.value || props.selection.context : '', sentence: ''},
      intent: intent.value, question: prompt, history: turns, ...(sessionId ? {sessionId} : {}),
      ...(sessionId && requestAnchor ? {anchorTurnId: requestAnchor} : {}),
    }, {
      progress: progress => {
        if (token !== generation || !sourceStillCurrent()) return;
        if (progress.kind === 'model') model.value = progress.model;
        if (progress.kind === 'text') answer.value = progress.text;
        if (progress.kind === 'session') { sessionId = progress.persistent ? (progress.sessionId || '') : ''; anchorTurnId = progress.persistent ? (progress.turnId || '') : ''; if (progress.warning) sessionWarning.value = progress.warning; }
        if (progress.kind === 'memory') { memoryCount.value = progress.count; if (progress.warning) feedback.value = progress.warning; }
      },
      result: response => {
        if (token !== generation || !sourceStillCurrent()) return;
        busy.value = false;
        streamHandle = undefined;
        if (!response.success) { if (response.cancelled) stopped.value = true; else error.value = response.error; return; }
        currentQuestion.value = prompt;
        answer.value = response.text;
        model.value = response.model;
        if (response.sessionId) sessionId = response.sessionId;
        if (response.sessionId) {const excerpt = activeText.value; void materialOperation.then(operation => completeMaterialCapture(operation, {kind: 'session', id: response.sessionId!, excerpt}, () => token === generation && sourceStillCurrent()));}
        if (response.turnId) anchorTurnId = response.turnId;
        if (response.persistenceWarning) sessionWarning.value = response.persistenceWarning;
        memoryCount.value = response.memoryCount || 0;
        history.splice(0, history.length, ...turns, {question: prompt || actionLabel.value, answer: response.text});
        if (history.length > 4) history.splice(0, history.length - 4);
        rememberAnswer();
      },
      error: failure => {
        if (token !== generation || !sourceStillCurrent()) return;
        busy.value = false;
        streamHandle = undefined;
        if (!stopped.value) error.value = failure.message;
      },
    });
  } catch (failure) {
    if (token === generation) { busy.value = false; error.value = failure instanceof Error ? failure.message : '请求失败，请重试。'; }
  }
}
function chooseAction(action: HarnessActionId): void {
  // 已选标签不重置阅读位置或未发送的追问；重新生成仍通过明确的次级操作触发。
  if (action !== intent.value || !currentTurnKey.value) startAction(action);
}
function startAction(action: HarnessActionId, preserveHistory = true): void {
  closeTools();
  if (!actions.value.some(item => item.id === action)) return;
  showRecords.value = false;
  if (preserveHistory && action === intent.value && busy.value) return;
  if (preserveHistory) archiveAnswer();
  cancelRequest();
  intent.value = action;
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
  evidenceSources.value = buildReadingEvidence(session.text, session.context);
  sessionId = session.id;
  wholeSentence.value = false;
  const latest = session.turns.at(-1);
  currentTurnKey.value = latest?.id || '';
  // 仓库存的动作名称用于记录展示，不能在重试时变成用户的追问。
  currentQuestion.value = latest?.question === actionLabelFor(latest?.intent || session.intent) ? '' : latest?.question || '';
  answer.value = latest?.answer || '';
  intent.value = latest?.intent || session.intent;
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
    actionCache.set(turn.intent, {evidenceSources: evidenceSources.value, id: turn.id, answer: turn.answer, question: turn.question === actionLabelFor(turn.intent) ? '' : turn.question, model: turn.model, history: [...before, {question: turn.question, answer: turn.answer}].slice(-4), lastHistory: before, memoryCount: 0, anchorTurnId: turn.id, lastAnchorTurnId: session.turns.slice(0, index).findLast(item => item.intent === turn.intent && item.answer.trim())?.id || ''});
  }
  error.value = latest?.status === 'error' ? '上次生成失败，已保留收到的内容' + (retrySupported.value ? '，可以重试。' : '。') : '';
  stopped.value = latest?.status === 'stopped' || latest?.status === 'streaming'; saved.value = false;
  feedback.value = followUpSupported.value && actionSupported.value ? '已打开上次的问答，可以继续追问。' : '已打开上次的问答。';
  recordsError.value = ''; showRecords.value = false;
  resetReadingPosition();
}
function expandSentence(): void { wholeSentence.value = true; sessionId = ''; historicalText.value = ''; saved.value = false; startAction(intent.value, false); }
function ask(): void {
  const prompt = question.value.trim();
  if (!followUpSupported.value || !prompt || busy.value) return;
  if (!actionSupported.value) { feedback.value = generationHint.value; return; }
  question.value = '';
  void run(prompt, history.map(turn => ({...turn})));
}
function retry(): void { void run(lastQuestion, lastHistory, true); }
async function openSettings(section = 'settings-selection'): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section}) as {success?: unknown} | undefined;
    if (response?.success !== true) throw new Error('打开设置失败');
  } catch { feedback.value = section === 'settings-services' ? '打开设置失败，请从扩展菜单进入“翻译服务”。' : '打开设置失败，请从专项翻译进入“划词翻译”。'; }
}
function readableAnswer(): string {
  return readingEvidenceText(answer.value, evidenceSources.value, {evidence: t('reading.evidence.label'), unverified: t('reading.evidence.unverified'), external: t('reading.evidence.external')});
}
async function copyAnswer(): Promise<void> {
  const owner = generation;
  try {
    await navigator.clipboard.writeText(`${activeText.value}\n\n${readableAnswer()}`);
    if (owner !== generation || !props.active) return;
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1800);
  } catch { if (owner === generation && props.active) feedback.value = '复制失败，可以选中回答后复制。'; }
}
async function openLearningMemory(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-vocabulary', learningTab: 'memory'}) as {success?: boolean} | undefined;
    if (!response?.success) throw new Error(t('reading.openNotesFailed'));
  } catch (failure) { feedback.value = failure instanceof Error ? failure.message : t('reading.openNotesFailed'); }
}
async function openLearningCollection(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-vocabulary', learningTab: 'saved'}) as {success?: boolean} | undefined;
    if (!response?.success) throw new Error(t('reading.openSavedFailed'));
  } catch (failure) { feedback.value = failure instanceof Error ? failure.message : t('reading.openSavedFailed'); }
}
async function rememberLearning(): Promise<void> {
  if (props.privateContext || busy.value || stopped.value || error.value || !answer.value || remembering.value || remembered.value) return;
  const owner = currentTurnKey.value;
  const epoch = generation;
  const isCurrent = () => epoch === generation && currentTurnKey.value === owner && props.active && !props.privateContext;
  remembering.value = true;
  try {
    const operation = await beginMaterialCapture(historicalText.value ? undefined : props.selection.material, props.privateContext);
    if (!isCurrent()) return;
    const memory = await saveLearningMemory({kind: 'lesson', content: `原文：${activeText.value.slice(0, 350)}\n${currentQuestion.value ? `问题：${currentQuestion.value.slice(0, 200)}\n` : ''}学习要点：${readableAnswer().slice(0, 1400)}`});
    await completeMaterialCapture(operation, {kind: 'memory', id: memory.id, excerpt: activeText.value}, isCurrent);
    if (isCurrent()) { remembered.value = true; feedback.value = t('reading.noteSaved'); }
  } catch (failure) { if (isCurrent()) feedback.value = failure instanceof Error ? failure.message : t('reading.noteSaveFailed'); }
  finally { remembering.value = false; }
}
async function saveWord(): Promise<void> {
  if (!canSaveWord.value || saving.value) return;
  saving.value = true;
  const savingText = activeText.value;
  const epoch = generation;
  const isCurrent = () => epoch === generation && activeText.value === savingText && props.active && canSaveWord.value;
  try {
    const operation = await beginMaterialCapture(historicalText.value ? undefined : props.selection.material, props.privateContext);
    if (!isCurrent()) return;
    const response = await browser.runtime.sendMessage({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input: {
      sourceLanguage: props.sourceLanguage && props.sourceLanguage !== 'auto' ? props.sourceLanguage : detectlang(savingText), targetLanguage: props.targetLanguage, term: normalizeLearningSourceText(savingText),
      translation: activeTranslation.value?.text || '', context: {text: historicalContext.value || props.selection.context || activeText.value},
    }}) as VocabularyBookResponse;
    if (!response.success) throw new Error(response.error.message);
    const id = (response.data as {id?: unknown})?.id;
    if (typeof id === 'string') await completeMaterialCapture(operation, {kind: 'vocabulary', id, excerpt: savingText}, isCurrent);
    if (isCurrent()) { saved.value = true; feedback.value = t('reading.sourceSaved'); }
  } catch (failure) { if (isCurrent()) feedback.value = failure instanceof Error ? failure.message : '收藏失败，请重试。'; }
  finally { saving.value = false; }
}
watch(() => JSON.stringify([props.preferences, effectiveService.value, props.targetLanguage, props.sourceLanguage, props.modelRevision]), () => { actionCache.clear(); cancelRequest(); stopped.value = true; feedback.value = '设置已更新，重新生成可使用新的设置。'; });
watch(() => JSON.stringify(props.selection), () => {
  actionCache.clear(); cancelRequest(); restoreEpoch += 1;
  sourceExpanded.value = false;
  historicalText.value = ''; historicalContext.value = ''; previousAnswers.value = []; history.splice(0);
  sessionId = ''; anchorTurnId = ''; lastAnchorTurnId = ''; lastQuestion = ''; lastHistory = [];
  currentTurnKey.value = ''; currentQuestion.value = ''; question.value = ''; answer.value = '';
  error.value = ''; stopped.value = false; model.value = ''; memoryCount.value = 0;
  wholeSentence.value = false; saved.value = false; remembered.value = false; copied.value = false;
  feedback.value = ''; sessionWarning.value = ''; clearTimeout(copyTimer);
});
watch(activeText, text => { sourceExpanded.value = false; closeTools(); saved.value = false; emit('source-change', text); });
watch(() => [props.initialAction, props.historyOnly, props.active] as const, ([action, only, active], [oldAction, oldOnly, oldActive]) => {
  // 父导航回写当前视图只同步标签，不能把历史动作改为默认动作或重复生成。
  if (active === oldActive && action === intent.value && Boolean(only) === showRecords.value) return;
  restoreEpoch += 1;
  if (!active) { props.clearEvidence?.(); closeTools(); emit('source-change', ''); if (busy.value) stop(); return; }
  if (only) openRecords();
  else if (action !== oldAction || oldOnly || !oldActive) startAction(availableInitialAction(action));
});
// 面板和正文滚动区由父卡片约束高度；回答增长只改变 scrollHeight，
// 首次出现、清空和生成状态仍通知父卡片，连续文本块不重复要求父卡片读取选区与卡片尺寸。
watch([busy, error, () => Boolean(answer.value), stopped, feedback, wholeSentence, sourceExpanded], () => emit('resize'), {flush: 'post'});
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
  closeTools();
  props.clearEvidence?.();
  cancelReadingPosition();
  restoreEpoch += 1;
  showRecords.value = true;
  recordsGeneration += 1;
  recordsLoading.value = false;
  sessions.value = []; sessionOffset.value = 0; hasMoreSessions.value = false;
  void loadMoreSessions();
}
function closeRecords(): void { restoreEpoch += 1; showRecords.value = false; recordsError.value = ''; if (!currentTurnKey.value && !answer.value && !busy.value && props.active) startAction(availableInitialAction(props.initialAction)); else resetReadingPosition(); }
onMounted(() => {
  if (!props.active) return;
  if (props.historyOnly) openRecords();
  else startAction(intent.value);
});
watch(() => [props.toolsTarget, props.externalNavigation], () => closeTools());
onBeforeUnmount(() => { closeTools(); recordsGeneration += 1; restoreEpoch += 1; cancelRequest(); emit('source-change', ''); clearTimeout(copyTimer); history.splice(0); actionCache.clear(); });
</script>

<style scoped>
.fr-reading, .fr-reading-controls { --fr-reading-line: #eee8ec; --fr-reading-muted: #756a74; --fr-reading-button: #826573; --fr-reading-soft: #faf7f9; color: #35333c; font: 13px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.fr-reading { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; padding: 6px 14px 10px; overflow: hidden; }
.fr-reading-controls { display: flex; align-items: center; gap: 3px; }
.fr-reading-navigation { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; color: var(--fr-reading-muted); font-size: 11px; }
.fr-reading-navigation button { color: #a64b6e; }
.fr-reading-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 2px 5px 4px 0; }
.fr-reading-result { position: relative; overflow-anchor: none; }
/* Overlay 滚动条不占 scrollbar-gutter；留出其命中区域与控件焦点轮廓。 */
.fr-reading-result-external { padding-inline-end: 20px; }
.fr-reading-records .fr-reading-hint { margin-top: 0; }
.fr-reading-session-list { display: grid; gap: 4px; padding-bottom: 8px; }
.fr-reading .fr-reading-session { display: grid; gap: 6px; width: 100%; padding: 10px; text-align: left; color: inherit; background: var(--fr-reading-soft); border: 1px solid var(--fr-reading-line); font-size: 12px; }
.fr-reading-session > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.fr-reading-session small { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px; color: var(--fr-reading-muted); font-size: 10px; }
.fr-reading-session small span { color: #a64b6e; }
.fr-reading-empty { padding: 16px 6px; color: var(--fr-reading-muted); font-size: 12px; }
.fr-reading-session-detail { margin: 0 0 14px; border-bottom: 1px solid var(--fr-reading-line); padding-bottom: 8px; }
.fr-reading-session-detail > summary { padding: 5px 0; color: var(--fr-reading-muted); cursor: pointer; font-size: 11px; }
.fr-reading-turn-list { display: grid; gap: 8px; margin: 8px 0 4px; }
.fr-reading-turn { min-width: 0; border: 1px solid var(--fr-reading-line); border-radius: 9px; overflow-wrap: anywhere; }
.fr-reading .fr-reading-turn-toggle { display: grid; gap: 5px; width: 100%; padding: 9px 10px; border-radius: 8px; text-align: start; color: inherit; background: var(--fr-reading-soft); }
.fr-reading-turn-toggle:hover { box-shadow: inset 0 0 0 1px var(--fr-reading-line); }
.fr-reading-turn-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--fr-reading-muted); font-size: 10px; }
.fr-reading-turn-status { padding: 1px 5px; border: 1px solid var(--fr-reading-line); border-radius: 4px; font-size: inherit; }
.fr-reading-turn-chevron { margin-inline-start: auto; flex-shrink: 0; }
.fr-reading-turn-toggle[aria-expanded='true'] .fr-reading-turn-chevron { transform: rotate(90deg); }
.fr-reading-turn-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 500; white-space: pre-wrap; }
.fr-reading-turn-toggle[aria-expanded='true'] .fr-reading-turn-title { display: block; }
.fr-reading-turn-answer { padding: 10px; border-top: 1px solid var(--fr-reading-line); user-select: text; }
.fr-reading-role { display: block; margin-bottom: 4px; color: var(--fr-reading-muted); font-size: 10px; }
.fr-reading-current-label { margin: 0 0 8px; color: var(--fr-reading-muted); font-size: 11px; font-weight: 600; }
.fr-reading button, .fr-reading input, .fr-reading-controls > button, .fr-reading-tools :deep(button) { font: inherit; }
.fr-reading button, .fr-reading-controls > button, .fr-reading-tools :deep(button) { cursor: pointer; border: 0; background: none; color: var(--fr-reading-button); padding: 3px 6px; border-radius: 6px; }
.fr-reading button:focus-visible, .fr-reading input:focus-visible, .fr-reading-controls > button:focus-visible, .fr-reading-tools :deep(button:focus-visible) { outline: 2px solid #cd527f; outline-offset: 2px; }
.fr-reading button:disabled, .fr-reading-controls > button:disabled, .fr-reading-tools :deep(button:disabled) { opacity: .5; cursor: default; }
.fr-reading-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding-bottom: 8px; }
.fr-reading-actions { display: flex; flex-wrap: wrap; flex: 1; min-width: 0; gap: 4px; border-bottom: 1px solid var(--fr-reading-line); }
.fr-reading-actions button { flex: 1 1 auto; min-width: 0; max-width: 100%; min-height: 32px; padding: 4px 6px; border-radius: 0; border-bottom: 2px solid transparent; color: var(--fr-reading-muted); font-size: 12px; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.fr-reading-actions button[aria-pressed='true'] { border-bottom-color: #b85579; color: #9d3e61; font-weight: 600; }
.fr-reading-actions button:hover, .fr-reading-tools :deep(summary:hover) { background: var(--fr-reading-soft); }
.fr-reading-tools { position: relative; flex: 0 0 auto; }
.fr-reading-controls > .fr-reading-inline-stop { flex: 0 0 32px; width: 32px; height: 32px; padding: 0; font-size: 12px; }
.fr-reading-accessible-status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.fr-reading-tools :deep(summary) { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 6px; list-style: none; cursor: pointer; color: var(--fr-reading-muted); }
.fr-reading-tools :deep(summary::-webkit-details-marker) { display: none; }
.fr-reading summary:focus-visible, .fr-reading-tools :deep(summary:focus-visible) { outline: 2px solid #cd527f; outline-offset: 2px; }
.fr-reading-tools :deep(.fr-reading-tool-list) { position: absolute; z-index: 3; inset-inline-end: 0; top: 36px; width: min(204px, calc(100vw - 24px)); box-sizing: border-box; max-height: min(310px, 55vh); overflow: auto; overscroll-behavior: contain; padding: 5px; background: var(--fr-reading-menu, #fff); border: 1px solid var(--fr-reading-line); border-radius: 9px; box-shadow: 0 5px 18px #0002; }
.fr-reading-tools :deep(.fr-reading-tool-list button) { display: block; width: 100%; min-height: 30px; text-align: start; font-size: 12px; padding: 4px 8px; color: inherit; }
.fr-reading-tools :deep(.fr-reading-tool-list button:hover) { background: var(--fr-reading-soft); }
.fr-reading-tools :deep(.fr-reading-tool-list p) { border-top: 1px solid var(--fr-reading-line); margin: 4px 0 0; padding: 6px 8px 3px; color: var(--fr-reading-muted); font-size: 10px; overflow-wrap: anywhere; }
.fr-reading-tools :deep(.fr-reading-tool-list p span) { display: block; }
.fr-reading-source { margin: 0 0 10px; color: var(--fr-reading-muted); font-size: 12px; }
.fr-reading .fr-reading-source-return { display: block; margin-bottom: 6px; padding-inline-start: 0; }
.fr-reading-source > span { font-size: 11px; }
.fr-reading-translation { margin-top: 10px; }
.fr-reading-translation > span { font-size: 11px; }
.fr-reading-source p { margin: 4px 0 0; padding-inline-start: 12px; border-inline-start: 2px solid var(--fr-reading-line); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.fr-reading-body { min-height: 100%; display: flow-root; }
.fr-reading-body-external { min-height: 0; }
.fr-reading-status { display: flex; align-items: center; gap: 8px; color: var(--fr-reading-muted); font-size: 12px; }
.fr-reading-status button { margin-left: auto; }
.fr-reading-pulse { width: 6px; height: 6px; border-radius: 50%; background: #c76688; animation: fr-reading-breathe 1.4s ease-in-out infinite; }
.fr-reading-static { animation: none; }
.fr-reading-hint, .fr-reading-feedback { font-size: 12px; color: var(--fr-reading-muted); }
.fr-reading-feedback { flex-shrink: 0; margin: 5px 0 0; max-height: 40px; overflow: auto; }
.fr-reading-error { font-size: 12px; color: #b44753; background: #fff4f4; padding: 8px 10px; border-radius: 9px; }
.fr-reading-error p { margin: 0 0 4px; }
.fr-reading-question { margin: 0 0 12px; padding: 8px 10px; border-inline-start: 2px solid #b85579; border-radius: 0 7px 7px 0; background: var(--fr-reading-soft); color: inherit; user-select: text; overflow-wrap: anywhere; }
.fr-reading-question p { margin: 0; white-space: pre-wrap; }
.fr-reading-answer { user-select: text; overflow-wrap: anywhere; }
.fr-reading-footer { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin: 8px 0 0; font-size: 11px; }
.fr-reading-followup { flex-shrink: 0; display: flex; gap: 6px; margin-top: 6px; padding: 3px 3px 3px 10px; border: 1px solid #eae2e7; border-radius: 11px; }
.fr-reading-followup input { min-width: 0; flex: 1; width: 100%; border: 0; outline: none; color: inherit; background: transparent; font-size: 12px; user-select: text; }
.fr-reading-followup input::placeholder { color: var(--fr-reading-muted); font-size: 11px; }
.fr-reading-followup button { background: #b85579; color: white; width: 28px; height: 28px; line-height: 20px; }
.fr-dark-theme .fr-reading, .fr-dark-theme .fr-reading-controls { --fr-reading-line: #514651; --fr-reading-muted: #b6a9b5; --fr-reading-button: #e4a0bc; --fr-reading-soft: #352f38; --fr-reading-menu: #29242d; color: #e6e0e8; }
.fr-dark-theme .fr-reading-actions button { color: #bdb0c1; }
.fr-dark-theme .fr-reading-actions button[aria-pressed='true'] { border-bottom-color: #e4a0bc; color: #f1b6ce; }
.fr-dark-theme .fr-reading-followup { border-color: #554651; }
.fr-dark-theme .fr-reading-error { background: #482e35; color: #f5acb6; }
.fr-dark-theme .fr-reading-navigation button, .fr-dark-theme .fr-reading-session small span, .fr-dark-theme .fr-reading-question { color: #e4a0bc; }
@media (max-height: 420px) { .fr-reading-toolbar { padding-bottom: 4px; } .fr-reading-followup { margin-top: 4px; } }
/* 避免 Safari 聚焦小字号追问框时自动放大、滚动宿主页并收起卡片。 */
@media (any-pointer: coarse) {
  .fr-reading-followup input, .fr-reading-followup input::placeholder { font-size: 16px; }
  .fr-reading button, .fr-reading .fr-reading-session, .fr-reading summary,
  .fr-reading-controls > button, .fr-reading-controls > .fr-reading-inline-stop,
  .fr-reading-tools :deep(button), .fr-reading-tools :deep(.fr-reading-tool-list button),
  .fr-reading-tools :deep(summary) { min-width: 44px; min-height: 44px; font-size: 14px; }
  .fr-reading-controls > .fr-reading-inline-stop { flex-basis: 44px; width: 44px; height: 44px; }
  .fr-reading-tools :deep(.fr-reading-tool-list) { top: 48px; }
}
@keyframes fr-reading-breathe { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .fr-reading-pulse { animation: none; } }
</style>
