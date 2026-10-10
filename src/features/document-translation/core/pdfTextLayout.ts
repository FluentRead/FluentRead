/**
 * @file src/features/document-translation/core/pdfTextLayout.ts
 * 文件职责：将 PDF 阅读计划中的完整文字和原图区域分页为可读的下载版面。
 * 主要内容：正文固定可读字号与行距，按字素和词边界换行并缓存字宽；长段落与超高原图跨页续排，保留每个字符和图像区域，不缩小文字、不裁剪译文；每页绘制项使用标准 PDF 点坐标。
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
// 一张输入页的续页预算；损坏或极端的几何不能令分页无限增长。
const MAX_READING_PAGES = 4096;

export function pdfReadingFont(role: string): PdfReadingFont {
    if (role === 'title') return {size: 20, weight: 700, lineHeight: 28};
    if (role === 'heading') return {size: 16, weight: 700, lineHeight: 23};
    if (role === 'caption') return {size: 11.5, weight: 400, lineHeight: 18};
    if (role === 'metadata' || role === 'footer' || role === 'note') return {size: 11, weight: 400, lineHeight: 17};
    return {size: 12, weight: 400, lineHeight: 19.2};
}

/** 测量只作用于词或独立字素，避免反复测量越来越长的中文字符串。 */
export function wrapPdfReadingText(value: string, width: number, font: PdfReadingFont, measure: PdfTextMeasure): string[] {
    const maxWidth = Math.max(1, Number.isFinite(width) ? width : 1);
    const widths = new Map<string, number>();
    const measured = (text: string) => {
        const cached = widths.get(text);
        if (cached !== undefined) return cached;
        const result = measure(text, font);
        const next = Number.isFinite(result) ? Math.max(0, result) : Math.max(1, Array.from(text).length) * maxWidth;
        if (widths.size < 512) widths.set(text, next);
        return next;
    };
    const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : undefined;
    const graphemes = (text: string) => segmenter && /[\p{Mark}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d]/u.test(text)
        ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
    const lines: string[] = [];
    for (const paragraph of value.replace(/\r\n?/gu, '\n').split('\n')) {
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
export function paginatePdfReadingPlan(plan: PdfReadingPlan, measure: PdfTextMeasure): PdfReadingOutputPage[] {
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
            for (const line of lines) {
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
            if (!Number.isFinite(totalHeight) || Math.ceil(totalHeight / (bottom - margin)) > MAX_READING_PAGES) throw new Error('PDF 原图区域过高，无法在合理页数内分页');
            if (!(totalHeight > 0)) continue;
            let consumed = 0;
            while (consumed < rect.height) {
                ensure(Math.min(80, rect.height * scale));
                const sourceHeight = Math.min(rect.height - consumed, (bottom - y) / scale);
                const drawHeight = sourceHeight * scale;
                if (!(sourceHeight > 0) || !Number.isFinite(sourceHeight) || consumed + sourceHeight <= consumed) throw new Error('PDF 原图分页无法继续，请重新打开文件');
                page!.items.push({kind: 'region', entryId: entry.id, sourceRect: {...rect, y: rect.y + consumed, height: sourceHeight}, x: margin, y, width: rect.width * scale, height: drawHeight});
                // 最后一个条带直接到终点，避免浮点尾差形成额外的近零切片。
                consumed = sourceHeight >= rect.height - consumed ? rect.height : consumed + sourceHeight;
                y += drawHeight;
                if (consumed < rect.height) nextPage();
            }
            y += 16;
        }
    }
    return pages;
}
