import {describe, expect, it, vi} from 'vitest';
import {
    CLOUD_AUTO_SYNC_ALARM,
    CLOUD_AUTO_SYNC_STATE_KEY,
    createCloudAutoSync,
    isValidAutoSyncInterval,
    type CloudAutoSyncAlarmApi,
    type CloudAutoSyncPorts,
} from '@/src/services/config/cloudAutoSync';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import type {DriveSyncPreview} from '@/src/services/config/remoteConfigSync';
import {createWebDavBackupHandler, WEBDAV_BACKUP_MESSAGE_TYPE} from '@/src/app/background/handlers/webDavBackup';
import type {createWebDavBackup} from '@/src/services/config/webDavBackup';
import {createCloudPassphraseStore} from '@/src/services/config/cloudPassphraseStore';
import {PersonalCorrectionError} from '@/src/core/personal-corrections/public';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import {VocabularyBookError} from '@/src/features/vocabulary/repository';

function previewFixture(patch: Partial<DriveSyncPreview> = {}): DriveSyncPreview {
    return {
        id: 'auto-preview-1',
        account: {id: 'webdav:rev-1', email: 'u · dav.example.test'},
        hasRemote: true,
        includeSensitive: false,
        remoteIncludesSensitive: false,
        hasBaseline: true,
        changes: [],
        expiresAt: 100_000,
        ...patch,
    };
}

function autoSyncFixture() {
    const store = new Map<string, unknown>();
    const listeners: Array<(alarm: {name: string}) => void> = [];
    let clock = 10_000;
    let online = true;
    let available = true;
    const alarms: CloudAutoSyncAlarmApi & {fire: (name: string) => void; active: Map<string, {delayInMinutes: number; periodInMinutes: number}>} = {
        active: new Map(),
        onAlarm: {addListener: listener => {listeners.push(listener);}},
        get: vi.fn(async name => {
            const info = alarms.active.get(name);
            return info ? {name, periodInMinutes: info.periodInMinutes} : undefined;
        }),
        create: vi.fn(async (name, info) => {alarms.active.set(name, info);}),
        clear: vi.fn(async name => alarms.active.delete(name)),
        fire: name => listeners.forEach(listener => listener({name})),
    };
    const ports: CloudAutoSyncPorts = {
        storage: {
            async getItem<T>(key: string): Promise<T | null> {
                return (store.has(key) ? structuredClone(store.get(key)) : null) as T | null;
            },
            async setItem(key: string, value: unknown): Promise<void> {
                store.set(key, structuredClone(value));
            },
        },
        alarms,
        isAvailable: vi.fn(async () => available),
        resolvePassphrase: vi.fn(async () => ({
            keyMode: 'app' as const,
            passphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
            legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
        })),
        prepare: vi.fn(async () => previewFixture()),
        commit: vi.fn(async () => ({available: true, reason: '', account: {id: 'webdav:rev-1', email: 'u'}, lastSyncedAt: clock})),
        cancel: vi.fn(async () => undefined),
        isOnline: () => online,
        now: () => clock,
    };
    return {
        autoSync: createCloudAutoSync(ports),
        ports,
        alarms,
        store,
        setClock: (v: number) => {clock = v;},
        setOnline: (v: boolean) => {online = v;},
        setAvailable: (v: boolean) => {available = v;},
    };
}

