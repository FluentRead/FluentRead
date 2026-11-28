<!--
 * @file src/features/settings/ui/LocalTranslationModelSettings.vue
 *
 * 文件职责：呈现本地翻译模型选择、下载源与加速镜像配置、持续下载进度、删除确认和短文本试译。
 * 主要内容：采用等高自适应紧凑卡片网格展示活跃语言包与混元 Hy-MT3 1.8B，整卡可直接点击选择，点击下载/续传/重试自动选中目标模型；明确区分选择态与下载状态，提供下载源偏好（自动选择/国内加速/官方直连）与经 SHA-256 校验保护的自定义 HTTPS 加速链接，并在信息提示中提供官方、镜像与魔搭社区访问入口；对已替代或旧版模型提供一键切换新版入口；活跃页面订阅后台持久快照，停用、缓存切页或上下文替换时退订并取消所属试译，按当前所选模型动态切换试译目标语言。
 * 模块边界：通过 runtime 消息操作下载任务并传递下载源偏好与加速镜像，模型配置交给既有设置持久化，设备级下载源偏好保存在扩展本机存储；所有操作、确认和迟到回包限定当前页面归属，不因页面离开中止后台下载，不获取模型文件、不创建推理引擎。
 -->
<template>
  <section class="local-models" aria-labelledby="local-models-title" data-local-translation-models>
    <h3 id="local-models-title" class="local-models-sr-only">{{ t('settings.localTranslation.title') }}</h3>
    <p v-if="!supported" class="local-models-error" role="status">{{ t('settings.localTranslation.unavailable') }}</p>
    <div v-if="loadError" class="local-models-error" role="alert">
      {{ t('settings.localTranslation.statusReadFailed') }}
      <button type="button" class="local-models-icon" :disabled="!active" :aria-label="t('settings.localTranslation.refresh')" :title="t('settings.localTranslation.refresh')" :onClick="actions.refresh"><Refresh aria-hidden="true" /></button>
    </div>

    <div class="local-models-list" role="radiogroup" :aria-label="t('settings.localTranslation.title')">
      <article v-for="item in visibleModels" :key="item.value" class="local-model" :class="{selected: selectedModel === item.value, disabled: !active || !supported}" :data-model="item.value" :data-phase="state(item.value).phase" :onClick="actions.cardSelect.bind(null, item.value)">
        <div class="local-model-head">
          <label class="local-model-choice">
            <input :checked="selectedModel === item.value" type="radio" name="local-translation-model" :value="item.value" :disabled="!active || !supported" :onChange="actions.model.bind(null, item.value)" :aria-label="t('settings.localTranslation.chooseNamed', {name: modelName(item)})" />
            <strong>{{ modelName(item) }}</strong>
          </label>
          <span v-if="item.value === defaultModel" class="local-model-tag">{{ t('settings.localTranslation.recommended') }}</span>
          <span v-else-if="item.legacy || item.supersededBy" class="local-model-tag legacy">{{ t('settings.localTranslation.legacyBadge') }}</span>
          <span v-else-if="item.engine === 'hunyuan'" class="local-model-tag quality">{{ t('settings.localTranslation.quality') }}</span>
          <span class="local-model-info-slot" @click.stop>
            <FieldHelp button-class="local-model-info" placement="bottom-start" :content="t(item.descriptionKey)" :label="`${modelName(item)}: ${t('settings.localTranslation.license')}`">
              <template #content>
                <div class="local-model-description">
                  <p class="local-model-tip-specs">
                    <span>{{ t(item.languagesKey) }}</span>
                    <span><Cpu aria-hidden="true" />{{ t('settings.localTranslation.memoryShort', {size: memoryRange(item)}) }}</span>
                  </p>
                  <p>{{ t(item.descriptionKey) }}</p>
                  <p>{{ t('settings.localTranslation.resourcesNote') }}</p>
                  <div class="local-model-tip-links">
                    <a :href="`https://huggingface.co/${item.repositories[0]}`" target="_blank" rel="noopener noreferrer">{{ t('settings.localTranslation.license') }}<TopRight aria-hidden="true" /></a>
                    <a :href="buildLocalTranslationMirrorPageUrl(item.repositories[0], effectiveMirrorUrl)" target="_blank" rel="noopener noreferrer">{{ t('settings.localTranslation.mirrorPage') }}<TopRight aria-hidden="true" /></a>
                    <a v-if="buildLocalTranslationModelScopePageUrl(item.repositories[0])" :href="buildLocalTranslationModelScopePageUrl(item.repositories[0])" target="_blank" rel="noopener noreferrer">{{ t('settings.localTranslation.modelScopePage') }}<TopRight aria-hidden="true" /></a>
                  </div>
                </div>
              </template>
            </FieldHelp>
          </span>
        </div>
        <div v-if="item.supersededBy" class="local-model-upgrade-row">
          <p class="local-model-upgrade-hint">{{ t('settings.localTranslation.hunyuanUpgradeHint') }}</p>
          <button type="button" class="local-model-upgrade-action" :disabled="!active || !supported" :onClick="actions.switchSuperseded.bind(null, item.supersededBy)" @click.stop>{{ t('settings.localTranslation.switchToLatest') }}</button>
        </div>
        <div class="local-model-foot">
          <div class="local-model-specs">
            <span class="local-model-size">{{ formatBytes(state(item.value).totalBytes) }}</span>
            <span class="local-model-dot" aria-hidden="true">·</span>
            <span class="local-model-status" :class="{'is-ready': state(item.value).phase === 'ready'}" role="status" aria-live="polite"><Check v-if="state(item.value).phase === 'ready'" aria-hidden="true" />{{ loaded ? t(`settings.localTranslation.phase.${state(item.value).phase}`) : t('settings.localTranslation.statusReading') }}</span>
          </div>
          <div class="local-model-action-buttons" @click.stop>
            <button v-if="canDelete(item.value)" type="button" class="local-models-icon" :disabled="!active || busy.has(item.value) || state(item.value).phase === 'removing'" :aria-label="t('modelCache.removeNamed', {name: modelName(item)})" :title="t('settings.localTranslation.remove')" :onClick="actions.remove.bind(null, item)"><Delete aria-hidden="true" /></button>
            <button v-if="isDownloading(item.value)" type="button" class="local-models-button" :disabled="!active || busy.has(item.value)" :onClick="actions.pause.bind(null, item.value)"><VideoPause aria-hidden="true" />{{ t('settings.localTranslation.pause') }}</button>
            <button v-else-if="state(item.value).phase !== 'ready' && !item.legacy" type="button" class="local-models-button primary" :disabled="!active || !modelSupported(item) || !loaded || busy.has(item.value) || state(item.value).phase === 'removing'" :onClick="actions.download.bind(null, item.value)"><Download aria-hidden="true" />{{ t(state(item.value).phase === 'error' ? 'settings.localTranslation.retry' : state(item.value).phase === 'paused' ? 'settings.localTranslation.resume' : 'settings.localTranslation.download') }}</button>
          </div>
        </div>
        <div v-if="showProgress(item.value) || state(item.value).error || supported && !modelSupported(item)" class="local-model-progress">
          <progress v-if="showProgress(item.value)" :value="state(item.value).downloadedBytes" :max="state(item.value).totalBytes || 1" :aria-label="modelName(item)" />
          <div v-if="showProgress(item.value)" class="local-model-progress-detail">
            <span>{{ percent(item.value) }}% · {{ formatBytes(state(item.value).downloadedBytes) }} / {{ formatBytes(state(item.value).totalBytes) }}</span>
            <span v-if="state(item.value).phase === 'downloading' && state(item.value).bytesPerSecond > 0">{{ formatBytes(state(item.value).bytesPerSecond) }}/s</span>
          </div>
          <p v-if="state(item.value).error" class="local-models-error" role="alert">{{ t(`settings.localTranslation.error.${state(item.value).error}`) }}</p>
          <p v-if="supported && !modelSupported(item)" class="local-models-error" role="status">{{ t('settings.localTranslation.error.browser') }}</p>
        </div>
      </article>
    </div>

    <div class="local-models-acceleration" data-local-translation-acceleration>
      <div class="local-models-acceleration-row">
        <div class="local-models-source-picker">
          <span class="local-models-source-label" aria-hidden="true">{{ t('settings.localTranslation.downloadSource') }}</span>
          <SegmentedControl :model-value="sourcePreference" :onUpdate:modelValue="actions.sourcePreference" compact :label="t('settings.localTranslation.downloadSource')" :options="sourcePreferenceOptions" :disabled="!active || !supported" />
        </div>
        <button type="button" class="local-models-button local-models-mirror-toggle" :class="{'is-configured': Boolean(effectiveMirrorUrl)}" :aria-expanded="mirrorPanelOpen" :disabled="!active || !supported" :onClick="actions.toggleMirrorPanel" data-local-translation-mirror-toggle>
          <span>{{ t('settings.localTranslation.customMirror') }}</span>
          <span v-if="mirrorHostBadge" class="local-models-mirror-badge">{{ mirrorHostBadge }}</span>
        </button>
      </div>
      <div v-if="mirrorPanelOpen" class="local-models-mirror-panel" data-local-translation-mirror-panel>
        <div class="local-models-mirror-input-row">
          <input type="url" class="local-models-mirror-input" :class="{'is-invalid': mirrorInvalid}" :value="mirrorDraft" :placeholder="t('settings.localTranslation.customMirrorPlaceholder')" :aria-label="t('settings.localTranslation.customMirror')" :aria-invalid="mirrorInvalid" :disabled="!active || !supported" :onInput="actions.mirrorInput" data-local-translation-mirror-input />
          <button type="button" class="local-models-button" :disabled="!active || !supported || mirrorDraft.trim() === DEFAULT_LOCAL_TRANSLATION_MIRROR_URL" :onClick="actions.applyPresetMirror">hf-mirror.com</button>
          <button v-if="mirrorDraft.trim()" type="button" class="local-models-button" :disabled="!active || !supported" :onClick="actions.clearMirror">{{ t('settings.localTranslation.customMirrorClear') }}</button>
        </div>
        <p v-if="mirrorInvalid" class="local-models-error" role="alert">{{ t('settings.localTranslation.customMirrorInvalid') }}</p>
        <p class="local-models-mirror-hint">{{ t('settings.localTranslation.customMirrorHint') }}</p>
      </div>
    </div>

    <div class="local-models-notes">
      <p class="local-models-background-note">
        <span>{{ t('settings.localTranslation.backgroundNote') }}</span>
        <FieldHelp button-class="local-model-storage-help" :content="t('settings.localTranslation.storageNote')" :label="t('settings.localTranslation.storageHelp')" />
      </p>
      <p v-if="loaded && !selectedReady" class="local-models-pending" role="status">{{ t('settings.localTranslation.selectedPending') }}</p>
      <p v-if="operationError" class="local-models-error" role="alert">{{ operationError }}</p>
    </div>

    <section class="local-model-trial" aria-labelledby="local-model-trial-title">
      <header class="local-model-trial-heading">
        <h3 id="local-model-trial-title">{{ t('settings.localTranslation.trial') }}</h3>
        <div class="local-model-trial-target">
          <span aria-hidden="true">{{ t('settings.localTranslation.trialTarget') }}</span>
          <SegmentedControl :model-value="trialTarget" :onUpdate:modelValue="actions.target" compact :label="t('settings.localTranslation.trialTarget')" :options="trialLanguageOptions" :disabled="!active || trialBusy" />
        </div>
      </header>
      <div class="local-model-trial-composer">
        <textarea :value="trialText" :onInput="actions.text" :aria-label="t('settings.localTranslation.trialSource')" rows="3" maxlength="2000" :disabled="!active || trialBusy" />
        <div class="local-model-trial-actions">
          <p v-if="trialBusy" class="local-model-trial-status" role="status">{{ t('settings.localTranslation.trialBusy') }}</p>
          <button v-if="trialBusy" type="button" class="local-models-button" :disabled="!active" :onClick="actions.cancel"><Close aria-hidden="true" />{{ t('settings.localTranslation.cancel') }}</button>
          <button v-else type="button" class="local-models-button primary" :disabled="!active || !selectedReady || !trialText.trim()" :onClick="actions.trial"><Promotion aria-hidden="true" />{{ t('settings.localTranslation.trialAction') }}</button>
        </div>
      </div>
      <p v-if="trialError" class="local-models-error" role="alert">{{ trialError }}</p>
      <div v-if="trialResult" class="local-model-trial-result" role="status"><p>{{ trialResult }}</p><small>{{ t('settings.localTranslation.trialTime', {seconds: trialSeconds}) }}</small></div>
    </section>
  </section>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
