import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDropboxAuth, DropboxError, type DropboxAuthPorts} from '@/src/platform/dropbox/auth';
import {DROPBOX_SCOPES} from '@/src/platform/dropbox/constants';

const redirect = 'https://fixture-extension.chromiumapp.org/dropbox';
function fixture() {
    let stored: unknown;
    let clock = 1000;
    const ports: DropboxAuthPorts = {
        appKey: 'fixturePublicAppKey',
        identity: {
            getRedirectURL: vi.fn(() => redirect),
            launchWebAuthFlow: vi.fn(async ({url}) => `${redirect}?code=fixture-code&state=${new URL(url).searchParams.get('state')}`),
        },
        readSession: vi.fn(async () => stored), writeSession: vi.fn(async value => {stored = value;}), clearSession: vi.fn(async () => {stored = undefined;}),
        fetch: vi.fn(async url => Response.json(String(url).includes('/oauth2/token') ? {access_token: 'fixture-only-token', token_type: 'bearer', expires_in: 14400, scope: DROPBOX_SCOPES.join(' ')} : {account_id: 'fixture-id', email: 'fixture@example.invalid'})),
        now: () => clock,
    };
    return {ports, auth: createDropboxAuth(ports), get stored() {return stored;}, set stored(value) {stored = value;}, set clock(value: number) {clock = value;}};
}
afterEach(() => vi.useRealTimers());
describe('Dropbox 一次授权', () => {
    it('只使用 App key 与 S256 PKCE，账号和临时令牌分离，后台重启可以恢复', async () => {
        const f = fixture(); const session = await f.auth.open(true);
        const url = new URL(vi.mocked(f.ports.identity!.launchWebAuthFlow).mock.calls[0][0].url);
        expect(url.searchParams.get('scope')).toBe(DROPBOX_SCOPES.join(' '));
        expect(url.searchParams.get('token_access_type')).toBe('online');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.has('force_reauthentication')).toBe(false);
        const form = new URLSearchParams(String(vi.mocked(f.ports.fetch).mock.calls[0][1]?.body));
        expect(form.get('client_id')).toBe(f.ports.appKey); expect(form.has('client_secret')).toBe(false);
        const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!))).toString('base64url');
        expect(url.searchParams.get('code_challenge')).toBe(challenge);
        expect(session.account).toEqual({id: 'dropbox:fixture-id', email: 'fixture@example.invalid'});
        expect(JSON.stringify(session)).not.toContain('fixture-only-token');
        expect(await session.request(async token => token)).toBe('fixture-only-token');
        expect((f.stored as {expiresAt: number}).expiresAt).toBe(601000);
        expect((await createDropboxAuth(f.ports).open()).account).toEqual(session.account);
        await f.auth.disconnect(); expect(f.stored).toBeUndefined();
    });
    it('显式换号重新登录，不依赖网站旧登录账号', async () => {
        const f = fixture(); await f.auth.open(true, true);
        expect(new URL(vi.mocked(f.ports.identity!.launchWebAuthFlow).mock.calls[0][0].url).searchParams.get('force_reauthentication')).toBe('true');
    });
    it('未配置及不支持的环境不启动授权', async () => {
        for (const appKey of ['', 'bad/key']) {const f = fixture(); f.ports.appKey = appKey; expect(f.auth.availability().available).toBe(false); await expect(f.auth.open(true)).rejects.toThrow('notConfigured');}
        for (const identity of [undefined, {}, {getRedirectURL: () => redirect}]) {const f = fixture(); f.ports.identity = identity as DropboxAuthPorts['identity']; expect(f.auth.availability().available).toBe(false); await expect(f.auth.open()).rejects.toThrow('unsupported');}
    });
    it('授权取消和伪造回调不会交换令牌或保存会话', async () => {
        const callbacks = [undefined, 'bad-url', `${redirect}?code=fixture`, `${redirect}?code=fixture&state=wrong`, `https://attacker.invalid/dropbox?code=x&state=STATE`, `${redirect}/other?code=x&state=STATE`, `${redirect}?code=x&state=STATE#fragment`, `https://user:password@fixture-extension.chromiumapp.org/dropbox?code=x&state=STATE`, `${redirect}?state=STATE&state=STATE&code=x`, `${redirect}?state=STATE&error=access_denied`, `${redirect}?state=STATE`, `${redirect}?state=STATE&code=`, `${redirect}?state=STATE&code=${'x'.repeat(2049)}`, `${redirect}?state=STATE&code=x&code=y`];
        for (const callback of callbacks) {const f = fixture(); vi.mocked(f.ports.identity!.launchWebAuthFlow).mockImplementationOnce(async ({url}) => callback?.replaceAll('STATE', new URL(url).searchParams.get('state')!)); await expect(f.auth.open(true)).rejects.toBeInstanceOf(DropboxError); expect(f.ports.fetch).not.toHaveBeenCalled(); expect(f.stored).toBeUndefined();}
        const f = fixture(); vi.mocked(f.ports.identity!.launchWebAuthFlow).mockRejectedValueOnce(new Error('fixture-private-error')); await expect(f.auth.open(true)).rejects.toThrow('canceled');
    });
    it('令牌、权限和账号返回值无效时清理临时会话', async () => {
        const valid = {access_token: 'fixture-token', token_type: 'bearer', expires_in: 5, scope: DROPBOX_SCOPES.join(' ')};
        for (const value of [null, {}, {...valid, access_token: 1}, {...valid, access_token: ''}, {...valid, token_type: 'other'}, {...valid, expires_in: '1'}, {...valid, expires_in: Infinity}, {...valid, expires_in: 0}, {...valid, scope: 1}, {...valid, scope: 'account_info.read'}]) {const f = fixture(); vi.mocked(f.ports.fetch).mockResolvedValueOnce(Response.json(value)); await expect(f.auth.open(true)).rejects.toBeInstanceOf(DropboxError); expect(f.stored).toBeUndefined();}
        for (const account of [null, {}, {account_id: ''}, {account_id: 1}]) {const f = fixture(); vi.mocked(f.ports.fetch).mockResolvedValueOnce(Response.json(valid)).mockResolvedValueOnce(Response.json(account)); await expect(f.auth.open(true)).rejects.toThrow('account');}
        const f = fixture(); vi.mocked(f.ports.fetch).mockResolvedValueOnce(Response.json(valid)).mockResolvedValueOnce(Response.json({account_id: 'fixture-id'})); expect((await f.auth.open(true)).account.email).toBe(''); expect((f.stored as {expiresAt: number}).expiresAt).toBe(6000);
    });
    it('缓存失效、令牌到期与账号变化要求重新预览', async () => {
        for (const stored of [undefined, null, {}, {token: ''}, {token: 1}, {token: 'x'}, {token: 'x', expiresAt: NaN}, {token: 'x', expiresAt: 999}, {token: 'x', expiresAt: 2000}, {token: 'x', expiresAt: 2000, account: {}}, {token: 'x', expiresAt: 2000, account: {id: 1}}, {token: 'x', expiresAt: 2000, account: {id: 'google-id'}}, {token: 'x', expiresAt: 2000, account: {id: 'dropbox:id'}}]) {const f = fixture(); f.stored = stored; await expect(f.auth.open(false)).rejects.toThrow('expired'); expect(f.stored).toBeUndefined();}
        const f = fixture(); const session = await f.auth.open(true); f.clock = 601001; await expect(session.request(async () => 'x')).rejects.toThrow('expired');
        const other = fixture(); await other.auth.open(true); vi.mocked(other.ports.fetch).mockResolvedValueOnce(Response.json({account_id: 'other', email: 'other@example.invalid'})); await expect(other.auth.open()).rejects.toThrow('accountChanged'); expect(other.stored).toBeUndefined();
    });
    it('错误响应和超时不泄露上游内容', async () => {
        for (const status of [401, 403, 429, 500]) {const f = fixture(); vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response('fixture-private-error', {status})); const error = await f.auth.open(true).catch(error => error); expect(error.status).toBe(status); expect(error.message).not.toContain('fixture-private');}
        for (const response of [new Response('invalid'), null]) {const f = fixture(); if (response) vi.mocked(f.ports.fetch).mockResolvedValueOnce(response); else vi.mocked(f.ports.fetch).mockRejectedValueOnce(new Error('fixture-private-network')); await expect(f.auth.open(true)).rejects.toThrow('network');}
        vi.useFakeTimers(); const f = fixture(); vi.mocked(f.ports.fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout'))))); const request = f.auth.open(true).catch(error => error); await vi.waitFor(() => expect(f.ports.fetch).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(30000); expect((await request).message).toContain('network');
    });
});
