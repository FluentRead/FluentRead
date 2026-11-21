<!--
 @file src/features/document-translation/ui/PdfAnnotations.vue
 文件职责：在 PDF 阅读工具栏展示已有批注，按选区显示编辑控件，并导出带批注的原 PDF。
 主要内容：采集原页文字层或单个重排段落的选区。备注编辑器保留自己的原文摘录，允许显式保存或取消，也可回看和修改已有备注。导出绑定当前文件与批注快照。
 模块边界：文档任务保存批注，阅读器负责定位与官方侧栏。本组件负责本地批注面板和导出。
-->
<template>
  <div class="pdf-menu pdf-annotations" :class="{open}" data-fluentread-pdf-decoration>
    <button ref="trigger" class="pdf-menu-button" type="button" aria-haspopup="dialog" :aria-expanded="open" :aria-label="t('document.pdfReading.annotations')" @pointerdown.prevent @click="$emit('toggle')">
      {{ t('document.pdfReading.annotations') }}<small v-if="annotations.length">{{ annotations.length }}</small>
    </button>
    <div v-if="open" class="pdf-menu-panel" role="dialog" :aria-label="t('document.pdfReading.annotations')">
      <div v-if="canCreateAnnotation || noteEditor" class="pdf-annotation-composer">
        <blockquote dir="auto" data-i18n-ignore>{{ editedAnnotation?.quote ?? candidate?.quote }}</blockquote>
        <p v-if="noteEditor?.type !== 'edit' && candidate?.sourceId" class="pdf-annotation-hint">{{ t('document.pdfReading.annotationReflowHint') }}</p>
        <div v-if="noteEditor?.type !== 'edit'" class="pdf-annotation-actions">
          <div class="pdf-annotation-colors" role="group" :aria-label="t('document.pdfReading.annotationColor')">
            <button v-for="(hex, key) in PDF_ANNOTATION_COLORS" :key="key" type="button" :aria-label="t(`document.pdfReading.annotationColor.${key}`)"
              :aria-pressed="color === key" :style="{background: hex}" @pointerdown.prevent @click="color = key" />
          </div>
          <button type="button" :aria-pressed="noteEditor?.type === 'new' ? noteEditor.kind === 'highlight' : undefined"
            @pointerdown.prevent @click="add('highlight')">{{ t('document.pdfReading.annotationHighlight') }}</button>
          <button type="button" :aria-pressed="noteEditor?.type === 'new' ? noteEditor.kind === 'underline' : undefined"
            @pointerdown.prevent @click="add('underline')">{{ t('document.pdfReading.annotationUnderline') }}</button>
          <button v-if="!noteEditor" type="button" class="pdf-annotation-note-toggle" @click="startNote()">{{ t('document.pdfReading.annotationAddNote') }}</button>
        </div>
        <form v-if="noteEditor" class="pdf-annotation-note" @submit.prevent="saveNote">
          <textarea ref="noteInput" v-model="note" :rows="noteEditor.type === 'edit' ? 5 : 3" maxlength="4000"
            :aria-label="t('document.pdfReading.annotationNote')" :placeholder="t('document.pdfReading.annotationNote')" />
          <label v-if="noteEditor.type === 'new' && selectionTranslation" class="pdf-annotation-translation">
            <input v-model="includeTranslation" type="checkbox" />{{ t('document.pdfReading.annotationIncludeTranslation') }}
          </label>
          <p v-if="noteEditor.type === 'new' && !canCreateAnnotation" class="pdf-annotation-hint" role="status">{{ t('document.pdfReading.annotationLimit') }}</p>
          <div class="pdf-annotation-note-actions">
            <button type="button" @click="cancelNote">{{ t('common.cancel') }}</button>
            <button type="submit" class="pdf-annotation-save" :disabled="noteEditor.type === 'new' && !canCreateAnnotation">
              {{ t('document.pdfReading.annotationSave') }}
            </button>
          </div>
        </form>
      </div>
      <p v-else-if="candidate" class="pdf-annotation-hint" role="status">{{ t('document.pdfReading.annotationLimit') }}</p>
      <ol v-if="annotations.length && !noteEditor" class="pdf-annotation-list">
        <li v-for="annotation in annotations" :key="annotation.id">
          <div class="pdf-annotation-row">
            <button type="button" class="pdf-annotation-location" :title="annotation.note || annotation.quote"
              :style="{'--annotation-color': PDF_ANNOTATION_COLORS[annotation.color]}" @click="$emit('jump', annotation)">
              <span class="pdf-annotation-primary" dir="auto" data-i18n-ignore>{{ annotation.note || annotation.quote }}</span>
              <span v-if="annotation.note" class="pdf-annotation-excerpt" dir="auto" data-i18n-ignore>{{ annotation.quote }}</span>
              <small>{{ t('document.pdfReading.pageNumber', {page: annotation.page}) }} · {{ t(`document.pdfReading.annotation${annotation.kind === 'highlight' ? 'Highlight' : 'Underline'}`) }}</small>
            </button>
            <button type="button" class="pdf-annotation-more" :aria-label="t('document.pdfReading.annotationActions')"
              :title="t('document.pdfReading.annotationActions')" :aria-expanded="rowActions === annotation.id"
              @click="rowActions = rowActions === annotation.id ? undefined : annotation.id">⋯</button>
          </div>
          <div v-if="rowActions === annotation.id" class="pdf-annotation-row-actions">
            <button type="button" @click="startNote(annotation)">{{ t('document.pdfReading.annotationEditNote') }}</button>
            <button type="button" class="pdf-annotation-delete" @click="removeAnnotation(annotation.id)">{{ t('document.pdfReading.annotationDelete') }}</button>
          </div>
        </li>
      </ol>
      <p v-else-if="!candidate && !noteEditor" class="pdf-annotation-hint">{{ t('document.pdfReading.annotationEmpty') }}</p>
      <div v-if="!noteEditor && (annotations.length || $slots.collaboration)" class="pdf-annotation-footer">
        <button v-if="annotations.length" class="pdf-annotation-download" type="button" :disabled="downloading"
          :aria-label="t('document.pdfReading.annotationDownload')" :title="t('document.pdfReading.annotationDownload')" @click="download">
          {{ t(downloading ? 'document.pdfReading.annotationSaving' : 'document.pdfReading.annotationExport') }}
        </button>
        <slot name="collaboration" />
      </div>
      <span class="pdf-annotation-announcement" role="status">{{ downloaded ? t('document.pdfReading.annotationDownloaded') : '' }}</span>
      <p v-if="exportFailed && !noteEditor" class="pdf-annotation-error" role="alert">{{ t('document.pdfReading.annotationExportFailed') }}</p>
      <p v-if="annotations.length && storageUnavailable && !noteEditor" class="pdf-annotation-hint" role="status">{{ t('document.pdfReading.annotationUnsaved') }}</p>
      <slot v-if="!noteEditor" name="collaboration-feedback" />
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import type {ParsedDocument} from '../core/document';
import {normalizePdfAnnotations, PDF_ANNOTATION_COLORS, PDF_ANNOTATION_LIMIT, type PdfAnnotation} from '../core/pdfAnnotations';
import {pdfReaderDisplayRect} from './pdfReader';

