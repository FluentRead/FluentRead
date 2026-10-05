<!--
@file src/features/settings/ui/RemoteConfigSync.vue
文件职责：用清晰的保存、恢复与逐项合并流程完成Google Drive 与 WebDAV 共用的配置云备份。
主要内容：默认只同步普通设置，敏感信息须阅读风险并明确同意且只对本次操作有效；预览说明旧备份范围和恢复保护。
风险确认集中展示存储方式、泄露风险与单次授权；删除确认以紧凑账号行和影响说明展示目标，次要信息按需展开。
删除前须输入本次界面语言的确认文本，再点击确认；只删除已核验版本的备份文件，并保留本机配置。
通过右侧记录插槽统一显示账号和时间，窄屏改为上下排列；显示本次账号并提供更换账号入口；按两步流程说明影响范围，
先选择操作再确认影响；缺少安全覆盖版本时明确提示只读恢复；默认展示差异与连接变更类别，小屏保留操作区。
模块边界：只消费后台脱敏预览和同步记录；不获取完整配置、令牌或用户口令，由父级提供存储方式和客户端。
-->
<template>
  <section class="drive-sync" :data-testid="`${kind}-sync`" :aria-busy="busy">
    <slot name="connection" :busy="busy" />
    <div class="cloud-scope" data-testid="cloud-sync-scope">
      <div class="cloud-scope-heading"><strong>{{ t('settings.cloud.scopeTitle') }}</strong><span :class="{'includes-sensitive': includeSensitive}">{{ t(includeSensitive ? 'settings.cloud.scopeSensitive' : 'settings.cloud.scopeSettings') }}</span></div>
      <p>{{ t('settings.cloud.scopeSettingsDescription') }}</p>
      <div class="cloud-sensitive-option">
        <label :for="`${kind}-include-sensitive`"><strong>{{ t('settings.cloud.includeSensitive') }}</strong><span>{{ t('settings.cloud.sensitiveDescription') }}</span></label>
        <el-switch :id="`${kind}-include-sensitive`" :model-value="includeSensitive" :disabled="busy || previewVisible" :aria-label="t('settings.cloud.includeSensitive')" data-testid="cloud-include-sensitive" @change="toggleSensitive" />
      </div>
      <p class="cloud-scope-note" role="status">{{ t(includeSensitive ? 'settings.cloud.consentOnce' : 'settings.cloud.preserveLocal') }}</p>
    </div>
    <el-alert v-if="error && !previewVisible" :title="error" type="error" :closable="false" show-icon class="drive-error" />
    <el-alert v-if="status?.cleanupPending && !previewVisible" :title="t('settings.cloud.cleanupPending')" type="warning" :closable="false" show-icon class="drive-error" />
    <div class="drive-actions">
      <el-button v-if="status?.available" type="primary" :loading="busy" :disabled="busy" :data-testid="`${kind}-sync-now`" @click="prepare">{{ t('settings.cloud.syncNow', {provider}) }}</el-button>
      <slot name="record" :status="status" :status-text="statusText">
      <div v-if="status?.account?.email || statusText" class="drive-record" role="status">
        <p v-if="status?.account?.email" :data-testid="`${kind}-last-account`">{{ t('settings.drive.lastAccount', {email: status.account.email}) }}</p>
        <p v-if="statusText" class="drive-status">{{ statusText }}</p>
      </div>
      </slot>
    </div>
    <div v-if="status?.available" class="cloud-delete-entry"><el-button link type="danger" :disabled="busy || previewVisible || consentVisible || deleteVisible" :data-testid="`${kind}-delete-backup`" @click="prepareDeletion"><el-icon><Delete /></el-icon>{{ t('settings.cloud.deleteBackup') }}</el-button></div>
    <el-dialog v-model="deleteVisible" class="cloud-delete-dialog cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t(deletion?.hasRemote ? 'settings.cloud.deleteTitle' : 'settings.cloud.deleteAbsent')" width="min(480px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="cancelDeletion" destroy-on-close @closed="deletion = null">
      <template v-if="deletion">
        <div class="cloud-delete-account"><div class="cloud-delete-target"><strong><slot name="delete-account">{{ deletion.account.email || t('settings.cloud.selectedAccount') }}</slot></strong><slot name="delete-location" /></div><el-button v-if="kind === 'google-drive'" link :disabled="busy" data-testid="google-drive-delete-switch-account" @click="changeDeletionAccount">{{ t('settings.cloud.changeAccount') }}</el-button></div>
        <div class="cloud-delete-impact"><p class="cloud-delete-description">{{ t(deletion.hasRemote ? 'settings.cloud.deleteDescription' : 'settings.cloud.deleteAbsentDescription') }}</p><p class="cloud-delete-preserved">{{ t('settings.cloud.deleteLocalPreserved') }}</p></div>
        <div v-if="deletion.hasRemote && deletion.canDelete" class="cloud-delete-verification" data-testid="cloud-delete-verification"><label :for="`${kind}-delete-verification`">{{ t('settings.cloud.deleteVerification', {phrase: t('settings.cloud.deletePhrase')}) }}</label><el-input :id="`${kind}-delete-verification`" v-model="deleteConfirmation" :disabled="busy" :maxlength="64" autocomplete="off" :spellcheck="false" @keydown.enter.prevent /></div>
        <div v-if="deletion.hasRemote" class="cloud-delete-details"><el-button link :aria-expanded="deleteDetailsVisible" :aria-controls="`${kind}-delete-details`" data-testid="cloud-delete-details-toggle" @click="deleteDetailsVisible = !deleteDetailsVisible">{{ t('settings.cloud.deleteDetails') }}<el-icon><component :is="deleteDetailsVisible ? ArrowUp : ArrowDown" /></el-icon></el-button><div v-show="deleteDetailsVisible" :id="`${kind}-delete-details`"><p class="cloud-delete-note">{{ t('settings.cloud.deleteHistory') }}</p><p class="cloud-delete-note">{{ t('settings.cloud.deleteRecreate') }}</p></div></div>
        <el-alert v-if="deletion.hasRemote && !deletion.canDelete" :title="t('settings.cloud.deleteUnsupported')" :description="t(kind === 'google-drive' ? 'settings.cloud.deleteManualDrive' : 'settings.cloud.deleteManualWebDav')" type="warning" :closable="false" show-icon data-testid="cloud-delete-unsupported" />
      </template>
      <template #footer><div class="cloud-consent-actions"><el-button :disabled="busy" data-testid="cloud-delete-cancel" @click="cancelDeletion">{{ t('settings.drive.cancelSync') }}</el-button><el-button type="primary" :loading="busy" :disabled="busy || !canConfirmDeletion" data-testid="cloud-delete-confirm" @click="confirmDeletion">{{ t(deletion?.hasRemote ? 'settings.cloud.deleteConfirm' : 'settings.cloud.deleteFinish') }}</el-button></div></template>
    </el-dialog>
    <el-dialog v-model="consentVisible" class="cloud-consent-dialog cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t('settings.cloud.consentTitle')" width="min(480px, calc(100vw - 24px))" destroy-on-close @closed="riskAcknowledged = false">
      <p class="cloud-consent-intro">{{ t('settings.cloud.consentStorage', {provider}) }}</p>
      <div class="cloud-consent-risk"><el-icon><Warning /></el-icon><p>{{ t('settings.cloud.consentRisk') }}</p></div>
      <label class="cloud-consent-checkbox"><input v-model="riskAcknowledged" type="checkbox" data-testid="cloud-risk-acknowledgement" /><span>{{ t('settings.cloud.consentAcknowledgement') }}</span></label>
      <template #footer><div class="cloud-consent-actions"><el-button data-testid="cloud-consent-cancel" @click="consentVisible = false">{{ t('settings.cloud.keepSettingsOnly') }}</el-button><el-button type="primary" :disabled="!riskAcknowledged" data-testid="cloud-consent-confirm" @click="confirmSensitive">{{ t('settings.cloud.consentConfirm') }}</el-button></div></template>
    </el-dialog>
    <el-dialog class="drive-dialog fluentread-cloud-sync-dialog" v-model="previewVisible" :title="t('settings.drive.previewTitle')" width="min(820px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="cancelPreview" destroy-on-close @closed="clearPreview">
      <template v-if="preview">
        <div class="drive-account-bar">
          <el-icon class="drive-account-icon"><User /></el-icon>
          <p>{{ preview.account.email ? t('settings.drive.account', {email: preview.account.email}) : t('settings.drive.selectedAccount') }}</p>
          <el-button v-if="kind === 'google-drive'" link :loading="switchingAccount" :disabled="busy" :data-testid="`${kind}-switch-account`" @click="switchAccount">{{ t('settings.drive.switchAccount') }}</el-button>
        </div>
        <div class="cloud-preview-scope" role="status" data-testid="cloud-preview-scope"><strong>{{ t(preview.includeSensitive ? 'settings.cloud.scopeSensitive' : 'settings.cloud.scopeSettings') }}</strong><p>{{ t(preview.includeSensitive ? 'settings.cloud.previewSensitive' : 'settings.cloud.preserveLocal') }}</p></div>
        <el-alert v-if="preview.remoteIncludesSensitive && !preview.includeSensitive" :title="t('settings.cloud.legacySensitive')" type="warning" :closable="false" show-icon class="drive-error drive-preview-notice" data-testid="cloud-legacy-sensitive" />
        <el-alert v-else-if="preview.hasRemote && preview.includeSensitive && !preview.remoteIncludesSensitive" :title="t('settings.cloud.remoteSettingsOnly')" type="info" :closable="false" show-icon class="drive-error drive-preview-notice" />
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="drive-error drive-preview-notice" />
        <el-alert v-if="preview.canUpload === false" :title="t('settings.cloud.restoreOnly')" type="warning" :closable="false" show-icon class="drive-error drive-preview-notice" :data-testid="`${kind}-restore-only`" />

        <ol v-if="preview.hasRemote && !identical && preview.canUpload !== false" class="drive-steps" :aria-label="t('settings.drive.stepsLabel')">
          <li :class="{'is-current': step === 'choose'}" :aria-current="step === 'choose' ? 'step' : undefined"><span>1</span>{{ t('settings.drive.chooseStep') }}</li>
          <li :class="{'is-current': step === 'review'}" :aria-current="step === 'review' ? 'step' : undefined"><span>2</span>{{ t('settings.drive.reviewStep') }}</li>
        </ol>

        <div v-if="!preview.hasRemote || identical" class="drive-summary drive-summary-positive">
          <el-icon><CircleCheck /></el-icon>
          <div><h3>{{ t(identical ? 'settings.drive.identicalTitle' : 'settings.drive.firstTitle') }}</h3><p>{{ t(identical ? 'settings.drive.identicalDescription' : 'settings.drive.firstDescription') }}</p></div>
        </div>
        <template v-else-if="step === 'choose'">
          <div class="drive-intent-heading"><h3>{{ t('settings.drive.chooseTitle') }}</h3><p>{{ t(preview.canUpload === false ? 'settings.drive.downloadDescription' : preview.hasBaseline ? 'settings.drive.returningDescription' : 'settings.drive.firstRestoreDescription') }}</p></div>
          <div class="drive-operation-list" role="radiogroup" :aria-label="t('settings.drive.chooseStep')">
            <label v-for="operation in ['download', 'upload'] as const" :key="operation" class="drive-operation" :class="{'is-selected': direction === operation, 'is-disabled': busy || operation === 'upload' && preview.canUpload === false}">
              <input v-model="direction" type="radio" name="drive-operation" :value="operation" :disabled="busy || operation === 'upload' && preview.canUpload === false" :data-testid="`${kind}-direction-${operation}`" />
              <span><strong>{{ t(`settings.drive.${operation}Title`) }}</strong><span>{{ t(`settings.drive.${operation}Description`) }}</span></span>
            </label>
          </div>
          <div v-if="preview.canUpload !== false" class="drive-advanced">
            <p>{{ t('settings.drive.mergeQuestion') }}</p>
            <el-button link :disabled="busy" :data-testid="`${kind}-direction-merge`" @click="selectMerge"><el-icon><Switch /></el-icon>{{ t('settings.drive.mergeReviewTitle') }}<el-icon><ArrowRight /></el-icon></el-button>
          </div>
        </template>
        <template v-else>
            <div class="drive-review-title">
              <span class="drive-review-icon"><el-icon><component :is="direction === 'merge' ? Switch : direction === 'download' ? Download : Upload" /></el-icon></span>
              <div><h3>{{ t(direction === 'merge' ? 'settings.drive.mergeReviewTitle' : `settings.drive.${direction}Title`) }}</h3><p>{{ t('settings.drive.differenceCount', {count: preview.changes.length}) }}</p></div>
            </div>
            <div v-if="direction !== 'merge'" class="drive-transfer" :aria-label="t(`settings.drive.${direction}Title`)">
              <span><el-icon><component :is="direction === 'download' ? Cloudy : Monitor" /></el-icon><strong>{{ t(direction === 'download' ? 'settings.drive.cloudLabel' : 'settings.drive.deviceLabel') }}</strong></span>
              <el-icon class="drive-transfer-arrow"><ArrowRight /></el-icon>
              <span><el-icon><component :is="direction === 'download' ? Monitor : Cloudy" /></el-icon><strong>{{ t(direction === 'download' ? 'settings.drive.deviceLabel' : 'settings.drive.cloudLabel') }}</strong></span>
            </div>
            <p class="drive-impact" :class="{'drive-impact-warning': direction !== 'merge'}"><el-icon v-if="direction !== 'merge'"><Warning /></el-icon>{{ directionHint }}</p>
            <div v-if="direction === 'merge' && conflictRows.length" class="drive-review-heading">
              <div><h3>{{ t('settings.drive.reviewConflicts') }}</h3><p>{{ t('settings.drive.remaining', {count: unresolved}) }}</p></div>
              <div class="drive-bulk-actions">
                <el-button size="small" :disabled="busy" @click="chooseAll('local')">{{ t('settings.drive.keepAllLocal') }}</el-button>
                <el-button size="small" :disabled="busy" @click="chooseAll('remote')">{{ t('settings.drive.keepAllRemote') }}</el-button>
              </div>
            </div>
            <p v-else-if="direction === 'merge'" class="drive-merge-ready"><el-icon><CircleCheck /></el-icon>{{ summaryTitle }}</p>
            <button v-if="direction !== 'merge'" type="button" class="drive-details-toggle" :aria-expanded="detailsVisible" @click="toggleDetails"><span>{{ t(detailsVisible ? 'settings.drive.hideDetails' : 'settings.drive.showDetails', {count: preview.changes.length}) }}</span><el-icon><component :is="detailsVisible ? ArrowUp : ArrowDown" /></el-icon></button>
            <button v-else-if="automaticRows.length" type="button" class="drive-details-toggle" :aria-expanded="automaticVisible" @click="toggleAutomatic"><span>{{ t(automaticVisible ? 'settings.drive.hideAutomatic' : 'settings.drive.showAutomatic', {count: automaticCount}) }}</span><el-icon><component :is="automaticVisible ? ArrowUp : ArrowDown" /></el-icon></button>
            <template v-if="direction === 'merge' ? activeRows.length > 0 : detailsVisible">
              <p class="drive-private-hint">{{ t('settings.drive.privateHint') }}</p>
              <div class="drive-differences" :data-testid="`${kind}-differences`">
                <article v-for="row in visibleRows" :key="row.id" class="drive-change" :data-change-id="row.id">
                  <div class="drive-change-heading"><strong>{{ row.label === '私密或自定义设置' ? t('settings.drive.otherSettings') : translateLegacy(row.label) }}</strong>
                    <span v-if="direction === 'merge'" :class="{'is-pending': !rowChoice(row)}">{{ t(rowChoice(row) ? (rowChoice(row) === 'local' ? 'settings.drive.localSelected' : 'settings.drive.remoteSelected') : 'settings.drive.needsChoice') }}</span>
                  </div>
                  <p v-if="row.changes.some(change => change.details?.length)" class="drive-change-details">{{ [...new Set(row.changes.flatMap(change => change.details ?? []))].map(key => t(key)).join(' · ') }}</p>
                  <div class="drive-values" :role="direction === 'merge' ? 'radiogroup' : undefined" :aria-label="direction === 'merge' ? t('settings.drive.choice', {label: row.label === '私密或自定义设置' ? t('settings.drive.otherSettings') : translateLegacy(row.label)}) : undefined">
                    <component :is="direction === 'merge' ? 'label' : 'div'" v-for="source in ['local', 'remote'] as const" :key="source" class="drive-value" :class="{'is-selected': direction === 'merge' ? rowChoice(row) === source : direction === (source === 'local' ? 'upload' : 'download')}">
                      <input v-if="direction === 'merge'" type="radio" :name="`drive-choice-${row.id}`" :checked="rowChoice(row) === source" :disabled="busy" :value="source" @change="chooseRow(row, source)" />
                      <span><strong>{{ t(source === 'local' ? 'settings.drive.deviceLabel' : 'settings.drive.cloudLabel') }}</strong><span>{{ row.changes.length === 1 ? previewValueLabel(row.changes[0][source]) : t('settings.drive.groupedContent', {count: row.changes.length}) }}</span></span>
                    </component>
                  </div>
                </article>
              </div>
              <el-pagination v-if="activeRows.length > 20" v-model:current-page="page" :page-size="20" :total="activeRows.length" layout="prev, pager, next" />
            </template>
        </template>
      </template>
      <template #footer>
        <p v-if="step === 'review' && direction === 'merge' && unresolved" class="drive-footer-hint" role="status">{{ t('settings.drive.remaining', {count: unresolved}) }}</p>
        <div class="drive-footer-row">
          <el-button v-if="step === 'review' && preview?.hasRemote && !identical && preview.canUpload !== false" link :disabled="busy" :data-testid="`${kind}-back`" @click="backToChoose"><el-icon><ArrowLeft /></el-icon>{{ t('settings.drive.back') }}</el-button>
          <div class="drive-footer-actions"><el-button :disabled="busy" @click="cancelPreview">{{ t('settings.drive.cancelSync') }}</el-button><el-button v-if="step === 'choose'" type="primary" :disabled="busy || !direction" :data-testid="`${kind}-continue`" @click="step = 'review'">{{ t('settings.drive.continue') }}</el-button><el-button v-else type="primary" :loading="busy && !switchingAccount" :disabled="busy || !canCommit" :data-testid="`${kind}-confirm`" @click="commit">{{ commitLabel }}</el-button></div>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import {ElAlert, ElIcon, ElInput, ElMessage, ElPagination, ElSwitch} from 'element-plus';
