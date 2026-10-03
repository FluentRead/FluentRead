import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDropboxApi} from '@/src/platform/dropbox/api';
import {DropboxError} from '@/src/platform/dropbox/auth';
import type {DriveSession} from '@/src/platform/google-drive/auth';
import {GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
import {encryptDriveConfig} from '@/src/platform/google-drive/encryption';
const session: DriveSession = {account: {id: 'dropbox:fixture', email: ''}, request: operation => operation('fixture-token')};
const meta = {id: 'id:fixture', rev: 'fixture-revision', server_modified: '2026-10-03T00:00:00Z', size: 10};
function download(body: BodyInit | null = 'fixture-cipher', value: unknown = meta, extra: HeadersInit = {}) {return new Response(body, {headers: {'Dropbox-API-Result': JSON.stringify(value), ...extra}});}
afterEach(() => vi.useRealTimers());
describe('Dropbox 应用文件夹读写', () => {
    it('下载内容与修订号来自同一响应；只把明确的 not_found 视为首次备份', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({error: {'.tag': 'path', path: {'.tag': 'not_found'}}}), {status: 409})).mockResolvedValueOnce(download());
        const api = createDropboxApi(fetcher); expect(await api.read(session)).toBeNull(); expect(await api.read(session)).toEqual({file: {id: meta.id, version: meta.rev, modifiedTime: meta.server_modified}, content: 'fixture-cipher'});
        expect(fetcher.mock.calls[1][0]).toBe('https://content.dropboxapi.com/2/files/download');
        expect(JSON.parse((fetcher.mock.calls[1][1]!.headers as Record<string, string>)['Dropbox-API-Arg'])).toEqual({path: '/fluentread-config.encrypted.json'});
        for (const value of [{error: {'.tag': 'path', path: {'.tag': 'not_file'}}}, {error: {'.tag': 'other'}}, {}, null]) await expect(createDropboxApi(vi.fn(async () => new Response(JSON.stringify(value), {status: 409}))).read(session)).rejects.toThrow('file');
    });
    it('真实 FileMetadata 无需 .tag，其他类型、缺字段与过大内容不能被读取', async () => {
        for (const value of [null, {}, {...meta, '.tag': 'folder'}, {...meta, id: 1}, {...meta, id: ''}, {...meta, rev: 1}, {...meta, rev: ''}, {...meta, server_modified: 1}, {...meta, size: '1'}, {...meta, size: -1}, {...meta, size: Infinity}, {...meta, size: GOOGLE_DRIVE_MAX_BYTES + 1}]) await expect(createDropboxApi(vi.fn(async () => download('x', value))).read(session)).rejects.toBeInstanceOf(DropboxError);
        expect((await createDropboxApi(vi.fn(async () => download('x', {...meta, '.tag': 'file'}))).read(session))?.content).toBe('x');
        for (const response of [download(null), download('x', meta, {'content-length': String(GOOGLE_DRIVE_MAX_BYTES + 1)}), download(new Uint8Array(GOOGLE_DRIVE_MAX_BYTES + 1)), download(new Uint8Array([255])), new Response('x', {headers: {'Dropbox-API-Result': 'broken'}}), new Response('x')]) await expect(createDropboxApi(vi.fn(async () => response)).read(session)).rejects.toBeInstanceOf(DropboxError);
    });
    it('首次 add 与条件 update 不自动重命名，不无条件覆盖', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(meta)); const api = createDropboxApi(fetcher);
        const content = await encryptDriveConfig({fixture: 'fixture-only-secret'}, 'fixture passphrase');
        await api.write(session, content, null); await api.write(session, content, {id: meta.id, version: meta.rev, modifiedTime: meta.server_modified});
        const args = fetcher.mock.calls.map(call => JSON.parse((call[1]!.headers as Record<string, string>)['Dropbox-API-Arg']));
        expect(args[0]).toMatchObject({mode: {'.tag': 'add'}, autorename: false, strict_conflict: true, mute: true}); expect(args[1].mode).toEqual({'.tag': 'update', update: meta.rev});
        expect(fetcher.mock.calls[0][1]).toMatchObject({body: content, credentials: 'omit', redirect: 'error'}); expect(content).not.toContain('fixture-only-secret');
        for (const invalid of ['broken', 'null', '{}', '{"format":"other"}', JSON.stringify({format: 'fluentread-drive-encrypted', data: 'x'.repeat(GOOGLE_DRIVE_MAX_BYTES)})]) await expect(api.write(session, invalid, null)).rejects.toThrow('encrypted');
        await expect(createDropboxApi(vi.fn(async () => new Response('fixture-private-error', {status: 409}))).write(session, content, null)).rejects.toThrow('conflict');
        await expect(createDropboxApi(vi.fn(async () => Response.json({}))).write(session, content, null)).rejects.toThrow('file');
    });
    it('HTTP、网络、解析和超时错误只返回固定提示，不自动重试', async () => {
        for (const status of [401, 403, 429, 500]) {const fetcher = vi.fn(async () => new Response('fixture-private-error', {status})); const error = await createDropboxApi(fetcher).read(session).catch(error => error); expect(error.status).toBe(status); expect(error.message).not.toContain('fixture-private'); expect(fetcher).toHaveBeenCalledOnce();}
        await expect(createDropboxApi(vi.fn(async () => {throw new Error('fixture-secret');})).read(session)).rejects.toThrow('network');
        await expect(createDropboxApi(vi.fn(async () => new Response('bad', {status: 409}))).read(session)).rejects.toThrow('network');
        vi.useFakeTimers(); const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout'))))); const request = createDropboxApi(fetcher).read(session).catch(error => error); await vi.advanceTimersByTimeAsync(30000); expect((await request).message).toContain('network');
    });
});
