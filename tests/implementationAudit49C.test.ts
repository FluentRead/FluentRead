import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

// 使用 runtime-dom 和真实 SFC/template；DOM、UI 控件、配置持久化边界与后台消息端口受控。
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
    return {document};
});
const ports = vi.hoisted(() => ({
    config: {} as any, listeners: new Set<(config: any) => void>(), storageListeners: new Set<(changes: any, area: string) => void>(),
    history: {} as any, historyListeners: new Set<(history: any) => void>(), messages: vi.fn(),
    delayDialogClosed: false, pendingDialogClosed: new Set<() => void>(),
    send: vi.fn(), patch: vi.fn(), confirm: vi.fn(), get: vi.fn(), exportConfig: vi.fn(),
    browserCapabilities: {extensionDom: true},
    brand: '流畅阅读',
    backupLabelTranslation: '',
    renderedEvents: [] as Array<{tag: unknown; props: any; node: any}>,
}));
// 记录真实 SFC 向 Vue 公开 render API 交出的完整事件，模拟排队后迟到的旧模板事件。
// 不读取 setupState、DOM 私有 invoker，也不复写组件内部业务函数。
vi.mock('vue', async () => {
    const actual = await vi.importActual<typeof import('vue')>('vue');
    const exposed: any = {...actual};
    for (const key of ['createVNode', 'createBlock', 'createElementVNode', 'createElementBlock'] as const) {
        exposed[key] = (...args: any[]) => {
            const node = (actual[key] as any)(...args);
            if (args[1]) ports.renderedEvents.push({tag: args[0], props: {...args[1]}, node});
            return node;
        };
    }
    return exposed;
});
vi.mock('@/src/ui/i18n', async () => {
    const {ref} = await import('vue');
    return {useUiI18n: () => ({t: (key: string) => key === 'common.brand' ? ports.brand : key,
        translateLegacy: (value: string) => value === 'FluentRead 备份' && ports.backupLabelTranslation ? ports.backupLabelTranslation : value, language: ref('zh-CN')})};
});
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: ports.browserCapabilities}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus/es/components/message-box/style/css', () => ({}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: unknown[]) => ports.send(...args)},
    storage: {local: {get: (...args: unknown[]) => ports.get(...args)}, onChanged: {addListener: (listener: any) => ports.storageListeners.add(listener), removeListener: (listener: any) => ports.storageListeners.delete(listener)}}}}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {
    writeOwner: false, getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, watch: () => () => undefined,
}}));
vi.mock('@/src/services/config/store', async () => ({
    ...await vi.importActual<typeof import('@/src/services/config/store')>('@/src/services/config/store'),
    config: ports.config, configReady: Promise.resolve(), configHistoryReady: Promise.resolve(),
    getConfigHistorySnapshot: () => structuredClone(ports.history),
    subscribeConfigHistory: (listener: (history: any) => void) => {ports.historyListeners.add(listener); return () => ports.historyListeners.delete(listener);},
    requestConfigPatch: (...args: unknown[]) => ports.patch(...args),
    prepareHydratedConfigForExport: () => ports.exportConfig(),
    subscribeConfig: (listener: (config: any) => void) => {ports.listeners.add(listener); return () => ports.listeners.delete(listener);},
}));
vi.mock('element-plus', async () => {
    const {defineComponent, h, onUnmounted, ref, watch} = await import('vue');
    const Select = defineComponent({props: ['modelValue'], emits: ['update:modelValue', 'change'], setup(props, {attrs, slots, emit, expose}) {
        expose({focus() {}, blur() {}});
        return () => h('select', {...attrs, value: props.modelValue, onChange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value; emit('update:modelValue', value); emit('change', value);
        }}, slots.default?.());
    }});
    const Option = defineComponent({props: ['value', 'label'], setup: props => () => h('option', {value: props.value}, props.label)});
    const Slot = defineComponent({setup: (_, {slots}) => () => h('span', slots.default?.())});
    const Dialog = defineComponent({props: ['modelValue'], emits: ['closed', 'update:modelValue'], setup(props, {slots, emit}) {
        const rendered = ref(Boolean(props.modelValue));
        let closing: (() => void) | undefined;
        watch(() => props.modelValue, value => {
            if (closing) {ports.pendingDialogClosed.delete(closing); closing = undefined;}
            if (value) {rendered.value = true; return;}
            const closed = () => {ports.pendingDialogClosed.delete(closed); closing = undefined; rendered.value = false; emit('closed');};
            if (ports.delayDialogClosed) {closing = closed; ports.pendingDialogClosed.add(closed);} else closed();
        });
        onUnmounted(() => {if (closing) ports.pendingDialogClosed.delete(closing);});
        return () => rendered.value ? h('div', {'data-dialog-visible': String(Boolean(props.modelValue)), 'aria-hidden': !props.modelValue}, [...slots.default?.() ?? [], ...slots.footer?.() ?? [],
            h('button', {'data-dialog-close': '', onClick: () => emit('update:modelValue', false)}, 'Close')]) : null;
    }});
    const Button = defineComponent({props: ['disabled', 'loading', 'nativeType', 'type'], setup: (props, {attrs, slots}) => () => h('button', {...attrs, disabled: props.disabled || props.loading, type: props.nativeType || 'button'}, slots.default?.())});
    const NumberInput = defineComponent({props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup: (props, {attrs, emit}) => () => h('input', {...attrs, type: 'number', value: props.modelValue, disabled: props.disabled,
        onInput: (event: Event) => emit('update:modelValue', Number((event.target as HTMLInputElement).value))})});
    const Switch = defineComponent({props: ['modelValue', 'disabled'], emits: ['change'], setup: (props, {attrs, emit}) => () => h('input', {...attrs, type: 'checkbox', checked: props.modelValue, disabled: props.disabled, onChange: (event: Event) => emit('change', (event.target as HTMLInputElement).checked)})});
    // 本组选择端口不验证鼠标外部点击；该公开导出由共享 UI 指令测试与真实浏览器负责。
    return {ClickOutside: {}, ElSelect: Select, ElOption: Option, ElTooltip: Slot, ElDialog: Dialog, ElButton: Button, ElInputNumber: NumberInput, ElSwitch: Switch,
        ElMessage: {success: (...args: unknown[]) => ports.messages('success', ...args), error: (...args: unknown[]) => ports.messages('error', ...args)},
        ElMessageBox: {confirm: (...args: unknown[]) => ports.confirm(...args)}};
});
// 子页面不属于恢复确认入口；保留真实 ConfigManagement 的 template、diff 与公开配置客户端。
vi.mock('@/src/features/settings/ui/CloudConfigBackup.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/settings/ui/LocalDataManagement.vue', () => ({default: {render: () => null}}));

import {createApp, defineComponent, h, KeepAlive, nextTick, reactive, ref, type App, type Component, type PropType} from 'vue';
import browser from 'webextension-polyfill';
import GlossarySettings from '@/src/features/glossary/ui/GlossarySettings.vue';
import LocalTtsSettings from '@/src/features/settings/ui/LocalTtsSettings.vue';
import LearningMemoryManager from '@/src/features/settings/ui/LearningMemoryManager.vue';
import HarnessReadingHistory from '@/src/features/reading-assistant/ui/HarnessReadingHistory.vue';
import VideoLocalModelSettings from '@/src/features/settings/ui/VideoLocalModelSettings.vue';
import ConfigManagement from '@/src/features/settings/ui/ConfigManagement.vue';
import LocalDataManagementStub from '@/src/features/settings/ui/LocalDataManagement.vue';
import TranslationCacheSettings from '@/src/features/settings/ui/TranslationCacheSettings.vue';
import {normalizeConfig, type Config} from '@/src/core/config/model';
import {createGlossaryLibrary} from '@/src/core/glossary';
import {LOCAL_TTS_MODEL_STATE_KEY} from '@/src/core/config/localTts';
import {createDriveAuth, DriveError, type DriveAuthPorts} from '@/src/platform/google-drive/auth';
import {createDriveApi} from '@/src/platform/google-drive/api';
import {GOOGLE_DRIVE_SCOPES, GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_ID, GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavSession, type WebDavConnection} from '@/src/platform/webdav/connection';
import {listSitePreferences, previewSitePreferences, type SitePreferences} from '@/src/features/settings/model/sitePreferences';
import {VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY, VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE} from '@/src/features/video-subtitle/transcription';
import {getVideoAiModelFileUrl, VIDEO_AI_Q4_MODEL_FILES, VIDEO_AI_SMALL_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';
import {VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE, VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE} from '@/src/features/video-subtitle/transcriptionCache';
import {createVideoSubtitleBackgroundHandlers} from '@/src/features/video-subtitle/background/handlers';
import type {OffscreenResponseMap, VideoTranscriptionModel} from '@/src/core/messaging/offscreen';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';
import {downloadProgressKey, videoModelDownloadId} from '@/src/core/download/progress';
import {appendConfigHistorySnapshot, toRestorableConfig} from '@/src/services/config/history';
import {appendConfigAutoBackup} from '@/src/services/config/autoBackup';
import {getConfigAutoBackupsSnapshot} from '@/src/services/config/autoBackupStore';
import {prepareConfigForExport} from '@/src/core/config/transfer';
import {VOCABULARY_BOOK_MESSAGE} from '@/src/features/vocabulary/public';
import {createFluentReadDataBackup} from '@/src/features/settings/model/dataBackup';

// 此组绕过恢复页原有的子页面 stub，执行真实本机备份 SFC；确认遮罩、下载和 IO 端口受控。
const ActualLocalDataManagement = (await vi.importActual<typeof import('@/src/features/settings/ui/LocalDataManagement.vue')>(
    '@/src/features/settings/ui/LocalDataManagement.vue',
)).default;

const apps = new Set<App>();
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (failure: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
async function settle() {for (let index = 0; index < 12; index++) {await Promise.resolve(); await nextTick();}}
async function mount(component: Component, props: Record<string, unknown> = {}, keepAlive = false) {
    const host = dom.document.createElement('div'); dom.document.body.append(host);
    const state = reactive(props), shown = ref(true);
    const app = createApp({setup: () => () => keepAlive
        ? h(KeepAlive, null, {default: () => shown.value ? h(component, state) : h('div', {key: 'other'})})
        : h(component, state)});
    const elementPlus = await import('element-plus');
    app.component('el-select', elementPlus.ElSelect); app.component('el-option', elementPlus.ElOption); app.component('el-dialog', elementPlus.ElDialog);
    app.component('el-button', elementPlus.ElButton); app.component('el-input-number', elementPlus.ElInputNumber); app.component('el-switch', elementPlus.ElSwitch);
    // 真实 textarea 只实现输入控件公开的 v-model 端口；JSON 解析、预览和归属规则由产品 SFC 执行。
    app.component('el-input', defineComponent({props: ['modelValue', 'type', 'rows'], emits: ['update:modelValue'], setup: (props, {attrs, emit}) => () => h('textarea', {
        ...attrs, rows: props.rows, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    })}));
    apps.add(app); app.mount(host); await settle();
    return {host, state, shown, stop: () => {app.unmount(); apps.delete(app);}};
}
function input(host: HTMLElement, selector: string, value: string, change = true) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    expect(field).not.toBeNull(); field.value = value; field.dispatchEvent(new Event('input', {bubbles: true}));
    if (change) field.dispatchEvent(new Event('change', {bubbles: true}));
}
function storageChanged() {for (const listener of ports.storageListeners) listener({[LOCAL_TTS_MODEL_STATE_KEY]: {}}, 'local');}
beforeEach(() => {
    // WXT supplies this auto-import to the real progress watcher in the extension.
    vi.stubGlobal('browser', browser);
    ports.send.mockReset(); ports.patch.mockReset(); ports.confirm.mockReset(); ports.get.mockReset(); ports.messages.mockReset();
    ports.exportConfig.mockReset();
    ports.delayDialogClosed = false;
    ports.browserCapabilities.extensionDom = true; ports.renderedEvents.length = 0;
    ports.brand = '流畅阅读';
    ports.backupLabelTranslation = '';
    for (const key of Object.keys(ports.config)) delete ports.config[key];
    Object.assign(ports.config, normalizeConfig({glossaryEnabled: true, glossaryLibraries: [{...createGlossaryLibrary([]), name: 'Original'}]}));
    ports.history = {schemaVersion: 1, cursor: 1, nextVersion: 3, entries: [
        {version: 1, savedAt: '2026-10-05T00:00:00Z', config: toRestorableConfig(normalizeConfig({on: false}))},
        {version: 2, savedAt: '2026-10-05T00:01:00Z', config: toRestorableConfig(normalizeConfig({on: true}))},
    ]};
    ports.patch.mockImplementation(async (patch: any) => {Object.assign(ports.config, patch); for (const listener of ports.listeners) listener(ports.config);});
    ports.confirm.mockResolvedValue(undefined);
});
afterEach(async () => {
    for (const app of apps) app.unmount(); apps.clear(); await settle();
    expect(ports.listeners.size).toBe(0); expect(ports.storageListeners.size).toBe(0);
    expect(ports.historyListeners.size).toBe(0);
    expect(ports.pendingDialogClosed.size).toBe(0);
    dom.document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals();
    ports.renderedEvents.length = 0;
});

function authFixture() {
    const identity = {getAuthToken: vi.fn(async () => ({token: 'token-A', grantedScopes: [...GOOGLE_DRIVE_SCOPES]})),
        removeCachedAuthToken: vi.fn(async (_details: {token: string}) => undefined), clearAllCachedAuthTokens: vi.fn(async () => undefined)};
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({user: {permissionId: 'A'}})));
    const authPorts: DriveAuthPorts = {userAgent: () => 'Chrome/142.0', identity, fetch: fetcher,
        runtime: {id: GOOGLE_DRIVE_EXTENSION_ID, getManifest: () => ({oauth2: {client_id: GOOGLE_DRIVE_DEFAULT_CLIENT_ID, scopes: [...GOOGLE_DRIVE_SCOPES]}})}};
    return {identity, fetcher, auth: createDriveAuth(authPorts)};
}
describe('audit49C Google account ownership through the public session', () => {
    it.each(['other-account', 'invalid-account', 'account-network'] as const)('never retains an unverified refreshed token after %s', async failure => {
        const fixture = authFixture(); const session = await fixture.auth.open();
        fixture.identity.getAuthToken.mockResolvedValue({token: 'token-B', grantedScopes: [...GOOGLE_DRIVE_SCOPES]});
        if (failure === 'account-network') fixture.fetcher.mockRejectedValue(new Error('fixture failed'));
        else fixture.fetcher.mockResolvedValue(new Response(JSON.stringify({user: failure === 'other-account' ? {permissionId: 'B'} : {emailAddress: 'unbound'}})));
        await expect(session.request(async () => {throw new DriveError('expired', 401);})).rejects.toBeInstanceOf(DriveError);
        const later = vi.fn(async (token: string) => token);
        expect(await session.request(later)).toBe('token-A'); expect(later).toHaveBeenCalledWith('token-A');
        expect(session.account.id).toBe('drive:A'); expect(JSON.stringify(session)).not.toContain('token-B');
    });
    it('refreshes within the same account and reuses only the verified replacement', async () => {
        const fixture = authFixture(); const session = await fixture.auth.open();
        fixture.identity.getAuthToken.mockResolvedValue({token: 'token-A2', grantedScopes: [...GOOGLE_DRIVE_SCOPES]});
        const operation = vi.fn(async (token: string) => {if (token === 'token-A') throw new DriveError('expired', 401); return token;});
        expect(await session.request(operation)).toBe('token-A2'); expect(await session.request(async token => token)).toBe('token-A2');
        expect(fixture.identity.removeCachedAuthToken).toHaveBeenCalledWith({token: 'token-A'});
    });
    it('evicts the token used by each concurrent failing request', async () => {
        const fixture = authFixture(); const session = await fixture.auth.open();
        const late = deferred<void>(); const started = deferred<void>();
        fixture.identity.getAuthToken.mockResolvedValue({token: 'token-A2', grantedScopes: [...GOOGLE_DRIVE_SCOPES]});
        const pending = session.request(async token => {if (token === 'token-A') {started.resolve(); await late.promise; throw new DriveError('expired', 401);} return token;});
        await started.promise;
        await session.request(async token => {if (token === 'token-A') throw new DriveError('expired', 401); return token;});
        late.resolve(); expect(await pending).toBe('token-A2');
        expect(fixture.identity.removeCachedAuthToken.mock.calls.map(([details]) => details.token)).toEqual(['token-A', 'token-A']);
    });
});

