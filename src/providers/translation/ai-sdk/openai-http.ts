/**
 * @file src/providers/translation/ai-sdk/openai-http.ts
 * 文件职责：执行 FluentRead 已准备的非流式 OpenAI 兼容 HTTP 请求，供普通与 standalone 脚本使用。
 * 主要内容：保持锁定 SDK 的请求头、响应文本校验、有限读取和重试等待合同，保留取消信号及最后一次 HTTP 错误；具体 payload、并发租约和用量仍经共享 transport 处理。
 * 模块边界：不是通用 SDK 替代，不提供工具、流式或结构化生成 API，不执行宿主页注入的 SDK telemetry 钩子；不持有配置、缓存或凭据，不直接调用全局 fetch。
 * 协议依据：Vercel AI SDK 7.0.165、openai-compatible 3.0.87 与 provider-utils 5.0.76（Apache-2.0）；产物保留上游版权和许可来源。
 */
import {readRuntimeUserAgent} from '@/src/platform/browser/capabilities';
import type {OpenAICompatibleCall, OpenAICompatibleExecution} from './openai-transport';
import {readOpenAICompatibleText, type OpenAICompatibleMessageContent} from './openai-response-text';
import {normalizeLlmTransportError, type LlmHttpFailure} from './transport-errors';

class HttpFailure extends Error implements LlmHttpFailure {
  constructor(
    message: string,
    readonly isRetryable: boolean,
    readonly statusCode?: number,
    readonly responseHeaders?: Record<string, string>,
    readonly responseBody?: string,
  ) { super(message); }
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && ['AbortError', 'TimeoutError', 'ResponseAborted'].includes(error.name);
}

function httpFailure(response: Response, message: string, body?: string): HttpFailure {
  const status = response.status;
  return new HttpFailure(message, status === 408 || status === 409 || status === 429 || status >= 500,
    status, Object.fromEntries(response.headers.entries()), body);
}

// 对照 ai7.0.165/provider-utils5.0.76 的有限读取合同；先检查声明长度，随后按真实字节累计。
async function readBody(response: Response): Promise<string> {
  const limit = 2 * 1024 * 1024 * 1024;
  const declared = response.headers.get('content-length');
  if (declared !== null && parseInt(declared, 10) > limit) {
    try { await response.body?.cancel(); } catch { /* 取消失败不覆盖大小错误。 */ }
    throw new Error('Response exceeds the supported size');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) throw new Error('Response exceeds the supported size');
      chunks.push(chunk.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* 保留原读取错误。 */ }
    finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => value == null || typeof value === 'string';
const number = (value: unknown) => value == null || typeof value === 'number' && Number.isFinite(value);
const fields = (value: JsonRecord, names: string[], check: (value: unknown) => boolean) => names.every(name => check(value[name]));

function safeTree(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    const object = item as JsonRecord;
    if (Object.prototype.hasOwnProperty.call(object, '__proto__')
      || Object.prototype.hasOwnProperty.call(object, 'constructor') && record(object.constructor)
        && Object.prototype.hasOwnProperty.call(object.constructor, 'prototype')) return false;
    for (const child of Object.values(object)) pending.push(child);
  }
  return true;
}

