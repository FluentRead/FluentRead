/**
 * @file src/core/config/pageTranslation.ts
 *
 * 文件职责：定义网页翻译排除语言、排除标签/选择器和进阶设置的归一化规则，让语言多选、不翻译标签、最少字符数和预翻译预算在读取、导入和界面绑定时得到一致约束。
 * 主要内容：清洗排除语言列表与不翻译的 HTML 标签/CSS 选择器列表（拒绝整页根表面与控制字符、规范纯标签名大小写、去重并限制容量，提供按非嵌套分隔符拆分和选择器语法校验）；给出翻译段落最少字符数与免滚动预翻译字符数的默认值、上下限和步进，并提供把任意存储值收敛回合法范围的纯函数，供配置模型、设置界面和内容脚本共享同一份阈值语义。 可核对的公开符号包括 COMMON_EXCLUDED_TAG_OPTIONS、EXCLUDED_TAGS_MAX、EXCLUDED_TAG_MAX_LENGTH、normalizeExcludedTags、splitExcludedTagInput、validateExcludedTagSelector、DEFAULT_MIN_TRANSLATION_TEXT_LENGTH、MIN_TRANSLATION_TEXT_LENGTH_MIN、MIN_TRANSLATION_TEXT_LENGTH_MAX、DEFAULT_EAGER_TRANSLATION_CHARACTERS、EAGER_TRANSLATION_CHARACTERS_MIN、EAGER_TRANSLATION_CHARACTERS_MAX、normalizeMinTranslationTextLength、normalizeEagerTranslationCharacters。
 * 模块边界：本文件属于 core 配置领域层，只做取值约束的纯计算；不读写浏览器存储、不修改页面 DOM、不调用翻译服务，持久化与界面呈现分别由 services 与 features 负责。
 */

import {translationLanguageOptions} from '@/src/core/language/catalog';
import {normalizeLanguageCode} from '@/src/core/language/codes';

/** 排除列表只接受已有语言目录，与目标语言共用标签规范化（中文地区、旧别名、三字母代码），去重并按目录排序。 */
export function normalizeExcludedLanguages(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const selected = new Set(value.map(item => normalizeLanguageCode(item)));
    return translationLanguageOptions.filter(item => selected.has(item.value)).map(item => item.value);
}

/** 常见可按需排除的 HTML 标签；code、pre、kbd、svg、math 等代码与脚本标签默认已由核心守卫跳过。 */
export const COMMON_EXCLUDED_TAG_OPTIONS = [
    'blockquote', 'a', 'button', 'mark', 'cite', 'figcaption',
    'table', 'header', 'footer', 'nav', 'aside',
    'h1', 'h2', 'h3', 'strong', 'em',
] as const;

export const EXCLUDED_TAGS_MAX = 128;
export const EXCLUDED_TAG_MAX_LENGTH = 256;

const plainHtmlTagPattern = /^[a-zA-Z][a-zA-Z0-9-]*$/u;
const disallowedExcludedSelectors = new Set(['*', 'html', 'body', ':root']);
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;

/** 清洗单条不翻译标签或 CSS 选择器；拒绝空白、控制字符、过长内容以及会屏蔽整页的根选择器。 */
export function normalizeExcludedTagEntry(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > EXCLUDED_TAG_MAX_LENGTH || controlCharacterPattern.test(trimmed)) return null;
    const normalized = plainHtmlTagPattern.test(trimmed) ? trimmed.toLowerCase() : trimmed;
    if (disallowedExcludedSelectors.has(normalized.toLowerCase())) return null;
    return normalized;
}

/** 清洗不翻译标签/选择器列表，去重并保留顺序。 */
export function normalizeExcludedTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        const normalized = normalizeExcludedTagEntry(item);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
        if (result.length >= EXCLUDED_TAGS_MAX) break;
    }
    return result;
}

/** 按逗号、分号或换行拆分用户输入，保留圆括号、方括号与引号内的分隔符（如 :is(h1, h2)）。 */
export function splitExcludedTagInput(raw: string): string[] {
    const entries: string[] = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    const flush = (): void => {
        const trimmed = current.trim();
        if (trimmed) entries.push(trimmed);
        current = '';
    };

    for (const char of raw) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\' && quote !== null) {
            current += char;
            escaped = true;
            continue;
        }
        if (quote !== null) {
            current += char;
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === '(') {
            parenDepth += 1;
            current += char;
            continue;
        }
        if (char === ')') {
            if (parenDepth > 0) parenDepth -= 1;
            current += char;
            continue;
        }
        if (char === '[') {
            bracketDepth += 1;
            current += char;
            continue;
        }
        if (char === ']') {
            if (bracketDepth > 0) bracketDepth -= 1;
            current += char;
            continue;
        }
        if (parenDepth === 0 && bracketDepth === 0 && (char === ',' || char === '，' || char === ';' || char === '；' || char === '\n' || char === '\r')) {
            flush();
            continue;
        }
        current += char;
    }
    flush();
    return entries;
}

/** 校验单条标签或 CSS 选择器；传入 document 时同步验证浏览器 CSS 选择器语法。 */
export function validateExcludedTagSelector(value: string, doc?: Document): {ok: true; selector: string} | {ok: false; reason: 'disallowed' | 'invalid'} {
    const trimmed = value.trim();
    if (trimmed && disallowedExcludedSelectors.has(trimmed.toLowerCase())) {
        return {ok: false, reason: 'disallowed'};
    }
    const normalized = normalizeExcludedTagEntry(value);
    if (!normalized) return {ok: false, reason: 'invalid'};
    const probeDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
    if (probeDoc) {
        try {
            probeDoc.createElement('div').matches(normalized);
        } catch {
            return {ok: false, reason: 'invalid'};
        }
    }
    return {ok: true, selector: normalized};
}

/** 段落需要达到的最少字符数；1 表示不过滤，默认过滤掉单字符碎片。 */
export const DEFAULT_MIN_TRANSLATION_TEXT_LENGTH = 2;
export const MIN_TRANSLATION_TEXT_LENGTH_MIN = 1;
export const MIN_TRANSLATION_TEXT_LENGTH_MAX = 100;

/** 进入网页后不等待滚动即可直接翻译的字符预算；0 表示完全按视口触发。 */
export const DEFAULT_EAGER_TRANSLATION_CHARACTERS = 0;
export const EAGER_TRANSLATION_CHARACTERS_MIN = 0;
export const EAGER_TRANSLATION_CHARACTERS_MAX = 100_000;

function toInteger(value: unknown): number | null {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(number) ? Math.round(number) : null;
}

export function normalizeMinTranslationTextLength(value: unknown): number {
    const integer = toInteger(value);
    if (integer === null) return DEFAULT_MIN_TRANSLATION_TEXT_LENGTH;
    return Math.min(
        MIN_TRANSLATION_TEXT_LENGTH_MAX,
        Math.max(MIN_TRANSLATION_TEXT_LENGTH_MIN, integer),
    );
}

export function normalizeEagerTranslationCharacters(value: unknown): number {
    const integer = toInteger(value);
    if (integer === null) return DEFAULT_EAGER_TRANSLATION_CHARACTERS;
    return Math.min(
        EAGER_TRANSLATION_CHARACTERS_MAX,
        Math.max(EAGER_TRANSLATION_CHARACTERS_MIN, integer),
    );
}
