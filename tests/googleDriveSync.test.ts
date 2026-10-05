import {describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {driveSyncPayload as completePayload, parseDriveSyncPayload, toDriveSyncConfig, projectDriveSyncConfig} from '@/src/core/config/driveSync';
import {decryptDriveConfig, encryptDriveConfig} from '@/src/platform/google-drive/encryption';
import {createGoogleDriveSync, type DriveSyncPorts, type DriveSyncState} from '@/src/services/config/googleDriveSync';
import type {DriveRemote} from '@/src/platform/google-drive/api';

// 旧完整备份回归使用明确完整范围，默认普通范围另行覆盖。
const driveSyncPayload = (config: Record<string, unknown>) => completePayload(config, true);
const password = 'fixture cross device password';
const owner = {id: 'fixture-account-a', email: 'tester@fixture.invalid'};
function config(patch: Record<string, unknown> = {}) {return toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, ...patch}));}
function fixture() {
    let local = config({customOpenAIProviders: [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']}], token: {openai: 'fixture-key-a'}, customHeaders: {'custom:fixture': '{"Authorization":"fixture-header-a"}'}, customBody: {openai: '{"auth":"fixture-body-a"}'}, proxy: {openai: 'https://fixture.invalid/?key=fixture-url-a'}, extra: {oauth: 'fixture-oauth-a'}});
    let remote: DriveRemote | null = null;
    let state: unknown = null;
    let account = owner;
    let clock = 1000;
    const session = () => ({account, request: async <T>(operation: (token: string) => Promise<T>) => operation('fixture-auth-token')});
    const ports: DriveSyncPorts = {
        auth: {availability: vi.fn(() => ({available: true, reason: ''})), open: vi.fn(async () => session()), disconnect: vi.fn(async () => undefined)},
        api: {
            read: vi.fn(async () => remote),
            remove: vi.fn(async () => {remote = null;}),
            write: vi.fn(async (_session, content) => {const file = {id: 'fixture-file', version: String(Number(remote?.file.version ?? 0) + 1), modifiedTime: 'fixture-time'}; remote = {file, content}; return file;}),
        },
        snapshot: vi.fn(async () => structuredClone(local)),
        apply: vi.fn(async value => {local = structuredClone(value);}),
        readState: vi.fn(async () => state), writeState: vi.fn(async value => {state = value;}), now: () => clock,
    };
    const service = createGoogleDriveSync(ports);
    return {service, ports, get local() {return local;}, set local(value) {local = value;}, get remote() {return remote;}, set remote(value) {remote = value;}, get state() {return state;}, set state(value) {state = value;}, set account(value: typeof owner) {account = value;}, set clock(value: number) {clock = value;}};
}
async function synced() {
    const f = fixture();
    const preview = await f.service.prepare(password, undefined, undefined, true);
    await f.service.commit(preview.id, password, 'upload', {});
    return f;
}
describe('Google Drive 同步事务', () => {
    it('只读备份仍展示差异并可在后台重启后恢复，伪造保存请求也不能写入云端', async () => {
        const f=await synced();
        const originalTarget=f.local.to;
        f.remote={...f.remote!,file:{...f.remote!.file,readOnly:true}};
        f.local=config({...f.local,to:'de'});
        const original=f.remote.content;
        let preview=await f.service.prepare(password, undefined, undefined, true);
        expect(preview).toMatchObject({canUpload:false,hasRemote:true});
        expect(preview.changes.some(change=>change.label==='目标语言')).toBe(true);
        await expect(f.service.commit(preview.id,password,'upload',{})).rejects.toThrow('安全覆盖');
        expect(f.ports.api.write).toHaveBeenCalledTimes(1);
        preview=await f.service.prepare(password, undefined, undefined, true);
        await createGoogleDriveSync(f.ports).commit(preview.id,password,'download',{});
        expect(f.local.to).toBe(originalTarget);
        expect(f.remote.content).toBe(original);
        expect(f.ports.api.write).toHaveBeenCalledTimes(1);
    });
    it('成功同步后清理授权失败不会被误报为同步失败，状态检查会重试清理', async () => {
        const f=fixture(); const preview=await f.service.prepare(password, undefined, undefined, true);
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cache failure'));
        await expect(f.service.commit(preview.id,password,'upload',{})).resolves.toMatchObject({lastSyncedAt:1000,cleanupPending:true});
        expect(f.ports.api.write).toHaveBeenCalledOnce();
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture repeated cache failure'));
        expect(await f.service.status()).toMatchObject({lastSyncedAt:1000,cleanupPending:true});
        expect(await f.service.status()).not.toHaveProperty('cleanupPending');
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(3);
    });
    it('清理同时失败时保留读取或写入失败的原始原因', async () => {
        const f=fixture();
        vi.mocked(f.ports.api.read).mockRejectedValueOnce(new Error('fixture read failure'));
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cleanup failure'));
        await expect(f.service.prepare(password, undefined, undefined, true)).rejects.toThrow('fixture read failure');
    });
    it('配置一致或合并结果等于云端时只更新基线，不重复写入备份', async () => {
        const f=await synced();
        for (const direction of ['upload','merge'] as const) {
            const preview=await f.service.prepare(password, undefined, undefined, true);
            await f.service.commit(preview.id,password,direction,{});
            expect(f.ports.api.write).toHaveBeenCalledTimes(1);
            expect((f.state as DriveSyncState).baseline).toBe(f.remote!.content);
        }
        f.local=config({...f.local,to:'de'});
        const preview=await f.service.prepare(password, undefined, undefined, true);
        await f.service.commit(preview.id,password,'merge',Object.fromEntries(preview.changes.map(change=>[change.id,'remote'])));
        expect(f.ports.api.write).toHaveBeenCalledTimes(1);
        expect(f.local.to).not.toBe('de');
    });
    it('MV3 后台重启后仍可用口令恢复一次性预览，暂存中没有明文凭据', async () => {
        const first = fixture();
        const initial = await first.service.prepare(password, undefined, undefined, true);
        const prepared = first.state as DriveSyncState;
        expect(JSON.stringify(prepared)).not.toMatch(/fixture-key-a|fixture-header-a|fixture-body-a|fixture-oauth-a/u);
        await createGoogleDriveSync(first.ports).commit(initial.id, password, 'upload', {});
        const existing = await first.service.prepare(password, undefined, undefined, true);
        await createGoogleDriveSync(first.ports).commit(existing.id, password, 'merge', {});
        expect(first.state).not.toHaveProperty('prepared');
        const second = fixture(); second.remote = first.remote;
        const download = await second.service.prepare(password, undefined, undefined, true);
        await createGoogleDriveSync(second.ports).commit(download.id, password, 'download', {});
        expect(second.local).toEqual(first.local);
    });
    it('拒绝损坏预览元数据与被人为延长的过期预览', async () => {
        const f = fixture(); for (const prepared of [null, {}, {id: 1}, {id: 'id'}, {id: 'id', expiresAt: 'bad'}, {id: 'id', expiresAt: 1000}, {id: 'id', expiresAt: 1000, content: 1}]) {
            f.state = {...f.state as DriveSyncState, prepared};
            expect(await f.service.status()).toMatchObject({account: null});
        }
        const preview = await f.service.prepare(password, undefined, undefined, true);
        const state = f.state as DriveSyncState;
        f.clock = preview.expiresAt;
        f.state = {...state, prepared: {...state.prepared!, expiresAt: preview.expiresAt + 1000}};
        await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        const next = await f.service.prepare(password, undefined, undefined, true);
        const updated = f.state as DriveSyncState;
        f.state = {...updated, prepared: {...updated.prepared!, id: 'different-id'}};
        await expect(f.service.commit('different-id', password, 'upload', {})).rejects.toThrow('失效');
        expect(next.id).not.toBe('different-id');
    });
    it('每次点击只授权一次，结束后清理缓存且保留密文基线与同步时间', async () => {
        const f = fixture();
        expect(await f.service.status()).toMatchObject({account: null});
        expect(f.ports.auth.open).not.toHaveBeenCalled();
        const preview = await f.service.prepare(password, undefined, undefined, true);
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
        const again = await f.service.prepare(password, undefined, undefined, true);
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
        await expect(second.service.prepare('wrong fixture password', undefined, undefined, true)).rejects.toThrow('口令不正确');
        expect(second.ports.apply).not.toHaveBeenCalled();
        expect(second.ports.api.write).not.toHaveBeenCalled();
        const preview = await second.service.prepare(password, undefined, undefined, true);
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
        const preview = await f.service.prepare(password, undefined, undefined, true);
        expect(preview.hasBaseline).toBe(true);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突');
        const refreshed = await f.service.prepare(password, undefined, undefined, true);
        const choices = Object.fromEntries(refreshed.changes.filter(change => change.conflict).map(change => [change.id, 'remote']));
        await f.service.commit(refreshed.id, password, 'merge', choices);
        expect(f.local).toMatchObject({theme: 'dark', to: 'fr', token: {openai: 'fixture-key-a'}, proxy: {openai: 'https://remote.invalid'}});
        expect((await decryptDriveConfig(f.remote!.content, password) as {config: unknown}).config).toEqual(f.local);
    });
    it('拒绝过期、取消、口令变化、本机修改和账号切换的预览', async () => {
        const f = fixture();
        let preview = await f.service.prepare(password, undefined, undefined, true);
        f.clock = preview.expiresAt;
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password, undefined, undefined, true);
        await f.service.cancel();
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password, undefined, undefined, true);
        await expect(f.service.commit(preview.id, `${password}-changed`, 'upload', {})).rejects.toThrow('口令已修改');
        preview = await f.service.prepare(password, undefined, undefined, true);
        f.local = config({...f.local, to: 'de'});
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('本机配置已变化');
        preview = await f.service.prepare(password, undefined, undefined, true);
        f.account = {id: 'fixture-account-b', email: 'other@fixture.invalid'};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('账号已切换');
        expect(f.ports.api.write).not.toHaveBeenCalled();
    });
    it('云端新增、删除和修改均使旧预览失效，上传失败保留本机和基线', async () => {
        const f = await synced();
        const baseline = f.state;
        const local = f.local;
        let preview = await f.service.prepare(password, undefined, undefined, true);
        f.remote = {...f.remote!, file: {...f.remote!.file, version: '9'}};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('云端配置已变化');
        preview = await f.service.prepare(password, undefined, undefined, true);
        f.remote = null;
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('云端配置已变化');
        preview = await f.service.prepare(password, undefined, undefined, true);
        f.remote = {file: {id: 'new-file', version: '1', modifiedTime: ''}, content: await encryptDriveConfig(driveSyncPayload(local), password)};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('云端配置已变化');
        f.remote = {...f.remote!, content: await encryptDriveConfig(driveSyncPayload(config({...local, to:'de'})), password)};
        preview = await f.service.prepare(password, undefined, undefined, true);
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
        const preview = await f.service.prepare(password, undefined, undefined, true);
        vi.mocked(f.ports.apply).mockRejectedValueOnce(new Error('fixture storage failure'));
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('已恢复原配置');
        expect(f.local).toEqual(local);
        expect(f.state).toEqual(baseline);
        const again = await f.service.prepare(password, undefined, undefined, true);
        vi.mocked(f.ports.apply).mockRejectedValue(new Error('fixture total storage failure'));
        await expect(f.service.commit(again.id, password, 'download', {})).rejects.toThrow('保存和恢复失败');
    });
    it('旧基线无法解密和换账号时不隐含合并；再次同步同账号保留基线', async () => {
        const f = await synced();
        const state = f.state as DriveSyncState;
        f.state = {...state, baseline: 'obsolete plaintext baseline'};
        expect((await f.service.prepare(password, undefined, undefined, true)).hasBaseline).toBe(false);
        f.state = state;
        expect((await f.service.prepare(password, undefined, undefined, true)).hasBaseline).toBe(true);
        f.account = {id: 'fixture-account-b', email: 'other@fixture.invalid'};
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect((await f.service.prepare(password, undefined, undefined, true)).hasBaseline).toBe(false);
        expect(f.state).toMatchObject({accountId: 'fixture-account-b', baseline: '', lastSyncedAt: 1000});
    });
    it('升级为 Drive 账号标识时不能按同邮箱复用旧 OAuth 基线，确认前保留两端配置', async () => {
        const f = await synced();
        const remote = structuredClone(f.remote);
        f.local = {...f.local, to: 'de'};
        const local = structuredClone(f.local);
        const writes = vi.mocked(f.ports.api.write).mock.calls.length;
        f.account = {id: 'drive:fixture-account-a', email: owner.email};
        const preview = await f.service.prepare(password, undefined, undefined, true);
        expect(preview.hasBaseline).toBe(false);
        expect(preview.changes.some(change => change.conflict && change.label === '目标语言' && change.local.includes('德语'))).toBe(true);
        expect(f.local).toEqual(local);
        expect(f.remote).toEqual(remote);
        expect(f.ports.api.write).toHaveBeenCalledTimes(writes);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突选择');
        expect(f.local).toEqual(local);
        expect(f.remote).toEqual(remote);
        const confirmed = await f.service.prepare(password, undefined, undefined, true);
        await f.service.commit(confirmed.id, password, 'download', {});
        expect(f.state).toMatchObject({accountId: 'drive:fixture-account-a', connected: false});
        expect((await f.service.prepare(password, undefined, undefined, true)).hasBaseline).toBe(true);
        await f.service.cancel();
    });
    it('防御未配置浏览器、无效状态、授权失败、已结束事务和不存在的同步方向', async () => {
        const f = fixture();
        for (const state of [[], {}, {version: 2}, {version: 1}, {version: 1, connected: true}, {version: 1, connected: true, accountId: 'a'}, {version: 1, connected: true, accountId: 'a', baseline: ''}, {version: 1, connected: true, accountId: 'a', baseline: '', lastSyncedAt: 'bad'}]) {f.state = state; expect(await f.service.status()).toMatchObject({account: null});}
        vi.mocked(f.ports.auth.availability).mockReturnValueOnce({available: false, reason: 'fixture unsupported'});
        expect(await f.service.status()).toMatchObject({available: false});
        vi.mocked(f.ports.auth.open).mockRejectedValueOnce(new Error('fixture auth failure'));
        await expect(f.service.prepare(password, undefined, undefined, true)).rejects.toThrow('fixture auth failure');
        expect(f.ports.auth.disconnect).toHaveBeenCalledOnce();
        let preview = await f.service.prepare(password, undefined, undefined, true);
        await expect(f.service.commit(preview.id, password, 'download', {})).rejects.toThrow('无效的同步方向');
        preview = await f.service.prepare(password, undefined, undefined, true);
        await f.service.cancel();
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('失效');
        preview = await f.service.prepare(password, undefined, undefined, true);
        f.state = {...f.state as DriveSyncState, connected: false};
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('授权已结束');
        await expect(f.service.prepare('short', undefined, undefined, true)).rejects.toThrow('12');
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
        const preview = await f.service.prepare(password, undefined, undefined, true);
        f.clock = preview.expiresAt;
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        expect(f.state).toEqual(state);
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(2);
    });
    it('预览、写入和清理失败都尝试清除授权缓存，原基线不被失败预览替换', async () => {
        const f = await synced();
        const state = f.state;
        vi.mocked(f.ports.api.read).mockRejectedValueOnce(new Error('fixture read failed'));
        await expect(f.service.prepare(password, undefined, undefined, true)).rejects.toThrow('fixture read failed');
        expect(f.state).toEqual(state);
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(2);
        vi.mocked(f.ports.readState).mockRejectedValueOnce(new Error('fixture state read failed'));
        await expect(f.service.cancel()).rejects.toThrow('fixture state read failed');
        expect(f.ports.auth.disconnect).toHaveBeenCalledTimes(3);
        f.state = {...f.state as DriveSyncState, connected:true};
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
        const preview = await f.service.prepare(password,  73, undefined, true);
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
        const preview = await f.service.prepare(password,  73,  'page-a', true);
        await f.service.cancel(preview.id, 74, 'page-b');
        await f.service.cancel('obsolete-id', 73, 'page-a');
        await expect(f.service.commit(preview.id, password, 'upload', {}, 74, 'page-b')).rejects.toThrow('其他页面');
        await expect(f.service.commit('obsolete-id', password, 'upload', {}, 73, 'page-a')).rejects.toThrow('失效');
        await expect(f.service.prepare(password,  74,  'page-b', true)).rejects.toThrow('另一个设置页面');
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
        const first = await f.service.prepare(password,  undefined,  'page-a', true);
        await f.service.cancel(undefined, undefined, 'page-b');
        await expect(f.service.prepare(password,  undefined,  'page-b', true)).rejects.toThrow('另一个设置页面');
        await f.service.cancel(first.id, undefined, 'page-a');
        expect(f.state).not.toHaveProperty('prepared');
        const expiring = await f.service.prepare(password,  73,  'page-a', true);
        f.clock = expiring.expiresAt;
        const next = await f.service.prepare(password,  74,  'page-b', true);
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
        const preview = await f.service.prepare(password, undefined, undefined, true);
        expect(preview.changes.some(change => change.conflict && change.sensitive)).toBe(true);
        await expect(f.service.commit(preview.id, password, 'merge', {})).rejects.toThrow('每个冲突');
        expect(f.remote).toEqual(before);
        expect(f.ports.api.write).toHaveBeenCalledTimes(writes);
        const retry = await f.service.prepare(password, undefined, undefined, true);
        await f.service.commit(retry.id, password, 'merge', Object.fromEntries(retry.changes.map(change => [change.id, 'remote'])));
        expect(parseDriveSyncPayload(await decryptDriveConfig(f.remote!.content, password))).toEqual(remoteConfig);
        expect((await f.service.prepare(password, undefined, undefined, true)).hasBaseline).toBe(true);
        await f.service.cancel();
    });
    it('最终快照无效时，在任何云端写入及本机应用之前拒绝', async () => {
        const f = fixture();
        const preview = await f.service.prepare(password, undefined, undefined, true);
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
        const initial = await first.service.prepare(password, undefined, undefined, true);
        await first.service.commit(initial.id, password, 'upload', {});
        const same = await first.service.prepare(password, undefined, undefined, true);
        expect(same.changes).toEqual([]);
        const persisted = first.state as DriveSyncState;
        const envelope = await decryptDriveConfig(persisted.prepared!.content, password);
        expect(envelope).not.toHaveProperty('remote');
        expect(envelope).not.toHaveProperty('baseline');
        await createGoogleDriveSync(first.ports).commit(same.id, password, 'merge', {});
        const second = fixture(); second.remote = first.remote;
        const restore = await second.service.prepare(password, undefined, undefined, true);
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
        const pending = await f.service.prepare(password,  1,  'owner', true);
        expect(pending.account.email).toBe('b@fixture.invalid');
        await f.service.cancel(pending.id, 1, 'owner');
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        vi.mocked(f.ports.auth.open).mockRejectedValueOnce(new Error('fixture-cancelled-authorization'));
        await expect(f.service.prepare(password,  1,  'owner', true)).rejects.toThrow('fixture-cancelled-authorization');
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: 1000});
        const next = await f.service.prepare(password,  1,  'owner', true);
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
        await f.service.prepare(password, undefined, undefined, true);
        expect(await f.service.status()).toMatchObject({account: null, lastSyncedAt: 1000});
    });

});

