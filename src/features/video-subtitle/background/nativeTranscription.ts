/**
 * @file src/features/video-subtitle/background/nativeTranscription.ts
 * 文件职责：将字幕采集的 PCM 音频提交到本机 vLLM 标准转写接口。
 * 主要内容：限制回环地址，封装 WAV，约束响应大小，并处理取消与超时。
 * 模块边界：只执行传输；不启动服务或加载模型，不持有字幕会话，不推断字级时间戳或推理设备。
 */
import {normalizeNativeAsrBaseUrl} from '@/src/core/config/nativeAsr';
import type {VideoTranscriptionResult} from '@/src/core/messaging/video';
import {abortErrorFromSignal, cancelResponseReader, cancelUnreadResponseBody, createRuntimeAbortContext} from '@/src/platform/http/runtime';

const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = 30 * SAMPLE_RATE * 2;
const MAX_RESPONSE_BYTES = 128 * 1024;
export const NATIVE_QWEN_ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B';

export interface NativeTranscriptionOptions {
    baseUrl: string;
    signal: AbortSignal;
    sourceLanguage?: string;
}

function endpoint(baseUrl: string): string {
    const normalized = normalizeNativeAsrBaseUrl(baseUrl);
    if (!normalized) {
        throw new Error('原生转写地址必须是本机回环地址，不接受凭据、远程地址或额外路径');
    }
    return `${normalized}/v1/audio/transcriptions`;
}

function pcmWav(encoded: string): {blob: Blob; durationMs: number} {
    if (!encoded || encoded.length > Math.ceil(MAX_PCM_BYTES / 3) * 4
        || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error('原生转写需要不超过30秒的16kHz单声道PCM16数据');
    }
    const pcm = atob(encoded);
    // The encoded-length bound above already implies 0 < pcm.length <= MAX_PCM_BYTES.
    if (pcm.length % 2 || btoa(pcm) !== encoded) {
        throw new Error('原生转写PCM16数据无效');
    }
    const bytes = new Uint8Array(44 + pcm.length);
    const header = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    header.setUint32(4, pcm.length + 36, true);
    ascii(8, 'WAVEfmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, SAMPLE_RATE, true);
    header.setUint32(28, SAMPLE_RATE * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    ascii(36, 'data');
    header.setUint32(40, pcm.length, true);
    for (let i = 0; i < pcm.length; i++) bytes[44 + i] = pcm.charCodeAt(i);
    return {blob: new Blob([bytes], {type: 'audio/wav'}), durationMs: pcm.length / (SAMPLE_RATE * 2) * 1000};
}

async function responseText(response: Response): Promise<string> {
    if (!response.body) throw new Error('原生转写响应为空');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let size = 0;
    let text = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error('原生转写响应超过大小限制');
            text += decoder.decode(value, {stream: true});
        }
        text += decoder.decode();
    } catch (error) {
        cancelResponseReader(reader);
        throw error;
    }
    reader.releaseLock();
    return text;
}

/** Input: canonical base64 of mono 16000Hz PCM16LE. Duration is derived from input bytes.
 * Settling closes the client body; it is not proof that remote model computation has stopped. */
export async function transcribeNativeQwenPcm16(
    encoded: string,
    options: NativeTranscriptionOptions,
): Promise<VideoTranscriptionResult> {
    if (options.signal.aborted) throw abortErrorFromSignal(options.signal);
    const url = endpoint(options.baseUrl);
    const language = options.sourceLanguage?.trim();
    if (language && language !== 'auto' && !/^[a-z]{2}$/.test(language)) {
        throw new Error('原生转写源语言必须是ISO 639-1代码或auto');
    }
    const {blob, durationMs} = pcmWav(encoded);
    const form = new FormData();
    form.append('file', blob, 'audio.wav');
    form.append('model', NATIVE_QWEN_ASR_MODEL);
    form.append('response_format', 'json');
    form.append('stream', 'false');
    if (language && language !== 'auto') form.append('language', language);
    const abort = createRuntimeAbortContext(90_000, options.signal);
    let transcription: VideoTranscriptionResult;
    try {
        // Local audio requires native Fetch redirect/credential semantics, not a userscript transport.
        const response = await globalThis.fetch(url, {
            method: 'POST', body: form, signal: abort.signal,
            credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw new Error(`原生转写服务返回HTTP ${response.status}`);
        }
        const result: unknown = JSON.parse(await responseText(response));
        if (abort.signal.aborted) throw abortErrorFromSignal(abort.signal);
        if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
            throw new Error('原生转写响应缺少text字符串');
        }
        // Standard Qwen ASR JSON supplies text only, not word timing or device evidence.
        transcription = {text: result.text, model: NATIVE_QWEN_ASR_MODEL, audioDurationMs: durationMs};
    } catch (error) {
        if (abort.didTimeout()) throw new Error('原生转写超时');
        if (abort.signal.aborted) throw abortErrorFromSignal(abort.signal);
        throw error;
    } finally {
        abort.cleanup();
    }
    return transcription;
}
