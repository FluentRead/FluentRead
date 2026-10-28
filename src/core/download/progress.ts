/**
 * @file src/core/download/progress.ts
 * 文件职责：为模型、语言包等按需资源定义统一的下载进度数据、跨上下文消息和展示文字，让各处下载都用同一套真实字节数说话。
 * 主要内容：下载标识与存储键、字节及受控模型来源状态归一化、百分比与体积格式化、多文件和多项下载汇总，以及对连接或来源切换立即通知、对字节分块限频的进度发布器。
 * 模块边界：纯数据与算法，不访问网络、浏览器存储或界面；字节数只能来自真实下载回调，本模块不估算速度，也不按时间推进百分比。
 */

/** 已接收字节与总字节；total 为 0 表示来源没有给出可信的总大小。 */
export interface DownloadProgress {
    loaded: number;
    total: number;
    /** 仅模型下载携带受控来源状态；不传 URL、重定向参数或用户网络信息。 */
    transfer?: ModelDownloadStatus;
}

export interface ModelDownloadStatus {
    source: 'modelscope' | 'huggingface' | 'hf-mirror' | 'other';
    state: 'connecting' | 'receiving';
    attempt: number;
    attempts: number;
}

export const DOWNLOAD_PROGRESS_MESSAGE = 'fluentReadDownloadProgress' as const;
/** content 无权读取受信本地存储，只能向后台查询单项下载的字节进度。 */
export const DOWNLOAD_PROGRESS_QUERY_MESSAGE = 'fluentReadDownloadProgressQuery' as const;
/** 进度只作为跨页面的事件通道写入扩展本地存储；界面只消费变化事件，不把存量值当作“正在下载”。 */
export const DOWNLOAD_PROGRESS_KEY_PREFIX = 'fluentReadDownloadProgress:' as const;

export interface DownloadProgressMessage {
    type: typeof DOWNLOAD_PROGRESS_MESSAGE;
    id: string;
    /** 缺省表示该下载已经结束（成功、失败或取消）。 */
    progress?: DownloadProgress;
}

export const LOCAL_TTS_DOWNLOAD_ID = 'local-tts' as const;

export function videoModelDownloadId(model: string): string {
    return `video-model:${model}`;
}

export function ocrLanguageDownloadId(language: string): string {
    return `ocr-language:${language}`;
}

export function isDownloadProgressId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9:_-]{0,63}$/u.test(value);
}

export function downloadProgressKey(id: string): string {
    return `${DOWNLOAD_PROGRESS_KEY_PREFIX}${id}`;
}

function isByteCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 跨上下文数据不可信：只接受非负有限数值，并保证已接收量不会超过总量。 */
export function normalizeDownloadProgress(value: unknown): DownloadProgress | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const {loaded, total, transfer} = value as Partial<DownloadProgress>;
    if (!isByteCount(loaded) || !isByteCount(total)) return undefined;
    const result: DownloadProgress = {loaded, total: total > 0 ? Math.max(total, loaded) : 0};
    if (transfer && typeof transfer === 'object') {
        const {source, state, attempt, attempts} = transfer;
        if (['modelscope', 'huggingface', 'hf-mirror', 'other'].includes(source) && ['connecting', 'receiving'].includes(state)
            && Number.isSafeInteger(attempt) && Number.isSafeInteger(attempts) && attempt > 0 && attempts >= attempt && attempts <= 8) {
            result.transfer = {source, state, attempt, attempts};
        }
    }
    return result;
}

/** 总大小未知时不给百分比，由界面改用不确定进度条和已下载体积。 */
export function downloadProgressPercent(progress: DownloadProgress): number | undefined {
    return progress.total > 0 ? Math.min(100, Math.floor(progress.loaded * 100 / progress.total)) : undefined;
}

export function formatDownloadBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
}

/** 数字与单位不随界面语言变化：有总量时为“42% · 143 MB / 341 MB”，否则只写已下载体积。 */
export function formatDownloadProgress(progress: DownloadProgress): string {
    const percent = downloadProgressPercent(progress);
    return percent === undefined
        ? formatDownloadBytes(progress.loaded)
        : `${percent}% · ${formatDownloadBytes(progress.loaded)} / ${formatDownloadBytes(progress.total)}`;
}

export interface DownloadFileProgress {
    /** 文件已在本地缓存；能读到大小时计入已完成部分。 */
    cached(bytes?: number): void;
    /** 文件正在接收；换来源重试时 loaded 会从 0 重新开始。 */
    advance(loaded: number, total?: number): void;
    complete(): void;
}

function isKnownSize(value: unknown): value is number {
    return isByteCount(value) && value > 0;
}

/**
 * 把一个任务的多个文件合并成一条进度。尚未开始的文件没有 Content-Length，
 * 这时以任务声明的预计总量为准；全部文件的大小都已知后改用精确合计。
 */
