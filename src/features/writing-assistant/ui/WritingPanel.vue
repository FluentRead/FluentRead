<!--
 * @file src/features/writing-assistant/ui/WritingPanel.vue
 * 文件职责：承载网页回复的完整写作流程，从一次点击起草到调整、核对和插入原编辑框。
 * 主要内容：按草稿与会话选择初始动作，原稿持续保留，支持语言篇幅语气改写与最近版本；失败或停止不丢已有正文。
 * 模块边界：固定布局的卡片只通过后台客户端生成，不自行读取网页或发送回复；编辑器写回由快照宿主负责。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor">
    <section v-show="active" ref="panel" class="writing-panel" :class="{'is-dark': dark}" role="dialog" aria-label="写作助手" tabindex="-1" @keydown="handleKeydown">
      <header class="writing-header">
        <img :src="icon" alt="" class="writing-mark" /><h2>写作助手</h2>
        <span v-if="supported" class="writing-provider" :title="displayModel">{{ serviceLabel }}<small>{{ displayModel }}</small></span>
        <button type="button" class="writing-icon" aria-label="写作设置" title="写作设置" @click="openSettings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button type="button" class="writing-icon" aria-label="关闭写作助手" @click="emit('close')">×</button>
      </header>
      <div v-if="!supported" class="writing-setup">
        <h3>先选择一个 AI 服务</h3><p>使用你已配置的服务来写作，之后即可从回复框直接开始。</p>
        <button type="button" class="writing-button primary" @click="openSettings">设置写作服务</button>
      </div>
      <template v-else>
        <div class="writing-main">
          <div class="writing-title"><h3>{{ busy ? (result ? '正在调整…' : '正在起草…') : result ? '回复草稿' : '想怎么回复？' }}</h3>
            <div v-if="versions.length > 1" class="writing-versions"><button type="button" class="writing-icon" :disabled="busy || versionIndex === 0" aria-label="上一版" @click="switchVersion(-1)">‹</button><span>{{ versionIndex + 1 }}/{{ versions.length }}</span><button type="button" class="writing-icon" :disabled="busy || versionIndex === versions.length - 1" aria-label="下一版" @click="switchVersion(1)">›</button></div>
            <button v-if="context || draft" type="button" class="writing-text-button" :disabled="busy" :aria-expanded="showReference" @click="showReference = !showReference">{{ showReference ? '返回草稿' : '参考内容' }}</button>
          </div>
          <div v-if="showReference" class="writing-reference">
            <label v-if="draft">原有草稿<textarea :value="draft" readonly rows="3" aria-label="写作草稿" /></label>
            <label v-if="context">当前讨论<textarea v-model="context" rows="5" maxlength="12000" aria-label="写作参考内容" /></label>
            <p>当前讨论可在重新生成前删改。</p>
          </div>
          <textarea v-else-if="result || busy" v-model="visibleText" class="writing-output" :readonly="busy" :aria-busy="busy" aria-label="生成正文" placeholder="正在组织语言…" spellcheck="true" />
          <div v-else class="writing-empty"><p>写下回复要点，写作助手帮你整理成自然的表达。</p><button v-if="draft || context" type="button" class="writing-button" @click="generate()">生成回复</button></div>
        </div>
        <div class="writing-actions">
          <p v-if="error" class="writing-error" role="alert">{{ error }} <button v-if="/配置|选择|请先/.test(error)" type="button" class="writing-text-button" @click="openSettings">写作设置</button><button v-else type="button" class="writing-text-button" @click="generate()">重试</button></p>
          <p v-else-if="notice" class="writing-notice" role="status">{{ notice }}</p>
          <p v-else-if="result && !applyDraft" class="writing-notice">原草稿含格式，请复制后自行粘贴。</p>
          <div class="writing-toolbar">
            <div class="writing-preferences">
              <label>语言<select v-model="language" :disabled="busy" aria-label="输出语言" @change="adjust"><option v-for="item in WRITING_LANGUAGES" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
              <label>篇幅<select v-model="length" :disabled="busy" aria-label="回复篇幅" @change="adjust"><option v-for="item in WRITING_LENGTHS" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
              <label>语气<select v-model="tone" :disabled="busy" aria-label="表达语气" @change="adjust"><option v-for="item in WRITING_TONES" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
            </div>
            <button v-if="result && !busy" type="button" class="writing-icon" aria-label="复制正文" title="复制正文" @click="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></button>
            <button v-if="result && !busy" type="button" class="writing-icon" aria-label="重新生成" title="重新生成" @click="generate()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 8a8 8 0 1 1-7-4M12 1v6h6"/></svg></button>
            <button v-if="busy" type="button" class="writing-button" @click="stop">停止</button>
            <button v-else-if="result" type="button" class="writing-button primary" @click="applyDraft ? apply() : copy()">{{ applyDraft ? '插入回复' : '复制回复' }}</button>
          </div>
        </div>
        <form class="writing-composer" @submit.prevent="generate()">
          <textarea ref="instructionInput" v-model="instruction" :disabled="busy" rows="2" maxlength="2000" aria-label="写作要求" autocomplete="off" data-1p-ignore="true" data-lpignore="true" :placeholder="result ? '告诉我如何改进…' : '写下你想表达的要点…'" />
          <button type="submit" class="writing-button primary" :disabled="busy || !instruction.trim()" :aria-label="result ? '改进草稿' : '生成回复'">{{ result ? '改进' : '生成' }} <span aria-hidden="true">↵</span></button>
        </form>
      </template>
      <p class="writing-footnote">由 AI 辅助起草，检查后再发送。</p>
    </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {config as initialConfig, subscribeConfig} from '@/src/services/config/store';
