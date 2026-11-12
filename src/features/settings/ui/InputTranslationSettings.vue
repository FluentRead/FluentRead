<!--
 * @file src/features/settings/ui/InputTranslationSettings.vue
 * 文件职责：承载输入框翻译的一组独立设置，说明触发与输出方式，再按需编辑翻译配置与连按速度。
 * 主要内容：按当前配置、服务与模型限定回调归属，关闭过期面板并保护提示词原文；编辑替换/双语输出顺序模式、三击间隔、输入框翻译服务、AI 模型及独立提示词；机器翻译隐藏不适用的模型与提示词。
 * 模块边界：组件只编排设置页状态并写入父级配置副本，触发方式交由父级处理快捷键冲突，服务能力与持久化仍由外层设置链路负责。
 -->
<template>
  <section class="input-translation-settings" data-testid="input-translation-settings">
    <SettingsGroup :title="t('inputTranslation.title')" :description="workflowDescription">
      <SettingsItem :label="t('inputTranslation.trigger')">
        <template #copy>
          <strong class="settings-item-label"><span>{{ t('inputTranslation.trigger') }}</span><FieldHelp :content="t('inputTranslation.triggerDescription')" /></strong>
          <ElPopover :key="revision" :visible="timingOpen" :onUpdate:visible="actions.timing" :disabled="!active" v-if="inputConfig.inputBoxTranslationTrigger.startsWith('triple_')" trigger="click" placement="bottom-start" :width="280" popper-class="fluentread-settings-number-popover">
            <template #reference>
              <button type="button" class="input-translation-text-button input-translation-timing-link" data-testid="input-translation-timing-toggle">
                {{ t('inputTranslation.adjustTiming') }} · {{ interval }} {{ t('inputTranslation.intervalUnit') }}
              </button>
            </template>
            <div class="input-translation-timing-panel" data-testid="input-translation-timing-panel">
              <strong>{{ t('inputTranslation.interval') }}</strong>
              <p>{{ t('inputTranslation.intervalDescription') }}</p>
              <div class="input-translation-interval-control">
                <el-input-number
                  :model-value="interval"
                  data-testid="input-translation-interval"
                  :aria-label="t('inputTranslation.interval')"
                  :min="INPUT_BOX_TRANSLATION_INTERVAL_MIN"
                  :max="INPUT_BOX_TRANSLATION_INTERVAL_MAX"
                  :step="INPUT_BOX_TRANSLATION_INTERVAL_STEP"
                  :onUpdate:modelValue="actions.interval"
                />
                <span>{{ t('inputTranslation.intervalUnit') }}</span>
              </div>
              <p>{{ t('inputTranslation.intervalHelp') }}</p>
              <button type="button" class="input-translation-text-button" data-testid="input-translation-interval-reset" :aria-label="t('inputTranslation.intervalResetAria')" :disabled="interval === DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL" :onClick="actions.resetInterval">{{ t('inputTranslation.intervalReset') }}</button>
            </div>
          </ElPopover>
        </template>
        <el-select :model-value="props.config.inputBoxTranslationTrigger" data-testid="input-translation-trigger" :aria-label="t('inputTranslation.trigger')" :onChange="actions.trigger">
          <el-option v-for="item in triggerOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </SettingsItem>

      <SettingsItem :label="t('inputTranslation.target')">
        <el-select :model-value="targetLanguage" :onUpdate:modelValue="actions.target" data-testid="input-translation-target" :aria-label="t('inputTranslation.target')">
          <el-option v-for="item in targetOptions" :key="item.value" class="select-left" data-i18n-ignore :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" :value="item.value" />
        </el-select>
      </SettingsItem>

      <SettingsItem :label="t('inputTranslation.outputMode')" :description="outputMode !== 'replace' ? t('inputTranslation.appendHelp') : ''">
        <el-select :model-value="outputMode" :onUpdate:modelValue="actions.output" data-testid="input-translation-output-mode" :aria-label="t('inputTranslation.outputMode')">
          <el-option value="replace" :label="t('inputTranslation.outputReplace')" />
          <el-option value="append" :label="t('inputTranslation.outputAppend')" />
          <el-option value="prepend" :label="t('inputTranslation.outputPrepend')" />
        </el-select>
      </SettingsItem>

      <SettingsItem :label="t('inputTranslation.service')">
        <div class="input-translation-service-control" data-testid="input-translation-profile-editor">
          <el-select id="input-translation-service-control" :model-value="translationService" :onUpdate:modelValue="actions.service" :empty-values="[null, undefined]" data-testid="input-translation-service" :aria-label="t('inputTranslation.service')" filterable>
            <el-option v-for="item in serviceOptions" :key="item.value" class="select-left" :label="item.label" :value="item.value" :disabled="item.disabled">
              <span class="input-translation-service-option">
                <ServiceIcon :service="item.value" :label="item.label" size="small" />
                <span>{{ item.label }}</span>
              </span>
            </el-option>
          </el-select>
          <div v-if="showModel" class="input-translation-model-control">
            <label for="input-translation-model-control">{{ t('inputTranslation.model') }}</label>
            <el-select id="input-translation-model-control" :model-value="translationModel" :onUpdate:modelValue="actions.model" data-testid="input-translation-model" :aria-label="t('inputTranslation.model')" filterable>
              <el-option value="" :label="t('inputTranslation.modelPlaceholder')" />
              <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
            </el-select>
            <small class="input-translation-field-help">{{ t('inputTranslation.modelDescription') }}</small>
          </div>
          <small v-if="credentialWarning" class="input-translation-credential-warning" role="status">{{ credentialWarning }}</small>
        </div>
      </SettingsItem>

      <div v-if="showPrompt" class="input-translation-prompt-options">
        <button type="button" class="input-translation-prompt-toggle" data-testid="input-translation-prompt-toggle" :aria-expanded="promptsExpanded" :onClick="actions.togglePrompts">
          <strong>{{ t('inputTranslation.promptGroup') }}</strong>
          <span>{{ promptStateLabel }}</span>
          <el-icon aria-hidden="true"><ArrowDown /></el-icon>
        </button>
        <div v-if="promptsExpanded" class="input-translation-prompts" data-testid="input-translation-prompts">
          <div class="input-translation-prompt-section">
            <PromptTemplateEditor
              :active="active && showPrompt && promptsExpanded"
              :context="props.config"
              :context-key="revision"
              :model-value="systemPrompt" :onUpdate:modelValue="actions.systemPrompt"
              role="system"
              :role-label="t('inputTranslation.systemRoleLabel')"
              :title="t('inputTranslation.systemPrompt')"
              :description="t('inputTranslation.systemPromptDescription')"
              :placeholder="defaultSystemPrompt"
              :aria-label="t('inputTranslation.systemPrompt')"
              :limit-label="t('inputTranslation.promptLimit', {count: 8192})"
              :tokens="[]"
            />
            <button v-if="!systemPrompt.trim()" type="button" class="input-translation-text-button" data-testid="input-translation-system-default" :onClick="actions.systemDefault">{{ t('inputTranslation.editDefaultPrompt') }}</button>
            <button v-else type="button" class="input-translation-text-button" :aria-label="t('inputTranslation.promptResetAria')" :onClick="actions.resetSystem">{{ t('inputTranslation.promptReset') }}</button>
          </div>
          <div class="input-translation-prompt-section">
            <PromptTemplateEditor
              :active="active && showPrompt && promptsExpanded"
              :context="props.config"
              :context-key="revision"
              :model-value="userPrompt" :onUpdate:modelValue="actions.userPrompt"
              role="user"
              :role-label="t('inputTranslation.userRoleLabel')"
              :title="t('inputTranslation.userPrompt')"
              :description="t('inputTranslation.userPromptDescription')"
              :placeholder="defaultUserPrompt"
              :aria-label="t('inputTranslation.userPrompt')"
              :limit-label="t('inputTranslation.promptLimit', {count: 8192})"
              :token-hint="t('inputTranslation.promptVariablesHelp', {origin: '{origin}', to: '{to}'})"
              :token-list-aria-label="t('inputTranslation.promptVariablesHelp', {origin: '{origin}', to: '{to}'})"
              :token-aria-label="promptTokenAriaLabel"
              :tokens="promptTokens"
            />
            <p v-if="promptWarnings.length" class="input-translation-prompt-warning" role="alert">
              <el-icon aria-hidden="true"><WarningFilled /></el-icon>
              <span>{{ promptWarnings.join(' ') }}</span>
            </p>
            <button v-if="!userPrompt.trim()" type="button" class="input-translation-text-button" data-testid="input-translation-user-default" :onClick="actions.userDefault">{{ t('inputTranslation.editDefaultPrompt') }}</button>
            <button v-else type="button" class="input-translation-text-button" :aria-label="t('inputTranslation.promptResetAria')" :onClick="actions.resetUser">{{ t('inputTranslation.promptReset') }}</button>
          </div>
        </div>
      </div>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElPopover } from 'element-plus'
