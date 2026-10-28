/**
 * @file src/services/translation/requestSnapshot.ts
 *
 * 文件职责：冻结翻译消息的可编辑字段与数组，并附加只读 provider 配置快照，复制并深度冻结服务合批偏好及组合成员配置，归一化 AI 超时设置，消除异步缓存读取期间全局配置变化造成的请求身份错配。
 * 主要内容：在入口一次读取消息字段并复制原文/图片文本/术语数组，保留内部 symbol 描述符，通过不可序列化的内部标记允许图片文字原样返回成功；配置读取沿用已附着的可信对象，未附着时才同步执行备用快照工厂，请求边界可以显式提供备用快照工厂，provider 内核只消费必需的受信快照；构造配置快照并操作 types.ts 唯一持有的剩余预算、内部取消、线路观察与可信术语及隐私来源契约，携带后台调度租约让实际网络及响应读取结束前持续占用并发槽，冻结术语规则并从完整文本槽协议恢复纯匹配原文及供文档逐槽结构校验复用的协议快照；以线性首尾边界扫描确定命名空间和最终外层槽数，保留来源中的字面标记和自定义命名空间，重复、交错与缺项仍由同一严格解析器拒绝；userscript 编译时裁剪扩展文档页专属的自动字面值扫描。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；文本槽恢复复用 core/translation/slotProtocol.ts 纯协议，不初始化 DOM 候选或网站规则；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {
    TRANSLATION_PROVIDER_CONFIG,
    TRANSLATION_REMAINING_BUDGET,
    TRANSLATION_MODEL_USAGE_OBSERVER,
    TRANSLATION_ROUTE_OBSERVER,
    TRANSLATION_REQUEST_CONTROL,
    TRANSLATION_REQUEST_SCHEDULER,
    TRANSLATION_GLOSSARY_CONTEXT,
    TRANSLATION_IMAGE_INPUT,
    type TrustedTranslationGlossaryContext,
    type TranslationModelUsageObserver,
    type TranslationRouteObservation,
    type TranslationRouteObserver,
    type TranslationRemainingBudgetContext,
    type TranslationRequestControl,
    type TranslationRequestControlContext,
    type TranslationProviderRequestContext,
    type TranslationConfigSource,
    type TranslationModelUsageObservation,
    type TranslationProviderConfigSnapshot,
} from './types';
export type {TrustedTranslationGlossaryContext} from './types';
import {normalizeFreeTranslationOrder, normalizeFreeTranslationMode} from '@/src/core/config/freeTranslation';
import {normalizeApiKeyRecoveryMs} from '@/src/core/config/scheduling';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import type {CustomOpenAIProvider} from '@/src/core/config/customOpenAI';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
import {normalizeDeepLApiPlan} from '@/src/core/config/deepl';
import {normalizeNativeBatchTranslationEnabled} from '@/src/core/config/nativeBatch';
import {resolveGlossaryEntries} from '@/src/core/glossary';
import {parseTranslationSlots, type SerializedTranslationSlots} from '@/src/core/translation/slotProtocol';
import {findDocumentLiteralTerms} from '@/src/core/translation/documentLiterals';
import {resolveTranslationLanguages, type TranslationLanguageOverride} from '@/src/core/translation/languages';
import type {TranslationRequestScheduler, TranslationRequestIdentity, TranslationRequestLease} from './requestScheduler';

/** 在入口第一次等待前复制用户可编辑的数组与消息字段，同时保留不可枚举的内部 symbol。 */
export function createTranslationRequestSnapshot<T extends object>(message: T): T {
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(message);
    for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        const value = 'value' in descriptor ? descriptor.value : Reflect.get(message, key);
        descriptors[key] = {
            value: (key === 'origin' || key === 'glossaryIds' || key === 'texts') && Array.isArray(value) ? [...value] : value,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
            writable: descriptor.writable ?? false,
        };
    }
    return Object.defineProperties({}, descriptors) as T;
}

const TRANSLATION_ACCEPT_UNCHANGED_RESULT = Symbol('fluentread.translation-accept-unchanged-result');

/** 图片文字允许有效原样结果；内部标记随后台对象展开保留，不进入 runtime 或网络 JSON。 */
export function allowUnchangedTranslationResult<T extends object>(message: T): T {
    return Object.assign(message, {[TRANSLATION_ACCEPT_UNCHANGED_RESULT]: true});
}

export function isUnchangedTranslationResultAllowed(message: unknown): boolean {
    return Boolean(message && typeof message === 'object'
        && (message as {[TRANSLATION_ACCEPT_UNCHANGED_RESULT]?: unknown})[TRANSLATION_ACCEPT_UNCHANGED_RESULT] === true);
}

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

