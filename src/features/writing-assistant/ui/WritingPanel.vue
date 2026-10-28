<!--
 * @file src/features/writing-assistant/ui/WritingPanel.vue
 * 文件职责：承载网页回复的写作流程，在固定卡片中起草、核对引用、调整风格并插回当前编辑器。
 * 主要内容：让多语言标题、语言选择与操作按可用空间换行；统一配置就绪提示、草稿和请求状态，保留失败任务的语义以便准确重试；偏好保存、复制及设置打开的迟到结果受当前会话/草稿约束，关闭或切换会话立即释放旧保存状态；正文优先布局、输入按需展开，支持分层返回、键盘提交、未完成版本提示与当前完整译文的双语插入。
 * 模块边界：不自行读取网页或发送回复，引用由宿主传入；后台负责模型请求，编辑器快照负责写回，Gmail 仅插入可读纯文本。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor" :width="640">
    <section v-show="active" v-ui-i18n ref="panel" class="writing-panel" :class="{'is-dark': dark}" role="dialog" aria-label="写作助手" tabindex="-1" @keydown="handleKeydown">
      <header class="writing-header">
        <img :src="icon" alt="" class="writing-mark" /><h2>写作助手</h2>
        <span v-if="supported" class="writing-provider" :title="displayModel" data-i18n-ignore>{{ serviceLabel }}</span>
        <button type="button" class="writing-settings" aria-label="写作设置" title="写作设置" @click="openSettings"><Setting /><span>设置</span></button>
        <button type="button" class="writing-icon" aria-label="关闭写作助手" @click="emit('close')"><Close /></button>
      </header>
      <div v-if="(!readiness.ready || credentialError) && !hasDraft" class="writing-setup">
        <h3>{{ !supported ? '先选择一个 AI 服务' : t('writing.experience.setupTitle') }}</h3><p>{{ !supported ? '使用你已配置的服务来写作，之后即可从回复框直接开始。' : readiness.message || error }}</p>
        <button type="button" class="writing-button primary" @click="openSettings">设置写作服务</button>
        <button v-if="credentialError && lastAttempt" type="button" class="writing-text-button" @click="retry">重试</button>
      </div>
      <template v-else>
        <WritingStyleEditor v-if="view === 'style'" :model-value="stylePreferences" :action-label="styleAction" :saving="saving" @apply="applyStyle" @cancel="view = 'answer'" />
        <WritingLanguagePicker v-else-if="view === 'language' || view === 'reference-language'" :model-value="view === 'reference-language' ? config.writing.referenceLanguage : language" :reference="view === 'reference-language'" :target-label="view === 'reference-language' ? interfaceLanguageLabel : targetLabel" :disabled="saving" @select="view === 'reference-language' ? applyReferenceLanguage($event) : applyLanguage($event)" @cancel="view = 'answer'" />
        <template v-else>
          <div class="writing-language-bar">
            <button type="button" class="writing-language-trigger" :disabled="busy || saving" aria-label="输出语言" :title="language === 'target' ? '跟随目标语言' : '输出语言'" @click="view = 'language'"><small>{{ t('writing.replyLanguage') }}</small><span>{{ outputLanguageLabel }}</span><ArrowDown /></button>
            <button type="button" class="writing-reference-trigger" :disabled="busy || saving" :aria-label="t('writing.referenceLanguage')" :title="sameReferenceLanguage ? t('writing.referenceSameLanguage') : t('writing.referenceFootnote')" @click="view = 'reference-language'"><small>{{ t('writing.referenceLanguage') }}</small><span>{{ referenceLanguageLabel }}</span><ArrowDown /></button>
          </div>
          <div class="writing-main">
            <div class="writing-title"><h3>{{ view === 'reference' ? '参考内容' : busy ? (hasDraft ? '正在调整…' : '正在起草…') : hasDraft ? '回复草稿' : '想怎么回复？' }}</h3>
              <div v-if="versions.length > 1 && view !== 'reference'" class="writing-versions"><button type="button" class="writing-icon" :disabled="busy || versionIndex === 0" aria-label="上一版" @click="switchVersion(-1)"><ArrowLeft /></button><span>{{ versionIndex + 1 }}/{{ versions.length }}</span><button type="button" class="writing-icon" :disabled="busy || versionIndex === versions.length - 1" aria-label="下一版" @click="switchVersion(1)"><ArrowRight /></button></div>
              <button v-if="view === 'reference'" type="button" class="writing-text-button" @click="view = 'answer'">返回草稿</button>
              <button v-else-if="context || draft" type="button" class="writing-text-button" :disabled="busy" @click="showReference">参考内容</button>
            </div>
            <div v-if="view === 'reference'" class="writing-reference">
              <label v-if="draft">原有草稿<textarea :value="draft" readonly rows="3" aria-label="写作草稿" /></label>
              <label>项目与讨论<textarea v-model="referenceDraft" rows="8" maxlength="12000" aria-label="写作参考内容" /></label>
              <div class="writing-reference-footer"><span>核对参考信息后，重新起草回复。</span><button type="button" class="writing-button primary" :disabled="!referenceDraft.trim() && !draft.trim() && !instruction.trim()" @click="restartFromReference">重新起草</button></div>
            </div>
            <textarea v-else-if="view === 'edit'" v-model="visibleText" class="writing-output" aria-label="生成正文" spellcheck="true" maxlength="12000" />
            <div v-else-if="result || busy" class="writing-preview" role="region" aria-label="生成正文预览" :aria-busy="busy">
              <ReadingAnswer v-if="visibleText" :text="visibleText" :compact="false" /><p v-else class="writing-loading">正在组织语言…</p>
              <section v-if="!busy && showReferenceTranslation && result" class="writing-translation" data-writing-reference :aria-label="t('writing.referenceHeading', {language: referenceLanguageLabel})" :aria-busy="referenceState.status === 'loading'">
                <h4>{{ t('writing.referenceHeading', {language: referenceLanguageLabel}) }}</h4>
                <ReadingAnswer v-if="referenceState.text" :text="referenceState.text" :compact="false" />
                <p v-if="referenceState.status === 'loading'" role="status">{{ t('writing.referenceLoading') }}</p>
                <p v-else-if="referenceState.status === 'error'" role="alert">{{ t('writing.referenceError') }} <button type="button" class="writing-text-button" @click="referenceController.retry()">{{ t('writing.referenceRetry') }}</button></p>
                <p v-else-if="referenceState.status === 'too-long'">{{ t('writing.referenceTooLong') }}</p>
              </section>
            </div>
            <div v-else class="writing-empty">
              <p>{{ intent === 'draft' ? t('writing.experience.emptyDraft') : '写下回复要点，写作助手帮你整理成自然的表达。' }}</p>
              <div v-if="!draft && intent === 'draft'" class="writing-suggestions"><button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="useSuggestion(suggestion)">{{ suggestion }}</button></div>
              <button v-if="draft || context" type="button" class="writing-button" :disabled="!readiness.ready" @click="generate()">生成回复</button>
            </div>
          </div>
          <div v-if="view !== 'reference'" class="writing-actions">
            <p v-if="result && !busy && versions[versionIndex]?.incomplete" class="writing-notice">{{ t('writing.experience.incomplete') }}</p>
            <p v-if="result && !applyDraft" class="writing-notice">原草稿含格式，请复制后自行粘贴。</p>
            <div class="writing-toolbar">
              <div class="writing-preferences"><button type="button" class="writing-style-trigger" :disabled="busy || saving" aria-label="回答风格" :title="styleSummary" @click="view = 'style'"><Operation /><span>回答风格</span><small>{{ styleSummary }}</small><ArrowDown /></button></div>
              <button v-if="hasDraft && !busy" type="button" class="writing-icon" :aria-label="view === 'edit' ? '完成编辑' : '编辑正文'" :title="view === 'edit' ? '完成编辑' : '编辑正文'" @click="view = view === 'edit' ? 'answer' : 'edit'"><Check v-if="view === 'edit'" /><EditPen v-else /></button>
              <button v-if="hasDraft && !busy" type="button" class="writing-icon" :disabled="!result.trim()" aria-label="复制正文" title="复制正文" @click="copy()"><CopyDocument /></button>
              <button v-if="hasDraft && !busy" type="button" class="writing-icon" :disabled="!readiness.ready || saving || !canStart" aria-label="重新生成" title="重新生成" @click="generate()"><RefreshRight /></button>
              <button v-if="busy" type="button" class="writing-button" @click="stop">停止</button>
              <div v-else-if="hasDraft" ref="insertActions" class="writing-insert-actions" @focusout="closeInsertOnBlur">
                <button type="button" class="writing-button primary" :disabled="!result.trim()" @click="applyDraft ? apply() : copy()">{{ applyDraft ? '插入回复' : '复制回复' }}</button>
                <button type="button" class="writing-button primary writing-insert-toggle" :disabled="!result.trim()" :aria-label="t('writing.entry.insertOptions')" aria-haspopup="menu" :aria-expanded="insertOptionsOpen" @click="toggleInsertOptions" @keydown.down.stop.prevent="toggleInsertOptions(true)"><ArrowDown /></button>
                <div v-if="insertOptionsOpen" class="writing-insert-menu" role="menu" :aria-label="t('writing.entry.insertOptions')" @keydown.stop="handleInsertKeydown">
                  <button type="button" role="menuitem" @click="insertOptionsOpen = false; applyDraft ? apply() : copy()">{{ applyDraft ? '插入回复' : '复制回复' }}</button>
                  <button type="button" role="menuitem" :disabled="!canUseBilingual" @click="insertOptionsOpen = false; applyDraft ? apply(true) : copy(true)">{{ t(applyDraft ? 'writing.entry.insertBilingual' : 'writing.entry.copyBilingual') }}</button>
                  <small v-if="!canUseBilingual">{{ t(showReferenceTranslation ? 'writing.entry.waitReference' : 'writing.entry.chooseReference') }}</small>
                </div>
              </div>
            </div>
          </div>
          <form v-if="view !== 'reference'" class="writing-composer" :class="{'has-instruction': Boolean(instruction)}" @submit.prevent="generate()">
            <textarea ref="instructionInput" v-model="instruction" :disabled="busy || saving" rows="1" maxlength="2000" aria-label="写作要求" autocomplete="off" data-1p-ignore="true" data-lpignore="true" :placeholder="result ? '告诉我如何改进…' : '写下你想表达的要点…'" />
            <button type="submit" class="writing-button primary" :disabled="busy || saving || !readiness.ready || !instruction.trim()" :aria-label="result ? '改进草稿' : '生成回复'" :title="submitHint">{{ result ? '改进' : '生成' }}</button>
          </form>
        </template>
        <p v-if="!readiness.ready" class="writing-error" role="status">{{ readiness.message }} <button type="button" class="writing-text-button" @click="openSettings">写作设置</button></p>
        <p v-else-if="error" class="writing-error" role="alert">{{ error }} <button v-if="/配置|选择|请先/.test(error)" type="button" class="writing-text-button" @click="openSettings">写作设置</button><button v-else-if="view === 'answer' && lastAttempt" type="button" class="writing-text-button" :disabled="busy || saving" @click="retry">重试</button></p>
        <p v-if="notice" class="writing-notice writing-status" role="status">{{ notice }}</p>
      </template>
    </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {Setting, Close, ArrowLeft, ArrowRight, ArrowDown, CopyDocument, RefreshRight, EditPen, Check, Operation} from '@element-plus/icons-vue';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
