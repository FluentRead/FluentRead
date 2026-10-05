import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDriveApi} from '@/src/platform/google-drive/api';
import {DriveError} from '@/src/platform/google-drive/auth';
import {GOOGLE_DRIVE_CONFIG_FILE_NAME, GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
import {encryptDriveConfig} from '@/src/platform/google-drive/encryption';

const metadata = {id: 'fixture/file', name: GOOGLE_DRIVE_CONFIG_FILE_NAME, version: '1', modifiedTime: 'fixture-time'};
const session = {account: {id: 'fixture-account', email: 'tester@fixture.invalid'}, request: async <T>(operation: (token: string) => Promise<T>) => operation('fixture-token')};
function json(value: unknown, etag?: string) {return new Response(JSON.stringify(value), {headers: etag ? {etag} : {}});}
afterEach(() => vi.useRealTimers());
describe('Google Drive appDataFolder HTTP 边界', () => {
    it('删除使用同版本 API 的 If-Match，缺失文件幂等成功，冲突和鉴权失败保留错误', async () => {
        for (const conditionalApi of [undefined, 'v2'] as const) {
            for (const status of [204, 404]) {
                const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {status}));
                await createDriveApi(fetcher).remove(session, {...metadata, etag: '"delete-one"', conditionalApi});
                expect(fetcher).toHaveBeenCalledWith(`https://www.googleapis.com/drive/${conditionalApi ?? 'v3'}/files/fixture%2Ffile`, expect.objectContaining({method: 'DELETE', headers: {'If-Match': '"delete-one"', Authorization: 'Bearer fixture-token'}, redirect: 'error', credentials: 'omit'}));
            }
        }
        for (const status of [401, 403, 412, 500]) {
            await expect(createDriveApi(vi.fn(async () => new Response('private failure', {status}))).remove(session, {...metadata, etag: '"one"'})).rejects.toMatchObject({status});
        }
        const blocked = vi.fn();
        for (const patch of [{etag: undefined}, {etag: 'W/"weak"'}, {readOnly: true as const, etag: '"strong"'}]) await expect(createDriveApi(blocked).remove(session, {...metadata, ...patch})).rejects.toThrow('安全删除');
        expect(blocked).not.toHaveBeenCalled();
    });
    it('v3 不返回 ETag 时从相同文件版本的 v2 元数据补取，并在 v2 上条件更新及回读', async () => {
        let version = '1';
        let saved = await encryptDriveConfig({to:'fr'}, 'fixture secure passphrase');
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            const current = {...metadata, version};
            if (url.pathname.startsWith('/upload/drive/v2/')) {
                expect(init).toMatchObject({method:'PUT', headers:{'If-Match':'"v2-1"'}});
                expect(String(init?.body)).toContain('"title":');
                expect(String(init?.body)).not.toContain('"name":');
                saved = String(init?.body).split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0];
                version = '2';
                return json({...current, version, modifiedDate:'fixture-time', etag:'"v2-2"'});
            }
            if (url.pathname.startsWith('/drive/v2/')) return json({...current, modifiedDate:'fixture-time', etag:`"v2-${version}"`});
            if (url.searchParams.has('spaces')) return json({files:[current]});
            return url.searchParams.get('alt') === 'media' ? new Response(saved) : json(current);
        });
        const api = createDriveApi(fetcher);
        const remote = await api.read(session);
        expect(remote?.file).toMatchObject({etag:'"v2-1"', conditionalApi:'v2', version:'1'});
        const next = await encryptDriveConfig({to:'de'}, 'fixture secure passphrase');
        expect(await api.write(session, next, remote!.file)).toMatchObject({etag:'"v2-2"', conditionalApi:'v2', version:'2'});
        expect((await api.read(session))?.content).toBe(next);
    });
    it('v2 元数据属于其他文件或版本时拒绝配对；弱或缺失 ETag 仍可读取恢复', async () => {
        for (const compatible of [{...metadata,id:'other',modifiedDate:'fixture-time',etag:'"v2"'},{...metadata,version:'2',modifiedDate:'fixture-time',etag:'"v2"'}]) {
            const fetcher=vi.fn().mockResolvedValueOnce(json({files:[metadata]})).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(new Response('ciphertext')).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(json(compatible));
            await expect(createDriveApi(fetcher).read(session)).rejects.toThrow('读取期间');
            expect(fetcher.mock.calls.every(([,init])=>!['POST','PATCH','PUT','DELETE'].includes(init?.method))).toBe(true);
        }
        for (const etag of [undefined,'W/"weak"',1,'unquoted']) {
            const fetcher=vi.fn().mockResolvedValueOnce(json({files:[metadata]})).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(new Response('ciphertext')).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(json({...metadata,modifiedDate:'fixture-time',etag}));
            expect(await createDriveApi(fetcher).read(session)).toMatchObject({file:{readOnly:true},content:'ciphertext'});
        }
        const malformed=vi.fn().mockResolvedValueOnce(json({files:[metadata]})).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(new Response('ciphertext')).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(json(null));
        await expect(createDriveApi(malformed).read(session)).rejects.toThrow('文件信息无效');
        const content=await encryptDriveConfig({},'fixture secure passphrase');
        const stale=vi.fn(async()=>new Response(null,{status:412}));
        await expect(createDriveApi(stale).write(session,content,{...metadata,etag:'"v2"',conditionalApi:'v2'})).rejects.toMatchObject({status:412});
    });
    it('上传后逐字核验密文和文件身份，不把空文件、旧文件或上传期间的改动报为成功', async()=>{
        const content=await encryptDriveConfig({},'fixture secure passphrase');
        for (const result of [null,{id:metadata.id,content:'old'},{id:'another-file',content}]) {
            const info={...metadata,id:result?.id ?? metadata.id};
            const fetcher=vi.fn(async(input,init)=> init?.method==='PATCH' ? json(metadata,'"written"') : String(input).includes('spaces=') ? json({files:result?[info]:[]}) : String(input).includes('alt=media') ? new Response(result?.content) : json(info,'"read"'));
            await expect(createDriveApi(fetcher).write(session,content,{...metadata,etag:'"before"'})).rejects.toThrow('校验');
            expect(fetcher.mock.calls.every(([,init])=>init?.method!=='DELETE')).toBe(true);
        }
    });
    it('首次创建竞态只条件撤回自己的新文件，撤回冲突不掩盖备份竞态',async()=>{
        const content=await encryptDriveConfig({},'fixture secure passphrase');
        for (const [etag,status] of [['"created"',204],['"created"',412],[undefined,204]] as const) {
            const fetcher=vi.fn(async(_input,init)=> init?.method==='POST' ? json(metadata,etag) : init?.method==='DELETE' ? new Response(null,{status}) : json({files:[metadata,{...metadata,id:'other-device-file'}]}));
            await expect(createDriveApi(fetcher).write(session,content,null)).rejects.toMatchObject({status:409});
            const deletes=fetcher.mock.calls.filter(([,init])=>init?.method==='DELETE');
            expect(deletes).toHaveLength(etag ? 1 : 0);
            if(etag) expect(deletes[0]).toMatchObject([expect.stringContaining('fixture%2Ffile'),{headers:{'If-Match':etag}}]);
        }
    });
    it('缺少强 ETag 时拒绝覆盖，不能退回无条件 PATCH', async () => {
        const fetcher=vi.fn(); const content=await encryptDriveConfig({},'fixture secure passphrase');
        for (const etag of [undefined,'W/"weak"','unquoted']) await expect(createDriveApi(fetcher).write(session,content,{...metadata,etag})).rejects.toThrow('版本');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('限定应用空间和文件名；空云盘不下载', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => json({files: []}));
        expect(await createDriveApi(fetcher).read(session)).toBeNull();
        const url = new URL(String(fetcher.mock.calls[0][0]));
        expect(url.searchParams.get('spaces')).toBe('appDataFolder');
        expect(url.searchParams.get('q')).toBe(`name = '${GOOGLE_DRIVE_CONFIG_FILE_NAME}' and trashed = false`);
        expect(url.search).not.toContain('fixture-token');
        expect(fetcher.mock.calls[0][1]).toMatchObject({headers: {Authorization: 'Bearer fixture-token'}});
    });
    it('读取一致的媒体与元数据，编码文件 ID，并保留服务器条件标识', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(json({files: [metadata]})).mockResolvedValueOnce(json(metadata, '"fixture-etag"')).mockResolvedValueOnce(new Response('encrypted fixture content')).mockResolvedValueOnce(json(metadata, '"fixture-etag"'));
        const remote = await createDriveApi(fetcher).read(session);
        expect(remote).toEqual({file: {id: metadata.id, version: '1', modifiedTime: 'fixture-time', etag: '"fixture-etag"'}, content: 'encrypted fixture content'});
        expect(fetcher.mock.calls[2][0]).toContain('fixture%2Ffile?alt=media');
    });
    it('拒绝重复文件、错误元数据和读取期间发生的版本变化', async () => {
        for (const data of [null, {}, {files: null}, {files: [metadata, metadata]}, {files: [], nextPageToken: 'more'}, {files: [null]}, {files: [{}]}, {files: [{...metadata, id: 1}]}, {files: [{...metadata, id: ''}]}, {files: [{...metadata, version: 1}]}, {files: [{...metadata, modifiedTime: 1}]}]) await expect(createDriveApi(vi.fn(async () => json(data))).read(session)).rejects.toThrow();
        const fetcher = vi.fn().mockResolvedValueOnce(json({files: [metadata]})).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(new Response('ciphertext')).mockResolvedValueOnce(json({...metadata, version: '2'}));
        await expect(createDriveApi(fetcher).read(session)).rejects.toThrow('云端配置已变化');
    });
    it('限制 Content-Length 和实际流大小，拒绝无媒体流', async () => {
        for (const response of [new Response('ciphertext', {headers: {'content-length': String(GOOGLE_DRIVE_MAX_BYTES + 1)}}), new Response('x'.repeat(GOOGLE_DRIVE_MAX_BYTES + 1)), new Response(null)]) {
            const fetcher = vi.fn().mockResolvedValueOnce(json({files: [metadata]})).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(response);
            await expect(createDriveApi(fetcher).read(session)).rejects.toThrow();
        }
    });
    it('只上传加密配置，创建和更新使用不同方法，支持条件写入', async () => {
        const content = await encryptDriveConfig({private: 'fixture-content-secret'}, 'fixture secure passphrase');
        const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('alt=media') ? new Response(content) : String(input).includes('spaces=') ? json({files:[metadata]}) : json(metadata, '"new-etag"'));
        const api = createDriveApi(fetcher);
        await api.write(session, content, null);
        expect(fetcher.mock.calls[0][1]).toMatchObject({method: 'POST', body: expect.stringContaining('appDataFolder')});
        expect(String(fetcher.mock.calls[0][1]?.body)).not.toContain('fixture-content-secret');
        await api.write(session, content, {...metadata, etag: '"previous-etag"'});
        expect(fetcher.mock.calls[5][1]).toMatchObject({method: 'PATCH', headers: {'If-Match': '"previous-etag"'}});
        expect(String(fetcher.mock.calls[5][0])).toContain('fixture%2Ffile');
        await expect(api.write(session, content, metadata)).rejects.toThrow('版本');
        expect(fetcher).toHaveBeenCalledTimes(10);
        for (const invalid of ['broken', 'null', '{}', JSON.stringify({format: 'wrong'}), 'x'.repeat(GOOGLE_DRIVE_MAX_BYTES + 1)]) await expect(api.write(session, invalid, null)).rejects.toThrow('加密');
    });
    it('错误和超时不反射上游私密响应，不进行额外重试', async () => {
        for (const status of [401, 403, 412, 500]) {
            const fetcher = vi.fn(async () => new Response('fixture-private-upstream-error', {status}));
            const error = await createDriveApi(fetcher).read(session).catch(error => error);
            expect(error).toBeInstanceOf(DriveError);
            expect(error.status).toBe(status);
            expect(error.message).not.toContain('fixture-private');
            expect(fetcher).toHaveBeenCalledOnce();
        }
        await expect(createDriveApi(vi.fn(async () => {throw new Error('fixture-private-network-error');})).read(session)).rejects.toThrow('网络请求失败');
        await expect(createDriveApi(vi.fn(async () => new Response('invalid JSON'))).read(session)).rejects.toThrow('响应无效');
        vi.useFakeTimers();
        const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')))));
        const request = createDriveApi(fetcher).read(session).catch(error => error);
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await request).message).toContain('网络请求失败');
    });
});
