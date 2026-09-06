<!--
 * @file src/ui/components/FeatureEnableCard.vue
 * 文件职责：突出功能总开关，帮助用户理解当前启停状态和启用入口。
 * 主要内容：展示状态文字、功能说明与带文字的可访问开关，关闭时解释启用前提，适配窄屏和亮暗主题。
 * 模块边界：仅发送布尔值更新，不保存配置、不判断平台能力；禁用状态由调用方传入。
 -->
<template>
  <div class="feature-enable-card" :class="{enabled: modelValue, unavailable: disabled}">
    <div class="feature-enable-copy">
      <div class="feature-enable-heading"><strong>{{ title }}</strong><span class="feature-enable-status">{{ t(disabled ? 'featureEnable.unavailable' : modelValue ? 'featureEnable.on' : 'featureEnable.off') }}</span></div>
      <p>{{ description }}</p>
      <small v-if="!modelValue && !disabled">{{ t('featureEnable.hint') }}</small>
    </div>
    <button type="button" role="switch" :aria-label="title" :aria-checked="modelValue" :disabled="disabled" @click="emit('update:modelValue', !modelValue)">
      <span>{{ t(modelValue ? 'featureEnable.disable' : 'featureEnable.enable') }}</span><i aria-hidden="true"><b /></i>
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
.feature-enable-card { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 20px; border: 1px solid var(--brand, #ef4776); border-radius: 14px; background: var(--brand-soft, #fff0f4); }
.feature-enable-copy { min-width: 0; }
.feature-enable-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.feature-enable-heading strong { color: var(--ink); font-size: 15px; }
.feature-enable-status { padding: 3px 8px; border-radius: 20px; background: var(--surface, #fff); color: var(--muted); font-size: 11px; font-weight: 700; }
.enabled .feature-enable-status { color: var(--brand-strong, #d83160); }
.feature-enable-copy p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.feature-enable-copy small { display: block; margin-top: 5px; color: var(--brand-strong, #d83160); font-size: 12px; line-height: 1.6; }
.feature-enable-card button { display: inline-flex; flex: none; align-items: center; gap: 12px; min-height: 44px; padding: 0 14px; border: 1px solid var(--brand, #ef4776); border-radius: 10px; color: #fff; background: var(--brand-strong, #d83160); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.feature-enable-card button:focus-visible { outline: 3px solid var(--brand); outline-offset: 3px; }
.enabled button { color: var(--ink); background: var(--surface); border-color: var(--line); }
.feature-enable-card i { display: flex; align-items: center; width: 36px; height: 22px; padding: 3px; border-radius: 20px; background: rgba(0,0,0,.22); }
.feature-enable-card b { width: 16px; height: 16px; border-radius: 50%; background: #fff; }
.enabled i { background: var(--brand); }
.enabled b { transform: translateX(14px); }
.unavailable { border-color: var(--line); background: var(--surface-soft); }
.feature-enable-card button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 600px) { .feature-enable-card { align-items: stretch; flex-direction: column; gap: 14px; padding: 16px; } .feature-enable-card button { justify-content: center; } }
</style>
