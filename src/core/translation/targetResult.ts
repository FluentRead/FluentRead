/**
 * @file src/core/translation/targetResult.ts
 * 文件职责：为网页翻译提供有目标语言证据的近似回显展示兜底，减少供应商只调整排版时的重复译文。
 * 主要内容：先沿用精确文本比较，再要求原文可信属于当前目标语言；仅折叠中西文同义标点、引号、句尾陈述句号及汉字/假名间排版空格；相同长度反引号、正确闭合的中西文引用保护原始实值，未闭合或有歧义的引用保守展示，单个词内撇号仍按正文处理。
 * 模块边界：纯算法，不改变原文、供应商结果、缓存或请求状态；只供具有冻结目标语言的网页展示调用，不对文档编辑和写作改写套用相似度阈值。
 */
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {hasDistinctTranslation, hasTranslationContent} from './result';

const PRESENTATION_PUNCTUATION: Readonly<Record<string, string>> = {
    '，': ',', '；': ';', '：': ':', '。': '.', '“': '"', '”': '"', '‘': "'", '’': "'",
};

const QUOTE_END: Readonly<Record<string, string>> = {
    '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』',
    '«': '»', '‹': '›', '„': '“', '‚': '‘',
};
const QUOTE_CLOSERS = new Set(['”', '’', '」', '』', '»', '›']);

interface ProtectedLiteral {
    start: number;
    end: number;
    open: string;
    close: string;
    body: string;
}

interface LiteralEvidence {
    matches: ProtectedLiteral[];
    values: string[];
    uncertain: boolean;
}

/** 只查看相邻码点，保留法文省音、英文缩写及所有格；不重复扫描前缀。 */
function wordBefore(value: string, index: number): boolean {
    return /[\p{Script=Latin}\p{M}\p{N}]$/u.test(value.slice(Math.max(0, index - 2), index));
}

function infixApostrophe(value: string, index: number): boolean {
    return wordBefore(value, index) && /^[\p{Script=Latin}\p{M}\p{N}]/u.test(value.slice(index + 1, index + 3));
}

/**
 * 先逐个反引号串建立下一处同长度位置，再按正文顺序消费闭合的代码或引用。
 * 每个字符最多经过预扫描和一次消费扫描；不配对的任意长度串不能触发正则回溯。
 * 未闭合分隔符立即回到原始比较；多个词内撇号也可能是前缀字符串的边界，保守保留实值。
 */
function literalEvidence(value: string): LiteralEvidence {
    const ticks = new Map<number, {end: number; close?: number}>();
    const nextByLength = new Map<number, number>();
    let lastApostrophe = -1;
    // 从后往前建立同长度配对位置，代码内更短或更长的反引号无需特殊递归。
    for (let index = value.length - 1; index >= 0; index--) {
        if (lastApostrophe < 0 && (value[index] === "'" || value[index] === '’')) lastApostrophe = index;
        if (value[index] !== '`') continue;
        const end = index + 1;
        while (index > 0 && value[index - 1] === '`') index--;
        const length = end - index;
        ticks.set(index, {end, close: nextByLength.get(length)});
        nextByLength.set(length, index);
    }
    const matches: ProtectedLiteral[] = [];
    const evidence = (uncertain: boolean): LiteralEvidence => ({matches, values: matches.map(match => match.body), uncertain});
    for (let index = 0; index < value.length;) {
        const open = value[index]!;
        if (open === '`') {
            const tick = ticks.get(index)!;
            if (tick.close === undefined) return evidence(true);
            const end = ticks.get(tick.close)!.end;
            const delimiter = value.slice(index, tick.end);
            matches.push({start: index, end, open: delimiter, close: delimiter, body: value.slice(tick.end, tick.close)});
            index = end;
            continue;
        }
        if ((open === "'" || open === '’') && wordBefore(value, index)) {
            // 不能把 N'a  b' 等带任意前缀的成对字面量当成两个词内撇号而丢掉数据空白。
            // 不推断前缀语言；后面还有撇号就有边界歧义，普通单次省音和所有格仍可折叠排版。
            if (index < lastApostrophe) return evidence(true);
            index++;
            continue;
        }
        const close = QUOTE_END[open];
        if (close) {
            let end = index + 1;
            for (; end < value.length; end++) {
                const character = value[end]!;
                if (character === close && !((close === "'" || close === '’') && infixApostrophe(value, end))) break;
                if (open !== close && character === open) return evidence(true);
            }
            if (end === value.length) return evidence(true);
            matches.push({start: index, end: end + 1, open, close, body: value.slice(index + 1, end)});
            index = end + 1;
            continue;
        }
        if (QUOTE_CLOSERS.has(open)) return evidence(true);
        index++;
    }
    return evidence(false);
}

function normalizePresentationRun(value: string): string {
    return value
        .replace(/[，；：。“”‘’]/gu, character => PRESENTATION_PUNCTUATION[character]!)
        .replace(/\s+/gu, ' ')
        // 不改变词间分隔，尤其保留韩文、阿拉伯文及 Latin 的空格语义。
        .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '')
        .replace(/\s*([,;:])\s*/gu, '$1');
}

function presentationComparable(value: string, evidence: LiteralEvidence): string {
    const runs: string[] = [];
    let cursor = 0;
    // 引用里的字符可能是数据或代码字面量；仅折叠引号外形，不改变内部字符。
    for (const match of evidence.matches) {
        runs.push(normalizePresentationRun(value.slice(cursor, match.start).normalize('NFC').replace(/\u200b/gu, '')));
        runs.push((PRESENTATION_PUNCTUATION[match.open] ?? match.open) + match.body + (PRESENTATION_PUNCTUATION[match.close] ?? match.close));
        cursor = match.end;
    }
    runs.push(normalizePresentationRun(value.slice(cursor).normalize('NFC').replace(/\u200b/gu, '')));
    return runs.join('').trim().replace(/(?<=\p{L})\.$/u, '');
}

/** 只有已有同目标证据且所有字词仍相同才隐藏排版回显；相近语言和高比例但有实质修改的文本继续展示。 */
export function hasDistinctTargetTranslation(source: string, translation: string | undefined, targetLanguage: string): boolean {
    if (!hasTranslationContent(translation ?? '')) return false;
    // 逐字相同时无需扫描引用或归一化，仍保留不同字符串中的字面量保护。
    if (source === translation) return false;
    // 转义引号会改变引用边界，保守使用原始比较，不让任何内部字符变化被归一化吞掉。
    if (/\\["'`]/u.test(source) || /\\["'`]/u.test(translation!)) return source !== translation;
    // 共享精确比较会折叠空白；字面量变化须先保护，避免它绕过下方展示兜底。
    const sourceEvidence = literalEvidence(source);
    const translatedEvidence = literalEvidence(translation!);
    if (sourceEvidence.uncertain || translatedEvidence.uncertain) return source !== translation;
    if (JSON.stringify(sourceEvidence.values) !== JSON.stringify(translatedEvidence.values)) return true;
    if (!hasDistinctTranslation(source, translation)) return false;
    if (!/\p{L}/u.test(source) || !shouldSkipTranslationForTarget(source, targetLanguage)) return true;
    return presentationComparable(source, sourceEvidence) !== presentationComparable(translation!, translatedEvidence);
}
