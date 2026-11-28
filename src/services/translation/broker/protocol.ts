/**
 * @file src/services/translation/broker/protocol.ts
 * 文件职责：定义翻译 broker 的内部执行上下文、观测跟踪、响应协议异常、截止时间控制以及请求与结果的纯校验规则。
 * 主要内容：提供单条/批量/槽位协议和行内代码的入参边界校验、空请求快速返回、缓存可写性判定、provider 响应形状校验、取消与截止时间竞争包装，以及多段/空槽/上下文泄漏/未译/错语种/术语版本变更等结构化错误类。
 * 模块边界：作为 broker 子模块树的零内部依赖叶模块，仅依赖翻译 core 纯协议与配置辅助，不访问缓存存储、调度器、provider 适配器或全局配置 store。
 */

import type {
    TranslationBatchRequestMessage,
    TranslationProviderConfigSnapshot,
    TranslationRequestMessage,
    TranslationSingleRequestMessage,
} from '../types';
import {
    getTranslationGlossaryContext,
    getTranslationGlossarySourceText,
    getTranslationImageInput,
    isImageTextBatch,
} from '../requestSnapshot';
import {normalizeDeadlineTimeoutMs, TranslationProviderDeadlineError} from '../requestDeadline';
import {createTranslationAbortError} from '../errors';
import type {TranslationRequestIdentityContext} from '../requestIdentity';
import {isGlossaryOnlyResult, shouldKeepCommonWebTermLabel} from '../glossaryProtection';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {
    isClearlyWrongLanguageResponse,
    isLikelyUntranslatedResponse,
    isUnchangedTranslationResponse,
} from '@/src/core/translation/resultValidation';
import {hasTranslationContent} from '@/src/core/translation/result';
import {SUBTITLE_CONTEXT_LIMIT} from '@/src/core/translation/subtitleContext';
import {isValidInlineCodeSource, isValidInlineCodeTranslation} from '@/src/core/translation/inlineCodeMarkers';
import type {TranslationRouteAttempt} from '@/src/services/translation-stats/types';

/** 单次公开翻译请求的观测累加器，只记录服务标识与数值，随 execution 传入缓存和 provider 路径。 */
export interface TranslationRequestTrace {
    serviceId?: string;
    model?: string;
    cachedSegments: number;
    shared: boolean;
    upstreamCalls: number;
    upstreamMs: number;
    routeAttempts: TranslationRouteAttempt[];
    privacyActivityGeneration: number;
}

export interface TranslationRequestExecution extends TranslationRequestIdentityContext {
    readonly acceptUnchangedResult: boolean;
    readonly subtitleContextEnabled: boolean;
    readonly compositeMember?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly ownershipKey?: string;
    readonly privateContext: boolean | undefined;
    readonly trace: TranslationRequestTrace;
}

export type PageSummaryResult = {context: string; summarized: boolean};

// 已消耗逐槽恢复预算时使用独立错误码，前端不能再将整个批次降级重发。
export const AI_MULTI_SEGMENT_REPAIR_FAILED = 'AI_MULTI_SEGMENT_REPAIR_FAILED';

export class AIMultiSegmentResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'AI_MULTI_SEGMENT_RESPONSE_INVALID';

    constructor() {
        super('AI 多段翻译返回格式异常，已切换为逐段翻译');
        this.name = 'AIMultiSegmentResponseError';
    }
}

export class TranslationSlotResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;

    constructor(readonly code = 'TRANSLATION_SLOT_RESPONSE_INVALID') {
        super('翻译服务返回空译文，请重试或切换服务');
        this.name = 'TranslationSlotResponseError';
    }
}

export class AIContextRecoveryResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'AI_CONTEXT_LEAK_AFTER_RECOVERY';

    constructor() {
        super('AI 翻译在无上下文重试后仍返回了网页参考内容，已停止展示并跳过缓存');
        this.name = 'AIContextRecoveryResponseError';
    }
}

