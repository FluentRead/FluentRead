<!--
 * @file src/features/settings/ui/AreaTranslationSettings.vue
 * 文件职责：提供独立圈选翻译设置，解释截图识别、标准翻译和 AI 文字上下文增强的能力边界。
 * 主要内容：管理圈选开关、独立服务、处理方式与共享源语言，显示服务能力反馈，并复用本地 OCR 语言包管理组件。
 * 模块边界：只修改父级配置并发出开关事件；配置持久化和快捷键冲突由 SettingsSections 处理，不截图、不调用模型、不下载识别资源。
 -->
<template>
  <SettingsGroup :title="t('area.settings.title')" :description="t('area.settings.intro')">
    <p v-if="!browserCapabilities.areaTranslation" class="area-settings-note" role="status">{{ t('area.settings.unavailable') }}</p>
    <FeatureEnableCard :model-value="props.enabled" :title="t('area.settings.enabled')" :description="t('area.settings.shortcut')" :disabled="!browserCapabilities.areaTranslation" @update:model-value="emit('update:enabled', $event)" />
    <SettingsItem :label="t('area.settings.service')" :description="t('area.settings.serviceDescription')">
      <el-select v-model="props.config.areaTranslationService" :aria-label="t('area.settings.service')" :placeholder="t('area.settings.followService')">
        <el-option :value="''" :label="t('area.settings.followService')" />
        <el-option v-if="savedServiceUnavailable" :value="props.config.areaTranslationService" :label="props.config.areaTranslationService" disabled />
        <el-option v-for="item in props.serviceOptions" :key="item.value" :value="item.value" :label="item.label" :disabled="item.disabled" />
      </el-select>
    </SettingsItem>
    <p v-if="unavailableMessage" class="area-settings-note area-settings-warning" role="status">{{ unavailableMessage }}</p>
    <SettingsItem :label="t('area.settings.mode')" :description="t('area.settings.modeDescription')">
      <el-select v-model="props.config.areaTranslationMode" :aria-label="t('area.settings.mode')">
        <el-option value="standard" :label="t('area.settings.standard')" />
        <el-option value="ai" :label="t('area.settings.ai')" :disabled="!supportsAI" />
      </el-select>
    </SettingsItem>
    <p class="area-settings-note" role="status">{{ t(props.config.areaTranslationMode === 'ai' ? 'area.settings.aiDescription' : 'area.settings.standardDescription') }}</p>
    <p v-if="!supportsAI" class="area-settings-note" :class="{'area-settings-warning': props.config.areaTranslationMode === 'ai'}" role="status">{{ t('area.settings.chooseAI') }}</p>
    <SettingsItem :label="t('area.settings.sourceLanguage')" :description="t('area.settings.sourceLanguageDescription')">
      <el-select v-model="props.config.from" :aria-label="t('area.settings.sourceLanguage')">
        <el-option v-if="!sourceLanguages.some(item => item.value === props.config.from)" :value="props.config.from" :label="props.config.from" disabled />
        <el-option v-for="item in sourceLanguages" :key="item.value" :value="item.value" :label="t(item.label)" />
      </el-select>
    </SettingsItem>
    <p class="area-settings-note">{{ t('area.settings.privacy') }}</p>
  </SettingsGroup>
  <ImageOcrSettings id-prefix="area" />
</template>

<script setup lang="ts">
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed} from 'vue';
import type {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {ImageOcrSettings} from '@/src/features/image-translation/public';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const props = defineProps<{
  config: Config;
  enabled: boolean;
  serviceOptions: readonly {value: string; label: string; disabled?: boolean}[];
}>();
const emit = defineEmits<{'update:enabled': [enabled: boolean]}>();
const {t} = useUiI18n();
const service = computed(() => props.config.areaTranslationService || props.config.service);
const supportsAI = computed(() => servicesType.isUseAIContext(
  service.value,
  resolveConfiguredModel(props.config.model[service.value], props.config.customModel[service.value]),
));
const unavailableMessage = computed(() => getTranslationServiceUnavailableMessage(service.value));
const savedServiceUnavailable = computed(() => props.config.areaTranslationService
  && !props.serviceOptions.some(item => item.value === props.config.areaTranslationService));
const sourceLanguages = [
  {value: 'auto', label: 'area.settings.languageAuto'},
  {value: 'en', label: 'area.settings.languageEnglish'},
  {value: 'zh-Hans', label: 'area.settings.languageChinese'},
  {value: 'zh-Hant', label: 'area.settings.languageTraditionalChinese'},
  {value: 'ja', label: 'area.settings.languageJapanese'},
];
</script>

<style scoped>
.area-settings-note { margin: 8px 16px 16px; color: var(--muted); font-size: 12px; line-height: 1.65; }
.area-settings-warning { color: var(--el-color-warning); }
</style>
