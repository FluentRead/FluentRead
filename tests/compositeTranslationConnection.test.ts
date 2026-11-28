import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {google, microsoft, openai} = vi.hoisted(() => ({google: vi.fn(), microsoft: vi.fn(), openai: vi.fn()}));
vi.mock('@/src/providers/translation/registry', () => ({translationProviderRegistry: {google, microsoft, openai}}));
vi.mock('@/src/providers/translation/free-translation', () => ({translateFreeTranslationProvider: vi.fn()}));

import {Config} from '@/src/core/config/model';
import {CONNECTION_TEST_ORIGIN, runTranslationServiceConnectionTest} from '@/src/providers/translation/connectionTest';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {
    createTranslationProviderConfigSnapshot, getTranslationProviderConfig, getTranslationRequestScheduler,
    reportTranslationModelUsage,
} from '@/src/services/translation/requestSnapshot';

let group = 'composite:connection';
let groupSequence = 0;
function source(services = ['google', 'microsoft']) {
    return Object.assign(new Config(), {service: group,
        compositeTranslationProviders: [{id: group, name: '组合连接检查', strategy: 'sequential' as const,
            services, timeoutMs: 1_000}],
        model: {openai: 'gpt-4.1-mini'}, customModel: {}, token: {openai: 'fixture-connection-openai'},
    });
}

beforeEach(() => {
    // 真实连接模块拥有会话级 router；各测试独立 profile，避免继承前一测试的轮次。
    group = `composite:connection-${++groupSequence}`;
    vi.clearAllMocks();
    google.mockReset().mockResolvedValue('你好，FluentRead。');
    microsoft.mockReset().mockResolvedValue('你好，FluentRead。');
    openai.mockReset().mockResolvedValue('你好，FluentRead。');
});
afterEach(() => vi.useRealTimers());

