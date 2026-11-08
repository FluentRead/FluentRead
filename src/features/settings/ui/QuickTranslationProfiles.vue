<!--
 * @file src/features/settings/ui/QuickTranslationProfiles.vue
 * 文件职责：提供悬浮、全文与局部容器翻译的多方案设置界面，让每个额外快捷键独立选择翻译服务、模型、目标语言和展示策略。
 * 主要内容：按动作筛选并编辑快捷翻译方案，复用快捷键录制与服务图标组件，聚合内置和自定义模型，并在新增、启停、删除及跨方案热键去重后发出最新配置快照；关闭的翻译服务显示为禁选项并阻止保存为新选择；按活跃配置、方案生命周期、字段版本与录制会话限定旧事件。
 * 模块边界：组件只编辑父级传入的 QuickTranslationProfile 列表，不直接保存 Config、不注册网页快捷键或执行翻译；配置归一化与运行时路由仍由 core 和对应 feature 负责。
 -->
<template>
  <section
    ref="sectionRoot"
    class="quick-translation-profiles"
    :data-action="action"
    data-testid="quick-translation-profiles"
  >
    <header class="profiles-toolbar">
      <div class="profiles-copy">
        <h3>{{ heading }}</h3>
        <p>{{ t(action === 'section' ? 'quickTranslation.sectionDescription' : 'quickTranslation.description') }}</p>
      </div>
      <div class="toolbar-actions">
        <span v-if="showCapacity" class="capacity-label">
          {{ isAtCapacity ? t('quickTranslation.capacityReached') : `${visibleProfiles.length} / ${MAX_QUICK_TRANSLATION_PROFILES}` }}
        </span>
        <button
          type="button"
          class="settings-add-button add-button"
          :disabled="!active || isAtCapacity"
          :title="isAtCapacity ? t('quickTranslation.capacityLimit', {count: MAX_QUICK_TRANSLATION_PROFILES}) : ''"
          :data-testid="`quick-profile-add-${action}`"
          :onClick="addAction"
        >
          {{ translateLegacy('添加') }}
        </button>
      </div>
    </header>

    <div v-if="visibleProfiles.length" class="profile-list">
      <article
        v-for="row in rows"
        :key="row.profile.id"
        class="profile-card"
        :class="{ 'is-disabled': !row.profile.enabled || !row.profile.hotkey, 'is-expanded': isExpanded(row.profile.id), 'is-unavailable': !isProfileAvailable(row.profile) }"
        :data-profile-id="row.profile.id"
      >
        <div class="profile-summary-row">
          <button
            type="button"
            class="profile-summary"
            :aria-expanded="isExpanded(row.profile.id)"
            :aria-controls="editorId(row.profile.id)"
            :onClick="row.toggle"
          >
            <kbd :class="{ empty: !row.profile.hotkey }">{{ hotkeyLabel(row.profile.hotkey) }}</kbd>
            <ServiceIcon
              :service="effectiveService(row.profile)"
              :label="serviceLabel(effectiveService(row.profile))"
              size="small"
            />
            <span class="service-summary">
              <strong>{{ profileSummaryTitle(row.profile) }}</strong>
              <small :class="{ warning: !isProfileAvailable(row.profile) }">
                {{ profileSummaryDetail(row.profile) }}
              </small>
            </span>
            <span class="summary-chevron" aria-hidden="true">⌄</span>
          </button>

          <el-switch
            :model-value="row.profile.enabled && Boolean(row.profile.hotkey)"
            :disabled="!active || !row.profile.hotkey"
            class="profile-switch"
            :aria-label="profileSwitchLabel(row.profile)"
            :onUpdate:modelValue="row.enabled"
          />
        </div>

        <div
          v-if="isExpanded(row.profile.id)"
          :id="editorId(row.profile.id)"
          class="profile-editor"
        >
          <label class="editor-field">
            <span>{{ translateLegacy('快捷键') }}</span>
            <button
              type="button"
              class="hotkey-button"
              :class="{ empty: !row.profile.hotkey }"
              :data-testid="`quick-profile-hotkey-${row.profile.id}`"
              :onClick="row.open"
            >
              <kbd>{{ hotkeyLabel(row.profile.hotkey) }}</kbd>
              <small>{{ row.profile.hotkey ? t('quickTranslation.clickEdit') : t('quickTranslation.clickRecord') }}</small>
            </button>
            <small v-if="hotkeyConflictWarning(row.profile.hotkey)" class="field-hint field-warning">
              {{ t('quickTranslation.systemConflict', {warning: hotkeyConflictWarning(row.profile.hotkey)}) }}
            </small>
          </label>

          <label class="editor-field">
            <span>{{ translateLegacy('服务') }}</span>
            <el-select
              :model-value="row.profile.service"
              :placeholder="t('quickTranslation.followDefault', {value: serviceLabel(config.service)})"
              :aria-label="t('quickTranslation.translationServiceAria', {hotkey: hotkeyLabel(row.profile.hotkey)})"
              :data-testid="`quick-profile-service-${row.profile.id}`"
              :disabled="!active" :onUpdate:modelValue="row.service"
              filterable
            >
              <el-option :label="t('quickTranslation.followDefault', {value: serviceLabel(config.service)})" value="" />
              <el-option
                v-if="row.profile.service && !isProfileAvailable(row.profile) && !serviceOptions.some(option => option.value === row.profile.service)"
                :label="t('quickTranslation.serviceUnavailable', {service: serviceLabel(row.profile.service)})"
                :value="row.profile.service"
                disabled
              />
              <el-option
                v-for="option in serviceOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
                :disabled="option.disabled"
              />
            </el-select>
          </label>

          <label v-if="usesModel(row.profile)" class="editor-field">
            <span>{{ translateLegacy('模型') }}</span>
            <el-select
              :model-value="row.profile.model"
              :placeholder="modelDefaultOptionLabel(row.profile)"
              :aria-label="t('quickTranslation.translationModelAria', {hotkey: hotkeyLabel(row.profile.hotkey)})"
              :data-testid="`quick-profile-model-${row.profile.id}`"
              :disabled="!active" :onUpdate:modelValue="row.model"
              filterable
            >
              <el-option :label="modelDefaultOptionLabel(row.profile)" value="" />
              <el-option
                v-for="model in row.modelChoices"
                :key="model"
                :label="model"
                :value="model"
              />
            </el-select>
            <small v-if="!row.profile.service" class="field-hint">{{ t('quickTranslation.pinServiceHint') }}</small>
          </label>

          <label class="editor-field">
            <span>{{ translateLegacy('目标语言') }}</span>
            <el-select
              :model-value="row.profile.targetLanguage"
              :placeholder="t('quickTranslation.followDefault', {value: languageLabel(config.to)})"
              :aria-label="t('quickTranslation.targetLanguageAria', {hotkey: hotkeyLabel(row.profile.hotkey)})"
              :data-testid="`quick-profile-target-${row.profile.id}`"
              :disabled="!active" :onUpdate:modelValue="row.target"
              filterable
            >
              <el-option :label="t('quickTranslation.followDefault', {value: languageLabel(config.to)})" value="" />
              <el-option
                v-for="option in row.languageChoices"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </label>

          <GlossaryLibrarySelect
            v-if="config.glossaryLibraries.length || config.glossaryEnabled"
            :model-value="row.profile.glossaryIds"
            :libraries="config.glossaryLibraries"
            :enabled="config.glossaryEnabled"
              :unsupported="!supportsTranslationGlossary(effectiveService(row.profile), row.profile.model || configuredDefaultModel(effectiveService(row.profile)))"
            :disabled="!active" :onUpdate:modelValue="row.glossary"
          />

          <label class="editor-field">
            <span>{{ translateLegacy('显示方式') }}</span>
            <el-select
              :model-value="displaySelectValue(row.profile)"
              :disabled="!active || isGoogleProfile(row.profile)"
              :aria-label="t('quickTranslation.displayModeAria', {hotkey: hotkeyLabel(row.profile.hotkey)})"
              :data-testid="`quick-profile-display-${row.profile.id}`"
              :onUpdate:modelValue="row.display"
            >
              <el-option :label="t('quickTranslation.followDefault', {value: defaultDisplayModeLabel})" value="inherit" />
              <el-option :label="translateLegacy('双语对照')" value="bilingual" />
              <el-option :label="translateLegacy('仅译文')" value="translation-only" :disabled="!active || isGoogleProfile(row.profile)" />
            </el-select>
          </label>

          <label v-if="action === 'full-page'" class="editor-field">
            <span>{{ t('quickTranslation.field.range') }}</span>
            <el-select
              :model-value="row.profile.fullPageMode"
              :aria-label="t('quickTranslation.fullPageRangeAria', {hotkey: hotkeyLabel(row.profile.hotkey)})"
              :data-testid="`quick-profile-range-${row.profile.id}`"
              :disabled="!active" :onUpdate:modelValue="row.range"
            >
              <el-option :label="t('quickTranslation.followDefault', {value: defaultFullPageModeLabel})" value="inherit" />
              <el-option :label="translateLegacy('按阅读进度')" value="viewport" />
              <el-option :label="translateLegacy('翻译到页底')" value="all" />
            </el-select>
          </label>

          <div class="editor-actions">
            <button
              type="button"
              class="delete-button"
              :aria-label="t('quickTranslation.deleteAria', {profile: profileAccessibleName(row.profile)})"
              :disabled="!active" :onClick="row.remove"
            >
              {{ t('quickTranslation.delete') }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <CustomHotkeyInput
      v-if="recorder"
      :key="recorder.sequence"
      :model-value="true"
      :current-value="recorder.hotkey"
      :validate="recorderActions.validate"
      :onUpdate:modelValue="recorderActions.update"
      :onConfirm="recorderActions.confirm"
      :onCancel="recorderActions.cancel"
    />
  </section>
</template>

<script setup lang="ts">
import {computed, defineAsyncComponent, nextTick, ref, shallowRef, watch} from 'vue'
import {ElMessage} from 'element-plus'
import {
  customModelString,
  getMultilingualTargetLanguageLabel,
  models,
  options,
  resolveConfiguredModel,
  services,
  servicesType,
} from '@/src/core/config/catalog'
import {
  getCustomOpenAIProvider,
  withCustomOpenAIServiceOptions,
} from '@/src/core/config/customOpenAI'
import {withCompositeTranslationServiceOptions} from '@/src/core/config/compositeTranslation'
import type {Config} from '@/src/core/config/model'
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy'
import {normalizeGlossaryIds} from '@/src/core/glossary'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
import {useQuickProfileDraft} from '../model/useQuickProfileDraft'
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation'
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation'
import {resolveReservedClickSelectionHotkey} from '@/src/core/config/clickSelection'
import {
  createQuickTranslationProfile,
  quickTranslationActionKey,
  type QuickTranslationAction,
  inputBoxTranslationTriggerHotkey,
  MAX_QUICK_TRANSLATION_PROFILES,
  type QuickTranslationDisplayMode,
  type QuickTranslationProfile,
} from '@/src/core/config/quickTranslation'
import {canonicalizeHotkey, parseHotkey, resolveConfiguredHotkey, validateHotkeyConflicts} from '@/src/core/hotkey'
import {filterAvailableTranslationServices, isTranslationServiceAvailable, supportsTranslationGlossary} from '@/src/services/translation/capabilities'
import {markDisabledTranslationServices} from '@/src/core/config/serviceAvailability'
import GlossaryLibrarySelect from '@/src/ui/components/GlossaryLibrarySelect.vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import {useUiI18n} from '@/src/ui/i18n'

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'))

interface ServiceOption {
  value: string
  label: string
  disabled?: boolean
}

interface LanguageOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  config: Config
  action: QuickTranslationAction
  profiles: QuickTranslationProfile[]
  active?: boolean
}>(), {active: true})

