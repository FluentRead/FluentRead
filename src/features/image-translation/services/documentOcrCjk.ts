/**
 * @file src/features/image-translation/services/documentOcrCjk.ts
 * 文件职责：在扫描文档的实际行上下文中复核低置信度汉字，避免静默漏字及过大字形带来的误读。
 * 主要内容：只对能逐词对应原始行的横排汉字上下文执行两种缩小倍率复核；两次高分读数相同、长度相同且变化仅落在原低分汉字位置时接受。数字、标点和高分文字不得改变。无法确认或超过有界预算时保留可对应的原读数与核对框，原始 OCR 数据始终不变。
 * 模块边界：不解码图片、不创建 Worker、不保存历史；像素裁剪、取消、缓存和行指标由 OCR 运行时负责，图片及漫画模式不调用此模块。
 */
import type {Bbox, Block, Line, Word} from 'tesseract.js';
import type {OcrLine} from '@/src/features/image-translation/core';

export type DocumentCjkReader = (box: Bbox, scale: .5 | .75) => Promise<{text: string; confidence: number}>;
const maximumContexts = 24;
const compact = (text: string) => text.replace(/\s/gu, '');
const han = (text: string) => /\p{Script=Han}/u.test(text);
const low = (word: Word) => Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence < 75 && han(word.text);
const valid = (box: Bbox | undefined): box is Bbox => Boolean(box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0);
const inside = (box: Bbox, outer: Bbox) => box.x0 >= outer.x0 && box.y0 >= outer.y0 && box.x1 <= outer.x1 && box.y1 <= outer.y1;
function exact(line: Line): boolean {
    let cursor = 0;
    for (const word of line.words) {
        const at = line.text.indexOf(word.text, cursor);
        if (!word.text.trim() || at < cursor || line.text.slice(cursor, at).trim() || !valid(word.bbox)) return false;
        cursor = at + word.text.length;
    }
    return !line.text.slice(cursor).trim();
}
const union = (words: readonly Word[]): Bbox => ({x0: Math.min(...words.map(word => word.bbox.x0)), y0: Math.min(...words.map(word => word.bbox.y0)),
    x1: Math.max(...words.map(word => word.bbox.x1)), y1: Math.max(...words.map(word => word.bbox.y1))});
const textOf = (words: readonly Word[]) => words.map(word => word.text.trim()).reduce((text, next) => !text || /[\p{Script=Han}([{]$/u.test(text)
    || /^[\p{Script=Han},.;:!?%\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b)\]}]/u.test(next) ? text + next : `${text} ${next}`, '');

export async function recoverDocumentOcrCjk(blocks: Block[] | null, ordinary: readonly OcrLine[], read: DocumentCjkReader, signal?: AbortSignal): Promise<OcrLine[]> {
    signal?.throwIfAborted();
    let result = [...ordinary], attempted = 0;
    for (const block of blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
        const candidates = (line.words ?? []).filter(low);
        if (!candidates.length || !valid(line.bbox)) continue;
        const review = (box: Bbox) => result.push({text: '', bbox: {...box}, documentReview: true});
        const baseline = line.baseline;
        if (!exact(line) || baseline && Math.abs(baseline.y1 - baseline.y0) > Math.max((line.bbox.y1 - line.bbox.y0) * .3, (line.bbox.x1 - line.bbox.x0) * .035)) {review(line.bbox);continue;}
        const heights = line.words.map(word => word.bbox.y1 - word.bbox.y0).sort((a, b) => a - b), height = heights[Math.floor(heights.length / 2)];
        const groups: Word[][] = [];
        for (const word of line.words) {
            const previous = groups.at(-1);
            if (previous && word.bbox.x0 - previous.at(-1)!.bbox.x1 <= height * 4) previous.push(word); else groups.push([word]);
        }
        for (const words of groups) {
            if (!words.some(low)) continue;
            const box = union(words), raw = textOf(words), rawCharacters = Array.from(compact(raw));
            // 引擎词框可能带推导出的上下伸部；裁剪与最终行框使用整行的实际墨迹范围。
            const ink = {x0: Math.max(box.x0, line.bbox.x0), x1: Math.min(box.x1, line.bbox.x1), y0: line.bbox.y0, y1: line.bbox.y1};
            if (!valid(ink)) {review(box);continue;}
            const present = result.filter(value => value.text && inside(value.bbox, box)).sort((a, b) => a.bbox.x0 - b.bbox.x0);
            const expected = compact(textOf(words.filter(word => word.confidence >= 25)));
            // 低分数字和非汉字噪声仍由各自证据契约处理；不能在汉字复核中借机复活它们。
            const safe = words.every(word => Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 100
                && (word.confidence >= 25 || /^\p{Script=Han}+$/u.test(word.text))
                && Math.min(word.bbox.y1, line.bbox.y1) - Math.max(word.bbox.y0, line.bbox.y0) >= Math.min(word.bbox.y1 - word.bbox.y0, line.bbox.y1 - line.bbox.y0) * .35)
                && compact(present.map(value => value.text).join('')) === expected
                && rawCharacters.length <= 160 && box.y1 - box.y0 <= height * 2.5;
            if (!safe) {review(box);continue;}
            const eligible: boolean[] = words.flatMap(word => Array.from(compact(word.text), character => low(word) && han(character)));
            let accepted: string | undefined;
            if (words.some(word => word.confidence >= 75 && han(word.text)) && attempted < maximumContexts) {
                attempted++;
                const first = await read(ink, .5);signal?.throwIfAborted();
                const second = await read(ink, .75);signal?.throwIfAborted();
                const candidate = compact(first.text), characters = Array.from(candidate);
                if ([first, second].every(value => Number.isFinite(value.confidence) && value.confidence >= 90 && value.confidence <= 100)
                    && candidate === compact(second.text) && characters.length === rawCharacters.length
                    && characters.every((character, index) => character === rawCharacters[index] || eligible[index] && han(character))) accepted = candidate;
            }
            // 只补回有逐词原文及位置证据的汉字；不提高原始置信度，未确认上下文仍显式提醒。
            let position = 0;
            const acceptedCharacters = accepted && Array.from(accepted);
            const replacement = acceptedCharacters ? Array.from(raw, character => /\s/u.test(character) ? character : acceptedCharacters[position++]).join('') : raw;
            const mapped = new Set(present);
            const first = present[0];
            result = result.filter(value => !mapped.has(value));
            result.push({...first, text: replacement, bbox: ink});
            if (!accepted) review(box);
        }
    }
    return result;
}
