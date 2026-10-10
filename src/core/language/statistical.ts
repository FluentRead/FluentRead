/**
 * @file src/core/language/statistical.ts
 *
 * 文件职责：对 Latin、Cyrillic、Arabic 与 Devanagari 等多语言共用文字执行统计识别，并只在多项独立证据一致时给出可信语言。
 * 主要内容：调用 franc-min 获取候选排序，把 ISO 639-3 结果按文字规范化；以功能词逆文档频率得分、正字法字母反证和候选分差共同评估可信度，分为短文本、长文本和统计模型缺失语言的功能词专用路径三档；当首位模型没有功能词证据、次位具有至少六种功能词和高独立权重时，可在原有支持分差内纠正排序；franc 分数只作为排序与分差信号，阈值由可复现语料校准，不当作概率。可核对的公开符号包括 assessStatisticalLanguage、StatisticalAssessment、FRANC_MIN_LANGUAGES、STATISTICAL_THRESHOLDS。
 * 模块边界：本文件属于 core 纯算法，只接收已切分的同一文字词段；技术标识符遮蔽、混合文字判断、中日韩文本和目标语言比较由 identify.ts 与 detect.ts 负责，不访问配置、浏览器或网络。
 */

import {francAll} from 'franc-min';
import {normalizeDetectedLanguageCode} from './codes';
import {
    ARABIC_FOREIGN_LETTERS,
    CYRILLIC_LETTERS,
    FUNCTION_WORDS,
    LATIN_EXTRA_LETTERS,
    STATISTICAL_SCRIPT_LANGUAGES,
    type StatisticalScript,
} from './lexicon';

const SCRIPT_SUBTAGS: Readonly<Record<StatisticalScript, string>> = {
    Latin: 'Latn', Cyrillic: 'Cyrl', Arabic: 'Arab', Devanagari: 'Deva',
};

/** franc-min 6.2.0 各文字包含的统计模型（ISO 639-3）；语料测试会与依赖数据逐项核对。 */
export const FRANC_MIN_LANGUAGES: Readonly<Record<StatisticalScript, readonly string[]>> = {
    Latin: ['spa', 'eng', 'por', 'ind', 'fra', 'deu', 'jav', 'vie', 'ita', 'tur', 'pol', 'swh', 'sun', 'ron', 'hau',
        'fuv', 'bos', 'hrv', 'nld', 'srp', 'ckb', 'yor', 'uzn', 'zlm', 'ibo', 'ceb', 'tgl', 'hun', 'azj', 'ces', 'run',
        'plt', 'qug', 'mad', 'nya', 'zyb', 'kin', 'zul', 'swe', 'lin', 'som', 'hms', 'hnj', 'ilo'],
    Cyrillic: ['rus', 'ukr', 'bos', 'srp', 'uzn', 'azj', 'koi', 'bel', 'bul', 'kaz'],
    Arabic: ['arb', 'urd', 'pes', 'zlm', 'skr', 'pbu'],
    Devanagari: ['hin', 'mar', 'mai', 'bho', 'npi', 'mag'],
};

/**
 * 由 tests/fixtures/language-identification-corpus.json 校准的保守阈值。分差是 franc 归一化距离之差，
 * 仅在同一文本内比较候选，且随文本变长被压缩，因此按字母数缩放；功能词得分是逆文档频率加权的不同功能词数量。
 */
export const STATISTICAL_THRESHOLDS = Object.freeze({
    minWords: 2,
    minLetters: 10,
    /** 分差阈值按 min(1, gapReferenceLetters / 字母数) 缩放。 */
    gapReferenceLetters: 50,
    supportedMinGap: 0.1,
    neutralMinGap: 0.15,
    neutralMinLetters: 15,
    nearTieMaxGap: 0.02,
    decisiveMinHits: 3,
    decisiveMinScore: 1.5,
    decisiveLeadRatio: 2,
    supportedMinHits: 2,
    supportedMinScore: 1,
    longLetters: 60,
    longMaxOrthographyViolationRatio: 0.01,
    lexicalOnlyMinWords: 3,
    lexicalOnlyMinLetters: 20,
    foreignSentenceMinHits: 2,
});

export interface StatisticalCandidate {
    language: string;
    score: number;
}

export interface StatisticalAssessment {
    /** 多项证据一致时的规范语言代码；undefined 表示应保留翻译机会。 */
    language?: string;
    /** 仅供需要“最佳猜测”的调用方使用，不代表可信。 */
    bestGuess?: string;
    /** 功能词证据最强且领先的语言，供整段内逐句判断是否夹带其他语言。 */
    functionWordLeader?: string;
    candidates: readonly StatisticalCandidate[];
    letters: number;
    words: number;
    functionWordScores: Readonly<Record<string, number>>;
    reason: 'too-short' | 'unsupported' | 'orthography' | 'function-words' | 'decisive' | 'supported' | 'neutral' | 'near-tie' | 'lexical-correction' | 'lexical-only';
}