const driveSession = {account: {id: 'fixture-account', email: ''}, request: async <T>(operation: (token: string) => Promise<T>) => operation('fixture-token')};
const connection: WebDavConnection = {url: 'https://fixture.invalid/dav/', username: 'fixture', password: 'synthetic-only', allowInsecure: false, revision: 'fixture-v1'};
const davSession = createWebDavSession(connection, async () => connection);
function openBody(status: number, rejecting = false, headers: Record<string, string> = {}) {
    const cancel = vi.fn(() => rejecting ? Promise.reject(new Error('fixture cleanup failed')) : undefined);
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new TextEncoder().encode('unread fixture'));}, cancel});
    return {response: new Response(body, {status, headers}), cancel};
}
describe('audit49C cloud response lifetime through public APIs', () => {
    it.each([200, 404, 403, 412, 500])('releases an unread Drive DELETE body for HTTP %s', async status => {
        const fixture = openBody(status); const fetcher = vi.fn<typeof fetch>(async () => fixture.response);
        const operation = createDriveApi(fetcher).remove(driveSession, {id: 'one', version: '1', modifiedTime: '', etag: '"one"'});
        if (status < 300 || status === 404) await operation; else await expect(operation).rejects.toMatchObject({status});
        expect(fixture.cancel).toHaveBeenCalledOnce();
    });
    it.each([404, 401, 412, 500])('releases an unread WebDAV GET body for HTTP %s', async status => {
        const fixture = openBody(status); const api = createWebDavApi(vi.fn(async () => fixture.response));
        if (status === 404) expect(await api.read(davSession)).toBeNull(); else await expect(api.read(davSession)).rejects.toMatchObject({status});
        expect(fixture.cancel).toHaveBeenCalledOnce();
    });
    it('releases an account-error body and keeps the original HTTP error if cleanup rejects', async () => {
        const fixture = authFixture(); const stream = openBody(403, true); fixture.fetcher.mockResolvedValue(stream.response);
        await expect(fixture.auth.open()).rejects.toMatchObject({status: 403}); expect(stream.cancel).toHaveBeenCalledOnce();
    });
    it('cancels before acquiring a reader when WebDAV rejects content-length', async () => {
        const fixture = openBody(200, false, {'content-length': '100'});
        await expect(createWebDavApi(vi.fn(async () => fixture.response), {maxBytes: 10}).read(davSession)).rejects.toMatchObject({code: 'tooLarge'});
        expect(fixture.cancel).toHaveBeenCalledOnce();
    });
    it('keeps a WebDAV status error when its body cancellation rejects', async () => {
        const fixture = openBody(423, true);
        await expect(createWebDavApi(vi.fn(async () => fixture.response)).read(davSession)).rejects.toMatchObject({code: 'locked', status: 423});
        expect(fixture.cancel).toHaveBeenCalledOnce();
    });
    it('preserves a streaming WebDAV size error when reader cleanup rejects and releases its lock', async () => {
        const fixture = openBody(200, true);
        await expect(createWebDavApi(vi.fn(async () => fixture.response), {maxBytes: 3}).read(davSession)).rejects.toMatchObject({code: 'tooLarge'});
        expect(fixture.cancel).toHaveBeenCalledOnce(); expect(fixture.response.body!.locked).toBe(false);
    });
    it('releases a Drive media body rejected by its declared size before acquiring a reader', async () => {
        const fixture = openBody(200, false, {'content-length': String(GOOGLE_DRIVE_MAX_BYTES + 1)});
        const metadata = {id: 'one', version: '1', modifiedTime: ''};
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({files: [metadata]})))
            .mockResolvedValueOnce(new Response(JSON.stringify(metadata))).mockResolvedValueOnce(fixture.response);
        await expect(createDriveApi(fetcher).read(driveSession)).rejects.toThrow('同步文件过大'); expect(fixture.cancel).toHaveBeenCalledOnce();
    });
    it('releases a Drive reader lock after invalid UTF-8 while keeping the sanitized error', async () => {
        const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array([255])); controller.close();}});
        const response = new Response(body); const metadata = {id: 'one', version: '1', modifiedTime: ''};
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({files: [metadata]})))
            .mockResolvedValueOnce(new Response(JSON.stringify(metadata))).mockResolvedValueOnce(response);
        await expect(createDriveApi(fetcher).read(driveSession)).rejects.toThrow('网络请求失败或响应无效'); expect(body.locked).toBe(false);
    });
});

describe('audit49C glossary metadata in the real client template', () => {
    it.each(['name', 'domains'] as const)('rolls back a rejected %s submission and supports a real retry', async field => {
        const {host} = await mount(GlossarySettings);
        host.querySelector<HTMLButtonElement>('.glossary-settings-toggle')!.click(); await settle();
        const selector = field === 'name' ? '.glossary-metadata input' : '.glossary-metadata textarea';
        const value = field === 'name' ? 'Edited name' : ' docs.example.com ';
        ports.patch.mockRejectedValueOnce(new Error('controlled persistence failure'));
        input(host, selector, value); await settle();
        expect(host.querySelector<HTMLInputElement>(selector)!.value).toBe(field === 'name' ? 'Original' : '');
        expect(host.querySelector('[role="alert"]')!.textContent).toContain('glossary.saveFailed');
        input(host, selector, value); await settle();
        expect(ports.config.glossaryLibraries[0][field]).toEqual(field === 'name' ? value : ['docs.example.com']);
        expect(host.querySelector<HTMLInputElement>(selector)!.value).toBe(field === 'name' ? value : 'docs.example.com');
    });
    it.each(['name', 'domains'] as const)('keeps a newer %s draft when an older submission rejects', async field => {
        const {host} = await mount(GlossarySettings); const save = deferred<void>();
        ports.patch.mockImplementationOnce(() => save.promise);
        const selector = field === 'name' ? '.glossary-metadata input' : '.glossary-metadata textarea';
        input(host, selector, field === 'name' ? 'Submitted' : 'submitted.example'); await settle();
        const newer = field === 'name' ? 'Still editing' : 'later.example'; input(host, selector, newer, false);
        save.reject(new Error('controlled failure')); await settle();
        expect(host.querySelector<HTMLInputElement>(selector)!.value).toBe(newer);
        expect(ports.config.glossaryLibraries[0][field]).toEqual(field === 'name' ? 'Original' : []);
    });
    it('keeps newer typed text when an older successful save returns', async () => {
        const {host} = await mount(GlossarySettings); const save = deferred<void>();
        ports.patch.mockImplementationOnce(async (patch: any) => {await save.promise; Object.assign(ports.config, patch);});
        input(host, '.glossary-metadata input', 'Submitted'); await settle();
        input(host, '.glossary-metadata input', 'Still typing', false); save.resolve(); await settle();
        expect(ports.config.glossaryLibraries[0].name).toBe('Submitted'); expect(host.querySelector<HTMLInputElement>('.glossary-metadata input')!.value).toBe('Still typing');
    });
    it('binds failure drafts to the library and unsubscribes on repeated mounts', async () => {
        ports.config.glossaryLibraries.push({...createGlossaryLibrary(ports.config.glossaryLibraries), name: 'Second'});
        const first = await mount(GlossarySettings); ports.patch.mockRejectedValueOnce(new Error('fixture'));
        input(first.host, '.glossary-metadata input', 'First draft'); await settle();
        const other = Array.from(first.host.querySelectorAll<HTMLButtonElement>('.glossary-library-name')).find(button => button.textContent?.includes('Second'))!;
        other.click(); await settle(); expect(first.host.querySelector<HTMLInputElement>('.glossary-metadata input')!.value).toBe('Second');
        first.stop(); expect(ports.listeners.size).toBe(0);
        const second = await mount(GlossarySettings); expect(ports.listeners.size).toBe(1); second.stop(); expect(ports.listeners.size).toBe(0);
    });
});

describe('audit49C local TTS lifecycle through real controls and backend messages', () => {
    it.each(['download', 'remove'] as const)('does not let an older status read undo completed %s', async operation => {
        ports.send.mockResolvedValue({success: true, downloaded: operation === 'remove'});
        const {host} = await mount(LocalTtsSettings, {config: normalizeConfig({})});
        const stale = deferred<unknown>(); ports.send.mockImplementationOnce(() => stale.promise);
        storageChanged(); await settle();
        // Current main reconciles the authoritative state after every model command.
        // Keep the captured old read stale, but let the terminal read see the completed operation.
        ports.send.mockResolvedValue({success: true, downloaded: operation === 'download'});
        host.querySelector<HTMLButtonElement>(`[data-testid="local-tts-${operation}"]`)!.click(); await settle();
        stale.resolve({success: true, downloaded: operation === 'remove'}); await settle();
        expect(host.querySelector(`[data-testid="local-tts-${operation === 'download' ? 'remove' : 'download'}"]`)).not.toBeNull();
        expect(host.querySelector('[role="status"]')!.textContent).toContain(operation === 'download' ? 'statusReady' : 'statusNotDownloaded');
    });
    it('ignores an older rejected refresh after a newer success', async () => {
        ports.send.mockResolvedValue({success: true, downloaded: false}); const {host} = await mount(LocalTtsSettings, {config: normalizeConfig({})});
        const stale = deferred<unknown>(); ports.send.mockImplementationOnce(() => stale.promise);
        storageChanged(); await settle(); ports.send.mockResolvedValue({success: true, downloaded: true}); storageChanged(); await settle();
        stale.reject(new Error('stale fixture')); await settle();
        expect(host.querySelector('[data-testid="local-tts-remove"]')).not.toBeNull(); expect(host.querySelector('[role="alert"]')).toBeNull();
    });
    it('releases its storage listener and survives unmount with a pending read', async () => {
        const stale = deferred<unknown>(); ports.send.mockImplementationOnce(() => stale.promise);
        const first = await mount(LocalTtsSettings, {config: normalizeConfig({})}); first.stop();
        stale.reject(new Error('late fixture')); await settle(); expect(ports.storageListeners.size).toBe(0);
        ports.send.mockResolvedValue({success: true, models: [{downloaded: true}]});
        const second = await mount(LocalTtsSettings, {config: normalizeConfig({})}); expect(second.host.querySelector('[data-testid="local-tts-remove"]')).not.toBeNull();
    });
    it('recovers from malformed state via a later storage update and ignores unrelated storage', async () => {
        ports.send.mockResolvedValue({success: false}); const {host} = await mount(LocalTtsSettings, {config: normalizeConfig({})});
        expect(host.querySelector('[role="alert"]')!.textContent).toContain('statusReadFailed');
        const calls = ports.send.mock.calls.length;
        for (const listener of ports.storageListeners) {listener({other: {}}, 'local'); listener({[LOCAL_TTS_MODEL_STATE_KEY]: {}}, 'sync');}
        expect(ports.send).toHaveBeenCalledTimes(calls);
        ports.send.mockResolvedValue({success: true, downloaded: true}); storageChanged(); await settle();
        expect(host.querySelector('[data-testid="local-tts-remove"]')).not.toBeNull(); expect(host.querySelector('[role="alert"]')).toBeNull();
    });
    it('keeps status reads out of an in-flight model command', async () => {
        ports.send.mockResolvedValue({success: true, downloaded: false}); const {host} = await mount(LocalTtsSettings, {config: normalizeConfig({})});
        const command = deferred<unknown>(); ports.send.mockImplementationOnce(() => command.promise);
        host.querySelector<HTMLButtonElement>('[data-testid="local-tts-download"]')!.click(); await settle();
        const calls = ports.send.mock.calls.length; storageChanged(); await settle(); expect(ports.send).toHaveBeenCalledTimes(calls);
        ports.send.mockResolvedValue({success: true, downloaded: true});
        command.resolve({success: true}); await settle(); expect(host.querySelector('[data-testid="local-tts-remove"]')).not.toBeNull();
    });
    it('retains a command failure when an unrelated successful status read arrives', async () => {
        ports.send.mockResolvedValue({success: true, downloaded: false}); const {host} = await mount(LocalTtsSettings, {config: normalizeConfig({})});
        ports.send.mockResolvedValueOnce({success: false, error: 'controlled command failure'});
        host.querySelector<HTMLButtonElement>('[data-testid="local-tts-download"]')!.click(); await settle();
        expect(host.querySelector('[role="alert"]')!.textContent).toContain('controlled command failure');
        storageChanged(); await settle(); expect(host.querySelector('[role="alert"]')!.textContent).toContain('controlled command failure');
    });
});

describe.each(['history','memory'] as const)('audit49C %s 清空确认归属', kind => {
    const reply = () => kind==='history'
        ? {success:true,sessions:[{id:'session-fixture',text:'Retained reading fixture',intent:'meaning',updatedAt:1,turnCount:1}],hasMore:false}
        : {success:true,memories:[{id:'12345678-1234-4234-8234-123456789abc',kind:'note',content:'Retained fixture',updatedAt:1,createdAt:1}]};
    const action = () => kind==='history'?'sessions-clear':'memory-clear';
    const clearButton = (host:HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===(kind==='history'?'清空记录':'learning.memoryClear'))!;
    const dialog = (host:HTMLElement) => host.querySelector<HTMLElement>('[data-dialog-visible="true"]');
    const button = (host:HTMLElement, label:string) => [...dialog(host)!.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label)!;
    const calls = () => ports.send.mock.calls.filter(([message])=>message.action===action());
    it('连续触发只打开一个确认，重复旧事件不会再次清空', async () => {
        ports.send.mockResolvedValue(reply());const {host}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true});
        const clear=clearButton(host);clear.click();clear.click();await settle();expect(host.querySelectorAll('[data-dialog-visible="true"]')).toHaveLength(1);
        const accept=button(host,'common.confirm');accept.click();await settle();expect(calls()).toHaveLength(1);
        accept.click();await settle();expect(calls()).toHaveLength(1);
    });
    it('取消后保留数据，重新确认可清空', async () => {
        ports.send.mockResolvedValue(reply());const {host}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true});
        clearButton(host).click();await settle();button(host,'common.cancel').click();await settle();expect(dialog(host)).toBeNull();expect(calls()).toHaveLength(0);
        expect(host.textContent).toContain(kind==='history'?'Retained reading fixture':'Retained fixture');
        clearButton(host).click();await settle();button(host,'common.confirm').click();await settle();expect(calls()).toHaveLength(1);
        expect(host.textContent).not.toContain(kind==='history'?'Retained reading fixture':'Retained fixture');
    });
    it('缓存面板隐藏时关闭遮罩，旧确认不能清空当前数据', async () => {
        ports.send.mockResolvedValue(reply());const {host,shown}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true},true);
        clearButton(host).click();await settle();const old=button(host,'common.confirm');shown.value=false;await settle();expect(dialog(host)).toBeNull();
        shown.value=true;await settle();old.click();await settle();expect(calls()).toHaveLength(0);
    });
    it('导航可见性同步关闭再恢复后，旧确认不能清空数据', async () => {
        const visible=ref(true);ports.send.mockResolvedValue(reply());const {host}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true,isVisible:()=>visible.value});
        clearButton(host).click();await settle();const old=button(host,'common.confirm');visible.value=false;visible.value=true;await settle();expect(dialog(host)).toBeNull();old.click();await settle();expect(calls()).toHaveLength(0);
    });
    it('旧确认迟到不能关闭新确认，当前确认仍能清空一次', async () => {
        ports.send.mockResolvedValue(reply());const {host,shown}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true},true);
        clearButton(host).click();await settle();const old=button(host,'common.confirm');shown.value=false;await settle();shown.value=true;await settle();clearButton(host).click();await settle();
        old.click();await settle();expect(dialog(host)).not.toBeNull();expect(calls()).toHaveLength(0);button(host,'common.confirm').click();await settle();expect(calls()).toHaveLength(1);
    });
    it('旧对话框关闭事件不会关闭新确认', async () => {
        ports.send.mockResolvedValue(reply());const {host,shown}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true},true);
        clearButton(host).click();await settle();
        const old=host.querySelector<HTMLButtonElement>('[data-dialog-close]')!;
        shown.value=false;await settle();shown.value=true;await settle();clearButton(host).click();await settle();old.click();await settle();
        expect(dialog(host)).not.toBeNull();expect(calls()).toHaveLength(0);host.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click();await settle();expect(dialog(host)).toBeNull();
    });
    it('卸载后旧确认不能清空', async () => {
        ports.send.mockResolvedValue(reply());const {host,stop}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true});
        clearButton(host).click();await settle();const old=button(host,'common.confirm');stop();old.click();await settle();expect(calls()).toHaveLength(0);
    });
    it('确认已提交后隐藏不会撤销用户已接受的清空', async () => {
        const pending=deferred<unknown>();ports.send.mockImplementation((message:any)=>message.action===action()?pending.promise:Promise.resolve(reply()));
        const {host,shown}=await mount(kind==='history'?HarnessReadingHistory:LearningMemoryManager,{enabled:true},true);
        clearButton(host).click();await settle();button(host,'common.confirm').click();await settle();expect(calls()).toHaveLength(1);
        shown.value=false;await settle();pending.resolve({success:true});await settle();shown.value=true;await settle();expect(calls()).toHaveLength(1);
    });
});

