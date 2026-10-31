/**
 * @file src/features/document-translation/services/translation.ts
 * 文件职责：编排文档片段的批量翻译流程，在固定语言和服务快照下按数量及字符预算拆批，并向调用方持续报告确定性进度。
 * 主要内容：定义进度与逐段提交契约，在本次文档调用中默认启用机器批量或 AI 多段槽请求而不改变全局设置，固定缓存策略并透传至批量和降级请求；在单批请求与重试总预算内尊重 Retry-After，暂时限频时由本任务冻结服务共享冷却派发闸门，自身退避与同伴尚余冷却都计入等待预算；禁用客户端叠加重试，冻结服务单次超时，绝对期限中止请求与等待并拒收迟到结果。按阅读位置变化重排待译片段并复用批次游标，以章节内去重避免重复原文挤占批量预算；构建有界篇章参考并区分人工确认译文，移除服务凭空加入的表情符号，报告真实等待数量。原样返回的专名与短词保留原文，复用已有译文续译，固定文件级上下文；不可恢复故障停止派发但收齐在途成功，显式取消覆盖运行时就绪等待、立即移除监听并禁止迟到提交。
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
    /** 本次任务的缓存策略；不传时沿用翻译客户端偏好，显式重译可关闭且不改写全局配置。 */
    useCache?: boolean;
    signal?: AbortSignal;
    /** 未启用文档退避时透传客户端；启用后由文档统一重试，客户端固定为 0。 */
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
     * 请求失败时按 2、4、8…秒（指数上限 60 秒）退避，服务指定的更长冷却优先；
     * 自身退避及共享冷却均计入 maxWaitMs，共享等待按尚余计时窗口保守计费。
     * maxDurationMs 同时限制单批首次请求、重试请求及退避的总耗时，至少保留服务原有的单次请求预算。
     * 不提供时保持“失败即停止”。sleep 仅供测试替换计时。
     */
    retryBackoff?: {maxWaitMs: number; maxDurationMs?: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>};
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
    /** 透传本次文档任务的缓存策略，包括批量协议降级后的逐段请求。 */
    useCache?: boolean;
    maxRetries?: number;
    /** 当前批次绝对预算的剩余时间，交给客户端限制后台传输。 */
    timeout?: number;
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
    /** 与客户端一致的单次预算；任务开始时冻结，文档总预算不得截短明确的服务设置。 */
    getRequestTimeout?(service: string, batch: boolean): number;
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
            cleanup();
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

interface DocumentTranslationAttempt {
    signal?: AbortSignal;
    timeout?: number;
}

function retryDeadline(options: DocumentTranslationOptions, requestTimeout?: number): number | undefined {
    const duration = options.retryBackoff?.maxDurationMs;
    return Number.isFinite(duration) && duration! > 0 ? Date.now() + Math.max(duration!, requestTimeout ?? 0) : undefined;
}

function documentTimeout(): TranslationRequestError {
    return new TranslationRequestError(serializeTranslationError({
        message: '文档翻译请求及重试已超时，请重试或更换服务', kind: 'timeout', retryable: true,
    }));
}

/** 预算包含真正的请求耗时；即使网关忽略取消，也及时结束等待并观察迟到结算。 */
async function runAttempt<T>(work: (attempt: DocumentTranslationAttempt) => Promise<T>, signal: AbortSignal | undefined, deadlineAt: number, requestTimeout?: number): Promise<T> {
    const startedAt = Date.now();
    const remaining = deadlineAt - startedAt;
    if (remaining <= 0) throw documentTimeout();
    const timeout = Math.min(remaining, requestTimeout ?? remaining);
    // 在同步注册监听器之前拒绝已取消任务，不为它建立子控制器和计时器。
    throwIfAborted(signal);
    const attemptDeadlineAt = Math.min(deadlineAt, startedAt + timeout);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeout);
    let result: T;
    try {
        result = await waitWithAbort(work({signal: controller.signal, timeout}), controller.signal);
        throwIfAborted(signal);
        if (timedOut || Date.now() >= attemptDeadlineAt) {
            timedOut = true;
            controller.abort();
            throw documentTimeout();
        }
    } catch (error) {
        throwIfAborted(signal);
        throw timedOut ? documentTimeout() : error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
    return result;
}

/**
 * 限流和网络抖动多半是暂时的：隔一会儿再试往往就能继续，不必让读者反复手动点“继续翻译”。
 * 复用翻译服务的错误分类，认证、无效模型、缺少配置、暂停与取消不重试，也不消耗等待预算；协议不兼容直接交给有界回退，等待预算用完后抛出最后一次的错误。
 */
