import {describe, expect, it, vi} from 'vitest';
import {installConfigStorageBroadcast} from '@/src/app/background/configStorageBroadcast';
import {createConfigStorageReadHandler, createPopupStartupHandler} from '@/src/app/background/handlers/configStorage';
import {
    CONFIG_INDEXED_DB_KEYS,
    CONFIG_STORAGE_CHANGED_MESSAGE,
    CONFIG_STORAGE_READ_MESSAGE,
    type ConfigStoragePort,
} from '@/src/platform/storage/configStorage';

describe('后台配置 IndexedDB 读取 handler', () => {
    it('网页快照去除仅供后台去重的计数幂等日志，扩展页面保持原始记录', async () => {
        const record = {marker: 'value', count: 3, __fluentCountOperations: [{id: 'count-1', delta: 1, count: 3}]};
        const handler = createConfigStorageReadHandler({
            ready: Promise.resolve(),
            read: vi.fn(async () => record),
            isExtensionUrl: url => url.startsWith('chrome-extension://fluentread/'),
        });
        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'},
            {sender: {url: 'https://example.com/page'}},
        )).resolves.toEqual({success: true, value: {marker: 'value', count: 3}});
        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'},
            {sender: {url: 'chrome-extension://fluentread/options.html'}},
        )).resolves.toEqual({success: true, value: record});
    });

    it('content 只取得无凭据主配置，其他记录只允许扩展自身页面', async () => {
        const read = vi.fn(async key => ({
            recordKey: key,
            marker: 'value',
            token: {openai: 'legacy-secret'},
            nested: {apiKey: 'nested-secret', safe: true},
        }));
        const handler = createConfigStorageReadHandler({
            ready: Promise.resolve(),
            read,
            isExtensionUrl: url => url.startsWith('chrome-extension://fluentread/'),
        });

        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'},
            {sender: {url: 'https://example.com/page'}},
        )).resolves.toEqual({
            success: true,
            value: {recordKey: 'local:config', marker: 'value', nested: {safe: true}},
        });
        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'session:credentials'},
            {sender: {url: 'https://example.com/page'}},
        )).rejects.toThrow('无权读取配置凭据');
        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:configHistory'},
            {sender: {url: 'https://example.com/page'}},
        )).rejects.toThrow('无权读取该配置记录');
        await expect(handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:credentials'},
            {sender: {url: 'chrome-extension://fluentread/options.html'}},
        )).resolves.toEqual({
            success: true,
            value: {
                recordKey: 'local:credentials',
                marker: 'value',
                token: {openai: 'legacy-secret'},
                nested: {apiKey: 'nested-secret', safe: true},
            },
        });
    });

    it('拒绝未知、空或非字符串键，并在读取前等待仓库 ready', async () => {
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const read = vi.fn().mockResolvedValue(null);
        const handler = createConfigStorageReadHandler({
            ready,
            read,
            isExtensionUrl: () => true,
        });
        const pending = handler.handle(
            {type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:configHistory'},
            {sender: {}},
        );
        expect(read).not.toHaveBeenCalled();
        release();
        await expect(pending).resolves.toEqual({success: true, value: null});
        expect(read).toHaveBeenCalledWith('local:configHistory');

        for (const key of [undefined, '', 42, 'local:unknown']) {
            await expect(handler.handle(
                {type: CONFIG_STORAGE_READ_MESSAGE, key},
                {},
            )).rejects.toThrow('读取键无效');
        }
    });
});

describe('Popup 启动提示', () => {
    it('等待后台配置初始化后只返回最新引导状态', async () => {
        let release!: () => void;
        let setupCompleted = false;
        const getSetupCompleted = vi.fn(() => setupCompleted);
        const handler = createPopupStartupHandler({
            ready: new Promise<void>(resolve => { release = resolve; }),
            getSetupCompleted,
            isExtensionUrl: url => url.startsWith('chrome-extension://fluentread/'),
        });
        const pending = handler.handle({type: 'popupStartup'}, {sender: {url: 'chrome-extension://fluentread/popup.html'}});
        expect(getSetupCompleted).not.toHaveBeenCalled();
        setupCompleted = true;
        release();
        await expect(pending).resolves.toEqual({success: true, uiLanguageSetupCompleted: true});
        setupCompleted = false;
        await expect(handler.handle({type: 'popupStartup'}, {sender: {url: 'chrome-extension://fluentread/popup.html'}}))
            .resolves.toEqual({success: true, uiLanguageSetupCompleted: false});
    });

    it('拒绝外部页面或缺失 sender，不读取引导状态', async () => {
        const getSetupCompleted = vi.fn(() => true);
        const handler = createPopupStartupHandler({
            ready: Promise.resolve(), getSetupCompleted,
            isExtensionUrl: url => url.startsWith('chrome-extension://fluentread/'),
        });
        for (const context of [{}, {sender: {url: 'https://example.com'}}]) {
            await expect(handler.handle({type: 'popupStartup'}, context)).rejects.toThrow('无权读取菜单启动提示');
        }
        expect(getSetupCompleted).not.toHaveBeenCalled();
    });
});