describe('audit49C video model and cache lifecycle in the client template', () => {
    const stats = (entries: number) => ({success: true, stats: {entries, bytes: entries * 100, maxEntries: 32, ttlMs: 1000}});
    it.each(['download', 'remove'] as const)('does not let a stale storage snapshot undo completed %s', async operation => {
        let state = operation === 'remove' ? ['tiny'] : [];
        ports.send.mockImplementation(async (message: any) => {
            if (message.type === VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE) return stats(0);
            if (message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE) return {success: true, models: state};
            const models = operation === 'remove' ? [] : ['tiny'];
            state = models;
            return {success: true, models};
        });
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const stale = deferred<unknown>(); ports.send.mockImplementationOnce(() => stale.promise);
        for (const listener of ports.storageListeners) listener({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: {}}, 'local'); await settle();
        host.querySelector<HTMLButtonElement>('.video-model-card button')!.click(); await settle();
        stale.resolve({success: true, models: operation === 'remove' ? ['tiny'] : []}); await settle();
        expect(host.querySelector('.video-model-card .video-model-availability')!.textContent).toContain(operation === 'download' ? '可离线使用' : '尚未下载');
    });
    it('keeps post-clear cache statistics when an older focus read returns later', async () => {
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? {success: true, models: []} : stats(5));
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const stale = deferred<unknown>(); ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? {success: true, models: []} : stale.promise);
        window.dispatchEvent(new Event('focus')); await settle();
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? {success: true, models: []} : message.type === VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE ? {success: true} : stats(0));
        host.querySelector<HTMLButtonElement>('.video-ai-cache-clear')!.click(); await settle();
        stale.resolve(stats(5)); await settle(); expect(host.querySelector<HTMLButtonElement>('.video-ai-cache-clear')!.disabled).toBe(true);
    });
    it('clears an old cache-read error on a newer success and removes focus listeners on unmount', async () => {
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? {success: true, models: []} : stats(0));
        const {host, stop} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const stale = deferred<unknown>(); let holdCacheRead = true;
        ports.send.mockImplementation(async (message: any) => {
            if (message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE) return {success: true, models: []};
            if (holdCacheRead) {holdCacheRead = false; return stale.promise;}
            return stats(0);
        }); window.dispatchEvent(new Event('focus')); await settle();
        window.dispatchEvent(new Event('focus')); await settle(); stale.reject(new Error('old cache read')); await settle();
        expect(host.querySelector('.video-ai-cache-panel [role="alert"]')).toBeNull(); stop();
        const calls = ports.send.mock.calls.length; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); await settle();
        expect(ports.send).toHaveBeenCalledTimes(calls);
    });
    it('retains a model-download error when another storage state read succeeds', async () => {
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? {success: true, models: []} : stats(0));
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        ports.send.mockResolvedValueOnce({success: false, error: 'controlled command failure'});
        host.querySelector<HTMLButtonElement>('.video-model-card button')!.click(); await settle();
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
        for (const listener of ports.storageListeners) listener({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: {}}, 'local'); await settle();
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
    });
});

// 实际后台 handler + 实际路由/失败回复纪律。这里只控制 Offscreen、storage 和回包传输端口，
// 不生成业务 snapshot；捕获的 models 完全由生产 handler 的串行写入产生。
function videoPrepared(model: VideoTranscriptionModel): Extract<OffscreenResponseMap['VIDEO_AI_PREPARE'], {success: true}> {
    return {success: true, model};
}
function videoHandlerFixture(initial: string[] = []) {
    let values: Record<string, unknown> = {[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: [...initial]};
    const events: unknown[] = [];
    const stateReplies: Array<() => Promise<unknown>> = [];
    const cacheUrls = new Set(['tiny', 'base', 'small'].flatMap(model => (model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES).map(file => getVideoAiModelFileUrl(model, file))));
    vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys: async () => [...cacheUrls].map(url => new Request(url))})});
    const storage = {
        get: vi.fn(async (_key: string) => structuredClone(values)),
        set: vi.fn(async (next: Record<string, unknown>) => {
            const oldValue = values[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY];
            values = {...values, ...structuredClone(next)};
            events.push({write: structuredClone(next)});
            for (const listener of ports.storageListeners) listener({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: {
                oldValue, newValue: values[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY],
            }}, 'local');
        }),
    };
    const offscreen = {
        send: vi.fn(async (message: {type: string; model?: VideoTranscriptionModel}): Promise<OffscreenResponseMap['VIDEO_AI_PREPARE'] | OffscreenResponseMap['VIDEO_AI_REMOVE_MODEL']> => {
            if (message.type === 'VIDEO_AI_PREPARE') return videoPrepared(message.model ?? 'tiny');
            if (message.type === 'VIDEO_AI_REMOVE_MODEL') return {success: true};
            throw new Error(`Unexpected Offscreen fixture request: ${message.type}`);
        }),
        sendIfPresent: vi.fn(async () => ({success: true})),
    };
    const listener = createBackgroundRuntimeMessageListener(createBackgroundMessageRouter(
        createVideoSubtitleBackgroundHandlers({offscreen: offscreen as any, storage}),
    ), () => ({}));
    const gates = new Map<string, {captured: ReturnType<typeof deferred<any>>; release: ReturnType<typeof deferred<void>>}>();
    ports.get.mockImplementation((key: string) => storage.get(key));
    ports.send.mockImplementation(async (message: any) => {
        if (message.type === VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE) return {success: true, stats: {entries: 0, bytes: 0, maxEntries: 32, ttlMs: 1000}};
        if (message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE && stateReplies.length) return stateReplies.shift()!();
        const id = `${message.type}:${message.model}`;
        const gate = gates.get(id); gates.delete(id);
        const response = await listener(message, {});
        events.push({reply: id, response: structuredClone(response)});
        if (gate) {gate.captured.resolve(response); await gate.release.promise;}
        return response;
    });
    return {storage, offscreen, listener, events, cacheUrls, models: () => structuredClone(values[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]),
        holdState(promise: Promise<unknown>) {stateReplies.push(() => promise);},
        failState(error: Error) {stateReplies.push(async () => {throw error;});},
        hold(type: string, model: string) {
            const gate = {captured: deferred<any>(), release: deferred<void>()}; gates.set(`${type}:${model}`, gate); return gate;
        },
    };
}
function videoCard(host: HTMLElement, model: string) {
    const radio = host.querySelector<HTMLInputElement>(`.video-model-card input[value="${model}"]`)!;
    expect(radio).not.toBeNull();
    return radio.closest('.video-model-card')!;
}
async function clickVideoModel(host: HTMLElement, model: string) {
    const button = videoCard(host, model).querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).toBe(false); button.click(); await settle();
}
function expectVideoModels(host: HTMLElement, models: string[]) {
    for (const model of ['tiny', 'base']) expect(videoCard(host, model).querySelector('.video-model-availability')!.textContent)
        .toContain(models.includes(model) ? '可离线使用' : '尚未下载');
}

function capturedModelEvent(model: string, tag: string, name = 'onClick'): (...args: any[]) => unknown {
    const root = ports.renderedEvents.findLast(event => event.tag === 'article' && event.props.key === model)?.node;
    const find = (node: any): any => {
        if (node?.type === tag && typeof node.props?.[name] === 'function') return node.props[name];
        if (Array.isArray(node?.children)) for (const child of node.children) {const event = find(child); if (event) return event;}
    };
    const event = find(root); expect(event, `actual ${model} template ${tag}.${name}`).toBeTypeOf('function'); return event;
}
function capturedCacheClear(): (event: Event) => unknown {
    const event = ports.renderedEvents.findLast(item => item.tag === 'button' && String(item.props.class).includes('video-ai-cache-clear'))?.props.onClick;
    expect(event).toBeTypeOf('function'); return event;
}
function emitVideoProgress(model: string, next?: {loaded: number; total: number}, listeners = [...ports.storageListeners]) {
    for (const listener of listeners) listener({[downloadProgressKey(videoModelDownloadId(model))]: {newValue: next}}, 'local');
}

