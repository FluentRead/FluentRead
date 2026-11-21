/**
 * @file src/providers/translation/ai-sdk/chatCompletionRequest.ts
 * 文件职责：在最终 Chat Completions 请求边界统一输出 token 上限的协议兼容。
 * 主要内容：官方 OpenAI 端点与已知 Azure 推理部署采用现行字段，其他兼容请求保留旧字段；
 * 显式的新字段优先，删除冲突字段和空上限。
 * 模块边界：只转换请求值，不选择模型、推理强度、服务等级、消息或流式模式；
 * Responses、Claude 与 Gemini 使用各自适配器，不经过此 Chat 专用转换。
 */

import {services} from '@/src/core/config/catalog';

export function normalizeChatCompletionRequest(endpoint: string, body: Record<string, unknown>, service?: string): Record<string, unknown> {
  const url = new URL(endpoint);
  const officialChat = url.origin === 'https://api.openai.com'
    && url.pathname.replace(/\/$/u, '') === '/v1/chat/completions';
  const result = {...body};
  const completionLimit = body.max_completion_tokens;
  const legacyLimit = body.max_tokens;
  // Azure 旧版路由由 URL 选择部署，v1 接口则使用请求体中的部署名称。
  const azureDeployment = service === services.azureOpenai
    ? url.pathname.match(/^\/openai\/deployments\/([^/]+)\/chat\/completions\/?$/u)?.[1] ?? body.model
    : undefined;
  const azureReasoning = typeof azureDeployment === 'string'
    && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/iu.test(azureDeployment);
  const modern = officialChat || azureReasoning || completionLimit != null;
  const limit = completionLimit ?? legacyLimit;
  delete result.max_tokens;
  delete result.max_completion_tokens;
  if (limit != null) result[modern ? 'max_completion_tokens' : 'max_tokens'] = limit;
  return result;
}
