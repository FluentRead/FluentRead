<!--
 * @file src/features/settings/ui/services/ServiceCatalogItem.vue
 * 文件职责：为完整服务目录渲染紧凑的服务选择行。
 * 主要内容：本地图标、可换行的完整服务名称、接口性质与状态标签、可访问的选中状态，以及无悬浮气泡的移除按钮；目录短名称行保留 44px 命中高度，长名称自然增高。
 * 模块边界：只发出服务选择与移除意图，不直接修改配置、不测试连接、不发起翻译。
 -->
<template>
  <div class="library-item" :class="{ active: selected }">
    <button type="button" class="library-select" :data-service-value="item.value"
      :aria-pressed="selected" :title="item.label" @click="$emit('select', item.value)">
      <ServiceIcon :service="item.value" :label="item.label" size="medium" />
      <span class="library-name">
        <strong>{{ item.label }}</strong>
        <span class="library-metadata">
          <ServiceNatureBadge :service="item.value" />
          <span v-if="item.disabled" class="service-badge library-configured">{{ t('settings.services.chromePreparation.unavailableBadge') }}</span>
          <span v-else-if="isDefault" class="service-badge service-badge--default library-default" :title="t('settings.services.library.defaultBadge')">{{ t('settings.services.library.defaultBadge') }}</span>
          <span v-else-if="isConfigured" class="service-badge library-configured" :title="t('settings.services.library.saved')">{{ t('settings.services.library.saved') }}</span>
          <span v-else-if="isFavorite" class="service-badge library-common" :title="t('settings.services.library.favorites')">{{ t('settings.services.library.favorites') }}</span>
        </span>
      </span>
    </button>
    <button
      type="button"
      class="library-remove"
      :aria-label="t('settings.services.library.removeNamedService', {service: item.label})"
      :disabled="removeDisabled"
      :data-service-remove="item.value"
      @click="$emit('remove', item.value)"
    >
      <UiIcon name="close" :size="16" />
    </button>
  </div>
</template>
<script setup lang="ts">
import './service-badges.css'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import UiIcon from '@/src/ui/components/UiIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import { useUiI18n } from '@/src/ui/i18n'
import type { ServiceOption } from '@/src/ui/view-model/serviceCatalog'
defineProps<{ item: ServiceOption; selected: boolean; isDefault: boolean; isConfigured?: boolean; isFavorite?: boolean; removeDisabled?: boolean }>()
defineEmits<{ select: [service: string]; remove: [service: string] }>()
const { t } = useUiI18n()
</script>
<style scoped>
.library-item { display: flex; align-items: center; min-width: 0; border: 1px solid transparent; border-radius: var(--fr-control-radius, 8px); background: transparent; transition: background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease); }
.library-item:hover { border-color: var(--line, #e3e6ed); background: var(--surface, #fff); }
.library-item.active { border-color: color-mix(in srgb, var(--brand) 36%, var(--line)); background: var(--brand-soft); box-shadow: none; }
.library-select { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; min-height: 44px; padding: 6px 4px 6px 8px; border: 0; background: transparent; color: var(--ink, #161b26); text-align: left; cursor: pointer; border-radius: var(--fr-control-radius, 8px); }
.library-remove { display: grid; flex: none; place-items: center; width: 32px; height: 36px; margin-inline-end: 4px; padding: 0; border: 0; border-radius: var(--fr-radius-xs, 6px); color: var(--muted, #5b6476); opacity: .45; background: transparent; cursor: pointer; transition: opacity var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease); }
.library-item:is(:hover, :focus-within) .library-remove:not(:disabled) { opacity: 1; }
.library-remove:hover:not(:disabled) { color: var(--brand-strong, #d4235a); background: var(--brand-soft); }
.library-remove:disabled { opacity: .25; cursor: default; }
.library-name { display: flex; align-items: center; flex-wrap: wrap; flex: 1; gap: 3px 6px; min-width: 0; }
.library-name strong { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; font-size: 13px; font-weight: 600; }
.library-metadata { display: flex; align-items: center; flex: 0 1 auto; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: 100%; }
.library-metadata:empty { display: none; }
.library-item :deep(.service-brand-icon) { width: 28px; height: 28px; border-radius: 8px; }
button:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }

@media (min-width: 701px) and (max-width: 1100px) { .library-select { padding-inline: 4px; } }
@media (max-width: 700px) { .library-select { padding: 6px; gap: 7px; } }
</style>
