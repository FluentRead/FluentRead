<!--
 * @file src/features/settings/ui/services/CustomOpenAIProviderDialog.vue
 * 文件职责：在同一窗口添加兼容接口或组合翻译，或加回已移除的目录服务。
 * 主要内容：新建服务共用名称，隔离接口凭据与组合成员草稿；加回服务单独搜索和选择，只提交服务 ID。类型切换、关闭重开、停用与配置替换淘汰旧事件；触屏与窄屏按实际可见视口容纳表单，键盘展开后仍可在窗口内滚动到各字段和操作。
 * 模块边界：不生成服务 ID、不修改 Config、不保存凭据或改变默认服务；外层统一创建、恢复和持久化，组合复用已有普通服务配置。
 -->
<template>
  <el-dialog :model-value="modelValue && active && ownedOpen" width="min(600px, calc(100vw - 28px))" class="custom-openai-provider-dialog" :style="dialogViewportStyle" data-testid="custom-service-dialog" :title="t('settings.services.composite.customTitle')" :close-on-click-modal="false" destroy-on-close :onOpened="actions.focus" :onUpdate:modelValue="actions.update">
    <form class="custom-provider-form" novalidate :onSubmit="withModifiers(actions.submit, ['prevent'])">
      <div class="custom-service-types" role="group" :aria-label="t('settings.services.composite.serviceType')">
        <button v-for="[type, label] in visibleServiceTypes" :key="type" type="button"
          :data-testid="`custom-service-type-${type}`" :aria-pressed="serviceType === type" :disabled="!active"
          :onClick="actions.type.bind(null, type)">{{ t(label) }}</button>
      </div>
      <template v-if="serviceType === 'restore'">
        <label>
          <input type="search" data-testid="custom-service-restore-search" :value="restore.query" :onInput="actions.restore.bind(null, 'query')" :aria-label="t('common.search')" :placeholder="t('common.search')" />
        </label>
        <div v-if="restoreMatches.length" class="restore-service-options" role="group" :aria-label="t('settings.services.library.restoreDirectory')">
          <label v-for="item in restoreMatches" :key="item.value" class="restore-service-option">
            <input type="radio" name="restore-service" :value="item.value" :data-service-restore="item.value" :checked="restore.selection === item.value" :onChange="actions.restore.bind(null, 'selection')" />
            <ServiceIcon :service="item.value" :label="item.label" size="small" />
            <span>{{ item.label }}</span>
          </label>
        </div>
        <p v-else class="restore-service-empty" role="status">{{ t('settings.services.library.empty') }}</p>
      </template>
      <template v-else>
        <label>
          <span>{{ translateLegacy('服务名称') }}</span>
          <input ref="nameInput" :value="draft.name" :onInput="actions.draft.bind(null, 'name')" type="text" autocomplete="off" data-testid="custom-service-name" :placeholder="serviceType === 'interface' ? translateLegacy('例如：本地 Ollama') : t('settings.services.composite.namePlaceholder')" :maxlength="maximumNameLength" :aria-label="translateLegacy('服务名称')" :aria-invalid="Boolean(nameError)" />
          <small v-if="nameError" class="field-error" role="alert">{{ nameError }}</small>
        </label>
        <template v-if="serviceType === 'interface'">
          <label>
            <span>{{ translateLegacy('接口地址') }}</span>
            <input :value="draft.endpoint" :onInput="actions.draft.bind(null, 'endpoint')" type="url" autocomplete="url" data-testid="custom-service-endpoint" placeholder="http://localhost:11434/v1/chat/completions" :maxlength="maximumEndpointLength" :aria-invalid="Boolean(errors.endpoint)" />
            <small>{{ translateLegacy('支持完整 Chat Completions 地址或以 /v1 结尾的 Base URL；模型须支持 Chat Completions') }}</small>
            <small v-if="errors.endpoint" class="field-error" role="alert">{{ translateLegacy(errors.endpoint) }}</small>
          </label>
          <label>
            <span>API Key <small>{{ translateLegacy('可选') }}</small></span>
            <input :value="draft.apiKey" :onInput="actions.draft.bind(null, 'apiKey')" type="password" autocomplete="new-password" data-testid="custom-service-api-key" :placeholder="translateLegacy('留空表示暂不配置')" />
          </label>
          <label>
            <span>{{ translateLegacy('首个模型') }}</span>
            <input :value="draft.model" :onInput="actions.draft.bind(null, 'model')" type="text" autocomplete="off" spellcheck="false" data-testid="custom-service-model" placeholder="例如：gpt-4.1-mini" :maxlength="maximumModelLength" :aria-invalid="Boolean(errors.model)" :onKeydown="withKeys(withModifiers(actions.close, ['stop']), ['esc'])" />
            <small v-if="errors.model" class="field-error" role="alert">{{ translateLegacy(errors.model) }}</small>
          </label>
        </template>
        <CompositeTranslationFields v-else :draft="compositeFormDraft" :members="members" :errors="compositeErrors" :active="active && ownedOpen && serviceType === 'composite'" :context="props.config || props.context" :show-name="false" :onUpdate="actions.composite" />
      </template>
      <footer>
        <button type="button" class="secondary-button" :onClick="actions.close">{{ t('common.cancel') }}</button>
        <button type="submit" class="primary-button" data-testid="custom-service-save" :disabled="serviceType === 'restore' && !canRestore">{{ serviceType === 'restore' ? t('settings.services.library.addService') : translateLegacy('保存服务') }}</button>
      </footer>
    </form>
  </el-dialog>
