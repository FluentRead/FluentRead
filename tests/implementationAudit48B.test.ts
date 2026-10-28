import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {encryptConfigValue, decryptConfigValue, type ConfigCryptoRuntime} from '@/src/platform/storage/configEncryption';
import {EncryptedConfigRepository, FluentReadConfigDatabase} from '@/src/platform/storage/configRepository';
import {createBackgroundConfigStorage, createRemoteConfigStorage, CONFIG_STORAGE_CHANGED_MESSAGE, type ConfigStoragePort} from '@/src/platform/storage/configStorage';
import * as schema from '@/src/services/config/schema';
import {parseConfigAutoBackups} from '@/src/services/config/autoBackup';
import {parseConfigHistory} from '@/src/services/config/history';
import {createGoogleDriveSync} from '@/src/services/config/googleDriveSync';
import type {DriveSyncPorts, DriveSyncState} from '@/src/services/config/remoteConfigSync';

const legacyRuntime = vi.hoisted(() => ({values: new Map<string, unknown>(), unavailableSession: false}));
vi.mock('@wxt-dev/storage', () => ({storage: {
    async getItem(key: string) {
        if (key.startsWith('session:') && legacyRuntime.unavailableSession) throw new Error('controlled unavailable session');
        return structuredClone(legacyRuntime.values.get(key) ?? null);
    },
    async setItem(key: string, value: unknown) {
        if (key.startsWith('session:') && legacyRuntime.unavailableSession) throw new Error('controlled unavailable session');
        legacyRuntime.values.set(key, structuredClone(value));
    },
    async removeItem(key: string) {legacyRuntime.values.delete(key);},
}}));
const runtimePort = vi.hoisted(() => ({storage: null as ConfigStoragePort | null}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {
    get writeOwner() {return runtimePort.storage?.writeOwner;},
    getItem: (key: string) => runtimePort.storage!.getItem(key),
    setItem: (key: string, value: unknown) => runtimePort.storage!.setItem(key, value),
    get setItemIfUnchanged() {return runtimePort.storage?.setItemIfUnchanged?.bind(runtimePort.storage);},
    get setItems() {return runtimePort.storage?.setItems?.bind(runtimePort.storage);},
    removeItem: (key: string) => runtimePort.storage!.removeItem(key),
    watch: (key: string, callback: (value: unknown, previous?: unknown) => void) => runtimePort.storage!.watch(key, callback),
}}));

const databases: FluentReadConfigDatabase[] = [];
const fixtureDisposers: Array<() => void> = [];
function database() {
    const db = new FluentReadConfigDatabase(`audit48b-${crypto.randomUUID()}`);
    databases.push(db);
    return db;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
function background(repository: EncryptedConfigRepository) {
    return createBackgroundConfigStorage({repository, legacy: {
        getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined,
    }});
}
const storedConfig = {on: true, service: 'freeTranslation', from: 'auto', to: 'zh-Hans', videoServiceDefaultMigrated: true};
function backups(version: number, to: string) {
    return {schemaVersion: 1, entries: [{version, savedAt: '2026-10-06T00:00:00Z', config: {...storedConfig, to}}], nextVersion: version + 1};
}
async function loadBackupStore(port: ConfigStoragePort) {
    runtimePort.storage = port;
    vi.stubGlobal('location', {protocol: 'chrome-extension:'});
    vi.resetModules();
    const config = await import('@/src/services/config/store');
    await Promise.all([config.configReady, config.configHistoryReady]);
    return import('@/src/services/config/autoBackupStore');
}
async function userscriptFixture(initial?: unknown) {
    const values = new Map<string, string>([['local:config', JSON.stringify(storedConfig)]]);
    if (initial !== undefined) values.set('local:configAutoBackups', JSON.stringify(initial));
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {visibilityState: 'visible'});
    for (const target of [window, document]) {
        vi.spyOn(target, 'addEventListener').mockImplementation((type, callback, options) => {
            EventTarget.prototype.addEventListener.call(target, type, callback, options);
            fixtureDisposers.push(() => target.removeEventListener(type, callback, options));
        });
    }
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    vi.stubGlobal('GM_getValue', async (key: string, fallback: unknown) => values.get(key) ?? fallback);
    const setValue = vi.fn(async (key: string, value: string) => {values.set(key, value);});
    vi.stubGlobal('GM_setValue', setValue);
    vi.stubGlobal('GM_deleteValue', async (key: string) => {values.delete(key);});
    vi.resetModules();
    const adapter = await import('../userscript/storage');
    adapter.completeUserscriptConfigPreparation();
    return {adapter, values, setValue, window};
}
function recordProbe(name: string, evidence: Record<string, unknown>) {
    console.log(`AUDIT48B_PROBE_DONE ${name}`);
    if (process.env.AUDIT48B_EVIDENCE_DIR) {
        writeFileSync(`${process.env.AUDIT48B_EVIDENCE_DIR}/${process.env.AUDIT48B_RUN ?? 'current'}-${name}.json`, JSON.stringify(evidence, null, 2));
    }
}
afterEach(async () => {
    for (const dispose of fixtureDisposers.splice(0)) dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    runtimePort.storage = null;
    legacyRuntime.values.clear(); legacyRuntime.unavailableSession = false;
    for (const db of (Reflect.get(Dexie, 'connections') as readonly Dexie[]).filter(db => db.name === 'FluentReadConfiguration')) db.close();
    await Dexie.delete('FluentReadConfiguration');
    vi.resetModules();
    for (const db of databases.splice(0)) {db.close(); await db.delete();}
});

