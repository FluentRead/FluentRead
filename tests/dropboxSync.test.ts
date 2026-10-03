import {describe, expect, it, vi} from 'vitest';
import {createDropboxAuth, type DropboxAuthPorts} from '@/src/platform/dropbox/auth';
import {createDropboxApi} from '@/src/platform/dropbox/api';
import {DROPBOX_SCOPES} from '@/src/platform/dropbox/constants';
import {createRemoteConfigSync, type DriveSyncPorts} from '@/src/services/config/remoteConfigSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE as password} from '@/src/platform/google-drive/constants';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {toDriveSyncConfig, driveSyncPayload} from '@/src/core/config/driveSync';
import {decryptDriveConfig, encryptDriveConfig} from '@/src/platform/google-drive/encryption';

function fixture() {
    let session: unknown; let state: unknown; let content: string | null = null; let rev = 0; let account = 'fixture-a';
    let local = toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, token: {openai: 'fixture-only-api-key'}}));
    const metadata = () => ({id: 'id:fixture', rev: `rev-${rev}`, size: new TextEncoder().encode(content!).byteLength, server_modified: '2026-10-03T00:00:00Z'});
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/oauth2/token')) return Response.json({access_token: 'fixture-sync-token', token_type: 'bearer', expires_in: 14400, scope: DROPBOX_SCOPES.join(' ')});
        if (url.endsWith('/users/get_current_account')) return Response.json({account_id: account, email: `${account}@example.invalid`});
        if (url.endsWith('/files/download')) return content ? new Response(content, {headers: {'Dropbox-API-Result': JSON.stringify(metadata())}}) : new Response(JSON.stringify({error: {'.tag': 'path', path: {'.tag': 'not_found'}}}), {status: 409});
        const arg = JSON.parse((init!.headers as Record<string, string>)['Dropbox-API-Arg']);
        if ((arg.mode['.tag'] === 'add' && content) || (arg.mode['.tag'] === 'update' && arg.mode.update !== `rev-${rev}`)) return new Response('fixture-conflict', {status: 409});
        content = String(init!.body); rev++; return Response.json(metadata());
    });
    const authPorts: DropboxAuthPorts = {appKey: 'fixtureAppKey', identity: {getRedirectURL: () => 'https://fixture.chromiumapp.org/dropbox', launchWebAuthFlow: vi.fn(async ({url}) => `https://fixture.chromiumapp.org/dropbox?code=fixture-code&state=${new URL(url).searchParams.get('state')}`)}, readSession: async () => session, writeSession: async value => {session = value;}, clearSession: async () => {session = undefined;}, fetch: fetcher, now: () => 1000};
    function ports(): DriveSyncPorts {return {auth: createDropboxAuth(authPorts), api: createDropboxApi(fetcher), snapshot: async () => structuredClone(local), apply: async value => {local = value;}, readState: async () => state, writeState: async value => {state = value;}, now: () => 1000};}
    return {ports, authPorts, fetcher, get session() {return session;}, get state() {return state;}, get local() {return local;}, set local(value) {local = value;}, get content() {return content;}, async replaceCloud(value: typeof local) {content = await encryptDriveConfig(driveSyncPayload(value), password); rev++;}, set account(value: string) {account = value;}};
}
describe('Dropbox 端口与配置事务联调', () => {
    it('首次备份不提前写入，后台重启后确认、恢复凭据并清理令牌，换号独立基线', async () => {
        const f = fixture(); const preview = await createRemoteConfigSync(f.ports()).prepare(password, 8, 'fixture-ui');
        expect(preview.account.email).toBe('fixture-a@example.invalid'); expect(f.content).toBeNull(); expect(f.session).toBeTruthy();
        expect(JSON.stringify(f.state)).not.toMatch(/fixture-sync-token|fixture-only-api-key/);
        const first = await createRemoteConfigSync(f.ports()).commit(preview.id, password, 'upload', {}, 8, 'fixture-ui');
        expect(first.account?.email).toBe('fixture-a@example.invalid'); expect(f.session).toBeUndefined(); expect(f.content).not.toMatch(/fixture-sync-token|fixture-only-api-key/);
        expect(JSON.stringify(await decryptDriveConfig(f.content!, password))).toContain('fixture-only-api-key');
        f.local = {...f.local, to: 'fr', token: {openai: 'fixture-new-key'}};
        const restored = createRemoteConfigSync(f.ports()); const download = await restored.prepare(password, 8, 'fixture-ui'); await restored.commit(download.id, password, 'download', {}, 8, 'fixture-ui');
        expect((f.local.token as Record<string, string>).openai).toBe('fixture-only-api-key'); expect(f.session).toBeUndefined();
        f.account = 'fixture-b'; const switcher = createRemoteConfigSync(f.ports()); const changed = await switcher.prepare(password, 8, 'fixture-ui', true);
        expect(changed.hasBaseline).toBe(false); expect(new URL(vi.mocked(f.authPorts.identity!.launchWebAuthFlow).mock.calls.at(-1)![0].url).searchParams.get('force_reauthentication')).toBe('true');
        await switcher.cancel(changed.id, 8, 'fixture-ui'); expect(f.session).toBeUndefined(); expect((await switcher.status()).account?.email).toBe('fixture-a@example.invalid');
    });
    it('并发云端变化不覆盖；丢失临时会话不会再次弹登录或写入', async () => {
        const f = fixture(); const service = createRemoteConfigSync(f.ports()); const initial = await service.prepare(password); await service.commit(initial.id, password, 'upload', {});
        const preview = await service.prepare(password); await f.replaceCloud({...f.local, to: 'de'}); const updated = f.content;
        await expect(service.commit(preview.id, password, 'upload', {})).rejects.toThrow('云端'); expect(f.content).toBe(updated); expect(f.session).toBeUndefined();
        const pending = await service.prepare(password, 8, 'fixture-ui'); await createDropboxAuth(f.authPorts).disconnect();
        const authorizations = vi.mocked(f.authPorts.identity!.launchWebAuthFlow).mock.calls.length;
        await expect(createRemoteConfigSync(f.ports()).commit(pending.id, password, 'download', {}, 8, 'fixture-ui')).rejects.toThrow('expired');
        expect(vi.mocked(f.authPorts.identity!.launchWebAuthFlow).mock.calls.length).toBe(authorizations); expect(f.content).toBe(updated);
    });
});
