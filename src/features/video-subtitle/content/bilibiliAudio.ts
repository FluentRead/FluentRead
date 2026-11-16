/**
 * @file src/features/video-subtitle/content/bilibiliAudio.ts
 * 文件职责：为 B 站当前分 P 读取独立 DASH 音轨并解码成本地识别 PCM。
 * 主要内容：复用播放器身份桥，限定官方接口和音轨域名，限制时长、体积和等待时间，取消后释放解码器。
 * 模块边界：不修改可见播放器、不读取登录凭据、不上传音频；只读取当前账号可播放的普通视频。
 */
import {captionRecord} from './courseCaptionData';
import {readVideoCaptionText} from './subtitleTransport';
import {readBoundedMediaResponse} from './hlsAudio';
import {resampleToWhisperAudio} from '../transcription';

export function chooseBilibiliAudio(value: unknown): string {
    const audio = captionRecord(captionRecord(value).dash).audio;
    if (!Array.isArray(audio)) throw new Error('当前视频没有可读取的独立音轨');
    // AAC 可由浏览器原生解码；选择较小音轨以控制完整解码内存。
    const candidates = audio.map(captionRecord).filter(item => typeof item.codecs === 'string' && item.codecs.startsWith('mp4a'))
        .sort((a, b) => Number(a.bandwidth) - Number(b.bandwidth));
    for (const item of candidates) {
        const source = item.baseUrl || item.base_url;
        if (typeof source !== 'string') continue;
        try {
            const url = new URL(source);
            if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
                && /(^|\.)(?:bilivideo\.com|bilivideo\.cn|hdslb\.com)$/.test(url.hostname)) return url.href;
        } catch { /* 非法媒体地址不进入网络层。 */ }
    }
    throw new Error('当前视频没有可解码的官方 AAC 音轨');
}

export interface BilibiliAudioPorts {
    fetch: typeof fetch;
    manifest(part: string, signal: AbortSignal): Promise<number>;
    createAudioContext(): AudioContext;
}

export async function readBilibiliAudio(part: string, video: HTMLVideoElement, signal: AbortSignal, ports: BilibiliAudioPorts): Promise<Float32Array> {
    if (!/^(?:BV[\dA-Za-z]{10}|av\d+):[1-9]\d*$/.test(part)) throw new Error('无法确定当前视频分 P');
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 1200) throw new Error('本地 AI 字幕仅支持 20 分钟以内的视频');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.throwIfAborted(); signal.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => controller.abort(new Error('B 站音轨读取超时，请重试')), 90_000);
    let context: AudioContext | undefined;
    try {
        const cid = await ports.manifest(part, controller.signal);
        controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error('无效的视频分 P 身份');
        const id = part.split(':')[0];
        const url = new URL('https://api.bilibili.com/x/player/playurl');
        url.search = new URLSearchParams({cid: String(cid), [id.startsWith('av') ? 'avid' : 'bvid']: id.startsWith('av') ? id.slice(2) : id,
            fnval: '16', fnver: '0', qn: '16', fourk: '0'}).toString();
        const response = captionRecord(JSON.parse(await readVideoCaptionText(url.href, ports.fetch,
            {signal: controller.signal, credentials: 'include', maxBytes: 2_000_000})));
        if (response.code !== 0) throw new Error('无法读取当前视频音轨，请确认视频可播放后重试');
        const audio = chooseBilibiliAudio(response.data);
        const media = await ports.fetch(audio, {signal: controller.signal, credentials: 'omit', referrer: 'https://www.bilibili.com/'});
        const encoded = await readBoundedMediaResponse(media, 48 * 1024 * 1024, controller.signal);
        controller.signal.throwIfAborted();
        context = ports.createAudioContext();
        const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
            const cancel = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', cancel, {once: true});
            context!.decodeAudioData(encoded.slice().buffer).then(resolve, reject)
                .finally(() => controller.signal.removeEventListener('abort', cancel));
        });
        controller.signal.throwIfAborted();
        if (decoded.duration > 1200 || Math.abs(decoded.duration - video.duration) > 2) throw new Error('音轨与当前视频时长不匹配');
        return resampleToWhisperAudio(Array.from({length: decoded.numberOfChannels}, (_, index) => decoded.getChannelData(index)), decoded.sampleRate);
    } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        if (context) void context.close().catch(() => undefined);
    }
}
