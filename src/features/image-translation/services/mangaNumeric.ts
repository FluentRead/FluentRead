/**
 * @file src/features/image-translation/services/mangaNumeric.ts
 * 文件职责：判定识别文本是否具有完整的数字信息形态。
 * 主要内容：识别多位数字、有效日期时间和金额，只为分类进行 NFKC，不改原文。
 * 模块边界：纯文本判定，不提供 OCR 置信判断、绘制或网络调用。
 */
/** 数字不属于某种源语言；只保留完整信息形态，孤立数字与空格分开的艺术碎片仍过滤。 */
export function numericInformation(text: string): boolean {
    // NFKC 可折叠全角数字与分隔符，但不能把圈号、上标等装饰符号变成新数字。
    if (!/^[\p{Nd}\p{Sc}\s:：.,，．/／\-－]+$/u.test(text)) return false;
    const normalized=text.normalize('NFKC');
    if (/^\d{2,}$/u.test(normalized)
        || /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(normalized)
        || /^-?(?:\p{Sc}\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*\p{Sc})$/u.test(normalized)) return true;
    const date=normalized.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/u);
    if (!date) return false;
    const year=Number(date[1]),month=Number(date[3]),day=Number(date[4]);
    return year>0&&month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate();
}