const emit = defineEmits<{
  'update:profiles': [profiles: QuickTranslationProfile[]]
}>()

const {language, t, translateLegacy} = useUiI18n()

const profileDraft = useQuickProfileDraft(() => props.profiles, () => [props.config, props.action])
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.action])
const defaultServiceRevision = ref(0)
watch(() => props.config.service, () => {defaultServiceRevision.value += 1}, {flush: 'sync'})
const expandedIds = ref(new Set<string>()), editorEpochs = ref(new Map<string, number>())
const sectionRoot = shallowRef<HTMLElement | null>(null)
type Recorder = {sequence: number; id: string; hotkey: string; token?: symbol; hotkeyToken?: symbol; current: () => boolean; trigger: HTMLElement | null}
const recorder = shallowRef<Recorder | null>(null)
const recorderRevision = ref(0)
const heading = computed(() => t(`quickTranslation.heading.${quickTranslationActionKey(props.action)}`))
const visibleProfiles = computed(() => profileDraft.profiles.value.filter(profile => profile.action === props.action))
const profileIndex = computed(() => new Map(visibleProfiles.value.map(profile => [profile.id, profile])))
const isAtCapacity = computed(() => visibleProfiles.value.length >= MAX_QUICK_TRANSLATION_PROFILES)
const showCapacity = computed(() => visibleProfiles.value.length >= MAX_QUICK_TRANSLATION_PROFILES - 1)
const allServiceOptions = computed<ServiceOption[]>(() => withCompositeTranslationServiceOptions(withCustomOpenAIServiceOptions(options.services, props.config.customOpenAIProviders), props.config.compositeTranslationProviders)
  .filter(option => !option.disabled).map(option => ({value: option.value, label: translateLegacy(option.label)})))
