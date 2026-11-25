<!--
 * @file src/features/settings/ui/services/ModelPicker.vue
 * 文件职责：为翻译服务提供紧凑、有界的模型选择与自定义模型增删界面。
 * 主要内容：使用 Teleport 弹层搜索和选择模型，以局部草稿提交新增模型，并为可删除模型提供独立操作。
 * 模块边界：组件只发出选择、添加和删除事件，不直接修改 Config 或持久化数据；模型容量和规范化由 core/config 负责。
 -->
<template>
  <div class="model-picker" data-testid="model-picker" :onKeydown="withKeys(withModifiers(actions.close, ['stop']), ['esc'])">
    <ElPopover
      :key="`${revision}:${pickerContentKey}`"
      :disabled="!active"
      :visible="pickerOpen"
      :onUpdate:visible="actions.open"
      placement="bottom-start"
      trigger="click"
      transition="model-picker-instant"
      :width="440"
      :teleported="true"
      :persistent="false"
      :show-arrow="false"
      :offset="6"
      popper-class="model-picker-popper"
    >
      <template #reference>
        <button
          ref="pickerTrigger"
          :disabled="!active"
          type="button"
          class="model-picker-trigger"
          data-testid="model-picker-trigger"
          aria-haspopup="dialog"
          :aria-expanded="pickerOpen"
          :aria-label="`选择模型，当前模型：${selectedModel || '未选择'}`"
        >
          <span>
            <strong :title="selectedModel || '未选择模型'">{{ selectedModel || '未选择模型' }}</strong>
            <small>{{ options.length }} 个模型，点击切换</small>
          </span>
          <b aria-hidden="true">⌄</b>
        </button>
      </template>

      <section class="model-picker-panel" role="dialog" aria-label="选择模型" :onKeydown="withKeys(withModifiers(actions.close, ['stop']), ['esc'])">
        <header class="model-picker-heading">
          <div>
            <strong>选择模型</strong>
            <small>{{ options.length }} 个可用模型</small>
          </div>
          <button
            v-if="allowCustomModels"
            type="button"
            class="model-add-button"
            data-testid="add-custom-model"
            :disabled="addDisabled"
            :aria-describedby="addDisabled ? limitDescriptionId : undefined"
            :onClick="actions.begin"
          >
            + 添加模型
          </button>
        </header>

        <p v-if="allowCustomModels && addDisabled" :id="limitDescriptionId" class="model-limit" data-testid="custom-model-limit" role="status">
          已达到 {{ maximumModels }} 个模型上限
        </p>

        <form v-if="addingModel" class="model-add-form" data-testid="custom-model-form" :onSubmit="withModifiers(actions.submit, ['prevent'])">
          <label :for="modelInputId">模型标识</label>
          <div>
            <input
              :id="modelInputId"
              ref="modelInput"
              :value="modelDraft"
              :onInput="actions.draft"
              type="text"
              autocomplete="off"
              spellcheck="false"
              data-testid="custom-model-input"
              placeholder="例如：gpt-4.1-mini"
              :maxlength="maximumModelLength"
              :aria-invalid="Boolean(modelError)"
              :aria-describedby="modelError ? modelErrorId : undefined"
              :onKeydown="withKeys(withModifiers(actions.cancel, ['prevent', 'stop']), ['esc'])"
            />
            <button type="submit" data-testid="custom-model-submit">添加</button>
            <button type="button" class="plain-button" :onClick="actions.cancel">取消</button>
          </div>
          <p v-if="modelError" :id="modelErrorId" class="model-error" role="alert">{{ modelError }}</p>
        </form>

        <label class="model-picker-search">
          <span class="sr-only">搜索模型</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input v-model.trim="query" type="search" aria-label="搜索模型" placeholder="搜索模型" />
        </label>

        <div v-if="filteredOptions.length" class="model-picker-list" aria-label="可用模型">
          <div
            v-for="option in filteredOptions"
            :key="option.value"
            class="model-picker-chip"
            :class="{ active: selectedModel === option.value }"
            :data-model-id="option.value"
          >
            <button
              type="button"
              class="model-picker-option"
              :aria-pressed="selectedModel === option.value"
              :title="option.value"
              :onClick="actions.select.bind(null, option.value)"
            >
              <strong>{{ option.label || option.value }}</strong>
              <span v-if="selectedModel === option.value" class="model-check" aria-hidden="true">✓</span>
            </button>
            <button
              v-if="option.removable"
              type="button"
              class="model-remove-button"
              :aria-label="`删除模型 ${option.label || option.value}`"
              :data-testid="`remove-custom-model-${option.value}`"
              :onClick="withModifiers(actions.remove.bind(null, option.value), ['stop'])"
            >
              ×
            </button>
          </div>
        </div>
        <p v-else class="model-picker-empty" role="status">没有匹配的模型</p>
      </section>
    </ElPopover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, withKeys, withModifiers } from 'vue'