export class UntranslatedResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'UNTRANSLATED_RESPONSE';

    constructor() {
        super('翻译服务连续返回未翻译的原文，请尝试切换服务；使用 AI 时也可调整提示词');
        this.name = 'UntranslatedResponseError';
    }
}

export class WrongLanguageResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'WRONG_LANGUAGE_RESPONSE';

    constructor() {
        super('翻译服务连续返回与目标语言不符的译文，请尝试切换服务');
        this.name = 'WrongLanguageResponseError';
    }
}

export class GlossaryRevisionChangedError extends Error {
    readonly kind = 'bad-request';
    readonly retryable = false;
    readonly code = 'GLOSSARY_REVISION_CHANGED';

    constructor() {
        super('术语库已更新，请重新翻译');
        this.name = 'GlossaryRevisionChangedError';
    }
}

export function requestAbortError(): Error {
    return createTranslationAbortError('翻译请求已取消');
}

export function throwIfRequestAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw requestAbortError();
}

export function getRemainingDeadlineMs(requestDeadline: number, now: () => number): number {
    const remaining = Math.floor(requestDeadline - now());
    if (remaining <= 0) throw new TranslationProviderDeadlineError();
    return remaining;
}

export async function runWithinDeadline<T>(
    operation: () => Promise<T>,
    requestDeadline: number,
    now: () => number,
    signal?: AbortSignal,
): Promise<T> {
    throwIfRequestAborted(signal);
    const remaining = getRemainingDeadlineMs(requestDeadline, now);

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TranslationProviderDeadlineError()), remaining);
    });
    const abortListenerCleanup = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener(
            'abort',
            () => reject(requestAbortError()),
            {once: true, signal: abortListenerCleanup.signal},
        );
    });
    try {
        // 先注册取消监听，再启动可能同步改变 signal 的操作，关闭检查与监听之间的窗口。
        const work = operation();
        return await Promise.race([work, timeout, aborted]);
    } finally {
        clearTimeout(timer!);
        abortListenerCleanup.abort();
    }
}

export function applyRemainingDeadline<T extends TranslationRequestMessage>(
    message: T,
    requestDeadline: number,
    now: () => number,
): T {
    const remaining = getRemainingDeadlineMs(requestDeadline, now);
    return {...message, requestTimeoutMs: remaining};
}

export function usesImageTextContext(
    execution: TranslationRequestExecution,
    message: TranslationBatchRequestMessage,
): boolean {
    return execution.service === 'google' && execution.nativeBatchEnabled && isImageTextBatch(message);
}

export function isCacheEnabled(
    current: TranslationProviderConfigSnapshot,
    message: TranslationRequestMessage,
): boolean {
    return !current.privacyProtection?.enabled && current.useCache && message.useCache !== false;
}

export function isCacheableResult(
    origin: string,
    result: unknown,
    execution: TranslationRequestExecution,
): result is string {
    // 图片文字的有效原样结果仅在独立策略缓存中复用；其他入口继续拒绝外语原文和明确错语种。
    return typeof result === 'string'
        && hasTranslationContent(result)
        && (isGlossaryOnlyResult(execution.config, origin, result)
        || (execution.acceptUnchangedResult && isUnchangedTranslationResponse(origin, result))
        || (!isLikelyUntranslatedResponse(origin, result, execution.targetLanguage)
        && !isClearlyWrongLanguageResponse(origin, result, execution.targetLanguage)));
}

/** 标记与原始载荷必须同时符合内部协议；普通原文中的相似标记没有逐槽语义。 */
export function getSingleSlotProtocol(message: TranslationSingleRequestMessage) {
    if (message.validateTranslationSlots !== true) return null;
    const sources = getTranslationGlossarySourceText(message.origin);
    if (!Array.isArray(sources)) return null;
    const packet = serializeTranslationSlots(sources);
    return packet.payload === message.origin ? {sources, packet} : null;
}

