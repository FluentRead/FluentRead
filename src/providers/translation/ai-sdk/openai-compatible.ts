/**
 * @file src/providers/translation/ai-sdk/openai-compatible.ts
 * 文件职责：为扩展与 Greasy Fork 保持原 AI SDK 的 OpenAI 兼容非流式执行入口。
 * 主要内容：将共享准备层提供的请求、HTTP 包装器和取消信号交给锁定 SDK，保留 SDK 重试与异常识别；公开请求类型和常量沿用原路径。
 * 模块边界：仅负责 SDK 装配，payload、租约、用量、请求预算和文本清洗由 openai-transport 统一管理；直接安装的脚本通过自有入口选择紧凑 HTTP 执行器，不替换 SDK API。
 */
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {generateText} from 'ai';
import {normalizeAiSdkError} from './errors';
import {translateOpenAICompatible, type AiSdkTranslationRequest, type OpenAICompatibleExecution} from './openai-transport';
import {readOpenAICompatibleText, type OpenAICompatibleMessageContent} from './openai-response-text';
export {AI_SDK_MAX_RETRIES, AI_SDK_REQUEST_TIMEOUT_MS, type AiSdkTranslationRequest} from './openai-transport';

export const openAICompatibleSdkExecution: OpenAICompatibleExecution = {
  async run(call) {
    const provider = createOpenAICompatible({
      name: 'fluentread', baseURL: call.endpoint.baseURL, apiKey: call.apiKey,
      headers: call.headers, queryParams: call.endpoint.queryParams,
      fetch: call.fetch, transformRequestBody: () => call.requestBody,
    });
    const result = await generateText({
      model: provider(call.requestBody.model as string),
      // 实际扩展格式 body 已在共享层验证；固定 prompt 避免 SDK 拒绝 developer/image_url。
      prompt: 'FluentRead OpenAI-compatible request',
      maxRetries: call.maxRetries, abortSignal: call.signal, include: {responseBody: true},
    });
    // SDK 7 会把拒答字段追加到 result.text；翻译只消费 provider 的正文。
    const response = result.finalStep.response.body as {choices: Array<{message: {content?: OpenAICompatibleMessageContent}}>};
    return readOpenAICompatibleText(response.choices[0].message.content);
  },
  normalizeError: normalizeAiSdkError,
};

export function translateWithOpenAICompatibleAiSdk(request: AiSdkTranslationRequest): Promise<string | string[]> {
  return translateOpenAICompatible(request, openAICompatibleSdkExecution);
}
