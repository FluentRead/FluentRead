<!--
@file src/features/settings/ui/LocalDataManagement.vue
文件职责：在备份与恢复页提供唯一的 FluentRead 数据迁移入口。
主要内容：将设置、单词本和模型用量导出为一份版本化备份，确认期随页面活跃归属失效；已接受并开始读取的导出继续下载，迟到提示与焦点归还仍核对归属。文件导入和粘贴 JSON 的输入、预览、确认及关闭事件绑定本次活跃对话框，旧确认不能接受新预览；已确认导入继续完成各领域写入并消费旧预览，只允许本次打开的对话框关闭回调清理和归还焦点，避免迟到结果影响新视图。
模块边界：组件只编排 runtime 协议和文件交互；各领域仓库继续拥有校验与合并规则，Anki 与清空等单词本操作留在单词本页。
-->
<template>
  <div class="local-data-management">
    <SettingsGroup :title="t('settings.backup.localTitle')">
      <div class="transfer-row featured-transfer">
        <div class="transfer-identity">
          <span class="transfer-icon" aria-hidden="true"><UiIcon name="history" /></span>
          <div class="transfer-copy">
            <strong>{{ t('settings.backup.fileTitle') }}</strong>
            <small>{{ t('settings.backup.fileDescription') }}</small>
          </div>
        </div>
        <div class="transfer-actions">
          <el-button :loading="busy" @click="exportCompleteBackup($event)"><Download />导出备份</el-button>
          <el-button type="primary" :disabled="busy" @click="openRestoreSource($event)"><Upload />从备份恢复</el-button>
        </div>
      </div>
    </SettingsGroup>

    <input
      :key="restoreSourceActions.inputKey"
      ref="data-import-input"
      hidden
      type="file"
      accept="application/json,.json"
      :onChange="restoreSourceActions.readFile"
    />

    <el-dialog
      :model-value="restoreSourceVisible"
      @update:model-value="restoreSourceActions.setVisible"
      title="从备份恢复"
      width="min(600px, calc(100vw - 32px))"
      data-testid="restore-source-dialog"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @closed="clearRestoreSource"
    >
      <div class="restore-file-choice">
        <div>
          <strong>选择备份文件</strong>
          <small>{{ t('settings.backup.restoreHint') }}</small>
        </div>
        <el-button type="primary" :disabled="busy" @click="restoreSourceActions.chooseFile">选择文件</el-button>
      </div>
      <details class="legacy-paste">
        <summary>粘贴旧版配置 JSON</summary>
        <p>如果你以前使用“导出配置”复制了 JSON，可以直接粘贴在这里</p>
        <el-input
          :model-value="pastedJson"
          @update:model-value="restoreSourceActions.updateJson"
          type="textarea"
          :rows="8"
          :placeholder="translateLegacy('粘贴 FluentRead JSON').replace('FluentRead', t('common.brand'))"
          :aria-label="translateLegacy('粘贴 FluentRead JSON').replace('FluentRead', t('common.brand'))"
        />
        <div class="legacy-paste-actions">
          <el-button :disabled="busy || !pastedJson.trim()" @click="restoreSourceActions.preview">预览恢复内容</el-button>
        </div>
      </details>
    </el-dialog>

    <el-dialog
      :model-value="importPreviewVisible"
      @update:model-value="importPreviewActions.setVisible"
      title="导入前确认"
      width="min(720px, calc(100vw - 32px))"
      destroy-on-close
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      data-testid="local-data-import-dialog"
      @closed="clearImportPreview"
    >
      <template v-if="pendingImport && importSummary">
        <div class="import-file-summary">
          <div>
            <span>{{ importKindLabel }}</span>
            <strong>{{ pendingFileName }}</strong>
          </div>
          <small>{{ formatFileSize(pendingFileSize) }}</small>
        </div>

        <div class="import-section-grid">
          <article :class="{ muted: !importSummary.configIncluded }">
            <span>设置与凭据</span>
            <strong>{{ importSummary.configIncluded ? (configChangeCount ? `${configChangeCount} 项设置或凭据变化` : '设置与凭据相同') : '不包含' }}</strong>
            <small>{{ importSummary.configIncluded ? '备份中的凭据会一并应用，具体内容不会显示' : '当前设置保持不变' }}</small>
          </article>
          <article :class="{ muted: importSummary.vocabularyEntries === 0 && pendingImport.kind !== 'complete' }">
            <span>单词本</span>
            <strong>{{ importSummary.vocabularyEntries }} 个词条</strong>
            <small>{{ importSummary.vocabularyReviewLogs }} 条复习日志 · 已有词条不会重复</small>
          </article>
          <article :class="{ muted: importSummary.modelUsageEvents === 0 && pendingImport.kind !== 'complete' }">
            <span>模型用量</span>
            <strong>{{ importSummary.modelUsageEvents }} 条记录</strong>
            <small>已有记录不会重复</small>
          </article>
        </div>

        <section v-if="importSummary.configIncluded" class="config-import-preview" aria-labelledby="migration-config-preview-title">
          <header>
            <div>
              <span>设置差异</span>
              <strong id="migration-config-preview-title">导入后会发生什么</strong>
            </div>
            <b>{{ configChangeCount }} 项需确认</b>
          </header>
          <div v-if="configPreviewDiff.groups.length || credentialPreviewChanges.length" class="config-change-list">
            <section v-for="group in configPreviewDiff.groups" :key="group.id" class="config-change-group">
              <h4>{{ group.label }}<span>{{ group.changes.length }}</span></h4>
              <article v-for="change in group.changes" :key="change.key">
                <strong>{{ change.label }}</strong>
                <div><span>当前</span><p>{{ change.before }}</p></div>
                <div><span>导入后</span><p>{{ change.after }}</p></div>
              </article>
            </section>
            <section v-if="credentialPreviewChanges.length" class="config-change-group">
              <h4>凭据安全<span>{{ credentialPreviewChanges.length }}</span></h4>
              <article v-for="change in credentialPreviewChanges" :key="change.key">
                <strong>{{ change.label }}</strong>
                <div><span>当前</span><p>{{ change.before }}</p></div>
                <div><span>导入后</span><p>{{ change.after }}</p></div>
              </article>
            </section>
          </div>
          <p v-else class="config-same">普通设置和凭据与当前状态相同</p>
        </section>

        <p class="import-boundary">
          {{ importBoundary }}
        </p>
      </template>
      <template #footer>
        <el-button :disabled="busy" @click="importPreviewActions.cancel">取消</el-button>
        <el-button type="primary" :loading="busy" :disabled="!pendingImport" @click="importPreviewActions.confirm">确认导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import {downloadTextFile as downloadFile} from '@/src/shared/dom/downloadTextFile';
