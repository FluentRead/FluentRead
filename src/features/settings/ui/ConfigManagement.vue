<!--
@file src/features/settings/ui/ConfigManagement.vue
文件职责：提供备份与恢复页面的配置云备份、完整数据备份和设置历史；历史预览以适度宽度呈现差异，完整配置按需展开。
主要内容：按页内分类切换完整备份入口与设置历史，仅在历史分区活跃时派生和渲染列表；列表每行只保留版本、一句概要和时间——单项修改给出“改前 → 改后”，多项修改只给数量，自动快照只给时间和与当前的差异数——具体修改在详情里区分当时的修改和恢复时的差异，并保留动态服务名称、多语言与安全恢复。恢复确认、取消后的焦点归还及回包保持页面和预览目标归属。
模块边界：本组件拥有设置历史的预览与恢复，并向本机备份入口转交页面与备份分区的活跃归属；本机备份与导入由 LocalDataManagement 编排，配置云备份由独立 CloudConfigBackup 组件及后台服务负责。
-->
<template>
  <section class="config-management">
    <SettingsPanel name="backup" :active="props.activePanel">
<CloudConfigBackup v-if="props.active && (!props.activePanel || props.activePanel === 'backup')" />
<LocalDataManagement :config="config" :active="props.active && (!props.activePanel || props.activePanel === 'backup')" />
</SettingsPanel>

<SettingsPanel name="history" :active="props.activePanel">
  <template v-if="previewIsActive()">
    <header class="history-heading">
      <h2>设置历史</h2>
      <p>用于找回误改的设置；不包含单词本、模型用量或 API 凭据</p>
    </header>
    <div class="version-grid">
      <section class="version-panel" aria-labelledby="recent-config-title">
        <header class="version-panel-heading settings-card-heading">
          <div class="settings-card-heading-copy">
            <h2 id="recent-config-title">最近修改</h2>
            <p>{{ t('settings.history.recentHint') }}</p>
          </div>
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
              <strong>{{ historyTitle(entry) }}</strong>
              <span v-if="soleChange(entry)" class="change-values">
                <span class="change-before">{{ translateLegacy(soleChange(entry)!.before) }}</span>
                <span class="change-arrow" aria-hidden="true">→</span>
                <span class="change-after">{{ translateLegacy(soleChange(entry)!.after) }}</span>
              </span>
              <small v-else-if="!entry.diff">{{ t('settings.history.noPrevious') }}</small>
              <small v-else-if="entry.diff.changeCount > 1">{{ t('settings.history.changeCount', {count: entry.diff.changeCount}) }}</small>
            </span>
            <span class="version-side">
              <time :datetime="entry.savedAt" :title="formatTime(entry.savedAt)">{{ formatShortTime(entry.savedAt) }}</time>
              <span v-if="entry.version === currentHistoryVersion" class="current-mark">当前</span>
              <span v-else class="view-link">查看</span>
            </span>
          </button>
        </div>
        <div v-else class="version-empty">修改设置后会在这里生成版本</div>
      </section>

      <section class="version-panel backup-panel" aria-labelledby="automatic-backup-title">
        <header class="version-panel-heading settings-card-heading">
          <div class="settings-card-heading-copy">
            <h2 id="automatic-backup-title">自动设置快照</h2>
            <p>{{ t('settings.history.backupHint') }}</p>
          </div>
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
              <strong><time :datetime="entry.savedAt" :title="formatTime(entry.savedAt)">{{ formatShortTime(entry.savedAt) }}</time></strong>
              <small>{{ backupComparison(entry) }}</small>
            </span>
            <span class="view-link">查看</span>
          </button>
        </div>
        <div v-else class="version-empty">首次启动后台后会建立一份基线备份</div>
      </section>
    </div>

  </template>
