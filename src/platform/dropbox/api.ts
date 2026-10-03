/**
 * @file src/platform/dropbox/api.ts
 * 文件职责：在 Dropbox App folder 的固定路径读取和条件写入配置密文。
 * 主要内容：下载响应元数据与内容属于同一版本；以 rev 更新、以 add 首次创建，
 * 禁止自动重命名或无条件覆盖；设置超时和流式大小预算，错误不反射供应商私密响应。
 * 模块边界：不执行 OAuth 或读取本机配置；沿用现有同步事务的文件与会话结构。
 */
import type {DriveSession} from '../google-drive/auth';
import type {DriveFile, DriveRemote} from '../google-drive/api';
import {DRIVE_ENCRYPTION_FORMAT} from '../google-drive/encryption';
import {GOOGLE_DRIVE_MAX_BYTES} from '../google-drive/constants';
import {DropboxError} from './auth';
import {DROPBOX_CONFIG_PATH} from './constants';

function fail(key: string, status?: number) {return new DropboxError(`settings.dropbox.error.${key}`, status);}
function metadata(value: unknown): DriveFile {
    const data = value as {'.tag'?: unknown; id?: unknown; rev?: unknown; server_modified?: unknown; size?: unknown} | null;
    if (!data || (data['.tag'] !== undefined && data['.tag'] !== 'file') || typeof data.id !== 'string' || !data.id || typeof data.rev !== 'string' || !data.rev || typeof data.server_modified !== 'string' || typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size < 0) throw fail('file');
    if (data.size > GOOGLE_DRIVE_MAX_BYTES) throw fail('size');
    return {id: data.id, version: data.rev, modifiedTime: data.server_modified};
}
export function createDropboxApi(fetcher: typeof fetch) {
    async function request<T>(session: DriveSession, endpoint: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
        return session.request(async token => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            const operation = (async () => {
                const response = await fetcher(`https://content.dropboxapi.com/2/files/${endpoint}`, {...init, method: 'POST', headers: {...init.headers, Authorization: `Bearer ${token}`}, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal});
                if (!response.ok && response.status !== 409) throw fail(response.status === 401 ? 'expired' : response.status === 403 ? 'permission' : response.status === 429 ? 'rateLimit' : 'request', response.status);
                return await consume(response);
            })();
            return operation.catch(error => {
                if (error instanceof DropboxError) throw error;
                throw fail('network');
            }).finally(() => clearTimeout(timer));
        });
    }
    async function read(session: DriveSession): Promise<DriveRemote | null> {
        return request(session, 'download', {headers: {'Dropbox-API-Arg': JSON.stringify({path: DROPBOX_CONFIG_PATH})}}, async response => {
            if (response.status === 409) {
                const result = await response.json() as {error?: {'.tag'?: unknown; path?: {'.tag'?: unknown}}};
                if (result?.error?.['.tag'] === 'path' && result.error.path?.['.tag'] === 'not_found') return null;
                throw fail('file', 409);
            }
            const file = metadata(JSON.parse(response.headers.get('Dropbox-API-Result') || 'null'));
            if (Number(response.headers.get('content-length')) > GOOGLE_DRIVE_MAX_BYTES) throw fail('size');
            const reader = response.body?.getReader();
            if (!reader) throw fail('file');
            const chunks: Uint8Array[] = []; let size = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.byteLength;
                    if (size > GOOGLE_DRIVE_MAX_BYTES) throw fail('size');
                    chunks.push(chunk.value);
                }
            } finally {await reader.cancel();}
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
            return {file, content: new TextDecoder('utf-8', {fatal: true}).decode(bytes)};
        });
    }
    async function write(session: DriveSession, content: string, previous: DriveFile | null): Promise<DriveFile> {
        let envelope: {format?: unknown} | null;
        try {envelope = JSON.parse(content);} catch {throw fail('encrypted');}
        if (!envelope || envelope.format !== DRIVE_ENCRYPTION_FORMAT || new TextEncoder().encode(content).byteLength > GOOGLE_DRIVE_MAX_BYTES) throw fail('encrypted');
        return request(session, 'upload', {headers: {'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({path: DROPBOX_CONFIG_PATH, mode: previous ? {'.tag': 'update', update: previous.version} : {'.tag': 'add'}, autorename: false, strict_conflict: true, mute: true})}, body: content}, async response => {
            if (response.status === 409) throw fail('conflict', 409);
            return metadata(await response.json());
        });
    }
    return {read, write};
}
