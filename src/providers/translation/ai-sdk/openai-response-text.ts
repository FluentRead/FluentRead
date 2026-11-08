/**
 * @file src/providers/translation/ai-sdk/openai-response-text.ts
 * 文件职责：从已校验的 OpenAI 兼容响应正文提取可见译文。
 * 主要内容：处理普通字符串和分段文本，跳过分段中的思考与未知类型。
 * 模块边界：只接收 message.content，不访问拒答、工具、凭据、网络或响应元数据。
 */
export type OpenAICompatibleMessageContent = string | Array<{type: string; text?: unknown}> | null | undefined;

/** OpenAI 兼容供应商可能分段返回正文；只拼接可见文本，不纳入独立拒答字段、思考内容或工具。 */
export function readOpenAICompatibleText(content: OpenAICompatibleMessageContent): string {
  if (typeof content === 'string') return content;
  return content?.map(part => part.type === 'text' && typeof part.text === 'string' ? part.text : '').join('') ?? '';
}
