<!--
 * @file src/app/popup/PopupSiteRuleDiagnosis.vue
 * 文件职责：紧凑展示当前网页的生效规则和选区翻译原因。
 * 主要内容：显式打开时读取一次诊断，页面身份变化或组件停用后丢弃旧回执；只渲染生效标识、范围和选区状态。
 * 模块边界：仅使用 Popup 注入的本地查询入口，不直接读取网页、不翻译所选文字、不修改网站规则。
-->
<template>
  <div class="site-diagnosis">
    <button type="button" class="site-diagnosis-toggle" :aria-expanded="opened" :disabled="pending" @click="toggle">
      {{ tr('网页翻译诊断') }}
    </button>
    <div v-if="opened" class="site-diagnosis-result" aria-live="polite">
      <p v-if="pending">{{ t('glossary.importReading') }}</p>
      <template v-else-if="result">
        <p>
          <strong>{{ tr('命中规则') }}</strong>
          <span>{{ tr(result.scope === 'all' ? '全部节点' : '正文范围') }}</span>
        </p>
        <p v-if="result.ruleIds.length"><code v-for="id in result.ruleIds" :key="id" data-i18n-ignore>{{ id }}</code></p>
        <p v-else>{{ tr('无专站规则') }}</p>
        <p data-testid="site-diagnosis-selection" :data-reason="result.selection.reason">{{ tr(reasons[result.selection.reason]) }}</p>
        <p v-if="selectionDetail"><code data-i18n-ignore>{{ selectionDetail }}</code></p>
      </template>
      <p v-else>{{ tr('当前网页的诊断暂不可用') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed, ref, shallowRef, watch} from 'vue';
import type {PageRuleDiagnosis, SelectionDiagnosisReason} from '@/src/core/translation/types';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{read: () => Promise<PageRuleDiagnosis | undefined>; active: boolean}>();
const {t, translateLegacy: tr} = useUiI18n();
const opened = ref(false);
const pending = ref(false);
const result = shallowRef<PageRuleDiagnosis>();
const context = useSettingsActionContext(() => props.active, () => [props.read]);
const selectionDetail = computed(() => {
  if (!result.value) return undefined;
  const {ruleId, detail} = result.value.selection;
  if (!ruleId || result.value.ruleIds.length === 1 || detail?.startsWith(ruleId + ':')) return detail;
  return detail ? `${ruleId} · ${detail}` : ruleId;
});
const reasons: Record<SelectionDiagnosisReason, string> = {
  'no-selection': '先在网页选中一段文字，再打开诊断。',
  'rule-excluded': '所选文字在站点规则排除的区域内。',
  'rule-protected': '站点规则将所选文字保留为原文。',
  'rule-focus': '站点规则只翻译指定区域，所选文字未命中翻译区域。',
  protected: '所选文字受网页翻译保护。',
  unrecognized: '所选文字未识别为可翻译段落。',
  inactive: '已识别所选段落，当前未启动网页翻译。',
  waiting: '所选段落正在等待可见或调度。',
  loading: '所选段落正在翻译。',
  translated: '所选段落已有译文。',
  error: '所选段落的翻译失败。',
  'language-filtered': '所选段落已是目标语言或命中语言排除设置。',
  unchanged: '所选段落本次没有生成不同的译文。',
  restored: '所选段落已手动恢复为原文。',
  unscheduled: '已识别所选段落，当前会话尚未排入翻译队列。',
};

watch(context.revision, () => {
  opened.value = false;
  pending.value = false;
  result.value = undefined;
}, {flush: 'sync'});

async function toggle() {
  if (!context.active.value || pending.value) return;
  opened.value = !opened.value;
  if (!opened.value) return;
  const current = context.capture();
  pending.value = true;
  try {
    const diagnosis = await props.read();
    if (current()) result.value = diagnosis;
  } catch {
    if (current()) result.value = undefined;
  } finally {
    if (current()) pending.value = false;
  }
}
</script>

<style scoped>
.site-diagnosis { min-width: 0; }
.site-diagnosis-toggle {
  padding: 3px 2px 0; border: 0; background: none; color: var(--brand-strong);
  font: inherit; font-size: 11px; cursor: pointer;
}
.site-diagnosis-toggle:hover { text-decoration: underline; }
.site-diagnosis-result {
  display: grid; gap: 5px; margin-top: 4px; padding: 7px 8px; border: 1px solid var(--line);
  border-radius: 8px; font-size: 11px; overflow-wrap: anywhere;
}
.site-diagnosis-result p { display: flex; flex-wrap: wrap; gap: 3px 6px; margin: 0; }
.site-diagnosis-result code { font-size: inherit; }
</style>