const serviceOptions = computed<ServiceOption[]>(() => markDisabledTranslationServices(
  filterAvailableTranslationServices(allServiceOptions.value), props.config.disabledTranslationServices,
))
const serviceLabels = computed(() => new Map(allServiceOptions.value.map(option => [option.value, option.label])))
const defaultDisplayModeLabel = computed(() => translateLegacy(props.config.display === 0 ? '仅译文' : '双语对照'))
const defaultFullPageModeLabel = computed(() => props.config.fullPageTranslationMode === 'all' ? translateLegacy('翻译到页底') : translateLegacy('按阅读进度'))
const knownLanguageOptions = computed(() => (options.to as LanguageOption[]).map(option => ({...option,
  label: getMultilingualTargetLanguageLabel(option.value, option.label, language.value),
})))
function currentProfile(id: string) {return profileIndex.value.get(id)}
function emitProfiles(profiles: QuickTranslationProfile[]): void {profileDraft.publish(profiles);emit('update:profiles', profiles)}
function updateProfile(profile: QuickTranslationProfile, patch: Partial<QuickTranslationProfile>): void {
  if (currentProfile(profile.id) !== profile) return
  emitProfiles(profileDraft.profiles.value.map(candidate => candidate.id === profile.id ? {...candidate, ...patch} : candidate))
}
function editorId(id: string): string {return `quick-translation-profile-${id}`}
function isExpanded(id: string): boolean {return expandedIds.value.has(id)}
function toggleExpanded(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id);else next.add(id)
  expandedIds.value = next;editorEpochs.value = new Map(editorEpochs.value).set(id, (editorEpochs.value.get(id) || 0) + 1)
}
function eventTrigger(event?: MouseEvent): HTMLElement | null {return event?.currentTarget instanceof HTMLElement ? event.currentTarget : null}
function focusAfterRender(current: () => boolean, before: Element | null, target: () => HTMLElement | null) {
  void nextTick(() => {
    if (!current() || (document.activeElement !== before && document.activeElement !== document.body)) return
    const element = target();if (element?.isConnected) element.focus({preventScroll: true})
  })
}
function ownsRecorder(value: Recorder): boolean {
  return recorder.value === value && value.current() && (!value.id || (Boolean(currentProfile(value.id))
    && profileDraft.token(value.id) === value.token && profileDraft.token(value.id, 'hotkey') === value.hotkeyToken))
}
function openRecorder(profile: QuickTranslationProfile | undefined, event?: MouseEvent) {
  if (!active.value || recorder.value) return
  if (!profile && isAtCapacity.value) {ElMessage.warning(t('quickTranslation.capacityLimit', {count: MAX_QUICK_TRANSLATION_PROFILES}));return}
  recorder.value = {sequence: ++recorderRevision.value, id: profile?.id || '', hotkey: profile?.hotkey || '',
    token: profile && profileDraft.token(profile.id), hotkeyToken: profile && profileDraft.token(profile.id, 'hotkey'), current: capture(), trigger: eventTrigger(event)}
}
function closeRecorder(value: Recorder, restoreFocus = true) {
  if (recorder.value !== value) return
  recorder.value = null;const pending = ++recorderRevision.value, current = capture()
  if (restoreFocus) focusAfterRender(() => current() && pending === recorderRevision.value, document.activeElement, () => value.trigger)
}
watch(() => [revision.value, profileDraft.lineageRevision.value, recorder.value, visibleProfiles.value], () => {
  const value = recorder.value;if (value && !ownsRecorder(value)) closeRecorder(value, false)
  const ids = new Set(visibleProfiles.value.map(profile => profile.id))
  if ([...expandedIds.value].some(id => !ids.has(id))) expandedIds.value = new Set([...expandedIds.value].filter(id => ids.has(id)))
  for (const id of editorEpochs.value.keys()) if (!ids.has(id)) editorEpochs.value.delete(id)
}, {flush: 'sync'})
const addAction = computed(() => {
  const current = capture(), sequence = recorderRevision.value
  return (event?: MouseEvent) => {if (current() && sequence === recorderRevision.value) openRecorder(undefined, event)}
})
function removeProfile(profile: QuickTranslationProfile, event?: MouseEvent): void {
  const index = visibleProfiles.value.findIndex(candidate => candidate.id === profile.id)
  const focusId = visibleProfiles.value[index + 1]?.id || visibleProfiles.value[index - 1]?.id
  const before = document.activeElement, restore = eventTrigger(event) === before
  emitProfiles(profileDraft.profiles.value.filter(candidate => candidate.id !== profile.id))
  if (restore) {const current = capture(), epoch = recorderRevision.value
    focusAfterRender(() => current() && epoch === recorderRevision.value, before, () => {
      const cards = [...(sectionRoot.value?.querySelectorAll<HTMLElement>('.profile-card') || [])]
      return cards.find(card => card.dataset.profileId === focusId)?.querySelector<HTMLElement>('.profile-summary')
        || sectionRoot.value?.querySelector<HTMLElement>('.add-button') || null
    })
  }
}
type ProfileField = keyof QuickTranslationProfile
const rows = computed(() => visibleProfiles.value.map(profile => {
  const current = capture(), token = profileDraft.token(profile.id), action = profileDraft.token(profile.id, 'action'), epoch = editorEpochs.value.get(profile.id)
  const owns = () => current() && profileDraft.token(profile.id) === token && profileDraft.token(profile.id, 'action') === action
    && editorEpochs.value.get(profile.id) === epoch && Boolean(currentProfile(profile.id))
  const bind = (field: ProfileField, dependencies: ProfileField[], run: (profile: QuickTranslationProfile, value: unknown) => void, editor = true) => {
    const versions = [field, ...dependencies].map(key => [key, profileDraft.token(profile.id, key)] as const)
    const service = effectiveService(profile)
    const defaultVersion = !profile.service && dependencies.includes('service') ? defaultServiceRevision.value : undefined
    return (value: unknown) => {
      if (!owns() || (editor && !isExpanded(profile.id)) || !versions.every(([key, version]) => profileDraft.token(profile.id, key) === version)) return
      const latest = currentProfile(profile.id)!
      if (defaultVersion !== undefined && defaultVersion !== defaultServiceRevision.value) return
      if (dependencies.includes('service') && effectiveService(latest) !== service) return
      run(latest, value)
    }
  }
  return {profile, modelChoices: modelOptions(profile), languageChoices: languageOptions(profile),
    toggle: () => {if (owns()) toggleExpanded(profile.id)},
    open: (event?: MouseEvent) => {if (owns() && isExpanded(profile.id)) openRecorder(currentProfile(profile.id), event)},
    remove: (event?: MouseEvent) => {if (owns() && isExpanded(profile.id)) removeProfile(currentProfile(profile.id)!, event)},
    enabled: bind('enabled', ['hotkey'], setEnabled, false), service: bind('service', [], setService),
    model: bind('model', ['service'], setModel), target: bind('targetLanguage', [], setTargetLanguage),
    glossary: bind('glossaryIds', ['service','model'], setGlossary), display: bind('displayMode', ['service'], setDisplayMode), range: bind('fullPageMode', [], setFullPageMode),
  }
}))
function hotkeyIdentity(hotkey: string): string {return (canonicalizeHotkey(hotkey) || hotkey.trim()).toLocaleLowerCase()}
function legacyHotkeyEntries(): Array<{hotkey: string; label: string}> {
  const entries = [
    {hotkey: resolveReservedClickSelectionHotkey(props.config), label: translateLegacy('两点选取')},
    {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), label: t('quickTranslation.defaultHover')},
    {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), label: t('quickTranslation.defaultFullPage')},
  ]
  if (props.config.selectionAreaEnabled) entries.push({hotkey: resolveAreaTranslationHotkey(props.config.selectionAreaHotkey, props.config.customSelectionAreaHotkey), label: translateLegacy('圈选翻译')})
  if (props.config.paragraphCopyEnabled) entries.push({hotkey: resolveParagraphCopyHotkey(props.config.paragraphCopyHotkey, props.config.customParagraphCopyHotkey), label: t('paragraphCopy.settings.title')})
  if (props.config.sectionTranslationHotkeyEnabled) entries.push({hotkey: resolveSectionTranslationHotkey(props.config.sectionTranslationHotkey, props.config.customSectionTranslationHotkey), label: t('sectionTranslation.settings.title')})
  const input = inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger)
  if (input) entries.push({hotkey: input, label: translateLegacy('输入框翻译')})
  return entries.filter(entry => Boolean(canonicalizeHotkey(entry.hotkey)))
}
function selectionHotkey(): string {
  return props.config.disableSelectionTranslator || props.config.selectionTranslatorMode === 'disabled' ? ''
    : resolveConfiguredHotkey(props.config.selectionTranslatorTrigger, props.config.customSelectionTranslatorHotkey)
}
function validateProfileHotkey(hotkey: string, id: string): string {
  const identity = hotkeyIdentity(hotkey)
  if (!identity) return ''
  if (profileDraft.profiles.value.some(profile => profile.id !== id && hotkeyIdentity(profile.hotkey) === identity)) return t('quickTranslation.duplicate')
  const conflict = legacyHotkeyEntries().find(entry => hotkeyIdentity(entry.hotkey) === identity)
  return conflict ? t('quickTranslation.legacyConflictEdit', {feature: conflict.label}) : ''
}
function confirmHotkey(value: Recorder, hotkey: unknown) {
  if (!ownsRecorder(value) || typeof hotkey !== 'string') return
  const normalized = hotkey === 'none' ? '' : canonicalizeHotkey(hotkey)
  if ((!normalized && hotkey !== 'none' && hotkey !== '') || (!value.id && !normalized)) {ElMessage.warning(t('quickTranslation.recordFirst'));return}
  if (!value.id && isAtCapacity.value) {ElMessage.warning(t('quickTranslation.capacityLimit', {count: MAX_QUICK_TRANSLATION_PROFILES}));return}
  const message = validateProfileHotkey(normalized, value.id)
  if (message) {ElMessage.warning(message);return}
  const profile = value.id ? currentProfile(value.id)! : {...createQuickTranslationProfile(props.action, profileDraft.profiles.value), hotkey: normalized, enabled: true}
  closeRecorder(value)
  if (value.id) updateProfile(profile, {hotkey: normalized, enabled: Boolean(normalized)})
  else {emitProfiles([...profileDraft.profiles.value, profile]);expandedIds.value = new Set([...expandedIds.value, profile.id])}
  if (normalized && hotkeyIdentity(selectionHotkey()) === hotkeyIdentity(normalized)) ElMessage.info(t('quickTranslation.selectionPrecedence'))
}
const recorderActions = computed(() => {
  const value = recorder.value
  return {validate: (hotkey: string) => value && ownsRecorder(value) ? validateProfileHotkey(hotkey, value.id) : '',
    confirm: (hotkey: unknown) => {if (value) confirmHotkey(value, hotkey)},
    cancel: () => {if (value && ownsRecorder(value)) closeRecorder(value)},
    update: (visible: unknown) => {if (visible === false && value && ownsRecorder(value)) closeRecorder(value)},
  }
})
function setEnabled(profile: QuickTranslationProfile, value: unknown): void {
  if (typeof value !== 'boolean') return
  if (value) {const conflict = validateProfileHotkey(profile.hotkey, profile.id)
    if (!profile.hotkey || conflict) {ElMessage.warning(conflict || t('quickTranslation.setFirst'));return}
  }
  if (profile.enabled !== value) updateProfile(profile, {enabled: value})
}
function setService(profile: QuickTranslationProfile, value: unknown): void {
  if (typeof value !== 'string' || (value && !serviceOptions.value.some(option => option.value === value && !option.disabled)) || profile.service === value) return
  updateProfile(profile, {service: value, model: ''})
  if ((value || props.config.service) === services.google && profile.displayMode !== 'bilingual') ElMessage.info(t('quickTranslation.googleNotice'))
}
function setModel(profile: QuickTranslationProfile, value: unknown): void {
  if (typeof value !== 'string' || !usesModel(profile) || !isProfileAvailable(profile) || (value && !modelOptions(profile).includes(value)) || value === profile.model) return
  updateProfile(profile, {model: value, ...(value && !profile.service ? {service: props.config.service} : {})})
}
function setTargetLanguage(profile: QuickTranslationProfile, value: unknown): void {
  if (typeof value !== 'string' || (value && !languageOptions(profile).some(option => option.value === value)) || profile.targetLanguage === value) return
  updateProfile(profile, {targetLanguage: value})
}
function setGlossary(profile: QuickTranslationProfile, value: unknown): void {
  if (value !== null && (!Array.isArray(value) || !value.every(id => typeof id === 'string'))) return
  if (!props.config.glossaryEnabled && !props.config.glossaryLibraries.length) return
  const normalized = normalizeGlossaryIds(value, props.config.glossaryLibraries)
  if (Array.isArray(value) && normalized?.length !== new Set(value).size) return
  updateProfile(profile, {glossaryIds: normalized})
}
function setDisplayMode(profile: QuickTranslationProfile, value: unknown): void {
  if (isGoogleProfile(profile) || (value !== 'inherit' && value !== 'bilingual' && value !== 'translation-only') || value === profile.displayMode) return
  updateProfile(profile, {displayMode: value})
}
function setFullPageMode(profile: QuickTranslationProfile, value: unknown): void {
  if (props.action !== 'full-page' || (value !== 'inherit' && value !== 'viewport' && value !== 'all') || value === profile.fullPageMode) return
  updateProfile(profile, {fullPageMode: value})
}

