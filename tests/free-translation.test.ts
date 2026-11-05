/**
 * @file tests/free-translation.test.ts
 * 文件职责：验证真实免费池编排的匿名配置、降级、共享预算、原生分组和取消持槽边界。
 * 主要内容：仅替换各线路 transport 和配置存储；以真实结果校验验证原文回显、整段错语种、单服务检查及线路健康；新增波兰语损坏结果的标量/原生降级，保留截止时间与迟到传输容量。
 * 模块边界：不运行浏览器或实际免费服务，不替换语言识别、结果校验、免费池或调度器。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {providerConfigFixture} from './helpers/providerSnapshot';

const {mockConfig, storedHealth, microsoftMock, officialMock, bilibiliMock, doubaoMock, googleMock, googleOwnerMock, myMemoryMock, webMock, chineseMock, extraMock, unsupportedApertiumMock} = vi.hoisted(() => ({
    mockConfig: {} as Record<string, any>,
    storedHealth: {records: null as unknown},
    microsoftMock: vi.fn(),
    officialMock: vi.fn(),
    bilibiliMock: vi.fn(),
    doubaoMock: vi.fn(),
    googleMock: vi.fn(),
    googleOwnerMock: vi.fn(),
    myMemoryMock: vi.fn(),
    webMock: vi.fn(),
    chineseMock: vi.fn(),
    extraMock: vi.fn(),
    unsupportedApertiumMock: vi.fn(),
}));
vi.mock('@/src/platform/storage/freeTranslationHealthStorage', () => ({freeTranslationHealthStorage: {load: async () => storedHealth.records, save: async () => undefined}}));
vi.mock('@/src/services/config/store', () => ({config: mockConfig}));
vi.mock('@/src/providers/translation/microsoft', () => ({translateMicrosoftTexts: microsoftMock}));
vi.mock('@/src/providers/translation/bilibili-free', () => ({translateBilibiliFree: bilibiliMock}));
vi.mock('@/src/providers/translation/doubao-web', () => ({translateDoubaoWeb: doubaoMock}));
vi.mock('@/src/providers/translation/free-official-web', () => ({translateOfficialFreeWebProvider: officialMock}));
vi.mock('@/src/providers/translation/google', () => ({translateGoogleText: googleMock, translateGoogleOwnerTexts: googleOwnerMock}));
vi.mock('@/src/providers/translation/mymemory', () => ({default: myMemoryMock}));
vi.mock('@/src/providers/translation/free-web', () => ({translateFreeWebText: webMock}));
vi.mock('@/src/providers/translation/free-chinese-web', () => ({translateFreeChineseWebText: chineseMock}));
vi.mock('@/src/providers/translation/free-extra-web', () => ({translateExtraFreeWebText: extraMock, isKnownUnsupportedApertiumDirection: unsupportedApertiumMock}));

import type {TranslationConfigSource} from '@/src/services/translation/types';
import type {FreeFallbackLease} from '@/src/services/translation/freeFallback';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {servicesType} from '@/src/core/config/catalog';
import {DEFAULT_DEEPLX_ENDPOINT} from '@/src/core/config/deeplx';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {serializeTranslationSlots} from '@/src/core/translation/slotProtocol';

let freeTranslation: typeof import('@/src/providers/translation/free-translation').default;
let FREE_TRANSLATION_BATCH_CONCURRENCY: number;
let getFreeTranslationWeightSnapshot: typeof import('@/src/providers/translation/free-translation').getFreeTranslationWeightSnapshot;
let translateFreeTranslationProvider: typeof import('@/src/providers/translation/free-translation').translateFreeTranslationProvider;
let attachTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').attachTranslationProviderConfig;
let createTranslationProviderConfigSnapshot: typeof import('@/src/services/translation/requestSnapshot').createTranslationProviderConfigSnapshot;
let getTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').getTranslationProviderConfig;
function withProviderSnapshot<T extends object>(message: T, source: Partial<TranslationConfigSource>): T {
    return attachTranslationProviderConfig({...message}, getTranslationProviderConfig(message, () => createTranslationProviderConfigSnapshot(providerConfigFixture(source))));
}
const translateFreeText = (text: string, message: Record<string, unknown> = {}) => (
    freeTranslation(withProviderSnapshot({...message, origin: text}, mockConfig)) as Promise<string>
);
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
async function settle<T>(request: Promise<T>): Promise<T> {
    let done = false;
    void request.then(() => {done = true;}, () => {done = true;});
    for (let step = 0; step < 200 && !done; step += 1) await vi.advanceTimersByTimeAsync(50);
    return request;
}
const httpFailure = (statusCode = 503) => Object.assign(new Error('private original and token'), {statusCode});
const readSnapshot = (message: object) => getTranslationProviderConfig(message, mockConfig as never);

beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    storedHealth.records = null;
    unsupportedApertiumMock.mockReturnValue(false);
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
    Object.assign(mockConfig, {
        service: 'freeTranslation', from: 'auto', to: 'zh-Hans',
        token: {}, proxy: {}, model: {}, customModel: {},
        freeTranslationTimeoutMs: 1_000, freeTranslationCooldownMs: 1_000,
        freeTranslationMode: 'sequential',
        freeTranslationOrder: ['microsoft', 'alibabaFree', 'google', 'myMemory'],
        myMemoryEmail: '', deeplx: 'https://deeplx.example/translate',
    });
    for (const mock of [microsoftMock, officialMock, bilibiliMock, doubaoMock, googleMock, googleOwnerMock, myMemoryMock, chineseMock, extraMock]) {
        mock.mockRejectedValue(httpFailure());
    }
    ({default: freeTranslation, FREE_TRANSLATION_BATCH_CONCURRENCY, getFreeTranslationWeightSnapshot, translateFreeTranslationProvider}
        = await import('@/src/providers/translation/free-translation'));
    ({attachTranslationProviderConfig, createTranslationProviderConfigSnapshot, getTranslationProviderConfig}
        = await import('@/src/services/translation/requestSnapshot'));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('非 Safari 免费池不依赖权限策略', () => {
    it.each(['chrome', 'firefox', 'userscript'])('%s 保留完整候选、连接检查与权重且不调用 Safari 权限端口', async browser => {
        vi.stubEnv('BROWSER', browser);
        const port = await import('@/src/platform/browser/freeProviderPermissions');
        const readAccess = vi.spyOn(port, 'readFreePoolAccess').mockRejectedValue(new Error('Safari-only permission port'));
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        microsoftMock.mockRejectedValue(httpFailure(503)); officialMock.mockResolvedValue('有效译文');
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(microsoftMock).toHaveBeenCalledOnce(); expect(officialMock).toHaveBeenCalledOnce();
        const weights = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        expect(weights.entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('cooling');
        expect(weights.entries.find(entry => entry.providerId === 'alibabaFree')?.status).toBe('ready');
        microsoftMock.mockResolvedValue(['连接成功']);
        await expect(translateFreeTranslationProvider('microsoft', withProviderSnapshot({origin: 'Check this service.'}, mockConfig))).resolves.toBe('连接成功');
        const controller = new AbortController(); controller.abort(new Error('closed before dispatch'));
        await expect(translateFreeTranslationProvider('microsoft', withProviderSnapshot({origin: 'Do not send.', abortSignal: controller.signal}, mockConfig))).rejects.toBe(controller.signal.reason);
        expect(microsoftMock).toHaveBeenCalledTimes(2); expect(readAccess).not.toHaveBeenCalled();
    });
});

describe('全局服务关闭与免费池', () => {
    it('跳过关闭成员，权重保持零，自动回退不改变原服务池或健康记录', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google']; mockConfig.disabledTranslationServices = ['microsoft'];
        microsoftMock.mockResolvedValue(['不应请求']); googleMock.mockResolvedValue('有效译文');
        const before = JSON.stringify(mockConfig);
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleMock).toHaveBeenCalledOnce();
        const weights = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        expect(weights.entries.find(entry => entry.providerId === 'microsoft')).toMatchObject({status: 'disabled', weight: 0});
        expect(JSON.stringify(mockConfig)).toBe(before);
    });
    it('全部成员关闭时不恢复默认池或发送请求，重新启用后可以翻译', async () => {
        mockConfig.freeTranslationOrder = ['microsoft']; mockConfig.disabledTranslationServices = ['microsoft'];
        const pending = translateFreeText('Hello from FluentRead.');
        const rejected = expect(pending).rejects.toThrow('未选择可用的免密钥服务');
        await settle(pending.catch(() => undefined)); await rejected;
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleMock).not.toHaveBeenCalled();
        mockConfig.disabledTranslationServices = []; microsoftMock.mockResolvedValue(['有效译文']);
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(microsoftMock).toHaveBeenCalledOnce();
    });
    it('逐服务检查也不绕过全局关闭开关', async () => {
        mockConfig.disabledTranslationServices = ['microsoft'];
        await expect(translateFreeTranslationProvider('microsoft', withProviderSnapshot({origin: 'Do not send.'}, mockConfig))).rejects.toThrow('所选翻译服务已关闭');
        expect(microsoftMock).not.toHaveBeenCalled();
    });
});

describe('Safari 免费池授权过滤', () => {
    function setGranted(hosts: readonly string[]) {
        vi.stubEnv('BROWSER', 'safari');
        const contains = vi.fn(async ({origins}: {origins: string[]}) => origins.every(origin => hosts.includes(origin)));
        vi.stubGlobal('browser', {permissions: {contains}});
        return contains;
    }
    function expectNoProviderCalls() {
        for (const mock of [microsoftMock, officialMock, bilibiliMock, doubaoMock, googleMock, googleOwnerMock, myMemoryMock, webMock, chineseMock, extraMock]) {
            expect(mock).not.toHaveBeenCalled();
        }
    }

    it.each([
        {documentBatch: false, native: false, slots: 0},
        {documentBatch: true, native: false, slots: 0},
        {documentBatch: true, native: false, slots: 3},
        {documentBatch: true, native: false, slots: 15},
        {documentBatch: false, native: true, slots: 15},
    ])('原本无网络的空批次保持本地完成且不查询权限：$documentBatch/$native/$slots', async ({documentBatch, native, slots}) => {
        const contains = setGranted([]);
        mockConfig.freeTranslationOrder = native ? ['microsoft', 'google'] : ['alibabaFree', 'microsoft'];
        const origin = Array.from({length: slots}, (_, index) => index % 2 ? ' \t\n' : '');
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const routes = vi.fn();
        const before = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        contains.mockClear();
        await expect(freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin, documentBatch}, routes), mockConfig))).resolves.toEqual(origin);
        expect(contains).not.toHaveBeenCalled(); expectNoProviderCalls(); expect(routes).not.toHaveBeenCalled();
        expect(await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).toEqual(before);
        contains.mockClear();
        const controller = new AbortController(); controller.abort();
        await expect(freeTranslation(withProviderSnapshot({origin, documentBatch, abortSignal: controller.signal}, mockConfig))).rejects.toMatchObject({name: 'AbortError'});
        expect(contains).not.toHaveBeenCalled(); expectNoProviderCalls();
    });

    it.each([undefined, null, 42, {}, ['Hello', 42], ['Hello', undefined]])('无效输入先报告准确格式错误，不查询权限：%s', async origin => {
        const contains = setGranted([]);
        await expect(freeTranslation(withProviderSnapshot({origin} as any, mockConfig))).rejects.toThrow('免费翻译服务仅支持文本输入');
        expect(contains).not.toHaveBeenCalled(); expectNoProviderCalls();
    });

    it.each([false, true])('零授权在任何候选/健康/统计前拒绝，document=%s', async documentBatch => {
        const contains = setGranted([]);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const routes = vi.fn();
        const before = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        contains.mockClear();
        const request = attachTranslationRouteObserver({origin: ['Hello from FluentRead.', 'This is a useful example.'], documentBatch}, routes);
        await expect(freeTranslation(withProviderSnapshot(request, mockConfig))).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED', retryable: false});
        expect(contains).toHaveBeenCalledTimes(4);
        expectNoProviderCalls(); expect(routes).not.toHaveBeenCalled();
        expect(await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).toEqual(before);
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'alibabaFree', 'google', 'myMemory']);
    });

    it('仅授权候选参与顺序换线，未授权候选不算失败或改变配置', async () => {
        setGranted(['https://translate.alibaba.com/*', 'https://api.mymemory.translated.net/*']);
        officialMock.mockRejectedValue(httpFailure(503));
        myMemoryMock.mockResolvedValue('有效译文');
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleMock).not.toHaveBeenCalled();
        expect(officialMock).toHaveBeenCalledOnce(); expect(myMemoryMock).toHaveBeenCalledOnce();
        const health = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        expect(health.entries.find(item => item.providerId === 'microsoft')?.status).toBe('disabled');
        expect(health.entries.find(item => item.providerId === 'google')?.status).toBe('disabled');
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'alibabaFree', 'google', 'myMemory']);
    });

    it.each(['google', 'lingvanexFree'])('%s 只授权部分请求域不会进入其内部备用/初始化请求', async id => {
        mockConfig.freeTranslationOrder = [id];
        setGranted([id === 'google' ? 'https://translate.google.com/*' : 'https://api-b2b.backenster.com/*']);
        await expect(translateFreeText('Hello from FluentRead.')).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED'});
        expectNoProviderCalls();
    });

    it('只有微软获授权仍保留完整混合池的普通逐段策略', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        setGranted(['https://edge.microsoft.com/*']);
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(() => '有效译文'));
        const origin = Array.from({length: 9}, (_, index) => `This English paragraph number ${index} explains useful application settings.`);
        await expect(settle(freeTranslation(withProviderSnapshot({origin}, mockConfig)))).resolves.toEqual(origin.map(() => '有效译文'));
        expect(microsoftMock).toHaveBeenCalledTimes(9);
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
        expect(officialMock).not.toHaveBeenCalled();
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'alibabaFree']);
    });

    it('文档混合池过滤后仍用文档原生分组且不触发未授权标量服务', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'microsoft'];
        setGranted(['https://edge.microsoft.com/*']);
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(() => '有效译文'));
        const origin = ['Hello from FluentRead.', 'This is a useful application.', 'The service translates paragraphs.'];
        await expect(settle(freeTranslation(withProviderSnapshot({origin, documentBatch: true}, mockConfig)))).resolves.toEqual(origin.map(() => '有效译文'));
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(microsoftMock.mock.calls[0][0]).toEqual(origin);
        expect(officialMock).not.toHaveBeenCalled();
    });

    it('单服务检查独立检查指定项，不受启用列表约束且无权不调用 provider', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const contains = setGranted([]);
        await expect(translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({origin: 'Hello from FluentRead.'}, mockConfig)))
            .rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED'});
        expectNoProviderCalls();
        expect(contains).toHaveBeenCalledWith({origins: ['https://translate.alibaba.com/*']});
        expect(contains).toHaveBeenCalledOnce();
        contains.mockResolvedValue(true); officialMock.mockResolvedValue('有效译文');
        await expect(translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({origin: 'Hello from FluentRead.'}, mockConfig))).resolves.toBe('有效译文');
        expect(officialMock).toHaveBeenCalledOnce();
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft']);
    });

    it('每次新请求重新验权，撤权后不沿用先前可用候选', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const contains = setGranted(['https://edge.microsoft.com/*']);
        microsoftMock.mockResolvedValue(['有效译文']);
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        contains.mockResolvedValue(false);
        await expect(translateFreeText('A second paragraph.')).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED'});
        expect(contains).toHaveBeenCalledTimes(2); expect(microsoftMock).toHaveBeenCalledOnce();
    });

    it('API失败不放行；查询期间取消的请求不因迟到授权结果继续', async () => {
        const contains = setGranted([]);
        contains.mockRejectedValueOnce(new Error('private failure'));
        await expect(translateFreeText('Hello from FluentRead.')).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE'});
        let resolve!: (allowed: boolean) => void;
        contains.mockImplementation(() => new Promise<boolean>(done => {resolve = done;}));
        mockConfig.freeTranslationOrder = ['microsoft'];
        const controller = new AbortController();
        const pending = translateFreeText('Hello from FluentRead.', {abortSignal: controller.signal});
        controller.abort(new DOMException('closed', 'AbortError'));
        resolve(true);
        await expect(pending).rejects.toBe(controller.signal.reason);
        expectNoProviderCalls();
    });

    it('已取消的请求不再查询权限', async () => {
        const contains = setGranted([]);
        const controller = new AbortController(); controller.abort();
        await expect(translateFreeText('Hello from FluentRead.', {abortSignal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(contains).not.toHaveBeenCalled(); expectNoProviderCalls();
    });

    it.each(['after-query', 'before-batch'] as const)('权限端口成功后异步取消仍不进入候选：%s', async boundary => {
        setGranted(['https://edge.microsoft.com/*']);
        mockConfig.freeTranslationOrder = ['microsoft'];
        const controller = new AbortController(); const reason = new Error('caller closed between query and dispatch');
        const port = await import('@/src/platform/browser/freeProviderPermissions');
        vi.spyOn(port, 'readFreePoolAccess').mockImplementation(async () => {
            queueMicrotask(() => {
                if (boundary === 'after-query') controller.abort(reason);
                else queueMicrotask(() => controller.abort(reason));
            });
            return {supported: true, grantedIds: ['microsoft'], preferredGrant: null};
        });
        await expect(freeTranslation(withProviderSnapshot({origin: ['Hello from FluentRead.'], abortSignal: controller.signal}, mockConfig))).rejects.toBe(reason);
        expectNoProviderCalls();
    });

    it.each(['abort', 'timeout'] as const)('真实 broker 纯权限查询悬挂在 %s 后归还租约，晚结果不启动旧 provider', async ending => {
        Object.assign(mockConfig, {freeTranslationOrder: ['microsoft'], maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0, translationRequestsPerMinute: 0, useCache: false, enableAIContext: false});
        const contains = setGranted([]);
        let release!: (allowed: boolean) => void;
        contains.mockImplementationOnce(() => new Promise<boolean>(resolve => {release = resolve;})).mockResolvedValue(true);
        const {createTranslationBroker} = await import('@/src/services/translation/broker');
        const {attachTranslationRequestControl} = await import('@/src/services/translation/requestSnapshot');
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => mockConfig as unknown as TranslationConfigSource,
            providers: {freeTranslation: message => freeTranslation(withProviderSnapshot(message as unknown as TranslationProviderRequest, mockConfig))},
            cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
            serviceTypes: servicesType,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: ''}), aiSdkTransportProfile: ''},
            promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            resolveConfiguredModel: () => '', buildTranslationCacheKey: identity => JSON.stringify(identity),
        });
        const controller = new AbortController();
        const first = broker.translateWithCache(attachTranslationRequestControl({origin: 'First source paragraph.', requestTimeoutMs: 5_000},
            {signal: controller.signal, ownershipKey: `permission-query-${ending}`})).catch(error => error);
        await vi.advanceTimersByTimeAsync(20);
        expect(contains).toHaveBeenCalledOnce(); expectNoProviderCalls();
        if (ending === 'abort') controller.abort(); else await vi.advanceTimersByTimeAsync(2_000);
        await expect(first).resolves.toMatchObject(ending === 'abort'
            ? {name: 'AbortError'} : {code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE'});
        expectNoProviderCalls();
        microsoftMock.mockResolvedValue(['恢复译文']);
        // 原 contains promise 尚未结束；下一请求必须能取得同一个后台并发槽。
        await expect(settle(broker.translateWithCache({origin: 'Second source paragraph.', requestTimeoutMs: 5_000}))).resolves.toBe('恢复译文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        release(true); await vi.advanceTimersByTimeAsync(0);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('权限查询沿用剩余总预算，耗尽预算不查询且查询超时不记录候选健康', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const contains = setGranted([]);
        const before = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)));
        contains.mockClear(); contains.mockImplementation(() => new Promise(() => {}));
        const assertion = expect(translateFreeText('Hello from FluentRead.', {requestTimeoutMs: 37})).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE'});
        await vi.advanceTimersByTimeAsync(37); await assertion;
        expect(contains).toHaveBeenCalledOnce(); expectNoProviderCalls();
        contains.mockResolvedValue(false);
        expect(await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).toEqual({...before, observedAt: Date.now()});
        contains.mockClear();
        await expect(translateFreeText('Hello from FluentRead.', {requestTimeoutMs: 0})).rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE'});
        expect(contains).not.toHaveBeenCalled(); expectNoProviderCalls(); expect(vi.getTimerCount()).toBe(0);
    });

    it('真实健康快照只给已授权服务分配权重，零授权不丢健康，重新授权可恢复冷却状态', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const contains = setGranted(['https://edge.microsoft.com/*', 'https://translate.alibaba.com/*']);
        microsoftMock.mockRejectedValue(httpFailure(503)); officialMock.mockResolvedValue('有效译文');
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        const current = createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig));
        const full = await getFreeTranslationWeightSnapshot(current);
        expect(full.entries.find(item => item.providerId === 'microsoft')).toMatchObject({status: 'cooling', weight: 0});
        expect(full.entries.find(item => item.providerId === 'alibabaFree')).toMatchObject({status: 'ready', weight: 100});
        contains.mockImplementation(async ({origins}: {origins: string[]}) => origins[0] === 'https://translate.alibaba.com/*');
        const single = await getFreeTranslationWeightSnapshot(current);
        expect(single.total).toBe(100);
        expect(single.entries.find(item => item.providerId === 'microsoft')).toMatchObject({status: 'disabled', weight: 0});
        expect(single.entries.find(item => item.providerId === 'alibabaFree')).toMatchObject({status: 'ready', weight: 100});
        contains.mockResolvedValue(false);
        const empty = await getFreeTranslationWeightSnapshot(current);
        expect(empty.total).toBe(0); expect(empty.entries.every(item => item.status === 'disabled' && item.weight === 0)).toBe(true);
        contains.mockResolvedValue(true);
        expect(await getFreeTranslationWeightSnapshot(current)).toEqual(full);
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'alibabaFree']);
        expect(microsoftMock).toHaveBeenCalledOnce(); expect(officialMock).toHaveBeenCalledOnce();
    });

    it('健康快照查询权限失败明确传播，不以未过滤的配置回退', async () => {
        const contains = setGranted([]); contains.mockRejectedValue(new Error('failed permission lookup'));
        await expect(getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig))))
            .rejects.toMatchObject({code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE'});
        expectNoProviderCalls();
    });
});

describe('免费翻译服务', () => {
    it.each([false, true])('实际 prepare/free-pool/restore 链接受紧邻英文的 emoji 标记且无需换线，批量=%s', async batch => {
        Object.assign(mockConfig, {from: 'zh-Hans', to: 'en', freeTranslationOrder: batch ? ['transmart'] : ['transmart', 'google']});
        const {prepareGlossaryRequest} = await import('@/src/services/translation/glossaryProtection');
        const current = createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig));
        const packet = batch
            ? prepareGlossaryRequest({origin: ['🙂猫', '🚚狗']}, current)
            : prepareGlossaryRequest({origin: '🙂猫'}, current);
        webMock.mockImplementation(async (_provider: string, text: string) => text.replaceAll('猫', 'cat').replaceAll('狗', 'dog'));
        const result = await settle(freeTranslation(withProviderSnapshot(packet.message, mockConfig)));
        expect(packet.restore(result)).toEqual(batch ? ['🙂cat', '🚚dog'] : '🙂cat');
        expect(webMock).toHaveBeenCalledTimes(batch ? 2 : 1);
        expect(googleMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot(current)).entries.find(entry => entry.providerId === 'transmart')?.status).toBe('ready');
    });
    it.each([false, true])('broker 自动保护 emoji 后在免费池拒绝丢失标记的候选，批量=%s', async batch => {
        Object.assign(mockConfig, {freeTranslationOrder:['transmart','google'],useCache:true,enableAIContext:false});
        const {createTranslationBroker} = await import('@/src/services/translation/broker');
        const cache = new Map<string,string>();
        const broker = createTranslationBroker({ready:Promise.resolve(),getConfig:()=>providerConfigFixture(mockConfig),
            providers:{freeTranslation:message=>freeTranslation(withProviderSnapshot(message as TranslationProviderRequest,mockConfig))},
            cache:{get:async key=>cache.get(key)??null,set:async(key,value)=>{cache.set(key,value);return true;},clear:async()=>{},cleanup:async()=>{}},
            serviceTypes:servicesType,endpointResolver:{resolveOpenAICompatibleEndpoint:()=>({endpoint:''}),aiSdkTransportProfile:''},
            promptBuilder:{buildPageSummaryPrompt:()=>'',buildPageSummarySystemPrompt:()=>''},getMissingCredentialMessage:()=>null,
            getTranslationLanguages:()=>({sourceLanguage:'en',targetLanguage:'zh-Hans'}),resolveConfiguredModel:()=>'',
            buildTranslationCacheKey:identity=>JSON.stringify(identity)});
        webMock.mockResolvedValue('省略图标的错误候选。');
        googleMock.mockImplementation(async(text:string)=>`译文:${text}`);
        googleOwnerMock.mockImplementation(async(texts:string[])=>texts.map(text=>`译文:${text}`));
        const sources=['Deliver 🚚 now.','Observe 👩🏽‍🔬 at Gate1️⃣.'];
        const origin=batch?sources:sources[0];
        const result=await settle(broker.translateWithCache({origin} as any));
        expect(result).toEqual(batch?sources.map(text=>`译文:${text}`):`译文:${sources[0]}`);
        expect(webMock).toHaveBeenCalled();
        expect(String(webMock.mock.calls[0][1])).toContain('__FRTERM_');
        expect(String(webMock.mock.calls[0][1])).not.toContain('🚚');
        expect([...cache.values()].join(' ')).not.toContain('错误候选');
        expect([...cache.values()].join(' ')).not.toContain('__FRTERM_');
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry=>entry.providerId==='transmart')?.status).toBe('ready');
    });
    it.each([false, true])('图片免费池原样结果成功且不换线，原生分组=%s', async grouped => {
        const {allowUnchangedTranslationResult} = await import('@/src/services/translation/requestSnapshot');
        mockConfig.freeTranslationOrder = grouped ? ['microsoft'] : ['microsoft', 'google'];
        microsoftMock.mockImplementation(async (texts: string[]) => [...texts]);
        const sources = Array.from({length: 9}, (_, index) => `This English paragraph number ${index} explains the application settings.`);
        const origin = grouped ? sources : sources[0];
        await expect(settle(freeTranslation(withProviderSnapshot(allowUnchangedTranslationResult({origin}), mockConfig)))).resolves.toEqual(origin);
        expect(microsoftMock).toHaveBeenCalledTimes(grouped ? 2 : 1);
        expect(microsoftMock.mock.calls.flatMap(call => call[0])).toEqual(grouped ? sources : [sources[0]]);
        expect(googleMock).not.toHaveBeenCalled(); expect(googleOwnerMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });

    it.each(['google', 'microsoft'] as const)('单服务连接检查向 %s 传递后台真实传输租约', async provider => {
        const {attachTranslationRequestScheduler} = await import('@/src/services/translation/requestSnapshot');
        const {createTranslationRequestScheduler} = await import('@/src/services/translation/requestScheduler');
        const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
        const lease = {holdUntil: vi.fn()};
        const leaf = provider === 'microsoft' ? microsoftMock : googleMock;
        leaf.mockResolvedValue(provider === 'microsoft' ? ['有效译文'] : '有效译文');
        const request = attachTranslationRequestScheduler({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'},
            scheduler, {service: 'freeTranslation'}, lease);

        await expect(translateFreeTranslationProvider(provider, withProviderSnapshot(request, mockConfig))).resolves.toBe('有效译文');
        expect(leaf.mock.calls[0][provider === 'microsoft' ? 5 : 6]).toBe(lease);
    });

    it.each([
        {provider: 'google', grouped: false, document: false}, {provider: 'microsoft', grouped: false, document: false},
        {provider: 'google', grouped: true, document: false}, {provider: 'microsoft', grouped: true, document: false},
        {provider: 'google', grouped: false, document: true}, {provider: 'microsoft', grouped: false, document: true},
        {provider: 'google', grouped: true, document: true}, {provider: 'microsoft', grouped: true, document: true},
    ])('broker keeps $provider grouped=$grouped document=$document occupied through nested physical transport settlement', async ({provider, grouped, document}) => {
        Object.assign(mockConfig, {
            freeTranslationOrder: [provider], maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
            useCache: false, enableAIContext: false,
        });
        const {createTranslationBroker} = await import('@/src/services/translation/broker');
        const {attachTranslationRequestControl} = await import('@/src/services/translation/requestSnapshot');
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => mockConfig as unknown as TranslationConfigSource,
            providers: {freeTranslation: message => freeTranslation(withProviderSnapshot(message as unknown as TranslationProviderRequest, mockConfig))},
            cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
            serviceTypes: servicesType,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: ''}), aiSdkTransportProfile: ''},
            promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            resolveConfiguredModel: () => '', buildTranslationCacheKey: identity => JSON.stringify(identity),
        });
        let releasePhysical!: () => void;
        const rawTransport = new Promise<void>(resolve => {releasePhysical = resolve;});
        const leaf = provider === 'microsoft' ? microsoftMock : grouped ? googleOwnerMock : googleMock;
        const leasePosition = provider === 'microsoft' ? 5 : grouped ? 4 : 6;
        leaf.mockImplementation((...args: unknown[]) => {
            const signal = args[3] as AbortSignal;
            const lease = args[leasePosition] as FreeFallbackLease;
            expect(lease).toEqual(expect.objectContaining({holdUntil: expect.any(Function)}));
            lease.holdUntil(rawTransport);
            return new Promise((_resolve, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('provider wrapper stopped waiting', 'AbortError')), {once: true}));
        });
        const controller = new AbortController();
        const origin = grouped ? Array.from({length: 9}, (_, index) => `English source paragraph ${index}.`) : 'English source paragraph.';
        const message = typeof origin === 'string'
            ? {origin, requestTimeoutMs: 5_000, documentBatch: document, enableNativeBatch: !document}
            : {origin, requestTimeoutMs: 5_000, documentBatch: document};
        const first = broker.translateWithCache(attachTranslationRequestControl(message, {
            signal: controller.signal, ownershipKey: `free-${provider}-${grouped}`,
        })).catch(error => error);
        await vi.advanceTimersByTimeAsync(100);
        const firstCalls = leaf.mock.calls.length;
        expect(firstCalls).toBeGreaterThan(0);
        controller.abort();
        await expect(first).resolves.toMatchObject({name: 'AbortError'});
        const retryLeaf = provider === 'microsoft' ? microsoftMock : googleMock;
        retryLeaf.mockImplementation(() => Promise.resolve(provider === 'microsoft' ? ['恢复译文'] : '恢复译文'));
        const retry = broker.translateWithCache({origin: 'Another source paragraph after cancellation.', requestTimeoutMs: 5_000});
        await vi.advanceTimersByTimeAsync(100);
        expect(leaf).toHaveBeenCalledTimes(firstCalls);
        releasePhysical();
        await expect(settle(retry)).resolves.toBe('恢复译文');
        expect(retryLeaf).toHaveBeenCalledTimes(provider === 'google' && grouped ? 1 : firstCalls + 1);
    });

    it.each(['google', 'microsoft'] as const)('文档 %s 原生协议恢复保留每次候选租约和未结算传输容量', async provider => {
        mockConfig.freeTranslationOrder = [provider];
        const {attachTranslationRequestScheduler} = await import('@/src/services/translation/requestSnapshot');
        const {createTranslationRequestScheduler} = await import('@/src/services/translation/requestScheduler');
        const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
        const held: Promise<void>[] = [];
        let pending = 0;
        const outerLease = {holdUntil(settlement: PromiseLike<unknown>) {
            pending += 1;
            held.push(Promise.resolve(settlement).then(() => {pending -= 1;}));
        }};
        let releasePhysical!: () => void;
        const raw = new Promise<void>(resolve => {releasePhysical = resolve;});
        const scalarLeases: FreeFallbackLease[] = [];
        if (provider === 'microsoft') {
            microsoftMock.mockImplementation(async (texts: string[], _from: string, _to: string, _signal: AbortSignal,
                _native: boolean, lease: FreeFallbackLease) => {
                expect(lease).toEqual(expect.objectContaining({holdUntil: expect.any(Function)}));
                expect(lease).not.toBe(outerLease);
                if (texts.length > 1) {
                    lease.holdUntil(raw);
                    return ['截断的批次译文'];
                }
                scalarLeases.push(lease);
                return [`有效译文 ${texts[0]!.endsWith('one.') ? '一' : '二'}`];
            });
        } else {
            googleOwnerMock.mockImplementation(async (_texts: string[], _from: string, _to: string,
                _signal: AbortSignal, lease: FreeFallbackLease) => {
                expect(lease).toEqual(expect.objectContaining({holdUntil: expect.any(Function)}));
                expect(lease).not.toBe(outerLease);
                lease.holdUntil(raw);
                return ['截断的批次译文'];
            });
            googleMock.mockImplementation(async (text: string, _from: string, _to: string, _signal: AbortSignal,
                native: boolean, _timeout: number, lease: FreeFallbackLease) => {
                expect(native).toBe(false);
                scalarLeases.push(lease);
                return `有效译文 ${text.endsWith('one.') ? '一' : '二'}`;
            });
        }
        const request = attachTranslationRequestScheduler({origin: ['Document paragraph one.', 'Document paragraph two.'],
            documentBatch: true, requestTimeoutMs: 5_000}, scheduler, {service: 'freeTranslation'}, outerLease);
        const translation = freeTranslation(withProviderSnapshot(request, mockConfig));
        await vi.advanceTimersByTimeAsync(300);
        expect(pending).toBeGreaterThan(0);
        if (provider === 'google') expect(googleMock).not.toHaveBeenCalled();
        releasePhysical();
        await expect(settle(translation)).resolves.toEqual(['有效译文 一', '有效译文 二']);
        expect(scalarLeases).toHaveLength(2);
        expect(scalarLeases.every(lease => lease !== outerLease && typeof lease.holdUntil === 'function')).toBe(true);
        await Promise.all(held);
        expect(pending).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['', ' \u200b\u2060\ufe0f '])('文档候选保留编号却把文字移出%s空节点时换线，术语豁免不隐藏空节点', async empty => {
        mockConfig.freeTranslationOrder = ['youdaoFree', 'google'];
        const token = '__FRTERM_123456789abc_0__', source = `The reader should choose <g1>${token}</g1> before importing the document.`;
        const invalid = `读者应选择 ${token}<g1>${empty}</g1> 再导入文档。`, valid = `读者应选择 <g1>${token}</g1> 再导入文档。`;
        chineseMock.mockResolvedValue(invalid); googleMock.mockResolvedValue(valid);
        const current = createTranslationProviderConfigSnapshot({...mockConfig, glossaryProtectedTokens: [token],
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource);
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: source}, current), mockConfig)))).resolves.toBe(valid);
        expect(chineseMock).toHaveBeenCalledOnce(); expect(googleMock).toHaveBeenCalledOnce();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'youdaoFree')?.status).toBe('ready');
        // 无文档 context 的既有纯文本/网页调用不引入格式占用约束。
        await expect(settle(translateFreeText(source))).resolves.toBe(invalid);
        const page = Object.freeze({...current, freeTranslationOrder: Object.freeze(['youdaoFree'] as const),
            glossaryMatchContext: {...current.glossaryMatchContext!, context: 'page' as const}});
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: source}, page), mockConfig)))).resolves.toBe(invalid);
        expect(chineseMock).toHaveBeenCalledTimes(3); expect(googleMock).toHaveBeenCalledOnce();
    });

    it('一个原生批次槽的空强调节点拒绝整组，下一线路保持原槽顺序和文字', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = Array.from({length: 9}, (_, index) => `The reader should choose <g1>Search</g1> before importing document ${index}.`);
        const target = (text: string) => `读者应选择 <g1>搜索</g1> 再导入文档 ${text.match(/document (\d+)/u)![1]}。`;
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map((text, index) => index === 2
            ? target(text).replace('<g1>搜索</g1>', '搜索<g1></g1>') : target(text)));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(target));
        const request = attachTranslationProviderConfig({origin: origins}, createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toEqual(origins.map(target));
        expect(microsoftMock).toHaveBeenCalledOnce(); expect(googleOwnerMock).toHaveBeenCalledTimes(2); expect(googleMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });

    it('真实文档正文已译但行内菜单原样英文时在胜出前换线，不冷却该服务或增加小请求', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const source = 'For an online PDF, open the extension menu and choose <g1>Open PDF reader</g1> or <g2>Document translation</g2>.';
        const echoed = '对于在线PDF，打开扩展菜单选择 <g1>Open PDF reader</g1> 或 <g2>Document translation</g2>。';
        const translated = '对于在线PDF，打开扩展菜单选择 <g1>打开PDF阅读器</g1> 或 <g2>文档翻译</g2>。';
        microsoftMock.mockResolvedValue([echoed]);
        googleMock.mockResolvedValue(translated);
        const current = createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource);
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: source}, current), mockConfig)))).resolves.toBe(translated);
        expect(microsoftMock).toHaveBeenCalledOnce(); expect(googleMock).toHaveBeenCalledOnce();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
        microsoftMock.mockResolvedValue(['下一段有效译文']);
        await expect(settle(translateFreeText('The next paragraph should use the same provider.'))).resolves.toBe('下一段有效译文');
        expect(microsoftMock).toHaveBeenCalledTimes(2); expect(googleMock).toHaveBeenCalledOnce();
    });

    it('行内正文校验使用本次目标语言覆盖，英文目标和显式术语仍允许英文', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        mockConfig.to = 'en';
        const source = 'The reader should choose <g1>Document translation</g1> before importing the document.';
        const echoed = '读者应选择 <g1>Document translation</g1> 再导入文档。';
        microsoftMock.mockResolvedValue([echoed]); googleMock.mockResolvedValue('读者应选择 <g1>文档翻译</g1> 再导入文档。');
        const current = createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource);
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: source, targetLanguage: 'zh-Hans'}, current), mockConfig))))
            .resolves.toBe('读者应选择 <g1>文档翻译</g1> 再导入文档。');
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: source, targetLanguage: 'en'}, current), mockConfig)))).resolves.toBe(echoed);
        const token = '__FRTERM_123456789abc_0__', protectedSource = source.replace('Document translation', token);
        microsoftMock.mockResolvedValue([echoed.replace('Document translation', token)]);
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationProviderConfig({origin: protectedSource, targetLanguage: 'zh-Hans'},
            Object.freeze({...current, glossaryProtectedTokens: [token]})), mockConfig)))).resolves.toBe(echoed.replace('Document translation', token));
        expect(microsoftMock).toHaveBeenCalledTimes(3); expect(googleMock).toHaveBeenCalledOnce();
    });

    it('原生组逐槽拒绝行内正文回显，保留槽顺序与每槽重新起算的编号', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = Array.from({length: 9}, (_, index) => `The reader should choose <g1>Document translation</g1> before importing document ${index}.`);
        const target = (text: string) => `读者应选择 <g1>文档翻译</g1> 再导入文档 ${text.match(/document (\d+)/u)![1]}。`;
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => target(text).replace('文档翻译', 'Document translation')));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(target));
        googleMock.mockImplementation(async (text: string) => target(text));
        const request = attachTranslationProviderConfig({origin: origins}, createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toEqual(origins.map(target));
        expect(microsoftMock).toHaveBeenCalledOnce(); expect(googleOwnerMock).toHaveBeenCalledTimes(2); expect(googleMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });

    it.each(['missing', 'duplicate', 'foreign'])('文档强调标记被候选%s时在获胜前换线，恢复后仍为原始Markdown语法', async kind => {
        mockConfig.freeTranslationOrder = ['youdaoFree', 'google'];
        const {prepareGlossaryRequest} = await import('@/src/services/translation/glossaryProtection');
        const {parseDocument, renderDocument} = await import('@/src/features/document-translation/core/document');
        const document = parseDocument('sample.md', 'Translate this paragraph and keep **bold** text.', {markdownSentences: true});
        const packet = prepareGlossaryRequest({origin: document.segments[0].source},
            createTranslationProviderConfigSnapshot({...mockConfig, glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource));
        expect(readSnapshot(packet.message).glossaryProtectedTokens).toBeUndefined();
        expect(packet.message.origin).toBe('Translate this paragraph and keep <g1>bold</g1> text.');
        chineseMock.mockImplementation(async (_id: string, text: string) => `译文:${kind === 'missing' ? text.replace('<g1>', '')
            : text + (kind === 'duplicate' ? '<g1>重复</g1>' : '<g2/>')}`);
        // 此句是实际匿名 Transmart A/B 返回；单测复用记录值验证请求和 Markdown 恢复，网络证据另存 /private/tmp。
        googleMock.mockResolvedValue('翻译这一段，并保留<g1>粗体</g1>文本。');
        const result = await settle(freeTranslation(withProviderSnapshot(packet.message, mockConfig)));
        expect(renderDocument(document, [packet.restore(result) as string], 'translated'))
            .toBe('翻译这一段，并保留**粗体**文本。');
        expect(chineseMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'youdaoFree')?.status).toBe('ready');
    });

    it('文档候选必须保留嵌套父子关系，并把合法全角和实体恢复为canonical标签', async () => {
        mockConfig.freeTranslationOrder = ['youdaoFree', 'google'];
        const source = 'Keep <g1>outer <g2>bold</g2></g1> and <g3/>.';
        const request = attachTranslationProviderConfig({origin: source}, createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource));
        chineseMock.mockResolvedValue('<g1>外层</g1><g2>粗体</g2><g3/>');
        googleMock.mockResolvedValue('保留（g1）外层&lt;g2&gt;粗体&lt;/g2&gt;（/g1）和 <g3></g3>。');
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toBe('保留<g1>外层<g2>粗体</g2></g1>和 <g3/>。');
        expect(chineseMock).toHaveBeenCalledOnce(); expect(googleMock).toHaveBeenCalledOnce();
        await expect(settle(translateFreeText(source))).resolves.toBe('<g1>外层</g1><g2>粗体</g2><g3/>');
        expect(chineseMock).toHaveBeenCalledTimes(2);
    });

    it('原生分组逐槽拒绝未知文档编号并归一每槽实体，同编号重新起算不串用外层结构', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = Array.from({length: 9}, (_, index) => `Keep <g1>bold ${index}</g1> with <g${index + 2}/>.`);
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => `译文:${text}<g99/>`));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(text => `译文:${text.replace('bold', '粗体').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}`));
        const request = attachTranslationProviderConfig({origin: origins}, createTranslationProviderConfigSnapshot({...mockConfig,
            glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-hans'}} as unknown as TranslationConfigSource));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toEqual(origins.map(text => `译文:${text.replace('bold', '粗体')}`));
        expect(googleOwnerMock).toHaveBeenCalled(); expect(googleMock).not.toHaveBeenCalled();
    });

    it('候选损坏术语标记时在免费池内部换线，只影响当前文字', async () => {
        mockConfig.freeTranslationOrder = ['youdaoFree', 'google'];
        const token = '__FRTERM_123456789abc_0__';
        chineseMock.mockResolvedValue('使用 FRTERM 123456789abc 0。');
        googleMock.mockImplementation(async (source: string) => `译文:${source}`);
        const request = attachTranslationProviderConfig({origin: `Use ${token} here.`},
            createTranslationProviderConfigSnapshot({...mockConfig, glossaryProtectedTokens: [token]} as unknown as TranslationConfigSource));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toBe(`译文:Use ${token} here.`);
        expect(chineseMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'youdaoFree')?.status).toBe('ready');
        await expect(settle(translateFreeText('Ordinary prose.'))).resolves.toBe('使用 FRTERM 123456789abc 0。');
        expect(chineseMock).toHaveBeenCalledTimes(2);
    });

    it('豆包遗漏术语标记时在池内换线，正常文字仍能继续使用豆包而不进入全局冷却', async () => {
        mockConfig.freeTranslationOrder = ['doubaoWeb', 'google'];
        mockConfig.freeTranslationCooldownMs = 60_000;
        const token = '__FRTERM_123456789abc_0__';
        doubaoMock.mockResolvedValueOnce('使用术语。').mockResolvedValue('正常文字的译文。');
        googleMock.mockImplementation(async (source: string) => `译文:${source}`);
        const request = attachTranslationProviderConfig({origin: `Use ${token} here.`},
            createTranslationProviderConfigSnapshot({...mockConfig, glossaryProtectedTokens: [token]} as unknown as TranslationConfigSource));

        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toBe(`译文:Use ${token} here.`);
        expect(doubaoMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'doubaoWeb')?.status).toBe('ready');

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(settle(translateFreeText('Ordinary prose.'))).resolves.toBe('正常文字的译文。');
        expect(doubaoMock).toHaveBeenCalledTimes(2);
        expect(doubaoMock.mock.calls[1]![0].origin).toBe('Ordinary prose.');
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it('原生免费批次也逐槽验证术语，拒绝串入相邻段标记并按原顺序换线', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const tokens = Array.from({length: 9}, (_, index) => `__FRTERM_123456789abc_${index}__`);
        const origins = tokens.map(token => `Use ${token} here.`);
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => `译文:${text} ${tokens[8]}`));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(text => `译文:${text}`));
        const request = attachTranslationProviderConfig({origin: origins},
            createTranslationProviderConfigSnapshot({...mockConfig, glossaryProtectedTokens: tokens} as unknown as TranslationConfigSource));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toEqual(origins.map(text => `译文:${text}`));
        expect(googleOwnerMock).toHaveBeenCalled();
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('已确认不支持的 Apertium 方向只在当前方向跳过，配置和连接健康身份不变', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree', 'google'];
        let unsupported = false;
        unsupportedApertiumMock.mockImplementation((source: string, target: string) => unsupported && source === 'en' && target === 'zh-Hans');
        extraMock.mockImplementationOnce(async () => {
            unsupported = true;
            throw Object.assign(new Error('Apertium 不支持当前语言方向'), {statusCode: 400, freeFailure: 'request'});
        }).mockResolvedValue('Hola');
        googleMock.mockResolvedValue('有效译文');

        await expect(settle(translateFreeText('First prose', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).resolves.toBe('有效译文');
        await expect(settle(translateFreeText('Next prose', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).resolves.toBe('有效译文');
        expect(extraMock).toHaveBeenCalledOnce();
        expect(mockConfig.freeTranslationOrder).toEqual(['apertiumFree', 'google']);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'apertiumFree')?.status).toBe('ready');

        await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'es'}))).resolves.toBe('Hola');
        expect(extraMock).toHaveBeenCalledTimes(2);
        expect(extraMock.mock.calls[1].slice(0, 4)).toEqual(['apertiumFree', 'Hello', 'en', 'es']);
    });

    it('只有 Apertium 时仍由 provider 返回语言方向错误，真实取消不被候选排除吞掉', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree'];
        unsupportedApertiumMock.mockReturnValue(true);
        extraMock.mockRejectedValue(Object.assign(new Error('Apertium 不支持当前语言方向'), {statusCode: 400, freeFailure: 'request'}));
        await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).rejects.toThrow('HTTP 400');
        expect(extraMock).toHaveBeenCalledOnce();

        const owner = new AbortController();
        const reason = new Error('真实取消');
        owner.abort(reason);
        await expect(translateFreeText('Cancelled', {abortSignal: owner.signal})).rejects.toBe(reason);
        expect(extraMock).toHaveBeenCalledOnce();
    });

    it.each(FREE_TRANSLATION_PROVIDERS)('单服务检查直接使用 $id 匿名适配器，即使没有开启', async ({id}) => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        microsoftMock.mockResolvedValue(['有效译文']);
        for (const mock of [officialMock, bilibiliMock, doubaoMock, googleMock, myMemoryMock, webMock, chineseMock, extraMock]) mock.mockResolvedValue('有效译文');
        await expect(translateFreeTranslationProvider(id, withProviderSnapshot({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, mockConfig))).resolves.toBe('有效译文');
        const calls = [microsoftMock, officialMock, bilibiliMock, doubaoMock, googleMock, myMemoryMock, webMock, chineseMock, extraMock].reduce((total, mock) => total + mock.mock.calls.length, 0);
        expect(calls).toBe(1);
        const families = {transmart: webMock, yandexFree: webMock, volcengineFree: webMock, youdaoFree: chineseMock, icibaFree: chineseMock,
            reversoFree: extraMock, apertiumFree: extraMock};
        if (id in families) expect(families[id as keyof typeof families]).toHaveBeenCalledWith(id, 'Hello from FluentRead.', 'en', 'zh-Hans', undefined);
        if (['alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree'].includes(id)) expect(officialMock).toHaveBeenCalledWith(id, expect.objectContaining({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}));
        if (id === 'bilibiliFree') expect(bilibiliMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}));
        if (id === 'doubaoWeb') expect(doubaoMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}));
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft']);
    });

    it('B站限流后按原顺序换线；连接检查不换线且无需凭据', async () => {
        mockConfig.freeTranslationOrder = ['bilibiliFree', 'google'];
        mockConfig.freeTranslationMode = 'sequential';
        bilibiliMock.mockRejectedValue(Object.assign(new Error('rate limited'), {statusCode: 429, retryAfterMs: 12000}));
        googleMock.mockResolvedValue('有效译文');
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(bilibiliMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        const snapshot = getTranslationProviderConfig(bilibiliMock.mock.calls[0][0], mockConfig as any);
        expect(snapshot.token).toEqual({});
        expect(snapshot.proxy).toEqual({});
        await expect(translateFreeTranslationProvider('bilibiliFree', withProviderSnapshot({origin: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, mockConfig))).rejects.toMatchObject({statusCode: 429});
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it('豆包匿名访客拒绝后按冻结顺序换线，连接检查保留单线路错误', async () => {
        Object.assign(mockConfig, {freeTranslationOrder: ['doubaoWeb', 'google'],
            token: {doubao: 'private-token'}, secret: {doubao: 'private-secret'}, customHeaders: {doubao: {Cookie: 'personal'}},
            proxy: {doubao: 'https://private-proxy.example'}, to: 'zh-Hans'});
        doubaoMock.mockRejectedValue(Object.assign(new Error('豆包网页翻译请求失败（错误码 710012001）'), {statusCode: 403, freeFailure: 'blocked'}));
        googleMock.mockResolvedValue('有效译文');
        const result = translateFreeText('Hello from FluentRead.');
        mockConfig.to = 'ja'; mockConfig.freeTranslationOrder = ['microsoft'];
        await expect(settle(result)).resolves.toBe('有效译文');
        const message = doubaoMock.mock.calls[0][0];
        expect(message).toMatchObject({origin: 'Hello from FluentRead.', sourceLanguage: 'auto', targetLanguage: 'zh-Hans', serviceOverride: 'doubaoWeb', abortSignal: expect.any(AbortSignal)});
        expect(readSnapshot(message)).toMatchObject({token: {}, secret: {}, customHeaders: {}, proxy: {}, freeTranslationOrder: ['doubaoWeb', 'google'], to: 'zh-Hans'});
        expect(googleMock).toHaveBeenCalledOnce(); expect(microsoftMock).not.toHaveBeenCalled();
        await expect(translateFreeTranslationProvider('doubaoWeb', withProviderSnapshot({origin: 'Hello', targetLanguage: 'zh-Hans'}, mockConfig))).rejects.toMatchObject({statusCode: 403});
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it('豆包真实适配器经免费入口处理完整 SSE、返回错误后由原池换线', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/doubao-web')>('@/src/providers/translation/doubao-web');
        doubaoMock.mockImplementation(actual.translateDoubaoWeb);
        mockConfig.freeTranslationOrder = ['doubaoWeb', 'google'];
        googleMock.mockResolvedValue('备用译文');
        let fail = false;
        const fetch = vi.fn(async input => String(input) === actual.DOUBAO_WEB_HOME ? new Response('{"ttwid":"fixture-guest","web_id":"1234567890123456789"}')
            : fail ? Response.json({code: 710012001, msg: 'private diagnostic'})
                : new Response('event: json\ndata: {"code":0,"data":{"items":[{"index":0,"res":"豆包译文"}]}}\n\nevent: done\ndata:\n\n', {headers: {'Content-Type': 'text/event-stream'}}));
        vi.stubGlobal('fetch', fetch);
        await expect(translateFreeTranslationProvider('doubaoWeb', withProviderSnapshot({origin: 'Hello', targetLanguage: 'zh-Hans'}, mockConfig))).resolves.toBe('豆包译文');
        expect(fetch).toHaveBeenCalledTimes(2); expect(googleMock).not.toHaveBeenCalled();
        fail = true;
        await expect(settle(translateFreeText('New readable paragraph.'))).resolves.toBe('备用译文');
        // 当前块第一次访客拒绝 + 刷新后拒绝，仅两轮网页初始化和翻译。
        expect(fetch).toHaveBeenCalledTimes(6); expect(googleMock).toHaveBeenCalledOnce();
    });

    it('单服务检查保留匿名边界和结果验证，失败或原文回显不会自动换线', async () => {
        mockConfig.token = {deeplx: 'saved-private-key'};
        mockConfig.proxy = {deeplx: 'https://private.example'};
        mockConfig.deeplx = 'https://private.example/translate';
        officialMock.mockResolvedValueOnce('有效译文');
        await translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, mockConfig));
        const snapshot = getTranslationProviderConfig(officialMock.mock.calls[0][1], mockConfig as any);
        expect(snapshot.token).toEqual({});
        expect(snapshot.proxy).toEqual({});
        expect(snapshot.deeplx).toBe(DEFAULT_DEEPLX_ENDPOINT);
        microsoftMock.mockResolvedValue(['备用译文']);
        officialMock.mockRejectedValueOnce(new Error('服务不可用'));
        await expect(translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({origin: 'Hello', targetLanguage: 'zh-Hans'}, mockConfig))).rejects.toThrow('服务不可用');
        const echoed = 'The software translates this paragraph with a fast backup when the first service is slow.';
        officialMock.mockResolvedValueOnce(echoed);
        await expect(translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({origin: echoed, targetLanguage: 'zh-Hans'}, mockConfig))).rejects.toThrow();
        await expect(translateFreeTranslationProvider('unknown', withProviderSnapshot({origin: 'Hello'}, mockConfig))).rejects.toThrow('无效的免费翻译服务');
        expect(microsoftMock).not.toHaveBeenCalled();
    });
    it('保留微软、阿里翻译、谷歌优先顺序并新增 MyMemory 官方后备', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree', 'google', 'myMemory'];
        const calls: string[] = [];
        microsoftMock.mockImplementation(async () => { calls.push('microsoft'); throw httpFailure(); });
        officialMock.mockImplementation(async () => { calls.push('alibabaFree'); throw httpFailure(); });
        googleMock.mockImplementation(async () => { calls.push('google'); throw httpFailure(); });
        myMemoryMock.mockImplementation(async () => { calls.push('myMemory'); return '官方译文'; });
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('官方译文');
        expect(calls).toEqual(['microsoft', 'alibabaFree', 'google', 'myMemory']);
        expect(microsoftMock).toHaveBeenCalledWith(['Hello'], 'auto', 'zh-Hans', expect.any(AbortSignal), true,
            expect.objectContaining({holdUntil: expect.any(Function)}));
        expect(officialMock).toHaveBeenCalledWith('alibabaFree', expect.objectContaining({origin: 'Hello', sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}));
        expect(myMemoryMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello', serviceOverride: 'myMemory', abortSignal: expect.any(AbortSignal)}));
    });

    it('每次线路尝试上报免费服务标识、结果、耗时与文本长度', async () => {
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<Record<string, unknown>> = [];
        microsoftMock.mockRejectedValue(httpFailure());
        officialMock.mockResolvedValue('阿里翻译 译文');
        const message = attachTranslationRouteObserver({origin: 'Hello route'}, observation => observations.push({...observation}));

        await expect(settle(freeTranslation(withProviderSnapshot(message, mockConfig)) as Promise<string>)).resolves.toBe('阿里翻译 译文');

        expect(observations).toEqual([
            {route: 'microsoft', outcome: 'error', durationMs: expect.any(Number), chars: 11},
            {route: 'alibabaFree', outcome: 'success', durationMs: expect.any(Number), chars: 11},
        ]);
    });

    it('首个服务成功即返回，不会外发给后续服务', async () => {
        microsoftMock.mockResolvedValue(['微软译文']);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: 'Hello'}, mockConfig)))).resolves.toBe('微软译文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).not.toHaveBeenCalled();
        expect(myMemoryMock).not.toHaveBeenCalled();
    });

    it('图片裸网址原样返回时不轮询后备服务或报免费线路全部失败', async () => {
        const url = 'docs.sglang.io/cookbook';
        microsoftMock.mockResolvedValue([url]);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: [url]}, mockConfig)))).resolves.toEqual([url]);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).not.toHaveBeenCalled();
        expect(googleMock).not.toHaveBeenCalled();
        expect(myMemoryMock).not.toHaveBeenCalled();
    });

    it('中文目标遇到整段日文时换线，后续段落仍可使用原线路', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const japanese = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
        microsoftMock.mockResolvedValueOnce([japanese]).mockResolvedValueOnce(['下一段的中文译文']);
        officialMock.mockResolvedValue('这个文件的首字母也有限制。');
        const origin = 'There are also restrictions on the first character of this file.';

        await expect(settle(translateFreeText(origin))).resolves.toBe('这个文件的首字母也有限制。');
        await expect(settle(translateFreeText('The next paragraph has different text.'))).resolves.toBe('下一段的中文译文');
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('英文标签列表被线路原样返回时换用后备服务，且不把该线路全局冷却', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const tags = 'solo, blush, smile, bangs, looking_at_viewer, long_hair, blue_eyes';
        microsoftMock.mockImplementation(async ([text]) => [text]);
        officialMock.mockResolvedValue('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');

        await expect(settle(translateFreeText(tags))).resolves.toBe('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');
        await expect(settle(translateFreeText('solo, blush, smile, bangs, long_hair, blue_eyes, white_dress')))
            .resolves.toBe('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(officialMock).toHaveBeenCalledTimes(2);
    });

    it('短英文标题被线路原样返回时换用后备服务', async () => {
        mockConfig.freeTranslationOrder = ['transmart', 'google'];
        webMock.mockResolvedValue('Frontend Developer');
        googleMock.mockResolvedValue('前端开发者');

        await expect(settle(translateFreeText('Frontend Developer'))).resolves.toBe('前端开发者');
        expect(webMock).toHaveBeenCalledWith('transmart', 'Frontend Developer', 'auto', 'zh-Hans', expect.any(AbortSignal));
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it.each([
        ['Division (', '（', '除法（'],
        ['Logical NOT (', 'LOGICAL NOT (', '逻辑非（'],
    ] as const)('免费池拒绝 Swift 运算符 %j 的无效成功结果并继续既有降级', async (source, invalid, translated) => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        officialMock.mockImplementation(async (_id, request) => request.origin === ')' ? ')' : translated);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string}> = [];
        const message = attachTranslationRouteObserver({origin: [source, ')'], targetLanguage: 'zh-Hans'},
            observation => observations.push({route: observation.route, outcome: observation.outcome}));
        // 实际全文槽包含本地保真的右括号；无字母的槽仍允许原样返回。
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => text === ')'
            ? ')' : text === source ? invalid : '下一段中文译文'));
        await expect(settle(freeTranslation(withProviderSnapshot(message, mockConfig)))).resolves.toEqual([translated, ')']);
        expect(observations).toContainEqual({route: 'microsoft', outcome: 'error'});
        expect(observations).toContainEqual({route: 'alibabaFree', outcome: 'success'});
        expect(officialMock).toHaveBeenCalledWith('alibabaFree', expect.objectContaining({origin: source}));
        expect(officialMock.mock.calls.filter(([, request]) => request.origin === source)).toHaveLength(1);
        const fallbackCallsBeforeLater = officialMock.mock.calls.length;
        // 这是文本级无效响应，不是 provider 全局冷却：下一段仍可命中微软。
        await expect(settle(translateFreeText('A later paragraph remains readable.'))).resolves.toBe('下一段中文译文');
        expect(microsoftMock.mock.calls.some(([texts]) => texts[0] === 'A later paragraph remains readable.')).toBe(true);
        expect(officialMock).toHaveBeenCalledTimes(fallbackCallsBeforeLater);
    });

    it.each([
        ['Division (', '（'],
        ['Logical NOT (', 'LOGICAL NOT ('],
    ] as const)('运算符 %j 无有效后备时保留失败，不冒充已完成或自行接受 unchanged', async (source, invalid) => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        microsoftMock.mockResolvedValue([invalid]);
        officialMock.mockResolvedValue(invalid);
        await expect(settle(translateFreeText(source))).rejects.toThrow('返回未翻译原文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('单服务检查也拒绝运算符丢词，不偷偷换线', async () => {
        officialMock.mockResolvedValue('（');
        await expect(translateFreeTranslationProvider('alibabaFree', withProviderSnapshot({
            origin: 'Division (', targetLanguage: 'zh-Hans',
        }, mockConfig))).rejects.toThrow('返回未翻译原文');
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('保存顺序里的有 Key 服务全部剔除，仅按所选免密钥服务翻译', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL', 'openai', 'custom:key-provider', 'myMemory', 'microsoft'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx', openai: 'secret-key'};
        myMemoryMock.mockResolvedValue('MyMemory');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('MyMemory');
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(officialMock).not.toHaveBeenCalled();
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['myMemory', 'microsoft']);
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).token).toEqual({});
    });

    it('旧设置只保存有 Key 服务时回到匿名默认链，历史 Key 不影响选择', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx'};
        myMemoryMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('备用');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['microsoft', 'bilibiliFree', 'transmart', 'volcengineFree', 'doubaoWeb', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'myMemory', 'reversoFree', 'apertiumFree', 'alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree']);
    });

    it('上游挂起时局部超时继续降级，下一段跳过正在冷却的上游', async () => {
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        officialMock.mockResolvedValue('备用');
        const first = translateFreeText('Hello');
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(first).resolves.toBe('备用');
        // 冷却时长带抖动，且到期后允许再次探测；断言必须落在冷却窗口内，
        // 否则 settle 推进的时钟可能越过冷却终点，把合法探测当成未跳过。
        const second = translateFreeText('World');
        await vi.advanceTimersByTimeAsync(900);
        expect(microsoftMock).toHaveBeenCalledOnce();
        await expect(settle(second)).resolves.toBe('备用');
        expect(microsoftMock.mock.calls[0][3].aborted).toBe(true);
    });

    it('返回空译文时继续降级，全部失败只汇总安全原因', async () => {
        microsoftMock.mockResolvedValue(['']);
        googleMock.mockRejectedValue(httpFailure(429));
        const request = translateFreeText('private source text');
        await expect(request).rejects.toThrow('微软翻译: 未返回有效译文；阿里翻译: HTTP 503；谷歌翻译: HTTP 429；MyMemory: HTTP 503');
        await expect(request).rejects.not.toThrow('private');
    });

    it('请求启动后修改全局顺序、语言、凭据和端点不影响在途降级', async () => {
        let rejectFirst!: (error: Error) => void;
        microsoftMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
        officialMock.mockResolvedValue('原配置译文');
        mockConfig.token.deeplx = 'original-key';
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const request = translateFreeText('Hello');
        await flush();
        mockConfig.token.deeplx = 'new-key';
        mockConfig.deeplx = 'https://new.example/translate';
        mockConfig.from = 'ja';
        mockConfig.to = 'fr';
        mockConfig.freeTranslationOrder.splice(0, 2, 'google');
        rejectFirst(httpFailure());
        await expect(request).resolves.toBe('原配置译文');
        const fallbackRequest = officialMock.mock.calls[0][1];
        expect(fallbackRequest).toMatchObject({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'});
        expect(readSnapshot(fallbackRequest)).toMatchObject({
            token: {}, proxy: {}, deeplx: DEFAULT_DEEPLX_ENDPOINT,
            freeTranslationOrder: ['microsoft', 'alibabaFree'],
        });
        expect(Object.isFrozen(readSnapshot(fallbackRequest).freeTranslationOrder)).toBe(true);
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('broker 附带的配置快照优先于已经变化的全局设置', async () => {
        mockConfig.freeTranslationOrder = ['myMemory'];
        mockConfig.myMemoryEmail = 'old@example.com';
        const snapshot = createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig));
        const message = attachTranslationProviderConfig({origin: 'Hello', targetLanguage: 'ja'}, snapshot);
        mockConfig.freeTranslationOrder = ['google'];
        mockConfig.myMemoryEmail = 'new@example.com';
        myMemoryMock.mockResolvedValue('冻结译文');
        await expect(settle(freeTranslation(withProviderSnapshot(message, mockConfig)))).resolves.toBe('冻结译文');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).myMemoryEmail).toBe('old@example.com');
        expect(myMemoryMock.mock.calls[0][0].targetLanguage).toBe('ja');
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('被官方接口忽略的残留 proxy 不影响配额冷却身份', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        googleMock.mockResolvedValue('备用');
        myMemoryMock.mockRejectedValue(httpFailure(429));
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.proxy.myMemory = 'https://other.example/memory';
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        expect(myMemoryMock).toHaveBeenCalledOnce();
    });

    it('更换 MyMemory 邮箱不继承旧匿名/邮箱额度冷却', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        myMemoryMock.mockRejectedValueOnce(httpFailure(429)).mockResolvedValue('新邮箱译文');
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.myMemoryEmail = 'new@example.com';
        await expect(settle(translateFreeText('two'))).resolves.toBe('新邮箱译文');
        expect(myMemoryMock).toHaveBeenCalledTimes(2);
    });

    it.each(['token', 'endpoint', 'proxy'])('更换独立 阿里翻译 的%s 不改变免费链的匿名连接或冷却状态', async changed => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'google'];
        mockConfig.token.deeplx = 'old-key';
        officialMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        if (changed === 'token') mockConfig.token.deeplx = 'new-key';
        else if (changed === 'endpoint') mockConfig.deeplx = 'https://new.example/translate';
        else mockConfig.proxy.deeplx = 'https://proxy.example/translate';
        await expect(settle(translateFreeText('three'))).resolves.toBe('备用');
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('已保存的 阿里翻译 代理及默认地址都不会绕过匿名公共接口的冷却', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'google'];
        mockConfig.proxy.deeplx = 'https://active.example/translate';
        officialMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.deeplx = 'https://unused.example/translate';
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it.each(['deeplx', 'lingvaFree'])('第三方旧节点 %s 不会参与检查或已保存的免费顺序', async id => {
        mockConfig.freeTranslationOrder = [id, 'google'];
        googleMock.mockResolvedValue('官方译文');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('官方译文');
        await expect(translateFreeTranslationProvider(id, withProviderSnapshot({origin: 'Hello'}, mockConfig))).rejects.toThrow('无效的免费翻译服务');
        expect(officialMock).not.toHaveBeenCalled();
    });

    it('single-provider batches respect Microsoft concurrency and spacing while preserving output order', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{text: string; resolve: (value: string[]) => void}> = [];
        let active = 0;
        let maximum = 0;
        microsoftMock.mockImplementation(([text]: [string]) => new Promise<string[]>(resolve => {
            active += 1;
            maximum = Math.max(maximum, active);
            pending.push({text, resolve: value => { active -= 1; resolve(value); }});
        }));
        const request = freeTranslation(withProviderSnapshot({origin: ['A', 'B', 'C', 'D', 'E', 'F']}, mockConfig));
        await flush();
        expect(pending).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(2);
        pending[1].resolve(['译:B']);
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(3);
        pending[0].resolve(['译:A']);
        await vi.advanceTimersByTimeAsync(100);
        pending[3].resolve(['译:D']);
        await vi.advanceTimersByTimeAsync(100);
        pending[2].resolve(['译:C']);
        await vi.advanceTimersByTimeAsync(100);
        pending[5].resolve(['译:F']);
        pending[4].resolve(['译:E']);
        await expect(request).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E', '译:F']);
        expect(maximum).toBe(2);
        expect(FREE_TRANSLATION_BATCH_CONCURRENCY).toBe(6);
    });

    it('a shared batch deadline includes pacing and prevents later segments starting', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<(value: string[]) => void> = [];
        microsoftMock.mockImplementation(() => new Promise<string[]>(resolve => { pending.push(resolve); }));
        const request = freeTranslation(withProviderSnapshot({origin: ['A', 'B', 'C', 'D', 'E'], requestTimeoutMs: 500}, mockConfig));
        const assertion = expect(request).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(300);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        pending[0](['译:A']);
        await flush();
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(200);
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(officialMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('批量遇限流后后续段跳过失败服务，保序翻译', async () => {
        microsoftMock.mockRejectedValue(httpFailure(429));
        officialMock.mockImplementation(async (_id: string, request: {origin: string}) => `译:${request.origin}`);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: ['A', 'B', 'C', 'D', 'E']}, mockConfig)))).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E']);
        expect(microsoftMock).toHaveBeenCalledTimes(1);
        expect(officialMock).toHaveBeenCalledTimes(5);
    });

    it('调用方取消中止所有在途 worker，不启动未领取段落、不继续降级', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const controller = new AbortController();
        const releases: Array<(value: string[]) => void> = [];
        microsoftMock.mockImplementation(() => new Promise<string[]>(resolve => {releases.push(resolve);}));
        const request = freeTranslation(withProviderSnapshot({origin: ['A', 'B', 'C', 'D', 'E'], abortSignal: controller.signal}, mockConfig));
        const assertion = expect(request).rejects.toThrow('用户取消');
        await vi.advanceTimersByTimeAsync(100);
        controller.abort(new Error('用户取消'));
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(microsoftMock.mock.calls.every(call => call[3].aborted)).toBe(true);
        expect(officialMock).not.toHaveBeenCalled();
        const resumed = translateFreeText('next');
        await vi.advanceTimersByTimeAsync(0);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        microsoftMock.mockResolvedValue(['恢复']);
        releases.forEach(release => release(['迟到译文']));
        await expect(settle(resumed)).resolves.toBe('恢复');
    });

    it('任一文本耗尽所有备用后取消 sibling，避免余下请求继续外发', async () => {
        microsoftMock.mockImplementation(([text]: [string]) => text === 'bad' ? Promise.reject(httpFailure()) : new Promise(() => {}));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: ['bad', 'slow-1', 'slow-2', 'not-started']}, mockConfig)))).rejects.toThrow('免费翻译服务均不可用');
        expect(microsoftMock).toHaveBeenCalledTimes(1);
        expect(microsoftMock.mock.calls.slice(1).every(call => call[3].aborted)).toBe(true);
        expect(officialMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect(myMemoryMock).toHaveBeenCalledOnce();
    });

    it.each(['single', 'batch'])('预先取消的%s消息不启动任何服务', async kind => {
        const controller = new AbortController();
        controller.abort('stop');
        await expect(freeTranslation(withProviderSnapshot({origin: kind === 'batch' ? ['Hello'] : 'Hello', abortSignal: controller.signal}, mockConfig)))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it.each([{sourceLanguage: 'en'}, {targetLanguage: 'ja'}])('显式语言覆盖传入每个备用 provider %#', async languages => {
        officialMock.mockResolvedValue('译文');
        await expect(settle(translateFreeText('Hello', languages))).resolves.toBe('译文');
        expect(officialMock.mock.calls[0][1]).toMatchObject(languages);
    });

    it('空批量直接返回并拒绝非文本输入', async () => {
        await expect(settle(freeTranslation(withProviderSnapshot({origin: []}, mockConfig)))).resolves.toEqual([]);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: [42 as unknown as string]}, mockConfig)))).rejects.toThrow('仅支持文本输入');
        await expect(settle(freeTranslation(withProviderSnapshot({origin: 42 as unknown as string}, mockConfig)))).rejects.toThrow('仅支持文本输入');
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('原生高槽批次在任何 HTTP 前拒绝非字符串来源', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = Array.from({length: 9}, (_, index) => index === 7 ? 42 as unknown as string : `Source ${index}`);
        await expect(freeTranslation(withProviderSnapshot({origin: origins}, mockConfig))).rejects.toThrow('仅支持文本输入');
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2, 4, 8])('成功结果交付前后第 %s 轮微任务取消，不外发后续槽且保留取消原因', async microtasks => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        microsoftMock.mockImplementation(async (sources: string[]) => sources.map(source => `有效译文：${source}`));
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const owner = new AbortController();
        const reason = new Error('用户在结果交付边界取消');
        let callsAtCancellation = -1;
        const cancel = (remaining: number) => {
            if (remaining > 0) queueMicrotask(() => cancel(remaining - 1));
            else {
                callsAtCancellation = microsoftMock.mock.calls.length;
                owner.abort(reason);
            }
        };
        const origins = Array.from({length: 17}, (_, index) => `Source passage ${index}`);
        const request = freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: origins, abortSignal: owner.signal}, event => {
            if (event.outcome === 'success' && !owner.signal.aborted) cancel(microtasks);
        }), mockConfig));
        await expect(settle(request)).rejects.toBe(reason);
        expect(callsAtCancellation).toBeGreaterThan(0);
        expect(microsoftMock).toHaveBeenCalledTimes(callsAtCancellation);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(microsoftMock).toHaveBeenCalledTimes(callsAtCancellation);
    });
});

it.each(['transmart', 'yandexFree', 'volcengineFree'])('routes %s only via free policy with request language and cancellation', async id => {
    mockConfig.freeTranslationOrder = [id];
    webMock.mockResolvedValue('新译文');
    const abort = new AbortController();
    await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hant', abortSignal: abort.signal}))).resolves.toBe('新译文');
    expect(webMock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hant', expect.any(AbortSignal));
});
it('maps background health to the enabled services of the current settings for the weight snapshot', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'google', 'myMemory'];
    mockConfig.myMemoryEmail = 'old@example.com';
    microsoftMock.mockRejectedValue(httpFailure(503));
    googleMock.mockRejectedValue(httpFailure(413));
    myMemoryMock.mockResolvedValue('MyMemory 译文');
    await expect(settle(translateFreeText('Hello'))).resolves.toBe('MyMemory 译文');

    const snapshot = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)), Date.now());
    const byId = new Map(snapshot.entries.map(entry => [entry.providerId, entry]));
    expect(snapshot.total).toBe(100);
    expect(byId.get('microsoft')).toMatchObject({weight: 0, status: 'cooling'});
    // 文本级 413 不产生健康记录，谷歌仍按默认权重参与分配。
    expect(byId.get('google')).toMatchObject({status: 'ready'});
    expect(byId.get('google')!.weight).toBeGreaterThan(0);
    expect(byId.get('myMemory')).toMatchObject({status: 'ready'});
    expect(byId.get('alibabaFree')).toMatchObject({weight: 0, status: 'disabled'});
    expect(JSON.stringify(snapshot)).not.toMatch(/[a-f0-9]{64}|old@example\.com/u);

    // MyMemory 邮箱属于连接身份；换邮箱后不能把旧身份的健康记录展示给新配置。
    mockConfig.freeTranslationOrder = ['microsoft', 'myMemory'];
    mockConfig.myMemoryEmail = 'new@example.com';
    const changed = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)), Date.now());
    expect(changed.entries.find(entry => entry.providerId === 'google')).toMatchObject({weight: 0, status: 'disabled'});
    expect(changed.entries.find(entry => entry.providerId === 'myMemory')).toMatchObject({weight: 100, status: 'ready'});
});

it('shows a persisted legacy cooling record without performance data after a background restart', async () => {
    const {default: sha256} = await import('crypto-js/sha256');
    const retryAt = Date.now() + 60_000;
    storedHealth.records = [{identity: `google:${sha256(JSON.stringify(['google'])).toString()}`, retryAt, failures: 2, category: 'blocked'}];
    mockConfig.freeTranslationOrder = ['microsoft', 'google'];

    const snapshot = await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)), Date.now());
    expect(snapshot.entries.find(entry => entry.providerId === 'google')).toEqual({providerId: 'google', weight: 0, status: 'cooling', retryAt});
    expect(snapshot.entries.find(entry => entry.providerId === 'microsoft')).toMatchObject({weight: 100, status: 'ready'});
});

it('falls back and cools down a failed new route while keeping language errors request-local', async () => {
    mockConfig.freeTranslationOrder = ['transmart', 'yandexFree', 'volcengineFree'];
    webMock.mockImplementation(async id => {if (id === 'transmart') throw httpFailure(429); if (id === 'yandexFree') throw httpFailure(400); return '译文';});
    await expect(settle(translateFreeText('One'))).resolves.toBe('译文');
    await expect(settle(translateFreeText('Two'))).resolves.toBe('译文');
    expect(webMock.mock.calls.map(call => call[0])).toEqual(['transmart', 'yandexFree', 'volcengineFree', 'yandexFree', 'volcengineFree']);
});

it.each([
    ['youdaoFree', 'chinese'], ['icibaFree', 'chinese'],
    ['reversoFree', 'extra'], ['apertiumFree', 'extra'],
] as const)('routes %s through the dedicated adapter with frozen language and cancellation', async (id, kind) => {
    mockConfig.freeTranslationOrder = [id];
    const mock = kind === 'chinese' ? chineseMock : extraMock;
    mock.mockResolvedValue('适配器译文');
    const abort = new AbortController();
    await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hans', abortSignal: abort.signal}))).resolves.toBe('适配器译文');
    if (kind === 'chinese') expect(mock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hans', expect.any(AbortSignal));
    else expect(mock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hans', expect.any(AbortSignal));
});

it('passes balanced mode while excluding supplied manual weights from the frozen request', async () => {
    mockConfig.freeTranslationOrder = ['microsoft', 'reversoFree'];
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationWeights = {microsoft: 7, reversoFree: 2};
    microsoftMock.mockRejectedValue(httpFailure(429));
    extraMock.mockResolvedValue('均衡译文');
    await expect(settle(translateFreeText('Hello'))).resolves.toBe('均衡译文');
    const request = extraMock.mock.calls[0]![4];
    expect(request).toBeInstanceOf(AbortSignal);
    const snapshot = createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig));
    expect(mockConfig.freeTranslationMode).toBe('balanced');
    expect(mockConfig.freeTranslationWeights).toEqual({microsoft: 7, reversoFree: 2});
    expect(Object.isFrozen(snapshot.freeTranslationOrder)).toBe(true);
    expect(snapshot).not.toHaveProperty('freeTranslationWeights');
});


it('六家官方节点同时分担不同段落，任务上限和输出顺序保持有界', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'transmart', 'google', 'alibabaFree', 'modernMtFree', 'laraFree'];
    const running: Array<{id: string; text: string; resolve: () => void}> = [];
    let active = 0;
    let maximum = 0;
    const pending = (id: string, text: string, array = false) => new Promise(resolve => {
        active++; maximum = Math.max(maximum, active);
        running.push({id, text, resolve: () => {active--; resolve(array ? [`译:${text}`] : `译:${text}`);}});
    });
    microsoftMock.mockImplementation(([text]: string[]) => pending('microsoft', text, true));
    googleMock.mockImplementation(text => pending('google', text));
    webMock.mockImplementation((id, text) => pending(id, text));
    officialMock.mockImplementation((id, request) => pending(id, request.origin));
    const texts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const request = freeTranslation(withProviderSnapshot({origin: texts}, mockConfig));
    await flush();
    expect(running).toHaveLength(6);
    expect(new Set(running.map(item => item.id)).size).toBe(6);
    expect(running.map(item => item.text)).toEqual(texts.slice(0, 6));
    running.splice(0).reverse().forEach(item => item.resolve());
    await vi.advanceTimersByTimeAsync(1000);
    running.splice(0).reverse().forEach(item => item.resolve());
    await expect(settle(request)).resolves.toEqual(texts.map(text => `译:${text}`));
    expect(maximum).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
});

it('取消同时停止六家节点，不继续领取队列中的段落', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'transmart', 'google', 'alibabaFree', 'modernMtFree', 'laraFree'];
    const signals: AbortSignal[] = [];
    const pending = (signal: AbortSignal) => {signals.push(signal); return new Promise(() => {});};
    microsoftMock.mockImplementation((_texts, _from, _to, signal) => pending(signal));
    googleMock.mockImplementation((_text, _from, _to, signal) => pending(signal));
    webMock.mockImplementation((_id, _text, _from, _to, signal) => pending(signal));
    officialMock.mockImplementation((_id, request) => pending(request.abortSignal));
    const caller = new AbortController();
    const request = freeTranslation(withProviderSnapshot({origin: ['A', 'B', 'C', 'D', 'E', 'F', 'queued'], abortSignal: caller.signal}, mockConfig));
    const assertion = expect(request).rejects.toMatchObject({name: 'AbortError'});
    await flush();
    expect(signals).toHaveLength(6);
    caller.abort();
    await assertion;
    expect(signals).toHaveLength(6);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it.each([
    ['direct', 'single'], ['direct', 'batch'], ['broker', 'single'], ['broker', 'batch'],
])('%s 的 %s 免费翻译实际只请求官方阿里节点，隔离历史凭据和私有代理', async (entrypoint, mode) => {
    const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
    officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
    mockConfig.freeTranslationOrder = ['alibabaFree'];
    mockConfig.token = {deeplx: 'stored-secret', aliyunTranslation: 'cloud-secret'};
    mockConfig.proxy = {deeplx: 'https://private.example/secret', aliyunTranslation: 'https://proxy.example/secret'};
    mockConfig.customHeaders = {aliyunTranslation: '{"Authorization":"private-header"}'};
    mockConfig.secret = {aliyunTranslation: 'private-cloud-secret'};
    const fetchMock = vi.fn(async (url, init) => String(url).endsWith('/csrftoken')
        ? Response.json({token: 'anonymous-csrf', headerName: 'X-XSRF-TOKEN_PROPERTY_ITEM'})
        : Response.json({success: true, data: {translateText: `译:${(init.body as FormData).get('query')}`}}));
    vi.stubGlobal('fetch', fetchMock);
    const origin = mode === 'batch' ? ['Hello', 'World'] : 'Hello';
    const message = {origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans'};
    const request = entrypoint === 'broker'
        ? attachTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig))) : message;
    await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toEqual(mode === 'batch' ? ['译:Hello', '译:World'] : '译:Hello');
    expect(fetchMock).toHaveBeenCalledTimes(mode === 'batch' ? 4 : 2);
    for (const [url, init] of fetchMock.mock.calls) {
        expect(new URL(String(url)).hostname).toBe('translate.alibaba.com');
        expect(init.credentials).toBe('omit');
        const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body;
        expect(JSON.stringify([url, init.headers, body])).not.toMatch(/stored-secret|private|proxy\.example|cloud-secret/u);
    }
    expect(readSnapshot(officialMock.mock.calls[0][1])).toMatchObject({token: {}, secret: {}, proxy: {}, customHeaders: {}});
    expect(mockConfig.token.deeplx).toBe('stored-secret');
});


// 全部输出来自受控 mock/HTTP 端口；63/1760 仅匹配规模，不复制 Wikipedia 原文或证明原生效果。
describe('owner-local bounded high-slot free batches', () => {
    const ownerSlots = () => Array.from({length: 63}, (_, index) =>
        `Owner slot ${String(index).padStart(2, '0')} has prose`.padEnd(index === 62 ? 24 : 28, '.'));
    const valid = (texts: readonly string[]) => texts.map(text => `译:${text}`);

    it('63 slots / 1760 characters use eight real Microsoft array HTTP calls under one twenty-second budget', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/microsoft')>('@/src/providers/translation/microsoft');
        microsoftMock.mockImplementation(actual.translateMicrosoftTexts);
        mockConfig.freeTranslationOrder = ['microsoft'];
        mockConfig.freeTranslationTimeoutMs = 5_000;
        const originals = ownerSlots();
        const expected = valid(originals);
        expect(originals.reduce((sum, text) => sum + text.length, 0)).toBe(1760);
        const starts: number[] = [];
        let active = 0;
        let maximum = 0;
        const fetchMock = vi.fn((_url, init) => new Promise<Response>((resolve, reject) => {
            const texts: string[] = JSON.parse(String(init.body));
            starts.push(Date.now()); active += 1; maximum = Math.max(maximum, active);
            const abort = () => { clearTimeout(timer); active -= 1; reject(init.signal.reason); };
            const timer = setTimeout(() => {
                init.signal.removeEventListener('abort', abort); active -= 1;
                resolve(Response.json(texts.map(text => ({translations: [{text: `译:${text}`}]}))));
            }, 2_500);
            init.signal.addEventListener('abort', abort, {once: true});
        }));
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        const start = Date.now();
        let outcome: unknown;
        const request = freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: originals, requestTimeoutMs: 20_000}, event => observations.push(event)), mockConfig));
        void request.then(value => { outcome = {value}; }, error => { outcome = {error}; });
        originals[0] = 'Caller mutation after dispatch';
        mockConfig.freeTranslationOrder = ['google'];
        await vi.advanceTimersByTimeAsync(11_000);
        // 基线逐槽传输在此仍未完成；这里检查实际 HTTP body/call，而非把逻辑调用当 HTTP 数。
        expect(outcome).toEqual({value: expected});
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)).length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(maximum).toBe(2);
        expect(starts.every((time, index) => index === 0 || time - starts[index - 1]! >= 100)).toBe(true);
        expect(Date.now() - start).toBeLessThan(20_000);
        expect(observations).toHaveLength(8);
        expect(observations.every(event => event.route === 'microsoft' && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(1760);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['microsoft', 'google'] as const)('免费池尊重 %s 子服务关闭偏好，不通过组或 scalar 收集重新合批', async service => {
        mockConfig.freeTranslationOrder = [service];
        mockConfig.nativeBatchTranslationEnabled = {[service]: false};
        if (service === 'microsoft') {
            const actual = await vi.importActual<typeof import('@/src/providers/translation/microsoft')>('@/src/providers/translation/microsoft');
            microsoftMock.mockImplementation(actual.translateMicrosoftTexts);
        } else {
            const actual = await vi.importActual<typeof import('@/src/providers/translation/google')>('@/src/providers/translation/google');
            googleMock.mockImplementation(actual.translateGoogleText);
        }
        const bodies: string[][] = [];
        const fetchMock = vi.fn(async (_url, init) => {
            const body = JSON.parse(String(init.body));
            const sources: string[] = service === 'microsoft' ? body : body[0][0];
            bodies.push(sources);
            return service === 'microsoft'
                ? Response.json(sources.map(text => ({translations: [{text: `译:${text}`}]})))
                : Response.json([sources.map(text => `译:${text.replace(/^<pre>|<\/pre>$/gu, '')}`)]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const origins = ownerSlots().slice(0, 9);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins, requestTimeoutMs: 20_000}, mockConfig)))).resolves.toEqual(valid(origins));
        expect(bodies).toHaveLength(9);
        expect(bodies.every(body => body.length === 1)).toBe(true);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        if (service === 'google') expect(googleMock.mock.calls.every(call => call[4] === false)).toBe(true);
    });

    it('Google high-slot groups use the existing native array endpoint and retain pool pacing', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/google')>('@/src/providers/translation/google');
        googleOwnerMock.mockImplementation(actual.translateGoogleOwnerTexts);
        mockConfig.freeTranslationOrder = ['google'];
        const starts: number[] = [];
        const fetchMock = vi.fn(async (_url, init) => {
            starts.push(Date.now());
            const texts: string[] = JSON.parse(String(init.body))[0][0];
            return Response.json([texts.map(text => `译:${text.replace(/^<pre>|<\/pre>$/gu, '')}`)]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const origins = ownerSlots();
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins}, mockConfig)))).resolves.toEqual(valid(origins));
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(googleOwnerMock.mock.calls.map(call => call[0].length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(starts.every((time, index) => index === 0 || time - starts[index - 1]! >= 300)).toBe(true);
        expect(googleMock).not.toHaveBeenCalled();
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('escaped character bounds split small groups and a pre-existing long slot stays a singleton', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = ['&'.repeat(500), ...Array.from({length: 8}, (_, index) => `Small prose ${index}`)];
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins}, mockConfig)))).resolves.toEqual(valid(origins));
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([1, 8]);
        expect(microsoftMock.mock.calls[0][0]).toEqual([origins[0]]);
        // 不截断单槽，不为了满足小组大小而给同一 owner 增加总预算。
        expect(microsoftMock.mock.calls[1][0]).toEqual(origins.slice(1));
        microsoftMock.mockClear();
        const bounded = Array.from({length: 9}, () => '&'.repeat(160));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: bounded}, mockConfig)))).resolves.toEqual(valid(bounded));
        // 每槽保守估算 971，两槽 1942；第三槽会越过 2000，而单槽未超限。
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([2, 2, 2, 2, 1]);
    });

    it('duplicates remain independent ordinal slots and out-of-order group completion keeps source order', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = Array.from({length: 9}, () => 'Same prose repeated');
        let group = 0;
        const finished: number[] = [];
        microsoftMock.mockImplementation((texts: string[]) => {
            const index = group++;
            return new Promise<string[]>(resolve => setTimeout(() => {
                finished.push(index); resolve(texts.map((_, ordinal) => `第${index}组第${ordinal}槽译文`));
            }, index === 0 ? 400 : 10));
        });
        const request = freeTranslation(withProviderSnapshot({origin: origins}, mockConfig));
        await vi.advanceTimersByTimeAsync(500);
        await expect(request).resolves.toEqual([...Array.from({length: 8}, (_, ordinal) => `第0组第${ordinal}槽译文`), '第1组第0槽译文']);
        expect(finished).toEqual([1, 0]);
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([origins.slice(0, 8), origins.slice(8)]);
    });

    it('pure whitespace, edge whitespace, literal markers, HTML text and internal newlines stay in their original slots', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = [' \tAlpha prose  \n', '', ' \n\t', 'A & <b>"quoted"</b>',
            'Literal ___FLUENTREAD_literal_0_BEGIN___code___FLUENTREAD_literal_0_END___',
            'Line one\n\n  Line two', 'Repeated prose', 'Repeated prose', 'Last prose'];
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => ` ${`译:${text.trim()}`} `));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins}, mockConfig)))).resolves.toEqual([
            ' \t译:Alpha prose  \n', '', ' \n\t', '译:A & <b>"quoted"</b>',
            '译:Literal ___FLUENTREAD_literal_0_BEGIN___code___FLUENTREAD_literal_0_END___',
            '译:Line one\n\n  Line two', '译:Repeated prose', '译:Repeated prose', '译:Last prose',
        ]);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(microsoftMock.mock.calls[0][0]).toEqual(origins.filter(text => text.trim()));
    });

    it.each(['missing', 'extra', 'non-string', 'empty', 'unchanged', 'wrong-language', 'injected-marker'])('one %s slot rejects the whole native group and follows configured fallback', async kind => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = [...Array.from({length: 8}, (_, index) => `This English paragraph contains several ordinary words for slot ${index}.`), ''];
        microsoftMock.mockImplementation(async (texts: string[]) => {
            const values: unknown[] = valid(texts);
            if (kind === 'missing') values.pop();
            else if (kind === 'extra') values.push('多余译文');
            else if (kind === 'non-string') values[6] = null;
            else if (kind === 'empty') values[6] = ' \t';
            else if (kind === 'unchanged') values[6] = texts[6];
            else if (kind === 'wrong-language') values[6] = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
            else values[6] = serializeTranslationSlots(texts).starts[0];
            return values;
        });
        googleOwnerMock.mockImplementation(async (texts: string[]) => valid(texts));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins}, mockConfig)))).resolves.toEqual([...valid(origins.slice(0, 8)), '']);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock.mock.calls[0][0]).toEqual(origins.slice(0, 8));
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'google']);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });

    it('non-native high-slot batches retain per-slot candidate calls and actual HTTP counts', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
        officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
        mockConfig.freeTranslationOrder = ['alibabaFree'];
        const origins = Array.from({length: 9}, (_, index) => `Anonymous prose ${index}`);
        const queryTexts: string[] = [];
        const fetchMock = vi.fn(async (url, init) => {
            if (String(url).endsWith('/csrftoken')) return Response.json({token: 'fixture-csrf', headerName: 'X-XSRF-TOKEN_PROPERTY_ITEM'});
            const query = String((init.body as FormData).get('query')); queryTexts.push(query);
            return Response.json({success: true, data: {translateText: `译:${query}`}});
        });
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: origins}, event => observations.push(event)), mockConfig)))).resolves.toEqual(valid(origins));
        expect(officialMock).toHaveBeenCalledTimes(9);
        expect(fetchMock).toHaveBeenCalledTimes(18); // 9 槽各自 CSRF + text，每槽仍独立 candidate，并非把两个 group 当作 HTTP。
        expect([...queryTexts].sort()).toEqual([...origins].sort());
        expect(officialMock.mock.calls.map(call => call[1].origin).sort()).toEqual([...origins].sort());
        expect(queryTexts.every(text => !text.includes('___FLUENTREAD_'))).toBe(true);
        expect(observations).toHaveLength(9);
        expect(observations.every(event => event.route === 'alibabaFree' && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(origins.join('').length);
        expect(readSnapshot(officialMock.mock.calls[0][1])).toMatchObject({token: {}, secret: {}, proxy: {}, customHeaders: {}});
    });

    it('pure-whitespace high-slot batches stay local and already-cancelled callers start no group', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const whitespace = Array.from({length: 15}, (_, index) => index % 2 ? ' \t\n' : '');
        await expect(freeTranslation(withProviderSnapshot({origin: whitespace}, mockConfig))).resolves.toEqual(whitespace);
        const cancelled = new AbortController(); cancelled.abort();
        await expect(freeTranslation(withProviderSnapshot({origin: whitespace, abortSignal: cancelled.signal}, mockConfig))).rejects.toMatchObject({name: 'AbortError'});
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleOwnerMock).not.toHaveBeenCalled(); expect(officialMock).not.toHaveBeenCalled();
    });

    it('one group exhausting the pool cancels siblings and never claims later groups', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = ownerSlots();
        const signals: AbortSignal[] = [];
        microsoftMock.mockImplementation((texts: string[], _from, _to, signal: AbortSignal) => {
            signals.push(signal);
            return new Promise((_resolve, reject) => {
                if (texts[0] === origins[0]) setTimeout(() => reject(httpFailure(429)), 300);
                else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });
        const request = freeTranslation(withProviderSnapshot({origin: origins}, mockConfig));
        const assertion = expect(request).rejects.toThrow('免费翻译服务均不可用');
        await vi.advanceTimersByTimeAsync(300); await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(signals[0]!.aborted).toBe(false); // This attempt already failed and released its caller subscription.
        expect(signals[1]!.aborted).toBe(true); // The other attempt was still in flight and belongs to this owner.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shared deadline includes queued groups; a successful group never resets siblings to a fresh budget', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{texts: string[]; resolve: (texts: string[]) => void}> = [];
        microsoftMock.mockImplementation((texts: string[]) => new Promise<string[]>(resolve => pending.push({texts, resolve})));
        const request = freeTranslation(withProviderSnapshot({origin: ownerSlots(), requestTimeoutMs: 500}, mockConfig));
        const assertion = expect(request).rejects.toMatchObject({kind: 'timeout'});
        await vi.advanceTimersByTimeAsync(300);
        expect(pending).toHaveLength(2);
        pending[0]!.resolve(valid(pending[0]!.texts));
        await flush();
        expect(pending).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(200); await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
        pending[1]!.resolve(valid(pending[1]!.texts)); await flush();
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('equal sources in overlapping owners share no group promise, array or cancellation domain', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{texts: string[]; signal: AbortSignal; resolve: (texts: string[]) => void}> = [];
        microsoftMock.mockImplementation((texts: string[], _from, _to, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
            pending.push({texts, signal, resolve}); signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        }));
        const origins = Array.from({length: 9}, (_, index) => `Same owner prose ${index}`);
        const firstOwner = new AbortController();
        const first = freeTranslation(withProviderSnapshot({origin: origins, abortSignal: firstOwner.signal}, mockConfig));
        const firstAssertion = expect(first).rejects.toMatchObject({name: 'AbortError'});
        const second = freeTranslation(withProviderSnapshot({origin: origins}, mockConfig));
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(2);
        firstOwner.abort(); await firstAssertion;
        expect(pending.slice(0, 2).every(item => item.signal.aborted)).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(pending).toHaveLength(4);
        expect(pending.slice(2).every(item => !item.signal.aborted)).toBe(true);
        expect(pending[0]!.texts).not.toBe(pending[2]!.texts);
        expect(pending[0]!.signal).not.toBe(pending[2]!.signal);
        pending[2]!.resolve(valid(pending[2]!.texts)); pending[3]!.resolve(valid(pending[3]!.texts));
        await expect(second).resolves.toEqual(valid(origins));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('known unsupported Apertium direction does not promote a mixed pool into grouped native calls', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree', 'microsoft'];
        unsupportedApertiumMock.mockReturnValue(true);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        const origins = ownerSlots();
        await expect(settle(freeTranslation(withProviderSnapshot({origin: origins, sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, mockConfig)))).resolves.toEqual(valid(origins));
        expect(extraMock).not.toHaveBeenCalled();
        expect(mockConfig.freeTranslationOrder).toEqual(['apertiumFree', 'microsoft']);
        expect(microsoftMock).toHaveBeenCalledTimes(63);
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it.each([
        {label: 'mixed pool', order: ['microsoft', 'transmart', 'google']},
        {label: 'default full pool', order: undefined},
    ])('$label keeps high-slot inputs on the original scalar candidate path', async ({order}) => {
        mockConfig.freeTranslationOrder = order;
        const configured = order ?? FREE_TRANSLATION_PROVIDERS.map(provider => provider.id);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        googleMock.mockImplementation(async (text: string) => `译:${text}`);
        for (const mock of [webMock, chineseMock, extraMock]) mock.mockImplementation(async (_id, text: string) => `译:${text}`);
        myMemoryMock.mockImplementation(async (request: {origin: string}) => `译:${request.origin}`);
        bilibiliMock.mockImplementation(async (request: {origin: string}) => `译:${request.origin}`);
        doubaoMock.mockImplementation(async (request: {origin: string}) => `译:${request.origin}`);
        officialMock.mockImplementation(async (_id, request: {origin: string}) => `译:${request.origin}`);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        const origins = ownerSlots();
        const request = freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: origins, requestTimeoutMs: 20_000}, event => observations.push(event)), mockConfig));
        // native-only 设置不能在 dispatch 后改变已经冻结的混合池执行方式。
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        await expect(settle(request)).resolves.toEqual(valid(origins));
        const submitted = [
            ...microsoftMock.mock.calls.flatMap(call => call[0]),
            ...googleMock.mock.calls.map(call => call[0]),
            ...[webMock, chineseMock, extraMock].flatMap(mock => mock.mock.calls.map(call => call[1])),
            ...myMemoryMock.mock.calls.map(call => call[0].origin),
            ...bilibiliMock.mock.calls.map(call => call[0].origin),
            ...doubaoMock.mock.calls.map(call => call[0].origin),
            ...officialMock.mock.calls.map(call => call[1].origin),
        ];
        expect(submitted).toHaveLength(63);
        expect([...submitted].sort()).toEqual([...origins].sort());
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(observations).toHaveLength(63);
        expect(observations.every(event => configured.includes(event.route) && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(1760);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Lara real adapter keeps nine 800ms HTTP calls as separate attempts within the original twenty-second owner budget', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
        officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
        Object.assign(mockConfig, {
            freeTranslationOrder: ['laraFree'], freeTranslationMode: 'sequential',
            freeTranslationTimeoutMs: 5_000, freeTranslationCooldownMs: 60_000,
        });
        const origins = Array.from({length: 9}, (_, index) => `This paragraph contains readable English prose for slot ${index}.`);
        const expected = origins.map((_, index) => `第${index}槽中文译文`);
        const started = Date.now();
        const starts: number[] = [];
        const queries: string[] = [];
        let active = 0; let maximum = 0; let aborts = 0;
        const fetchMock = vi.fn<typeof fetch>();
        fetchMock.mockImplementation((url, init) => new Promise<Response>((resolve, reject) => {
            expect(new URL(String(url)).href).toBe('https://webapi.laratranslate.com/translate/segmented');
            expect(init!.credentials).toBe('omit');
            const body = JSON.parse(String(init!.body));
            expect(body).toMatchObject({source: 'en', target: 'zh-CN', content_type: 'text/plain'});
            const index = origins.indexOf(body.q);
            expect(index).toBeGreaterThanOrEqual(0);
            queries.push(body.q); starts.push(Date.now() - started);
            active += 1; maximum = Math.max(maximum, active);
            const signal = init!.signal!;
            const abort = () => { clearTimeout(timer); active -= 1; aborts += 1; reject(signal.reason); };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort); active -= 1;
                resolve(Response.json({status: 200, content: {translations: [{translation: expected[index]}]}}));
            }, 800);
            signal.addEventListener('abort', abort, {once: true});
        }));
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number; durationMs: number}> = [];
        let outcome: unknown;
        const request = freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({
            origin: origins, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 20_000,
        }, event => observations.push(event)), mockConfig));
        void request.then(value => {outcome = {value};}, error => {outcome = {error};});
        await vi.advanceTimersByTimeAsync(8_800);
        // 对此前 all-provider 分组生产基线，5000ms 首组超时使这条断言红；不是导出缺失或 mock API 差异。
        expect(outcome).toEqual({value: expected});
        expect(fetchMock).toHaveBeenCalledTimes(9);
        expect(officialMock.mock.calls.map(call => call[1].origin).sort()).toEqual([...origins].sort());
        expect([...queries].sort()).toEqual([...origins].sort());
        expect(starts).toEqual(Array.from({length: 9}, (_, index) => index * 1_000));
        expect(maximum).toBe(1); expect(aborts).toBe(0);
        expect(observations).toHaveLength(9);
        expect(observations.every(event => event.route === 'laraFree' && event.outcome === 'success' && event.durationMs === 800)).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(origins.join('').length);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'laraFree')?.status).toBe('ready');
        expect(mockConfig.freeTranslationTimeoutMs).toBe(5_000);
        expect(mockConfig.freeTranslationCooldownMs).toBe(60_000);
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('document-only mixed free-pool batching', () => {
    const sources = (count: number) => Array.from({length: count}, (_, index) => `Source passage ${index}`);
    const valid = (texts: readonly string[]) => texts.map(text => `译:${text}`);

    it.each([2, 8])('default full pool sends %s short document slots in one Microsoft array transport via controlled fetch', async count => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/microsoft')>('@/src/providers/translation/microsoft');
        microsoftMock.mockImplementation(actual.translateMicrosoftTexts);
        mockConfig.freeTranslationOrder = undefined;
        const originals = sources(count);
        const fetchMock = vi.fn(async (_url, init) => Response.json(JSON.parse(String(init.body))
            .map((text: string) => ({translations: [{text: `译:${text}`}]}))));
        vi.stubGlobal('fetch', fetchMock);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig)))).resolves.toEqual(valid(originals));
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual(originals);
        expect(bilibiliMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it('a scalar winner consumes only the first raw source, then an available native candidate consumes the remainder', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'microsoft', 'google'];
        officialMock.mockImplementation(async (_id, request) => `译:${request.origin}`);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observed: Array<{route: string; chars: number}> = [];
        const originals = sources(4);
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: originals, documentBatch: true}, event => observed.push(event)), mockConfig))))
            .resolves.toEqual(valid(originals));
        expect(officialMock).toHaveBeenCalledOnce();
        expect(officialMock.mock.calls[0]![1].origin).toBe(originals[0]);
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals.slice(1)]);
        expect(observed).toEqual([{route: 'alibabaFree', chars: originals[0]!.length, outcome: 'success', durationMs: 0},
            {route: 'microsoft', chars: originals.slice(1).join('').length, outcome: 'success', durationMs: 0}]);
        expect(mockConfig.freeTranslationOrder).toEqual(['alibabaFree', 'microsoft', 'google']);
    });

    it('a scalar-only pool preserves independent duplicates, whitespace and source order while continuing every untouched slot', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree'];
        officialMock.mockImplementation(async (_id, request) => `译:${request.origin}`);
        const originals = ['First source', ' ', 'First source', 'Second source', '\n'];
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig))))
            .resolves.toEqual(['译:First source', ' ', '译:First source', '译:Second source', '\n']);
        expect(officialMock.mock.calls.map(call => call[1].origin)).toEqual(['First source', 'First source', 'Second source']);
        expect(officialMock.mock.calls.every(call => !call[1].origin.includes('___FLUENTREAD_'))).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('document batching sends Doubao independent raw scalar slots, preserves blanks and duplicates, and observes only sent characters', async () => {
        mockConfig.freeTranslationOrder = ['doubaoWeb'];
        doubaoMock.mockImplementation(async request => `译:${request.origin}`);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observed: Array<{route: string; chars: number}> = [];
        const originals = ['First source', ' ', 'First source', 'Second source', '\n'];
        const before = [...originals];
        const request = attachTranslationRouteObserver({origin: originals, documentBatch: true, requestTimeoutMs: 5_000}, event => observed.push(event));

        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig))))
            .resolves.toEqual(['译:First source', ' ', '译:First source', '译:Second source', '\n']);
        expect(doubaoMock.mock.calls.map(call => call[0].origin)).toEqual(['First source', 'First source', 'Second source']);
        expect(doubaoMock.mock.calls.every(call => call[0].serviceOverride === 'doubaoWeb' && call[0].enableNativeBatch === false)).toBe(true);
        expect(observed.map(({route, chars}) => ({route, chars}))).toEqual([
            {route: 'doubaoWeb', chars: 'First source'.length},
            {route: 'doubaoWeb', chars: 'First source'.length},
            {route: 'doubaoWeb', chars: 'Second source'.length},
        ]);
        expect(originals).toEqual(before);
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a malformed native group falls back once, then uses scalar candidates within the group without quadratic retransmission or global cooling', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        microsoftMock.mockResolvedValueOnce(['译:missing slots']).mockImplementation(async (texts: string[]) => valid(texts));
        officialMock.mockImplementation(async (_id, request) => `译:${request.origin}`);
        const originals = sources(4);
        const before = [...originals];
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observed: Array<{route: string; chars: number}> = [];
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: originals, documentBatch: true}, event => observed.push(event)), mockConfig))))
            .resolves.toEqual(valid(originals));
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals, ...originals.slice(1).map(source => [source])]);
        expect(officialMock.mock.calls.map(call => call[1].origin)).toEqual([originals[0]]);
        expect(observed.map(event => event.chars)).toEqual([originals.join('').length, ...originals.map(source => source.length)]);
        expect(originals).toEqual(before);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
        microsoftMock.mockClear();
        await vi.advanceTimersByTimeAsync(200);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig)))).resolves.toEqual(valid(originals));
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals]);
    });

    it.each([true, false])('document Google owner arrays follow document intent independently of global native preference %s', async enabled => {
        mockConfig.freeTranslationOrder = ['google', 'alibabaFree'];
        mockConfig.nativeBatchTranslationEnabled = {google: enabled};
        googleOwnerMock.mockImplementation(async (texts: string[]) => valid(texts));
        const originals = sources(3);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig)))).resolves.toEqual(valid(originals));
        expect(googleOwnerMock).toHaveBeenCalledWith(originals, 'auto', 'zh-Hans', expect.any(AbortSignal),
            expect.objectContaining({holdUntil: expect.any(Function)}));
        expect(googleMock).not.toHaveBeenCalled();
        expect(officialMock).not.toHaveBeenCalled();
    });

    it('bounds groups by escaped characters and eight slots, preserves singleton long sources and out-of-order completion', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const originals = ['&'.repeat(400), ...sources(9)];
        microsoftMock.mockImplementation((texts: string[]) => new Promise(resolve => {
            setTimeout(() => resolve(valid(texts)), texts[0]!.startsWith('&') ? 500 : 0);
        }));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig)))).resolves.toEqual(valid(originals));
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([[originals[0]], originals.slice(1, 9), originals.slice(9)]);
    });

    it.each(['resolve', 'reject'] as const)('cancelled scalar continuation returns immediately and ignores late %s without starting other slots', async late => {
        mockConfig.freeTranslationOrder = ['alibabaFree'];
        let resolve!: (value: string) => void;
        let reject!: (error: Error) => void;
        officialMock.mockReturnValue(new Promise<string>((res, rej) => {resolve = res; reject = rej;}));
        const controller = new AbortController();
        const reason = new Error('Document cancelled');
        const request = freeTranslation(withProviderSnapshot({origin: sources(3), documentBatch: true, abortSignal: controller.signal}, mockConfig));
        const assertion = expect(request).rejects.toBe(reason);
        await flush();
        expect(officialMock).toHaveBeenCalledOnce();
        controller.abort(reason);
        await assertion;
        if (late === 'resolve') resolve('迟到译文'); else reject(new Error('Late provider rejection'));
        await flush();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(officialMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('single-slot continuation shares the original deadline instead of giving later slots fresh time', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree'];
        officialMock.mockImplementation(async (_id, request) => `译:${request.origin}`);
        const request = freeTranslation(withProviderSnapshot({origin: sources(3), documentBatch: true, requestTimeoutMs: 250}, mockConfig));
        const assertion = expect(request).rejects.toThrow('超时');
        await vi.advanceTimersByTimeAsync(400);
        await assertion;
        expect(officialMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('disabled document intent leaves the legacy mixed-pool scalar transport unchanged', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        const originals = sources(3);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: false}, mockConfig)))).resolves.toEqual(valid(originals));
        expect(microsoftMock.mock.calls).toHaveLength(3);
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
    });

    it('document whitespace remains local and a caller cancelled before dispatch starts no candidate', async () => {
        await expect(freeTranslation(withProviderSnapshot({origin: [' ', '\n', ''], documentBatch: true}, mockConfig))).resolves.toEqual([' ', '\n', '']);
        const controller = new AbortController();
        controller.abort(new Error('Already cancelled'));
        await expect(freeTranslation(withProviderSnapshot({origin: sources(2), documentBatch: true, abortSignal: controller.signal}, mockConfig))).rejects.toBe(controller.signal.reason);
        for (const mock of [microsoftMock, googleOwnerMock, officialMock, bilibiliMock, myMemoryMock, webMock]) expect(mock).not.toHaveBeenCalled();
    });

    it('the owner rejects an intermediate-size packet instead of claiming partially translated untouched slots', async () => {
        const {translateDocumentFreeGroups} = await import('@/src/providers/translation/documentFreeBatch');
        const original = sources(4), packet = serializeTranslationSlots(original);
        const nonce = packet.starts[0]!.slice('___FLUENTREAD_'.length, -'_0_BEGIN___'.length);
        const translate = vi.fn(async () => serializeTranslationSlots(valid(original.slice(0, 2)), nonce).payload);
        await expect(translateDocumentFreeGroups(original, [{indexes: [0, 1, 2, 3], sources: original}], 1, undefined, translate))
            .rejects.toThrow('文档槽位不完整');
        expect(translate).toHaveBeenCalledOnce();
    });

    it('late native validation failures after cancellation cannot change the group fallback strategy', async () => {
        const {runDocumentFreeNativeCandidate} = await import('@/src/providers/translation/documentFreeBatch');
        const controller = new AbortController(), scalarProviders = new Set<string>();
        let reject!: (error: Error) => void;
        const result = runDocumentFreeNativeCandidate('microsoft', controller.signal, scalarProviders,
            () => new Promise<string>((_resolve, rej) => {reject = rej;}));
        const error = Object.assign(new Error('Late invalid group'), {freeFailure: 'request'});
        const assertion = expect(result).rejects.toBe(error);
        controller.abort();
        reject(error);
        await assertion;
        expect(scalarProviders.size).toBe(0);
    });

    it('a scalar response colliding with this group namespace is rejected before any slot is consumed', async () => {
        const {serializeDocumentFreeFirstSlot} = await import('@/src/providers/translation/documentFreeBatch');
        const original = sources(2), packet = serializeTranslationSlots(original);
        expect(() => serializeDocumentFreeFirstSlot(original, `译文包含 ${packet.starts[0]}`))
            .toThrow('首段槽位异常');
        expect(original).toEqual(sources(2));
    });

    it('the group owner receiving an already cancelled caller starts no translation port', async () => {
        const {translateDocumentFreeGroups} = await import('@/src/providers/translation/documentFreeBatch');
        const original = sources(2), controller = new AbortController(), reason = new Error('Owner cancelled before dispatch');
        controller.abort(reason);
        const translate = vi.fn();
        await expect(translateDocumentFreeGroups(original, [{indexes: [0, 1], sources: original}], 1, controller.signal, translate))
            .rejects.toBe(reason);
        expect(translate).not.toHaveBeenCalled();
    });

    it('the owner rejects a late success from a port ignoring cancellation and never claims another group', async () => {
        const {translateDocumentFreeGroups} = await import('@/src/providers/translation/documentFreeBatch');
        const original = sources(4), controller = new AbortController(), reason = new Error('Owner cancelled while pending');
        Object.freeze(original);
        let resolve!: (translated: string) => void;
        const translate = vi.fn(() => new Promise<string>(res => {resolve = res;}));
        const first = original.slice(0, 2), second = original.slice(2), packet = serializeTranslationSlots(first);
        const nonce = packet.starts[0]!.slice('___FLUENTREAD_'.length, -'_0_BEGIN___'.length);
        const result = translateDocumentFreeGroups(original, [{indexes: [0, 1], sources: first}, {indexes: [2, 3], sources: second}],
            1, controller.signal, translate);
        const assertion = expect(result).rejects.toBe(reason);
        expect(translate).toHaveBeenCalledOnce();
        controller.abort(reason);
        resolve(serializeTranslationSlots(valid(first), nonce).payload);
        await assertion;
        expect(translate).toHaveBeenCalledOnce();
        expect(original).toEqual(sources(4));
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['microsoft', 'google'] as const)('a %s-only document pool recovers a malformed array through paced scalar attempts within the same budget', async provider => {
        mockConfig.freeTranslationOrder = [provider];
        const originals = sources(2), expected = valid(originals);
        Object.freeze(originals);
        const starts: number[] = [];
        if (provider === 'microsoft') {
            microsoftMock.mockImplementation(async (texts: string[]) => {
                starts.push(Date.now());
                return valid(texts.length > 1 ? texts.slice(0, 1) : texts);
            });
        } else {
            googleOwnerMock.mockImplementation(async (texts: string[]) => {
                starts.push(Date.now());
                return valid(texts.slice(0, 1));
            });
            googleMock.mockImplementation(async (text: string) => {starts.push(Date.now()); return `译:${text}`;});
        }
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observed: Array<{route: string; chars: number}> = [];
        await expect(settle(freeTranslation(withProviderSnapshot(attachTranslationRouteObserver({origin: originals, documentBatch: true}, event => observed.push(event)), mockConfig))))
            .resolves.toEqual(expected);
        if (provider === 'microsoft') expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals, [originals[0]], [originals[1]]]);
        else {
            expect(googleOwnerMock).toHaveBeenCalledOnce();
            expect(googleMock.mock.calls.map(call => call[0])).toEqual(originals);
            expect(googleMock.mock.calls.every(call => call[4] === false)).toBe(true);
        }
        expect(starts.map(time => time - starts[0]!)).toEqual(provider === 'microsoft' ? [0, 100, 200] : [0, 300, 600]);
        expect(observed.map(event => event.chars)).toEqual([originals.join('').length, ...originals.map(source => source.length)]);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === provider)?.status).toBe('ready');
        expect(originals).toEqual(sources(2));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('scalar recovery that also returns invalid content stops after its one bounded retry', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const originals = sources(2);
        microsoftMock.mockImplementation(async (texts: string[]) => texts.length > 1 ? valid(texts.slice(0, 1)) : ['']);
        await expect(settle(freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true}, mockConfig)))).rejects.toThrow('免费翻译服务均不可用');
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals, [originals[0]]]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('native-to-scalar recovery uses the original deadline and cannot start the next source beyond it', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const originals = sources(2);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts.length > 1 ? texts.slice(0, 1) : texts));
        const request = freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true, requestTimeoutMs: 150}, mockConfig));
        const assertion = expect(request).rejects.toThrow('超时');
        await vi.advanceTimersByTimeAsync(200);
        await assertion;
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals, [originals[0]]]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['resolve', 'reject'] as const)('abort during the native-only scalar recovery ignores late %s and starts no later slot', async late => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        let resolve!: (value: string[]) => void;
        let reject!: (error: Error) => void;
        microsoftMock.mockImplementation((texts: string[]) => texts.length > 1 ? Promise.resolve(valid(texts.slice(0, 1)))
            : new Promise<string[]>((res, rej) => {resolve = res; reject = rej;}));
        const controller = new AbortController(), reason = new Error('Cancel scalar recovery');
        const originals = sources(2);
        const request = freeTranslation(withProviderSnapshot({origin: originals, documentBatch: true, abortSignal: controller.signal}, mockConfig));
        const assertion = expect(request).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(100);
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([originals, [originals[0]]]);
        controller.abort(reason);
        await assertion;
        if (late === 'resolve') resolve(['迟到译文']); else reject(new Error('Late recovery rejection'));
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('HTTP failure without a new native validation marker is not retried as scalar recovery', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        microsoftMock.mockRejectedValue(httpFailure(503));
        await expect(settle(freeTranslation(withProviderSnapshot({origin: sources(2), documentBatch: true}, mockConfig)))).rejects.toThrow('HTTP 503');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an attempt timeout without a new validation marker does not recover, even when an invalid array arrives late', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        let resolve!: (value: string[]) => void;
        microsoftMock.mockReturnValue(new Promise<string[]>(res => {resolve = res;}));
        const request = freeTranslation(withProviderSnapshot({origin: sources(2), documentBatch: true}, mockConfig));
        const assertion = expect(request).rejects.toThrow('超时');
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;
        resolve(['迟到的缺槽译文']);
        await flush();
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});


describe('中文目标下明确 Latin 错语种结果', () => {
    const polishSource = 'Osobne działko laserowe o ogromnej mocy: zabija jednym strzałem, strzela co 1,5 s, zasięg 34, niebieski promień, bardzo duży pobór prądu.';
    const corruptPolishResult = 'Osobne dzia😍ko laserowe o ogromnej mocy：zabija jednym strza😍em，strzela co 1,5 s，zasig 34，niebieski promie😍，bardzo du😍y pobór pr😍du。';
    beforeEach(() => { mockConfig.freeTranslationOrder = ['microsoft', 'google']; });
    const chinese = '独立的高功率激光炮，每隔一点五秒发射一次，射程三十四，蓝色光束，耗电量非常大。';
    it('actual scalar free pool rejects the corrupt result, uses the configured fallback and leaves the route ready', async () => {
        const { attachTranslationRouteObserver } = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{
            route: string;
            outcome: string;
            chars: number;
        }> = [];
        microsoftMock.mockResolvedValueOnce([corruptPolishResult]).mockResolvedValue([chinese]);
        googleMock.mockResolvedValue(chinese);
        const request = attachTranslationRouteObserver({ origin: polishSource, targetLanguage: 'zh-Hans' }, event => observations.push(event));
        await expect(settle(freeTranslation(withProviderSnapshot(request, mockConfig)))).resolves.toBe(chinese);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect(observations.map(({ route, outcome, chars }) => ({ route, outcome, chars }))).toEqual([
            { route: 'microsoft', outcome: 'error', chars: polishSource.length },
            { route: 'google', outcome: 'success', chars: polishSource.length },
        ]);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
        await expect(settle(freeTranslation(withProviderSnapshot({ origin: polishSource + ' Another paragraph.' }, mockConfig)))).resolves.toBe(chinese);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(googleMock).toHaveBeenCalledOnce();
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'google']);
    });
    it('one corrupt native slot rejects the entire candidate and preserves original indexes/empty slots under fallback', async () => {
        const sources = Array.from({ length: 8 }, (_, index) => index === 6 ? polishSource
            : `The software translates every complete paragraph and retains all reader settings after restart ${index}.`);
        const original = [...sources, ''];
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map((_, index) => index === 6 ? corruptPolishResult : `首选中文译文${index}`));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map((_, index) => `后备中文译文${index}`));
        await expect(settle(freeTranslation(withProviderSnapshot({ origin: original }, mockConfig)))).resolves.toEqual([...sources.map((_, index) => `后备中文译文${index}`), '']);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock).toHaveBeenCalledOnce();
        expect(microsoftMock.mock.calls[0][0]).toEqual(sources);
        expect(googleOwnerMock.mock.calls[0][0]).toEqual(sources);
        expect(googleMock).not.toHaveBeenCalled();
        expect(original).toEqual([...sources, '']);
        expect((await getFreeTranslationWeightSnapshot(createTranslationProviderConfigSnapshot(providerConfigFixture(mockConfig)))).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });
    it('single-provider check rejects wrong language and never silently changes provider', async () => {
        microsoftMock.mockResolvedValue([corruptPolishResult]);
        googleMock.mockResolvedValue(chinese);
        await expect(translateFreeTranslationProvider('microsoft', withProviderSnapshot({ origin: polishSource, targetLanguage: 'zh-Hans' }, mockConfig)))
            .rejects.toMatchObject({ freeFailure: 'request', message: '返回的译文语言与目标语言不符' });
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(officialMock).not.toHaveBeenCalled();
    });
    it('all invalid providers stay failed with one attempt per configured candidate', async () => {
        microsoftMock.mockResolvedValue([corruptPolishResult]);
        googleMock.mockResolvedValue(corruptPolishResult);
        await expect(settle(freeTranslation(withProviderSnapshot({ origin: polishSource }, mockConfig)))).rejects.toThrow('语言与目标语言不符');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
    });
    it('fallback consumes the existing shared deadline rather than restarting the request budget', async () => {
        const started = Date.now();
        let release!: () => void;
        microsoftMock.mockImplementation(() => new Promise(resolve => { release = () => resolve([corruptPolishResult]); }));
        let googleSignal: AbortSignal | undefined;
        googleMock.mockImplementation((_text, _from, _to, signal: AbortSignal) => {
            googleSignal = signal;
            return new Promise(() => { });
        });
        const request = freeTranslation(withProviderSnapshot({ origin: polishSource, requestTimeoutMs: 50 }, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(30);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(googleMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(20);
        const error = await request;
        expect(error).toBeInstanceOf(Error);
        expect(Date.now() - started).toBe(50);
        expect(googleSignal?.aborted).toBe(true);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
    });
    it('cancelled noncooperative transport retains exact reasons and original per-provider capacity until settlement', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const release: Array<() => void> = [];
        microsoftMock.mockImplementation((texts: string[], _from, _to, _signal, _batch, lease: FreeFallbackLease) => {
            if (texts[0] === 'The software translates this recovery paragraph and keeps all user settings available after restart.')
                return Promise.resolve([chinese]);
            const raw = new Promise<void>(resolve => { release.push(resolve); });
            lease.holdUntil(raw);
            return raw.then(() => [corruptPolishResult]);
        });
        const first = new AbortController(), second = new AbortController();
        const reason1 = new Error('first owner cancelled'), reason2 = new Error('second owner cancelled');
        const one = freeTranslation(withProviderSnapshot({ origin: polishSource, abortSignal: first.signal }, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(100);
        const two = freeTranslation(withProviderSnapshot({ origin: polishSource, abortSignal: second.signal }, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        first.abort(reason1);
        second.abort(reason2);
        expect(await one).toBe(reason1);
        expect(await two).toBe(reason2);
        const recovery = freeTranslation(withProviderSnapshot({ origin: 'The software translates this recovery paragraph and keeps all user settings available after restart.' }, mockConfig));
        await vi.advanceTimersByTimeAsync(100);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        release[0]();
        await vi.advanceTimersByTimeAsync(0);
        await expect(settle(recovery)).resolves.toBe(chinese);
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        release[1]();
        await vi.advanceTimersByTimeAsync(0);
        expect(googleMock).not.toHaveBeenCalled();
    });
});
