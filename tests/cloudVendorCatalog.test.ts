import {describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {}}));
import {
    cloudCredentialLabels,
    cloudRegionOptions,
    cloudVendorServices,
    getCloudCredentialLabels,
    getDefaultCloudRegion,
    options,
    referenceAiPlatformServices,
    resolveCloudRegion,
    services,
    servicesType,
} from '@/src/core/config/catalog';
import {
    AZURE_TRANSLATOR_ENDPOINT,
    DEFAULT_OLLAMA_ENDPOINT,
    getAliyunTranslationEndpoint,
    getHuanYuanEndpoint,
    urls,
    VOLC_TRANSLATION_ENDPOINT,
} from '@/src/core/config/constants';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {extractConfigCredentials, hasCredentialData} from '@/src/core/config/credentials';
import {dropCredentialsForChangedDestinations} from '@/src/core/config/credentialBinding';
import {buildCredentialPreviewChanges} from '@/src/features/settings/model/credentialPreview';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {AI_SDK_COMMON_SERVICE_IDS, getAiSdkEndpointRoute, resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {
    buildServiceSections,
    getServiceCredentialGuide,
    getServiceWebsite,
    searchServiceOptions,
} from '@/src/ui/view-model/serviceCatalog';
import {translateLegacyText} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

const newCloudServices = [
    services.googleCloudTranslation,
    services.azureTranslator,
    services.aliyunTranslation,
    services.baiduTranslation,
    services.volcTranslation,
];

describe('云服务厂商目录', () => {
    it('云服务厂商同时属于机器翻译阵营，并与免费网页端点保持独立标识', () => {
        expect([...cloudVendorServices]).toEqual([services.tencent, ...newCloudServices]);
        for (const service of cloudVendorServices) {
            expect(servicesType.isCloudVendor(service), service).toBe(true);
            expect(servicesType.isMachine(service), service).toBe(true);
            expect(servicesType.isAI(service), service).toBe(false);
        }
        expect(servicesType.isCloudVendor(services.google)).toBe(false);
        expect(servicesType.isCloudVendor(services.microsoft)).toBe(false);
        expect(servicesType.isCloudVendor(services.openai)).toBe(false);
    });

    it('主密钥沿用 token，第二段密钥与地域由凭据名称表和白名单派生', () => {
        for (const service of newCloudServices) expect(servicesType.isUseToken(service), service).toBe(true);
        expect(servicesType.isUseToken(services.tencent)).toBe(false);
        expect([...servicesType.useSecret].sort()).toEqual(
            Object.entries(cloudCredentialLabels).filter(([, labels]) => 'secret' in labels).map(([service]) => service).sort(),
        );
        expect(servicesType.isUseSecret(services.aliyunTranslation)).toBe(true);
        expect(servicesType.isUseSecret(services.googleCloudTranslation)).toBe(false);
        expect(servicesType.isUseRegion(services.azureTranslator)).toBe(true);
        expect(servicesType.isUseRegion(services.baiduTranslation)).toBe(false);
        expect(getCloudCredentialLabels(services.baiduTranslation)).toEqual({token: 'APP ID', secret: '密钥'});
        expect(getCloudCredentialLabels(services.openai)).toEqual({token: 'API Key'});
        expect(getCloudCredentialLabels('__proto__')).toEqual({token: 'API Key'});
    });

    it('地域只接受白名单取值，未知值回落默认地域，不需要地域的服务返回空', () => {
        for (const service of servicesType.useRegion) {
            expect(cloudRegionOptions[service]?.length, service).toBeGreaterThan(0);
            expect(getDefaultCloudRegion(service)).toBe(cloudRegionOptions[service]![0]!.value);
            expect(resolveCloudRegion(service, undefined)).toBe(getDefaultCloudRegion(service));
            expect(resolveCloudRegion(service, ' unknown-region ')).toBe(getDefaultCloudRegion(service));
        }
        expect(resolveCloudRegion(services.azureTranslator, 'westeurope')).toBe('westeurope');
        // #653：日本西部等官方 Translator 区域不能在保存或请求时被静默回落到 global。
        for (const region of ['japanwest', 'koreacentral', 'eastus2', 'northeurope', 'southafricanorth']) {
            expect(resolveCloudRegion(services.azureTranslator, region)).toBe(region);
        }
        const azureRegions = cloudRegionOptions[services.azureTranslator]!.map(option => option.value);
        expect(new Set(azureRegions).size).toBe(azureRegions.length);
        for (const region of azureRegions) expect(region, region).toMatch(/^[a-z0-9]+$/u);
        expect(resolveCloudRegion(services.aliyunTranslation, ' ap-southeast-1 ')).toBe('ap-southeast-1');
        expect(getDefaultCloudRegion(services.openai)).toBe('');
        expect(resolveCloudRegion(services.openai, 'cn-north-1')).toBe('');
    });

    it('端点常量覆盖每个新服务，阿里云按地域切换域名', () => {
        for (const service of [...newCloudServices, ...referenceAiPlatformServices]) {
            expect(urls[service], service).toMatch(/^https?:\/\//u);
        }
        expect(urls[services.azureTranslator]).toBe(AZURE_TRANSLATOR_ENDPOINT);
        expect(urls[services.volcTranslation]).toBe(VOLC_TRANSLATION_ENDPOINT);
        expect(urls[services.ollama]).toBe(DEFAULT_OLLAMA_ENDPOINT);
        expect(getAliyunTranslationEndpoint()).toBe('https://mt.cn-hangzhou.aliyuncs.com/');
        expect(getAliyunTranslationEndpoint('ap-southeast-1')).toBe('https://mt.ap-southeast-1.aliyuncs.com/');
        expect(getAliyunTranslationEndpoint('evil.example.com/')).toBe('https://mt.cn-hangzhou.aliyuncs.com/');
        expect(getHuanYuanEndpoint()).toBe('https://tokenhub-intl.tencentmaas.com/v1/chat/completions');
        expect(getHuanYuanEndpoint('ap-singapore')).toBe('https://tokenhub-intl.tencentmaas.com/v1/chat/completions');
        expect(getHuanYuanEndpoint('ap-guangzhou')).toBe('https://tokenhub.tencentmaas.com/v1/chat/completions');
        expect(getHuanYuanEndpoint('evil.example.com/')).toBe('https://tokenhub-intl.tencentmaas.com/v1/chat/completions');
    });

    it('目录中“云服务厂商”分组位于机器翻译与 AI 翻译之间，且不重复列出免费端点', () => {
        const values = options.services.map((option) => option.value);
        const machineIndex = values.indexOf('machine');
        const cloudIndex = values.indexOf('cloud');
        const aiIndex = values.indexOf('ai');
        expect(machineIndex).toBeLessThan(cloudIndex);
        expect(cloudIndex).toBeLessThan(aiIndex);
        expect(values.slice(cloudIndex + 1, aiIndex)).toEqual([...cloudVendorServices]);
        expect(values.slice(machineIndex + 1, cloudIndex)).not.toContain(services.tencent);
        expect(values.filter((value) => value === services.tencent)).toHaveLength(1);
        for (const service of cloudVendorServices) {
            expect(options.services.find((option) => option.value === service)?.description, service).toMatch(/免费额度/u);
        }
        const sections = buildServiceSections(options.services);
        const cloudSection = sections.find((section) => section.id === 'cloud')!;
        expect(cloudSection.collapsible).toBe(true);
        expect(cloudSection.groups[0]!.itemKind).toBe('云服务厂商');
        expect(cloudSection.groups[0]!.items.map((item) => item.value)).toEqual([...cloudVendorServices]);
        expect(sections.find((section) => section.id === 'ai')!.collapsible).toBe(false);
    });

    it('目录搜索命中云厂商的英文别名', () => {
        const hits = searchServiceOptions(options.services, 'volcengine', new Map());
        expect(hits.map((item) => item.value)).toEqual([services.volcTranslation]);
        expect(searchServiceOptions(options.services, 'gcp', new Map()).map((item) => item.value))
            .toEqual([services.googleCloudTranslation]);
    });

    it('每个云服务厂商都有免费额度、控制台与文档链接的开通指引', () => {
        for (const service of cloudVendorServices) {
            const guide = getServiceCredentialGuide(service)!;
            expect(guide, service).toBeDefined();
            expect(guide.freeQuota).toMatch(/免费/u);
            expect(guide.steps.length).toBeGreaterThanOrEqual(3);
            for (const url of [guide.consoleUrl, guide.docsUrl]) {
                const parsed = new URL(url);
                expect(parsed.protocol).toBe('https:');
                expect(`${parsed.username}${parsed.password}`).toBe('');
            }
            expect(getServiceWebsite(service)?.kind).toBe('website');
        }
        for (const service of [services.google, services.openai, services.ollama, '__proto__', 'constructor']) {
            expect(getServiceCredentialGuide(service), service).toBeUndefined();
        }
    });
});

describe('OpenAI 兼容平台目录', () => {
    it('全部走 AI SDK 通用路由，Ollama 免密钥且默认指向本机', () => {
        for (const service of referenceAiPlatformServices) {
            expect(servicesType.isAI(service), service).toBe(true);
            expect(servicesType.isAiSdk(service), service).toBe(true);
            expect(servicesType.isUseModel(service), service).toBe(true);
            expect(servicesType.isUseProxy(service), service).toBe(true);
            expect(AI_SDK_COMMON_SERVICE_IDS).toContain(service);
            expect(getAiSdkEndpointRoute(service)).toBe('common');
            expect(getServiceWebsite(service)?.kind).toBe('website');
            expect(servicesType.isUseToken(service)).toBe(service !== services.ollama && service !== services.rapidmlx);
        }
        expect(resolveOpenAICompatibleEndpoint(services.ollama, {proxy: {}}).baseURL).toBe('http://127.0.0.1:11434/v1');
        expect(resolveOpenAICompatibleEndpoint(services.ollama, {proxy: {[services.ollama]: 'http://192.168.1.8:11434/v1/chat/completions'}}).baseURL)
            .toBe('http://192.168.1.8:11434/v1');
        expect(resolveOpenAICompatibleEndpoint(services.cohere, {proxy: {}}).baseURL).toBe('https://api.cohere.ai/compatibility/v1');
        expect(getMissingCredentialMessage(services.ollama, {token: {}})).toBeNull();
        expect(getMissingCredentialMessage(services.mistral, {token: {}})).toContain('API Key');
    });
});

describe('云服务厂商凭据的配置领域规则', () => {
    it('缺失凭据提示按厂商命名两段密钥，配置完整后不再提示', () => {
        expect(getMissingCredentialMessage(services.aliyunTranslation, {token: {}}))
            .toBe('阿里云机器翻译 需要 AccessKey ID 和 AccessKey Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。');
        expect(getMissingCredentialMessage(services.baiduTranslation, {token: {[services.baiduTranslation]: 'app'}, secret: {}}))
            .toContain('APP ID 和 密钥');
        expect(getMissingCredentialMessage(services.volcTranslation, {token: {}, secret: {[services.volcTranslation]: 'sk'}}))
            .toContain('Access Key ID 和 Secret Access Key');
        expect(getMissingCredentialMessage(services.volcTranslation, {
            token: {[services.volcTranslation]: ' ak '}, secret: {[services.volcTranslation]: ' sk '},
        })).toBeNull();
        expect(getMissingCredentialMessage(services.googleCloudTranslation, {token: {}}))
            .toBe('谷歌云翻译 需要 API Key，当前尚未配置；请先在设置中填写，再开始翻译。');
        expect(getMissingCredentialMessage(services.azureTranslator, {token: {}}))
            .toContain('Azure 翻译 需要 密钥（Key）');
        expect(getMissingCredentialMessage(services.azureTranslator, {token: {[services.azureTranslator]: 'k'}})).toBeNull();
        expect(getMissingCredentialMessage(services.deepseek, {token: {}})).toContain('API Key（访问令牌）');
    });

    it('缺失凭据提示与输入占位符在非中文界面完整本地化', () => {
        const messages = [
            getMissingCredentialMessage(services.aliyunTranslation, {token: {}})!,
            getMissingCredentialMessage(services.baiduTranslation, {token: {}})!,
            getMissingCredentialMessage(services.googleCloudTranslation, {token: {}})!,
            getMissingCredentialMessage(services.azureTranslator, {token: {}})!,
            '输入 AccessKey ID；留空表示尚未配置',
            '输入 密钥；留空表示尚未配置',
        ];
        for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
            for (const message of messages) {
                const localized = translateLegacyText(message, language);
                expect(localized, `${language}: ${message}`).not.toBe(message);
                if (language !== 'ja-JP') expect(localized, `${language}: ${message}`).not.toMatch(/[㐀-鿿]/u);
            }
            for (const {value, label} of Object.values(cloudRegionOptions).flat()) {
                const localized = translateLegacyText(label, language);
                expect(localized, `${language}: ${label}`).toContain(value);
                // 日文的 Azure 官方地名可能与中文同形（如「英国南部」），其余语言不得残留中文。
                if (language !== 'ja-JP') expect(localized, `${language}: ${label}`).not.toMatch(/[㐀-鿿]/u);
            }
            expect(translateLegacyText('云服务厂商', language)).not.toBe('云服务厂商');
            expect(translateLegacyText('谷歌云翻译', language)).toBe('Google Cloud Translation');
            const guide = getServiceCredentialGuide(services.aliyunTranslation)!;
            for (const text of [guide.freeQuota, guide.consoleLabel, guide.docsLabel, ...guide.steps]) {
                const localized = translateLegacyText(text, language);
                expect(localized, `${language}: ${text}`).not.toBe(text);
            }
        }
        expect(translateLegacyText('输入 AccessKey ID；留空表示尚未配置', 'en-US'))
            .toBe('Enter AccessKey ID; leave empty if it is not configured yet');
        expect(translateLegacyText(getMissingCredentialMessage(services.baiduTranslation, {token: {}})!, 'en-US'))
            .toBe('Baidu Translate requires APP ID and Secret key, which are not fully configured. Add them in settings before translating.');
    });

    it('secret 与 serviceRegion 被规范化：丢弃非字符串、退役服务与白名单外地域', () => {
        const normalized = normalizeConfig({
            ...new Config(),
            secret: {[services.aliyunTranslation]: 'sk', cozecom: 'stale', broken: 42},
            serviceRegion: {
                [services.azureTranslator]: 'japanwest',
                [services.aliyunTranslation]: 'mars-1',
                [services.openai]: 'us-east-1',
                [services.volcTranslation]: 7,
            },
        } as unknown as Partial<Config>);
        expect(normalized.secret).toEqual({[services.aliyunTranslation]: 'sk'});
        expect(normalized.serviceRegion).toEqual({
            [services.azureTranslator]: 'japanwest',
            [services.aliyunTranslation]: 'cn-hangzhou',
        });
        expect(normalizeConfig({...new Config(), secret: 'nope', serviceRegion: null} as unknown as Partial<Config>))
            .toMatchObject({secret: {}, serviceRegion: {}});
        expect(new Config()).toMatchObject({secret: {}, serviceRegion: {}});
    });

    it('secret 是敏感凭据：进入凭据快照、参与非空判断并从公开配置剥离', () => {
        const credentials = extractConfigCredentials({secret: {[services.baiduTranslation]: 'key', bad: 1}});
        expect(credentials.secret).toEqual({[services.baiduTranslation]: 'key'});
        expect(hasCredentialData(credentials)).toBe(true);
        expect(hasCredentialData(extractConfigCredentials({secret: {}}))).toBe(false);
        expect(extractConfigCredentials({secret: 'oops'}).secret).toEqual({});

        const snapshot = createTranslationProviderConfigSnapshot({
            ...new Config(),
            secret: {[services.volcTranslation]: 'sk'},
            serviceRegion: {[services.volcTranslation]: 'ap-southeast-1'},
        });
        expect(snapshot.secret).toEqual({[services.volcTranslation]: 'sk'});
        expect(snapshot.serviceRegion).toEqual({[services.volcTranslation]: 'ap-southeast-1'});
        expect(Object.isFrozen(snapshot.secret)).toBe(true);
        expect(Object.isFrozen(snapshot.serviceRegion)).toBe(true);
        expect(createTranslationProviderConfigSnapshot({...new Config(), secret: undefined}).secret).toEqual({});
    });

    it('secret 跟随同一服务的目标地址解绑，显式绑定的服务除外', () => {
        const current = normalizeConfig({...new Config()});
        const next = normalizeConfig({...new Config(), proxy: {[services.openai]: 'https://relay.example.com/v1/chat/completions'}});
        const credentials = extractConfigCredentials({
            token: {[services.openai]: 'tok', [services.aliyunTranslation]: 'ak'},
            secret: {[services.openai]: 'paired', [services.aliyunTranslation]: 'sk'},
        });
        const dropped = dropCredentialsForChangedDestinations(credentials, current, next);
        expect(dropped.secret).toEqual({[services.aliyunTranslation]: 'sk'});
        expect(dropped.token).toEqual({[services.aliyunTranslation]: 'ak'});

        const kept = dropCredentialsForChangedDestinations(credentials, current, next, new Set([services.openai]));
        expect(kept).toBe(credentials);
        expect(dropCredentialsForChangedDestinations(credentials, current, current)).toBe(credentials);
    });

    it('导入预览分别列出云厂商的主密钥与第二段密钥', () => {
        const changes = buildCredentialPreviewChanges(
            {token: {}, secret: {}},
            {token: {[services.aliyunTranslation]: 'ak'}, secret: {[services.aliyunTranslation]: 'sk', [services.openai]: 'x', ghost: 'y'}},
        );
        expect(changes.map((change) => [change.key, change.label])).toEqual([
            [`token.${services.aliyunTranslation}`, '阿里云机器翻译 AccessKey ID'],
            [`secret.${services.aliyunTranslation}`, '阿里云机器翻译 AccessKey Secret'],
            [`secret.${services.openai}`, 'OpenAI Secret'],
            ['secret.ghost', 'ghost Secret'],
        ]);
        expect(changes.every((change) => !change.before.includes('sk') && !change.after.includes('sk'))).toBe(true);
    });

    it('旧版导入合并 secret 映射，未提供时保留当前值', () => {
        const current = normalizeConfig({
            ...new Config(),
            token: {[services.baiduTranslation]: 'app'},
            secret: {[services.baiduTranslation]: 'old', [services.aliyunTranslation]: 'keep'},
        });
        const merged = prepareConfigForImport({
            ...current,
            secret: {[services.baiduTranslation]: 'new'},
        }, current);
        expect(merged.secret).toEqual({[services.baiduTranslation]: 'new', [services.aliyunTranslation]: 'keep'});
        const {secret: _omitted, ...withoutSecret} = current;
        const untouched = prepareConfigForImport({...withoutSecret, token: {}}, current);
        expect(untouched.secret).toEqual(current.secret);
    });
});
