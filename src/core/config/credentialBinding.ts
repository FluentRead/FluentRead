/**
 * @file src/core/config/credentialBinding.ts
 * 文件职责：把服务凭据绑定到请求实际抵达的配置地址，防止配置替换后把旧密钥带到另一端点。
 * 主要内容：按 provider 的真实路由计算 token、自定义请求头与腾讯共享密钥的目标身份；在单次解绑中复用服务比较与自定义端点索引，目标变化且未显式重绑时丢弃旧凭据。
 * 模块边界：本文件只做 Config、凭据映射与 URL 的纯比较，不读取存储、不执行请求；调用方仍负责配置合并与持久化。
 */
import {
    currentModelIds,
    resolveConfiguredModel,
    services,
    servicesType,
} from './catalog';
import {
    getAliyunTranslationEndpoint,
    getHuanYuanEndpoint,
    getMimoEndpoint,
    MINIMAX_ENDPOINTS,
    tongyiTokenPlanUrl,
    urls,
} from './constants';
import {isCustomOpenAIProviderId} from './customOpenAI';
import {DEFAULT_DEEPLX_ENDPOINT, parseDeepLXEndpoints} from './deeplx';
import {getDeepLEndpoint} from './deepl';
import {normalizeAzureEndpoint} from './azure';
import type {ConfigCredentialField, ConfigCredentials} from './credentials';
import type {Config} from './model';

function canonicalFetchEndpoint(value: string): string {
    const endpoint = value.trim();
    if (!endpoint) return '';
    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return endpoint;
        url.hash = '';
        return url.toString();
    } catch {
        return endpoint;
    }
}

function canonicalOpenAICompatibleEndpoint(value: string, normalizeCustomBase = false): string {
    const endpoint = canonicalFetchEndpoint(value);
    try {
        const url = new URL(endpoint);
        if (normalizeCustomBase && (url.protocol === 'http:' || url.protocol === 'https:')) {
            const path = url.pathname.replace(/\/+$/u, '');
            if (!path) url.pathname = '/v1/chat/completions';
            else if (/\/v\d+$/u.test(path)) url.pathname = `${path}/chat/completions`;
        }
        url.searchParams.sort();
        if (/\/chat\/completions\/$/u.test(url.pathname)) {
            url.pathname = url.pathname.slice(0, -1);
        }
        return url.toString();
    } catch {
        return endpoint;
    }
}

function canonicalNewApiEndpoint(value: string): string {
    const endpoint = value.trim();
    if (!endpoint) return '';
    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return endpoint;
        url.hash = '';
        url.searchParams.sort();
        const path = url.pathname.replace(/\/+$/u, '');
        if (/\/chat\/completions$/u.test(path)) url.pathname = path;
        else if (/\/v1$/u.test(path)) url.pathname = `${path}/chat/completions`;
        else url.pathname = `${path}/v1/chat/completions`;
        return url.toString();
    } catch {
        return endpoint;
    }
}

function canonicalAzureEndpoint(value: string): string {
    try {
        return canonicalOpenAICompatibleEndpoint(normalizeAzureEndpoint(value));
    } catch {
        // 未补全的旧配置保留原始身份，配置加载和无关编辑不应使既有凭据丢失。
        return canonicalOpenAICompatibleEndpoint(value);
    }
}

function configuredTongyiDestinations(config: Config): string {
    const service = services.tongyi;
    const configuredModels = [
        resolveConfiguredModel(config.model[service], config.customModel[service]),
        resolveConfiguredModel(config.documentModel[service], config.documentCustomModel[service]),
    ];
    return Array.from(new Set(configuredModels.map((model) => (
        model === currentModelIds.tongyiTokenPlan
            ? canonicalFetchEndpoint(tongyiTokenPlanUrl)
            : canonicalFetchEndpoint(String(urls[service]))
    )))).sort().join('|');
}

