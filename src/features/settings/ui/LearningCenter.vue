<!--
 * @file src/features/settings/ui/LearningCenter.vue
 * 文件职责：把阅读材料、轻量收藏、最近 30 天的阅读记录和长期学习笔记组织成统一的学习中心。
 * 主要内容：保留默认收藏入口，按平台能力开放材料入口与直达参数，按需加载材料、记录与笔记，提供等待和页面重载提示，集中展示本地保存说明和备份入口；向收藏与材料面板传递稳定的可见状态，异步面板在学习中心隐藏后才挂载时也延后普通刷新。
 * 模块边界：只组合 vocabulary 和 reading-assistant 的公开 UI；各 feature 拥有数据操作生命周期，页面重载由设置入口处理。
 -->
<template>
  <div id="settings-vocabulary" class="fr-learning-center">
    <header class="fr-learning-center-header">
      <SegmentedControl v-model="activeTab" :options="tabs" :label="t('learning.content')" />
    </header>
    <p v-if="activeTab === 'saved'" class="fr-learning-center-purpose">{{ t(`learning.${activeTab}Description`) }}</p>
    <VocabularyBook v-if="activeTab === 'saved'" :is-visible="isPanelVisible" @navigate="emit('navigate', $event)" />
    <MaterialWorkspace v-else-if="materialWorkspaceAvailable && activeTab === 'materials'" :is-visible="isPanelVisible" @navigate="emit('navigate', $event)" @open-tab="activeTab = $event" />
    <HarnessReadingHistory v-else-if="activeTab === 'history'" :is-visible="isPanelVisible" />
    <LearningMemoryManager v-else :enabled="memoryEnabled" :is-visible="isPanelVisible" @navigate="emit('navigate', $event)" />
    <footer class="fr-learning-local">
      <details class="fr-learning-storage" @keydown.esc.stop.prevent="($event.currentTarget as HTMLDetailsElement).open = false">
        <summary><UiIcon name="shield" :size="14" />{{ t('learning.localStorage') }}<UiIcon name="chevron-down" :size="12" /></summary>
        <p>{{ t('learning.retention') }}<br>{{ t('learning.localStorageHelp') }}</p>
      </details>
      <button type="button" @click="emit('navigate', 'settings-data')">{{ t('learning.backup') }}</button>
    </footer>
  </div>
