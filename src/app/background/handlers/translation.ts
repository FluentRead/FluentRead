/**
 * @file src/app/background/handlers/translation.ts
 * 文件职责：解析没有显式 type 的翻译请求，并把它作为后台消息路由的受控 fallback 接入共享翻译 broker。
 * 主要内容：校验公开字段，以真实发送者绑定普通/私密 quota 上下文，以发送者和随机 ID 管理 AbortController，并提供精确取消 handler；页面不能提供内部 scope。
 * 模块边界：本文件只承担协议验证与 fallback 适配，不选择 provider、不缓存结果、不读取配置或凭据；真正的翻译执行由注入的 translateWithCache 完成。
 */
import type {BackgroundFallbackHandler} from '../messageRouter';
import type {BackgroundMessageHandler} from '../messageRouter';
import {attachTranslationGlossaryContext, attachTranslationRequestControl, translationPrivacyContext} from '@/src/services/translation/requestSnapshot';
import type {
    TranslationCancelMessage,
    TranslationCancelResponse,
    TranslationRequestMessage,
    TranslationRequestMessageBase,
} from '@/src/services/translation/types';
import {TRANSLATION_CANCEL_MESSAGE_TYPE} from '@/src/services/translation/types';

interface TranslationRequestCandidate extends Record<string, unknown> {
    origin: unknown;
}

export interface TranslationRequestHandlerDependencies {
    translate(message: TranslationRequestMessage): Promise<string | string[]>;
    serializeError(error: unknown): unknown;
}

export interface TranslationRequestContext {
    sender?: {
        id?: string;
        url?: string;
        frameId?: number;
        documentId?: string;
        tab?: {id?: number; incognito?: boolean};
    };
}

export interface TranslationRequestRegistry {
    run<T>(clientRequestId: string, context: TranslationRequestContext, operation: (
        signal: AbortSignal,
        ownershipKey: string,
    ) => Promise<T>): Promise<T>;
    cancel(clientRequestId: unknown, context: TranslationRequestContext): TranslationCancelResponse;
}

const STRING_FIELDS = [
    'context',
    'pageContext',
    'serviceOverride',
    'modelOverride',
    'sourceLanguage',
    'targetLanguage',
    'sourceLanguageDetectionText',
    'glossaryRevision',
] as const satisfies readonly (keyof TranslationRequestMessageBase)[];
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REQUEST_HISTORY_LIMIT = 512;

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isTranslationRequestCandidate(message: unknown): message is TranslationRequestCandidate {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (!hasOwn(message, 'origin') || hasOwn(message, 'type')) return false;
    return true;
}

function assertOptionalString(candidate: TranslationRequestCandidate, field: typeof STRING_FIELDS[number]): void {
    const value = candidate[field];
    if (value !== undefined && typeof value !== 'string') {
        throw new TypeError(`翻译请求字段 ${field} 必须是字符串`);
    }
}

function parseClientRequestId(value: unknown, optional = false): string | undefined {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(value)) {
        throw new TypeError('翻译请求 clientRequestId 格式无效');
    }
    return value;
}

function requestOwnerKey(context: TranslationRequestContext): string {
    const sender = context?.sender;
    const extensionId = typeof sender?.id === 'string' ? sender.id : '';
    const tabId = Number.isSafeInteger(sender?.tab?.id) ? sender!.tab!.id : '-';
    const frameId = Number.isSafeInteger(sender?.frameId) ? sender!.frameId : '-';
    const documentId = typeof sender?.documentId === 'string' ? sender.documentId.slice(0, 128) : '';
    if (tabId !== '-') return `extension:${extensionId}:tab:${tabId}:frame:${frameId}:document:${documentId}`;
    const url = typeof sender?.url === 'string' ? sender.url.slice(0, 512) : '';
    return `extension:${extensionId}:url:${url}:frame:${frameId}:document:${documentId}`;
}

