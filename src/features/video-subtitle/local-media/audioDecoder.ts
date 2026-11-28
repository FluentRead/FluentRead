/**
 * @file src/features/video-subtitle/local-media/audioDecoder.ts
 * 文件职责：使用 Web Audio API 在本机解码本地音视频文件为 16 kHz 单声道 PCM，并按语音停顿切分转写窗口。
 * 主要内容：支持可取消的字节读取与异步解码、严格时长与声道校验、自动关闭临时 AudioContext，并复用既有重采样与停顿对齐算法切片。
 * 模块边界：不上传任何音频数据、不触发模型推理或渲染界面；所有音频上下文和文件读取均支持端口注入以便离线测试。
 */
import {
    normalizeVideoLocalTranscriptionModel,
    resampleToWhisperAudio,
    type VideoLocalTranscriptionModel,
} from '../transcription';
import {measureVideoAiSpeechActivity, VIDEO_AI_SAMPLE_RATE} from '../content/video-ai/audioWindow';
import {findVideoAiPauseBoundary} from '../content/video-ai/speechAlignment';
import {MAX_LOCAL_MEDIA_DURATION_SECONDS} from './mediaValidation';

export interface LocalMediaAudioSource {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LocalMediaDecodePorts {
    decodeAudioData?: (buffer: ArrayBuffer) => Promise<AudioBuffer>;
}

export interface DecodedLocalMediaPcm {
    readonly pcm: Float32Array;
    readonly durationMs: number;
}

export interface LocalMediaPcmWindow {
    readonly startMs: number;
    readonly endMs: number;
    readonly overlapMs: number;
    readonly pcm: Float32Array;
}

const TINY_WINDOW_MS = 10_000;
const STANDARD_WINDOW_MS = 14_000;
const WINDOW_OVERLAP_MS = 1_200;

function createAbortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error('本地音频解码已取消');
    error.name = 'AbortError';
    return error;
}

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError(signal));
        signal.addEventListener('abort', onAbort, {once: true});
        void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function decodeWithWebAudio(buffer: ArrayBuffer): Promise<AudioBuffer> {
    if (typeof globalThis.OfflineAudioContext === 'function') {
        const offline = new globalThis.OfflineAudioContext(1, 1, VIDEO_AI_SAMPLE_RATE);
        return offline.decodeAudioData(buffer);
    }
    const AudioContextClass = globalThis.AudioContext
        || (globalThis as typeof globalThis & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
        throw new Error('当前浏览器不支持 Web Audio 解码');
    }
    const context = new AudioContextClass({sampleRate: VIDEO_AI_SAMPLE_RATE});
    try {
        return await context.decodeAudioData(buffer);
    } finally {
        if (context.state !== 'closed') {
            void context.close().catch(() => undefined);
        }
    }
}

export async function decodeLocalMediaToPcm16k(
    source: LocalMediaAudioSource,
    signal: AbortSignal,
    ports: LocalMediaDecodePorts = {},
): Promise<DecodedLocalMediaPcm> {
    if (signal.aborted) throw createAbortError(signal);
    const buffer = await raceWithAbort(source.arrayBuffer(), signal);
    if (signal.aborted) throw createAbortError(signal);
    if (buffer.byteLength === 0) throw new Error('所选媒体文件为空');

    const decoder = ports.decodeAudioData ?? decodeWithWebAudio;
    const decoded = await raceWithAbort(decoder(buffer), signal);

    if (signal.aborted) throw createAbortError(signal);
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw new Error('媒体文件不包含可识别的音频轨');
    }
    if (decoded.duration > MAX_LOCAL_MEDIA_DURATION_SECONDS) {
        throw new Error('本地离线转写仅支持 20 分钟以内的音视频文件');
    }
    if (decoded.numberOfChannels < 1) {
        throw new Error('媒体文件不包含可识别的音频声道');
    }

    const channels = Array.from({length: decoded.numberOfChannels}, (_, index) => decoded.getChannelData(index));
    const pcm = channels.length === 1 && decoded.sampleRate === VIDEO_AI_SAMPLE_RATE
        ? channels[0].slice()
        : resampleToWhisperAudio(channels, decoded.sampleRate, VIDEO_AI_SAMPLE_RATE);

    if (pcm.length === 0 || !measureVideoAiSpeechActivity(pcm).active) {
        throw new Error('未在媒体文件中检测到有效语音音轨');
    }

    return {
        pcm,
        durationMs: Math.round(pcm.length * 1000 / VIDEO_AI_SAMPLE_RATE),
    };
}

/**
 * 将完整的 16 kHz 单声道 PCM 切片为串行识别窗口；优先在静音停顿处切分并跳过纯数字静音段。
 */
export function sliceLocalMediaWindows(
    pcm: Float32Array,
    model: VideoLocalTranscriptionModel | unknown,
): LocalMediaPcmWindow[] {
    if (pcm.length === 0) return [];
    const totalMs = pcm.length * 1000 / VIDEO_AI_SAMPLE_RATE;
    const windowLengthMs = normalizeVideoLocalTranscriptionModel(model) === 'tiny'
        ? TINY_WINDOW_MS
        : STANDARD_WINDOW_MS;
    const stepMs = windowLengthMs - WINDOW_OVERLAP_MS;
    const windows: LocalMediaPcmWindow[] = [];
    let startMs = 0;
    let overlapMs = 0;

    while (startMs < totalMs - 1) {
        const remainingMs = totalMs - startMs;
        if (remainingMs >= windowLengthMs) {
            const startSample = Math.floor(startMs * VIDEO_AI_SAMPLE_RATE / 1000);
            const fullEndSample = Math.min(pcm.length, Math.ceil((startMs + windowLengthMs) * VIDEO_AI_SAMPLE_RATE / 1000));
            const rawSlice = pcm.subarray(startSample, fullEndSample);
            const pauseMs = findVideoAiPauseBoundary(rawSlice);
            const endMs = startMs + (pauseMs || windowLengthMs);
            const slice = pauseMs
                ? rawSlice.subarray(0, Math.min(rawSlice.length, Math.round(pauseMs * VIDEO_AI_SAMPLE_RATE / 1000)))
                : rawSlice;
            if (measureVideoAiSpeechActivity(slice).active) {
                windows.push({startMs, endMs, overlapMs, pcm: slice});
            }
            startMs += pauseMs || stepMs;
            overlapMs = pauseMs ? 0 : WINDOW_OVERLAP_MS;
        } else {
            const startSample = Math.floor(startMs * VIDEO_AI_SAMPLE_RATE / 1000);
            const slice = pcm.subarray(startSample);
            if (measureVideoAiSpeechActivity(slice).active) {
                windows.push({startMs, endMs: totalMs, overlapMs, pcm: slice});
            }
            break;
        }
    }

    return windows;
}