function effectiveService(profile: QuickTranslationProfile): string {
  return profile.service || props.config.service
}

function isGoogleProfile(profile: QuickTranslationProfile): boolean {
  return effectiveService(profile) === services.google
}

function isProfileAvailable(profile: QuickTranslationProfile): boolean {
  return serviceOptions.value.some(option => option.value === effectiveService(profile) && !option.disabled) && isTranslationServiceAvailable(effectiveService(profile))
}

function serviceLabel(service: string): string {
  return serviceLabels.value.get(service) || service || t('common.notSet')
}

function usesModel(profile: QuickTranslationProfile): boolean {
  return servicesType.isUseModel(effectiveService(profile))
}

function configuredDefaultModel(service: string): string {
  const provider = getCustomOpenAIProvider(props.config.customOpenAIProviders, service)
  return resolveConfiguredModel(props.config.model[service], props.config.customModel[service])
    || provider?.models[0]
    || models.get(service)?.find((model) => model !== customModelString)
    || ''
}

function summaryModel(profile: QuickTranslationProfile): string {
  if (profile.model) return profile.model
  const model = configuredDefaultModel(effectiveService(profile))
  return model || t('quickTranslation.defaultModel')
}

function modelDefaultOptionLabel(profile: QuickTranslationProfile): string {
  const model = configuredDefaultModel(effectiveService(profile))
  return model
    ? t('quickTranslation.followServiceDefaultModel', {model})
    : t('quickTranslation.followServiceDefault')
}