describe('云备份删除确认事务', () => {
    function backup(f: ReturnType<typeof fixture>, content = 'broken or future encrypted backup') {
        f.remote = {file: {id: 'fixture-backup', version: '1', modifiedTime: 'fixture-time', etag: '"one"'}, content};
    }
    it('损坏、未知格式与旧完整备份可删除，重启后仅删除确认的文件并清除基线，本机凭据保持不变', async () => {
        for (const content of ['broken backup', JSON.stringify({version: 99}), await encryptDriveConfig(driveSyncPayload(config()), password)]) {
            const f = await synced(); backup(f, content);
            const previous = structuredClone(f.local);
            vi.mocked(f.ports.snapshot).mockClear(); vi.mocked(f.ports.apply).mockClear();
            const preview = await f.service.prepareDelete(7, 'page-a');
            expect(preview).toMatchObject({account: owner, hasRemote: true, canDelete: true});
            expect(f.ports.api.remove).not.toHaveBeenCalled();
            expect(f.state).toMatchObject({prepared: {operation: 'delete', content: ''}});
            expect(JSON.stringify(f.state)).not.toContain('fixture-key-a');
            expect(await createGoogleDriveSync(f.ports).commitDelete(preview.id, 7, 'page-a')).toMatchObject({deleted: true, account: null, lastSyncedAt: null});
            expect(f.remote).toBeNull();
            expect(f.state).toEqual({version: 1, connected: false, accountId: '', baseline: '', lastSyncedAt: null});
            expect(f.local).toEqual(previous);
            expect(f.ports.snapshot).not.toHaveBeenCalled(); expect(f.ports.apply).not.toHaveBeenCalled();
            await expect(f.service.commitDelete(preview.id, 7, 'page-a')).rejects.toThrow('失效');
            const fresh = await f.service.prepare(password);
            expect(fresh).toMatchObject({hasRemote: false, hasBaseline: false, includeSensitive: false});
            await f.service.cancel(fresh.id);
        }
    });
    it('取消和关闭所属页签只结束授权，保留云端数据与上次同步记录', async () => {
        const f = await synced(); backup(f);
        const original = structuredClone(f.remote); const baseline = f.state as DriveSyncState;
        let preview = await f.service.prepareDelete(7, 'page-a');
        await f.service.cancel(preview.id, 8, 'page-b'); expect((f.state as DriveSyncState).prepared?.id).toBe(preview.id);
        await f.service.cancel(preview.id, 7, 'page-a');
        preview = await f.service.prepareDelete(7, 'page-a'); await createGoogleDriveSync(f.ports).cancelTab(7);
        expect(f.remote).toEqual(original); expect(f.ports.api.remove).not.toHaveBeenCalled();
        expect(await f.service.status()).toMatchObject({account: owner, lastSyncedAt: baseline.lastSyncedAt});
        expect((f.state as DriveSyncState).baseline).toBe(baseline.baseline);
        await expect(f.service.commitDelete(preview.id, 7, 'page-a')).rejects.toThrow('失效');
    });
    it('空备份与确认前已经删除都幂等完成，但空预览后新建的文件必须重新确认', async () => {
        const f = await synced(); f.remote = null;
        let preview = await f.service.prepareDelete(); expect(preview).toMatchObject({hasRemote: false, canDelete: true});
        expect(await f.service.commitDelete(preview.id)).toMatchObject({deleted: false, account: null, lastSyncedAt: null});
        backup(f); preview = await f.service.prepareDelete(); f.remote = null;
        expect(await f.service.commitDelete(preview.id)).toMatchObject({deleted: false});
        expect(f.ports.api.remove).not.toHaveBeenCalled();
        preview = await f.service.prepareDelete(); backup(f);
        await expect(f.service.commitDelete(preview.id)).rejects.toThrow('云端备份已变化');
        expect(f.ports.api.remove).not.toHaveBeenCalled(); expect(f.remote).not.toBeNull();
    });
    it('另一页面、另一个确认 ID、账号切换与过期事务不能删除或夺取正在预览的授权', async () => {
        const f = fixture(); backup(f);
        let preview = await f.service.prepareDelete(7, 'page-a');
        await expect(f.service.prepareDelete(8, 'page-b')).rejects.toThrow('另一个设置页面');
        for (const [id, tabId, clientId] of [[preview.id, 8, 'page-b'], ['wrong-id', 7, 'page-a']] as const) await expect(f.service.commitDelete(id, tabId, clientId)).rejects.toThrow('其他页面');
        expect((f.state as DriveSyncState).prepared?.id).toBe(preview.id); expect(f.ports.auth.disconnect).not.toHaveBeenCalled();
        f.account = {id: 'account-b', email: 'b@fixture.invalid'};
        await expect(f.service.commitDelete(preview.id, 7, 'page-a')).rejects.toThrow('目标账号');
        preview = await f.service.prepareDelete(7, 'page-a'); f.clock = preview.expiresAt;
        await expect(f.service.commitDelete(preview.id, 7, 'page-a')).rejects.toThrow('失效');
        expect(f.ports.api.remove).not.toHaveBeenCalled();
    });
    it('同步与删除确认不能混用，也不能绕过缺失删除元数据或已经结束的会话', async () => {
        const f = fixture(); backup(f);
        let preview = await f.service.prepareDelete();
        await expect(f.service.commit(preview.id, password, 'upload', {})).rejects.toThrow('范围');
        f.remote = null;
        const sync = await f.service.prepare(password);
        await expect(f.service.commitDelete(sync.id)).rejects.toThrow('失效');
        for (const patch of [{prepared: undefined}, {connected: false}, {deletion: undefined}]) {
            preview = await f.service.prepareDelete();
            const state = f.state as DriveSyncState;
            f.state = 'deletion' in patch ? {...state, prepared: {...state.prepared!, deletion: undefined}} : {...state, ...patch};
            await expect(f.service.commitDelete(preview.id)).rejects.toThrow('失效');
        }
        expect(f.ports.api.remove).not.toHaveBeenCalled();
    });
    it('身份、密文、版本或 ETag 变化都需要重新确认，缺少强版本只提供手动清理', async () => {
        for (const patch of [{id: 'other-file'}, {version: '2'}, {etag: '"two"'}]) {
            const f = fixture(); backup(f); const preview = await f.service.prepareDelete();
            f.remote = {...f.remote!, file: {...f.remote!.file, ...patch}};
            await expect(f.service.commitDelete(preview.id)).rejects.toThrow('云端备份已变化'); expect(f.ports.api.remove).not.toHaveBeenCalled();
        }
        const f = fixture(); backup(f); const preview = await f.service.prepareDelete(); f.remote = {...f.remote!, content: 'updated backup'};
        await expect(f.service.commitDelete(preview.id)).rejects.toThrow('云端备份已变化');
        for (const patch of [{etag: undefined}, {etag: 'W/"one"'}, {readOnly: true as const}]) {
            backup(f); f.remote = {...f.remote!, file: {...f.remote!.file, ...patch}};
            const blocked = await f.service.prepareDelete(); expect(blocked.canDelete).toBe(false);
            await expect(f.service.commitDelete(blocked.id)).rejects.toThrow('安全删除');
        }
        expect(f.ports.api.remove).not.toHaveBeenCalled();
    });
    it('读取、删除或回读失败不清除成功记录，原始错误不被授权清理错误掩盖', async () => {
        const f = await synced(); backup(f); const baseline = (f.state as DriveSyncState).baseline;
        vi.mocked(f.ports.api.read).mockRejectedValueOnce(new Error('fixture read failure'));
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cleanup failure'));
        await expect(f.service.prepareDelete()).rejects.toThrow('fixture read failure');
        let preview = await f.service.prepareDelete(); vi.mocked(f.ports.api.remove).mockRejectedValueOnce(new Error('fixture remove failure'));
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cleanup failure'));
        await expect(f.service.commitDelete(preview.id)).rejects.toThrow('fixture remove failure');
        expect((f.state as DriveSyncState).baseline).toBe(baseline); expect(f.remote).not.toBeNull();
        preview = await f.service.prepareDelete(); vi.mocked(f.ports.api.remove).mockResolvedValueOnce(undefined);
        await expect(f.service.commitDelete(preview.id)).rejects.toThrow('删除后仍检测到');
        expect((f.state as DriveSyncState).lastSyncedAt).toBe(1000);
        preview = await f.service.prepareDelete(); vi.mocked(f.ports.writeState).mockRejectedValueOnce(new Error('fixture storage failure'));
        const calls = vi.mocked(f.ports.api.remove).mock.calls.length;
        await expect(f.service.commitDelete(preview.id)).rejects.toThrow('fixture storage failure');
        expect(f.ports.api.remove).toHaveBeenCalledTimes(calls);
    });
    it('确认删除后授权清理失败只提示缓存未清理，不能误报备份仍存在', async () => {
        const f = fixture(); backup(f); const preview = await f.service.prepareDelete();
        vi.mocked(f.ports.auth.disconnect).mockRejectedValueOnce(new Error('fixture cleanup failure'));
        expect(await f.service.commitDelete(preview.id)).toMatchObject({deleted: true, cleanupPending: true, account: null, lastSyncedAt: null});
        expect(f.remote).toBeNull(); expect(await f.service.status()).not.toHaveProperty('cleanupPending');
    });
});


