/**
 * @file src/features/image-translation/services/rendering.ts
 * 文件职责：采样 OCR 框周边背景并在有限图片区域中排版、绘制完整译文，避免混合语言空格损坏、强制横向压缩和行数截断。
 * 主要内容：按周长用量化色阶聚类主色，但返回桶内真实颜色均值，避免纯色修补的固定色差；依据亮度选择文字颜色、按单词与真实字素边界换行，无字素分割器时仅在已知安全的空格边界分开复杂词组；每次排版有界复用同字号测宽和字素分割，单个源行按参考字体的宽度与墨迹高度一致性估计尺度，估计不可靠时沿用原上限；按实际回退字体的墨迹、描边和基线适配上下边界，单行不重复扣除完整行高，保留正文对齐及字号上限并隔离 Canvas 状态。
 * 模块边界：颜色和排版算法无浏览器副作用；绘制函数仅操作调用方传入的 Canvas context，不读取配置、不请求翻译、不修补背景或修改宿主图片元素。
 * 原色与余量：接收调用方已验证的前景色，并提供局部RGB对比度与单行实际高度度量；这些度量本身不授予新增像素或清字权限。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {ImageTextRegion} from '../paragraphs';
import {isSpaceGraphemeExtension, isSpaceGraphemePrepend} from '../graphemeSpaceData';

/** 从 OCR 框外围采样主色，忽略透明像素且不遍历框内面积。 */
export function getImageTextBackgroundColor(
    pixels: Uint8ClampedArray,
    imageWidth: number,
    imageHeight: number,
    bbox: OcrLine['bbox'],
): string {
    if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight)
        || ![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
        || imageWidth <= 0 || imageHeight <= 0 || pixels.length < imageWidth * imageHeight * 4) {
        return 'rgb(255,255,255)';
    }
    const x0 = Math.max(0, Math.min(imageWidth, Math.floor(bbox.x0)));
    const y0 = Math.max(0, Math.min(imageHeight, Math.floor(bbox.y0)));
    const x1 = Math.max(x0, Math.min(imageWidth, Math.ceil(bbox.x1)));
    const y1 = Math.max(y0, Math.min(imageHeight, Math.ceil(bbox.y1)));
    const colors = new Map<string, number[]>();
    const sample = (x: number, y: number) => {
        const offset = (y * imageWidth + x) * 4;
        if (pixels[offset + 3] < 128) return;
        const red = Math.min(255, Math.round(pixels[offset] / 16) * 16);
        const green = Math.min(255, Math.round(pixels[offset + 1] / 16) * 16);
        const blue = Math.min(255, Math.round(pixels[offset + 2] / 16) * 16);
        const key = `${red},${green},${blue}`;
        const group = colors.get(key) ?? [0,0,0,0];
        for (let channel = 0; channel < 3; channel++) group[channel] += pixels[offset + channel];
        group[3]++; colors.set(key, group);
    };
    const left = Math.max(0, x0 - 4);
    const right = Math.min(imageWidth, x1 + 4);
    const top = Math.max(0, y0 - 4);
    const bottom = Math.min(imageHeight, y1 + 4);
    for (let y = top; y < bottom; y += 1) {
        if (y < y0 || y >= y1) {
            for (let x = left; x < right; x += 1) sample(x, y);
        } else {
            for (let x = left; x < x0; x += 1) sample(x, y);
            for (let x = x1; x < right; x += 1) sample(x, y);
        }
    }
    let best = '255,255,255';
    let bestCount = 0;
    colors.forEach(group => {
        if (group[3] > bestCount) {
            // 色阶只负责聚类；用实际样本均值填色，纯色图片不能凭空出现 8 级色差。
            best = group.slice(0,3).map(value => Math.round(value / group[3])).join(',');
            bestCount = group[3];
        }
    });
    return `rgb(${best})`;
}

