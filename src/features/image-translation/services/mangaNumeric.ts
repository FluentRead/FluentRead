/**
 * @file src/features/image-translation/services/mangaNumeric.ts
 * 文件职责：判定识别文本是否具有完整的数字信息形态。
 * 主要内容：识别多位数字、有效日期时间、常见币种金额、百分数、小数、千位分隔、分数、温度以及带精确 SI/物理/计算计量单位的数值与复合时长；分类时折叠全角及阿拉伯/波斯数字，保留上标平方立方不转为普通数字，不改原文或判断地域数值。
 * 模块边界：纯文本判定，不提供 OCR 置信判断、绘制或网络调用。
 */
function validNumericDate(year:number,month:number,day:number):boolean {
    if (year<=0 || month<1 || month>12 || day<1) return false;
    const leap=year%4===0&&(year%100!==0||year%400===0);
    return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}

const MULTI_CHAR_UNIT_NUMERIC = /^[+-]?\d+(?:[.,]\d+)? ?(?:mm\/s|m\/s|km\/h|g\/cm³|mm[²³]|cm[²³]|mm|cm|km|[uμ]m|nm|mg|kg|m[lL]|[mnuμ]s|min|hrs?|sec|[kMG]?Hz|[mkM]W|[mk]V|mA|px|pt|[dp]pi|fps|rpm|dB|[kKMGT]B|[KMG]iB|mph)$/u;
const SINGLE_LETTER_SI_NUMERIC = /^[+-]?(?:\d+[.,]\d+ ?[mgshLWVAKNJΩ]|\d+[mgshLWVAKNJΩ]|\d+ [VWΩ])$/u;
const COMPOUND_DURATION_NUMERIC = /^(?:\d+h ?[0-5]?\dm(?: ?[0-5]?\ds)?|\d+m ?[0-5]?\ds)$/u;

/** 数字不属于某种源语言；只保留完整信息形态，孤立数字与空格分开的艺术碎片仍过滤。 */
export function numericInformation(text: string): boolean {
    // NFKC 可折叠全角数字与分隔符，但不能把圈号、上标等装饰符号变成新数字。
    if (!/\p{Nd}/u.test(text)) return false;
    if (!/^[\p{Nd}\p{Sc}\s:：.,，．/／\-－−+＋%％°℃℉²³µμΩΩA-Za-z年月日]+$/u.test(text)) return false;
    // 仅用于判断，保留实际 OCR 字符；保护 ²/³ 不被 NFKC 折叠为普通数字 2/3，并折叠阿拉伯-印度及波斯十进制数字。
    const normalized=text.replace(/²/gu, '\u0002').replace(/³/gu, '\u0003').normalize('NFKC')
        .replace(/\u0002/gu, '²').replace(/\u0003/gu, '³').replace(/\s+/gu, ' ').replace(/−/gu, '-')
        .replace(/[٠-٩۰-۹]/gu, digit => {
            const code=digit.charCodeAt(0);return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
        });
    const codeAmount=normalized.match(/^([+-]?)(USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF|HKD|KRW|INR|AED|SAR)\s+([\d., ]+)$/iu);
    if (codeAmount) return numericInformation(`${codeAmount[1]}$${codeAmount[3]}`);
    if (/^(?:0?[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d)?\s*(?:AM|PM)$/iu.test(normalized)) return true;
    const cjkDate=normalized.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/u);
    if (cjkDate) return validNumericDate(Number(cjkDate[1]),Number(cjkDate[2]),Number(cjkDate[3]));
    const lastYear=normalized.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/u);
    if (lastYear) {
        const first=Number(lastYear[1]),second=Number(lastYear[3]),year=Number(lastYear[4]);
        return validNumericDate(year,first,second)||validNumericDate(year,second,first);
    }
    if (/^\d{2,}$/u.test(normalized)
        || /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(normalized)
        || /^[+-]?(?:\p{Sc}\s*(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?)|(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?)\s*\p{Sc})$/u.test(normalized)
        || /^[+-]?\d+(?:[.,]\d+)? ?%$/u.test(normalized)
        || /^[+-]?\d+\.\d+$/u.test(normalized)
        || /^[+-]?\d+,\d+$/u.test(normalized)
        || /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/u.test(normalized)
        || /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(normalized)
        || /^[+-]?\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/u.test(normalized)
        || /^[+-]\d+$/u.test(normalized)
        || /^[+-]?\d+(?:[.,]\d+)?°[CF]$/iu.test(normalized)
        || MULTI_CHAR_UNIT_NUMERIC.test(normalized)
        || SINGLE_LETTER_SI_NUMERIC.test(normalized)
        || COMPOUND_DURATION_NUMERIC.test(normalized)) return true;
    const fraction=normalized.match(/^[+-]?\d+\/(\d+)$/u);
    if (fraction) return /[1-9]/u.test(fraction[1]);
    const date=normalized.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/u);
    if (!date) return false;
    const year=Number(date[1]),month=Number(date[3]),day=Number(date[4]);
    return year>0&&month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate();
}

/** 已进入普通图片结果的单个数字也保留原图；这不扩大漫画识别的单字准入。 */
export function numericProtection(text:string):boolean {
    return /^[0-9０-９٠-٩۰-۹]$/u.test(text)||numericInformation(text);
}

/** 数值证据比较只消除百分号前空白；数字间空格可能是数值组成部分。 */
export function numericEvidenceKey(text:string):string {
    return text.replace(/\s+/gu,' ').trim().replace(/ +(?=[%％])/gu,'');
}