import {ElPopover} from 'element-plus'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'
import {CUSTOM_OPENAI_RESERVED_MODEL_ID} from '@/src/core/config/customOpenAI'

interface ModelPickerOption {
  value: string
  label?: string
  removable?: boolean
}

const props = withDefaults(defineProps<{
  active?: boolean
  context?: unknown
  contextKey?: string
  options: ModelPickerOption[]
  selectedModel?: string
  maximumModels?: number
  maximumModelLength?: number
  customModelCount?: number
  allowCustomModels?: boolean
}>(), {
  active: true,
  selectedModel: '',
  maximumModels: 50,
  maximumModelLength: 256,
  customModelCount: 0,
  allowCustomModels: true,
})

const emit = defineEmits<{
  select: [value: string]
  add: [value: string]
  remove: [value: string]
}>()

const pickerOpen = ref(false)
const addingModel = ref(false)
const query = ref('')
const modelDraft = ref('')
const modelError = ref('')
const modelInput = ref<HTMLInputElement | null>(null)
const pickerTrigger = ref<HTMLButtonElement | null>(null)
const modelInputId = `model-input-${useId()}`
const modelErrorId = `model-error-${useId()}`
const limitDescriptionId = `model-limit-${useId()}`

const {active, capture, revision} = useSettingsActionContext(() => props.active !== false, () => [props.context, props.contextKey])
let focusRevision = 0
const actions = computed(() => {
  const current = capture()
  return {
    open: (open: boolean) => {if (current()) pickerOpen.value = open && active.value},
    close: () => {if (current()) closePicker()},
    cancel: () => {if (current()) cancelAddModel()},
    draft: (event: Event) => {if (current() && event.target instanceof HTMLInputElement) {modelDraft.value = event.target.value;modelError.value = ''}},
    select: (model: string) => {if (current()) selectModel(model)},
    remove: (model: string) => {if (current()) removeModel(model)},
    submit: () => {if (current()) submitModel()},
    begin: () => {if (current()) void beginAddModel()},
  }
})
const filteredOptions = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return props.options
  return props.options.filter((option) => `${option.label || ''}${option.value}`.toLocaleLowerCase().includes(keyword))
})
// Element Plus caches the teleported slot while open. Remount the popover when
// the parent's saved option list changes so a removed model cannot survive in DOM.
const pickerContentKey = computed(() => props.options
  .map((option) => `${option.value}\u0000${option.label || ''}\u0000${option.removable ? '1' : '0'}`)
  .join('\u0001'))
const allowCustomModels = computed(() => props.allowCustomModels)
const addDisabled = computed(() => !allowCustomModels.value || props.customModelCount >= props.maximumModels)

async function beginAddModel(): Promise<void> {
  if (!active.value || addDisabled.value) return
  const current = capture()
  const revision = ++focusRevision
  addingModel.value = true
  modelDraft.value = ''
  modelError.value = ''
  await nextTick()
  if (current() && revision === focusRevision && addingModel.value) modelInput.value?.focus()
}

