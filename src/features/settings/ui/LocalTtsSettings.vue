<!--
 * @file src/features/settings/ui/LocalTtsSettings.vue
 * 文件职责：统一管理在线与本地朗读的来源策略、实时回退链路、默认语速、在线多源优先级、OpenAI 兼容语音参数、在线/本地音色试听以及 Kokoro 模型生命周期。
 * 主要内容：提供在线优先、本地优先、仅在线、仅本地四种来源切换并实时展示生效回退链路；支持快捷倍速档位、在线多源启停与重排（至少保留一项）、选中 OpenAI 来源时展示模型与音色配置及密钥提示；为在线音色与本地音色提供一键试听（支持页面音频播放、Offscreen 播放态同步与浏览器语音兜底），并在切换/隐藏/卸载时立即停止试听与释放对象 URL；模型状态读取失败时提供一键重新读取，下载模型时显示真实字节进度，所有配置写回与后台动作均受当前配置上下文门禁保护，避免旧视图事件污染新配置。
 * 模块边界：只修改传入的配置副本并调用后台模型管理或朗读试听消息，不执行 TTS 推理，也不直接访问 Offscreen 或缓存存储；下载进度只读取后台转存的变化事件，不暴露任何模型下载来源或镜像地址。
 -->
<template>
  <SettingsGroup class="speech-settings" :title="t('settings.experience.speechTitle')" data-testid="speech-settings">
    <SettingsItem class="speech-source-row" :label="t('settings.localTts.source')" :description="modeDescription">
      <SegmentedControl
        :model-value="ttsMode"
        :onUpdate:modelValue="actions.mode"
        :disabled="!active"
        :options="modeOptions"
        :label="t('settings.localTts.source')"
      />
    </SettingsItem>

    <div class="tts-fallback-chain" data-testid="speech-fallback-chain">
      <span class="tts-fallback-label">{{ t('settings.tts.fallbackChain') }}</span>
      <ol class="tts-fallback-steps" :aria-label="t('settings.tts.fallbackChain')">
        <li
          v-for="(step, index) in fallbackChain"
          :key="step"
          class="tts-fallback-step"
        >
          <span
            class="tts-fallback-pill"
            :class="{'is-primary': index === 0, 'is-local': step === 'local', 'is-browser': step === 'browser'}"
          >
            {{ sourceLabel(step) }}
          </span>
          <svg
            v-if="index < fallbackChain.length - 1"
            class="tts-fallback-arrow"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3.5 8h9m0 0-3-3m3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </li>
      </ol>
    </div>

    <SettingsItem
      class="speech-rate-row"
      :label="t('settings.tts.rate')"
      :description="t('settings.tts.rateDescription')"
      data-testid="speech-rate"
    >
      <div class="tts-rate-group" role="radiogroup" :aria-label="t('settings.tts.rate')" :aria-disabled="!active">
        <button
          v-for="preset in SELECTION_TTS_RATE_PRESETS"
          :key="preset"
          type="button"
          role="radio"
          class="tts-rate-pill"
          :class="{active: speechRate === preset}"
          :aria-checked="speechRate === preset"
          :tabindex="active && activeRatePreset === preset ? 0 : -1"
          :disabled="!active"
          :onClick="actions.rateHandlers[preset]"
        >
          {{ `${preset}x` }}
        </button>
      </div>
    </SettingsItem>

    <SettingsItem
      v-if="ttsMode !== 'local-only'"
      class="speech-online-sources-row"
      :label="t('settings.tts.onlineSources')"
      :description="t('settings.tts.onlineSourcesDescription')"
      data-testid="speech-online-sources"
    >
      <div class="tts-source-list">
        <div
          v-for="item in orderedSourceItems"
          :key="item.id"
          class="tts-source-chip"
          :class="{'is-enabled': item.enabled, 'is-disabled': !item.enabled}"
          :data-source="item.id"
        >
          <button
            type="button"
            role="switch"
            class="tts-source-toggle"
            :aria-checked="item.enabled"
            :disabled="!active || (item.enabled && !item.canDisable)"
            :onClick="actions.toggleSource[item.id]"
          >
            <span class="tts-source-order" aria-hidden="true">{{ item.enabled ? item.enabledIndex + 1 : '–' }}</span>
            <span class="tts-source-indicator" aria-hidden="true" />
            <span class="tts-source-name">{{ sourceLabel(item.id) }}</span>
          </button>
          <div v-if="item.enabled" class="tts-source-reorder">
            <button
              type="button"
              class="tts-source-move"
              :aria-label="t('settings.tts.moveUp')"
              :title="t('settings.tts.moveUp')"
              :disabled="!active || !item.canMoveUp"
              :onClick="actions.moveSourceUp[item.id]"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4.5 9.75 8 6.25l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              class="tts-source-move"
              :aria-label="t('settings.tts.moveDown')"
              :title="t('settings.tts.moveDown')"
              :disabled="!active || !item.canMoveDown"
              :onClick="actions.moveSourceDown[item.id]"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4.5 6.25 8 9.75l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </SettingsItem>

    <SettingsItem
      v-if="ttsMode !== 'local-only' && onlineSources.includes('openai')"
      class="speech-openai-row"
      :class="{'is-missing-key': !hasOpenAiKey}"
      :label="t('settings.tts.openAiVoice')"
      :description="hasOpenAiKey ? t('settings.tts.openAiHint') : t('settings.tts.openAiMissingKey')"
      data-testid="speech-openai-config"
    >
      <el-select
        class="tts-openai-select"
        :model-value="openAiModel"
        :onUpdate:modelValue="actions.openAiModel"
        :disabled="!active"
        :aria-label="t('configDiff.selectionTtsOpenAiModel')"
      >
        <el-option
          v-for="item in SELECTION_TTS_OPENAI_MODEL_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select
        class="tts-openai-select"
        :model-value="openAiVoice"
        :onUpdate:modelValue="actions.openAiVoice"
        :disabled="!active"
        :aria-label="t('configDiff.selectionTtsOpenAiVoice')"
      >
        <el-option
          v-for="item in SELECTION_TTS_OPENAI_VOICE_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
    </SettingsItem>

    <SettingsItem
      v-if="ttsMode !== 'local-only'"
      class="speech-voice-row"
      :label="t('settings.experience.onlineSpeechTitle')"
      :help="translateLegacy('留空时根据语言自动尝试免费 Edge 音色；选择多个音色后，朗读失败时按此顺序尝试，无需 API Key')"
      data-testid="speech-online-voices"
    >
      <el-select
        :model-value="config.selectionTtsVoices"
        :onUpdate:modelValue="actions.voices"
        :disabled="!active"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        :aria-label="translateLegacy('划词翻译备用音色顺序')"
        :placeholder="translateLegacy('自动按语言选择')"
      >
        <el-option
          v-for="item in SELECTION_TTS_VOICE_OPTIONS"
          :key="item.value"
          :label="formatOnlineVoiceLabel(item)"
          :value="item.value"
        />
      </el-select>
      <button
        type="button"
        class="tts-preview-button"
        :class="{'is-active': previewTarget === 'online' && previewPhase !== 'idle'}"
        :disabled="!active"
        data-testid="speech-online-preview"
        :aria-busy="previewTarget === 'online' && previewPhase === 'loading'"
        :onClick="actions.previewOnline"
      >
        <svg v-if="previewTarget === 'online' && previewPhase === 'loading'" class="is-loading" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-dasharray="24 12" stroke-linecap="round" />
        </svg>
        <svg v-else-if="previewTarget === 'online' && previewPhase === 'playing'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 6.2h2.2L8.6 3.5v9L5.4 9.8H3.2a.7.7 0 0 1-.7-.7V6.9a.7.7 0 0 1 .7-.7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M10.8 5.8a3.2 3.2 0 0 1 0 4.4M12.6 4.1a5.6 5.6 0 0 1 0 7.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span>{{ previewButtonLabel('online') }}</span>
      </button>
    </SettingsItem>

    <SettingsItem
      v-if="ttsMode !== 'online-only'"
      class="speech-voice-row"
      :label="t('settings.localTts.voice')"
      data-testid="speech-local-voice"
    >
      <el-select :model-value="localVoice" :onUpdate:modelValue="actions.voice" :disabled="!active" :aria-label="t('settings.localTts.voice')" filterable>
        <el-option
          v-for="option in voiceOptions"
          :key="option.value"
          :label="option.value === 'auto' ? translateLegacy(option.label) : `${translateLegacy(option.label)} · ${option.locale}`"
          :value="option.value"
        />
      </el-select>
      <button
        type="button"
        class="tts-preview-button"
        :class="{'is-active': previewTarget === 'local' && previewPhase !== 'idle'}"
        :disabled="!active || !downloaded"
        data-testid="speech-local-preview"
        :aria-busy="previewTarget === 'local' && previewPhase === 'loading'"
        :onClick="actions.previewLocal"
      >
        <svg v-if="previewTarget === 'local' && previewPhase === 'loading'" class="is-loading" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-dasharray="24 12" stroke-linecap="round" />
        </svg>
        <svg v-else-if="previewTarget === 'local' && previewPhase === 'playing'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 6.2h2.2L8.6 3.5v9L5.4 9.8H3.2a.7.7 0 0 1-.7-.7V6.9a.7.7 0 0 1 .7-.7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M10.8 5.8a3.2 3.2 0 0 1 0 4.4M12.6 4.1a5.6 5.6 0 0 1 0 7.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span>{{ previewButtonLabel('local') }}</span>
      </button>
    </SettingsItem>

    <div v-if="ttsMode !== 'online-only'" class="local-tts-model-row" data-testid="local-tts-model-row">
      <div class="local-tts-model-copy">
        <div class="local-tts-model-heading">
          <span class="local-tts-model-icon" aria-hidden="true"><Cpu /></span>
          <div>
            <strong>{{ t('settings.localTts.model') }}</strong>
            <small>{{ t('settings.localTts.modelDescription', {size: LOCAL_TTS_MODEL.downloadSizeMb}) }}</small>
          </div>
        </div>
        <DownloadProgress
          v-if="downloading"
          class="local-tts-model-progress"
          :progress="progress"
          :label="t('settings.localTts.statusDownloading')"
          data-testid="local-tts-progress"
        />
        <p v-else class="local-tts-model-status" role="status" aria-live="polite">
          {{ !statusLoaded
            ? t('settings.localTts.statusReading')
            : downloaded
              ? t('settings.localTts.statusReady')
              : t('settings.localTts.statusNotDownloaded') }}
        </p>
      </div>
      <button
        v-if="downloaded"
        type="button"
        class="local-tts-model-action"
        :disabled="!active || removing || downloading || !browserCapabilities.extensionDom"
        data-testid="local-tts-remove"
        :aria-label="t('settings.localTts.remove')"
        :onClick="actions.remove"
      >
        <component :is="removing ? Loading : Delete" :class="{'is-loading': removing}" aria-hidden="true" />
        {{ removing ? t('modelCache.removing') : t('settings.localTts.remove') }}
      </button>
      <button
        v-else
        type="button"
        class="local-tts-model-action"
        :disabled="!active || !statusLoaded || downloading || !browserCapabilities.extensionDom"
        data-testid="local-tts-download"
        :aria-label="t('settings.localTts.download')"
        :onClick="actions.download"
      >
        <component :is="downloading ? Loading : Download" :class="{'is-loading': downloading}" aria-hidden="true" />
        {{ downloading ? t('settings.localTts.statusDownloading') : t('settings.localTts.download') }}
      </button>
    </div>

    <p v-if="ttsMode !== 'online-only' && !browserCapabilities.extensionDom" class="local-tts-warning" role="status">{{ t('settings.localTts.unavailable') }}</p>
    <div v-if="errorMessage" class="local-tts-error-row">
      <p class="local-tts-error" role="alert">{{ errorMessage }}</p>
      <button
        v-if="statusReadFailed"
        type="button"
        class="local-tts-retry"
        data-testid="local-tts-retry-status"
        :disabled="!active"
        :onClick="actions.retryStatus"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M12.7 6.5A5 5 0 1 0 12.2 10.6M12.7 3.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ t('settings.tts.retryStatus') }}
      </button>
    </div>
    <p v-if="previewError" class="local-tts-error local-tts-preview-error" role="alert">{{ previewError }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, toRef, watch} from 'vue'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
