<!--
@file src/features/settings/ui/components/ToolbarClickSetting.vue
文件职责：在通用设置中提供浏览器工具栏的一键翻译选择。
主要内容：使用紧凑分段控件切换打开快捷面板或翻译／恢复，说明右键图标仍可打开面板。
模块边界：只修改当前设置草稿；保存和原生工具栏同步由配置服务与后台运行时完成，用户脚本不挂载此设置。
-->
<template>
  <SettingsItem :label="t('toolbar.click.label')" :description="t('toolbar.click.description')">
    <SegmentedControl
      v-model="props.config.toolbarClickAction"
      :options="options"
      :label="t('toolbar.click.label')"
      compact
    />
  </SettingsItem>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import type {Config} from '@/src/core/config/model';
import {useUiI18n} from '@/src/ui/i18n';
import SegmentedControl from './SegmentedControl.vue';
import SettingsItem from './SettingsItem.vue';

const props = defineProps<{config: Pick<Config, 'toolbarClickAction'>}>();
const {t} = useUiI18n();
const options = computed(() => [
  {value: 'popup', label: t('toolbar.click.popup')},
  {value: 'translate', label: t('toolbar.click.translate')},
]);
</script>
