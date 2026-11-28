import {withProviderSnapshot} from './helpers/providerSnapshot';
import {getApiKeyRequirementKey} from '@/src/core/config/validation';
import {TRANSLATION_COMPACT_BATCH} from '@/src/services/translation/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mockConfig = vi.hoisted(() => ({
    service: 'zhipu',
    aiRequestTimeoutMs: undefined as number | undefined,
    to: 'zh-Hans',
    token: {zhipu: 'api-id.api-secret'} as Record<string, string>,
    proxy: {} as Record<string, string>,
    model: {zhipu: 'glm-4.5-flash'} as Record<string, string>,
    customModel: {} as Record<string, string>,
    customBody: {} as Record<string, string>,
    system_role: {zhipu: 'Translate safely.'} as Record<string, string>,
    user_role: {zhipu: 'Translate {{origin}} into {{to}}.'} as Record<string, string>,
    requireApiKey: {} as Record<string, boolean>,
    extra: {zhipu: {secret: 'legacy-persisted-jwt', expiration: Number.MAX_SAFE_INTEGER}},
}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import zhipu from '@/src/providers/translation/zhipu';

describe('智谱派生 JWT 凭据', () => {
    beforeEach(() => {
        mockConfig.aiRequestTimeoutMs = undefined;
        mockConfig.token.zhipu = 'api-id.api-secret';
        mockConfig.proxy = {};
        mockConfig.requireApiKey = {};
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({choices: [{message: {content: 'translated'}}]}),
        })));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each(['', 'not-a-jwt-pair'])('required malformed key %s fails before sending a request', async token => {
        mockConfig.token.zhipu = token;
        await expect(zhipu(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('无法生成令牌');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('optional no-key endpoints do not reuse a prior signed credential', async () => {
        await zhipu(withProviderSnapshot({origin: 'first'}, mockConfig));
        mockConfig.token.zhipu = '';
        mockConfig.requireApiKey = {[getApiKeyRequirementKey('zhipu', mockConfig)]: false};
        await zhipu(withProviderSnapshot({origin: 'second'}, mockConfig));
        const calls = vi.mocked(fetch).mock.calls;
        expect(new Headers(calls[0][1]?.headers).get('Authorization')).toMatch(/^Bearer /);
        expect(new Headers(calls[1][1]?.headers).has('Authorization')).toBe(false);
    });
    it('只在模块内存复用 JWT，不读取或改写 config.extra', async () => {
        const legacyExtra = structuredClone(mockConfig.extra);
        await zhipu(withProviderSnapshot({origin: 'hello', targetLanguage: 'zh-Hans'}, mockConfig));
        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
        await zhipu(withProviderSnapshot({origin: 'world', targetLanguage: 'zh-Hans'}, mockConfig));

        const fetchMock = vi.mocked(fetch);
        const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Headers;
        const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Headers;
        expect(firstHeaders.get('Authorization')).toMatch(/^Bearer /);
        expect(secondHeaders.get('Authorization')).toBe(firstHeaders.get('Authorization'));
        expect(mockConfig.extra).toEqual(legacyExtra);
    });

    it('支持代理地址、多 Key 独立 JWT 缓存、推理清理、compactBatch 截断识别与请求超时', async () => {
        mockConfig.proxy.zhipu = 'https://zhipu-proxy.example/v4/chat/completions';
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({choices: [{message: {content: '<think>reasoning</think>你好'}, finish_reason: 'stop'}]}),
        })));
        const first = await zhipu(withProviderSnapshot({origin: 'hello'}, mockConfig));
        expect(first).toBe('你好');
        const fetchMock = vi.mocked(fetch);
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://zhipu-proxy.example/v4/chat/completions');
        const key1Auth = (fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('Authorization');

        // 切换 Key 后保留各自缓存，切回第一个 Key 时仍复用原有 JWT 而不重签。
        vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
        mockConfig.token.zhipu = 'api-id-2.api-secret-2';
        await zhipu(withProviderSnapshot({origin: 'second'}, mockConfig));
        const key2Auth = (fetchMock.mock.calls[1]?.[1]?.headers as Headers).get('Authorization');
        expect(key2Auth).not.toBe(key1Auth);

        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
        mockConfig.token.zhipu = 'api-id.api-secret';
        await zhipu(withProviderSnapshot({origin: 'third'}, mockConfig));
        expect((fetchMock.mock.calls[2]?.[1]?.headers as Headers).get('Authorization')).toBe(key1Auth);

        // 超过缓存上限后驱逐最旧条目，避免长期运行内存无界增长。
        for (let i = 0; i < 65; i += 1) {
            mockConfig.token.zhipu = `cap-id-${i}.cap-secret-${i}`;
            await zhipu(withProviderSnapshot({origin: 'cap'}, mockConfig));
        }

        // compactBatch 透传原始 JSON 字符串，并在 finish_reason === 'length' 时抛出批次截断错误。
        mockConfig.token.zhipu = 'api-id.api-secret';
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({choices: [{message: {content: '[[0,"<think>tag</think>"]]'}, finish_reason: 'stop'}]}),
        })));
        const compactBase = withProviderSnapshot({origin: '["tag"]'}, mockConfig);
        const compactSnap = Object.freeze({...(compactBase as any)[Object.getOwnPropertySymbols(compactBase)[0]!], [TRANSLATION_COMPACT_BATCH]: true as const});
        Object.defineProperty(compactBase, Object.getOwnPropertySymbols(compactBase)[0]!, {value: compactSnap});
        await expect(zhipu(compactBase)).resolves.toBe('[[0,"<think>tag</think>"]]');

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({choices: [{message: {content: '[[0,"截断'}, finish_reason: 'length'}]}),
        })));
        await expect(zhipu(compactBase)).rejects.toMatchObject({code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});

        // 独立调用超时抛出 TimeoutError 并清理计时器。
        vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
        })));
        const timeoutOutcome = zhipu(withProviderSnapshot({origin: 'slow', requestTimeoutMs: 50}, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(50);
        await expect(timeoutOutcome).resolves.toMatchObject({name: 'TimeoutError', kind: 'timeout', retryable: true});
        expect(vi.getTimerCount()).toBe(0);
    });
});
