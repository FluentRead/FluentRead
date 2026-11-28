import {describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {driveSyncPayload, toDriveSyncConfig} from '@/src/core/config/driveSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {
    decryptDriveConfig,
    DRIVE_ENCRYPTION_FORMAT,
    DriveEncryptionError,
    encryptDriveConfig,
    evaluatePassphraseStrength,
    inspectDriveEncryptedEnvelope,
} from '@/src/platform/google-drive/encryption';
import {
    cloudPassphraseDeviceKey,
    cloudPassphraseModeKey,
    cloudPassphraseSessionKey,
    createCloudPassphraseStore,
    type CloudPassphraseSessionStorage,
} from '@/src/services/config/cloudPassphraseStore';
import {createGoogleDriveSync, type DriveSyncPorts} from '@/src/services/config/googleDriveSync';
import {createGoogleDriveSyncHandler, GOOGLE_DRIVE_SYNC_MESSAGE_TYPE} from '@/src/app/background/handlers/googleDriveSync';
import {createWebDavBackupHandler, WEBDAV_BACKUP_MESSAGE_TYPE} from '@/src/app/background/handlers/webDavBackup';
import type {createWebDavBackup} from '@/src/services/config/webDavBackup';
import type {DriveRemote} from '@/src/platform/google-drive/api';
import {initialDriveDirection} from '@/src/features/settings/model/googleDrivePreview';
import {PersonalCorrectionError} from '@/src/core/personal-corrections/public';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import {VocabularyBookError} from '@/src/features/vocabulary/repository';

const CUSTOM_PASS = 'ZeroKnowledge-Passphrase!2026';
const OTHER_PASS = 'AnotherStrong-Passphrase!2026';

function sampleConfig(patch: Record<string, unknown> = {}) {
    return toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, ...patch}));
}

function memoryDeviceStorage() {
    const map = new Map<string, unknown>();
    return {
        map,
        async getItem<T>(key: string): Promise<T | null> {
            return (map.has(key) ? structuredClone(map.get(key)) : null) as T | null;
        },
        async setItem(key: string, value: unknown): Promise<void> {
            map.set(key, structuredClone(value));
        },
        async removeItem(key: string): Promise<void> {
            map.delete(key);
        },
    };
}

function memorySessionStorage(): CloudPassphraseSessionStorage & {map: Map<string, unknown>} {
    const map = new Map<string, unknown>();
    return {
        map,
        async get(key: string) {return map.has(key) ? {[key]: map.get(key)} : {};},
        async set(items: Record<string, unknown>) {for (const [k, v] of Object.entries(items)) map.set(k, v);},
        async remove(key: string) {map.delete(key);},
    };
}

function syncFixture() {
    let local = sampleConfig({to: 'ja'});
    let remote: DriveRemote | null = null;
    let state: unknown = null;
    const owner = {id: 'acct-e2ee', email: 'e2ee@example.test'};
    const ports: DriveSyncPorts = {
        auth: {
            availability: () => ({available: true, reason: ''}),
            open: vi.fn(async () => ({account: owner, request: async <T>(op: (token: string) => Promise<T>) => op('tok')})),
            disconnect: vi.fn(async () => undefined),
        },
        api: {
            read: vi.fn(async () => remote),
            remove: vi.fn(async () => {remote = null;}),
            write: vi.fn(async (_session, content) => {
                const file = {id: 'file-1', version: String(Number(remote?.file.version ?? 0) + 1), modifiedTime: ''};
                remote = {file, content};
                return file;
            }),
        },
        snapshot: vi.fn(async () => structuredClone(local)),
        apply: vi.fn(async value => {local = structuredClone(value);}),
        readState: vi.fn(async () => state),
        writeState: vi.fn(async value => {state = value;}),
        now: () => 5_000,
    };
    return {
        service: createGoogleDriveSync(ports),
        ports,
        get local() {return local;},
        set local(v) {local = v;},
        get remote() {return remote;},
        set remote(v) {remote = v;},
        get state() {return state;},
    };
}

