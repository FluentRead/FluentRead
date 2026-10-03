import {describe, expect, it, vi} from 'vitest';
import {createGoogleDriveSyncHandler} from '@/src/app/background/handlers/googleDriveSync';
import {DropboxError} from '@/src/platform/dropbox/auth';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import type {createGoogleDriveSync} from '@/src/services/config/googleDriveSync';
describe('Dropbox 设置消息边界', () => {
    it('使用独立消息类型，明确换号才让服务重新登录，拒绝非布尔标记', async () => {
        const service = {status: vi.fn(), prepare: vi.fn(), commit: vi.fn(), cancel: vi.fn()} as unknown as ReturnType<typeof createGoogleDriveSync>;
        const handler = createGoogleDriveSyncHandler(service, () => true, 'dropbox');
        expect(handler.type).toBe('dropboxEncryptedSync');
        for (const switchAccount of [true, false, undefined]) await handler.handle({type: handler.type, action: 'prepare', clientId: 'fixture-client', switchAccount}, {sender: {tab: {id: 8}}});
        expect(service.prepare).toHaveBeenNthCalledWith(1, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 8, 'fixture-client', true);
        expect(service.prepare).toHaveBeenNthCalledWith(2, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 8, 'fixture-client');
        expect(await handler.handle({type: handler.type, action: 'prepare', clientId: 'fixture-client', switchAccount: 'true'}, {})).toEqual({success: false, error: 'settings.dropbox.error.invalidAction'});
        vi.mocked(service.status).mockRejectedValueOnce(new DropboxError('settings.dropbox.error.expired'));
        expect(await handler.handle({type: handler.type, action: 'status'}, {})).toEqual({success: false, error: 'settings.dropbox.error.expired'});
        vi.mocked(service.status).mockRejectedValueOnce(new CloudSyncError('settings.dropbox.error.accountChanged'));
        expect(await handler.handle({type: handler.type, action: 'status'}, {})).toEqual({success: false, error: 'settings.dropbox.error.accountChanged'});
        expect(await createGoogleDriveSyncHandler(service, () => false, 'dropbox').handle({type: handler.type}, {})).toEqual({success: false, error: 'settings.dropbox.error.settingsOnly'});
        expect(await handler.handle({type: handler.type, action: 'prepare', clientId: ''}, {})).toMatchObject({success: false, error: 'settings.dropbox.error.invalidAction'});
    });
});