import {ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleCheck, Cloudy, Delete, Download, Monitor, Switch, Upload, User, Warning} from '@element-plus/icons-vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/switch/style/css';
import {useUiI18n} from '@/src/ui/i18n';
import {CloudBackupRequestError, type createCloudBackupClient} from '@/src/services/config/cloudBackupClient';
import {chooseDriveRow, driveRowChoice, groupDrivePreviewChanges, initialDriveDirection, localizeDrivePreviewLanguage, unresolvedDriveChanges, type DrivePreviewRow} from '../model/googleDrivePreview';
import type {DriveChoice} from '@/src/core/config/driveSync';
import type {DriveSyncDirection, DriveSyncPreview, DriveSyncStatus} from '@/src/services/config/googleDriveSync';
import type {CloudBackupDeletePreview} from '@/src/services/config/remoteConfigSync';

const props = defineProps<{client: Pick<ReturnType<typeof createCloudBackupClient>, 'status' | 'prepare' | 'commit' | 'cancel' | 'prepareDelete' | 'commitDelete'>; provider: string; kind: 'google-drive' | 'webdav'}>();
const emit = defineEmits<{busy: [value: boolean]}>();
const {t: baseT, translateLegacy, language} = useUiI18n();
const client = props.client;
const mapping: Record<string, string> = {'settings.drive.downloadDescription': 'settings.cloud.downloadDescription', 'settings.drive.uploadDescription': 'settings.cloud.uploadDescription', 'settings.drive.firstTitle': 'settings.cloud.firstTitle', 'settings.drive.selectedAccount': 'settings.cloud.selectedAccount'};
function t(key: string, params?: Record<string, string | number>) {return baseT(mapping[key] ?? key, {...params, provider: props.provider});}

