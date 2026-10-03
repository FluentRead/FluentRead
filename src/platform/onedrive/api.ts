/**
 * @file src/platform/onedrive/api.ts
 * 文件职责：在微软应用文件夹中读取和上传加密配置。
 * 主要内容：限定 Graph 地址、校验临时传输地址、限制响应体、检查版本与条件上传。
 * 模块边界：不接收明文配置；签名下载和上传地址不附加 OAuth 令牌，也不持久化。
 */
import {DriveError, type DriveSession} from '../google-drive/auth';
import type {DriveFile, DriveRemote} from '../google-drive/api';
import {DRIVE_ENCRYPTION_FORMAT} from '../google-drive/encryption';
import {GOOGLE_DRIVE_MAX_BYTES} from '../google-drive/constants';
import {ONEDRIVE_CONFIG_FILE, ONEDRIVE_GRAPH} from './constants';

const fail = (key: string, status?: number) => new DriveError(`settings.onedrive.${key}`, status);
const fields = 'id,eTag,lastModifiedDateTime,@microsoft.graph.downloadUrl';
function metadata(value: unknown): DriveFile {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id || !('eTag' in value) || typeof value.eTag !== 'string' || !value.eTag || !('lastModifiedDateTime' in value) || typeof value.lastModifiedDateTime !== 'string') throw fail('invalidFile');
    return {id: value.id, etag: value.eTag, version: value.eTag, modifiedTime: value.lastModifiedDateTime};
}
function transferUrl(value: unknown): string {
    if (typeof value !== 'string') throw fail('invalidFile');
    let url: URL;
    try {url = new URL(value);} catch {throw fail('invalidFile');}
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['1drv.com', 'sharepoint.com', 'onedrive.com', 'storage.live.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw fail('invalidFile');
    return url.href;
}
export function createOneDriveApi(fetcher: typeof fetch) {
    async function request<T>(session: DriveSession, url: string, init: RequestInit, consume: (response: Response) => Promise<T>, signed = false): Promise<T> {
        return session.request(async token => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), signed ? 60_000 : 30_000);
            let result: T;
            try {
                const response = await fetcher(url, {...init, headers: {...init.headers, ...(!signed ? {Authorization: `Bearer ${token}`} : {})}, redirect: 'error', signal: controller.signal});
                if (!response.ok) throw fail([409, 412].includes(response.status) ? 'cloudChanged' : response.status === 403 ? 'accessDenied' : response.status === 404 ? 'notFound' : response.status === 507 ? 'quotaExceeded' : 'requestFailed', response.status);
                result = await consume(response);
            } catch (error) {
                if (error instanceof DriveError) throw error;
                throw fail('networkFailed');
            } finally {
                clearTimeout(timer);
            }
            return result;
        });
    }
    const json = (session: DriveSession, path: string, init: RequestInit = {}) => request<unknown>(session, `${ONEDRIVE_GRAPH}${path}`, init, response => response.json());
    async function folder(session: DriveSession): Promise<string> {
        let value: unknown;
        try {value = await json(session, '/me/drive/special/approot?$select=id');}
        catch (error) {if (error instanceof DriveError && error.status === 404) throw fail('driveUnavailable'); throw error;}
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id) throw fail('invalidFile');
        return value.id;
    }
    async function read(session: DriveSession): Promise<DriveRemote | null> {
        const root = await folder(session);
        let value: unknown;
        try {value = await json(session, `/me/drive/items/${encodeURIComponent(root)}:/${ONEDRIVE_CONFIG_FILE}?$select=${fields}`);}
        catch (error) {if (error instanceof DriveError && error.status === 404) return null; throw error;}
        const before = metadata(value);
        const download = transferUrl((value as Record<string, unknown>)['@microsoft.graph.downloadUrl']);
        const content = await request(session, download, {}, async response => {
            if (Number(response.headers.get('content-length')) > GOOGLE_DRIVE_MAX_BYTES) throw fail('tooLarge');
            const reader = response.body?.getReader();
            if (!reader) throw fail('invalidFile');
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    length += chunk.value.byteLength;
                    if (length > GOOGLE_DRIVE_MAX_BYTES) throw fail('tooLarge');
                    chunks.push(chunk.value);
                }
            } finally {await reader.cancel();}
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        }, true);
        const after = metadata(await json(session, `/me/drive/items/${encodeURIComponent(before.id)}?$select=${fields}`));
        if (after.id !== before.id || after.version !== before.version) throw fail('cloudChanged');
        return {file: after, content};
    }
    async function write(session: DriveSession, content: string, previous: DriveFile | null): Promise<DriveFile> {
        let envelope: unknown;
        try {envelope = JSON.parse(content);} catch {throw fail('encryptedOnly');}
        const bytes = new TextEncoder().encode(content);
        if (!envelope || typeof envelope !== 'object' || !('format' in envelope) || envelope.format !== DRIVE_ENCRYPTION_FORMAT) throw fail('encryptedOnly');
        if (bytes.length > GOOGLE_DRIVE_MAX_BYTES) throw fail('tooLarge');
        if (previous && !previous.etag) throw fail('invalidFile');
        const root = await folder(session);
        const path = previous ? `/me/drive/items/${encodeURIComponent(previous.id)}/createUploadSession` : `/me/drive/items/${encodeURIComponent(root)}:/${ONEDRIVE_CONFIG_FILE}:/createUploadSession`;
        const created = await json(session, path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(previous ? {'If-Match': previous.etag!} : {})}, body: JSON.stringify({item: {name: ONEDRIVE_CONFIG_FILE, '@microsoft.graph.conflictBehavior': previous ? 'replace' : 'fail'}})});
        const upload = transferUrl(created && typeof created === 'object' && 'uploadUrl' in created ? created.uploadUrl : undefined);
        try {
            // 预览后和创建会话后各检查一次版本；首次创建由服务端拒绝同名覆盖。
            if (previous) {
                const current = metadata(await json(session, `/me/drive/items/${encodeURIComponent(previous.id)}?$select=${fields}`));
                if (current.id !== previous.id || current.etag !== previous.etag) throw fail('cloudChanged');
            }
            return await request(session, upload, {method: 'PUT', headers: {'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`}, body: bytes}, async response => {
                if (![200, 201].includes(response.status)) throw fail('requestFailed');
                return metadata(await response.json());
            }, true);
        } catch (error) {
            // 失败时取消临时上传会话；删除会话不会删除既有配置文件。
            try {await fetcher(upload, {method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10_000)});} catch { /* 原错误优先 */ }
            throw error;
        }
    }
    return {read, write};
}
