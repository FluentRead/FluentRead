import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const ports = vi.hoisted(() => {
    const watchers = new Map<string, (value: unknown, previous?: unknown) => void>();
    const removedListeners: Array<(id: number) => void> = [];
    const browser = {
        runtime: {id: 'fluentread', getURL: (path: string) => `safari-web-extension://fluentread${path}`, sendMessage: vi.fn()},
        extension: {inIncognitoContext: false},
        tabs: {query: vi.fn(), sendMessage: vi.fn(), onRemoved: {addListener: vi.fn((listener: (id: number) => void) => {removedListeners.push(listener);})}},
        storage: {session: {get: vi.fn(), set: vi.fn()}},
    };
    return {watchers, removedListeners, browser, createProject: vi.fn(), config: {on: true, personalCorrectionsEnabled: true},
        storage: {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(),
            watch: vi.fn((key: string, callback: (value: unknown, previous?: unknown) => void) => {
                watchers.set(key, callback); return () => {watchers.delete(key);};
            })}};
});
vi.mock('webextension-polyfill', () => ({default: ports.browser}));
vi.mock('@/src/services/config/store', () => ({config: ports.config}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: ports.storage}));
vi.mock('@/src/platform/storage/personalCorrectionRepository', () => ({PersonalCorrectionRepository: class {}}));
vi.mock('@/src/services/personal-corrections/service', () => ({PersonalCorrectionService: class {createProject = ports.createProject;}}));
import {createConfigImageOcrLanguageStorage, installBrowserConfigStorageBroadcast, installBrowserTabBroadcastRuntime} from '@/src/app/background/configStorageRuntime';
import {createPersonalCorrectionRuntimeHandlers} from '@/src/app/background/personalCorrectionRuntime';
import {createConfigStorageReadHandler} from '@/src/app/background/handlers/configStorage';
import {createTranslationCacheHandler, createTranslationCacheInvalidationBroadcaster} from '@/src/app/background/handlers/translationCache';
import {createBrowserVocabularyBookChangedBroadcaster} from '@/src/features/vocabulary/background/handler';
import {TAB_BROADCAST_SESSION_KEY} from '@/src/app/background/tabBroadcast';
import {CONFIG_STORAGE_READ_MESSAGE} from '@/src/platform/storage/configStorage';
import type {PersonalCorrectionMessage} from '@/src/services/personal-corrections/protocol';

