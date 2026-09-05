<!--
 * @file src/features/vocabulary/ui/VocabularyStudy.vue
 * 文件职责：围绕一个主动收藏的表达提供原句阅读、定向讲解和自主造句反馈。
 * 主要内容：展示真实来源和收藏参考，复用 Harness 流式客户端按需分析，区分理解与造句结果，并在切换词条、配置变化或卸载时取消旧请求。
 * 模块边界：不挑选随机词、不自动请求模型或改变掌握度；不访问数据库和服务密钥，问答沿用后台会话保存与模型配置。
 -->
<template>
  <section class="word-study" aria-label="表达学习">
    <header class="study-header">
      <button type="button" @click="emit('close')">‹ 返回收藏</button>
      <span>理解原句 → 学会用法 → 自己表达</span>
    </header>
    <div class="study-source">
      <div class="study-title"><h3 data-i18n-ignore>{{ entry.term }}</h3><button type="button" @click="emit('speak')">朗读原文</button></div>
      <template v-if="context">
        <h4>你收藏时的原句</h4>
        <blockquote data-i18n-ignore>{{ context.text }}</blockquote>
        <a v-if="context.sourceUrl" :href="context.sourceUrl" target="_blank" rel="noopener noreferrer"><span data-i18n-ignore>{{ context.pageTitle || translateLegacy('查看原文来源') }}</span> ↗</a>
      </template>
      <p v-else class="study-hint">这条收藏没有可用的原句。可以先了解常见用法；下次连同原句收藏，更容易判断具体含义。</p>
      <details v-if="reference" class="study-reference"><summary>收藏时的参考内容</summary><ReadingAnswer :text="reference" /></details>
    </div>
    <div class="study-workspace">
      <section class="study-step">
        <h4>1 · 读懂与会用</h4>
        <p class="study-hint">围绕这个表达，理解含义、常用搭配和一个可迁移的例句。</p>
        <button type="button" class="study-primary" :disabled="busy" @click="run('understand')">{{ explanation ? '重新讲解' : '理解这个表达' }}</button>
        <ReadingAnswer v-if="explanation" :text="explanation" />
      </section>
      <section class="study-step">
        <h4>2 · 用自己的话说一句</h4>
        <p class="study-hint"><span data-i18n-ignore>{{ t("learning.writeSentenceHint", {term: entry.term}) }}</span></p>
        <form @submit.prevent="run('use')">
          <textarea v-model="draft" maxlength="300" rows="3" aria-label="我的造句" placeholder="写下你自己的句子…" :disabled="busy" @keydown.stop />
          <button type="submit" class="study-primary" :disabled="busy || !draft.trim()">看看用得是否自然</button>
        </form>
        <div v-if="feedback" class="study-feedback"><p class="submitted-sentence">你的句子：<span data-i18n-ignore>{{ submittedDraft }}</span></p><ReadingAnswer :text="feedback" /></div>
      </section>
    </div>
    <p v-if="busy" class="study-status" role="status">{{ mode === 'use' ? '正在检查你的表达…' : '正在结合语境讲解…' }} <button type="button" @click="stop">停止</button></p>
    <p v-if="error" class="study-error" role="alert">{{ error }} <button type="button" @click="run(mode)">重试</button></p>
    <p v-if="!enabled" class="study-hint">按需讲解使用翻译卡的服务与模型。<button type="button" @click="emit('navigate', 'settings-harness')">开启翻译卡</button></p>
    <p v-else class="study-hint">{{ contextAllowed ? '点击时发送当前表达和收藏原句。' : '当前仅发送表达；可在翻译卡设置中允许参考原句。' }}<button type="button" @click="emit('navigate', 'settings-harness')">服务与原文范围</button></p>
    <p v-if="model" class="study-hint">{{ model }} · AI 讲解与反馈，掌握程度由你在复习时确认。</p>
    <p v-if="notice" class="study-hint" role="status">{{ notice }}</p>
  </section>
</template>
<script setup lang="ts">
import {useUiI18n} from "@/src/ui/i18n";
const {t, translateLegacy} = useUiI18n();
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {ReadingAnswer, streamReading} from '@/src/features/reading-assistant/public';
import {config, subscribeConfig} from '@/src/services/config/store';
import {vocabularyStudyContext, type VocabularyEntry} from '../learningModel';

