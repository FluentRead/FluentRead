<!--
@file src/features/settings/ui/InformationHighlightModelCard.vue
文件职责：展示本地意外度模型的真实可用性、资源状态和显式下载操作。
主要内容：每张卡独立读取资源状态，简短区分基础与进阶模型，标题单选模型、右下角单个按钮管理资源，下载、续传与删除共用明确确认框；显示真实下载进度和错误，选择与配置切换、隐藏和卸载时拒绝迟到回复与旧确认操作。
模块边界：不直接访问网络、不分析正文、不推断模型已就绪，不自动下载或切换云端；模型校验、资源缓存和 WebGPU 检查由 feature runtime 负责。
-->
<template>
  <section class="information-highlight-model" :class="{'is-compact': compact, 'is-selected': selectable && selected}" data-testid="information-highlight-model-card" :data-information-highlight-model-id="selectedModel.id" :aria-busy="reading && !status">
    <label class="highlight-model-heading" :class="{'is-selectable': selectable}">
      <input v-if="selectable" type="radio" name="information-highlight-local-model" :value="selectedModel.id" :checked="selected" :disabled="!context.active.value" :aria-label="t('informationHighlight.model.selectAction', {name: selectedModel.name})" :onChange="actions.select" data-information-highlight-model-radio :data-information-highlight-model-choice="selectedModel.id" />
      <span v-else class="highlight-model-chip" aria-hidden="true">↓</span>
      <span class="highlight-model-copy"><span class="highlight-model-title"><strong>{{ selectedModel.name }}</strong><span v-if="selectable && selected" class="highlight-model-selected">{{ t('informationHighlight.model.selected') }}</span></span><small v-if="!compact || status && !status.supported">{{ t(selectedModel.id === DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID ? 'informationHighlight.model.description.basic' : 'informationHighlight.model.description.advanced') }}</small></span>
    </label>
    <p v-if="!status || operation === 'remove'" class="highlight-model-status" role="status" aria-live="polite">{{ t(!status ? 'informationHighlight.model.reading' : 'informationHighlight.model.phase.removing') }}</p>
    <DownloadProgress v-if="showProgress" :progress="downloadProgress" :label="t(`informationHighlight.model.phase.${displayPhase}`)" data-testid="information-highlight-model-progress" />
    <p v-if="status && !status.supported" class="highlight-model-notice" role="status">{{ t('informationHighlight.model.webgpuRequired') }}</p>
    <p v-if="hasError" class="highlight-model-error" role="alert">{{ errorLabel }}</p>
    <div class="highlight-model-actions">
      <button v-if="downloading" type="button" :disabled="!context.active.value || operation === 'pause'" :onClick="actions.pause" data-testid="information-highlight-model-pause" data-information-highlight-pause>{{ t('informationHighlight.model.pause') }}</button>
      <button v-else-if="status?.downloaded" type="button" :disabled="!context.active.value || operation !== null || confirming" :onClick="actions.remove" data-testid="information-highlight-model-remove" data-information-highlight-remove>{{ t('informationHighlight.model.remove') }}</button>
      <button v-else type="button" class="highlight-model-primary" :disabled="!context.active.value || reading || operation !== null || confirming || !error && !status?.supported" :onClick="error ? actions.refresh : actions.prepare" data-testid="information-highlight-model-download" data-information-highlight-download>{{ error ? t('informationHighlight.retry') : status?.phase === 'paused' || (status?.downloadedBytes || 0) > 0 ? t('informationHighlight.model.resume') : t('informationHighlight.model.download', {size: formatDownloadBytes(selectedModel.bytes)}) }}</button>
    </div>
  </section>
  <ElDialog v-if="confirmation" :key="confirmation.sequence" :model-value="true" class="fluentread-information-highlight-model-dialog" :title="confirmationTitle" width="min(440px, calc(100vw - 24px))" align-center append-to-body destroy-on-close :show-close="false" :close-on-click-modal="false" :close-on-press-escape="true" :before-close="confirmationActions.cancel" :onUpdate:modelValue="confirmationActions.open" :onClose="confirmationActions.cancel" :onOpenAutoFocus="focusConfirmationCancel" :onOpened="focusConfirmationCancel" data-information-highlight-model-dialog data-information-highlight-confirmation :data-information-highlight-model-id="confirmation.modelId" :data-information-highlight-action="confirmation.action">
    <template #header>
      <div class="highlight-confirm-heading"><h2>{{ confirmationTitle }}</h2><button type="button" class="highlight-confirm-close" :aria-label="t('common.cancel')" :onClick="confirmationActions.cancel" data-information-highlight-close><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></div>
    </template>
    <div class="highlight-confirm-body" data-testid="information-highlight-model-confirmation">
      <div class="highlight-confirm-resource"><strong>{{ confirmation.name }}</strong><span>{{ confirmation.size }}</span></div>
      <p>{{ confirmation.action === 'remove' ? t('informationHighlight.model.remove.confirmBody', {name: confirmation.name}) : t('informationHighlight.model.download.confirmBody') }}</p>
    </div>
    <template #footer>
      <div class="highlight-confirm-actions"><button ref="confirmationCancel" type="button" class="highlight-confirm-cancel" :onClick="confirmationActions.cancel" data-information-highlight-cancel>{{ t('common.cancel') }}</button><button type="button" class="highlight-confirm-primary" :onClick="confirmationActions.confirm" data-information-highlight-confirm>{{ confirmation.action === 'remove' ? t('informationHighlight.model.remove') : confirmation.resuming ? t('informationHighlight.model.resume') : t('informationHighlight.model.download.confirmAction') }}</button></div>
    </template>
  </ElDialog>
