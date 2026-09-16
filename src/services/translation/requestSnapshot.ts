/**
 * @file src/services/translation/requestSnapshot.ts
 *
 * 文件职责：在翻译消息上附加只读 provider 配置快照，消除异步缓存读取期间全局配置变化造成的请求身份错配。
 * 主要内容：定义配置快照、剩余预算、内部取消、线路观察与可信术语来源 symbol，冻结术语规则并从完整文本槽协议恢复纯匹配原文，供后台 broker 安全传递进程内状态。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import type {
    TranslationConfigSource,
    TranslationModelUsageObservation,
    TranslationProviderConfigSnapshot,
    TranslationRequestMessageBase,
    TranslationGlossaryContext,
} from './types';
import {normalizeFreeTranslationOrder, normalizeFreeTranslationMode} from '@/src/core/config/freeTranslation';
import {normalizeApiKeyRecoveryMs} from '@/src/core/config/scheduling';
import type {CustomOpenAIProvider} from '@/src/core/config/customOpenAI';
import {normalizeDeepLApiPlan} from '@/src/core/config/deepl';
import {resolveGlossary} from '@/src/core/glossary';
import {parseTranslationSlots} from '@/src/core/translation/public';
import type {TranslationRequestScheduler, TranslationRequestIdentity} from './requestScheduler';

/** 内部 symbol 无法由 content runtime 消息伪造，也不会进入网络 JSON。 */
export const TRANSLATION_PROVIDER_CONFIG = Symbol('fluentread.translation-provider-config');
export const TRANSLATION_REMAINING_BUDGET = Symbol('fluentread.translation-remaining-budget');
export const TRANSLATION_MODEL_USAGE_OBSERVER = Symbol('fluentread.translation-model-usage-observer');
export const TRANSLATION_ROUTE_OBSERVER = Symbol('fluentread.translation-route-observer');
export const TRANSLATION_REQUEST_CONTROL = Symbol('fluentread.translation-request-control');
export const TRANSLATION_REQUEST_SCHEDULER = Symbol('fluentread.translation-scheduler');
export const TRANSLATION_GLOSSARY_CONTEXT = Symbol('fluentread.translation-glossary-context');
export const TRANSLATION_IMAGE_INPUT = Symbol('fluentread.translation-image-input');

const MAX_TRANSLATION_IMAGE_INPUT_LENGTH = 20 * 1024 * 1024;
const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

export function validateTranslationImageInput(image: string): string {
    if (typeof image !== 'string' || image.length > MAX_TRANSLATION_IMAGE_INPUT_LENGTH) {
        throw new TypeError('图片输入必须是不超过 20 MiB 的 PNG、JPEG 或 WebP data image');
    }
    const match = image.match(IMAGE_DATA_URL_RE);
    if (!match || match[2].length % 4 === 1) {
        throw new TypeError('图片输入必须是 PNG、JPEG 或 WebP 的有效 base64 data image');
    }
    return image;
}

export function attachTranslationImageInput<T extends object>(message: T, image: string): T {
    Object.defineProperty(message, TRANSLATION_IMAGE_INPUT, {
        value: validateTranslationImageInput(image),
        // Symbol 属性不会进入 JSON/runtime 字段；保持可枚举只为后台对象展开时继续携带。
        enumerable: true,
        configurable: false,
        writable: false,
    });
    return message;
}

export function getTranslationImageInput(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const image = (message as {[TRANSLATION_IMAGE_INPUT]?: unknown})[TRANSLATION_IMAGE_INPUT];
    const match = typeof image === 'string' ? image.match(IMAGE_DATA_URL_RE) : null;
    return typeof image === 'string' && match !== null && match[2].length % 4 !== 1 && image.length <= MAX_TRANSLATION_IMAGE_INPUT_LENGTH
        ? image
        : undefined;
}

export interface TrustedTranslationGlossaryContext {
    readonly pageUrl?: string;
    readonly context?: TranslationGlossaryContext;
}

/** 真实 sender 或应用组合根才能绑定网页来源；字符串 payload 无法伪造此 symbol。 */
export function attachTranslationGlossaryContext<T extends object>(
    message: T,
    context: TrustedTranslationGlossaryContext,
): T {
    return Object.assign(message, {[TRANSLATION_GLOSSARY_CONTEXT]: Object.freeze({...context})});
}

export function getTranslationGlossaryContext(message: object): TrustedTranslationGlossaryContext | undefined {
    return (message as {[TRANSLATION_GLOSSARY_CONTEXT]?: TrustedTranslationGlossaryContext})[TRANSLATION_GLOSSARY_CONTEXT];
}

