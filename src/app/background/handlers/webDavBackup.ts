/**
 * @file src/app/background/handlers/webDavBackup.ts
 * 文件职责：把 WebDAV 连接管理与配置云备份限制在扩展设置页的可信消息边界。
 * 主要内容：校验动作、客户端身份、连接字段和冲突选择；返回受控错误 key 或脱敏摘要。
 * 模块边界：不读取配置或发起网络请求；不向 popup、content 或外部页面返回连接密码。
 */
import type {BackgroundMessageHandler} from '../messageRouter';
import type {ConfigPersistenceContext} from './configPersistence';
import type {createWebDavBackup} from '@/src/services/config/webDavBackup';
import {WebDavError, type WebDavConnectionInput} from '@/src/platform/webdav/connection';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {DriveConfigError} from '@/src/core/config/driveSync';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';

export const WEBDAV_BACKUP_MESSAGE_TYPE = 'webDavConfigBackup';
export interface WebDavBackupMessage {type: typeof WEBDAV_BACKUP_MESSAGE_TYPE; action?: unknown; clientId?: unknown; id?: unknown; direction?: unknown; choices?: unknown; connection?: unknown; revision?: unknown}
export function createWebDavBackupHandler(service: ReturnType<typeof createWebDavBackup>, trusted: (sender: ConfigPersistenceContext['sender']) => boolean): BackgroundMessageHandler<ConfigPersistenceContext, WebDavBackupMessage> {
    return {
        type: WEBDAV_BACKUP_MESSAGE_TYPE,
        async handle(message, context) {
            if (!trusted(context.sender)) return {success: false, errorKey: 'settings.webdav.error.trusted'};
            try {
                if (typeof message.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(message.clientId)) return {success: false, errorKey: 'settings.webdav.error.action'};
                const tabId = context.sender?.tab?.id;
                const clientId = message.clientId;
                let data: unknown;
                if (message.action === 'status') data = await service.status();
                else if (message.action === 'settings') data = await service.settings();
                else if (message.action === 'clear') data = await service.clear(message.revision, tabId, clientId);
                else if (message.action === 'save' || message.action === 'test') {
                    if (!message.connection || typeof message.connection !== 'object' || Array.isArray(message.connection)) return {success: false, errorKey: 'settings.webdav.error.action'};
                    const input = message.connection as WebDavConnectionInput;
                    data = message.action === 'save' ? await service.save(input, tabId, clientId) : await service.test(input);
                } else if (message.action === 'prepare') data = await service.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, tabId, clientId);
                else if (message.action === 'cancel' && (message.id === undefined || (typeof message.id === 'string' && message.id.length <= 64))) data = await service.cancel(message.id as string | undefined, tabId, clientId);
                else if (message.action === 'commit' && typeof message.id === 'string' && message.id.length <= 64 && ['upload', 'download', 'merge'].includes(message.direction as string)) {
                    const choices = message.choices;
                    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 50_000 || !Object.entries(choices).every(([key, value]) => /^\d+$/u.test(key) && (value === 'local' || value === 'remote'))) return {success: false, errorKey: 'settings.webdav.error.action'};
                    data = await service.commit(message.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId);
                } else return {success: false, errorKey: 'settings.webdav.error.action'};
                return {success: true, data};
            } catch (error) {
                if (error instanceof WebDavError) return {success: false, errorKey: `settings.webdav.error.${error.code}`, errorParams: {status: error.status ?? 0}};
                if (error instanceof DriveEncryptionError) return {success: false, errorKey: error.message.includes('过大') ? 'settings.webdav.error.tooLarge' : 'settings.webdav.error.decrypt'};
                if (error instanceof CloudSyncError || error instanceof DriveConfigError) return {success: false, error: error.message};
                return {success: false, errorKey: 'settings.webdav.error.failure'};
            }
        },
    };
}