import { ArrowDown, WarningFilled } from '@element-plus/icons-vue'
import { customModelString, getMultilingualTargetLanguageLabel, models, options, resolveConfiguredModel, servicesType } from '@/src/core/config/catalog'
import { getMissingCredentialMessage } from '@/src/core/config/validation'
import type { Config } from '@/src/core/config/model'
import { getCustomOpenAIProviderModels, isCustomOpenAIProviderId } from '@/src/core/config/customOpenAI'
import {
  DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL,
  DEFAULT_INPUT_BOX_TRANSLATION_PROMPT,
  DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
  INPUT_BOX_TRANSLATION_INTERVAL_MAX,
  INPUT_BOX_TRANSLATION_INTERVAL_MIN,
  INPUT_BOX_TRANSLATION_INTERVAL_STEP,
  normalizeInputBoxTranslationInterval,
  normalizeInputBoxTranslationOutputMode,
  type InputBoxTranslationOutputMode,
  supportsInputBoxTranslationPrompt,
} from '@/src/core/config/inputTranslation'
import { useUiI18n } from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import FieldHelp from './components/FieldHelp.vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import PromptTemplateEditor from './services/PromptTemplateEditor.vue'
import {useSettingsActionContext} from '../model/useSettingsActionContext'

const MAX_PROMPT_LENGTH = 8192

