import {afterEach, describe, expect, it, vi} from 'vitest';
import {createOneDriveApi} from '@/src/platform/onedrive/api';
import {DriveError, type DriveSession} from '@/src/platform/google-drive/auth';
import {DRIVE_ENCRYPTION_FORMAT} from '@/src/platform/google-drive/encryption';
import {GOOGLE_DRIVE_MAX_BYTES} from '@/src/platform/google-drive/constants';
const data = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const file = (version = 'v1') => ({id: 'synthetic-file', eTag: version, lastModifiedDateTime: '2026-10-03T00:00:00Z', '@microsoft.graph.downloadUrl': 'https://fixture.files.1drv.com/download'});
const previous = {id: 'synthetic-file', version: 'v1', etag: 'v1', modifiedTime: '2026-10-03T00:00:00Z'};
const encrypted = JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: 'synthetic-encrypted-payload'});
const session: DriveSession = {account: {id: 'onedrive:synthetic-user', email: ''}, request: operation => operation('synthetic-bearer')};
function fixture() {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === 'DELETE') return new Response(null, {status: 204});
        if (url.includes('createUploadSession')) return data({uploadUrl: 'https://fixture.up.1drv.com/upload'});
        if (url.includes('/upload')) return data(file('v2'), 201);
        if (url.includes('/download')) return new Response(encrypted);
        if (url.includes('/special/approot')) return data({id: 'synthetic-folder'});
        return data(file());
    });
    return {fetcher, api: createOneDriveApi(fetcher)};
}
afterEach(() => vi.useRealTimers());
describe('OneDrive encrypted application-folder API', () => {
    it('reads only the app folder, never forwards a bearer token to signed URLs and checks the version after download', async () => {
        const f = fixture();
        expect(await f.api.read(session)).toEqual({file: previous, content: encrypted});
        const download = f.fetcher.mock.calls.find(([url]) => String(url).includes('/download'))!;
        expect(download[1]?.headers).not.toHaveProperty('Authorization');
        expect(download[1]?.redirect).toBe('error');
        expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('graph.microsoft.com')).every(([, init]) => (init!.headers as Record<string,string>).Authorization === 'Bearer synthetic-bearer')).toBe(true);
    });
    it('distinguishes an empty backup from an unavailable OneDrive or a removed file', async () => {
        const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id: 'folder'})).mockResolvedValueOnce(data({}, 404));
        expect(await f.api.read(session)).toBeNull();
        const g = fixture(); g.fetcher.mockResolvedValueOnce(data({}, 404));
        await expect(g.api.read(session)).rejects.toThrow('driveUnavailable');
        const h = fixture(); h.fetcher.mockResolvedValueOnce(data({id: 'folder'})).mockResolvedValueOnce(data(file())).mockResolvedValueOnce(new Response(encrypted)).mockResolvedValueOnce(data({},404));
        await expect(h.api.read(session)).rejects.toThrow('notFound');
    });
    it('rejects malformed metadata and untrusted signed transfer addresses', async () => {
        for (const value of [null, 1, {}, {id: 1}, {id: ''}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data(value)); await expect(f.api.read(session)).rejects.toThrow('invalidFile');
        }
        for (const value of [null, 1, {}, {...file(), id: ''}, {...file(), id: 1}, {...file(), eTag: ''}, {...file(), eTag: 1}, {...file(), lastModifiedDateTime: 1}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data(value)); await expect(f.api.read(session)).rejects.toThrow('invalidFile');
        }
        for (const url of [undefined, 1, 'bad URL', 'http://fixture.1drv.com/file', 'https://user:pass@fixture.1drv.com/file', 'https://fixture.1drv.com:444/file', 'https://fixture.1drv.com/file#fragment', 'https://1drv.com.evil.invalid/file', 'https://evil.invalid/file']) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data({...file(), '@microsoft.graph.downloadUrl': url}));
            await expect(f.api.read(session)).rejects.toThrow('invalidFile'); expect(f.fetcher).toHaveBeenCalledTimes(2);
        }
    });
    it('supports Microsoft personal and organization transfer hosts and refuses changed downloads', async () => {
        for (const url of ['https://1drv.com/file','https://tenant.sharepoint.com/file','https://storage.live.com/file','https://fixture.onedrive.com/file']) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data({...file(), '@microsoft.graph.downloadUrl':url})).mockResolvedValueOnce(new Response(encrypted)).mockResolvedValueOnce(data(file()));
            expect((await f.api.read(session))?.content).toBe(encrypted);
        }
        for (const after of [file('v2'), {...file(),id:'different'}]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data(file())).mockResolvedValueOnce(new Response(encrypted)).mockResolvedValueOnce(data(after));
            await expect(f.api.read(session)).rejects.toThrow('cloudChanged');
        }
    });
    it('limits advertised and streamed payloads, and rejects unavailable or invalid UTF-8 bodies', async () => {
        for (const body of [new Response('x',{headers:{'content-length': String(GOOGLE_DRIVE_MAX_BYTES+1)}}), new Response(null), new Response(new Uint8Array([255])), new Response(new Uint8Array(GOOGLE_DRIVE_MAX_BYTES+1))]) {
            const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data(file())).mockResolvedValueOnce(body);
            await expect(f.api.read(session)).rejects.toBeInstanceOf(DriveError);
        }
        const f = fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data(file())).mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('one'));controller.enqueue(new TextEncoder().encode('two'));controller.close();}}))).mockResolvedValueOnce(data(file()));
        expect((await f.api.read(session))?.content).toBe('onetwo');
    });
    it('uses documented conditional upload sessions for replacement, and fail-on-conflict for first creation', async () => {
        for (const old of [null,previous]) {
            const f = fixture(); expect((await f.api.write(session,encrypted,old)).version).toBe('v2');
            const create = f.fetcher.mock.calls.find(([url]) => String(url).includes('createUploadSession'))!;
            expect(JSON.parse(create[1]!.body as string).item['@microsoft.graph.conflictBehavior']).toBe(old ? 'replace':'fail');
            expect((create[1]!.headers as Record<string,string>)['If-Match']).toBe(old ? 'v1':undefined);
            const upload = f.fetcher.mock.calls.find(([url]) => String(url).endsWith('/upload'))!;
            expect(upload[1]!.headers).not.toHaveProperty('Authorization');
            expect(new TextDecoder().decode(upload[1]!.body as Uint8Array)).toBe(encrypted);
            expect((upload[1]!.headers as Record<string,string>)['Content-Range']).toBe(`bytes 0-${new TextEncoder().encode(encrypted).length-1}/${new TextEncoder().encode(encrypted).length}`);
        }
    });
    it('never uploads plaintext or an oversized envelope', async () => {
        for (const content of ['bad json','null','1','{}','{"format":"bad"}']) {
            const f=fixture(); await expect(f.api.write(session,content,null)).rejects.toThrow('encryptedOnly'); expect(f.fetcher).not.toHaveBeenCalled();
        }
        const f=fixture(); await expect(f.api.write(session,JSON.stringify({format:DRIVE_ENCRYPTION_FORMAT,padding:'x'.repeat(GOOGLE_DRIVE_MAX_BYTES)}),null)).rejects.toThrow('tooLarge');
        await expect(f.api.write(session,encrypted,{...previous,etag:undefined})).rejects.toThrow('invalidFile'); expect(f.fetcher).not.toHaveBeenCalled();
    });
    it('cancels a temporary upload if the file changed after session creation or upload failed', async () => {
        for (const current of [file('v2'),{...file(),id:'different'}]) {
            const f=fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data({uploadUrl:'https://fixture.up.1drv.com/upload'})).mockResolvedValueOnce(data(current));
            await expect(f.api.write(session,encrypted,previous)).rejects.toThrow('cloudChanged');
            expect(f.fetcher).toHaveBeenLastCalledWith('https://fixture.up.1drv.com/upload',expect.objectContaining({method:'DELETE'}));
            expect(f.fetcher.mock.calls.some(([,init]) => init?.method==='PUT')).toBe(false);
        }
        const f=fixture(); f.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data({uploadUrl:'https://fixture.up.1drv.com/upload'})).mockResolvedValueOnce(data({},202)).mockRejectedValueOnce(new Error('cleanup failed'));
        await expect(f.api.write(session,encrypted,null)).rejects.toThrow('requestFailed');
        for (const value of [null,{}, {uploadUrl:'https://evil.invalid/upload'}]) {
            const g=fixture(); g.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data(value)); await expect(g.api.write(session,encrypted,null)).rejects.toThrow('invalidFile');
        }
    });
    it('maps provider failures without reflecting private response bodies', async () => {
        for (const [status,key] of [[409,'cloudChanged'],[412,'cloudChanged'],[403,'accessDenied'],[507,'quotaExceeded'],[500,'requestFailed'],[401,'requestFailed']] as const) {
            const f=fixture(); f.fetcher.mockResolvedValueOnce(data({secret:'synthetic-private'},status)); await expect(f.api.read(session)).rejects.toThrow(key);
        }
        const f=fixture(); f.fetcher.mockRejectedValueOnce(new Error('synthetic-private')); await expect(f.api.read(session)).rejects.toThrow('networkFailed');
        const g=fixture(); g.fetcher.mockResolvedValueOnce(new Response('bad JSON')); await expect(g.api.read(session)).rejects.toThrow('networkFailed');
        const denied=fixture(); denied.fetcher.mockResolvedValueOnce(data({id:'folder'})).mockResolvedValueOnce(data({},403)); await expect(denied.api.read(session)).rejects.toThrow('accessDenied');
        const h=fixture(); h.fetcher.mockResolvedValueOnce(data({},403)); await expect(h.api.write(session,encrypted,null)).rejects.toThrow('accessDenied');
    });
    it('aborts a slow request rather than retaining an active transfer indefinitely', async () => {
        vi.useFakeTimers(); const f=fixture(); f.fetcher.mockImplementation(async (_,init) => new Promise((_,reject) => init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')))));
        const assertion=expect(f.api.read(session)).rejects.toThrow('networkFailed'); await vi.advanceTimersByTimeAsync(30_000); await assertion;
    });
});
