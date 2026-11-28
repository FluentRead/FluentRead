<!--
 * @file src/features/vocabulary/ui/ReencounterPanel.vue
 * 文件职责：在独立 Shadow UI 中呈现阅读时再次遇见的表达与新旧原句对照。
 * 主要内容：提供可键盘访问的轻量入口、附近命中导航、真实原句和收藏参考；仅在反馈展示边界本地化读取、讲解与保存提示，不扫描用户原句；主动请求当前语境讲解，无关配置通知保留当前回答，讲解输入变化与卸载取消旧请求，支持重试、本次暂停和关闭标记。
 * 模块边界：不扫描或改写网页、不读取词书数据库、不更新掌握度；读取交给内容挂载器，模型交给既有阅读助手，界面样式只作用于本组件。
 -->
<template>
  <div v-if="!state.paused" class="reencounter-ui" :class="{dark}">
    <button v-if="state.occurrences.length && !state.current" class="reencounter-entry" type="button" @click="open(state.occurrences[0])">
      <UiIcon name="book" :size="15" /><span>{{ t('reencounter.entry', {count: state.occurrences.length}) }}</span>
    </button>
    <section v-if="state.current" ref="panel" class="reencounter-panel" role="dialog" :aria-label="t('reencounter.title')" :style="position" @keydown.esc.stop="close">
      <header><span>{{ t('reencounter.title') }}</span><button ref="closeButton" type="button" :aria-label="t('reencounter.close')" @click="close">×</button></header>
      <h3 data-i18n-ignore>{{ state.current.entry.term }}</h3>
      <div class="sentence-section"><h4>{{ t('reencounter.current') }}</h4><blockquote data-i18n-ignore>{{ state.current.sentence }}</blockquote></div>
      <p v-if="state.loading" class="hint" role="status">{{ t('reencounter.loading') }}</p>
      <template v-else-if="state.saved">
        <div class="sentence-section"><h4>{{ t('reencounter.saved') }}</h4><blockquote v-if="state.saved.savedSentence" data-i18n-ignore>{{ state.saved.savedSentence }}</blockquote><p v-else class="hint">{{ t('reencounter.noSentence') }}</p><small v-if="state.saved.savedTitle" data-i18n-ignore>{{ state.saved.savedTitle }}</small></div>
        <details v-if="state.saved.reference" class="saved-reference"><summary>{{ t('reencounter.reference') }}</summary><ReadingAnswer :text="state.saved.reference" /></details>
      </template>
      <p v-if="state.error" class="error" role="alert">{{ state.error === '收藏暂时无法读取' ? t('reencounter.readFailed') : translateLegacy(state.error) }} <button type="button" @click="retry">{{ t('reencounter.retry') }}</button></p>
      <div class="meaning-actions"><button v-if="canExplain" class="primary" type="button" :disabled="busy" @click="explain">{{ answer ? t('reencounter.explainAgain') : t('reencounter.explain') }}</button><button v-if="busy" type="button" @click="stop">{{ t('reencounter.stop') }}</button><button v-if="!canExplain" type="button" @click="settings">{{ t('reencounter.setup') }}</button></div>
      <p v-if="busy" class="hint" role="status">{{ t('reencounter.explaining') }}</p>
      <ReadingAnswer v-if="answer" :text="answer" />
      <p v-if="error" class="error" role="alert">{{ translateLegacy(error) }} <button type="button" @click="explain">{{ t('reencounter.retry') }}</button></p>
      <p v-if="notice" class="hint" role="status">{{ translateLegacy(notice) }}</p>
      <p class="hint">{{ contextAllowed ? t('reencounter.requestScope') : t('reencounter.contextDisabled') }}</p>
      <footer><nav v-if="state.occurrences.length > 1" :aria-label="t('reencounter.navigation')"><button type="button" @click="step(-1)">‹</button><span>{{ currentIndex + 1 }} / {{ state.occurrences.length }}</span><button type="button" @click="step(1)">›</button></nav><details><summary>{{ t('reencounter.options') }}</summary><div class="menu"><button type="button" @click="pause">{{ t('reencounter.pause') }}</button><button type="button" @click="disable">{{ t('reencounter.disable') }}</button></div></details></footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import {config, subscribeConfig} from '@/src/services/config/store';
