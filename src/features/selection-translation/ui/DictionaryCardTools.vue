<!--
 * @file src/features/selection-translation/ui/DictionaryCardTools.vue
 * 文件职责：在既有划词卡中提供离线原版排版、按需网页来源与可预览的双面卡导出。
 * 主要内容：复用词卡字段和用户模板，在紧凑展开区预览卡片并导出 CSV、Markdown 或 Anki；网页只在点击后加载。
 * 模块边界：不直接请求供应商或 Anki，不写词书；关闭或切词时销毁 iframe，模板始终作为纯文本显示。
 -->
<template>
  <div class="fr-dictionary-tools" :class="{'fr-dictionary-tools--dark': dark}" data-i18n-ignore>
    <dl v-if="entry.etymology || entry.inflections" class="fr-dictionary-facts">
      <template v-if="entry.etymology"><dt>{{ t('dictionary.etymology') }}</dt><dd>{{ entry.etymology }}</dd></template>
      <template v-if="entry.inflections"><dt>{{ t('dictionary.inflections') }}</dt><dd>{{ entry.inflections }}</dd></template>
    </dl>
    <details v-if="entry.html" class="fr-dictionary-disclosure fr-dictionary-original">
      <summary><UiIcon name="chevron-down" :size="13" class="fr-dictionary-chevron" /><span>{{ t('dictionary.original') }}</span></summary>
      <iframe :srcdoc="originalDocument" sandbox="" :title="t('dictionary.original')" referrerpolicy="no-referrer" />
    </details>
    <div v-if="entry.webUrl" class="fr-dictionary-web">
      <div class="fr-dictionary-web-actions">
        <button type="button" @click="webOpen = !webOpen">{{ t(webOpen ? 'dictionary.closeWeb' : 'dictionary.openWeb') }}</button>
        <a :href="entry.webUrl" target="_blank" rel="noopener noreferrer">{{ t('dictionary.newTab') }}</a>
      </div>
      <p>{{ t('dictionary.frameHelp') }}</p>
      <iframe v-if="webOpen" :src="entry.webUrl" sandbox="allow-scripts" :title="entry.source" referrerpolicy="no-referrer" />
    </div>
    <details class="fr-dictionary-disclosure" @toggle="message = ''">
      <summary><UiIcon name="chevron-down" :size="13" class="fr-dictionary-chevron" /><span>{{ t('dictionary.card') }}</span></summary>
      <div class="fr-dictionary-card-panel">
        <div class="fr-dictionary-card-preview">
          <div class="fr-dictionary-card-side">
            <span>{{ t('dictionary.front') }}</span>
            <pre>{{ card.front }}</pre>
          </div>
          <div class="fr-dictionary-card-side">
            <span>{{ t('dictionary.back') }}</span>
            <pre>{{ card.back }}</pre>
          </div>
        </div>
        <div class="fr-dictionary-export">
          <button type="button" class="fr-dictionary-export-primary" :disabled="busy || !card.front.trim() || !card.back.trim()" @click="anki">Anki</button>
          <button type="button" @click="download('csv')">CSV</button>
          <button type="button" @click="download('md')">Markdown</button>
        </div>
        <p v-if="message" class="fr-dictionary-status" role="status">{{ message }}</p>
      </div>
    </details>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import type {DictionaryWorkspace} from '@/src/core/config/dictionaryWorkspace';
