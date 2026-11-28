import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    CONFIG_DATABASE_NAME,
    EncryptedConfigRepository,
    FluentReadConfigDatabase,
} from '@/src/platform/storage/configRepository';
import {encryptConfigValue} from '@/src/platform/storage/configEncryption';
import {
    CONFIG_LEGACY_CLEANUP_MARKER_KEY,
    CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY,
    CONFIG_STORAGE_CHANGED_MESSAGE,
    CONFIG_STORAGE_READ_MESSAGE,
    createBackgroundConfigStorage,
    createRemoteConfigStorage,
    createSessionKeyMaterialProvider,
    type LegacyConfigStoragePort,
} from '@/src/platform/storage/configStorage';
import {isBackgroundContext} from '@/src/platform/storage/configStorageRuntime';

const databases: FluentReadConfigDatabase[] = [];

function createDatabase() {
    const database = new FluentReadConfigDatabase(`FluentReadConfiguration-storage-${crypto.randomUUID()}`);
    databases.push(database);
    return database;
}

async function digestValue(value: unknown): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
    ));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function createLegacyHarness(initial: Record<string, unknown> = {}, failRemoveKey = '') {
    const values = new Map(Object.entries(initial));
    const operations: string[] = [];
    let currentFailRemoveKey = failRemoveKey;
    const port: LegacyConfigStoragePort = {
        async getItem<T>(key: string) {
            operations.push(`get:${key}`);
            return (values.get(key) ?? null) as T | null;
        },
        async setItem<T>(key: string, value: T) {
            operations.push(`set:${key}`);
            values.set(key, structuredClone(value));
        },
        async removeItem(key: string) {
            operations.push(`remove:${key}`);
            if (key === currentFailRemoveKey) throw new Error('cleanup failed');
            values.delete(key);
        },
    };
    return {
        values,
        operations,
        port,
        allowRemove() { currentFailRemoveKey = ''; },
    };
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(async database => {
        database.close();
        await database.delete();
    }));
    await Dexie.delete(CONFIG_DATABASE_NAME);
});

