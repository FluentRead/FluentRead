/**
 * @file src/services/translation/capabilities.ts
 *
 * 文件职责：把浏览器能力映射为翻译服务可用性，为无法接入设备端翻译接口的浏览器提供提示。
 * 主要内容：声明不可用提示，分别判断 provider 的等长数组契约和真正的原生多文本 HTTP 协议，原生服务名单复用纯配置领域规则；只有原生接口才允许自动合并网页候选，逐项执行的数组适配器仍可用于文档等显式批次。根据 BrowserCapabilities 过滤不可用服务，ChatGPT 套餐本机实验仅在显式启用的开发扩展中可用，公开版本保留旧配置但不开放选择和请求，不把用户合批偏好或 AI 多段开关当成机器翻译能力。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {services, servicesType} from '@/src/core/config/catalog';
import {isNativeBatchTranslationService} from '@/src/core/config/nativeBatch';
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode';
import {
    browserCapabilities,
    type BrowserCapabilities,
} from '@/src/platform/browser/capabilities';

export const BROWSER_TRANSLATOR_UNAVAILABLE_MESSAGE =
    '当前环境无法使用浏览器内置翻译，请选择其他翻译服务。';
export const LOCAL_TRANSLATION_UNAVAILABLE_MESSAGE =
    '当前浏览器不支持扩展本地模型翻译；原配置会保留，请切换到其他翻译服务。';
export const CHATGPT_PLAN_UNAVAILABLE_MESSAGE =
    'ChatGPT 套餐尚未开放公开接入，请切换到其他服务；已保存的配置会保留。';

const ARRAY_TRANSLATION_SERVICES = new Set<string>([
    services.freeTranslation,
    services.bilibili,
    services.chatgptPlan,
]);

/** 已实现供应商原生多文本请求与完整响应校验，允许自动合批；与 AI 多段开关无关。 */
export function supportsNativeTranslationBatch(service: string): boolean {
    return isNativeBatchTranslationService(service);
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
    if (service === services.chromeTranslator) return capabilities.browserTranslation;
    if (service === services.localTranslation) return capabilities.extensionDom;
    if (service === services.chatgptPlan) return chatGPTPlanDevelopmentEnabled && capabilities.browser !== 'userscript';
    return true;
}

export function getTranslationServiceUnavailableMessage(
    service: string,
    capabilities: BrowserCapabilities = browserCapabilities,
): string | null {
    if (isTranslationServiceAvailable(service, capabilities)) return null;
    if (service === services.chatgptPlan) return capabilities.browser === 'userscript'
        ? 'ChatGPT 套餐暂不可用；脚本版不支持此服务，请切换到其他翻译服务。'
        : CHATGPT_PLAN_UNAVAILABLE_MESSAGE;
    if (service === services.localTranslation) return LOCAL_TRANSLATION_UNAVAILABLE_MESSAGE;
    switch (capabilities.browser) {
        case 'chrome':
            return '当前 Chrome 未开放内置翻译接口。请使用桌面版 Chrome 138 或更新版本，并检查浏览器管理策略。';
        case 'edge':
            return '当前 Edge 未开放内置翻译接口。请使用桌面版 Edge 148 或更新版本，并检查浏览器管理策略。';
        case 'firefox':
            return 'Firefox 的本地翻译可从浏览器菜单使用，扩展暂无法调用。若要在 FluentRead 中离线翻译，请选择「本地模型翻译」。';
        default:
            return BROWSER_TRANSLATOR_UNAVAILABLE_MESSAGE;
    }
}

export function filterAvailableTranslationServices<TOption extends {readonly value: string}>(
    options: readonly TOption[],
    capabilities: BrowserCapabilities = browserCapabilities,
): TOption[] {
    return options.filter((option) => isTranslationServiceAvailable(option.value, capabilities));
}