describe('Optional Scheduled Auto-Sync', () => {
    it('defaults to OFF, validates configuration patches, and reconciles MV3 alarms cleanly', async () => {
        expect(isValidAutoSyncInterval(30)).toBe(true);
        expect(isValidAutoSyncInterval(1440)).toBe(true);
        expect(isValidAutoSyncInterval(15)).toBe(false);

        const f = autoSyncFixture();
        expect(await f.autoSync.status()).toMatchObject({enabled: false, intervalMinutes: 60, state: 'idle', includeSensitive: false});
        expect(await f.autoSync.runScheduled()).toMatchObject({enabled: false, state: 'idle'});
        expect(f.ports.prepare).not.toHaveBeenCalled();

        // Corrupt persisted state falls back safely
        f.store.set(CLOUD_AUTO_SYNC_STATE_KEY, {enabled: 'yes', intervalMinutes: 999, state: 'weird', learningScope: 'bad'});
        expect(await f.autoSync.status()).toMatchObject({enabled: false, intervalMinutes: 60, state: 'idle'});

        // Invalid config patches rejected
        await expect(f.autoSync.configure(null as never)).rejects.toThrow(CloudSyncError);
        await expect(f.autoSync.configure({enabled: 'true' as unknown as boolean})).rejects.toThrow(CloudSyncError);
        await expect(f.autoSync.configure({intervalMinutes: 5 as 30})).rejects.toThrow(CloudSyncError);
        await expect(f.autoSync.configure({includeSensitive: 1 as unknown as boolean})).rejects.toThrow(CloudSyncError);

        // Enable -> creates alarm; install keeps existing alarm; disable -> clears alarm
        const enabled = await f.autoSync.configure({enabled: true, intervalMinutes: 30, includeSensitive: false, learningScope: {includeVocabulary: true}});
        expect(enabled).toMatchObject({enabled: true, intervalMinutes: 30, learningScope: {includeVocabulary: true}});
        expect(f.alarms.create).toHaveBeenCalledWith(CLOUD_AUTO_SYNC_ALARM, {delayInMinutes: 30, periodInMinutes: 30});

        await f.autoSync.install();
        expect(f.alarms.create).toHaveBeenCalledTimes(1);

        // Alarm firing triggers scheduled run; unrelated alarms ignored; alarm error is swallowed cleanly
        f.alarms.fire('other-alarm');
        f.alarms.fire(CLOUD_AUTO_SYNC_ALARM);
        await vi.waitFor(() => expect(f.ports.commit).toHaveBeenCalledOnce());
        vi.mocked(f.ports.resolvePassphrase).mockRejectedValueOnce(new Error('alarm unexpected failure'));
        f.alarms.fire(CLOUD_AUTO_SYNC_ALARM);
        await vi.waitFor(() => expect(f.ports.resolvePassphrase).toHaveBeenCalledTimes(2));

        // Partial interval patch preserves enabled state
        expect(await f.autoSync.configure({intervalMinutes: 1440})).toMatchObject({enabled: true, intervalMinutes: 1440});

        // Disabling clears alarm and resets state
        const disabled = await f.autoSync.configure({enabled: false});
        expect(disabled).toMatchObject({enabled: false, state: 'idle', consecutiveFailures: 0, nextRetryAt: null});
        expect(f.alarms.clear).toHaveBeenCalledWith(CLOUD_AUTO_SYNC_ALARM);

        // Startup install clears stale alarm when disabled, recreates missing alarm, and reconciles mismatched interval
        await f.autoSync.install();
        expect(f.alarms.clear).toHaveBeenCalledTimes(2);
        await f.autoSync.configure({enabled: true, intervalMinutes: 360});
        f.alarms.active.clear();
        await f.autoSync.install();
        expect(f.alarms.create).toHaveBeenLastCalledWith(CLOUD_AUTO_SYNC_ALARM, {delayInMinutes: 360, periodInMinutes: 360});
        f.alarms.active.set(CLOUD_AUTO_SYNC_ALARM, {delayInMinutes: 30, periodInMinutes: 30});
        await f.autoSync.install();
        expect(f.alarms.create).toHaveBeenLastCalledWith(CLOUD_AUTO_SYNC_ALARM, {delayInMinutes: 360, periodInMinutes: 360});
    });

    it('performs safe three-way merge without overwriting on conflict, missing baseline, or read-only local edits', async () => {
        const f = autoSyncFixture();
        await f.autoSync.configure({enabled: true, intervalMinutes: 60});

        // 1. First sync (no remote yet) -> safe upload
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({hasRemote: false, hasBaseline: false}));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'synced', lastSyncedAt: 10_000, conflictCount: 0});
        expect(f.ports.commit).toHaveBeenLastCalledWith('auto-preview-1', GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, expect.any(Object));

        // 2. Non-conflicting three-way merge -> commits recommended choices
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            changes: [
                {id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: false, recommended: 'local'},
                {id: '1', label: 'Target', local: 'en', remote: 'ja', sensitive: false, conflict: false, recommended: 'remote'},
            ],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'synced', conflictCount: 0});
        expect(f.ports.commit).toHaveBeenLastCalledWith('auto-preview-1', GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'merge', {'0': 'local', '1': 'remote'}, expect.any(Object));

        // 3. Explicit conflict -> NEVER commits, cancels preview, records conflict status
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            changes: [{id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: true, recommended: null}],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict', conflictCount: 1, lastErrorKey: 'settings.cloud.autoSync.statusConflict'});
        expect(f.ports.cancel).toHaveBeenCalledWith('auto-preview-1');
        expect(f.ports.commit).toHaveBeenCalledTimes(2);

        // 4. Missing baseline with remote changes or sensitive scope mismatch -> NEVER overwrites, records conflict
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            hasBaseline: false,
            changes: [{id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: false, recommended: 'remote'}],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict', conflictCount: 1});
        expect(f.ports.commit).toHaveBeenCalledTimes(2);

        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            hasBaseline: false,
            includeSensitive: true,
            remoteIncludesSensitive: false,
            changes: [],
        }));
        vi.mocked(f.ports.cancel).mockRejectedValueOnce(new Error('cancel failed'));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict', conflictCount: 1});

        // 5. Read-only remote with local-only changes, learning changes, or E2EE upgrade -> conflict; read-only remote with only remote changes -> safe download
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            canUpload: false,
            changes: [{id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: false, recommended: 'local'}],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict'});

        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            canUpload: false,
            changes: [],
            learningSummary: {
                vocabulary: {enabled: true, remoteAvailable: true, localCount: 1, remoteCount: 1, addedFromRemote: 0, updatedFromRemote: 0, addedToRemote: 1, updatedToRemote: 0, hasChanges: true},
                personalCorrections: {enabled: false, remoteAvailable: false, localCount: 0, remoteCount: 0, addedFromRemote: 0, updatedFromRemote: 0, addedToRemote: 0, updatedToRemote: 0, hasChanges: false},
                readingMaterials: {enabled: false, remoteAvailable: false, localCount: 0, remoteCount: 0, addedFromRemote: 0, updatedFromRemote: 0, addedToRemote: 0, updatedToRemote: 0, hasChanges: false},
                hasAnyChanges: true,
            },
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict'});

        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            canUpload: false,
            changes: [],
            keyMode: 'custom',
            remoteKeyMode: 'app',
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict'});

        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            canUpload: false,
            changes: [{id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: false, recommended: 'remote'}],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'synced'});
        expect(f.ports.commit).toHaveBeenLastCalledWith('auto-preview-1', GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'download', {'0': 'remote'}, expect.any(Object));
    });

    it('handles passphrase-locked, offline, unavailable, abort, manual-preview contention, and exponential backoff', async () => {
        const f = autoSyncFixture();
        await f.autoSync.configure({enabled: true, intervalMinutes: 30});

        // Aborted before start & aborted after resolvePassphrase & aborted after prepare
        const aborted = new AbortController();
        aborted.abort();
        expect(await f.autoSync.runNow(aborted.signal)).toMatchObject({state: 'idle'});

        const midAbort = new AbortController();
        vi.mocked(f.ports.resolvePassphrase).mockImplementationOnce(async () => {
            midAbort.abort();
            return {keyMode: 'app', passphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE, legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE};
        });
        expect(await f.autoSync.runNow(midAbort.signal)).toMatchObject({state: 'idle'});

        const afterPrepareAbort = new AbortController();
        vi.mocked(f.ports.prepare).mockImplementationOnce(async () => {
            afterPrepareAbort.abort();
            return previewFixture();
        });
        expect(await f.autoSync.runNow(afterPrepareAbort.signal)).toMatchObject({state: 'idle'});
        expect(f.ports.cancel).toHaveBeenCalledWith('auto-preview-1');

        // Offline skips network without incrementing failures
        f.setOnline(false);
        expect(await f.autoSync.runNow()).toMatchObject({state: 'offline', consecutiveFailures: 0});
        f.setOnline(true);

        // Unavailable backend records idle
        f.setAvailable(false);
        expect(await f.autoSync.runNow()).toMatchObject({state: 'idle'});
        f.setAvailable(true);

        // Passphrase locked or invalid from store -> passphrase-locked without mutation, and scheduled runs short-circuit until unlocked!
        vi.mocked(f.ports.resolvePassphrase).mockRejectedValueOnce(new DriveEncryptionError('locked', 'passphrase-required'));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'passphrase-locked', lastErrorKey: 'settings.cloud.e2ee.passphraseRequired'});
        const callsWhileLocked = vi.mocked(f.ports.prepare).mock.calls.length;
        expect(await f.autoSync.runScheduled()).toMatchObject({state: 'passphrase-locked'});
        expect(vi.mocked(f.ports.prepare).mock.calls.length).toBe(callsWhileLocked);
        expect(await f.autoSync.notifyPassphraseChanged()).toMatchObject({state: 'idle', consecutiveFailures: 0});
        expect(await f.autoSync.notifyPassphraseChanged()).toMatchObject({state: 'idle'});
        vi.mocked(f.ports.resolvePassphrase).mockRejectedValueOnce(new DriveEncryptionError('invalid', 'invalid-passphrase'));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'passphrase-locked', lastErrorKey: 'settings.cloud.e2ee.passphraseRequired'});
        await f.autoSync.notifyPassphraseChanged();

        // Conflict state also short-circuits scheduled runs until resolved by manual sync!
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({
            changes: [{id: '0', label: 'Theme', local: 'dark', remote: 'light', sensitive: false, conflict: true, recommended: null}],
        }));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'conflict', conflictCount: 1});
        const callsWhileConflict = vi.mocked(f.ports.prepare).mock.calls.length;
        expect(await f.autoSync.runScheduled()).toMatchObject({state: 'conflict'});
        expect(vi.mocked(f.ports.prepare).mock.calls.length).toBe(callsWhileConflict);
        expect(await f.autoSync.resetAfterManualSync(99_000)).toMatchObject({state: 'synced', lastSyncedAt: 99_000, conflictCount: 0, consecutiveFailures: 0, nextRetryAt: null});
        await f.autoSync.configure({enabled: false});
        expect(await f.autoSync.resetAfterManualSync()).toMatchObject({state: 'idle', lastSyncedAt: 10_000});
        await f.autoSync.configure({enabled: true, intervalMinutes: 30});

        // Unexpected error from resolvePassphrase bubbles up
        vi.mocked(f.ports.resolvePassphrase).mockRejectedValueOnce(new Error('storage broken'));
        await expect(f.autoSync.runNow()).rejects.toThrow('storage broken');

        // Wrong passphrase or passphrase-required from prepare -> passphrase-locked
        vi.mocked(f.ports.prepare).mockRejectedValueOnce(new DriveEncryptionError('wrong', 'wrong-passphrase'));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'passphrase-locked', lastErrorKey: 'settings.cloud.e2ee.wrongPassphrase'});
        vi.mocked(f.ports.prepare).mockRejectedValueOnce(new DriveEncryptionError('need', 'passphrase-required'));
        expect(await f.autoSync.runNow()).toMatchObject({state: 'passphrase-locked', lastErrorKey: 'settings.cloud.e2ee.passphraseRequired'});

        // Another settings tab preparing -> skips cleanly without error count
        vi.mocked(f.ports.prepare).mockRejectedValueOnce(new CloudSyncError('另一个设置页面正在确认同步，请先完成或取消该页面的预览。'));
        expect(await f.autoSync.runNow()).toMatchObject({consecutiveFailures: 0});

        // Transient failure on commit cancels preview, increments failure count, and schedules backoff
        vi.mocked(f.ports.commit).mockRejectedValueOnce(new Error('network timeout'));
        const failed = await f.autoSync.runNow();
        expect(failed).toMatchObject({state: 'error', consecutiveFailures: 1, nextRetryAt: 10_000 + 30 * 60_000});
        expect(f.ports.cancel).toHaveBeenCalledWith('auto-preview-1');

        // Scheduled run before nextRetryAt skips cleanly; after nextRetryAt runs and resets backoff
        f.setClock(10_000 + 10 * 60_000);
        const beforeCalls = vi.mocked(f.ports.prepare).mock.calls.length;
        await f.autoSync.runScheduled();
        expect(vi.mocked(f.ports.prepare).mock.calls.length).toBe(beforeCalls);

        f.setClock(10_000 + 35 * 60_000);
        expect(await f.autoSync.runScheduled()).toMatchObject({state: 'synced', consecutiveFailures: 0, nextRetryAt: null});

        // Works cleanly when alarms port is omitted (e.g. non-alarm test environments)
        const noAlarmSync = createCloudAutoSync({...f.ports, alarms: undefined});
        await noAlarmSync.install();
        expect(await noAlarmSync.configure({enabled: true})).toMatchObject({enabled: true});
    });

    it('exposes autoSync actions, clears passphrase & alarm on WebDAV clear, resets on manual commit/passphrase change, and whitelists learning errors', async () => {
        const f = autoSyncFixture();
        const deviceMap = new Map<string, unknown>();
        const passphrases = createCloudPassphraseStore({
            provider: 'webdav',
            deviceStorage: {
                async getItem<T>(k: string) {return (deviceMap.get(k) ?? null) as T | null;},
                async setItem(k: string, v: unknown) {deviceMap.set(k, v);},
                async removeItem(k: string) {deviceMap.delete(k);},
            },
        });
        const webdavService = Object.fromEntries(
            ['status', 'settings', 'save', 'test', 'clear', 'prepare', 'commit', 'cancel', 'prepareDelete', 'commitDelete'].map(k => [k, vi.fn(async () => ({ok: true}))]),
        ) as unknown as ReturnType<typeof createWebDavBackup>;
        const handler = createWebDavBackupHandler(webdavService, () => true, {passphrases, autoSync: f.autoSync});

        expect(await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'autoSyncStatus'}, {})).toMatchObject({
            success: true, data: {enabled: false, intervalMinutes: 60},
        });
        expect(await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'configureAutoSync', autoSync: null}, {})).toMatchObject({
            success: false, errorKey: 'settings.webdav.error.action',
        });
        expect(await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'configureAutoSync', autoSync: {enabled: true, intervalMinutes: 360}}, {})).toMatchObject({
            success: true, data: {enabled: true, intervalMinutes: 360},
        });
        expect(await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'runAutoSyncNow'}, {})).toMatchObject({
            success: true, data: {state: 'synced'},
        });

        // configurePassphrase wakes autoSync from passphrase-locked
        vi.mocked(f.ports.resolvePassphrase).mockRejectedValueOnce(new DriveEncryptionError('locked', 'passphrase-required'));
        await f.autoSync.runNow();
        expect((await f.autoSync.status()).state).toBe('passphrase-locked');
        await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'configurePassphrase', passphraseConfig: {mode: 'custom', passphrase: 'StrongPassphrase!2026', rememberScope: 'device'}}, {});
        expect((await f.autoSync.status()).state).toBe('idle');

        // Manual commit resets autoSync conflict/backoff state
        vi.mocked(f.ports.prepare).mockResolvedValueOnce(previewFixture({changes: [{id: '0', label: 'T', local: 'a', remote: 'b', sensitive: false, conflict: true, recommended: null}]}));
        await f.autoSync.runNow();
        expect((await f.autoSync.status()).state).toBe('conflict');
        await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'commit', id: 'p1', direction: 'upload', choices: {}}, {});
        expect((await f.autoSync.status()).state).toBe('synced');

        // Clearing WebDAV connection disables autoSync, clears alarm, and wipes stored passphrase secrets!
        await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'clear', revision: 'rev-1'}, {});
        expect(await f.autoSync.status()).toMatchObject({enabled: false, state: 'idle'});
        expect(await passphrases.status()).toMatchObject({hasStoredPassphrase: false, storageScope: 'none'});
        expect(f.alarms.clear).toHaveBeenCalledWith(CLOUD_AUTO_SYNC_ALARM);

        // Whitelisted repository errors surface their messages cleanly
        for (const err of [
            new PersonalCorrectionError('校订超限'),
            new VocabularyBookError('limit-exceeded', '单词本超限'),
            new MaterialError('limit-exceeded', '材料超限'),
        ]) {
            vi.mocked(webdavService.prepare).mockRejectedValueOnce(err);
            expect(await handler.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'app'}, {})).toEqual({
                success: false, error: err.message,
            });
        }
    });
});
