/**
 * @file src/app/background/handlers/googleDriveSync.ts
 * 文件职责：将加密同步、端到端口令管理、学习资产同步与备份删除协议限制在扩展设置页面的可信消息边界。
 * 主要内容：校验发送者、同步或删除动作、预览 ID、冲突选择、端到端口令模式与学习同步范围；无自定义口令时兼容固定应用口令，上传未核验与口令错误返回可本地化提示，屏蔽外部异常原文。
 * 模块边界：不读取配置或令牌；依赖服务与口令仓库执行同步，返回值仅含状态与隐藏内容的预览。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './configPersistence';
import type {createGoogleDriveSync} from '@/src/services/config/googleDriveSync';
import type {CloudPassphraseConfigInput, createCloudPassphraseStore} from '@/src/services/config/cloudPassphraseStore';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {DriveError} from '@/src/platform/google-drive/auth';
import {DriveUploadVerificationError} from '@/src/platform/google-drive/api';
import {DriveEncryptionError, type DriveEncryptionKeyMode} from '@/src/platform/google-drive/encryption';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {DriveConfigError} from '@/src/core/config/driveSync';
import {hasAnyLearningSyncScope, LearningSyncError, normalizeLearningSyncScope} from '@/src/core/config/learningSync';
import {PersonalCorrectionError} from '@/src/core/personal-corrections/public';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import {VocabularyBookError} from '@/src/features/vocabulary/repository';

export const GOOGLE_DRIVE_SYNC_MESSAGE_TYPE = 'googleDriveEncryptedSync';
export interface DriveSyncMessage {
    type: typeof GOOGLE_DRIVE_SYNC_MESSAGE_TYPE;
    action?: unknown;
    clientId?: unknown;
    id?: unknown;
    direction?: unknown;
    includeSensitive?: unknown;
    choices?: unknown;
    keyMode?: unknown;
    passphrase?: unknown;
    learningScope?: unknown;
    passphraseConfig?: unknown;
}
type Service = ReturnType<typeof createGoogleDriveSync>;
export interface GoogleDriveSyncHandlerExtras {
    passphrases?: ReturnType<typeof createCloudPassphraseStore>;
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
export function createGoogleDriveSyncHandler(
    service: Service,
    trusted: (sender: ConfigPersistenceContext['sender']) => boolean,
    extras?: GoogleDriveSyncHandlerExtras,
): BackgroundMessageHandler<ConfigPersistenceContext, DriveSyncMessage> {
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
        type: GOOGLE_DRIVE_SYNC_MESSAGE_TYPE,
        async handle(message, context) {
            if (!trusted(context.sender)) return {success: false, error: 'Google Drive 同步仅允许从扩展设置页面操作。'};
            try {
                let data: unknown;
                const tabId = context.sender?.tab?.id;
                if (message.action !== 'status' && (typeof message.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(message.clientId))) return {success: false, error: '无效的 Google Drive 同步操作。'};
                const clientId = message.clientId as string;
                if (message.action === 'status') data = await service.status();
                else if (message.action === 'passphraseStatus') {
                    data = extras?.passphrases ? await extras.passphrases.status() : {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'};
                } else if (message.action === 'configurePassphrase' && extras?.passphrases) {
                    if (!message.passphraseConfig || typeof message.passphraseConfig !== 'object' || Array.isArray(message.passphraseConfig)) return {success: false, error: '无效的 Google Drive 同步操作。'};
                    data = await extras.passphrases.configure(message.passphraseConfig as CloudPassphraseConfigInput);
                } else if (message.action === 'clearPassphrase' && extras?.passphrases) {
                    data = await extras.passphrases.clear();
                } else if (message.action === 'prepareDelete') data = await service.prepareDelete(tabId, clientId);
                else if (message.action === 'commitDelete' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 64) data = await service.commitDelete(message.id, tabId, clientId);
                else if (message.action === 'cancel' && (message.id === undefined || (typeof message.id === 'string' && message.id.length <= 64))) data = await service.cancel(message.id as string | undefined, tabId, clientId);
                else if (message.action === 'prepare' && (message.includeSensitive === undefined || typeof message.includeSensitive === 'boolean')) {
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
                } else if (message.action === 'commit' && typeof message.id === 'string' && message.id.length <= 64 && ['upload', 'download', 'merge'].includes(message.direction as string)) {
                    const choices = message.choices;
                    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 50_000 || !Object.entries(choices).every(([key, value]) => /^\d+$/u.test(key) && (value === 'local' || value === 'remote'))) return {success: false, error: '无效的同步差异选择。'};
                    const keyMode = parseKeyMode(message.keyMode);
                    const rawPassphrase = parseOptionalPassphrase(message.passphrase);
                    const resolved = await resolvePassphrase(keyMode, rawPassphrase);
                    data = resolved.keyMode === 'custom'
                        ? await service.commit(message.id, resolved.passphrase, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId, {
                            keyMode: resolved.keyMode,
                            legacyPassphrase: resolved.legacyPassphrase,
                        })
                        : await service.commit(message.id, resolved.passphrase, message.direction as 'upload' | 'download' | 'merge', choices as Record<string, unknown>, tabId, clientId);
                } else return {success: false, error: '无效的 Google Drive 同步操作。'};
                return {success: true, data};
            } catch (error) {
                if (error instanceof DriveUploadVerificationError) return {success: false, error: error.message, errorKey: 'settings.cloud.uploadUnverified'};
                if (error instanceof DriveEncryptionError) {
                    if (error.code === 'passphrase-required') return {success: false, error: error.message, errorKey: 'settings.cloud.e2ee.passphraseRequired'};
                    if (error.code === 'wrong-passphrase') return {success: false, error: error.message, errorKey: 'settings.cloud.e2ee.wrongPassphrase'};
                    if (error.code === 'invalid-passphrase') return {success: false, error: error.message, errorKey: 'settings.cloud.e2ee.invalidPassphrase'};
                    return {success: false, error: error.message === '同步配置过大，请减少自定义设置后重试' ? error.message : '同步文件无法解密或已损坏；请检查云端备份，本机配置未被修改。'};
                }
                const isKnownError = error instanceof DriveError
                    || error instanceof CloudSyncError
                    || error instanceof DriveConfigError
                    || error instanceof LearningSyncError
                    || error instanceof PersonalCorrectionError
                    || error instanceof VocabularyBookError
                    || error instanceof MaterialError;
                return {success: false, error: isKnownError ? error.message : '同步未完成，请检查网络和配置存储后重新预览。'};
            }
        },
    };
}
