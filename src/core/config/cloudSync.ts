/**
 * @file src/core/config/cloudSync.ts
 * 文件职责：定义配置云备份与存储供应商之间共用的账号、会话、文件版本和安全错误契约。
 * 主要内容：账号身份隔离、带版本的密文快照，以及只允许向设置页展示的受控异常。
 * 模块边界：只声明结构，不访问浏览器、配置存储或网络；供应商自行实现会话和条件写入。
 */
export class CloudSyncError extends Error {}
export interface CloudSyncAccount {id: string; email: string}
export interface CloudSyncSession {
    account: CloudSyncAccount;
    request<T>(operation: (credential: string) => Promise<T>): Promise<T>;
}
export interface CloudSyncFile {id: string; version: string; modifiedTime: string; etag?: string}
export interface CloudSyncRemote {file: CloudSyncFile; content: string}
