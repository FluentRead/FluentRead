/**
 * @file src/features/document-translation/services/translation.ts
 * 文件职责：编排文档片段的批量翻译流程，在固定语言和服务快照下按数量及字符预算拆批，并向调用方持续报告确定性进度。
 * 主要内容：定义进度与逐段提交契约，在本次文档调用中默认启用机器批量或 AI 多段槽请求而不改变全局设置，按阅读位置标识变化重排待译片段、其余批次复用游标并可收紧单批大小，同时保持数批请求在途、先返回的先提交，以章节内一次去重和游标领取避免重复原文挤占批量预算或反复扫描长文队列，按原生章节和位置构建有界篇章参考并区分人工确认译文，提交前移除服务凭空加入的表情符号，请求失败时可按退避间隔自动重试并报告真实等待数量，被服务原样返回的专名与短词保留原文而不中断全文，复用已有译文继续未完成片段，提供文件解析所有权，固定文件级上下文，透传全局暂停状态、校验批次结果，服务失败后停止派发但收齐在途成功译文，显式取消后立即退出并禁止迟到提交。
 * 模块边界：该层不解析文件、不持久化配置，也不直接绑定具体 provider；上层负责冻结用户设置并注入 gateway，文档结构由 core 提供，网络和缓存语义由应用翻译客户端承担。
 */
import {serializeTranslationError, TranslationRequestError} from '@/src/services/translation/errors';
import {createDiscourseContext, discourseContextLimits, type DiscourseBlock} from '@/src/services/translation/context/discourse';
import type {DocumentSegment} from '@/src/features/document-translation/core/document';

export interface DocumentTranslationProgress {
    completed: number;
    total: number;
}

export interface DocumentTranslationOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    fileName: string;
    /** 原文件摘要或当前会话文件标识；篇章状态仅属于这次任务，不持久化。 */
    materialId?: string;
    pageContext?: string;
    /** 沿用现有 AI 上下文开关；默认不创建篇章状态，也不改变并发。 */
    enableAIContext?: boolean;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    signal?: AbortSignal;
    maxRetries?: number;
    /** 同一文档和语言对下已完成或人工校订的译文；切换服务或模型时仍复用，仅空白位置继续翻译。 */
    initialTranslations?: readonly string[];
    /** 当前阅读会话里经用户编辑确认的片段，历史机器译文不能冒充用户确认。 */
    confirmedTranslationIds?: readonly number[];
    /** 仅本次文档调用生效，默认开启；关闭时逐段请求，不修改网页或全局 AI 多段翻译设置。 */
    batchTranslation?: boolean;
    /** 每次领取下一批之前重排尚未翻译的片段，让阅读器把正在看的页排到前面；返回值必须恰好是传入的那些片段。 */
    prioritize?: (pending: readonly DocumentSegment[]) => readonly DocumentSegment[];
    /** 可选的不可变优先级标识；Object.is 相同时复用剩余顺序，变化时重新排列全部未领取位置（含重复原文）。不提供时仍每批调用 prioritize。 */
    priorityKey?: () => unknown;
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
    /** 正在退避等待的请求数量；并发成功不能把其他请求的等待状态提前清除。 */
    onRetryStateChange?: (state: {waiting: number}) => void;
    /** 首次不可恢复的请求故障立即通知；id 为片段标识，reason 为完整可读提示，在途成功仍可继续提交。 */
    onFailure?: (failure: {id: number; reason: string}) => void;
    onSegment?: (segment: {id: number; translation: string}) => void;
    onProgress?: (progress: DocumentTranslationProgress) => void;
}

