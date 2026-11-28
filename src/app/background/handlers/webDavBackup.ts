/**
 * @file src/app/background/handlers/webDavBackup.ts
 * 文件职责：把 WebDAV 连接管理、自定义端到端口令、学习资产同步与定时自动同步限制在扩展设置页的可信消息边界。
 * 主要内容：校验同步或删除动作、客户端身份、连接字段、冲突选择、端到端口令与自动同步设置；返回受控错误 key 或脱敏摘要。
 * 模块边界：不读取配置或发起网络请求；不向 popup、content 或外部页面返回连接密码或自定义同步口令。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './configPersistence';
import type {createWebDavBackup} from '@/src/services/config/webDavBackup';
import type {CloudAutoSyncConfigPatch, createCloudAutoSync} from '@/src/services/config/cloudAutoSync';
import type {CloudPassphraseConfigInput, createCloudPassphraseStore} from '@/src/services/config/cloudPassphraseStore';
import {WebDavError, type WebDavConnectionInput} from '@/src/platform/webdav/connection';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {DriveConfigError} from '@/src/core/config/driveSync';
import {hasAnyLearningSyncScope, LearningSyncError, normalizeLearningSyncScope} from '@/src/core/config/learningSync';
import {DriveEncryptionError, type DriveEncryptionKeyMode} from '@/src/platform/google-drive/encryption';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';

export const WEBDAV_BACKUP_MESSAGE_TYPE = 'webDavConfigBackup';
export interface WebDavBackupMessage {
    type: typeof WEBDAV_BACKUP_MESSAGE_TYPE;
    action?: unknown;
    clientId?: unknown;
    id?: unknown;
    direction?: unknown;
    includeSensitive?: unknown;
    choices?: unknown;
    connection?: unknown;
    revision?: unknown;
    keyMode?: unknown;
    passphrase?: unknown;
    learningScope?: unknown;
    passphraseConfig?: unknown;
    autoSync?: unknown;
}
export interface WebDavBackupHandlerExtras {
    passphrases?: ReturnType<typeof createCloudPassphraseStore>;
    autoSync?: ReturnType<typeof createCloudAutoSync>;
}
function parseKeyMode(value: unknown): DriveEncryptionKeyMode | undefined {
    if (value === undefined) return undefined;
    if (value !== 'app' && value !== 'custom') throw new DriveEncryptionError('加密口令模式无效', 'unsupported');
    return value;
}
function parseOptionalPassphrase(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new DriveEncryptionError('同步口令至少需要 12 个字符，最多 1024 个字符', 'invalid-passphrase');
    return value;
}
export function createWebDavBackupHandler(
    service: ReturnType<typeof createWebDavBackup>,
    trusted: (sender: ConfigPersistenceContext['sender']) => boolean,
    extras?: WebDavBackupHandlerExtras,
): BackgroundMessageHandler<ConfigPersistenceContext, WebDavBackupMessage> {
    async function resolvePassphrase(keyMode: DriveEncryptionKeyMode | undefined, passphrase: string | undefined) {
        if (extras?.passphrases) {
            return extras.passphrases.resolveForSync({
                ...(keyMode !== undefined ? {keyMode} : {}),
                ...(passphrase !== undefined ? {passphrase} : {}),
            });
        }
        if (keyMode === 'custom') {
            if (!passphrase) throw new DriveEncryptionError('云端备份使用自定义端到端加密口令保护，请先输入同步口令。', 'passphrase-required');
            return {keyMode: 'custom' as const, passphrase, legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE};
        }
        return {keyMode: 'app' as const, passphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE, legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE};
    }
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
                else if (message.action === 'passphraseStatus') {
                    data = extras?.passphrases ? await extras.passphrases.status() : {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'};
                } else if (message.action === 'configurePassphrase' && extras?.passphrases) {
                    if (!message.passphraseConfig || typeof message.passphraseConfig !== 'object' || Array.isArray(message.passphraseConfig)) return {success: false, errorKey: 'settings.webdav.error.action'};
                    data = await extras.passphrases.configure(message.passphraseConfig as CloudPassphraseConfigInput);
                } else if (message.action === 'clearPassphrase' && extras?.passphrases) {
                    data = await extras.passphrases.clear();
                } else if (message.action === 'autoSyncStatus' && extras?.autoSync) {
                    data = await extras.autoSync.status();
                } else if (message.action === 'configureAutoSync' && extras?.autoSync) {
                    if (!message.autoSync || typeof message.autoSync !== 'object' || Array.isArray(message.autoSync)) return {success: false, errorKey: 'settings.webdav.error.action'};
                    data = await extras.autoSync.configure(message.autoSync as CloudAutoSyncConfigPatch);
                } else if (message.action === 'runAutoSyncNow' && extras?.autoSync) {
                    data = await extras.autoSync.runNow();
                } else if (message.action === 'prepareDelete') data = await service.prepareDelete(tabId, clientId);
                else if (message.action === 'commitDelete' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 64) data = await service.commitDelete(message.id, tabId, clientId);
                else if (message.action === 'settings') data = await service.settings();
                else if (message.action === 'clear') data = await service.clear(message.revision, tabId, clientId);
                else if (message.action === 'save' || message.action === 'test') {
                    if (!message.connection || typeof message.connection !== 'object' || Array.isArray(message.connection)) return {success: false, errorKey: 'settings.webdav.error.action'};
                    const input = message.connection as WebDavConnectionInput;
                    data = message.action === 'save' ? await service.save(input, tabId, clientId) : await service.test(input);
                } else if (message.action === 'prepare' && (message.includeSensitive === undefined || typeof message.includeSensitive === 'boolean')) {
                    const keyMode = parseKeyMode(message.keyMode);
                    const rawPassphrase = parseOptionalPassphrase(message.passphrase);
                    const learningScope = message.learningScope !== undefined ? normalizeLearningSyncScope(message.learningScope) : undefined;
                    const resolved = await resolvePassphrase(keyMode, rawPassphrase);
                    const hasExtendedOptions = resolved.keyMode === 'custom' || (learningScope !== undefined && hasAnyLearningSyncScope(learningScope));
                    data = hasExtendedOptions
                        ? await service.prepare(resolved.passphrase, tabId, clientId, message.includeSensitive ?? false, {
                            keyMode: resolved.keyMode,
                            legacyPassphrase: resolved.legacyPassphrase,
                            ...(learningScope ? {learningScope} : {}),
                        })
                        : await service.prepare(resolved.passphrase, tabId, clientId, message.includeSensitive ?? false);
                } else if (message.action === 'cancel' && (message.id === undefined || (typeof message.id === 'string' && message.id.length <= 64))) data = await service.cancel(message.id as string | undefined, tabId, clientId);
                else if (message.action === 'commit' && typeof message.id === 'string' && message.id.length <= 64 && ['upload', 'download', 'merge'].includes(message.direction as string)) {
                    const choices = message.choices;
                    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 50_000 || !Object.entries(choices).every(([key, value]) => /^\d+$/u.test(key) && (value === 'local' || value === 'remote'))) return {success: false, errorKey: 'settings.webdav.error.action'};
                    const keyMode = parseKeyMode(message.keyMode);
                    const rawPassphrase = parseOptionalPassphrase(message.passphrase);
                    const resolved = await resolvePassphrase(keyMode, rawPassphrase);
                    data = resolved.keyMode === 'custom'
                        ? await service.commit(message.id, resolved.passphrase, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId, {
                            keyMode: resolved.keyMode,
                            legacyPassphrase: resolved.legacyPassphrase,
                        })
                        : await service.commit(message.id, resolved.passphrase, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId);
                } else return {success: false, errorKey: 'settings.webdav.error.action'};
                return {success: true, data};
            } catch (error) {
                if (error instanceof WebDavError) return {success: false, errorKey: `settings.webdav.error.${error.code}`, errorParams: {status: error.status ?? 0}};
                if (error instanceof DriveEncryptionError) {
                    if (error.code === 'passphrase-required') return {success: false, errorKey: 'settings.cloud.e2ee.passphraseRequired'};
                    if (error.code === 'wrong-passphrase') return {success: false, errorKey: 'settings.cloud.e2ee.wrongPassphrase'};
                    if (error.code === 'invalid-passphrase') return {success: false, errorKey: 'settings.cloud.e2ee.invalidPassphrase'};
                    return {success: false, errorKey: error.message.includes('过大') ? 'settings.webdav.error.tooLarge' : 'settings.webdav.error.decrypt'};
                }
                if (error instanceof CloudSyncError || error instanceof DriveConfigError || error instanceof LearningSyncError) return {success: false, error: error.message};
                return {success: false, errorKey: 'settings.webdav.error.failure'};
            }
        },
    };
}
