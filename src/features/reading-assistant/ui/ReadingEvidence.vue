<!--
 * @file src/features/reading-assistant/ui/ReadingEvidence.vue
 * 文件职责：在句末以无外框的双引号图标显示已经校验的原文依据和定位状态，保留失效来源的文字供读者核对。
 * 主要内容：使用无常驻背景的行内引文原生按钮支持点击及键盘操作，完整引文保留在悬停提示与无障碍名称中；通过受限回调定位原句，只显示简短失效提示，历史材料保留快照。
 * 模块边界：只接收已校验的引用，不读取网页、网络或存储；原文定位及临时绘制由页面所属锚点负责。
 -->
<template>
  <span class="fr-reading-evidence-wrap" data-i18n-ignore>
    <button type="button" class="fr-reading-evidence" data-reading-evidence :data-evidence-quote="citation.quote" :data-evidence-state="state" :aria-label="t('reading.evidence.locate', {quote: citation.quote})" :title="citation.quote" @click="locate"><svg aria-hidden="true" focusable="false" data-evidence-icon="quote" viewBox="0 0 16 16"><path d="M2 3h5v4c0 3-1.5 5-4 6l-1-1.5C4 10.5 5 9 5 8H2Z" /><path d="M9 3h5v4c0 3-1.5 5-4 6l-1-1.5C11 10.5 12 9 12 8H9Z" /></svg></button>
    <span v-if="state !== 'ready'" class="fr-reading-evidence-status" :class="{'is-located': state === 'located'}" role="status">{{ t(`reading.evidence.${state}`) }}</span>
  </span>
</template>
<script setup lang="ts">
import {ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import type {ReadingEvidenceBlock} from '@/src/core/harness/evidence';
import type {ReadingEvidenceCitation, ReadingEvidenceLocation} from '../evidenceAnchor';
const props = defineProps<{citation: Extract<ReadingEvidenceBlock, {kind: 'citation'}>; locateEvidence?: (citation: ReadingEvidenceCitation) => ReadingEvidenceLocation; sourceState?: ReadingEvidenceLocation}>();
const {t} = useUiI18n();
const state = ref<'ready' | ReadingEvidenceLocation>('ready');
watch(() => [props.citation.id, props.citation.quote, props.locateEvidence, props.sourceState], () => {
  state.value = props.sourceState && props.sourceState !== 'located' ? props.sourceState : 'ready';
}, {immediate: true});
function locate(): void {
  state.value = props.locateEvidence?.({quote: props.citation.quote, sourceText: props.citation.sourceText, kind: props.citation.sourceKind, sourceOffset: props.citation.sourceStart}) ?? 'unavailable';
}
</script>
<style scoped>
.fr-reading-evidence-wrap { display: inline; }
.fr-reading-evidence { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin: 0 2px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--fr-reading-muted, #5d6678); font: inherit; line-height: 1; vertical-align: text-bottom; cursor: pointer; transition: color 120ms cubic-bezier(.23, 1, .32, 1), background-color 120ms cubic-bezier(.23, 1, .32, 1); }
.fr-reading-evidence svg { width: 15px; height: 15px; fill: currentColor; stroke: none; }
.fr-reading-evidence:hover, .fr-reading-evidence:focus-visible { color: var(--fr-reading-button, #d4235a); background: var(--fr-reading-active-bg, #fff0f5); }
.fr-reading-evidence:focus-visible { outline: 2px solid var(--fr-reading-button, #d4235a); outline-offset: 1px; }
.fr-reading-evidence-status { font-size: 12px; color: var(--fr-answer-quote, inherit); }
.fr-reading-evidence-status.is-located { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
