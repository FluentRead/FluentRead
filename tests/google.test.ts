import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {from: 'auto', to: 'zh-Hans'}}));

const fetchMock = vi.fn<typeof fetch>();
let api: typeof import('@/src/providers/translation/google');
const HTML = 'translate-pa.googleapis.com';
const LIST = 'translate.googleapis.com';
const RPC = 'translate.google.com';
const UK = 'translate.google.co.uk';

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return {ok: status === 200, status, statusText: 'HTTP error',
        headers: new Headers(headers),
        text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}
function rpcResponse(texts: string[], ids = texts.map((_, i) => String(i))): string {
    const records = texts.map((text, i) => ['wrb.fr', 'MkEWBc', JSON.stringify([
        null, [[[null, null, null, null, null, [[text]]]]],
    ]), null, null, null, ids[i]]);
    return `)]}'\n\n${JSON.stringify(records)}`;
}
function requestData(input: RequestInfo | URL, init?: RequestInit): {texts: string[]; from: string; to: string} {
    const url = new URL(String(input));
    if (url.hostname === HTML) {
        const payload = JSON.parse(String(init?.body))[0];
        return {texts: payload[0], from: payload[1], to: payload[2]};
    }
    if (url.hostname === LIST) return {
        texts: new URLSearchParams(String(init?.body)).getAll('q'),
        from: url.searchParams.get('sl')!, to: url.searchParams.get('tl')!,
    };
    const records = JSON.parse(new URLSearchParams(String(init?.body)).get('f.req')!)[0];
    const requests = records.map((record: unknown[]) => JSON.parse(String(record[1]))[0]);
    return {texts: requests.map((item: string[]) => item[0]), from: requests[0][1], to: requests[0][2]};
}
function successfulResponse(input: RequestInfo | URL, texts: string[]): Response {
    const host = new URL(String(input)).hostname;
    return response(host === HTML ? [texts] : host === LIST ? texts : rpcResponse(texts));
}
function hosts(): string[] { return fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname); }
async function flush<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    void promise.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    for (let step = 0; !settled && step < 100; step++) await vi.advanceTimersToNextTimerAsync();
    return promise;
}

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    api = await import('@/src/providers/translation/google');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Google 批量传输与换线', () => {
    it('连续错峰到达的 20 个段落只产生 5 个批次，输出顺序保留', async () => {
        const starts: number[] = [];
        fetchMock.mockImplementation(async (url, init) => {
            starts.push(Date.now());
            return successfulResponse(url, requestData(url, init).texts.map(text => `译文${text.match(/\d+/)![0]}`));
        });
        const requests: Promise<string>[] = [];
        for (let index = 0; index < 20; index++) {
            requests.push(api.translateGoogleText(`Paragraph ${index}`, 'en', 'zh'));
            await vi.advanceTimersByTimeAsync(30);
        }
        await expect(flush(Promise.all(requests))).resolves.toEqual(Array.from({length: 20}, (_, index) => `译文${index}`));
        expect(fetchMock.mock.calls.map(([url, init]) => requestData(url, init).texts.length)).toEqual([4, 4, 4, 4, 4]);
        expect(starts.slice(1).every((at, index) => at - starts[index]! >= 200)).toBe(true);
    });
    it('显式大数组满批立即发送，尾批只等待 HTTP 节流，不再等待收集窗', async () => {
        fetchMock.mockImplementation(async (url, init) => successfulResponse(url,
            requestData(url, init).texts.map(text => `译文${text.match(/\d+/)![0]}`)));
        const sources = Array.from({length: 65}, (_, index) => `Paragraph ${index}`);
        const request = api.translateGoogleTexts(sources, 'en', 'zh');
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(400);
        await expect(request).resolves.toEqual(sources.map((_, index) => `译文${index}`));
        expect(fetchMock.mock.calls.map(([url, init]) => requestData(url, init).texts.length)).toEqual([32, 32, 1]);
    });
    it('接近一万字符的普通段落可以合批，单个超长段落独立发送并保留完整内容', async () => {
        fetchMock.mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '完整译文')));
        await expect(flush(api.translateGoogleTexts(['A'.repeat(4900), 'B'.repeat(4900)], 'en', 'zh'))).resolves.toEqual(['完整译文', '完整译文']);
        expect(fetchMock).toHaveBeenCalledOnce();
        fetchMock.mockClear();
        await expect(flush(api.translateGoogleTexts(['C'.repeat(12_000), 'Next'], 'en', 'zh'))).resolves.toEqual(['完整译文', '完整译文']);
        expect(fetchMock.mock.calls.map(([url, init]) => requestData(url, init).texts.length)).toEqual([1, 1]);
        expect(requestData(...fetchMock.mock.calls[0]!).texts[0]).toBe(`<pre>${'C'.repeat(12_000)}</pre>`);
    });

    it('rejects an RPC slot containing a malformed middle subsegment instead of dropping prose', () => {
        const records = JSON.parse(rpcResponse(['whole']).split('\n').at(-1)!);
        const payload = JSON.parse(records[0][2]);
        for (const bad of [null, [7], []]) {
            payload[1][0][0][5] = [['前半句'], bad, ['后半句']];
            records[0][2] = JSON.stringify(payload);
            expect(() => api.parseGoogleBatchResponse(JSON.stringify(records))).toThrow('返回格式异常');
        }
    });
    it('all endpoints with broken arrays expose a structural error and permit standalone recovery', async () => {
        fetchMock.mockImplementation(async (url, init) => {
            const data = requestData(url, init);
            return data.texts.length > 1 ? response('[]') : successfulResponse(url, ['恢复译文']);
        });
        await expect(flush(api.translateGoogleTexts(['First', 'Second'], 'en', 'zh')))
            .rejects.toMatchObject({kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false});
        expect(fetchMock).toHaveBeenCalledTimes(4);
        await expect(flush(api.translateGoogleText('First', 'en', 'zh'))).resolves.toBe('恢复译文');
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('preserves invisible blank origins locally and rejects invisible empty translations', async () => {
        fetchMock.mockResolvedValueOnce(response([['\u200b']])).mockResolvedValueOnce(response(['译文']));
        await expect(flush(api.translateGoogleTexts(['\u200b', 'Text'], 'en', 'zh')))
            .resolves.toEqual(['\u200b', '译文']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('优先浏览器批量接口，纯文本转义、换行与实体只还原一次', async () => {
        fetchMock.mockResolvedValue(response([['<pre>第一行 &amp; &lt;b&gt;\n  第二行\n\n&amp;lt;</pre>']]));
        const request = api.default({origin: '<b>Hello & world</b>\n  Next line\n\n&lt;'});
        await expect(flush(request)).resolves.toBe('第一行 & <b>\n  第二行\n\n&lt;');
        expect(hosts()).toEqual([HTML]);
        const init = fetchMock.mock.calls[0]![1]!;
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({'Content-Type': 'application/json+protobuf'});
        expect(JSON.parse(String(init.body))).toEqual([
            [['<pre>&lt;b&gt;Hello &amp; world&lt;/b&gt;\n  Next line\n\n&amp;lt;</pre>'], 'auto', 'zh-CN'], 'wt_lib',
        ]);
    });
    it('并发段落与显式数组共享一批请求，并按原调用者顺序返回', async () => {
        fetchMock.mockResolvedValue(response([['第一段', '第二段', '第三段']]));
        const single = api.translateGoogleText('First paragraph', 'en', 'zh-Hans');
        const batch = api.default({origin: ['Second paragraph', 'Third paragraph'], sourceLanguage: 'en', targetLanguage: 'zh-Hans'});
        await expect(flush(Promise.all([single, batch]))).resolves.toEqual(['第一段', ['第二段', '第三段']]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))[0][0]).toHaveLength(3);
    });
    it('不同语言隔离，中文书写系统与 Google 别名正确映射', async () => {
        fetchMock.mockImplementation(async (_url, init) => {
            const data = requestData(_url, init);
            return successfulResponse(_url, data.texts.map(() => `${data.from}:${data.to}`));
        });
        const tasks = [api.translateGoogleText('Hello', 'nb', 'zh-Hant'), api.translateGoogleText('Hello', 'fil', 'zh-Hans')];
        await expect(flush(Promise.all(tasks))).resolves.toEqual(['no:zh-TW', 'tl:zh-CN']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('合批同时限制条数与转义后的大小，空槽原样保留', async () => {
        fetchMock.mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '译文')));
        const many = Array.from({length: 65}, (_, i) => `Paragraph ${i}`);
        await expect(flush(api.translateGoogleTexts(many, 'en', 'zh'))).resolves.toHaveLength(65);
        expect(fetchMock.mock.calls.map(([url, init]) => requestData(url, init).texts.length)).toEqual([32, 32, 1]);
        fetchMock.mockClear();
        await expect(flush(api.translateGoogleTexts(['&'.repeat(1000), '&'.repeat(1000), '  \n', ''], 'en', 'zh')))
            .resolves.toEqual(['译文', '译文', '  \n', '']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(api.translateGoogleTexts([], 'en', 'zh')).resolves.toEqual([]);
    });
    it('浏览器接口失败后整批换到网页批量接口，不访问淘汰的 single', async () => {
        fetchMock.mockResolvedValueOnce(response('unavailable', 503)).mockResolvedValueOnce(response([['第一段', 'en'], ['第二段', 'en']]));
        await expect(flush(api.translateGoogleTexts(['First paragraph', 'Second paragraph'], 'auto', 'zh'))).resolves.toEqual(['第一段', '第二段']);
        expect(hosts()).toEqual([HTML, LIST]);
        const [url, init] = fetchMock.mock.calls[1]!;
        expect(new URL(String(url)).pathname).toBe('/translate_a/t');
        expect(new URLSearchParams(String(init?.body)).getAll('q')).toEqual(['First paragraph', 'Second paragraph']);
    });
    it('批量返回缺槽、空译文或错误类型时继续换线，不能错配原文', async () => {
        for (const bad of [[['只有一段']], [['', '第二段']], [['<pre></pre>', '第二段']], [[12, '第二段']]]) {
            vi.resetModules(); api = await import('@/src/providers/translation/google'); fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(response(bad)).mockResolvedValueOnce(response(['第一段', '第二段']));
            await expect(flush(api.translateGoogleTexts(['First', 'Second'], 'en', 'zh'))).resolves.toEqual(['第一段', '第二段']);
            expect(hosts()).toEqual([HTML, LIST]);
        }
    });
    it('RPC 整批回退按编号还原乱序结果，保留换行与服务端片段', async () => {
        fetchMock.mockResolvedValueOnce(response('', 502)).mockResolvedValueOnce(response('', 502))
            .mockResolvedValueOnce(response(rpcResponse(['第二段', '第一段'], ['1', '0'])));
        await expect(flush(api.translateGoogleTexts(['First', 'Second'], 'en', 'zh'))).resolves.toEqual(['第一段', '第二段']);
        expect(hosts()).toEqual([HTML, LIST, RPC]);
        const payload = JSON.parse(new URLSearchParams(String(fetchMock.mock.calls[2]![1]!.body)).get('f.req')!);
        expect(payload[0].map((record: unknown[]) => record[3])).toEqual(['0', '1']);
        expect(JSON.parse(payload[0][1][1])[0]).toEqual(['Second', 'en', 'zh-CN', true]);
    });
    it.each([['0', '0'], ['1'], ['unexpected', '0']].map(ids => ({ids})))('RPC 重复、缺失或非法编号 $ids 不会静默接受', async ({ids}) => {
        fetchMock.mockResolvedValueOnce(response('', 503)).mockResolvedValueOnce(response('', 503))
            .mockResolvedValueOnce(response(rpcResponse(ids.map(() => '错误槽'), ids)))
            .mockResolvedValueOnce(response(rpcResponse(['第一段', '第二段'])));
        await expect(flush(api.translateGoogleTexts(['First', 'Second'], 'en', 'zh'))).resolves.toEqual(['第一段', '第二段']);
        expect(hosts()).toEqual([HTML, LIST, RPC, UK]);
    });
    it('解析 RPC 帧忽略无关记录，且不额外插入空格', () => {
        const payload = [null, [[[null, null, null, null, null, [['第一句。'], ['第二句！']]]]]];
        const body = `)]}'\n\n120\nnot json\n[broken\n${JSON.stringify([['other'], ['wrb.fr', 'Other', '{}'], ['wrb.fr', 'MkEWBc', '{broken'], ['wrb.fr', 'MkEWBc', JSON.stringify(payload)]])}`;
        expect(api.parseGoogleBatchResponse(body)).toBe('第一句。第二句！');
        expect(() => api.parseGoogleBatchResponse('[]')).toThrow('返回格式异常');
    });
});

describe('Google 端点健康与预算', () => {
    it('网络失败和 5xx 对后续段落冷却，到期仅一个探测请求', async () => {
        fetchMock.mockRejectedValueOnce(new Error('private transport URL')).mockResolvedValue(response(['后备译文']));
        await expect(flush(api.translateGoogleText('First', 'en', 'zh'))).resolves.toBe('后备译文');
        await expect(flush(api.translateGoogleText('Second', 'en', 'zh'))).resolves.toBe('后备译文');
        expect(hosts()).toEqual([HTML, LIST, LIST]);
        await vi.advanceTimersByTimeAsync(30_000);
        let resolveProbe!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveProbe = resolve; }));
        const probe = api.translateGoogleText('Recovery probe', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(120);
        await expect(flush(api.translateGoogleText('Concurrent paragraph', 'en', 'zh'))).resolves.toBe('后备译文');
        expect(hosts()).toEqual([HTML, LIST, LIST, HTML, LIST]);
        resolveProbe(response([['恢复译文']]));
        await expect(probe).resolves.toBe('恢复译文');
        fetchMock.mockResolvedValue(response([['正常译文']]));
        await expect(flush(api.translateGoogleText('Next', 'en', 'zh'))).resolves.toBe('正常译文');
        expect(hosts().at(-1)).toBe(LIST);
    });
    it('403 与 XSRF 拒绝仍按入口冷却五分钟，普通 400 不淘汰入口', async () => {
        fetchMock.mockResolvedValueOnce(response('bad language', 400)).mockResolvedValueOnce(response(['后备']))
            .mockResolvedValueOnce(response('bad language', 400)).mockResolvedValueOnce(response([['下一段']]));
        await expect(flush(api.translateGoogleText('First', 'en', 'zh'))).resolves.toBe('后备');
        await expect(flush(api.translateGoogleText('Second', 'en', 'zh'))).resolves.toBe('下一段');
        expect(hosts()).toEqual([HTML, LIST, LIST, HTML]);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(response('<html>private</html>', 403)).mockResolvedValueOnce(response('', 403))
            .mockResolvedValueOnce(response('["xsrf"]', 400)).mockResolvedValue(response(rpcResponse(['备用'])));
        await expect(flush(api.translateGoogleText('Third', 'en', 'zh'))).resolves.toBe('备用');
        await expect(flush(api.translateGoogleText('Fourth', 'en', 'zh'))).resolves.toBe('备用');
        expect(hosts()).toEqual([HTML, LIST, RPC, UK, UK]);
        await vi.advanceTimersByTimeAsync(300_000);
        fetchMock.mockResolvedValue(response([['恢复']]));
        await expect(flush(api.translateGoogleText('Fifth', 'en', 'zh'))).resolves.toBe('恢复');
        expect(hosts().at(-1)).toBe(HTML);
    });
    it('较早请求迟到成功不会清掉新请求记录的故障', async () => {
        fetchMock.mockResolvedValueOnce(response([['初始成功']]));
        await flush(api.translateGoogleText('Initial paragraph', 'en', 'zh'));
        fetchMock.mockReset();
        let resolveOld!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce(response('', 503)).mockResolvedValue(response(['后备']));
        const old = api.translateGoogleText('Old paragraph', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(120);
        await expect(flush(api.translateGoogleText('New paragraph', 'en', 'zh'))).resolves.toBe('后备');
        resolveOld(response([['迟到成功']])); await expect(old).resolves.toBe('迟到成功');
        await expect(flush(api.translateGoogleText('Next paragraph', 'en', 'zh'))).resolves.toBe('后备');
        expect(hosts()).toEqual([HTML, HTML, LIST, LIST]);
    });
    it.each([[400,400,413,422], [503,503,503,503]].map(statuses => ({statuses})))('所有接口失败保留一致 HTTP 分类 $statuses 且不泄露正文', async ({statuses}) => {
        for (const status of statuses) fetchMock.mockResolvedValueOnce(response('<html>private original secret.example/key</html>', status));
        const failure = await flush(api.translateGoogleText('private original', 'en', 'zh')).catch(error => error);
        expect(failure).toMatchObject({statusCode: statuses[0]});
        expect(failure.message).toContain('CAPTCHA');
        expect(failure.message).not.toMatch(/private original|secret.example/);
    });
    it('混合参数错误与服务故障不让单个 400 掩盖可用性问题', async () => {
        for (const status of [400,503,400,400]) fetchMock.mockResolvedValueOnce(response('', status));
        const failure = await flush(api.translateGoogleText('Hello', 'en', 'zh')).catch(error => error);
        expect(failure.statusCode).toBeUndefined();
    });
    it('读取响应体失败与无效 JSON 均会换线，错误只包含安全文案', async () => {
        fetchMock.mockResolvedValueOnce({...response(''), text: vi.fn().mockRejectedValue(new Error('private stream'))} as unknown as Response)
            .mockResolvedValueOnce(response('private malformed JSON')).mockResolvedValueOnce(response('invalid RPC'))
            .mockResolvedValueOnce(response('invalid RPC'));
        const failure = await flush(api.translateGoogleText('Hello', 'en', 'zh')).catch(error => error);
        expect(failure.message).toContain('响应读取失败');
        expect(failure.message).not.toContain('private');
        expect(hosts()).toEqual([HTML, LIST, RPC, UK]);
    });
    it('每个接口最多两秒，四个候选共享八秒总预算', async () => {
        const signals: AbortSignal[] = [];
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            signals.push(init!.signal!);
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once:true});
        }));
        const request = api.translateGoogleText('Hello', 'en', 'zh');
        const assertion = expect(request).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(8_000);
        await assertion;
        expect(hosts()).toEqual([HTML, LIST, RPC, UK]);
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Google 所有入口共享限流与恢复', () => {
    it('交付许可后的微任务收到其他入口 429 时重新排队，暂停之后不会再发 HTTP', async () => {
        vi.setSystemTime(0);
        let resolveFirst!: (value: Response) => void;
        let resolveSecond!: (value: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => {resolveFirst = resolve;}))
            .mockImplementationOnce(() => new Promise(resolve => {resolveSecond = resolve;}))
            .mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '恢复译文')));
        const first = api.translateGoogleOwnerTexts(['First'], 'en', 'zh', new AbortController().signal);
        const second = api.translateGoogleOwnerTexts(['Second'], 'fr', 'zh', new AbortController().signal);
        const third = api.translateGoogleOwnerTexts(['Third'], 'es', 'zh', new AbortController().signal);
        await vi.advanceTimersByTimeAsync(400); expect(fetchMock).toHaveBeenCalledTimes(2);
        resolveFirst(response([['第一段']])); await Promise.resolve();
        resolveSecond(response('', 429, {'Retry-After': '1'}));
        await vi.advanceTimersByTimeAsync(0);
        await expect(first).resolves.toEqual(['第一段']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(flush(Promise.all([second, third]))).resolves.toEqual([['恢复译文'], ['恢复译文']]);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
    it('Retry-After 日期在到期前暂停所有语言与入口；恢复只重试原入口', async () => {
        vi.setSystemTime(0);
        const starts: number[] = [];
        fetchMock.mockImplementation(async (url, init) => {
            starts.push(Date.now());
            return starts.length === 1 ? response('private', 429, {'Retry-After': new Date(2000).toUTCString()})
                : successfulResponse(url, requestData(url, init).texts.map(() => '恢复译文'));
        });
        const request = api.translateGoogleText('Hello', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(1999); expect(starts).toEqual([120]);
        await vi.advanceTimersByTimeAsync(1); await expect(request).resolves.toBe('恢复译文');
        expect(starts).toEqual([120, 2000]); expect(hosts()).toEqual([HTML, HTML]);
    });
    it('无 Retry-After 的连续 429 按 1/2/4 秒退避，在原总预算内恢复', async () => {
        vi.setSystemTime(0);
        const starts: number[] = [];
        fetchMock.mockImplementation(async (url, init) => {
            starts.push(Date.now());
            return starts.length <= 3 ? response('<html>private</html>', 429)
                : successfulResponse(url, requestData(url, init).texts.map(() => '恢复译文'));
        });
        await expect(flush(api.translateGoogleText('Hello', 'en', 'zh'))).resolves.toBe('恢复译文');
        expect(starts).toEqual([120, 1120, 3120, 7120]); expect(hosts()).toEqual([HTML, HTML, HTML, HTML]);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('长 Retry-After 立即让所有等待者获得安全 429，免费池可换服务且没有备用域名请求', async () => {
        fetchMock.mockResolvedValue(response('<html>private original secret.example/key</html>', 429, {'Retry-After': '60'}));
        const failures = await flush(Promise.all([
            api.translateGoogleText('Private English', 'en', 'zh').catch(error => error),
            api.translateGoogleText('Private French', 'fr', 'zh').catch(error => error),
        ]));
        expect(failures).toEqual([expect.objectContaining({statusCode: 429, retryAfterMs: 60_000}), expect.objectContaining({statusCode: 429, retryAfterMs: 60_000})]);
        expect(failures.every(failure => !/Private|private original|secret.example/u.test(failure.message))).toBe(true);
        expect(hosts()).toEqual([HTML]); expect(vi.getTimerCount()).toBe(0);
    });
    it('迟到的旧 HTTP 成功不能清除新 429；恢复探测在途时其他语言继续等待', async () => {
        vi.setSystemTime(0);
        let resolveOld!: (value: Response) => void;
        let resolveProbe!: (value: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => {resolveOld = resolve;}))
            .mockResolvedValueOnce(response('', 429, {'Retry-After': '1'}))
            .mockImplementationOnce(() => new Promise(resolve => {resolveProbe = resolve;}))
            .mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '最后译文')));
        const old = api.translateGoogleText('Old prose', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(120);
        const limited = api.translateGoogleText('Limited prose', 'fr', 'zh');
        await vi.advanceTimersByTimeAsync(200); expect(fetchMock).toHaveBeenCalledTimes(2);
        resolveOld(response([['迟到旧译文']])); await expect(old).resolves.toBe('迟到旧译文');
        const queued = api.translateGoogleText('Queued prose', 'es', 'zh');
        await vi.advanceTimersByTimeAsync(999); expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(201); expect(fetchMock).toHaveBeenCalledTimes(3);
        resolveProbe(response(['恢复译文']));
        await expect(limited).resolves.toBe('恢复译文');
        await expect(flush(queued)).resolves.toBe('最后译文');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
    it('收集、HTTP 排队与短退避共用 caller 截止时间，预算装不下 429 等待时不发恢复请求', async () => {
        fetchMock.mockResolvedValue(response('', 429, {'Retry-After': '1'}));
        const failure = await flush(api.default({origin: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh', requestTimeoutMs: 1000})).catch(error => error);
        expect(failure).toMatchObject({statusCode: 429, retryAfterMs: 1000});
        expect(fetchMock).toHaveBeenCalledOnce();
        fetchMock.mockClear();
        await expect(flush(api.translateGoogleTexts(['No budget'], 'en', 'zh', undefined, 0))).rejects.toThrow('请求超时');
        expect(fetchMock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });
    it('退避等待中取消立即回收队列，不产生恢复 fetch，也不遗留 timer/listener', async () => {
        fetchMock.mockResolvedValue(response('', 429, {'Retry-After': '1'}));
        const owner = new AbortController();
        const remove = vi.spyOn(owner.signal, 'removeEventListener');
        const request = api.translateGoogleText('Hello', 'en', 'zh', owner.signal);
        const assertion = expect(request).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(500); owner.abort(); await assertion;
        expect(remove).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(2000); expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('Google 动态优先级', () => {
    it('接口仍成功但变慢时降级；更快的备用接口和恢复变快的入口会自动上升', async () => {
        let delayMs = 1400;
        fetchMock.mockImplementation((url, init) => new Promise((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
            const timer = setTimeout(() => {
                init?.signal?.removeEventListener('abort', onAbort);
                resolve(successfulResponse(url, requestData(url, init).texts.map(() => '有效译文')));
            }, delayMs);
            init?.signal?.addEventListener('abort', onAbort, {once:true});
        }));
        for (const delay of [1400, 100, 1800, 100]) {
            delayMs = delay;
            const assertion = expect(api.translateGoogleText(`Readable paragraph ${delay} ${hosts().length}`, 'en', 'zh')).resolves.toBe('有效译文');
            await vi.advanceTimersByTimeAsync(delay + 120);
            await assertion;
        }
        expect(hosts()).toEqual([HTML, LIST, LIST, HTML]);
    });
    it('每十批用真实请求探索较少使用的备用接口，不额外发探测请求', async () => {
        fetchMock.mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '译文')));
        for (let index = 0; index < 30; index++) {
            await expect(flush(api.translateGoogleText(`Readable paragraph ${index}`, 'en', 'zh'))).resolves.toBe('译文');
        }
        expect(fetchMock).toHaveBeenCalledTimes(30);
        expect([hosts()[9], hosts()[19], hosts()[29]]).toEqual([LIST, RPC, UK]);
        expect(hosts().filter(host => host === HTML)).toHaveLength(27);
    });
    it('健康主接口有在途负载时分流；完成后负载计数释放并重新参与排序', async () => {
        let resolveFirst!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => {resolveFirst = resolve;}))
            .mockImplementation(async (url, init) => successfulResponse(url, requestData(url, init).texts.map(() => '译文')));
        const first = api.translateGoogleText('First paragraph', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(120);
        await expect(flush(api.translateGoogleText('Second paragraph', 'en', 'zh'))).resolves.toBe('译文');
        expect(hosts()).toEqual([HTML, LIST]);
        resolveFirst(response([['第一段']])); await expect(first).resolves.toBe('第一段');
        await expect(flush(api.translateGoogleText('Third paragraph', 'en', 'zh'))).resolves.toBe('译文');
        expect(hosts()).toEqual([HTML, LIST, HTML]);
    });
    it('定期探索也跳过访问拒绝冷却的接口', async () => {
        fetchMock.mockImplementation(async (url, init) => new URL(String(url)).hostname === LIST
            ? response('', 403) : successfulResponse(url, requestData(url, init).texts.map(() => '译文')));
        for (let index = 0; index < 30; index++) await flush(api.translateGoogleText(`Readable paragraph ${index}`, 'en', 'zh'));
        expect(hosts().filter(host => host === LIST)).toHaveLength(1);
        expect(hosts()).toContain(RPC);
        expect(hosts()).toContain(UK);
    });
});

describe('Google 合批取消所有权', () => {
    it('许可交付到 fetch 前取消或越过绝对截止时间时归还许可并发送零请求', async () => {
        vi.setSystemTime(0);
        const owner = new AbortController();
        const cancelled = api.translateGoogleOwnerTexts(['Cancelled'], 'en', 'zh', owner.signal);
        owner.abort(); await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        const expired = api.translateGoogleOwnerTexts(['Expired'], 'en', 'zh', new AbortController().signal);
        vi.setSystemTime(8001);
        await expect(expired).rejects.toMatchObject({googleQueueError: true});
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValue(response([['正常译文']]));
        await expect(api.translateGoogleOwnerTexts(['Next'], 'en', 'zh', new AbortController().signal)).resolves.toEqual(['正常译文']);
        expect(hosts()).toEqual([HTML]); expect(vi.getTimerCount()).toBe(0);
    });
    it('排队前/排队中取消不会发送请求', async () => {
        const first = new AbortController(); first.abort();
        await expect(api.translateGoogleText('Hello', 'en', 'zh', first.signal)).rejects.toMatchObject({name:'AbortError'});
        const second = new AbortController();
        const request = api.translateGoogleText('Hello', 'en', 'zh', second.signal);
        const assertion = expect(request).rejects.toMatchObject({name:'AbortError'});
        second.abort(); await assertion;
        await vi.advanceTimersByTimeAsync(120);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('一个调用者取消不影响共用请求的另一个调用者，监听器完成后清理', async () => {
        let resolve!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        const owner = new AbortController();
        const remove = vi.spyOn(owner.signal, 'removeEventListener');
        const one = api.translateGoogleText('First', 'en', 'zh', owner.signal);
        const assertion = expect(one).rejects.toMatchObject({name:'AbortError'});
        const two = api.translateGoogleText('Second', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(120);
        const transportSignal = fetchMock.mock.calls[0]![1]!.signal!;
        owner.abort(); await assertion;
        expect(transportSignal.aborted).toBe(false);
        resolve(response([['第一段', '第二段']]));
        await expect(two).resolves.toBe('第二段');
        expect(remove).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('全部调用者取消会终止网络；不会换线或把取消计为端点故障', async () => {
        fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once:true});
        }));
        const owner = new AbortController();
        const request = api.translateGoogleTexts(['First', 'Second'], 'en', 'zh', owner.signal);
        const assertion = expect(request).rejects.toThrow('broker 预算耗尽');
        await vi.advanceTimersByTimeAsync(120); owner.abort(new Error('broker 预算耗尽')); await assertion;
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        fetchMock.mockResolvedValue(response([['正常']]));
        await expect(flush(api.translateGoogleText('Next', 'en', 'zh'))).resolves.toBe('正常');
        expect(hosts()).toEqual([HTML, HTML]);
    });
});


// 只在受控 HTTP 端口检验 owner 隔离；不访问真实服务，不把候选断言当作原生验证。
describe('Google owner-local native array transport', () => {
    it('overlapping equal groups send distinct paced HTTP requests and cancellation remains with its owner', async () => {
        const pending: Array<{url: RequestInfo | URL; texts: string[]; signal: AbortSignal; resolve: (value: Response) => void}> = [];
        fetchMock.mockImplementation((url, init) => new Promise<Response>((resolve, reject) => {
            const signal = init!.signal!;
            pending.push({url, texts: requestData(url, init).texts, signal, resolve});
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        }));
        const sources = Array.from({length: 8}, (_, index) => `Equal owner prose ${index}`);
        const firstOwner = new AbortController();
        const secondOwner = new AbortController();
        const first = api.translateGoogleOwnerTexts(sources, 'en', 'zh-Hans', firstOwner.signal);
        const firstAssertion = expect(first).rejects.toMatchObject({name: 'AbortError'});
        const second = api.translateGoogleOwnerTexts(sources, 'en', 'zh-Hans', secondOwner.signal);
        expect(first).not.toBe(second);
        // native 数组跳过合批窗口，仍受所有 Google HTTP 共用的启动间隔约束。
        await vi.advanceTimersByTimeAsync(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(pending.map(item => item.texts.length)).toEqual([8, 8]);
        expect(pending[0]!.signal).not.toBe(pending[1]!.signal);
        sources[0] = 'Caller mutation';
        expect(pending.every(item => !item.texts.some(text => text.includes('Caller mutation')))).toBe(true);
        firstOwner.abort();
        await firstAssertion;
        expect(pending[0]!.signal.aborted).toBe(true);
        expect(pending[1]!.signal.aborted).toBe(false);
        expect(secondOwner.signal.aborted).toBe(false);
        const translated = Array.from({length: 8}, (_, index) => `第二 owner 第${index}槽译文`);
        pending[1]!.resolve(successfulResponse(pending[1]!.url, translated));
        await expect(second).resolves.toEqual(translated);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('native arrays preserve duplicate ordinal slots, HTML text, entities, newlines and language aliases', async () => {
        const origins = ['Same prose', 'Same prose', '<b>& "quoted"</b>\n  Next\n\n&lt;'];
        fetchMock.mockResolvedValue(response([['<pre>第一槽</pre>', '<pre>第二槽</pre>', '<pre>&lt;b&gt;&amp; &quot;译文&quot;&lt;/b&gt;\n  下一行\n\n&amp;lt;</pre>']]));
        await expect(api.translateGoogleOwnerTexts(origins, 'nb', 'zh-Hant', new AbortController().signal))
            .resolves.toEqual(['第一槽', '第二槽', '<b>& "译文"</b>\n  下一行\n\n&lt;']);
        expect(hosts()).toEqual([HTML]);
        expect(requestData(...fetchMock.mock.calls[0]!)).toEqual({
            texts: ['<pre>Same prose</pre>', '<pre>Same prose</pre>', '<pre>&lt;b&gt;&amp; &quot;quoted&quot;&lt;/b&gt;\n  Next\n\n&amp;lt;</pre>'],
            from: 'no', to: 'zh-TW',
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an already-cancelled owner sends no HTTP and does not cool an endpoint for the next owner', async () => {
        const cancelled = new AbortController(); cancelled.abort();
        await expect(api.translateGoogleOwnerTexts(['First prose'], 'en', 'zh-Hans', cancelled.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValue(response([['可用译文']]));
        await expect(api.translateGoogleOwnerTexts(['Next prose'], 'en', 'zh-Hans', new AbortController().signal))
            .resolves.toEqual(['可用译文']);
        expect(hosts()).toEqual([HTML]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a malformed native response retains existing whole-array endpoint fallback', async () => {
        fetchMock.mockResolvedValueOnce(response([['缺一槽']])).mockResolvedValueOnce(response(['第一槽', '第二槽']));
        await expect(flush(api.translateGoogleOwnerTexts(['First prose', 'Second prose'], 'en', 'zh-Hans', new AbortController().signal)))
            .resolves.toEqual(['第一槽', '第二槽']);
        expect(hosts()).toEqual([HTML, LIST]);
        expect(fetchMock.mock.calls.map(call => requestData(...call).texts.length)).toEqual([2, 2]);
        expect(new URLSearchParams(String(fetchMock.mock.calls[1]![1]!.body)).getAll('q')).toEqual(['First prose', 'Second prose']);
        expect(vi.getTimerCount()).toBe(0);
    });
});
