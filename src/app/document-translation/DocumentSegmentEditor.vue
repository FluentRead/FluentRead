<!--
 @file src/app/document-translation/DocumentSegmentEditor.vue
 文件职责：提供覆盖整份文档的译文校订视图，使长文档、章节、字幕与结构化文件都可以查找和修改任意片段。
 主要内容：相同译文默认折叠为带统一按钮样式的校订入口，用户主动编辑后保留人工校订能力；支持通过 active 属性在隐藏时跳过搜索与统计重算，并预计算静态原文与位置索引加速筛选；提供清空搜索、已译进度胶囊、按 focusSegmentId 跳页聚焦（含去重、过期保护与 focus-handled 通知）以及回到阅读器定位事件；修复 LRC 仅有开始时间戳时的位置展示，超大文档下收敛页码下拉选项数量；每页 40 段限制 DOM 数量，旧校订以收起的只读区保留，展开后每次展示 40 条供复制；原文、译文、旧校订和搜索词各自自动确定文字方向，不改变列顺序；切换文档时清除旧校订焦点与展开状态，页码与筛选联动，通过事件向页面提交人工校订。
 模块边界：只消费文档模型与译文，不调用翻译服务、不保存配置、不直接修改父级数据；任务所有权和导出由 DocumentApp 管理。
-->
<template>
  <section class="segment-editor" aria-label="全量译文校订">
    <div class="editor-toolbar">
      <div class="editor-search">
        <label class="editor-search-label"><span class="visually-hidden">搜索原文、译文或位置</span><input v-model="query" dir="auto" type="search" placeholder="搜索原文、译文或位置" /></label>
        <button v-if="query" type="button" class="editor-search-clear" :aria-label="t('document.pdfReading.clearSearch')" :title="t('document.pdfReading.clearSearch')" @click="query = ''">×</button>
      </div>
      <label class="editor-filter"><input v-model="onlyPending" type="checkbox" />只看未翻译</label>
      <span class="editor-progress-pill">{{ t('document.pdfReading.editorSummary', {completed: completedCount, total: scopedSegments.length}) }}</span>
      <span>{{ filteredSegments.length }} 个片段</span>
      <label v-if="pageCount > 1" class="editor-page-select">页码<ElSelect class="document-select" append-to=".document-app" v-model="page" aria-label="校订页码"><ElOption v-for="index in pageOptions" :key="index" :value="index" :label="`${index} / ${pageCount}`" /></ElSelect></label>
    </div>
    <p class="editor-note">{{ disabled ? '翻译进行中，可查看已完成的片段；暂停后即可校订。' : '修改即时用于本页预览和下载，下载文件后再离开。' }}</p>
    <details v-if="retainedRevisions?.length" class="editor-retained" :open="retainedOpen" @toggle="retainedOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('document.retainedRevisions.title') }} · {{ retainedRevisions.length }}</summary>
      <template v-if="retainedOpen">
        <p class="editor-note">{{ t('document.retainedRevisions.hint') }}</p>
        <article v-for="(revision, index) in retainedRevisions.slice(0, retainedLimit)" :key="index" class="segment-edit-row">
          <div class="segment-position"><span v-if="revision.pageNumber && revision.blockNumber">{{ t('document.sourceEdit.location', {page: revision.pageNumber, block: revision.blockNumber}) }}</span><span data-i18n-ignore>{{ revision.contextLabel }}</span></div>
          <div class="segment-edit-columns"><div><span class="segment-column-label">{{ revision.kind === 'source' ? t('document.sourceEdit.sourceRevision') : translateLegacy('原文') }}</span><p dir="auto" class="document-source" data-i18n-ignore>{{ revision.source }}</p></div><div v-if="revision.translation"><span class="segment-column-label">{{ t('document.retainedRevisions.revision') }}</span><p dir="auto" class="document-translation" data-i18n-ignore>{{ revision.translation }}</p></div></div>
        </article>
        <button v-if="retainedLimit < retainedRevisions.length" type="button" class="ghost-button" @click="retainedLimit += 40">{{ translateLegacy('显示更多') }}</button>
      </template>
    </details>
    <div v-if="!filteredSegments.length" class="editor-empty">{{ query ? '没有找到匹配内容，试试其他关键词。' : '所有片段都已有译文。' }}</div>
    <article v-for="segment in visibleSegments" :key="segment.id" class="segment-edit-row" :data-segment-id="segment.id">
      <div class="segment-position"><strong>#{{ segment.id + 1 }}</strong><span data-i18n-ignore>{{ segmentPositionLabel(segment) }}</span><small :class="{ pending: !translations[segment.id]?.trim() }">{{ translations[segment.id]?.trim() ? '已有译文' : '未翻译' }}</small></div>
      <div class="segment-edit-columns">
        <div><span class="segment-column-label">原文</span><p dir="auto" class="document-source" data-i18n-ignore>{{ sourceText(segment) }}</p><button v-if="editableSourceIds.has(segment.id)" type="button" class="ghost-button" :disabled="disabled" @click="emit('source-edit', segment.id)">{{ t('document.sourceEdit.open') }}</button></div>
        <label v-if="!translations[segment.id]?.trim() || hasDistinctTranslation(sourceText(segment), formatDocumentReaderText(document.format, translations[segment.id], segment.docxInline)) || editingSameId === segment.id"><span class="segment-column-label">译文</span><textarea :ref="el => setTextareaRef(segment.id, el)" dir="auto" class="document-translation" :value="translations[segment.id] || ''" :aria-label="t('document.segmentTranslation', {number: segment.id + 1})" :disabled="disabled" @focus="editingId = segment.id" @blur="editingId = null" :rows="Math.min(12, Math.max(3, Math.ceil((translations[segment.id]?.length || segment.source.length) / 55)))" placeholder="译文会出现在这里，也可以手动填写" @input="emit('update', segment.id, ($event.target as HTMLTextAreaElement).value)" /><small v-if="hasDocumentPlaceholder(translations[segment.id])" class="segment-placeholder-hint">{{ translateLegacy('<g1>…</g1> 这类标记对应原文里的链接、加粗等格式，保留它们，译文才带有这些格式。') }}</small></label>
        <button v-else type="button" class="ghost-button compact-action" :disabled="disabled" @click="editingSameId = segment.id">{{ translateLegacy('校订译文') }}</button>
      </div>
      <div class="segment-row-actions">
        <button type="button" class="ghost-button compact-action segment-locate-button" @click="emit('locate-segment', segment.id)">{{ t('document.pdfReading.locateInReader') }}</button>
      </div>
    </article>
    <nav v-if="pageCount > 1" class="reader-pagination" aria-label="校订分页">
      <button type="button" :disabled="page === 1" @click="page--">上一页</button>
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <button type="button" :disabled="page === pageCount" @click="page++">下一页</button>
    </nav>
  </section>