import browser from 'webextension-polyfill'
import {Cpu, Delete, Download, Loading} from '@element-plus/icons-vue'
import type {Config} from '@/src/core/config/model'
import {getServiceApiKeys} from '@/src/core/config/apiKeys'
import {
  DEFAULT_SELECTION_TTS_RATE,
  SELECTION_TTS_ONLINE_SOURCE_OPTIONS,
  SELECTION_TTS_OPENAI_MODEL_OPTIONS,
  SELECTION_TTS_OPENAI_VOICE_OPTIONS,
  SELECTION_TTS_RATE_PRESETS,
  SELECTION_TTS_VOICE_OPTIONS,
  normalizeSelectionTtsOnlineSources,
  normalizeSelectionTtsOpenAiModel,
  normalizeSelectionTtsOpenAiVoice,
  normalizeSelectionTtsRate,
  selectionTtsPreviewText,
  selectionTtsVoiceLocale,
  type SelectionTtsOnlineSourceId,
  type SelectionTtsOpenAiModel,
  type SelectionTtsOpenAiVoice,
  type SelectionTtsVoiceOption,
} from '@/src/core/config/selectionTts'
import {
  LOCAL_TTS_MODE_OPTIONS,
  LOCAL_TTS_MODEL,
  LOCAL_TTS_VOICE_OPTIONS,
  LOCAL_TTS_MODEL_STATE_KEY,
  normalizeLocalTtsMode,
  normalizeLocalTtsVoice,
  type LocalTtsMode,
  type LocalTtsVoiceId,
} from '@/src/core/config/localTts'
import {
  createSelectionTtsClientRequestId,
  loadBrowserSpeechVoices,
  normalizeSpeechLanguage,
  selectBrowserSpeechVoice,
} from '@/src/features/selection-translation/speech/public'
import {LOCAL_TTS_DOWNLOAD_ID, type DownloadProgress as DownloadProgressValue} from '@/src/core/download/progress'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {watchDownloadProgress} from '@/src/platform/storage/downloadProgress'
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue'
import {useUiI18n} from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import SegmentedControl from './components/SegmentedControl.vue'

