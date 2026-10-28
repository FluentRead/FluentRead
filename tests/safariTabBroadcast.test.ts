/**
 * @file tests/safariTabBroadcast.test.ts
 * 文件职责：验证 Safari 无值通知的接收者发现、非持久后台恢复和异步操作归属。
 * 主要内容：以可延迟、可失败的会话存储和网页响应端口覆盖冷唤醒、可信 iframe、加载与关闭交错、失败恢复、有限失效意图和合并广播的等待语义。
 * 模块边界：只验证注入端口的确定性契约；不表示 Safari API 可用性、浏览器真实重启、站点授权或页面实际渲染已通过验收。
 */
import {describe, expect, it, vi} from 'vitest';
import {
    createTabBroadcastRuntime,
    type TabBroadcastDependencies,
    type TabBroadcastSender,
} from '@/src/app/background/tabBroadcast';

const extensionId = 'fixture-fluentread-extension';
const extensionOrigin = 'safari-web-extension://fixture-fluentread/';
const configChanged = {type: 'configStorageChanged', key: 'local:config'} as const;
const cacheCleared = {type: 'translationCacheCleared'} as const;
const vocabularyChanged = {type: 'fluentReadVocabularyBookChanged', reason: 'upsert', entryId: 'opaque-id'} as const;
const invalidations = [
    configChanged,
    {type: 'fluentReadReadingModelInputsChanged'},
    cacheCleared,
    vocabularyChanged,
    {type: 'fluentReadPersonalCorrectionsChanged'},
] as const;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}

function contentSender(id: number, url = 'https://page.example/article'): TabBroadcastSender {
    return {id: extensionId, url, tab: {id}};
}

function harness(initialRecipients: unknown = undefined, browserName = 'safari') {
    const session = {value: initialRecipients};
    const readSessionRecipients = vi.fn(async (): Promise<unknown> => (
        Array.isArray(session.value) ? [...session.value] : session.value
    ));
    const writeSessionRecipients = vi.fn(async (tabIds: number[]): Promise<void> => {
        session.value = [...tabIds];
    });
    const queryTabs = vi.fn(async (): Promise<Array<{id?: number}>> => [{id: 801}, {id: 802}]);
    const sendTabMessage = vi.fn(async (_tabId: number, _message: unknown): Promise<unknown> => undefined);
    const warn = vi.fn<(message: string) => void>();
    const dependencies: TabBroadcastDependencies = {
        browserName,
        extensionId,
        isExtensionUrl: url => url.startsWith(extensionOrigin),
        queryTabs,
        sendTabMessage,
        readSessionRecipients,
        writeSessionRecipients,
        warn,
    };
    return {
        runtime: createTabBroadcastRuntime(dependencies), dependencies, session,
        readSessionRecipients, writeSessionRecipients, queryTabs, sendTabMessage, warn,
    };
}

function deliveries(send: ReturnType<typeof harness>['sendTabMessage']) {
    return send.mock.calls.map(([tabId, message]) => ({tabId, message}));
}

