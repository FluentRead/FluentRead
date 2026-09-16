/**
 * @file src/services/translation-stats/measure.ts
 * 文件职责：计算一次翻译请求的规模数值，为统计事件提供段落数、字符数与字节数。
 * 主要内容：单次遍历按 Unicode 码点统计字符并按 UTF-8 规则累加字节，兼容单条与批量原文；按 base64 长度推算图片输入的解码字节数。
 * 模块边界：本文件只返回数字，不保存、截取或转换文本，也不依赖浏览器 API、配置或存储。
 */

export interface TranslationTextSize {
    segmentCount: number;
    chars: number;
    bytes: number;
}

function measureSegment(text: string, size: TranslationTextSize): void {
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        size.chars += 1;
        if (code < 0x80) {
            size.bytes += 1;
        } else if (code < 0x800) {
            size.bytes += 2;
        } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                // 代理对是一个码点，UTF-8 编码为 4 字节。
                size.bytes += 4;
                index += 1;
            } else {
                size.bytes += 3;
            }
        } else {
            // 其余 BMP 字符与孤立代理项（编码为替换字符）均为 3 字节。
            size.bytes += 3;
        }
    }
}

/** 统计单条或批量原文；非字符串槽位按空文本计数，保持段落数与请求一致。 */
export function measureTranslationText(value: string | readonly unknown[]): TranslationTextSize {
    const size: TranslationTextSize = {segmentCount: 0, chars: 0, bytes: 0};
    const segments = typeof value === 'string' ? [value] : value;
    for (const segment of segments) {
        size.segmentCount += 1;
        if (typeof segment === 'string') measureSegment(segment, size);
    }
    return size;
}

/** 由已校验的 data URL 推算图片解码字节数，避免为统计再次解码图片。 */
export function measureImageDataUrlBytes(dataUrl: string | undefined): number {
    if (!dataUrl) return 0;
    const commaIndex = dataUrl.indexOf(',');
    const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}
