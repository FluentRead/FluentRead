/**
 * @file src/providers/translation/ai-sdk/chatCompletionRequest.ts
 * 文件职责：在最终 Chat Completions 请求边界统一输出 token 上限的协议兼容。
 * 主要内容：按实际端点选择官方 OpenAI 的现行字段，保留未知兼容服务的旧字段默认值；
 * 显式的新字段优先，删除冲突字段和空上限，不依赖模型名称或通过网络重试猜测能力。
 * 模块边界：只转换请求值，不选择模型、推理强度、服务等级、消息或流式模式；
 * Responses、Claude 与 Gemini 使用各自适配器，不经过此 Chat 专用转换。
 */

export function normalizeChatCompletionRequest(endpoint: string, body: Record<string, unknown>): Record<string, unknown> {
  const url = new URL(endpoint);
  const officialChat = url.origin === 'https://api.openai.com'
    && url.pathname.replace(/\/$/u, '') === '/v1/chat/completions';
  const result = {...body};
  const completionLimit = body.max_completion_tokens;
  const legacyLimit = body.max_tokens;
  // 官方协议统一采用现行字段；兼容端点只有显式提供新字段时才切换。
  const modern = officialChat || completionLimit != null;
  const limit = completionLimit ?? legacyLimit;
  delete result.max_tokens;
  delete result.max_completion_tokens;
  if (limit != null) result[modern ? 'max_completion_tokens' : 'max_tokens'] = limit;
  return result;
}
