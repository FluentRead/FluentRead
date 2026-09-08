/**
 * @file src/providers/translation/apertium.ts
 * 文件职责：接入 Apertium 官方免密钥 APY 翻译服务。
 * 主要内容：保守识别源语言、映射欧洲语言代码、使用纯文本协议、验证响应并保留取消与文本结构。
 * 模块边界：仅访问固定官方匿名端点，不读取密钥和代理；免费链的超时、冷却由现有编排负责。
 */
import {detectlang, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {config} from '@/src/services/config/store';
import {getTranslationProviderConfig, getTranslationGlossarySourceText, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {translateStructuredText} from './structuredText';

const aliases: Record<string, string> = {en: 'eng', es: 'spa', fr: 'fra', it: 'ita', pt: 'por', ca: 'cat', gl: 'glg', ro: 'ron', ru: 'rus', uk: 'ukr', eo: 'epo', nl: 'nld', af: 'afr', sv: 'swe', da: 'dan'};

export default async function apertium(message: TranslationProviderRequest): Promise<string | string[]> {
    const current = getTranslationProviderConfig(message, config);
    const languages = resolveTranslationLanguages(message, {sourceLanguage: current.from, targetLanguage: current.to});
    const to = aliases[languages.targetLanguage];
    if (!to) throw Object.assign(new Error('Apertium 不支持此目标语言，请切换翻译服务'), {statusCode: 400});
    const source = getTranslationGlossarySourceText(message.origin);
    const text = Array.isArray(source) ? source.join('\n') : source;
    const detected = languages.sourceLanguage === 'auto' ? detectlang(text) : languages.sourceLanguage;
    const from = aliases[detected] || (Object.values(aliases).includes(detected) ? detected : undefined);
    if (!from || (languages.sourceLanguage === 'auto' && !shouldSkipTranslationForTarget(text, detected))) {
        throw Object.assign(new Error('Apertium 无法识别或不支持源语言，请手动选择来源语言'), {statusCode: 400});
    }
    return translateStructuredText(message.origin, async q => {
        const response = await runtimeFetch('https://apertium.org/apy/translate', {
            method: 'POST', credentials: 'omit', signal: message.abortSignal,
            headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
            body: new URLSearchParams({q, langpair: `${from}|${to}`, format: 'txt', markUnknown: 'no'}).toString(),
        });
        if (!response.ok) throw createHttpStatusError(response, 'Apertium 翻译失败');
        const result = await readJsonResponse<{responseStatus?: unknown; responseData?: {translatedText?: unknown}} | null>(response, 'Apertium 返回的不是有效 JSON');
        if (String(result?.responseStatus) !== '200') {
            const status = Number(result?.responseStatus);
            throw Object.assign(new Error('Apertium 翻译失败，请检查语言对或切换服务'), {
                statusCode: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
            });
        }
        return result?.responseData?.translatedText as string;
    }, message.abortSignal);
}
