import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig} = vi.hoisted(() => ({
    mockConfig: {
        from: 'auto',
        to: 'zh-Hans',
        service: 'deepL',
        deeplApiPlan: undefined as 'free' | 'pro' | undefined,
        nativeBatchTranslationEnabled: {} as Record<string, boolean>,
        proxy: {} as Record<string, string>,
        token: {} as Record<string, string>,
    },
}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import deepl from '@/src/providers/translation/deepl';
import {Config} from '@/src/core/config/model';
import {
    DEFAULT_DEEPL_API_PLAN,
    DEEPL_API_ENDPOINTS,
    getDeepLEndpoint,
    normalizeDeepLApiPlan,
} from '@/src/core/config/deepl';
import {
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({translations: [{text: '你好'}]})));
    Object.assign(mockConfig, {
        service: 'deepL', from: 'auto', to: 'zh-Hans', deeplApiPlan: undefined,
        proxy: {}, token: {deepL: 'test-key'}, nativeBatchTranslationEnabled: {},
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('DeepL API 套餐配置', () => {
    it('使用官方 Free / Pro 地址，并让缺失与无效旧值保持 Free', () => {
        expect(DEFAULT_DEEPL_API_PLAN).toBe('free');
        expect(Object.isFrozen(DEEPL_API_ENDPOINTS)).toBe(true);
        expect(normalizeDeepLApiPlan('pro')).toBe('pro');
        expect(getDeepLEndpoint('pro')).toBe('https://api.deepl.com/v2/translate');
        for (const value of ['free', undefined, null, '', 'PRO', 'paid', 1, {}, []]) {
            expect(normalizeDeepLApiPlan(value)).toBe('free');
            expect(getDeepLEndpoint(value)).toBe('https://api-free.deepl.com/v2/translate');
        }
    });

    it('去掉代理外围空白，无效或空白代理回到所选官方端点', () => {
        expect(getDeepLEndpoint('free', '  https://proxy.example/translate  '))
            .toBe('https://proxy.example/translate');
        for (const proxy of [undefined, null, '', '  ', 1, {}, []]) {
            expect(getDeepLEndpoint('pro', proxy)).toBe(DEEPL_API_ENDPOINTS.pro);
        }
    });
});

describe('DeepL adapter', () => {
    it.each([
        [undefined, 'https://api-free.deepl.com/v2/translate'],
        ['free', 'https://api-free.deepl.com/v2/translate'],
        ['pro', 'https://api.deepl.com/v2/translate'],
    ] as const)('按所选套餐 %s 发送到正确端点并保留 API 鉴权和上下文', async (plan, endpoint) => {
        mockConfig.deeplApiPlan = plan;
        const controller = new AbortController();

        await expect(deepl({origin: 'Hello', context: 'Article title', abortSignal: controller.signal}))
            .resolves.toBe('你好');

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init).toMatchObject({method: 'POST', signal: controller.signal});
        expect(init?.headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: 'DeepL-Auth-Key test-key',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
            text: ['Hello'], target_lang: 'ZH-HANS',
            context: 'Article title', preserve_formatting: true,
        });
    });

    it.each(['free', 'pro'] as const)('自定义代理优先于 %s 套餐的官方端点', async (plan) => {
        mockConfig.deeplApiPlan = plan;
        mockConfig.proxy.deepL = '  https://proxy.example/translate  ';
        await deepl({origin: 'Hello'});
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://proxy.example/translate');
    });

    it('空白代理仍使用所选 Pro 官方端点', async () => {
        mockConfig.deeplApiPlan = 'pro';
        mockConfig.proxy.deepL = '  ';
        await deepl({origin: 'Hello'});
        expect(fetchMock.mock.calls[0]?.[0]).toBe(DEEPL_API_ENDPOINTS.pro);
    });

    it('服务覆盖和已冻结套餐不受全局设置后续修改影响', async () => {
        const source = Object.assign(new Config(), {
            service: 'microsoft', deeplApiPlan: 'free', token: {deepL: 'frozen-key'},
        });
        const request = attachTranslationProviderConfig({
            origin: 'Hello', serviceOverride: 'deepL', targetLanguage: 'de',
        }, createTranslationProviderConfigSnapshot(source));
        source.deeplApiPlan = 'pro';
        source.token.deepL = 'new-key';
        mockConfig.deeplApiPlan = 'pro';
        mockConfig.token.deepL = 'global-key';
        mockConfig.proxy.deepL = 'https://new-proxy.example/translate';

        await deepl(request);

        expect(fetchMock.mock.calls[0]?.[0]).toBe(DEEPL_API_ENDPOINTS.free);
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
            Authorization: 'DeepL-Auth-Key frozen-key',
        });
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).target_lang).toBe('DE');
    });

    it('付费 API 的 HTTP 错误沿用既有错误处理', async () => {
        mockConfig.deeplApiPlan = 'pro';
        fetchMock.mockResolvedValue(new Response('Forbidden', {status: 403}));

        await expect(deepl({origin: 'Hello'})).rejects.toThrow('403');
    });
});