describe('video settings real template recovery boundaries', () => {
    const stats = {success: true, stats: {entries: 1, bytes: 4, maxEntries: 32, ttlMs: 1000}};
    const installReplies = (command: () => Promise<unknown> = async () => ({success: true})) => {
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE
            ? {success: true, models: []} : message.type === VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE ? stats : command());
    };
    it('selects a model by its actual radio/card and ignores the old rendered controls after a config replacement', async () => {
        installReplies();
        const config = normalizeConfig({videoTranslationEnabled: true});
        const page = await mount(VideoLocalModelSettings, {config, active: true});
        const state = page.state as {config: Config; active: boolean};
        videoCard(page.host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(state.config.videoLocalModel).toBe('base');
        const radio = videoCard(page.host, 'small').querySelector<HTMLInputElement>('input')!;
        radio.checked = true; radio.dispatchEvent(new Event('change', {bubbles: true})); await settle();
        expect(state.config.videoLocalModel).toBe('small');
        const oldChoose = capturedModelEvent('base', 'article'), oldDownload = capturedModelEvent('base', 'button');
        state.config = normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'tiny'}); await settle();
        const messages = ports.send.mock.calls.length;
        oldChoose(new Event('click')); await oldDownload(new Event('click')); await settle();
        expect(config.videoLocalModel).toBe('small'); expect(state.config.videoLocalModel).toBe('tiny'); expect(ports.send).toHaveBeenCalledTimes(messages);
        state.config.videoTranslationEnabled = false; await settle();
        videoCard(page.host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(state.config.videoLocalModel).toBe('tiny');
    });
    it('rejects a programmatically dispatched disabled download when extension DOM support is unavailable', async () => {
        installReplies(); ports.browserCapabilities.extensionDom = false;
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const button = videoCard(host, 'tiny').querySelector<HTMLButtonElement>('button')!;
        expect(button.disabled).toBe(true); button.dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(host.textContent).toContain('当前浏览器不支持本地 AI 字幕');
        expect(ports.send.mock.calls.map(([message]) => message.type)).not.toContain('fluentReadPrepareLocalVideoModel');
    });
    it('checks Small files on focus, accepts external byte progress and repairs the missing tokenizer through the real button', async () => {
        const fixture = videoHandlerFixture(['small']);
        const {host, state} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true}), active: true});
        const tokenizer = getVideoAiModelFileUrl('small', 'tokenizer.json');
        fixture.cacheUrls.delete(tokenizer); window.dispatchEvent(new Event('focus')); await settle();
        expect(videoCard(host, 'small').querySelector('.video-model-availability')!.textContent).toContain('尚未下载');
        expect(fixture.models()).toEqual(['small']); expect(fixture.offscreen.send).not.toHaveBeenCalled();
        emitVideoProgress('small', {loaded: 10, total: 100}); await settle();
        expect(host.querySelector('[data-video-model-progress="small"] progress')!.getAttribute('value')).toBe('10');
        emitVideoProgress('small', {loaded: 20, total: 100}); await settle();
        expect(host.querySelector('[data-video-model-progress="small"] progress')!.getAttribute('value')).toBe('20');
        emitVideoProgress('small'); await settle();
        expect(videoCard(host, 'small').querySelector('.video-model-availability')!.textContent).toContain('尚未下载');
        fixture.offscreen.send.mockImplementationOnce(async () => {fixture.cacheUrls.add(tokenizer); return videoPrepared('small');});
        await clickVideoModel(host, 'small');
        expect(videoCard(host, 'small').querySelector('.video-model-availability')!.textContent).toContain('可离线使用');
        const oldProgress = [...ports.storageListeners]; state.active = false; await settle();
        emitVideoProgress('small', {loaded: 90, total: 100}, oldProgress); await settle();
        expect(host.querySelector('[data-video-model-progress="small"]')).toBeNull();
    });
    it('keeps one download despite repeated queued events and ignores a stale success after the view becomes inactive', async () => {
        const gate = deferred<unknown>(); installReplies(() => gate.promise);
        const page = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true}), active: true});
        const event = capturedModelEvent('tiny', 'button');
        event(new Event('click')); event(new Event('click')); await settle();
        expect(ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadPrepareLocalVideoModel')).toHaveLength(1);
        page.state.active = false; await settle(); gate.resolve({success: true}); await settle();
        expect(page.host.querySelector('.video-model-management [role="alert"]')).toBeNull();
    });
    it('does not repeat a completed download from its old still-owned button event', async () => {
        const fixture = videoHandlerFixture(); await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const download = capturedModelEvent('tiny', 'button');
        await download(new Event('click')); await settle(); await download(new Event('click')); await settle();
        expect(fixture.offscreen.send).toHaveBeenCalledOnce();
    });
    it.each([undefined, {success: true, models: undefined}])('shows a status error for an invalid central state reply %j', async reply => {
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE ? reply : stats);
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('无法读取模型缓存');
    });
    it('shows a generic download error when a transport rejects with a non-Error value', async () => {
        installReplies(async () => {throw 'PORT_CLOSED';});
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
    });
    it('keeps one remove despite queued duplicate events and ignores a stale reply and old remove event after deactivation', async () => {
        const gate = deferred<unknown>();
        ports.send.mockImplementation(async (message: any) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE
            ? {success: true, models: ['tiny']} : message.type === VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE ? stats : gate.promise);
        const page = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true}), active: true});
        const event = capturedModelEvent('tiny', 'button'); event(new Event('click')); event(new Event('click')); await settle();
        expect(ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadRemoveLocalVideoModel')).toHaveLength(1);
        page.state.active = false; await settle(); gate.resolve({success: true}); await settle();
        const messages = ports.send.mock.calls.length; event(new Event('click')); await settle();
        expect(ports.send).toHaveBeenCalledTimes(messages); expect(page.host.querySelector('.video-model-management [role="alert"]')).toBeNull();
    });
    it.each(['empty', 'non-Error'])('shows a clear remove failure for a %s transport response', async mode => {
        ports.send.mockImplementation(async (message: any) => {
            if (message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE) return {success: true, models: ['tiny']};
            if (message.type === VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE) return stats;
            if (mode === 'non-Error') throw 'PORT_CLOSED';
        });
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('modelCache.removeFailed');
    });
    it.each(['invalid', 'non-Error'])('shows a cache-statistics failure for %s replies', async mode => {
        ports.send.mockImplementation(async (message: any) => {
            if (message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE) return {success: true, models: []};
            if (mode === 'non-Error') throw 'PORT_CLOSED';
            return {success: true};
        });
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        expect(host.querySelector('.video-ai-cache-panel [role="alert"]')!.textContent).toContain('无法读取已识别字幕缓存');
        expect(host.querySelector('.video-ai-cache-status')!.textContent).toContain('读取失败');
    });
    it.each(['empty', 'Error', 'non-Error', 'reported'])('preserves visible cache entries and allows retry after %s clear failure', async mode => {
        installReplies(async () => {
            if (mode === 'Error') throw new Error('controlled clear failure');
            if (mode === 'non-Error') throw 'PORT_CLOSED';
            if (mode === 'reported') return {success: false, error: 'controlled clear failure'};
        });
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        host.querySelector<HTMLButtonElement>('.video-ai-cache-clear')!.click(); await settle();
        expect(host.querySelector('.video-ai-cache-panel [role="alert"]')!.textContent).toContain(mode === 'Error' || mode === 'reported' ? 'controlled clear failure' : '清除已识别字幕失败');
        expect(host.querySelector<HTMLButtonElement>('.video-ai-cache-clear')!.disabled).toBe(false);
    });
    it('does not repeat cache clear or apply its late result after deactivation, and rejects an old queued clear event', async () => {
        const gate = deferred<unknown>(); installReplies(() => gate.promise);
        const page = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true}), active: true});
        const event = capturedCacheClear(); event(new Event('click')); event(new Event('click')); await settle();
        expect(page.host.textContent).toContain('清除中…');
        expect(ports.send.mock.calls.filter(([message]) => message.type === VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE)).toHaveLength(1);
        page.state.active = false; await settle(); gate.resolve({success: true}); await settle();
        const messages = ports.send.mock.calls.length; event(new Event('click')); await settle();
        expect(ports.send).toHaveBeenCalledTimes(messages); expect(page.host.querySelector('.video-ai-cache-panel [role="alert"]')).toBeNull();
    });
    it('mounts inactive without installing listeners or reading model files', async () => {
        installReplies(); const page = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true}), active: false});
        expect(ports.send).not.toHaveBeenCalled(); expect(ports.storageListeners.size).toBe(0); page.stop();
    });
});
describe('audit49C followup1 cross-model convergence through public handlers and real client buttons', () => {
    it('keeps both successful concurrent downloads when the earlier captured reply is delivered last', async () => {
        const fixture = videoHandlerFixture(); const tinyWorker = deferred<OffscreenResponseMap['VIDEO_AI_PREPARE']>(); const baseWorker = deferred<OffscreenResponseMap['VIDEO_AI_PREPARE']>();
        fixture.offscreen.send.mockImplementation((message: any) => message.model === 'tiny' ? tinyWorker.promise : baseWorker.promise);
        const tinyReply = fixture.hold('fluentReadPrepareLocalVideoModel', 'tiny');
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); await clickVideoModel(host, 'base');
        expect(fixture.offscreen.send.mock.calls.map(([message]) => message.model)).toEqual(['tiny', 'base']);
        tinyWorker.resolve(videoPrepared('tiny')); expect((await tinyReply.captured.promise).models).toEqual(['tiny']);
        baseWorker.resolve(videoPrepared('base')); await settle();
        expect(fixture.models()).toEqual(['tiny', 'base']);
        tinyReply.release.resolve(); await settle(); expectVideoModels(host, ['tiny', 'base']);
    });
    it('does not resurrect an externally removed model from an older successful download snapshot', async () => {
        const fixture = videoHandlerFixture(['tiny']); const reply = fixture.hold('fluentReadPrepareLocalVideoModel', 'base');
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'base'); expect((await reply.captured.promise).models).toEqual(['tiny', 'base']);
        expect(await fixture.listener({type: 'fluentReadRemoveLocalVideoModel', model: 'tiny'}, {})).toMatchObject({success: true, models: ['base']});
        reply.release.resolve(); await settle(); expect(fixture.models()).toEqual(['base']); expectVideoModels(host, ['base']);
    });
    it('keeps an external successful download when an older remove snapshot arrives last', async () => {
        const fixture = videoHandlerFixture(['tiny']); const reply = fixture.hold('fluentReadRemoveLocalVideoModel', 'tiny');
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); expect((await reply.captured.promise).models).toEqual([]);
        expect(await fixture.listener({type: 'fluentReadPrepareLocalVideoModel', model: 'base'}, {})).toMatchObject({success: true, models: ['base']});
        reply.release.resolve(); await settle(); expect(fixture.models()).toEqual(['base']); expectVideoModels(host, ['base']);
    });
    it('preserves both page commands when a remove and download complete before their replies are delivered in reverse order', async () => {
        const fixture = videoHandlerFixture(['tiny']); const tinyReply = fixture.hold('fluentReadRemoveLocalVideoModel', 'tiny');
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); expect((await tinyReply.captured.promise).models).toEqual([]);
        await clickVideoModel(host, 'base'); expect(fixture.models()).toEqual(['base']);
        tinyReply.release.resolve(); await settle(); expectVideoModels(host, ['base']);
    });
    it('re-reads external changes after a failed command and retains the independent command error', async () => {
        const fixture = videoHandlerFixture(); const worker = deferred<OffscreenResponseMap['VIDEO_AI_PREPARE']>();
        fixture.offscreen.send.mockImplementationOnce(() => worker.promise);
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny');
        expect(await fixture.listener({type: 'fluentReadPrepareLocalVideoModel', model: 'base'}, {})).toMatchObject({success: true});
        worker.resolve({success: false, error: 'controlled failed download'}); await settle();
        expect(fixture.models()).toEqual(['base']); expectVideoModels(host, ['base']);
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
        await clickVideoModel(host, 'tiny'); expectVideoModels(host, ['tiny', 'base']);
        expect(host.querySelector('.video-model-management [role="alert"]')).toBeNull();
    });
    it('keeps one concurrent download success when the other command fails', async () => {
        const fixture = videoHandlerFixture(); const tinyWorker = deferred<OffscreenResponseMap['VIDEO_AI_PREPARE']>();
        fixture.offscreen.send.mockImplementation(message => message.model === 'tiny' ? tinyWorker.promise : Promise.resolve(videoPrepared('base')));
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny'); await clickVideoModel(host, 'base');
        tinyWorker.resolve({success: false, error: 'tiny failed'}); await settle();
        expect(fixture.models()).toEqual(['base']); expectVideoModels(host, ['base']);
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
    });
    it('ignores a stale terminal read when a new command starts before that read is delivered', async () => {
        const fixture = videoHandlerFixture(); const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        const stale = deferred<unknown>(); fixture.holdState(stale.promise);
        await clickVideoModel(host, 'tiny'); await clickVideoModel(host, 'base');
        expect(fixture.models()).toEqual(['tiny', 'base']); stale.resolve({success: true, models: ['tiny']}); await settle();
        expectVideoModels(host, ['tiny', 'base']);
    });
    it('recovers from a terminal state-read failure through a later storage event', async () => {
        const fixture = videoHandlerFixture(); const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        fixture.failState(new Error('controlled terminal read failure'));
        await clickVideoModel(host, 'tiny');
        expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('无法读取模型缓存');
        await fixture.storage.set({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: ['tiny', 'base']}); await settle();
        expectVideoModels(host, ['tiny', 'base']); expect(host.querySelector('.video-model-management [role="alert"]')).toBeNull();
    });
    it('unsubscribes and avoids a terminal read after unmount while a successful reply is in transit', async () => {
        const fixture = videoHandlerFixture(); const reply = fixture.hold('fluentReadPrepareLocalVideoModel', 'tiny');
        const first = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(first.host, 'tiny'); await reply.captured.promise; first.stop();
        const reads = ports.send.mock.calls.filter(([message]) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE).length; reply.release.resolve(); await settle();
        expect(ports.send.mock.calls.filter(([message]) => message.type === VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE)).toHaveLength(reads); expect(ports.storageListeners.size).toBe(0);
        const second = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        expectVideoModels(second.host, ['tiny']); second.stop(); expect(ports.storageListeners.size).toBe(0);
    });
    it('keeps a command error after a failed terminal read is later recovered', async () => {
        const fixture = videoHandlerFixture(); const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        fixture.offscreen.send.mockResolvedValueOnce({success: false, error: 'controlled failed download'});
        fixture.failState(new Error('read failed after command failure'));
        await clickVideoModel(host, 'tiny');
        await fixture.storage.set({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: ['base']}); await settle();
        expectVideoModels(host, ['base']); expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型下载失败，请检查网络后重试');
    });
    it('preserves external state after an actual remove handler rejects and permits retry', async () => {
        const fixture = videoHandlerFixture(['tiny']); const worker = deferred<OffscreenResponseMap['VIDEO_AI_REMOVE_MODEL']>();
        fixture.offscreen.send.mockImplementationOnce(() => worker.promise);
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'tiny');
        await fixture.storage.set({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: ['tiny', 'base']});
        worker.resolve({success: false, error: '模型清除失败'}); await settle();
        expectVideoModels(host, ['tiny', 'base']); expect(host.querySelector('.video-model-management [role="alert"]')!.textContent).toContain('模型清除失败');
        await clickVideoModel(host, 'tiny'); expect(fixture.models()).toEqual(['base']); expectVideoModels(host, ['base']);
        expect(host.querySelector('.video-model-management [role="alert"]')).toBeNull();
    });
    it('keeps automatic downloads behind current rendered model controls and rejects stale or disabled choices', async () => {
        videoHandlerFixture();
        const page = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'tiny'}), active: true});
        const state = page.state as {config: Config; active: boolean};
        const oldChoose = capturedModelEvent('base', 'article'), oldDownload = capturedModelEvent('base', 'button');
        state.config = normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'tiny'}); await settle();
        const messages = ports.send.mock.calls.length;
        oldChoose(new Event('click')); await oldDownload(new Event('click')); await settle();
        expect(state.config.videoLocalModel).toBe('tiny'); expect(ports.send).toHaveBeenCalledTimes(messages);
        state.config.videoTranslationEnabled = false; await settle();
        videoCard(page.host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(state.config.videoLocalModel).toBe('tiny');
        state.config.videoTranslationEnabled = true; ports.browserCapabilities.extensionDom = false; await settle();
        videoCard(page.host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(state.config.videoLocalModel).toBe('tiny');
        ports.browserCapabilities.extensionDom = true; state.active = false; await settle();
        const inactiveDownload = capturedModelEvent('base', 'button');
        videoCard(page.host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await inactiveDownload(new Event('click')); await settle();
        expect(state.config.videoLocalModel).toBe('tiny'); expect(ports.send).toHaveBeenCalledTimes(messages);
        state.active = true; await settle();
        await clickVideoModel(page.host, 'base');
        const requests = ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadPrepareLocalVideoModel');
        expect(requests).toHaveLength(1); expect(requests[0][0]).toMatchObject({model: 'base', preference: 'auto'});
        expect(state.config.videoLocalModel).toBe('base'); expect(Object.keys(state.config)).not.toContain('videoModelDownloadSource');
        expect(page.host.querySelector('[data-video-model-source]')).toBeNull();
    });
    it('renders real download byte progress while keeping connection and fallback sources internal, then permits retry', async () => {
        const gate = deferred<OffscreenResponseMap['VIDEO_AI_PREPARE']>(), fixture = videoHandlerFixture(); fixture.offscreen.send.mockReturnValueOnce(gate.promise);
        const {host} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true})});
        await clickVideoModel(host, 'small');
        const progress = () => host.querySelector('[data-video-model-progress="small"]')!;
        expect(progress()).not.toBeNull(); expect(progress().getAttribute('data-state')).toBe('indeterminate');
        expect(progress().querySelector('progress')!.hasAttribute('value')).toBe(false);
        for (const transfer of [
            {source: 'modelscope', attempt: 1, attempts: 3, state: 'connecting'},
            {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'connecting'},
            {source: 'huggingface', attempt: 3, attempts: 3, state: 'receiving'},
            {source: 'other', attempt: 1, attempts: 1, state: 'receiving'},
        ] as const) {
            for (const listener of ports.storageListeners) listener({[downloadProgressKey(videoModelDownloadId('small'))]: {newValue: {loaded: 200_000, total: 800_000, transfer}}}, 'local');
            await settle(); expect(progress().getAttribute('data-state')).toBe('determinate');
            expect(progress().querySelector('progress')!.getAttribute('value')).toBe('200000');
            expect(progress().querySelector('progress')!.getAttribute('max')).toBe('800000');
            expect(progress().querySelector('.download-progress-detail')!.textContent).toBe('25% · 0.2 MB / 0.8 MB');
            expect(host.querySelector('[data-video-model-transfer]')).toBeNull();
            for (const source of ['modelscope', 'hf-mirror', 'huggingface']) expect(host.textContent).not.toContain(source);
        }
        gate.resolve({success: false, error: 'SOURCES_EXHAUSTED'}); await settle();
        expect(videoCard(host, 'small').querySelector('button')!.textContent!.trim()).toBe('video.downloadRetry');
        expect(videoCard(host, 'small').querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
        await clickVideoModel(host, 'small');
        expect(fixture.offscreen.send).toHaveBeenCalledTimes(2);
        expect(videoCard(host, 'small').querySelector('.video-model-availability')!.textContent).toContain('可离线使用');
    });
    it('keeps download sources private, changes the chosen model without downloading, and downloads only on its explicit button', async () => {
        videoHandlerFixture(); const {host, state} = await mount(VideoLocalModelSettings, {config: normalizeConfig({videoTranslationEnabled: true, videoLocalModel: 'small'})});
        const current = state as {config: Config};
        const requests = ports.send.mock.calls.length;
        expect(host.querySelector('.video-model-source-links')).toBeNull(); expect(host.querySelector('[data-video-model-source]')).toBeNull();
        expect([...host.querySelectorAll('input[type="radio"]')].map(input => input.getAttribute('value'))).toEqual(['tiny', 'base', 'small']);
        let bubbled = 0; host.addEventListener('click', () => bubbled++);
        videoCard(host, 'base').dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(current.config.videoLocalModel).toBe('base'); expect(ports.send).toHaveBeenCalledTimes(requests); expect(bubbled).toBe(1);
        await clickVideoModel(host, 'base');
        const downloads = ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadPrepareLocalVideoModel');
        expect(downloads).toHaveLength(1); expect(downloads[0][0]).toMatchObject({model: 'base', preference: 'auto'});
        expect(current.config.videoLocalModel).toBe('base'); expect(bubbled).toBe(1);
    });
});

function namedButton(host: HTMLElement, name: string) {
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === name)!;
    expect(button).not.toBeUndefined(); return button;
}
async function openHistoryRestore() {
    ports.send.mockImplementation(async (message: any) => message.type === 'configHistoryAction' ? {success: true, history: ports.history} : {success: true});
    const page = await mount(ConfigManagement, {active: true, activePanel: 'history', config: normalizeConfig({on: true})});
    Array.from(page.host.querySelectorAll<HTMLButtonElement>('.version-entry')).find(button => button.textContent?.includes('v1'))!.click(); await settle();
    return page;
}
describe('audit49C followup1 configuration restore confirmation ownership', () => {
    it.each(['unmount', 'close'] as const)('does not send a public history restore after %s while confirmation is pending', async boundary => {
        const page = await openHistoryRestore();
        namedButton(page.host, '恢复此版本').click(); await settle();
        expect(page.host.querySelector('.config-restore-confirm-dialog')).not.toBeNull();
        if (boundary === 'unmount') page.stop(); else {namedButton(page.host, '关闭').click(); await settle();}
        await settle(); expect(ports.send.mock.calls.map(([message]) => message.type)).not.toContain('configHistoryAction');
        expect(page.host.querySelector('.config-restore-confirm-dialog')).toBeNull();
        expect(ports.messages).not.toHaveBeenCalled();
    });
    it('allows only one pending confirmation and sends the selected version through the real public client', async () => {
        const page = await openHistoryRestore();
        const restore = namedButton(page.host, '恢复此版本'); restore.click(); restore.click(); await settle();
        expect(page.host.querySelectorAll('.config-restore-confirm-dialog')).toHaveLength(1);
        expect(ports.confirm).not.toHaveBeenCalled();
        namedButton(page.host, '恢复').click(); await settle();
        expect(ports.send.mock.calls.map(([message]) => message)).toEqual([{type: 'configHistoryAction', action: 'restore', version: 1}]);
        expect(ports.messages).toHaveBeenCalledWith('success', '设置已恢复');
    });
    it('releases cancellation and failed restore so the same visible version can be retried', async () => {
        const page = await openHistoryRestore(); namedButton(page.host, '恢复此版本').click(); await settle();
        namedButton(page.host, '取消').click(); await settle();
        expect(ports.send).not.toHaveBeenCalled();
        ports.send.mockResolvedValueOnce({success: false, error: 'controlled restore failure'});
        namedButton(page.host, '恢复此版本').click(); await settle();
        namedButton(page.host, '恢复').click(); await settle();
        expect(ports.messages).toHaveBeenCalledWith('error', '恢复失败：controlled restore failure');
        namedButton(page.host, '恢复此版本').click(); await settle();
        namedButton(page.host, '恢复').click(); await settle();
        expect(ports.send).toHaveBeenCalledTimes(2); expect(ports.messages).toHaveBeenLastCalledWith('success', '设置已恢复');
    });
    it('does not retain the old confirmation after its preview is closed and another version is opened', async () => {
        const page = await openHistoryRestore();
        namedButton(page.host, '恢复此版本').click(); await settle(); namedButton(page.host, '关闭').click(); await settle();
        page.host.querySelector<HTMLButtonElement>('.version-entry')!.click(); await settle();
        expect(ports.send).not.toHaveBeenCalled(); expect(page.host.querySelector('.preview-summary')!.textContent).toContain('v2');
    });
    it.each(['success', 'error'] as const)('ignores a late public restore %s notification after unmount', async result => {
        const page = await openHistoryRestore(); const response = deferred<any>(); ports.send.mockImplementationOnce(() => response.promise);
        namedButton(page.host, '恢复此版本').click(); await settle(); namedButton(page.host, '恢复').click(); await settle();
        expect(ports.send).toHaveBeenCalledOnce(); page.stop();
        response.resolve(result === 'success' ? {success: true, history: ports.history} : {success: false, error: 'late restore failure'}); await settle();
        expect(ports.messages).not.toHaveBeenCalled();
    });
});

