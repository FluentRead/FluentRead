<!--
 @file src/features/document-translation/ui/PdfAnnotations.vue
 文件职责：提供 PDF 选区批注、高亮/下划线管理、原文件批注副本下载与显式 Hypothesis 入口。
 主要内容：只采集本阅读器原页文字层或单个重排段落，保存归一化原页矩形与选区摘录；阅读工具栏和划词卡片共用已审核的 Range，快捷批注不带入旧备注；可在阅读工具栏附加当前段译文或备注；下载期间捕获文件及批注快照，切换文件和卸载后拒绝迟到下载并释放 URL。
 模块边界：持久化由文档任务的既有历史流程拥有，本组件只发出批注变更；不注入远程脚本、不上传本地文件、不占用划词卡片的事件或层级。
-->
<template>
  <div class="pdf-menu pdf-annotations" :class="{open}" data-fluentread-pdf-decoration>
    <button class="pdf-menu-button" type="button" aria-haspopup="dialog" :aria-expanded="open" :aria-label="t('document.pdfReading.annotations')" :title="t('document.pdfReading.annotations')" @pointerdown.prevent @click="$emit('toggle')"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="m5 12 7-8 4 4-7 7H5v-3ZM3 17h14M10 6l4 4" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg><small v-if="annotations.length">{{ annotations.length }}</small></button>
    <div v-if="open" class="pdf-menu-panel" role="dialog" :aria-label="t('document.pdfReading.annotations')">
      <p class="pdf-annotation-hint">{{ t(candidate?.sourceId ? 'document.pdfReading.annotationReflowHint' : 'document.pdfReading.annotationSelectionHint') }}</p>
      <blockquote v-if="candidate" dir="auto" data-i18n-ignore>{{ candidate.quote }}</blockquote>
      <div class="pdf-annotation-colors" role="group" :aria-label="t('document.pdfReading.annotationColor')"><button v-for="(hex, key) in PDF_ANNOTATION_COLORS" :key="key" type="button" :aria-label="t(`document.pdfReading.annotationColor.${key}`)" :aria-pressed="color === key" :style="{background: hex}" @pointerdown.prevent @click="color = key" /></div>
      <label v-if="candidate?.translation" class="pdf-annotation-translation"><input v-model="includeTranslation" type="checkbox" />{{ t('document.pdfReading.annotationIncludeTranslation') }}</label>
      <textarea v-model="note" rows="2" maxlength="4000" :aria-label="t('document.pdfReading.annotationNote')" :placeholder="t('document.pdfReading.annotationNote')" />
      <div class="pdf-annotation-actions"><button type="button" :disabled="!candidate || annotations.length >= PDF_ANNOTATION_LIMIT" @pointerdown.prevent @click="add('highlight')">{{ t('document.pdfReading.annotationHighlight') }}</button><button type="button" :disabled="!candidate || annotations.length >= PDF_ANNOTATION_LIMIT" @pointerdown.prevent @click="add('underline')">{{ t('document.pdfReading.annotationUnderline') }}</button></div>
      <p v-if="annotations.length >= PDF_ANNOTATION_LIMIT" role="status">{{ t('document.pdfReading.annotationLimit') }}</p>
      <ol v-if="annotations.length" class="pdf-annotation-list"><li v-for="annotation in annotations" :key="annotation.id"><button type="button" class="pdf-annotation-location" :title="annotation.note || annotation.quote" @click="$emit('jump', annotation.page)"><small>{{ annotation.page }} · {{ t(`document.pdfReading.annotation${annotation.kind === 'highlight' ? 'Highlight' : 'Underline'}`) }}</small><span dir="auto" data-i18n-ignore>{{ annotation.quote }}</span></button><button type="button" :aria-label="t('document.pdfReading.annotationDelete')" @click="$emit('update:annotations', annotations.filter(item => item.id !== annotation.id))">×</button></li></ol>
      <button class="pdf-annotation-download" type="button" :disabled="!annotations.length || downloading" @click="download">{{ t(downloading ? 'document.pdfReading.annotationSaving' : 'document.pdfReading.annotationDownload') }}</button>
      <p v-if="message" role="status">{{ t(message) }}</p>
      <p v-if="annotations.length" class="pdf-annotation-hint">{{ t(saved ? 'document.pdfReading.annotationSaved' : 'document.pdfReading.annotationUnsaved') }}</p>
      <details class="pdf-hypothesis"><summary>Hypothesis ↗</summary><p>{{ t(hypothesisUrl ? 'document.pdfReading.hypothesisNotice' : 'document.pdfReading.hypothesisLocal') }}</p><a v-if="hypothesisUrl" :href="hypothesisUrl" target="_blank" rel="noopener noreferrer">{{ t('document.pdfReading.hypothesisOpen') }}</a><a v-else href="https://web.hypothes.is/help/annotating-locally-saved-pdfs/" target="_blank" rel="noopener noreferrer">{{ t('document.pdfReading.hypothesisHelp') }}</a></details>
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import type {ParsedDocument} from '../core/document';
import {normalizePdfAnnotations, pdfHypothesisUrl, PDF_ANNOTATION_COLORS, PDF_ANNOTATION_LIMIT, type PdfAnnotation} from '../core/pdfAnnotations';
import {pdfReaderDisplayRect} from './pdfReader';