function validUsage(value: unknown): boolean {
  if (value == null) return true;
  if (!record(value) || !fields(value, ['prompt_tokens', 'completion_tokens', 'total_tokens'], number)) return false;
  return [
    ['prompt_tokens_details', ['cached_tokens']],
    ['completion_tokens_details', ['reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ].every(([name, names]) => value[name as string] == null || record(value[name as string])
    && fields(value[name as string] as JsonRecord, names as string[], number));
}

function validTool(value: unknown): boolean {
  if (!record(value) || !string(value.id) || !record(value.function)
    || typeof value.function.name !== 'string' || typeof value.function.arguments !== 'string') return false;
  const extra = value.extra_content;
  return extra == null || record(extra) && (extra.google == null || record(extra.google) && string(extra.google.thought_signature));
}

function validResponse(value: unknown): value is {choices: Array<{message: {content?: OpenAICompatibleMessageContent}}> } {
  return record(value) && safeTree(value) && fields(value, ['id', 'model'], string) && number(value.created)
    && validUsage(value.usage) && Array.isArray(value.choices) && value.choices.every(choice => {
      if (!record(choice) || !string(choice.finish_reason) || !record(choice.message)) return false;
      const message = choice.message;
      return (message.role == null || message.role === 'assistant')
        && (string(message.content) || Array.isArray(message.content)
          && message.content.every(part => record(part) && typeof part.type === 'string'))
        && fields(message, ['reasoning_content', 'reasoning'], string)
        && (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.every(validTool));
    });
}

async function attempt(call: OpenAICompatibleCall, url: string, headers: Record<string, string>): Promise<string> {
  let response: Response;
  try {
    response = await call.fetch(url, {method: 'POST', headers, body: JSON.stringify(call.requestBody), signal: call.signal});
  } catch (error) {
    // 浏览器普通 TypeError 没有 cause 时由外层网络策略处理；保持 SDK 不在本层重试的合同。
    if (!isAbort(error) && error instanceof TypeError
      && ['fetch failed', 'failed to fetch'].includes(error.message.toLowerCase())
      && (error as Error & {cause?: unknown}).cause != null) {
      throw new HttpFailure(`Cannot connect to API: ${(error as Error & {cause: {message?: string}}).cause.message}`, true);
    }
    if (!isAbort(error) && error instanceof Error
      && ['ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']
        .includes((error as Error & {code: string}).code)) throw new HttpFailure(`Cannot connect to API: ${error.message}`, true);
    throw error;
  }
  let body: string;
  try { body = await readBody(response); }
  catch (error) {
    if (isAbort(error)) throw error;
    throw httpFailure(response, response.ok ? 'Failed to process successful response' : 'Failed to process error response');
  }
  if (!response.ok) throw httpFailure(response, response.statusText, body);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { /* 与 schema 失败统一为不可重试的 HTTP 响应错误。 */ }
  if (!validResponse(parsed)) throw httpFailure(response, 'Invalid JSON response', body);
  const choice = parsed.choices[0];
  if (!choice) throw new Error('Response did not contain any choices.');
  return readOpenAICompatibleText(choice.message.content);
}

function retryDelay(error: HttpFailure, fallback: number): number {
  const headers = error.responseHeaders;
  let milliseconds: number | undefined;
  if (headers?.['retry-after-ms']) {
    const value = parseFloat(headers['retry-after-ms']);
    if (!Number.isNaN(value)) milliseconds = value;
  }
  if (headers?.['retry-after'] && milliseconds === undefined) {
    const value = parseFloat(headers['retry-after']);
    milliseconds = Number.isNaN(value) ? Date.parse(headers['retry-after']) - Date.now() : value * 1000;
  }
  return milliseconds !== undefined && !Number.isNaN(milliseconds) && milliseconds >= 0
    && (milliseconds < 60_000 || milliseconds < fallback) ? milliseconds : fallback;
}

function waitRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Delay was aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Delay was aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, {once: true});
  });
}

export const standaloneOpenAIExecution: OpenAICompatibleExecution = {
  async run(call) {
    const url = new URL(`${call.endpoint.baseURL.replace(/\/$/u, '')}/chat/completions`);
    if (call.endpoint.queryParams) url.search = new URLSearchParams(call.endpoint.queryParams).toString();
    // 固定到当前已对照的 wire 合同；升级 SDK 时锁定版本测试要求同步复审，而非静默漂移。
    const headers = Object.fromEntries(new Headers({
      'content-type': 'application/json',
      ...(call.apiKey ? {authorization: `Bearer ${call.apiKey}`} : {}),
      ...call.headers,
      'user-agent': ['ai/7.0.165 ai-sdk-provider-utils/5.0.76', readRuntimeUserAgent(globalThis).toLowerCase()].filter(Boolean).join(' '),
    }).entries());
    const send = async (retry: number): Promise<string> => {
      try { return await attempt(call, url.toString(), headers); }
      catch (error) {
        if (!(error instanceof HttpFailure) || !error.isRetryable || retry >= call.maxRetries) throw error;
        await waitRetry(retryDelay(error, 2000 * 2 ** retry), call.signal);
        return send(retry + 1);
      }
    };
    return send(0);
  },
  normalizeError(service, error, secrets, callerAborted) {
    return normalizeLlmTransportError(service, error, secrets, callerAborted, error instanceof HttpFailure ? error : undefined);
  },
};
