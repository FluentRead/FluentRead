/** 真实 Google 数组 transport 经免费池和 broker 的预算合同；仅替换 HTTP 与健康持久化端口，不访问真实网络。 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {current} = vi.hoisted(() => ({current: {} as Record<string, any>}));
vi.mock('@/src/services/config/store', () => ({config: current, configReady: Promise.resolve()}));
vi.mock('@/src/platform/storage/freeTranslationHealthStorage', () => ({
    freeTranslationHealthStorage: {load: async () => [], save: async () => undefined},
}));

let freeTranslation: typeof import('@/src/providers/translation/free-translation').default;
let createTranslationBroker: typeof import('@/src/services/translation/broker').createTranslationBroker;
const fetchMock = vi.fn<typeof fetch>();
const slots = (count: number) => Array.from({length: count}, (_, index) => `Readable English sentence number ${index}.`);
const translated = (count: number) => Array.from({length: count}, (_, index) => `第${index}段的有效中文译文。`);

function successful(input: RequestInfo | URL, init?: RequestInit): Response {
    expect(new URL(String(input)).hostname).toBe('translate-pa.googleapis.com');
    const sources: string[] = JSON.parse(String(init?.body))[0][0];
    expect(sources.every(source => !source.includes('___FLUENTREAD_'))).toBe(true);
    return Response.json([sources.map(source => `第${source.match(/number (\d+)/u)![1]}段的有效中文译文。`)]);
}

function observe<T>(promise: Promise<T>) {
    const state: {value?: T; error?: unknown; at?: number} = {};
    void promise.then(value => Object.assign(state, {value, at: Date.now()}), error => Object.assign(state, {error, at: Date.now()}));
    return state;
}

function broker(provider: (request: any) => Promise<unknown>) {
    return createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => current, providers: {freeTranslation: provider},
        cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
        serviceTypes: {machine: new Set(['freeTranslation']), isAI: () => false, isAiSdk: () => false, isUseAIContext: () => false},
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => '', aiSdkTransportProfile: ''},
        promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => '', getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
        resolveConfiguredModel: () => '', buildTranslationCacheKey: (identity: unknown) => JSON.stringify(identity),
    } as any).translateWithCache;
}

beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(0);
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, {
        service: 'freeTranslation', from: 'en', to: 'zh-Hans', useCache: false, enableAIContext: false,
        token: {}, proxy: {}, model: {}, customModel: {}, maxConcurrentTranslations: 1,
        translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
        freeTranslationOrder: ['google'], freeTranslationMode: 'sequential',
        freeTranslationTimeoutMs: 5000, freeTranslationCooldownMs: 60000,
    });
    ({default: freeTranslation} = await import('@/src/providers/translation/free-translation'));
    ({createTranslationBroker} = await import('@/src/services/translation/broker'));
});
afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('Google HTTP 退避与免费池/broker 集成', () => {
    it('63 槽免费池保留 owner 分组，在一次短 429 后等待恢复并成功完成，不跨端点重试', async () => {
        const starts: number[] = [];
        fetchMock.mockImplementation(async (input, init) => {
            starts.push(Date.now());
            if (starts.length === 1) return new Response('private original', {status: 429, headers: {'Retry-After': '1'}});
            return successful(input, init);
        });
        const outcome = observe(freeTranslation({origin: slots(63), requestTimeoutMs: 20000}));
        await vi.advanceTimersByTimeAsync(10000);
        expect(outcome).toMatchObject({value: translated(63)});
        expect(outcome.error).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(9);
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))[0][0].length)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 7]);
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
        // 恢复探测属于第一组原 attempt；其旧 300ms 许可已过期，下一组仍受共享 HTTP 200ms 节奏约束。
        expect(starts.slice(2).every((at, index) => at - starts[index + 1]! >= 200)).toBe(true);
        expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).hostname === 'translate-pa.googleapis.com')).toBe(true);
    });

    it('18 秒 outer 排队后的 2 秒剩余预算仍可完成短退避和两个原生组，成功不重置总预算', async () => {
        let release!: (value: string) => void;
        const admitted: Array<{at: number; budget: number}> = [];
        let calls = 0;
        const translate = broker(request => {
            if (++calls === 1) return new Promise<string>(resolve => {release = resolve;});
            admitted.push({at: Date.now(), budget: request.requestTimeoutMs});
            return freeTranslation(request);
        });
        const starts: number[] = [];
        fetchMock.mockImplementation(async (input, init) => {
            starts.push(Date.now());
            if (starts.length === 1) return new Response('', {status: 429, headers: {'Retry-After': '1'}});
            return successful(input, init);
        });
        const occupying = observe(translate({origin: 'Occupying readable English paragraph.', useCache: false, requestTimeoutMs: 20000}));
        const queued = observe(translate({origin: slots(9), useCache: false, requestTimeoutMs: 20000}));
        await vi.advanceTimersByTimeAsync(18000); release('占用请求的有效中文译文。');
        await vi.advanceTimersByTimeAsync(2000);
        expect(occupying.error).toBeUndefined();
        expect(admitted).toEqual([{at: 18000, budget: 2000}]);
        expect(queued).toMatchObject({value: translated(9)});
        expect(queued.error).toBeUndefined();
        expect(queued.at).toBeLessThanOrEqual(20000);
        expect(starts).toHaveLength(3);
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
        expect(starts.every(at => at >= 18000 && at < 20000)).toBe(true);
    });

    it('outer 排队仅剩 500ms 时不能在 1 秒 Retry-After 后重新派发或继续兄弟组', async () => {
        let release!: (value: string) => void;
        let calls = 0;
        const translate = broker(request => ++calls === 1
            ? new Promise<string>(resolve => {release = resolve;}) : freeTranslation(request));
        fetchMock.mockResolvedValue(new Response('', {status: 429, headers: {'Retry-After': '1'}}));
        const occupying = observe(translate({origin: 'Occupying readable English paragraph.', useCache: false, requestTimeoutMs: 20000}));
        const queued = observe(translate({origin: slots(9), useCache: false, requestTimeoutMs: 20000}));
        await vi.advanceTimersByTimeAsync(19500); release('占用请求的有效中文译文。');
        await vi.advanceTimersByTimeAsync(500);
        expect(occupying.error).toBeUndefined();
        expect(queued.error).toBeDefined();
        expect(queued.value).toBeUndefined();
        expect(queued.at).toBeLessThanOrEqual(20000);
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10000);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('免费池取消的恢复探测迟到返回 200 时，不能解冻其他 owner 的单探测限制', async () => {
        const api = await import('@/src/providers/translation/google');
        const pending: Array<{input: RequestInfo | URL; init?: RequestInit; resolve: (response: Response) => void}> = [];
        const validResponse = (entry: typeof pending[number]) => {
            if (new URL(String(entry.input)).hostname === 'translate-pa.googleapis.com') return successful(entry.input, entry.init);
            // 独立 owner 仍可依据在途负载选到 LIST；此用例只判断全 Google 共用的探测所有权。
            expect(new URL(String(entry.input)).hostname).toBe('translate.googleapis.com');
            return Response.json(new URLSearchParams(String(entry.init?.body)).getAll('q')
                .map(source => `第${source.match(/number (\d+)/u)![1]}段的有效中文译文。`));
        };
        let starts = 0;
        fetchMock.mockImplementation((input, init) => {
            if (++starts === 1) return Promise.resolve(new Response('', {status: 429, headers: {'Retry-After': '1'}}));
            // 此夹具故意不响应 abort，用迟到成功检验 provider 健康状态，而不是依赖 fetch 的合作取消。
            return new Promise(resolve => pending.push({input, init, resolve}));
        });
        const caller = new AbortController();
        const cancelled = observe(freeTranslation({origin: slots(9), requestTimeoutMs: 20000, abortSignal: caller.signal}));
        await vi.advanceTimersByTimeAsync(1050);
        expect(pending).toHaveLength(1);
        caller.abort(); await vi.advanceTimersByTimeAsync(0);
        expect(cancelled.error).toMatchObject({name: 'AbortError'});
        expect(pending[0]!.init!.signal!.aborted).toBe(true);
        pending[0]!.resolve(validResponse(pending[0]!));
        await vi.advanceTimersByTimeAsync(0);

        const first = observe(api.translateGoogleOwnerTexts([slots(21)[20]!], 'en', 'zh-Hans', new AbortController().signal));
        const second = observe(api.translateGoogleOwnerTexts([slots(22)[21]!], 'en', 'zh-Hans', new AbortController().signal));
        await vi.advanceTimersByTimeAsync(400);
        const callsDuringProbe = fetchMock.mock.calls.length;
        // 收尾所有真实 transport，使失败断言也不会留下计时器或未完成的本地夹具。
        pending[1]!.resolve(validResponse(pending[1]!));
        await vi.advanceTimersByTimeAsync(0);
        pending[2]!.resolve(validResponse(pending[2]!));
        await vi.advanceTimersByTimeAsync(0);
        expect(first).toMatchObject({value: ['第20段的有效中文译文。']});
        expect(second).toMatchObject({value: ['第21段的有效中文译文。']});
        expect(callsDuringProbe).toBe(3); // 初始 429、取消 probe、新 owner probe；另一个 owner 仍等待。
    });
});
