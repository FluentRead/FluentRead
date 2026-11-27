<!--
 * @file src/features/reading-assistant/ui/ReadingAnswer.vue
 * 文件职责：统一呈现阅读回答、流式生成内容和已保存问答，提供清晰而紧凑的阅读层次。
 * 主要内容：把能够对应原文的首个词性表格提到回答顶部，纯表格章节的紧邻标题随之迁移，仍有正文的章节保留原标题；随后按原顺序呈现安全 Markdown 正文，流式追加时保留结构片段的选择，普通和不匹配表格保持原位，使用局部主题变量兼容选区 Shadow UI 与设置页面；有效引用显示原生定位按钮，无效引用保留快照状态，带引文的句法表保留表格以呈现每格依据，外部背景使用独立标记。
 * 模块边界：仅接收回答、可选原文与紧凑模式，不请求模型、不读取存储，不插入 HTML、不创建可点击外链或远程图片；经引用身份和原句校验的依据只通过所属页面端口定位。
 -->
<template>
  <div class="fr-reading-markdown" :class="{'is-compact': compact}" data-reading-answer data-i18n-ignore>
    <section v-if="structure" class="fr-reading-structure">
      <h3><AnswerInline :text="structure.heading" /></h3>
      <SentenceAnalysis :source="sourceText" :annotations="structure.annotations" />
    </section>
    <template v-for="({block, index}) in bodyBlocks" :key="index">
      <component :is="block.level <= 2 ? 'h3' : 'h4'" v-if="block.kind === 'heading'"><AnswerInline :text="block.text" /></component>
      <p v-else-if="block.kind === 'paragraph'"><AnswerInline :text="block.text" /></p>
      <blockquote v-else-if="block.kind === 'quote'"><AnswerInline :text="block.text" /></blockquote>
      <pre v-else-if="block.kind === 'code'"><code>{{ block.text }}</code></pre>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.ordered ? block.start : undefined">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><AnswerInline :text="item" /></li>
      </component>
      <SentenceAnalysis v-else-if="annotations[index]" :source="sourceText" :annotations="annotations[index]!" />
      <div v-else-if="block.kind === 'table'" class="fr-reading-table"><table><thead><tr><th v-for="(cell, column) in block.headers" :key="column" scope="col"><AnswerInline :text="cell" /></th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, column) in row" :key="column"><AnswerInline :text="cell" /></td></tr></tbody></table></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import SentenceAnalysis from './SentenceAnalysis.vue';
import ReadingEvidence from './ReadingEvidence.vue';
import {parseReadingEvidence, type ReadingEvidenceSource} from '@/src/core/harness/evidence';
import type {ReadingEvidenceAnchor, ReadingEvidenceLocation} from '../evidenceAnchor';
import {anchorSentenceAnalysis} from '../sentenceAnalysis';
import {computed, h} from 'vue';
import {readingAnswerBlocks, readingAnswerSpans} from '../answerFormat';
import {useUiI18n} from '@/src/ui/i18n';
// 显式函数类型让 Vue 正确生成运行时校验，同时继续从锚点接口推导参数和返回类型。
const props = withDefaults(defineProps<{text: string; compact?: boolean; sourceText?: string; evidenceSources?: readonly ReadingEvidenceSource[]; locateEvidence?: (...args: Parameters<ReadingEvidenceAnchor['locate']>) => ReturnType<ReadingEvidenceAnchor['locate']>; evidenceState?: ReadingEvidenceLocation}>(), {compact: true, sourceText: '', evidenceSources: () => []});
const {translateLegacy, t} = useUiI18n();
const blocks = computed(() => readingAnswerBlocks(props.text));
const annotations = computed(() => blocks.value.map(block => block.kind === 'table' && [...block.headers, ...block.rows.flat()].some(cell => cell.includes('[[cite:'))
  ? null : anchorSentenceAnalysis(block, props.sourceText)));
const structure = computed(() => {
  const index = annotations.value.findIndex(value => value !== null);
  if (index < 0) return null;
  const previous = blocks.value[index - 1];
  const following = blocks.value[index + 1];
  // 表格所在章节仍有正文或子标题时，原标题留在原处，避免正文归入上一节。
  const headingIndex = previous?.kind === 'heading'
    && (!following || following.kind === 'heading' && following.level <= previous.level) ? index - 1 : -1;
  return {index, headingIndex,
    heading: headingIndex >= 0 && previous.kind === 'heading' ? previous.text : translateLegacy('结构分析'),
    annotations: annotations.value[index]!};
});
const bodyBlocks = computed(() => blocks.value.map((block, index) => ({block, index}))
  .filter(({index}) => index !== structure.value?.index && index !== structure.value?.headingIndex));
