/**
 * @file src/services/translation/broker/cachedExecution.ts
 * 文件职责：封装翻译 broker 的页面摘要复用、单条与批量翻译持久缓存读写、在途 pending 去重及共享超时恢复逻辑。
 * 主要内容：提供 createBrokerCachedExecution 工厂，统筹短参考直通与页面摘要缓存、单条/批量缓存命中与上下文泄漏复核、AI 多段整包重算及批内去重回填落库。
 * 模块边界：仅负责缓存与在途合并执行层，底层传输调度归 providerTransport，上下文/回显恢复归 recoveryPipeline，高层请求校验与组合路由留在 broker.ts。
 */
import type {
    TranslationBatchRequestMessage,
    TranslationBrokerDependencies,
    TranslationSingleRequestMessage,
} from '../types';
import {
    attachTranslationProviderConfig,
    getImageLabelSlots,
    getTranslationImageInput,
} from '../requestSnapshot';
import {
    normalizeDeadlineTimeoutMs,
    TranslationProviderDeadlineError,
} from '../requestDeadline';
import type {CacheRequestMode, createTranslationIdentityPolicy} from '../requestIdentity';
import {supportsNativeTranslationBatch} from '../capabilities';
import {hasTranslationContent} from '@/src/core/translation/result';
import {PrivacyProtectionError} from '@/src/core/privacy/policy';
import {sha256Hex} from '@/src/shared/function/sha256';
import {
    buildPendingRequestKey,
    getRemainingDeadlineMs,
    isCacheableResult,
    isCacheableSingleResult,
    runWithinDeadline,
    usesImageTextContext,
    type PageSummaryResult,
    type TranslationRequestExecution,
} from './protocol';
import type {createBrokerCacheStore} from './cacheStore';
import type {createBrokerProviderTransport} from './providerTransport';
import type {createBrokerRecoveryPipeline} from './recoveryPipeline';

const PAGE_SUMMARY_LIMIT = 1200;
// 仅一至两句短参考直接发送；不能使用摘要输出上限作阈值，否则长页逐段重复输入反而更贵。
const DIRECT_PAGE_CONTEXT_LIMIT = 240;

export interface BrokerCachedExecutionDependencies {
    deps: TranslationBrokerDependencies;
    now: () => number;
    warn: (message: string, error: unknown) => void;
    identity: ReturnType<typeof createTranslationIdentityPolicy>;
    cacheStore: ReturnType<typeof createBrokerCacheStore>;
    providerTransport: ReturnType<typeof createBrokerProviderTransport>;
    recoveryPipeline: ReturnType<typeof createBrokerRecoveryPipeline>;
}

