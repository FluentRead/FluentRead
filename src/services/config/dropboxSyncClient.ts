/**
 * @file src/services/config/dropboxSyncClient.ts
 * 文件职责：为设置页面提供独立的 Dropbox 同步消息客户端。
 * 主要内容：复用同步协议客户端与错误边界，以独立消息类型及客户端标识隔离预览归属。
 * 模块边界：不访问配置或令牌，不执行网络授权，只有后台负责同步事务。
 */
import {createCloudBackupClient} from './cloudBackupClient';
export const dropboxSyncClient = createCloudBackupClient('dropboxEncryptedSync');
