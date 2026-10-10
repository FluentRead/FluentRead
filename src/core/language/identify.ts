/**
 * @file src/core/language/identify.ts
 *
 * 文件职责：对一段待翻译文本给出与目标语言无关的语言识别结论，是全文、悬浮、标题、划词和共享翻译客户端同目标跳过判断的唯一证据来源。
 * 主要内容：规范空白后生成技术标识符遮蔽副本并按文字切词；以非名称字母量确定主文字，把其他文字正文判为混合；按同句非 Latin 文字正文和相邻文字边界辨别短名称及连字符名称，让中日韩、Cyrillic、Arabic、Indic 和独立文字共用规则，不依赖品牌名单；中文额外保留既有短操作句架与小写技术术语证据，保护外语句子、功能词和引述文本；把名称、缩写、格式名和带版本名称限制为不能主导结论的少量权重。中日韩分别使用假名/谚文/汉字规则并以中文专用字形排除中日、中韩误判；单一语言文字直接给出结论；Latin、Cyrillic、Arabic、Devanagari 交给统计评估，并逐句检查是否夹带可信的其他语言句子；名称句架只对词和词间间隔进行常数次扫描，结果以文本为键做有界缓存，目标语言与排除列表不进入缓存。
 * 模块边界：本文件属于 core 纯算法，不比较目标语言、不读取配置或页面 lang、不修改原文与 DOM；配置语言匹配和各功能入口语义由 detect.ts 负责。
 */

import {classifyChineseHan, hasSimplifiedChineseEvidence, hasTraditionalChineseEvidence} from './chinese';
import {SCRIPT_UNIQUE_LANGUAGES, hasScriptUniqueVeto, segmentScriptWords, type ScriptWord, type WritingScript} from './scripts';
import {assessStatisticalLanguage} from './statistical';
import {classifyEmbeddedLatinWord, createLanguageDetectionCopy, isAcronymWord, isMixedCaseName, isNameVariantWord, isTechnicalAbbreviation} from './technicalTokens';
import {FUNCTION_WORDS, type StatisticalScript} from './lexicon';

export type LanguageIdentificationStatus = 'empty' | 'identified' | 'unknown' | 'mixed';

export interface LanguageIdentification {
    status: LanguageIdentificationStatus;
    /** 可信归属的规范语言代码；简繁字形相同的中文同时属于 zh-Hans 与 zh-Hant。 */
    languages: readonly string[];
    /** 不可信时的最佳猜测，仅供选择朗读音色或模型语言等非跳过用途。 */
    bestGuess?: string;
    method?: 'script' | 'chinese' | 'japanese' | 'korean' | 'statistical' | 'lexical-only';
}