function configuredDeepLXDestinations(config: Config): string {
    const proxyEndpoints = parseDeepLXEndpoints(config.proxy[services.deeplx]);
    const configuredEndpoints = proxyEndpoints.length > 0
        ? proxyEndpoints
        : parseDeepLXEndpoints(config.deeplx);
    // URL 本身可以包含竖线，使用结构化列表避免与多目标身份碰撞。
    return JSON.stringify((configuredEndpoints.length > 0 ? configuredEndpoints : [DEFAULT_DEEPLX_ENDPOINT])
        .map(canonicalFetchEndpoint)
        .sort());
}

function urlDestination(service: string, value: string): string {
    const endpoint = servicesType.isAiSdk(service)
        ? canonicalOpenAICompatibleEndpoint(value)
        : canonicalFetchEndpoint(value);
    return `urls:${endpoint}`;
}

// 这些 adapter 直接调用官方端点，不消费通用 proxy；Azure 的地域头、
// 火山的签名地域也不改变接收密钥的主机。腾讯与混元翻译确实消费 proxy，
// 继续走下方通用分支，不能仅按云厂商分组忽略其真实改道。
const FIXED_TRANSLATION_DESTINATIONS = new Set<string>([
    services.googleCloudTranslation,
    services.azureTranslator,
    services.baiduTranslation,
    services.volcTranslation,
    services.youdao,
]);

function tokenCredentialDestination(config: Config, service: string, customEndpoint: (service: string) => string): string {
    if (isCustomOpenAIProviderId(service)) {
        const proxy = config.proxy[service]?.trim();
        if (proxy) return urlDestination(service, proxy);
        const endpoint = customEndpoint(service) || (service === services.custom ? config.custom : '');
        return `urls:${canonicalOpenAICompatibleEndpoint(endpoint, true)}`;
    }
    // AI SDK 的 NewAPI/Azure 路由不读取通用 proxy，必须按真实直连字段绑定。
    if (service === services.newapi) return `urls:${canonicalNewApiEndpoint(config.newApiUrl)}`;
    if (service === services.azureOpenai) return `urls:${canonicalAzureEndpoint(config.azureOpenaiEndpoint)}`;
    // Gemini 保留同一服务的 Key，不因代理开关或地址变化清除；代理不自动携带
    // x-goog-api-key，但配置了 {key} 的 URL 模板会使用这个保留的 Key。
    if (service === services.gemini) return urlDestination(service,
        'https://generativelanguage.googleapis.com/',
    );
    if (service === services.deeplx) return `urls:${configuredDeepLXDestinations(config)}`;
    if (service === services.aliyunTranslation) {
        return urlDestination(service, getAliyunTranslationEndpoint(config.serviceRegion?.[service]));
    }
    if (FIXED_TRANSLATION_DESTINATIONS.has(service)) return urlDestination(service, urls[service]);
    const proxy = config.proxy[service]?.trim();
    if (proxy) return urlDestination(service, proxy);
    if (service === services.deepL) return urlDestination(service, getDeepLEndpoint(config.deeplApiPlan));
    if (service === services.minimax) {
        const plan = config.minimaxBillingPlan === 'token-plan' ? 'token-plan' : 'payg';
        const region = config.minimaxRegion === 'global' ? 'global' : 'cn';
        return urlDestination(service, MINIMAX_ENDPOINTS[plan][region]);
    }
    if (service === services.mimo) {
        return urlDestination(service, getMimoEndpoint(config.mimoBillingPlan, config.mimoRegion));
    }
    if (service === services.huanYuan) {
        return urlDestination(service, getHuanYuanEndpoint(config.serviceRegion?.[service]));
    }
    if (service === services.tongyi) {
        return `urls:${configuredTongyiDestinations(config)}`;
    }
    const officialEndpoint = urls[service];
    return typeof officialEndpoint === 'string' && officialEndpoint.trim()
        ? urlDestination(service, officialEndpoint)
        : `service:${service}`;
}

