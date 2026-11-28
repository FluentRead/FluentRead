import './helpers/vueDomFixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {App} from 'vue';
import type {DriveSyncPreview, DriveSyncStatus} from '@/src/services/config/remoteConfigSync';
import type {CloudPassphraseStatus} from '@/src/services/config/cloudPassphraseStore';
import type {CloudAutoSyncStatus} from '@/src/services/config/cloudAutoSync';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: (window as unknown as Record<string, unknown>)[name]});
    }
    return {window, document};
});
const mocks = vi.hoisted(() => ({success: vi.fn(), send: vi.fn(), errors: [] as unknown[]}));

import * as Vue from 'vue';
import RemoteConfigSync from '@/src/features/settings/ui/RemoteConfigSync.vue';
import {CloudBackupRequestError} from '@/src/services/config/cloudBackupClient';
import {googleDriveSyncClient} from '@/src/services/config/googleDriveSyncClient';
import {webDavBackupClient} from '@/src/services/config/webDavBackupClient';

vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: mocks.send}}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text, language: Vue.ref('zh-CN')})}));
vi.mock('@element-plus/icons-vue', () => Object.fromEntries(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'CircleCheck', 'Delete', 'Download', 'Switch', 'Upload', 'User', 'Warning'].map(name => [name, {render: () => null}])));
vi.mock('element-plus/es/components/alert/style/css', () => ({}));
vi.mock('element-plus/es/components/input/style/css', () => ({}));
vi.mock('element-plus/es/components/pagination/style/css', () => ({}));
vi.mock('element-plus/es/components/popover/style/css', () => ({}));
vi.mock('element-plus/es/components/switch/style/css', () => ({}));
vi.mock('element-plus', () => ({
    ElMessage: {success: (...args: unknown[]) => mocks.success(...args)},
    ElAlert: {props: ['title', 'description'], setup: (props: Record<string, unknown>) => () => Vue.h('div', {role: 'alert'}, [props.title as string, props.description as string])},
    ElIcon: {setup: (_: unknown, {slots}: any) => () => Vue.h('i', slots.default?.())},
    ElInput: {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        setup: (props: any, {attrs, emit}: any) => () => Vue.h('input', {
            ...attrs,
            value: props.modelValue,
            disabled: props.disabled,
            onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
        }),
    },
    ElSwitch: {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue', 'change'],
        setup: (props: any, {attrs, emit}: any) => () => Vue.h('button', {
            ...attrs,
            type: 'button',
            role: 'switch',
            disabled: props.disabled,
            'aria-checked': String(props.modelValue),
            onClick: () => {emit('update:modelValue', !props.modelValue); emit('change', !props.modelValue);},
        }),
    },
    ElPopover: {setup: (_: unknown, {slots}: any) => () => Vue.h('div', [slots.reference?.(), slots.default?.()])},
    ElPagination: {setup: () => () => Vue.h('div')},
}));

const apps = new Set<App>();
const storage = new Map<string, string>();

async function settle() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
        await Vue.nextTick();
    }
}

beforeEach(() => {
    mocks.success.mockClear();
    mocks.send.mockReset();
    mocks.errors.length = 0;
    storage.clear();
    dom.document.body.replaceChildren();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    });
});

