import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig, microsoftMock, deeplxMock, googleMock, myMemoryMock, apertiumMock} = vi.hoisted(() => ({
    mockConfig: {} as Record<string, any>,
    microsoftMock: vi.fn(),
    deeplxMock: vi.fn(),
    googleMock: vi.fn(),
    myMemoryMock: vi.fn(),
    apertiumMock: vi.fn(),
}));
vi.mock('@/src/services/config/store', () => ({config: mockConfig}));
vi.mock('@/src/providers/translation/microsoft', () => ({translateMicrosoftTexts: microsoftMock}));
vi.mock('@/src/providers/translation/deeplx', () => ({translateDeepLXText: deeplxMock}));
vi.mock('@/src/providers/translation/google', () => ({translateGoogleText: googleMock}));
vi.mock('@/src/providers/translation/mymemory', () => ({default: myMemoryMock}));
vi.mock('@/src/providers/translation/apertium', () => ({default: apertiumMock}));

import type {TranslationConfigSource} from '@/src/services/translation/types';
import {DEFAULT_DEEPLX_ENDPOINT} from '@/src/core/config/deeplx';

let freeTranslation: typeof import('@/src/providers/translation/free-translation').default;
let translateFreeText: typeof import('@/src/providers/translation/free-translation').translateFreeText;
let FREE_TRANSLATION_BATCH_CONCURRENCY: number;
let FREE_TRANSLATION_ORDER: string[];
let attachTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').attachTranslationProviderConfig;
let createTranslationProviderConfigSnapshot: typeof import('@/src/services/translation/requestSnapshot').createTranslationProviderConfigSnapshot;
let getTranslationProviderConfig: typeof import('@/src/services/translation/requestSnapshot').getTranslationProviderConfig;
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const httpFailure = (statusCode = 503) => Object.assign(new Error('private original and token'), {statusCode});
const readSnapshot = (message: object) => getTranslationProviderConfig(message, mockConfig as never);

beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
    Object.assign(mockConfig, {
        service: 'freeTranslation', from: 'auto', to: 'zh-Hans',
        token: {}, proxy: {}, model: {}, customModel: {},
        freeTranslationTimeoutMs: 1_000, freeTranslationCooldownMs: 1_000,
        myMemoryEmail: '', deeplx: 'https://deeplx.example/translate',
    });
    for (const mock of [microsoftMock, deeplxMock, googleMock, myMemoryMock]) {
        mock.mockRejectedValue(httpFailure());
    }
    ({default: freeTranslation, translateFreeText, FREE_TRANSLATION_BATCH_CONCURRENCY, FREE_TRANSLATION_ORDER}
        = await import('@/src/providers/translation/free-translation'));
    ({attachTranslationProviderConfig, createTranslationProviderConfigSnapshot, getTranslationProviderConfig}
        = await import('@/src/services/translation/requestSnapshot'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('免费翻译服务', () => {
    it('保留微软、DeepLX、谷歌优先顺序并新增 MyMemory 官方后备', async () => {
        const calls: string[] = [];
        microsoftMock.mockImplementation(async () => { calls.push('microsoft'); throw httpFailure(); });
        deeplxMock.mockImplementation(async () => { calls.push('deeplx'); throw httpFailure(); });
        googleMock.mockImplementation(async () => { calls.push('google'); throw httpFailure(); });
        myMemoryMock.mockImplementation(async () => { calls.push('myMemory'); return '官方译文'; });
        await expect(translateFreeText('Hello')).resolves.toBe('官方译文');
        expect(calls).toEqual(['microsoft', 'deeplx', 'google', 'myMemory']);
        expect(FREE_TRANSLATION_ORDER).toEqual(['微软翻译', 'DeepLX', '谷歌翻译', 'MyMemory']);
        expect(microsoftMock).toHaveBeenCalledWith(['Hello'], 'auto', 'zh-Hans', expect.any(AbortSignal));
        expect(deeplxMock).toHaveBeenCalledWith('Hello', 'deeplx', expect.objectContaining({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}));
        expect(myMemoryMock).toHaveBeenCalledWith(expect.objectContaining({origin: 'Hello', serviceOverride: 'myMemory', abortSignal: expect.any(AbortSignal)}));
    });

    it('首个服务成功即返回，不会外发给后续服务', async () => {
        microsoftMock.mockResolvedValue(['微软译文']);
        await expect(freeTranslation({origin: 'Hello'})).resolves.toBe('微软译文');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(deeplxMock).not.toHaveBeenCalled();
        expect(myMemoryMock).not.toHaveBeenCalled();
    });

    it('保存顺序里的有 Key 服务全部剔除，仅按所选免密钥服务翻译', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL', 'openai', 'custom:key-provider', 'myMemory', 'microsoft'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx', openai: 'secret-key'};
        myMemoryMock.mockResolvedValue('MyMemory');
        await expect(translateFreeText('Hello')).resolves.toBe('MyMemory');
        expect(microsoftMock).not.toHaveBeenCalled();
        expect(deeplxMock).not.toHaveBeenCalled();
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['myMemory', 'microsoft']);
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).token).toEqual({});
    });

    it('旧设置只保存有 Key 服务时回到匿名默认链，历史 Key 不影响选择', async () => {
        mockConfig.freeTranslationOrder = ['azureTranslator', 'deepL'];
        mockConfig.token = {azureTranslator: 'configured-key', deepL: 'free-key:fx'};
        myMemoryMock.mockResolvedValue('备用');
        await expect(translateFreeText('Hello')).resolves.toBe('备用');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).freeTranslationOrder).toEqual(['microsoft', 'deeplx', 'google', 'myMemory']);
    });

    it('上游挂起时局部超时继续降级，下一段跳过正在冷却的上游', async () => {
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        deeplxMock.mockResolvedValue('备用');
        const first = translateFreeText('Hello');
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(first).resolves.toBe('备用');
        await expect(translateFreeText('World')).resolves.toBe('备用');
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(microsoftMock.mock.calls[0][3].aborted).toBe(true);
    });

    it('返回空译文时继续降级，全部失败只汇总安全原因', async () => {
        microsoftMock.mockResolvedValue(['']);
        googleMock.mockRejectedValue(httpFailure(429));
        const request = translateFreeText('private source text');
        await expect(request).rejects.toThrow('微软翻译: 未返回有效译文；DeepLX: HTTP 503；谷歌翻译: HTTP 429；MyMemory: HTTP 503');
        await expect(request).rejects.not.toThrow('private');
    });

    it('请求启动后修改全局顺序、语言、凭据和端点不影响在途降级', async () => {
        let rejectFirst!: (error: Error) => void;
        microsoftMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
        deeplxMock.mockResolvedValue('原配置译文');
        mockConfig.token.deeplx = 'original-key';
        mockConfig.freeTranslationOrder = ['microsoft', 'deeplx'];
        const request = translateFreeText('Hello');
        await flush();
        mockConfig.token.deeplx = 'new-key';
        mockConfig.deeplx = 'https://new.example/translate';
        mockConfig.from = 'ja';
        mockConfig.to = 'fr';
        mockConfig.freeTranslationOrder.splice(0, 2, 'google');
        rejectFirst(httpFailure());
        await expect(request).resolves.toBe('原配置译文');
        const fallbackRequest = deeplxMock.mock.calls[0][2];
        expect(fallbackRequest).toMatchObject({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'});
        expect(readSnapshot(fallbackRequest)).toMatchObject({
            token: {}, proxy: {}, deeplx: DEFAULT_DEEPLX_ENDPOINT,
            freeTranslationOrder: ['microsoft', 'deeplx'],
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
        await expect(freeTranslation(message)).resolves.toBe('冻结译文');
        expect(readSnapshot(myMemoryMock.mock.calls[0][0]).myMemoryEmail).toBe('old@example.com');
        expect(myMemoryMock.mock.calls[0][0].targetLanguage).toBe('ja');
        expect(googleMock).not.toHaveBeenCalled();
    });

    it('被官方接口忽略的残留 proxy 不影响配额冷却身份', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        googleMock.mockResolvedValue('备用');
        myMemoryMock.mockRejectedValue(httpFailure(429));
        await expect(translateFreeText('one')).resolves.toBe('备用');
        mockConfig.proxy.myMemory = 'https://other.example/memory';
        await expect(translateFreeText('two')).resolves.toBe('备用');
        expect(myMemoryMock).toHaveBeenCalledOnce();
    });

    it('更换 MyMemory 邮箱不继承旧匿名/邮箱额度冷却', async () => {
        mockConfig.freeTranslationOrder = ['myMemory', 'google'];
        myMemoryMock.mockRejectedValueOnce(httpFailure(429)).mockResolvedValue('新邮箱译文');
        googleMock.mockResolvedValue('备用');
        await expect(translateFreeText('one')).resolves.toBe('备用');
        mockConfig.myMemoryEmail = 'new@example.com';
        await expect(translateFreeText('two')).resolves.toBe('新邮箱译文');
        expect(myMemoryMock).toHaveBeenCalledTimes(2);
    });

    it.each(['token', 'endpoint', 'proxy'])('更换独立 DeepLX 的%s 不改变免费链的匿名连接或冷却状态', async changed => {
        mockConfig.freeTranslationOrder = ['deeplx', 'google'];
        mockConfig.token.deeplx = 'old-key';
        deeplxMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(translateFreeText('one')).resolves.toBe('备用');
        await expect(translateFreeText('two')).resolves.toBe('备用');
        if (changed === 'token') mockConfig.token.deeplx = 'new-key';
        else if (changed === 'endpoint') mockConfig.deeplx = 'https://new.example/translate';
        else mockConfig.proxy.deeplx = 'https://proxy.example/translate';
        await expect(translateFreeText('three')).resolves.toBe('备用');
        expect(deeplxMock).toHaveBeenCalledOnce();
    });

    it('已保存的 DeepLX 代理及默认地址都不会绕过匿名公共接口的冷却', async () => {
        mockConfig.freeTranslationOrder = ['deeplx', 'google'];
        mockConfig.proxy.deeplx = 'https://active.example/translate';
        deeplxMock.mockRejectedValue(httpFailure(429));
        googleMock.mockResolvedValue('备用');
        await expect(translateFreeText('one')).resolves.toBe('备用');
        mockConfig.deeplx = 'https://unused.example/translate';
        await expect(translateFreeText('two')).resolves.toBe('备用');
        expect(deeplxMock).toHaveBeenCalledOnce();
    });

    it.each([
        ['direct', 'single'], ['direct', 'batch'], ['broker', 'single'], ['broker', 'batch'],
    ])('%s入口的%s翻译真实请求只访问匿名 DeepLX，历史凭据与代理完全隔离', async (entrypoint, mode) => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/deeplx')>('@/src/providers/translation/deeplx');
        deeplxMock.mockImplementation(actual.translateDeepLXText);
        mockConfig.freeTranslationOrder = ['deeplx'];
        mockConfig.deeplx = 'https://private.example/{{apiKey}}/translate';
        mockConfig.proxy = {deeplx: 'https://proxy.example/translate?token=proxy-secret'};
        mockConfig.token = {deeplx: 'deeplx-secret', deepL: 'deepl-secret:fx', azureTranslator: 'azure-secret'};
        mockConfig.youdaoAppSecret = 'youdao-secret';
        mockConfig.tencentSecretKey = 'tencent-secret';
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({code: 200, data: `译:${JSON.parse(String(init?.body)).text}`}),
        } as Response));
        vi.stubGlobal('fetch', fetchMock);
        const origin = mode === 'batch' ? ['Hello', 'World'] : 'Hello';
        const message = {origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans'};
        const request = entrypoint === 'broker'
            ? attachTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(mockConfig as TranslationConfigSource))
            : message;
        await expect(freeTranslation(request)).resolves.toEqual(mode === 'batch' ? ['译:Hello', '译:World'] : '译:Hello');
        expect(fetchMock).toHaveBeenCalledTimes(mode === 'batch' ? 2 : 1);
        for (const [url, init] of fetchMock.mock.calls) {
            expect(url).toBe(DEFAULT_DEEPLX_ENDPOINT);
            expect(init?.headers).toEqual({'Content-Type': 'application/json'});
            expect(JSON.stringify([url, init?.headers, init?.body])).not.toMatch(/secret|private\.example|proxy\.example/u);
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        }
        const local = readSnapshot(deeplxMock.mock.calls[0][2]);
        expect(local).toMatchObject({token: {}, proxy: {}, deeplx: DEFAULT_DEEPLX_ENDPOINT, youdaoAppSecret: '', tencentSecretKey: ''});
        expect(Object.isFrozen(local.token)).toBe(true);
        expect(mockConfig.token.deeplx).toBe('deeplx-secret');
        expect(mockConfig.proxy.deeplx).toBe('https://proxy.example/translate?token=proxy-secret');
        expect(mockConfig.deeplx).toBe('https://private.example/{{apiKey}}/translate');
    });

    it('匿名网络失败的错误仍不泄漏历史凭据、代理地址或原文', async () => {
        const actual = await vi.importActual<typeof import('@/src/providers/translation/deeplx')>('@/src/providers/translation/deeplx');
        deeplxMock.mockImplementation(actual.translateDeepLXText);
        mockConfig.freeTranslationOrder = ['deeplx'];
        mockConfig.token.deeplx = 'stored-secret';
        mockConfig.proxy.deeplx = 'https://private.example/stored-secret';
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private original https://private.example/stored-secret')));
        const request = translateFreeText('private original');
        await expect(request).rejects.toThrow('DeepLX: 请求失败');
        await expect(request).rejects.not.toThrow('stored-secret');
        await expect(request).rejects.not.toThrow('private.example');
        await expect(request).rejects.not.toThrow('private original');
    });

    it('批量并发最多三条且乱序完成后保留输入顺序', async () => {
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
        expect(pending).toHaveLength(FREE_TRANSLATION_BATCH_CONCURRENCY);
        pending[2].resolve(['译:C']);
        pending[0].resolve(['译:A']);
        pending[1].resolve(['译:B']);
        await flush();
        expect(pending).toHaveLength(6);
        pending[5].resolve(['译:F']);
        pending[3].resolve(['译:D']);
        pending[4].resolve(['译:E']);
        await expect(request).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E', '译:F']);
        expect(maximum).toBe(3);
    });

    it('批量各段共享配置和上层截止时间，预算耗尽不启动后续段', async () => {
        const pending: Array<(value: string[]) => void> = [];
        microsoftMock.mockImplementation(() => new Promise<string[]>(resolve => { pending.push(resolve); }));
        const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E'], requestTimeoutMs: 500});
        const assertion = expect(request).rejects.toThrow('请求超时');
        await flush();
        await vi.advanceTimersByTimeAsync(300);
        pending[0](['译:A']);
        await flush();
        expect(microsoftMock).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(200);
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(4);
        expect(deeplxMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('批量遇限流后后续段跳过失败服务，保序翻译', async () => {
        microsoftMock.mockRejectedValue(httpFailure(429));
        deeplxMock.mockImplementation(async (text: string) => `译:${text}`);
        await expect(freeTranslation({origin: ['A', 'B', 'C', 'D', 'E']})).resolves.toEqual(['译:A', '译:B', '译:C', '译:D', '译:E']);
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(deeplxMock).toHaveBeenCalledTimes(5);
    });

    it('调用方取消中止所有在途 worker，不启动未领取段落、不继续降级', async () => {
        const controller = new AbortController();
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        const request = freeTranslation({origin: ['A', 'B', 'C', 'D', 'E'], abortSignal: controller.signal});
        const assertion = expect(request).rejects.toThrow('用户取消');
        await flush();
        controller.abort(new Error('用户取消'));
        await assertion;
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(microsoftMock.mock.calls.every(call => call[3].aborted)).toBe(true);
        expect(deeplxMock).not.toHaveBeenCalled();
        microsoftMock.mockResolvedValue(['恢复']);
        await expect(translateFreeText('next')).resolves.toBe('恢复');
    });

    it('任一文本耗尽所有备用后取消 sibling，避免余下请求继续外发', async () => {
        microsoftMock.mockImplementation(([text]: [string]) => text === 'bad' ? Promise.reject(httpFailure()) : new Promise(() => {}));
        await expect(freeTranslation({origin: ['bad', 'slow-1', 'slow-2', 'not-started']})).rejects.toThrow('免费翻译服务均不可用');
        expect(microsoftMock).toHaveBeenCalledTimes(3);
        expect(microsoftMock.mock.calls.slice(1).every(call => call[3].aborted)).toBe(true);
        expect(deeplxMock).toHaveBeenCalledOnce();
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
        deeplxMock.mockResolvedValue('译文');
        await expect(translateFreeText('Hello', languages)).resolves.toBe('译文');
        expect(deeplxMock.mock.calls[0][2]).toMatchObject(languages);
    });

    it('空批量直接返回并拒绝非文本输入', async () => {
        await expect(freeTranslation({origin: []})).resolves.toEqual([]);
        await expect(translateFreeText(42 as unknown as string)).rejects.toThrow('仅支持文本输入');
        await expect(freeTranslation({origin: 42 as unknown as string})).rejects.toThrow('仅支持文本输入');
        expect(microsoftMock).not.toHaveBeenCalled();
    });
});

it('uses explicitly enabled Apertium then falls back for unsupported language pairs', async () => {
    mockConfig.freeTranslationOrder = ['apertium', 'google'];
    apertiumMock.mockRejectedValue(httpFailure(400));
    googleMock.mockResolvedValue('译文');
    await expect(translateFreeText('Hello')).resolves.toBe('译文');
    const request = apertiumMock.mock.calls[0]![0];
    expect(request.serviceOverride).toBe('apertium');
    expect(readSnapshot(request).token).toEqual({});
    expect(readSnapshot(request).proxy).toEqual({});
    apertiumMock.mockResolvedValue('Hola');
    await expect(translateFreeText('Hello again')).resolves.toBe('Hola');
});
