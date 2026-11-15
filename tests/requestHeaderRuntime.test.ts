/**
 * @file tests/requestHeaderRuntime.test.ts
 * 文件职责：验证后台 HTTP 请求等待配置水合与 DNR 同步，覆盖启用、删除和失败重试。
 * 主要内容：注入模拟配置及浏览器，实际调用共享 runtimeFetch，断言规则安装失败时没有发出 HTTP 请求。
 * 模块边界：不启动真实浏览器，不修改真实配置或请求头；网络层移除由浏览器专项确认。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({
    config: {requestHeaderRules: [] as Array<{domain: string; removeOrigin: boolean; removeReferer: boolean}>},
    subscribe: vi.fn(),
}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, configReady: Promise.resolve(), subscribeConfig: mocks.subscribe}));
import {installRequestHeaderRuntime} from '@/src/app/background/requestHeaderRuntime';
import {runtimeFetch, setRuntimeFetch} from '@/src/platform/http/runtime';
import {DOUBAO_GUEST_HEADER} from '@/src/platform/http/doubaoGuest';
afterEach(() => {setRuntimeFetch(); vi.unstubAllGlobals(); vi.restoreAllMocks(); mocks.subscribe.mockReset();});

describe('后台请求头同步屏障', () => {
    it('用真实扩展 origin 的 hostname 安装规则，网络等待安装；配置更新与删除后立即同步', async () => {
        mocks.config.requestHeaderRules = [{domain: 'api.example.com', removeOrigin: true, removeReferer: false}];
        let release!: () => void;
        const api = {getDynamicRules: vi.fn().mockResolvedValue([]), updateDynamicRules: vi.fn()
            .mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;})).mockResolvedValue(undefined)};
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://own-uuid/'}, declarativeNetRequest: api});
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        vi.stubGlobal('fetch', fetch);
        installRequestHeaderRuntime();
        await Promise.resolve();
        const request = runtimeFetch('https://api.example.com/v1', {method: 'POST'});
        await vi.waitFor(() => expect(api.updateDynamicRules).toHaveBeenCalledOnce());
        expect(fetch).not.toHaveBeenCalled();
        expect(api.updateDynamicRules.mock.calls[0][0].addRules[0].condition.initiatorDomains).toEqual(['own-uuid']);
        expect(api.updateDynamicRules.mock.calls[0][0].addRules).toHaveLength(2);
        release();
        await request;
        expect(fetch).toHaveBeenCalledWith('https://api.example.com/v1', {method: 'POST'});
        mocks.config.requestHeaderRules = [];
        api.getDynamicRules.mockResolvedValue([{id: 2_763_000}]);
        mocks.subscribe.mock.calls[0][0]();
        await runtimeFetch('https://api.example.com/v1');
        expect(api.updateDynamicRules).toHaveBeenLastCalledWith({removeRuleIds: [2_763_000], addRules: [expect.objectContaining({condition: expect.objectContaining({regexFilter: '^https?://index-translate\\.bilibili\\.com(?::[0-9]+)?/'})})]});
    });

    it('安装失败时阻止网络并重试；后台订阅的失败只输出固定诊断', async () => {
        mocks.config.requestHeaderRules = [{domain: 'api.example.com', removeOrigin: true, removeReferer: true}];
        const api = {getDynamicRules: vi.fn().mockResolvedValue([]), updateDynamicRules: vi.fn().mockRejectedValue(new Error('install failed'))};
        vi.stubGlobal('browser', {runtime: {getURL: () => 'chrome-extension://own/'}, declarativeNetRequest: api});
        const fetch = vi.fn().mockResolvedValue(new Response('ok'));
        vi.stubGlobal('fetch', fetch);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        installRequestHeaderRuntime();
        await Promise.resolve();
        mocks.subscribe.mock.calls[0][0]();
        await expect(runtimeFetch('https://api.example.com/')).rejects.toThrow('install failed');
        expect(fetch).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[FluentRead] 请求头规则更新失败；下次请求将重试。');
        api.updateDynamicRules.mockResolvedValue(undefined);
        await runtimeFetch('https://api.example.com/');
        expect(fetch).toHaveBeenCalledOnce();
    });
});

it('Safari 26 的动态规则和豆包会话规则保留扩展发起方及 POST 隔离条件', async () => {
    mocks.config.requestHeaderRules = [{domain: 'api.example.com', removeOrigin: true, removeReferer: true}];
    const api = {
        getDynamicRules: vi.fn().mockResolvedValue([]),
        updateDynamicRules: vi.fn().mockResolvedValue(undefined),
        updateSessionRules: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('browser', {runtime: {getURL: () => 'safari-web-extension://own-uuid/'}, declarativeNetRequest: api});
    const fetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    installRequestHeaderRuntime();
    const url = 'https://www.doubao.com/samantha/plugin/stream_article_translate?fixture=1';
    await runtimeFetch(url, {method: 'POST', headers: {[DOUBAO_GUEST_HEADER]: 'fixture-token'}});
    const dynamicRules = api.updateDynamicRules.mock.calls[0][0].addRules;
    expect(dynamicRules).toHaveLength(2);
    for (const rule of dynamicRules) expect(rule.condition.initiatorDomains).toEqual(['own-uuid']);
    const sessionRule = api.updateSessionRules.mock.calls[1][0].addRules[0];
    expect(sessionRule.condition).toMatchObject({initiatorDomains: ['own-uuid'], requestMethods: ['post'], resourceTypes: ['xmlhttprequest']});
    expect(new RegExp(sessionRule.condition.regexFilter).test(url)).toBe(true);
    expect(new RegExp(sessionRule.condition.regexFilter).test(`${url}&other=1`)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0][1].headers).has(DOUBAO_GUEST_HEADER)).toBe(false);
    expect(api.updateSessionRules).toHaveBeenLastCalledWith({removeRuleIds: [sessionRule.id], addRules: []});
});

it('缺少 DNR 的运行环境不影响其他服务', async () => {
    mocks.config.requestHeaderRules = [];
    vi.stubGlobal('browser', {runtime: {getURL: () => 'chrome-extension://own/'}});
    const fetch = vi.fn().mockResolvedValue(new Response('ok')); vi.stubGlobal('fetch', fetch);
    installRequestHeaderRuntime();
    await runtimeFetch('https://other.example/');
    expect(fetch).toHaveBeenCalledOnce();
});