function cancelAddModel(): void {
  focusRevision += 1
  addingModel.value = false
  modelDraft.value = ''
  modelError.value = ''
}

function submitModel(): void {
  if (!active.value || !addingModel.value || addDisabled.value) return
  const model = modelDraft.value.trim()
  if (!model) {
    modelError.value = '请输入模型标识'
    return
  }
  if (model.length > props.maximumModelLength) {
    modelError.value = `模型标识最多 ${props.maximumModelLength} 个字符`
    return
  }
  if (model === CUSTOM_OPENAI_RESERVED_MODEL_ID) {
    modelError.value = `“${CUSTOM_OPENAI_RESERVED_MODEL_ID}”是界面保留名称，请换一个模型标识`
    return
  }
  if (props.options.some((option) => option.value === model)) {
    modelError.value = '该模型已经存在'
    return
  }
  cancelAddModel()
  emit('add', model)
}

function selectModel(model: string): void {
  if (!active.value || !props.options.some(option => option.value === model)) return
  closePicker()
  emit('select', model)
}

function removeModel(model: string): void {
  if (!active.value || !props.options.some(option => option.value === model && option.removable)) return
  // Element Plus keeps a teleported popover slot mounted while it is open. Closing
  // before the parent replaces its config snapshot prevents the old slot from lingering.
  closePicker()
  emit('remove', model)
}

function closePicker(): void {
  // Move focus out of the panel before Element Plus applies aria-hidden. Focusing
  // after the visibility update is too late and causes an accessibility warning.
  if (active.value && pickerOpen.value) pickerTrigger.value?.focus({preventScroll: true})
  pickerOpen.value = false
  query.value = ''
  cancelAddModel()
}

watch(() => [active.value, props.context, props.contextKey], () => {
  pickerOpen.value = false
  query.value = ''
  cancelAddModel()
}, {flush: 'sync'})

watch(() => props.selectedModel, () => {
  query.value = ''
})

watch(pickerOpen, (open) => {
  if (open) return
  query.value = ''
  cancelAddModel()
})
</script>

<style scoped>
.model-picker { width: min(100%, 560px); min-width: 0; }
.model-picker-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 44px; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px); color: var(--ink); background: var(--surface); text-align: left; cursor: pointer;
  transition: border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.model-picker-trigger:hover { border-color: color-mix(in srgb, var(--brand) 38%, var(--line)); background: var(--surface-soft); }
