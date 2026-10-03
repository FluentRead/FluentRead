/**
 * @file src/services/config/googleDriveSyncClient.ts
 * 文件职责：为设置页面提供加密同步的类型化后台请求端口。
 * 主要内容：发送无授权状态检查、单次同步预览、确认与取消请求，并检查标准响应。
 * 模块边界：不读取配置、不加密、不调用 Google；不接收口令，由后台自动使用固定应用口令。
 */
import browser from 'webextension-polyfill';
import type {DriveSyncDirection, DriveSyncPreview, DriveSyncStatus} from './googleDriveSync';

export function createCloudSyncClient(type: string) {
    const clientId = crypto.randomUUID();
    async function request<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
        let response: {success?: boolean; data?: T; error?: string} | undefined;
        try {response = await browser.runtime.sendMessage({type, action, clientId, ...data});}
        catch {throw new Error('扩展后台暂时不可用，请重新打开设置后重试。');}
        if (!response?.success) throw new Error(response?.error || '同步请求未完成，请重试。');
        return response.data as T;
    }
    return {
        status: () => request<DriveSyncStatus>('status'),
        prepare: () => request<DriveSyncPreview>('prepare'),
        commit: (id: string, direction: DriveSyncDirection, choices: Record<string, string>) => request<DriveSyncStatus>('commit', {id, direction, choices}),
        cancel: (id?: string) => request<void>('cancel', {id}),
    };
}
export type CloudSyncClient = ReturnType<typeof createCloudSyncClient>;
export const googleDriveSyncClient = createCloudSyncClient('googleDriveEncryptedSync');
export const oneDriveSyncClient = createCloudSyncClient('oneDriveEncryptedSync');