</template>
<script setup lang="ts">
import {hasDistinctTranslation} from '@/src/core/translation/result';
import ElSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';
import 'element-plus/es/components/select/style/css';
import {useUiI18n} from "@/src/ui/i18n";
const {t, translateLegacy} = useUiI18n();
import {computed, nextTick, ref, watch} from 'vue';
import {documentSegmentMarkupSources, formatDocumentReaderText, hasDocumentPlaceholder, type DocumentSegment, type DocumentRetainedRevision, type ParsedDocument} from '@/src/features/document-translation/public';
import {getDocumentGeneratedPositionLabels} from '@/src/features/document-translation/ui/presentation';
const props = withDefaults(defineProps<{document: ParsedDocument; translations: string[]; retainedRevisions?: DocumentRetainedRevision[]; disabled: boolean; scopeIds?: ReadonlySet<number>; active?: boolean; focusSegmentId?: number | null}>(), {active: true});
const emit = defineEmits<{update: [index: number, value: string]; 'source-edit': [index: number]; 'locate-segment': [segmentId: number]; 'focus-handled': []}>();
const MAX_DIRECT_PAGE_OPTIONS = 100;
const isActive = computed(() => props.active);
const editableSourceIds = computed(() => new Set(props.document.binary?.kind === 'pdf' ? props.document.binary.pages
  .filter(page => !page.scanned && (page.ocrRecognized || page.ocrReviewRegions !== undefined))
  .flatMap(page => page.blocks.filter(block => block.segmentIndex >= 0 && block.lines?.length).map(block => block.segmentIndex)) : []));