const props = defineProps<{document: ParsedDocument; root?: HTMLElement; annotations: readonly PdfAnnotation[]; translations: readonly string[]; open: boolean; storageUnavailable: boolean}>();
const emit = defineEmits<{'update:annotations': [annotations: PdfAnnotation[]]; toggle: []; jump: [annotation: PdfAnnotation]}>();
const {t} = useUiI18n();
const color = ref<keyof typeof PDF_ANNOTATION_COLORS>('yellow'), note = ref(''), includeTranslation = ref(false);
type Candidate = Pick<PdfAnnotation, 'page' | 'quote' | 'rects' | 'sourceId'> & {segmentIndex?: number};
type NoteEditor = {type: 'new'; kind: PdfAnnotation['kind']} | {type: 'edit'; id: string};
const candidate = shallowRef<Candidate>();
const canCreateAnnotation = computed(() => Boolean(candidate.value) && props.annotations.length < PDF_ANNOTATION_LIMIT);
const trigger = ref<HTMLButtonElement | null>(null);
const noteEditor = ref<NoteEditor>(), noteInput = ref<HTMLTextAreaElement | null>(null);
const rowActions = ref<string>();
const editedAnnotation = computed(() => {
  const editor = noteEditor.value;
  return editor?.type === 'edit' ? props.annotations.find(item => item.id === editor.id) : undefined;
});
const selectionSegment = computed(() => candidate.value ? annotationSegment(candidate.value) : undefined);
const selectionTranslation = computed(() => {
  const index = selectionSegment.value;
  return index === undefined ? '' : props.translations[index]?.trim() ?? '';
});
const downloading = ref(false), downloaded = ref(false), exportFailed = ref(false);
type SelectionBounds = Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>;
let selectionBounds: SelectionBounds | undefined;
let disposed = false, generation = 0;
const urls = new Map<string, ReturnType<typeof setTimeout>>();

