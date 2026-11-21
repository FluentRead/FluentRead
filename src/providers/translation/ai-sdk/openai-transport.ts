/**
 * @file src/providers/translation/ai-sdk/openai-transport.ts
 * 字幕参考：将后台规范化的相邻 cue 标记交给共用提示模板，供应商协议与返回结构保持原契约。
 *
 * 文件职责：组织 OpenAI 兼容翻译请求的共享准备、响应归一和生命周期，向扩展 SDK 与 standalone HTTP 执行器提供同一端口。
 * 主要内容：冻结请求级配置，解析服务 endpoint 与模型，构造 commonMsgTemplate，将固定 payload 交给执行端口；把真实 HTTP 请求和响应读取登记到后台并发租约，避免取消提前释放槽位；在自定义请求体合并后仅为官方 MiMo 端点兜底退役编号；按实际 Chat 端点统一输出 token 上限，清理推理内容、执行预算和归一错误。公开 translateOpenAICompatible 及请求、执行端口类型，不依赖任一具体执行器。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {stripTranslationReasoning as contentPostHandler} from '@/src/core/translation/prompts';
import {normalizeChatCompletionRequest} from './chatCompletionRequest';
import {buildOpenAIChatPayload} from '@/src/services/translation/templates';
import {services} from '@/src/core/config/catalog';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {parseCustomHeaders, mergeCustomHeaders} from '@/src/core/config/customHeaders';
import {
  resolveOpenAICompatibleEndpoint,
  resolveOfficialMimoModel,
  type ResolvedOpenAICompatibleEndpoint,
} from './endpoints';
import {LlmTransportError} from './transport-errors';
import {createImageInputHttpError} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {boundErrorResponse, OPENAI_ERROR_BODY_LIMIT} from './boundedErrorResponse';
import {TranslationRequestCooldownError, type TranslationRequestLease} from '@/src/services/translation/requestScheduler';
import {TRANSLATION_COMPACT_BATCH} from '@/src/services/translation/types';
import {
    requireTranslationProviderConfig,
    getTranslationRequestScheduler,
    reportTranslationModelUsage,
    getTranslationImageInput,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequestContext} from '@/src/services/translation/types';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {normalizeOpenAICompatibleUsage} from '../usage';
import {normalizeTranslationMaxRetries} from '@/src/core/config/scheduling';
import {DEFAULT_AI_REQUEST_TIMEOUT_MS, normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';

export const AI_SDK_REQUEST_TIMEOUT_MS = DEFAULT_AI_REQUEST_TIMEOUT_MS;
export const AI_SDK_MAX_RETRIES = 2;

export interface AiSdkTranslationRequest extends TranslationProviderRequestContext {
  origin: string | string[];
  pageContext?: string;
  subtitleContext?: string;
  summaryPrompt?: string;
  summarySystemPrompt?: string;
  serviceOverride?: string;
  modelOverride?: string;
  thinkingOverride?: boolean;
  targetLanguage?: string;
  requestTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

interface OpenAICompatiblePayload extends Record<string, unknown> {
  model: string;
  messages: unknown[];
}

function validatePayload(candidate: Record<string, unknown>): OpenAICompatiblePayload {
  if (typeof candidate.model !== 'string' || !candidate.model.trim()) {
    throw new LlmTransportError('模型尚未配置，请前往设置页面进行检查。', {
      kind: 'bad-request',
      retryable: false,
    });
  }
  if (!Array.isArray(candidate.messages)) {
    throw new LlmTransportError('自定义请求体中的 messages 必须是数组。', {
      kind: 'bad-request',
      retryable: false,
    });
  }

  return {
    ...candidate,
    model: candidate.model.trim(),
    messages: candidate.messages,
  };
}

function providerHeaders(service: string, apiKey: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (service === services.azureOpenai && apiKey) headers['api-key'] = apiKey;
  if (service === services.openrouter) {
    headers['HTTP-Referer'] = 'https://read.thinkstu.com';
    headers['X-Title'] = 'FluentRead';
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

interface OpenAICompatibleResponseBody {
  model?: unknown;
  usage?: unknown;
  choices?: Array<{message?: {content?: unknown; refusal?: unknown}; finish_reason?: unknown}>;
}

function nonNegativeToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** 只把 SDK 能安全解析的数值 usage 字段放回响应，兼容字符串等非标准元数据。 */
function sanitizeUsageForAiSdk(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: Record<string, unknown> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens'] as const) {
    const token = nonNegativeToken(source[key]);
    if (token !== undefined) usage[key] = token;
  }

  const promptDetails = source.prompt_tokens_details;
  if (promptDetails && typeof promptDetails === 'object' && !Array.isArray(promptDetails)) {
    const details: Record<string, number> = {};
    for (const key of ['cached_tokens', 'cache_write_tokens'] as const) {
      const token = nonNegativeToken((promptDetails as Record<string, unknown>)[key]);
      if (token !== undefined) details[key] = token;
    }
    if (Object.keys(details).length > 0) usage.prompt_tokens_details = details;
  }

  const completionDetails = source.completion_tokens_details;
  if (completionDetails && typeof completionDetails === 'object' && !Array.isArray(completionDetails)) {
    const reasoningTokens = nonNegativeToken(
      (completionDetails as Record<string, unknown>).reasoning_tokens,
    );
    if (reasoningTokens !== undefined) {
      usage.completion_tokens_details = {reasoning_tokens: reasoningTokens};
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

async function normalizeSuccessfulTextResponse(
  response: Response,
): Promise<{response: Response; body?: OpenAICompatibleResponseBody}> {
  if (!response.ok) return {response};

  try {
    const body = await response.clone().json() as OpenAICompatibleResponseBody;
    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason;
    if (typeof content !== 'string') return {response, body};

    // FluentRead 只消费文本。这里重建旧适配器接受的最小响应结构，避免非标准可选元数据
    // （例如字符串形式的 token 数量）导致 SDK 拒绝原本有效的翻译；有效数值 usage
    // 会继续交给 SDK，并同时由本地统计观察器读取。
    const normalizedBody: Record<string, unknown> = {
      choices: [{
        message: {role: 'assistant', content},
        finish_reason: typeof finishReason === 'string' ? finishReason : null,
      }],
    };
    const sanitizedUsage = sanitizeUsageForAiSdk(body.usage);
    if (sanitizedUsage) normalizedBody.usage = sanitizedUsage;
    if (typeof body.model === 'string' && body.model.trim()) normalizedBody.model = body.model.trim();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json');
    // 克隆已读完且下游改读重建响应，原始 tee 分支不会再被消费；立即丢弃其缓存。
    cancelUnreadResponseBody(response);
    return {
      response: new Response(JSON.stringify(normalizedBody), {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      body,
    };
  } catch {
    return {response};
  }
}

function compatibilityFetch(
  endpoint: ResolvedOpenAICompatibleEndpoint,
  request: AiSdkTranslationRequest,
  requestedModel: string,
  compactBatch: boolean,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let startedAt: number | undefined;
    let result: {
      response: Response;
      normalized: Awaited<ReturnType<typeof normalizeSuccessfulTextResponse>>;
      cooldownError?: TranslationRequestCooldownError | void;
    };
    try {
      const schedulerContext = getTranslationRequestScheduler(request);
      const identity = {...schedulerContext?.identity,
        service: request.serviceOverride || schedulerContext?.identity?.service, model: requestedModel};
      const fetchAttempt = (attemptLease?: TranslationRequestLease) => {
        startedAt = Date.now();
        // 使用独立的传输 signal：错误正文超限时可终止真实 fetch，且不把这次局部
        // 终止误当作调用方取消（原始 signal 仍负责调度和错误归属）。
        const callerSignal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
        const transport = new AbortController();
        const onAbort = () => transport.abort(callerSignal?.reason);
        if (callerSignal?.aborted) onAbort();
        else callerSignal?.addEventListener('abort', onAbort, {once: true});
        let drained: Promise<void> | undefined;
        const settlement = (async () => {
          const upstream = await runtimeFetch(endpoint.exactEndpoint || input, {...init, signal: transport.signal}, {
            errorBodyLimit: OPENAI_ERROR_BODY_LIMIT,
          });
          const cooldownError = schedulerContext?.scheduler.observeResponse(
            identity, upstream, attemptLease ?? schedulerContext.lease, schedulerContext.deadlineAt,
          );
          let response = upstream;
          if (!response.ok) {
            const bounded = boundErrorResponse(response, callerSignal ?? undefined, () => transport.abort());
            drained = bounded.drained;
            response = await bounded.result;
          }
          const normalized = await normalizeSuccessfulTextResponse(response);
          return {response, normalized, cooldownError};
        })();
        // 给调用方返回有界错误不代表不合作的底层传输已结束；同时持有真实
        // attempt 与旧外层槽直到原 reader 的 EOF/异常，不由超时提前释放槽位。
        const lifecycle = settlement.then(
          async value => {await drained; return value;},
          async error => {await drained; throw error;},
        ).finally(() => callerSignal?.removeEventListener('abort', onAbort));
        attemptLease?.holdUntil(lifecycle);
        schedulerContext?.lease?.holdUntil(lifecycle);
        void lifecycle.catch(() => undefined);
        return settlement;
      };
      result = schedulerContext
        ? await schedulerContext.scheduler.scheduleAttempt(fetchAttempt, {
            signal: init?.signal ?? undefined,
            identity,
            deadlineAt: schedulerContext.deadlineAt,
            countConcurrency: Boolean(schedulerContext.identity?.quotaScope),
          })
        : await fetchAttempt();
    } catch (error) {
      if (startedAt !== undefined) reportTranslationModelUsage(request, {
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        actualModel: requestedModel,
        outcome: init?.signal?.aborted ? 'cancelled' : 'error',
        usageAvailability: 'unreported',
      });
      throw error;
    }

    const {response, normalized, cooldownError} = result;
    const observedStart = startedAt ?? Date.now();
    const choice = normalized.body?.choices?.[0];
    const outputLimited = compactBatch && choice?.finish_reason === 'length';
    const outputUnavailable = compactBatch && (choice?.finish_reason === 'content_filter'
      || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call'
      || (typeof choice?.message?.refusal === 'string' && Boolean(choice.message.refusal.trim())));
    const usage = normalizeOpenAICompatibleUsage(normalized.body?.usage, normalized.body?.model ?? requestedModel);
    reportTranslationModelUsage(request, {
      ...usage,
      startedAt: observedStart,
      durationMs: Math.max(0, Date.now() - observedStart),
      outcome: response.status === 408 ? 'timeout' : response.ok && !outputLimited && !outputUnavailable ? 'success' : 'error',
      statusCode: response.status,
    });
    if (cooldownError) {
      cancelUnreadResponseBody(response);
      throw cooldownError;
    }
    if (outputLimited || outputUnavailable) {
      cancelUnreadResponseBody(normalized.response);
      throw new LlmTransportError(outputLimited ? 'AI 批量译文被截断' : '当前翻译服务未返回可用的译文', {
        kind: 'response', retryable: false,
        ...(outputLimited ? {code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'} : {}),
      });
    }
    if (!response.ok && getTranslationImageInput(request)) {
      const error = await createImageInputHttpError(response);
      if ((error as {imageInputUnsupported?: boolean}).imageInputUnsupported) {
        cancelUnreadResponseBody(response);
        throw error;
      }
    }
    return normalized.response;
  };
}

function normalizedTimeout(value: number | undefined, configuredTimeout: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return normalizeAiRequestTimeoutMs(configuredTimeout);
  // 显式数值可能是事务剩余预算，不能使用设置的最小值抬高，也不能按旧 120 秒上限截断。
  return Math.max(1, Math.floor(value));
}

function createRequestAbortContext(timeoutMs: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  let abortedByCaller = false;
  const onCallerAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, {once: true});

  // 避免依赖 AI SDK 的 AbortSignal.timeout，使扩展在支持 AbortController、
  // 但尚不支持该新辅助方法的浏览器中仍能使用。
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    abortedByCaller: () => abortedByCaller,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export interface OpenAICompatibleCall {
  readonly endpoint: ResolvedOpenAICompatibleEndpoint;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly requestBody: Record<string, unknown>;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly signal: AbortSignal;
  readonly maxRetries: number;
}

export interface OpenAICompatibleExecution {
  run(call: OpenAICompatibleCall): Promise<string>;
  normalizeError(service: string, error: unknown, secrets: readonly string[], callerAborted: boolean): LlmTransportError;
}

/** 执行和归一错误先于外层 finally 清理，避免异常分支改变调用方取消归属。 */
async function runPreparedRequest(
  call: OpenAICompatibleCall,
  execution: OpenAICompatibleExecution,
  service: string,
  secrets: readonly string[],
  callerAborted: () => boolean,
  compactBatch: boolean,
): Promise<string> {
  try {
    const raw = await execution.run(call) || '';
    // JSON 字符串内可能包含字面 <think>，由批次解析器仅移除外层推理。
    if (compactBatch) return raw;
    const text = contentPostHandler(raw);
    if (!text) throw new LlmTransportError('翻译服务已响应，但没有返回有效译文。', {kind: 'response', retryable: false});
    return text;
  } catch (error) {
    throw error instanceof LlmTransportError || error instanceof TranslationRequestCooldownError
      || (error as {imageInputUnsupported?: boolean})?.imageInputUnsupported
      ? error : execution.normalizeError(service, error, secrets, callerAborted());
  }
}

async function translateSingle(
  request: AiSdkTranslationRequest,
  service: string,
  origin: string,
  current: TranslationProviderConfigSnapshot,
  execution: OpenAICompatibleExecution,
): Promise<string> {
  let endpoint: ResolvedOpenAICompatibleEndpoint;
  try {
    endpoint = resolveOpenAICompatibleEndpoint(service, current);
  } catch (error) {
    throw new LlmTransportError(
      error instanceof Error ? error.message : String(error),
      {kind: 'bad-request', retryable: false},
    );
  }
  const customHeaders = parseCustomHeaders(isCustomOpenAIProviderId(service) ? current.customHeaders?.[service] : undefined);
  if (!customHeaders) throw new LlmTransportError('自定义请求头必须是有效的 JSON 对象，头名称和值必须符合 HTTP 格式。', {
    kind: 'bad-request', retryable: false,
  });
  const apiKey = current.token[service]?.trim() || '';
  const imageInput = getTranslationImageInput(request);
  const body = buildOpenAIChatPayload({
      origin,
      context: request.pageContext,
      subtitleContext: request.subtitleContext,
      prompt: request.summaryPrompt,
      systemPrompt: request.summarySystemPrompt,
      serviceOverride: service,
      targetLanguage: request.targetLanguage,
      modelOverride: request.modelOverride,
      current,
      thinkingOverride: request.thinkingOverride,
      imageInput,
  });
  // 默认请求直接交给 transport 序列化；高级 JSON 保留原有线格式归一化。
  const payload = validatePayload(!imageInput && current.customBody?.[service]?.trim()
    ? JSON.parse(JSON.stringify(body)) : body);

  // 必须在 customBody 合并及 model 去空白之后处理，覆盖自定义模型、历史快照和
  // 自定义 OpenAI 服务直连官方 API；只改本次 payload，不改保存的别名及 Thinking 偏好。
  payload.model = resolveOfficialMimoModel(endpoint.endpoint, payload.model);

  // 协议的 stream 标记由 SDK 管理。自定义请求体仍可替换 model/messages，并添加任意
  // OpenAI 兼容 provider 字段，但不能绕过解析器把 generateText 调用切换为 SSE。
  const requestBody = normalizeChatCompletionRequest(endpoint.endpoint, {...payload, stream: false}, service);
  const compactBatch = current[TRANSLATION_COMPACT_BATCH] === true;
  const abortContext = createRequestAbortContext(
    normalizedTimeout(request.requestTimeoutMs, current.aiRequestTimeoutMs),
    request.abortSignal,
  );

  try {
    return await runPreparedRequest({
      endpoint,
      apiKey: service === services.azureOpenai ? undefined : apiKey || undefined,
      headers: providerHeaders(service, apiKey),
      requestBody,
      fetch: (input, init) => compatibilityFetch(endpoint, request, payload.model, compactBatch)(input, {
        ...init, headers: mergeCustomHeaders(init?.headers, customHeaders),
      }),
      signal: abortContext.signal,
      maxRetries: current.translationMaxRetries === undefined
        ? AI_SDK_MAX_RETRIES
        : normalizeTranslationMaxRetries(current.translationMaxRetries),
    }, execution, service,
    [apiKey, ...Object.values(customHeaders)], abortContext.abortedByCaller, compactBatch);
  } finally {
    abortContext.cleanup();
  }
}

export async function translateOpenAICompatible(
  request: AiSdkTranslationRequest,
  execution: OpenAICompatibleExecution,
): Promise<string | string[]> {
  const current = requireTranslationProviderConfig(request);
  const service = request.serviceOverride || current.service;
  const requestBudget = normalizedTimeout(request.requestTimeoutMs, current.aiRequestTimeoutMs);
  if (!Array.isArray(request.origin)) {
    return translateSingle({...request, requestTimeoutMs: requestBudget}, service, request.origin, current, execution);
  }

  // AI 服务很少接收批量消息，但图片翻译会提供这类输入。每次仅允许一个上游请求在途，
  // 避免单个后台队列租约绕过 FluentRead 的并发上限。
  const translations: string[] = [];
  const deadline = Date.now() + requestBudget;
  for (const origin of request.origin) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LlmTransportError('当前翻译服务请求超时，请稍后重试。', {
        kind: 'timeout',
        retryable: true,
      });
    }
    translations.push(await translateSingle(
      {...request, requestTimeoutMs: remaining},
      service,
      origin,
      current,
      execution,
    ));
  }
  return translations;
}
