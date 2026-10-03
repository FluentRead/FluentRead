import {describe, expect, it, vi} from 'vitest';
import {createWebDavConnectionStore, createWebDavSession, normalizeWebDavUrl, parseWebDavConnection, webDavConnectionSummary, WebDavError} from '@/src/platform/webdav/connection';

const input = {url: 'https://dav.fixture.invalid/base', username: 'fixture-user', password: 'fixture-app-password', revision: null};
describe('WebDAV 本机连接边界', () => {
    it('规范化目录地址，并拒绝凭据 URL、非 HTTP 协议、查询和不安全地址', () => {
        expect(normalizeWebDavUrl(' https://dav.fixture.invalid/base/// ')).toBe('https://dav.fixture.invalid/base/');
        expect(normalizeWebDavUrl('http://127.0.0.1:9000/dav/', true)).toBe('http://127.0.0.1:9000/dav/');
        expect(() => normalizeWebDavUrl('http://dav.fixture.invalid/')).toThrow(WebDavError);
        for (const value of [null, '', ' ', 'invalid', 'x'.repeat(4097), 'https://a/\nb', 'ftp://a/', 'https://u:p@a/', 'https://a/?token=x', 'https://a/#x', 'https://a/%2f', 'https://a/%5c', 'https://a/%00']) expect(() => normalizeWebDavUrl(value)).toThrow(WebDavError);
    });
    it('同一账号可保持已存密码，改变账号必须重填，并防止旧页面覆盖新设置', () => {
        const saved = parseWebDavConnection(input, null);
        expect(saved).toMatchObject({url: input.url+'/', username: input.username, password: input.password, allowInsecure: false});
        expect(parseWebDavConnection({...saved, password: ''}, saved).password).toBe(saved.password);
        expect(parseWebDavConnection({...saved, password: 'fixture-new'}, saved).password).toBe('fixture-new');
        for (const patch of [{url: 'https://other.fixture.invalid/'}, {username: 'other'}]) expect(() => parseWebDavConnection({...saved, password: '', ...patch}, saved)).toThrow(WebDavError);
        expect(() => parseWebDavConnection({...input, revision: 'stale'}, saved)).toThrow(WebDavError);
        for (const username of [null, '', '  ', 'a:b', 'a\nb', 'x'.repeat(513)]) expect(() => parseWebDavConnection({...input, username}, null)).toThrow(WebDavError);
        for (const password of [null, '', '\n', 'x'.repeat(4097)]) expect(() => parseWebDavConnection({...input, password}, null)).toThrow(WebDavError);
        for (const bad of [null, [], false]) expect(() => parseWebDavConnection(bad as never, null)).toThrow(WebDavError);
        expect(parseWebDavConnection({...input, url: 'http://127.0.0.1/', allowInsecure: true}, null).allowInsecure).toBe(true);
    });
    it('仓库摘要不返回密码，损坏记录停止使用，清除只删除本机记录', async () => {
        let record: unknown = null;
        const storage = {getItem: vi.fn(async () => record), setItem: vi.fn(async (_key, next) => {record = next;}), removeItem: vi.fn(async () => {record = null;})};
        const store = createWebDavConnectionStore(storage as never);
        expect(await store.read()).toBeNull();
        expect(webDavConnectionSummary(null)).toBeNull();
        const next = parseWebDavConnection(input, null);
        await store.write(next);
        expect(await store.read()).toEqual(next);
        expect(webDavConnectionSummary(next)).toEqual({url: next.url, username: next.username, allowInsecure: false, revision: next.revision, hasPassword: true});
        expect(webDavConnectionSummary({...next, password: ''})?.hasPassword).toBe(false);
        expect(JSON.stringify(webDavConnectionSummary(next))).not.toContain(input.password);
        for (const value of [{}, {...next, revision: 1}, {...next, revision: ''}, {...next, password: ''}]) {record = value; await expect(store.read()).rejects.toThrow(WebDavError);}
        await store.remove(); expect(await store.read()).toBeNull();
    });
    it('会话支持 Unicode Basic Auth，每次请求都检查连接修订号', async () => {
        const connection = parseWebDavConnection({...input, username: '虚构用户'}, null);
        const session = createWebDavSession(connection, async () => connection);
        expect(session.account.email).toBe('虚构用户 · dav.fixture.invalid');
        expect(session.account.id).toBe(`webdav:${connection.revision}`);
        const auth = await session.request(async value => value);
        expect(Buffer.from(auth.slice(6), 'base64').toString()).toBe('虚构用户:fixture-app-password');
        for (const current of [null, {...connection, revision: 'changed'}]) {
            const operation = vi.fn();
            await expect(createWebDavSession(connection, async () => current).request(operation)).rejects.toMatchObject({code: 'changed'});
            expect(operation).not.toHaveBeenCalled();
        }
    });
});
