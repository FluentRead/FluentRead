/**
 * @file src/providers/translation/connectionTest.ts
 *
 * 文件职责：通过真实 provider registry 执行最小翻译连接测试，覆盖服务鉴权、端点、模型配置和响应解析。
 * 主要内容：连接测试外层 lease 持有 SDK 的原始传输，调用者超时后仍等原始传输结束才归还并发；使用固定英文测试文本调用指定适配器，为 MyMemory 和免费池单服务指定测试语言对，逐服务检查使用匿名适配器与配置等待上限，验证非空结果并返回耗时；formatConnectionTestError 将失败转换为可读消息。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {translationProviderRegistry} from './registry';
import {services} from '@/src/core/config/catalog';
import {formatServiceError} from '@/src/services/translation/serviceErrors';
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestScheduler,
} from '@/src/services/translation/requestSnapshot';
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
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** 通过现有服务适配器发出真实的最小翻译请求，覆盖鉴权、端点、模型和响应解析。 */
export async function runTranslationServiceConnectionTest(
    service: string,
    usageOptions: ConnectionTestUsageOptions = {},
): Promise<{durationMs: number}> {
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
    const timeoutMs = freeProviderId === undefined ? CONNECTION_TEST_TIMEOUT_MS
        : normalizeFreeTranslationTimeoutMs(snapshot?.freeTranslationTimeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('翻译请求超时'));
        }, timeoutMs);
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
            const transport = usageOptions.requestScheduler
                ? usageOptions.requestScheduler.schedule(async (lease) => {
                    const scheduledRequest = attachTranslationRequestScheduler(requestWithConfig, usageOptions.requestScheduler!, {
                        service, model: effectiveModel,
                    }, lease);
                    const operation = Promise.resolve().then(() => adapter(scheduledRequest));
                    lease.holdUntil(operation);
                    return operation;
                }, {
                    signal: controller.signal,
                    deadlineAt: startedAt + timeoutMs,
                    identity: {service, model: effectiveModel},
                    countRate: usageOptions.countRate !== false,
                })
                : Promise.resolve().then(() => adapter(requestWithConfig));
            const response = await Promise.race([transport, timeout]);
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
