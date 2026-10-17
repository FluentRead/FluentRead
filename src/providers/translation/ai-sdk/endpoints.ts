/**
 * @file src/providers/translation/ai-sdk/endpoints.ts
 *
 * 文件职责：解析使用 Vercel AI SDK 的 OpenAI 兼容服务端点，统一 common、custom、New API、Azure、MiniMax 与 MiMo 的路由差异。
 * 主要内容：为翻译及阅读/写作共用官方 MiMo 端点的退役编号映射，保留第三方别名；声明 transport profile、服务 ID 和 endpoint 配置类型，补全自定义服务的根地址和版本 Base URL，保留完整或非标准接口，并由 resolveOpenAICompatibleEndpoint 返回 baseURL、route 与兼容参数。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {getMimoEndpoint, MIMO_ENDPOINTS, MINIMAX_ENDPOINTS, urls} from '@/src/core/config/constants';
import {referenceAiPlatformServices, services} from '@/src/core/config/catalog';
import {migrateModelIdentifier} from '@/src/core/config/model';
import {normalizeAzureEndpoint} from '@/src/core/config/azure';
import {
    getCustomOpenAIProvider,
    isCustomOpenAIProviderId,
    LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
    type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI';

export type AiSdkEndpointRoute = 'common' | 'custom' | 'newapi' | 'azure';

export const AI_SDK_TRANSPORT_PROFILE = 'vercel-ai-sdk-openai-compatible-v1' as const;

export interface AiSdkEndpointConfig {
    proxy?: Record<string, string | undefined>;
    custom?: string;
    customOpenAIProviders?: readonly CustomOpenAIProvider[];
    newApiUrl?: string;
    azureOpenaiEndpoint?: string;
    minimaxBillingPlan?: string;
    minimaxRegion?: string;
    mimoBillingPlan?: string;
    mimoRegion?: string;
}

export interface OpenAICompatibleEndpointResolution {
    /** 当前 FluentRead 适配器实际调用的规范 URL。 */
    endpoint: string;
    /** 传给 OpenAI 兼容 provider 的 URL 前缀，provider 会在其后追加 `/chat/completions`。 */
    baseURL: string;
    /** 从 endpoint 中移除、并在创建 provider 时单独传入的查询参数。 */
    queryParams?: Record<string, string>;
    /**
     * 无法用 baseURL 与 provider 查询记录无损表达的 endpoint，例如非标准路径或
     * 重复查询键。SDK 适配器会把注入的 fetch 目标改写为此 URL。
     */
    exactEndpoint?: string;
}

export type ResolvedOpenAICompatibleEndpoint = OpenAICompatibleEndpointResolution;

export const AI_SDK_COMMON_SERVICE_IDS = Object.freeze([
    services.yiyan,
    services.infini,
    services.minimax,
    services.mimo,
    services.openai,
    services.moonshot,
    services.baichuan,
    services.lingyi,
    services.jieyue,
    services.groq,
    services.huanYuan,
    services.doubao,
    services.siliconCloud,
    services.openrouter,
    services.grok,
    // OpenAI 兼容平台使用标准 chat/completions，直接复用通用路由。
    ...referenceAiPlatformServices,
]);

export const AI_SDK_SERVICE_IDS = Object.freeze([
    ...AI_SDK_COMMON_SERVICE_IDS,
    services.custom,
    services.newapi,
    services.azureOpenai,
]);

const commonServices = new Set<string>(AI_SDK_COMMON_SERVICE_IDS);

