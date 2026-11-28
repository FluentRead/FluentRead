/**
 * @file src/providers/translation/microsoft.ts
 *
 * 文件职责：适配 Edge Microsoft 免费翻译端点，支持单条与批量文本并保留受控 HTML 片段。
 * 主要内容：映射源/目标语言，按冻结的服务合批偏好分组并对文本进行 HTML 转义，调用 translatetext，将后台或免费池并发租约传到真实 HTTP 和正文读取，解析 translations 数组并按原批次还原结果；导出 translateMicrosoftTexts。 可核对的公开符号包括 translateMicrosoftTexts、default:microsoft。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {getTranslationProviderLanguages, getTranslationRequestScheduler, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationLanguageOverride} from '@/src/core/translation/languages';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {translateMicrosoftTextsWithTransport, type MicrosoftTranslationLease} from './microsoftTransport';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';

export async function translateMicrosoftTexts(
    texts: string[],
    fromLang: string,
    toLang: string,
    abortSignal?: AbortSignal,
    enableNativeBatch = true,
    lease?: MicrosoftTranslationLease,
): Promise<string[]> {
    return translateMicrosoftTextsWithTransport(runtimeFetch, texts, fromLang, toLang, abortSignal, enableNativeBatch, lease);
}

async function microsoft(message: TranslationProviderRequest & TranslationLanguageOverride) {
    const origin = message.origin;
    const isSingleText = typeof origin === 'string';
    const texts: string[] = isSingleText ? [origin] : origin;
    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const current = requireTranslationProviderConfig(message);
    const enableNativeBatch = message.enableNativeBatch
        ?? isNativeTranslationBatchEnabled('microsoft', current.nativeBatchTranslationEnabled);
    const translations = await translateMicrosoftTexts(texts, sourceLanguage, targetLanguage, message.abortSignal,
        enableNativeBatch, getTranslationRequestScheduler(message)?.lease);
    if (!isSingleText) return translations;

    // The shared transport has already validated one output per input, including blank slots.
    return translations[0]!;
}

export default microsoft;
