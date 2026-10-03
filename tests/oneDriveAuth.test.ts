import {afterEach, describe, expect, it, vi} from 'vitest';
import {createOneDriveAuth, type OneDriveIdentity} from '@/src/platform/onedrive/auth';
import {DriveError} from '@/src/platform/google-drive/auth';
import {ONEDRIVE_SCOPES} from '@/src/platform/onedrive/constants';
const clientId = '11111111-1111-4111-8111-111111111111';
const redirect = 'https://fixture.chromiumapp.org/onedrive';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const token = () => ({access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600, scope: ONEDRIVE_SCOPES.join(' ')});
function fixture() {
    let time = 100;
    const identity: OneDriveIdentity = {getRedirectURL: vi.fn(() => redirect), launchWebAuthFlow: vi.fn(async ({url}) => {
        const auth = new URL(url);
        return `${redirect}?${new URLSearchParams({code: 'synthetic-code', state: auth.searchParams.get('state')!})}`;
    })};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/token') ? response(token()) : response({id: 'synthetic-user', mail: 'fixture@example.invalid'}));
    const auth = createOneDriveAuth({clientId, identity, fetch: fetcher, now: () => time});
    return {auth, identity, fetcher, setTime: (value: number) => {time = value;}};
}
afterEach(() => vi.useRealTimers());
describe('OneDrive browser OAuth + PKCE', () => {
    it('gates unsupported runtimes and missing public client configuration', async () => {
        for (const identity of [undefined, {}, {getRedirectURL: () => redirect}, {launchWebAuthFlow: async () => redirect}]) {
            const auth = createOneDriveAuth({clientId, identity: identity as unknown as OneDriveIdentity, fetch, now: Date.now});
            expect(auth.availability().reason).toContain('unsupported');
            await expect(auth.open(true)).rejects.toThrow('unsupported');
        }
        const f = fixture();
        const auth = createOneDriveAuth({clientId: '', identity: f.identity, fetch, now: Date.now});
        expect(auth.availability().reason).toContain('notConfigured');
        await expect(auth.open()).rejects.toThrow('notConfigured');
    });
    it('binds state and S256 PKCE, requests only app folder and account permissions, and caches no refresh token', async () => {
        const f = fixture();
        const session = await f.auth.open(true);
        expect(session.account).toEqual({id: 'onedrive:synthetic-user', email: 'fixture@example.invalid'});
        const authorize = new URL(vi.mocked(f.identity.launchWebAuthFlow).mock.calls[0][0].url);
        const body = new URLSearchParams(f.fetcher.mock.calls[0][1]!.body as string);
        const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!))).toString('base64url');
        expect(authorize.searchParams.get('code_challenge')).toBe(hash);
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.get('prompt')).toBe('select_account');
        expect(authorize.searchParams.get('scope')).toBe(ONEDRIVE_SCOPES.join(' '));
        expect(body.has('client_secret')).toBe(false);
        expect(body.has('refresh_token')).toBe(false);
        expect(authorize.searchParams.get('scope')).not.toContain('offline_access');
        await f.auth.open();
        expect(f.identity.launchWebAuthFlow).toHaveBeenCalledOnce();
        f.setTime(3_600_000);
        await f.auth.open();
        expect(new URL(vi.mocked(f.identity.launchWebAuthFlow).mock.lastCall![0].url).searchParams.get('prompt')).toBe('none');
        await f.auth.disconnect();
        await expect(session.request(async () => 'secret')).rejects.toThrow('authorizationExpired');
    });
    it('rejects invalid redirect locations, mismatched state and duplicate callback fields before token exchange', async () => {
        for (const value of ['http://fixture.test/onedrive', 'https://user:pass@fixture.test/onedrive', `${redirect}?extra=1`, `${redirect}#extra`]) {
            const f = fixture(); vi.mocked(f.identity.getRedirectURL).mockReturnValue(value);
            await expect(f.auth.open(true)).rejects.toThrow('invalidRedirect'); expect(f.fetcher).not.toHaveBeenCalled();
        }
        for (const callback of ['bad URL', 'https://evil.invalid/onedrive?state=x&code=y', `${redirect}?state=wrong&code=y`, `${redirect}?state=x&state=x&code=y`, `${redirect.replace('onedrive', 'other')}?state=x&code=y`]) {
            const f = fixture(); vi.mocked(f.identity.launchWebAuthFlow).mockResolvedValue(callback);
            await expect(f.auth.open(true)).rejects.toThrow('invalidRedirect'); expect(f.fetcher).not.toHaveBeenCalled();
        }
        for (const query of ['code=', 'code=x&code=y', 'error=access_denied']) {
            const f = fixture(); vi.mocked(f.identity.launchWebAuthFlow).mockImplementation(async ({url}) => `${redirect}?state=${new URL(url).searchParams.get('state')}&${query}`);
            await expect(f.auth.open(true)).rejects.toThrow(query.startsWith('error') ? 'authCanceled' : 'invalidRedirect');
        }
    });
    it('handles dismissal, silent expiry and cancellation while authorization is pending', async () => {
        for (const interactive of [true, false]) {
            const f = fixture(); vi.mocked(f.identity.launchWebAuthFlow).mockRejectedValue(new Error('synthetic-private-provider-error'));
            await expect(f.auth.open(interactive)).rejects.toThrow(interactive ? 'authCanceled' : 'authorizationExpired');
            vi.mocked(f.identity.launchWebAuthFlow).mockImplementation(async ({url}) => `${redirect}?state=${new URL(url).searchParams.get('state')}&error=login_required`);
            await expect(f.auth.open(interactive)).rejects.toThrow(interactive ? 'authCanceled' : 'authorizationExpired');
        }
        const f = fixture(); vi.mocked(f.identity.launchWebAuthFlow).mockResolvedValue(undefined);
        await expect(f.auth.open(true)).rejects.toThrow('authCanceled');
        const g = fixture(); const original = g.identity.launchWebAuthFlow;
        g.identity.launchWebAuthFlow = async details => {await g.auth.disconnect(); return original(details);};
        await expect(g.auth.open(true)).rejects.toThrow('authorizationExpired');
    });
    it('validates token responses and partial grants without exposing provider errors', async () => {
        for (const value of [null, 1, {}, {...token(), access_token: 1}, {...token(), access_token: ''}, {...token(), token_type: 'MAC'}, {...token(), expires_in: '3600'}, {...token(), expires_in: -1}, {...token(), expires_in: 100000}, {...token(), scope: 1}, {...token(), scope: 'User.Read'}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(response(value));
            await expect(f.auth.open(true)).rejects.toThrow(typeof value === 'object' && value && 'scope' in value && value.scope === 'User.Read' ? 'missingPermission' : 'invalidAuthorization');
        }
        for (const status of [400, 401, 403]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(response({error: 'synthetic-private'}, status));
            await expect(f.auth.open()).rejects.toThrow(status === 401 ? 'authorizationExpired' : 'authFailed');
        }
        const f = fixture(); f.fetcher.mockRejectedValue(new Error('synthetic-private-network-error'));
        await expect(f.auth.open()).rejects.toThrow('networkFailed');
        const g = fixture(); g.fetcher.mockResolvedValueOnce(new Response('invalid json'));
        await expect(g.auth.open()).rejects.toThrow('networkFailed');
    });
    it('confirms the Graph user, supports account-name fallback and clears a canceled in-flight response', async () => {
        for (const value of [null, 1, {}, {id: 1}, {id: ''}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response(value));
            await expect(f.auth.open(true)).rejects.toThrow('invalidAccount');
        }
        for (const user of [{id: 'u', mail: '', userPrincipalName: 'org@example.invalid'}, {id: 'u'}, {id: 'u', mail: 1, userPrincipalName: 1}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(response({...token(), scope: ONEDRIVE_SCOPES.map(s => `https://graph.microsoft.com/${s.toLowerCase()}`).join(' ')})).mockResolvedValueOnce(response(user));
            expect((await f.auth.open(true)).account.email).toBe('userPrincipalName' in user && typeof user.userPrincipalName === 'string' ? user.userPrincipalName : '');
        }
        const f = fixture(); f.fetcher.mockImplementation(async url => {
            if (String(url).endsWith('/token')) return response(token());
            await f.auth.disconnect(); return response({id: 'u'});
        });
        await expect(f.auth.open(true)).rejects.toThrow('authorizationExpired');
    });
    it('retries a 401 once and never applies a different silently selected account', async () => {
        const f = fixture(); const session = await f.auth.open(true);
        const operation = vi.fn().mockRejectedValueOnce(new DriveError('expired', 401)).mockResolvedValue('ok');
        expect(await session.request(operation)).toBe('ok'); expect(operation).toHaveBeenCalledTimes(2);
        const again = vi.fn().mockRejectedValue(new DriveError('expired', 401));
        await expect(session.request(again)).rejects.toThrow('expired'); expect(again).toHaveBeenCalledTimes(2);
        await expect(session.request(async () => {throw new Error('application error');})).rejects.toThrow('application error');
        f.fetcher.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response({id: 'different'}));
        const denied = vi.fn().mockRejectedValue(new DriveError('expired', 401));
        await expect(session.request(denied)).rejects.toThrow('accountChanged'); expect(denied).toHaveBeenCalledOnce();
    });
    it('aborts slow authorization HTTP requests', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.fetcher.mockImplementation(async (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')))));
        const pending = f.auth.open(true); const asserted = expect(pending).rejects.toThrow('networkFailed');
        await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(30_000); await asserted;
    });
});
