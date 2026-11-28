import {beforeEach, describe, expect, it, vi} from 'vitest';

const storageMock = vi.hoisted(() => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
}));

vi.mock('@wxt-dev/storage', () => ({storage: storageMock}));

import {
    createEmptyPrivacyActivitySnapshot,
    PRIVACY_ACTIVITY_MESSAGE_TYPE,
} from '@/src/core/privacy/activity';
import {
    createPrivacyActivityRepository,
    getPrivacyActivityRepository,
    PRIVACY_ACTIVITY_STORAGE_KEY,
} from '@/src/platform/storage/privacyActivityRepository';
import {createPrivacyActivityHandler} from '@/src/app/background/handlers/privacyActivity';

describe('privacy activity repository', () => {
    beforeEach(() => {
        storageMock.getItem.mockReset();
        storageMock.setItem.mockReset();
        storageMock.removeItem.mockReset();
    });

    it('records, caches, clones snapshots, and clears via injected storage port', async () => {
        let persisted: unknown = null;
        let removed = false;
        const port = {
            load: vi.fn(async () => persisted),
            save: vi.fn(async (value: unknown) => {persisted = value; removed = false;}),
            remove: vi.fn(async () => {persisted = null; removed = true;}),
        };
        let clock = 1_700_000_000_000;
        const repo = createPrivacyActivityRepository({storage: port, now: () => (clock += 1_000)});

        const empty = await repo.getSnapshot();
        expect(empty.stats.totalEvents).toBe(0);
        expect(port.load).toHaveBeenCalledOnce();

        const generation = repo.captureGeneration();
        await repo.record({
            action: 'masked',
            serviceId: 'openai',
            hitCount: 2,
            categoryCounts: {email: 1, phone: 1},
            samples: [{category: 'email', masked: 'd***@e***.test'}],
        }, generation);
        await repo.record({
            action: 'blocked',
            serviceId: 'google',
            hitCount: 1,
            categoryCounts: {secret: 1},
            samples: [{category: 'secret', masked: 'sk-***'}],
        });

        const snapshot = await repo.getSnapshot();
        expect(snapshot.stats.totalEvents).toBe(2);
        expect(snapshot.stats.maskedEvents).toBe(1);
        expect(snapshot.stats.blockedEvents).toBe(1);
        expect(snapshot.stats.totalHits).toBe(3);
        expect(snapshot.records[0]?.action).toBe('blocked');
        expect(snapshot.records[1]?.action).toBe('masked');
        // 返回快照必须隔离内部缓存。
        (snapshot.records as unknown[]).push({} as never);
        expect((await repo.getSnapshot()).records).toHaveLength(2);

        await repo.clear();
        expect(removed).toBe(true);
        expect((await repo.getSnapshot()).stats.totalEvents).toBe(0);
    });

    it('drops stale-generation records queued before or during clear, and falls back to save when remove is omitted', async () => {
        let resolveLoad!: (value: unknown) => void;
        const port = {
            load: vi.fn(() => new Promise(resolve => {resolveLoad = resolve;})),
            save: vi.fn(async () => undefined),
        };
        const repo = createPrivacyActivityRepository({storage: port});
        const oldGen = repo.captureGeneration();
        const inFlight = repo.record({action: 'masked', serviceId: 'openai', hitCount: 1}, oldGen);
        await Promise.resolve();
        const firstClear = repo.clear();
        const secondClear = repo.clear();
        const staleRecord = repo.record({action: 'blocked', serviceId: 'openai', hitCount: 1}, oldGen);
        resolveLoad(createEmptyPrivacyActivitySnapshot());
        await Promise.all([inFlight, firstClear, secondClear, staleRecord]);

        expect(port.save).toHaveBeenCalledTimes(1);
        expect((await repo.getSnapshot()).stats.totalEvents).toBe(0);
    });

    it('handles storage load, save and clear failures with warnings and provides default singleton wiring', async () => {
        const warn = vi.fn();
        const failing = createPrivacyActivityRepository({
            storage: {
                load: async () => {throw new Error('load failed');},
                save: async () => {throw new Error('save failed');},
                remove: async () => {throw new Error('remove failed');},
            },
            warn,
        });

        await failing.record({action: 'masked', serviceId: 'google', hitCount: 1});
        await failing.clear();
        expect(warn).toHaveBeenCalledTimes(3);

        const defaultWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        storageMock.getItem.mockResolvedValueOnce(null);
        storageMock.setItem.mockResolvedValueOnce(undefined);
        storageMock.removeItem.mockResolvedValueOnce(undefined);
        const singleton = getPrivacyActivityRepository();
        expect(getPrivacyActivityRepository()).toBe(singleton);
        await singleton.record({action: 'masked', serviceId: 'google', hitCount: 1});
        expect(storageMock.getItem).toHaveBeenCalledWith(PRIVACY_ACTIVITY_STORAGE_KEY);
        expect(storageMock.setItem).toHaveBeenCalledWith(PRIVACY_ACTIVITY_STORAGE_KEY, expect.any(Object));
        await singleton.clear();
        expect(storageMock.removeItem).toHaveBeenCalledWith(PRIVACY_ACTIVITY_STORAGE_KEY);
        storageMock.setItem.mockRejectedValueOnce(new Error('disk full'));
        await singleton.record({action: 'masked', serviceId: 'google', hitCount: 1});
        expect(defaultWarnSpy).toHaveBeenCalled();
        defaultWarnSpy.mockRestore();
    });
});

describe('privacy activity background handler', () => {
    it('allows only options pages and handles query, clear, unsupported actions, and errors', async () => {
        const snapshot = createEmptyPrivacyActivitySnapshot();
        const repo = {
            getSnapshot: vi.fn(async () => snapshot),
            clear: vi.fn(async () => undefined),
        };
        const isOptionsUrl = vi.fn((url: string) => url.startsWith('chrome-extension://ext/options.html'));
        const handler = createPrivacyActivityHandler(repo, isOptionsUrl);
        expect(handler.type).toBe(PRIVACY_ACTIVITY_MESSAGE_TYPE);

        const trusted = {sender: {url: 'chrome-extension://ext/options.html'}};
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'query'}, trusted))
            .resolves.toEqual({success: true, data: snapshot});
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'clear'}, trusted))
            .resolves.toEqual({success: true, data: {cleared: true}});
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'unknown'}, trusted))
            .resolves.toEqual({success: false, error: '不支持的隐私防护记录操作'});

        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'query'}, {sender: {url: 'https://example.com'}}))
            .resolves.toEqual({success: false, error: '当前上下文无权访问隐私防护记录'});
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'query'}, {}))
            .resolves.toEqual({success: false, error: '当前上下文无权访问隐私防护记录'});

        repo.getSnapshot.mockRejectedValueOnce(new Error('boom'));
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'query'}, trusted))
            .resolves.toEqual({success: false, error: 'boom'});

        repo.clear.mockRejectedValueOnce('non-error');
        await expect(handler.handle({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'clear'}, trusted))
            .resolves.toEqual({success: false, error: '隐私防护记录暂时不可用'});
    });
});