/** 仅解析完整的内部槽协议，避免哨兵下划线破坏词边界或被当成用户术语；其他文本原样匹配。 */
export function getTranslationGlossarySourceText(origin: string | string[]): string | string[] {
    if (Array.isArray(origin)) return origin.flatMap(getTranslationGlossarySourceText);
    const firstMarker = origin.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu);
    if (!firstMarker) return origin;
    // nonce 的白名单只允许字母、数字、下划线和连字符，可直接组成字面正则片段。
    const starts = [...origin.matchAll(new RegExp(`___FLUENTREAD_${firstMarker[1]}_\\d+_BEGIN___`, 'gu'))]
        .map(([marker]) => marker);
    const ends = starts.map(marker => marker.replace(/_BEGIN___$/u, '_END___'));
    return parseTranslationSlots({payload: origin, starts, ends}, origin) ?? origin;
}

/** 同一批次逐条发送时仍只外发该条原文真正命中的术语，摘要由模板显式跳过。 */
export function getTranslationGlossaryTerms(current: TranslationProviderConfigSnapshot, origin: string | string[]) {
    const context = current.glossaryMatchContext;
    if (!context) return current.glossaryTerms ?? [];
    if (!current.glossaryTerms?.length) return [];
    return resolveGlossary(current.glossaryLibraries ?? [], {
        ...context,
        glossaryIds: context.glossaryIds ? [...context.glossaryIds] : null,
        text: getTranslationGlossarySourceText(origin),
    }).terms;
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
    };
};

export function attachTranslationRequestScheduler<T extends object>(
    message: T,
    scheduler: TranslationRequestScheduler,
    identity?: TranslationRequestIdentity,
): T & TranslationProviderRequestContext {
    return Object.assign(message, {
        [TRANSLATION_REQUEST_SCHEDULER]: Object.freeze({scheduler, identity: identity ? Object.freeze({...identity}) : undefined}),
    });
}

export function getTranslationRequestScheduler(message: unknown): TranslationProviderRequestContext[typeof TRANSLATION_REQUEST_SCHEDULER] {
    if (!message || typeof message !== 'object') return undefined;
    return (message as TranslationProviderRequestContext)[TRANSLATION_REQUEST_SCHEDULER];
}

/** 为后台内部调用附加不可序列化的取消所有权；runtime payload 无法构造 symbol key。 */
export function attachTranslationRequestControl<T extends object>(
    message: T,
    control: TranslationRequestControl,
): T & TranslationRequestControlContext {
    if (!control.ownershipKey.trim()) throw new TypeError('翻译请求 ownershipKey 不能为空');
    Object.defineProperty(message, TRANSLATION_REQUEST_CONTROL, {
        value: Object.freeze({...control}),
        enumerable: false,
    });
    return message as T & TranslationRequestControlContext;
}

/** 普通 runtime 请求没有该 symbol，只有同一后台进程内的受信调用能取得控制信息。 */
export function getTranslationRequestControl(message: unknown): TranslationRequestControl | undefined {
    if (!message || typeof message !== 'object') return undefined;
    return (message as TranslationRequestControlContext)[TRANSLATION_REQUEST_CONTROL];
}

/** 把进程内观察器附到 provider 请求；symbol 不会通过 runtime 或 JSON 越过边界。 */
export function attachTranslationModelUsageObserver<T extends object>(
    message: T,
    observer: TranslationModelUsageObserver,
): T & TranslationProviderRequestContext {
    return Object.assign(message, {[TRANSLATION_MODEL_USAGE_OBSERVER]: observer});
}

/** 把线路观察器附到 provider 请求；symbol 不会通过 runtime 或 JSON 越过边界。 */
export function attachTranslationRouteObserver<T extends object>(
    message: T,
    observer: TranslationRouteObserver,
): T & TranslationProviderRequestContext {
    return Object.assign(message, {[TRANSLATION_ROUTE_OBSERVER]: observer});
}

/** 只交付线路标识与数值；与用量观察一样，统计旁路不得影响翻译结果。 */
export function reportTranslationRoute(message: unknown, observation: TranslationRouteObservation): void {
    if (!message || typeof message !== 'object') return;
    const observer = (message as TranslationProviderRequestContext)[TRANSLATION_ROUTE_OBSERVER];
    if (!observer) return;
    try {
        observer(observation);
    } catch {
        // 线路观察器是旁路，不允许反向影响免费链的回退决策。
    }
}

