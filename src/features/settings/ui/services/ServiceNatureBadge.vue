<!--
 * @file src/features/settings/ui/services/ServiceNatureBadge.vue
 * 文件职责：在服务名称旁展示接口性质徽章。
 * 主要内容：为 DeepLX 提供本地化的免费非官方标记，供目录、详情标题和免费服务卡片共用。
 * 模块边界：仅展示已知服务的性质，不判断连接状态、费用或修改配置。
 -->
<template>
  <span v-if="service === 'deeplx'" class="service-nature-badge" :data-service-nature-badge="service">{{ t('settings.services.library.freeUnofficial') }}</span>
</template>
<script setup lang="ts">
import { useUiI18n } from '@/src/ui/i18n'
defineProps<{ service: string }>()
const { t } = useUiI18n()
</script>
<style scoped>
.service-nature-badge { display: inline-flex; flex: none; align-items: center; padding: 1px 5px; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 10px; font-weight: 500; line-height: 16px; white-space: nowrap; }
</style>
