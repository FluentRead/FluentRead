/**
 * @file src/platform/http/doubaoGuest.ts
 * 文件职责：将豆包匿名访客请求转换为受限的运行时网络请求。
 * 主要内容：校验内部访客头和精确翻译端点；扩展使用单请求的内存会话规则设置匿名 Cookie 与官网来源头，串行安装、请求和清理，取消或安装失败不发送请求。
 * 模块边界：不获取访客凭据、不读取用户 Cookie 或配置；平台仅消费 provider 给出的临时 ttwid，其他网络请求保持原有传输。
 */
import type {DeclarativeNetRequest} from 'webextension-polyfill';
import {abortErrorFromSignal, cancelUnreadResponseBody, type RuntimeFetch} from './runtime';

export const DOUBAO_GUEST_HEADER = 'X-FluentRead-Doubao-Ttwid';
export const DOUBAO_GUEST_RULE_ID = 2_764_000;
const DOUBAO_ORIGIN = 'https://www.doubao.com';
const DOUBAO_PATH = '/samantha/plugin/stream_article_translate';
type GuestRulesPort = Pick<DeclarativeNetRequest.Static, 'updateSessionRules'>;

function unavailable(): Error {
    return Object.assign(new Error('当前运行环境无法发送豆包匿名访客请求。'), {freeFailure: 'unavailable'});
}

/** 内部头不能发送到外部服务，也不能把匿名 Cookie 带到其他端点。 */
export function readDoubaoGuestRequest(url: string, method: string, headers: Headers): {token: string; headers: Headers} | undefined {
    const token = headers.get(DOUBAO_GUEST_HEADER);
    if (token === null) return undefined;
    const target = new URL(url);
    if (target.origin !== DOUBAO_ORIGIN || target.pathname !== DOUBAO_PATH || target.username || target.password
        || target.hash || url.length > 1500 || method.toUpperCase() !== 'POST' || !/^[A-Za-z0-9%._~|+/=-]{1,4096}$/u.test(token)) throw unavailable();
    const safeHeaders = new Headers(headers);
    safeHeaders.delete(DOUBAO_GUEST_HEADER);
    safeHeaders.delete('Cookie');
    safeHeaders.delete('Authorization');
    return {token, headers: safeHeaders};
}

/** 会话规则由浏览器保存在内存，不写入动态规则或用户的 Cookie 存储。 */
export function createDoubaoGuestFetch(api: GuestRulesPort | undefined, extensionDomain: string, fetcher: RuntimeFetch): RuntimeFetch {
    // 同一个保留编号串行使用。后台重启时清理上次被中断的临时规则。
    let tail = api?.updateSessionRules
        ? api.updateSessionRules({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []}).catch(() => undefined)
        : Promise.resolve();
    return (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        let guest: ReturnType<typeof readDoubaoGuestRequest>;
        try { guest = readDoubaoGuestRequest(url, method, headers); }
        catch { return Promise.reject(unavailable()); }
        if (!guest) return fetcher(input, init);
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const checkAbort = () => { if (signal?.aborted) throw abortErrorFromSignal(signal); };
        let started = false;
        const request = tail.then(async () => {
            started = true;
            checkAbort();
            if (!api?.updateSessionRules) throw unavailable();
            const rule: DeclarativeNetRequest.Rule = {
                id: DOUBAO_GUEST_RULE_ID,
                priority: 1,
                action: {type: 'modifyHeaders', requestHeaders: [
                    {header: 'Cookie', operation: 'set', value: `ttwid=${guest.token}`},
                    {header: 'Origin', operation: 'set', value: DOUBAO_ORIGIN},
                    {header: 'Referer', operation: 'set', value: `${DOUBAO_ORIGIN}/`},
                ]},
                condition: {
                    regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                    isUrlFilterCaseSensitive: true,
                    initiatorDomains: [extensionDomain],
                    requestMethods: ['post'],
                    resourceTypes: ['xmlhttprequest'],
                },
            };
            try { await api.updateSessionRules({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: [rule]}); }
            catch { throw unavailable(); }
            let response: Response | undefined;
            try {
                checkAbort();
                response = await fetcher(input, {...init, headers: guest.headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
                return response;
            } finally {
                try { await api.updateSessionRules({removeRuleIds: [DOUBAO_GUEST_RULE_ID], addRules: []}); }
                catch {
                    // 清理失败时不把已收到的长连接留给无人消费的 Response。
                    if (response) cancelUnreadResponseBody(response);
                    checkAbort();
                    throw unavailable();
                }
            }
        });
        tail = request.then(() => undefined, () => undefined);
        if (!signal) return request;
        return new Promise<Response>((resolve, reject) => {
            const onAbort = () => { if (!started) reject(abortErrorFromSignal(signal)); };
            signal.addEventListener('abort', onAbort, {once: true});
            if (signal.aborted) onAbort();
            const cleanup = () => signal.removeEventListener('abort', onAbort);
            request.then(value => {cleanup(); resolve(value);}, error => {cleanup(); reject(error);});
        });
    };
}
