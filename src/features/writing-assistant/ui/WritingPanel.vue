<!--
 * @file src/features/writing-assistant/ui/WritingPanel.vue
 * 文件职责：承载网页回复的写作流程，在固定卡片中起草、核对引用、调整风格并插回当前编辑器。
 * 主要内容：以安全 Markdown 呈现生成内容并保留原文编辑能力，风格集中确认、语言跟随目标设置，保留原稿和最近版本；失败或停止不会丢失已有正文。
 * 模块边界：不自行读取网页或发送回复，引用由宿主传入；后台负责模型请求，编辑器快照负责写回，Gmail 仅插入可读纯文本。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor">
    <section v-show="active" ref="panel" class="writing-panel" :class="{'is-dark': dark}" role="dialog" aria-label="写作助手" tabindex="-1" @keydown="handleKeydown">
      <header class="writing-header">
        <img :src="icon" alt="" class="writing-mark" /><h2>写作助手</h2>
        <span v-if="supported" class="writing-provider" :title="displayModel">{{ serviceLabel }}<small>{{ displayModel }}</small></span>
        <button type="button" class="writing-settings" aria-label="写作设置" title="写作设置" @click="openSettings"><Setting /><span>设置</span></button>
        <button type="button" class="writing-icon" aria-label="关闭写作助手" @click="emit('close')"><Close /></button>
      </header>
      <div v-if="!supported" class="writing-setup">
        <h3>先选择一个 AI 服务</h3><p>使用你已配置的服务来写作，之后即可从回复框直接开始。</p>
        <button type="button" class="writing-button primary" @click="openSettings">设置写作服务</button>
      </div>
      <template v-else>
        <WritingStyleEditor v-if="view === 'style'" :model-value="stylePreferences" :action-label="styleAction" :saving="saving" @apply="applyStyle" @cancel="view = 'answer'" />
        <WritingLanguagePicker v-else-if="view === 'language'" :model-value="language" :target-label="targetLabel" :disabled="saving" @select="applyLanguage" @cancel="view = 'answer'" />
        <template v-else>
          <div class="writing-main">
            <div class="writing-title"><h3>{{ view === 'reference' ? '参考内容' : busy ? (result ? '正在调整…' : '正在起草…') : result ? '回复草稿' : '想怎么回复？' }}</h3>
              <div v-if="versions.length > 1 && view !== 'reference'" class="writing-versions"><button type="button" class="writing-icon" :disabled="busy || versionIndex === 0" aria-label="上一版" @click="switchVersion(-1)"><ArrowLeft /></button><span>{{ versionIndex + 1 }}/{{ versions.length }}</span><button type="button" class="writing-icon" :disabled="busy || versionIndex === versions.length - 1" aria-label="下一版" @click="switchVersion(1)"><ArrowRight /></button></div>
              <button v-if="view === 'reference'" type="button" class="writing-text-button" @click="view = 'answer'">返回草稿</button>
              <button v-else-if="context || draft" type="button" class="writing-text-button" :disabled="busy" @click="showReference">参考内容</button>
            </div>
            <div v-if="view === 'reference'" class="writing-reference">
              <label v-if="draft">原有草稿<textarea :value="draft" readonly rows="3" aria-label="写作草稿" /></label>
              <label>项目与讨论<textarea v-model="referenceDraft" rows="8" maxlength="12000" aria-label="写作参考内容" /></label>
              <div class="writing-reference-footer"><span>核对参考信息后，重新起草回复。</span><button type="button" class="writing-button primary" :disabled="!referenceDraft.trim() && !draft.trim() && !instruction.trim()" @click="restartFromReference">重新起草</button></div>
            </div>
            <textarea v-else-if="view === 'edit'" v-model="visibleText" class="writing-output" aria-label="生成正文" spellcheck="true" />
            <div v-else-if="result || busy" class="writing-preview" role="region" aria-label="生成正文预览" :aria-busy="busy"><ReadingAnswer v-if="visibleText" :text="visibleText" :compact="false" /><p v-else class="writing-loading">正在组织语言…</p></div>
            <div v-else class="writing-empty"><p>写下回复要点，写作助手帮你整理成自然的表达。</p><button v-if="draft || context" type="button" class="writing-button" @click="generate()">生成回复</button></div>
          </div>
          <div v-if="view !== 'reference'" class="writing-actions">
            <p v-if="result && !applyDraft" class="writing-notice">原草稿含格式，请复制后自行粘贴。</p>
            <div class="writing-toolbar">
              <div class="writing-preferences"><button type="button" class="writing-style-trigger" :disabled="busy" @click="view = 'style'"><Operation />回答风格<ArrowDown /></button><button type="button" class="writing-language-trigger" :disabled="busy" aria-label="输出语言" :title="language === 'target' ? '跟随目标语言' : '输出语言'" @click="view = 'language'">{{ outputLanguageLabel }}<ArrowDown /></button></div>
              <button v-if="result && !busy" type="button" class="writing-icon" :aria-label="view === 'edit' ? '完成编辑' : '编辑正文'" :title="view === 'edit' ? '完成编辑' : '编辑正文'" @click="view = view === 'edit' ? 'answer' : 'edit'"><Check v-if="view === 'edit'" /><EditPen v-else /></button>
              <button v-if="result && !busy" type="button" class="writing-icon" aria-label="复制正文" title="复制正文" @click="copy"><CopyDocument /></button>
              <button v-if="result && !busy" type="button" class="writing-icon" aria-label="重新生成" title="重新生成" @click="generate()"><RefreshRight /></button>
              <button v-if="busy" type="button" class="writing-button" @click="stop">停止</button>
              <button v-else-if="result" type="button" class="writing-button primary" @click="applyDraft ? apply() : copy()">{{ applyDraft ? '插入回复' : '复制回复' }}</button>
            </div>
          </div>
          <form v-if="view !== 'reference'" class="writing-composer" @submit.prevent="generate()">
            <textarea ref="instructionInput" v-model="instruction" :disabled="busy" rows="2" maxlength="2000" aria-label="写作要求" autocomplete="off" data-1p-ignore="true" data-lpignore="true" :placeholder="result ? '告诉我如何改进…' : '写下你想表达的要点…'" />
            <button type="submit" class="writing-button primary" :disabled="busy || !instruction.trim()" :aria-label="result ? '改进草稿' : '生成回复'">{{ result ? '改进' : '生成' }} <span aria-hidden="true">↵</span></button>
          </form>
        </template>
        <p v-if="error" class="writing-error" role="alert">{{ error }} <button v-if="/配置|选择|请先/.test(error)" type="button" class="writing-text-button" @click="openSettings">写作设置</button><button v-else-if="view === 'answer'" type="button" class="writing-text-button" @click="generate()">重试</button></p>
        <p v-else-if="notice" class="writing-notice writing-status" role="status">{{ notice }}</p>
      </template>
      <p class="writing-footnote">由 AI 辅助起草，检查后再发送。</p>
    </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {Setting, Close, ArrowLeft, ArrowRight, ArrowDown, CopyDocument, RefreshRight, EditPen, Check, Operation} from '@element-plus/icons-vue';
