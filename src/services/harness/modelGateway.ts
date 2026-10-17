/**
 * @file src/services/harness/modelGateway.ts
 * 文件职责：把已配置的 FluentRead AI 服务适配为 Harness 可消费的 LanguageModel。
 * 主要内容：解析 OpenAI 兼容端点、注入凭据与供应商头、保留 tools/messages/system
 * 语义，直连官方 MiMo 时兼容退役编号而保留配置值，单独适配固定端点与模型的 B站匿名讲解，并对未开放的 ChatGPT 套餐、DeepSeek Responses 配置和其他机器翻译服务给出明确错误。
 * 模块边界：本文件只负责模型 transport，不管理会话、UI、提示词、缓存或配置持久化；
 * 请求由 AI SDK 执行，网络统一经过 runtimeFetch。
 */
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import type {LanguageModel} from 'ai';
import hmacSha256 from 'crypto-js/hmac-sha256';
import base64 from 'crypto-js/enc-base64';
import type {Config} from '@/src/core/config/model';
import {currentModelIds, services} from '@/src/core/config/catalog';
import {tongyiTokenPlanUrl, urls} from '@/src/core/config/constants';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {
  parseChatCompletionsEndpoint,
  resolveOpenAICompatibleEndpoint,
  resolveOfficialMimoModel,
  type ResolvedOpenAICompatibleEndpoint,
} from '@/src/providers/translation/ai-sdk/endpoints';
import {isHarnessService} from '@/src/core/config/harness';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {parseCustomHeaders, mergeCustomHeaders} from '@/src/core/config/customHeaders';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {runWithApiKeyRotation, withServiceApiKey} from '@/src/services/translation/apiKeyRotation';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {isApiKeyRequired} from '@/src/core/config/validation';
import {normalizeApiKeyRecoveryMs} from '@/src/core/config/scheduling';
import {sha256Hex} from '@/src/shared/function/sha256';
import {createChatGPTPlanHarnessModel} from './chatgptPlanModel';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';

function zhipuBearer(apiKey: string): string {
  const [key, secret] = apiKey.split('.', 2);
  if (!key || !secret) throw new Error('智谱 API Key 格式不正确，应为 id.secret');
  const encode = (value: string) => btoa(value).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  const header = encode(JSON.stringify({alg: 'HS256', sign_type: 'SIGN', typ: 'JWT'}));
  const payload = encode(JSON.stringify({api_key: key, exp: Math.floor(Date.now() / 1000) + 86_400, timestamp: Math.floor(Date.now() / 1000)}));
  const signature = hmacSha256(`${header}.${payload}`, secret).toString(base64)
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  return `${header}.${payload}.${signature}`;
}

function endpointFor(config: Config, service: string, model: string): ResolvedOpenAICompatibleEndpoint {
  if (service === services.deepseek) {
    if (config.deepseekApiType === 'responses') {
      throw new Error('DeepSeek Responses 配置不能用于阅读助手，请改用 Chat Completion 或自定义接口');
    }
    return parseChatCompletionsEndpoint(config.proxy[service]?.trim() || urls[service], `${service} 阅读助手接口地址`);
  }
  if (service === services.tongyi) {
    return parseChatCompletionsEndpoint(config.proxy[service]?.trim() || (model === currentModelIds.tongyiTokenPlan ? tongyiTokenPlanUrl : urls[service]), `${service} 阅读助手接口地址`);
  }
  if (service === services.zhipu) {
    return parseChatCompletionsEndpoint(config.proxy[service]?.trim() || urls[service], `${service} 阅读助手接口地址`);
  }
  return resolveOpenAICompatibleEndpoint(service, config);
}

function serviceHeaders(service: string, apiKey: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (service === services.azureOpenai && apiKey) headers['api-key'] = apiKey;
  if (service === services.openrouter) {
    headers['HTTP-Referer'] = 'https://fluent.thinkstu.com';
    headers['X-Title'] = 'FluentRead Harness';
  }
  return Object.keys(headers).length ? headers : undefined;
}

function nativeFetch(config: Config, service: string) {
  const proxy = config.proxy[service]?.trim();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    runtimeFetch(proxy || input, {...init, redirect: 'error'});
}

