import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash, createHmac} from 'node:crypto';

const {config} = vi.hoisted(() => ({config: {} as Record<string, any>}));
vi.mock('@/src/services/config/store', () => ({config}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {id: 'test', getURL: (path: string) => path}}}));

import {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {
    canonicalQueryString,
    hmacSha1,
    hmacSha256,
    md5Hex,
    percentEncode,
    sha256Hex,
    toBase64,
    toHex,
} from '@/src/providers/translation/cloud/signature';
import {CLOUD_LANGUAGE_MAPS, resolveCloudLanguages} from '@/src/providers/translation/cloud/languages';
import googleCloudTranslation, {GOOGLE_CLOUD_TRANSLATION_URL} from '@/src/providers/translation/google-cloud-translation';
import azureTranslator from '@/src/providers/translation/azure-translator';
import aliyunTranslation, {buildAliyunSignedForm} from '@/src/providers/translation/aliyun-translation';
import baiduTranslation, {buildBaiduSignedForm} from '@/src/providers/translation/baidu-translation';
import volcTranslation, {buildVolcAuthorization} from '@/src/providers/translation/volc-translation';
import {translationProviderRegistry} from '@/src/providers/translation/registry';

const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
// 每次调用都要新建 Response，同一个 body 只能读取一次。
const respond = (value: unknown, init?: ResponseInit) => fetchMock.mockImplementation(async () => json(value, init));
const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    return {url: String(url), init: init!, headers: new Headers(init?.headers), body: String(init?.body ?? '')};
};

