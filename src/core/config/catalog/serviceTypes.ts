/**
 * @file src/core/config/catalog/serviceTypes.ts
 *
 * 文件职责：集中维护翻译服务阵营分类集合与能力谓词，供校验、协议路由、配置归一化和设置界面统一判定服务特性。
 * 主要内容：导出 servicesType，包含 machine、cloudVendor、AI、aiSdk、useToken、useModel、useSecret、useRegion、useProxy 集合以及 isAI、isUseAIContext、isUseCustomBody 等完整能力判定函数。
 * 模块边界：仅依赖 services 基础标识、customOpenAI ID 识别与 doubaoSeedTranslation 专用翻译模型判定；不承载模型列表、界面选项或语言标签数据。
 */

import {isCustomOpenAIProviderId} from '../customOpenAI';
import {isDoubaoSeedTranslationModel} from '../doubaoSeedTranslation';
import {
    cloudCredentialLabels,
    cloudVendorServices,
    referenceAiPlatformServices,
    services,
} from './services';

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
        services.chatgptPlan,
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
        // 本地 Ollama 与 Rapid-MLX 默认无鉴权，不纳入密钥要求。
        ...referenceAiPlatformServices.filter((service) => service !== services.ollama && service !== services.rapidmlx),
        // 云服务厂商统一把主密钥存放在 token[service]。
        ...cloudVendorServices.filter((service) => service !== services.tencent),
    ]),
    // 需要 model
    useModel: new Set([
        services.openai,
        services.chatgptPlan,
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
        services.huanYuan,
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
    // 套餐预览协议只接受明确支持的字段；其他 AI 服务保留附加顶层字段。
    isUseCustomBody: (service: string) => service !== services.chatgptPlan && servicesType.isAI(service),
    isCustom: (service: string) => isCustomOpenAIProviderId(service),
    isNewApi: (service: string) => service === services.newapi,
    isYoudao: (service: string) => service === services.youdao,
    isTencent: (service: string) => service === services.tencent || service === services.huanYuanTranslation,
    isAzureOpenai: (service: string) => service === services.azureOpenai,
};
