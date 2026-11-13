<!--
 @file src/app/document-translation/PdfSourceEditor.vue
 文件职责：让用户对照扫描原图逐行校订当前页的识别文字，包含不送翻的图内标签和公式。
 主要内容：以页面块选择器切换核对位置，按实际 OCR 行显示独立输入；预览请求随位置变化或关闭取消，迟到结果不创建 URL，所有临时 URL 在替换和卸载时释放；保存和撤销只发出明确事件，父任务再次验证身份并提交。
 模块边界：不修改 props、不翻译或保存历史；原图裁剪与输入校验使用文档公共 API，文档状态与人工校订保留归 DocumentApp。
-->
<template>
  <dialog ref="dialog" class="pdf-source-editor" aria-labelledby="pdf-source-editor-title" @cancel.prevent="emit('close')">
    <header><h2 id="pdf-source-editor-title">{{ t('document.sourceEdit.title') }}</h2><button type="button" class="ghost-button" :aria-label="t('document.sourceEdit.close')" @click="emit('close')">×</button></header>
    <label class="pdf-source-block"><span>{{ t('document.sourceEdit.location', {page: pageNumber, block: selected + 1}) }}</span>
      <select :value="selected" :disabled="disabled || dirty" @change="selected = Number(($event.target as HTMLSelectElement).value)" :aria-label="t('document.sourceEdit.chooseBlock')"><option v-for="item in blocks" :key="item.index" :value="item.index" data-i18n-ignore>{{ item.index + 1 }} · {{ item.label }}</option></select>
    </label>
    <p v-if="dirty" class="pdf-source-hint" role="status">{{ t('document.sourceEdit.switchHint') }}</p>
    <p class="pdf-source-hint">{{ t('document.sourceEdit.hint') }}</p>
    <div class="pdf-source-columns">
      <section><h3>{{ t('document.sourceEdit.image') }}</h3><p v-if="loading" role="status">{{ t('document.sourceEdit.loading') }}</p><p v-else-if="previewError" role="alert">{{ t('document.sourceEdit.previewFailed') }} <button type="button" class="ghost-button" @click="loadPreview">{{ t('document.translationRecovery.retry') }}</button></p><div v-else class="pdf-source-image"><img v-if="previewUrl" :src="previewUrl" :alt="t('document.sourceEdit.image')" /></div></section>
      <section><h3>{{ t('document.sourceEdit.text') }}</h3><div class="pdf-source-lines"><label v-for="(_, index) in lines" :key="index"><span>{{ index + 1 }}</span><textarea ref="lineInputs" v-model="lines[index]" rows="1" dir="auto" data-i18n-ignore @input="resizeInputs" :maxlength="PDF_SOURCE_EDIT_MAX_CHARS" :disabled="disabled" :aria-label="t('document.sourceEdit.line', {line: index + 1})" /></label></div></section>
    </div>
    <p v-if="!valid" class="notice warning" role="status">{{ t('document.sourceEdit.invalid', {limit: PDF_SOURCE_EDIT_MAX_CHARS}) }}</p>
    <footer><button v-if="target?.block.sourceCorrection" type="button" class="ghost-button" :disabled="disabled" @click="emit('restore', selected)">{{ t('document.sourceEdit.restore') }}</button><span /><button type="button" class="ghost-button" @click="emit('close')">{{ t('document.sourceEdit.cancel') }}</button><button type="button" class="translate-document-button" :disabled="disabled || !valid" @click="emit('apply', selected, [...lines])">{{ t('document.sourceEdit.save') }}</button></footer>
  </dialog>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {createPdfSourcePreview, pdfSourceEditTarget, validPdfSourceEditLines, PDF_SOURCE_EDIT_MAX_CHARS, type ParsedDocument} from '@/src/features/document-translation/public';
