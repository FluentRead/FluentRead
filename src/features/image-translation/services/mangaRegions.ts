/**
 * @file src/features/image-translation/services/mangaRegions.ts
 * 文件职责：把漫画专用 OCR 和通用 OCR 行转换成可整段翻译与修补的气泡或旁白区域。
 * 主要内容：校验并夹紧坐标，过滤纯符号和源语言不符的短片段；神经 OCR 保留置信度策略，语言无关地保留高置信多位数字、合法时间日期、货币金额、百分数、小数、分数和温度，只为判定执行 NFKC 而保留原文；仅独立气泡容许高置信度大单字，通用 OCR 从行框补足字号与原始修补框；按方向、字号、重叠与间距合并相邻行，东亚相邻文字不插入空格，保留硬连字符且只移除行末软连字符；仅已定位的独立气泡容许略宽横排行距与有界宽竖列距，保持不同气泡分离。
 * 模块边界：纯数据算法，不运行模型、不读取 DOM 或配置，也不修补图片；只输出可核对的识别原文和区域，不推测缺失文字。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {NumericEvidenceOcrLine} from '../core';
import {numericInformation} from './mangaNumeric';

export interface MangaOcrItem {
    text: string;
    confidence: number;
    box: {x: number; y: number; width: number; height: number};
}
export interface MangaRegion extends OcrLine {fontSize: number; sourceBoxes?: OcrLine['bbox'][]; numericUncertain?: true; guardOnly?: true}

function union(left: OcrLine['bbox'], right: OcrLine['bbox']): OcrLine['bbox'] {
    return {x0: Math.min(left.x0, right.x0), y0: Math.min(left.y0, right.y0),
        x1: Math.max(left.x1, right.x1), y1: Math.max(left.y1, right.y1)};
}

function adjacent(left: MangaRegion, right: MangaRegion, lineGap: number, columnGap: number): boolean {
    if (left.vertical !== right.vertical) return false;
    const a = left.bbox, b = right.bbox;
    const [start, end, crossStart, crossEnd] = left.vertical
        ? ['x0', 'x1', 'y0', 'y1'] as const : ['y0', 'y1', 'x0', 'x1'] as const;
    const thickness = Math.min(left.fontSize, right.fontSize);
    if (Math.max(left.fontSize, right.fontSize) > thickness * 1.8) return false;
    const gap = Math.max(a[start], b[start]) - Math.min(a[end], b[end]);
    const overlap = Math.min(a[crossEnd], b[crossEnd]) - Math.max(a[crossStart], b[crossStart]);
    // 同一基线的分词先由 OCR 合并；这里仅跨行/列合段，避免旁边的气泡被连成一句。
    const centers = Math.abs((a[start] + a[end]) - (b[start] + b[end])) / 2;
    if (centers < thickness * 0.45) {
        return gap <= 0 && -overlap <= thickness * 0.8;
    }
    return gap <= thickness * (left.vertical ? columnGap : lineGap)
        && overlap >= Math.min(a[crossEnd] - a[crossStart], b[crossEnd] - b[crossStart]) * 0.5;
}

/** 源语言只用于排除明确不符的绘画噪声；自动检测保留两种书写系统。 */
export function groupMangaText(items: MangaOcrItem[], sourceLanguage: string, width: number, height: number, context: 'page' | 'bubble' = 'page', protectNumeric = false): MangaRegion[] {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return [];
    const english = /^en(?:-|$)/i.test(sourceLanguage);
    const japanese = /^(?:ja|jpn)(?:-|$)/i.test(sourceLanguage);
    const lines: MangaRegion[] = items.flatMap(item => {
        const sourceText=item.text.trim();
        const text=numericInformation(sourceText) ? sourceText : sourceText.replace(/\s+/gu, ' ');
        const box = item.box;
        if (!Number.isFinite(item.confidence) || item.confidence < 0.65 || item.confidence > 1 || !text) return [];
        const numericSyntax=numericInformation(text);
        const numeric=item.confidence>=0.9&&numericSyntax;
        if (numericSyntax && !numeric) return [];
        if ((!numeric && (!/\p{L}/u.test(text)
            || (english && (!/[a-z]/iu.test(text) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text)))
            || (japanese && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(text) && text.replace(/[^a-z]/giu,'').length < 4)))
            || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
        const bbox = {x0: Math.max(0, box.x), y0: Math.max(0, box.y),
            x1: Math.min(width, box.x + box.width), y1: Math.min(height, box.y + box.height)};
        if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return [];
        const vertical = !english && box.height > box.width * 1.8;
        const fontSize = vertical ? box.width : box.height;
        // 巨大拟声字和纹理中的孤字不作为对白；保留 I/A 等合法英语短句。
        if (!numeric && Array.from(text.replace(/[^\p{L}\p{N}]/gu, '')).length < 2
            && (english ? !/^[IA][.!?]?$/u.test(text) : item.confidence < 0.9 || (context !== 'bubble' && Math.max(box.width, box.height) > width * 0.12))) return [];
        return [{text, bbox, fontSize, ...(vertical ? {vertical: true as const} : {})}];
    });
    // 大写字形框常小于字体行高；已定位气泡中允许最多 1.5 倍字形高度的空隙，
    // 让同一对白保持整句。竖列按字形厚度保留较宽的阅读列距，
    // 必须已有同一气泡归属；整页、通用 OCR 和不同气泡沿用严格边界。
    if (!protectNumeric) return mergeMangaLines(lines, context === 'bubble' ? 1.5 : 0.8, context === 'bubble' ? 3.5 : 0.8);
    const numeric = lines.filter(line => numericInformation(line.text));
    const others = lines.filter(line => !numericInformation(line.text));
    return [...mergeMangaLines(others, context === 'bubble' ? 1.5 : 0.8, context === 'bubble' ? 3.5 : 0.8),
        ...numeric.map(line => ({...line, sourceBoxes: [line.bbox]}))].sort(readingOrder);
}

