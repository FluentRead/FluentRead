/**
 * @file src/services/translation/types.ts
 *
 * 文件职责：定义翻译 broker、缓存和 provider 之间的端口与消息契约，约束单条、批量、语言和配置快照的数据形状。
 * 主要内容：统一持有 ProviderRequest、配置/调度/取消 symbol context、观察契约、TranslationRequestMessage、runtime 请求/取消协议、识图探测与取消的唯一消息名称、ProviderRegistry、CachePort、ConfigSnapshot、ProviderConfigFields 及含模型用量与翻译统计端口的 BrokerDependencies/Broker 等接口，并允许 Chrome 内置翻译携带不含结构哨兵的源语言检测样本，为依赖注入和测试替身提供稳定边界。 可核对的公开符号包括 TranslationRequestMessageBase、TranslationRuntimeRequestMessage、TranslationCancelMessage、VISION_PROBE_MESSAGE、VISION_PROBE_CANCEL_MESSAGE、TranslationProvider、TranslationProviderRegistry、TranslationLanguageOverride、TranslationLanguages。
 * 模块边界：本文件位于翻译 application service 层，只提供纯类型、消息字面量和内部 symbol 身份；所有依赖均为 type-only，导入契约不初始化探测实现、正文候选或供应商；不挂载页面 UI，具体 HTTP 协议由 providers/platform 实现。
 */

import type {CustomOpenAIProvider} from '@/src/core/config/customOpenAI';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
import type {DeepLApiPlan} from '@/src/core/config/deepl';
import type {ModelThinkingMapping} from '@/src/core/config/modelThinking';
import type {GlossaryLibrary} from '@/src/core/glossary';
import type {TranslationRequestStatsEvent} from '@/src/services/translation-stats/types';
import type {TranslationRequestScheduler, TranslationRequestIdentity, TranslationRequestLease} from './requestScheduler';

/** 内部 symbol 无法由 content runtime 消息伪造，也不会进入网络 JSON。 */
export const TRANSLATION_PROVIDER_CONFIG = Symbol('fluentread.translation-provider-config');

export const TRANSLATION_REMAINING_BUDGET = Symbol('fluentread.translation-remaining-budget');

export const TRANSLATION_REQUEST_STARTED_AT = Symbol('fluentread.translation-request-started-at');

export const TRANSLATION_MODEL_USAGE_OBSERVER = Symbol('fluentread.translation-model-usage-observer');

export const TRANSLATION_ROUTE_OBSERVER = Symbol('fluentread.translation-route-observer');

export const TRANSLATION_REQUEST_CONTROL = Symbol('fluentread.translation-request-control');

export const TRANSLATION_REQUEST_SCHEDULER = Symbol('fluentread.translation-scheduler');

export const TRANSLATION_GLOSSARY_CONTEXT = Symbol('fluentread.translation-glossary-context');

export const TRANSLATION_IMAGE_INPUT = Symbol('fluentread.translation-image-input');

export interface TrustedTranslationGlossaryContext {
    readonly pageUrl?: string;
    readonly context?: TranslationGlossaryContext;
    /** 只由后台真实 sender 绑定，用于内存 quota 隔离；不写入缓存或网络。 */
    readonly privateContext?: boolean;
}

export type TranslationModelUsageObserver = (observation: TranslationModelUsageObservation) => void;

/** 免费翻译链等内部多线路 provider 对单次线路尝试的无文本观察。 */
export interface TranslationRouteObservation {
    readonly route: string;
    readonly outcome: TranslationRouteOutcome;
    readonly durationMs: number;
    readonly chars: number;
}

export type TranslationRouteOutcome = 'success' | 'error' | 'timeout' | 'cancelled';

export type TranslationRouteObserver = (observation: TranslationRouteObservation) => void;

export type TranslationRemainingBudgetContext = {
    readonly [TRANSLATION_REMAINING_BUDGET]?: true;
};

export interface TranslationRequestControl {
    readonly signal: AbortSignal;
    /** 只影响 pending 去重所有权，不进入持久缓存 identity。 */
    readonly ownershipKey: string;
}

export type TranslationRequestControlContext = {
    readonly [TRANSLATION_REQUEST_CONTROL]?: TranslationRequestControl;
};

export type TranslationProviderRequestContext = {
    readonly [TRANSLATION_PROVIDER_CONFIG]?: TranslationProviderConfigSnapshot;
    readonly [TRANSLATION_MODEL_USAGE_OBSERVER]?: TranslationModelUsageObserver;
    readonly [TRANSLATION_ROUTE_OBSERVER]?: TranslationRouteObserver;
    /** 仅由 broker 在后台注入；provider 必须向底层 transport 继续传递。 */
    readonly abortSignal?: AbortSignal;
    /** 后台注入的共享调度器；provider 仅用于真实 HTTP attempt，不取得嵌套并发槽。 */
    readonly [TRANSLATION_REQUEST_SCHEDULER]?: {
        readonly scheduler: TranslationRequestScheduler;
        readonly identity?: TranslationRequestIdentity;
        /** provider 在真正启动 transport 时登记结算，取消包装不能提前归还外层并发槽。 */
        readonly lease?: TranslationRequestLease;
    };
};