function transformBody(service: string, config: Config, model: string, body: Record<string, unknown>): Record<string, unknown> {
  if (service !== services.deepseek) return body;
  return {
    ...body,
    thinking: {type: isModelThinkingEnabled(config.modelThinking, service, model) ? 'enabled' : 'disabled'},
  };
}

/** 将 provider 错误归一为不泄露 API Key 的用户可见错误。 */
export function sanitizeHarnessModelMessage(message: string): string {
  return message.replace(
    /([?&](?:api[_-]?key|token|secret|access[_-]?token|authorization)=)[^&\s]+/giu,
    '$1[已隐藏]',
  );
}

export function normalizeHarnessModelError(error: unknown, service: string, apiKey = '', customHeaders?: string): Error {
  const normalized = normalizeAiSdkError(service, error, [apiKey, ...Object.values(parseCustomHeaders(customHeaders) ?? {})]);
  const sanitized = sanitizeHarnessModelMessage(normalized.message);
  normalized.message = sanitized;
  return normalized;
}

/**
 * 创建可执行文本生成及工具调用的 LanguageModel。调用方传入的 messages、system、tools
 * 会原样交给 AI SDK；这里不注入翻译 prompt，也不改写会话语义。
 */
type ConcreteLanguageModel = Extract<LanguageModel, {specificationVersion: 'v3'}>;

function createSingleHarnessLanguageModel(config: Config, service: string, model: string): ConcreteLanguageModel {
  if (service === services.chatgptPlan) return createChatGPTPlanHarnessModel(model);
  if (service === services.bilibili) {
    // 免费入口只使用已验证的官方模型；残留凭据、代理、多 Key 和自定义模型均不参与请求。
    const provider = createOpenAICompatible({
      name: 'fluentread-harness-bilibili',
      baseURL: `https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1`,
      transformRequestBody: body => ({
        model: BILIBILI_FREE_TRANSLATION_MODEL,
        messages: body.messages,
        stream: body.stream,
        max_tokens: body.max_tokens,
        temperature: 0,
        chat_template_kwargs: {enable_thinking: false},
      }),
      fetch: (input, init) => runtimeFetch(input, {...init, credentials: 'omit', redirect: 'error'}),
    });
    return provider(BILIBILI_FREE_TRANSLATION_MODEL);
  }
  const requestedModel = model.trim();
  if (!requestedModel) throw new Error('请先为阅读助手选择一个模型');
  if (!isHarnessService(service, config.customOpenAIProviders)) throw new Error(`阅读助手尚未适配这个服务: ${service}`);

  const configuredKey = config.token[service]?.trim() || '';
  if (service === services.claude) {
    const provider = createAnthropic({
      name: 'fluentread-harness-claude',
      apiKey: configuredKey || undefined,
      headers: {'anthropic-dangerous-direct-browser-access': 'true'},
      fetch: nativeFetch(config, service),
    });
    return provider(requestedModel) as ConcreteLanguageModel;
  }
  if (service === services.gemini) {
    const provider = createGoogleGenerativeAI({
      name: 'fluentread-harness-gemini',
      apiKey: configuredKey || undefined,
      fetch: nativeFetch(config, service),
    });
    return provider(requestedModel);
  }
  const customHeaders = parseCustomHeaders(isCustomOpenAIProviderId(service) ? config.customHeaders[service] : undefined);
  if (!customHeaders) throw new Error('自定义请求头必须是有效的 JSON 对象，头名称和值必须符合 HTTP 格式。');
  const endpoint = endpointFor(config, service, requestedModel);
  const apiKey = service === services.zhipu && configuredKey ? zhipuBearer(configuredKey) : configuredKey;
  const provider = createOpenAICompatible({
    name: `fluentread-harness-${service}`,
    baseURL: endpoint.baseURL,
    apiKey: service === services.azureOpenai ? undefined : apiKey || undefined,
    headers: serviceHeaders(service, configuredKey),
    queryParams: endpoint.queryParams,
    transformRequestBody: body => transformBody(service, config, requestedModel, body),
    fetch: async (input, init) => runtimeFetch(endpoint.exactEndpoint || input, {
      ...init, headers: mergeCustomHeaders(init?.headers, customHeaders), redirect: 'error',
    }),
  });
  return provider(resolveOfficialMimoModel(endpoint.endpoint, requestedModel));
}