function modelOptions(profile: QuickTranslationProfile): string[] {
  const service = effectiveService(profile)
  const provider = getCustomOpenAIProvider(props.config.customOpenAIProviders, service)
  const builtIn = provider
    ? provider.models
    : (models.get(service) || []).filter((model) => model !== customModelString)
  const activeCustomModel = props.config.model[service] === customModelString
    ? props.config.customModel[service]?.trim()
    : ''
  return [...new Set([
    ...builtIn,
    ...(props.config.customModels[service] || []),
    activeCustomModel,
    configuredDefaultModel(service),
    profile.model,
  ].filter((model): model is string => Boolean(model)))]
}

function languageLabel(languageCode: string): string {
  const label = (options.to as LanguageOption[]).find((option) => option.value === languageCode)?.label
  return languageCode
    ? getMultilingualTargetLanguageLabel(languageCode, label || languageCode, language.value)
    : t('common.notSet')
}

function languageOptions(profile: QuickTranslationProfile): LanguageOption[] {
  const known = knownLanguageOptions.value
  return !profile.targetLanguage || known.some(option => option.value === profile.targetLanguage) ? known : [...known,
    {value: profile.targetLanguage, label: getMultilingualTargetLanguageLabel(profile.targetLanguage, profile.targetLanguage, language.value)},
  ]
}

