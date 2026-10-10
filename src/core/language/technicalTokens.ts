/**
 * @file src/core/language/technicalTokens.ts
 *
 * 文件职责：统一识别文本中的技术标识符和名称类 Latin 词，只生成供语言识别使用的副本，避免把模型名、版本号、哈希、URL、路径和文件名当成外语正文。
 * 主要内容：按从结构最强到最弱的顺序遮蔽 URL、邮箱、@提及、行内代码、带编号的仓库引用、参数赋值、带单位数值、路径、文件名、UUID、提交哈希、版本号、带版本的产品或模型名称（可带一个首字母大写后缀及规模/变体词）、代码标识符和字母数字混合编号；URL、邮箱、域名、引用、赋值、路径和文件名按最大合法候选检查一次，名称保留超长前缀对整体匹配的拒绝语义，避免重复回溯或改变计权；把连续三个以上全大写词还原为普通词以免外语句子伪装成缩写；为非 Latin 正文中的 Latin 词给出缩写、内部大写名称、格式名、常见技术词、单字母或普通正文的角色与权重，提供通用技术缩写证据以区分大写名称与大写外语短句。可核对的公开符号包括 createLanguageDetectionCopy、classifyEmbeddedLatinWord、isAcronymWord、isMixedCaseName、isTechnicalAbbreviation、LanguageDetectionCopy、EmbeddedLatinWordRole。
 * 模块边界：本文件属于 core 纯算法，只读字符串并返回新的识别副本，绝不修改原文、链接、代码或宿主 DOM；不判断文本属于哪种语言，也不访问配置、浏览器或检测库。
 */

export interface LanguageDetectionCopy {
    /** 仅供识别：结构化标识符替换为空格，全大写短语改为小写。 */
    text: string;
    /** 被遮蔽的结构化标识符数量（URL、路径、哈希、版本、代码等），不代表任何语言。 */
    identifiers: number;
    /** 被遮蔽的带版本产品/模型名称数量，按名称计权，不能主导目标语言结论。 */
    versionedNames: number;
}

export type EmbeddedLatinWordRole = 'name' | 'format' | 'letter' | 'prose';

/** Latin 词两侧的边界：ASCII 字母数字、下划线及带附加符号的 Latin 字母都不能与标识符相邻。 */
const LATIN_WORD_CHARACTER = 'A-Za-z0-9_\\u00C0-\\u024F\\u1E00-\\u1EFF';
const LATIN_WORD_CHARACTER_PATTERN = new RegExp(`[${LATIN_WORD_CHARACTER}]`, 'u');
const BEFORE = `(?<![${LATIN_WORD_CHARACTER}])`;
const AFTER = `(?![${LATIN_WORD_CHARACTER}])`;

const FILE_EXTENSIONS = [
    'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'vue', 'svelte', 'json', 'jsonl', 'css', 'scss', 'less',
    'html', 'htm', 'md', 'mdx', 'py', 'ipynb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
    'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'csv',
    'tsv', 'txt', 'log', 'pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf', 'png', 'jpg',
    'jpeg', 'gif', 'svg', 'webp', 'ico', 'mp3', 'mp4', 'mov', 'wav', 'flac', 'webm', 'zip', 'tar', 'gz', 'tgz',
    '7z', 'rar', 'exe', 'dmg', 'apk', 'ipa', 'srt', 'vtt', 'ass', 'ssa', 'lrc', 'wasm', 'onnx', 'bin', 'gguf',
    'safetensors', 'lock', 'env', 'sql', 'db', 'sqlite',
].join('|');

const TOP_LEVEL_DOMAINS = 'com|org|net|edu|gov|io|ai|dev|app|co|me|cn|jp|kr|de|fr|uk|ru|tw|hk|info|xyz|tech|so|gg|tv|ly|sh';

