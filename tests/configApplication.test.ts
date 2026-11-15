/**
 * @file tests/configApplication.test.ts
 * 文件职责：验证配置应用实例的显式启动、状态隔离和真实权威端到客户端提交协作。
 * 主要内容：直接组合生产 authority/client/history 与后台保存 handler，以可控存储和消息等待验证独立实例、计数重放及并发字段保留。
 * 模块边界：不替换配置领域规则，不读取真实凭据或浏览器存储，不复制生产 CAS 或 ACK 算法；水合状态只验证既有初始化/写入保护标志的公开投影。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {createConfigApplication, type ConfigApplication} from '@/src/services/config/application';
import {createConfigAuthority} from '@/src/services/config/authority';
import {createConfigMutationClient} from '@/src/services/config/mutationClient';
import {createConfigHistoryRuntime} from '@/src/services/config/historyRuntime';
import {createBaselineConfigHistory} from '@/src/services/config/history';
import {createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';

const applications: ConfigApplication[] = [];
afterEach(async () => {
    await Promise.all(applications.splice(0).map(application => application.flushConfigHistory()));
    vi.restoreAllMocks();
});

function pending<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {promise, resolve};
}

function memoryStorage(to: string, count = 7) {
    const initial = normalizeConfig({to, count});
    const records = new Map<string, unknown>([
        ['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 4}],
        ['local:credentials', extractConfigCredentials(initial)],
    ]);
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const reads = vi.fn<(key: string) => void>();
    const notify = (key: string) => {
        for (const listener of listeners.get(key) ?? []) listener(structuredClone(records.get(key) ?? null));
    };
    const port: ConfigStoragePort = {
        writeOwner: true,
        getItem: async <T>(key: string) => {
            reads(key);
            return structuredClone(records.get(key) ?? null) as T | null;
        },
        setItem: vi.fn(async <T>(key: string, value: T) => {records.set(key, structuredClone(value)); notify(key);}),
        setItems: vi.fn(async (entries, removeKeys = []) => {
            for (const [key, value] of entries) records.set(key, structuredClone(value));
            for (const key of removeKeys) records.delete(key);
            for (const key of [...entries.keys(), ...removeKeys]) notify(key);
        }),
        removeItem: vi.fn(async key => {records.delete(key); notify(key);}),
        watch: vi.fn((key, callback) => {
            const watched = listeners.get(key) ?? new Set();
            const listener = callback as (value: unknown) => void;
            listeners.set(key, watched); watched.add(listener);
            return () => {watched.delete(listener);};
        }),
    };
    return {port, records, reads};
}

function application(storage: ConfigStoragePort) {
    const result = createConfigApplication({storage, trustedContext: true});
    applications.push(result);
    return result;
}

describe('explicit configuration application ownership', () => {
    it('an older failed public restore preserves the newer pending deduplication receipt',async()=>{
        const {port,records}=memoryStorage('en'),authority=createConfigAuthority({storage:port,trustedContext:false,client:()=>client,history:()=>history});
        const history=createConfigHistoryRuntime({storage:port,ready:()=>authority.configReady,getConfig:()=>authority.config,getRevision:authority.getConfigRevision,isTrusted:()=>false,isWriteOwner:()=>true,commit:authority.restore});
        const client=createConfigMutationClient({authority:authority.clientPort,applyHistoryAction:history.applyAction});await authority.start();
        const gate=pending<void>(),started=pending<void>();
        vi.mocked(port.setItem).mockImplementationOnce(async()=>{started.resolve();await gate.promise;throw Error('old public write failed');});
        const first=authority.restore(normalizeConfig({to:'ja'})).catch(error=>error);await started.promise;const next=normalizeConfig({to:'fr'}),second=authority.restore(next);
        gate.resolve();expect(await first).toBeInstanceOf(Error);await second;const writes=vi.mocked(port.setItem).mock.calls.length;await authority.restore(next);
        expect(vi.mocked(port.setItem).mock.calls.length).toBe(writes);expect((records.get('local:config') as any).to).toBe('fr');expect(authority.config.token).toEqual({});
    });
    it('keeps hydration and durable saves working when a configuration subscriber throws', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {port, records} = memoryStorage('en');
        const app = application(port);
        const broken = vi.fn(() => {throw new Error('UI observer failed');});
        const healthy = vi.fn();
        const stop = app.subscribeConfig(broken);
        app.subscribeConfig(healthy);
        await app.start();
        expect(app.getConfigHydrationStatus()).toBe('ready');
        expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({to: 'en'}));
        await expect(app.saveConfig({...app.config, to: 'ja'})).resolves.toBeUndefined();
        expect(records.get('local:config')).toMatchObject({to: 'ja'});
        expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({to: 'ja'}));
        stop();
        expect(() => app.subscribeConfig(() => {throw new Error('initial notification failed');})()).not.toThrow();
    });

    it('does not misreport a successful history commit as failed when a history subscriber throws', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {port, records} = memoryStorage('en');
        const app = application(port);
        await app.start();
        const healthy = vi.fn();
        app.subscribeConfigHistory(() => {throw new Error('history view failed');});
        app.subscribeConfigHistory(healthy);
        await app.configHistoryReady;
        await expect(app.saveConfig({...app.config, to: 'ja'}, {recordHistory: true, immediateHistory: true})).resolves.toBeUndefined();
        expect((records.get('local:configHistory') as {entries: Array<{config: {to: string}}>}).entries.at(-1)?.config.to).toBe('ja');
        expect(healthy).toHaveBeenCalled();
        expect(() => app.subscribeConfigHistory(() => {throw new Error('initial history view failed');})()).not.toThrow();
    });

    it('reports a storage observer startup failure through the same ready promise', async () => {
        const {port, reads} = memoryStorage('en');
        vi.mocked(port.watch).mockImplementation(() => {throw new Error('observer unavailable');});
        const app = createConfigApplication({storage: port, trustedContext: true});
        const ready = app.start();
        await expect(ready).rejects.toThrow('observer unavailable');
        expect(app.start()).toBe(ready);
        expect(reads).not.toHaveBeenCalled();
        expect(port.setItem).not.toHaveBeenCalled();
    });

    it('keeps hydration loading through a delayed public read, then reports ready without exposing configuration data', async () => {
        const {port, records} = memoryStorage('ja');
        const gate = pending<unknown>();
        const app = application({...port, writeOwner: false, getItem: async <T>(key: string) => key === 'local:config' ? await gate.promise as T : port.getItem<T>(key)});
        expect(app.getConfigHydrationStatus()).toBe('loading');
        const ready = app.start(); expect(app.getConfigHydrationStatus()).toBe('loading');
        gate.resolve(structuredClone(records.get('local:config'))); await ready;
        expect(app.getConfigHydrationStatus()).toBe('ready'); expect(app.config.to).toBe('ja');
    });
    it.each(['local:config', 'local:credentials'])('reports blocked on %s read failure while preserving the resolving configReady contract and stored records', async failedKey => {
        const {port, records} = memoryStorage('ja'); const before = JSON.stringify([...records]);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = application({...port, writeOwner: false, getItem: async <T>(key: string) => {
            if (key === failedKey) throw new Error('fixture-private-config-error');
            return port.getItem<T>(key);
        }});
        await expect(app.start()).resolves.toBeUndefined(); await expect(app.configReady).resolves.toBeUndefined();
        expect(app.getConfigHydrationStatus()).toBe('blocked');
        expect(JSON.stringify([...records])).toBe(before); expect(port.setItem).not.toHaveBeenCalled(); expect(port.setItems).not.toHaveBeenCalled(); expect(port.removeItem).not.toHaveBeenCalled();
        if (failedKey === 'local:credentials') expect(app.config.to).toBe('ja');
    });
    it('a genuinely new, successfully read configuration is ready and keeps the normal first-use flag', async () => {
        const {port, records} = memoryStorage('en'); records.clear();
        const app = application({...port, writeOwner: false}); await app.start();
        expect(app.getConfigHydrationStatus()).toBe('ready'); expect(app.config.uiLanguageSetupCompleted).toBe(false);
    });
    it.each([true, false])('keeps ready hydration while reading existing history with write-owner=%s', async writeOwner => {
        const {port, records} = memoryStorage('ja');
        const storedHistory = createBaselineConfigHistory(normalizeConfig(records.get('local:config')), 4);
        records.set('local:configHistory', storedHistory);
        const app = application({...port, writeOwner}); await app.start(); await app.configHistoryReady;
        expect(app.getConfigHydrationStatus()).toBe('ready');
        expect(app.getConfigHistorySnapshot()).toEqual(storedHistory);
        expect(records.get('local:configHistory')).toEqual(storedHistory);
    });
    it('reconciles a rejected patch from an already received authoritative watch without another read', async () => {
        const {port, reads} = memoryStorage('en');
        const client = application({...port, writeOwner: false});
        await client.start();
        const sent = pending<void>(), rejectAck = pending<void>();
        const saving = client.requestConfigPatch({to: 'ja'}, async () => {
            sent.resolve();
            await rejectAck.promise;
            return {success: false, error: 'field changed elsewhere'};
        });
        await sent.promise;
        const readCount = reads.mock.calls.length;
        await port.setItem('local:config', {
            ...sanitizeConfigCredentials(normalizeConfig({to: 'fr', on: false, count: 7})),
            __fluentConfigRevision: 5,
        });
        expect(client.config.to).toBe('ja');
        rejectAck.resolve();
        await expect(saving).rejects.toThrow('field changed elsewhere');
        expect(client.config).toMatchObject({to: 'fr', on: false, count: 7});
        expect(client.getConfigRevision()).toBe(5);
        expect(reads.mock.calls).toHaveLength(readCount);
    });

    it('constructs without storage work and starts only one authority hydration', async () => {
        const {port, reads} = memoryStorage('en');
        const app = application(port);
        expect(reads).not.toHaveBeenCalled();
        expect(port.setItem).not.toHaveBeenCalled();
        expect(port.watch).not.toHaveBeenCalled();
        const ready = app.start();
        expect(app.start()).toBe(ready);
        expect(ready).toBe(app.configReady);
        await ready;
        expect(app.config.to).toBe('en');
        const configWatches = vi.mocked(port.watch).mock.calls.filter(([key]) => key === 'local:config');
        expect(configWatches).toHaveLength(1);
    });

    it('isolates authority, client queues and history between independent instances', async () => {
        const left = application(memoryStorage('en').port);
        const right = application(memoryStorage('fr').port);
        expect(left.config).not.toBe(right.config);
        await Promise.all([left.start(), right.start()]);
        await left.requestConfigPatch({to: 'ja'});
        expect(left.config.to).toBe('ja');
        expect(right.config.to).toBe('fr');
        await Promise.all([left.configHistoryReady, right.configHistoryReady]);
        expect(left.getConfigHistorySnapshot().entries.at(-1)?.config.to).toBe('ja');
        expect(right.getConfigHistorySnapshot().entries.at(-1)?.config.to).toBe('fr');
    });

    it('keeps durable count-operation replay when a new authority instance starts', async () => {
        const {port} = memoryStorage('en');
        const first = application(port);
        await first.start();
        expect(await first.incrementConfigCount(3, 'application:count:1')).toBe(10);
        const restarted = application(port);
        await restarted.start();
        expect(await restarted.incrementConfigCount(3, 'application:count:1')).toBe(10);
        expect(restarted.config.count).toBe(10);
        expect(await restarted.incrementConfigCount(2, 'application:count:2')).toBe(12);
    });

    it('uses the real background authority and preserves concurrent unrelated fields across a delayed ACK', async () => {
        const {port} = memoryStorage('en');
        const owner = application(port);
        const client = application({...port, writeOwner: false});
        await Promise.all([owner.start(), client.start()]);
        const handler = createConfigPersistenceHandler({
            ready: owner.configReady, getCurrentConfig: () => owner.config,
            prepareConfigSaveRequest: owner.prepareConfigSaveRequest,
            prepareConfigPatchRequest: owner.prepareConfigPatchRequest,
            saveConfig: owner.saveConfig, getCurrentRevision: owner.getConfigRevision,
            isExtensionUrl: url => url.startsWith('chrome-extension://application-test/'),
        });
        const sent = pending<void>(), proceed = pending<void>();
        const saving = client.requestConfigPatch({to: 'ja'}, async message => {
            sent.resolve();
            await proceed.promise;
            return handler.handle(JSON.parse(JSON.stringify(message)), {
                sender: {url: 'chrome-extension://application-test/options.html'},
            });
        });
        await sent.promise;
        expect(client.config.to).toBe('ja');
        expect(owner.config.to).toBe('en');
        await owner.requestConfigPatch({on: false});
        proceed.resolve();
        await saving;
        expect(owner.config).toMatchObject({to: 'ja', on: false, count: 7});
        expect(client.config).toMatchObject({to: 'ja', on: false, count: 7});
        expect(client.getConfigRevision()).toBe(owner.getConfigRevision());
        await client.waitForConfigPersistenceQueue();
    });

    it.each(['delete', 'edit', 'unrelated'] as const)('keeps glossary list CAS across a delayed transport with a concurrent %s', async change => {
        const library = (id: string) => ({
            id, name: id, enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-hans', domains: [],
            entries: [{id: `${id}-term`, source: id, target: `${id} translation`, caseSensitive: false}],
        });
        const {port, records} = memoryStorage('en');
        const initial = normalizeConfig({to: 'en', count: 7, glossaryLibraries: [library('first'), library('second')]});
        records.set('local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 4});
        const owner = application(port);
        const client = application({...port, writeOwner: false});
        await Promise.all([owner.start(), client.start()]);
        const handler = createConfigPersistenceHandler({
            ready: owner.configReady, getCurrentConfig: () => owner.config,
            prepareConfigSaveRequest: owner.prepareConfigSaveRequest,
            prepareConfigPatchRequest: owner.prepareConfigPatchRequest,
            saveConfig: owner.saveConfig, getCurrentRevision: owner.getConfigRevision,
            isExtensionUrl: url => url.startsWith('chrome-extension://application-test/'),
        });
        const sent = pending<void>(), proceed = pending<void>();
        const sender = vi.fn<NonNullable<Parameters<typeof client.requestConfigPatch>[1]>>(async message => {
            sent.resolve();
            await proceed.promise;
            return handler.handle(JSON.parse(JSON.stringify(message)), {
                sender: {url: 'chrome-extension://application-test/options.html'},
            });
        });
        const requested = [...client.config.glossaryLibraries, library('local-addition')];
        const saving = client.requestConfigPatch({glossaryLibraries: requested}, sender);
        // Attach rejection handling before releasing the transport; the actual client,
        // background CAS and authoritative watch/readback remain production code.
        const outcome = saving.then(() => 'accepted', (error: unknown) => error);
        await sent.promise;
        expect(sender).toHaveBeenCalledOnce();
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'patch', config: {glossaryLibraries: requested}, expected: {glossaryLibraries: initial.glossaryLibraries},
        }));
        expect(client.config.glossaryLibraries).toEqual(requested);
        expect(owner.config.glossaryLibraries).toEqual(initial.glossaryLibraries);

        const externalLibraries = change === 'delete' ? initial.glossaryLibraries.slice(1)
            : initial.glossaryLibraries.map(item => item.id === 'second'
                ? {...item, entries: item.entries.map(entry => ({...entry, target: 'external translation'}))} : item);
        await owner.requestConfigPatch(change === 'unrelated' ? {on: false} : {glossaryLibraries: externalLibraries});
        const externalRevision = owner.getConfigRevision();
        // The active request defers the incoming watch; its old expected array must
        // still reach CAS, rather than borrowing the new baseline and overwriting it.
        expect(client.config.glossaryLibraries).toEqual(requested);
        proceed.resolve();
        const result = await outcome;
        if (change === 'unrelated') expect(result).toBe('accepted');
        else expect(result).toMatchObject({message: expect.stringContaining('glossaryLibraries')});
        await client.waitForConfigPersistenceQueue();

        const expectedLibraries = change === 'unrelated' ? requested : externalLibraries;
        expect(owner.config.glossaryLibraries).toEqual(expectedLibraries);
        expect(client.config.glossaryLibraries).toEqual(expectedLibraries);
        expect(owner.config).toMatchObject({on: change !== 'unrelated', to: 'en', count: 7});
        expect(records.get('local:config')).toMatchObject({glossaryLibraries: expectedLibraries});
        expect(owner.getConfigRevision()).toBe(externalRevision + (change === 'unrelated' ? 1 : 0));
        expect(client.getConfigRevision()).toBe(owner.getConfigRevision());
        expect(sender).toHaveBeenCalledOnce();
    });
});