export interface DocumentTranslationRequestOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    glossaryContext?: 'document';
    signal?: AbortSignal;
    pageContext: string;
    discourseContext?: string;
    enableAIContext?: boolean;
    /** 文档本次合批开关覆盖全局偏好；逐段及协议降级不能被服务收集窗再次合批。 */
    enableNativeBatch?: boolean;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    maxRetries?: number;
    /** 显式使用翻译客户端已有的 AI 多段槽协议；只有具备该能力的服务批次携带此标记。 */
    aiMultiSegment?: boolean;
    /** 当前文档开启多段时才发送；后台校验入口，免费池按真实线路能力消费槽位。 */
    documentBatch?: boolean;
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
        if (signal?.aborted) {resolve(); return;}
        const finish = () => {clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve();};
        const timer = setTimeout(finish, milliseconds);
        signal?.addEventListener('abort', finish, {once: true});
    });
}

/** 网关或测试 sleep 忽略取消时也及时释放任务；原 Promise 仍被观察，迟到拒绝不会成为未处理异常。 */
function waitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    return new Promise((resolve, reject) => {
        const abort = () => {
            const error = new Error('文档翻译已取消');
            error.name = 'AbortError';
            reject(error);
        };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, {once: true});
        work.then(value => {cleanup(); signal.aborted ? abort() : resolve(value);}, error => {cleanup(); reject(error);});
        if (signal.aborted) {cleanup(); abort();}
    });
}

/**
 * 限流和网络抖动多半是暂时的：隔一会儿再试往往就能继续，不必让读者反复手动点“继续翻译”。
 * 复用翻译服务的错误分类，认证、无效模型、缺少配置、暂停与取消不重试，也不消耗等待预算；协议不兼容直接交给有界回退，等待预算用完后抛出最后一次的错误。
 */
