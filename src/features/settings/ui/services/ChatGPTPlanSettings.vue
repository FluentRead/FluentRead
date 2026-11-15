<!--
 * @file src/features/settings/ui/services/ChatGPTPlanSettings.vue
 * 文件职责：仅为显式本机开发模式提供 ChatGPT 助手配对、账户授权和动态模型设置，公开构建不展示登录界面。
 * 主要内容：公开构建不渲染根节点、不调用助手且保留已有配置；开发模式先等待安全状态读取，再提供配对、取消授权、退出、用量管理和模型刷新，仅保存用户选择的模型 slug，账号变化隔离旧模型结果。
 * 模块边界：本组件不处理 OAuth URL 或令牌、不直接访问助手 HTTP、不定义套餐模型；授权及凭据属于后台与本机助手，隐藏、缓存停用、配置替换和卸载释放本地任务及计时器并取消未完成登录。
 -->
<template>
  <section v-if="chatGPTPlanDevelopmentEnabled" class="chatgpt-plan-settings" data-chatgpt-plan-settings>
    <p v-if="!statusResolved" class="chatgpt-plan-help" role="status" data-chatgpt-plan-loading>{{ text('loading') }}</p>
    <template v-else>
    <p class="chatgpt-plan-help" data-chatgpt-plan-eligibility>{{ text('eligibility') }}</p>
    <template v-if="!status.paired">
      <div class="chatgpt-plan-step">
        <strong>{{ text('helperTitle') }}</strong>
        <p class="chatgpt-plan-help">{{ text('helperHelp') }}</p>
        <code class="chatgpt-plan-command">node integrations/chatgpt-plan/cli.mjs</code>
        <a class="chatgpt-plan-guide" href="./chatgpt-plan-guide.html" target="_blank" rel="noreferrer">{{ text('setupGuide') }}</a>
      </div>
      <form class="chatgpt-plan-step" @submit.prevent="pair">
        <strong>{{ text('pairingTitle') }}</strong>
        <p class="chatgpt-plan-help">{{ text('pairingHelp') }}</p>
        <div class="chatgpt-plan-pairing-controls">
          <el-input v-model="pairingCode" type="password" show-password autocomplete="off" :aria-label="text('pairingCode')" :placeholder="text('pairingCode')" :disabled="!active || Boolean(busy)" data-chatgpt-plan-pair-code />
          <el-button native-type="submit" :disabled="!active || Boolean(busy)" data-chatgpt-plan-pair>{{ text(busy === 'pair' ? 'pairing' : 'pair') }}</el-button>
        </div>
      </form>
    </template>
    <div v-else class="chatgpt-plan-account">
      <div class="chatgpt-plan-status" :class="{'is-connected': ready}" role="status" aria-live="polite" data-chatgpt-plan-status>
        <span class="chatgpt-plan-status-dot" aria-hidden="true" />
        <strong>{{ text(statusUnavailable ? 'unavailableStatus' : status.connected ? 'connected' : 'disconnected') }}</strong>
        <small>{{ text('paired') }}</small>
      </div>
      <p v-if="status.account?.name || status.account?.email" class="chatgpt-plan-account-label" data-chatgpt-plan-account data-i18n-ignore>
        <span v-if="status.account?.name">{{ status.account.name }}</span><span v-if="status.account?.email">{{ status.account.email }}</span>
      </p>
      <p v-if="status.connected && !status.sharing" class="chatgpt-plan-error" role="status">{{ text('sharingDisabled') }}</p>
      <div class="chatgpt-plan-actions">
        <el-button v-if="!signInPending" :disabled="!active || Boolean(busy)" :type="status.connected ? 'default' : 'primary'" @click="signIn(false)" data-chatgpt-plan-sign-in>{{ text(status.connected ? 'reauthorize' : 'signIn') }}</el-button>
        <el-button v-if="!signInPending" :disabled="!active || Boolean(busy)" @click="signIn(true)" data-chatgpt-plan-switch-account>{{ text('switchAccount') }}</el-button>
        <el-button v-if="signInPending" :disabled="!active" @click="cancelSignIn" data-chatgpt-plan-cancel>{{ text('cancel') }}</el-button>
        <el-button v-if="status.connected" :disabled="!active || Boolean(busy)" @click="disconnect" data-chatgpt-plan-disconnect>{{ text('disconnect') }}</el-button>
        <el-button :disabled="!active || Boolean(busy)" @click="manageUsage" data-chatgpt-plan-usage>{{ text('usage') }}</el-button>
      </div>
      <p v-if="signInPending" class="chatgpt-plan-help" role="status" data-chatgpt-plan-waiting>{{ text('waiting') }}</p>
      <p v-else-if="!status.connected || !status.sharing" class="chatgpt-plan-help">{{ text('signInHelp') }}</p>
    </div>
    <div v-if="status.connected" class="chatgpt-plan-step chatgpt-plan-model">
      <div class="chatgpt-plan-model-heading"><strong>{{ text('model') }}</strong><el-button :disabled="!active || !ready || modelsLoading || Boolean(busy)" @click="refreshModels" data-chatgpt-plan-refresh-models>{{ text(modelsLoading ? 'loading' : 'refreshModels') }}</el-button></div>
      <el-select :model-value="config.model[services.chatgptPlan] || ''" :aria-label="text('model')" :placeholder="text('selectModel')" :disabled="!active || !ready || modelsLoading || Boolean(busy)" @update:model-value="selectModel" data-chatgpt-plan-model-select>
        <el-option v-for="model in models" :key="model.slug" :label="model.display_name" :value="model.slug" />
      </el-select>
      <p class="chatgpt-plan-help">{{ text('modelHelp') }}</p>
      <p v-if="ready && !modelsLoading && !models.length && !modelError" class="chatgpt-plan-help" role="status">{{ text('modelsEmpty') }}</p>
      <p v-if="savedModelUnavailable" class="chatgpt-plan-error" role="status" data-chatgpt-plan-model-unavailable>{{ text('modelUnavailable') }}</p>
      <p v-if="modelError" class="chatgpt-plan-error" role="status" data-chatgpt-plan-model-error>{{ errorText(modelError) }}</p>
    </div>
    <div v-if="feedback || panelError || status.error" class="chatgpt-plan-feedback" role="status" aria-live="polite" data-chatgpt-plan-feedback>
      <p :class="{'chatgpt-plan-error': Boolean(panelError || status.error)}">{{ panelError ? errorText(panelError) : status.error ? errorText(status.error) : text(feedback!) }}</p>
      <el-button v-if="panelError || status.error" :disabled="!active || statusLoading || Boolean(busy)" @click="refreshStatus" data-chatgpt-plan-retry>{{ text('retry') }}</el-button>
    </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode';
