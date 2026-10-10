/**
 * @file src/features/document-translation/services/translation.ts
 * 文件职责：编排文档片段的批量翻译流程，在固定语言和服务快照下按数量及字符预算拆批，并向调用方持续报告确定性进度。
 * 主要内容：定义进度与逐段提交契约，在本次文档调用中默认启用机器批量或 AI 多段槽请求而不改变全局设置，按阅读位置重排待译片段并可收紧单批大小，同时保持数批请求在途、先返回的先提交，以一次去重和游标领取避免重复原文挤占批量预算或反复扫描长文队列，提交前移除服务凭空加入的表情符号，请求失败时可按退避间隔自动重试并向页面报告原因，被服务原样返回的专名与短词保留原文而不中断全文，复用已有译文继续未完成片段，提供文件解析所有权，固定文件级上下文，透传全局暂停状态、校验批次结果并阻止取消和失败后的迟到提交与继续回退请求。
 * 模块边界：该层不解析文件、不持久化配置，也不直接绑定具体 provider；上层负责冻结用户设置并注入 gateway，文档结构由 core 提供，网络和缓存语义由应用翻译客户端承担。
 */
import {serializeTranslationError, TranslationRequestError} from '@/src/services/translation/errors';
import type {DocumentSegment} from '@/src/features/document-translation/core/document';

export interface DocumentTranslationProgress {
    completed: number;
    total: number;
}

export interface DocumentTranslationOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    fileName: string;
    pageContext?: string;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    signal?: AbortSignal;
    maxRetries?: number;
    /** 同一文档和设置下已完成或人工校订的译文；空白位置继续翻译。 */
    initialTranslations?: readonly string[];
    /** 仅本次文档调用生效，默认开启；关闭时逐段请求，不修改网页或全局 AI 多段翻译设置。 */
    batchTranslation?: boolean;
    /** 每次领取下一批之前重排尚未翻译的片段，让阅读器把正在看的页排到前面；返回值必须恰好是传入的那些片段。 */
    prioritize?: (pending: readonly DocumentSegment[]) => readonly DocumentSegment[];
    /** 收紧单批的片段数与字符数，译文可以更细地逐批显示；只能小于默认上限。 */
    batchLimits?: {items?: number; characters?: number};
    /** 支持批量的服务同时在途的批次数，默认 3；设为 1 即逐批顺序请求。 */
    batchConcurrency?: number;
    /**
     * 请求失败时按 2、4、8…秒（单次不超过 30 秒）退避重试，累计等待不超过 maxWaitMs；
     * 不提供时保持“失败即停止”。sleep 仅供测试替换计时。
     */
    retryBackoff?: {maxWaitMs: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>};
    /** 每次退避开始前通知页面：第几次重试、要等多久、上一次失败的原因。 */
    onRetry?: (retry: {attempt: number; delayMs: number; reason: string}) => void;
    onSegment?: (segment: {id: number; translation: string}) => void;
    onProgress?: (progress: DocumentTranslationProgress) => void;
}

export interface DocumentTranslationRequestOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    glossaryContext?: 'document';
    signal?: AbortSignal;
    pageContext: string;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    maxRetries?: number;
    /** 显式使用翻译客户端已有的 AI 多段槽协议；只有具备该能力的服务批次携带此标记。 */
    aiMultiSegment?: boolean;
}

/**
 * 文档翻译只依赖这一组端口，不读取 WXT storage 或具体 provider。
 * 入口层负责把当前配置、批量能力和翻译客户端注入进来。
 */
export interface DocumentTranslationGateway {
    getGlossaryOptions?(): {glossaryIds?: readonly string[] | null; glossaryRevision?: string};
    waitUntilReady(): PromiseLike<unknown> | unknown;
    getDefaultService(): string;
    getDefaultModel?(service: string): string;
    supportsBatch(service: string): boolean;
    /** AI 多段能力由组合根按服务和固定模型判断，feature 不读取全局 enableAIMultiSegment。 */
    supportsAIMultiSegment?(service: string, model?: string): boolean;
    translateText(
        source: string,
        context: string,
        options: DocumentTranslationRequestOptions,
    ): Promise<string>;
    translateTextBatch(
        sources: string[],
        context: string,
        options: DocumentTranslationRequestOptions,
    ): Promise<string[]>;
}

export type TranslateDocumentSegments = (
    segments: readonly DocumentSegment[],
    options: DocumentTranslationOptions,
) => Promise<string[]>;

export interface DocumentFileLoadRequest {
    /** 旧解析 Promise 完成时必须再次检查，只有当前请求可以提交页面状态。 */
    isCurrent(): boolean;
}

export interface DocumentFileLoadGuard {
    begin(): DocumentFileLoadRequest;
    invalidate(): void;
}

