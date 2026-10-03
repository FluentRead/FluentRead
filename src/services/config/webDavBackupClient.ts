/**
 * @file src/services/config/webDavBackupClient.ts
 * 文件职责：为 WebDAV 云备份设置提供类型化的可信后台端口。
 * 主要内容：共用预览事务客户端，并扩展连接摘要、只读测试、测试后保存和清除本机连接。
 * 模块边界：不持有完整配置，不请求服务器；密码由后台保存，读取只返回 hasPassword 标识。
 */
import {createCloudBackupClient} from './cloudBackupClient';
import type {WebDavConnectionInput, WebDavConnectionSummary} from '@/src/platform/webdav/connection';
const client = createCloudBackupClient('webDavConfigBackup');
export const webDavBackupClient = {
    ...client,
    settings: () => client.request<WebDavConnectionSummary | null>('settings'),
    test: (connection: WebDavConnectionInput) => client.request<void>('test', {connection}),
    save: (connection: WebDavConnectionInput) => client.request<WebDavConnectionSummary>('save', {connection}),
    clear: (revision: string | null) => client.request<void>('clear', {revision}),
};
