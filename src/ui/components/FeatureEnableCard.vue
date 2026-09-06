<!--
 * @file src/ui/components/FeatureEnableCard.vue
 * 文件职责：以简洁设置行展示功能总开关，保留清晰的启停状态。
 * 主要内容：将说明与右侧状态开关对齐，减少重复提示和大面积强调，适配窄屏、键盘操作与亮暗主题。
 * 模块边界：仅发送布尔值更新，不保存配置、不判断平台能力；禁用状态由调用方传入。
 -->
<template>
  <div class="feature-enable-card" :class="{enabled: modelValue, unavailable: disabled}">
    <div class="feature-enable-copy">
      <div class="feature-enable-heading"><strong>{{ title }}</strong></div>
      <p v-if="description">{{ description }}</p>
    </div>
    <button type="button" role="switch" :aria-label="title" :aria-checked="modelValue" :disabled="disabled" @click="emit('update:modelValue', !modelValue)">
      <span>{{ t(disabled ? 'featureEnable.unavailable' : modelValue ? 'featureEnable.on' : 'featureEnable.off') }}</span><i aria-hidden="true"><b /></i>
    </button>
  </div>
</template>
<script setup lang="ts">
import {useUiI18n} from '@/src/ui/i18n';
defineProps<{modelValue: boolean; title: string; description?: string; disabled?: boolean}>();
const emit = defineEmits<{'update:modelValue': [value: boolean]}>();
const {t} = useUiI18n();
</script>
<style scoped>
.feature-enable-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid var(--line, #e7e9f0); background: transparent; }
.feature-enable-copy { min-width: 0; }
.feature-enable-heading strong { color: var(--ink, #172033); font-size: 14px; font-weight: 650; }
.feature-enable-copy p { margin: 5px 0 0; color: var(--muted, #737c8f); font-size: 12px; line-height: 1.6; }
.feature-enable-card button { display: inline-flex; flex: none; align-items: center; justify-content: flex-end; gap: 10px; min-height: 44px; padding: 0 2px 0 8px; border: 0; border-radius: 8px; color: var(--muted, #737c8f); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.feature-enable-card button:focus-visible { outline: 2px solid var(--brand, #ef4776); outline-offset: 3px; }
.feature-enable-card button:hover i { box-shadow: 0 0 0 3px var(--brand-soft, #fff0f4); }
.feature-enable-card i { display: flex; flex: none; align-items: center; width: 42px; height: 24px; padding: 3px; border-radius: 20px; background: var(--muted, #737c8f); }
.feature-enable-card b { width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.enabled i { background: var(--brand, #ef4776); }
.enabled b { transform: translateX(18px); }
.feature-enable-card button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 600px) { .feature-enable-card { gap: 12px; padding: 16px; } .feature-enable-card button { gap: 7px; } }
</style>
