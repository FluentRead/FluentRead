/**
 * @file src/platform/webdav/api.ts
 * 文件职责：在用户指定的 WebDAV 目录下读写 FluentRead 配置密文并验证服务器能力。
 * 主要内容：只读 PROPFIND 测试、确认后创建专属目录、ETag 条件 PUT、流式大小限制和超时；
 * 禁止跟随重定向、携带浏览器 Cookie 或返回服务器异常正文，防止连接凭据流向其他地址。
 * 模块边界：只消费后台会话与密文，不读取配置或保存密码；冲突合并由云备份服务处理。
 */
import type {CloudSyncFile, CloudSyncRemote} from '@/src/core/config/cloudSync';
import {GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
import {DRIVE_ENCRYPTION_FORMAT} from '@/src/platform/google-drive/encryption';
import {createWebDavSession, WebDavError, type WebDavConnection, type WebDavSession} from './connection';

export const WEBDAV_BACKUP_DIRECTORY = 'FluentRead/';
export const WEBDAV_BACKUP_FILE = 'fluentread-config.encrypted.json';
const XML_LIMIT = 128 * 1024;
function isDavCollection(xml: string): boolean {
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return false;
    const namespaces = [...xml.matchAll(/xmlns(?::([\w-]+))?=["']([^"']+)["']/gu)];
    const dav = namespaces.filter(match => match[2] === 'DAV:');
    if (!dav.length) return false;
    // 不接受前缀被重新绑定；目录与 200 状态必须在同一个 DAV propstat 中。
    if (dav.some(binding => namespaces.some(other => other[1] === binding[1] && other[2] !== 'DAV:'))) return false;
    const prefix = `(?:${dav.map(match => match[1] ? `${match[1]}:` : '').join('|')})`;
    const records = xml.matchAll(new RegExp(`<(${prefix}propstat)\\s*>[\\s\\S]*?<\\/\\1\\s*>`, 'gu'));
    return [...records].some(([record]) => new RegExp(`<${prefix}resourcetype\\s*>\\s*<${prefix}collection\\s*(?:\\/\\s*>|>\\s*<\\/${prefix}collection\\s*>)\\s*<\\/${prefix}resourcetype\\s*>`, 'u').test(record)
        && new RegExp(`<${prefix}status\\s*>\\s*HTTP\\/\\d(?:\\.\\d)? 200(?:\\s[^<]*)?<\\/${prefix}status\\s*>`, 'u').test(record));
}
function strongEtag(value: string | null): string | undefined {
    return value && value.length <= 512 && /^"[\x21\x23-\x7e\x80-\xff]*"$/u.test(value) ? value : undefined;
}
function failure(status: number): WebDavError {
    const codes = {401: 'auth', 403: 'forbidden', 404: 'notFound', 409: 'notFound', 412: 'conflict', 423: 'locked', 507: 'quota'} as const;
    return new WebDavError(codes[status as keyof typeof codes] ?? 'http', status);
}
export function createWebDavApi(fetcher: typeof fetch, options: {timeoutMs?: number; maxBytes?: number} = {}) {
    const maxBytes = options.maxBytes ?? GOOGLE_DRIVE_MAX_BYTES;
    async function consumeText(response: Response, limit: number): Promise<string> {
        if (Number(response.headers.get('content-length')) > limit) throw new WebDavError('tooLarge');
        const reader = response.body?.getReader();
        if (!reader) throw new WebDavError('invalidDav');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > limit) throw new WebDavError('tooLarge');
                chunks.push(part.value);
            }
        } finally {await reader.cancel();}
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    }
    async function request<T>(session: WebDavSession, url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
        return session.request(async authorization => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
            return (async () => {
                try {
                    const response = await fetcher(url, {...init, headers: {...init.headers, Authorization: authorization}, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
                    return await consume(response);
                } catch (error) {
                    if (error instanceof WebDavError) throw error;
                    throw new WebDavError(controller.signal.aborted ? 'timeout' : 'network');
                }
            })().finally(() => clearTimeout(timer));
        });
    }
    const directory = (session: WebDavSession) => new URL(WEBDAV_BACKUP_DIRECTORY, session.connection.url).href;
    const filename = (session: WebDavSession) => new URL(WEBDAV_BACKUP_FILE, directory(session)).href;
    async function test(connection: WebDavConnection): Promise<void> {
        const session = createWebDavSession(connection, async () => connection);
        await request(session, connection.url, {method: 'PROPFIND', headers: {Depth: '0', 'Content-Type': 'application/xml; charset=utf-8'}, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'}, async response => {
            if (response.status !== 207) throw response.ok ? new WebDavError('invalidDav') : failure(response.status);
            const xml = await consumeText(response, XML_LIMIT);
            // 只检查 Depth:0 的目录能力，不执行 XML、实体展开或任意返回地址。
            if (!isDavCollection(xml)) throw new WebDavError('invalidDav');
        });
    }
    async function read(session: WebDavSession): Promise<CloudSyncRemote | null> {
        return request(session, filename(session), {method: 'GET'}, async response => {
            if (response.status === 404) return null;
            if (response.status !== 200) throw failure(response.status);
            const content = await consumeText(response, maxBytes);
            const etag = strongEtag(response.headers.get('etag'));
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
            const version = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
            return {file: {id: filename(session), version, modifiedTime: response.headers.get('last-modified') ?? '', ...(etag ? {etag} : {})}, content};
        });
    }
    async function write(session: WebDavSession, content: string, previous: CloudSyncFile | null): Promise<CloudSyncFile> {
        let envelope: unknown;
        try {envelope = JSON.parse(content);} catch {throw new WebDavError('encryptedOnly');}
        if (!envelope || typeof envelope !== 'object' || !('format' in envelope) || envelope.format !== DRIVE_ENCRYPTION_FORMAT || !('ciphertext' in envelope) || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext || new TextEncoder().encode(content).length > maxBytes) throw new WebDavError('encryptedOnly');
        if (previous && (!strongEtag(previous.etag ?? null) || previous.id !== filename(session))) throw new WebDavError('etag');
        if (!previous) {
            await request(session, directory(session), {method: 'MKCOL'}, async response => {
                if (![201, 405].includes(response.status)) throw failure(response.status);
            });
        }
        await request(session, filename(session), {method: 'PUT', headers: {'Content-Type': 'application/json; charset=utf-8', ...(previous ? {'If-Match': previous.etag!} : {'If-None-Match': '*'})}, body: content}, async response => {
            if (![200, 201, 204].includes(response.status)) throw failure(response.status);
        });
        const verified = await read(session);
        if (!verified || verified.content !== content) throw new WebDavError('verify');
        return verified.file;
    }
    return {test, read, write};
}