function targetLanguageLabel(profile: QuickTranslationProfile): string {
  return profile.targetLanguage
    ? languageLabel(profile.targetLanguage)
    : languageLabel(props.config.to)
}

function displayModeLabel(profile: QuickTranslationProfile): string {
  if (isGoogleProfile(profile)) return `${translateLegacy('双语对照')} · ${t('quickTranslation.serviceRestriction')}`
  if (profile.displayMode === 'bilingual') return translateLegacy('双语对照')
  if (profile.displayMode === 'translation-only') return translateLegacy('仅译文')
  return defaultDisplayModeLabel.value
}

function displaySelectValue(profile: QuickTranslationProfile): QuickTranslationDisplayMode {
  return isGoogleProfile(profile) ? 'bilingual' : profile.displayMode
}

function fullPageModeLabel(profile: QuickTranslationProfile): string {
  if (profile.fullPageMode === 'all') return translateLegacy('翻译到页底')
  if (profile.fullPageMode === 'viewport') return translateLegacy('按阅读进度')
  return defaultFullPageModeLabel.value
}

function hasProfileOverrides(profile: QuickTranslationProfile): boolean {
  return Boolean(profile.service || profile.model || profile.targetLanguage
    || profile.glossaryIds != null
    || profile.displayMode !== 'inherit'
    || (props.action === 'full-page' && profile.fullPageMode !== 'inherit'))
}