describe('audit49C followup2 restore visibility during the dialog closing transition', () => {
    it.each([
        ['history', 'success'], ['history', 'failure'], ['backup', 'success'], ['backup', 'failure'],
    ] as const)('ignores the %s restore %s receipt after the public close button and before closed', async (kind, result) => {
        const page = kind === 'history' ? await openHistoryRestore()
            : await mount(ConfigManagement, {active: true, activePanel: 'history', config: normalizeConfig({on: false})});
        if (kind === 'backup') {page.host.querySelector<HTMLButtonElement>('.backup-panel .version-entry')!.click(); await settle();}
        const response = deferred<any>(); ports.send.mockImplementationOnce(() => response.promise);
        const restore = namedButton(page.host, '恢复此版本'); expect(restore.disabled).toBe(false); restore.click(); await settle();
        namedButton(page.host, '恢复').click(); await settle();
        expect(ports.send).toHaveBeenCalledOnce();
        expect(ports.send.mock.calls[0][0]).toEqual(kind === 'history'
            ? {type: 'configHistoryAction', action: 'restore', version: 1} : {type: 'configAutoBackupRestore', version: 1});
        const count = () => Array.from(page.host.querySelectorAll('.version-panel')).map(panel => panel.querySelectorAll('.version-entry').length);
        const before = count();
        // 外部 Dialog 端口保持离场内容，modelValue 已 false，但动画结束的 closed 尚未递送。
        // 这是受控过渡语义，不能代表 Element Plus 原生浏览器验证。
        ports.delayDialogClosed = true; namedButton(page.host, '关闭').click(); await settle();
        expect(page.host.querySelector('.config-preview-dialog')!.getAttribute('data-dialog-visible')).toBe('false');
        expect(page.host.querySelector('.preview-summary')!.textContent).toContain(kind === 'history' ? 'v1' : 'b1');
        expect(ports.pendingDialogClosed.size).toBe(1);
        const history = appendConfigHistorySnapshot(ports.history, normalizeConfig({on: false}))!;
        const backups = appendConfigAutoBackup(getConfigAutoBackupsSnapshot(), normalizeConfig({on: false}));
        response.resolve(result === 'failure' ? {success: false, error: 'controlled closing restore failure'}
            : kind === 'history' ? {success: true, history} : {success: true, result: {history, backups}});
        await settle();
        expect.soft(ports.messages).not.toHaveBeenCalled(); expect.soft(count()).toEqual(before);
        expect(ports.send).toHaveBeenCalledOnce();
        for (const closed of [...ports.pendingDialogClosed]) closed(); await settle();
        expect(page.host.querySelector('.config-preview-dialog')).toBeNull(); expect(ports.pendingDialogClosed.size).toBe(0);
        expect(ports.send).toHaveBeenCalledOnce();
    });
});

describe('audit49C followup1 cache-limit draft and authoritative configuration', () => {
    const stats = {success: true, stats: {bytes: 0, entries: 0, maxBytes: 10 * 1024 * 1024, maxEntries: 10000}};
    it.each(['panel', 'keep-alive'] as const)('[cache-draft-owner] %s departure settles old authoritative limits without replacing a later failed draft', async reason => {
        for (const oldOutcome of ['success', 'failure'] as const) for (const oldTiming of ['before', 'after'] as const) {
            ports.send.mockReset();ports.patch.mockReset();ports.send.mockResolvedValue(stats);
            const old = deferred<void>(), latest = deferred<void>();
            ports.patch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise).mockResolvedValue(undefined);
            const page = await mount(TranslationCacheSettings, {config: normalizeConfig({}), active: true}, true);
            const fields = () => Array.from(page.host.querySelectorAll<HTMLInputElement>('input[type="number"]')).map(field => field.value);
            const edit = async (size: string, entries: string) => {
                input(page.host, 'input[aria-label="settings.cache.maxSize"]', size);
                input(page.host, 'input[aria-label="settings.cache.maxEntries"]', entries);await settle();
            };
            const submit = async () => {page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();};
            await edit('2', '300');await submit();
            Object.assign(page.state.config as object, {translationCacheMaxBytes: 3 * 1024 * 1024, translationCacheMaxEntries: 500});await settle();
            if (reason === 'panel') page.state.active = false;else page.shown.value = false;
            await settle();
            if (reason === 'panel') page.state.active = true;else page.shown.value = true;
            await settle();expect.soft(fields()).toEqual(['3', '500']);
            await edit('4', '600');await submit();
            const reads = ports.send.mock.calls.length;
            const settleOld = async () => {if (oldOutcome === 'success') old.resolve();else old.reject(new Error('old departed save'));await settle();};
            if (oldTiming === 'before') {
                await settleOld();expect(namedButton(page.host, 'common.save').disabled).toBe(true);
                expect(page.host.querySelector('[role="status"]')).toBeNull();
            }
            latest.reject(new Error('fresh save failed'));await settle();
            if (oldTiming === 'after') await settleOld();
            expect.soft(fields()).toEqual(['4', '600']);
            expect(page.host.querySelector('[role="alert"]')!.textContent).toContain('settings.cache.saveFailed');
            expect(namedButton(page.host, 'common.save').disabled).toBe(false);expect(ports.send).toHaveBeenCalledTimes(reads);
            await submit();expect(ports.patch.mock.calls[2][0]).toEqual({translationCacheMaxBytes: 4 * 1024 * 1024, translationCacheMaxEntries: 600});
            page.stop();
        }
    });
    it('[cache-recovery] clear timeout is unconfirmed and releases the button', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const clear = deferred<unknown>();ports.send.mockReturnValueOnce(clear.promise);
        const trigger = namedButton(page.host, 'settings.cache.clear');trigger.click();await settle();
        await vi.advanceTimersByTimeAsync(15000);await settle();
        expect(trigger.disabled).toBe(false);
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.clearUnconfirmed');
        expect(page.host.querySelector('[role="alert"]')).toBeNull();
        clear.resolve({success: true});await settle();
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.clearUnconfirmed');
    });
    it('[cache-recovery] clear ACK and following statistics share one deadline', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const clear = deferred<unknown>(), read = deferred<unknown>();ports.send.mockReturnValueOnce(clear.promise).mockReturnValueOnce(read.promise);
        const trigger = namedButton(page.host, 'settings.cache.clear');trigger.click();await settle();
        await vi.advanceTimersByTimeAsync(9000);clear.resolve({success: true});await settle();
        await vi.advanceTimersByTimeAsync(5999);expect(trigger.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(1);await settle();expect(trigger.disabled).toBe(false);
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.cleared');
        expect(page.host.querySelector('[role="alert"]')!.textContent).toBe('settings.cache.readFailed');
        read.resolve(stats);await settle();expect(page.host.querySelector('[role="alert"]')!.textContent).toBe('settings.cache.readFailed');
    });
    it('[cache-recovery] reports pending pages without claiming full completion', async () => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        ports.send.mockResolvedValueOnce({success: true, invalidationPending: true});
        namedButton(page.host, 'settings.cache.clear').click();await settle();
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.clearedPendingPages');
    });
    it.each(['success', 'failure'] as const)('[cache-recovery] timed-out %s cannot release or complete a new clear', async outcome => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const first = deferred<unknown>(), second = deferred<unknown>();ports.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const trigger = namedButton(page.host, 'settings.cache.clear');trigger.click();await settle();
        await vi.advanceTimersByTimeAsync(15000);await settle();expect(trigger.disabled).toBe(false);
        trigger.click();await settle();expect(trigger.disabled).toBe(true);
        if (outcome === 'success') first.resolve({success: true});else first.reject(new Error('late fixture'));
        await settle();expect(trigger.disabled).toBe(true);expect(page.host.querySelector('[role="status"]')).toBeNull();
        second.resolve({success: true});await settle();expect(trigger.disabled).toBe(false);
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.cleared');
        expect(ports.send.mock.calls.map(([message]) => message.type)).toEqual(['getTranslationCacheStats', 'clearTranslationCache', 'clearTranslationCache', 'getTranslationCacheStats']);
    });
    it.each(['read', 'clear', 'following-stats'] as const)('[cache-recovery] unmount releases the pending %s timer', async phase => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
        const pending = deferred<unknown>();ports.send.mockResolvedValue(stats);
        if (phase === 'read') ports.send.mockReturnValueOnce(pending.promise);
        const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        if (phase !== 'read') {
            if (phase === 'following-stats') ports.send.mockResolvedValueOnce({success: true});
            ports.send.mockReturnValueOnce(pending.promise);namedButton(page.host, 'settings.cache.clear').click();await settle();
        }
        expect(vi.getTimerCount()).toBe(1);page.stop();await settle();expect(vi.getTimerCount()).toBe(0);
        const calls = ports.send.mock.calls.length;pending.reject(new Error('late unmounted fixture'));await settle();expect(ports.send).toHaveBeenCalledTimes(calls);
    });
    it.each(['panel', 'keep-alive'] as const)('[cache-recovery] %s inactivity preserves draft limits and rejects old clear/save followups', async reason => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
        for (const phase of ['clear', 'clear-stats', 'save', 'save-stats'] as const) {
            ports.send.mockReset();ports.send.mockResolvedValue(stats);
            const page = await mount(TranslationCacheSettings, {config: normalizeConfig({}), active: true}, true);
            input(page.host, 'input[aria-label="settings.cache.maxEntries"]', '300');await settle();
            const old = deferred<unknown>(), latest = deferred<unknown>();
            if (phase === 'clear' || phase === 'clear-stats') {
                if (phase === 'clear-stats') ports.send.mockResolvedValueOnce({success: true});
                ports.send.mockReturnValueOnce(old.promise);namedButton(page.host, 'settings.cache.clear').click();
            } else {
                if (phase === 'save') ports.patch.mockReturnValueOnce(old.promise);
                else ports.send.mockReturnValueOnce(old.promise);
                page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
            }
            await settle();
            if (reason === 'panel') page.state.active = false;else page.shown.value = false;
            await settle();expect(vi.getTimerCount()).toBe(0);
            const before = ports.send.mock.calls.length;ports.send.mockReturnValueOnce(latest.promise);
            if (reason === 'panel') page.state.active = true;else page.shown.value = true;
            await settle();expect(ports.send).toHaveBeenCalledTimes(before + 1);
            old.resolve(phase === 'clear' ? {success: true} : phase === 'save' ? undefined : {...stats, stats: {...stats.stats, entries: 99}});
            await settle();expect(ports.send).toHaveBeenCalledTimes(before + 1);
            expect(namedButton(page.host, 'settings.cache.clear').disabled).toBe(true);
            expect(page.host.querySelector('[role="status"]')).toBeNull();
            latest.resolve({...stats, stats: {...stats.stats, entries: 7}});await settle();
            expect(page.host.querySelector('[data-cache-entries]')!.textContent).toContain('7');
            expect(page.host.querySelector<HTMLInputElement>('input[aria-label="settings.cache.maxEntries"]')!.value).toBe('300');
            expect(namedButton(page.host, 'settings.cache.clear').disabled).toBe(false);page.stop();
        }
    });
    it('[cache-recovery] an ACK already queued before leaving cannot launch a late stats read', async () => {
        ports.send.mockResolvedValue(stats);const page = await mount(TranslationCacheSettings, {config: normalizeConfig({}), active: true});
        const clear = deferred<unknown>();ports.send.mockReturnValueOnce(clear.promise);
        namedButton(page.host, 'settings.cache.clear').click();await settle();
        clear.resolve({success: true});await Promise.resolve();page.state.active = false;await settle();
        expect(ports.send.mock.calls.map(([message]) => message.type)).toEqual(['getTranslationCacheStats', 'clearTranslationCache']);
    });
    it('[cache-recovery] renders measured KiB usage and adopts idle external limit updates', async () => {
        ports.send.mockResolvedValue({...stats, stats: {...stats.stats, bytes: 2048, entries: 2}});
        const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        expect(page.host.querySelector('[data-cache-bytes]')!.textContent).toContain('2 KiB');
        Object.assign(page.state.config as object, {translationCacheMaxBytes: 3 * 1024 * 1024, translationCacheMaxEntries: 300});await settle();
        expect(Array.from(page.host.querySelectorAll<HTMLInputElement>('input[type="number"]')).map(field => field.value)).toEqual(['3', '300']);
    });
    it('[cache-recovery] delayed disabled-control events cannot overlap a pending cache read', async () => {
        const read = deferred<unknown>();ports.send.mockReturnValueOnce(read.promise);
        const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        namedButton(page.host, 'settings.cache.refresh').dispatchEvent(new Event('click', {bubbles: true}));
        page.host.querySelector('input[type="checkbox"]')!.dispatchEvent(new Event('change', {bubbles: true}));
        page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await settle();
        expect(ports.patch).not.toHaveBeenCalled();expect(ports.send).toHaveBeenCalledOnce();
        expect(ports.send).toHaveBeenCalledWith({type: 'getTranslationCacheStats'});
        read.resolve(stats);await settle();expect(namedButton(page.host, 'settings.cache.refresh').disabled).toBe(false);
    });
    it.each(['success', 'failure', 'unmount'] as const)('keeps cache clearing single-flight and handles its %s receipt', async outcome => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const clear = deferred<any>(); ports.send.mockImplementationOnce(() => clear.promise); ports.send.mockClear();
        const trigger = namedButton(page.host, 'settings.cache.clear');
        trigger.click(); await settle();
        expect(trigger.disabled).toBe(true);
        trigger.dispatchEvent(new Event('click', {bubbles: true})); await settle();
        expect(ports.send.mock.calls.map(([message]) => message)).toEqual([{type: 'clearTranslationCache'}]);
        if (outcome === 'unmount') page.stop();
        clear.resolve(outcome === 'failure' ? {success: false} : {success: true}); await settle();
        if (outcome === 'unmount') {
            expect(ports.send).toHaveBeenCalledOnce(); return;
        }
        expect(trigger.disabled).toBe(false);
        if (outcome === 'failure') {
            expect(page.host.querySelector('[role="alert"]')!.textContent).toBe('settings.cache.clearFailed');
            trigger.click(); await settle();
        }
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.cleared');
        expect(ports.send.mock.calls.map(([message]) => message.type)).toEqual(outcome === 'failure'
            ? ['clearTranslationCache', 'clearTranslationCache', 'getTranslationCacheStats']
            : ['clearTranslationCache', 'getTranslationCacheStats']);
    });
    it('saves both numeric cache limits from the rendered inputs in one patch', async () => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        input(page.host, 'input[aria-label="settings.cache.maxSize"]', '3');
        input(page.host, 'input[aria-label="settings.cache.maxEntries"]', '500'); await settle();
        page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        expect(ports.patch.mock.calls.map(([patch]) => patch)).toEqual([{translationCacheMaxBytes: 3 * 1024 * 1024, translationCacheMaxEntries: 500}]);
        expect(page.host.querySelector('[role="status"]')!.textContent).toBe('settings.cache.saved');
    });
    it('reconciles limits received from the real parent prop while the cache toggle save is pending', async () => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const save = deferred<void>(); ports.patch.mockImplementationOnce(() => save.promise);
        const toggle = page.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!; toggle.checked = false; toggle.dispatchEvent(new Event('change')); await settle();
        Object.assign(page.state.config as any, {translationCacheMaxBytes: 2 * 1024 * 1024, translationCacheMaxEntries: 300}); await settle();
        save.resolve(); await settle();
        expect(Array.from(page.host.querySelectorAll<HTMLInputElement>('input[type="number"]')).map(field => field.value)).toEqual(['2', '300']);
        expect(namedButton(page.host, 'common.save').disabled).toBe(true);
        expect(ports.patch.mock.calls[0][0]).toEqual({useCache: false});
    });
    it('retains an unsaved user draft after a failed limit save with no external update', async () => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        input(page.host, 'input[aria-label="settings.cache.maxEntries"]', '300'); await settle(); ports.patch.mockRejectedValueOnce(new Error('fixture failed'));
        page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        expect(page.host.querySelector<HTMLInputElement>('input[aria-label="settings.cache.maxEntries"]')!.value).toBe('300');
        expect(namedButton(page.host, 'common.save').disabled).toBe(false); expect(page.host.querySelector('[role="alert"]')!.textContent).toContain('settings.cache.saveFailed');
        page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        expect(ports.patch.mock.calls[1][0]).toEqual({translationCacheMaxBytes: 10 * 1024 * 1024, translationCacheMaxEntries: 300});
    });
    it('adopts the latest external limits after a failed save and keeps its failure feedback', async () => {
        ports.send.mockResolvedValue(stats); const page = await mount(TranslationCacheSettings, {config: normalizeConfig({})});
        const save = deferred<void>(); ports.patch.mockImplementationOnce(() => save.promise);
        input(page.host, 'input[aria-label="settings.cache.maxEntries"]', '300'); await settle();
        page.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        Object.assign(page.state.config as any, {translationCacheMaxBytes: 3 * 1024 * 1024, translationCacheMaxEntries: 500}); await settle();
        save.reject(new Error('controlled failure')); await settle();
        expect(Array.from(page.host.querySelectorAll<HTMLInputElement>('input[type="number"]')).map(field => field.value)).toEqual(['3', '500']);
        expect(namedButton(page.host, 'common.save').disabled).toBe(true); expect(page.host.querySelector('[role="alert"]')!.textContent).toContain('settings.cache.saveFailed');
    });
});