describe('配置 IndexedDB storage port', () => {
    it('把全部旧配置键原子迁入密文数据库，验证后删除旧载体', async () => {
        const sentinel = 'legacy-api-key-sensitive-sentinel';
        const legacy = createLegacyHarness({
            'local:config': {on: true, user_role: {openai: 'legacy-user-role'}},
            'local:configHistory': {entries: [{version: 1}]},
            'local:configAutoBackups': {entries: [{version: 2}]},
            'local:credentials': {token: {openai: sentinel}},
            'session:credentials': {token: {openai: 'session-secret'}},
            'local:fluentReadImageOcrLanguages': ['eng', 'chi_sim'],
        });
        const repository = new EncryptedConfigRepository({
            database: createDatabase(),
            getSessionKeyMaterial: async () => 'current-browser-session',
        });
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).resolves.toEqual({
            on: true,
            user_role: {openai: 'legacy-user-role'},
        });
        await expect(storage.getItem('local:credentials')).resolves.toEqual({token: {openai: sentinel}});
        await expect(storage.getItem('session:credentials')).resolves.toEqual({token: {openai: 'session-secret'}});
        await expect(storage.getItem('local:fluentReadImageOcrLanguages')).resolves.toEqual(['eng', 'chi_sim']);
        expect([...legacy.values.keys()]).toEqual([]);
        expect(legacy.operations.filter(operation => operation.startsWith('remove:'))).toHaveLength(6);
        const rawRecords = await repository.database.records.toArray();
        expect(rawRecords).toHaveLength(6);
        expect(JSON.stringify(rawRecords)).not.toContain(sentinel);
        expect(JSON.stringify(rawRecords)).not.toContain('legacy-user-role');
    });

    it('主配置已在 IndexedDB 时直接使用且完全不访问残留旧 storage', async () => {
        const legacy = createLegacyHarness({'local:config': {marker: 'stale-legacy'}});
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        await repository.set('local:config', {marker: 'indexed-db-authoritative'});
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).resolves.toEqual({marker: 'indexed-db-authoritative'});
        expect(legacy.values.get('local:config')).toEqual({marker: 'stale-legacy'});
        expect(legacy.operations).toEqual([]);
    });

    it('迁移加密失败时不写半套数据库，也不删除任何旧键，并允许重试', async () => {
        const legacy = createLegacyHarness({
            'local:config': {on: true},
            'local:configHistory': {fail: true},
        });
        let shouldFail = true;
        const repository = new EncryptedConfigRepository({
            database: createDatabase(),
            encrypt: async (value, keyMaterial, additionalData) => {
                if (shouldFail && (value as {fail?: boolean}).fail) throw new Error('migration encryption failed');
                return encryptConfigValue(value, undefined, keyMaterial, additionalData);
            },
        });
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).rejects.toThrow('migration encryption failed');
        expect(await repository.database.records.count()).toBe(0);
        expect([...legacy.values.keys()].sort()).toEqual(['local:config', 'local:configHistory']);

        shouldFail = false;
        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        expect(legacy.values.size).toBe(0);
    });

    it('旧 session 区域不可用时仍迁移持久配置，但本地区域读取失败会 fail closed', async () => {
        const values = new Map<string, unknown>([['local:config', {on: true}]]);
        const warn = vi.fn();
        const sessionUnavailable: LegacyConfigStoragePort = {
            async getItem<T>(key: string) {
                if (key.startsWith('session:')) throw new Error('storage.session unavailable');
                return (values.get(key) ?? null) as T | null;
            },
            async setItem<T>(key: string, value: T) { values.set(key, value); },
            async removeItem(key: string) { values.delete(key); },
        };
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const storage = createBackgroundConfigStorage({
            repository,
            legacy: sessionUnavailable,
            logger: {warn},
        });
        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        expect(values.has('local:config')).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('session:credentials'),
            expect.objectContaining({message: 'storage.session unavailable'}),
        );

        const localUnavailable: LegacyConfigStoragePort = {
            async getItem() { throw new Error('storage.local unavailable'); },
            async setItem() { return undefined; },
            async removeItem() { return undefined; },
        };
        const failedRepository = new EncryptedConfigRepository({database: createDatabase()});
        const failed = createBackgroundConfigStorage({repository: failedRepository, legacy: localUnavailable});
        await expect(failed.getItem('local:config')).rejects.toThrow('storage.local unavailable');
        expect(await failedRepository.database.records.count()).toBe(0);
    });

    it('迁移读回与刚导入值不一致时保留旧键并拒绝启用数据库', async () => {
        const legacy = createLegacyHarness({'local:config': {on: true}});
        const repository = {
            has: vi.fn().mockResolvedValue(false),
            importMigrationSnapshotIfAuthorityMissing: vi.fn().mockResolvedValue(true),
            get: vi.fn().mockResolvedValue({on: false}),
        } as unknown as EncryptedConfigRepository;
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).rejects.toThrow('迁移写入校验失败');
        expect(legacy.values.get('local:config')).toEqual({on: true});
        expect(legacy.operations).not.toContain('remove:local:config');
    });

    it('并发迁移未胜出且胜出实例已清除 marker 时直接采用其主配置', async () => {
        const legacy = createLegacyHarness({'local:config': {snapshot: 'losing-legacy'}});
        const repository = {
            has: vi.fn().mockResolvedValue(false),
            importMigrationSnapshotIfAuthorityMissing: vi.fn().mockResolvedValue(false),
            get: vi.fn(async (key: string) => (
                key === 'local:config' ? {snapshot: 'winning-indexed-db'} : null
            )),
        } as unknown as EncryptedConfigRepository;
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).resolves.toEqual({snapshot: 'winning-indexed-db'});
        expect(legacy.values.get('local:config')).toEqual({snapshot: 'losing-legacy'});
        expect(legacy.operations.filter(operation => operation.startsWith('remove:'))).toEqual([]);
    });

    it('首次迁移的旧键清理失败时留下密文标记，并在下次启动只重试删除而不读取旧值', async () => {
        const legacy = createLegacyHarness({'local:config': {on: true}}, 'local:config');
        const warn = vi.fn();
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const storage = createBackgroundConfigStorage({
            repository,
            legacy: legacy.port,
            logger: {warn},
        });

        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        expect(legacy.values.get('local:config')).toEqual({on: true});
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('local:config'),
            expect.objectContaining({message: 'cleanup failed'}),
        );
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(true);
        await expect(repository.get(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).resolves.toEqual({
            version: 1,
            state: 'verified',
            keys: ['local:config'],
        });
        const rawMarker = await repository.database.records.get(CONFIG_LEGACY_CLEANUP_MARKER_KEY);
        expect(rawMarker?.payload.ciphertext).toEqual(expect.any(String));
        expect(rawMarker).not.toHaveProperty('value');

        const legacyReadsAfterMigration = legacy.operations.filter(operation => operation.startsWith('get:')).length;
        legacy.values.set('local:config', {on: false});
        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        await repository.set('local:config', {on: 'changed-after-verification'});
        legacy.allowRemove();

        const restartedStorage = createBackgroundConfigStorage({
            repository,
            legacy: legacy.port,
            logger: {warn},
        });
        await expect(restartedStorage.getItem('local:config')).resolves.toEqual({on: 'changed-after-verification'});
        expect(legacy.values.has('local:config')).toBe(false);
        expect(legacy.operations.filter(operation => operation.startsWith('get:'))).toHaveLength(legacyReadsAfterMigration);
        expect(legacy.operations.filter(operation => operation.startsWith('remove:'))).toEqual([
            'remove:local:config',
            'remove:local:config',
        ]);
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(false);
    });

    it('没有旧主配置时也由清理标记恢复完整快照，不用残缺 legacy 覆盖历史或凭据', async () => {
        const legacy = createLegacyHarness({
            'local:configHistory': {snapshot: 'migrated-history'},
            'local:credentials': {token: 'migrated-credential'},
        }, 'local:credentials');
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const first = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(first.getItem('local:config')).resolves.toBeNull();
        await expect(repository.get('local:configHistory')).resolves.toEqual({snapshot: 'migrated-history'});
        await expect(repository.get('local:credentials')).resolves.toEqual({token: 'migrated-credential'});
        expect(legacy.values.has('local:configHistory')).toBe(false);
        expect(legacy.values.has('local:credentials')).toBe(true);
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(true);

        const legacyReads = legacy.operations.filter(operation => operation.startsWith('get:')).length;
        legacy.allowRemove();
        const restarted = createBackgroundConfigStorage({repository, legacy: legacy.port});
        await expect(restarted.getItem('local:config')).resolves.toBeNull();
        expect(legacy.operations.filter(operation => operation.startsWith('get:'))).toHaveLength(legacyReads);
        expect(legacy.values.size).toBe(0);
        await expect(repository.get('local:configHistory')).resolves.toEqual({snapshot: 'migrated-history'});
        await expect(repository.get('local:credentials')).resolves.toEqual({token: 'migrated-credential'});
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(true);

        await restarted.setItem('local:config', {snapshot: 'default-established'});
        const finalRestart = createBackgroundConfigStorage({repository, legacy: legacy.port});
        await expect(finalRestart.getItem('local:config')).resolves.toEqual({snapshot: 'default-established'});
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(false);
    });

    it('首次读回前中断且 IndexedDB 主记录损坏时保留旧副本且不执行清理', async () => {
        const legacyValue = {on: true};
        const legacy = createLegacyHarness({'local:config': legacyValue});
        const warn = vi.fn();
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        await repository.importMigrationSnapshotIfAuthorityMissing(
            ['local:config', CONFIG_LEGACY_CLEANUP_MARKER_KEY],
            new Map<string, unknown>([
                ['local:config', legacyValue],
                [CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
                    version: 1,
                    state: 'unverified',
                    records: [{
                        key: 'local:config',
                        digest: await digestValue(legacyValue),
                    }],
                }],
            ]),
            ['local:config', CONFIG_LEGACY_CLEANUP_MARKER_KEY],
        );

        const raw = await repository.database.records.get('local:config');
        if (!raw) throw new Error('测试准备失败：缺少 local:config 密文');
        await repository.database.records.put({
            ...raw,
            payload: {...raw.payload, ciphertext: `${raw.payload.ciphertext.slice(0, -2)}AA`},
        });
        const removalCount = legacy.operations.filter(operation => operation.startsWith('remove:')).length;
        const legacyReadCount = legacy.operations.filter(operation => operation.startsWith('get:')).length;
        const restartedStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});

        await expect(restartedStorage.getItem('local:config')).rejects.toThrow('配置密文校验失败');
        expect(legacy.values.get('local:config')).toEqual({on: true});
        expect(legacy.operations.filter(operation => operation.startsWith('remove:'))).toHaveLength(removalCount);
        expect(legacy.operations.filter(operation => operation.startsWith('get:'))).toHaveLength(legacyReadCount);
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(true);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('local:config'),
            expect.objectContaining({message: '配置密文校验失败'}),
        );
    });

    it('未验证标记恢复时验证持久摘要但不给已过期 session 凭据保存普通摘要', async () => {
        const database = createDatabase();
        const localConfig = {on: true, marker: 'persistent-config'};
        const firstSession = new EncryptedConfigRepository({
            database,
            getSessionKeyMaterial: async () => 'browser-session-a',
        });
        await firstSession.set('local:config', localConfig);
        await firstSession.set('session:credentials', {token: 'session-secret-must-not-be-hashed'});
        await firstSession.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
            version: 1,
            state: 'unverified',
            records: [
                {key: 'local:config', digest: await digestValue(localConfig)},
                {key: 'session:credentials'},
            ],
        });
        const legacy = createLegacyHarness({
            'local:config': localConfig,
            'session:credentials': {token: 'old-session-copy'},
        });
        const nextSession = new EncryptedConfigRepository({
            database,
            getSessionKeyMaterial: async () => 'browser-session-b',
        });
        const storage = createBackgroundConfigStorage({repository: nextSession, legacy: legacy.port});

        await expect(storage.getItem('local:config')).resolves.toEqual(localConfig);
        expect(legacy.operations.filter(operation => operation.startsWith('get:'))).toEqual([]);
        expect(legacy.operations.filter(operation => operation.startsWith('remove:'))).toEqual([
            'remove:local:config',
            'remove:session:credentials',
        ]);
        expect(legacy.values.size).toBe(0);
        expect(await nextSession.has('session:credentials')).toBe(false);
        expect(await nextSession.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(false);
    });

    it('未验证标记的持久记录缺失或摘要不符时不清理旧载体', async () => {
        const legacy = createLegacyHarness({'local:config': {legacy: true}});
        const warn = vi.fn();
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        await repository.set('local:config', {on: true});

        await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
            version: 1,
            state: 'unverified',
            records: [{key: 'local:configHistory', digest: await digestValue({entries: []})}],
        });
        const missingStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
        await expect(missingStorage.getItem('local:config')).resolves.toEqual({on: true});

        await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
            version: 1,
            state: 'unverified',
            records: [{key: 'local:config', digest: '0'.repeat(64)}],
        });
        const mismatchStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
        await expect(mismatchStorage.getItem('local:config')).resolves.toEqual({on: true});
        expect(legacy.operations).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('local:configHistory'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('local:config'));
    });

    it('拒绝格式错误或越权的清理标记，且不访问旧 storage', async () => {
        const invalidMarkers: unknown[] = [
            false,
            'invalid',
            [],
            {version: 2, state: 'verified', keys: ['local:config']},
            {version: 1, state: 'verified', keys: 'local:config'},
            {version: 1, state: 'verified', keys: []},
            {version: 1, state: 'verified', keys: [1]},
            {version: 1, state: 'verified', keys: ['local:unknown']},
            {version: 1, state: 'verified', keys: ['local:config', 'local:config']},
            {version: 1, state: 'unknown', records: []},
            {version: 1, state: 'unverified', records: 'invalid'},
            {version: 1, state: 'unverified', records: []},
            {version: 1, state: 'unverified', records: [null]},
            {version: 1, state: 'unverified', records: ['invalid']},
            {version: 1, state: 'unverified', records: [[]]},
            {version: 1, state: 'unverified', records: [{key: 1, digest: '0'.repeat(64)}]},
            {version: 1, state: 'unverified', records: [{key: 'local:unknown', digest: '0'.repeat(64)}]},
            {version: 1, state: 'unverified', records: [
                {key: 'local:config', digest: '0'.repeat(64)},
                {key: 'local:config', digest: '0'.repeat(64)},
            ]},
            {version: 1, state: 'unverified', records: [{key: 'session:credentials', digest: '0'.repeat(64)}]},
            {version: 1, state: 'unverified', records: [{key: 'local:config'}]},
            {version: 1, state: 'unverified', records: [{key: 'local:config', digest: 'invalid'}]},
        ];
        const legacy = createLegacyHarness({'local:config': {legacy: true}});
        const warn = vi.fn();
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        await repository.set('local:config', {on: true});

        for (const marker of invalidMarkers) {
            await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, marker);
            const storage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
            await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        }
        expect(legacy.operations).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(invalidMarkers.length);
    });

    it('清理标记解密或删除失败时保留安全状态并允许下次启动收敛', async () => {
        const legacy = createLegacyHarness({'local:config': {on: true}});
        const warn = vi.fn();
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        await repository.set('local:config', {on: true});
        await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
            version: 1,
            state: 'verified',
            keys: ['local:config'],
        });
        const markerRecord = await repository.database.records.get(CONFIG_LEGACY_CLEANUP_MARKER_KEY);
        if (!markerRecord) throw new Error('测试准备失败：缺少清理标记');
        await repository.database.records.put({
            ...markerRecord,
            payload: {...markerRecord.payload, ciphertext: `${markerRecord.payload.ciphertext.slice(0, -2)}AA`},
        });
        const corruptStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
        await expect(corruptStorage.getItem('local:config')).resolves.toEqual({on: true});
        expect(legacy.operations).toEqual([]);

        await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
            version: 1,
            state: 'verified',
            keys: ['local:config'],
        });
        const originalRemove = repository.remove.bind(repository);
        let failMarkerRemove = true;
        vi.spyOn(repository, 'remove').mockImplementation(async key => {
            if (key === CONFIG_LEGACY_CLEANUP_MARKER_KEY && failMarkerRemove) {
                throw new Error('marker remove failed');
            }
            await originalRemove(key);
        });
        const failedClearStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
        await expect(failedClearStorage.getItem('local:config')).resolves.toEqual({on: true});
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(true);

        failMarkerRemove = false;
        const recoveredStorage = createBackgroundConfigStorage({repository, legacy: legacy.port, logger: {warn}});
        await expect(recoveredStorage.getItem('local:config')).resolves.toEqual({on: true});
        expect(await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('无法解密'),
            expect.objectContaining({message: '配置密文校验失败'}),
        );
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('暂时无法删除'),
            expect.objectContaining({message: 'marker remove failed'}),
        );
    });

    it('清理标记在 has 与 get 之间消失时仍直接使用 IndexedDB 主配置', async () => {
        const repository = {
            has: vi.fn().mockResolvedValue(true),
            get: vi.fn(async (key: string) => (
                key === CONFIG_LEGACY_CLEANUP_MARKER_KEY ? null : {on: true}
            )),
        } as unknown as EncryptedConfigRepository;
        const legacy = createLegacyHarness({'local:config': {legacy: true}});
        const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});

        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        expect(legacy.operations).toEqual([]);
    });

    it('两个后台实例并发迁移时只采用一个完整快照', async () => {
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const originalHas = repository.has.bind(repository);
        let primaryChecks = 0;
        let releaseChecks!: () => void;
        const checksReady = new Promise<void>(resolve => { releaseChecks = resolve; });
        vi.spyOn(repository, 'has').mockImplementation(async key => {
            if (key === 'local:config' && primaryChecks < 2) {
                primaryChecks += 1;
                if (primaryChecks === 2) releaseChecks();
                await checksReady;
                return false;
            }
            return originalHas(key);
        });
        const firstLegacy = createLegacyHarness({
            'local:config': {snapshot: 'first'},
            'local:configHistory': {snapshot: 'first'},
        });
        const secondLegacy = createLegacyHarness({
            'local:config': {snapshot: 'second'},
            'local:configHistory': {snapshot: 'second'},
        });
        const first = createBackgroundConfigStorage({repository, legacy: firstLegacy.port});
        const second = createBackgroundConfigStorage({repository, legacy: secondLegacy.port});

        const [firstConfig, secondConfig] = await Promise.all([
            first.getItem<{snapshot: string}>('local:config'),
            second.getItem<{snapshot: string}>('local:config'),
        ]);
        const history = await repository.get<{snapshot: string}>('local:configHistory');
        expect(firstConfig?.snapshot).toMatch(/^(first|second)$/);
        expect(secondConfig?.snapshot).toBe(firstConfig?.snapshot);
        expect(history?.snapshot).toBe(firstConfig?.snapshot);
    });

    it('迁移摘要运行时不可用时不写数据库且保留旧配置', async () => {
        const legacy = createLegacyHarness({'local:config': {on: true}});
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const cryptoRuntime = globalThis.crypto;
        vi.stubGlobal('crypto', undefined);
        try {
            const storage = createBackgroundConfigStorage({repository, legacy: legacy.port});
            await expect(storage.getItem('local:config')).rejects.toThrow('不支持配置迁移校验');
            expect(await repository.database.records.count()).toBe(0);
            expect(legacy.values.get('local:config')).toEqual({on: true});
        } finally {
            vi.stubGlobal('crypto', cryptoRuntime);
        }
    });

    it('普通写入和删除只通知当前后台实例的订阅者', async () => {
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const storage = createBackgroundConfigStorage({repository, legacy: createLegacyHarness().port});
        const listener = vi.fn();
        const unsubscribe = storage.watch('local:config', listener);

        await storage.setItem('local:config', {on: true});
        await storage.setItem('local:config', {on: false});
        await storage.removeItem('local:config');

        // 非凭据键不需要旧值，写入前不再额外解密读取。
        expect(listener).toHaveBeenNthCalledWith(1, {on: true}, undefined);
        expect(listener).toHaveBeenNthCalledWith(2, {on: false}, undefined);
        expect(listener).toHaveBeenNthCalledWith(3, null, undefined);
        unsubscribe();
        await storage.setItem('local:config', {on: true});
        expect(listener).toHaveBeenCalledTimes(3);

        const credentialListener = vi.fn();
        storage.watch('local:credentials', credentialListener);
        await storage.setItem('local:credentials', {token: 'a'});
        await storage.removeItem('local:credentials');
        expect(credentialListener).toHaveBeenNthCalledWith(1, {token: 'a'}, null);
        expect(credentialListener).toHaveBeenNthCalledWith(2, null, {token: 'a'});
    });

    it('批量端口在一次提交后发布每个写入与删除键的最终值', async () => {
        const repository = new EncryptedConfigRepository({database: createDatabase()});
        const storage = createBackgroundConfigStorage({repository, legacy: createLegacyHarness().port});
        await storage.setItem('local:credentials', {token: 'old'});
        const configListener = vi.fn();
        const credentialListener = vi.fn();
        storage.watch('local:config', configListener);
        storage.watch('local:credentials', credentialListener);

        await storage.setItems!(new Map([
            ['local:config', {revision: 2}],
        ]));
        await storage.setItems!(new Map([
            ['local:config', {revision: 3}],
        ]), ['local:credentials', 'local:credentials', 'local:config']);

        await expect(storage.getItem('local:config')).resolves.toEqual({revision: 3});
        await expect(storage.getItem('local:credentials')).resolves.toBeNull();
        expect(configListener).toHaveBeenNthCalledWith(1, {revision: 2}, undefined);
        expect(configListener).toHaveBeenNthCalledWith(2, {revision: 3}, undefined);
        expect(credentialListener).toHaveBeenCalledWith(null, {token: 'old'});
    });

    it('会话材料 provider 只把随机材料留在 session storage，配置仍进入默认密文数据库', async () => {
        const legacy = createLegacyHarness({
            'local:config': {on: true},
            'session:credentials': {token: {openai: 'default-session-secret'}},
        });
        const repository = new EncryptedConfigRepository({
            getSessionKeyMaterial: createSessionKeyMaterialProvider(legacy.port),
        });
        const storage = createBackgroundConfigStorage({legacy: legacy.port, repository});

        await expect(storage.getItem('session:credentials')).resolves.toEqual({
            token: {openai: 'default-session-secret'},
        });
        const material = legacy.values.get(CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY);
        expect(material).toEqual(expect.any(String));
        expect(String(material).length).toBeGreaterThanOrEqual(32);
        expect(legacy.operations.filter(operation => operation === `set:${CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY}`))
            .toHaveLength(1);
        const raw = await repository.database.records.toArray();
        repository.database.close();
        expect(JSON.stringify(raw)).not.toContain('default-session-secret');
        expect(legacy.values.has('local:config')).toBe(false);
        expect(legacy.values.has('session:credentials')).toBe(false);
    });

    it('会话材料复用现有值，写入校验失败后可重新尝试', async () => {
        const validMaterial = btoa('x'.repeat(32));
        const existing = createLegacyHarness({
            [CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY]: validMaterial,
        });
        const readExisting = createSessionKeyMaterialProvider(existing.port);
        await expect(readExisting()).resolves.toBe(validMaterial);
        await expect(readExisting()).resolves.toBe(validMaterial);
        expect(existing.operations.filter(operation => operation.startsWith('set:'))).toHaveLength(0);

        const invalid = createLegacyHarness({
            [CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY]: 'not base64!',
        });
        const replaceInvalid = createSessionKeyMaterialProvider(invalid.port);
        await expect(replaceInvalid()).resolves.not.toBe('not base64!');
        expect(invalid.operations.filter(operation => operation.startsWith('set:'))).toHaveLength(1);

        let allowVerification = false;
        const failingValues = new Map<string, unknown>();
        const failingPort: LegacyConfigStoragePort = {
            async getItem<T>(key: string) {
                return allowVerification ? failingValues.get(key) as T : null;
            },
            setItem: vi.fn(async (key, value) => { failingValues.set(key, value); }),
            removeItem: vi.fn(),
        };
        const getMaterial = createSessionKeyMaterialProvider(failingPort);
        await expect(getMaterial()).rejects.toThrow('写入校验失败');
        allowVerification = true;
        await expect(getMaterial()).resolves.toEqual(expect.any(String));
        expect(failingPort.setItem).toHaveBeenCalledTimes(1);
    });

    it('Firefox MV2 缺少 storage.session 时只在持久后台页内存中保存会话材料', async () => {
        const unavailable: LegacyConfigStoragePort = {
            async getItem() { throw new Error('browser.storage.session is undefined'); },
            async setItem() { throw new Error('browser.storage.session is undefined'); },
            async removeItem() { return undefined; },
        };
        const warn = vi.fn();
        const getMemoryMaterial = createSessionKeyMaterialProvider(unavailable, {
            allowMemoryFallback: true,
            logger: {warn},
        });
        const first = await getMemoryMaterial();
        const second = await getMemoryMaterial();
        expect(first).toBe(second);
        expect(atob(first)).toHaveLength(32);
        expect(warn).toHaveBeenCalledTimes(1);

        let reads = 0;
        const writeUnavailable: LegacyConfigStoragePort = {
            async getItem() {
                reads += 1;
                return null;
            },
            async setItem() { throw new Error('session write unavailable'); },
            async removeItem() { return undefined; },
        };
        const fallbackAfterWrite = createSessionKeyMaterialProvider(writeUnavailable, {
            allowMemoryFallback: true,
            logger: {warn},
        });
        await expect(fallbackAfterWrite()).resolves.toEqual(expect.any(String));
        expect(reads).toBe(1);
        expect(warn).toHaveBeenCalledTimes(2);

        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const defaultLoggerFallback = createSessionKeyMaterialProvider(unavailable, {
                allowMemoryFallback: true,
            });
            await expect(defaultLoggerFallback()).resolves.toEqual(expect.any(String));
            expect(consoleWarn).toHaveBeenCalledWith(
                expect.stringContaining('storage.session 不可用'),
                expect.any(Error),
            );
        } finally {
            consoleWarn.mockRestore();
        }
    });
});

