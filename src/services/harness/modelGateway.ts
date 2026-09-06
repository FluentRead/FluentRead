/**
 * @file src/services/harness/modelGateway.ts
 * 文件职责：把已配置的 FluentRead AI 服务适配为 Harness 可消费的 LanguageModel。
 * 主要内容：解析 OpenAI 兼容端点、注入凭据与供应商头、保留 tools/messages/system
 * 语义，并对 DeepSeek Responses 配置和机器翻译服务给出明确错误。
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
  type ResolvedOpenAICompatibleEndpoint,
} from '@/src/providers/translation/ai-sdk/endpoints';
import {isHarnessService} from '@/src/core/config/harness';
import {runtimeFetch} from '@/src/platform/http/runtime';

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

export function normalizeHarnessModelError(error: unknown, service: string, apiKey = ''): Error {
  const normalized = normalizeAiSdkError(service, error, apiKey);
  const sanitized = sanitizeHarnessModelMessage(normalized.message);
  normalized.message = sanitized;
  return normalized;
}

/**
 * 创建可执行文本生成及工具调用的 LanguageModel。调用方传入的 messages、system、tools
 * 会原样交给 AI SDK；这里不注入翻译 prompt，也不改写会话语义。
 */
export function createHarnessLanguageModel(config: Config, service: string, model: string): LanguageModel {
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
    return provider(requestedModel);
  }
  if (service === services.gemini) {
    const provider = createGoogleGenerativeAI({
      name: 'fluentread-harness-gemini',
      apiKey: configuredKey || undefined,
      fetch: nativeFetch(config, service),
    });
    return provider(requestedModel);
  }
  const endpoint = endpointFor(config, service, requestedModel);
  const apiKey = service === services.zhipu && configuredKey ? zhipuBearer(configuredKey) : configuredKey;
  const provider = createOpenAICompatible({
    name: `fluentread-harness-${service}`,
    baseURL: endpoint.baseURL,
    apiKey: service === services.azureOpenai ? undefined : apiKey || undefined,
    headers: serviceHeaders(service, configuredKey),
    queryParams: endpoint.queryParams,
    transformRequestBody: body => transformBody(service, config, requestedModel, body),
    fetch: async (input, init) => runtimeFetch(endpoint.exactEndpoint || input, {...init, redirect: 'error'}),
  });
  return provider(requestedModel);
}