const basePreferences: SitePreferences = {on: true, autoTranslate: false, disableFloatingBall: false,
    alwaysTranslateDomains: ['docs.example.com'], disabledExtensionDomains: ['blocked.com'], floatingBallDisabledDomains: ['docs.example.com']};
describe('audit49C single-site preferences public preview', () => {
    it.each([
        ['https://docs.example.com/path', {}, ['enabled', 'site', 'hidden-site']],
        ['https://blocked.com', {}, ['disabled', 'disabled', 'disabled']],
        ['https://docs.example.com', {on: false}, ['paused', 'paused', 'paused']],
        ['https://manual.com', {}, ['enabled', 'manual', 'visible']],
        ['http://localhost', {autoTranslate: true}, ['enabled', 'global', 'visible']],
        ['https://docs.example.com', {disableFloatingBall: true}, ['enabled', 'site', 'hidden-global']],
    ])('preserves priority for %s / %j', (url, overrides, expected) => {
        const result = previewSitePreferences(url as string, {...basePreferences, ...overrides as object})!;
        expect([result.extension, result.translation, result.floatingBall]).toEqual(expected);
    });
    it('rejects malformed or non-HTTP input while retaining sorted multi-site listing', () => {
        for (const value of ['', '://', 'file:///fixture', 'javascript:alert(1)']) expect(previewSitePreferences(value, basePreferences)).toBeNull();
        expect(listSitePreferences(basePreferences).map(row => row.domain)).toEqual(['blocked.com', 'example.com']);
    });
    it('avoids sorting all site rows for a bounded one-site preview and records the same output', () => {
        const domains = Array.from({length: 512}, (_, index) => `site${511 - index}.com`);
        const config = {...basePreferences, alwaysTranslateDomains: domains, disabledExtensionDomains: domains.slice(0, 256), floatingBallDisabledDomains: domains.slice(256)};
        const original = String.prototype.localeCompare; let comparisons = 0;
        const outputs: unknown[] = []; const start = performance.now();
        try {
            String.prototype.localeCompare = function (...args: Parameters<typeof original>) {comparisons++; return original.apply(this, args);};
            for (let index = 0; index < 12; index++) outputs.push(previewSitePreferences('https://docs.site7.com/article', config));
        } finally {String.prototype.localeCompare = original;}
        const rawOutput = JSON.stringify(outputs);
        const outputSHA256 = createHash('sha256').update(rawOutput).digest('hex');
        const evidenceDirectory = process.env.AUDIT_C_EVIDENCE_DIR;
        if (evidenceDirectory && process.env.AUDIT_C_LABEL) {
            mkdirSync(evidenceDirectory, {recursive: true});
            writeFileSync(join(evidenceDirectory, `${process.env.AUDIT_C_LABEL}-performance.json`), JSON.stringify({
            mode: process.env.AUDIT_C_MODE, loaded: true, entry: 'previewSitePreferences', domainCount: 512, repetitions: 12, comparisons,
            elapsedMs: performance.now() - start, output: outputs, outputSHA256,
            }, null, 2));
        }
        expect(outputs[0]).toEqual({url: 'https://docs.site7.com/article', domain: 'site7.com', extension: 'enabled', translation: 'site', floatingBall: 'hidden-site'});
        expect(outputSHA256).toBe('0d6eb2f1949a7aee972ecce47af20ed2376dbe72847748e369ad8f09ecbd6829');
        expect(comparisons).toBe(0);
    });
});