/** 只解释后台的 sender 与平台上下文，未知来源保留未知；不读取 payload 的自报隐私字段。 */
export interface TrustedTranslationSenderContext {
    sender?: {url?: string; tab?: unknown};
}
export function translationPrivacyContext(context: TrustedTranslationSenderContext | undefined): Pick<TrustedTranslationGlossaryContext, 'privateContext'> {
    const tab = context?.sender?.tab as {incognito?: unknown} | undefined;
    return typeof tab?.incognito === 'boolean' ? {privateContext: tab.incognito} : {};
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

/** KMP 首尾公共前缀：嵌套字面标记不能让短 nonce 抢先，也不按每个 BEGIN 重扫全文。 */
function slotNamespaceFromBoundaries(origin: string, finalOrdinalOffset: number): string | undefined {
    const prefix = origin.match(/^___FLUENTREAD_[a-z0-9_-]+/iu);
    if (!prefix) return undefined;
    const markerPrefix = '___FLUENTREAD_';
    // 只有位于合法前缀内的边界可能成为 namespace；过长的匹配沿前缀表回退。
    const maxBoundary = Math.min(prefix[0].length, finalOrdinalOffset);
    const borders = new Uint32Array(maxBoundary);
    let matched = 0;
    for (let index = 1; index < maxBoundary; index += 1) {
        while (matched > 0 && origin[index] !== origin[matched]) matched = borders[matched - 1]!;
        if (origin[index] === origin[matched]) matched += 1;
        borders[index] = matched;
    }
    for (let index = maxBoundary; index < finalOrdinalOffset; index += 1) {
        while (matched > 0 && (matched === maxBoundary || origin[index] !== origin[matched])) matched = borders[matched - 1]!;
        if (origin[index] === origin[matched]) matched += 1;
    }
    // 选择最长合法 namespace，先排除 BEGIN/END 自身重叠的伪边界；来源可与
    // 标记共享下划线，但不能把该重叠扩为 namespace。随后仍通过完整严格 parser。
    while (matched > markerPrefix.length) {
        if (matched <= prefix[0].length && origin.startsWith('_0_BEGIN___', matched)
            && finalOrdinalOffset - matched >= matched + '_0_BEGIN___'.length) {
            return origin.slice(markerPrefix.length, matched);
        }
        matched = borders[matched - 1]!;
    }
    return undefined;
}

/** 仅解析完整的内部槽协议，避免哨兵下划线破坏词边界或被当成用户术语；其他文本原样匹配。 */
export function getTranslationGlossarySourceSlots(origin: string): {packet: SerializedTranslationSlots; texts: string[]} | undefined {
    // 普通正文不扫描尾部，也不分配协议边界数组。
    if (typeof origin !== 'string' || !origin.startsWith('___FLUENTREAD_')) return undefined;
    const finalMarker = origin.match(/_(0|[1-9]\d*)_END___\s*$/u);
    if (!finalMarker) return undefined;
    // 最后一槽正文中的 index=N 仍是字面内容，不能由所有 BEGIN 数量推断槽数。
    const count = Number(finalMarker[1]) + 1;
    if (!Number.isSafeInteger(count)) return undefined;
    const nonce = slotNamespaceFromBoundaries(origin, finalMarker.index!);
    if (!nonce) return undefined;
    // nonce 的白名单只允许字母、数字、下划线和连字符，可直接组成字面正则片段。
    const observedStarts = [...origin.matchAll(new RegExp(`___FLUENTREAD_${nonce}_(?:0|[1-9]\\d*)_BEGIN___`, 'gu'))].length;
    // 先验证实际输入规模，不能按不可信尾部整数分配无限数组。
    if (count > observedStarts) return undefined;
    const starts = Array.from({length: count}, (_, index) => `___FLUENTREAD_${nonce}_${index}_BEGIN___`);
    const ends = starts.map(marker => marker.replace(/_BEGIN___$/u, '_END___'));
    const packet = {payload: origin, starts, ends};
    const texts = parseTranslationSlots(packet, origin);
    return texts ? {packet, texts} : undefined;
}

/** 与文档行内格式校验共用已验证的槽快照；普通或残缺协议仍按原文本匹配。 */
export function getTranslationGlossarySourceText(origin: string | string[]): string | string[] {
    if (Array.isArray(origin)) return origin.flatMap(getTranslationGlossarySourceText);
    return getTranslationGlossarySourceSlots(origin)?.texts ?? origin;
}

/** 同一批次逐条发送时仍只外发该条原文真正命中的术语，摘要由模板显式跳过。 */
export function getTranslationGlossaryTerms(current: TranslationProviderConfigSnapshot, origin: string | string[]) {
    if (current.glossaryProtectedTokens) {
        const texts = Array.isArray(origin) ? origin : [origin];
        return current.glossaryProtectedTokens.filter(token => texts.some(text => text.includes(token)))
            .map(token => ({source: token, target: token}));
    }
    const context = current.glossaryMatchContext;
    if (!context) return current.glossaryTerms ?? [];
    const source = getTranslationGlossarySourceText(origin);
    const entries = current.glossaryTerms?.length ? resolveGlossaryEntries(current.glossaryLibraries ?? [], {
        ...context,
        glossaryIds: context.glossaryIds ? [...context.glossaryIds] : null,
        text: source,
    }).terms : [];
    const terms = import.meta.env.BROWSER !== 'userscript' && context.context === 'document'
        ? [...entries, ...findDocumentLiteralTerms(source, entries)] : entries;
    return terms.map(({source, target}) => ({source, target: target || source}));
}

export function attachTranslationRequestScheduler<T extends object>(
    message: T,
    scheduler: TranslationRequestScheduler,
    identity?: TranslationRequestIdentity,
    lease?: TranslationRequestLease,
): T & TranslationProviderRequestContext {
    return Object.assign(message, {
        [TRANSLATION_REQUEST_SCHEDULER]: Object.freeze({scheduler, identity: identity ? Object.freeze({...identity}) : undefined, lease}),
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

function frozenCompositeTranslationProviders(value: readonly CompositeTranslationProvider[] | undefined): readonly Readonly<CompositeTranslationProvider>[] {
    return Object.freeze((value || []).map(provider => Object.freeze({
        id: provider.id,
        name: provider.name,
        strategy: provider.strategy,
        services: Object.freeze([...provider.services]) as unknown as string[],
        timeoutMs: provider.timeoutMs,
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
        aiRequestTimeoutMs: normalizeAiRequestTimeoutMs(source.aiRequestTimeoutMs),
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
        compositeTranslationProviders: frozenCompositeTranslationProviders(source.compositeTranslationProviders),
        proxy: frozenStringMap(source.proxy),
        customBody: frozenStringMap(source.customBody),
        customHeaders: frozenStringMap(source.customHeaders),
        requestHeaderRules: Object.freeze((source.requestHeaderRules ?? []).map(rule => Object.freeze({...rule}))),
        serviceRequestLimits: frozenRequestLimitMap(source.serviceRequestLimits),
        modelRequestLimits: frozenModelRequestLimitMap(source.modelRequestLimits),
        apiKeyRecoveryMs: normalizeApiKeyRecoveryMs(source.apiKeyRecoveryMs),
        system_role: frozenStringMap(source.system_role),
        user_role: frozenStringMap(source.user_role),
        token: frozenStringMap(source.token),
        apiKeys: frozenApiKeys(source.apiKeys),
        apiKeyRotationEnabled: frozenBooleanMap(source.apiKeyRotationEnabled),
        nativeBatchTranslationEnabled: Object.freeze(normalizeNativeBatchTranslationEnabled(source.nativeBatchTranslationEnabled)),
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

/** Provider 只消费调用边界已经冻结的配置；缺失时在发起 transport 前明确失败。 */
export function requireTranslationProviderConfig(message: unknown): TranslationProviderConfigSnapshot {
    if (message && typeof message === 'object') {
        const snapshot = (message as TranslationProviderRequestContext)[TRANSLATION_PROVIDER_CONFIG];
        if (snapshot) return snapshot;
    }
    throw Object.assign(new TypeError('翻译服务缺少配置快照，请通过翻译请求入口调用'), {
        code: 'TRANSLATION_PROVIDER_CONFIG_REQUIRED',
    });
}

/** Provider 的语言缺省也必须来自同一冻结快照，不能隐式读取全局配置。 */
export function getTranslationProviderLanguages(message: (TranslationLanguageOverride & TranslationProviderRequestContext) | null | undefined) {
    const current = requireTranslationProviderConfig(message);
    return resolveTranslationLanguages(message, {sourceLanguage: current.from, targetLanguage: current.to});
}

/** 沿用可信 symbol 对象；缺失时同步读取一次备用工厂，仅供请求边界构造快照。 */
export function getTranslationProviderConfig(
    message: unknown,
    fallback: TranslationProviderConfigSnapshot | (() => TranslationProviderConfigSnapshot),
): TranslationProviderConfigSnapshot {
    if (message && typeof message === 'object') {
        const snapshot = (message as TranslationProviderRequestContext)[TRANSLATION_PROVIDER_CONFIG];
        if (snapshot) return snapshot;
    }
    return typeof fallback === 'function' ? fallback() : fallback;
}
