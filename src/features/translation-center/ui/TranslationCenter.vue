<!--
 * @file src/features/translation-center/ui/TranslationCenter.vue
 * 文件职责：提供以输入和多服务对照为中心的翻译工作台，清晰展示凭据、请求进度和旧结果。
 * 主要内容：设置页与原生侧边栏共用输入、服务选择和请求会话；侧栏支持 Enter 翻译、Shift+Enter 换行，输入法组合期间不触发，原设置页快捷键保持不变；侧栏专用布局由原生入口样式负责；侧边栏用紧凑按钮显示服务或已选数量，完整保留多服务对比与模型标识，移除重复语言/耗时、拖拽和常驻配置说明，不覆盖设置页保存的结果布局，暂停时通过外层打开通用设置；相同译文仍可显示和复制；复用配置补丁保存语言、顺序和结果布局；服务目录按凭据状态分组并支持模型搜索；卡片提供配置入口、独立重试和复制，设置同步保留原文及结果，请求身份和停止由 comparison 模型维护，全局暂停取消在途任务并保留输入与已完成结果。
 * 模块边界：不实现 provider 协议、不保存原文和译文、不更改网页默认服务；翻译复用 app client 的服务超时配置，设置导航交给外层，卸载时释放自有页面监听器和请求。
 -->
