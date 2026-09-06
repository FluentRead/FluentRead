<!--
 * @file src/features/writing-assistant/ui/WritingChoices.vue
 * 文件职责：用统一品牌样式展示写作偏好的互斥选项，让长度、风格、语气和角色可以直接比较。
 * 主要内容：提供换行的圆角选项、选中反馈以及方向键和首尾键导航，支持父级在提交期间禁用交互。
 * 模块边界：只接收值和选项并发出选择事件，不读取配置、不保存偏好，也不会因为一次选中而调用模型。
 -->
<template>
  <div class="writing-choices" role="radiogroup" :aria-label="label">
    <button v-for="(item, index) in options" :key="item.value" type="button" role="radio" :aria-checked="modelValue === item.value" :disabled="disabled" :tabindex="modelValue === item.value || (!options.some(option => option.value === modelValue) && index === 0) ? 0 : -1" @click="emit('update:modelValue', item.value)" @keydown="navigate($event, index)">{{ item.label }}</button>
  </div>
</template>
<script setup lang="ts">
const props = defineProps<{modelValue: string; options: readonly {value: string; label: string}[]; label: string; disabled?: boolean}>();
const emit = defineEmits<{'update:modelValue': [value: string]}>();
function navigate(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + props.options.length) % props.options.length;
  emit('update:modelValue', props.options[next].value);
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
}
</script>
<style scoped>
.writing-choices{display:flex;flex-wrap:wrap;gap:7px}.writing-choices button{font:inherit;font-size:12px;line-height:1.4;min-height:33px;padding:7px 14px;border:1px solid var(--w-line);border-radius:9px;background:var(--w-soft);color:var(--w-ink);cursor:pointer}.writing-choices button:hover{border-color:var(--w-brand)}.writing-choices button[aria-checked=true]{color:var(--w-brand);background:var(--w-brand-soft);border-color:var(--w-brand);font-weight:600}.writing-choices button:focus-visible{outline:2px solid var(--w-brand);outline-offset:2px}.writing-choices button:disabled{opacity:.5;cursor:default}
</style>
