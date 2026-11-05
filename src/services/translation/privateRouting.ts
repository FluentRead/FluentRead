/**
 * @file src/services/translation/privateRouting.ts
 * 文件职责：在共享翻译 broker 边界把可信无痕身份解析为独立的请求配置，而不是修改全局服务。
 * 主要内容：显式启用但缺少可信隐私身份时明确拒绝，userscript 编译目标始终保持未知身份并消融不可达专用路由；仅内部 sender 派生的隐私 symbol 为真时选用专用 AI 服务和模型；拒绝缺失或删除的服务、组合回退及空模型；拒绝非空自定义请求体，避免覆盖模型身份或静默丢弃连接参数。关闭本次共享译文及摘要缓存，保留服务自身的连接、凭据和限额，供缓存、调度、统计及 provider 共用。
 * 模块边界：不读取浏览器或 payload 自报字段，不保存配置，不调用网络，不处理阅读、写作或 OCR 的独立生成链路。
 */
import {resolveTranslationRequestModel} from '@/src/core/config/requestModel';
import {resolveOpenAICompatibleEndpoint, resolveOfficialMimoModel} from '@/src/providers/translation/ai-sdk/endpoints';
import {supportsPrivateTranslationService} from '@/src/core/config/privateTranslation';
import {getTranslationGlossaryContext} from './requestSnapshot';
import {TRANSLATION_PROVIDER_CONFIG, type TranslationProviderConfigSnapshot, type TranslationRequestMessage} from './types';

function privateRoutingError(message: string): Error {
    return Object.assign(new Error(message), {kind: 'bad-request', retryable: false, code: 'PRIVATE_TRANSLATION_UNAVAILABLE'});
}

export function resolvePrivateTranslation(
    config: TranslationProviderConfigSnapshot,
    request: TranslationRequestMessage,
): {config: TranslationProviderConfigSnapshot; request: TranslationRequestMessage} {
    const selected = config.privateTranslation;
    if (!selected?.enabled) return {config, request};
    const privateContext = getTranslationGlossaryContext(request)?.privateContext;
    // userscript 没有可信 sender.tab 身份；编译期明确拒绝，不携带不可达的专用 provider 路由。
    if (import.meta.env.BROWSER === 'userscript' || privateContext === undefined) throw privateRoutingError('无法确认窗口隐私身份，未调用翻译服务；请从可识别的浏览器标签页重试或关闭无痕专用模型');
    if (privateContext !== true) return {config, request};
    const service = selected.service.trim();
    const model = selected.model.trim();
    if (!supportsPrivateTranslationService(service, config.customOpenAIProviders)) {
        throw privateRoutingError('无痕专用翻译服务不可用，请在设置中重新选择；不会回退到普通翻译服务');
    }
    if (config.customBody[service]?.trim()) throw privateRoutingError('无痕专用翻译仅支持标准请求体，请选择未配置自定义请求体的连接；不会回退到普通模型');
    if (!model) throw privateRoutingError('请先配置无痕专用翻译模型；不会回退到普通翻译模型');
    let endpoint: string;
    try {endpoint = resolveOpenAICompatibleEndpoint(service, config).endpoint;}
    catch {throw privateRoutingError('无痕专用翻译连接地址无效，请检查连接设置');}
    const actualModel = resolveOfficialMimoModel(endpoint, resolveTranslationRequestModel(config, service, model));
    if (actualModel !== model) throw privateRoutingError('无痕专用翻译模型编号会被兼容规则改写，请填写最终模型编号；不会回退到普通模型');
    const effectiveConfig = Object.freeze({...config,
        service,
        // 既有持久缓存身份不携带隐私来源；专用无痕请求不读写译文或摘要缓存。
        useCache: false,
        model: Object.freeze({...config.model, [service]: model}),
        customModel: Object.freeze({...config.customModel, [service]: model}),
    });
    // 复制 descriptor 以保留不可枚举的取消、预算等内部契约；快照同步换成有效配置。
    const effective = Object.defineProperties({}, {...Object.getOwnPropertyDescriptors(request),
        [TRANSLATION_PROVIDER_CONFIG]: {value: effectiveConfig, enumerable: true, configurable: true, writable: true},
        serviceOverride: {value: service, enumerable: true, configurable: true, writable: true},
        modelOverride: {value: model, enumerable: true, configurable: true, writable: true},
    }) as TranslationRequestMessage;
    return {request: effective, config: effectiveConfig};
}