<template>
  <section class="translation-center" :class="{'is-sidebar': surface === 'sidebar'}" :aria-label="translateLegacy('翻译中心')">
    <div v-if="surface !== 'sidebar' || saveState === 'error'" class="translation-center-intro"><p v-if="surface !== 'sidebar'">{{ ct('intro') }}</p><span v-if="surface !== 'sidebar' && saveState === 'saved'" class="save-status">{{ ct('saved') }}</span><button v-if="saveState === 'error'" class="text-button" type="button" @click="retrySave">{{ ct('saveError') }}</button></div>
    <p v-if="hiddenUnavailableServices.length" class="translation-capability-warning" role="status">{{ translateLegacy('当前浏览器暂不支持 Chrome 内置翻译；该对比项已暂时隐藏，原配置会保留') }}</p>
    <div class="translation-center-layout">
      <section class="translation-input-panel" :aria-label="ct('input')">
        <div v-if="surface !== 'sidebar'" class="translation-panel-heading"><h3 id="translation-input-title">{{ ct('input') }}</h3><button v-if="sourceText" class="text-button" type="button" @click="clearSource">{{ ct('clear') }}</button></div>
        <div class="translation-center-toolbar">
          <div class="language-picker-group"><label v-if="surface !== 'sidebar'" for="translation-center-source">{{ ct('source') }}</label><UiSelect id="translation-center-source" v-model="sourceLanguage" :aria-label="ct('source')" :title="languageLabel(sourceLanguage)" :wrap-label="false" :show-search-icon="false" filterable @visible-change="sourceMenuOpen = $event" @change="persistTranslationCenterConfig('source')"><template #label><span data-i18n-ignore>{{ sourceMenuOpen ? t('select.search') : languageLabel(sourceLanguage).split(' / ')[0] }}</span></template><ElOption v-for="item in sourceLanguageOptions" :key="item.value" :value="item.value" data-i18n-ignore :label="languageLabel(item.value)" /></UiSelect></div>
          <button class="language-swap-button icon-button" type="button" :aria-label="ct('swap')" :title="ct(sourceLanguage === 'auto' ? 'swapAuto' : 'swap')" :disabled="sourceLanguage === 'auto'" @click="swapLanguages"><UiIcon name="swap" /></button>
          <div class="language-picker-group"><label v-if="surface !== 'sidebar'" for="translation-center-target">{{ ct('target') }}</label><UiSelect id="translation-center-target" v-model="targetLanguage" :aria-label="ct('target')" :title="languageLabel(targetLanguage)" :wrap-label="false" :show-search-icon="false" filterable @visible-change="targetMenuOpen = $event" @change="persistTranslationCenterConfig('target')"><template #label><span data-i18n-ignore>{{ targetMenuOpen ? t('select.search') : languageLabel(targetLanguage).split(' / ')[0] }}</span></template><ElOption v-for="item in targetLanguageOptions" :key="item.value" :value="item.value" data-i18n-ignore :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" /></UiSelect></div>
        </div>
        <div class="translation-editor"><textarea ref="sourceEditor" v-model="sourceText" data-i18n-ignore :maxlength="MAX_TEXT_LENGTH" :placeholder="ct('placeholder')" :aria-label="ct('input')" :aria-describedby="surface === 'sidebar' ? 'sidebar-input-help' : 'translation-input-help'" :title="surface === 'sidebar' ? t('sidepanel.keyboardHint') : undefined" @keydown="handleEditorKeydown" /><button v-if="surface === 'sidebar' && sourceText" class="sidebar-clear-button icon-button" type="button" :aria-label="ct('clear')" :title="ct('clear')" @click="clearSource"><UiIcon name="close" :size="16" /></button><button v-if="!sourceText && surface !== 'sidebar'" class="example-button" type="button" @click="useExample"><UiIcon name="pen" :size="15" />{{ ct('example') }}</button></div>
        <div v-if="surface !== 'sidebar'" class="translation-input-meta"><span>{{ sourceText.length.toLocaleString() }} / 5,000</span><span v-if="isRunning" role="status">{{ ct('progress', {done: settledCount, total: requestedCount}) }}</span></div>
        <p v-if="!translationEnabled" class="input-notice translation-paused" role="status">{{ t('popup.heroDisabled') }} · <button v-if="surface === 'sidebar'" class="text-button" type="button" @click="emit('configure-general')">{{ translateLegacy('通用设置') }}</button><a v-else href="#settings-general">{{ translateLegacy('通用设置') }}</a></p>
        <p v-if="sameLanguage" class="input-notice" role="status">{{ ct('sameLanguage') }}</p>
        <p v-if="!readyCards.length && surface !== 'sidebar'" class="input-notice" role="status">{{ ct('noReady') }}</p>
        <div class="translation-input-footer"><button v-if="isRunning" class="translate-stop-button" type="button" @click="session.stop()"><UiIcon name="close" :size="16" />{{ ct('stop') }}</button><button v-else class="translate-primary-button" type="button" :disabled="!canTranslate || !readyCards.length" @click="runTranslation"><UiIcon name="translate" :size="17" />{{ ct(state.run ? 'again' : 'start') }}<kbd v-if="surface !== 'sidebar'">{{ shortcutLabel }}</kbd></button><p v-if="surface === 'sidebar'" id="sidebar-input-help" class="sidebar-keyboard-hint">{{ t('sidepanel.keyboardHint') }}</p><p v-if="surface !== 'sidebar'" id="translation-input-help">{{ ct('privacy') }}</p></div>
      </section>
      <section class="translation-results-panel" :aria-label="ct('results')">
        <div class="translation-panel-heading results-heading">
          <div v-if="surface !== 'sidebar'"><h3 id="translation-results-title">{{ ct('results') }} <span class="result-count">{{ cards.length }}</span></h3><p class="results-help">{{ ct('selectionHint') }}</p></div>
          <button v-if="surface === 'sidebar' && cards.length === 1 && cards[0].status === 'success'" class="text-button sidebar-copy-button" type="button" @click="copyResult(cards[0])">{{ ct(copiedService === cards[0].service ? 'copied' : 'copy') }}</button><div ref="servicePicker" class="translation-center-service-picker">
            <button ref="servicePickerTrigger" class="add-service-button" type="button" :aria-label="ct('manage')" :title="ct('manage')" :aria-expanded="servicePickerOpen" aria-controls="translation-service-picker" aria-haspopup="dialog" @click="toggleServicePicker"><UiIcon :name="surface === 'sidebar' ? 'sliders' : 'plus'" :size="16" /><span class="service-picker-label" data-i18n-ignore>{{ surface === 'sidebar' && cards.length === 1 ? serviceLabel(cards[0].service) : ct('manage') }}</span><span v-if="surface === 'sidebar' && cards.length > 1" class="service-picker-count">{{ cards.length }}</span><UiIcon v-if="surface === 'sidebar'" name="chevron-down" :size="13" /></button>
            <div v-if="servicePickerOpen" id="translation-service-picker" class="service-picker-popover" role="dialog" :aria-label="ct('manageTitle')" @keydown.esc.stop.prevent="closePicker(true)">
              <header class="service-picker-header"><div><strong>{{ ct('manageTitle') }}</strong><p v-if="surface !== 'sidebar'">{{ ct('manageHint') }}</p></div><button class="service-picker-close icon-button" type="button" :aria-label="ct('close')" @click="closePicker(true)"><UiIcon name="close" :size="16" /></button></header>
              <label class="service-picker-search"><UiIcon name="search" :size="17" /><input ref="serviceSearch" v-model.trim="serviceSearchQuery" type="search" :placeholder="ct('search')" :aria-label="ct('search')" /></label>
              <div class="service-picker-groups">
                <section v-for="group in filteredServiceGroups" :key="group.key" class="service-picker-group"><div class="service-picker-group-heading"><strong>{{ group.label }}</strong><span v-if="surface !== 'sidebar'">{{ group.items.length }}</span></div>
                  <div v-for="item in group.items" :key="item.value" class="service-picker-row"><button type="button" class="service-picker-option" :aria-pressed="selectedServiceValues.has(item.value)" :disabled="selectedServiceValues.has(item.value) && cards.length <= 1" @click="toggleService(item.value)"><ServiceIcon :service="item.value" :label="item.label" size="small" /><span class="service-picker-option-copy"><strong data-i18n-ignore>{{ item.label }}</strong><small data-i18n-ignore>{{ serviceModel(item.value) || serviceCategory(item.value) }}</small></span><UiIcon :name="selectedServiceValues.has(item.value) ? 'check' : 'plus'" :size="16" /></button><button v-if="credentialWarning(item.value)" class="picker-configure text-button" type="button" :aria-label="ct('configureNamed', {service: item.label})" @click="configureService(item.value)">{{ ct('needsConfig') }}<UiIcon name="external" :size="12" /></button></div>
                </section>
                <p v-if="!filteredServiceGroups.length" class="picker-empty">{{ ct('noMatch') }}</p>
              </div><footer v-if="surface !== 'sidebar'" class="service-picker-footer">{{ ct('selected', {count: cards.length}) }}</footer>
            </div>
          </div>
        </div>
        <div v-if="surface !== 'sidebar'" class="results-controls"><div class="results-layout-control" role="group" :aria-label="ct('layout')"><button type="button" :aria-pressed="resultLayout === 'list'" @click="setLayout('list')"><UiIcon name="card" :size="15" />{{ ct('list') }}</button><button type="button" :aria-pressed="resultLayout === 'grid'" @click="setLayout('grid')"><UiIcon name="layout" :size="15" />{{ ct('grid') }}</button></div><div class="results-heading-actions"><button v-if="incompleteCards.length" class="text-button" type="button" :disabled="!canTranslate" @click="retryIncomplete">{{ ct('retryIncomplete') }}</button><button class="copy-all-button text-button" type="button" :disabled="!successfulCards.length" @click="copyAllResults">{{ ct(copiedService === 'all' ? 'copied' : 'copyAll') }}</button></div></div>
        <div v-if="staleCount" class="results-stale-notice" role="status"><UiIcon name="info" :size="16" />{{ ct(surface === 'sidebar' ? 'stale' : 'staleHint') }}</div>
        <div class="translation-result-list" :class="{'is-grid': surface !== 'sidebar' && resultLayout === 'grid'}">
          <article v-for="card in visibleCards" :key="card.service" class="translation-result-card" :data-service="card.service" :data-status="card.status" :data-stale="isStale(card)" :class="{'is-dragging': draggingService === card.service, 'is-drag-over': dragOverService === card.service}">
            <header v-if="surface !== 'sidebar' || cards.length > 1" class="translation-result-card-header"><div class="translation-result-service-name"><button v-if="surface !== 'sidebar'" class="drag-handle icon-button" type="button" :aria-label="ct('reorder', {service: serviceLabel(card.service)})" :title="ct('reorderHint')" @pointerdown.prevent.stop="startPointerDrag(card.service, $event)" @keydown.alt.arrow-up.prevent="moveCard(card.service, -1)" @keydown.alt.arrow-down.prevent="moveCard(card.service, 1)"><UiIcon name="grip" :size="15" /></button><ServiceIcon v-if="surface !== 'sidebar'" :service="card.service" :label="serviceLabel(card.service)" size="medium" /><div><strong data-i18n-ignore :title="serviceLabel(card.service)">{{ serviceLabel(card.service) }}</strong><small v-if="surface !== 'sidebar' || cardModel(card)" data-i18n-ignore :title="cardModel(card)">{{ cardModel(card) || serviceCategory(card.service) }}</small></div></div><div class="translation-result-card-actions"><span v-if="surface !== 'sidebar'" class="result-state" :class="cardStatus(card)">{{ ct(cardStatus(card)) }}</span><button class="remove-service-button icon-button" type="button" :aria-label="ct('remove', {service: serviceLabel(card.service)})" :disabled="cards.length <= 1" @click="removeService(card.service)"><UiIcon name="close" :size="15" /></button></div></header>
            <div v-if="card.status === 'loading'" class="translation-result-placeholder loading-placeholder" role="status"><span class="loading-bars" aria-hidden="true"><i /><i /><i /></span>{{ ct('loading') }}<button v-if="surface !== 'sidebar' || cards.length > 1" class="text-button" type="button" @click="session.stopService(card.service)">{{ ct('stop') }}</button></div>
            <div v-else-if="card.status === 'success'" class="translation-result-content"><p data-i18n-ignore>{{ card.result }}</p><footer v-if="surface !== 'sidebar' || cards.length > 1"><span v-if="surface !== 'sidebar'">{{ languageLabel(card.input!.sourceLanguage) + ' → ' + languageLabel(card.input!.targetLanguage) }} {{ card.input!.model ? ' · ' + card.input!.model : '' }} · {{ card.duration.toLocaleString() }} ms</span><div><button v-if="isStale(card)" class="text-button" type="button" :disabled="!canTranslate || !!credentialWarning(card.service)" @click="retryService(card.service)">{{ ct('refresh') }}</button><button class="text-button" type="button" @click="copyResult(card)">{{ ct(copiedService === card.service ? 'copied' : 'copy') }}</button></div></footer></div>
            <div v-else-if="credentialWarning(card.service)" class="translation-result-placeholder needs-configuration"><p>{{ translateLegacy(credentialWarning(card.service)!) }}</p><button class="text-button" type="button" @click="configureService(card.service)">{{ ct('configure') }}<UiIcon name="external" :size="13" /></button></div>
            <div v-else-if="card.status === 'error'" class="translation-result-error"><p data-i18n-ignore>{{ card.error === 'empty-result' ? ct('emptyResult') : card.error || ct('requestError') }}</p><button class="text-button" type="button" :disabled="!canTranslate" @click="retryService(card.service)">{{ ct('retry') }}</button></div>
            <div v-else class="translation-result-placeholder"><p>{{ ct(card.status === 'cancelled' ? 'cancelledHint' : 'wait') }}</p><button class="text-button" type="button" :disabled="!canTranslate" @click="retryService(card.service)">{{ ct('translateOne') }}</button></div>
            <footer v-if="surface !== 'sidebar' && (!credentialWarning(card.service) || card.status === 'success')" class="card-connection-footer"><button class="text-button" type="button" :aria-label="ct('configureNamed', {service: serviceLabel(card.service)})" @click="configureService(card.service)"><UiIcon name="sliders" :size="13" />{{ ct('configure') }}</button></footer>
          </article>
        </div><p v-if="surface !== 'sidebar' || feedback === ct('copyError')" class="translation-center-feedback" role="status" aria-live="polite">{{ feedback }}</p>
      </section>
    </div>
  </section>