import {
    getChatGPTPlanStatus, pairChatGPTPlan, startChatGPTPlanSignIn, cancelChatGPTPlanSignIn,
    disconnectChatGPTPlan, listChatGPTPlanModels, openChatGPTPlanUsage,
} from '@/src/services/chatgpt-plan/client';
import {useUiI18n} from '@/src/ui/i18n';
import {chatGPTPlanErrorText, chatGPTPlanText} from '../../model/chatgptPlanMessages';
import {useSettingsActionContext} from '../../model/useSettingsActionContext';
import {waitForSettingsTask} from '../../model/taskWait';

interface PlanStatus {paired: boolean; connected: boolean; sharing: boolean; account?: {name?: string; email?: string}; authPending?: boolean; error?: string}
interface PlanModel {slug: string; display_name: string}
const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {language} = useUiI18n();
const text = (key: Parameters<typeof chatGPTPlanText>[0]) => chatGPTPlanText(key, language.value);
const errorText = (error: unknown) => chatGPTPlanErrorText(error, language.value);
const {active} = useSettingsActionContext(() => props.active && chatGPTPlanDevelopmentEnabled, () => [props.config]);
const emptyStatus = (): PlanStatus => ({paired: false, connected: false, sharing: false});
const status = ref<PlanStatus>(emptyStatus());
const statusResolved = ref(false);
const pairingCode = ref('');
const busy = ref<'' | 'pair' | 'signin' | 'cancel' | 'disconnect' | 'usage'>('');
const models = ref<PlanModel[]>([]);
const modelsLoading = ref(false), statusLoading = ref(false), statusUnavailable = ref(false);
const panelError = ref<unknown>(), modelError = ref<unknown>();
const feedback = ref<Parameters<typeof chatGPTPlanText>[0]>();
const signInPending = computed(() => busy.value === 'signin' || Boolean(status.value.authPending));
const ready = computed(() => status.value.connected && status.value.sharing && !statusUnavailable.value);
const savedModelUnavailable = computed(() => ready.value && !modelsLoading.value && !modelError.value && Boolean(props.config.model[services.chatgptPlan])
    && !models.value.some(model => model.slug === props.config.model[services.chatgptPlan]));