// 整句送翻的片段，原文列显示替换成占位符之前的文字。
const markupSources = computed(() => documentSegmentMarkupSources(props.document));
const generatedPositionLabels = computed(() => getDocumentGeneratedPositionLabels(props.document, page => t('document.pageNumber', {page}), translateLegacy));
const sourceText = (segment: DocumentSegment) => formatDocumentReaderText(props.document.format, markupSources.value.get(segment.id) ?? segment.source, segment.docxInline);
const staticHaystacks = computed(() => {
  const map = new Map<number, string>();
  for (const segment of props.document.segments) {
    map.set(
      segment.id,
      [segment.source, segment.pathLabel, segment.contextLabel, segment.timeStart, String(segment.id + 1)].join('\n').toLocaleLowerCase(),
    );
  }
  return map;
});
function segmentPositionLabel(segment: DocumentSegment): string {
  const generated = generatedPositionLabels.value.get(segment.id);
  if (generated) return generated;
  if (segment.pathLabel) return segment.pathLabel;
  if (segment.contextLabel) return segment.contextLabel;
  if (segment.timeStart) return segment.timeEnd ? `${segment.timeStart} → ${segment.timeEnd}` : segment.timeStart;
  return translateLegacy('正文');
}
const query = ref('');
const onlyPending = ref(false);
const page = ref(1);
const editingId = ref<number | null>(null);
const editingSameId = ref<number | null>(null);
const retainedOpen = ref(false);
const retainedLimit = ref(40);
const textareas = new Map<number, {focus?: () => void}>();
function setTextareaRef(id: number, el: unknown): void {
  if (el) textareas.set(id, el as {focus?: () => void});
  else textareas.delete(id);
}
const scopedSegments = computed(() => props.scopeIds ? props.document.segments.filter(segment => props.scopeIds!.has(segment.id)) : props.document.segments);
const completedCount = computed(() => {
  if (!isActive.value) return 0;
  let count = 0;
  for (const segment of scopedSegments.value) {
    if (props.translations[segment.id]?.trim()) count++;
  }
  return count;
});
const filteredSegments = computed(() => {
  if (!isActive.value) return [];
  const search = query.value.trim().toLocaleLowerCase();
  if (!search && !onlyPending.value) return scopedSegments.value;
  const haystacks = staticHaystacks.value;
  return scopedSegments.value.filter((segment) => {
    if (segment.id === editingId.value) return true;
    const translation = props.translations[segment.id] || '';
    if (onlyPending.value && translation.trim()) return false;
    return !search || haystacks.get(segment.id)!.includes(search) || translation.toLocaleLowerCase().includes(search);
  });
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredSegments.value.length / 40)));
const pageOptions = computed(() => {
  const total = pageCount.value;
  if (total <= MAX_DIRECT_PAGE_OPTIONS) return Array.from({length: total}, (_, index) => index + 1);
  const pages = new Set<number>([1, total]);
  for (let index = Math.max(1, page.value - 20); index <= Math.min(total, page.value + 20); index++) pages.add(index);
  for (let index = 10; index < total; index += Math.max(10, Math.floor(total / 20))) pages.add(index);
  return [...pages].sort((a, b) => a - b);
});
const visibleSegments = computed(() => filteredSegments.value.slice((page.value - 1) * 40, page.value * 40));
let lastHandledFocusId: number | null = null;
let focusRun = 0;
const staleFocus = (run: number) => run !== focusRun || !isActive.value;
async function focusSegment(targetId: number): Promise<void> {
  const run = ++focusRun;
  if (!filteredSegments.value.some(segment => segment.id === targetId)) {
    query.value = '';
    onlyPending.value = false;
  }
  await nextTick();
  if (staleFocus(run)) return;
  const index = filteredSegments.value.findIndex(segment => segment.id === targetId);
  if (index < 0) return;
  page.value = Math.floor(index / 40) + 1;
  editingSameId.value = targetId;
  await nextTick();
  if (staleFocus(run)) return;
  const field = textareas.get(targetId);
  if (field && typeof field.focus === 'function') field.focus();
}
watch([query, onlyPending, () => props.document, () => props.scopeIds], () => { page.value = 1; editingSameId.value = null; });
watch(() => props.document, () => { editingId.value = null; retainedOpen.value = false; retainedLimit.value = 40; lastHandledFocusId = null; });
watch([pageCount, isActive], ([count, active]) => { if (active) page.value = Math.min(page.value, count); });
watch([() => props.focusSegmentId, isActive], async ([targetId, active]) => {
  if (targetId == null) {
    lastHandledFocusId = null;
    return;
  }
  if (!active || targetId === lastHandledFocusId) return;
  lastHandledFocusId = targetId;
  await focusSegment(targetId);
  if (isActive.value && props.focusSegmentId === targetId) emit('focus-handled');
}, {immediate: true});
defineExpose({focusSegment});
</script>
<style scoped>
.editor-search { position: relative; display: flex; align-items: center; }
.editor-search-label { flex: 1; min-width: 0; }
.editor-search-label input[type="search"] { padding-right: 34px; }
.editor-search-label input[type="search"]::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
.editor-search-clear { position: absolute; right: 8px; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted, #606b80); font-size: 14px; line-height: 1; cursor: pointer; }
.editor-search-clear:hover { color: var(--ink, #242b3d); background: var(--line, #dde2ea); }
.editor-progress-pill { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; background: var(--surface-soft, #f5f7fa); border: 1px solid var(--line, #dde2ea); color: var(--ink, #242b3d); font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.compact-action { padding: 5px 10px; font-size: 12px; align-self: flex-start; }
.segment-row-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.segment-locate-button { color: var(--muted, #606b80); font-size: 11.5px; padding: 3px 8px; }
</style>
