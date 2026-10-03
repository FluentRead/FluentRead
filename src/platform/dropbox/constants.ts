/**
 * @file src/platform/dropbox/constants.ts
 * 文件职责：集中 Dropbox 的公开应用标识、最小权限和固定同步路径。
 * 主要内容：使用构建时公开 App key；同步文件位于用户的 App folder，状态与 Google 隔离。
 * 模块边界：不保存 App secret、用户令牌或用户配置，不发起网络请求。
 */
export const DROPBOX_APP_KEY = import.meta.env.WXT_DROPBOX_APP_KEY?.trim() || '';
export const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'] as const;
export const DROPBOX_CONFIG_PATH = '/fluentread-config.encrypted.json';
export const DROPBOX_SYNC_STATE_KEY = 'local:dropboxEncryptedSyncState';
export const DROPBOX_AUTH_SESSION_KEY = 'fluentreadDropboxSyncSession';
export const DROPBOX_REDIRECT_PATH = 'dropbox';
export const DROPBOX_SYNC_MESSAGE_TYPE = 'dropboxEncryptedSync';
