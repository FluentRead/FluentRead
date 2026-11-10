import {describe, expect, it} from 'vitest';

import {
    firstConfiguredModel,
    defaultOption,
    services,
    servicesType,
} from '@/src/core/config/catalog';
import {
    extractConfigCredentials,
    isSensitiveConfigKey,
    parseStoredCredentials,
    sanitizeConfigCredentials,
    sanitizeConfigHistoryCredentials,
} from '@/src/core/config/credentials';
import {parseCustomBody} from '@/src/core/config/customBody';
import {getDeepLXEndpoints} from '@/src/core/config/deeplx';
import {
    DEFAULT_TRANSLATION_BACKOFF_BASE_MS,
    DEFAULT_TRANSLATION_BACKOFF_MAX_MS,
    DEFAULT_API_KEY_RECOVERY_MS,
    MAX_API_KEY_RECOVERY_MS,
    DEFAULT_TRANSLATION_MAX_RETRIES,
    DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE,
    DEFAULT_TRANSLATION_REQUESTS_PER_SECOND,
    DEFAULT_MAX_CONCURRENT_TRANSLATIONS,
    normalizeConfig,
    normalizeApiKeyRecoveryMs,
    normalizeMaxConcurrentTranslations,
    normalizeTranslationBackoffBaseMs,
    normalizeTranslationBackoffMaxMs,
    normalizeTranslationMaxRetries,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from '@/src/core/config/model';
import {
    getApiKeyRequirementKey,
    createApiKeyRequirementKey,
    parseApiKeyRequirementKey,
    getMissingCredentialMessage,
    isApiKeyRequired,
} from '@/src/core/config/validation';

describe('配置领域边界与防御分支', () => {
    it('公开配置与历史保留合法网站正文标签，额外凭据和其他路径同名字段仍被清洗', () => {
        const siteAdaptation = normalizeConfig({siteAdaptation: {enabled: false, disabledRuleIds: ['reddit'], custom: {
            version: 1, rules: [{id: 'mine', name: 'My rule', match: {hosts: ['example.com']},
                content: [{css: ['article p'], key: 'article-body'}]}],
        }}}).siteAdaptation;
        const source = {siteAdaptation, key: 'fixture-secret', future: {siteAdaptation, key: 'fixture-secret'}};
        const sanitized = sanitizeConfigCredentials(source);
        expect(sanitized.siteAdaptation).toEqual(siteAdaptation);
        expect(sanitized.siteAdaptation).not.toBe(siteAdaptation);
        expect(sanitized).not.toHaveProperty('key');
        expect(sanitized).not.toHaveProperty('future.key');
        expect(sanitized).not.toHaveProperty('future.siteAdaptation.custom.rules.0.content.0.key');
        expect(sanitizeConfigHistoryCredentials({entries: [{config: source}]}))
            .toMatchObject({entries: [{config: {siteAdaptation}}]});
        const invalid = {...siteAdaptation, token: 'fixture-secret', custom: {version: 1,
            rules: [{...siteAdaptation.custom.rules[0], content: [{css: ['p'], key: {token: 'fixture-secret'}}]}]}};
        expect(sanitizeConfigCredentials({siteAdaptation: invalid}).siteAdaptation)
            .toEqual({...siteAdaptation, custom: {version: 1, rules: []}});
        expect(JSON.stringify(sanitizeConfigCredentials({siteAdaptation: invalid}))).not.toContain('fixture-secret');
    });
    it('页面识别范围仅接受全部节点枚举，旧配置和非法值保持默认正文模式', () => {
        expect(normalizeConfig({}).translationScope).toBe('content');
        expect(normalizeConfig({translationScope: 'all'}).translationScope).toBe('all');
        for (const translationScope of ['content', undefined, null, '', 'ALL', 'future', true, 1, {}, ['all']]) {
            expect(normalizeConfig({translationScope}).translationScope).toBe('content');
        }
    });
    it('保留侧边栏窗口偏好，旧配置及非法范围默认仅当前标签页', () => {
        expect(normalizeConfig({}).translationSidepanelScope).toBe('tab');
        expect(normalizeConfig({translationSidepanelScope: 'window'}).translationSidepanelScope).toBe('window');
        expect(normalizeConfig({translationSidepanelScope: 'invalid'}).translationSidepanelScope).toBe('tab');
    });

    it('全局和工具语言按书写体系迁移历史别名并保留自定义非中文语言', () => {
        for (const [language, canonical] of [
            [' zh ', 'zh-Hans'], ['zh_CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'],
            ['zh-CHS', 'zh-Hans'], ['zh-Hans-TW', 'zh-Hans'],
            ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'],
            ['zh-CHT', 'zh-Hant'], ['zh-Hant-CN', 'zh-Hant'],
            [' en-US ', 'en-US'], [' Custom language ', 'Custom language'],
        ]) {
            const config = normalizeConfig({
                from: language, to: language, inputBoxTranslationTarget: language,
                translationCenterSourceLanguage: language, translationCenterTargetLanguage: language,
            });
            expect(config).toMatchObject({
                from: canonical, to: canonical, inputBoxTranslationTarget: canonical,
                translationCenterSourceLanguage: canonical, translationCenterTargetLanguage: canonical,
            });
            expect(normalizeConfig(config)).toEqual(config);
        }
        for (const invalid of [undefined, null, '', '  ', 42]) {
            expect(normalizeConfig({from: invalid, to: invalid, inputBoxTranslationTarget: invalid,
                translationCenterSourceLanguage: invalid, translationCenterTargetLanguage: invalid}))
                .toMatchObject({from: 'auto', to: 'zh-Hans', inputBoxTranslationTarget: 'en',
                    translationCenterSourceLanguage: '', translationCenterTargetLanguage: ''});
        }
    });

    it('旧配置获得缓存默认双上限，保存与导入统一归一化范围', () => {
        expect(normalizeConfig({})).toMatchObject({translationCacheMaxBytes: 10 * 1024 * 1024, translationCacheMaxEntries: 10000});
        expect(normalizeConfig({translationCacheMaxBytes: 20 * 1024 * 1024, translationCacheMaxEntries: 5000}))
            .toMatchObject({translationCacheMaxBytes: 10 * 1024 * 1024, translationCacheMaxEntries: 5000});
        expect(normalizeConfig({translationCacheMaxBytes: 'unlimited', translationCacheMaxEntries: Number.NaN}))
            .toMatchObject({translationCacheMaxBytes: 10 * 1024 * 1024, translationCacheMaxEntries: 10000});
        expect(normalizeConfig({translationCacheMaxBytes: 500 * 1024 * 1024, translationCacheMaxEntries: 1_000_000}))
            .toMatchObject({translationCacheMaxBytes: 10 * 1024 * 1024, translationCacheMaxEntries: 10_000});
    });
    it('服务能力查询覆盖正反例与复合供应商判断', () => {
        expect(servicesType.isAiSdk(services.openai)).toBe(true);
        expect(servicesType.isAiSdk(services.gemini)).toBe(false);
        for (const supported of [
            services.openai,
            services.yiyan,
            services.infini,
            services.minimax,
        ]) expect(servicesType.isUseProxy(supported), supported).toBe(true);
        for (const ignored of [
            services.azureOpenai,
            services.google,
            services.youdao,
        ]) expect(servicesType.isUseProxy(ignored), ignored).toBe(false);
        expect(servicesType.isUseProxy(services.chromeTranslator)).toBe(false);
        expect(servicesType.isCustom(services.custom)).toBe(true);
        expect(servicesType.isCustom(services.openai)).toBe(false);
        expect(servicesType.isNewApi(services.newapi)).toBe(true);
        expect(servicesType.isNewApi(services.openai)).toBe(false);
        expect(servicesType.isUseModel(services.openai)).toBe(true);
        expect(servicesType.isUseModel(services.microsoft)).toBe(false);
        expect(servicesType.isYoudao(services.youdao)).toBe(true);
        expect(servicesType.isYoudao(services.openai)).toBe(false);
        expect(servicesType.isTencent(services.tencent)).toBe(true);
        expect(servicesType.isTencent(services.huanYuanTranslation)).toBe(true);
        expect(servicesType.isTencent(services.openai)).toBe(false);
        expect(servicesType.isAzureOpenai(services.azureOpenai)).toBe(true);
        expect(servicesType.isAzureOpenai(services.openai)).toBe(false);
        expect(firstConfiguredModel([])).toBe('');
        expect(firstConfiguredModel(['model-a'])).toBe('model-a');
    });

    it('凭据边界拒绝非对象与无凭据记录，并清洗混合历史条目', () => {
        expect(extractConfigCredentials(null)).toMatchObject({token: {}, extra: {}});
        expect(parseStoredCredentials({unrelated: true})).toBeNull();
        expect(sanitizeConfigCredentials('not-an-object')).toEqual({});
        expect(sanitizeConfigHistoryCredentials({
            entries: [null, {config: {token: {openai: 'secret'}, on: true}}],
        })).toEqual({
            entries: [null, {config: {on: true}}],
        });
        expect(isSensitiveConfigKey('key')).toBe(true);
        expect(isSensitiveConfigKey('token')).toBe(true);
        expect(isSensitiveConfigKey('authorization')).toBe(true);
        expect(isSensitiveConfigKey('apiToken')).toBe(true);
        expect(isSensitiveConfigKey('apiKeyRecoveryMs')).toBe(false);
        expect(isSensitiveConfigKey('requireApiKey')).toBe(false);
        expect(isSensitiveConfigKey('displayName')).toBe(false);
    });

    it('自定义请求体和 DeepLX 代理对不支持输入安全回退', () => {
        expect(parseCustomBody(123)).toBeUndefined();
        expect(() => getDeepLXEndpoints('', 'https://proxy.test/{{apiKey}}/translate'))
            .toThrow('DeepLX 地址包含 {{apiKey}} 或 {{token}} 占位符');
    });

    it('配置规范化修复非对象、错误类型和不可用自定义快捷键', () => {
        expect(normalizeConfig(null)).toMatchObject({on: true, service: services.freeTranslation});

        const normalized = normalizeConfig({
            on: true,
            service: services.openai,
            from: 'auto',
            to: 'zh-Hans',
            custom: 123,
            newApiUrl: false,
            videoTranslationEnabled: 'yes',
            deepseekApiType: 'legacy',
            selectionTranslatorMode: 'bilingual',
            selectionTranslatorTrigger: 'custom',
            customSelectionTranslatorHotkey: ' ',
        });

        expect(normalized.custom).toBe(defaultOption.custom);
        expect(normalized.newApiUrl).toBe('http://localhost:3000');
        expect(normalized.videoTranslationEnabled).toBe(true);
        expect(normalized.deepseekApiType).toBe('auto');
        expect(normalized.selectionTranslatorTrigger).toBe('icon');
        expect(normalized.selectionTranslatorHotkey).toBe('none');
    });

    it.each([undefined, null, 'false', 0])('缺失或无效的翻译功能开关使用各自默认值：%s', value => {
        expect(normalizeConfig({videoTranslationEnabled: value, selectionAreaEnabled: value, disableImageTranslator: value})).toMatchObject({
            videoTranslationEnabled: true, selectionAreaEnabled: true, disableImageTranslator: true,
        });
    });

    it.each([
        ['缺失值', undefined, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['字符串', '1000', DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['非有限数', Number.POSITIVE_INFINITY, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['负数', -7, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['零', 0, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['小数', 1.6, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['超出上限', 1000, DEFAULT_MAX_CONCURRENT_TRANSLATIONS],
        ['合法上限', 100, 100],
    ])('并发配置规范化：%s', (_label, value, expected) => {
        const normalized = normalizeMaxConcurrentTranslations(value);
        expect(normalized).toBe(expected);
        expect(Number.isSafeInteger(normalized)).toBe(true);
        expect(normalizeConfig({maxConcurrentTranslations: value}).maxConcurrentTranslations).toBe(expected);
    });

    it('任务调度配置保留 0 不限速语义，并限制重试与退避范围', () => {
        expect(DEFAULT_MAX_CONCURRENT_TRANSLATIONS).toBe(10);
        expect(DEFAULT_TRANSLATION_REQUESTS_PER_SECOND).toBe(10);
        expect(DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE).toBe(250);
        expect(normalizeConfig({})).toMatchObject({maxConcurrentTranslations: 10, translationRequestsPerSecond: 10});
        expect(normalizeConfig({maxConcurrentTranslations: 6}).maxConcurrentTranslations).toBe(6);
        expect(normalizeConfig({maxConcurrentTranslations: 3, translationRequestsPerSecond: 6}))
            .toMatchObject({maxConcurrentTranslations: 3, translationRequestsPerSecond: 6});
        expect(DEFAULT_TRANSLATION_BACKOFF_BASE_MS).toBe(500);
        expect(DEFAULT_TRANSLATION_BACKOFF_MAX_MS).toBe(3_000);
        expect(DEFAULT_API_KEY_RECOVERY_MS).toBe(60_000);
        expect(normalizeApiKeyRecoveryMs(undefined)).toBe(DEFAULT_API_KEY_RECOVERY_MS);
        expect(normalizeApiKeyRecoveryMs(Number.NaN)).toBe(DEFAULT_API_KEY_RECOVERY_MS);
        expect(normalizeApiKeyRecoveryMs(0)).toBe(DEFAULT_API_KEY_RECOVERY_MS);
        expect(normalizeApiKeyRecoveryMs(90_000)).toBe(2 * DEFAULT_API_KEY_RECOVERY_MS);
        expect(normalizeApiKeyRecoveryMs(MAX_API_KEY_RECOVERY_MS + DEFAULT_API_KEY_RECOVERY_MS)).toBe(MAX_API_KEY_RECOVERY_MS);
        expect(normalizeTranslationRequestsPerSecond(undefined)).toBe(DEFAULT_TRANSLATION_REQUESTS_PER_SECOND);
        expect(normalizeTranslationRequestsPerSecond(-1)).toBe(0);
        expect(normalizeTranslationRequestsPerSecond(2_000)).toBe(1_000);
        expect(normalizeTranslationRequestsPerMinute('10')).toBe(DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE);
        expect(normalizeTranslationRequestsPerMinute(20_000)).toBe(10_000);
        expect(normalizeTranslationMaxRetries(-1)).toBe(0);
        expect(normalizeTranslationMaxRetries(99)).toBe(10);
        expect(normalizeTranslationBackoffBaseMs(1)).toBe(100);
        expect(normalizeTranslationBackoffBaseMs(99_999)).toBe(60_000);
        expect(normalizeTranslationBackoffMaxMs(1)).toBe(1_000);
        expect(normalizeTranslationBackoffMaxMs(999_999)).toBe(300_000);

        expect(normalizeConfig({
            translationRequestsPerSecond: 4,
            translationRequestsPerMinute: 120,
            translationMaxRetries: 5,
            translationBackoffBaseMs: 400,
            translationBackoffMaxMs: 8_000,
            apiKeyRecoveryMs: 5 * 60_000,
        })).toMatchObject({
            translationRequestsPerSecond: 4,
            translationRequestsPerMinute: 120,
            translationMaxRetries: 5,
            translationBackoffBaseMs: 400,
            translationBackoffMaxMs: 8_000,
            apiKeyRecoveryMs: 5 * 60_000,
        });
        expect(normalizeConfig({translationBackoffBaseMs: 60_000, translationBackoffMaxMs: 1})
            .translationBackoffMaxMs).toBe(60_000);
        expect(normalizeConfig({}).translationBackoffBaseMs).toBe(DEFAULT_TRANSLATION_BACKOFF_BASE_MS);
        expect(normalizeConfig({}).translationBackoffMaxMs).toBe(DEFAULT_TRANSLATION_BACKOFF_MAX_MS);
        expect(normalizeConfig({}).translationMaxRetries).toBe(DEFAULT_TRANSLATION_MAX_RETRIES);
    });

    it('凭据提示覆盖未知服务和可选字段短路', () => {
        expect(getApiKeyRequirementKey('unknown-service', {})).toBe(
            createApiKeyRequirementKey('unknown-service', ''),
        );
        expect(getApiKeyRequirementKey(services.openai, {
            model: {[services.openai]: '自定义模型'},
        })).toBe(createApiKeyRequirementKey(services.openai, '自定义模型'));
        expect(getApiKeyRequirementKey(services.openai, {
            model: {[services.openai]: '自定义模型'},
            customModel: {[services.openai]: 'local-model'},
        })).toBe(createApiKeyRequirementKey(services.openai, 'local-model'));
        const encodedRequirement = createApiKeyRequirementKey('custom:1', 'model:latest');
        expect(parseApiKeyRequirementKey(encodedRequirement)).toEqual(['custom:1', 'model:latest']);
        expect(parseApiKeyRequirementKey('legacy:key')).toBeNull();
        expect(parseApiKeyRequirementKey('v2:{bad-json')).toBeNull();
        expect(parseApiKeyRequirementKey('v2:["only-one"]')).toBeNull();
        expect(parseApiKeyRequirementKey('v2:[42,"model"]')).toBeNull();
        expect(isApiKeyRequired(services.microsoft, {})).toBe(true);
        expect(getMissingCredentialMessage('unknown-service', {})).toBeNull();
        expect(getMissingCredentialMessage(services.youdao, {
            youdaoAppKey: 'key',
        })).toContain('App Secret');
        expect(getMissingCredentialMessage(services.youdao, {
            youdaoAppSecret: 'secret',
        })).toContain('App Key');
        expect(getMissingCredentialMessage(services.youdao, {
            youdaoAppKey: 'key',
            youdaoAppSecret: 'secret',
        })).toBeNull();
        expect(getMissingCredentialMessage(services.tencent, {
            tencentSecretId: 'id',
        })).toContain('SecretKey');
        expect(getMissingCredentialMessage(services.tencent, {
            tencentSecretKey: 'key',
        })).toContain('SecretId');
    });

});


describe('自定义请求头格式与合并边界', () => {
    it('接受空值、稳定会话头和字符串 JSON，名称大小写无关且不修改输入', async () => {
        const {parseCustomHeaders, isValidCustomHeaders, mergeCustomHeaders} = await import('@/src/core/config/customHeaders');
        expect(parseCustomHeaders()).toEqual({});
        expect(parseCustomHeaders('')).toEqual({});
        expect(parseCustomHeaders('  ')).toEqual({});
        expect(parseCustomHeaders('{"X-Session":"  stable  ","X-Empty":""}')).toEqual({'x-session': 'stable', 'x-empty': ''});
        expect(isValidCustomHeaders('{}')).toBe(true);
        const defaults = {Authorization: 'Bearer default', 'Content-Type': 'application/json'};
        expect(mergeCustomHeaders(defaults, {authorization: 'Bearer custom'})).toEqual({authorization: 'Bearer custom', 'content-type': 'application/json'});
        expect(defaults.Authorization).toBe('Bearer default');
        expect(mergeCustomHeaders(undefined, {})).toEqual({});
    });

    it('拒绝数组、非字符串值、非法头名、控制字符和不能编码的值', async () => {
        const {parseCustomHeaders, isValidCustomHeaders} = await import('@/src/core/config/customHeaders');
        for (const raw of ['{oops', 'null', '[]', '42', {}, '{"x":1}', '{"x":null}', '{"x":true}', '{"x":{}}', '{"": "x"}', '{"bad name":"x"}', JSON.stringify({'x': 'a\r\nb'}), JSON.stringify({'x': '\0'}), '{"x":"中文"}']) {
            expect(parseCustomHeaders(raw)).toBeUndefined();
            expect(isValidCustomHeaders(raw)).toBe(false);
        }
        expect(parseCustomHeaders('{"__proto__":"value","X":"last"}')).toEqual(JSON.parse('{"__proto__":"value","x":"last"}'));
    });
});
