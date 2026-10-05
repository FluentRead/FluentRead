<!--
 * @file src/features/settings/ui/services/FreeTranslationSettings.vue
 * 文件职责：编辑免费翻译服务的启停、选择策略、邮箱与等待时间。
 * 主要内容：以等宽等高卡片统一展示全部服务的启停、连接结果、单次测试耗时与分流参考；失败说明集中显示，邮箱作为独立紧凑字段常驻，高级态显示等待上限。
 * 模块边界：只修改传入的配置，由设置页统一持久化；只读取不含凭据的后台权重快照，不请求翻译。
 -->
<template>
  <div class="free-translation-settings" :class="{'is-advanced': advanced}" data-free-translation-settings>
    <template v-if="!advanced">
      <div class="mode-picker" role="radiogroup" :aria-label="translateLegacy('免费翻译选择模式')">
        <label class="mode-option" :class="{ 'is-selected': mode === 'balanced' }"><input type="radio" name="free-translation-mode" value="balanced" :checked="mode === 'balanced'" :aria-label="t('settings.services.freeWeights.mode')" @change="setMode('balanced')" /><span>{{ t('settings.services.freeWeights.mode') }}</span></label>
        <label class="mode-option" :class="{ 'is-selected': mode === 'sequential' }"><input type="radio" name="free-translation-mode" value="sequential" :checked="mode === 'sequential'" :aria-label="translateLegacy('优先顺序')" @change="setMode('sequential')" /><span>{{ translateLegacy('优先顺序') }}</span></label>
      </div>
      <p class="mode-help">{{ mode === 'balanced' ? t('settings.services.freeWeights.strategy') : translateLegacy('依次调用启用的免费接口；可使用上下按钮调整顺序') }}</p>
      <p v-if="!isSequential && displayedWeightSnapshot.total === 0" class="service-unavailable" role="status">{{ t('settings.services.freeWeights.unavailable') }}</p>
      <section class="provider-section" :aria-label="translateLegacy(isSequential ? '免费翻译优先顺序' : '免费翻译服务')">
        <div class="section-heading"><h3>{{ isSequential ? translateLegacy('服务优先顺序') : t('settings.services.freeWeights.services') }}</h3><p>{{ t('settings.services.freeWeights.enabledCount', {count: order.length}) }}</p></div>
        <div v-if="!isSequential" class="routing-summary" data-testid="free-translation-weight-summary" :data-weight-total="displayedWeightSnapshot.total" :data-weight-observed-at="displayedWeightSnapshot.observedAt">
          <span>{{ t('settings.services.freeWeights.description') }}</span>
          <el-tooltip :content="t('settings.services.freeWeights.refresh', {minutes: refreshMinutes})"><span class="allocation-total">{{ t('settings.services.freeWeights.total', {total: formatPercentage(displayedWeightSnapshot.total)}) }}</span></el-tooltip>
        </div>
        <ol class="fallback-list" :class="{ 'is-sequential': isSequential }" :aria-label="translateLegacy(isSequential ? '免费翻译优先顺序' : '免费翻译服务')">
          <li v-for="provider in providers" :key="provider.id" :data-fallback-provider="provider.id" :class="{'is-disabled': !isEnabled(provider.id)}">
            <div class="provider-row">
              <span v-if="isSequential" class="provider-position" aria-hidden="true">{{ isEnabled(provider.id) ? order.indexOf(provider.id) + 1 : '—' }}</span>
              <ServiceIcon :service="provider.id" :label="translateLegacy(provider.label)" size="small" />
              <div class="provider-copy">
                <div class="provider-name"><el-tooltip :content="`${translateLegacy(provider.label)} · ${translateLegacy(provider.description)}`"><strong tabindex="0">{{ translateLegacy(provider.label) }}</strong></el-tooltip><ServiceNatureBadge :service="provider.id" /></div>
                <div class="provider-result">
                  <span class="provider-state" :class="`is-${providerState(provider.id)}`" :data-provider-state="provider.id" :data-provider-check-status="providerState(provider.id)" :title="providerStateTitle(provider.id)" role="status">{{ providerStateLabel(provider.id) }}</span>
                  <output v-if="providerDuration(provider.id) !== undefined" class="provider-duration" :data-provider-duration="provider.id" :aria-label="t('settings.services.freeWeights.testDuration', {duration: providerDuration(provider.id)})">{{ providerDuration(provider.id) }} ms</output>
                </div>
              </div>
              <div class="provider-actions">
                <button v-if="isSequential" type="button" :disabled="!isEnabled(provider.id) || order.indexOf(provider.id) === 0" :aria-label="`${translateLegacy('上移')} ${translateLegacy(provider.label)}`" :title="translateLegacy('上移')" @click="move(provider.id, -1)"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 9 4-4 4 4" /></svg></button>
                <button v-if="isSequential" type="button" :disabled="!isEnabled(provider.id) || order.indexOf(provider.id) === order.length - 1" :aria-label="`${translateLegacy('下移')} ${translateLegacy(provider.label)}`" :title="translateLegacy('下移')" @click="move(provider.id, 1)"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 7 4 4 4-4" /></svg></button>
                <el-switch :model-value="isEnabled(provider.id)" :disabled="toggleDisabled(provider.id)" :aria-label="`${translateLegacy('启用')} ${translateLegacy(provider.label)}`" @update:model-value="toggle(provider.id, Boolean($event))" />
              </div>
            </div>
            <div class="provider-meta">
              <span v-if="provider.id === 'apertiumFree'" class="provider-language">{{ t('settings.services.freeWeights.noChinese') }}</span>
              <span v-if="!isSequential && isEnabled(provider.id)" class="provider-allocation">{{ t('settings.services.freeWeights.share') }} <output class="provider-weight" :data-provider-weight="provider.id" :data-weight-status="weightStatus(provider.id)" :aria-label="weightAriaLabel(provider.id)">{{ formatProviderWeight(provider.id) }}</output></span>
            </div>
          </li>
        </ol>
        <ul v-if="failedProviders.length" class="check-failures" :aria-label="t('settings.services.keys.failed')">
          <li v-for="provider in failedProviders" :key="provider.id" :data-provider-error="provider.id"><strong>{{ translateLegacy(provider.label) }}</strong><span>{{ checks?.[provider.id]?.error }}</span></li>
        </ul>
      </section>
      <p class="fallback-footnote">{{ t('settings.services.library.keepOne') }}</p>
      <section class="provider-settings" :aria-label="t('settings.services.library.memoryEmail')">
        <label class="compact-field"><span>{{ t('settings.services.library.memoryEmail') }}</span><el-input v-model="myMemoryEmailDraft" type="email" :placeholder="translateLegacy('不填写也可以使用')" :aria-label="t('settings.services.library.memoryEmail')" :aria-invalid="myMemoryEmailInvalid" @change="commitMyMemoryEmail" /></label>
        <p v-if="myMemoryEmailInvalid" class="provider-note" role="status">{{ translateLegacy('请输入有效邮箱，或留空') }}</p>
        <p>{{ translateLegacy('提供邮箱后可提升额度；邮箱会随请求发送给 MyMemory') }} <a href="https://mymemory.translated.net/doc/usagelimits.php" target="_blank" rel="noreferrer">{{ translateLegacy('官方额度说明') }}</a></p>
      </section>
    </template>
    <template v-if="advanced">
      <label class="compact-field"><span>{{ translateLegacy('每个服务最多等待（秒）') }}</span><el-input-number :model-value="config.freeTranslationTimeoutMs / 1000" :min="1" :max="15" :step="1" :aria-label="translateLegacy('每个服务最多等待（秒）')" @update:model-value="setDuration($event)" /></label>
      <p class="recovery-copy">{{ t('settings.services.freeWeights.budget') }}</p>
      <p class="recovery-copy">{{ translateLegacy('网络问题通常几分钟后重试；限流按服务提示恢复；拦截可能需要几小时；日额度通常隔天恢复') }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import browser from 'webextension-polyfill'
import type { Config } from '@/src/core/config/model'
import { FREE_TRANSLATION_PROVIDERS, normalizeFreeTranslationMode, normalizeFreeTranslationOrder, normalizeMyMemoryEmail, type FreeTranslationProviderId } from '@/src/core/config/freeTranslation'
import {
  calculateFreeTranslationWeightSnapshot,
  FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS,
  FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE,
  type FreeTranslationWeightSnapshot,
  type FreeTranslationWeightsResponse,
} from '@/src/services/translation/freeWeights'
import { useUiI18n } from '@/src/ui/i18n'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import type { FreeTranslationChecks } from './freeTranslationChecks'

type FreeTranslationMode = 'balanced' | 'sequential'
type FreeTranslationConfig = Config & {freeTranslationMode: FreeTranslationMode}
const props = defineProps<{config: Config; advanced?: boolean; checks?: FreeTranslationChecks}>()
const advanced = computed(() => props.advanced === true)
const config = toRef(props, 'config')
const freeConfig = computed(() => config.value as FreeTranslationConfig)
const { t, translateLegacy } = useUiI18n()
const myMemoryEmailDraft = ref(config.value.myMemoryEmail)
const myMemoryEmailInvalid = computed(() => Boolean(myMemoryEmailDraft.value.trim() && !normalizeMyMemoryEmail(myMemoryEmailDraft.value)))
watch(() => config.value.myMemoryEmail, value => { myMemoryEmailDraft.value = value })
function commitMyMemoryEmail(): void { if (!myMemoryEmailInvalid.value) config.value.myMemoryEmail = normalizeMyMemoryEmail(myMemoryEmailDraft.value) }
const mode = computed<FreeTranslationMode>(() => normalizeFreeTranslationMode(freeConfig.value.freeTranslationMode) as FreeTranslationMode)
const isSequential = computed(() => mode.value === 'sequential')
const order = computed(() => normalizeFreeTranslationOrder(config.value.freeTranslationOrder))
const providers = computed(() => mode.value === 'sequential' ? [...order.value.flatMap(id => FREE_TRANSLATION_PROVIDERS.filter(provider => provider.id === id)), ...FREE_TRANSLATION_PROVIDERS.filter(provider => !order.value.includes(provider.id))] : [...FREE_TRANSLATION_PROVIDERS])
const failedProviders = computed(() => providers.value.filter(provider => props.checks?.[provider.id]?.status === 'error' && props.checks[provider.id]?.error))
const weightSnapshot = ref<FreeTranslationWeightSnapshot | null>(null)
const localWeightSnapshot = computed(() => calculateFreeTranslationWeightSnapshot(order.value))
const displayedWeightSnapshot = computed(() => weightSnapshot.value || localWeightSnapshot.value)
const weightByProvider = computed(() => new Map(displayedWeightSnapshot.value.entries.map(entry => [entry.providerId, entry])))
const refreshMinutes = Math.round(FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS / 60_000)
let weightRefreshTimer: ReturnType<typeof setInterval> | undefined
let weightRequestGeneration = 0

function providerWeight(providerId: string): number {
  if (!isEnabled(providerId)) return 0
  return weightByProvider.value.get(providerId)?.weight ?? 0
}
function formatPercentage(value: number): string { return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%` }
function formatProviderWeight(providerId: string): string { return formatPercentage(providerWeight(providerId)) }
function weightStatus(providerId: string): string {
  if (!isEnabled(providerId)) return 'disabled'
  const status = weightByProvider.value.get(providerId)?.status
  return status && status !== 'disabled' ? status : 'ready'
}
function providerState(providerId: FreeTranslationProviderId): string {
  const check = props.checks?.[providerId]
  if (check && check.status !== 'idle') return check.status
  const health = weightStatus(providerId)
  return health === 'cooling' || health === 'recovering' ? health : 'idle'
}
function providerStateLabel(providerId: FreeTranslationProviderId): string {
  const state = providerState(providerId)
  if (state === 'success') return translateLegacy('连接正常')
  if (state === 'error') return translateLegacy('连接失败')
  if (state === 'cooling' || state === 'recovering') return t(`settings.services.freeWeights.state.${state}`)
  return t(`settings.services.keys.${state === 'idle' ? 'unchecked' : state}`)
}
function providerDuration(providerId: FreeTranslationProviderId): number | undefined {
  const check = props.checks?.[providerId]
  if (check?.status !== 'success' && check?.status !== 'error') return undefined
  const duration = check.durationMs
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined
}
function providerStateTitle(providerId: FreeTranslationProviderId): string {
  const check = props.checks?.[providerId]
  const pair = providerId === 'apertiumFree' ? 'en → es' : 'en → zh-Hans'
  const duration = providerDuration(providerId)
  return [check?.error || providerStateLabel(providerId), pair, duration === undefined ? '' : `${duration} ms`].filter(Boolean).join(' · ')
}
function weightAriaLabel(providerId: string): string {
  return t('settings.services.freeWeights.aria', {
    service: translateLegacy(FREE_TRANSLATION_PROVIDERS.find(provider => provider.id === providerId)?.label || providerId),
    weight: formatPercentage(providerWeight(providerId)),
  })
}
async function refreshWeights(): Promise<void> {
  if (advanced.value || mode.value !== 'balanced') return
  const generation = ++weightRequestGeneration
  try {
    const response = await browser.runtime.sendMessage({type: FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE}) as FreeTranslationWeightsResponse | undefined
    if (generation !== weightRequestGeneration) return
    weightSnapshot.value = response?.success === true && response.snapshot ? response.snapshot : null
  } catch {
    if (generation === weightRequestGeneration) weightSnapshot.value = null
  }
}
function startWeightRefresh(): void {
  if (advanced.value) return
  void refreshWeights()
  weightRefreshTimer = setInterval(() => { void refreshWeights() }, FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS)
}
function setMode(value: FreeTranslationMode): void { freeConfig.value.freeTranslationMode = normalizeFreeTranslationMode(value) as FreeTranslationMode }
function isEnabled(id: string): boolean { return order.value.includes(id) }
function toggleDisabled(id: string): boolean { return isEnabled(id) && order.value.length === 1 }
function toggle(id: string, enabled: boolean): void {
  if (!FREE_TRANSLATION_PROVIDERS.some(provider => provider.id === id) || enabled === isEnabled(id) || toggleDisabled(id)) return
  config.value.freeTranslationOrder = enabled ? [...order.value, id] : order.value.filter(value => value !== id)
}
function move(id: string, direction: -1 | 1): void {
  const current = order.value.indexOf(id), next = current + direction
  if (current < 0 || next < 0 || next >= order.value.length) return
  const reordered = [...order.value]; [reordered[current], reordered[next]] = [reordered[next], reordered[current]]; config.value.freeTranslationOrder = reordered
}
function setDuration(seconds: number | undefined): void { if (typeof seconds === 'number' && Number.isFinite(seconds)) config.value.freeTranslationTimeoutMs = Math.round(Math.min(15, Math.max(1, seconds)) * 1000) }
watch(mode, value => { if (value === 'balanced') void refreshWeights() })
watch(order, () => { if (mode.value === 'balanced') void refreshWeights() })
onMounted(startWeightRefresh)
onBeforeUnmount(() => {
  weightRequestGeneration += 1
  if (weightRefreshTimer) clearInterval(weightRefreshTimer)
})
</script>

<style scoped>
.free-translation-settings { container-type: inline-size; color: var(--el-text-color-primary); font-size: 12px; }
.fallback-footnote, .mode-help { margin: 10px 0; color: var(--el-text-color-secondary); line-height: 1.55; }
.mode-picker { max-width: 320px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 10px 0 3px; }
.mode-option { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 9px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-blank); cursor: pointer; }
.mode-option.is-selected { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.mode-option input { margin: 0; accent-color: var(--el-color-primary); }
.mode-help { margin-top: 7px; }
.service-unavailable { color: var(--el-color-warning-dark-2); line-height: 1.6; }
.provider-section { margin-top: 14px; }
.section-heading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
.section-heading h3 { margin: 0; font-size: 13px; font-weight: 600; }
.section-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 11px; }
.routing-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-bottom: 9px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.5; }
.allocation-total { white-space: nowrap; }
.fallback-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); align-items: start; gap: 7px; margin: 0; padding: 0; list-style: none; }
.fallback-list.is-sequential { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.fallback-list > li { box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; gap: 5px; height: 88px; min-width: 0; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 9px; background: var(--el-fill-color-blank); }
.fallback-list > li.is-disabled { background: var(--el-fill-color-extra-light); }
.provider-row { display: flex; align-items: center; gap: 8px; }
.provider-position { width: 14px; flex: none; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.provider-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
.provider-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.provider-copy strong { min-width: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.provider-result { display: flex; align-items: center; gap: 4px 8px; min-height: 19px; }
.provider-state { padding: 2px 5px; border-radius: 4px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); font-size: 10px; white-space: nowrap; }
.provider-state.is-success { color: var(--el-color-success-dark-2); background: var(--el-color-success-light-9); }
.provider-state.is-error { color: var(--el-color-danger-dark-2); background: var(--el-color-danger-light-9); }
.provider-state.is-checking { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.provider-state.is-cooling, .provider-state.is-recovering { color: var(--el-color-warning-dark-2); background: var(--el-color-warning-light-9); }
.provider-duration { color: var(--el-text-color-regular); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.provider-meta { display: flex; align-items: center; justify-content: space-between; gap: 5px 8px; min-height: 16px; margin-left: 28px; color: var(--el-text-color-secondary); font-size: 10px; }
.provider-language { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; }
.provider-allocation { flex: none; margin-left: auto; white-space: nowrap; }
.provider-weight { color: var(--el-text-color-regular); font-variant-numeric: tabular-nums; }
.provider-actions { display: flex; flex: none; align-items: center; gap: 5px; }
.provider-actions button { width: 24px; height: 26px; padding: 0; border: 1px solid var(--el-border-color); border-radius: 7px; color: var(--el-text-color-regular); background: var(--el-fill-color-blank); cursor: pointer; }
.provider-actions button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; vertical-align: middle; }
.provider-actions button:disabled { opacity: .35; cursor: default; }
.check-failures { display: grid; gap: 7px; margin: 10px 0 0; padding: 9px 12px; list-style: none; border-left: 2px solid var(--el-color-danger-light-5); background: var(--el-fill-color-light); color: var(--el-color-danger); font-size: 11px; line-height: 1.6; }
.check-failures li { display: flex; flex-wrap: wrap; gap: 0 10px; }
.check-failures strong { flex: none; font-weight: 600; }
.check-failures span { min-width: 0; flex: 1 1 180px; overflow-wrap: anywhere; }
.provider-settings { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--el-border-color-lighter); }
.provider-settings p { margin: 6px 0 0; line-height: 1.5; font-size: 11px; color: var(--el-text-color-secondary); }
.provider-settings .provider-note { color: var(--el-color-warning-dark-2); }
.provider-settings a { color: var(--el-color-primary); }
.compact-field { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 12px; }
.provider-settings .compact-field { margin-top: 0; }
.compact-field :deep(.el-input), .compact-field :deep(.el-input-number) { width: min(100%, 260px); max-width: 260px; }
.recovery-copy { margin: 8px 0 0; color: var(--el-text-color-secondary); line-height: 1.5; }
.mode-option:focus-within, .provider-actions button:focus-visible, .provider-copy strong:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@container (min-width: 900px) { .fallback-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 650px) { .fallback-list.is-sequential { grid-template-columns: 1fr; } }
@media (max-width: 700px) {
  .compact-field { flex-wrap: wrap; gap: 7px; }
  .compact-field :deep(.el-input), .compact-field :deep(.el-input-number) { width: 100%; max-width: none; }
}
</style>
