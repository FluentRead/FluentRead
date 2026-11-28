/**
 * @file src/services/translation/broker.ts
 * 隐私防护：provider 前统一处理正文、上下文与提示词，逐槽校验后本地恢复；开启时跳过持久翻译缓存并隔离 pending 身份，失败不得降级发送明文。
 * 字幕参考：只向文档中的提示词 AI 传递有界 cue，独立于网页摘要开关并进入缓存身份；上下文异常回退会移除字幕参考并继续复验。
 * 漫画语境：启用 AI 上下文时先对不可信网页摘要与篇章证据转义保留协议标签，再仅为受信漫画请求追加独立漫画语境标记并参与缓存隔离，剥离原始布尔字段，异常回退时一并移除。
 * 用量控制：短参考直接复用；完整 AI 批次中的少数空槽或原文回显只恢复对应槽，整包回显仍触发原有降级。
 * 同图 Google：可信且启用原生合批的图片请求保留重复位置，以整组有序指纹隔离缓存；部分缺失重算完整邻文，逐条回退仍受原截止时间和取消所有权约束。
 * 网页术语：独立的常用词槽在本地原位保留，正文沿用用户词条优先的占位回填，摘要、字幕和图像请求保持各自的保护范围。
 * Emoji 兼容：B站与硅基流动 Hunyuan-MT-7B 的单行正文占位符校验失败后，在原请求预算内尝试字面 emoji 并严格校验。
 *
 * 文件职责：编排翻译请求的配置快照、语言解析、缓存、请求去重、超时与 provider 调用，是后台翻译用例的中心服务。
 * 主要内容：createTranslationBroker 同时支持单条、批量和页面摘要，验证 provider 返回数量、类型及明显的原文回显或错语种，图片文字的内部策略接受有效原样结果并隔离缓存，空来源在本地保留；普通数组无论是否缓存都先合并完全相同的原文，再按原位置回填，AI 多段保留独立槽位与邻段语义；仅在原生批次响应结构异常时以相同取消所有权和剩余 deadline 逐段恢复，整批完成前不发布缓存；对完整多段协议逐槽修复上下文回显并拒绝空译文，以包含 Chrome auto 检测样本的完整身份构建缓存键，并按实际消费的云地域和凭据摘要、匿名额度身份、等待策略、清理代次与剩余 deadline 隔离 pending 请求；入口在等待前复制消息，ready 采用有界水合等待，之后按最终服务解析 AI 配置预算并扣除已等待时间，取消检查后沿用可信配置快照，仅未附着的公开请求复制备用配置；批次摘要与分项缓存键只构建一次并复用，重复身份只读写一次；每次公开请求累计缓存复用、上游调用次数、耗时与免费链线路尝试，结束后向注入的统计端口交付只含规模数值、服务与线路标识的事件。 可核对的公开符号包括 createTranslationBroker、聚合导出。
 * 模块边界：本文件位于翻译 application service 层，负责高层用例编排与组合路由；具体协议校验、缓存与在途存储、上游传输调度、异常恢复管线和用量统计下沉到 ./broker/* 子模块，不初始化 DOM 候选或网站规则，不挂载页面 UI，也不把供应商 HTTP 细节扩散到 feature。
 * 摘要共享：同一页面摘要跨取消归属共用一次调用，最后一个可取消等待者离开才中止；术语表修订号经 memoizer 复用。
 */

