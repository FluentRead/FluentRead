<!--
 * @file src/features/settings/ui/PrivacyActivityLog.vue
 * 文件职责：在翻译隐私防护设置卡底部提供默认折叠的脱敏与拦截记录抽屉，展示累计统计与不可逆的 *** 摘要。
 * 主要内容：折叠态直接展示脱敏/拦截/保护项统计概览；展开后提供指标卡、按类别与动作筛选、带星号摘要的记录列表与分页展开、刷新和二次确认清空；失活、配置切换或卸载时丢弃过期异步回复并关闭确认态。
 * 模块边界：仅通过后台 privacyProtectionActivity 消息读取或清空本机记录，不直接访问存储、不修改配置，也不进入 userscript 产物。
 -->
<template>
  <details class="privacy-log" :open="logOpen" data-privacy-log :onToggle="actions.toggleLog">
    <summary class="privacy-log-summary" data-privacy-log-summary>
      <span class="privacy-log-title-wrap">
        <svg class="privacy-log-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.5 13 3.6v3.7c0 3.2-2.1 5.8-5 7.2-2.9-1.4-5-4-5-7.2V3.6L8 1.5Z" />
          <path d="M5.7 8.1 7.3 9.7 10.5 6.4" />
        </svg>
        <span class="privacy-log-title">{{ t('privacy.log.title') }}</span>
      </span>
      <span class="privacy-log-summary-meta" data-privacy-log-stats>{{ summaryText }}</span>
      <svg class="privacy-log-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
    </summary>
    <div class="privacy-log-body">
      <div v-if="logSnapshot.stats.totalEvents > 0" class="privacy-log-kpis" data-privacy-log-kpis>
        <div class="privacy-log-kpi">
          <span>{{ t('privacy.log.statMasked') }}</span>
          <strong>{{ logSnapshot.stats.maskedEvents }}</strong>
        </div>
        <div class="privacy-log-kpi">
          <span>{{ t('privacy.log.statBlocked') }}</span>
          <strong>{{ blockedTotal }}</strong>
        </div>
        <div class="privacy-log-kpi">
          <span>{{ t('privacy.log.statHits') }}</span>
          <strong>{{ logSnapshot.stats.totalHits }}</strong>
        </div>
      </div>

      <div v-if="categoryBreakdown.length > 0" class="privacy-log-categories" role="group" :aria-label="t('privacy.categories')">
        <button v-for="item in categoryBreakdown" :key="item.category" type="button" class="privacy-log-cat-chip"
          :class="{'is-active': categoryFilter === item.category}" :data-privacy-log-category="item.category"
          :onClick="actions.categoryFilter[item.category]">
          <span>{{ t(`privacy.category.${item.category}`) }}</span>
          <em>{{ item.count }}</em>
        </button>
      </div>

      <div class="privacy-log-toolbar">
        <div class="privacy-log-filters" role="group" :aria-label="t('privacy.log.title')">
          <button v-for="option in ACTION_FILTERS" :key="option" type="button" class="privacy-log-filter"
            :class="{'is-active': actionFilter === option}" :data-privacy-log-filter="option"
            :onClick="actions.actionFilter[option]">
            {{ t(`privacy.log.filter${option === 'all' ? 'All' : option === 'masked' ? 'Masked' : 'Blocked'}`) }}
          </button>
        </div>
        <div class="privacy-log-actions">
          <button type="button" class="privacy-log-btn" :disabled="!context.active.value || logLoading"
            data-privacy-log-refresh :onClick="actions.refreshLog">
            {{ t('privacy.log.refresh') }}
          </button>
          <template v-if="logSnapshot.stats.totalEvents > 0">
            <template v-if="clearConfirming">
              <button type="button" class="privacy-log-btn is-danger" :disabled="!context.active.value || logClearing"
                data-privacy-log-clear-confirm :onClick="actions.confirmClearLog">
                {{ t('privacy.log.clearConfirm') }}
              </button>
              <button type="button" class="privacy-log-btn" :disabled="logClearing"
                data-privacy-log-clear-cancel :onClick="actions.cancelClearLog">
                {{ t('common.cancel') }}
              </button>
            </template>
            <button v-else type="button" class="privacy-log-btn" :disabled="!context.active.value || logClearing"
              data-privacy-log-clear :onClick="actions.requestClearLog">
              {{ t('privacy.log.clear') }}
            </button>
          </template>
        </div>
      </div>

      <p v-if="logError" class="privacy-log-error" role="alert" data-privacy-log-error>{{ t('privacy.log.loadFailed') }}</p>

      <ul v-if="visibleRecords.length > 0" class="privacy-log-list" data-privacy-log-list>
        <li v-for="record in visibleRecords" :key="record.id" class="privacy-log-item" :data-privacy-log-action="record.action">
          <div class="privacy-log-item-head">
            <span class="privacy-log-badge" :class="`is-${actionTone(record.action)}`">
              {{ t(`privacy.log.action.${record.action}`) }}
            </span>
            <span class="privacy-log-service">{{ serviceLabel(record.serviceId) }}</span>
            <span v-if="record.hitCount > 0" class="privacy-log-hits">{{ t('privacy.log.hits', {count: record.hitCount}) }}</span>
            <time class="privacy-log-time">{{ formatRecordTime(record.occurredAt) }}</time>
          </div>
          <div v-if="record.samples.length > 0" class="privacy-log-samples">
            <span v-for="(sampleItem, sampleIndex) in record.samples" :key="`${record.id}-${sampleIndex}`" class="privacy-log-sample">
              <span class="privacy-log-sample-cat">{{ t(`privacy.category.${sampleItem.category}`) }}</span>
              <code>{{ sampleItem.masked }}</code>
            </span>
            <span v-if="record.hitCount > record.samples.length" class="privacy-log-sample-more">
              {{ t('privacy.log.moreSamples', {count: record.hitCount - record.samples.length}) }}
            </span>
          </div>
        </li>
      </ul>
      <p v-else class="privacy-log-empty" data-privacy-log-empty>
        {{ t(logSnapshot.stats.totalEvents > 0 ? 'privacy.log.emptyFiltered' : 'privacy.log.empty') }}
      </p>

      <button v-if="remainingRecords > 0" type="button" class="privacy-log-more" data-privacy-log-more :onClick="actions.showMoreLog">
        {{ t('privacy.log.showMore', {count: remainingRecords}) }}
      </button>

      <p class="privacy-log-note">{{ t('privacy.log.note') }}</p>
    </div>
  </details>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import type {Config} from '@/src/core/config/model';