beforeEach(() => {
    vi.clearAllMocks(); ports.watchers.clear(); ports.removedListeners.length = 0;
    vi.stubGlobal('browser', ports.browser);
    ports.browser.tabs.query.mockResolvedValue([{id: 7}, {id: 90}]);
    ports.browser.tabs.sendMessage.mockResolvedValue(undefined);
    ports.browser.runtime.sendMessage.mockResolvedValue(undefined);
    ports.browser.storage.session.get.mockResolvedValue({});
    ports.browser.storage.session.set.mockResolvedValue(undefined);
    ports.createProject.mockResolvedValue({id: 'project'});
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('真实后台广播工厂共享接收者适配器', () => {
    it.each(['safari', 'chrome', 'firefox'])('%s 的四条实际广播沿共享策略投递', async browserName => {
        const tabBroadcast = installBrowserTabBroadcastRuntime(browserName);
        const handler = createConfigStorageReadHandler({
            ready: Promise.resolve(), read: async () => ({on: true}),
            isExtensionUrl: url => url.startsWith('safari-web-extension://fluentread/'),
            registerContentReceiver: tabBroadcast.registerContentReceiver,
        });
        await handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {
            sender: {id: 'fluentread', url: 'about:blank', frameId: 3, tab: {id: 7}},
        });
        installBrowserConfigStorageBroadcast(tabBroadcast);
        ports.watchers.get('local:config')?.({on: false});
        await vi.waitFor(() => expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'configStorageChanged', key: 'local:config'}));
        await createTranslationCacheInvalidationBroadcaster({...tabBroadcast, warn: vi.fn()})();
        createBrowserVocabularyBookChangedBroadcaster({...tabBroadcast, sendRuntimeMessage: ports.browser.runtime.sendMessage})('note', 'opaque-entry');
        const [correction] = createPersonalCorrectionRuntimeHandlers(tabBroadcast);
        const projectMessage: PersonalCorrectionMessage = {type: 'fluentReadPersonalCorrections', action: 'createProject', label: 'Project'};
        await expect(correction!.handle(projectMessage, {
            sender: {id: 'fluentread', url: 'safari-web-extension://fluentread/options.html'},
        })).resolves.toMatchObject({success: true});
        await vi.waitFor(() => expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'fluentReadPersonalCorrectionsChanged'}));
        await vi.waitFor(() => expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
            type: 'fluentReadVocabularyBookChanged', reason: 'note', entryId: 'opaque-entry',
        }));
        const calls = ports.browser.tabs.sendMessage.mock.calls;
        expect(calls.filter(([id]) => id === 7).map(([, message]) => message.type).sort()).toEqual([
            'configStorageChanged', 'fluentReadPersonalCorrectionsChanged', 'fluentReadVocabularyBookChanged', 'translationCacheCleared',
        ]);
        if (browserName === 'safari') {
            expect(ports.browser.tabs.query).not.toHaveBeenCalled();
            expect(calls.every(([id]) => id === 7)).toBe(true);
            expect(ports.browser.storage.session.set).toHaveBeenLastCalledWith({[TAB_BROADCAST_SESSION_KEY]: [7]});
        } else {
            expect(ports.browser.tabs.query).toHaveBeenCalledTimes(4);
            expect(calls.filter(([id]) => id === 90)).toHaveLength(4);
            expect(ports.browser.storage.session.get).not.toHaveBeenCalled();
            expect(ports.browser.storage.session.set).not.toHaveBeenCalled();
        }
    });

    it('先安装关闭事件，pending session load 期间关闭的标签不进入真实投递', async () => {
        let release!: (value: unknown) => void;
        ports.browser.storage.session.get.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        expect(ports.browser.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
        expect(ports.browser.storage.session.get).not.toHaveBeenCalled();
        const broadcast = tabBroadcast.broadcastTabMessage({type: 'translationCacheCleared'});
        await vi.waitFor(() => expect(ports.browser.storage.session.get).toHaveBeenCalledOnce());
        ports.removedListeners[0]!(7);
        release({[TAB_BROADCAST_SESSION_KEY]: [7, 90]});
        await broadcast;
        expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(90, {type: 'translationCacheCleared'});
        expect(ports.browser.tabs.sendMessage.mock.calls.every(([id]) => id !== 7)).toBe(true);
        expect(ports.browser.tabs.query).not.toHaveBeenCalled();
    });

    it('唯一后台入口把同一接收者实例接到四个工厂与配置读取', () => {
        const source = readFileSync(resolve(__dirname, '../src/app/background/messageRuntime.ts'), 'utf8');
        expect(source).toContain('const tabBroadcast = installBrowserTabBroadcastRuntime(capabilities.browser)');
        expect(source).toContain('createPersonalCorrectionRuntimeHandlers<BackgroundRuntimeContext>(tabBroadcast)');
        expect(source).toContain('createConfigBackgroundHandlers<BackgroundRuntimeContext>(tabBroadcast.registerContentReceiver)');
        expect(source).toContain('installBrowserConfigStorageBroadcast(tabBroadcast)');
        expect(source.match(/\.\.\.tabBroadcast/g)).toHaveLength(2);
        expect(source).not.toContain('browser.tabs.query({})');
    });

    it('真实配置广播安装取消后，迟到的会话加载不发送或补发通知', async () => {
        let release!: (value: unknown) => void;
        ports.browser.storage.session.get.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        const dispose = installBrowserConfigStorageBroadcast(tabBroadcast);
        ports.watchers.get('local:config')?.({on: false});
        await vi.waitFor(() => expect(ports.browser.storage.session.get).toHaveBeenCalledOnce());
        dispose();
        release({[TAB_BROADCAST_SESSION_KEY]: [7]});
        await tabBroadcast.queryTabs();
        await tabBroadcast.queryTabs();
        expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalled();
        expect(ports.watchers.size).toBe(0);
        expect(ports.browser.runtime.sendMessage).toHaveBeenCalledWith({type: 'configStorageChanged', key: 'local:config'});
    });

    it('共享装配保留 OCR 元数据端口的原键映射', async () => {
        ports.storage.getItem.mockResolvedValue({languages: ['en']});
        ports.storage.setItem.mockResolvedValue(undefined);
        const storage = createConfigImageOcrLanguageStorage();
        await expect(storage.get('fluentReadImageOcrLanguages')).resolves.toEqual({fluentReadImageOcrLanguages: {languages: ['en']}});
        await storage.set({fluentReadImageOcrLanguages: {languages: ['zh']}});
        expect(ports.storage.getItem).toHaveBeenCalledWith('local:fluentReadImageOcrLanguages');
        expect(ports.storage.setItem).toHaveBeenCalledWith('local:fluentReadImageOcrLanguages', {languages: ['zh']});
    });

    it('扩展自身页面不登记为 Safari 网页接收者，真实网页仍能接收通知', async () => {
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        await tabBroadcast.registerContentReceiver({id: 'fluentread', url: 'safari-web-extension://fluentread/options.html', tab: {id: 11}});
        await tabBroadcast.registerContentReceiver({id: 'fluentread', url: 'https://example.test/article', tab: {id: 7}});
        await tabBroadcast.broadcastTabMessage({type: 'translationCacheCleared'});
        expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'translationCacheCleared'});
        expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalledWith(11, expect.anything());
        expect(ports.browser.storage.session.set).toHaveBeenLastCalledWith({[TAB_BROADCAST_SESSION_KEY]: [7]});
    });

    it('OCR 元数据持久化读写失败会传递错误，恢复后可以重试', async () => {
        const storage = createConfigImageOcrLanguageStorage();
        const failure = new Error('fixture storage failure');
        ports.storage.getItem.mockRejectedValueOnce(failure).mockResolvedValueOnce({languages: ['en']});
        await expect(storage.get('fluentReadImageOcrLanguages')).rejects.toBe(failure);
        await expect(storage.get('fluentReadImageOcrLanguages')).resolves.toEqual({fluentReadImageOcrLanguages: {languages: ['en']}});
        ports.storage.setItem.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
        await expect(storage.set({fluentReadImageOcrLanguages: {languages: ['zh']}})).rejects.toBe(failure);
        await expect(storage.set({fluentReadImageOcrLanguages: {languages: ['zh']}})).resolves.toBeUndefined();
        expect(ports.storage.setItem).toHaveBeenCalledTimes(2);
        expect(ports.storage.setItem).toHaveBeenLastCalledWith('local:fluentReadImageOcrLanguages', {languages: ['zh']});
    });

    it('真实会话故障只告警，配置读取仍能完成并在后续广播恢复', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        ports.browser.storage.session.get.mockRejectedValueOnce(new Error('session wake failure'));
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        const handler = createConfigStorageReadHandler({ready: Promise.resolve(), read: async () => ({on: true}),
            isExtensionUrl: () => false, registerContentReceiver: tabBroadcast.registerContentReceiver});
        await expect(handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {sender: {id: 'fluentread', tab: {id: 7}}}))
            .resolves.toEqual({success: true, value: {on: true}});
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Safari 网页通知接收者暂未同步'));
        await tabBroadcast.broadcastTabMessage({type: 'translationCacheCleared'});
        expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'translationCacheCleared'});
        expect(ports.browser.tabs.query).not.toHaveBeenCalled();
    });

    it('共享端口失败沿原广播错误边界处理，不重新枚举任何标签', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const failure = new Error('injected shared port failure');
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        const failed = {...tabBroadcast, broadcastTabMessage: vi.fn().mockRejectedValue(failure)};
        const dispose = installBrowserConfigStorageBroadcast(failed);
        ports.watchers.get('local:config')?.({on: false});
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 网页配置变化广播失败', failure));
        ports.browser.runtime.sendMessage.mockRejectedValueOnce(new Error('runtime unavailable'));
        ports.watchers.get('local:configHistory')?.({entries: []});
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 扩展配置变化广播失败', expect.any(Error)));
        const cacheWarn = vi.fn();
        await createTranslationCacheInvalidationBroadcaster({...failed, warn: cacheWarn})();
        expect(cacheWarn).toHaveBeenCalledWith('[FluentRead] 翻译缓存清理完成广播失败', failure);
        createBrowserVocabularyBookChangedBroadcaster({...failed, sendRuntimeMessage: ports.browser.runtime.sendMessage})('clear');
        await vi.waitFor(() => expect(failed.broadcastTabMessage).toHaveBeenCalledWith({type: 'fluentReadVocabularyBookChanged', reason: 'clear'}));
        expect(ports.browser.tabs.query).not.toHaveBeenCalled();
        expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalled();
        dispose();
    });
});

