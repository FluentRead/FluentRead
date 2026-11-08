import {afterEach, describe, expect, it, vi} from 'vitest';

const {adapter, freeAdapter} = vi.hoisted(() => ({
    adapter: vi.fn(),
    freeAdapter: vi.fn(),
}));
vi.mock('@/src/providers/translation/free-translation', () => ({translateFreeTranslationProvider: freeAdapter}));

vi.mock('@/src/providers/translation/registry', () => ({
    translationProviderRegistry: {
        custom: adapter,
        demo: adapter,
    },
}));

import {
    CONNECTION_TEST_ORIGIN,
    CONNECTION_TEST_TIMEOUT_MS,
    formatConnectionTestError,
    runTranslationServiceConnectionTest,
} from '@/src/providers/translation/connectionTest';
import {formatServiceError, getServiceErrorMessage} from '@/src/services/translation/serviceErrors';
import {services} from '@/src/core/config/catalog';
import {getTranslationRequestScheduler, reportTranslationModelUsage} from '@/src/services/translation/requestSnapshot';
import {TRANSLATION_PROVIDER_CONFIG} from '@/src/services/translation/types';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {createTranslationProviderConfigSnapshot, getTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {createApiKeyCheckRevision} from '@/src/core/config/apiKeyCheckIdentity';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, reject, resolve};
}