const URL_PATTERN = new RegExp(`${BEFORE}(?:[a-z][a-z\\d+.-]*:\\/\\/|www\\.)[^\\s<>"'\`，。、；：！？（）【】《》「」]+`, 'iyu');
const URL_CANDIDATE_PATTERN = new RegExp(`${BEFORE}[a-z][a-z\\d+.-]*`, 'giu');
// www. 是 URL 的另一种入口，可位于失败的协议候选内部；只在该候选内寻找，不能重扫后续全文。
const URL_NESTED_CANDIDATE_PATTERN = new RegExp(`${BEFORE}www\\.`, 'iu');
const EMAIL_PATTERN = /[A-Za-z\d._%+-]+@[A-Za-z\d-]+(?:\.[A-Za-z\d-]+)+/yu;
const EMAIL_CANDIDATE_PATTERN = /[A-Za-z\d._%+-]+/gu;
const DOMAIN_PATTERN = new RegExp(`${BEFORE}(?:[a-z\\d](?:[a-z\\d-]*[a-z\\d])?\\.)+(?:${TOP_LEVEL_DOMAINS})(?:\\/[^\\s<>"'\`，。、；：！？（）]*)?${AFTER}`, 'iyu');
const DOMAIN_CANDIDATE_PATTERN = new RegExp(`${BEFORE}[a-z\\d](?:[a-z\\d-]*[a-z\\d])?(?:\\.[a-z\\d](?:[a-z\\d-]*[a-z\\d])?)*`, 'giu');
// 必要语法预检只排除绝不可能匹配的文本，不改变完整正则的边界与遮蔽顺序。
const DOMAIN_SUFFIX_PATTERN = new RegExp(`\\.(?:${TOP_LEVEL_DOMAINS})${AFTER}`, 'iu');
const FILE_SUFFIX_PATTERN = new RegExp(`\\.(?:${FILE_EXTENSIONS})${AFTER}`, 'iu');
const EMAIL_DOMAIN_PATTERN = /@[A-Za-z\d-]+(?:\.[A-Za-z\d-]+)+/u;
const MENTION_PATTERN = new RegExp(`${BEFORE}@[A-Za-z\\d_](?:[A-Za-z\\d_.-]*[A-Za-z\\d_])?`, 'gu');
const INLINE_CODE_PATTERN = /`[^`\n]{1,200}`/gu;
// owner/repository#123 是引用，单独的 and/or 仍是正文；赋值和单位必须有明确结构，不能遮蔽普通词。
const REPOSITORY_REFERENCE_PATTERN = new RegExp(`${BEFORE}[\\w.-]+\\/[\\w.-]+#\\d+${AFTER}`, 'yu');
const REPOSITORY_CANDIDATE_PATTERN = new RegExp(`${BEFORE}[\\w.-]+`, 'gu');
const PARAMETER_ASSIGNMENT_PATTERN = new RegExp(`${BEFORE}[A-Za-z_][\\w.-]*[ \\t]*=[ \\t]*(?:-?\\d+(?:\\.\\d+)?|true|false|null)${AFTER}`, 'yu');
const ASSIGNMENT_CANDIDATE_PATTERN = new RegExp(`${BEFORE}[A-Za-z_][\\w.-]*`, 'gu');
const MEASUREMENT_PATTERN = new RegExp(`${BEFORE}\\d+(?:\\.\\d+)?[ \\t]*(?:px|rem|em|vw|vh|vmin|vmax|ms|s|Hz|kHz|MHz|GHz|KB|MB|GB|TB|KiB|MiB|GiB|TiB)${AFTER}`, 'gu');
const PATH_PATTERN = new RegExp(`${BEFORE}(?:[A-Za-z]:)?(?:~|\\.{1,2})?[\\/\\\\]?[\\w.@+-]+(?:[\\/\\\\][\\w.@+-]+)+[\\/\\\\]?${AFTER}`, 'yu');
const PATH_CANDIDATE_PATTERN = new RegExp(`${BEFORE}(?:[A-Za-z]:)?(?:~|\\.{1,2})?[\\/\\\\]?[\\w.@+-]+(?:[\\/\\\\][\\w.@+-]+)*[\\/\\\\]?`, 'gu');
const FILE_EXTENSION_SUFFIX_PATTERN = new RegExp(`\\.(?:${FILE_EXTENSIONS})[\\\\/]?$`, 'iu');
const FILE_NAME_PATTERN = new RegExp(`${BEFORE}\\.?[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXTENSIONS})${AFTER}`, 'iyu');
const FILE_CANDIDATE_PATTERN = new RegExp(`${BEFORE}\\.?[\\w-]+(?:\\.[\\w-]+)*`, 'giu');
const UUID_PATTERN = new RegExp(`${BEFORE}[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}${AFTER}`, 'giu');
// 提交哈希必须同时含数字和字母，避免 decade、abcdefa 等普通或伪造单词被当作标识符。
const HASH_PATTERN = new RegExp(`${BEFORE}(?=[\\da-f]*\\d)(?=[\\da-f]*[a-f])[\\da-f]{7,64}${AFTER}`, 'giu');
const VERSION_PATTERN = new RegExp(`${BEFORE}v?\\d+(?:\\.\\d+){1,3}(?:-[\\w.]+)?(?:\\+[\\w.]+)?${AFTER}`, 'giu');
const MEMBER_ACCESS_PATTERN = new RegExp(`${BEFORE}[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*){2,}(?:\\([^()\\s]{0,40}\\))?|${BEFORE}[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\([^()\\s]{0,40}\\)`, 'gu');
const SNAKE_CASE_PATTERN = new RegExp(`${BEFORE}[A-Za-z]+(?:_[A-Za-z\\d]+)+${AFTER}`, 'gu');
const CLI_FLAG_PATTERN = new RegExp(`(?<![${LATIN_WORD_CHARACTER}-])--?[A-Za-z][\\w-]*`, 'gu');
const PLACEHOLDER_PATTERN = /\{\{?\s*[\w.$-]+\s*\}?\}|\$\{[^}\s]{1,40}\}|<\/?[A-Za-z][\w-]*(?:\s[^<>]{0,80})?>/gu;
const ALPHANUMERIC_PATTERN = new RegExp(`${BEFORE}[A-Za-z\\d]+(?:[-_.][A-Za-z\\d]+)*${AFTER}`, 'gu');
const UPPERCASE_PHRASE_PATTERN = new RegExp(`${BEFORE}[A-Z]{2,}(?:[ \\t]+[A-Z]{2,}){2,}${AFTER}`, 'gu');