import {
    TRANSLATION_REMAINING_BUDGET,
    type TranslationBatchRequestMessage,
    type TranslationBroker,
    type TranslationBrokerDependencies,
    type TranslationRequestMessage,
    type TranslationSingleRequestMessage,
} from './types';
import {
    attachTranslationImageInput,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    createTranslationProviderConfigSnapshot,
    createTranslationRequestSnapshot,
    getImageLabelSlots,
    getTranslationGlossaryContext,
    getTranslationGlossarySourceText,
    getTranslationImageInput,
    getTranslationProviderConfig,
    getTranslationRequestControl,
    isUnchangedTranslationResultAllowed,
} from './requestSnapshot';
import {
    DEFAULT_PROVIDER_TIMEOUT_MS,
    getExplicitTranslationBudget,
    normalizeDeadlineTimeoutMs,
    startTranslationRequest,
    TranslationProviderDeadlineError,
} from './requestDeadline';
import {createTranslationIdentityPolicy, type CacheRequestMode} from './requestIdentity';
import {createTranslationRequestScheduler} from './requestScheduler';
import {createCompositeTranslationRoutingState} from './compositeRouting';
import {
    getTranslationServiceUnavailableMessage,
    supportsNativeTranslationBatch,
    supportsTranslationGlossary,
} from './capabilities';
import {shouldKeepCommonWebTermLabel} from './glossaryProtection';
import {preparePrivacyRequest} from './privacyProtection';
import {hasTranslationContent} from '@/src/core/translation/result';
import {escapePageContextDelimiters} from '@/src/core/translation/prompts';
import {SUBTITLE_CONTEXT_LIMIT} from '@/src/core/translation/subtitleContext';
import {buildPageSummaryReference} from '@/src/core/translation/pageSummaryReference';
import {createGlossaryRevisionMemoizer, resolveGlossary} from '@/src/core/glossary';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {getCompositeTranslationProvider, isCompositeTranslationProviderId} from '@/src/core/config/compositeTranslation';
import {services} from '@/src/core/config/catalog';
import {isTranslationServiceDisabled, TRANSLATION_SERVICE_DISABLED_MESSAGE} from '@/src/core/config/serviceAvailability';
import {resolveTranslationRequestModel} from '@/src/core/config/requestModel';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {supportsVisionTransport} from '@/src/core/config/vision';
import {PrivacyProtectionError} from '@/src/core/privacy/policy';
import {sha256Hex} from '@/src/shared/function/sha256';
import {measureTranslationText} from '@/src/services/translation-stats/measure';
import {
    buildPendingRequestKey,
    getRemainingDeadlineMs,
    getSingleSlotProtocol,
    GlossaryRevisionChangedError,
    isCacheableResult,
    isCacheableSingleResult,
    isCacheEnabled,
    resolveEmptyTranslationOrigin,
    runWithinDeadline,
    throwIfRequestAborted,
    usesImageTextContext,
    validatePublicTranslationRequest,
    type PageSummaryResult,
    type TranslationRequestExecution,
    type TranslationRequestTrace,
} from './broker/protocol';
import {
    cleanModelName,
    createBrokerTelemetry,
    modelUsageOutcome,
    modelUsagePurpose,
} from './broker/telemetry';
import {createBrokerCacheStore} from './broker/cacheStore';
import {createBrokerProviderTransport} from './broker/providerTransport';
import {createBrokerRecoveryPipeline} from './broker/recoveryPipeline';

export type {
    TranslationBatchRequestMessage,
    TranslationBroker,
    TranslationBrokerDependencies,
    TranslationProviderConfigSnapshot,
    TranslationProvider,
    TranslationRequestMessage,
    TranslationSingleRequestMessage,
} from './types';

const PAGE_SUMMARY_LIMIT = 1200;
// 仅一至两句短参考直接发送；不能使用摘要输出上限作阈值，否则长页逐段重复输入反而更贵。
const DIRECT_PAGE_CONTEXT_LIMIT = 240;

/** 保留既有 broker 公共入口，模型规则由设置页与后台共用的 core 函数维护。 */
export {resolveTranslationRequestModel};