import type {DictionaryEntry} from '../dictionary/model';
import {dictionaryCard, dictionaryCsv, dictionaryMarkdown} from '../dictionary/model';
import {dictionaryDocument} from '../dictionary/presentation';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';
import {useUiI18n} from '@/src/ui/i18n';
import UiIcon from '@/src/ui/components/UiIcon.vue';
const {t} = useUiI18n();
const props = defineProps<{entry: DictionaryEntry; workspace: DictionaryWorkspace; context: string; explanation: string; dark: boolean}>();
const webOpen = ref(false), busy = ref(false), message = ref('');
const card = computed(() => dictionaryCard(props.entry, props.context, props.explanation, props.workspace));
const originalDocument = computed(() => dictionaryDocument(props.entry.html || '', props.entry.css || '', props.dark));
function download(format: 'csv' | 'md'): void {
  try {downloadTextFile(`FluentRead-card.${format}`, format === 'csv' ? dictionaryCsv(card.value) : dictionaryMarkdown(card.value), format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8'); message.value = t('dictionary.exported');}
  catch {message.value = t('dictionary.exportError');}
}
async function anki(): Promise<void> {
  if (busy.value) return;
  busy.value = true; message.value = '';
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadDictionaryAnki', ...card.value}) as {success?: boolean};
    message.value = t(response?.success ? 'dictionary.ankiSaved' : 'dictionary.ankiError');
  } catch {message.value = t('dictionary.ankiError');}
  finally {busy.value = false;}
}
</script>
<style scoped>
.fr-dictionary-tools {
  --fr-dt-bg: #ffffff;
  --fr-dt-soft: #f7f8fb;
  --fr-dt-hover: #eff1f6;
  --fr-dt-line: #e7eaf1;
  --fr-dt-line-strong: #d2d7e2;
  --fr-dt-ink: #172033;
  --fr-dt-muted: #5d6678;
  --fr-dt-active-ink: #d4235a;
  --fr-dt-active-bg: #fff0f5;
  --fr-dt-active-border: rgba(239, 71, 118, .24);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--fr-dt-muted);
}
.fr-dictionary-tools--dark {
  --fr-dt-bg: #1c2028;
  --fr-dt-soft: #232833;
  --fr-dt-hover: #2b313e;
  --fr-dt-line: #2f3542;
  --fr-dt-line-strong: #434b5c;
  --fr-dt-ink: #f1f3f7;
  --fr-dt-muted: #a5aebf;
  --fr-dt-active-ink: #ff85ab;
  --fr-dt-active-bg: rgba(244, 101, 144, .16);
  --fr-dt-active-border: rgba(244, 101, 144, .30);
}
.fr-dictionary-disclosure > summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 2px 7px 2px 5px;
  border: 1px solid transparent;
  border-radius: 6px;
  list-style: none;
  cursor: pointer;
  color: var(--fr-dt-muted);
  font-size: 11px;
  font-weight: 500;
  transition: background-color 120ms cubic-bezier(.23, 1, .32, 1), border-color 120ms cubic-bezier(.23, 1, .32, 1), color 120ms cubic-bezier(.23, 1, .32, 1);
}
.fr-dictionary-disclosure > summary::-webkit-details-marker { display: none; }
.fr-dictionary-disclosure > summary:hover {
  border-color: var(--fr-dt-line);
  background: var(--fr-dt-soft);
  color: var(--fr-dt-ink);
}
.fr-dictionary-chevron {
  flex: none;
  transform: rotate(-90deg);
  transition: transform 150ms cubic-bezier(.23, 1, .32, 1);
}
.fr-dictionary-disclosure[open] > summary { color: var(--fr-dt-ink); }
.fr-dictionary-disclosure[open] > summary .fr-dictionary-chevron { transform: rotate(0deg); }
.fr-dictionary-card-panel { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.fr-dictionary-card-preview {
  display: grid;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--fr-dt-line);
  border-radius: 8px;
  background: var(--fr-dt-soft);
  color: var(--fr-dt-ink);
}
.fr-dictionary-card-side + .fr-dictionary-card-side {
  padding-top: 8px;
  border-top: 1px solid var(--fr-dt-line);
}
.fr-dictionary-card-side span {
  display: block;
  margin-bottom: 3px;
  color: var(--fr-dt-muted);
  font-size: 11px;
  font-weight: 600;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 12px;
  line-height: 1.55;
  margin: 0;
  max-height: 140px;
  overflow: auto;
}
.fr-dictionary-export, .fr-dictionary-web-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
button, a { font: inherit; color: inherit; }
button {
  min-height: 27px;
  padding: 0 10px;
  border: 1px solid var(--fr-dt-line);
  border-radius: 7px;
  background: var(--fr-dt-bg);
  color: var(--fr-dt-ink);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 120ms cubic-bezier(.23, 1, .32, 1), background-color 120ms cubic-bezier(.23, 1, .32, 1), color 120ms cubic-bezier(.23, 1, .32, 1);
}
button:hover:not(:disabled) {
  border-color: var(--fr-dt-line-strong);
  background: var(--fr-dt-hover);
}
.fr-dictionary-export-primary {
  border-color: var(--fr-dt-active-border);
  background: var(--fr-dt-active-bg);
  color: var(--fr-dt-active-ink);
  font-weight: 600;
}
.fr-dictionary-export-primary:hover:not(:disabled) {
  border-color: var(--fr-dt-active-ink);
  background: var(--fr-dt-active-bg);
}
button:disabled { opacity: .45; cursor: not-allowed; }
a { color: var(--fr-dt-active-ink); font-size: 11.5px; text-decoration: none; }
a:hover { text-decoration: underline; }
p { margin: 4px 0 0; font-size: 11px; line-height: 1.5; color: var(--fr-dt-muted); }
.fr-dictionary-status { margin: 0; color: var(--fr-dt-active-ink); }
iframe { display: block; width: 100%; height: 260px; border: 1px solid var(--fr-dt-line); border-radius: 8px; margin-top: 6px; background: transparent; }
.fr-dictionary-facts { margin: 0 0 2px; display: grid; gap: 4px; line-height: 1.55; }
.fr-dictionary-facts dt { font-size: 11px; font-weight: 600; color: var(--fr-dt-muted); }
.fr-dictionary-facts dd { margin: 0 0 4px; color: var(--fr-dt-ink); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--fr-dt-active-ink); outline-offset: 2px; }
@media (any-pointer: coarse) {
  button, .fr-dictionary-disclosure > summary { min-height: 44px; box-sizing: border-box; }
}
@media (prefers-reduced-motion: reduce) {
  .fr-dictionary-disclosure > summary, .fr-dictionary-chevron, button { transition: none; }
}
</style>
