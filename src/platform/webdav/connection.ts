/**
 * @file src/platform/webdav/connection.ts
 * 文件职责：规范化 WebDAV 连接并把应用密码保存在后台专属加密配置仓库。
 * 主要内容：校验目录地址、用户名与密码；通过修订号防止多页覆盖；只返回无密码的连接摘要。
 * 模块边界：不访问服务器，不导出完整配置；记录独立于配置快照，因此连接凭据不会进入云备份。
 */
import {CloudSyncError, type CloudSyncSession} from '@/src/core/config/cloudSync';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';

export const WEBDAV_CONNECTION_KEY = 'local:webdavBackupConnection';
export const WEBDAV_SYNC_STATE_KEY = 'local:webdavEncryptedSyncState';
export type WebDavErrorCode = 'url' | 'credentials' | 'insecure' | 'missing' | 'changed' | 'auth' | 'forbidden' | 'notFound' | 'locked' | 'quota' | 'conflict' | 'etag' | 'network' | 'timeout' | 'tooLarge' | 'invalidDav' | 'http' | 'encryptedOnly' | 'verify';
export class WebDavError extends CloudSyncError {
    constructor(readonly code: WebDavErrorCode, readonly status?: number) {super(`WebDAV ${code}`);}
}
export interface WebDavConnection {url: string; username: string; password: string; allowInsecure: boolean; revision: string}
export interface WebDavConnectionSummary {url: string; username: string; allowInsecure: boolean; hasPassword: boolean; revision: string}
export interface WebDavConnectionInput {url?: unknown; username?: unknown; password?: unknown; allowInsecure?: unknown; revision?: unknown}

export function normalizeWebDavUrl(value: unknown, allowInsecure = false): string {
    if (typeof value !== 'string' || value.length > 4096 || !value.trim() || /[\\\x00-\x1f\x7f]/u.test(value)) throw new WebDavError('url');
    let url: URL;
    try {url = new URL(value.trim());} catch {throw new WebDavError('url');}
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%(?:2f|5c|00|0a|0d)/iu.test(url.pathname)) throw new WebDavError('url');
    if (url.protocol === 'http:' && !allowInsecure) throw new WebDavError('insecure');
    url.pathname = url.pathname.replace(/\/+$/u, '') + '/';
    return url.href;
}
export function parseWebDavConnection(input: WebDavConnectionInput, previous: WebDavConnection | null): WebDavConnection {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WebDavError('credentials');
    if (input.revision !== (previous?.revision ?? null)) throw new WebDavError('changed');
    const allowInsecure = input.allowInsecure === true;
    const url = normalizeWebDavUrl(input.url, allowInsecure);
    if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 512 || /[:\x00-\x1f\x7f]/u.test(input.username)) throw new WebDavError('credentials');
    const username = input.username.trim();
    const password = input.password === '' && previous?.url === url && previous.username === username ? previous.password : input.password;
    if (typeof password !== 'string' || !password || password.length > 4096 || /[\x00-\x1f\x7f]/u.test(password)) throw new WebDavError('credentials');
    return {url, username, password, allowInsecure, revision: crypto.randomUUID()};
}
export function webDavConnectionSummary(value: WebDavConnection | null): WebDavConnectionSummary | null {
    return value ? {url: value.url, username: value.username, allowInsecure: value.allowInsecure, hasPassword: Boolean(value.password), revision: value.revision} : null;
}
export function createWebDavConnectionStore(storage: Pick<ConfigStoragePort, 'getItem' | 'setItem' | 'removeItem'>) {
    return {
        async read(): Promise<WebDavConnection | null> {
            const value = await storage.getItem<WebDavConnection>(WEBDAV_CONNECTION_KEY);
            if (!value) return null;
            // 仓库中损坏的数据必须停止操作，不能退回匿名请求或默认地址。
            if (typeof value.revision !== 'string' || !value.revision) throw new WebDavError('credentials');
            return {...parseWebDavConnection(value, value), revision: value.revision};
        },
        write: (value: WebDavConnection) => storage.setItem(WEBDAV_CONNECTION_KEY, value),
        remove: () => storage.removeItem(WEBDAV_CONNECTION_KEY),
    };
}
export interface WebDavSession extends CloudSyncSession {connection: WebDavConnection}
export function createWebDavSession(connection: WebDavConnection, current: () => Promise<WebDavConnection | null>): WebDavSession {
    const bytes = new TextEncoder().encode(`${connection.username}:${connection.password}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const authorization = `Basic ${btoa(binary)}`;
    return {
        connection,
        account: {id: `webdav:${connection.revision}`, email: `${connection.username} · ${new URL(connection.url).host}`},
        async request(operation) {
            if ((await current())?.revision !== connection.revision) throw new WebDavError('changed');
            return operation(authorization);
        },
    };
}