async function withRetryBackoff<T>(work: (attempt: DocumentTranslationAttempt) => Promise<T>, options: DocumentTranslationOptions, isStopped: () => boolean,
    retryStop: AbortSignal, onWaiting: (started: boolean) => void, cooldown: DocumentRetryCooldown, attempt = 1, waited = 0,
    deadlineAt = retryDeadline(options), requestTimeout?: number): Promise<T> {
    const budget = options.retryBackoff?.maxWaitMs ?? 0;
    const cooling = cooldown.wait(budget - waited, deadlineAt);
    if (cooling) {
        onWaiting(true);
        try {waited += await cooling;} finally {onWaiting(false);}
    }
    throwIfAborted(retryStop);
    try {
        return await (deadlineAt === undefined ? work({signal: options.signal}) : runAttempt(work, options.signal, deadlineAt, requestTimeout));
    } catch (error) {
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        const details = serializeTranslationError(error);
        const retryAfterMs = typeof details.retryAfterMs === 'number' && details.retryAfterMs > 0 ? details.retryAfterMs : 0;
        const temporaryCooldown = retryAfterMs > 0 && (details.code === 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE'
            || (details.kind === 'rate-limit' && details.statusCode === 429));
        const remaining = Math.min(budget - waited, deadlineAt === undefined ? Infinity : deadlineAt - Date.now());
        const delayMs = Math.min(Math.max(Math.min(60_000, 2_000 * 2 ** (attempt - 1)), retryAfterMs), remaining);
        if (delayMs <= 0 || untranslatedEcho(error) || invalidAIMultiSegment(error)
            || (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED')
            || retryAfterMs > remaining || (!details.retryable && !temporaryCooldown)) throw error;
        onWaiting(true);
        try {
            options.onRetry?.({attempt, delayMs, reason: getErrorMessage(error)});
            // 服务失败只取消退避等待，不取消已发出的翻译请求；后者的成功结果仍可保留。
            const sleeping = waitWithAbort(options.retryBackoff?.sleep
                ? options.retryBackoff.sleep(delayMs, options.signal)
                : abortableSleep(delayMs, retryStop), retryStop);
            await (details.kind === 'rate-limit' || retryAfterMs > 0 ? cooldown.track(sleeping, delayMs, error) : sleeping);
            waited += delayMs;
            const waitingForPeers = cooldown.wait(budget - waited, deadlineAt);
            if (waitingForPeers) waited += await waitingForPeers;
        } catch (waitingError) {
            throwIfAborted(options.signal);
            if (isStopped()) throw error;
            throw waitingError;
        } finally {onWaiting(false);}
        throwIfAborted(options.signal);
        if (isStopped()) throw error;
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw documentTimeout();
        return withRetryBackoff(work, options, isStopped, retryStop, onWaiting, cooldown, attempt + 1, waited, deadlineAt, requestTimeout);
    }
}

interface DocumentRetryCooldown {
    wait(remaining: number, deadlineAt?: number): Promise<number> | undefined;
    track(sleeping: Promise<void>, delayMs: number, reason: unknown): Promise<void>;
}

/** 只协调当前冻结服务的文档任务；各自计时结束先撤下自己的闸门，再等待其它请求，避免相互等待。 */
function createDocumentRetryCooldown(signal: AbortSignal): DocumentRetryCooldown {
    const waits = new Map<Promise<void>, {sleeping: Promise<void>; delayMs: number; startedAt: number; reason: unknown}>();
    return {
        wait: (remaining, deadlineAt) => !waits.size ? undefined : (async () => {
            let waited = 0;
            while (waits.size) {
                const now = Date.now();
                const current = [...waits.values()].map(entry => ({...entry, delayMs: Math.max(0, entry.delayMs - (now - entry.startedAt))}));
                const longest = current.reduce((left, right) => left.delayMs >= right.delayMs ? left : right);
                if (longest.delayMs > Math.min(remaining - waited, deadlineAt === undefined ? Infinity : deadlineAt - now)) throw longest.reason;
                await waitWithAbort(Promise.all(current.map(entry => entry.sleeping)), signal);
                waited += longest.delayMs;
            }
            return waited;
        })(),
        track: async (sleeping, delayMs, reason) => {
            waits.set(sleeping, {sleeping, delayMs, startedAt: Date.now(), reason});
            try {await sleeping;} finally {waits.delete(sleeping);}
        },
    };
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
        throwIfAborted(options.signal);
        await waitWithAbort(Promise.resolve(gateway.waitUntilReady()), options.signal);
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
        const cacheOptions = options.useCache === undefined ? {} : {useCache: options.useCache};
        const service = options.serviceOverride || gateway.getDefaultService();
        const model = options.modelOverride || gateway.getDefaultModel?.(service);
        const singleRequestTimeout = gateway.getRequestTimeout?.(service, false);
        const batchRequestTimeout = gateway.getRequestTimeout?.(service, true);
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
        const cooldown = createDocumentRetryCooldown(retryStop.signal);
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
            // 同一请求只由一层负责重试，避免客户端重试三次后文档再重复整轮等待。
            const maxRetries = options.retryBackoff ? 0 : options.maxRetries;
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
            const translateSegment = (segment: DocumentSegment, deadlineAt = retryDeadline(options, singleRequestTimeout)) => withRetryBackoff(async attempt => {
                const received = await gateway.translateText(segment.source, context, {
                    ...glossaryOptions, ...cacheOptions, ...discourseOptions(segment, [segment.source]),
                    enableNativeBatch: false, ...attempt, pageContext,
                    serviceOverride: service, modelOverride: model, sourceLanguage, targetLanguage, maxRetries,
                });
                if (typeof received !== 'string' || !received.trim()) throw new Error('翻译服务返回空译文，请重试');
                return received;
            }, options, () => stopped, retryStop.signal, reportRetryWaiting, cooldown, 1, 0, deadlineAt, singleRequestTimeout);
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
                    const requestTimeout = single ? singleRequestTimeout : batchRequestTimeout;
                    const deadlineAt = retryDeadline(options, requestTimeout);
                    try {
                        const result = await withRetryBackoff(async attempt => {
                        const requestOptions: DocumentTranslationRequestOptions = {
                            ...glossaryOptions,
                            ...cacheOptions,
                            ...discourseOptions(batch[0], batch.map(segment => segment.source)),
                            enableNativeBatch: !single,
                            ...attempt,
                            pageContext,
                            serviceOverride: service,
                            modelOverride: model,
                            sourceLanguage,
                            targetLanguage,
                            maxRetries,
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
                        }, options, () => stopped, retryStop.signal, reportRetryWaiting, cooldown, 1, 0, deadlineAt, requestTimeout);
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
                                    translation = await translateSegment(segment, deadlineAt);
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
                        const translation = await translateSegment(segment);
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
