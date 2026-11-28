/**
 * @file src/services/translation/apiKeyRotation.ts
 * 文件职责：把服务凭据快照接入动态 Key 轮询，统一翻译和模型调用的失败切换与单 Key 检测。
 * 主要内容：使用摘要隔离服务及端点状态，逐次绑定不可变凭据，共享总预算，限制每次请求每个 Key 只尝试一次；单次快捷路径同样拒绝取消后的迟到结果并清理错误中的凭据。
 * 模块边界：本服务不读取全局配置、不保存密钥或执行 HTTP；调度、取消与实际请求由调用方提供，健康权重仅存于当前运行进程。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {getServiceApiKeys, getServiceApiKeyRows, type ApiKeyConfigSource} from '@/src/core/config/apiKeys';
import {createApiKeyRotation, classifyApiKeyFailure} from '@/src/core/translation/apiKeyPool';
import {normalizeApiKeyRecoveryMs} from '@/src/core/config/scheduling';
import {getApiKeyRequestProxy, getApiKeySigningCredentials} from '@/src/core/config/apiKeyCheckIdentity';
import {serializeTranslationError, TranslationRequestError} from './errors';

type KeyConfig = ApiKeyConfigSource & {
    readonly token?: Readonly<Record<string, string>>;
    readonly apiKeyRotationEnabled?: Readonly<Record<string, boolean>>;
    readonly apiKeyRecoveryMs?: number;
};
export interface ApiKeyAttempt {
    readonly attemptTimeoutMs?: number;
    readonly attempt: number;
}
export interface ApiKeyRequestOptions {
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
    readonly now?: () => number;
    readonly model?: string;
    /** 单项检测绕过冷却，只测试指定原始行；不会切换成其他 Key。 */
    readonly keyIndex?: number;
}

/** 同一后台的翻译、阅读/写作和主动检测共用；只存摘要，不持久化健康状态。 */
const rotations = new Map<number, ReturnType<typeof createApiKeyRotation>>();

function getRotation(source: KeyConfig): ReturnType<typeof createApiKeyRotation> {
    const recoveryMs = normalizeApiKeyRecoveryMs(source.apiKeyRecoveryMs);
    let rotation = rotations.get(recoveryMs);
    if (!rotation) {
        // 配置范围按分钟限制为 1–60，因此该缓存最多保留 60 个策略实例。
        rotation = createApiKeyRotation({recoveryMs});
        rotations.set(recoveryMs, rotation);
    }
    return rotation;
}

export function withServiceApiKey<T extends KeyConfig>(source: T, service: string, key: string): T {
    return Object.freeze({...source,
        token: Object.freeze({...source.token, [service]: key}),
        apiKeys: Object.freeze({[service]: Object.freeze([key])}),
    }) as T;
}

/** 只把当前服务实际使用的配置纳入身份；其他服务编辑不会重置本服务权重。 */
function scopeFor(source: KeyConfig, service: string, model?: string): string {
    const fields = source as Record<string, unknown>;
    const selected: Record<string, unknown> = {service, requestedModel: model};
    for (const name of ['customBody', 'customHeaders', 'model', 'customModel', 'serviceRegion']) {
        selected[name] = (fields[name] as Record<string, unknown> | undefined)?.[service];
    }
    selected.proxy = getApiKeyRequestProxy(service, (fields.proxy as Record<string, unknown> | undefined)?.[service]);
    selected.signingCredentials = getApiKeySigningCredentials(source, service);
    selected.apiKeyRotationEnabled = (fields.apiKeyRotationEnabled as Record<string, unknown> | undefined)?.[service] !== false;
    const routeFields: Record<string, readonly string[]> = {
        custom: ['custom'], deeplx: ['deeplx'], deepL: ['deeplApiPlan'], newapi: ['newApiUrl'],
        azureOpenai: ['azureOpenaiEndpoint'], minimax: ['minimaxRegion', 'minimaxBillingPlan'],
        mimo: ['mimoRegion', 'mimoBillingPlan'], deepseek: ['deepseekApiType'],
    };
    for (const name of routeFields[service] ?? []) {
        selected[name] = fields[name];
    }
    selected.customEndpoint = (fields.customOpenAIProviders as {id: string; endpoint?: string}[] | undefined)
        ?.find(item => item.id === service)?.endpoint;
    return sha256Hex(JSON.stringify(selected));
}

/** provider 回显的任意 key 都不得进入 runtime 错误或日志。 */
export function redactApiKeyError(error: unknown, keys: readonly string[]): TranslationRequestError {
    const serialized = serializeTranslationError(error);
    for (const field of ['message', 'code', 'requestId'] as const) {
        let value = serialized[field];
        if (value === undefined) continue;
        for (const key of keys) {
            if (!key) continue;
            value = value.split(key).join('[已隐藏的密钥]').split(encodeURIComponent(key)).join('[已隐藏的密钥]');
        }
        serialized[field] = value;
    }
    return new TranslationRequestError(serialized);
}

function cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('翻译请求已取消', 'AbortError');
}