/**
 * 为无法真正中止的 PDF/ePub/DOCX 解析提供最新请求所有权。
 * 新文件或页面重置会推进代次，旧解析仍可自然结束，但不能覆盖较新的文档。
 */
export function createDocumentFileLoadGuard(): DocumentFileLoadGuard {
    let generation = 0;
    return {
        begin() {
            const requestGeneration = ++generation;
            return {isCurrent: () => requestGeneration === generation};
        },
        invalidate() {
            generation += 1;
        },
    };
}

const BATCH_ITEM_LIMIT = 16;
const BATCH_CHARACTER_LIMIT = 3_500;
const BATCH_CONCURRENCY = 3;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error('文档翻译已取消');
        error.name = 'AbortError';
        throw error;
    }
}

/** 从队首取出一批：至少一个片段，其后在数量与字符预算内尽量多取。 */
function takeBatch(queue: readonly DocumentSegment[], start: number, itemLimit: number, characterLimit: number): DocumentSegment[] {
    let end = start;
    let characters = 0;
    while (end < queue.length && (end === start || (end - start < itemLimit && characters + queue[end].source.length <= characterLimit))) {
        characters += queue[end].source.length;
        end += 1;
    }
    return queue.slice(start, end);
}

/** 重排结果只有在与待译片段一一对应时才采用，调用方的失误不能丢失或重复片段。 */
function prioritized(queue: DocumentSegment[], prioritize: NonNullable<DocumentTranslationOptions['prioritize']>): DocumentSegment[] {
    const ordered = prioritize(queue);
    if (!ordered || ordered.length !== queue.length) return queue;
    const known = new Set(queue);
    const unique = new Set(ordered);
    return unique.size === queue.length && ordered.every(segment => known.has(segment)) ? [...ordered] : queue;
}

/**
 * 专名、缩写、单位和表格里的短词译成目标语言后常与原文相同，翻译层会把“原样返回”报告为 UNTRANSLATED_RESPONSE。
 * 对整篇文档来说这不是故障：这类片段保留原文即可，不能让它中断其余几百段的翻译。
 */
function untranslatedEcho(error: unknown): boolean {
    return (error as {code?: unknown} | null)?.code === 'UNTRANSLATED_RESPONSE';
}

/** 多段槽格式不兼容时才降级；限流、认证与传输错误继续原请求的退避或停止策略。 */
function invalidAIMultiSegment(error: unknown): boolean {
    return (error as {code?: unknown} | null)?.code === 'AI_MULTI_SEGMENT_RESPONSE_INVALID';
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve();};
        const timer = setTimeout(finish, milliseconds);
        signal?.addEventListener('abort', finish, {once: true});
    });
}

/**
 * 限流和网络抖动多半是暂时的：隔一会儿再试往往就能继续，不必让读者反复手动点“继续翻译”。
 * 复用翻译服务的错误分类，认证、无效模型、缺少配置、暂停与取消不重试，也不消耗等待预算；协议不兼容直接交给有界回退，等待预算用完后抛出最后一次的错误。
 */
async function withRetryBackoff<T>(work: () => Promise<T>, options: DocumentTranslationOptions, isStopped: () => boolean, attempt = 1, waited = 0): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1), (options.retryBackoff?.maxWaitMs ?? 0) - waited);
        if (delayMs <= 0 || untranslatedEcho(error) || invalidAIMultiSegment(error)
            || (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED')
            || !serializeTranslationError(error).retryable) throw error;
        options.onRetry?.({attempt, delayMs, reason: getErrorMessage(error)});
        await (options.retryBackoff?.sleep ?? abortableSleep)(delayMs, options.signal);
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        return withRetryBackoff(work, options, isStopped, attempt + 1, waited + delayMs);
    }
}

const PICTOGRAPH = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

/**
 * 翻译服务偶尔会把公式残片或乱码“译”成表情符号。原文没有的图形符号不属于译文，提交前移除；
 * 原文本身带有的符号（如 ©、™ 或作者写下的表情）原样保留，清理后为空时保留服务返回的内容。
 */
export function stripInventedPictographs(source: string, translation: string): string {
    const cleaned = translation.replace(PICTOGRAPH, match => source.includes(match) ? match : '');
    return cleaned.trim() ? cleaned : translation;
}

function boundedLimit(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! >= 1 ? Math.min(fallback, Math.floor(value!)) : fallback;
}

function buildDocumentContext(segments: readonly DocumentSegment[], fileName: string, supplied?: string): string {
    if (supplied?.trim()) return supplied.trim().slice(0, 4_000);
    const preview = segments
        .slice(0, 24)
        .map((segment) => segment.source)
        .join('\n')
        .trim();
    return `Document: ${fileName}\n${preview}`.slice(0, 4_000);
}

