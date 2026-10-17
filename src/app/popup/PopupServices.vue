<!--
 @file src/app/popup/PopupServices.vue
 文件职责：在 Popup 翻译服务抽屉中展示功能分配概览，以独立选择面板替代层叠下拉菜单，让窄弹窗里的服务选择更直观。
 B站匿名讲解只出现在阅读分配中，并展示固定有效模型；写作继续遵循通用AI服务边界。
 主要内容：突出网页默认服务，以紧凑列表展示各功能的独立服务或继承状态，继承行在同一行标出“跟随默认”与实际跟随的服务，且仅在模型与默认服务的配置模型不同时才显示模型行，以统一状态标签呈现服务并让多语言名称完整换行，保留本地图标、配置模型和配置提醒；选择面板合并功能标题、返回与关闭操作，搜索框随列表一起滚动，常用区只放可直接使用的服务，按免费翻译、已配置或正在使用的服务、微软与谷歌、热门服务排序，待配置的服务留在更多服务中，当前选中项始终在常用区，更多服务默认展开并按机器翻译、云服务厂商与 AI 翻译分组，选项下方标出配置模型或待配置状态，支持模型搜索及键盘导航，保留不可用的旧选择，缓存默认、继承或独立行的配置模型及本地化说明，避免将设置中的模型声明为最终请求模型；只让当前活跃配置和所属面板的事件修改草稿，焦点返回复验面板与用户焦点；切换时仅重置所属抽屉的滚动，渲染后在同一归属保护内让搜索框或原分配行可见，不滚动宿主页面；可见区扩大时只修正仍聚焦的同一搜索外框被吸顶标题遮住的位置，保留查询和长列表滚动归属。
 模块边界：复用功能服务映射、模型解析及供应商能力，只修改父级配置草稿；保存由 PopupApp 负责，不请求翻译或处理连接密钥。
 键盘布局：极矮可见区复用同一输入和按钮排成单行，保留原有键盘顺序及控件名称；普通高度保留标题及关闭吸顶、搜索随列表滚动，不因旋转重建查询或会话。
 概览标题：复用原关闭工具行显示本地化标题，窄屏允许标题换行且不压缩关闭命中区。