function relativeLuminance(channels: readonly number[]): number {
    const linear = channels.map(channel => {
        const value = Math.max(0, Math.min(255, channel)) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** 仅比较不透明 RGB 的相对亮度，不把这一个局部数值当作整页可访问性结论。 */
export function getImageRgbContrast(foreground:readonly number[],background:readonly number[]):number {
    const a=relativeLuminance(foreground),b=relativeLuminance(background);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

/** 选择与背景对比度较高的深色或白色，避免饱和色被简单灰度阈值误判。 */
export function getImageTextColor(backgroundColor: string): string {
    const channels = backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number);
    const luminance = relativeLuminance(channels && channels.length >= 3 ? channels.slice(0, 3) : [255, 255, 255]);
    const dark = relativeLuminance([17, 24, 39]);
    const darkContrast = (Math.max(luminance, dark) + 0.05) / (Math.min(luminance, dark) + 0.05);
    const lightContrast = 1.05 / (luminance + 0.05);
    return darkContrast >= lightContrast ? '#111827' : '#ffffff';
}

export interface ImageTranslationTextLayout {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    /** 字体回退后的实际墨迹高度与字母基线；旧度量端口缺少指标时仍使用行框。 */
    ink?: {height: number; baselines: number[]};
}

export const IMAGE_TEXT_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", sans-serif';

/** 单个横排物理行的字号上限：宽度与墨迹高度独立推算一致时，才采用参考字体的 em 估计。
 * OCR 框不是字体行框；含下伸笔画的行不能仅因框更高就变成大字。未知字体形状、合段和长文本保留旧上限。
 * 这里只估计尺度，不声称识别字体族；最终译文仍须用设备实际回退字体的完整墨迹适配。
 */
export function getImageSourceFontLimit(context:CanvasRenderingContext2D,line:ImageTextRegion):number {
    if(line.vertical)return Infinity;
    const b=line.bbox,height=b.y1-b.y0,width=b.x1-b.x0,fallback=(line.fontSize??height)*1.2;
    if(line.sourceBoxes&&line.sourceBoxes.length!==1||line.ruby?.length||line.text.length<3||line.text.length>256||/[\r\n]/u.test(line.text)
        ||![width,height].every(value=>Number.isFinite(value)&&value>0))return fallback;
    context.save();
    try{
        context.font='400 100px Arial, sans-serif';context.textAlign='left';context.textBaseline='alphabetic';context.direction=getImageTextDirection(line.text);
        const metrics=context.measureText(line.text),inkWidth=metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight,
            inkHeight=metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent;
        if(![inkWidth,inkHeight].every(value=>Number.isFinite(value)&&value>0))return fallback;
        const byWidth=width/inkWidth*100,byHeight=height/inkHeight*100,estimate=(byWidth+byHeight)/2;
        return Math.max(byWidth,byHeight)<=Math.min(byWidth,byHeight)*1.12&&estimate>=height*.8&&estimate<=height*2.5?estimate:fallback;
    }finally{context.restore();}
}

/** 只有整段可在当前宽度以源字号保持一行时，返回实际墨迹与描边所需的高度。 */
export function getImageSingleLineHeight(context:CanvasRenderingContext2D,text:string,width:number,fontSize:number):number|undefined {
    if(!text.trim()||text.length>256||/[\r\n]/u.test(text)||![width,fontSize].every(n=>Number.isFinite(n)&&n>0))return;
    context.save();
    try{
        context.font=`400 ${fontSize}px ${IMAGE_TEXT_FONT}`;context.textAlign='left';context.textBaseline='alphabetic';context.direction=getImageTextDirection(text);
        const m=context.measureText(text),inkWidth=m.actualBoundingBoxLeft+m.actualBoundingBoxRight,inkHeight=m.actualBoundingBoxAscent+m.actualBoundingBoxDescent;
        if(![m.width,inkWidth,inkHeight].every(Number.isFinite)||inkWidth<=0||inkHeight<=0)return;
        const stroke=Math.max(.35,fontSize*.06);
        if(Math.max(m.width,inkWidth)+stroke>width-Math.min(2,width*.03)*2)return;
        return Math.ceil(inkHeight+stroke+2);
    }finally{context.restore();}
}
/** 离屏文档的默认方向不能决定译文中的数字与标点；预检和绘制使用同一首强字符方向。 */
export function getImageTextDirection(text:string):CanvasDirection {
    const firstLetter=text.match(/\p{Letter}/u)?.[0]??'';
    return /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u.test(firstLetter)?'rtl':'ltr';
}
// 补充平面汉字、假名与韩文 Jamo 要与英文分词，附着的组合标记和连接符仍属于前一字素。
const CJK_TOKENS = /\s+|[\uFF66-\uFF9D][\uFF9E\uFF9F](?:\p{Mark}|[\u200c\u200d])*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff66-\uff9d\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af](?:\p{Mark}|[\u200c\u200d])*|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff66-\uff9d\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
// 这些字符各自是完整字素：不含组合标记、连接符、韩文 Jamo、表情修饰符或 Prepend。
const SIMPLE_IMAGE_TEXT = /^[\s\x20-\x7e\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\uac00-\ud7a3\uff01-\uff9d]*$/u;
const IMAGE_TEXT_EXTEND = /[\p{Mark}\p{Grapheme_Extend}]/u;
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function isSimpleImageText(text: string): boolean {
    return SIMPLE_IMAGE_TEXT.test(text) && !IMAGE_TEXT_EXTEND.test(text);
}

function graphemes(text: string): string[] {
    if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), part => part.segment);
    // 不模拟不完整的 UAX29：复杂词组保持整体，宁可缩小字号，也不拆开字素。
    return isSimpleImageText(text) ? Array.from(text) : [text];
}

