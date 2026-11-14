/**
 * @file src/providers/translation/connectionTest.ts
 *
 * 文件职责：通过真实 provider registry 执行最小翻译连接测试，覆盖服务鉴权、端点、模型配置和响应解析。
 * 隐私边界：连接检查中的用户模板同样经过本地脱敏与阻止策略，不能因静态测试原文绕过防护。
 * 主要内容：使用固定英文测试文本调用指定适配器，为 MyMemory 和免费池单服务指定测试语言对；组合服务按配置策略逐成员检查，沿用冻结凭据、成员模型、共享总预算和取消边界，模型用量仍记录真实服务；传递共享调度租约直到真实传输结束，验证非空结果并返回耗时；formatConnectionTestError 将失败转换为可读消息。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {translationProviderRegistry} from './registry';
import {preparePrivacyRequest} from '@/src/services/translation/privacyProtection';
import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {getCompositeTranslationProvider, isCompositeTranslationProviderId} from '@/src/core/config/compositeTranslation';
import {resolveTranslationRequestModel} from '@/src/core/config/requestModel';
import {createCompositeTranslationRoutingState} from '@/src/services/translation/compositeRouting';
import {formatServiceError} from '@/src/services/translation/serviceErrors';
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {attachTranslationModelUsageObserver, attachTranslationProviderConfig, attachTranslationRequestScheduler} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import type {
    TranslationProviderConfigSnapshot,
    TranslationModelUsageObservation,
    TranslationModelUsageOutcome,
    TranslationModelUsageRecord,
} from '@/src/services/translation/types';
import {waitForBoundedPersistence} from '@/src/services/translation/persistenceBarrier';
import {runWithApiKeyRotation, withServiceApiKey} from '@/src/services/translation/apiKeyRotation';
import {getServiceApiKeyRows} from '@/src/core/config/apiKeys';
import {matchesApiKeyCheckRevision} from '@/src/core/config/apiKeyCheckIdentity';
import {isFreeTranslationProviderId, normalizeFreeTranslationTimeoutMs} from '@/src/core/config/freeTranslation';
import {translateFreeTranslationProvider} from './free-translation';

export const CONNECTION_TEST_ORIGIN = 'Hello from FluentRead.';
export const CONNECTION_TEST_TIMEOUT_MS = 30_000;
const COMPOSITE_CONNECTION_TEST_TIMEOUT_MS = 45_000;
const compositeRouting = createCompositeTranslationRoutingState();

export interface ConnectionTestUsageOptions {
    configSnapshot?: TranslationProviderConfigSnapshot;
    keyIndex?: number;
    keyRevision?: string;
    configuredModel?: string;
    recordModelUsage?: (events: readonly TranslationModelUsageRecord[]) => Promise<void>;
    now?: () => number;
    warn?: (message: string, error: unknown) => void;
    persistenceGraceMs?: number;
    requestScheduler?: TranslationRequestScheduler;
    config?: TranslationProviderConfigSnapshot;
    effectiveModel?: string;
    countRate?: boolean;
    freeProviderId?: unknown;
    /** 内部组合成员继承的剩余时间，不能重新取得完整连接检查预算。 */
    requestTimeoutMs?: number;
    signal?: AbortSignal;
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** 通过现有服务适配器发出真实的最小翻译请求，覆盖鉴权、端点、模型和响应解析。 */
export async function runTranslationServiceConnectionTest(
    service: string,
    usageOptions: ConnectionTestUsageOptions = {},
): Promise<{durationMs: number}> {
    if (usageOptions.signal?.aborted) throw connectionTestAbortError();
    if (isCompositeTranslationProviderId(service)) return runCompositeConnectionTest(service, usageOptions);
    const freeProviderId = usageOptions.freeProviderId;
    if (freeProviderId !== undefined && (service !== services.freeTranslation || !isFreeTranslationProviderId(freeProviderId))) {
        throw new Error('无效的免费翻译服务');
    }
    const adapter = typeof freeProviderId === 'string'
        ? (message: Parameters<typeof translateFreeTranslationProvider>[1]) => translateFreeTranslationProvider(freeProviderId, message)
        : translationProviderRegistry[service]
        || (isCustomOpenAIProviderId(service)
            ? translationProviderRegistry[LEGACY_CUSTOM_OPENAI_PROVIDER_ID]
            : undefined);
    if (!adapter) {
        throw new Error(`未找到翻译服务适配器: ${service}`);
    }

    const now = usageOptions.now ?? Date.now;
    const startedAt = now();
    let finishedAt = startedAt;
    const observations: TranslationModelUsageObservation[] = [];
    const configuredModel = usageOptions.configuredModel?.trim() || 'unknown';
    const effectiveModel = usageOptions.effectiveModel?.trim() || configuredModel;
    const controller = new AbortController();
    const snapshot = usageOptions.config ?? usageOptions.configSnapshot;
    const configuredTimeoutMs = freeProviderId === undefined ? CONNECTION_TEST_TIMEOUT_MS
        : normalizeFreeTranslationTimeoutMs(snapshot?.freeTranslationTimeoutMs);
    const timeoutMs = normalizeConnectionTestTimeout(usageOptions.requestTimeoutMs, configuredTimeoutMs,
        freeProviderId === undefined ? COMPOSITE_CONNECTION_TEST_TIMEOUT_MS : configuredTimeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('翻译请求超时'));
        }, timeoutMs);
    });
    let cleanupExternalAbort!: () => void;
    const abort = new Promise<never>((_resolve, reject) => {
        usageOptions.signal?.addEventListener('abort', abortConnectionTest, {once: true});
        function abortConnectionTest() {
            controller.abort();
            reject(connectionTestAbortError());
        }
        cleanupExternalAbort = () => usageOptions.signal?.removeEventListener('abort', abortConnectionTest);
    });

    try {
        const observedRequest = attachTranslationModelUsageObserver({
            origin: CONNECTION_TEST_ORIGIN,
            // 短英文不足以可靠检测语言；固定测试语言对也避免用户选择英文目标时变成同语种请求。
            ...(service === services.myMemory || freeProviderId !== undefined
                ? {sourceLanguage: 'en', targetLanguage: freeProviderId === 'apertiumFree' ? 'es' : 'zh-Hans'} : {}),
            context: '',
            pageContext: '',
            summaryPrompt: '',
            summarySystemPrompt: '',
            serviceOverride: service,
            useCache: false,
            requestTimeoutMs: timeoutMs,
            abortSignal: controller.signal,
        }, (observation) => observations.push({...observation}));
        if (usageOptions.keyIndex !== undefined && (!Number.isSafeInteger(usageOptions.keyIndex) || usageOptions.keyIndex < 0)) {
            throw new Error('连接测试 Key 序号无效');
        }
        if (usageOptions.keyIndex !== undefined && !snapshot) throw new Error('连接测试缺少配置快照');
        if (usageOptions.keyIndex !== undefined && usageOptions.keyRevision !== undefined
            && !matchesApiKeyCheckRevision(snapshot!, service, usageOptions.keyRevision)) {
            throw new Error('服务配置已更改，请重新检查');
        }
        const runAdapter = async (selectedSnapshot?: TranslationProviderConfigSnapshot) => {
            const requestWithConfig = selectedSnapshot
                ? attachTranslationProviderConfig(observedRequest, selectedSnapshot)
                : observedRequest;
            // 连接测试也会使用用户模板，必须遵守与正式翻译相同的隐私规则。
            const invokeAdapter = async (request: typeof requestWithConfig) => {
                if (!selectedSnapshot) return adapter(request);
                const privacy = preparePrivacyRequest(request, selectedSnapshot);
                try {return privacy.restore(await adapter(privacy.message));}
                finally {privacy.dispose();}
            };
            const transport = usageOptions.requestScheduler
                ? usageOptions.requestScheduler.schedule(async (lease) => {
                    // 每次入场建立独立上下文，避免后续 Key 尝试覆盖仍在结算的请求租约。
                    const scheduledRequest = attachTranslationRequestScheduler({...requestWithConfig}, usageOptions.requestScheduler!, {
                        service,
                        model: effectiveModel,
                    }, lease);
                    const operation = Promise.resolve().then(() => invokeAdapter(scheduledRequest));
                    lease.holdUntil(operation);
                    return operation;
                }, {
                    signal: controller.signal,
                    deadlineAt: startedAt + timeoutMs,
                    identity: {service, model: effectiveModel},
                    countRate: usageOptions.countRate !== false,
                })
                : Promise.resolve().then(() => invokeAdapter(requestWithConfig));
            const response = await Promise.race([transport, timeout, abort]);
            if (!isNonEmptyText(response)) throw new Error('服务已响应，但没有返回有效译文');
            if (freeProviderId !== undefined && response.trim() === CONNECTION_TEST_ORIGIN) {
                throw new Error('服务已响应，但未翻译测试文本');
            }
            return response;
        };
        const keyIndex = usageOptions.keyIndex ?? (snapshot
            ? getServiceApiKeyRows(snapshot, service).findIndex(key => Boolean(key.trim())) : -1);
        const selectedKeyIndex = keyIndex >= 0 ? keyIndex : undefined;
        const selectedKeyRequest = selectedKeyIndex !== undefined && snapshot
            ? runWithApiKeyRotation(snapshot, service, runAdapter, {
                keyIndex: selectedKeyIndex,
                signal: controller.signal,
                deadlineAt: startedAt + timeoutMs,
                now,
                model: usageOptions.configuredModel,
            })
            : runAdapter(snapshot ? withServiceApiKey(snapshot, service, '') : undefined);
        await Promise.race([
            selectedKeyRequest,
            timeout,
            abort,
        ]);
        clearTimeout(timer!);
        finishedAt = now();
        await persistConnectionTestUsage('success');
    } catch (error) {
        finishedAt = now();
        const lastObservation = observations.at(-1);
        const outcome = timedOut || isTimeoutError(error) || lastObservation?.statusCode === 408
            ? 'timeout'
            : error instanceof Error && error.name === 'AbortError'
                ? 'cancelled'
                : 'error';
        if (
            outcome === 'timeout'
            && (lastObservation?.outcome === 'cancelled' || lastObservation?.outcome === 'error')
        ) {
            lastObservation.outcome = 'timeout';
        }
        await persistConnectionTestUsage(outcome);
        if (timedOut) throw new Error('翻译请求超时');
        throw error;
    } finally {
        clearTimeout(timer!);
        cleanupExternalAbort();
    }

    return {durationMs: Math.max(0, finishedAt - startedAt)};

    async function persistConnectionTestUsage(fallbackOutcome: TranslationModelUsageOutcome): Promise<void> {
        if (!usageOptions.recordModelUsage || observations.length === 0) return;
        const elapsed = Math.max(0, finishedAt - startedAt);
        const records: TranslationModelUsageRecord[] = observations.map((observation) => ({
            ...observation,
            startedAt: typeof observation.startedAt === 'number' && Number.isFinite(observation.startedAt)
                ? observation.startedAt
                : startedAt,
            durationMs: typeof observation.durationMs === 'number' && Number.isFinite(observation.durationMs)
                ? Math.max(0, observation.durationMs)
                : observations.length === 1 ? elapsed : 0,
            serviceId: service,
            configuredModel,
            purpose: 'connection-test',
            outcome: observation.outcome ?? fallbackOutcome,
        }));
        await waitForBoundedPersistence(
            Promise.resolve().then(() => usageOptions.recordModelUsage!(records)),
            {
                graceMs: usageOptions.persistenceGraceMs,
                onFailure: (error) => usageOptions.warn?.('[FluentRead] connection test usage write failed:', error),
                onTimeout: (error) => usageOptions.warn?.('[FluentRead] connection test usage write timed out:', error),
            },
        );
    }
}

