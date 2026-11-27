/**
 * @file src/core/config/catalog/services.ts
 *
 * 文件职责：定义 FluentRead 所有内置翻译服务的稳定标识、云厂商凭据标签、分组列表以及模型配置解析纯函数。
 * 主要内容：导出 services、cloudCredentialLabels、CloudCredentialLabels、getCloudCredentialLabels、cloudVendorServices、referenceAiPlatformServices、customModelString 与 resolveConfiguredModel，为配置、协议与界面提供零外部依赖的基础目录事实。
 * 模块边界：本文件属于 core 配置目录底层叶子模块，不依赖任何其他业务或配置子模块；服务类型判定、地域白名单、模型列表和下拉选项分别由同目录其他子模块派生。
 */

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
    chromeTranslator: "chromeTranslator", // 浏览器内置翻译，沿用已有的配置服务 ID
    localTranslation: "localTranslation", // 浏览器内本地模型翻译
    // 云服务厂商机器翻译：使用云控制台签发的密钥调用官方接口，各家都提供免费额度
    tencent: "tencent", // 腾讯云机器翻译 TMT
    googleCloudTranslation: "googleCloudTranslation", // Google Cloud Translation API
    azureTranslator: "azureTranslator", // Azure AI Translator
    aliyunTranslation: "aliyunTranslation", // 阿里云机器翻译
    baiduTranslation: "baiduTranslation", // 百度翻译开放平台
    volcTranslation: "volcTranslation", // 火山引擎机器翻译
    // 大模型翻译
    openai: "openai",
    chatgptPlan: "chatgptPlan", // 本机助手持有 OAuth；账户模型在授权后发现。
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
    runcrate: "runcrate", // Runcrate
    cloudgpu: "cloudgpu", // CloudGPU
    cheaperinference: "cheaperinference", // Cheaper Inference
    cheapaimodel: "cheapaimodel", // cheapaimodel
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
    services.runcrate,
    services.cloudgpu,
    services.cheaperinference,
    services.cheapaimodel,
]);

export const customModelString = '自定义模型' as const;

/** 解析实际发送给 provider 的模型。 */
export function resolveConfiguredModel(selectedModel?: string, customModel?: string): string {
    return selectedModel === customModelString ? customModel || '' : selectedModel || '';
}
