/**
 * @file src/features/video-subtitle/content/hlsAudioRuntime.ts
 * 文件职责：将当前 X 视频的 HLS 音轨或完整 MP4 接入浏览器音频解码，为完整字幕提供 16 kHz PCM。
 * 主要内容：按已确认的媒体身份选择候选，优先音频主清单并恢复元数据中的低码率 MP4，对发现、读取、解码失败进行有界重试，校验音轨时长并解码为单声道 PCM。
 * 模块边界：不修改用户 video 的播放状态；解码资源仅属于本次读取，页面切换或取消后必须释放。
 */
import {hasMp4AudioTrack, isXMediaUrl, readBoundedMediaResponse, readXHlsAudio} from './hlsAudio';
import {isXVideoMediaVariantUrl} from './xVideoSubtitleData';
import {resampleToWhisperAudio} from '../transcription';
import {buildVideoAiSubtitleVideoKey, type VideoAiSubtitleCacheSource} from '../transcriptionCache';

export class XHlsAudioReader {
    private readonly manifests = new Map<string, string>();
    private readonly media = new Map<string, number>();

    rememberMedia(url: string, bitrate?: unknown): void {
        if (!isXVideoMediaVariantUrl(url)) return;
        this.media.set(url, typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0 ? bitrate : Infinity);
        if (this.media.size > 96) this.media.delete(this.media.keys().next().value!);
    }

    remember(url: string, text: string): void {
        if (!isXMediaUrl(url) || !/\.m3u8(?:\?|$)/i.test(url)
            || text.length > 1_000_000 || !text.trim().startsWith('#EXTM3U')) return;
        this.manifests.set(url, text);
        if (this.manifests.size > 16) this.manifests.delete(this.manifests.keys().next().value!);
    }

    reset(): void { this.manifests.clear(); this.media.clear(); }