// 实际 Vue client renderer + 受控 MessageBox/下载；active 改变证明装配归属，非原生遮罩下鼠标离区。
describe('audit49C local backup confirmation ownership', () => {
    async function fixture(defaultActive = false) {
        vi.useFakeTimers();
        const blobs = new Map<string, Blob>();
        let nextUrl = 0;
        const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            const url = `blob:owned-backup-${++nextUrl}`; blobs.set(url, blob as Blob); return url;
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => {blobs.delete(url);});
        const download = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const activeDescriptor = Object.getOwnPropertyDescriptor(dom.document, 'activeElement');
        Object.defineProperty(dom.document, 'activeElement', {configurable: true, value: dom.document.body});
        const shown = ref(true);
        const Empty = {render: () => null};
        const Owner = defineComponent({props: {
            config: {type: Object as PropType<Config>, required: true},
            active: {type: Boolean, default: undefined},
        }, setup: props => () => h(KeepAlive, null, {
            default: () => shown.value ? h(ActualLocalDataManagement, {config: props.config, ...defaultActive ? {} : {active: props.active}}) : h(Empty),
        })});
        ports.exportConfig.mockImplementation(async () => prepareConfigForExport(ports.config as Config));
        ports.send.mockImplementation(async (message: {type: string; action: string; options?: {includePrivateContext: boolean}}) => {
            if (message.action === 'exportData') return {success: true, data: {format: 'fluentread-vocabulary-book', version: 1,
                exportedAt: 1, includesPrivateContext: message.options?.includePrivateContext, entries: [], reviewLogs: []}};
            if (message.type === 'modelUsage' && message.action === 'export') return {success: true, data: {
                format: 'fluentread-model-usage', version: 1, exportedAt: 1, events: [],
            }};
            throw new Error('Unexpected backup IO port');
        });
        const page = await mount(Owner, {config: ports.config, ...defaultActive ? {} : {active: true}});
        const button = () => page.host.querySelector<HTMLButtonElement>('.transfer-actions button')!;
        const focus = vi.spyOn(button(), 'focus').mockImplementation(() => undefined);
        const restoreFocus = vi.spyOn(page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1], 'focus').mockImplementation(() => undefined);
        const fileFocusRestorers: Array<() => void> = [];
        const chooseFile = async (file: Pick<File, 'name' | 'size' | 'text'>) => {
            if (!page.host.querySelector('[data-testid="restore-source-dialog"]')) {
                page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            }
            const choose = page.host.querySelector<HTMLButtonElement>('[data-testid="restore-source-dialog"] button')!;
            expect(choose.disabled).toBe(false);
            const fileFocus = vi.spyOn(choose, 'focus').mockImplementation(() => undefined);
            fileFocusRestorers.push(() => fileFocus.mockRestore());
            choose.click();
            const input = page.host.querySelector<HTMLInputElement>('input[type="file"]')!;
            Object.defineProperty(input, 'files', {configurable: true, value: [file]});
            input.dispatchEvent(new Event('change', {bubbles: true})); await settle();
            return {input, focus: fileFocus};
        };
        let stopped = false;
        const stop = () => {if (!stopped) {stopped = true; page.stop();}};
        const leave = async (kind: 'inactive' | 'reopen' | 'keepalive' | 'unmount') => {
            if (kind === 'unmount') stop();
            else if (kind === 'keepalive') shown.value = false;
            else page.state.active = false;
            await settle();
            if (kind === 'reopen') {page.state.active = true; await settle();}
        };
        const reactivate = async () => {page.state.active = true; shown.value = true; await settle();};
        return {page, button, focus, restoreFocus, create, revoke, download, blobs, chooseFile, leave, reactivate, stop, async close() {
            try {
                stop(); await settle(); vi.runOnlyPendingTimers();
                expect(blobs.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
            } finally {
                for (const restore of fileFocusRestorers) restore();
                restoreFocus.mockRestore(); focus.mockRestore(); download.mockRestore(); create.mockRestore(); revoke.mockRestore();
                if (activeDescriptor) Object.defineProperty(dom.document, 'activeElement', activeDescriptor);
                else Reflect.deleteProperty(dom.document, 'activeElement');
                vi.useRealTimers();
            }
        }};
    }

    it.each(['confirm', 'cancel', 'close'] as const)('preserves the %s privacy choice with default-true active compatibility', async choice => {
        const f = await fixture(true);
        try {
            if (choice !== 'confirm') ports.confirm.mockRejectedValueOnce(choice);
            f.button().click(); await settle();
            expect(ports.confirm).toHaveBeenCalledOnce();
            expect(ports.confirm.mock.calls[0][2]).toMatchObject({confirmButtonText: '不包含并导出', cancelButtonText: '包含并导出', distinguishCancelAndClose: true});
            expect(f.create).toHaveBeenCalledTimes(choice === 'close' ? 0 : 1);
            expect(f.download).toHaveBeenCalledTimes(choice === 'close' ? 0 : 1);
            expect(ports.exportConfig).toHaveBeenCalledTimes(choice === 'close' ? 0 : 1);
            if (choice === 'close') expect(ports.send).not.toHaveBeenCalled();
            else {
                expect(ports.send.mock.calls.map(([message]) => [message.type, message.action])).toEqual([[VOCABULARY_BOOK_MESSAGE, 'exportData'], ['modelUsage', 'export']]);
                const backup = JSON.parse(await [...f.blobs.values()][0].text());
                expect(backup).toMatchObject({format: 'fluentread-data-backup', version: 2, configCredentialMode: 'exact-replace',
                    vocabulary: {includesPrivateContext: choice === 'cancel'}, modelUsage: {events: []}});
                expect(ports.messages).toHaveBeenCalledOnce(); expect(f.focus).toHaveBeenCalledOnce();
            }
            expect(f.button().disabled).toBe(false);
        } finally {await f.close();}
    });

    it.each(['inactive', 'reopen', 'keepalive', 'unmount'] as const)('rejects a late privacy confirmation after controlled %s and permits a fresh active export', async kind => {
        const f = await fixture(); const confirmation = deferred<void>();
        ports.confirm.mockImplementationOnce(() => confirmation.promise);
        try {
            f.button().click(); await settle(); expect(ports.confirm).toHaveBeenCalledOnce();
            await f.leave(kind); confirmation.resolve(); await settle();
            expect(ports.exportConfig).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled();
            expect(f.download).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate(); f.button().click(); await settle();
                expect(ports.confirm).toHaveBeenCalledTimes(2); expect(f.download).toHaveBeenCalledOnce();
                expect(f.button().disabled).toBe(false);
            }
        } finally {confirmation.resolve(); await settle(); await f.close();}
    });

    it.each(['inactive', 'keepalive', 'unmount'] as const)('finishes an accepted export after controlled %s while withholding stale toast and focus', async kind => {
        const f = await fixture(); const io = deferred<Record<string, unknown>>();
        ports.exportConfig.mockImplementationOnce(() => io.promise);
        try {
            f.button().click(); await settle();
            expect(ports.exportConfig).toHaveBeenCalledOnce(); expect(ports.send).toHaveBeenCalledTimes(2);
            expect(f.button().disabled).toBe(true);
            // The loading/disabled native button must not start another confirmation after acceptance.
            f.button().click(); await settle(); expect(ports.confirm).toHaveBeenCalledOnce();
            await f.leave(kind); io.resolve(prepareConfigForExport(ports.config as Config)); await settle();
            expect(f.download).toHaveBeenCalledOnce(); expect(ports.messages).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate(); expect(f.button().disabled).toBe(false);
                f.button().click(); await settle(); expect(f.download).toHaveBeenCalledTimes(2); expect(ports.messages).toHaveBeenCalledOnce();
            }
        } finally {io.resolve(prepareConfigForExport(ports.config as Config)); await settle(); await f.close();}
    });

    it.each(['click', 'timer'] as const)('releases the sensitive backup object URL when download %s throws', async failure => {
        const f = await fixture();
        let timer: {mockRestore(): void} | undefined;
        try {
            if (failure === 'click') f.download.mockImplementationOnce(() => {throw new Error('download unavailable');});
            else timer = vi.spyOn(window, 'setTimeout').mockImplementationOnce(() => {throw new Error('timer unavailable');});
            f.button().click(); await settle();
            expect(f.create).toHaveBeenCalledOnce();expect(f.download).toHaveBeenCalledOnce();
            expect(f.revoke).toHaveBeenCalledWith('blob:owned-backup-1');expect(f.blobs.size).toBe(0);
            expect(ports.messages).toHaveBeenCalledOnce();expect(f.button().disabled).toBe(false);
        } finally {
            timer?.mockRestore();
            for (const url of f.blobs.keys()) URL.revokeObjectURL(url);
            await f.close();
        }
    });

    it('retains the download error when object URL cleanup also throws', async () => {
        const f = await fixture();
        try {
            f.download.mockImplementationOnce(() => {throw new Error('download unavailable');});
            f.revoke.mockImplementationOnce(() => {throw new Error('cleanup unavailable');});
            f.button().click();await settle();
            expect(ports.messages).toHaveBeenCalledWith('error', '导出失败：download unavailable');
            expect(f.revoke).toHaveBeenCalledOnce();expect(f.button().disabled).toBe(false);
        } finally {
            for (const url of f.blobs.keys()) URL.revokeObjectURL(url);
            await f.close();
        }
    });

    it('releases busy after a stale accepted IO failure and allows a fresh export on reactivation', async () => {
        const f = await fixture(); const io = deferred<Record<string, unknown>>();
        ports.exportConfig.mockImplementationOnce(() => io.promise);
        try {
            f.button().click(); await settle(); await f.leave('inactive'); io.reject(new Error('Owned export fixture failure')); await settle();
            expect(f.download).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
            await f.reactivate(); expect(f.button().disabled).toBe(false); f.button().click(); await settle(); expect(f.download).toHaveBeenCalledOnce();
        } finally {io.resolve(prepareConfigForExport(ports.config as Config)); await settle(); await f.close();}
    });

    it('keeps a pending choice valid across unrelated config replacement and exports the accepted authoritative snapshot', async () => {
        const f = await fixture(); const confirmation = deferred<void>();
        ports.confirm.mockImplementationOnce(() => confirmation.promise);
        try {
            f.button().click(); await settle();
            f.page.state.config = normalizeConfig({...ports.config, on: false, count: 123, theme: 'dark'}); await settle();
            confirmation.resolve(); await settle(); expect(f.download).toHaveBeenCalledOnce();
            const backup = JSON.parse(await [...f.blobs.values()][0].text());
            expect(backup.config).toEqual(prepareConfigForExport(ports.config as Config));
        } finally {confirmation.resolve(); await settle(); await f.close();}
    });

    it('forwards the actual data-page and backup-panel availability without remounting the local backup child', async () => {
        const page = await mount(ConfigManagement, {config: ports.config, active: true});
        const latest = () => [...ports.renderedEvents].reverse().find(event => event.tag === LocalDataManagementStub)!;
        const initial = latest().node;
        expect(latest().props.active).toBe(true);
        page.state.active = false; await settle(); expect(latest().props.active).toBe(false);
        page.state.active = true; page.state.activePanel = 'history'; await settle(); expect(latest().props.active).toBe(false);
        page.state.activePanel = 'backup'; await settle(); expect(latest().props.active).toBe(true);
        expect(latest().node.component).toBe(initial.component);
    });

    // 使用真实隐藏 file input 的 change 事件；文件、确认和活跃状态是受控端口，非原生文件选择器。
    const fileJson = () => JSON.stringify({...prepareConfigForExport(ports.config as Config), round22FileMarker: 'controlled-local-import'});
    const filePort = (text: () => Promise<string>, size = 100): Pick<File, 'name' | 'size' | 'text'> => ({name: 'controlled-local-import.json', size, text});
    const preview = (host: HTMLElement) => host.querySelector('[data-testid="local-data-import-dialog"]');

    const openPaste = async (f: Awaited<ReturnType<typeof fixture>>, payload: string) => {
        f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
        input(f.page.host, '[data-testid="restore-source-dialog"] textarea', payload, false); await settle();
        return namedButton(f.page.host.querySelector('[data-testid="restore-source-dialog"]') as HTMLElement, '预览恢复内容');
    };

    it('previews pasted configuration without writing and recovers from invalid JSON in the same source dialog', async () => {
        const f = await fixture();
        try {
            const button = await openPaste(f, '{invalid'); button.click(); await settle();
            expect(ports.messages).toHaveBeenCalledWith('error', expect.stringContaining('无法读取 JSON'));
            expect(preview(f.page.host)).toBeNull(); expect(button.disabled).toBe(false);
            input(f.page.host, '[data-testid="restore-source-dialog"] textarea', fileJson(), false); await settle();
            button.click(); await settle(); expect(preview(f.page.host)?.textContent).toContain('粘贴的旧版 JSON');
            expect(preview(f.page.host)?.textContent).toContain('只恢复设置');
            expect(ports.send).not.toHaveBeenCalled(); expect(ports.patch).not.toHaveBeenCalled();
            preview(f.page.host)?.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click(); await settle();
            expect(preview(f.page.host)).toBeNull(); expect(f.restoreFocus).toHaveBeenCalledOnce();
        } finally {await f.close();}
    });

    it.each(['inactive', 'reopen', 'keepalive', 'unmount'] as const)('rejects a queued pasted-preview action after its view becomes %s', async kind => {
        const f = await fixture();
        try {
            const button = await openPaste(f, fileJson());
            const event = ports.renderedEvents.findLast(item => typeof item.props.onClick === 'function'
                && item.node.children?.default?.().some((child: any) => child.children === '预览恢复内容'))!;
            expect(event).toBeDefined(); const queued = event.props.onClick;
            await f.leave(kind); await queued({currentTarget: button}); await settle();
            expect(preview(f.page.host)).toBeNull(); expect(ports.messages).not.toHaveBeenCalled();
            expect(ports.send).not.toHaveBeenCalled(); expect(ports.patch).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate();
                const fresh = await openPaste(f, fileJson()); fresh.click(); await settle();
                expect(preview(f.page.host)?.textContent).toContain('粘贴的旧版 JSON');
            }
        } finally {await f.close();}
    });

    it('ignores old textarea, file, close and preview receipts after the restore dialog reopens', async () => {
        const f = await fixture(); const fileClick = vi.spyOn(window.HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
        try {
            const oldButton = await openPaste(f, fileJson());
            const source = ports.renderedEvents.findLast(item => item.props['data-testid'] === 'restore-source-dialog')!.props;
            const oldInput = ports.renderedEvents.findLast(item => item.props.type === 'textarea')!.props['onUpdate:modelValue'];
            const action = (label: string) => ports.renderedEvents.findLast(item => typeof item.props.onClick === 'function'
                && item.node.children?.default?.().some((child: any) => child.children === label))!.props.onClick;
            const oldChoose = action('选择文件'), oldPreview = action('预览恢复内容');
            f.page.host.querySelector<HTMLButtonElement>('[data-testid="restore-source-dialog"] [data-dialog-close]')!.click(); await settle();
            const payload = fileJson(), fresh = await openPaste(f, payload);
            oldInput('{stale-invalid'); source['onUpdate:modelValue'](false);
            oldChoose({currentTarget: oldButton}); await oldPreview({currentTarget: oldButton}); await settle();
            expect(f.page.host.querySelector<HTMLTextAreaElement>('[data-testid="restore-source-dialog"] textarea')?.value).toBe(payload);
            expect(preview(f.page.host)).toBeNull(); expect(fileClick).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled();
            fresh.click(); await settle(); expect(preview(f.page.host)?.textContent).toContain('粘贴的旧版 JSON');
        } finally {fileClick.mockRestore(); await f.close();}
    });

    it.each(['source', 'preview'] as const)('does not read a file from an old chooser after a new %s opens', async boundary => {
        const f = await fixture();
        try {
            await openPaste(f, fileJson());
            const oldInput = f.page.host.querySelector<HTMLInputElement>('input[type="file"]')!;
            const oldChange = ports.renderedEvents.findLast(item => item.tag === 'input' && item.props.type === 'file')!.props.onChange;
            f.page.host.querySelector<HTMLButtonElement>('[data-testid="restore-source-dialog"] [data-dialog-close]')!.click(); await settle();
            const payload = fileJson(), currentPreview = await openPaste(f, payload);
            if (boundary === 'preview') {currentPreview.click(); await settle();}
            const text = vi.fn(async () => fileJson());
            Object.defineProperty(oldInput, 'files', {configurable: true, value: [filePort(text)]});
            await oldChange({target: oldInput}); oldInput.dispatchEvent(new Event('change', {bubbles: true})); await settle();
            expect(text).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled();
            expect(oldInput.isConnected).toBe(false);
            if (boundary === 'source') {
                expect(f.page.host.querySelector<HTMLTextAreaElement>('[data-testid="restore-source-dialog"] textarea')?.value).toBe(payload);
                expect(preview(f.page.host)).toBeNull(); currentPreview.click(); await settle();
            }
            expect(preview(f.page.host)?.textContent).toContain('粘贴的旧版 JSON');
        } finally {await f.close();}
    });

    it('continues a confirmed large file in its current view and previews it before any imported write', async () => {
        const f = await fixture(); const confirmation = deferred<void>(); const payload = fileJson();
        const text = vi.fn(async () => payload); const parse = vi.spyOn(JSON, 'parse');
        ports.confirm.mockImplementationOnce(() => confirmation.promise);
        try {
            const selected = await f.chooseFile(filePort(text, 20 * 1024 * 1024 + 1));
            expect(selected.input.value).toBe(''); expect(ports.confirm).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
            expect(f.button().disabled).toBe(true); confirmation.resolve(); await settle();
            expect(text).toHaveBeenCalledOnce(); expect(parse.mock.calls.filter(([value]) => value === payload).length).toBe(1);
            expect(preview(f.page.host)?.textContent).toContain('controlled-local-import.json'); expect(f.button().disabled).toBe(false);
            expect(ports.send).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
        } finally {confirmation.resolve(); await settle(); parse.mockRestore(); await f.close();}
    });

    it.each(['inactive', 'reopen', 'keepalive', 'unmount'] as const)('does not start reading a large file after its confirmation owner becomes %s', async kind => {
        const f = await fixture(); const confirmation = deferred<void>(); const text = vi.fn(async () => fileJson());
        ports.confirm.mockImplementationOnce(() => confirmation.promise);
        try {
            const selected = await f.chooseFile(filePort(text, 20 * 1024 * 1024 + 1));
            expect(selected.input.value).toBe(''); expect(ports.confirm).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
            expect(f.button().disabled).toBe(true);
            await f.leave(kind); confirmation.resolve(); await settle();
            expect(text).not.toHaveBeenCalled(); expect(preview(f.page.host)).toBeNull();
            expect(ports.messages).not.toHaveBeenCalled(); expect(selected.focus).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate(); expect(f.button().disabled).toBe(false);
                const fresh = vi.fn(async () => fileJson()); await f.chooseFile(filePort(fresh));
                expect(fresh).toHaveBeenCalledOnce(); expect(preview(f.page.host)).not.toBeNull();
            }
        } finally {confirmation.resolve(); await settle(); await f.close();}
    });

    it.each([
        ['inactive', 'resolve'], ['reopen', 'resolve'], ['keepalive', 'resolve'], ['unmount', 'resolve'],
        ['inactive', 'reject'], ['reopen', 'reject'], ['keepalive', 'reject'], ['unmount', 'reject'],
    ] as const)('discards a pending file %s/%s continuation before parse, preview, toast or focus', async (kind, outcome) => {
        const f = await fixture(); const pending = deferred<string>(); const payload = fileJson();
        const text = vi.fn(() => pending.promise);
        // 透传原生 JSON.parse，仅对唯一 synthetic 文件字符串计数；不替换生产校验或解析算法。
        const parse = vi.spyOn(JSON, 'parse');
        const parseCount = () => parse.mock.calls.filter(([value]) => value === payload).length;
        try {
            const selected = await f.chooseFile(filePort(text)); expect(text).toHaveBeenCalledOnce(); expect(parseCount()).toBe(0);
            expect(f.button().disabled).toBe(true); await f.leave(kind);
            if (outcome === 'resolve') pending.resolve(payload); else pending.reject(new Error('Controlled file read failure'));
            await settle();
            expect(parseCount()).toBe(0); expect(preview(f.page.host)).toBeNull(); expect(ports.messages).not.toHaveBeenCalled();
            expect(selected.focus).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate(); expect(f.button().disabled).toBe(false);
                const fresh = vi.fn(async () => payload); await f.chooseFile(filePort(fresh));
                expect(fresh).toHaveBeenCalledOnce(); expect(parseCount()).toBe(1); expect(preview(f.page.host)).not.toBeNull();
            }
        } finally {pending.resolve(payload); await settle(); parse.mockRestore(); await f.close();}
    });

    it.each(['cancel', 'close'] as const)('keeps large-file %s at zero reads and permits another file selection', async action => {
        const f = await fixture(); const text = vi.fn(async () => fileJson());
        ports.confirm.mockRejectedValueOnce(action);
        try {
            const selected = await f.chooseFile(filePort(text, 20 * 1024 * 1024 + 1));
            expect(selected.input.value).toBe(''); expect(text).not.toHaveBeenCalled(); expect(preview(f.page.host)).toBeNull();
            expect(ports.messages).not.toHaveBeenCalled(); expect(f.button().disabled).toBe(false);
            await f.chooseFile(filePort(text)); expect(text).toHaveBeenCalledOnce(); expect(preview(f.page.host)).not.toBeNull();
        } finally {await f.close();}
    });

    it('shows a valid file preview with omitted active and does not write any imported data before confirmation', async () => {
        const f = await fixture(true); const payload = fileJson(); const parse = vi.spyOn(JSON, 'parse');
        try {
            const selected = await f.chooseFile(filePort(vi.fn(async () => payload)));
            expect(selected.input.value).toBe(''); expect(parse.mock.calls.filter(([value]) => value === payload).length).toBe(1);
            expect(preview(f.page.host)?.textContent).toContain('controlled-local-import.json'); expect(f.button().disabled).toBe(false);
            expect(ports.confirm).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
        } finally {parse.mockRestore(); await f.close();}
    });

    it('keeps an in-flight file valid across unrelated config replacement', async () => {
        const f = await fixture(); const pending = deferred<string>(); const payload = fileJson();
        try {
            await f.chooseFile(filePort(vi.fn(() => pending.promise)));
            f.page.state.config = normalizeConfig({...ports.config, count: 123, theme: 'dark'}); await settle();
            pending.resolve(payload); await settle();
            expect(preview(f.page.host)).not.toBeNull(); expect(f.button().disabled).toBe(false); expect(ports.messages).not.toHaveBeenCalled();
        } finally {pending.resolve(payload); await settle(); await f.close();}
    });

    it('retains current malformed-file errors and lost-focus return while releasing busy for retry', async () => {
        const f = await fixture(); const payload = 'round22 malformed JSON'; const parse = vi.spyOn(JSON, 'parse');
        try {
            const selected = await f.chooseFile(filePort(vi.fn(async () => payload)));
            expect(parse.mock.calls.filter(([value]) => value === payload).length).toBe(1); expect(preview(f.page.host)).toBeNull();
            expect(ports.messages).toHaveBeenCalledWith('error', expect.stringMatching(/^无法读取备份：/u));
            expect(selected.focus).toHaveBeenCalledOnce(); expect(f.button().disabled).toBe(false);
            await f.chooseFile(filePort(vi.fn(async () => fileJson()))); expect(preview(f.page.host)).not.toBeNull();
        } finally {parse.mockRestore(); await f.close();}
    });

    it.each([
        ['流畅阅读', '', '流畅阅读 备份'], ['FluentRead', '', 'FluentRead 备份'],
        ['FluentRead', '플루언트리드 백업', 'FluentRead 백업'],
    ])('uses the %s product name with legacy label %s while retaining the selected filename', async (brand, legacyLabel, expectedLabel) => {
        ports.brand = brand;
        ports.backupLabelTranslation = legacyLabel;
        const f = await fixture();
        try {
            await f.chooseFile(filePort(async () => '{}'));
            expect(ports.messages).toHaveBeenCalledWith('error', `无法读取备份：不是受支持的 ${brand} 备份或旧版配置文件`);
            expect(preview(f.page.host)).toBeNull(); expect(ports.send).not.toHaveBeenCalled();
            const backup = createFluentReadDataBackup({config: prepareConfigForExport(ports.config as Config),
                vocabulary: {format: 'fluentread-vocabulary-book', version: 1, exportedAt: 1, includesPrivateContext: false, entries: [], reviewLogs: []},
                modelUsage: {format: 'fluentread-model-usage', version: 1, exportedAt: 1, events: []}, exportedAt: 1});
            await f.chooseFile({...filePort(async () => JSON.stringify(backup)), name: 'FluentRead-personal-note.json'});
            expect(preview(f.page.host)?.textContent).toContain(expectedLabel);
            expect(preview(f.page.host)?.textContent).toContain('FluentRead-personal-note.json');
            expect(ports.send).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
        } finally {await f.close();}
    });

    it('rejects a controlled file change already outside the active view and allows a fresh active read', async () => {
        const f = await fixture(); const text = vi.fn(async () => fileJson());
        try {
            f.page.state.active = false; await settle();
            f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            expect(f.page.host.querySelector('[data-testid="restore-source-dialog"]')).toBeNull();
            const input = f.page.host.querySelector<HTMLInputElement>('input[type="file"]')!;
            Object.defineProperty(input, 'files', {configurable: true, value: [filePort(text, 20 * 1024 * 1024 + 1)]});
            input.dispatchEvent(new Event('change', {bubbles: true})); await settle();
            expect(input.value).toBe(''); expect(ports.confirm).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
            expect(f.button().disabled).toBe(false); await f.reactivate();
            await f.chooseFile(filePort(text)); expect(text).toHaveBeenCalledOnce(); expect(preview(f.page.host)).not.toBeNull();
        } finally {await f.close();}
    });

    // 实际预览 footer 的确认 click 已接受领域写入；只控制领域 runtime 回执，不取消半恢复。
    const modelReceipt = {success: true, data: {receivedCount: 0, importedCount: 0, duplicateCount: 0}};
    const vocabularyReceipt = {success: true, data: {inserted: 0, updated: 0, skipped: 0}};
    type ImportOutcome = 'success' | 'model-failure' | 'vocabulary-failure' | 'config-failure';
    let completionRevision = 1000;
    it.each(['config', 'model-usage', 'vocabulary'] as const)('applies an accepted standalone legacy %s import through only its owned domain', async kind => {
        const f = await fixture();
        const document = kind === 'config' ? JSON.parse(fileJson()) : kind === 'model-usage'
            ? {format: 'fluentread-model-usage', version: 1, exportedAt: 1, events: []}
            : {format: 'fluentread-vocabulary-book', version: 1, exportedAt: 1, includesPrivateContext: false, entries: [], reviewLogs: []};
        ports.send.mockImplementation(async (message: {type: string; action?: string}) => {
            if (message.type === 'persistConfig') return {success: true, revision: ++completionRevision};
            if (message.type === 'modelUsage' && message.action === 'import') return modelReceipt;
            if (message.type === VOCABULARY_BOOK_MESSAGE && message.action === 'importData') return vocabularyReceipt;
            throw new Error('Unexpected standalone import IO port');
        });
        try {
            await f.chooseFile(filePort(async () => JSON.stringify(document)));
            expect(ports.send).not.toHaveBeenCalled();
            namedButton(preview(f.page.host) as HTMLElement, '确认导入').click(); await settle();
            expect(ports.send).toHaveBeenCalledOnce();
            expect(ports.send.mock.calls[0][0].type).toBe(kind === 'config' ? 'persistConfig' : kind === 'model-usage' ? 'modelUsage' : VOCABULARY_BOOK_MESSAGE);
            expect(ports.messages).toHaveBeenCalledWith('success', expect.stringContaining('导入完成'));
            expect(preview(f.page.host)).toBeNull(); expect(f.restoreFocus).toHaveBeenCalledOnce();
        } finally {await f.close();}
    });

    async function completionFixture(outcome: ImportOutcome = 'success', delaySourceClosed = false) {
        const f = await fixture(); const model = deferred<unknown>(); const vocabulary = deferred<unknown>();
        const importedConfig = prepareConfigForExport(normalizeConfig({...ports.config, to: 'ja',
            token: {deepseek: 'synthetic-import-primary'}, apiKeys: {deepseek: ['synthetic-import-primary', 'synthetic-import-secondary']}}));
        const backup = createFluentReadDataBackup({config: importedConfig,
            vocabulary: {format: 'fluentread-vocabulary-book', version: 1, exportedAt: 1, includesPrivateContext: false, entries: [], reviewLogs: []},
            modelUsage: {format: 'fluentread-model-usage', version: 1, exportedAt: 1, events: []}, exportedAt: 1});
        ports.send.mockImplementation(async (message: {type: string; action?: string; config?: Config; baseRevision?: number}) => {
            if (message.type === 'modelUsage' && message.action === 'import') return model.promise;
            if (message.type === VOCABULARY_BOOK_MESSAGE && message.action === 'importData') return vocabulary.promise;
            if (message.type === 'persistConfig') return outcome === 'config-failure'
                ? {success: false, error: 'Controlled CAS conflict'} : {success: true, revision: ++completionRevision};
            throw new Error('Unexpected accepted import IO port');
        });
        ports.delayDialogClosed = delaySourceClosed;
        await f.chooseFile(filePort(async () => JSON.stringify(backup)));
        const confirm = () => namedButton(preview(f.page.host) as HTMLElement, '确认导入');
        const calls = () => ports.send.mock.calls.map(([message]) => [message.type, message.action ?? 'replace']);
        const finishModel = async () => {model.resolve(outcome === 'model-failure' ? {success: false, error: 'Controlled model import failure'} : modelReceipt); await settle();};
        const finishVocabulary = async () => {vocabulary.resolve(outcome === 'vocabulary-failure' ? {success: false, error: {message: 'Controlled vocabulary import failure'}} : vocabularyReceipt); await settle();};
        return {...f, backup, confirm, calls, finishModel, finishVocabulary, async close() {
            model.resolve(modelReceipt); vocabulary.resolve(vocabularyReceipt); await settle(); await f.close();
        }};
    }

    it.each(['success', 'model-failure', 'vocabulary-failure', 'config-failure'] as const)('finishes current complete import %s through all real client domains and releases its preview', async outcome => {
        const f = await completionFixture(outcome);
        try {
            const confirm = f.confirm(); confirm.click(); await settle();
            expect(f.calls()).toEqual([['modelUsage', 'import']]); expect(confirm.disabled).toBe(true);
            confirm.click(); await settle(); expect(f.calls()).toHaveLength(1);
            await f.finishModel(); expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData']]);
            await f.finishVocabulary();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]);
            const saved = ports.send.mock.calls.find(([message]) => message.type === 'persistConfig')![0];
            expect(saved.config).toMatchObject({to: 'ja', apiKeys: {deepseek: ['synthetic-import-primary', 'synthetic-import-secondary']}});
            expect(Number.isSafeInteger(saved.baseRevision)).toBe(true); expect(saved.baseRevision).toBeGreaterThanOrEqual(0);
            expect(saved.sequence).toBeGreaterThan(0); expect(saved.clientId).toEqual(expect.any(String));
            expect(ports.messages).toHaveBeenCalledOnce(); expect(ports.messages.mock.calls[0][0]).toBe(outcome === 'success' ? 'success' : 'error');
            expect(ports.messages.mock.calls[0][1]).toContain(outcome === 'success' ? '导入完成' : '导入完成但有失败项');
            expect(preview(f.page.host)).toBeNull(); expect(f.button().disabled).toBe(false); expect(f.restoreFocus).toHaveBeenCalledOnce();
        } finally {await f.close();}
    });

    it.each([
        ['inactive', 'model', 'success'], ['reopen', 'model', 'success'], ['keepalive', 'model', 'success'], ['unmount', 'model', 'success'],
        ['inactive', 'vocabulary', 'model-failure'], ['reopen', 'vocabulary', 'vocabulary-failure'], ['keepalive', 'vocabulary', 'config-failure'], ['unmount', 'vocabulary', 'vocabulary-failure'],
    ] as const)('completes accepted %s/%s/%s writes without a stale completion toast or focus', async (kind, gate, outcome) => {
        const f = await completionFixture(outcome);
        try {
            f.confirm().click(); await settle(); expect(f.calls()).toEqual([['modelUsage', 'import']]);
            if (gate === 'vocabulary') await f.finishModel();
            await f.leave(kind);
            if (gate === 'model') await f.finishModel();
            await f.finishVocabulary();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]);
            expect.soft(ports.messages).not.toHaveBeenCalled(); expect.soft(f.restoreFocus).not.toHaveBeenCalled();
            if (kind !== 'unmount') {
                await f.reactivate(); expect(f.button().disabled).toBe(false); expect(preview(f.page.host)).toBeNull();
                await f.chooseFile({...filePort(async () => fileJson()), name: 'fresh-after-accepted.json'});
                expect(preview(f.page.host)?.textContent).toContain('fresh-after-accepted.json'); expect(f.confirm().disabled).toBe(false);
            }
        } finally {await f.close();}
    });

    it.each(['count', 'theme'] as const)('retains the complete config fingerprint contract when %s changes during accepted IO', async field => {
        const f = await completionFixture();
        try {
            f.confirm().click(); await settle();
            f.page.state.config = normalizeConfig({...ports.config, ...field === 'count' ? {count: 123} : {theme: 'dark'}}); await settle();
            await f.finishModel(); await f.finishVocabulary();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ...field === 'count' ? [['persistConfig', 'replace']] : []]);
            if (field === 'count') {
                expect(ports.send.mock.calls.find(([message]) => message.type === 'persistConfig')![0].config.count).toBe(123);
                expect(ports.messages).toHaveBeenCalledWith('success', expect.stringContaining('设置已应用'));
            } else expect(ports.messages).toHaveBeenCalledWith('error', expect.stringContaining('设置在导入期间已被其他页面修改'));
            expect(f.button().disabled).toBe(false); expect(preview(f.page.host)).toBeNull();
        } finally {await f.close();}
    });

    it('retires the accepted target before delayed closed so its retained footer cannot import it twice', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true;
            const confirm = f.confirm(); confirm.click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            expect(preview(f.page.host)?.getAttribute('data-dialog-visible')).toBe('false'); expect(ports.pendingDialogClosed.size).toBe(1);
            expect.soft(confirm.disabled).toBe(true); confirm.click(); await settle();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]);
            for (const closed of [...ports.pendingDialogClosed]) closed(); await settle();
            expect(preview(f.page.host)).toBeNull(); expect(f.button().disabled).toBe(false);
        } finally {await f.close();}
    });

    it('keeps a fresh preview and focus intact when an old accepted preview delivers its captured closed callback', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true; f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            expect(ports.pendingDialogClosed.size).toBe(1);
            // 捕获 SFC 交给公开 render API 的事件；只迟到递送 handler，不让端口旧帧关闭新 DOM。
            const oldClosed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            expect(oldClosed).toEqual(expect.any(Function));
            await f.chooseFile({...filePort(async () => fileJson()), name: 'fresh-owned-preview.json'});
            expect(preview(f.page.host)?.textContent).toContain('fresh-owned-preview.json');
            const calls = f.calls(); const focusCalls = f.restoreFocus.mock.calls.length;
            oldClosed(); await settle();
            expect.soft(preview(f.page.host)?.textContent).toContain('fresh-owned-preview.json');
            expect.soft(f.confirm().disabled).toBe(false); expect(f.calls()).toEqual(calls);
            expect(f.restoreFocus.mock.calls.length).toBe(focusCalls);
        } finally {await f.close();}
    });

    it('withholds a captured source closed focus after an accepted import leaves and returns to the view', async () => {
        const f = await completionFixture('success', true);
        try {
            const oldClosed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'restore-source-dialog')!.props.onClosed as () => void;
            expect(oldClosed).toEqual(expect.any(Function));
            f.confirm().click(); await settle(); await f.leave('reopen'); await f.finishModel(); await f.finishVocabulary();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]);
            expect(f.restoreFocus).not.toHaveBeenCalled(); oldClosed(); await settle();
            expect(f.restoreFocus).not.toHaveBeenCalled();
        } finally {await f.close();}
    });

    it('returns normal accepted focus once after the dialog closed receipt and consumes duplicate receipts', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true; f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            const closed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            expect(f.restoreFocus).not.toHaveBeenCalled(); expect(ports.messages).toHaveBeenCalledOnce();
            for (const receipt of [...ports.pendingDialogClosed]) receipt(); await settle();
            expect(f.restoreFocus).toHaveBeenCalledOnce(); expect(preview(f.page.host)).toBeNull();
            closed(); await settle(); expect(f.restoreFocus).toHaveBeenCalledOnce();
        } finally {await f.close();}
    });

    it('returns current cancelled-preview focus once and allows a fresh preview without accepted writes', async () => {
        const f = await completionFixture();
        try {
            namedButton(preview(f.page.host) as HTMLElement, '取消').click(); await settle();
            expect(preview(f.page.host)).toBeNull(); expect(f.restoreFocus).toHaveBeenCalledOnce(); expect(ports.send).not.toHaveBeenCalled();
            await f.chooseFile({...filePort(async () => fileJson()), name: 'fresh-after-cancel.json'});
            expect(preview(f.page.host)?.textContent).toContain('fresh-after-cancel.json'); expect(f.confirm().disabled).toBe(false);
        } finally {await f.close();}
    });

    it.each((['replace', 'reactivate', 'keepalive'] as const).flatMap(boundary =>
        (['confirm', 'cancel', 'visibility'] as const).map(action => ({boundary, action})),
    ))('rejects old preview $action after $boundary while keeping the current preview usable', async ({boundary, action}) => {
        const f = await fixture();
        ports.send.mockResolvedValue({success: true, revision: ++completionRevision});
        try {
            await f.chooseFile(filePort(async () => fileJson()));
            const dialog = ports.renderedEvents.findLast(item => item.props['data-testid'] === 'local-data-import-dialog')!.props;
            const label = action === 'confirm' ? '确认导入' : '取消';
            const oldAction = action === 'visibility' ? dialog['onUpdate:modelValue']
                : ports.renderedEvents.findLast(item => typeof item.props.onClick === 'function'
                    && item.node.children?.default?.().some((child: any) => child.children === label))!.props.onClick;
            if (boundary === 'replace') {
                namedButton(preview(f.page.host) as HTMLElement, '取消').click(); await settle();
                await f.chooseFile({...filePort(async () => fileJson()), name: 'current-preview.json'});
            } else {
                await f.leave(boundary === 'reactivate' ? 'reopen' : 'keepalive'); await f.reactivate();
            }
            const currentText = preview(f.page.host)!.textContent, focusCount = f.restoreFocus.mock.calls.length;
            await oldAction(false); await settle();
            expect(ports.send).not.toHaveBeenCalled(); expect(ports.messages).not.toHaveBeenCalled();
            expect(preview(f.page.host)?.textContent).toBe(currentText);
            expect(f.restoreFocus.mock.calls.length).toBe(focusCount);
            namedButton(preview(f.page.host) as HTMLElement, '确认导入').click(); await settle();
            expect(ports.send).toHaveBeenCalledOnce(); expect(ports.send.mock.calls[0][0].type).toBe('persistConfig');
            expect(preview(f.page.host)).toBeNull();
        } finally {await f.close();}
    });

    it('disowns the old preview closed receipt when a new source is opened before another file is selected', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true; f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            const oldClosed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            oldClosed(); await settle(); expect(f.restoreFocus).not.toHaveBeenCalled();
            expect(f.page.host.querySelector('[data-testid="restore-source-dialog"]')?.getAttribute('data-dialog-visible')).toBe('true');
            await f.chooseFile({...filePort(async () => fileJson()), name: 'fresh-source-selection.json'});
            expect(preview(f.page.host)?.textContent).toContain('fresh-source-selection.json'); expect(f.confirm().disabled).toBe(false);
        } finally {await f.close();}
    });

    it('rechecks preview focus ownership after nextTick when another source opens in the same job', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true; f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            const oldClosed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            oldClosed(); f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            expect(f.restoreFocus).not.toHaveBeenCalled();
            expect(f.page.host.querySelector('[data-testid="restore-source-dialog"]')?.getAttribute('data-dialog-visible')).toBe('true');
        } finally {await f.close();}
    });

    it('preserves external focus acquired before a current preview closed focus continuation runs', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true; f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            const closed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            closed();
            const outside = dom.document.createElement('button'); dom.document.body.append(outside);
            Object.defineProperty(dom.document, 'activeElement', {configurable: true, value: outside}); await settle();
            expect(f.restoreFocus).not.toHaveBeenCalled(); expect(dom.document.activeElement).toBe(outside);
        } finally {await f.close();}
    });

    it('refuses inactive preview confirmation but permits an explicitly accepted fresh preview on return', async () => {
        const f = await completionFixture();
        try {
            await f.leave('inactive'); f.confirm().click(); await settle(); expect(ports.send).not.toHaveBeenCalled();
            await f.reactivate(); namedButton(preview(f.page.host) as HTMLElement, '取消').click(); await settle();
            await f.chooseFile({...filePort(async () => JSON.stringify(f.backup)), name: 'fresh-after-inactive.json'});
            f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
            expect(f.calls()).toEqual([['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]);
            expect(ports.messages).toHaveBeenCalledWith('success', expect.stringContaining('导入完成')); expect(f.restoreFocus).toHaveBeenCalledOnce();
        } finally {await f.close();}
    });

    it('rechecks source closed focus after nextTick and preserves the next source normal close', async () => {
        const f = await fixture();
        try {
            ports.delayDialogClosed = true;
            const open = f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1]; open.click(); await settle();
            const source = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'restore-source-dialog')!;
            (source.props['onUpdate:modelValue'] as (value: boolean) => void)(false); await settle();
            (source.props.onClosed as () => void)(); open.click(); await settle();
            expect(f.restoreFocus).not.toHaveBeenCalled();
            expect(f.page.host.querySelector('[data-testid="restore-source-dialog"]')?.getAttribute('data-dialog-visible')).toBe('true');
            const current = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'restore-source-dialog')!;
            (current.props['onUpdate:modelValue'] as (value: boolean) => void)(false); await settle();
            for (const closed of [...ports.pendingDialogClosed]) closed(); await settle();
            expect(f.restoreFocus).toHaveBeenCalledOnce(); expect(ports.send).not.toHaveBeenCalled();
        } finally {await f.close();}
    });

    it('retires a cancelled target when a new source opens and closes without choosing another file', async () => {
        const f = await completionFixture();
        try {
            ports.delayDialogClosed = true;
            const confirm = f.confirm();
            const oldClosed = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void;
            namedButton(preview(f.page.host) as HTMLElement, '取消').click(); await settle();
            f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            expect(confirm.disabled).toBe(true); expect(preview(f.page.host)?.querySelector('.import-file-summary')).toBeNull();
            const source = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'restore-source-dialog')!;
            (source.props['onUpdate:modelValue'] as (value: boolean) => void)(false); await settle();
            for (const closed of [...ports.pendingDialogClosed]) closed(); await settle();
            expect(preview(f.page.host)).toBeNull(); expect(f.restoreFocus).toHaveBeenCalledOnce();
            oldClosed(); await settle(); expect(f.restoreFocus).toHaveBeenCalledOnce();
            expect(ports.send).not.toHaveBeenCalled(); expect(f.button().disabled).toBe(false);
        } finally {await f.close();}
    });

    it('preserves normal focus through two complete preview cycles and rejects their old closed receipts in a fresh source', async () => {
        const f = await completionFixture();
        try {
            const oldClosed: (() => void)[] = [];
            for (let cycle = 0; cycle < 2; cycle++) {
                if (cycle) await f.chooseFile({...filePort(async () => JSON.stringify(f.backup)), name: 'second-complete-preview.json'});
                oldClosed.push([...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'local-data-import-dialog')!.props.onClosed as () => void);
                f.confirm().click(); await settle(); await f.finishModel(); await f.finishVocabulary();
                expect(preview(f.page.host)).toBeNull(); expect(f.button().disabled).toBe(false);
                expect(f.restoreFocus).toHaveBeenCalledTimes(cycle + 1);
                expect(ports.messages).toHaveBeenCalledTimes(cycle + 1);
            }
            expect(f.calls()).toEqual(Array.from({length: 2}, () => [['modelUsage', 'import'], [VOCABULARY_BOOK_MESSAGE, 'importData'], ['persistConfig', 'replace']]).flat());
            f.page.host.querySelectorAll<HTMLButtonElement>('.transfer-actions button')[1].click(); await settle();
            for (const closed of oldClosed) closed(); await settle();
            expect(f.restoreFocus).toHaveBeenCalledTimes(2);
            expect(f.page.host.querySelector('[data-testid="restore-source-dialog"]')?.getAttribute('data-dialog-visible')).toBe('true');
            const source = [...ports.renderedEvents].reverse().find(event => event.props['data-testid'] === 'restore-source-dialog')!;
            (source.props['onUpdate:modelValue'] as (value: boolean) => void)(false); await settle();
            expect(f.restoreFocus).toHaveBeenCalledTimes(3); expect(ports.send).toHaveBeenCalledTimes(6);
            expect(ports.messages).toHaveBeenCalledTimes(2);
        } finally {await f.close();}
    });
});
