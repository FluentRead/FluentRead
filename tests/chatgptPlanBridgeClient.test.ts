/**
 * @file tests/chatgptPlanBridgeClient.test.ts
 * 文件职责：验证 ChatGPT 本机助手平台端口、设置消息客户端及后台信任边界的真实行为。
 * 主要内容：控制网络、存储和浏览器能力，覆盖输入校验、账号归属、配对写入串行、非合作传输取消、有界元信息读取与流释放。
 * 模块边界：不替换被测业务模块、不使用真实授权或令牌；本地端口夹具不证明在线 ChatGPT 套餐可用。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
const buildMode = vi.hoisted(() => ({enabled: true}));
vi.mock('@/src/platform/chatgpt-plan/buildMode', () => ({get chatGPTPlanDevelopmentEnabled() {return buildMode.enabled;}}));
import {
    CHATGPT_PLAN_BRIDGE_URL, CHATGPT_PLAN_PAIRING_KEY, CHATGPT_PLAN_USAGE_URL,
    ChatGPTPlanError, createChatGPTPlanBridge, normalizeChatGPTPlanErrorCode,
    readChatGPTPlanModels, readChatGPTPlanStatus, chatGPTPlanBridge, requestChatGPTPlanResponse,
} from '@/src/platform/chatgpt-plan/bridge';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {isRetryableTranslationError, serializeTranslationError, TranslationRequestError} from '@/src/services/translation/errors';
import {createChatGPTPlanHandler} from '@/src/app/background/chatgptPlanRuntime';
import * as client from '@/src/services/chatgpt-plan/client';
const fixtureToken = 'synthetic-local-pairing-capability-0000000000';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const fixtureStatus = {connected: true, sharing: true, account: {email: 'fixture@example.test', name: 'Fixture'}, authPending: false};
function pending<T>() {
    let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};
}
async function settle() {for (let i = 0; i < 20; i++) await Promise.resolve();}
function createFixture(initial: string | undefined = fixtureToken) {
    let token = initial;
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith('/status')) return json(fixtureStatus);
        if (String(url).endsWith('/models')) return json({models: [{slug: 'fixture-model', display_name: 'Fixture model'}]});
        if (String(url).endsWith('/pair')) return json({bridgeToken: fixtureToken});
        if (String(url).endsWith('/auth/start')) return json({authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture'});
        return json({});
    });
    const write = vi.fn(async (value: string) => {token = value;});
    return {bridge: createChatGPTPlanBridge({fetch, storage: {read: async () => token, write}}), fetch, write, token: () => token};
}
afterEach(() => {buildMode.enabled = true;setRuntimeFetch();vi.unstubAllGlobals(); vi.useRealTimers();});
describe('ChatGPT 本机助手端口', () => {
    it.each(['models', 'status'] as const)('退出与 %s 结算交错时只返回完整结果或会话取消，并释放全部计时器', async action => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']}); const outcomes = new Set<string>();
        for (let delay = 0; delay <= 25; delay++) {
            const fixture = createFixture();
            const result = fixture.bridge[action]().then(value => {
                if (action === 'models') expect(value).toEqual(expect.arrayContaining([expect.objectContaining({slug: 'fixture-model'})]));
                else expect(value).toMatchObject({paired: true, connected: true});
                outcomes.add('complete');
            }, error => {expect(error).toMatchObject({code: 'session_changed'}); outcomes.add('cancelled');});
            const logout = (async () => {
                if (delay === 25) await new Promise<void>(resolve => setImmediate(resolve));
                else for (let step = 0; step < delay; step++) await Promise.resolve();
                await fixture.bridge.disconnect();
            })();
            await Promise.all([result, logout]); expect(vi.getTimerCount()).toBe(0);
        }
        expect(outcomes).toEqual(new Set(['complete', 'cancelled']));
    });
    it('取消与读取响应交错时及时交还流，不遗留请求或未处理拒绝', async () => {
        const outcomes = new Set<string>();
        for (let delay = 0; delay <= 24; delay++) {
            const fixture = createFixture(), caller = new AbortController();
            const result = fixture.bridge.respond({model: 'fixture', input: []}, caller.signal).then(response => response.text()).then(value => {
                expect(value).toBe('{}'); outcomes.add('complete');
            }, error => {expect(error).toMatchObject({name: 'AbortError'}); outcomes.add('cancelled');});
            const cancel = (async () => {for (let step = 0; step < delay; step++) await Promise.resolve(); caller.abort();})();
            await Promise.all([result, cancel]);
        }
        expect(outcomes).toEqual(new Set(['complete', 'cancelled']));
    });
    it('调用者在监听注册边界同步取消时，不派发已失效的传输', async () => {
        const fixture = createFixture(), caller = new AbortController();
        const register = caller.signal.addEventListener.bind(caller.signal);
        const added = vi.spyOn(caller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
            register(type, listener, options); caller.abort();
        });
        try {
            await expect(fixture.bridge.respond({model: 'fixture', input: []}, caller.signal)).rejects.toMatchObject({name: 'AbortError'});
            expect(fixture.fetch).not.toHaveBeenCalled();
        } finally {added.mockRestore();}
    });
    it('监听注册端口重入配对时，不把旧请求发送到新的账号会话', async () => {
        const fixture = createFixture(), caller = new AbortController();
        let pairing: ReturnType<typeof fixture.bridge.pair> | undefined;
        const register = caller.signal.addEventListener.bind(caller.signal);
        const added = vi.spyOn(caller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
            register(type, listener, options); pairing = fixture.bridge.pair('fixture-next-pairing-code');
        });
        try {
            await expect(fixture.bridge.respond({model: 'fixture', input: []}, caller.signal)).rejects.toMatchObject({code: 'session_changed'});
            expect(pairing).toBeDefined(); await pairing;
            expect(fixture.fetch.mock.calls.some(([url]) => String(url).endsWith('/responses'))).toBe(false);
            expect(fixture.write).toHaveBeenCalledOnce();
        } finally {added.mockRestore();}
    });
    it('取消已开始的 SSE 读取不等待底层取消握手，并立即释放上游锁', async () => {
        const fixture = createFixture(), caller = new AbortController();
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const upstream = new ReadableStream<Uint8Array>({cancel});
        fixture.fetch.mockResolvedValueOnce(new Response(upstream));
        const response = await fixture.bridge.respond({model: 'fixture', input: []}, caller.signal);
        let settled = false;
        const result = response.body!.getReader().read().catch(error => {settled = true; return error;});
        await settle(); caller.abort(); await settle();
        expect(cancel).toHaveBeenCalledOnce();
        expect(upstream.locked).toBe(false);
        expect(settled).toBe(true);
        expect(await result).toMatchObject({name: 'AbortError'});
    });
    it('主动丢弃 SSE 正文不等待底层取消握手', async () => {
        const fixture = createFixture();
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const upstream = new ReadableStream<Uint8Array>({cancel});
        fixture.fetch.mockResolvedValueOnce(new Response(upstream));
        const response = await fixture.bridge.respond({model: 'fixture', input: []});
        let settled = false;
        const result = response.body!.cancel().then(() => {settled = true;});
        await settle();
        expect(upstream.locked).toBe(false);
        expect(settled).toBe(true);
        await result;
        expect(cancel).toHaveBeenCalledOnce();
    });
    it.each(['caller', 'metadata', 'status'] as const)('配对存储未决也受 %s 取消或预算约束，迟到读取不派发', async mode => {
        vi.useFakeTimers();
        const read = pending<string>(), fetch = vi.fn(), caller = new AbortController();
        const bridge = createChatGPTPlanBridge({fetch, storage: {read: () => read.promise, write: vi.fn()}});
        let settled = false;
        const result = (mode === 'caller' ? bridge.respond({model: 'fixture', input: []}, caller.signal) : mode === 'status' ? bridge.status() : bridge.models())
            .catch(error => {settled = true; return error;});
        await settle();
        if (mode === 'caller') caller.abort();
        else await vi.advanceTimersByTimeAsync(15_000);
        await settle();
        expect(settled).toBe(true);
        expect(await result).toMatchObject({name: 'AbortError'});
        read.resolve(fixtureToken); await settle();
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('传输端口同步取消时不会错过 abort 或等待不合作的返回值', async () => {
        const caller = new AbortController();
        const fetch = vi.fn(() => {caller.abort();return new Promise<Response>(() => {});});
        const bridge = createChatGPTPlanBridge({fetch, storage: {read: async () => fixtureToken, write: vi.fn()}});
        await expect(bridge.respond({model: 'fixture', input: []}, caller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('状态的凭证读取耗时计入同一个十五秒预算', async () => {
        vi.useFakeTimers();
        const firstRead = pending<string>(), response = pending<Response>();
        const read = vi.fn().mockReturnValueOnce(firstRead.promise).mockResolvedValue(fixtureToken);
        const fetch = vi.fn(() => response.promise);
        const bridge = createChatGPTPlanBridge({fetch, storage: {read, write: vi.fn()}});
        const result = bridge.status().catch(error => error);
        await vi.advanceTimersByTimeAsync(14_999);
        firstRead.resolve(fixtureToken); await settle();
        expect(fetch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({name: 'AbortError'});
        expect(vi.getTimerCount()).toBe(0);
        response.resolve(json(fixtureStatus)); await settle();
    });
    it('错误结构保留HTTP和broker重试语义，套餐额度与授权失败不自动重试', () => {
        for (const [code, status, kind, retryable, expectedStatus] of [
            ['quota_exceeded', undefined, 'rate-limit', false, 429], ['not_connected', undefined, 'authentication', false, 401],
            ['sharing_disabled', undefined, 'authentication', false, 403], ['oauth_failed', undefined, 'authentication', false, 401],
            ['oauth_cancelled', undefined, 'authentication', false, 401], ['pairing_failed', undefined, 'authentication', false, 401],
            ['helper_unavailable', undefined, 'network', true, undefined], ['invalid_response', undefined, 'response', false, undefined],
            ['public_unavailable', undefined, 'provider', false, 503],
            ['invalid_response', 403, 'authentication', false, 403], ['invalid_response', 401, 'authentication', false, 401],
            ['invalid_response', 503, 'provider', true, 503], ['invalid_response', 408, 'timeout', true, 408],
            ['invalid_response', 400, 'bad-request', false, 400], ['invalid_response', 429, 'rate-limit', false, 429],
        ] as const) {
            const error = new ChatGPTPlanError(code, status);
            expect(error).toMatchObject({kind, retryable, statusCode: expectedStatus, status});
            expect(serializeTranslationError(error)).toMatchObject({kind, retryable, statusCode: expectedStatus, code});
            expect(isRetryableTranslationError(new TranslationRequestError(serializeTranslationError(error)))).toBe(retryable);
        }
    });
    it('未配对不访问网络；配对后的状态严格剔除额外字段', async () => {
        const fixture = createFixture('');
        expect(await fixture.bridge.status()).toEqual({paired: false, connected: false, sharing: false, authPending: false});
        expect(fixture.fetch).not.toHaveBeenCalled();
        const paired = createFixture();
        paired.fetch.mockResolvedValueOnce(json({...fixtureStatus, access_token: 'discarded', account: {...fixtureStatus.account, token: 'discarded'}}));
        expect(await paired.bridge.status()).toEqual({paired: true, ...fixtureStatus});
    });
    it('固定助手地址与POST，配对成功仅写独立凭证槽，不触碰config', async () => {
        const fixture = createFixture('');
        expect(await fixture.bridge.pair('fixture-pairing-code-123456')).toEqual({paired: true, ...fixtureStatus});
        expect(fixture.write).toHaveBeenCalledWith(fixtureToken);
        const [url, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${CHATGPT_PLAN_BRIDGE_URL}/pair`);
        expect(init).toMatchObject({method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'});
        expect(init.headers).toEqual({'Content-Type': 'application/json'});
        expect(CHATGPT_PLAN_PAIRING_KEY).not.toMatch(/config/u);
    });
    it.each(['short', ' ', 'https://example.test/pair'])('拒绝无效配对码 %s', async code => {
        const fixture = createFixture();
        await expect(fixture.bridge.pair(code)).rejects.toMatchObject({code: 'pairing_failed'});
        expect(fixture.fetch).not.toHaveBeenCalled();
    });
    it.each([{}, {bridgeToken: 'tiny'}, {bridgeToken: 1}])('拒绝无效助手配对响应 %j', async value => {
        const fixture = createFixture(); fixture.fetch.mockResolvedValueOnce(json(value));
        await expect(fixture.bridge.pair('fixture-pairing-code-123456')).rejects.toMatchObject({code: 'pairing_failed'});
        expect(fixture.write).not.toHaveBeenCalled();
    });
    it('模型使用账户动态目录，不能重复或猜测slug', async () => {
        const fixture = createFixture();
        expect(await fixture.bridge.models()).toEqual([{slug: 'fixture-model', display_name: 'Fixture model'}]);
        for (const value of [{}, {models: [{}]}, {models: [{slug: 'x', display_name: 'X'}, {slug: 'x', display_name: 'X'}]}, {models: new Array(1001)}]) {
            expect(() => readChatGPTPlanModels(value)).toThrow(ChatGPTPlanError);
        }
    });
    it('只打开固定OpenAI授权入口，拒绝助手提供的任意链接', async () => {
        const fixture = createFixture();
        expect(await fixture.bridge.signIn()).toMatch(/^https:\/\/auth.openai.com\/api\/accounts\/authorize/u);
        for (const value of [{}, {authorizationUrl: 'https://evil.test/api/accounts/authorize'}, {authorizationUrl: 'https://auth.openai.com/evil'}, {authorizationUrl: 'https://x@y@auth.openai.com/api/accounts/authorize'}]) {
            fixture.fetch.mockResolvedValueOnce(json(value));
            await expect(fixture.bridge.signIn()).rejects.toThrow(ChatGPTPlanError);
        }
    });
    it('取消授权及退出保留本机配对，但必须完成助手状态确认', async () => {
        const fixture = createFixture();
        expect((await fixture.bridge.cancelSignIn()).paired).toBe(true);
        expect((await fixture.bridge.disconnect()).paired).toBe(true);
        expect(fixture.token()).toBe(fixtureToken);
    });
    it('网络失败和未知服务器异常只返回安全错误，不泄漏原文', async () => {
        const fixture = createFixture();
        fixture.fetch.mockRejectedValueOnce(new Error('private upstream text'));
        await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'helper_unavailable'});
        fixture.fetch.mockResolvedValueOnce(json({error: {code: 'subscription_sharing_usage_limit_exceeded', message: 'private upstream text'}}, 429));
        await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'quota_exceeded', status: 429});
        fixture.fetch.mockResolvedValueOnce(new Response('not json', {status: 500}));
        await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'invalid_response'});
    });
    it('未配对不能请求模型，预取消不能发送请求', async () => {
        await expect(createFixture('').bridge.models()).rejects.toMatchObject({code: 'not_connected'});
        const fixture = createFixture(); const controller = new AbortController(); controller.abort();
        await expect(fixture.bridge.respond({model: 'fixture', input: []}, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fixture.fetch).not.toHaveBeenCalled();
    });
    it('读取流保持原始SSE，退出会中断旧流而不是读取晚到块', async () => {
        const fixture = createFixture(); let emit!: ReadableStreamDefaultController<Uint8Array>;
        fixture.fetch.mockResolvedValueOnce(new Response(new ReadableStream({start(c) {emit = c;}}), {headers: {'Content-Type': 'text/event-stream'}}));
        const response = await fixture.bridge.respond({model: 'fixture', input: []});
        const reader = response.body!.getReader();
        emit.enqueue(new TextEncoder().encode('data: fixture\n\n'));
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: fixture\n\n');
        const pending = reader.read();
        const rejected = expect(pending).rejects.toMatchObject({code: 'session_changed'});
        await fixture.bridge.disconnect();
        await rejected;
    });
    it('消费完毕或主动取消流会释放持有的请求', async () => {
        const fixture = createFixture();
        fixture.fetch.mockResolvedValueOnce(new Response('complete'));
        expect(await (await fixture.bridge.respond({model: 'fixture', input: []})).text()).toBe('complete');
        const cancel = vi.fn(); fixture.fetch.mockResolvedValueOnce(new Response(new ReadableStream({cancel})));
        await (await fixture.bridge.respond({model: 'fixture', input: []})).body!.cancel();
        expect(cancel).toHaveBeenCalled();
    });
    it('状态schema拒绝非bool、账号字段越界，错误码限制为已知安全集合', () => {
        expect(() => readChatGPTPlanStatus({connected: 1, sharing: false})).toThrow(ChatGPTPlanError);
        expect(readChatGPTPlanStatus({connected: false, sharing: false, error: 'login_required', account: {name: 'x'.repeat(301), email: 'x'.repeat(321)}})).toEqual({connected: false, sharing: false, authPending: false, error: 'not_connected', account: {name: undefined, email: undefined}});
        expect(readChatGPTPlanStatus({connected: true, sharing: false})).toEqual({connected: true, sharing: false, authPending: false});
        for (const [code, expected] of [['invalid_pairing_code', 'pairing_failed'], ['insufficient_scope', 'sharing_disabled'], ['invalid_grant', 'not_connected'], ['subscription_sharing_usage_unavailable', 'quota_exceeded'], ['insufficient_quota', 'quota_exceeded'], ['oauth_cancelled', 'oauth_cancelled'], ['unknown', 'invalid_response'], [null, 'invalid_response']]) expect(normalizeChatGPTPlanErrorCode(code)).toBe(expected);
        for (const code of ['invalid_token', 'token_expired', 'invalid_refresh_token', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'authentication_error', 'invalid_api_key']) {
            const normalized = normalizeChatGPTPlanErrorCode(code);
            expect(new ChatGPTPlanError(normalized)).toMatchObject({code: 'not_connected', kind: 'authentication', retryable: false});
        }
    });
    it('不合作的metadata transport超时后也立即结束，迟到响应不得作为成功提交', async () => {
        vi.useFakeTimers();const fixture = createFixture(), delayed = pending<Response>();fixture.fetch.mockReturnValueOnce(delayed.promise);
        let settled = false;const job = fixture.bridge.models().then(() => 'unexpected success', error => {settled = true;return error;});
        await settle();await vi.advanceTimersByTimeAsync(15_000);await settle();expect(settled).toBe(true);
        delayed.resolve(json({models: [{slug: 'late', display_name: 'Late'}]}));const error = await job;
        expect(error).toMatchObject({name: 'AbortError'});expect(vi.getTimerCount()).toBe(0);
    });
    it('JSON正文读取也受metadata预算和账号归属约束，注销后拒绝迟到旧模型', async () => {
        const fixture = createFixture();const body = pending<Uint8Array>();let bodyStarted = false;
        fixture.fetch.mockResolvedValueOnce(new Response(new ReadableStream({async pull(controller) {bodyStarted = true;controller.enqueue(await body.promise);controller.close();}})));
        const modelJob = fixture.bridge.models();const rejected = expect(modelJob).rejects.toMatchObject({code: 'session_changed'});await settle();expect(bodyStarted).toBe(true);
        await fixture.bridge.disconnect();body.resolve(new TextEncoder().encode(JSON.stringify({models: [{slug: 'old-model', display_name: 'Old account'}]})));await rejected;
    });
    it('元信息body超时会主动cancel reader，失败取消不会泄漏未处理异常', async () => {
        vi.useFakeTimers();const fixture = createFixture(), body = pending<Uint8Array>(), cancel = vi.fn(async () => {throw new Error('private cancel detail');});
        fixture.fetch.mockResolvedValueOnce(new Response(new ReadableStream({async pull(controller) {controller.enqueue(await body.promise);}, cancel})));
        const job = fixture.bridge.status();const rejected = expect(job).rejects.toMatchObject({name: 'AbortError'});await settle();
        await vi.advanceTimersByTimeAsync(15_000);await rejected;expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);body.resolve(new Uint8Array());
    });
    it('caller取消不合作stream transport立即结束，迟到正文即使cancel失败也释放', async () => {
        const fixture = createFixture(), delayed = pending<Response>(), caller = new AbortController(), cancel = vi.fn(async () => {throw new Error('cancel failed');});
        fixture.fetch.mockReturnValueOnce(delayed.promise);const job = fixture.bridge.respond({model: 'fixture', input: []}, caller.signal);
        const rejected = expect(job).rejects.toMatchObject({name: 'AbortError'});await settle();caller.abort();await rejected;
        delayed.resolve(new Response(new ReadableStream({cancel})));await settle();expect(cancel).toHaveBeenCalledOnce();
    });
    it('storage读取期间取消或更换配对不会发送旧请求，存储失败保持安全错误', async () => {
        const read = pending<string>(), fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/pair') ? json({bridgeToken: fixtureToken}) : json(fixtureStatus));
        const reads = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(fixtureToken);
        const bridge = createChatGPTPlanBridge({fetch, storage: {read: reads, write: vi.fn()}});
        const old = bridge.models();const rejected = expect(old).rejects.toMatchObject({code: 'session_changed'});await settle();await bridge.pair('fixture-pairing-code-123456');read.resolve(fixtureToken);await rejected;
        const caller = new AbortController(), waiting = pending<string>();reads.mockReturnValueOnce(waiting.promise);
        const responding = bridge.respond({model: 'fixture', input: []}, caller.signal);const abort = expect(responding).rejects.toMatchObject({name: 'AbortError'});
        caller.abort();waiting.resolve(fixtureToken);await abort;
        reads.mockRejectedValueOnce(new Error('private-storage-detail'));await expect(bridge.status()).rejects.toMatchObject({code: 'helper_unavailable'});
        const failed = createChatGPTPlanBridge({fetch, storage: {read: async () => fixtureToken, write: async () => {throw new Error('private-write-detail');}}});
        await expect(failed.pair('fixture-pairing-code-123456')).rejects.toMatchObject({code: 'helper_unavailable'});
    });
    it('配对写入串行：旧write已经开始时新的配对仍最后保存，两个旧任务不能覆盖最新凭证', async () => {
        const firstWrite = pending<void>();let token = fixtureToken;
        const tokenOne = 'synthetic-capability-first-00000000000000000', tokenTwo = 'synthetic-capability-second-0000000000000000', tokenThree = 'synthetic-capability-third-00000000000000000';
        const fetch = vi.fn().mockResolvedValueOnce(json({bridgeToken: tokenOne})).mockResolvedValueOnce(json({bridgeToken: tokenTwo})).mockResolvedValueOnce(json({bridgeToken: tokenThree}))
            .mockImplementation(async () => json(fixtureStatus));
        const write = vi.fn(async (value: string) => {if (value === tokenOne) await firstWrite.promise;token = value;});
        const bridge = createChatGPTPlanBridge({fetch, storage: {read: async () => token, write}});
        const first = bridge.pair('fixture-first-pairing-code');const firstRejected = expect(first).rejects.toMatchObject({code: 'session_changed'});await settle();
        const second = bridge.pair('fixture-second-pairing-code');const secondRejected = expect(second).rejects.toMatchObject({code: 'session_changed'});await settle();
        const third = bridge.pair('fixture-third-pairing-code');await settle();expect(write).toHaveBeenCalledTimes(1);
        firstWrite.resolve();await firstRejected;await secondRejected;await third;
        expect(write.mock.calls.map(([value]) => value)).toEqual([tokenOne, tokenThree]);expect(token).toBe(tokenThree);
    });
    it('非bool状态、空或坏JSON、无body和坏模型字段均返回稳定schema错误', async () => {
        for (const value of [null, [], 1, {connected: false, sharing: 1}]) expect(() => readChatGPTPlanStatus(value)).toThrow(ChatGPTPlanError);
        for (const value of [null, [], {models: []}, {models: [null]}, {models: [{slug: 'x', display_name: ''}]}, {models: [{slug: 'x'.repeat(257), display_name: 'Name'}]}, {models: [{slug: 'x', display_name: 'x'.repeat(301)}]}]) {
            if (value && !Array.isArray(value) && 'models' in value && Array.isArray(value.models) && !value.models.length) expect(readChatGPTPlanModels(value)).toEqual([]);
            else expect(() => readChatGPTPlanModels(value)).toThrow(ChatGPTPlanError);
        }
        const fixture = createFixture();fixture.fetch.mockResolvedValueOnce(new Response('not json'));await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'invalid_response'});
        fixture.fetch.mockResolvedValueOnce(new Response(null));await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'invalid_response'});
        fixture.fetch.mockResolvedValueOnce(new Response(null));await expect(fixture.bridge.respond({model: 'fixture', input: []})).rejects.toMatchObject({code: 'invalid_response'});
        fixture.fetch.mockResolvedValueOnce(json({authorizationUrl: 'not a url'}));await expect(fixture.bridge.signIn()).rejects.toMatchObject({code: 'invalid_response'});
        expect(new ChatGPTPlanError('unknown-code').message).not.toContain('unknown-code');
        for (const [value, normalized] of [['access_denied', 'oauth_cancelled'], ['auth_cancelled', 'oauth_cancelled'], ['auth_failed', 'oauth_failed'], ['auth_expired', 'oauth_failed']]) expect(normalizeChatGPTPlanErrorCode(value)).toBe(normalized);
    });
    it('退出保留配对并明确远端撤销尚未确认，失败storage或JSON不会泄漏原文', async () => {
        const fixture = createFixture();fixture.fetch.mockResolvedValueOnce(json({connected: false, revocationConfirmed: false}));fixture.fetch.mockResolvedValueOnce(json({connected: false, sharing: false}));
        expect(await fixture.bridge.disconnect()).toMatchObject({paired: true, connected: false, revocationConfirmed: false, error: 'revoke_unconfirmed'});
        fixture.fetch.mockResolvedValueOnce(json(null));expect((await fixture.bridge.disconnect()).paired).toBe(true);
        fixture.fetch.mockResolvedValueOnce(json({authorizationUrl: 'https://auth.openai.com/api/accounts/authorize'}));await fixture.bridge.signIn(true);
        expect(JSON.parse((fixture.fetch.mock.calls.at(-1) as unknown as [unknown, RequestInit])[1].body as string)).toEqual({newAccount: true});
    });
    it('默认singleton仅读写独立本机槽，默认runtimeFetch和response导出可读取流', async () => {
        let token: string | undefined;
        const get = vi.fn(async (key: string) => ({[key]: token})), set = vi.fn(async (value: Record<string, string>) => {token = value[CHATGPT_PLAN_PAIRING_KEY];});
        vi.stubGlobal('browser', {storage: {local: {get, set}}});
        const transport = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/pair') ? json({bridgeToken: fixtureToken}) : String(url).endsWith('/responses') ? new Response('singleton SSE') : json(fixtureStatus));
        setRuntimeFetch(transport);expect((await chatGPTPlanBridge.status()).paired).toBe(false);
        await chatGPTPlanBridge.pair('fixture-pairing-code-123456');expect(set).toHaveBeenCalledWith({[CHATGPT_PLAN_PAIRING_KEY]: fixtureToken});
        expect(await (await requestChatGPTPlanResponse({model: 'fixture', input: []})).text()).toBe('singleton SSE');expect(get.mock.calls.every(([key]) => key === CHATGPT_PLAN_PAIRING_KEY)).toBe(true);
    });
    it('headers刚到达但尚未提交时退出，响应和初始存储等待都复验会话身份', async () => {
        const fixture = createFixture(), headers = pending<Response>();fixture.fetch.mockReturnValueOnce(headers.promise);
        const model = fixture.bridge.models();const modelRejected = expect(model).rejects.toMatchObject({code: 'session_changed'});await settle();
        headers.resolve(json({models: [{slug: 'old', display_name: 'Old'}]}));await fixture.bridge.disconnect();await modelRejected;
        const firstRead = pending<string>(), read = vi.fn().mockReturnValueOnce(firstRead.promise).mockResolvedValue(fixtureToken);
        const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/pair') ? json({bridgeToken: fixtureToken}) : json(fixtureStatus));
        const bridge = createChatGPTPlanBridge({fetch, storage: {read, write: vi.fn()}});
        const status = bridge.status();const statusRejected = expect(status).rejects.toMatchObject({code: 'session_changed'});
        await bridge.pair('fixture-pairing-code-123456');firstRead.resolve(fixtureToken);await statusRejected;
    });
    it('JSON解码已完成但账号同步改变，最后交付步骤仍拒绝旧metadata', async () => {
        const fixture = createFixture();let logout!: Promise<unknown>;
        const spy = vi.spyOn(Response.prototype, 'json').mockImplementationOnce(async () => {
            logout = fixture.bridge.disconnect();return {models: [{slug: 'old', display_name: 'Old'}]};
        });
        await expect(fixture.bridge.models()).rejects.toMatchObject({code: 'session_changed'});await logout;spy.mockRestore();
    });
});
describe('ChatGPT 设置消息边界', () => {
    it('公共构建即使有旧配对也不读取凭据、访问助手或打开授权网页', async () => {
        buildMode.enabled = false;
        const fixture = createFixture(), open = vi.fn(), get = vi.fn(), set = vi.fn();
        vi.stubGlobal('browser', {storage: {local: {get, set}}});
        const handler = createChatGPTPlanHandler(fixture.bridge, () => true, open);
        for (const action of ['status', 'pair', 'signIn', 'models', 'cancel', 'disconnect', 'usage']) {
            expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action, code: 'saved-pairing'}, {sender: {}} as never)).toEqual({success: false, code: 'public_unavailable'});
        }
        await expect(requestChatGPTPlanResponse({model: 'saved-account-model', input: []})).rejects.toMatchObject({code: 'public_unavailable', kind: 'provider', retryable: false});
        expect(fixture.fetch).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
        expect(normalizeChatGPTPlanErrorCode('public_unavailable')).toBe('public_unavailable');
    });
    it('网页和content sender不能配对、授权或查看账户', async () => {
        const fixture = createFixture(); const handler = createChatGPTPlanHandler(fixture.bridge, () => false, vi.fn());
        expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'status'}, {sender: {}} as never)).toEqual({success: false, code: 'not_connected'});
        expect(fixture.fetch).not.toHaveBeenCalled();
    });
    it('仅后台打开授权和用量页，并返回安全状态', async () => {
        const fixture = createFixture(); const open = vi.fn(async () => {}); const handler = createChatGPTPlanHandler(fixture.bridge, () => true, open);
        for (const action of ['status', 'pair', 'signIn', 'models', 'cancel', 'disconnect', 'usage']) expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action, code: 'fixture-pairing-code-123456'}, {sender: {}} as never)).toMatchObject({success: true});
        expect(open).toHaveBeenCalledWith(CHATGPT_PLAN_USAGE_URL);
        expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'pair', code: 1}, {sender: {}} as never)).toMatchObject({success: false, code: 'invalid_response'});
        fixture.fetch.mockRejectedValueOnce(new Error('private'));
        expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'models'}, {sender: {}} as never)).toMatchObject({success: false, code: 'helper_unavailable'});
    });
    it('设置端口只传操作，不接收token；响应失败恢复稳定代码', async () => {
        const sendMessage = vi.fn(async () => ({success: true, data: 'fixture'})); vi.stubGlobal('browser', {runtime: {sendMessage}});
        for (const invoke of [client.getChatGPTPlanStatus, () => client.pairChatGPTPlan('fixture'), client.startChatGPTPlanSignIn, client.cancelChatGPTPlanSignIn, client.disconnectChatGPTPlan, client.listChatGPTPlanModels, client.openChatGPTPlanUsage]) expect(await invoke()).toBe('fixture');
        sendMessage.mockResolvedValueOnce({success: false, code: 'quota_exceeded'} as never);
        await expect(client.getChatGPTPlanStatus()).rejects.toMatchObject({code: 'quota_exceeded'});
        sendMessage.mockResolvedValueOnce(undefined as never);
        await expect(client.getChatGPTPlanStatus()).rejects.toMatchObject({code: 'helper_unavailable'});
    });
    it('默认sender检查只信任同扩展options，默认打开browser tab，非法操作不触碰助手', async () => {
        const fixture = createFixture(), create = vi.fn(async () => ({id: 1}));
        const id = 'a'.repeat(32), optionsUrl = `chrome-extension://${id}/options.html`;
        vi.stubGlobal('browser', {runtime: {id, getURL: vi.fn(() => optionsUrl)}, tabs: {create}});
        const handler = createChatGPTPlanHandler(fixture.bridge);
        for (const sender of [undefined, {}, {id, url: 'https://example.test'}, {id: 'wrong', url: optionsUrl}, {id, url: `${optionsUrl}/extra`}]) {
            expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'signIn'}, {sender} as never)).toEqual({success: false, code: 'not_connected'});
        }
        const context = {sender: {id, url: `${optionsUrl}?panel=connections`}} as never;
        expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'signIn', newAccount: true}, context)).toMatchObject({success: true});
        expect(create).toHaveBeenCalledWith({url: expect.stringMatching(/^https:\/\/auth.openai.com/u)});
        expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'usage'}, context)).toEqual({success: true, data: undefined});
        expect(create).toHaveBeenLastCalledWith({url: CHATGPT_PLAN_USAGE_URL});
        for (const message of [{action: 'unknown'}, {action: 'signIn', newAccount: 'true'}, {action: 'pair', code: null}]) expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, ...message}, context)).toEqual({success: false, code: 'invalid_response'});
        create.mockRejectedValueOnce(new Error('private-tab-error'));expect(await handler.handle({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'usage'}, context)).toEqual({success: false, code: 'helper_unavailable'});
        const sendMessage = vi.fn(async () => ({success: true, data: undefined}));vi.stubGlobal('browser', {runtime: {sendMessage}});
        await client.startChatGPTPlanSignIn(true);expect(sendMessage).toHaveBeenLastCalledWith({type: client.CHATGPT_PLAN_MESSAGE_TYPE, action: 'signIn', newAccount: true});
    });
});
