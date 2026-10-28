/**
 * @file src/platform/webdav/api.ts
 * 文件职责：在用户指定的 WebDAV 目录下读写、条件删除 FluentRead 配置密文并验证服务器能力。
 * 主要内容：只读连接测试、首次备份识别、补取并核验强 ETag；缺少强版本时在 PUT/DELETE 前重新核对密文摘要，
 * 兼容坚果云等服务返回的无引号 ETag，按服务原始版本值发出条件请求，上传后读回验证。
 * 内容核验无法原子阻止其他设备并发写入，由预览明确提示避免同时同步；不将弱 ETag 或内容摘要当作服务器版本。
 * 禁止跟随重定向、携带浏览器 Cookie 或返回服务器异常正文，防止连接凭据流向其他地址。
 * 模块边界：只消费后台会话与密文，不读取配置或保存密码；冲突合并由云备份服务处理。
 */
import {cancelResponseReader, cancelUnreadResponseBody, createRuntimeAbortContext} from '@/src/platform/http/runtime';
import {canMutateCloudFile, strongCloudEtag, type CloudSyncFile, type CloudSyncRemote} from '@/src/core/config/cloudSync';
import {parseWebDavProperties} from './properties';
import {GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
import {DRIVE_ENCRYPTION_FORMAT} from '@/src/platform/google-drive/encryption';
import {createWebDavSession, WebDavError, type WebDavConnection, type WebDavSession} from './connection';

export const WEBDAV_BACKUP_DIRECTORY = 'FluentRead/';
export const WEBDAV_BACKUP_FILE = 'fluentread-config.encrypted.json';
const XML_LIMIT = 128 * 1024;
function unquotedWebDavEtag(value: string | null): string | undefined {
    // 仅接受有界的单个可见 ASCII 标识，排除弱版本、通配符、列表和引号；不放宽共用的强 ETag 校验。
    return value && value.length <= 512 && !value.startsWith('W/') && /^[A-Za-z0-9][A-Za-z0-9._~+/=-]*$/u.test(value) ? value : undefined;
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
        let finished = false;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) {finished = true; break;}
                size += part.value.byteLength;
                if (size > limit) throw new WebDavError('tooLarge');
                chunks.push(part.value);
            }
        } finally {
            if (finished) reader.releaseLock();
            else cancelResponseReader(reader);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    }
    async function request<T>(session: WebDavSession, url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
        init.signal?.throwIfAborted();
        return session.request(async authorization => {
            init.signal?.throwIfAborted();
            const context = createRuntimeAbortContext(options.timeoutMs ?? 30_000, init.signal ?? undefined);
            return (async () => {
                let response: Response | undefined;
                let requestError: WebDavError | undefined;
                try {
                    response = await fetcher(url, {...init, headers: {...init.headers, Authorization: authorization}, signal: context.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
                    return await consume(response);
                } catch (error) {
                    requestError = error instanceof WebDavError
                        ? error
                        : new WebDavError(context.signal.aborted ? 'timeout' : 'network');
                } finally {
                    if (response) cancelUnreadResponseBody(response);
                }
                throw requestError;
            })().finally(context.cleanup);
        });
    }
    const directory = (session: WebDavSession) => new URL(WEBDAV_BACKUP_DIRECTORY, session.connection.url).href;
    const filename = (session: WebDavSession) => new URL(WEBDAV_BACKUP_FILE, directory(session)).href;
    async function checkDirectory(session: WebDavSession, url: string, allowMissing = false, signal?: AbortSignal): Promise<boolean> {
        return request(session, url, {method: 'PROPFIND', signal, headers: {Depth: '0', 'Content-Type': 'application/xml; charset=utf-8'}, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'}, async response => {
            if (allowMissing && [404, 409].includes(response.status)) return false;
            if (response.status !== 207) throw response.ok ? new WebDavError('invalidDav') : failure(response.status);
            const xml = await consumeText(response, XML_LIMIT);
            // 只检查 Depth:0 的目录能力，不执行 XML、实体展开或任意返回地址。
            if (!parseWebDavProperties(xml, url)?.collection) throw new WebDavError('invalidDav');
            return true;
        });
    }
    async function test(connection: WebDavConnection, signal?: AbortSignal): Promise<void> {
        await checkDirectory(createWebDavSession(connection, async () => connection), connection.url, false, signal);
    }
    async function read(session: WebDavSession, signal?: AbortSignal): Promise<CloudSyncRemote | null> {
        const url = filename(session);
        const remote = await request(session, url, {method: 'GET', signal}, async response => {
            if (response.status === 404) return null;
            if (response.status === 409) {
                // 坚果云等服务在备份父目录尚不存在时返回 409。先验证用户入口仍有效，
                // 再只读检查专属目录；不得将已有目录的未知冲突当成空备份或提前创建目录。
                await checkDirectory(session, session.connection.url, false, signal);
                if (!await checkDirectory(session, directory(session), true, signal)) return null;
                throw new WebDavError('http', response.status);
            }
            if (response.status !== 200) throw failure(response.status);
            const content = await consumeText(response, maxBytes);
            const rawEtag = response.headers.get('etag');
            const etag = strongCloudEtag(rawEtag);
            const unquotedEtag = unquotedWebDavEtag(rawEtag);
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
            const version = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
            return {file: {id: filename(session), version, modifiedTime: response.headers.get('last-modified') ?? '', ...(etag ? {etag} : {}), ...(unquotedEtag ? {unquotedEtag} : {})}, content};
        });
        if (!remote || remote.file.etag) return remote;
        let etag = await request(session, url, {method: 'PROPFIND', signal, headers: {Depth: '0', 'Content-Type': 'application/xml; charset=utf-8'}, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>'}, async response => {
            // 不具备属性能力仍可恢复；真正的鉴权、版本或网络错误必须提示用户。
            if ([405, 501].includes(response.status)) return undefined;
            if (response.status !== 207) throw failure(response.status);
            return parseWebDavProperties(await consumeText(response, XML_LIMIT), url)?.etag;
        });
        // 部分服务仅在 HEAD 中返回文件 ETag。它与属性值一样，必须经过条件
        // GET 和密文核对，不能仅凭时间戳、自己计算的 hash 或弱 ETag 来覆盖。
        if (!etag) etag = await request(session, url, {method: 'HEAD', signal}, async response => {
            if ([405, 501].includes(response.status)) return undefined;
            if (response.status !== 200) throw failure(response.status);
            return strongCloudEtag(response.headers.get('etag'));
        });
        if (!etag) return {...remote, file: {...remote.file, contentGuard: true}};
        // 属性与下载之间可能被另一设备更新。条件重读且逐字核对密文，
        // 防止把旧内容与新 ETag 配对后覆盖对方的修改。
        await request(session, url, {method: 'GET', signal, headers: {'If-Match': etag}}, async response => {
            if (response.status !== 200) throw failure(response.status);
            const returnedEtag = strongCloudEtag(response.headers.get('etag'));
            if (returnedEtag && returnedEtag !== etag || await consumeText(response, maxBytes) !== remote.content) throw new WebDavError('conflict');
        });
        remote.file.etag = etag;
        return remote;
    }
    async function mutationHeaders(session: WebDavSession, previous: CloudSyncFile): Promise<Record<string, string> | null> {
        if (previous.id !== filename(session) || !canMutateCloudFile(previous)) throw new WebDavError('etag');
        const etag = strongCloudEtag(previous.etag);
        if (etag) return {'If-Match': etag};
        // 确认后的最后一次内容核验必须位于实际写入/删除边界，不能只依赖 UI 预览。
        const current = await read(session);
        if (!current) return null;
        if (current.file.version !== previous.version) throw new WebDavError('conflict');
        // 若服务器恢复强版本能力立即使用它；无引号 ETag 须在内容核验后按服务器原值发送，
        // 避免丢弃可用版本后发送 *，导致坚果云拒绝覆盖。只有没有可用版本标识时才使用存在性条件。
        return {'If-Match': current.file.etag ?? current.file.unquotedEtag ?? '*'};
    }
    async function write(session: WebDavSession, content: string, previous: CloudSyncFile | null): Promise<CloudSyncFile> {
        let envelope: unknown;
        try {envelope = JSON.parse(content);} catch {throw new WebDavError('encryptedOnly');}
        if (!envelope || typeof envelope !== 'object' || !('format' in envelope) || envelope.format !== DRIVE_ENCRYPTION_FORMAT || !('ciphertext' in envelope) || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext || new TextEncoder().encode(content).length > maxBytes) throw new WebDavError('encryptedOnly');
        const headers = previous ? await mutationHeaders(session, previous) : {'If-None-Match': '*'};
        if (!headers) throw new WebDavError('conflict');
        if (!previous) {
            await request(session, directory(session), {method: 'MKCOL'}, async response => {
                if (![201, 405].includes(response.status)) throw failure(response.status);
            });
        }
        await request(session, filename(session), {method: 'PUT', headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}, body: content}, async response => {
            if (![200, 201, 204].includes(response.status)) throw failure(response.status);
        });
        const verified = await read(session);
        if (!verified || verified.content !== content) throw new WebDavError('verify');
        return verified.file;
    }
    async function remove(session: WebDavSession, previous: CloudSyncFile): Promise<void> {
        const headers = await mutationHeaders(session, previous);
        if (!headers) return;
        // 只删除固定备份文件；保留目录和其他文件。缺失视为幂等成功，412 不降级重试。
        await request(session, filename(session), {method: 'DELETE', headers}, async response => {
            if (![200, 204, 404].includes(response.status)) throw failure(response.status);
        });
    }
    return {test, read, write, remove};
}