function translationAbortError(): Error {
    const error = new Error('翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

/** 有界保存 cancel-before-start/已用 ID，同时用 sender scope 防止跨页面误取消。 */
export function createTranslationRequestRegistry(): TranslationRequestRegistry {
    const active = new Map<string, AbortController>();
    const cancelledBeforeStart = new Set<string>();
    const completed = new Set<string>();
    const remember = (set: Set<string>, key: string) => {
        if (set.has(key)) return;
        set.add(key);
        // Set 的插入顺序即当前记录的 FIFO；已消费取消不再占容量或淘汰同 ID 的新一代记录。
        if (set.size > REQUEST_HISTORY_LIMIT) set.delete(set.values().next().value!);
    };

    return {
        async run(clientRequestId, context, operation) {
            const owner = requestOwnerKey(context);
            const key = `${owner.length}:${owner}:${clientRequestId}`;
            if (cancelledBeforeStart.delete(key)) {
                remember(completed, key);
                throw translationAbortError();
            }
            if (active.has(key) || completed.has(key)) {
                throw new Error('翻译请求 clientRequestId 已在使用');
            }
            const controller = new AbortController();
            active.set(key, controller);
            try {
                return await operation(controller.signal, key);
            } finally {
                if (active.get(key) === controller) active.delete(key);
                remember(completed, key);
            }
        },
        cancel(clientRequestIdValue, context) {
            const clientRequestId = parseClientRequestId(clientRequestIdValue)!;
            const owner = requestOwnerKey(context);
            const key = `${owner.length}:${owner}:${clientRequestId}`;
            const controller = active.get(key);
            if (controller) controller.abort();
            else if (!completed.has(key)) remember(cancelledBeforeStart, key);
            return {success: true, cancelled: Boolean(controller), clientRequestId};
        },
    };
}

export function parseTranslationRequest(candidate: TranslationRequestCandidate): TranslationRequestMessage {
    // 步骤 1：origin 是无 type 翻译协议的判别字段；批量请求只能包含字符串。
    let origin: string | string[];
    if (typeof candidate.origin === 'string') {
        origin = candidate.origin;
    } else if (Array.isArray(candidate.origin)) {
        const denseOrigin = Array.from(candidate.origin);
        if (!denseOrigin.every((item): item is string => typeof item === 'string')) {
            throw new TypeError('翻译请求 origin 必须是字符串或字符串数组');
        }
        origin = denseOrigin;
    } else {
        throw new TypeError('翻译请求 origin 必须是字符串或字符串数组');
    }

    // 步骤 2：逐个收窄可选协议字段，避免未知 payload 直接流入 provider。
    parseClientRequestId(candidate.clientRequestId, true);
    for (const field of STRING_FIELDS) assertOptionalString(candidate, field);
    if (candidate.useCache !== undefined && typeof candidate.useCache !== 'boolean') {
        throw new TypeError('翻译请求字段 useCache 必须是布尔值');
    }
    if (candidate.enableAIContext !== undefined && typeof candidate.enableAIContext !== 'boolean') {
        throw new TypeError('翻译请求字段 enableAIContext 必须是布尔值');
    }
    if (candidate.aiMultiSegment !== undefined && typeof candidate.aiMultiSegment !== 'boolean') {
        throw new TypeError('翻译请求字段 aiMultiSegment 必须是布尔值');
    }
    if (candidate.validateTranslationSlots !== undefined && typeof candidate.validateTranslationSlots !== 'boolean') {
        throw new TypeError('翻译请求字段 validateTranslationSlots 必须是布尔值');
    }
    if (candidate.thinkingOverride !== undefined && typeof candidate.thinkingOverride !== 'boolean') {
        throw new TypeError('翻译请求字段 thinkingOverride 必须是布尔值');
    }
    if (candidate.glossaryRevision !== undefined
        && !/^glossary-v1:(?:disabled|[a-f0-9]{64})$/u.test(candidate.glossaryRevision as string)) {
        throw new TypeError('翻译请求 glossaryRevision 格式无效');
    }
    if (candidate.glossaryContext !== undefined
        && !['page', 'document', 'video'].includes(candidate.glossaryContext as string)) {
        throw new TypeError('翻译请求 glossaryContext 无效');
    }
    if (candidate.glossaryIds !== undefined && candidate.glossaryIds !== null
        && (!Array.isArray(candidate.glossaryIds) || candidate.glossaryIds.length > 100
            || !Array.from(candidate.glossaryIds).every(id => typeof id === 'string' && id.length <= 128))) {
        throw new TypeError('翻译请求 glossaryIds 必须是有限字符串数组或 null');
    }
    if (candidate.requestTimeoutMs !== undefined
        && (typeof candidate.requestTimeoutMs !== 'number' || !Number.isFinite(candidate.requestTimeoutMs))) {
        throw new TypeError('翻译请求字段 requestTimeoutMs 必须是有限数字');
    }

    // 步骤 3：只复制版本化协议允许的字段，不把页面注入的任意属性传给 provider。
    const base: TranslationRequestMessageBase = {};
    for (const field of STRING_FIELDS) {
        const value = candidate[field];
        if (typeof value === 'string') base[field] = value;
    }
    if (typeof candidate.enableAIContext === 'boolean') base.enableAIContext = candidate.enableAIContext;
    if (typeof candidate.useCache === 'boolean') base.useCache = candidate.useCache;
    if (typeof candidate.aiMultiSegment === 'boolean') base.aiMultiSegment = candidate.aiMultiSegment;
    if (typeof candidate.validateTranslationSlots === 'boolean') base.validateTranslationSlots = candidate.validateTranslationSlots;
    if (typeof candidate.thinkingOverride === 'boolean') base.thinkingOverride = candidate.thinkingOverride;
    if (typeof candidate.requestTimeoutMs === 'number') base.requestTimeoutMs = candidate.requestTimeoutMs;
    if (candidate.glossaryIds === null) base.glossaryIds = null;
    else if (Array.isArray(candidate.glossaryIds)) base.glossaryIds = Object.freeze([...candidate.glossaryIds]);
    if (candidate.glossaryContext !== undefined) base.glossaryContext = candidate.glossaryContext as TranslationRequestMessageBase['glossaryContext'];
    return typeof origin === 'string' ? {...base, origin} : {...base, origin};
}

/**
 * 普通翻译消息是历史上的无 `type` 协议，因此只能作为 typed router 的最后一个 fallback。
 * 所有带 `type` 的未知消息必须保持未处理，不能误送到翻译 provider。
 */
export function createTranslationRequestFallback<TContext = undefined>(
    dependencies: TranslationRequestHandlerDependencies & {requestRegistry?: TranslationRequestRegistry},
): BackgroundFallbackHandler<TContext, TranslationRequestCandidate> {
    const requestRegistry = dependencies.requestRegistry ?? createTranslationRequestRegistry();
    return {
        canHandle: isTranslationRequestCandidate,
        async handle(candidate, context) {
            try {
                const message = parseTranslationRequest(candidate);
                const senderUrl = (context as TranslationRequestContext | undefined)?.sender?.url;
                const isDocument = typeof senderUrl === 'string'
                    && /^(?:chrome|moz|safari-web)-extension:\/\/[^/]+\/document\.html(?:[?#]|$)/u.test(senderUrl);
                attachTranslationGlossaryContext(message, {
                    ...translationPrivacyContext(context as TranslationRequestContext | undefined),
                    pageUrl: typeof senderUrl === 'string' && /^https?:\/\//u.test(senderUrl) ? senderUrl : undefined,
                    context: message.glossaryContext === 'document' && isDocument ? 'document'
                        : message.glossaryContext === 'video' ? 'video' : 'page',
                });
                const clientRequestId = parseClientRequestId(candidate.clientRequestId, true);
                if (!clientRequestId) return await dependencies.translate(message);
                return await requestRegistry.run(
                    clientRequestId,
                    (context ?? {}) as TranslationRequestContext,
                    (signal, ownershipKey) => dependencies.translate(attachTranslationRequestControl(message, {
                        signal,
                        ownershipKey,
                    })),
                );
            } catch (error) {
                return dependencies.serializeError(error);
            }
        },
    };
}

export function createTranslationCancelHandler<TContext extends TranslationRequestContext>(
    requestRegistry: TranslationRequestRegistry,
): BackgroundMessageHandler<TContext, TranslationCancelMessage, TranslationCancelResponse> {
    return {
        type: TRANSLATION_CANCEL_MESSAGE_TYPE,
        handle: (message, context) => requestRegistry.cancel(message.clientRequestId, context),
    };
}
