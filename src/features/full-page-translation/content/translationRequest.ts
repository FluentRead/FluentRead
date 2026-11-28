/**
 * @file src/features/full-page-translation/content/translationRequest.ts
 * 文件职责：为单次全文翻译会话编排文本槽翻译主入口，协调公式保护、语言预检、篇章语境、合批队列与会话请求复用。
 * 主要内容：对外统一导出配置快照捕获、调用身份、行内代码整句试探、请求缓存清理与 translateTextSlots 入口；在调用时保护三美元公式源码并按语言预检结果回填跳过槽，交由合批队列或单候选执行模块完成翻译。
 * 模块边界：本文件不发现候选、不持有 DOM 翻译状态也不渲染译文；快照与缓存归 requestCache，行内代码试探归 inlineCodeProbe，单候选执行归 slotExecution，跨候选合批归 batchQueue。
 */
import {preparePageDiscourseContext} from '@/src/services/translation/context/pageDiscourse';
import {invalidatePageTranslationSnapshotCache} from '@/src/services/translation/context/browser';
import {servicesType} from '@/src/core/config/catalog';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {getSupplementalLanguageCandidate} from '@/src/core/language/supplement';
import {shouldSkipTranslationWithEvidence} from '@/src/services/translation/languagePreflight';
import {supportsNativeTranslationBatch} from '@/src/services/translation/capabilities';
import {
    createTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';
import {copyFullPageTranslationConfigSnapshot, type FullPageTranslationConfigSnapshot} from './translationConfigSnapshot';
import {
    captureFullPageTranslationConfig,
    clearFullPageTranslationRequestCache,
    createAbortError,
    createRequestCacheKey,
    createSnapshotTranslateOptions,
    getFullPageTranslationCandidateConcurrency,
    getTranslationInvocationIdentity,
    rememberTranslationRequest,
    retireTranslationRequest,
    throwIfAborted,
    waitForCaller,
    waitForTranslationRequest,
    type FullPageTranslationCacheEntry,
    type FullPageTranslationRequestCacheEntry,
    type FullPageTranslationSessionCache,
} from './requestCache';
import {tryTranslateInlineCodeSentence} from './inlineCodeProbe';
import {translateTextSlotsDirectly} from './slotExecution';
import {enqueueTranslationBatchTask, getAIBatchOwnerIdentity} from './batchQueue';

export type {FullPageTranslationConfigSnapshot, PageTranslationConfigOverrides} from './translationConfigSnapshot';
export {
    captureFullPageTranslationConfig,
    clearFullPageTranslationRequestCache,
    createAbortError,
    createSnapshotTranslateOptions,
    getFullPageTranslationCandidateConcurrency,
    getTranslationInvocationIdentity,
    tryTranslateInlineCodeSentence,
    waitForCaller,
    type FullPageTranslationCacheEntry,
    type FullPageTranslationRequestCacheEntry,
    type FullPageTranslationSessionCache,
};

/** 文本槽与整段候选、标题使用同一目标/排除语言判断；是否配置排除语言不改变识别深度。 */
function shouldKeepOriginalSlot(origin: string, snapshot: FullPageTranslationConfigSnapshot): boolean {
    return Boolean(origin.trim())
        && shouldSkipTranslationForTarget(origin, snapshot.targetLanguage, snapshot.excludedLanguages);
}

function restoreSkippedSlots(
    origins: readonly string[],
    translatedIndexes: readonly number[],
    translations: readonly string[],
): string[] {
    if (translations.length !== translatedIndexes.length) return [];
    const result = origins.map((origin) => origin ?? '');
    translatedIndexes.forEach((originIndex, translationIndex) => {
        result[originIndex] = translations[translationIndex] ?? '';
    });
    return result;
}

async function translateTextSlotsInternal(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    forceFailedRequest = false,
    batchOwner?: Element,
    discourseContext?: string,
): Promise<string[]> {
    if (origins.length === 0) return [];
    throwIfAborted(signal);
    // 缓存身份、微任务合批、协议回退与跳过槽回填都必须使用同一次调用的值。
    origins = Array.from(origins);
    snapshot = copyFullPageTranslationConfigSnapshot(snapshot);
    const requestContext = document.title;
    // Codeforces 在 MathJax 排版前使用 $$$...$$$。公式源码留在本地，
    // 只把两侧正文交给现有槽请求；回填不依赖模型保留占位符，也不改宿主 DOM。
    // 仅处理完整的三美元定界符，不把普通价格或未闭合片段猜成公式。
    const formulaPattern = /(?<!\$)\${3}(?!\$)[^$]+?\${3}(?!\$)/gu;
    if (origins.some(origin => /(?<!\$)\${3}(?!\$)[^$]+?\${3}(?!\$)/u.test(origin ?? ''))) {
        const prose: string[] = [];
        const parts = origins.map(origin => {
            const text = origin ?? '';
            const pieces: Array<string | number> = [];
            const addProse = (value: string) => {
                if (!value.trim()) pieces.push(value);
                else {
                    const match = /^(\s*)([\s\S]*?\S)(\s*)$/u.exec(value)!;
                    pieces.push(match[1], prose.length, match[3]);
                    prose.push(match[2]);
                }
            };
            let cursor = 0;
            for (const match of text.matchAll(formulaPattern)) {
                addProse(text.slice(cursor, match.index));
                pieces.push(match[0]);
                cursor = match.index + match[0].length;
            }
            addProse(text.slice(cursor));
            return pieces;
        });
        const translations = await translateTextSlots(prose, snapshot, signal, queueSession, fullPageSession, forceFailedRequest, batchOwner);
        if (translations.length !== prose.length) return [];
        return parts.map(pieces => pieces.map(piece => typeof piece === 'number' ? translations[piece] : piece).join(''));
    }
    let translatedIndexes = origins
        .map((origin, index) => shouldKeepOriginalSlot(origin ?? '', snapshot) ? -1 : index)
        .filter((index) => index >= 0);
    if (translatedIndexes.length === 0) return [...origins];
    // 内部槽包必须绕过 client 检测，因此补充证据只检查组包前的原文。
    // 空槽沿用既有协议，由供应商回传占位，不把它当作语言证据。
    const supplementalIndexes = translatedIndexes.filter(index => getSupplementalLanguageCandidate(origins[index] ?? '') !== undefined);
    if (supplementalIndexes.length > 0) {
        const keepOriginal = await Promise.all(supplementalIndexes.map(index =>
            shouldSkipTranslationWithEvidence(origins[index]!, snapshot.targetLanguage, snapshot.excludedLanguages, signal)));
        throwIfAborted(signal);
        const skipped = new Set(supplementalIndexes.filter((_index, position) => keepOriginal[position]));
        translatedIndexes = translatedIndexes.filter(index => !skipped.has(index));
        if (translatedIndexes.length === 0) return [...origins];
    }
    // 全量路径复用入口自己的快照；只有跳过语言槽时才创建回填所需的子集。
    const requestOrigins = translatedIndexes.length === origins.length
        ? origins
        : translatedIndexes.map((index) => origins[index] ?? '');
    const isAICrossCandidateRequest = snapshot.enableAIMultiSegment
        && !supportsNativeTranslationBatch(snapshot.service)
        && servicesType.isUseAIContext(snapshot.service, snapshot.model)
        && fullPageSession?.active && fullPageSession.allowAIMultiSegment !== false;
    const execute = (
        executionSignal: AbortSignal | undefined,
        executionQueueSession: TranslationQueueSession | undefined,
    ) => {
        const canCombineNativeParagraphs = supportsNativeTranslationBatch(snapshot.service)
            && snapshot.enableNativeBatch !== false
            && fullPageSession?.active && fullPageSession.allowNativeBatch !== false;
        const canCombineAIParagraphs = isAICrossCandidateRequest;
        const request = (canCombineNativeParagraphs || canCombineAIParagraphs)
            ? enqueueTranslationBatchTask(
                requestOrigins,
                snapshot,
                executionSignal,
                executionQueueSession,
                fullPageSession!,
                batchOwner,
                discourseContext,
            )
            : translateTextSlotsDirectly(
                requestOrigins,
                snapshot,
                executionSignal,
                executionQueueSession,
                fullPageSession,
                undefined,
                requestContext,
                discourseContext,
            );
        return translatedIndexes.length === origins.length
            ? request
            : request.then((translations) => restoreSkippedSlots(origins, translatedIndexes, translations));
    };

    // 候选节点会因虚拟列表或前端框架重挂载而更换自己的 AbortSignal。
    // 将相同请求归属到全文会话后，旧候选取消只停止等待，不会终止新候选
    // 正在复用的 provider 请求；会话结束仍会统一中止底层工作。
    if (fullPageSession?.active && fullPageSession.requestSignal) {
        const aiOwnerIdentity = isAICrossCandidateRequest ? getAIBatchOwnerIdentity(batchOwner) : undefined;
        const key = createRequestCacheKey(origins, snapshot, fullPageSession.pageContextGeneration ?? 0, aiOwnerIdentity, discourseContext);
        const failureKey = createRequestCacheKey(origins, snapshot, -1, aiOwnerIdentity, discourseContext);
        const requestCache = fullPageSession.translationRequestCache ??= new Map();
        const failed = requestCache.get(failureKey);
        if (failed) {
            if (!forceFailedRequest) return waitForTranslationRequest(requestCache, failureKey, failed, signal);
            retireTranslationRequest(requestCache, failureKey, failed);
        }
        const cached = requestCache.get(key);
        if (cached) return waitForTranslationRequest(requestCache, key, cached, signal);
        // 每个底层请求保留独立 queue session，避免某次逐槽降级失败时取消
        // 全文会话里其他无关请求；AbortSignal 仍由会话统一持有和结束。
        const requestQueueSession = createTranslationQueueSession();
        fullPageSession.requestQueueSessions?.add(requestQueueSession);
        const requestController = new AbortController();
        fullPageSession.requestControllers?.add(requestController);
        if (fullPageSession.requestSignal.aborted) requestController.abort();
        const result = execute(requestController.signal, requestQueueSession);
        const releaseQueueSession = () => {
            fullPageSession.requestControllers?.delete(requestController);
            fullPageSession.requestQueueSessions?.delete(requestQueueSession);
        };
        void result.then(releaseQueueSession, releaseQueueSession);
        const entry = rememberTranslationRequest(
            fullPageSession,
            key,
            failureKey,
            result,
            origins.length,
            requestController,
            requestQueueSession,
            fullPageSession.retainSettledResults !== false,
            !isAICrossCandidateRequest,
        );
        return waitForTranslationRequest(requestCache, key, entry, signal);
    }

    return execute(signal, queueSession);
}

/** 用候选位置准备篇章证据；失败、取消和正文变更后的迟到结果不会成为参考。 */
export async function translateTextSlots(
    origins: readonly string[], snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal, queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache, forceFailedRequest = false, batchOwner?: Element,
): Promise<string[]> {
    const ticket = batchOwner && snapshot.enableAIContext
        && (servicesType.isUseAIContext(snapshot.service, snapshot.model) || snapshot.compositeAIContext)
        ? preparePageDiscourseContext(batchOwner, origins, JSON.stringify([
            snapshot.service, snapshot.model, snapshot.sourceLanguage, snapshot.targetLanguage,
            snapshot.glossaryRevision, snapshot.glossaryIds,
            ...(snapshot.compositeConnectionFingerprint ? [snapshot.compositeConnectionFingerprint] : []),
        ]), signal, invalidatePageTranslationSnapshotCache) : undefined;
    const result = await translateTextSlotsInternal(origins, snapshot, signal, queueSession,
        fullPageSession, forceFailedRequest, batchOwner, ticket?.context);
    throwIfAborted(signal);
    if (result.length === origins.length) ticket?.commit(result);
    return result;
}
