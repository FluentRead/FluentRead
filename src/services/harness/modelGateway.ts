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
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {
  resolveOfficialMimoModel,
} from '@/src/providers/translation/ai-sdk/endpoints';
import {isHarnessService} from '@/src/core/config/harness';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {parseCustomHeaders, mergeCustomHeaders} from '@/src/core/config/customHeaders';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {runWithApiKeyRotation, withServiceApiKey} from '@/src/services/translation/apiKeyRotation';
import {createChatGPTPlanHarnessModel} from './chatgptPlanModel';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {endpointFor, zhipuBearer, serviceHeaders, transformBody, snapshotHarnessConfig, sanitizeHarnessModelMessage, normalizeHarnessTransportError} from './modelConfig';
export {getHarnessModelInputKey, sanitizeHarnessModelMessage} from './modelConfig';

function nativeFetch(config: Config, service: string) {
  const proxy = config.proxy[service]?.trim();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    runtimeFetch(proxy || input, {...init, redirect: 'error'});
}

export function normalizeHarnessModelError(error: unknown, service: string, apiKey = '', customHeaders?: string): Error {
  return normalizeHarnessTransportError(error, service, apiKey, customHeaders, normalizeAiSdkError);
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
    transformRequestBody: body => transformBody(service, config, requestedModel, body, endpoint.endpoint),
    fetch: async (input, init) => runtimeFetch(endpoint.exactEndpoint || input, {
      ...init, headers: mergeCustomHeaders(init?.headers, customHeaders), redirect: 'error',
    }),
  });
  return provider(resolveOfficialMimoModel(endpoint.endpoint, requestedModel));
}

type LanguageModelGenerateOptions = Parameters<ConcreteLanguageModel['doGenerate']>[0];
type LanguageModelStreamOptions = Parameters<ConcreteLanguageModel['doStream']>[0];

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