import {options} from '@/src/core/config/catalog';
import {getCompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
import {getCustomOpenAIProviderLabel} from '@/src/core/config/customOpenAI';
import {
  createEmptyPrivacyActivitySnapshot,
  normalizePrivacyActivitySnapshot,
  PRIVACY_ACTIVITY_CATEGORIES,
  PRIVACY_ACTIVITY_MESSAGE_TYPE,
  type PrivacyActivityAction,
  type PrivacyActivityCategory,
  type PrivacyActivityResponse,
  type PrivacyActivitySnapshot,
} from '@/src/core/privacy/activity';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';

const ACTION_FILTERS = ['all', 'masked', 'blocked'] as const;
type ActionFilter = typeof ACTION_FILTERS[number];
const LOG_PAGE_STEP = 8;

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const context = useSettingsActionContext(() => props.active, () => [props.config]);

const logOpen = ref(false);
const logLoading = ref(false);
const logClearing = ref(false);
const logError = ref(false);
const clearConfirming = ref(false);
const actionFilter = ref<ActionFilter>('all');
const categoryFilter = ref<PrivacyActivityCategory | null>(null);
const visibleLimit = ref(LOG_PAGE_STEP);
const logSnapshot = ref<PrivacyActivitySnapshot>(createEmptyPrivacyActivitySnapshot());
let logSession = 0;

const blockedTotal = computed(() => logSnapshot.value.stats.blockedEvents + logSnapshot.value.stats.stoppedEvents);
const summaryText = computed(() => {
  const stats = logSnapshot.value.stats;
  if (stats.totalEvents === 0) return t('privacy.log.summaryEmpty');
  return t('privacy.log.summary', {
    masked: stats.maskedEvents,
    blocked: blockedTotal.value,
    hits: stats.totalHits,
  });
});

const categoryBreakdown = computed(() => PRIVACY_ACTIVITY_CATEGORIES
  .map(category => ({category, count: logSnapshot.value.stats.categoryCounts[category]}))
  .filter(item => item.count > 0)
  .sort((a, b) => b.count - a.count));

const filteredRecords = computed(() => logSnapshot.value.records.filter(record => {
  if (actionFilter.value === 'masked' && record.action !== 'masked') return false;
  if (actionFilter.value === 'blocked' && record.action === 'masked') return false;
  if (categoryFilter.value && !(record.categoryCounts[categoryFilter.value] ?? 0)) return false;
  return true;
}));

const visibleRecords = computed(() => filteredRecords.value.slice(0, visibleLimit.value));
const remainingRecords = computed(() => Math.max(0, filteredRecords.value.length - visibleRecords.value.length));

function actionTone(action: PrivacyActivityAction): 'masked' | 'blocked' | 'danger' {
  if (action === 'masked') return 'masked';
  if (action === 'restore-failed') return 'danger';
  return 'blocked';
}

function serviceLabel(serviceId: string): string {
  const composite = getCompositeTranslationProvider(props.config.compositeTranslationProviders, serviceId);
  if (composite) return composite.name;
  const builtin = options.services.find(option => option.value === serviceId)?.label;
  if (builtin) return translateLegacy(builtin);
  return getCustomOpenAIProviderLabel(props.config.customOpenAIProviders, serviceId);
}

function formatRecordTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

async function fetchLog(): Promise<void> {
  const session = ++logSession;
  logLoading.value = true;
  logError.value = false;
  try {
    const response = await browser.runtime.sendMessage({
      type: PRIVACY_ACTIVITY_MESSAGE_TYPE,
      action: 'query',
    }) as PrivacyActivityResponse | undefined;
    if (session !== logSession) return;
    if (response?.success && 'records' in response.data) {
      logSnapshot.value = normalizePrivacyActivitySnapshot(response.data);
    } else {
      logError.value = true;
    }
  } catch {
    if (session === logSession) logError.value = true;
  } finally {
    if (session === logSession) logLoading.value = false;
  }
}

async function executeClearLog(): Promise<void> {
  if (logClearing.value) return;
  const session = ++logSession;
  logClearing.value = true;
  logError.value = false;
  try {
    const response = await browser.runtime.sendMessage({
      type: PRIVACY_ACTIVITY_MESSAGE_TYPE,
      action: 'clear',
    }) as PrivacyActivityResponse | undefined;
    if (session !== logSession) return;
    if (response?.success) {
      logSnapshot.value = createEmptyPrivacyActivitySnapshot();
      clearConfirming.value = false;
      categoryFilter.value = null;
      actionFilter.value = 'all';
      visibleLimit.value = LOG_PAGE_STEP;
    } else {
      logError.value = true;
    }
  } catch {
    if (session === logSession) logError.value = true;
  } finally {
    if (session === logSession) logClearing.value = false;
  }
}

function resetTransient() {
  clearConfirming.value = false;
  logSession += 1;
  logLoading.value = false;
  logClearing.value = false;
}

watch(() => [context.active.value, props.config], () => {
  resetTransient();
  if (context.active.value) void fetchLog();
}, {flush: 'sync', immediate: true});
onBeforeUnmount(resetTransient);

const actions = computed(() => {
  const owns = context.capture();
  return {
    toggleLog(event: Event) {
      if (!owns()) return;
      const open = Boolean((event.target as HTMLDetailsElement).open);
      logOpen.value = open;
      clearConfirming.value = false;
      if (open) void fetchLog();
    },
    refreshLog() {if (owns()) void fetchLog();},
    requestClearLog() {if (owns()) clearConfirming.value = true;},
    cancelClearLog() {if (owns()) clearConfirming.value = false;},
    confirmClearLog() {if (owns()) void executeClearLog();},
    showMoreLog() {if (owns()) visibleLimit.value += LOG_PAGE_STEP;},
    actionFilter: Object.fromEntries(ACTION_FILTERS.map(option => [option, () => {
      if (!owns()) return;
      actionFilter.value = option;
      visibleLimit.value = LOG_PAGE_STEP;
    }])) as Record<ActionFilter, () => void>,
    categoryFilter: Object.fromEntries(PRIVACY_ACTIVITY_CATEGORIES.map(category => [category, () => {
      if (!owns()) return;
      categoryFilter.value = categoryFilter.value === category ? null : category;
      visibleLimit.value = LOG_PAGE_STEP;
    }])) as Record<PrivacyActivityCategory, () => void>,
  };
});
</script>

<style scoped>
.privacy-log { border-top: 1px solid var(--line); background: var(--surface); }
.privacy-log-summary { display: flex; align-items: center; gap: 10px; padding: 12px var(--fr-card-padding-inline, 20px); color: var(--ink); font-size: 13px; list-style: none; cursor: pointer; user-select: none; transition: background-color 140ms ease; }
.privacy-log-summary::-webkit-details-marker { display: none; }
.privacy-log-summary::marker { content: ''; }
.privacy-log-summary:hover { background: var(--surface-soft); }
.privacy-log-summary:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.privacy-log-title-wrap { display: inline-flex; align-items: center; gap: 7px; font-weight: 550; }
.privacy-log-icon { width: 15px; height: 15px; fill: none; stroke: var(--brand-strong); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.privacy-log-summary-meta { margin-inline-start: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.privacy-log-chevron { flex: none; width: 14px; height: 14px; fill: none; stroke: var(--muted); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; transition: transform 160ms ease; }
.privacy-log[open] > .privacy-log-summary { border-bottom: 1px solid var(--line); background: var(--surface-soft); }
.privacy-log[open] > .privacy-log-summary .privacy-log-chevron { transform: rotate(90deg); }

.privacy-log-body { display: grid; gap: 12px; padding: 14px var(--fr-card-padding-inline, 20px) 16px; }
.privacy-log-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.privacy-log-kpi { display: grid; gap: 2px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.privacy-log-kpi span { color: var(--muted); font-size: 11.5px; }
.privacy-log-kpi strong { color: var(--ink); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; }

.privacy-log-categories { display: flex; flex-wrap: wrap; gap: 6px; }
.privacy-log-cat-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--surface); font: inherit; font-size: 11.5px; cursor: pointer; }
.privacy-log-cat-chip em { font-style: normal; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink); }
.privacy-log-cat-chip.is-active { border-color: color-mix(in srgb, var(--brand) 34%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); }
.privacy-log-cat-chip.is-active em { color: var(--brand-strong); }

.privacy-log-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.privacy-log-filters, .privacy-log-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.privacy-log-filter, .privacy-log-btn, .privacy-log-more { padding: 4px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); background: var(--surface); font: inherit; font-size: 12px; cursor: pointer; }
.privacy-log-filter.is-active { border-color: color-mix(in srgb, var(--brand) 34%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); font-weight: 500; }
.privacy-log-btn:hover:not(:disabled), .privacy-log-more:hover { color: var(--ink); background: var(--surface-soft); }
.privacy-log-btn.is-danger { border-color: color-mix(in srgb, var(--el-color-danger) 35%, var(--line)); color: var(--el-color-danger); }
.privacy-log-btn:disabled { opacity: .55; cursor: default; }