function createCustomEndpointLookup(config: Config): (service: string) => string {
    const providers = config.customOpenAIProviders ?? [];
    const indexed = new Map<string, (typeof providers)[number]>();
    let index = 0;
    return (service) => {
        if (indexed.has(service)) return indexed.get(service)!.endpoint || '';
        // 只扫描到第一个匹配项；多服务查询累计最多遍历一次列表。
        while (index < providers.length) {
            const provider = providers[index++]!;
            const id = provider.id;
            if (!indexed.has(id)) indexed.set(id, provider);
            if (id === service) return indexed.get(id)!.endpoint || '';
        }
        return '';
    };
}

const TENCENT_CREDENTIAL_FIELDS = [
    'tencentSecretId',
    'tencentSecretKey',
] as const satisfies readonly ConfigCredentialField[];

export function dropCredentialsForChangedDestinations(
    credentials: ConfigCredentials,
    current: Config,
    next: Config,
    explicitlyBoundTokens: ReadonlySet<string> = new Set(),
    explicitlyBoundCredentialFields: ReadonlySet<ConfigCredentialField> = new Set(),
    explicitlyBoundHeaders: ReadonlySet<string> = new Set(),
    explicitlyBoundApiKeys: ReadonlySet<string> = new Set(),
): ConfigCredentials {
    const changedDestinations = new Map<string, boolean>();
    const currentCustomEndpoint = createCustomEndpointLookup(current);
    const nextCustomEndpoint = createCustomEndpointLookup(next);
    const destinationChanged = (service: string): boolean => {
        const cached = changedDestinations.get(service);
        if (cached !== undefined) return cached;
        const changed = tokenCredentialDestination(current, service, currentCustomEndpoint)
            !== tokenCredentialDestination(next, service, nextCustomEndpoint);
        changedDestinations.set(service, changed);
        return changed;
    };
    const token = {...credentials.token};
    let tokenChanged = false;
    for (const service of Object.keys(token)) {
        if (!destinationChanged(service)) continue;
        if (explicitlyBoundTokens.has(service)) continue;
        tokenChanged = true;
        delete token[service];
    }

    const apiKeys: Record<string, string[]> = Object.fromEntries(Object.entries(credentials.apiKeys)
        .map(([service, keys]) => [service, [...keys]]));
    let apiKeysChanged = false;
    for (const service of Object.keys(apiKeys)) {
        if (!destinationChanged(service)) continue;
        if (explicitlyBoundApiKeys.has(service)) continue;
        delete apiKeys[service];
        apiKeysChanged = true;
    }
    let nextCredentials = tokenChanged || apiKeysChanged ? {...credentials, token, apiKeys} : credentials;
    // secret 与 token 是同一个服务的一对凭据，必须跟随同一个目标地址一起解绑，
    // 否则改过端点后会只剩半副密钥被发往新地址。
    const secret = {...credentials.secret};
    let secretChanged = false;
    for (const service of Object.keys(secret)) {
        if (!destinationChanged(service)) continue;
        if (explicitlyBoundTokens.has(service)) continue;
        secretChanged = true;
        delete secret[service];
    }
    if (secretChanged) nextCredentials = {...nextCredentials, secret};
    const customHeaders = {...credentials.customHeaders};
    for (const service of Object.keys(customHeaders)) {
        if (!destinationChanged(service)) continue;
        if (explicitlyBoundHeaders.has(service)) continue;
        delete customHeaders[service];
        nextCredentials = {...nextCredentials, customHeaders};
    }
    const explicitlyBoundTencentPair = TENCENT_CREDENTIAL_FIELDS.every((field) => (
        explicitlyBoundCredentialFields.has(field)
    ));
    if (!explicitlyBoundTencentPair
        && TENCENT_CREDENTIAL_FIELDS.some((field) => Boolean(nextCredentials[field]))
        && (destinationChanged(services.tencent) || destinationChanged(services.huanYuanTranslation))) {
        nextCredentials = {
            ...nextCredentials,
            tencentSecretId: '',
            tencentSecretKey: '',
        };
    }
    return nextCredentials;
}
