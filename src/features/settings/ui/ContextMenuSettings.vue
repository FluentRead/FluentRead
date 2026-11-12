<!--
@file src/features/settings/ui/ContextMenuSettings.vue
文件职责：提供右键菜单的设置界面，让用户按使用习惯增删菜单入口，并在同一屏看到已启用的菜单项。
主要内容：总开关与入口事件绑定活跃配置、功能能力和当时偏好，拒绝迟到或非法写入；左侧预览可用操作，右侧网格编辑各入口，窄屏上下排列。
模块边界：本组件只编辑父级响应式配置并展示入口总览，保存与跨页面同步复用父级设置流程，不创建原生菜单、不发送运行时消息；入口目录来自 core/context-menu，实际右键时的场景筛选、创建与点击路由由 app/background 负责。
-->
<template>
  <SettingsGroup class="context-menu-settings" :title="t('contextMenuSettings.title')" :description="t('contextMenuSettings.description')">
    <SettingsItem :label="t('contextMenuSettings.master')" :description="t('contextMenuSettings.masterDescription')">
      <el-switch :model-value="config.contextMenuEnabled" :onUpdate:modelValue="masterChange" :disabled="!active" class="settings-toggle" :aria-label="t('contextMenuSettings.master')" />
    </SettingsItem>

    <div class="context-menu-workspace">
      <section class="context-menu-preview" data-testid="context-menu-preview" :aria-label="t('contextMenuSettings.preview')">
        <div class="context-menu-preview-heading">
          <h3>{{ t('contextMenuSettings.preview') }}</h3>
          <p>{{ t('contextMenuSettings.previewDescription') }}</p>
        </div>
        <div class="context-menu-preview-menu" aria-live="polite">
          <ul v-if="previewEntries.length" class="context-menu-preview-list">
            <li v-for="item in previewEntries" :key="item.id" :data-context-menu-action="item.id" :class="{'is-site-action': item.id === 'toggleSite'}">
              <img class="brand-icon" :src="iconUrl" width="16" height="16" alt="" aria-hidden="true" />
              <span>{{ item.title }}</span>
            </li>
          </ul>
          <p v-else class="context-menu-preview-empty" role="status">{{ t('contextMenuSettings.sceneEmpty') }}</p>
        </div>
      </section>
      <div class="context-menu-entry-grid">
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
      </div>
    </div>
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
const iconUrl = globalThis.__FLUENTREAD_ICON_DATA__ || '/icon/16.png';

// 每个入口先说明“什么时候会看到它”，再说明它做什么；不可用时补上前置条件，避免只能靠猜。
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
  // 图片入口与图片翻译设置共用同一个开关，避免同一件事出现两个互相矛盾的选项。
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

// 设置预览汇总所有已开启的入口，实际网页右键时再由后台按对象筛选。
const previewEntries = computed(() => config.value.contextMenuEnabled === false ? [] : entryRows.value
  .filter(entry => entry.enabled && entry.available)
  .map(entry => ({id: entry.id, title: entry.id === 'toggleSite' ? t('contextMenu.disableSite') : entry.label})));
</script>

<style scoped>
.context-menu-workspace {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(0, 1.4fr);
  align-items: start;
  gap: 20px;
  padding: 16px 20px 20px;
  border-top: 1px solid var(--line);
  container-type: inline-size;
}
.context-menu-preview { display: grid; gap: 12px; min-width: 0; }
.context-menu-preview-heading h3 { margin: 0 0 4px; color: var(--ink); font-size: 13px; font-weight: 600; }
.context-menu-preview-heading p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.context-menu-preview-menu {
  width: min(100%, 300px);
  box-sizing: border-box;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px -12px rgba(15, 23, 42, .3);
}
.context-menu-preview-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.context-menu-preview-list li {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.4;
}
.context-menu-preview-list img { flex: none; }
.context-menu-preview-list li span { min-width: 0; overflow-wrap: anywhere; }
.context-menu-preview-list li + .is-site-action { margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--line); }
.context-menu-preview-empty {
  margin: 0;
  padding: 10px;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.55;
}
.context-menu-entry-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.context-menu-entry { grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; min-height: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.context-menu-entry :deep(.settings-item-copy small) { font-size: 11px; }
@container (max-width: 760px) {
  .context-menu-entry-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 850px) {
  .context-menu-workspace { grid-template-columns: minmax(0, 1fr); }
  .context-menu-entry-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .context-menu-workspace { padding: 12px; gap: 16px; }
}
@media (max-width: 480px) {
  .context-menu-entry-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
