/**
 * @file src/features/local-tts/background/offscreenAdapter.ts
 * 文件职责：把本地 TTS 的模型管理和合成请求转换为 Offscreen 消息。
 * 主要内容：复用共享消息 DTO 与实际回包校验，为合成请求生成可取消的 requestId 与超时，解码 base64 WAV 音频和校验句段时间，并把失败响应重建为携带稳定 code 的 Error。
 * 模块边界：不读取配置、不操作网页；模型与 Worker 生命周期归 Offscreen TTS 运行时，错误语义以 protocol 中的错误码为准。
 */

import type {InferenceSuccess, InferenceFailure, LocalTtsPreparation, LocalTtsStatus} from '@/src/core/messaging/offscreen';
import {sendOffscreenRequest} from '@/src/platform/offscreen/requests';
import {parseSpeechCues} from '@/src/core/tts/speechProgress';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE} from '@/src/platform/offscreen/client';
import type {LocalTtsAudio} from '../protocol';

function requestId(): string {
    return crypto.randomUUID();
}

function errorMessage(response: InferenceFailure, fallback: string): Error {
    const error = new Error(response.error || fallback);
    if (response.errorCode !== undefined) Object.assign(error, {code: response.errorCode});
    return error;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

export function createLocalTtsOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    return {
        async synthesize(
            text: string,
            language: string,
            voice: string,
            signal?: AbortSignal,
            speed?: number,
        ): Promise<LocalTtsAudio> {
            const id = requestId();
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TTS_SYNTHESIZE',
                requestId: id,
                text,
                language,
                voice,
                ...(speed !== undefined ? {speed} : {}),
            }, {
                signal,
                timeoutMs: 120_000,
                cancelMessage: {type: OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE, requestId: id},
            });
            if (!response.success) {
                throw errorMessage(response, '本地 TTS 合成失败');
            }
            return {
                audio: base64ToArrayBuffer(response.audioBase64),
                ...(response.timings === undefined ? {} : {timings: parseSpeechCues(response.timings)}),
                contentType: 'audio/wav',
                voice: typeof response.voice === 'string' && response.voice ? response.voice : voice,
                backend: response.backend,
            };
        },
        async prepare(keepWarm = false): Promise<InferenceSuccess<LocalTtsPreparation>> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TTS_PREPARE',
                keepWarm,
            }, {timeoutMs: 300_000});
            if (!response.success) throw errorMessage(response, '本地 TTS 模型下载失败');
            return response;
        },
        async status(): Promise<InferenceSuccess<LocalTtsStatus>> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TTS_STATUS',
            }, {timeoutMs: 30_000});
            if (!response.success) throw errorMessage(response, '无法读取本地 TTS 模型状态');
            return response;
        },
        async remove(): Promise<void> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TTS_REMOVE_MODEL',
            }, {timeoutMs: 30_000});
            if (!response.success) throw errorMessage(response, '本地 TTS 模型清除失败');
        },
    };
}

export const localTtsOffscreenAdapter = createLocalTtsOffscreenAdapter();
