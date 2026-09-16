/**
 * @file src/services/translation/types.ts
 *
 * 文件职责：定义翻译 broker、缓存和 provider 之间的端口与消息契约，约束单条、批量、语言和配置快照的数据形状。
 * 主要内容：包含 TranslationRequestMessage、runtime 请求/取消协议、ProviderRegistry、CachePort、ConfigSnapshot、ProviderConfigFields 及含模型用量与翻译统计端口的 BrokerDependencies/Broker 等接口，并允许 Chrome 内置翻译携带不含结构哨兵的源语言检测样本，为依赖注入和测试替身提供稳定边界。 可核对的公开符号包括 TranslationRequestMessageBase、TranslationRuntimeRequestMessage、TranslationCancelMessage、TranslationProvider、TranslationProviderRegistry、TranslationLanguageOverride、TranslationLanguages。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import type {CustomOpenAIProvider} from '@/src/core/config/customOpenAI';
import type {DeepLApiPlan} from '@/src/core/config/deepl';
import type {ModelThinkingMapping} from '@/src/core/config/modelThinking';
import type {GlossaryLibrary} from '@/src/core/glossary';
import type {TranslationRequestStatsEvent} from '@/src/services/translation-stats/types';

export type TranslationGlossaryContext = 'page' | 'document' | 'video';
export interface TranslationGlossaryTerm {
    readonly source: string;
    readonly target: string;
}

export interface TranslationRequestMessageBase {
    /** null/缺省跟随入口默认；空数组显式关闭此次术语干预。 */
    glossaryIds?: readonly string[] | null;
    /** 由客户端在任务开始时冻结；配置更新后旧任务必须重新开始。 */
    glossaryRevision?: string;
    /** 只选择入口默认词库；网站范围始终由受信发送者上下文决定。 */
    glossaryContext?: TranslationGlossaryContext;
    context?: string;
    pageContext?: string;
    /** 当前请求是否允许 AI 网页上下文；全文翻译会显式携带会话启动时的冻结值。 */
    enableAIContext?: boolean;
    useCache?: boolean;
    /** 全文翻译内部标记；仅允许通用提示词型 AI 把数组合并为一次上游请求。 */
    aiMultiSegment?: boolean;
    /** 视频字幕、文档等独立入口使用的翻译服务；普通网页请求不设置。 */
    serviceOverride?: string;
    /** 文档、翻译中心等独立入口指定的实际模型；普通网页请求不设置。 */
    modelOverride?: string;
    /** 当前请求冻结的模型级 Thinking 状态；缺省时由后台配置快照解析。 */
    thinkingOverride?: boolean;
    /** 翻译中心仅对当前请求使用的语言，不改变全局设置。 */
    sourceLanguage?: string;
    targetLanguage?: string;
    /** 仅供本地模型或 Chrome 内置翻译在 auto 模式检测语言；正文仍以 origin 为准。 */
    sourceLanguageDetectionText?: string;
    /** provider deadline；用于避免可选摘要耗尽整次请求。 */
    requestTimeoutMs?: number;
}

export type TranslationSingleRequestMessage = TranslationRequestMessageBase & {origin: string};
export type TranslationBatchRequestMessage = TranslationRequestMessageBase & {origin: string[]};
export type TranslationRequestMessage = TranslationSingleRequestMessage | TranslationBatchRequestMessage;

/** content -> background 的传输层字段；后台解析后必须剥离，不得进入 broker/provider。 */
export type TranslationRuntimeRequestMessage = TranslationRequestMessage & {clientRequestId: string};

export const TRANSLATION_CANCEL_MESSAGE_TYPE = 'fluentReadTranslationCancel' as const;
export interface TranslationCancelMessage {
    readonly type: typeof TRANSLATION_CANCEL_MESSAGE_TYPE;
    readonly clientRequestId?: unknown;
}
export interface TranslationCancelResponse {
    readonly success: true;
    readonly cancelled: boolean;
    readonly clientRequestId: string;
}

export type TranslationProvider = (message: Record<string, unknown>) => Promise<unknown>;
export type TranslationProviderRegistry = Record<string, TranslationProvider>;

