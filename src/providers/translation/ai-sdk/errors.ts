/**
 * @file src/providers/translation/ai-sdk/errors.ts
 * 文件职责：按结构特征识别 HTTP 失败与重试包装异常，并转交共享 transport 错误归一层。
 * 主要内容：在不引入 AI SDK 运行时的前提下解包 RetryError 风格异常的 lastError，识别 LlmHttpFailure 与 AI_APICallError，并原位重新导出同一 LlmTransportError 类与类型。
 * 模块边界：只做轻量错误归类与导出，不发送网络请求、不依赖第三方 SDK 运行时或网关。
 */
import {normalizeLlmTransportError, type LlmHttpFailure, type LlmTransportError} from './transport-errors';
export {LlmTransportError, type LlmTransportErrorOptions} from './transport-errors';

function isHttpFailure(value: unknown): value is LlmHttpFailure {
  return value instanceof Error
    && typeof (value as Partial<LlmHttpFailure>).isRetryable === 'boolean'
    && (value.name === 'LlmHttpFailure' || value.name === 'AI_APICallError');
}

export function normalizeAiSdkError(
  service: string,
  error: unknown,
  apiKey?: string | readonly string[],
  callerAborted = false,
): LlmTransportError {
  const candidate = error instanceof Error && error.name === 'AI_RetryError' && 'lastError' in error
    ? (error as Error & {lastError: unknown}).lastError
    : error;
  return normalizeLlmTransportError(service, candidate, apiKey, callerAborted,
    isHttpFailure(candidate) ? candidate : undefined);
}
