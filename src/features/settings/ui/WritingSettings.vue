<!--
 * @file src/features/settings/ui/WritingSettings.vue
 * 文件职责：提供写作助手总开关、默认回复偏好和 AI 服务连接设置。
 * 主要内容：用单层开关、与其他分区一致的“左标签、右控件”服务与语言设置行，以及左侧预览、右侧风格设置组织内容，窄屏按预览、设置依次展示；关闭的服务保留为禁选项并显示未就绪提示；缺失配置直接提示在 AI 服务一行，清楚区分默认偏好与真实生成，服务与风格模块提供同页导航目标。
 * 模块边界：服务候选与就绪提示遵循共享平台可用性；继承项及内置名称显式本地化，选择框与传送到页面的选项保护用户服务名和模型值；ChatGPT 套餐选择器保留已保存的全局与写作实际模型 slug，不发起账户模型发现；只编辑设置中心持久化的同一份写作配置并恢复被禁用的网站；选项通过写作 UI 公开入口复用，不加载网页卡片，不请求模型也不生成真实正文。
 -->
<template>
  <div class="writing-settings">
    <div ref="modelOptionsHost" data-i18n-ignore />
    <FeatureEnableCard v-model="config.writing.enabled" title="启用写作助手" :description="t('writing.experience.enableDescription')" />
    <p v-if="!config.writing.enabled" class="writing-description" role="status">{{ t('writing.experience.disabled') }}</p>
    <p v-else-if="!config.on" class="writing-description" role="status">{{ t('writing.experience.paused') }}</p>
    <SettingsGroup v-if="config.writing.disabledDomains.length" :title="t('writing.entry.disabledSites')">
      <p class="writing-site-help">{{ t('writing.entry.siteHelp') }}</p>
      <div v-for="domain in config.writing.disabledDomains" :key="domain" class="writing-disabled-site" :data-writing-disabled-site="domain"><span>{{ domain }}</span><button type="button" :aria-label="t('writing.entry.restoreSite', {domain})" @click="config.writing.disabledDomains = config.writing.disabledDomains.filter(item => item !== domain)">{{ t('writing.entry.restore') }}</button></div>
    </SettingsGroup>
    <SettingsGroup title="写作服务" data-settings-anchor="service" data-settings-anchor-label="写作服务">
      <SettingsItem label="AI 服务">
        <template v-if="readiness.issue && readiness.issue !== 'model'" #description><small class="writing-setup-message" role="status">{{ readiness.message }}</small></template>
        <el-select v-model="config.writing.service" data-i18n-ignore :empty-values="[null, undefined]" :aria-label="translateLegacy('写作服务')" :placeholder="translateLegacy('选择 AI 服务')" @change="config.writing.model = ''" filterable>
          <el-option value="" data-i18n-ignore :label="t('writing.experience.inheritService', {service: defaultServiceLabel})" />
          <el-option v-for="item in serviceOptions" :key="item.value" data-i18n-ignore :label="item.label" :value="item.value" :disabled="item.disabled" />
        </el-select>
      </SettingsItem>
      <SettingsItem label="模型">
        <template v-if="supported || readiness.issue === 'model'" #description>
          <small v-if="readiness.issue === 'model'" class="writing-setup-message" role="status">{{ readiness.message }}</small>
          <small v-if="supported" class="writing-model-label"><button type="button" @click="emit('configure-service')">配置服务连接 →</button></small>
        </template>
        <el-select v-model="config.writing.model" data-i18n-ignore :append-to="modelOptionsHost" :empty-values="[null, undefined]" filterable allow-create default-first-option :aria-label="translateLegacy('写作模型')" :placeholder="translateLegacy('选择或输入模型')" :disabled="!supported">
          <el-option value="" data-i18n-ignore :label="resolvedModel ? t('writing.experience.inheritModel', {model: resolvedModel}) : t('writing.experience.inheritModelEmpty')" />
          <el-option v-for="item in modelOptions" :key="item" data-i18n-ignore :label="item" :value="item" />
        </el-select>
      </SettingsItem>
      <SettingsItem label="输出语言">
        <el-select v-model="config.writing.language" class="writing-default-language" data-i18n-ignore :aria-label="translateLegacy('输出语言')" filterable>
          <el-option v-for="item in WRITING_LANGUAGES" :key="item.value" data-i18n-ignore :value="item.value" :label="item.value === 'target' ? t('writing.experience.inheritTargetLanguage', {language: targetLanguageLabel}) : getMultilingualTargetLanguageLabel(item.value, item.label, uiLanguage)" />
        </el-select>
      </SettingsItem>
      <SettingsItem :label="t('writing.referenceLanguage')">
        <el-select v-model="config.writing.referenceLanguage" class="writing-default-language" data-i18n-ignore :aria-label="t('writing.referenceLanguage')" filterable>
          <el-option value="ui" data-i18n-ignore :label="t('writing.interfaceLanguage')" />
          <el-option value="off" data-i18n-ignore :label="t('writing.referenceDisabled')" />
          <el-option v-for="item in WRITING_LANGUAGES.filter(item => item.value !== 'target')" :key="item.value" data-i18n-ignore :value="item.value" :label="getMultilingualTargetLanguageLabel(item.value, item.label, uiLanguage)" />
        </el-select>
      </SettingsItem>
    </SettingsGroup>
    <SettingsGroup title="回答风格" data-settings-anchor="style" data-settings-anchor-label="回答风格">
      <div class="writing-default-style">
        <WritingStylePreview
          :length="config.writing.length" :style="config.writing.style"
          :tone="toneChoice === 'custom' ? customTone || 'custom' : config.writing.tone" :role="roleChoice === 'custom' ? customRole || 'custom' : config.writing.role"
          :reference-label="referencePreviewLabel" :animated="config.animations"
        />
        <div class="writing-style-controls">
        <section><h3>长度</h3><WritingChoices v-model="config.writing.length" :options="WRITING_LENGTHS" label="长度" /></section>
        <section><h3>风格</h3><WritingChoices v-model="config.writing.style" :options="WRITING_STYLES" label="风格" /></section>
        <section><h3>语气</h3><WritingChoices v-model="toneChoice" :options="toneOptions" label="语气" />
          <div v-if="toneChoice === 'custom'" class="writing-custom-preference"><el-input :model-value="customTone" :maxlength="WRITING_TONE_MAX_LENGTH" aria-label="自定义语气" placeholder="例如：耐心、鼓励，避免夸张" @update:model-value="updateCustomTone" /><small>留空时使用自然语气</small></div>
        </section>
        <section><h3 :title="t('writing.experience.roleHelp')">您的角色</h3><WritingChoices v-model="roleChoice" :options="roleOptions" label="您的角色" />
          <div v-if="roleChoice === 'custom'" class="writing-custom-preference"><el-input :model-value="customRole" :maxlength="WRITING_ROLE_MAX_LENGTH" aria-label="自定义角色" placeholder="例如：正在排查问题的项目维护者" @update:model-value="updateCustomRole" /><small>留空时不指定回复身份</small></div>
        </section>
        </div>
      </div>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import {computed, ref, toRef, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import type {Config} from '@/src/core/config/model';
import {getMultilingualTargetLanguageLabel, models, options, resolveConfiguredModel, services} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {resolveWritingReadiness} from '@/src/core/config/writingReadiness';
import {filterAvailableTranslationServices, getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {markDisabledTranslationServices} from '@/src/core/config/serviceAvailability';
import {getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {WRITING_LANGUAGES, WRITING_LENGTHS, WRITING_STYLES, WRITING_TONES, WRITING_ROLES, WRITING_TONE_MAX_LENGTH, WRITING_ROLE_MAX_LENGTH, resolveWritingLanguage, resolveWritingReferenceLanguage} from '@/src/core/config/writing';
import {WritingChoices} from '@/src/features/writing-assistant/ui/public';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import WritingStylePreview from './components/WritingStylePreview.vue';
const {t, translateLegacy, language: uiLanguage} = useUiI18n();
// allow-create 的候选由控件内部生成；专属容器保护整个传送菜单中的模型原值。
const modelOptionsHost = ref<HTMLElement>();
const props = defineProps<{config: Config}>(); const config = toRef(props, 'config');
const emit = defineEmits<{'configure-service': []}>();
const targetLanguageLabel = computed(() => {const item = WRITING_LANGUAGES.find(item => item.value === resolveWritingLanguage('target', config.value.to))!; return getMultilingualTargetLanguageLabel(item.value, item.label, uiLanguage.value);});
const toneOptions = [...WRITING_TONES, {value: 'custom', label: '自定义'}];
const roleOptions = [...WRITING_ROLES, {value: 'custom', label: '自定义'}];
// 自定义选择独立于已保存值，避免空输入回落或输入恰好等于预设 ID 时让控件突然消失。
function customPreference(field: 'tone' | 'role', presets: readonly {value: string}[], limit: number, fallback: string) {
  const isPreset = (value: string) => presets.some(item => item.value === value);
  const custom = ref(!isPreset(config.value.writing[field]));
  const text = ref(custom.value ? config.value.writing[field] : '');
  let localValue: string | undefined;
  function save(value: string) {
    const normalized = value.trim() || fallback;
    if (config.value.writing[field] === normalized) return;
    localValue = normalized; config.value.writing[field] = normalized;
  }
  const choice = computed({get: () => custom.value ? 'custom' : config.value.writing[field], set: (value: string) => {
    custom.value = value === 'custom'; save(custom.value ? text.value : value);
  }});
  watch(() => config.value.writing[field], value => {
    if (value === localValue) { localValue = undefined; return; }
    custom.value = !isPreset(value); text.value = custom.value ? value : '';
  });
  function update(value: string | number) { text.value = String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit); save(text.value); }
  return {choice, text, update};
}
const {choice: toneChoice, text: customTone, update: updateCustomTone} = customPreference('tone', WRITING_TONES, WRITING_TONE_MAX_LENGTH, 'natural');
const {choice: roleChoice, text: customRole, update: updateCustomRole} = customPreference('role', WRITING_ROLES, WRITING_ROLE_MAX_LENGTH, 'auto');
const serviceOptions = computed(() => markDisabledTranslationServices(filterAvailableTranslationServices([...options.services.filter(item => !item.disabled && isHarnessService(item.value)).map(item => ({...item, label: translateLegacy(item.label)})), ...config.value.customOpenAIProviders.map(item => ({value: item.id, label: item.name}))]), config.value.disabledTranslationServices));
const service = computed(() => config.value.writing.service || config.value.service);
const serviceUnavailableMessage = computed(() => config.value.disabledTranslationServices.includes(service.value)
  ? t('settings.services.library.serviceDisabledMessage') : getTranslationServiceUnavailableMessage(service.value));
const readiness = computed(() => resolveWritingReadiness(config.value, true, serviceUnavailableMessage.value));
const supported = computed(() => readiness.value.supported);
const defaultServiceLabel = computed(() => {const builtin = options.services.find(item => item.value === config.value.service); return builtin ? translateLegacy(builtin.label) : serviceOptions.value.find(item => item.value === config.value.service)?.label || config.value.service;});
const resolvedModel = computed(() => resolveConfiguredModel(config.value.model[service.value], config.value.customModel[service.value]));
const modelOptions = computed(() => service.value === services.chatgptPlan
  ? [...new Set([resolvedModel.value, config.value.writing.model].filter(Boolean))]
  : (isCustomOpenAIProviderId(service.value) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service.value) : models.get(service.value) ?? []).filter(item => item !== '自定义模型'));
// 对照语言在示例里只提示一行，真实译文仍由写作卡片在生成后请求。
const referencePreviewLabel = computed(() => {
  const language = resolveWritingReferenceLanguage(config.value.writing.referenceLanguage, uiLanguage.value);
  if (!language || language === resolveWritingLanguage(config.value.writing.language, config.value.to)) return '';
  return (WRITING_LANGUAGES.find(item => item.value === language)?.label || language).split(' / ')[0];
});
</script>
<style scoped>
.writing-settings{max-width:1080px;margin:0 auto}
.writing-settings>.feature-enable-card{margin:0 0 24px}
.writing-description{margin:-12px 0 24px;color:var(--muted);font-size:12px;line-height:1.7}
.writing-site-help{margin:0;padding:12px 18px 0;color:var(--muted);font-size:12px}.writing-disabled-site{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;font-size:13px}.writing-disabled-site button{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--brand);padding:6px 10px;font:inherit;cursor:pointer}.writing-disabled-site button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.writing-settings small.writing-setup-message{color:var(--fr-warning)}
.writing-model-label button{border:0;padding:0;background:none;color:var(--brand-strong);font:inherit;font-weight:600;cursor:pointer}
.writing-model-label button:hover{text-decoration:underline;text-underline-offset:3px}
.writing-model-label button:focus-visible{outline:2px solid var(--brand);outline-offset:4px}
.writing-default-style{--w-brand:var(--brand);--w-brand-soft:var(--brand-soft);--w-ink:var(--ink);--w-soft:var(--surface-soft);--w-line:var(--line);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:24px;padding:16px 18px;align-items:start}
.writing-style-controls{display:flex;flex-direction:column;gap:16px;min-width:0}
.writing-default-style h3{margin:0 0 8px;font-size:12px;line-height:1.5;font-weight:600;color:var(--ink)}
.writing-default-style :deep(.writing-choices){gap:6px}
.writing-default-style :deep(.writing-choices button){box-sizing:border-box;min-height:32px;padding:6px 11px;font-size:12px;line-height:18px;border-radius:8px}
.writing-default-style :deep(.style-preview){margin:0;min-width:0}
.writing-custom-preference{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;margin-top:9px}
.writing-custom-preference small{font-size:10.5px;line-height:1.55;color:var(--muted)}
@media(max-width:1100px){.writing-default-style{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.writing-default-style{padding:16px 12px}}
</style>