export type TranslationModelUsageOutcome = 'success' | 'error' | 'timeout' | 'cancelled';
export type TranslationModelUsageAvailability = 'reported' | 'unreported' | 'malformed';
export type TranslationModelUsagePurpose = 'translation' | 'page-summary' | 'connection-test';

/** Provider 或 transport 对单次真实上游尝试返回的最小、无敏感信息用量观察。 */
export interface TranslationModelUsageObservation {
    startedAt?: number;
    durationMs?: number;
    actualModel?: string;
    outcome?: TranslationModelUsageOutcome;
    usageAvailability: TranslationModelUsageAvailability;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    statusCode?: number;
}

/** Broker 补齐服务、用途和输入规模后交给本地统计仓库的事件。 */
export interface TranslationModelUsageRecord extends TranslationModelUsageObservation {
    startedAt: number;
    durationMs: number;
    serviceId: string;
    configuredModel: string;
    purpose: TranslationModelUsagePurpose;
    outcome: TranslationModelUsageOutcome;
}

export interface TranslationLanguageOverride {
    sourceLanguage?: string;
    targetLanguage?: string;
}

export interface TranslationLanguages {
    sourceLanguage: string;
    targetLanguage: string;
}

export interface TranslationCachePort {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    clear: () => Promise<void>;
    cleanup: () => Promise<void>;
}

export interface TranslationConfigSnapshot {
    glossaryEnabled?: boolean;
    glossaryLibraries?: readonly GlossaryLibrary[];
    documentGlossaryIds?: readonly string[] | null;
    videoGlossaryIds?: readonly string[] | null;
    /** 仅后台从原文命中后派生，绝不直接采纳公开消息传入的术语。 */
    glossaryTerms?: readonly TranslationGlossaryTerm[];
    /** 与冻结词库配合，为批量 provider 的每次实际上游调用重新筛选命中词。 */
    glossaryMatchContext?: Readonly<{
        sourceLanguage: string;
        targetLanguage: string;
        pageUrl?: string;
        glossaryIds?: readonly string[] | null;
    }>;
    service: string;
    from: string;
    to: string;
    useCache: boolean;
    enableAIContext: boolean;
    model: Record<string, string>;
    customModel: Record<string, string>;
    modelThinking?: ModelThinkingMapping;
    customOpenAIProviders?: CustomOpenAIProvider[];
    proxy: Record<string, string>;
    custom: string;
    deeplApiPlan?: DeepLApiPlan;
    deeplx: string;
    freeTranslationOrder?: readonly string[];
    freeTranslationMode?: 'balanced' | 'sequential';
    freeTranslationTimeoutMs?: number;
    freeTranslationCooldownMs?: number;
    myMemoryEmail?: string;
    newApiUrl: string;
    minimaxBillingPlan: string;
    minimaxRegion: string;
    mimoBillingPlan: string;
    mimoRegion: string;
    azureOpenaiEndpoint: string;
    customBody: Record<string, string>;
    customHeaders?: Record<string, string>;
    system_role: Record<string, string>;
    user_role: Record<string, string>;
    deepseekApiType: string;
    deepseekThinkingMode: string;
    /** 云服务厂商所选地域；决定签名 scope 与请求域名。 */
    serviceRegion?: Record<string, string>;
    /** 请求调度策略；provider 适配器只读取重试次数，其余字段由调度边界消费。 */
    translationMaxRetries?: number;
    translationBackoffBaseMs?: number;
    translationBackoffMaxMs?: number;
    /** 稀疏的服务/模型独立限流配置；未启用时保持旧 global budget。 */
    serviceRequestLimits?: Record<string, {
        enabled: boolean;
        limits: {
            maxConcurrentTranslations: number;
            translationRequestsPerSecond: number;
            translationRequestsPerMinute: number;
        };
    }>;
    modelRequestLimits?: Record<string, Record<string, {
        enabled: boolean;
        limits: {
            maxConcurrentTranslations: number;
            translationRequestsPerSecond: number;
            translationRequestsPerMinute: number;
        };
    }>>;
    /** 多 API Key 失败后默认冷却恢复时间；服务端 Retry-After 优先。 */
    apiKeyRecoveryMs?: number;
}