type FallbackNodeId = SelectionTtsOnlineSourceId | 'local' | 'browser'
type PreviewTarget = 'online' | 'local'
type PreviewPhase = 'idle' | 'loading' | 'playing'

interface PreviewTtsResponse {
  success?: unknown
  transport?: unknown
  audioBase64?: unknown
  contentType?: unknown
  source?: unknown
  error?: unknown
}

const props = withDefaults(defineProps<{config: Config; active?: boolean; context?: unknown}>(), {active: true})
const config = toRef(props, 'config')
const {t, translateLegacy, language} = useUiI18n()
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.context])

const ttsMode = computed<LocalTtsMode>(() => normalizeLocalTtsMode(config.value.selectionTtsMode))
const localVoice = computed<LocalTtsVoiceId>(() => normalizeLocalTtsVoice(config.value.selectionTtsLocalVoice))
const speechRate = computed<number>(() => normalizeSelectionTtsRate(config.value.selectionTtsRate))
const activeRatePreset = computed<number>(() => (
  SELECTION_TTS_RATE_PRESETS.includes(speechRate.value) ? speechRate.value : DEFAULT_SELECTION_TTS_RATE
))
const onlineSources = computed<SelectionTtsOnlineSourceId[]>(() => normalizeSelectionTtsOnlineSources(config.value.selectionTtsOnlineSources))
const openAiModel = computed<SelectionTtsOpenAiModel>(() => normalizeSelectionTtsOpenAiModel(config.value.selectionTtsOpenAiModel))
const openAiVoice = computed<SelectionTtsOpenAiVoice>(() => normalizeSelectionTtsOpenAiVoice(config.value.selectionTtsOpenAiVoice))
const LOCAL_OPENAI_TTS_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isLocalOpenAiTtsEndpoint(proxyUrl: string): boolean {
  const trimmed = proxyUrl.trim()
  if (!trimmed) return false
  try {
    return LOCAL_OPENAI_TTS_HOSTS.has(new URL(trimmed).hostname.toLowerCase())
  } catch {
    return false
  }
}

