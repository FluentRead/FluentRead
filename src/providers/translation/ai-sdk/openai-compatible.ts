/**
 * @file src/providers/translation/ai-sdk/openai-compatible.ts
 * 文件职责：为扩展提供轻量 OpenAI 兼容非流式执行入口，保持既有请求类型、常量与协议合同。
 * 主要内容：复用与锁定 AI SDK 合同一致的自有 HTTP 执行器（openai-http），统一交由 openai-transport 管理 payload、租约、用量、预算与文本清洗。
 * 模块边界：仅负责执行器装配与公开入口导出，不引入第三方 AI SDK 运行时，不直接调用全局 fetch。
 */
import {standaloneOpenAIExecution} from './openai-http';
import {translateOpenAICompatible, type AiSdkTranslationRequest, type OpenAICompatibleExecution} from './openai-transport';
export {AI_SDK_MAX_RETRIES, AI_SDK_REQUEST_TIMEOUT_MS, type AiSdkTranslationRequest} from './openai-transport';

export const openAICompatibleSdkExecution: OpenAICompatibleExecution = standaloneOpenAIExecution;

export function translateWithOpenAICompatibleAiSdk(request: AiSdkTranslationRequest): Promise<string | string[]> {
  return translateOpenAICompatible(request, openAICompatibleSdkExecution);
}
