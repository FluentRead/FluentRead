/**
 * @file src/features/video-subtitle/content/bilibiliAudio.ts
 * 文件职责：为 B 站当前分 P 读取独立 DASH 音轨并解码成本地识别 PCM。
 * 主要内容：复用播放器身份桥，禁止跨站重定向，在下载前核对接口时长，限制体积与等待时间并丢弃迟到解码。
 * 模块边界：不修改可见播放器、不读取登录凭据、不上传音频；只读取当前账号可播放的普通视频。
 */
import {captionRecord, isBilibiliBangumiPart} from './courseCaptionData';
import {readVideoCaptionText} from './subtitleTransport';
import {readBoundedMediaResponse} from './hlsAudio';
import {resampleToWhisperAudio} from '../transcription';
import {VIDEO_AI_SAMPLE_RATE} from './video-ai/audioWindow';

const MAX_BILIBILI_AUDIO_SECONDS = 20 * 60;

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
    decode(audio: ArrayBuffer): Promise<AudioBuffer>;
}

export async function readBilibiliAudio(part: string, video: HTMLMediaElement, signal: AbortSignal, ports: BilibiliAudioPorts): Promise<Float32Array> {
    const bangumi = isBilibiliBangumiPart(part);
    if (!bangumi && !/^(?:BV[\dA-Za-z]{10}|av\d+):[1-9]\d*$/.test(part)) throw new Error('无法确定当前视频分 P');
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_BILIBILI_AUDIO_SECONDS) throw new Error('本地 AI 字幕仅支持 20 分钟以内的视频');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.throwIfAborted(); signal.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => controller.abort(new Error('B 站音轨读取超时，请重试')), 90_000);
    try {
        const cid = await ports.manifest(part, controller.signal);
        controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error('无效的视频分 P 身份');
        const id = part.split(':')[0];
        const url = new URL(bangumi ? 'https://api.bilibili.com/pgc/player/web/playurl' : 'https://api.bilibili.com/x/player/playurl');
        const idParam = bangumi
            ? {[id.startsWith('ep') ? 'ep_id' : 'season_id']: id.slice(2)}
            : {[id.startsWith('av') ? 'avid' : 'bvid']: id.startsWith('av') ? id.slice(2) : id};
        url.search = new URLSearchParams({cid: String(cid), ...idParam, fnval: '16', fnver: '0', qn: '16', fourk: '0'}).toString();
        const response = captionRecord(JSON.parse(await readVideoCaptionText(url.href,
            (input, init) => ports.fetch(input, {...init, redirect: 'error'}),
            {signal: controller.signal, credentials: 'include', maxBytes: 2_000_000})));
        if (response.code !== 0) throw new Error('无法读取当前视频音轨，请确认视频可播放后重试');
        const payload = bangumi && response.result ? captionRecord(response.result) : captionRecord(response.data);
        if (Boolean(payload.is_drm) || Boolean(payload.drm_tech_type)) {
            throw new Error('当前番剧受 DRM 保护，无法读取独立音轨');
        }
        const declaredDuration = typeof payload.timelength === 'number' ? payload.timelength / 1000 : captionRecord(payload.dash).duration;
        if (typeof declaredDuration !== 'number' || !Number.isFinite(declaredDuration) || declaredDuration <= 0
            || declaredDuration > MAX_BILIBILI_AUDIO_SECONDS || Math.abs(declaredDuration - duration) > 2) {
            throw new Error('接口音轨时长与当前视频不匹配');
        }
        const audio = chooseBilibiliAudio(payload);
        const media = await ports.fetch(audio, {signal: controller.signal, redirect: 'error', credentials: 'omit', referrer: 'https://www.bilibili.com/'});
        const encoded = await readBoundedMediaResponse(media, 48 * 1024 * 1024, controller.signal);
        controller.signal.throwIfAborted();
        const work = ports.decode(encoded.buffer);
        const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
            const cancel = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', cancel, {once: true});
            void work.then(resolve, reject)
                .finally(() => controller.signal.removeEventListener('abort', cancel));
        });
        controller.signal.throwIfAborted();
        if (decoded.duration <= 0 || decoded.duration > MAX_BILIBILI_AUDIO_SECONDS || Math.abs(decoded.duration - video.duration) > 2) {
            throw new Error('音轨与当前视频时长不匹配');
        }
        if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) throw new Error('当前音轨不是单声道或立体声');
        const channels = Array.from({length: decoded.numberOfChannels}, (_, index) => decoded.getChannelData(index));
        if (channels.length === 1 && decoded.sampleRate === VIDEO_AI_SAMPLE_RATE) return channels[0];
        return resampleToWhisperAudio(channels, decoded.sampleRate);
    } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
    }
}