export function createBrokerCachedExecution(ctx: BrokerCachedExecutionDependencies) {
    const {deps, now, warn, identity, cacheStore, providerTransport, recoveryPipeline} = ctx;
    const {isAIContextEnabled, buildCacheKey} = identity;

    async function addPageSummary(
        execution: TranslationRequestExecution,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        modelOverride?: string,
        requestTimeoutMs?: number,
    ): Promise<PageSummaryResult> {
        if (!isAIContextEnabled(execution, modelOverride) || !pageContext.trim()) return {context: '', summarized: false};

        // 很短的参考省掉一次付费调用及首段串行等待；更长材料仍摘要并复用，控制整页累计输入。
        if (pageContext.trim().length <= DIRECT_PAGE_CONTEXT_LIMIT) return {context: pageContext.trim(), summarized: false};

        const key = cacheStore.buildPageSummaryCacheKey(execution, pageContext, modelOverride);
        if (useCache) {
            const cached = cacheStore.pageSummaryCache.get(key);
            if (cached) return cached;
        }

        const summaryTimeoutMs = normalizeDeadlineTimeoutMs(requestTimeoutMs as number);
        const pendingKey = `${buildPendingRequestKey(key, summaryTimeoutMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${cacheStore.pendingIdentitySuffix(execution, modelOverride)}`;
        const existing = cacheStore.pendingPageSummaries.get(pendingKey);
        if (existing) return runWithinDeadline(() => existing, requestDeadline, now, execution.abortSignal);

        const request = (async () => {
            const fallback: PageSummaryResult = {context: pageContext, summarized: false};
            try {
                // 步骤 1：先读持久缓存，覆盖 MV3 service worker 重启后的重复摘要。
                if (useCache) {
                    const persisted = await runWithinDeadline(
                        () => cacheStore.readCacheWithPendingValue(requestGeneration, key),
                        requestDeadline,
                        now,
                        execution.abortSignal,
                    );
                    if (persisted !== null) {
                        const cachedSummary: PageSummaryResult = {context: persisted, summarized: true};
                        if (requestGeneration === cacheStore.getCacheGeneration()) cacheStore.cachePageSummary(key, cachedSummary);
                        return cachedSummary;
                    }
                }

                // 步骤 2：缓存未命中时生成短摘要，失败时回退到原始上下文。
                const remainingTotalMs = getRemainingDeadlineMs(requestDeadline, now);
                const providerTimeoutMs = Math.min(summaryTimeoutMs, remainingTotalMs);
                const result = await providerTransport.callProviderWithinDeadline(
                    execution,
                    attachTranslationProviderConfig({
                        origin: '',
                        context: '',
                        pageContext: '',
                        summaryPrompt: deps.promptBuilder.buildPageSummaryPrompt(pageContext),
                        summarySystemPrompt: deps.promptBuilder.buildPageSummarySystemPrompt(),
                        serviceOverride: execution.service,
                        sourceLanguage: execution.sourceLanguage,
                        targetLanguage: execution.targetLanguage,
                        modelOverride,
                        thinkingOverride: execution.thinking,
                        requestTimeoutMs: providerTimeoutMs,
                    }, execution.config),
                );
                const summary = typeof result === 'string' ? result.trim().slice(0, PAGE_SUMMARY_LIMIT) : '';
                const summarized: PageSummaryResult = summary
                    ? {context: `Page summary (AI-generated reference):\n${summary}`, summarized: true}
                    : fallback;
                if (useCache && requestGeneration === cacheStore.getCacheGeneration()) cacheStore.cachePageSummary(key, summarized);
                if (useCache && summarized.summarized) await cacheStore.persistCacheWrite(requestGeneration, key, summarized.context);
                return summarized;
            } catch (error) {
                if (execution.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw error;
                }
                if (error instanceof PrivacyProtectionError) throw error;
                warn('[FluentRead] page context summary failed; using extracted context:', error);
                // 超时只是本次摘要预算耗尽，不能把原上下文当成成功摘要缓存，否则同 key 无法重试。
                if (!(error instanceof TranslationProviderDeadlineError)
                    && useCache
                    && requestGeneration === cacheStore.getCacheGeneration()) {
                    cacheStore.cachePageSummary(key, fallback);
                }
                return fallback;
            }
        })();

        return cacheStore.trackPending(cacheStore.pendingPageSummaries, pendingKey, request);
    }

    async function translateSingleWithCache(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        context: string,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        pendingBudgetMs: number,
        recoverSharedDeadline = true,
    ): Promise<string> {
        const key = buildCacheKey(
            execution,
            message.origin,
            context,
            pageContext,
            message.validateInlineCodeTranslation === true ? 'inline-code-v1'
                : message.validateTranslationSlots === true ? 'slot-protocol' : 'single',
            message.modelOverride,
            message.sourceLanguageDetectionText,
            message.subtitleContext,
        );
        const imageInput = getTranslationImageInput(message);
        const imageSuffix = imageInput ? `:image:${sha256Hex(imageInput)}` : '';
        const pendingKey = `${buildPendingRequestKey(key, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${imageSuffix}${cacheStore.pendingIdentitySuffix(execution, message.modelOverride)}${cacheStore.pendingAnonymousConfigSuffix(execution)}${cacheStore.pendingCloudConfigSuffix(execution)}${recoverSharedDeadline ? '' : `:recovery-deadline:${requestDeadline}ms`}`;
        const existing = cacheStore.pendingTranslations.get(pendingKey);
        // 共享的是 provider 工作；每个等待者仍需保留自己的取消和截止边界。
        if (existing) {
            execution.trace.shared = true;
            try {
                return await runWithinDeadline(() => existing, requestDeadline, now, execution.abortSignal);
            } catch (error) {
                // 仅恢复早于自身截止时间的共享 transport 超时；普通失败和自身取消仍原样返回。
                if (!recoverSharedDeadline || !(error instanceof TranslationProviderDeadlineError) || now() >= requestDeadline) throw error;
                // 恢复轮按原绝对截止时间去重；相同等待者共享一次重发，仍最多恢复一轮。
                execution.trace.shared = false;
                return translateSingleWithCache(execution, message, context, pageContext, useCache,
                    requestGeneration, requestDeadline, pendingBudgetMs, false);
            }
        }

        const request = useCache ? (async () => {
            // 步骤 1：先读持久缓存；未命中后只发起一次 provider 请求。
            const cached = await runWithinDeadline(
                () => cacheStore.readCacheWithPendingValue(requestGeneration, key),
                requestDeadline,
                now,
                execution.abortSignal,
            );
            let leakedPageContext = false;
            if (cached !== null) {
                getRemainingDeadlineMs(requestDeadline, now);
                // 缓存中的软重合可能是已经经过无上下文复验的合法译名；
                // 只用明确边界/长复制信号否定旧缓存，避免每次都重译。
                leakedPageContext = recoveryPipeline.isDefiniteRecoveryPageContextLeak(
                    execution,
                    message.origin,
                    cached,
                    pageContext,
                    message.modelOverride,
                );
                if (isCacheableSingleResult(execution, message, cached) && !leakedPageContext) {
                    execution.trace.cachedSegments = 1;
                    return cached;
                }
            }

            const result = leakedPageContext
                ? await recoveryPipeline.callSingleProviderWithoutPageContext(execution, message, requestDeadline, pageContext)
                : await recoveryPipeline.callSingleProviderWithContextRecovery(execution, message, context, pageContext, requestDeadline);
            if (isCacheableSingleResult(execution, message, result)) {
                await cacheStore.persistCacheWrite(requestGeneration, key, result);
            }
            return result;
        })() : recoveryPipeline.callSingleProviderWithContextRecovery(
            execution,
            message,
            context,
            pageContext,
            requestDeadline,
        );

        return cacheStore.trackPending(cacheStore.pendingTranslations, pendingKey, request);
    }

    async function translateBatchWithCache(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        pendingBudgetMs: number,
        recoverSharedDeadline = true,
    ): Promise<string[]> {
        const imageContext = import.meta.env.BROWSER !== 'userscript' && usesImageTextContext(execution, message);
        const cacheMode: CacheRequestMode = imageContext ? 'image-context-v1'
            : message.aiMultiSegment === true && !supportsNativeTranslationBatch(execution.service)
            ? 'ai-multi-segment'
            : 'batch';
        const batchKey = buildCacheKey(
            execution,
            message.origin,
            context,
            pageContext,
            cacheMode,
            message.modelOverride,
            undefined,
            message.subtitleContext,
            imageContext ? getImageLabelSlots(message) : undefined,
        );
        // 完整批次身份只计算一次；有语境的分项用定长摘要保留邻段和槽位语义，避免逐项携带整个批次。
        const batchFingerprint = cacheMode !== 'batch' ? sha256Hex(batchKey) : '';
        const pendingKey = `${buildPendingRequestKey(batchKey, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${cacheStore.pendingIdentitySuffix(execution, message.modelOverride)}${cacheStore.pendingAnonymousConfigSuffix(execution)}${cacheStore.pendingCloudConfigSuffix(execution)}${import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true ? ':document-batch' : ''}${recoverSharedDeadline ? '' : `:recovery-deadline:${requestDeadline}ms`}`;
        const existing = cacheStore.pendingBatches.get(pendingKey);
        if (existing) {
            execution.trace.shared = true;
            try {
                return await runWithinDeadline(() => existing, requestDeadline, now, execution.abortSignal);
            } catch (error) {
                // 仅恢复早于自身截止时间的共享 transport 超时；普通失败和自身取消仍原样返回。
                if (!recoverSharedDeadline || !(error instanceof TranslationProviderDeadlineError) || now() >= requestDeadline) throw error;
                // 恢复轮按原绝对截止时间去重；相同等待者共享一次重发，仍最多恢复一轮。
                execution.trace.shared = false;
                return translateBatchWithCache(execution, message, context, pageContext, useCache,
                    requestGeneration, requestDeadline, pendingBudgetMs, false);
            }
        }

        const request = useCache ? (async () => {
            const keyByOrigin = cacheMode === 'batch' ? new Map<string, string>() : undefined;
            const itemKeys = message.origin.map((origin, index) => {
                if (keyByOrigin) {
                    const existingKey = keyByOrigin.get(origin);
                    if (existingKey !== undefined) return existingKey;
                }
                const built = cacheStore.buildBatchItemCacheKey(
                    execution, origin, index, batchFingerprint, context, pageContext, cacheMode, message.modelOverride,
                    message.subtitleContext,
                );
                keyByOrigin?.set(origin, built);
                return built;
            });
            // 步骤 1：分项批量读取缓存，单次 IndexedDB 事务读取全部未命中热层的键。
            const cached = await runWithinDeadline(
                () => cacheStore.readCacheBatchWithPendingValues(requestGeneration, itemKeys),
                requestDeadline,
                now,
                execution.abortSignal,
            );
            const leakedCachedIndexes = new Set<number>();
            const validatedCached = cached.map((value, index) => {
                if (!hasTranslationContent(message.origin[index] ?? '')) return message.origin[index] ?? '';
                if (value === null || !isCacheableResult(message.origin[index]!, value, execution)) return null;
                if (!recoveryPipeline.isDefiniteRecoveryPageContextLeak(
                    execution,
                    message.origin[index]!,
                    value,
                    pageContext,
                    message.modelOverride,
                )) return value;
                leakedCachedIndexes.add(index);
                return null;
            });
            const missingIndexes = validatedCached
                .map((value, index) => value === null ? index : -1)
                .filter((index) => index >= 0);

            if (missingIndexes.length === 0) {
                getRemainingDeadlineMs(requestDeadline, now);
                execution.trace.cachedSegments = message.origin.length;
                return validatedCached as string[];
            }

            const missingEntries = missingIndexes.map((index) => ({index, origin: message.origin[index]}));
            const normalMissingIndexes = missingIndexes.filter((index) => !leakedCachedIndexes.has(index));
            if (cacheMode !== 'batch' && normalMissingIndexes.length > 0) {
                // 有语境批次的邻段本身就是翻译输入。只要有普通 miss，必须用完整原批次重算，
                // 否则“完整批次指纹”会缓存一份实际没看到邻段的结果。
                const translated = await recoveryPipeline.callBatchProviderWithContextRecovery(
                    execution,
                    message,
                    context,
                    pageContext,
                    requestDeadline,
                );
                const entriesToWrite: Array<{key: string; value: string}> = [];
                translated.forEach((value, index) => {
                    const origin = message.origin[index];
                    if (isCacheableResult(origin, value, execution)) {
                        entriesToWrite.push({key: itemKeys[index]!, value});
                    }
                });
                await cacheStore.persistCacheBatchWrite(requestGeneration, entriesToWrite);
                return translated;
            }
            // 只有逐项补齐时缓存结果才会被使用；AI 合批整包重算不计入缓存命中。
            execution.trace.cachedSegments = message.origin.length - missingIndexes.length;
            const translatedByKey = new Map<string, string>();
            const groups = [
                {
                    entries: missingEntries.filter(({index}) => !leakedCachedIndexes.has(index)),
                    startWithoutPageContext: false,
                },
                {
                    entries: missingEntries.filter(({index}) => leakedCachedIndexes.has(index)),
                    startWithoutPageContext: true,
                },
            ];
            for (const group of groups) {
                if (group.entries.length === 0) continue;
                const uniqueEntries = [...new Map(group.entries.map(({origin, index}) => [
                    itemKeys[index],
                    origin,
                ])).entries()];
                const uniqueOrigins = uniqueEntries.map(([, origin]) => origin);
                const translated = await recoveryPipeline.callBatchProviderWithContextRecovery(
                    execution,
                    {...message, origin: uniqueOrigins},
                    context,
                    pageContext,
                    requestDeadline,
                    group.startWithoutPageContext,
                );
                uniqueEntries.forEach(([key], index) => {
                    translatedByKey.set(key, translated[index]);
                });
            }

            // 步骤 2：按原请求顺序回填结果，并合并单次事务写入有效译文。
            const result = [...validatedCached] as Array<string | null>;
            const entriesToWrite: Array<{key: string; value: string}> = [];
            const writtenKeys = new Set<string>();
            missingEntries.forEach(({index, origin}) => {
                const itemKey = itemKeys[index]!;
                const value = translatedByKey.get(itemKey);
                result[index] = value as string;
                if (!writtenKeys.has(itemKey) && isCacheableResult(origin, value, execution)) {
                    writtenKeys.add(itemKey);
                    entriesToWrite.push({key: itemKey, value});
                }
            });

            await cacheStore.persistCacheBatchWrite(requestGeneration, entriesToWrite);
            return result as string[];
        })() : recoveryPipeline.callBatchProviderWithContextRecovery(
            execution,
            message,
            context,
            pageContext,
            requestDeadline,
        );

        return cacheStore.trackPending(cacheStore.pendingBatches, pendingKey, request);
    }

    return {
        addPageSummary,
        translateSingleWithCache,
        translateBatchWithCache,
    };
}
