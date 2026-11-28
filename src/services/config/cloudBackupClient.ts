/**
 * @file src/services/config/cloudBackupClient.ts
 * 文件职责：为配置云备份提供统一的设置页后台请求契约。
 * 主要内容：每个客户端持有独立事务身份；发送同步、删除、自定义端到端口令配置与学习资产同步范围的预览、确认与取消；保留受控错误 key 供 UI 本地化。
 * 模块边界：不读取配置或存储，不调用云端 API；口令与连接密码仅随可信设置请求发送给本机后台。
 */
import browser from 'webextension-polyfill';
import {validateDriveSyncConsent} from '@/src/core/config/driveSync';
import type {LearningSyncScope} from '@/src/core/config/learningSync';
import type {DriveEncryptionKeyMode} from '@/src/platform/google-drive/encryption';
import type {CloudPassphraseConfigInput, CloudPassphraseStatus} from './cloudPassphraseStore';
import type {CloudBackupDeletePreview, CloudBackupDeleteResult, DriveSyncDirection, DriveSyncPreview, DriveSyncStatus} from './remoteConfigSync';
export class CloudBackupRequestError extends Error {
    constructor(message: string, readonly errorKey?: string, readonly params?: Record<string, string | number>) {super(message);}
}
export interface CloudBackupPrepareOptions {
    keyMode?: DriveEncryptionKeyMode;
    passphrase?: string;
    learningScope?: LearningSyncScope;
}
export interface CloudBackupCommitOptions {
    keyMode?: DriveEncryptionKeyMode;
    passphrase?: string;
}
export function createCloudBackupClient(type: string) {
    const clientId = crypto.randomUUID();
    async function request<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
        let response: {success?: boolean; data?: T; error?: string; errorKey?: string; errorParams?: Record<string, string | number>} | undefined;
        try {response = await browser.runtime.sendMessage({type, action, clientId, ...data});}
        catch {throw new Error('扩展后台暂时不可用，请重新打开设置后重试。');}
        if (!response?.success) throw new CloudBackupRequestError(response?.error || '同步请求未完成，请重试。', response?.errorKey, response?.errorParams);
        return response.data as T;
    }
    return {
        request,
        status: () => request<DriveSyncStatus>('status'),
        prepareDelete: () => request<CloudBackupDeletePreview>('prepareDelete'),
        commitDelete: (id: string) => request<CloudBackupDeleteResult>('commitDelete', {id}),
        prepare: (includeSensitive = false, options?: CloudBackupPrepareOptions) => {
            validateDriveSyncConsent(includeSensitive);
            const payload: Record<string, unknown> = {includeSensitive};
            if (options?.keyMode !== undefined) payload.keyMode = options.keyMode;
            if (options?.passphrase !== undefined) payload.passphrase = options.passphrase;
            if (options?.learningScope !== undefined) payload.learningScope = options.learningScope;
            return request<DriveSyncPreview>('prepare', payload);
        },
        commit: (id: string, direction: DriveSyncDirection, choices: Record<string, string>, options?: CloudBackupCommitOptions) => {
            const payload: Record<string, unknown> = {id, direction, choices};
            if (options?.keyMode !== undefined) payload.keyMode = options.keyMode;
            if (options?.passphrase !== undefined) payload.passphrase = options.passphrase;
            return request<DriveSyncStatus>('commit', payload);
        },
        cancel: (id?: string) => request<void>('cancel', {id}),
        passphraseStatus: () => request<CloudPassphraseStatus>('passphraseStatus'),
        configurePassphrase: (passphraseConfig: CloudPassphraseConfigInput) => request<CloudPassphraseStatus>('configurePassphrase', {passphraseConfig}),
        clearPassphrase: () => request<CloudPassphraseStatus>('clearPassphrase'),
    };
}
