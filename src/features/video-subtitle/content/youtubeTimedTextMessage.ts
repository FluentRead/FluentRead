/**
 * @file src/features/video-subtitle/content/youtubeTimedTextMessage.ts
 * 文件职责：校验 isolated world 收到的 YouTube timedtext 桥消息，只把当前视频的有界字幕数据交给播放器运行时。
 * 主要内容：复验消息协议、页面与请求 URL、当前 videoId、响应体积、cue 数量和单条文本长度，并输出规范化字幕时间轴。
 * 模块边界：本文件不监听 window 消息、不缓存字幕也不操作播放器 DOM；MAIN world 只负责采集，content runtime 负责事件来源校验和消费结果。
 */
import {
    finalizeVideoSubtitleCues,
    getYoutubeVideoId,
    parseYoutubeTimedTextResponse,
    type VideoSubtitleCue,
} from './youtubeSubtitleData';
import {
    isYoutubeTimedTextUrl,
    YOUTUBE_TIMED_TEXT_MESSAGE,
} from './youtubeTimedTextBridgeCore';

const YOUTUBE_HOST_PATTERN = /(^|\.)youtube\.com$/i;

export interface YoutubeTimedTextMessageLimits {
    maxPayloadChars: number;
    maxCues: number;
    maxCueChars: number;
}

export const YOUTUBE_TIMED_TEXT_MESSAGE_LIMITS: Readonly<YoutubeTimedTextMessageLimits> = {
    maxPayloadChars: 4 * 1024 * 1024,
    maxCues: 20_000,
    maxCueChars: 4_096,
};

export interface ValidatedYoutubeTimedTextMessage {
    url: string;
    cues: VideoSubtitleCue[];
}

function isYoutubeVideoUrl(url: URL): boolean {
    return YOUTUBE_HOST_PATTERN.test(url.hostname)
        && (url.pathname === '/watch' || url.pathname.startsWith('/shorts/'));
}

/**
 * 页面脚本也能调用 postMessage，因此 source/origin 不是信任凭据。消费前必须
 * 把桥消息视为不可信输入，并重新绑定到当前页面的 videoId 与资源上限。
 */
export function validateYoutubeTimedTextMessage(
    data: unknown,
    pageHref: string,
    limits: Readonly<YoutubeTimedTextMessageLimits> = YOUTUBE_TIMED_TEXT_MESSAGE_LIMITS,
): ValidatedYoutubeTimedTextMessage | null {
    try {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const payload = data as Record<string, unknown>;
        if (payload.source !== 'fluent-read' || payload.type !== YOUTUBE_TIMED_TEXT_MESSAGE) return null;
        if (typeof payload.url !== 'string' || payload.url.length > 32_768 || typeof payload.responseText !== 'string') return null;
        if (!payload.responseText || payload.responseText.length > limits.maxPayloadChars) return null;

        const pageUrl = new URL(pageHref);
        if (!isYoutubeVideoUrl(pageUrl) || !isYoutubeTimedTextUrl(payload.url, pageHref)) return null;
        const currentVideoId = getYoutubeVideoId({
            hostname: pageUrl.hostname,
            pathname: pageUrl.pathname,
            search: pageUrl.search,
        });
        const requestUrl = new URL(payload.url, pageHref);
        if (!currentVideoId || requestUrl.searchParams.get('v') !== currentVideoId) return null;

        const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(payload.responseText));
        if (cues.length === 0 || cues.length > limits.maxCues) return null;
        if (cues.some((cue) => Array.from(cue.text).length > limits.maxCueChars)) return null;
        return {url: requestUrl.href, cues};
    } catch {
        return null;
    }
}