</template>
<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import browser from 'webextension-polyfill'
import {ElDialog} from 'element-plus'
import type {InformationHighlightModelStatus} from '@/src/features/information-highlight/protocol'
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel'
import {formatDownloadBytes} from '@/src/core/download/progress'
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
import {useUiI18n} from '@/src/ui/i18n'
const props = withDefaults(defineProps<{active?: boolean; modelId?: InformationHighlightModelId; compact?: boolean; selectable?: boolean; selected?: boolean; contextIdentity?: unknown}>(), {active: true, compact: false, modelId: DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, selectable: false, selected: false})
const emit = defineEmits<{preparing: []; ready: []; select: [modelId: InformationHighlightModelId]}>()
const {t} = useUiI18n()
const selectedModel = computed(() => getInformationHighlightModel(props.modelId))
const context = useSettingsActionContext(() => props.active, () => [selectedModel.value.id, props.selected, props.selectable, props.contextIdentity])
const status = ref<InformationHighlightModelStatus | null>(null)
const reading = ref(false), error = ref(false)
const operation = ref<'prepare' | 'pause' | 'remove' | null>(null)
interface ModelConfirmation {
  sequence: number; action: 'prepare' | 'remove'; modelId: InformationHighlightModelId; name: string; size: string; resuming: boolean
  confirm: () => Promise<void> | void; cancel: () => void
}
const confirmation = ref<ModelConfirmation | null>(null)
const confirming = computed(() => confirmation.value !== null)
const confirmationCancel = ref<HTMLButtonElement>()
const confirmationTitle = computed(() => t(confirmation.value?.action === 'remove' ? 'informationHighlight.model.remove' : 'informationHighlight.model.download.confirmTitle'))
let readSequence = 0, commandSequence = 0, confirmationSequence = 0
let prepared: {current: () => boolean; command: number} | null = null
let timer: ReturnType<typeof setInterval> | undefined
let mounted = false
let currentModelId = selectedModel.value.id
const pageDocument = typeof document === 'undefined' ? undefined : document
const downloading = computed(() => operation.value === 'prepare' && !status.value?.downloaded || Boolean(status.value && ['queued', 'downloading', 'verifying'].includes(status.value.phase)))
const hasError = computed(() => error.value || status.value?.phase === 'error')
const errorLabel = computed(() => t(({
  INFORMATION_HIGHLIGHT_MODEL_NETWORK: 'informationHighlight.model.error.network',
  INFORMATION_HIGHLIGHT_MODEL_INTEGRITY: 'informationHighlight.model.error.integrity',
  INFORMATION_HIGHLIGHT_STORAGE_QUOTA: 'informationHighlight.model.error.quota',
  INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED: 'informationHighlight.model.error.runtime',
  INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED: 'informationHighlight.model.error.runtime',
  INFORMATION_HIGHLIGHT_MODEL_TIMEOUT: 'informationHighlight.model.error.runtime'
} as Record<string, string>)[status.value?.errorCode || ''] || 'informationHighlight.model.error'))
const displayPhase = computed(() => operation.value === 'remove' ? 'removing' : operation.value === 'prepare' && !status.value?.downloaded && !['downloading', 'verifying'].includes(status.value?.phase || '') ? 'queued' : status.value?.phase)
const showProgress = computed(() => downloading.value || Boolean(status.value && ['paused', 'error'].includes(status.value.phase) && status.value.downloadedBytes > 0))
const downloadProgress = computed(() => ({loaded: status.value?.downloadedBytes || 0, total: status.value?.totalBytes || 0}))
function schedulePolling() {
  if (timer) clearInterval(timer)
  timer = undefined
  if (mounted && context.active.value && pageDocument?.visibilityState !== 'hidden') timer = setInterval(() => {void refresh()}, downloading.value || operation.value === 'remove' || (!status.value && !error.value) ? 1000 : 15000)
}
function accept(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const envelope = response as {success?: unknown; status?: InformationHighlightModelStatus}
  const candidate = envelope.status
  if (envelope.success !== true || !candidate || typeof candidate.downloaded !== 'boolean' || typeof candidate.supported !== 'boolean'
    || candidate.modelId !== selectedModel.value.id
    || !['absent', 'queued', 'downloading', 'verifying', 'paused', 'ready', 'error', 'removing'].includes(candidate.phase)
    || !Number.isFinite(candidate.downloadedBytes) || candidate.downloadedBytes < 0
    || !Number.isFinite(candidate.totalBytes) || candidate.totalBytes < 0
    || typeof candidate.initialized !== 'boolean' || typeof candidate.modelName !== 'string'
    || !Number.isFinite(candidate.downloadSizeBytes) || candidate.downloadSizeBytes < 0) return false
  status.value = candidate
  if (prepared && prepared.current() && prepared.command === commandSequence && candidate.phase === 'ready' && candidate.downloaded && candidate.supported) {
    prepared = null; emit('ready')
  }
  if (['error', 'paused', 'removing'].includes(candidate.phase)) prepared = null
  return true
}
async function refresh() {
  if (!context.active.value || reading.value || pageDocument?.visibilityState === 'hidden') return
  const current = context.capture(), sequence = ++readSequence, commandVersion = commandSequence
  reading.value = true
  try {
    const response = await browser.runtime.sendMessage({type: 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS', modelId: selectedModel.value.id})
    if (current() && sequence === readSequence && commandVersion === commandSequence) error.value = !accept(response)
  } catch {if (current() && sequence === readSequence && commandVersion === commandSequence) error.value = true}
  finally {if (sequence === readSequence) {reading.value = false; if (current()) schedulePolling()}}
}
async function run(action: 'prepare' | 'pause' | 'remove') {
  if (!context.active.value || (action === 'prepare' && (!status.value?.supported || status.value.downloaded || downloading.value)) || (action === 'remove' && !status.value?.downloaded)) return
  if (action !== 'pause' && operation.value !== null) return
  const current = context.capture(), sequence = ++commandSequence
  readSequence++; reading.value = false; operation.value = action; error.value = false
  prepared = action === 'prepare' ? {current, command: sequence} : null
  schedulePolling()
  if (action === 'prepare') emit('preparing')
  const type = {prepare: 'PREPARE_INFORMATION_HIGHLIGHT_MODEL', pause: 'PAUSE_INFORMATION_HIGHLIGHT_MODEL', remove: 'REMOVE_INFORMATION_HIGHLIGHT_MODEL'}[action]
  try {
    const response = await browser.runtime.sendMessage({type, modelId: selectedModel.value.id})
    if (current() && sequence === commandSequence) {
      error.value = !accept(response)
      if (error.value) prepared = null
    }
  } catch {if (current() && sequence === commandSequence) {error.value = true; prepared = null}}
  finally {if (current() && sequence === commandSequence) {operation.value = null; void refresh()}}
}
function cancelConfirmation() {
  confirmationSequence++
  confirmation.value = null
}
function requestConfirmation(action: 'prepare' | 'remove', current: () => boolean) {
  if (!current() || pageDocument?.visibilityState === 'hidden' || operation.value !== null || confirming.value) return
  if (action === 'prepare' ? !status.value?.supported || status.value.downloaded || downloading.value : !status.value?.downloaded) return
  const sequence = ++confirmationSequence
  confirmation.value = {sequence, action, modelId: selectedModel.value.id, name: selectedModel.value.name, size: formatDownloadBytes(selectedModel.value.bytes), resuming: status.value?.phase === 'paused' || (status.value?.downloadedBytes || 0) > 0,
    confirm: () => {
      if (!current() || sequence !== confirmationSequence || confirmation.value?.sequence !== sequence) return
      // 消费本次确认后再发命令；重复点击或旧弹窗回调不能再次操作资源。
      cancelConfirmation()
      return run(action)
    }, cancel: () => {if (sequence === confirmationSequence) cancelConfirmation()},
  }
}
const confirmationActions = computed(() => {
  const pending = confirmation.value
  return {confirm: () => pending?.confirm(), cancel: () => pending?.cancel(), open: (value: boolean) => {if (!value) pending?.cancel()}}
})
function focusConfirmationCancel() {
  const sequence = confirmation.value?.sequence
  void nextTick(() => {if (sequence !== undefined && confirmation.value?.sequence === sequence) confirmationCancel.value?.focus({preventScroll: true})})
}
const actions = computed(() => {
  const current = context.capture()
  return {prepare: () => {if (current()) requestConfirmation('prepare', current)}, pause: () => {if (current()) return run('pause')},
    remove: () => {if (current()) requestConfirmation('remove', current)}, refresh: () => {if (current()) return refresh()},
    select: () => {if (current() && props.selectable) emit('select', selectedModel.value.id)}}
})
watch(context.revision, () => {
  readSequence++; commandSequence++; cancelConfirmation(); prepared = null; reading.value = false; operation.value = null
  if (currentModelId !== selectedModel.value.id) {currentModelId = selectedModel.value.id; status.value = null; error.value = false}
  schedulePolling()
  if (context.active.value) void refresh()
}, {flush: 'sync'})
function visibilityChanged() {if (pageDocument?.visibilityState === 'hidden') cancelConfirmation(); schedulePolling(); if (pageDocument?.visibilityState !== 'hidden') void refresh()}
onMounted(() => {mounted = true; pageDocument?.addEventListener('visibilitychange', visibilityChanged); void refresh(); schedulePolling()})
onUnmounted(() => {mounted = false; readSequence++; commandSequence++; cancelConfirmation(); prepared = null; if (timer) clearInterval(timer); pageDocument?.removeEventListener('visibilitychange', visibilityChanged)})
</script>
<style scoped>
.information-highlight-model { display: flex; flex-direction: column; min-width: 0; padding: 15px; border: 1px solid var(--line, #dce3eb); border-radius: 10px; color: var(--ink, #25354b); background: var(--surface-soft, #f6f8fb); }
.information-highlight-model.is-selected { border-color: var(--brand, #ef4776); }
.highlight-model-heading { display: flex; align-items: flex-start; gap: 10px; }
.highlight-model-heading.is-selectable { cursor: pointer; }.highlight-model-copy { min-width: 0; display: grid; gap: 4px; }.highlight-model-heading strong { font-size: 13px; }.highlight-model-heading small { color: var(--muted, #637184); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.highlight-model-heading input { width: 16px; height: 16px; margin: 1px 0 0; flex: none; accent-color: var(--brand, #ef4776); cursor: pointer; }.highlight-model-heading input:focus-visible { outline: 2px solid var(--brand, #ef4776); outline-offset: 3px; }.highlight-model-heading input:disabled { cursor: default; }
.highlight-model-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.highlight-model-selected { padding: 2px 6px; border-radius: 5px; background: var(--brand-soft, #fff0f4); color: var(--brand-strong, #dc315f); font-size: 10px; font-weight: 500; }
.highlight-model-chip { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 8px; color: var(--brand-strong, #2464b8); background: var(--brand-soft, #edf5ff); font-size: 18px; }
.highlight-model-status, .highlight-model-notice, .highlight-model-error { margin: 10px 0 0; font-size: 11px; line-height: 1.65; overflow-wrap: anywhere; }
.highlight-model-status { color: var(--muted, #637184); }.highlight-model-notice { color: var(--ink, #25354b); }.highlight-model-error { color: var(--danger, #c04b54); }
.highlight-model-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: auto; padding-top: 12px; }.highlight-model-actions button { max-width: 100%; border: 1px solid var(--line, #dce3eb); border-radius: 7px; padding: 7px 10px; background: var(--surface, #fff); color: var(--ink, #25354b); font: inherit; font-size: 11px; overflow-wrap: anywhere; cursor: pointer; }.highlight-model-actions button.highlight-model-primary { background: var(--brand-soft, #edf5ff); color: var(--brand-strong, #2464b8); border-color: var(--brand, #3680dd); }.highlight-model-actions button:disabled { opacity: .55; cursor: default; }.highlight-model-actions button:focus-visible { outline: 2px solid var(--brand, #3680dd); outline-offset: 2px; }
.information-highlight-model :deep(.download-progress) { margin-top: 12px; }
.information-highlight-model.is-compact { padding: 12px; }.is-compact .highlight-model-heading { align-items: center; gap: 8px; }.is-compact .highlight-model-chip { width: 24px; height: 24px; font-size: 16px; }.is-compact .highlight-model-status { margin-top: 8px; }.is-compact .highlight-model-actions { padding-top: 8px; }
:global(.fluentread-information-highlight-model-dialog.el-dialog) { display: flex; flex-direction: column; max-height: calc(100dvh - 24px); margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--line, #e5e8ef); border-radius: 18px; color: var(--ink, #172033); background: var(--surface, #fff); box-shadow: 0 20px 60px rgba(23, 32, 51, .2); font-family: inherit; --el-dialog-bg-color: var(--surface, #fff); }
:global(.fluentread-information-highlight-model-dialog .el-dialog__header) { margin: 0; padding: 20px 22px 0; flex: none; }
:global(.fluentread-information-highlight-model-dialog .el-dialog__body) { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 22px; color: var(--ink, #172033); }
:global(.fluentread-information-highlight-model-dialog .el-dialog__footer) { padding: 0 22px 20px; flex: none; }
.highlight-confirm-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.highlight-confirm-heading h2 { margin: 0; color: var(--ink); font-size: 18px; font-weight: 600; line-height: 1.5; }
.highlight-confirm-close { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; flex: none; border: 0; border-radius: 8px; color: var(--muted); background: transparent; cursor: pointer; }.highlight-confirm-close:hover { color: var(--ink); background: var(--surface-soft); }.highlight-confirm-close svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.highlight-confirm-resource { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }.highlight-confirm-resource strong { min-width: 0; color: var(--ink); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }.highlight-confirm-resource > span { flex: none; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: var(--surface); font-size: 12px; }
.highlight-confirm-body p { margin: 12px 0 0; color: var(--muted); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.highlight-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }.highlight-confirm-actions button { min-height: 36px; padding: 7px 14px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }.highlight-confirm-actions .highlight-confirm-primary { border-color: var(--brand); color: var(--skin-action-text, #fff); background: var(--brand); }.highlight-confirm-actions .highlight-confirm-primary:hover { border-color: var(--brand-strong); background: var(--brand-strong); }.highlight-confirm-actions .highlight-confirm-cancel:hover { background: var(--surface-soft); }.highlight-confirm-actions button:focus-visible, .highlight-confirm-close:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (max-width: 480px) { :global(.fluentread-information-highlight-model-dialog .el-dialog__header) { padding: 16px 16px 0; } :global(.fluentread-information-highlight-model-dialog .el-dialog__body) { padding: 14px 16px; } :global(.fluentread-information-highlight-model-dialog .el-dialog__footer) { padding: 0 16px 16px; } }
</style>
