/**
 * @file src/features/selection-translation/background/offscreenAdapter.ts
 * 文件职责：适配划词 TTS 的 Offscreen 播放控制（播放、停止、跳转、暂停、继续、变速）与扩展页在线音频获取，把 AbortSignal 和稳定路由身份传到平台边界。
 * 主要内容：定义响应与默认适配器，先读取接收端实例/版本、领取一次性播放许可，再携带取消信号发送 PLAY；支持停止、5 秒跳转、暂停、继续、实时变速及带超时的扩展页 Google 音频下载，并保留服务端 HTTP 错误状态、取消未消费的错误响应体。
 * 模块边界：不合成音频、不创建 Audio 或 Offscreen document；音频解码与播放归调用页面，实际传输由 runtimeFetch 和平台 Offscreen client 执行。
 */
import {cancelUnreadResponseBody, createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {readRetryAfterMs} from '@/src/platform/http/errors';
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {parseSelectionTtsRoute} from '@/src/features/selection-translation/protocol';
import type {
    SelectionTtsPlaybackRequest,
    SelectionTtsRoute,
} from '@/src/features/selection-translation/protocol';
import {
    type OffscreenClient,
} from '@/src/platform/offscreen/client';

const PAGE_AUDIO_FETCH_TIMEOUT_MS = 10_000;

interface SelectionTtsOffscreenResponse {
    readonly success?: boolean;
    readonly error?: string;
    readonly seeked?: boolean;
    readonly paused?: boolean;
    readonly resumed?: boolean;
    readonly updated?: boolean;
    readonly revision?: string;
    readonly playbackToken?: string;
    readonly conflict?: boolean;
    readonly receiverId?: string;
    readonly errorCode?: string;
}

/** TTS 消息始终携带 {tabId, clientRequestId}，不依赖可重启 worker 的内存。 */
export function createSelectionTtsOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    return {
        async fetchPageAudio(url: string, signal: AbortSignal): Promise<{audio: ArrayBuffer; contentType: string}> {
            const abort = createRuntimeAbortContext(PAGE_AUDIO_FETCH_TIMEOUT_MS, signal);
            try {
                const response = await runtimeFetch(url, {signal: abort.signal});
                if (!response.ok) {
                    cancelUnreadResponseBody(response);
                    const retryAfterMs = readRetryAfterMs(response.headers);
                    throw Object.assign(
                        new Error(`Google TTS failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`),
                        {statusCode: response.status, ...(retryAfterMs ? {retryAfterMs} : {})},
                    );
                }
                return {audio: await response.arrayBuffer(), contentType: response.headers.get('content-type') || 'audio/mpeg'};
            } finally {
                abort.cleanup();
            }
        },
        async play(payload: SelectionTtsPlaybackRequest, signal?: AbortSignal): Promise<void> {
            const route = parseSelectionTtsRoute(payload);
            const options = {signal, cancelMessage: {type: 'STOP_SELECTION_TTS', ...route}};
            const checkCancelled = () => {
                if (!signal?.aborted) return;
                const error = new Error('Offscreen 请求已取消');
                error.name = 'AbortError';
                throw error;
            };
            // READ 无副作用；RESERVE 是 compare-and-swap，STOP/新许可会推进版本。
            // 不保存 cancelled UUID 列表。总共最多尝试三次；取消后绝不重领。
            for (let attempt = 0; attempt < 3; attempt += 1) {
                checkCancelled();
                const snapshot = await client.send<SelectionTtsOffscreenResponse>({type: 'READ_SELECTION_TTS_REVISION'}, options);
                checkCancelled();
                if (!snapshot?.success || typeof snapshot.revision !== 'string' || typeof snapshot.receiverId !== 'string') {
                    throw new Error(snapshot?.error || 'Offscreen TTS 播放许可不可用');
                }
                const reservation = await client.send<SelectionTtsOffscreenResponse>({
                    type: 'RESERVE_SELECTION_TTS', ...route, expectedRevision: snapshot.revision,
                }, options);
                checkCancelled();
                if (reservation?.conflict) continue;
                if (!reservation?.success || typeof reservation.playbackToken !== 'string') {
                    throw new Error(reservation?.error || 'Offscreen TTS 播放许可不可用');
                }
                const response = await client.send<SelectionTtsOffscreenResponse>({
                    type: 'PLAY_SELECTION_TTS', ...payload, playbackToken: reservation.playbackToken,
                }, options);
                checkCancelled();
                // 重建后的新接收端拒绝旧 token；只有确认实例变化且尚未进入 Audio
                // 时才重领。同实例的 STOP/消费/竞争失效及真实播放错误都立即结束。
                if (response?.errorCode === 'selection-tts-permit-invalid'
                    && typeof response.receiverId === 'string' && response.receiverId !== snapshot.receiverId) continue;
                if (!response?.success) throw new Error(response?.error || 'Offscreen TTS 播放失败');
                return;
            }
            throw new Error('语音播放未能启动，请重试');
        },

        async stop(route: SelectionTtsRoute): Promise<void> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'STOP_SELECTION_TTS',
                ...route,
            });
            if (response && !response.success) throw new Error(response.error || 'Offscreen TTS 停止失败');
        },

        async seek(route: SelectionTtsRoute, offsetSeconds: -5 | 5): Promise<boolean> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'SEEK_SELECTION_TTS', ...route, offsetSeconds,
            });
            if (response && !response.success) throw new Error(response.error || '语音跳转失败');
            return response?.seeked === true;
        },

        async pause(route: SelectionTtsRoute): Promise<boolean> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'PAUSE_SELECTION_TTS', ...route,
            });
            if (response && !response.success) throw new Error(response.error || '语音暂停失败');
            return response?.paused === true;
        },

        async resume(route: SelectionTtsRoute): Promise<boolean> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'RESUME_SELECTION_TTS', ...route,
            });
            if (response && !response.success) throw new Error(response.error || '语音继续失败');
            return response?.resumed === true;
        },

        async setRate(route: SelectionTtsRoute, rate: number): Promise<boolean> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'SET_RATE_SELECTION_TTS', ...route, rate,
            });
            if (response && !response.success) throw new Error(response.error || '语音倍速设置失败');
            return response?.updated === true;
        },
    };
}

export const selectionTtsOffscreenAdapter = createSelectionTtsOffscreenAdapter();