.model-picker-trigger > span { display: flex; min-width: 0; flex-direction: column; }
.model-picker-trigger small { margin-top: 2px; color: var(--muted); font-size: var(--fr-text-xs, 11px); }
.model-picker-trigger strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.model-picker-trigger b { color: var(--brand-strong); font-size: 14px; }
:global(.model-picker-popper.el-popper) {
  isolation: isolate;
  max-width: calc(100vw - 24px) !important;
  padding: 0 !important;
  border: 1px solid var(--line) !important;
  border-radius: var(--fr-menu-radius) !important;
  overflow: hidden;
  background: var(--surface) !important;
  box-shadow: var(--fr-menu-shadow) !important;
}
:global(.model-picker-popper.el-popper:not([aria-hidden="true"])) { opacity: 1 !important; }
:global(.model-picker-popper.el-popper .el-popper__arrow::before) {
  border-color: var(--line) !important;
  background: var(--surface) !important;
}
.model-picker-panel { box-sizing: border-box; width: 100%; padding: 14px; color: var(--ink); background: var(--surface); }
.model-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.model-picker-heading > div { display: flex; min-width: 0; flex-direction: column; }
.model-picker-heading strong { font-size: 14px; }
.model-picker-heading small { margin-top: 2px; color: var(--muted); font-size: var(--fr-text-xs, 11px); }
.model-add-button, .model-add-form button {
  padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--brand) 38%, var(--line)); border-radius: var(--fr-control-radius, 8px); color: var(--brand-strong); background: var(--brand-soft); font-size: var(--fr-text-xs, 11px); font-weight: 600; cursor: pointer;
}
.model-add-button:disabled { border-color: var(--line); color: var(--muted); background: var(--surface-soft); opacity: .6; cursor: not-allowed; }
.model-limit { margin: -2px 0 9px; color: var(--fr-warning, #92400e); font-size: var(--fr-text-xs, 11px); }
.model-add-form { margin-bottom: 10px; padding: 10px; border: 1px solid var(--line); border-radius: var(--fr-radius-md, 10px); background: var(--surface-soft); }
.model-add-form > label { display: block; margin-bottom: 6px; color: var(--ink); font-size: var(--fr-text-xs, 11px); font-weight: 600; }
.model-add-form > div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 7px; }
.model-add-form input, .model-picker-search input {
  min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px); color: var(--ink); background: var(--surface); outline: none; font-size: var(--fr-text-sm, 12px);
}
.model-add-form input:focus, .model-picker-search input:focus { border-color: var(--brand); box-shadow: var(--fr-focus-ring, 0 0 0 3px rgba(239, 71, 118, .12)); }
.model-add-form .plain-button { border-color: transparent; color: var(--muted); background: transparent; }
.model-error { margin: 7px 0 0; color: var(--fr-danger, #be123c); font-size: var(--fr-text-xs, 11px); }
.model-picker-search { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 5px; margin-bottom: 9px; color: var(--muted); }
.model-picker-search input { width: 100%; }
.model-picker-list { display: flex; flex-wrap: wrap; max-height: min(300px, 45vh); overflow-y: auto; overscroll-behavior: contain; padding: 1px; gap: 8px; align-content: flex-start; scrollbar-width: thin; }
.model-picker-chip {
  display: flex; flex: 0 1 auto; width: auto; max-width: 100%; min-width: 0; min-height: 38px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface-soft);
}
.model-picker-chip:hover { background: var(--surface-soft); }
.model-picker-chip.active { border-color: var(--brand); color: var(--ink); background: var(--brand-soft); }
.model-picker-option {
  display: flex; flex: 1; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; min-height: 38px; padding: 8px 12px;
  border: 0; color: var(--ink); background: transparent; text-align: left; cursor: pointer;
}
.model-picker-option strong { min-width: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.model-picker-chip.active .model-picker-option { color: var(--ink); }
.model-check { color: var(--brand-strong); font-size: 11px; }
.model-remove-button { width: 28px; padding: 0; border: 0; border-left: 1px solid #efd6dd; color: #a84a62; background: transparent; font-size: 15px; cursor: pointer; }
.model-remove-button:hover { background: #fff0f4; }
.model-picker-empty { margin: 18px 0 8px; color: #9299a8; font-size: 11px; text-align: center; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
:global(:root.dark .model-picker-popper.el-popper),
:global(:root.dark .model-picker-panel) { border-color: var(--line); color: var(--ink); background: var(--surface); }
:global(:root.dark .model-picker-popper.el-popper) { background: var(--surface) !important; box-shadow: var(--fr-menu-shadow) !important; }
:global(:root.dark .model-picker-popper.el-popper .el-popper__arrow::before) { border-color: var(--line) !important; background: var(--surface) !important; }
:global(:root.dark .model-picker-trigger),
:global(:root.dark .model-add-form),
:global(:root.dark .model-add-form input),
:global(:root.dark .model-picker-search input) { border-color: var(--line); color: var(--ink); background: var(--surface-soft); }
:global(:root.dark .model-picker-option) { color: var(--ink); }
:global(:root.dark .model-picker-chip) { border-color: var(--line); }
:global(:root.dark .model-picker-chip.active) { border-color: var(--brand); background: var(--brand-soft); }
@media (max-width: 480px) {
  :global(.model-picker-popper.el-popper) { width: calc(100vw - 24px) !important; }
  .model-add-form > div { grid-template-columns: minmax(0, 1fr) auto; }
  .model-add-form .plain-button { grid-column: 1 / -1; justify-self: start; }
}
</style>
