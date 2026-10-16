/**
 * @file src/core/translation/resultValidation.ts
 * 文件职责：识别翻译服务误返原文或明显错语种的响应，避免将其当成成功译文。
 * 主要内容：复用语言识别副本排除纯符号、数字和技术标识，提供保持字词内容的原样响应比较，供图片入口接受空白、标点边界或 U+200B 包装的原文；仅在既有外语证据下识别原文回显，保留字词、大小写和符号差异，补足中文目标下短标签列表、运算符标签丢词或大小写回显、整段日文及有充分外语证据的长 Latin 正文错语种判定；文档行内正文可在完整原句的既有外语证据下识别普通多词标签原样返回，专名和单词仍保持保守。
 * 补充边界：可信外语长正文中，少量汉字替换不能掩盖大量保留的 Latin 原词，阿拉伯正文丢空格也不能冒充中文译文；成对外语引文、短名称与完整槽标记代码不作为新增拒绝证据，标记之间的正文仍参与判定。
 * 模块边界：仅做保守的纯文本判定；不读取配置或缓存、不请求服务，也不改写原文与译文。
 */
import {getChineseScript} from '@/src/core/language/chinese';
import {isLanguageCodeMatch} from '@/src/core/language/codes';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {createLanguageDetectionCopy} from '@/src/core/language/technicalTokens';

/** 网址、版本、模型编号和纯符号保持原文；旁边有正文的整行仍参与翻译。 */
export function hasTranslatableText(text: string): boolean {
    return /\p{L}/u.test(createLanguageDetectionCopy(text).text);
}

function comparable(value: string): string {
    // 免费服务有时只把英文标题的冒号换成全角并删去后面的空格。
    return value.normalize('NFKC').replace(/\s*:\s*/gu, ':').replace(/\s+/gu, ' ').trim();
}

/** 标点只作为分词边界，不能把 a-b 与 ab 合并；U+200B 不改变字词内容。
 * 保留大小写、组合音标、运算符及可能改变字形的 ZWJ/ZWNJ，最终仍由原文的既有外语证据决定是否拒绝。
 */
