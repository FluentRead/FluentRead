/**
 * @file src/features/full-page-translation/content/slotExecution.ts
 * 文件职责：执行单候选文本槽的底层翻译策略，涵盖逐槽并发翻译、数组批量校验、会话槽缓存去重与内部槽协议回退。
 * 主要内容：为本地与 Chrome 引擎按需复用整段检测样本并在多语种混排时隔离独立槽语种；对原生批译服务执行槽缓存增量补齐；对通用 AI 服务执行序列化槽协议并在格式不合法时回退逐槽。
 * 模块边界：仅负责单候选文本数组的翻译执行，不负责跨候选合批队列、页面篇章上下文调度或 DOM 节点操作。
 */
import {services, servicesType} from '@/src/core/config/catalog';
import {isCompositeTranslationProviderId} from '@/src/core/config/compositeTranslation';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {normalizeMaxConcurrentTranslations} from '@/src/core/config/scheduling';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {translateText, translateTextBatch} from '@/src/services/translation/client';
import {supportsNativeTranslationBatch, supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {validateNativeBatchResults} from '@/src/core/translation/nativeBatch';
import {
    cancelTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';
import type {FullPageTranslationConfigSnapshot} from './translationConfigSnapshot';
import {getPageSourceTitle} from './pageTitleSource';
import {
    createAbortError,
    createCacheKey,
    createSnapshotTranslateOptions,
    rememberTranslation,
    throwIfAborted,
    type FullPageTranslationSessionCache,
    type SnapshotTranslateExecutionOptions,
} from './requestCache';

export async function translateSlotsIndividually(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    context = getPageSourceTitle(),
    discourseContext?: string,
): Promise<string[]> {
    throwIfAborted(signal);
    const translations = new Array<string>(origins.length);
    let nextIndex = 0;
    const workerCount = Math.min(
        normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations),
        origins.length,
    );
    // 本地自动检测沿用整段来源；Chrome 槽协议损坏后也不能退回不可靠的短标题检测。
    // 只有同一候选包含不同已识别语种（如日文槽与英文槽混排）时，已独立识别的槽改用自身语种，避免被另一语种覆盖。
    const joinedDetectionText = snapshot.sourceLanguage === 'auto'
        && (snapshot.service === services.localTranslation || snapshot.service === services.chromeTranslator)
        ? origins.join('\n') : undefined;
    const slotIdentifications = joinedDetectionText !== undefined && origins.length > 1
        ? origins.map(origin => identifyTextLanguage(origin)) : undefined;
    const hasConflictingSlotLanguages = new Set(
        slotIdentifications?.flatMap(item => item.status === 'identified' && item.languages.length === 1 ? item.languages : []) ?? [],
    ).size > 1;
    let failed = false;
    let firstError: unknown;
    let hasFirstError = false;
    const siblingController = new AbortController();
    const abortSiblings = () => {
        siblingController.abort();
        if (queueSession) cancelTranslationQueueSession(queueSession, createAbortError());
    };
    signal?.addEventListener('abort', abortSiblings, {once: true});
    const workers = Array.from({length: workerCount}, async () => {
        while (!failed && nextIndex < origins.length) {
            throwIfAborted(siblingController.signal);
            const index = nextIndex++;
            const slotOrigin = origins[index] ?? '';
            const sourceLanguageDetectionText = joinedDetectionText !== undefined
                && (!hasConflictingSlotLanguages || slotIdentifications?.[index]?.status !== 'identified')
                ? joinedDetectionText : undefined;
            try {
                translations[index] = await translateText(slotOrigin, context,
                    createSnapshotTranslateOptions(snapshot, {
                        discourseContext,
                        signal: siblingController.signal,
                        queueSession,
                        ...(sourceLanguageDetectionText !== undefined
                            ? {sourceLanguageDetectionText}
                            : {}),
                    }));
            } catch (error) {
                if (!hasFirstError) {
                    hasFirstError = true;
                    firstError = error;
                }
                failed = true;
                siblingController.abort();
                if (queueSession) cancelTranslationQueueSession(queueSession, firstError);
                throw error;
            }
        }
    });
    try {
        const outcomes = await Promise.allSettled(workers);
        if (hasFirstError) throw firstError;
        const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (rejected) throw rejected.reason;
        return translations;
    } finally {
        signal?.removeEventListener('abort', abortSiblings);
    }
}

export async function translateArrayWithValidation(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    options: SnapshotTranslateExecutionOptions,
    context = getPageSourceTitle(),
    discourseContext?: string,
): Promise<string[]> {
    const translations = await translateTextBatch([...origins], context,
        createSnapshotTranslateOptions(snapshot, {...options, discourseContext}));
    // 原生响应恢复只由 broker 在同一总 deadline 内执行；最终失败不得在前端重获预算。
    return supportsNativeTranslationBatch(snapshot.service)
        ? validateNativeBatchResults(origins, translations, '批量翻译返回结构异常')
        : translations;
}

export async function translateTextSlotsDirectly(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    onSlotProtocolInvalid?: () => void,
    context = getPageSourceTitle(),
    discourseContext?: string,
): Promise<string[]> {
    throwIfAborted(signal);
    // 小模型直接翻译各槽，不要求模型复述结构标记；短链接借用段落正文检测语言。
    if (snapshot.service === services.localTranslation) {
        return translateSlotsIndividually(origins, snapshot, signal, queueSession, context, discourseContext);
    }
    const batchFriendly = isCompositeTranslationProviderId(snapshot.service)
        || supportsNativeTranslationBatch(snapshot.service)
        || snapshot.service === services.freeTranslation
        || snapshot.service === services.bilibili
        || (servicesType.isMachine(snapshot.service) && supportsTranslationBatch(snapshot.service));
    if (batchFriendly) {
        if (!fullPageSession?.active || fullPageSession.retainSettledResults === false) {
            return translateArrayWithValidation(origins, snapshot, {signal, queueSession}, context, discourseContext);
        }

        const resultPromises = new Array<Promise<string | undefined>>(origins.length);
        // 缺失条目复用首次按入口复制快照生成的键；只在本次批译内携带，不跨调用记忆快照。
        const missing = new Map<string, {key: string; origin: string; indexes: number[]}>();
        for (const [index, origin] of origins.entries()) {
            const key = createCacheKey(origin, snapshot);
            const cached = fullPageSession.translationSlotCache.get(key);
            // 未结算的逐槽 promise 仍属于创建它的整请求取消域。只复用稳定结果；
            // 完全相同的重挂请求由外层 request cache 安全合并并统计 waiter。
            if (cached?.settled) {
                resultPromises[index] = cached.promise;
                continue;
            }
            const entry = missing.get(key);
            if (entry) entry.indexes.push(index);
            else missing.set(key, {key, origin, indexes: [index]});
        }

        if (missing.size > 0) {
            const entries = [...missing.values()];
            const providerRequest = translateArrayWithValidation(
                entries.map(({origin}) => origin),
                snapshot,
                {signal, queueSession},
                context,
                discourseContext,
            ).then((translations) =>
                Array.isArray(translations) && translations.length === entries.length
                && Array.from(translations).every((translation) => typeof translation === 'string')
                    ? translations
                    : null,
            );
            entries.forEach(({key, indexes}, entryIndex) => {
                const result = providerRequest.then((translations) => translations?.[entryIndex]);
                rememberTranslation(fullPageSession, key, result);
                indexes.forEach((index) => {
                    resultPromises[index] = result;
                });
            });
        }

        const translations = await Promise.all(resultPromises);
        if (translations.some((translation) => typeof translation !== 'string')) {
            fullPageSession.translationSlotCache.clear();
            return [];
        }
        return translations as string[];
    }
    if (origins.length === 1) {
        return [await translateText(origins[0] ?? '', context,
            createSnapshotTranslateOptions(snapshot, {discourseContext, signal, queueSession}))];
    }

    // 只有支持通用提示词的模型使用内部槽协议；单串机器接口不得承担标记分界。
    if (servicesType.isMachine(snapshot.service)
        || (servicesType.isAI(snapshot.service) && !servicesType.isUseAIContext(snapshot.service, snapshot.model))) {
        return translateSlotsIndividually(origins, snapshot, signal, queueSession, context, discourseContext);
    }
    const packet = serializeTranslationSlots(origins);
    const combined = await translateText(packet.payload, context, createSnapshotTranslateOptions(snapshot, {
        discourseContext,
        skipLanguageDetection: true,
        validateTranslationSlots: true,
        signal,
        queueSession,
    }));
    throwIfAborted(signal);
    const parsed = parseTranslationSlots(packet, combined);
    if (parsed?.length === origins.length) return parsed;
    onSlotProtocolInvalid?.();
    return translateSlotsIndividually(origins, snapshot, signal, queueSession, context, discourseContext);
}
