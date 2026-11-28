/**
 * @file src/features/video-subtitle/content/youtubeHumanCaptions.ts
 * 文件职责：读取 YouTube 目标语言人工字幕，供现有双语显示与下载优先使用。
 * 主要内容：在视频、目标语言与开关未变化时先短路已加载/在途/退避状态再扫描页面脚本，并按 (root, id, target, scriptCount) 缓存无人工轨结果以避免重复 JSON.parse；接入 createCaptionFetchBackoff 实现指数退避、429 Retry-After 尊重与 403/404/410 永久停止重试，以统一总时限及字节预算读取并按播放时间二分查询目标语言原始时间轴。
 * 模块边界：网络函数由调用者注入，不切换原生字幕语言、不覆盖原文轨，也不调用翻译服务。
 */
import {chooseTargetHumanCaptionTrack} from './platforms';
import {createCaptionFetchBackoff, type CaptionFetchBackoff} from './retryBackoff';
import {readVideoCaptionText} from './subtitleTransport';
import {buildYoutubeTimedTextUrl, extractYoutubeCaptionTracks, getYoutubeVideoId, parseYoutubeTimedTextResponse, finalizeVideoSubtitleCues, type VideoSubtitleCue} from './youtubeSubtitleData';

export class YoutubeHumanCaptions {
    private contextKey = '';
    private key = '';
    private cues: VideoSubtitleCue[] = [];
    private maximumEnds: number[] = [];
    private controller: AbortController | undefined;
    private readonly backoff: CaptionFetchBackoff;
    private emptyTrackCache: {root: ParentNode; id: string; target: string; scriptCount: number} | undefined;
    private pending: Promise<void> | undefined;
    private requestUrl = '';
    private visibleRevision = 0;
    /** 供原生轨道避免每秒遍历未变化的人工字幕。 */
    get revision(): number { return this.visibleRevision; }
    constructor(
        private readonly request: typeof fetch,
        private readonly onReady: () => void,
        options?: {random?: () => number},
    ) {
        this.backoff = createCaptionFetchBackoff({random: options?.random});
    }

    sync(root: ParentNode, location: Pick<Location, 'hostname' | 'pathname' | 'search'>, target: string, enabled: boolean): void {
        const id = getYoutubeVideoId(location);
        const contextKey = enabled && id ? `${id}:${target}` : '';
        if (contextKey !== this.contextKey) {
            this.clear();
            this.contextKey = contextKey;
        }
        if (!contextKey || this.cues.length || this.pending || !this.backoff.canAttempt()) return;

        const scriptCount = root.querySelectorAll('script').length;
        if (
            this.emptyTrackCache
            && this.emptyTrackCache.root === root
            && this.emptyTrackCache.id === id
            && this.emptyTrackCache.target === target
            && this.emptyTrackCache.scriptCount === scriptCount
        ) {
            return;
        }

        const track = chooseTargetHumanCaptionTrack(extractYoutubeCaptionTracks(root, id), target);
        if (!track) {
            this.emptyTrackCache = {root, id, target, scriptCount};
            this.key = '';
            this.backoff.reset();
            return;
        }
        this.emptyTrackCache = undefined;

        const key = `${id}:${target}:${track.baseUrl}`;
        if (key !== this.key) {
            this.backoff.reset();
            this.key = key;
        }

        let url: URL;
        try { url = new URL(buildYoutubeTimedTextUrl(track)); } catch { return; }
        // 初始化脚本是页面数据；只请求本站的 timedtext，不信任任意 baseUrl。
        if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== '/api/timedtext') return;
        this.requestUrl = url.href;
        const controller = new AbortController();
        this.controller = controller;
        const pending = (async () => {
            try {
                const text = await readVideoCaptionText(url.href, this.request, {credentials: 'include', signal: controller.signal});
                const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(text));
                if (controller.signal.aborted || this.key !== key) return;
                if (!cues.length) throw new Error('人工字幕为空');
                this.backoff.recordSuccess();
                this.cues = cues;
                let maximumEnd = 0;
                this.maximumEnds = cues.map(cue => (maximumEnd = Math.max(maximumEnd, cue.startMs + cue.durationMs)));
                this.visibleRevision += 1;
                this.onReady();
            } catch (error) {
                if (!controller.signal.aborted && this.key === key) this.backoff.recordFailure(error);
            }
        })();
        this.pending = pending;
        void pending.finally(() => { if (this.pending === pending) this.pending = undefined; });
    }

    at(timeMs: number): string {
        if (!Number.isFinite(timeMs)) return '';
        // finalized 时间轴按开始时间排序；二分跳过未来 cue，prefix end 跳过已全部结束的区间。
        // 原生轨批量构建会调用数千次，不能每句重新扫描全长人工字幕。
        let lower = 0, upper = this.cues.length;
        while (lower < upper) {
            const middle = (lower + upper) >>> 1;
            if (this.cues[middle].startMs <= timeMs) lower = middle + 1;
            else upper = middle;
        }
        let active: VideoSubtitleCue | undefined;
        for (let index = lower - 1; index >= 0 && this.maximumEnds[index] > timeMs; index -= 1) {
            const cue = this.cues[index];
            if (active && cue.startMs < active.startMs) break;
            // 同起点保留原有顺序；较新的短 cue 结束后仍可回到较早的有效长 cue。
            if (cue.startMs + cue.durationMs > timeMs) active = cue;
        }
        return active?.text || '';
    }

    ownsUrl(url: string): boolean {
        if (!this.requestUrl) return false;
        try {
            const parsed = new URL(url);
            const base = new URL(this.requestUrl);
            return parsed.origin === base.origin && parsed.pathname === base.pathname
                && parsed.searchParams.get('v') === base.searchParams.get('v')
                && parsed.searchParams.get('lang') === base.searchParams.get('lang')
                && parsed.searchParams.get('kind') === base.searchParams.get('kind')
                && !parsed.searchParams.has('tlang');
        } catch { return false; }
    }

    async ready(): Promise<void> { await this.pending; }

    clear(): void {
        this.controller?.abort();
        this.controller = undefined;
        this.pending = undefined;
        this.contextKey = '';
        this.key = '';
        this.requestUrl = '';
        this.emptyTrackCache = undefined;
        if (this.cues.length) this.visibleRevision += 1;
        this.cues = [];
        this.maximumEnds = [];
        this.backoff.reset();
    }
}
