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
// 能力矩阵在模块加载时求值，用可变对象模拟宿主浏览器，覆盖 Safari 与 Chromium 两种规则条件。
const caps = vi.hoisted(() => ({browser: 'firefox'}));
vi.mock('@/src/platform/browser/capabilities', () => ({
    browserCapabilities: {get browser() { return caps.browser; }},
}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, configReady: Promise.resolve(), subscribeConfig: mocks.subscribe}));
import {installRequestHeaderRuntime} from '@/src/app/background/requestHeaderRuntime';
import {runtimeFetch, setRuntimeFetch} from '@/src/platform/http/runtime';
afterEach(() => {setRuntimeFetch(); vi.unstubAllGlobals(); vi.restoreAllMocks(); mocks.subscribe.mockReset(); caps.browser = 'firefox';});

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

it('Safari 宿主下省略 initiatorDomains，规则仍按精确域名安装', async () => {
    caps.browser = 'safari';
    mocks.config.requestHeaderRules = [{domain: 'api.example.com', removeOrigin: true, removeReferer: false}];
    const api = {getDynamicRules: vi.fn().mockResolvedValue([]), updateDynamicRules: vi.fn().mockResolvedValue(undefined)};
    vi.stubGlobal('browser', {runtime: {getURL: () => 'safari-web-extension://own-uuid/'}, declarativeNetRequest: api});
    const fetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    installRequestHeaderRuntime();
    await Promise.resolve();
    await runtimeFetch('https://api.example.com/v1');
    const addRules = api.updateDynamicRules.mock.calls[0][0].addRules;
    expect(addRules).toHaveLength(2);
    for (const rule of addRules) {
        expect(rule.condition).not.toHaveProperty('initiatorDomains');
        expect(rule.condition).toMatchObject({resourceTypes: ['xmlhttprequest']});
    }
    expect(fetch).toHaveBeenCalledOnce();
});

it('缺少 DNR 的运行环境不影响其他服务', async () => {
    mocks.config.requestHeaderRules = [];
    vi.stubGlobal('browser', {runtime: {getURL: () => 'chrome-extension://own/'}});
    const fetch = vi.fn().mockResolvedValue(new Response('ok')); vi.stubGlobal('fetch', fetch);
    installRequestHeaderRuntime();
    await runtimeFetch('https://other.example/');
    expect(fetch).toHaveBeenCalledOnce();
});