interface ServiceOption {
  value: string
  label: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  active?: boolean
  config: Config
  serviceOptions: readonly ServiceOption[]
}>(), {active: true})

const emit = defineEmits<{
  'trigger-change': [value: string]
}>()

const { language, t, translateLegacy } = useUiI18n()
const inputConfig = computed(() => props.config)
const promptsExpanded = ref(false)
const timingOpen = ref(false)
const promptRevision = ref(0)
watch(promptsExpanded, () => {promptRevision.value += 1}, {flush: 'sync'})

const triggerOptions = computed(() => inputConfig.value.inputBoxTranslationTrigger === 'ctrl_enter'
  ? [...options.inputBoxTranslationTrigger, {value: 'ctrl_enter', label: 'Ctrl+Enter'}]
  : options.inputBoxTranslationTrigger)
const targetOptions = computed(() => options.inputBoxTranslationTarget)
const serviceOptions = computed(() => {
  const visible = [{value: '', label: t('featureServices.followDefault')}, ...props.serviceOptions.filter((item) => !item.disabled)]
  const selected = inputConfig.value.inputBoxTranslationService
  if (!selected || visible.some((item) => item.value === selected)) return visible
  return [{value: selected, label: selected, disabled: true}, ...visible]
})

const interval = computed({
  get: () => normalizeInputBoxTranslationInterval(inputConfig.value.inputBoxTranslationInterval),
  set: (value: number) => {
    if (active.value && inputConfig.value.inputBoxTranslationTrigger.startsWith('triple_')) inputConfig.value.inputBoxTranslationInterval = normalizeInputBoxTranslationInterval(value)
  },
})

