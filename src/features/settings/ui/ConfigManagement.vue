<!--
@file src/features/settings/ui/ConfigManagement.vue
文件职责：提供备份与恢复页面的 Google Drive 和 OneDrive 配置同步、完整数据备份和设置历史。
主要内容：按页内分类切换完整备份入口与设置历史，展示相邻版本的具体修改与自动设置快照，区分当时的修改和恢复时的差异，并保留动态服务名称、多语言与安全恢复。
模块边界：本组件拥有设置历史的预览与恢复；本机备份与导入由 LocalDataManagement 编排，加密云同步由独立的云端入口与共用确认组件及后台服务负责。
-->
<template>
  <section class="config-management">
    <SettingsPanel name="backup" :active="props.activePanel">
<GoogleDriveSync v-if="props.active && (!props.activePanel || props.activePanel === 'backup')" />
<OneDriveSync v-if="props.active && (!props.activePanel || props.activePanel === 'backup')" />
<LocalDataManagement :config="config" />
</SettingsPanel>

<SettingsPanel name="history" :active="props.activePanel">
    <header class="history-heading">
      <h2>设置历史</h2>
      <p>用于找回误改的设置；不包含单词本、模型用量或 API 凭据。</p>
    </header>
    <div class="version-grid">
      <section class="version-panel" aria-labelledby="recent-config-title">
        <header class="version-panel-heading">
          <div>
            <h2 id="recent-config-title">最近修改</h2>
            <p>{{ t('settings.history.recentHint') }}</p>
          </div>
          <span>{{ historyEntries.length }}/10</span>
        </header>
        <div v-if="historyEntries.length" class="version-list">
          <button
            v-for="entry in historyEntries"
            :key="entry.version"
            type="button"
            class="version-entry"
            :class="{ current: entry.version === currentHistoryVersion }"
            :aria-label="`${historyTitle(entry)}，v${entry.version}，${formatTime(entry.savedAt)}`"
            @click="openHistoryPreview(entry)"
          >
            <span class="version-badge">v{{ entry.version }}</span>
            <span class="version-copy">
              <span class="version-meta">
                <time :datetime="entry.savedAt">{{ formatTime(entry.savedAt) }}</time>
                <span v-if="entry.diff?.changeCount">{{ t('settings.history.changeCount', {count: entry.diff.changeCount}) }}</span>
              </span>
              <strong>{{ historyTitle(entry) }}</strong>
              <span v-for="change in entry.diff?.groups.flatMap(group => group.changes).slice(0, 2)" :key="change.key" class="change-values">
                <span v-if="entry.diff && entry.diff.changeCount > 1" class="change-label">{{ translateLegacy(change.label) }}</span>
                <span class="change-before">{{ translateLegacy(change.before) }}</span>
                <span class="change-arrow" aria-hidden="true">→</span>
                <span class="change-after">{{ translateLegacy(change.after) }}</span>
              </span>
              <small v-if="!entry.diff">{{ t('settings.history.noPrevious') }}</small>
              <small v-if="entry.diff && entry.diff.changeCount > 2">{{ t('settings.history.moreChanges', {count: entry.diff.changeCount - 2}) }}</small>
            </span>
            <span v-if="entry.version === currentHistoryVersion" class="current-mark">当前</span>
            <span v-else class="view-link">查看</span>
          </button>
        </div>
        <div v-else class="version-empty">修改设置后会在这里生成版本。</div>
      </section>

      <section class="version-panel backup-panel" aria-labelledby="automatic-backup-title">
        <header class="version-panel-heading">
          <div>
            <h2 id="automatic-backup-title">自动设置快照</h2>
            <p>{{ t('settings.history.backupHint') }}</p>
          </div>
          <span>{{ backupEntries.length }}/10</span>
        </header>
        <div v-if="backupEntries.length" class="version-list">
          <button
            v-for="entry in backupEntries"
            :key="entry.version"
            type="button"
            class="version-entry"
            :aria-label="`查看自动设置快照 b${entry.version}，${snapshotSummary(entry.config)}，${formatTime(entry.savedAt)}`"
            @click="openBackupPreview(entry)"
          >
            <span class="version-badge backup">b{{ entry.version }}</span>
            <span class="version-copy">
              <strong>{{ snapshotSummary(entry.config) }}</strong>
              <time :datetime="entry.savedAt">{{ formatTime(entry.savedAt) }}</time>
              <small>{{ backupComparison(entry) }}</small>
            </span>
            <span class="view-link">查看</span>
          </button>
        </div>
        <div v-else class="version-empty">首次启动后台后会建立一份基线备份。</div>
      </section>
    </div>

