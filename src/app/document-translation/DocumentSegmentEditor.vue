<!--
 @file src/app/document-translation/DocumentSegmentEditor.vue
 文件职责：提供覆盖整份文档的译文校订视图，使长文档、章节、字幕与结构化文件都可以查找和修改任意片段。
 主要内容：相同译文默认折叠为校订入口，用户主动编辑后保留人工校订能力；按原文、译文和路径搜索，筛选未翻译片段，默认直接分页引用原始片段而不扫描译文，以每页 40 段限制 DOM 数量；原文结构变化后无法安全回填的旧校订以收起的只读区保留，展开后每次展示 40 条供复制；原文、译文、旧校订和搜索词各自自动确定文字方向，不改变列顺序；整句送翻的片段，原文列显示占位符替换前的文字，译文带占位符时提示保留它们才能保留格式；切换文档时清除旧校订焦点与展开状态，页码与筛选联动，通过事件向页面提交人工校订。
 模块边界：只消费文档模型与译文，不调用翻译服务、不保存配置、不直接修改父级数据；任务所有权和导出由 DocumentApp 管理。
-->
<template>
  <section class="segment-editor" aria-label="全量译文校订">
    <div class="editor-toolbar">
      <label class="editor-search"><span class="visually-hidden">搜索原文、译文或位置</span><input v-model="query" dir="auto" type="search" placeholder="搜索原文、译文或位置" /></label>
      <label class="editor-filter"><input v-model="onlyPending" type="checkbox" />只看未翻译</label>
      <span>{{ filteredSegments.length }} 个片段</span>
      <label v-if="pageCount > 1" class="editor-page-select">页码<ElSelect class="document-select"  append-to=".document-app" v-model="page" aria-label="校订页码"><ElOption v-for="index in pageCount" :key="index" :value="index" :label="`${index} / ${pageCount}`" /></ElSelect></label>
    </div>
    <p class="editor-note">{{ disabled ? '翻译进行中，可查看已完成的片段；暂停后即可校订。' : '修改即时用于本页预览和下载，下载文件后再离开。' }}</p>
    <details v-if="retainedRevisions?.length" class="editor-retained" :open="retainedOpen" @toggle="retainedOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('document.retainedRevisions.title') }} · {{ retainedRevisions.length }}</summary>
      <template v-if="retainedOpen">
        <p class="editor-note">{{ t('document.retainedRevisions.hint') }}</p>
        <article v-for="(revision, index) in retainedRevisions.slice(0, retainedLimit)" :key="index" class="segment-edit-row">
          <div class="segment-position"><span data-i18n-ignore>{{ revision.contextLabel }}</span></div>
          <div class="segment-edit-columns"><div><span class="segment-column-label">原文</span><p dir="auto" class="document-source" data-i18n-ignore>{{ revision.source }}</p></div><div><span class="segment-column-label">{{ t('document.retainedRevisions.revision') }}</span><p dir="auto" class="document-translation" data-i18n-ignore>{{ revision.translation }}</p></div></div>
        </article>
        <button v-if="retainedLimit < retainedRevisions.length" type="button" class="ghost-button" @click="retainedLimit += 40">{{ translateLegacy('显示更多') }}</button>
      </template>
    </details>
    <div v-if="!filteredSegments.length" class="editor-empty">{{ query ? '没有找到匹配内容，试试其他关键词。' : '所有片段都已有译文。' }}</div>
    <article v-for="segment in visibleSegments" :key="segment.id" class="segment-edit-row" :data-segment-id="segment.id">
      <div class="segment-position"><strong>#{{ segment.id + 1 }}</strong><span data-i18n-ignore>{{ generatedPositionLabels.get(segment.id) || segment.pathLabel || segment.contextLabel || (segment.timeStart ? `${segment.timeStart} → ${segment.timeEnd}` : translateLegacy('正文')) }}</span><small :class="{ pending: !translations[segment.id]?.trim() }">{{ translations[segment.id]?.trim() ? '已有译文' : '未翻译' }}</small></div>
      <div class="segment-edit-columns">
        <div><span class="segment-column-label">原文</span><p dir="auto" class="document-source" data-i18n-ignore>{{ sourceText(segment) }}</p></div>
        <label v-if="!translations[segment.id]?.trim() || hasDistinctTranslation(sourceText(segment), formatDocumentReaderText(document.format, translations[segment.id])) || editingSameId === segment.id"><span class="segment-column-label">译文</span><textarea dir="auto" class="document-translation" :value="translations[segment.id] || ''" :aria-label="t('document.segmentTranslation', {number: segment.id + 1})" :disabled="disabled" @focus="editingId = segment.id" @blur="editingId = null" :rows="Math.min(12, Math.max(3, Math.ceil((translations[segment.id]?.length || segment.source.length) / 55)))" placeholder="译文会出现在这里，也可以手动填写" @input="emit('update', segment.id, ($event.target as HTMLTextAreaElement).value)" /><small v-if="hasDocumentPlaceholder(translations[segment.id])" class="segment-placeholder-hint">{{ translateLegacy('<g1>…</g1> 这类标记对应原文里的链接、加粗等格式，保留它们，译文才带有这些格式。') }}</small></label>
        <button v-else type="button" :disabled="disabled" @click="editingSameId = segment.id">{{ translateLegacy('校订译文') }}</button>
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
import {computed, ref, watch} from 'vue';
import {documentSegmentMarkupSources, formatDocumentReaderText, hasDocumentPlaceholder, type DocumentSegment, type DocumentRetainedRevision, type ParsedDocument} from '@/src/features/document-translation/public';
import {getDocumentGeneratedPositionLabels} from '@/src/features/document-translation/ui/presentation';
const props = defineProps<{document: ParsedDocument; translations: string[]; retainedRevisions?: DocumentRetainedRevision[]; disabled: boolean}>();
const emit = defineEmits<{update: [index: number, value: string]}>();
// 整句送翻的片段，原文列显示替换成占位符之前的文字。
const markupSources = computed(() => documentSegmentMarkupSources(props.document));
const generatedPositionLabels = computed(() => getDocumentGeneratedPositionLabels(props.document, page => t('document.pageNumber', {page}), translateLegacy));
const sourceText = (segment: DocumentSegment) => formatDocumentReaderText(props.document.format, markupSources.value.get(segment.id) ?? segment.source);
const query = ref('');
const onlyPending = ref(false);
const page = ref(1);
const editingId = ref<number | null>(null);
const editingSameId = ref<number | null>(null);
const retainedOpen = ref(false);
const retainedLimit = ref(40);
const filteredSegments = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  if (!search && !onlyPending.value) return props.document.segments;
  return props.document.segments.filter((segment) => {
    if (segment.id === editingId.value) return true;
    const translation = props.translations[segment.id] || '';
    if (onlyPending.value && translation.trim()) return false;
    return !search || [segment.source, translation, segment.pathLabel, segment.contextLabel, segment.timeStart, String(segment.id + 1)].join('\n').toLocaleLowerCase().includes(search);
  });
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredSegments.value.length / 40)));
const visibleSegments = computed(() => filteredSegments.value.slice((page.value - 1) * 40, page.value * 40));
watch([query, onlyPending, () => props.document], () => { page.value = 1; editingSameId.value = null; });
watch(() => props.document, () => { editingId.value = null; retainedOpen.value = false; retainedLimit.value = 40; });
watch(pageCount, (count) => { page.value = Math.min(page.value, count); });
</script>