export async function runWithApiKeyRotation<T extends KeyConfig, R>(
    source: T,
    service: string,
    operation: (selected: T, attempt: ApiKeyAttempt) => Promise<R>,
    options: ApiKeyRequestOptions = {},
): Promise<R> {
    cancelled(options.signal);
    const keys = [...new Set(getServiceApiKeys(source, service))];
    // 普通单 Key 和显式关闭轮询的请求不读轮询身份，也不散列全部密钥。
    // 单项检测仍必须进入健康状态路径，不能被此快捷路径绕过。
    const rotationEnabled = source.apiKeyRotationEnabled?.[service] !== false && keys.length > 1;
    if (options.keyIndex === undefined && !rotationEnabled) {
        try {
            const result = await operation(withServiceApiKey(source, service, keys[0] ?? ''), {attempt: 0});
            cancelled(options.signal);
            return result;
        } catch (error) {
            cancelled(options.signal);
            if (keys.length === 0) throw error;
            const safeError = redactApiKeyError(error, keys);
            const original = serializeTranslationError(error);
            // 本地 deadline 等错误使用类身份触发恢复；没有凭据回显时保留原对象。
            if (safeError.message === original.message && safeError.code === original.code
                && safeError.requestId === original.requestId) throw error;
            // provider 的本地取消仍须被上层识别，不能因脱敏变成普通可重试失败。
            if (error instanceof Error && error.name === 'AbortError') safeError.name = 'AbortError';
            throw safeError;
        }
    }
    const now = options.now ?? Date.now;
    const rotation = getRotation(source);
    const scope = scopeFor(source, service, options.model);
    const ids = keys.map(key => sha256Hex(key));
    const excluded: string[] = [];
    let lastError: unknown;
    cancelled(options.signal);

    if (options.keyIndex !== undefined) {
        const rows = getServiceApiKeyRows(source, service);
        if (!Number.isSafeInteger(options.keyIndex) || options.keyIndex < 0 || !rows[options.keyIndex]?.trim()) {
            throw new Error('这个 API Key 已更改或为空，请重新检查');
        }
        const key = rows[options.keyIndex].trim();
        const id = sha256Hex(key);
        // 初始化/同步列表但不领取普通轮询租约，检测不会被冷却阻挡。
        rotation.nextRetry(scope, ids, [], now());
        try {
            const result = await operation(withServiceApiKey({...source, translationMaxRetries: 0}, service, key), {attempt: 0});
            cancelled(options.signal);
            rotation.success(scope, id, now());
            return result;
        } catch (error) {
            cancelled(options.signal);
            const failure = classifyFailure(error);
            if (failure !== 'none') rotation.fail(scope, id, failure === 'cooldown' ? 'auth' : 'transient', now(),
                failure === 'cooldown' ? serializeTranslationError(error).retryAfterMs : undefined);
            throw redactApiKeyError(error, keys);
        }
    }

    while (excluded.length < keys.length) {
        cancelled(options.signal);
        const remaining = options.deadlineAt === undefined ? undefined : options.deadlineAt - now();
        if (remaining !== undefined && remaining <= 0) {
            throw redactApiKeyError(lastError ?? new Error('翻译请求超时'), keys);
        }
        let lease;
        try {
            lease = rotation.pick(scope, ids, excluded, now());
        } catch (error) {
            // scope 和 Key ID 均由本模块生成合法摘要，此处只会因池耗尽而失败。
            const retryAfterMs = rotation.nextRetry(scope, ids, [], now());
            const safeLastError = redactApiKeyError(lastError ?? error, keys);
            throw new TranslationRequestError({
                ...serializeTranslationError(safeLastError),
                message: lastError ? `${safeLastError.message} 其他 Key 暂时不可用，请稍后重试或逐项检查。`
                    : `所有 API Key 暂时不可用，约 ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} 分钟后自动恢复尝试，也可以逐项检查。`,
                kind: 'rate-limit', retryable: false, retryAfterMs,
            });
        }
        const key = keys[ids.indexOf(lease.keyId)];
        excluded.push(lease.keyId);
        try {
            const result = await operation(withServiceApiKey({...source, translationMaxRetries: 0}, service, key), {
                attempt: excluded.length - 1,
                // 最多按三次分配单次预算，避免大量 Key 把每次请求切得过短。
                attemptTimeoutMs: remaining === undefined ? undefined
                    : Math.max(1, Math.floor(remaining / Math.min(keys.length - excluded.length + 1, 3))),
            });
            cancelled(options.signal);
            rotation.success(scope, lease, now());
            return result;
        } catch (error) {
            const failure = options.signal?.aborted ? 'none' : classifyFailure(error);
            rotation.fail(scope, lease, failure === 'cooldown' ? 'auth' : failure === 'penalty' ? 'transient' : 'cancelled', now(),
                failure === 'cooldown' ? serializeTranslationError(error).retryAfterMs : undefined);
            cancelled(options.signal);
            lastError = error;
            if (failure === 'none') throw redactApiKeyError(error, keys);
        }
    }
    throw redactApiKeyError(lastError, keys);
}

function classifyFailure(error: unknown) {
    const serialized = serializeTranslationError(error);
    return classifyApiKeyFailure({
        ...serialized,
        name: error instanceof Error ? error.name : undefined,
        kind: serialized.kind === 'authentication' ? 'auth'
            : serialized.kind === 'rate-limit' ? 'rate-limit'
            : serialized.kind === 'network' ? 'network'
            : serialized.kind === 'timeout' ? 'transient'
            : serialized.kind === 'provider' ? 'server'
            : serialized.kind === 'bad-request' || serialized.kind === 'response' ? 'config' : undefined,
    });
}