</template>
<script setup lang="ts">
import {computed, defineAsyncComponent, h, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue'
import {VocabularyBook} from '@/src/features/vocabulary/ui/public'
import {useUiI18n} from '@/src/ui/i18n'
import SegmentedControl from './components/SegmentedControl.vue'
import UiIcon from '@/src/ui/components/UiIcon.vue'
import {config, configReady, subscribeConfig} from '@/src/services/config/store'
import {browserCapabilities} from '@/src/platform/browser/capabilities'

const emit = defineEmits<{navigate: [section: string]; reload: [tab: string]}>()
const {t} = useUiI18n()
const props = defineProps<{initialTab?: string; isVisible?: () => boolean}>()
const keptAliveVisible = ref(true)
const viewActive = computed(() => (props.isVisible?.() ?? true) && keptAliveVisible.value)
function isPanelVisible(): boolean {return viewActive.value}
onActivated(() => {keptAliveVisible.value = true})
onDeactivated(() => {keptAliveVisible.value = false})
const materialWorkspaceAvailable = browserCapabilities.browser !== 'userscript'
function resolveTab(tab?: string): string | undefined {
  if (tab === 'materials' && !materialWorkspaceAvailable) return 'saved'
  return tab && ['saved', 'materials', 'history', 'memory'].includes(tab) ? tab : undefined
}
const activeTab = ref(resolveTab(props.initialTab) ?? 'saved')
watch(() => props.initialTab, tab => { const nextTab = resolveTab(tab); if (nextTab) activeTab.value = nextTab })
const PanelLoading = () => h('p', {class: 'fr-learning-load', role: 'status'}, t('common.loading'))
const PanelLoadError = () => h('div', {class: 'fr-learning-load', role: 'alert'}, [
  h('p', t('learning.panelLoadError')),
  h('button', {type: 'button', onClick: () => emit('reload', activeTab.value)}, t('learning.reloadPage')),
])
const HarnessReadingHistory = defineAsyncComponent({
  loader: () => import('@/src/features/reading-assistant/ui/public').then(module => module.HarnessReadingHistory),
  loadingComponent: PanelLoading,
  errorComponent: PanelLoadError,
})
const MaterialWorkspace = defineAsyncComponent({
  loader: () => import('@/src/features/vocabulary/ui/public').then(module => module.MaterialWorkspace),
  loadingComponent: PanelLoading,
  errorComponent: PanelLoadError,
})
const LearningMemoryManager = defineAsyncComponent({
  loader: () => import('./LearningMemoryManager.vue'),
  loadingComponent: PanelLoading,
  errorComponent: PanelLoadError,
})
const memoryEnabled = ref(config.harness.memoryEnabled)
let mounted = true
const unsubscribe = subscribeConfig(nextConfig => { memoryEnabled.value = nextConfig.harness.memoryEnabled })
void configReady.then(() => { if (mounted) memoryEnabled.value = config.harness.memoryEnabled }).catch(() => undefined)
onBeforeUnmount(() => { mounted = false; unsubscribe() })
const tabs = computed(() => [
  {value: 'saved', label: t('learning.saved')},
  ...(materialWorkspaceAvailable ? [{value: 'materials', label: '阅读材料'}] : []),
  {value: 'history', label: t('learning.history')},
  {value: 'memory', label: t('learning.memory')},
])
</script>
<style scoped>
.fr-learning-center { width:min(100%,1080px); margin-inline:auto; color:var(--ink); }
.fr-learning-center-header { margin-bottom:18px; border-bottom:1px solid var(--line); }
.fr-learning-center-header :deep(.segmented-control) { width:fit-content; max-width:100%; padding:0; border:0; border-radius:0; background:transparent; gap:26px; }
.fr-learning-center-header :deep(.segmented-control button) { min-height:44px; padding:8px 1px 12px; border-radius:0; border-bottom:2px solid transparent; font-size:13px; font-weight:500; }
.fr-learning-center-header :deep(.segmented-control button.active) { border-bottom-color:var(--brand); background:transparent; box-shadow:none; font-weight:650; }
.fr-learning-center-purpose { margin:0 0 20px; color:var(--muted); font-size:12px; line-height:1.7; }
.fr-learning-center :deep(.fr-learning-load) { padding:16px; color:var(--muted); font-size:12px; line-height:1.7; }
.fr-learning-center :deep(.fr-learning-load p) { margin:0; }
.fr-learning-center :deep(.fr-learning-load button) { margin-top:12px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--brand-strong); font:inherit; cursor:pointer; }
.fr-learning-center :deep(.fr-learning-load button:focus-visible) { outline:2px solid var(--brand); outline-offset:3px; }
.fr-learning-local { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-top:24px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
.fr-learning-local button { flex:none; padding:3px 0; border:0; background:transparent; color:var(--muted); font:inherit; cursor:pointer; }
.fr-learning-local button:hover { color:var(--brand-strong); }
.fr-learning-center .fr-learning-local .fr-learning-storage > summary { display:flex; align-items:center; gap:6px; min-height:22px; margin:0; padding:0; border:0; border-radius:0; color:var(--muted); background:transparent; font:inherit; font-weight:400; cursor:pointer; list-style:none; }
.fr-learning-center .fr-learning-local .fr-learning-storage > summary::after { display:none; content:none; }
.fr-learning-storage summary::-webkit-details-marker { display:none; }
.fr-learning-storage p { margin:8px 0 0; font-size:11px; line-height:1.8; }
.fr-learning-local button:focus-visible,.fr-learning-storage summary:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
@media (max-width:600px) {
  .fr-learning-center-header :deep(.segmented-control) { width:100%; gap:12px; flex-wrap:wrap; }
  .fr-learning-center-header :deep(.segmented-control button) { font-size:12px; }
}
</style>