const hasOpenAiKey = computed<boolean>(() => (
  getServiceApiKeys(config.value, 'openai').length > 0 || isLocalOpenAiTtsEndpoint(config.value.proxy?.openai ?? '')
))

const fallbackChain = computed<FallbackNodeId[]>(() => {
  if (ttsMode.value === 'local-only') return ['local']
  if (ttsMode.value === 'online-only') return [...onlineSources.value, 'browser']
  if (ttsMode.value === 'local-first') return ['local', ...onlineSources.value, 'browser']
  return [...onlineSources.value, 'local', 'browser']
})

const orderedSourceItems = computed(() => {
  const enabled = onlineSources.value
  const enabledItems = enabled.map((id, index) => ({
    id,
    enabled: true,
    enabledIndex: index,
    canDisable: enabled.length > 1,
    canMoveUp: index > 0,
    canMoveDown: index < enabled.length - 1,
  }))
  const disabledItems = SELECTION_TTS_ONLINE_SOURCE_OPTIONS
    .filter((option) => !enabled.includes(option.value))
    .map((option) => ({
      id: option.value,
      enabled: false,
      enabledIndex: -1,
      canDisable: false,
      canMoveUp: false,
      canMoveDown: false,
    }))
  return [...enabledItems, ...disabledItems]
})

function sourceLabel(source: FallbackNodeId): string {
  switch (source) {
    case 'edge': return t('settings.tts.sourceEdge')
    case 'youdao': return t('settings.tts.sourceYoudao')
    case 'google': return t('settings.tts.sourceGoogle')
    case 'openai': return t('settings.tts.sourceOpenAi')
    case 'local': return t('settings.tts.sourceLocal')
    case 'browser': return t('settings.tts.sourceBrowser')
  }
}

function formatOnlineVoiceLabel(item: SelectionTtsVoiceOption): string {
  const genderSymbol = item.gender === 'Female' ? '♀' : '♂'
  return `${item.label} · ${item.locale} · ${genderSymbol}${item.multilingual ? ' · Multilingual' : ''}`
}

const actions = computed(() => {
  const current = capture(), target = props.config
  const updateOnlineSources = (value: SelectionTtsOnlineSourceId[]) => {
    if (current()) target.selectionTtsOnlineSources = normalizeSelectionTtsOnlineSources(value)
  }
  const updateRate = (value: number) => {
    if (current()) target.selectionTtsRate = normalizeSelectionTtsRate(value)
  }

  const rateHandlers = Object.fromEntries(
    SELECTION_TTS_RATE_PRESETS.map((preset) => [preset, () => updateRate(preset)]),
  ) as Record<number, () => void>

  const toggleSource = Object.fromEntries(
    SELECTION_TTS_ONLINE_SOURCE_OPTIONS.map((option) => [option.value, () => {
      if (!current()) return
      const existing = normalizeSelectionTtsOnlineSources(target.selectionTtsOnlineSources)
      if (existing.includes(option.value)) {
        if (existing.length <= 1) return
        updateOnlineSources(existing.filter((item) => item !== option.value))
      } else {
        updateOnlineSources([...existing, option.value])
      }
    }]),
  ) as Record<SelectionTtsOnlineSourceId, () => void>

  const moveSource = (source: SelectionTtsOnlineSourceId, offset: -1 | 1) => {
    if (!current()) return
    const existing = normalizeSelectionTtsOnlineSources(target.selectionTtsOnlineSources)
    const index = existing.indexOf(source)
    const nextIndex = index + offset
    if (index < 0 || nextIndex < 0 || nextIndex >= existing.length) return
    const reordered = [...existing]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(nextIndex, 0, moved)
    updateOnlineSources(reordered)
  }

  const moveSourceUp = Object.fromEntries(
    SELECTION_TTS_ONLINE_SOURCE_OPTIONS.map((option) => [option.value, () => moveSource(option.value, -1)]),
  ) as Record<SelectionTtsOnlineSourceId, () => void>

  const moveSourceDown = Object.fromEntries(
    SELECTION_TTS_ONLINE_SOURCE_OPTIONS.map((option) => [option.value, () => moveSource(option.value, 1)]),
  ) as Record<SelectionTtsOnlineSourceId, () => void>

  return {
    mode: (value: string | number) => {if (current()) target.selectionTtsMode = normalizeLocalTtsMode(value)},
    voice: (value: LocalTtsVoiceId) => {if (current()) target.selectionTtsLocalVoice = normalizeLocalTtsVoice(value)},
    voices: (value: string[]) => {if (current()) target.selectionTtsVoices = value},
    rate: updateRate,
    rateHandlers,
    onlineSources: updateOnlineSources,
    toggleSource,
    moveSourceUp,
    moveSourceDown,
    openAiModel: (value: string) => {if (current()) target.selectionTtsOpenAiModel = normalizeSelectionTtsOpenAiModel(value)},
    openAiVoice: (value: string) => {if (current()) target.selectionTtsOpenAiVoice = normalizeSelectionTtsOpenAiVoice(value)},
    download: () => downloadModel(current),
    remove: () => removeModel(current),
    retryStatus: () => {if (current()) void refresh(true)},
    previewOnline: () => void togglePreview('online', current),
    previewLocal: () => void togglePreview('local', current),
  }
})

