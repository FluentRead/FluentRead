/**
 * @file src/features/image-translation/textBoundary.ts
 * 文件职责：判断图片 OCR 跨行衔接处是否为东亚书写边界。
 * 主要内容：按 Unicode 码点从行末逆向读取变体选择符与半角浊音，仅在确有东亚文字时连写。
 * 模块边界：只读取文本，不规范化原文、不推断语言、不操作图像或翻译服务。
 */
const EAST_ASIAN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\uac00-\ud7af]$/u;
const EAST_ASIAN_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const HALF_WIDTH_KANA = /^[\uFF66-\uFF9D]$/u;

/** 用 UTF-16 偏移逆向读取单个码点，不复制此前整段文本。 */
function previousCodePoint(text: string, end: number): {start: number; value: number} {
    const last = text.charCodeAt(end - 1), before = text.charCodeAt(end - 2);
    const paired = last >= 0xDC00 && last <= 0xDFFF && before >= 0xD800 && before <= 0xDBFF;
    const start = end - (paired ? 2 : 1);
    return {start, value: text.codePointAt(start)!};
}

function isVariationSelector(value: number): boolean {
    return (value >= 0xFE00 && value <= 0xFE0F) || (value >= 0xE0100 && value <= 0xE01EF);
}

/** 有界扫描末尾选择符，不把表情或异常标记当作东亚文字。 */
export function endsEastAsianText(text: string): boolean {
    let end = text.length, variations = 0;
    while (end > 0) {
        const point = previousCodePoint(text, end);
        if (!isVariationSelector(point.value)) break;
        // 标准变体序列只需一个选择符；异常长序列保守分隔，避免重复处理不可信正文。
        if (++variations > 32) return false;
        end = point.start;
    }
    if (!end) return false;
    const point = previousCodePoint(text, end), character = text.slice(point.start, end);
    const hasVariation = end !== text.length;
    if (hasVariation && PICTOGRAPHIC.test(character)) return false;
    // Unicode 定义的日文逗号/句号标准变体：FE00 为靠角形，FE01 为居中形。
    if (hasVariation && variations === 1 && (point.value === 0x3001 || point.value === 0x3002)
        && (text.charCodeAt(end) === 0xFE00 || text.charCodeAt(end) === 0xFE01)) return true;
    if ((hasVariation ? EAST_ASIAN_SCRIPT : EAST_ASIAN).test(character)) return true;
    if ((point.value === 0xFF9E || point.value === 0xFF9F) && point.start > 0) {
        const previous = previousCodePoint(text, point.start);
        return HALF_WIDTH_KANA.test(text.slice(previous.start, point.start));
    }
    return false;
}

export function startsEastAsianText(text: string): boolean {
    if (!text) return false;
    return EAST_ASIAN.test(String.fromCodePoint(text.codePointAt(0)!));
}