function createStorageWatchHarness() {
    const watchers = new Map<string, (value: unknown) => void>();
    const unsubscribers = new Map<string, ReturnType<typeof vi.fn>>();
    const storage: ConfigStoragePort = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        watch: vi.fn((key: string, listener: (value: unknown) => void) => {
            watchers.set(key, listener);
            const unsubscribe = vi.fn();
            unsubscribers.set(key, unsubscribe);
            return unsubscribe;
        }),
    };
    return {storage, watchers, unsubscribers};
}

describe('后台配置变化广播', () => {
    it('所有键只向扩展页面广播键名，主配置额外通知所有 content tab', async () => {
        const harness = createStorageWatchHarness();
        const sendRuntimeMessage = vi.fn().mockResolvedValue(undefined);
        const queryTabs = vi.fn().mockResolvedValue([{id: 1}, {}, {id: 2}]);
        const sendTabMessage = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('tab closed'));
        const warn = vi.fn();
        const dispose = installConfigStorageBroadcast(harness.storage, {
            sendRuntimeMessage,
            queryTabs,
            sendTabMessage,
            warn,
        });

        expect(harness.storage.watch).toHaveBeenCalledTimes(CONFIG_INDEXED_DB_KEYS.length);
        harness.watchers.get('local:credentials')?.({token: {openai: 'never-broadcast-value'}});
        await vi.waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledWith({
            type: CONFIG_STORAGE_CHANGED_MESSAGE,
            key: 'local:credentials',
        }));
        expect(queryTabs).not.toHaveBeenCalled();
        expect(JSON.stringify(sendRuntimeMessage.mock.calls)).not.toContain('never-broadcast-value');

        harness.watchers.get('local:config')?.({on: false});
        await vi.waitFor(() => expect(sendTabMessage).toHaveBeenCalledTimes(2));
        expect(sendTabMessage).toHaveBeenCalledWith(1, {
            type: CONFIG_STORAGE_CHANGED_MESSAGE,
            key: 'local:config',
        });
        expect(warn).not.toHaveBeenCalled();

        // 只有计数与幂等日志变化时仍通知扩展页，但不再扇出到网页。
        const runtimeCalls = sendRuntimeMessage.mock.calls.length;
        harness.watchers.get('local:config')?.({on: false, count: 9, __fluentCountOperations: [{id: 'count-1'}]});
        expect(sendRuntimeMessage).toHaveBeenCalledTimes(runtimeCalls + 1);
        harness.watchers.get('local:config')?.(null);
        await vi.waitFor(() => expect(queryTabs).toHaveBeenCalledTimes(2));
        expect(queryTabs).toHaveBeenCalledTimes(2);

        dispose();
        expect([...harness.unsubscribers.values()].every(unsubscribe => unsubscribe.mock.calls.length === 1)).toBe(true);
    });

    it('忽略没有接收端的空广播，但记录 runtime 与 tabs 查询故障', async () => {
        const noReceiver = createStorageWatchHarness();
        const noReceiverWarn = vi.fn();
        installConfigStorageBroadcast(noReceiver.storage, {
            sendRuntimeMessage: vi.fn().mockRejectedValue(new Error('Receiving end does not exist')),
            queryTabs: vi.fn().mockResolvedValue([]),
            sendTabMessage: vi.fn(),
            warn: noReceiverWarn,
        });
        noReceiver.watchers.get('local:configHistory')?.({entries: []});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(noReceiverWarn).not.toHaveBeenCalled();

        const failed = createStorageWatchHarness();
        const warn = vi.fn();
        installConfigStorageBroadcast(failed.storage, {
            sendRuntimeMessage: vi.fn().mockRejectedValue(new Error('runtime failed')),
            queryTabs: vi.fn().mockRejectedValue(new Error('tabs failed')),
            sendTabMessage: vi.fn(),
            warn,
        });
        failed.watchers.get('local:config')?.({on: true});
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
        expect(warn.mock.calls.map(call => call[0])).toEqual([
            '[FluentRead] 扩展配置变化广播失败',
            '[FluentRead] 网页配置变化广播失败',
        ]);
    });
});