beforeEach(() => {
    Object.assign(config, new Config(), {
        from: 'auto', to: 'zh-Hans',
        token: {
            [services.googleCloudTranslation]: 'gcp-key',
            [services.azureTranslator]: 'azure-key',
            [services.aliyunTranslation]: 'ali-ak',
            [services.baiduTranslation]: 'baidu-app',
            [services.volcTranslation]: 'volc-ak',
        },
        secret: {
            [services.aliyunTranslation]: 'ali-sk',
            [services.baiduTranslation]: 'baidu-key',
            [services.volcTranslation]: 'volc-sk',
        },
        serviceRegion: {},
    });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('云服务厂商签名原语', () => {
    it('MD5 与 Node 实现一致，覆盖填充边界与多字节文本', () => {
        for (const input of ['', 'a', 'abc', '你好，世界', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), '2024appid翻译测试salt密钥']) {
            expect(md5Hex(input), JSON.stringify(input.slice(0, 12))).toBe(createHash('md5').update(input, 'utf8').digest('hex'));
        }
    });

    it('HMAC/SHA-256/Base64 与 Node 实现一致，并支持派生密钥链', async () => {
        expect(toHex(await hmacSha256('secret', 'message'))).toBe(createHmac('sha256', 'secret').update('message').digest('hex'));
        expect(toBase64(await hmacSha1('secret&', 'POST&%2F&x'))).toBe(createHmac('sha1', 'secret&').update('POST&%2F&x').digest('base64'));
        expect(await sha256Hex('{"a":1}')).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
        const kDate = await hmacSha256('sk', '20260912');
        const chained = toHex(await hmacSha256(kDate, 'cn-north-1'));
        const expectedKDate = createHmac('sha256', 'sk').update('20260912').digest();
        expect(chained).toBe(createHmac('sha256', expectedKDate).update('cn-north-1').digest('hex'));
    });

    it('百分号编码遵循 RFC 3986，规范查询串按键排序', () => {
        expect(percentEncode("a b!'()*~/")).toBe('a%20b%21%27%28%29%2A~%2F');
        expect(canonicalQueryString({b: '2', a: '1 1', Empty: ''})).toBe('Empty=&a=1%201&b=2');
    });
});

describe('云服务厂商语言映射', () => {
    it('把统一语言映射为厂商代码，自动检测按厂商约定处理', () => {
        expect(resolveCloudLanguages('googleCloudTranslation', 'auto', 'zh-CN')).toEqual({source: undefined, target: 'zh-CN'});
        expect(resolveCloudLanguages('googleCloudTranslation', 'en', 'zh-TW')).toEqual({source: 'en', target: 'zh-TW'});
        expect(resolveCloudLanguages('azureTranslator', '', 'zh-Hant')).toEqual({source: undefined, target: 'zh-Hant'});
        expect(resolveCloudLanguages('aliyunTranslation', 'auto', 'zh-hant')).toEqual({source: 'auto', target: 'zh-tw'});
        expect(resolveCloudLanguages('baiduTranslation', 'ja', 'zh')).toEqual({source: 'jp', target: 'zh'});
        expect(resolveCloudLanguages('baiduTranslation', 'fr', 'ko')).toEqual({source: 'fra', target: 'kor'});
        expect(resolveCloudLanguages('volcTranslation', 'zh-HK', 'en')).toEqual({source: 'zh-Hant', target: 'en'});
        expect(resolveCloudLanguages('volcTranslation', 'sw', 'xx')).toEqual({source: 'sw', target: 'xx'});
        for (const vendor of Object.keys(CLOUD_LANGUAGE_MAPS) as Array<keyof typeof CLOUD_LANGUAGE_MAPS>) {
            expect(() => resolveCloudLanguages(vendor, 'en', 'auto')).toThrow(/不支持目标语言自动检测/u);
            expect(() => resolveCloudLanguages(vendor, 'en', ' ')).toThrow(CLOUD_LANGUAGE_MAPS[vendor].label);
        }
    });
});

describe('注册表', () => {
    it('五个新云厂商与腾讯云都通过 registry 暴露', () => {
        for (const service of [services.tencent, services.googleCloudTranslation, services.azureTranslator, services.aliyunTranslation, services.baiduTranslation, services.volcTranslation]) {
            expect(translationProviderRegistry[service], service).toBeTypeOf('function');
        }
        expect(translationProviderRegistry[services.googleCloudTranslation]).toBe(googleCloudTranslation);
        expect(translationProviderRegistry[services.volcTranslation]).toBe(volcTranslation);
    });
});

describe('谷歌云翻译', () => {
    it('密钥走请求头而非 URL，自动检测时省略 source', async () => {
        respond({data: {translations: [{translatedText: '你好'}]}});
        await expect(googleCloudTranslation({origin: 'Hello'})).resolves.toBe('你好');
        const {url, headers, body} = lastCall();
        expect(url).toBe(GOOGLE_CLOUD_TRANSLATION_URL);
        expect(url).not.toContain('gcp-key');
        expect(headers.get('x-goog-api-key')).toBe('gcp-key');
        expect(JSON.parse(body)).toEqual({q: ['Hello'], target: 'zh-CN', format: 'text'});
    });

    it('显式源语言与错误路径', async () => {
        respond({data: {translations: [{translatedText: 'ok'}]}});
        await googleCloudTranslation({origin: 'x', sourceLanguage: 'ja', targetLanguage: 'en'});
        expect(JSON.parse(lastCall().body)).toMatchObject({source: 'ja', target: 'en'});

        config.token[services.googleCloudTranslation] = ' ';
        await expect(googleCloudTranslation({origin: 'x'})).rejects.toThrow(/API Key/u);
        config.token[services.googleCloudTranslation] = 'gcp-key';

        fetchMock.mockResolvedValue(new Response('denied', {status: 403}));
        await expect(googleCloudTranslation({origin: 'x'})).rejects.toMatchObject({message: '谷歌云翻译请求失败: 403', statusCode: 403});
        respond({error: {code: 400, message: 'secret payload'}}, {status: 200});
        await expect(googleCloudTranslation({origin: 'x'})).rejects.toThrow('谷歌云翻译错误（错误码 400）');
        respond({data: {translations: []}});
        await expect(googleCloudTranslation({origin: 'x'})).rejects.toThrow('谷歌云翻译返回格式异常');
        fetchMock.mockResolvedValue(new Response('not json'));
        await expect(googleCloudTranslation({origin: 'x'})).rejects.toThrow('谷歌云翻译返回的不是有效 JSON');
    });
});

describe('Azure 翻译', () => {
    it('全球资源不发区域头，区域资源附带 Ocp-Apim-Subscription-Region', async () => {
        respond([{translations: [{text: '你好', to: 'zh-Hans'}]}]);
        await expect(azureTranslator({origin: 'Hello'})).resolves.toBe('你好');
        let call = lastCall();
        let url = new URL(call.url);
        expect(url.origin + url.pathname).toBe('https://api.cognitive.microsofttranslator.com/translate');
        expect(url.searchParams.get('api-version')).toBe('3.0');
        expect(url.searchParams.get('to')).toBe('zh-Hans');
        expect(url.searchParams.get('from')).toBeNull();
        expect(call.headers.get('Ocp-Apim-Subscription-Key')).toBe('azure-key');
        expect(call.headers.has('Ocp-Apim-Subscription-Region')).toBe(false);
        expect(JSON.parse(call.body)).toEqual([{Text: 'Hello'}]);

        config.serviceRegion[services.azureTranslator] = 'eastasia';
        await azureTranslator({origin: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-TW'});
        call = lastCall();
        url = new URL(call.url);
        expect(call.headers.get('Ocp-Apim-Subscription-Region')).toBe('eastasia');
        expect(url.searchParams.get('from')).toBe('en');
        expect(url.searchParams.get('to')).toBe('zh-Hant');

        config.serviceRegion[services.azureTranslator] = 'japanwest';
        await azureTranslator({origin: 'Hello'});
        expect(lastCall().headers.get('Ocp-Apim-Subscription-Region')).toBe('japanwest');

        config.serviceRegion[services.azureTranslator] = 'not-a-region';
        await azureTranslator({origin: 'Hello'});
        expect(lastCall().headers.has('Ocp-Apim-Subscription-Region')).toBe(false);
    });

    it('错误路径', async () => {
        config.token[services.azureTranslator] = '';
        await expect(azureTranslator({origin: 'x'})).rejects.toThrow(/密钥/u);
        config.token[services.azureTranslator] = 'azure-key';
        fetchMock.mockResolvedValue(new Response('', {status: 401}));
        await expect(azureTranslator({origin: 'x'})).rejects.toMatchObject({statusCode: 401});
        respond({error: {code: 401000, message: 'leak'}});
        await expect(azureTranslator({origin: 'x'})).rejects.toThrow('Azure 翻译错误（错误码 401000）');
        respond({});
        await expect(azureTranslator({origin: 'x'})).rejects.toMatchObject({kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        respond([{translations: []}]);
        await expect(azureTranslator({origin: 'x'})).rejects.toThrow('Azure 翻译返回格式异常');
        for (const translations of [{0: {text: '译文'}}, [{text: '译文'}, {text: '多余'}]]) {
            respond([{translations}]);
            await expect(azureTranslator({origin: 'x'})).rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        }
        respond([]);
        await expect(azureTranslator({origin: 'x'})).rejects.toThrow('Azure 翻译返回格式异常');
    });
});

const nativeCloudProviders = [
    {label: 'Google Cloud', translate: googleCloudTranslation,
        bodySources: (body: any) => body.q,
        success: (texts: unknown[]) => ({data: {translations: texts.map(translatedText => ({translatedText}))}})},
    {label: 'Azure', translate: azureTranslator,
        bodySources: (body: any) => body.map((item: any) => item.Text),
        success: (texts: unknown[]) => texts.map(text => ({translations: [{text}]}))},
] as const;

describe.each(nativeCloudProviders)('$label 原生数组完整性', ({translate, bodySources, success}) => {
    it('一次请求保留重复源槽、字面 HTML 与内部换行，空白槽不上传', async () => {
        const origins = ['<b>Hello & &lt;</b>\nNext', 'duplicate', '', ' \r\n', 'duplicate'];
        respond(success(['<b>你好 & &lt;</b>\n下一行', '重复一', '重复二']));
        await expect(translate({origin: origins})).resolves.toEqual([
            '<b>你好 & &lt;</b>\n下一行', '重复一', '', ' \r\n', '重复二',
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(bodySources(JSON.parse(lastCall().body))).toEqual([origins[0], 'duplicate', 'duplicate']);
        const url = new URL(lastCall().url);
        if (url.hostname === 'api.cognitive.microsofttranslator.com') expect(url.searchParams.get('textType')).toBe('plain');
        else expect(JSON.parse(lastCall().body).format).toBe('text');
    });

    it.each([[], ['一'], ['一', '二', '额外'], ['一', undefined], ['一', 7], ['一', ' \n'], ['一', '\u200b']].map(translations => ({translations})))(
        '异常结果 $translations 拒绝整批且不在 provider 内重试', async ({translations}) => {
            respond(success(translations));
            await expect(translate({origin: ['first', 'second']})).rejects.toMatchObject({
                kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false,
            });
            expect(fetchMock).toHaveBeenCalledOnce();
        },
    );

    it('按条数和字符数分包，后包缺项则整个调用失败', async () => {
        const origins = Array.from({length: 33}, (_, index) => `source ${index}`);
        fetchMock.mockImplementation(async (_url, init) => json(success(bodySources(JSON.parse(String(init?.body))).map((text: string) => `译:${text}`))));
        await expect(translate({origin: origins})).resolves.toEqual(origins.map(text => `译:${text}`));
        expect(fetchMock.mock.calls.map(([, init]) => bodySources(JSON.parse(String(init?.body))).length)).toEqual([32, 1]);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(json(success(Array.from({length: 32}, () => '译文')))).mockResolvedValueOnce(json(success([])));
        await expect(translate({origin: origins})).rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        expect(fetchMock).toHaveBeenCalledTimes(2);
        fetchMock.mockClear();
        fetchMock.mockImplementation(async (_url, init) => json(success(bodySources(JSON.parse(String(init?.body))).map(() => '译文'))));
        await expect(translate({origin: ['a'.repeat(2_001), 'b'.repeat(2_000)]})).resolves.toEqual(['译文', '译文']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('空白数组本地返回，取消后不启动请求或后续分包', async () => {
        await expect(translate({origin: ['', ' \n', '\u200b']})).resolves.toEqual(['', ' \n', '\u200b']);
        await expect(translate({origin: []})).resolves.toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(translate({origin: ['source'], abortSignal: cancelled.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).not.toHaveBeenCalled();
        const active = new AbortController();
        fetchMock.mockImplementation(async () => { active.abort(); return json(success(Array.from({length: 32}, () => '译文'))); });
        await expect(translate({origin: Array.from({length: 33}, () => 'source'), abortSignal: active.signal}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('成功 HTTP 的损坏 JSON 属于可识别的响应结构错误', async () => {
        fetchMock.mockResolvedValue(new Response('not json'));
        await expect(translate({origin: ['first', 'second']})).rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('HTTP200读取中断不会被归为可拆批的结构错误', async () => {
        fetchMock.mockResolvedValue({ok: true, json: async () => {throw new TypeError('private response');}} as unknown as Response);
        await expect(translate({origin: ['first', 'second']})).rejects.toMatchObject({message: '翻译响应读取失败'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('阿里云机器翻译', () => {
    it('RPC 1.0 签名与官方算法一致', async () => {
        const form = await buildAliyunSignedForm({
            accessKeyId: 'ak', accessKeySecret: 'sk',
            parameters: {Action: 'TranslateGeneral', SourceText: 'Hello world!', SourceLanguage: 'auto', TargetLanguage: 'zh', FormatType: 'text', Scene: 'general'},
            now: new Date('2026-09-12T08:09:10.123Z'), nonce: 'fixed-nonce',
        });
        expect(form).toMatchObject({Format: 'JSON', Version: '2018-10-12', AccessKeyId: 'ak', SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: 'fixed-nonce', Timestamp: '2026-09-12T08:09:10Z'});
        const {Signature, ...rest} = form;
        const query = Object.keys(rest).sort().map((key) => `${percentEncode(key)}=${percentEncode(rest[key]!)}`).join('&');
        const stringToSign = `POST&%2F&${percentEncode(query)}`;
        expect(Signature).toBe(createHmac('sha1', 'sk&').update(stringToSign).digest('base64'));
        const generated = await buildAliyunSignedForm({accessKeyId: 'ak', accessKeySecret: 'sk', parameters: {}});
        expect(generated.SignatureNonce).toMatch(/^[0-9a-f-]{36}$/u);
        expect(generated.Timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    });

    it('按地域选择域名，表单包含签名后的公共参数', async () => {
        respond({Code: '200', Data: {Translated: '你好，世界'}});
        await expect(aliyunTranslation({origin: 'Hello world'})).resolves.toBe('你好，世界');
        let call = lastCall();
        expect(call.url).toBe('https://mt.cn-hangzhou.aliyuncs.com/');
        expect(call.headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
        let params = new URLSearchParams(call.body);
        expect(params.get('Action')).toBe('TranslateGeneral');
        expect(params.get('SourceLanguage')).toBe('auto');
        expect(params.get('TargetLanguage')).toBe('zh');
        expect(params.get('SourceText')).toBe('Hello world');
        expect(params.get('AccessKeyId')).toBe('ali-ak');
        expect(params.get('Signature')).toBeTruthy();
        expect(call.body).not.toContain('ali-sk');

        config.serviceRegion[services.aliyunTranslation] = 'ap-southeast-1';
        respond({Code: 200, Data: {Translated: 'ok'}});
        await aliyunTranslation({origin: 'x', sourceLanguage: 'zh-Hant', targetLanguage: 'en'});
        call = lastCall();
        expect(call.url).toBe('https://mt.ap-southeast-1.aliyuncs.com/');
        params = new URLSearchParams(call.body);
        expect(params.get('SourceLanguage')).toBe('zh-tw');
    });

    it.each([
        ['SignatureDoesNotMatch', 400, '来自同一组密钥'],
        ['SignatureNonceUsed', 400, '请求标识已被使用'],
        ['InvalidTimeStamp.Expired', 400, '校准设备日期与时间'],
        ['InvalidAccessKeyId.NotFound', 404, '未找到 AccessKey ID'],
        ['InvalidAccessKeyId.Inactive', 400, 'AccessKey 已停用'],
        ['Forbidden.RAM', 403, 'alimt:TranslateGeneral'],
        [10010, 400, '尚未开通机器翻译服务'],
        ['10013', 403, '未开通或账号欠费'],
    ])('HTTP 失败保留 %s 错误码并提供可操作提示', async (Code, status, hint) => {
        respond({Code, Message: 'ali-ak ali-sk private source', Recommend: 'https://example.com/?key=ali-sk'}, {status});
        const error = await aliyunTranslation({origin: 'private source'}).catch((error: Error) => error);
        expect(error).toMatchObject({statusCode: status});
        expect((error as Error).message).toContain(String(Code));
        expect((error as Error).message).toContain(hint);
        expect((error as Error).message).not.toMatch(/ali-ak|ali-sk|private source|example\.com/u);
    });

    it('HTTP 限流保留 Retry-After，业务错误同样提供提示', async () => {
        respond({Code: 'Throttling'}, {status: 429, headers: {'Retry-After': '3'}});
        await expect(aliyunTranslation({origin: 'x'})).rejects.toMatchObject({
            statusCode: 429, retryAfterMs: 3000,
            message: '阿里云机器翻译请求失败: 429（错误码 Throttling）：请求过于频繁，请稍后重试',
        });
        respond({Code: 10005, Message: 'private source'});
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('暂不支持所选语言组合');
    });

    it.each([null, [], {}, {Code: 'ali-sk'}, {Code: 'SignatureDoesNotMatch ali-sk'}, {Code: 'constructor'}, {Code: '__proto__'}, {Code: {secret: 'ali-sk'}}, {Code: 200, Data: {Translated: 'should not succeed'}}])(
        '未知或畸形 HTTP 错误体不泄漏内容且不覆盖状态', async (body) => {
            respond(body, {status: 400});
            await expect(aliyunTranslation({origin: 'x'})).rejects.toMatchObject({
                statusCode: 400, message: '阿里云机器翻译请求失败: 400',
            });
        },
    );

    it('非 JSON HTTP 错误保留状态，成功 HTTP 响应仍校验 JSON 和结构', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<html>ali-sk private source</html>', {status: 502}));
        await expect(aliyunTranslation({origin: 'x'})).rejects.toMatchObject({statusCode: 502, message: '阿里云机器翻译请求失败: 502'});
        fetchMock.mockResolvedValueOnce(new Response('ali-sk private source'));
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('阿里云机器翻译返回的不是有效 JSON');
        respond(null);
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('阿里云机器翻译错误');
    });

    it('错误路径', async () => {
        config.secret[services.aliyunTranslation] = '';
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow(/AccessKey ID 与 AccessKey Secret/u);
        config.secret[services.aliyunTranslation] = 'ali-sk';
        fetchMock.mockResolvedValue(new Response('', {status: 500}));
        await expect(aliyunTranslation({origin: 'x'})).rejects.toMatchObject({statusCode: 500});
        respond({Code: '10001', Message: 'signature mismatch'});
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('阿里云机器翻译错误（错误码 10001）');
        respond({Message: 'no code'});
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('阿里云机器翻译错误');
        respond({Code: '200', Data: {}});
        await expect(aliyunTranslation({origin: 'x'})).rejects.toThrow('阿里云机器翻译返回格式异常');
    });
});

describe('百度翻译', () => {
    it('sign = md5(appid + q + salt + key)，多段结果按换行拼回', async () => {
        const form = buildBaiduSignedForm({appId: 'app', secretKey: 'key', query: '第一行\n第二行', from: 'auto', to: 'en', salt: '12345'});
        expect(form).toEqual({q: '第一行\n第二行', from: 'auto', to: 'en', appid: 'app', salt: '12345', sign: createHash('md5').update('app第一行\n第二行12345key', 'utf8').digest('hex')});
        expect(buildBaiduSignedForm({appId: 'a', secretKey: 'k', query: 'q', from: 'auto', to: 'en'}).salt).toMatch(/^\d+$/u);

        respond({from: 'zh', to: 'en', trans_result: [{src: '第一行', dst: 'Line one'}, {src: '第二行', dst: 'Line two'}]});
        await expect(baiduTranslation({origin: '第一行\n第二行', sourceLanguage: 'zh-Hans', targetLanguage: 'en'})).resolves.toBe('Line one\nLine two');
        const call = lastCall();
        expect(call.url).toBe('https://fanyi-api.baidu.com/api/trans/vip/translate');
        const params = new URLSearchParams(call.body);
        expect(params.get('from')).toBe('zh');
        expect(params.get('to')).toBe('en');
        expect(params.get('appid')).toBe('baidu-app');
        expect(params.get('sign')).toBe(createHash('md5').update(`baidu-app第一行\n第二行${params.get('salt')}baidu-key`, 'utf8').digest('hex'));
        expect(call.body).not.toContain('baidu-key');
    });

    it('错误路径与成功码 52000', async () => {
        config.token[services.baiduTranslation] = '';
        await expect(baiduTranslation({origin: 'x'})).rejects.toThrow(/APP ID 与密钥/u);
        config.token[services.baiduTranslation] = 'baidu-app';
        fetchMock.mockResolvedValue(new Response('', {status: 429}));
        await expect(baiduTranslation({origin: 'x'})).rejects.toMatchObject({statusCode: 429});
        respond({error_code: '54003', error_msg: 'rate limit'});
        await expect(baiduTranslation({origin: 'x'})).rejects.toThrow('百度翻译错误（错误码 54003）');
        respond({error_code: 52000, trans_result: [{src: 'x', dst: 'y'}]});
        await expect(baiduTranslation({origin: 'x'})).resolves.toBe('y');
        respond({trans_result: []});
        await expect(baiduTranslation({origin: 'x'})).rejects.toThrow('百度翻译返回格式异常');
        respond({trans_result: [{src: 'x'}]});
        await expect(baiduTranslation({origin: 'x'})).rejects.toThrow('百度翻译返回格式异常');
    });
});

describe('火山引擎翻译', () => {
    it('V4 签名与派生密钥链一致', async () => {
        const body = JSON.stringify({TargetLanguage: 'zh', TextList: ['Hello']});
        const headers = await buildVolcAuthorization({
            accessKeyId: 'ak', secretAccessKey: 'sk', region: 'cn-north-1', host: 'translate.volcengineapi.com',
            query: {Action: 'TranslateText', Version: '2020-06-01'}, body, now: new Date('2026-09-12T08:09:10.500Z'),
        });
        expect(headers['X-Date']).toBe('20260912T080910Z');
        const payloadHash = createHash('sha256').update(body).digest('hex');
        expect(headers['X-Content-Sha256']).toBe(payloadHash);
        const canonicalRequest = ['POST', '/', 'Action=TranslateText&Version=2020-06-01',
            `content-type:application/json; charset=utf-8\nhost:translate.volcengineapi.com\nx-content-sha256:${payloadHash}\nx-date:20260912T080910Z\n`,
            'content-type;host;x-content-sha256;x-date', payloadHash].join('\n');
        const scope = '20260912/cn-north-1/translate/request';
        const stringToSign = ['HMAC-SHA256', '20260912T080910Z', scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
        let key: Buffer | string = 'sk';
        for (const part of ['20260912', 'cn-north-1', 'translate', 'request']) key = createHmac('sha256', key).update(part).digest();
        const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
        expect(headers.Authorization).toBe(`HMAC-SHA256 Credential=ak/${scope}, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=${signature}`);
        expect((await buildVolcAuthorization({accessKeyId: 'ak', secretAccessKey: 'sk', region: 'cn-north-1', host: 'h', query: {}, body: ''}))['X-Date']).toMatch(/^\d{8}T\d{6}Z$/u);
    });

    it('请求携带签名头，地域进入凭证范围，自动检测时省略 SourceLanguage', async () => {
        respond({ResponseMetadata: {}, TranslationList: [{Translation: '你好', DetectedSourceLanguage: 'en'}]});
        await expect(volcTranslation({origin: 'Hello'})).resolves.toBe('你好');
        let call = lastCall();
        expect(call.url).toBe('https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01');
        expect(JSON.parse(call.body)).toEqual({TargetLanguage: 'zh', TextList: ['Hello']});
        expect(call.headers.get('Authorization')).toMatch(/^HMAC-SHA256 Credential=volc-ak\/\d{8}\/cn-north-1\/translate\/request, SignedHeaders=/u);
        expect(call.headers.get('X-Content-Sha256')).toBe(createHash('sha256').update(call.body).digest('hex'));
        expect(call.body).not.toContain('volc-sk');

        config.serviceRegion[services.volcTranslation] = 'ap-southeast-1';
        await volcTranslation({origin: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-Hant'});
        call = lastCall();
        expect(JSON.parse(call.body)).toEqual({TargetLanguage: 'zh-Hant', TextList: ['Hello'], SourceLanguage: 'en'});
        expect(call.headers.get('Authorization')).toContain('/ap-southeast-1/translate/request');
    });

    it('错误路径', async () => {
        config.token[services.volcTranslation] = '';
        await expect(volcTranslation({origin: 'x'})).rejects.toThrow(/Access Key ID 与 Secret Access Key/u);
        config.token[services.volcTranslation] = 'volc-ak';
        fetchMock.mockResolvedValue(new Response('', {status: 403}));
        await expect(volcTranslation({origin: 'x'})).rejects.toMatchObject({statusCode: 403});
        respond({ResponseMetadata: {Error: {Code: 'SignatureDoesNotMatch', CodeN: 100009, Message: 'leak'}}});
        await expect(volcTranslation({origin: 'x'})).rejects.toThrow('火山引擎翻译错误（错误码 100009）');
        respond({TranslationList: []});
        await expect(volcTranslation({origin: 'x'})).rejects.toThrow('火山引擎翻译返回格式异常');
    });
});
