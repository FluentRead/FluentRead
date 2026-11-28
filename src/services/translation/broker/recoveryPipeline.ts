/**
 * @file src/services/translation/broker/recoveryPipeline.ts
 * 文件职责：编排翻译响应的质量复验、页面上下文泄漏恢复、AI 多段紧凑批次熔断回退以及批量请求的去重与拆批恢复。
 * 主要内容：实现单条与文本槽协议的空译文/原文回显/错语种逐槽恢复、无上下文二次复验、通用聊天与原生 LLM 紧凑 JSON 多段协议 5 分钟熔断回退、空白保留与同文去重回填，以及原生批次响应结构损坏时的逐段降级恢复。
 * 模块边界：通过注入的 callProviderWithinDeadline 回调执行上游重发，依赖 broker/protocol 与 core 纯校验逻辑，不读写持久缓存、不管理 pending Map 或统计上报。
 */

import type {
    TranslationBatchRequestMessage,
    TranslationBrokerDependencies,
    TranslationRequestMessage,
    TranslationSingleRequestMessage,
} from '../types';
import {getTranslationImageInput} from '../requestSnapshot';
import {COMPACT_BATCH_RESPONSE_INVALID} from '../compactBatch';
import {supportsNativeTranslationBatch, supportsTranslationBatch} from '../capabilities';
import {isGlossaryOnlyResult, shouldKeepCommonWebTermLabel} from '../glossaryProtection';
import type {createTranslationIdentityPolicy} from '../requestIdentity';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {
    isClearlyWrongLanguageResponse,
    isLikelyUntranslatedResponse,
    isUnchangedTranslationResponse,
} from '@/src/core/translation/resultValidation';
import {hasTranslationContent} from '@/src/core/translation/result';
import {isNativeBatchResponseError, validateNativeBatchResults} from '@/src/core/translation/nativeBatch';
import {isDefinitePageContextLeak, isLikelyPageContextLeak} from '@/src/core/translation/prompts';
import {defaultOption, services} from '@/src/core/config/catalog';
import {
    AI_MULTI_SEGMENT_REPAIR_FAILED,
    AIContextRecoveryResponseError,
    AIMultiSegmentResponseError,
    TranslationSlotResponseError,
    UntranslatedResponseError,
    WrongLanguageResponseError,
    applyRemainingDeadline,
    getSingleSlotProtocol,
    requireBatchResult,
    requireSingleResult,
    requireTranslationContent,
    usesImageTextContext,
    type TranslationRequestExecution,
} from './protocol';

const COMPACT_BATCH_FALLBACK_MS = 5 * 60_000;
const COMPACT_BATCH_FALLBACK_LIMIT = 64;

type IdentityPolicy = Pick<
    ReturnType<typeof createTranslationIdentityPolicy>,
    'getEffectiveRequestModel' | 'isPromptBasedAI' | 'isAIContextEnabled'
>;

export interface BrokerRecoveryPipelineOptions {
    readonly serviceTypes: TranslationBrokerDependencies['serviceTypes'];
    readonly now: () => number;
    readonly warn: (message: string, error: unknown) => void;
    readonly identity: IdentityPolicy;
    readonly quotaDigest: (execution: TranslationRequestExecution, model: string, transport?: boolean) => string;
    readonly callProviderWithinDeadline: (
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
        compactBatch?: boolean,
    ) => Promise<unknown>;
}

