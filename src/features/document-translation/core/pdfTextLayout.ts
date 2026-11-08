/**
 * @file src/features/document-translation/core/pdfTextLayout.ts
 * 文件职责：将 PDF 阅读计划中的完整文字和原图区域分页为可读的下载版面。
 * 主要内容：正文固定可读字号与行距，按字素和词边界换行并用有界先进先出缓存复用近期字宽；保留当前页能容纳的段内空行，避免空行单独成页，不改写存储文字；整页可容纳的公式或插图整体换页，长段落与真实超高原图跨页续排，把源坐标浮点尾差并入末条带并保全全部图像几何；原版译文续页可按最后一张的内容缩短页高，保留正文下方的页脚空间。
 * 模块边界：只消费纯阅读计划和注入的字体测量，不使用 DOM、Canvas、浏览器 API 或文件 I/O；具体绘制与编码由 PDF 光栅端口负责。
 */
import type {PdfReadingPlan, PdfReadingRect} from './pdfReadingPlan';

export interface PdfReadingFont {size: number; weight: 400 | 600 | 700; lineHeight: number}
export type PdfTextMeasure = (text: string, font: PdfReadingFont) => number;
export interface PdfReadingTextDraw {
    kind: 'text'; entryId: string; segmentIndex: number; text: string;
    x: number; y: number; width: number; font: PdfReadingFont;
}
export interface PdfReadingRegionDraw {
    kind: 'region'; entryId: string; sourceRect: PdfReadingRect;
    x: number; y: number; width: number; height: number;
}
export type PdfReadingDraw = PdfReadingTextDraw | PdfReadingRegionDraw;
export interface PdfReadingOutputPage {width: number; height: number; items: PdfReadingDraw[]}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CLOSING = /^[，。！？；：、,.!?;:%）\]】》」』”’]/u;
const MAX_MEASURED_TOKENS = 512;
// 一张输入页的续页预算；损坏或极端的几何不能令分页无限增长。
const MAX_READING_PAGES = 4096;

/** 这两段 Unicode 选择符依附于前一个字符，不单独占据字形或换行位置。 */
export function isPdfReadingVariationSelector(character: string): boolean {
    const code = character.codePointAt(0)!;
    return (code >= 0xFE00 && code <= 0xFE0F) || (code >= 0xE0100 && code <= 0xE01EF);
}

export function pdfReadingFont(role: string): PdfReadingFont {
    if (role === 'title') return {size: 20, weight: 700, lineHeight: 28};
    if (role === 'heading') return {size: 16, weight: 700, lineHeight: 23};
    if (role === 'caption') return {size: 11.5, weight: 400, lineHeight: 18};
    if (role === 'metadata' || role === 'footer' || role === 'note') return {size: 11, weight: 400, lineHeight: 17};
    return {size: 12, weight: 400, lineHeight: 19.2};
}

/** 测量只作用于词或独立字素；首尾空段不占排版高度，正文内部空行保持原样。 */
export function wrapPdfReadingText(value: string, width: number, font: PdfReadingFont, measure: PdfTextMeasure): string[] {
    const maxWidth = Math.max(1, Number.isFinite(width) ? width : 1);
    const widths = new Map<string, number>();
    const measured = (text: string) => {
        const cached = widths.get(text);
        if (cached !== undefined) return cached;
        const result = measure(text, font);
        const next = Number.isFinite(result) ? Math.max(0, result) : Math.max(1, Array.from(text).length) * maxWidth;
        // 长前缀不能永久占满缓存，否则后续反复出现的正文字符每次都要重新测量。
        if (widths.size >= MAX_MEASURED_TOKENS) widths.delete(widths.keys().next().value!);
        widths.set(text, next);
        return next;
    };
    const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : undefined;
    const graphemes = (text: string) => {
        if (segmenter && /[\p{Mark}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d]/u.test(text)) {
            return Array.from(segmenter.segment(text), item => item.segment);
        }
        const characters: string[] = [];
        for (const character of text) {
            if (isPdfReadingVariationSelector(character) && characters.length) characters[characters.length - 1] += character;
            else characters.push(character);
        }
        return characters;
    };
    const lines: string[] = [];
    const paragraphs = value.replace(/\r\n?/gu, '\n').split('\n');
    let first = 0, last = paragraphs.length;
    while (first < last && !paragraphs[first].trim()) first += 1;
    while (last > first && !paragraphs[last - 1].trim()) last -= 1;
    for (let index = first; index < last; index += 1) {
        const paragraph = paragraphs[index];
        if (!paragraph.trim()) {lines.push(''); continue;}
        const tokens: string[] = [];
        let word = '';
        const flushWord = () => {if (word) {tokens.push(word); word = '';}};
        for (const character of graphemes(paragraph)) {
            if (CJK.test(character) || /\s/u.test(character)) {flushWord(); tokens.push(character);}
            else if (CLOSING.test(character) && !word && tokens.length && !/\s/u.test(tokens.at(-1)!)) tokens[tokens.length - 1] += character;
            else word += character;
        }
        flushWord();
        let line = '', used = 0;
        const flush = () => {lines.push(line.trimEnd()); line = ''; used = 0;};
        const append = (token: string) => {
            if (!line && /^\s+$/u.test(token)) return;
            const tokenWidth = measured(token);
            if (line && used + tokenWidth > maxWidth) flush();
            if (!line && /^\s+$/u.test(token)) return;
            line += token; used += tokenWidth;
        };
        for (const token of tokens) {
            if (measured(token) > maxWidth && graphemes(token).length > 1) {
                for (const character of graphemes(token)) append(character);
            } else append(token);
        }
        if (line) flush();
    }
    return lines;
}

