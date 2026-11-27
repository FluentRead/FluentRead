<!--
@file src/features/settings/ui/ContextMenuSettings.vue
文件职责：提供右键菜单的精简设置界面，总开关关闭时收起子项，开启后直接以紧凑网格增删各菜单入口。
主要内容：标题栏集成总开关并绑定活跃配置、功能能力和当时偏好，拒绝迟到或非法写入；去除静态模拟预览以保持页面清爽聚焦。
模块边界：本组件只编辑父级响应式配置，保存与跨页面同步复用父级设置流程，不创建原生菜单、不发送运行时消息；入口目录来自 core/context-menu，实际右键时的场景筛选、创建与点击路由由 app/background 负责。
-->
<template>
  <SettingsGroup class="context-menu-settings" :title="t('contextMenuSettings.title')" :description="t('contextMenuSettings.description')">
    <template #heading-extra>
      <el-switch
        :model-value="config.contextMenuEnabled"
        :onUpdate:modelValue="masterChange"
        :disabled="!active"
        class="settings-toggle"
        :aria-label="t('contextMenuSettings.master')"
      />
    </template>

    <template v-if="config.contextMenuEnabled">
      <SettingsItem
        v-for="entry in entryRows"
        :key="entry.id"
        class="context-menu-entry"
        :data-context-menu-entry="entry.id"
        :label="entry.label"
        :description="entry.description"
        :disabled="!active || !config.contextMenuEnabled || !entry.available"
      >
        <el-switch
          :model-value="entry.enabled"
          class="settings-toggle"
          :aria-label="entry.label"
          :disabled="!active || !config.contextMenuEnabled || !entry.available"
          :onUpdate:modelValue="entry.update"
        />
      </SettingsItem>
    </template>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import {
  CONTEXT_MENU_ENTRIES,
  type ContextMenuActionId,
} from '@/src/core/context-menu/domain';
import { browserCapabilities } from '@/src/platform/browser/capabilities';
import type { Config } from '@/src/core/config/model';
import { useUiI18n } from '@/src/ui/i18n';

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {active, capture} = useSettingsActionContext(() => props.active, () => [props.config, props.config.contextMenuEnabled, props.config.selectionTranslatorMode, props.config.disableSelectionTranslator, props.config.selectionAreaEnabled, props.config.disableImageTranslator, browserCapabilities.imageTranslation, browserCapabilities.areaTranslation]);
const masterChange = computed(() => {const current = capture();return (value: unknown) => {if (current() && typeof value === 'boolean') props.config.contextMenuEnabled = value};});
const config = computed(() => props.config);
const { t } = useUiI18n();

const ENTRY_COPY: Readonly<Record<ContextMenuActionId, {label: string; description: string; unavailable: string}>> = {
  translateSelection: {label: 'contextMenu.translateSelection', description: 'contextMenuSettings.selectionDescription', unavailable: 'contextMenuSettings.selectionUnavailable'},
  translatePage: {label: 'contextMenu.translatePage', description: 'contextMenuSettings.pageDescription', unavailable: ''},
  translateImage: {label: 'contextMenu.translateImage', description: 'contextMenuSettings.imageDescription', unavailable: 'contextMenuSettings.imageUnavailable'},
  translateArea: {label: 'contextMenu.translateArea', description: 'contextMenuSettings.areaDescription', unavailable: 'contextMenuSettings.areaUnavailable'},
  toggleSite: {label: 'contextMenuSettings.siteToggle', description: 'contextMenuSettings.siteToggleDescription', unavailable: ''},
};

function isAvailable(id: ContextMenuActionId): boolean {
  if (id === 'translateSelection') return config.value.selectionTranslatorMode !== 'disabled' && config.value.disableSelectionTranslator !== true;
  if (id === 'translateArea') return browserCapabilities.areaTranslation && config.value.selectionAreaEnabled === true;
  if (id === 'translateImage') return browserCapabilities.imageTranslation && config.value.disableImageTranslator !== true;
  return true;
}

function readEntryPreference(id: ContextMenuActionId, defaultEnabled: boolean): boolean {
  if (id === 'translateImage') return config.value.imageTranslationContextMenuEnabled !== false;
  return config.value.contextMenuEntries?.[id] ?? defaultEnabled;
}

function writeEntryPreference(id: ContextMenuActionId, value: unknown): void {
  if (!active.value || !config.value.contextMenuEnabled || typeof value !== 'boolean' || !CONTEXT_MENU_ENTRIES.some(entry => entry.id === id) || !isAvailable(id)) return;
  if (id === 'translateImage') {
    config.value.imageTranslationContextMenuEnabled = value;
    return;
  }
  config.value.contextMenuEntries = {...config.value.contextMenuEntries, [id]: value};
}

const entryRows = computed(() => CONTEXT_MENU_ENTRIES.map((entry) => {
  const current = capture();
  const available = isAvailable(entry.id);
  const copy = ENTRY_COPY[entry.id];
  const description = t(copy.description);
  const enabled = readEntryPreference(entry.id, entry.defaultEnabled);
  return {
    id: entry.id,
    label: t(copy.label),
    available,
    enabled,
    description: available ? description : t('contextMenuSettings.withReason', {description, reason: t(copy.unavailable)}),
    update: (value: unknown) => {if (current() && readEntryPreference(entry.id, entry.defaultEnabled) === enabled) writeEntryPreference(entry.id, value)},
  };
}));
</script>

<style scoped>
.context-menu-settings { min-width: 0; }
</style>