function profileSummaryTitle(profile: QuickTranslationProfile): string {
  if (!hasProfileOverrides(profile)) return t('quickTranslation.useDefaults')
  const service = serviceLabel(effectiveService(profile))
  return usesModel(profile) ? `${service} · ${summaryModel(profile)}` : service
}

function profileSummaryDetail(profile: QuickTranslationProfile): string {
  const detail = [
    targetLanguageLabel(profile),
    displayModeLabel(profile),
    ...(props.action === 'full-page' ? [fullPageModeLabel(profile)] : []),
    ...(profile.glossaryIds != null ? [profile.glossaryIds.length
      ? `${t('glossary.title')}: ${profile.glossaryIds.map(id => props.config.glossaryLibraries.find(library => library.id === id)?.name || id).join(', ')}`
      : t('glossary.none')] : []),
  ].join(' · ')
  if (!isProfileAvailable(profile)) return t('quickTranslation.profileUnavailable', {detail})
  if (!profile.enabled) return t('quickTranslation.profilePaused', {detail})
  return detail
}

function hotkeyLabel(hotkey: string): string {
  if (!hotkey) return translateLegacy('待设置')
  const parsed = parseHotkey(hotkey)
  return parsed.isValid ? parsed.displayName : hotkey
}

function hotkeyConflictWarning(hotkey: string): string {
  if (!hotkey) return ''
  const warning = validateHotkeyConflicts(parseHotkey(hotkey)).conflictDescription || ''
  return translateLegacy(warning.replace(/^与系统快捷键冲突:\s*/u, ''))
}

function profileAccessibleName(profile: QuickTranslationProfile): string {
  const index = visibleProfiles.value.findIndex((candidate) => candidate.id === profile.id) + 1
  const actionLabel = t(`quickTranslation.action.${quickTranslationActionKey(props.action)}`)
  return t('quickTranslation.profileName', {
    action: actionLabel,
    index: index > 0 ? index : '',
    hotkey: hotkeyLabel(profile.hotkey),
  }).trim()
}

function profileSwitchLabel(profile: QuickTranslationProfile): string {
  const profileName = profileAccessibleName(profile)
  if (!profile.hotkey) return t('quickTranslation.profileNeedsHotkey', {profile: profileName})
  if (profile.enabled) {
    return t(isProfileAvailable(profile)
      ? 'quickTranslation.disableProfile'
      : 'quickTranslation.disableProfileUnavailable', {profile: profileName})
  }
  return t(isProfileAvailable(profile)
    ? 'quickTranslation.enableProfile'
    : 'quickTranslation.enableProfileUnavailable', {profile: profileName})
}
</script>

