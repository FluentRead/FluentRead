import {describe, expect, it, vi} from 'vitest';
import {createGoogleDriveSyncHandler, isGoogleDriveSettingsSender, GOOGLE_DRIVE_SYNC_MESSAGE_TYPE as type} from '@/src/app/background/handlers/googleDriveSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {DriveError} from '@/src/platform/google-drive/auth';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import {DriveConfigError} from '@/src/core/config/driveSync';
import type {createGoogleDriveSync} from '@/src/services/config/googleDriveSync';

function fixture(trusted = true) {
    const service = {status: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), commit: vi.fn(), prepareDelete: vi.fn(), commitDelete: vi.fn()} as unknown as ReturnType<typeof createGoogleDriveSync>;
    return {service, handler: createGoogleDriveSyncHandler(service, () => trusted)};
}
describe('Google Drive 可信消息协议', () => {
    it('Google Drive 删除动作绑定设置页身份和非空确认 ID，不接受任意文件地址', async () => {
        const denied=fixture(false); await denied.handler.handle({type,clientId:'delete-page',action:'prepareDelete'},{});expect(denied.service.prepareDelete).not.toHaveBeenCalled();
        const f=fixture();await f.handler.handle({type,clientId:'delete-page',action:'prepareDelete'},{sender:{tab:{id:7}}});
        expect(f.service.prepareDelete).toHaveBeenCalledWith(7,'delete-page');
        for(const id of [undefined,null,1,'','x'.repeat(65)]) expect(await f.handler.handle({type,clientId:'delete-page',action:'commitDelete',id},{})).toMatchObject({success:false});
        await f.handler.handle({type,clientId:'delete-page',action:'commitDelete',id:'delete-id'},{sender:{tab:{id:7}}});expect(f.service.commitDelete).toHaveBeenCalledWith('delete-id',7,'delete-page');
    });
    it('设置页可操作，其他扩展、网页、popup、路径前缀和非法 URL 都不能操作', () => {
        const options = 'chrome-extension://fixture/options.html';
        expect(isGoogleDriveSettingsSender({id: 'fixture', url: `${options}?test=1#backup`}, 'fixture', options)).toBe(true);
        for (const sender of [undefined, {}, {id: 'fixture'}, {id: 'other', url: options}, {id: 'fixture', url: 'invalid'}, {id: 'fixture', url: 'https://fixture/options.html'}, {id: 'fixture', url: 'chrome-extension://other/options.html'}, {id: 'fixture', url: 'chrome-extension://fixture/popup.html'}, {id: 'fixture', url: `${options}.evil`}]) expect(isGoogleDriveSettingsSender(sender, 'fixture', options)).toBe(false);
        expect(isGoogleDriveSettingsSender({id: 'fixture', url: options}, 'fixture', 'invalid')).toBe(false);
    });
    it('拒绝内容脚本发送者，合法设置消息只向服务传递必要参数', async () => {
        const f = fixture(false);
        expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'prepare'}, {})).toMatchObject({success: false});
        expect(f.service.prepare).not.toHaveBeenCalled();
        const allowed = fixture();
        for (const action of ['status', 'cancel'] as const) {
            expect(await allowed.handler.handle({type, clientId: 'fixture-client', action}, {})).toMatchObject({success: true});
            expect(allowed.service[action]).toHaveBeenCalledOnce();
            if (action === 'cancel') expect(allowed.service.cancel).toHaveBeenCalledWith(undefined, undefined, 'fixture-client');
        }
        await allowed.handler.handle({type, clientId: 'fixture-client', action: 'prepare'}, {});
        expect(allowed.service.prepare).toHaveBeenCalledWith(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, undefined, 'fixture-client', false);
        await allowed.handler.handle({type, clientId: 'fixture-client', action: 'prepare'}, {sender: {tab: {id: 73}}});
        expect(allowed.service.prepare).toHaveBeenLastCalledWith(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 73, 'fixture-client', false);
        await allowed.handler.handle({type, clientId: 'fixture-client', action: 'commit', id: 'fixture-id', direction: 'merge', choices: {'0': 'local', '1': 'remote'}}, {});
        expect(allowed.service.commit).toHaveBeenCalledWith('fixture-id', GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'merge', {'0': 'local', '1': 'remote'}, undefined, 'fixture-client');
    });
    it('绑定客户端与取消 ID 的格式检查，大小错误保留明确原因', async () => {
        const f = fixture();
        for (const clientId of [undefined, null, '', 'bad/client', 'x'.repeat(65)]) expect(await f.handler.handle({type, action: 'prepare', clientId}, {})).toMatchObject({success: false});
        for (const id of [1, 'x'.repeat(65)]) expect(await f.handler.handle({type, action: 'cancel', clientId: 'fixture-client', id}, {})).toMatchObject({success: false});
        await f.handler.handle({type, action: 'cancel', clientId: 'fixture-client', id: 'preview-id'}, {sender: {tab: {id: 73}}});
        expect(f.service.cancel).toHaveBeenCalledWith('preview-id', 73, 'fixture-client');
        vi.mocked(f.service.status).mockRejectedValueOnce(new DriveEncryptionError('同步配置过大，请减少自定义设置后重试'));
        expect(await f.handler.handle({type, action: 'status'}, {})).toEqual({success: false, error: '同步配置过大，请减少自定义设置后重试'});
    });
    it('拒绝非法动作、预览 ID、方向与冲突选择', async () => {
        const f = fixture();
        for (const message of [{}, {action: 'bad'}, {action: 'connect'}, {action: 'disconnect'}, {action: 'commit'}, {action: 'commit', id: 'x'.repeat(65)}, {action: 'commit', id: 'id', direction: 'bad'}]) expect(await f.handler.handle({type, clientId: 'fixture-client', ...message}, {})).toMatchObject({success: false});
        for (const choices of [undefined, null, [], 1, {'bad-secret-field': 'local'}, {'0': 'bad'}, Object.fromEntries(Array.from({length: 50_001}, (_, id) => [String(id), 'local']))]) expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'commit', id: 'id', direction: 'merge', choices}, {})).toMatchObject({success: false});
        expect(f.service.commit).not.toHaveBeenCalled();
    });
    it('只返回已知安全错误，绝不反射外部错误或密钥', async () => {
        const f = fixture();
        for (const error of [new DriveError('fixture safe drive error'), new DriveEncryptionError('fixture safe encryption error'), new DriveConfigError('fixture safe config error')]) {
            vi.mocked(f.service.status).mockRejectedValueOnce(error);
            expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'status'}, {})).toEqual({success: false, error: error instanceof DriveEncryptionError ? '同步文件无法解密或已损坏；请检查云端备份，本机配置未被修改。' : error.message});
        }
        for (const error of [new Error('fixture-private-upstream-key'), 'fixture-private-token', null]) {
            vi.mocked(f.service.status).mockRejectedValueOnce(error);
            expect(JSON.stringify(await f.handler.handle({type, clientId: 'fixture-client', action: 'status'}, {}))).not.toContain('fixture-private');
        }
    });
});


it('Google Drive prepare 的敏感信息同意只能是 boolean，旧消息缺省安全关闭', async () => {
    const f = fixture();
    for (const includeSensitive of [null, 0, 1, 'false', 'true', {}, []]) {
        expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'prepare', includeSensitive}, {})).toMatchObject({success: false});
    }
    expect(f.service.prepare).not.toHaveBeenCalled();
    for (const includeSensitive of [undefined, false, true]) {
        expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'prepare', includeSensitive}, {sender: {tab: {id: 7}}})).toMatchObject({success: true});
        expect(f.service.prepare).toHaveBeenLastCalledWith(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 7, 'fixture-client', includeSensitive ?? false);
    }
});
