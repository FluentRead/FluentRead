import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {from: 'auto', to: 'zh-Hans'}}));

const fetchMock = vi.fn<typeof fetch>();
let api: typeof import('@/src/providers/translation/google');
const HTML = 'translate-pa.googleapis.com';
const LIST = 'translate.googleapis.com';
const RPC = 'translate.google.com';
const UK = 'translate.google.co.uk';

function response(body: unknown, status = 200): Response {
    return {ok: status === 200, status, statusText: 'HTTP error',
        text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}
function rpcResponse(texts: string[], ids = texts.map((_, i) => String(i))): string {
    const records = texts.map((text, i) => ['wrb.fr', 'MkEWBc', JSON.stringify([
        null, [[[null, null, null, null, null, [[text]]]]],
    ]), null, null, null, ids[i]]);
    return `)]}'\n\n${JSON.stringify(records)}`;
}
function hosts(): string[] { return fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname); }
async function flush<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
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
            const payload = JSON.parse(String(init?.body));
            return response([payload[0][0].map(() => payload[0].slice(1).join(':'))]);
        });
        const tasks = [api.translateGoogleText('Hello', 'nb', 'zh-Hant'), api.translateGoogleText('Hello', 'fil', 'zh-Hans')];
        await expect(flush(Promise.all(tasks))).resolves.toEqual(['no:zh-TW', 'tl:zh-CN']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('合批同时限制条数与转义后的大小，空槽原样保留', async () => {
        fetchMock.mockImplementation(async (_url, init) => response([JSON.parse(String(init?.body))[0][0].map(() => '译文')]));
        const many = Array.from({length: 65}, (_, i) => `Paragraph ${i}`);
        await expect(flush(api.translateGoogleTexts(many, 'en', 'zh'))).resolves.toHaveLength(65);
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))[0][0].length)).toEqual([32, 32, 1]);
        fetchMock.mockClear();
        await expect(flush(api.translateGoogleTexts(['&'.repeat(500), '&'.repeat(500), '  \n', ''], 'en', 'zh')))
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
        await vi.advanceTimersByTimeAsync(10);
        await expect(flush(api.translateGoogleText('Concurrent paragraph', 'en', 'zh'))).resolves.toBe('后备译文');
        expect(hosts()).toEqual([HTML, LIST, LIST, HTML, LIST]);
        resolveProbe(response([['恢复译文']]));
        await expect(probe).resolves.toBe('恢复译文');
        fetchMock.mockResolvedValue(response([['正常译文']]));
        await expect(flush(api.translateGoogleText('Next', 'en', 'zh'))).resolves.toBe('正常译文');
        expect(hosts().at(-1)).toBe(HTML);
    });
    it('429、403 与 XSRF 拒绝冷却五分钟，普通 400 不淘汰入口', async () => {
        fetchMock.mockResolvedValueOnce(response('bad language', 400)).mockResolvedValueOnce(response(['后备']))
            .mockResolvedValueOnce(response([['下一段']]));
        await expect(flush(api.translateGoogleText('First', 'en', 'zh'))).resolves.toBe('后备');
        await expect(flush(api.translateGoogleText('Second', 'en', 'zh'))).resolves.toBe('下一段');
        expect(hosts()).toEqual([HTML, LIST, HTML]);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(response('<html>private</html>', 429)).mockResolvedValueOnce(response('', 403))
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
        let resolveOld!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce(response('', 503)).mockResolvedValue(response(['后备']));
        const old = api.translateGoogleText('Old paragraph', 'en', 'zh');
        await vi.advanceTimersByTimeAsync(10);
        await expect(flush(api.translateGoogleText('New paragraph', 'en', 'zh'))).resolves.toBe('后备');
        resolveOld(response([['迟到成功']])); await expect(old).resolves.toBe('迟到成功');
        await expect(flush(api.translateGoogleText('Next paragraph', 'en', 'zh'))).resolves.toBe('后备');
        expect(hosts()).toEqual([HTML, HTML, LIST, LIST]);
    });
    it.each([[400,400,413,422], [429,429,429,429], [503,503,503,503]].map(statuses => ({statuses})))('所有接口失败保留一致 HTTP 分类 $statuses 且不泄露正文', async ({statuses}) => {
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
        await vi.advanceTimersByTimeAsync(8_010);
        await assertion;
        expect(hosts()).toEqual([HTML, LIST, RPC, UK]);
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Google 合批取消所有权', () => {
    it('排队前/排队中取消不会发送请求', async () => {
        const first = new AbortController(); first.abort();
        await expect(api.translateGoogleText('Hello', 'en', 'zh', first.signal)).rejects.toMatchObject({name:'AbortError'});
        const second = new AbortController();
        const request = api.translateGoogleText('Hello', 'en', 'zh', second.signal);
        const assertion = expect(request).rejects.toMatchObject({name:'AbortError'});
        second.abort(); await assertion;
        await vi.advanceTimersByTimeAsync(10);
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
        await vi.advanceTimersByTimeAsync(10);
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
        await vi.advanceTimersByTimeAsync(10); owner.abort(new Error('broker 预算耗尽')); await assertion;
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        fetchMock.mockResolvedValue(response([['正常']]));
        await expect(flush(api.translateGoogleText('Next', 'en', 'zh'))).resolves.toBe('正常');
        expect(hosts()).toEqual([HTML, HTML]);
    });
});