import UiIcon from '@/src/ui/components/UiIcon.vue'
import {computed, nextTick, ref, shallowRef, useTemplateRef} from 'vue';
import {Download, Upload} from '@element-plus/icons-vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import browser from 'webextension-polyfill';
import {buildConfigDiff} from '@/src/core/config/diff';
import type {Config} from '@/src/core/config/model';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {
  createFluentReadDataBackup,
  parseLocalDataImport,
  resolveBackupConfigCredentialMode,
  summarizeLocalDataImport,
  type LocalDataImport,
  usesExactCredentialReplacement,
} from '@/src/features/settings/model/dataBackup';
import {buildCredentialPreviewChanges} from '@/src/features/settings/model/credentialPreview';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {
  VOCABULARY_BOOK_MESSAGE,
  type VocabularyBookExport,
  type VocabularyBookRequest,
  type VocabularyBookResponse,
  type VocabularyImportResult,
  vocabularyImportNeedsConfirmation,
} from '@/src/features/vocabulary/public';
import type {ModelUsageImportResult, ModelUsageTransferDocument} from '@/src/services/model-usage/types';
import {prepareHydratedConfigForExport, requestConfigSave} from '@/src/services/config';
import {toRestorableConfig} from '@/src/services/config/history';
import SettingsGroup from './components/SettingsGroup.vue';
import {useUiI18n} from '@/src/ui/i18n';

