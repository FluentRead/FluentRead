/**
 * @file src/services/config/webDavBackupClient.ts
 * 文件职责：为 WebDAV 云备份设置提供类型化的可信后台端口。
 * 主要内容：共用预览事务客户端，并扩展连接摘要、只读测试、测试后保存、清除本机连接与可选定时自动同步控制接口。
 * 模块边界：不持有完整配置，不请求服务器；密码与端到端口令由后台保存，读取只返回脱敏状态标识。
 */
import {createCloudBackupClient} from './cloudBackupClient';
import type {CloudAutoSyncConfigPatch, CloudAutoSyncStatus} from './cloudAutoSync';
import type {WebDavConnectionInput, WebDavConnectionSummary} from '@/src/platform/webdav/connection';
const client = createCloudBackupClient('webDavConfigBackup');
export const webDavBackupClient = {
    ...client,
    settings: () => client.request<WebDavConnectionSummary | null>('settings'),
    test: (connection: WebDavConnectionInput) => client.request<void>('test', {connection}),
    save: (connection: WebDavConnectionInput) => client.request<WebDavConnectionSummary>('save', {connection}),
    clear: (revision: string | null) => client.request<void>('clear', {revision}),
    autoSyncStatus: () => client.request<CloudAutoSyncStatus>('autoSyncStatus'),
    configureAutoSync: (autoSync: CloudAutoSyncConfigPatch) => client.request<CloudAutoSyncStatus>('configureAutoSync', {autoSync}),
    runAutoSyncNow: () => client.request<CloudAutoSyncStatus>('runAutoSyncNow'),
};