let generation = 0, statusRevision = 0, modelRevision = 0, accountIdentity = '';
let pollTimer: ReturnType<typeof setTimeout> | undefined, signInTimer: ReturnType<typeof setTimeout> | undefined;
let statusController: AbortController | undefined, modelController: AbortController | undefined, actionController: AbortController | undefined;

function ignoreCancellation(): void {
    if (!chatGPTPlanDevelopmentEnabled) return;
    try {void cancelChatGPTPlanSignIn().catch(() => undefined);} catch { /* 页面退出不能被已关闭的消息端口阻止。 */ }
}
function clearPoll(): void {if (pollTimer !== undefined) clearTimeout(pollTimer);pollTimer = undefined;}
function clearSignInDeadline(): void {if (signInTimer !== undefined) clearTimeout(signInTimer);signInTimer = undefined;}
function current(owner: number): boolean {return active.value && owner === generation;}
function pairingFailed(error: unknown): boolean {return error === 'pairing_failed' || Boolean(error && typeof error === 'object' && (error as {code?: unknown}).code === 'pairing_failed');}
function wait<T>(task: Promise<T>, controller: AbortController): Promise<T> {
    return waitForSettingsTask(task, controller.signal, 12_000, 'timeout');
}
function invalidate(): void {
    const cancelPending = signInPending.value;
    generation++;statusRevision++;modelRevision++;clearPoll();clearSignInDeadline();
    statusController?.abort();modelController?.abort();actionController?.abort();
    statusController = modelController = actionController = undefined;
    busy.value = '';statusLoading.value = false;modelsLoading.value = false;
    status.value = {...status.value, authPending: false};pairingCode.value = '';
    if (cancelPending) ignoreCancellation();
}
function schedulePoll(): void {
    clearPoll();
    if (active.value && status.value.paired) pollTimer = setTimeout(() => {pollTimer = undefined;void refreshStatus();}, signInPending.value ? 2_000 : 15_000);
}
function watchSignInDeadline(): void {
    if (!status.value.authPending) {clearSignInDeadline();return;}
    if (signInTimer !== undefined) return;
    const owner = generation;
    signInTimer = setTimeout(() => {
        signInTimer = undefined;if (!current(owner) || !signInPending.value) return;
        statusRevision++;statusController?.abort();actionController?.abort();actionController = undefined;
        busy.value = '';status.value = {...status.value, authPending: false};panelError.value = 'timeout';ignoreCancellation();schedulePoll();
    }, 300_000);
}
function applyStatus(next: PlanStatus): void {
    if (next.error === 'pairing_failed') next = {...emptyStatus(), error: next.error};
    status.value = next;statusUnavailable.value = false;
    const identity = next.connected ? JSON.stringify([next.account?.email ?? '', next.account?.name ?? '']) : '';
    if (identity !== accountIdentity || !next.connected || !next.sharing) {
        accountIdentity = identity;modelRevision++;modelController?.abort();modelController = undefined;
        models.value = [];modelsLoading.value = false;modelError.value = undefined;
        if (next.connected && next.sharing) void refreshModels();
    }
    if (!next.authPending && busy.value === 'signin') {busy.value = '';clearSignInDeadline();}
    watchSignInDeadline();
    schedulePoll();
}
async function refreshStatus(): Promise<void> {
    if (!active.value) return;
    clearPoll();statusController?.abort();
    const owner = generation, revision = ++statusRevision, controller = new AbortController();statusController = controller;statusLoading.value = true;
    try {
        const next = await wait(getChatGPTPlanStatus(), controller);
        if (!current(owner) || revision !== statusRevision) return;
        panelError.value = undefined;applyStatus(next);
    } catch (error) {
        if (current(owner) && revision === statusRevision) {
            if (pairingFailed(error)) applyStatus({...emptyStatus(), error: 'pairing_failed'});
            else statusUnavailable.value = true;
            panelError.value = error;
        }
    } finally {
        if (statusController === controller) {statusController = undefined;statusLoading.value = false;controller.abort();}
        if (current(owner) && revision === statusRevision) {statusResolved.value = true;schedulePoll();}
    }
}
async function refreshModels(): Promise<void> {
    if (!active.value || !ready.value || modelsLoading.value) return;
    const owner = generation, revision = ++modelRevision, identity = accountIdentity, controller = new AbortController();
    modelController = controller;modelsLoading.value = true;modelError.value = undefined;
    try {
        const result = await wait(listChatGPTPlanModels(), controller);
        if (!current(owner) || revision !== modelRevision || identity !== accountIdentity || !ready.value) return;
        models.value = result;
    } catch (error) {
        if (current(owner) && revision === modelRevision && identity === accountIdentity) {
            if (pairingFailed(error)) applyStatus({...emptyStatus(), error: 'pairing_failed'});
            else modelError.value = error;
        }
    } finally {
        if (modelController === controller) {modelController = undefined;modelsLoading.value = false;controller.abort();}
    }
}
function selectModel(value: unknown): void {
    if (!active.value || !ready.value || busy.value || modelsLoading.value || typeof value !== 'string' || !models.value.some(model => model.slug === value)) return;
    props.config.model[services.chatgptPlan] = value;
}
async function runAction(kind: Exclude<typeof busy.value, ''>, task: () => Promise<PlanStatus | void>): Promise<boolean> {
    if (!active.value || busy.value) return false;
    statusRevision++;statusController?.abort();statusController = undefined;statusLoading.value = false;clearPoll();
    const owner = generation, controller = new AbortController();actionController = controller;
    busy.value = kind;panelError.value = undefined;feedback.value = undefined;
    let succeeded = false;
    try {
        const result = await wait(task(), controller);
        if (current(owner) && actionController === controller) {
            if (result) applyStatus(result);
            succeeded = true;
        }
    } catch (error) {
        if (current(owner) && actionController === controller) {
            if (pairingFailed(error)) applyStatus({...emptyStatus(), error: 'pairing_failed'});
            panelError.value = error;
        }
    } finally {
        if (actionController === controller) {
            actionController = undefined;controller.abort();
            if (kind !== 'signin' || !succeeded || !status.value.authPending) busy.value = '';
            schedulePoll();
        }
    }
    return succeeded;
}
async function pair(): Promise<void> {
    if (!active.value || busy.value) return;
    const code = pairingCode.value.trim();
    if (!code) {feedback.value = 'pairRequired';panelError.value = undefined;return;}
    if (await runAction('pair', () => pairChatGPTPlan(code))) pairingCode.value = '';
}
async function signIn(newAccount = false): Promise<void> {
    if (!active.value || !status.value.paired || busy.value || signInPending.value) return;
    await runAction('signin', () => startChatGPTPlanSignIn(newAccount));
}
async function cancelSignIn(): Promise<void> {
    if (!active.value || !signInPending.value) return;
    clearSignInDeadline();clearPoll();statusRevision++;statusController?.abort();statusController = undefined;statusLoading.value = false;
    actionController?.abort();actionController = undefined;busy.value = 'cancel';status.value = {...status.value, authPending: false};
    feedback.value = 'cancelled';panelError.value = undefined;
    const owner = generation, controller = new AbortController();actionController = controller;
    try {
        const result = await wait(cancelChatGPTPlanSignIn(), controller);
        if (current(owner) && actionController === controller) applyStatus(result);
    } catch (error) {
        if (current(owner) && actionController === controller) {
            if (pairingFailed(error)) applyStatus({...emptyStatus(), error: 'pairing_failed'});
            panelError.value = error;
        }
    }
    finally {if (actionController === controller) {actionController = undefined;busy.value = '';controller.abort();schedulePoll();}}
}
async function disconnect(): Promise<void> {
    if (!active.value || busy.value) return;
    modelRevision++;modelController?.abort();modelController = undefined;modelsLoading.value = false;models.value = [];
    await runAction('disconnect', disconnectChatGPTPlan);
}
async function manageUsage(): Promise<void> {if (status.value.paired) await runAction('usage', openChatGPTPlanUsage);}
watch(() => [active.value, props.config] as const, () => {
    invalidate();feedback.value = undefined;panelError.value = undefined;modelError.value = undefined;status.value = emptyStatus();statusResolved.value = false;models.value = [];accountIdentity = '';
    if (active.value) void refreshStatus();
}, {immediate: true, flush: 'sync'});
onBeforeUnmount(invalidate);
</script>