describe('单次敏感范围事务', () => {
    it('默认普通上传在 worker 重启后也只写 v2，原始本机秘密完整保留', async () => {
        const f = fixture();
        const original = structuredClone(f.local);
        const preview = await f.service.prepare(password);
        expect(preview).toMatchObject({includeSensitive: false, remoteIncludesSensitive: false});
        expect((f.state as DriveSyncState).prepared).toMatchObject({scope: 'settings'});
        await createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {});
        const payload = await decryptDriveConfig(f.remote!.content, password) as {version: number; scope: string; config: Record<string, unknown>};
        expect(payload).toMatchObject({version: 2, scope: 'settings'});
        expect(payload.config).toEqual(projectDriveSyncConfig(original));
        expect(JSON.stringify(payload)).not.toMatch(/fixture-key-a|fixture-header-a|fixture-body-a|fixture-url-a|fixture-oauth-a/u);
        expect(f.local).toEqual(original);
        expect(f.ports.apply).not.toHaveBeenCalled();
    });
    it.each(['download', 'merge'] as const)('旧 v1 的默认 %s 保护本机连接和私密字段；download 保留云端秘密', async direction => {
        const f = fixture();
        f.local = config({...f.local, token: {openai: 'fixture-local-key'}, proxy: {openai: 'https://local.fixture.invalid'}, inputBoxTranslationPrompt: 'fixture-local-prompt'});
        const local = structuredClone(f.local);
        const remoteConfig = config({...local, to: 'de', service: 'bing', token: {}, apiKeys: {}, proxy: {openai: 'https://remote.fixture.invalid'}, inputBoxTranslationPrompt: 'fixture-cloud-prompt'});
        f.remote = {file: {id: 'fixture-file', version: '1', modifiedTime: ''}, content: await encryptDriveConfig(completePayload(remoteConfig, true), password)};
        const oldCloud = f.remote.content;
        const preview = await f.service.prepare(password);
        expect(preview).toMatchObject({includeSensitive: false, remoteIncludesSensitive: true});
        expect(preview.changes.every(change => change.label !== '翻译连接与凭据（整组）')).toBe(true);
        await createGoogleDriveSync(f.ports).commit(preview.id, password, direction, Object.fromEntries(preview.changes.map(change => [change.id, 'remote'])));
        expect(f.local).toMatchObject({to: 'de', service: local.service, token: local.token, apiKeys: local.apiKeys, proxy: local.proxy, inputBoxTranslationPrompt: local.inputBoxTranslationPrompt});
        if (direction === 'download') {
            expect(f.ports.api.write).not.toHaveBeenCalled();
            expect(f.remote!.content).toBe(oldCloud);
            expect((f.state as DriveSyncState).baseline).toBe(oldCloud);
        } else expect(await decryptDriveConfig(f.remote!.content, password)).toMatchObject({version: 2, scope: 'settings'});
    });
    it.each(['download', 'merge'] as const)('同意敏感信息也不能把普通远端 %s 当作完整连接删除', async direction => {
        const f = fixture();
        const local = structuredClone(f.local);
        f.remote = {file: {id: 'fixture-file', version: '1', modifiedTime: ''}, content: await encryptDriveConfig(completePayload({...local, to: 'de'}), password)};
        const preview = await f.service.prepare(password, undefined, undefined, true);
        expect(preview).toMatchObject({includeSensitive: true, remoteIncludesSensitive: false});
        await createGoogleDriveSync(f.ports).commit(preview.id, password, direction, Object.fromEntries(preview.changes.map(change => [change.id, 'remote'])));
        expect(f.local).toEqual({...local, to: 'de'});
        const payload = await decryptDriveConfig(f.remote!.content, password) as {version: number; config: Record<string, unknown>};
        if (direction === 'merge') expect(payload).toMatchObject({version: 1, config: {token: local.token}});
        else {expect(payload.version).toBe(2); expect(f.ports.api.write).not.toHaveBeenCalled();}
    });
    it('范围切换投影基线，普通设置完全一致时仍覆盖旧云秘密，重新同意才能上传完整快照', async () => {
        const f = await synced();
        const preview = await f.service.prepare(password);
        expect(preview).toMatchObject({includeSensitive: false, remoteIncludesSensitive: true, hasBaseline: true, changes: []});
        await createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {});
        expect(await decryptDriveConfig(f.remote!.content, password)).toMatchObject({version: 2, scope: 'settings'});
        expect(f.ports.api.write).toHaveBeenCalledTimes(2);
        const normal = await f.service.prepare(password);
        expect(normal).toMatchObject({includeSensitive: false, remoteIncludesSensitive: false, hasBaseline: true, changes: []});
        await f.service.commit(normal.id, password, 'merge', {});
        expect(f.ports.api.write).toHaveBeenCalledTimes(2);
        const full = await f.service.prepare(password, undefined, undefined, true);
        expect(full).toMatchObject({includeSensitive: true, remoteIncludesSensitive: false, hasBaseline: true});
        await createGoogleDriveSync(f.ports).commit(full.id, password, 'upload', {});
        expect(await decryptDriveConfig(f.remote!.content, password)).toMatchObject({version: 1, config: {token: f.local.token}});
        const reset = await f.service.prepare(password);
        expect(reset.includeSensitive).toBe(false);
        await f.service.cancel();
    });
    it('普通基线遇到完整云端时不对敏感字段给出错误自动建议', async () => {
        const f = fixture();
        const first = await f.service.prepare(password);
        await f.service.commit(first.id, password, 'upload', {});
        f.remote = {...f.remote!, content: await encryptDriveConfig(completePayload(config({...f.local, token: {}, apiKeys: {}}), true), password)};
        const full = await f.service.prepare(password, undefined, undefined, true);
        expect(full.hasBaseline).toBe(false);
        expect(full.changes.some(change => change.conflict && change.label === '翻译连接与凭据（整组）')).toBe(true);
        await createGoogleDriveSync(f.ports).commit(full.id, password, 'download', {});
        expect(f.local.token).toEqual({});
        expect(f.local.apiKeys).toEqual({});
        expect(f.ports.api.write).toHaveBeenCalledTimes(1);
    });
    it('旧 pending、篡改 scope 以及重启后的范围字段缺失均拒绝且不写云', async () => {
        for (const mutation of ['missing-scope', 'changed-scope', 'missing-consent', 'missing-remote-scope', 'missing-local', 'changed-remote-scope', 'missing-preview'] as const) {
            const f = fixture();
            const preview = await f.service.prepare(password);
            const state = f.state as DriveSyncState;
            if (mutation === 'missing-scope') delete state.prepared!.scope;
            else if (mutation === 'changed-scope') state.prepared!.scope = 'complete';
            else {
                const saved = await decryptDriveConfig(state.prepared!.content, password) as {preview?: Partial<typeof preview>; local?: unknown};
                if (mutation === 'missing-consent') delete saved.preview!.includeSensitive;
                if (mutation === 'missing-remote-scope') delete saved.preview!.remoteIncludesSensitive;
                if (mutation === 'changed-remote-scope') saved.preview!.remoteIncludesSensitive = true;
                if (mutation === 'missing-local') delete saved.local;
                if (mutation === 'missing-preview') delete saved.preview;
                state.prepared!.content = await encryptDriveConfig(saved, password);
            }
            await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {})).rejects.toThrow(/范围/u);
            expect(f.ports.api.write).not.toHaveBeenCalled();
            expect(f.ports.apply).not.toHaveBeenCalled();
            expect(f.state).not.toHaveProperty('prepared');
        }
    });
    it('完整原始本机快照检测投影外变化，并在保存失败后精确回滚', async () => {
        const f = fixture();
        f.local = {...f.local, count: 123, unknownPrivate: {opaque: 'fixture-original-secret'}, translationAppearance: {...f.local.translationAppearance as object, token: 'fixture-nested-original'}};
        let preview = await f.service.prepare(password);
        f.local = {...f.local, count: 124};
        await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'upload', {})).rejects.toThrow('本机配置已变化');
        const raw = structuredClone(f.local);
        f.remote = {file: {id: 'fixture-file', version: '1', modifiedTime: ''}, content: await encryptDriveConfig(completePayload(config({...f.local, to: 'de'})), password)};
        preview = await f.service.prepare(password);
        vi.mocked(f.ports.apply).mockRejectedValueOnce(new Error('fixture-write-failure'));
        await expect(createGoogleDriveSync(f.ports).commit(preview.id, password, 'download', {})).rejects.toThrow('已恢复原配置');
        expect(f.ports.apply).toHaveBeenLastCalledWith(raw);
        expect(f.local).toEqual(raw);
    });
    it('核心 prepare 也严格拒绝非布尔同意', async () => {
        const f = fixture();
        for (const consent of [null, 1, 'true', {}, []]) await expect(f.service.prepare(password, undefined, undefined, consent as boolean)).rejects.toThrow('布尔值');
        expect(f.ports.auth.open).not.toHaveBeenCalled();
        expect(f.ports.api.write).not.toHaveBeenCalled();
    });
});
