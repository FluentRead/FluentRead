/**
 * @file src/core/config/catalog.ts
 *
 * 文件职责：维护 FluentRead 翻译语言、服务与模型的领域目录，让设置、校验和运行时能够引用同一组稳定的服务标识与模型元数据。
 * 主要内容：明确区分简体中文和繁体中文，统一源语言、目标语言和输入框语言选项，并定义 services、servicesType、服务目录展示分类与排序（含“云服务厂商”分组）、模型候选、云厂商地域白名单、MiniMax 与 MiMo 的计费和地域选项，并提供 resolveConfiguredModel、resolveCloudRegion 等解析函数，把“自定义模型”选择归一为可请求的模型编号。 同时维护默认翻译提示词与历史默认提示词清单，供配置归一化升级未被用户改写的旧默认值。 可核对的公开符号包括 services、cloudVendorServices、referenceAiPlatformServices、servicesType、customModelString、cloudRegionOptions、getDefaultCloudRegion、resolveCloudRegion、minimaxBillingPlans、MiniMaxBillingPlan、minimaxRegions、MiniMaxRegion、mimoBillingPlans、defaultOption、LEGACY_DEFAULT_USER_ROLES。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；目录解析只接受表自身登记的键，未知服务、语言或界面语言按公开回退契约处理；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import {translationLanguageOptions} from '@/src/core/language/catalog';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {DEFAULT_DEEPLX_ENDPOINT} from "./deeplx";
import {CUSTOM_OPENAI_RESERVED_MODEL_ID, isCustomOpenAIProviderId} from './customOpenAI';
import {DOUBAO_SEED_TRANSLATION_MODEL_ID, isDoubaoSeedTranslationModel} from './doubaoSeedTranslation';
import {buildTranslationStyleOptions} from './translationAppearance';
import {
    LOCAL_TRANSLATION_MODELS,
    DEFAULT_LOCAL_TRANSLATION_MODEL,
    LOCAL_TRANSLATION_SERVICE_ID,
} from './localTranslation';

export const services = {
    // 机器翻译
    microsoft: "microsoft",
    freeTranslation: "freeTranslation",
    bilibili: "bilibili", // B站官方匿名文本翻译，独立服务与免费池共用适配器
    myMemory: "myMemory",
    deepL: "deepL",
    deeplx: "deeplx",
    google: "google",
    xiaoniu: "xiaoniu",
    youdao: "youdao",
    chromeTranslator: "chromeTranslator", // Chrome 内置翻译 API
    localTranslation: LOCAL_TRANSLATION_SERVICE_ID, // 浏览器内本地模型翻译
    // 云服务厂商机器翻译：使用云控制台签发的密钥调用官方接口，各家都提供免费额度
    tencent: "tencent", // 腾讯云机器翻译 TMT
    googleCloudTranslation: "googleCloudTranslation", // Google Cloud Translation API
    azureTranslator: "azureTranslator", // Azure AI Translator
    aliyunTranslation: "aliyunTranslation", // 阿里云机器翻译
    baiduTranslation: "baiduTranslation", // 百度翻译开放平台
    volcTranslation: "volcTranslation", // 火山引擎机器翻译
    // 大模型翻译
    openai: "openai",
    azureOpenai: "azureOpenai", // Azure 服务；保留旧 ID 以兼容已保存的配置和凭据
    gemini: "gemini",
    yiyan: "yiyan",
    tongyi: "tongyi",
    zhipu: "zhipu",
    moonshot: "moonshot",
    claude: "claude",
    custom: "custom",
    infini: "infini",
    baichuan: "baichuan",
    lingyi: "lingyi",
    deepseek: "deepseek",
    minimax: "minimax",
    mimo: "mimo", // 小米 MiMo
    jieyue: "jieyue", // 阶跃星辰
    groq: "groq",
    huanYuan: "huanYuan", // 腾讯混元
    huanYuanTranslation: "huanYuanTranslation", // 腾讯混元翻译大模型
    doubao: "doubao", // 字节豆包
    siliconCloud: "siliconCloud", // 硅流
    openrouter: "openrouter", // OpenRouter 聚合服务
    grok: "grok", // X.AI 的 Grok
    newapi: "newapi", // New API 接口
    ollama: "ollama", // 本地 Ollama 运行时
    mistral: "mistral", // Mistral AI
    cohere: "cohere", // Cohere
    togetherai: "togetherai", // Together AI
    fireworks: "fireworks", // Fireworks AI
    cerebras: "cerebras", // Cerebras
    deepinfra: "deepinfra", // DeepInfra
    perplexity: "perplexity", // Perplexity
};

/**
 * 云服务厂商的凭据字段名称。各家控制台对同一对密钥的叫法都不同，
 * 设置页表单、缺失凭据提示与连接测试文案统一从这里取名，避免三处各写一版。
 * 只填一段密钥的服务省略 secret。
 */
export const cloudCredentialLabels = {
    googleCloudTranslation: {token: 'API Key'},
    azureTranslator: {token: '密钥（Key）'},
    aliyunTranslation: {token: 'AccessKey ID', secret: 'AccessKey Secret'},
    baiduTranslation: {token: 'APP ID', secret: '密钥'},
    volcTranslation: {token: 'Access Key ID', secret: 'Secret Access Key'},
} as const satisfies Record<string, {token: string; secret?: string}>;

export type CloudCredentialLabels = {token: string; secret?: string};

/** 未登记的服务返回通用名称，让调用方不必为每个服务单独判空。 */
export function getCloudCredentialLabels(service: string): CloudCredentialLabels {
    return Object.hasOwn(cloudCredentialLabels, service)
        ? cloudCredentialLabels[service as keyof typeof cloudCredentialLabels]
        : {token: 'API Key'};
}

/** 云服务厂商机器翻译：凭云控制台密钥调用官方接口，与免费网页端点相互独立。 */
export const cloudVendorServices = Object.freeze([
    services.tencent,
    services.googleCloudTranslation,
    services.azureTranslator,
    services.aliyunTranslation,
    services.baiduTranslation,
    services.volcTranslation,
]);

/** 支持的 OpenAI 兼容平台；除本地 Ollama 外都需要平台密钥。 */
export const referenceAiPlatformServices = Object.freeze([
    services.ollama,
    services.mistral,
    services.cohere,
    services.togetherai,
    services.fireworks,
    services.cerebras,
    services.deepinfra,
    services.perplexity,
]);