const targetLanguage = computed({
  get: () => inputConfig.value.inputBoxTranslationTarget,
  set: (value: string) => {if (active.value && targetOptions.value.some(item => item.value === value)) inputConfig.value.inputBoxTranslationTarget = value},
})

const outputMode = computed({
  get: () => normalizeInputBoxTranslationOutputMode(inputConfig.value.inputBoxTranslationOutputMode),
  set: (value: InputBoxTranslationOutputMode) => {if (active.value && ['replace', 'append', 'prepend'].includes(value)) inputConfig.value.inputBoxTranslationOutputMode = value},
})

const translationService = computed({
  get: () => inputConfig.value.inputBoxTranslationService,
  set: (value: string) => {
    if (!active.value || !serviceOptions.value.some(item => item.value === value && !item.disabled)) return
    const config = inputConfig.value
    if (value !== config.inputBoxTranslationService) config.inputBoxTranslationModel = ''
    config.inputBoxTranslationService = value
  },
})

const translationModel = computed({
  get: () => inputConfig.value.inputBoxTranslationModel || '',
  set: (value: string | undefined) => {
    if (!active.value || !showModel.value || (value !== undefined && typeof value !== 'string')) return
    const model = value?.trim() || ''
    if (!model || modelOptions.value.includes(model)) inputConfig.value.inputBoxTranslationModel = model
  },
})

const effectiveTranslationService = computed(() => translationService.value || props.config.service)

const credentialWarning = computed(() => {
  const service = effectiveTranslationService.value
  const config = props.config
  const message = getMissingCredentialMessage(service, config, translationModel.value || config.model[service])
  return message ? translateLegacy(message) : ''
})

const defaultSystemPrompt = DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT
const defaultUserPrompt = DEFAULT_INPUT_BOX_TRANSLATION_PROMPT
const systemPrompt = computed({
  get: () => inputConfig.value.inputBoxTranslationSystemPrompt || '',
  set: (value: string) => { if (active.value && showPrompt.value && typeof value === 'string' && value.length <= MAX_PROMPT_LENGTH) inputConfig.value.inputBoxTranslationSystemPrompt = value },
})
const userPrompt = computed({
  get: () => inputConfig.value.inputBoxTranslationPrompt || '',
  set: (value: string) => { if (active.value && showPrompt.value && typeof value === 'string' && value.length <= MAX_PROMPT_LENGTH) inputConfig.value.inputBoxTranslationPrompt = value },
})

const isMachineService = computed(() => servicesType.isMachine(effectiveTranslationService.value))
const isInputTranslationEnabled = computed(() => inputConfig.value.inputBoxTranslationTrigger !== 'disabled')
const effectiveModel = computed(() => translationModel.value || resolveConfiguredModel(
  inputConfig.value.model[effectiveTranslationService.value],
  inputConfig.value.customModel[effectiveTranslationService.value],
))
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, effectiveTranslationService.value, effectiveModel.value])
watch(revision, () => {promptsExpanded.value = false; timingOpen.value = false}, {flush: 'sync'})
const isAiService = computed(() => !isMachineService.value && (
  isCustomOpenAIProviderId(effectiveTranslationService.value) || servicesType.isAI(effectiveTranslationService.value)
))
const showModel = computed(() => isAiService.value && servicesType.isUseModel(effectiveTranslationService.value))
const showPrompt = computed(() => isAiService.value && supportsInputBoxTranslationPrompt(
  effectiveTranslationService.value,
  effectiveModel.value,
))
const modelOptions = computed(() => {
  const service = effectiveTranslationService.value
  const providerModels = isCustomOpenAIProviderId(service)
    ? getCustomOpenAIProviderModels(inputConfig.value.customOpenAIProviders, service)
    : models.get(service) || []
  const configuredModels = inputConfig.value.customModels[service] || []
  const selected = translationModel.value
  const defaultModel = resolveConfiguredModel(inputConfig.value.model[service], inputConfig.value.customModel[service])
  return Array.from(new Set([...providerModels, ...configuredModels, defaultModel, selected]
    .filter((model) => model && model !== customModelString)))
})