function connectionTestAbortError(): Error {
    const error = new Error('翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

function normalizeConnectionTestTimeout(value: number | undefined, fallback: number, maximum = fallback): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.min(maximum, Math.trunc(value)))
        : fallback;
}

/** 组合检查沿用相同成员配置与实际 provider 路径，逐项用量仍归属真实服务。 */
async function runCompositeConnectionTest(service: string, options: ConnectionTestUsageOptions): Promise<{durationMs: number}> {
    if (options.keyIndex !== undefined || options.keyRevision !== undefined || options.freeProviderId !== undefined) {
        throw new Error('组合翻译连接检查不支持指定 Key 或免费线路');
    }
    const snapshot = options.config ?? options.configSnapshot;
    if (!snapshot) throw new Error('组合翻译连接检查缺少配置快照');
    const profile = getCompositeTranslationProvider(snapshot.compositeTranslationProviders, service);
    if (!profile) throw new Error('组合翻译服务已被删除，请重新选择');
    if (profile.services.length === 0) throw new Error('组合翻译尚未添加成员服务');
    const now = options.now ?? Date.now;
    const startedAt = now();
    const deadlineAt = startedAt + normalizeConnectionTestTimeout(options.requestTimeoutMs, COMPOSITE_CONNECTION_TEST_TIMEOUT_MS);
    let lastError: unknown;
    for (const member of compositeRouting.order(profile)) {
        if (options.signal?.aborted) throw connectionTestAbortError();
        // 受信旧快照也不能让组合引用自己或递归嵌套。
        if (isCompositeTranslationProviderId(member)) continue;
        const remaining = deadlineAt - now();
        if (remaining <= 0) throw new Error('翻译请求超时');
        const memberStartedAt = now();
        try {
            await runTranslationServiceConnectionTest(member, {
                ...options,
                config: snapshot,
                configSnapshot: snapshot,
                configuredModel: resolveConfiguredModel(snapshot.model[member], snapshot.customModel[member]),
                effectiveModel: resolveTranslationRequestModel(snapshot, member, undefined, servicesType.isAiSdk, servicesType.isAI),
                countRate: !servicesType.isAiSdk(member),
                requestTimeoutMs: Math.min(profile.timeoutMs, remaining),
            });
            if (options.signal?.aborted) throw connectionTestAbortError();
            compositeRouting.record(profile.id, member, true, Math.max(0, now() - memberStartedAt));
            return {durationMs: Math.max(0, now() - startedAt)};
        } catch (error) {
            if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
            compositeRouting.record(profile.id, member, false, Math.max(0, now() - memberStartedAt));
            lastError = error;
        }
    }
    throw lastError ?? new Error('组合翻译没有可用的成员服务');
}

function isTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {kind?: unknown; name?: unknown; statusCode?: unknown};
    return candidate.kind === 'timeout'
        || candidate.name === 'TimeoutError'
        || candidate.statusCode === 408;
}

export function formatConnectionTestError(service: string, error: unknown): string {
    return formatServiceError(service, error);
}
