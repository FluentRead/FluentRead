/**
 * @file tests/localModelSettingsLifecycle.test.ts
 * 文件职责：从真实 mounted client template 验证本地朗读与字幕模型设置的页面归属。
 * 主要内容：覆盖 cached/hidden 监听停用、真实字节进度接续、自动下载与隐藏连接来源、失败重试、后台命令继续完成、迟到读写回包隔离，以及整个旧模板事件不能写入替换后的配置。
 * 模块边界：实际 SFC/setup/template、进度 watcher/display 和公共后台 handlers；只控制 DOM、存储、Offscreen 与回包传输端口，无浏览器、网络、GPU、native 或源码私有导出。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {App} from 'vue';
import {sharedDirectoryFixture} from './helpers/sharedVideoModelDirectory';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    const selectValues = new WeakMap<object, string>();
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true,
        get() {return selectValues.get(this) ?? '';}, set(value: string) {selectValues.set(this, String(value));}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    return {window, document};
});
const ports = vi.hoisted(() => ({send: vi.fn(), get: vi.fn(), listeners: new Set<(changes: any, area: string) => void>(),
    renderedEvents: [] as Array<{tag: string; props: Record<string, any>}>,
}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: any[]) => ports.send(...args)}, storage: {
    local: {get: (...args: any[]) => ports.get(...args)}, onChanged: {
        addListener: (listener: any) => ports.listeners.add(listener), removeListener: (listener: any) => ports.listeners.delete(listener),
    },
}}}));

// Observe the complete events emitted by the actual SFC render API, preserving
// stale-event tests without setupState, private invokers or compiled-code copies.
vi.mock('vue', async () => {
    const actual = await vi.importActual<typeof import('vue')>('vue');
    const exposed: any = {...actual};
    for (const key of ['createVNode', 'createBlock', 'createElementVNode', 'createElementBlock'] as const) {
        exposed[key] = (...args: any[]) => {
            const [tag, props] = args;
            if (props && Object.keys(props).some(name => name.startsWith('on'))) {
                ports.renderedEvents.push({tag: typeof tag === 'string' ? tag : tag.__name || tag.name || 'component', props: {...props}});
            }
            return (actual[key] as any)(...args);
        };
    }
    return exposed;
});
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({
    t: (key: string, parameters?: unknown) => parameters ? `${key}:${JSON.stringify(parameters)}` : key,
    translateLegacy: (text: string) => text,
})}));
vi.mock('@element-plus/icons-vue', async () => {
    const {h} = await import('vue');
    return Object.fromEntries(['Cpu', 'Delete', 'Download', 'Loading', 'Check', 'Files'].map(name => [name, {render: () => h('svg')}]));
});
vi.mock('element-plus', async () => {
    const {defineComponent, h} = await import('vue');
    return {ElTooltip: defineComponent({name: 'TooltipPort', setup: (_, {slots}) => () => h('span', slots.default?.())})};
});

import * as Vue from 'vue';
import LocalTtsSettings from '@/src/features/settings/ui/LocalTtsSettings.vue';
import VideoLocalModelSettings from '@/src/features/settings/ui/VideoLocalModelSettings.vue';
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue';
import browser from 'webextension-polyfill';
import {normalizeConfig} from '@/src/core/config/model';
import * as ttsModel from '@/src/core/config/localTts';
import * as videoPublic from '@/src/features/video-subtitle/domain/public';
import {createLocalTtsBackgroundHandlers} from '@/src/features/local-tts/background/handlers';
import {createVideoSubtitleBackgroundHandlers} from '@/src/features/video-subtitle/background/handlers';
import {getVideoAiModelFileUrl, VIDEO_AI_Q4_MODEL_FILES, VIDEO_AI_SMALL_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';
import {createDownloadProgressHandler} from '@/src/app/background/handlers/downloadProgress';
import {createDownloadProgressPublisher, downloadProgressKey, LOCAL_TTS_DOWNLOAD_ID, videoModelDownloadId} from '@/src/core/download/progress';
import type {VideoPreparationResult} from '@/src/core/messaging/video';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
async function settle() {for (let n = 0; n < 16; n++) {await Promise.resolve(); await Vue.nextTick();}}
type Kind = 'tts' | 'video';
type Captured = {tag: string; props: Record<string, any>};
const renderedEvents: Captured[] = ports.renderedEvents;
const Select = Vue.defineComponent({name: 'SelectPort', props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
    setup: (props, {attrs, slots, emit}) => () => Vue.h('select', {...attrs, value: props.modelValue, disabled: props.disabled,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)}, slots.default?.())});
const Option = Vue.defineComponent({props: ['value', 'label'], setup: props => () => Vue.h('option', {value: props.value}, props.label)});
import * as progressModule from '@/src/core/download/progress';

function backend() {
    const values: Record<string, any> = {};
    const videoKeys = new Set<string>();
    const addVideoKeys = (model: string) => {for (const file of model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES) videoKeys.add(getVideoAiModelFileUrl(model, file));};
    vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys: async () => [...videoKeys].map(url => new Request(url))})});
    const writes: unknown[] = [];
    const jobs = new Map<string, {done: ReturnType<typeof deferred<any>>; work: Promise<any>; received: number; report: (next: progressModule.DownloadProgress) => void; successResponse: {success: true; model?: VideoPreparationResult['model']}}>();
    const publishTasks = new Set<Promise<unknown>>();
    const reads: Array<{kind: Kind; gate: ReturnType<typeof deferred<any>>}> = [];
    const allReadGates: Array<ReturnType<typeof deferred<any>>> = [];
    const changed = (changes: any) => {for (const listener of [...ports.listeners]) listener(changes, 'local');};
    const storage = {
        get: async (keys: string | string[] | null) => {
            const names = keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
            return structuredClone(Object.fromEntries(names.filter(name => name in values).map(name => [name, values[name]])));
        },
        set: async (next: Record<string, unknown>) => {
            const changes: any = {};
            for (const [key, value] of Object.entries(next)) {
                if (JSON.stringify(values[key]) === JSON.stringify(value)) continue;
                changes[key] = {oldValue: values[key], newValue: structuredClone(value)};
                values[key] = structuredClone(value);
            }
            writes.push(structuredClone(next)); if (Object.keys(changes).length) changed(changes);
        },
        remove: async (key: string) => {if (key in values) {const oldValue = values[key]; delete values[key]; changed({[key]: {oldValue}});}},
    };
    const progressHandler = createDownloadProgressHandler({runtimeId: 'owned-fixture', offscreenUrl: 'chrome-extension://owned-fixture/offscreen.html', storage});
    const start = (id: string, successResponse: {success: true; model?: VideoPreparationResult['model']} = {success: true}) => {
        const done = deferred<any>(); let report!: (next: progressModule.DownloadProgress) => void;
        const publisher = createDownloadProgressPublisher(message => {
            const task = Promise.resolve(progressHandler.handle(message, {sender: {id: 'owned-fixture', url: 'chrome-extension://owned-fixture/offscreen.html'}}));
            publishTasks.add(task); void task.finally(() => publishTasks.delete(task));
        }, {intervalMs: 0});
        const work = publisher.track(id, async publish => {report = publish; return done.promise;});
        jobs.set(id, {done, work, received: 0, report, successResponse}); return work;
    };
    const ttsOffscreen = {prepare: vi.fn(() => start(LOCAL_TTS_DOWNLOAD_ID)), status: vi.fn(async () => ({models: [values[ttsModel.LOCAL_TTS_MODEL_STATE_KEY] || {
        model: ttsModel.LOCAL_TTS_MODEL_ID, downloaded: false, downloadSizeMb: ttsModel.LOCAL_TTS_MODEL.downloadSizeMb,
    }]})), remove: vi.fn(async () => undefined)};
    // 默认完成包模拟实际离屏路由的准备结果；显式受控回包仍原样传递，不修饰坏消息。
    const videoOffscreen = {send: vi.fn((message: {model: VideoPreparationResult['model']}) => start(videoModelDownloadId(message.model), {success: true, model: message.model}).then(response => {
        if (response?.success === true) addVideoKeys(message.model);
        return response;
    })), sendIfPresent: vi.fn(async () => ({success: true}))};
    const listener = createBackgroundRuntimeMessageListener(createBackgroundMessageRouter<any>([
        ...createLocalTtsBackgroundHandlers({storage, offscreen: ttsOffscreen}),
        ...createVideoSubtitleBackgroundHandlers({storage, offscreen: videoOffscreen as any}),
    ]), () => ({}));
    const stats = () => ({success: true, stats: {entries: 2, bytes: 1234, maxEntries: 32, ttlMs: 7 * 86400000}});
    ports.send.mockImplementation(async (message: any) => {
        const kind = message.type === 'fluentReadGetLocalTtsModelState' ? 'tts' : message.type === videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? 'video' : undefined;
        const hold = kind ? reads.findIndex(read => read.kind === kind) : -1;
        const gate = hold < 0 ? undefined : reads.splice(hold, 1)[0].gate;
        const response = message.type === videoPublic.VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE ? stats()
            : message.type === videoPublic.VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE ? {success: true} : await listener(message, {});
        return gate ? gate.promise : response;
    });
    ports.get.mockImplementation((key: string | string[]) => storage.get(key));
    return {values, writes, jobs, ttsOffscreen, videoOffscreen, storage, videoKeys, addVideoKeys,
        holdRead(kind: Kind) {const gate = deferred<any>(); reads.push({kind, gate}); allReadGates.push(gate); return gate;},
        async chunk(id: string, bytes = 200_000, total = 800_000) {
            const job = jobs.get(id)!; expect(job).toBeDefined();
            job.received += new Uint8Array(bytes).byteLength;
            job.report({loaded: job.received, total}); await Promise.all([...publishTasks]); await settle();
        },
        async transfer(id: string, transfer: progressModule.DownloadProgress['transfer'], loaded = 0, total = 800_000) {
            jobs.get(id)!.report({loaded, total, transfer}); await Promise.all([...publishTasks]); await settle();
        },
        async finish(id: string, response?: unknown) {const job = jobs.get(id)!; job.done.resolve(response === undefined ? job.successResponse : response); await job.work; await settle(); await Promise.all([...publishTasks]);},
        async close() {for (const gate of allReadGates) gate.resolve({success: false}); for (const job of jobs.values()) job.done.resolve(job.successResponse); await Promise.allSettled([...jobs.values()].map(job => job.work)); await Promise.allSettled([...publishTasks]);},
    };
}
let fixture: ReturnType<typeof backend> | undefined;
const apps = new Set<App>();
const viewEventRestorers: Array<() => void> = [];
function observeViewEventPort(target: EventTarget, type: string) {
    const add = target.addEventListener, remove = target.removeEventListener;
    const active: Array<{listener: Parameters<EventTarget['addEventListener']>[1]; capture: boolean}> = [];
    // linkedom's window routes event methods through a Proxy setter; install call-through ports by assignment.
    target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
        add.apply(target, args);
        const [eventType, listener, options] = args, capture = listenerCapture(options);
        if (eventType === type && listener && !active.some(item => item.listener === listener && item.capture === capture)) {
            active.push({listener, capture});
        }
    };
    target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
        remove.apply(target, args);
        const [eventType, listener, options] = args;
        if (eventType !== type) return;
        const index = active.findIndex(item => item.listener === listener && item.capture === listenerCapture(options));
        if (index !== -1) active.splice(index, 1);
    };
    viewEventRestorers.push(() => {target.addEventListener = add; target.removeEventListener = remove;});
    return {type, active};
}
function listenerCapture(options?: boolean | EventListenerOptions): boolean {
    return typeof options === 'boolean' ? options : Boolean(options?.capture);
}
async function mount(kind: Kind) {
    vi.stubGlobal('browser', browser);
    fixture = backend(); renderedEvents.length = 0;
    const state = Vue.reactive({config: normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'tiny', selectionTtsMode: 'online-first'}), active: true});
    const cached = Vue.ref(false);
    const host = dom.document.createElement('div'); dom.document.body.append(host);
    const component = kind === 'tts' ? LocalTtsSettings : VideoLocalModelSettings;
    const empty = Vue.defineComponent({render: () => null});
    const app = Vue.createApp({setup: () => () => Vue.h(Vue.KeepAlive, null, {default: () => cached.value ? Vue.h(empty, {key: 'other'}) : Vue.h(component, {
        config: state.config, active: state.active, context: state.config,
    })})});
    app.component('el-select', Select); app.component('el-option', Option); app.config.warnHandler = () => {};
    apps.add(app); app.mount(host); await settle();
    return {host, state, cached, backend: fixture, stop: () => {app.unmount(); apps.delete(app);}};
}
afterEach(async () => {
    for (const app of apps) app.unmount(); apps.clear(); await fixture?.close(); await settle();
    for (const restore of viewEventRestorers.splice(0).reverse()) restore();
    expect(ports.listeners.size).toBe(0); ports.send.mockReset(); ports.get.mockReset(); fixture = undefined;
    renderedEvents.length = 0; dom.document.body.replaceChildren(); vi.unstubAllGlobals();
    delete (dom.window as any).showDirectoryPicker;
});

describe('shared directory controls on the mounted settings page', () => {
    function directoryPort() {
        const f = sharedDirectoryFixture();
        vi.stubGlobal('window', dom.window);
        Object.defineProperty(dom.window, 'showDirectoryPicker', {configurable: true, value: f.picker});
        return f;
    }
    it('shows the unconfigured state, connects once, and disconnects without deleting shared files', async () => {
        const f = directoryPort(), h = await mount('video');
        const panel = () => h.host.querySelector('[data-video-ai-shared-models]')!;
        expect(panel().textContent).toContain('未连接');
        const choose = panel().querySelector('.video-ai-shared-model-actions button') as HTMLButtonElement;
        choose.click(); choose.click(); await settle();
        expect(f.picker).toHaveBeenCalledOnce(); expect(panel().textContent).toContain('已授权');
        const disconnect = [...panel().querySelectorAll('button')].find(button => button.textContent === '断开共享') as HTMLButtonElement;
        await vi.waitFor(() => expect(disconnect.disabled).toBe(false));
        disconnect.click(); await settle();
        await vi.waitFor(() => expect(panel().textContent).toContain('未连接')); expect(f.removed).toEqual([]);
    });
    it('ignores an obsolete rendered action and lets a new view reread an outstanding picker grant', async () => {
        const f = directoryPort(), h = await mount('video');
        const old = capture(event => event.props.class === 'video-model-download-button', 'onClick');
        h.state.config = normalizeConfig({videoTranslationEnabled: true}); await settle();
        await old(); expect(f.picker).not.toHaveBeenCalled();
        const pending = deferred<any>(); f.picker.mockReturnValueOnce(pending.promise);
        (h.host.querySelector('.video-ai-shared-model-actions button') as HTMLButtonElement).click(); await settle();
        await hide(h, 'hidden'); pending.resolve(f.handle); await settle();
        await reopen(h);
        expect(h.host.querySelector('[data-video-ai-shared-models]')!.textContent).toContain('已授权');
        expect(f.picker).toHaveBeenCalledOnce();
    });
});
function capture(predicate: (event: Captured) => boolean, handler: string) {
    const event = renderedEvents.findLast(item => predicate(item) && typeof item.props[handler] === 'function');
    expect(event, `actual template must produce ${handler}`).toBeDefined(); return event!.props[handler] as (...args: any[]) => any;
}
function downloadButton(host: HTMLElement, kind: Kind, model = 'tiny') {
    const selector = kind === 'tts' ? '[data-testid="local-tts-download"]' : `.video-model-card input[value="${model}"]`;
    const node = host.querySelector(selector)!;
    expect(node).not.toBeNull(); return (kind === 'tts' ? node : node.closest('.video-model-card')!.querySelector('button')) as HTMLButtonElement;
}
function uiReads(kind: Kind) {return ports.send.mock.calls.filter(([message]) => message.type === (kind === 'tts' ? 'fluentReadGetLocalTtsModelState' : videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE)).length;}
function progress(host: HTMLElement, kind: Kind, model = 'tiny') {return host.querySelector(kind === 'tts' ? '[data-testid="local-tts-progress"] progress' : `[data-video-model-progress="${model}"] progress`);}
async function hide(h: Awaited<ReturnType<typeof mount>>, reason: string) {if (reason === 'cached') h.cached.value = true; else h.state.active = false; await settle();}
async function reopen(h: Awaited<ReturnType<typeof mount>>) {h.cached.value = false; h.state.active = true; await settle();}

for (const kind of ['tts', 'video'] as const) describe(`${kind} actual mounted local model lifecycle`, () => {
    it.each(['hidden', 'cached'])('retires UI subscriptions and rejects queued progress/state callbacks after %s and return', async reason => {
        // Observe real DOM listener ports as well as storage; inactive guards alone must not hide leaked listeners.
        const viewEvents = [
            observeViewEventPort(dom.window, 'focus'),
            observeViewEventPort(dom.document, 'visibilitychange'),
        ];
        const h = await mount(kind), oldListeners = [...ports.listeners];
        if (kind === 'video') for (const event of viewEvents) expect(event.active.length).toBeGreaterThan(0);
        expect(oldListeners.length).toBeGreaterThan(0); await hide(h, reason);
        for (const event of viewEvents) expect(event.active).toEqual([]);
        const hiddenListeners = ports.listeners.size, reads = uiReads(kind), messages = ports.send.mock.calls.length;
        for (const listener of oldListeners) listener({[kind === 'tts' ? ttsModel.LOCAL_TTS_MODEL_STATE_KEY : videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: {}}, 'local');
        dom.window.dispatchEvent(new dom.window.Event('focus')); dom.document.dispatchEvent(new dom.window.Event('visibilitychange')); await settle();
        expect({hiddenListeners, reads: uiReads(kind), messages: ports.send.mock.calls.length}).toEqual({hiddenListeners: 0, reads, messages});
        await reopen(h); const currentReads = uiReads(kind);
        if (kind === 'video') for (const event of viewEvents) expect(event.active.length).toBeGreaterThan(0);
        const id = kind === 'tts' ? LOCAL_TTS_DOWNLOAD_ID : videoModelDownloadId('tiny');
        for (const listener of oldListeners) listener({[downloadProgressKey(id)]: {newValue: {loaded: 700_000, total: 800_000}}}, 'local');
        await settle(); expect(progress(h.host, kind)).toBeNull(); expect(uiReads(kind)).toBe(currentReads);
        h.stop();
        for (const event of viewEvents) expect(event.active).toEqual([]);
    });
    it('keeps the public background download alive while hidden and reconnects actual byte progress before cached completion', async () => {
        const h = await mount(kind), id = kind === 'tts' ? LOCAL_TTS_DOWNLOAD_ID : videoModelDownloadId('tiny');
        downloadButton(h.host, kind).click(); await settle(); await h.backend.chunk(id);
        expect(progress(h.host, kind)?.getAttribute('value')).toBe('200000'); expect(progress(h.host, kind)?.getAttribute('max')).toBe('800000');
        expect(h.host.textContent).toContain('25% · 0.2 MB / 0.8 MB');
        await hide(h, 'hidden'); const reads = uiReads(kind); await h.backend.chunk(id); expect(uiReads(kind)).toBe(reads);
        expect(h.backend.jobs.has(id)).toBe(true);
        await reopen(h); expect(uiReads(kind)).toBeGreaterThan(reads); await h.backend.chunk(id);
        expect(progress(h.host, kind)?.getAttribute('value')).toBe('600000'); expect(h.host.textContent).toContain('75% · 0.6 MB / 0.8 MB');
        await hide(h, 'hidden'); await h.backend.finish(id);
        expect(kind === 'tts' ? h.backend.values[ttsModel.LOCAL_TTS_MODEL_STATE_KEY].downloaded : h.backend.values[videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY].includes('tiny')).toBe(true);
        await reopen(h); expect(progress(h.host, kind)).toBeNull();
        expect(kind === 'tts' ? h.host.querySelector('[data-testid="local-tts-remove"]') : h.host.querySelector('.video-model-card .video-model-availability')?.textContent?.includes('可离线使用')).toBeTruthy();
        expect(kind === 'tts' ? h.backend.ttsOffscreen.prepare : h.backend.videoOffscreen.send).toHaveBeenCalledTimes(1);
    });
    it('ignores a late failed status read from the prior config object', async () => {
        const h = await mount(kind), gate = h.backend.holdRead(kind);
        for (const listener of [...ports.listeners]) listener({[kind === 'tts' ? ttsModel.LOCAL_TTS_MODEL_STATE_KEY : videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: {}}, 'local');
        await settle(); h.state.config = normalizeConfig({videoTranslationEnabled: true, selectionTtsMode: 'local-first'}); await settle();
        if (kind === 'tts') gate.resolve({success: false}); else gate.reject(new Error('OLD_CONTEXT_STATE_READ_FAILED'));
        await settle();
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
    });
    it('keeps background completion independent but excludes an old command error after hidden return/config replacement', async () => {
        const h = await mount(kind), id = kind === 'tts' ? LOCAL_TTS_DOWNLOAD_ID : videoModelDownloadId('tiny');
        downloadButton(h.host, kind).click(); await settle(); await hide(h, 'hidden');
        h.state.config = normalizeConfig({videoTranslationEnabled: true, selectionTtsMode: 'local-first'}); await reopen(h);
        await h.backend.finish(id, {success: false, error: 'OLD_CONTEXT_COMMAND_FAILED'});
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
    });
});

it('rechecks missing Small tokenizer on return and offers the existing repair download without erasing its receipt', async () => {
    const h = await mount('video');
    const model = 'small', id = videoModelDownloadId(model);
    h.backend.addVideoKeys(model);
    await h.backend.storage.set({[videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: [model]}); await settle();
    const card = h.host.querySelector('input[value="small"]')!.closest('.video-model-card')!;
    expect(card.querySelector('.video-model-availability')!.textContent).toContain('可离线使用');
    h.backend.videoKeys.delete(getVideoAiModelFileUrl(model, 'tokenizer.json'));
    dom.window.dispatchEvent(new dom.window.Event('focus')); await settle();
    expect(card.querySelector('.video-model-availability')!.textContent).toContain('尚未下载');
    expect(h.backend.values[videoPublic.VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]).toEqual([model]);
    expect(h.backend.videoOffscreen.send).not.toHaveBeenCalled();
    expect(card.querySelector('button')!.textContent).toContain('下载模型');
    downloadButton(h.host, 'video', model).click(); await settle(); await h.backend.chunk(id);
    expect(progress(h.host, 'video', model)?.getAttribute('value')).toBe('200000');
    await h.backend.finish(id);
    expect(card.querySelector('.video-model-availability')!.textContent).toContain('可离线使用');
    expect(h.backend.videoKeys.has(getVideoAiModelFileUrl(model, 'tokenizer.json'))).toBe(true);
    expect(h.backend.videoOffscreen.send).toHaveBeenCalledOnce();
});

it('coalesces simultaneous visibilitychange and focus return events into a single refresh batch', async () => {
    const h = await mount('video');
    const nowSpy = vi.spyOn(Date, 'now');
    try {
        let now = 0;
        nowSpy.mockImplementation(() => now);
        const before = ports.send.mock.calls.length;
        dom.document.dispatchEvent(new dom.window.Event('visibilitychange'));
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        await settle();
        const firstBatch = ports.send.mock.calls.length - before;
        expect(firstBatch).toBe(2); // model state + cache stats (not duplicated to 4, works even at timestamp 0)
        now += 350;
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        await settle();
        expect(ports.send.mock.calls.length - before).toBe(4);
    } finally {
        nowSpy.mockRestore();
        h.stop();
    }
});

describe('video model settings pure public contract', () => {
    it('loads the existing model and cache protocol without evaluating the player runtime', async () => {
        vi.resetModules();
        const evaluatePlayer = vi.fn(() => { throw new Error('model settings must not initialize the player runtime'); });
        vi.doMock('@/src/features/video-subtitle/content/runtime', evaluatePlayer);
        try {
            const protocol = await import('@/src/features/video-subtitle/domain/public');
            const transcription = await import('@/src/features/video-subtitle/transcription');
            const cache = await import('@/src/features/video-subtitle/transcriptionCache');
            expect(protocol.VIDEO_LOCAL_TRANSCRIPTION_MODELS).toBe(transcription.VIDEO_LOCAL_TRANSCRIPTION_MODELS);
            expect(protocol.normalizeVideoLocalTranscriptionModels).toBe(transcription.normalizeVideoLocalTranscriptionModels);
            expect(protocol.VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE).toBe(cache.VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE);
            expect(protocol.VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE).toBe(cache.VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE);
            expect(Object.keys(protocol).sort()).toEqual([
                'VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE', 'VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE',
                'VIDEO_LOCAL_TRANSCRIPTION_MODELS', 'VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL',
                'VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY', 'VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE',
                'normalizeVideoLocalTranscriptionModels',
            ].sort());
            expect(evaluatePlayer).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('@/src/features/video-subtitle/content/runtime');
        }
    });
});

describe('entire captured public template event belongs to its rendered config', () => {
    it('writes ordered online voices only from the current active template event', async () => {
        const h = await mount('tts'), config = h.state.config;
        const isOnline = (event: Captured) => event.tag === 'SelectPort' && event.props['aria-label'] === '划词翻译备用音色顺序';
        const online = capture(isOnline, 'onUpdate:modelValue');
        const voices = ['en-US-AriaNeural', 'zh-CN-XiaoxiaoMultilingualNeural'];
        online(voices); await settle();
        expect(config.selectionTtsVoices).toEqual(voices);

        await hide(h, 'hidden');
        const inactiveOnline = capture(isOnline, 'onUpdate:modelValue');
        online(['zh-CN-XiaoxiaoMultilingualNeural']); await settle();
        expect(config.selectionTtsVoices).toEqual(voices);
        inactiveOnline([]); await settle();
        expect(config.selectionTtsVoices).toEqual(voices);

        await reopen(h);
        online([]); await settle();
        expect(config.selectionTtsVoices).toEqual(voices);
        inactiveOnline(['zh-CN-XiaoxiaoMultilingualNeural']); await settle();
        expect(config.selectionTtsVoices).toEqual(voices);
        const currentOnline = capture(isOnline, 'onUpdate:modelValue');
        const reordered = [...voices].reverse();
        currentOnline(reordered); await settle();
        expect(config.selectionTtsVoices).toEqual(reordered);
        expect(h.state.config).toBe(config);
    });
    it('rejects old TTS mode/local voice/online voices updates after object replacement while current mode controls still work', async () => {
        const h = await mount('tts'), original = h.state.config;
        const mode = capture(event => event.tag === 'SegmentedControl' && event.props.label === 'settings.localTts.source', 'onUpdate:modelValue');
        const local = capture(event => event.tag === 'SelectPort' && event.props['aria-label'] === 'settings.localTts.voice', 'onUpdate:modelValue');
        const online = capture(event => event.tag === 'SelectPort' && event.props['aria-label'] === '划词翻译备用音色顺序', 'onUpdate:modelValue');
        h.state.config = normalizeConfig({selectionTtsMode: 'local-first', selectionTtsLocalVoice: 'zm_009', selectionTtsVoices: ['zh-CN-XiaoxiaoMultilingualNeural']}); await settle();
        const current = h.state.config, before = [original.selectionTtsMode, original.selectionTtsLocalVoice, [...original.selectionTtsVoices], current.selectionTtsMode, current.selectionTtsLocalVoice, [...current.selectionTtsVoices]];
        mode('local-only'); local('zf_001'); online(['en-US-AriaNeural']); await settle();
        expect([original.selectionTtsMode, original.selectionTtsLocalVoice, [...original.selectionTtsVoices], current.selectionTtsMode, current.selectionTtsLocalVoice, [...current.selectionTtsVoices]]).toEqual(before);
        const radio = [...h.host.querySelectorAll<HTMLButtonElement>('.speech-settings [role="radio"]')].find(button => button.textContent === 'settings.localTts.localOnly')!;
        expect(radio).toBeDefined(); radio.click(); await settle(); expect(current.selectionTtsMode).toBe('local-only');
        expect(h.host.querySelector('[data-testid="speech-online-voices"]')).toBeNull();
        const localSelect = h.host.querySelector<HTMLSelectElement>('select[aria-label="settings.localTts.voice"]')!;
        localSelect.value = 'zf_001'; localSelect.dispatchEvent(new dom.window.Event('change', {bubbles: true})); await settle();
        expect(current.selectionTtsLocalVoice).toBe('zf_001');
        const onlineOnly = [...h.host.querySelectorAll<HTMLButtonElement>('.speech-settings [role="radio"]')].find(button => button.textContent === 'settings.localTts.onlineOnly')!;
        onlineOnly.click(); await settle();
        expect(h.host.querySelector('[data-testid="speech-local-voice"]')).toBeNull();
        expect(h.host.querySelector('[data-testid="local-tts-model-row"]')).toBeNull();
        expect(current.selectionTtsLocalVoice).toBe('zf_001');
        expect(current.selectionTtsVoices).toEqual(['zh-CN-XiaoxiaoMultilingualNeural']);
        const localFirst = [...h.host.querySelectorAll<HTMLButtonElement>('.speech-settings [role="radio"]')].find(button => button.textContent === 'settings.localTts.localFirst')!;
        localFirst.click(); await settle();
        expect(h.host.querySelector<HTMLSelectElement>('select[aria-label="settings.localTts.voice"]')!.value).toBe('zf_001');
        expect(current.selectionTtsVoices).toEqual(['zh-CN-XiaoxiaoMultilingualNeural']);
    });
    it.each(['radio', 'card', 'download'] as const)('rejects the complete old video %s event before any config write or backend command', async control => {
        const h = await mount('video'), original = h.state.config;
        const handler = control === 'radio' ? capture(event => event.tag === 'input' && event.props.name === 'video-local-model' && event.props.value === 'base', 'onUpdate:modelValue')
            : control === 'card' ? capture(event => event.tag === 'article' && event.props.key === 'base', 'onClick')
            : capture(event => event.tag === 'button' && String(event.props['aria-label']).includes('video.modelDownloadAria') && String(event.props['aria-label']).includes('video.modelBaseName'), 'onClick');
        h.state.config = normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'tiny'}); await settle();
        const current = h.state.config, calls = ports.send.mock.calls.length;
        handler(control === 'radio' ? 'base' : new dom.window.Event('click')); await settle();
        expect(original.videoLocalModel).toBe('tiny'); expect(current.videoLocalModel).toBe('tiny'); expect(ports.send).toHaveBeenCalledTimes(calls);
        const radio = h.host.querySelector<HTMLInputElement>('input[name="video-local-model"][value="base"]')!;
        radio.checked = true; radio.dispatchEvent(new dom.window.Event('change', {bubbles: true})); await settle(); expect(current.videoLocalModel).toBe('base');
    });
});

it('observes a download started by another page and rereads authoritative completion without sending a duplicate prepare', async () => {
    const h = await mount('tts');
    const externalCommand = browser.runtime.sendMessage({type: 'fluentReadPrepareLocalTtsModel'});
    await settle(); await h.backend.chunk(LOCAL_TTS_DOWNLOAD_ID);
    expect(progress(h.host, 'tts')?.getAttribute('value')).toBe('200000');
    expect(h.host.textContent).toContain('25% · 0.2 MB / 0.8 MB');
    expect(downloadButton(h.host, 'tts').disabled).toBe(true);
    downloadButton(h.host, 'tts').click(); await settle();
    expect(h.backend.ttsOffscreen.prepare).toHaveBeenCalledOnce();
    const reads = uiReads('tts');
    await h.backend.finish(LOCAL_TTS_DOWNLOAD_ID); await externalCommand; await settle();
    expect(uiReads('tts')).toBeGreaterThan(reads);
    expect(progress(h.host, 'tts')).toBeNull();
    expect(h.host.querySelector('[data-testid="local-tts-remove"]')).not.toBeNull();
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
});

it('keeps an installed TTS model available after removal fails and lets the current control retry successfully', async () => {
    const h = await mount('tts');
    await h.backend.storage.set({[ttsModel.LOCAL_TTS_MODEL_STATE_KEY]: {
        model: ttsModel.LOCAL_TTS_MODEL_ID, downloaded: true, downloadSizeMb: ttsModel.LOCAL_TTS_MODEL.downloadSizeMb,
    }}); await settle();
    h.backend.ttsOffscreen.remove.mockRejectedValueOnce(new Error('controlled model removal failure'));
    h.host.querySelector<HTMLButtonElement>('[data-testid="local-tts-remove"]')!.click(); await settle();
    expect(h.host.querySelector('[role="alert"]')!.textContent).toContain('controlled model removal failure');
    expect(h.backend.values[ttsModel.LOCAL_TTS_MODEL_STATE_KEY].downloaded).toBe(true);
    const retry = h.host.querySelector<HTMLButtonElement>('[data-testid="local-tts-remove"]')!;
    expect(retry.disabled).toBe(false);
    retry.click(); await settle();
    expect(h.backend.ttsOffscreen.remove).toHaveBeenCalledTimes(2);
    expect(h.backend.values[ttsModel.LOCAL_TTS_MODEL_STATE_KEY].downloaded).toBe(false);
    expect(h.host.querySelector('[data-testid="local-tts-remove"]')).toBeNull();
    expect(downloadButton(h.host, 'tts').disabled).toBe(false);
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
});

it('keeps compact progress accessible and clears a previous percentage when the current transfer has no total', async () => {
    const state = Vue.reactive<{progress?: progressModule.DownloadProgress; label: string; detail: 'percent' | 'none'}>({
        progress: {loaded: 200_000, total: 800_000}, label: '本地朗读模型下载', detail: 'percent',
    });
    const host = dom.document.createElement('div'); dom.document.body.append(host);
    const app = Vue.createApp({render: () => Vue.h(DownloadProgress, state)});
    apps.add(app); app.mount(host); await settle();
    expect(host.querySelector('progress')!.getAttribute('aria-label')).toBe('本地朗读模型下载');
    expect(host.querySelector('.download-progress-detail')!.textContent).toBe('25%');
    expect(host.querySelector('[aria-live]')).toBeNull();
    state.progress = {loaded: 200_000, total: 0}; await settle();
    expect(host.querySelector('progress')!.hasAttribute('value')).toBe(false);
    expect(host.querySelector('progress')!.hasAttribute('max')).toBe(false);
    expect(host.querySelector('.download-progress-detail')!.textContent).toBe('0.2 MB');
    state.detail = 'none'; await settle();
    expect(host.querySelector('.download-progress-detail')).toBeNull();
    expect(host.querySelector('progress')!.getAttribute('aria-label')).toBe('本地朗读模型下载');
});

// 回包隔离不能把重新进入的视图永久留在下载中；未发布进度的失败没有 storage 删除事件。
for (const kind of ['tts', 'video'] as const) it(`${kind} final ui-settings pending download releases retry after hidden return without progress`, async () => {
    const h = await mount(kind), gate = deferred<any>();
    const prepare = kind === 'tts' ? h.backend.ttsOffscreen.prepare : h.backend.videoOffscreen.send;
    prepare.mockReturnValueOnce(gate.promise);
    downloadButton(h.host, kind).click(); await settle();
    expect(prepare).toHaveBeenCalledTimes(1);
    await hide(h, 'hidden'); await reopen(h);
    expect(downloadButton(h.host, kind).disabled).toBe(true);
    gate.reject(new Error('OLD_CONTEXT_PREPARATION_FAILED_BEFORE_PROGRESS')); await settle();
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
    expect(downloadButton(h.host, kind).disabled).toBe(false);
    downloadButton(h.host, kind).click(); await settle();
    expect(prepare).toHaveBeenCalledTimes(2);
});

describe('automatic video model download through the mounted public UI', () => {
    function requestPreferences() {
        return ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadPrepareLocalVideoModel').map(([message]) => message.preference);
    }
    function expectSourcesHidden(host: HTMLElement) {
        expect(host.querySelector('[data-video-model-source]')).toBeNull();
        expect(host.querySelector('[data-video-model-transfer]')).toBeNull();
        expect(host.querySelector('a[href*="huggingface"], a[href*="hf-mirror"], a[href*="modelscope"]')).toBeNull();
        expect(host.textContent).not.toMatch(/Hugging Face|HF Mirror|ModelScope|video\.downloadSource|video\.downloadConnecting|video\.downloadSwitching|video\.downloadReceiving|下载来源|模型来源/iu);
    }
    it('automatically prepares each model without exposing source controls or provider links', async () => {
        const h = await mount('video');
        expectSourcesHidden(h.host);
        downloadButton(h.host, 'video', 'small').click(); await settle();
        expect(requestPreferences()).toEqual(['auto']);
        expect(progress(h.host, 'video', 'small')?.hasAttribute('value')).toBe(false);
        expectSourcesHidden(h.host);
        await h.backend.finish(videoModelDownloadId('small'));
        downloadButton(h.host, 'video', 'base').click(); await settle();
        expect(requestPreferences()).toEqual(['auto', 'auto']);
        expectSourcesHidden(h.host);
    });
    it('keeps providers invisible while connecting, retrying another connection and receiving real bytes', async () => {
        const h = await mount('video'), id = videoModelDownloadId('small');
        downloadButton(h.host, 'video', 'small').click(); await settle();
        expect(progress(h.host, 'video', 'small')?.hasAttribute('value')).toBe(false);
        await h.backend.transfer(id, {source: 'modelscope', attempt: 1, attempts: 3, state: 'connecting'});
        expectSourcesHidden(h.host);
        expect(progress(h.host, 'video', 'small')?.getAttribute('value')).toBe('0');
        await h.backend.transfer(id, {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'connecting'});
        expectSourcesHidden(h.host);
        expect(progress(h.host, 'video', 'small')?.getAttribute('value')).toBe('0');
        await h.backend.transfer(id, {source: 'huggingface', attempt: 3, attempts: 3, state: 'receiving'}, 200_000);
        expectSourcesHidden(h.host);
        expect(h.host.textContent).toContain('25% · 0.2 MB / 0.8 MB');
        await h.backend.transfer(id, {source: 'other', attempt: 1, attempts: 1, state: 'receiving'}, 200_000, 0);
        expectSourcesHidden(h.host);
        expect(progress(h.host, 'video', 'small')?.hasAttribute('value')).toBe(false);
        expect(h.host.textContent).toContain('0.2 MB');
        await h.backend.chunk(id);
        expectSourcesHidden(h.host);
        expect(progress(h.host, 'video', 'small')?.getAttribute('value')).toBe('200000');
        await h.backend.finish(id);
        expect(progress(h.host, 'video', 'small')).toBeNull();
        expectSourcesHidden(h.host);
    });
    it('offers retry after failure with automatic download and excludes provider diagnostics from the error', async () => {
        const h = await mount('video'), id = videoModelDownloadId('small');
        downloadButton(h.host, 'video', 'small').click(); await settle();
        expect(requestPreferences()).toEqual(['auto']);
        await h.backend.finish(id, {success: false, error: 'Hugging Face / HF Mirror / ModelScope ALL_SOURCES_FAILED'});
        const button = downloadButton(h.host, 'video', 'small');
        expect(button.disabled).toBe(false); expect(button.textContent!.trim()).toBe('video.downloadRetry');
        expect(h.host.querySelector('[role="alert"]')!.textContent).toBe('模型下载失败，请检查网络后重试');
        expectSourcesHidden(h.host);
        button.click(); await settle();
        expect(requestPreferences()).toEqual(['auto', 'auto']);
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
        expect(downloadButton(h.host, 'video', 'small').disabled).toBe(true);
        await h.backend.finish(id);
        expect(progress(h.host, 'video', 'small')).toBeNull();
    });
    it('keeps downloads automatic after config replacement and disabling then enabling video translation', async () => {
        const h = await mount('video');
        h.state.config = normalizeConfig({videoTranslationEnabled: true}); await settle();
        downloadButton(h.host, 'video', 'tiny').click(); await settle();
        expect(requestPreferences()).toEqual(['auto']);
        await h.backend.finish(videoModelDownloadId('tiny'));
        h.state.config.videoTranslationEnabled = false; await settle();
        const disabledButton = downloadButton(h.host, 'video', 'base');
        expect(disabledButton.disabled).toBe(true);
        expectSourcesHidden(h.host);
        h.state.config.videoTranslationEnabled = true; await settle();
        downloadButton(h.host, 'video', 'base').click(); await settle();
        expect(requestPreferences()).toEqual(['auto', 'auto']);
    });
    it('rejects old connection progress and retry error after reactivating the view', async () => {
        const h = await mount('video'), id = videoModelDownloadId('small');
        downloadButton(h.host, 'video', 'small').click(); await settle();
        await h.backend.transfer(id, {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'connecting'});
        const oldListeners = [...ports.listeners]; await hide(h, 'hidden'); await reopen(h);
        for (const listener of oldListeners) listener({[downloadProgressKey(id)]: {newValue: {loaded: 700_000, total: 800_000, transfer: {source: 'huggingface', attempt: 3, attempts: 3, state: 'connecting'}}}}, 'local');
        await settle();
        expect(progress(h.host, 'video', 'small')?.getAttribute('value')).not.toBe('700000');
        expect(h.host.textContent).not.toContain('87%');
        expectSourcesHidden(h.host);
        await h.backend.finish(id, {success: false, error: 'OLD_SOURCE_FAILURE'});
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
        expect(downloadButton(h.host, 'video', 'small').textContent).not.toBe('video.downloadRetry');
    });
});