async function withRetryBackoff<T>(work: () => Promise<T>, options: DocumentTranslationOptions, isStopped: () => boolean,
    retryStop: AbortSignal, onWaiting: (started: boolean) => void, attempt = 1, waited = 0): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1), (options.retryBackoff?.maxWaitMs ?? 0) - waited);
        if (delayMs <= 0 || untranslatedEcho(error) || invalidAIMultiSegment(error)
            || (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED')
            || !serializeTranslationError(error).retryable) throw error;
        onWaiting(true);
        try {
            options.onRetry?.({attempt, delayMs, reason: getErrorMessage(error)});
            // 服务失败只取消退避等待，不取消已发出的翻译请求；后者的成功结果仍可保留。
            await waitWithAbort(options.retryBackoff?.sleep
                ? options.retryBackoff.sleep(delayMs, options.signal)
                : abortableSleep(delayMs, retryStop), retryStop);
        } catch (waitingError) {
            throwIfAborted(options.signal);
            if (isStopped()) throw error;
            throw waitingError;
        } finally {onWaiting(false);}
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        return withRetryBackoff(work, options, isStopped, retryStop, onWaiting, attempt + 1, waited + delayMs);
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

/** 原生章节标签变化与显式标题形成局部作用域，以起始片段位置隔离；页码只提供位置，不猜测人物或缩写含义。 */
function documentDiscourseBlocks(segments: readonly DocumentSegment[]): DiscourseBlock[] {
    let section = 'document';
    let chapterLabel: string | undefined;
    return segments.map(segment => {
        const label = segment.contextLabel;
        // 页码只有位置语义：翻到下一页不能让同一人物突然丢掉前文；重复的章节标签也不重复切章。
        const pageLabel = label && /^(?:第\s*\d+\s*页|Page\s+\d+)$/iu.test(label.trim());
        const changedChapter = label && !pageLabel && label !== chapterLabel;
        if (changedChapter || segment.role === 'title' || segment.role === 'heading') section = `section:${segment.id}`;
        if (label && !pageLabel) chapterLabel = label;
        return {id: String(segment.id), section, source: segment.source,
            position: [segment.contextLabel, segment.pathLabel, segment.timeStart, `段落 ${segment.id + 1}`].filter(Boolean).join(' · ')};
    });
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
        const enableAIContext = options.enableAIContext === true;
        const blocks = Object.freeze(documentDiscourseBlocks(segments).map(block => Object.freeze(block)));
        const blockSections = new Map(blocks.map(block => [Number(block.id), block.section]));
        const reuseKeys = new Map(segments.map(segment => [segment.id, JSON.stringify([blockSections.get(segment.id), segment.source])]));
        const reuseKey = ({id}: DocumentSegment) => reuseKeys.get(id)!;
        const segmentById = new Map(segments.map(segment => [segment.id, segment]));
        const discourse = enableAIContext ? createDiscourseContext() : undefined;
        const materialId = options.materialId || context;
        const languageKey = JSON.stringify([sourceLanguage, targetLanguage, service, model, glossaryOptions.glossaryRevision]);
        const prepareDiscourse = (id: number, origins: string[]) => {
            // 同一冻结材料只算一次全文版本；章节焦点移动保留有界译文，读取后文不会退化为前缀参考。
            discourse?.replace(materialId, languageKey, blocks, String(id));
            return discourse?.prepare(String(id), origins, options.signal);
        };
        const confirmed = new Set(options.confirmedTranslationIds);
        if (discourse) {
            // 历史可能已经译完几千段，最多回填状态本身可保存的64对；确认来源优先占用预算。
            const confirmedSegments = segments.filter(segment => confirmed.has(segment.id) && translations[segment.id].trim()).slice(-discourseContextLimits.pairs);
            const previousSegments = segments.filter(segment => !confirmed.has(segment.id) && translations[segment.id].trim());
            const machineBudget = discourseContextLimits.pairs - confirmedSegments.length;
            const seeds = [...(machineBudget ? previousSegments.slice(-machineBudget) : []), ...confirmedSegments];
            for (const segment of seeds) {
                prepareDiscourse(segment.id, [segment.source])?.commit([translations[segment.id]], confirmed.has(segment.id));
            }
        }
        const discourseOptions = (segment: DocumentSegment, origins: string[]) => ({
            ...(options.enableAIContext === undefined ? {} : {enableAIContext}),
            ...(discourse ? {discourseContext: prepareDiscourse(segment.id, origins)!.context} : {}),
        });
        const retryStop = new AbortController();
        let waitingRetries = 0;
        let callbacksActive = true;
        const reportRetryWaiting = (started: boolean) => {
            if (!callbacksActive || options.signal?.aborted) return;
            waitingRetries += started ? 1 : -1;
            options.onRetryStateChange?.({waiting: waitingRetries});
        };
        const abortRetries = () => {
            retryStop.abort();
            if (waitingRetries > 0) {
                waitingRetries = 0;
                options.onRetryStateChange?.({waiting: 0});
            }
        };
        options.signal?.addEventListener('abort', abortRetries, {once: true});
        try {
            let completed = segments.length - pending.length;
            const reportProgress = () => {
                throwIfAborted(options.signal);
                options.onProgress?.({completed, total: segments.length});
            };
            const sources = new Map(segments.map(segment => [segment.id, segment.source]));
            // 同章节原文相同的片段只翻译一次；换章后缩写或人物名可能另有所指，不跨章强行复用。
            const twins = new Map<string, DocumentSegment[]>();
            for (const segment of pending) {
                const key = reuseKey(segment);
                const identical = twins.get(key);
                if (identical) identical.push(segment);
                else twins.set(key, [segment]);
            }
            const commit = (id: number, received: string) => {
                throwIfAborted(options.signal);
                const source = sources.get(id)!;
                const translation = stripInventedPictographs(source, received);
                prepareDiscourse(id, [source])?.commit([translation]);
                for (const {id: twin} of twins.get(reuseKey(segmentById.get(id)!))!) {
                    throwIfAborted(options.signal);
                    translations[twin] = translation;
                    completed += 1;
                    options.onSegment?.({id: twin, translation});
                }
            };
            // 继续未完成的任务时，已有译文的原文直接复用给后面相同的片段，不再请求。
            const known = new Map<string, string>();
            for (const segment of segments) if (translations[segment.id].trim() && !known.has(reuseKey(segment))) known.set(reuseKey(segment), translations[segment.id]);
            for (const segment of pending) if (!translations[segment.id].trim() && known.has(reuseKey(segment))) commit(segment.id, known.get(reuseKey(segment))!);
            reportProgress();

            // 先只保留每个原文的一段，再分配批量字符和数量预算；字幕重复台词和表格重复单元格不会挤成小请求。
            const queuedSources = new Set<string>();
            let queue: DocumentSegment[] = [];
            for (const segment of pending) {
                const key = reuseKey(segment);
                if (translations[segment.id].trim() || queuedSources.has(key)) continue;
                queuedSources.add(key);
                queue.push(segment);
            }
            let cursor = 0;
            let priorityInitialized = false;
            let previousPriorityKey: unknown;
            const nextBatch = (items: number, characters: number): DocumentSegment[] => {
                const priorityKey = options.prioritize ? options.priorityKey?.() : undefined;
                if (options.prioritize && (!priorityInitialized || !options.priorityKey || !Object.is(priorityKey, previousPriorityKey))) {
                    // 阅读位置未变时只移动游标，避免长文档每批重新扫描、校验和排序所有剩余片段。
                    // 同一原文可能同时出现在首尾页：把所有尚未认领的位置交给阅读优先级，再只发送最先选中的代表。
                    const remaining = [...queuedSources].flatMap(source => twins.get(source)!);
                    const ordered = prioritized(remaining, options.prioritize);
                    const seen = new Set<string>();
                    queue = ordered.filter(segment => {
                        const key = reuseKey(segment);
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                    cursor = 0;
                    previousPriorityKey = priorityKey;
                    priorityInitialized = true;
                }
                const taken = takeBatch(queue, cursor, items, characters);
                cursor += taken.length;
                for (const segment of taken) queuedSources.delete(reuseKey(segment));
                return taken;
            };
            const batchTranslation = options.batchTranslation !== false;
            let stopped = false;
            let failure: Error | undefined;
            const stopAfterFailure = (error: unknown, id: number) => {
                if (stopped) return;
                stopped = true;
                const paused = error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED';
                failure = paused
                    ? error : new Error(`第 ${id + 1} 段文档翻译失败：${getErrorMessage(error)}`);
                retryStop.abort();
                if (!paused) options.onFailure?.({id, reason: failure.message});
            };
            const finishWorkers = async (workers: Promise<void>[]) => {
                // 普通故障先收齐已发出的成功结果再交还页面；显式暂停/换文件则不等待不支持取消的网关。
                await waitWithAbort(Promise.all(workers), options.signal);
                throwIfAborted(options.signal);
                if (failure) throw failure;
            };
            // AI 篇章模式保留逐段按序提交，后文才能使用当前任务已完成的前文译法。
            const aiMultiSegment = batchTranslation && !enableAIContext && Boolean(gateway.supportsAIMultiSegment?.(service, model));
            if (batchTranslation && (gateway.supportsBatch(service) || aiMultiSegment)) {
                const itemLimit = boundedLimit(options.batchLimits?.items, BATCH_ITEM_LIMIT);
                const characterLimit = boundedLimit(options.batchLimits?.characters, BATCH_CHARACTER_LIMIT);
                // 同时发出几批请求：先出结果的那一批先显示，整篇的等待时间按并发数缩短；任何一批失败后其余批次不再认领新片段。
                // 一个服务不理解多段槽协议时，本次任务后面的新请求直接逐段，避免每一批都先发送一次注定失败的槽包。
                let singleFallback = false;
                const batchWorker = async () => {
                while (cursor < queue.length && !stopped) {
                    throwIfAborted(options.signal);
                    const single = singleFallback;
                    const batch = nextBatch(single ? 1 : itemLimit, characterLimit);
                    try {
                        const result = await withRetryBackoff(async () => {
                        const requestOptions: DocumentTranslationRequestOptions = {
                            ...glossaryOptions,
                            ...discourseOptions(batch[0], batch.map(segment => segment.source)),
                            enableNativeBatch: !single,
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
                                documentBatch: true,
                                ...(aiMultiSegment ? {aiMultiSegment: true} : {}),
                            },
                        );
                        throwIfAborted(options.signal);
                        // 按请求位置校验，Array.some 会跳过返回数组中的空洞。
                        if (result.length !== batch.length || batch.some((_, index) => typeof result[index] !== 'string' || !result[index].trim())) {
                            throw new Error('翻译服务返回的片段不完整，请重试');
                        }
                        return result;
                        }, options, () => stopped, retryStop.signal, reportRetryWaiting);
                        result.forEach((translation, index) => commit(batch[index].id, translation));
                        reportProgress();
                    } catch (error) {
                        throwIfAborted(options.signal);
                        if (single && untranslatedEcho(error)) {
                            commit(batch[0].id, batch[0].source);
                            reportProgress();
                            continue;
                        }
                        if (stopped) return;
                        if (untranslatedEcho(error) || (aiMultiSegment && invalidAIMultiSegment(error))) {
                            if (invalidAIMultiSegment(error)) singleFallback = true;
                            // 整批里只要有一段被原样返回就会整批报错；逐段重译，仍被原样返回的那几段保留原文。
                            for (const segment of batch) {
                                throwIfAborted(options.signal);
                                if (stopped) return;
                                let translation = segment.source;
                                try {
                                    const received = await gateway.translateText(segment.source, context, {...glossaryOptions, ...discourseOptions(segment, [segment.source]), enableNativeBatch: false, signal: options.signal, pageContext,
                                        serviceOverride: service, modelOverride: model, sourceLanguage, targetLanguage, maxRetries: options.maxRetries});
                                    if (typeof received !== 'string' || !received.trim()) throw new Error('翻译服务返回空译文，请重试');
                                    translation = received;
                                } catch (single) {
                                    throwIfAborted(options.signal);
                                    if (!untranslatedEcho(single)) {
                                        stopAfterFailure(single, segment.id);
                                        return;
                                    }
                                }
                                commit(segment.id, translation);
                                reportProgress();
                            }
                            continue;
                        }
                        stopAfterFailure(error, batch[0].id);
                        return;
                    }
                }
                };
                await finishWorkers(Array.from({length: boundedLimit(options.batchConcurrency, BATCH_CONCURRENCY)}, () => batchWorker()));
                return translations;
            }

            const workerCount = Math.min(enableAIContext ? 1 : BATCH_CONCURRENCY, queue.length);
            const worker = async () => {
                while (!stopped) {
                    throwIfAborted(options.signal);
                    const [segment] = nextBatch(1, Number.POSITIVE_INFINITY);
                    if (!segment) return;

                    try {
                        const translation = await withRetryBackoff(async () => {
                            const received = await gateway.translateText(segment.source, context, {
                                ...glossaryOptions,
                                ...discourseOptions(segment, [segment.source]),
                                enableNativeBatch: false,
                                signal: options.signal,
                                pageContext,
                                serviceOverride: service,
                                modelOverride: model,
                                sourceLanguage,
                                targetLanguage,
                                maxRetries: options.maxRetries,
                            });
                            // 其他 worker 已经失败时不再为这一段重试。
                            if (typeof received !== 'string' || !received.trim()) throw new Error('翻译服务返回空译文，请重试');
                            return received;
                        }, options, () => stopped, retryStop.signal, reportRetryWaiting);
                        // 其他请求失败只能停止下一次领取；当前有效译文仍提交，避免续译重复消耗。
                        throwIfAborted(options.signal);
                        commit(segment.id, translation);
                        reportProgress();
                    } catch (error) {
                        throwIfAborted(options.signal);
                        if (untranslatedEcho(error)) {commit(segment.id, segment.source); reportProgress(); continue;}
                        stopAfterFailure(error, segment.id);
                        return;
                    }
                }
            };

            await finishWorkers(Array.from({length: workerCount}, () => worker()));
            return translations;
        } finally {
            callbacksActive = false;
            options.signal?.removeEventListener('abort', abortRetries);
            discourse?.clear();
        }
    };
}