export const servicesType = {
    // 阵营划分
    machine: new Set([
        services.myMemory, services.microsoft, services.freeTranslation, services.bilibili, services.deepL, services.deeplx,
        services.google, services.xiaoniu, services.youdao, services.chromeTranslator,
        services.localTranslation,
        ...cloudVendorServices,
    ]),
    // 云服务厂商：使用云控制台密钥的官方机器翻译接口
    cloudVendor: new Set<string>(cloudVendorServices),
    AI: new Set([
        services.openai,
        services.azureOpenai,
        services.gemini,
        services.yiyan,
        services.tongyi,
        services.zhipu,
        services.moonshot,
        services.claude, services.custom,
        services.infini,
        services.baichuan,
        services.deepseek,
        services.lingyi,
        services.minimax,
        services.mimo,
        services.jieyue,
        services.groq,
        services.huanYuan,
        services.huanYuanTranslation,
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        services.newapi,
        ...referenceAiPlatformServices,
    ]),
    // 首批由 Vercel AI SDK 的 OpenAI-compatible provider 承接。其他 AI
    // 服务保留专用协议适配器，避免把 Claude/Gemini 等误当成兼容端点。
    aiSdk: new Set([
        services.openai,
        services.azureOpenai,
        services.yiyan,
        services.moonshot,
        services.custom,
        services.infini,
        services.baichuan,
        services.lingyi,
        services.minimax,
        services.mimo,
        services.jieyue,
        services.groq,
        services.huanYuan,
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        services.newapi,
        ...referenceAiPlatformServices,
    ]),
    // 需要 token
    useToken: new Set([
        services.openai,
        services.azureOpenai,
        services.gemini,
        services.yiyan,
        services.tongyi,
        services.zhipu,
        services.moonshot,
        services.claude,
        services.deepL,
        services.deeplx,
        services.xiaoniu,
        services.infini,
        services.baichuan,
        services.deepseek,
        services.lingyi,
        services.minimax,
        services.mimo,
        services.jieyue,
        services.groq,
        services.custom,
        services.huanYuan,
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        services.newapi,
        // 本地 Ollama 默认无鉴权，不纳入密钥要求。
        ...referenceAiPlatformServices.filter((service) => service !== services.ollama),
        // 云服务厂商统一把主密钥存放在 token[service]。
        ...cloudVendorServices.filter((service) => service !== services.tencent),
    ]),
    // 需要 model
    useModel: new Set([
        services.openai,
        services.azureOpenai,
        services.gemini,
        services.yiyan,
        services.tongyi,
        services.zhipu,
        services.moonshot,
        services.claude,
        services.custom,
        services.infini,
        services.baichuan,
        services.deepseek,
        services.lingyi,
        services.minimax,
        services.mimo,
        services.jieyue,
        services.groq,
        services.huanYuan,
        services.huanYuanTranslation,
        services.localTranslation,
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        services.newapi,
        ...referenceAiPlatformServices,
    ]),
    // 需要与主密钥配对的第二段密钥，统一存放在 secret[service]。
    // 直接由凭据名称表派生，新增服务时不会漏配其中一处。
    useSecret: new Set(
        Object.entries(cloudCredentialLabels)
            .filter(([, labels]) => 'secret' in labels)
            .map(([service]) => service),
    ),
    // 需要显式选择服务区域（地域）的服务
    useRegion: new Set([
        services.azureTranslator,
        services.aliyunTranslation,
        services.volcTranslation,
    ]),
    // 支持代理
    useProxy: new Set([
        services.openai,
        services.gemini,
        services.claude,
        services.deepL,
        services.deeplx,
        services.yiyan,
        services.moonshot,
        services.tongyi,
        services.xiaoniu,
        services.tencent,
        services.infini,
        services.baichuan,
        services.deepseek,
        services.lingyi,
        services.minimax,
        services.mimo,
        services.jieyue,
        services.groq,
        services.huanYuan,
        services.huanYuanTranslation,
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        ...referenceAiPlatformServices,
    ]),
    // 支持自定义 URL 的服务
    useCustomUrl: new Set([
        services.custom,
        services.deeplx,
        services.newapi,
        services.azureOpenai,
    ]),

    isMachine: (service: string) => servicesType.machine.has(service),
    isCloudVendor: (service: string) => servicesType.cloudVendor.has(service),
    isUseSecret: (service: string) => servicesType.useSecret.has(service),
    isUseRegion: (service: string) => servicesType.useRegion.has(service),
    isAI: (service: string) => servicesType.AI.has(service) || isCustomOpenAIProviderId(service),
    isAiSdk: (service: string) => servicesType.aiSdk.has(service) || isCustomOpenAIProviderId(service),
    // 翻译专用模型不接受提示词与页面上下文，译文风格由各自的原生翻译参数决定。
    isUseAIContext: (service: string, model = '') =>
        servicesType.isAI(service)
        && service !== services.huanYuanTranslation
        && !(service === services.tongyi && model.startsWith('qwen-mt'))
        && !(service === services.doubao && isDoubaoSeedTranslationModel(model)),
    isUseToken: (service: string) => servicesType.useToken.has(service) || isCustomOpenAIProviderId(service),
    isUseProxy: (service: string) => servicesType.useProxy.has(service) || isCustomOpenAIProviderId(service),
    isUseModel: (service: string) => servicesType.useModel.has(service) || isCustomOpenAIProviderId(service),
    // 所有 AI 服务的请求体都支持附加顶层字段。
    isUseCustomBody: (service: string) => servicesType.isAI(service),
    isCustom: (service: string) => isCustomOpenAIProviderId(service),
    isNewApi: (service: string) => service === services.newapi,
    // 文心一言已迁移到千帆 v2 的 Bearer Token 鉴权；保留方法供 UI 兼容。
    isUseAkSk: (_service: string) => false,
    isYoudao: (service: string) => service === services.youdao,
    isTencent: (service: string) => service === services.tencent || service === services.huanYuanTranslation,
    isAzureOpenai: (service: string) => service === services.azureOpenai,
    isUseCustomUrl: (service: string) => servicesType.useCustomUrl.has(service) || isCustomOpenAIProviderId(service),
};

export const customModelString = CUSTOM_OPENAI_RESERVED_MODEL_ID;

/**
 * 云服务厂商的可选地域。地域同时决定签名 scope 与请求域名，因此必须来自固定白名单，
 * 避免用户手填出一个既签不出正确签名、又把密钥发往未知主机的地址。
 */
export const cloudRegionOptions: Record<string, ReadonlyArray<{value: string; label: string}>> = {
    [services.azureTranslator]: [
        {value: "global", label: "全球（global）"},
        {value: "eastasia", label: "东亚（eastasia）"},
        {value: "southeastasia", label: "东南亚（southeastasia）"},
        {value: "japaneast", label: "日本东部（japaneast）"},
        {value: "japanwest", label: "日本西部（japanwest）"},
        {value: "koreacentral", label: "韩国中部（koreacentral）"},
        {value: "centralindia", label: "印度中部（centralindia）"},
        {value: "australiaeast", label: "澳大利亚东部（australiaeast）"},
        {value: "eastus", label: "美国东部（eastus）"},
        {value: "eastus2", label: "美国东部 2（eastus2）"},
        {value: "centralus", label: "美国中部（centralus）"},
        {value: "northcentralus", label: "美国中北部（northcentralus）"},
        {value: "southcentralus", label: "美国中南部（southcentralus）"},
        {value: "westcentralus", label: "美国中西部（westcentralus）"},
        {value: "westus", label: "美国西部（westus）"},
        {value: "westus2", label: "美国西部 2（westus2）"},
        {value: "canadacentral", label: "加拿大中部（canadacentral）"},
        {value: "brazilsouth", label: "巴西南部（brazilsouth）"},
        {value: "northeurope", label: "北欧（northeurope）"},
        {value: "westeurope", label: "西欧（westeurope）"},
        {value: "francecentral", label: "法国中部（francecentral）"},
        {value: "uksouth", label: "英国南部（uksouth）"},
        {value: "swedencentral", label: "瑞典中部（swedencentral）"},
        {value: "uaenorth", label: "阿联酋北部（uaenorth）"},
        {value: "southafricanorth", label: "南非北部（southafricanorth）"},
    ],
    [services.aliyunTranslation]: [
        {value: "cn-hangzhou", label: "华东 1 / 杭州（cn-hangzhou）"},
        {value: "ap-southeast-1", label: "新加坡（ap-southeast-1）"},
    ],
    [services.volcTranslation]: [
        {value: "cn-north-1", label: "华北 2 / 北京（cn-north-1）"},
        {value: "ap-southeast-1", label: "新加坡（ap-southeast-1）"},
    ],
};