const modeOptions = computed(() => LOCAL_TTS_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: t(`settings.localTts.${option.value === 'online-first' ? 'onlineFirst' : option.value === 'local-first' ? 'localFirst' : option.value === 'online-only' ? 'onlineOnly' : 'localOnly'}`),
})))
const modeDescription = computed(() => t(`settings.localTts.mode.${ttsMode.value === 'online-first' ? 'onlineFirst' : ttsMode.value === 'local-first' ? 'localFirst' : ttsMode.value === 'online-only' ? 'onlineOnly' : 'localOnly'}Description`))
const voiceOptions = computed(() => LOCAL_TTS_VOICE_OPTIONS.filter((option) => option.value === 'auto' || LOCAL_TTS_MODEL.voices.includes(option.value as never)))
const downloaded = ref(false)
const statusLoaded = ref(false)
// 本页发起的请求与其他页面发起、仍在进行的下载都算“下载中”；后者只能从实时进度事件得知。
const requesting = ref(false)
const observedDownload = ref(false)
const downloading = computed(() => !downloaded.value && (requesting.value || observedDownload.value || pendingDownloads.value > 0))
const progress = ref<DownloadProgressValue>()
const removing = ref(false)
const errorMessage = ref('')
const statusReadFailed = ref(false)
let stopObserving: (() => void) | undefined
const mounted = ref(false)
// 只记录本实例已交给后台、尚未回包的下载，不取消后台任务或伪造进度。
const pendingDownloads = ref(0)
let generation = 0

// 语音试听状态与资源所有权；失活、配置替换或卸载时立即中止播放并回收对象 URL。
const previewTarget = ref<PreviewTarget | null>(null)
const previewPhase = ref<PreviewPhase>('idle')
const previewError = ref('')
let previewGeneration = 0
let previewAudio: HTMLAudioElement | null = null
let previewAudioUrl: string | null = null
let previewUtterance: SpeechSynthesisUtterance | null = null
let activePreviewRequestId: string | null = null
let stopOffscreenPreviewListener: (() => void) | undefined

function previewButtonLabel(target: PreviewTarget): string {
  if (previewTarget.value === target && previewPhase.value === 'loading') return t('settings.tts.previewLoading')
  if (previewTarget.value === target && previewPhase.value === 'playing') return t('settings.tts.previewStop')
  return t('settings.tts.preview')
}

function releasePreviewAudio(): void {
  if (previewAudio) {
    previewAudio.onended = null
    previewAudio.onerror = null
    try {previewAudio.pause()} catch {}
    try {previewAudio.src = ''} catch {}
    previewAudio = null
  }
  if (previewAudioUrl) {
    try {URL.revokeObjectURL(previewAudioUrl)} catch {}
    previewAudioUrl = null
  }
}

function releasePreviewUtterance(): void {
  if (!previewUtterance) return
  previewUtterance.onend = null
  previewUtterance.onerror = null
  previewUtterance = null
  try {globalThis.speechSynthesis?.cancel()} catch {}
}

function stopPreview(notifyRemote = true): void {
  previewGeneration += 1
  stopOffscreenPreviewListener?.()
  stopOffscreenPreviewListener = undefined
  releasePreviewAudio()
  releasePreviewUtterance()
  const requestId = activePreviewRequestId
  activePreviewRequestId = null
  previewTarget.value = null
  previewPhase.value = 'idle'
  if (notifyRemote && requestId) {
    void Promise.resolve()
      .then(() => browser.runtime.sendMessage({type: 'selectionTtsStop', clientRequestId: requestId}))
      .catch(() => undefined)
  }
}

function resolvePreviewLocale(target: PreviewTarget): string {
  const uiLocale = typeof language?.value === 'string' && language.value ? language.value : 'en-US'
  if (target === 'local') {
    if (localVoice.value !== 'auto') {
      const option = LOCAL_TTS_VOICE_OPTIONS.find((item) => item.value === localVoice.value)
      if (option) return option.locale
    }
    return uiLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  }
  const firstVoice = Array.isArray(config.value.selectionTtsVoices) ? config.value.selectionTtsVoices[0] : undefined
  if (typeof firstVoice === 'string' && firstVoice.trim()) {
    return normalizeSpeechLanguage(selectionTtsVoiceLocale(firstVoice), 'en-US')
  }
  return normalizeSpeechLanguage(uiLocale, 'en-US')
}

async function fallbackPreviewWithBrowserSpeech(
  text: string,
  locale: string,
  rate: number,
  runGeneration: number,
  current: () => boolean,
): Promise<boolean> {
  const synth = globalThis.speechSynthesis
  const UtteranceCtor = globalThis.SpeechSynthesisUtterance
  if (!synth || typeof synth.speak !== 'function' || typeof UtteranceCtor !== 'function') return false
  try {
    const voices = await loadBrowserSpeechVoices(synth)
    if (!current() || runGeneration !== previewGeneration) return true
    const utterance = new UtteranceCtor(text)
    utterance.lang = locale
    utterance.rate = rate
    const preferredVoice = selectBrowserSpeechVoice(voices, locale)
    if (preferredVoice) utterance.voice = preferredVoice
    utterance.onend = () => {
      if (runGeneration !== previewGeneration) return
      previewUtterance = null
      previewTarget.value = null
      previewPhase.value = 'idle'
    }
    utterance.onerror = () => {
      if (runGeneration !== previewGeneration) return
      previewUtterance = null
      previewTarget.value = null
      previewPhase.value = 'idle'
      if (current()) previewError.value = t('settings.tts.previewFailed')
    }
    previewUtterance = utterance
    previewPhase.value = 'playing'
    synth.cancel()
    synth.speak(utterance)
    return true
  } catch {
    return false
  }
}

