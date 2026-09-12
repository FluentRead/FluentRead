/**
 * @file src/core/config/pageTranslation.ts
 *
 * 文件职责：定义网页翻译进阶设置的取值范围与归一化规则，让最少字符数、预翻译字符预算等数值配置在读取、导入和界面绑定时得到一致约束。
 * 主要内容：给出翻译段落最少字符数与免滚动预翻译字符数的默认值、上下限和步进，并提供把任意存储值收敛回合法范围的纯函数，供配置模型、设置界面和内容脚本共享同一份阈值语义。 可核对的公开符号包括 DEFAULT_MIN_TRANSLATION_TEXT_LENGTH、MIN_TRANSLATION_TEXT_LENGTH_MIN、MIN_TRANSLATION_TEXT_LENGTH_MAX、DEFAULT_EAGER_TRANSLATION_CHARACTERS、EAGER_TRANSLATION_CHARACTERS_MIN、EAGER_TRANSLATION_CHARACTERS_MAX、normalizeMinTranslationTextLength、normalizeEagerTranslationCharacters。
 * 模块边界：本文件属于 core 配置领域层，只做取值约束的纯计算；不读写浏览器存储、不访问 DOM、不调用翻译服务，持久化与界面呈现分别由 services 与 features 负责。
 */

/** 段落需要达到的最少字符数；1 表示不过滤，默认过滤掉单字符碎片。 */
export const DEFAULT_MIN_TRANSLATION_TEXT_LENGTH = 2;
export const MIN_TRANSLATION_TEXT_LENGTH_MIN = 1;
export const MIN_TRANSLATION_TEXT_LENGTH_MAX = 100;

/** 进入网页后不等待滚动即可直接翻译的字符预算；0 表示完全按视口触发。 */
export const DEFAULT_EAGER_TRANSLATION_CHARACTERS = 4999;
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
