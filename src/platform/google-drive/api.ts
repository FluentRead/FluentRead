/**
 * @file src/platform/google-drive/api.ts
 * 文件职责：在 Google Drive 的 appDataFolder 中读取、写入与条件删除唯一的加密配置文件。
 * 主要内容：固定 Google 请求地址、超时和大小限制、重复文件检测、v3 缺少 ETag 时按相同版本补取 v2 元数据及条件更新/删除、保存后回读校验。
 * 模块边界：只接受加密封装，账号会话由 auth 管理，配置合并由同步服务管理。
 */
import {DriveError, type DriveSession} from './auth';
import {strongCloudEtag} from '@/src/core/config/cloudSync';
import {GOOGLE_DRIVE_CONFIG_FILE_NAME, GOOGLE_DRIVE_MAX_BYTES} from './constants';
import {DRIVE_ENCRYPTION_FORMAT} from './encryption';

export interface DriveFile {id: string; version: string; modifiedTime: string; etag?: string; readOnly?: true; conditionalApi?: 'v2'}
export interface DriveRemote {file: DriveFile; content: string}
const FIELDS = 'id,name,version,modifiedTime';
const BASE = 'https://www.googleapis.com/drive/v3/files';
const V2_BASE = 'https://www.googleapis.com/drive/v2/files';
const V2_FIELDS = 'id,version,modifiedDate,etag';

