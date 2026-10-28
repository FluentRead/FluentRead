import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from '@/src/app/background/handlers/configPersistence';

const ports = vi.hoisted(() => ({
    config: {uiLanguageSetupCompleted: true, marker: 'old'}, revision: 7,
    ready: Promise.resolve(), historyReady: Promise.resolve(), backupReady: Promise.resolve(),
    prepareSave: vi.fn(), preparePatch: vi.fn(), save: vi.fn(), count: vi.fn(), history: vi.fn(), backup: vi.fn(),
    getItem: vi.fn(), drive: vi.fn(), webdav: vi.fn(), coordinators: [] as unknown[],
}));
vi.mock('@/src/services/config/store', () => ({
    config: ports.config, get configReady() {return ports.ready;}, get configHistoryReady() {return ports.historyReady;},
    getConfigRevision: () => ports.revision, prepareConfigSaveRequest: ports.prepareSave, prepareConfigPatchRequest: ports.preparePatch,
    saveConfig: ports.save, incrementConfigCount: ports.count, applyConfigHistoryAction: ports.history,
}));
vi.mock('@/src/services/config/autoBackupStore', () => ({get configAutoBackupsReady() {return ports.backupReady;}, restoreConfigAutoBackup: ports.backup}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {getItem: ports.getItem}}));
vi.mock('@/src/app/background/googleDriveSyncRuntime', () => ({createGoogleDriveSyncRuntime: (queue: any) => {
    ports.coordinators.push(queue);return {type: 'drive-probe', handle: () => queue.run(ports.drive)};
}}));
vi.mock('@/src/app/background/webDavBackupRuntime', () => ({createWebDavBackupRuntime: (queue: any) => {
    ports.coordinators.push(queue);return {type: 'webdav-probe', handle: () => queue.run(ports.webdav)};
}}));
import {createConfigBackgroundHandlers} from '@/src/app/background/configMessageHandlers';