/** 缺少 Segmenter 时按固定 Unicode 17 属性，只在 ASCII 空格的安全两侧分开词组。 */
function fallbackTokens(paragraph: string): Array<string | null> {
    const words = paragraph.replace(/\s+/gu, ' ').split(' ');
    const result: Array<string | null> = [];
    let pending = words[0];
    for (let index = 1; index < words.length; index += 1) {
        const next = words[index];
        if (!isSpaceGraphemeExtension(next.codePointAt(0)!)) {
            // 只读末尾两个 UTF-16 单元，避免为查询 Prepend 展开整个词组。
            const last = pending.charCodeAt(pending.length - 1), before = pending.charCodeAt(pending.length - 2);
            const paired = last >= 0xDC00 && last <= 0xDFFF && before >= 0xD800 && before <= 0xDBFF;
            const previous = pending.codePointAt(pending.length - (paired ? 2 : 1))!;
            if (!isSpaceGraphemePrepend(previous)) {
                if (isSimpleImageText(pending)) {
                    for (const token of pending.match(CJK_TOKENS)!) result.push(token);
                } else result.push(pending);
                result.push(null);
            } else {
                // Prepend 与空格同属字素，保留在左词组；空格之后的真实边界仍可换行。
                result.push(pending + ' ');
            }
            pending = next;
        } else {
            // 例如泰/老挝语 SpacingMark 不是 GC=Mark，不能用“非 Mark”推断空格后可断。
            pending += ' ' + next;
        }
    }
    if (isSimpleImageText(pending)) {
        for (const token of pending.match(CJK_TOKENS)!) result.push(token);
    } else {
        result.push(pending);
    }
    return result;
}

function tokenize(paragraph: string): Array<string | null> {
    if (!graphemeSegmenter && !isSimpleImageText(paragraph)) return fallbackTokens(paragraph);
    const tokens = paragraph.match(CJK_TOKENS) || [];
    // 正则词界（包括空白两侧）可能位于字素内，使用分割器的实际边界合并；空白仍按原规则归一化。
    const mayCrossBoundary = tokens.length > 1 && graphemeSegmenter
        && !isSimpleImageText(paragraph);
    if (mayCrossBoundary && graphemeSegmenter) {
        const iterator = graphemeSegmenter.segment(paragraph)[Symbol.iterator]();
        const merged: string[] = [];
        let offset = 0;
        let end = 0;
        let pending = '';
        for (const token of tokens) {
            offset += token.length;
            while (end < offset) end += iterator.next().value!.segment.length;
            pending += token;
            if (offset === end) {
                merged.push(pending);
                pending = '';
            }
        }
        return merged.map(token => /^\s+$/u.test(token) ? null : token);
    }
    return tokens.map(token => /^\s+$/u.test(token) ? null : token);
}