describe('Zero-Knowledge Custom E2EE Passphrase & Downgrade Resistance', () => {
    it('encrypts v2 custom envelopes with AAD binding keyMode and blocks downgrade/upgrade tampering', async () => {
        const payload = {format: 'test', secret: 'api-key-fixture'};
        const v1 = await encryptDriveConfig(payload, GOOGLE_DRIVE_APPLICATION_PASSPHRASE);
        const v2 = await encryptDriveConfig(payload, CUSTOM_PASS, {keyMode: 'custom'});

        expect(inspectDriveEncryptedEnvelope(v1)).toEqual({version: 1, keyMode: 'app'});
        expect(inspectDriveEncryptedEnvelope(v2)).toEqual({version: 2, keyMode: 'custom'});
        expect(JSON.parse(v2)).toMatchObject({format: DRIVE_ENCRYPTION_FORMAT, version: 2, keyMode: 'custom'});
        expect(v2).not.toContain('api-key-fixture');
        expect(v2).not.toContain(CUSTOM_PASS);

        expect(await decryptDriveConfig(v2, CUSTOM_PASS, {expectedKeyMode: 'custom'})).toEqual(payload);
        await expect(decryptDriveConfig(v2, OTHER_PASS, {expectedKeyMode: 'custom'})).rejects.toMatchObject({code: 'wrong-passphrase'});
        await expect(decryptDriveConfig(v2, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, {expectedKeyMode: 'app'})).rejects.toMatchObject({code: 'passphrase-required'});
        await expect(decryptDriveConfig(v1, CUSTOM_PASS, {expectedKeyMode: 'custom'})).rejects.toMatchObject({code: 'unsupported'});

        // Downgrade attack: rewrite v2 header to v1/app -> AAD mismatch rejects even with same passphrase!
        const downgraded = {...JSON.parse(v2), version: 1, keyMode: 'app'};
        await expect(decryptDriveConfig(JSON.stringify(downgraded), CUSTOM_PASS)).rejects.toMatchObject({code: 'wrong-passphrase'});

        // Upgrade spoof: rewrite v1 header to v2/custom -> AAD mismatch rejects!
        const upgradedSpoof = {...JSON.parse(v1), version: 2, keyMode: 'custom'};
        await expect(decryptDriveConfig(JSON.stringify(upgradedSpoof), GOOGLE_DRIVE_APPLICATION_PASSPHRASE)).rejects.toMatchObject({code: 'wrong-passphrase'});

        // Invalid keyMode on encrypt or invalid envelope keyMode
        await expect(encryptDriveConfig(payload, CUSTOM_PASS, {keyMode: 'invalid' as 'app'})).rejects.toMatchObject({code: 'unsupported'});
        expect(() => inspectDriveEncryptedEnvelope(JSON.stringify({...JSON.parse(v1), keyMode: 'custom'}))).toThrow(DriveEncryptionError);
    });

    it('evaluates passphrase strength across all tiers', () => {
        expect(evaluatePassphraseStrength('short')).toBe('too-short');
        expect(evaluatePassphraseStrength('            ')).toBe('too-short');
        expect(evaluatePassphraseStrength('abcdefghijkl')).toBe('weak');
        expect(evaluatePassphraseStrength('123456789012')).toBe('weak');
        expect(evaluatePassphraseStrength('abcdefghijkl12')).toBe('fair');
        expect(evaluatePassphraseStrength('Abcdefghijkl1234!')).toBe('strong');
    });

    it('manages custom passphrase retention across none, session, memory fallback, and encrypted device storage', async () => {
        const device = memoryDeviceStorage();
        const session = memorySessionStorage();
        const store = createCloudPassphraseStore({provider: 'webdav', deviceStorage: device, sessionStorage: session});

        expect(await store.status()).toEqual({mode: 'app', hasStoredPassphrase: false, storageScope: 'none'});
        expect(await store.resolveForSync()).toMatchObject({keyMode: 'app', passphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE});

        // Session retention (both explicit and default rememberScope)
        expect(await store.configure({mode: 'custom', passphrase: CUSTOM_PASS})).toEqual({
            mode: 'custom', hasStoredPassphrase: true, storageScope: 'session',
        });
        expect(await store.configure({mode: 'custom', passphrase: CUSTOM_PASS, rememberScope: 'session'})).toEqual({
            mode: 'custom', hasStoredPassphrase: true, storageScope: 'session',
        });
        expect(session.map.get(cloudPassphraseSessionKey('webdav'))).toBe(CUSTOM_PASS);
        expect(device.map.has(cloudPassphraseDeviceKey('webdav'))).toBe(false);
        expect(await store.resolveForSync()).toEqual({
            keyMode: 'custom', passphrase: CUSTOM_PASS, legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
        });

        // Device encrypted hold (for auto-sync)
        expect(await store.configure({mode: 'custom', passphrase: OTHER_PASS, rememberScope: 'device'})).toEqual({
            mode: 'custom', hasStoredPassphrase: true, storageScope: 'device',
        });
        expect(session.map.has(cloudPassphraseSessionKey('webdav'))).toBe(false);
        expect(device.map.get(cloudPassphraseDeviceKey('webdav'))).toEqual({version: 1, passphrase: OTHER_PASS});
        expect(await store.resolveForSync()).toMatchObject({keyMode: 'custom', passphrase: OTHER_PASS});

        // One-click forget clears both device & session while keeping mode
        expect(await store.clear()).toEqual({mode: 'custom', hasStoredPassphrase: false, storageScope: 'none'});
        await expect(store.resolveForSync()).rejects.toMatchObject({code: 'passphrase-required'});

        // One-shot override works without storing
        expect(await store.resolveForSync({keyMode: 'custom', passphrase: CUSTOM_PASS})).toMatchObject({keyMode: 'custom', passphrase: CUSTOM_PASS});
        expect(await store.configure({mode: 'custom', rememberScope: 'none'})).toEqual({mode: 'custom', hasStoredPassphrase: false, storageScope: 'none'});

        // Switch back to app mode wipes everything
        expect(await store.configure({mode: 'app'})).toEqual({mode: 'app', hasStoredPassphrase: false, storageScope: 'none'});
        expect(device.map.get(cloudPassphraseModeKey('webdav'))).toEqual({version: 1, mode: 'app'});

        // Invalid inputs rejected
        await expect(store.configure({mode: 'bad' as 'app'})).rejects.toMatchObject({code: 'unsupported'});
        await expect(store.configure({mode: 'custom', rememberScope: 'bad' as 'session', passphrase: CUSTOM_PASS})).rejects.toMatchObject({code: 'unsupported'});
        await expect(store.configure({mode: 'custom', rememberScope: 'session'})).rejects.toMatchObject({code: 'invalid-passphrase'});

        // Fallback to in-memory when sessionStorage is absent or throws
        const throwingSession: CloudPassphraseSessionStorage = {
            get: vi.fn(async () => {throw new Error('session denied');}),
            set: vi.fn(async () => {throw new Error('session denied');}),
            remove: vi.fn(async () => {throw new Error('session denied');}),
        };
        const fallbackStore = createCloudPassphraseStore({provider: 'google-drive', deviceStorage: memoryDeviceStorage(), sessionStorage: throwingSession});
        expect(await fallbackStore.configure({mode: 'custom', passphrase: CUSTOM_PASS, rememberScope: 'session'})).toEqual({
            mode: 'custom', hasStoredPassphrase: true, storageScope: 'session',
        });
        expect(await fallbackStore.resolveForSync()).toMatchObject({keyMode: 'custom', passphrase: CUSTOM_PASS});
        await fallbackStore.clear();
        expect(await fallbackStore.status()).toEqual({mode: 'custom', hasStoredPassphrase: false, storageScope: 'none'});

        const memoryOnlyStore = createCloudPassphraseStore({provider: 'google-drive', deviceStorage: memoryDeviceStorage()});
        expect(await memoryOnlyStore.configure({mode: 'custom', passphrase: CUSTOM_PASS, rememberScope: 'session'})).toEqual({
            mode: 'custom', hasStoredPassphrase: true, storageScope: 'session',
        });
    });

    it('seamlessly upgrades a legacy v1 backup to v2 custom E2EE and blocks app-mode access without mutating local state', async () => {
        const f = syncFixture();
        // 1. Seed a legacy v1 app-encrypted backup with identical config
        const legacyContent = await encryptDriveConfig(driveSyncPayload(f.local, false), GOOGLE_DRIVE_APPLICATION_PASSPHRASE);
        f.remote = {file: {id: 'file-1', version: '1', modifiedTime: ''}, content: legacyContent};

        // 2. Prepare in custom mode without explicit legacyPassphrase (uses built-in legacy fallback)
        const fallbackPreview = await f.service.prepare(CUSTOM_PASS, 1, 'client-a', false, {keyMode: 'custom'});
        expect(fallbackPreview).toMatchObject({hasRemote: true, keyMode: 'custom', remoteKeyMode: 'app'});
        await f.service.cancel(fallbackPreview.id, 1, 'client-a');

        // Prepare in custom mode: decrypts v1 with legacy fallback and flags upgrade
        const upgradePreview = await f.service.prepare(CUSTOM_PASS, 1, 'client-a', false, {
            keyMode: 'custom',
            legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
        });
        expect(upgradePreview).toMatchObject({hasRemote: true, keyMode: 'custom', remoteKeyMode: 'app', changes: []});
        expect(initialDriveDirection(upgradePreview)).toBe('');

        // Commit across a fresh service instance (MV3 restart) re-encrypts remote as v2 custom!
        await createGoogleDriveSync(f.ports).commit(upgradePreview.id, CUSTOM_PASS, 'upload', {}, 1, 'client-a', {
            keyMode: 'custom',
            legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
        });
        expect(inspectDriveEncryptedEnvelope(f.remote!.content)).toEqual({version: 2, keyMode: 'custom'});
        expect(f.ports.api.write).toHaveBeenCalledOnce();

        // 3. Attempting to prepare in legacy app mode against v2 custom backup throws passphrase-required and leaves local untouched
        const localBefore = structuredClone(f.local);
        await expect(f.service.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'client-a', false)).rejects.toMatchObject({
            code: 'passphrase-required',
        });
        expect(f.local).toEqual(localBefore);

        // 4. Attempting with wrong custom passphrase fails cleanly without mutating local
        await expect(f.service.prepare(OTHER_PASS, 1, 'client-a', false, {keyMode: 'custom'})).rejects.toMatchObject({
            code: 'wrong-passphrase',
        });
        expect(f.local).toEqual(localBefore);

        // 5. KeyMode mismatch between prepare and commit is rejected
        const customPreview = await f.service.prepare(CUSTOM_PASS, 1, 'client-a', false, {keyMode: 'custom'});
        await expect(f.service.commit(customPreview.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, 1, 'client-a', {keyMode: 'app'})).rejects.toThrow('口令模式已变化');

        // 6. Normal custom-to-custom merge across MV3 restart preserves baseline
        f.local = sampleConfig({to: 'fr'});
        const mergePreview = await f.service.prepare(CUSTOM_PASS, 1, 'client-a', false, {keyMode: 'custom'});
        expect(mergePreview.hasBaseline).toBe(true);
        await createGoogleDriveSync(f.ports).commit(mergePreview.id, CUSTOM_PASS, 'merge', Object.fromEntries(mergePreview.changes.map(c => [c.id, 'local'])), 1, 'client-a', {keyMode: 'custom'});
        expect(inspectDriveEncryptedEnvelope(f.remote!.content)).toEqual({version: 2, keyMode: 'custom'});
    });

    it('wires passphrase actions and structured error keys through Google Drive and WebDAV background handlers', async () => {
        const driveService = {status: vi.fn(), cancel: vi.fn(), prepare: vi.fn(async () => ({id: 'p1'})), commit: vi.fn(async () => ({available: true})), prepareDelete: vi.fn(), commitDelete: vi.fn()} as unknown as ReturnType<typeof createGoogleDriveSync>;
        const webdavService = {status: vi.fn(), settings: vi.fn(), save: vi.fn(), test: vi.fn(), clear: vi.fn(), cancel: vi.fn(), prepare: vi.fn(async () => ({id: 'p2'})), commit: vi.fn(async () => ({available: true})), prepareDelete: vi.fn(), commitDelete: vi.fn()} as unknown as ReturnType<typeof createWebDavBackup>;
        const drivePassphrases = createCloudPassphraseStore({provider: 'google-drive', deviceStorage: memoryDeviceStorage(), sessionStorage: memorySessionStorage()});
        const webdavPassphrases = createCloudPassphraseStore({provider: 'webdav', deviceStorage: memoryDeviceStorage(), sessionStorage: memorySessionStorage()});

        const driveHandler = createGoogleDriveSyncHandler(driveService, () => true, {passphrases: drivePassphrases});
        const webdavHandler = createWebDavBackupHandler(webdavService, () => true, {passphrases: webdavPassphrases});

        // Without extras: passphraseStatus returns default legacy mode, custom without passphrase fails cleanly
        const bareDrive = createGoogleDriveSyncHandler(driveService, () => true);
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'passphraseStatus'}, {})).toEqual({
            success: true, data: {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'},
        });
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'custom'}, {})).toMatchObject({
            success: false, errorKey: 'settings.cloud.e2ee.passphraseRequired',
        });
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'custom', passphrase: CUSTOM_PASS}, {})).toMatchObject({success: true});
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'bad'}, {})).toMatchObject({success: false});
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', passphrase: 123}, {})).toMatchObject({success: false, errorKey: 'settings.cloud.e2ee.invalidPassphrase'});
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', learningScope: {includeVocabulary: true}}, {})).toMatchObject({success: true});
        expect(await bareDrive.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', learningScope: {includeVocabulary: false}}, {})).toMatchObject({success: true});

        const bareWebdav = createWebDavBackupHandler(webdavService, () => true);
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'passphraseStatus'}, {})).toEqual({
            success: true, data: {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'},
        });
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'custom'}, {})).toMatchObject({
            success: false, errorKey: 'settings.cloud.e2ee.passphraseRequired',
        });
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'custom', passphrase: CUSTOM_PASS}, {})).toMatchObject({success: true});
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'bad'}, {})).toMatchObject({success: false});
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', passphrase: 123}, {})).toMatchObject({success: false, errorKey: 'settings.cloud.e2ee.invalidPassphrase'});
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', learningScope: {includeVocabulary: true}}, {})).toMatchObject({success: true});
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', learningScope: {includeVocabulary: false}}, {})).toMatchObject({success: true});
        expect(await bareWebdav.handle({type: WEBDAV_BACKUP_MESSAGE_TYPE, clientId: 'c1', action: 'commit', id: 'p1', direction: 'upload', choices: {}}, {})).toMatchObject({success: true});

        // With passphrases store: configure -> prepare -> commit -> clear
        for (const [handler, type, svc] of [
            [driveHandler, GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, driveService],
            [webdavHandler, WEBDAV_BACKUP_MESSAGE_TYPE, webdavService],
        ] as const) {
            expect(await handler.handle({type, clientId: 'c1', action: 'configurePassphrase', passphraseConfig: null} as never, {})).toMatchObject({success: false});
            expect(await handler.handle({type, clientId: 'c1', action: 'configurePassphrase', passphraseConfig: {mode: 'custom', passphrase: CUSTOM_PASS, rememberScope: 'session'}} as never, {})).toEqual({
                success: true, data: {mode: 'custom', hasStoredPassphrase: true, storageScope: 'session'},
            });
            expect(await handler.handle({type, clientId: 'c1', action: 'passphraseStatus'} as never, {})).toEqual({
                success: true, data: {mode: 'custom', hasStoredPassphrase: true, storageScope: 'session'},
            });
            expect(await handler.handle({type, clientId: 'c1', action: 'prepare', includeSensitive: false} as never, {})).toMatchObject({success: true});
            expect(svc.prepare).toHaveBeenLastCalledWith(CUSTOM_PASS, undefined, 'c1', false, expect.objectContaining({keyMode: 'custom', legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE}));
            expect(await handler.handle({type, clientId: 'c1', action: 'commit', id: 'p1', direction: 'upload', choices: {}} as never, {})).toMatchObject({success: true});
            expect(svc.commit).toHaveBeenLastCalledWith('p1', CUSTOM_PASS, 'upload', {}, undefined, 'c1', expect.objectContaining({keyMode: 'custom'}));
            expect(await handler.handle({type, clientId: 'c1', action: 'clearPassphrase'} as never, {})).toEqual({
                success: true, data: {mode: 'custom', hasStoredPassphrase: false, storageScope: 'none'},
            });

            // Wrong passphrase error key
            vi.mocked(svc.prepare).mockRejectedValueOnce(new DriveEncryptionError('wrong', 'wrong-passphrase'));
            expect(await handler.handle({type, clientId: 'c1', action: 'prepare', keyMode: 'custom', passphrase: OTHER_PASS} as never, {})).toMatchObject({
                success: false, errorKey: 'settings.cloud.e2ee.wrongPassphrase',
            });
        }

        // Google Drive handler whitelists learning repository errors
        for (const err of [
            new PersonalCorrectionError('校订超限'),
            new VocabularyBookError('limit-exceeded', '单词本超限'),
            new MaterialError('limit-exceeded', '材料超限'),
        ]) {
            vi.mocked(driveService.prepare).mockRejectedValueOnce(err);
            expect(await driveHandler.handle({type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE, clientId: 'c1', action: 'prepare', keyMode: 'app'}, {})).toEqual({
                success: false, error: err.message,
            });
        }
    });
});
