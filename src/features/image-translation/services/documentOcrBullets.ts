/**
 * @file src/features/image-translation/services/documentOcrBullets.ts
 * 文件职责：根据原图实心圆点和重复的悬挂缩进恢复扫描文档列表，避免 OCR 把圆点读成字母或过滤后合并相邻条目。
 * 主要内容：只检查原行首个小号近圆字形，要求其悬在正文基线上方，绑定同位置的规范化正文，并由其他条目的相同对齐和尺寸支持；有界裁剪必须具有实心中心、留白角部和合理墨迹比例，才输出独立圆点与正文行供既有 PDF 列表逻辑使用；歧义和超出复核预算的候选携带核对框。逐项检查取消，结果原子返回且不改写输入。
 * 模块边界：不解码图片、不创建 Canvas 或 Worker、不猜测普通字母含义；原像素由 OCR 运行时提供，原页坐标回映和段落排版仍由现有流程负责。
 */
import type {Bbox, Block} from 'tesseract.js';
import type {OcrLine} from '@/src/features/image-translation/core';

export interface DocumentBulletPixels {width: number; height: number; data: Uint8ClampedArray}
type Candidate = {index: number; marker: Bbox; bodyX: number; text: string};
const valid = (box: Bbox | undefined): box is Bbox => Boolean(box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x1 > box.x0 && box.y1 > box.y0);
const height = (box: Bbox) => box.y1 - box.y0;
const boxKey = (box: Bbox) => [box.x0, box.y0, box.x1, box.y1].join(',');

/** 实心中心排除 o/e/0，留白角部排除方块；小于六像素的形状不足以确认。 */
export function isDocumentBulletPixels(pixels: DocumentBulletPixels): boolean {
    const {width, height, data} = pixels;
    if (![width, height].every(value => Number.isInteger(value) && value >= 6 && value <= 64)
        || data.length !== width * height * 4 || width / height < .75 || width / height > 1.25) return false;
    let ink = 0, core = 0, coreInk = 0, corners = 0, cornerInk = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const dark = 255 + (Math.min(data[at], data[at + 1], data[at + 2]) - 255) * data[at + 3] / 255 < 160 ? 1 : 0;
        const distance = ((x * 2 + 1 - width) / width) ** 2 + ((y * 2 + 1 - height) / height) ** 2;
        ink += dark;
        if (distance < .35) {core++; coreInk += dark;}
        if (distance > 1.2) {corners++; cornerInk += dark;}
    }
    return ink / width / height >= .64 && ink / width / height <= .92 && coreInk / core >= .96 && cornerInk / corners <= .1;
}

export async function recoverDocumentOcrBullets(blocks: Block[] | null, lines: OcrLine[],
    pixels: (box: Bbox) => Promise<DocumentBulletPixels>, signal?: AbortSignal): Promise<OcrLine[]> {
    signal?.throwIfAborted();
    const candidates: Candidate[] = [];
    for (const block of blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const row of paragraph.lines ?? []) {
        const [mark, next] = row.words ?? [];
        if (!mark || !next || !next.text.trim() || !/^[\p{L}\p{N}\p{Co}•●·]$/u.test(mark.text) || !valid(row.bbox) || !valid(mark.bbox) || !valid(next.bbox)) continue;
        const a = mark.bbox, b = next.bbox, size = height(a), body = height(b), gap = b.x0 - a.x1;
        if (a.x0 !== row.bbox.x0 || a.y0 < row.bbox.y0 || a.y1 > row.bbox.y1 || b.y0 < row.bbox.y0 || b.y1 > row.bbox.y1 || b.x1 > row.bbox.x1
            || size < body * .3 || size > body * .75 || (a.x1 - a.x0) / size < .75 || (a.x1 - a.x0) / size > 1.25
            || gap < body * .25 || gap > body * 2.5 || Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) > body * .2
            || row.words.map(word => word.text).join('').replace(/\s/gu, '') !== row.text.replace(/\s/gu, '')) continue;
        const index = lines.findIndex(line => !line.vertical && !line.documentReview && line.bbox.y0 >= row.bbox.y0 && line.bbox.y1 <= row.bbox.y1
            && line.bbox.x1 <= row.bbox.x1 && (line.bbox.x0 === a.x0 || line.bbox.x0 === b.x0)
            && (line.bbox.x0 === a.x0 ? line.text.startsWith(mark.text) && line.text.slice(mark.text.length).trimStart().startsWith(next.text) : line.text.startsWith(next.text)));
        if (index < 0) continue;
        const baseline = lines[index].baseline;
        // 普通小写字母也比相邻大写/升降部矮；圆点应悬在正文基线上方，不能仅按字框大小推断。
        if (!Number.isFinite(baseline) || baseline! - a.y1 < Math.max(1, body * .08) || baseline! - a.y1 > body * .4) continue;
        const text = lines[index].bbox.x0 === a.x0 ? lines[index].text.slice(mark.text.length).trimStart() : lines[index].text;
        candidates.push({index, marker: a, bodyX: b.x0, text});
    }
    const replacements = new Map<number, OcrLine[]>(), review: OcrLine[] = [];
    const confirmed = new Set<string>(), reviewed = new Set(lines.filter(line => line.documentReview).map(line => boxKey(line.bbox)));
    const markReview = (box: Bbox) => {const key = boxKey(box); if (!reviewed.has(key)) {reviewed.add(key); review.push({text: '', bbox: {...box}, documentReview: true});}};
    let attempted = 0;
    for (const candidate of candidates) {
        signal?.throwIfAborted();
        const {index, marker, bodyX, text} = candidate, size = height(marker);
        // 至少两个不同原行具有相同的悬挂缩进；重复检测同一行不能作为支持证据。
        if (replacements.has(index) || !candidates.some(other => other.index !== index
            && Math.abs(other.marker.x0 - marker.x0) <= size * .2 && Math.abs(other.bodyX - bodyX) <= size * .3
            && Math.abs(height(other.marker) - size) <= size * .2 && Math.abs(other.marker.y0 - marker.y0) > size * 3)) continue;
        if (attempted++ >= 128) {markReview(marker); continue;}
        const recognized = isDocumentBulletPixels(await pixels({...marker}));
        signal?.throwIfAborted();
        if (!recognized) {markReview(marker); continue;}
        const line = lines[index];
        confirmed.add(boxKey(marker));
        replacements.set(index, [
            {text: '•', bbox: {...marker}, baseline: line.baseline, fontSize: line.fontSize},
            {...line, text, bbox: {...line.bbox, x0: bodyX}},
        ]);
    }
    // 被读成 0 的实心圆点曾进入数字核对；只移除同一原框已经由像素确认的提醒，其它数字继续核对。
    return replacements.size || review.length ? [...lines.flatMap((line, index) => line.documentReview && confirmed.has(boxKey(line.bbox)) ? [] : replacements.get(index) ?? [line]), ...review] : lines;
}