const extension = {id: 'extension-id', url: 'chrome-extension://extension-id/options.html'};
const web = {id: 'extension-id', url: 'https://example.test/article', tab: {id: 4}, frameId: 0};
function deferred<T>() {let resolve!: (value: T) => void;let reject!: (reason: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
function harness(register?: (sender: ConfigPersistenceContext['sender']) => Promise<void>) {
    const handlers = createConfigBackgroundHandlers(register);
    const listener = createBackgroundRuntimeMessageListener(createBackgroundMessageRouter(handlers), sender => ({sender} as ConfigPersistenceContext));
    return {handlers, send: (message: unknown, sender: unknown = extension) => listener(message, sender)};
}
beforeEach(() => {
    vi.stubGlobal('browser', {runtime: {getURL: (path: string) => `chrome-extension://extension-id${path}`}});
    ports.ready = Promise.resolve();ports.historyReady = Promise.resolve();ports.backupReady = Promise.resolve();ports.revision = 7;
    ports.config.uiLanguageSetupCompleted = true;ports.config.marker = 'old';ports.coordinators.length = 0;
    for (const fn of [ports.prepareSave, ports.preparePatch, ports.save, ports.count, ports.history, ports.backup, ports.getItem, ports.drive, ports.webdav]) fn.mockReset();
    ports.prepareSave.mockImplementation((incoming: object, _current: object, allow: boolean) => ({...incoming, allowed: allow}));
    ports.preparePatch.mockImplementation((incoming: object, _expected: object, current: object, allow: boolean) => ({...current, ...incoming, allowed: allow}));
    ports.save.mockResolvedValue(undefined);ports.count.mockResolvedValue(12);ports.history.mockResolvedValue({position: 3});ports.backup.mockResolvedValue({restored: 8});
    ports.drive.mockResolvedValue({success: true});ports.webdav.mockResolvedValue({success: true});
    ports.getItem.mockImplementation(async (key: string) => ({key, marker: 'safe', token: {secret: 'local-secret'}, nested: {apiKey: 'hidden', keep: true}}));
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('background config message composition', () => {
    it('routes public configuration with sanitized credentials, registers receivers, and restricts private records and popup', async () => {
        const register = vi.fn(async () => undefined), h = harness(register);
        expect(ports.coordinators).toHaveLength(2);expect(ports.coordinators[0]).toBe(ports.coordinators[1]);
        expect(await h.send({type: 'configStorageRead', key: 'local:config'}, web)).toEqual({success: true, value: {marker: 'safe', nested: {keep: true}}});
        expect(register).toHaveBeenCalledWith(web);
        expect(await h.send({type: 'configStorageRead', key: 'local:credentials'}, web)).toMatchObject({success: false, error: '当前上下文无权读取配置凭据'});
        expect(await h.send({type: 'configStorageRead', key: 'local:configHistory'}, web)).toMatchObject({success: false, error: '当前上下文无权读取该配置记录'});
        expect(await h.send({type: 'configStorageRead', key: 'local:credentials'}, extension)).toMatchObject({success: true, value: {token: {secret: 'local-secret'}}});
        expect(await h.send({type: 'popupStartup'}, extension)).toEqual({success: true, uiLanguageSetupCompleted: true});
        expect(await h.send({type: 'popupStartup'}, web)).toMatchObject({success: false, error: '当前上下文无权读取菜单启动提示'});
        expect(await h.send({type: 'configStorageRead', key: 'local:unknown'}, extension)).toMatchObject({success: false, error: '配置存储读取键无效'});
        expect(await h.send({type: 'not-registered'}, extension)).toEqual({success: false, error: '不支持的后台消息'});
    });
    it('waits for hydration before safe reads and startup while denying spoofed extension origins immediately', async () => {
        const ready = deferred<void>();ports.ready = ready.promise;const register = vi.fn(async () => undefined), h = harness(register);
        const read = h.send({type: 'configStorageRead', key: 'local:config'}, web);
        const popup = h.send({type: 'popupStartup'}, extension);
        const denied = await h.send({type: 'configStorageRead', key: 'local:credentials'}, {url: 'chrome-extension://extension-id.evil/options.html'});
        expect(denied).toMatchObject({success: false, error: '当前上下文无权读取配置凭据'});
        expect(ports.getItem).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();
        ports.config.uiLanguageSetupCompleted = false;ready.resolve();
        expect(await read).toMatchObject({success: true, value: {marker: 'safe'}});
        expect(await popup).toEqual({success: true, uiLanguageSetupCompleted: false});
        expect(register).toHaveBeenCalledOnce();
        ports.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
        expect(await h.send({type: 'configStorageRead', key: 'session:credentials'}, extension)).toMatchObject({success: false, error: 'storage unavailable'});
    });
    it('uses the right readiness barrier for history and auto-backup, propagates failures, and reads ordinary config independently', async () => {
        const history = deferred<void>(), backup = deferred<void>();ports.historyReady = history.promise;ports.backupReady = backup.promise;
        const h = harness();const pendingHistory = h.send({type: 'configStorageRead', key: 'local:configHistory'});const pendingBackup = h.send({type: 'configStorageRead', key: 'local:configAutoBackups'});
        expect(await h.send({type: 'configStorageRead', key: 'local:config'})).toMatchObject({success: true});
        expect(ports.getItem.mock.calls.map(call => call[0])).toEqual(['local:config']);
        history.resolve();expect(await pendingHistory).toMatchObject({success: true});expect(ports.getItem).toHaveBeenCalledWith('local:configHistory');
        backup.reject(new Error('backup unavailable'));expect(await pendingBackup).toMatchObject({success: false, error: 'backup unavailable'});
        expect(ports.getItem).not.toHaveBeenCalledWith('local:configAutoBackups');
    });
    it('uses sender privileges and shared persistence for single requests and ordered patch batches', async () => {
        const h = harness();
        expect(await h.send({type: 'persistConfig', config: {marker: 'web'}, clientId: 'web', sequence: 1}, web)).toEqual({success: true, revision: 7});
        expect(ports.prepareSave).toHaveBeenLastCalledWith({marker: 'web'}, ports.config, false);
        expect(await h.send({type: 'persistConfig', config: {marker: 'extension'}, clientId: 'extension', sequence: 1}, extension)).toEqual({success: true, revision: 7});
        expect(ports.prepareSave).toHaveBeenLastCalledWith({marker: 'extension'}, ports.config, true);
        const patches = [{sequence: 1, config: {marker: 'first'}, expected: {marker: 'old'}}, {sequence: 2, config: {marker: 'second'}, expected: {marker: 'first'}}];
        expect(await h.send({type: 'persistConfigBatch', clientId: 'batch', patches}, web)).toEqual({success: true, revision: 7});
        expect(ports.preparePatch).toHaveBeenNthCalledWith(1, patches[0].config, patches[0].expected, ports.config, false);
        expect(ports.preparePatch).toHaveBeenNthCalledWith(2, patches[1].config, patches[1].expected, ports.config, false);
        expect(ports.save).toHaveBeenCalledTimes(4);expect(ports.save.mock.calls.every(call => call[1].recordHistory === true)).toBe(true);
        expect(await h.send({type: 'persistConfigBatch', clientId: 'bad', patches: []}, extension)).toMatchObject({success: false});
        expect(await h.send({type: 'persistConfigBatch', clientId: 'invalid-tail', patches: [patches[0], {...patches[1], expected: {wrong: 'field'}}]}, extension)).toMatchObject({success: false});
        expect(ports.save).toHaveBeenCalledTimes(4); // Invalid later entries must reject before the first write.
    });
    it('shares mutation order across persistence, count, history, backup and remote commits, and recovers after failure', async () => {
        const gate = deferred<void>(), events: string[] = [];const h = harness();
        ports.save.mockImplementation(async () => {events.push('save:start');await gate.promise;events.push('save:end');});
        ports.count.mockImplementationOnce(async () => {events.push('count:failed');throw new Error('count failed');});
        ports.history.mockImplementation(async () => {events.push('history');return {position: 3};});
        ports.backup.mockImplementation(async () => {events.push('backup');return {restored: 8};});
        ports.drive.mockImplementation(async () => {events.push('drive');return {success: true};});
        ports.webdav.mockImplementation(async () => {events.push('webdav');return {success: true};});
        const save = h.send({type: 'persistConfig', config: {marker: 'write'}, clientId: 'a', sequence: 1});
        try {
            await vi.waitFor(() => expect(events).toEqual(['save:start']));
            const count = h.send({type: 'incrementConfigCount', delta: 1, operationId: 'operation-123'});
            const history = h.send({type: 'configHistoryAction', action: 'undo'});
            const backup = h.send({type: 'configAutoBackupRestore', version: 8});
            const drive = h.send({type: 'drive-probe'}), webdav = h.send({type: 'webdav-probe'});
            await Promise.resolve();expect(events).toEqual(['save:start']);gate.resolve();
            expect(await save).toEqual({success: true, revision: 7});expect(await count).toMatchObject({success: false, error: 'count failed'});
            expect(await history).toEqual({success: true, history: {position: 3}});expect(await backup).toEqual({success: true, result: {restored: 8}});
            expect(await drive).toEqual({success: true});expect(await webdav).toEqual({success: true});
            expect(events).toEqual(['save:start', 'save:end', 'count:failed', 'history', 'backup', 'drive', 'webdav']);
        } finally {gate.resolve();}
    });
    it('warns on receiver registration failure yet returns sanitized config; missing receiver is supported', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness(vi.fn(async () => {throw new Error('closed tab');}));
        expect(await h.send({type: 'configStorageRead', key: 'local:config'}, web)).toMatchObject({success: true, value: {marker: 'safe'}});
        expect(warn).toHaveBeenCalledWith('[FluentRead] 网页配置通知登记失败');
        expect(await harness().send({type: 'configStorageRead', key: 'local:config'}, web)).toMatchObject({success: true});
    });
});
