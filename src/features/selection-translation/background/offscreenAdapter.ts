/**
 * @file src/features/selection-translation/background/offscreenAdapter.ts
 * 文件职责：把划词 TTS 的播放、停止及路由信息转换为平台 Offscreen 消息，并验证隔离文档是否接受了对应音频请求。
 * 主要内容：定义 SelectionTtsOffscreenResponse，提供 createSelectionTtsOffscreenAdapter 和默认实例，发送 play/stop 消息时携带 tabId 与 clientRequestId 防止旧状态串扰。
 * 模块边界：适配器不合成音频、不创建 Audio 或 Offscreen document；音频资源生命周期归 offscreen 应用，Edge/Google TTS 获取归 handler/services，平台 client 负责文档创建与复用。
 */
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import type {
    SelectionTtsPlaybackRequest,
    SelectionTtsRoute,
} from '@/src/features/selection-translation/protocol';
import {
    type OffscreenClient,
} from '@/src/platform/offscreen/client';

interface SelectionTtsOffscreenResponse {
    readonly success?: boolean;
    readonly error?: string;
}

/** TTS 消息始终携带 {tabId, clientRequestId}，不依赖可重启 worker 的内存。 */
export function createSelectionTtsOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    return {
        async play(payload: SelectionTtsPlaybackRequest): Promise<void> {
            const response = await client.send<SelectionTtsOffscreenResponse>({
                type: 'PLAY_SELECTION_TTS',
                ...payload,
            });
            if (!response?.success) throw new Error(response?.error || 'Offscreen TTS 播放失败');
        },

        async stop(route: SelectionTtsRoute): Promise<void> {
            const response = await client.sendIfPresent<SelectionTtsOffscreenResponse>({
                type: 'STOP_SELECTION_TTS',
                ...route,
            });
            if (response && !response.success) throw new Error(response.error || 'Offscreen TTS 停止失败');
        },
    };
}

export const selectionTtsOffscreenAdapter = createSelectionTtsOffscreenAdapter();