function clearComposer(): void {
  candidate.value = undefined;
  noteEditor.value = undefined;
  note.value = '';
  includeTranslation.value = false;
}

function resetSelection(): void {
  selectionBounds = undefined;
  clearComposer();
}

function startNote(annotation?: PdfAnnotation): void {
  if (annotation) {
    clearComposer();
    rowActions.value = undefined;
    note.value = annotation.note;
    noteEditor.value = {type: 'edit', id: annotation.id};
  } else if (canCreateAnnotation.value) {
    noteEditor.value = {type: 'new', kind: 'highlight'};
  }
}

function cancelNote(): void {
  resetSelection();
  captureSelection();
  trigger.value?.focus({preventScroll: true});
}

function captureSelection(): void {
  // 草稿始终绑定开始编辑时的句子或批注。继续阅读和临时收起面板都可回来继续写。
  if (noteEditor.value) return;
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) {
    if (!props.open) resetSelection();
    return;
  }
  const range = selection.getRangeAt(0);
  const {startContainer, startOffset, endContainer, endOffset} = range;
  if (props.open && !props.root?.contains(startContainer) && !props.root?.contains(endContainer)) return;
  if (selectionBounds?.startContainer === startContainer && selectionBounds.startOffset === startOffset
    && selectionBounds.endContainer === endContainer && selectionBounds.endOffset === endOffset) return;
  resetSelection();
  const captured = captureRange(range);
  if (!captured) return;
  candidate.value = captured;
  selectionBounds = {startContainer, startOffset, endContainer, endOffset};
}
function captureRange(range: Range): Candidate | undefined {
  if (range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
  const element = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  if (!start || !end || !props.root?.contains(start) || !props.root.contains(end)) return;
  const binary = props.document.binary;
  if (binary?.kind !== 'pdf') return;
  const paragraph = start.closest<HTMLElement>('.pdf-reading-paragraph');
  if (paragraph && paragraph === end.closest('.pdf-reading-paragraph')) {
    const page = binary.pages.find(item => item.pageNumber === Number(paragraph.closest('[data-pdf-reading-page]')?.getAttribute('data-pdf-reading-page')));
    const sourceId = paragraph.getAttribute('data-pdf-source-id');
    const block = page?.blocks.find((item, index) => `pdf-${page.pageNumber}-${item.segmentIndex >= 0 ? `segment-${item.segmentIndex}` : `block-${index}`}` === sourceId);
    const quote = range.toString().trim().slice(0, 4000);
    if (!page || !block || !sourceId || !quote) return;
    const rect = pdfReaderDisplayRect(block, page);
    return {page: page.pageNumber, quote, sourceId, segmentIndex: block.segmentIndex,
      rects: [{x: rect.x / page.width, y: rect.y / page.height, width: rect.width / page.width, height: rect.height / page.height}]};
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
  return normalizePdfAnnotations([{id: 'selection', page: page.pageNumber, quote: range.toString(), note: '', color: color.value, kind: 'highlight', rects}], binary.pages.length)[0];
}
/** 每个选区矩形都属于同一段才附加译文，避免跨段时误用第一段。 */
function annotationSegment(selection: Candidate): number | undefined {
  if (selection.segmentIndex !== undefined) return selection.segmentIndex;
  const binary = props.document.binary;
  const page = binary?.kind === 'pdf' ? binary.pages.find(item => item.pageNumber === selection.page) : undefined;
  if (!page) return;
  const blocks = page.blocks.map(block => ({segmentIndex: block.segmentIndex, ...pdfReaderDisplayRect(block, page)}));
  const matches = selection.rects.map(mark => new Set(blocks.filter(block => (
    mark.x * page.width < block.x + block.width && (mark.x + mark.width) * page.width > block.x
    && mark.y * page.height < block.y + block.height && (mark.y + mark.height) * page.height > block.y
  )).map(block => block.segmentIndex)));
  const [index] = matches[0];
  return index >= 0 && matches.every(match => match.size === 1 && match.has(index)) ? index : undefined;
}
function saveAnnotation(captured: Candidate | undefined, kind: PdfAnnotation['kind'], text = ''): boolean {
  if (!captured || props.annotations.length >= PDF_ANNOTATION_LIMIT) return false;
  const {page, quote, rects, sourceId} = captured;
  const value = normalizePdfAnnotations([{page, quote, rects, sourceId, id: globalThis.crypto.randomUUID(), kind, color: color.value,
    note: text}], props.document.binary?.kind === 'pdf' ? props.document.binary.pages.length : 0)[0];
  if (!value) return false;
  emit('update:annotations', [...props.annotations, value]);
  return true;
}
function add(kind: PdfAnnotation['kind']): void {
  if (noteEditor.value?.type === 'new') {
    noteEditor.value.kind = kind;
    return;
  }
  if (saveAnnotation(candidate.value, kind)) finishNote();
}
function finishNote(): void {
  // 保留选区边界，避免保存后相同选区立即重新打开草稿。
  trigger.value?.focus({preventScroll: true});
  clearComposer();
}
function saveNote(): void {
  const editor = noteEditor.value;
  if (!editor) return;
  const text = note.value.trim();
  if (editor.type === 'edit') {
    const existing = editedAnnotation.value;
    if (existing && existing.note !== text) emit('update:annotations', props.annotations.map(item => item.id === existing.id ? {...item, note: text} : item));
    finishNote();
    return;
  }
  const complete = [text, includeTranslation.value ? selectionTranslation.value : ''].filter(Boolean).join('\n\n');
  if (saveAnnotation(candidate.value, editor.kind, complete)) finishNote();
}
function removeAnnotation(id: string): void {
  rowActions.value = undefined;
  trigger.value?.focus({preventScroll: true});
  emit('update:annotations', props.annotations.filter(item => item.id !== id));
}
function markSelection(range: Range, kind: PdfAnnotation['kind']): boolean {
  const added = saveAnnotation(captureRange(range), kind);
  if (added && !noteEditor.value) {
    clearComposer();
    const {startContainer, startOffset, endContainer, endOffset} = range;
    selectionBounds = {startContainer, startOffset, endContainer, endOffset};
  }
  return added;
}
defineExpose({markSelection});
function clearUrls(): void {for (const [url, timer] of urls) {clearTimeout(timer); URL.revokeObjectURL(url);} urls.clear();}
async function download(): Promise<void> {
  const binary = props.document.binary;
  if (downloading.value || !props.annotations.length || binary?.kind !== 'pdf') return;
  const request = ++generation, document = props.document, annotations = [...props.annotations];
  downloading.value = true; downloaded.value = false; exportFailed.value = false;
  try {
    const {exportPdfAnnotations} = await import('../services/pdfAnnotationExport');
    const output = await exportPdfAnnotations(binary.bytes, annotations);
    if (disposed || request !== generation || document.binary !== props.document.binary) return;
    const url = URL.createObjectURL(new Blob([asArrayBufferBytes(output)], {type: 'application/pdf'}));
    const timer = setTimeout(() => {urls.delete(url); URL.revokeObjectURL(url);}, 1000); urls.set(url, timer);
    const anchor = globalThis.document.createElement('a'); anchor.href = url; anchor.download = document.fileName.replace(/\.pdf$/iu, '') + '.annotated.pdf'; anchor.click();
    downloaded.value = true;
  } catch {
    if (!disposed && request === generation) {clearUrls(); exportFailed.value = true;}
  } finally {if (request === generation) downloading.value = false;}
}
watch(() => props.document.binary?.bytes, () => {
  generation += 1; clearUrls(); downloading.value = false; downloaded.value = false; exportFailed.value = false;
  rowActions.value = undefined;
  resetSelection();
});
watch(noteInput, input => input?.focus({preventScroll: true}), {flush: 'post'});
watch(() => props.open, open => {if (!open) rowActions.value = undefined;});
watch(editedAnnotation, annotation => {
  if (!annotation && noteEditor.value?.type === 'edit') clearComposer();
});
function onPointerDown(event: Event): void {if (!noteEditor.value && props.root?.contains(event.target as Node)) resetSelection();}
onMounted(() => {globalThis.document.addEventListener('selectionchange', captureSelection); globalThis.document.addEventListener('pointerup', captureSelection); globalThis.document.addEventListener('pointerdown', onPointerDown, true);});
onBeforeUnmount(() => {disposed = true; generation += 1; clearUrls(); globalThis.document.removeEventListener('selectionchange', captureSelection); globalThis.document.removeEventListener('pointerup', captureSelection); globalThis.document.removeEventListener('pointerdown', onPointerDown, true);});
</script>

<style scoped>
.pdf-menu.pdf-annotations {position: static; flex: none; justify-self: start;}
.pdf-annotations > .pdf-menu-button {display: inline-flex; align-items: center; justify-content: center; gap: 5px; width: auto; height: 30px; padding: 0 7px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; white-space: nowrap; cursor: pointer;}
.pdf-menu-button:hover, .open > .pdf-menu-button {color: var(--brand-strong); background: var(--brand-soft);}
.pdf-menu-panel {position: absolute; top: calc(100% + 8px); inset-inline-end: 0; z-index: 12; width: min(320px, 100%); box-sizing: border-box; max-height: min(600px, 60dvh); overflow: auto; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink); background: var(--surface); box-shadow: 0 12px 36px #10182824; font: 12px/1.5 system-ui, sans-serif;}
.pdf-annotation-hint, .pdf-annotation-error {margin: 6px 0; color: var(--muted);}
.pdf-annotation-error {color: var(--brand-strong);}
blockquote {margin: 0 0 6px; padding: 4px 8px; border-inline-start: 2px solid var(--brand); max-height: 56px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;}
textarea {display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 48px; max-height: 160px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); font: inherit;}
.pdf-menu-panel button {inline-size: auto; block-size: auto; min-block-size: 28px; padding: 3px 7px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer;}
.pdf-menu-panel button:hover:not(:disabled) {background: var(--surface-soft);}
.pdf-menu-panel button:disabled {opacity: .55; cursor: default;}
.pdf-annotation-actions, .pdf-annotation-footer, .pdf-annotation-note-actions, .pdf-annotation-row-actions {display: flex; align-items: center; flex-wrap: wrap; gap: 4px;}
.pdf-annotation-actions > button[aria-pressed="true"], .pdf-annotation-more[aria-expanded="true"] {color: var(--brand-strong); background: var(--brand-soft);}
.pdf-annotation-colors {display: flex; align-items: center; gap: 6px; margin-inline-end: 4px;}
.pdf-annotation-colors button {inline-size: 18px; block-size: 18px; min-block-size: 18px; border: 1px solid var(--line); border-radius: 50%; padding: 0;}
.pdf-annotation-colors button[aria-pressed="true"] {outline: 2px solid var(--ink); outline-offset: 1px;}
.pdf-annotation-note {margin: 6px 0;}
.pdf-annotation-note-actions {justify-content: flex-end; margin-top: 6px;}
.pdf-menu-panel .pdf-annotation-save {background: var(--brand-soft); color: var(--brand-strong); font-weight: 600;}
.pdf-annotation-translation {display: flex; gap: 6px; align-items: center; margin-top: 4px;}
.pdf-annotation-list {list-style: none; padding: 0; margin: 0; max-height: 220px; overflow: auto;}
.pdf-annotation-composer + .pdf-annotation-list {margin-top: 8px; border-top: 1px solid var(--line);}
.pdf-annotation-list li {padding: 4px 0;}
.pdf-annotation-list li + li {border-top: 1px solid var(--line);}
.pdf-annotation-row {display: flex; align-items: flex-start; gap: 4px;}
.pdf-annotation-row-actions {justify-content: flex-end; margin-top: 4px;}
.pdf-annotation-list .pdf-annotation-location {flex: 1; min-width: 0; text-align: start; padding-inline-start: 8px; border-inline-start: 2px solid var(--annotation-color);}
.pdf-annotation-primary, .pdf-annotation-excerpt {display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: pre-line; overflow-wrap: anywhere;}
.pdf-annotation-primary {font-weight: 600;}
.pdf-annotation-excerpt, .pdf-annotation-location small {color: var(--muted);}
.pdf-annotation-excerpt {-webkit-line-clamp: 1;}
.pdf-annotation-location small {display: block;}
.pdf-menu-panel .pdf-annotation-more {min-inline-size: 28px; color: var(--muted); font-size: 16px;}
.pdf-menu-panel .pdf-annotation-delete {color: var(--brand-strong);}
.pdf-annotation-footer {justify-content: space-between; border-top: 1px solid var(--line); margin-top: 6px; padding-top: 4px;}
.pdf-menu-panel .pdf-annotation-download {color: var(--brand-strong);}
.pdf-annotation-announcement {position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;}
button:focus-visible, textarea:focus-visible {outline: 2px solid var(--brand); outline-offset: 2px;}
</style>
