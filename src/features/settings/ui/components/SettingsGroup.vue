<!--
@file src/features/settings/ui/components/SettingsGroup.vue
文件职责：建立设置页面的二级分组容器，用清晰的标题、说明和单层细边框区分相关配置而不重复页面级介绍。
主要内容：通过共用卡片 token 统一圆角、细边框、轻阴影与留白，标题和说明构成纵向文案区，右侧保留辅助操作插槽；分组使用中性色层级，品牌色留给选择和主操作，组内设置行保持分隔与窄屏对齐。
模块边界：本组件是无业务状态的布局壳，不解释配置、不读写 store，也不决定导航分类；具体字段及控件由调用页面和 SettingsItem 提供。
-->
<template>
  <section class="settings-group">
    <header v-if="title || description || $slots['heading-extra']" class="settings-group-heading settings-card-heading">
      <div v-if="title || description" class="settings-card-heading-copy">
        <h2 v-if="title">{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
      <slot name="heading-extra" />
    </header>
    <div class="settings-group-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import './settings-card-heading.css'
defineProps<{
  title?: string
  description?: string
}>()
</script>

<style scoped>
.settings-group {
  box-sizing: border-box;
  width: min(100%, 1080px);
  min-width: 0;
  margin: 0 auto var(--fr-card-gap, 20px);
  border: var(--fr-card-outline, 1px solid var(--line));
  border-radius: var(--fr-card-radius, 14px);
  background: var(--fr-card-background, var(--surface));
  box-shadow: var(--fr-card-shadow, none);
}

.settings-group-heading {
  margin: 0;
  padding: var(--fr-card-heading-padding-block, 16px) var(--fr-card-padding-inline, 20px);
  border-bottom: 1px solid var(--fr-card-border, var(--line));
  border-radius: calc(var(--fr-card-radius, 14px) - 1px) calc(var(--fr-card-radius, 14px) - 1px) 0 0;
}

.settings-group-body {
  overflow: clip;
  border-radius: calc(var(--fr-card-radius, 14px) - 1px);
  background: transparent;
}

.settings-group-heading + .settings-group-body {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.settings-group-body :deep(.el-row) {
  min-height: 60px !important;
  margin: 0 !important;
  padding: var(--fr-settings-row-padding-block, 14px) var(--fr-card-padding-inline, 20px) !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.settings-group-body :deep(:is(.settings-item, .el-row) + :is(.settings-item, .el-row)) {
  border-top: 1px solid var(--fr-card-border, var(--line)) !important;
}

.settings-group-body :deep(.el-row:hover) {
  background: transparent !important;
  transform: none !important;
}

</style>
