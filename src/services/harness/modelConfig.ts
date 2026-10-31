/**
 * @file src/services/harness/modelConfig.ts
 * 文件职责：集中定义阅读模型的配置快照、请求身份与供应商认证规则，供扩展和脚本共用。
 * 主要内容：规范化端点、请求头、Chat Completions 自定义生成参数与输出上限、思考开关和智谱签名，计算模型输入指纹，并对供应商错误中的凭据与网址参数脱敏。
 * 模块边界：只处理配置与错误值，不初始化 AI SDK、不发送网络请求；具体传输和密钥轮换由各运行环境的生成适配器负责。
 */
import hmacSha256 from 'crypto-js/hmac-sha256';
import base64 from 'crypto-js/enc-base64';
import type {Config} from '@/src/core/config/model';
import {currentModelIds, services} from '@/src/core/config/catalog';
import {tongyiTokenPlanUrl, urls} from '@/src/core/config/constants';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {parseChatCompletionsEndpoint, resolveOpenAICompatibleEndpoint, type ResolvedOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {normalizeLlmTransportError} from '@/src/providers/translation/ai-sdk/transport-errors';
import {isHarnessService} from '@/src/core/config/harness';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {normalizeChatCompletionRequest} from '@/src/providers/translation/ai-sdk/chatCompletionRequest';
import {parseCustomBody} from '@/src/core/config/customBody';
import {parseCustomHeaders} from '@/src/core/config/customHeaders';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {isApiKeyRequired} from '@/src/core/config/validation';
import {normalizeApiKeyRecoveryMs} from '@/src/core/config/scheduling';
import {sha256Hex} from '@/src/shared/function/sha256';

export function zhipuBearer(apiKey: string): string {
  const [key, secret] = apiKey.split('.', 2);
  if (!key || !secret) throw new Error('智谱 API Key 格式不正确，应为 id.secret');
  const encode = (value: string) => btoa(value).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  const header = encode(JSON.stringify({alg: 'HS256', sign_type: 'SIGN', typ: 'JWT'}));
  const payload = encode(JSON.stringify({api_key: key, exp: Math.floor(Date.now() / 1000) + 86_400, timestamp: Math.floor(Date.now() / 1000)}));
  const signature = hmacSha256(`${header}.${payload}`, secret).toString(base64)
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  return `${header}.${payload}.${signature}`;
}

export function endpointFor(config: Config, service: string, model: string): ResolvedOpenAICompatibleEndpoint {
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

export function serviceHeaders(service: string, apiKey: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (service === services.azureOpenai && apiKey) headers['api-key'] = apiKey;
  if (service === services.openrouter) {
    headers['HTTP-Referer'] = 'https://fluent.thinkstu.com';
    headers['X-Title'] = 'FluentRead Harness';
  }
  return Object.keys(headers).length ? headers : undefined;
}

export function transformBody(service: string, config: Config, model: string, body: Record<string, unknown>, endpoint: string): Record<string, unknown> {
  const custom = parseCustomBody(config.customBody[service]);
  if (!custom) throw new Error('自定义请求体必须是有效的 JSON 对象');
  // 兼容服务均遵循顶层用户参数优先；会话和协议字段仍由调用方管理。
  const parameters = {...custom};
  for (const key of ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'response_format']) {
    delete parameters[key];
  }
  // null 不作为禁用预算的哨兵，避免重新发送被拒绝的旧字段或丢失功能默认预算。
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (parameters[key] == null) delete parameters[key];
  }
  const defaults = service === services.deepseek
    ? {...body, thinking: {type: isModelThinkingEnabled(config.modelThinking, service, model) ? 'enabled' : 'disabled'}}
    : body;
  return normalizeChatCompletionRequest(endpoint, {...defaults, ...parameters});
}

/** 将 provider 错误归一为不泄露 API Key 的用户可见错误。 */
export function sanitizeHarnessModelMessage(message: string): string {
  return message.replace(
    /([?&](?:api[_-]?key|token|secret|access[_-]?token|authorization)=)[^&\s]+/giu,
    '$1[已隐藏]',
  );
}

export function snapshotHarnessConfig(config: Config): Config {
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
    !native ? config.customBody[service] : null,
    service, requestedModel, isHarnessService(service, config.customOpenAIProviders), endpoint,
    headers ? Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)) : null,
    rotating ? keys : [keys[0] ?? ''], rotating, rotating ? normalizeApiKeyRecoveryMs(config.apiKeyRecoveryMs) : null,
    isApiKeyRequired(service, {...config, model: {...config.model, [service]: requestedModel}}) && !config.token[service]?.trim(),
    service === services.deepseek && isModelThinkingEnabled(config.modelThinking, service, requestedModel),
  ]));
}

export function normalizeHarnessTransportError(
  error: unknown, service: string, apiKey = '', customHeaders?: string,
  normalize: (service: string, error: unknown, secrets: readonly string[]) => Error = normalizeLlmTransportError,
): Error {
  const normalized = normalize(service, error, [apiKey, ...Object.values(parseCustomHeaders(customHeaders) ?? {})]);
  normalized.message = sanitizeHarnessModelMessage(normalized.message);
  return normalized;
}