<style scoped>
.chatgpt-plan-settings { display: grid; gap: 18px; min-width: 0; color: var(--ink, #172033); font-size: 13px; }
.chatgpt-plan-settings strong { font-weight: 600; }
.chatgpt-plan-help { margin: 0; color: var(--muted, #697386); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.chatgpt-plan-step { display: grid; gap: 8px; min-width: 0; }
.chatgpt-plan-step + .chatgpt-plan-step { padding-top: 18px; border-top: 1px solid var(--line, #e4e7ef); }
.chatgpt-plan-command { display: block; width: fit-content; max-width: 100%; padding: 9px 12px; border: 1px solid var(--line, #e4e7ef); border-radius: 8px; background: var(--surface-soft, #f6f8fc); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.chatgpt-plan-guide { width: fit-content; color: var(--brand-strong, #bd2853); font-size: 12px; }
.chatgpt-plan-pairing-controls { display: flex; align-items: center; gap: 8px; max-width: 480px; }
.chatgpt-plan-pairing-controls :deep(.el-input) { min-width: 0; flex: 1; }
.chatgpt-plan-account { display: grid; gap: 10px; }
.chatgpt-plan-account-label { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.chatgpt-plan-status { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.chatgpt-plan-status small { color: var(--muted, #697386); font-size: 11px; }
.chatgpt-plan-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted, #697386); flex: none; }
.chatgpt-plan-status.is-connected .chatgpt-plan-status-dot { background: var(--el-color-success, #47a369); }
.chatgpt-plan-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.chatgpt-plan-settings :deep(.el-button + .el-button) { margin-left: 0; }
.chatgpt-plan-model-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.chatgpt-plan-model :deep(.el-select) { width: 100%; max-width: 420px; }
.chatgpt-plan-feedback { display: flex; align-items: start; flex-wrap: wrap; gap: 8px; }
.chatgpt-plan-feedback p { flex: 1; min-width: 200px; margin: 0; font-size: 12px; line-height: 1.7; }
.chatgpt-plan-error { margin: 0; color: var(--el-color-danger, #d94e58); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.chatgpt-plan-guide:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
</style>