import {getHarnessRequestConfigKey} from '@/src/core/config/harness';
import {useUiI18n} from '@/src/ui/i18n';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
import {streamReading} from '@/src/features/reading-assistant/public';
import type {ReencounterState} from '../content/reencounterState';
import type {ReencounterOccurrence} from '../content/readingText';

const props = defineProps<{state: ReencounterState; open: (occurrence: ReencounterOccurrence) => unknown; close: () => void;
  pause: () => void; disable: () => unknown; retry: () => unknown}>();
const {t, translateLegacy} = useUiI18n();
const prefs = ref({...config});
const media = window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(media.matches);
const dark = computed(() => prefs.value.theme === 'dark' || (prefs.value.theme === 'auto' && systemDark.value));
const canExplain = computed(() => prefs.value.on && prefs.value.harness.enabled && prefs.value.harness.actions.includes('usage') && contextAllowed.value);
const contextAllowed = computed(() => prefs.value.harness.contextMode === 'paragraph' && prefs.value.harness.maxContextChars > 0);
const currentIndex = computed(() => Math.max(0, props.state.occurrences.findIndex(item => item.entry.id === props.state.current?.entry.id
  && item.ranges[0]?.startContainer === props.state.current.ranges[0]?.startContainer && item.ranges[0]?.startOffset === props.state.current.ranges[0]?.startOffset)));
