/**
 * @file src/platform/onedrive/constants.ts
 * 文件职责：定义微软公共客户端、最小委托权限和独立的 OneDrive 配置存储协议。
 * 主要内容：固定微软授权与 Graph 地址、配置文件名、回调路径和本机状态键。
 * 模块边界：不保存账号、令牌或客户端秘密；公开客户端 ID 由构建环境提供。
 */
export const ONEDRIVE_CLIENT_ID = String(import.meta.env.WXT_ONEDRIVE_CLIENT_ID ?? '').trim();
export const ONEDRIVE_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const ONEDRIVE_GRAPH = 'https://graph.microsoft.com/v1.0';
export const ONEDRIVE_SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read'] as const;
export const ONEDRIVE_REDIRECT_PATH = 'onedrive';
export const ONEDRIVE_CONFIG_FILE = 'fluentread-config.encrypted.json';
export const ONEDRIVE_STATE_KEY = 'local:oneDriveEncryptedSyncState';
export const ONEDRIVE_MESSAGE_TYPE = 'oneDriveEncryptedSync';
