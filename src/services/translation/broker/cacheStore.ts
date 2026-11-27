/**
 * @file src/services/translation/broker/cacheStore.ts
 * 文件职责：管理翻译 broker 的持久缓存读写、写前热层、代次线性化清理屏障、页面摘要内存缓存及在途去重身份。
 * 主要内容：封装 pendingTranslations/pendingBatches/pendingPageSummaries 在途登记与释放、按配置快照缓存的额度摘要与云凭据/匿名配置/隐私策略 pending 后缀、批次分项与摘要缓存键构建、单条与批量带热层的有界持久化读写，以及严格串行排空迟到写入的 clear/cleanup 生命周期。
 * 模块边界：仅操作注入的缓存端口与内存去重表，依赖 broker/protocol 与 requestIdentity 策略回调，不直接调用 provider 适配器或承载上下文恢复和组合路由逻辑。
 */

import type {
    TranslationBrokerDependencies,
    TranslationProviderConfigSnapshot,
} from '../types';
import type {CacheRequestMode, createTranslationIdentityPolicy} from '../requestIdentity';
import {waitForBoundedPersistence} from '../persistenceBarrier';
import {currentConfiguredModel} from '../templates';
import {resolveCloudRegion, services} from '@/src/core/config/catalog';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {
    normalizeFreeTranslationCooldownMs,
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
} from '@/src/core/config/freeTranslation';
import {normalizeTranslationMaxRetries} from '@/src/core/config/scheduling';
import {isDoubaoSeedTranslationModel} from '@/src/core/config/doubaoSeedTranslation';
import {sha256Hex} from '@/src/shared/function/sha256';
import {
    runWithinDeadline,
    type PageSummaryResult,
    type TranslationRequestExecution,
} from './protocol';

interface PendingCacheValue {
    readonly generation: number;
    readonly value: string;
}

const PAGE_SUMMARY_CACHE_SIZE = 8;

type IdentityPolicy = ReturnType<typeof createTranslationIdentityPolicy>;

export interface BrokerCacheStoreOptions {
    readonly deps: TranslationBrokerDependencies;
    readonly now: () => number;
    readonly warn: (message: string, error: unknown) => void;
    readonly identity: IdentityPolicy;
}

