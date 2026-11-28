<!--
 * @file src/features/reading-assistant/ui/SentenceAnalysis.vue
 * 文件职责：在原文片段下展示当前界面语言的句中作用和词性，让学习者先总览结构，再点击查看含义。
 * 主要内容：以紧凑双行片段保留原文顺序，将间隔和标点与前一片段一起排版；常见作用及词性本地化，未识别名称保留模型已有摘要，去掉未知或重复维度的冗余标签；完整作用和含义点击可查，支持方向键切换及深浅主题。
 * 模块边界：只接收已经锚定的标注，不进行词性猜测、不发起请求，不写入宿主网页。
 -->
<template>
  <section class="fr-sentence-analysis" :aria-label="translateLegacy('词性与句法')">
    <div class="fr-sentence-tokens" role="group" :aria-label="translateLegacy('原文词性标注')" :title="translateLegacy('点击原文片段，查看词性和句中作用')" @keydown="navigateAnnotations">
      <span class="fr-sentence-gap">{{ source.slice(0, annotations[0]?.start || 0) }}</span>
      <template v-for="({annotation, punctuation, remaining}, index) in units" :key="`${annotation.start}-${annotation.end}`">
      <span class="fr-sentence-unit">
        <button type="button" :data-pos="annotation.part.id" :data-role="describeSentenceRole(annotation.role).id" :aria-pressed="selected === index" :tabindex="selected === index ? 0 : -1" :aria-label="`${annotation.text} · ${annotationLabel(annotation)}`" :title="annotationLabel(annotation)" @click="selectAnnotation(index)">
          <span class="fr-sentence-token-text">{{ annotation.text }}</span>
          <span class="fr-sentence-token-meta">{{ annotationLabel(annotation) }}</span>
        </button>
        <span class="fr-sentence-gap">{{ punctuation }}</span>
      </span>
      <span class="fr-sentence-gap">{{ remaining }}</span>
      </template>
    </div>
    <div v-if="active" ref="detail" class="fr-sentence-detail" aria-live="polite">
      <div class="fr-sentence-detail-heading"><strong>{{ active.text }}</strong><span>{{ partLabel(active) }}</span></div>
      <p class="fr-sentence-meaning">{{ active.meaning }}</p>
      <p class="fr-sentence-role"><span>{{ translateLegacy('句中作用') }}</span>{{ roleDescription(active) }}</p>
      <details :key="selected" class="fr-sentence-reference">
        <summary>{{ translateLegacy('词性说明') }}</summary>
        <p>{{ translateLegacy(active.part.description) }}</p>
        <p>{{ translateLegacy('AI 根据原文分析；同一个词在不同句子中可能有不同词性。') }}</p>
      </details>
    </div>
  </section>
</template>
<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {describeSentenceRole, summarizeSentenceRole, type SentenceAnnotation} from '../sentenceAnalysis';
const props = defineProps<{source: string; annotations: SentenceAnnotation[]}>();
const {translateLegacy} = useUiI18n();
const selected = ref(0);
const detail = ref<HTMLElement>();
const units = computed(() => props.annotations.map((annotation, index) => {
  const gap = props.source.slice(annotation.end, props.annotations[index + 1]?.start ?? props.source.length);
  // 只将紧邻的标点和横向空白附在片段后，未标注正文独立换行，避免挤窄部分标注。
  const punctuation = gap.match(/^[\p{P}\p{Zs}\t]*/u)![0];
  return {annotation, punctuation, remaining: gap.slice(punctuation.length)};
}));
const unknownLabel = (value: string) => /^(?:unknown|other|其他|未知|未明确)$/iu.test(value.trim());
function partLabel(annotation: SentenceAnnotation): string {
  return translateLegacy(unknownLabel(annotation.part.label) ? '其他' : annotation.part.label);
}
function annotationLabel(annotation: SentenceAnnotation): string {
  const role = describeSentenceRole(annotation.role);
  const roleLabel = role.id === 'other' ? summarizeSentenceRole(annotation.role) : translateLegacy(role.label);
  const labels = [unknownLabel(roleLabel) ? '' : roleLabel, unknownLabel(annotation.part.label) ? '' : partLabel(annotation)].filter(Boolean);
  return [...new Set(labels)].join(' · ') || translateLegacy('其他');
}
function roleDescription(annotation: SentenceAnnotation): string {
  const role = describeSentenceRole(annotation.role);
  return role.id !== 'other' && summarizeSentenceRole(annotation.role) === annotation.role.trim()
    ? translateLegacy(role.label) : annotation.role;
}
async function selectAnnotation(index: number): Promise<void> {
  selected.value = index;
  await nextTick();
  const element = detail.value;
  const viewport = element?.closest<HTMLElement>('.fr-reading-result');
  if (!element || !viewport) return;
  const box = element.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  if (box.bottom > bounds.bottom) viewport.scrollTop += Math.min(box.bottom - bounds.bottom + 8, box.top - bounds.top);
}