const {t, translateLegacy} = useUiI18n();
const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const localDataContext = useSettingsActionContext(() => props.active, () => []);
const importInput = useTemplateRef<HTMLInputElement>('data-import-input');
const busy = ref(false);
const restoreSourceVisible = ref(false);
const pastedJson = ref('');
const pendingImport = shallowRef<LocalDataImport | null>(null);
const pendingFileName = ref('');
const pendingFileSize = ref(0);
const importPreviewVisible = ref(false);
const sendRuntimeMessage = browser.runtime.sendMessage.bind(browser.runtime);
let importTrigger: HTMLElement | null = null;
let restoreActionTrigger: HTMLElement | null = null;
const noopClosed = () => undefined;
const clearImportPreview = shallowRef<() => void>(noopClosed);
const clearRestoreSource = shallowRef<() => void>(noopClosed);
// 控件可能保留旧事件；视图归属或恢复对话框更新后，不允许它们修改新一次恢复内容。
const restoreSourceActions = computed(() => {
  const source = clearRestoreSource.value;
  const isCurrent = localDataContext.capture();
  const ownsSource = () => isCurrent() && clearRestoreSource.value === source
    && restoreSourceVisible.value && !importPreviewVisible.value && !busy.value;
  return {
    inputKey: Symbol(),
    setVisible(value: boolean) {if (ownsSource()) restoreSourceVisible.value = value;},
    updateJson(value: string) {if (ownsSource()) pastedJson.value = value;},
    chooseFile(event?: MouseEvent) {if (ownsSource()) chooseImport(event);},
    readFile(event: Event) {if (ownsSource()) return readImportFile(event);},
    preview(event?: MouseEvent) {if (ownsSource()) return previewPastedImport(event);},
  };
});
const importPreviewActions = computed(() => {
  const preview = clearImportPreview.value;
  const target = pendingImport.value;
  const isCurrent = localDataContext.capture();
  const ownsPreview = () => isCurrent() && clearImportPreview.value === preview
    && pendingImport.value === target && importPreviewVisible.value && !busy.value;
  return {
    setVisible(value: boolean) {if (ownsPreview()) importPreviewVisible.value = value;},
    cancel() {if (ownsPreview()) importPreviewVisible.value = false;},
    confirm() {if (ownsPreview()) return applyPendingImport();},
  };
});

const importSummary = computed(() => pendingImport.value ? summarizeLocalDataImport(pendingImport.value) : null);
function prepareImportedConfig(target: LocalDataImport | null, current: Config): Config | null {
  if (target?.kind === 'complete') {
    return prepareConfigForImport(target.backup.config, current, {
      credentialMode: resolveBackupConfigCredentialMode(target.backup),
    });
  }
  if (target?.kind === 'config') return prepareConfigForImport(target.config, current);
  return null;
}
const importedConfig = computed(() => prepareImportedConfig(pendingImport.value, props.config));
const configPreviewDiff = computed(() => buildConfigDiff(
  toRestorableConfig(props.config),
  toRestorableConfig(importedConfig.value),
));
const credentialPreviewChanges = computed(() => importedConfig.value
  ? buildCredentialPreviewChanges(props.config, importedConfig.value)
  : []);