export function createDownloadProgressTracker(
    fileCount: number,
    expectedTotal: number,
    report: (progress: DownloadProgress) => void,
): {file(): DownloadFileProgress; transfer(status: ModelDownloadStatus): void} {
    const files: Array<{loaded: number; total?: number}> = [];
    let transfer: ModelDownloadStatus | undefined;
    const publish = () => {
        const loaded = files.reduce((sum, file) => sum + file.loaded, 0);
        const known = files.reduce((sum, file) => sum + Math.max(file.total ?? 0, file.loaded), 0);
        const sized = files.length >= fileCount && files.every(file => file.total !== undefined);
        report({loaded, total: sized ? known : expectedTotal > 0 ? Math.max(expectedTotal, known) : 0, ...(transfer ? {transfer} : {})});
    };
    return {
        transfer(status) {
            transfer = status;
            publish();
        },
        file() {
            const file: {loaded: number; total?: number} = {loaded: 0};
            files.push(file);
            return {
                cached(bytes) {
                    file.loaded = file.total = isKnownSize(bytes) ? bytes : 0;
                    publish();
                },
                advance(loaded, total) {
                    file.loaded = loaded;
                    file.total = isKnownSize(total) ? total : undefined;
                    publish();
                },
                complete() {
                    file.total = file.loaded;
                    publish();
                },
            };
        },
    };
}

/**
 * 把按顺序进行的几项下载（例如一次识别缺少的多个语言包）合成一个总百分比。
 * 后面的项开始前不知道大小，无法按字节合计；这里每一项等权：未开始计 0，
 * 进行中按自己的真实比例计，结束计完成，总百分比不会因为下一项开始而倒退。
 */
export function createDownloadCompletionSummary(
    ids: readonly string[],
    report: (percent: number) => void,
): (id: string, progress: DownloadProgress | undefined) => void {
    const fractions = new Map(ids.map(id => [id, 0]));
    return (id, progress) => {
        if (!fractions.has(id)) return;
        // 总量未知的进度无法换算比例，保持该项上一次的数值。
        if (progress && progress.total <= 0) return;
        fractions.set(id, progress ? Math.min(1, progress.loaded / progress.total) : 1);
        const completed = [...fractions.values()].reduce((sum, fraction) => sum + fraction, 0);
        report(Math.floor(completed * 100 / fractions.size));
    };
}

export interface DownloadProgressPublisher {
    report(id: string, progress: DownloadProgress): void;
    finish(id: string): void;
    /** 运行一次下载并保证无论成功、失败还是取消都会发出结束通知。 */
    track<T>(id: string, run: (report: (progress: DownloadProgress) => void) => Promise<T>): Promise<T>;
}

/**
 * 网络分块远比界面需要的更新密；同一下载在间隔内只发布一次，
 * 首次进度和结束通知不受限频影响，避免界面停在旧状态。
 */
export function createDownloadProgressPublisher(
    send: (message: DownloadProgressMessage) => void,
    options: {now?: () => number; intervalMs?: number} = {},
): DownloadProgressPublisher {
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? 300;
    const publishedAt = new Map<string, number>();
    const transfers = new Map<string, string | undefined>();
    const publisher: DownloadProgressPublisher = {
        report(id, progress) {
            const at = now();
            const previous = publishedAt.get(id);
            const transfer = JSON.stringify(progress.transfer);
            if (previous !== undefined && at - previous < intervalMs && transfers.get(id) === transfer) return;
            publishedAt.set(id, at);
            transfers.set(id, transfer);
            send({type: DOWNLOAD_PROGRESS_MESSAGE, id, progress: {loaded: progress.loaded, total: progress.total, ...(progress.transfer ? {transfer: progress.transfer} : {})}});
        },
        finish(id) {
            publishedAt.delete(id);
            transfers.delete(id);
            send({type: DOWNLOAD_PROGRESS_MESSAGE, id});
        },
        async track(id, run) {
            try {
                return await run(progress => publisher.report(id, progress));
            } finally {
                publisher.finish(id);
            }
        },
    };
    return publisher;
}

/** 单个外部通知在途时仅保留最新快照；等待超时只释放调用方，不伪称取消传输。 */
export function createCoalescedDownloadNotifier<T>(
    send: (value: T) => Promise<void>, timeoutMs = 1000,
): {notify(value: T): Promise<void>; dispose(): void} {
    let active: Promise<void> | undefined;
    let queued: T | undefined;
    let hasQueued = false;
    let disposed = false;
    const waiters = new Set<() => void>();
    const start = (value: T): Promise<void> => {
        const request = Promise.resolve().then(() => {if (!disposed) return send(value);}).catch(() => undefined);
        active = request;
        void request.then(() => {
            active = undefined;
            if (disposed || !hasQueued) return;
            const latest = queued as T;
            queued = undefined;
            hasQueued = false;
            start(latest);
        });
        return request;
    };
    return {
        notify(value) {
            if (disposed) return Promise.resolve();
            if (active) {queued = value; hasQueued = true; return Promise.resolve();}
            const request = start(value);
            return new Promise<void>((resolve) => {
                let timer: ReturnType<typeof setTimeout>;
                const finish = () => {clearTimeout(timer); waiters.delete(finish); resolve();};
                waiters.add(finish);
                timer = setTimeout(finish, timeoutMs);
                void request.then(finish);
            });
        },
        dispose() {
            disposed = true;
            queued = undefined;
            hasQueued = false;
            for (const finish of waiters) finish();
        },
    };
}