const STATISTICAL_SCRIPTS = new Set<WritingScript>(['Latin', 'Cyrillic', 'Arabic', 'Devanagari']);
const CJK_SCRIPTS = new Set<WritingScript>(['Han', 'Kana', 'Hangul']);
const IDENTIFICATION_CACHE_LIMIT = 512;
const CACHEABLE_TEXT_LENGTH = 4096;
const MIXED_SENTENCE_MIN_WORDS = 3;
const MIXED_SENTENCE_MIN_LETTERS = 12;
/** 现代韩文汉字通常是 1–6 字名词，连续 8 个及以上汉字按中文句子处理。 */
const KOREAN_MAX_HANJA_RUN = 8;
// 句末标点覆盖 Latin/CJK、阿拉伯文（؟ ؛ ۔）、印度诸文字（। ॥）、希腊文问号及亚美尼亚、缅甸、高棉、吉兹文句号。
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?。！？;；:：\u061F\u061B\u06D4\u0964\u0965\u037E\u0589\u104B\u17D4\u1362])\s*(?=\S)|\n+/u;
const identificationCache = new Map<string, LanguageIdentification>();
const LATIN_FUNCTION_WORDS = new Set(Object.values(FUNCTION_WORDS.Latin).flatMap(words => [...words]));
// 这些是中文句法中的技术角色，不是浏览器、产品或供应商名称名单。未知名称也可由使用语境确认。
const TECHNICAL_ROLE_BEFORE = /(?:降为|降為|设为|設為|设置为|設置為|切换为|切換為|级别为|級別為|提示为|提示為|生产|生產|构建|構建|运行|運行|执行|執行|安装|安裝|启用|啟用|加载|加載|导入|導入|导出|導出|兼容|适配|適配|无|無)$/u;
const TECHNICAL_ROLE_AFTER = /^(?:只|仅|僅)?(?:构建|構建|脚本|腳本|插件|扩展|擴展|浏览器|瀏覽器|模式|级别|級別|格式|版本|组件|組件|控件|缓存|緩存|配置|参数|參數|服务|服務|接口|模型|环境|環境|内核|內核|引擎|协议|協議|文件|资源|資源|平台|项目|項目|模块|模組|检测|檢測|测试|測試|校验|校驗|日志|日誌|错误|錯誤|异常|異常|提示|验证|驗證)/u;
const EXPLICIT_FOREIGN_WORD_BEFORE = /(?:翻译|翻譯|解释|解釋|(?:英文|外语|外語)(?:标题|標題|短语|短語|提示|句子)?(?:列表)?|单词|單詞|词语|詞語)(?:一下|为|為|是|的)?$/u;
const FOREIGN_PROSE_MARKERS = new Set(['please', 'hello', 'welcome', 'goodbye', 'thanks', 'sorry', 'translate', 'click', 'retry', 'open', 'restart', 'failed', 'crashed', 'broken', 'unavailable', 'denied', 'expired']);
// 短操作提示只有一个服务名称和完整中文句架；不能把任意短中文旁的英文词当作名称。
const SHORT_UI_NAME_BEFORE = /^(?:继续使用|繼續使用|通过|通過|透过|透過)$/u;
const SHORT_UI_NAME_AFTER = /^(?:继续操作|繼續操作)?$/u;
// 只描述软件执行、数据及测试语境，不维护某篇文章里的英文术语名单。
const CHINESE_TECHNICAL_CONTEXT = /(?:连接|連接|持槽|排队|排隊|阻塞|互锁|互鎖|挡住|擋住|重试|重試|并发|併發|同桶|峰值|元数据|元資料|只传|只傳|传递|傳遞|查询|查詢|字段|欄位|参数|參數|变量|變量|集合|状态|狀態|分支|调用|呼叫|入口|响应|回應|缓存|緩存|配置|用例|回归|回歸|所有权|所有權|计数|計數|计一次|計一次|恢复|恢復|安装|安裝|运行|運行|执行|執行|构建|構建|测试|測試|调度|調度|处理链|處理鏈|释放|釋放|占位|按实际选择|按實際選擇|字节|位元組|标准方案|標準方案|产物|產物)/u;
const CHINESE_CODE_CONTEXT = /(?:字段|欄位|参数|參數|变量|變量|元数据|元資料|调用|呼叫|缓存|緩存|并发|併發|调度|調度|处理链|處理鏈|持槽|阻塞|互锁|互鎖|安装|安裝|回归|回歸)/u;
const CAPITALIZED_FIELD_CONTEXT = /^(?:字段|欄位|参数|參數|变量|變量|集合|状态|狀態)/u;
const TECHNICAL_EXPRESSION_GAP = /^[ \t/、+→&|!-]+$/u;
const TECHNICAL_CLAUSE_BOUNDARY = /[,.!?。！？;；:：，\n]/u;
const TECHNICAL_SENTENCE_BOUNDARY = /(?<=[.!?。！？])\s*(?=\S)|\n+/u;
const NATIVE_SENTENCE_BOUNDARY = /[.!?。！？\n\u061F\u06D4\u0964\u0965\u0589\u104B\u17D4\u1362]/u;
const NAME_WORD_GAP = /^[ \t/、-]+$/u;
const NATIVE_NAME_MIN_LETTERS = 8;
// 封闭类并列连词确认名称枚举关系，适用于多种非 Latin 文字；不包含品牌或技术角色关键词。
const NATIVE_COORDINATORS = new Set(['和', '与', '與', '或', '及', '以及', 'と', 'や', '及び', 'または',
    '및', '과', '와', '또는', 'и', 'і', 'или', 'та', 'або', 'و', 'أو', 'یا', 'और', 'या', 'και', 'ή', 'ו', 'או']);

function writingGroup(word: ScriptWord): string {
    return CJK_SCRIPTS.has(word.script) ? 'CJK' : word.script;
}

/** 同句至多 256 字符的局部窗口，只寻找已有通用技术缩写证据，不借用前后完整句子的内容。 */
function hasNearbyTechnicalAnchor(copy: string, first: ScriptWord, last: ScriptWord): boolean {
    const before = copy.slice(Math.max(0, first.start - 128), first.start).split(NATIVE_SENTENCE_BOUNDARY).at(-1)!;
    const after = copy.slice(last.end, last.end + 128).split(NATIVE_SENTENCE_BOUNDARY)[0]!;
    return segmentScriptWords(before + ' ' + after).some(word => isTechnicalAbbreviation(word.text));
}