/** 保留单词、显式换行和混排空格；过长单词才按字素拆分，不截断译文。 */
export function layoutImageTranslationText(
    text: string,
    width: number,
    height: number,
    measure: (text: string, fontSize: number) => number,
    maxFontSize = Infinity,
    measureInk?: (text: string, fontSize: number) => {ascent: number; descent: number},
): ImageTranslationTextLayout {
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    if (!normalized || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { lines: [], fontSize: 0, lineHeight: 0 };
    }
    const paragraphs = normalized.split('\n').map(paragraph => paragraph.trim());
    const tokens = paragraphs.map(tokenize);
    const segments = new Map<string, string[]>();
    let measuredSize = 0;
    const widths = new Map<string, number>();
    const textWidth = (value: string, size: number) => {
        if (size !== measuredSize) {
            widths.clear();
            measuredSize = size;
        }
        const cached = widths.get(value);
        if (cached !== undefined) return cached;
        const result = measure(value, size);
        // 缓存只属于本段和当前字号，长段落也不累积无限多中间字符串。
        if (widths.size >= 512) widths.delete(widths.keys().next().value!);
        widths.set(value, result);
        return result;
    };
    const lineSpacing = 1.18;
    const wrap = (fontSize: number): ImageTranslationTextLayout => {
        const lines: string[] = [];
        for (const paragraph of tokens) {
            let current = '';
            let space = '';
            for (const token of paragraph) {
                if (token === null) {
                    space = ' ';
                    continue;
                }
                const candidate = current + space + token;
                space = '';
                if (textWidth(candidate, fontSize) <= width) {
                    current = candidate;
                    continue;
                }
                if (current) {
                    lines.push(current);
                    current = '';
                }
                if (textWidth(token, fontSize) <= width) {
                    current = token;
                    continue;
                }
                let parts = segments.get(token);
                if (!parts) {
                    parts = graphemes(token);
                    segments.set(token, parts);
                }
                for (const part of parts) {
                    if (current && textWidth(current + part, fontSize) > width) {
                        lines.push(current);
                        current = '';
                    }
                    current += part;
                }
            }
            lines.push(current);
        }
        const layout: ImageTranslationTextLayout = { lines, fontSize, lineHeight: fontSize * lineSpacing };
        if (measureInk) {
            const metrics = lines.map(line => line ? measureInk(line, fontSize) : {ascent: fontSize / 2, descent: fontSize / 2});
            if (metrics.every(metric => Number.isFinite(metric.ascent) && Number.isFinite(metric.descent)
                && metric.ascent + metric.descent > 0 && Number.isFinite(metric.ascent + metric.descent))) {
                let top = Infinity, bottom = -Infinity;
                for (const metric of metrics) layout.lineHeight = Math.max(layout.lineHeight, metric.ascent + metric.descent);
                const baselines = metrics.map((metric, index) => {
                    const baseline = index * layout.lineHeight;
                    top = Math.min(top, baseline - metric.ascent);
                    bottom = Math.max(bottom, baseline + metric.descent);
                    return baseline;
                });
                layout.ink = {height: bottom - top, baselines: baselines.map(baseline => baseline - top)};
            }
        }
        return layout;
    };
    const fits = (layout: ImageTranslationTextLayout) => (layout.ink?.height ?? layout.lines.length * layout.lineHeight) <= height
        && layout.lines.every(line => textWidth(line, layout.fontSize) <= width);

    // 有真实墨迹时，外侧不需要额外占一个完整 CSS 行高；行距只用于多行之间。
    let high = Math.min(measureInk?Math.min(Number.MAX_VALUE,height*2):height/lineSpacing, maxFontSize);
    let largest = wrap(high);
    if(measureInk&&!largest.ink){high=Math.min(height/lineSpacing,maxFontSize);largest=wrap(high);}
    if (fits(largest)) return largest;
    // 根据完整段落在 1px 字号的宽度推导可容纳下限；极长译文可缩小但始终保留全部文字。
    // 行数来自完整译文，不展开成函数参数，也不为取最大值另建宽度数组。
    let paragraphWidth = 1;
    for (const paragraph of paragraphs) paragraphWidth = Math.max(paragraphWidth, textWidth(paragraph, 1));
    let low = Math.min(1, width / paragraphWidth, height / (paragraphs.length * lineSpacing)) * 0.99;
    let best = wrap(low);
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const candidate = wrap((low + high) / 2);
        if (fits(candidate)) {
            best = candidate;
            low = candidate.fontSize;
        } else {
            high = candidate.fontSize;
        }
    }
    return best;
}