export function createTranslationBroker(deps: TranslationBrokerDependencies): TranslationBroker {
    const now = deps.now ?? (() => Date.now());
    const readGlossaryRevision = createGlossaryRevisionMemoizer();
    const compositeRouting = createCompositeTranslationRoutingState({now});
    const logger = deps.logger ?? console;
    const requestScheduler = deps.requestScheduler ?? createTranslationRequestScheduler(
        () => deps.getConfig() as unknown as {
            maxConcurrentTranslations?: unknown;
            translationRequestsPerSecond?: unknown;
            translationRequestsPerMinute?: unknown;
        },
        {now},
    );

    function warn(message: string, error: unknown): void {
        try {
            logger.warn(message, error);
        } catch {
            // 步骤 1：诊断器是旁路依赖；自定义 logger 失败不能中断用户翻译。
        }
    }

    function config() {
        return deps.getConfig();
    }

    const identity = createTranslationIdentityPolicy(deps);
    const {getSelectedModel, getEffectiveRequestModel, isPromptBasedAI, isAIContextEnabled, buildCacheKey} = identity;
    const telemetry = createBrokerTelemetry({deps, now, warn, getSelectedModel});
    const cacheStore = createBrokerCacheStore({deps, now, warn, identity});
    const providerTransport = createBrokerProviderTransport({
        deps,
        now,
        requestScheduler,
        identity,
        quotaDigest: cacheStore.quotaDigest,
        telemetry,
    });
    const recoveryPipeline = createBrokerRecoveryPipeline({
        serviceTypes: deps.serviceTypes,
        now,
        warn,
        identity,
        quotaDigest: cacheStore.quotaDigest,
        callProviderWithinDeadline: providerTransport.callProviderWithinDeadline,
    });

    type SharedPageSummary = {controller: AbortController; waiters: number; release: () => void};
    const sharedPageSummaryWaiters = new WeakMap<Promise<PageSummaryResult>, SharedPageSummary>();

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
        // 摘要跨取消归属共享：各请求只登记等待，最后一个可取消等待者离开时才中止共享调用。
        const pendingKey = `${buildPendingRequestKey(key, summaryTimeoutMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${cacheStore.pendingIdentitySuffix({...execution, ownershipKey: undefined}, modelOverride)}`;
        const existing = cacheStore.pendingPageSummaries.get(pendingKey);
        if (existing) return waitForSharedPageSummary(existing, sharedPageSummaryWaiters.get(existing)!, execution.abortSignal, requestDeadline);

        const controller = new AbortController();
        const abortSignal = execution.abortSignal;
        execution = {...execution, ownershipKey: undefined, abortSignal: controller.signal};
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

        // 共享调用被中止后立即让出 pending 位，后续请求重新发起摘要而不是加入已中止的调用。
        const entry = {controller, waiters: 0, release: () => { cacheStore.pendingPageSummaries.delete(pendingKey); }};
        sharedPageSummaryWaiters.set(request, entry);
        return waitForSharedPageSummary(cacheStore.trackPending(cacheStore.pendingPageSummaries, pendingKey, request), entry, abortSignal, requestDeadline);
    }

    async function waitForSharedPageSummary(
        request: Promise<PageSummaryResult>,
        entry: SharedPageSummary,
        signal: AbortSignal | undefined,
        requestDeadline: number,
    ): Promise<PageSummaryResult> {
        // 不可取消的等待者永久计数，保证共享调用不会被其他请求的取消中止。
        entry.waiters += 1;
        if (!signal) return runWithinDeadline(() => request, requestDeadline, now);
        const leave = () => {
            entry.waiters -= 1;
            if (entry.waiters > 0) return;
            entry.release();
            entry.controller.abort();
        };
        signal.addEventListener('abort', leave, {once: true});
        try {
            return await runWithinDeadline(() => request, requestDeadline, now, signal);
        } finally {
            signal.removeEventListener('abort', leave);
        }
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
            const itemKeys = message.origin.map((origin, index) => cacheStore.buildBatchItemCacheKey(
                execution, origin, index, batchFingerprint, context, pageContext, cacheMode, message.modelOverride,
                message.subtitleContext,
            ));
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

    async function translateWithCache(message: TranslationRequestMessage): Promise<string | string[]> {
        validatePublicTranslationRequest(message);
        const emptyResult = resolveEmptyTranslationOrigin(message.origin);
        if (emptyResult !== null) return emptyResult;

        message = createTranslationRequestSnapshot(message);

        const trace: TranslationRequestTrace = {cachedSegments: 0, shared: false, upstreamCalls: 0, upstreamMs: 0, routeAttempts: []};
        const startedAt = startTranslationRequest(message, now);
        const statsGeneration = deps.captureTranslationStatsGeneration?.() ?? 0;
        try {
            const result = await executeTranslation(message, trace, startedAt);
            telemetry.recordTranslationRequest(message, trace, startedAt, statsGeneration, 'success', result);
            return result;
        } catch (error) {
            telemetry.recordTranslationRequest(message, trace, startedAt, statsGeneration, modelUsageOutcome(error), undefined, error);
            throw error;
        }
    }

    async function executeTranslation(
        message: TranslationRequestMessage,
        trace: TranslationRequestTrace,
        providerStartedAt: number,
        compositeMember = false,
    ): Promise<string | string[]> {
        const requestControl = getTranslationRequestControl(message);
        throwIfRequestAborted(requestControl?.signal);
        // 入口选择也必须在水合/队列之前复制，防止上层原地编辑数组改变在途请求。
        const glossaryIds = message.glossaryIds ? Object.freeze([...message.glossaryIds]) : message.glossaryIds;

        // deadline 从公开入口开始计时（与统计开始时间共用一次时钟读取），配置水合不能让上层剩余预算重新获得完整时长。
        const explicitProviderBudget = getExplicitTranslationBudget(message);
        // 水合仍有独立的有界等待；不得先读取未就绪的服务/设置决定此次 AI 默认。
        await runWithinDeadline(() => deps.ready,
            providerStartedAt + (explicitProviderBudget ?? DEFAULT_PROVIDER_TIMEOUT_MS), now, requestControl?.signal);
        throwIfRequestAborted(requestControl?.signal);

        // 步骤 1：圈选等受信后台事务沿用开始时的 symbol 快照；未附着的公开请求才在 cache/provider await 前复制配置。
        let current = getTranslationProviderConfig(message, () => createTranslationProviderConfigSnapshot(config()));
        const serviceOverride = message.serviceOverride;
        const selectedService = serviceOverride || current.service;
        const providerBudget = explicitProviderBudget ?? (deps.serviceTypes.isAI(selectedService)
            ? normalizeAiRequestTimeoutMs(current.aiRequestTimeoutMs) : DEFAULT_PROVIDER_TIMEOUT_MS);
        const providerDeadline = providerStartedAt + providerBudget;
        trace.serviceId = selectedService;
        if (isTranslationServiceDisabled(current.disabledTranslationServices, selectedService)) {
            throw Object.assign(new Error(TRANSLATION_SERVICE_DISABLED_MESSAGE), {
                kind: 'bad-request', retryable: false, code: 'TRANSLATION_SERVICE_DISABLED',
            });
        }
        if (selectedService === services.chatgptPlan) {
            const unavailable = getTranslationServiceUnavailableMessage(selectedService);
            if (unavailable) throw Object.assign(new Error(unavailable), {kind: 'bad-request', retryable: false});
        }
        if (isCompositeTranslationProviderId(selectedService)) {
            const profile = getCompositeTranslationProvider(current.compositeTranslationProviders, selectedService);
            if (!profile) throw new Error('组合翻译服务已被删除，请重新选择服务');
            if (!profile.services.length) throw new Error('请先为组合翻译添加至少一个服务');
            // 受信快照也可能含旧配置；在排序前排除递归和自引用成员。
            const nonRecursiveMembers = profile.services.filter(member => !isCompositeTranslationProviderId(member));
            if (!nonRecursiveMembers.length) throw new Error('组合翻译没有可用的成员服务');
            const enabledProfile = {
                ...profile,
                services: nonRecursiveMembers.filter(member => !isTranslationServiceDisabled(current.disabledTranslationServices, member)),
            };
            if (!enabledProfile.services.length) throw Object.assign(new Error('组合翻译的所有成员都已关闭，请重新启用至少一个服务'), {
                kind: 'bad-request', retryable: false, code: 'TRANSLATION_SERVICE_DISABLED',
            });
            let lastError: unknown;
            for (const member of compositeRouting.order(enabledProfile)) {
                throwIfRequestAborted(requestControl?.signal);
                const startedAt = now();
                const remaining = Math.min(profile.timeoutMs, getRemainingDeadlineMs(providerDeadline, now));
                const child = attachTranslationProviderConfig({
                    ...message,
                    serviceOverride: member,
                    requestTimeoutMs: remaining,
                    [TRANSLATION_REMAINING_BUDGET]: true,
                }, current);
                // 组合使用成员各自的模型、Thinking 和合批偏好，入口模型不能覆盖整组。
                delete child.modelOverride;
                delete child.thinkingOverride;
                delete child.enableNativeBatch;
                if (requestControl) attachTranslationRequestControl(child, requestControl);
                const memberTrace: TranslationRequestTrace = {
                    cachedSegments: 0, shared: false, upstreamCalls: 0, upstreamMs: 0, routeAttempts: [],
                };
                try {
                    const result = await executeTranslation(child, memberTrace, startedAt, true);
                    throwIfRequestAborted(requestControl?.signal);
                    // 缓存和共享请求不代表上游响应速度，不能让它们污染智能选择。
                    if (memberTrace.upstreamCalls > 0 && !memberTrace.shared) {
                        compositeRouting.record(profile.id, member, true, now() - startedAt);
                    }
                    trace.cachedSegments = memberTrace.cachedSegments;
                    trace.shared = memberTrace.shared;
                    trace.model = memberTrace.model;
                    telemetry.collectRouteAttempt(trace, {route: member, outcome: 'success',
                        durationMs: now() - startedAt, chars: measureTranslationText(message.origin).chars});
                    return result;
                } catch (error) {
                    throwIfRequestAborted(requestControl?.signal);
                    if (error instanceof GlossaryRevisionChangedError
                        || (error instanceof Error && error.name === 'AbortError')) throw error;
                    lastError = error;
                    compositeRouting.record(profile.id, member, false, now() - startedAt);
                    telemetry.collectRouteAttempt(trace, {route: member, outcome: modelUsageOutcome(error),
                        durationMs: now() - startedAt, chars: measureTranslationText(message.origin).chars});
                } finally {
                    trace.upstreamCalls += memberTrace.upstreamCalls;
                    trace.upstreamMs += memberTrace.upstreamMs;
                    for (const attempt of memberTrace.routeAttempts) telemetry.collectRouteAttempt(trace, attempt);
                }
            }
            throw lastError ?? new Error('组合翻译没有可用的成员服务');
        }
        if (deps.serviceTypes.isAI(selectedService)) {
            trace.model = cleanModelName(getEffectiveRequestModel(current, selectedService, message.modelOverride));
        }
        const imageInput = getTranslationImageInput(message);
        if (imageInput && current.privacyProtection?.enabled) throw new PrivacyProtectionError('PRIVACY_IMAGE_BLOCKED');
        // 阻止模式先检查完整输入，不能先发送无敏感词的网页摘要，再发现正文需要阻止。
        if (current.privacyProtection?.enabled && current.privacyProtection.mode === 'block') {
            const preflight = preparePrivacyRequest(message, current);
            preflight.dispose();
        }
        if (imageInput && Array.isArray(message.origin) && message.origin.length > 0) {
            throw new Error('图片识别请求必须使用单条原文');
        }
        const selectedModel = getSelectedModel(current, selectedService, message.modelOverride);
        if (imageInput && (!deps.serviceTypes.isAI(selectedService)
            || !supportsVisionTransport(selectedService, selectedModel))) {
            throw new Error('图片识别需要支持视觉输入的 AI 翻译服务');
        }
        const {sourceLanguage, targetLanguage} = deps.getTranslationLanguages({
            sourceLanguage: message.sourceLanguage?.trim() || current.from,
            targetLanguage: message.targetLanguage?.trim() || current.to,
        });
        const supportsGlossary = supportsTranslationGlossary(
            selectedService, getSelectedModel(current, selectedService, message.modelOverride), deps.serviceTypes,
        );
        if (supportsGlossary && message.glossaryRevision !== undefined
            && message.glossaryRevision !== readGlossaryRevision(current.glossaryLibraries, current.glossaryEnabled)) {
            throw new GlossaryRevisionChangedError();
        }
        const glossarySource = getTranslationGlossaryContext(message);
        // 文档合批只接受受信入口的数组；保留同一分项译文缓存，pending 则按执行策略隔离。
        if (import.meta.env.BROWSER !== 'userscript' && message.documentBatch !== undefined
            && (message.documentBatch !== true || !Array.isArray(message.origin) || glossarySource?.context !== 'document')) {
            const {documentBatch: _ignored, ...withoutDocumentBatch} = message;
            message = withoutDocumentBatch as TranslationRequestMessage;
        }
        const glossaryContext = glossarySource?.context ?? message.glossaryContext ?? 'page';
        // 字幕参考独立于网页摘要开关，只让提示词型 AI 消费真正的文档请求。
        const subtitleContext = !imageInput && glossaryContext === 'document'
            && isPromptBasedAI(current, selectedService, message.modelOverride) && typeof message.subtitleContext === 'string'
            ? message.subtitleContext.trim().slice(0, SUBTITLE_CONTEXT_LIMIT) : '';
        const selectedGlossaryIds = glossaryIds ?? (glossaryContext === 'document' ? current.documentGlossaryIds
            : glossaryContext === 'video' ? current.videoGlossaryIds : null);
        const glossaryTerms = supportsGlossary && current.glossaryEnabled
            ? resolveGlossary(current.glossaryLibraries!, {
                text: getTranslationGlossarySourceText(message.origin),
                sourceLanguage,
                targetLanguage,
                pageUrl: glossarySource?.pageUrl,
                glossaryIds: selectedGlossaryIds ? [...selectedGlossaryIds] : null,
            }).terms
            : [];
        // Provider 只读取命中当前原文的词对；配置原文与域规则不会进入请求 JSON。
        current = Object.freeze({...current,
            glossaryTerms: Object.freeze(glossaryTerms.map(term => Object.freeze({...term}))),
            glossaryMatchContext: Object.freeze({context: glossaryContext, sourceLanguage, targetLanguage, pageUrl: glossarySource?.pageUrl,
                preserveCommonWebTerms: supportsGlossary && glossaryContext === 'page' && !imageInput && modelUsagePurpose(message) === 'translation',
                glossaryIds: selectedGlossaryIds ? Object.freeze([...selectedGlossaryIds]) : null}),
        });
        const execution: TranslationRequestExecution = {
            config: current,
            service: selectedService,
            sourceLanguage,
            targetLanguage,
            enableAIContext: message.enableAIContext ?? current.enableAIContext,
            nativeBatchEnabled: supportsNativeTranslationBatch(selectedService) && (message.enableNativeBatch
                ?? isNativeTranslationBatchEnabled(selectedService, current.nativeBatchTranslationEnabled)),
            acceptUnchangedResult: isUnchangedTranslationResultAllowed(message),
            subtitleContextEnabled: Boolean(subtitleContext),
            compositeMember,
            thinking: message.thinkingOverride ?? isModelThinkingEnabled(
                current.modelThinking,
                selectedService,
                getSelectedModel(current, selectedService, message.modelOverride),
            ),
            abortSignal: requestControl?.signal,
            ownershipKey: requestControl?.ownershipKey,
            privateContext: glossarySource?.privateContext,
            trace,
        };
        const credentialConfig = message.modelOverride
            ? {
                ...current,
                model: {...current.model, [selectedService]: message.modelOverride},
                customModel: {...current.customModel, [selectedService]: message.modelOverride},
            }
            : current;
        const missingCredentialMessage = deps.getMissingCredentialMessage(selectedService, credentialConfig);
        if (missingCredentialMessage) throw new Error(missingCredentialMessage);
        if (serviceOverride && !deps.serviceTypes.machine.has(serviceOverride) && !deps.serviceTypes.isAI(serviceOverride)) {
            throw new Error('独立翻译服务不可用，请选择已配置的机器翻译或 AI 服务');
        }

        // 纯术语留在本地。混合批次从摘要、缓存和 provider 链路移除这些槽，结束时按原位置填回。
        const sourceBatch = Array.isArray(message.origin) ? message.origin : undefined;
        const translatedIndexes = sourceBatch && current.glossaryMatchContext?.preserveCommonWebTerms
            ? Array.from(sourceBatch).flatMap((origin, index) => shouldKeepCommonWebTermLabel(current, origin) ? [] : [index])
            : undefined;
        if (translatedIndexes?.length === 0) return message.origin;
        if (typeof message.origin === 'string' && current.glossaryMatchContext?.preserveCommonWebTerms) {
            // 富文本标签可以拆为多个原生文本槽；只有通过原协议核验的槽参与纯术语判断。
            const protocol = getSingleSlotProtocol(message as TranslationSingleRequestMessage);
            if (shouldKeepCommonWebTermLabel(current, protocol?.sources.join(' ') ?? message.origin)) return message.origin;
        }
        const filteredBatch = sourceBatch && translatedIndexes && translatedIndexes.length < sourceBatch.length
            ? translatedIndexes : undefined;

        const context = typeof message.context === 'string' ? message.context : '';
        const rawPageContext = typeof message.pageContext === 'string' ? message.pageContext : '';
        const useCache = !imageInput && isCacheEnabled(current, message);
        // clear 是缓存代次的线性化边界。清理期间进入的缓存请求必须等到所有
        // 已串联 clear 完成后再取得新代次，等待时间仍计入原始 deadline 且可取消。
        if (useCache) {
            await cacheStore.waitForCacheClearBarrier(providerDeadline, requestControl?.signal);
        }
        const requestGeneration = cacheStore.getCacheGeneration();
        // 步骤 2：摘要是 AI 上下文增强，只拿 provider deadline 的一小段预算。
        const summaryBudget = Math.min(10_000, Math.max(1_000, Math.floor(providerBudget / 4)));
        const sharedPageSummary = await addPageSummary(
            execution,
            imageInput ? '' : rawPageContext,
            useCache,
            requestGeneration,
            providerDeadline,
            message.modelOverride,
            summaryBudget,
        );
        const summarizedPageContext = sharedPageSummary.summarized
            ? buildPageSummaryReference(sharedPageSummary.context, rawPageContext, Array.isArray(message.origin) ? message.origin : [message.origin])
            : sharedPageSummary.context;
        // 篇章证据不进入摘要缓存：每段只复用原有页面摘要，且总参考预算保持 4,000。
        const discourse = !imageInput && isAIContextEnabled(execution, message.modelOverride)
            && typeof message.discourseContext === 'string' ? message.discourseContext.slice(0, 2400) : '';
        // 先转义不可信网页上下文、篇章证据与字幕参考中的保留协议标签，再追加受信漫画标记，杜绝伪造和原样泄漏。
        const safePageContext = escapePageContextDelimiters(summarizedPageContext);
        const safeDiscourse = escapePageContextDelimiters(discourse);
        const safeSubtitleContext = escapePageContextDelimiters(subtitleContext);
        const mangaContext = !imageInput && isAIContextEnabled(execution, message.modelOverride) && message.mangaContext === true;
        const references = [
            safeDiscourse ? `<discourse_evidence>\n${safeDiscourse}\n</discourse_evidence>` : '',
            mangaContext ? '<manga_context />' : '',
            safeSubtitleContext ? `<subtitle_context>\n${safeSubtitleContext}\n</subtitle_context>` : '',
        ].filter(Boolean).join('\n');
        const pageContext = !safeSubtitleContext && !mangaContext && safeDiscourse
            ? `${safePageContext.slice(0, Math.max(0, 4000 - safeDiscourse.length - 48))}\n<discourse_evidence>\n${safeDiscourse}\n</discourse_evidence>`.slice(0, 4000)
            : references ? [safePageContext.slice(0, Math.max(0, 4000 - references.length - 1)), references]
                .filter(Boolean).join('\n').slice(0, 4000)
            : safePageContext;
        const remainingProviderBudget = getRemainingDeadlineMs(providerDeadline, now);

        // 步骤 3：检测样本只属于本地翻译 auto；即使其他扩展页面手工构造该字段，
        // 也不能让重复正文扩散到任何云端 provider。
        const shouldCarryDetectionText = (selectedService === 'chromeTranslator' || selectedService === 'localTranslation')
            && sourceLanguage === 'auto'
            && Boolean(message.sourceLanguageDetectionText?.trim());
        const {discourseContext: _rawDiscourse, subtitleContext: _rawSubtitle, mangaContext: _rawMangaContext, ...withoutDiscourse} = message;
        const providerInput = shouldCarryDetectionText
            ? withoutDiscourse as TranslationRequestMessage
            : (() => {
                const {sourceLanguageDetectionText: _ignored, ...withoutDetectionText} = withoutDiscourse;
                return withoutDetectionText as TranslationRequestMessage;
            })();

        // 步骤 4：把摘要耗时从剩余 provider 请求中扣除，避免后台无限等待。
        const requestMessage = attachTranslationProviderConfig(
            {
                ...providerInput,
                origin: sourceBatch && filteredBatch ? filteredBatch.map(index => sourceBatch[index]!) : message.origin,
                ...(subtitleContext ? {subtitleContext} : {}),
                glossaryIds,
                sourceLanguage,
                targetLanguage,
                thinkingOverride: execution.thinking,
                enableNativeBatch: execution.nativeBatchEnabled,
                requestTimeoutMs: remainingProviderBudget,
            } as TranslationRequestMessage,
            current,
        );
        if (imageInput) attachTranslationImageInput(requestMessage, imageInput);
        // 步骤 5：根据 origin 类型进入单条或批量管线，两者共享缓存身份与 pending 去重。
        if (Array.isArray(requestMessage.origin)) {
            const translated = await translateBatchWithCache(
                execution,
                requestMessage as TranslationBatchRequestMessage,
                context,
                pageContext,
                useCache,
                requestGeneration,
                providerDeadline,
                providerBudget,
            );
            if (!sourceBatch || !filteredBatch) return translated;
            const restored = Array.from(sourceBatch, origin => origin ?? '');
            filteredBatch.forEach((index, position) => {restored[index] = translated[position]!;});
            return restored;
        }
        return translateSingleWithCache(
            execution,
            requestMessage as TranslationSingleRequestMessage,
            context,
            pageContext,
            useCache,
            requestGeneration,
            providerDeadline,
            providerBudget,
        );
    }

    return {
        translateWithCache,
        clearTranslationCache: cacheStore.clearTranslationCache,
        cleanupTranslationCache: cacheStore.cleanupTranslationCache,
    };
}