/** 未选择地域时使用的默认值，保证首次配置即可直接发起请求。 */
export function getDefaultCloudRegion(service: string): string {
    return Object.hasOwn(cloudRegionOptions, service) ? cloudRegionOptions[service][0].value : '';
}

/** 只接受白名单内的地域；未知值回落到默认地域。 */
export function resolveCloudRegion(service: string, region?: string): string {
    const candidate = region?.trim() || '';
    const allowed = Object.hasOwn(cloudRegionOptions, service) ? cloudRegionOptions[service] : undefined;
    if (!allowed) return '';
    return allowed.some((option) => option.value === candidate) ? candidate : getDefaultCloudRegion(service);
}

export const minimaxBillingPlans = [
    {value: "payg", label: "按量付费（API）"},
    {value: "token-plan", label: "Token Plan（套餐/积分）"},
] as const;

export type MiniMaxBillingPlan = typeof minimaxBillingPlans[number]["value"];

export const minimaxRegions = [
    {value: "cn", label: "中国版（api.minimaxi.com）"},
    {value: "global", label: "全球版（api.minimax.io）"},
] as const;

export type MiniMaxRegion = typeof minimaxRegions[number]["value"];

export const mimoBillingPlans = [
    {value: "payg", label: "按量付费（API）"},
    {value: "token-plan", label: "Token Plan（套餐/积分）"},
] as const;

export type MiMoBillingPlan = typeof mimoBillingPlans[number]["value"];

export const mimoRegions = [
    {value: "cn", label: "中国集群（token-plan-cn.xiaomimimo.com）"},
    {value: "sgp", label: "新加坡集群（token-plan-sgp.xiaomimimo.com）"},
    {value: "ams", label: "欧洲集群（token-plan-ams.xiaomimimo.com）"},
] as const;

export type MiMoRegion = typeof mimoRegions[number]["value"];

/** 解析实际发送给 provider 的模型。 */
export function resolveConfiguredModel(selectedModel?: string, customModel?: string): string {
    return selectedModel === customModelString ? customModel || '' : selectedModel || '';
}

// 2026-09-12 核对官方目录；来源与选型依据见 docs/reports/model-catalog-20260912.md。
// 当前官方模型编号的单一来源，同时供列表和旧配置迁移使用。
export const currentModelIds = {
    openai: "gpt-5.6-luna",
    zhipu: "glm-5.3",
    zhipuFlash: "glm-4.5-flash",
    tongyiTokenPlan: "qwen3.8-max-preview",
    moonshot: "kimi-k3",
    moonshotCompatible: "kimi-k2.6",
    claude: "claude-fable-5",
    claudeSonnet: "claude-sonnet-5",
    claudeOpus: "claude-opus-5",
    claudeHaiku: "claude-haiku-4-5",
    deepseek: "deepseek-flash",
    infiniDeepseek: "deepseek-v4-flash",
    minimax: "MiniMax-M2.7",
    mimo: "mimo-v2.6-pro",
    jieyue: "step-3.5-flash",
    huanYuan: "hy3",
    grok: "grok-4.5",
    groqLarge: "openai/gpt-oss-120b",
    groqSmall: "openai/gpt-oss-20b",
    yiyan: "ernie-5.1",
    yiyanFast: "ernie-speed-128k",
    infiniZhipu: "glm-5.2",
    infiniGeneral: "qwen3.6-27b",
} as const;

// 各 AI 服务的开箱默认模型优先选择近期、低延迟或低成本档位。
// currentModelIds 仍作为官方编号与旧配置迁移的单一来源；用户仍可在模型列表中主动选择更大的模型。
export const defaultModelIds = {
    [services.openai]: "gpt-5.4-mini",
    [services.azureOpenai]: "gpt-5.4-mini",
    [services.gemini]: "gemini-3.5-flash-lite",
    [services.yiyan]: currentModelIds.yiyanFast,
    [services.tongyi]: "qwen3.8-flash",
    [services.zhipu]: currentModelIds.zhipuFlash,
    [services.moonshot]: currentModelIds.moonshotCompatible,
    [services.claude]: currentModelIds.claudeHaiku,
    [services.custom]: "gpt-5.4-mini",
    [services.infini]: currentModelIds.infiniDeepseek,
    [services.baichuan]: "Baichuan-M3",
    [services.lingyi]: "yi-lightning",
    [services.deepseek]: currentModelIds.deepseek,
    [services.minimax]: "MiniMax-M2.7-highspeed",
    [services.mimo]: "mimo-v2.6-flash",
    [services.jieyue]: "step-2-mini",
    [services.huanYuan]: currentModelIds.huanYuan,
    [services.huanYuanTranslation]: "hunyuan-translation-lite",
    [services.localTranslation]: DEFAULT_LOCAL_TRANSLATION_MODEL,
    [services.newapi]: "gpt-5.4-mini",
    [services.grok]: "grok-4.3",
    [services.doubao]: "doubao-seed-1-6-250615",
    [services.siliconCloud]: "deepseek-ai/DeepSeek-V4-Flash",
    [services.groq]: currentModelIds.groqSmall,
    [services.openrouter]: "google/gemini-3.5-flash-lite",
    // 兼容平台默认选择各家的低延迟档，翻译场景优先响应速度。
    [services.mistral]: "mistral-small-latest",
    [services.cohere]: "command-a-translate-08-2025",
    [services.cerebras]: currentModelIds.groqSmall,
    [services.togetherai]: "Qwen/Qwen3.5-9B",
    [services.fireworks]: "accounts/fireworks/models/gpt-oss-20b",
    [services.deepinfra]: "Qwen/Qwen3.5-9B",
    [services.perplexity]: "sonar",
    [services.ollama]: "gemma3:4b",
} as const;