describe('远程配置 storage port', () => {
    it('通过后台读取快照，并在变更通知后重新拉取再触发 watch', async () => {
        const runtimeListeners: Array<(message: unknown) => void> = [];
        let current = {on: true};
        const sendMessage = vi.fn(async (message: unknown) => {
            expect(message).toEqual({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'});
            return {success: true, value: structuredClone(current)};
        });
        const storage = createRemoteConfigStorage({
            sendMessage,
            onMessage: {addListener: listener => runtimeListeners.push(listener)},
        });

        await expect(storage.getItem('local:config')).resolves.toEqual({on: true});
        const listener = vi.fn();
        const unsubscribe = storage.watch('local:config', listener);
        current = {on: false};
        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({on: false}, {on: true}));
        expect(sendMessage).toHaveBeenCalledTimes(2);

        unsubscribe();
        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        runtimeListeners[0]?.({type: 'unknown', key: 'local:config'});
        runtimeListeners[0]?.(null);
        runtimeListeners[0]?.([]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(sendMessage).toHaveBeenCalledTimes(2);
        await expect(storage.setItem('local:config', {})).rejects.toThrow('必须通过后台配置协议保存');
        await expect(storage.setItems!(new Map())).rejects.toThrow('必须通过后台配置协议批量保存');
        await expect(storage.removeItem('local:config')).rejects.toThrow('必须通过后台配置协议删除');
    });

    it('拒绝后台明确失败或缺失结果，并把 null 规范化为 null', async () => {
        const listeners: Array<(message: unknown) => void> = [];
        const failed = createRemoteConfigStorage({
            sendMessage: vi.fn()
                .mockResolvedValueOnce({success: false, error: 'read denied'})
                .mockResolvedValueOnce({success: false}),
            onMessage: {addListener: listener => listeners.push(listener)},
        });
        await expect(failed.getItem('local:config')).rejects.toThrow('read denied');
        await expect(failed.getItem('local:config')).rejects.toThrow('后台读取配置失败');

        const missing = createRemoteConfigStorage({
            sendMessage: vi.fn().mockResolvedValue(undefined),
            onMessage: {addListener: listener => listeners.push(listener)},
        });
        await expect(missing.getItem('local:config')).rejects.toThrow('没有返回结果');

        const empty = createRemoteConfigStorage({
            sendMessage: vi.fn().mockResolvedValue({success: true}),
            onMessage: {addListener: listener => listeners.push(listener)},
        });
        await expect(empty.getItem('local:config')).resolves.toBeNull();
    });

    it('变更后的重新拉取失败时只告警，不向订阅者发送伪快照', async () => {
        const runtimeListeners: Array<(message: unknown) => void> = [];
        const sendMessage = vi.fn()
            .mockResolvedValueOnce({success: true, value: {on: true}})
            .mockRejectedValueOnce(new Error('background stopped'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const storage = createRemoteConfigStorage({
            sendMessage,
            onMessage: {addListener: listener => runtimeListeners.push(listener)},
        });
        await storage.getItem('local:config');
        const listener = vi.fn();
        storage.watch('local:config', listener);
        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});

        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
            '[FluentRead] 配置变更同步失败',
            expect.objectContaining({message: 'background stopped'}),
        ));
        expect(listener).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('同一键的并发回读只发布最后发起的结果，旧响应晚到不会回滚', async () => {
        const runtimeListeners: Array<(message: unknown) => void> = [];
        const pending: Array<(value: unknown) => void> = [];
        const sendMessage = vi.fn()
            .mockResolvedValueOnce({success: true, value: {revision: 1}})
            .mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const storage = createRemoteConfigStorage({
            sendMessage,
            onMessage: {addListener: listener => runtimeListeners.push(listener)},
        });
        await storage.getItem('local:config');
        const listener = vi.fn();
        storage.watch('local:config', listener);

        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        pending[1]?.({success: true, value: {revision: 3}});
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({revision: 3}, {revision: 1}));
        pending[0]?.({success: true, value: {revision: 2}});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(listener).toHaveBeenCalledTimes(1);

        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        pending[2]?.({success: true, value: {revision: 4}});
        await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({revision: 4}, {revision: 3}));
    });

    it('变更回读被随后的显式读取取代时仍通知订阅者', async () => {
        const runtimeListeners: Array<(message: unknown) => void> = [];
        const pending: Array<(value: unknown) => void> = [];
        const sendMessage = vi.fn()
            .mockResolvedValueOnce({success: true, value: {revision: 1}})
            .mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const storage = createRemoteConfigStorage({
            sendMessage,
            onMessage: {addListener: listener => runtimeListeners.push(listener)},
        });
        await storage.getItem('local:config');
        const listener = vi.fn();
        storage.watch('local:config', listener);

        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        const explicitRead = storage.getItem<{revision: number}>('local:config');
        pending[1]?.({success: true, value: {revision: 3}});
        await expect(explicitRead).resolves.toEqual({revision: 3});
        pending[0]?.({success: true, value: {revision: 2}});
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith({revision: 3}, {revision: 1});
    });

    it('初始化旧读取先返回时仍等待变更回读，并把最新快照返回给原调用方', async () => {
        const runtimeListeners: Array<(message: unknown) => void> = [];
        const pending: Array<(value: unknown) => void> = [];
        const sendMessage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
        const storage = createRemoteConfigStorage({
            sendMessage,
            onMessage: {addListener: listener => runtimeListeners.push(listener)},
        });
        const listener = vi.fn();
        storage.watch('local:config', listener);

        const initialRead = storage.getItem<{revision: number}>('local:config');
        runtimeListeners[0]?.({type: CONFIG_STORAGE_CHANGED_MESSAGE, key: 'local:config'});
        pending[0]?.({success: true, value: {revision: 1}});
        let initialSettled = false;
        void initialRead.finally(() => { initialSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(initialSettled).toBe(false);

        pending[1]?.({success: true, value: {revision: 2}});
        await expect(initialRead).resolves.toEqual({revision: 2});
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({revision: 2}, undefined));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('准确区分 MV3 worker、Firefox MV2 background page、扩展页面和普通网页', () => {
        const names = ['location', 'document', 'window', 'browser'] as const;
        const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        const define = (name: typeof names[number], value: unknown) => {
            Object.defineProperty(globalThis, name, {configurable: true, value});
        };
        try {
            define('location', {protocol: 'https:'});
            expect(isBackgroundContext()).toBe(false);

            define('location', {protocol: 'chrome-extension:'});
            Reflect.deleteProperty(globalThis, 'document');
            expect(isBackgroundContext()).toBe(true);

            const backgroundWindow = {};
            define('location', {protocol: 'moz-extension:'});
            define('document', {});
            define('window', backgroundWindow);
            define('browser', {extension: {getBackgroundPage: () => backgroundWindow}});
            expect(isBackgroundContext()).toBe(true);

            define('window', {});
            expect(isBackgroundContext()).toBe(false);
            define('browser', {extension: {getBackgroundPage: () => { throw new Error('unavailable'); }}});
            expect(isBackgroundContext()).toBe(false);
            define('browser', {extension: {}});
            expect(isBackgroundContext()).toBe(false);
        } finally {
            for (const name of names) {
                const descriptor = originals.get(name);
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    });
});