export function isCacheableSingleResult(
    execution: TranslationRequestExecution,
    message: TranslationSingleRequestMessage,
    result: string,
): boolean {
    if (message.validateInlineCodeTranslation === true) {
        return isValidInlineCodeTranslation(message.origin, result, execution.targetLanguage)
            && isCacheableResult(message.origin, result, execution);
    }
    if (message.validateTranslationSlots !== true) {
        return isCacheableResult(message.origin, result, execution);
    }
    const protocol = getSingleSlotProtocol(message);
    const parsed = protocol && parseTranslationSlots(protocol.packet, result);
    return Boolean(parsed && parsed.every((translation, index) => {
        const source = protocol!.sources[index]!;
        return shouldKeepCommonWebTermLabel(execution.config, source) ? source === translation
            : isCacheableResult(source, translation, execution);
    }));
}

export function requireSingleResult(result: unknown): string {
    if (typeof result !== 'string') throw new Error('单条翻译返回格式异常');
    return result;
}

/** 单条响应和逐槽恢复共用内容防御；恢复后的最后检查仍必须拒绝空译文。 */
export function requireTranslationContent(value: string): void {
    if (!hasTranslationContent(value)) throw new TranslationSlotResponseError();
}

export function requireBatchResult(result: unknown, expectedLength: number): string[] {
    if (!Array.isArray(result)) throw new Error('批量翻译返回格式异常');
    if (result.length !== expectedLength) throw new Error('批量翻译返回数量异常');
    const denseResult = Array.from({length: expectedLength}, (_, index) => result[index]);
    if (denseResult.some((value) => typeof value !== 'string')) {
        throw new Error('批量翻译返回格式异常');
    }
    return denseResult as string[];
}

export function validatePublicTranslationRequest(message: TranslationRequestMessage): void {
    // 此标志可经公开 runtime 协议进入后台；即使调用方绕过 parser，缓存边界也必须拒绝不兼容形态。
    if (message.validateInlineCodeTranslation !== undefined && typeof message.validateInlineCodeTranslation !== 'boolean') {
        throw new TypeError('翻译请求字段 validateInlineCodeTranslation 必须是布尔值');
    }
    if (message.subtitleContext !== undefined
        && (typeof message.subtitleContext !== 'string' || message.subtitleContext.length > SUBTITLE_CONTEXT_LIMIT)) {
        throw new TypeError('翻译请求字段 subtitleContext 必须是不超过 1200 字符的字符串');
    }
    if (message.validateInlineCodeTranslation === true && (
        typeof message.origin !== 'string' || !isValidInlineCodeSource(message.origin) ||
        message.validateTranslationSlots === true || message.aiMultiSegment === true || message.documentBatch === true ||
        message.enableAIContext !== false || Boolean(message.context) || Boolean(message.pageContext) ||
        Boolean(message.discourseContext) || Boolean(message.subtitleContext) || (message.glossaryContext !== undefined && message.glossaryContext !== 'page') ||
        Boolean(getTranslationImageInput(message)) || (getTranslationGlossaryContext(message)?.context ?? 'page') !== 'page'
    )) throw new TypeError('行内代码翻译请求格式无效');
}

export function resolveEmptyTranslationOrigin(origin: string | string[]): string | string[] | null {
    // 空请求没有 provider 语义，也不应被配置水合阻塞或计入统计。
    if (Array.isArray(origin) && origin.length === 0) return [];
    if (Array.isArray(origin) && Array.from(origin).every(item =>
        typeof item === 'string' && !hasTranslationContent(item))) return [...origin];
    if (typeof origin === 'string' && !origin.trim()) return origin;
    return null;
}

export function buildPendingRequestKey(
    cacheKey: string,
    requestTimeoutMs: number,
    requestGeneration: number,
): string {
    const normalizedTimeoutMs = normalizeDeadlineTimeoutMs(requestTimeoutMs);
    return `${cacheKey}:generation:${requestGeneration}:timeout:${normalizedTimeoutMs}ms`;
}
