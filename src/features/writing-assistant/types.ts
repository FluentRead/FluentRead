/**
 * @file src/features/writing-assistant/types.ts
 * 文件职责：定义写作面板与后台之间有界、无凭据的流式消息协议。
 * 主要内容：声明动作、用户要求、草稿、可预览上下文、语言、语气、可选篇幅及近期问答；响应包含实际服务模型。
 * 模块边界：仅定义类型，页面不能通过请求覆盖后台密钥或服务地址。
 */
import type {WritingIntent, WritingLength} from '@/src/core/config/writing';
export interface WritingRequest {
    type: 'fluentReadWriting'; action: 'run'; requestId: string; intent: WritingIntent;
    instruction: string; draft: string; context: string; language: string; tone: string; length?: WritingLength;
    history: Array<{question: string; answer: string}>;
}
export type WritingResponse = {success: true; text: string; service: string; model: string}
    | {success: false; error: string; cancelled?: boolean};
export type WritingProgress = {kind: 'text'; text: string} | {kind: 'model'; service: string; model: string};
export type WritingStreamMessage = {requestId: string} & (
    {type: 'progress'; progress: WritingProgress} | {type: 'result'; response: WritingResponse});
