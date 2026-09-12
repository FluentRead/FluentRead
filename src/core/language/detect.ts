/**
 * @file src/core/language/detect.ts
 *
 * 文件职责：对待翻译文本执行轻量语言识别，并提供只在高置信度时跳过同语言翻译的保守判定。
 * 主要内容：detectlang 调用 franc-min 得到 ISO 639-3 识别结果，普通话仅凭明确字形映射简体或繁体，不明确时保留 cmn；shouldSkipTranslationForTarget 对短文本、共享 Han、简繁混排和未知结果 fail-open，仅接受明确书写体系或足够长的统计结果；划词与翻译卡片额外按纯 Han 选区跳过中文目标，不将该交互规则用于全文检测；共享 Chrome 现代语言检测的最低置信度边界。 可核对的公开符号包括 detectlang、shouldSkipTranslationForTarget、MIN_CHROME_LANGUAGE_CONFIDENCE。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import {franc} from 'franc-min';
import {isClearlyTargetLanguage, normalizeTranslationText} from '@/src/core/translation/text';
import {detectChineseScript, getChineseScript} from './chinese';

const FLUENTREAD_LANGUAGE_CODES: Readonly<Record<string, string>> = {
    eng: 'en',
    fra: 'fr',
    jpn: 'ja',
    kor: 'ko',
    rus: 'ru',
    spa: 'es',
};

const MIN_RELIABLE_STATISTICAL_LETTERS = 50;
const CJK_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNKNOWN_LANGUAGE_CODES = new Set(['', 'auto', 'detect', 'unknown', 'und']);

/** Chrome LanguageDetector 结果低于此边界时按未知语言处理。 */
export const MIN_CHROME_LANGUAGE_CONFIDENCE = 0.4;

function languageBase(value: string): string {
    const normalized = value.trim().replace(/_/gu, '-').toLowerCase();
    if (UNKNOWN_LANGUAGE_CODES.has(normalized)) return '';
    return normalized.split('-')[0]!;
}

/** 将 franc 的 ISO 639-3 结果映射为 FluentRead 配置使用的语言代码。 */
export function detectlang(origin: string): string {
    const detected = franc(origin, {minLength: 0});
    if (detected === 'cmn') {
        const script = detectChineseScript(origin);
        return script ? `zh-${script}` : 'cmn';
    }
    return FLUENTREAD_LANGUAGE_CODES[detected] ?? detected;
}

/**
 * 同语言预检只能省请求，绝不能让不确定文本静默漏译。短 Latin、纯 Han 与任何
 * 未知统计结果都返回 false；调用方继续交给实际 provider 处理。
 */
export function shouldSkipTranslationForTarget(origin: string, targetLanguage: string): boolean {
    const text = normalizeTranslationText(origin);
    if (isClearlyTargetLanguage(text, targetLanguage)) return true;
    if (!text || CJK_SCRIPT_PATTERN.test(text)) return false;

    const letters = text.match(/\p{L}/gu)!.length;
    if (letters < MIN_RELIABLE_STATISTICAL_LETTERS) return false;
    const detected = languageBase(detectlang(text));
    const target = languageBase(targetLanguage);
    return Boolean(detected && target && detected === target);
}

/**
 * 中文目标下，划词与翻译卡片不为纯汉字选区提供翻译入口，包括短词、简繁汉字和
 * 伴随的标点、数字、表情。只依据选区本身，不让页面语言掩盖其中的外语内容。
 * 这是选区交互规则，不作为通用语言识别结论；外语目标仍允许翻译中文。
 */
export function shouldSkipChineseSelection(origin: string, targetLanguage: string): boolean {
    if (!getChineseScript(targetLanguage)) return false;
    return /\p{Script=Han}/u.test(origin)
        && !/\p{L}/u.test(origin.replace(/\p{Script=Han}/gu, ''));
}