/** 每个长段落和图像都可跨页；下一页继续消费原内容，绝不丢弃尾行。 */
export function paginatePdfReadingPlan(
    plan: PdfReadingPlan, measure: PdfTextMeasure, {compactLastPage = false} = {},
): PdfReadingOutputPage[] {
    const width = 612, height = 792, margin = 42;
    const availableWidth = width - margin * 2, bottom = height - margin;
    const pages: PdfReadingOutputPage[] = [];
    let page: PdfReadingOutputPage | undefined;
    let y = margin;
    const nextPage = () => {
        if (pages.length >= MAX_READING_PAGES) throw new Error('PDF 单页内容过长，无法在合理页数内分页');
        page = {width, height, items: []}; pages.push(page); y = margin;
    };
    const ensure = (size: number) => {if (!page || (page.items.length > 0 && y + size > bottom)) nextPage();};
    for (const entry of plan.entries) {
        if (entry.kind === 'text') {
            const font = pdfReadingFont(entry.role);
            const lines = wrapPdfReadingText(entry.text, availableWidth, font, measure);
            if (!lines.length) continue;
            for (const line of lines) {
                if (!line) {
                    // 保留页内段落间距，但不为超出当前页的空行分配新页。
                    if (y + font.lineHeight <= bottom) y += font.lineHeight;
                    continue;
                }
                ensure(font.lineHeight);
                page!.items.push({kind: 'text', entryId: entry.id, segmentIndex: entry.segmentIndex, text: line, x: margin, y, width: availableWidth, font});
                y += font.lineHeight;
            }
            y += 12;
        } else {
            const rect = entry.sourceRect;
            if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) continue;
            const scale = Math.min(1.5, availableWidth / rect.width);
            const totalHeight = rect.height * scale;
            const maximumHeight = (bottom - margin) * MAX_READING_PAGES;
            if (!Number.isFinite(totalHeight) || totalHeight > maximumHeight + Number.EPSILON * maximumHeight * 2) throw new Error('PDF 原图区域过高，无法在合理页数内分页');
            if (!(totalHeight > 0)) continue;
            let consumed = 0, stripCount = 0, firstPageHeight = 0;
            while (consumed < rect.height) {
                // 整页能容纳的公式或图表保持原像素整体；只有真实超高图片继续条带分页。
                ensure(totalHeight <= bottom - margin ? totalHeight : Math.min(80, rect.height * scale));
                if (stripCount === 0) firstPageHeight = bottom - y;
                // 从已占用的整页数反推源终点，避免数百次累加非整数条带高度后积出额外尾页。
                const boundary = (firstPageHeight + stripCount * (bottom - margin)) / scale;
                // 缩放可能留下几个源坐标 ULP；只把该浮点尾差并入末条带，真实细条仍单独续排。
                const tolerance = Number.EPSILON * Math.max(rect.height, boundary) * 2;
                const sourceEnd = rect.height <= boundary + tolerance ? rect.height : boundary;
                const sourceHeight = sourceEnd - consumed;
                const drawHeight = Math.min(bottom - y, sourceHeight * scale);
                if (!(sourceHeight > 0) || !Number.isFinite(sourceHeight) || consumed + sourceHeight <= consumed) throw new Error('PDF 原图分页无法继续，请重新打开文件');
                page!.items.push({kind: 'region', entryId: entry.id, sourceRect: {...rect, y: rect.y + consumed, height: sourceHeight}, x: margin, y, width: rect.width * scale, height: drawHeight});
                consumed = sourceEnd;
                stripCount += 1;
                y += drawHeight;
                if (consumed < rect.height) nextPage();
            }
            y += 16;
        }
    }
    const lastPage = pages.at(-1);
    if (compactLastPage && lastPage) {
        const lastItem = lastPage.items.at(-1)!;
        const itemHeight = lastItem.kind === 'text' ? lastItem.font.lineHeight : lastItem.height;
        lastPage.height = Math.min(height, Math.ceil(lastItem.y + itemHeight + margin));
    }
    return pages;
}
