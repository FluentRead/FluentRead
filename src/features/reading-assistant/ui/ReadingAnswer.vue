<!--
 * @file src/features/reading-assistant/ui/ReadingAnswer.vue
 * 文件职责：统一呈现阅读回答、流式生成内容和已保存问答，提供清晰而紧凑的阅读层次。
 * 主要内容：把安全 Markdown 结构渲染为标题、列表、引用、代码和表格，使用产品颜色变量兼容选区 Shadow UI 与设置页面。
 * 模块边界：仅接收文本与紧凑模式，不请求模型、不读取存储，不插入 HTML、不创建可点击外链或远程图片。
 -->
<template>
  <div class="fr-reading-markdown" :class="{'is-compact': compact}" data-reading-answer data-i18n-ignore>
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="block.level <= 2 ? 'h3' : 'h4'" v-if="block.kind === 'heading'"><AnswerInline :text="block.text" /></component>
      <p v-else-if="block.kind === 'paragraph'"><AnswerInline :text="block.text" /></p>
      <blockquote v-else-if="block.kind === 'quote'"><AnswerInline :text="block.text" /></blockquote>
      <pre v-else-if="block.kind === 'code'"><code>{{ block.text }}</code></pre>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.ordered ? block.start : undefined">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><AnswerInline :text="item" /></li>
      </component>
      <div v-else-if="block.kind === 'table'" class="fr-reading-table"><table><thead><tr><th v-for="(cell, column) in block.headers" :key="column" scope="col"><AnswerInline :text="cell" /></th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, column) in row" :key="column"><AnswerInline :text="cell" /></td></tr></tbody></table></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import {computed, h} from 'vue';
import {readingAnswerBlocks, readingAnswerSpans} from '../answerFormat';
const props = withDefaults(defineProps<{text: string; compact?: boolean}>(), {compact: true});
const blocks = computed(() => readingAnswerBlocks(props.text));
const inlineTags = {text: 'span', strong: 'strong', emphasis: 'em', code: 'code'} as const;
const AnswerInline = ({text}: {text: string}) => readingAnswerSpans(text).map(span => h(inlineTags[span.kind], span.text));
</script>
<style scoped>
.fr-reading-markdown { --fr-answer-border: var(--el-border-color-lighter, #e9e9ef); --fr-answer-soft: var(--el-fill-color-lighter, #f8f8fa); --fr-answer-code: var(--el-fill-color-light, #f3f3f6); color: inherit; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.fr-reading-markdown > :first-child { margin-top: 0; }
.fr-reading-markdown > :last-child { margin-bottom: 0; }
.fr-reading-markdown h3, .fr-reading-markdown h4 { margin: 22px 0 8px; color: inherit; font-size: 14px; font-weight: 700; line-height: 1.45; }
.fr-reading-markdown h3 { font-size: 15px; }
.fr-reading-markdown h3:not(:first-child), .fr-reading-markdown h4:not(:first-child) { padding-top: 12px; border-top: 1px solid var(--fr-answer-border); }
.fr-reading-markdown p { margin: 0 0 12px; white-space: pre-line; }
.fr-reading-markdown ul, .fr-reading-markdown ol { margin: 6px 0 14px; padding-inline-start: 1.5em; }
.fr-reading-markdown li { padding-inline-start: 2px; margin: 5px 0; white-space: pre-line; }
.fr-reading-markdown li::marker { color: var(--el-color-primary, #ec4899); }
.fr-reading-markdown blockquote { margin: 12px 0; padding: 7px 12px; border-inline-start: 3px solid var(--el-color-primary-light-5, #f6a5c4); color: var(--el-text-color-regular, inherit); background: var(--fr-answer-soft); border-radius: 0 5px 5px 0; white-space: pre-line; }
.fr-reading-markdown :deep(strong) { color: inherit; font-weight: 650; }
.fr-reading-markdown :deep(code) { padding: 2px 5px; border-radius: 4px; background: var(--fr-answer-code); color: inherit; font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
.fr-reading-markdown pre { margin: 12px 0; padding: 12px; max-width: 100%; overflow: auto; border: 1px solid var(--fr-answer-border); border-radius: 7px; background: var(--fr-answer-soft); line-height: 1.65; }
.fr-reading-markdown pre code { display: block; padding: 0; background: transparent; white-space: pre; }
.fr-reading-table { max-width: 100%; margin: 12px 0; overflow-x: auto; }
.fr-reading-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.fr-reading-table th, .fr-reading-table td { padding: 7px 9px; border: 1px solid var(--fr-answer-border); text-align: start; vertical-align: top; }
.fr-reading-table th { font-weight: 650; background: var(--fr-answer-soft); }
.is-compact { font-size: 13px; line-height: 1.75; }
.is-compact h3, .is-compact h4 { margin-top: 18px; font-size: 13px; }
.is-compact p, .is-compact ul, .is-compact ol { margin-bottom: 10px; }
:global(.fr-dark-theme) .fr-reading-markdown { --fr-answer-border: #514651; --fr-answer-soft: #352f38; --fr-answer-code: #413846; }
</style>