const configChangeCount = computed(() => configPreviewDiff.value.changeCount + credentialPreviewChanges.value.length);
const importKindLabel = computed(() => ({
  complete: translateLegacy('FluentRead 备份').replace(/FluentRead|플루언트리드/u, t('common.brand')),
  vocabulary: '旧版单词本备份',
  'model-usage': '旧版模型用量备份',
  config: '旧版配置文件',
})[pendingImport.value?.kind || 'complete']);
const importBoundary = computed(() => {
  if (pendingImport.value?.kind === 'vocabulary') return '只恢复单词本，当前设置和模型用量保持不变';
  if (pendingImport.value?.kind === 'model-usage') return '只恢复模型用量，当前设置和单词本保持不变';
  if (pendingImport.value?.kind === 'config') return '只恢复设置，单词本和模型用量保持不变';
  return '导入会更新设置、合并单词本和用量记录，已有记录不会重复；未恢复的内容会另行提示';
});

async function requestVocabulary<T>(request: VocabularyBookRequest): Promise<T> {
  const response = await sendRuntimeMessage(request) as VocabularyBookResponse<T>;
  if (!response?.success) throw new Error(response?.error?.message || '单词本操作失败');
  return response.data;
}

type ModelUsageResponse<T> = {success: true; data: T} | {success: false; error: string};

async function requestModelUsage<T>(action: 'export' | 'import', document?: unknown): Promise<T> {
  const response = await sendRuntimeMessage({
    type: 'modelUsage',
    action,
    ...(document === undefined ? {} : {document}),
  }) as ModelUsageResponse<T>;
  if (!response?.success) throw new Error(response?.error || '模型用量操作失败');
  return response.data;
}

async function vocabularyExport(includePrivateContext: boolean): Promise<VocabularyBookExport> {
  return requestVocabulary<VocabularyBookExport>({
    type: VOCABULARY_BOOK_MESSAGE,
    action: 'exportData',
    options: {includePrivateContext},
  });
}

async function modelUsageExport(): Promise<ModelUsageTransferDocument> {
  return requestModelUsage<ModelUsageTransferDocument>('export');
}

