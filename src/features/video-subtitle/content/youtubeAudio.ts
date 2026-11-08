/**
 * @file src/features/video-subtitle/content/youtubeAudio.ts
 * 文件职责：保守选择当前 YouTube 视频已公开的完整直达音轨，不解析签名或猜测播放接口。
 * 主要内容：仅选择明示默认音轨或唯一可证实音轨，不读取播放器私有配音选择；复用平衡 JSON 提取，仅接受身份、时长、字节数、音频 MIME 与 googlevideo HTTPS 边界均明确的静态音频格式。
 * 模块边界：不发网络请求、不访问页面私有全局、不改变播放器；签名 URL 只供音频读取器短暂使用，禁止进入日志、缓存身份或模型请求。
 */
import {extractBalancedJson} from './youtubeSubtitleData';

export const YOUTUBE_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const YOUTUBE_AUDIO_MAX_SECONDS = 20 * 60;
export interface YoutubeDirectAudio {
    readonly videoId: string;
    readonly url: string;
    readonly mime: 'audio/mp4' | 'audio/webm';
    readonly bytes: number;
    readonly duration: number;
}

export function youtubeAudioVideoId(location: Pick<Location, 'hostname' | 'pathname' | 'search'>): string {
    if (!/^(?:www\.|m\.)?youtube\.com$/i.test(location.hostname)) return '';
    const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v')
        : location.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})\/?$/)?.[1];
    return typeof id === 'string' && /^[\w-]{11}$/.test(id) ? id : '';
}

export function isYoutubeDirectAudioUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 16384) return false;
    try {
        const url = new URL(value);
        return url.href === value && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
            && /^(?:[a-z0-9-]+\.)*googlevideo\.com$/.test(url.hostname)
            && url.pathname === '/videoplayback' && !url.searchParams.has('range')
            && !url.searchParams.has('sq') && !url.searchParams.has('rn')
            && url.searchParams.get('source') !== 'yt_live_broadcast';
    } catch { return false; }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positiveNumber(value: unknown): number {
    return (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) ? Number(value) : NaN;
}

/** 不把较小码率的另一语言当作默认音轨；判定时也包含 cipher/未知编码音轨，防止过滤后伪造唯一性。 */
function selectAudioTrackFormats(values: unknown[]): Record<string, unknown>[] {
    const audio = values.map(record).filter(format => typeof format.mimeType === 'string' && format.mimeType.startsWith('audio/'));
    if (audio.length === 1 && audio[0].audioTrack === undefined) return audio;
    const ids = new Set<string>(), defaults = new Set<string>(), nonDefaults = new Set<string>();
    for (const format of audio) {
        const track = record(format.audioTrack);
        if (typeof track.id !== 'string' || !/^[\w.-]{1,128}$/.test(track.id)
            || (track.audioIsDefault !== undefined && typeof track.audioIsDefault !== 'boolean')) return [];
        ids.add(track.id);
        if (track.audioIsDefault === true) defaults.add(track.id);
        if (track.audioIsDefault === false) nonDefaults.add(track.id);
    }
    if (defaults.size > 1) return [];
    const selected = defaults.size === 1 ? [...defaults][0] : ids.size === 1 ? [...ids][0] : '';
    if (!selected || nonDefaults.has(selected)) return [];
    return audio.filter(format => record(format.audioTrack).id === selected);
}

/** 每个候选都必须是完整音频文件；init/index range 元数据不代表请求分段，但 OTF/直播清单不属于本路径。 */
export function selectYoutubeDirectAudio(response: unknown, videoId: string): YoutubeDirectAudio | null {
    const root = record(response), details = record(root.videoDetails), streaming = record(root.streamingData);
    const duration = positiveNumber(details.lengthSeconds);
    if (!/^[\w-]{11}$/.test(videoId) || details.videoId !== videoId || details.isLiveContent !== false
        || details.isLive === true || record(root.playabilityStatus).status !== 'OK'
        || !Number.isFinite(duration) || duration <= 0 || duration > YOUTUBE_AUDIO_MAX_SECONDS
        || !Array.isArray(streaming.adaptiveFormats)) return null;
    const candidates: YoutubeDirectAudio[] = [];
    for (const value of selectAudioTrackFormats(streaming.adaptiveFormats)) {
        const format = record(value);
        const mime = format.mimeType === 'audio/mp4; codecs="mp4a.40.2"' ? 'audio/mp4'
            : format.mimeType === 'audio/webm; codecs="opus"' ? 'audio/webm' : '';
        const bytes = positiveNumber(format.contentLength), audioDuration = positiveNumber(format.approxDurationMs) / 1000;
        if (!isYoutubeDirectAudioUrl(format.url) || !mime || format.signatureCipher !== undefined || format.cipher !== undefined
            || format.type !== undefined || format.targetDurationSec !== undefined
            || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > YOUTUBE_AUDIO_MAX_BYTES
            || !Number.isFinite(audioDuration) || audioDuration <= 0 || audioDuration > YOUTUBE_AUDIO_MAX_SECONDS
            || Math.abs(audioDuration - duration) > 1) continue;
        candidates.push({videoId, url: format.url, mime: mime as YoutubeDirectAudio['mime'], bytes, duration: audioDuration});
    }
    return candidates.sort((left, right) => left.bytes - right.bytes)[0] || null;
}

/** 初始化脚本可能在 SPA 中陈旧，缺失当前身份时明确不支持；不借旧页音源，也不重新请求页面。 */
export function discoverYoutubeDirectAudio(root: ParentNode, videoId: string): YoutubeDirectAudio | null {
    for (const script of Array.from(root.querySelectorAll('script')).slice(0, 128)) {
        const source = script.textContent || '';
        if (source.length > 2_000_000) continue;
        const marker = source.indexOf('ytInitialPlayerResponse');
        if (marker < 0) continue;
        const start = source.indexOf('{', marker);
        if (start < 0) continue;
        const json = extractBalancedJson(source, start);
        if (!json) continue;
        try {
            const candidate = selectYoutubeDirectAudio(JSON.parse(json), videoId);
            if (candidate) return candidate;
        } catch { /* 截断或非 JSON 初始化脚本不可成为音源。 */ }
    }
    return null;
}
