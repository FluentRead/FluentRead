/**
 * @file tests/requestHeaderRules.test.ts
 * 文件职责：验证 issue #763 的域名边界与 DNR 生命周期，保证请求头规则不会作用于宿主网页或扩大目标范围。
 * 主要内容：精确域名、默认关闭、输入拒绝、旧规则清理、独立开关、串行更新、失败重试与配置迁移。
 * 模块边界：只使用纯配置和模拟浏览器端口；真实网络行为由隔离扩展 UI 专项验证。
 */
import {describe, expect, it, vi} from 'vitest';
import {normalizeRequestHeaderDomain, normalizeRequestHeaderRules} from '@/src/core/config/requestHeaders';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {createRequestHeaderRulesSynchronizer, REQUEST_HEADER_RULE_START} from '@/src/platform/browser/requestHeaderRules';

const origin = {domain: 'api.example.com', removeOrigin: true, removeReferer: false};
const referer = {domain: 'other.example.com', removeOrigin: false, removeReferer: true};
function api() {
    return {getDynamicRules: vi.fn().mockResolvedValue([]), updateDynamicRules: vi.fn().mockResolvedValue(undefined)};
}

describe('按域名请求头移除名单', () => {
    it('接受精确域名和本地服务，拒绝 URL、通配符、路径、凭据与端口', () => {
        for (const domain of ['api.example.com', 'localhost', '127.0.0.1', '[::1]']) expect(normalizeRequestHeaderDomain(domain)).toBe(domain);
        expect(normalizeRequestHeaderDomain(' API.EXAMPLE.COM ')).toBe('api.example.com');
        expect(normalizeRequestHeaderDomain('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d');
        for (const value of [Array(6).fill('é'.repeat(40)).join('.'), null, 42, '', 'x'.repeat(254), 'https://api.example.com', 'api.example.com:443',
            '例子.测试:443', 'api.example.com/path', '*.example.com', 'user@example.com', 'api.example.com?x',
            'api.example.com#x', 'api.example.com%2f', 'api.example.com\\path', 'api. example.com', '[:::]',
            '127.1', 'api..example.com', '-bad.example', 'api.example.com.', 'a'.repeat(64)+'.example']) {
            expect(normalizeRequestHeaderDomain(value), String(value)).toBeNull();
        }
    });

    it('默认空名单，归一化去重且独立保存关闭的开关，限制导入规模', () => {
        expect(new Config().requestHeaderRules).toEqual([]);
        expect(normalizeRequestHeaderRules(null)).toEqual([]);
        expect(normalizeRequestHeaderRules([null, 'invalid', {}, {domain: '*.example.com'}, origin,
            {...origin, domain: 'API.EXAMPLE.COM', removeOrigin: false, removeReferer: true},
            {domain: 'disabled.example', removeOrigin: 'true', removeReferer: 1}])).toEqual([
                {...origin, removeReferer: true}, {domain: 'disabled.example', removeOrigin: false, removeReferer: false},
            ]);
        expect(normalizeRequestHeaderRules([{...referer}, {...referer, removeReferer: false}])).toEqual([referer]);
        expect(normalizeRequestHeaderRules(Array.from({length: 110}, (_, i) => ({...origin, domain: `api${i}.example.com`})))).toHaveLength(100);
        expect(normalizeConfig({requestHeaderRules: [origin]}).requestHeaderRules).toEqual([origin]);
        const config = normalizeConfig(new Config());
        config.requestHeaderRules = [origin];
        const exported = prepareConfigForExport(config);
        expect(prepareConfigForImport(exported, new Config()).requestHeaderRules).toEqual([origin]);
        expect(normalizeConfig({}).requestHeaderRules).toEqual([]);
    });

    it('规则只修改本扩展对精确域名的 XHR，分别移除所选头，保留其他规则', async () => {
        const port = api();
        port.getDynamicRules.mockResolvedValue([{id: 1}, {id: 2_001_460}, {id: REQUEST_HEADER_RULE_START + 99}, {id: REQUEST_HEADER_RULE_START + 101}]);
        const sync = createRequestHeaderRulesSynchronizer(port, 'own-extension-id');
        await sync.sync([origin, referer, {domain: 'disabled.example', removeOrigin: false, removeReferer: false}]);
        const update = port.updateDynamicRules.mock.calls[0][0];
        expect(update.removeRuleIds).toEqual([REQUEST_HEADER_RULE_START + 99]);
        expect(update.addRules).toHaveLength(2);
        expect(update.addRules[0]).toMatchObject({id: REQUEST_HEADER_RULE_START, priority: 2,
            action: {type: 'modifyHeaders', requestHeaders: [{header: 'Origin', operation: 'remove'}]},
            condition: {initiatorDomains: ['own-extension-id'], resourceTypes: ['xmlhttprequest']}});
        expect(update.addRules[1].action.requestHeaders).toEqual([{header: 'Referer', operation: 'remove'}]);
        const pattern = new RegExp(update.addRules[0].condition.regexFilter);
        for (const url of ['https://api.example.com/v1/chat', 'http://api.example.com:1234/']) expect(pattern.test(url)).toBe(true);
        for (const url of ['https://sub.api.example.com/', 'https://api.example.com.evil/', 'https://apiXexampleYcom/',
            'https://evil/?next=https://api.example.com/', 'https://api.example.com@evil/']) expect(pattern.test(url)).toBe(false);
        await sync.sync([origin, referer, {domain: 'disabled.example', removeOrigin: false, removeReferer: false}]);
        expect(port.getDynamicRules).toHaveBeenCalledOnce();
        expect(port.updateDynamicRules).toHaveBeenCalledOnce();
    });

    it('重启时清理过期规则，删除或关闭两项开关后恢复默认行为', async () => {
        const port = api();
        port.getDynamicRules.mockResolvedValue([{id: REQUEST_HEADER_RULE_START}]);
        const sync = createRequestHeaderRulesSynchronizer(port, 'own');
        await sync.sync([]);
        expect(port.updateDynamicRules).toHaveBeenLastCalledWith({removeRuleIds: [REQUEST_HEADER_RULE_START], addRules: []});
        await sync.sync([{...origin, removeReferer: true}]);
        expect(port.updateDynamicRules.mock.calls[1][0].addRules[0].action.requestHeaders).toHaveLength(2);
        await sync.sync([{...origin, removeOrigin: false}]);
        expect(port.updateDynamicRules).toHaveBeenLastCalledWith({removeRuleIds: [REQUEST_HEADER_RULE_START], addRules: []});
        const empty = api();
        await createRequestHeaderRulesSynchronizer(empty, 'own').sync([]);
        expect(empty.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('不支持 API 时空名单可继续工作，启用名单给出明确错误', async () => {
        const sync = createRequestHeaderRulesSynchronizer(undefined, 'own');
        await sync.sync([]);
        await sync.sync([]);
        await expect(sync.sync([origin])).rejects.toThrow('不支持网络层移除');
    });

    it('并发修改串行安装，失败后允许相同名单重试，不留下旧配置', async () => {
        const port = api();
        let release!: () => void;
        port.updateDynamicRules.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
        const sync = createRequestHeaderRulesSynchronizer(port, 'own');
        const first = sync.sync([origin]);
        const second = sync.sync([referer]);
        await vi.waitFor(() => expect(port.updateDynamicRules).toHaveBeenCalledOnce());
        release();
        await Promise.all([first, second]);
        expect(port.updateDynamicRules.mock.calls[1][0].addRules[0].action.requestHeaders[0].header).toBe('Referer');
        port.updateDynamicRules.mockRejectedValueOnce(new Error('permission unavailable'));
        await expect(sync.sync([origin])).rejects.toThrow('permission unavailable');
        await sync.sync([origin]);
        expect(port.updateDynamicRules).toHaveBeenCalledTimes(4);
        port.getDynamicRules.mockRejectedValueOnce(new Error('read failed'));
        await expect(sync.sync([])).rejects.toThrow('read failed');
        await sync.sync([]);
    });
});

it('内置 B站规则不挤掉用户的一百项配置，并清理额外规则编号', async () => {
    const port = api();
    port.getDynamicRules.mockResolvedValue([{id: REQUEST_HEADER_RULE_START + 100}]);
    const entries = [{domain: 'index-translate.bilibili.com', removeOrigin: true, removeReferer: false},
        ...Array.from({length: 100}, (_, i) => ({domain: `user-${i}.example`, removeOrigin: false, removeReferer: true}))];
    await createRequestHeaderRulesSynchronizer(port, 'own').sync(entries);
    const update = port.updateDynamicRules.mock.calls[0][0];
    expect(update.addRules).toHaveLength(101);
    expect(update.addRules[100].condition.regexFilter).toContain('user-99');
    expect(update.removeRuleIds).toEqual([REQUEST_HEADER_RULE_START + 100]);
});