</SettingsPanel>
    <el-dialog
      v-model="previewVisible"
      class="config-preview-dialog"
      :title="previewTitle"
      width="min(680px, calc(100vw - 32px))"
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

        <details class="json-details fr-dialog-disclosure">
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
    <el-dialog
      v-for="operation in restoreConfirmations"
      :key="operation.id"
      :model-value="true"
      class="config-restore-confirm-dialog"
      title="确认恢复设置"
      width="min(420px, calc(100vw - 32px))"
      append-to-body
      destroy-on-close
      @open-auto-focus="rememberConfirmationOrigin(operation)"
      @focusin="rememberConfirmationFocus(operation, $event)"
      @close-auto-focus="returnConfirmationFocus(operation)"
      @close="cancelConfirmation(operation)"
      @update:model-value="(visible: boolean) => { if (!visible) cancelConfirmation(operation) }"
    >
      <p>将恢复 {{ operation.target.label }}，并生成一份新的最近修改记录。是否继续？</p>
      <template #footer>
        <el-button @click="cancelConfirmation(operation)">取消</el-button>
        <el-button type="primary" @click="confirmRestore(operation)">恢复</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch} from 'vue';
import CloudConfigBackup from './CloudConfigBackup.vue';
import {ElMessage} from 'element-plus';
import browser from 'webextension-polyfill';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';
import {getCustomOpenAIProviderLabel} from '@/src/core/config/customOpenAI';
import {getCompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
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
import {restoreRestorableConfig, toRestorableConfig} from '@/src/services/config/history';
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
let active = true;
const cachedActive = ref(true);
onActivated(() => { cachedActive.value = true; });
onDeactivated(() => {
  cachedActive.value = false;
  invalidatePreview();
});
onUnmounted(() => {
  active = false;
  invalidatePreview();
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

/** 列表里只显示到分钟，完整时间保留在悬停提示和无障碍名称里。 */
function formatShortTime(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return translateLegacy('时间未知');
  return new Intl.DateTimeFormat(language.value, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
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
    || getCompositeTranslationProvider(value.compositeTranslationProviders, value.service)?.name
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

/** 只改了一项时，列表直接给出“改前 → 改后”；多项修改只显示数量，细节在详情里看。 */
function soleChange(entry: ConfigHistoryTimelineEntry) {
  return entry.diff?.changeCount === 1 ? entry.diff.groups.flatMap(group => group.changes)[0] : undefined;
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
interface RestoreOperation {
  id: number;
  target: PreviewTarget;
  config: Config;
  configRevision: string | null;
  expectedConfigRevision: string | null;
  expectedConfigObserved: boolean;
  trigger: HTMLButtonElement | null;
  focusBeforeTrap: Element | null;
  confirmationElement: HTMLElement | null;
}
let restoreSequence = 0;
let pendingRestoreFocus: RestoreOperation | null = null;
const restoreOperation = shallowRef<RestoreOperation | null>(null);
const restoreStarted = ref(false);
const applyBusy = computed(() => restoreOperation.value !== null);
// 每个 Dialog 绑定自己的操作对象；旧实例的关闭事件不能取消后开的确认。
const restoreConfirmations = computed(() => restoreOperation.value && !restoreStarted.value
  ? [restoreOperation.value] : []);
// 父页面通过 Object.assign 水合同一个配置对象；只比较对象身份不足以限定恢复。
// 隐藏且无操作时不读取配置；computed 缓存投影，watch 按渲染批次合并水合的多字段写入。
const restorableRevision = computed(() => previewIsActive() || restoreOperation.value
  ? JSON.stringify(toRestorableConfig(props.config)) : null);
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
const previewBoundary = 'API 凭据和翻译次数不会随设置版本恢复';

function previewIsActive() {
  return active && cachedActive.value && props.active && (!props.activePanel || props.activePanel === 'history');
}

function cancelRestore(operation = restoreOperation.value) {
  if (!operation) { pendingRestoreFocus = null; return; }
  if (restoreOperation.value !== operation) return;
  pendingRestoreFocus = null;
  restoreOperation.value = null;
  restoreStarted.value = false;
}

function invalidatePreview() {
  cancelRestore();
  previewVisible.value = false;
}

function cancelConfirmation(operation: RestoreOperation) {
  if (restoreStarted.value || restoreOperation.value !== operation) return;
  const canReturnFocus = isCurrentRestore(operation);
  cancelRestore(operation);
  if (canReturnFocus) pendingRestoreFocus = operation;
}

function rememberConfirmationOrigin(operation: RestoreOperation) {
  operation.focusBeforeTrap = operation.trigger?.ownerDocument.activeElement ?? null;
}

function rememberConfirmationFocus(operation: RestoreOperation, event: FocusEvent) {
  if (restoreOperation.value === operation && event.currentTarget instanceof HTMLElement) {
    operation.confirmationElement = event.currentTarget;
  }
}

async function returnConfirmationFocus(operation: RestoreOperation) {
  // Escape 的焦点释放可先于 close；只有仍归属当前预览的未发送操作可以申请归还。
  if (restoreOperation.value === operation) cancelConfirmation(operation);
  if (pendingRestoreFocus !== operation) return;
  const trigger = operation.trigger, confirmation = operation.confirmationElement;
  if (!trigger || !confirmation) { pendingRestoreFocus = null; return; }
  const document = trigger.ownerDocument, releasedFrom = document.activeElement;
  if (!confirmation.contains(releasedFrom) && releasedFrom !== trigger) { pendingRestoreFocus = null; return; }

  // EP 2.9.3 的公开 hook 不传 Event，并在 hook 后同步执行默认归还。
  // 允许它返回捕获的原焦点；之后用户的任何新选择都撤销本次补偿。
  let defaultPhase = true, focusMoved = false;
  const onFocusIn = (event: FocusEvent) => {
    if (!defaultPhase || (event.target !== trigger && event.target !== operation.focusBeforeTrap)) focusMoved = true;
  };
  const onVisibilityChange = () => { if (document.visibilityState === 'hidden' && pendingRestoreFocus === operation) pendingRestoreFocus = null; };
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  try {
    await Promise.resolve();
    defaultPhase = false;
    const defaultFocus = document.activeElement;
    await nextTick();
    if (pendingRestoreFocus !== operation) return;
    pendingRestoreFocus = null;
    if (focusMoved || document.activeElement !== defaultFocus || document.visibilityState === 'hidden'
      || !previewIsActive() || !previewVisible.value || previewTarget.value !== operation.target
      || props.config !== operation.config || restorableRevision.value !== operation.configRevision
      || restoreOperation.value || restoreSequence !== operation.id || !trigger.isConnected || trigger.disabled) return;
    // body 只可作为这一个已卸载确认的失焦结果，不能作为任意页面的归还许可。
    if (defaultFocus !== releasedFrom && defaultFocus !== operation.focusBeforeTrap && defaultFocus !== trigger
      && !(defaultFocus === document.body && releasedFrom && !releasedFrom.isConnected)) return;
    if (document.activeElement !== trigger) trigger.focus({preventScroll: true});
  } finally {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (pendingRestoreFocus === operation) pendingRestoreFocus = null;
  }
}

watch([() => props.active, () => props.activePanel, () => props.config], invalidatePreview, {flush: 'sync'});
watch(previewVisible, visible => { if (!visible) cancelRestore(); }, {flush: 'sync'});
watch(previewTarget, () => cancelRestore(), {flush: 'sync'});
watch(restorableRevision, revision => {
  if (pendingRestoreFocus && revision !== pendingRestoreFocus.configRevision) pendingRestoreFocus = null;
  const operation = restoreOperation.value;
  if (operation && !restoreConfigIsCurrent(operation, revision)) invalidatePreview();
});

function restoreConfigIsCurrent(operation: RestoreOperation, revision = restorableRevision.value) {
  // 本次恢复的配置广播可能先于客户端回包；只有发送后才接受目标状态。
  if (restoreStarted.value && revision === operation.expectedConfigRevision) {
    operation.expectedConfigObserved = true;
    return true;
  }
  // 目标状态已到达后又退回启动状态，也属于另一次修改，不能复活旧请求。
  return !operation.expectedConfigObserved && revision === operation.configRevision;
}

function showPreview(target: PreviewTarget) {
  if (!previewIsActive()) return;
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
  if (!previewVisible.value) previewTarget.value = null;
}

function applyPreviewTarget(event: MouseEvent) {
  const target = previewTarget.value;
  if (!previewIsActive() || !previewVisible.value || !target || previewChangeCount.value === 0 || applyBusy.value) return;
  pendingRestoreFocus = null;
  restoreStarted.value = false;
  restoreOperation.value = {
    id: ++restoreSequence, target, config: props.config, configRevision: restorableRevision.value,
    expectedConfigRevision: null, expectedConfigObserved: false,
    trigger: event.currentTarget instanceof HTMLElement && event.currentTarget.tagName === 'BUTTON'
      ? event.currentTarget as HTMLButtonElement : null,
    focusBeforeTrap: null, confirmationElement: null,
  };
}

function isCurrentRestore(operation: RestoreOperation) {
  return restoreOperation.value === operation && previewIsActive() && previewVisible.value
    && previewTarget.value === operation.target && props.config === operation.config
    && restoreConfigIsCurrent(operation);
}

async function confirmRestore(operation: RestoreOperation) {
  if (!isCurrentRestore(operation) || restoreStarted.value) return;
  const target = operation.target;
  try {
    operation.expectedConfigRevision = JSON.stringify(toRestorableConfig(restoreRestorableConfig(target.config, props.config)));
    restoreStarted.value = true;
    if (target.kind === 'history') {
      const history = await requestConfigHistoryAction('restore', target.version, sendRuntimeMessage);
      if (!isCurrentRestore(operation)) return;
      configHistory.value = history;
    } else if (target.kind === 'backup') {
      const result = await requestConfigAutoBackupRestore(target.version!, sendRuntimeMessage);
      if (!isCurrentRestore(operation)) return;
      configBackups.value = result.backups;
      configHistory.value = result.history;
    }
    previewVisible.value = false;
    ElMessage.success('设置已恢复');
  } catch (error) {
    if (isCurrentRestore(operation)) ElMessage.error(`恢复失败：${error instanceof Error ? error.message : '请稍后重试'}`);
  } finally {
    cancelRestore(operation);
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
.version-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.version-panel-heading h2 { margin: 0; color: var(--ink); font-size: 16px; }
.version-panel-heading p { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.version-list { max-height: 520px; overflow-y: auto; }
.version-entry { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 62px; padding: 11px 16px; border: 0; border-bottom: 1px solid var(--line); color: inherit; background: transparent; text-align: left; cursor: pointer; }
.version-entry:last-child { border-bottom: 0; }
.version-entry:hover { background: var(--surface-soft); }
.version-entry.current { background: var(--brand-soft); }
.version-entry:focus-visible { position: relative; outline: 2px solid var(--brand-strong); outline-offset: -3px; }
.version-badge { display: grid; place-items: center; min-height: 28px; border-radius: 9px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; font-weight: 800; }
.version-badge.backup { color: #267260; background: #eaf8f4; }
.version-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.version-copy strong { color: var(--ink); font-size: 12px; font-weight: 600; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.version-copy strong time { color: inherit; font-size: inherit; }
.version-side { display: flex; align-items: center; gap: 12px; flex: none; }
.version-side time { color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.version-copy small, .version-copy time { color: var(--muted); font-size: 10px; line-height: 1.5; }
.change-values { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; min-width: 0; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.change-values > span { min-width: 0; }
.change-before { color: var(--muted); max-width: 100%; }
.change-after { color: var(--ink); max-width: 100%; }
.change-arrow { color: var(--muted); }
.backup-panel .version-list { max-height: 360px; }
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