function detachOffscreenPreviewListener(): void {
  stopOffscreenPreviewListener?.()
  stopOffscreenPreviewListener = undefined
}

function attachOffscreenPreviewListener(
  clientRequestId: string,
  runGeneration: number,
  current: () => boolean,
  onTerminal: () => void,
): () => void {
  detachOffscreenPreviewListener()
  const onMessage = browser.runtime?.onMessage
  if (!onMessage || typeof onMessage.addListener !== 'function') return () => undefined
  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    try {onMessage.removeListener(listener)} catch {}
    if (stopOffscreenPreviewListener === detach) stopOffscreenPreviewListener = undefined
  }
  const listener = (message: unknown): undefined => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
    const payload = message as {type?: unknown; clientRequestId?: unknown; state?: unknown; error?: unknown}
    if (payload.type !== 'selectionTtsState' || payload.clientRequestId !== clientRequestId) return undefined
    if (payload.state !== 'ended' && payload.state !== 'stopped' && payload.state !== 'error') return undefined
    if (runGeneration !== previewGeneration) return undefined
    onTerminal()
    detach()
    activePreviewRequestId = null
    previewTarget.value = null
    previewPhase.value = 'idle'
    if (payload.state === 'error' && current()) {
      previewError.value = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : t('settings.tts.previewFailed')
    }
    return undefined
  }
  onMessage.addListener(listener)
  stopOffscreenPreviewListener = detach
  return detach
}

async function togglePreview(target: PreviewTarget, current = capture()): Promise<void> {
  if (!current()) return
  if (target === 'local' && !downloaded.value) return
  const wasSameActive = previewTarget.value === target && previewPhase.value !== 'idle'
  stopPreview()
  previewError.value = ''
  if (wasSameActive) return

  const runGeneration = previewGeneration
  const locale = resolvePreviewLocale(target)
  const text = selectionTtsPreviewText(locale)
  const rate = speechRate.value
  const clientRequestId = createSelectionTtsClientRequestId()

  previewTarget.value = target
  previewPhase.value = 'loading'
  activePreviewRequestId = clientRequestId

  const canFallbackToBrowser = target === 'online' && ttsMode.value !== 'local-only'
  let offscreenTerminal = false
  let failureHandled = false
  // 在发起后台合成前先挂载 Offscreen 状态监听，避免极短试听音频先于回包结束而漏接 ended。
  const detachListener = attachOffscreenPreviewListener(clientRequestId, runGeneration, current, () => {offscreenTerminal = true})

  const failPreview = async (message?: string) => {
    detachListener()
    if (failureHandled || !current() || runGeneration !== previewGeneration) return
    failureHandled = true
    releasePreviewAudio()
    activePreviewRequestId = null
    if (canFallbackToBrowser && await fallbackPreviewWithBrowserSpeech(text, locale, rate, runGeneration, current)) {
      return
    }
    if (!current() || runGeneration !== previewGeneration) return
    previewTarget.value = null
    previewPhase.value = 'idle'
    previewError.value = message && message.trim() ? message : t('settings.tts.previewFailed')
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: 'selectionTts',
      text,
      language: locale,
      rate,
      clientRequestId,
      modeOverride: target === 'local' ? 'local-only' : 'online-only',
    }) as PreviewTtsResponse | undefined

    if (!current() || runGeneration !== previewGeneration) {
      detachListener()
      if (response?.success === true && response.transport === 'offscreen' && !offscreenTerminal) {
        void Promise.resolve()
          .then(() => browser.runtime.sendMessage({type: 'selectionTtsStop', clientRequestId}))
          .catch(() => undefined)
      }
      return
    }

    if (response?.success === true && response.transport === 'offscreen') {
      if (!offscreenTerminal) previewPhase.value = 'playing'
      return
    }

    detachListener()

    if (response?.success === true && typeof response.audioBase64 === 'string' && response.audioBase64) {
      activePreviewRequestId = null
      const binary = atob(response.audioBase64)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      const mimeType = typeof response.contentType === 'string' && response.contentType.trim()
        ? response.contentType
        : 'audio/mpeg'
      const blobUrl = URL.createObjectURL(new Blob([bytes], {type: mimeType}))
      const audio = new Audio(blobUrl)
      if (response.source === 'youdao' || response.source === 'google') {
        audio.playbackRate = rate
      }
      previewAudioUrl = blobUrl
      previewAudio = audio
      audio.onended = () => {
        if (runGeneration !== previewGeneration) return
        releasePreviewAudio()
        previewTarget.value = null
        previewPhase.value = 'idle'
      }
      audio.onerror = () => {
        if (runGeneration !== previewGeneration) return
        void failPreview()
      }
      previewPhase.value = 'playing'
      await audio.play()
      return
    }

    await failPreview(typeof response?.error === 'string' ? response.error : undefined)
  } catch {
    await failPreview()
  }
}

function readDownloaded(response: unknown): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  const record = response as {downloaded?: unknown; models?: unknown}
  if (record.downloaded === true) return true
  return Array.isArray(record.models)
    && Boolean(record.models[0] && typeof record.models[0] === 'object' && (record.models[0] as {downloaded?: unknown}).downloaded === true)
}

async function refresh(force = false): Promise<void> {
  const current = capture()
  if (!current() || !force && (downloading.value || removing.value)) return
  const request = ++generation
  if (!browserCapabilities.extensionDom) {
    statusLoaded.value = true
    return
  }
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadGetLocalTtsModelState'}) as unknown
    if (!current() || request !== generation) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(t('settings.localTts.statusReadFailed'))
    }
    downloaded.value = readDownloaded(response)
    if (statusReadFailed.value) {
      errorMessage.value = ''
      statusReadFailed.value = false
    }
  } catch {
    if (current() && request === generation) {
      statusReadFailed.value = true
      errorMessage.value = t('settings.localTts.statusReadFailed')
    }
  } finally {
    if (current() && request === generation) statusLoaded.value = true
  }
}