/** Provider 直调时没有观察器；统计旁路也绝不能让正常翻译失败。 */
export function reportTranslationModelUsage(
    message: unknown,
    observation: TranslationModelUsageObservation,
): void {
    if (!message || typeof message !== 'object') return;
    const observer = (message as TranslationProviderRequestContext)[TRANSLATION_MODEL_USAGE_OBSERVER];
    if (!observer) return;
    try {
        observer(observation);
    } catch {
        // 统计观察器是旁路，不允许反向影响 provider 响应解析。
    }
}

/** 只在 transport 已实际启动后调用；把网络/HTTP/解析失败记为无 usage 的真实尝试。 */
export function reportTranslationModelUsageFailure(
    message: unknown,
    error: unknown,
    startedAt: number,
    actualModel?: string,
    statusCode?: number,
): void {
    const candidateStatus = statusCode ?? (
        error && typeof error === 'object'
            ? (error as {statusCode?: unknown}).statusCode
            : undefined
    );
    const safeStatusCode = typeof candidateStatus === 'number'
        && Number.isInteger(candidateStatus)
        && candidateStatus >= 100
        && candidateStatus <= 599
        ? candidateStatus
        : undefined;
    const aborted = (error instanceof Error && error.name === 'AbortError')
        || Boolean((message as TranslationProviderRequestContext | null)?.abortSignal?.aborted);
    reportTranslationModelUsage(message, {
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(actualModel ? {actualModel} : {}),
        outcome: safeStatusCode === 408 ? 'timeout' : aborted ? 'cancelled' : 'error',
        usageAvailability: 'unreported',
        ...(safeStatusCode !== undefined ? {statusCode: safeStatusCode} : {}),
    });
}

/** 标记 requestTimeoutMs 已是上层事务的剩余预算，broker 不得再次抬高到公开入口下限。 */
export function markTranslationRemainingBudget<T extends {requestTimeoutMs: number}>(
    request: T,
): T & TranslationRemainingBudgetContext {
    Object.defineProperty(request, TRANSLATION_REMAINING_BUDGET, {value: true});
    return request as T & TranslationRemainingBudgetContext;
}

/** Provider 收到的类型化内部请求；在公开翻译消息之上附加配置快照和取消信号。 */
export type TranslationProviderRequest<TOrigin = string | string[]> = TranslationRequestMessageBase
    & TranslationProviderRequestContext
    & {
        origin: TOrigin;
        /** 仅摘要请求使用；普通正文 provider 可忽略。 */
        summaryPrompt?: string;
        summarySystemPrompt?: string;
    };

function frozenStringMap(value: Record<string, string> | undefined): Readonly<Record<string, string>> {
    return Object.freeze({...value});
}

function frozenApiKeys(value: Record<string, readonly string[]> | undefined): Readonly<Record<string, readonly string[]>> {
    return Object.freeze(Object.fromEntries(Object.entries(value ?? {}).map(([service, keys]) => [service, Object.freeze([...keys])]))) as Readonly<Record<string, readonly string[]>>;
}

function frozenBooleanMap(value: Record<string, boolean> | undefined): Readonly<Record<string, boolean>> {
    return Object.freeze({...value});
}

function frozenNestedBooleanMap(
    value: Record<string, Record<string, boolean>> | undefined,
): Readonly<Record<string, Readonly<Record<string, boolean>>>> {
    return Object.freeze(Object.fromEntries(
        Object.entries(value || {}).map(([service, models]) => [service, frozenBooleanMap(models)]),
    ));
}

function frozenRequestLimitMap(
    value: TranslationConfigSource['serviceRequestLimits'],
): TranslationProviderConfigSnapshot['serviceRequestLimits'] {
    return Object.freeze(Object.fromEntries(Object.entries(value || {}).map(([service, setting]) => [service, Object.freeze({
        enabled: setting.enabled === true,
        limits: Object.freeze({...setting.limits}),
    })])));
}

function frozenModelRequestLimitMap(
    value: TranslationConfigSource['modelRequestLimits'],
): TranslationProviderConfigSnapshot['modelRequestLimits'] {
    return Object.freeze(Object.fromEntries(Object.entries(value || {}).map(([service, models]) => [service,
        Object.freeze(Object.fromEntries(Object.entries(models || {}).map(([model, setting]) => [model, Object.freeze({
            enabled: setting.enabled === true,
            limits: Object.freeze({...setting.limits}),
        })]))),
    ])));
}

