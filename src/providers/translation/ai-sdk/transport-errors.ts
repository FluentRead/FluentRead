/**
 * @file src/providers/translation/ai-sdk/transport-errors.ts
 *
 * 文件职责：将结构化 HTTP 失败与未知异常归一为稳定的 FluentRead LLM transport 错误，供 SDK 和 standalone 共用。
 * 主要内容：定义 LlmTransportError 及诊断字段，隐藏 HTML 错误页并提示检查模型接口，限制和脱敏 provider detail，并由 normalizeLlmTransportError 校准 kind 与 retryable。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {formatServiceError} from '@/src/services/translation/serviceErrors';
import type {TranslationErrorKind} from '@/src/services/translation/errors';
import {readRetryAfterMs} from '@/src/platform/http/errors';

export interface LlmHttpFailure {
  readonly message: string;
  readonly statusCode?: number;
  readonly responseBody?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly data?: unknown;
  readonly isRetryable: boolean;
}

const MAX_PROVIDER_DETAIL_LENGTH = 800;

export interface LlmTransportErrorOptions {
  kind: TranslationErrorKind;
  retryable: boolean;
  statusCode?: number;
  code?: string;
  retryAfterMs?: number;
  requestId?: string;
}

export class LlmTransportError extends Error {
  readonly kind: TranslationErrorKind;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(message: string, options: LlmTransportErrorOptions) {
    super(message);
    this.name = 'LlmTransportError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractProviderError(data: unknown): {message?: string; code?: string} {
  const root = recordValue(data);
  if (!root) return {};
  const nested = recordValue(root.error);
  return {
    message: stringValue(nested?.message) || stringValue(root.message) || stringValue(root.error),
    code: stringValue(nested?.code) || stringValue(root.code),
  };
}

function parseResponseBody(body?: string): {message?: string; code?: string} {
  if (!body?.trim()) return {};
  try {
    return extractProviderError(JSON.parse(body));
  } catch {
    return {message: body};
  }
}

function isHtmlResponse(error: LlmHttpFailure): boolean {
  const body = error.responseBody?.trimStart() ?? '';
  return Object.entries(error.responseHeaders ?? {}).some(([name, value]) =>
    name.toLowerCase() === 'content-type' && /\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(value))
    || (body.startsWith('<') && /<(?:!doctype\s+html|html|head|body)(?:\s|>)/iu.test(body.slice(0, 1024)));
}

function sanitizeProviderDetail(value: string, apiKey?: string | readonly string[]): string {
  let result = value
    .replace(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/giu, '[已隐藏的图片]')
    .replace(/((?:authorization|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}]+/giu, '$1[已隐藏]')
    .replace(/\b(?:sk|tp)-[a-z0-9_-]{8,}\b/giu, '[已隐藏的密钥]');
  for (const value of typeof apiKey === 'string' ? [apiKey] : apiKey ?? []) {
    const key = value.trim();
    if (key) result = result.split(key).join('[已隐藏的密钥]');
  }
  result = result.replace(/\s+/gu, ' ').trim();
  return result.slice(0, MAX_PROVIDER_DETAIL_LENGTH);
}

function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  const normalizedHeaders = Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  return readRetryAfterMs({get: key => normalizedHeaders[key] ?? null});
}

function requestIdFrom(headers?: Record<string, string>): string | undefined {
  const normalizedHeaders = Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  return normalizedHeaders['x-request-id']
    || normalizedHeaders['request-id']
    || normalizedHeaders['x-ms-request-id']
    || normalizedHeaders['x-amzn-requestid'];
}

function sanitizeMetadata(value: string | undefined, apiKey?: string | readonly string[], maxLength = 160): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeProviderDetail(value, apiKey).slice(0, maxLength);
  return sanitized || undefined;
}

function statusKind(statusCode?: number): TranslationErrorKind {
  if (statusCode === 401 || statusCode === 403) return 'authentication';
  if (statusCode === 408) return 'timeout';
  if (statusCode === 429) return 'rate-limit';
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return 'bad-request';
  if (statusCode !== undefined && statusCode >= 500) return 'provider';
  return 'response';
}

function userMessageForStatus(
  service: string,
  statusCode: number | undefined,
  detail: string,
): string {
  const specialized = detail ? formatServiceError(service, detail) : '';
  if (specialized && specialized !== detail) return specialized;

  if (statusCode === 401 || statusCode === 403) {
    return `当前翻译服务的 API Key 无效、已过期或没有模型访问权限（HTTP ${statusCode}）。请检查服务配置。`;
  }
  if (statusCode === 429) {
    return '当前翻译服务的请求频率或配额已达上限（HTTP 429），请稍后重试。';
  }
  if (statusCode === 408) return '当前翻译服务请求超时（HTTP 408），请稍后重试。';
  if (statusCode !== undefined && statusCode >= 500) {
    return `当前翻译服务暂时不可用（HTTP ${statusCode}），请稍后重试。`;
  }
  if (statusCode !== undefined && statusCode >= 400) {
    const suffix = detail ? `：${detail}` : '';
    return `当前翻译服务拒绝了请求（HTTP ${statusCode}）${suffix}`;
  }
  return formatServiceError(service, detail || '翻译服务返回了无法识别的错误');
}

function withRequestId(message: string, requestId?: string): string {
  return requestId ? `${message}\n请求 ID：${requestId}` : message;
}

export function normalizeLlmTransportError(
  service: string,
  error: unknown,
  apiKey?: string | readonly string[],
  callerAborted = false,
  httpFailure?: LlmHttpFailure,
): LlmTransportError {
  if (httpFailure) {
    const candidate = httpFailure;
    const fromData = extractProviderError(candidate.data);
    const fromBody = parseResponseBody(candidate.responseBody);
    const detail = sanitizeProviderDetail(
      isHtmlResponse(candidate)
        ? '服务返回了 HTML 网页。请检查 Base URL、接口路径，以及所选模型是否支持 Chat Completions。'
        : fromData.message || fromBody.message || candidate.message || '上游请求失败',
      apiKey,
    );
    const requestId = sanitizeMetadata(requestIdFrom(candidate.responseHeaders), apiKey);
    const code = sanitizeMetadata(fromData.code || fromBody.code, apiKey, 120);
    return new LlmTransportError(
      withRequestId(userMessageForStatus(service, candidate.statusCode, detail), requestId),
      {
        kind: statusKind(candidate.statusCode),
        retryable: candidate.isRetryable,
        statusCode: candidate.statusCode,
        code,
        retryAfterMs: parseRetryAfter(candidate.responseHeaders),
        requestId,
      },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const errorName = error instanceof Error ? error.name : '';
  const timedOut = /timeout|timed out|请求超时/u.test(normalized)
    || errorName === 'TimeoutError'
    // AI SDK 也会把内部总超时控制器表现为 AbortError，例如等待 Retry-After 时。
    || (errorName === 'AbortError' && !callerAborted);
  const aborted = errorName === 'AbortError' && callerAborted;
  const network = /failed to fetch|fetch failed|networkerror|network error|load failed|网络连接失败/u.test(normalized);
  const invalidRequest = /invalidprompt|typevalidation|invalidargument/u.test(
    errorName.replace(/[^a-z]/giu, '').toLowerCase(),
  )
    || /invalid prompt|messages? must|prompt must|请求体.*(?:无效|格式)/u.test(normalized);
  const detail = sanitizeProviderDetail(message || '网络请求失败', apiKey);
  return new LlmTransportError(
    timedOut
      ? '当前翻译服务请求超时，请稍后重试。'
      : aborted
        ? '翻译请求已取消。'
        : invalidRequest
          ? `大模型请求配置无效：${detail}`
          : formatServiceError(service, detail),
    {
      kind: timedOut
        ? 'timeout'
        : aborted
          ? 'timeout'
          : invalidRequest
            ? 'bad-request'
            : network
              ? 'network'
              : 'response',
      retryable: !aborted && !invalidRequest && (timedOut || network),
    },
  );
}
