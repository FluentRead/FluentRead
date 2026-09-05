<!--
 @file src/app/document-translation/DocumentSegmentEditor.vue
 文件职责：提供覆盖整份文档的译文校订视图，使长文档、章节、字幕与结构化文件都可以查找和修改任意片段。
 主要内容：按原文、译文和路径搜索，筛选未翻译片段，以每页 40 段限制 DOM 数量；页码与筛选联动，并通过事件向页面提交人工校订。
 模块边界：只消费文档模型与译文，不调用翻译服务、不保存配置、不直接修改父级数据；任务所有权和导出由 DocumentApp 管理。
-->
<template>
  <section class="segment-editor" aria-label="全量译文校订">
    <div class="editor-toolbar">
      <label class="editor-search"><span class="visually-hidden">搜索原文、译文或位置</span><input v-model="query" type="search" placeholder="搜索原文、译文或位置" /></label>
      <label class="editor-filter"><input v-model="onlyPending" type="checkbox" />只看未翻译</label>
      <span>{{ filteredSegments.length }} 个片段</span>
      <label v-if="pageCount > 1" class="editor-page-select">页码<select v-model.number="page" aria-label="校订页码"><option v-for="index in pageCount" :key="index" :value="index">{{ index }} / {{ pageCount }}</option></select></label>
    </div>
    <p class="editor-note">{{ disabled ? '翻译进行中，可查看已完成的片段；暂停后即可校订。' : '修改即时用于本页预览和下载，下载文件后再离开。' }}</p>
    <div v-if="!filteredSegments.length" class="editor-empty">{{ query ? '没有找到匹配内容，试试其他关键词。' : '所有片段都已有译文。' }}</div>
    <article v-for="segment in visibleSegments" :key="segment.id" class="segment-edit-row" :data-segment-id="segment.id">
      <div class="segment-position"><strong>#{{ segment.id + 1 }}</strong><span data-i18n-ignore>{{ segment.pathLabel || segment.contextLabel || (segment.timeStart ? `${segment.timeStart} → ${segment.timeEnd}` : '正文') }}</span><small :class="{ pending: !translations[segment.id]?.trim() }">{{ translations[segment.id]?.trim() ? '已有译文' : '未翻译' }}</small></div>
      <div class="segment-edit-columns">
        <div><span class="segment-column-label">原文</span><p class="document-source" data-i18n-ignore>{{ formatDocumentReaderText(document.format, segment.source) }}</p></div>
        <label><span class="segment-column-label">译文</span><textarea class="document-translation" :value="translations[segment.id] || ''" :aria-label="`第 ${segment.id + 1} 段译文`" :disabled="disabled" @focus="editingId = segment.id" @blur="editingId = null" :rows="Math.min(12, Math.max(3, Math.ceil((translations[segment.id]?.length || segment.source.length) / 55)))" placeholder="译文会出现在这里，也可以手动填写" @input="emit('update', segment.id, ($event.target as HTMLTextAreaElement).value)" /></label>
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
import {computed, ref, watch} from 'vue';
import {formatDocumentReaderText, type ParsedDocument} from '@/src/features/document-translation/public';
const props = defineProps<{document: ParsedDocument; translations: string[]; disabled: boolean}>();
const emit = defineEmits<{update: [index: number, value: string]}>();
const query = ref('');
const onlyPending = ref(false);
const page = ref(1);
const editingId = ref<number | null>(null);
const filteredSegments = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return props.document.segments.filter((segment) => {
    if (segment.id === editingId.value) return true;
    const translation = props.translations[segment.id] || '';
    if (onlyPending.value && translation.trim()) return false;
    return !search || [segment.source, translation, segment.pathLabel, segment.contextLabel, segment.timeStart, String(segment.id + 1)].join('\n').toLocaleLowerCase().includes(search);
  });
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredSegments.value.length / 40)));
const visibleSegments = computed(() => filteredSegments.value.slice((page.value - 1) * 40, page.value * 40));
watch([query, onlyPending, () => props.document], () => { page.value = 1; });
watch(pageCount, (count) => { page.value = Math.min(page.value, count); });
</script>
