/**
 * @file src/features/image-translation/services/documentOcrNumbers.ts
 * 文件职责：避免扫描文档中已被引擎读取的数字因整词低置信度无声丢失，保留可核对的原词及原页位置。
 * 主要内容：逐行验证原文与词出现位置，再检查数字词与全部字形的文字、坐标和分数；只将具有完整字形证据的原词交给既有规范化器保留，不更改字形、符号或原始置信度。所有低分数字候选均附带核对框；缺少字形、对应关系不成立或分数不足时只保留提醒，不猜测文本。
 * 模块边界：仅消费当前文档 OCR 的结构化结果，不读取图片、不创建 Worker、不影响图片/漫画擦除策略；原始识别对象不可变，核对和缓存策略由 OCR 运行时及文档 feature 承接。
 */
import type {Bbox, Block, Line} from 'tesseract.js';
import {normalizeOcrLines, type OcrLine} from '@/src/features/image-translation/core';

const validBox = (box: Bbox | undefined): box is Bbox => Boolean(box
    && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0);
const contains = (outer: Bbox, inner: Bbox) => outer.x0 <= inner.x0 && outer.y0 <= inner.y0
    && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;

/** 重复数值也必须与其在原行中的那一次出现对应，不能略过未映射的正文。 */
function exactWords(line: Line): boolean {
    let cursor = 0;
    for (const word of line.words) {
        const offset = line.text.indexOf(word.text, cursor);
        if (!word.text || offset < cursor || line.text.slice(cursor, offset).trim()
            || !validBox(word.bbox) || !contains(line.bbox, word.bbox)) return false;
        cursor = offset + word.text.length;
    }
    return !line.text.slice(cursor).trim();
}

export function retainDocumentOcrNumbers(blocks: Block[] | null, ordinary: OcrLine[]): OcrLine[] {
    const retained = new Set<object>(), review: OcrLine[] = [];
    for (const block of blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
        if (!validBox(line.bbox)) continue;
        const candidates = (line.words ?? []).filter(word => /\p{N}/u.test(word.text)
            && word.confidence !== undefined && !(Number.isFinite(word.confidence) && word.confidence >= 25));
        if (!candidates.length) continue;
        const mapped = exactWords(line);
        for (const word of candidates) {
            const box = validBox(word.bbox) && contains(line.bbox, word.bbox) ? word.bbox : line.bbox;
            review.push({text: '', bbox: {...box}, documentReview: true});
            const symbols = word.symbols;
            if (mapped && Number.isFinite(word.confidence) && word.confidence >= 0 && symbols?.length
                && symbols.map(symbol => symbol.text).join('') === word.text
                && symbols.every((symbol, index) => symbol.text.length > 0 && validBox(symbol.bbox) && contains(word.bbox, symbol.bbox)
                    && Number.isFinite(symbol.confidence) && symbol.confidence >= 85 && symbol.confidence <= 100
                    && (index === 0 || symbol.bbox.x0 >= symbols[index - 1].bbox.x1))) retained.add(word);
        }
    }
    return review.length ? [...(retained.size ? normalizeOcrLines(blocks, false, retained) : ordinary), ...review] : ordinary;
}
