import {describe, expect, it, vi} from 'vitest';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavSession, parseWebDavConnection, WebDavError} from '@/src/platform/webdav/connection';
import {DRIVE_ENCRYPTION_FORMAT} from '@/src/platform/google-drive/encryption';

const connection = parseWebDavConnection({url: 'https://dav.fixture.invalid/base/', username: 'fixture', password: 'fixture-only', revision: null}, null);
const session = createWebDavSession(connection, async () => connection);
const content = JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: 'fixture-encrypted-content'});
const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
const response = (body: string | null, status = 200, headers: Record<string, string> = {}) => new Response(body, {status, headers});
describe('WebDAV 文件协议', () => {
    it('只读测试使用 Depth:0，备份只在专属目录内写入并带新建条件', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(response(xml, 207)).mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(null, 201)).mockResolvedValueOnce(response(null, 201)).mockResolvedValueOnce(response(content, 200, {etag: '"one"', 'last-modified': 'fixture-time'}));
        const api = createWebDavApi(fetcher);
        await api.test(connection);
        for (const valid of [xml.replaceAll('d:', '').replace('xmlns:d', 'xmlns'), xml.replace('<d:collection/>', '<d:collection></d:collection>')]) await createWebDavApi(vi.fn(async () => response(valid, 207))).test(connection);
        expect(fetcher.mock.calls[0]).toMatchObject([connection.url, {method: 'PROPFIND', headers: {Depth: '0', Authorization: expect.stringMatching(/^Basic /u)}, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'}]);
        expect(await api.read(session)).toBeNull();
        const file = await api.write(session, content, null);
        expect(file).toMatchObject({id: connection.url+'FluentRead/fluentread-config.encrypted.json', etag: '"one"', modifiedTime: 'fixture-time'});
        expect(fetcher.mock.calls[2][1]).toMatchObject({method: 'MKCOL'});
        expect(fetcher.mock.calls[3][1]).toMatchObject({method: 'PUT', headers: {'If-None-Match': '*'}, body: content});
        expect(fetcher.mock.calls.every(([url]) => url.startsWith(connection.url))).toBe(true);
    });
    it('已有目录可新建，已存在备份只使用强 ETag 条件覆盖；没有 ETag 仍可读取', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(response(null, 405)).mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(response(content, 200));
        const api = createWebDavApi(fetcher);
        const first = await api.write(session, content, null);
        expect(first.etag).toBeUndefined();
        for (const etag of [undefined, 'W/"weak"', 'bad', '"'+ 'x'.repeat(513)+'"']) await expect(api.write(session, content, {...first, etag})).rejects.toMatchObject({code: 'etag'});
        await expect(api.write(session, content, {...first, id: 'https://other.fixture.invalid', etag: '"one"'})).rejects.toMatchObject({code: 'etag'});
        fetcher.mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(response(content, 200, {etag: '"two"'}));
        expect(await api.write(session, content, {...first, etag: '"one"'})).toMatchObject({etag: '"two"'});
        expect(fetcher.mock.calls.at(-2)?.[1]).toMatchObject({method: 'PUT', headers: {'If-Match': '"one"'}});
        for (const etag of ['W/"weak"', 'bad']) {
            fetcher.mockResolvedValueOnce(response(content, 200, {etag}));
            expect((await api.read(session))?.file.etag).toBeUndefined();
        }
    });
    it('鉴权、权限、锁、配额和并发错误只返回安全代码，不反射响应正文', async () => {
        for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [409, 'notFound'], [412, 'conflict'], [423, 'locked'], [507, 'quota'], [500, 'http']] as const) {
            const fetcher = vi.fn(async () => response('fixture-private-server-body', status));
            await expect(createWebDavApi(fetcher).read(session)).rejects.toMatchObject({code, status});
            await expect(createWebDavApi(fetcher).test(connection)).rejects.toMatchObject({code, status});
        }
        const first = {id: connection.url+'FluentRead/fluentread-config.encrypted.json', version: '1', modifiedTime: '', etag: '"one"'};
        await expect(createWebDavApi(vi.fn(async () => response('private', 412))).write(session, content, first)).rejects.toMatchObject({code: 'conflict'});
        await expect(createWebDavApi(vi.fn(async () => response(null, 403))).write(session, content, null)).rejects.toMatchObject({code: 'forbidden'});
    });
    it('拒绝不正确的 WebDAV 响应、损坏或超大文件；上传只允许密文', async () => {
        for (const bad of [response('HTML', 200), response('private', 404), response('<x/>', 207), response('<!DOCTYPE x>'+xml, 207), response(xml.replace('200 OK','403 Forbidden'), 207), response(null, 207), response(xml.replace('xmlns:d="DAV:"', 'xmlns:d="DAV:" xmlns:d="urn:wrong"'), 207), response(xml.replace('<d:collection/>', '<wrong:collection/>'), 207), response(xml.replace('200 OK', '403 Forbidden').replace('</d:response>', '<d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'), 207)]) await expect(createWebDavApi(vi.fn(async () => bad)).test(connection)).rejects.toThrow(WebDavError);
        await expect(createWebDavApi(vi.fn(async () => response('x'.repeat(128*1024+1), 207))).test(connection)).rejects.toMatchObject({code: 'tooLarge'});
        await expect(createWebDavApi(vi.fn(async () => response('xx', 200, {'content-length': '11'})), {maxBytes: 10}).read(session)).rejects.toMatchObject({code: 'tooLarge'});
        await expect(createWebDavApi(vi.fn(async () => response('x'.repeat(11))), {maxBytes: 10}).read(session)).rejects.toMatchObject({code: 'tooLarge'});
        await expect(createWebDavApi(vi.fn(async () => response(null))).read(session)).rejects.toMatchObject({code: 'invalidDav'});
        await expect(createWebDavApi(vi.fn(async () => new Response(new Uint8Array([255])))).read(session)).rejects.toMatchObject({code: 'network'});
        const fetcher = vi.fn();
        for (const value of ['invalid', 'null', '{}', JSON.stringify({format: 'plain'}), JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT}), JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: 1}), JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: ''}), content+' '.repeat(100)]) await expect(createWebDavApi(fetcher, {maxBytes: 100}).write(session, value, null)).rejects.toMatchObject({code: 'encryptedOnly'});
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('上传后校验失败不误报成功，网络和超时有独立错误', async () => {
        const previous = {id: connection.url+'FluentRead/fluentread-config.encrypted.json', version: '1', modifiedTime: '', etag: '"one"'};
        for (const next of [response(null, 404), response('other')]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(next);
            await expect(createWebDavApi(fetcher).write(session, content, previous)).rejects.toMatchObject({code: 'verify'});
        }
        await expect(createWebDavApi(vi.fn(async () => {throw new Error('fixture-private');})).read(session)).rejects.toMatchObject({code: 'network'});
        const fetcher = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')))));
        await expect(createWebDavApi(fetcher, {timeoutMs: 1}).read(session)).rejects.toMatchObject({code: 'timeout'});
    });
});