describe('翻译服务连接测试', () => {
    it.each(['transmart', 'apertiumFree'])('免费池 %s 直接调用匿名适配器，使用支持的固定语言对', async freeProviderId => {
        freeAdapter.mockResolvedValue('有效译文');
        const source = Object.assign(new Config(), {from: 'auto', to: 'en'});
        await expect(runTranslationServiceConnectionTest('freeTranslation', {
            freeProviderId, configSnapshot: createTranslationProviderConfigSnapshot(source),
        })).resolves.toEqual({durationMs: expect.any(Number)});
        expect(freeAdapter).toHaveBeenLastCalledWith(freeProviderId, expect.objectContaining({
            origin: CONNECTION_TEST_ORIGIN, sourceLanguage: 'en',
            targetLanguage: freeProviderId === 'apertiumFree' ? 'es' : 'zh-Hans',
            requestTimeoutMs: source.freeTranslationTimeoutMs, useCache: false,
        }));
        expect(source.to).toBe('en');
    });

    it('免费池单服务失败不被其他适配器成功掩盖，超时取消对应请求', async () => {
        vi.useFakeTimers();
        const source = Object.assign(new Config(), {freeTranslationTimeoutMs: 1000});
        freeAdapter.mockImplementationOnce(() => new Promise(() => undefined));
        const pending = runTranslationServiceConnectionTest('freeTranslation', {
            freeProviderId: 'alibabaFree', config: createTranslationProviderConfigSnapshot(source),
        });
        const outcome = expect(pending).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(1000);
        await outcome;
        expect(freeAdapter.mock.calls.at(-1)![1].abortSignal.aborted).toBe(true);
        freeAdapter.mockRejectedValueOnce(new Error('服务限流'));
        await expect(runTranslationServiceConnectionTest('freeTranslation', {freeProviderId: 'alibabaFree'})).rejects.toThrow('服务限流');
        freeAdapter.mockResolvedValueOnce(CONNECTION_TEST_ORIGIN);
        await expect(runTranslationServiceConnectionTest('freeTranslation', {freeProviderId: 'alibabaFree'})).rejects.toThrow('未翻译测试文本');
        await expect(runTranslationServiceConnectionTest('google', {freeProviderId: 'alibabaFree'})).rejects.toThrow('无效的免费翻译服务');
        await expect(runTranslationServiceConnectionTest('freeTranslation', {freeProviderId: 'unknown'})).rejects.toThrow('无效的免费翻译服务');
    });
    it('指定 Key 的逐项检查仍共享请求调度，不会绕过频率限制', async () => {
        vi.useFakeTimers();
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 6, translationRequestsPerSecond: 1, translationRequestsPerMinute: 0,
        }));
        const source = new Config();
        source.apiKeys.demo = ['scheduled-first', 'scheduled-second'];
        source.token.demo = 'scheduled-first';
        const snapshot = createTranslationProviderConfigSnapshot(source);
        const used: string[] = [];
        adapter.mockImplementation(async message => {
            used.push(getTranslationProviderConfig(message, snapshot).token.demo);
            expect(getTranslationRequestScheduler(message)?.identity?.service).toBe('demo');
            return '你好';
        });
        await runTranslationServiceConnectionTest('demo', {config: snapshot, keyIndex: 0, requestScheduler: scheduler});
        const second = runTranslationServiceConnectionTest('demo', {config: snapshot, keyIndex: 1, requestScheduler: scheduler});
        await vi.advanceTimersByTimeAsync(999);
        expect(used).toEqual(['scheduled-first']);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(used).toEqual(['scheduled-first', 'scheduled-second']);
    });
    it('逐项检查使用冻结凭据、不用其他 Key 掩盖失败，支持空行后的原始索引', async () => {
        const source = new Config();
        source.apiKeys.demo = ['fixture-connection-bad', '', 'fixture-connection-good'];
        source.token.demo = 'fixture-connection-bad';
        const snapshot = createTranslationProviderConfigSnapshot(source);
        const used: string[] = [];
        adapter.mockImplementation(async message => {
            const key = getTranslationProviderConfig(message, snapshot).token.demo;
            used.push(key);
            if (key === 'fixture-connection-bad') throw Object.assign(new Error(`HTTP 401 ${key}`), {statusCode: 401});
            return '你好';
        });
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: snapshot, keyIndex: 0}))
            .rejects.toThrow('已隐藏的密钥');
        expect(used).toEqual(['fixture-connection-bad']);
        source.apiKeys.demo[2] = 'changed-after-snapshot';
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: snapshot, keyIndex: 2})).resolves.toBeTruthy();
        expect(used).toEqual(['fixture-connection-bad', 'fixture-connection-good']);
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: snapshot, keyIndex: 1})).rejects.toThrow('为空');
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: snapshot, keyIndex: -1})).rejects.toThrow('序号无效');
        await expect(runTranslationServiceConnectionTest('demo', {keyIndex: 0})).rejects.toThrow('缺少配置快照');
    });

    it('配置指纹过期时在 provider 调用前拒绝检测', async () => {
        const source = new Config();
        source.apiKeys.demo = ['fixture-check-key'];
        const snapshot = createTranslationProviderConfigSnapshot(source);
        adapter.mockResolvedValue('不应发出');
        const revision = createApiKeyCheckRevision(snapshot, 'demo');
        await expect(runTranslationServiceConnectionTest('demo', {
            configSnapshot: snapshot,
            keyIndex: 0,
            keyRevision: revision.replace(/^./u, revision[0] === 'a' ? 'b' : 'a'),
        })).rejects.toThrow('服务配置已更改，请重新检查');
        expect(adapter).not.toHaveBeenCalled();
    });

    it('无 Key 配置也冻结端点，旧未指定索引检查只验证第一个非空 Key', async () => {
        const source = new Config();
        source.apiKeys.demo = ['', 'fixture-single-check'];
        const snapshot = createTranslationProviderConfigSnapshot(source);
        adapter.mockImplementation(async message => {
            expect(getTranslationProviderConfig(message, source).token.demo).toBe('fixture-single-check');
            return '你好';
        });
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: snapshot})).resolves.toBeTruthy();
        adapter.mockImplementation(async message => {
            expect(Object.isFrozen(getTranslationProviderConfig(message, source))).toBe(true);
            expect(getTranslationProviderConfig(message, source).token.demo).toBe('');
            return '你好';
        });
        await expect(runTranslationServiceConnectionTest('demo', {configSnapshot: createTranslationProviderConfigSnapshot(new Config())})).resolves.toBeTruthy();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        adapter.mockReset();
        freeAdapter.mockReset();
    });

    it('调用真实适配器并禁用翻译缓存', async () => {
        adapter.mockResolvedValue('测试译文');

        await expect(runTranslationServiceConnectionTest('demo')).resolves.toEqual(expect.objectContaining({
            durationMs: expect.any(Number),
        }));
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            origin: CONNECTION_TEST_ORIGIN,
            serviceOverride: 'demo',
            useCache: false,
            abortSignal: expect.any(AbortSignal),
        }));
        expect(adapter.mock.calls[0][0]).not.toHaveProperty('sourceLanguage');
        expect(adapter.mock.calls[0][0]).not.toHaveProperty('targetLanguage');
    });

    it('无 config 时不注入不完整的 provider snapshot，保持 adapter 原有 fallback', async () => {
        adapter.mockImplementation(async (message: object) => {
            expect(Object.prototype.hasOwnProperty.call(message, TRANSLATION_PROVIDER_CONFIG)).toBe(false);
            return '测试译文';
        });

        await expect(runTranslationServiceConnectionTest('demo')).resolves.toEqual(expect.objectContaining({
            durationMs: expect.any(Number),
        }));
    });

    it('提供 config 时绑定调用方 snapshot，供 adapter 读取真实配置', async () => {
        const config = createTranslationProviderConfigSnapshot(normalizeConfig({
            service: 'demo',
            model: {demo: 'configured-demo-model'},
        }));
        adapter.mockImplementation(async (message: object) => {
            expect(Object.prototype.hasOwnProperty.call(message, TRANSLATION_PROVIDER_CONFIG)).toBe(true);
            return '测试译文';
        });

        await expect(runTranslationServiceConnectionTest('demo', {config})).resolves.toEqual(expect.objectContaining({
            durationMs: expect.any(Number),
        }));
    });

    it('排队期间不调用 adapter，超时取消后也不会迟到发出真实请求', async () => {
        vi.useFakeTimers();
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const blocker = deferred<string>();
        adapter.mockImplementationOnce((message: object) => {
            expect(getTranslationRequestScheduler(message)?.identity?.model).toBe('effective-demo');
            return blocker.promise;
        }).mockResolvedValueOnce('不应发出的译文');

        const first = runTranslationServiceConnectionTest('demo', {requestScheduler: scheduler, effectiveModel: ' effective-demo '});
        const firstOutcome = first.catch(error => error);
        await Promise.resolve();
        expect(adapter).toHaveBeenCalledOnce();

        const second = runTranslationServiceConnectionTest('demo', {requestScheduler: scheduler});
        const secondOutcome = second.catch(error => error);
        await Promise.resolve();
        expect(adapter).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(CONNECTION_TEST_TIMEOUT_MS);
        await expect(secondOutcome).resolves.toMatchObject({message: '翻译请求超时'});
        await expect(firstOutcome).resolves.toMatchObject({message: '翻译请求超时'});
        blocker.resolve('第一个译文');
        await Promise.resolve();
        expect(adapter).toHaveBeenCalledOnce();
    });

    it.each(['resolve', 'reject'] as const)('连接测试超时后等待真实传输 %s，再启动共享调度的翻译和下一次检查', async settlement => {
        vi.useFakeTimers();
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const identity = {service: 'demo', model: 'qwen3:8b'};
        const physicalTransport = deferred<string>();
        const started: string[] = [];
        adapter.mockImplementationOnce((message: {abortSignal?: AbortSignal}) => {
            const context = getTranslationRequestScheduler(message)!;
            return context.scheduler.scheduleAttempt(() => {
                started.push('first-check');
                context.lease?.holdUntil(physicalTransport.promise);
                return physicalTransport.promise;
            }, {signal: message.abortSignal, identity: context.identity});
        }).mockImplementationOnce(async () => {
            started.push('next-check');
            return '下一次检查译文';
        });
        const options = {requestScheduler: scheduler, effectiveModel: identity.model, countRate: false};
        const first = runTranslationServiceConnectionTest('demo', options).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toEqual(['first-check']);
        await vi.advanceTimersByTimeAsync(CONNECTION_TEST_TIMEOUT_MS);
        await expect(first).resolves.toMatchObject({message: '翻译请求超时'});

        const translation = scheduler.schedule(async () => {
            started.push('translation');
            return '共享调度译文';
        }, {identity, countRate: false});
        const nextCheck = runTranslationServiceConnectionTest('demo', options);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(started).toEqual(['first-check']);
        } finally {
            if (settlement === 'resolve') physicalTransport.resolve('迟到译文');
            else physicalTransport.reject(new TypeError('Cancelled physical transport finished'));
            await vi.advanceTimersByTimeAsync(0);
            await expect(translation).resolves.toBe('共享调度译文');
            await expect(nextCheck).resolves.toEqual({durationMs: expect.any(Number)});
        }
        expect(started).toEqual(['first-check', 'translation', 'next-check']);
    });

    it('动态 custom:* 服务回退到共享 custom adapter，同时保留动态 serviceOverride', async () => {
        adapter.mockResolvedValue('动态服务译文');

        await expect(runTranslationServiceConnectionTest('custom:1')).resolves.toEqual({
            durationMs: expect.any(Number),
        });
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            serviceOverride: 'custom:1',
            origin: CONNECTION_TEST_ORIGIN,
        }));
    });

    it('拒绝空响应，避免把仅 HTTP 成功误报为连接正常', async () => {
        adapter.mockResolvedValue('   ');

        await expect(runTranslationServiceConnectionTest('demo')).rejects.toThrow('没有返回有效译文');
    });

    it('拒绝非字符串响应与未知适配器', async () => {
        adapter.mockResolvedValue(['unexpected batch']);

        await expect(runTranslationServiceConnectionTest('demo')).rejects.toThrow('没有返回有效译文');
        await expect(runTranslationServiceConnectionTest('missing')).rejects.toThrow('未找到翻译服务适配器: missing');
    });

    it('系统时钟回拨时将耗时钳制为零', async () => {
        adapter.mockResolvedValue('测试译文');
        vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(90);

        await expect(runTranslationServiceConnectionTest('demo')).resolves.toEqual({durationMs: 0});
    });

    it('30 秒后中止 legacy adapter signal，统一返回超时且忽略迟到结果', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        let resolveLate!: (value: string) => void;
        adapter.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string>((resolve) => {
                resolveLate = resolve;
            });
        });

        const request = runTranslationServiceConnectionTest('demo');
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(CONNECTION_TEST_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(signal?.aborted).toBe(true);

        resolveLate('迟到译文');
        await Promise.resolve();
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('非超时 adapter 错误保持原始原因', async () => {
        const failure = new Error('provider failed');
        adapter.mockRejectedValue(failure);

        await expect(runTranslationServiceConnectionTest('demo')).rejects.toBe(failure);
    });

    it('把真实连接测试尝试记录为 connection-test，并在返回前等待统计写入', async () => {
        const usageWrite = deferred<void>();
        const recordModelUsage = vi.fn(() => usageWrite.promise);
        adapter.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                actualModel: 'demo-model',
                startedAt: 10,
                durationMs: -5,
                usageAvailability: 'reported',
                inputTokens: 4,
                outputTokens: 2,
                totalTokens: 6,
            });
            reportTranslationModelUsage(message, {
                startedAt: Number.NaN,
                durationMs: Number.NaN,
                usageAvailability: 'unreported',
            });
            return '测试译文';
        });

        let settled = false;
        const request = runTranslationServiceConnectionTest('demo', {
            configuredModel: '  demo-config  ',
            recordModelUsage,
        });
        void request.finally(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(recordModelUsage).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({
                serviceId: 'demo',
                configuredModel: 'demo-config',
                actualModel: 'demo-model',
                startedAt: 10,
                durationMs: 0,
                purpose: 'connection-test',
                outcome: 'success',
                totalTokens: 6,
            }),
            expect.objectContaining({
                startedAt: expect.any(Number),
                durationMs: 0,
                outcome: 'success',
                usageAvailability: 'unreported',
            }),
        ]);
        usageWrite.resolve();
        await expect(request).resolves.toEqual(expect.objectContaining({durationMs: expect.any(Number)}));
    });

    it('连接测试用量写入超过宽限期后释放成功响应', async () => {
        vi.useFakeTimers();
        const recordModelUsage = vi.fn(() => new Promise<void>(() => undefined));
        const warn = vi.fn();
        adapter.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '测试译文';
        });

        const request = runTranslationServiceConnectionTest('demo', {
            recordModelUsage,
            warn,
            persistenceGraceMs: 25,
        });
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        expect(recordModelUsage).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(24);
        let settled = false;
        void request.finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(request).resolves.toEqual(expect.objectContaining({durationMs: expect.any(Number)}));
        expect(warn).toHaveBeenCalledWith(
            '[FluentRead] connection test usage write timed out:',
            expect.any(Error),
        );
    });

    it('连接测试预检失败不造请求，结构化 timeout 会校准 transport cancelled', async () => {
        const recordModelUsage = vi.fn(async () => undefined);
        adapter.mockRejectedValueOnce(new Error('local validation failed'));
        await expect(runTranslationServiceConnectionTest('demo', {recordModelUsage}))
            .rejects.toThrow('local validation failed');
        expect(recordModelUsage).not.toHaveBeenCalled();

        const timeoutError = Object.assign(new Error('provider timeout'), {kind: 'timeout'});
        adapter.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                outcome: 'cancelled',
                usageAvailability: 'unreported',
            });
            throw timeoutError;
        });
        await expect(runTranslationServiceConnectionTest('demo', {recordModelUsage}))
            .rejects.toBe(timeoutError);
        expect(recordModelUsage).toHaveBeenNthCalledWith(1, [
            expect.objectContaining({
                purpose: 'connection-test',
                outcome: 'timeout',
            }),
        ]);

        const httpTimeout = new Error('adapter omitted structured timeout');
        adapter.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                outcome: 'error',
                statusCode: 408,
                usageAvailability: 'unreported',
            });
            throw httpTimeout;
        });
        await expect(runTranslationServiceConnectionTest('demo', {recordModelUsage}))
            .rejects.toBe(httpTimeout);
        expect(recordModelUsage).toHaveBeenNthCalledWith(2, [
            expect.objectContaining({
                purpose: 'connection-test',
                statusCode: 408,
                outcome: 'timeout',
            }),
        ]);
    });

    it('区分取消与不同结构化超时，并处理非对象错误', async () => {
        const abortError = new Error('caller cancelled');
        abortError.name = 'AbortError';
        adapter.mockRejectedValueOnce(abortError);
        await expect(runTranslationServiceConnectionTest('demo')).rejects.toBe(abortError);

        for (const timeoutError of [
            Object.assign(new Error('named timeout'), {name: 'TimeoutError'}),
            Object.assign(new Error('http timeout'), {statusCode: 408}),
        ]) {
            adapter.mockRejectedValueOnce(timeoutError);
            await expect(runTranslationServiceConnectionTest('demo')).rejects.toBe(timeoutError);
        }

        adapter.mockRejectedValueOnce('plain failure');
        await expect(runTranslationServiceConnectionTest('demo')).rejects.toBe('plain failure');
    });

    it('统计写入的异步或同步失败都只告警，不改变连接测试结果', async () => {
        const asyncFailure = new Error('async usage failure');
        const syncFailure = new Error('sync usage failure');
        const warn = vi.fn();
        adapter.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '测试译文';
        });

        await expect(runTranslationServiceConnectionTest('demo', {
            recordModelUsage: vi.fn(async () => { throw asyncFailure; }),
            warn,
        })).resolves.toEqual(expect.objectContaining({durationMs: expect.any(Number)}));
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
            '[FluentRead] connection test usage write failed:',
            asyncFailure,
        ));

        await expect(runTranslationServiceConnectionTest('demo', {
            recordModelUsage: vi.fn(() => { throw syncFailure; }),
            warn,
        })).resolves.toEqual(expect.objectContaining({durationMs: expect.any(Number)}));
        expect(warn).toHaveBeenCalledWith(
            '[FluentRead] connection test usage write failed:',
            syncFailure,
        );
    });

    it('复用统一服务错误格式化器', () => {
        expect(formatConnectionTestError('demo', new Error('plain failure'))).toBe('plain failure');
    });

    it('将 MiniMax 2049 错误转换为 Key、区域和计费类型提示', () => {
        const message = formatServiceError(
            services.minimax,
            new Error('翻译失败: 401 Unauthorized'),
        );

        expect(message).toContain('Token Plan Key');
        expect(message).toContain('api.minimaxi.com');
        expect(message).toContain('api.minimax.io');
        expect(message).toContain('不能互换');
    });

    it('将 MiMo 鉴权错误转换为 Key 前缀和集群提示', () => {
        const message = formatServiceError(
            services.mimo,
            new Error('翻译失败: 401 Unauthorized'),
        );

        expect(message).toContain('sk-');
        expect(message).toContain('tp-');
        expect(message).toContain('中国、新加坡或欧洲集群');
    });

    it('统一读取 Error 与非 Error 的消息', () => {
        expect(getServiceErrorMessage(new Error('from-error'))).toBe('from-error');
        expect(getServiceErrorMessage(503)).toBe('503');
    });

    it('网络错误增加可识别前缀，其他错误保持供应商原文', () => {
        expect(formatServiceError('demo', new Error('Failed to fetch endpoint')))
            .toBe('网络连接失败：Failed to fetch endpoint');
        expect(formatServiceError('demo', new Error('provider rejected request')))
            .toBe('provider rejected request');
    });

    it('空错误使用稳定兜底，并且鉴权提示只对匹配服务生效', () => {
        expect(formatServiceError('demo', '   ')).toBe('未知错误');
        expect(formatServiceError('demo', '401 Unauthorized')).toBe('401 Unauthorized');
    });
});