</SettingsPanel>
    <el-dialog
      v-model="previewVisible"
      class="config-preview-dialog"
      :title="previewTitle"
      width="min(880px, calc(100vw - 32px))"
      destroy-on-close
      @closed="clearPreview"
    >
      <template v-if="previewTarget">
        <div class="preview-summary">
          <div>
            <span>{{ previewSourceLabel }}</span>
            <strong>{{ formatTime(previewTarget.savedAt) }}</strong>
          </div>
          <b :class="{ empty: displayDiff?.changeCount === 0 }">
            {{ comparisonBadge }}
          </b>
        </div>

        <div class="preview-comparison" role="group" :aria-label="t('settings.history.comparisonMode')">
          <button v-if="previewTarget.kind === 'history'" type="button" :aria-pressed="previewMode === 'changes'" @click="previewMode = 'changes'">{{ t('settings.history.thisChange') }}</button>
          <button type="button" :aria-pressed="previewMode === 'current'" @click="previewMode = 'current'">{{ t('settings.history.compareCurrent') }}</button>
        </div>
        <p class="comparison-hint">{{ comparisonHint }}</p>
        <div v-if="displayDiff?.groups.length" class="diff-groups">
          <section v-for="group in displayDiff.groups" :key="group.id" class="diff-group">
            <h3>{{ translateLegacy(group.label) }}<span>{{ group.changes.length }}</span></h3>
            <div class="diff-list">
              <article v-for="change in group.changes" :key="change.key" class="diff-item">
                <strong>{{ translateLegacy(change.label) }}</strong>
                <div><span>{{ t(previewMode === 'changes' ? 'settings.history.before' : 'settings.history.current') }}</span><p>{{ translateLegacy(change.before) }}</p></div>
                <div><span>{{ t(previewMode === 'changes' ? 'settings.history.after' : 'settings.history.saved') }}</span><p>{{ translateLegacy(change.after) }}</p></div>
              </article>
            </div>
          </section>
        </div>
        <div v-else class="diff-empty">{{ previewMode === 'changes' ? t(displayDiff ? 'settings.history.noVisibleChanges' : 'settings.history.noPrevious') : t('settings.history.sameConfig') }}</div>

        <details class="json-details">
          <summary>查看完整配置 JSON</summary>
          <pre>{{ previewJson }}</pre>
        </details>
        <p class="restore-boundary">{{ previewBoundary }}</p>
      </template>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :loading="applyBusy"
          :disabled="!previewTarget || previewChangeCount === 0"
          @click="applyPreviewTarget"
        >{{ previewActionLabel }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {computed, onUnmounted, ref} from 'vue';
import GoogleDriveSync from './GoogleDriveSync.vue';
import OneDriveSync from './OneDriveSync.vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import browser from 'webextension-polyfill';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';
import {getCustomOpenAIProviderLabel} from '@/src/core/config/customOpenAI';
import {buildConfigDiff, type ConfigDiffResult} from '@/src/core/config/diff';
import {buildConfigHistoryTimeline, type ConfigHistoryTimelineEntry} from '../model/configHistory';
import type {Config} from '@/src/core/config/model';
import {
  configAutoBackupsReady,
  configHistoryReady,
  getConfigAutoBackupsSnapshot,
  getConfigHistorySnapshot,
  requestConfigAutoBackupRestore,
  requestConfigHistoryAction,
  subscribeConfigAutoBackups,
  subscribeConfigHistory,
  type ConfigAutoBackupEntry,
  type ConfigAutoBackupState,
  type ConfigHistoryEntry,
  type ConfigHistoryState,
} from '@/src/services/config';
import {toRestorableConfig} from '@/src/services/config/history';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsPanel from './components/SettingsPanel.vue';
import LocalDataManagement from './LocalDataManagement.vue';

const props = defineProps<{
  active: boolean;
  config: Config
  activePanel?: string
}>();
const {language, translateLegacy, t} = useUiI18n();
const sendRuntimeMessage = browser.runtime.sendMessage.bind(browser.runtime);

const configHistory = ref<ConfigHistoryState>(getConfigHistorySnapshot());
const configBackups = ref<ConfigAutoBackupState>(getConfigAutoBackupsSnapshot());
const historyEntries = computed(() => buildConfigHistoryTimeline(configHistory.value.entries));
const backupEntries = computed(() => [...configBackups.value.entries].reverse());
const currentHistoryVersion = computed(() => configHistory.value.entries[configHistory.value.cursor]?.version ?? null);

void configHistoryReady.then(() => { configHistory.value = getConfigHistorySnapshot(); });
void configAutoBackupsReady.then(() => { configBackups.value = getConfigAutoBackupsSnapshot(); });
const unsubscribeHistory = subscribeConfigHistory((history) => { configHistory.value = history; });
const unsubscribeBackups = subscribeConfigAutoBackups((backups) => { configBackups.value = backups; });
onUnmounted(() => {
  unsubscribeHistory();
  unsubscribeBackups();
});

function formatTime(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return translateLegacy('时间未知');
  return new Intl.DateTimeFormat(language.value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function snapshotSummary(value: ConfigHistoryEntry['config'] | ConfigAutoBackupEntry['config']): string {
  const targetOption = options.to.find((item: any) => item.value === value.to);
  const target = getMultilingualTargetLanguageLabel(
    value.to,
    targetOption?.label || value.to,
    language.value,
  );
  const service = options.services.find((item: any) => item.value === value.service)?.label
    || getCustomOpenAIProviderLabel(value.customOpenAIProviders, value.service);
  const rules = (value.alwaysTranslateDomains?.length || 0) + (value.disabledExtensionDomains?.length || 0);
  return `${target} · ${translateLegacy(service)} · ${translateLegacy(`${rules} 条网站规则`)}`;
}

function historyTitle(entry: ConfigHistoryTimelineEntry): string {
  if (!entry.diff) return t('settings.history.retainedSnapshot');
  const changes = entry.diff.groups.flatMap(group => group.changes);
  return changes.length ? changes.slice(0, 2).map(change => translateLegacy(change.label)).join(' · ')
    : t('settings.history.noVisibleChanges');
}

function backupComparison(entry: ConfigAutoBackupEntry): string {
  const diff = buildConfigDiff(toRestorableConfig(props.config), toRestorableConfig(entry.config));
  return diff.changeCount ? t('settings.history.backupDifference', {count: diff.changeCount})
    : translateLegacy('与当前相同');
}

type PreviewKind = 'history' | 'backup';
interface PreviewTarget {
  kind: PreviewKind;
  version?: number;
  label: string;
  savedAt: string;
  config: unknown;
  changes?: ConfigDiffResult | null;
  previousVersion?: number | null;
}

const previewTarget = ref<PreviewTarget | null>(null);
const previewVisible = ref(false);
const applyBusy = ref(false);
const previewMode = ref<'changes' | 'current'>('changes');
const resolvedPreviewConfig = computed(() => previewTarget.value?.config);
const previewDiff = computed(() => buildConfigDiff(
  toRestorableConfig(props.config),
  toRestorableConfig(resolvedPreviewConfig.value),
));
const previewChangeCount = computed(() => previewDiff.value.changeCount);
const displayDiff = computed(() => previewMode.value === 'changes' ? previewTarget.value?.changes : previewDiff.value);
const comparisonBadge = computed(() => previewMode.value === 'changes'
  ? displayDiff.value ? t('settings.history.changeCount', {count: displayDiff.value.changeCount}) : t('settings.history.retainedSnapshot')
  : previewChangeCount.value ? t('settings.history.differenceCount', {count: previewChangeCount.value}) : translateLegacy('与当前相同'));
const comparisonHint = computed(() => previewMode.value === 'changes'
  ? previewTarget.value?.previousVersion != null
    ? t('settings.history.changeHint', {version: previewTarget.value.previousVersion, target: previewTarget.value.label})
    : t('settings.history.noPrevious')
  : t('settings.history.restoreHint'));
const previewJson = computed(() => JSON.stringify(toRestorableConfig(resolvedPreviewConfig.value), null, 2));
const previewTitle = '设置版本详情';
const previewSourceLabel = computed(() => previewTarget.value?.kind === 'history'
  ? `最近修改 ${previewTarget.value.label}`
  : `自动设置快照 ${previewTarget.value?.label || ''}`);
const previewActionLabel = '恢复此版本';
const previewBoundary = 'API 凭据和翻译次数不会随设置版本恢复。';

function showPreview(target: PreviewTarget) {
  previewTarget.value = target;
  previewMode.value = target.kind === 'history' ? 'changes' : 'current';
  previewVisible.value = true;
}

function openHistoryPreview(entry: ConfigHistoryTimelineEntry) {
  showPreview({kind: 'history', version: entry.version, label: `v${entry.version}`, savedAt: entry.savedAt, config: entry.config, changes: entry.diff, previousVersion: entry.previousVersion});
}

function openBackupPreview(entry: ConfigAutoBackupEntry) {
  showPreview({kind: 'backup', version: entry.version, label: `b${entry.version}`, savedAt: entry.savedAt, config: entry.config});
}

function clearPreview() {
  previewTarget.value = null;
  applyBusy.value = false;
}

async function applyPreviewTarget() {
  const target = previewTarget.value;
  if (!target || previewChangeCount.value === 0 || applyBusy.value) return;
  try {
    await ElMessageBox.confirm(
      `将恢复 ${target.label}，并生成一份新的最近修改记录。是否继续？`,
      '确认恢复设置',
      {confirmButtonText: '恢复', cancelButtonText: '取消', type: 'warning'},
    );
  } catch {
    return;
  }

  applyBusy.value = true;
  try {
    if (target.kind === 'history') {
      configHistory.value = await requestConfigHistoryAction('restore', target.version, sendRuntimeMessage);
    } else if (target.kind === 'backup') {
      const result = await requestConfigAutoBackupRestore(target.version!, sendRuntimeMessage);
      configBackups.value = result.backups;
      configHistory.value = result.history;
    }
    previewVisible.value = false;
    ElMessage.success('设置已恢复');
  } catch (error) {
    ElMessage.error(`恢复失败：${error instanceof Error ? error.message : '请稍后重试'}`);
  } finally {
    applyBusy.value = false;
  }
}
</script>

<style scoped>
.config-management { width: 100%; }
.history-heading { width: min(100%, 1080px); margin: 0 auto 10px; padding: 0 4px; }
.history-heading h2 { margin: 0; color: var(--ink); font-size: 15px; line-height: 1.4; }
.history-heading p { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.version-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); align-items: start; gap: 16px; width: min(100%, 1080px); margin: 0 auto 22px; }
.version-panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: 0 7px 22px rgba(31, 40, 61, .035); }
.version-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 16px; border-bottom: 1px solid var(--line); }
.version-panel-heading h2 { margin: 0; color: var(--ink); font-size: 15px; }
.version-panel-heading p { margin: 4px 0 0; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.version-panel-heading > span { flex: none; padding: 4px 8px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; font-weight: 750; }
.version-list { max-height: 520px; overflow-y: auto; }
.version-entry { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 78px; padding: 13px 14px; border: 0; border-bottom: 1px solid var(--line); color: inherit; background: transparent; text-align: left; cursor: pointer; }
.version-entry:last-child { border-bottom: 0; }
.version-entry:hover { background: var(--surface-soft); }
.version-entry.current { background: var(--brand-soft); }
.version-entry:focus-visible { position: relative; outline: 2px solid var(--brand-strong); outline-offset: -3px; }
.version-badge { display: grid; place-items: center; min-height: 28px; border-radius: 9px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; font-weight: 800; }
.version-badge.backup { color: #267260; background: #eaf8f4; }
.version-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.version-copy strong { color: var(--ink); font-size: 11px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.version-copy small, .version-copy time { color: var(--muted); font-size: 10px; line-height: 1.5; }
.version-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--muted); font-size: 10px; }
.change-values { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; min-width: 0; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.change-values > span { min-width: 0; }
.change-label { color: var(--muted); }
.change-before { color: var(--muted); max-width: 100%; }
.change-after { color: var(--ink); max-width: 100%; }
.change-arrow { color: var(--muted); }
.backup-panel .version-list { max-height: 360px; }
.backup-panel .version-entry { min-height: 90px; }
.preview-comparison { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
.preview-comparison button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.preview-comparison button[aria-pressed="true"] { border-color: var(--brand-strong); color: var(--brand-strong); background: var(--brand-soft); }
.preview-comparison button:focus-visible { outline: 2px solid var(--brand-strong); outline-offset: 2px; }
.comparison-hint { margin: 10px 2px 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.view-link, .current-mark { color: var(--brand-strong); font-size: 10px; font-weight: 750; }
.current-mark { padding: 3px 7px; border-radius: 999px; background: var(--brand-soft); }
.version-empty { padding: 28px 16px; color: var(--muted); font-size: 11px; text-align: center; }
.preview-summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface-soft); }
.preview-summary > div { display: flex; flex-direction: column; gap: 3px; }
.preview-summary span { color: var(--muted); font-size: 10px; }
.preview-summary strong { color: var(--ink); font-size: 12px; }
.preview-summary b { padding: 5px 9px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; }
.preview-summary b.empty { color: #267260; background: #eaf8f4; }
.diff-groups { display: grid; gap: 14px; max-height: 48vh; margin-top: 16px; padding-right: 4px; overflow-y: auto; }
.diff-group h3 { display: flex; align-items: center; gap: 7px; margin: 0 0 7px; color: var(--ink); font-size: 12px; }
.diff-group h3 span { display: grid; place-items: center; min-width: 20px; height: 20px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 9px; }
.diff-list { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; }
.diff-item { display: grid; grid-template-columns: minmax(130px, .65fr) repeat(2, minmax(0, 1fr)); gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.diff-item:last-child { border-bottom: 0; }
.diff-item > strong { align-self: center; color: var(--ink); font-size: 10.5px; }
.diff-item div { min-width: 0; }
.diff-item span { color: var(--muted); font-size: 9px; }
.diff-item p { margin: 3px 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: 10px; line-height: 1.45; }
.diff-empty { margin-top: 16px; padding: 28px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); font-size: 11px; text-align: center; }
.json-details { margin-top: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.json-details summary { padding: 11px 13px; color: var(--ink); cursor: pointer; font-size: 10.5px; font-weight: 700; }
.json-details pre { max-height: 280px; margin: 0; padding: 12px; overflow: auto; border-top: 1px solid var(--line); color: var(--muted); background: var(--surface); font-size: 9.5px; line-height: 1.55; white-space: pre-wrap; }
.restore-boundary { margin: 10px 2px 0; color: var(--muted); font-size: 10px; line-height: 1.5; }

@media (max-width: 900px) {
  .version-grid { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .diff-item { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .version-entry { grid-template-columns: 40px minmax(0, 1fr) auto; }
}

:root.dark .version-badge.backup { color: #80d8c2; background: rgba(38, 114, 96, .22); }
:root.dark .preview-summary b.empty { color: #80d8c2; background: rgba(38, 114, 96, .22); }
</style>
