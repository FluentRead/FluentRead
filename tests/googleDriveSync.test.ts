import {describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {driveSyncPayload, parseDriveSyncPayload, toDriveSyncConfig} from '@/src/core/config/driveSync';
import {decryptDriveConfig, encryptDriveConfig} from '@/src/platform/google-drive/encryption';
import {createGoogleDriveSync, type DriveSyncPorts, type DriveSyncState} from '@/src/services/config/googleDriveSync';
import {createRemoteConfigSync} from '@/src/services/config/remoteConfigSync';
import type {DriveRemote} from '@/src/platform/google-drive/api';

const password = 'fixture cross device password';
const owner = {id: 'fixture-account-a', email: 'tester@fixture.invalid'};
function config(patch: Record<string, unknown> = {}) {return toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, ...patch}));}
function fixture(accountChangedError?: string) {
    let local = config({customOpenAIProviders: [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']}], token: {openai: 'fixture-key-a'}, customHeaders: {'custom:fixture': '{"Authorization":"fixture-header-a"}'}, customBody: {openai: '{"auth":"fixture-body-a"}'}, proxy: {openai: 'https://fixture.invalid/?key=fixture-url-a'}, extra: {oauth: 'fixture-oauth-a'}});
    let remote: DriveRemote | null = null;
    let state: unknown = null;
    let account = owner;
    let clock = 1000;
    const session = () => ({account, request: async <T>(operation: (token: string) => Promise<T>) => operation('fixture-auth-token')});
    const ports: DriveSyncPorts = {
        ...(accountChangedError ? {accountChangedError} : {}),
        auth: {availability: vi.fn(() => ({available: true, reason: ''})), open: vi.fn(async () => session()), disconnect: vi.fn(async () => undefined)},
        api: {
            read: vi.fn(async () => remote),
            write: vi.fn(async (_session, content) => {const file = {id: 'fixture-file', version: String(Number(remote?.file.version ?? 0) + 1), modifiedTime: 'fixture-time'}; remote = {file, content}; return file;}),
        },
        snapshot: vi.fn(async () => structuredClone(local)),
        apply: vi.fn(async value => {local = structuredClone(value);}),
        readState: vi.fn(async () => state), writeState: vi.fn(async value => {state = value;}), now: () => clock,
    };
    const service = accountChangedError ? createRemoteConfigSync(ports) : createGoogleDriveSync(ports);
    return {service, ports, get local() {return local;}, set local(value) {local = value;}, get remote() {return remote;}, set remote(value) {remote = value;}, get state() {return state;}, set state(value) {state = value;}, set account(value: typeof owner) {account = value;}, set clock(value: number) {clock = value;}};
}
async function synced() {
    const f = fixture();
    const preview = await f.service.prepare(password);
    await f.service.commit(preview.id, password, 'upload', {});
    return f;
}
describe('Google Drive 同步事务', () => {
    it('微软与谷歌实例的状态、账号、基线独立，静默换号不能确认旧预览', async () => {
        const google = await synced(); const microsoft = fixture('settings.onedrive.accountChanged');
        microsoft.account = {id: 'onedrive:fixture-user', email: 'ms@fixture.invalid'};
        expect(await microsoft.service.status()).toMatchObject({account: null});
        const first = await microsoft.service.prepare(password);
        await microsoft.service.commit(first.id, password, 'upload', {});
        expect(await microsoft.service.status()).toMatchObject({account: {id: 'onedrive:fixture-user'}});
        expect(await google.service.status()).toMatchObject({account: owner});
        const next = await microsoft.service.prepare(password);
        microsoft.account = {id: 'onedrive:another', email: 'other@fixture.invalid'};
        await expect(microsoft.service.commit(next.id, password, 'download', {})).rejects.toThrow('settings.onedrive.accountChanged');
        expect(await google.service.status()).toMatchObject({account: owner});
    });
    it('MV3 后台重启后仍可用口令恢复一次性预览，暂存中没有明文凭据', async () => {
        const first = fixture();
        const initial = await first.service.prepare(password);
        const prepared = first.state as DriveSyncState;
        expect(JSON.stringify(prepared)).not.toMatch(/fixture-key-a|fixture-header-a|fixture-body-a|fixture-oauth-a/u);
        await createGoogleDriveSync(first.ports).commit(initial.id, password, 'upload', {});
        const existing = await first.service.prepare(password);
        await createGoogleDriveSync(first.ports).commit(existing.id, password, 'merge', {});
        expect(first.state).not.toHaveProperty('prepared');
        const second = fixture(); second.remote = first.remote;
        const download = await second.service.prepare(password);
        await createGoogleDriveSync(second.ports).commit(download.id, password, 'download', {});
        expect(second.local).toEqual(first.local);
    });
    it('拒绝损坏预览元数据与被人为延长的过期预览', async () => {
        const f = fixture(); for (const prepared of [null, {}, {id: 1}, {id: 'id'}, {id: 'id', expiresAt: 'bad'}, {id: 'id', expiresAt: 1000}, {id: 'id', expiresAt: 1000, content: 1}]) {
            f.state = {...f.state as DriveSyncState, prepared};
            expect(await f.service.status()).toMatchObject({account: null});
        }
        const preview = await f.service.prepare(password);
        const state = f.state as DriveSyncState;
        f.clock = preview.expiresAt;
        f.state = {...state, prepared: {...state.prepared!, expiresAt: preview.expiresAt + 1000}};
        await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        const next = await f.service.prepare(password);
        const updated = f.state as DriveSyncState;
        f.state = {...updated, prepared: {...updated.prepared!, id: 'different-id'}};
        await expect(f.service.commit('different-id', password, 'upload', {})).rejects.toThrow('失效');
        expect(next.id).not.toBe('different-id');
    });
    it('每次点击只授权一次，结束后清理缓存且保留密文基线与同步时间', async () => {
        const f = fixture();
        expect(await f.service.status()).toMatchObject({account: null});
        expect(f.ports.auth.open).not.toHaveBeenCalled();
        const preview = await f.service.prepare(password);
        expect(f.ports.auth.open).toHaveBeenCalledOnce();
        expect(f.ports.auth.open).toHaveBeenCalledWith(true);
        expect(preview).toMatchObject({hasRemote: false, hasBaseline: false, changes: []});
        expect(f.ports.api.write).not.toHaveBeenCalled();
        expect(await f.service.status()).toMatchObject({account: null});
        expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        expect(await f.service.commit(preview.id, password, 'upload', {})).toMatchObject({account: owner, lastSyncedAt: 1000});
        const persisted = f.state as DriveSyncState;
        for (const secret of ['fixture-key-a', 'fixture-header-a', 'fixture-body-a', 'fixture-url-a', 'fixture-oauth-a', password, 'fixture-auth-token']) {expect(JSON.stringify(persisted)).not.toContain(secret); expect(f.remote!.content).not.toContain(secret);}
        expect(toDriveSyncConfig((await decryptDriveConfig(f.remote!.content, password) as {config: unknown}).config)).toEqual(f.local);
        expect(persisted).toMatchObject({connected: false, accountId: owner.id, lastSyncedAt: 1000});
        expect(f.ports.apply).not.toHaveBeenCalled();
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect(f.ports.auth.open).toHaveBeenCalledTimes(2);
        expect(f.remote).not.toBeNull();
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
        const again = await f.service.prepare(password);
        expect(again.hasBaseline).toBe(true);
        expect(f.ports.auth.open).toHaveBeenLastCalledWith(true);
        await f.service.cancel();
        expect(f.state).toEqual(persisted);
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(2);
    });
    it('第二设备必须明确下载，精确恢复凭据及其删除，口令错误不产生任何写入', async () => {
        const first = await synced();
        const second = fixture();
        second.remote = first.remote;
        second.local = config({token: {openai: 'fixture-other'}, key: 'fixture-remove-me'});
        await expect(second.service.prepare('wrong fixture password')).rejects.toThrow('口令不正确');
        expect(second.ports.apply).not.toHaveBeenCalled();
        expect(second.ports.api.write).not.toHaveBeenCalled();
        const preview = await second.service.prepare(password);
        expect(preview.hasBaseline).toBe(false);
        expect(JSON.stringify(preview)).not.toMatch(/fixture-key-a|fixture-remove-me/u);
        await second.service.commit(preview.id, password, 'download', {});
        expect(second.local).toEqual(first.local);
        expect(second.ports.api.write).not.toHaveBeenCalled();
        await expect(second.service.commit(preview.id, password, 'download', {})).rejects.toThrow('失效');
    });
    it('基于共同基线合并独立设置变化，私密连接冲突必须整组选择', async () => {
        const f = await synced();
        const base = f.local;
        f.local = config({...base, theme: 'dark', token: {openai: 'fixture-local-changed'}, apiKeys: {openai: ['fixture-local-changed']}});
        const remoteConfig = config({...base, to: 'fr', proxy: {openai: 'https://remote.invalid'}});
        f.remote = {file: {...f.remote!.file, version: '2'}, content: await encryptDriveConfig(driveSyncPayload(remoteConfig), password)};
        const preview = await f.service.prepare(password);
        expect(preview.hasBaseline).toBe(true);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突');
        const refreshed = await f.service.prepare(password);
        const choices = Object.fromEntries(refreshed.changes.filter(change => change.conflict).map(change => [change.id, 'remote']));
        await f.service.commit(refreshed.id, password, 'merge', choices);
        expect(f.local).toMatchObject({theme: 'dark', to: 'fr', token: {openai: 'fixture-key-a'}, proxy: {openai: 'https://remote.invalid'}});
        expect((await decryptDriveConfig(f.remote!.content, password) as {config: unknown}).config).toEqual(f.local);
    });
    it('拒绝过期、取消、口令变化、本机修改和账号切换的预览', async () => {
        const f = fixture();
        let preview = await f.service.prepare(password);
        f.clock = preview.expiresAt;
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password);
        await f.service.cancel();
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password);
        await expect(f.service.commit(preview.id, `${password}-changed`, 'upload', {})).rejects.toThrow('口令已修改');
        preview = await f.service.prepare(password);
        f.local = config({...f.local, to: 'de'});
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('本机配置已变化');
        preview = await f.service.prepare(password);
        f.account = {id: 'fixture-account-b', email: 'other@fixture.invalid'};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('账号已切换');
        expect(f.ports.api.write).not.toHaveBeenCalled();
    });
    it('云端新增、删除和修改均使旧预览失效，上传失败保留本机和基线', async () => {
        const f = await synced();
        const baseline = f.state;
        const local = f.local;
        let preview = await f.service.prepare(password);
        f.remote = {...f.remote!, file: {...f.remote!.file, version: '9'}};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('云端配置已变化');
        preview = await f.service.prepare(password);
        f.remote = null;
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('云端配置已变化');
        preview = await f.service.prepare(password);
        f.remote = {file: {id: 'new-file', version: '1', modifiedTime: ''}, content: await encryptDriveConfig(driveSyncPayload(local), password)};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('云端配置已变化');
        preview = await f.service.prepare(password);
        vi.mocked(f.ports.api.write).mockRejectedValueOnce(new Error('fixture upstream secret'));
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow();
        expect(f.local).toEqual(local);
        expect(f.state).toEqual(baseline);
        expect(f.ports.apply).not.toHaveBeenCalled();
    });
    it('本机写入失败先恢复原设置，不把失败记录为同步成功', async () => {
        const f = await synced();
        const local = f.local;
        const baseline = f.state;
        f.remote = {file: {...f.remote!.file, version: '2'}, content: await encryptDriveConfig(driveSyncPayload(config({...local, to: 'de'})), password)};
        const preview = await f.service.prepare(password);
        vi.mocked(f.ports.apply).mockRejectedValueOnce(new Error('fixture storage failure'));
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('已恢复原配置');
        expect(f.local).toEqual(local);
        expect(f.state).toEqual(baseline);
        const again = await f.service.prepare(password);
        vi.mocked(f.ports.apply).mockRejectedValue(new Error('fixture total storage failure'));
        await expect(f.service.commit(again.id, password, 'download', {})).rejects.toThrow('保存和恢复失败');
    });
    it('旧基线无法解密和换账号时不隐含合并；再次同步同账号保留基线', async () => {
        const f = await synced();
        const state = f.state as DriveSyncState;
        f.state = {...state, baseline: 'obsolete plaintext baseline'};
        expect((await f.service.prepare(password)).hasBaseline).toBe(false);
        f.state = state;
        expect((await f.service.prepare(password)).hasBaseline).toBe(true);
        f.account = {id: 'fixture-account-b', email: 'other@fixture.invalid'};
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect((await f.service.prepare(password)).hasBaseline).toBe(false);
        expect(f.state).toMatchObject({accountId: 'fixture-account-b', baseline: '', lastSyncedAt: 1000});
    });
    it('升级为 Drive 账号标识时不能按同邮箱复用旧 OAuth 基线，确认前保留两端配置', async () => {
        const f = await synced();
        const remote = structuredClone(f.remote);
        f.local = {...f.local, to: 'de'};
        const local = structuredClone(f.local);
        const writes = vi.mocked(f.ports.api.write).mock.calls.length;
        f.account = {id: 'drive:fixture-account-a', email: owner.email};
        const preview = await f.service.prepare(password);
        expect(preview.hasBaseline).toBe(false);
        expect(preview.changes.some(change => change.conflict && change.label === '目标语言' && change.local.includes('德语'))).toBe(true);
        expect(f.local).toEqual(local);
        expect(f.remote).toEqual(remote);
        expect(f.ports.api.write).toHaveBeenCalledTimes(writes);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突选择');
        expect(f.local).toEqual(local);
        expect(f.remote).toEqual(remote);
        const confirmed = await f.service.prepare(password);
        await f.service.commit(confirmed.id, password, 'download', {});
        expect(f.state).toMatchObject({accountId: 'drive:fixture-account-a', connected: false});
        expect((await f.service.prepare(password)).hasBaseline).toBe(true);
        await f.service.cancel();
    });
    it('防御未配置浏览器、无效状态、授权失败、已结束事务和不存在的同步方向', async () => {
        const f = fixture();
        for (const state of [[], {}, {version: 2}, {version: 1}, {version: 1, connected: true}, {version: 1, connected: true, accountId: 'a'}, {version: 1, connected: true, accountId: 'a', baseline: ''}, {version: 1, connected: true, accountId: 'a', baseline: '', lastSyncedAt: 'bad'}]) {f.state = state; expect(await f.service.status()).toMatchObject({account: null});}
        vi.mocked(f.ports.auth.availability).mockReturnValueOnce({available: false, reason: 'fixture unsupported'});
        expect(await f.service.status()).toMatchObject({available: false});
        vi.mocked(f.ports.auth.open).mockRejectedValueOnce(new Error('fixture auth failure'));
        await expect(f.service.prepare(password)).rejects.toThrow('fixture auth failure');
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
        let preview = await f.service.prepare(password);
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('无效的同步方向');
        preview = await f.service.prepare(password);
        await f.service.cancel();
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password);
        f.state = {...f.state as DriveSyncState, connected: false};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('授权已结束');
        await expect(f.service.prepare('short')).rejects.toThrow('12');
        await expect(f.service.commit('missing', 'short', 'upload', {})).rejects.toThrow('12');
    });
    it('旧连接及过期事务在状态检查时清理，不发起 Google 请求', async () => {
        const f = await synced();
        const state = f.state as DriveSyncState;
        f.state = {...state, connected: true};
        vi.mocked(f.ports.auth.open).mockClear();
        vi.mocked(f.ports.auth.disconnect).mockClear();
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect(f.ports.auth.open).not.toHaveBeenCalled();
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
        const preview = await f.service.prepare(password);
        f.clock = preview.expiresAt;
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect(f.state).toEqual(state);
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(2);
    });
    it('预览、写入和清理失败都尝试清除授权缓存，原基线不被失败预览替换', async () => {
        const f = await synced();
        const state = f.state;
        vi.mocked(f.ports.api.read).mockRejectedValueOnce(new Error('fixture read failed'));
        await expect(f.service.prepare(password)).rejects.toThrow('fixture read failed');
        expect(f.state).toEqual(state);
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(2);
        vi.mocked(f.ports.readState).mockRejectedValueOnce(new Error('fixture state read failed'));
        await expect(f.service.cancel()).rejects.toThrow('fixture state read failed');
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(3);
        vi.mocked(f.ports.writeState).mockRejectedValueOnce(new Error('fixture state write failed'));
        await expect(f.service.cancel()).rejects.toThrow('fixture state write failed');
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(4);
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cache clear failed'));
        await expect(f.service.cancel()).rejects.toThrow('fixture cache clear failed');
    });
    it('只有所属设置页关闭才取消预览，后台重启后仍能识别所属页签', async () => {
        const f = fixture();
        await f.service.cancelTab(73);
        expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        const preview = await f.service.prepare(password, 73);
        await f.service.cancelTab(74);
        expect((f.state as DriveSyncState).prepared?.id).toBe(preview.id);
        expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        await createGoogleDriveSync(f.ports).cancelTab(73);
        expect(f.state).not.toHaveProperty('prepared');
        expect(f.state).toMatchObject({connected: false});
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
        expect(f.ports.api.write).not.toHaveBeenCalled();
        await expect(f.service.commit(preview.id, password, 'upload', {}, 73)).rejects.toThrow('失效');
    });

    it('无关页面的取消、确认和新预览都不能破坏当前页事务；所属页面仍可确认', async () => {
        const f = fixture();
        const preview = await f.service.prepare(password, 73, 'page-a');
        await f.service.cancel(preview.id, 74, 'page-b');
        await f.service.cancel('obsolete-id', 73, 'page-a');
        await expect(f.service.commit(preview.id, password, 'upload', {}, 74, 'page-b')).rejects.toThrow('其他页面');
        await expect(f.service.commit('obsolete-id', password, 'upload', {}, 73, 'page-a')).rejects.toThrow('失效');
        await expect(f.service.prepare(password, 74, 'page-b')).rejects.toThrow('另一个设置页面');
        expect((f.state as DriveSyncState).prepared?.id).toBe(preview.id);
        expect(f.ports.auth.open).toHaveBeenCalledOnce();
        expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        await createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {}, 73, 'page-a');
        expect(f.ports.api.write).toHaveBeenCalledOnce();
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
    });
    it('没有页签编号也按客户端绑定，取消空事务不清理其他授权，过期事务可由新页面重建', async () => {
        const f = fixture();
        await f.service.cancel(undefined, undefined, 'page-b');
        expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        const first = await f.service.prepare(password, undefined, 'page-a');
        await f.service.cancel(undefined, undefined, 'page-b');
        await expect(f.service.prepare(password, undefined, 'page-b')).rejects.toThrow('另一个设置页面');
        await f.service.cancel(first.id, undefined, 'page-a');
        expect(f.state).not.toHaveProperty('prepared');
        const expiring = await f.service.prepare(password, 73, 'page-a');
        f.clock = expiring.expiresAt;
        const next = await f.service.prepare(password, 74, 'page-b');
        expect(next.id).not.toBe(expiring.id);
        await f.service.cancel(next.id, 74, 'page-b');
    });
    it('删除自定义服务和另一端选择它形成整组冲突，确认后备份可再次读取', async () => {
        const f = await synced();
        const base = f.local;
        const providerId = (base.customOpenAIProviders as {id: string}[])[0].id;
        f.local = config({...base, customOpenAIProviders: []});
        const remoteConfig = config({...base, service: providerId});
        f.remote = {file: {...f.remote!.file, version: '2'}, content: await encryptDriveConfig(driveSyncPayload(remoteConfig), password)};
        const before = structuredClone(f.remote);
        const writes = vi.mocked(f.ports.api.write).mock.calls.length;
        const preview = await f.service.prepare(password);
        expect(preview.changes.some(change => change.conflict && change.sensitive)).toBe(true);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突');
        expect(f.remote).toEqual(before);
        expect(f.ports.api.write).toHaveBeenCalledTimes(writes);
        const retry = await f.service.prepare(password);
        await f.service.commit(retry.id, password, 'merge', Object.fromEntries(retry.changes.map(change => [change.id, 'remote'])));
        expect(parseDriveSyncPayload(await decryptDriveConfig(f.remote!.content, password))).toEqual(remoteConfig);
        expect((await f.service.prepare(password)).hasBaseline).toBe(true);
        await f.service.cancel();
    });
    it('最终快照无效时，在任何云端写入及本机应用之前拒绝', async () => {
        const f = fixture();
        const preview = await f.service.prepare(password);
        const state = f.state as DriveSyncState;
        const saved = await decryptDriveConfig(state.prepared!.content, password) as {local: Record<string, unknown>};
        saved.local = {...saved.local, documentService: 'custom:missing'};
        state.prepared!.content = await encryptDriveConfig(saved, password);
        await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {})).rejects.toThrow('不存在');
        expect(f.ports.api.write).not.toHaveBeenCalled();
        expect(f.ports.apply).not.toHaveBeenCalled();
    });
    it('6MiB 合法请求体首次上传后可再次预览，后台重启后可合并及跨设备恢复', async () => {
        const first = fixture();
        first.local = config({...first.local, customBody: {openai: JSON.stringify({instructions: 'x'.repeat(6 * 1024 * 1024)})}});
        const initial = await first.service.prepare(password);
        await first.service.commit(initial.id, password, 'upload', {});
        const same = await first.service.prepare(password);
        expect(same.changes).toEqual([]);
        const persisted = first.state as DriveSyncState;
        const envelope = await decryptDriveConfig(persisted.prepared!.content, password);
        expect(envelope).not.toHaveProperty('remote');
        expect(envelope).not.toHaveProperty('baseline');
        await createGoogleDriveSync(first.ports).commit(same.id, password, 'merge', {});
        const second = fixture(); second.remote = first.remote;
        const restore = await second.service.prepare(password);
        await createGoogleDriveSync(second.ports).commit(restore.id, password, 'download', {});
        expect(second.local).toEqual(first.local);
        expect(second.ports.api.write).not.toHaveBeenCalled();
    }, 30_000);

    it('成功同步记录账号，重开不授权；换号取消或失败仍保留上次成功记录', async () => {
        const f = await synced();
        vi.mocked(f.ports.auth.open).mockClear();
        expect(await createGoogleDriveSync(f.ports).status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect(f.ports.auth.open).not.toHaveBeenCalled();
        f.account = {id: 'fixture-account-b', email: 'b@fixture.invalid'};
        const pending = await f.service.prepare(password, 1, 'owner');
        expect(pending.account.email).toBe('b@fixture.invalid');
        await f.service.cancel(pending.id, 1, 'owner');
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        vi.mocked(f.ports.auth.open).mockRejectedValueOnce(new Error('fixture-cancelled-authorization'));
        await expect(f.service.prepare(password, 1, 'owner')).rejects.toThrow('fixture-cancelled-authorization');
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        const next = await f.service.prepare(password, 1, 'owner');
        await f.service.commit(next.id, password, 'download', {}, 1, 'owner');
        expect(await f.service.status()).toMatchObject({account: {id: 'fixture-account-b', email: 'b@fixture.invalid'}});
    });
    it('旧版缺少账号记录仍显示时间，损坏记录不会进入界面', async () => {
        const f = fixture();
        const state = {version: 1, connected: false, accountId: 'old', baseline: '', lastSyncedAt: 1000};
        for (const lastSyncedAccount of [undefined, null, {}, {id: 'bad'}, {id: 1, email: 'bad'}, {id: 'bad', email: 1}]) {
            f.state = {...state, lastSyncedAccount};
            expect(await f.service.status()).toMatchObject({account: null, lastSyncedAt: 1000});
        }
        f.account = {id: 'new', email: ''};
        await f.service.prepare(password);
        expect(await f.service.status()).toMatchObject({account: null, lastSyncedAt: 1000});
    });

});