/** Provider 收到的类型化内部请求；在公开翻译消息之上附加配置快照和取消信号。 */
export type TranslationProviderRequest<TOrigin = string | string[]> = TranslationRequestMessageBase
    & TranslationProviderRequestContext
    & {
        origin: TOrigin;
        /** 仅摘要请求使用；普通正文 provider 可忽略。 */
        summaryPrompt?: string;
        summarySystemPrompt?: string;
    };

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
    /** 有界单篇原文/既有译文证据；与页面摘要分开，避免每段额外摘要调用。 */
    discourseContext?: string;
    /** 当前请求是否允许 AI 网页上下文；全文翻译会显式携带会话启动时的冻结值。 */
    enableAIContext?: boolean;
    /** 请求入口冻结的原生合批偏好；缺省由后台当前服务配置解析。 */
    enableNativeBatch?: boolean;
    useCache?: boolean;
    /** 全文翻译内部标记；仅允许通用提示词型 AI 把数组合并为一次上游请求。 */
    aiMultiSegment?: boolean;
    /** 文档数组请求的合批意图；后台必须根据真实文档入口验证，不能从网页或单条请求启用。 */
    documentBatch?: boolean;
    /** 全文内部的单条槽协议；broker 按冻结术语配置逐槽校验，沿用本次请求的截止时间。 */
    validateTranslationSlots?: boolean;
    /** 行内代码的单条标记协议；仅已验证的响应可进入独立缓存。 */
    validateInlineCodeTranslation?: boolean;
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
/** 设置页与后台共用纯消息契约，读取名称不加载探测实现。 */
export const VISION_PROBE_MESSAGE = 'fluentReadModelVisionProbe';
export const VISION_PROBE_CANCEL_MESSAGE = 'fluentReadModelVisionProbeCancel';
export interface TranslationCancelMessage {
    readonly type: typeof TRANSLATION_CANCEL_MESSAGE_TYPE;
    readonly clientRequestId?: unknown;
}
export interface TranslationCancelResponse {
    readonly success: true;
    readonly cancelled: boolean;
    readonly clientRequestId: string;
}

/** 适配器的合法输出；broker 面对不可信供应商响应时仍以 unknown 完成运行时校验。 */
export type TranslationProviderResult = string | string[];
export type TranslationProvider<TResult = unknown, TOrigin = string | string[]> =
    (message: TranslationProviderRequest<TOrigin>) => Promise<TResult>;
export type TranslationProviderRegistry<TResult = unknown> = Record<string, TranslationProvider<TResult>>;

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
    privateTranslation?: Readonly<import('@/src/core/config/privateTranslation').PrivateTranslationConfig>;
    /** 本次请求的界面语言，仅用于本地服务稳定失败文案。 */
    uiLanguage?: string;
    glossaryEnabled?: boolean;
    glossaryLibraries?: readonly GlossaryLibrary[];
    documentGlossaryIds?: readonly string[] | null;
    videoGlossaryIds?: readonly string[] | null;
    /** 仅后台从原文命中后派生，绝不直接采纳公开消息传入的术语。 */
    glossaryTerms?: readonly TranslationGlossaryTerm[];
    /** 仅在 provider 调用边界生成；提示词只能要求原样保留这些占位符。 */
    glossaryProtectedTokens?: readonly string[];
    /** 与冻结词库配合，为批量 provider 的每次实际上游调用重新筛选命中词。 */
    glossaryMatchContext?: Readonly<{
        /** broker 根据当前入口派生；文档正文的地址与代码名称使用同一严格保护链。 */
        context?: TranslationGlossaryContext;
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
    /** AI provider 总请求预算；缺省使用统一默认值，不影响机器/浏览器内置翻译。 */
    aiRequestTimeoutMs?: number;
    nativeBatchTranslationEnabled?: Readonly<Record<string, boolean>>;
    model: Record<string, string>;
    customModel: Record<string, string>;
    modelThinking?: ModelThinkingMapping;
    customOpenAIProviders?: CustomOpenAIProvider[];
    compositeTranslationProviders?: CompositeTranslationProvider[];
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
    requestHeaderRules?: import('@/src/core/config/requestHeaders').RequestHeaderRule[];
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
    /** 请求开始时复制并冻结；缺省启用，多 Key 服务可显式关闭。 */
    apiKeyRotationEnabled?: Readonly<Record<string, boolean>>;
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

export interface TranslationServiceTypes {
    machine: {has: (service: string) => boolean};
    isAI: (service: string) => boolean;
    isAiSdk: (service: string) => boolean;
    isUseAIContext: (service: string, model?: string) => boolean;
}

export interface TranslationEndpointResolver {
    resolveOpenAICompatibleEndpoint: (
        service: string,
        config: TranslationProviderConfigSnapshot,
    ) => {endpoint: string};
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