const inlineTags = {text: 'span', strong: 'strong', emphasis: 'em', code: 'code'} as const;
const AnswerInline = ({text}: {text: string}) => parseReadingEvidence(text, props.evidenceSources).flatMap(block => {
  if (block.kind === 'citation') return [h(ReadingEvidence, {citation: block, locateEvidence: props.locateEvidence, sourceState: props.evidenceState})];
  if (block.kind === 'unavailable') return [h('span', {class: 'fr-reading-evidence-status', 'data-evidence-state': 'unverified'}, `${t('reading.evidence.unverified')} · ${block.text}`)];
  return readingAnswerSpans(block.text.replaceAll('[[external]]', `【${t('reading.evidence.external')}】`)).map(span => h(inlineTags[span.kind], span.text));
});
</script>
<style scoped>
.fr-reading-markdown {
  --fr-answer-quote: var(--el-text-color-regular, #475266);
  --fr-answer-border: var(--el-border-color-lighter, #e7eaf1);
  --fr-answer-soft: var(--el-fill-color-lighter, #f7f8fb);
  --fr-answer-code: var(--el-fill-color-light, #eff1f6);
  --fr-answer-accent: var(--el-color-primary, #ef4776);
  color: inherit;
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.fr-reading-markdown > :first-child { margin-top: 0; }
.fr-reading-markdown > :last-child { margin-bottom: 0; }
.fr-reading-structure { margin-bottom: 14px; }
.fr-reading-markdown .fr-reading-structure > h3 { margin: 0 0 8px; padding: 0; border: 0; }
.fr-reading-markdown h3, .fr-reading-markdown h4 { margin: 18px 0 7px; color: inherit; font-size: 13.5px; font-weight: 650; line-height: 1.45; }
.fr-reading-markdown h3 { font-size: 14.5px; }
.fr-reading-markdown h3:not(:first-child), .fr-reading-markdown h4:not(:first-child) { padding-top: 11px; border-top: 1px solid var(--fr-answer-border); }
.fr-reading-markdown p { margin: 0 0 10px; white-space: pre-line; }
.fr-reading-markdown ul, .fr-reading-markdown ol { margin: 5px 0 12px; padding-inline-start: 1.4em; }
.fr-reading-markdown li { padding-inline-start: 2px; margin: 4px 0; white-space: pre-line; }
.fr-reading-markdown li::marker { color: var(--fr-answer-accent); }
.fr-reading-markdown blockquote { margin: 10px 0; padding: 8px 12px; border-inline-start: 2.5px solid color-mix(in srgb, var(--fr-answer-accent) 48%, transparent); color: var(--fr-answer-quote); background: var(--fr-answer-soft); border-radius: 0 7px 7px 0; white-space: pre-line; }
.fr-reading-markdown :deep(strong) { color: inherit; font-weight: 650; }
.fr-reading-markdown :deep(code) { padding: 1.5px 5px; border-radius: 5px; background: var(--fr-answer-code); color: inherit; font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
.fr-reading-markdown pre { margin: 10px 0; padding: 10px 12px; max-width: 100%; overflow: auto; border: 1px solid var(--fr-answer-border); border-radius: 8px; background: var(--fr-answer-soft); line-height: 1.6; }
.fr-reading-markdown pre code { display: block; padding: 0; background: transparent; white-space: pre; }
.fr-reading-table { max-width: 100%; margin: 10px 0; overflow-x: auto; border: 1px solid var(--fr-answer-border); border-radius: 8px; }
.fr-reading-table table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fr-reading-table th, .fr-reading-table td { padding: 7px 10px; border-bottom: 1px solid var(--fr-answer-border); text-align: start; vertical-align: top; }
.fr-reading-table th + th, .fr-reading-table td + td { border-inline-start: 1px solid var(--fr-answer-border); }
.fr-reading-table tbody tr:last-child td { border-bottom: 0; }
.fr-reading-table th { font-weight: 600; background: var(--fr-answer-soft); }
.is-compact { font-size: 13px; line-height: 1.7; }
.is-compact h3, .is-compact h4 { margin-top: 14px; font-size: 13px; }
.is-compact p, .is-compact ul, .is-compact ol { margin-bottom: 9px; }
.fr-dark-theme .fr-reading-markdown { --fr-answer-quote: #c6cedd; --fr-answer-border: #2f3542; --fr-answer-soft: #232833; --fr-answer-code: #2b313e; --fr-answer-accent: #f46590; }
</style>