const props = defineProps<{entry: VocabularyEntry; reference: string}>();
const emit = defineEmits<{close: []; speak: []; navigate: [section: string]}>();
const context = computed(() => vocabularyStudyContext(props.entry));
const enabled = ref(config.on && config.harness.enabled);
const contextAllowed = ref(config.harness.contextMode === 'paragraph');
const explanation = ref('');
const feedback = ref('');
const draft = ref('');
const submittedDraft = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const model = ref('');
const mode = ref<'understand' | 'use'>('understand');
let generation = 0;
let pending: {cancel: () => void} | undefined;
let active = true;
function stop(): void {
  generation += 1;
  pending?.cancel();
  pending = undefined;
  if (busy.value) notice.value = '已停止，当前内容尚未完成。';
  busy.value = false;
}
function reset(): void {
  stop(); explanation.value = ''; feedback.value = ''; draft.value = ''; submittedDraft.value = ''; error.value = ''; notice.value = ''; model.value = '';
}
function run(nextMode: 'understand' | 'use'): void {
  if (busy.value || (nextMode === 'use' && !draft.value.trim())) return;
  if (!enabled.value) { emit('navigate', 'settings-harness'); return; }
  stop();
  mode.value = nextMode;
  const owner = generation;
  const owns = () => active && owner === generation;
  error.value = ''; notice.value = ''; busy.value = true;
  if (nextMode === 'understand') explanation.value = '';
  else { feedback.value = ''; submittedDraft.value = draft.value.trim(); }
  const setAnswer = (text: string) => { if (nextMode === 'understand') explanation.value = text; else feedback.value = text; };
  try {
    pending = streamReading({type:'fluentReadHarness', action:'run', requestId:crypto.randomUUID(), intent: nextMode === 'use' ? 'practice' : 'usage',
      selection: {text:props.entry.term, context:contextAllowed.value ? context.value?.text || '' : '', sentence:''},
      studyMode:nextMode, question:nextMode === 'understand' ? '理解这个表达的含义与用法' : submittedDraft.value,
    }, {
      progress(progress) {
        if (!owns()) return;
        if (progress.kind === 'text') setAnswer(progress.text);
        if (progress.kind === 'model') model.value = progress.model;
        if (progress.kind === 'session' && progress.warning) notice.value = progress.warning;
      },
      result(response) {
        if (!owns()) return;
        busy.value = false; pending = undefined;
        if (response.success) { setAnswer(response.text); model.value = response.model; notice.value = response.persistenceWarning || ''; }
        else error.value = response.error;
      },
      error(failure) { if (owns()) { busy.value = false; pending = undefined; error.value = failure.message; } },
    });
  } catch (failure) { if (owns()) { busy.value = false; error.value = failure instanceof Error ? failure.message : '讲解暂时不可用，请重试。'; } }
}
watch(() => [props.entry.id, props.entry.updatedAt], reset);
// 配置快照变化时使旧模型响应失效；下一次明确操作才重新发起请求。
let revision = JSON.stringify(config);
const unsubscribe = subscribeConfig(next => {
  enabled.value = next.on && next.harness.enabled;
  contextAllowed.value = next.harness.contextMode === 'paragraph';
  const nextRevision = JSON.stringify(next);
  if (revision !== nextRevision) { stop(); notice.value = '设置已更新，下次讲解会使用新的设置。'; revision = nextRevision; }
});
onBeforeUnmount(() => { active = false; stop(); unsubscribe(); });
</script>
<style scoped>
.word-study { color:var(--ink); display:grid; gap:18px; }
.study-header,.study-title { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.study-header span,.study-hint { color:var(--muted); font-size:12px; line-height:1.8; }
.word-study button { font:inherit; cursor:pointer; background:var(--surface); color:var(--brand); border:1px solid var(--line); border-radius:9px; padding:8px 12px; }
.word-study button:disabled { opacity:.5; cursor:not-allowed; }
.study-source,.study-step { background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:22px; min-width:0; overflow-wrap:anywhere; }
.study-title h3 { font-size:26px; margin:0; overflow-wrap:anywhere; }
.word-study h4 { margin:18px 0 10px; font-size:14px; }
.study-step h4 { margin-top:0; }
.word-study blockquote { margin:12px 0; padding:12px 16px; background:var(--surface-soft); border-left:3px solid var(--brand); border-radius:6px; line-height:1.8; white-space:pre-wrap; }
.word-study a { color:var(--brand); font-size:12px; }
.study-reference { margin-top:18px; color:var(--muted); font-size:12px; }
.study-reference summary { cursor:pointer; margin-bottom:12px; }
.study-workspace { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.study-step :deep(.fr-reading-markdown) { margin-top:18px; }
.word-study textarea { box-sizing:border-box; width:100%; min-height:110px; resize:vertical; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--surface-soft); color:var(--ink); font:inherit; line-height:1.6; margin:0 0 12px; }
.word-study .study-primary { background:var(--el-color-primary-dark-2,#cf315e); color:#fff; border-color:var(--brand); }
.study-status,.study-error { padding:12px; border-radius:10px; background:var(--surface-soft); font-size:13px; }
.study-error { color:var(--danger,#b42318); }
.study-feedback { margin-top:18px; }
.submitted-sentence { border-left:2px solid var(--line); padding-left:12px; font-size:13px; line-height:1.6; }
.word-study button:focus-visible,.word-study textarea:focus-visible,.study-reference summary:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
@media(max-width:760px) { .study-workspace { grid-template-columns:1fr; } .study-header { align-items:flex-start; flex-direction:column; } .study-source,.study-step { padding:16px; } }
</style>
