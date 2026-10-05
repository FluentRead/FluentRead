<!--
 * @file src/features/settings/ui/services/ServiceCatalogItem.vue
 * 文件职责：为完整服务目录渲染紧凑的服务选择行。
 * 主要内容：本地图标、可换行的完整服务名称及提示、接口性质徽章、默认标记、可访问的选中状态。
 * 模块边界：只发出选择事件，不修改配置、不测试连接、不发起翻译。
 -->
<template>
  <div class="library-item" :class="{ active: selected, compact }">
    <button type="button" class="library-select" :data-service-value="item.value"
      :aria-pressed="selected" :title="item.label" @click="$emit('select', item.value)">
      <ServiceIcon :service="item.value" :label="item.label" size="medium" />
      <span class="library-copy"><span class="library-name"><strong>{{ item.label }}</strong><ServiceNatureBadge :service="item.value" /></span><small v-if="!compact && status">{{ status }}</small></span>
      <span class="library-statuses">
        <span v-if="isDefault" class="library-default">{{ t('settings.services.library.defaultBadge') }}</span>
        <span v-else-if="isConfigured" class="library-configured">{{ t('settings.services.library.saved') }}</span>
        <span v-else-if="isFavorite" class="library-common">{{ t('settings.services.library.favorites') }}</span>
      </span>
    </button>

  </div>
</template>
<script setup lang="ts">
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import { useUiI18n } from '@/src/ui/i18n'
import type { ServiceOption } from '@/src/ui/view-model/serviceCatalog'
defineProps<{ item: ServiceOption; selected: boolean; isDefault: boolean; isConfigured?: boolean; isFavorite?: boolean; compact?: boolean; status?: string }>()
defineEmits<{ select: [service: string] }>()
const { t } = useUiI18n()
</script>
<style scoped>
.library-item { display: flex; align-items: center; min-width: 0; border: 1px solid transparent; border-radius: 12px; background: transparent; }
.library-item:hover { border-color: var(--line, #e4e7ef); background: var(--surface-soft, #f7f8fb); }
.library-item.active { border-color: var(--brand-border, #f3c4d1); background: var(--brand-soft); box-shadow: 0 4px 12px color-mix(in srgb, var(--brand) 5%, transparent); }
.library-select { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; min-height: 64px; padding: 10px 8px 10px 12px; border: 0; background: transparent; color: var(--ink, #172033); text-align: left; cursor: pointer; border-radius: 8px; }
.library-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.library-name { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 6px; min-width: 0; }
.library-copy strong { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; font-size: 13px; font-weight: 600; }
.library-copy small { margin-top: 3px; color: var(--muted, #737c8f); font-size: 11px; }
.library-statuses { display: inline-flex; align-items: center; gap: 4px; max-width: 34%; flex-wrap: wrap; flex-shrink: 0; }
.library-default, .library-configured, .library-common { font-size: 10px; white-space: normal; overflow-wrap: anywhere; }
.library-default { color: var(--brand-strong, #bd2853); }
.library-configured { color: var(--muted, #737c8f); }
.library-common { color: #a76b1b; }
.compact { border-color: transparent; background: transparent; }
.compact .library-select { min-height: 60px; padding: 9px 8px; gap: 10px; }
button:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }

@media (max-width: 700px) { .compact .library-select { min-height: 52px; padding: 7px 6px; gap: 7px; } .library-statuses { display: none; } }
</style>
