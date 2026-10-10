/**
 * @file src/features/information-highlight/background/handlers.ts
 * 文件职责：将信息高亮公开消息接入既有后台 registry，校验请求来源与取消所有权。
 * 主要内容：校验模型身份，扩展 UI 独占模型下载/删除，页面只请求评分；按 tab/frame/document 区分 UUID 请求，记住先取消后评分并限制在途数量。
 * 模块边界：不加载模型、不保存原文、不绘制页面，不另建 runtime listener 或持久会话状态。
 */
import {INFORMATION_HIGHLIGHT_MAX_CHARACTERS, type InformationHighlightModelStatus, type InformationHighlightResult} from '../protocol';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
interface MessageHandler {type: string; handle(message: unknown, context: unknown): unknown | Promise<unknown>}
interface Sender {id?: string; url?: string; tab?: {id?: number}; frameId?: number; documentId?: string}
interface Dependencies {
    runtimeId: string;
    isUi(url: string): boolean;
    isDocument(url: string): boolean;
    offscreen: {score(text: string, signal: AbortSignal, modelId?: InformationHighlightModelId): Promise<InformationHighlightResult>; status(modelId?: InformationHighlightModelId): Promise<InformationHighlightModelStatus>; prepare(modelId?: InformationHighlightModelId): Promise<InformationHighlightModelStatus>; pause(modelId?: InformationHighlightModelId): Promise<InformationHighlightModelStatus>; remove(modelId?: InformationHighlightModelId): Promise<InformationHighlightModelStatus>};
}
function requestModel(message: unknown): InformationHighlightModelId {
    const value = (message as {modelId?: unknown}).modelId;
    if (value === undefined) return DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID;
    const model = getInformationHighlightModel(value);
    if (model.id !== value) throw new Error('INFORMATION_HIGHLIGHT_INVALID_MODEL');
    return model.id;
}
export function createInformationHighlightBackgroundHandlers(dependencies: Dependencies): MessageHandler[] {
    const active = new Map<string, AbortController>(), cancelled = new Set<string>();
    const source = (context: unknown): Sender => {
        const sender = (context as {sender?: Sender})?.sender;
        if (!sender || sender.id !== dependencies.runtimeId) throw new Error('INFORMATION_HIGHLIGHT_UNTRUSTED_SENDER');
        return sender;
    };
    const owner = (message: unknown, context: unknown) => {
        const sender = source(context), id = (message as {requestId?: unknown}).requestId;
        const documentPage = Boolean(sender.url && dependencies.isDocument(sender.url));
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)
            || !sender.url || (!documentPage && (!Number.isInteger(sender.tab?.id) || !/^(?:https?|file):/u.test(sender.url)))) throw new Error('INFORMATION_HIGHLIGHT_INVALID_REQUEST');
        return `${sender.tab?.id ?? 'document'}:${sender.frameId ?? 0}:${sender.documentId ?? sender.url}:${id}`;
    };
    const management = (method: 'status' | 'prepare' | 'pause' | 'remove', type: string): MessageHandler => ({type,
        async handle(message, context) {
            const sender = source(context);
            if (method !== 'status' && (!sender.url || !dependencies.isUi(sender.url))) throw new Error('INFORMATION_HIGHLIGHT_UNTRUSTED_SENDER');
            return {success: true, status: await dependencies.offscreen[method](requestModel(message))};
        },
    });
    return [
        management('status', 'GET_INFORMATION_HIGHLIGHT_MODEL_STATUS'), management('prepare', 'PREPARE_INFORMATION_HIGHLIGHT_MODEL'),
        management('pause', 'PAUSE_INFORMATION_HIGHLIGHT_MODEL'), management('remove', 'REMOVE_INFORMATION_HIGHLIGHT_MODEL'),
        {type: 'SCORE_INFORMATION_HIGHLIGHT', async handle(message, context) {
            const key = owner(message, context), text = (message as {text?: unknown}).text, modelId = requestModel(message);
            if (typeof text !== 'string' || !text || text.length > INFORMATION_HIGHLIGHT_MAX_CHARACTERS) throw new Error('INFORMATION_HIGHLIGHT_TEXT_LIMIT');
            if (cancelled.delete(key)) throw new DOMException('信息高亮已取消', 'AbortError');
            if (active.has(key) || active.size >= 32) throw new Error('INFORMATION_HIGHLIGHT_BUSY');
            const controller = new AbortController(); active.set(key, controller);
            try {
                const result = await dependencies.offscreen.score(text, controller.signal, modelId);
                if (controller.signal.aborted) throw new DOMException('信息高亮已取消', 'AbortError');
                return {success: true, result};
            } finally {if (active.get(key) === controller) active.delete(key);}
        }},
        {type: 'CANCEL_INFORMATION_HIGHLIGHT', handle(message, context) {
            const key = owner(message, context), controller = active.get(key);
            if (controller) controller.abort();
            else {cancelled.add(key); if (cancelled.size > 512) cancelled.delete(cancelled.values().next().value!);}
            return {success: true};
        }},
    ];
}
