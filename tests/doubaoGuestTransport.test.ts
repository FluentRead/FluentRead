/**
 * @file tests/doubaoGuestTransport.test.ts
 * 文件职责：验证匿名豆包网络边界的端点限制、临时规则生命周期和取消行为。
 * 主要内容：使用受控浏览器端口覆盖安装/清理失败、并发串行、重启清理以及内部头不出站；真实网络头由独立浏览器验收确认。
 * 模块边界：不读取个人 Cookie、不请求在线服务、不记录真实访客凭据。
 */
import {describe, expect, it, vi} from 'vitest';
import {createDoubaoGuestFetch, readDoubaoGuestRequest, DOUBAO_GUEST_HEADER, DOUBAO_GUEST_RULE_ID} from '@/src/platform/http/doubaoGuest';

const url = 'https://www.doubao.com/samantha/plugin/stream_article_translate?tea_uuid=123456789012345678';
const init = {method: 'POST', headers: {[DOUBAO_GUEST_HEADER]: 'anonymous-test-token', Cookie: 'personal=secret', Authorization: 'secret'}, body: '{}'};
const port = () => ({updateSessionRules: vi.fn().mockResolvedValue(undefined)});

describe('豆包临时匿名网络请求', () => {
    it('普通请求完全保留原传输；没有会话 API 时只拒绝访客请求', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        const transport = createDoubaoGuestFetch(undefined, 'own', fetch);
        await transport('https://other.test/', {method: 'GET'});
        expect(fetch).toHaveBeenCalledWith('https://other.test/', {method: 'GET'});
        await expect(transport(url, init)).rejects.toThrow('无法发送豆包匿名');
        expect(fetch).toHaveBeenCalledOnce();
        expect(readDoubaoGuestRequest('not a URL', 'GET', new Headers())).toBeUndefined();
    });

    it.each([
        ['https://evil.test/samantha/plugin/stream_article_translate', 'POST', 'valid'],
        ['https://www.doubao.com.evil.test/samantha/plugin/stream_article_translate', 'POST', 'valid'],
        ['https://www.doubao.com/samantha/plugin/other', 'POST', 'valid'],
        [url, 'GET', 'valid'], [url, 'POST', ''], [url, 'POST', 'x;y=z'],
        [url, 'POST', 'a'.repeat(4097)], [url + '#fragment', 'POST', 'valid'],
        [url.replace('www.doubao.com', 'user:password@www.doubao.com'), 'POST', 'valid'],
        [url + '&padding=' + 'a'.repeat(1500), 'POST', 'valid'], ['broken', 'POST', 'valid'],
    ])('非法目标、方法或凭据不发请求 %#', async (target, method, token) => {
        const fetch = vi.fn();
        await expect(createDoubaoGuestFetch(port(), 'own', fetch)(target, {method, headers: {[DOUBAO_GUEST_HEADER]: token}})).rejects.toThrow('无法发送豆包匿名');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('只设置单一匿名 Cookie，精确 URL/POST/扩展 initiator 限定，并立即清理', async () => {
        const api = port();
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        await createDoubaoGuestFetch(api, 'own', fetch)(new URL(url), init);
        expect(api.updateSessionRules.mock.calls[0][0]).toEqual({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []});
        const rule = api.updateSessionRules.mock.calls[1][0].addRules[0];
        expect(rule.condition).toMatchObject({initiatorDomains: ['own'], requestMethods: ['post'], resourceTypes: ['xmlhttprequest'], isUrlFilterCaseSensitive: true});
        const pattern = new RegExp(rule.condition.regexFilter);
        expect(pattern.test(url)).toBe(true);
        expect(pattern.test(url + '&more=1')).toBe(false);
        expect(rule.action.requestHeaders).toEqual([
            {header: 'Cookie', operation: 'set', value: 'ttwid=anonymous-test-token'},
            {header: 'Origin', operation: 'set', value: 'https://www.doubao.com'},
            {header: 'Referer', operation: 'set', value: 'https://www.doubao.com/'},
        ]);
        const sent = fetch.mock.calls[0][1];
        expect(sent).toMatchObject({credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', body: '{}'});
        for (const header of [DOUBAO_GUEST_HEADER, 'Cookie', 'Authorization']) expect(sent.headers.has(header)).toBe(false);
        expect(api.updateSessionRules).toHaveBeenLastCalledWith({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []});
    });

    it('Request 输入保留方法与取消信号，init 可以覆盖请求头', async () => {
        const api = port();
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        const request = new Request(url, init);
        await createDoubaoGuestFetch(api, 'own', fetch)(request);
        expect(fetch.mock.calls[0][0]).toBe(request);
        expect(fetch.mock.calls[0][1].headers.has(DOUBAO_GUEST_HEADER)).toBe(false);
    });

    it('安装失败不会出站，不泄露浏览器错误；后续相同请求可重试', async () => {
        const api = port();
        api.updateSessionRules.mockRejectedValueOnce(new Error('private startup')).mockRejectedValueOnce(new Error('private install'));
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        const transport = createDoubaoGuestFetch(api, 'own', fetch);
        await expect(transport(url, init)).rejects.toThrow('无法发送豆包匿名');
        expect(fetch).not.toHaveBeenCalled();
        await transport(url, init);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('请求失败仍清理；清理失败给出安全错误且下一请求原子替换旧规则', async () => {
        const api = port();
        const fetch = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(new Response('ok'));
        const transport = createDoubaoGuestFetch(api, 'own', fetch);
        await expect(transport(url, init)).rejects.toThrow('network');
        expect(api.updateSessionRules).toHaveBeenLastCalledWith({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []});
        api.updateSessionRules.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private cleanup'));
        await expect(transport(url, init)).rejects.toThrow('无法发送豆包匿名');
        await transport(url, init);
        expect(api.updateSessionRules.mock.calls[5][0]).toMatchObject({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: [expect.anything()]});
    });

    it('取消发生在入场前或规则安装后均不发出网络请求，并保留原因', async () => {
        const fetch = vi.fn();
        const before = new AbortController(); const reason = new Error('cancel'); before.abort(reason);
        await expect(createDoubaoGuestFetch(port(), 'own', fetch)(url, {...init, signal: before.signal})).rejects.toBe(reason);
        const during = new AbortController();
        const api = port();
        api.updateSessionRules.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {during.abort();});
        await expect(createDoubaoGuestFetch(api, 'own', fetch)(url, {...init, signal: during.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(fetch).not.toHaveBeenCalled();
        expect(api.updateSessionRules).toHaveBeenLastCalledWith({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []});
    });

    it('并发访客请求串行使用规则，其他服务不会被等待挡住', async () => {
        let release!: (response: Response) => void;
        const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {release = resolve;})).mockResolvedValue(new Response('ok'));
        const api = port(); const transport = createDoubaoGuestFetch(api, 'own', fetch);
        const first = transport(url, init); const second = transport(url + '&next=1', init);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        await transport('https://other.test/');
        expect(fetch).toHaveBeenCalledTimes(2);
        release(new Response('first'));
        await Promise.all([first, second]);
        expect(fetch.mock.calls[2][0]).toContain('&next=1');
    });

    it('等待前一个请求时取消立即结算，之后也不会安装或发出已取消请求', async () => {
        let release!: (response: Response) => void;
        const fetch = vi.fn().mockImplementation(() => new Promise<Response>(resolve => {release = resolve;}));
        const api = port(); const transport = createDoubaoGuestFetch(api, 'own', fetch);
        const first = transport(url, init);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        const controller = new AbortController(); const reason = new Error('cancel queued');
        const queued = transport(url + '&next=1', {...init, signal: controller.signal});
        controller.abort(reason);
        await expect(queued).rejects.toBe(reason);
        expect(fetch).toHaveBeenCalledOnce();
        release(new Response('ok'));
        await first;
        await Promise.resolve();
        expect(fetch).toHaveBeenCalledOnce();
        expect(api.updateSessionRules.mock.calls.flatMap(([operation]) => operation.addRules)).toHaveLength(1);
    });

    it('清理规则失败时关闭未消费响应，调用方取消仍保留原始原因', async () => {
        const api = port();
        api.updateSessionRules.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup'));
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const response = new Response(new ReadableStream({cancel}));
        await expect(createDoubaoGuestFetch(api, 'own', async () => response)(url, init)).rejects.toThrow('无法发送豆包匿名');
        expect(cancel).toHaveBeenCalledOnce();

        const failing = port(); const controller = new AbortController(); const reason = new Error('cancel active');
        failing.updateSessionRules.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup'));
        await expect(createDoubaoGuestFetch(failing, 'own', async () => {controller.abort(reason); throw reason;})(url, {...init, signal: controller.signal})).rejects.toBe(reason);

        const noBody = port();
        noBody.updateSessionRules.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup'));
        await expect(createDoubaoGuestFetch(noBody, 'own', async () => new Response(null))(url, init)).rejects.toThrow('无法发送豆包匿名');

        const brokenBody = port();
        brokenBody.updateSessionRules.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup'));
        await expect(createDoubaoGuestFetch(brokenBody, 'own', async () => ({body: {cancel: async () => {throw new Error('cancel failed');}}} as unknown as Response))(url, init)).rejects.toThrow('无法发送豆包匿名');
    });
});