function navigateAnnotations(event: KeyboardEvent): void {
  const last = props.annotations.length - 1;
  const next = event.key === 'ArrowRight' ? Math.min(last, selected.value + 1)
    : event.key === 'ArrowLeft' ? Math.max(0, selected.value - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
  if (next < 0 || !(event.target instanceof HTMLButtonElement)) return;
  event.preventDefault(); event.stopPropagation();
  void selectAnnotation(next);
  (event.currentTarget as HTMLElement).querySelectorAll('button')[next]?.focus({preventScroll: true});
}

const active = computed(() => props.annotations[selected.value] || props.annotations[0]);
watch(() => [props.source, props.annotations.length] as const, ([source, length], [previousSource]) => {
  if (source !== previousSource || selected.value >= length) selected.value = 0;
});
</script>
<style scoped>
.fr-sentence-analysis { margin: 6px 0 10px; }
.fr-sentence-tokens { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 5px 4px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.fr-sentence-unit { display: inline-flex; align-items: flex-start; max-width: 100%; vertical-align: top; }
.fr-sentence-gap { white-space: pre-wrap; padding-top: 5px; }
.fr-sentence-tokens button {
  --pos-color: #64748b;
  font: inherit;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--pos-color) 22%, transparent);
  border-bottom: 2px solid color-mix(in srgb, var(--pos-color) 52%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--pos-color) 6%, transparent);
  color: inherit;
  cursor: pointer;
  text-align: start;
  white-space: normal;
  overflow-wrap: anywhere;
  transition: background-color 120ms cubic-bezier(.23, 1, .32, 1), border-color 120ms cubic-bezier(.23, 1, .32, 1), box-shadow 120ms cubic-bezier(.23, 1, .32, 1), transform 120ms cubic-bezier(.23, 1, .32, 1);
}
.fr-sentence-token-text { max-width: 100%; font-size: 12.5px; font-weight: 500; line-height: 1.4; }
.fr-sentence-token-meta { max-width: 100%; font-size: 11px; line-height: 1.35; color: var(--fr-reading-muted, var(--el-text-color-secondary, #5d6678)); white-space: normal; overflow-wrap: anywhere; user-select: none; }
.fr-dark-theme .fr-sentence-token-meta { color: #a5aebf; }
.fr-sentence-tokens button[data-pos=noun], .fr-sentence-tokens button[data-pos=pronoun] { --pos-color: #2563a6; }
.fr-sentence-tokens button[data-pos=verb], .fr-sentence-tokens button[data-pos=auxiliary] { --pos-color: #d4235a; }
.fr-sentence-tokens button[data-pos=adjective], .fr-sentence-tokens button[data-pos=adverb] { --pos-color: #147e5c; }
.fr-sentence-tokens button[data-pos=article], .fr-sentence-tokens button[data-pos=determiner] { --pos-color: #8f5f16; }
.fr-sentence-tokens button[data-pos=conjunction], .fr-sentence-tokens button[data-pos=preposition] { --pos-color: #6d4ec4; }
.fr-sentence-tokens button[data-role=subject] { --pos-color: #147e5c; }
.fr-sentence-tokens button[data-role=predicate] { --pos-color: #d4235a; }
.fr-sentence-tokens button[data-role=object], .fr-sentence-tokens button[data-role=indirect-object] { --pos-color: #2563a6; }
.fr-sentence-tokens button[data-role=attribute], .fr-sentence-tokens button[data-role=postmodifier] { --pos-color: #8f5f16; }
.fr-dark-theme .fr-sentence-tokens button[data-pos=noun], .fr-dark-theme .fr-sentence-tokens button[data-pos=pronoun], .fr-dark-theme .fr-sentence-tokens button[data-role=object], .fr-dark-theme .fr-sentence-tokens button[data-role=indirect-object] { --pos-color: #7ab3f0; }
.fr-dark-theme .fr-sentence-tokens button[data-pos=verb], .fr-dark-theme .fr-sentence-tokens button[data-pos=auxiliary], .fr-dark-theme .fr-sentence-tokens button[data-role=predicate] { --pos-color: #f46590; }
.fr-dark-theme .fr-sentence-tokens button[data-pos=adjective], .fr-dark-theme .fr-sentence-tokens button[data-pos=adverb], .fr-dark-theme .fr-sentence-tokens button[data-role=subject] { --pos-color: #5cd4ab; }
.fr-dark-theme .fr-sentence-tokens button[data-pos=article], .fr-dark-theme .fr-sentence-tokens button[data-pos=determiner], .fr-dark-theme .fr-sentence-tokens button[data-role=attribute], .fr-dark-theme .fr-sentence-tokens button[data-role=postmodifier] { --pos-color: #ebca84; }
.fr-dark-theme .fr-sentence-tokens button[data-pos=conjunction], .fr-dark-theme .fr-sentence-tokens button[data-pos=preposition] { --pos-color: #b49ef2; }
.fr-sentence-tokens button[aria-pressed=true] {
  border-color: var(--pos-color);
  background: color-mix(in srgb, var(--pos-color) 12%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--pos-color) 35%, transparent);
}
.fr-sentence-tokens button:hover { background: color-mix(in srgb, var(--pos-color) 11%, transparent); }
.fr-sentence-tokens button:active { transform: scale(.98); }
.fr-sentence-tokens button:focus-visible, .fr-sentence-reference summary:focus-visible { outline: 2px solid var(--fr-reading-button, #d4235a); outline-offset: 2px; }
.fr-sentence-detail { margin: 10px 0 0; padding: 10px 12px; border: 1px solid var(--fr-reading-line, #e7eaf1); border-radius: 9px; background: var(--fr-reading-soft, #f7f8fb); }
.fr-sentence-detail-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.fr-sentence-detail-heading strong { font-size: 13.5px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.fr-sentence-detail-heading > span { padding: 1px 6px; border: 1px solid var(--fr-reading-line, #e7eaf1); border-radius: 5px; background: var(--fr-reading-bg, #ffffff); color: var(--fr-reading-button, #d4235a); font-size: 11px; font-weight: 600; }
.fr-sentence-detail p { margin: 5px 0 0; overflow-wrap: anywhere; }
.fr-sentence-meaning { font-size: 13px; line-height: 1.65; }
.fr-sentence-role { font-size: 12px; color: var(--fr-reading-muted, #5d6678); }
.fr-sentence-role > span { margin-inline-end: 6px; font-weight: 600; }
.fr-sentence-reference { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--fr-reading-line, #e7eaf1); font-size: 11px; color: var(--fr-reading-muted, var(--el-text-color-secondary, #5d6678)); }
.fr-sentence-reference summary { display: inline-flex; align-items: center; gap: 5px; list-style: none; cursor: pointer; width: fit-content; font-weight: 500; }
.fr-sentence-reference summary::-webkit-details-marker { display: none; }
.fr-sentence-reference summary::before { content: ''; width: 5px; height: 5px; flex: none; border: solid currentColor; border-width: 0 1.4px 1.4px 0; transform: rotate(-45deg); transition: transform 140ms cubic-bezier(.23, 1, .32, 1); }
.fr-sentence-reference[open] summary::before { transform: rotate(45deg); }
.fr-sentence-reference p { line-height: 1.6; }
.fr-dark-theme .fr-sentence-detail { background: #232833; border-color: #2f3542; color: #f1f3f7; }
.fr-dark-theme .fr-sentence-detail-heading > span { background: #1c2028; border-color: #2f3542; color: #ff85ab; }
.fr-dark-theme .fr-sentence-reference { border-top-color: #2f3542; }
.fr-dark-theme .fr-sentence-reference, .fr-dark-theme .fr-sentence-role { color: #a5aebf; }
@media (prefers-reduced-motion: reduce) {
  .fr-sentence-tokens button, .fr-sentence-reference summary::before { transition: none; }
}
</style>
