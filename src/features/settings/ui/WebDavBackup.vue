<!--
@file src/features/settings/ui/WebDavBackup.vue
文件职责：在同步操作右侧统一显示账号、服务器、同步时间和修改连接入口，接入 WebDAV 配置云备份。
主要内容：应用密码输入、只读测试、测试后保存、多语言错误；同步或删除时刷新并核对连接摘要，密码不回显。
模块边界：只向可信后台发送连接参数，不直接请求 WebDAV；共用 RemoteConfigSync 的预览和确认流程。
-->
<template>
  <RemoteConfigSync ref="syncUi" :client="client" provider="WebDAV" kind="webdav" @busy="setSyncBusy">
    <template #delete-account>{{ connection?.username }}</template>
    <template #delete-location><p v-if="connection" data-testid="webdav-delete-server">{{ connection.url }}</p></template>
    <template #connection>
      <div v-if="!connection" class="webdav-connection">
        <div><strong>{{ t('settings.webdav.notConfigured') }}</strong><p>{{ t('settings.webdav.connectionHint') }}</p></div>
        <el-button :disabled="busy" data-testid="webdav-setup" @click="openSettings">{{ t('settings.webdav.setup') }}</el-button>
      </div>
      <el-alert v-if="error && !settingsVisible" :title="error" type="error" :closable="false" show-icon />
    </template>
    <template #record="{status, statusText}">
      <div v-if="connection" class="webdav-record" role="status">
        <div class="webdav-record-heading"><p data-testid="webdav-account">{{ t('settings.cloud.currentAccount', {email: connection.username}) }}</p><el-button link :disabled="busy" data-testid="webdav-setup" @click="openSettings">{{ t('settings.webdav.editConnection') }}</el-button></div>
        <p class="webdav-record-secondary" data-testid="webdav-server">{{ connection.url }}</p>
        <p v-if="status?.account?.id === `webdav:${connection.revision}` && status.lastSyncedAt" class="webdav-record-secondary">{{ statusText }}</p>
      </div>
    </template>
  </RemoteConfigSync>
  <el-dialog v-model="settingsVisible" :title="t('settings.webdav.connectionTitle')" class="webdav-settings-dialog fluentread-webdav-connection-dialog" width="min(540px, calc(100vw - 24px))" :close-on-click-modal="!settingsBusy" :close-on-press-escape="!settingsBusy" :show-close="!settingsBusy" destroy-on-close @closed="draft.password = ''">
    <form id="webdav-connection-form" class="webdav-form" @submit.prevent="save">
      <label for="webdav-url">{{ t('settings.webdav.url') }}</label><el-input id="webdav-url" v-model="draft.url" placeholder="https://cloud.example.com/dav/" :disabled="settingsBusy" :maxlength="4096" autocomplete="off" />
      <label for="webdav-username">{{ t('settings.webdav.username') }}</label><el-input id="webdav-username" v-model="draft.username" :disabled="settingsBusy" :maxlength="512" autocomplete="off" />
      <label for="webdav-password">{{ t('settings.webdav.password') }}</label><el-input id="webdav-password" v-model="draft.password" type="password" show-password :placeholder="canKeepPassword ? t('settings.webdav.passwordSaved') : t('settings.webdav.passwordHint')" :disabled="settingsBusy" :maxlength="4096" autocomplete="new-password" />
      <p class="webdav-hint">{{ t('settings.webdav.connectionHint') }} <a :href="guideUrl" target="_blank" rel="noopener noreferrer">{{ t('settings.webdav.openGuide') }}</a></p>
      <template v-if="insecure"><el-alert :title="t('settings.webdav.httpWarning')" type="warning" :closable="false" show-icon /><label class="webdav-http-consent"><input v-model="draft.allowInsecure" type="checkbox" :disabled="settingsBusy" /><span>{{ t('settings.webdav.httpConsent') }}</span></label></template>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-alert v-if="tested" :title="t('settings.webdav.testSuccess')" type="success" :closable="false" show-icon />
      <el-button v-if="connection" link type="danger" :disabled="settingsBusy" data-testid="webdav-clear" @click="clearConnection">{{ t('settings.webdav.clear') }}</el-button>
    </form>
    <template #footer><div class="webdav-footer"><el-button :disabled="settingsBusy" @click="settingsVisible = false">{{ t('settings.drive.cancelSync') }}</el-button><el-button :loading="settingsBusy && action === 'test'" :disabled="settingsBusy || !ready" data-testid="webdav-test" @click="test">{{ t('settings.webdav.test') }}</el-button><el-button type="primary" :loading="settingsBusy && action === 'save'" :disabled="settingsBusy || !ready" data-testid="webdav-save" @click="save">{{ t('settings.webdav.save') }}</el-button></div></template>
  </el-dialog>