const MAX_VERSIONED_NAME_LENGTH = 48;
// 名称主体：缩写/内部大写（GPT、OpenAI、iOS）或首字母大写单词（Claude、Qwen）。
// 沿用名称总长上限限制每段扫描；否则无版本的超长大写词会在重叠字母组间反复回溯。
const NAME_HEAD = `(?:[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}|[a-z]{1,${MAX_VERSIONED_NAME_LENGTH}}[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}|[A-Z][a-z]{1,15})`;
// 名称前可有一个缩写或内部大写的厂商名（OpenAI GPT-6），普通首字母大写词不作前缀，避免吞掉句首正文。
const NAME_PREFIX = `(?:(?:[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}|[a-z]{1,${MAX_VERSIONED_NAME_LENGTH}}[A-Z][A-Za-z]{0,${MAX_VERSIONED_NAME_LENGTH}}) )?`;
const VERSIONED_NAME_PATTERN = new RegExp(`${BEFORE}${NAME_PREFIX}${NAME_HEAD}(?:[-_ ]?v?\\d+(?:\\.\\d+)*[a-z]?)${AFTER}`, 'gu');
const VARIANT_WORDS = new Set([
    'mini', 'nano', 'micro', 'pro', 'max', 'plus', 'ultra', 'turbo', 'lite', 'flash', 'instruct', 'chat',
    'preview', 'base', 'large', 'small', 'medium', 'xl', 'xxl', 'air', 'ti', 'se', 'beta', 'alpha', 'rc', 'lts',
]);

/** 产品/模型名称中的通用变体词，仅由名称语境调用；单独的 Plus/Chat 仍可属于外语正文。 */
export function isNameVariantWord(word: string): boolean {
    return VARIANT_WORDS.has(word.toLowerCase());
}