const functionWordWeights = new Map<StatisticalScript, Map<string, number>>();

function weightsFor(script: StatisticalScript): Map<string, number> {
    const cached = functionWordWeights.get(script);
    if (cached) return cached;
    const counts = new Map<string, number>();
    for (const lexicon of Object.values(FUNCTION_WORDS[script])) {
        for (const word of lexicon) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const weights = new Map([...counts].map(([word, count]) => [word, 1 / count]));
    functionWordWeights.set(script, weights);
    return weights;
}

interface FunctionWordEvidence {
    scores: Record<string, number>;
    hits: Record<string, number>;
}

function scoreFunctionWords(script: StatisticalScript, tokens: ReadonlySet<string>): FunctionWordEvidence {
    const weights = weightsFor(script);
    const scores: Record<string, number> = {};
    const hits: Record<string, number> = {};
    for (const [language, lexicon] of Object.entries(FUNCTION_WORDS[script])) {
        let score = 0;
        let count = 0;
        for (const token of tokens) {
            if (!lexicon.has(token)) continue;
            score += weights.get(token)!;
            count += 1;
        }
        scores[language] = score;
        hits[language] = count;
    }
    return {scores, hits};
}

function orthographyViolations(script: StatisticalScript, language: string, letters: readonly string[]): number {
    // 功能词语言与正字法数据一一对应（由数据测试保证），只有 Devanagari 没有可靠的字母反证。
    if (script === 'Latin') {
        const extra = LATIN_EXTRA_LETTERS[language]!;
        return letters.filter(letter => !/^[a-z]$/u.test(letter) && !extra.includes(letter)).length;
    }
    if (script === 'Cyrillic') {
        const alphabet = CYRILLIC_LETTERS[language]!;
        return letters.filter(letter => !alphabet.includes(letter)).length;
    }
    if (script === 'Arabic') {
        const foreign = ARABIC_FOREIGN_LETTERS[language]!;
        return letters.filter(letter => foreign.includes(letter)).length;
    }
    return 0;
}

function canonicalFrancCode(code: string, script: StatisticalScript): string {
    return normalizeDetectedLanguageCode(`${code}-${SCRIPT_SUBTAGS[script]}`);
}

/**
 * 评估同一文字词段的语言，按证据强度依次尝试：
 * 1. franc 首位且功能词决定性领先（至少 3 个不同功能词、得分翻倍领先）；
 * 2. franc 首位、功能词严格领先且分差达标；
 * 3. franc 首位、功能词不矛盾（与其他语言持平）但分差更大，适用于俄/保/乌等共享功能词的短句；
 * 4. franc 前两位几乎持平时，由决定性领先的功能词语言打破平局；首位无任何功能词证据时，
 *    次位至少六种功能词且权重达到决定性门槛三倍，才可在支持分差内纠正统计误排；
 * 5. franc-min 没有统计模型的目录语言只接受决定性功能词证据。
 * 每条路径都要求目标语言字母表内无反证；所有分数只用于同一文本内比较。
 */
export function assessStatisticalLanguage(script: StatisticalScript, words: readonly string[]): StatisticalAssessment {
    const thresholds = STATISTICAL_THRESHOLDS;
    // 功能词词典使用 Unicode 默认大小写；不能让宿主的土耳其语区域设置把英文 I 改成 ı。
    const lowered = words.map(word => word.toLowerCase().replace(/\u0307/gu, '').replace(/’/gu, "'"));
    // 印度诸文字的元音符号属于音节，与字母一起计数，避免 Devanagari 文本被低估长度。
    const letters = lowered.flatMap(word => [...word].filter(character => /[\p{L}\p{M}]/u.test(character)));
    const {scores, hits} = scoreFunctionWords(script, new Set(lowered));

    const candidates: StatisticalCandidate[] = [];
    const seen = new Set<string>();
    for (const [code, score] of francAll(lowered.join(' '), {minLength: 0})) {
        const language = code === 'und' ? '' : canonicalFrancCode(code, script);
        if (!language || seen.has(language)) continue;
        seen.add(language);
        candidates.push({language, score});
    }
    const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
    const strongestOther = (language: string): number =>
        Math.max(0, ...ranked.filter(([other]) => other !== language).map(([, score]) => score));
    const isDecisive = (language: string): boolean => hits[language]! >= thresholds.decisiveMinHits
        && scores[language]! >= thresholds.decisiveMinScore
        && scores[language]! >= strongestOther(language) * thresholds.decisiveLeadRatio;
    const leader = ranked[0]![1] > strongestOther(ranked[0]![0]) && hits[ranked[0]![0]]! >= thresholds.foreignSentenceMinHits
        ? ranked[0]![0]
        : undefined;
    const base = {
        candidates,
        bestGuess: candidates[0]?.language,
        functionWordLeader: leader,
        letters: letters.length,
        words: words.length,
        functionWordScores: scores,
    };
    if (words.length < thresholds.minWords || letters.length < thresholds.minLetters) return {...base, reason: 'too-short'};

    const long = letters.length >= thresholds.longLetters;
    const consistentOrthography = (language: string): boolean => {
        const violations = orthographyViolations(script, language, letters);
        return long ? violations <= letters.length * thresholds.longMaxOrthographyViolationRatio : violations === 0;
    };
    const gapScale = Math.min(1, thresholds.gapReferenceLetters / letters.length);
    const catalogLanguages = STATISTICAL_SCRIPT_LANGUAGES[script];
    const francSupported = new Set(FRANC_MIN_LANGUAGES[script].map(code => canonicalFrancCode(code, script)));
    const top = candidates[0];

    // 首位语言出现字母表反证时不采信它，但仍允许后续平局打破或功能词专用路径识别真实语言。
    if (top && catalogLanguages.includes(top.language) && consistentOrthography(top.language)) {
        // 统计文字在 franc-min 中至少有六个模型，首位存在时必然有第二位候选。
        const gap = top.score - candidates[1]!.score;
        const score = scores[top.language]!;
        const other = strongestOther(top.language);
        if (isDecisive(top.language)) return {...base, language: top.language, reason: 'decisive'};
        if (score > other && score >= thresholds.supportedMinScore && hits[top.language]! >= thresholds.supportedMinHits
            && gap >= thresholds.supportedMinGap * gapScale) {
            return {...base, language: top.language, reason: 'supported'};
        }
        if (score >= other && hits[top.language]! >= thresholds.supportedMinHits
            && letters.length >= thresholds.neutralMinLetters && gap >= thresholds.neutralMinGap * gapScale) {
            return {...base, language: top.language, reason: 'neutral'};
        }
    }

    // franc 无法区分前两位时，由功能词决定性领先的一方打破平局，例如意大利语被西班牙语模型以极小分差压过。
    const lexicalLeader = ranked[0]![0];
    const leaderCandidate = candidates.find(candidate => candidate.language === lexicalLeader);
    if (top && leaderCandidate && leaderCandidate !== top && catalogLanguages.includes(lexicalLeader)
        && top.score - leaderCandidate.score <= thresholds.nearTieMaxGap
        && candidates.indexOf(leaderCandidate) === 1
        && isDecisive(lexicalLeader) && consistentOrthography(lexicalLeader)) {
        return {...base, language: lexicalLeader, reason: 'near-tie'};
    }

    // 例如普通英语操作句可能被三元组误排为德语，但六种英文功能词与零个德文功能词
    // 是独立反证。仅救援统计第二位；不能凭词典把模型中缺失、字母冲突或远落后的候选抬升。
    if (top && leaderCandidate && leaderCandidate !== top && candidates.indexOf(leaderCandidate) === 1
        && catalogLanguages.includes(lexicalLeader)
        && hits[lexicalLeader]! >= thresholds.decisiveMinHits * 2
        && scores[lexicalLeader]! >= thresholds.decisiveMinScore * 3
        && scores[top.language] === 0
        && top.score - leaderCandidate.score <= thresholds.supportedMinGap * gapScale
        && consistentOrthography(lexicalLeader)) {
        return {...base, language: lexicalLeader, reason: 'lexical-correction'};
    }

    // 统计模型缺失的目录语言（如斯洛伐克语、丹麦语）只能依赖功能词与正字法，要求决定性证据。
    if (!francSupported.has(lexicalLeader) && catalogLanguages.includes(lexicalLeader)
        && words.length >= thresholds.lexicalOnlyMinWords && letters.length >= thresholds.lexicalOnlyMinLetters
        && isDecisive(lexicalLeader) && consistentOrthography(lexicalLeader)) {
        return {...base, language: lexicalLeader, reason: 'lexical-only'};
    }
    if (!top || !catalogLanguages.includes(top.language)) return {...base, reason: 'unsupported'};
    return {...base, reason: consistentOrthography(top.language) ? 'function-words' : 'orthography'};
}
