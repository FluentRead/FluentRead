/**
 * @file src/core/language/detect.ts
 *
 * 文件职责：提供各翻译入口共用的语言判断公开 API，把与目标无关的文本识别结论和配置中的目标语言、排除语言按同一规则比较。
 * 主要内容：detectlang 返回规范语言代码，可信识别优先、否则给出统计最佳猜测或混合正文的 franc-min 整体排序，普通话无法确定简繁时返回 cmn、没有正文证据时返回 und；shouldSkipTranslationForTarget 只在文本无字母或整段被可信识别为目标语言/任一排除语言时跳过，未知、混合与夹带外语句子一律保留翻译；shouldSkipChineseTargetParagraph 为全文段落与标题补上中文目标的确定性跳过——正文含至少两个连续汉字、无假名谚文且不与目标书写体系字形冲突时不再翻译，避免中文段落被供应商再翻一遍后双语显示两遍中文，同时保留简繁转换，划词、输入框等局部翻译不使用；detectChineseScript 报告可信的单一中文书写体系；划词与翻译卡片额外按纯 Han 选区跳过中文目标；从 confidence.ts 转出 Chrome 现代语言检测的最低置信度边界。可核对的公开符号包括 detectlang、shouldSkipTranslationForTarget、shouldSkipChineseTargetParagraph、isTextInLanguage、detectChineseScript、shouldSkipChineseSelection、MIN_CHROME_LANGUAGE_CONFIDENCE。
 * 模块边界：本文件属于 core 领域层，只组合 identify.ts 与 codes.ts 的纯规则，并保留 confidence.ts 的同名阈值出口；不读取浏览器存储、页面 lang 或配置，不发起网络请求，也不挂载 Vue/WXT 入口，是否强制翻译等交互语义由调用方决定。
 */

import {franc} from 'franc-min';
import {getChineseScript, type ChineseScript} from './chinese';
import {hasOppositeChineseScriptForms} from './chineseText';
import {isLanguageCodeMatch, normalizeDetectedLanguageCode} from './codes';
import {identifyTextLanguage} from './identify';

export {MIN_CHROME_LANGUAGE_CONFIDENCE} from './confidence';

/**
 * 返回文本的规范语言代码。可信识别结果优先；否则使用统计最佳猜测，供朗读音色、本地模型源语言等
 * 需要猜测的场景使用。普通话书写体系不明确时返回 cmn，无法识别返回 und。该结果不能单独作为跳过依据。
 */
export function detectlang(origin: string): string {
    const identification = identifyTextLanguage(origin);
    if (identification.status === 'identified') {
        return identification.languages.length === 1 ? identification.languages[0]! : 'cmn';
    }
    if (identification.bestGuess && identification.bestGuess !== 'zh') return identification.bestGuess;
    // 只有标识符、名称或无法统计的文字时没有可用猜测；混合正文才退回 franc 的整体排序。
    if (identification.status === 'unknown' && identification.bestGuess === undefined) return 'und';
    const detected = franc(origin, {minLength: 0});
    const normalized = normalizeDetectedLanguageCode(detected);
    if (normalized === 'zh') return 'cmn';
    return normalized || 'und';
}

/** 文本是否被可信识别为指定配置语言；简繁同形的中文同时属于简体与繁体目标。 */
export function isTextInLanguage(origin: string, language: string): boolean {
    const identification = identifyTextLanguage(origin);
    return identification.status === 'identified'
        && identification.languages.some(detected => isLanguageCodeMatch(detected, language));
}

/**
 * 同语言预检只能省请求，绝不能让不确定文本静默漏译。目标语言和排除语言共用同一识别结论与代码比较；
 * 没有字母的文本无需翻译；短歧义词、专有名词、纯共享汉字、混合文字和夹带外语句子都返回 false。
 */
export function shouldSkipTranslationForTarget(
    origin: string,
    targetLanguage: string,
    excludedLanguages: readonly string[] = [],
): boolean {
    const identification = identifyTextLanguage(origin);
    if (identification.status === 'empty') return true;
    if (identification.status !== 'identified') return false;
    return [targetLanguage, ...excludedLanguages].some(language =>
        identification.languages.some(detected => isLanguageCodeMatch(detected, language)));
}

/**
 * 全文翻译的中文目标段落预检：段落正文含足够汉字、无假名或谚文且不与目标
 * 书写体系的专属字形冲突时直接保留原文，不再发给供应商，避免识别为混合或未知的
 * 中文段落（中文夹英文术语、链接、代码、版权行等 fail-open 文本）被再翻一遍后
 * 双语区域显示两遍中文。八字阈值与 identify.ts 的可信中文正文门槛同源；表情或
 * emoji 开头的评论短句按句末标点放宽到两个汉字，如「🤔🤔🤔移动？」。无句末
 * 标点的两三个汉字短词可能是日文汉字或繁体短语，保持 fail-open 继续翻译；
 * 出现假名或谚文正文的日文、韩文段落仍需翻译；与目标体系相反的简繁字形保留
 * 简繁转换；代码、数字与拉丁正文不受影响。本规则只服务整段候选、文本槽与
 * 标题的全文预检，划词、输入框等局部翻译不使用，用户显式请求的局部翻译不受影响。
 */
export function shouldSkipChineseTargetParagraph(origin: string, targetLanguage: string): boolean {
    const targetScript = getChineseScript(targetLanguage);
    if (!targetScript) return false;
    if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(origin)) return false;
    let hanCount = 0;
    for (const character of origin) {
        if (/\p{Script=Han}/u.test(character)) hanCount += 1;
    }
    if (hanCount === 0) return false;
    // 有完整句末标点的短句是评论或聊天正文，两个汉字即可确认；无标点短词
    // （日本国立大学、趨勢、時間）仍按八字可信门槛保持 fail-open。
    const minimum = (/[？?！!。]$/u).test(origin.trim()) ? 2 : 8;
    if (hanCount < minimum) return false;
    return !hasOppositeChineseScriptForms(origin, targetScript);
}

/** 只报告有明确中文证据且字形一致的文本，不为简繁同形中文猜测简体或繁体。 */
export function detectChineseScript(value: string): ChineseScript | undefined {
    const identification = identifyTextLanguage(value);
    if (identification.status !== 'identified' || identification.languages.length !== 1) return undefined;
    return getChineseScript(identification.languages[0]!);
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