-->
<template>
  <div ref="panel" class="popup-service-panel" data-i18n-ignore :onKeydown="panelActions.keydown">
    <div v-if="!editing" class="popup-service-toolbar">
      <h2 class="service-overview-title">{{ t('popup.providers.title') }}</h2>
      <button type="button" class="service-panel-close" :aria-label="t('common.close')" :onClick="panelActions.close">×</button>
    </div>
    <div v-if="!editing" class="popup-service-overview">
      <button v-for="row in rows" :key="row.field.id" type="button" class="service-assignment"
        :class="{'default-assignment': !row.field.feature}" :data-feature-service="row.field.id"
        :aria-label="`${t(`featureServices.${row.field.id}`)} · ${row.selectedLabel}`"
        :title="row.warning || (!row.field.feature ? t('featureServices.defaultHelp') : row.selectedLabel)"
        :onClick="row.open">
        <span class="assignment-heading"><strong>{{ t(`featureServices.${row.field.id}`) }}</strong></span>
        <span class="assignment-details">
          <span v-if="row.warning" class="assignment-warning" role="img" :aria-label="row.warning" :title="row.warning">!</span>
          <span class="assignment-value" :class="{'assignment-inherited': row.inherited}">
            <span v-if="row.inherited" class="assignment-follow">{{ t('featureServices.followDefault') }}</span>
            <span class="assignment-service"><ServiceIcon :service="row.service" :label="label(row.service)" size="small" /><span>{{ label(row.service) }}</span></span>
          </span>
          <small v-if="row.showModel" :title="row.model">{{ row.modelLabel }}</small>
        </span>
        <span class="assignment-chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <section v-else class="popup-service-picker" :data-service-picker="editing.id" :aria-label="t(`featureServices.${editing.id}`)">
      <header class="service-picker-heading">
        <button type="button" class="service-picker-back" :aria-label="t('featureServices.back')" :onClick="panelActions.back">←</button>
        <strong>{{ t(`featureServices.${editing.id}`) }}</strong>
        <small v-if="editing.feature?.aiOnly">{{ t('featureServices.aiOnly') }}</small>
        <button type="button" class="service-panel-close service-picker-close" :aria-label="t('common.close')" :onClick="panelActions.close">×</button>
      </header>
      <div class="service-picker-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
        <input ref="searchInput" :value="query" :onInput="panelActions.search" type="search" :aria-label="t('popup.serviceSearchPlaceholder')" :placeholder="t('popup.serviceSearchPlaceholder')" :onKeydown="panelActions.searchKeydown" />
        <button v-if="query" type="button" :aria-label="t('popup.clearSearch')" :onClick="panelActions.clear">×</button>
      </div>
      <div ref="results" class="service-picker-list" role="listbox" :aria-label="t(`featureServices.${editing.id}`)" :onKeydown="panelActions.navigate">
        <button v-if="editing.feature?.inherit && !query.trim()" type="button" role="option" class="service-choice follow-choice"
          data-service-choice="" :aria-selected="!selected(editing.feature)" :onClick="panelActions.inherit">
          <ServiceIcon :service="config.service" :label="label(config.service)" size="small" />
          <span class="service-choice-copy"><strong>{{ t('featureServices.followDefault') }}</strong><small>{{ label(config.service) }}</small></span>
          <span v-if="!selected(editing.feature)" class="service-choice-check" aria-hidden="true">✓</span>
        </button>
        <template v-for="group in choiceGroups" :key="group.id">
          <button v-if="group.toggle" type="button" class="service-picker-more" :aria-expanded="moreOpen" :onClick="panelActions.more">
            <span>{{ t('popup.moreServices') }} <small>{{ moreChoices.length }}</small></span><span class="service-picker-more-arrow" aria-hidden="true">›</span>
          </button>
          <div v-if="group.items.length" role="group" :aria-label="group.label" class="service-choice-group">
            <span class="service-choice-group-label">{{ group.label }}</span>
            <div class="service-choice-grid" :class="{compact: group.id !== 'search'}">
            <button v-for="option in group.items" :key="option.value" type="button" role="option" class="service-choice"
              :data-service-choice="option.value" :aria-selected="selected(editing.feature) === option.value"
              :disabled="option.disabled" :title="option.note ? `${option.label} · ${option.note}` : option.label" :onClick="option.choose">
              <ServiceIcon :service="option.value" :label="option.label" size="small" />
              <span class="service-choice-copy"><strong>{{ option.label }}</strong><small v-if="option.note" :class="{'service-choice-setup': option.needsSetup}">{{ option.note }}</small></span>
              <span v-if="selected(editing.feature) === option.value" class="service-choice-check" aria-hidden="true">✓</span>
            </button>
            </div>
          </div>
        </template>
        <p v-if="!filteredChoices.length" class="service-picker-empty" role="status">{{ t('popup.noServiceFound') }}</p>
      </div>
      <p v-if="editingWarning" class="service-picker-warning" role="status">{{ editingWarning }}</p>
    </section>
  </div>
