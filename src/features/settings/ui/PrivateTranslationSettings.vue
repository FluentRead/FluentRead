<!--
 * @file src/features/settings/ui/PrivateTranslationSettings.vue
 * 文件职责：为可信无痕来源的共享翻译提供显式开关、独立服务与模型设置，并清楚展示能力边界。
 * 主要内容：仅提供已配置的 AI 连接，保留不可用旧选择的警告；编辑不发起网络请求，关闭保留草稿，过期事件不修改新配置。
 * 模块边界：只编辑父级配置并沿用自动保存，不推断浏览器身份，不管理凭据，不改变阅读、写作或 OCR 服务。
 -->
<template>
  <SettingsGroup data-testid="private-translation-settings" data-i18n-ignore>
    <SettingsItem :label="t('privateTranslation.title')" :description="t('privateTranslation.scope')">
      <el-switch :key="revision" :model-value="config.privateTranslation.enabled" :disabled="!active" :aria-label="t('privateTranslation.title')" :onUpdate:modelValue="actions.enabled" />
    </SettingsItem>
    <template v-if="config.privateTranslation.enabled">
      <SettingsItem :label="t('privateTranslation.service')" :description="t('privateTranslation.credentials')">
        <el-select :key="revision" :model-value="config.privateTranslation.service" :disabled="!active" :aria-label="t('privateTranslation.service')" :onUpdate:modelValue="actions.service">
          <el-option v-if="unavailable" :value="config.privateTranslation.service" :label="config.privateTranslation.service" disabled />
          <el-option v-for="option in choices" :key="option.value" :value="option.value" :label="option.label" />
        </el-select>
      </SettingsItem>
      <SettingsItem :label="t('privateTranslation.model')" :description="t('privateTranslation.policy')">
        <el-input :key="revision" :model-value="config.privateTranslation.model" :disabled="!active" :maxlength="256" :aria-label="t('privateTranslation.model')" :onUpdate:modelValue="actions.model" />
        <small v-if="unavailable || !config.privateTranslation.service || !config.privateTranslation.model.trim()" role="status">{{ t('privateTranslation.required') }}</small>
      </SettingsItem>
    </template>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {computed} from 'vue';
import type {Config} from '@/src/core/config/model';
import {supportsPrivateTranslationService} from '@/src/core/config/privateTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
const props = withDefaults(defineProps<{config: Config; serviceOptions: readonly {value: string; label: string; disabled?: boolean}[]; active?: boolean}>(), {active: true});
const {t} = useUiI18n();
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.config.privateTranslation,
  props.config.privateTranslation.enabled, props.config.privateTranslation.service]);
const choices = computed(() => props.serviceOptions.filter(option => !option.disabled
  && supportsPrivateTranslationService(option.value, props.config.customOpenAIProviders)));
const unavailable = computed(() => Boolean(props.config.privateTranslation.service)
  && !choices.value.some(option => option.value === props.config.privateTranslation.service));
const actions = computed(() => {
  const current = capture();
  return {
    enabled: (value: unknown) => {if (current() && typeof value === 'boolean') props.config.privateTranslation.enabled = value;},
    service: (value: unknown) => {
      if (current() && props.config.privateTranslation.enabled && typeof value === 'string'
        && value !== props.config.privateTranslation.service && choices.value.some(option => option.value === value)) {
        props.config.privateTranslation = {...props.config.privateTranslation, service: value, model: ''};
      }
    },
    model: (value: unknown) => {
      if (current() && props.config.privateTranslation.enabled && typeof value === 'string') props.config.privateTranslation.model = value.slice(0, 256);
    },
  };
});
</script>