const promptTokens = computed(() => [
  {value: '{{to}}', label: t('inputTranslation.target')},
  {value: '{{origin}}', label: t('inputTranslation.sourceText')},
])
const promptTokenAriaLabel = (token: {value: string; label: string}) => t('inputTranslation.promptInsert', {token: token.value, label: token.label})
const promptWarnings = computed(() => {
  const warnings: string[] = []
  if (inputConfig.value.inputBoxTranslationPrompt?.trim() && !inputConfig.value.inputBoxTranslationPrompt.includes('{{origin}}')) {
    warnings.push(t('inputTranslation.promptMissingOrigin', {origin: '{origin}'}))
  }
  if (inputConfig.value.inputBoxTranslationPrompt?.trim() && !inputConfig.value.inputBoxTranslationPrompt.includes('{{to}}')) {
    warnings.push(t('inputTranslation.promptMissingTarget', {to: '{to}'}))
  }
  return warnings
})
const promptStateLabel = computed(() => (
  inputConfig.value.inputBoxTranslationPrompt?.trim() || inputConfig.value.inputBoxTranslationSystemPrompt?.trim()
    ? t('inputTranslation.promptEdited')
    : t('inputTranslation.promptDefault')
))

function setIntervalValue(value: number | undefined): void {
  interval.value = value ?? DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL
}

function resetInterval(): void {
  interval.value = DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL
}

function resetSystemPrompt(): void {
  systemPrompt.value = ''
}

function resetUserPrompt(): void {
  userPrompt.value = ''
}

const actions = computed(() => {
  const current = capture(), promptSession = promptRevision.value
  const promptCurrent = () => current() && promptsExpanded.value && promptSession === promptRevision.value
  return {
    target: (value: string) => {if (current()) targetLanguage.value = value},
    output: (value: InputBoxTranslationOutputMode) => {if (current()) outputMode.value = value},
    service: (value: string) => {if (current()) translationService.value = value},
    model: (value: string | undefined) => {if (current()) translationModel.value = value},
    interval: (value: number | undefined) => {if (current()) setIntervalValue(value)},
    resetInterval: () => {if (current()) resetInterval()},
    trigger: (value: string) => {if (current() && triggerOptions.value.some(item => item.value === value)) emit('trigger-change', value)},
    timing: (value: boolean) => {if (current()) timingOpen.value = value},
    togglePrompts: () => {if (current() && showPrompt.value) promptsExpanded.value = !promptsExpanded.value},
    systemPrompt: (value: string) => {if (promptCurrent()) systemPrompt.value = value},
    userPrompt: (value: string) => {if (promptCurrent()) userPrompt.value = value},
    systemDefault: () => {if (promptCurrent()) systemPrompt.value = defaultSystemPrompt},
    userDefault: () => {if (promptCurrent()) userPrompt.value = defaultUserPrompt},
    resetSystem: () => {if (promptCurrent()) resetSystemPrompt()},
    resetUser: () => {if (promptCurrent()) resetUserPrompt()},
  }
})

const workflowDescription = computed(() => {
  if (!isInputTranslationEnabled.value) return t('inputTranslation.workflowDisabled')
  const trigger = triggerOptions.value.find(item => item.value === inputConfig.value.inputBoxTranslationTrigger)?.label || inputConfig.value.inputBoxTranslationTrigger
  let target = targetOptions.value.find(item => item.value === targetLanguage.value)?.label || targetLanguage.value
  try {
    target = new Intl.DisplayNames([language.value], {type: 'language'}).of(targetLanguage.value) || target
  } catch { /* 无法识别的语言标识继续显示目录名称。 */ }
  const workflowKey = outputMode.value === 'replace' ? 'inputTranslation.workflowEnabled'
    : outputMode.value === 'prepend' ? 'inputTranslation.workflowPrepend' : 'inputTranslation.workflowAppend'
  return t(workflowKey, {trigger: translateLegacy(trigger), language: target})
})
</script>