async function exportCompleteBackup(event?: MouseEvent): Promise<void> {
  if (!localDataContext.active.value || busy.value) return;
  const trigger = eventTarget(event);
  const isCurrent = localDataContext.capture();
  const includePrivateContext = await chooseBackupContext();
  if (includePrivateContext === null || !isCurrent()) return;
  busy.value = true;
  try {
    const [configSnapshot, vocabulary, modelUsage] = await Promise.all([
      prepareHydratedConfigForExport(),
      vocabularyExport(includePrivateContext),
      modelUsageExport(),
    ]);
    const backup = createFluentReadDataBackup({
      config: configSnapshot,
      vocabulary,
      modelUsage,
    });
    downloadFile(`fluentread-backup-${dateStamp()}.json`, JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    if (isCurrent()) ElMessage.success(`备份已导出：${vocabulary.entries.length} 个词条，${modelUsage.events.length} 条用量记录`);
  } catch (error) {
    if (isCurrent()) ElMessage.error(`导出失败：${errorMessage(error)}`);
  } finally {
    busy.value = false;
    await focusTriggerAfterBusy(trigger, isCurrent);
  }
}

async function chooseBackupContext(): Promise<boolean | null> {
  try {
    await ElMessageBox.confirm(
      '网页片段、页面标题和来源网址可能包含浏览隐私，默认不纳入单词收藏的备份',
      '是否包含单词上下文？',
      {
        confirmButtonText: '不包含并导出',
        cancelButtonText: '包含并导出',
        distinguishCancelAndClose: true,
        type: 'warning',
      },
    );
    return false;
  } catch (action) {
    return action === 'cancel' ? true : null;
  }
}

function openRestoreSource(event: MouseEvent): void {
  if (!localDataContext.active.value || busy.value || importPreviewVisible.value) return;
  if (pendingImport.value) consumePendingImport(pendingImport.value);
  clearImportPreview.value = noopClosed;
  const trigger = event.currentTarget as HTMLElement | null;
  const isCurrent = localDataContext.capture();
  const previewAtOpen = clearImportPreview.value;
  let handled = false;
  const closed = () => {
    if (handled || clearRestoreSource.value !== closed || restoreSourceVisible.value) return;
    handled = true;
    pastedJson.value = '';
    restoreActionTrigger = null;
    if (clearImportPreview.value !== previewAtOpen || importPreviewVisible.value) return;
    if (importTrigger === trigger) importTrigger = null;
    void focusTriggerAfterBusy(trigger, () => isCurrent()
      && clearRestoreSource.value === closed && clearImportPreview.value === previewAtOpen
      && !restoreSourceVisible.value && !importPreviewVisible.value);
  };
  clearRestoreSource.value = closed;
  importTrigger = trigger;
  restoreSourceVisible.value = true;
}

function chooseImport(event?: MouseEvent): void {
  restoreActionTrigger = eventTarget(event);
  importInput.value?.click();
}

function showImportPreview(target: LocalDataImport, name: string, size: number): void {
  const trigger = importTrigger;
  const isCurrent = localDataContext.capture();
  const sourceAtShow = clearRestoreSource.value;
  let handled = false;
  const closed = () => {
    if (handled || clearImportPreview.value !== closed || clearRestoreSource.value !== sourceAtShow
      || importPreviewVisible.value || restoreSourceVisible.value) return;
    handled = true;
    const pending = pendingImport.value;
    if (pending) consumePendingImport(pending);
    if (importTrigger === trigger) importTrigger = null;
    void focusTriggerAfterBusy(trigger, () => isCurrent()
      && clearImportPreview.value === closed && clearRestoreSource.value === sourceAtShow
      && !restoreSourceVisible.value && !importPreviewVisible.value);
  };
  clearImportPreview.value = closed;
  pendingImport.value = target;
  pendingFileName.value = name;
  pendingFileSize.value = size;
  importPreviewVisible.value = true;
  restoreSourceVisible.value = false;
}

async function readImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || busy.value || !localDataContext.active.value || !restoreSourceVisible.value) return;
  const trigger = restoreActionTrigger;
  restoreActionTrigger = null;
  const isCurrent = localDataContext.capture();
  busy.value = true;
  try {
    if (vocabularyImportNeedsConfirmation(file.size)) {
      try {
        await ElMessageBox.confirm(
          `文件约 ${Math.ceil(file.size / (1024 * 1024))} MB，读取和校验可能需要较长时间。是否继续？`,
          '导入较大的备份',
          {confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning'},
        );
      } catch {
        return;
      }
    }
    if (!isCurrent()) return;
    const text = await file.text();
    if (!isCurrent()) return;
    const parsed = parseLocalDataImport(JSON.parse(text));
    showImportPreview(parsed, file.name, file.size);
  } catch (error) {
    if (isCurrent()) ElMessage.error(`无法读取备份：${errorMessage(error)}`);
  } finally {
    busy.value = false;
    await focusTriggerAfterBusy(trigger, () => isCurrent() && restoreSourceVisible.value && !importPreviewVisible.value);
  }
}

async function previewPastedImport(event?: MouseEvent): Promise<void> {
  const text = pastedJson.value.trim();
  if (!text || busy.value || !localDataContext.active.value || !restoreSourceVisible.value) return;
  const trigger = eventTarget(event);
  const isCurrent = localDataContext.capture();
  busy.value = true;
  try {
    const parsed = parseLocalDataImport(JSON.parse(text));
    showImportPreview(parsed, '粘贴的旧版 JSON', new Blob([text]).size);
  } catch (error) {
    if (isCurrent()) ElMessage.error(`无法读取 JSON：${errorMessage(error)}`);
  } finally {
    busy.value = false;
    await focusTriggerAfterBusy(trigger, () => isCurrent() && restoreSourceVisible.value && !importPreviewVisible.value);
  }
}