<style scoped>
.quick-translation-profiles {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 16px 20px;
  border-top: 1px solid var(--line, #e5e8ef);
  color: var(--ink, #172033);
}

.quick-translation-profiles[data-action="section"] {
  padding: var(--fr-settings-row-padding-block, 14px) var(--fr-card-padding-inline, 20px);
  border-color: var(--fr-card-border, var(--line));
}

.quick-translation-profiles[data-action="section"] .profiles-toolbar {
  align-items: center;
  min-height: calc(var(--fr-settings-row-min-height, 66px) - 2 * var(--fr-settings-row-padding-block, 14px));
}

.profiles-toolbar,
.toolbar-actions,
.profile-summary-row,
.profile-summary,
.hotkey-button {
  display: flex;
  align-items: center;
}

.profiles-toolbar {
  justify-content: space-between;
  gap: 18px;
}

.profiles-copy {
  min-width: 0;
}

.profiles-copy h3,
.profiles-copy p {
  margin: 0;
}

.profiles-copy h3 {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
}

.profiles-copy p {
  margin-top: 3px;
  color: var(--muted, #737c8f);
  font-size: 12px;
  line-height: 1.55;
}

.toolbar-actions {
  flex: none;
  gap: 8px;
}

.capacity-label {
  flex: none;
  color: var(--muted, #737c8f);
  font-size: 11px;
  font-weight: 650;
}

.profile-list {
  display: grid;
  gap: 7px;
  margin-top: 11px;
}

.profile-card {
  overflow: hidden;
  border: 1px solid var(--line, #e5e8ef);
  border-radius: 11px;
  background: var(--surface, #fff);
  transition: border-color 150ms ease, background 150ms ease;
}

.profile-card:hover,
.profile-card.is-expanded {
  border-color: rgba(239, 71, 118, .34);
}

.profile-card.is-unavailable {
  border-style: dashed;
}

.profile-summary-row {
  min-width: 0;
  padding: 8px 10px;
}

.profile-summary {
  flex: 1;
  min-width: 0;
  gap: 8px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.profile-summary:focus-visible,
.delete-button:focus-visible,
.hotkey-button:focus-visible {
  outline: 2px solid rgba(239, 71, 118, .35);
  outline-offset: 2px;
}

kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.profile-summary > kbd {
  flex: none;
  min-width: 62px;
  max-width: 96px;
  padding: 5px 8px;
  overflow: hidden;
  border: 1px solid rgba(239, 71, 118, .2);
  border-radius: 8px;
  color: var(--brand-strong, #dc315f);
  background: var(--brand-soft, #fff0f4);
  font-size: 10px;
  font-weight: 750;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-summary > kbd.empty {
  border-color: var(--line, #e5e8ef);
  color: var(--muted, #737c8f);
  background: var(--surface-soft, #f7f8fb);
}

.service-summary {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.service-summary strong,
.service-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.service-summary strong {
  font-size: 11.5px;
  line-height: 1.35;
}

.service-summary small {
  margin-top: 2px;
  color: var(--muted, #737c8f);
  font-size: 9.5px;
}

.service-summary small.warning {
  color: #9c6b12;
}

.summary-chevron {
  flex: none;
  color: var(--muted, #737c8f);
  font-size: 13px;
  transform: rotate(0deg);
  transition: transform 150ms ease;
}

.is-expanded .summary-chevron {
  transform: rotate(180deg);
}

.profile-switch {
  flex: none;
  margin-left: 9px;
}

.delete-button {
  padding: 6px 2px;
  border: 0;
  border-radius: 7px;
  color: #b42b50;
  background: transparent;
  cursor: pointer;
  font-size: 10px;
  font-weight: 650;
}

.delete-button:hover {
  color: #c52751;
  text-decoration: underline;
}

.profile-editor {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 13px 12px 10px;
  border-top: 1px solid var(--line, #e5e8ef);
  background: var(--surface-soft, #f7f8fb);
}

.editor-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.editor-field > span {
  color: var(--muted, #737c8f);
  font-size: 10px;
  font-weight: 700;
}

.editor-field :deep(.el-select) {
  width: 100%;
}

.editor-field :deep(.el-select__wrapper) {
  min-height: 38px;
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--line, #e5e8ef) inset;
}

.field-hint {
  margin-top: -2px;
  color: var(--muted, #737c8f);
  font-size: 9px;
}

.field-warning {
  color: #9c6b12;
  line-height: 1.45;
}

.editor-actions {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  padding-top: 1px;
}

.hotkey-button {
  justify-content: space-between;
  gap: 12px;
  min-height: 40px;
  padding: 7px 10px;
  border: 1px solid var(--line, #e5e8ef);
  border-radius: 10px;
  color: var(--ink, #172033);
  background: var(--surface, #fff);
  cursor: pointer;
  text-align: left;
}

.hotkey-button:hover {
  border-color: var(--brand, #ef4776);
}

.hotkey-button kbd {
  color: var(--brand-strong, #dc315f);
  font-size: 11px;
  font-weight: 750;
}

.hotkey-button.empty kbd {
  color: var(--muted, #737c8f);
}

.hotkey-button small {
  color: var(--muted, #737c8f);
  font-size: 9px;
}

@media (max-width: 900px) {
  .profile-editor {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .quick-translation-profiles {
    padding: 12px;
  }

  .profiles-toolbar {
    align-items: flex-start;
  }

  .quick-translation-profiles:not([data-action="section"]) .profiles-copy p {
    max-width: 210px;
  }

  .profile-summary-row {
    padding: 9px;
  }

  .profile-editor {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 11px;
  }

  .editor-actions {
    grid-column: 1;
  }
}

@media (max-width: 420px) {
  .profiles-toolbar {
    gap: 10px;
  }

  .quick-translation-profiles:not([data-action="section"]) .profiles-copy p {
    display: none;
  }

  .profile-summary > :deep(.service-brand-icon) {
    display: none;
  }

  .profile-summary > kbd {
    min-width: 56px;
    max-width: 76px;
  }

  .profile-switch {
    margin-left: 6px;
  }
}
</style>
