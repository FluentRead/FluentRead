/**
 * @file tests/freeProviderPermissions.test.ts
 * 文件职责：验证 Safari 免费池精确域授权端口及同步用户手势入口。
 * 主要内容：覆盖十六个 provider 的域范围、退役节点过滤、完整多域授权、拒绝与撤权、API 缺失或失败、非 Safari 旁路和请求顺序。
 * 模块边界：仅替换浏览器权限 API，不发起网络请求、不修改任何真实浏览器权限。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, FREE_TRANSLATION_PROVIDERS, type FreeTranslationProviderId} from '@/src/core/config/freeTranslation';
import {FREE_PROVIDER_ORIGINS} from '@/src/core/config/freeProviderOrigins';
import {FREE_PROVIDER_PERMISSION_QUERY_TIMEOUT_MS, isFreeProviderAllowed, readFreePoolAccess, requestFreeProviderAccess, requireFreeProviderAccess, subscribeFreeProviderAccessChanges} from '@/src/platform/browser/freeProviderPermissions';
import {serializeTranslationError, unwrapTranslationResponse} from '@/src/services/translation/errors';

afterEach(() => {vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();});
const unavailable = {code: 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE', retryable: false};
const required = {code: 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED', retryable: false};
function safari(permissions: unknown): void {
    vi.stubEnv('BROWSER', 'safari');
    vi.stubGlobal('browser', {permissions});
}

describe('Safari 免费池授权端口', () => {
    it('目录完整且只列当前匿名请求的二十个精确 HTTPS 主机，含 bootstrap 和内部备用域', () => {
        expect(Object.keys(FREE_PROVIDER_ORIGINS).sort()).toEqual(FREE_TRANSLATION_PROVIDERS.map(item => item.id).sort());
        const origins = Object.values(FREE_PROVIDER_ORIGINS).flat();
        expect(new Set(origins).size).toBe(20);
        expect(FREE_PROVIDER_ORIGINS).not.toHaveProperty('sogouFree');
        expect(origins.every(origin => /^https:\/\/[a-z0-9.-]+\/\*$/u.test(origin))).toBe(true);
        expect(FREE_PROVIDER_ORIGINS.microsoft).toEqual(['https://edge.microsoft.com/*']);
        expect(FREE_PROVIDER_ORIGINS.google).toEqual(['https://translate.google.com/*', 'https://translate.google.co.uk/*',
            'https://translate-pa.googleapis.com/*', 'https://translate.googleapis.com/*']);
        expect(FREE_PROVIDER_ORIGINS.lingvanexFree).toEqual(['https://lingvanex.com/*', 'https://api-b2b.backenster.com/*']);
        expect(FREE_PROVIDER_ORIGINS.doubaoWeb).toEqual(['https://www.doubao.com/*']);
        expect(Object.isFrozen(FREE_PROVIDER_ORIGINS)).toBe(true);
        expect(Object.values(FREE_PROVIDER_ORIGINS).every(Object.isFrozen)).toBe(true);
    });

    it('provider 源码新增静态请求域时目录合约会发现差异，不遗漏 bootstrap 或备用域', () => {
        const groups: [string, FreeTranslationProviderId[]][] = [
            ['microsoftTransport', ['microsoft']], ['google', ['google']], ['doubao-web', ['doubaoWeb']],
            ['free-web', ['transmart', 'yandexFree', 'volcengineFree']], ['free-chinese-web', ['youdaoFree', 'icibaFree']],
            ['mymemory', ['myMemory']], ['free-extra-web', ['reversoFree', 'apertiumFree']],
            ['free-official-web', ['alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree']],
        ];
        for (const [file, ids] of groups) {
            const source = readFileSync(resolve(__dirname, `../src/providers/translation/${file}.ts`), 'utf8');
            const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)\//gu)].map(match => match[1]);
            const actual = [...new Set(hosts)].sort();
            const expected = [...new Set(ids.flatMap(id => FREE_PROVIDER_ORIGINS[id].map(origin => new URL(origin).hostname)))].sort();
            expect(actual, file).toEqual(expected);
        }
        expect(FREE_PROVIDER_ORIGINS.bilibiliFree).toEqual([`https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/*`]);
    });

    it.each(['chrome', 'edge', 'firefox', 'userscript', 'unknown'])('%s 不调用任何权限 API，不改变候选顺序', async target => {
        vi.stubEnv('BROWSER', target);
        const contains = vi.fn(); const request = vi.fn();
        vi.stubGlobal('browser', {permissions: {contains, request}});
        const access = await readFreePoolAccess(['sogouFree', 'google', 'unknown', 'microsoft', 'google']);
        expect(access).toEqual({supported: false, grantedIds: ['google', 'microsoft'], preferredGrant: null});
        expect(isFreeProviderAllowed(access, 'alibabaFree')).toBe(true);
        expect(() => requireFreeProviderAccess(access)).not.toThrow();
        expect(() => requireFreeProviderAccess(access, 'alibabaFree')).not.toThrow();
        await expect(requestFreeProviderAccess('google')).resolves.toBe(true);
        expect(contains).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });

    it('按完整 origin 集查询，保持输入不变、去重并首选第一个缺授权候选', async () => {
        const contains = vi.fn(async ({origins}: {origins: string[]}) => origins[0] === 'https://edge.microsoft.com/*');
        safari({contains});
        const order = Object.freeze(['sogouFree', 'google', 'microsoft', 'google', 'lingvanexFree', 'invalid']);
        const access = await readFreePoolAccess(order);
        expect(access).toEqual({supported: true, grantedIds: ['microsoft'], preferredGrant: {id: 'google', origins: FREE_PROVIDER_ORIGINS.google}});
        expect(contains.mock.calls.map(([arg]) => arg.origins)).toEqual([
            [...FREE_PROVIDER_ORIGINS.google], [...FREE_PROVIDER_ORIGINS.microsoft], [...FREE_PROVIDER_ORIGINS.lingvanexFree],
        ]);
        expect(order).toEqual(['sogouFree', 'google', 'microsoft', 'google', 'lingvanexFree', 'invalid']);
        expect(isFreeProviderAllowed(access, 'microsoft')).toBe(true);
        expect(isFreeProviderAllowed(access, 'google')).toBe(false);
        expect(() => requireFreeProviderAccess(access)).not.toThrow();
        expect(() => requireFreeProviderAccess(access, 'microsoft')).not.toThrow();
        expect(() => requireFreeProviderAccess(access, 'google')).toThrowError(expect.objectContaining(required));
    });

    it.each(['google', 'lingvanexFree'] as const)('%s 部分域授权不足以开放候选', async id => {
        const grant = new Set(FREE_PROVIDER_ORIGINS[id].slice(1));
        safari({contains: vi.fn(async ({origins}: {origins: string[]}) => origins.every(origin => grant.has(origin)))});
        const access = await readFreePoolAccess([id]);
        expect(access.grantedIds).toEqual([]);
        expect(access.preferredGrant).toEqual({id, origins: FREE_PROVIDER_ORIGINS[id]});
        expect(() => requireFreeProviderAccess(access)).toThrowError(expect.objectContaining(required));
    });

    it('全部已授权和空目录均没有额外授权建议，空目录不会恢复为全部服务', async () => {
        const contains = vi.fn(async () => true);
        safari({contains});
        expect(await readFreePoolAccess(['microsoft', 'google'])).toEqual({supported: true, grantedIds: ['microsoft', 'google'], preferredGrant: null});
        contains.mockClear();
        const empty = await readFreePoolAccess([]);
        expect(empty).toEqual({supported: true, grantedIds: [], preferredGrant: null});
        expect(contains).not.toHaveBeenCalled();
        expect(() => requireFreeProviderAccess(empty)).toThrowError(expect.objectContaining(required));
    });

    it('每次重新查询，先前成功或一天授权不在撤权后复用', async () => {
        const contains = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        safari({contains});
        expect((await readFreePoolAccess(['microsoft'])).grantedIds).toEqual(['microsoft']);
        expect((await readFreePoolAccess(['microsoft'])).grantedIds).toEqual([]);
        expect(contains).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, {}, {request: vi.fn()}])('Safari 查询 API 缺失时明确拒绝：%s', async permissions => {
        safari(permissions);
        await expect(readFreePoolAccess(['microsoft'])).rejects.toMatchObject(unavailable);
    });

    it('Safari 无 browser 全局时查询和同步授权均明确拒绝', async () => {
        vi.stubEnv('BROWSER', 'safari'); vi.stubGlobal('browser', undefined);
        await expect(readFreePoolAccess(['microsoft'])).rejects.toMatchObject(unavailable);
        expect(() => requestFreeProviderAccess('microsoft')).toThrowError(expect.objectContaining(unavailable));
    });

    it.each([undefined, {}, {contains: vi.fn()}])('Safari 授权 API 缺失时不静默通过：%s', permissions => {
        safari(permissions);
        expect(() => requestFreeProviderAccess('google')).toThrowError(expect.objectContaining(unavailable));
    });

    it('查询任一域失败不会返回部分可用池或泄漏原始错误', async () => {
        safari({contains: vi.fn(({origins}: {origins: string[]}) => origins[0].includes('google')
            ? Promise.reject(new Error('private transport detail')) : Promise.resolve(true))});
        await expect(readFreePoolAccess(['microsoft', 'google'])).rejects.toMatchObject({...unavailable, message: expect.not.stringContaining('private')});
    });

    it('同步抛出的查询 API 错误同样明确拒绝，并清除计时器与监听', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        safari({contains() {throw new Error('private synchronous failure');}});
        await expect(readFreePoolAccess(['microsoft'], {signal: controller.signal})).rejects.toMatchObject(unavailable);
        expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledOnce();
    });

    it('前项异步拒绝与后项同步异常并存时也消费每个查询的结算', async () => {
        const contains = vi.fn().mockRejectedValueOnce(new Error('first rejection')).mockImplementationOnce(() => {throw new Error('second synchronous failure');});
        safari({contains});
        await expect(readFreePoolAccess(['google', 'microsoft'])).rejects.toMatchObject(unavailable);
        expect(contains).toHaveBeenCalledTimes(2);
    });

    it.each(['resolve', 'reject'] as const)('UI 无调用方选项时两秒结束悬挂查询，晚 %s 被消费', async late => {
        vi.useFakeTimers();
        let resolve!: (allowed: boolean) => void; let reject!: (reason: unknown) => void;
        const raw = new Promise<boolean>((done, fail) => {resolve = done; reject = fail;});
        safari({contains: vi.fn(() => raw)});
        const assertion = expect(readFreePoolAccess(['microsoft'])).rejects.toMatchObject(unavailable);
        await vi.advanceTimersByTimeAsync(FREE_PROVIDER_PERMISSION_QUERY_TIMEOUT_MS);
        await assertion;
        expect(vi.getTimerCount()).toBe(0);
        if (late === 'resolve') resolve(true); else reject(new Error('late query failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('较早的绝对截止时间不会被重置为两秒', async () => {
        vi.useFakeTimers();
        safari({contains: vi.fn(() => new Promise(() => {}))});
        let settled = false;
        const assertion = expect(readFreePoolAccess(['microsoft'], {deadline: Date.now() + 37}).finally(() => {settled = true;}))
            .rejects.toMatchObject(unavailable);
        await vi.advanceTimersByTimeAsync(36); expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1); await assertion;
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, -1, Number.NaN])('耗尽或无效的截止预算不启动查询：%s', async remaining => {
        vi.useFakeTimers();
        const contains = vi.fn(); safari({contains});
        await expect(readFreePoolAccess(['microsoft'], {deadline: Date.now() + remaining})).rejects.toMatchObject(unavailable);
        expect(contains).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it.each([new Error('closed'), 'closed by caller'])('已取消查询保留 caller reason 且不调用 API：%s', async reason => {
        vi.useFakeTimers();
        const contains = vi.fn(); safari({contains});
        const controller = new AbortController(); controller.abort(reason);
        await expect(readFreePoolAccess(['microsoft'], {signal: controller.signal})).rejects.toBe(reason);
        expect(contains).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['resolve', 'reject'] as const)('悬挂时取消立即结束并清理，晚 %s 不改变结果', async late => {
        vi.useFakeTimers();
        let resolve!: (allowed: boolean) => void; let reject!: (reason: unknown) => void;
        const raw = new Promise<boolean>((done, fail) => {resolve = done; reject = fail;});
        safari({contains: vi.fn(() => raw)});
        const controller = new AbortController(); const reason = new Error('caller closed');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const assertion = expect(readFreePoolAccess(['microsoft'], {signal: controller.signal})).rejects.toBe(reason);
        expect(vi.getTimerCount()).toBe(1);
        controller.abort(reason); await assertion;
        expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledOnce();
        if (late === 'resolve') resolve(true); else reject(new Error('late query failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledOnce();
    });

    it('查询成功立即移除超时和取消监听；非 Safari 忽略查询边界且不装监听', async () => {
        vi.useFakeTimers();
        const contains = vi.fn(async () => true); safari({contains});
        const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
        expect((await readFreePoolAccess(['microsoft'], {signal: controller.signal, deadline: Date.now() + 10_000})).grantedIds).toEqual(['microsoft']);
        expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledOnce();
        vi.stubEnv('BROWSER', 'firefox'); contains.mockClear(); remove.mockClear(); controller.abort();
        expect((await readFreePoolAccess(['microsoft'], {signal: controller.signal, deadline: 0})).supported).toBe(false);
        expect(contains).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('点击同步直接发起一个服务完整域请求并原样返回 promise：授权=%s', async granted => {
        const result = Promise.resolve(granted);
        const request = vi.fn(() => result); const contains = vi.fn();
        safari({request, contains});
        const pending = requestFreeProviderAccess('google');
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith({origins: [...FREE_PROVIDER_ORIGINS.google]});
        expect(contains).not.toHaveBeenCalled();
        expect(pending).toBe(result);
        await expect(pending).resolves.toBe(granted);
    });

    it('不吞掉原生授权拒绝，非法 provider 在同步边界拒绝', async () => {
        const error = new Error('user gesture required');
        safari({request: vi.fn(() => Promise.reject(error))});
        await expect(requestFreeProviderAccess('microsoft')).rejects.toBe(error);
        expect(() => requestFreeProviderAccess('unknown' as FreeTranslationProviderId)).toThrow('无效的免费翻译服务');
        expect(() => requestFreeProviderAccess('sogouFree' as FreeTranslationProviderId)).toThrow('无效的免费翻译服务');
    });

    it('未授权错误通过现有翻译消息序列化保留独立 code 和不可重试语义', async () => {
        safari({contains: vi.fn(async () => false)});
        const access = await readFreePoolAccess(['microsoft']);
        let error: unknown;
        try {requireFreeProviderAccess(access);} catch (caught) {error = caught;}
        const serialized = serializeTranslationError(error);
        expect(serialized).toMatchObject({...required, kind: 'bad-request'});
        expect(() => unwrapTranslationResponse(serialized)).toThrowError(expect.objectContaining(required));
    });
});


describe('Safari 域权限事件生命周期', () => {
    function eventPort() {
        const listeners = new Set<(details: {origins?: string[]}) => void>();
        return {listeners, addListener: vi.fn((callback: (details: {origins?: string[]}) => void) => listeners.add(callback)),
            removeListener: vi.fn((callback: (details: {origins?: string[]}) => void) => listeners.delete(callback)),
            emit(details: {origins?: string[]}) {for (const callback of listeners) callback(details);}};
    }
    it('只转发域变化，清理两类监听且迟到原回调不通知已关闭界面', () => {
        const onAdded=eventPort(),onRemoved=eventPort(),listener=vi.fn();safari({onAdded,onRemoved});
        const stop=subscribeFreeProviderAccessChanges(listener);
        onAdded.emit({});onRemoved.emit({origins:[]});expect(listener).not.toHaveBeenCalled();
        onAdded.emit({origins:['https://edge.microsoft.com/*']});onRemoved.emit({origins:['<all_urls>']});
        expect(listener.mock.calls).toEqual([['added'],['removed']]);const late=[...onAdded.listeners][0];stop();
        expect(onAdded.listeners.size).toBe(0);expect(onRemoved.listeners.size).toBe(0);late({origins:['https://edge.microsoft.com/*']});expect(listener).toHaveBeenCalledTimes(2);
    });
    it.each(['chrome','edge','firefox','userscript'])('%s 不注册原生权限事件', target => {
        vi.stubEnv('BROWSER',target);const onAdded=eventPort(),onRemoved=eventPort();vi.stubGlobal('browser',{permissions:{onAdded,onRemoved}});
        subscribeFreeProviderAccessChanges(vi.fn())();expect(onAdded.addListener).not.toHaveBeenCalled();expect(onRemoved.addListener).not.toHaveBeenCalled();
    });
    it('Safari 无browser时返回可清理的空订阅', () => {
        vi.stubEnv('BROWSER','safari');vi.stubGlobal('browser',undefined);expect(()=>subscribeFreeProviderAccessChanges(vi.fn())()).not.toThrow();
    });
    it.each([undefined,{}, {onAdded:{addListener:vi.fn()}}, {onRemoved:{removeListener:vi.fn()}}])('缺失或不完整事件API不注册不可清理监听：%s', permissions => {
        safari(permissions);expect(()=>subscribeFreeProviderAccessChanges(vi.fn())()).not.toThrow();
        if(permissions&&'onAdded'in permissions&&permissions.onAdded)expect(permissions.onAdded.addListener).not.toHaveBeenCalled();
    });
    it('某事件注册失败仍监听另一事件，关闭上下文清理异常不阻断其余解绑', () => {
        const onRemoved=eventPort(),listener=vi.fn();safari({onAdded:{addListener(){throw Error('unsupported');},removeListener:vi.fn()},onRemoved});
        const stop=subscribeFreeProviderAccessChanges(listener);onRemoved.emit({origins:['https://edge.microsoft.com/*']});expect(listener).toHaveBeenCalledWith('removed');stop();expect(onRemoved.listeners.size).toBe(0);
        const onAdded=eventPort(),other=eventPort();onAdded.removeListener.mockImplementation(()=>{throw Error('closed context');});safari({onAdded,onRemoved:other});
        const cleanup=subscribeFreeProviderAccessChanges(listener),late=[...onAdded.listeners][0];cleanup();expect(other.listeners.size).toBe(0);listener.mockClear();late({origins:['https://edge.microsoft.com/*']});expect(listener).not.toHaveBeenCalled();
    });
});