async function downloadModel(current = capture()): Promise<void> {
  if (!current() || pendingDownloads.value || !statusLoaded.value || downloading.value || removing.value || !browserCapabilities.extensionDom) return
  generation++
  statusReadFailed.value = false
  errorMessage.value = ''
  progress.value = undefined
  requesting.value = true
  pendingDownloads.value++
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadPrepareLocalTtsModel'}) as unknown
    if (!current()) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(response && typeof response === 'object' && typeof (response as {error?: unknown}).error === 'string'
        ? (response as {error: string}).error
        : t('settings.localTts.downloadFailed'))
    }
    downloaded.value = true
  } catch (error) {
    if (current()) errorMessage.value = error instanceof Error ? error.message : t('settings.localTts.downloadFailed')
  } finally {
    pendingDownloads.value--
    if (current()) {
      requesting.value = false
      observedDownload.value = false
    }
    // 命令结算后新视图独立重读权威状态，不移交旧回包或错误。
    if (active.value) await refresh()
  }
}

function handleDownloadProgress(_id: string, next: DownloadProgressValue | undefined): void {
  progress.value = next
  if (next) {
    observedDownload.value = true
    return
  }
  // 结束事件不说明成败；不是本页发起的下载需要重新读取模型状态。
  const external = observedDownload.value && !requesting.value
  observedDownload.value = false
  if (external) void refresh()
}

async function removeModel(current = capture()): Promise<void> {
  if (!current() || removing.value || downloading.value || !browserCapabilities.extensionDom) return
  generation++
  statusReadFailed.value = false
  errorMessage.value = ''
  removing.value = true
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadRemoveLocalTtsModel'}) as unknown
    if (!current()) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(response && typeof response === 'object' && typeof (response as {error?: unknown}).error === 'string'
        ? (response as {error: string}).error
        : t('modelCache.removeFailed'))
    }
    downloaded.value = false
  } catch (error) {
    if (current()) errorMessage.value = error instanceof Error ? error.message : t('modelCache.removeFailed')
  } finally {
    if (current()) {
      removing.value = false
      await refresh()
    }
  }
}

watch(() => [mounted.value, revision.value], () => {
  stopObserving?.()
  stopObserving = undefined
  stopPreview()
  previewError.value = ''
  generation++
  requesting.value = false
  removing.value = false
  observedDownload.value = false
  progress.value = undefined
  errorMessage.value = ''
  statusReadFailed.value = false
  statusLoaded.value = false
  if (!mounted.value || !active.value) return
  const current = capture()
  const handleStorageChange = (changes: Record<string, browser.Storage.StorageChange>, areaName: string) => {
    if (current() && areaName === 'local' && changes[LOCAL_TTS_MODEL_STATE_KEY]) void refresh()
  }
  browser.storage.onChanged.addListener(handleStorageChange)
  const stopProgress = watchDownloadProgress([LOCAL_TTS_DOWNLOAD_ID], (id, next) => {if (current()) handleDownloadProgress(id, next)})
  stopObserving = () => {browser.storage.onChanged.removeListener(handleStorageChange); stopProgress()}
  void refresh(true)
}, {flush: 'sync'})
onMounted(() => {mounted.value = true})
onUnmounted(() => {mounted.value = false; stopObserving?.(); stopPreview()})
</script>

<style scoped>
/* 朗读来源与多源列表需要更宽的控件列，避免多语言标签换行或挤压。 */
.speech-settings :deep(.speech-source-row),
.speech-settings :deep(.speech-rate-row),
.speech-settings :deep(.speech-online-sources-row),
.speech-settings :deep(.speech-openai-row),
.speech-settings :deep(.speech-voice-row) {
  grid-template-columns: minmax(0, 1fr) minmax(280px, 440px);
}
.speech-settings :deep(.speech-online-sources-row) { align-items: start; }
.speech-settings :deep(.speech-voice-row .settings-item-control) { flex-wrap: nowrap; }
.speech-settings :deep(.speech-voice-row .el-select) { flex: 1 1 auto; min-width: 0; width: auto; max-width: none; }
.speech-settings :deep(.speech-openai-row .settings-item-control) {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: 8px;
}
.speech-settings :deep(.speech-openai-row .el-select) { width: 100%; max-width: none; }
.speech-settings :deep(.speech-openai-row.is-missing-key .settings-item-copy small) { color: var(--el-color-danger); }

/* 实时回退链路条：紧贴来源策略下方，直观呈现当前生效的合成与回退路径。 */
.tts-fallback-chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 10px var(--fr-card-padding-inline, 20px) 12px;
  border-top: 1px dashed var(--line);
  border-bottom: 1px solid var(--fr-card-border, var(--line));
  background: var(--surface-soft);
}
.tts-fallback-label {
  flex: none;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.tts-fallback-steps {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 0;
}
.tts-fallback-step {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.tts-fallback-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink);
  background: var(--surface);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
}
.tts-fallback-pill.is-primary {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-weight: 600;
}
.tts-fallback-pill.is-browser {
  color: var(--muted);
  background: transparent;
}
.tts-fallback-arrow {
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--muted);
}