const FORMAT_WORDS = new Set([
    'pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'html', 'htm', 'txt', 'markdown', 'md', 'srt',
    'vtt', 'ass', 'ssa', 'lrc', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'rtf', 'odt', 'mobi', 'azw3', 'png',
    'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'mp4', 'wav', 'zip',
]);
// 小写技术词在中日韩及其他非 Latin 正文中通常作为术语保留；只收录通用缩写，不收录产品或样例名称。
const TECHNICAL_WORDS = new Set([
    'ai', 'api', 'app', 'bug', 'cpu', 'css', 'dns', 'dom', 'git', 'gpu', 'http', 'https', 'id', 'ip', 'js', 'llm',
    'npm', 'ok', 'os', 'pc', 'pnpm', 'sdk', 'sql', 'ssh', 'ts', 'ui', 'url', 'usb', 'ux', 'vpn', 'wifi', 'yarn',
]);
const MAX_ACRONYM_LENGTH = 10;
const MAX_MIXED_CASE_NAME_LENGTH = 24;
// 常用 DOM 标签在行内代码中是标准标识符；不能把所有裸词都当代码遮蔽。
const INLINE_DOM_IDENTIFIERS = new Set(['code', 'pre', 'span', 'div', 'body', 'head', 'style', 'script', 'html']);

/** 已有通用技术缩写词集的证据，不按大写字形猜测任意缩写，也不维护品牌名单。 */
export function isTechnicalAbbreviation(word: string): boolean {
    return TECHNICAL_WORDS.has(word.toLowerCase());
}

/** 反引号不能证明代码：只接纳完整标识符、声明/赋值、字面量、调用、运算表达式和带参数的技术命令。 */
function isStructuredInlineCode(token: string): boolean {
    const content = token.slice(1, -1).trim();
    if (!/\p{L}/u.test(content)) return true;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(content)
        || /^[A-Za-z]+(?:_[A-Za-z\d]+)+$/u.test(content)
        || isMixedCaseName(content) || isTechnicalAbbreviation(content) || INLINE_DOM_IDENTIFIERS.has(content)) return true;
    if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*[:=])/u.test(content)
        || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:[+*/%-]?=)(?!=)/u.test(content)) return true;
    if (/^(?:\{[^]*\}|\[[^]*\]|<\/?[A-Za-z][^<>]*>)$/u.test(content)) return true;
    if (/^(?:(?:await|return|yield|new)\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^]*\);?$/u.test(content)) return true;
    if (/^[\w$.]+(?:\s*[<>+*/%&|!=-]{1,3}\s*[\w$.]+)+;?$/u.test(content)) return true;
    const firstWord = /^[A-Za-z]+/u.exec(content)?.[0];
    return firstWord !== undefined && isTechnicalAbbreviation(firstWord) && /(?:^|\s)--?[A-Za-z]/u.test(content);
}

/** 同一最大合法前缀内，后续起点的必要后缀相同；只在候选起点匹配，失败后跳过整段而不重复回溯。 */
function maskCandidateTokens(text: string, candidates: RegExp, pattern: RegExp, accept: (token: string) => boolean, nestedCandidate?: RegExp): {text: string; count: number} {
    let output = '';
    let lastIndex = 0;
    let count = 0;
    candidates.lastIndex = 0;
    let candidate: RegExpExecArray | null;
    while ((candidate = candidates.exec(text)) !== null) {
        pattern.lastIndex = candidate.index;
        let match = pattern.exec(text);
        if (!match && nestedCandidate) {
            const nested = nestedCandidate.exec(candidate[0]);
            if (nested) {
                pattern.lastIndex = candidate.index + nested.index;
                match = pattern.exec(text);
            }
        }
        if (!match) continue;
        // 接纳回调拒绝时仍消费匹配范围，与原 replace 回调保留 token 后的全局扫描行为相同。
        candidates.lastIndex = match.index + match[0].length;
        if (!accept(match[0])) continue;
        output += `${text.slice(lastIndex, match.index)} `;
        lastIndex = match.index + match[0].length;
        // 域名可继续消费路径；也可能只匹配链中的一个后缀，余下部分仍沿用原有全局匹配顺序。
        candidates.lastIndex = lastIndex;
        count += 1;
    }
    return {text: output + text.slice(lastIndex), count};
}