async function applyPendingImport(): Promise<void> {
  const target = pendingImport.value;
  if (!target || busy.value || !localDataContext.active.value || !importPreviewVisible.value) return;
  const isCurrent = localDataContext.capture();
  const configBaseFingerprint = target.kind === 'complete' || target.kind === 'config'
    ? JSON.stringify(prepareConfigForExport(props.config))
    : '';
  const confirmedConfigChangeCount = configChangeCount.value;
  busy.value = true;
  const successes: string[] = [];
  const failures: string[] = [];
  const run = async (label: string, operation: () => Promise<string>) => {
    try {
      successes.push(await operation());
    } catch (error) {
      failures.push(`${label}：${errorMessage(error)}`);
    }
  };

  try {
    if (target.kind === 'complete' || target.kind === 'model-usage') {
      const modelUsage = target.kind === 'complete' ? target.backup.modelUsage : target.modelUsage;
      await run('模型用量', async () => {
        const result = await requestModelUsage<ModelUsageImportResult>('import', modelUsage);
        return `模型用量新增 ${result.importedCount}、跳过 ${result.duplicateCount}`;
      });
    }
    if (target.kind === 'complete' || target.kind === 'vocabulary') {
      const vocabulary = target.kind === 'complete' ? target.backup.vocabulary : target.vocabulary;
      await run('单词本', async () => {
        const result = await requestVocabulary<VocabularyImportResult>({
          type: VOCABULARY_BOOK_MESSAGE,
          action: 'importData',
          data: vocabulary,
        });
        return `单词本新增 ${result.inserted}、更新 ${result.updated}、跳过 ${result.skipped}`;
      });
    }
    if (target.kind === 'complete' || target.kind === 'config') {
      await run('设置', async () => {
        if (JSON.stringify(prepareConfigForExport(props.config)) !== configBaseFingerprint) {
          throw new Error('设置在导入期间已被其他页面修改，本次未覆盖；请重新预览后再导入设置');
        }
        const targetConfig = prepareImportedConfig(target, props.config);
        if (!targetConfig) throw new Error('备份中不包含可恢复的设置');
        await requestConfigSave(targetConfig, sendRuntimeMessage, {
          credentialIntent: target.kind === 'complete' && usesExactCredentialReplacement(target.backup)
            ? 'exact'
            : 'changed-fields',
        });
        return `设置已应用（${confirmedConfigChangeCount} 项需确认）`;
      });
    }
  } finally {
    busy.value = false;
    if (consumePendingImport(target)) importPreviewVisible.value = false;
  }

  if (!isCurrent()) return;
  if (failures.length) {
    ElMessage.error(`导入完成但有失败项：${failures.join('；')}。已成功：${successes.join('；') || '无'}`);
  } else {
    ElMessage.success(`导入完成：${successes.join('；')}`);
  }
}

function consumePendingImport(target: LocalDataImport): boolean {
  if (pendingImport.value !== target) return false;
  pendingImport.value = null;
  pendingFileName.value = '';
  pendingFileSize.value = 0;
  return true;
}

function eventTarget(event?: MouseEvent): HTMLElement | null {
  return event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
}

async function focusTriggerAfterBusy(
  trigger: HTMLElement | null,
  shouldFocus: () => boolean,
): Promise<void> {
  await nextTick();
  const activeElement = document.activeElement;
  const focusWasLost = !activeElement || activeElement === document.body || activeElement === document.documentElement;
  if (focusWasLost && trigger?.isConnected && shouldFocus()) trigger.focus();
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}