import {useUiI18n} from '@/src/ui/i18n';
const {t} = useUiI18n();
const props = defineProps<{document: ParsedDocument; pageNumber: number; blockIndex: number; disabled: boolean}>();
const emit = defineEmits<{apply: [blockIndex: number, lines: string[]]; restore: [blockIndex: number]; close: []}>();
const dialog = ref<HTMLDialogElement>(), selected = ref(props.blockIndex), lines = ref<string[]>([]);
const lineInputs = ref<HTMLTextAreaElement[]>([]);
function resizeInputs(): void {for (const field of lineInputs.value) {if (!field.scrollHeight) continue; field.style.height = 'auto'; field.style.height = `${field.scrollHeight + 2}px`;}}
const previewUrl = ref(''), loading = ref(false), previewError = ref(false);
let controller: AbortController | undefined, disposed = false;
const blocks = computed(() => props.document.binary?.kind === 'pdf' ? (props.document.binary.pages.find(page => page.pageNumber === props.pageNumber)?.blocks ?? [])
  .flatMap((block, index) => block.lines?.length ? [{index, label: (block.source ?? block.lines.map(line => line.text).join(' ')).slice(0, 80)}] : []) : []);
const target = computed(() => pdfSourceEditTarget(props.document, props.pageNumber, selected.value));
const dirty = computed(() => lines.value.some((line, index) => line !== target.value?.block.lines?.[index]?.text));
const valid = computed(() => Boolean(target.value) && validPdfSourceEditLines(lines.value, target.value!.block.lines!.length));
function releasePreview(): void {if (previewUrl.value) {URL.revokeObjectURL(previewUrl.value); previewUrl.value = '';}}
async function loadPreview(): Promise<void> {
  controller?.abort(); releasePreview();
  const operation = controller = new AbortController(); loading.value = true; previewError.value = false;
  try {
    const bytes = await createPdfSourcePreview(props.document, props.pageNumber, selected.value, operation.signal);
    if (!disposed && controller === operation && !operation.signal.aborted) previewUrl.value = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], {type: 'image/png'}));
  } catch {if (!disposed && controller === operation && !operation.signal.aborted) previewError.value = true;}
  finally {if (!disposed && controller === operation) loading.value = false;}
}
watch([() => props.document, () => props.pageNumber, selected], () => {lines.value = target.value?.block.lines?.map(line => line.text) ?? []; void loadPreview(); void nextTick(resizeInputs);}, {immediate: true});
onMounted(() => {dialog.value?.showModal(); resizeInputs(); window.addEventListener('resize', resizeInputs);});
onBeforeUnmount(() => {window.removeEventListener('resize', resizeInputs); disposed = true; controller?.abort(); releasePreview(); dialog.value?.close();});
</script>
<style scoped>
.pdf-source-editor {width: min(1040px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 24px; border: 1px solid var(--line, #dde2ea); border-radius: 16px; background: var(--surface, #fff); color: var(--ink, #242b3d); overflow: auto;}
.pdf-source-editor::backdrop {background: #19233d66;}
header, footer {display: flex; align-items: center; gap: 12px;} header h2 {margin: 0; flex: 1; font-size: 19px;} footer {margin-top: 20px;} footer span {flex: 1;}
.pdf-source-block {display: grid; gap: 8px; margin-top: 20px;}.pdf-source-block select {width: 100%; min-width: 0; padding: 9px; border: 1px solid var(--line, #dde2ea); border-radius: 8px; background: inherit; color: inherit;}
.pdf-source-hint {font-size: 13px; line-height: 1.6; color: var(--muted, #606b80);}.pdf-source-columns {display: grid; grid-template-columns: 1fr 1fr; gap: 20px;}.pdf-source-columns section {min-width: 0;}.pdf-source-columns h3 {font-size: 14px; margin: 8px 0;}
.pdf-source-image, .pdf-source-lines {max-height: 52vh; overflow: auto;}.pdf-source-image {background: white;}.pdf-source-image img {display: block; width: 100%; height: auto;}.pdf-source-lines {display: grid; gap: 8px;}.pdf-source-lines label {display: flex; align-items: center; gap: 7px;}.pdf-source-lines span {width: 20px; text-align: right; flex-shrink: 0; font-size: 11px; color: var(--muted, #606b80);}.pdf-source-lines textarea {resize: none; overflow: hidden; line-height: 1.5; min-height: 36px;min-width: 0; width: 100%; padding: 8px; border: 1px solid var(--line, #dde2ea); border-radius: 6px; color: inherit; background: inherit; font: inherit; font-size: 13px;}
@media(max-width:700px) {.pdf-source-editor {padding: 16px;}.pdf-source-columns {grid-template-columns: 1fr;}.pdf-source-image {max-height: 28vh;}.pdf-source-lines {max-height: 36vh;}footer {flex-wrap: wrap;}}
</style>
