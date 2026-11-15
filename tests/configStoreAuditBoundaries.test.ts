/**
 * @file tests/configStoreAuditBoundaries.test.ts
 * 文件职责：验证真实配置 store、导入、diff 与 schema 的字段边界及保存时序。
 * 主要内容：区分导入显式凭据与完整草稿，覆盖成对凭据、权威回滚、广播、卸载、并发写入与深层预览。
 * 模块边界：直接导入生产模块和加密 IndexedDB repository，仅控制外部存储与消息端口，不复制业务规则，不使用真实账号。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {webcrypto} from 'node:crypto';
import {buildConfigDiff} from '@/src/core/config/diff';
import {isConfigImportValid, prepareConfigForImport} from '@/src/core/config/transfer';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {getStoredConfigRevision, parseStoredConfig} from '@/src/services/config/schema';
import {EncryptedConfigRepository, FluentReadConfigDatabase} from '@/src/platform/storage/configRepository';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {appendConfigHistorySnapshot, createBaselineConfigHistory, type ConfigHistoryState} from '@/src/services/config/history';
import {createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';

// Only the external storage port is controlled; store, domain rules and IndexedDB repository are real imports.
const configstoreAuditRuntime = vi.hoisted(() => ({port: null as ConfigStoragePort | null}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({
    configStorage: new Proxy({}, {get: (_target, key) => {
        const port = configstoreAuditRuntime.port!;
        const value = port[key as keyof ConfigStoragePort];
        return typeof value === 'function' ? value.bind(port) : value;
    }}),
}));

function configstoreAuditDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((a, b) => {resolve = a; reject = b;});
    return {promise, resolve, reject};
}

const configstoreAuditStores: Array<typeof import('@/src/services/config/store')> = [];
const configstoreAuditDatabases: FluentReadConfigDatabase[] = [];
const configstoreAuditCleanups: Array<() => void> = [];

async function configstoreAuditLoad(options: {
    owner?: boolean; trusted?: boolean; initial?: unknown; indexed?: boolean;
    credentialReadBarrier?: Promise<void>; failCredentialRead?: boolean;
    records?: Record<string, unknown>;
    configurePort?: (port: ConfigStoragePort, records: Map<string, unknown>, emit: (key: string, value: unknown) => void) => void;
    beforeReady?: (store: typeof import('@/src/services/config/store'), records: Map<string, unknown>) => void;
} = {}) {
    vi.resetModules();
    vi.stubGlobal('location', {protocol: options.trusted === false ? 'https:' : 'chrome-extension:'});
    vi.stubGlobal('crypto', webcrypto);
    const initial = normalizeConfig(options.initial ?? {to: 'en'});
    const records = new Map<string, unknown>([
        ['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 10}],
        ['local:credentials', extractConfigCredentials(initial)],
    ]);
    for (const [key, value] of Object.entries(options.records ?? {})) records.set(key, value);
    let repository: EncryptedConfigRepository | undefined;
    if (options.indexed) {
        const database = new FluentReadConfigDatabase(`configstoreAudit-${crypto.randomUUID()}`);
        configstoreAuditDatabases.push(database);
        repository = new EncryptedConfigRepository({database});
        await repository.commitChanges(records);
    }
    const watchers = new Map<string, Set<(value: unknown) => void>>();
    const port: ConfigStoragePort = {
        writeOwner: options.owner === true,
        getItem: vi.fn(async <T>(key: string) => {
            if (key === 'local:credentials') {
                await options.credentialReadBarrier;
                if (options.failCredentialRead) throw new Error('credentials unavailable');
            }
            return (repository ? await repository.get<T>(key) : records.get(key) ?? null) as T | null;
        }) as ConfigStoragePort['getItem'],
        setItem: vi.fn(async <T>(key: string, value: T) => {
            if (repository) await repository.set(key, value);
            else records.set(key, structuredClone(value));
        }),
        removeItem: vi.fn(async (key: string) => {
            if (repository) await repository.remove(key);
            else records.delete(key);
        }),
        setItems: vi.fn(async (entries: ReadonlyMap<string, unknown>, removals: readonly string[] = []) => {
            if (repository) await repository.commitChanges(entries, removals);
            else {
                for (const [key, value] of entries) records.set(key, structuredClone(value));
                for (const key of removals) records.delete(key);
            }
        }),
        watch: <T>(key: string, callback: (value: T | null) => void) => {
            const bucket = watchers.get(key) ?? new Set();
            const listener = callback as (value: unknown) => void;
            bucket.add(listener);
            watchers.set(key, bucket);
            return () => {bucket.delete(listener);};
        },
    };
    const emit = (key: string, value: unknown) => {
        records.set(key, value);
        for (const listener of watchers.get(key) ?? []) listener(value);
    };
    options.configurePort?.(port, records, emit);
    configstoreAuditRuntime.port = port;
    const store = await import('@/src/services/config/store');
    configstoreAuditStores.push(store);
    options.beforeReady?.(store, records);
    await store.configReady;
    return {store, port, records, repository, emit};
}

beforeEach(() => {vi.clearAllMocks();});
afterEach(async () => {
    for (const cleanup of configstoreAuditCleanups.splice(0)) cleanup();
    for (const store of configstoreAuditStores.splice(0)) {
        await store.waitForConfigPersistenceQueue().catch(() => undefined);
        await store.flushConfigHistory().catch(() => undefined);
    }
    for (const database of configstoreAuditDatabases.splice(0)) {database.close(); await database.delete();}
    configstoreAuditRuntime.port = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function configstoreAuditHistory(): ConfigHistoryState {
    let state = createBaselineConfigHistory({to: 'en'}, 10, '2026-10-05T00:00:00Z');
    for (const to of ['ja', 'fr']) state = appendConfigHistorySnapshot(state, {to}, '2026-10-05T00:00:01Z')!;
    return state;
}

describe('configstoreAudit storage owners, count replay and message authority', () => {
    it('restores cloud website rules through the real import, store and encrypted repository without losing content labels', async () => {
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true,
            initial: {token: {openai: 'fixture-local-key'}}});
        const siteAdaptation = normalizeConfig({siteAdaptation: {enabled: false, disabledRuleIds: ['reddit'], custom: {
            version: 1, rules: [{id: 'mine', name: 'My rule', match: {hosts: ['example.com']},
                content: [{css: ['article p'], key: 'article-body'}]}],
        }}}).siteAdaptation;
        const imported = prepareConfigForImport({...store.config, siteAdaptation}, store.config, {credentialMode: 'replace'});
        await store.saveConfig(imported, {recordHistory: true, immediateHistory: true});
        expect(store.config.siteAdaptation).toEqual(siteAdaptation);
        const stored = await repository!.get<Record<string, unknown>>('local:config');
        expect(stored!.siteAdaptation).toEqual(siteAdaptation);
        expect(stored).not.toHaveProperty('token');
        expect((await store.prepareHydratedConfigForExport()).siteAdaptation).toEqual(siteAdaptation);
        expect(store.config.token.openai).toBe('fixture-local-key');
    });
    it('consumes raw import ownership before JSON messaging and persists through the real background handler and IndexedDB', async () => {
        const service = 'aliyunTranslation';
        const initial = normalizeConfig({service, token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-secret'}, serviceRegion: {[service]: 'cn-hangzhou'}});
        const {store, repository, emit} = await configstoreAuditLoad({owner: true, indexed: true, initial});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({on: true, service, display: 1, from: 'auto', to: 'en', serviceRegion: {[service]: 'ap-southeast-1'}, token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-secret'}}, store.config);
        const handler = createConfigPersistenceHandler({ready: store.configReady, getCurrentConfig: () => store.config,
            prepareConfigSaveRequest: store.prepareConfigSaveRequest, prepareConfigPatchRequest: store.prepareConfigPatchRequest,
            saveConfig: store.saveConfig, getCurrentRevision: store.getConfigRevision, isExtensionUrl: url => url.startsWith('chrome-extension://configstore-audit/')});
        await store.requestConfigSave(imported, async message => {
            const wire = JSON.parse(JSON.stringify(message));
            expect(Object.keys(wire).sort()).toEqual(['baseRevision', 'clientId', 'config', 'sequence', 'type']);
            expect(message.config).not.toBe(imported);
            expect(Reflect.ownKeys(wire.config).sort()).toEqual(Object.keys(new Config()).sort());
            const response = await handler.handle(wire, {sender: {url: 'chrome-extension://configstore-audit/options.html'}});
            expect(await repository!.get('local:credentials')).toMatchObject({token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-secret'}});
            // 模拟提交前已发出、响应前迟到的凭据广播；JSON 消息中不存在意图元数据。
            emit('local:credentials', extractConfigCredentials({token: {[service]: 'fixture-late-id', openai: 'fixture-unrelated-new'}, secret: {[service]: 'fixture-late-secret'}}));
            return response;
        });
        expect(store.config.token[service]).toBe('fixture-id'); expect(store.config.secret[service]).toBe('fixture-secret');
        expect(store.config.token.openai).toBe('fixture-unrelated-new');
        expect((await repository!.get<Config>('local:config'))!.serviceRegion[service]).toBe('ap-southeast-1');
    });
    it('a newer external config invalidates an owner snapshot before its queued disk write', async () => {
        const {store, port, emit} = await configstoreAuditLoad({owner: true});
        const save = store.saveConfig({...store.config, to: 'ja'});
        queueMicrotask(() => emit('local:config', {...sanitizeConfigCredentials({...store.config, to: 'fr'}), __fluentConfigRevision: 12}));
        await save;
        expect(port.setItems).not.toHaveBeenCalled(); expect(store.config.to).toBe('fr');
        expect(store.getConfigRevision()).toBe(12);
        emit('local:config', null);
        emit('local:config', {...sanitizeConfigCredentials(store.config), __fluentConfigRevision: 11});
        expect(store.config.to).toBe('fr');
    });

    it('content owner fallback writes only public data through the actual repository', async () => {
        const {store, repository, port} = await configstoreAuditLoad({owner: true, trusted: false, indexed: true, initial: {token: {openai: 'fixture-private'}}});
        await store.saveConfig({...store.config, to: 'ja', token: {openai: 'fixture-rejected'}});
        const stored = await repository!.get<Record<string, unknown>>('local:config');
        expect(stored).toMatchObject({to: 'ja', __fluentConfigRevision: 11}); expect(stored).not.toHaveProperty('token');
        expect(await repository!.get('local:credentials')).toMatchObject({token: {openai: 'fixture-private'}});
        expect(port.setItems).not.toHaveBeenCalled();
    });

    it('credential watch registration failure does not block an otherwise safe public save', async () => {
        const {store} = await configstoreAuditLoad({configurePort: port => {
            const watch = port.watch;
            port.watch = (key, callback) => {if (key === 'local:credentials') throw new Error('watch unavailable'); return watch(key, callback);};
        }});
        await store.requestConfigSave({...store.config, to: 'ja'}, async () => ({success: true, revision: 11}));
        expect(store.config.to).toBe('ja');
    });

    it('invalid credential broadcasts clear private state without reading webpage credentials', async () => {
        const {store, emit} = await configstoreAuditLoad({initial: {token: {openai: 'fixture'}}});
        emit('local:credentials', null); expect(store.config.token).toEqual({});
    });

    it('public read failure installs safe defaults and blocks both local save modes', async () => {
        const {store} = await configstoreAuditLoad({owner: true, configurePort: port => {vi.mocked(port.getItem).mockRejectedValue(new Error('disk read unavailable'));}});
        expect(store.config.count).toBe(0);
        await expect(store.requestConfigSave()).rejects.toThrow('安全水合');
        await expect(store.requestConfigPatch({to: 'ja'})).rejects.toThrow('安全水合');
        await expect(store.prepareHydratedConfigForExport()).rejects.toThrow('安全水合');
    });

    it('local patch write failure re-reads committed authority and a later local patch retries successfully', async () => {
        const {store, port} = await configstoreAuditLoad({owner: true});
        vi.mocked(port.setItems!).mockRejectedValueOnce(new Error('atomic write failed'));
        await expect(store.requestConfigPatch({to: 'ja'})).rejects.toThrow('atomic write failed');
        expect(store.config.to).toBe('en');
        await store.requestConfigPatch({to: 'fr'}); expect(store.config.to).toBe('fr');
    });

    it('failed authority read with invalid stored data restores the last real committed config', async () => {
        const {store, records} = await configstoreAuditLoad();
        await expect(store.requestConfigPatch({to: 'ja'}, async () => {records.set('local:config', null); return {success: false};})).rejects.toThrow('后台保存配置失败');
        expect(store.config.to).toBe('en');
    });

    it('hydrates only valid count logs and adopts new count replay ownership from a storage broadcast', async () => {
        const record = {...sanitizeConfigCredentials(normalizeConfig({to: 'en', count: 5})), __fluentConfigRevision: 10,
            __fluentCountOperations: [null, 7, {id: 'short', delta: 1, count: 1}, {id: 'fixture-invalid', delta: 0, count: 1}, {id: 'fixture-retained', delta: 1, count: 5}, {id: 'fixture-future', delta: 1, count: 99}]};
        const {store, port, emit} = await configstoreAuditLoad({owner: true, records: {'local:config': record}});
        vi.mocked(port.setItem).mockClear();
        expect(await store.incrementConfigCount(1, 'fixture-retained')).toBe(5);
        emit('local:config', {...record, count: 8, __fluentConfigRevision: 11, __fluentCountOperations: [{id: 'fixture-broadcast', delta: 2, count: 8}]});
        expect(await store.incrementConfigCount(2, 'fixture-broadcast')).toBe(8);
        expect(port.setItem).not.toHaveBeenCalled();
    });
    it('continuous startup broadcasts preserve the newest count replay log after bounded initialization retries', async () => {
        let reads = 0;
        const {store, port} = await configstoreAuditLoad({owner: true, configurePort: (port, records, emit) => {
            const original = vi.mocked(port.getItem).getMockImplementation()!;
            vi.mocked(port.getItem).mockImplementation(async key => {
                if (key === 'local:credentials' && ++reads <= 2) {
                    const count = reads === 1 ? 5 : 8;
                    emit('local:config', {...records.get('local:config') as object, count, __fluentConfigRevision: 10 + reads,
                        __fluentCountOperations: [{id: 'fixture-startup-replay', delta: 2, count}]});
                }
                return original(key);
            });
        }});
        expect(reads).toBe(2); expect(store.config.count).toBe(8);
        vi.mocked(port.setItem).mockClear();
        expect(await store.incrementConfigCount(2, 'fixture-startup-replay')).toBe(8);
        expect(port.setItem).not.toHaveBeenCalled();
    });

    it('joins an active count operation and rejects a conflicting duplicate increment', async () => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port} = await configstoreAuditLoad({owner: true});
        const original = vi.mocked(port.setItem).getMockImplementation()!;
        vi.mocked(port.setItem).mockImplementationOnce(async (key, value) => {started.resolve(); await gate.promise; await original(key, value);});
        const first = store.incrementConfigCount(1, 'fixture-active-count'); await started.promise;
        const same = store.incrementConfigCount(1, 'fixture-active-count');
        await expect(store.incrementConfigCount(2, 'fixture-active-count')).rejects.toThrow('增量不一致');
        gate.resolve(); expect(await first).toBe(1); expect(await same).toBe(1);
        expect(port.setItem).toHaveBeenCalledTimes(1);
        expect(await store.incrementConfigCount(1)).toBe(2);
    });

    it('rechecks a mismatched completed count operation after hydration', async () => {
        const record = {...sanitizeConfigCredentials(normalizeConfig({count: 1})), __fluentConfigRevision: 10, __fluentCountOperations: [{id: 'fixture-completed', delta: 1, count: 1}]};
        let pending!: Promise<unknown>;
        const gate = configstoreAuditDeferred<void>(); configstoreAuditCleanups.push(() => gate.resolve());
        const {store} = await configstoreAuditLoad({owner: true, records: {'local:config': record}, configurePort: port => {
            const original = vi.mocked(port.getItem).getMockImplementation()!;
            vi.mocked(port.getItem).mockImplementationOnce(async key => {await gate.promise; return original(key);});
        }, beforeReady: store => {pending = store.incrementConfigCount(2, 'fixture-completed').catch(error => error); gate.resolve();}});
        expect(await pending).toBeInstanceOf(Error); expect(store.config.count).toBe(1);
    });

    it('validates count identifiers and current numeric state through the public APIs', async () => {
        const {store} = await configstoreAuditLoad({owner: true});
        await expect(store.incrementConfigCount(1, 'bad')).rejects.toThrow('操作标识');
        await expect(store.requestConfigCountIncrement(1, undefined, 'bad')).rejects.toThrow('操作标识');
        await expect(store.requestConfigCountIncrement(1, async () => ({success: false}), 'fixture-count-error')).rejects.toThrow('翻译计数保存失败');
        expect(await store.requestConfigCountIncrement(1, undefined, 'fixture-count-local')).toBe(1);
        store.config.count = -1;
        await expect(store.incrementConfigCount(1)).rejects.toThrow('非负安全整数');
    });

    it('compares patch containers and lengths, rejects missing expectations, and filters invalid/protected inputs', async () => {
        const {store} = await configstoreAuditLoad();
        expect(store.prepareConfigPatchRequest(null, null).to).toBe('en');
        expect(store.prepareConfigPatchRequest({unknown: true, count: 99}, null).count).toBe(0);
        await store.requestConfigPatch([]); await store.requestConfigPatch({unknown: true});
        for (const [current, expected] of [[{a: []}, {a: {}}], [{a: [1]}, {a: [1, 2]}], [{a: 1}, {b: 1}]]) {
            expect(() => store.prepareConfigPatchRequest({extra: {a: 2}}, {extra: expected}, {...store.config, extra: current}, true)).toThrow('配置字段已更新');
        }
        expect(() => store.prepareConfigPatchRequest({to: 'ja'}, null)).toThrow('配置字段已更新');
    });

    it('legacy token synchronization rejects non-string entries, keeps multi-key lists and accepts explicit clearing', async () => {
        const {store} = await configstoreAuditLoad();
        const snapshot = store.prepareConfigSaveRequest({...store.config, token: {openai: 7, deepseek: 'fixture', gemini: ''}, apiKeys: {openai: ['fixture-a', 'fixture-b'], deepseek: ['fixture-one', 'fixture-two']}}, store.config, true);
        expect(snapshot.apiKeys.openai).toEqual(['fixture-a', 'fixture-b']);
        expect(snapshot.apiKeys.deepseek).toHaveLength(2); expect(snapshot.token.gemini).toBeUndefined();
    });

    it('route changes remove an unchanged custom request header from an ordinary full draft', async () => {
        const service = 'custom:configstore-audit';
        const {store} = await configstoreAuditLoad({initial: {
            customOpenAIProviders: [{id: service, name: 'Audit', endpoint: 'https://configstore-audit.invalid/old', models: ['fixture-model']}],
            customHeaders: {[service]: '{"Authorization":"fixture"}'},
        }});
        expect(store.config.customHeaders[service]).toBe('{"Authorization":"fixture"}');
        const next = store.prepareConfigPatchRequest({proxy: {[service]: 'https://configstore-audit.invalid/new'}}, {proxy: store.config.proxy}, store.config, true);
        expect(next.customHeaders[service]).toBeUndefined();
    });

    it('clears all canonical key lists for a raw empty legacy token patch through the actual owner and IndexedDB', async () => {
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true,
            initial: {apiKeys: {openai: ['fixture-one', 'fixture-two'], deepseek: ['fixture-other']}}});
        await store.requestConfigPatch({token: {}});
        expect(store.config.token).toEqual({}); expect(store.config.apiKeys).toEqual({});
        expect(await repository!.get('local:credentials')).toMatchObject({token: {}, apiKeys: {}});
    });

    it('clears one service via a raw legacy blank token without erasing unrelated canonical key lists', async () => {
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true,
            initial: {apiKeys: {openai: ['fixture-one', 'fixture-two'], deepseek: ['fixture-other']}}});
        // token 是完整服务映射；沿原有 API 携带未修改服务，不能假设嵌套字段自动合并。
        await store.requestConfigPatch({token: {...store.config.token, openai: ''}});
        expect(store.config.token.openai).toBeUndefined();
        expect(store.config.apiKeys.openai).toEqual([]);
        expect(store.config.apiKeys.deepseek).toEqual(['fixture-other']);
        expect(await repository!.get('local:credentials')).toMatchObject({apiKeys: {openai: [], deepseek: ['fixture-other']}});
    });

    it.each(['token', 'apiKeys'] as const)('does not promote an inherited %s field into legacy credential intent', async inherited => {
        const {store} = await configstoreAuditLoad();
        const payload = Object.assign(Object.create(inherited === 'token'
            ? {token: {}}
            : {apiKeys: {openai: ['fixture-inherited-one', 'fixture-inherited-two']}}), {
            on: true, service: 'openai', display: 1, from: 'auto', to: 'en',
            ...(inherited === 'token' ? {apiKeys: {openai: ['fixture-explicit']}} : {token: {openai: 'fixture-explicit'}}),
        });
        const prepared = store.prepareConfigSaveRequest(payload, store.config, true);
        expect(prepared.token.openai).toBe('fixture-explicit');
        expect(prepared.apiKeys.openai).toEqual(['fixture-explicit']);
    });

    it.each(['non-error', 'other-error', 'backend-failure'] as const)('does not run a local history fallback for %s', async kind => {
        const {store, port} = await configstoreAuditLoad({owner: true});
        const sender = async () => {
            if (kind === 'non-error') throw 'history rejected';
            if (kind === 'other-error') throw new Error('history channel failed');
            return {success: false};
        };
        await expect(store.requestConfigHistoryAction('undo', undefined, sender)).rejects.toBeDefined();
        expect(port.setItem).not.toHaveBeenCalled();
    });

    it.each(['missing', 'fractional', 'negative'] as const)('rejects a %s message revision and restores patch authority', async kind => {
        const {store} = await configstoreAuditLoad();
        const revision = kind === 'missing' ? undefined : kind === 'fractional' ? 1.5 : -1;
        await expect(store.requestConfigPatch({to: 'ja'}, async () => ({success: true, revision}))).rejects.toThrow('有效 revision');
        expect(store.config.to).toBe('en');
    });

    it.each(['throw', 'bad-revision'] as const)('consumes a deferred external config after a replaced snapshot %s', async kind => {
        const {store, emit} = await configstoreAuditLoad();
        await expect(store.requestConfigSave({...store.config, to: 'ja'}, async () => {
            emit('local:config', {...sanitizeConfigCredentials({...store.config, to: 'fr'}), __fluentConfigRevision: 12});
            if (kind === 'throw') throw new Error('transport offline');
            return {success: true};
        })).rejects.toBeInstanceOf(Error);
        expect(store.config.to).toBe('fr'); expect(store.getConfigRevision()).toBe(12);
    });

    it('a queue barrier follows a later request enqueued before its predecessor settles', async () => {
        const firstGate = configstoreAuditDeferred<void>(), secondGate = configstoreAuditDeferred<void>();
        const firstStarted = configstoreAuditDeferred<void>(), secondStarted = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => {firstGate.resolve(); secondGate.resolve();});
        const {store, records} = await configstoreAuditLoad(); let count = 0;
        const sender = async (message: Parameters<NonNullable<Parameters<typeof store.requestConfigPatch>[1]>>[0]) => {
            count += 1; const revision = 10 + count;
            if (count === 1) {firstStarted.resolve(); await firstGate.promise;} else {secondStarted.resolve(); await secondGate.promise;}
            const canonical = store.prepareConfigPatchRequest(message.config, message.expected, records.get('local:config'), false);
            records.set('local:config', {...sanitizeConfigCredentials(canonical), __fluentConfigRevision: revision});
            return {success: true, revision};
        };
        const first = store.requestConfigPatch({to: 'ja'}, sender); await firstStarted.promise;
        let finished = false; const barrier = store.waitForConfigPersistenceQueue().then(() => {finished = true;});
        await Promise.resolve();
        const second = store.requestConfigPatch({theme: 'dark'}, sender);
        firstGate.resolve(); await secondStarted.promise; expect(finished).toBe(false);
        secondGate.resolve(); await Promise.all([first, second, barrier]); expect(finished).toBe(true);
    });

    it.each([false, true])('rejects a replaced snapshot invalidated by a concurrent local failure (read fails=%s)', async readFails => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port, records} = await configstoreAuditLoad();
        const remote = store.requestConfigSave({...store.config, to: 'ja'}, async message => {
            started.resolve(); await gate.promise;
            records.set('local:config', {...sanitizeConfigCredentials(message.config), __fluentConfigRevision: 11});
            if (readFails) vi.mocked(port.getItem).mockRejectedValueOnce(new Error('response read unavailable'));
            return {success: true, revision: 11};
        }).catch(error => error);
        await started.promise;
        await expect(store.requestConfigPatch({theme: 'dark'})).rejects.toThrow('后台配置协议');
        gate.resolve(); expect(await remote).toBeInstanceOf(Error);
    });

    it.each([0, 11])('content message confirmation reconstructs public authority at revision %s', async revision => {
        const {store, records} = await configstoreAuditLoad({trusted: false});
        await store.requestConfigPatch({to: 'ja'}, async message => {
            records.set('local:config', revision === 0 ? null : {...sanitizeConfigCredentials({...store.config, ...message.config}), __fluentConfigRevision: revision});
            return {success: true, revision};
        });
        if (revision !== 0) expect(store.config.to).toBe('ja');
        expect(store.config.token).toEqual({});
    });

    it('content success with a stale public read preserves only the confirmed public patch', async () => {
        const {store} = await configstoreAuditLoad({trusted: false});
        await store.requestConfigPatch({to: 'ja'}, async () => ({success: true, revision: 11}));
        expect(store.config.to).toBe('ja'); expect(store.config.token).toEqual({});
    });

    it('a successful patch with a missing stored snapshot uses its confirmed baseline and retains unrelated credentials', async () => {
        const {store, records} = await configstoreAuditLoad({initial: {theme: 'dark', token: {openai: 'fixture-retained'}}});
        await store.requestConfigPatch({to: 'ja'}, async () => {
            records.set('local:config', null);
            return {success: true, revision: 11};
        });
        expect(store.config.to).toBe('ja'); expect(store.config.theme).toBe('dark');
        expect(store.config.token.openai).toBe('fixture-retained'); expect(store.getConfigRevision()).toBe(11);
    });

    it('response read completion consumes the newest external config that arrived during the read', async () => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port, records, emit} = await configstoreAuditLoad();
        const original = vi.mocked(port.getItem).getMockImplementation()!;
        const request = store.requestConfigPatch({to: 'ja'}, async message => {
            const stored = {...sanitizeConfigCredentials({...store.config, ...message.config}), __fluentConfigRevision: 11}; records.set('local:config', stored);
            vi.mocked(port.getItem).mockImplementationOnce(async key => {started.resolve(); await gate.promise; return original(key);});
            return {success: true, revision: 11};
        }).catch(error => error);
        await started.promise;
        emit('local:config', {...sanitizeConfigCredentials({...store.config, to: 'fr'}), __fluentConfigRevision: 12});
        gate.resolve(); expect(await request).toBeInstanceOf(Error); expect(store.config.to).toBe('fr');
    });

    it('a patch submitted before hydration waits for the actual public config baseline', async () => {
        const gate = configstoreAuditDeferred<void>(); configstoreAuditCleanups.push(() => gate.resolve());
        let pending!: Promise<void>;
        const {store} = await configstoreAuditLoad({owner: true, credentialReadBarrier: gate.promise, beforeReady: store => {pending = store.requestConfigPatch({to: 'ja'}); gate.resolve();}});
        await pending; expect(store.config.to).toBe('ja');
    });

    it('content initialization re-reads after both bounded first reads lose to newer broadcasts', async () => {
        let reads = 0;
        const {store} = await configstoreAuditLoad({trusted: false, configurePort: (port, records, emit) => {
            const original = vi.mocked(port.getItem).getMockImplementation()!;
            vi.mocked(port.getItem).mockImplementation(async key => {
                reads += 1;
                if (reads > 2) return original(key);
                const stale = structuredClone(records.get(key));
                emit('local:config', {...sanitizeConfigCredentials(normalizeConfig({to: reads === 1 ? 'ja' : 'fr'})), __fluentConfigRevision: 10 + reads});
                return stale as never;
            });
        }});
        expect(reads).toBe(3); expect(store.config.to).toBe('fr'); expect(store.getConfigRevision()).toBe(12);
    });

    it('an exhausted revision fails before writing an unsafe owner checkpoint', async () => {
        const record = {...sanitizeConfigCredentials(normalizeConfig({to: 'en'})), __fluentConfigRevision: Number.MAX_SAFE_INTEGER};
        const {store, port, records} = await configstoreAuditLoad({owner: true, records: {'local:config': record}});
        await expect(store.saveConfig({...store.config, to: 'ja'})).rejects.toThrow('revision');
        expect(port.setItems).not.toHaveBeenCalled();
        expect((records.get('local:config') as Record<string, unknown>).__fluentConfigRevision).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('an exhausted migration revision keeps the legacy record and blocks destructive later writes', async () => {
        const record = {...sanitizeConfigCredentials(normalizeConfig({to: 'en'})), persistCredentials: false, __fluentConfigRevision: Number.MAX_SAFE_INTEGER};
        const {store, port, records} = await configstoreAuditLoad({owner: true, records: {'local:config': record}});
        expect(port.setItem).not.toHaveBeenCalled();
        expect(records.get('local:config')).toMatchObject({persistCredentials: false, __fluentConfigRevision: Number.MAX_SAFE_INTEGER});
        await expect(store.requestConfigSave()).rejects.toThrow('安全水合');
    });
});

describe('configstoreAudit lazy history and persistence recovery', () => {
    it.each([false, true])('keeps the watched newer lazy-history cursor over a late read (reject=%s)', async reject => {
        const stale = configstoreAuditHistory(), latest = {...stale, cursor: 0};
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, emit} = await configstoreAuditLoad({configurePort: port => {
            const original = vi.mocked(port.getItem).getMockImplementation()!;
            vi.mocked(port.getItem).mockImplementation(async key => {
                if (key !== 'local:configHistory') return original(key);
                started.resolve(); await gate.promise;
                if (reject) throw new Error('late history read failed');
                return stale as never;
            });
        }});
        const ready = Promise.resolve(store.configHistoryReady);
        await started.promise;
        emit('local:configHistory', latest);
        gate.resolve(); await ready;
        expect(store.getConfigHistorySnapshot().cursor).toBe(0);
    });

    it('falls back after an ordinary lazy history read failure and installs the real baseline', async () => {
        const {store, port} = await configstoreAuditLoad();
        vi.mocked(port.getItem).mockRejectedValueOnce(new Error('history unavailable'));
        await store.configHistoryReady;
        expect(store.getConfigHistorySnapshot()).toMatchObject({cursor: 0, entries: [{version: 10, config: {to: 'en'}}]});
    });

    it.each([false, true])('migrates obsolete history projection without losing its cursor (write fails=%s)', async fails => {
        const raw = configstoreAuditHistory();
        Object.assign(raw.entries[0].config, {count: 9, uiLanguageSetupCompleted: true});
        const {store, port, records} = await configstoreAuditLoad({owner: true, records: {'local:configHistory': raw}, configurePort: (port, records) => {
            port.setItemIfUnchanged = vi.fn(async (key, expected, value) => {
                if (fails) throw new Error('projection write unavailable');
                if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return false;
                records.set(key, structuredClone(value));
                return true;
            });
        }});
        await store.configHistoryReady;
        expect(store.getConfigHistorySnapshot().cursor).toBe(2);
        expect(store.getConfigHistorySnapshot().entries[0].config).not.toHaveProperty('count');
        expect(port.setItemIfUnchanged).toHaveBeenCalledWith('local:configHistory', raw, expect.any(Object));
        expect(port.setItem).not.toHaveBeenCalled();
        if (!fails) expect((records.get('local:configHistory') as ConfigHistoryState).entries[0].config).not.toHaveProperty('count');
    });

    it('keeps obsolete history migration in memory on get/set-only ports until an explicit history action', async () => {
        const raw = configstoreAuditHistory();
        Object.assign(raw.entries[0].config, {count: 9});
        const {store, port, records} = await configstoreAuditLoad({owner: true, records: {'local:configHistory': raw}});
        await store.configHistoryReady;
        expect(store.getConfigHistorySnapshot().entries[0].config).not.toHaveProperty('count');
        expect(port.setItem).not.toHaveBeenCalled();
        expect(records.get('local:configHistory')).toEqual(raw);
        await store.applyConfigHistoryAction('undo');
        expect(port.setItem).toHaveBeenCalledOnce();
        expect((records.get('local:configHistory') as ConfigHistoryState).entries[0].config).not.toHaveProperty('count');
    });

    it.each([false, true])('history projection migration preserves a concurrent external commit (watch=%s)', async notify => {
        const raw = configstoreAuditHistory();
        Object.assign(raw.entries[0].config, {count: 9});
        const latest = appendConfigHistorySnapshot(raw, {to: 'ko'}, '2026-10-25T01:00:00Z')!;
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, records, emit} = await configstoreAuditLoad({owner: true, records: {'local:configHistory': raw}, configurePort: (port, records) => {
            port.setItem = vi.fn(async (key, value) => {
                started.resolve(); await gate.promise; records.set(key, structuredClone(value));
            });
            port.setItemIfUnchanged = vi.fn(async (key, expected, value) => {
                started.resolve(); await gate.promise;
                if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return false;
                records.set(key, structuredClone(value));
                return true;
            });
        }});
        const ready = Promise.resolve(store.configHistoryReady);
        await started.promise;
        if (notify) emit('local:configHistory', latest);
        else records.set('local:configHistory', latest);
        gate.resolve(); await ready;
        expect(records.get('local:configHistory')).toEqual(latest);
        expect(store.getConfigHistorySnapshot()).toEqual(latest);
    });

    it('a failed history migration reread cannot overwrite a newer watch update', async () => {
        const raw = configstoreAuditHistory();
        Object.assign(raw.entries[0].config, {count: 9});
        const latest = appendConfigHistorySnapshot(raw, {to: 'ko'}, '2026-10-25T01:00:00Z')!;
        const newer = appendConfigHistorySnapshot(latest, {to: 'de'}, '2026-10-25T02:00:00Z')!;
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, emit} = await configstoreAuditLoad({owner: true, records: {'local:configHistory': raw}, configurePort: (port, records) => {
            const original = vi.mocked(port.getItem).getMockImplementation()!;
            let reads = 0;
            vi.mocked(port.getItem).mockImplementation(async key => {
                if (key !== 'local:configHistory' || ++reads === 1) return original(key);
                const snapshot = structuredClone(records.get(key));
                started.resolve(); await gate.promise;
                return snapshot as never;
            });
            port.setItemIfUnchanged = vi.fn(async key => {
                records.set(key, latest);
                return false;
            });
        }});
        const ready = Promise.resolve(store.configHistoryReady);
        await started.promise;
        emit('local:configHistory', newer);
        gate.resolve(); await ready;
        expect(store.getConfigHistorySnapshot()).toEqual(newer);
    });

    it('ignores invalid, duplicate and stale external history while a real cursor write is pending', async () => {
        const history = configstoreAuditHistory();
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port, records, emit} = await configstoreAuditLoad({owner: true, initial: {to: 'fr'}, records: {'local:configHistory': history}});
        await store.configHistoryReady;
        const listener = vi.fn(); configstoreAuditCleanups.push(store.subscribeConfigHistory(listener));
        emit('local:configHistory', null); emit('local:configHistory', history);
        expect(listener).toHaveBeenCalledTimes(1);
        vi.mocked(port.setItem).mockImplementationOnce(async (key, value) => {
            started.resolve(); await gate.promise; records.set(key, structuredClone(value));
        });
        const undo = store.applyConfigHistoryAction('undo'); await started.promise;
        emit('local:configHistory', {...history, cursor: 0});
        expect(store.getConfigHistorySnapshot().cursor).toBe(2);
        gate.resolve(); await undo;
        expect(store.getConfigHistorySnapshot().cursor).toBe(1);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('duplicate cursor changes both await the same history write and reject its failure', async () => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port} = await configstoreAuditLoad({owner: true, initial: {to: 'fr'}, records: {'local:configHistory': configstoreAuditHistory()}});
        await store.configHistoryReady;
        vi.mocked(port.setItem).mockImplementationOnce(async () => {started.resolve(); await gate.promise; throw new Error('history disk failed');});
        const first = store.applyConfigHistoryAction('undo').catch(error => error);
        await started.promise;
        let finished = false;
        const second = store.applyConfigHistoryAction('undo').then(value => {finished = true; return value;}, error => {finished = true; return error;});
        await new Promise(resolve => setImmediate(resolve));
        expect(finished).toBe(false);
        gate.resolve();
        expect(await first).toBeInstanceOf(Error); expect(await second).toBeInstanceOf(Error);
        await store.applyConfigHistoryAction('undo');
        expect(store.getConfigHistorySnapshot().cursor).toBe(1);
    });

    it('newer cursor writes supersede an in-flight old history write without rolling back the cursor', async () => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port, records} = await configstoreAuditLoad({owner: true, initial: {to: 'fr'}, records: {'local:configHistory': configstoreAuditHistory()}});
        await store.configHistoryReady;
        const original = vi.mocked(port.setItem).getMockImplementation()!;
        vi.mocked(port.setItem).mockImplementationOnce(async (key, value) => {started.resolve(); await gate.promise; await original(key, value);});
        const old = store.applyConfigHistoryAction('undo'); await started.promise;
        const next = store.applyConfigHistoryAction('restore', 10);
        await new Promise(resolve => setImmediate(resolve));
        gate.resolve(); await Promise.all([old, next]);
        const final = store.getConfigHistorySnapshot();
        expect(final.entries[final.cursor].config.to).toBe('en');
        expect((records.get('local:configHistory') as ConfigHistoryState).entries.at(-1)?.config.to).toBe('en');
    });

    it('coalesces concurrent restores before old history disk work starts', async () => {
        const {store, records} = await configstoreAuditLoad({owner: true, initial: {to: 'fr'}, records: {'local:configHistory': configstoreAuditHistory()}});
        await store.configHistoryReady;
        await Promise.all([store.applyConfigHistoryAction('restore', 10), store.applyConfigHistoryAction('restore', 11)]);
        expect((records.get('local:configHistory') as ConfigHistoryState).entries.at(-1)?.config.to).toBe('ja');
    });

    it('same-content cursor races drop an obsolete history queue entry before the disk starts', async () => {
        const history = configstoreAuditHistory();
        for (const entry of history.entries) entry.config = history.entries[0].config;
        const {store, port} = await configstoreAuditLoad({owner: true, records: {'local:configHistory': history}});
        await store.configHistoryReady;
        await Promise.all([store.applyConfigHistoryAction('undo'), store.applyConfigHistoryAction('restore', 10)]);
        expect(store.getConfigHistorySnapshot().cursor).toBe(2);
        expect(vi.mocked(port.setItem).mock.calls.filter(([key]) => key === 'local:configHistory')).toHaveLength(1);
    });

    it('deduplicates equal restored snapshots and keeps no-op history operations stable', async () => {
        const history = configstoreAuditHistory(); history.entries[0].config = history.entries[2].config;
        const {store, port} = await configstoreAuditLoad({owner: true, initial: {to: 'fr'}, records: {'local:configHistory': history}});
        await store.configHistoryReady;
        await store.applyConfigHistoryAction('redo');
        await store.requestConfigHistoryAction('restore');
        await store.applyConfigHistoryAction('restore', 10);
        expect(vi.mocked(port.setItem).mock.calls.filter(([key]) => key === 'local:configHistory')).toHaveLength(0);
        expect(store.getConfigHistorySnapshot().cursor).toBe(2);
    });

    it('debounces actual history writes and emits only the final saved configuration', async () => {
        const {store, records} = await configstoreAuditLoad({owner: true});
        await store.configHistoryReady; vi.useFakeTimers();
        await store.saveConfig({...store.config, to: 'ja'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(200);
        await store.saveConfig({...store.config, to: 'fr'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(349);
        expect(records.has('local:configHistory')).toBe(false);
        await vi.advanceTimersByTimeAsync(1); await store.flushConfigHistory();
        expect(store.getConfigHistorySnapshot().entries.map(entry => entry.config.to)).toEqual(['en', 'fr']);
    });

    it('flush waits through a history append queued by a later debounce timer', async () => {
        const firstGate = configstoreAuditDeferred<void>(), secondGate = configstoreAuditDeferred<void>();
        const firstStarted = configstoreAuditDeferred<void>(), secondStarted = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => {firstGate.resolve(); secondGate.resolve();});
        const {store, port} = await configstoreAuditLoad({owner: true});
        await store.configHistoryReady; vi.useFakeTimers();
        const original = vi.mocked(port.setItem).getMockImplementation()!;
        vi.mocked(port.setItem)
            .mockImplementationOnce(async (key, value) => {firstStarted.resolve(); await firstGate.promise; await original(key, value);})
            .mockImplementationOnce(async (key, value) => {secondStarted.resolve(); await secondGate.promise; await original(key, value);});
        await store.saveConfig({...store.config, to: 'ja'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(350); await firstStarted.promise;
        let finished = false; const flush = store.flushConfigHistory().then(() => {finished = true;});
        await store.saveConfig({...store.config, to: 'fr'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(350);
        firstGate.resolve(); await secondStarted.promise; expect(finished).toBe(false);
        secondGate.resolve(); await flush;
        expect(store.getConfigHistorySnapshot().entries.map(entry => entry.config.to)).toEqual(['en', 'ja', 'fr']);
    });

    it('a failed debounce append does not poison a queued newer append or a later immediate save', async () => {
        const gate = configstoreAuditDeferred<void>(), started = configstoreAuditDeferred<void>();
        configstoreAuditCleanups.push(() => gate.resolve());
        const {store, port} = await configstoreAuditLoad({owner: true});
        await store.configHistoryReady; vi.useFakeTimers();
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        configstoreAuditCleanups.push(() => errorLog.mockRestore());
        vi.mocked(port.setItem).mockImplementationOnce(async () => {started.resolve(); await gate.promise; throw new Error('debounce disk failed');});
        await store.saveConfig({...store.config, to: 'ja'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(350); await started.promise;
        await store.saveConfig({...store.config, to: 'fr'}, {recordHistory: true});
        await vi.advanceTimersByTimeAsync(350); gate.resolve();
        await store.flushConfigHistory();
        expect(errorLog).toHaveBeenCalledWith('[FluentRead] 配置历史保存失败', expect.any(Error));
        expect(store.getConfigHistorySnapshot().entries.map(entry => entry.config.to)).toEqual(['en', 'fr']);
        await store.saveConfig({...store.config, to: 'de'}, {recordHistory: true, immediateHistory: true});
        expect(store.getConfigHistorySnapshot().entries.at(-1)?.config.to).toBe('de');
    });
});

describe('configstoreAudit own-key and preview boundaries', () => {
    it('requires own import and stored-config fields and an own revision', () => {
        const inherited = Object.create({on: true, service: 'openai', display: 1, from: 'auto', to: 'en', __fluentConfigRevision: 999});
        expect(isConfigImportValid(inherited)).toBe(false);
        expect(parseStoredConfig(inherited)).toBeNull();
        expect(getStoredConfigRevision(inherited)).toBe(0);
        const own = Object.assign(Object.create(null), {on: true, service: 'openai', display: 1, from: 'auto', to: 'en'});
        expect(isConfigImportValid(own)).toBe(true);
        expect(parseStoredConfig(JSON.stringify(own))).toEqual(own);
    });

    it('does not accept a modern custom service solely supplied by an inherited provider list', () => {
        const payload = Object.assign(Object.create({customOpenAIProviders: [{id: 'custom:borrowed', name: 'Borrowed', endpoint: 'https://fixture.invalid/', models: ['fixture-model']}]}), {
            on: true, service: 'custom:borrowed', display: 1, from: 'auto', to: 'en',
        });
        expect(isConfigImportValid(payload)).toBe(false);
    });

    it('previews own prototype-named fields and ignores inherited mapping values', () => {
        const target = JSON.parse('{"constructor":"custom-value","toString":"literal-value","__proto__":{"public":"safe"}}');
        const diff = buildConfigDiff({}, target);
        expect(diff.changeCount).toBe(3);
        expect(diff.groups[0].id).toBe('other');
        expect(diff.groups[0].changes.every(item => item.before === '未设置')).toBe(true);
        const mapping = buildConfigDiff({model: Object.create({openai: 'inherited-model'})}, {model: {openai: 'actual-model'}});
        expect(mapping.groups[0].changes[0].before).toBe('未设置');
        expect(JSON.stringify(mapping)).not.toContain('inherited-model');
    });

    it('reads repeated references as public values while redacting true cycles and nested secrets', () => {
        const shared = {label: 'public'};
        const cyclic: Record<string, unknown> = {visible: 'safe', apiToken: 'fixture-private'};
        cyclic.self = cyclic;
        const diff = buildConfigDiff({}, {shared: {left: shared, right: shared}, cyclic});
        const text = JSON.stringify(diff);
        expect(text).not.toContain('fixture-private');
        expect(diff.groups[0].changes.find(item => item.key === 'shared')!.after).not.toContain('循环引用');
        expect(diff.groups[0].changes.find(item => item.key === 'cyclic')!.after).toContain('循环引用');
    });

    it('compares 12000-level public input without recursion and bounds visible depth', () => {
        const nested = (leaf: string) => {
            let value: Record<string, unknown> = {leaf};
            for (let index = 0; index < 12_000; index += 1) value = {child: value};
            return value;
        };
        const before = nested('before'), after = nested('after');
        expect(buildConfigDiff({deepPublic: before}, {deepPublic: before}).changeCount).toBe(0);
        const diff = buildConfigDiff({deepPublic: before}, {deepPublic: after});
        expect(diff.changeCount).toBe(1);
        expect(diff.groups[0].changes[0].after).toContain('已配置（内容已摘要）');
        expect(JSON.stringify(diff).length).toBeLessThan(5000);
        const mapping = buildConfigDiff({model: {openai: before}}, {model: {openai: after}});
        expect(mapping.groups[0].changes).toEqual([{key: 'model.openai', label: 'OpenAI模型',
            before: '已配置（内容已摘要）', after: '已配置（内容已摘要）'}]);
        expect(JSON.stringify(mapping).length).toBeLessThan(5000);
    });

    it('formats only the four visible array entries', () => {
        let calls = 0;
        const entries = Array.from({length: 1000}, (_, index) => index < 4 ? `visible-${index}` : {toString: (): string => {calls += 1; return 'hidden';}});
        const diff = buildConfigDiff({}, {publicList: entries});
        expect(diff.groups[0].changes[0].after).toContain('1000 项：visible-0、visible-1、visible-2、visible-3 等');
        expect(calls).toBe(0);
    });

    it('compares cyclic structures, shape differences, own-key differences and JSON array holes safely', () => {
        const a: Record<string, unknown> = {}, b: Record<string, unknown> = {};
        a.self = a; b.self = b;
        expect(buildConfigDiff({cyclic: a}, {cyclic: b}).changeCount).toBe(0);
        expect(buildConfigDiff({shape: []}, {shape: {}}).changeCount).toBe(1);
        expect(buildConfigDiff({shape: {a: 1}}, {shape: {b: 1}}).changeCount).toBe(1);
        expect(buildConfigDiff({holes: [undefined, () => true, Symbol('fixture'), Number.NaN]}, {holes: [null, null, null, null]}).changeCount).toBe(0);
    });
});

describe('configstoreAudit explicit destination binding', () => {
    it.each(['fixture-new-openai', ''])('persists mixed-service legacy token edit %j through actual import, store and encrypted repository', async token => {
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true,
            initial: {service: 'openai', apiKeys: {openai: ['fixture-old-openai'], deepseek: ['fixture-old-deepseek']}}});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({on: true, service: 'openai', display: 1, from: 'auto', to: 'en',
            apiKeys: {deepseek: ['fixture-new-deepseek']}, token: {openai: token}}, store.config);
        await store.requestConfigSave(imported);
        const expectedKeys = {openai: token ? [token] : [], deepseek: ['fixture-new-deepseek']};
        expect(store.config.apiKeys).toEqual(expectedKeys);
        expect(store.config.token.openai).toBe(token || undefined);
        expect(await repository!.get('local:credentials')).toMatchObject({apiKeys: expectedKeys});
        expect((await store.prepareHydratedConfigForExport()).apiKeys).toEqual(expectedKeys);
    });
    const service = 'aliyunTranslation';
    const initial = () => normalizeConfig({service, token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-old-secret'}, serviceRegion: {[service]: 'cn-hangzhou'}});
    const importBase = {on: true, service, display: 1, from: 'auto', to: 'en', serviceRegion: {[service]: 'ap-southeast-1'}};

    it('keeps an explicitly imported secret and unbinds an omitted old token', () => {
        const imported = prepareConfigForImport({...importBase, secret: {[service]: 'fixture-new-secret'}}, initial());
        expect(imported.secret[service]).toBe('fixture-new-secret');
        expect(imported.token[service]).toBeUndefined();
    });

    it('unbinds an omitted old secret when only the token is explicitly imported', () => {
        const imported = prepareConfigForImport({...importBase, token: {[service]: 'fixture-id'}}, initial());
        expect(imported.token[service]).toBe('fixture-id');
        expect(imported.secret[service]).toBeUndefined();
    });

    it('treats unchanged credentials in an automatic full draft as carried values and unbinds them', async () => {
        const {store, records} = await configstoreAuditLoad({initial: initial()});
        const send = vi.fn(async (message: Parameters<NonNullable<Parameters<typeof store.requestConfigPatch>[1]>>[0]) => {
            const canonical = store.prepareConfigPatchRequest(message.config, message.expected, initial(), true);
            records.set('local:config', {...sanitizeConfigCredentials(canonical), __fluentConfigRevision: 11});
            expect(canonical.token[service]).toBeUndefined();
            expect(canonical.secret[service]).toBeUndefined();
            return {success: true, revision: 11};
        });
        await store.requestConfigPatch({...store.config, serviceRegion: {[service]: 'ap-southeast-1'}}, send);
        expect(store.config.token[service]).toBeUndefined();
        expect(store.config.secret[service]).toBeUndefined();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('never preserves an old pair for a destination-only patch', async () => {
        const {store} = await configstoreAuditLoad({initial: initial()});
        const next = store.prepareConfigPatchRequest({serviceRegion: {[service]: 'ap-southeast-1'}}, {serviceRegion: initial().serviceRegion}, initial(), true);
        expect(next.token[service]).toBeUndefined();
        expect(next.secret[service]).toBeUndefined();
    });

    it.each(['patch', 'save'] as const)('unbinds carried credentials in an ordinary proxy draft sent through %s', async mode => {
        const previous = normalizeConfig({token: {openai: 'fixture-openai', [service]: 'fixture-id'}, secret: {[service]: 'fixture-secret'}});
        const {store, records} = await configstoreAuditLoad({initial: previous});
        const sender = vi.fn(async (message: Parameters<NonNullable<Parameters<typeof store.requestConfigPatch>[1]>>[0]) => {
            const canonical = mode === 'patch'
                ? store.prepareConfigPatchRequest(message.config, message.expected, previous, true)
                : store.prepareConfigSaveRequest(message.config, previous, true);
            expect(canonical.token.openai).toBeUndefined();
            expect(canonical.token[service]).toBe('fixture-id');
            expect(canonical.secret[service]).toBe('fixture-secret');
            records.set('local:config', {...sanitizeConfigCredentials(canonical), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        const draft = {...store.config, proxy: {openai: 'https://configstore-audit.invalid/v1/chat/completions'}};
        await (mode === 'patch' ? store.requestConfigPatch(draft, sender) : store.requestConfigSave(draft, sender));
        expect(store.config.token.openai).toBeUndefined();
        expect(store.config.token[service]).toBe('fixture-id');
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it.each(['token', 'secret'] as const)('binds only the changed %s in an automatic full draft at a new region', async field => {
        const {store, records} = await configstoreAuditLoad({initial: initial()});
        const sender = vi.fn(async (message: Parameters<NonNullable<Parameters<typeof store.requestConfigPatch>[1]>>[0]) => {
            const canonical = store.prepareConfigPatchRequest(message.config, message.expected, initial(), true);
            expect(canonical[field][service]).toBe('fixture-explicit-new');
            expect(canonical[field === 'token' ? 'secret' : 'token'][service]).toBeUndefined();
            records.set('local:config', {...sanitizeConfigCredentials(canonical), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        await store.requestConfigPatch({...store.config, serviceRegion: importBase.serviceRegion, [field]: {[service]: 'fixture-explicit-new'}}, sender);
        expect(store.config[field][service]).toBe('fixture-explicit-new');
        expect(store.config[field === 'token' ? 'secret' : 'token'][service]).toBeUndefined();
    });

    it('imports an explicit pair and saves its exact snapshot through the actual store', async () => {
        const {store, records} = await configstoreAuditLoad({initial: initial()});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({...importBase, token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-new-secret'}}, store.config);
        await store.requestConfigSave(imported, async message => {
            expect(message.config.secret[service]).toBe('fixture-new-secret');
            records.set('local:config', {...sanitizeConfigCredentials(message.config), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        }, {credentialIntent: 'exact'});
        expect((await store.prepareHydratedConfigForExport()).secret).toEqual({[service]: 'fixture-new-secret'});
    });

    it('keeps both explicitly imported apiKeys and secret when the destination changes', () => {
        const imported = prepareConfigForImport({...importBase, apiKeys: {[service]: ['fixture-id']}, secret: {[service]: 'fixture-new-secret'}}, initial());
        expect(imported.token[service]).toBe('fixture-id');
        expect(imported.secret[service]).toBe('fixture-new-secret');
    });

    it('preserves explicitly rebound canonical multi-key rows over an empty raw token mirror in an actual imported IndexedDB save', async () => {
        const rows = ['', 'fixture-id', 'fixture-backup'];
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true,
            initial: {...initial(), apiKeys: {[service]: rows}}});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({...importBase, token: {}, apiKeys: {[service]: rows}}, store.config);
        await store.requestConfigSave(imported);
        expect(store.config.apiKeys[service]).toEqual(rows); expect(store.config.token[service]).toBe('fixture-id');
        expect(store.config.secret[service]).toBeUndefined();
        expect(await repository!.get('local:credentials')).toMatchObject({apiKeys: {[service]: rows}, secret: {}});
    });

    it('keeps an explicitly imported unchanged pair across an unrelated credential broadcast with default import save intent', async () => {
        const {store, records, emit} = await configstoreAuditLoad({initial: initial()});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({...importBase, token: {[service]: 'fixture-id'}, secret: {[service]: 'fixture-old-secret'}}, store.config);
        const response = configstoreAuditDeferred<{success: boolean; revision: number}>();
        const started = configstoreAuditDeferred<void>();
        const saved = store.requestConfigSave(imported, async message => {
            records.set('local:config', {...sanitizeConfigCredentials(store.prepareConfigSaveRequest(message.config, initial(), true)), __fluentConfigRevision: 11});
            started.resolve(); return response.promise;
        });
        await started.promise;
        emit('local:credentials', extractConfigCredentials({token: {[service]: 'fixture-broadcast-id', openai: 'fixture-other-id'}, secret: {[service]: 'fixture-broadcast-secret'}}));
        response.resolve({success: true, revision: 11});
        await saved;
        expect(store.config.token[service]).toBe('fixture-id');
        expect(store.config.secret[service]).toBe('fixture-old-secret');
        expect(store.config.token.openai).toBe('fixture-other-id');
    });

    it('applies destination protection to ordinary full-save drafts from connection checks', async () => {
        const {store, records} = await configstoreAuditLoad({initial: initial()});
        await store.requestConfigSave({...store.config, serviceRegion: {[service]: 'ap-southeast-1'}}, async message => {
            expect(message.config.token[service]).toBeUndefined();
            expect(message.config.secret[service]).toBeUndefined();
            records.set('local:config', {...sanitizeConfigCredentials(message.config), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        expect(store.config.token[service]).toBeUndefined();
        expect(store.config.secret[service]).toBeUndefined();
    });

    it.each(['token', 'secret'] as const)('carries only explicitly imported %s while clearing the omitted half through default store save', async field => {
        const {store, records} = await configstoreAuditLoad({initial: initial()});
        const {prepareConfigForImport} = await import('@/src/core/config/transfer');
        const imported = prepareConfigForImport({...importBase, [field]: {[service]: field === 'token' ? 'fixture-id' : 'fixture-old-secret'}}, store.config);
        await store.requestConfigSave(imported, async message => {
            records.set('local:config', {...sanitizeConfigCredentials(message.config), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        expect(store.config[field][service]).toBe(field === 'token' ? 'fixture-id' : 'fixture-old-secret');
        expect(store.config[field === 'token' ? 'secret' : 'token'][service]).toBeUndefined();
    });
});

describe('configstoreAudit persistence timing and permissions', () => {
    it('normalizes a non-object save snapshot while retaining canonical count fields', async () => {
        const {store, records} = await configstoreAuditLoad({initial: {count: 42}});
        await store.requestConfigSave(null, async message => {
            const canonical = store.prepareConfigSaveRequest(message.config, store.config, true);
            records.set('local:config', {...sanitizeConfigCredentials(canonical), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        expect(store.config.count).toBe(42);
    });
    it('does not turn pre-hydration default empty credentials into user clearing intent', async () => {
        const gate = configstoreAuditDeferred<void>();
        let pending!: Promise<void>;
        const sender = vi.fn();
        const {store} = await configstoreAuditLoad({initial: {token: {openai: 'fixture-stored'}, secret: {openai: 'fixture-stored-secret'}}, credentialReadBarrier: gate.promise,
            beforeReady: (store, records) => {
                sender.mockImplementation(async (message: {config: Config}) => {
                    expect(message.config.token.openai).toBe('fixture-stored');
                    expect(message.config.secret.openai).toBe('fixture-stored-secret');
                    records.set('local:config', {...sanitizeConfigCredentials(message.config), __fluentConfigRevision: 11});
                    return {success: true, revision: 11};
                });
                pending = store.requestConfigSave({...new Config(), to: 'ja'}, sender);
                gate.resolve();
            }});
        await pending;
        expect(store.config.token.openai).toBe('fixture-stored');
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('refuses empty defaults after credential hydration failed and sends no destructive save', async () => {
        const {store, records} = await configstoreAuditLoad({initial: {token: {openai: 'fixture-stored'}}, failCredentialRead: true});
        const sender = vi.fn();
        await expect(store.requestConfigSave({...new Config(), to: 'ja'}, sender)).rejects.toThrow('水合');
        expect(sender).not.toHaveBeenCalled();
        expect((records.get('local:credentials') as {token: Record<string, string>}).token.openai).toBe('fixture-stored');
    });

    it('rolls back ordinary transport failure to the same-revision authority', async () => {
        const {store} = await configstoreAuditLoad();
        const listener = vi.fn();
        configstoreAuditCleanups.push(store.subscribeConfig(listener));
        await expect(store.requestConfigPatch({to: 'ja'}, async () => {throw new Error('offline');})).rejects.toThrow('offline');
        expect(store.config.to).toBe('en');
        expect(listener.mock.calls.map(([value]) => value.to)).toEqual(['en', 'ja', 'en']);
    });

    it('adopts canonical same-revision authority on an explicit backend failure', async () => {
        const {store, records} = await configstoreAuditLoad();
        await expect(store.requestConfigPatch({to: 'ja'}, async () => {
            records.set('local:config', {...sanitizeConfigCredentials(normalizeConfig({to: 'fr'})), __fluentConfigRevision: 10});
            return {success: false, error: 'conflict'};
        })).rejects.toThrow('conflict');
        expect(store.config.to).toBe('fr');
        expect(store.getConfigRevision()).toBe(10);
    });

    it('consumes a newer external revision arriving before the saved response', async () => {
        const {store, emit} = await configstoreAuditLoad();
        const response = configstoreAuditDeferred<{success: boolean; revision: number}>();
        const started = configstoreAuditDeferred<void>();
        const saved = store.requestConfigPatch({to: 'ja'}, async () => {started.resolve(); return response.promise;});
        const settled = saved.catch(error => error);
        await started.promise;
        emit('local:config', {...sanitizeConfigCredentials(normalizeConfig({to: 'fr'})), __fluentConfigRevision: 12});
        response.resolve({success: true, revision: 11});
        expect(await settled).toBeInstanceOf(Error);
        expect(store.config.to).toBe('fr');
        expect(store.getConfigRevision()).toBe(12);
    });

    it('rebuilds a successful queued patch without fields from its failed predecessor', async () => {
        const {store, port} = await configstoreAuditLoad();
        const barrier = configstoreAuditDeferred<{success: boolean; error: string}>();
        const started = configstoreAuditDeferred<void>();
        const sender = vi.fn().mockImplementationOnce(async () => {started.resolve(); return barrier.promise;})
            .mockImplementationOnce(async () => {
                vi.mocked(port.getItem).mockRejectedValue(new Error('read unavailable'));
                return {success: true, revision: 11};
            });
        const first = store.requestConfigPatch({to: 'ja'}, sender).catch(error => error);
        await started.promise;
        const second = store.requestConfigPatch({theme: 'dark'}, sender);
        barrier.resolve({success: false, error: 'first failed'});
        expect(await first).toBeInstanceOf(Error);
        await second;
        expect(store.config.to).toBe('en');
        expect(store.config.theme).toBe('dark');
    });

    it('hands off the complete in-flight patch chain before unload and unsubscribes the page consumer', async () => {
        const {store, records} = await configstoreAuditLoad();
        const barrier = configstoreAuditDeferred<void>();
        const started = configstoreAuditDeferred<void>();
        const consumer = vi.fn();
        const unsubscribe = store.subscribeConfig(consumer);
        const sender = vi.fn(async (message: Parameters<NonNullable<Parameters<typeof store.requestConfigPatch>[1]>>[0]) => {
            started.resolve(); await barrier.promise;
            records.set('local:config', {...sanitizeConfigCredentials(store.config), __fluentConfigRevision: 10 + message.sequence});
            return {success: true, revision: 10 + message.sequence};
        });
        const first = store.requestConfigPatch({to: 'ja'}, sender);
        await started.promise;
        const second = store.requestConfigPatch({theme: 'dark'}, sender);
        let synchronouslySent = false;
        const handoff = store.handoffPendingConfigPatches(sender, async message => {
            synchronouslySent = true;
            expect(message.patches).toHaveLength(2);
            expect(message.patches[0].expected.to).toBe('en');
            expect(message.patches[1].expected.theme).toBe('auto');
            return {success: true, revision: 12};
        });
        expect(synchronouslySent).toBe(true);
        unsubscribe();
        const calls = consumer.mock.calls.length;
        barrier.resolve();
        await Promise.all([first, second, handoff]);
        expect(consumer).toHaveBeenCalledTimes(calls);
    });

    it('prevents content contexts from reading or patching credentials and rejects complete export', async () => {
        const {store, port} = await configstoreAuditLoad({trusted: false, initial: {token: {openai: 'fixture-protected'}}});
        expect(vi.mocked(port.getItem).mock.calls.map(([key]) => key)).toEqual(['local:config']);
        const next = store.prepareConfigPatchRequest({token: {openai: 'fixture-untrusted'}, to: 'ja'}, {to: store.config.to}, store.config, false);
        expect(next.token).toEqual({});
        expect(next.to).toBe('ja');
        await expect(store.prepareHydratedConfigForExport()).rejects.toThrow('无权');
    });

    it('rejects cyclic and overly deep persistence input without leaving pending saves or blocking a later valid edit', async () => {
        const {store, records} = await configstoreAuditLoad();
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        let deep: Record<string, unknown> = {leaf: 'fixture'};
        for (let index = 0; index < 12_000; index += 1) deep = {child: deep};
        const sender = vi.fn(async (message: {config: Config}) => {
            records.set('local:config', {...sanitizeConfigCredentials(normalizeConfig({...store.config, ...message.config})), __fluentConfigRevision: 11});
            return {success: true, revision: 11};
        });
        for (const extra of [cyclic, deep]) await expect(store.requestConfigPatch({extra}, sender)).rejects.toBeInstanceOf(Error);
        expect(sender).not.toHaveBeenCalled();
        await store.waitForConfigPersistenceQueue();
        await store.requestConfigPatch({to: 'ja'}, sender);
        expect(store.config.to).toBe('ja');
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('duplicate local saves wait for the same IndexedDB write and both reject its failure', async () => {
        const {store, port, repository} = await configstoreAuditLoad({owner: true, indexed: true});
        const barrier = configstoreAuditDeferred<void>();
        const started = configstoreAuditDeferred<void>();
        vi.mocked(port.setItems!).mockImplementationOnce(async () => {started.resolve(); await barrier.promise; throw new Error('disk failed');});
        const target = {...store.config, to: 'ja'};
        const first = store.saveConfig(target).catch(error => error);
        await started.promise;
        let finished = false;
        const second = store.saveConfig(target).then(() => {finished = true; return null;}, error => {finished = true; return error;});
        await Promise.resolve(); await Promise.resolve();
        expect(finished).toBe(false);
        barrier.resolve();
        expect(await first).toBeInstanceOf(Error);
        expect(await second).toBeInstanceOf(Error);
        expect((await repository!.get<Config>('local:config'))!.to).toBe('en');
    });

    it('coalesces queued local snapshots and persists the final one in the real IndexedDB repository', async () => {
        const {store, repository} = await configstoreAuditLoad({owner: true, indexed: true});
        await Promise.all([store.saveConfig({...store.config, to: 'ja'}), store.saveConfig({...store.config, to: 'fr'})]);
        expect((await repository!.get<Config>('local:config'))!.to).toBe('fr');
        expect(store.config.to).toBe('fr');
        expect((await repository!.get<Config>('local:credentials'))).not.toBeNull();
    });
});