/** 已规范化的 Tesseract 行不带漫画字号；从原图行框补足修补契约，再合并跨行对白，保留所有原始框。 */
export function groupMangaOcrLines(lines: NumericEvidenceOcrLine[], sourceLanguage: string, width: number, height: number): MangaRegion[] {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return [];
    const language = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase().split('-')[0];
    const regions: MangaRegion[] = lines.flatMap(line => {
        const sourceText=line.text.trim();
        const text=numericInformation(sourceText) ? sourceText : sourceText.replace(/\s+/gu, ' ');
        const {x0, y0, x1, y1} = line.bbox;
        const numeric = typeof line.numericConfidence === 'number' && Number.isFinite(line.numericConfidence)
            && line.numericConfidence >= 90 && line.numericConfidence <= 100 && numericInformation(text);
        if (numericInformation(text) && !numeric) return [];
        if (!text || (!numeric && !/\p{L}/u.test(text)) || ![x0, y0, x1, y1].every(Number.isFinite)) return [];
        // 与日文专用模型一致，排除绘画上误识别的短拉丁碎片；合法源语言字和完整英文词仍保留。
        const native = language === 'ru' ? /\p{Script=Cyrillic}/u.test(text)
            : language === 'ko' ? /[\uac00-\ud7a3]/u.test(text) : true;
        if (!numeric && !native && text.replace(/[^a-z]/giu, '').length < 4) return [];
        const bbox = {x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(width, x1), y1: Math.min(height, y1)};
        if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return [];
        return [{text, bbox, fontSize: line.vertical ? bbox.x1 - bbox.x0 : bbox.y1 - bbox.y0,
            ...(line.vertical ? {vertical: true as const} : {})}];
    });
    const numeric = regions.filter(line => numericInformation(line.text));
    const others = regions.filter(line => !numericInformation(line.text));
    return [...mergeMangaLines(others), ...numeric.map(line => ({...line, sourceBoxes: [line.bbox]}))].sort(readingOrder);
}

function readingOrder(a: MangaRegion, b: MangaRegion): number {
    return a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0;
}

function mergeMangaLines(lines: MangaRegion[], lineGap = 0.8, columnGap = 0.8): MangaRegion[] {
    const groups: MangaRegion[][] = [];
    const remaining = new Set(lines);
    for (const first of lines) {
        if (!remaining.delete(first)) continue;
        const members = [first];
        for (let cursor = 0; cursor < members.length; cursor += 1) {
            for (const next of remaining) if (adjacent(members[cursor], next, lineGap, columnGap)) {
                remaining.delete(next); members.push(next);
            }
        }
        groups.push(members);
    }
    return groups.map(members => {
        members.sort((a, b) => {
            const near = Math.min(a.fontSize, b.fontSize) * 0.45;
            return a.vertical
                ? Math.abs(a.bbox.x0 - b.bbox.x0) < near ? a.bbox.y0 - b.bbox.y0 : b.bbox.x0 - a.bbox.x0
                : Math.abs(a.bbox.y0 - b.bbox.y0) < near ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0;
        });
        const sizes = members.map(member => member.fontSize).sort((a, b) => a - b);
        const text=members.reduce((text, member) => {
            if (text.endsWith('\u00ad')) return text.slice(0,-1) + member.text;
            const cjk = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
            const last = text.slice(-1), next = member.text.slice(0,1);
            const hyphen = /\p{L}-$/u.test(text) && /^\p{L}/u.test(member.text);
            const separator = !text || members[0].vertical || hyphen || ((cjk.test(last) || /[。！？、」』】）]/u.test(last)) && cjk.test(next)) ? '' : ' ';
            return text + separator + member.text;
        }, '');
        return {text,
            bbox: members.map(member => member.bbox).reduce(union), fontSize: sizes[Math.floor(sizes.length / 2)],
            sourceBoxes: members.map(member => ({...member.bbox})),
            ...(members[0].vertical ? {vertical: true as const} : {})};
    }).sort(readingOrder);
}
