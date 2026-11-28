<!--
 * @file src/features/settings/ui/components/FieldHelp.vue
 * 文件职责：在设置标签旁提供可悬停和键盘聚焦的辅助说明，避免说明占据表单主空间。
 * 主要内容：统一信息图标、提示延迟、可配置弹出方向（默认 top）、焦点轮廓及富文本提示插槽；鼠标离开后延迟关闭，移入提示可继续停留并选择复制文字，支持提示中的外部说明链接；Shadow Root 中的提示保留在原根内，避免宿主页面样式影响。
 * 模块边界：只负责展示调用方提供的已本地化说明，不保存配置、不执行表单动作或网络请求。
 -->
<template>
  <el-tooltip ref="tooltip" :content="content" :teleported="teleported" trigger="hover" :show-after="200" :hide-after="600" :enterable="true" :placement="placement" popper-class="fluentread-field-help-popper" @hide="contentHovered = false">
    <template #content><div @mouseenter="contentHovered = true" @mouseleave="contentHovered = false"><slot name="content">{{ content }}</slot></div></template>
    <button ref="trigger" type="button" class="field-help" :class="buttonClass" :aria-label="label || content" @focus="openFromFocus" @blur="!contentHovered && tooltip?.onClose()" @keydown.esc.stop="tooltip?.hide()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>
    </button>
  </el-tooltip>
</template>
<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {ElTooltip, type TooltipInstance} from 'element-plus'
withDefaults(defineProps<{
  content: string
  label?: string
  buttonClass?: string
  placement?: 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left' | 'right'
}>(), {placement: 'top'})
const trigger = ref<HTMLButtonElement | null>(null)
const teleported = ref(false)
onMounted(() => { teleported.value = !(trigger.value?.getRootNode() instanceof ShadowRoot) })
// Element Plus 仅在单一 hover 触发下处理提示内容的移入；键盘焦点复用其延迟控制。
const tooltip = ref<TooltipInstance>()
const contentHovered = ref(false)
function openFromFocus(event: FocusEvent): void {
  // 内容可能已卸载，直接检查焦点来源；关闭后返还按钮的焦点不应再次打开提示。
  if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.fluentread-field-help-popper')) return
  tooltip.value?.onOpen(event)
}
</script>
<style scoped>
.field-help { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; color: var(--muted); background: transparent; cursor: help; vertical-align: middle; }
.field-help:hover, .field-help:focus-visible { color: var(--brand-strong); background: var(--brand-soft); }
.field-help:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
:global(.fluentread-field-help-popper) { max-width: min(360px, calc(100vw - 32px)); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; user-select: text; cursor: text; }
</style>
