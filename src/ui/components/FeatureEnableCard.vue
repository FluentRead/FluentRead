<!--
 * @file src/ui/components/FeatureEnableCard.vue
 * 文件职责：以整块可点击的紧凑设置卡展示功能总开关，使操作与标题紧邻并明确启停状态。
 * 主要内容：先呈现名称与说明，右侧开关对齐，读屏通过 aria-checked 获取状态；整块按钮支持点击、空格与回车，并适配禁用、窄屏及亮暗主题。
 * 模块边界：仅发送布尔值更新，不保存配置、不判断平台能力；禁用状态由调用方传入。
 -->
<template>
  <div class="feature-enable-card" :class="{enabled: modelValue, unavailable: disabled}">
    <button type="button" role="switch" :aria-label="title" :aria-checked="modelValue" :disabled="disabled" @click="emit('update:modelValue', !modelValue)">
      <span class="feature-enable-copy">
        <span class="feature-enable-heading"><strong>{{ title }}</strong></span>
        <span v-if="description" class="feature-enable-description">{{ description }}</span>
      </span>
      <span class="feature-enable-control"><i aria-hidden="true"><b /></i></span>
    </button>
  </div>
</template>
<script setup lang="ts">
defineProps<{modelValue: boolean; title: string; description?: string; disabled?: boolean}>();
const emit = defineEmits<{'update:modelValue': [value: boolean]}>();
</script>
<style scoped>
.feature-enable-card { margin: 0 0 var(--fr-card-gap, 20px); border: var(--fr-card-outline, 1px solid var(--line, #d7dce5)); border-radius: var(--fr-card-radius, 14px); background: var(--fr-card-background, var(--surface, #fff)); box-shadow: var(--fr-card-shadow, none); overflow: hidden; }
.feature-enable-card.enabled { background: var(--fr-card-background, var(--surface, #fff)); }
.feature-enable-card button { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%; min-height: 74px; padding: 16px var(--fr-card-padding-inline, 20px); border: 0; color: var(--ink, #161b26); background: transparent; font: inherit; text-align: start; cursor: pointer; transition: background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease); }
.feature-enable-card button:hover:not(:disabled) { background: var(--surface-soft, #f6f7f9); }
.feature-enable-card button:focus-visible { outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong)); outline-offset: -3px; }
.feature-enable-copy { display: block; min-width: 0; flex: 1; }
.feature-enable-control { display: flex; align-items: center; gap: 10px; flex: none; }
.feature-enable-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-height: 26px; }
.feature-enable-heading strong { font-size: var(--fr-text-md, 14px); font-weight: 600; }
.feature-enable-description { display: block; margin-top: 3px; color: var(--muted, #5b6476); font-size: var(--fr-text-sm, 12px); line-height: 1.55; }
.feature-enable-card i { display: flex; box-sizing: border-box; flex: none; align-items: center; width: 48px; height: 28px; padding: 3px; border: 1px solid color-mix(in srgb, var(--muted, #5b6476) 55%, transparent); border-radius: var(--fr-radius-full, 9999px); background: color-mix(in srgb, var(--muted, #5b6476) 42%, var(--surface, #fff)); transition: background-color var(--fr-duration-fast, 160ms) var(--fr-ease-out, ease), border-color var(--fr-duration-fast, 160ms) var(--fr-ease-out, ease); }
.feature-enable-card b { width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .16); transition: transform var(--fr-duration-normal, 220ms) var(--fr-ease-in-out, ease); }
.enabled i { background: var(--brand, #ef4776); border-color: var(--brand, #ef4776); }
.enabled b { transform: translateX(20px); }
.feature-enable-card button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 600px) { .feature-enable-card button { gap: 12px; padding: 15px var(--fr-card-padding-inline, 16px); } }
@media (prefers-reduced-motion: reduce) { .feature-enable-card b { transition: none; } }
</style>