export const models = new Map<string, Array<string>>([
    [services.openai, [defaultModelIds[services.openai], "gpt-5.4-nano", "gpt-6-astra", currentModelIds.openai, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", customModelString]],
    [services.azureOpenai, [defaultModelIds[services.azureOpenai], currentModelIds.openai, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-nano", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", customModelString]],
    [services.gemini, [defaultModelIds[services.gemini], "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", customModelString]],
    [services.yiyan, [defaultModelIds[services.yiyan], currentModelIds.yiyan, "ernie-5.0-thinking-preview", "ernie-x1.1-preview", "ernie-4.5-turbo-128k", "ernie-4.5-21b-a3b", customModelString]],
    [services.tongyi, [defaultModelIds[services.tongyi], "qwen3.7-flash", "qwen3.6-flash", "qwen3.8-max", currentModelIds.tongyiTokenPlan, "qwen3.7-max", "qwen3.7-plus", "qwen-mt-plus", "qwen-mt-turbo", "qwen-mt-flash", "qwen-mt-lite", "qwen-long-latest", customModelString]],
    [services.zhipu, [defaultModelIds[services.zhipu], currentModelIds.zhipu, "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", customModelString]],
    [services.moonshot, [defaultModelIds[services.moonshot], currentModelIds.moonshot, "kimi-k2.7-code-highspeed", "kimi-k2.7-code", "kimi-k2.5", customModelString]],
    [services.claude, [defaultModelIds[services.claude], "claude-fable-5-1", currentModelIds.claude, currentModelIds.claudeOpus, currentModelIds.claudeSonnet, "claude-opus-4-8", "claude-sonnet-4-6", customModelString]],
    [services.custom, [defaultModelIds[services.custom], currentModelIds.openai, "gpt-5.6-sol", "gemini-3.6-flash", currentModelIds.claude, currentModelIds.deepseek, "gemma:7b", "llama2:7b", "mistral:7b", customModelString]],
    [services.infini, [defaultModelIds[services.infini], "deepseek-v4-pro", currentModelIds.infiniZhipu, "kimi-k2.7-code", currentModelIds.infiniGeneral, "qwen3.6-35b-a3b", customModelString]],
    [services.baichuan, [defaultModelIds[services.baichuan], "Baichuan-M3-Plus", "Baichuan4-Air", "Baichuan4-Turbo", "Baichuan4", customModelString]],
    [services.lingyi, [defaultModelIds[services.lingyi], customModelString]],
    // 旧 Flash 编号仍由官方兼容路由，保留它以维持已保存的模型与 Thinking 偏好。
    [services.deepseek, [currentModelIds.deepseek, "deepseek-v4-pro", "deepseek-v4-flash", customModelString]],
    [services.minimax, [defaultModelIds[services.minimax], "MiniMax-M3.1-flash", "MiniMax-M3", currentModelIds.minimax, "MiniMax-M2.5", "MiniMax-M2.5-highspeed", customModelString]],
    [services.mimo, [defaultModelIds[services.mimo], currentModelIds.mimo, customModelString]],
    [services.jieyue, [defaultModelIds[services.jieyue], "step-3.5-flash-2603", currentModelIds.jieyue, "step-3", "step-2", customModelString]],
    [services.huanYuan, [currentModelIds.huanYuan, customModelString]],
    [services.huanYuanTranslation, [defaultModelIds[services.huanYuanTranslation], "hunyuan-translation", customModelString]],
    [services.localTranslation, [...LOCAL_TRANSLATION_MODELS.map((model) => model.value), customModelString]],
    [services.newapi, [defaultModelIds[services.newapi], currentModelIds.openai, "gpt-5.6-sol", "gemini-3.6-flash", "gemini-3.5-flash-lite", currentModelIds.claude, currentModelIds.deepseek, "kimi-k2.7-code", customModelString]],
    [services.grok, [defaultModelIds[services.grok], "grok-4.6", currentModelIds.grok, customModelString]],
    [services.doubao, ["doubao-seed-1-6-250615", DOUBAO_SEED_TRANSLATION_MODEL_ID, customModelString]],

    // 混合模型。
    [services.siliconCloud, [defaultModelIds[services.siliconCloud], "deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.2", "Qwen/Qwen3.6-27B", "Qwen/Qwen3.6-35B-A3B", "deepseek-ai/DeepSeek-V3.2", "deepseek-ai/DeepSeek-R1", customModelString]],

    [services.groq, [defaultModelIds[services.groq], currentModelIds.groqLarge, "qwen/qwen3.6-27b", customModelString]],
    [services.openrouter, [defaultModelIds[services.openrouter], "google/gemini-3.6-flash", "deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-mini", "openai/gpt-6-astra", "x-ai/grok-4.6", "openrouter/auto", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "anthropic/claude-fable-5", "anthropic/claude-opus-5", "x-ai/grok-4.5", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k3", "z-ai/glm-5.2", customModelString]],

    // 支持的 OpenAI 兼容平台。列表只放各家稳定的公开编号，
    // 平台上新更快，用户可以随时用“自定义模型”补充。
    [services.mistral, [defaultModelIds[services.mistral], "mistral-medium-latest", "mistral-large-latest", "magistral-small-latest", "open-mistral-nemo", customModelString]],
    [services.cohere, [defaultModelIds[services.cohere], "command-a-03-2025", "command-r7b-12-2024", "command-r-plus", customModelString]],
    [services.cerebras, [defaultModelIds[services.cerebras], currentModelIds.groqLarge, "qwen-3-32b", "llama-3.3-70b", customModelString]],
    [services.togetherai, [defaultModelIds[services.togetherai], "Qwen/Qwen3.5-35B-A3B", "deepseek-ai/DeepSeek-V3.2", "meta-llama/Llama-3.3-70B-Instruct-Turbo", customModelString]],
    [services.fireworks, [defaultModelIds[services.fireworks], "accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/qwen3-30b-a3b", "accounts/fireworks/models/deepseek-v3p2", customModelString]],
    [services.deepinfra, [defaultModelIds[services.deepinfra], "Qwen/Qwen3.5-35B-A3B", "deepseek-ai/DeepSeek-V3.2", "meta-llama/Llama-3.3-70B-Instruct", customModelString]],
    [services.perplexity, [defaultModelIds[services.perplexity], "sonar-pro", "sonar-reasoning", customModelString]],
    [services.ollama, [defaultModelIds[services.ollama], "qwen3:8b", "gemma3:12b", "llama3.2:3b", "mistral:7b", customModelString]],
]);

// 每个需要模型选择的 AI 服务都把列表第一项作为开箱即用的默认模型。
// 统一从模型列表生成，避免设置页、配置初始化和请求模板各自维护一份默认值。
export function firstConfiguredModel(modelOptions: readonly string[]): string {
    return modelOptions[0] || '';
}

export const defaultModels = new Map<string, string>(
    Array.from(models.entries())
        .map(([service, modelOptions]) => [service, firstConfiguredModel(modelOptions)] as [string, string])
        .filter(([, model]) => Boolean(model)),
);

// 各翻译入口共用语言目录；具体语言对由所选翻译服务决定是否可用。
export const options = {
    minimaxBillingPlan: minimaxBillingPlans,
    minimaxRegion: minimaxRegions,
    mimoBillingPlan: mimoBillingPlans,
    mimoRegion: mimoRegions,
    on: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    // 是否即时翻译
    autoTranslate: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    // 是否使用缓存
    useCache: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    from: [{value: "auto", label: "自动检测"}, ...translationLanguageOptions],
    // DeepSeek API 格式（仅 DeepSeek 服务显示）
    deepseekApiType: [
        {value: "auto", label: "自动（Chat Completion）"},
        {value: "responses", label: "Responses API"},
        {value: "chat", label: "Chat Completion"},
    ],
    deepseekThinkingMode: [
        {value: "disabled", label: "关闭（推荐）"},
        {value: "enabled", label: "开启"},
    ],
    to: translationLanguageOptions,
    keys: [
        {value: "none", label: "禁用快捷键"},

        {value: "Computer", label: "键盘选项", disabled: true},
        {value: "Control", label: "Ctrl"},
        {value: "Alt", label: "Alt"},
        {value: "Shift", label: "Shift"},
        {value: "Escape", label: "ESC"},
        {value: "`", label: "波浪号键"},

        {value: "mouse", label: "鼠标选项", disabled: true},
        {value: "DoubleClick", label: "鼠标双击"},
        {value: "LongPress", label: "鼠标长按"},
        {value: "MiddleClick", label: "鼠标滚轮单击"},

        {value: "touchscreen", label: "触屏设备选项", disabled: true},
        {value: "TwoFinger", label: "双指翻译"},
        {value: "ThreeFinger", label: "三指翻译"},
        {value: "FourFinger", label: "四指翻译"},
        {value: "DoubleClickScree", label: "双击翻译"},
        {value: "TripleClickScree", label: "三击翻译"},

        {value: "custom", label: "自定义快捷键"},
    ],
    // 划词翻译互斥触发方式。仅右键菜单与快捷键均不显示划词图标或小点。
    selectionTranslatorTriggers: [
        {value: "icon", label: "显示图标"},
        {value: "dot", label: "显示小点"},
        {value: "contextMenu", label: "仅右键菜单"},
        {value: "custom", label: "自定义"},
        {value: "Control", label: "Ctrl"},
        {value: "Alt", label: "Alt / Option"},
        {value: "Shift", label: "Shift"},
        {value: 'hover', label: '悬停图标'},
        {value: "direct", label: "直接弹出"},
    ],
    services: [
        // 机器翻译
        {value: "machine", label: "机器翻译", disabled: true},
        {
            value: services.freeTranslation,
            label: "免费翻译服务",
            description: "后台自动均衡可用服务；根据响应表现调整分配，失败后自动切换。",
        },
        {value: services.bilibili, label: "B站翻译", description: "官方免费文本 API，Index-Translate-35B-A3B，无需密钥"},
        {value: services.myMemory, label: "MyMemory", description: "官方免费 API，匿名每天 5,000 字符；可选邮箱提升额度。"},
        {value: services.microsoft, label: "微软翻译"},
        {value: services.google, label: "谷歌翻译"},
        {value: services.deepL, label: "DeepL"},
        {value: services.deeplx, label: "DeepLX", description: "非官方公共接口，无需密钥"},
        {value: services.xiaoniu, label: "小牛翻译"},
        {value: services.youdao, label: "有道翻译"},
        {value: services.chromeTranslator, label: "Chrome内置AI翻译"},
        {value: services.localTranslation, label: "本地模型翻译", description: "下载后离线翻译，可选轻量语言包与混元翻译模型。"},
        // 云服务厂商：各家云控制台签发密钥，免费额度用完后按量计费
        {value: "cloud", label: "云服务厂商", disabled: true},
        {value: services.tencent, label: "腾讯云翻译", description: "机器翻译 TMT，每月 500 万字符免费额度。"},
        {value: services.googleCloudTranslation, label: "谷歌云翻译", description: "Cloud Translation v2，每月 50 万字符免费额度。", searchTerms: ["google cloud translation", "gcp"]},
        {value: services.azureTranslator, label: "Azure 翻译", description: "Azure AI Translator F0，每月 200 万字符免费额度。", searchTerms: ["microsoft azure translator"]},
        {value: services.aliyunTranslation, label: "阿里云机器翻译", description: "通用版翻译，每月 100 万字符免费额度。", searchTerms: ["aliyun alibaba cloud mt"]},
        {value: services.baiduTranslation, label: "百度翻译", description: "翻译开放平台，标准版每月 5 万字符免费额度。", searchTerms: ["baidu fanyi"]},
        {value: services.volcTranslation, label: "火山引擎翻译", description: "机器翻译 TranslateText，每月 200 万字符免费额度。", searchTerms: ["volcengine volc bytedance"]},
        // 大模型翻译
        {value: "ai", label: "AI翻译", disabled: true},
        // 大模型服务商：中国常用厂商优先，其次为常用海外厂商。
        {value: services.deepseek, label: "DeepSeek", catalogKind: "provider"},
        {value: services.tongyi, label: "千问/Qwen", catalogKind: "provider"},
        {value: services.doubao, label: "字节豆包", catalogKind: "provider"},
        {value: services.moonshot, label: "月之暗面/Kimi", catalogKind: "provider"},
        {value: services.zhipu, label: "智谱/GLM", catalogKind: "provider"},
        {value: services.huanYuan, label: "腾讯混元模型", catalogKind: "provider"},
        {value: services.huanYuanTranslation, label: "腾讯混元翻译", catalogKind: "provider"},
        {value: services.yiyan, label: "文心一言", catalogKind: "provider"},
        {value: services.minimax, label: "MiniMax", catalogKind: "provider"},
        {value: services.mimo, label: "小米 MiMo", catalogKind: "provider"},
        {value: services.jieyue, label: "阶跃星辰", catalogKind: "provider"},
        {value: services.openai, label: "OpenAI", catalogKind: "provider"},
        {value: services.gemini, label: "Gemini", catalogKind: "provider"},
        {value: services.claude, label: "Claude", catalogKind: "provider"},
        {value: services.grok, label: "Grok (X.AI)", catalogKind: "provider"},
        // 聚合平台、托管平台与 OpenAI 兼容接口。
        {value: services.siliconCloud, label: "硅基流动", catalogKind: "platform"},
        {value: services.newapi, label: "New API", catalogKind: "platform"},
        {value: services.infini, label: "无问芯穹", catalogKind: "platform"},
        {value: services.openrouter, label: "OpenRouter", catalogKind: "platform"},
        {value: services.groq, label: "Groq", catalogKind: "platform"},
        {value: services.azureOpenai, label: "Azure", catalogKind: "platform"},
        {value: services.mistral, label: "Mistral AI", catalogKind: "platform"},
        {value: services.cohere, label: "Cohere", catalogKind: "platform"},
        {value: services.cerebras, label: "Cerebras", catalogKind: "platform"},
        {value: services.togetherai, label: "Together AI", catalogKind: "platform"},
        {value: services.fireworks, label: "Fireworks AI", catalogKind: "platform"},
        {value: services.deepinfra, label: "DeepInfra", catalogKind: "platform"},
        {value: services.perplexity, label: "Perplexity", catalogKind: "platform"},
        {value: services.ollama, label: "Ollama", description: "连接本机 Ollama，无需密钥，模型与数据都留在本地。", catalogKind: "platform", searchTerms: ["local localhost 本地"]},
        {value: services.custom, label: "自定义接口", catalogKind: "platform"},
    ],
    display: [
        {value: 0, label: "仅译文模式"},
        {value: 1, label: "双语对照模式"},
    ],
    // 双语翻译样式：带分组标题的旧版选项，由译文外观注册表统一派生。
    styles: buildTranslationStyleOptions(),
    // 悬浮球快捷键选项
    floatingBallHotkeys: [
        {value: "none", label: "禁用快捷键"},
        {value: "Alt+T", label: "Alt+T / Option+T"},
        {value: "Alt+A", label: "Alt+A / Option+A"},
        {value: "Alt+S", label: "Alt+S / Option+S"},
        {value: "Alt+D", label: "Alt+D / Option+D"},
        {value: "Alt+Q", label: "Alt+Q / Option+Q"},
        {value: "Ctrl+Shift+T", label: "Ctrl+Shift+T / Control+Shift+T"},
        {value: "Ctrl+Shift+A", label: "Ctrl+Shift+A / Control+Shift+A"},
        {value: "F9", label: "F9"},
        {value: "F10", label: "F10"},
        {value: "F11", label: "F11"},
        {value: "F12", label: "F12"},
        {value: "custom", label: "自定义快捷键"},
    ],
    theme: [
        {value: "auto", label: "跟随操作系统"},
        {value: "light", label: "亮色主题"},
        {value: "dark", label: "暗色主题"},
    ],
    // 输入框翻译目标语言选项
    inputBoxTranslationTarget: translationLanguageOptions,
    // 输入框翻译触发方式选项
    inputBoxTranslationTrigger: [
        {value: "disabled", label: "已关闭"},
        {value: "triple_space", label: "连按三下空格"},
        {value: "triple_equal", label: "连按三下等号(=)"},
        {value: "triple_dash", label: "连按三下短横线(-)"},
    ],
};

/**
 * Target-language controls deliberately keep a multilingual label so that the
 * selected translation language remains understandable before the interface
 * language has been configured.
 */
export const multilingualTargetLanguageLabels: Readonly<Record<string, string>> = {
    "zh-Hans": "简体中文 / Simplified Chinese",
    "zh-Hant": "繁體中文 / Traditional Chinese",
    en: "English / 英语",
    ja: "日本語 / Japanese / 日语",
    ko: "한국어 / Korean / 韩语",
    fr: "Français / French / 法语",
    ru: "Русский / Russian / 俄语",
    es: "Español / Spanish / 西班牙语",
    de: "Deutsch / German / 德语",
    pt: "Português / Portuguese / 葡萄牙语",
    it: "Italiano / Italian / 意大利语",
    ar: "العربية / Arabic / 阿拉伯语",
    hi: "हिन्दी / Hindi / 印地语",
    bn: "বাংলা / Bangla / 孟加拉语",
    ur: "اردو / Urdu / 乌尔都语",
    fa: "فارسی / Persian / 波斯语",
    he: "עברית / Hebrew / 希伯来语",
    tr: "Türkçe / Turkish / 土耳其语",
    vi: "Tiếng Việt / Vietnamese / 越南语",
    th: "ไทย / Thai / 泰语",
    id: "Indonesia / Indonesian / 印度尼西亚语",
    ms: "Melayu / Malay / 马来语",
    nl: "Nederlands / Dutch / 荷兰语",
    pl: "polski / Polish / 波兰语",
    uk: "українська / Ukrainian / 乌克兰语",
    cs: "čeština / Czech / 捷克语",
    sk: "slovenčina / Slovak / 斯洛伐克语",
    da: "dansk / Danish / 丹麦语",
    sv: "svenska / Swedish / 瑞典语",
    nb: "norsk bokmål / Norwegian Bokmål / 书面挪威语",
    fi: "suomi / Finnish / 芬兰语",
    el: "Ελληνικά / Greek / 希腊语",
    ro: "română / Romanian / 罗马尼亚语",
    hu: "magyar / Hungarian / 匈牙利语",
    bg: "български / Bulgarian / 保加利亚语",
    hr: "hrvatski / Croatian / 克罗地亚语",
    sr: "српски / Serbian / 塞尔维亚语",
    sl: "slovenščina / Slovenian / 斯洛文尼亚语",
    et: "eesti / Estonian / 爱沙尼亚语",
    lv: "latviešu / Latvian / 拉脱维亚语",
    lt: "lietuvių / Lithuanian / 立陶宛语",
    ta: "தமிழ் / Tamil / 泰米尔语",
    te: "తెలుగు / Telugu / 泰卢固语",
    mr: "मराठी / Marathi / 马拉地语",
    gu: "ગુજરાતી / Gujarati / 古吉拉特语",
    kn: "ಕನ್ನಡ / Kannada / 卡纳达语",
    ml: "മലയാളം / Malayalam / 马拉雅拉姆语",
    pa: "ਪੰਜਾਬੀ / Punjabi / 旁遮普语",
    ne: "नेपाली / Nepali / 尼泊尔语",
    si: "සිංහල / Sinhala / 僧伽罗语",
    sw: "Kiswahili / Swahili / 斯瓦希里语",
    fil: "Filipino / Filipino / 菲律宾语",
};

export const englishTargetLanguageLabels: Readonly<Record<string, string>> = {
    "zh-Hans": "Simplified Chinese",
    "zh-Hant": "Traditional Chinese",
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    fr: "French",
    ru: "Russian",
    es: "Spanish",
    de: "German",
    pt: "Portuguese",
    it: "Italian",
    ar: "Arabic",
    hi: "Hindi",
    bn: "Bangla",
    ur: "Urdu",
    fa: "Persian",
    he: "Hebrew",
    tr: "Turkish",
    vi: "Vietnamese",
    th: "Thai",
    id: "Indonesian",
    ms: "Malay",
    nl: "Dutch",
    pl: "Polish",
    uk: "Ukrainian",
    cs: "Czech",
    sk: "Slovak",
    da: "Danish",
    sv: "Swedish",
    nb: "Norwegian Bokmål",
    fi: "Finnish",
    el: "Greek",
    ro: "Romanian",
    hu: "Hungarian",
    bg: "Bulgarian",
    hr: "Croatian",
    sr: "Serbian",
    sl: "Slovenian",
    et: "Estonian",
    lv: "Latvian",
    lt: "Lithuanian",
    ta: "Tamil",
    te: "Telugu",
    mr: "Marathi",
    gu: "Gujarati",
    kn: "Kannada",
    ml: "Malayalam",
    pa: "Punjabi",
    ne: "Nepali",
    si: "Sinhala",
    sw: "Swahili",
    fil: "Filipino",
};

const localizedTargetLanguageLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "ja-JP": {
        ar: "アラビア語 / Arabic / العربية",
        hi: "ヒンディー語 / Hindi / हिन्दी",
        bn: "ベンガル語 / Bangla / বাংলা",
        ur: "ウルドゥー語 / Urdu / اردو",
        fa: "ペルシア語 / Persian / فارسی",
        he: "ヘブライ語 / Hebrew / עברית",
        tr: "トルコ語 / Turkish / Türkçe",
        vi: "ベトナム語 / Vietnamese / Tiếng Việt",
        th: "タイ語 / Thai / ไทย",
        id: "インドネシア語 / Indonesian / Indonesia",
        ms: "マレー語 / Malay / Melayu",
        nl: "オランダ語 / Dutch / Nederlands",
        pl: "ポーランド語 / Polish / polski",
        uk: "ウクライナ語 / Ukrainian / українська",
        cs: "チェコ語 / Czech / čeština",
        sk: "スロバキア語 / Slovak / slovenčina",
        da: "デンマーク語 / Danish / dansk",
        sv: "スウェーデン語 / Swedish / svenska",
        nb: "ノルウェー語(ブークモール) / Norwegian Bokmål / norsk bokmål",
        fi: "フィンランド語 / Finnish / suomi",
        el: "ギリシャ語 / Greek / Ελληνικά",
        ro: "ルーマニア語 / Romanian / română",
        hu: "ハンガリー語 / Hungarian / magyar",
        bg: "ブルガリア語 / Bulgarian / български",
        hr: "クロアチア語 / Croatian / hrvatski",
        sr: "セルビア語 / Serbian / српски",
        sl: "スロベニア語 / Slovenian / slovenščina",
        et: "エストニア語 / Estonian / eesti",
        lv: "ラトビア語 / Latvian / latviešu",
        lt: "リトアニア語 / Lithuanian / lietuvių",
        ta: "タミル語 / Tamil / தமிழ்",
        te: "テルグ語 / Telugu / తెలుగు",
        mr: "マラーティー語 / Marathi / मराठी",
        gu: "グジャラート語 / Gujarati / ગુજરાતી",
        kn: "カンナダ語 / Kannada / ಕನ್ನಡ",
        ml: "マラヤーラム語 / Malayalam / മലയാളം",
        pa: "パンジャブ語 / Punjabi / ਪੰਜਾਬੀ",
        ne: "ネパール語 / Nepali / नेपाली",
        si: "シンハラ語 / Sinhala / සිංහල",
        sw: "スワヒリ語 / Swahili / Kiswahili",
        fil: "フィリピノ語 / Filipino / Filipino",
        "zh-Hans": "中国語（簡体字） / Simplified Chinese / 简体中文",
        "zh-Hant": "中国語（繁体字） / Traditional Chinese / 繁體中文",
        en: "英語 / English",
        ja: "日本語 / Japanese",
        ko: "韓国語 / Korean / 한국어",
        fr: "フランス語 / French / Français",
        ru: "ロシア語 / Russian / Русский",
        es: "スペイン語 / Spanish / Español",
        de: "ドイツ語 / German / Deutsch",
        pt: "ポルトガル語 / Portuguese / Português",
        it: "イタリア語 / Italian / Italiano",
    },
    "ko-KR": {
        ar: "아랍어 / Arabic / العربية",
        hi: "힌디어 / Hindi / हिन्दी",
        bn: "벵골어 / Bangla / বাংলা",
        ur: "우르두어 / Urdu / اردو",
        fa: "페르시아어 / Persian / فارسی",
        he: "히브리어 / Hebrew / עברית",
        tr: "터키어 / Turkish / Türkçe",
        vi: "베트남어 / Vietnamese / Tiếng Việt",
        th: "태국어 / Thai / ไทย",
        id: "인도네시아어 / Indonesian / Indonesia",
        ms: "말레이어 / Malay / Melayu",
        nl: "네덜란드어 / Dutch / Nederlands",
        pl: "폴란드어 / Polish / polski",
        uk: "우크라이나어 / Ukrainian / українська",
        cs: "체코어 / Czech / čeština",
        sk: "슬로바키아어 / Slovak / slovenčina",
        da: "덴마크어 / Danish / dansk",
        sv: "스웨덴어 / Swedish / svenska",
        nb: "노르웨이어(보크말) / Norwegian Bokmål / norsk bokmål",
        fi: "핀란드어 / Finnish / suomi",
        el: "그리스어 / Greek / Ελληνικά",
        ro: "루마니아어 / Romanian / română",
        hu: "헝가리어 / Hungarian / magyar",
        bg: "불가리아어 / Bulgarian / български",
        hr: "크로아티아어 / Croatian / hrvatski",
        sr: "세르비아어 / Serbian / српски",
        sl: "슬로베니아어 / Slovenian / slovenščina",
        et: "에스토니아어 / Estonian / eesti",
        lv: "라트비아어 / Latvian / latviešu",
        lt: "리투아니아어 / Lithuanian / lietuvių",
        ta: "타밀어 / Tamil / தமிழ்",
        te: "텔루구어 / Telugu / తెలుగు",
        mr: "마라티어 / Marathi / मराठी",
        gu: "구자라트어 / Gujarati / ગુજરાતી",
        kn: "칸나다어 / Kannada / ಕನ್ನಡ",
        ml: "말라얄람어 / Malayalam / മലയാളം",
        pa: "펀잡어 / Punjabi / ਪੰਜਾਬੀ",
        ne: "네팔어 / Nepali / नेपाली",
        si: "싱할라어 / Sinhala / සිංහල",
        sw: "스와힐리어 / Swahili / Kiswahili",
        fil: "필리핀어 / Filipino / Filipino",
        "zh-Hans": "중국어 간체 / Simplified Chinese / 简体中文",
        "zh-Hant": "중국어 번체 / Traditional Chinese / 繁體中文",
        en: "영어 / English",
        ja: "일본어 / Japanese / 日本語",
        ko: "한국어 / Korean",
        fr: "프랑스어 / French / Français",
        ru: "러시아어 / Russian / Русский",
        es: "스페인어 / Spanish / Español",
        de: "독일어 / German / Deutsch",
        pt: "포르투갈어 / Portuguese / Português",
        it: "이탈리아어 / Italian / Italiano",
    },
    "fr-FR": {
        ar: "arabe / Arabic / العربية",
        hi: "hindi / Hindi / हिन्दी",
        bn: "bengali / Bangla / বাংলা",
        ur: "ourdou / Urdu / اردو",
        fa: "persan / Persian / فارسی",
        he: "hébreu / Hebrew / עברית",
        tr: "turc / Turkish / Türkçe",
        vi: "vietnamien / Vietnamese / Tiếng Việt",
        th: "thaï / Thai / ไทย",
        id: "indonésien / Indonesian / Indonesia",
        ms: "malais / Malay / Melayu",
        nl: "néerlandais / Dutch / Nederlands",
        pl: "polonais / Polish / polski",
        uk: "ukrainien / Ukrainian / українська",
        cs: "tchèque / Czech / čeština",
        sk: "slovaque / Slovak / slovenčina",
        da: "danois / Danish / dansk",
        sv: "suédois / Swedish / svenska",
        nb: "norvégien bokmål / Norwegian Bokmål / norsk bokmål",
        fi: "finnois / Finnish / suomi",
        el: "grec / Greek / Ελληνικά",
        ro: "roumain / Romanian / română",
        hu: "hongrois / Hungarian / magyar",
        bg: "bulgare / Bulgarian / български",
        hr: "croate / Croatian / hrvatski",
        sr: "serbe / Serbian / српски",
        sl: "slovène / Slovenian / slovenščina",
        et: "estonien / Estonian / eesti",
        lv: "letton / Latvian / latviešu",
        lt: "lituanien / Lithuanian / lietuvių",
        ta: "tamoul / Tamil / தமிழ்",
        te: "télougou / Telugu / తెలుగు",
        mr: "marathi / Marathi / मराठी",
        gu: "goudjarati / Gujarati / ગુજરાતી",
        kn: "kannada / Kannada / ಕನ್ನಡ",
        ml: "malayalam / Malayalam / മലയാളം",
        pa: "pendjabi / Punjabi / ਪੰਜਾਬੀ",
        ne: "népalais / Nepali / नेपाली",
        si: "cingalais / Sinhala / සිංහල",
        sw: "swahili / Swahili / Kiswahili",
        fil: "filipino / Filipino / Filipino",
        "zh-Hans": "chinois simplifié / Simplified Chinese / 简体中文",
        "zh-Hant": "chinois traditionnel / Traditional Chinese / 繁體中文",
        en: "anglais / English",
        ja: "japonais / Japanese / 日本語",
        ko: "coréen / Korean / 한국어",
        fr: "français / French",
        ru: "russe / Russian / Русский",
        es: "espagnol / Spanish / Español",
        de: "allemand / German / Deutsch",
        pt: "portugais / Portuguese / Português",
        it: "italien / Italian / Italiano",
    },
    "ru-RU": {
        ar: "арабский / Arabic / العربية",
        hi: "хинди / Hindi / हिन्दी",
        bn: "бенгальский / Bangla / বাংলা",
        ur: "урду / Urdu / اردو",
        fa: "персидский / Persian / فارسی",
        he: "иврит / Hebrew / עברית",
        tr: "турецкий / Turkish / Türkçe",
        vi: "вьетнамский / Vietnamese / Tiếng Việt",
        th: "тайский / Thai / ไทย",
        id: "индонезийский / Indonesian / Indonesia",
        ms: "малайский / Malay / Melayu",
        nl: "нидерландский / Dutch / Nederlands",
        pl: "польский / Polish / polski",
        uk: "украинский / Ukrainian / українська",
        cs: "чешский / Czech / čeština",
        sk: "словацкий / Slovak / slovenčina",
        da: "датский / Danish / dansk",
        sv: "шведский / Swedish / svenska",
        nb: "норвежский букмол / Norwegian Bokmål / norsk bokmål",
        fi: "финский / Finnish / suomi",
        el: "греческий / Greek / Ελληνικά",
        ro: "румынский / Romanian / română",
        hu: "венгерский / Hungarian / magyar",
        bg: "болгарский / Bulgarian / български",
        hr: "хорватский / Croatian / hrvatski",
        sr: "сербский / Serbian / српски",
        sl: "словенский / Slovenian / slovenščina",
        et: "эстонский / Estonian / eesti",
        lv: "латышский / Latvian / latviešu",
        lt: "литовский / Lithuanian / lietuvių",
        ta: "тамильский / Tamil / தமிழ்",
        te: "телугу / Telugu / తెలుగు",
        mr: "маратхи / Marathi / मराठी",
        gu: "гуджарати / Gujarati / ગુજરાતી",
        kn: "каннада / Kannada / ಕನ್ನಡ",
        ml: "малаялам / Malayalam / മലയാളം",
        pa: "панджаби / Punjabi / ਪੰਜਾਬੀ",
        ne: "непальский / Nepali / नेपाली",
        si: "сингальский / Sinhala / සිංහල",
        sw: "суахили / Swahili / Kiswahili",
        fil: "филиппинский / Filipino / Filipino",
        "zh-Hans": "китайский (упрощённый) / Simplified Chinese / 简体中文",
        "zh-Hant": "китайский (традиционный) / Traditional Chinese / 繁體中文",
        en: "английский / English",
        ja: "японский / Japanese / 日本語",
        ko: "корейский / Korean / 한국어",
        fr: "французский / French / Français",
        ru: "русский / Russian",
        es: "испанский / Spanish / Español",
        de: "немецкий / German / Deutsch",
        pt: "португальский / Portuguese / Português",
        it: "итальянский / Italian / Italiano",
    },
    "es-ES": {
        ar: "árabe / Arabic / العربية",
        hi: "hindi / Hindi / हिन्दी",
        bn: "bengalí / Bangla / বাংলা",
        ur: "urdu / Urdu / اردو",
        fa: "persa / Persian / فارسی",
        he: "hebreo / Hebrew / עברית",
        tr: "turco / Turkish / Türkçe",
        vi: "vietnamita / Vietnamese / Tiếng Việt",
        th: "tailandés / Thai / ไทย",
        id: "indonesio / Indonesian / Indonesia",
        ms: "malayo / Malay / Melayu",
        nl: "neerlandés / Dutch / Nederlands",
        pl: "polaco / Polish / polski",
        uk: "ucraniano / Ukrainian / українська",
        cs: "checo / Czech / čeština",
        sk: "eslovaco / Slovak / slovenčina",
        da: "danés / Danish / dansk",
        sv: "sueco / Swedish / svenska",
        nb: "noruego bokmal / Norwegian Bokmål / norsk bokmål",
        fi: "finés / Finnish / suomi",
        el: "griego / Greek / Ελληνικά",
        ro: "rumano / Romanian / română",
        hu: "húngaro / Hungarian / magyar",
        bg: "búlgaro / Bulgarian / български",
        hr: "croata / Croatian / hrvatski",
        sr: "serbio / Serbian / српски",
        sl: "esloveno / Slovenian / slovenščina",
        et: "estonio / Estonian / eesti",
        lv: "letón / Latvian / latviešu",
        lt: "lituano / Lithuanian / lietuvių",
        ta: "tamil / Tamil / தமிழ்",
        te: "telugu / Telugu / తెలుగు",
        mr: "maratí / Marathi / मराठी",
        gu: "guyaratí / Gujarati / ગુજરાતી",
        kn: "canarés / Kannada / ಕನ್ನಡ",
        ml: "malayálam / Malayalam / മലയാളം",
        pa: "punyabí / Punjabi / ਪੰਜਾਬੀ",
        ne: "nepalí / Nepali / नेपाली",
        si: "cingalés / Sinhala / සිංහල",
        sw: "suajili / Swahili / Kiswahili",
        fil: "filipino / Filipino / Filipino",
        "zh-Hans": "Chino simplificado / Simplified Chinese / 简体中文",
        "zh-Hant": "Chino tradicional / Traditional Chinese / 繁體中文",
        en: "Inglés / English",
        ja: "Japonés / Japanese / 日本語",
        ko: "Coreano / Korean / 한국어",
        fr: "Francés / French / Français",
        ru: "Ruso / Russian / Русский",
        es: "Español / Spanish",
        de: "Alemán / German / Deutsch",
        pt: "Portugués / Portuguese / Português",
        it: "Italiano / Italian",
    },
};

const targetLanguageLabelsByUiLanguage: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "zh-CN": multilingualTargetLanguageLabels,
    "en-US": englishTargetLanguageLabels,
    ...localizedTargetLanguageLabels,
};

export function getMultilingualTargetLanguageLabel(value: string, fallback = value, uiLanguage = "zh-CN"): string {
    const labels = Object.hasOwn(targetLanguageLabelsByUiLanguage, uiLanguage)
        ? targetLanguageLabelsByUiLanguage[uiLanguage] : multilingualTargetLanguageLabels;
    const language = normalizeChineseLanguageCode(value);
    return Object.hasOwn(labels, language) ? labels[language] : fallback;
}

/**
 * 历史默认用户提示词。“If translation is unnecessary … return the original text”
 * 会被较弱的模型理解为可以整句保留原文，导致译文中夹杂明显应当翻译的源语言
 * （Issue #54）。这里保留原文本，供配置归一化把未被用户改写的默认值升级到当前
 * 提示词；用户自定义的提示词不受影响。
 */
export const LEGACY_DEFAULT_USER_ROLES: readonly string[] = Object.freeze([
    `Translate the following text into {{to}}, If translation is unnecessary (e.g. proper nouns, codes, etc.), return the original text. NO explanations. NO notes:

{{origin}}`,
]);

export const defaultOption = {
    on: true,
    uiLanguage: "zh-CN" as const,
    from: "auto",
    to: "zh-Hans",
    style: 1,
    display: 1,
    hotkey: "Control",
    service: services.freeTranslation,
    custom: "http://localhost:11434/v1/chat/completions",
    deeplx: DEFAULT_DEEPLX_ENDPOINT,
    system_role:
        "You are a professional, authentic machine translation engine.",
    user_role: `Translate the following text into {{to}}. Translate every sentence, clause and phrase in full; no part of the source text may stay in its original language. Keep only code, URLs, and proper nouns that have no established {{to}} form, and keep them inline inside the translated sentence. Return the translation only. NO explanations. NO notes:

{{origin}}`,
    count: 0,
    useCache: true,
    floatingBallHotkey: "Alt+T", // 默认悬浮球快捷键
    inputBoxTranslationTrigger: "disabled", // 默认关闭输入框翻译
    inputBoxTranslationTarget: "en", // 默认翻译成英文
};
