/**
 * @file src/platform/onedrive/auth.ts
 * 文件职责：用浏览器身份窗口和 PKCE 完成一次微软账号委托授权。
 * 主要内容：随机校验状态、严格匹配回调、校验授权范围、账号绑定与一次静默重试。
 * 模块边界：只在后台内存保存短期访问令牌；不创建客户端秘密或持久化刷新令牌。
 */
import {DriveError, type DriveAccount, type DriveSession} from '../google-drive/auth';
import {ONEDRIVE_AUTHORITY, ONEDRIVE_GRAPH, ONEDRIVE_REDIRECT_PATH, ONEDRIVE_SCOPES} from './constants';

export interface OneDriveIdentity {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: {url: string; interactive: boolean}): Promise<string | undefined>;
}
export interface OneDriveAuthPorts {
    clientId: string;
    identity?: OneDriveIdentity;
    fetch: typeof fetch;
    now(): number;
}
const failure = (key: string, status?: number) => new DriveError(`settings.onedrive.${key}`, status);
function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
function random(): string {return base64url(crypto.getRandomValues(new Uint8Array(32)));}

export function createOneDriveAuth(ports: OneDriveAuthPorts) {
    let cached: {token: string; expiresAt: number; account: DriveAccount} | null = null;
    let generation = 0;
    function availability() {
        if (!ports.identity?.getRedirectURL || !ports.identity.launchWebAuthFlow) return {available: false, reason: 'settings.onedrive.unsupported'};
        if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(ports.clientId)) return {available: false, reason: 'settings.onedrive.notConfigured'};
        return {available: true, reason: ''};
    }
    async function json(url: string, init: RequestInit): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let result: unknown;
        try {
            const response = await ports.fetch(url, {...init, redirect: 'error', signal: controller.signal});
            if (!response.ok) throw failure(response.status === 401 ? 'authorizationExpired' : 'authFailed', response.status);
            result = await response.json();
        } catch (error) {
            if (error instanceof DriveError) throw error;
            throw failure('networkFailed');
        } finally {
            clearTimeout(timer);
        }
        return result;
    }
    async function authorize(interactive: boolean) {
        const state = availability();
        if (!state.available) throw new DriveError(state.reason);
        const version = generation;
        const redirect = ports.identity!.getRedirectURL(ONEDRIVE_REDIRECT_PATH);
        const expected = new URL(redirect);
        if (expected.protocol !== 'https:' || expected.username || expected.password || expected.search || expected.hash) throw failure('invalidRedirect');
        const verifier = random();
        const nonce = random();
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const url = new URL(`${ONEDRIVE_AUTHORITY}/authorize`);
        url.search = new URLSearchParams({client_id: ports.clientId, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: ONEDRIVE_SCOPES.join(' '), state: nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: interactive ? 'select_account' : 'none'}).toString();
        let result: string | undefined;
        try {result = await ports.identity!.launchWebAuthFlow({url: url.href, interactive});}
        catch {throw failure(interactive ? 'authCanceled' : 'authorizationExpired');}
        if (generation !== version) throw failure('authorizationExpired');
        if (!result) throw failure('authCanceled');
        let callback: URL;
        try {callback = new URL(result);} catch {throw failure('invalidRedirect');}
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== nonce) throw failure('invalidRedirect');
        if (callback.searchParams.has('error')) throw failure(interactive ? callback.searchParams.get('error') === 'access_denied' ? 'authCanceled' : 'authFailed' : 'authorizationExpired');
        const code = callback.searchParams.get('code');
        if (!code || callback.searchParams.getAll('code').length !== 1) throw failure('invalidRedirect');
        const value = await json(`${ONEDRIVE_AUTHORITY}/token`, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: ports.clientId, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier}).toString()});
        if (!value || typeof value !== 'object' || !('access_token' in value) || typeof value.access_token !== 'string' || !value.access_token || !('token_type' in value) || value.token_type !== 'Bearer' || !('expires_in' in value) || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86_400 || !('scope' in value) || typeof value.scope !== 'string') throw failure('invalidAuthorization');
        const granted = value.scope.toLowerCase().split(/\s+/u).map(scope => scope.replace('https://graph.microsoft.com/', ''));
        if (!ONEDRIVE_SCOPES.every(scope => granted.includes(scope.toLowerCase()))) throw failure('missingPermission');
        const user = await json(`${ONEDRIVE_GRAPH}/me?$select=id,mail,userPrincipalName`, {headers: {Authorization: `Bearer ${value.access_token}`}});
        if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id) throw failure('invalidAccount');
        const email = 'mail' in user && typeof user.mail === 'string' && user.mail ? user.mail : 'userPrincipalName' in user && typeof user.userPrincipalName === 'string' ? user.userPrincipalName : '';
        if (generation !== version) throw failure('authorizationExpired');
        cached = {token: value.access_token, expiresAt: ports.now() + value.expires_in * 1000, account: {id: `onedrive:${user.id}`, email}};
        return cached;
    }
    async function open(interactive = false): Promise<DriveSession> {
        const current = !interactive && cached && cached.expiresAt > ports.now() + 60_000 ? cached : await authorize(interactive);
        const version = generation;
        const owner = current.account;
        let accessToken = current.token;
        return {account: owner, async request(operation) {
            if (generation !== version) throw failure('authorizationExpired');
            try {return await operation(accessToken);} catch (error) {
                if (!(error instanceof DriveError) || error.status !== 401) throw error;
                cached = null;
                const renewed = await authorize(false);
                if (renewed.account.id !== owner.id || generation !== version) throw failure('accountChanged');
                accessToken = renewed.token;
                return operation(accessToken);
            }
        }};
    }
    async function disconnect() {generation += 1; cached = null;}
    return {availability, open, disconnect};
}