describe('组合翻译连接检查', () => {
    it('连续连接检查轮流首选成员，成功不会固定后续检查的首选服务', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source(['google', 'microsoft', 'openai']));
        const attempted: string[] = [];
        for (const [service, adapter] of [['google', google], ['microsoft', microsoft], ['openai', openai]] as const) {
            adapter.mockImplementation(async () => {attempted.push(service); return '你好，FluentRead。';});
        }
        for (let index = 0; index < 4; index += 1) {
            await expect(runTranslationServiceConnectionTest(group, {config: snapshot})).resolves.toEqual({durationMs: expect.any(Number)});
        }
        expect(attempted).toEqual(['google', 'microsoft', 'openai', 'google']);
    });

    it('首成员检查失败后当前轮次回退，下一轮仍从轮到的第二成员开始', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source(['google', 'microsoft', 'openai']));
        const attempted: string[] = [];
        let googleCalls = 0, microsoftCalls = 0, openaiCalls = 0;
        google.mockImplementation(async () => {
            attempted.push('google');
            if (++googleCalls === 1) throw new Error('first unavailable');
            return '你好，FluentRead。';
        });
        microsoft.mockImplementation(async () => {
            attempted.push('microsoft');
            if (++microsoftCalls === 2) throw new Error('second unavailable');
            return '你好，FluentRead。';
        });
        openai.mockImplementation(async () => {
            attempted.push('openai');
            if (++openaiCalls === 1) throw new Error('third unavailable');
            return '你好，FluentRead。';
        });
        for (let index = 0; index < 3; index += 1) {
            await expect(runTranslationServiceConnectionTest(group, {config: snapshot})).resolves.toBeTruthy();
        }
        expect(attempted).toEqual(['google', 'microsoft', 'microsoft', 'openai', 'google', 'openai']);
    });

    it('并发连接检查在响应前分配不同首选成员', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source(['google', 'microsoft', 'openai']));
        const attempted: string[] = [];
        const complete: Array<() => void> = [];
        for (const [service, adapter] of [['google', google], ['microsoft', microsoft], ['openai', openai]] as const) {
            adapter.mockImplementation(async () => {
                attempted.push(service);
                return new Promise(resolve => complete.push(() => resolve('你好，FluentRead。')));
            });
        }
        const pending = Array.from({length: 3}, () => runTranslationServiceConnectionTest(group, {config: snapshot}));
        void Promise.all(pending).catch(() => undefined);
        await vi.waitFor(() => expect(attempted).toEqual(['google', 'microsoft', 'openai']));
        complete.forEach(resolve => resolve());
        await expect(Promise.all(pending)).resolves.toHaveLength(3);
    });

    it('从真实 registry 按顺序检查成员，复用冻结配置与实际服务限流身份', async () => {
        const current = source(['google', 'openai']);
        const snapshot = createTranslationProviderConfigSnapshot(current);
        const scheduler = createTranslationRequestScheduler(() => current);
        google.mockImplementation(async () => {
            current.token.openai = 'changed-token'; current.model.openai = 'changed-model';
            throw new Error('first failed');
        });
        openai.mockImplementation(async message => {
            expect(message).toMatchObject({origin: CONNECTION_TEST_ORIGIN, serviceOverride: 'openai', useCache: false});
            expect(getTranslationProviderConfig(message, snapshot).token.openai).toBe('fixture-connection-openai');
            expect(getTranslationRequestScheduler(message)?.identity).toEqual({service: 'openai', model: 'gpt-4.1-mini'});
            reportTranslationModelUsage(message, {usageAvailability: 'reported', totalTokens: 2});
            return '你好，FluentRead。';
        });
        const recordModelUsage = vi.fn(async () => undefined);
        await expect(runTranslationServiceConnectionTest(group, {config: snapshot, configuredModel: 'group-model',
            effectiveModel: 'group-model', requestScheduler: scheduler, recordModelUsage})).resolves.toEqual({durationMs: expect.any(Number)});
        expect(google).toHaveBeenCalledOnce();
        expect(openai).toHaveBeenCalledOnce();
        expect(recordModelUsage).toHaveBeenCalledWith([expect.objectContaining({serviceId: 'openai',
            configuredModel: 'gpt-4.1-mini', purpose: 'connection-test', outcome: 'success'})]);
    });

    it('超时中止第一成员后回退检查下一成员', async () => {
        vi.useFakeTimers();
        const snapshot = createTranslationProviderConfigSnapshot(source());
        let firstSignal!: AbortSignal;
        google.mockImplementation(async message => {
            firstSignal = message.abortSignal;
            return new Promise((_resolve, reject) => firstSignal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
        });
        const pending = runTranslationServiceConnectionTest(group, {config: snapshot});
        await vi.advanceTimersByTimeAsync(1_001);
        await expect(pending).resolves.toEqual({durationMs: expect.any(Number)});
        expect(firstSignal.aborted).toBe(true);
        expect(microsoft).toHaveBeenCalledOnce();
    });

    it('兼容 configSnapshot 入口，非法剩余时间使用默认连接预算', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source(['google']));
        await expect(runTranslationServiceConnectionTest(group, {configSnapshot: snapshot, requestTimeoutMs: Number.NaN}))
            .resolves.toEqual({durationMs: expect.any(Number)});
        expect(google.mock.calls[0][0].requestTimeoutMs).toBe(1_000);
    });

    it('组合成员可使用设置的 45 秒预算，普通服务缺省仍是 30 秒', async () => {
        vi.useFakeTimers();
        const current = source(['google']);
        current.compositeTranslationProviders[0].timeoutMs = 45_000;
        const snapshot = createTranslationProviderConfigSnapshot(current);
        google.mockImplementation(async message => {
            expect(message.requestTimeoutMs).toBe(45_000);
            return new Promise(resolve => setTimeout(() => resolve('你好，FluentRead。'), 35_000));
        });
        const pending = runTranslationServiceConnectionTest(group, {config: snapshot});
        await vi.advanceTimersByTimeAsync(35_001);
        await expect(pending).resolves.toEqual({durationMs: 35_000});
        google.mockResolvedValueOnce('你好，FluentRead。');
        await expect(runTranslationServiceConnectionTest('google', {config: snapshot})).resolves.toBeTruthy();
        expect(google.mock.calls[1][0].requestTimeoutMs).toBe(30_000);
    });

    it('组合总剩余预算耗尽后不会继续检查新成员', async () => {
        vi.useFakeTimers();
        const snapshot = createTranslationProviderConfigSnapshot(source());
        google.mockImplementation(async message => new Promise((_resolve, reject) =>
            message.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})));
        const settled = runTranslationServiceConnectionTest(group, {config: snapshot, requestTimeoutMs: 40}).catch(error => error);
        await vi.advanceTimersByTimeAsync(41);
        await expect(settled).resolves.toMatchObject({message: '翻译请求超时'});
        expect(microsoft).not.toHaveBeenCalled();
    });

    it('外部取消会中止在途成员并禁止回退', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source());
        const controller = new AbortController();
        let memberSignal!: AbortSignal;
        google.mockImplementation(async message => {
            memberSignal = message.abortSignal;
            return new Promise((_resolve, reject) => memberSignal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
        });
        const settled = runTranslationServiceConnectionTest(group, {config: snapshot, signal: controller.signal}).catch(error => error);
        await vi.waitFor(() => expect(google).toHaveBeenCalledOnce());
        controller.abort();
        await expect(settled).resolves.toMatchObject({name: 'AbortError'});
        expect(memberSignal.aborted).toBe(true);
        expect(microsoft).not.toHaveBeenCalled();
        await expect(runTranslationServiceConnectionTest(group, {config: snapshot, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    });

    it('计算组合预算期间出现取消时，不启动第一个成员', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source());
        const controller = new AbortController();
        await expect(runTranslationServiceConnectionTest(group, {config: snapshot, signal: controller.signal,
            now: () => {controller.abort(); return 0;}})).rejects.toMatchObject({name: 'AbortError'});
        expect(google).not.toHaveBeenCalled();
    });

    it('成员响应后用量持久化期间取消，组合仍返回取消并禁止回退', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source(['openai', 'microsoft']));
        const controller = new AbortController();
        openai.mockImplementation(async message => {
            reportTranslationModelUsage(message, {usageAvailability: 'reported', totalTokens: 2});
            return '你好，FluentRead。';
        });
        await expect(runTranslationServiceConnectionTest(group, {config: snapshot, signal: controller.signal,
            recordModelUsage: async () => {controller.abort();}})).rejects.toMatchObject({name: 'AbortError'});
        expect(openai).toHaveBeenCalledOnce();
        expect(microsoft).not.toHaveBeenCalled();
    });

    it('组合检查拒绝指定 Key、免费线路、缺失配置和空组合', async () => {
        const config = createTranslationProviderConfigSnapshot(source());
        await expect(runTranslationServiceConnectionTest(group, {config, keyIndex: 0})).rejects.toThrow('不支持指定 Key');
        await expect(runTranslationServiceConnectionTest(group, {config, keyRevision: 'revision'})).rejects.toThrow('不支持指定 Key');
        await expect(runTranslationServiceConnectionTest(group, {config, freeProviderId: 'googleFree'})).rejects.toThrow('不支持指定 Key');
        await expect(runTranslationServiceConnectionTest(group)).rejects.toThrow('缺少配置快照');
        await expect(runTranslationServiceConnectionTest('composite:missing', {config})).rejects.toThrow('已被删除');
        await expect(runTranslationServiceConnectionTest(group, {config: createTranslationProviderConfigSnapshot(source([]))})).rejects.toThrow('尚未添加');
        expect(google).not.toHaveBeenCalled();
    });

    it('所有成员失败时返回最后一个具体错误', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source());
        google.mockRejectedValueOnce(new Error('first failed'));
        const final = new Error('last failed');
        microsoft.mockRejectedValueOnce(final);
        await expect(runTranslationServiceConnectionTest(group, {config: snapshot})).rejects.toBe(final);
    });

    it('受信旧快照中的自引用成员被跳过，不递归调用组合', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(source());
        const nested = {...snapshot, compositeTranslationProviders: [{...snapshot.compositeTranslationProviders![0], services: [group]}]};
        await expect(runTranslationServiceConnectionTest(group, {config: nested})).rejects.toThrow('没有可用的成员');
        expect(google).not.toHaveBeenCalled();
    });

    it('组合检查跳过全局关闭的成员服务，全部关闭时明确报错', async () => {
        const partial = createTranslationProviderConfigSnapshot({...source(), disabledTranslationServices: ['google']});
        await expect(runTranslationServiceConnectionTest(group, {config: partial})).resolves.toEqual({durationMs: expect.any(Number)});
        expect(google).not.toHaveBeenCalled();
        expect(microsoft).toHaveBeenCalledOnce();

        const allDisabled = createTranslationProviderConfigSnapshot({...source(), disabledTranslationServices: ['google', 'microsoft']});
        await expect(runTranslationServiceConnectionTest(group, {config: allDisabled})).rejects.toThrow('所有成员都已关闭');
    });
});
