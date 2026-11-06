/**
 * @file src/features/video-subtitle/content/youtubeAudioReader.ts
 * 文件职责：独立、有界地读取已验证 YouTube 直达音轨，交付完整 16 kHz 单声道 PCM。
 * 主要内容：拒绝重定向/分段/错误类型与字节数，限制调用等待、输入字节和已解码结果尺寸，校验解码时长、通道及有限采样值，取消/导航丢弃迟到结果并请求关闭资源；浏览器解码内部的分配与执行不可硬限或保证取消。
 * 模块边界：不接触可见 video、不回退到 MediaSource/捕获播放、不记录签名地址；任何底层异常统一为不含 URL 的安全错误。
 */
import {readBoundedMediaResponse} from './hlsAudio';
import {isYoutubeDirectAudioUrl, YOUTUBE_AUDIO_MAX_BYTES, YOUTUBE_AUDIO_MAX_SECONDS, type YoutubeDirectAudio} from './youtubeAudio';
import {resampleToWhisperAudio} from '../transcription';

export const YOUTUBE_AUDIO_CLOSE_WARNING = '[FluentRead] YouTube 音频解码资源关闭失败';
export const YOUTUBE_AUDIO_READ_ERROR = 'YouTube 直达音轨不可读取或不完整，请刷新后重试；不会接管播放器';

export async function readYoutubeDirectAudio(track: YoutubeDirectAudio, signal: AbortSignal, isCurrent: () => boolean): Promise<Float32Array> {
    const scope = new AbortController();
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => scope.abort();
    signal.addEventListener('abort', abort, {once: true});
    // 关闭握手不阻塞结果；单次 scope 的 abort 只调用一次。仅输出固定诊断，不转发异常中的媒体 URL。
    const reportCloseFailure = () => console.warn(YOUTUBE_AUDIO_CLOSE_WARNING);
    const close = () => {
        if (context && context.state !== 'closed') {
            try { void context.close().catch(reportCloseFailure); }
            catch { reportCloseFailure(); }
        }
    };
    scope.signal.addEventListener('abort', close, {once: true});
    const check = () => {
        if (signal.aborted || scope.signal.aborted || !isCurrent()) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
    };
    let rejectCancelled: (() => void) | undefined;
    try {
        check();
        if (!isYoutubeDirectAudioUrl(track.url) || !Number.isSafeInteger(track.bytes) || track.bytes <= 0 || track.bytes > YOUTUBE_AUDIO_MAX_BYTES
            || !Number.isFinite(track.duration) || track.duration <= 0 || track.duration > YOUTUBE_AUDIO_MAX_SECONDS) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
        const cancelled = new Promise<never>((_, reject) => {
            rejectCancelled = () => reject(new Error(YOUTUBE_AUDIO_READ_ERROR));
            scope.signal.addEventListener('abort', rejectCancelled, {once: true});
            timer = setTimeout(abort, 30_000);
        });
        const read = async () => {
            const response = await fetch(track.url, {signal: scope.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'});
            try { check(); }
            catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
            if (response.status !== 200 || response.redirected || response.headers.has('content-range')
                || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== track.mime
                || Number(response.headers.get('content-length')) !== track.bytes) {
                void response.body?.cancel().catch(() => undefined);
                throw new Error(YOUTUBE_AUDIO_READ_ERROR);
            }
            const bytes = await readBoundedMediaResponse(response, track.bytes, scope.signal);
            check();
            if (bytes.length !== track.bytes) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
            context = new AudioContext({sampleRate: 16_000});
            const decoded = await context.decodeAudioData(bytes.buffer as ArrayBuffer);
            check();
            if (![1, 2].includes(decoded.numberOfChannels) || !Number.isFinite(decoded.duration)
                || Math.abs(decoded.duration - track.duration) > .25
                || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate < 8000 || decoded.sampleRate > 192000) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
            const channels = Array.from({length: decoded.numberOfChannels}, (_, index) => decoded.getChannelData(index));
            if (channels.some(channel => Math.abs(channel.length / decoded.sampleRate - track.duration) > .25
                || !channel.length || channel.some(sample => !Number.isFinite(sample) || Math.abs(sample) > 1))) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
            const pcm = resampleToWhisperAudio(channels, decoded.sampleRate, 16_000);
            if (!pcm.length || pcm.length > YOUTUBE_AUDIO_MAX_SECONDS * 16000
                || Math.abs(pcm.length / 16000 - track.duration) > .25) throw new Error(YOUTUBE_AUDIO_READ_ERROR);
            return pcm;
        };
        return await Promise.race([read(), cancelled]).catch(() => { throw new Error(YOUTUBE_AUDIO_READ_ERROR); });
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (rejectCancelled) scope.signal.removeEventListener('abort', rejectCancelled);
        signal.removeEventListener('abort', abort);
        scope.abort();
        scope.signal.removeEventListener('abort', close);
    }
}
