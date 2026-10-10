/**
 * @file src/services/translation/capabilities.ts
 *
 * 文件职责：把浏览器能力映射为翻译服务可用性，防止不支持的平台展示或调用 Chrome 内置翻译。
 * 主要内容：声明不可用提示，分别判断 provider 的等长数组契约和真正的原生多文本 HTTP 协议；只有原生接口才自动合并网页候选，逐项执行的数组适配器仍可用于文档等显式批次。根据 BrowserCapabilities 过滤不可用服务，不把 AI 多段开关当成机器翻译能力。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {services, servicesType} from '@/src/core/config/catalog';
import {
    browserCapabilities,
    type BrowserCapabilities,
} from '@/src/platform/browser/capabilities';

export const CHROME_TRANSLATOR_UNAVAILABLE_MESSAGE =
    '当前浏览器暂不支持 Chrome 内置翻译；原配置会保留，请切换到其他翻译服务。';
export const LOCAL_TRANSLATION_UNAVAILABLE_MESSAGE =
    '当前浏览器不支持扩展本地模型翻译；原配置会保留，请切换到其他翻译服务。';

const NATIVE_BATCH_TRANSLATION_SERVICES = new Set<string>([
    services.microsoft,
    services.google,
    services.deepL,
    services.azureTranslator,
    services.googleCloudTranslation,
]);

const ARRAY_TRANSLATION_SERVICES = new Set<string>([
    services.freeTranslation,
    services.bilibili,
]);

/** 已实现供应商原生多文本请求与完整响应校验，允许自动合批；与 AI 多段开关无关。 */
export function supportsNativeTranslationBatch(service: string): boolean {
    return NATIVE_BATCH_TRANSLATION_SERVICES.has(service);
}

/**
 * 只有明确实现 string[] -> string[] 契约的 provider 才能接收批量 origin。
 * 部分免费 provider 和 AI SDK 会逐条执行并返回等长数组，这不等于一次原生 HTTP 合批。
 * 其余 legacy provider 仍是单条协议，不能依赖隐式数组转字符串。
 */
export function supportsTranslationBatch(service: string): boolean {
    return supportsNativeTranslationBatch(service) || ARRAY_TRANSLATION_SERVICES.has(service)
        || servicesType.isAiSdk(service);
}

/**
 * 统一编排在发送前保护命中术语、返回后填回译法，机器翻译与 AI 共用同一契约。
 */
export function supportsTranslationGlossary(
    service: string,
    model = '',
    serviceTypes: Pick<typeof servicesType, 'isUseAIContext'> = servicesType,
): boolean {
    return serviceTypes.isUseAIContext(service, model)
        || servicesType.isAI(service) || servicesType.isMachine(service);
}

export function isTranslationServiceAvailable(
    service: string,
    capabilities: BrowserCapabilities = browserCapabilities,
): boolean {
    if (service === services.chromeTranslator) return capabilities.chromeTranslation;
    if (service === services.localTranslation) return capabilities.extensionDom;
    return true;
}

export function getTranslationServiceUnavailableMessage(
    service: string,
    capabilities: BrowserCapabilities = browserCapabilities,
): string | null {
    if (isTranslationServiceAvailable(service, capabilities)) return null;
    return service === services.localTranslation
        ? LOCAL_TRANSLATION_UNAVAILABLE_MESSAGE
        : CHROME_TRANSLATOR_UNAVAILABLE_MESSAGE;
}

export function filterAvailableTranslationServices<TOption extends {readonly value: string}>(
    options: readonly TOption[],
    capabilities: BrowserCapabilities = browserCapabilities,
): TOption[] {
    return options.filter((option) => isTranslationServiceAvailable(option.value, capabilities));
}
