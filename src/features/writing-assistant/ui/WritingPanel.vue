<!--
 * @file src/features/writing-assistant/ui/WritingPanel.vue
 * 文件职责：提供回复框旁的写作助手卡片，展示草稿、可编辑参考内容与流式结果。
 * 主要内容：支持回复起草、修改要求和流式改写；停止、关闭、配置变化时取消旧请求，用户确认后才复制或填入。
 * 模块边界：通过 feature 客户端调用后台；不读取网页或凭据、不自行提交表单，填入能力由拥有编辑器快照的宿主注入。
 -->
<template>
  <WritingPopover :active="active" :anchor="anchor">
  <section v-show="active" ref="panel" class="writing-panel" :class="{'is-dark': dark}" role="dialog" aria-label="写作助手" tabindex="-1" @keydown="handleKeydown">
    <header class="writing-header">
      <div class="writing-brand"><img :src="icon" alt="" class="writing-mark" /><h2>写作助手</h2></div>
      <div class="writing-provider" :title="model"><span>{{ serviceLabel }}</span><small v-if="model">{{ model }}</small></div>
      <button type="button" class="writing-icon" aria-label="关闭写作助手" @click="emit('close')">×</button>
    </header>
    <div class="writing-scroll">
      <div class="writing-title"><h3>回复草稿</h3><span v-if="busy" role="status">正在写作…</span></div>
      <p class="writing-subtitle">结合当前讨论，写一份自然的回复。</p>
      <details class="writing-reference">
        <summary>查看参考内容 <span>{{ context.length + draft.length }} 字</span></summary>
        <label v-if="draft" class="writing-field"><span>原有草稿</span><textarea v-model="draft" :disabled="busy" rows="2" maxlength="12000" aria-label="写作草稿" /></label>
        <label class="writing-field"><span>参考内容 <small>可删改，只发送这里展示的内容</small></span><textarea v-model="context" :disabled="busy" rows="3" maxlength="12000" aria-label="写作参考内容" /></label>
      </details>
      <textarea v-if="result || busy" v-model="result" class="writing-output" :readonly="busy" rows="4" aria-label="生成正文" placeholder="正在组织语言…" />
      <div v-else class="writing-empty"><p>写下回复要点，或直接根据当前讨论起草。</p><button type="button" class="writing-button primary" :disabled="!enabled || (!draft.trim() && !instruction.trim() && !context.trim())" @click="generate()">生成回复</button></div>
      <p v-if="!enabled" class="writing-notice">请先在设置中启用写作助手。</p>
      <p v-if="error" class="writing-error" role="alert">{{ error }} <button type="button" @click="openSettings">打开设置</button></p>
      <div class="writing-toolbar">
        <div class="writing-preferences">
          <select v-model="language" :disabled="busy" aria-label="输出语言"><option v-for="item in WRITING_LANGUAGES" :key="item.value" :value="item.value">{{ item.label }}</option></select>
          <select v-model="tone" :disabled="busy" aria-label="表达语气"><option v-for="item in WRITING_TONES" :key="item.value" :value="item.value">{{ item.label }}</option></select>
        </div>
        <button v-if="result && !busy" type="button" class="writing-icon" aria-label="复制正文" title="复制正文" @click="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></button>
        <button v-if="result && !busy" type="button" class="writing-icon" aria-label="重新生成" title="重新生成" @click="generate()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 8a8 8 0 1 1-7-4M12 1v6h6"/></svg></button>
        <button v-if="busy" type="button" class="writing-button" @click="stop">停止生成</button>
        <button v-else-if="result && applyDraft" type="button" class="writing-button primary writing-insert" @click="apply">插入回复</button>
      </div>
      <p v-if="notice" class="writing-notice" role="status">{{ notice }}</p>
    </div>
    <form class="writing-composer" @submit.prevent="generate(Boolean(result))">
      <textarea v-model="instruction" :disabled="busy" rows="1" maxlength="2000" aria-label="写作要求" :placeholder="result ? '告诉我如何改进…' : '想怎么回复？写下你的要点…'" @keydown.ctrl.enter.prevent="generate(Boolean(result))" />
      <button type="submit" class="writing-button primary" :disabled="busy || !enabled || !instruction.trim()" :aria-label="result ? '改进草稿' : '按要求生成回复'">↵</button>
    </form>
    <p class="writing-footnote">生成时发送参考内容至所选 AI 服务，插入后由你确认发送。</p>
  </section>
  </WritingPopover>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue';
