<!--
 @file src/features/settings/ui/components/SettingsPreviewLayout.vue
 文件职责：统一设置页的效果预览与选择区，让桌面左侧展示结果、右侧调整偏好。
 主要内容：提供带示例说明的预览插槽与设置插槽，桌面使用等宽等高列和主题变量，可让自然尺寸的预览内容随设置滚动保持可见；窄屏按预览、设置顺序纵向排列并保持自然高度。
 模块边界：只负责布局，不读取配置、不生成示例、不调用翻译或学习服务。
-->
<template>
  <div class="settings-preview-layout">
    <section class="settings-preview-example" :class="{'sticky-preview': stickyPreview}" :aria-label="label">
      <div class="settings-preview-content">
        <div class="settings-preview-caption"><strong>效果预览</strong></div>
        <slot name="preview" />
      </div>
    </section>
    <div class="settings-preview-controls"><slot /></div>
  </div>
</template>
<script setup lang="ts">
defineProps<{label: string; stickyPreview?: boolean}>()
</script>
<style scoped>
.settings-preview-layout { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:stretch; gap:24px; padding:20px; }
.settings-preview-example { min-width:0; padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--surface-soft); color:var(--ink); }
.settings-preview-content { min-width:0; }
.settings-preview-example.sticky-preview { padding:0; border:0; background:transparent; }
.sticky-preview .settings-preview-content { position:sticky; top:18px; padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--surface-soft); }
.settings-preview-caption { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px 12px; margin-bottom:16px; color:var(--muted); }
.settings-preview-caption strong { font-size:12px; font-weight:550; }
.settings-preview-caption small { font-size:11px; }
.settings-preview-controls { min-width:0; }
@media(max-width:850px) { .settings-preview-layout { grid-template-columns:minmax(0,1fr); padding:16px; gap:18px; } .sticky-preview .settings-preview-content { position:static; } }
@media(max-width:480px) { .settings-preview-layout { padding:12px; } .settings-preview-example { padding:14px; } .sticky-preview .settings-preview-content { padding:14px; } }
</style>
