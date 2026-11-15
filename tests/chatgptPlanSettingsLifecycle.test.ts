/**
 * @file tests/chatgptPlanSettingsLifecycle.test.ts
 * 文件职责：执行 ChatGPT 设置的真实 Vue 模板，验证公开构建完全不展示登录界面，开发模式维持授权和模型操作的生命周期归属。
 * 主要内容：仅控制构建模式、后台服务端口和第三方输入控件，覆盖公开模式无根节点、无任何助手操作且保留配置，开发模式状态加载、取消、账号切换迟到结果、停用和七语言反馈。
 * 模块边界：不替换组件业务实现，不使用真实账号或凭据；这些确定性测试不证明 OpenAI 授权、套餐资格或在线推理可用。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window} = parseHTML('<html><body></body></html>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    // Vue devtools discovery is a host concern; provide its inert hook instead of a 3-second discovery timer.
    (window as any).__VUE_DEVTOOLS_GLOBAL_HOOK__ = {emit() {}};
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() {return [...this.querySelectorAll('option')].find(option => option.selected)?.value || '';},
        set(value) {for (const option of this.querySelectorAll('option')) option.selected = option.value === String(value);},
    });
});
const ports = vi.hoisted(() => ({status: vi.fn(), pair: vi.fn(), signIn: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), models: vi.fn(), usage: vi.fn(), locale: 'zh-CN', development: true}));
vi.mock('@/src/platform/chatgpt-plan/buildMode', () => ({get chatGPTPlanDevelopmentEnabled() {return ports.development;}}));
vi.mock('@/src/services/chatgpt-plan/client', () => ({
    getChatGPTPlanStatus: ports.status, pairChatGPTPlan: ports.pair, startChatGPTPlanSignIn: ports.signIn,
    cancelChatGPTPlanSignIn: ports.cancel, disconnectChatGPTPlan: ports.disconnect,
    listChatGPTPlanModels: ports.models, openChatGPTPlanUsage: ports.usage,
}));
vi.mock('@/src/ui/i18n', async () => {
    const {ref} = await import('vue');
    return {useUiI18n: () => ({language: ref(ports.locale)})};
});
import {createApp, h, KeepAlive, nextTick, reactive, ref, type App, type SetupContext} from 'vue';
import {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {chatGPTPlanErrorText, chatGPTPlanMessages, chatGPTPlanText} from '@/src/features/settings/model/chatgptPlanMessages';
import type {UiLanguage} from '@/src/core/i18n';
import ChatGPTPlanSettings from '@/src/features/settings/ui/services/ChatGPTPlanSettings.vue';

interface PlanStatus {paired: boolean; connected: boolean; sharing: boolean; account?: {name?: string; email?: string}; authPending?: boolean; error?: string}
let helperStatus: PlanStatus, app: App | undefined, container: HTMLElement;
let props: {config: Config; active: boolean}, visible: ReturnType<typeof ref<boolean>>;
let state: Record<string, any>;
const disconnected = (): PlanStatus => ({paired: true, connected: false, sharing: false});
const connected = (email = 'reader@example.test'): PlanStatus => ({paired: true, connected: true, sharing: true, account: {name: 'Reader', email}});
const availableModels = [{slug: 'account-model-one', display_name: 'Account model one'}, {slug: 'account-model-two', display_name: 'Account model two'}];
const releases: (() => void)[] = [];
function pending<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});
    releases.push(() => resolve(undefined as T));return {promise, resolve, reject};
}
async function settle() {for (let i = 0; i < 20; i++) {await Promise.resolve();await nextTick();}}
function query(selector: string) {const element = container.querySelector<HTMLElement>(selector);expect(element, selector).not.toBeNull();return element!;}
async function click(selector: string) {query(selector).click();await settle();}
async function pairCode(value: string) {const input = query('[data-chatgpt-plan-pair-code]') as HTMLInputElement;input.value = value;input.dispatchEvent(new Event('input', {bubbles: true}));await settle();}
async function mount(savedModel = '') {
    const config = reactive(new Config());config.model[services.chatgptPlan] = savedModel;
    props = reactive({config, active: true});visible = ref(true);container = document.createElement('div');document.body.append(container);
    app = createApp({setup: () => () => h(KeepAlive, null, {default: () => visible.value
        ? h(ChatGPTPlanSettings, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}}) : h({render: () => h('div')}, {key: 'other'})})});
    // Third-party widgets are ports; component handlers, Vue updates and native DOM remain real.
    app.component('el-input', {props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup(p: {modelValue?: string; disabled?: boolean}, {emit, attrs}: SetupContext) {
        return () => h('input', {...attrs, value: p.modelValue, disabled: p.disabled, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)});
    }});
    app.component('el-button', {props: ['disabled', 'nativeType'], setup(p: {disabled?: boolean; nativeType?: string}, {slots, attrs}: SetupContext) {
        return () => h('button', {...attrs, type: p.nativeType || 'button', disabled: p.disabled}, slots.default?.());
    }});
    app.component('el-select', {props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup(p: {modelValue?: string; disabled?: boolean}, {slots, attrs, emit}: SetupContext) {
        return () => h('select', {...attrs, value: p.modelValue, disabled: p.disabled, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)}, slots.default?.());
    }});
    app.component('el-option', {props: ['value', 'label'], setup(p: {value?: string; label?: string}) {return () => h('option', {value: p.value}, p.label);}});
    app.mount(container);await settle();
}
beforeEach(() => {
    vi.useFakeTimers();vi.clearAllMocks();releases.length = 0;document.body.replaceChildren();ports.locale = 'zh-CN';ports.development = true;
    helperStatus = {paired: false, connected: false, sharing: false};
    ports.status.mockImplementation(async () => helperStatus);
    ports.pair.mockImplementation(async () => {helperStatus = disconnected();return helperStatus;});
    ports.signIn.mockImplementation(async () => {helperStatus = {...helperStatus, authPending: true};return helperStatus;});
    ports.cancel.mockImplementation(async () => {helperStatus = {...helperStatus, authPending: false};return helperStatus;});
    ports.disconnect.mockImplementation(async () => {helperStatus = disconnected();return helperStatus;});
    ports.models.mockResolvedValue(availableModels);ports.usage.mockResolvedValue(undefined);
});
afterEach(async () => {
    app?.unmount();app = undefined;for (const release of releases) release();await settle();
    expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();vi.restoreAllMocks();
});

describe('ChatGPT 套餐设置真实组件', () => {
    it.each(Object.keys(chatGPTPlanMessages))('公开%s不渲染任何界面，保留配置且不调用任何助手端口', async locale => {
        ports.development = false;ports.locale = locale;await mount('saved-account-model');
        props.config.service = services.chatgptPlan;props.config.documentModel[services.chatgptPlan] = 'saved-document-model';
        const saved = JSON.stringify(props.config);
        expect(container.textContent).toBe('');expect(container.childElementCount).toBe(0);
        expect(container.querySelector('[data-chatgpt-plan-settings], [data-chatgpt-plan-unavailable]')).toBeNull();
        state.pairingCode = 'fixture-pairing';state.status = {...connected(), authPending: true};
        await state.refreshStatus();await state.refreshModels();await state.pair();await state.signIn(false);await state.signIn(true);
        await state.cancelSignIn();await state.disconnect();await state.manageUsage();state.selectModel('account-model-two');
        props.active = false;await settle();props.active = true;await settle();await vi.advanceTimersByTimeAsync(300_000);await settle();
        for (const port of [ports.status, ports.pair, ports.signIn, ports.cancel, ports.disconnect, ports.models, ports.usage]) expect(port).not.toHaveBeenCalled();
        expect(JSON.stringify(props.config)).toBe(saved);expect(vi.getTimerCount()).toBe(0);
    });
    it('显式开发模式先等待初始连接状态，读取完成前不闪现配对或安装表单', async () => {
        const initial = pending<PlanStatus>();ports.status.mockReturnValueOnce(initial.promise);await mount('saved-account-model');
        expect(container.querySelector('[data-chatgpt-plan-loading]')).not.toBeNull();
        expect(container.querySelector('form, code, a, [data-chatgpt-plan-sign-in]')).toBeNull();
        initial.resolve(disconnected());await settle();
        expect(container.querySelector('[data-chatgpt-plan-loading]')).toBeNull();expect(container.querySelector('[data-chatgpt-plan-sign-in]')).not.toBeNull();
        expect(props.config.model[services.chatgptPlan]).toBe('saved-account-model');
    });
    it('首次使用说明本机助手与套餐资格，只配对助手，不把配对码当成 API Key', async () => {
        await mount();
        expect(container.textContent).toContain('ChatGPT Plus 或 Pro');expect(container.textContent).toContain('node integrations/chatgpt-plan/cli.mjs');
        expect(container.textContent).toContain('配对码不是 API Key');expect(ports.models).not.toHaveBeenCalled();expect(ports.signIn).not.toHaveBeenCalled();
        query('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();
        expect(ports.pair).not.toHaveBeenCalled();expect(container.textContent).toContain('请输入本机助手显示的配对码');
        await pairCode('  fixture-pairing  ');query('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();
        expect(ports.pair).toHaveBeenCalledWith('fixture-pairing');expect(container.querySelector('[data-chatgpt-plan-pair-code]')).toBeNull();
        expect(container.textContent).toContain('本机助手已配对');expect(query('[data-chatgpt-plan-sign-in]').textContent).toBe('Continue with ChatGPT');
    });
    it('授权完成后使用账户模型列表，刷新保留已保存选择，只有显式选择才保存slug', async () => {
        helperStatus = disconnected();await mount('previous-account-model');await click('[data-chatgpt-plan-sign-in]');
        expect(container.querySelector('[data-chatgpt-plan-waiting]')).not.toBeNull();expect(ports.models).not.toHaveBeenCalled();
        helperStatus = connected();await vi.advanceTimersByTimeAsync(2_000);await settle();
        expect(container.textContent).toContain('reader@example.test');expect(container.querySelector('[data-chatgpt-plan-waiting]')).toBeNull();expect(ports.models).toHaveBeenCalledOnce();
        expect(props.config.model[services.chatgptPlan]).toBe('previous-account-model');expect(container.querySelector('[data-chatgpt-plan-model-unavailable]')).not.toBeNull();
        const select = query('[data-chatgpt-plan-model-select]') as HTMLSelectElement;select.value = 'account-model-two';select.dispatchEvent(new Event('change', {bubbles: true}));await settle();
        expect(props.config.model[services.chatgptPlan]).toBe('account-model-two');expect(container.querySelector('[data-chatgpt-plan-model-unavailable]')).toBeNull();
        await click('[data-chatgpt-plan-refresh-models]');expect(props.config.model[services.chatgptPlan]).toBe('account-model-two');
        await click('[data-chatgpt-plan-usage]');expect(ports.usage).toHaveBeenCalledOnce();
    });
    it('取消立即关闭本地等待，取消端口完成前禁止重开授权，成功后可以重试', async () => {
        helperStatus = disconnected();await mount();await click('[data-chatgpt-plan-sign-in]');
        const cancellation = pending<PlanStatus>();ports.cancel.mockReturnValueOnce(cancellation.promise);
        await click('[data-chatgpt-plan-cancel]');
        expect(container.querySelector('[data-chatgpt-plan-waiting]')).toBeNull();expect(container.textContent).toContain('已取消登录');
        expect((query('[data-chatgpt-plan-sign-in]') as HTMLButtonElement).disabled).toBe(true);
        cancellation.resolve(disconnected());await settle();expect((query('[data-chatgpt-plan-sign-in]') as HTMLButtonElement).disabled).toBe(false);
        await click('[data-chatgpt-plan-sign-in]');expect(ports.signIn).toHaveBeenCalledTimes(2);
    });
    it.each(['hidden', 'cached', 'config', 'unmount'])('%s 取消登录并释放轮询，迟到状态不能复活旧等待', async reason => {
        helperStatus = disconnected();await mount();await click('[data-chatgpt-plan-sign-in]');
        const waiting = pending<PlanStatus>();ports.status.mockReturnValueOnce(waiting.promise);await vi.advanceTimersByTimeAsync(2_000);await settle();
        if (reason === 'hidden') props.active = false;
        if (reason === 'cached') visible.value = false;
        if (reason === 'config') {props.config = reactive(new Config());props.active = false;}
        if (reason === 'unmount') {app?.unmount();app = undefined;}
        await settle();expect(ports.cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
        waiting.resolve(connected());await settle();expect(ports.models).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('账号切换隔离上一账号迟到的模型，退出保留已保存选择并清空账户', async () => {
        helperStatus = connected('first@example.test');const first = pending<typeof availableModels>();ports.models.mockReturnValueOnce(first.promise);
        await mount('saved-model');helperStatus = connected('second@example.test');await state.refreshStatus();await settle();
        expect(ports.models).toHaveBeenCalledTimes(2);expect(container.textContent).toContain('second@example.test');
        first.resolve([{slug: 'old-account-only', display_name: 'Old account only'}]);await settle();
        expect(container.textContent).not.toContain('Old account only');expect(container.textContent).toContain('Account model one');
        await click('[data-chatgpt-plan-disconnect]');expect(ports.disconnect).toHaveBeenCalledOnce();expect(props.config.model[services.chatgptPlan]).toBe('saved-model');
        expect(container.querySelector('[data-chatgpt-plan-model-select]')).toBeNull();expect(container.querySelector('[data-chatgpt-plan-account]')).toBeNull();
        expect(container.textContent).toContain('本机助手已配对');
    });
    it('模型失败可刷新重试，共享关闭禁用模型并给出恢复入口', async () => {
        helperStatus = connected();ports.models.mockRejectedValueOnce(Object.assign(new Error('sensitive raw response'), {code: 'quota_exceeded'}));await mount();
        expect(container.textContent).toContain('套餐额度已用尽');expect(container.textContent).not.toContain('sensitive raw response');
        await click('[data-chatgpt-plan-refresh-models]');expect(container.querySelector('[data-chatgpt-plan-model-error]')).toBeNull();
        helperStatus = {...connected(), sharing: false};await vi.advanceTimersByTimeAsync(15_000);await settle();
        expect(container.textContent).toContain('套餐共享已关闭');expect((query('[data-chatgpt-plan-model-select]') as HTMLSelectElement).disabled).toBe(true);
        expect(container.querySelector('[data-chatgpt-plan-sign-in]')).not.toBeNull();
    });
    it('助手不可用和未知失败提供安全可重试提示，不透传原始错误', async () => {
        await mount();ports.pair.mockRejectedValueOnce(Object.assign(new Error('secret-value-do-not-display'), {code: 'helper_unavailable'}));
        await pairCode('fixture');query('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();
        expect(container.textContent).toContain('无法连接本机助手');expect(container.textContent).not.toContain('secret-value-do-not-display');
        await click('[data-chatgpt-plan-retry]');expect(container.querySelector('[data-chatgpt-plan-feedback]')).toBeNull();
        ports.pair.mockRejectedValueOnce(new Error('secret-value-do-not-display'));query('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();
        expect(container.textContent).toContain('操作未完成');expect(container.textContent).not.toContain('secret-value-do-not-display');
    });
    it('状态与模型挂起遵循12秒等待，授权遵循5分钟等待并取消助手授权', async () => {
        helperStatus = disconnected();await mount();await click('[data-chatgpt-plan-sign-in]');
        await vi.advanceTimersByTimeAsync(300_000);await settle();expect(ports.cancel).toHaveBeenCalledOnce();expect(container.textContent).toContain('等待超时');
        expect(container.querySelector('[data-chatgpt-plan-waiting]')).toBeNull();
        helperStatus = connected();const stalled = pending<typeof availableModels>();ports.models.mockReturnValueOnce(stalled.promise);
        await click('[data-chatgpt-plan-retry]');await vi.advanceTimersByTimeAsync(12_000);await settle();
        expect(query('[data-chatgpt-plan-model-error]').textContent).toContain('等待超时');stalled.resolve(availableModels);await settle();
        expect(container.textContent).not.toContain('Account model one');await click('[data-chatgpt-plan-refresh-models]');expect(container.textContent).toContain('Account model one');
    });
    it('已连接与已退出都提供显式换账号，不把点击事件当成newAccount标志', async () => {
        helperStatus = connected();await mount();await click('[data-chatgpt-plan-sign-in]');expect(ports.signIn).toHaveBeenLastCalledWith(false);
        await click('[data-chatgpt-plan-cancel]');await click('[data-chatgpt-plan-switch-account]');expect(ports.signIn).toHaveBeenLastCalledWith(true);
        await click('[data-chatgpt-plan-cancel]');await click('[data-chatgpt-plan-disconnect]');await click('[data-chatgpt-plan-switch-account]');
        expect(ports.signIn).toHaveBeenLastCalledWith(true);
    });
    it.each(['error-response', 'error-rejection', 'model-rejection', 'signin-rejection', 'cancel-rejection'])('配对凭证失效的%s返回配对引导并保留模型选择', async phase => {
        helperStatus = connected();await mount('saved-model');
        const invalidPair = Object.assign(new Error('private detail'), {code: 'pairing_failed'});
        if (phase === 'error-response') {helperStatus = {...connected(), error: 'pairing_failed'};await state.refreshStatus();}
        if (phase === 'error-rejection') {ports.status.mockRejectedValueOnce(invalidPair);await state.refreshStatus();}
        if (phase === 'model-rejection') {ports.models.mockRejectedValueOnce(invalidPair);await state.refreshModels();}
        if (phase === 'signin-rejection') {ports.signIn.mockRejectedValueOnce(invalidPair);await state.signIn();}
        if (phase === 'cancel-rejection') {await state.signIn();ports.cancel.mockRejectedValueOnce(invalidPair);await state.cancelSignIn();}
        await settle();expect(container.querySelector('[data-chatgpt-plan-pair-code]')).not.toBeNull();expect(container.textContent).toContain('配对未成功');
        expect(container.querySelector('[data-chatgpt-plan-account]')).toBeNull();expect(props.config.model[services.chatgptPlan]).toBe('saved-model');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('助手离线保持已配对状态并可恢复，无账号名称或邮箱时安全显示', async () => {
        helperStatus = {...connected(), account: {email: 'only-email@example.test'}};await mount();expect(container.textContent).toContain('only-email@example.test');
        ports.status.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'helper_unavailable'}));await state.refreshStatus();await settle();
        expect(container.textContent).toContain('暂时无法读取连接状态');expect(container.querySelector('[data-chatgpt-plan-pair-code]')).toBeNull();
        helperStatus = {...connected(), account: {name: 'Only name'}};await click('[data-chatgpt-plan-retry]');expect(container.textContent).toContain('Only name');
        helperStatus = {...connected(), account: undefined};await state.refreshStatus();await settle();expect(container.querySelector('[data-chatgpt-plan-account]')).toBeNull();
    });
    it('页面隐藏时所有迟到控件回调都拒绝保存或发起操作，并取消未完成模型读取', async () => {
        helperStatus = connected();const model = pending<typeof availableModels>();ports.models.mockReturnValueOnce(model.promise);await mount('saved-model');
        props.active = false;await settle();const calls = ports.status.mock.calls.length;
        await state.refreshStatus();await state.refreshModels();state.selectModel('account-model-one');await state.pair();await state.signIn();await state.cancelSignIn();await state.disconnect();await state.manageUsage();
        expect(ports.status.mock.calls).toHaveLength(calls);expect(ports.pair).not.toHaveBeenCalled();expect(ports.signIn).not.toHaveBeenCalled();expect(ports.disconnect).not.toHaveBeenCalled();expect(ports.usage).not.toHaveBeenCalled();
        model.resolve(availableModels);await settle();expect(props.config.model[services.chatgptPlan]).toBe('saved-model');
    });
    it('busy和未连接期间拒绝重复操作及迟到模型选择，元信息重试取代旧轮询', async () => {
        await mount();await state.signIn();await state.manageUsage();await state.refreshModels();await state.cancelSignIn();
        expect(ports.signIn).not.toHaveBeenCalled();expect(ports.usage).not.toHaveBeenCalled();expect(ports.models).not.toHaveBeenCalled();
        state.pairingCode = 'fixture-pairing';const pair = pending<PlanStatus>();ports.pair.mockReturnValueOnce(pair.promise);
        const pairing = state.pair();await settle();await state.pair();await state.signIn();await state.disconnect();await state.manageUsage();
        expect(ports.pair).toHaveBeenCalledOnce();helperStatus = connected();pair.resolve(helperStatus);await pairing;await settle();
        state.selectModel(undefined);state.selectModel('unknown-account-model');expect(props.config.model[services.chatgptPlan]).toBe('');
        const usage = pending<void>();ports.usage.mockReturnValueOnce(usage.promise);const managing = state.manageUsage();await settle();
        state.selectModel('account-model-one');await state.disconnect();await state.manageUsage();expect(props.config.model[services.chatgptPlan]).toBe('');expect(ports.disconnect).not.toHaveBeenCalled();
        usage.resolve();await managing;
        const stale = pending<PlanStatus>();ports.status.mockReturnValueOnce(stale.promise);const first = state.refreshStatus();await settle();
        const second = state.refreshStatus();await second;await first;stale.resolve(disconnected());await settle();expect(container.textContent).toContain('已连接 ChatGPT');
    });
    it('授权发起期间的取消终止旧action，取消失败可重试且退出会取消在途模型', async () => {
        helperStatus = disconnected();await mount();const auth = pending<PlanStatus>();ports.signIn.mockReturnValueOnce(auth.promise);
        const starting = state.signIn();await settle();ports.cancel.mockRejectedValueOnce(new Error('secret'));await state.cancelSignIn();await starting;
        expect(container.querySelector('[data-chatgpt-plan-waiting]')).toBeNull();expect(container.textContent).toContain('操作未完成');auth.resolve({...connected(), authPending: true});await settle();
        helperStatus = connected();const model = pending<typeof availableModels>();ports.models.mockReturnValueOnce(model.promise);await state.refreshStatus();await settle();
        await state.disconnect();model.resolve(availableModels);await settle();expect(container.querySelector('[data-chatgpt-plan-model-select]')).toBeNull();
    });
    it.each(['status', 'models', 'action'])('%s已解决但下一微任务前页面失活，成功结果仍属于旧页面', async phase => {
        helperStatus = connected();await mount();const response = pending<any>();let job: Promise<void>;
        if (phase === 'status') {ports.status.mockReturnValueOnce(response.promise);job = state.refreshStatus();}
        else if (phase === 'models') {ports.models.mockReturnValueOnce(response.promise);job = state.refreshModels();}
        else {ports.usage.mockReturnValueOnce(response.promise);job = state.manageUsage();}
        response.resolve(phase === 'status' ? connected('late@example.test') : phase === 'models' ? [{slug: 'late-model', display_name: 'Late model'}] : undefined);
        props.active = false;await job;await settle();expect(container.textContent).not.toContain('late@example.test');expect(container.textContent).not.toContain('Late model');
    });
    it.each(['success','failure'])('取消授权的%s回执迟到时不会更新已隐藏的页面',async outcome=>{
        helperStatus={...connected(),authPending:true};await mount();const response=pending<PlanStatus>();ports.cancel.mockReturnValueOnce(response.promise);
        const job=state.cancelSignIn();props.active=false;await settle();
        if(outcome==='success')response.resolve(connected('late-cancel@example.test'));else response.reject(Error('late private failure'));
        await job;await settle();expect(container.textContent).not.toContain('late-cancel@example.test');expect(container.textContent).not.toContain('late private failure');expect(vi.getTimerCount()).toBe(0);
    });
    it('取消回执已解决但组件卸载先于其继续执行时保持旧状态',async()=>{
        helperStatus={...connected(),authPending:true};await mount();const response=pending<PlanStatus>();ports.cancel.mockReturnValueOnce(response.promise);
        const job=state.cancelSignIn();response.resolve(connected('late-cancel@example.test'));await Promise.resolve();await Promise.resolve();
        app!.unmount();app=undefined;await job;expect(state.status.account?.email).not.toBe('late-cancel@example.test');expect(vi.getTimerCount()).toBe(0);
    });
    it('隐藏页结束挂起action，取消端口的异步拒绝和同步抛错都不阻止清理', async () => {
        helperStatus = disconnected();await mount();const auth = pending<PlanStatus>();ports.signIn.mockReturnValueOnce(auth.promise);const job = state.signIn();await settle();
        ports.cancel.mockRejectedValueOnce(new Error('released'));props.active = false;await job;await settle();expect(vi.getTimerCount()).toBe(0);
        auth.resolve({...disconnected(), authPending: true});props.active = true;await settle();await state.signIn();
        ports.cancel.mockImplementationOnce(() => {throw new Error('released');});props.active = false;await settle();expect(vi.getTimerCount()).toBe(0);
    });
    it('登录截止时取消在途状态与usage操作，旧计时器回调不能复活隐藏页面', async () => {
        helperStatus = {...disconnected(), authPending: true};const timerSpy = vi.spyOn(globalThis, 'setTimeout');await mount();
        const deadline = timerSpy.mock.calls.find(([_callback, time]) => time === 300_000)![0] as () => void;
        await state.signIn();expect(ports.signIn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(299_000);const statusPending = pending<PlanStatus>();ports.status.mockReturnValueOnce(statusPending.promise);
        const checking = state.refreshStatus();await settle();const usage = pending<void>();ports.usage.mockReturnValueOnce(usage.promise);const managing = state.manageUsage();await settle();
        await vi.advanceTimersByTimeAsync(1_000);await checking;await managing;await settle();expect(ports.cancel).toHaveBeenCalledOnce();
        props.active = false;await settle();deadline();expect(vi.getTimerCount()).toBe(0);
    });
    it('取消和截止都能终止在途轮询，同步失败不会留下action忙碌状态', async () => {
        helperStatus = disconnected();await mount();ports.signIn.mockImplementationOnce(() => {throw new Error('closed port');});await state.signIn();
        expect(container.textContent).toContain('操作未完成');expect((query('[data-chatgpt-plan-sign-in]') as HTMLButtonElement).disabled).toBe(false);
        await state.signIn();const response = pending<PlanStatus>();ports.status.mockReturnValueOnce(response.promise);const checking = state.refreshStatus();await settle();
        await state.cancelSignIn();await checking;expect(container.querySelector('[data-chatgpt-plan-waiting]')).toBeNull();
        await state.signIn();await vi.advanceTimersByTimeAsync(299_000);ports.status.mockReturnValueOnce(response.promise);
        const last = state.refreshStatus();await settle();await vi.advanceTimersByTimeAsync(1_000);await last;
        expect(container.textContent).toContain('等待超时');
    });
    it('七种语言目录保持相同语义键，已知错误本地化，未知错误不显示原始内容', () => {
        const keys = Object.keys(chatGPTPlanMessages['zh-CN']).sort();
        for (const locale of Object.keys(chatGPTPlanMessages) as UiLanguage[]) {
            expect(Object.keys(chatGPTPlanMessages[locale]).sort(), locale).toEqual(keys);
            expect(chatGPTPlanErrorText({code: 'helper_unavailable', message: 'private'}, locale)).toBe(chatGPTPlanMessages[locale].helperUnavailable);
            expect(chatGPTPlanErrorText('private', locale)).toBe(chatGPTPlanMessages[locale].operationFailed);
            expect(chatGPTPlanText('model', locale)).toBe(chatGPTPlanMessages[locale].model);
            for (const value of Object.values(chatGPTPlanMessages[locale])) expect(value.trim()).not.toBe('');
        }
        expect(chatGPTPlanText('model', 'future-locale' as UiLanguage)).toBe(chatGPTPlanMessages['zh-CN'].model);
        for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            expect(chatGPTPlanErrorText({code}, 'en-US')).toBe(chatGPTPlanMessages['en-US'].operationFailed);
            expect(chatGPTPlanText('model', code as UiLanguage)).toBe(chatGPTPlanMessages['zh-CN'].model);
        }
        expect(chatGPTPlanErrorText({}, 'en-US')).toBe(chatGPTPlanMessages['en-US'].operationFailed);
        expect(chatGPTPlanErrorText(null, 'en-US')).toBe(chatGPTPlanMessages['en-US'].operationFailed);
        expect(chatGPTPlanErrorText({message: 'not_connected'}, 'en-US')).toBe(chatGPTPlanMessages['en-US'].notConnected);
    });
});