<style scoped>
.input-translation-settings { min-width: 0; }
.input-translation-text-button { display: inline-flex; align-items: center; min-height: 22px; padding: 0; border: 0; color: var(--brand-strong); background: transparent; cursor: pointer; font: inherit; font-size: 11px; line-height: 1.5; text-align: left; }
.input-translation-text-button:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.input-translation-text-button:disabled { color: var(--muted); cursor: default; }
.input-translation-timing-link { align-self: flex-start; color: var(--muted); }
.input-translation-text-button:focus-visible,
.input-translation-prompt-toggle:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

.input-translation-service-control { display: grid; gap: 10px; width: 100%; max-width: 360px; min-width: 0; }
.input-translation-service-option { display: flex; align-items: center; gap: 9px; min-width: 0; }
.input-translation-service-option > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.input-translation-service-option :deep(.service-brand-icon) { flex: none; box-shadow: none; }
.input-translation-model-control { display: grid; gap: 6px; min-width: 0; }
.input-translation-model-control label { color: var(--ink); font-size: 11px; font-weight: 650; }

.input-translation-timing-panel { color: var(--ink); font-size: 12px; }
.input-translation-timing-panel strong { font-weight: 600; }
.input-translation-timing-panel p { margin: 8px 0 12px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.input-translation-interval-control { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
.input-translation-interval-control :deep(.el-input-number) { width: min(100%, 184px); }

.input-translation-field { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
.input-translation-field label { color: var(--ink); font-size: 12.5px; font-weight: 600; }
.input-translation-label-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.input-translation-field-help,
.input-translation-credential-warning { color: var(--muted); font-size: 11px; line-height: 1.5; }

/* 与 SettingsItem 行共用卡片内边距令牌，保证提示词区块与上方配置行共享同一内容边界；底部留白与卡片标题节奏一致，折叠态也不贴边。 */
.input-translation-prompt-options { border-top: 1px solid var(--line); padding-inline: var(--fr-card-padding-inline, 20px); padding-bottom: var(--fr-card-heading-padding-block, 16px); }
.input-translation-prompt-toggle { display: flex; align-items: center; gap: 12px; width: 100%; padding: 16px 0 0; border: 0; color: var(--muted); background: transparent; cursor: pointer; font: inherit; text-align: left; }
.input-translation-prompt-toggle strong { color: var(--ink); font-size: 12.5px; font-weight: 600; }
.input-translation-prompt-toggle span { margin-left: auto; font-size: 11px; }
.input-translation-prompt-toggle .el-icon { flex: none; transition: transform 160ms ease; }
.input-translation-prompt-toggle[aria-expanded="true"] .el-icon { transform: rotate(180deg); }
.input-translation-prompts { display: grid; gap: 24px; padding-top: 20px; }
.input-translation-prompt-section { display: grid; min-width: 0; gap: 8px; }
.input-translation-prompt-section > .input-translation-text-button { justify-self: start; }
.input-translation-prompts :deep(.prompt-template-field) { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.input-translation-prompts :deep(.prompt-role-badge) { display: none; }
.input-translation-prompts :deep(.prompt-template-textarea) { box-sizing: border-box; min-height: 100px; height: 116px; margin-top: 12px; border-color: var(--line); border-radius: 10px; font-size: 12px; }
.input-translation-prompts :deep(.prompt-template-footer) { flex-wrap: wrap; margin-top: 8px; }
.input-translation-prompts :deep(.prompt-token-list) { justify-content: flex-start; }
.input-translation-prompt-warning { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--ink); font-size: 11px; line-height: 1.5; }
.input-translation-prompt-warning .el-icon { flex: none; margin-top: 2px; color: var(--brand-strong); }
@media (max-width: 540px) {
  .input-translation-prompts :deep(.prompt-template-header) { flex-wrap: wrap; gap: 4px; }
}
</style>
