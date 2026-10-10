/**
 * @file src/features/information-highlight/background/offscreenAdapter.ts
 * 文件职责：通过已有扩展 DOM client 请求本地信息高亮能力。
 * 主要内容：评分、状态及显式下载操作均固定模型身份，取消绑定独立 UUID，继续复用 Chromium/Firefox 的 ready 与重建机制。
 * 模块边界：不创建新 offscreen 文档、不加载模型、不处理 DOM；AbortSignal 留在后台。
 */
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import type {InformationHighlightModelStatus, InformationHighlightResult} from '../protocol';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
export function createInformationHighlightOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    const command = async (type: string, modelId: InformationHighlightModelId) => {
        const response = await client.send<{success: boolean; status?: InformationHighlightModelStatus; error?: string}>({type, modelId}, {timeoutMs: 30_000});
        if (!response.success || !response.status) throw new Error(response.error || 'INFORMATION_HIGHLIGHT_FAILED');
        return response.status;
    };
    return {
        status: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => command('INFORMATION_HIGHLIGHT_STATUS_OFFSCREEN', modelId),
        prepare: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => command('INFORMATION_HIGHLIGHT_PREPARE_OFFSCREEN', modelId),
        pause: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => command('INFORMATION_HIGHLIGHT_PAUSE_OFFSCREEN', modelId),
        remove: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => command('INFORMATION_HIGHLIGHT_REMOVE_OFFSCREEN', modelId),
        async score(text: string, signal: AbortSignal, modelId: InformationHighlightModelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID): Promise<InformationHighlightResult> {
            const requestId = crypto.randomUUID();
            const response = await client.send<{success: boolean; result?: InformationHighlightResult; error?: string}>({type: 'INFORMATION_HIGHLIGHT_SCORE_OFFSCREEN', text, requestId, modelId}, {
                signal, timeoutMs: 120_000, cancelMessage: {type: 'INFORMATION_HIGHLIGHT_CANCEL_OFFSCREEN', requestId},
            });
            if (!response.success || !response.result) throw new Error(response.error || 'INFORMATION_HIGHLIGHT_FAILED');
            return response.result;
        },
    };
}