import {writingPlainText} from '../markdown';
import {createWritingReference, type WritingReferenceState} from '../reference';
import {useUiI18n} from '@/src/ui/i18n';
import WritingStyleEditor from './WritingStyleEditor.vue';
import WritingLanguagePicker from './WritingLanguagePicker.vue';
import {config as initialConfig, subscribeConfig, requestConfigPatch} from '@/src/services/config/store';
import {options, services} from '@/src/core/config/catalog';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {resolveWritingReadiness} from '@/src/core/config/writingReadiness';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {WRITING_LANGUAGES, WRITING_LENGTHS, WRITING_TONES, resolveWritingLanguage, resolveWritingReferenceLanguage, type WritingPreferences, type WritingIntent} from '@/src/core/config/writing';
import type {WritingRequest} from '../types';
import {streamWriting} from '../client';
import WritingPopover from './WritingPopover.vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; initialDraft?: string; initialContext?: string; initialIntent?: WritingIntent; sessionKey?: number; plainTextOutput?: boolean; applyDraft?: (text: string) => string | undefined}>();
const emit = defineEmits<{close: []}>();
const {t, translateLegacy, language: uiLanguage} = useUiI18n();
const config = shallowRef(initialConfig); const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const icon = browser.runtime.getURL('/icon/128.png'); const panel = ref<HTMLElement>(); const instructionInput = ref<HTMLTextAreaElement>();
const draft = ref(''); const context = ref(''); const instruction = ref(''); const intent = ref<WritingIntent>('reply');
const language = ref(config.value.writing.language); const tone = ref(config.value.writing.tone); const length = ref(config.value.writing.length);
const style = ref(config.value.writing.style); const role = ref(config.value.writing.role);
const view = ref<'answer' | 'edit' | 'reference' | 'style' | 'language' | 'reference-language'>('answer'); const referenceDraft = ref(''); const saving = ref(false);
type StylePreferences = Pick<WritingPreferences, 'length' | 'style' | 'tone' | 'role'>;
const stylePreferences = computed(() => ({length: length.value, style: style.value, tone: tone.value, role: role.value}));
const styleSummary = computed(() => [WRITING_LENGTHS.find(item => item.value === length.value)!.label, WRITING_TONES.find(item => item.value === tone.value)?.label || '自定义'].map(value => translateLegacy(value)).join(' · '));
const suggestions = computed(() => [t('writing.experience.suggestionThanks'), t('writing.experience.suggestionProgress'), t('writing.experience.suggestionDecline')]);
const submitHint = `${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} + Enter`;
function useSuggestion(value: string) { instruction.value = translateLegacy(value); instructionInput.value?.focus({preventScroll: true}); }
const canStart = computed(() => Boolean(result.value.trim() || draft.value.trim() || context.value.trim() || instruction.value.trim()));
const styleAction = computed(() => result.value ? '应用并改写' : canStart.value ? '应用并起草' : '应用');
const languageLabel = (value: string) => (WRITING_LANGUAGES.find(item => item.value === value)?.label || value).split(' / ')[0];
const referenceLanguage = computed(() => resolveWritingReferenceLanguage(config.value.writing.referenceLanguage, uiLanguage.value));
const referenceLanguageLabel = computed(() => referenceLanguage.value ? translateLegacy(languageLabel(referenceLanguage.value)) : t('writing.referenceOff'));
const interfaceLanguageLabel = computed(() => translateLegacy(languageLabel(resolveWritingReferenceLanguage('ui', uiLanguage.value))));
const targetLabel = computed(() => languageLabel(resolveWritingLanguage('target', config.value.to)));
const displayedOutputLanguage = computed(() => showingPending.value ? requestedLanguage.value : resultLanguage.value || resolveWritingLanguage(language.value, config.value.to));
const outputLanguageLabel = computed(() => languageLabel(displayedOutputLanguage.value));
const sameReferenceLanguage = computed(() => Boolean(referenceLanguage.value && referenceLanguage.value === displayedOutputLanguage.value));
const showReferenceTranslation = computed(() => Boolean(referenceLanguage.value && !sameReferenceLanguage.value));
const busy = ref(false); const result = ref(''); const pending = ref(''); const error = ref(''); const notice = ref('');
type DraftVersion = {text: string; service: string; model: string; language: string; incomplete: boolean};
const versions = ref<DraftVersion[]>([]); const versionIndex = ref(0); let session: number | undefined | null = null; let attempted = false;
const hasDraft = computed(() => versions.value.length > 0);
const requestedLanguage = ref(''); const resultLanguage = ref('');
const actualModel = ref(''); const requestedService = ref(''); const resultService = ref(''); const resultModel = ref('');
// 网页配置刻意不包含凭据；缺失密钥必须以后台返回为准，不能从公开快照推断。
const readiness = computed(() => resolveWritingReadiness(config.value, false,
  getTranslationServiceUnavailableMessage(config.value.writing.service || config.value.service)));
