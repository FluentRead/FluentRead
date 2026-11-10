<!--
@file src/features/settings/ui/components/SidepanelScopeSetting.vue
文件职责：在支持的扩展设置页提供原生翻译侧边栏的显示范围选择。
主要内容：用紧凑分段控件在当前标签页和整个窗口之间切换，并说明新范围的生效时机。
模块边界：只更新当前设置草稿，由设置页统一保存；浏览器能力判断和原生打开在组件外完成。
-->
<template>
  <SettingsItem
    :label="t('sidepanel.scope.label')"
    :description="t('sidepanel.scope.description')"
  >
    <SegmentedControl
      :model-value="props.config.translationSidepanelScope"
      :options="options"
      :label="t('sidepanel.scope.label')"
      :disabled="!props.active"
      compact
      @update:model-value="selectScope"
    />
  </SettingsItem>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import type {Config} from '@/src/core/config/model'
import {useUiI18n} from '@/src/ui/i18n'
import SegmentedControl from './SegmentedControl.vue'
import SettingsItem from './SettingsItem.vue'

const props = defineProps<{config: Pick<Config, 'translationSidepanelScope'>; active: boolean}>()
const {t} = useUiI18n()
const options = computed(() => [
  {value: 'tab', label: t('sidepanel.scope.tab')},
  {value: 'window', label: t('sidepanel.scope.window')},
])

function selectScope(scope: string | number) {
  if (props.active && (scope === 'tab' || scope === 'window')) props.config.translationSidepanelScope = scope
}
</script>
