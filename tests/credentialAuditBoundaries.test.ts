import {withProviderSnapshot} from './helpers/providerSnapshot';
/**
 * 凭据审计的合成配置回归：身份、继承、不可变转换、深层清洗和实际 HTTP 字节语义。
 * 不读取本地存储、不执行网络请求，所有 Key 与端点均为测试值。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {apiKeysToToken, getServiceApiKeyRows, getServiceApiKeys, normalizeApiKeys} from '@/src/core/config/apiKeys';
import {credentialsEqual, extractConfigCredentials, hasCredentialFields, mergeConfigCredentials,
    parseStoredCredentials, sanitizeConfigCredentials, sanitizeConfigHistoryCredentials, hasCredentialData} from '@/src/core/config/credentials';
import {dropCredentialsForChangedDestinations} from '@/src/core/config/credentialBinding';
import {parseCustomBody, mergeCustomBody, isValidCustomBody, isCustomBodyMapping, normalizeCustomBodyMapping} from '@/src/core/config/customBody';
import {parseCustomHeaders, mergeCustomHeaders, isValidCustomHeaders} from '@/src/core/config/customHeaders';
import {normalizeCustomOpenAIProviders, normalizeCustomOpenAIModels, createNextCustomOpenAIProviderId,
    getCustomOpenAIProvider, getCustomOpenAIProviderLabel, getCustomOpenAIProviderModels,
    getCustomOpenAIServiceOptions, isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId,
    removeCustomOpenAIProvider, withCustomOpenAIServiceOptions} from '@/src/core/config/customOpenAI';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {getDeepLXEndpoints} from '@/src/core/config/deeplx';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import googleCloudTranslation from '@/src/providers/translation/google-cloud-translation';
import azureTranslator from '@/src/providers/translation/azure-translator';
import aliyunTranslation from '@/src/providers/translation/aliyun-translation';
import baiduTranslation from '@/src/providers/translation/baidu-translation';
import volcTranslation from '@/src/providers/translation/volc-translation';
import youdao from '@/src/providers/translation/youdao';
import tencent from '@/src/providers/translation/tencent';
import hunyuanTranslation from '@/src/providers/translation/hunyuan-translation';
import xiaoniu from '@/src/providers/translation/xiaoniu';

vi.mock('@/src/services/config/store', () => ({config: {}}));

afterEach(() => {setRuntimeFetch(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function cloudConfig(service: string): Config {
    return Object.assign(new Config(), {
        service,
        token: {[service]: 'synthetic-access-id'},
        apiKeys: {[service]: ['synthetic-access-id']},
        secret: {[service]: 'synthetic-access-secret'},
        customHeaders: {[service]: '{"X-Test":"synthetic"}'},
        youdaoAppKey: 'synthetic-youdao-id',
        youdaoAppSecret: 'synthetic-youdao-secret',
        tencentSecretId: 'synthetic-tencent-id',
        tencentSecretKey: 'synthetic-tencent-secret',
    });
}

function cloudRequest(config: Config) {
    return attachTranslationProviderConfig({
        origin: 'Synthetic example', sourceLanguage: 'en', targetLanguage: 'zh-Hans', serviceOverride: config.service,
    }, createTranslationProviderConfigSnapshot(config));
}

function captureCloudRequests(response: unknown) {
    const requests: Array<{url: string; headers: Headers; body: string}> = [];
    setRuntimeFetch(async (input, init) => {
        requests.push({url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), body: String(init?.body ?? '')});
        return new Response(JSON.stringify(response), {status: 200});
    });
    return requests;
}

describe('云服务凭据绑定与实际 adapter 请求一致', () => {
    it.each([
        [services.baiduTranslation, baiduTranslation, {trans_result: [{dst: 'synthetic-result'}]}, 'https://fanyi-api.baidu.com/api/trans/vip/translate'],
        [services.googleCloudTranslation, googleCloudTranslation, {data: {translations: [{translatedText: 'synthetic-result'}]}}, 'https://translation.googleapis.com/language/translate/v2'],
        [services.azureTranslator, azureTranslator, [{translations: [{text: 'synthetic-result'}]}], 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans&textType=plain&from=en'],
        [services.aliyunTranslation, aliyunTranslation, {Code: '200', Data: {Translated: 'synthetic-result'}}, 'https://mt.cn-hangzhou.aliyuncs.com/'],
        [services.volcTranslation, volcTranslation, {TranslationList: [{Translation: 'synthetic-result'}]}, 'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01'],
        [services.youdao, youdao, {errorCode: '0', translation: ['synthetic-result']}, 'https://openapi.youdao.com/api'],
    ] as const)('%s 的无效 proxy 编辑不改变实际 URL，也不清除凭据', async (service, provider, response, expectedUrl) => {
        const current = cloudConfig(service);
        const next = Object.assign(new Config(), current, {proxy: {[service]: 'https://unused-proxy.synthetic.example/'}});
        const requests = captureCloudRequests(response);
        await expect(provider(cloudRequest(current))).resolves.toBe('synthetic-result');
        await expect(provider(cloudRequest(next))).resolves.toBe('synthetic-result');
        expect(requests.map(request => request.url)).toEqual([expectedUrl, expectedUrl]);
        const credentials = extractConfigCredentials(current);
        const rebound = dropCredentialsForChangedDestinations(credentials, current, next);
        expect(rebound).toBe(credentials);
        await expect(provider(cloudRequest(Object.assign(new Config(), next, rebound)))).resolves.toBe('synthetic-result');
        expect(requests[2].url).toBe(expectedUrl);
        expect(dropCredentialsForChangedDestinations(credentials, next, current)).toBe(credentials);
    });

    it.each([
        [services.azureTranslator, azureTranslator, [{translations: [{text: 'synthetic-result'}]}], 'eastasia', 'japanwest'],
        [services.volcTranslation, volcTranslation, {TranslationList: [{Translation: 'synthetic-result'}]}, 'cn-north-1', 'ap-southeast-1'],
    ] as const)('%s 地域只改变请求头或签名，不改变目的地或清除凭据', async (service, provider, response, beforeRegion, afterRegion) => {
        const current = Object.assign(cloudConfig(service), {serviceRegion: {[service]: beforeRegion}});
        const next = Object.assign(new Config(), current, {serviceRegion: {[service]: afterRegion}});
        const requests = captureCloudRequests(response);
        await provider(cloudRequest(current));
        await provider(cloudRequest(next));
        expect(requests[1].url).toBe(requests[0].url);
        const header = service === services.azureTranslator ? 'Ocp-Apim-Subscription-Region' : 'Authorization';
        expect(requests[1].headers.get(header)).toContain(afterRegion);
        expect(requests[0].headers.get(header)).toContain(beforeRegion);
        const credentials = extractConfigCredentials(current);
        expect(dropCredentialsForChangedDestinations(credentials, current, next)).toBe(credentials);
    });

    it.each([
        [undefined, 'ap-southeast-1', true],
        ['unsupported', 'cn-hangzhou', false],
        [' ap-southeast-1 ', 'ap-southeast-1', false],
    ] as const)('阿里云地域 %s → %s 按实际域名判断解绑，显式重绑独立生效', async (beforeRegion, afterRegion, changed) => {
        const service = services.aliyunTranslation;
        const current = Object.assign(cloudConfig(service), {
            proxy: {[service]: 'https://unused-stable-proxy.synthetic.example/'},
            serviceRegion: beforeRegion === undefined ? undefined as unknown as Config['serviceRegion'] : {[service]: beforeRegion},
        });
        const next = Object.assign(new Config(), current, {serviceRegion: {[service]: afterRegion}});
        const requests = captureCloudRequests({Code: '200', Data: {Translated: 'synthetic-result'}});
        await aliyunTranslation(withProviderSnapshot(cloudRequest(current), {}));
        await aliyunTranslation(withProviderSnapshot(cloudRequest(next), {}));
        expect(requests[1].url !== requests[0].url).toBe(changed);
        expect(requests[1].url).toBe(`https://mt.${afterRegion}.aliyuncs.com/`);
        const credentials = extractConfigCredentials(current);
        const rebound = dropCredentialsForChangedDestinations(credentials, current, next);
        if (!changed) {
            expect(rebound).toBe(credentials);
            return;
        }
        expect(rebound.token).toEqual({}); expect(rebound.secret).toEqual({});
        expect(rebound.apiKeys).toEqual({}); expect(rebound.customHeaders).toEqual({});
        expect(dropCredentialsForChangedDestinations(credentials, next, current).token).toEqual({});
        await expect(aliyunTranslation(withProviderSnapshot(cloudRequest(Object.assign(new Config(), next, rebound)), {}))).rejects.toThrow('尚未配置');
        expect(requests).toHaveLength(2);
        const explicitToken = dropCredentialsForChangedDestinations(credentials, current, next, new Set([service]));
        expect(explicitToken.token).toEqual(credentials.token); expect(explicitToken.secret).toEqual(credentials.secret);
        expect(explicitToken.apiKeys).toEqual({}); expect(explicitToken.customHeaders).toEqual({});
        const explicitAll = dropCredentialsForChangedDestinations(credentials, current, next, new Set([service]), new Set(), new Set([service]), new Set([service]));
        expect(explicitAll).toBe(credentials);
        await expect(aliyunTranslation(withProviderSnapshot(cloudRequest(Object.assign(new Config(), next, explicitAll)), {}))).resolves.toBe('synthetic-result');
    });

    it.each([
        [services.tencent, tencent, {Response: {TargetText: 'synthetic-result'}}],
        [services.huanYuanTranslation, hunyuanTranslation, {Response: {Choices: [{Message: {Content: 'synthetic-result'}}]}}],
        [services.xiaoniu, xiaoniu, {tgt_text: 'synthetic-result'}],
    ] as const)('%s 实际消费 proxy，真实改道解绑并保留显式重绑保护', async (service, provider, response) => {
        const current = Object.assign(cloudConfig(service), {proxy: {[service]: 'https://before.synthetic.example/translate'}});
        const next = Object.assign(new Config(), current, {proxy: {[service]: 'https://after.synthetic.example/translate'}});
        const requests = captureCloudRequests(response);
        await expect(provider(cloudRequest(current))).resolves.toBe('synthetic-result');
        await expect(provider(cloudRequest(next))).resolves.toBe('synthetic-result');
        expect(requests.map(request => request.url)).toEqual(['https://before.synthetic.example/translate', 'https://after.synthetic.example/translate']);
        const credentials = extractConfigCredentials(current);
        const rebound = dropCredentialsForChangedDestinations(credentials, current, next);
        expect(rebound.token).toEqual({}); expect(rebound.secret).toEqual({});
        expect(rebound.apiKeys).toEqual({}); expect(rebound.customHeaders).toEqual({});
        if (service !== services.xiaoniu) {
            expect(rebound.tencentSecretId).toBe(''); expect(rebound.tencentSecretKey).toBe('');
            const partial = dropCredentialsForChangedDestinations(credentials, current, next, new Set(), new Set(['tencentSecretId']));
            expect(partial.tencentSecretKey).toBe('');
            await expect(provider(cloudRequest(Object.assign(new Config(), next, rebound)))).rejects.toThrow('密钥未配置');
            expect(requests).toHaveLength(2);
        }
        const explicit = dropCredentialsForChangedDestinations(credentials, current, next, new Set([service]),
            new Set(['tencentSecretId', 'tencentSecretKey']), new Set([service]), new Set([service]));
        expect(explicit).toBe(credentials);
        await expect(provider(cloudRequest(Object.assign(new Config(), next, explicit)))).resolves.toBe('synthetic-result');
    });
});

describe('凭据边界审计回归', () => {
    it('保留 __proto__ 服务的自有 Key 行，结果与调用方原型无关', () => {
        const input = JSON.parse('{"__proto__":[" synthetic ",""],"constructor":["other"]}');
        const result = normalizeApiKeys(input);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(getServiceApiKeyRows({apiKeys: input}, '__proto__')).toEqual(['synthetic', '']);
        expect(apiKeysToToken(input)).toEqual(JSON.parse('{"__proto__":"synthetic","constructor":"other"}'));
    });

    it('Key 查询不读取继承的旧 token，也不扫描无关服务的 getter', () => {
        expect(getServiceApiKeys({token: Object.create({openai: 'inherited-synthetic'})}, 'openai')).toEqual([]);
        const unrelated = vi.fn(() => {throw new Error('不得读取无关服务');});
        const apiKeys = {openai: [' synthetic ', 'synthetic', '', 1]};
        Object.defineProperty(apiKeys, 'custom:unrelated', {get: unrelated, enumerable: true});
        expect(getServiceApiKeys({apiKeys}, 'openai')).toEqual(['synthetic']);
        expect(getServiceApiKeyRows({apiKeys}, 'openai')).toEqual(['synthetic', 'synthetic', '']);
        expect(unrelated).not.toHaveBeenCalled();
    });

    it('凭据记录只接受自有字段，继承值不构成保存或恢复意图', () => {
        const inherited = Object.create({token: {openai: 'inherited-synthetic'}, ak: 'inherited'});
        expect(hasCredentialFields(inherited)).toBe(false);
        expect(parseStoredCredentials(inherited)).toBeNull();
        expect(extractConfigCredentials(inherited)).toEqual(extractConfigCredentials({}));
    });

    it('凭据和公开配置复制保留 __proto__ 自有数据，不替换输出原型', () => {
        const publicInput = JSON.parse('{"__proto__":{"label":"public","apiToken":"synthetic"},"nested":{"enabled":true}}');
        const sanitized = sanitizeConfigCredentials(publicInput);
        expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
        expect(Object.hasOwn(sanitized, '__proto__')).toBe(true);
        expect(sanitized['__proto__']).toEqual({label: 'public'});
        const extra = JSON.parse('{"__proto__":{"label":"private-extra"}}');
        const copied = extractConfigCredentials({extra}).extra;
        expect(Object.hasOwn(copied, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
        expect(copied['__proto__']).not.toBe(extra['__proto__']);
    });

    it('深层未知配置与凭据 extra 复制不依赖 JS 递归栈', () => {
        const root: Record<string, unknown> = {}; let tail = root;
        for (let i = 0; i < 20_000; i += 1) {const next = {}; tail.child = next; tail = next;}
        tail.apiToken = 'synthetic'; tail.enabled = true;
        const sanitized = sanitizeConfigCredentials(root);
        const privateCopy = extractConfigCredentials({extra: root}).extra;
        let publicTail = sanitized, privateTail = privateCopy;
        for (let i = 0; i < 20_000; i += 1) {
            publicTail = publicTail.child as Record<string, unknown>;
            privateTail = privateTail.child as Record<string, unknown>;
        }
        expect(publicTail).toEqual({enabled: true});
        expect(privateTail).toEqual({apiToken: 'synthetic', enabled: true});
        expect(privateTail).not.toBe(tail);
    });

    it('循环和重复引用的清洗会终止，并在所有引用中移除敏感字段', () => {
        const shared = {apiToken: 'synthetic', enabled: true};
        const root: Record<string, unknown> = {a: shared, b: shared}; root.self = root;
        const result = sanitizeConfigCredentials(root);
        expect(result.self).toBe(result);
        expect(result.a).toBe(result.b);
        expect(result.a).toEqual({enabled: true});
        expect(shared.apiToken).toBe('synthetic');
    });

    it('凭据内容相等不受对象字段顺序影响，数组顺序仍有意义', () => {
        const a = extractConfigCredentials({token: {openai: 'a', deepseek: 'b'}, extra: {first: 1, second: [1, 2]}});
        const b = extractConfigCredentials({token: {deepseek: 'b', openai: 'a'}, extra: {second: [1, 2], first: 1}});
        expect(credentialsEqual(a, b)).toBe(true);
        expect(credentialsEqual(a, extractConfigCredentials({...b, extra: {second: [2, 1], first: 1}}))).toBe(false);
    });

    it('隐私词按内容比较，重复引用与独立副本等价且不会改变凭据', () => {
        const left = extractConfigCredentials({privacyProtectionSecretTerms: ['synthetic term one', 'synthetic term two']});
        const right = extractConfigCredentials(left);
        left.extra = {first: left.privacyProtectionSecretTerms, second: left.privacyProtectionSecretTerms};
        right.extra = {first: [...right.privacyProtectionSecretTerms], second: [...right.privacyProtectionSecretTerms]};
        const original = JSON.stringify([left, right]);
        expect(credentialsEqual(left, right)).toBe(true);
        expect(credentialsEqual(right, left)).toBe(true);
        expect(JSON.stringify([left, right])).toBe(original);
        expect(credentialsEqual(left, {...right, privacyProtectionSecretTerms: []})).toBe(false);
        expect(credentialsEqual(left, {...right, privacyProtectionSecretTerms: [...right.privacyProtectionSecretTerms].reverse()})).toBe(false);
        expect(left.extra.first).toBe(left.extra.second);
        expect(right.extra.first).not.toBe(right.extra.second);
    });

    it('请求头只删除 HTTP 空白，保留合法 NBSP 字节，合并结果与 Headers 一致', () => {
        const value = ' \t\u00a0synthetic\u00a0\t ';
        const parsed = parseCustomHeaders(JSON.stringify({'X-Auth': value}));
        expect(parsed).toEqual({'x-auth': '\u00a0synthetic\u00a0'});
        expect(mergeCustomHeaders(undefined, parsed!)).toEqual(Object.fromEntries(new Headers({'X-Auth': value}).entries()));
    });

    it('超长服务 ID 不能截断成已有身份并接收旧凭据', () => {
        const id = `custom:${'a'.repeat(64)}`;
        expect(normalizeCustomOpenAIProviders([{id: `${id}other`, endpoint: 'https://synthetic.example/v1', models: []}])).toEqual([]);
        const normalized = normalizeConfig({customOpenAIProviders: [{id: `${id}other`, endpoint: 'https://synthetic.example/v1', models: []}],
            apiKeys: {[id]: ['synthetic-old']}});
        expect(normalized.customOpenAIProviders).toEqual([]);
        expect(normalized.apiKeys).not.toHaveProperty(id);
    });

    it('继承的 profile 字段不能定义服务身份或覆盖请求地址', () => {
        expect(normalizeCustomOpenAIProviders([Object.create({id: 'custom:inherited', endpoint: 'https://synthetic.example'})])).toEqual([]);
        const own = Object.assign(Object.create({endpoint: 'https://inherited.example', name: 'inherited', models: ['inherited']}), {id: 'custom:own'});
        expect(normalizeCustomOpenAIProviders([own])).toEqual([{id: 'custom:own', name: '自定义接口 1', endpoint: '', models: []}]);
    });

    it('随机身份候选必须完整合法，不能通过截断采用非法超长候选', () => {
        const suffixes = ['a'.repeat(65), 'replacement'];
        expect(createNextCustomOpenAIProviderId([], () => suffixes.shift()!)).toBe('custom:replacement');
        expect(() => createNextCustomOpenAIProviderId([], () => undefined as unknown as string)).toThrow('无法生成唯一');
    });

    it.each([undefined, null, false, 42, [], 'invalid'])('规范化 Key 与旧 token 的异常容器：%j', value => {
        expect(normalizeApiKeys(value)).toEqual({});
        expect(getServiceApiKeys({apiKeys: value, token: value}, 'openai')).toEqual([]);
    });

    it('Key 行保留显式空列表、非法列表回退、自有 token 的原样逗号和不共享数组', () => {
        expect(getServiceApiKeyRows({apiKeys: {openai: []}, token: {openai: 'synthetic-old'}}, 'openai')).toEqual([]);
        expect(getServiceApiKeyRows({apiKeys: {openai: false}, token: {openai: ' synthetic,a '}}, 'openai')).toEqual(['synthetic,a']);
        expect(getServiceApiKeyRows({token: {openai: 1}}, 'openai')).toEqual([]);
        expect(getServiceApiKeyRows({token: {openai: ' '}}, 'openai')).toEqual([]);
        expect(getServiceApiKeyRows({apiKeys: Object.create({openai: ['inherited']}), token: {openai: 'synthetic-own'}}, 'openai')).toEqual(['synthetic-own']);
        const rows = ['synthetic', '', 'synthetic']; const copy = getServiceApiKeyRows({apiKeys: {openai: rows}}, 'openai');
        copy[0] = 'changed'; expect(rows[0]).toBe('synthetic');
        expect(apiKeysToToken({empty: [''], invalid: false, openai: rows})).toEqual({openai: 'synthetic'});
    });

    it('提取与合并只保留正确类型，并生成隔离的敏感值副本', () => {
        const extra = {nested: ['synthetic', {enabled: true}]};
        const credentials = extractConfigCredentials({token: {a: 'synthetic', b: false}, secret: [], customHeaders: null,
            apiKeys: {a: ['synthetic']}, extra, ak: 'synthetic'});
        expect(credentials).toMatchObject({token: {a: 'synthetic'}, secret: {}, customHeaders: {}, ak: 'synthetic'});
        const merged = mergeConfigCredentials({on: true, token: {old: 'synthetic'}}, credentials);
        (merged.apiKeys as Record<string, string[]>).a.push('changed');
        (merged.extra as typeof extra).nested.push('changed');
        expect(credentials.apiKeys.a).toEqual(['synthetic']); expect(extra.nested).toHaveLength(2);
        expect(merged.on).toBe(true); expect(merged).not.toHaveProperty('schemaVersion');
        expect(extractConfigCredentials({extra: false}).extra).toEqual({});
    });

    it.each([
        ['token', {a: 'synthetic'}], ['apiKeys', {a: ['synthetic']}], ['secret', {a: 'synthetic'}],
        ['customHeaders', {a: '{}'}], ['ak', 'synthetic'], ['sk', 'synthetic'], ['appid', 'synthetic'], ['key', 'synthetic'],
        ['youdaoAppKey', 'synthetic'], ['youdaoAppSecret', 'synthetic'], ['tencentSecretId', 'synthetic'],
        ['tencentSecretKey', 'synthetic'], ['extra', {unknown: 'synthetic'}],
    ])('识别敏感记录中的有效数据：%s', (field, value) => {
        expect(hasCredentialData(extractConfigCredentials({[field as string]: value}))).toBe(true);
        expect(hasCredentialData(extractConfigCredentials({}))).toBe(false);
        expect(parseStoredCredentials({[field as string]: value})).not.toBeNull();
    });

    it('历史损坏字符串丢弃，普通条目清洗并保留无配置元数据', () => {
        expect(parseStoredCredentials(null)).toBeNull(); expect(parseStoredCredentials([])).toBeNull();
        expect(sanitizeConfigHistoryCredentials('{bad')).toBeNull();
        expect(sanitizeConfigHistoryCredentials('42')).toBe(42);
        expect(sanitizeConfigHistoryCredentials({other: true})).toEqual({other: true});
        expect(sanitizeConfigHistoryCredentials(JSON.stringify({entries: [null, 1, {date: 2, config: {on: true, password: 'synthetic'}}]})))
            .toEqual({entries: [null, 1, {date: 2, config: {on: true}}]});
        expect(sanitizeConfigCredentials([])).toEqual({});
    });

    it('数组复制保留空位，忽略非元素 getter，敏感对象仍被清洗', () => {
        const list = new Array(3); list[2] = {password: 'synthetic', label: 'public'};
        const extraGetter = vi.fn(() => {throw new Error('非元素属性');});
        Object.defineProperty(list, 'extra', {enumerable: true, get: extraGetter});
        Object.defineProperty(list, '4294967295', {enumerable: true, get: extraGetter});
        const result = sanitizeConfigCredentials({list}).list as unknown[];
        expect(result).toHaveLength(3); expect(0 in result).toBe(false); expect(result[2]).toEqual({label: 'public'});
        expect(extraGetter).not.toHaveBeenCalled();
    });

    it('内容比较保留 JSON 保存语义，同时支持循环、深层对象和结构差异', () => {
        const a = extractConfigCredentials({extra: {drop: undefined, count: NaN, list: [undefined, () => 1, Symbol('synthetic')]}});
        const b = extractConfigCredentials({extra: {count: null, list: [null, null, null]}});
        expect(credentialsEqual(a, b)).toBe(true);
        expect(credentialsEqual(a, a)).toBe(true);
        expect(credentialsEqual(extractConfigCredentials({extra: {zero: -0}}), extractConfigCredentials({extra: {zero: 0}}))).toBe(true);
        expect(credentialsEqual(a, extractConfigCredentials({extra: {count: {}, list: [null, null, null]}}))).toBe(false);
        expect(credentialsEqual(extractConfigCredentials({extra: {a: null}}), extractConfigCredentials({extra: {a: 1}}))).toBe(false);
        expect(credentialsEqual(extractConfigCredentials({extra: {a: []}}), extractConfigCredentials({extra: {a: {}}}))).toBe(false);
        expect(credentialsEqual(extractConfigCredentials({extra: {a: [1]}}), extractConfigCredentials({extra: {a: []}}))).toBe(false);
        expect(credentialsEqual(extractConfigCredentials({extra: {a: 1}}), extractConfigCredentials({extra: {b: 1}}))).toBe(false);
        expect(credentialsEqual(extractConfigCredentials({extra: {a: 1}}), extractConfigCredentials({extra: {}}))).toBe(false);
        const cycle: Record<string, unknown> = {label: 'same'}; cycle.self = cycle;
        const copyA = extractConfigCredentials({extra: cycle}), copyB = extractConfigCredentials({extra: cycle});
        expect(credentialsEqual(copyA, copyB)).toBe(true);
        copyB.extra.label = 'changed'; expect(credentialsEqual(copyA, copyB)).toBe(false);
        const array: unknown[] = []; array.push(array);
        expect(credentialsEqual(extractConfigCredentials({extra: {array}}), extractConfigCredentials({extra: {array}}))).toBe(true);
    });

    it('自定义请求体保持顶层替换、按指定键合并和原始 payload 不变', () => {
        const payload = {model: 'synthetic', options: {from: 'en', to: 'zh', keep: true}, list: [1]};
        expect(mergeCustomBody(payload, '{"options":{"to":"ja"},"list":[2]}', ['options']))
            .toEqual({model: 'synthetic', options: {from: 'en', to: 'ja', keep: true}, list: [2]});
        expect(mergeCustomBody(payload, '{"options":null}', ['options']).options).toBeNull();
        expect(mergeCustomBody(payload, '{"options":[]}', ['options']).options).toEqual([]);
        expect(mergeCustomBody({options: null}, '{"options":{}}', ['options'])).toEqual({options: {}});
        expect(mergeCustomBody({options: [1]}, '{"options":{}}', ['options'])).toEqual({options: {}});
        expect(mergeCustomBody(payload)).toEqual(payload); expect(payload.options.to).toBe('zh');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(mergeCustomBody(payload, '{invalid')).toBe(payload); expect(warning).toHaveBeenCalledOnce();
        expect(isValidCustomBody('{}')).toBe(true); expect(isValidCustomBody('[]')).toBe(false);
        expect(isCustomBodyMapping({a: '{}'})).toBe(true); expect(isCustomBodyMapping({a: 1})).toBe(false);
        expect(isCustomBodyMapping(null)).toBe(false); expect(isCustomBodyMapping([])).toBe(false);
        expect(normalizeCustomBodyMapping({a: '{}', b: 1})).toEqual({a: '{}'});
        expect(normalizeCustomBodyMapping(null)).toEqual({}); expect(normalizeCustomBodyMapping(1)).toEqual({});
        expect(normalizeCustomBodyMapping([])).toEqual({});
        for (const raw of [undefined, null, '', ' \t ', '{}']) expect(parseCustomBody(raw)).toEqual({});
        for (const raw of [1, {}, 'null', '[]', 'true', '42', '{bad']) expect(parseCustomBody(raw)).toBeUndefined();
    });

    it('请求头原生合并覆盖默认值；名称、类型和字节校验拒绝无效输入', () => {
        for (const value of ['', ' ', '\t', '  \t  ', '\x80', 'prefix ', ' \tvalue\t ', 'value', '\xa0']) {
            expect(parseCustomHeaders(JSON.stringify({'X-Test': value})))
                .toEqual(Object.fromEntries(new Headers({'X-Test': value}).entries()));
        }
        expect(isValidCustomHeaders('{}')).toBe(true);
        for (const raw of ['[]', '{"bad name":"x"}', '{"x":1}', '{"x":"中文"}']) {
            expect(isValidCustomHeaders(raw)).toBe(false); expect(parseCustomHeaders(raw)).toBeUndefined();
        }
        const defaults = new Headers({'X-A': 'default', 'X-B': 'retained'});
        expect(mergeCustomHeaders(defaults, {'x-a': 'synthetic'})).toEqual({'x-a': 'synthetic', 'x-b': 'retained'});
        expect(defaults.get('x-a')).toBe('default');
    });

    it('模型目录过滤外部排除项、重复项和保留字，查询与删除不共享模型数组', () => {
        expect(normalizeCustomOpenAIModels(['first', 'excluded', 'first', '自定义模型', '', 1], new Set(['excluded']))).toEqual(['first']);
        expect(normalizeCustomOpenAIModels({})).toEqual([]);
        const providers = normalizeCustomOpenAIProviders([null, [], {id: 1}, {id: 'custom:own', models: ['first']}, {id: 'custom', models: []}]);
        expect(providers).toHaveLength(2); expect(providers[0].name).toBe('自定义接口 1');
        expect(getCustomOpenAIProvider(providers, 'custom:own')).toBe(providers[0]);
        expect(isConfiguredCustomOpenAIProvider(providers, 'custom:missing')).toBe(false);
        expect(getCustomOpenAIProviderLabel(undefined, 'custom:missing')).toBe('custom:missing');
        expect(getCustomOpenAIProviderLabel([{...providers[0], name: ''}], 'custom:own')).toBe('custom:own');
        const models = getCustomOpenAIProviderModels(providers, 'custom:own'); models.push('changed');
        expect(providers[0].models).toEqual(['first']);
        expect(getCustomOpenAIProviderModels(providers, 'custom:missing')).toEqual([]);
        expect(getCustomOpenAIServiceOptions(undefined)).toEqual([]);
        expect(withCustomOpenAIServiceOptions([{value: 'custom', label: 'old'}], undefined)).toEqual([]);
        const removed = removeCustomOpenAIProvider(providers, 'custom'); removed[0].models.push('changed');
        expect(providers[0].models).toEqual(['first']);
        expect(isCustomOpenAIProviderId(null)).toBe(false); expect(isCustomOpenAIProviderId('custom:')).toBe(false);
    });

    it('四种按服务凭据独立解绑，显式重绑只保留对应字段且不改变输入', () => {
        const service = 'custom:owned';
        const current = Object.assign(new Config(), {customOpenAIProviders: [{id: service, name: 'synthetic', endpoint: 'https://old.example/v1', models: []}]});
        const next = Object.assign(new Config(), {customOpenAIProviders: [{id: service, name: 'synthetic', endpoint: 'https://next.example/v1', models: []}]});
        const credentials = extractConfigCredentials({token: {[service]: 'synthetic'}, apiKeys: {[service]: ['synthetic']},
            secret: {[service]: 'synthetic-secret'}, customHeaders: {[service]: '{"x":"synthetic"}'}});
        expect(dropCredentialsForChangedDestinations(credentials, current, current)).toBe(credentials);
        const cleared = dropCredentialsForChangedDestinations(credentials, current, next);
        expect(cleared.token).toEqual({}); expect(cleared.apiKeys).toEqual({});
        expect(cleared.secret).toEqual({}); expect(cleared.customHeaders).toEqual({});
        const tokenOnly = dropCredentialsForChangedDestinations(credentials, current, next, new Set([service]));
        expect(tokenOnly.token[service]).toBe('synthetic'); expect(tokenOnly.secret[service]).toBe('synthetic-secret');
        expect(tokenOnly.apiKeys).toEqual({}); expect(tokenOnly.customHeaders).toEqual({});
        const keysOnly = dropCredentialsForChangedDestinations(credentials, current, next, new Set(), new Set(), new Set(), new Set([service]));
        expect(keysOnly.apiKeys[service]).toEqual(['synthetic']); expect(keysOnly.token).toEqual({}); expect(keysOnly.secret).toEqual({});
        const headersOnly = dropCredentialsForChangedDestinations(credentials, current, next, new Set(), new Set(), new Set([service]));
        expect(headersOnly.customHeaders[service]).toBe('{"x":"synthetic"}'); expect(headersOnly.token).toEqual({});
        expect(credentials.token[service]).toBe('synthetic'); expect(credentials.apiKeys[service]).toEqual(['synthetic']);
        const secretOnly = extractConfigCredentials({secret: credentials.secret});
        expect(dropCredentialsForChangedDestinations(secretOnly, current, next).secret).toEqual({});
    });

    it('自定义端点索引保留首个重复身份，空地址与缺失档案之间不误解绑', () => {
        const id = 'custom:duplicate';
        const first = {id, name: 'first', endpoint: 'https://first.example/v1', models: []};
        const current = Object.assign(new Config(), {customOpenAIProviders: [first, {...first, endpoint: 'https://ignored.example'}]});
        const next = Object.assign(new Config(), {customOpenAIProviders: [first]});
        const credentials = extractConfigCredentials({token: {[id]: 'synthetic'}});
        expect(dropCredentialsForChangedDestinations(credentials, current, next)).toBe(credentials);
        expect(dropCredentialsForChangedDestinations(credentials, Object.assign(new Config(), {customOpenAIProviders: [{...first, endpoint: ''}]}), new Config())).toBe(credentials);
        const last = {...first, id: 'custom:last'};
        current.customOpenAIProviders.push(last); next.customOpenAIProviders.push(last);
        const order = extractConfigCredentials({token: {'custom:last': 'synthetic', [id]: 'synthetic', 'custom:missing': 'synthetic'}});
        expect(dropCredentialsForChangedDestinations(order, current, next)).toBe(order);
        const legacy = Object.assign(new Config(), {customOpenAIProviders: undefined as unknown as Config['customOpenAIProviders']});
        expect(dropCredentialsForChangedDestinations(credentials, legacy, new Config())).toBe(credentials);
        const empty = {...first, id: 'custom:empty', endpoint: ''};
        const indexedEmpty = Object.assign(new Config(), {customOpenAIProviders: [empty, last]});
        const blankOrder = extractConfigCredentials({token: {'custom:last': 'synthetic', 'custom:empty': 'synthetic'}});
        expect(dropCredentialsForChangedDestinations(blankOrder, indexedEmpty, indexedEmpty)).toBe(blankOrder);
    });

    it('腾讯共享密钥无数据或完整显式重绑时无需读取无关路由，单侧密钥仍解绑', () => {
        const current = new Config();
        const next = Object.assign(new Config(), {proxy: {[services.tencent]: 'https://synthetic.example'}});
        expect(dropCredentialsForChangedDestinations(extractConfigCredentials({}), current, next)).toEqual(extractConfigCredentials({}));
        const credentials = extractConfigCredentials({tencentSecretKey: 'synthetic'});
        expect(dropCredentialsForChangedDestinations(credentials, current, next).tencentSecretKey).toBe('');
        expect(dropCredentialsForChangedDestinations(credentials, current, next, new Set(), new Set(['tencentSecretId', 'tencentSecretKey'])))
            .toBe(credentials);
    });

    it('端点归一化保留无法发出的地址身份，实际 URL 或查询参数变化仍解绑', () => {
        for (const endpoint of ['', ' not-yet-url ', 'ftp://synthetic.example/chat/completions/']) {
            const current = Object.assign(new Config(), {proxy: {openai: endpoint}});
            expect(dropCredentialsForChangedDestinations(extractConfigCredentials({token: {openai: 'synthetic'}}), current, current).token.openai).toBe('synthetic');
        }
        const current = Object.assign(new Config(), {proxy: {openai: 'https://synthetic.example/chat/completions/?a=1&b=2'}});
        const equivalent = Object.assign(new Config(), {proxy: {openai: 'https://synthetic.example/chat/completions?b=2&a=1#fragment'}});
        const changed = Object.assign(new Config(), {proxy: {openai: 'https://synthetic.example/chat/completions?a=2&b=2'}});
        const credentials = extractConfigCredentials({token: {openai: 'synthetic'}});
        expect(dropCredentialsForChangedDestinations(credentials, current, equivalent)).toBe(credentials);
        expect(dropCredentialsForChangedDestinations(credentials, current, changed).token).toEqual({});
    });

    it('自定义 Base URL 与实际补全的请求地址共享身份，proxy 完整地址仍按原样使用', () => {
        const service = 'custom:base-url';
        for (const [base, full] of [
            ['https://synthetic.example', 'https://synthetic.example/v1/chat/completions'],
            ['https://synthetic.example/v7///?b=2&a=1', 'https://synthetic.example/v7/chat/completions?a=1&b=2'],
        ]) {
            const profile = (endpoint: string) => [{id: service, name: 'synthetic', endpoint, models: []}];
            const current = Object.assign(new Config(), {customOpenAIProviders: profile(base)});
            const next = Object.assign(new Config(), {customOpenAIProviders: profile(full)});
            const credentials = extractConfigCredentials({token: {[service]: 'synthetic'}, apiKeys: {[service]: ['synthetic']}, customHeaders: {[service]: '{}'}});
            expect(new URL(resolveOpenAICompatibleEndpoint(service, current).endpoint).pathname)
                .toBe(new URL(resolveOpenAICompatibleEndpoint(service, next).endpoint).pathname);
            expect(dropCredentialsForChangedDestinations(credentials, current, next)).toBe(credentials);
            expect(dropCredentialsForChangedDestinations(credentials, next, current)).toBe(credentials);
            const proxy = Object.assign(new Config(), {proxy: {[service]: base}, customOpenAIProviders: profile(full)});
            expect(resolveOpenAICompatibleEndpoint(service, proxy).endpoint).not.toBe(resolveOpenAICompatibleEndpoint(service, next).endpoint);
            expect(dropCredentialsForChangedDestinations(credentials, proxy, next).token).toEqual({});
        }
        for (const endpoint of ['ftp://synthetic.example/v1', 'not-yet-url', '']) {
            const current = Object.assign(new Config(), {customOpenAIProviders: [{id: service, name: 'synthetic', endpoint, models: []}]});
            expect(dropCredentialsForChangedDestinations(extractConfigCredentials({token: {[service]: 'synthetic'}}), current, current).token[service]).toBe('synthetic');
        }
    });

    it('DeepLX 单 URL 中的竖线不能与多目标分隔混淆，新增目标必须解绑', () => {
        const a = 'https://a.synthetic.example/translate', b = 'https://b.synthetic.example/{{token}}';
        const current = Object.assign(new Config(), {deeplx: `${a}|${b}`});
        const next = Object.assign(new Config(), {deeplx: `${a}\n${b}`});
        expect(getDeepLXEndpoints(current.deeplx, '', 'synthetic')).toHaveLength(1);
        expect(new URL(getDeepLXEndpoints(next.deeplx, '', 'synthetic')[1]).origin).toBe('https://b.synthetic.example');
        const credentials = extractConfigCredentials({token: {deeplx: 'synthetic'}, apiKeys: {deeplx: ['synthetic']}});
        const result = dropCredentialsForChangedDestinations(credentials, current, next);
        expect(result.token).toEqual({}); expect(result.apiKeys).toEqual({});
    });

    it('旧 custom 字段作为档案缺失或空端点的实际回退，等价请求保留凭据', () => {
        const current = Object.assign(new Config(), {custom: 'https://synthetic.example', customOpenAIProviders: []});
        const next = Object.assign(new Config(), {custom: 'https://synthetic.example/v1/chat/completions',
            customOpenAIProviders: [{id: 'custom', name: 'synthetic', endpoint: 'https://synthetic.example/v1', models: []}]});
        expect(resolveOpenAICompatibleEndpoint('custom', current).endpoint).toBe(resolveOpenAICompatibleEndpoint('custom', next).endpoint);
        const credentials = extractConfigCredentials({token: {custom: 'synthetic'}});
        expect(dropCredentialsForChangedDestinations(credentials, current, next)).toBe(credentials);
    });
});