/* 快捷倍速选择 */
.tts-rate-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  width: 100%;
}
.tts-rate-pill {
  min-width: 48px;
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
}
.tts-rate-pill:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.tts-rate-pill.active {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-weight: 600;
}
.tts-rate-pill:disabled {
  color: var(--muted);
  background: var(--surface-soft);
  opacity: 0.6;
  cursor: default;
}
.tts-rate-pill:focus-visible,
.tts-source-toggle:focus-visible,
.tts-source-move:focus-visible,
.tts-preview-button:focus-visible,
.local-tts-retry:focus-visible {
  outline: 2px solid var(--brand-strong);
  outline-offset: 1px;
}

/* 在线多源顺序与启停 */
.tts-source-list {
  display: grid;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.tts-source-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  transition: border-color 140ms ease, background-color 140ms ease;
}
.tts-source-chip.is-enabled {
  border-color: color-mix(in srgb, var(--brand) 36%, var(--line));
}
.tts-source-chip.is-disabled {
  background: var(--surface-soft);
  opacity: 0.78;
}
.tts-source-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 26px;
  padding: 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.tts-source-toggle:disabled { cursor: default; }
.tts-source-order {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 999px;
  color: var(--muted);
  background: var(--surface-soft);
  font-size: 11px;
  font-weight: 600;
}
.tts-source-chip.is-enabled .tts-source-order {
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.tts-source-indicator {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 999px;
  border: 1.5px solid var(--muted);
  background: transparent;
}
.tts-source-chip.is-enabled .tts-source-indicator {
  border-color: var(--brand);
  background: var(--brand);
}
.tts-source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tts-source-chip.is-disabled .tts-source-name { color: var(--muted); }
.tts-source-reorder {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.tts-source-move {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
}
.tts-source-move svg { width: 13px; height: 13px; }
.tts-source-move:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.tts-source-move:disabled {
  color: var(--muted);
  background: var(--surface-soft);
  opacity: 0.45;
  cursor: default;
}

/* 音色一键试听按钮 */
.tts-preview-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: none;
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
}
.tts-preview-button svg { width: 14px; height: 14px; flex: none; }
.tts-preview-button:hover:not(:disabled),
.tts-preview-button.is-active {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.tts-preview-button:disabled {
  color: var(--muted);
  background: var(--surface-soft);
  opacity: 0.55;
  cursor: default;
}

.local-tts-model-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-width: 0; padding: 16px 20px; border-top: 1px solid var(--line); }
.local-tts-model-copy { min-width: 0; }
.local-tts-model-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.local-tts-model-heading > div { display: grid; gap: 3px; min-width: 0; }
.local-tts-model-heading strong { color: var(--ink); font-size: 13px; font-weight: 550; line-height: 1.45; }
.local-tts-model-heading small, .local-tts-model-status, .local-tts-warning, .local-tts-error { color: var(--muted); font-size: 12px; line-height: 1.6; }
.local-tts-model-heading small { overflow-wrap: anywhere; }
.local-tts-model-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 8px; color: var(--brand-strong); background: var(--brand-soft); }
.local-tts-model-icon svg, .local-tts-model-action svg { width: 15px; height: 15px; flex: none; }
.local-tts-model-status { margin: 8px 0 0 42px; }
.local-tts-model-copy:has(.local-tts-model-progress) { flex: 1 1 auto; }
.local-tts-model-progress { max-width: 360px; margin: 10px 0 0 42px; }
.local-tts-model-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 112px; min-height: 34px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.local-tts-model-action:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft); }
.local-tts-model-action:disabled { color: var(--muted); background: var(--surface-soft); opacity: .65; cursor: default; }
.local-tts-warning, .local-tts-preview-error { margin: 0; padding: 0 20px 16px; }
.local-tts-error-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 20px 16px; }
.local-tts-error-row .local-tts-error { margin: 0; padding: 0; }
.local-tts-warning, .local-tts-error { color: var(--el-color-danger); }
.local-tts-retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.local-tts-retry svg { width: 13px; height: 13px; flex: none; }
.local-tts-retry:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.local-tts-retry:disabled { opacity: 0.6; cursor: default; }
.is-loading { animation: local-tts-spin 1s linear infinite; }
@keyframes local-tts-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .is-loading { animation: none; }
  .tts-rate-pill, .tts-source-chip, .tts-source-move, .tts-preview-button { transition: none; }
}
@media (max-width: 700px) {
  .tts-fallback-chain { padding: 10px 16px 12px; }
  .local-tts-model-row { align-items: flex-start; flex-direction: column; padding: 14px 12px; }
  .local-tts-model-copy:has(.local-tts-model-progress) { align-self: stretch; }
  .local-tts-model-action { width: 100%; }
  .local-tts-warning, .local-tts-preview-error, .local-tts-error-row { padding-right: 12px; padding-left: 12px; }
}
@media (max-width: 480px) {
  .speech-settings :deep(.speech-source-row),
  .speech-settings :deep(.speech-rate-row),
  .speech-settings :deep(.speech-online-sources-row),
  .speech-settings :deep(.speech-openai-row),
  .speech-settings :deep(.speech-voice-row) {
    grid-template-columns: minmax(0, 1fr);
  }
  .speech-settings :deep(.speech-openai-row .settings-item-control) { grid-template-columns: minmax(0, 1fr); }
  .speech-settings :deep(.speech-voice-row .settings-item-control) { flex-wrap: wrap; }
  .tts-rate-group { justify-content: flex-start; }
  .tts-preview-button { width: 100%; }
  .local-tts-error-row { flex-direction: column; align-items: flex-start; }
}
</style>
