/**
 * @file src/features/video-subtitle/content/translationScheduler.ts
 * 文件职责：限制视频字幕的翻译并发，避免预取字幕挤占当前播放句子的处理机会。
 * 主要内容：按原文合并等待者、提升当前句优先级、限制预取占用；维护 O(1) 等待当前句计数以在两路已满且无当前句待启动或三路全满时跳过队列整理；支持仅丢弃未启动预取（retainPrefetches）及跳转抢占时同时中止在途旧预取（abortPrefetchesNotIn），且不在底层结算前提前归还并发名额。
 * 模块边界：只调度注入的翻译函数，不读取配置、播放器或浏览器消息；调用方管理译文缓存与时间轴。
 */
interface TranslationJob {
    source: string;
    priority: number;
    started: boolean;
    controller: AbortController;
    promise: Promise<string>;
    resolve(value: string): void;
    reject(error: unknown): void;
}

function createSchedulerAbortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export class VideoTranslationScheduler {
    private readonly jobs = new Map<string, TranslationJob>();
    private active = 0;
    private waitingCurrentCount = 0;

    constructor(private readonly translate: (source: string, signal: AbortSignal) => Promise<string>) {}

    request(source: string, prefetch = false): Promise<string> {
        const existing = this.jobs.get(source);
        if (existing && !existing.controller.signal.aborted) {
            if (!prefetch && existing.priority !== 0) {
                existing.priority = 0;
                if (!existing.started) this.waitingCurrentCount += 1;
            }
            this.pump();
            return existing.promise;
        }
        let resolve!: TranslationJob['resolve'];
        let reject!: TranslationJob['reject'];
        const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
        const priority = prefetch ? 1 : 0;
        const job: TranslationJob = {
            source, priority, started: false,
            controller: new AbortController(), promise, resolve, reject,
        };
        if (priority === 0) this.waitingCurrentCount += 1;
        this.jobs.set(source, job);
        this.pump();
        return promise;
    }

    clear(): void {
        const error = createSchedulerAbortError('视频字幕轨道已切换');
        this.waitingCurrentCount = 0;
        for (const job of this.jobs.values()) {
            job.controller.abort();
            job.reject(error);
        }
        this.jobs.clear();
    }

    /** 跳转后移除尚未启动的旧预取，保留当前请求和正在进行的翻译。 */
    retainPrefetches(sources: ReadonlySet<string>): string[] {
        const removed: string[] = [];
        for (const [source, job] of this.jobs) {
            if (job.started || job.priority === 0 || sources.has(source)) continue;
            const error = createSchedulerAbortError('字幕已离开预翻译窗口');
            job.controller.abort();
            job.reject(error);
            this.jobs.delete(source);
            removed.push(source);
        }
        return removed;
    }

    /** 跳转抢占：立即移除未启动旧预取，并向在途旧预取发送 abort 信号以尽快释放底层请求；返回所有已中止的键。 */
    abortPrefetchesNotIn(sources: ReadonlySet<string>): string[] {
        const aborted: string[] = [];
        for (const [source, job] of this.jobs) {
            if (job.priority === 0 || sources.has(source)) continue;
            job.controller.abort();
            aborted.push(source);
            if (!job.started) {
                const error = createSchedulerAbortError('字幕已离开预翻译窗口');
                job.reject(error);
                this.jobs.delete(source);
            }
        }
        return aborted;
    }

    private pump(): void {
        if (this.active >= 3) return;
        if (this.active >= 2 && this.waitingCurrentCount === 0) return;
        const waiting = [...this.jobs.values()].filter(job => !job.started)
            .sort((a, b) => a.priority - b.priority);
        for (const job of waiting) {
            // 预取最多占两路，第三路留给当前字幕；总在途任务也严格限制为三路。
            if (this.active >= (job.priority === 0 ? 3 : 2)) break;
            job.started = true;
            if (job.priority === 0) this.waitingCurrentCount -= 1;
            this.active += 1;
            void Promise.resolve().then(() => {
                if (job.controller.signal.aborted) throw createSchedulerAbortError('字幕翻译已取消');
                return this.translate(job.source, job.controller.signal);
            }).then(job.resolve, (error) => {
                job.reject(job.controller.signal.aborted ? createSchedulerAbortError('字幕翻译已取消') : error);
            }).finally(() => {
                this.active -= 1;
                if (this.jobs.get(job.source) === job) this.jobs.delete(job.source);
                this.pump();
            });
        }
    }
}