export function createBrokerCacheStore(options: BrokerCacheStoreOptions) {
    const {deps, now, warn, identity} = options;
    const {getSelectedModel, getEffectiveRequestModel, getProviderEndpoint, buildCacheKey} = identity;

    const pendingTranslations = new Map<string, Promise<string>>();
    const pendingBatches = new Map<string, Promise<string[]>>();
    const pageSummaryCache = new Map<string, PageSummaryResult>();
    const pendingPageSummaries = new Map<string, Promise<PageSummaryResult>>();
    const pendingCacheWrites = new Map<Promise<unknown>, number>();
    const pendingCacheValues = new Map<string, PendingCacheValue>();
    const quotaDigestCache = new WeakMap<TranslationProviderConfigSnapshot, Map<string, string>>();
    let cacheGeneration = 0;
    let cacheClearBarrier: Promise<void> | null = null;

    function getCacheGeneration(): number {
        return cacheGeneration;
    }

    async function waitForCacheClearBarrier(requestDeadline: number, signal?: AbortSignal): Promise<void> {
        // clear 可以在等待期间再次串联；只有观察到的 barrier 仍是最新值时，
        // 才允许缓存请求继续，避免在两个连续 clear 之间读到或写入缓存。
        while (cacheClearBarrier) {
            const barrier = cacheClearBarrier;
            await runWithinDeadline(() => barrier, requestDeadline, now, signal);
        }
    }

    /** 成功和失败均只撤销仍归属本请求的在途记录，不删除 clear 换代后登记的新请求。 */
    function trackPending<T>(pending: Map<string, Promise<T>>, key: string, request: Promise<T>): Promise<T> {
        pending.set(key, request);
        const release = () => {
            if (pending.get(key) === request) pending.delete(key);
        };
        void request.then(release, release);
        return request;
    }

    /** 同一冻结配置派生 transport 的实际 key 与 pending 的有效 key 集合；摘要不进入成功缓存身份。 */
    function quotaDigest(execution: TranslationRequestExecution, model: string, transport = false): string {
        const current = execution.config;
        let bySnapshot = quotaDigestCache.get(current);
        if (!bySnapshot) {
            bySnapshot = new Map();
            quotaDigestCache.set(current, bySnapshot);
        }
        const privateFlag = execution.privateContext === true ? 1 : execution.privateContext === false ? 0 : 2;
        const memoKey = `${execution.service}\u0000${model}\u0000${transport ? 1 : 0}\u0000${privateFlag}`;
        const cached = bySnapshot.get(memoKey);
        if (cached !== undefined) return cached;
        const digest = !deps.serviceTypes.isAI(execution.service)
            ? sha256Hex(JSON.stringify([execution.privateContext]))
            : sha256Hex(JSON.stringify([
                execution.service, model, getProviderEndpoint(current, execution.service),
                transport ? current.token[execution.service]?.trim() || ''
                    : [getServiceApiKeys(current, execution.service), current.apiKeyRotationEnabled?.[execution.service] !== false, current.apiKeyRecoveryMs],
                current.customHeaders?.[execution.service] || '', current.requestHeaderRules, execution.privateContext,
            ]));
        bySnapshot.set(memoKey, digest);
        return digest;
    }

    function pendingIdentitySuffix(execution: TranslationRequestExecution, modelOverride?: string): string {
        const ownershipKey = execution.ownershipKey;
        const {config: current, service} = execution;
        const sdk = deps.serviceTypes.isAiSdk(service) && !(service === services.doubao
            && isDoubaoSeedTranslationModel(currentConfiguredModel(current, service, modelOverride)));
        const rotates = current.apiKeyRotationEnabled?.[service] !== false
            && getServiceApiKeys(current, service).length > 1;
        const retries = rotates ? 0 : current.translationMaxRetries === undefined
            ? 2 : normalizeTranslationMaxRetries(current.translationMaxRetries);
        return (ownershipKey ? `:owner:${ownershipKey.length}:${ownershipKey}` : '')
            + (current.privacyProtection?.enabled ? `:privacy:${sha256Hex(JSON.stringify([current.privacyProtection, current.privacyProtectionSecretTerms]))}` : '')
            + `:quota:${quotaDigest(execution, getEffectiveRequestModel(current, service, modelOverride))}`
            + (sdk ? `:sdk-retries:${retries}` : '');
    }

    function pendingAnonymousConfigSuffix(execution: TranslationRequestExecution): string {
        const {service, config: current} = execution;
        if (service !== 'freeTranslation' && service !== 'myMemory') return '';
        const usesMyMemory = service === 'myMemory'
            || normalizeFreeTranslationOrder(current.freeTranslationOrder).includes('myMemory');
        // 成功译文可跨额度身份复用；正在执行的旧邮箱/等待策略却不能替新配置决定失败。
        // 只保留实际消费的匿名配置，摘要不暴露邮箱，Key 和私有地址从不参与此身份。
        const identityPayload = {
            ...(service === 'freeTranslation' ? {
                timeoutMs: normalizeFreeTranslationTimeoutMs(current.freeTranslationTimeoutMs),
                cooldownMs: normalizeFreeTranslationCooldownMs(current.freeTranslationCooldownMs),
            } : {}),
            ...(usesMyMemory ? {email: (current.myMemoryEmail ?? '').trim()} : {}),
        };
        return `:anonymous:${sha256Hex(JSON.stringify(identityPayload))}`;
    }

    /** 成功译文可跨凭据复用；新凭据/地域请求不能继承旧鉴权失败，摘要只用于内存 pending。 */
    function pendingCloudConfigSuffix(execution: TranslationRequestExecution): string {
        const {service, config: current} = execution;
        let credentials: unknown;
        if (service === services.youdao) {
            credentials = [current.youdaoAppKey, current.youdaoAppSecret];
        } else if (service === services.tencent || service === services.huanYuanTranslation) {
            credentials = [current.tencentSecretId?.trim(), current.tencentSecretKey?.trim()];
        } else if (service === services.baiduTranslation || service === services.googleCloudTranslation
            || service === services.azureTranslator || service === services.aliyunTranslation
            || service === services.volcTranslation || service === services.xiaoniu) {
            const keys = getServiceApiKeys(current, service);
            const usesSecret = service === services.baiduTranslation || service === services.aliyunTranslation
                || service === services.volcTranslation;
            const rotationEnabled = current.apiKeyRotationEnabled?.[service] !== false;
            credentials = [keys, ...(usesSecret ? [current.secret?.[service]?.trim()] : []),
                ...(keys.length > 1 ? [rotationEnabled] : [])];
        } else return '';
        return `:cloud:${sha256Hex(JSON.stringify({credentials,
            region: resolveCloudRegion(service, current.serviceRegion?.[service]),
        }))}`;
    }

    function buildBatchItemCacheKey(
        execution: TranslationRequestExecution,
        origin: string,
        itemIndex: number,
        batchFingerprint: string,
        context: string,
        pageContext: string,
        mode: CacheRequestMode,
        modelOverride?: string,
        subtitleContext?: string,
    ): string {
        // AI 多段和同图语境结果受同批邻段影响，不能只按当前 origin 复用到另一种组合。
        // 把槽位序号和当前项放在首位，再携带完整有序批次的摘要；同批重复原文也不会被错误折叠。
        const sourceIdentity = mode === 'ai-multi-segment' || mode === 'image-context-v1'
            ? [`slot:${itemIndex}`, origin, `batch:${batchFingerprint}`]
            : origin;
        return buildCacheKey(
            execution,
            sourceIdentity,
            context,
            pageContext,
            mode,
            modelOverride,
            undefined,
            subtitleContext,
        );
    }

    function buildPageSummaryCacheKey(
        execution: TranslationRequestExecution,
        pageContext: string,
        modelOverride?: string,
    ): string {
        const {config: current, service} = execution;
        return deps.buildTranslationCacheKey({
            requestMode: 'page-summary',
            pageSummaryPolicy: {version: 2},
            sourceLanguage: current.from,
            targetLanguage: '',
            sourceText: pageContext,
            service,
            model: getSelectedModel(current, service, modelOverride),
            modelThinking: execution.thinking,
            endpoint: getProviderEndpoint(current, service),
            customBody: current.customBody[service] || '',
            ...(current.customHeaders?.[service] ? {customHeaders: current.customHeaders[service]} : {}),
            transportProfile: deps.serviceTypes.isAiSdk(service)
                ? deps.endpointResolver.aiSdkTransportProfile
                : undefined,
        });
    }

    function cachePageSummary(key: string, value: PageSummaryResult): void {
        if (pageSummaryCache.size >= PAGE_SUMMARY_CACHE_SIZE) {
            const oldestKey = pageSummaryCache.keys().next().value!;
            pageSummaryCache.delete(oldestKey);
        }
        pageSummaryCache.set(key, value);
    }

    function readCacheWithPendingValue(generation: number, key: string): Promise<string | null> {
        const pending = pendingCacheValues.get(key);
        if (generation === cacheGeneration && pending?.generation === generation) {
            return Promise.resolve(pending.value);
        }
        return deps.cache.get(key);
    }

    async function writeCacheIfCurrent(generation: number, key: string, value: string): Promise<void> {
        if (generation !== cacheGeneration) return;

        // 缓存写可能因 IndexedDB 事务排队超过响应宽限期。先公开本次已经验证过的值，
        // 让同 key 的紧随请求复用；持久化失败、完成或 clear 换代后再精确撤销。
        const pendingValue: PendingCacheValue = {generation, value};
        const write = Promise.resolve().then(() => deps.cache.set(key, value));
        pendingCacheValues.set(key, pendingValue);
        pendingCacheWrites.set(write, generation);
        try {
            await write;
        } finally {
            pendingCacheWrites.delete(write);
            if (pendingCacheValues.get(key) === pendingValue) pendingCacheValues.delete(key);
        }
    }

    function readCacheBatchWithPendingValues(generation: number, keys: readonly string[]): Promise<Array<string | null>> {
        if (!deps.cache.getMany) {
            const reads = new Map<string, Promise<string | null>>();
            return Promise.all(keys.map(itemKey => {
                let read = reads.get(itemKey);
                if (!read) {
                    read = readCacheWithPendingValue(generation, itemKey);
                    reads.set(itemKey, read);
                }
                return read;
            }));
        }
        const results = new Array<string | null>(keys.length).fill(null);
        const missedByKey = new Map<string, number[]>();
        for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index]!;
            const pending = pendingCacheValues.get(key);
            if (generation === cacheGeneration && pending?.generation === generation) {
                results[index] = pending.value;
                continue;
            }
            let slots = missedByKey.get(key);
            if (!slots) {
                slots = [];
                missedByKey.set(key, slots);
            }
            slots.push(index);
        }
        if (missedByKey.size === 0) return Promise.resolve(results);
        const missedKeys = [...missedByKey.keys()];
        return deps.cache.getMany(missedKeys).then((fetched) => {
            for (let index = 0; index < missedKeys.length; index += 1) {
                const value = fetched[index] ?? null;
                for (const slot of missedByKey.get(missedKeys[index]!)!) {
                    results[slot] = value;
                }
            }
            return results;
        });
    }

    async function writeCacheBatchIfCurrent(
        generation: number,
        entries: readonly {key: string; value: string}[],
    ): Promise<void> {
        if (generation !== cacheGeneration) return;
        const pendingEntries = entries.map(({key, value}) => ({key, pendingValue: {generation, value} as PendingCacheValue}));
        const write = Promise.resolve().then(() => deps.cache.setMany!(entries));
        for (const {key, pendingValue} of pendingEntries) {
            pendingCacheValues.set(key, pendingValue);
        }
        pendingCacheWrites.set(write, generation);
        try {
            await write;
        } finally {
            pendingCacheWrites.delete(write);
            for (const {key, pendingValue} of pendingEntries) {
                if (pendingCacheValues.get(key) === pendingValue) pendingCacheValues.delete(key);
            }
        }
    }

    async function persistCacheWrite(generation: number, key: string, value: string): Promise<void> {
        // MV3 service worker 可能在消息 Promise 完成后立即挂起；成功响应前必须持有写入，
        // 但只等待有限宽限期；迟到写仍留在 pendingCacheWrites 中供 clear 严格排空。
        await waitForBoundedPersistence(
            Promise.resolve().then(() => writeCacheIfCurrent(generation, key, value)),
            {
                graceMs: deps.persistenceGraceMs,
                onFailure: (error) => warn('[FluentRead] translation cache write failed:', error),
                onTimeout: (error) => warn('[FluentRead] translation cache write timed out:', error),
            },
        );
    }

    async function persistCacheBatchWrite(
        generation: number,
        entries: readonly {key: string; value: string}[],
    ): Promise<void> {
        if (entries.length <= 1 || !deps.cache.setMany) {
            await Promise.all(entries.map(({key, value}) => persistCacheWrite(generation, key, value)));
            return;
        }
        await waitForBoundedPersistence(
            Promise.resolve().then(() => writeCacheBatchIfCurrent(generation, entries)),
            {
                graceMs: deps.persistenceGraceMs,
                onFailure: (error) => warn('[FluentRead] translation cache write failed:', error),
                onTimeout: (error) => warn('[FluentRead] translation cache write timed out:', error),
            },
        );
    }

    function clearTranslationCache(): Promise<void> {
        // 步骤 1：先切换代次并断开旧请求去重；旧 provider 仍可返回给原调用者，但不能重新填充缓存。
        cacheGeneration += 1;
        const clearGeneration = cacheGeneration;
        pendingTranslations.clear();
        pendingBatches.clear();
        pendingPageSummaries.clear();
        pendingCacheValues.clear();
        pageSummaryCache.clear();

        // 步骤 2：所有 clear 严格串行。每次都等待自己代次之前已经进入存储
        // 适配器的写入，再执行最终清库；失败不会阻断后续 clear 的执行。
        const previousBarrier = cacheClearBarrier ?? Promise.resolve();
        const clearOperation = previousBarrier.then(async () => {
            const staleWrites = [...pendingCacheWrites]
                .filter(([, generation]) => generation < clearGeneration)
                .map(([write]) => write);
            await Promise.allSettled(staleWrites);
            await deps.cache.clear();
            pageSummaryCache.clear();
        });
        const settledBarrier = clearOperation.then(
            () => undefined,
            () => undefined,
        );
        cacheClearBarrier = settledBarrier;
        void settledBarrier.then(() => {
            if (cacheClearBarrier === settledBarrier) cacheClearBarrier = null;
        });
        return clearOperation;
    }

    async function cleanupTranslationCache(): Promise<void> {
        await deps.cache.cleanup();
    }

    return {
        pendingTranslations,
        pendingBatches,
        pageSummaryCache,
        pendingPageSummaries,
        getCacheGeneration,
        waitForCacheClearBarrier,
        trackPending,
        quotaDigest,
        pendingIdentitySuffix,
        pendingAnonymousConfigSuffix,
        pendingCloudConfigSuffix,
        buildBatchItemCacheKey,
        buildPageSummaryCacheKey,
        cachePageSummary,
        readCacheWithPendingValue,
        readCacheBatchWithPendingValues,
        persistCacheWrite,
        persistCacheBatchWrite,
        clearTranslationCache,
        cleanupTranslationCache,
    };
}

export type BrokerCacheStore = ReturnType<typeof createBrokerCacheStore>;
