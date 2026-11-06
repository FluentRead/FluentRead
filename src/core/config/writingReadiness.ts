/**
 * @file src/core/config/writingReadiness.ts
 * 服务启用：独立或继承的关闭服务统一作为不可用处理，设置、网页与后台共享同一阻止规则。
 * 文件职责：统一写作设置、网页卡片与后台请求的本地配置检查。
 * 主要内容：解析独立或继承的服务模型，区分未选择 AI、调用方声明的平台不可用、缺少模型和缺少必要密钥；网页公开配置仅检查服务模型，完整凭据检查留给可信设置页和后台。
 * 模块边界：只读取传入配置，不检查网络、不暴露凭据，也不把配置齐全表述为服务连接成功。
 */
import type {Config} from './model';
import {resolveConfiguredModel} from './catalog';
import {isHarnessService} from './harness';
import {isApiKeyRequired} from './validation';
import {isTranslationServiceDisabled, TRANSLATION_SERVICE_DISABLED_MESSAGE} from './serviceAvailability';

export function resolveWritingReadiness(config: Config, checkCredentials = true, unavailableMessage: string | null = null) {
    const service = config.writing.service || config.service;
    if (isTranslationServiceDisabled(config.disabledTranslationServices, service)) unavailableMessage = TRANSLATION_SERVICE_DISABLED_MESSAGE;
    const model = (config.writing.model || resolveConfiguredModel(config.model[service], config.customModel[service])).trim();
    const supported = isHarnessService(service, config.customOpenAIProviders);
    const issue = !supported ? 'service' : unavailableMessage ? 'unavailable' : !model ? 'model'
        : checkCredentials && isApiKeyRequired(service, {...config, model: {...config.model, [service]: model}}) && !config.token[service]?.trim() ? 'credential' : null;
    const message = issue === 'service' ? '请在写作助手设置中选择一个 AI 服务'
        : issue === 'unavailable' ? unavailableMessage!
        : issue === 'model' ? '请先选择写作模型'
            : issue === 'credential' ? '请先在翻译服务中配置这个服务的 API Key' : '';
    return {service, model, supported, issue, message, ready: issue === null};
}