/** 在原区域内绘制完整译文；使用真实字号适配而非 Canvas maxWidth 横向压扁。 */
export function drawTranslatedImageText(
    context: CanvasRenderingContext2D,
    text: string,
    left: number,
    top: number,
    width: number,
    height: number,
    backgroundColor: string,
    maxFontSize = Infinity,
    textAlign: 'left' | 'center' | 'right' = 'center',
    prepared?: ImageTranslationTextLayout,
    foregroundColor?: string,
): void {
    const paddingX = Math.min(2, width * 0.03);
    const paddingY = Math.min(1, height * 0.05);
    context.save();
    try {
        // 离屏文档通常是LTR，不能把这个默认方向施加到阿拉伯文、希伯来文及其数字/标点。
        context.direction = getImageTextDirection(text);
        let measuredFont = 0;
        const metrics = new Map<string, TextMetrics>();
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        const measure = (line: string, fontSize: number) => {
            if (fontSize !== measuredFont) {
                context.font = `400 ${fontSize}px ${IMAGE_TEXT_FONT}`;
                measuredFont = fontSize;
                metrics.clear();
            }
            let result = metrics.get(line);
            if (!result) {
                result = context.measureText(line);
                if (metrics.size >= 512) metrics.clear();
                metrics.set(line, result);
            }
            return result;
        };
        const bleed = (size: number) => Math.max(0.35, size * 0.06) / 2;
        const layout = prepared ?? layoutImageTranslationText(text, width - paddingX * 2, height - paddingY * 2,
            (line, size) => {
                const metric = measure(line, size);
                const inkWidth = metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight;
                return Number.isFinite(inkWidth) ? Math.max(metric.width, inkWidth) + bleed(size) * 2 : metric.width;
            }, maxFontSize, (line, size) => {
                const metric = measure(line, size);
                const valid = metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent > 0;
                return {ascent: valid ? metric.actualBoundingBoxAscent + bleed(size) : NaN,
                    descent: valid ? metric.actualBoundingBoxDescent + bleed(size) : NaN};
            });
        if (layout.lines.length === 0) return;
        context.beginPath();
        context.rect(left, top, width, height);
        context.clip();
        context.font = `400 ${layout.fontSize}px ${IMAGE_TEXT_FONT}`;
        context.textAlign = layout.ink ? 'left' : textAlign;
        context.textBaseline = layout.ink ? 'alphabetic' : 'middle';
        context.fillStyle = foregroundColor ?? getImageTextColor(backgroundColor);
        context.strokeStyle = backgroundColor;
        context.lineWidth = Math.max(0.35, layout.fontSize * 0.06);
        context.lineJoin = 'round';
        const firstLine = textAlign === 'center'
            ? top + (height - layout.lineHeight * layout.lines.length) / 2 + layout.lineHeight / 2
            : top + paddingY + layout.lineHeight / 2;
        const x = textAlign === 'left' ? left + paddingX : textAlign === 'right' ? left + width - paddingX : left + width / 2;
        layout.lines.forEach((line, index) => {
            const y = layout.ink
                ? top + (textAlign === 'center' ? (height - layout.ink.height) / 2 : paddingY) + layout.ink.baselines[index]
                : firstLine + index * layout.lineHeight;
            const metric = layout.ink ? measure(line, layout.fontSize) : undefined;
            const inkX = metric && Number.isFinite(metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight)
                ? textAlign === 'left' ? left + paddingX + metric.actualBoundingBoxLeft + bleed(layout.fontSize)
                    : textAlign === 'right' ? left + width - paddingX - metric.actualBoundingBoxRight - bleed(layout.fontSize)
                        : left + (width + metric.actualBoundingBoxLeft - metric.actualBoundingBoxRight) / 2
                : x;
            context.strokeText(line, inkX, y);
            context.fillText(line, inkX, y);
        });
    } finally {
        context.restore();
    }
}