import browser from 'webextension-polyfill'
import {ElMessageBox} from 'element-plus'
import {Check, Close, Cpu, Delete, Download, Promotion, Refresh, TopRight, VideoPause} from '@element-plus/icons-vue'
import type {Config} from '@/src/core/config/model'
import {
  DEFAULT_LOCAL_TRANSLATION_MIRROR_URL, DEFAULT_LOCAL_TRANSLATION_MODEL, LOCAL_TRANSLATION_DOWNLOAD_SETTINGS_KEY,
  LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY, LOCAL_TRANSLATION_MODELS,
  buildLocalTranslationMirrorPageUrl, buildLocalTranslationModelScopePageUrl, getLocalTranslationModel,
  isValidLocalTranslationMirrorUrl, localTranslationErrorKey, normalizeLocalTranslationDownloadSnapshot,
  normalizeLocalTranslationMirrorUrl, normalizeLocalTranslationModel, normalizeLocalTranslationSourcePreference,
  type LocalTranslationDownloadSourcePreference, type LocalTranslationDownloadState,
  type LocalTranslationModel, type LocalTranslationModelId,
} from '@/src/core/config/localTranslation'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {supportsHunyuanTranslation, supportsOpusTranslation} from '@/src/platform/browser/localTranslationSupport'
import {useUiI18n} from '@/src/ui/i18n'
import FieldHelp from './components/FieldHelp.vue'
import SegmentedControl from './components/SegmentedControl.vue'