function echoComparable(value: string): string {
    return value.normalize('NFKC').replace(/\u200b/gu, '')
        .replace(/(?:(?![-*/\\_%&#@:]|!(?=[\p{L}\p{N}_=!(])|\?(?=\s*[\p{L}\p{N}_?.=]))\p{P})+/gu, ' ')
        .replace(/\s+/gu, ' ').trim();
}

/** 仅比较是否保留原字词；边界标点可变化，空响应和删去字词的符号结果不能冒充原样成功。 */
export function isUnchangedTranslationResponse(origin: string, result: string): boolean {
    if (!origin.trim() || !result.trim()) return false;
    if (comparable(origin) === comparable(result)) return true;
    const source = echoComparable(origin);
    return Boolean(source) && source === echoComparable(result);
}

/** 标签列表缺少功能词，统计语言识别通常只能给出不可信的猜测。 */
function isLatinKeywordList(value: string): boolean {
    const tags = value.split(',');
    if (tags.length < 6) return false;
    let readableTags = 0;
    let words = 0;
    for (const tag of tags) {
        const trimmed = tag.trim();
        if (!/^[a-z][a-z_ ]{2,}$/u.test(trimmed)) continue;
        const parts = trimmed.match(/[a-z]{3,}/gu) ?? [];
        if (parts.length === 0) continue;
        readableTags += 1;
        words += parts.length;
    }
    return readableTags >= 6 && words >= 6;
}

/** 职业标题常被语言检测视为不确定；只对明确的通用职位词判定原文回显。 */
function isLatinShortHeading(value: string): boolean {
    const words = value.trim().split(/\s+/u);
    return words.length === 2 && words.every(word => /^[A-Za-z][a-z]{3,}[.!?]?$/u.test(word))
        && /^(?:developer|engineer|designer|manager|analyst|architect|administrator|scientist|researcher|specialist|consultant|programmer|translator|editor|writer|teacher|student|operator|technician)$/iu.test(words[1]);
}

/** 两个首字母大写的词可能是人名、地名或品牌；不能因原样保留就使整段失败。 */
function isPossiblyProperName(value: string): boolean {
    const words = value.trim().split(/\s+/u);
    return words.length === 2 && words.every(word => /^[A-Z][a-z]{2,}$/u.test(word))
        && !isLatinShortHeading(value);
}

/** 运算符是普通可译概念；只补足完整标签及 code 前的开括号槽，不猜测任意英文短语。 */
function isLatinOperatorLabel(value: string): boolean {
    return /^(?:addition|subtraction|multiplication|division|remainder|(?:logical|bitwise) (?:not|and|or|xor))(?:\s+\(\s*\)?)?$/iu.test(value);
}

/** 拒绝外语正文及英文标题的原文回显；缩写、代码与部分专名保持保守判定。 */
export function isLikelyUntranslatedResponse(origin: string, result: string, targetLanguage: string): boolean {
    // 受保护的 inline code 不进入 provider 槽，标签经常以开括号结尾。
    // 中文目标下只剩括号或只改英文大小写不算完成，交由既有免费线路降级；
    // 不扩大 hasDistinctTranslation 的展示比较，也不把任意品牌当成漏译。
    const source = comparable(origin);
    const translated = comparable(result);
    if (getChineseScript(targetLanguage) && isLatinOperatorLabel(source) && hasTranslatableText(origin) && (
        source.toLowerCase() === translated.toLowerCase() || /^[\p{P}\p{S}\s]+$/u.test(translated)
    )) return true;
    if (!origin.trim() || (source !== translated && echoComparable(origin) !== echoComparable(result))) return false;
    if (!hasTranslatableText(origin)) return false;
    if (getChineseScript(targetLanguage) && isPossiblyProperName(origin)) return false;
    const identification = identifyTextLanguage(origin);
    if (identification.status === 'identified') {
        return !identification.languages.some(language => isLanguageCodeMatch(language, targetLanguage));
    }
    return Boolean(getChineseScript(targetLanguage)) && !/[\u3400-\u9fff]/u.test(result) && (
        isLatinKeywordList(origin) || isLatinShortHeading(origin) ||
        (createLanguageDetectionCopy(origin).text.match(/\b[a-z]{3,}\b/gu) ?? []).length >= 3
    );
}

/** 仅文档行内节点使用完整原句的真实外语证据，不改变其他入口的单段判定。 */
export function isLikelyUntranslatedInlineResponse(origin: string, result: string, targetLanguage: string, sourceContext: string): boolean {
    if (isLikelyUntranslatedResponse(origin, result, targetLanguage)) return true;
    // 短英文节点缺乏独立语言证据；中文目标和完整外语原句均明确时才补足，英文目标不误拒已是英文的标签。
    if (!getChineseScript(targetLanguage) || comparable(origin) !== comparable(result)
        || !isLikelyUntranslatedResponse(sourceContext, sourceContext, targetLanguage)) return false;
    const words = createLanguageDetectionCopy(origin).text.match(/\b[A-Za-z]{3,}\b/gu) ?? [];
    return words.length >= 2 && words.some(word => /^[a-z]+$/u.test(word))
        && words.slice(1).every(word => !/^[A-Z][a-z]/u.test(word));
}

/** 只补足整段 Latin 外语正文；名称列表、技术标识和短词句不扩大判定。 */
function hasSubstantialLatinProse(value: string): boolean {
    const words = value.match(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu) ?? [];
    // 每词均以 Latin 字母开头；满八词时匹配必非空，数组长度仍按 Unicode 码点计数。
    return words.length >= 8 && words.join('').match(/\p{Script=Latin}/gu)!.length >= 60
        && words.filter(word => /^\p{Ll}[\p{Ll}\p{M}]+$/u.test(word)).length >= 4;
}

function isClearlyForeignLatinProse(origin: string, result: string, targetLanguage: string): boolean {
    // 少量中文旁的品牌、引用或技术词保持保守；常见中文结果不额外生成识别副本。
    if (/\p{Script=Han}/u.test(result) || !/\p{Script=Latin}/u.test(result)) return false;
    const source = createLanguageDetectionCopy(origin).text;
    const translated = createLanguageDetectionCopy(result).text;
    if (!hasSubstantialLatinProse(source) || !hasSubstantialLatinProse(translated)) return false;
    const sourceLanguage = identifyTextLanguage(origin);
    if (sourceLanguage.status !== 'identified'
        || sourceLanguage.languages.some(language => isLanguageCodeMatch(language, targetLanguage))) return false;
    const resultLanguage = identifyTextLanguage(result);
    return resultLanguage.status === 'identified'
        && !resultLanguage.languages.some(language => isLanguageCodeMatch(language, targetLanguage));
}

/** 引文只从新增残留正文证据中排除；不改动原文、译文或既有回显比较。 */
function outsideQuotedText(value: string): string {
    // Latin 字母之间的弯/直撇号属于词，不能提前结束 L’usage / s'agit 等引文。
    // ASCII 开闭引号还须在词外；未引用正文中的撇号不构成开引号。
    return value.replace(/“[^”]*”|「[^」]*」|『[^』]*』|«[^»]*»|"[^"\n]*"/gu, ' ')
        .replace(/‘(?:[^’]|(?<=[\p{Script=Latin}\p{M}])’(?=[\p{Script=Latin}\p{M}]))*’(?![\p{Script=Latin}\p{M}])/gu, ' ')
        .replace(/(?<![\p{L}\p{N}])'(?:[^'\n]|(?<=[\p{Script=Latin}\p{M}])'(?=[\p{Script=Latin}\p{M}]))*'(?![\p{L}\p{N}])/gu, ' ');
}

/** 仅新残留规则的识别副本排除完整代码标记；不解包、不吞标记之间的正文，也不赋予逐槽语义。 */
function residueDetectionCopy(value: string): string {
    // nonce 在三下划线处停止，避免从损坏标记跨过下一标记；仅完整标准序号及 BEGIN/END 参与遮蔽。
    return createLanguageDetectionCopy(value.replace(/___FLUENTREAD_(?:(?!___)[a-z0-9_-])+?_(?:0|[1-9]\d*)_(?:BEGIN|END)___/giu, ' ')).text;
}

/** 原文归属必须可信，且引文之外仍有大量外语正文；比例不能独立作为错语种依据。 */
function hasDominantForeignResidue(origin: string, result: string, targetLanguage: string): boolean {
    const translated = residueDetectionCopy(outsideQuotedText(result));
    const han = (translated.match(/\p{Script=Han}/gu) ?? []).length;
    const arabic = (translated.match(/\p{Script=Arabic}/gu) ?? []).length;
    const latin = (translated.match(/\p{Script=Latin}/gu) ?? []).length;
    // 无汉字的 Latin 正文继续使用原有统计判定，不扩大不确定混合段落。
    if (arabic < 60 && (han === 0 || latin < 60 || latin <= han * 6)) return false;
    const source = residueDetectionCopy(origin);
    const identification = identifyTextLanguage(origin);
    if (identification.status !== 'identified'
        || identification.languages.some(language => isLanguageCodeMatch(language, targetLanguage))) return false;
    if (arabic >= 60 && arabic > han * 6 && (source.match(/\p{Script=Arabic}/gu) ?? []).length >= 60) return true;
    if (!hasSubstantialLatinProse(source) || !hasSubstantialLatinProse(translated)) return false;
    // 上面的充分正文检查已保证双方都有至少八个 Latin 词；此处匹配不可能为空。
    const sourceWords = new Set(source.toLowerCase().match(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu)!);
    const retained = translated.toLowerCase().match(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu)!
        .filter(word => sourceWords.has(word));
    return han > 0 && latin > han * 6 && retained.length >= 8
        && retained.join('').length >= Math.max(40, latin / 2);
}

/** 拒绝明确的整段日文、Latin 外语及大量残留的阿拉伯/Latin 正文；名称和有界引文保持保守。 */
export function isClearlyWrongLanguageResponse(origin: string, result: string, targetLanguage: string): boolean {
    if (!origin.trim() || !result.trim() || !getChineseScript(targetLanguage)) return false;
    if (isClearlyForeignLatinProse(origin, result, targetLanguage)) return true;
    if (hasDominantForeignResidue(origin, result, targetLanguage)) return true;
    const kanaCount = (result.match(/[\p{Script=Hiragana}\p{Script=Katakana}ーｰ]/gu) ?? []).length;
    if (kanaCount < 16) return false;
    const hanCount = (result.match(/\p{Script=Han}/gu) ?? []).length;
    if (kanaCount * 2 < hanCount) return false;
    const identification = identifyTextLanguage(result);
    return identification.status === 'identified' && identification.languages.includes('ja');
}
