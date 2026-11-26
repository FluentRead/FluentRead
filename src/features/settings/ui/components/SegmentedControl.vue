<!--
@file src/features/settings/ui/components/SegmentedControl.vue
文件职责：为少量互斥设置提供紧凑且可访问的分段选择控件，替代难以快速比较的普通下拉框。
主要内容：以 radiogroup 语义渲染选项，支持完整多语言标签自然换行、禁用状态、双向绑定以及方向键、Home、End 的循环键盘导航和焦点同步；compact 模式把整体高度收到与输入框一致，供表单行内使用；合并键盘焦点帧，仅为仍有效的选值和原焦点归属同步焦点，并在停用、卸载或缓存去激活时清理。
模块边界：本组件只接收通用标签和值并发出选择事件，不包含任何 FluentRead 配置字段含义，也不负责保存配置或展示页面说明。
-->
<template>
  <div ref="groupElement" class="segmented-control" :class="{ compact }" role="radiogroup" :aria-label="label" :aria-disabled="disabled">
    <button
      v-for="(option, index) in options"
      :key="String(option.value)"
      type="button"
      role="radio"
      :data-option-index="index"
      :aria-checked="modelValue === option.value"
      :tabindex="modelValue === option.value && !disabled && !option.disabled ? 0 : -1"
      :class="{ active: modelValue === option.value }"
      :disabled="disabled || option.disabled"
      @click="cancelPendingFocus(); $emit('update:modelValue', option.value)"
      @keydown="handleKeydown($event, index)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onDeactivated, ref, watch} from 'vue'

export type SegmentedOption = {
  label: string
  value: string | number
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string | number
  options: SegmentedOption[]
  label: string
  disabled?: boolean
  compact?: boolean
}>(), {
  disabled: false,
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

const groupElement = ref<HTMLElement | null>(null)
let pendingFocus: number | null = null

function cancelPendingFocus() {
  if (pendingFocus === null) return
  cancelAnimationFrame(pendingFocus)
  pendingFocus = null
}

watch(() => props.disabled, (disabled) => {
  if (disabled) cancelPendingFocus()
}, {flush: 'sync'})
onBeforeUnmount(cancelPendingFocus)
onDeactivated(cancelPendingFocus)

function handleKeydown(event: KeyboardEvent, currentIndex: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  cancelPendingFocus()
  const enabledIndexes = props.options
    .map((option, index) => (!props.disabled && !option.disabled ? index : -1))
    .filter(index => index >= 0)
  if (!enabledIndexes.length) return

  event.preventDefault()
  const position = Math.max(0, enabledIndexes.indexOf(currentIndex))
  let nextIndex: number
  if (event.key === 'Home') nextIndex = enabledIndexes[0]
  else if (event.key === 'End') nextIndex = enabledIndexes.at(-1)!
  else {
    const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    nextIndex = enabledIndexes[(position + offset + enabledIndexes.length) % enabledIndexes.length]
  }
  const value = props.options[nextIndex].value
  const group = groupElement.value!
  const focusRoot = group.getRootNode() as Document | ShadowRoot
  const origin = event.currentTarget
  // 原生键盘监听已挂在固定 group 的按钮上；按值重查，避免父级重排后复用旧 index。
  pendingFocus = requestAnimationFrame(() => {
    pendingFocus = null
    if (!group.isConnected || focusRoot.activeElement !== origin || props.modelValue !== value) return
    const liveIndex = props.options.findIndex(option => option.value === value && !option.disabled)
    if (liveIndex < 0) return
    group.querySelector<HTMLButtonElement>(`button[data-option-index="${liveIndex}"]`)?.focus()
  })
  // 先登记待清理帧，再发出选择，使同步父级卸载也能取消它。
  emit('update:modelValue', value)
}
</script>

<style scoped>
.segmented-control {
  display: grid;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  width: 100%;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-md, 10px);
  background: var(--surface-soft);
}

.segmented-control button {
  min-width: 0;
  min-height: 34px;
  padding: 6px 10px;
  overflow: visible;
  border: 0;
  border-radius: var(--fr-radius-xs, 6px);
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  font-size: var(--fr-text-sm, 12px);
  font-weight: 500;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.4;
  transition: color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), box-shadow var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}

.segmented-control.compact { padding: 3px; border-radius: var(--fr-control-radius, 8px); }
.segmented-control.compact button { min-height: 30px; padding: 4px 12px; border-radius: var(--fr-radius-xs, 6px); font-size: var(--fr-text-sm, 12px); font-weight: 500; }

.segmented-control button:hover:not(:disabled) { color: var(--ink); }
.segmented-control button.active {
  color: var(--brand-strong);
  background: var(--surface);
  font-weight: 600;
  box-shadow: var(--fr-shadow-xs, 0 1px 2px rgba(22, 27, 38, .06));
}
.segmented-control button:disabled { cursor: not-allowed; opacity: .55; }
.segmented-control button:focus-visible { outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong)); outline-offset: 1px; }
</style>