.privacy-log-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; max-height: 300px; overflow-y: auto; }
.privacy-log-item { display: grid; gap: 7px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.privacy-log-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.privacy-log-badge { padding: 1px 7px; border-radius: 5px; font-size: 11px; font-weight: 550; }
.privacy-log-badge.is-masked { color: var(--fr-success, #1f7a4c); background: color-mix(in srgb, var(--fr-success, #1f7a4c) 12%, transparent); }
.privacy-log-badge.is-blocked { color: var(--brand-strong); background: var(--brand-soft); }
.privacy-log-badge.is-danger { color: var(--el-color-danger); background: color-mix(in srgb, var(--el-color-danger) 12%, transparent); }
.privacy-log-service { color: var(--ink); font-weight: 500; }
.privacy-log-hits { color: var(--muted); font-variant-numeric: tabular-nums; }
.privacy-log-time { margin-inline-start: auto; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.privacy-log-samples { display: flex; flex-wrap: wrap; gap: 6px; }
.privacy-log-sample { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 2px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font-size: 11.5px; }
.privacy-log-sample-cat { color: var(--muted); }
.privacy-log-sample code { color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.privacy-log-sample-more { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 6px; color: var(--muted); background: var(--surface); font-size: 11px; font-variant-numeric: tabular-nums; }
.privacy-log-empty, .privacy-log-note, .privacy-log-error { margin: 0; font-size: 12px; line-height: 1.6; }
.privacy-log-empty { padding: 12px; border: 1px dashed var(--line); border-radius: 10px; color: var(--muted); text-align: center; }
.privacy-log-note { color: var(--muted); font-size: 11.5px; }
.privacy-log-error { color: var(--el-color-danger); }
.privacy-log-more { justify-self: center; }

@media (max-width: 480px) {
  .privacy-log-kpis { grid-template-columns: minmax(0, 1fr); }
  .privacy-log-summary { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .privacy-log-summary, .privacy-log-chevron { transition: none; }
}
</style>