describe('Safari 接收者会话与可信配置读取发送方', () => {
    it('新后台实例从同一浏览器会话恢复旧接收者，不枚举标签或要求页面重新读取', async () => {
        const page = harness([21, 42]);
        await page.runtime.registerContentReceiver(contentSender(63));
        expect(page.session.value).toEqual([21, 42, 63]);
        page.sendTabMessage.mockClear();

        // 旧实例不再执行；第二个实例只有会话端口，没有沿用旧内存集合。
        const woken = createTabBroadcastRuntime(page.dependencies);
        await woken.broadcastTabMessage(cacheCleared);

        expect(deliveries(page.sendTabMessage)).toEqual([
            {tabId: 21, message: cacheCleared},
            {tabId: 42, message: cacheCleared},
            {tabId: 63, message: cacheCleared},
        ]);
        expect(page.readSessionRecipients).toHaveBeenCalledTimes(2);
        expect(page.queryTabs).not.toHaveBeenCalled();
    });

    it('会话记录只采用合法整数 ID，重复、负数和损坏值不能成为接收者', async () => {
        const page = harness([0, 21, 21, -1, 1.5, NaN, Infinity, '42', null, Number.MAX_SAFE_INTEGER + 1]);

        await page.runtime.broadcastTabMessage(configChanged);

        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([0, 21]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.queryTabs).not.toHaveBeenCalled();
    });

    it('可信子 frame、about:blank、临时访问页面及无 URL 的发送方都能登记', async () => {
        const page = harness();
        const iframe = {...contentSender(42, 'https://authorized-frame.example/embed'), frameId: 7,
            tab: {id: 42, url: 'https://ungranted-parent.example/'}};
        const blank = {...contentSender(21, 'about:blank'), frameId: 3};
        const activeTabPage = contentSender(63, 'https://temporary-access.example/article');

        await Promise.all([
            page.runtime.registerContentReceiver(blank),
            page.runtime.registerContentReceiver(iframe),
            page.runtime.registerContentReceiver(activeTabPage),
            page.runtime.registerContentReceiver({id: extensionId, tab: {id: 84}}),
            page.runtime.registerContentReceiver(contentSender(0)),
        ]);
        await page.runtime.broadcastTabMessage(cacheCleared);

        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([0, 21, 42, 63, 84]);
        expect(page.session.value).toEqual([0, 21, 42, 63, 84]);
        expect(page.queryTabs).not.toHaveBeenCalled();
        expect(JSON.stringify(page.writeSessionRecipients.mock.calls)).not.toContain('example');
        expect(JSON.stringify(page.writeSessionRecipients.mock.calls)).not.toContain('about:blank');
    });

    const invalidSenders: Array<[string, TabBroadcastSender | undefined]> = [
        ['缺失 sender', undefined],
        ['其他扩展', {id: 'another-extension', tab: {id: 21}}],
        ['缺失扩展身份', {tab: {id: 21}}],
        ['没有 tab', {id: extensionId, url: 'https://page.example/'}],
        ['负数 ID', contentSender(-1)],
        ['小数 ID', contentSender(1.5)],
        ['NaN ID', contentSender(NaN)],
        ['无穷 ID', contentSender(Infinity)],
        ['不安全整数 ID', contentSender(Number.MAX_SAFE_INTEGER + 1)],
        ['字符串 ID', {id: extensionId, tab: {id: '21'}} as unknown as TabBroadcastSender],
        ['扩展 UI 标签页', contentSender(21, `${extensionOrigin}options.html`)],
        ['扩展 UI iframe', contentSender(42, `${extensionOrigin}popup.html`)],
    ];
    it.each(invalidSenders)('%s 不读取或改写接收者会话', async (_label, sender) => {
        const page = harness([63]);

        await page.runtime.registerContentReceiver(sender);

        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.sendTabMessage).not.toHaveBeenCalled();
        expect(page.queryTabs).not.toHaveBeenCalled();
    });

    it('浏览器新会话使用空存储的新后台实例，不复用上一会话的 ID', async () => {
        const page = harness([21, 42]);
        await page.runtime.broadcastTabMessage(cacheCleared);
        await page.runtime.removeTab(21);
        page.sendTabMessage.mockClear();

        // 这是 session 生命周期模型，不是实际浏览器重启操作。
        page.session.value = undefined;
        const restarted = createTabBroadcastRuntime(page.dependencies);
        await restarted.broadcastTabMessage(cacheCleared);
        expect(page.sendTabMessage).not.toHaveBeenCalled();

        // 新会话可合法产生同一个数值 ID，不能沿用旧后台的 closed tombstone。
        await restarted.registerContentReceiver(contentSender(21));
        await restarted.broadcastTabMessage(cacheCleared);
        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([21]);
        expect(page.session.value).toEqual([21]);
        expect(page.queryTabs).not.toHaveBeenCalled();
    });
});