/** 有界名称正则不能漏掉原本会被整体拒绝的超长厂商前缀，避免把内层名称改计为一个名称。 */
function hasOversizedNamePrefix(text: string, start: number, length: number): boolean {
    if (text[start - 1] !== ' ') return false;
    const end = start - 1;
    let cursor = end;
    while (cursor > 0 && /[A-Za-z]/u.test(text[cursor - 1]!)) cursor -= 1;
    if (end - cursor + 1 + length <= MAX_VERSIONED_NAME_LENGTH) return false;
    if (cursor > 0 && LATIN_WORD_CHARACTER_PATTERN.test(text[cursor - 1]!)) return false;
    // 原前缀语法是 ASCII 字母组成且首字母之后至少一次大写；普通首字母大写词不算前缀。
    return /[A-Z]/u.test(text.slice(cursor + 1, end));
}

/** 在带版本名称之后吸收规模（70B）、通用变体词（mini/Pro）和至多一个首字母大写后缀（Sol、Sonnet）。 */
function extendVersionedName(text: string, start: number, end: number): number {
    let cursor = end;
    let capitalizedSuffixes = 0;
    for (let taken = 0; taken < 3; taken += 1) {
        const match = /^[-_ ](\d+(?:\.\d+)?[A-Za-z]?|[A-Za-z]+)/u.exec(text.slice(cursor));
        if (!match) break;
        const token = match[1]!;
        const next = text[cursor + match[0].length];
        if (next !== undefined && LATIN_WORD_CHARACTER_PATTERN.test(next)) break;
        const isSize = /^\d+(?:\.\d+)?[BKMTbkmt]$/u.test(token);
        const isVariant = isNameVariantWord(token);
        const isCapitalized = /^[A-Z][a-z]{1,15}$/u.test(token);
        if (!isSize && !isVariant && !(isCapitalized && capitalizedSuffixes === 0)) break;
        if (isCapitalized && !isVariant) capitalizedSuffixes += 1;
        if (cursor + match[0].length - start > MAX_VERSIONED_NAME_LENGTH) break;
        cursor += match[0].length;
    }
    return cursor;
}

function maskVersionedNames(text: string): {text: string; count: number} {
    let count = 0;
    let output = '';
    let lastIndex = 0;
    for (const match of text.matchAll(VERSIONED_NAME_PATTERN)) {
        const start = match.index;
        if (start < lastIndex) continue;
        if (hasOversizedNamePrefix(text, start, match[0].length)) continue;
        const end = extendVersionedName(text, start, start + match[0].length);
        if (end - start > MAX_VERSIONED_NAME_LENGTH) continue;
        output += `${text.slice(lastIndex, start)} `;
        lastIndex = end;
        count += 1;
    }
    return {text: output + text.slice(lastIndex), count};
}

/**
 * 生成识别副本。顺序从结构最强到最弱：先吃掉 URL/路径，再处理名称与编号，防止 URL 中的
 * 版本片段或路径中的文件名被拆成零散字母。副本只用于统计与字符集判断。
 */
