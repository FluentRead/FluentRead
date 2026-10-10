/**
 * @file src/app/content/informationHighlightScorePort.ts
 * 文件职责：把扩展的模型评分消息适配成可取消的纯文本评分函数，供网页内容脚本和文档阅读页共用。
 * 主要内容：为每次请求固定模型和身份，取消时通知后台并立即拒绝，校验返回结构；不持有页面状态。
 * 模块边界：只依赖注入的 send 与纯数据 protocol，不导入页面控制器、翻译模块或浏览器扩展 API，文档页引用它不会带入内容脚本的依赖。
 */
import type {InformationHighlightResult} from '@/src/features/information-highlight/protocol';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';

export function createInformationHighlightScorePort(send: (message: {type: string; text?: string; requestId: string; modelId?: InformationHighlightModelId}) => Promise<unknown>) {
    const requestIdentity = () => {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        // HTTP 宿主页也有 getRandomValues；构造相同 RFC 4122 v4 格式以满足后台消息验证。
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    return async function scoreLocal(text: string, signal: AbortSignal, modelId: InformationHighlightModelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID): Promise<InformationHighlightResult> {
        const requestId = requestIdentity();
        if (signal.aborted) throw new Error('INFORMATION_HIGHLIGHT_CANCELLED');
        let rejectAbort: (reason: Error) => void;
        const cancelled = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
        const abort = () => {
            void send({type: 'CANCEL_INFORMATION_HIGHLIGHT', requestId}).catch(() => undefined);
            rejectAbort(new Error('INFORMATION_HIGHLIGHT_CANCELLED'));
        };
        signal.addEventListener('abort', abort, {once: true});
        try {
            const reply = await Promise.race([send({type: 'SCORE_INFORMATION_HIGHLIGHT', text, requestId, modelId}), cancelled]);
            if (signal.aborted) throw new Error('INFORMATION_HIGHLIGHT_CANCELLED');
            const response = reply as {success?: boolean; result?: InformationHighlightResult; error?: string} | undefined;
            if (!response?.success || !response.result || !Array.isArray(response.result.spans) || typeof response.result.engine !== 'string') {
                throw new Error(response?.error || 'INFORMATION_HIGHLIGHT_SCORE_FAILED');
            }
            return response.result;
        } finally {signal.removeEventListener('abort', abort);}
    };
}
