/**
 * @file src/platform/google-drive/auth.ts
 * 文件职责：连接 Chrome 原生身份 API，并将一次同步绑定到同一个 Google 账号。
 * 主要内容：单项 Drive 授权、Drive 账号识别、短期令牌刷新与账号切换保护。
 * 模块边界：不保存令牌、不读取配置；账号和令牌只在后台请求期间使用。
 */
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_ID, GOOGLE_DRIVE_SCOPES} from './constants';

// 邮箱仅用于预览展示；账号绑定始终使用 Drive permissionId，不依赖邮箱或额外身份授权。
export interface DriveAccount {id: string; email: string}
export interface DriveSession {
    account: DriveAccount;
    request<T>(operation: (token: string) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface DriveIdentity {
    getAuthToken(details: {interactive: boolean; enableGranularPermissions: boolean; scopes: string[]}): Promise<{token?: string; grantedScopes?: string[]}>;
    removeCachedAuthToken(details: {token: string}): Promise<void>;
    clearAllCachedAuthTokens(): Promise<void>;
}
export class DriveError extends Error {
    constructor(message: string, readonly status?: number) {super(message); this.name = 'DriveError';}
}
export interface DriveAuthPorts {
    userAgent(): string;
    identity?: DriveIdentity;
    runtime: {id: string; getManifest(): {oauth2?: {client_id?: string; scopes?: string[]}}};
    fetch: typeof fetch;
}

export function createDriveAuth(ports: DriveAuthPorts) {
    // Native identity cannot be cancelled. A late token must be cleared before
    // another authorization can use the same browser cache.
    const abandonedIdentities = new Set<Promise<void>>();
    let abandonedCleanupFailed = false;
    const waitForSignal = <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
        if (!signal) return operation;
        return new Promise((resolve, reject) => {
            const abort = () => {signal.removeEventListener('abort', abort); reject(signal.reason);};
            signal.addEventListener('abort', abort, {once: true});
            operation.then(value => {signal.removeEventListener('abort', abort); resolve(value);}, error => {signal.removeEventListener('abort', abort); reject(error);});
            if (signal.aborted) abort();
        });
    };
    function availability(): {available: boolean; reason: string} {
        const oauth = ports.runtime.getManifest().oauth2;
        if (!/\bChrome\//u.test(ports.userAgent()) || /\b(?:Edg|OPR)\//u.test(ports.userAgent()) || !ports.identity?.getAuthToken || !oauth?.client_id) return {available: false, reason: 'Google Drive 同步目前支持 Chrome 扩展；其他浏览器可使用下方完整数据备份。'};
        if (oauth.client_id === GOOGLE_DRIVE_DEFAULT_CLIENT_ID && ports.runtime.id !== GOOGLE_DRIVE_EXTENSION_ID) return {available: false, reason: '当前开发版扩展 ID 与 Google OAuth 客户端不匹配，请按维护者指南设置扩展公钥或单独创建开发客户端。'};
        if (!GOOGLE_DRIVE_SCOPES.every(scope => oauth.scopes?.includes(scope))) return {available: false, reason: '扩展缺少 Google Drive 应用数据授权范围，请重新构建。'};
        return {available: true, reason: ''};
    }
    async function token(interactive: boolean, signal?: AbortSignal): Promise<string> {
        const state = availability();
        if (!state.available) throw new DriveError(state.reason);
        if (abandonedIdentities.size || abandonedCleanupFailed) throw new DriveError('上次 Google 授权仍在结束，请稍后重试。');
        signal?.throwIfAborted();
        const request = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return ports.identity!.getAuthToken({interactive, enableGranularPermissions: true, scopes: [...GOOGLE_DRIVE_SCOPES]});
        });
        let result: Awaited<ReturnType<DriveIdentity['getAuthToken']>>;
        const quarantine = () => {
            const cleanup = request.then(async late => {if (late.token) await ports.identity!.removeCachedAuthToken({token: late.token});}, () => undefined)
                .catch(() => {abandonedCleanupFailed = true;});
            abandonedIdentities.add(cleanup);
            void cleanup.then(() => {abandonedIdentities.delete(cleanup);});
        };
        const abort = () => {quarantine();};
        signal?.addEventListener('abort', abort, {once: true});
        try {
            result = await waitForSignal(request, signal);
            signal?.throwIfAborted();
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            throw new DriveError('Google 授权未完成，请点击同步按钮后重试。');
        } finally {signal?.removeEventListener('abort', abort);}
        if (!result.token) throw new DriveError('Google 未返回有效授权，请点击同步按钮重试。');
        if (result.grantedScopes && !result.grantedScopes.includes(GOOGLE_DRIVE_SCOPES[0])) throw new DriveError('未允许 Google Drive 配置数据权限，请重新同步并在 Google 授权页面允许访问配置数据。');
        return result.token;
    }
    async function evictToken(accessToken: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const operation = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return ports.identity!.removeCachedAuthToken({token: accessToken});
        });
        const abort = () => {
            const cleanup = operation.catch(() => {abandonedCleanupFailed = true;});
            abandonedIdentities.add(cleanup);
            void cleanup.then(() => {abandonedIdentities.delete(cleanup);});
        };
        signal?.addEventListener('abort', abort, {once: true});
        try {
            await waitForSignal(operation, signal);
            signal?.throwIfAborted();
        } finally {signal?.removeEventListener('abort', abort);}
    }
    async function account(accessToken: string, signal?: AbortSignal): Promise<DriveAccount> {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(() => controller.abort(), 30_000);
        const operation = (async () => {
            let response: Response | undefined;
            try {
                response = await ports.fetch('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)', {headers: {Authorization: `Bearer ${accessToken}`}, signal: controller.signal});
                if (!response.ok) throw new DriveError(`读取 Google 账号失败（HTTP ${response.status}）。`, response.status);
                const data: unknown = await response.json();
                const user = data && typeof data === 'object' && 'user' in data ? data.user : null;
                if (!user || typeof user !== 'object' || !('permissionId' in user) || typeof user.permissionId !== 'string' || !user.permissionId) throw new DriveError('Google 账号响应无效，请重新同步。');
                // 与旧 OAuth 身份 ID 分开命名，旧基线回到明确选方向的首次同步，不能按邮箱冒认同一账号。
                return {id: `drive:${user.permissionId}`, email: 'emailAddress' in user && typeof user.emailAddress === 'string' ? user.emailAddress : ''};
            } finally {
                if (response) cancelUnreadResponseBody(response);
            }
        })();
        return waitForSignal(operation, signal).catch(error => {
            if (signal?.aborted) throw signal.reason;
            if (error instanceof DriveError) throw error;
            throw new DriveError('无法读取 Google 账号，请检查网络后重试。');
        }).finally(() => {clearTimeout(timer); signal?.removeEventListener('abort', abort);});
    }
    async function open(interactive = false, signal?: AbortSignal): Promise<DriveSession> {
        let accessToken = await token(interactive, signal);
        let owner: DriveAccount;
        try {owner = await account(accessToken, signal);} catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof DriveError) || error.status !== 401) throw error;
            await evictToken(accessToken, signal);
            accessToken = await token(false, signal);
            owner = await account(accessToken, signal);
        }
        return {
            account: owner,
            async request(operation, requestSignal) {
                requestSignal?.throwIfAborted();
                const requestToken = accessToken;
                try {return await operation(requestToken);} catch (error) {
                    requestSignal?.throwIfAborted();
                    if (!(error instanceof DriveError) || error.status !== 401) throw error;
                    await evictToken(requestToken, requestSignal);
                    const refreshedToken = await token(false, requestSignal);
                    const refreshed = await account(refreshedToken, requestSignal);
                    if (refreshed.id !== owner.id) throw new DriveError('Google 账号已切换，请重新生成同步预览。');
                    // 只有验证属于本会话账号的令牌才可成为后续请求的凭据。
                    accessToken = refreshedToken;
                    return operation(refreshedToken);
                }
            },
        };
    }
    async function disconnect() {
        if (ports.identity) {
            await ports.identity.clearAllCachedAuthTokens();
            if (!abandonedIdentities.size) abandonedCleanupFailed = false;
        }
    }
    return {availability, open, disconnect};
}