import {resolveConfiguredModel, options} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {WRITING_LANGUAGES, WRITING_TONES, WRITING_LENGTHS, type WritingIntent} from '@/src/core/config/writing';
import {streamWriting} from '../client';
import WritingPopover from './WritingPopover.vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; initialDraft?: string; initialContext?: string; initialIntent?: WritingIntent; sessionKey?: number; applyDraft?: (text: string) => string | undefined}>();
const emit = defineEmits<{close: []}>();
const config = shallowRef(initialConfig); const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const icon = browser.runtime.getURL('/icon/128.png'); const panel = ref<HTMLElement>(); const instructionInput = ref<HTMLTextAreaElement>();
const draft = ref(''); const context = ref(''); const instruction = ref(''); const intent = ref<WritingIntent>('reply');
const language = ref(config.value.writing.language); const tone = ref(config.value.writing.tone); const length = ref(config.value.writing.length);
const busy = ref(false); const result = ref(''); const pending = ref(''); const error = ref(''); const notice = ref(''); const showReference = ref(false);
type DraftVersion = {text: string; service: string; model: string};
const versions = ref<DraftVersion[]>([]); const versionIndex = ref(0); let session: number | undefined; let attempted = false;
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
    instruction.value = ''; result.value = ''; resultService.value = ''; resultModel.value = ''; actualModel.value = ''; requestedService.value = ''; error.value = ''; notice.value = ''; showReference.value = false; versions.value = []; versionIndex.value = 0;
    language.value = config.value.writing.language; tone.value = config.value.writing.tone; length.value = config.value.writing.length;
  }
  if (!props.active) { stop(); return; }
  await nextTick(); panel.value?.focus({preventScroll: true});
  if (!attempted && supported.value && (draft.value.trim() || context.value.trim())) { attempted = true; generate(); }
  else if (!result.value && supported.value) instructionInput.value?.focus({preventScroll: true});
}, {immediate: true});
watch(() => JSON.stringify([config.value.on, config.value.writing.enabled, service.value, configuredModel.value]), stop);
onBeforeUnmount(stop);
function saveVersion(text: string, service: string, model: string) {
  if (result.value && versions.value.length) versions.value[versionIndex.value].text = result.value;
  const last = versions.value.at(-1);
  if (last?.text !== text || last.service !== service || last.model !== model) versions.value.push({text, service, model});
  if (versions.value.length > 5) versions.value.shift(); versionIndex.value = versions.value.length - 1; result.value = text; resultService.value = service; resultModel.value = model;
}
function switchVersion(delta: number) { versions.value[versionIndex.value].text = result.value; versionIndex.value += delta; const version = versions.value[versionIndex.value]; result.value = version.text; resultService.value = version.service; resultModel.value = version.model; error.value = ''; notice.value = ''; }
function adjust() { if (result.value) generate(true); }
function generate(preferenceOnly = false) {
  if (busy.value || !props.active || !config.value.on || !config.value.writing.enabled || !supported.value) return;
  if (!result.value.trim() && !draft.value.trim() && !context.value.trim() && !instruction.value.trim()) return;
  stop(); attempted = true; error.value = ''; notice.value = ''; pending.value = ''; showReference.value = false; busy.value = true;
  const owner = ++generation; const question = preferenceOnly ? '' : instruction.value;
  const source = result.value || draft.value; const action = result.value ? 'polish' : intent.value;
  requestedService.value = service.value; actualModel.value = configuredModel.value;
  try {
    cancel = streamWriting({type: 'fluentReadWriting', action: 'run', requestId: `writing-${crypto.randomUUID()}`, intent: action,
      instruction: question, draft: source.slice(0, 12000), context: context.value, language: language.value, tone: tone.value, length: length.value, history: []}, {
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
async function copy() { try { await navigator.clipboard.writeText(result.value); notice.value = '正文已复制。'; } catch { error.value = '复制失败，请选中生成正文手动复制。'; } }
function apply() { const failure = props.applyDraft?.(result.value); if (failure) error.value = failure; }
function openSettings() { void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}).catch(() => { error.value = '请从扩展菜单打开完整设置。'; }); }
</script>
<style scoped>
.writing-panel{--w-bg:#fff;--w-soft:#f7f8fa;--w-ink:#28323f;--w-muted:#88929f;--w-line:#edf0f3;--w-brand:#ef4776;position:relative;width:100%;height:440px;box-sizing:border-box;max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--w-bg);color:var(--w-ink);border:1px solid var(--w-line);border-radius:16px;box-shadow:0 12px 48px #152c4122;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;color-scheme:light;overflow:hidden;outline:none}.writing-panel.is-dark{--w-bg:#24262e;--w-soft:#2c2e38;--w-ink:#edf0f5;--w-muted:#a1a8b5;--w-line:#393c48;--w-brand:#fa83a7;color-scheme:dark}.writing-panel *{box-sizing:border-box}.writing-header{display:flex;align-items:center;gap:10px;flex-shrink:0;padding:16px 20px 12px}.writing-mark{width:26px;height:26px;object-fit:contain;flex-shrink:0}.writing-header h2{font-size:16px;font-weight:650;line-height:1.4;white-space:nowrap;margin:0;margin-right:auto}.writing-provider{max-width:170px;min-width:0;padding:4px 9px;background:var(--w-soft);border-radius:7px;font-size:11px;line-height:1.5;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.writing-provider small{display:block;font-size:9px;color:var(--w-muted);overflow:hidden;text-overflow:ellipsis}.writing-panel button,.writing-panel textarea,.writing-panel select{font:inherit;color:inherit}.writing-panel button{cursor:pointer}.writing-icon{display:inline-flex;justify-content:center;align-items:center;flex-shrink:0;border:0;background:transparent;color:var(--w-muted)!important;padding:3px;font-size:23px!important;line-height:1}.writing-icon svg{width:17px;height:17px}.writing-main{min-height:0;flex:1;padding:5px 20px 0;display:flex;flex-direction:column}.writing-title{display:flex;align-items:center;gap:10px;flex-shrink:0;margin-bottom:12px}.writing-title h3{font-size:13px;line-height:1.5;margin:0;margin-right:auto;font-weight:600}.writing-title .writing-text-button{font-size:11px}.writing-text-button{border:0;background:transparent;padding:0;color:var(--w-muted)!important;font-size:12px!important;white-space:nowrap}.writing-text-button:hover{color:var(--w-brand)!important}.writing-versions{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--w-muted)}.writing-output{display:block;width:100%;min-height:0;flex:1;resize:none;border:0;padding:0;background:transparent;outline:none;font-size:14px!important;line-height:1.9!important;overflow:auto;overscroll-behavior:contain}.writing-panel textarea::placeholder{color:var(--w-muted)}.writing-panel :is(button,select,textarea):focus-visible{outline:2px solid var(--w-brand);outline-offset:2px}.writing-panel :disabled{opacity:.45;cursor:default}.writing-empty,.writing-setup{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:16px;padding:20px;text-align:center;color:var(--w-muted)}.writing-empty p,.writing-setup p{font-size:12px;line-height:1.8;margin:0;max-width:340px}.writing-setup h3{font-size:16px;color:var(--w-ink);margin:0}.writing-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;border:1px solid var(--w-line);border-radius:7px;padding:6px 12px;background:var(--w-bg);font-size:12px!important;line-height:1.5;white-space:nowrap}.writing-button.primary{background:var(--w-brand);border-color:var(--w-brand);color:var(--w-bg);font-weight:600}.writing-actions{padding:10px 20px 14px;flex-shrink:0}.writing-toolbar{display:flex;align-items:center;gap:10px}.writing-preferences{display:flex;align-items:center;gap:10px;margin-right:auto;min-width:0}.writing-preferences label{font-size:10px;color:var(--w-muted);display:flex;align-items:center;gap:3px}.writing-preferences select{font-size:11px;min-width:0;width:auto;max-width:88px;border:0;background:var(--w-bg);padding:4px 0;cursor:pointer}.writing-composer{flex-shrink:0;display:flex;align-items:center;gap:14px;padding:12px 20px;border-top:1px solid var(--w-line)}.writing-composer textarea{width:100%;min-width:0;resize:none;border:0;padding:0;background:transparent;font-size:12px;line-height:1.6;outline:none}.writing-footnote{font-size:10px!important;flex-shrink:0;color:var(--w-muted);padding:0 20px 12px;margin:0!important}.writing-error,.writing-notice{font-size:11px;line-height:1.5;margin:0 0 8px;max-height:48px;overflow:auto}.writing-error{color:#c55b4e}.writing-error button{margin-left:8px;color:inherit!important}.writing-notice{color:var(--w-muted)}.writing-reference{flex:1;min-height:0;overflow:auto;color:var(--w-muted);font-size:11px}.writing-reference label{display:block;margin-bottom:10px}.writing-reference textarea{display:block;width:100%;border:1px solid var(--w-line);background:var(--w-soft);border-radius:6px;padding:8px;margin-top:5px;font-size:12px;resize:vertical}.writing-reference p{font-size:10px;margin:0 0 10px}
@media(max-width:540px){.writing-header{padding:14px 14px 10px;gap:7px}.writing-header h2{font-size:14px}.writing-provider{max-width:112px}.writing-main{padding:5px 14px 0}.writing-actions{padding:10px 14px}.writing-composer{padding:12px 14px}.writing-footnote{padding:0 14px 10px}.writing-toolbar{flex-wrap:wrap;gap:9px}.writing-preferences{width:100%;gap:16px}.writing-preferences label{font-size:10px}.writing-toolbar>.writing-icon:first-of-type{margin-left:auto}.writing-button{padding:6px 10px}}
</style>