describe('真实共享广播挂起时的缓存清理回复', () => {
    beforeEach(() => {vi.useFakeTimers();});
    afterEach(() => {
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it.each(['chrome', 'safari'])('%s 挂起投递只占用1000毫秒，其他页面立即收到失效且迟到完成不再回复', async browserName => {
        let finish!: () => void;
        const delivery = new Promise<void>(resolve => {finish = resolve;});
        ports.browser.storage.session.get.mockResolvedValue({[TAB_BROADCAST_SESSION_KEY]: [7, 90]});
        ports.browser.tabs.sendMessage.mockImplementation(async id => id === 7 ? delivery : undefined);
        const clear = vi.fn(async () => undefined);
        const warn = vi.fn();
        const settled = vi.fn();
        const broadcast = createTranslationCacheInvalidationBroadcaster({...installBrowserTabBroadcastRuntime(browserName), warn});
        const handler = createTranslationCacheHandler(clear, broadcast);
        const request = Promise.resolve(handler.handle({type: 'clearTranslationCache'}, undefined)).then(settled);
        try {
            await vi.advanceTimersByTimeAsync(999);
            expect(clear).toHaveBeenCalledOnce();
            expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'translationCacheCleared'});
            expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(90, {type: 'translationCacheCleared'});
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toHaveBeenCalledWith({success: true, invalidationPending: true});
        } finally {
            finish();
            await request;
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each(['chrome', 'safari'])('%s 接收者读取挂起时仍返回清库成功，恢复后原失效消息继续投递', async browserName => {
        let finish!: () => void;
        if (browserName === 'safari') {
            ports.browser.storage.session.get.mockImplementationOnce(() => new Promise(resolve => {
                finish = () => resolve({[TAB_BROADCAST_SESSION_KEY]: [7]});
            }));
        } else {
            ports.browser.tabs.query.mockImplementationOnce(() => new Promise(resolve => {
                finish = () => resolve([{id: 7}]);
            }));
        }
        const warn = vi.fn();
        const settled = vi.fn();
        const broadcast = createTranslationCacheInvalidationBroadcaster({...installBrowserTabBroadcastRuntime(browserName), warn});
        const handler = createTranslationCacheHandler(async () => undefined, broadcast);
        const request = Promise.resolve(handler.handle({type: 'clearTranslationCache'}, undefined)).then(settled);
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalled();
            expect(settled).toHaveBeenCalledWith({success: true, invalidationPending: true});
        } finally {
            finish();
            await request;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(ports.browser.tabs.sendMessage).toHaveBeenCalledOnce();
        expect(ports.browser.tabs.sendMessage).toHaveBeenCalledWith(7, {type: 'translationCacheCleared'});
        expect(settled).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('共享查询迟到拒绝仍记录原告警，已完成的清库回复不改变', async () => {
        let fail!: (error: Error) => void;
        ports.browser.tabs.query.mockImplementationOnce(() => new Promise((_, reject) => {fail = reject;}));
        const failure = new Error('late tabs query failure');
        const warn = vi.fn();
        const settled = vi.fn();
        const broadcast = createTranslationCacheInvalidationBroadcaster({...installBrowserTabBroadcastRuntime('chrome'), warn});
        const handler = createTranslationCacheHandler(async () => undefined, broadcast);
        const request = Promise.resolve(handler.handle({type: 'clearTranslationCache'}, undefined)).then(settled);
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(settled).toHaveBeenCalledWith({success: true, invalidationPending: true});
        } finally {
            fail(failure);
            await request;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith('[FluentRead] 翻译缓存清理完成广播失败', failure);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalled();
    });
});

describe('真实配置 handler 的登记顺序与故障边界', () => {
    it('ready 之后先完成登记尝试，再读取快照，登记期间提交不会返回旧配置', async () => {
        let releaseReady!: () => void; let releaseRegistration!: () => void;
        let revision = 1;
        const calls: string[] = [];
        const handler = createConfigStorageReadHandler({
            ready: new Promise<void>(resolve => {releaseReady = resolve;}),
            read: async () => {calls.push('read'); return {revision};},
            isExtensionUrl: () => false,
            registerContentReceiver: async () => {calls.push('register'); await new Promise<void>(resolve => {releaseRegistration = resolve;});},
        });
        const response = handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {sender: {id: 'fluentread', tab: {id: 7}}});
        expect(calls).toEqual([]); releaseReady();
        await vi.waitFor(() => expect(calls).toEqual(['register']));
        revision = 2; releaseRegistration();
        await expect(response).resolves.toEqual({success: true, value: {revision: 2}});
        expect(calls).toEqual(['register', 'read']);
    });

    it('等待 ready 时关闭标签，旧 sender 恢复读取不会重新登记', async () => {
        const tabBroadcast = installBrowserTabBroadcastRuntime('safari');
        let releaseReady!: () => void;
        const handler = createConfigStorageReadHandler({
            ready: new Promise<void>(resolve => {releaseReady = resolve;}), read: async () => ({on: true}),
            isExtensionUrl: () => false, registerContentReceiver: tabBroadcast.registerContentReceiver,
        });
        const response = handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {sender: {id: 'fluentread', tab: {id: 7}}});
        await tabBroadcast.removeTab(7); releaseReady(); await response;
        await tabBroadcast.broadcastTabMessage({type: 'translationCacheCleared'});
        expect(ports.browser.tabs.sendMessage).not.toHaveBeenCalled();
        expect(await tabBroadcast.queryTabs()).toEqual([]);
    });

    it('拒绝的记录不登记，扩展 UI 仍有原授权，登记失败也不阻断无凭据快照', async () => {
        const register = vi.fn().mockRejectedValue(new Error('session unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handler = createConfigStorageReadHandler({ready: Promise.resolve(), read: async () => ({safe: true, apiKey: 'secret'}),
            isExtensionUrl: url => url.startsWith('safari-web-extension:'), registerContentReceiver: register});
        await expect(handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'session:credentials'}, {sender: {url: 'https://example.com'}})).rejects.toThrow('无权读取配置凭据');
        await expect(handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {sender: {url: 'safari-web-extension://fluentread/options.html'}})).resolves.toEqual({success: true, value: {safe: true, apiKey: 'secret'}});
        expect(register).not.toHaveBeenCalled();
        await expect(handler.handle({type: CONFIG_STORAGE_READ_MESSAGE, key: 'local:config'}, {sender: {id: 'fluentread', tab: {id: 7}}})).resolves.toEqual({success: true, value: {safe: true}});
        expect(warn).toHaveBeenCalledWith('[FluentRead] 网页配置通知登记失败');
    });
});