describe('Safari 登记与移除的异步归属', () => {
    it('无效关闭 ID 不触发会话访问，未登记页关闭不改写已有集合', async () => {
        const page = harness([21]);
        for (const id of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await page.runtime.removeTab(id);
        }
        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();

        await page.runtime.queryTabs();
        await page.runtime.removeTab(999);

        expect(await page.runtime.queryTabs()).toEqual([{id: 21}]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
    });

    it('旧会话读取挂起时的新登记与关闭合并，旧快照不能复活已关闭 ID', async () => {
        const page = harness();
        const loading = deferred<unknown>();
        page.readSessionRecipients.mockReturnValueOnce(loading.promise);
        const initial = page.runtime.queryTabs();
        await vi.waitFor(() => expect(page.readSessionRecipients).toHaveBeenCalledTimes(1));

        const added = page.runtime.registerContentReceiver(contentSender(63));
        const repeated = page.runtime.registerContentReceiver(contentSender(63, 'about:blank'));
        const removed = page.runtime.removeTab(21);
        const stillOpen = page.runtime.registerContentReceiver(contentSender(42, 'about:blank'));
        loading.resolve([21, 42]);
        await Promise.all([initial, added, repeated, removed, stillOpen]);

        expect(await page.runtime.queryTabs()).toEqual([{id: 42}, {id: 63}]);
        expect(page.session.value).toEqual([42, 63]);
        await page.runtime.broadcastTabMessage(cacheCleared);
        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([42, 63]);
    });

    it('旧登记写入完成不能吞掉同 ID 的新移除', async () => {
        const page = harness([21]);
        const writing = deferred<void>();
        page.writeSessionRecipients.mockImplementationOnce(async ids => {
            await writing.promise;
            page.session.value = [...ids];
        });
        const first = page.runtime.registerContentReceiver(contentSender(42));
        await vi.waitFor(() => expect(page.writeSessionRecipients).toHaveBeenCalledTimes(1));

        const latest = page.runtime.removeTab(42);
        writing.resolve(undefined);
        await Promise.all([first, latest]);

        expect(await page.runtime.queryTabs()).toEqual([{id: 21}]);
        expect(page.session.value).toEqual([21]);
    });

    it('配置 ready 期间关闭标签后，迟到的旧发送方不能重新登记', async () => {
        const page = harness([21, 42]);
        const ready = deferred<void>();
        const lateReadRegistration = ready.promise.then(() => page.runtime.registerContentReceiver(contentSender(21)));

        await page.runtime.removeTab(21);
        ready.resolve(undefined);
        await lateReadRegistration;
        await page.runtime.broadcastTabMessage(cacheCleared);

        expect(await page.runtime.queryTabs()).toEqual([{id: 42}]);
        expect(page.session.value).toEqual([42]);
        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([42]);
    });

    it('会话发送失败不删除登记，后续失效仍通知该页面', async () => {
        const page = harness([21]);
        page.sendTabMessage.mockRejectedValueOnce(new Error('page temporarily suspended'));

        await expect(page.runtime.broadcastTabMessage(cacheCleared)).resolves.toBeUndefined();
        await page.runtime.broadcastTabMessage(configChanged);

        expect(deliveries(page.sendTabMessage)).toEqual([
            {tabId: 21, message: cacheCleared},
            {tabId: 21, message: configChanged},
        ]);
        expect(await page.runtime.queryTabs()).toEqual([{id: 21}]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
    });
});

describe('Safari 存储失败与无值失效恢复', () => {
    it('首读失败不覆盖未知旧集合，恢复后合并增删并仅补发五类无值意图', async () => {
        const page = harness([21, 42]);
        let unavailable = true;
        page.readSessionRecipients.mockImplementation(async () => {
            if (unavailable) throw new Error('session temporarily unavailable');
            return Array.isArray(page.session.value) ? [...page.session.value] : page.session.value;
        });
        await expect(page.runtime.registerContentReceiver(contentSender(63))).resolves.toBeUndefined();
        await expect(page.runtime.removeTab(21)).resolves.toBeUndefined();

        for (let round = 0; round < 3; round += 1) {
            for (const message of invalidations) {
                await page.runtime.broadcastTabMessage({...message,
                    reason: message.type === vocabularyChanged.type ? 'upsert' : `fixture-${round}`,
                    entryId: message.type === vocabularyChanged.type ? 'opaque-id' : `private-entry-${round}`,
                    body: 'fixture content must not be broadcast',
                    url: 'https://private.example/fixture'});
            }
        }
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.session.value).toEqual([21, 42]);
        // 未知旧 ID 不能靠全标签查询补救；本轮只尝试已知的新接收者。
        expect(new Set(page.sendTabMessage.mock.calls.map(([id]) => id))).toEqual(new Set([63]));
        expect(page.queryTabs).not.toHaveBeenCalled();
        page.sendTabMessage.mockClear();

        unavailable = false;
        expect(await page.runtime.queryTabs()).toEqual([{id: 42}, {id: 63}]);
        await vi.waitFor(() => expect(page.sendTabMessage).toHaveBeenCalledTimes(10));

        for (const id of [42, 63]) {
            expect(page.sendTabMessage.mock.calls.filter(([tabId]) => tabId === id).map(([, message]) => message))
                .toEqual([...invalidations]);
        }
        expect(page.session.value).toEqual([42, 63]);
        expect(page.warn).toHaveBeenCalled();
        expect(JSON.stringify(page.sendTabMessage.mock.calls)).not.toContain('private-entry');
        expect(JSON.stringify(page.sendTabMessage.mock.calls)).not.toContain('fixture content');
        expect(JSON.stringify(page.writeSessionRecipients.mock.calls)).not.toContain('private.example');
        expect(JSON.stringify(page.writeSessionRecipients.mock.calls)).not.toContain('opaque-id');
    });

    it('未知形状的会话记录不能被当作空记录覆盖，读恢复后仍保留旧接收者', async () => {
        const page = harness({unexpected: 'fixture shape'});

        await page.runtime.registerContentReceiver(contentSender(63));
        await page.runtime.broadcastTabMessage(cacheCleared);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();

        page.session.value = [21];
        expect(await page.runtime.queryTabs()).toEqual([{id: 21}, {id: 63}]);
        await vi.waitFor(() => expect(page.sendTabMessage).toHaveBeenCalledWith(21, cacheCleared));
        expect(page.session.value).toEqual([21, 63]);
    });

    it('写入失败仍通知已知接收者，并在后续操作重试持久化', async () => {
        const page = harness([21]);
        page.writeSessionRecipients
            .mockRejectedValueOnce(new Error('first write unavailable'))
            .mockRejectedValueOnce(new Error('second write unavailable'));

        await expect(page.runtime.registerContentReceiver(contentSender(42))).resolves.toBeUndefined();
        await expect(page.runtime.broadcastTabMessage(cacheCleared)).resolves.toBeUndefined();
        expect(page.sendTabMessage.mock.calls.map(([id]) => id)).toEqual([21, 42]);
        expect(page.session.value).toEqual([21]);

        expect(await page.runtime.queryTabs()).toEqual([{id: 21}, {id: 42}]);
        expect(page.session.value).toEqual([21, 42]);
        expect(page.readSessionRecipients).toHaveBeenCalledTimes(1);
        expect(page.writeSessionRecipients).toHaveBeenCalledTimes(3);
    });

    it('正常词书通知保留既有合法 reason 和不透明 entryId，但不转发额外正文', async () => {
        const page = harness([21]);

        await page.runtime.broadcastTabMessage({...vocabularyChanged,
            body: 'fixture private vocabulary text', url: 'https://private.example/fixture'});
        await page.runtime.broadcastTabMessage({type: vocabularyChanged.type, reason: 'clear'});
        await page.runtime.broadcastTabMessage({type: vocabularyChanged.type, reason: 'undo', body: 'private snapshot'});

        expect(deliveries(page.sendTabMessage)).toEqual([
            {tabId: 21, message: vocabularyChanged},
            {tabId: 21, message: {type: vocabularyChanged.type, reason: 'clear'}},
            {tabId: 21, message: {type: vocabularyChanged.type, reason: 'undo'}},
        ]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
    });

    it('同类词书通知在冷读取期间合并为最新合法元数据，不持久化 entryId', async () => {
        const page = harness([21]);
        const loading = deferred<unknown>();
        page.readSessionRecipients.mockReturnValueOnce(loading.promise);
        const first = page.runtime.broadcastTabMessage(vocabularyChanged);
        const latestMessage = {type: vocabularyChanged.type, reason: 'note', entryId: 'latest-opaque-id'};
        const latest = page.runtime.broadcastTabMessage(latestMessage);

        loading.resolve([21]);
        await Promise.all([first, latest]);

        expect(deliveries(page.sendTabMessage)).toEqual([{tabId: 21, message: latestMessage}]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.session.value).toEqual([21]);
    });

    it.each([
        null, [], 'translationCacheCleared', {},
        {type: 'configStorageChanged', key: 'local:credentials'},
        {type: 'configStorageChanged'}, {type: 'unrecognized-event'},
        {type: 'fluentReadVocabularyBookChanged'},
        {type: 'fluentReadVocabularyBookChanged', reason: 'unrecognized-reason'},
    ])('拒绝不属于五种无值意图的请求 %#', async message => {
        const page = harness([21]);

        await expect(page.runtime.broadcastTabMessage(message)).rejects.toThrow('不支持的网页失效通知');

        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.sendTabMessage).not.toHaveBeenCalled();
    });
});

describe('广播调用者与网页响应的归属', () => {
    it('合并广播的每个调用者都等自己的投递尝试结束，缓存清理不能提前确认', async () => {
        const page = harness([21]);
        const loading = deferred<unknown>();
        const delivery = deferred<unknown>();
        const cacheFinished = vi.fn();
        page.readSessionRecipients.mockReturnValueOnce(loading.promise);
        page.sendTabMessage.mockImplementation(async (_id, message) => {
            if ((message as {type?: string}).type === cacheCleared.type) return delivery.promise;
            return undefined;
        });
        const first = page.runtime.broadcastTabMessage(configChanged);
        const cache = page.runtime.broadcastTabMessage(cacheCleared).then(cacheFinished);
        loading.resolve([21]);
        await vi.waitFor(() => expect(page.sendTabMessage).toHaveBeenCalledWith(21, cacheCleared));
        // 公共队列屏障确认第二个调用的登记规划已经完成；网页回复仍明确挂起。
        await page.runtime.queryTabs();
        try {
            expect(cacheFinished).not.toHaveBeenCalled();
        } finally {
            delivery.resolve(undefined);
            await Promise.all([first, cache]);
        }
        expect(cacheFinished).toHaveBeenCalledTimes(1);
    });

    it('恢复补发等待网页响应时，可信配置读取重新登记不会互相等待', async () => {
        const page = harness([21]);
        page.readSessionRecipients.mockRejectedValueOnce(new Error('wake-time read unavailable'));
        await page.runtime.broadcastTabMessage(configChanged);
        page.sendTabMessage.mockImplementation(async id => {
            await page.runtime.registerContentReceiver(contentSender(id));
            return undefined;
        });

        await page.runtime.registerContentReceiver(contentSender(42));
        await vi.waitFor(() => expect(page.sendTabMessage).toHaveBeenCalledTimes(2));

        expect(await page.runtime.queryTabs()).toEqual([{id: 21}, {id: 42}]);
        expect(page.queryTabs).not.toHaveBeenCalled();
    });
});

describe('通知所属生命周期取消', () => {
    it.each(['safari', 'chrome', 'firefox'])('%s 调用前已取消的通知不启动接收者发现或投递', async browserName => {
        const page = harness([21], browserName);
        const owner = new AbortController();
        owner.abort();

        await expect(page.runtime.broadcastTabMessage(configChanged, owner.signal)).resolves.toBeUndefined();

        expect(page.queryTabs).not.toHaveBeenCalled();
        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.sendTabMessage).not.toHaveBeenCalled();
        expect(page.warn).not.toHaveBeenCalled();
        expect(page.session.value).toEqual([21]);
    });

    it('Safari 冷会话读取挂起后取消，读取完成及后续恢复都不能发送旧通知', async () => {
        const page = harness([21, 42]);
        const loading = deferred<unknown>();
        const owner = new AbortController();
        page.readSessionRecipients.mockReturnValueOnce(loading.promise);
        const broadcast = page.runtime.broadcastTabMessage(configChanged, owner.signal);
        await vi.waitFor(() => expect(page.readSessionRecipients).toHaveBeenCalledTimes(1));

        owner.abort();
        loading.resolve([21, 42]);
        await expect(broadcast).resolves.toBeUndefined();
        await page.runtime.queryTabs();
        await page.runtime.queryTabs();

        expect(page.sendTabMessage).not.toHaveBeenCalled();
        expect(page.queryTabs).not.toHaveBeenCalled();
        expect(page.session.value).toEqual([21, 42]);
    });

    it('首读失败保留的通知在 owner 取消后不能随会话恢复补发', async () => {
        const page = harness([21]);
        const owner = new AbortController();
        page.readSessionRecipients.mockRejectedValueOnce(new Error('session unavailable during wake'));
        await expect(page.runtime.broadcastTabMessage(configChanged, owner.signal)).resolves.toBeUndefined();
        expect(page.sendTabMessage).not.toHaveBeenCalled();

        owner.abort();
        expect(await page.runtime.queryTabs()).toEqual([{id: 21}]);
        await page.runtime.broadcastTabMessage(cacheCleared);

        expect(deliveries(page.sendTabMessage)).toEqual([{tabId: 21, message: cacheCleared}]);
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
    });

    it.each(['first', 'latest'] as const)('同类不同 owner 并发，取消 %s 不吞掉另一个 owner 的通知或留下挂起调用', async cancelled => {
        const page = harness([21]);
        const loading = deferred<unknown>();
        const firstOwner = new AbortController();
        const latestOwner = new AbortController();
        const firstMessage = {...vocabularyChanged, entryId: 'first-owner-entry'};
        const latestMessage = {type: vocabularyChanged.type, reason: 'note', entryId: 'latest-owner-entry'};
        page.readSessionRecipients.mockReturnValueOnce(loading.promise);
        const first = page.runtime.broadcastTabMessage(firstMessage, firstOwner.signal);
        const latest = page.runtime.broadcastTabMessage(latestMessage, latestOwner.signal);
        await vi.waitFor(() => expect(page.readSessionRecipients).toHaveBeenCalledTimes(1));

        (cancelled === 'first' ? firstOwner : latestOwner).abort();
        loading.resolve([21]);
        await expect(Promise.all([first, latest])).resolves.toEqual([undefined, undefined]);
        await page.runtime.queryTabs();

        expect(deliveries(page.sendTabMessage)).toEqual([
            {tabId: 21, message: cancelled === 'first' ? latestMessage : firstMessage},
        ]);
    });

    it('发送期间 owner 取消后，尚未调用浏览器 API 的其他接收者不能继续收到通知', async () => {
        const page = harness([21, 42]);
        const owner = new AbortController();
        page.sendTabMessage.mockImplementation(async id => {
            if (id === 21) owner.abort();
            return undefined;
        });

        await expect(page.runtime.broadcastTabMessage(configChanged, owner.signal)).resolves.toBeUndefined();
        await page.runtime.queryTabs();

        // 已发出的第一条不能撤回；后续 API 调用必须重新核验 owner。
        expect(deliveries(page.sendTabMessage)).toEqual([{tabId: 21, message: configChanged}]);
    });

    it.each(['chrome', 'edge', 'firefox'])('%s 标签查询挂起后 owner 取消，查询完成不能再投递', async browserName => {
        const page = harness(undefined, browserName);
        const querying = deferred<Array<{id?: number}>>();
        const owner = new AbortController();
        page.queryTabs.mockReturnValueOnce(querying.promise);
        const broadcast = page.runtime.broadcastTabMessage(configChanged, owner.signal);
        await vi.waitFor(() => expect(page.queryTabs).toHaveBeenCalledTimes(1));

        owner.abort();
        querying.resolve([{id: 21}, {id: 42}]);
        await expect(broadcast).resolves.toBeUndefined();

        expect(page.sendTabMessage).not.toHaveBeenCalled();
        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
    });
});

describe('其他浏览器保持原有标签查询', () => {
    it.each(['chrome', 'edge', 'firefox'])('%s 不读写 Safari 接收者会话', async browserName => {
        const page = harness([21], browserName);
        const message = {type: 'fixture-original-message', reason: 'preserve-original-payload'};

        await page.runtime.registerContentReceiver(contentSender(63));
        await page.runtime.removeTab(21);
        await page.runtime.broadcastTabMessage(message);
        expect(await page.runtime.queryTabs()).toEqual([{id: 801}, {id: 802}]);
        await page.runtime.sendTabMessage(803, message);

        expect(deliveries(page.sendTabMessage)).toEqual([
            {tabId: 801, message}, {tabId: 802, message}, {tabId: 803, message},
        ]);
        expect(page.queryTabs).toHaveBeenCalledTimes(2);
        expect(page.readSessionRecipients).not.toHaveBeenCalled();
        expect(page.writeSessionRecipients).not.toHaveBeenCalled();
        expect(page.warn).not.toHaveBeenCalled();
    });
});
