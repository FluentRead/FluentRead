import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig, storedHealth, microsoftMock, officialMock, bilibiliMock, googleMock, googleOwnerMock, myMemoryMock, webMock, chineseMock, extraMock, unsupportedApertiumMock} = vi.hoisted(() => ({
    mockConfig: {} as Record<string, any>,
    storedHealth: {records: null as unknown},
    microsoftMock: vi.fn(),
    officialMock: vi.fn(),
    bilibiliMock: vi.fn(),
    googleMock: vi.fn(),
    googleOwnerMock: vi.fn(),
    myMemoryMock: vi.fn(),
    webMock: vi.fn(),
    chineseMock: vi.fn(),
    extraMock: vi.fn(),
    unsupportedApertiumMock: vi.fn(),
}));
vi.mock('@/src/platform/storage/freeTranslationHealthStorage', () => ({freeTranslationHealthStorage: {load: async () => storedHealth.records, save: async () => undefined}}));
vi.mock('@/src/services/config/store', () => ({config: mockConfig}));
vi.mock('@/src/providers/translation/microsoft', () => ({translateMicrosoftTexts: microsoftMock}));
vi.mock('@/src/providers/translation/bilibili-free', () => ({translateBilibiliFree: bilibiliMock}));
vi.mock('@/src/providers/translation/free-official-web', () => ({translateOfficialFreeWebProvider: officialMock}));
vi.mock('@/src/providers/translation/google', () => ({translateGoogleText: googleMock, translateGoogleOwnerTexts: googleOwnerMock}));
vi.mock('@/src/providers/translation/mymemory', () => ({default: myMemoryMock}));
vi.mock('@/src/providers/translation/free-web', () => ({translateFreeWebText: webMock}));
vi.mock('@/src/providers/translation/free-chinese-web', () => ({translateFreeChineseWebText: chineseMock}));
vi.mock('@/src/providers/translation/free-extra-web', () => ({translateExtraFreeWebText: extraMock, isKnownUnsupportedApertiumDirection: unsupportedApertiumMock}));

import type {TranslationConfigSource} from '@/src/services/translation/types';
import {DEFAULT_DEEPLX_ENDPOINT} from '@/src/core/config/deeplx';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {serializeTranslationSlots} from '@/src/core/translation/slotProtocol';

let freeTranslation: typeof import('@/src/providers/translation/free-translation').default;
let FREE_TRANSLATION_BATCH_CONCURRENCY: number;
let getFreeTranslationWeightSnapshot: typeof import('@/src/providers/translation/free-translation').getFreeTranslationWeightSnapshot;
let translateFreeTranslationProvider: typeof import('@/src/providers/translation/free-translation').translateFreeTranslationProvider;
let attachTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').attachTranslationProviderConfig;
let createTranslationProviderConfigSnapshot: typeof import('@/src/services/translation/requestSnapshot').createTranslationProviderConfigSnapshot;
let getTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').getTranslationProviderConfig;
const translateFreeText = (text: string, message: Record<string, unknown> = {}) => (
    freeTranslation({...message, origin: text}) as Promise<string>
);
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
async function settle<T>(request: Promise<T>): Promise<T> {
    let done = false;
    void request.then(() => {done = true;}, () => {done = true;});
    for (let step = 0; step < 200 && !done; step += 1) await vi.advanceTimersByTimeAsync(50);
    return request;
}
const httpFailure = (statusCode = 503) => Object.assign(new Error('private original and token'), {statusCode});
const readSnapshot = (message: object) => getTranslationProviderConfig(message, mockConfig as never);

beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    storedHealth.records = null;
    unsupportedApertiumMock.mockReturnValue(false);
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
    Object.assign(mockConfig, {
        service: 'freeTranslation', from: 'auto', to: 'zh-Hans',
        token: {}, proxy: {}, model: {}, customModel: {},
        freeTranslationTimeoutMs: 1_000, freeTranslationCooldownMs: 1_000,
        freeTranslationMode: 'sequential',
        freeTranslationOrder: ['microsoft', 'alibabaFree', 'google', 'myMemory'],
        myMemoryEmail: '', deeplx: 'https://deeplx.example/translate',
    });
    for (const mock of [microsoftMock, officialMock, bilibiliMock, googleMock, googleOwnerMock, myMemoryMock, chineseMock, extraMock]) {
        mock.mockRejectedValue(httpFailure());
    }
    ({default: freeTranslation, FREE_TRANSLATION_BATCH_CONCURRENCY, getFreeTranslationWeightSnapshot, translateFreeTranslationProvider}
        = await import('@/src/providers/translation/free-translation'));
    ({attachTranslationProviderConfig, createTranslationProviderConfigSnapshot, getTranslationProviderConfig}
        = await import('@/src/services/translation/requestSnapshot'));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('免费翻译服务', () => {
    it('已确认不支持的 Apertium 方向只在当前方向跳过，配置和连接健康身份不变', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree', 'google'];
        let unsupported = false;
        unsupportedApertiumMock.mockImplementation((source: string, target: string) => unsupported && source === 'en' && target === 'zh-Hans');
        extraMock.mockImplementationOnce(async () => {
            unsupported = true;
            throw Object.assign(new Error('Apertium 不支持当前语言方向'), {statusCode: 400, freeFailure: 'request'});
        }).mockResolvedValue('Hola');
        googleMock.mockResolvedValue('有效译文');

        await expect(settle(translateFreeText('First prose', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).resolves.toBe('有效译文');
        await expect(settle(translateFreeText('Next prose', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).resolves.toBe('有效译文');
        expect(extraMock).toHaveBeenCalledOnce();
        expect(mockConfig.freeTranslationOrder).toEqual(['apertiumFree', 'google']);
        expect((await getFreeTranslationWeightSnapshot()).entries.find(entry => entry.providerId === 'apertiumFree')?.status).toBe('ready');

        await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'es'}))).resolves.toBe('Hola');
        expect(extraMock).toHaveBeenCalledTimes(2);
        expect(extraMock.mock.calls[1].slice(0, 4)).toEqual(['apertiumFree', 'Hello', 'en', 'es']);
    });

    it('只有 Apertium 时仍由 provider 返回语言方向错误，真实取消不被候选排除吞掉', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree'];
        unsupportedApertiumMock.mockReturnValue(true);
        extraMock.mockRejectedValue(Object.assign(new Error('Apertium 不支持当前语言方向'), {statusCode: 400, freeFailure: 'request'}));
        await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).rejects.toThrow('HTTP 400');
        expect(extraMock).toHaveBeenCalledOnce();

        const owner = new AbortController();
        const reason = new Error('真实取消');
        owner.abort(reason);
        await expect(translateFreeText('Cancelled', {abortSignal: owner.signal})).rejects.toBe(reason);
        expect(extraMock).toHaveBeenCalledOnce();
    });

    it.each(FREE_TRANSLATION_PROVIDERS)('单服务检查直接使用 $id 匿名适配器，即使没有开启', async ({id}) => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        microsoftMock.mockResolvedValue(['有效译文']);
        for (const mock of [officialMock, bilibiliMock, googleMock, myMemoryMock, webMock, chineseMock, extraMock]) mock.mockResolvedValue('有效译文');
        await expect(translateFreeTranslationProvider(id, {origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'})).resolves.toBe('有效译文');
        const calls = [microsoftMock, officialMock, bilibiliMock, googleMock, myMemoryMock, webMock, chineseMock, extraMock].reduce((total, mock) => total + mock.mock.calls.length, 0);
        expect(calls).toBe(1);
        const families = {transmart: webMock, yandexFree: webMock, volcengineFree: webMock, youdaoFree: chineseMock, icibaFree: chineseMock,
            sogouFree: extraMock, reversoFree: extraMock, apertiumFree: extraMock};
        if (id in families) expect(families[id as keyof typeof families]).toHaveBeenCalledWith(id, 'Hello from FluentRead.', 'en', 'zh-Hans', undefined);
        if (['alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree'].includes(id)) expect(officialMock).toHaveBeenCalledWith(id, expect.objectContaining({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}));
        if (id === 'bilibiliFree') expect(bilibiliMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}));
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft']);
    });

    it('B站限流后按原顺序换线；连接检查不换线且无需凭据', async () => {
        mockConfig.freeTranslationOrder = ['bilibiliFree', 'google'];
        mockConfig.freeTranslationMode = 'sequential';
        bilibiliMock.mockRejectedValue(Object.assign(new Error('rate limited'), {statusCode: 429, retryAfterMs: 12000}));
        googleMock.mockResolvedValue('有效译文');
        await expect(settle(translateFreeText('Hello from FluentRead.'))).resolves.toBe('有效译文');
        expect(bilibiliMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        const snapshot = getTranslationProviderConfig(bilibiliMock.mock.calls[0][0], mockConfig as any);
        expect(snapshot.token).toEqual({});
        expect(snapshot.proxy).toEqual({});
        await expect(translateFreeTranslationProvider('bilibiliFree', {origin: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans'})).rejects.toMatchObject({statusCode: 429});
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it('单服务检查保留匿名边界和结果验证，失败或原文回显不会自动换线', async () => {
        mockConfig.token = {deeplx: 'saved-private-key'};
        mockConfig.proxy = {deeplx: 'https://private.example'};
        mockConfig.deeplx = 'https://private.example/translate';
        officialMock.mockResolvedValueOnce('有效译文');
        await translateFreeTranslationProvider('alibabaFree', {origin: 'Hello from FluentRead.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'});
        const snapshot = getTranslationProviderConfig(officialMock.mock.calls[0][1], mockConfig as any);
        expect(snapshot.token).toEqual({});
        expect(snapshot.proxy).toEqual({});
        expect(snapshot.deeplx).toBe(DEFAULT_DEEPLX_ENDPOINT);
        microsoftMock.mockResolvedValue(['备用译文']);
        officialMock.mockRejectedValueOnce(new Error('服务不可用'));
        await expect(translateFreeTranslationProvider('alibabaFree', {origin: 'Hello', targetLanguage: 'zh-Hans'})).rejects.toThrow('服务不可用');
        const echoed = 'The software translates this paragraph with a fast backup when the first service is slow.';
        officialMock.mockResolvedValueOnce(echoed);
        await expect(translateFreeTranslationProvider('alibabaFree', {origin: echoed, targetLanguage: 'zh-Hans'})).rejects.toThrow();
        await expect(translateFreeTranslationProvider('unknown', {origin: 'Hello'})).rejects.toThrow('无效的免费翻译服务');
        expect(microsoftMock).not.toHaveBeenCalled();
    });
    it('保留微软、阿里翻译、谷歌优先顺序并新增 MyMemory 官方后备', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree', 'google', 'myMemory'];
        const calls: string[] = [];
        microsoftMock.mockImplementation(async () => { calls.push('microsoft'); throw httpFailure(); });
        officialMock.mockImplementation(async () => { calls.push('alibabaFree'); throw httpFailure(); });
        googleMock.mockImplementation(async () => { calls.push('google'); throw httpFailure(); });
        myMemoryMock.mockImplementation(async () => { calls.push('myMemory'); return '官方译文'; });
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('官方译文');
        expect(calls).toEqual(['microsoft', 'alibabaFree', 'google', 'myMemory']);
        expect(microsoftMock).toHaveBeenCalledWith(['Hello'], 'auto', 'zh-Hans', expect.any(AbortSignal));
        expect(officialMock).toHaveBeenCalledWith('alibabaFree', expect.objectContaining({origin: 'Hello', sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}));
        expect(myMemoryMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello', serviceOverride: 'myMemory', abortSignal: expect.any(AbortSignal)}));
    });

    it('每次线路尝试上报免费服务标识、结果、耗时与文本长度', async () => {
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<Record<string, unknown>> = [];
        microsoftMock.mockRejectedValue(httpFailure());
        officialMock.mockResolvedValue('阿里翻译 译文');
        const message = attachTranslationRouteObserver({origin: 'Hello route'}, observation => observations.push({...observation}));

        await expect(settle(freeTranslation(message) as Promise<string>)).resolves.toBe('阿里翻译 译文');

        expect(observations).toEqual([
            {route: 'microsoft', outcome: 'error', durationMs: expect.any(Number), chars: 11},
            {route: 'alibabaFree', outcome: 'success', durationMs: expect.any(Number), chars: 11},
        ]);
    });

    it('首个服务成功即返回，不会外发给后续服务', async () => {
        microsoftMock.mockResolvedValue(['微软译文']);
        await expect(settle(freeTranslation({origin: 'Hello'}))).resolves.toBe('微软译文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).not.toHaveBeenCalled();
        expect(myMemoryMock).not.toHaveBeenCalled();
    });

    it('图片裸网址原样返回时不轮询后备服务或报免费线路全部失败', async () => {
        const url = 'docs.sglang.io/cookbook';
        microsoftMock.mockResolvedValue([url]);
        await expect(settle(freeTranslation({origin: [url]}))).resolves.toEqual([url]);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).not.toHaveBeenCalled();
        expect(googleMock).not.toHaveBeenCalled();
        expect(myMemoryMock).not.toHaveBeenCalled();
    });

    it('中文目标遇到整段日文时换线，后续段落仍可使用原线路', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const japanese = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
        microsoftMock.mockResolvedValueOnce([japanese]).mockResolvedValueOnce(['下一段的中文译文']);
        officialMock.mockResolvedValue('这个文件的首字母也有限制。');
        const origin = 'There are also restrictions on the first character of this file.';

        await expect(settle(translateFreeText(origin))).resolves.toBe('这个文件的首字母也有限制。');
        await expect(settle(translateFreeText('The next paragraph has different text.'))).resolves.toBe('下一段的中文译文');
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('英文标签列表被线路原样返回时换用后备服务，且不把该线路全局冷却', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const tags = 'solo, blush, smile, bangs, looking_at_viewer, long_hair, blue_eyes';
        microsoftMock.mockImplementation(async ([text]) => [text]);
        officialMock.mockResolvedValue('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');

        await expect(settle(translateFreeText(tags))).resolves.toBe('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');
        await expect(settle(translateFreeText('solo, blush, smile, bangs, long_hair, blue_eyes, white_dress')))
            .resolves.toBe('单人，脸红，微笑，刘海，看向观众，长发，蓝眼睛');
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(officialMock).toHaveBeenCalledTimes(2);
    });

    it('短英文标题被线路原样返回时换用后备服务', async () => {
        mockConfig.freeTranslationOrder = ['transmart', 'google'];
        webMock.mockResolvedValue('Frontend Developer');
        googleMock.mockResolvedValue('前端开发者');

        await expect(settle(translateFreeText('Frontend Developer'))).resolves.toBe('前端开发者');
        expect(webMock).toHaveBeenCalledWith('transmart', 'Frontend Developer', 'auto', 'zh-Hans', expect.any(AbortSignal));
        expect(googleMock).toHaveBeenCalledOnce();
    });

    it.each([
        ['Division (', '（', '除法（'],
        ['Logical NOT (', 'LOGICAL NOT (', '逻辑非（'],
    ] as const)('免费池拒绝 Swift 运算符 %j 的无效成功结果并继续既有降级', async (source, invalid, translated) => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        officialMock.mockImplementation(async (_id, request) => request.origin === ')' ? ')' : translated);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string}> = [];
        const message = attachTranslationRouteObserver({origin: [source, ')'], targetLanguage: 'zh-Hans'},
            observation => observations.push({route: observation.route, outcome: observation.outcome}));
        // 实际全文槽包含本地保真的右括号；无字母的槽仍允许原样返回。
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => text === ')'
            ? ')' : text === source ? invalid : '下一段中文译文'));
        await expect(settle(freeTranslation(message))).resolves.toEqual([translated, ')']);
        expect(observations).toContainEqual({route: 'microsoft', outcome: 'error'});
        expect(observations).toContainEqual({route: 'alibabaFree', outcome: 'success'});
        expect(officialMock).toHaveBeenCalledWith('alibabaFree', expect.objectContaining({origin: source}));
        expect(officialMock.mock.calls.filter(([, request]) => request.origin === source)).toHaveLength(1);
        const fallbackCallsBeforeLater = officialMock.mock.calls.length;
        // 这是文本级无效响应，不是 provider 全局冷却：下一段仍可命中微软。
        await expect(settle(translateFreeText('A later paragraph remains readable.'))).resolves.toBe('下一段中文译文');
        expect(microsoftMock.mock.calls.some(([texts]) => texts[0] === 'A later paragraph remains readable.')).toBe(true);
        expect(officialMock).toHaveBeenCalledTimes(fallbackCallsBeforeLater);
    });

    it.each([
        ['Division (', '（'],
        ['Logical NOT (', 'LOGICAL NOT ('],
    ] as const)('运算符 %j 无有效后备时保留失败，不冒充已完成或自行接受 unchanged', async (source, invalid) => {
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        microsoftMock.mockResolvedValue([invalid]);
        officialMock.mockResolvedValue(invalid);
        await expect(settle(translateFreeText(source))).rejects.toThrow('返回未翻译原文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('单服务检查也拒绝运算符丢词，不偷偷换线', async () => {
        officialMock.mockResolvedValue('（');
        await expect(translateFreeTranslationProvider('alibabaFree', {
            origin: 'Division (', targetLanguage: 'zh-Hans',
        })).rejects.toThrow('返回未翻译原文');
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('保存顺序里的有 Key 服务全部剔除，仅按所选免密钥服务翻译', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL', 'openai', 'custom:key-provider', 'myMemory', 'microsoft'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx', openai: 'secret-key'};
        myMemoryMock.mockResolvedValue('MyMemory');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('MyMemory');
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(officialMock).not.toHaveBeenCalled();
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['myMemory', 'microsoft']);
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).token).toEqual({});
    });

    it('旧设置只保存有 Key 服务时回到匿名默认链，历史 Key 不影响选择', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx'};
        myMemoryMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('备用');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['microsoft', 'bilibiliFree', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'myMemory', 'sogouFree', 'reversoFree', 'apertiumFree', 'alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree']);
    });

    it('上游挂起时局部超时继续降级，下一段跳过正在冷却的上游', async () => {
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        officialMock.mockResolvedValue('备用');
        const first = translateFreeText('Hello');
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(first).resolves.toBe('备用');
        // 冷却时长带抖动，且到期后允许再次探测；断言必须落在冷却窗口内，
        // 否则 settle 推进的时钟可能越过冷却终点，把合法探测当成未跳过。
        const second = translateFreeText('World');
        await vi.advanceTimersByTimeAsync(900);
        expect(microsoftMock).toHaveBeenCalledOnce();
        await expect(settle(second)).resolves.toBe('备用');
        expect(microsoftMock.mock.calls[0][3].aborted).toBe(true);
    });

    it('返回空译文时继续降级，全部失败只汇总安全原因', async () => {
        microsoftMock.mockResolvedValue(['']);
        googleMock.mockRejectedValue(httpFailure(429));
        const request = translateFreeText('private source text');
        await expect(request).rejects.toThrow('微软翻译: 未返回有效译文；阿里翻译: HTTP 503；谷歌翻译: HTTP 429；MyMemory: HTTP 503');
        await expect(request).rejects.not.toThrow('private');
    });

    it('请求启动后修改全局顺序、语言、凭据和端点不影响在途降级', async () => {
        let rejectFirst!: (error: Error) => void;
        microsoftMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
        officialMock.mockResolvedValue('原配置译文');
        mockConfig.token.deeplx = 'original-key';
        mockConfig.freeTranslationOrder = ['microsoft', 'alibabaFree'];
        const request = translateFreeText('Hello');
        await flush();
        mockConfig.token.deeplx = 'new-key';
        mockConfig.deeplx = 'https://new.example/translate';
        mockConfig.from = 'ja';
        mockConfig.to = 'fr';
        mockConfig.freeTranslationOrder.splice(0, 2, 'google');
        rejectFirst(httpFailure());
        await expect(request).resolves.toBe('原配置译文');
        const fallbackRequest = officialMock.mock.calls[0][1];
        expect(fallbackRequest).toMatchObject({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'});
        expect(readSnapshot(fallbackRequest)).toMatchObject({
            token: {}, proxy: {}, deeplx: DEFAULT_DEEPLX_ENDPOINT,
            freeTranslationOrder: ['microsoft', 'alibabaFree'],
        });
        expect(Object.isFrozen(readSnapshot(fallbackRequest).freeTranslationOrder)).toBe(true);
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('broker 附带的配置快照优先于已经变化的全局设置', async () => {
        mockConfig.freeTranslationOrder = ['myMemory'];
        mockConfig.myMemoryEmail = 'old@example.com';
        const snapshot = createTranslationProviderConfigSnapshot(mockConfig as TranslationConfigSource);
        const message = attachTranslationProviderConfig({origin: 'Hello', targetLanguage: 'ja'}, snapshot);
        mockConfig.freeTranslationOrder = ['google'];
        mockConfig.myMemoryEmail = 'new@example.com';
        myMemoryMock.mockResolvedValue('冻结译文');
        await expect(settle(freeTranslation(message))).resolves.toBe('冻结译文');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).myMemoryEmail).toBe('old@example.com');
        expect(myMemoryMock.mock.calls[0][0].targetLanguage).toBe('ja');
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('被官方接口忽略的残留 proxy 不影响配额冷却身份', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        googleMock.mockResolvedValue('备用');
        myMemoryMock.mockRejectedValue(httpFailure(429));
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.proxy.myMemory = 'https://other.example/memory';
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        expect(myMemoryMock).toHaveBeenCalledOnce();
    });

    it('更换 MyMemory 邮箱不继承旧匿名/邮箱额度冷却', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        myMemoryMock.mockRejectedValueOnce(httpFailure(429)).mockResolvedValue('新邮箱译文');
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.myMemoryEmail = 'new@example.com';
        await expect(settle(translateFreeText('two'))).resolves.toBe('新邮箱译文');
        expect(myMemoryMock).toHaveBeenCalledTimes(2);
    });

    it.each(['token', 'endpoint', 'proxy'])('更换独立 阿里翻译 的%s 不改变免费链的匿名连接或冷却状态', async changed => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'google'];
        mockConfig.token.deeplx = 'old-key';
        officialMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        if (changed === 'token') mockConfig.token.deeplx = 'new-key';
        else if (changed === 'endpoint') mockConfig.deeplx = 'https://new.example/translate';
        else mockConfig.proxy.deeplx = 'https://proxy.example/translate';
        await expect(settle(translateFreeText('three'))).resolves.toBe('备用');
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it('已保存的 阿里翻译 代理及默认地址都不会绕过匿名公共接口的冷却', async () => {
        mockConfig.freeTranslationOrder = ['alibabaFree', 'google'];
        mockConfig.proxy.deeplx = 'https://active.example/translate';
        officialMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(settle(translateFreeText('one'))).resolves.toBe('备用');
        mockConfig.deeplx = 'https://unused.example/translate';
        await expect(settle(translateFreeText('two'))).resolves.toBe('备用');
        expect(officialMock).toHaveBeenCalledOnce();
    });

    it.each(['deeplx', 'lingvaFree'])('第三方旧节点 %s 不会参与检查或已保存的免费顺序', async id => {
        mockConfig.freeTranslationOrder = [id, 'google'];
        googleMock.mockResolvedValue('官方译文');
        await expect(settle(translateFreeText('Hello'))).resolves.toBe('官方译文');
        await expect(translateFreeTranslationProvider(id, {origin: 'Hello'})).rejects.toThrow('无效的免费翻译服务');
        expect(officialMock).not.toHaveBeenCalled();
    });

    it('single-provider batches respect Microsoft concurrency and spacing while preserving output order', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{text: string; resolve: (value: string[]) => void}> = [];
        let active = 0;
        let maximum = 0;
        microsoftMock.mockImplementation(([text]: [string]) => new Promise<string[]>(resolve => {
            active += 1;
            maximum = Math.max(maximum, active);
            pending.push({text, resolve: value => { active -= 1; resolve(value); }});
        }));
        const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E', 'F']});
        await flush();
        expect(pending).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(2);
        pending[1].resolve(['译:B']);
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(3);
        pending[0].resolve(['译:A']);
        await vi.advanceTimersByTimeAsync(100);
        pending[3].resolve(['译:D']);
        await vi.advanceTimersByTimeAsync(100);
        pending[2].resolve(['译:C']);
        await vi.advanceTimersByTimeAsync(100);
        pending[5].resolve(['译:F']);
        pending[4].resolve(['译:E']);
        await expect(request).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E', '译:F']);
        expect(maximum).toBe(2);
        expect(FREE_TRANSLATION_BATCH_CONCURRENCY).toBe(6);
    });

    it('a shared batch deadline includes pacing and prevents later segments starting', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<(value: string[]) => void> = [];
        microsoftMock.mockImplementation(() => new Promise<string[]>(resolve => { pending.push(resolve); }));
        const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E'], requestTimeoutMs: 500});
        const assertion = expect(request).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(300);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        pending[0](['译:A']);
        await flush();
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(200);
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(officialMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('批量遇限流后后续段跳过失败服务，保序翻译', async () => {
        microsoftMock.mockRejectedValue(httpFailure(429));
        officialMock.mockImplementation(async (_id: string, request: {origin: string}) => `译:${request.origin}`);
        await expect(settle(freeTranslation({origin: ['A', 'B', 'C', 'D', 'E']}))).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E']);
        expect(microsoftMock).toHaveBeenCalledTimes(1);
        expect(officialMock).toHaveBeenCalledTimes(5);
    });

    it('调用方取消中止所有在途 worker，不启动未领取段落、不继续降级', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const controller = new AbortController();
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E'], abortSignal: controller.signal});
        const assertion = expect(request).rejects.toThrow('用户取消');
        await vi.advanceTimersByTimeAsync(100);
        controller.abort(new Error('用户取消'));
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(microsoftMock.mock.calls.every(call => call[3].aborted)).toBe(true);
        expect(officialMock).not.toHaveBeenCalled();
        microsoftMock.mockResolvedValue(['恢复']);
        await expect(settle(translateFreeText('next'))).resolves.toBe('恢复');
    });

    it('任一文本耗尽所有备用后取消 sibling，避免余下请求继续外发', async () => {
        microsoftMock.mockImplementation(([text]: [string]) => text === 'bad' ? Promise.reject(httpFailure()) : new Promise(() => {}));
        await expect(settle(freeTranslation({origin: ['bad', 'slow-1', 'slow-2', 'not-started']}))).rejects.toThrow('免费翻译服务均不可用');
        expect(microsoftMock).toHaveBeenCalledTimes(1);
        expect(microsoftMock.mock.calls.slice(1).every(call => call[3].aborted)).toBe(true);
        expect(officialMock).toHaveBeenCalledOnce();
        expect(googleMock).toHaveBeenCalledOnce();
        expect(myMemoryMock).toHaveBeenCalledOnce();
    });

    it.each(['single', 'batch'])('预先取消的%s消息不启动任何服务', async kind => {
        const controller = new AbortController();
        controller.abort('stop');
        await expect(freeTranslation({origin: kind === 'batch' ? ['Hello'] : 'Hello', abortSignal: controller.signal}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it.each([{sourceLanguage: 'en'}, {targetLanguage: 'ja'}])('显式语言覆盖传入每个备用 provider %#', async languages => {
        officialMock.mockResolvedValue('译文');
        await expect(settle(translateFreeText('Hello', languages))).resolves.toBe('译文');
        expect(officialMock.mock.calls[0][1]).toMatchObject(languages);
    });

    it('空批量直接返回并拒绝非文本输入', async () => {
        await expect(settle(freeTranslation({origin: []}))).resolves.toEqual([]);
        await expect(settle(freeTranslation({origin: [42 as unknown as string]}))).rejects.toThrow('仅支持文本输入');
        await expect(settle(freeTranslation({origin: 42 as unknown as string}))).rejects.toThrow('仅支持文本输入');
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('原生高槽批次在任何 HTTP 前拒绝非字符串来源', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = Array.from({length: 9}, (_, index) => index === 7 ? 42 as unknown as string : `Source ${index}`);
        await expect(freeTranslation({origin: origins})).rejects.toThrow('仅支持文本输入');
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2, 4, 8])('成功结果交付前后第 %s 轮微任务取消，不外发后续槽且保留取消原因', async microtasks => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        microsoftMock.mockImplementation(async (sources: string[]) => sources.map(source => `有效译文：${source}`));
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const owner = new AbortController();
        const reason = new Error('用户在结果交付边界取消');
        let callsAtCancellation = -1;
        const cancel = (remaining: number) => {
            if (remaining > 0) queueMicrotask(() => cancel(remaining - 1));
            else {
                callsAtCancellation = microsoftMock.mock.calls.length;
                owner.abort(reason);
            }
        };
        const origins = Array.from({length: 17}, (_, index) => `Source passage ${index}`);
        const request = freeTranslation(attachTranslationRouteObserver({origin: origins, abortSignal: owner.signal}, event => {
            if (event.outcome === 'success' && !owner.signal.aborted) cancel(microtasks);
        }));
        await expect(settle(request)).rejects.toBe(reason);
        expect(callsAtCancellation).toBeGreaterThan(0);
        expect(microsoftMock).toHaveBeenCalledTimes(callsAtCancellation);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(microsoftMock).toHaveBeenCalledTimes(callsAtCancellation);
    });
});

it.each(['transmart', 'yandexFree', 'volcengineFree'])('routes %s only via free policy with request language and cancellation', async id => {
    mockConfig.freeTranslationOrder = [id];
    webMock.mockResolvedValue('新译文');
    const abort = new AbortController();
    await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hant', abortSignal: abort.signal}))).resolves.toBe('新译文');
    expect(webMock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hant', expect.any(AbortSignal));
});
it('maps background health to the enabled services of the current settings for the weight snapshot', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'google', 'myMemory'];
    mockConfig.myMemoryEmail = 'old@example.com';
    microsoftMock.mockRejectedValue(httpFailure(503));
    googleMock.mockRejectedValue(httpFailure(413));
    myMemoryMock.mockResolvedValue('MyMemory 译文');
    await expect(settle(translateFreeText('Hello'))).resolves.toBe('MyMemory 译文');

    const snapshot = await getFreeTranslationWeightSnapshot(Date.now());
    const byId = new Map(snapshot.entries.map(entry => [entry.providerId, entry]));
    expect(snapshot.total).toBe(100);
    expect(byId.get('microsoft')).toMatchObject({weight: 0, status: 'cooling'});
    // 文本级 413 不产生健康记录，谷歌仍按默认权重参与分配。
    expect(byId.get('google')).toMatchObject({status: 'ready'});
    expect(byId.get('google')!.weight).toBeGreaterThan(0);
    expect(byId.get('myMemory')).toMatchObject({status: 'ready'});
    expect(byId.get('alibabaFree')).toMatchObject({weight: 0, status: 'disabled'});
    expect(JSON.stringify(snapshot)).not.toMatch(/[a-f0-9]{64}|old@example\.com/u);

    // MyMemory 邮箱属于连接身份；换邮箱后不能把旧身份的健康记录展示给新配置。
    mockConfig.freeTranslationOrder = ['microsoft', 'myMemory'];
    mockConfig.myMemoryEmail = 'new@example.com';
    const changed = await getFreeTranslationWeightSnapshot(Date.now());
    expect(changed.entries.find(entry => entry.providerId === 'google')).toMatchObject({weight: 0, status: 'disabled'});
    expect(changed.entries.find(entry => entry.providerId === 'myMemory')).toMatchObject({weight: 100, status: 'ready'});
});

it('shows a persisted legacy cooling record without performance data after a background restart', async () => {
    const {default: sha256} = await import('crypto-js/sha256');
    const retryAt = Date.now() + 60_000;
    storedHealth.records = [{identity: `google:${sha256(JSON.stringify(['google'])).toString()}`, retryAt, failures: 2, category: 'blocked'}];
    mockConfig.freeTranslationOrder = ['microsoft', 'google'];

    const snapshot = await getFreeTranslationWeightSnapshot(Date.now());
    expect(snapshot.entries.find(entry => entry.providerId === 'google')).toEqual({providerId: 'google', weight: 0, status: 'cooling', retryAt});
    expect(snapshot.entries.find(entry => entry.providerId === 'microsoft')).toMatchObject({weight: 100, status: 'ready'});
});

it('falls back and cools down a failed new route while keeping language errors request-local', async () => {
    mockConfig.freeTranslationOrder = ['transmart', 'yandexFree', 'volcengineFree'];
    webMock.mockImplementation(async id => {if (id === 'transmart') throw httpFailure(429); if (id === 'yandexFree') throw httpFailure(400); return '译文';});
    await expect(settle(translateFreeText('One'))).resolves.toBe('译文');
    await expect(settle(translateFreeText('Two'))).resolves.toBe('译文');
    expect(webMock.mock.calls.map(call => call[0])).toEqual(['transmart', 'yandexFree', 'volcengineFree', 'yandexFree', 'volcengineFree']);
});

it.each([
    ['youdaoFree', 'chinese'], ['icibaFree', 'chinese'],
    ['sogouFree', 'extra'], ['reversoFree', 'extra'], ['apertiumFree', 'extra'],
] as const)('routes %s through the dedicated adapter with frozen language and cancellation', async (id, kind) => {
    mockConfig.freeTranslationOrder = [id];
    const mock = kind === 'chinese' ? chineseMock : extraMock;
    mock.mockResolvedValue('适配器译文');
    const abort = new AbortController();
    await expect(settle(translateFreeText('Hello', {sourceLanguage: 'en', targetLanguage: 'zh-Hans', abortSignal: abort.signal}))).resolves.toBe('适配器译文');
    if (kind === 'chinese') expect(mock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hans', expect.any(AbortSignal));
    else expect(mock).toHaveBeenCalledWith(id, 'Hello', 'en', 'zh-Hans', expect.any(AbortSignal));
});

it('passes balanced mode while excluding supplied manual weights from the frozen request', async () => {
    mockConfig.freeTranslationOrder = ['microsoft', 'sogouFree'];
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationWeights = {microsoft: 7, sogouFree: 2};
    microsoftMock.mockRejectedValue(httpFailure(429));
    extraMock.mockResolvedValue('均衡译文');
    await expect(settle(translateFreeText('Hello'))).resolves.toBe('均衡译文');
    const request = extraMock.mock.calls[0]![4];
    expect(request).toBeInstanceOf(AbortSignal);
    const snapshot = createTranslationProviderConfigSnapshot(mockConfig as TranslationConfigSource);
    expect(mockConfig.freeTranslationMode).toBe('balanced');
    expect(mockConfig.freeTranslationWeights).toEqual({microsoft: 7, sogouFree: 2});
    expect(Object.isFrozen(snapshot.freeTranslationOrder)).toBe(true);
    expect(snapshot).not.toHaveProperty('freeTranslationWeights');
});


it('六家官方节点同时分担不同段落，任务上限和输出顺序保持有界', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'transmart', 'google', 'alibabaFree', 'modernMtFree', 'laraFree'];
    const running: Array<{id: string; text: string; resolve: () => void}> = [];
    let active = 0;
    let maximum = 0;
    const pending = (id: string, text: string, array = false) => new Promise(resolve => {
        active++; maximum = Math.max(maximum, active);
        running.push({id, text, resolve: () => {active--; resolve(array ? [`译:${text}`] : `译:${text}`);}});
    });
    microsoftMock.mockImplementation(([text]: string[]) => pending('microsoft', text, true));
    googleMock.mockImplementation(text => pending('google', text));
    webMock.mockImplementation((id, text) => pending(id, text));
    officialMock.mockImplementation((id, request) => pending(id, request.origin));
    const texts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const request = freeTranslation({origin: texts});
    await flush();
    expect(running).toHaveLength(6);
    expect(new Set(running.map(item => item.id)).size).toBe(6);
    expect(running.map(item => item.text)).toEqual(texts.slice(0, 6));
    running.splice(0).reverse().forEach(item => item.resolve());
    await vi.advanceTimersByTimeAsync(1000);
    running.splice(0).reverse().forEach(item => item.resolve());
    await expect(settle(request)).resolves.toEqual(texts.map(text => `译:${text}`));
    expect(maximum).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
});

it('取消同时停止六家节点，不继续领取队列中的段落', async () => {
    mockConfig.freeTranslationMode = 'balanced';
    mockConfig.freeTranslationOrder = ['microsoft', 'transmart', 'google', 'alibabaFree', 'modernMtFree', 'laraFree'];
    const signals: AbortSignal[] = [];
    const pending = (signal: AbortSignal) => {signals.push(signal); return new Promise(() => {});};
    microsoftMock.mockImplementation((_texts, _from, _to, signal) => pending(signal));
    googleMock.mockImplementation((_text, _from, _to, signal) => pending(signal));
    webMock.mockImplementation((_id, _text, _from, _to, signal) => pending(signal));
    officialMock.mockImplementation((_id, request) => pending(request.abortSignal));
    const caller = new AbortController();
    const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E', 'F', 'queued'], abortSignal: caller.signal});
    const assertion = expect(request).rejects.toMatchObject({name: 'AbortError'});
    await flush();
    expect(signals).toHaveLength(6);
    caller.abort();
    await assertion;
    expect(signals).toHaveLength(6);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it.each([
    ['direct', 'single'], ['direct', 'batch'], ['broker', 'single'], ['broker', 'batch'],
])('%s 的 %s 免费翻译实际只请求官方阿里节点，隔离历史凭据和私有代理', async (entrypoint, mode) => {
    const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
    officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
    mockConfig.freeTranslationOrder = ['alibabaFree'];
    mockConfig.token = {deeplx: 'stored-secret', aliyunTranslation: 'cloud-secret'};
    mockConfig.proxy = {deeplx: 'https://private.example/secret', aliyunTranslation: 'https://proxy.example/secret'};
    mockConfig.customHeaders = {aliyunTranslation: '{"Authorization":"private-header"}'};
    mockConfig.secret = {aliyunTranslation: 'private-cloud-secret'};
    const fetchMock = vi.fn(async (url, init) => String(url).endsWith('/csrftoken')
        ? Response.json({token: 'anonymous-csrf', headerName: 'X-XSRF-TOKEN_PROPERTY_ITEM'})
        : Response.json({success: true, data: {translateText: `译:${(init.body as FormData).get('query')}`}}));
    vi.stubGlobal('fetch', fetchMock);
    const origin = mode === 'batch' ? ['Hello', 'World'] : 'Hello';
    const message = {origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans'};
    const request = entrypoint === 'broker'
        ? attachTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(mockConfig as TranslationConfigSource)) : message;
    await expect(settle(freeTranslation(request))).resolves.toEqual(mode === 'batch' ? ['译:Hello', '译:World'] : '译:Hello');
    expect(fetchMock).toHaveBeenCalledTimes(mode === 'batch' ? 4 : 2);
    for (const [url, init] of fetchMock.mock.calls) {
        expect(new URL(String(url)).hostname).toBe('translate.alibaba.com');
        expect(init.credentials).toBe('omit');
        const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body;
        expect(JSON.stringify([url, init.headers, body])).not.toMatch(/stored-secret|private|proxy\.example|cloud-secret/u);
    }
    expect(readSnapshot(officialMock.mock.calls[0][1])).toMatchObject({token: {}, secret: {}, proxy: {}, customHeaders: {}});
    expect(mockConfig.token.deeplx).toBe('stored-secret');
});


// 全部输出来自受控 mock/HTTP 端口；63/1760 仅匹配规模，不复制 Wikipedia 原文或证明原生效果。
describe('owner-local bounded high-slot free batches', () => {
    const ownerSlots = () => Array.from({length: 63}, (_, index) =>
        `Owner slot ${String(index).padStart(2, '0')} has prose`.padEnd(index === 62 ? 24 : 28, '.'));
    const valid = (texts: readonly string[]) => texts.map(text => `译:${text}`);

    it('63 slots / 1760 characters use eight real Microsoft array HTTP calls under one twenty-second budget', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/microsoft')>('@/src/providers/translation/microsoft');
        microsoftMock.mockImplementation(actual.translateMicrosoftTexts);
        mockConfig.freeTranslationOrder = ['microsoft'];
        mockConfig.freeTranslationTimeoutMs = 5_000;
        const originals = ownerSlots();
        const expected = valid(originals);
        expect(originals.reduce((sum, text) => sum + text.length, 0)).toBe(1760);
        const starts: number[] = [];
        let active = 0;
        let maximum = 0;
        const fetchMock = vi.fn((_url, init) => new Promise<Response>((resolve, reject) => {
            const texts: string[] = JSON.parse(String(init.body));
            starts.push(Date.now()); active += 1; maximum = Math.max(maximum, active);
            const abort = () => { clearTimeout(timer); active -= 1; reject(init.signal.reason); };
            const timer = setTimeout(() => {
                init.signal.removeEventListener('abort', abort); active -= 1;
                resolve(Response.json(texts.map(text => ({translations: [{text: `译:${text}`}]}))));
            }, 2_500);
            init.signal.addEventListener('abort', abort, {once: true});
        }));
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        const start = Date.now();
        let outcome: unknown;
        const request = freeTranslation(attachTranslationRouteObserver({origin: originals, requestTimeoutMs: 20_000}, event => observations.push(event)));
        void request.then(value => { outcome = {value}; }, error => { outcome = {error}; });
        originals[0] = 'Caller mutation after dispatch';
        mockConfig.freeTranslationOrder = ['google'];
        await vi.advanceTimersByTimeAsync(11_000);
        // 基线逐槽传输在此仍未完成；这里检查实际 HTTP body/call，而非把逻辑调用当 HTTP 数。
        expect(outcome).toEqual({value: expected});
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)).length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(maximum).toBe(2);
        expect(starts.every((time, index) => index === 0 || time - starts[index - 1]! >= 100)).toBe(true);
        expect(Date.now() - start).toBeLessThan(20_000);
        expect(observations).toHaveLength(8);
        expect(observations.every(event => event.route === 'microsoft' && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(1760);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Google high-slot groups use the existing native array endpoint and retain pool pacing', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/google')>('@/src/providers/translation/google');
        googleOwnerMock.mockImplementation(actual.translateGoogleOwnerTexts);
        mockConfig.freeTranslationOrder = ['google'];
        const starts: number[] = [];
        const fetchMock = vi.fn(async (_url, init) => {
            starts.push(Date.now());
            const texts: string[] = JSON.parse(String(init.body))[0][0];
            return Response.json([texts.map(text => `译:${text.replace(/^<pre>|<\/pre>$/gu, '')}`)]);
        });
        vi.stubGlobal('fetch', fetchMock);
        const origins = ownerSlots();
        await expect(settle(freeTranslation({origin: origins}))).resolves.toEqual(valid(origins));
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(googleOwnerMock.mock.calls.map(call => call[0].length)).toEqual([8, 8, 8, 8, 8, 8, 8, 7]);
        expect(starts.every((time, index) => index === 0 || time - starts[index - 1]! >= 300)).toBe(true);
        expect(googleMock).not.toHaveBeenCalled();
        expect(microsoftMock).not.toHaveBeenCalled();
    });

    it('escaped character bounds split small groups and a pre-existing long slot stays a singleton', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = ['&'.repeat(500), ...Array.from({length: 8}, (_, index) => `Small prose ${index}`)];
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        await expect(settle(freeTranslation({origin: origins}))).resolves.toEqual(valid(origins));
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([1, 8]);
        expect(microsoftMock.mock.calls[0][0]).toEqual([origins[0]]);
        // 不截断单槽，不为了满足小组大小而给同一 owner 增加总预算。
        expect(microsoftMock.mock.calls[1][0]).toEqual(origins.slice(1));
        microsoftMock.mockClear();
        const bounded = Array.from({length: 9}, () => '&'.repeat(160));
        await expect(settle(freeTranslation({origin: bounded}))).resolves.toEqual(valid(bounded));
        // 每槽保守估算 971，两槽 1942；第三槽会越过 2000，而单槽未超限。
        expect(microsoftMock.mock.calls.map(call => call[0].length)).toEqual([2, 2, 2, 2, 1]);
    });

    it('duplicates remain independent ordinal slots and out-of-order group completion keeps source order', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = Array.from({length: 9}, () => 'Same prose repeated');
        let group = 0;
        const finished: number[] = [];
        microsoftMock.mockImplementation((texts: string[]) => {
            const index = group++;
            return new Promise<string[]>(resolve => setTimeout(() => {
                finished.push(index); resolve(texts.map((_, ordinal) => `第${index}组第${ordinal}槽译文`));
            }, index === 0 ? 400 : 10));
        });
        const request = freeTranslation({origin: origins});
        await vi.advanceTimersByTimeAsync(500);
        await expect(request).resolves.toEqual([...Array.from({length: 8}, (_, ordinal) => `第0组第${ordinal}槽译文`), '第1组第0槽译文']);
        expect(finished).toEqual([1, 0]);
        expect(microsoftMock.mock.calls.map(call => call[0])).toEqual([origins.slice(0, 8), origins.slice(8)]);
    });

    it('pure whitespace, edge whitespace, literal markers, HTML text and internal newlines stay in their original slots', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = [' \tAlpha prose  \n', '', ' \n\t', 'A & <b>"quoted"</b>',
            'Literal ___FLUENTREAD_literal_0_BEGIN___code___FLUENTREAD_literal_0_END___',
            'Line one\n\n  Line two', 'Repeated prose', 'Repeated prose', 'Last prose'];
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => ` ${`译:${text.trim()}`} `));
        await expect(settle(freeTranslation({origin: origins}))).resolves.toEqual([
            ' \t译:Alpha prose  \n', '', ' \n\t', '译:A & <b>"quoted"</b>',
            '译:Literal ___FLUENTREAD_literal_0_BEGIN___code___FLUENTREAD_literal_0_END___',
            '译:Line one\n\n  Line two', '译:Repeated prose', '译:Repeated prose', '译:Last prose',
        ]);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(microsoftMock.mock.calls[0][0]).toEqual(origins.filter(text => text.trim()));
    });

    it.each(['missing', 'extra', 'non-string', 'empty', 'unchanged', 'wrong-language', 'injected-marker'])('one %s slot rejects the whole native group and follows configured fallback', async kind => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const origins = [...Array.from({length: 8}, (_, index) => `This English paragraph contains several ordinary words for slot ${index}.`), ''];
        microsoftMock.mockImplementation(async (texts: string[]) => {
            const values: unknown[] = valid(texts);
            if (kind === 'missing') values.pop();
            else if (kind === 'extra') values.push('多余译文');
            else if (kind === 'non-string') values[6] = null;
            else if (kind === 'empty') values[6] = ' \t';
            else if (kind === 'unchanged') values[6] = texts[6];
            else if (kind === 'wrong-language') values[6] = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
            else values[6] = serializeTranslationSlots(texts).starts[0];
            return values;
        });
        googleOwnerMock.mockImplementation(async (texts: string[]) => valid(texts));
        await expect(settle(freeTranslation({origin: origins}))).resolves.toEqual([...valid(origins.slice(0, 8)), '']);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock.mock.calls[0][0]).toEqual(origins.slice(0, 8));
        expect(mockConfig.freeTranslationOrder).toEqual(['microsoft', 'google']);
        expect((await getFreeTranslationWeightSnapshot()).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
    });

    it('non-native high-slot batches retain per-slot candidate calls and actual HTTP counts', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
        officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
        mockConfig.freeTranslationOrder = ['alibabaFree'];
        const origins = Array.from({length: 9}, (_, index) => `Anonymous prose ${index}`);
        const queryTexts: string[] = [];
        const fetchMock = vi.fn(async (url, init) => {
            if (String(url).endsWith('/csrftoken')) return Response.json({token: 'fixture-csrf', headerName: 'X-XSRF-TOKEN_PROPERTY_ITEM'});
            const query = String((init.body as FormData).get('query')); queryTexts.push(query);
            return Response.json({success: true, data: {translateText: `译:${query}`}});
        });
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        await expect(settle(freeTranslation(attachTranslationRouteObserver({origin: origins}, event => observations.push(event))))).resolves.toEqual(valid(origins));
        expect(officialMock).toHaveBeenCalledTimes(9);
        expect(fetchMock).toHaveBeenCalledTimes(18); // 9 槽各自 CSRF + text，每槽仍独立 candidate，并非把两个 group 当作 HTTP。
        expect([...queryTexts].sort()).toEqual([...origins].sort());
        expect(officialMock.mock.calls.map(call => call[1].origin).sort()).toEqual([...origins].sort());
        expect(queryTexts.every(text => !text.includes('___FLUENTREAD_'))).toBe(true);
        expect(observations).toHaveLength(9);
        expect(observations.every(event => event.route === 'alibabaFree' && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(origins.join('').length);
        expect(readSnapshot(officialMock.mock.calls[0][1])).toMatchObject({token: {}, secret: {}, proxy: {}, customHeaders: {}});
    });

    it('pure-whitespace high-slot batches stay local and already-cancelled callers start no group', async () => {
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        const whitespace = Array.from({length: 15}, (_, index) => index % 2 ? ' \t\n' : '');
        await expect(freeTranslation({origin: whitespace})).resolves.toEqual(whitespace);
        const cancelled = new AbortController(); cancelled.abort();
        await expect(freeTranslation({origin: whitespace, abortSignal: cancelled.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleOwnerMock).not.toHaveBeenCalled(); expect(officialMock).not.toHaveBeenCalled();
    });

    it('one group exhausting the pool cancels siblings and never claims later groups', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const origins = ownerSlots();
        const signals: AbortSignal[] = [];
        microsoftMock.mockImplementation((texts: string[], _from, _to, signal: AbortSignal) => {
            signals.push(signal);
            return new Promise((_resolve, reject) => {
                if (texts[0] === origins[0]) setTimeout(() => reject(httpFailure(429)), 300);
                else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });
        const request = freeTranslation({origin: origins});
        const assertion = expect(request).rejects.toThrow('免费翻译服务均不可用');
        await vi.advanceTimersByTimeAsync(300); await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(signals[0]!.aborted).toBe(false); // This attempt already failed and released its caller subscription.
        expect(signals[1]!.aborted).toBe(true); // The other attempt was still in flight and belongs to this owner.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shared deadline includes queued groups; a successful group never resets siblings to a fresh budget', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{texts: string[]; resolve: (texts: string[]) => void}> = [];
        microsoftMock.mockImplementation((texts: string[]) => new Promise<string[]>(resolve => pending.push({texts, resolve})));
        const request = freeTranslation({origin: ownerSlots(), requestTimeoutMs: 500});
        const assertion = expect(request).rejects.toMatchObject({kind: 'timeout'});
        await vi.advanceTimersByTimeAsync(300);
        expect(pending).toHaveLength(2);
        pending[0]!.resolve(valid(pending[0]!.texts));
        await flush();
        expect(pending).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(200); await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect((await getFreeTranslationWeightSnapshot()).entries.find(entry => entry.providerId === 'microsoft')?.status).toBe('ready');
        pending[1]!.resolve(valid(pending[1]!.texts)); await flush();
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('equal sources in overlapping owners share no group promise, array or cancellation domain', async () => {
        mockConfig.freeTranslationOrder = ['microsoft'];
        const pending: Array<{texts: string[]; signal: AbortSignal; resolve: (texts: string[]) => void}> = [];
        microsoftMock.mockImplementation((texts: string[], _from, _to, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
            pending.push({texts, signal, resolve}); signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        }));
        const origins = Array.from({length: 9}, (_, index) => `Same owner prose ${index}`);
        const firstOwner = new AbortController();
        const first = freeTranslation({origin: origins, abortSignal: firstOwner.signal});
        const firstAssertion = expect(first).rejects.toMatchObject({name: 'AbortError'});
        const second = freeTranslation({origin: origins});
        await vi.advanceTimersByTimeAsync(100);
        expect(pending).toHaveLength(2);
        firstOwner.abort(); await firstAssertion;
        expect(pending.slice(0, 2).every(item => item.signal.aborted)).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(pending).toHaveLength(4);
        expect(pending.slice(2).every(item => !item.signal.aborted)).toBe(true);
        expect(pending[0]!.texts).not.toBe(pending[2]!.texts);
        expect(pending[0]!.signal).not.toBe(pending[2]!.signal);
        pending[2]!.resolve(valid(pending[2]!.texts)); pending[3]!.resolve(valid(pending[3]!.texts));
        await expect(second).resolves.toEqual(valid(origins));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('known unsupported Apertium direction does not promote a mixed pool into grouped native calls', async () => {
        mockConfig.freeTranslationOrder = ['apertiumFree', 'microsoft'];
        unsupportedApertiumMock.mockReturnValue(true);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        const origins = ownerSlots();
        await expect(settle(freeTranslation({origin: origins, sourceLanguage: 'en', targetLanguage: 'zh-Hans'}))).resolves.toEqual(valid(origins));
        expect(extraMock).not.toHaveBeenCalled();
        expect(mockConfig.freeTranslationOrder).toEqual(['apertiumFree', 'microsoft']);
        expect(microsoftMock).toHaveBeenCalledTimes(63);
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it.each([
        {label: 'mixed pool', order: ['microsoft', 'transmart', 'google']},
        {label: 'default full pool', order: undefined},
    ])('$label keeps high-slot inputs on the original scalar candidate path', async ({order}) => {
        mockConfig.freeTranslationOrder = order;
        const configured = order ?? FREE_TRANSLATION_PROVIDERS.map(provider => provider.id);
        microsoftMock.mockImplementation(async (texts: string[]) => valid(texts));
        googleMock.mockImplementation(async (text: string) => `译:${text}`);
        for (const mock of [webMock, chineseMock, extraMock]) mock.mockImplementation(async (_id, text: string) => `译:${text}`);
        myMemoryMock.mockImplementation(async (request: {origin: string}) => `译:${request.origin}`);
        bilibiliMock.mockImplementation(async (request: {origin: string}) => `译:${request.origin}`);
        officialMock.mockImplementation(async (_id, request: {origin: string}) => `译:${request.origin}`);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number}> = [];
        const origins = ownerSlots();
        const request = freeTranslation(attachTranslationRouteObserver({origin: origins, requestTimeoutMs: 20_000}, event => observations.push(event)));
        // native-only 设置不能在 dispatch 后改变已经冻结的混合池执行方式。
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        await expect(settle(request)).resolves.toEqual(valid(origins));
        const submitted = [
            ...microsoftMock.mock.calls.flatMap(call => call[0]),
            ...googleMock.mock.calls.map(call => call[0]),
            ...[webMock, chineseMock, extraMock].flatMap(mock => mock.mock.calls.map(call => call[1])),
            ...myMemoryMock.mock.calls.map(call => call[0].origin),
            ...bilibiliMock.mock.calls.map(call => call[0].origin),
            ...officialMock.mock.calls.map(call => call[1].origin),
        ];
        expect(submitted).toHaveLength(63);
        expect([...submitted].sort()).toEqual([...origins].sort());
        expect(microsoftMock.mock.calls.every(call => call[0].length === 1)).toBe(true);
        expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(observations).toHaveLength(63);
        expect(observations.every(event => configured.includes(event.route) && event.outcome === 'success')).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(1760);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Lara real adapter keeps nine 800ms HTTP calls as separate attempts within the original twenty-second owner budget', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/free-official-web')>('@/src/providers/translation/free-official-web');
        officialMock.mockImplementation(actual.translateOfficialFreeWebProvider);
        Object.assign(mockConfig, {
            freeTranslationOrder: ['laraFree'], freeTranslationMode: 'sequential',
            freeTranslationTimeoutMs: 5_000, freeTranslationCooldownMs: 60_000,
        });
        const origins = Array.from({length: 9}, (_, index) => `This paragraph contains readable English prose for slot ${index}.`);
        const expected = origins.map((_, index) => `第${index}槽中文译文`);
        const started = Date.now();
        const starts: number[] = [];
        const queries: string[] = [];
        let active = 0; let maximum = 0; let aborts = 0;
        const fetchMock = vi.fn<typeof fetch>();
        fetchMock.mockImplementation((url, init) => new Promise<Response>((resolve, reject) => {
            expect(new URL(String(url)).href).toBe('https://webapi.laratranslate.com/translate/segmented');
            expect(init!.credentials).toBe('omit');
            const body = JSON.parse(String(init!.body));
            expect(body).toMatchObject({source: 'en', target: 'zh-CN', content_type: 'text/plain'});
            const index = origins.indexOf(body.q);
            expect(index).toBeGreaterThanOrEqual(0);
            queries.push(body.q); starts.push(Date.now() - started);
            active += 1; maximum = Math.max(maximum, active);
            const signal = init!.signal!;
            const abort = () => { clearTimeout(timer); active -= 1; aborts += 1; reject(signal.reason); };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort); active -= 1;
                resolve(Response.json({status: 200, content: {translations: [{translation: expected[index]}]}}));
            }, 800);
            signal.addEventListener('abort', abort, {once: true});
        }));
        vi.stubGlobal('fetch', fetchMock);
        const {attachTranslationRouteObserver} = await import('@/src/services/translation/requestSnapshot');
        const observations: Array<{route: string; outcome: string; chars: number; durationMs: number}> = [];
        let outcome: unknown;
        const request = freeTranslation(attachTranslationRouteObserver({
            origin: origins, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 20_000,
        }, event => observations.push(event)));
        void request.then(value => {outcome = {value};}, error => {outcome = {error};});
        await vi.advanceTimersByTimeAsync(8_800);
        // 对此前 all-provider 分组生产基线，5000ms 首组超时使这条断言红；不是导出缺失或 mock API 差异。
        expect(outcome).toEqual({value: expected});
        expect(fetchMock).toHaveBeenCalledTimes(9);
        expect(officialMock.mock.calls.map(call => call[1].origin).sort()).toEqual([...origins].sort());
        expect([...queries].sort()).toEqual([...origins].sort());
        expect(starts).toEqual(Array.from({length: 9}, (_, index) => index * 1_000));
        expect(maximum).toBe(1); expect(aborts).toBe(0);
        expect(observations).toHaveLength(9);
        expect(observations.every(event => event.route === 'laraFree' && event.outcome === 'success' && event.durationMs === 800)).toBe(true);
        expect(observations.reduce((sum, event) => sum + event.chars, 0)).toBe(origins.join('').length);
        expect((await getFreeTranslationWeightSnapshot()).entries.find(entry => entry.providerId === 'laraFree')?.status).toBe('ready');
        expect(mockConfig.freeTranslationTimeoutMs).toBe(5_000);
        expect(mockConfig.freeTranslationCooldownMs).toBe(60_000);
        expect(microsoftMock).not.toHaveBeenCalled(); expect(googleOwnerMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
