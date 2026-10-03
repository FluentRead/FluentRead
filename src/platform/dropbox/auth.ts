/**
 * @file src/platform/dropbox/auth.ts
 * 文件职责：通过浏览器 identity 完成 Dropbox 授权码与 S256 PKCE 授权。
 * 主要内容：校验随机 state 和精确回调地址，以公开 App key 换取短期令牌；只在浏览器
 * session storage 暂存一次同步的授权，支持后台重启与主动换号，不请求 refresh token。
 * 模块边界：不读取配置，不向设置页返回令牌；结构上适配现有同步事务的会话端口。
 */
import {DriveError, type DriveAccount, type DriveSession} from '../google-drive/auth';
import {DROPBOX_SCOPES, DROPBOX_REDIRECT_PATH} from './constants';

export class DropboxError extends DriveError {}
export interface DropboxIdentity {
    getRedirectURL(path: string): string;
    launchWebAuthFlow(details: {url: string; interactive: boolean}): Promise<string | undefined>;
}
export interface DropboxAuthPorts {
    appKey: string;
    identity?: DropboxIdentity;
    readSession(): Promise<unknown>;
    writeSession(value: unknown): Promise<void>;
    clearSession(): Promise<void>;
    fetch: typeof fetch;
    now(): number;
}
interface Authorization {token: string; expiresAt: number; account: DriveAccount}
function fail(key: string, status?: number): DropboxError {return new DropboxError(`settings.dropbox.error.${key}`, status);}
function base64Url(bytes: Uint8Array): string {return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');}
function cached(value: unknown, now: number): Authorization {
    const data = value as Partial<Authorization> | null;
    if (!data || typeof data.token !== 'string' || !data.token || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt) || data.expiresAt <= now || !data.account || typeof data.account.id !== 'string' || !data.account.id.startsWith('dropbox:') || typeof data.account.email !== 'string') throw fail('expired');
    return data as Authorization;
}
export function createDropboxAuth(ports: DropboxAuthPorts) {
    function availability() {
        if (!ports.appKey || !/^[a-zA-Z0-9]{5,128}$/u.test(ports.appKey)) return {available: false, reason: 'settings.dropbox.error.notConfigured'};
        if (!ports.identity?.getRedirectURL || !ports.identity.launchWebAuthFlow) return {available: false, reason: 'settings.dropbox.error.unsupported'};
        return {available: true, reason: ''};
    }
    async function json(url: string, init: RequestInit): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const operation = (async () => {
            const response = await ports.fetch(url, {...init, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal});
            if (!response.ok) throw fail(response.status === 401 ? 'expired' : response.status === 403 ? 'permission' : response.status === 429 ? 'rateLimit' : 'authorization', response.status);
            return await response.json();
        })();
        return operation.catch(error => {
            if (error instanceof DropboxError) throw error;
            throw fail('network');
        }).finally(() => clearTimeout(timer));
    }
    async function account(token: string): Promise<DriveAccount> {
        const value = await json('https://api.dropboxapi.com/2/users/get_current_account', {method: 'POST', headers: {Authorization: `Bearer ${token}`}}) as {account_id?: unknown; email?: unknown} | null;
        if (!value || typeof value.account_id !== 'string' || !value.account_id) throw fail('account');
        return {id: `dropbox:${value.account_id}`, email: typeof value.email === 'string' ? value.email : ''};
    }
    async function authorize(selectAccount: boolean): Promise<Authorization> {
        const redirectUri = ports.identity!.getRedirectURL(DROPBOX_REDIRECT_PATH);
        const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
        const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
        const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const url = new URL('https://www.dropbox.com/oauth2/authorize');
        url.search = new URLSearchParams({client_id: ports.appKey, response_type: 'code', redirect_uri: redirectUri, state, code_challenge_method: 'S256', code_challenge: challenge, token_access_type: 'online', scope: DROPBOX_SCOPES.join(' '), ...(selectAccount ? {force_reauthentication: 'true'} : {})}).toString();
        let redirected: string | undefined;
        try {redirected = await ports.identity!.launchWebAuthFlow({url: url.href, interactive: true});} catch {throw fail('canceled');}
        if (!redirected) throw fail('canceled');
        let result: URL;
        try {result = new URL(redirected);} catch {throw fail('callback');}
        const expected = new URL(redirectUri);
        if (result.origin !== expected.origin || result.pathname !== expected.pathname || result.username || result.password || result.hash || result.searchParams.getAll('state').length !== 1 || result.searchParams.get('state') !== state) throw fail('callback');
        if (result.searchParams.has('error')) throw fail('canceled');
        const code = result.searchParams.get('code');
        if (!code || code.length > 2048 || result.searchParams.getAll('code').length !== 1) throw fail('callback');
        const value = await json('https://api.dropboxapi.com/oauth2/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: ports.appKey, code, code_verifier: verifier, redirect_uri: redirectUri}).toString()}) as {access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown} | null;
        if (!value || typeof value.access_token !== 'string' || !value.access_token || value.token_type !== 'bearer' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw fail('authorization');
        if (typeof value.scope !== 'string' || !DROPBOX_SCOPES.every(scope => (value.scope as string).split(' ').includes(scope))) throw fail('scope');
        const authorization = {token: value.access_token, expiresAt: ports.now() + Math.min(value.expires_in * 1000, 10 * 60_000), account: await account(value.access_token)};
        await ports.writeSession(authorization);
        return authorization;
    }
    async function open(interactive = false, selectAccount = false): Promise<DriveSession> {
        const supported = availability();
        if (!supported.available) throw new DropboxError(supported.reason);
        let authorization: Authorization;
        try {
            if (interactive) {await ports.clearSession(); authorization = await authorize(selectAccount);}
            else {
                authorization = cached(await ports.readSession(), ports.now());
                if ((await account(authorization.token)).id !== authorization.account.id) throw fail('accountChanged');
            }
        } catch (error) {await ports.clearSession(); throw error;}
        return {account: authorization.account, async request(operation) {
            if (authorization.expiresAt <= ports.now()) throw fail('expired');
            return operation(authorization.token);
        }};
    }
    return {availability, open, disconnect: ports.clearSession};
}
