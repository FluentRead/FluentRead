/**
 * @file src/features/video-subtitle/content/xSubtitleLoader.ts
 * 文件职责：为单个 X 播放器加载原生字幕资源，隔离媒体替换前后的网络结果。
 * 主要内容：限制 HLS 资源并发、体积和单资源十五秒等待，选取单一语言；失败后允许外部回放重试，并在请求等待时保留桥接捕获的正文；切换媒体与超时释放队列槽，迟到响应不再提交旧字幕。
 * 模块边界：通过注入 fetch 和 cue 回调工作，不查找页面播放器、不持久化字幕也不执行翻译。
 */
import {isXSubtitleResourceUrl, parseXSubtitleResource, selectXSubtitleLanguageResources, type XSubtitleResource} from './xVideoSubtitleData';
import {readVideoCaptionText} from './subtitleTransport';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

interface LoadJob { resource: XSubtitleResource; text?: string; generation: number }

export class XSubtitleLoader {
    private generation = 0;
    private controller = new AbortController();
    private readonly visited = new Set<string>();
    private readonly pending = new Map<string, LoadJob>();
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
    }

    load(resource: XSubtitleResource, text?: string): void {
        if (!isXSubtitleResourceUrl(resource.url)) return;
        if (this.visited.has(resource.url)) {
            const waiting = this.pending.get(resource.url);
            if (waiting && text !== undefined && text.length <= 1_000_000 && text.trim()) waiting.text = text;
            return;
        }
        if (this.visited.size >= 96) return;
        this.visited.add(resource.url);
        const job = {resource, text, generation: this.generation};
        this.pending.set(resource.url, job);
        this.queue.push(job);
        this.pump();
    }

    private pump(): void {
        while (this.active < 3 && this.queue.length > 0) {
            const job = this.queue.shift()!;
            this.active += 1;
            void this.run(job, this.controller.signal).catch(() => {
                // 只允许外部的新资源事件触发重试；旧代错误不能改变新代去重。
                if (job.generation === this.generation) this.visited.delete(job.resource.url);
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
            return;
        }
        if (parsed.cues.length) this.options.onCues(job.resource.url, parsed.cues);
        const languages = parsed.resources.filter(resource => resource.languageCode);
        const resources = languages.length > 0
            ? selectXSubtitleLanguageResources(languages, this.options.language())
            : parsed.resources;
        for (const resource of resources.slice(0, 32)) this.load(resource);
    }
}