</template>
<script setup lang="ts">
import {computed, onUnmounted, reactive, ref, watch} from 'vue';
import {ElAlert, ElMessage, ElMessageBox} from 'element-plus';
import 'element-plus/es/components/alert/style/css';
import {useUiI18n} from '@/src/ui/i18n';
import {webDavBackupClient as connectionClient} from '@/src/services/config/webDavBackupClient';
import {CloudBackupRequestError} from '@/src/services/config/cloudBackupClient';
import type {WebDavConnectionSummary} from '@/src/platform/webdav/connection';
import RemoteConfigSync from './RemoteConfigSync.vue';
const emit = defineEmits<{busy: [value: boolean]}>();
const {t, translateLegacy, language} = useUiI18n();
const connection = ref<WebDavConnectionSummary | null>(null);
const settingsVisible = ref(false);
const settingsBusy = ref(false);
const syncBusy = ref(false);
const busy = computed(() => settingsBusy.value || syncBusy.value);
watch(busy, value => emit('busy', value));
const syncUi = ref<InstanceType<typeof RemoteConfigSync>>();
const error = ref('');
const tested = ref(false);
const action = ref('');
let alive = true;
onUnmounted(() => {alive = false; draft.password = '';});
async function refreshConnection() {
  const saved = await connectionClient.settings();
  if (alive) connection.value = saved;
  return saved;
}
const client = {
  ...connectionClient,
  async status() {
    const result = await connectionClient.status();
    await refreshConnection();
    return result;
  },
  async prepare(includeSensitive = false) {
    await refreshConnection();
    const result = await connectionClient.prepare(includeSensitive);
    try {
      const saved = await refreshConnection();
      if (!saved || result.account.id !== `webdav:${saved.revision}`) throw new CloudBackupRequestError('同步连接已变化，请重新生成预览', 'settings.cloud.connectionChanged');
      return result;
    } catch (failure) {
      await connectionClient.cancel(result.id).catch(() => undefined);
      throw failure;
    }
  },
  async prepareDelete() {
    await refreshConnection();
    const result = await connectionClient.prepareDelete();
    try {
      const saved = await refreshConnection();
      if (!saved || result.account.id !== `webdav:${saved.revision}`) throw new CloudBackupRequestError('同步连接已变化，请重新生成预览', 'settings.cloud.connectionChanged');
      return result;
    } catch (failure) {await connectionClient.cancel(result.id).catch(() => undefined); throw failure;}
  },
};
const draft = reactive({url: '', username: '', password: '', allowInsecure: false, revision: null as string | null});
const insecure = computed(() => /^http:\/\//iu.test(draft.url.trim()));
const canKeepPassword = computed(() => Boolean(connection.value?.hasPassword && draft.url.trim().replace(/\/+$/u, '') === connection.value.url.replace(/\/+$/u, '') && draft.username.trim() === connection.value.username));
const ready = computed(() => Boolean(draft.url.trim() && draft.username.trim() && (draft.password || canKeepPassword.value) && (!insecure.value || draft.allowInsecure)));
const guideUrl = computed(() => `https://read.thinkstu.com/${language.value === 'zh-CN' ? '' : 'en/'}guide/webdav`);
watch(draft, () => {tested.value = false;});
function setSyncBusy(value: boolean) {syncBusy.value = value;}
async function perform(nextAction: string, operation: () => Promise<void>) {
  if (settingsBusy.value) return;
  settingsBusy.value = true; action.value = nextAction; error.value = '';
  try {await operation();} catch (failure) {if (!alive) return; error.value = failure instanceof CloudBackupRequestError && failure.errorKey ? t(failure.errorKey, failure.params) : failure instanceof Error ? translateLegacy(failure.message) : t('settings.webdav.error.failure');}
  finally {settingsBusy.value = false; action.value = '';}
}
async function openSettings() {
  if (busy.value) return;
  await perform('load', async () => {
    const saved = await client.settings();
    if (!alive) return;
    connection.value = saved;
    Object.assign(draft, {url: connection.value?.url ?? '', username: connection.value?.username ?? '', password: '', allowInsecure: connection.value?.allowInsecure ?? false, revision: connection.value?.revision ?? null});
    tested.value = false; settingsVisible.value = true;
  });
}
async function test() {if (ready.value) await perform('test', async () => {await client.test({...draft}); tested.value = true;});}
async function save() {if (ready.value) await perform('save', async () => {
  connection.value = await client.save({...draft}); draft.password = ''; settingsVisible.value = false;
  await syncUi.value?.refreshStatus(); if (alive) ElMessage.success(t('settings.webdav.saveSuccess'));
});}
async function clearConnection() {
  try {await ElMessageBox.confirm(t('settings.webdav.clearDescription'), t('settings.webdav.clear'), {confirmButtonText: t('settings.webdav.clear'), cancelButtonText: t('settings.drive.cancelSync'), type: 'warning'});} catch {return;}
  await perform('clear', async () => {await client.clear(connection.value?.revision ?? null); connection.value = null; draft.password = ''; settingsVisible.value = false; await syncUi.value?.refreshStatus(); if (alive) ElMessage.success(t('settings.webdav.cleared'));});
}
</script>
<style scoped>
.webdav-connection {display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:16px;}
.webdav-connection>div {min-width:0;}
.webdav-connection strong {font-size:14px; font-weight:500; overflow-wrap:anywhere;}
.webdav-connection p {color:var(--el-text-color-secondary); font-size:12px; line-height:1.6; margin:5px 0 0; overflow-wrap:anywhere;}
.webdav-connection>.el-button {flex-shrink:0;}
.webdav-record {flex:1 1 280px; min-width:0; margin-inline-start:auto; text-align:right;}
.webdav-record p {margin:0; font-size:13px; line-height:1.6; overflow-wrap:anywhere;}
.webdav-record-heading {display:flex; justify-content:flex-end; align-items:center; gap:12px;}
.webdav-record-heading>.el-button {flex-shrink:0; margin:0; font-size:12px; color:var(--el-text-color-secondary);}
.webdav-record-secondary {color:var(--el-text-color-secondary);}
.webdav-form {display:grid; gap:10px;}
.webdav-form>label {font-size:13px; margin-top:8px; color:var(--el-text-color-primary);}
.webdav-hint {font-size:12px; line-height:1.6; color:var(--el-text-color-secondary); margin:2px 0 8px;}
.webdav-hint a {color:var(--el-color-primary);}
.webdav-http-consent {display:flex; gap:8px; align-items:flex-start; font-size:12px; line-height:1.6;}
.webdav-http-consent input {margin:3px 0 0; accent-color:var(--el-color-primary);}
.webdav-form>.el-button {justify-self:start; margin-top:12px;}
.webdav-footer {display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;}
.webdav-footer .el-button {margin:0;}
:global(.fluentread-webdav-connection-dialog) {display:flex; flex-direction:column; max-height:calc(100dvh - 32px); margin:16px auto;}
:global(.fluentread-webdav-connection-dialog .el-dialog__body) {min-height:0; overflow-y:auto;}
:global(.fluentread-webdav-connection-dialog .el-dialog__footer) {border-top:1px solid var(--el-border-color-lighter);}
@media(max-width:600px) {.webdav-record {flex:none; width:100%; margin-inline-start:0; text-align:left;}.webdav-record-heading {justify-content:space-between; align-items:flex-start;}.webdav-connection {align-items:flex-start; flex-direction:column;}.webdav-footer {display:grid; grid-template-columns:1fr 1fr;}.webdav-footer>.el-button:last-child {grid-column:1 / -1;}.webdav-footer .el-button {height:auto; min-height:34px; white-space:normal; line-height:1.5;}}
</style>