afterEach(async () => {
    const mounted = [...apps];
    apps.clear();
    for (const app of mounted) app.unmount();
    await settle();
    expect(mocks.errors).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function mountRemote(client: Record<string, unknown>, kind: 'webdav' | 'google-drive' = 'webdav') {
    const host = dom.document.createElement('main');
    dom.document.body.append(host);
    const app = Vue.createApp({render: () => Vue.h(RemoteConfigSync, {client: client as never, kind, provider: kind === 'webdav' ? 'WebDAV' : 'Google Drive'})});
    app.component('el-button', {props: ['disabled'], setup: (props: any, {attrs, slots}: any) => () => Vue.h('button', {...attrs, type: 'button', disabled: props.disabled}, slots.default?.())});
    app.component('el-dialog', {
        props: ['modelValue'],
        emits: ['closed', 'update:modelValue'],
        setup: (props: any, {attrs, slots}: any) => () => props.modelValue ? Vue.h('section', {...attrs, role: 'dialog'}, [slots.default?.(), slots.footer?.()]) : null,
    });
    const {ElSwitch} = await import('element-plus');
    app.component('el-switch', ElSwitch);
    app.config.warnHandler = () => {};
    app.config.errorHandler = error => mocks.errors.push(error);
    app.mount(host);
    apps.add(app);
    await settle();
    expect(mocks.errors).toEqual([]);
    return host;
}

async function click(host: HTMLElement, selector: string) {
    const el = host.querySelector<HTMLButtonElement>(selector);
    expect(el, selector).not.toBeNull();
    expect(el!.disabled).toBe(false);
    el!.click();
    await settle();
}

async function typeInput(host: HTMLElement, selector: string, value: string) {
    const el = host.querySelector<HTMLInputElement>(selector);
    expect(el, selector).not.toBeNull();
    el!.value = value;
    el!.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    await settle();
}

function fullClient() {
    const account = {id: 'webdav:rev-1', email: 'u · dav.example.test'};
    const statusValue: DriveSyncStatus = {available: true, reason: '', account, lastSyncedAt: 1000};
    let passState: CloudPassphraseStatus = {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'};
    let autoState: CloudAutoSyncStatus = {
        enabled: false,
        intervalMinutes: 60,
        includeSensitive: false,
        learningScope: {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false},
        state: 'idle',
        lastAttemptAt: null,
        lastSyncedAt: null,
        nextRetryAt: null,
        consecutiveFailures: 0,
        conflictCount: 0,
    };
    const previewValue: DriveSyncPreview = {
        id: 'preview-upgrade-1',
        account,
        hasRemote: true,
        includeSensitive: false,
        remoteIncludesSensitive: false,
        hasBaseline: true,
        keyMode: 'custom',
        remoteKeyMode: 'app',
        learningSummary: {
            vocabulary: {enabled: true, remoteAvailable: true, localCount: 3, remoteCount: 4, addedFromRemote: 2, updatedFromRemote: 1, addedToRemote: 1, updatedToRemote: 0, hasChanges: true},
            personalCorrections: {enabled: true, remoteAvailable: true, localCount: 2, remoteCount: 2, addedFromRemote: 0, updatedFromRemote: 0, addedToRemote: 0, updatedToRemote: 0, hasChanges: false},
            readingMaterials: {enabled: false, remoteAvailable: false, localCount: 0, remoteCount: 0, addedFromRemote: 0, updatedFromRemote: 0, addedToRemote: 0, updatedToRemote: 0, hasChanges: false},
            hasAnyChanges: true,
        },
        changes: [],
        expiresAt: Date.now() + 60_000,
    };
    return {
        status: vi.fn(async () => ({...statusValue})),
        prepare: vi.fn(async () => structuredClone(previewValue)),
        commit: vi.fn(async () => ({...statusValue})),
        cancel: vi.fn(async () => undefined),
        prepareDelete: vi.fn(async () => ({id: 'del-1', account, hasRemote: true, canDelete: true, expiresAt: Date.now() + 60_000})),
        commitDelete: vi.fn(async () => ({...statusValue, deleted: true})),
        passphraseStatus: vi.fn(async () => ({...passState})),
        configurePassphrase: vi.fn(async input => {
            passState = input.mode === 'app'
                ? {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'}
                : {mode: 'custom', hasStoredPassphrase: input.rememberScope !== 'none', storageScope: input.rememberScope ?? 'session'};
            return {...passState};
        }),
        clearPassphrase: vi.fn(async () => {
            passState = {mode: passState.mode, hasStoredPassphrase: false, storageScope: 'none'};
            return {...passState};
        }),
        autoSyncStatus: vi.fn(async () => ({...autoState})),
        configureAutoSync: vi.fn(async patch => {
            autoState = {...autoState, ...patch, learningScope: {...autoState.learningScope, ...(patch.learningScope ?? {})}};
            return {...autoState};
        }),
        runAutoSyncNow: vi.fn(async () => {
            autoState = {...autoState, state: 'synced', lastSyncedAt: 2000};
            return {...autoState};
        }),
    };
}

describe('RemoteConfigSync upgraded E2EE, learning sync, and auto-sync UI & client contracts', () => {
    it('configures custom E2EE passphrase with validation, strength feedback, forget, and auto-switches on passphraseRequired', async () => {
        const client = fullClient();
        const host = await mountRemote(client);

        expect(host.querySelector('[data-testid="cloud-e2ee-status"]')?.textContent).toBe('settings.cloud.e2ee.statusLegacy');

        // Switch to custom mode -> validate mismatch & strength -> apply -> forget
        const customRadio = host.querySelector<HTMLInputElement>('[data-testid="cloud-e2ee-mode-custom"]')!;
        customRadio.checked = true;
        customRadio.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await settle();

        await typeInput(host, '[data-testid="cloud-e2ee-passphrase"]', 'short');
        expect(host.querySelector('[data-testid="cloud-e2ee-strength"]')?.textContent).toBe('settings.cloud.e2ee.strength.too-short');
        expect(host.querySelector<HTMLButtonElement>('[data-testid="cloud-e2ee-apply"]')!.disabled).toBe(true);

        await typeInput(host, '[data-testid="cloud-e2ee-passphrase"]', 'StrongPassphrase!2026');
        expect(host.querySelector('[data-testid="cloud-e2ee-strength"]')?.textContent).toBe('settings.cloud.e2ee.strength.strong');
        await typeInput(host, '[data-testid="cloud-e2ee-confirm"]', 'DifferentPassphrase!2026');
        expect(host.querySelector('[data-testid="cloud-e2ee-mismatch"]')).not.toBeNull();
        expect(host.querySelector<HTMLButtonElement>('[data-testid="cloud-e2ee-apply"]')!.disabled).toBe(true);

        await typeInput(host, '[data-testid="cloud-e2ee-confirm"]', 'StrongPassphrase!2026');
        expect(host.querySelector('[data-testid="cloud-e2ee-mismatch"]')).toBeNull();
        await click(host, '[data-testid="cloud-e2ee-apply"]');
        expect(client.configurePassphrase).toHaveBeenCalledWith({
            mode: 'custom',
            rememberScope: 'session',
            passphrase: 'StrongPassphrase!2026',
        });
        expect(host.querySelector('[data-testid="cloud-e2ee-status"]')?.textContent).toBe('settings.cloud.e2ee.statusSession');

        // One-click forget clears stored passphrase
        await click(host, '[data-testid="cloud-e2ee-forget"]');
        expect(client.clearPassphrase).toHaveBeenCalledOnce();
        expect(host.querySelector('[data-testid="cloud-e2ee-status"]')?.textContent).toBe('settings.cloud.e2ee.statusLocked');

        // Passphrase-required error when syncing in app mode switches mode to custom automatically
        const appRadio = host.querySelector<HTMLInputElement>('[data-testid="cloud-e2ee-mode-app"]')!;
        appRadio.checked = true;
        appRadio.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await settle();
        client.prepare.mockRejectedValueOnce(new CloudBackupRequestError('locked', 'settings.cloud.e2ee.passphraseRequired'));
        await click(host, '[data-testid="webdav-sync-now"]');
        expect(host.querySelector<HTMLInputElement>('[data-testid="cloud-e2ee-mode-custom"]')!.checked).toBe(true);
    });

    it('toggles learning assets, displays per-category diff & E2EE upgrade banner, and controls WebDAV auto-sync', async () => {
        const client = fullClient();
        const host = await mountRemote(client);

        // Learning toggles default OFF; enabling vocabulary reveals context sub-toggle
        expect(host.querySelector('[data-testid="cloud-include-vocabulary-context"]')).toBeNull();
        await click(host, '[data-testid="cloud-include-vocabulary"]');
        expect(host.querySelector('[data-testid="cloud-include-vocabulary-context"]')).not.toBeNull();
        await click(host, '[data-testid="cloud-include-corrections"]');

        // Sync now sends learningScope and shows learning diff + E2EE upgrade banner in preview dialog
        await click(host, '[data-testid="webdav-sync-now"]');
        expect(client.prepare).toHaveBeenCalledWith(false, expect.objectContaining({
            learningScope: {
                includeVocabulary: true,
                includeVocabularyContext: false,
                includePersonalCorrections: true,
                includeReadingMaterials: false,
            },
        }));
        expect(host.querySelector('[data-testid="cloud-e2ee-upgrade-notice"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="cloud-learning-diff-vocabulary"]')?.textContent).toContain('settings.cloud.learning.diffSummary');
        expect(host.querySelector('[data-testid="cloud-learning-diff-corrections"]')?.textContent).toContain('settings.cloud.learning.noChanges');
        await click(host, '[data-testid="webdav-confirm"]');
        expect(client.commit).toHaveBeenCalledWith('preview-upgrade-1', 'merge', {}, {keyMode: 'app'});

        // WebDAV auto-sync toggle, interval change, and manual safe merge trigger
        await click(host, '[data-testid="cloud-auto-sync-enabled"]');
        expect(client.configureAutoSync).toHaveBeenCalledWith(expect.objectContaining({enabled: true}));
        const select = host.querySelector<HTMLSelectElement>('[data-testid="cloud-auto-sync-interval"]')!;
        Object.defineProperty(select, 'value', {configurable: true, value: '360'});
        select.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await settle();
        expect(client.configureAutoSync).toHaveBeenLastCalledWith({intervalMinutes: 360});
        await click(host, '[data-testid="cloud-auto-sync-run-now"]');
        expect(client.runAutoSyncNow).toHaveBeenCalledOnce();
        expect(host.querySelector('[data-testid="cloud-auto-sync-status"]')?.textContent).toBe('settings.cloud.autoSync.statusSynced');

        // Google Drive UI (without auto-sync) hides "(for auto-sync)" label in device retention option
        const driveClient = fullClient();
        delete (driveClient as Partial<typeof driveClient>).autoSyncStatus;
        delete (driveClient as Partial<typeof driveClient>).configureAutoSync;
        delete (driveClient as Partial<typeof driveClient>).runAutoSyncNow;
        const driveHost = await mountRemote(driveClient, 'google-drive');
        const driveCustom = driveHost.querySelector<HTMLInputElement>('[data-testid="cloud-e2ee-mode-custom"]')!;
        driveCustom.checked = true;
        driveCustom.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await settle();
        expect(driveHost.querySelector('[data-testid="cloud-e2ee-remember"] option[value="device"]')?.textContent).toBe('settings.cloud.e2ee.rememberDeviceNoAutoSync');
    });

    it('sends extended passphrase, learningScope, and autoSync messages from typed clients', async () => {
        mocks.send.mockResolvedValue({success: true, data: {ok: true}});
        await googleDriveSyncClient.passphraseStatus();
        await googleDriveSyncClient.configurePassphrase({mode: 'custom', passphrase: 'StrongPassphrase!2026', rememberScope: 'session'});
        await googleDriveSyncClient.clearPassphrase();
        await googleDriveSyncClient.prepare(false, {
            keyMode: 'custom',
            passphrase: 'StrongPassphrase!2026',
            learningScope: {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false},
        });
        await googleDriveSyncClient.commit('p1', 'merge', {'0': 'local'}, {keyMode: 'custom', passphrase: 'StrongPassphrase!2026'});
        await webDavBackupClient.autoSyncStatus();
        await webDavBackupClient.configureAutoSync({enabled: true, intervalMinutes: 30});
        await webDavBackupClient.runAutoSyncNow();

        expect(mocks.send.mock.calls.map(([msg]) => msg.action)).toEqual([
            'passphraseStatus',
            'configurePassphrase',
            'clearPassphrase',
            'prepare',
            'commit',
            'autoSyncStatus',
            'configureAutoSync',
            'runAutoSyncNow',
        ]);
    });
});