</template>
<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, reactive, ref} from 'vue';
import browser from 'webextension-polyfill';
import {ElOption} from 'element-plus';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
import {useUiI18n} from '@/src/ui/i18n';
import {filterAvailableTranslationServices, isTranslationServiceAvailable} from '@/src/services/translation/capabilities';
import {getMultilingualTargetLanguageLabel, models, options, resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {getCustomOpenAIProvider, getCustomOpenAIProviderModels, isConfiguredCustomOpenAIProvider, type CustomOpenAIProvider, withCustomOpenAIServiceOptions} from '@/src/core/config/customOpenAI';
import {getCompositeTranslationConfigFingerprint, isCompositeTranslationProviderId, withCompositeTranslationServiceOptions} from '@/src/core/config/compositeTranslation';
import {config, configReady, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import {translateText} from '@/src/services/translation/client';
import {TranslationRequestError} from '@/src/services/translation/errors';
import {createComparisonSession, isComparisonStale, MAX_COMPARISON_TEXT_LENGTH, type ComparisonCard, type ComparisonState} from '../model/comparison';

const props = withDefaults(defineProps<{surface?: 'settings' | 'sidebar'}>(), {surface: 'settings'});
const emit = defineEmits<{(event: 'configure-service', service: string): void; (event: 'configure-general'): void}>();
const {language, translateLegacy, t} = useUiI18n();
const ct = (key: string, params?: Record<string, string | number>) => t('translationCenter.' + key, params);
const MAX_TEXT_LENGTH = MAX_COMPARISON_TEXT_LENGTH;
const sourceText = ref('');
const sourceLanguage = ref('auto');
const targetLanguage = ref('zh-Hans');
const sourceMenuOpen = ref(false);
const targetMenuOpen = ref(false);
const resultLayout = ref<'list' | 'grid'>('list');
const sourceEditor = ref<HTMLTextAreaElement | null>(null);
const state = reactive<ComparisonState>({cards: [], run: 0});
const cards = computed(() => state.cards);
const visibleCards = computed(() => props.surface === 'sidebar' ? cards.value.filter(card => card.status !== 'idle' || credentialWarning(card.service)) : cards.value);
const servicePickerOpen = ref(false);
const serviceSearchQuery = ref('');
const servicePicker = ref<HTMLElement | null>(null);
const servicePickerTrigger = ref<HTMLButtonElement | null>(null);
const serviceSearch = ref<HTMLInputElement | null>(null);
const copiedService = ref('');
const feedback = ref('');
const saveState = ref<'idle' | 'saved' | 'error'>('idle');
const draggingService = ref('');
const dragOverService = ref('');
const customOpenAIProviders = ref<CustomOpenAIProvider[]>([]);
// 全局配置不是 Vue proxy；订阅版本驱动模型及凭据状态更新。
const configRevision = ref(0);
const configHydrated = ref(false);
const translationEnabled = ref(false);
let disposed = false;
let unsubscribeConfig: (() => void) | undefined;
let unsubscribeSidebar: (() => void) | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveSequence = 0;
const failedSave = new Set<TranslationCenterConfigField>();
const pendingSave = new Map<TranslationCenterConfigField, number>();
let pointerDrag: {service: string; pointerId: number; previousUserSelect: string} | null = null;
type TranslationCenterConfigField = 'services' | 'source' | 'target' | 'layout';
type TranslationCenterConfigPatch = {translationCenterServices?: string[]; translationCenterSourceLanguage?: string; translationCenterTargetLanguage?: string; translationCenterLayout?: 'list' | 'grid'};

const serviceOptions = computed(() => {
  void configRevision.value;
  return filterAvailableTranslationServices(withCompositeTranslationServiceOptions(withCustomOpenAIServiceOptions(
    options.services, customOpenAIProviders.value,
  ), config.compositeTranslationProviders)).filter(item => !item.disabled).map(item => ({...item, label: translateLegacy(item.label)}));
});
const hiddenUnavailableServices = computed(() => {
  void configRevision.value;
  return config.translationCenterServices.filter(service => !isTranslationServiceAvailable(service));
});
const sourceLanguageOptions = computed(() => options.from);
const targetLanguageOptions = computed(() => options.to);
const selectedServiceValues = computed(() => new Set(cards.value.map(card => card.service)));
const sameLanguage = computed(() => sourceLanguage.value === targetLanguage.value);
const canTranslate = computed(() => configHydrated.value && translationEnabled.value && !!sourceText.value.trim() && sourceText.value.length <= MAX_TEXT_LENGTH && !sameLanguage.value);
const isRunning = computed(() => cards.value.some(card => card.status === 'loading'));
const readyCards = computed(() => cards.value.filter(card => !credentialWarning(card.service)));
const successfulCards = computed(() => cards.value.filter(card => card.status === 'success' && !isStale(card)));
const staleCount = computed(() => cards.value.filter(card => card.input && isStale(card)).length);
const incompleteCards = computed(() => readyCards.value.filter(card => card.status === 'error' || card.status === 'cancelled'));
const currentTaskCards = computed(() => cards.value.filter(card => card.status === 'loading' || (card.input && !isStale(card))));
const requestedCount = computed(() => currentTaskCards.value.length);
const settledCount = computed(() => currentTaskCards.value.filter(card => card.status !== 'loading').length);
const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵';
const session = createComparisonSession(state, async (service, input, signal) => {
  try {
    return await translateText(input.text, 'FluentRead 翻译中心', {
  maxRetries: 0, useCache: false, serviceOverride: service,
  sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, modelOverride: input.model || undefined, signal,
    });
  } catch (error) {
    // 后台暂停响应可能先于配置订阅到达，仍须停止全部未完成项。
    if (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED') {
      translationEnabled.value = false;
      session.stop();
    }
    throw error;
  }
});
function serviceModel(service: string): string {
  void configRevision.value;
  return servicesType.isAI(service) || isConfiguredCustomOpenAIProvider(customOpenAIProviders.value, service)
    ? resolveConfiguredModel(config.model[service], config.customModel[service]) : '';
}
function credentialWarning(service: string): string | null {
  void configRevision.value;
  const provider = getCustomOpenAIProvider(customOpenAIProviders.value, service);
  if (provider && !provider.endpoint.trim()) return ct('endpointMissing');
  if ((servicesType.isAI(service) || provider) && !serviceModel(service)) return ct('modelMissing');
  return getMissingCredentialMessage(service, config);
}
function serviceCategory(service: string): string {
  return isCompositeTranslationProviderId(service) ? t('settings.services.composite.badge')
    : ct(servicesType.isCloudVendor(service) ? 'cloud' : servicesType.isMachine(service) ? 'machine' : 'ai');
}
function serviceLabel(service: string): string {return serviceOptions.value.find(item => item.value === service)?.label || service;}
// 旧译文始终标识发起请求时的模型，避免连接配置变化后归属被新模型覆盖。
function cardModel(card: ComparisonCard): string {return card.input ? card.input.model : serviceModel(card.service);}
function languageLabel(value: string): string {
  if (value === 'auto') return translateLegacy('自动检测');
  const option = targetLanguageOptions.value.find(item => item.value === value);
  return getMultilingualTargetLanguageLabel(value, option?.label || value, language.value);
}
function currentInput(service: string) {return {text: sourceText.value.trim(), sourceLanguage: sourceLanguage.value,
  targetLanguage: targetLanguage.value, model: serviceModel(service), connectionFingerprint: getCompositeTranslationConfigFingerprint(config, service)};}
function isStale(card: ComparisonCard) {return isComparisonStale(card, currentInput(card.service));}
function cardStatus(card: ComparisonCard): string {
  if (card.status === 'loading') return 'loading';
  if (card.input && isStale(card)) return 'stale';
  if (card.status === 'success' || card.status === 'error' || card.status === 'cancelled') return card.status;
  return credentialWarning(card.service) ? 'needsConfig' : 'ready';
}
const filteredServiceGroups = computed(() => {
  const keyword = serviceSearchQuery.value.toLocaleLowerCase();
  const items = serviceOptions.value.filter(item => {
    const modelOptions = getCustomOpenAIProviderModels(customOpenAIProviders.value, item.value);
    const searchableModels = modelOptions.length ? modelOptions : [...(models.get(item.value) || []), ...(config.customModels[item.value] || [])];
    return [item.label, item.value, item.description || '', ...searchableModels, serviceModel(item.value)].join(' ').toLocaleLowerCase().includes(keyword);
  });
  return [
    {key: 'ready', label: ct('configuredGroup'), items: items.filter(item => !credentialWarning(item.value))},
    {key: 'configure', label: ct('configureGroup'), items: items.filter(item => !!credentialWarning(item.value))},
  ].filter(group => group.items.length);
});
function sameOrder(left: string[], right: string[]): boolean {return left.length === right.length && left.every((service, index) => service === right[index]);}
function getCurrentServiceOrder(): string[] {return cards.value.map(card => card.service);}
function persistTranslationCenterConfig(...fields: TranslationCenterConfigField[]): void {
  if (!configHydrated.value || disposed) return;
  const requestedFields = new Set([...failedSave, ...fields]);
  const patch: TranslationCenterConfigPatch = {};
  if (requestedFields.has('services')) {
    const available = getCurrentServiceOrder();
    const stored = config.translationCenterServices;
    const translationCenterServices = stored.flatMap(service => {
      if (!isTranslationServiceAvailable(service)) return [service];
      const replacement = available.shift();
      return replacement ? [replacement] : [];
    }).concat(available);
    if (!sameOrder(translationCenterServices, stored)) patch.translationCenterServices = translationCenterServices;
  }
  if (requestedFields.has('source') && sourceLanguage.value !== config.translationCenterSourceLanguage) patch.translationCenterSourceLanguage = sourceLanguage.value;
  if (requestedFields.has('target') && targetLanguage.value !== config.translationCenterTargetLanguage) patch.translationCenterTargetLanguage = targetLanguage.value;
  if (requestedFields.has('layout') && resultLayout.value !== config.translationCenterLayout) patch.translationCenterLayout = resultLayout.value;
  if (Object.keys(patch).length === 0) {
    requestedFields.forEach(field => failedSave.delete(field));
    if (!failedSave.size && !pendingSave.size) saveState.value = 'idle';
    return;
  }
  const sequence = ++saveSequence;
  requestedFields.forEach(field => pendingSave.set(field, sequence));
  const settleSave = (success: boolean) => {
    if (disposed) return;
    requestedFields.forEach(field => {
      if (pendingSave.get(field) !== sequence) return;
      pendingSave.delete(field);
      if (success) failedSave.delete(field); else failedSave.add(field);
    });
    if (saveTimer) clearTimeout(saveTimer);
    if (failedSave.size) saveState.value = 'error';
    else if (pendingSave.size) saveState.value = 'idle';
    else {saveState.value = 'saved'; saveTimer = setTimeout(() => {saveState.value = 'idle';}, 1800);}
  };
  void requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime)).then(() => {
    settleSave(true);
  }).catch(() => {settleSave(false);});
}
function retrySave() {persistTranslationCenterConfig(...failedSave);}
function hydrateTranslationCenterConfig(nextConfig = config): void {
  translationEnabled.value = nextConfig.on;
  if (!translationEnabled.value) session.stop();
  customOpenAIProviders.value = nextConfig.customOpenAIProviders.map(provider => ({...provider, models: [...provider.models]}));
  configRevision.value++;
  const available = new Set(serviceOptions.value.map(item => item.value));
  const storedOrder = [...new Set(nextConfig.translationCenterServices.filter(service => available.has(service)))];
  // 空配置是首次使用，只选免密钥服务和用户已配置的网页默认服务。
  const defaults = [...new Set([nextConfig.service, 'freeTranslation', 'google'])].filter(service => available.has(service) && !credentialWarning(service)).slice(0, 3);
  const nextOrder = storedOrder.length ? storedOrder : defaults;
  if (!draggingService.value && !pendingSave.has('services') && !failedSave.has('services') && !sameOrder(getCurrentServiceOrder(), nextOrder)) session.syncServices(nextOrder);
  const storedSource = nextConfig.translationCenterSourceLanguage || nextConfig.from || 'auto';
  const storedTarget = nextConfig.translationCenterTargetLanguage || nextConfig.to || 'zh-Hans';
  if (!pendingSave.has('source') && !failedSave.has('source')) sourceLanguage.value = sourceLanguageOptions.value.some(item => item.value === storedSource) ? storedSource : 'auto';
  if (!pendingSave.has('target') && !failedSave.has('target')) targetLanguage.value = targetLanguageOptions.value.some(item => item.value === storedTarget) ? storedTarget : 'zh-Hans';
  if (!pendingSave.has('layout') && !failedSave.has('layout')) resultLayout.value = nextConfig.translationCenterLayout;
}
function addService(service: string): void {if (!selectedServiceValues.value.has(service)) {session.syncServices([...getCurrentServiceOrder(), service]); persistTranslationCenterConfig('services');}}
function removeService(service: string): void {if (cards.value.length > 1) {session.syncServices(getCurrentServiceOrder().filter(item => item !== service)); persistTranslationCenterConfig('services');}}
function toggleService(service: string) {if (selectedServiceValues.value.has(service)) removeService(service); else addService(service);}
function configureService(service: string) {closePicker(false); emit('configure-service', service);}
function swapLanguages(): void {if (sourceLanguage.value !== 'auto') {[sourceLanguage.value, targetLanguage.value] = [targetLanguage.value, sourceLanguage.value]; persistTranslationCenterConfig('source', 'target');}}
function setLayout(layout: 'list' | 'grid') {resultLayout.value = layout; persistTranslationCenterConfig('layout');}
function useExample() {sourceText.value = 'Good design makes complex things feel simple.'; sourceEditor.value?.focus();}
function clearSource() {session.stop(); sourceText.value = ''; feedback.value = ''; sourceEditor.value?.focus();}
function runTranslation() {if (canTranslate.value && !isRunning.value) void session.run(readyCards.value.map(card => card.service), currentInput);}
function retryService(service: string) {if (canTranslate.value && !credentialWarning(service)) void session.run([service], currentInput);}
function retryIncomplete() {if (canTranslate.value) void session.run(incompleteCards.value.map(card => card.service), currentInput);}
function handleEditorKeydown(event: KeyboardEvent) {
  if (props.surface !== 'sidebar') {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {event.preventDefault(); runTranslation();}
    return;
  }
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  if (!event.ctrlKey && !event.metaKey && (event.shiftKey || event.altKey)) return;
  event.preventDefault();
  if (!event.repeat) runTranslation();
}
async function toggleServicePicker() {if (servicePickerOpen.value) {closePicker(true); return;} servicePickerOpen.value = true; await nextTick(); serviceSearch.value?.focus();}
function closePicker(restoreFocus: boolean) {servicePickerOpen.value = false; serviceSearchQuery.value = ''; if (restoreFocus) servicePickerTrigger.value?.focus();}
function closeServicePicker(event: Event) {if (!servicePicker.value?.contains(event.target as Node)) closePicker(false);}
function closePickerOnFocus(event: FocusEvent) {if (servicePickerOpen.value && !servicePicker.value?.contains(event.target as Node)) closePicker(false);}
function reorderCards(fromService: string, targetService: string): void {
  const order = getCurrentServiceOrder(), from = order.indexOf(fromService), target = order.indexOf(targetService);
  if (from < 0 || target < 0 || from === target) return;
  order.splice(from, 1); order.splice(target, 0, fromService); session.syncServices(order); persistTranslationCenterConfig('services');
}
function moveCard(service: string, offset: number) {const order = getCurrentServiceOrder(), index = order.indexOf(service), target = index + offset; if (index >= 0 && target >= 0 && target < order.length) reorderCards(service, order[target]);}
function startPointerDrag(service: string, event: PointerEvent) {
  if (event.button !== 0) return;
  endCardDrag(); pointerDrag = {service, pointerId: event.pointerId, previousUserSelect: document.body.style.userSelect};
  draggingService.value = service; document.body.style.userSelect = 'none';
  document.addEventListener('pointermove', handlePointerMove); document.addEventListener('pointerup', finishPointerDrag); document.addEventListener('pointercancel', finishPointerDrag); window.addEventListener('blur', endCardDrag);
}
function handlePointerMove(event: PointerEvent) {if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return; const service = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.translation-result-card')?.dataset.service; dragOverService.value = service && service !== pointerDrag.service ? service : '';}
function finishPointerDrag(event: PointerEvent) {if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return; if (event.type !== 'pointercancel' && dragOverService.value) reorderCards(pointerDrag.service, dragOverService.value); endCardDrag();}
function endCardDrag() {const wasDragging = !!pointerDrag; if (pointerDrag) document.body.style.userSelect = pointerDrag.previousUserSelect; pointerDrag = null; document.removeEventListener('pointermove', handlePointerMove); document.removeEventListener('pointerup', finishPointerDrag); document.removeEventListener('pointercancel', finishPointerDrag); window.removeEventListener('blur', endCardDrag); draggingService.value = ''; dragOverService.value = ''; if (wasDragging && configHydrated.value && !disposed) hydrateTranslationCenterConfig();}
async function copyText(text: string, key: string) {
  if (!text) return;
  try {await navigator.clipboard.writeText(text); if (disposed) return; copiedService.value = key; feedback.value = ct('copied'); if (copiedTimer) clearTimeout(copiedTimer); copiedTimer = setTimeout(() => {copiedService.value = ''; feedback.value = '';}, 1800);}
  catch {if (!disposed) feedback.value = ct('copyError');}
}
function copyResult(card: ComparisonCard) {void copyText(card.result, card.service);}
function copyAllResults() {void copyText(successfulCards.value.map(card => serviceLabel(card.service) + '\n' + card.result).join('\n\n'), 'all');}
onMounted(async () => {
  await configReady; if (disposed) return; hydrateTranslationCenterConfig(); configHydrated.value = true;
  unsubscribeConfig = subscribeConfig(nextConfig => {if (configHydrated.value && !disposed) hydrateTranslationCenterConfig(nextConfig);});
  document.addEventListener('pointerdown', closeServicePicker); document.addEventListener('focusin', closePickerOnFocus);
  if (props.surface === 'sidebar') {
    // 缓存的原生面板可能在 close 事件投递前冻结；hidden 是取消上游的最后可执行时机，输入和已完成结果不因此清除。
    const stopHiddenSidebar = () => {if (document.visibilityState === 'hidden') session.stop();};
    document.addEventListener('visibilitychange', stopHiddenSidebar);
    unsubscribeSidebar = () => document.removeEventListener('visibilitychange', stopHiddenSidebar);
  }
});
onUnmounted(() => {disposed = true; session.dispose(); endCardDrag(); unsubscribeConfig?.(); unsubscribeSidebar?.(); document.removeEventListener('pointerdown', closeServicePicker); document.removeEventListener('focusin', closePickerOnFocus); if (copiedTimer) clearTimeout(copiedTimer); if (saveTimer) clearTimeout(saveTimer);});
</script>
<style scoped>
.translation-center { display: flex; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; height: 100%; padding: 22px 26px; color: var(--ink); background: var(--surface-soft); overflow: hidden; }
.translation-paused a { color: var(--brand-strong); text-underline-offset: 3px; }
.translation-center * { box-sizing: border-box; }
.translation-center-intro { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none; min-height: 20px; }
.translation-center-intro p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }.save-status { white-space: nowrap; color: var(--muted); font-size: 11px; }
.translation-capability-warning, .input-notice { margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); background: var(--surface-soft); font-size: 12px; line-height: 1.6; }
.translation-center-layout { display: grid; grid-template-columns: minmax(280px, .85fr) minmax(0, 1.35fr); gap: 18px; min-height: 0; flex: 1; }
.translation-input-panel, .translation-results-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.translation-input-panel { padding: 20px; }.translation-results-panel { padding: 20px 16px 10px; }
.translation-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none; }.translation-panel-heading h3 { margin: 0; font-size: 15px; line-height: 1.5; font-weight: 650; }
.translation-center-toolbar { display: flex; align-items: flex-end; gap: 8px; margin: 22px 0 16px; }.language-picker-group { display: grid; gap: 7px; min-width: 0; flex: 1; }.language-picker-group label { font-size: 11px; color: var(--muted); }.language-swap-button { margin-bottom: 2px; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: none; padding: 0; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 7px; cursor: pointer; }.icon-button:hover:not(:disabled) { color: var(--ink); background: var(--surface-soft); border-color: var(--line); }
.translation-editor { position: relative; display: flex; min-height: 180px; flex: 1; }.translation-editor textarea { width: 100%; height: 100%; min-height: 180px; padding: 14px 14px 52px; color: var(--ink); background: var(--surface-soft); border: 1px solid var(--line); border-radius: 10px; resize: none; font: inherit; font-size: 14px; line-height: 1.85; }.translation-editor textarea::placeholder { color: var(--muted); opacity: .85; }
.example-button { position: absolute; bottom: 14px; left: 14px; display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--ink); background: var(--surface); cursor: pointer; font-size: 12px; }
.translation-input-meta { display: flex; justify-content: space-between; gap: 10px; margin: 10px 0 16px; font-size: 11px; color: var(--muted); }.translation-input-footer { flex: none; padding-top: 8px; }.translation-input-footer p { margin: 11px 0 0; font-size: 11px; line-height: 1.7; color: var(--muted); }
.translate-primary-button, .translate-stop-button { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; min-height: 42px; padding: 10px 16px; border: 1px solid transparent; border-radius: 9px; color: var(--skin-action-text, #fff); background: var(--brand-strong); cursor: pointer; font-size: 13px; font-weight: 600; }.translate-primary-button:hover:not(:disabled) { background: var(--brand-strong); }.translate-stop-button { color: var(--ink); background: var(--surface-soft); border-color: var(--line); }.translate-primary-button kbd { font: inherit; font-size: 11px; opacity: .85; }
.results-heading { align-items: flex-start; margin: 0 4px 14px; }.result-count { display: inline-block; margin-left: 5px; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 500; color: var(--muted); background: var(--surface-soft); vertical-align: 1px; }.results-help { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.add-service-button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 7px 10px; white-space: nowrap; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); cursor: pointer; font-size: 12px; }.add-service-button:hover { border-color: var(--brand); color: var(--brand-strong); }
.results-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: none; padding: 0 4px 14px; }.results-layout-control { display: flex; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }.results-layout-control button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 8px; border: 0; border-radius: 5px; font-size: 11px; color: var(--muted); background: transparent; cursor: pointer; white-space: nowrap; }.results-layout-control button[aria-pressed="true"] { color: var(--ink); background: var(--surface); box-shadow: 0 1px 3px rgb(0 0 0 / .05); }.results-heading-actions { display: flex; align-items: center; gap: 12px; }
.text-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 0; border: 0; color: var(--brand-strong); background: transparent; cursor: pointer; font-size: 11px; line-height: 1.5; }.text-button:hover:not(:disabled) { text-decoration: underline; }
.results-stale-notice { display: flex; align-items: flex-start; gap: 7px; flex: none; margin: 0 4px 12px; padding: 9px 10px; color: var(--muted); background: var(--surface-soft); border-radius: 8px; font-size: 11px; line-height: 1.7; }
.translation-result-list { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 1px 4px 12px; flex: 1; }.translation-result-list.is-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.translation-result-card { min-width: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; transition: border-color .15s; }.translation-result-card.is-dragging { opacity: .55; }.translation-result-card.is-drag-over { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.translation-result-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 0 6px; }.translation-result-service-name { display: flex; align-items: center; gap: 8px; min-width: 0; }.translation-result-service-name > div { min-width: 0; }.translation-result-service-name strong { display: block; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }.translation-result-service-name small { display: block; margin-top: 3px; max-width: 220px; color: var(--muted); font-size: 10px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.translation-result-card-actions { display: flex; align-items: center; gap: 6px; flex: none; }.result-state { color: var(--muted); font-size: 10px; white-space: nowrap; }.result-state.loading { color: var(--brand-strong); }.result-state.error { color: var(--fr-danger); }.drag-handle { width: 24px; cursor: grab; touch-action: none; }.remove-service-button { width: 24px; height: 28px; }
.translation-result-placeholder { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; min-height: 90px; padding: 18px; color: var(--muted); font-size: 12px; line-height: 1.7; }.translation-result-placeholder p { margin: 0; }.needs-configuration { background: var(--surface-soft); margin: 14px 14px 0; min-height: 70px; border-radius: 8px; padding: 12px; }
.loading-bars { display: inline-flex; align-items: center; gap: 3px; }.loading-bars i { width: 3px; height: 12px; border-radius: 2px; background: var(--brand); animation: comparison-pulse 1s ease-in-out infinite alternate; }.loading-bars i:nth-child(2) { animation-delay: .2s; }.loading-bars i:nth-child(3) { animation-delay: .4s; }
.translation-result-content { padding: 14px 18px 0; }.translation-result-content p { margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.85; }.translation-result-content footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 10px; line-height: 1.6; }.translation-result-content footer > div { display: flex; gap: 10px; }
.translation-result-error { padding: 14px 18px 0; font-size: 12px; line-height: 1.7; }.translation-result-error p { margin: 0 0 8px; overflow-wrap: anywhere; color: var(--fr-danger); }.card-connection-footer { display: flex; justify-content: flex-end; padding: 7px 18px 10px; }.card-connection-footer .text-button { color: var(--muted); font-size: 10px; }
.translation-center-feedback { flex: none; margin: 0 4px; color: var(--muted); font-size: 11px; line-height: 1.6; }.translation-center-feedback:empty { display: none; }
.translation-center-service-picker { position: relative; flex: none; }.service-picker-popover { position: absolute; z-index: 30; top: calc(100% + 8px); right: 0; display: flex; flex-direction: column; width: 360px; max-width: calc(100vw - 48px); max-height: min(560px, calc(100vh - 200px)); padding: 16px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink); background: var(--surface); box-shadow: 0 12px 36px rgb(20 30 50 / .12); }
.service-picker-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex: none; }.service-picker-header strong { font-size: 14px; }.service-picker-header p { margin: 6px 0 12px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.service-picker-search { display: flex; align-items: center; gap: 9px; flex: none; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface-soft); }.service-picker-search input { min-width: 0; width: 100%; color: var(--ink); background: transparent; border: 0; outline: none; font-size: 12px; }.service-picker-search:focus-within { border-color: var(--brand); }
.service-picker-groups { overflow-y: auto; min-height: 0; padding-top: 12px; overscroll-behavior: contain; }.service-picker-group + .service-picker-group { margin-top: 14px; }.service-picker-group-heading { display: flex; justify-content: space-between; padding: 0 4px 8px; color: var(--muted); font-size: 11px; }.service-picker-row { position: relative; display: flex; align-items: center; border-radius: 7px; }.service-picker-row:hover { background: var(--surface-soft); }
.service-picker-option { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; min-height: 52px; width: 100%; padding: 8px; border: 0; border-radius: 7px; text-align: left; color: var(--ink); background: transparent; cursor: pointer; }.service-picker-option[aria-pressed="true"] { color: var(--brand-strong); }.service-picker-option-copy { min-width: 0; flex: 1; }.service-picker-option-copy strong { display: block; font-size: 12px; }.service-picker-option-copy small { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 10px; }.picker-configure { padding: 6px; white-space: nowrap; color: var(--muted); font-size: 10px; }
.service-picker-footer { flex: none; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }.picker-empty { color: var(--muted); font-size: 12px; }
.translation-center button:disabled { opacity: .45; cursor: not-allowed; }.translation-center button:focus-visible, .translation-editor textarea:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
:global(:root.dark .translation-center .translate-primary-button) { color: var(--skin-action-text, #172033); background: var(--brand); }
@keyframes comparison-pulse { from { opacity: .35; transform: scaleY(.55); } to { opacity: 1; transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) { .loading-bars i { animation: none; }.translation-result-card { transition: none; } }
@media (max-width: 1200px) { .translation-center { padding: 18px; }.translation-center-layout { grid-template-columns: minmax(260px, .9fr) minmax(0, 1.1fr); gap: 14px; }.translation-input-panel { padding: 16px; }.translation-result-list.is-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) { .translation-center { overflow-y: auto; }.translation-center-layout { display: flex; flex-direction: column; flex: none; }.translation-input-panel { min-height: 390px; }.translation-editor { min-height: 170px; }.translation-results-panel { min-height: 320px; }.translation-result-list { overflow: visible; flex: none; }.translation-result-list.is-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .translation-center { padding: 12px; gap: 12px; }.translation-center-intro { align-items: flex-start; }.translation-center-intro p { font-size: 11px; }.translation-input-panel, .translation-results-panel { padding: 16px 12px; border-radius: 11px; }.translation-result-list.is-grid { grid-template-columns: minmax(0, 1fr); }.results-heading { gap: 8px; }.results-heading h3 { font-size: 14px; }.results-controls { flex-wrap: wrap; }.results-heading-actions { gap: 10px; }.service-picker-popover { width: 330px; max-width: calc(100vw - 56px); max-height: 480px; }.translation-result-service-name small { max-width: 140px; }.translation-center-toolbar { margin-top: 16px; }.translation-result-content { padding-right: 14px; padding-left: 14px; } }
</style>