function errorMessage(error: unknown): string {
  if (error instanceof TypeError && error.message === '不是受支持的 FluentRead 备份或旧版配置文件') {
    return translateLegacy(error.message).replace('FluentRead', t('common.brand'));
  }
  return error instanceof Error && error.message.trim() ? error.message : '请稍后重试';
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped>
.local-data-management { width: 100%; }
.transfer-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 16px; }
.featured-transfer { background: var(--surface); }
.transfer-identity { display: flex; min-width: 0; align-items: center; gap: 12px; }
.transfer-icon { display: grid; flex: none; width: 36px; height: 36px; place-items: center; border-radius: 11px; color: var(--brand-strong); background: var(--brand-soft); font-size: 16px; font-weight: 800; }
.transfer-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.transfer-copy strong { color: var(--ink); font-size: 12.5px; }
.transfer-copy small, .import-boundary { color: var(--muted); font-size: 10.5px; line-height: 1.55; }
.transfer-actions { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: 7px; }
.transfer-actions :deep(.el-button) { margin-left: 0; }
.transfer-actions :deep(svg) { width: 14px; margin-right: 5px; }
.restore-file-choice { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface-soft); }
.restore-file-choice > div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.restore-file-choice strong { color: var(--ink); font-size: 12px; }
.restore-file-choice small, .legacy-paste p { color: var(--muted); font-size: 10px; line-height: 1.55; }
.legacy-paste { margin-top: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.legacy-paste summary { padding: 12px 14px; color: var(--ink); cursor: pointer; font-size: 10.5px; font-weight: 700; }
.legacy-paste p { margin: 0; padding: 0 14px 10px; }
.legacy-paste :deep(.el-textarea) { display: block; padding: 0 14px; box-sizing: border-box; }
.legacy-paste-actions { display: flex; justify-content: flex-end; padding: 10px 14px 14px; }
.import-file-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface-soft); }
.import-file-summary > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.import-file-summary span, .import-file-summary small { color: var(--muted); font-size: 10px; }
.import-file-summary strong { overflow: hidden; color: var(--ink); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.import-section-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.import-section-grid article { display: flex; min-height: 108px; padding: 13px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); flex-direction: column; }
.import-section-grid article.muted { opacity: .55; }
.import-section-grid span { color: var(--muted); font-size: 9.5px; font-weight: 700; }
.import-section-grid strong { margin: 8px 0 5px; color: var(--ink); font-size: 14px; }
.import-section-grid small { color: var(--muted); font-size: 9px; line-height: 1.45; }
.import-boundary { margin: 12px 2px 0; }
.config-import-preview { margin-top: 14px; padding: 13px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface-soft); }
.config-import-preview > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.config-import-preview > header > div { display: flex; flex-direction: column; gap: 3px; }
.config-import-preview > header span { color: var(--muted); font-size: 9.5px; }
.config-import-preview > header strong { color: var(--ink); font-size: 12px; }
.config-import-preview > header b { padding: 5px 9px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 9.5px; }
.config-change-list { display: grid; gap: 11px; max-height: 34vh; margin-top: 12px; padding-right: 3px; overflow-y: auto; }
.config-change-group { overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); }
.config-change-group h4 { display: flex; align-items: center; gap: 6px; margin: 0; padding: 9px 10px; border-bottom: 1px solid var(--line); color: var(--ink); font-size: 10.5px; }
.config-change-group h4 span { display: grid; min-width: 18px; height: 18px; place-items: center; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 8.5px; }
.config-change-group article { display: grid; grid-template-columns: minmax(110px, .65fr) repeat(2, minmax(0, 1fr)); gap: 10px; padding: 9px 10px; border-bottom: 1px solid var(--line); }
.config-change-group article:last-child { border-bottom: 0; }
.config-change-group article > strong { align-self: center; color: var(--ink); font-size: 9.5px; }
.config-change-group article div { min-width: 0; }
.config-change-group article span { color: var(--muted); font-size: 8.5px; }
.config-change-group article p { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: 9px; line-height: 1.4; }
.config-same { margin: 12px 0 0; color: var(--muted); font-size: 10px; }

@media (max-width: 820px) {
  .transfer-row { align-items: flex-start; flex-direction: column; }
  .transfer-actions { width: 100%; }
  .restore-file-choice { align-items: flex-start; flex-direction: column; }
  .import-section-grid { grid-template-columns: 1fr; }
  .config-change-group article { grid-template-columns: 1fr; gap: 5px; }
}

</style>