const panel = ref<HTMLElement>(); const closeButton = ref<HTMLButtonElement>();
const position = ref({left: '12px', top: '12px'});
const answer = ref(''); const busy = ref(false); const error = ref(''); const notice = ref('');
let generation = 0; let active = true; let request: {cancel: () => void} | undefined;
let previousFocus: HTMLElement | null = null;
const abort = new AbortController();
function stop(): void { generation += 1; request?.cancel(); request = undefined; if (busy.value) notice.value = t('reencounter.stopped'); busy.value = false; }
function place(): void {
  const occurrence = props.state.current;
  if (!occurrence || !panel.value) return;
  const anchor = occurrence.ranges[0]?.getBoundingClientRect();
  if (!anchor) return;
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft || 0; const y = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth; const height = viewport?.height || window.innerHeight;
  const box = panel.value.getBoundingClientRect();
  position.value = {left: `${Math.max(x + 12, Math.min(anchor.left, x + width - box.width - 12))}px`,
    top: `${Math.max(y + 12, Math.min(anchor.bottom + 8, y + height - box.height - 12))}px`};
}
function step(direction: number): void { const list = props.state.occurrences; props.open(list[(currentIndex.value + direction + list.length) % list.length]); }
function settings(): void { void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-selection'}).catch(() => undefined); }
function explain(): void {
  if (busy.value || !props.state.current || !canExplain.value) return;
  stop(); const owner = generation; const owns = () => active && owner === generation;
  answer.value = ''; error.value = ''; notice.value = ''; busy.value = true;
  const occurrence = props.state.current;
  try {
    request = streamReading({type: 'fluentReadHarness', action: 'run', requestId: crypto.randomUUID(), intent: 'usage',
      selection: {text: occurrence.entry.term, context: occurrence.sentence, sentence: ''},
      question: t('reencounter.question'),
    }, {
      progress(progress) { if (!owns()) return; if (progress.kind === 'text') answer.value = progress.text; },
      result(response) { if (!owns()) return; request = undefined; busy.value = false;
        if (response.success) { answer.value = response.text; notice.value = response.persistenceWarning || ''; } else error.value = response.error; },
      error(failure) { if (owns()) { busy.value = false; request = undefined; error.value = failure.message; } },
    });
  } catch (failure) { if (owns()) { busy.value = false; error.value = failure instanceof Error ? failure.message : t('reencounter.failed'); } }
}
watch(() => props.state.current, async (current, previous) => {
  const root = panel.value?.getRootNode();
  const hadFocus = panel.value?.contains(root instanceof ShadowRoot ? root.activeElement : document.activeElement);
  stop(); answer.value = ''; error.value = ''; notice.value = '';
  if (current && !previous) previousFocus = document.activeElement as HTMLElement | null;
  await nextTick(); if (!active) return;
  if (current) { place(); closeButton.value?.focus({preventScroll: true}); }
  else if (hadFocus) previousFocus?.focus({preventScroll: true});
}, {immediate: true});
watch(() => [answer.value, props.state.saved, props.state.loading], () => { void nextTick(place); });
let revision = getHarnessRequestConfigKey(config);
const unsubscribe = subscribeConfig(next => {
  prefs.value = {...next};
  const nextRevision = getHarnessRequestConfigKey(next);
  if (revision !== nextRevision) { stop(); revision = nextRevision; }
});
const mediaChanged = () => { systemDark.value = media.matches; };
onMounted(() => {
  media.addEventListener('change', mediaChanged);
  document.addEventListener('scroll', place, {passive: true, capture: true, signal: abort.signal});
  window.addEventListener('resize', place, {passive: true, signal: abort.signal});
  window.visualViewport?.addEventListener('resize', place, {passive: true, signal: abort.signal});
  window.visualViewport?.addEventListener('scroll', place, {passive: true, signal: abort.signal});
  document.addEventListener('pointerdown', event => {
    if (props.state.current && !event.composedPath().some(node => node instanceof HTMLElement && node.id === 'fluent-read-vocabulary-reencounter')) props.close();
  }, {capture: true, signal: abort.signal});
});
onBeforeUnmount(() => { active = false; stop(); unsubscribe(); media.removeEventListener('change', mediaChanged); abort.abort(); });
</script>
<style scoped>
.reencounter-ui{--brand:#ef4776;--ink:#283042;--muted:#657184;--surface:#fff;--soft:#f6f7fa;--line:#e5e8ee;color:var(--ink);font:14px/1.65 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
.reencounter-ui.dark{--ink:#edf0f6;--muted:#abb6c8;--surface:#202531;--soft:#2b3240;--line:#414a5c;}
.reencounter-entry{position:fixed;right:18px;bottom:18px;display:flex;align-items:center;gap:7px;padding:7px 11px!important;box-shadow:0 3px 14px #00000014;font-size:12px!important;}
.reencounter-ui button{color:var(--ink);font:inherit;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:6px 10px;cursor:pointer;}
.reencounter-ui button:hover{background:var(--soft);}.reencounter-ui button:disabled{opacity:.5;cursor:default;}
.reencounter-ui button:focus-visible,.reencounter-ui summary:focus-visible{outline:2px solid var(--brand);outline-offset:3px;}
.reencounter-panel{position:fixed;width:min(410px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px #00000024;padding:16px;overflow-wrap:anywhere;overscroll-behavior:contain;}
.reencounter-panel header,.reencounter-panel footer{display:flex;align-items:center;justify-content:space-between;gap:10px;}.reencounter-panel header{font-size:11px;color:var(--muted);}.reencounter-panel header button{font-size:20px;line-height:1;padding:4px 8px;}
.reencounter-panel h3{font-size:23px;line-height:1.4;margin:10px 0 16px;}.reencounter-panel h4{font-size:11px;color:var(--muted);font-weight:500;margin:0 0 6px;}
.sentence-section{margin-top:14px;}.sentence-section blockquote{margin:0;border-left:2px solid var(--brand);padding:8px 11px;background:var(--soft);border-radius:0 8px 8px 0;white-space:pre-wrap;}.sentence-section small{display:block;color:var(--muted);font-size:10px;margin:5px 0;}
.hint{font-size:11px;color:var(--muted);line-height:1.65;}.error{font-size:12px;color:#d04b5b;}.meaning-actions{display:flex;gap:8px;margin-top:16px;}.reencounter-ui .primary{background:var(--brand);color:white;border-color:var(--brand);}
.saved-reference{margin-top:12px;}.saved-reference summary{color:var(--muted);font-size:11px;cursor:pointer;}.reencounter-panel :deep(.fr-reading-markdown){font-size:13px;margin-top:12px;}
.reencounter-panel footer{border-top:1px solid var(--line);padding-top:10px;margin-top:14px;font-size:11px;}.reencounter-panel nav{display:flex;align-items:center;gap:8px;}.reencounter-panel footer details{margin-left:auto;}.reencounter-panel footer summary{cursor:pointer;color:var(--muted);}.menu{display:grid;gap:6px;margin-top:8px;}
</style>
