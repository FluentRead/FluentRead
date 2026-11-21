<!--
 * @file src/features/selection-translation/ui/DictionaryCardTools.vue
 * 文件职责：在既有划词卡中提供离线原版排版、按需网页来源与可预览的双面卡导出。
 * 主要内容：复用词卡字段和用户模板，在紧凑展开区预览卡片并导出 CSV、Markdown 或 Anki；网页只在点击后加载。
 * 模块边界：不直接请求供应商或 Anki，不写词书；关闭或切词时销毁 iframe，模板始终作为纯文本显示。
 -->
<template>
  <div class="fr-dictionary-tools" :class="{'fr-dictionary-tools--dark': dark}" data-i18n-ignore>
    <dl v-if="entry.etymology || entry.inflections">
      <template v-if="entry.etymology"><dt>{{ t('dictionary.etymology') }}</dt><dd>{{ entry.etymology }}</dd></template>
      <template v-if="entry.inflections"><dt>{{ t('dictionary.inflections') }}</dt><dd>{{ entry.inflections }}</dd></template>
    </dl>
    <details v-if="entry.html" class="fr-dictionary-original">
      <summary>{{ t('dictionary.original') }}</summary>
      <iframe :srcdoc="originalDocument" sandbox="" :title="t('dictionary.original')" referrerpolicy="no-referrer" />
    </details>
    <div v-if="entry.webUrl" class="fr-dictionary-web">
      <button type="button" @click="webOpen = !webOpen">{{ t(webOpen ? 'dictionary.closeWeb' : 'dictionary.openWeb') }}</button>
      <a :href="entry.webUrl" target="_blank" rel="noopener noreferrer">{{ t('dictionary.newTab') }}</a>
      <p>{{ t('dictionary.frameHelp') }}</p>
      <iframe v-if="webOpen" :src="entry.webUrl" sandbox="allow-scripts" :title="entry.source" referrerpolicy="no-referrer" />
    </div>
    <details @toggle="message = ''">
      <summary>{{ t('dictionary.card') }}</summary>
      <div class="fr-dictionary-card-preview">
        <span>{{ t('dictionary.front') }}</span><pre>{{ card.front }}</pre>
        <span>{{ t('dictionary.back') }}</span><pre>{{ card.back }}</pre>
      </div>
      <div class="fr-dictionary-export">
        <button type="button" :disabled="busy || !card.front.trim() || !card.back.trim()" @click="anki">Anki</button>
        <button type="button" @click="download('csv')">CSV</button>
        <button type="button" @click="download('md')">Markdown</button>
      </div>
      <p v-if="message" role="status">{{ message }}</p>
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
.fr-dictionary-tools{font-size:12px;margin-top:12px;border-top:1px solid #aaa4;padding-top:10px;color:#544e56}.fr-dictionary-tools--dark{color:#e5dee4}
summary{cursor:pointer;padding:6px 0;color:inherit}iframe{display:block;width:100%;height:280px;border:1px solid #aaa4;border-radius:8px;margin-top:8px;background:transparent}
.fr-dictionary-card-preview{padding:10px;border:1px solid #aaa4;border-radius:8px;margin:6px 0}.fr-dictionary-card-preview span{opacity:.65;font-size:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:6px 0 12px;max-height:180px;overflow:auto}
.fr-dictionary-export{display:flex;gap:8px;flex-wrap:wrap}button,a{font:inherit;color:inherit}button{border:1px solid #aaa4;border-radius:6px;background:transparent;padding:5px 10px;cursor:pointer}button:disabled{opacity:.5;cursor:default}a{margin-left:12px}p{font-size:11px;line-height:1.6}button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #a2687d;outline-offset:2px}
dl{margin:4px 0 8px;line-height:1.7}dt{font-size:11px;opacity:.65}dd{margin:2px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}@media(any-pointer:coarse){button,summary{min-height:44px;box-sizing:border-box}}
</style>