type LanguageModelGenerateOptions = Parameters<ConcreteLanguageModel['doGenerate']>[0];
type LanguageModelStreamOptions = Parameters<ConcreteLanguageModel['doStream']>[0];

function snapshotHarnessConfig(config: Config): Config {
  return createTranslationProviderConfigSnapshot(config) as unknown as Config;
}

/** 后台取消只比较 gateway 的生效输入；摘要不包含可展示或发送的凭据。 */
export function getHarnessModelInputKey(config: Config, service: string, model: string): string {
  if (service === services.chatgptPlan) return sha256Hex(JSON.stringify([service, model.trim(), 'chatgpt-plan-local-oauth']));
  if (service === services.bilibili) return sha256Hex(JSON.stringify([service, BILIBILI_FREE_TRANSLATION_MODEL, BILIBILI_FREE_TRANSLATION_DOMAIN]));
  const requestedModel = model.trim();
  const keys = getServiceApiKeys(config, service);
  const rotating = keys.length > 1 && config.apiKeyRotationEnabled[service] !== false;
  const native = service === services.claude || service === services.gemini;
  let endpoint: unknown;
  try { endpoint = native ? config.proxy[service]?.trim() || null : endpointFor(config, service, requestedModel); }
  catch { endpoint = 'invalid'; }
  const headers = !native && isCustomOpenAIProviderId(service) ? parseCustomHeaders(config.customHeaders[service]) : {};
  return sha256Hex(JSON.stringify([
    service, requestedModel, isHarnessService(service, config.customOpenAIProviders), endpoint,
    headers ? Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)) : null,
    rotating ? keys : [keys[0] ?? ''], rotating, rotating ? normalizeApiKeyRecoveryMs(config.apiKeyRecoveryMs) : null,
    isApiKeyRequired(service, {...config, model: {...config.model, [service]: requestedModel}}) && !config.token[service]?.trim(),
    service === services.deepseek && isModelThinkingEnabled(config.modelThinking, service, requestedModel),
  ]));
}

/**
 * 创建可执行文本生成及工具调用的 LanguageModel。多 Key 服务按每次调用冻结的配置
 * 重新创建底层 provider，避免某次调用中途读取到 UI 正在编辑的凭据。
 */
export function createHarnessLanguageModel(config: Config, service: string, model: string): LanguageModel {
  if (service === services.chatgptPlan) {
    const unavailable = getTranslationServiceUnavailableMessage(service);
    if (unavailable) throw Object.assign(new Error(unavailable), {kind: 'bad-request', retryable: false});
    return createSingleHarnessLanguageModel(config, service, model);
  }
  if (service === services.bilibili) return createSingleHarnessLanguageModel(config, service, model);
  const keys = getServiceApiKeys(config, service);
  if (keys.length < 2) return createSingleHarnessLanguageModel(withServiceApiKey(config, service, keys[0] ?? ''), service, model);

  const frozenConfig = snapshotHarnessConfig(config);
  const baseModel = createSingleHarnessLanguageModel(frozenConfig, service, model);
  const operationConfig = () => {
    const headers = isCustomOpenAIProviderId(service) ? parseCustomHeaders(frozenConfig.customHeaders[service]) : undefined;
    return [...keys, ...Object.values(headers ?? {})];
  };
  const invoke = async <R>(operation: (selected: Config) => Promise<R>, signal?: AbortSignal): Promise<R> => runWithApiKeyRotation(
    frozenConfig,
    service,
    async selected => {
      try { return await operation(selected); }
      catch (error) {
        const normalized = normalizeAiSdkError(service, error, operationConfig());
        normalized.message = sanitizeHarnessModelMessage(normalized.message);
        throw normalized;
      }
    },
    {signal, model},
  );
  const wrapped = new Proxy(baseModel, {
    get(target, property) {
      if (property === 'doGenerate') return (options: LanguageModelGenerateOptions) => invoke(selected => Promise.resolve(createSingleHarnessLanguageModel(selected, service, model).doGenerate(options)), options.abortSignal);
      if (property === 'doStream') return (options: LanguageModelStreamOptions) => invoke(selected => Promise.resolve(createSingleHarnessLanguageModel(selected, service, model).doStream(options)), options.abortSignal);
      return Reflect.get(target, property, target);
    },
  }) as unknown as LanguageModel;
  return wrapped;
}