const status = ref<DriveSyncStatus | null>(null);
const busy = ref(false);
const includeSensitive = ref(false);
const consentVisible = ref(false);
const riskAcknowledged = ref(false);
const switchingAccount = ref(false);
const error = ref('');
const preview = ref<DriveSyncPreview | null>(null);
const previewVisible = ref(false);
const deletion = ref<CloudBackupDeletePreview | null>(null);
const deleteVisible = ref(false);
const deleteDetailsVisible = ref(false);
const deleteConfirmation = ref('');
const canConfirmDeletion = computed(() => Boolean(deleteVisible.value && deletion.value?.canDelete && (!deletion.value.hasRemote || deleteConfirmation.value === t('settings.cloud.deletePhrase'))));
watch(() => busy.value || consentVisible.value || previewVisible.value || deleteVisible.value, value => emit('busy', value));
const direction = ref<DriveSyncDirection | ''>('');
const step = ref<'choose' | 'review'>('review');
const choices = ref<Record<string, string>>({});
const page = ref(1);
const detailsVisible = ref(false);
const automaticVisible = ref(false);
const identical = computed(() => Boolean(preview.value?.hasRemote && !preview.value.changes.length && preview.value.includeSensitive === preview.value.remoteIncludesSensitive));
const rows = computed(() => groupDrivePreviewChanges(preview.value?.changes ?? []));
const conflictRows = computed(() => rows.value.filter(row => !row.recommended));
const automaticRows = computed(() => rows.value.filter(row => row.recommended));
const automaticCount = computed(() => automaticRows.value.reduce((count, row) => count + row.changes.length, 0));
const activeRows = computed(() => direction.value === 'merge' ? [...conflictRows.value, ...(automaticVisible.value ? automaticRows.value : [])] : rows.value);
const visibleRows = computed(() => activeRows.value.slice((page.value - 1) * 20, page.value * 20));
const unresolved = computed(() => preview.value ? unresolvedDriveChanges(preview.value, choices.value) : 0);
const statusText = computed(() => !status.value ? translateLegacy('正在检查同步状态…') : !status.value.available ? translateLegacy(status.value.reason) : status.value.lastSyncedAt ? t('settings.drive.lastSync', {time: new Date(status.value.lastSyncedAt).toLocaleString(language.value)}) : '');
const directionHint = computed(() => direction.value === 'merge' && !preview.value?.hasBaseline ? t('settings.drive.firstMergeDescription') : direction.value ? t(`settings.drive.${direction.value}Description`) : '');
const summaryTitle = computed(() => t('settings.drive.mergeReady'));
const commitLabel = computed(() => t(identical.value ? 'settings.drive.finishSync' : direction.value ? `settings.drive.${direction.value}Action` : 'settings.drive.chooseAction'));
const canCommit = computed(() => Boolean(preview.value && direction.value && (preview.value.canUpload !== false || direction.value === 'download') && (direction.value !== 'merge' || unresolved.value === 0)));
watch(direction, () => {page.value = 1; detailsVisible.value = true; automaticVisible.value = true;});
function previewValueLabel(value: string) {return value === '开启' ? t('settings.drive.enabled') : value === '关闭' ? t('settings.drive.disabled') : translateLegacy(localizeDrivePreviewLanguage(value, language.value));}
function rowChoice(row: DrivePreviewRow) {return driveRowChoice(row, choices.value);}
function chooseRow(row: DrivePreviewRow, choice: DriveChoice) {choices.value = chooseDriveRow(row, choice, choices.value);}
function chooseAll(choice: DriveChoice) {for (const row of conflictRows.value) chooseRow(row, choice);}
function toggleDetails() {detailsVisible.value = !detailsVisible.value; page.value = 1;}
function toggleAutomatic() {automaticVisible.value = !automaticVisible.value; page.value = 1;}
function selectMerge() {direction.value = 'merge'; step.value = 'review';}
function backToChoose() {step.value = 'choose'; direction.value = '';}
let alive = true;
async function perform(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {await operation();} catch (failure) {if (alive) error.value = failure instanceof CloudBackupRequestError && failure.errorKey ? t(failure.errorKey, failure.params) : failure instanceof Error ? translateLegacy(failure.message) : translateLegacy('同步未完成，请重试');}
  finally {if (alive) busy.value = false;}
}
async function requestPreview() {
  const result = await client.prepare(includeSensitive.value);
  if (!alive) {await client.cancel(result.id); return;}
  preview.value = result;
  choices.value = Object.fromEntries(result.changes.filter(change => change.recommended).map(change => [change.id, change.recommended!]));
  direction.value = initialDriveDirection(result);
  if (result.hasRemote && result.canUpload !== false && result.includeSensitive !== result.remoteIncludesSensitive) direction.value = '';
  step.value = direction.value ? 'review' : 'choose';
  page.value = 1; detailsVisible.value = true; automaticVisible.value = true; previewVisible.value = true;
}
async function prepare() {await perform(async () => {try {await requestPreview();} catch (failure) {includeSensitive.value = false; throw failure;}});}
async function requestDeletion() {
  deleteConfirmation.value = '';
  const result = await client.prepareDelete();
  if (!alive) {await client.cancel(result.id); return;}
  deletion.value = result; deleteDetailsVisible.value = false; deleteVisible.value = true;
}
async function prepareDeletion() {
  if (previewVisible.value || consentVisible.value || deleteVisible.value) return;
  includeSensitive.value = false;
  await perform(requestDeletion);
}
async function changeDeletionAccount() {await perform(async () => {
  await client.cancel(deletion.value?.id);
  if (!alive) return;
  try {await requestDeletion();} catch (failure) {deleteVisible.value = false; throw failure;}
});}
async function confirmDeletion() {
  if (!canConfirmDeletion.value || !deletion.value) return;
  const id = deletion.value.id;
  await perform(async () => {
    try {
      const result = await client.commitDelete(id);
      if (alive) {status.value = result; ElMessage.success(t(result.deleted ? 'settings.cloud.deleteSuccess' : 'settings.cloud.deleteAbsent'));}
    } finally {if (alive) deleteVisible.value = false;}
  });
}
async function cancelDeletion() {await perform(async () => {await client.cancel(deletion.value?.id); deleteVisible.value = false;});}
function toggleSensitive(value: boolean | string | number) {
  if (busy.value || previewVisible.value || deleteVisible.value) return;
  if (value === true) {riskAcknowledged.value = false; consentVisible.value = true;}
  else includeSensitive.value = false;
}
function confirmSensitive() {
  if (!riskAcknowledged.value) return;
  includeSensitive.value = true; consentVisible.value = false;
}
async function switchAccount() {
  await perform(async () => {
    switchingAccount.value = true;
    try {
      await client.cancel(preview.value?.id);
      if (!alive) return;
      includeSensitive.value = false;
      try {await requestPreview();} catch (failure) {previewVisible.value = false; throw failure;}
    } finally {if (alive) switchingAccount.value = false;}
  });
}
async function commit() {
  if (step.value !== 'review' || !canCommit.value || !preview.value || !direction.value) return;
  const selected = {id: preview.value.id, direction: direction.value, choices: {...choices.value}};
  await perform(async () => {
    if (!alive) return;
    try {
      const result = await client.commit(selected.id, selected.direction, selected.choices);
      if (alive) {status.value = result; ElMessage.success(t('settings.cloud.syncComplete', {provider: props.provider}));}
    } finally {if (alive) previewVisible.value = false;}
  });
}
async function cancelPreview() {await perform(async () => {await client.cancel(preview.value?.id); previewVisible.value = false;});}
function clearPreview() {preview.value = null; choices.value = {}; direction.value = ''; includeSensitive.value = false;}
function endSession() {if (preview.value || deletion.value || busy.value) void client.cancel(preview.value?.id ?? deletion.value?.id).catch(() => undefined);}
async function refreshStatus() {await perform(async () => {
  try {status.value = await client.status();}
  catch (failure) {status.value = {available: false, reason: t('settings.cloud.unavailable'), account: null, lastSyncedAt: null}; throw failure;}
});}
defineExpose({refreshStatus});
onMounted(() => {void refreshStatus();});
onUnmounted(() => {alive = false; endSession(); clearPreview();});
</script>

