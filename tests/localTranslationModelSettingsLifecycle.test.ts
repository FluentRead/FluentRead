/**
 * @file tests/localTranslationModelSettingsLifecycle.test.ts
 * 文件职责：通过真实客户端 Vue 模板验证本地翻译模型页的操作和订阅归属。
 * 主要内容：覆盖隐藏、缓存切页和配置替换后的退订、状态接续、后台下载独立完成、试译取消与晚回包隔离，以及旧控件和删除确认不能进入新视图。
 * 模块边界：执行完整 SFC/setup/template 与公共后台消息 handlers，仅控制 DOM、存储、确认和 Offscreen 端口，不访问网络、GPU、真实模型或源码私有导出。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {App} from 'vue';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    return {window, document};
});
const ports = vi.hoisted(() => ({send: vi.fn(), get: vi.fn(), confirm: vi.fn(), listeners: new Set<(changes: any, area: string) => void>()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: any[]) => ports.send(...args)}, storage: {
    local: {get: (...args: any[]) => ports.get(...args)}, onChanged: {
        addListener: (listener: any) => ports.listeners.add(listener), removeListener: (listener: any) => ports.listeners.delete(listener),
    },
}}}));

import * as Vue from 'vue';
import LocalTranslationModelSettings from '@/src/features/settings/ui/LocalTranslationModelSettings.vue';
import {normalizeConfig} from '@/src/core/config/model';
import * as models from '@/src/core/config/localTranslation';
import {createLocalTranslationBackgroundHandlers} from '@/src/features/local-translation/background/handlers';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});
    return {promise, resolve, reject};
}
async function settle() {for (let n = 0; n < 16; n++) {await Promise.resolve();await Vue.nextTick();}}
const primary = models.DEFAULT_LOCAL_TRANSLATION_MODEL;
const alternate = models.LOCAL_TRANSLATION_MODEL_IDS.opusJaEn;
type Captured = {tag: string; props: Record<string, any>};
const {renderedEvents} = vi.hoisted(() => ({renderedEvents: [] as Array<{tag: string; props: Record<string, any>}>}));
// Observe emitted VNodes without compiling or replacing the production component.
vi.mock('vue', async importOriginal => {
    const actual = await importOriginal<typeof import('vue')>();
    const wrapped: Record<string, unknown> = {...actual};
    for (const key of ['createVNode', 'createBlock', 'createElementVNode', 'createElementBlock'] as const) {
        wrapped[key] = (...args: any[]) => {
            const [tag, props] = args;
            if (props && Object.keys(props).some(name => name.startsWith('on'))) renderedEvents.push({tag: typeof tag === 'string' ? tag : tag.__name || tag.name || 'component', props: {...props}});
            return (actual[key] as any)(...args);
        };
    }
    return wrapped;
});
vi.mock('element-plus', () => ({ElMessageBox: {confirm: (...args: any[]) => ports.confirm(...args)}}));
vi.mock('@element-plus/icons-vue', () => Object.fromEntries(['Check', 'Close', 'Cpu', 'Delete', 'Download', 'Promotion', 'Refresh', 'TopRight', 'VideoPause'].map(name => [name, {render: () => Vue.h('svg')}])));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
vi.mock('@/src/platform/browser/localTranslationSupport', () => ({supportsHunyuanTranslation: () => true, supportsOpusTranslation: () => true}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string, values?: unknown) => values ? `${key}:${JSON.stringify(values)}` : key})}));
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {setup: (_: unknown, {slots}: any) => () => Vue.h('span', slots.default?.())}}));
function task(phase: models.LocalTranslationDownloadPhase, downloadedBytes = 0, updatedAt = 1, model: models.LocalTranslationModelId = primary): models.LocalTranslationDownloadState {
    return {model, phase, downloadedBytes, totalBytes: 800_000, bytesPerSecond: 200_000, updatedAt};
}
function snapshot(tasks: models.LocalTranslationDownloadState[]): models.LocalTranslationDownloadSnapshot {return {version: 2, tasks};}
function backend() {
    let current = snapshot([]);
    const values: Record<string, any> = {[models.LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]: current};
    const gates: Array<ReturnType<typeof deferred<any>>> = [];
    const heldStatus: Array<ReturnType<typeof deferred<any>>> = [], heldStorage: Array<ReturnType<typeof deferred<any>>> = [];
    const pendingCommands: Array<ReturnType<typeof deferred<any>>> = [];
    const trials = new Map<string, {done: ReturnType<typeof deferred<string>>; signal: AbortSignal}>();
    const jobs = new Map<string, {done: ReturnType<typeof deferred<any>>}>();
    let clock = 1;
    const emit = async (next: models.LocalTranslationDownloadState[]) => {
        current = snapshot(next);
        await route({type: 'fluentReadLocalTranslationDownloadProgress', snapshot: current}, {});
        await settle();
    };
    const offscreen = {
        status: vi.fn(() => heldStatus.length ? heldStatus.shift()!.promise : Promise.resolve(current)),
        prepare: vi.fn(async (model: string) => {
            const done = deferred<any>();jobs.set(model, {done});gates.push(done);
            await emit([task('downloading', 0, ++clock, model as typeof primary)]);
            return pendingCommands.length ? pendingCommands.shift()!.promise : current;
        }),
        pause: vi.fn(async (model: string) => {await emit([task('paused', 200_000, ++clock, model as typeof primary)]);return current;}),
        remove: vi.fn(async () => {await emit([]);}),
        translate: vi.fn((_request: unknown, options: {signal: AbortSignal}) => {
            const done = deferred<string>(), message = ports.send.mock.calls.findLast(([input]) => input.type === 'fluentReadTryLocalTranslation')![0];
            gates.push(done);trials.set(message.requestId, {done, signal: options.signal});return done.promise;
        }),
    };
    const storage = {
        get: async (key: string) => structuredClone({[key]: values[key]}),
        set: async (next: Record<string, unknown>) => {
            const changes: any = {};
            for (const [key, value] of Object.entries(next)) {changes[key] = {oldValue: values[key], newValue: structuredClone(value)};values[key] = structuredClone(value);}
            for (const listener of [...ports.listeners]) listener(changes, 'local');
        },
    };
    const handlers = createLocalTranslationBackgroundHandlers({offscreen, storage, isTrustedProgress: () => true});
    const route = createBackgroundRuntimeMessageListener(createBackgroundMessageRouter(handlers), () => ({}));
    ports.send.mockImplementation((message: any) => route(message, {}));
    ports.get.mockImplementation((key: string) => heldStorage.length ? heldStorage.shift()!.promise : storage.get(key));
    ports.confirm.mockResolvedValue(undefined);
    return {offscreen, trials, jobs, values, emit,
        async ready() {await emit([task('ready', 800_000, ++clock)]);},
        async chunk(bytes: number) {await emit([task('downloading', bytes, ++clock)]);},
        async finish() {await emit([task('ready', 800_000, ++clock)]);jobs.get(primary)?.done.resolve({success: true});},
        holdStatus() {const done = deferred<any>();heldStatus.push(done);gates.push(done);return done;},
        holdStorage() {const done = deferred<any>();heldStorage.push(done);gates.push(done);return done;},
        holdCommand() {const done = deferred<any>();pendingCommands.push(done);gates.push(done);return done;},
        async close() {for (const gate of gates) gate.resolve({success: false});await settle();},
    };
}
let fixture: ReturnType<typeof backend> | undefined;
const apps = new Set<App>();
async function mount(enabled = true) {
    fixture = backend();renderedEvents.length = 0;
    const state = Vue.reactive({config: normalizeConfig({}), service: 'localTranslation', active: enabled, context: {id: 1}});
    const cached = Vue.ref(false), host = dom.document.createElement('div');dom.document.body.append(host);
    const component = LocalTranslationModelSettings;
    const empty = Vue.defineComponent({render: () => null});
    const app = Vue.createApp({setup: () => () => Vue.h(Vue.KeepAlive, null, {default: () => cached.value ? Vue.h(empty, {key: 'other'}) : Vue.h(component, {
        config: state.config, service: state.service, active: state.active, context: state.context,
    })})});
    app.config.warnHandler = () => {};apps.add(app);app.mount(host);await settle();
    return {host, state, cached, backend: fixture, stop: () => {app.unmount();apps.delete(app);}};
}
afterEach(async () => {
    for (const app of apps) app.unmount();apps.clear();await fixture?.close();
    expect(ports.listeners.size).toBe(0);
    ports.send.mockReset();ports.get.mockReset();ports.confirm.mockReset();fixture = undefined;
    renderedEvents.length = 0;dom.document.body.replaceChildren();
});
function findButton(host: HTMLElement, selector: string, text: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(node => node.textContent?.includes(text));
    expect(button).toBeDefined();return button!;
}
function trialButton(host: HTMLElement) {return findButton(host, '.local-model-trial-actions button', 'settings.localTranslation.trialAction');}
function downloadButton(host: HTMLElement) {return findButton(host, `[data-model="${primary}"] button`, 'settings.localTranslation.download');}
function capture(predicate: (event: Captured) => boolean, handler: string, first = false) {
    const matching = (item: Captured) => predicate(item) && typeof item.props[handler] === 'function';
    const event = first ? renderedEvents.find(matching) : renderedEvents.findLast(matching);
    expect(event).toBeDefined();return event!.props[handler] as (...args: any[]) => any;
}
type View = Awaited<ReturnType<typeof mount>>;
async function leave(h: View, reason: string) {
    if (reason === 'cached') h.cached.value = true;
    else if (reason === 'config') h.state.config = normalizeConfig({model: {localTranslation: alternate}});
    else if (reason === 'context') h.state.context = {id: 2};
    else if (reason === 'service') h.state.service = 'other-local-service';
    else h.state.active = false;
    await settle();
}
async function reopen(h: View) {h.cached.value = false;h.state.active = true;await settle();}

describe('local translation actual mounted page ownership', () => {
    it('does not subscribe, read, or issue commands when initially inactive', async () => {
        const h = await mount(false);
        expect(ports.listeners.size).toBe(0);expect(ports.get).not.toHaveBeenCalled();expect(ports.send).not.toHaveBeenCalled();
        expect(downloadButton(h.host).disabled).toBe(true);
        const download = capture(event => event.tag === 'button' && String(event.props.class).includes('primary'), 'onClick', true);
        download();await settle();expect(ports.send).not.toHaveBeenCalled();
        await reopen(h);expect(ports.listeners.size).toBe(1);expect(downloadButton(h.host).disabled).toBe(false);
    });
    it.each(['hidden', 'cached'])('unsubscribes while %s and reconnects authority without accepting old progress', async reason => {
        const h = await mount(), oldListeners = [...ports.listeners];
        expect(oldListeners).toHaveLength(1);downloadButton(h.host).click();await settle();await h.backend.chunk(200_000);
        expect(h.host.querySelector('progress')?.getAttribute('value')).toBe('200000');
        await leave(h, reason);expect(ports.listeners.size).toBe(0);
        const reads = ports.send.mock.calls.length;
        await h.backend.chunk(400_000);expect(ports.send).toHaveBeenCalledTimes(reads);
        expect(h.backend.jobs.has(primary)).toBe(true);
        await reopen(h);expect(ports.listeners.size).toBe(1);
        expect(h.host.querySelector('progress')?.getAttribute('value')).toBe('400000');
        for (const listener of oldListeners) listener({[models.LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]: {newValue: snapshot([task('error', 700_000, 1000)])}}, 'local');
        await settle();expect(h.host.querySelector('progress')?.getAttribute('value')).toBe('400000');
        await leave(h, reason);await h.backend.finish();await reopen(h);
        expect(h.host.querySelector('progress')).toBeNull();expect(trialButton(h.host).disabled).toBe(false);
        expect(h.backend.offscreen.prepare).toHaveBeenCalledOnce();
        expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadPauseLocalTranslationModel')).toBe(false);
    });
    it.each(['hidden', 'cached', 'config', 'context', 'service'])('cancels an owned trial on %s and excludes its late success/error from the current view', async reason => {
        const h = await mount();await h.backend.ready();trialButton(h.host).click();await settle();
        const [id, trial] = [...h.backend.trials][0];expect(trial.signal.aborted).toBe(false);
        await leave(h, reason);expect(trial.signal.aborted).toBe(true);
        expect(ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadCancelLocalTranslationTrial').map(([message]) => message.requestId)).toEqual([id]);
        await reopen(h);trial.done.resolve('OLD_TRIAL_SUCCESS');await settle();
        expect(h.host.textContent).not.toContain('OLD_TRIAL_SUCCESS');expect(h.host.querySelector('.local-model-trial-result')).toBeNull();
        expect(h.host.querySelector('.local-model-trial [role="alert"]')).toBeNull();
    });
    it('keeps a newer trial running when a cancelled prior trial rejects late', async () => {
        const h = await mount();await h.backend.ready();trialButton(h.host).click();await settle();
        const prior = [...h.backend.trials.values()][0];await leave(h, 'hidden');await reopen(h);
        trialButton(h.host).click();await settle();const next = [...h.backend.trials.values()][1];
        prior.done.reject(new Error('OLD_TRIAL_ERROR'));await settle();
        expect(next.signal.aborted).toBe(false);expect(h.host.querySelector('.local-model-trial-status')).not.toBeNull();
        next.done.resolve('CURRENT_TRIAL_RESULT');await settle();expect(h.host.querySelector('.local-model-trial-result')?.textContent).toContain('CURRENT_TRIAL_RESULT');
    });
    it('ignores old storage/state reads after context replacement and keeps newer progress when reads arrive out of order', async () => {
        const h = await mount(), stateRead = h.backend.holdStatus(), storageRead = h.backend.holdStorage();
        await leave(h, 'context');await leave(h, 'config');await h.backend.chunk(400_000);
        stateRead.resolve({success: false});storageRead.resolve({[models.LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]: snapshot([task('ready', 800_000, 1000)])});await settle();
        expect(h.host.querySelector('[role="alert"]')).toBeNull();expect(h.host.querySelector('progress')?.getAttribute('value')).toBe('400000');
        const currentRead = h.backend.holdStatus();
        await leave(h, 'context');await h.backend.chunk(600_000);
        currentRead.resolve({success: true, ...snapshot([task('downloading', 200_000, 1)])});await settle();
        expect(h.host.querySelector('progress')?.getAttribute('value')).toBe('600000');
    });
    it('does not resurrect a deleted model from a late initial storage read', async () => {
        const h = await mount(false), stored = h.backend.holdStorage();await h.backend.ready();await reopen(h);
        expect(trialButton(h.host).disabled).toBe(false);
        findButton(h.host, `[data-model="${primary}"] button`, '').click();await settle();
        expect(h.backend.offscreen.remove).toHaveBeenCalledOnce();expect(trialButton(h.host).disabled).toBe(true);
        stored.resolve({[models.LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]: snapshot([task('ready', 800_000, 1000)])});await settle();
        expect(trialButton(h.host).disabled).toBe(true);expect(downloadButton(h.host).disabled).toBe(false);
        expect(h.host.querySelector(`[data-model="${primary}"] .local-model-status`)?.textContent).toBe('settings.localTranslation.phase.idle');
    });
    it('keeps an empty deletion event over an older pending status read while valid status releases loading', async () => {
        const h = await mount(false);await h.backend.ready();const status = h.backend.holdStatus();await reopen(h);
        // 本地缓存能显示 ready，后台读取尚未结束，不能试译或再次下载。
        expect(trialButton(h.host).disabled).toBe(true);
        await h.backend.emit([]);expect(downloadButton(h.host).disabled).toBe(true);
        status.resolve({success: true, ...snapshot([task('ready', 800_000, 1000)])});await settle();
        expect(trialButton(h.host).disabled).toBe(true);expect(downloadButton(h.host).disabled).toBe(false);
        expect(h.host.querySelector(`[data-model="${primary}"] .local-model-status`)?.textContent).toBe('settings.localTranslation.phase.idle');
    });
    it('lets authoritative status replace a faster initial cached snapshot', async () => {
        const h = await mount(false);await h.backend.ready();const status = h.backend.holdStatus();await reopen(h);
        status.resolve({success: true, ...snapshot([])});await settle();
        expect(trialButton(h.host).disabled).toBe(true);expect(downloadButton(h.host).disabled).toBe(false);
    });
    it('keeps pending background commands alive but excludes old command failures after hidden return', async () => {
        const h = await mount(), done = h.backend.holdCommand();downloadButton(h.host).click();await settle();
        await leave(h, 'hidden');await reopen(h);
        const pendingPause = findButton(h.host, `[data-model="${primary}"] button`, 'settings.localTranslation.pause');
        expect(pendingPause.disabled).toBe(true);
        const reads = ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadGetLocalTranslationModelState').length;
        done.reject(new Error('OLD_COMMAND_ERROR'));await settle();
        expect(h.host.querySelector('[role="alert"]')).toBeNull();expect(h.backend.offscreen.prepare).toHaveBeenCalledOnce();
        expect(h.host.querySelector('progress')).not.toBeNull();
        expect(findButton(h.host, `[data-model="${primary}"] button`, 'settings.localTranslation.pause').disabled).toBe(false);
        expect(ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadGetLocalTranslationModelState').length).toBeGreaterThan(reads);
    });
    it.each(['hidden', 'config', 'service'])('rejects queued complete radio/download/target/text/trial events after %s', async reason => {
        const h = await mount();
        const download = capture(event => event.tag === 'button' && String(event.props.class).includes('primary') && !event.props.disabled, 'onClick');
        await h.backend.ready();
        const original = h.state.config;
        const model = capture(event => event.tag === 'input' && event.props.value === alternate, 'onChange');
        const target = capture(event => event.tag === 'SegmentedControl', 'onUpdate:modelValue');
        const text = capture(event => event.tag === 'textarea', 'onInput');
        const trial = capture(event => event.tag === 'button' && String(event.props.class).includes('primary') && !event.props.disabled, 'onClick');
        await leave(h, reason);await reopen(h);const calls = ports.send.mock.calls.length;
        const before = structuredClone(Vue.toRaw(h.state.config.model));
        model(new dom.window.Event('change'));download();target('en');text({target: {value: 'OLD_TEXT'}});trial();await settle();
        expect(h.state.config.model).toEqual(before);expect(original.model.localTranslation).toBe(primary);expect(ports.send).toHaveBeenCalledTimes(calls);
        expect(h.host.querySelector('textarea')?.value).not.toBe('OLD_TEXT');
        const radio = h.host.querySelector<HTMLInputElement>(`input[value="${alternate}"]`)!;
        radio.dispatchEvent(new dom.window.Event('change', {bubbles: true}));await settle();expect(h.state.config.model[h.state.service]).toBe(alternate);
    });
    it.each(['hidden', 'config', 'service'])('binds a pending deletion confirmation to its original %s context', async reason => {
        const h = await mount();await h.backend.ready();const confirmation = deferred<any>();ports.confirm.mockReturnValueOnce(confirmation.promise);
        findButton(h.host, `[data-model="${primary}"] button`, '').click();await settle();expect(ports.confirm).toHaveBeenCalledOnce();
        await leave(h, reason);await reopen(h);confirmation.resolve(undefined);await settle();
        expect(h.backend.offscreen.remove).not.toHaveBeenCalled();
        findButton(h.host, `[data-model="${primary}"] button`, '').click();await settle();expect(h.backend.offscreen.remove).toHaveBeenCalledOnce();
    });
    it('refreshes a failed state read, pauses and resumes the actual download, and cancels only the current trial', async () => {
        const h = await mount(false), status = h.backend.holdStatus();await reopen(h);
        status.reject(new Error('temporary status failure'));await settle();
        expect(h.host.querySelector('[role="alert"]')?.textContent).toContain('settings.localTranslation.statusReadFailed');
        const refresh = h.host.querySelector<HTMLButtonElement>('button[aria-label="settings.localTranslation.refresh"]')!;
        refresh.click();await settle();expect(h.host.querySelector('[role="alert"]')).toBeNull();
        downloadButton(h.host).click();await settle();await h.backend.chunk(200_000);
        findButton(h.host, `[data-model="${primary}"] button`, 'settings.localTranslation.pause').click();await settle();
        expect(h.backend.offscreen.pause).toHaveBeenCalledWith(primary);
        expect(h.host.querySelector(`[data-model="${primary}"]`)?.getAttribute('data-phase')).toBe('paused');
        const resume = findButton(h.host, `[data-model="${primary}"] button`, 'settings.localTranslation.resume');
        await vi.waitFor(() => expect(resume.disabled).toBe(false));resume.click();await vi.waitFor(() => expect(h.backend.offscreen.prepare).toHaveBeenCalledTimes(2));await h.backend.finish();
        expect(h.backend.offscreen.prepare).toHaveBeenCalledTimes(2);expect(trialButton(h.host).disabled).toBe(false);
        trialButton(h.host).click();await settle();const prior = [...h.backend.trials.values()][0];
        findButton(h.host, '.local-model-trial-actions button', 'settings.localTranslation.cancel').click();await settle();
        expect(prior.signal.aborted).toBe(true);expect(h.host.querySelector('.local-model-trial-status')).toBeNull();
        trialButton(h.host).click();await settle();const current = [...h.backend.trials.values()][1];prior.done.resolve('CANCELLED_RESULT');await settle();
        expect(current.signal.aborted).toBe(false);expect(h.host.querySelector('.local-model-trial-result')).toBeNull();
        current.done.resolve('CURRENT_RESULT');await settle();expect(h.host.querySelector('.local-model-trial-result')?.textContent).toContain('CURRENT_RESULT');
    });
    it('cancels trial and removes subscriptions on unmount', async () => {
        const h = await mount();await h.backend.ready();trialButton(h.host).click();await settle();const trial = [...h.backend.trials.values()][0];
        h.stop();await settle();expect(ports.listeners.size).toBe(0);expect(trial.signal.aborted).toBe(true);
    });
});