    private async recoverManifest(urls: string[], signal: AbortSignal): Promise<void> {
        if (urls.every(url => this.manifests.has(url))) return;
        const scope = new AbortController();
        const abort = () => scope.abort();
        signal.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(abort, 5000);
        try {
            const pending = urls.slice(-6).reverse().filter(url => !this.manifests.has(url));
            let index = 0;
            const worker = async () => {
                while (index < pending.length && !scope.signal.aborted) {
                    const url = pending[index++];
                    try {
                        const response = await fetch(url, {signal: scope.signal, credentials: 'omit'});
                        const bytes = await readBoundedMediaResponse(response, 1_000_000, scope.signal);
                        if (scope.signal.aborted) return;
                        this.remember(url, new TextDecoder().decode(bytes));
                    } catch {
                        // 两路发现让一个旧 URL 卡住时，其他当前媒体清单仍有机会恢复。
                    }
                }
            };
            await Promise.all([worker(), worker()]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            scope.abort();
        }
    }

    async read(video: HTMLMediaElement, signal: AbortSignal, identity?: VideoAiSubtitleCacheSource): Promise<Float32Array | null> {
        const mediaId = (url: string) => url.match(/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)/)?.[1];
        const identityKey = identity ? buildVideoAiSubtitleVideoKey(identity) : null;
        const sourceId = mediaId(video.currentSrc || video.src) || mediaId((video as HTMLVideoElement).poster)
            || (identityKey?.startsWith('media:') ? identityKey.slice('media:'.length) : undefined);
        // 首页并行预加载多个视频，MSE 地址不能复制。页面桥只捕获 Fetch/XHR
        // 文本响应，浏览器直接加载或 arraybuffer 清单需要从资源时序补读。
        // 有媒体 ID 时只读取这一组；没有 ID 时仍要求唯一候选，避免识别其他帖子。
        const urls = [...new Set([
            ...this.manifests.keys(),
            // 被动时间线里只有一个视频也不能证明属于当前播放器；公开元数据
            // 仅在已有稳定 media ID 时参加选择，缺失身份仍沿用已加载单组规则。
            ...(sourceId ? this.media.keys() : []),
            video.currentSrc || video.src,
            ...performance.getEntriesByType('resource').map(entry => entry.name),
        ])].filter(url => isXMediaUrl(url) && /\.(?:m3u8|mp4)(?:\?|$)/i.test(url)
            && (!sourceId || mediaId(url) === sourceId));
        const groups = new Set(urls.map(url => mediaId(url) || new URL(url).pathname.split('/').slice(0, -1).join('/')));
        if (groups.size !== 1 || signal.aborted) return null;
        await this.recoverManifest(urls.filter(url => /\.m3u8(?:\?|$)/i.test(url)), signal);
        // MSE 只暴露 blob 地址；在唯一媒体组明确时使用已捕获清单，拒绝猜测多个推荐视频。
        const priority = (text: string) => /#EXT-X-MEDIA:.*TYPE=AUDIO/.test(text) ? 0 : /#EXT-X-STREAM-INF:/.test(text) ? 1 : 2;
        const hlsCandidates: [string, string | null][] = [...this.manifests].reverse()
            .filter(([url]) => !sourceId || mediaId(url) === sourceId).sort((a, b) => priority(a[1]!) - priority(b[1]!));
        const mp4Candidates: [string, string | null][] = urls.filter(url => /\.mp4(?:\?|$)/i.test(url))
            .sort((a, b) => (this.media.get(a) ?? Infinity) - (this.media.get(b) ?? Infinity))
            .slice(0, 3).map(url => [url, null]);
        // 一个主清单失败后立即尝试低码率完整媒体，避免两份坏 HLS 连续
        // 耗尽总预算，导致已恢复的 MP4 永远没有执行机会。
        const firstHls = hlsCandidates.shift();
        const firstMp4 = mp4Candidates.shift();
        const candidates = [...(firstHls ? [firstHls] : []), ...(firstMp4 ? [firstMp4] : []), ...hlsCandidates, ...mp4Candidates].slice(0, 6);
        const ids = new Set(candidates.map(([url]) => mediaId(url) || new URL(url).pathname.split('/').slice(0, -1).join('/')));
        if (ids.size !== 1 || signal.aborted) return null;
        // 主清单提供音频 rendition；不能因为高清纯视频子清单更新更晚就优先选择它。
        // 同类清单保留新版本优先，读取或解码失败后继续尝试同媒体的其他清单。
        const scope = new AbortController();
        const abort = () => scope.abort();
        signal.addEventListener('abort', abort, {once: true});
        // 单条 HLS 自带 30 秒上限；外层保留第二条候选的机会，避免第一个
        // 过期/卡住的地址恰好耗尽全部预算，导致 MP4 或备用清单永远无法读取。
        const readTimer = setTimeout(abort, 60_000);
        let context: AudioContext | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelDecode: (() => void) | undefined;
        const close = () => { if (context && context.state !== 'closed') void context.close().catch(() => undefined); };
        signal.addEventListener('abort', close, {once: true});
        scope.signal.addEventListener('abort', close, {once: true});
        try {
            for (const [url, text] of candidates) {
                if (signal.aborted || scope.signal.aborted) return null;
                try {
                    const result = text !== null ? await readXHlsAudio(url, text, scope.signal, fetch)
                        : await this.readMp4(url, video.duration, scope.signal);
                    if (!result || signal.aborted || scope.signal.aborted) continue;
                    if (Number.isFinite(video.duration) && Math.abs(result.durationMs - video.duration * 1000) > 1000) continue;
                    context = new AudioContext({sampleRate: 16_000});
                    const decoded = await Promise.race([
                        context.decodeAudioData(result.bytes.buffer as ArrayBuffer),
                        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('音轨解码超时')), 10_000); }),
                        new Promise<never>((_, reject) => {
                            cancelDecode = () => reject(new Error('音轨解码已取消'));
                            scope.signal.addEventListener('abort', cancelDecode, {once: true});
                        }),
                    ]);
                    if (signal.aborted || scope.signal.aborted) return null;
                    if (decoded.numberOfChannels === 0 || Math.abs(decoded.duration * 1000 - result.durationMs) > 1000) continue;
                    const channels = Array.from({length: decoded.numberOfChannels}, (_, index) => decoded.getChannelData(index));
                    const pcm = resampleToWhisperAudio(channels, decoded.sampleRate, 16_000);
                    if (pcm.length > 0) return pcm;
                } catch {
                    // 下载成功不等于音频可解码；过期、纯视频或不兼容音轨都继续重试。
                } finally {
                    if (timer) clearTimeout(timer);
                    if (cancelDecode) scope.signal.removeEventListener('abort', cancelDecode);
                    cancelDecode = undefined;
                    timer = undefined;
                    close();
                    context = null;
                }
            }
            return null;
        }
        finally {
            if (timer) clearTimeout(timer);
            if (cancelDecode) scope.signal.removeEventListener('abort', cancelDecode);
            clearTimeout(readTimer);
            signal.removeEventListener('abort', abort);
            scope.abort();
            signal.removeEventListener('abort', close);
            scope.signal.removeEventListener('abort', close);
            close();
        }
    }

    private async readMp4(url: string, duration: number, signal: AbortSignal): Promise<{bytes: Uint8Array; durationMs: number} | null> {
        if (signal.aborted || !Number.isFinite(duration) || duration <= 0 || duration > 20 * 60) return null;
        const scope = new AbortController();
        const abort = () => scope.abort();
        signal.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(abort, 20_000);
        try {
            const response = await fetch(url, {signal: scope.signal, credentials: 'omit'});
            const bytes = await readBoundedMediaResponse(response, 32 * 1024 * 1024, scope.signal);
            // 资源时序里同时有只有 moov 的视频初始化 MP4；完整读取也不能
            // 证明存在音频。与 HLS 一样必须先校验真实音轨，再交给浏览器解码。
            return hasMp4AudioTrack(bytes) ? {bytes, durationMs: duration * 1000} : null;
        } catch { return null; }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            scope.abort();
        }
    }
}
