/**
 * @file src/core/config/catalog.ts
 *
 * 文件职责：维护 FluentRead 翻译语言、服务与模型的领域目录，让设置、校验和运行时能够引用同一组稳定的服务标识与模型元数据。
 * 主要内容：明确区分简体中文和繁体中文，统一源语言、目标语言和输入框语言选项，并定义 services、servicesType、服务目录展示分类与排序、模型候选、MiniMax 与 MiMo 的计费和地域选项，并提供 resolveConfiguredModel 等解析函数，把“自定义模型”选择归一为可请求的模型编号。 可核对的公开符号包括 services、servicesType、customModelString、minimaxBillingPlans、MiniMaxBillingPlan、minimaxRegions、MiniMaxRegion、mimoBillingPlans。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {DEFAULT_DEEPLX_ENDPOINT} from "./deeplx";
import {CUSTOM_OPENAI_RESERVED_MODEL_ID, isCustomOpenAIProviderId} from './customOpenAI';

export const services = {
    // 机器翻译
    microsoft: "microsoft",
    freeTranslation: "freeTranslation",
    myMemory: "myMemory",
    deepL: "deepL",
    deeplx: "deeplx",
    google: "google",
    xiaoniu: "xiaoniu",
    youdao: "youdao",
    tencent: "tencent", // 腾讯云机器翻译
    chromeTranslator: "chromeTranslator", // Chrome 内置翻译 API
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
};

export const servicesType = {
    // 阵营划分
    machine: new Set([services.myMemory, services.microsoft, services.freeTranslation, services.deepL, services.deeplx, services.google, services.xiaoniu, services.youdao, services.tencent, services.chromeTranslator,]),
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
        services.doubao,
        services.siliconCloud,
        services.openrouter,
        services.grok,
        services.newapi,
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
    ]),
    // 支持自定义 URL 的服务
    useCustomUrl: new Set([
        services.custom,
        services.deeplx,
        services.newapi,
        services.azureOpenai,
    ]),

    isMachine: (service: string) => servicesType.machine.has(service),
    isAI: (service: string) => servicesType.AI.has(service) || isCustomOpenAIProviderId(service),
    isAiSdk: (service: string) => servicesType.aiSdk.has(service) || isCustomOpenAIProviderId(service),
    isUseAIContext: (service: string, model = '') =>
        servicesType.isAI(service)
        && service !== services.huanYuanTranslation
        && !(service === services.tongyi && model.startsWith('qwen-mt')),
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
    deepseek: "deepseek-v4-flash",
    minimax: "MiniMax-M2.7",
    mimo: "mimo-v2.5-pro",
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
    [services.openai]: currentModelIds.openai,
    [services.azureOpenai]: currentModelIds.openai,
    [services.gemini]: "gemini-3.6-flash",
    [services.yiyan]: currentModelIds.yiyanFast,
    [services.tongyi]: "qwen3.6-flash",
    [services.zhipu]: currentModelIds.zhipuFlash,
    [services.moonshot]: currentModelIds.moonshotCompatible,
    [services.claude]: currentModelIds.claudeHaiku,
    [services.custom]: currentModelIds.openai,
    [services.infini]: currentModelIds.deepseek,
    [services.baichuan]: "Baichuan-M3",
    [services.lingyi]: "yi-lightning",
    [services.deepseek]: currentModelIds.deepseek,
    [services.minimax]: "MiniMax-M2.7-highspeed",
    [services.mimo]: "mimo-v2.5",
    [services.jieyue]: currentModelIds.jieyue,
    [services.huanYuan]: currentModelIds.huanYuan,
    [services.huanYuanTranslation]: "hunyuan-translation-lite",
    [services.newapi]: currentModelIds.openai,
    [services.grok]: "grok-4.3",
    [services.doubao]: "doubao-seed-1-6-250615",
    [services.siliconCloud]: "deepseek-ai/DeepSeek-V4-Flash",
    [services.groq]: currentModelIds.groqSmall,
    [services.openrouter]: "google/gemini-3.6-flash",
} as const;

export const models = new Map<string, Array<string>>([
    [services.openai, [currentModelIds.openai, "gpt-5.4-mini", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-nano", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", customModelString]],
    [services.azureOpenai, [currentModelIds.openai, "gpt-5.4-mini", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-nano", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", customModelString]],
    [services.gemini, [defaultModelIds[services.gemini], "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", customModelString]],
    [services.yiyan, [defaultModelIds[services.yiyan], currentModelIds.yiyan, "ernie-5.0-thinking-preview", "ernie-x1.1-preview", "ernie-4.5-turbo-128k", "ernie-4.5-21b-a3b", customModelString]],
    [services.tongyi, [defaultModelIds[services.tongyi], currentModelIds.tongyiTokenPlan, "qwen3.7-max", "qwen3.7-plus", "qwen-mt-plus", "qwen-mt-turbo", "qwen-mt-flash", "qwen-mt-lite", "qwen-long-latest", customModelString]],
    [services.zhipu, [defaultModelIds[services.zhipu], currentModelIds.zhipu, "glm-5.3-flash","glm-5.3","glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", customModelString]],
    [services.moonshot, [defaultModelIds[services.moonshot], currentModelIds.moonshot, "kimi-k2.7-code-highspeed", "kimi-k2.7-code", "kimi-k2.5", customModelString]],
    [services.claude, [defaultModelIds[services.claude], currentModelIds.claude, currentModelIds.claudeOpus, currentModelIds.claudeSonnet, "claude-opus-4-8", "claude-sonnet-4-6", customModelString]],
    [services.custom, [currentModelIds.openai, "gpt-5.4-mini", "gpt-5.6-sol", "gemini-3.6-flash", currentModelIds.claude, currentModelIds.deepseek, "gemma:7b", "llama2:7b", "mistral:7b", customModelString]],
    [services.infini, [defaultModelIds[services.infini], "deepseek-v4-pro", currentModelIds.infiniZhipu, "kimi-k2.7-code", currentModelIds.infiniGeneral, "qwen3.6-35b-a3b", customModelString]],
    [services.baichuan, [defaultModelIds[services.baichuan], "Baichuan-M3-Plus", "Baichuan4-Air", "Baichuan4-Turbo", "Baichuan4", customModelString]],
    [services.lingyi, [defaultModelIds[services.lingyi], customModelString]],
    [services.deepseek, [currentModelIds.deepseek, "deepseek-v4-pro", customModelString]],
    [services.minimax, [defaultModelIds[services.minimax], "MiniMax-M3.1", "MiniMax-M3", currentModelIds.minimax, "MiniMax-M2.5", "MiniMax-M2.5-highspeed", customModelString]],
    [services.mimo, [defaultModelIds[services.mimo], currentModelIds.mimo, customModelString]],
    [services.jieyue, [currentModelIds.jieyue, "step-3", "step-2", customModelString]],
    [services.huanYuan, [currentModelIds.huanYuan, "hy3-preview", customModelString]],
    [services.huanYuanTranslation, [defaultModelIds[services.huanYuanTranslation], "hunyuan-translation", customModelString]],
    [services.newapi, [currentModelIds.openai, "gpt-5.4-mini", "gpt-5.6-sol", "gemini-3.6-flash", "gemini-3.5-flash-lite", currentModelIds.claude, currentModelIds.deepseek, "kimi-k2.7-code", customModelString]],
    [services.grok, [defaultModelIds[services.grok], currentModelIds.grok, customModelString]],
    [services.doubao, ["doubao-seed-1-6-250615", customModelString]],

    // 混合模型。
    [services.siliconCloud, [defaultModelIds[services.siliconCloud], "deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.2", "Qwen/Qwen3.6-27B", "Qwen/Qwen3.6-35B-A3B", "deepseek-ai/DeepSeek-V3.2", "deepseek-ai/DeepSeek-R1", customModelString]],

    [services.groq, [defaultModelIds[services.groq], currentModelIds.groqLarge, "qwen/qwen3.6-27b", customModelString]],
    [services.openrouter, [defaultModelIds[services.openrouter], "openrouter/auto", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "anthropic/claude-fable-5", "anthropic/claude-opus-5", "x-ai/grok-4.5", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k3", "z-ai/glm-5.2", customModelString]]
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

const translationLanguageOptions = [
    {value: "zh-Hans", label: "简体中文"},
    {value: "zh-Hant", label: "繁體中文"},
    {value: "en", label: "English"},
    {value: "ja", label: "日本語"},
    {value: "ko", label: "한국어"},
    {value: "fr", label: "Français"},
    {value: "ru", label: "Русский"},
    {value: "es", label: "Español"},
];

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
    // 划词翻译互斥触发方式。快捷键选择后，不再显示选区旁的图标或小点。
    selectionTranslatorTriggers: [
        {value: "direct", label: "直接弹出"},
        {value: "icon", label: "显示图标"},
        {value: "dot", label: "显示小点"},
        {value: "Control", label: "Ctrl"},
        {value: "Alt", label: "Alt / Option"},
        {value: "Shift", label: "Shift"},
        {value: "custom", label: "自定义"},
    ],
    services: [
        // 机器翻译
        {value: "machine", label: "机器翻译", disabled: true},
        {
            value: services.freeTranslation,
            label: "免费翻译服务",
            description: "按设置顺序自动切换可用服务；支持每路超时和失败冷却。",
        },
        {value: services.myMemory, label: "MyMemory", description: "官方免费 API，匿名每天 5,000 字符；可选邮箱提升额度。"},
        {value: services.microsoft, label: "微软翻译"},
        {value: services.google, label: "谷歌翻译"},
        {value: services.deepL, label: "DeepL"},
        {value: services.deeplx, label: "DeepLX（免费非官方）"},
        {value: services.xiaoniu, label: "小牛翻译"},
        {value: services.youdao, label: "有道翻译"},
        {value: services.tencent, label: "腾讯云翻译"},
        {value: services.chromeTranslator, label: "Chrome内置AI翻译"},
        // 大模型翻译
        {value: "ai", label: "AI翻译", disabled: true},
        // 大模型服务商：中国常用厂商优先，其次为常用海外厂商。
        {value: services.deepseek, label: "DeepSeek", catalogKind: "provider"},
        {value: services.tongyi, label: "千问/Qwen", catalogKind: "provider"},
        {value: services.doubao, label: "字节豆包", catalogKind: "provider"},
        {value: services.moonshot, label: "月之暗面/Kimi", catalogKind: "provider"},
        {value: services.zhipu, label: "智谱/GLM", catalogKind: "provider"},
        {value: services.huanYuan, label: "腾讯混元", catalogKind: "provider"},
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
        {value: services.custom, label: "自定义接口", catalogKind: "platform"},
    ],
    display: [
        {value: 0, label: "仅译文模式"},
        {value: 1, label: "双语对照模式"},
    ],
    // 双语翻译样式
    styles: [
        // 基础样式
        {value: "basic", label: "基础样式", disabled: true},
        {value: 0, label: "朴素模式", class: "fluent-display-default", group: "basic"},
        {value: 1, label: "加粗显示", class: "fluent-display-bold", group: "basic"},
        {value: 2, label: "优雅斜体", class: "fluent-display-italic", group: "basic"},
        {value: 3, label: "立体阴影", class: "fluent-display-text-shadow", group: "basic"},

        // 下划线系列
        {value: "underline", label: "下划线系列", disabled: true},
        {value: 4, label: "蓝色实线", class: "fluent-display-solid-underline", group: "underline"},
        {value: 5, label: "优雅虚线", class: "fluent-display-dot-underline", group: "underline"},
        {value: 6, label: "活泼波浪", class: "fluent-display-wavy", group: "underline"},

        // 卡片系列
        {value: "card", label: "卡片系列", disabled: true},
        {value: 7, label: "简约卡片", class: "fluent-display-card-mode", group: "card"},
        {value: 8, label: "渐变卡片", class: "fluent-display-modern-card", group: "card"},
        {value: 9, label: "纸张卡片", class: "fluent-display-paper", group: "card"},

        // 高亮系列
        {value: "highlight", label: "高亮系列", disabled: true},
        {value: 10, label: "学习标记", class: "fluent-display-learning-mode", group: "highlight"},
        {value: 11, label: "荧光标记", class: "fluent-display-marker", group: "highlight"},
        {value: 12, label: "柔和渐变", class: "fluent-display-highlight-fade", group: "highlight"},

        // 背景色系列
        {value: "background", label: "背景色系列", disabled: true},
        {value: 13, label: "温暖黄底", class: "fluent-display-lightyellow", group: "background"},
        {value: 14, label: "清新蓝底", class: "fluent-display-lightblue", group: "background"},
        {value: 15, label: "素雅灰底", class: "fluent-display-lightgray", group: "background"},

        // 特殊效果
        {value: "special", label: "特殊效果", disabled: true},
        {value: 16, label: "典雅引用", class: "fluent-display-quote", group: "special"},
        {value: 17, label: "轻巧边框", class: "fluent-display-border", group: "special"},
        {value: 18, label: "阅读焦点", class: "fluent-display-focus", group: "special"},
        {value: 19, label: "简约底线", class: "fluent-display-clean", group: "special"},

        // 专业样式
        {value: "pro", label: "专业样式", disabled: true},
        {value: 20, label: "代码风格", class: "fluent-display-tech", group: "pro"},
        {value: 21, label: "书籍风格", class: "fluent-display-elegant", group: "pro"},

        // 透明度
        {value: "transparent", label: "透明效果", disabled: true},
        {value: 22, label: "半透明弱化", class: "fluent-display-dimmed", group: "transparent"},
        {value: 23, label: "轻透明感", class: "fluent-display-transparent-mode", group: "transparent"},
    ],
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
    inputBoxTranslationTarget: [
        ...translationLanguageOptions,
        {value: "de", label: "Deutsch"},
        {value: "pt", label: "Português"},
        {value: "it", label: "Italiano"},
    ],
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
};

const localizedTargetLanguageLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "ja-JP": {
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
    const labels = targetLanguageLabelsByUiLanguage[uiLanguage] || multilingualTargetLanguageLabels;
    return labels[normalizeChineseLanguageCode(value)] || fallback;
}

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
    user_role: `Translate the following text into {{to}}, If translation is unnecessary (e.g. proper nouns, codes, etc.), return the original text. NO explanations. NO notes:

{{origin}}`,
    count: 0,
    useCache: true,
    floatingBallHotkey: "Alt+T", // 默认悬浮球快捷键
    inputBoxTranslationTrigger: "disabled", // 默认关闭输入框翻译
    inputBoxTranslationTarget: "en", // 默认翻译成英文
};