function frozenCustomOpenAIProviders(
    value: readonly CustomOpenAIProvider[] | undefined,
): readonly Readonly<CustomOpenAIProvider>[] {
    return Object.freeze((value || []).map((provider) => Object.freeze({
        ...provider,
        models: Object.freeze([...provider.models]) as unknown as string[],
    })));
}

/**
 * 在任何 await 之前复制 provider 与缓存身份会读取的字段。嵌套映射和顶层对象
 * 均冻结，配置页后续原地修改不会改变已在途请求。
 */
export function createTranslationProviderConfigSnapshot(
    source: TranslationConfigSource,
): TranslationProviderConfigSnapshot {
    // 已保存模型列表只服务于设置 UI，不参与一次请求的模型身份；显式排除，避免
    // Config 结构化兼容传入时把可变数组引用带进冻结快照。
    // 免费服务权重只由后台性能统计决定，不接受导入配置或旧设置中的手动权重。
    const {customModels: _savedCustomModels, freeTranslationWeights: _manualWeights, ...providerSource} = source as TranslationConfigSource & {
        customModels?: unknown;
        freeTranslationWeights?: unknown;
    };
    return Object.freeze({
        ...providerSource,
        freeTranslationOrder: Object.freeze(normalizeFreeTranslationOrder(source.freeTranslationOrder)),
        freeTranslationMode: normalizeFreeTranslationMode(source.freeTranslationMode),
        deeplApiPlan: normalizeDeepLApiPlan(source.deeplApiPlan),
        glossaryLibraries: Object.freeze((source.glossaryLibraries ?? []).map((library) => Object.freeze({
            ...library,
            domains: Object.freeze([...library.domains]),
            entries: Object.freeze(library.entries.map((entry) => Object.freeze({...entry}))),
        }))),
        documentGlossaryIds: source.documentGlossaryIds ? Object.freeze([...source.documentGlossaryIds]) : null,
        videoGlossaryIds: source.videoGlossaryIds ? Object.freeze([...source.videoGlossaryIds]) : null,
        glossaryTerms: Object.freeze((source.glossaryTerms ?? []).map((term) => Object.freeze({...term}))),
        ...(source.glossaryMatchContext ? {glossaryMatchContext: Object.freeze({
            ...source.glossaryMatchContext,
            glossaryIds: source.glossaryMatchContext.glossaryIds
                ? Object.freeze([...source.glossaryMatchContext.glossaryIds]) : null,
        })} : {}),
        model: frozenStringMap(source.model),
        customModel: frozenStringMap(source.customModel),
        modelThinking: frozenNestedBooleanMap(source.modelThinking),
        customOpenAIProviders: frozenCustomOpenAIProviders(source.customOpenAIProviders),
        proxy: frozenStringMap(source.proxy),
        customBody: frozenStringMap(source.customBody),
        customHeaders: frozenStringMap(source.customHeaders),
        serviceRequestLimits: frozenRequestLimitMap(source.serviceRequestLimits),
        modelRequestLimits: frozenModelRequestLimitMap(source.modelRequestLimits),
        apiKeyRecoveryMs: normalizeApiKeyRecoveryMs(source.apiKeyRecoveryMs),
        system_role: frozenStringMap(source.system_role),
        user_role: frozenStringMap(source.user_role),
        token: frozenStringMap(source.token),
        apiKeys: frozenApiKeys(source.apiKeys),
        secret: frozenStringMap(source.secret),
        serviceRegion: frozenStringMap(source.serviceRegion),
        requireApiKey: frozenBooleanMap(source.requireApiKey),
        youdaoAppKey: source.youdaoAppKey ?? '',
        youdaoAppSecret: source.youdaoAppSecret ?? '',
        tencentSecretId: source.tencentSecretId ?? '',
        tencentSecretKey: source.tencentSecretKey ?? '',
    }) as TranslationProviderConfigSnapshot;
}

export function attachTranslationProviderConfig<T extends object>(
    message: T,
    snapshot: TranslationProviderConfigSnapshot,
): T & TranslationProviderRequestContext {
    return Object.assign(message, {[TRANSLATION_PROVIDER_CONFIG]: snapshot});
}

/** Provider 直调测试保留 fallback；broker 路径始终命中不可伪造的 request snapshot。 */
export function getTranslationProviderConfig(
    message: unknown,
    fallback: TranslationProviderConfigSnapshot,
): TranslationProviderConfigSnapshot {
    if (message && typeof message === 'object') {
        const snapshot = (message as TranslationProviderRequestContext)[TRANSLATION_PROVIDER_CONFIG];
        if (snapshot) return snapshot;
    }
    return fallback;
}
