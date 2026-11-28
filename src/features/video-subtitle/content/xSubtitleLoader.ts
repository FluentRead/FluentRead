/**
 * @file src/features/video-subtitle/content/xSubtitleLoader.ts
 * 文件职责：为单个 X 播放器加载原生字幕资源，隔离媒体替换前后的网络结果。
 * 主要内容：限制 HLS 资源并发、体积和单资源十五秒等待，选取单一语言且不再截断超过 32 段的子清单；使用有界滑动去重集合（上限 256）避免长视频播放到第 96 段后永久停载；按 URL 记录有界失败指数退避（最多 3 次，永久 HTTP 错误立即停止）同时保持桥接已捕获正文的即时消费；切换媒体与超时释放队列槽，迟到响应不再提交旧字幕。
 * 模块边界：通过注入 fetch 和 cue 回调工作，不查找页面播放器、不持久化字幕也不执行翻译。
 */
import {isXSubtitleResourceUrl, parseXSubtitleResource, selectXSubtitleLanguageResources, type XSubtitleResource} from './xVideoSubtitleData';
import {classifyVideoError, computeBackoffDelayMs} from './retryBackoff';
import {readVideoCaptionText} from './subtitleTransport';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

interface LoadJob { resource: XSubtitleResource; text?: string; generation: number }
interface UrlFailureState { attempts: number; retryAt: number; exhausted: boolean }

const MAX_VISITED_RESOURCES = 256;
const MAX_URL_RETRY_ATTEMPTS = 3;
const URL_RETRY_BASE_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];

export class XSubtitleLoader {
    private generation = 0;
    private controller = new AbortController();
    private readonly visited = new Set<string>();
    private readonly pending = new Map<string, LoadJob>();
    private readonly failures = new Map<string, UrlFailureState>();
    private queue: LoadJob[] = [];
    private active = 0;

    constructor(private readonly options: {
        fetch(url: string, options: {signal: AbortSignal}): Promise<Response>;
        language(): string;
        onCues(url: string, cues: VideoSubtitleCue[]): void;
    }) {}

    reset(): void {
        this.generation += 1;
        this.controller.abort();
        this.controller = new AbortController();
        this.queue = [];
        this.visited.clear();
        this.pending.clear();
        this.failures.clear();
    }

    private recordFailure(url: string, error: unknown): void {
        const classified = classifyVideoError(error);
        const attempts = (this.failures.get(url)?.attempts || 0) + 1;
        const exhausted = classified.category === 'permanent' || attempts >= MAX_URL_RETRY_ATTEMPTS;
        const retryAt = exhausted
            ? Infinity
            : Date.now() + computeBackoffDelayMs(attempts, {
                baseDelaysMs: URL_RETRY_BASE_DELAYS_MS,
                retryAfterMs: classified.retryAfterMs,
                jitterRatio: 0,
            });
        this.failures.delete(url);
        this.failures.set(url, {attempts, retryAt, exhausted});
        if (this.failures.size > MAX_VISITED_RESOURCES) {
            this.failures.delete(this.failures.keys().next().value!);
        }
    }

    load(resource: XSubtitleResource, text?: string): void {
        if (!isXSubtitleResourceUrl(resource.url)) return;
        const hasInlineText = text !== undefined && text.length <= 1_000_000 && text.trim().length > 0;
        if (this.visited.has(resource.url) || this.pending.has(resource.url)) {
            const waiting = this.pending.get(resource.url);
            if (waiting && hasInlineText) waiting.text = text;
            return;
        }
        if (!hasInlineText) {
            const failure = this.failures.get(resource.url);
            if (failure && (failure.exhausted || Date.now() < failure.retryAt)) return;
        }
        this.visited.add(resource.url);
        if (this.visited.size > MAX_VISITED_RESOURCES) {
            this.visited.delete(this.visited.keys().next().value!);
        }
        const job = {resource, text, generation: this.generation};
        this.pending.set(resource.url, job);
        this.queue.push(job);
        this.pump();
    }

    private pump(): void {
        while (this.active < 3 && this.queue.length > 0) {
            const job = this.queue.shift()!;
            this.active += 1;
            void this.run(job, this.controller.signal).catch((error) => {
                // 只允许外部的新资源事件在退避后或桥接回放时重试；旧代错误不能改变新代去重。
                if (job.generation === this.generation) {
                    this.visited.delete(job.resource.url);
                    this.recordFailure(job.resource.url, error);
                }
            }).finally(() => {
                if (this.pending.get(job.resource.url) === job) this.pending.delete(job.resource.url);
                this.active -= 1;
                this.pump();
            });
        }
    }

    private async run(job: LoadJob, signal: AbortSignal): Promise<void> {
        let source = job.text;
        if (source === undefined) {
            try {
                source = await readVideoCaptionText(job.resource.url, this.options.fetch,
                    {signal, credentials: 'omit', maxBytes: 1_000_000});
            } catch (error) {
                if (signal.aborted || job.generation !== this.generation || job.text === undefined) throw error;
                source = job.text;
            }
        }
        signal.throwIfAborted();
        if (source.length > 1_000_000) throw new Error('字幕资源超过大小限制');
        let parsed = parseXSubtitleResource(source, job.resource.url, job.resource.offsetMs);
        // 页面可先获得有效正文，但扩展侧的另一次读取可能返回空或暂不可解析的内容。
        if (!parsed.cues.length && !parsed.resources.length && job.text && job.text !== source) {
            parsed = parseXSubtitleResource(job.text, job.resource.url, job.resource.offsetMs);
        }
        if (!parsed.cues.length && !parsed.resources.length) {
            this.visited.delete(job.resource.url);
            this.recordFailure(job.resource.url, new Error('字幕资源为空或不可解析'));
            return;
        }
        this.failures.delete(job.resource.url);
        if (parsed.cues.length) this.options.onCues(job.resource.url, parsed.cues);
        const languages = parsed.resources.filter(resource => resource.languageCode);
        const resources = languages.length > 0
            ? selectXSubtitleLanguageResources(languages, this.options.language())
            : parsed.resources;
        for (const resource of resources) this.load(resource);
    }
}