import {ReadingAnswer} from '@/src/features/reading-assistant/public';
import {writingPlainText} from '../markdown';
import WritingStyleEditor from './WritingStyleEditor.vue';
import WritingLanguagePicker from './WritingLanguagePicker.vue';
import {config as initialConfig, subscribeConfig, requestConfigPatch} from '@/src/services/config/store';
import {resolveConfiguredModel, options} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {WRITING_LANGUAGES, resolveWritingLanguage, type WritingPreferences, type WritingIntent} from '@/src/core/config/writing';
import {streamWriting} from '../client';
import WritingPopover from './WritingPopover.vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; initialDraft?: string; initialContext?: string; initialIntent?: WritingIntent; sessionKey?: number; plainTextOutput?: boolean; applyDraft?: (text: string) => string | undefined}>();
const emit = defineEmits<{close: []}>();
const config = shallowRef(initialConfig); const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const icon = browser.runtime.getURL('/icon/128.png'); const panel = ref<HTMLElement>(); const instructionInput = ref<HTMLTextAreaElement>();
const draft = ref(''); const context = ref(''); const instruction = ref(''); const intent = ref<WritingIntent>('reply');
const language = ref(config.value.writing.language); const tone = ref(config.value.writing.tone); const length = ref(config.value.writing.length);
const style = ref(config.value.writing.style); const role = ref(config.value.writing.role);
const view = ref<'answer' | 'edit' | 'reference' | 'style' | 'language'>('answer'); const referenceDraft = ref(''); const saving = ref(false);
type StylePreferences = Pick<WritingPreferences, 'length' | 'style' | 'tone' | 'role'>;
const stylePreferences = computed(() => ({length: length.value, style: style.value, tone: tone.value, role: role.value}));
const canStart = computed(() => Boolean(result.value.trim() || draft.value.trim() || context.value.trim() || instruction.value.trim()));
const styleAction = computed(() => result.value ? '应用并改写' : canStart.value ? '应用并起草' : '应用');
const languageLabel = (value: string) => (WRITING_LANGUAGES.find(item => item.value === value)?.label || value).split(' / ')[0];
const targetLabel = computed(() => languageLabel(resolveWritingLanguage('target', config.value.to)));
const outputLanguageLabel = computed(() => languageLabel(showingPending.value ? requestedLanguage.value : resultLanguage.value || resolveWritingLanguage(language.value, config.value.to)));
const busy = ref(false); const result = ref(''); const pending = ref(''); const error = ref(''); const notice = ref('');
type DraftVersion = {text: string; service: string; model: string; language: string};
const versions = ref<DraftVersion[]>([]); const versionIndex = ref(0); let session: number | undefined; let attempted = false;
const requestedLanguage = ref(''); const resultLanguage = ref('');
const actualModel = ref(''); const requestedService = ref(''); const resultService = ref(''); const resultModel = ref('');
const service = computed(() => config.value.writing.service || config.value.service);
const supported = computed(() => isHarnessService(service.value, config.value.customOpenAIProviders));
const configuredModel = computed(() => config.value.writing.model || resolveConfiguredModel(config.value.model[service.value], config.value.customModel[service.value]));
const showingPending = computed(() => busy.value && Boolean(pending.value || !result.value));
const displayService = computed(() => showingPending.value ? requestedService.value || service.value : resultService.value || service.value);
const serviceLabel = computed(() => options.services.find(item => item.value === displayService.value)?.label || config.value.customOpenAIProviders.find(item => item.id === displayService.value)?.name || displayService.value);
const displayModel = computed(() => showingPending.value ? actualModel.value || configuredModel.value : resultModel.value || configuredModel.value);
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
const visibleText = computed({get: () => busy.value && pending.value ? pending.value : result.value, set: value => { if (!busy.value) result.value = value; }});
let generation = 0; let cancel: (() => void) | undefined;
function stop() { generation++; cancel?.(); cancel = undefined; if (busy.value) { if (!result.value && pending.value) saveVersion(pending.value, requestedService.value, actualModel.value); notice.value = '已停止，当前草稿已保留。'; } pending.value = ''; busy.value = false; }
function handleKeydown(event: KeyboardEvent) { event.stopPropagation(); if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); emit('close'); } }
watch(() => [props.active, props.sessionKey], async () => {
  if (session !== props.sessionKey) {
    stop(); session = props.sessionKey; attempted = false; draft.value = props.initialDraft ?? ''; context.value = props.initialContext ?? ''; intent.value = props.initialIntent ?? 'reply';
    instruction.value = ''; result.value = ''; resultService.value = ''; resultModel.value = ''; resultLanguage.value = ''; requestedLanguage.value = ''; actualModel.value = ''; requestedService.value = ''; error.value = ''; notice.value = ''; view.value = 'answer'; versions.value = []; versionIndex.value = 0;
    language.value = config.value.writing.language; tone.value = config.value.writing.tone; length.value = config.value.writing.length; style.value = config.value.writing.style; role.value = config.value.writing.role;
  }
  if (!props.active) { stop(); return; }
  await nextTick(); panel.value?.focus({preventScroll: true});
  if (!attempted && supported.value && (draft.value.trim() || (intent.value !== 'draft' && context.value.trim()))) { attempted = true; generate(); }
  else if (!result.value && supported.value) instructionInput.value?.focus({preventScroll: true});
}, {immediate: true});
watch(() => JSON.stringify([config.value.writing.language, config.value.writing.length, config.value.writing.style, config.value.writing.tone, config.value.writing.role]), () => {
  language.value = config.value.writing.language; length.value = config.value.writing.length; style.value = config.value.writing.style; tone.value = config.value.writing.tone; role.value = config.value.writing.role;
});
watch(() => JSON.stringify([config.value.on, config.value.writing.enabled, service.value, configuredModel.value]), stop);
onBeforeUnmount(stop);
function saveVersion(text: string, service: string, model: string) {
  if (result.value && versions.value.length) versions.value[versionIndex.value].text = result.value;
  const last = versions.value.at(-1);
  if (last?.text !== text || last.service !== service || last.model !== model || last.language !== requestedLanguage.value) versions.value.push({text, service, model, language: requestedLanguage.value});
  if (versions.value.length > 5) versions.value.shift(); versionIndex.value = versions.value.length - 1; result.value = text; resultService.value = service; resultModel.value = model; resultLanguage.value = requestedLanguage.value;
}
function switchVersion(delta: number) { versions.value[versionIndex.value].text = result.value; versionIndex.value += delta; const version = versions.value[versionIndex.value]; result.value = version.text; resultService.value = version.service; resultModel.value = version.model; resultLanguage.value = version.language; error.value = ''; notice.value = ''; }
function showReference() { referenceDraft.value = context.value; view.value = 'reference'; }
function restartFromReference() { context.value = referenceDraft.value; generate(false, true); }
async function persistPreferences(value: Partial<WritingPreferences>) {
  if (saving.value) return false;
  saving.value = true; error.value = '';
  try { await requestConfigPatch({writing: {...config.value.writing, ...value}}, message => browser.runtime.sendMessage(message)); return true; }
  catch { error.value = '保存失败，请重试。'; return false; }
  finally { saving.value = false; }
}
async function applyStyle(value: StylePreferences) {
  const owner = generation; const ownerSession = props.sessionKey;
  if (!await persistPreferences(value) || owner !== generation || ownerSession !== props.sessionKey || !props.active) return;
  length.value = value.length; style.value = value.style; tone.value = value.tone; role.value = value.role;
  view.value = 'answer'; if (canStart.value) generate(Boolean(result.value));
}
async function applyLanguage(value: string) {
  const changed = language.value !== value;
  const owner = generation; const ownerSession = props.sessionKey;
  if (saving.value || !await persistPreferences({language: value}) || owner !== generation || ownerSession !== props.sessionKey || !props.active) return;
  language.value = value; view.value = 'answer';
  if (changed && result.value) generate(true);
}
function generate(preferenceOnly = false, fresh = false) {
  if (busy.value || !props.active || !config.value.on || !config.value.writing.enabled || !supported.value) return;
  if (!result.value.trim() && !draft.value.trim() && !context.value.trim() && !instruction.value.trim()) return;
  stop(); attempted = true; error.value = ''; notice.value = ''; pending.value = ''; view.value = 'answer'; busy.value = true;
  const owner = ++generation; const question = preferenceOnly ? '' : instruction.value;
  const source = fresh ? draft.value : result.value || draft.value; const action = result.value && !fresh ? 'polish' : intent.value;
  requestedLanguage.value = resolveWritingLanguage(language.value, config.value.to); requestedService.value = service.value; actualModel.value = configuredModel.value;
  try {
    cancel = streamWriting({type: 'fluentReadWriting', action: 'run', requestId: `writing-${crypto.randomUUID()}`, intent: action,
      instruction: question, draft: source.slice(0, 12000), context: context.value, language: requestedLanguage.value, tone: tone.value, length: length.value, style: style.value, role: role.value, history: []}, {
      progress(value) { if (owner !== generation) return; if (value.kind === 'text') pending.value = value.text; else { requestedService.value = value.service; actualModel.value = value.model; } },
      result(value) {
        if (owner !== generation) return; busy.value = false; cancel = undefined;
        if (!value.success && !result.value && pending.value) saveVersion(pending.value, requestedService.value, actualModel.value);
        pending.value = '';
        if (value.success) { saveVersion(value.text, value.service, value.model); if (!preferenceOnly) instruction.value = ''; }
        else if (value.cancelled) notice.value = value.error; else error.value = value.error;
      },
    });
  } catch { busy.value = false; pending.value = ''; error.value = '写作助手暂时不可用，请刷新页面后重试。'; }
}
async function copy() { try { await navigator.clipboard.writeText(props.plainTextOutput ? writingPlainText(result.value) : result.value); notice.value = '正文已复制。'; } catch { error.value = '复制失败，请选中生成正文手动复制。'; } }
function apply() { const failure = props.applyDraft?.(props.plainTextOutput ? writingPlainText(result.value) : result.value); if (failure) error.value = failure; }
function openSettings() { void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}).catch(() => { error.value = '请从扩展菜单打开完整设置。'; }); }
</script>
<style scoped>
.writing-panel{--w-bg:#fff;--w-soft:#f7f8fb;--w-ink:#28323f;--w-muted:#7c8799;--w-line:#e9edf3;--w-brand:#ef4776;--w-brand-soft:#fff0f5;--el-border-color-lighter:var(--w-line);--el-fill-color-lighter:var(--w-soft);--el-fill-color-light:var(--w-soft);--el-text-color-regular:var(--w-ink);--el-color-primary:var(--w-brand);--el-color-primary-light-5:var(--w-brand);position:relative;width:100%;height:500px;box-sizing:border-box;max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--w-bg);color:var(--w-ink);border:1px solid var(--w-line);border-radius:16px;box-shadow:0 12px 48px #152c4122;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;color-scheme:light;overflow:hidden;outline:none}
.writing-panel :deep(.writing-choices button){font-size:12px;line-height:1.4}.writing-panel.is-dark{--w-bg:#24262e;--w-soft:#2c2e38;--w-ink:#edf0f5;--w-muted:#a1a8b5;--w-line:#393c48;--w-brand:#fa83a7;--w-brand-soft:#442c3a;color-scheme:dark}.writing-panel :deep(*){box-sizing:border-box}.writing-panel :deep(button),.writing-panel :deep(textarea),.writing-panel :deep(input){font:inherit;color:inherit}.writing-panel :deep(button){cursor:pointer}.writing-panel :deep(:is(button,input,textarea):focus-visible){outline:2px solid var(--w-brand);outline-offset:2px}.writing-panel :deep(:disabled){opacity:.45;cursor:default}
.writing-header{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:16px 20px 14px}.writing-mark{width:26px;height:26px;object-fit:contain;flex-shrink:0}.writing-header h2{font-size:16px;font-weight:650;line-height:1.4;white-space:nowrap;margin:0 auto 0 2px}.writing-provider{max-width:158px;min-width:0;padding:4px 9px;background:var(--w-soft);border-radius:8px;font-size:11px;line-height:1.5;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.writing-provider small{display:block;font-size:10px;color:var(--w-muted);overflow:hidden;text-overflow:ellipsis}.writing-icon,.writing-settings{display:inline-flex;justify-content:center;align-items:center;flex-shrink:0;height:30px;min-width:30px;gap:5px;border:0;border-radius:8px;background:transparent;color:var(--w-muted)!important;padding:6px;line-height:1}.writing-settings{background:var(--w-soft);font-size:11px!important;padding-inline:8px}.writing-icon:hover,.writing-settings:hover{background:var(--w-brand-soft);color:var(--w-brand)!important}.writing-icon svg,.writing-settings svg{width:16px;height:16px}.writing-main{min-height:0;flex:1;padding:4px 20px 0;display:flex;flex-direction:column}.writing-title{display:flex;align-items:center;gap:10px;flex-shrink:0;margin-bottom:12px}.writing-title h3{font-size:13px;line-height:1.5;margin:0 auto 0 0;font-weight:600}.writing-panel :deep(.writing-text-button){border:0;background:transparent;padding:0;color:var(--w-muted);font-size:11px;white-space:nowrap}.writing-panel :deep(.writing-text-button:hover){color:var(--w-brand)}.writing-versions{display:flex;align-items:center;gap:2px;font-size:11px;color:var(--w-muted)}.writing-versions .writing-icon{height:24px;min-width:24px;padding:5px}.writing-output,.writing-preview{display:block;width:100%;min-height:0;flex:1;resize:none;border:0;padding:0 3px 0 0;background:transparent;outline:none;font-size:14px!important;line-height:1.9!important;overflow:auto;overscroll-behavior:contain}.writing-preview :deep(.fr-reading-markdown){font-size:14px;line-height:1.85}.writing-loading{font-size:12px;color:var(--w-muted);margin:0}.writing-panel textarea::placeholder{color:var(--w-muted)}.writing-empty,.writing-setup{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:16px;padding:20px;text-align:center;color:var(--w-muted)}.writing-empty p,.writing-setup p{font-size:12px;line-height:1.8;margin:0;max-width:340px}.writing-setup h3{font-size:16px;color:var(--w-ink);margin:0}.writing-panel :deep(.writing-button){display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;border:1px solid var(--w-line);border-radius:9px;padding:7px 12px;background:var(--w-bg);font-size:12px;line-height:1.5;white-space:nowrap}.writing-panel :deep(.writing-button.primary){background:var(--w-brand);border-color:var(--w-brand);color:var(--w-bg);font-weight:600}.writing-actions{padding:12px 20px;flex-shrink:0}.writing-toolbar{display:flex;align-items:center;gap:4px}.writing-preferences{display:flex;align-items:center;gap:8px;margin-right:auto;min-width:0}.writing-style-trigger,.writing-language-trigger{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;padding:5px 0;font-size:11px!important;color:var(--w-muted)!important;white-space:nowrap;max-width:155px}.writing-language-trigger{max-width:118px;overflow:hidden;text-overflow:ellipsis}.writing-style-trigger svg,.writing-language-trigger svg{width:11px;height:11px;flex-shrink:0}.writing-style-trigger svg:first-child{color:var(--w-brand);width:16px;height:16px}.writing-composer{flex-shrink:0;display:flex;align-items:center;gap:14px;padding:13px 20px;border-top:1px solid var(--w-line)}.writing-composer textarea{width:100%;min-width:0;resize:none;border:0;padding:0;background:transparent;font-size:12px;line-height:1.6;outline:none}.writing-footnote{font-size:10px!important;flex-shrink:0;color:var(--w-muted);padding:0 20px 12px;margin:0!important}.writing-error,.writing-notice{font-size:11px;line-height:1.5;margin:0 0 8px;max-height:48px;overflow:auto;flex-shrink:0}.writing-error,.writing-status{padding:0 20px}.writing-error{color:#c55b4e}.writing-error button{margin-left:8px;color:inherit!important}.writing-notice{color:var(--w-muted)}.writing-reference{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;color:var(--w-muted);font-size:11px;padding-bottom:12px}.writing-reference label{display:flex;flex-direction:column;margin-bottom:10px;min-height:80px;flex:1}.writing-reference textarea{color:var(--w-ink);display:block;width:100%;min-height:0;flex:1;border:1px solid var(--w-line);background:var(--w-soft);border-radius:9px;padding:10px;margin-top:5px;font-size:12px;line-height:1.8;resize:none}.writing-reference textarea:focus-visible{outline:none;border-color:var(--w-brand);box-shadow:inset 0 0 0 1px var(--w-brand)}.writing-reference-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;flex-shrink:0}
@media(max-width:540px){.writing-header{padding:14px 14px 10px;gap:6px}.writing-header h2{font-size:14px}.writing-provider{max-width:110px}.writing-settings span{display:none}.writing-settings{padding:6px}.writing-main{padding:5px 14px 0}.writing-actions{padding:10px 14px}.writing-composer{padding:12px 14px}.writing-footnote{padding:0 14px 10px}.writing-toolbar{flex-wrap:wrap;gap:5px}.writing-preferences{width:100%;gap:16px}.writing-toolbar>.writing-icon:first-of-type{margin-left:auto}.writing-panel :deep(.writing-button){padding:6px 10px}.writing-error,.writing-status{padding-inline:14px}}
</style>