/**
 * 名称字形与正文句架共同提供证据：每个名称最多三个 ASCII Latin 词，顿号枚举逐项检查，不能含功能词、外语动作或引号，
 * 同句至少八个同一非 Latin 文字字符，并与该文字紧邻。普通多词标题需要后接母语正文；
 * 单个名称、内部大写/缩写名称及连字符名称也可作母语句末宾语，不能跨完整句子借用正文证据。
 * 一段名称最多计两个字符的预算，两侧母语句架俱全时计一点五，格式名仍为零；
 * 顿号枚举逐项计权，不让名称数量代替正文证据。原文不会被替换，每个词和间隔仅遍历常数次。
 */
function findNativeNamedRuns(copy: string, words: readonly ScriptWord[]): ReadonlyMap<ScriptWord, number> {
    const names = new Map<ScriptWord, number>();
    let sentenceStart = 0;
    while (sentenceStart < words.length) {
        let sentenceEnd = sentenceStart + 1;
        const counts = new Map<string, number>();
        const countNative = (word: ScriptWord): void => {
            if (word.script === 'Latin') return;
            const group = writingGroup(word);
            counts.set(group, (counts.get(group) ?? 0) + word.letters);
        };
        countNative(words[sentenceStart]!);
        while (sentenceEnd < words.length
            && !NATIVE_SENTENCE_BOUNDARY.test(copy.slice(words[sentenceEnd - 1]!.end, words[sentenceEnd]!.start))) {
            countNative(words[sentenceEnd]!);
            sentenceEnd += 1;
        }
        let nativeGroup: string | undefined;
        let nativeLetters = 0;
        for (const [group, letters] of counts) {
            if (letters > nativeLetters) { nativeGroup = group; nativeLetters = letters; }
        }
        if (nativeLetters >= NATIVE_NAME_MIN_LETTERS) {
            for (let index = sentenceStart; index < sentenceEnd; index += 1) {
                const first = words[index]!;
                if (first.script !== 'Latin') continue;
                const runStart = index;
                while (index + 1 < sentenceEnd && words[index + 1]!.script === 'Latin'
                    && NAME_WORD_GAP.test(copy.slice(words[index]!.end, words[index + 1]!.start))) index += 1;
                const last = words[index]!;
                if (last.end - first.start > 64) continue;
                const run = words.slice(runStart, index + 1);
                const enumeration = copy.slice(first.start, last.end).includes('、');
                const entries = enumeration ? copy.slice(first.start, last.end).split('、').map(part => segmentScriptWords(part)) : [run];
                // 顿号分隔的是独立名称，不能把 Google Meet、Teams、Zoom 合成一个四词标题。
                // 完整列表仍受 64 字符、母语句架、外语反证和逐项名称预算约束。
                if (entries.some(entry => entry.length > 3)) continue;
                const before = copy.slice(Math.max(0, first.start - 32), first.start).trimEnd();
                const after = copy.slice(last.end, last.end + 32).trimStart();
                if (/["'“‘「『]$/u.test(before) || /^["'”’」』]/u.test(after)
                    || EXPLICIT_FOREIGN_WORD_BEFORE.test(before)) continue;
                const previous = runStart > sentenceStart ? words[runStart - 1] : undefined;
                const next = index + 1 < sentenceEnd ? words[index + 1] : undefined;
                const nativeBefore = previous !== undefined && writingGroup(previous) === nativeGroup
                    && /^[ \t]*$/u.test(copy.slice(previous.end, first.start));
                // 单个紧贴名称的 + 可是版本后缀；分离的加号及其他运算符不能提供母语边界。
                const nativeAfter = next !== undefined && writingGroup(next) === nativeGroup
                    && /^\+?[ \t]*$/u.test(copy.slice(last.end, next.start));
                if (!nativeBefore && !nativeAfter) continue;
                const structured = run.some(word => isMixedCaseName(word.text) || isAcronymWord(word.text))
                    || copy.slice(first.start, last.end).includes('-');
                // 一串普通多词标题不能互相证明为名称；扩大的枚举须有单词名称或独立结构证据。
                if (enumeration && run.length > 3 && !structured && entries.every(entry => entry.length > 1)) continue;
                // 逗号后的普通 Title Case 片段可能是外语陈述；只有真正句首、标签/枚举边界或
                // 两侧母语句架才有名称证据，不能凭后接母语把孤立单词或标题吞掉。
                if (!nativeBefore && !structured && previous !== undefined
                    && !/^[ \t]*[:：、/][ \t]*$/u.test(copy.slice(previous.end, first.start))) continue;
                if (!nativeAfter && run.length > 1 && !structured) continue;
                // 普通首字母大写的句末单词也可能是外语提示。需要独立技术证据确认这个
                // 名称角色；真实名称仍可由两侧母语、内部大写、缩写或连字符确认。
                const sibling = runStart >= sentenceStart + 2 ? words[runStart - 2] : undefined;
                const namedSibling = previous !== undefined && NATIVE_COORDINATORS.has(previous.text)
                    && sibling !== undefined && sibling.script === 'Latin' && names.has(sibling)
                    && classifyEmbeddedLatinWord(sibling.text).role !== 'format';
                if (!nativeAfter && !structured && !namedSibling && !hasNearbyTechnicalAnchor(copy, first, last)) continue;
                if (!run.every((word, position) => {
                    const variant = position > 0 && isNameVariantWord(word.text)
                        && (isMixedCaseName(first.text) || isAcronymWord(first.text));
                    return (!LATIN_FUNCTION_WORDS.has(word.text.toLowerCase()) || variant)
                        && !FOREIGN_PROSE_MARKERS.has(word.text.toLowerCase())
                        && (classifyEmbeddedLatinWord(word.text).role !== 'prose'
                            || /^[A-Z][a-z]{1,23}$/u.test(word.text) || variant);
                })) continue;
                const weight = nativeBefore && nativeAfter ? 1.5 : 2;
                for (const word of run) names.set(word, classifyEmbeddedLatinWord(word.text).role === 'format'
                    ? 0 : enumeration ? weight : weight / run.length);
            }
        }
        sentenceStart = sentenceEnd;
    }
    return names;
}

/**
 * 外语反证优先于名称字形。Latin 连续片段中的功能词、明确外语动作、引述的未知缩写以及
 * 没有通用技术缩写证据的两个以上全大写词仍是正文；DO NOT 不能因大写而伪装成两个名称。
 * 按片段判断并逐词覆盖名称回退，适用于任何主文字，也保护跨完整句子的外语短提示。
 */
function findForeignLatinWords(copy: string, words: readonly ScriptWord[], embeddedNames: ReadonlyMap<ScriptWord, number>): ReadonlySet<ScriptWord> {
    const foreign = new Set<ScriptWord>();
    for (let index = 0; index < words.length; index += 1) {
        const first = words[index]!;
        if (first.script !== 'Latin') continue;
        const start = index;
        while (index + 1 < words.length && words[index + 1]!.script === 'Latin'
            && NAME_WORD_GAP.test(copy.slice(words[index]!.end, words[index + 1]!.start))) index += 1;
        const last = words[index]!;
        const before = copy.slice(Math.max(0, first.start - 32), first.start).trimEnd();
        const after = copy.slice(last.end, last.end + 32).trimStart();
        let allUnknownAcronyms = index > start;
        let proseEvidence = EXPLICIT_FOREIGN_WORD_BEFORE.test(before);
        const quoted = /["'“‘「『]$/u.test(before) || /^["'”’」』]/u.test(after);
        for (let cursor = start; cursor <= index; cursor += 1) {
            const word = words[cursor]!;
            const lower = word.text.toLowerCase();
            const technical = isTechnicalAbbreviation(word.text) || classifyEmbeddedLatinWord(word.text).role === 'format';
            const nameVariant = cursor > start && isNameVariantWord(word.text) && embeddedNames.has(word)
                && (isMixedCaseName(first.text) || isAcronymWord(first.text));
            allUnknownAcronyms &&= isAcronymWord(word.text) && !technical;
            if ((!technical && !nameVariant && word.letters > 1 && LATIN_FUNCTION_WORDS.has(lower))
                || (FOREIGN_PROSE_MARKERS.has(lower) && !(word.text === lower && embeddedNames.has(word)))
                || (quoted && isAcronymWord(word.text) && !technical)) proseEvidence = true;
        }
        // 母语技术句子可包含尚未列出的缩写组合（如某种运行时/后端名称）；需要两侧母语
        // 句架和同一句附近已有通用缩写的独立证据，不能凭大写、主语言比例或跨句证据放行。
        if (allUnknownAcronyms && /\p{L}$/u.test(before) && /^\p{L}/u.test(after)) {
            if (hasNearbyTechnicalAnchor(copy, first, last)) allUnknownAcronyms = false;
        }
        if (!proseEvidence && !allUnknownAcronyms) continue;
        for (let cursor = start; cursor <= index; cursor += 1) foreign.add(words[cursor]!);
    }
    return foreign;
}

/**
 * 小写术语不能只凭中文占比获准：同一句至少有八个汉字、明确中文证据及代码/缩写锚点；
 * 每个短语还须在含中文技术句架的局部子句中。箭头、斜杠及枚举按完整表达式判断，
 * 各项最多三个词，总长有界；功能词、引文和明确要求解释的外语继续作为正文。
 */
function findChineseTechnicalTerms(copy: string, words: readonly ScriptWord[]): ReadonlyMap<ScriptWord, number> {
    const terms = new Map<ScriptWord, number>();
    if (!words.some(word => word.script === 'Han') || !words.some(word => word.script === 'Latin')
        || classifyChineseHan(copy) === undefined) return terms;
    let offset = 0;
    const sentences = copy.split(TECHNICAL_SENTENCE_BOUNDARY).map(text => {
        const start = copy.indexOf(text, offset);
        offset = start + text.length;
        const sentenceWords = segmentScriptWords(text);
        const hanCount = sentenceWords.reduce((count, word) => count + (word.script === 'Han' ? word.letters : 0), 0);
        return {
            text, start, end: offset,
            credible: hanCount >= 8
                && (CHINESE_CODE_CONTEXT.test(text) && sentenceWords.some((word, index) => word.script === 'Latin'
                    && sentenceWords[index + 1]?.script === 'Latin'
                    && /^[ \t]*[/、+→&|][ \t]*$/u.test(text.slice(word.end, sentenceWords[index + 1]!.start)))
                    || sentenceWords.some(word => word.script === 'Latin'
                    && (isAcronymWord(word.text) || isMixedCaseName(word.text)
                        || /^[A-Z][a-z]{1,23}$/u.test(word.text) && CAPITALIZED_FIELD_CONTEXT.test(text.slice(word.end).trimStart())))),
        };
    });
    let sentenceIndex = 0;
    for (let index = 0; index < words.length; index += 1) {
        const first = words[index]!;
        if (first.script !== 'Latin') continue;
        while (sentenceIndex + 1 < sentences.length && first.start >= sentences[sentenceIndex]!.end) sentenceIndex += 1;
        const sentence = sentences[sentenceIndex]!;
        if (!sentence.credible) continue;
        const start = index;
        while (index + 1 < words.length && words[index + 1]!.script === 'Latin'
            && TECHNICAL_EXPRESSION_GAP.test(copy.slice(words[index]!.end, words[index + 1]!.start))) index += 1;
        const run = words.slice(start, index + 1);
        const last = run.at(-1)!;
        const expression = copy.slice(first.start, last.end);
        if (expression.length > 128 || expression.split(/[/、+→&|!-]+/u).some(part => part.trim().split(/\s+/u).length > 3)) continue;
        const sentenceText = sentence.text;
        const localStart = first.start - sentence.start;
        const localEnd = last.end - sentence.start;
        const before = sentenceText.slice(Math.max(0, localStart - 64), localStart).split(TECHNICAL_CLAUSE_BOUNDARY).at(-1)!.trimEnd();
        const after = sentenceText.slice(localEnd, localEnd + 64).split(TECHNICAL_CLAUSE_BOUNDARY)[0]!.trimStart();
        if (!/\p{Script=Han}$/u.test(before) && !/^\p{Script=Han}/u.test(after)) continue;
        if (!CHINESE_TECHNICAL_CONTEXT.test(before + after)
            && !run.some(word => isAcronymWord(word.text) || isMixedCaseName(word.text))) continue;
        if (EXPLICIT_FOREIGN_WORD_BEFORE.test(before) || /["'“‘「『]$/u.test(before) || /^["'”’」』]/u.test(after)) continue;
        if (!run.every(word => /^[A-Za-z]{1,24}$/u.test(word.text)
            && !LATIN_FUNCTION_WORDS.has(word.text.toLowerCase())
            && (word.text === 'retry' || !FOREIGN_PROSE_MARKERS.has(word.text.toLowerCase())))) continue;
        const items = expression.split(/[/、+→&|!-]+/u).filter(part => part.trim()).length;
        for (const word of run) terms.set(word, 2 * items / run.length);
    }
    return terms;
}

const EMPTY: LanguageIdentification = Object.freeze({status: 'empty', languages: Object.freeze([])});
const UNKNOWN: LanguageIdentification = Object.freeze({status: 'unknown', languages: Object.freeze([])});
const MIXED: LanguageIdentification = Object.freeze({status: 'mixed', languages: Object.freeze([])});

/** 识别只关心词和句子边界：合并行内空白，保留换行作为句子边界。 */
export function normalizeLanguageEvidenceText(value: string): string {
    return value.replace(/[^\S\n]+/gu, ' ').replace(/ ?\n[\s]*/gu, '\n').trim();
}

export function clearLanguageIdentificationCache(): void {
    identificationCache.clear();
}

function identified(languages: readonly string[], method: NonNullable<LanguageIdentification['method']>): LanguageIdentification {
    return Object.freeze({status: 'identified', languages: Object.freeze([...languages]), bestGuess: languages[0], method});
}

function unknown(bestGuess?: string): LanguageIdentification {
    return bestGuess ? Object.freeze({status: 'unknown', languages: Object.freeze([]), bestGuess}) : UNKNOWN;
}

interface EmbeddedEvidence {
    foreignProse: boolean;
    nameWeight: number;
}

/**
 * 统计主文字以外的词：其他文字的多字母词都是外语正文；Latin 词按名称/格式/单字母/正文分类；
 * 希腊字母单字常作数学或物理符号，不视为外语。
 */
function assessEmbeddedWords(words: readonly ScriptWord[], isMain: (word: ScriptWord) => boolean, versionedNames: number,
    embeddedNames: ReadonlyMap<ScriptWord, number>, foreignWords: ReadonlySet<ScriptWord>): EmbeddedEvidence {
    let foreignProse = false;
    let nameWeight = versionedNames * 2;
    for (const word of words) {
        if (isMain(word)) continue;
        if (word.script === 'Latin') {
            if (foreignWords.has(word)) { foreignProse = true; continue; }
            if (embeddedNames.has(word)) { nameWeight += embeddedNames.get(word)!; continue; }
            const {role, weight} = classifyEmbeddedLatinWord(word.text);
            if (role === 'prose') foreignProse = true;
            nameWeight += weight;
            continue;
        }
        if (word.script === 'Greek' && word.letters === 1) continue;
        foreignProse = true;
    }
    return {foreignProse, nameWeight};
}

/**
 * 中文技术说明常把未带版本的名称直接嵌入正文（例如 DeepSeek Harness）。逐词拒绝所有
 * 首字母大写词会让整段重复翻译。按连续 Latin 短语判断：接纳紧邻汉字的 1–3 词名称及
 * 有中文技术角色支撑的 1–2 词术语，支持顿号/斜杠枚举；功能词、引文、明确要求翻译的词、
 * 外语句子和跨句边界不能被吞掉，术语只在可信中文语境中生效；不足八字时只接纳
 * 至少四字、一个名称且具有完整中文操作句架的提示，其他短文本仍保持未知。
 * 不依赖产品名单、页面 lang 或目标语言，也不改变送给供应商的原文。
 */
function findEmbeddedNames(copy: string, words: readonly ScriptWord[]): ReadonlyMap<ScriptWord, number> {
    const names = new Map<ScriptWord, number>();
    const hanCount = words.reduce((count, word) => count + (word.script === 'Han' ? word.letters : 0), 0);
    if (hanCount < 4) return names;
    const chineseContext = classifyChineseHan(copy) !== undefined;
    for (let index = 0; index < words.length; index += 1) {
        if (words[index]!.script !== 'Latin') continue;
        const start = index;
        while (index + 1 < words.length && words[index + 1]!.script === 'Latin' &&
            /^[ \t/、-]+$/u.test(copy.slice(words[index]!.end, words[index + 1]!.start))) index += 1;
        const run = words.slice(start, index + 1);
        if (run.length > 3 || run.at(-1)!.end - run[0]!.start > 64) continue;
        const before = copy.slice(Math.max(0, run[0]!.start - 16), run[0]!.start).trimEnd();
        const after = copy.slice(run.at(-1)!.end, run.at(-1)!.end + 16).trimStart();
        const shortUiName = chineseContext && run.length === 1
            && (isMixedCaseName(run[0]!.text) || /^[A-Z][a-z]{1,23}$/u.test(run[0]!.text))
            && SHORT_UI_NAME_BEFORE.test(copy.slice(0, run[0]!.start).trim())
            && SHORT_UI_NAME_AFTER.test(copy.slice(run[0]!.end).trim());
        if (hanCount < 8 && !shortUiName) continue;
        const technicalRole = shortUiName || chineseContext && (run.length <= 2 || copy.slice(run[0]!.start, run.at(-1)!.end).includes('/'))
            && (TECHNICAL_ROLE_BEFORE.test(before.replace(/[、,，]\s*$/u, '')) || TECHNICAL_ROLE_AFTER.test(after))
            && !EXPLICIT_FOREIGN_WORD_BEFORE.test(before);
        const hanBefore = /\p{Script=Han}$/u.test(before);
        const hanAfter = /^\p{Script=Han}/u.test(after);
        if (!hanBefore && !hanAfter && !technicalRole) continue;
        if (EXPLICIT_FOREIGN_WORD_BEFORE.test(before)) continue;
        // 纯首字母大写名称需要两侧正文支撑；被标点切断的孤立词不能靠另一侧的汉字获准。
        if (!technicalRole && (!hanBefore || !hanAfter) && !run.some(word => isMixedCaseName(word.text) || isAcronymWord(word.text))) continue;
        // 引述的外语词不是名称点缀；只借助另一侧汉字也不能越过引号。
        if (/["'“‘「『]$/u.test(before) || /^["'”’」』]/u.test(after)) continue;
        if (!run.every((word, position) => {
            const nameVariant = position > 0 && isNameVariantWord(word.text)
                && (isMixedCaseName(run[0]!.text) || isAcronymWord(run[0]!.text));
            return (!LATIN_FUNCTION_WORDS.has(word.text.toLowerCase()) || nameVariant)
            && !FOREIGN_PROSE_MARKERS.has(word.text.toLowerCase())
            && (classifyEmbeddedLatinWord(word.text).role !== 'prose' || /^[A-Z][a-z]{1,23}$/u.test(word.text)
                || nameVariant || (technicalRole && /^[A-Za-z]{2,24}$/u.test(word.text)));
        })) continue;
        // 一个连续标签按一个名称计权，词段仍逐项排除正文证据；不能按英文拼写长度压倒中文语法。
        // 顿号枚举里的名称仍分别计权，避免大量产品名借少量中文主导语言结论。
        const enumeration = copy.slice(run[0]!.start, run.at(-1)!.end).includes('、');
        for (const word of run) names.set(word, enumeration ? 2 : 2 / run.length);
    }
    return names;
}

function statisticalWords(words: readonly ScriptWord[], script: StatisticalScript): string[] {
    return words
        .filter(word => word.script === script)
        .map(word => word.text)
        .filter(word => script !== 'Latin' || (!isAcronymWord(word) && !isMixedCaseName(word)));
}

/**
 * 已可信识别整段后逐句检查。这里只需要“存在其他语言证据”，比跳过判断更敏感：
 * 句子被可信识别为其他语言，或其他语言的功能词严格领先，都视为夹带外语句子并保留翻译。
 */
function containsForeignSentence(copy: string, script: StatisticalScript, language: string): boolean {
    const sentences = copy.split(SENTENCE_BOUNDARY_PATTERN);
    if (sentences.length < 2) return false;
    return sentences.some((sentence) => {
        const words = statisticalWords(segmentScriptWords(sentence), script);
        const letters = words.reduce((total, word) => total + [...word].filter(character => /\p{L}/u.test(character)).length, 0);
        if (words.length < MIXED_SENTENCE_MIN_WORDS || letters < MIXED_SENTENCE_MIN_LETTERS) return false;
        const assessment = assessStatisticalLanguage(script, words);
        const foreign = assessment.language ?? assessment.functionWordLeader;
        return foreign !== undefined && foreign !== language;
    });
}

function identifyCjk(copy: string, words: readonly ScriptWord[], versionedNames: number,
    embeddedNames: ReadonlyMap<ScriptWord, number>, foreignWords: ReadonlySet<ScriptWord>): LanguageIdentification {
    const counts = {Han: 0, Kana: 0, Hangul: 0};
    for (const word of words) {
        if (word.script === 'Han' || word.script === 'Kana' || word.script === 'Hangul') counts[word.script] += word.letters;
    }
    const native = counts.Han + counts.Kana + counts.Hangul;
    const embedded = assessEmbeddedWords(words, word => CJK_SCRIPTS.has(word.script), versionedNames, embeddedNames, foreignWords);
    if (embedded.foreignProse || (counts.Kana > 0 && counts.Hangul > 0)) return MIXED;
    // 名称只能点缀正文：按词计权后超过母语字符一半时，无法证明整段属于目标语言。
    if (embedded.nameWeight * 2 > native) return UNKNOWN;
    const han = words.filter(word => word.script === 'Han').map(word => word.text).join('');

    if (counts.Kana > 0) {
        return hasSimplifiedChineseEvidence(han) || hasTraditionalChineseEvidence(han)
            ? MIXED
            : identified(['ja'], 'japanese');
    }
    if (counts.Hangul > 0) {
        // 韩文汉字使用传统字形且多为短名词；简体字、汉字多于谚文或出现中文句子式的长汉字串时不能证明是韩文。
        // 字段数来自任意网页文本，不能展开为函数参数；超多短汉字段会超过运行时参数上限。
        let longestHanRun = 0;
        for (const word of words) {
            if (word.script === 'Han') longestHanRun = Math.max(longestHanRun, word.letters);
        }
        return hasSimplifiedChineseEvidence(han) || counts.Han > counts.Hangul || longestHanRun >= KOREAN_MAX_HANJA_RUN
            ? MIXED
            : identified(['ko'], 'korean');
    }
    const script = classifyChineseHan(copy);
    if (script === 'shared') return identified(['zh-Hans', 'zh-Hant'], 'chinese');
    return script ? identified([`zh-${script}`], 'chinese') : unknown('zh');
}

function identifyUncached(value: string): LanguageIdentification {
    if (!/\p{L}/u.test(value)) return EMPTY;
    const detectionCopy = createLanguageDetectionCopy(value);
    const words = segmentScriptWords(detectionCopy.text);
    if (words.length === 0) return UNKNOWN;
    const embeddedNames = new Map(findEmbeddedNames(detectionCopy.text, words));
    for (const [word, weight] of findNativeNamedRuns(detectionCopy.text, words)) {
        if (!embeddedNames.has(word) || weight < embeddedNames.get(word)!) embeddedNames.set(word, weight);
    }
    for (const [word, weight] of findChineseTechnicalTerms(detectionCopy.text, words)) {
        // 格式名仍保持零权重，已接纳的名称沿用原有预算；新规则只补足小写术语的正文误判。
        if (!embeddedNames.has(word) && classifyEmbeddedLatinWord(word.text).role === 'prose') embeddedNames.set(word, weight);
    }
    const foreignWords = findForeignLatinWords(detectionCopy.text, words, embeddedNames);

    // 主文字按“非名称字母”决定：PDF、OpenAI 这类名称不能把中文句子变成 Latin 文本。
    const weights = new Map<string, number>();
    for (const word of words) {
        const group = writingGroup(word);
        const contributes = word.script !== 'Latin' || foreignWords.has(word)
            || (!embeddedNames.has(word) && classifyEmbeddedLatinWord(word.text).role === 'prose');
        if (contributes) weights.set(group, (weights.get(group) ?? 0) + word.letters);
    }
    const ranked = [...weights].sort((left, right) => right[1] - left[1]);
    if (ranked.length === 0 || (ranked[1] && ranked[1][1] === ranked[0]![1])) return UNKNOWN;
    const main = ranked[0]![0];

    if (main === 'CJK') return identifyCjk(detectionCopy.text, words, detectionCopy.versionedNames, embeddedNames, foreignWords);

    const script = main as WritingScript;
    const embedded = assessEmbeddedWords(words, word => word.script === script, script === 'Latin' ? 0 : detectionCopy.versionedNames, embeddedNames, foreignWords);
    if (embedded.foreignProse) return MIXED;
    const nativeLetters = weights.get(script)!;
    if (script !== 'Latin' && embedded.nameWeight * 2 > nativeLetters) return UNKNOWN;

    const scriptLanguage = SCRIPT_UNIQUE_LANGUAGES[script];
    if (scriptLanguage) {
        if (nativeLetters < 2 || hasScriptUniqueVeto(script, detectionCopy.text)) return UNKNOWN;
        return identified([scriptLanguage], 'script');
    }
    if (!STATISTICAL_SCRIPTS.has(script)) return UNKNOWN;

    const statisticalScript = script as StatisticalScript;
    const assessment = assessStatisticalLanguage(statisticalScript, statisticalWords(words, statisticalScript));
    if (!assessment.language) return unknown(assessment.bestGuess);
    if (containsForeignSentence(detectionCopy.text, statisticalScript, assessment.language)) return MIXED;
    return identified([assessment.language], assessment.reason === 'lexical-only' ? 'lexical-only' : 'statistical');
}

/** 识别文本语言；只以文本为缓存键，目标语言、排除语言或源语言变化都会重新比较而不会复用旧结论。 */
export function identifyTextLanguage(text: string): LanguageIdentification {
    const value = normalizeLanguageEvidenceText(text);
    if (value.length > CACHEABLE_TEXT_LENGTH) return identifyUncached(value);
    const cached = identificationCache.get(value);
    if (cached) {
        identificationCache.delete(value);
        identificationCache.set(value, cached);
        return cached;
    }
    const result = identifyUncached(value);
    identificationCache.set(value, result);
    if (identificationCache.size > IDENTIFICATION_CACHE_LIMIT) {
        identificationCache.delete(identificationCache.keys().next().value!);
    }
    return result;
}