</template>
<script setup lang="ts">
import {computed, nextTick, ref, shallowRef, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {featureServiceDefinitions, getFeatureService, setFeatureService, getFeatureModel, isFeatureServiceSupported, type FeatureServiceDefinition} from '@/src/core/config/featureServices';
import {models, customModelString, resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {getCustomOpenAIProvider, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {getTranslationServiceUnavailableMessage, isTranslationServiceAvailable} from '@/src/services/translation/capabilities';
import {searchServiceOptions, splitServiceChoices, type ServiceOption, type ServiceSearchOption} from '@/src/ui/view-model/serviceCatalog';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
type Field = {id: string; feature?: FeatureServiceDefinition};
type PickerSession = {field: Field; config: Config; selected: string; service: string; current: () => boolean};
const emit = defineEmits<{close: []}>();
const props = withDefaults(defineProps<{config: Config; serviceOptions: readonly ServiceOption[]; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config]);
// 更多服务默认展开：整个面板随抽屉滚动，用户无需先点开才能浏览全部服务。
const query = ref(''), moreOpen = ref(true), viewRevision = ref(0);
const session = shallowRef<PickerSession | null>(null);
const editing = computed(() => session.value?.field || null);
const searchInput = shallowRef<HTMLInputElement | null>(null);
const results = shallowRef<HTMLElement | null>(null), panel = shallowRef<HTMLElement | null>(null);
const fields: Field[] = [{id: 'default'}, ...featureServiceDefinitions.map(feature => ({id: feature.id, feature}))];
const labels = computed(() => {
  const result = new Map<string, string>();
  for (const option of props.serviceOptions) if (!result.has(option.value)) result.set(option.value, option.label);
  return result;
});
const label = (service: string) => labels.value.get(service) || service;
const selected = (feature?: FeatureServiceDefinition) => feature ? getFeatureService(props.config, feature) : props.config.service;
const effective = (feature?: FeatureServiceDefinition) => selected(feature) || props.config.service;
function selectionMatches(config: Config, field: Field, value: string, service: string) {
  const current = field.feature ? getFeatureService(config, field.feature) : config.service;
  return current === value && (current || config.service) === service;
}
function warning(feature?: FeatureServiceDefinition) {
  const config = props.config, service = effective(feature);
  if (feature && !isFeatureServiceSupported(feature, service, config.customOpenAIProviders)) return `${t(`featureServices.${feature.id}`)} · ${t('featureServices.aiOnly')}`;
  const model = feature ? getFeatureModel(config, feature) : config.model[service];
  const message = getTranslationServiceUnavailableMessage(service) || getMissingCredentialMessage(service, config, model);
  return message ? translateLegacy(message) : '';
}
const rows = computed(() => {
  const token = viewRevision.value, current = capture(), config = props.config;
  const defaultModel = servicesType.isUseModel(config.service) ? resolveConfiguredModel(config.model[config.service], config.customModel[config.service]) : '';
  return fields.map(field => {
    const value = selected(field.feature), service = value || config.service;
    const model = field.feature?.id === 'reading' ? getFeatureModel(config, field.feature) : !servicesType.isUseModel(service) ? '' : field.feature ? getFeatureModel(config, field.feature)
      : resolveConfiguredModel(config.model[service], config.customModel[service]);
    const modelLabel = model ? t('featureServices.configuredModel', {model}) : '';
    const selectedLabel = field.feature?.inherit && !value ? t('featureServices.follow', {service: label(config.service)}) : label(service);
    const inherited = Boolean(field.feature?.inherit && !value), rowWarning = warning(field.feature);
    // 继承行的模型与默认服务相同时不重复展示，只有功能自带模型覆盖时才单独标出。
    return {field, selected: value, service, model, modelLabel, inherited, showModel: Boolean(model && !rowWarning && (!inherited || model !== defaultModel)),
      selectedLabel: modelLabel ? `${selectedLabel} · ${modelLabel}` : selectedLabel,
      warning: rowWarning, open: () => {
        if (current() && token === viewRevision.value && !session.value && selectionMatches(config, field, value, service)) openPicker(field);
      }};
  });
});
const editingWarning = computed(() => editing.value ? warning(editing.value.feature) : '');
const searchableModels = computed(() => {
  const merged = new Map<string, readonly string[]>(models);
  Object.entries(props.config.customModels).forEach(([service, saved]) => merged.set(service, [...new Set([...(merged.get(service) || []).filter(model => model !== customModelString), ...saved])]));
  props.config.customOpenAIProviders.forEach(provider => merged.set(provider.id, provider.models));
  return merged;
});
const filteredChoices = computed(() => {
  const feature = editing.value?.feature;
  const available = props.serviceOptions.filter(option => !option.disabled && isTranslationServiceAvailable(option.value)
    && (!isCustomOpenAIProviderId(option.value) || Boolean(getCustomOpenAIProvider(props.config.customOpenAIProviders, option.value)))
    && (!feature || isFeatureServiceSupported(feature, option.value, props.config.customOpenAIProviders)));
  const matches = searchServiceOptions(available, query.value, searchableModels.value, props.config.model, props.config.customModel);
  const current = selected(feature);
  return current && !query.value.trim() && !available.some(option => option.value === current)
    ? [{value: current, label: label(current), disabled: true, matchingModels: []}, ...matches] : matches;
});
// “已配置”指用户填过凭据且当前可直接使用；正在被任一功能使用的服务同样视为用户自己的服务。
function hasCredential(service: string) {
  const config = props.config;
  return Boolean(config.token[service]?.trim()
    || (service === services.youdao && config.youdaoAppKey?.trim())
    || (servicesType.isTencent(service) && config.tencentSecretId?.trim()));
}
const configuredServices = computed(() => {
  const config = props.config;
  const result = new Set([config.service, ...featureServiceDefinitions.map(feature => getFeatureService(config, feature))].filter(Boolean));
  for (const option of props.serviceOptions) {
    if (hasCredential(option.value) && !getMissingCredentialMessage(option.value, config)) result.add(option.value);
  }
  return result;
});
const needsSetupServices = computed(() => new Set(props.serviceOptions
  .filter(option => getMissingCredentialMessage(option.value, props.config)).map(option => option.value)));
const splitChoices = computed(() => splitServiceChoices(filteredChoices.value,
  {configured: configuredServices.value, needsSetup: needsSetupServices.value, selected: selected(editing.value?.feature)}));
const moreChoices = computed(() => splitChoices.value.more);
// 选项副标题：搜索时列出命中的模型；否则可直接使用的 AI 服务显示配置模型，缺少凭据的服务标为待配置。
function choiceNote(option: ServiceSearchOption) {
  const config = props.config;
  if (option.disabled) return {note: translateLegacy(getTranslationServiceUnavailableMessage(option.value) || ''), needsSetup: false};
  if (option.matchingModels.length) return {note: option.matchingModels.join(' · '), needsSetup: false};
  if (needsSetupServices.value.has(option.value)) return {note: t('featureServices.needsSetup'), needsSetup: true};
  const model = servicesType.isUseModel(option.value) && configuredServices.value.has(option.value)
    ? resolveConfiguredModel(config.model[option.value], config.customModel[option.value]) : '';
  return {note: model || '', needsSetup: false};
}
const moreCategories = [
  {id: 'machine', label: 'translationCenter.machine', match: (service: string) => !servicesType.isCloudVendor(service) && !servicesType.isAI(service)},
  {id: 'cloud', label: 'translationCenter.cloud', match: (service: string) => servicesType.isCloudVendor(service)},
  {id: 'ai', label: 'translationCenter.ai', match: (service: string) => servicesType.isAI(service)},
] as const;
const choiceGroups = computed(() => {
  const owned = ownView(), keyword = query.value, expanded = moreOpen.value;
  const bind = (items: readonly ServiceSearchOption[]) => items.map(option => ({...option, ...choiceNote(option), choose: () => {
    if (owned() && query.value === keyword && moreOpen.value === expanded) choose(session.value!, option.value);
  }}));
  if (query.value.trim()) return [{id: 'search', label: t('popup.providers.title'), toggle: false, items: bind(filteredChoices.value)}];
  const more = moreCategories.map(category => ({id: category.id, label: t(category.label), toggle: false,
    items: expanded ? bind(moreChoices.value.filter(option => category.match(option.value))) : []}));
  // 展开按钮固定渲染在更多区的第一个分组之前，用户收起后各分组为空，只留下按钮。
  if (moreChoices.value.length) more[0].toggle = true;
  return [{id: 'common', label: t('popup.commonServices'), toggle: false, items: bind(splitChoices.value.common)}, ...more];
});
function resetPicker() {session.value = null;query.value = '';moreOpen.value = true;viewRevision.value += 1;}
watch(() => [revision.value, session.value && selected(session.value.field.feature), session.value && effective(session.value.field.feature)], () => {
  if (!active.value || (session.value && !ownsSession(session.value))) resetPicker();
}, {flush: 'sync'});
function ownsSession(value: PickerSession) {
  return session.value === value && value.current() && selectionMatches(value.config, value.field, value.selected, value.service);
}
function ownView() {
  const value = session.value, token = viewRevision.value, current = capture();
  return () => current() && token === viewRevision.value && (value ? ownsSession(value) : !session.value);
}
function revealInScroller(scroller: HTMLElement, destination: HTMLElement, sticky: Element | null) {
  const bounds = scroller.getBoundingClientRect(), item = destination.getBoundingClientRect();
  const top = Math.max(bounds.top + scroller.clientTop, sticky?.getBoundingClientRect().bottom ?? bounds.top);
  const bottom = bounds.top + scroller.clientTop + scroller.clientHeight;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
  const delta = item.top < top ? item.top - top
    : item.bottom > bottom ? Math.min(item.top - top, item.bottom - bottom) : 0;
  if (delta) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
}
function revealFocusedSearch(owner: () => boolean) {
  const root = panel.value, input = searchInput.value, current = ownView();
  const scroller = root?.closest<HTMLElement>('.popup-services-drawer .el-drawer__body');
  if (!owner() || !root || !input || !session.value || !scroller || document.activeElement !== input) return;
  void nextTick(() => {
    if (!owner() || !current() || !root.isConnected || searchInput.value !== input || document.activeElement !== input
      || root.closest('.popup-services-drawer .el-drawer__body') !== scroller
      || root.closest('.popup-drawer-modal')?.hasAttribute('data-fluent-read-popup-short')) return;
    const border = input.closest<HTMLElement>('.service-picker-search'), heading = root.querySelector('.service-picker-heading');
    if (!border || !heading) return;
    const item = border.getBoundingClientRect(), cover = heading.getBoundingClientRect();
    // 包括搜索框已完整卷到标题上方的情况；只移动当前抽屉，不重新聚焦或为focus ring额外移动。
    if (item.top < cover.bottom) revealInScroller(scroller, border, heading);
  });
}
defineExpose({revealFocusedSearch});
function focusAfterRender(current: () => boolean, before: Element | null, target: () => HTMLElement | null) {
  const root = panel.value, startedHere = before === document.body || Boolean(before && root?.contains(before));
  const scroller = root?.closest<HTMLElement>('.popup-services-drawer .el-drawer__body');
  const canRestore = () => current() && root?.isConnected && startedHere
    && (document.activeElement === before || document.activeElement === document.body);
  // 两个视图复用同一个滚动容器；先清掉长列表位置，不能让下一帧直接落在概览末尾。
  if (canRestore() && scroller) scroller.scrollTop = 0;
  void nextTick(() => {
    if (!canRestore()) return;
    const destination = target();
    if (destination && scroller?.isConnected && root?.closest('.popup-services-drawer .el-drawer__body') === scroller) {
      revealInScroller(scroller, destination, root.querySelector('.popup-service-toolbar'));
    }
    destination?.focus({preventScroll: true});
  });
}
function openPicker(field: Field) {
  if (!active.value || !fields.includes(field)) return;
  const before = document.activeElement, config = props.config;
  resetPicker();session.value = {field, config, selected: selected(field.feature), service: effective(field.feature), current: capture()};
  // 当前选中项始终在常用区内；转场回顶并只在当前抽屉内恢复搜索位置。
  focusAfterRender(ownView(), before, () => searchInput.value);
}
function backToOverview(value: PickerSession) {
  if (!ownsSession(value)) return;
  const before = document.activeElement, id = value.field.id;
  resetPicker();focusAfterRender(ownView(), before, () => panel.value?.querySelector<HTMLButtonElement>(`[data-feature-service="${id}"]`) || null);
}
function choose(value: PickerSession, service: string) {
  if (!ownsSession(value)) return;
  const feature = value.field.feature, config = value.config;
  if (service && !filteredChoices.value.some(option => option.value === service && !option.disabled)) return;
  if (!service && !feature?.inherit) return;
  // 写入会同步失效会话，所以先安排所属面板的返回，再修改捕获的配置。
  backToOverview(value);
  if (feature) setFeatureService(config, feature, service);else config.service = service;
}
function navigateOptions(event: KeyboardEvent) {
  const buttons = [...(results.value?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
const panelActions = computed(() => {
  const owned = ownView(), value = session.value, keyword = query.value, expanded = moreOpen.value;
  const ownsControls = () => owned() && query.value === keyword && moreOpen.value === expanded;
  return {
    close: () => {if (owned()) {resetPicker();emit('close');}},
    back: () => {if (owned() && value) backToOverview(value);},
    inherit: () => {if (ownsControls() && value) choose(value, '');},
    search: (event: Event) => {if (ownsControls() && event.target === searchInput.value) query.value = searchInput.value?.value || '';},
    clear: () => {if (ownsControls()) {query.value = '';searchInput.value?.focus({preventScroll: true});}},
    more: () => {if (ownsControls()) moreOpen.value = !expanded;},
    searchKeydown: (event: KeyboardEvent) => {
      if (ownsControls() && event.key === 'ArrowDown') {event.preventDefault();results.value?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus();}
    },
    navigate: (event: KeyboardEvent) => {if (ownsControls()) navigateOptions(event);},
    keydown: (event: KeyboardEvent) => {if (owned() && value && event.key === 'Escape') {event.stopPropagation();backToOverview(value);}},
  };
});
</script>
<style scoped>
.popup-service-toolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin-bottom: 8px; background: var(--surface); }
.service-overview-title { flex: 1; min-width: 0; margin: 0; color: var(--ink); font-size: 12px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.service-panel-close { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; color: var(--muted); background: var(--surface-soft); font-size: 22px; cursor: pointer; }
.service-panel-close:hover { color: var(--ink); background: var(--brand-soft); }
.popup-service-overview { display: grid; grid-template-columns: minmax(0, 1fr); }
.service-assignment { display: grid; grid-template-columns: fit-content(45%) minmax(0, 1fr) 8px; align-items: center; gap: 8px; min-width: 0; min-height: 36px; padding: 6px 8px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.service-assignment:last-child { border-bottom: 0; }
.service-assignment:hover { border-radius: 8px; background: var(--surface-soft); }
.default-assignment { min-height: 44px; margin-bottom: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.default-assignment:hover { border-color: var(--brand); background: var(--brand-soft); }
.assignment-heading { min-width: 0; font-size: 11px; line-height: 1.4; }
.assignment-heading strong { font-weight: 600; }
.default-assignment .assignment-heading strong { font-weight: 650; }
.assignment-details { display: grid; grid-template-columns: auto minmax(0, auto); align-items: center; justify-content: end; justify-items: end; gap: 1px 5px; min-width: 0; }
/* 服务值不再套方框：图标加名称单行右对齐；空间不足时“跟随默认”折到名称上方，长名称在自己的行内换行。 */
.assignment-value { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 1px 5px; max-width: 100%; min-width: 0; font-size: 10.5px; line-height: 1.4; }
.assignment-service { display: flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; }
.assignment-service :deep(.service-brand-icon) { width: 18px; height: 18px; border-radius: 6px; }
.assignment-service > span:last-child { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.assignment-follow { flex: none; color: var(--muted); font-size: 10px; white-space: nowrap; }
.assignment-follow::after { content: "·"; margin-left: 5px; }
.assignment-inherited .assignment-service { color: var(--muted); }
.assignment-details > small { grid-column: 2; max-width: 100%; overflow: hidden; color: var(--muted); font-size: 9px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.assignment-warning { grid-column: 1; grid-row: 1; display: grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-strong); font-size: 10px; font-weight: 600; }
.assignment-chevron { color: var(--muted); font-size: 16px; line-height: 1; }
.service-picker-heading { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding-bottom: 10px; background: var(--surface); }
.service-picker-heading > strong { min-width: 0; flex: 1; font-size: 12px; }
.service-picker-heading > small { max-width: 100px; color: var(--muted); font-size: 9px; }
.service-picker-back { flex: none; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--ink); cursor: pointer; }
.service-picker-search { min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); }
.service-picker-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.service-picker-search > svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.service-picker-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 10px; }
.service-picker-search input::-webkit-search-cancel-button { display: none; }
.service-picker-search button { flex: none; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.service-picker-list { position: relative; margin-top: 8px; }
.service-choice-grid.compact { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.service-choice-grid.compact .service-choice { min-width: 0; padding: 6px 4px; gap: 6px; }
.service-choice-grid.compact .service-choice-copy strong { font-size: 10px; overflow-wrap: anywhere; }
.service-choice-grid.compact .service-choice-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.service-choice-group-label { display: block; padding: 8px 4px 5px; color: var(--muted); font-size: 10px; }
.service-choice { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 38px; padding: 6px 8px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.service-choice:hover:not(:disabled) { background: var(--surface-soft); }
.service-choice[aria-selected="true"] { border-color: color-mix(in srgb, var(--brand) 24%, transparent); background: var(--brand-soft); color: var(--brand-strong); }
.service-choice:disabled { opacity: .6; cursor: not-allowed; }
.service-choice-copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
.service-choice-copy strong { font-size: 11px; font-weight: 550; }
.service-choice-copy small { color: var(--muted); font-size: 9px; line-height: 1.5; overflow-wrap: anywhere; }
.service-choice-setup { opacity: .8; }
.service-choice-check { flex: none; font-size: 14px; color: var(--brand-strong); }
.follow-choice { margin-bottom: 3px; border-color: var(--line); }
.service-picker-more { display: flex; justify-content: space-between; align-items: center; width: 100%; min-height: 34px; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface-soft); font-size: 11px; cursor: pointer; }
.service-picker-more small { margin-left: 4px; color: var(--muted); font-size: 9px; }
.service-picker-more-arrow { color: var(--muted); font-size: 14px; line-height: 1; transition: transform 160ms ease; transform: rotate(90deg); }
.service-picker-more[aria-expanded="true"] .service-picker-more-arrow { transform: rotate(-90deg); }
.service-picker-empty { padding: 15px 4px; color: var(--muted); font-size: 11px; text-align: center; }
.service-picker-warning { margin: 10px 0 0; color: var(--muted); font-size: 10px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