</template>
<script setup lang="ts">
import {computed, reactive, ref, watch, withKeys, withModifiers} from 'vue'
import {Config} from '@/src/core/config/model'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import {serviceDirectorySearchText, type ServiceOption} from '@/src/ui/view-model/serviceCatalog'
import {useUiI18n, localizeServiceOptions} from '@/src/ui/i18n'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'
import {CUSTOM_OPENAI_RESERVED_MODEL_ID, MAX_CUSTOM_OPENAI_MODEL_LENGTH, MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH, MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH} from '@/src/core/config/customOpenAI'
import {createCompositeTranslationDraft, getCompositeMemberOptions, validateCompositeTranslationDraft, type CompositeTranslationDraft, type CompositeTranslationDraftErrors} from '@/src/ui/view-model/compositeServiceEditor'
import CompositeTranslationFields from './CompositeTranslationFields.vue'
import {getVisualViewportRect, observeVisualViewport} from '@/src/platform/dom/visualViewport'

interface CustomOpenAIProviderDraft {name: string; endpoint: string; apiKey: string; model: string}
const serviceTypes = [
  ['interface', 'settings.services.composite.interfaceType'],
  ['composite', 'settings.services.composite.compositeType'],
  ['restore', 'settings.services.library.restoreDirectory'],
] as const
type CustomServiceType = (typeof serviceTypes)[number][0]
const props = withDefaults(defineProps<{modelValue: boolean; config?: Config; active?: boolean; context?: unknown; restoreServices?: ServiceOption[]; maximumNameLength?: number; maximumEndpointLength?: number; maximumModelLength?: number}>(), {active: true, restoreServices: () => [], maximumNameLength: MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH, maximumEndpointLength: MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH, maximumModelLength: MAX_CUSTOM_OPENAI_MODEL_LENGTH})
const emit = defineEmits<{'update:modelValue': [value: boolean]; submit: [draft: CustomOpenAIProviderDraft]; 'submit:composite': [draft: CompositeTranslationDraft]; 'submit:restore': [service: string]}>()
const {t, translateLegacy} = useUiI18n()
const nameInput = ref<HTMLInputElement | null>(null)
const draft = reactive<CustomOpenAIProviderDraft>({name: '', endpoint: '', apiKey: '', model: ''})
const compositeDraft = reactive(createCompositeTranslationDraft())
const compositeErrors = ref<CompositeTranslationDraftErrors>({})
const serviceType = ref<CustomServiceType>('interface')
const visibleServiceTypes = computed(() => props.restoreServices.length ? serviceTypes : serviceTypes.slice(0, 2))
const restore = reactive({query: '', selection: ''})
const restoreMatches = computed(() => {
  const keyword = restore.query.trim().normalize('NFKC').toLocaleLowerCase()
  return keyword ? props.restoreServices.filter(item => serviceDirectorySearchText(item).includes(keyword)) : props.restoreServices
})
const canRestore = computed(() => restoreMatches.value.some(item => item.value === restore.selection))
const fallbackConfig = new Config()
const memberConfig = computed(() => props.config || fallbackConfig)
const members = computed(() => localizeServiceOptions(getCompositeMemberOptions(memberConfig.value), memberConfig.value.customOpenAIProviders, translateLegacy))
const compositeFormDraft = computed(() => ({...compositeDraft, name: draft.name}))
const ownedOpen = ref(props.modelValue)
const errors = reactive({name: '', endpoint: '', model: ''})
const nameError = computed(() => serviceType.value === 'composite' ? compositeErrors.value.name ? t(compositeErrors.value.name) : '' : translateLegacy(errors.name))
const {active, capture} = useSettingsActionContext(() => props.active !== false, () => [props.context, props.config, props.modelValue, serviceType.value, props.restoreServices])
const dialogViewportStyle = ref<Record<string, string>>()
// 变量只写入本窗口，CSS 决定是否采用触屏布局；订阅随关闭、停用、缓存和卸载释放，不改变表单或焦点归属。
watch(() => props.modelValue && active.value && ownedOpen.value, (open, _previous, onCleanup) => {
  dialogViewportStyle.value = undefined
  if (!open || typeof window === 'undefined') return
  const update = () => {
    if (!props.modelValue || !active.value || !ownedOpen.value) return
    const viewport = getVisualViewportRect()
    dialogViewportStyle.value = {
      '--fluentread-custom-provider-viewport-left': `${viewport.left}px`,
      '--fluentread-custom-provider-viewport-top': `${viewport.top}px`,
      '--fluentread-custom-provider-viewport-width': `${viewport.width}px`,
      '--fluentread-custom-provider-viewport-height': `${viewport.height}px`,
    }
  }
  update()
  onCleanup(observeVisualViewport(update))
}, {flush: 'sync', immediate: true})
const actions = computed(() => {
  const current = capture()
  return {
    close: () => {if (current()) closeDialog()},
    draft: (field: keyof CustomOpenAIProviderDraft, event: Event) => {
      if (!current() || !ownedOpen.value || (field !== 'name' && serviceType.value !== 'interface') || !(event.target instanceof HTMLInputElement)) return
      draft[field] = event.target.value
      if (field !== 'apiKey') errors[field] = ''
      if (field === 'name') compositeErrors.value = {...compositeErrors.value, name: undefined}
    },
    type: (value: CustomServiceType) => {
      if (!current() || !ownedOpen.value || !visibleServiceTypes.value.some(([type]) => type === value)) return
      serviceType.value = value
      errors.name = '';errors.endpoint = '';errors.model = '';compositeErrors.value = {}
    },
    restore: (field: keyof typeof restore, event: Event) => {
      if (current() && ownedOpen.value && serviceType.value === 'restore' && event.target instanceof HTMLInputElement) {
        restore[field] = event.target.value
      }
    },
    composite: (patch: Partial<CompositeTranslationDraft>) => {if (current() && ownedOpen.value && serviceType.value === 'composite') {Object.assign(compositeDraft, patch);compositeErrors.value = {}}},
    focus: () => {if (current()) focusFirstField()},
    submit: () => {if (current()) submitProvider()},
    update: (open: boolean) => {if (current()) updateOpenState(open)},
  }
})
function resetDraft(): void {
  Object.assign(draft, {name: '', endpoint: '', apiKey: '', model: ''})
  Object.assign(compositeDraft, createCompositeTranslationDraft())
  restore.query = ''; restore.selection = ''
  errors.name = '';errors.endpoint = '';errors.model = '';compositeErrors.value = {};serviceType.value = 'interface'
}
function focusFirstField(): void {if (active.value && ownedOpen.value && props.modelValue) nameInput.value?.focus()}
function updateOpenState(value: boolean): void {if (active.value && ownedOpen.value && !value) closeDialog()}
function closeDialog(): void {const wasOpen = ownedOpen.value;ownedOpen.value = false;resetDraft();if (wasOpen) emit('update:modelValue', false)}
function isValidEndpoint(value: string): boolean {try {return ['http:', 'https:'].includes(new URL(value).protocol)} catch {return false}}
function submitProvider(): void {
  if (!active.value || !ownedOpen.value || !props.modelValue) return
  if (serviceType.value === 'restore') {
    if (!canRestore.value) return
    const service = restore.selection
    closeDialog()
    emit('submit:restore', service)
    return
  }
  if (serviceType.value === 'composite') {
    const result = validateCompositeTranslationDraft(compositeFormDraft.value, members.value)
    compositeErrors.value = result.errors
    if (!result.valid) return
    closeDialog();emit('submit:composite', result.draft);return
  }
  const value: CustomOpenAIProviderDraft = {name: draft.name.trim(), endpoint: draft.endpoint.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim()}
  errors.name = !value.name ? '请输入服务名称' : value.name.length > props.maximumNameLength ? `服务名称最多 ${props.maximumNameLength} 个字符` : ''
  errors.endpoint = !value.endpoint ? '请输入接口地址' : value.endpoint.length > props.maximumEndpointLength ? `接口地址最多 ${props.maximumEndpointLength} 个字符` : isValidEndpoint(value.endpoint) ? '' : '请输入有效的 HTTP 或 HTTPS 地址'
  errors.model = !value.model ? '请输入至少一个模型' : value.model.length > props.maximumModelLength ? `模型标识最多 ${props.maximumModelLength} 个字符` : value.model === CUSTOM_OPENAI_RESERVED_MODEL_ID ? `“${CUSTOM_OPENAI_RESERVED_MODEL_ID}”是界面保留名称，请换一个模型标识` : ''
  if (errors.name || errors.endpoint || errors.model) return
  closeDialog();emit('submit', value)
}
watch(() => props.modelValue, open => {resetDraft();ownedOpen.value = open && active.value}, {flush: 'sync'})
watch(() => props.restoreServices, items => {
  if (!items.some(item => item.value === restore.selection)) restore.selection = ''
  if (!items.length && serviceType.value === 'restore') serviceType.value = 'interface'
}, {flush: 'sync'})
watch(() => [active.value, props.context, props.config], () => closeDialog(), {flush: 'sync'})
</script>
<style scoped>
.custom-provider-form { display: grid; gap: 15px; color: var(--ink, #172033); }
.custom-provider-form > label { display: grid; gap: 6px; }
.custom-provider-form > label > span { font-size: 12px; font-weight: 600; }
.custom-provider-form > label > span small, .custom-provider-form > label > small { color: var(--muted, #8b93a4); font-size: 11px; font-weight: 400; line-height: 1.6; }
.custom-provider-form input:not([type="radio"]) { box-sizing: border-box; width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--line, #dfe3eb); border-radius: 8px; color: inherit; background: var(--surface, #fff); font: inherit; font-size: 13px; }
.custom-provider-form input:focus-visible { outline: 2px solid var(--brand, #ef4776); outline-offset: 1px; }
.custom-provider-form input[aria-invalid='true'] { border-color: var(--el-color-danger, #d9345e); }
.custom-provider-form .field-error { color: var(--el-color-danger, #c52f58); }
.custom-service-types { display: inline-grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 3px; padding: 3px; width: fit-content; max-width: 100%; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.custom-service-types button { overflow-wrap: anywhere; min-height: 32px; padding: 5px 14px; border: 0; border-radius: 7px; color: var(--muted); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.custom-service-types button[aria-pressed='true'] { color: var(--brand-strong); background: var(--surface); box-shadow: 0 2px 6px rgba(31, 40, 61, .08); }
.restore-service-options { display: grid; gap: 2px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
.restore-service-option { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 4px 8px; border-radius: 7px; cursor: pointer; overflow-wrap: anywhere; }
.restore-service-option input { flex: none; accent-color: var(--brand, #ef4776); }
.restore-service-option:hover, .restore-service-option:focus-within { background: var(--surface-soft); }
.restore-service-empty { margin: 0; color: var(--muted); font-size: 13px; }
.custom-provider-form footer { display: flex; justify-content: flex-end; gap: 9px; padding-top: 2px; }
.custom-provider-form footer button { min-height: 36px; padding: 7px 14px; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.secondary-button { border: 1px solid var(--line); color: var(--muted); background: var(--surface); }
.primary-button:disabled { opacity: .55; cursor: default; }
.primary-button { border: 1px solid var(--brand, #ef4776); color: #fff; background: var(--brand, #ef4776); }

/* 专属选择器在 Element Plus 的 portal 中同样有效；整窗滚动，极短横屏不为固定页头或页脚预占编辑高度。 */
@media (max-width: 700px), (any-pointer: coarse) {
  :global(.custom-openai-provider-dialog.el-dialog) {
    --fluentread-custom-provider-gap-left: max(14px, env(safe-area-inset-left, 0px));
    --fluentread-custom-provider-gap-right: max(14px, env(safe-area-inset-right, 0px));
    --fluentread-custom-provider-gap-top: max(12px, env(safe-area-inset-top, 0px));
    --fluentread-custom-provider-gap-bottom: max(12px, env(safe-area-inset-bottom, 0px));
    position: fixed;
    top: calc(var(--fluentread-custom-provider-viewport-top, 0px) + var(--fluentread-custom-provider-gap-top));
    left: calc(var(--fluentread-custom-provider-viewport-left, 0px) + var(--fluentread-custom-provider-gap-left) + (var(--fluentread-custom-provider-viewport-width, 100vw) - var(--fluentread-custom-provider-gap-left) - var(--fluentread-custom-provider-gap-right)) / 2);
    transform: translateX(-50%);
    width: min(600px, calc(var(--fluentread-custom-provider-viewport-width, 100vw) - var(--fluentread-custom-provider-gap-left) - var(--fluentread-custom-provider-gap-right)));
    max-height: calc(100vh - 24px);
    max-height: max(0px, calc(var(--fluentread-custom-provider-viewport-height, 100dvh) - var(--fluentread-custom-provider-gap-top) - var(--fluentread-custom-provider-gap-bottom)));
    margin: 0;
    padding: 12px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scroll-padding-block: 12px;
  }
  :global(.custom-openai-provider-dialog .el-dialog__header) { min-height: 32px; padding-bottom: 12px; }
  :global(.custom-openai-provider-dialog .el-dialog__body) { min-width: 0; }
  :global(.custom-openai-provider-dialog .el-dialog__headerbtn) { min-width: 44px; min-height: 44px; }
  .custom-provider-form, .custom-provider-form > label { min-width: 0; }
  .custom-provider-form > label > small { overflow-wrap: anywhere; }
  .custom-provider-form input:not([type="radio"]),
  .custom-provider-form :deep(.composite-fields input),
  .custom-provider-form :deep(.composite-fields select) { min-width: 0; min-height: 44px; font-size: 16px; }
  .custom-service-types { width: 100%; box-sizing: border-box; }
  .custom-service-types button { padding-inline: 8px; }
  .custom-service-types button,
  .custom-provider-form footer button,
  .custom-provider-form :deep(.composite-fields button),
  .custom-provider-form :deep(.composite-strategy-control.segmented-control.compact button) { min-width: 44px; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
  .custom-provider-form footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .custom-provider-form :deep(.composite-setting-row) { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .custom-provider-form :deep(.composite-member-list li) { flex-wrap: wrap; }
  .custom-provider-form :deep(.member-actions) { margin-inline-start: auto; gap: 4px; }
}
</style>
