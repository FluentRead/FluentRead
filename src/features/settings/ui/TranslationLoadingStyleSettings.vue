<!--
 * @file src/features/settings/ui/TranslationLoadingStyleSettings.vue
 * 文件职责：提供界面动画总开关与翻译加载样式选择，让用户在“界面风格”页面即时比较低干扰和趣味预设。
 * 主要内容：使用原生单选控件构建可访问的样式卡片，并为 15 种不同运动方案呈现轻量预览。
 * 模块边界：本组件只修改父级传入的 Config 字段，不持久化配置、不创建网页内加载指示器，也不决定运行时动画调度策略。
-->
<template>
  <SettingsGroup
    :title="t('settings.interface.animationLoading.label')"
    :description="t('settings.interface.animationLoading.description')"
  >
    <SettingsItem
      :label="t('settings.advanced.animations')"
      :description="t('settings.advanced.animationsDescription')"
    >
      <el-switch
        v-model="props.config.animations"
        class="settings-toggle"
        :aria-label="t('settings.advanced.animationsAria')"
      />
    </SettingsItem>

    <SettingsItem
      :label="t('settings.advanced.translationLoadingStyle')"
      :description="t('settings.advanced.translationLoadingStyleDescription')"
      stacked
      :disabled="!props.config.animations"
    >
      <div
        class="loading-style-picker"
        :class="{ 'is-disabled': !props.config.animations }"
        role="radiogroup"
        :aria-label="t('settings.advanced.translationLoadingStyleAria')"
        :aria-disabled="!props.config.animations"
      >
        <label
          v-for="option in translationLoadingStyleOptions"
          :key="option.value"
          class="loading-style-option"
          :class="{
            selected: props.config.translationLoadingStyle === option.value,
            disabled: !props.config.animations,
          }"
        >
          <input
            v-model="props.config.translationLoadingStyle"
            class="loading-style-radio"
            type="radio"
            name="translation-loading-style"
            :value="option.value"
            :disabled="!props.config.animations"
            :aria-label="t('settings.advanced.translationLoadingStyleOptionAria', {
              label: t(option.labelKey),
              description: t(option.descriptionKey),
            })"
          >

          <span
            class="loading-style-preview"
            aria-hidden="true"
          >
            <i class="loading-style-preview-line" />
            <TranslationLoadingPreview
              :loading-style="option.value"
              :animated="props.config.animations"
            />
          </span>

          <span class="loading-style-copy">
            <strong>{{ t(option.labelKey) }}</strong>
            <small>{{ t(option.descriptionKey) }}</small>
          </span>

          <span class="loading-style-check" aria-hidden="true"><i /></span>
        </label>
      </div>
    </SettingsItem>
  </SettingsGroup>
</template>

<script lang="ts" setup>
import type { Config } from '@/src/core/config/model'
import { translationLoadingStyleOptions } from '@/src/core/config/translationLoadingStyle'
import TranslationLoadingPreview from '@/src/ui/components/TranslationLoadingPreview.vue'
import { useUiI18n } from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'

const props = defineProps<{
  config: Config
}>()
const { t } = useUiI18n()
</script>

<style scoped>
.loading-style-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 156px), 1fr));
  width: 100%;
  gap: 8px;
}

.loading-style-option {
  position: relative;
  display: grid;
  grid-template-rows: 44px auto;
  gap: 8px;
  min-width: 0;
  min-height: 112px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--ink);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.loading-style-option:not(.disabled):hover {
  border-color: rgba(239, 71, 118, .38);
  background: var(--surface-soft);
}

.loading-style-option.selected {
  border-color: var(--brand);
  background: var(--brand-soft);
  box-shadow: 0 0 0 2px rgba(239, 71, 118, .08);
}

.loading-style-option.disabled {
  cursor: not-allowed;
}

.loading-style-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  border: 0;
  white-space: nowrap;
}

.loading-style-radio:focus-visible ~ .loading-style-preview {
  outline: 2px solid rgba(239, 71, 118, .34);
  outline-offset: 2px;
}

.loading-style-preview {
  position: relative;
  display: flex;
  width: 100%;
  height: 44px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-soft);
}

.loading-style-preview-line {
  display: block;
  width: 30px;
  height: 3px;
  margin-right: 1px;
  border-radius: 999px;
  background: var(--muted);
  opacity: .34;
}

.loading-style-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding-right: 15px;
}

.loading-style-copy strong {
  font-size: 11.5px;
  line-height: 1.35;
}

.loading-style-copy small {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.loading-style-check {
  position: absolute;
  right: 9px;
  bottom: 10px;
  display: grid;
  width: 13px;
  height: 13px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}

.loading-style-option.selected .loading-style-check {
  border-color: var(--brand);
  background: var(--brand);
}

.loading-style-check > i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: #fff;
  opacity: 0;
}

.loading-style-option.selected .loading-style-check > i {
  opacity: 1;
}

.loading-style-picker.is-disabled .loading-style-preview-line {
  opacity: .22;
}

@media (max-width: 480px) {
  .loading-style-picker {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 340px) {
  .loading-style-picker {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