export function createLanguageDetectionCopy(value: string): LanguageDetectionCopy {
    let identifiers = 0;
    const mask = (text: string, pattern: RegExp, accept: (token: string) => boolean = () => true, candidates?: RegExp, nestedCandidate?: RegExp): string => {
        if (candidates) {
            const masked = maskCandidateTokens(text, candidates, pattern, accept, nestedCandidate);
            identifiers += masked.count;
            return masked.text;
        }
        return text.replace(pattern, (token) => {
            if (!accept(token)) return token;
            identifiers += 1;
            return ' ';
        });
    };

    let text = value.normalize('NFC');
    // 避免在长普通词/点号串上从每个位置尝试带可变长前缀的正则；先检查必需的结构。
    if (text.includes('://') || /www\./iu.test(text)) text = mask(text, URL_PATTERN, undefined, URL_CANDIDATE_PATTERN, URL_NESTED_CANDIDATE_PATTERN);
    if (EMAIL_DOMAIN_PATTERN.test(text)) text = mask(text, EMAIL_PATTERN, undefined, EMAIL_CANDIDATE_PATTERN);
    if (DOMAIN_SUFFIX_PATTERN.test(text)) text = mask(text, DOMAIN_PATTERN, undefined, DOMAIN_CANDIDATE_PATTERN);
    if (text.includes('@')) text = mask(text, MENTION_PATTERN);
    // 反引号只是网页样式，不能证明其中不是自然语言。只有明确代码结构才遮蔽整段；
    // 英文操作提示等自然短句保留正文证据，由统一识别流程决定是否需要翻译。
    if (text.includes('`')) text = mask(text, INLINE_CODE_PATTERN, isStructuredInlineCode);
    if (/[{<]/u.test(text)) text = mask(text, PLACEHOLDER_PATTERN);
    if (text.includes('#')) text = mask(text, REPOSITORY_REFERENCE_PATTERN, undefined, REPOSITORY_CANDIDATE_PATTERN);
    if (text.includes('=')) text = mask(text, PARAMETER_ASSIGNMENT_PATTERN, undefined, ASSIGNMENT_CANDIDATE_PATTERN);
    if (/\d/u.test(text)) text = mask(text, MEASUREMENT_PATTERN);
    // 单个分隔符的 ASS/SSA、and/or 仍按词处理；至少两级、以根/相对路径开头或末段带扩展名才是路径。
    if (/[\\/][\w.@+-]/u.test(text)) text = mask(text, PATH_PATTERN, (token) => /[\\/].*[\\/]/u.test(token)
        || /^(?:[A-Za-z]:|~|\.{1,2})?[\\/]/u.test(token)
        || /\d/u.test(token)
        || FILE_EXTENSION_SUFFIX_PATTERN.test(token), PATH_CANDIDATE_PATTERN);
    if (FILE_SUFFIX_PATTERN.test(text)) text = mask(text, FILE_NAME_PATTERN, undefined, FILE_CANDIDATE_PATTERN);
    if (text.includes('-')) text = mask(text, UUID_PATTERN);
    if (/\d/u.test(text)) text = mask(text, HASH_PATTERN);
    // 带版本名称必须先于裸版本号处理，否则 Claude 3.5 Sonnet 会被拆成孤立的名称和后缀。
    const versioned = /\d/u.test(text) ? maskVersionedNames(text) : {text, count: 0};
    text = versioned.text;
    if (/\d/u.test(text)) text = mask(text, VERSION_PATTERN);
    if (/[.(]/u.test(text)) text = mask(text, MEMBER_ACCESS_PATTERN);
    if (text.includes('_')) text = mask(text, SNAKE_CASE_PATTERN);
    if (text.includes('-')) text = mask(text, CLI_FLAG_PATTERN);
    if (/\d/u.test(text)) text = mask(text, ALPHANUMERIC_PATTERN, (token) => /\d/u.test(token) && /[A-Za-z]/u.test(token));
    // 三个及以上连续全大写词是被大写的句子（ERROR PLEASE RETRY），不能逐个当缩写保留。
    text = text.replace(UPPERCASE_PHRASE_PATTERN, (phrase) => phrase.toLowerCase());
    return {text, identifiers, versionedNames: versioned.count};
}

export function isAcronymWord(word: string): boolean {
    return word.length <= MAX_ACRONYM_LENGTH + 1 && /^[A-Z]{2,}s?$/u.test(word)
        && word.replace(/s$/u, '').length <= MAX_ACRONYM_LENGTH;
}

export function isMixedCaseName(word: string): boolean {
    return word.length <= MAX_MIXED_CASE_NAME_LENGTH
        && /^(?:[A-Z][a-z]*[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*)$/u.test(word)
        && !/^[A-Z]+s?$/u.test(word);
}

/**
 * 非 Latin 正文中的 Latin 词角色。名称按一个词计权，格式名不计权，单字母（A 股、Plan B 中的 B）计 1；
 * 普通小写词、首字母大写的普通词及超长缩写都视为正文，使夹带的外语句子保留翻译机会。
 */
export function classifyEmbeddedLatinWord(word: string): {role: EmbeddedLatinWordRole; weight: number} {
    const lower = word.toLowerCase();
    if (FORMAT_WORDS.has(lower)) return {role: 'format', weight: 0};
    if (/^[A-Za-z]$/u.test(word)) return {role: 'letter', weight: 1};
    if (isAcronymWord(word) || isMixedCaseName(word)) return {role: 'name', weight: 2};
    if (word === lower && TECHNICAL_WORDS.has(lower)) return {role: 'name', weight: 2};
    return {role: 'prose', weight: 0};
}
