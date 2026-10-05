/**
 * @file src/services/config/cloudBackupClient.ts
 * 文件职责：为配置云备份提供统一的设置页后台请求契约。
 * 主要内容：每个客户端持有独立事务身份；发送同步或删除的预览、确认与取消；保留受控错误 key 供 UI 本地化。
 * 模块边界：不读取配置或存储，不调用云端 API；连接密码仅随可信设置请求发送给本机后台。
 */
import browser from 'webextension-polyfill';
import {validateDriveSyncConsent} from '@/src/core/config/driveSync';
import type {CloudBackupDeletePreview, CloudBackupDeleteResult, DriveSyncDirection, DriveSyncPreview, DriveSyncStatus} from './remoteConfigSync';
export class CloudBackupRequestError extends Error {
    constructor(message: string, readonly errorKey?: string, readonly params?: Record<string, string | number>) {super(message);}
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
        prepare: (includeSensitive = false) => {validateDriveSyncConsent(includeSensitive); return request<DriveSyncPreview>('prepare', {includeSensitive});},
        commit: (id: string, direction: DriveSyncDirection, choices: Record<string, string>) => request<DriveSyncStatus>('commit', {id, direction, choices}),
        cancel: (id?: string) => request<void>('cancel', {id}),
    };
}
