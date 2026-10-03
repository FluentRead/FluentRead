/**
 * @file src/app/background/handlers/googleDriveSync.ts
 * 文件职责：将加密同步协议限制在扩展设置页面的可信消息边界。
 * 主要内容：校验发送者、动作、预览 ID 与冲突选择，自动使用固定应用口令、供应商消息类型和显式换号，屏蔽外部异常原文。
 * 模块边界：不读取配置或令牌；依赖服务执行同步，返回值仅含状态与隐藏内容的预览。
 */
import type {BackgroundMessageHandler} from '../messageRouter';
import type {ConfigPersistenceContext} from './configPersistence';
import type {createGoogleDriveSync} from '@/src/services/config/googleDriveSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {DriveError} from '@/src/platform/google-drive/auth';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import {DriveConfigError} from '@/src/core/config/driveSync';

export const GOOGLE_DRIVE_SYNC_MESSAGE_TYPE = 'googleDriveEncryptedSync';
export interface DriveSyncMessage {type: string; switchAccount?: unknown; action?: unknown; clientId?: unknown; id?: unknown; direction?: unknown; choices?: unknown}
type Service = ReturnType<typeof createGoogleDriveSync>;
export function isGoogleDriveSettingsSender(sender: ConfigPersistenceContext['sender'], extensionId: string, optionsUrl: string): boolean {
    if (!sender?.url || sender.id !== extensionId) return false;
    try {
        const source = new URL(sender.url);
        const expected = new URL(optionsUrl);
        return source.protocol === expected.protocol && source.host === expected.host && source.pathname === expected.pathname;
    } catch {return false;}
}
export function createGoogleDriveSyncHandler(service: Service, trusted: (sender: ConfigPersistenceContext['sender']) => boolean, provider: 'google' | 'dropbox' = 'google'): BackgroundMessageHandler<ConfigPersistenceContext, DriveSyncMessage> {
    const invalidAction = provider === 'google' ? '无效的 Google Drive 同步操作。' : 'settings.dropbox.error.invalidAction';
    return {
        type: provider === 'google' ? GOOGLE_DRIVE_SYNC_MESSAGE_TYPE : 'dropboxEncryptedSync',
        async handle(message, context) {
            if (!trusted(context.sender)) return {success: false, error: provider === 'google' ? 'Google Drive 同步仅允许从扩展设置页面操作。' : 'settings.dropbox.error.settingsOnly'};
            try {
                let data: unknown;
                const tabId = context.sender?.tab?.id;
                if (message.action !== 'status' && (typeof message.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(message.clientId))) return {success: false, error: invalidAction};
                const clientId = message.clientId as string;
                if (message.action === 'status') data = await service.status();
                else if (message.action === 'cancel' && (message.id === undefined || (typeof message.id === 'string' && message.id.length <= 64))) data = await service.cancel(message.id as string | undefined, tabId, clientId);
                else if (message.action === 'prepare' && (message.switchAccount === undefined || typeof message.switchAccount === 'boolean')) {
                    data = provider === 'dropbox' && message.switchAccount
                        ? await service.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, tabId, clientId, true)
                        : await service.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, tabId, clientId);
                }
                else if (message.action === 'commit' && typeof message.id === 'string' && message.id.length <= 64 && ['upload', 'download', 'merge'].includes(message.direction as string)) {
                    const choices = message.choices;
                    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 50_000 || !Object.entries(choices).every(([key, value]) => /^\d+$/u.test(key) && (value === 'local' || value === 'remote'))) return {success: false, error: '无效的同步差异选择。'};
                    data = await service.commit(message.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId);
                } else return {success: false, error: invalidAction};
                return {success: true, data};
            } catch (error) {
                if (error instanceof DriveEncryptionError) return {success: false, error: error.message === '同步配置过大，请减少自定义设置后重试' ? error.message : '同步文件无法解密或已损坏；请检查云端备份，本机配置未被修改。'};
                if (error instanceof DriveError || error instanceof DriveConfigError) return {success: false, error: provider === 'dropbox' && error.message === 'Google 账号已切换，请重新生成同步预览。' ? 'settings.dropbox.error.accountChanged' : error.message};
                return {success: false, error: '同步未完成，请检查网络和配置存储后重新预览。'};
            }
        },
    };
}