export function createDocumentSegmentTranslator(
    gateway: DocumentTranslationGateway,
): TranslateDocumentSegments {
    return async (segments, options) => {
        await gateway.waitUntilReady();
        throwIfAborted(options.signal);
        const glossary = gateway.getGlossaryOptions?.();
        const selectedGlossaryIds = options.glossaryIds ?? glossary?.glossaryIds;
        const glossaryOptions = {
            glossaryContext: 'document' as const,
            glossaryIds: selectedGlossaryIds ? [...selectedGlossaryIds] : selectedGlossaryIds,
            glossaryRevision: options.glossaryRevision ?? glossary?.glossaryRevision,
        };

        if (segments.length === 0) return [];
        const translations = new Array<string>(segments.length).fill('');
        segments.forEach(({id}) => { translations[id] = options.initialTranslations?.[id] || ''; });
        const pending = segments.filter(({id}) => !translations[id].trim());
        const context = options.fileName || 'FluentRead 文档';
        const pageContext = buildDocumentContext(segments, context, options.pageContext);
        // 步骤 1：一次文档任务固定语言对，不能被设置页同步更新或用户中途改选污染后续批次。
        const sourceLanguage = options.sourceLanguage;
        const targetLanguage = options.targetLanguage;
        const service = options.serviceOverride || gateway.getDefaultService();
        const model = options.modelOverride || gateway.getDefaultModel?.(service);
        let completed = segments.length - pending.length;
        const reportProgress = () => options.onProgress?.({completed, total: segments.length});
        const sources = new Map(segments.map(segment => [segment.id, segment.source]));
        // 原文完全相同的片段（字幕里重复的台词、表格里重复的单元格）只翻译一次：一处有了译文，其余同时提交，用词也保持一致。
        const twins = new Map<string, DocumentSegment[]>();
        for (const segment of pending) {
            const {source} = segment;
            const identical = twins.get(source);
            if (identical) identical.push(segment);
            else twins.set(source, [segment]);
        }
        const commit = (id: number, received: string) => {
            throwIfAborted(options.signal);
            const source = sources.get(id)!;
            const translation = stripInventedPictographs(source, received);
            for (const {id: twin} of twins.get(source)!) {
                throwIfAborted(options.signal);
                translations[twin] = translation;
                completed += 1;
                options.onSegment?.({id: twin, translation});
            }
        };
        // 继续未完成的任务时，已有译文的原文直接复用给后面相同的片段，不再请求。
        const known = new Map<string, string>();
        for (const {id, source} of segments) if (translations[id].trim() && !known.has(source)) known.set(source, translations[id]);
        for (const {id, source} of pending) if (!translations[id].trim() && known.has(source)) commit(id, known.get(source)!);
        reportProgress();

        // 先只保留每个原文的一段，再分配批量字符和数量预算；字幕重复台词和表格重复单元格不会挤成小请求。
        const queuedSources = new Set<string>();
        let queue: DocumentSegment[] = [];
        for (const segment of pending) {
            if (translations[segment.id].trim() || queuedSources.has(segment.source)) continue;
            queuedSources.add(segment.source);
            queue.push(segment);
        }
        let cursor = 0;
        const nextBatch = (items: number, characters: number): DocumentSegment[] => {
            if (options.prioritize) {
                // 同一原文可能同时出现在首尾页：把所有尚未认领的位置交给阅读优先级，再只发送最先选中的代表。
                const remaining = [...queuedSources].flatMap(source => twins.get(source)!);
                const ordered = prioritized(remaining, options.prioritize);
                const seen = new Set<string>();
                queue = ordered.filter(segment => {
                    if (seen.has(segment.source)) return false;
                    seen.add(segment.source);
                    return true;
                });
                cursor = 0;
            }
            const taken = takeBatch(queue, cursor, items, characters);
            cursor += taken.length;
            for (const segment of taken) queuedSources.delete(segment.source);
            return taken;
        };
        const batchTranslation = options.batchTranslation !== false;
        const aiMultiSegment = batchTranslation && Boolean(gateway.supportsAIMultiSegment?.(service, model));
        if (batchTranslation && (gateway.supportsBatch(service) || aiMultiSegment)) {
            const itemLimit = boundedLimit(options.batchLimits?.items, BATCH_ITEM_LIMIT);
            const characterLimit = boundedLimit(options.batchLimits?.characters, BATCH_CHARACTER_LIMIT);
            // 同时发出几批请求：先出结果的那一批先显示，整篇的等待时间按并发数缩短；任何一批失败后其余批次不再认领新片段。
            let failed = false;
            // 一个服务不理解多段槽协议时，本次任务后面的新请求直接逐段，避免每一批都先发送一次注定失败的槽包。
            let singleFallback = false;
            const batchWorker = async () => {
            while (cursor < queue.length && !failed) {
                throwIfAborted(options.signal);
                const single = singleFallback;
                const batch = nextBatch(single ? 1 : itemLimit, characterLimit);
                try {
                    const result = await withRetryBackoff(async () => {
                    const requestOptions: DocumentTranslationRequestOptions = {
                        ...glossaryOptions,
                        signal: options.signal,
                        pageContext,
                        serviceOverride: service,
                        modelOverride: model,
                        sourceLanguage,
                        targetLanguage,
                        maxRetries: options.maxRetries,
                    };
                    const result = single ? [await gateway.translateText(batch[0].source, context, requestOptions)] : await gateway.translateTextBatch(
                        batch.map((segment) => segment.source),
                        context,
                        {
                            ...requestOptions,
                            ...(aiMultiSegment ? {aiMultiSegment: true} : {}),
                        },
                    );
                    throwIfAborted(options.signal);
                    // 按请求位置校验，Array.some 会跳过返回数组中的空洞。
                    if (result.length !== batch.length || batch.some((_, index) => typeof result[index] !== 'string' || !result[index].trim())) {
                        throw new Error('翻译服务返回的片段不完整，请重试');
                    }
                    return result;
                    }, options, () => failed);
                    if (failed) return;
                    result.forEach((translation, index) => commit(batch[index].id, translation));
                    reportProgress();
                } catch (error) {
                    if (failed) return;
                    throwIfAborted(options.signal);
                    if (single && untranslatedEcho(error)) {
                        commit(batch[0].id, batch[0].source);
                        reportProgress();
                        continue;
                    }
                    if (untranslatedEcho(error) || (aiMultiSegment && invalidAIMultiSegment(error))) {
                        if (invalidAIMultiSegment(error)) singleFallback = true;
                        // 整批里只要有一段被原样返回就会整批报错；逐段重译，仍被原样返回的那几段保留原文。
                        for (const segment of batch) {
                            throwIfAborted(options.signal);
                            let translation = segment.source;
                            try {
                                const received = await gateway.translateText(segment.source, context, {...glossaryOptions, signal: options.signal, pageContext,
                                    serviceOverride: service, modelOverride: model, sourceLanguage, targetLanguage, maxRetries: options.maxRetries});
                                if (typeof received === 'string' && received.trim()) translation = received;
                            } catch (single) {
                                if (failed) return;
                                throwIfAborted(options.signal);
                                if (!untranslatedEcho(single)) {
                                    failed = true;
                                    if (single instanceof TranslationRequestError && single.code === 'TRANSLATION_DISABLED') throw single;
                                    throw new Error(`第 ${segment.id + 1} 段文档翻译失败：${getErrorMessage(single)}`);
                                }
                            }
                            if (failed) return;
                            commit(segment.id, translation);
                            reportProgress();
                        }
                        continue;
                    }
                    failed = true;
                    if (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED') throw error;
                    throw new Error(`第 ${batch[0].id + 1} 段文档翻译失败：${getErrorMessage(error)}`);
                }
            }
            };
            await Promise.all(Array.from({length: boundedLimit(options.batchConcurrency, BATCH_CONCURRENCY)}, () => batchWorker()));
            return translations;
        }

        let stopped = false;
        const workerCount = Math.min(BATCH_CONCURRENCY, queue.length);
        const worker = async () => {
            while (true) {
                throwIfAborted(options.signal);
                const [segment] = nextBatch(1, Number.POSITIVE_INFINITY);
                if (!segment) return;

                try {
                    const translation = await withRetryBackoff(async () => {
                        const received = await gateway.translateText(segment.source, context, {
                            ...glossaryOptions,
                            signal: options.signal,
                            pageContext,
                            serviceOverride: service,
                            modelOverride: model,
                            sourceLanguage,
                            targetLanguage,
                            maxRetries: options.maxRetries,
                        });
                        // 其他 worker 已经失败时不再为这一段重试。
                        if (!stopped && (typeof received !== 'string' || !received.trim())) throw new Error('翻译服务返回空译文，请重试');
                        return received;
                    }, options, () => stopped);
                    // Promise.all 会在首个 worker 失败时立即 reject；其余在途请求仍会稍后结束。
                    // 步骤 1：失败后不再上报过期进度，也不继续认领新的文档片段。
                    if (stopped) return;
                    throwIfAborted(options.signal);
                    commit(segment.id, translation);
                    reportProgress();
                } catch (error) {
                    if (stopped) return;
                    if (!options.signal?.aborted && untranslatedEcho(error)) {commit(segment.id, segment.source); reportProgress(); continue;}
                    stopped = true;
                    if (options.signal?.aborted) throwIfAborted(options.signal);
                    if (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED') throw error;
                    throw new Error(`第 ${segment.id + 1} 段文档翻译失败：${getErrorMessage(error)}`);
                }
            }
        };

        await Promise.all(Array.from({length: workerCount}, () => worker()));
        return translations;
    };
}
