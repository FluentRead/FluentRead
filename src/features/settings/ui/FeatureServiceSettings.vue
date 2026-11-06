<!--
 * @file src/features/settings/ui/FeatureServiceSettings.vue
 * 文件职责：在通用设置中按需展开各功能的翻译服务分配，沿用默认服务，摘要提示独立配置与需要处理的状态。
 * 主要内容：按当前配置和功能选择限定缓存事件，复验服务能力，缓存各行模型与凭据提示；关闭的功能服务保留为不可选的当前值并显示已关闭提示；标题旁仅在没有操作提示时显示 AI 服务限制，下一行展示有效模型，阅读单独支持B站免费讲解，写作保留通用AI限制；配置连接定位到翻译服务页，默认选择保持独立。
 * 模块边界：仅修改父级传入的配置草稿，复用现有字段与自动保存；不保存第二份映射，不发起翻译或测试连接请求。
 -->
<template>
  <SettingsDisclosure class="feature-services" data-testid="feature-services" data-i18n-ignore
    :title="t('featureServices.open')" :description="t('featureServices.shortHelp')"
    :status-tone="summaryWarning ? 'warning' : 'neutral'">
    <template #status><span class="feature-services-status" :title="summaryWarning || summaryServices">{{ summaryWarning ? t('featureServices.needsSetup') : summaryServices }}</span></template>
    <SettingsGroup>
      <SettingsItem v-for="row in rows" :key="row.feature.id" :label="t(`featureServices.${row.feature.id}`)">
        <template #copy>
          <div class="feature-service-heading">
            <strong>{{ t(`featureServices.${row.feature.id}`) }}</strong>
            <small v-if="row.feature.aiOnly && !row.warning" class="feature-service-ai-only">{{ t('featureServices.aiOnly') }}</small>
          </div>
          <small v-if="(row.feature.id === 'reading' || servicesType.isUseModel(row.service)) && row.model" class="feature-service-model">{{ row.model }}</small>
        </template>
        <div class="feature-service-control" :data-feature-service="row.feature.id">
          <el-select :model-value="row.selected" :empty-values="[null, undefined]" :aria-label="t(`featureServices.${row.feature.id}`)" filterable :search-placeholder="t('select.searchService')" :disabled="!active" :onUpdate:modelValue="row.choose">
            <template #prefix><ServiceIcon :service="row.service" :label="serviceLabel(row.service)" size="small" /></template>
            <el-option v-if="row.feature.inherit" value="" :label="t('featureServices.follow', {service: serviceLabel(config.service)})" />
            <el-option v-for="option in row.choices" :key="option.value" :value="option.value" :label="option.label" :disabled="option.disabled"><span class="feature-service-option"><ServiceIcon :service="option.value" :label="option.label" size="small" />{{ option.label }}</span></el-option>
          </el-select>
          <div class="feature-service-meta">
            <button class="feature-service-connection" type="button" :aria-label="`${t(`featureServices.${row.feature.id}`)} · ${t('featureServices.connection')}`" :disabled="!active" :onClick="row.configure">{{ t('featureServices.connection') }}</button>
          </div>
          <small v-if="row.warning" class="feature-service-warning" role="status">{{ row.warning }}</small>
        </div>
      </SettingsItem>
    </SettingsGroup>
  </SettingsDisclosure>
</template>
<script setup lang="ts">
import {computed} from 'vue';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import {type Config} from '@/src/core/config/model';
import {featureServiceDefinitions, getFeatureService, setFeatureService, getFeatureModel, isFeatureServiceSupported} from '@/src/core/config/featureServices';
import {isHarnessService, isReadingService} from '@/src/core/config/harness';
import {options, servicesType} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {useUiI18n} from '@/src/ui/i18n';
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsDisclosure from './components/SettingsDisclosure.vue';
import SettingsItem from './components/SettingsItem.vue';
type ServiceOption = {value: string; label: string; disabled?: boolean};
const props = withDefaults(defineProps<{config: Config; serviceOptions: readonly ServiceOption[]; active?: boolean}>(), {active: true});
const emit = defineEmits<{'configure-service': [service: string]}>();
const {t, translateLegacy} = useUiI18n();
const {active, capture} = useSettingsActionContext(() => props.active, () => [props.config]);
const labels = computed(() => {
  const result = new Map<string, string>();
  for (const option of props.serviceOptions) if (!result.has(option.value)) result.set(option.value, option.label);
  return result;
});
const serviceLabel = (service: string) => labels.value.get(service)
  || (() => {
    const savedLabel = options.services.find(option => option.value === service)?.label;
    return savedLabel ? translateLegacy(savedLabel) : service;
  })();