describe('DeepL 中文源和目标的协议边界', () => {
    it.each([
        ['en', 'zh-Hans', 'EN', 'ZH-HANS'],
        ['en', 'zh-TW', 'EN', 'ZH-HANT'],
        ['zh-Hant', 'zh-Hans', 'ZH', 'ZH-HANS'],
        ['zh-Hans', 'zh-Hant', 'ZH', 'ZH-HANT'],
        ['zh-Hant', 'en', 'ZH', 'EN'],
    ])('%s → %s 将目标脚本传给 DeepL 并保留有效源参数', async (sourceLanguage, targetLanguage, source, target) => {
        await deepl({origin: '測試 test', sourceLanguage, targetLanguage});
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({source_lang: source, target_lang: target});
    });
});

describe('DeepL 扩展语言协议', () => {
    it.each(['de', 'pt', 'it', 'ar', 'hi', 'bn', 'ur', 'fa', 'he', 'tr', 'vi', 'th', 'id', 'ms', 'nl', 'pl', 'uk', 'cs', 'sk', 'da', 'sv', 'nb', 'fi', 'el', 'ro', 'hu', 'bg', 'hr', 'sr', 'sl', 'et', 'lv', 'lt', 'ta', 'te', 'mr', 'gu', 'ml', 'pa', 'ne', 'sw', 'fil'])('按官方代码发送 %s，纯文本标签不启用 HTML 解析或废弃 beta 参数', async language => {
        await deepl({origin: '<b>Hello</b>', sourceLanguage: language, targetLanguage: language});
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        const code = language === 'fil' ? 'TL' : language.toUpperCase();
        expect(body).toMatchObject({source_lang: code, target_lang: code, text: ['<b>Hello</b>']});
        expect(body).not.toHaveProperty('tag_handling');
        expect(body).not.toHaveProperty('enable_beta_languages');
        expect(mockConfig.to).toBe('zh-Hans');
    });
    it.each(['kn', 'si'])('不支持的 %s 在源语言或目标语言中均明确失败且不发送请求', async language => {
        await expect(deepl({origin: 'Hello', sourceLanguage: 'en', targetLanguage: language})).rejects.toThrow('请选择其他翻译服务');
        await expect(deepl({origin: 'Hello', sourceLanguage: language, targetLanguage: 'en'})).rejects.toThrow('请选择其他翻译服务');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockConfig.to).toBe('zh-Hans');
    });
});

describe('DeepL 原生数组的源槽对应', () => {
    it('关闭合批后数组逐条 HTTP；冻结 true 覆盖仍使用原生数组', async () => {
        mockConfig.nativeBatchTranslationEnabled.deepL = false;
        fetchMock.mockImplementation(async (_url, init) => Response.json({translations:
            JSON.parse(String(init?.body)).text.map((source: string) => ({text: `译:${source}`}))}));
        await expect(deepl({origin: ['first', '', 'second']})).resolves.toEqual(['译:first', '', '译:second']);
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text)).toEqual([['first'], ['second']]);
        fetchMock.mockClear();
        await expect(deepl({origin: ['first', 'second'], enableNativeBatch: true})).resolves.toEqual(['译:first', '译:second']);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('一次 HTTP 保留重复槽、字面 HTML、换行及本地空白，不拼结构标记', async () => {
        const origins = ['<b>Hello & &lt;</b>\nNext', 'same', '', ' \r\n', 'same'];
        fetchMock.mockResolvedValue(new Response(JSON.stringify({translations: [
            {text: '<b>你好 & &lt;</b>\n下一行'}, {text: '重复槽一'}, {text: '重复槽二'},
        ]})));
        await expect(deepl({origin: origins})).resolves.toEqual([
            '<b>你好 & &lt;</b>\n下一行', '重复槽一', '', ' \r\n', '重复槽二',
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        expect(body.text).toEqual([origins[0], 'same', 'same']);
        expect(body).not.toHaveProperty('tag_handling');
    });

    it.each([
        {translations: []}, {translations: [{text: '一'}]},
        {translations: [{text: '一'}, {text: '二'}, {text: '多余'}]},
        {translations: [{text: '一'}, {text: 9}]},
        {translations: [{text: '一'}, {text: ' \n'}]}, {}, null,
    ])('异常响应 %j 显式拒绝整批且不自行重试', async result => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
        await expect(deepl({origin: ['first', 'second']})).rejects.toMatchObject({
            kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false,
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('空数组或纯空白文本只在本地返回', async () => {
        await expect(deepl({origin: []})).resolves.toEqual([]);
        await expect(deepl({origin: [' ', '', '\r\n']})).resolves.toEqual([' ', '', '\r\n']);
        await expect(deepl({origin: ' \n'})).resolves.toBe(' \n');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