const props = withDefaults(defineProps<{config: Config; service: string; active?: boolean; context?: unknown}>(), {active: true})
const {t} = useUiI18n()
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.context, props.service])
const supported = browserCapabilities.extensionDom
const hunyuanSupported = supportsHunyuanTranslation()
const opusSupported = supportsOpusTranslation()
function modelSupported(model: LocalTranslationModel): boolean {
  if (!supported) return false
  if (model.engine === 'hunyuan') return hunyuanSupported
  return model.engine !== 'opus' || opusSupported
}
const defaultModel = DEFAULT_LOCAL_TRANSLATION_MODEL
const tasks = ref<LocalTranslationDownloadState[]>([])
const loaded = ref(false)
const loadError = ref(false)
const operationError = ref('')
const busy = ref(new Set<string>())
const mounted = ref(false)
function readDownloadSettings(): {preference: LocalTranslationDownloadSourcePreference; mirrorUrl: string} {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCAL_TRANSLATION_DOWNLOAD_SETTINGS_KEY)
    const parsed = raw ? JSON.parse(raw) as {preference?: unknown; mirrorUrl?: unknown} : null
    return {
      preference: normalizeLocalTranslationSourcePreference(parsed?.preference),
      mirrorUrl: normalizeLocalTranslationMirrorUrl(parsed?.mirrorUrl) ?? '',
    }
  } catch {
    return {preference: 'auto', mirrorUrl: ''}
  }
}
function persistDownloadSettings(preference: LocalTranslationDownloadSourcePreference, mirrorUrl: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const normalized = normalizeLocalTranslationMirrorUrl(mirrorUrl)
    localStorage.setItem(LOCAL_TRANSLATION_DOWNLOAD_SETTINGS_KEY, JSON.stringify({preference, mirrorUrl: normalized ?? ''}))
  } catch {
    // 存储受限时保留内存态偏好，不阻断页面交互。
  }
}
const initialDownloadSettings = readDownloadSettings()
const sourcePreference = ref<LocalTranslationDownloadSourcePreference>(initialDownloadSettings.preference)
const mirrorDraft = ref(initialDownloadSettings.mirrorUrl)
const mirrorPanelOpen = ref(Boolean(initialDownloadSettings.mirrorUrl))
const effectiveMirrorUrl = computed(() => normalizeLocalTranslationMirrorUrl(mirrorDraft.value))
const mirrorInvalid = computed(() => !isValidLocalTranslationMirrorUrl(mirrorDraft.value))
const mirrorHostBadge = computed(() => {
  if (!effectiveMirrorUrl.value) return ''
  try { return new URL(effectiveMirrorUrl.value).host } catch { return '' }
})
const sourcePreferenceOptions = computed(() => [
  {value: 'auto', label: t('settings.localTranslation.sourceAuto')},
  {value: 'mirror', label: t('settings.localTranslation.sourceMirror')},
  {value: 'official', label: t('settings.localTranslation.sourceOfficial')},
])
let stopObserving: (() => void) | undefined
let readGeneration = 0
// 空快照也可能表示模型已删除；不能只用仍存在任务的 updatedAt 排除旧读取。
let snapshotRevision = 0
const selectedModel = computed(() => normalizeLocalTranslationModel(props.config.model[props.service]))
const idleStates = new Map<LocalTranslationModelId, LocalTranslationDownloadState>(LOCAL_TRANSLATION_MODELS.map(model => [model.value,
  {model: model.value, phase: 'idle', downloadedBytes: 0, totalBytes: model.downloadSizeMb * 1_000_000, bytesPerSecond: 0, updatedAt: 0},
]))
const taskIndex = computed(() => new Map(tasks.value.map(task => [task.model, task])))
const visibleModels = computed(() => LOCAL_TRANSLATION_MODELS.filter(
  (model) => (!model.legacy && !model.supersededBy)
    || selectedModel.value === model.value
    || state(model.value).downloadedBytes > 0
    || state(model.value).phase !== 'idle',
))
const selectedReady = computed(() => loaded.value && modelSupported(getLocalTranslationModel(selectedModel.value)) && state(selectedModel.value).phase === 'ready')
function modelName(model: LocalTranslationModel): string { return model.nameKey ? t(model.nameKey) : model.label }
function state(model: LocalTranslationModelId): LocalTranslationDownloadState {
  return taskIndex.value.get(model) || idleStates.get(model)!
}
function formatBytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${(bytes / 1_000_000).toFixed(bytes > 10_000_000 ? 0 : 1)} MB`
}
function memoryRange(model: LocalTranslationModel): string { return `${formatBytes(model.memoryMb[0] * 1_000_000)} - ${formatBytes(model.memoryMb[1] * 1_000_000)}` }
function percent(model: LocalTranslationModelId): number { const task = state(model); return Math.min(100, Math.floor(task.downloadedBytes * 100 / (task.totalBytes || 1))) }
function isDownloading(model: LocalTranslationModelId): boolean { return ['queued', 'downloading', 'verifying'].includes(state(model).phase) }
function showProgress(model: LocalTranslationModelId): boolean { return !['idle', 'ready', 'removing'].includes(state(model).phase) }
function canDelete(model: LocalTranslationModelId): boolean { return loaded.value && (state(model).downloadedBytes > 0 || isDownloading(model) || state(model).phase === 'ready') }
function applySnapshot(value: unknown, authoritative = true): void {
  const snapshot = normalizeLocalTranslationDownloadSnapshot(value)
  if (!snapshot) return
  if (authoritative) snapshotRevision++
  const previousTasks = taskIndex.value
  tasks.value = snapshot.tasks.map((task) => {
    const previous = previousTasks.get(task.model)
    return previous && previous.updatedAt > task.updatedAt ? previous : task
  })
}
async function refresh(current = capture()): Promise<void> {
  if (!current() || !supported) return
  const request = ++readGeneration
  const observedSnapshot = snapshotRevision
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadGetLocalTranslationModelState'}) as {success?: boolean} | undefined
    if (!current() || request !== readGeneration) return
    if (!response?.success || !normalizeLocalTranslationDownloadSnapshot(response)) throw new Error('status')
    // 读取期间事件或命令已经送来新状态，保留它；有效回包仍完成本次状态读取。
    if (observedSnapshot === snapshotRevision) applySnapshot(response)
    loaded.value = true
    loadError.value = false
  } catch { if (current() && request === readGeneration) loadError.value = true }
}
async function command(model: LocalTranslationModelId, action: 'download' | 'pause' | 'remove', current = capture()): Promise<void> {
  if (!current() || !supported || busy.value.has(model)) return
  readGeneration++
  busy.value.add(model)
  operationError.value = ''
  const type = {download: 'fluentReadPrepareLocalTranslationModel', pause: 'fluentReadPauseLocalTranslationModel', remove: 'fluentReadRemoveLocalTranslationModel'}[action]
  const payload = action === 'download'
    ? {
        type,
        model,
        ...(sourcePreference.value !== 'auto' ? {preference: sourcePreference.value} : {}),
        ...(effectiveMirrorUrl.value ? {mirrorUrl: effectiveMirrorUrl.value} : {}),
      }
    : {type, model}
  try {
    const response = await browser.runtime.sendMessage(payload) as {success?: boolean} | undefined
    if (!current()) return
    if (!response?.success) throw new Error('operation')
    applySnapshot(response)
  } catch { if (current()) operationError.value = t('settings.localTranslation.error.unknown') }
  finally {
    busy.value.delete(model)
    // 旧命令继续在后台完成；当前视图只重新读取权威状态，不接收旧归属回包。
    if (!current() && active.value) void refresh()
  }
}
async function confirmRemove(model: LocalTranslationModel, current = capture()): Promise<void> {
  if (!current() || !supported || busy.value.has(model.value)) return
  try {
    await ElMessageBox.confirm(
      t('settings.localTranslation.confirmBody', {size: formatBytes(state(model.value).downloadedBytes)}),
      t('settings.localTranslation.confirmTitle', {name: modelName(model)}),
      {type: 'warning', confirmButtonText: t('settings.localTranslation.confirmAction'), cancelButtonText: t('settings.localTranslation.cancel'), distinguishCancelAndClose: true, closeOnClickModal: false},
    )
  } catch { return }
  if (current()) await command(model.value, 'remove', current)
}

const languageLabels: Record<string, string> = {
  zh: 'area.settings.languageChinese',
  en: 'area.settings.languageEnglish',
  ja: 'area.settings.languageJapanese',
  fr: 'settings.localTranslation.langFrench',
  de: 'settings.localTranslation.langGerman',
  es: 'settings.localTranslation.langSpanish',
  ru: 'settings.localTranslation.langRussian',
}
const trialLanguages = computed(() => getLocalTranslationModel(selectedModel.value).opusLanguages ?? ['zh', 'en', 'ja'])
const trialLanguageOptions = computed(() => trialLanguages.value.map(language => ({value: language, label: t(languageLabels[language] || language)})))
const trialText = ref('When switching between different filaments, the printer flushes the remaining material to avoid color mixing.')
const trialTarget = ref(trialLanguages.value.includes('zh') ? 'zh' : trialLanguages.value[0]!)
const trialBusy = ref(false)
const trialResult = ref('')
const trialError = ref('')
const trialSeconds = ref('')
let trialId: string | undefined
function cancelTrial(): void {
  if (trialId) void browser.runtime.sendMessage({type: 'fluentReadCancelLocalTranslationTrial', requestId: trialId}).catch(() => undefined)
  trialId = undefined
  trialBusy.value = false
}
async function tryTranslation(current = capture()): Promise<void> {
  if (!current() || !selectedReady.value || trialBusy.value || !trialText.value.trim()) return
  const id = crypto.randomUUID()
  trialId = id
  trialBusy.value = true
  trialResult.value = ''
  trialError.value = ''
  const started = performance.now()
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadTryLocalTranslation', requestId: id, model: selectedModel.value, text: trialText.value, targetLanguage: trialTarget.value}) as {success?: boolean; result?: string; error?: string} | undefined
    if (!response?.success || !response.result) throw new Error(response?.error || 'translation')
    if (current() && trialId === id) { trialResult.value = response.result; trialSeconds.value = ((performance.now() - started) / 1000).toFixed(1) }
  } catch (error) { if (current() && trialId === id) trialError.value = t(localTranslationErrorKey(error)) }
  finally { if (trialId === id) { trialBusy.value = false; trialId = undefined } }
}
watch(selectedModel, () => {
  cancelTrial()
  trialResult.value = ''
  trialError.value = ''
  if (!trialLanguages.value.includes(trialTarget.value)) trialTarget.value = trialLanguages.value[0]!
})
const actions = computed(() => {
  const current = capture(), config = props.config, service = props.service
  return {
    model: (model: LocalTranslationModelId) => {if (current() && supported) config.model[service] = model},
    cardSelect: (model: LocalTranslationModelId, event?: MouseEvent) => {
      if (!current() || !supported) return
      const target = event?.target instanceof Element ? event.target : null
      if (target?.closest('button, a, input, label, .local-model-info-slot, .local-model-action-buttons')) return
      config.model[service] = model
    },
    switchSuperseded: (replacement: LocalTranslationModelId) => {
      if (current() && supported) config.model[service] = replacement
    },
    sourcePreference: (value: string | number) => {
      if (!current() || !supported) return
      sourcePreference.value = normalizeLocalTranslationSourcePreference(value)
      persistDownloadSettings(sourcePreference.value, mirrorDraft.value)
    },
    toggleMirrorPanel: () => {
      if (current() && supported) mirrorPanelOpen.value = !mirrorPanelOpen.value
    },
    mirrorInput: (event: Event) => {
      if (!current() || !supported) return
      const next = (event.target as HTMLInputElement).value
      mirrorDraft.value = next
      if (isValidLocalTranslationMirrorUrl(next)) persistDownloadSettings(sourcePreference.value, next)
    },
    applyPresetMirror: () => {
      if (!current() || !supported) return
      mirrorDraft.value = DEFAULT_LOCAL_TRANSLATION_MIRROR_URL
      persistDownloadSettings(sourcePreference.value, mirrorDraft.value)
    },
    clearMirror: () => {
      if (!current() || !supported) return
      mirrorDraft.value = ''
      persistDownloadSettings(sourcePreference.value, '')
    },
    target: (language: string | number) => {if (current() && !trialBusy.value && trialLanguages.value.includes(String(language))) trialTarget.value = String(language)},
    text: (event: Event) => {if (current() && !trialBusy.value) trialText.value = (event.target as HTMLTextAreaElement).value},
    refresh: () => refresh(current),
    download: (model: LocalTranslationModelId) => {
      if (!current() || !supported) return
      config.model[service] = model
      return command(model, 'download', current)
    },
    pause: (model: LocalTranslationModelId) => command(model, 'pause', current),
    remove: (model: LocalTranslationModel) => confirmRemove(model, current),
    trial: () => tryTranslation(current),
    cancel: () => {if (current()) cancelTrial()},
  }
})
watch(() => [mounted.value, revision.value], () => {
  stopObserving?.()
  stopObserving = undefined
  readGeneration++
  cancelTrial()
  loaded.value = false
  loadError.value = false
  operationError.value = ''
  trialResult.value = ''
  trialError.value = ''
  if (!mounted.value || !active.value || !supported) return
  const current = capture()
  const storageChanged = (changes: Record<string, browser.Storage.StorageChange>, area: string) => {
    if (current() && area === 'local' && changes[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]) applySnapshot(changes[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY].newValue)
  }
  browser.storage.onChanged.addListener(storageChanged)
  stopObserving = () => browser.storage.onChanged.removeListener(storageChanged)
  const cachedSnapshot = snapshotRevision
  void browser.storage.local.get(LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY).then((stored) => {
    if (current() && cachedSnapshot === snapshotRevision) applySnapshot(stored[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY], false)
  }).catch(() => undefined)
  void refresh(current)
}, {flush: 'sync'})
onMounted(() => {mounted.value = true})
onUnmounted(() => {mounted.value = false;stopObserving?.()})
</script>

<style scoped>
.local-models { display: grid; gap: 12px; padding: 0; min-width: 0; color: var(--ink); container-type: inline-size; }
.local-models h3 { margin: 0; font-size: 14px; font-weight: 650; line-height: 1.5; }
.local-models-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.local-models svg { width: 13px; height: 13px; flex: none; }
.local-models-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 10px; align-items: stretch; }
.local-model { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--fr-radius-md, 10px); background: var(--surface); transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }
.local-model:not(.disabled) { cursor: pointer; }
.local-model:not(.disabled):hover { border-color: color-mix(in srgb, var(--brand) 38%, var(--line)); background: color-mix(in srgb, var(--surface-soft) 50%, var(--surface)); }
.local-model.selected { border-color: var(--brand); box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 24%, transparent); background: color-mix(in srgb, var(--brand-soft) 30%, var(--surface)); }
.local-model.selected:not(.disabled):hover { border-color: var(--brand); background: color-mix(in srgb, var(--brand-soft) 38%, var(--surface)); }
.local-model-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.local-model-choice { display: inline-flex; align-items: center; gap: 7px; min-width: 0; cursor: inherit; }
.local-model-choice input { width: 15px; height: 15px; margin: 0; flex: none; accent-color: var(--brand); cursor: inherit; }
.local-model-choice strong { font-size: 13px; font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.local-model-tag { font-size: 10px; padding: 1px 6px; line-height: 1.5; color: var(--brand-strong); background: var(--brand-soft); border-radius: 5px; white-space: nowrap; flex: none; }
.local-model-tag.quality { color: var(--fr-success, #147e5c); background: var(--fr-success-soft, #eaf7f3); }
.local-model-tag.legacy { color: var(--muted); background: var(--surface-soft); }
.local-model-info-slot { margin-left: auto; flex: none; display: inline-flex; align-items: center; }
.local-model-info-slot :deep(.local-model-info) { width: 22px; height: 22px; }
.local-model-upgrade-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -4px 0 0; }
.local-model-upgrade-hint { margin: 0; font-size: 11px; line-height: 1.45; color: var(--muted); }
.local-model-upgrade-action { padding: 0; border: 0; background: transparent; color: var(--brand-strong); font: inherit; font-size: 11px; font-weight: 550; line-height: 1.45; cursor: pointer; white-space: nowrap; }
.local-model-upgrade-action:hover:not(:disabled) { text-decoration: underline; }
.local-model-tip-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding-top: 2px; }
.local-models-acceleration { display: grid; gap: 8px; padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--fr-radius-sm, 8px); background: var(--surface-soft); }
.local-models-acceleration-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.local-models-source-picker { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.local-models-source-label { color: var(--muted); font-size: 12px; white-space: nowrap; }
.local-models-source-picker :deep(.segmented-control) { width: auto; }
.local-models-source-picker :deep(.segmented-control button) { white-space: nowrap; }
.local-models-mirror-toggle.is-configured { border-color: color-mix(in srgb, var(--brand) 42%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); }
.local-models-mirror-badge { padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, var(--brand) 14%, transparent); font-size: 10px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.local-models-mirror-panel { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
.local-models-mirror-input-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.local-models-mirror-input { flex: 1 1 220px; min-width: 0; min-height: 28px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12px; }
.local-models-mirror-input:focus { outline: none; border-color: var(--brand); }
.local-models-mirror-input.is-invalid { border-color: var(--el-color-danger); }
.local-models-mirror-hint { margin: 0; font-size: 11px; line-height: 1.5; color: var(--muted); }
.local-model-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; min-width: 0; }
.local-model-specs { display: flex; align-items: center; gap: 5px; min-width: 0; flex-wrap: wrap; }
.local-model-size { font-size: 11px; line-height: 1.4; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.local-model-dot { font-size: 11px; line-height: 1.4; color: var(--line-strong, var(--muted)); opacity: .8; }
.local-model-status { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; line-height: 1.4; color: var(--muted); white-space: nowrap; }
.local-model-status.is-ready { color: var(--fr-success, #147e5c); font-weight: 500; }
:global(:root.dark) .local-model-tag.quality { color: #79c9a8; background: rgba(20, 126, 92, .22); }
:global(:root.dark) .local-model-status.is-ready { color: #79c9a8; }
.local-model-action-buttons { display: flex; align-items: center; gap: 5px; flex: none; }
.local-model-description { margin: 0; padding: 2px 0 0; color: inherit; font-size: 12px; line-height: 1.65; }
.local-model-description p { margin: 0 0 5px; }
.local-model-tip-specs { display: flex; flex-wrap: wrap; gap: 4px 10px; opacity: .9; font-size: 11px; font-variant-numeric: tabular-nums; }
.local-model-tip-specs span { display: inline-flex; align-items: center; gap: 4px; }
.local-model-description a { display: inline-flex; align-items: center; gap: 4px; color: inherit; text-decoration: underline; font-size: 12px; }
.local-model-description svg { width: 12px; height: 12px; flex: none; }
.local-model-progress { display: grid; gap: 4px; padding-top: 2px; }
.local-model-progress-detail { display: flex; justify-content: space-between; align-items: center; gap: 8px; line-height: 1.4; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.local-model progress { width: 100%; height: 4px; border: 0; border-radius: 2px; overflow: hidden; background: var(--surface-soft); accent-color: var(--brand); }
.local-model progress::-webkit-progress-bar { background: var(--surface-soft); }
.local-model progress::-webkit-progress-value { background: var(--brand); }
.local-model progress::-moz-progress-bar { background: var(--brand); }
.local-models-button, .local-models-icon { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--line); border-radius: 6px; min-height: 26px; padding: 3px 9px; background: var(--surface); color: var(--ink); font: inherit; font-size: 11px; font-weight: 500; cursor: pointer; line-height: 1.35; white-space: nowrap; transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease; }
.local-models-icon { width: 26px; height: 26px; padding: 3px; flex: none; color: var(--muted); }
.local-models-button.primary { border-color: color-mix(in srgb, var(--brand) 48%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); }
.local-model:not(.selected) .local-models-button.primary { border-color: var(--fr-color-line-strong, var(--line)); color: var(--ink); background: var(--surface); }
.local-model:not(.selected) .local-models-button.primary:hover:not(:disabled) { border-color: color-mix(in srgb, var(--brand) 48%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); }
.local-models button:disabled { opacity: .55; cursor: default; }
.local-models button:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-strong); }
.local-models :is(button, input, textarea, a):focus-visible, .local-model-description a:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.local-models-notes { display: grid; gap: 8px; }
.local-models-notes p { margin: 0; font-size: 11px; line-height: 1.6; color: var(--muted); }
.local-models-background-note { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.local-models-notes .local-models-pending { padding: 7px 11px; border: 1px solid var(--line); border-radius: var(--fr-radius-sm, 8px); background: var(--surface-soft); color: var(--ink); font-size: 12px; line-height: 1.5; }
.local-models-error { margin: 0; color: var(--el-color-danger) !important; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.local-model-trial { display: grid; gap: 8px; margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--line); }
.local-model-trial-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 14px; }
.local-model-trial-heading h3 { margin: 0; }
.local-model-trial-target { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; color: var(--muted); font-size: 12px; }
.local-model-trial-target :deep(.segmented-control) { width: auto; }
.local-model-trial-target :deep(.segmented-control button) { white-space: nowrap; }
/* 输入框与操作栏合成一个输入区：语言在标题右侧选择，翻译按钮固定在输入区右下角；支持 field-sizing 的浏览器里输入框随内容增高。 */
.local-model-trial-composer { display: grid; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); transition: border-color 150ms ease; }
.local-model-trial-composer:focus-within { border-color: var(--brand); }
.local-model-trial textarea { width: 100%; box-sizing: border-box; field-sizing: content; min-height: 68px; max-height: 200px; resize: none; padding: 10px 12px 4px; border: 0; border-radius: 10px 10px 0 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; line-height: 1.65; }
.local-model-trial-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 10px 8px; }
.local-model-trial-actions .local-model-trial-status { margin: 0 auto 0 4px; }
.local-model-trial-result { border-left: 2px solid var(--brand); padding: 4px 12px; }
.local-model-trial-result p { margin: 0 0 6px; font-size: 12px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.local-model-trial-result small, .local-model-trial-status { color: var(--muted); font-size: 11px; }
@container (max-width: 340px) {
  .local-model-foot { flex-wrap: wrap; }
}
</style>