const choices = computed(() => {
  const general = props.serviceOptions.filter(option => !option.disabled);
  return {general, ai: general.filter(option => isHarnessService(option.value, props.config.customOpenAIProviders)), reading: general.filter(option => isReadingService(option.value, props.config.customOpenAIProviders))};
});
const rows = computed(() => featureServiceDefinitions.map(feature => {
  const config = props.config, selected = getFeatureService(config, feature), service = selected || config.service;
  const model = getFeatureModel(config, feature), visible = feature.id === 'reading' ? choices.value.reading : feature.aiOnly ? choices.value.ai : choices.value.general;
  const available = visible.some(option => option.value === selected);
  const current = capture();
  const ownsSelection = () => current() && getFeatureService(config, feature) === selected
    && (selected || config.service) === service;
  const supported = isFeatureServiceSupported(feature, service, config.customOpenAIProviders);
  const message = config.disabledTranslationServices.includes(service)
    ? t('settings.services.library.serviceDisabledMessage')
    : !supported
    ? t(selected ? 'featureServices.aiOnly' : 'featureServices.needsAi') : getMissingCredentialMessage(service, config, model);
  const needsAttention = Boolean(message && (selected || supported || !feature.aiOnly
    || (feature.id === 'reading' ? config.harness.enabled : config.writing.enabled)));
  return {
    feature, selected, service, model, needsAttention, warning: message ? translateLegacy(message) : '',
    choices: selected && !available ? [{value: selected, label: serviceLabel(selected), disabled: true}, ...visible] : visible,
    choose: (value: unknown) => {
      if (!ownsSelection() || typeof value !== 'string') return;
      const permitted = feature.id === 'reading' ? choices.value.reading : feature.aiOnly ? choices.value.ai : choices.value.general;
      if ((value === '' && feature.inherit) || permitted.some(option => option.value === value)) setFeatureService(config, feature, value);
    },
    configure: () => {
      if (ownsSelection() && props.serviceOptions.some(option => option.value === service && !option.disabled)) emit('configure-service', service);
    },
  };
}));
const summaryServices = computed(() => {
  const independent = rows.value.filter(row => row.selected);
  return independent.length ? independent.map(row => t(`featureServices.${row.feature.id}`)).join(' · ') : t('featureServices.followDefault');
});
// 仅忽略未启用且未单独配置的 AI 功能能力说明；继承服务的缺凭据和已启用功能的问题仍在摘要提醒。
const summaryWarning = computed(() => rows.value.filter(row => row.needsAttention).map(row => `${t(`featureServices.${row.feature.id}`)} · ${row.warning}`).join('\n'));
</script>
<style scoped>
.feature-service-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; min-width: 0; }
.feature-service-control :deep(.el-select) { width: 100%; }
.feature-service-meta { display: contents; }
.feature-service-meta small { color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.feature-service-connection { justify-self: end; margin-left: auto; border: 0; padding: 3px 0; color: var(--brand-strong); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.feature-service-option { display: flex; align-items: center; gap: 9px; }
.feature-service-warning { grid-column: 1 / -1; color: var(--fr-warning); font-size: 12px; line-height: 1.5; }
button:hover { color: var(--brand); }
button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.feature-services :deep(.settings-item) { grid-template-columns: minmax(160px, 1fr) minmax(280px, 440px); min-height: 72px; padding: var(--fr-settings-row-padding-block, 14px) var(--fr-card-padding-inline, 20px); }
.feature-service-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.feature-service-ai-only { white-space: nowrap; }
.feature-service-model { overflow-wrap: anywhere; }
@media (max-width: 700px) { .feature-services :deep(.settings-item) { grid-template-columns: minmax(0, 1fr); gap: 10px; } }
</style>