import browser from 'webextension-polyfill';
import {config as initialConfig, subscribeConfig} from '@/src/services/config/store';
import {resolveConfiguredModel, options} from '@/src/core/config/catalog';
import {WRITING_LANGUAGES, WRITING_TONES, type WritingIntent} from '@/src/core/config/writing';
import {streamWriting} from '../client';
import WritingPopover from './WritingPopover.vue';
const icon = browser.runtime.getURL('/icon/128.png');
const config = shallowRef(initialConfig);
const unsubscribeConfig = subscribeConfig(value => { config.value = value; });
onBeforeUnmount(unsubscribeConfig);
const props = defineProps<{active: boolean; anchor?: HTMLElement; initialDraft?: string; initialContext?: string; initialIntent?: WritingIntent; sessionKey?: number; applyDraft?: (text: string) => string | undefined}>();
const emit = defineEmits<{close: []}>();
const panel = ref<HTMLElement>();
const draft = ref(props.initialDraft ?? ''); const context = ref(props.initialContext ?? '');
const instruction = ref('');
const intent = ref<WritingIntent>(props.initialIntent ?? 'draft');
const language = ref(config.value.writing.language); const tone = ref(config.value.writing.tone);
const busy = ref(false); const result = ref(''); const error = ref(''); const notice = ref('');
const service = ref(''); const model = ref('');
const history: Array<{question: string; answer: string}> = [];
const enabled = computed(() => config.value.on && config.value.writing.enabled);
const dark = computed(() => config.value.theme === 'dark' || (config.value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
const serviceLabel = computed(() => {
  const id = service.value || config.value.writing.service || config.value.service;
  return options.services.find(item => item.value === id)?.label || config.value.customOpenAIProviders.find(item => item.id === id)?.name || id;
});
let generation = 0; let cancel: (() => void) | undefined;
function stop() { generation++; cancel?.(); cancel = undefined; if (busy.value) notice.value = '已停止生成，现有内容保留。'; busy.value = false; }
function handleKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); emit('close'); }
}
watch(() => props.active, async active => { if (!active) stop(); else { await nextTick(); panel.value?.focus({preventScroll: true}); } }, {immediate: true});
watch(() => props.sessionKey, () => {
  stop(); draft.value = props.initialDraft ?? ''; context.value = props.initialContext ?? '';
  intent.value = props.initialIntent ?? 'draft'; instruction.value = ''; result.value = ''; error.value = ''; notice.value = ''; history.length = 0;
});
watch(() => JSON.stringify([config.value.on, config.value.writing, config.value.service, config.value.model]), () => { stop(); language.value = config.value.writing.language; tone.value = config.value.writing.tone; });
onBeforeUnmount(stop);
function generate(improve = false) {
  if (busy.value || !enabled.value) return;
  const previousDraft = improve ? result.value : draft.value;
  stop(); error.value = ''; notice.value = ''; result.value = ''; busy.value = true;
  const owner = ++generation;
  const question = instruction.value;
  const action = improve ? 'polish' : intent.value;
  service.value = config.value.writing.service || config.value.service;
  model.value = config.value.writing.model || resolveConfiguredModel(config.value.model[service.value], config.value.customModel[service.value]);
  try {
    cancel = streamWriting({type: 'fluentReadWriting', action: 'run', requestId: `writing-${crypto.randomUUID()}`, intent: action,
      instruction: question, draft: previousDraft.slice(0, 12000), context: context.value, language: language.value, tone: tone.value, history: action === 'chat' ? history.slice(-4) : []}, {
      progress(value) { if (owner !== generation) return; if (value.kind === 'text') result.value = value.text; else { service.value = value.service; model.value = value.model; } },
      result(value) {
        if (owner !== generation) return;
        busy.value = false; cancel = undefined;
        if (value.success) { result.value = value.text; service.value = value.service; model.value = value.model;
          if (action === 'chat') { history.push({question, answer: value.text.slice(0, 12000)}); if (history.length > 4) history.shift(); }
        } else if (value.cancelled) notice.value = value.error; else error.value = value.error;
      },
    });
  } catch { busy.value = false; error.value = '写作助手暂时不可用，请刷新页面后重试。'; }
}
async function copy() { try { await navigator.clipboard.writeText(result.value); notice.value = '正文已复制。'; } catch { error.value = '复制失败，请选中生成正文手动复制。'; } }
function apply() { const failure = props.applyDraft?.(result.value); if (failure) error.value = failure; else notice.value = '已填入回复框，请检查后自行发送。'; }
function openSettings() { void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-writing'}).catch(() => { error.value = '请从扩展菜单打开完整设置。'; }); }
</script>
<style scoped>
.writing-panel{--w-bg:#fff;--w-soft:#f7f8fa;--w-ink:#28323f;--w-muted:#88929f;--w-line:#edf0f3;--w-brand:#ef4776;position:relative;width:100%;height:440px;box-sizing:border-box;max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--w-bg);color:var(--w-ink);border:1px solid var(--w-line);border-radius:18px;box-shadow:0 12px 48px #152c411c;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;color-scheme:light;overflow:hidden;outline:none;}
.writing-panel.is-dark{--w-bg:#24262e;--w-soft:#2c2e38;--w-ink:#edf0f5;--w-muted:#a1a8b5;--w-line:#393c48;--w-brand:#fa83a7;color-scheme:dark;}
.writing-panel *{box-sizing:border-box}.writing-header{flex-shrink:0;display:flex;align-items:center;gap:12px;padding:18px 20px 10px}.writing-brand{display:flex;align-items:center;gap:9px;flex:1;min-width:0}.writing-header h2{margin:0;font-size:16px;line-height:1.4;font-weight:680;white-space:nowrap}.writing-mark{width:26px;height:26px;object-fit:contain;flex-shrink:0}.writing-provider{max-width:200px;min-width:0;border-radius:8px;background:var(--w-soft);padding:4px 10px;font-size:11px;line-height:1.5}.writing-provider span,.writing-provider small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.writing-provider small{font-size:9px;color:var(--w-muted)}.writing-panel button,.writing-panel select,.writing-panel textarea{font:inherit;color:inherit}.writing-panel button{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;cursor:pointer}.writing-icon{flex-shrink:0;border:0;background:transparent;color:var(--w-muted)!important;padding:4px;font-size:23px!important;line-height:1;cursor:pointer}.writing-icon svg{width:17px;height:17px}.writing-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 20px 14px}.writing-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.writing-title h3{font-size:15px;font-weight:650;margin:0}.writing-title>span{font-size:11px;color:var(--w-brand)}.writing-subtitle{font-size:11px;color:var(--w-muted);margin:5px 0 8px}.writing-reference{font-size:11px;color:var(--w-muted);margin-bottom:8px}.writing-reference summary{cursor:pointer;padding:4px 0;list-style:none;display:flex;gap:8px;align-items:center}.writing-reference summary:before{content:'›';font-size:15px}.writing-reference[open] summary:before{transform:rotate(90deg)}.writing-reference summary span{margin-left:auto;font-size:10px}.writing-field{display:flex;flex-direction:column;gap:5px;margin:8px 0}.writing-field small{font-size:10px;font-weight:400;margin-left:8px}.writing-panel textarea{width:100%;display:block;resize:vertical;min-height:40px;max-height:260px;border:1px solid var(--w-line);border-radius:8px;padding:10px;background:var(--w-soft);font-size:13px;line-height:1.8;outline:none;}.writing-panel textarea::placeholder{color:var(--w-muted)}.writing-panel textarea.writing-output{border:0;padding:12px 0 8px;background:transparent;min-height:110px;font-size:14px;line-height:1.9;resize:vertical}.writing-panel :is(button,select,textarea,summary):focus-visible{outline:2px solid var(--w-brand);outline-offset:2px}.writing-panel :disabled{opacity:.5;cursor:default}.writing-empty{padding:25px 10px 30px;text-align:center}.writing-empty p{font-size:12px;color:var(--w-muted);margin:0 0 17px}.writing-button{flex-shrink:0;border:1px solid var(--w-line);border-radius:8px;padding:6px 12px;background:var(--w-bg);font-size:12px!important;line-height:1.5;cursor:pointer}.writing-button.primary{background:var(--w-brand);border-color:var(--w-brand);color:var(--w-bg);font-weight:600}.writing-toolbar{display:flex;align-items:center;gap:12px;margin-top:10px}.writing-preferences{display:flex;align-items:center;gap:6px;margin-right:auto;min-width:0}.writing-preferences select{font-size:11px;width:auto;max-width:118px;min-width:0;border:0;padding:5px 16px 5px 0;background:var(--w-bg);color:var(--w-muted)}.writing-insert{margin-left:2px}.writing-composer{flex-shrink:0;display:flex;align-items:center;gap:12px;padding:14px 20px;border-top:1px solid var(--w-line)}.writing-composer textarea{resize:none;border:0;background:transparent;padding:4px 0;min-height:30px;font-size:12px}.writing-composer button{padding:4px 9px;font-size:20px!important}.writing-footnote{flex-shrink:0;font-size:9px!important;color:var(--w-muted);padding:0 20px 12px;margin:0!important;line-height:1.65!important}.writing-notice,.writing-error{font-size:11px;margin:9px 0 0;overflow-wrap:anywhere}.writing-notice{color:var(--w-brand)}.writing-error{color:#c55b4e}.writing-error button{border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
@media(max-width:540px){.writing-header{padding:15px 15px 8px;gap:8px}.writing-scroll{padding:10px 15px}.writing-composer{padding:12px 15px}.writing-provider{max-width:125px}.writing-toolbar{gap:8px}.writing-preferences{gap:2px}.writing-preferences select{max-width:94px;font-size:10px}.writing-title h3{font-size:14px}.writing-header h2{font-size:14px}.writing-button{padding:6px 10px}}
</style>
