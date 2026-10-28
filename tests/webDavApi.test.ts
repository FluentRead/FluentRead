import {describe, expect, it, vi} from 'vitest';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavSession, parseWebDavConnection, WebDavError} from '@/src/platform/webdav/connection';
import {DRIVE_ENCRYPTION_FORMAT} from '@/src/platform/google-drive/encryption';

const connection = parseWebDavConnection({url: 'https://dav.fixture.invalid/base/', username: 'fixture', password: 'fixture-only', revision: null}, null);
const session = createWebDavSession(connection, async () => connection);
const content = JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: 'fixture-encrypted-content'});
const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/base/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
const response = (body: string | null, status = 200, headers: Record<string, string> = {}) => new Response(body, {status, headers});
const metadata = (etag = '&quot;one&quot;', href = '/base/FluentRead/fluentread-config.encrypted.json') => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
describe('WebDAV 文件协议', () => {
    it('备份缺失时取消未读响应，不等服务器取消握手且继续正常处理下一次读取', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({cancel}), {status: 404}))
            .mockResolvedValueOnce(response(content, 200, {etag: '"current"'}));
        const api = createWebDavApi(fetcher);
        await expect(api.read(session)).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
        await expect(api.read(session)).resolves.toMatchObject({content, file: {etag: '"current"'}});
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('超限流立即释放读取锁，取消握手未决不阻断大小错误', async () => {
        vi.useFakeTimers();
        try {
            const cancel = vi.fn(() => new Promise<void>(() => {}));
            const body = new ReadableStream<Uint8Array>({
                start(controller) {controller.enqueue(new Uint8Array(9));}, cancel,
            });
            const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
            let settled = false;
            const result = createWebDavApi(fetcher, {maxBytes: 8}).read(session).catch(error => {settled = true; return error;});
            await vi.advanceTimersByTimeAsync(0);
            expect(cancel).toHaveBeenCalledOnce();
            expect(body.locked).toBe(false);
            expect(settled).toBe(true);
            expect(await result).toMatchObject({code: 'tooLarge'});
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('保留无引号 ETag，在内容核验后使用最新原值覆盖和删除，拒绝陈旧内容', async () => {
        let current: string | null = content;
        let etag = 'fixture_version-1';
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'GET') return response(current, current === null ? 404 : 200, {etag});
            if (init?.method === 'PROPFIND' || init?.method === 'HEAD') return response(null, 405);
            const match = new Headers(init?.headers).get('If-Match');
            if (match !== etag) return response(null, 412);
            if (init?.method === 'PUT') {current = init.body as string; etag = 'fixture_version-3'; return response(null, 204);}
            if (init?.method === 'DELETE') {current = null; return response(null, 204);}
            throw new Error('unexpected request');
        });
        const api = createWebDavApi(fetcher);
        const first = (await api.read(session))!.file;
        expect(first).toMatchObject({contentGuard: true, unquotedEtag: 'fixture_version-1'});
        expect(first.etag).toBeUndefined();
        // 服务端标识变更但内容一致时，写入边界重新读取并使用最新标识。
        etag = 'fixture_version-2';
        const next = JSON.stringify({format: DRIVE_ENCRYPTION_FORMAT, ciphertext: 'second encrypted backup'});
        const second = await api.write(session, next, first);
        expect(current).toBe(next);
        expect(second.unquotedEtag).toBe('fixture_version-3');
        expect(fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.headers).toMatchObject({'If-Match': 'fixture_version-2'});
        for (const operation of [() => api.write(session, content, first), () => api.remove(session, first)]) {
            const before = fetcher.mock.calls.filter(([, init]) => ['PUT', 'DELETE'].includes(init!.method!)).length;
            await expect(operation()).rejects.toMatchObject({code: 'conflict'});
            expect(fetcher.mock.calls.filter(([, init]) => ['PUT', 'DELETE'].includes(init!.method!))).toHaveLength(before);
        }
        await api.remove(session, second);
        expect(current).toBeNull();
        expect(fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[1]?.headers).toMatchObject({'If-Match': 'fixture_version-3'});
    });
    it('无引号 ETag 只接受有界单值，不把弱标识、通配符、列表和异常值作为版本', async () => {
        for (const etag of ['W/weak', 'W/"weak"', '*', 'one,two', 'one two', '"partial', 'x'.repeat(513)]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(content, 200, {etag})).mockResolvedValueOnce(response(null, 405)).mockResolvedValueOnce(response(null, 405));
            const remote = await createWebDavApi(fetcher).read(session);
            expect(remote?.file).toMatchObject({contentGuard: true});
            // 不能把无效值保存在后续条件请求中。
            expect(remote?.file.unquotedEtag).toBeUndefined();
        }
    });
    it('仅条件删除固定备份文件，保留目录与其他文件；缺失幂等、冲突拒绝、异步或多状态不冒充成功', async () => {
        const file = {id: connection.url + 'FluentRead/fluentread-config.encrypted.json', version: '1', modifiedTime: '', etag: '"one"'};
        for (const status of [200, 204, 404]) {
            const fetcher = vi.fn<typeof fetch>(async () => response(null, status));
            await createWebDavApi(fetcher).remove(session, file);
            expect(fetcher).toHaveBeenCalledOnce();
            expect(fetcher).toHaveBeenCalledWith(file.id, expect.objectContaining({method: 'DELETE', headers: expect.objectContaining({'If-Match': '"one"'}), redirect: 'error', credentials: 'omit'}));
        }
        for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [412, 'conflict'], [423, 'locked'], [405, 'http'], [202, 'http'], [207, 'http']] as const) await expect(createWebDavApi(vi.fn(async () => response('private failure', status))).remove(session, file)).rejects.toMatchObject({status, code});
        const blocked = vi.fn();
        for (const patch of [{id: connection.url}, {etag: undefined}, {etag: 'W/"weak"'}, {readOnly: true as const}]) await expect(createWebDavApi(blocked).remove(session, {...file, ...patch})).rejects.toMatchObject({code: 'etag'});
        expect(blocked).not.toHaveBeenCalled();
    });
    it('GET 和属性均未返回 ETag 时补查 HEAD，核对原密文后才可条件覆盖', async () => {
        const fetcher=vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(metadata('W/&quot;weak&quot;'),207)).mockResolvedValueOnce(response(null,200,{etag:'"head"'})).mockResolvedValueOnce(response(content));
        const remote=await createWebDavApi(fetcher).read(session);
        expect(remote?.file.etag).toBe('"head"');
        expect(remote?.file.readOnly).toBeUndefined();
        expect(fetcher.mock.calls[2]).toMatchObject([connection.url+'FluentRead/fluentread-config.encrypted.json',{method:'HEAD'}]);
        expect(fetcher.mock.calls[3][1]).toMatchObject({method:'GET',headers:{'If-Match':'"head"'}});
        for (const status of [401,403,404,412,500]) {
            const denied=vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(null,405)).mockResolvedValueOnce(response(null,status));
            await expect(createWebDavApi(denied).read(session)).rejects.toThrow(WebDavError);
        }
        for (const header of [undefined,'W/"head"','unquoted']) {
            const missing=vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(null,501)).mockResolvedValueOnce(response(null,200,header?{etag:header}:{}));
            expect(await createWebDavApi(missing).read(session)).toMatchObject({file:{contentGuard:true},content});
        }
    });
    it('接受属性响应中的局部命名空间、等号空白、数值实体和 CDATA', async () => {
        const body = '<multistatus xmlns="DAV:"><response xmlns:p = "DAV:"><p:href>/base/FluentRead/fluentread-config.encrypted.json</p:href><p:propstat><p:prop><p:getetag>&#34;one&#x22;</p:getetag></p:prop><p:status><![CDATA[HTTP/1.1 200 OK]]></p:status></p:propstat></response></multistatus>';
        const fetcher=vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(body,207)).mockResolvedValueOnce(response(content));
        expect((await createWebDavApi(fetcher).read(session))?.file.etag).toBe('"one"');
    });
    it('下载未返回 ETag 时从固定文件属性补取，条件重读后才能安全覆盖', async () => {
        for (const xml of [metadata(), metadata('"one"', connection.url+'FluentRead/fluentread-config.encrypted.json').replaceAll('d:', '').replace('xmlns:d', 'xmlns'), metadata('&quot;one&amp;&lt;&gt;&apos;&quot;')]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(xml, 207)).mockResolvedValueOnce(response(content));
            const remote = await createWebDavApi(fetcher).read(session);
            expect(remote?.file.etag).toMatch(/^"/u);
            expect(fetcher.mock.calls[1]).toMatchObject([connection.url+'FluentRead/fluentread-config.encrypted.json', {method:'PROPFIND', headers:{Depth:'0'}, body:expect.stringContaining('<d:getetag/>')}]);
            expect(fetcher.mock.calls[2]).toMatchObject([connection.url+'FluentRead/fluentread-config.encrypted.json', {method:'GET', headers:{'If-Match':remote!.file.etag}}]);
        }
        for (const changed of [response('other'), response(content,200,{etag:'"two"'}), response(null,412)]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(metadata(),207)).mockResolvedValueOnce(changed);
            await expect(createWebDavApi(fetcher).read(session)).rejects.toMatchObject({code:'conflict'});
            expect(fetcher.mock.calls.every(([,init]) => init.method !== 'PUT')).toBe(true);
        }
    });
    it('属性不支持、缺少强版本或非目标文件仍可只读恢复，不信任异常 XML', async () => {
        const badXml = [metadata('W/&quot;one&quot;'),metadata('unquoted'),metadata('"'+'x'.repeat(513)+'"'),metadata().replace('DAV:','urn:other'),metadata().replace('xmlns:d="DAV:"','xmlns:d="DAV:" xmlns:d="urn:other"'), '<!DOCTYPE x>'+metadata(), '<!ENTITY x "private">'+metadata(), metadata().replace('/base/FluentRead/fluentread-config.encrypted.json','https://other.invalid/file'),metadata().replace('<d:href>','<wrong:href>'),metadata().replace('<d:response>','<d:response><d:response>'), metadata().replace('</d:multistatus>',metadata()+'</d:multistatus>'), metadata().replace('200 OK','404 Not Found'), metadata().replace('<d:getetag>', '<wrong:getetag>'), metadata().replace('</d:prop>','<d:getetag>"two"</d:getetag></d:prop>'),metadata().replace('<d:href>/base/FluentRead/fluentread-config.encrypted.json</d:href>','<d:href></d:href>')];
        for (const body of badXml) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(body,207)).mockResolvedValueOnce(response(null,405));
            expect((await createWebDavApi(fetcher).read(session))?.file.etag).toBeUndefined();
            expect(fetcher).toHaveBeenCalledTimes(3);
        }
        for (const status of [401,403,404,500]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response('private response',status));
            await expect(createWebDavApi(fetcher).read(session)).rejects.toThrow(WebDavError);
        }
    });
    it('缺少备份父目录的 409 只在入口有效且专属目录确实不存在时视为首次备份', async () => {
        for (const status of [404, 409]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response('private missing-parent response', 409)).mockResolvedValueOnce(response(xml, 207)).mockResolvedValueOnce(response(null, status));
            expect(await createWebDavApi(fetcher).read(session)).toBeNull();
            expect(fetcher.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
                [connection.url + 'FluentRead/fluentread-config.encrypted.json', 'GET'],
                [connection.url, 'PROPFIND'],
                [connection.url + 'FluentRead/', 'PROPFIND'],
            ]);
            expect(fetcher.mock.calls.slice(1).every(([, init]) => init.headers.Depth === '0')).toBe(true);
        }
        for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'notFound'], [409, 'notFound'], [500, 'http']] as const) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(null, 409)).mockResolvedValueOnce(response(null, status));
            await expect(createWebDavApi(fetcher).read(session)).rejects.toMatchObject({code, status});
            expect(fetcher).toHaveBeenCalledTimes(2);
        }
        for (const denied of [response(null, 403), response('not XML', 207)]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(null, 409)).mockResolvedValueOnce(response(xml, 207)).mockResolvedValueOnce(denied);
            await expect(createWebDavApi(fetcher).read(session)).rejects.toThrow(WebDavError);
        }
        const existing = vi.fn().mockResolvedValueOnce(response(null, 409)).mockResolvedValueOnce(response(xml, 207)).mockResolvedValueOnce(response(xml.replace("/base/", "/base/FluentRead/"), 207));
        await expect(createWebDavApi(existing).read(session)).rejects.toMatchObject({code: 'http', status: 409});
    });
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
        const fetcher = vi.fn().mockResolvedValueOnce(response(null, 405)).mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(response(content, 200)).mockResolvedValueOnce(response(null, 405)).mockResolvedValueOnce(response(null,501));
        const api = createWebDavApi(fetcher);
        const first = await api.write(session, content, null);
        expect(first.etag).toBeUndefined();
        for (const etag of [undefined, 'W/"weak"', 'bad', '"'+ 'x'.repeat(513)+'"']) await expect(api.write(session, content, {...first, contentGuard:undefined, readOnly:undefined, etag})).rejects.toMatchObject({code: 'etag'});
        await expect(api.write(session, content, {...first, id: 'https://other.fixture.invalid', etag: '"one"'})).rejects.toMatchObject({code: 'etag'});
        fetcher.mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(response(content, 200, {etag: '"two"'}));
        expect(await api.write(session, content, {...first, readOnly:undefined, etag: '"one"'})).toMatchObject({etag: '"two"'});
        expect(fetcher.mock.calls.at(-2)?.[1]).toMatchObject({method: 'PUT', headers: {'If-Match': '"one"'}});
        for (const etag of ['W/"weak"', 'bad']) {
            fetcher.mockResolvedValueOnce(response(content, 200, {etag})).mockResolvedValueOnce(response(null, 501)).mockResolvedValueOnce(response(null,405));
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
        for (const next of [response(null, 404), response('other', 200, {etag: '"two"'})]) {
            const fetcher = vi.fn().mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(next);
            await expect(createWebDavApi(fetcher).write(session, content, previous)).rejects.toMatchObject({code: 'verify'});
        }
        await expect(createWebDavApi(vi.fn(async () => {throw new Error('fixture-private');})).read(session)).rejects.toMatchObject({code: 'network'});
        const fetcher = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')))));
        await expect(createWebDavApi(fetcher, {timeoutMs: 1}).read(session)).rejects.toMatchObject({code: 'timeout'});
    });
    it('首次备份的 404 正文取消同步失败仍返回缺失，并清除请求计时器', async () => {
        vi.useFakeTimers();
        try {
            const cancel = vi.fn(() => {throw new Error('fixture-private cancellation failure');});
            const body = new ReadableStream<Uint8Array>({
                start(controller) {controller.enqueue(new TextEncoder().encode('fixture-private missing body'));},
                cancel,
            });
            const missing = new Response(body, {status: 404});
            const fetcher = vi.fn<typeof fetch>(async () => missing);

            await expect(createWebDavApi(fetcher).read(session)).resolves.toBeNull();

            expect(fetcher).toHaveBeenCalledOnce();
            expect(cancel).toHaveBeenCalledOnce();
            expect(missing.bodyUsed).toBe(true);
            expect(body.locked).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
        } finally {vi.useRealTimers();}
    });
    it('PUT 成功正文的异步取消失败不阻断读回校验，也不重试条件上传', async () => {
        vi.useFakeTimers();
        try {
            const cancel = vi.fn(async () => {throw new Error('fixture-private upload cleanup failure');});
            const body = new ReadableStream<Uint8Array>({
                start(controller) {controller.enqueue(new TextEncoder().encode('fixture-private upload response'));},
                cancel,
            });
            const uploaded = new Response(body, {status: 201});
            const verified = response(content, 200, {etag: '"two"'});
            const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(uploaded).mockResolvedValueOnce(verified);
            const previous = {id: connection.url+'FluentRead/fluentread-config.encrypted.json', version: '1', modifiedTime: '', etag: '"one"'};

            await expect(createWebDavApi(fetcher).write(session, content, previous)).resolves.toMatchObject({id: previous.id, etag: '"two"'});

            expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([[previous.id, 'PUT'], [previous.id, 'GET']]);
            expect(fetcher.mock.calls[0][1]).toMatchObject({headers: {'If-Match': '"one"'}, body: content});
            expect(cancel).toHaveBeenCalledOnce();
            expect(uploaded.bodyUsed).toBe(true);
            expect(body.locked).toBe(false);
            expect(verified.body!.locked).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it.each(['network', 'timeout'] as const)('HTTP 200 部分正文读取发生 %s 时不返回截断备份，释放流锁和计时器', async code => {
        vi.useFakeTimers();
        try {
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            let reading!: () => void;
            const bodyReadStarted = new Promise<void>(resolve => {reading = resolve;});
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    controller.enqueue(new TextEncoder().encode(content.slice(0, 12)));
                },
                pull(controller) {
                    reading();
                    if (code === 'network') controller.error(new TypeError('fixture-private transport interruption'));
                },
            }, {highWaterMark: 0}); // 禁止预取，让失败发生在已读部分正文之后。
            const interrupted = new Response(body, {status: 200, headers: {etag: '"one"'}});
            const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
                init!.signal!.addEventListener('abort', () => streamController.error(new DOMException('fixture-private body abort', 'AbortError')), {once: true});
                return interrupted;
            });
            const failure = expect(createWebDavApi(fetcher, {timeoutMs: 10}).read(session)).rejects.toMatchObject({code, status: undefined, message: `WebDAV ${code}`});

            await bodyReadStarted;
            if (code === 'timeout') await vi.advanceTimersByTimeAsync(10);
            await failure;

            expect(fetcher).toHaveBeenCalledOnce();
            expect(interrupted.bodyUsed).toBe(true);
            expect(body.locked).toBe(false);
            expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(code === 'timeout');
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it('缺少 ETag 时在实际 PUT/DELETE 前核对内容，变更或消失不能上传，删除消失幂等', async () => {
        let current: string | null = content;
        let upgraded = false;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'GET') return response(current, current === null ? 404 : 200, upgraded ? {etag:'"upgraded"'} : {});
            if (init?.method === 'PROPFIND' || init?.method === 'HEAD') return response(null, 405);
            if (init?.method === 'PUT') {current = init.body as string; return response(null, 204);}
            if (init?.method === 'DELETE') {current = null; return response(null, 204);}
            throw new Error('unexpected request');
        });
        const api = createWebDavApi(fetcher);
        const first = (await api.read(session))!.file;
        expect(first).toMatchObject({contentGuard:true});
        expect(first.readOnly).toBeUndefined();
        const next = JSON.stringify({format:DRIVE_ENCRYPTION_FORMAT,ciphertext:'changed ciphertext'});
        const second = await api.write(session, next, first);
        expect(current).toBe(next);
        expect(fetcher.mock.calls.find(([,init]) => init?.method === 'PUT')?.[1]?.headers).toMatchObject({'If-Match':'*'});
        for (const operation of [() => api.write(session, content, first), () => api.remove(session, first)]) {
            const before = fetcher.mock.calls.filter(([,init]) => ['PUT','DELETE'].includes(init!.method!)).length;
            await expect(operation()).rejects.toMatchObject({code:'conflict'});
            expect(fetcher.mock.calls.filter(([,init]) => ['PUT','DELETE'].includes(init!.method!))).toHaveLength(before);
        }
        upgraded = true;
        await api.remove(session, second);
        expect(fetcher.mock.calls.find(([,init]) => init?.method === 'DELETE')?.[1]?.headers).toMatchObject({'If-Match':'"upgraded"'});
        expect(current).toBeNull();
        await api.remove(session, second);
        await expect(api.write(session, content, second)).rejects.toMatchObject({code:'conflict'});
    });
    it('内容兼容写入遇到条件失败仍中止，不进行无条件重试', async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        const file = {id:connection.url+'FluentRead/fluentread-config.encrypted.json', version:Array.from(new Uint8Array(digest), byte=>byte.toString(16).padStart(2,'0')).join(''), modifiedTime:'',contentGuard:true as const};
        for (const method of ['write','remove'] as const) for (const etag of [undefined, 'fixture-raw-version']) {
            const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
                if (init?.method === 'GET') return response(content,200,etag?{etag}:{});
                if (init?.method === 'PROPFIND' || init?.method === 'HEAD') return response(null, 405);
                return response(null, 412);
            });
            const api = createWebDavApi(fetcher);
            await expect(method === 'write' ? api.write(session,content,file) : api.remove(session,file)).rejects.toMatchObject({code:'conflict'});
            expect(fetcher.mock.calls.filter(([,init])=>['PUT','DELETE'].includes(init!.method!))).toHaveLength(1);
        }
    });
});

it('aborted preview read cannot start follow-up DAV requests when fetch ignores cancellation', async () => {
    const controller=new AbortController();
    let release!: (value:Response)=>void;
    const fetcher=vi.fn<typeof fetch>(()=>new Promise(resolve=>{release=resolve;}));
    const pending=createWebDavApi(fetcher).read(session,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    const requestSignal=fetcher.mock.calls[0][1]!.signal!;
    controller.abort();
    expect(requestSignal.aborted).toBe(true);
    release(response(null,409));
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
});
