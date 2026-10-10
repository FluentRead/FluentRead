/**
 * @file src/core/translation/targetResult.ts
 * 文件职责：为网页翻译提供有目标语言证据的近似回显展示兜底，减少供应商只调整排版时的重复译文。
 * 主要内容：先沿用精确文本比较，再要求原文可信属于当前目标语言；仅折叠中西文同义标点、引号、句尾陈述句号及汉字/假名间排版空格，不吞掉字词、数字、否定、问号、感叹号、运算符和简繁转换。
 * 模块边界：纯算法，不改变原文、供应商结果、缓存或请求状态；只供具有冻结目标语言的网页展示调用，不对文档编辑和写作改写套用相似度阈值。
 */
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {hasDistinctTranslation, hasTranslationContent} from './result';

const PRESENTATION_PUNCTUATION: Readonly<Record<string, string>> = {
    '，': ',', '；': ';', '：': ':', '。': '.', '“': '"', '”': '"', '‘': "'", '’': "'",
};

const PROTECTED_LITERAL = /`[^`]*`|"[^"]*"|'[^']*'|“[^“”]*”|‘[^‘’]*’|「[^「」]*」|『[^『』]*』/gu;

function normalizePresentationRun(value: string): string {
    return value
        .replace(/[，；：。“”‘’]/gu, character => PRESENTATION_PUNCTUATION[character]!)
        .replace(/\s+/gu, ' ')
        // 不改变词间分隔，尤其保留韩文、阿拉伯文及 Latin 的空格语义。
        .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '')
        .replace(/\s*([,;:])\s*/gu, '$1');
}

function presentationComparable(value: string): string {
    const normalized = value.normalize('NFC').replace(/\u200b/gu, '');
    let result = '';
    let cursor = 0;
    // 引用里的字符可能是数据或代码字面量；仅折叠引号外形，不改变内部字符。
    for (const match of normalized.matchAll(PROTECTED_LITERAL)) {
        result += normalizePresentationRun(normalized.slice(cursor, match.index));
        const quoted = match[0];
        const open = PRESENTATION_PUNCTUATION[quoted[0]!] ?? quoted[0]!;
        const close = PRESENTATION_PUNCTUATION[quoted.at(-1)!] ?? quoted.at(-1)!;
        result += open + quoted.slice(1, -1) + close;
        cursor = match.index + quoted.length;
    }
    result += normalizePresentationRun(normalized.slice(cursor));
    return result.trim().replace(/(?<=\p{L})\.$/u, '');
}

/** 只有已有同目标证据且所有字词仍相同才隐藏排版回显；相近语言和高比例但有实质修改的文本继续展示。 */
export function hasDistinctTargetTranslation(source: string, translation: string | undefined, targetLanguage: string): boolean {
    if (!hasTranslationContent(translation ?? '')) return false;
    // 转义引号会改变引用边界，保守使用原始比较，不让任何内部字符变化被归一化吞掉。
    if (/\\["'`]/u.test(source) || /\\["'`]/u.test(translation!)) return source !== translation;
    // 共享精确比较会折叠空白；字面量变化须先保护，避免它绕过下方展示兜底。
    const literals = (text: string): string => JSON.stringify([...text.matchAll(PROTECTED_LITERAL)].map(match => match[0].slice(1, -1)));
    if (literals(source) !== literals(translation!)) return true;
    if (!hasDistinctTranslation(source, translation)) return false;
    if (!/\p{L}/u.test(source) || !shouldSkipTranslationForTarget(source, targetLanguage)) return true;
    return presentationComparable(source) !== presentationComparable(translation!);
}
