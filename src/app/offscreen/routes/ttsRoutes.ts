/**
 * @file src/app/offscreen/routes/ttsRoutes.ts
 *
 * 文件职责：路由 Offscreen 划词朗读播放控制与本地神经网络 TTS 模型准备、状态查询、清理及可取消音频合成消息。
 * 主要内容：提供 createTtsRoutes，校验划词朗读控制发送方同扩展无 tab 身份、串联一次性播放许可握手，并将本地 TTS 音频二进制分块编码为 Base64 与词级句段时间。
 * 模块边界：仅负责 TTS 域消息校验与分派，不直接实例化 Audio 元素或加载推理 Worker。
 */

import {
    isLocalTtsPreparation,
    isLocalTtsStatus,
    parseOffscreenRequest,
    type LocalTtsSerializedAudio,
} from '@/src/core/messaging/offscreen';
import {parseSpeechCues} from '@/src/core/tts/speechProgress';
import {localTtsErrorCode, type LocalTtsAudio} from '@/src/features/local-tts/protocol';
import {OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE} from '@/src/platform/offscreen/client';
import {createSelectionTtsPlaybackAdmission} from '../ttsPlaybackAdmission';
import {
    cancelRequest,
    errorMessage,
    isRecord,
    requiredRequestId,
    requiredString,
    respondWith,
    runCancellableRequest,
    validatedResult,
    type OffscreenMessageDependencies,
    type OffscreenRouteHandler,
    type OffscreenRouteMap,
} from './shared';

function binaryToBase64(value: unknown, operation: string): string {
    const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
    if (!bytes) throw new Error(`${operation}音频结果无效`);
    // 数秒 WAV 即达数十万字节；按块转换避免逐字节拼接字符串，同时不超过函数参数上限。
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function serializeLocalTtsAudio(value: LocalTtsAudio): LocalTtsSerializedAudio {
    const {audio, ...metadata} = value;
    return {
        ...metadata,
        ...(value.timings === undefined ? {} : {timings: parseSpeechCues(value.timings)}),
        audioBase64: binaryToBase64(audio, '本地 TTS 合成'),
    };
}

export function createTtsRoutes(dependencies: OffscreenMessageDependencies): OffscreenRouteMap {
    const ttsAdmission = createSelectionTtsPlaybackAdmission();
    const activeLocalTts = new Map<string, AbortController>();

    const guardedSelectionControl = (handler: OffscreenRouteHandler): OffscreenRouteHandler =>
        (message, sender, sendResponse) => {
            if (dependencies.runtimeId !== undefined
                && (!isRecord(sender) || sender.id !== dependencies.runtimeId || sender.tab !== undefined)) {
                sendResponse({success: false, error: 'TTS 播放控制发送方无效'});
                return true;
            }
            return handler(message, sender, sendResponse);
        };

    return {
        READ_SELECTION_TTS_REVISION: guardedSelectionControl((_message, _sender, sendResponse) => {
            respondWith(async () => ttsAdmission.read(), sendResponse, (snapshot) => ({success: true, ...(snapshot as object)}));
            return true;
        }),
        RESERVE_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => ttsAdmission.reserve(message), sendResponse, (playbackToken) =>
                playbackToken === undefined ? {success: false, conflict: true} : {success: true, playbackToken});
            return true;
        }),
        PLAY_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => {
                // 消费许可与进入真实播放器连续执行；拒绝旧 PLAY 时尚未创建/停止 Audio。
                if (!ttsAdmission.consume(message)) {
                    return {
                        success: false,
                        error: 'TTS 播放许可已失效',
                        errorCode: 'selection-tts-permit-invalid',
                        receiverId: ttsAdmission.read().receiverId,
                    };
                }
                await dependencies.ttsPlayer.play(message);
                return {success: true};
            }, sendResponse, (response) => response);
            return true;
        }),
        STOP_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => {
                ttsAdmission.stop(message);
                return dependencies.ttsPlayer.stop(message);
            }, sendResponse, () => ({success: true}));
            return true;
        }),
        SEEK_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => dependencies.ttsPlayer.seek(message), sendResponse, (seeked) => ({success: true, seeked}));
            return true;
        }),
        PAUSE_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => Boolean(dependencies.ttsPlayer.pause?.(message)), sendResponse, (paused) => ({success: true, paused}));
            return true;
        }),
        RESUME_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => Boolean(await dependencies.ttsPlayer.resume?.(message)), sendResponse, (resumed) => ({success: true, resumed}));
            return true;
        }),
        SET_RATE_SELECTION_TTS: guardedSelectionControl((message, _sender, sendResponse) => {
            respondWith(async () => Boolean(dependencies.ttsPlayer.setRate?.(message)), sendResponse, (updated) => ({success: true, updated}));
            return true;
        }),
        LOCAL_TTS_PREPARE: (message, _sender, sendResponse) => {
            if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
            respondWith(
                () => dependencies.localTts!.prepare(parseOffscreenRequest('LOCAL_TTS_PREPARE', message)),
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isLocalTtsPreparation, '本地 TTS 模型')}),
            );
            return true;
        },
        LOCAL_TTS_STATUS: (_message, _sender, sendResponse) => {
            if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
            respondWith(
                () => dependencies.localTts!.status(),
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isLocalTtsStatus, '本地 TTS 模型状态')}),
            );
            return true;
        },
        LOCAL_TTS_REMOVE_MODEL: (message, _sender, sendResponse) => {
            if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
            respondWith(
                () => dependencies.localTts!.removeModel(parseOffscreenRequest('LOCAL_TTS_REMOVE_MODEL', message)),
                sendResponse,
                () => ({success: true}),
            );
            return true;
        },
        LOCAL_TTS_SYNTHESIZE: (message, _sender, sendResponse) => {
            if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
            let requestId: string;
            try {
                requestId = requiredRequestId(message.requestId);
                if (activeLocalTts.has(requestId)) throw new Error('Offscreen 本地 TTS requestId 正在执行');
                requiredString(message.text, 'text');
                requiredString(message.language, 'language');
                requiredString(message.voice, 'voice');
            } catch (error) {
                sendResponse({success: false, error: errorMessage(error)});
                return true;
            }

            runCancellableRequest(
                activeLocalTts,
                requestId,
                sendResponse,
                '本地 TTS 请求已取消',
                (signal) => dependencies.localTts!.synthesize(parseOffscreenRequest('LOCAL_TTS_SYNTHESIZE', message), signal),
                (result) => ({success: true, ...serializeLocalTtsAudio(result), requestId}),
                // 错误码是本地模型不可用的跨消息契约；后台策略据此回退在线朗读。
                (error) => ({success: false, error: errorMessage(error), errorCode: localTtsErrorCode(error), requestId}),
            );
            return true;
        },
        [OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE]: (message, _sender, sendResponse) => {
            cancelRequest(activeLocalTts, message, sendResponse);
            return true;
        },
    };
}