export interface TranslationProviderConfigFields {
    token: Record<string, string>;
    apiKeys?: Record<string, readonly string[]>;
    /** 云服务厂商与主密钥配对的第二段密钥，按服务标识存放。 */
    secret: Record<string, string>;
    requireApiKey: Record<string, boolean>;
    youdaoAppKey: string;
    youdaoAppSecret: string;
    tencentSecretId: string;
    tencentSecretKey: string;
}

/** 一次 provider 调用使用的完整、不可变配置视图。 */
export type TranslationProviderConfigSnapshot = Readonly<TranslationConfigSnapshot & TranslationProviderConfigFields>;

/** 测试或迁移期配置源可以省略凭据字段，snapshot factory 会补安全默认值。 */
export type TranslationConfigSource = TranslationConfigSnapshot & Partial<TranslationProviderConfigFields>;

export interface TranslationServiceIds {
    minimax: string;
    mimo: string;
}

export interface TranslationServiceTypes {
    machine: {has: (service: string) => boolean};
    isAI: (service: string) => boolean;
    isAiSdk: (service: string) => boolean;
    isUseAIContext: (service: string, model?: string) => boolean;
}

export interface TranslationEndpointResolver {
    resolveOpenAICompatibleEndpoint: (
        service: string,
        config?: TranslationProviderConfigSnapshot,
    ) => {endpoint: string};
    getMimoEndpoint: (plan: string, region: string) => string;
    minimaxEndpoints: Record<string, Record<string, string>>;
    aiSdkTransportProfile: string;
}

export interface TranslationPromptBuilder {
    buildPageSummaryPrompt: (pageContext: string) => string;
    buildPageSummarySystemPrompt: () => string;
}

export interface TranslationBrokerDependencies {
    ready: Promise<unknown>;
    getConfig: () => TranslationConfigSource;
    providers: TranslationProviderRegistry;
    cache: TranslationCachePort;
    serviceIds: TranslationServiceIds;
    serviceTypes: TranslationServiceTypes;
    endpointResolver: TranslationEndpointResolver;
    promptBuilder: TranslationPromptBuilder;
    getMissingCredentialMessage: (service: string, config: TranslationConfigSnapshot) => string | null;
    getTranslationLanguages: (override?: TranslationLanguageOverride) => TranslationLanguages;
    resolveConfiguredModel: (selected?: string, custom?: string) => string;
    buildTranslationCacheKey: (identity: Record<string, unknown>) => string;
    /** 在 provider 真正开始前捕获重置代次，避免清除后在途旧请求把事件写回来。 */
    captureModelUsageGeneration?: () => number;
    /** 本地统计是旁路能力；正常写入可在响应前短暂等待，失败或超时不得改变翻译结果。 */
    recordModelUsage?: (
        events: readonly TranslationModelUsageRecord[],
        generation: number,
    ) => Promise<void>;
    /** 请求开始时捕获翻译统计代次，清除统计后才结束的旧请求不会写回。 */
    captureTranslationStatsGeneration?: () => number;
    /** 翻译请求结束后同步交付统计事件；实现方自行缓冲写入，不能阻塞或改变翻译结果。 */
    recordTranslationRequest?: (event: TranslationRequestStatsEvent, generation: number) => void;
    /** 响应前等待本地缓存和用量写入的最长宽限期；主要供测试和受限运行时注入。 */
    persistenceGraceMs?: number;
    now?: () => number;
    logger?: Pick<Console, 'warn'>;
    /** 可由 app composition root 注入，使 broker、连接测试和输入框共用 bucket。 */
    requestScheduler?: import('./requestScheduler').TranslationRequestScheduler;
}

export interface TranslationBroker {
    translateWithCache: (message: TranslationRequestMessage) => Promise<string | string[]>;
    clearTranslationCache: () => Promise<void>;
    cleanupTranslationCache: () => Promise<void>;
}