<style scoped>
:global(.fluentread-cloud-sync-dialog) {display:flex; flex-direction:column; max-height:calc(100dvh - 32px); margin:16px auto;}
:global(.fluentread-cloud-sync-dialog .el-dialog__body) {overflow-y:auto; min-height:0; padding-top:8px; padding-bottom:24px;}
:global(.fluentread-cloud-sync-dialog .el-dialog__header), :global(.fluentread-cloud-sync-dialog .el-dialog__footer) {flex-shrink:0;}
:global(.fluentread-cloud-sync-dialog .el-dialog__title) {font-size:18px; font-weight:600;}
:global(.fluentread-cloud-sync-dialog .el-dialog__footer) {border-top:1px solid var(--el-border-color-lighter); padding-top:16px;}
:global(.fluentread-cloud-sync-dialog.cloud-compact-dialog .el-dialog__body) {padding-bottom:16px;}
.drive-sync {color:var(--el-text-color-primary);}
.cloud-scope {border:1px solid var(--el-border-color-lighter); border-radius:10px; padding:16px; background:var(--el-fill-color-blank);}
.cloud-scope-heading {display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; font-size:14px;}
.cloud-scope-heading>span {font-size:12px; padding:4px 8px; border-radius:6px; background:var(--el-color-success-light-9); color:var(--el-color-success-dark-2);}
.cloud-scope-heading>span.includes-sensitive {background:var(--el-color-warning-light-9); color:var(--el-color-warning-dark-2);}
.cloud-scope p,.cloud-preview-scope p {font-size:12px; line-height:1.7; color:var(--el-text-color-secondary); margin:8px 0 0;}
.cloud-sensitive-option {display:flex; gap:16px; align-items:center; margin-top:12px; padding-top:12px; border-top:1px solid var(--el-border-color-lighter);}
.cloud-sensitive-option>label {display:grid; gap:5px; flex:1; min-width:0; cursor:pointer;}
.cloud-sensitive-option strong {font-size:13px; font-weight:500;}
.cloud-sensitive-option label>span {font-size:12px; line-height:1.7; color:var(--el-text-color-secondary);}
.cloud-sensitive-option>.el-switch {flex-shrink:0;}
.cloud-scope .cloud-scope-note {margin-top:12px;}
.cloud-preview-scope {padding:12px 14px; margin-bottom:16px; border:1px solid var(--el-border-color-lighter); border-radius:8px; font-size:13px;}
.cloud-consent-intro {margin:0 0 14px; font-size:13px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-consent-risk {display:flex; align-items:flex-start; gap:8px; padding:12px; margin-bottom:16px; background:var(--el-fill-color-light); border-radius:8px;}
.cloud-consent-risk>.el-icon {color:var(--el-color-warning); font-size:16px; flex-shrink:0; margin-top:3px;}
.cloud-consent-risk p {margin:0; font-size:13px; line-height:1.7; color:var(--el-text-color-primary);}
.cloud-consent-checkbox {display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px; line-height:1.7;}
.cloud-consent-checkbox input {accent-color:var(--el-color-primary); margin:4px 0 0; flex-shrink:0;}
.cloud-consent-actions {display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px;}
.cloud-consent-actions>.el-button {margin:0; max-width:100%; height:auto; min-height:32px; white-space:normal; line-height:1.5;}
.cloud-delete-entry {display:flex; justify-content:flex-end; padding-top:12px; margin-top:12px; border-top:1px solid var(--el-border-color-lighter);}
.cloud-delete-entry .el-icon {margin-inline-end:5px;}
.cloud-delete-entry :deep(.el-button:not(.is-disabled)) {color:#b54444;}
:global(.dark) .cloud-delete-entry :deep(.el-button:not(.is-disabled)) {color:var(--el-color-danger);}
.cloud-delete-account {display:flex; align-items:flex-start; gap:12px; margin-bottom:14px;}
.cloud-delete-target {flex:1; min-width:0; font-size:13px; line-height:1.7; overflow-wrap:anywhere;}
.cloud-delete-target strong {display:block; font-weight:600; color:var(--el-text-color-primary);}
.cloud-delete-target :deep(p) {margin:2px 0 0; overflow-wrap:anywhere; font-size:12px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-delete-account>.el-button {flex-shrink:0; padding:0; min-height:22px; margin:0; font-size:12px; color:var(--el-text-color-regular);}
.cloud-delete-description {font-size:13px; line-height:1.7; margin:0; color:var(--el-text-color-primary);}
.cloud-delete-preserved {font-size:13px; line-height:1.7; color:var(--el-text-color-regular); margin:4px 0 0;}
.cloud-delete-details {font-size:12px; line-height:1.7; color:var(--el-text-color-regular); margin-top:8px;}
.cloud-delete-details>.el-button {padding:4px 0; min-height:28px; font-size:12px; font-weight:400; color:var(--el-text-color-regular);}
.cloud-delete-details>.el-button .el-icon {margin-inline-start:4px;}
.cloud-delete-details>.el-button:focus-visible {outline:2px solid var(--el-color-primary); outline-offset:3px;}
.cloud-delete-note {font-size:12px; line-height:1.7; color:var(--el-text-color-regular); margin:8px 0 0;}
.cloud-delete-verification {display:grid; gap:6px; margin-top:12px;}
.cloud-delete-verification label {font-size:12px; line-height:1.7; color:var(--el-text-color-regular);}
.drive-heading {display:flex; justify-content:space-between; align-items:flex-start; gap:16px;}
.drive-heading h2 {margin:0; font-size:19px;}
.drive-boundary {color:var(--el-text-color-secondary); font-size:13px; line-height:1.7;}
.drive-badge {display:inline-flex; align-items:center; gap:5px; flex-shrink:0; white-space:nowrap; border-radius:20px; padding:4px 10px; font-size:12px; color:var(--el-text-color-secondary); background:var(--el-fill-color-light);}
.drive-badge svg {width:15px; height:15px; flex-shrink:0; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round;}
.drive-record {display:grid; gap:4px; flex:1 1 240px; min-width:0; margin-inline-start:auto; text-align:right;}
.drive-record p {margin:0; overflow-wrap:anywhere; font-size:13px; line-height:1.5;}
.drive-status {color:var(--el-text-color-secondary);}
.drive-change-details {font-size:12px; line-height:1.7; margin:0 0 12px; color:var(--el-text-color-secondary);}
.drive-error,.drive-actions {margin-top:16px;}
.drive-preview-notice {margin:0 0 24px; align-items:flex-start;}
.drive-preview-notice :deep(.el-alert__content) {min-width:0;}
.drive-preview-notice :deep(.el-alert__title) {display:block; line-height:1.7; overflow-wrap:anywhere;}
.drive-preview-notice :deep(.el-alert__icon) {margin-top:2px; flex-shrink:0;}
.drive-actions {display:flex; flex-wrap:wrap; align-items:center; gap:12px 20px;}
.drive-actions>.el-button {flex-shrink:0; max-width:100%; min-height:32px; height:auto; white-space:normal; line-height:1.5; padding:8px 15px;}
.drive-account-bar {display:flex; align-items:center; gap:10px; border-radius:8px; background:var(--el-fill-color-light); padding:12px; margin-bottom:24px;}
.drive-account-icon {font-size:18px; color:var(--el-text-color-secondary); flex-shrink:0;}
.drive-account-bar p {margin:0; flex:1; font-size:12px; color:var(--el-text-color-regular); overflow-wrap:anywhere;}
.drive-account-bar .el-button {flex-shrink:0; font-size:12px; color:var(--el-text-color-secondary);}
.drive-steps {display:flex; gap:24px; list-style:none; padding:0 0 16px; margin:0 0 24px; border-bottom:1px solid var(--el-border-color-lighter);}
.drive-steps li {display:flex; align-items:center; gap:8px; font-size:12px; color:var(--el-text-color-secondary);}
.drive-steps li>span {display:grid; place-items:center; width:22px; height:22px; border-radius:50%; border:1px solid var(--el-border-color);}
.drive-steps li.is-current {color:var(--el-text-color-primary); font-weight:600;}
.drive-steps li.is-current>span {background:var(--el-color-primary); border-color:var(--el-color-primary); color:var(--el-color-white);}
.drive-intent-heading h3,.drive-review-title h3 {margin:0; font-size:20px; font-weight:600; color:var(--el-text-color-primary);}
.drive-intent-heading p,.drive-review-title p {margin:8px 0 0; font-size:13px; line-height:1.6; color:var(--el-text-color-secondary);}
.drive-operation-list {border:1px solid var(--el-border-color); border-radius:10px; overflow:hidden; margin-top:20px;}
.drive-operation {display:flex; align-items:flex-start; gap:12px; cursor:pointer; padding:20px; background:var(--el-bg-color);}
.drive-operation+.drive-operation {border-top:1px solid var(--el-border-color-lighter);}
.drive-operation>span {display:grid; gap:7px; min-width:0; flex:1;}
.drive-operation strong {color:var(--el-text-color-primary); font-size:15px; font-weight:600;}
.drive-operation span span {color:var(--el-text-color-secondary); font-size:13px; line-height:1.6;}
.drive-operation input {accent-color:var(--el-color-primary); margin:4px 0 0; flex-shrink:0;}
.drive-operation.is-selected {background:var(--el-color-primary-light-9);}
.drive-operation:focus-within {outline:2px solid var(--el-color-primary); outline-offset:-2px;}
.drive-advanced {display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; border-top:1px solid var(--el-border-color-lighter); padding-top:16px; margin-top:24px;}
.drive-advanced p {margin:0; color:var(--el-text-color-secondary); font-size:12px;}
.drive-advanced .el-button {color:var(--el-text-color-regular); font-size:13px;}
.drive-advanced .el-icon {margin:0 5px;}
.drive-review-title {display:flex; align-items:center; gap:14px; margin-bottom:20px;}
.drive-review-icon {display:grid; place-items:center; width:44px; height:44px; border-radius:12px; background:var(--el-color-primary-light-9); color:var(--el-color-primary); font-size:24px; flex-shrink:0;}
.drive-transfer {display:flex; align-items:center; gap:16px; padding:20px; background:var(--el-fill-color-light); border:1px solid var(--el-border-color-lighter); border-radius:10px;}
.drive-transfer>span {display:flex; align-items:center; justify-content:center; gap:10px; flex:1; min-width:0;}
.drive-transfer>span>.el-icon {font-size:24px; color:var(--el-text-color-secondary); flex-shrink:0;}
.drive-transfer strong {font-size:13px; font-weight:500; color:var(--el-text-color-primary);}
.drive-transfer-arrow {font-size:22px; color:var(--el-text-color-secondary); flex-shrink:0;}
.drive-impact {display:flex; align-items:flex-start; gap:8px; margin:16px 0 24px; font-size:13px; line-height:1.7; color:var(--el-text-color-regular);}
.drive-impact-warning {padding:12px 14px; border:1px solid var(--el-color-warning-light-7); border-radius:8px; background:var(--el-color-warning-light-9);}
.drive-impact-warning>.el-icon {font-size:18px; color:var(--el-color-warning); margin-top:2px; flex-shrink:0;}
.drive-summary {display:flex; gap:12px; padding:20px; border-radius:10px; background:var(--el-fill-color-light); margin:20px 0 12px;}
.drive-summary h3 {margin:0; font-size:18px; color:var(--el-text-color-primary);}
.drive-summary p {margin:8px 0 0; font-size:13px; line-height:1.6; color:var(--el-text-color-secondary);}
.drive-summary-positive {background:var(--el-color-success-light-9);}
.drive-summary-positive>.el-icon {font-size:24px; color:var(--el-color-success); flex-shrink:0;}
.drive-review-heading {display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:1px solid var(--el-border-color-lighter); padding-top:20px; margin-top:20px;}
.drive-review-heading h3 {margin:0; font-size:15px; font-weight:600; color:var(--el-text-color-primary);}
.drive-review-heading p {margin:6px 0 0; font-size:13px; color:var(--el-text-color-secondary);}
.drive-bulk-actions {display:flex; flex-wrap:wrap; gap:6px;}
.drive-bulk-actions .el-button {margin:0;}
.drive-merge-ready {display:flex; align-items:center; gap:8px; padding:14px; font-size:13px; background:var(--el-color-success-light-9); border-radius:8px; color:var(--el-text-color-primary);}
.drive-merge-ready>.el-icon {font-size:18px; color:var(--el-color-success);}
.drive-details-toggle {display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; margin:16px 0 0; padding:14px; font:inherit; font-size:13px; text-align:left; line-height:1.5; color:var(--el-text-color-regular); background:var(--el-bg-color); border:1px solid var(--el-border-color); border-radius:8px; cursor:pointer;}
.drive-details-toggle:focus-visible {outline:2px solid var(--el-color-primary); outline-offset:2px;}
.drive-private-hint {font-size:12px; color:var(--el-text-color-secondary); line-height:1.6; margin:14px 0;}
.drive-differences {border:1px solid var(--el-border-color-lighter); border-radius:10px; overflow:hidden; margin-bottom:12px;}
.drive-change {padding:16px; border-bottom:1px solid var(--el-border-color-lighter);}
.drive-change:last-child {border-bottom:0;}
.drive-change-heading {display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:10px; font-size:13px;}
.drive-change-heading>span {font-size:12px; color:var(--el-color-success);}
.drive-change-heading>span.is-pending {color:var(--el-color-warning);}
.drive-values {display:grid; grid-template-columns:1fr 1fr; gap:10px; overflow-wrap:anywhere;}
.drive-value {display:flex; align-items:flex-start; gap:8px; border:1px solid var(--el-border-color-lighter); border-radius:8px; padding:12px; font-size:13px;}
.drive-value.is-selected {border-color:var(--el-color-primary); background:var(--el-color-primary-light-9);}
.drive-value:focus-within {outline:2px solid var(--el-color-primary); outline-offset:2px;}
label.drive-value {cursor:pointer;}
.drive-value input {accent-color:var(--el-color-primary); margin:3px 0; flex-shrink:0;}
.drive-value>span {display:grid; gap:5px; min-width:0;}
.drive-value strong {font-size:12px; color:var(--el-text-color-secondary); font-weight:500;}
.drive-value span span {line-height:1.5; color:var(--el-text-color-primary);}
.drive-footer-hint {margin:0 0 12px; color:var(--el-text-color-secondary); font-size:12px; text-align:left;}
.drive-footer-row {display:flex; align-items:center; justify-content:space-between; gap:16px;}
.drive-footer-row>.el-button {margin:0; color:var(--el-text-color-secondary); font-size:13px;}
.drive-footer-row>.el-button .el-icon {margin-right:5px;}
.drive-footer-actions {display:flex; justify-content:flex-end; gap:8px; margin-left:auto;}
.drive-footer-actions .el-button {margin:0; min-height:38px;}
.is-disabled {cursor:wait; opacity:.65;}
@media (max-width:600px) {
  .drive-heading {flex-wrap:wrap;}.drive-values {grid-template-columns:1fr;}
  .drive-actions {flex-direction:column; align-items:flex-start;}.drive-record {flex:none; width:100%; margin-inline-start:0; text-align:left;}
  .drive-operation {padding:16px;}.drive-review-heading {align-items:flex-start; flex-direction:column;}
  .drive-account-bar {align-items:flex-start;}.drive-account-icon {display:none;}.drive-review-title h3 {font-size:18px;}
  .drive-transfer {padding:16px 12px; gap:10px;}.drive-transfer>span {flex-direction:column; text-align:center; gap:6px;}
  .drive-footer-row {flex-wrap:wrap; gap:12px;}.drive-footer-row>.el-button {width:100%; justify-content:flex-start;}
  .drive-footer-actions {display:grid; grid-template-columns:1fr 1fr; width:100%;}
  .drive-footer-actions .el-button {height:auto; white-space:normal; line-height:1.5; padding:8px;}
  .drive-change {padding:12px;}.drive-steps {gap:16px;}
}
</style>