const props = defineProps<{document: ParsedDocument; root?: HTMLElement; annotations: readonly PdfAnnotation[]; translations: readonly string[]; sourceUrl: string; open: boolean; saved: boolean}>();
const emit = defineEmits<{'update:annotations': [annotations: PdfAnnotation[]]; toggle: []; jump: [page: number]}>();
const {t} = useUiI18n();
const color = ref<keyof typeof PDF_ANNOTATION_COLORS>('yellow'), note = ref(''), includeTranslation = ref(false);
type Candidate = Pick<PdfAnnotation, 'page' | 'quote' | 'rects' | 'sourceId'> & {translation?: string};
const candidate = shallowRef<Candidate>();
const downloading = ref(false), message = ref('');
const hypothesisUrl = computed(() => pdfHypothesisUrl(props.sourceUrl));
let disposed = false, generation = 0;
const urls = new Map<string, ReturnType<typeof setTimeout>>();

function captureSelection(): void {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) {
    // 用户正在工具栏输入备注时保留已经捕获的选区；正文内重新点击则清空。
    if (!props.open) candidate.value = undefined;
    return;
  }
  captureRange(selection.getRangeAt(0));
}
function captureRange(range: Range): void {
  if (range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
  const element = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  if (!start || !end || !props.root?.contains(start) || !props.root.contains(end)) return;
  candidate.value = undefined;
  const binary = props.document.binary;
  if (binary?.kind !== 'pdf') return;
  const paragraph = start.closest<HTMLElement>('.pdf-reading-paragraph');
  if (paragraph && paragraph === end.closest('.pdf-reading-paragraph')) {
    const page = binary.pages.find(item => item.pageNumber === Number(paragraph.closest('[data-pdf-reading-page]')?.getAttribute('data-pdf-reading-page')));
    const sourceId = paragraph.getAttribute('data-pdf-source-id');
    const block = page?.blocks.find((item, index) => `pdf-${page.pageNumber}-${item.segmentIndex >= 0 ? `segment-${item.segmentIndex}` : `block-${index}`}` === sourceId);
    if (!page || !block || !sourceId) return;
    const rect = pdfReaderDisplayRect(block, page);
    candidate.value = {page: page.pageNumber, quote: range.toString().trim().slice(0, 4000), sourceId, translation: props.translations[block.segmentIndex],
      rects: [{x: rect.x / page.width, y: rect.y / page.height, width: rect.width / page.width, height: rect.height / page.height}]};
    return;
  }
  const layer = start.closest('[data-fluentread-pdf-text]');
  if (!layer || layer !== end.closest('[data-fluentread-pdf-text]')) return;
  const page = binary.pages.find(item => item.pageNumber === Number(layer.getAttribute('data-pdf-page-number')));
  const frame = layer.closest('.pdf-page-frame')?.getBoundingClientRect();
  if (!page || !frame?.width || !frame.height) return;
  const clientRects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  if (clientRects.length > 128) return;
  const rects = clientRects.map(rect => ({
    x: (rect.left - frame.left) / frame.width, y: (rect.top - frame.top) / frame.height, width: rect.width / frame.width, height: rect.height / frame.height,
  }));
  const first = rects[0];
  const block = first && page.blocks.find(block => {const rect = pdfReaderDisplayRect(block, page); return first.x * page.width < rect.x + rect.width && (first.x + first.width) * page.width > rect.x && first.y * page.height < rect.y + rect.height && (first.y + first.height) * page.height > rect.y;});
  const value = normalizePdfAnnotations([{id: 'selection', page: page.pageNumber, quote: range.toString(), note: '', color: color.value, kind: 'highlight', rects}], binary.pages.length)[0];
  if (value) candidate.value = {...value, translation: block ? props.translations[block.segmentIndex] : undefined};
}
function add(kind: PdfAnnotation['kind']): boolean {
  if (!candidate.value || props.annotations.length >= PDF_ANNOTATION_LIMIT) return false;
  const {translation, ...selection} = candidate.value;
  const value = normalizePdfAnnotations([{...selection, id: globalThis.crypto.randomUUID(), kind, color: color.value,
    note: [note.value.trim(), includeTranslation.value ? translation : ''].filter(Boolean).join('\n\n')}], props.document.binary?.kind === 'pdf' ? props.document.binary.pages.length : 0)[0];
  if (!value) return false;
  emit('update:annotations', [...props.annotations, value]);
  candidate.value = undefined; note.value = ''; includeTranslation.value = false; message.value = '';
  return true;
}
function markSelection(range: Range, kind: PdfAnnotation['kind']): boolean {
  candidate.value = undefined; note.value = ''; includeTranslation.value = false;
  captureRange(range);
  return add(kind);
}
defineExpose({markSelection});
function clearUrls(): void {for (const [url, timer] of urls) {clearTimeout(timer); URL.revokeObjectURL(url);} urls.clear();}
async function download(): Promise<void> {
  const binary = props.document.binary;
  if (downloading.value || !props.annotations.length || binary?.kind !== 'pdf') return;
  const request = ++generation, document = props.document, annotations = [...props.annotations];
  downloading.value = true; message.value = '';
  try {
    const {exportPdfAnnotations} = await import('../services/pdfAnnotationExport');
    const output = await exportPdfAnnotations(binary.bytes, annotations);
    if (disposed || request !== generation || document.binary !== props.document.binary) return;
    const url = URL.createObjectURL(new Blob([asArrayBufferBytes(output)], {type: 'application/pdf'}));
    const timer = setTimeout(() => {urls.delete(url); URL.revokeObjectURL(url);}, 1000); urls.set(url, timer);
    const anchor = globalThis.document.createElement('a'); anchor.href = url; anchor.download = document.fileName.replace(/\.pdf$/iu, '') + '.annotated.pdf'; anchor.click();
    message.value = 'document.pdfReading.annotationDownloaded';
  } catch {
    if (!disposed && request === generation) {clearUrls(); message.value = 'document.pdfReading.annotationExportFailed';}
  } finally {if (request === generation) downloading.value = false;}
}
watch(() => props.document.binary?.bytes, () => {generation += 1; clearUrls(); downloading.value = false; candidate.value = undefined; note.value = ''; includeTranslation.value = false; message.value = '';});
function onPointerDown(event: Event): void {if (props.root?.contains(event.target as Node)) {candidate.value = undefined; message.value = '';}}
onMounted(() => {globalThis.document.addEventListener('selectionchange', captureSelection); globalThis.document.addEventListener('pointerup', captureSelection); globalThis.document.addEventListener('pointerdown', onPointerDown, true);});
onBeforeUnmount(() => {disposed = true; generation += 1; clearUrls(); globalThis.document.removeEventListener('selectionchange', captureSelection); globalThis.document.removeEventListener('pointerup', captureSelection); globalThis.document.removeEventListener('pointerdown', onPointerDown, true);});
</script>

<style scoped>
.pdf-annotations {position: relative; flex: none;}
.pdf-menu-button {display: inline-flex; align-items: center; justify-content: center; gap: 3px; height: 30px; min-width: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer;}
.pdf-menu-button:hover, .open > .pdf-menu-button {color: var(--brand-strong); background: var(--brand-soft);}
.pdf-menu-panel {position: absolute; top: calc(100% + 8px); left: 0; z-index: 12; width: min(320px, calc(100vw - 32px)); box-sizing: border-box; max-height: min(600px, 75dvh); overflow: auto; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink); background: var(--surface); box-shadow: 0 12px 36px #10182824; font: 12px/1.5 system-ui, sans-serif;}
.pdf-menu-panel p {margin: 8px 0;}
.pdf-annotation-hint {color: var(--muted);}
blockquote {margin: 8px 0; padding: 6px 10px; border-inline-start: 2px solid var(--brand); max-height: 70px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;}
textarea {width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px; max-height: 160px; padding: 6px 8px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; font: inherit;}
.pdf-menu-panel button {height: auto; width: auto; font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 5px 8px;}
.pdf-menu-panel button:disabled {opacity: .5; cursor: default;}
.pdf-annotation-colors, .pdf-annotation-actions {display: flex; gap: 8px; margin: 8px 0;}
.pdf-annotation-colors button {width: 23px; height: 23px; border: 2px solid transparent; border-radius: 50%; padding: 0;}
.pdf-annotation-colors button[aria-pressed="true"] {outline: 2px solid var(--ink); outline-offset: 1px;}
.pdf-annotation-translation {display: flex; gap: 6px; align-items: center; margin: 8px 0;}
.pdf-annotation-list {list-style: none; padding: 0; margin: 10px 0; max-height: 180px; overflow: auto;}
.pdf-annotation-list li {display: flex; gap: 4px; align-items: center; border-top: 1px solid var(--line); padding: 5px 0;}
.pdf-annotation-list .pdf-annotation-location {flex: 1; min-width: 0; text-align: start; border: 0; padding: 3px 0;}
.pdf-annotation-location small {display: block; color: var(--muted);}
.pdf-annotation-location span {display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 240px;}
.pdf-menu-panel .pdf-annotation-download {width: 100%; background: var(--brand); border-color: var(--brand); color: #fff;}
.pdf-hypothesis {border-top: 1px solid var(--line); margin-top: 10px; padding-top: 8px;}
.pdf-hypothesis summary {cursor: pointer;}
.pdf-hypothesis a {color: var(--brand-strong);}
button:focus-visible, textarea:focus-visible, a:focus-visible, summary:focus-visible {outline: 2px solid var(--brand); outline-offset: 2px;}
</style>