export function createBrokerRecoveryPipeline(options: BrokerRecoveryPipelineOptions) {
    const {serviceTypes, now, warn, identity, quotaDigest, callProviderWithinDeadline} = options;
    const {getEffectiveRequestModel, isPromptBasedAI, isAIContextEnabled} = identity;
    const legacyBatchUntil = new Map<string, number>();

    function shouldRecoverPageContextLeak(
        execution: TranslationRequestExecution,
        origin: string,
        result: string,
        pageContext: string,
        modelOverride?: string,
    ): boolean {
        return Boolean(pageContext.trim())
            && (isAIContextEnabled(execution, modelOverride) || execution.subtitleContextEnabled)
            && isLikelyPageContextLeak(origin, result, pageContext);
    }

    function isDefiniteRecoveryPageContextLeak(
        execution: TranslationRequestExecution,
        origin: string,
        result: string,
        pageContext: string,
        modelOverride?: string,
    ): boolean {
        return Boolean(pageContext.trim())
            && (isAIContextEnabled(execution, modelOverride) || execution.subtitleContextEnabled)
            && isDefinitePageContextLeak(origin, result, pageContext);
    }

    /** 第一次误返原文或明显错语种时只重试当前槽；再次异常则显式失败。 */
    async function recoverInvalidResult(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        result: string,
        requestDeadline: number,
        context: string,
        validationPageContext: string,
        usedContextFreeRequest = false,
        recoverEmpty = false,
    ): Promise<string> {
        const protocol = getSingleSlotProtocol(message);
        if (protocol) {
            const parsed = parseTranslationSlots(protocol.packet, result);
            // 保留前端既有的协议失败回退，但绝不能把损坏包写入缓存。
            if (!parsed) return result;
            for (let index = 0; index < parsed.length; index++) {
                const slotMessage = {...message, origin: protocol.sources[index]!, validateTranslationSlots: false};
                if (!hasTranslationContent(slotMessage.origin) || shouldKeepCommonWebTermLabel(execution.config, slotMessage.origin)) {
                    parsed[index] = slotMessage.origin;
                    continue;
                }
                const translation = parsed[index]!;
                // 整包已经无上下文重译时，每槽仍检查明确泄漏；软信号不能再次触发逐槽请求。
                // 按槽比较也能识别另一来源槽包含相同字面标记而被整包检测豁免的泄漏。
                if (usedContextFreeRequest && isDefiniteRecoveryPageContextLeak(
                    execution, slotMessage.origin, translation, validationPageContext, message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
                if (isGlossaryOnlyResult(execution.config, slotMessage.origin, translation)) continue;
                parsed[index] = !hasTranslationContent(translation) || (!usedContextFreeRequest && shouldRecoverPageContextLeak(
                    execution, slotMessage.origin, translation, validationPageContext, message.modelOverride,
                ))
                    ? await callSingleProviderWithoutPageContext(execution, slotMessage, requestDeadline, validationPageContext)
                    : await recoverInvalidResult(execution, slotMessage, translation, requestDeadline, context, validationPageContext, usedContextFreeRequest);
                requireTranslationContent(parsed[index]!);
            }
            return parsed.map((translation, index) =>
                `${protocol.packet.starts[index]}${translation}${protocol.packet.ends[index]}`).join('\n');
        }
        if (!hasTranslationContent(message.origin) && !getTranslationImageInput(message)) return message.origin;
        if (!recoverEmpty) requireTranslationContent(result);
        if (execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin, result)) return result;
        if (isGlossaryOnlyResult(execution.config, message.origin, result)) return result;
        if (hasTranslationContent(result) && !isLikelyUntranslatedResponse(message.origin, result, execution.targetLanguage)
            && !isClearlyWrongLanguageResponse(message.origin, result, execution.targetLanguage)) return result;
        const retried = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context, pageContext: '', subtitleContext: undefined, enableNativeBatch: false}, requestDeadline, now),
        ));
        if (isDefiniteRecoveryPageContextLeak(
            execution, message.origin, retried, validationPageContext, message.modelOverride,
        )) throw new AIContextRecoveryResponseError();
        if (!hasTranslationContent(retried)) throw new TranslationSlotResponseError(recoverEmpty ? AI_MULTI_SEGMENT_REPAIR_FAILED : undefined);
        if (execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin, retried)) return retried;
        if (isGlossaryOnlyResult(execution.config, message.origin, retried)) return retried;
        if (isLikelyUntranslatedResponse(message.origin, retried, execution.targetLanguage)) {
            throw new UntranslatedResponseError();
        }
        if (isClearlyWrongLanguageResponse(message.origin, retried, execution.targetLanguage)) {
            throw new WrongLanguageResponseError();
        }
        return retried;
    }

    async function callSingleProviderWithoutPageContext(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        requestDeadline: number,
        validationPageContext: string,
    ): Promise<string> {
        const result = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context: '', pageContext: '', subtitleContext: undefined}, requestDeadline, now),
        ));
        if (isDefiniteRecoveryPageContextLeak(
            execution,
            message.origin,
            result,
            validationPageContext,
            message.modelOverride,
        )) throw new AIContextRecoveryResponseError();
        return recoverInvalidResult(execution, message, result, requestDeadline, '', validationPageContext, true);
    }

    async function callSingleProviderWithContextRecovery(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
    ): Promise<string> {
        const result = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context, pageContext}, requestDeadline, now),
        ));
        if (getSingleSlotProtocol(message) || !shouldRecoverPageContextLeak(
            execution,
            message.origin,
            result,
            pageContext,
            message.modelOverride,
        )) return recoverInvalidResult(execution, message, result, requestDeadline, context, pageContext);

        warn(
            '[FluentRead] AI page context leaked into translation; retrying once without page context:',
            new Error('AI_PAGE_CONTEXT_LEAK'),
        );
        return callSingleProviderWithoutPageContext(execution, message, requestDeadline, pageContext);
    }

    async function callPromptBasedAIBatch(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
        startWithoutPageContext: boolean,
    ): Promise<string[]> {
        if (message.origin.length === 1) {
            const singleMessage = {...message, origin: message.origin[0]!};
            return [startWithoutPageContext
                ? await callSingleProviderWithoutPageContext(
                    execution,
                    singleMessage,
                    requestDeadline,
                    pageContext,
                )
                : await callSingleProviderWithContextRecovery(
                    execution,
                    singleMessage,
                    context,
                    pageContext,
                    requestDeadline,
                )];
        }

        const requestContext = startWithoutPageContext ? '' : context;
        const requestPageContext = startWithoutPageContext ? '' : pageContext;
        const requestBatch = (
            request: TranslationRequestMessage, nextContext: string, nextPageContext: string, compact = false,
        ) => callProviderWithinDeadline(execution, applyRemainingDeadline({
            ...request,
            context: nextContext,
            pageContext: nextPageContext,
            subtitleContext: nextPageContext ? message.subtitleContext : undefined,
        }, requestDeadline, now), compact);

        let usedContextFreeRequest = startWithoutPageContext;
        let parsed: string[] | null = null;
        const {service, config: current} = execution;
        // 高级 body 和自定义提示词可能依赖标记合同。对通用聊天适配器与主流原生 LLM 适配器启用轻量 JSON 协议，
        // 避免每段反复输出长哨兵标记；返回结构不兼容时自动 5 分钟熔断回退到标记协议。
        const supportsCompactBatch = serviceTypes.isAiSdk(service)
            || service === services.claude
            || service === services.gemini
            || service === services.deepseek
            || service === services.tongyi
            || service === services.zhipu;
        if (supportsCompactBatch
            && (!current.system_role[service] || current.system_role[service] === defaultOption.system_role)
            && (!current.user_role[service] || current.user_role[service] === defaultOption.user_role)
            && !current.customBody[service]?.trim()) {
            const scope = quotaDigest(execution, getEffectiveRequestModel(current, service, message.modelOverride));
            if ((legacyBatchUntil.get(scope) ?? -Infinity) <= now()) {
                try {
                    parsed = requireBatchResult(
                        await requestBatch(message, requestContext, requestPageContext, true), message.origin.length,
                    );
                } catch (error) {
                    const code = (error as {code?: string} | null)?.code;
                    if (code !== COMPACT_BATCH_RESPONSE_INVALID && code !== 'GLOSSARY_PLACEHOLDER_INVALID'
                        && code !== 'PRIVACY_RESTORE_FAILED' && code !== 'DOCUMENT_INLINE_MARKER_INVALID') throw error;
                    legacyBatchUntil.delete(scope);
                    legacyBatchUntil.set(scope, now() + COMPACT_BATCH_FALLBACK_MS);
                    if (legacyBatchUntil.size > COMPACT_BATCH_FALLBACK_LIMIT) {
                        legacyBatchUntil.delete(legacyBatchUntil.keys().next().value!);
                    }
                }
            }
        }

        let packet: ReturnType<typeof serializeTranslationSlots> | undefined;
        if (!parsed) {
            packet = serializeTranslationSlots(message.origin);
            const legacy = {...message, origin: packet.payload};
            let rawResult = requireSingleResult(await requestBatch(legacy, requestContext, requestPageContext));
            // 协议完整时先定位异常槽，避免同一处上下文泄漏导致整批再发送。
            parsed = parseTranslationSlots(packet, rawResult);
            if (!parsed && shouldRecoverPageContextLeak(
                execution,
                packet.payload,
                rawResult,
                requestPageContext,
                message.modelOverride,
            )) {
                warn(
                    '[FluentRead] AI page context leaked into multi-segment translation; retrying once without page context:',
                    new Error('AI_PAGE_CONTEXT_LEAK'),
                );
                rawResult = requireSingleResult(await requestBatch(legacy, '', ''));
                parsed = parseTranslationSlots(packet, rawResult);
                usedContextFreeRequest = true;
                if (isDefiniteRecoveryPageContextLeak(
                    execution, packet.payload, rawResult, pageContext, message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
            }
        }

        // 严格解析器已经校验标记数量、顺序和每槽唯一性。
        if (!parsed) {
            throw new AIMultiSegmentResponseError();
        }

        // 所有槽均为空或回显原文时没有可复用成果，交给既有批次熔断；不能边重试边放大坏协议。
        const needsRepair = (result: string, index: number) => !hasTranslationContent(result)
            || (!(execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin[index], result))
                && !isGlossaryOnlyResult(execution.config, message.origin[index], result)
                && isLikelyUntranslatedResponse(message.origin[index], result, execution.targetLanguage));
        if (parsed.every(needsRepair)) throw new AIMultiSegmentResponseError();

        // 若协议完整但只有个别段落误译了页面上下文，并发重译受影响段落，
        // 已正确的同批结果继续复用，避免整批再次消耗或逐槽串行拖长延迟。
        const leakRepairIndexes: number[] = [];
        for (let index = 0; index < parsed.length; index += 1) {
            const origin = message.origin[index];
            const leakedPageContext = shouldRecoverPageContextLeak(
                execution,
                origin,
                parsed[index],
                pageContext,
                message.modelOverride,
            );
            if (!leakedPageContext) continue;
            if (usedContextFreeRequest) {
                if (isDefiniteRecoveryPageContextLeak(
                    execution,
                    origin,
                    parsed[index],
                    pageContext,
                    message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
                continue;
            }
            leakRepairIndexes.push(index);
        }
        if (leakRepairIndexes.length > 0) {
            await Promise.all(leakRepairIndexes.map(async (index) => {
                parsed[index] = await callSingleProviderWithoutPageContext(
                    execution,
                    {...message, origin: message.origin[index]},
                    requestDeadline,
                    pageContext,
                );
            }));
        }
        const invalidRepairIndexes: number[] = [];
        for (let index = 0; index < parsed.length; index += 1) {
            const origin = message.origin[index];
            if (!needsRepair(parsed[index], index)
                && !isClearlyWrongLanguageResponse(origin, parsed[index], execution.targetLanguage)) continue;
            invalidRepairIndexes.push(index);
        }
        if (invalidRepairIndexes.length > 0) {
            await Promise.all(invalidRepairIndexes.map(async (index) => {
                const origin = message.origin[index];
                const repaired = await recoverInvalidResult(
                    execution, {...message, origin}, parsed[index], requestDeadline, '', pageContext, usedContextFreeRequest, true,
                );
                // 单槽恢复不能把上一次完整协议包当作译文；来源已避让本包标记，出现即表示串槽。
                if (packet && [...packet.starts, ...packet.ends].some(marker => repaired.includes(marker))) {
                    throw new TranslationSlotResponseError(AI_MULTI_SEGMENT_REPAIR_FAILED);
                }
                parsed[index] = repaired;
            }));
        }
        return parsed;
    }

    async function callBatchProviderWithContextRecovery(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
        startWithoutPageContext = false,
    ): Promise<string[]> {
        // 空白没有上游翻译语义；保留原始位置与空白，不能让空响应伪装成完成的正文。
        const nonEmptyIndexes = message.origin.map((origin, index) => origin && hasTranslationContent(origin) ? index : -1)
            .filter(index => index >= 0);
        if (nonEmptyIndexes.length !== message.origin.length) {
            const origins = [...message.origin];
            if (nonEmptyIndexes.length === 0) return origins.map(origin => origin ?? '');
            const translated = await callBatchProviderWithContextRecovery(
                execution,
                {...message, origin: nonEmptyIndexes.map(index => origins[index]!)},
                context, pageContext, requestDeadline, startWithoutPageContext,
            );
            let ordinal = 0;
            return origins.map(origin => origin && hasTranslationContent(origin) ? translated[ordinal++]! : origin ?? '');
        }
        const promptBasedAI = isPromptBasedAI(
            execution.config,
            execution.service,
            message.modelOverride,
        );
        const nativeBatch = supportsNativeTranslationBatch(execution.service);
        // 去重不依赖持久缓存；全文批次或关闭缓存的显式数组也只发送一份相同原文。
        // AI 多段和同图语境中的同文槽可能受各自邻段影响，须保留完整有序输入。
        if (!(message.aiMultiSegment === true && promptBasedAI && !nativeBatch) && !usesImageTextContext(execution, message)) {
            const uniqueIndexes = new Map<string, number>();
            for (const origin of message.origin) {
                if (!uniqueIndexes.has(origin)) uniqueIndexes.set(origin, uniqueIndexes.size);
            }
            if (uniqueIndexes.size !== message.origin.length) {
                const translated = await callBatchProviderWithContextRecovery(
                    execution,
                    {...message, origin: [...uniqueIndexes.keys()]},
                    context, pageContext, requestDeadline, startWithoutPageContext,
                );
                return message.origin.map(origin => translated[uniqueIndexes.get(origin)!]!);
            }
        }
        if (nativeBatch && !execution.nativeBatchEnabled) {
            // 显式数组继续原子返回；关闭合批只改变上游请求形态，不提前发布或缓存任何槽。
            const translated: string[] = [];
            for (const origin of message.origin) {
                const single = {...message, origin, enableNativeBatch: false};
                translated.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return validateNativeBatchResults(message.origin, translated);
        }
        if (message.aiMultiSegment === true && promptBasedAI && !nativeBatch) {
            return callPromptBasedAIBatch(
                execution,
                message,
                context,
                pageContext,
                requestDeadline,
                startWithoutPageContext,
            );
        }
        if (execution.compositeMember && !supportsTranslationBatch(execution.service)) {
            // 单条协议的成员逐段执行，仍只在整批校验成功后发布组合批次缓存。
            const translated: string[] = [];
            for (const origin of message.origin) {
                const single = {...message, origin};
                translated.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return requireBatchResult(translated, message.origin.length);
        }
        const nativeOrigins = nativeBatch ? [...message.origin] : message.origin;
        let results: string[];
        try {
            const result = await callProviderWithinDeadline(
                execution,
                applyRemainingDeadline({
                    ...message,
                    origin: nativeBatch ? [...nativeOrigins] : message.origin,
                    context: startWithoutPageContext ? '' : context,
                    pageContext: startWithoutPageContext ? '' : pageContext,
                    ...(startWithoutPageContext ? {subtitleContext: undefined} : {}),
                }, requestDeadline, now),
            );
            results = nativeBatch ? validateNativeBatchResults(nativeOrigins, result)
                : requireBatchResult(result, message.origin.length);
        } catch (error) {
            // 网络、鉴权与限流沿现有失败链路返回；只有响应结构损坏才允许拆批，逐段恢复避免首槽超时或取消时放大上游请求。
            if (!nativeBatch || !isNativeBatchResponseError(error)) throw error;
            const recovered: string[] = [];
            for (const origin of nativeOrigins) {
                // 恢复必须是真正的单项请求，不能被 Google 的 scalar 收集窗重新合成坏批次。
                const single = {...message, origin, enableNativeBatch: false};
                recovered.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return recovered;
        }
        if (promptBasedAI) {
            const leakRepairs: Array<{index: number; origin: string}> = [];
            for (let index = 0; index < results.length; index += 1) {
                const origin = message.origin[index] ?? '';
                const leakedPageContext = shouldRecoverPageContextLeak(
                    execution,
                    origin,
                    results[index] ?? '',
                    pageContext,
                    message.modelOverride,
                );
                if (!leakedPageContext) continue;
                if (startWithoutPageContext) {
                    if (isDefiniteRecoveryPageContextLeak(
                        execution,
                        origin,
                        results[index] ?? '',
                        pageContext,
                        message.modelOverride,
                    )) throw new AIContextRecoveryResponseError();
                    continue;
                }
                leakRepairs.push({index, origin});
            }
            if (leakRepairs.length > 0) {
                await Promise.all(leakRepairs.map(async ({index, origin}) => {
                    results[index] = await callSingleProviderWithoutPageContext(
                        execution,
                        {...message, origin},
                        requestDeadline,
                        pageContext,
                    );
                }));
            }
        }
        // 机器与 AI 数组共用逐项质量恢复；仅 AI 的无上下文重试清空提示上下文，多槽修复并发完成。
        const finalized = Array.from(results, value => value ?? '');
        return Promise.all(finalized.map((value, index) => recoverInvalidResult(
            execution, {...message, origin: message.origin[index] ?? ''}, value ?? '',
            requestDeadline, promptBasedAI && startWithoutPageContext ? '' : context, pageContext,
        )));
    }

    return {
        isDefiniteRecoveryPageContextLeak,
        callSingleProviderWithoutPageContext,
        callSingleProviderWithContextRecovery,
        callBatchProviderWithContextRecovery,
    };
}