function file(value: unknown, etag: string | null): DriveFile {
    if (!value || typeof value !== 'object' || !('id' in value) || !('version' in value) || !('modifiedTime' in value) || typeof value.id !== 'string' || !value.id || typeof value.version !== 'string' || typeof value.modifiedTime !== 'string') throw new DriveError('Google Drive 文件信息无效。');
    return {id: value.id, version: value.version, modifiedTime: value.modifiedTime, ...(strongCloudEtag(etag) ? {etag: etag!} : {})};
}
function v2File(value: unknown): DriveFile {
    if (!value || typeof value !== 'object' || !('modifiedDate' in value)) throw new DriveError('Google Drive 文件信息无效。');
    const etag = 'etag' in value && typeof value.etag === 'string' ? strongCloudEtag(value.etag) : undefined;
    return {...file({...value, modifiedTime: value.modifiedDate}, etag ?? null), ...(etag ? {conditionalApi: 'v2' as const} : {readOnly: true as const})};
}
export function createDriveApi(fetcher: typeof fetch) {
    async function request<T>(session: DriveSession, url: string, init: RequestInit, consume: (response: Response) => Promise<T>, allowMissing = false): Promise<T> {
        return session.request(async token => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            const operation = (async () => {
                const response = await fetcher(url, {...init, headers: {...init.headers, Authorization: `Bearer ${token}`}, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
                if (!response.ok && !(allowMissing && response.status === 404)) {
                    if (response.status === 412) throw new DriveError('云端配置已变化，请重新生成预览。', 412);
                    if (response.status === 403) throw new DriveError('Google Drive 拒绝访问，请检查授权范围、测试用户及 API 配额。', 403);
                    throw new DriveError(`Google Drive 请求失败（HTTP ${response.status}），请重试。`, response.status);
                }
                return await consume(response);
            })();
            return operation.catch(error => {
                if (error instanceof DriveError) throw error;
                throw new DriveError('Google Drive 网络请求失败或响应无效，请检查网络后重试。');
            }).finally(() => clearTimeout(timer));
        });
    }
    async function read(session: DriveSession): Promise<DriveRemote | null> {
        const url = new URL(BASE);
        url.search = new URLSearchParams({spaces: 'appDataFolder', q: `name = '${GOOGLE_DRIVE_CONFIG_FILE_NAME}' and trashed = false`, pageSize: '2', fields: `nextPageToken,files(${FIELDS})`}).toString();
        const metadata = await request(session, url.href, {}, async response => {
            const data: unknown = await response.json();
            if (!data || typeof data !== 'object' || !('files' in data) || !Array.isArray(data.files)) throw new DriveError('Google Drive 文件列表无效。');
            if (data.files.length > 1 || ('nextPageToken' in data && data.nextPageToken)) throw new DriveError('发现多个同名同步文件，请先在 Google Drive 应用管理中清理重复数据。', 409);
            return data.files.length ? file(data.files[0], null) : null;
        });
        if (!metadata) return null;
        const encoded = encodeURIComponent(metadata.id);
        // 读取媒体前后再取元数据，避免预览基于上传过程中混合的版本。
        const before = await request(session, `${BASE}/${encoded}?fields=${FIELDS}`, {}, async response => file(await response.json(), response.headers.get('etag')));
        const content = await request(session, `${BASE}/${encoded}?alt=media`, {}, async response => {
            if (Number(response.headers.get('content-length')) > GOOGLE_DRIVE_MAX_BYTES) throw new DriveError('同步文件过大，请使用完整数据备份。');
            const reader = response.body?.getReader();
            if (!reader) throw new DriveError('无法读取同步文件。');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.byteLength;
                    if (size > GOOGLE_DRIVE_MAX_BYTES) throw new DriveError('同步文件过大，请使用完整数据备份。');
                    chunks.push(chunk.value);
                }
            } finally {await reader.cancel();}
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        });
        const after = await request(session, `${BASE}/${encoded}?fields=${FIELDS}`, {}, async response => file(await response.json(), response.headers.get('etag')));
        if (before.id !== metadata.id || after.id !== metadata.id || before.version !== after.version) throw new DriveError('读取期间云端配置已变化，请重试。');
        if (after.etag) return {file: after, content};
        // v3 File 没有 etag 字段，响应头也可能不提供。v2 的资源 ETag
        // 只在文件 ID 与单调版本均相同的情况下使用，不能把另一个版本配给已下载的密文。
        const compatible = await request(session, `${V2_BASE}/${encoded}?fields=${V2_FIELDS}`, {}, async response => v2File(await response.json()));
        if (compatible.id !== after.id || compatible.version !== after.version) throw new DriveError('读取期间云端配置已变化，请重试。');
        return {file: {...after, ...compatible}, content};
    }
    async function write(session: DriveSession, content: string, previous: DriveFile | null): Promise<DriveFile> {
        let envelope: unknown;
        try {envelope = JSON.parse(content);} catch {throw new DriveError('只允许上传本地加密后的配置。');}
        if (!envelope || typeof envelope !== 'object' || !('format' in envelope) || envelope.format !== DRIVE_ENCRYPTION_FORMAT || new TextEncoder().encode(content).length > GOOGLE_DRIVE_MAX_BYTES) throw new DriveError('只允许上传大小有效的加密配置。');
        if (previous && (previous.readOnly || !strongCloudEtag(previous.etag))) throw new DriveError('云端备份缺少安全覆盖所需的版本信息；仍可恢复，请重新读取后重试。');
        const v2 = previous?.conditionalApi === 'v2';
        const boundary = `fluentread-${crypto.randomUUID()}`;
        const metadata = {...(v2 ? {title: GOOGLE_DRIVE_CONFIG_FILE_NAME} : {name: GOOGLE_DRIVE_CONFIG_FILE_NAME}), mimeType: 'application/json', ...(!previous ? {parents: ['appDataFolder']} : {})};
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`;
        const endpoint = `https://www.googleapis.com/upload/drive/${v2 ? 'v2' : 'v3'}/files${previous ? `/${encodeURIComponent(previous.id)}` : ''}?uploadType=multipart&fields=${v2 ? V2_FIELDS : FIELDS}`;
        const written = await request(session, endpoint, {method: v2 ? 'PUT' : previous ? 'PATCH' : 'POST', headers: {'Content-Type': `multipart/related; boundary=${boundary}`, ...(previous?.etag ? {'If-Match': previous.etag} : {})}, body}, async response => v2 ? v2File(await response.json()) : file(await response.json(), response.headers.get('etag')));
        try {
            const verified = await read(session);
            if (!verified || verified.file.id !== written.id || verified.content !== content) throw new DriveError('云端保存后校验未通过，请重新读取备份后重试；本机配置未修改。');
            return verified.file;
        } catch (error) {
            // Drive 不提供文件名唯一约束。两台设备同时首次创建时，只撤回本次
            // 创建且版本仍未变化的文件；绝不删除对方或已有备份，也不无条件删除。
            if (!previous && error instanceof DriveError && error.status === 409 && strongCloudEtag(written.etag)) {
                await request(session, `${BASE}/${encodeURIComponent(written.id)}`, {method: 'DELETE', headers: {'If-Match': written.etag!}}, async () => undefined).catch(() => undefined);
            }
            throw error;
        }
    }
    async function remove(session: DriveSession, previous: DriveFile): Promise<void> {
        if (previous.readOnly || !strongCloudEtag(previous.etag)) throw new DriveError('云端备份缺少安全删除所需的版本信息，请到服务商管理页面手动删除。');
        // v2 资源的 ETag 必须配合同版本 API；禁止降级成无条件删除，也不删除整个应用空间。
        await request(session, `${previous.conditionalApi === 'v2' ? V2_BASE : BASE}/${encodeURIComponent(previous.id)}`, {method: 'DELETE', headers: {'If-Match': previous.etag!}}, async () => undefined, true);
    }
    return {read, write, remove};
}