const credentialError = computed(() => error.value === '请先在翻译服务中配置这个服务的 API Key');
const service = computed(() => readiness.value.service);
const supported = computed(() => readiness.value.supported);
const configuredModel = computed(() => readiness.value.model);
const showingPending = computed(() => busy.value && Boolean(pending.value || !result.value));
const displayService = computed(() => showingPending.value ? requestedService.value || service.value : resultService.value || service.value);
const serviceLabel = computed(() => options.services.find(item => item.value === displayService.value)?.label || config.value.customOpenAIProviders.find(item => item.id === displayService.value)?.name || displayService.value);
const displayModel = computed(() => showingPending.value ? actualModel.value || configuredModel.value : resultModel.value || configuredModel.value);
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
const visibleText = computed({get: () => busy.value && pending.value ? pending.value : result.value, set: value => { if (!busy.value) result.value = value; }});
const referenceState = shallowRef<WritingReferenceState>({status: 'idle', text: ''});
const insertOptionsOpen = ref(false);
const insertActions = ref<HTMLElement>();
const canUseBilingual = computed(() => !busy.value && !saving.value && view.value !== 'edit' && showReferenceTranslation.value && referenceState.value.status === 'success' && Boolean(referenceState.value.text.trim()));
async function toggleInsertOptions(open?: boolean | Event) {
  insertOptionsOpen.value = open === true || !insertOptionsOpen.value;
  if (!insertOptionsOpen.value) return;
  await nextTick(); insertActions.value?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll: true});
}
function closeInsertOnBlur(event: FocusEvent) { if (!insertActions.value?.contains(event.relatedTarget as Node | null)) insertOptionsOpen.value = false; }
function handleInsertKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); insertOptionsOpen.value = false; insertActions.value?.querySelector<HTMLButtonElement>('.writing-insert-toggle')?.focus({preventScroll: true}); }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault(); const items = [...insertActions.value!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  const current = (insertActions.value!.getRootNode() as ShadowRoot).activeElement;
  const index = items.indexOf(current as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
const referenceOwner = ref(0);
const referenceOwnerKey = () => JSON.stringify([service.value, configuredModel.value, config.value.proxy, config.value.token, config.value.customOpenAIProviders,
  service.value === services.deepseek && isModelThinkingEnabled(config.value.modelThinking, service.value, configuredModel.value)]);
let observedReferenceOwnerKey = referenceOwnerKey();
watch(referenceOwnerKey, value => {observedReferenceOwnerKey = value; referenceOwner.value++; });
const referenceSnapshot = () => ({session: props.sessionKey ?? 0, source: result.value, sourceLanguage: resultLanguage.value, language: referenceLanguage.value, owner: referenceOwner.value,
  active: props.active && !busy.value && !saving.value && !versions.value[versionIndex.value]?.incomplete && view.value !== 'edit' && view.value !== 'reference-language' && config.value.on && config.value.writing.enabled && readiness.value.ready});
const referenceController = createWritingReference({
  changed: state => { referenceState.value = state; },
  canRecover: snapshot => referenceOwnerKey() === observedReferenceOwnerKey && JSON.stringify(referenceSnapshot()) === JSON.stringify(snapshot),
  stream: (source, target, handlers) => streamWriting({type: 'fluentReadWriting', action: 'run', requestId: `writing-reference-${crypto.randomUUID()}`, intent: 'translate', instruction: '', draft: source, context: '', language: target, tone: 'natural', length: 'standard', style: 'auto', role: 'auto', history: []}, handlers),
});
watch(() => [props.active, props.sessionKey, result.value, resultLanguage.value, referenceLanguage.value, referenceOwner.value, busy.value, saving.value, view.value, config.value.on, config.value.writing.enabled, readiness.value.ready, versions.value[versionIndex.value]?.incomplete], () => {
  referenceController.update(referenceSnapshot());
}, {immediate: true});
onBeforeUnmount(() => referenceController.dispose());
let generation = 0; let cancel: (() => void) | undefined;
let disposed = false; let preferenceRevision = 0;
function capturePanelAction() {
  const owner = generation, ownerSession = props.sessionKey;
  return () => !disposed && props.active && owner === generation && ownerSession === props.sessionKey;
}
function invalidatePreferenceSave() { preferenceRevision++; saving.value = false; }
const lastAttempt = shallowRef<{request: WritingRequest; clearInstruction: boolean; previousResult: string}>();
function stop() { generation++; cancel?.(); cancel = undefined; if (busy.value) { if (!result.value.trim() && pending.value.trim()) saveVersion(pending.value, requestedService.value, actualModel.value, true); notice.value = result.value.trim() ? '已停止，当前草稿已保留。' : t('writing.experience.stoppedEmpty'); } pending.value = ''; busy.value = false; }
function handleKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); if (saving.value) return; if (view.value !== 'answer') view.value = 'answer'; else emit('close'); }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target === instructionInput.value && instruction.value.trim()) { event.preventDefault(); generate(); }
}
watch(() => [props.active, props.sessionKey], async () => {
  invalidatePreferenceSave();
  insertOptionsOpen.value = false;
  if (session !== props.sessionKey) {
    stop(); session = props.sessionKey; attempted = false; draft.value = props.initialDraft ?? ''; context.value = props.initialContext ?? ''; intent.value = props.initialIntent ?? 'reply';
    instruction.value = ''; result.value = ''; resultService.value = ''; resultModel.value = ''; resultLanguage.value = ''; requestedLanguage.value = ''; actualModel.value = ''; requestedService.value = ''; error.value = ''; notice.value = ''; view.value = 'answer'; versions.value = []; versionIndex.value = 0; lastAttempt.value = undefined;
    language.value = config.value.writing.language; tone.value = config.value.writing.tone; length.value = config.value.writing.length; style.value = config.value.writing.style; role.value = config.value.writing.role;
  }
  if (!props.active) { stop(); return; }
  const owner = generation; await nextTick(); if (!props.active || owner !== generation) return; panel.value?.focus({preventScroll: true});
  if (!attempted && readiness.value.ready && (draft.value.trim() || (intent.value !== 'draft' && context.value.trim()))) { attempted = true; generate(); }
  else if (!result.value && supported.value) instructionInput.value?.focus({preventScroll: true});
}, {immediate: true});
watch(() => JSON.stringify([config.value.writing.language, config.value.writing.length, config.value.writing.style, config.value.writing.tone, config.value.writing.role]), () => {
  language.value = config.value.writing.language; length.value = config.value.writing.length; style.value = config.value.writing.style; tone.value = config.value.writing.tone; role.value = config.value.writing.role;
});
watch(() => JSON.stringify([config.value.on, config.value.writing.enabled, service.value, configuredModel.value]), stop);
onBeforeUnmount(() => { disposed = true; invalidatePreferenceSave(); stop(); });
function saveVersion(text: string, service: string, model: string, incomplete = false) {
  if (versions.value.length) versions.value[versionIndex.value].text = result.value;
  const last = versions.value.at(-1);
  if (last?.text !== text || last.service !== service || last.model !== model || last.language !== requestedLanguage.value || last.incomplete !== incomplete) versions.value.push({text, service, model, language: requestedLanguage.value, incomplete});
  if (versions.value.length > 5) versions.value.shift(); versionIndex.value = versions.value.length - 1; result.value = text; resultService.value = service; resultModel.value = model; resultLanguage.value = requestedLanguage.value;
}
function switchVersion(delta: number) { versions.value[versionIndex.value].text = result.value; versionIndex.value += delta; const version = versions.value[versionIndex.value]; result.value = version.text; resultService.value = version.service; resultModel.value = version.model; resultLanguage.value = version.language; error.value = ''; notice.value = ''; }
function showReference() { referenceDraft.value = context.value; view.value = 'reference'; }
function restartFromReference() { context.value = referenceDraft.value; generate(false, true); }
async function persistPreferences(value: Partial<WritingPreferences>) {
  if (saving.value || disposed || !props.active) return false;
  const revision = ++preferenceRevision, current = capturePanelAction();
  saving.value = true; error.value = '';
  try {
    await requestConfigPatch({writing: {...config.value.writing, ...value}}, message => browser.runtime.sendMessage(message));
    return revision === preferenceRevision && current();
  } catch {
    if (revision === preferenceRevision && current()) error.value = '保存失败，请重试。';
    return false;
  } finally { if (revision === preferenceRevision) saving.value = false; }
}
async function applyStyle(value: StylePreferences) {
  if (Object.entries(value).every(([key, selected]) => stylePreferences.value[key as keyof StylePreferences] === selected)) { view.value = 'answer'; return; }
  const owner = generation; const ownerSession = props.sessionKey;
  if (!await persistPreferences(value) || owner !== generation || ownerSession !== props.sessionKey || !props.active) return;
  length.value = value.length; style.value = value.style; tone.value = value.tone; role.value = value.role;
  view.value = 'answer'; if (canStart.value) generate(Boolean(result.value));
}
async function applyLanguage(value: string) {
  const changed = language.value !== value || (result.value && resultLanguage.value !== resolveWritingLanguage(value, config.value.to));
  const owner = generation; const ownerSession = props.sessionKey;
  if (saving.value || !await persistPreferences({language: value}) || owner !== generation || ownerSession !== props.sessionKey || !props.active) return;
  language.value = value; view.value = 'answer';
  if (changed && result.value) generate(true, false, 'translate');
}
async function applyReferenceLanguage(value: string) {
  const ownerSession = props.sessionKey;
  if (!await persistPreferences({referenceLanguage: value}) || ownerSession !== props.sessionKey || !props.active) return;
  view.value = 'answer';
}
function generate(preferenceOnly = false, fresh = false, overrideIntent?: WritingIntent) {
  if (busy.value || saving.value || !props.active || !config.value.on || !config.value.writing.enabled || !readiness.value.ready) return;
  if (!result.value.trim() && !draft.value.trim() && !context.value.trim() && !instruction.value.trim()) return;
  const question = preferenceOnly ? '' : instruction.value;
  const source = fresh ? draft.value : result.value.trim() ? result.value : draft.value;
  const action = overrideIntent ?? (result.value.trim() && !fresh ? 'polish' : intent.value);
  run({type: 'fluentReadWriting', action: 'run', requestId: '', intent: action,
    instruction: question, draft: source.slice(0, 12000), context: context.value, language: resolveWritingLanguage(language.value, config.value.to), tone: tone.value, length: length.value, style: style.value, role: role.value, history: []}, !preferenceOnly);
}
function retry() {
  const attempt = lastAttempt.value;
  if (!attempt || busy.value || saving.value || !props.active || !config.value.on || !config.value.writing.enabled || !readiness.value.ready) return;
  // 未编辑的失败请求原样重试；用户补写了保留的草稿时采用该稿，但仍保留原任务及语言。
  run({...attempt.request, draft: result.value !== attempt.previousResult ? result.value.slice(0, 12000) : attempt.request.draft}, attempt.clearInstruction);
}
function run(request: WritingRequest, clearInstruction: boolean) {
  stop(); attempted = true; error.value = ''; notice.value = ''; pending.value = ''; view.value = 'answer'; busy.value = true;
  const owner = ++generation;
  const snapshot = {...request, requestId: `writing-${crypto.randomUUID()}`, history: request.history.map(turn => ({...turn}))};
  lastAttempt.value = {request: snapshot, clearInstruction, previousResult: result.value};
  requestedLanguage.value = snapshot.language; requestedService.value = service.value; actualModel.value = configuredModel.value;
  try {
    const abort = streamWriting(snapshot, {
      progress(value) { if (owner !== generation || !busy.value) return; if (value.kind === 'text') pending.value = value.text; else { requestedService.value = value.service; actualModel.value = value.model; } },
      result(value) {
        if (owner !== generation || !busy.value) return; busy.value = false; cancel = undefined;
        if (!value.success && !result.value.trim() && pending.value.trim()) saveVersion(pending.value, requestedService.value, actualModel.value, true);
        pending.value = '';
        if (value.success && value.text.trim()) { saveVersion(value.text, value.service, value.model); if (clearInstruction && instruction.value === snapshot.instruction) instruction.value = ''; lastAttempt.value = undefined; }
        else { if (lastAttempt.value) lastAttempt.value.previousResult = result.value; if (!value.success && value.cancelled) notice.value = value.error; else error.value = value.success ? '模型没有返回正文，请重试' : value.error; }
      },
    });
    // 客户端连接失败可以同步返回，不能再把已结束的取消句柄记为正在生成。
    if (owner === generation && busy.value) cancel = abort; else abort();
  } catch { busy.value = false; pending.value = ''; error.value = '写作助手暂时不可用，请刷新页面后重试。'; }
}
function replyText(bilingual = false): string {
  if (!result.value.trim() || (bilingual && !canUseBilingual.value)) return '';
  const text = bilingual ? `${result.value.trim()}\n\n${referenceState.value.text.trim()}` : result.value;
  return props.plainTextOutput ? writingPlainText(text) : text;
}
async function copy(bilingual = false) {
  const text = replyText(bilingual), current = capturePanelAction();
  if (!text || !current()) return;
  try { await navigator.clipboard.writeText(text); if (current() && replyText(bilingual) === text) notice.value = '正文已复制。'; }
  catch { if (current() && replyText(bilingual) === text) error.value = '复制失败，请选中生成正文手动复制。'; }
}
function apply(bilingual = false) { const text = replyText(bilingual); if (!text) return; const failure = props.applyDraft?.(text); if (failure) error.value = failure; }
async function openSettings() {
  const current = capturePanelAction(); if (!current()) return;
  try { await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}); }
  catch { if (current()) error.value = '请从扩展菜单打开完整设置。'; }
}
</script>
<style scoped>
.writing-panel{--w-bg:#fff;--w-soft:#f7f8fb;--w-ink:#28323f;--w-muted:#7c8799;--w-line:#e9edf3;--w-brand:#ef4776;--w-brand-soft:#fff0f5;--el-border-color-lighter:var(--w-line);--el-fill-color-lighter:var(--w-soft);--el-fill-color-light:var(--w-soft);--el-text-color-regular:var(--w-ink);--el-color-primary:var(--w-brand);--el-color-primary-light-5:var(--w-brand);position:relative;width:100%;height:600px;box-sizing:border-box;max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--w-bg);color:var(--w-ink);border:1px solid var(--w-line);border-radius:16px;box-shadow:0 12px 48px #152c4122;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;color-scheme:light;overflow:hidden;outline:none}
.writing-panel :deep(.writing-choices button){font-size:12px;line-height:1.4}.writing-panel.is-dark{--w-bg:#24262e;--w-soft:#2c2e38;--w-ink:#edf0f5;--w-muted:#a1a8b5;--w-line:#393c48;--w-brand:#fa83a7;--w-brand-soft:#442c3a;color-scheme:dark}.writing-panel :deep(*){box-sizing:border-box}.writing-panel :deep(button),.writing-panel :deep(textarea),.writing-panel :deep(input){font:inherit;color:inherit}.writing-panel :deep(button){cursor:pointer}.writing-panel :deep(:is(button,input,textarea):focus-visible){outline:2px solid var(--w-brand);outline-offset:2px}.writing-panel :deep(:disabled){opacity:.45;cursor:default}

/* 固定面板内优先分配阅读空间；语言与操作保持一行，输入需要时展开。 */
.writing-header{display:flex;align-items:center;gap:7px;flex-shrink:0;padding:8px 14px;border-bottom:1px solid var(--w-line)}
.writing-mark{width:22px;height:22px;object-fit:contain;flex-shrink:0}.writing-header h2{flex:1;min-width:0;margin:0;font-size:14px;line-height:1.4;font-weight:650;overflow-wrap:anywhere}
.writing-provider{max-width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:var(--w-muted)}
.writing-icon,.writing-settings{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;gap:4px;border:0;border-radius:6px;background:transparent;color:var(--w-muted)!important;padding:5px;line-height:1}.writing-settings span{display:none}.writing-icon svg,.writing-settings svg{width:16px;height:16px}
.writing-icon:hover,.writing-settings:hover{background:var(--w-brand-soft);color:var(--w-brand)!important}
.writing-language-bar{display:flex;gap:12px;padding:4px 14px;flex-shrink:0}.writing-language-bar button{display:flex;align-items:center;gap:5px;flex:1;min-width:0;border:0;border-radius:6px;background:transparent;padding:3px 0;color:var(--w-ink)!important;font:inherit;font-size:12px;cursor:pointer;text-align:left}.writing-language-bar button:hover{background:var(--w-soft)}
.writing-language-bar small{font-size:10px;color:var(--w-muted);flex-shrink:0}.writing-language-bar span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.writing-language-bar svg{width:11px;height:11px;flex-shrink:0}.writing-language-bar button:disabled{opacity:.5;cursor:default}
.writing-main{min-height:0;flex:1;padding:0 14px;display:flex;flex-direction:column}.writing-title{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-bottom:6px;min-height:22px}.writing-title h3{font-size:12px;line-height:1.5;margin:0 auto 0 0;font-weight:600;overflow-wrap:anywhere}
.writing-panel :deep(.writing-text-button){border:0;background:transparent;padding:0;color:var(--w-muted);font-size:11px;white-space:normal;cursor:pointer}.writing-panel :deep(.writing-text-button:hover){color:var(--w-brand)}
.writing-versions{display:flex;align-items:center;gap:2px;font-size:11px;color:var(--w-muted)}.writing-versions .writing-icon{width:22px;height:22px;padding:4px}
.writing-output,.writing-preview{display:block;width:100%;min-height:0;flex:1;resize:none;border:0;padding:0 4px 0 0;background:transparent;outline:none;font-size:14px!important;line-height:1.8!important;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}.writing-preview :deep(.fr-reading-markdown){font-size:14px;line-height:1.8}
.writing-translation{border-top:1px solid var(--w-line);margin-top:12px;padding-top:10px}.writing-translation h4{font-size:11px;font-weight:500;color:var(--w-muted);margin:0 0 6px}.writing-translation>p{font-size:11px;color:var(--w-muted);margin:6px 0}.writing-translation .writing-text-button{margin-left:6px}
.writing-loading{font-size:12px;color:var(--w-muted);margin:0}.writing-panel textarea::placeholder{color:var(--w-muted)}
.writing-empty,.writing-setup{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;padding:16px;text-align:center;color:var(--w-muted);min-height:0;overflow:auto}.writing-empty p,.writing-setup p{font-size:12px;line-height:1.8;margin:0;max-width:340px}.writing-setup h3{font-size:16px;color:var(--w-ink);margin:0}
.writing-suggestions{display:flex;flex-wrap:wrap;justify-content:center;gap:6px}.writing-suggestions button{border:1px solid var(--w-line);border-radius:8px;background:var(--w-soft);padding:5px 9px;font-size:11px}.writing-suggestions button:hover{border-color:var(--w-brand);color:var(--w-brand)}
.writing-panel :deep(.writing-button){display:inline-flex;align-items:center;justify-content:center;gap:5px;flex-shrink:0;border:1px solid var(--w-line);border-radius:7px;padding:5px 10px;background:var(--w-bg);font-size:12px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;cursor:pointer}.writing-panel :deep(.writing-button.primary){background:var(--w-brand);border-color:var(--w-brand);color:#fff;font-weight:600}
.writing-actions{padding:6px 14px;flex-shrink:0;border-top:1px solid var(--w-line);margin-top:6px}.writing-toolbar{display:flex;align-items:center;gap:3px}.writing-preferences{display:flex;align-items:center;margin-right:auto;min-width:0}.writing-style-trigger{display:flex;align-items:center;gap:5px;min-width:0;border:0;background:transparent;padding:4px 0;font-size:11px!important;color:var(--w-muted)!important;text-align:start}.writing-style-trigger svg{width:11px;height:11px;flex-shrink:0}.writing-style-trigger svg:first-child{color:var(--w-brand);width:15px;height:15px}.writing-style-trigger small{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.writing-style-trigger span{flex-shrink:0}
.writing-insert-actions{position:relative;display:flex;flex-shrink:0}.writing-insert-actions>.writing-button:first-child{border-radius:7px 0 0 7px}.writing-panel :deep(.writing-insert-toggle){border-radius:0 7px 7px 0;border-left:1px solid #ffffff55;padding:5px;width:24px}.writing-insert-toggle svg{width:12px;height:12px}
.writing-insert-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:2;box-sizing:border-box;width:220px;max-width:calc(100vw - 40px);padding:5px;background:var(--w-bg);border:1px solid var(--w-line);border-radius:9px;box-shadow:0 5px 20px #152c4122}.writing-insert-menu button{display:block;width:100%;border:0;background:transparent;padding:8px;text-align:start;font:inherit;font-size:12px;color:var(--w-ink);border-radius:5px;cursor:pointer}.writing-insert-menu button:hover{background:var(--w-soft)}.writing-insert-menu small{display:block;padding:3px 8px;font-size:11px;color:var(--w-muted);line-height:1.5}
.writing-composer{flex-shrink:0;display:flex;align-items:center;gap:8px;margin:0 14px 8px;padding:5px 8px;border:1px solid var(--w-line);background:var(--w-soft);border-radius:8px}.writing-composer textarea{width:100%;min-width:0;height:20px;resize:none;border:0;padding:0;background:transparent;font-size:12px;line-height:20px;outline:none;overflow:auto}.writing-composer:focus-within{border-color:var(--w-brand)}.writing-composer:focus-within textarea,.writing-composer.has-instruction textarea{height:60px}
.writing-error,.writing-notice{font-size:11px;line-height:1.5;margin:0 0 6px;max-height:48px;overflow:auto;flex-shrink:0}.writing-error,.writing-status{padding:0 14px}.writing-error{color:#c55b4e}.writing-error button{margin-left:6px;color:inherit!important}.writing-notice{color:var(--w-muted)}
.writing-reference{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;color:var(--w-muted);font-size:11px;padding-bottom:8px}.writing-reference label{display:flex;flex-direction:column;margin-bottom:8px;min-height:80px;flex:1}.writing-reference textarea{color:var(--w-ink);display:block;width:100%;min-height:0;flex:1;border:1px solid var(--w-line);background:var(--w-soft);border-radius:8px;padding:8px;margin-top:4px;font-size:12px;line-height:1.8;resize:none}.writing-reference textarea:focus-visible{outline:none;border-color:var(--w-brand);box-shadow:inset 0 0 0 1px var(--w-brand)}.writing-reference-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;flex-shrink:0}
@media(max-width:540px){.writing-header{padding:7px 10px;gap:5px}.writing-header h2{font-size:13px}.writing-provider{max-width:85px}.writing-language-bar{padding:5px 10px;gap:8px}.writing-language-bar button{flex-wrap:wrap;gap:2px 4px}.writing-language-bar small{width:100%;text-align:start}.writing-main{padding-inline:10px}.writing-actions{padding-inline:10px}.writing-composer{margin-inline:10px}.writing-style-trigger>span{display:none}.writing-style-trigger small{max-width:78px}.writing-insert-actions>.writing-button:first-child{max-width:115px}.writing-error,.writing-status{padding-inline:10px}}
@media(max-height:440px){.writing-panel{overflow-y:auto}.writing-main{flex:1 0 100px}.writing-style-editor,.writing-language-picker{min-height:120px}}
</style>
