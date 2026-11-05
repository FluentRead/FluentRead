<!--
 * @file src/features/settings/ui/services/ServiceCatalogItem.vue
 * 文件职责：为完整服务目录渲染紧凑的服务选择行。
 * 主要内容：本地图标、可换行的完整服务名称及提示、接口性质与状态标签、可访问的选中状态，以及独立的服务启用开关；默认优先于已保存和常用，窄屏继续展示标签；目录短名称行保留 44px 命中高度，长名称自然增高。
 * 模块边界：只发出服务选择与启用状态事件，不直接修改配置、不测试连接、不发起翻译。
 -->
<template>
  <div class="library-item" :class="{ active: selected, compact, 'is-availability-disabled': !availabilityEnabled }">
    <button type="button" class="library-select" :data-service-value="item.value"
      :aria-pressed="selected" :title="item.label" @click="$emit('select', item.value)">
      <ServiceIcon :service="item.value" :label="item.label" size="medium" />
      <span class="library-copy">
        <span class="library-name">
          <strong>{{ item.label }}</strong>
          <span class="library-metadata">
            <ServiceNatureBadge :service="item.value" />
            <span v-if="isDefault" class="service-badge service-badge--default library-default" :title="t('settings.services.library.defaultBadge')">{{ t('settings.services.library.defaultBadge') }}</span>
            <span v-else-if="isConfigured" class="service-badge library-configured" :title="t('settings.services.library.saved')">{{ t('settings.services.library.saved') }}</span>
            <span v-else-if="isFavorite" class="service-badge library-common" :title="t('settings.services.library.favorites')">{{ t('settings.services.library.favorites') }}</span>
          </span>
        </span>
        <small v-if="!compact && status">{{ status }}</small>
      </span>
    </button>
    <el-tooltip class="availability-toggle" :content="t(availabilityToggleDisabled && availabilityEnabled ? 'settings.services.library.keepOne' : 'settings.services.library.availabilityHelp')" placement="top">
      <el-switch
        :model-value="availabilityEnabled"
        :disabled="availabilityToggleDisabled"
        :aria-label="t(availabilityEnabled ? 'settings.services.library.disableService' : 'settings.services.library.enableService', {service: translateLegacy(item.label)})"
        :data-service-availability="item.value"
        :onUpdate:modelValue="onAvailabilityToggle.bind(null, item.value)"
      />
    </el-tooltip>
  </div>
</template>
<script setup lang="ts">
import './service-badges.css'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import { useUiI18n } from '@/src/ui/i18n'
import type { ServiceOption } from '@/src/ui/view-model/serviceCatalog'
withDefaults(defineProps<{ item: ServiceOption; selected: boolean; isDefault: boolean; isConfigured?: boolean; isFavorite?: boolean; compact?: boolean; status?: string; availabilityEnabled?: boolean; availabilityToggleDisabled?: boolean }>(), {availabilityEnabled: true, availabilityToggleDisabled: false})
const emit = defineEmits<{ select: [service: string]; 'toggle-availability': [service: string, enabled: boolean] }>()
const { t, translateLegacy } = useUiI18n()
function onAvailabilityToggle(service: string, enabled: boolean): void {emit('toggle-availability', service, enabled)}
</script>
<style scoped>
.library-item { display: flex; align-items: center; min-width: 0; border: 1px solid transparent; border-radius: 12px; background: transparent; }
.library-item:hover { border-color: var(--line, #e4e7ef); background: var(--surface-soft, #f7f8fb); }
.library-item.active { border-color: var(--brand-border, #f3c4d1); background: var(--brand-soft); box-shadow: 0 4px 12px color-mix(in srgb, var(--brand) 5%, transparent); }
.library-item.is-availability-disabled .library-select { opacity: .68; }
.library-select { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; min-height: 64px; padding: 10px 8px 10px 12px; border: 0; background: transparent; color: var(--ink, #172033); text-align: left; cursor: pointer; border-radius: 8px; }
.availability-toggle { display: flex; flex: none; align-items: center; margin: 0 7px 0 3px; }
.library-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.library-name { display: flex; align-items: flex-start; flex-wrap: nowrap; gap: 6px; min-width: 0; }
.library-copy strong { min-width: 0; flex: 0 1 auto; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; font-size: 13px; font-weight: 600; }
.library-copy small { color: var(--muted, #737c8f); font-size: 11px; }
.library-metadata { display: flex; align-items: center; flex: none; flex-wrap: nowrap; gap: 4px; min-width: 0; max-width: calc(100% - 64px); }
.library-metadata:empty { display: none; }
.compact { border-color: transparent; background: transparent; }
.compact .library-select { min-height: 44px; padding: 6px 4px 6px 8px; gap: 8px; }
.compact :deep(.service-brand-icon) { width: 28px; height: 28px; border-radius: 8px; }
button:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }

@media (min-width: 701px) and (max-width: 1100px) { .compact .library-select { padding-inline: 4px; } }
@media (max-width: 700px) { .compact .library-select { padding: 6px; gap: 7px; } }
</style>