describe('implementation audit 48 B: controlled public storage and backup flows', () => {
    it('a late failed session decrypt cannot delete a newly committed ciphertext at the same timestamp', async () => {
        const db = database();
        let material = 'old-fixture-session';
        const writer = new EncryptedConfigRepository({database: db, now: () => 1, getSessionKeyMaterial: async () => material});
        await writer.set('session:credentials', {token: 'old-fixture'});
        material = 'new-fixture-session';
        const started = deferred<void>();
        const resume = deferred<void>();
        const reader = new EncryptedConfigRepository({database: db, getSessionKeyMaterial: async () => material, decrypt: async (value, keyMaterial, aad) => {
            started.resolve();
            await resume.promise;
            return decryptConfigValue(value, undefined, keyMaterial, aad);
        }});
        const pending = reader.get('session:credentials');
        await started.promise;
        await writer.set('session:credentials', {token: 'new-fixture'});
        resume.resolve();
        await expect(pending).resolves.toBeNull();
        await expect(writer.get('session:credentials')).resolves.toEqual({token: 'new-fixture'});
    });

    it('failed authentication still removes the same stale session ciphertext', async () => {
        const db = database();
        const old = new EncryptedConfigRepository({database: db, getSessionKeyMaterial: async () => 'old-session'});
        await old.set('session:credentials', {token: 'expired-fixture'});
        const current = new EncryptedConfigRepository({database: db, getSessionKeyMaterial: async () => 'new-session'});
        await expect(current.get('session:credentials')).resolves.toBeNull();
        expect(await current.has('session:credentials')).toBe(false);
    });

    it('unserializable root values are rejected before replacing a readable persisted config', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        for (const value of [undefined, () => undefined, Symbol('fixture')]) {
            await expect(repository.set('local:config', value)).rejects.toThrow('可序列化 JSON');
            await expect(repository.get('local:config')).resolves.toEqual(storedConfig);
        }
        await repository.set('local:nullable', null);
        await expect(repository.get('local:nullable')).resolves.toBeNull();
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(repository.set('local:config', circular)).rejects.toThrow();
        await expect(repository.get('local:config')).resolves.toEqual(storedConfig);
    });

    it('background watcher failures do not reject committed batch writes or skip the remaining keys', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', {version: 1});
        const port = background(repository);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const next = vi.fn();
        port.watch('local:config', () => {throw new Error('fixture watcher');});
        const stop = port.watch('local:config', next);
        const history = vi.fn();
        port.watch('local:configHistory', history);
        await expect(port.setItems!(new Map<string, unknown>([['local:config', {version: 2}], ['local:configHistory', {version: 2}]]))).resolves.toBeUndefined();
        expect(next).toHaveBeenLastCalledWith({version: 2}, {version: 1});
        expect(history).toHaveBeenCalledWith({version: 2}, null);
        await expect(port.removeItem('local:config')).resolves.toBeUndefined();
        expect(next).toHaveBeenLastCalledWith(null, {version: 2});
        stop();
        await port.setItem('local:config', {version: 3});
        expect(next).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalled();
        await expect(repository.get('local:config')).resolves.toEqual({version: 3});
    });

    it('a remote watcher exception cannot turn a successful latest read into a rejected read', async () => {
        let onMessage!: (message: unknown) => void;
        const changeRead = deferred<unknown>();
        const explicitRead = deferred<unknown>();
        const send = vi.fn().mockResolvedValueOnce({success: true, value: 1}).mockImplementationOnce(() => changeRead.promise).mockImplementationOnce(() => explicitRead.promise);
        const port = createRemoteConfigStorage({sendMessage: send, onMessage: {addListener: callback => {onMessage = callback;}}});
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await port.getItem('local:config')).toBe(1);
        port.watch('local:config', () => {throw new Error('fixture watcher');});
        const next = vi.fn();
        const stop = port.watch('local:config', next);
        onMessage({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        const read = port.getItem('local:config');
        explicitRead.resolve({success: true, value: 3});
        try {await expect(read).resolves.toBe(3);}
        finally {changeRead.resolve({success: true, value: 2});}
        await Promise.resolve();
        expect(next).toHaveBeenCalledWith(3, 1);
        expect(next).toHaveBeenCalledTimes(1);
        stop();
    });

    it('backup hydration retains a newer external storage event while the initial read is delayed', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        await repository.set('local:configAutoBackups', backups(1, 'ja'));
        const port = background(repository);
        const started = deferred<void>();
        const initial = deferred<unknown>();
        const delayed: ConfigStoragePort = {...port, async getItem<T>(key: string) {
            if (key !== 'local:configAutoBackups') return port.getItem<T>(key);
            const value = await port.getItem<T>(key);
            started.resolve();
            await initial.promise;
            return value;
        }};
        const loading = loadBackupStore(delayed);
        await started.promise;
        await port.setItem('local:configAutoBackups', backups(2, 'fr'));
        initial.resolve(undefined);
        const store = await loading;
        await store.configAutoBackupsReady;
        expect(store.getConfigAutoBackupsSnapshot().entries[0]).toMatchObject({version: 2, config: {to: 'fr'}});
        const result = await store.captureConfigAutoBackup({config: {...storedConfig, to: 'de'}, savedAt: 'capture'});
        expect(result.entries.map(entry => entry.version)).toEqual([2, 3]);
        await expect(repository.get('local:configAutoBackups')).resolves.toMatchObject({nextVersion: 4});
    });

    it('background baseline initialization cannot overwrite a newer backup after its write has started', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const port = background(repository);
        const started = deferred<void>();
        const resume = deferred<void>();
        const delayed: ConfigStoragePort = {...port,
            async setItem<T>(key: string, value: T) {
                if (key === 'local:configAutoBackups') {started.resolve(); await resume.promise;}
                return port.setItem(key, value);
            },
            async setItemIfUnchanged<T>(key: string, expected: unknown, value: T) {
                started.resolve(); await resume.promise;
                return port.setItemIfUnchanged!(key, expected, value);
            },
        };
        const loading = loadBackupStore(delayed);
        await started.promise;
        // Independent public port, shared actual IndexedDB: another writer wins first.
        const other = background(new EncryptedConfigRepository({database: repository.database}));
        await other.setItem('local:configAutoBackups', backups(5, 'fr'));
        resume.resolve();
        const store = await loading;
        await store.configAutoBackupsReady;
        expect(store.getConfigAutoBackupsSnapshot().entries[0]).toMatchObject({version: 5, config: {to: 'fr'}});
        await expect(repository.get('local:configAutoBackups')).resolves.toMatchObject({entries: [{version: 5, config: {to: 'fr'}}]});
        const captured = await store.captureConfigAutoBackup({savedAt: 'next'});
        expect(captured.entries.map(entry => entry.version)).toEqual([5, 6]);
    });

    it('legacy backup projection migration cannot overwrite a newer backup during its write', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const legacy = backups(1, 'ja');
        Object.assign(legacy.entries[0].config, {token: {openai: 'legacy-fixture-secret'}, count: 20});
        await repository.set('local:configAutoBackups', legacy);
        const port = background(repository);
        const started = deferred<void>();
        const resume = deferred<void>();
        const delayed: ConfigStoragePort = {...port,
            async setItem<T>(key: string, value: T) {
                if (key === 'local:configAutoBackups') {started.resolve(); await resume.promise;}
                return port.setItem(key, value);
            },
            async setItemIfUnchanged<T>(key: string, expected: unknown, value: T) {
                started.resolve(); await resume.promise;
                return port.setItemIfUnchanged!(key, expected, value);
            },
        };
        const loading = loadBackupStore(delayed);
        await started.promise;
        const other = background(new EncryptedConfigRepository({database: repository.database}));
        await other.setItem('local:configAutoBackups', backups(5, 'fr'));
        resume.resolve();
        const store = await loading;
        await store.configAutoBackupsReady;
        expect(store.getConfigAutoBackupsSnapshot().entries[0]).toMatchObject({version: 5, config: {to: 'fr'}});
        await expect(repository.get('local:configAutoBackups')).resolves.toEqual(backups(5, 'fr'));
    });

    it('background conditional commit rechecks the ciphertext after delayed real encryption', async () => {
        const db = database();
        let delayEncryption = false;
        const started = deferred<void>();
        const resume = deferred<void>();
        const repository = new EncryptedConfigRepository({database: db, now: () => 1, encrypt: async (value, material, aad) => {
            if (delayEncryption) {started.resolve(); await resume.promise;}
            return encryptConfigValue(value, undefined, material, aad);
        }});
        await repository.set('local:config', storedConfig);
        await repository.set('local:configAutoBackups', backups(1, 'ja'));
        const port = background(repository);
        const listener = vi.fn();
        port.watch('local:configAutoBackups', listener);
        delayEncryption = true;
        // This is a new optional production API; the old-module missing-API failure is classified separately.
        const saving = port.setItemIfUnchanged!('local:configAutoBackups', backups(1, 'ja'), backups(2, 'de'));
        await started.promise;
        const other = new EncryptedConfigRepository({database: db, now: () => 1});
        await other.set('local:configAutoBackups', backups(9, 'fr'));
        resume.resolve();
        expect(await saving).toBe(false);
        expect(listener).not.toHaveBeenCalled();
        await expect(repository.get('local:configAutoBackups')).resolves.toEqual(backups(9, 'fr'));
        delayEncryption = false;
        expect(await port.setItemIfUnchanged!('local:configAutoBackups', backups(1, 'ja'), backups(2, 'de'))).toBe(false);
        expect(await port.setItemIfUnchanged!('local:configAutoBackups', backups(9, 'fr'), backups(10, 'de'))).toBe(true);
        expect(listener).toHaveBeenCalledWith(backups(10, 'de'), backups(9, 'fr'));
        expect(await port.setItemIfUnchanged!('local:new-backup', null, backups(1, 'ja'))).toBe(true);
    });

    it('a get/set-only adapter avoids a destructive late automatic baseline write', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const port = background(repository);
        const started = deferred<void>();
        const resume = deferred<void>();
        const basic: ConfigStoragePort = {...port, setItemIfUnchanged: undefined,
            async setItem<T>(key: string, value: T) {
                if (key === 'local:configAutoBackups') {started.resolve(); await resume.promise;}
                await port.setItem(key, value);
            },
        };
        const store = await loadBackupStore(basic);
        // Baseline dispatches a destructive write; current initialization settles without it.
        // Both execute exactly the same public-entry interleaving, without inspecting source.
        await Promise.race([started.promise, store.configAutoBackupsReady]);
        await port.setItem('local:configAutoBackups', backups(5, 'fr'));
        resume.resolve();
        await store.configAutoBackupsReady;
        const disk = await repository.get<{entries: Array<{version: number}>}>('local:configAutoBackups');
        recordProbe('basic-adapter-boundary', {hasAtomicPort: false, concurrentVersion: 5, finalDiskVersion: disk?.entries[0]?.version, finalMemoryVersion: store.getConfigAutoBackupsSnapshot().entries[0]?.version});
        expect(disk?.entries[0]?.version).toBe(5);
        expect(store.getConfigAutoBackupsSnapshot().entries[0]?.version).toBe(5);
        const captured = await store.captureConfigAutoBackup({savedAt: 'explicit'});
        expect(captured.entries.map(entry => entry.version)).toEqual([5, 6]);
        await expect(repository.get('local:configAutoBackups')).resolves.toMatchObject({nextVersion: 7});
    });

    it.each(['empty baseline', 'legacy projection'])('the actual userscript adapter defers %s writes and preserves a concurrent durable checkpoint', async (kind) => {
        const initial = kind === 'legacy projection' ? backups(7, 'ja') : undefined;
        if (initial) Object.assign(initial.entries[0].config, {token: {openai: 'controlled-legacy-secret'}, count: 7});
        const fixture = await userscriptFixture(initial);
        const started = deferred<void>();
        const resume = deferred<void>();
        let delay = true;
        fixture.setValue.mockImplementation(async (key, value) => {
            if (key === 'local:configAutoBackups' && delay) {started.resolve(); await resume.promise;}
            fixture.values.set(key, value);
        });
        const store = await loadBackupStore(fixture.adapter.configStorage);
        await Promise.race([started.promise, store.configAutoBackupsReady]);
        // An independent GM context commits while baseline's automatic write is pending.
        delay = false;
        await fixture.setValue('local:configAutoBackups', JSON.stringify(backups(15, 'fr')));
        resume.resolve();
        await store.configAutoBackupsReady;
        const disk = JSON.parse(fixture.values.get('local:configAutoBackups')!);
        const memory = store.getConfigAutoBackupsSnapshot();
        recordProbe(`userscript-${kind === 'empty baseline' ? 'baseline' : 'projection'}`, {
            hasAtomicPort: 'setItemIfUnchanged' in fixture.adapter.configStorage,
            concurrentVersion: 15, finalDiskVersion: disk.entries[0].version,
            memoryVersionBeforeFocus: memory.entries[0].version,
            backupSetCallsBeforeExplicitCapture: fixture.setValue.mock.calls.filter(([key]) => key === 'local:configAutoBackups').length,
        });
        expect(disk.entries[0].version).toBe(15);
        expect(memory.entries[0].version).toBe(initial ? 7 : 1);
        expect(JSON.stringify(memory)).not.toContain('controlled-legacy-secret');
        expect(memory.entries[0].config).not.toHaveProperty('count');
        expect(fixture.setValue.mock.calls.filter(([key]) => key === 'local:configAutoBackups')).toHaveLength(1);
        const observed = deferred<void>();
        const stop = store.subscribeConfigAutoBackups(state => {if (state.entries[0].version === 15) observed.resolve();});
        fixture.window.dispatchEvent(new Event('focus'));
        await observed.promise;
        stop();
        const captured = await store.captureConfigAutoBackup({savedAt: 'explicit-capture'});
        expect(captured.entries.map(entry => entry.version)).toEqual([15, 16]);
        expect(JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!)).toEqual(captured);
        expect(fixture.setValue.mock.calls.filter(([key]) => key === 'local:configAutoBackups')).toHaveLength(2);
    });

    it('an actual userscript delayed write echo cannot replace a newer observed backup in memory', async () => {
        const fixture = await userscriptFixture(backups(1, 'ja'));
        const store = await loadBackupStore(fixture.adapter.configStorage);
        await store.configAutoBackupsReady;
        const started = deferred<void>();
        const resume = deferred<void>();
        let delay = true;
        fixture.setValue.mockImplementation(async (key, value) => {
            // GM commits first, but completion (and adapter's local watch echo) is delayed.
            fixture.values.set(key, value);
            if (key === 'local:configAutoBackups' && delay) {started.resolve(); await resume.promise;}
        });
        const capturing = store.captureConfigAutoBackup({config: {...storedConfig, to: 'de'}, savedAt: 'pending'});
        await started.promise;
        delay = false;
        await fixture.setValue(store.CONFIG_AUTO_BACKUP_STORAGE_KEY, JSON.stringify(backups(5, 'fr')));
        const observed = deferred<void>();
        const listener = vi.fn(state => {if (state.entries[0].version === 5) observed.resolve();});
        const stop = store.subscribeConfigAutoBackups(listener);
        fixture.window.dispatchEvent(new Event('focus'));
        await observed.promise;
        const countBeforeEcho = listener.mock.calls.length;
        resume.resolve();
        const result = await capturing;
        recordProbe('userscript-late-echo', {concurrentVersion: 5,
            finalDiskVersion: JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!).entries[0].version,
            finalMemoryVersion: result.entries[0].version,
            notificationsBeforeEcho: countBeforeEcho, notificationsAfterEcho: listener.mock.calls.length});
        expect(result.entries[0]).toMatchObject({version: 5, config: {to: 'fr'}});
        expect(JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!).entries[0].version).toBe(5);
        expect(listener).toHaveBeenCalledTimes(countBeforeEcho);
        stop();
        const next = await store.captureConfigAutoBackup({savedAt: 'next'});
        expect(next.entries.map(entry => entry.version)).toEqual([5, 6]);
        expect(JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!)).toEqual(next);
    });

    it('a failed explicit userscript capture releases its pending echo state and the next capture persists', async () => {
        const fixture = await userscriptFixture(backups(1, 'ja'));
        const store = await loadBackupStore(fixture.adapter.configStorage);
        await store.configAutoBackupsReady;
        const started = deferred<void>();
        const fail = deferred<void>();
        fixture.setValue.mockImplementationOnce(async (key, value) => {
            expect(key).toBe(store.CONFIG_AUTO_BACKUP_STORAGE_KEY);
            expect(JSON.parse(value).entries.map((entry: {version: number}) => entry.version)).toEqual([1, 2]);
            started.resolve();
            await fail.promise;
        });
        const failed = store.captureConfigAutoBackup({savedAt: 'failed'});
        const rejected = expect(failed).rejects.toThrow('controlled GM set failure');
        await started.promise;
        fail.reject(new Error('controlled GM set failure'));
        await rejected;
        expect(store.getConfigAutoBackupsSnapshot().entries.map(entry => entry.version)).toEqual([1]);
        expect(JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!).entries.map((entry: {version: number}) => entry.version)).toEqual([1]);
        const captured = await store.captureConfigAutoBackup({savedAt: 'recovered'});
        expect(captured.entries.map(entry => entry.version)).toEqual([1, 2]);
        expect(captured.entries.at(-1)?.savedAt).toBe('recovered');
        expect(JSON.parse(fixture.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)!)).toEqual(captured);
    });

    it.each([false, true])('an initial backup read failure retains a usable state with newer watch=%s', async (newerWatch) => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const port = background(repository);
        const started = deferred<void>();
        const fail = deferred<unknown>();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const store = await loadBackupStore({...port, async getItem<T>(key: string) {
            if (key !== 'local:configAutoBackups') return port.getItem<T>(key);
            started.resolve();
            return await fail.promise as T;
        }});
        await started.promise;
        expect(store.getConfigAutoBackupsSnapshot().entries[0].version).toBe(1);
        const notified = vi.fn();
        const stop = store.subscribeConfigAutoBackups(notified);
        expect(notified).not.toHaveBeenCalled();
        await port.setItem(store.CONFIG_AUTO_BACKUP_STORAGE_KEY, {schemaVersion: -1});
        expect(notified).not.toHaveBeenCalled();
        if (newerWatch) {
            await port.setItem(store.CONFIG_AUTO_BACKUP_STORAGE_KEY, backups(5, 'fr'));
            const count = notified.mock.calls.length;
            await port.setItem(store.CONFIG_AUTO_BACKUP_STORAGE_KEY, backups(5, 'fr'));
            expect(notified).toHaveBeenCalledTimes(count);
        }
        fail.reject(new Error('controlled initial backup read failure'));
        await store.configAutoBackupsReady;
        expect(store.getConfigAutoBackupsSnapshot().entries[0].version).toBe(newerWatch ? 5 : 1);
        const captured = await store.captureConfigAutoBackup({savedAt: 'after-error'});
        expect(captured.entries.map(entry => entry.version)).toEqual(newerWatch ? [5, 6] : [1, 2]);
        await expect(repository.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).resolves.toEqual(captured);
        stop();
    });

    it('a rejected projection migration leaves a safe usable snapshot and explicit capture cleans persisted secrets', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const legacy = backups(7, 'ja');
        Object.assign(legacy.entries[0].config, {token: {openai: 'controlled-legacy-secret'}, count: 4});
        await repository.set('local:configAutoBackups', legacy);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = await loadBackupStore({...background(repository), async setItemIfUnchanged() {
            throw new Error('controlled conditional storage failure');
        }});
        await store.configAutoBackupsReady;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('迁移暂未落盘'), expect.any(Error));
        expect(store.getConfigAutoBackupsSnapshot().entries[0].version).toBe(7);
        expect(JSON.stringify(store.getConfigAutoBackupsSnapshot())).not.toContain('controlled-legacy-secret');
        const captured = await store.captureConfigAutoBackup({savedAt: 'after-error'});
        expect(captured.entries.map(entry => entry.version)).toEqual([7, 8]);
        await expect(repository.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).resolves.toEqual(captured);
    });

    it('an atomic initialization conflict with invalid stored data falls back to a usable memory baseline', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const port = background(repository);
        const other = background(new EncryptedConfigRepository({database: repository.database}));
        const store = await loadBackupStore({...port, async setItemIfUnchanged<T>(key: string, expected: unknown, value: T) {
            await other.setItem(key, {schemaVersion: -1});
            return port.setItemIfUnchanged!(key, expected, value);
        }});
        await store.configAutoBackupsReady;
        expect(store.getConfigAutoBackupsSnapshot().entries[0].version).toBe(1);
        await expect(repository.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).resolves.toEqual({schemaVersion: -1});
        const captured = await store.captureConfigAutoBackup({savedAt: 'explicit'});
        expect(captured.entries.map(entry => entry.version)).toEqual([1, 2]);
        await expect(repository.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).resolves.toEqual(captured);
    });

    it('public backup restore errors preserve config and only the supported missing-receiver fallback restores locally', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const store = await loadBackupStore(background(repository));
        await store.configAutoBackupsReady;
        const original = await repository.get('local:config');
        await expect(store.restoreConfigAutoBackup(999)).rejects.toThrow('不存在');
        await expect(store.requestConfigAutoBackupRestore(1, async () => ({success: false}))).rejects.toThrow('自动配置备份恢复失败');
        await expect(store.requestConfigAutoBackupRestore(1, async () => {throw 'controlled transport rejection';})).rejects.toBe('controlled transport rejection');
        await expect(repository.get('local:config')).resolves.toEqual(original);
        const captured = await store.captureConfigAutoBackup({config: {...storedConfig, to: 'ja'}, savedAt: 'restore'});
        const restored = await store.requestConfigAutoBackupRestore(captured.entries.at(-1)!.version);
        expect(restored.backups).toEqual(captured);
        await expect(repository.get('local:config')).resolves.toMatchObject({to: 'ja'});
    });

    it('a backup listener failure does not reject a committed capture or block later subscribers', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const store = await loadBackupStore(background(repository));
        await store.configAutoBackupsReady;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let throwOnUpdate = false;
        const stopBad = store.subscribeConfigAutoBackups(() => {if (throwOnUpdate) throw new Error('fixture subscriber');});
        const next = vi.fn();
        const stopGood = store.subscribeConfigAutoBackups(next);
        throwOnUpdate = true;
        const captured = await store.captureConfigAutoBackup({config: {...storedConfig, to: 'fr'}, savedAt: 'capture'});
        expect(captured.entries.at(-1)).toMatchObject({version: 2, config: {to: 'fr'}});
        expect(next).toHaveBeenCalledTimes(2);
        stopBad(); stopGood();
        await store.captureConfigAutoBackup({savedAt: 'next'});
        expect(next).toHaveBeenCalledTimes(2);
    });

    it('backup subscriber snapshots are isolated from each other and the authoritative state', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const store = await loadBackupStore(background(repository));
        await store.configAutoBackupsReady;
        const stopBad = store.subscribeConfigAutoBackups(snapshot => {snapshot.entries.length = 0;});
        const next = vi.fn();
        const stopGood = store.subscribeConfigAutoBackups(next);
        await store.captureConfigAutoBackup({savedAt: 'capture'});
        expect(next.mock.calls.at(-1)?.[0].entries).toHaveLength(2);
        expect(store.getConfigAutoBackupsSnapshot().entries).toHaveLength(2);
        // Reentrant public reads/subscriptions run synchronously during notification;
        // a capture requested there joins the real capture queue after this write.
        let queued: ReturnType<typeof store.captureConfigAutoBackup> | undefined;
        const nested = vi.fn(snapshot => {snapshot.entries.length = 0;});
        const stopReentrant = store.subscribeConfigAutoBackups(snapshot => {
            if (snapshot.entries.length !== 3 || queued) return;
            expect(store.getConfigAutoBackupsSnapshot().entries).toHaveLength(3);
            const stopNested = store.subscribeConfigAutoBackups(nested);
            stopNested();
            queued = store.captureConfigAutoBackup({savedAt: 'reentrant-capture'});
            snapshot.entries.length = 0;
        });
        const third = await store.captureConfigAutoBackup({savedAt: 'outer-capture'});
        expect(third.entries.map(entry => entry.version)).toEqual([1, 2, 3]);
        expect(nested).toHaveBeenCalledOnce();
        expect(queued).toBeDefined();
        const fourth = await queued!;
        expect(fourth.entries.map(entry => entry.version)).toEqual([1, 2, 3, 4]);
        expect(fourth.entries.at(-1)?.savedAt).toBe('reentrant-capture');
        await expect(repository.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).resolves.toEqual(fourth);
        expect(next.mock.calls.at(-1)?.[0].entries).toHaveLength(4);
        stopReentrant();
        stopBad(); stopGood();
    });

    it('bounded history parsing preserves retained versions and cursor while limiting projection work', () => {
        const entries = Array.from({length: 256}, (_, index) => ({version: index + 1, savedAt: String(index), config: {...storedConfig, to: index % 2 ? 'ja' : 'fr'}}));
        const input = {schemaVersion: 1, entries, cursor: 250, nextVersion: 300};
        const calls = vi.spyOn(schema, 'parseStoredConfig');
        const start = performance.now();
        console.log('AUDIT48B_PROBE_LOADED history-bounded');
        const output = parseConfigHistory(input)!;
        const durationMs = performance.now() - start;
        recordProbe('history-bounded', {inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'), parseStoredConfigCalls: calls.mock.calls.length, durationMs, inputEntries: entries.length});
        expect(output.entries.map(entry => entry.version)).toEqual([247, 248, 249, 250, 251, 252, 253, 254, 255, 256]);
        expect(output).toMatchObject({cursor: 4, nextVersion: 300});
        expect(calls).toHaveBeenCalledTimes(10);
    });

    it('bounded backup parsing preserves the last ten valid entries while limiting projection work', () => {
        const entries = Array.from({length: 256}, (_, index) => ({version: index + 1, savedAt: String(index), config: {...storedConfig, to: 'ja'}}));
        const input = {schemaVersion: 1, entries, nextVersion: 300};
        const calls = vi.spyOn(schema, 'parseStoredConfig');
        const start = performance.now();
        console.log('AUDIT48B_PROBE_LOADED backups-bounded');
        const output = parseConfigAutoBackups(input)!;
        recordProbe('backups-bounded', {inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'), parseStoredConfigCalls: calls.mock.calls.length, durationMs: performance.now() - start, inputEntries: entries.length});
        expect(output.entries.map(entry => entry.version)).toEqual([247, 248, 249, 250, 251, 252, 253, 254, 255, 256]);
        expect(output.nextVersion).toBe(300);
        expect(calls).toHaveBeenCalledTimes(10);
    });

    it('retention scans past invalid tails and keeps cursor mapping without restoring secrets', () => {
        const valid = Array.from({length: 15}, (_, index) => ({version: index + 1, savedAt: 'saved', config: {...storedConfig, token: {openai: 'fixture-secret'}}}));
        const entries = [...valid, null, {version: 16, savedAt: 'bad', config: {on: true}}, {version: -1, savedAt: 'bad', config: storedConfig}];
        const history = parseConfigHistory({entries, cursor: 10, nextVersion: 1})!;
        const backup = parseConfigAutoBackups({entries, nextVersion: 1})!;
        expect(history).toMatchObject({cursor: 5, nextVersion: 16});
        expect(history.entries.map(entry => entry.version)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        expect(backup.entries).toEqual(history.entries);
        expect(JSON.stringify(history)).not.toContain('fixture-secret');
        expect(parseConfigHistory({entries: [null]})).toBeNull();
        expect(parseConfigAutoBackups({entries: [null]})).toBeNull();
    });

    it('bounded all-invalid history and backup input terminates without inventing checkpoints', () => {
        const input = {entries: Array.from({length: 4096}, (_, index) => ({version: index + 1, savedAt: 'invalid', config: {on: true}})), cursor: 4095};
        const calls = vi.spyOn(schema, 'parseStoredConfig');
        console.log('AUDIT48B_PROBE_LOADED invalid-bounded');
        const start = performance.now();
        const output = [parseConfigHistory(input), parseConfigAutoBackups(input)];
        recordProbe('invalid-bounded', {inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'), parseStoredConfigCalls: calls.mock.calls.length, durationMs: performance.now() - start, inputEntries: input.entries.length});
        expect(output).toEqual([null, null]);
        expect(calls).toHaveBeenCalledTimes(8192);
    });

    it('bounded AES-GCM roundtrip retains exact ciphertext with a controlled IV and fewer encoder calls', async () => {
        console.log('AUDIT48B_PROBE_LOADED encryption-bounded');
        const input = {text: '中A'.repeat(65_536)};
        const runtime: ConfigCryptoRuntime = {crypto: {subtle: crypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(7)} as Crypto, encoder: new TextEncoder(), decoder: new TextDecoder()};
        const encoding = vi.spyOn(String, 'fromCharCode');
        const start = performance.now();
        const encrypted = await encryptConfigValue(input, runtime, 'fixture-encryption-key', 'fixture-aad');
        const calls = encoding.mock.calls.length;
        encoding.mockRestore();
        const decrypted = await decryptConfigValue(encrypted, runtime, 'fixture-encryption-key', 'fixture-aad');
        recordProbe('encryption-bounded', {inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), outputSha256: createHash('sha256').update(JSON.stringify(encrypted)).digest('hex'), plaintextSha256: createHash('sha256').update(JSON.stringify(decrypted)).digest('hex'), fromCharCodeCalls: calls, durationMs: performance.now() - start, utf8Bytes: new TextEncoder().encode(JSON.stringify(input)).length});
        expect(decrypted).toEqual(input);
        expect(encrypted.iv).toBe('BwcHBwcHBwcHBwcH');
        expect(calls).toBeLessThanOrEqual(12);
    });

    it('MV3 runtime uses the encrypted public storage owner and restricts legacy access', async () => {
        const local = {setAccessLevel: vi.fn(async () => undefined)};
        const session = {get: vi.fn(), set: vi.fn(), setAccessLevel: vi.fn(async () => {throw new Error('controlled access restriction failure');})};
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('location', {protocol: 'chrome-extension:'});
        vi.stubGlobal('document', undefined);
        vi.stubGlobal('browser', {storage: {local, session}, runtime: {}});
        legacyRuntime.values.set('local:config', storedConfig);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        expect(runtime.configStorage.writeOwner).toBe(true);
        await expect(runtime.configStorage.getItem('local:config')).resolves.toEqual(storedConfig);
        expect(legacyRuntime.values.has('local:config')).toBe(false);
        expect(local.setAccessLevel).toHaveBeenCalledWith({accessLevel: 'TRUSTED_CONTEXTS'});
        expect(session.setAccessLevel).toHaveBeenCalledOnce();
        await runtime.configStorage.setItem('session:credentials', {token: 'controlled-runtime-fixture'});
        await expect(runtime.configStorage.getItem('session:credentials')).resolves.toEqual({token: 'controlled-runtime-fixture'});
        await runtime.configStorage.removeItem('session:credentials');
        await expect(runtime.configStorage.getItem('session:credentials')).resolves.toBeNull();
    });

    it('a synchronous access restriction failure does not prevent the other area or config hydration', async () => {
        const local = {setAccessLevel: vi.fn(() => { throw new Error('controlled synchronous restriction failure'); })};
        const session = {get: vi.fn(), set: vi.fn(), setAccessLevel: vi.fn(async () => undefined)};
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('location', {protocol: 'chrome-extension:'});
        vi.stubGlobal('document', undefined);
        vi.stubGlobal('browser', {storage: {local, session}, runtime: {}});
        legacyRuntime.values.set('local:config', storedConfig);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        expect(local.setAccessLevel).toHaveBeenCalledWith({accessLevel: 'TRUSTED_CONTEXTS'});
        expect(session.setAccessLevel).toHaveBeenCalledWith({accessLevel: 'TRUSTED_CONTEXTS'});
        expect(warn).toHaveBeenCalled();
        await expect(runtime.configStorage.getItem('local:config')).resolves.toEqual(storedConfig);
        expect(legacyRuntime.values.has('local:config')).toBe(false);
    });

    it('a throwing local area getter still attempts session restriction and retains config access', async () => {
        const session = {get: vi.fn(), set: vi.fn(), setAccessLevel: vi.fn(async () => undefined)};
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('location', {protocol: 'chrome-extension:'});
        vi.stubGlobal('document', undefined);
        vi.stubGlobal('browser', {storage: {get local() {throw new Error('controlled local getter failure');}, session}, runtime: {}});
        legacyRuntime.values.set('local:config', storedConfig);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        expect(session.setAccessLevel).toHaveBeenCalledWith({accessLevel: 'TRUSTED_CONTEXTS'});
        await expect(runtime.configStorage.getItem('local:config')).resolves.toEqual(storedConfig);
    });

    it('Firefox background runtime retains its explicit memory-session fallback without native session storage', async () => {
        const window = {};
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('location', {protocol: 'moz-extension:'});
        vi.stubGlobal('document', {}); vi.stubGlobal('window', window);
        vi.stubGlobal('browser', {extension: {getBackgroundPage: () => window}, storage: {local: {}}, runtime: {}});
        legacyRuntime.unavailableSession = true;
        legacyRuntime.values.set('local:config', storedConfig);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        await runtime.configStorage.setItem('session:credentials', {token: 'controlled-firefox-fixture'});
        await expect(runtime.configStorage.getItem('session:credentials')).resolves.toEqual({token: 'controlled-firefox-fixture'});
        await expect(runtime.configStorage.getItem('local:config')).resolves.toEqual(storedConfig);
        expect(legacyRuntime.values.has('session:configIndexedDbKeyMaterial')).toBe(false);
    });

    it('a throwing native session API getter retains recoverable ciphertext instead of choosing a new fallback key', async () => {
        const window = {};
        const session = {get get() {throw new Error('controlled native session API getter');}, set: async () => undefined};
        vi.stubGlobal('location', {protocol: 'moz-extension:'});
        vi.stubGlobal('document', {}); vi.stubGlobal('window', window);
        vi.stubGlobal('browser', {extension: {getBackgroundPage: () => window}, storage: {local: {}, session}, runtime: {}});
        legacyRuntime.values.set('local:config', storedConfig);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        await runtime.configStorage.setItem('session:credentials', {token: 'controlled-recoverable-session'});
        legacyRuntime.unavailableSession = true;
        // A fresh runtime has no successful cached material; the API getter error must
        // keep memory fallback disabled even on Firefox.
        vi.resetModules();
        const reloaded = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        await expect(reloaded.configStorage.getItem('session:credentials')).rejects.toThrow('controlled unavailable session');
        legacyRuntime.unavailableSession = false;
        await expect(reloaded.configStorage.getItem('session:credentials')).resolves.toEqual({token: 'controlled-recoverable-session'});
        const db = new FluentReadConfigDatabase();
        expect(await db.records.get('session:credentials')).toBeDefined();
        db.close();
    });

    it('the dedicated remote runtime only reads via controlled messages and rejects writes', async () => {
        const handlers: Array<(message: unknown) => void> = [];
        let value = {version: 1};
        const sendMessage = vi.fn(async () => ({success: true, value: structuredClone(value)}));
        vi.stubGlobal('browser', {runtime: {sendMessage, onMessage: {addListener: (callback: (message: unknown) => void) => handlers.push(callback)}}});
        vi.resetModules();
        const runtime = await import('@/src/platform/storage/remoteConfigStorageRuntime');
        await expect(runtime.configStorage.getItem('local:config')).resolves.toEqual({version: 1});
        vi.stubGlobal('location', {protocol: 'https:'});
        const generic = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        await expect(generic.configStorage.getItem('local:config')).resolves.toEqual({version: 1});
        const updated = deferred<unknown>();
        const stop = runtime.configStorage.watch('local:config', updated.resolve);
        value = {version: 2};
        handlers[0]({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        await expect(updated.promise).resolves.toEqual({version: 2});
        stop();
        await expect(runtime.configStorage.setItem('local:config', value)).rejects.toThrow('后台配置协议');
        expect(sendMessage).toHaveBeenCalledTimes(3);
    });

    it('a runtime without a browser reports unavailable storage through every public operation', async () => {
        vi.stubGlobal('location', {protocol: 'https:'});
        vi.stubGlobal('browser', undefined);
        vi.resetModules();
        const runtime = await vi.importActual<typeof import('@/src/platform/storage/configStorageRuntime')>('@/src/platform/storage/configStorageRuntime');
        await expect(runtime.configStorage.getItem('local:config')).rejects.toThrow('运行时不可用');
        await expect(runtime.configStorage.setItem('local:config', storedConfig)).rejects.toThrow('运行时不可用');
        await expect(runtime.configStorage.removeItem('local:config')).rejects.toThrow('运行时不可用');
        const stop = runtime.configStorage.watch('local:config', () => {throw new Error('unexpected notification');});
        stop();
    });

    it('the config public barrel captures and restores a backup through the actual config store and IndexedDB', async () => {
        const repository = new EncryptedConfigRepository({database: database()});
        await repository.set('local:config', storedConfig);
        const store = await loadBackupStore(background(repository));
        await store.configAutoBackupsReady;
        const service = await import('@/src/services/config');
        const captured = await service.captureConfigAutoBackup({config: {...storedConfig, to: 'fr'}, savedAt: 'barrel-capture'});
        await service.restoreConfigAutoBackup(captured.entries.at(-1)!.version);
        expect(service.config.to).toBe('fr');
        await expect(repository.get('local:config')).resolves.toMatchObject({to: 'fr'});
        expect(service.getConfigHistorySnapshot().entries.at(-1)?.config.to).toBe('fr');
    });

    it('cloud deletion still rejects a changed target and retains the sync baseline', async () => {
        let state: DriveSyncState | null = null;
        let remote = {file: {id: 'fixture-file', version: '1', modifiedTime: '', etag: '"1"'}, content: 'opaque-fixture'};
        const remove = vi.fn();
        const disconnect = vi.fn(async () => undefined);
        const session = {account: {id: 'fixture-account', email: 'fixture@example.test'}, request: async <T>(operation: (credential: string) => Promise<T>) => operation('controlled-credential')};
        const ports: DriveSyncPorts = {auth: {availability: () => ({available: true, reason: ''}), open: async () => session, disconnect}, api: {read: async () => structuredClone(remote), write: async () => {throw new Error('unexpected write');}, remove}, snapshot: async () => storedConfig, apply: async () => {throw new Error('unexpected apply');}, readState: async () => structuredClone(state), writeState: async value => {state = structuredClone(value);}, now: () => 100};
        const sync = createGoogleDriveSync(ports);
        const preview = await sync.prepareDelete(1, 'fixture-client');
        remote = {...remote, content: 'changed', file: {...remote.file, version: '2', etag: '"2"'}};
        await expect(sync.commitDelete(preview.id, 1, 'fixture-client')).rejects.toThrow('云端备份已变化');
        expect(remove).not.toHaveBeenCalled();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(state).toMatchObject({connected: false, baseline: ''});
        expect(state).not.toHaveProperty('prepared');
    });
});