function parseAbsoluteEndpoint(rawEndpoint: string | undefined, label: string): URL {
    const endpoint = rawEndpoint?.trim();
    if (!endpoint) throw new Error(`${label}未配置`);

    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`${label}格式不正确`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${label}仅支持 HTTP 或 HTTPS 协议`);
    }

    url.hash = '';
    return url;
}

function withoutTrailingSlash(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** 只补全明确的 Base URL；其余路径仍视为用户指定的完整接口，不推测供应商路由。 */
function normalizeCustomEndpoint(rawEndpoint: string, label: string): string {
    const url = parseAbsoluteEndpoint(rawEndpoint, label);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) url.pathname = '/v1/chat/completions';
    else if (/\/v\d+$/.test(path)) url.pathname = `${path}/chat/completions`;
    return url.toString();
}

/**
 * 将完整的 Chat Completions URL 拆分为 OpenAI 兼容 provider 所需字段。
 * 非标准路径会保留 exactEndpoint 标记，使共享 fetch 包装器维持配置中的直接目标。
 */
export function parseChatCompletionsEndpoint(
    rawEndpoint: string,
    label = '翻译服务接口地址',
): OpenAICompatibleEndpointResolution {
    const url = parseAbsoluteEndpoint(rawEndpoint, label);
    const queryEntries = [...url.searchParams.entries()];
    const hasDuplicateQueryKeys = new Set(queryEntries.map(([key]) => key)).size !== queryEntries.length;
    const parsedQueryParams = Object.fromEntries(queryEntries);
    const queryParams = Object.keys(parsedQueryParams).length > 0 ? parsedQueryParams : undefined;
    url.search = '';

    const standardPath = url.pathname.match(/^(.*)\/chat\/completions\/?$/);
    if (standardPath) {
        const endpointUrl = new URL(rawEndpoint.trim());
        endpointUrl.hash = '';
        endpointUrl.pathname = endpointUrl.pathname.replace(/\/$/, '');

        url.pathname = standardPath[1] || '/';
        const resolution: OpenAICompatibleEndpointResolution = {
            endpoint: endpointUrl.toString(),
            baseURL: withoutTrailingSlash(url.toString()),
        };
        if (hasDuplicateQueryKeys) resolution.exactEndpoint = endpointUrl.toString();
        else resolution.queryParams = queryParams;
        return resolution;
    }

    const exactUrl = new URL(rawEndpoint.trim());
    exactUrl.hash = '';
    return {
        endpoint: exactUrl.toString(),
        baseURL: withoutTrailingSlash(url.toString()),
        queryParams,
        exactEndpoint: exactUrl.toString(),
    };
}

/** 与现有 New API 适配器的 URL 补全规则保持一致。 */
export function normalizeNewApiEndpoint(rawEndpoint: string): string {
    const url = parseAbsoluteEndpoint(rawEndpoint, 'New API 地址');
    const path = url.pathname.replace(/\/+$/, '');

    if (/\/chat\/completions$/.test(path)) {
        url.pathname = path;
    } else if (/\/v1$/.test(path)) {
        url.pathname = `${path}/chat/completions`;
    } else {
        url.pathname = `${path}/v1/chat/completions`;
    }

    return url.toString();
}

export function getAiSdkEndpointRoute(service: string): AiSdkEndpointRoute | null {
    if (commonServices.has(service)) return 'common';
    if (isCustomOpenAIProviderId(service)) return 'custom';
    if (service === services.newapi) return 'newapi';
    if (service === services.azureOpenai) return 'azure';
    return null;
}

function resolveCommonEndpoint(service: string, config: AiSdkEndpointConfig): string {
    const proxy = config.proxy?.[service]?.trim();
    if (proxy) return proxy;

    if (service === services.minimax) {
        const plan = config.minimaxBillingPlan === 'token-plan' ? 'token-plan' : 'payg';
        const region = config.minimaxRegion === 'global' ? 'global' : 'cn';
        return MINIMAX_ENDPOINTS[plan][region];
    }

    if (service === services.mimo) {
        return getMimoEndpoint(config.mimoBillingPlan || 'payg', config.mimoRegion || 'cn');
    }

    const endpoint = urls[service];
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
        throw new Error(`未找到翻译服务接口: ${service}`);
    }
    return endpoint;
}

export function resolveOpenAICompatibleEndpoint(
    service: string,
    config: AiSdkEndpointConfig,
): ResolvedOpenAICompatibleEndpoint {
    const route = getAiSdkEndpointRoute(service);
    if (!route) throw new Error(`翻译服务尚未纳入 AI SDK 端点解析: ${service}`);

    let endpoint: string;
    switch (route) {
        case 'common':
            endpoint = resolveCommonEndpoint(service, config);
            break;
        case 'custom':
            endpoint = config.proxy?.[service]?.trim()
                || normalizeCustomEndpoint(
                    getCustomOpenAIProvider(config.customOpenAIProviders, service)?.endpoint
                    || (service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID ? config.custom : '')
                    || '',
                    `${service} 接口地址`,
                );
            break;
        case 'newapi':
            endpoint = normalizeNewApiEndpoint(config.newApiUrl || '');
            break;
        case 'azure':
            endpoint = normalizeAzureEndpoint(config.azureOpenaiEndpoint || '');
            break;
    }

    return parseChatCompletionsEndpoint(endpoint, `${service} 接口地址`);
}

const officialMimoOrigins = new Set(Object.values(MIMO_ENDPOINTS)
    .flatMap(regions => Object.values(regions))
    .map(endpoint => new URL(endpoint).origin));

/** 端点已由解析器验证；只对精确官方 HTTPS origin 应用已登记迁移，不改保存配置。 */
export function resolveOfficialMimoModel(endpoint: string, model: string): string {
    return officialMimoOrigins.has(new URL(endpoint).origin)
        ? migrateModelIdentifier(services.mimo, model)
        : model;
}
