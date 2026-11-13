/**
 * @file src/features/image-translation/services/documentOcrScripts.ts
 * 文件职责：依据原页字形位置识别文档中的数字上下标，通过两种缩放下的局部识别恢复其文字与上下标结构。
 * 主要内容：只接受行、词与字形文字完全对应且几何有效的结果；以邻近正文字符为基准找出小号上移或下移字形，不把普通百分号、度数、标点或短横线当成指数；局部识别必须在两种缩放下给出一致且有足够置信度的数字，成功后按原始出现位置不可变地改写词和行，低置信度整词只有其余字形均可信时才恢复；逐项检查取消并限制每页局部识别数量，未确认部分返回原位置以供核对。
 * 未知字母脚标：低分单字母变量后、连续小号上移的商标与引号组合可能是误读的字母脚标；仅保留原读数并提示核对，不把它猜成数字或字母。普通引号、独立商标和可信词不扩大识别范围。
 * 模块边界：不加载图片、不创建 Canvas/Worker、不猜测符号内容，也不修改输入的识别对象；裁剪与实际 OCR 由现有 OCR 运行时注入，文档坐标及提醒由文档 feature 处理。
 */
import type {Bbox, Block, Line, Symbol as OcrSymbol, Word} from 'tesseract.js';

export interface DocumentScriptRead {text: string; confidence: number}
export type DocumentScriptRecognizer = (box: Bbox, scale: 2 | 4) => Promise<DocumentScriptRead>;
interface ScriptGroup {word: Word; first: number; end: number; box: Bbox; kind: 'sup' | 'sub'}
interface LinePlan {line: Line; offsets: number[]; groups: ScriptGroup[]}
const maximumGroups = 128;
const coordinates = ['x0', 'y0', 'x1', 'y1'] as const;
const validBox = (box: Bbox | undefined): box is Bbox => Boolean(box && coordinates.every(key => Number.isFinite(box[key])) && box.x1 > box.x0 && box.y1 > box.y0);
const contains = (outer: Bbox, inner: Bbox) => outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
const height = (box: Bbox) => box.y1 - box.y0;
const isBase = (symbol: OcrSymbol, baseline: number, row: number) => /^[\p{L}\p{N})\]}]$/u.test(symbol.text)
    && height(symbol.bbox) >= row * .38 && Math.abs(symbol.bbox.y1 - baseline) <= row * .18;

/** 墨迹框必须与正文基线明显分离；普通度数/撇号通常小于正文的一半，不作为数字脚标重识别。 */
function scriptKind(symbol: OcrSymbol, base: OcrSymbol, baseline: number, continuation = false): ScriptGroup['kind'] | undefined {
    const size = height(base.bbox), box = symbol.bbox;
    if (!/^[\p{L}\p{N}%°º*+\-−–—]$/u.test(symbol.text)) return;
    if (height(box) < size * .45 || height(box) > size * .9 || box.x0 < base.bbox.x1 || !continuation && box.x0 - base.bbox.x1 > size * 1.5) return;
    if (box.y1 < baseline - size * .25) return 'sup';
    if (box.y0 > base.bbox.y0 + size * .4 && box.y1 > baseline + size * .12) return 'sub';
}

function planLine(line: Line): LinePlan | undefined {
    const row = line.rowAttributes?.rowHeight, baseline = line.baseline;
    if (!row || !baseline || !validBox(line.bbox) || ![row, baseline.y0, baseline.y1].every(Number.isFinite)
        || row <= 0 || Math.abs(baseline.y0 - baseline.y1) > row * .2 || !line.words?.length) return;
    const y = (baseline.y0 + baseline.y1) / 2;
    const offsets: number[] = [], groups: ScriptGroup[] = [];
    let cursor = 0;
    for (const word of line.words) {
        const offset = line.text.indexOf(word.text, cursor);
        // 不能把同一行中另一次出现的相同数字当成本词，或丢掉引擎行正文中未对应到词的部分。
        if (!word.text || offset < cursor || line.text.slice(cursor, offset).trim() || !validBox(word.bbox) || !contains(line.bbox, word.bbox)) return;
        offsets.push(offset); cursor = offset + word.text.length;
        const symbols = word.symbols;
        if (!symbols?.length || symbols.map(symbol => symbol.text).join('') !== word.text
            || symbols.some((symbol, index) => !validBox(symbol.bbox) || !contains(word.bbox, symbol.bbox)
                || index > 0 && symbol.bbox.x0 < symbols[index - 1].bbox.x0)) continue;
        let base: OcrSymbol | undefined;
        for (let index = 0; index < symbols.length; index++) {
            const symbol = symbols[index];
            if (isBase(symbol, y, row)) {base = symbol; continue;}
            let kind = base && scriptKind(symbol, base, y);
            // min 等小号字母可能整体误读为 ™ 和引号，单个符号本身不足以推断指数。
            if (!kind && base && index === 1 && /^\p{L}$/u.test(base.text)
                && Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence < 75) {
                const size = height(base.bbox), box = {...symbol.bbox};
                let end = index, previousEnd = base.bbox.x1;
                while (end < symbols.length) {
                    const next = symbols[end], b = next.bbox;
                    if (!/^[™®℠"”'’]$/u.test(next.text) || height(b) < size * .45 || height(b) > size * .9
                        || b.y1 >= y - size * .25 || b.x0 < previousEnd || b.x0 - previousEnd > size * .6) break;
                    box.x1 = b.x1; box.y0 = Math.min(box.y0, b.y0); box.y1 = Math.max(box.y1, b.y1);
                    previousEnd = b.x1; end++;
                }
                if (end - index >= 2) {groups.push({word, first: index, end, box, kind: 'sup'}); index = end - 1; continue;}
            }
            if (!kind && base && /^[+\-−–—]$/u.test(symbol.text) && index + 1 < symbols.length) {
                const next = symbols[index + 1], nextKind = scriptKind(next, base, y, true);
                const center = (symbol.bbox.y0 + symbol.bbox.y1) / 2, size = height(base.bbox);
                if (nextKind && symbol.bbox.x0 >= base.bbox.x1 && symbol.bbox.x0 - base.bbox.x1 <= size * 1.5
                    && next.bbox.x0 - symbol.bbox.x1 <= size * .6 && center >= next.bbox.y0 && center <= next.bbox.y1
                    && (nextKind === 'sup' ? center < base.bbox.y0 + size * .3 : center > y - size * .15)) kind = nextKind;
            }
            if (!kind) {base = undefined; continue;}
            const first = index, box = {...symbol.bbox};
            while (index + 1 < symbols.length) {
                const next = symbols[index + 1];
                if (scriptKind(next, base!, y, true) !== kind || next.bbox.x0 - box.x1 > height(base!.bbox) * .6) break;
                index++; box.x1 = next.bbox.x1; box.y0 = Math.min(box.y0, next.bbox.y0); box.y1 = Math.max(box.y1, next.bbox.y1);
            }
            groups.push({word, first, end: index + 1, box, kind});
        }
    }
    if (line.text.slice(cursor).trim() || !groups.length) return;
    return {line, offsets, groups};
}

function confirmedValue(first: DocumentScriptRead, second: DocumentScriptRead, kind: ScriptGroup['kind']): string | undefined {
    const a = first.text.trim().replace(/^[−–—]/u, '-'), b = second.text.trim().replace(/^[−–—]/u, '-');
    if (a !== b || !/^[+\-−]?\d{1,6}$/u.test(a) || ![first.confidence, second.confidence].every(value => Number.isFinite(value) && value >= 85 && value <= 100)) return;
    const alphabet = kind === 'sup' ? '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻' : '₀₁₂₃₄₅₆₇₈₉₊₋₋';
    return Array.from(a, value => alphabet['0123456789+-−'.indexOf(value)]).join('');
}

/** 两个局部视图的内容与原始字形位置同时成立才提交；任一取消/失败都不泄露半改写结果。 */
export async function recoverDocumentOcrScripts(blocks: Block[] | null, recognize: DocumentScriptRecognizer, signal?: AbortSignal): Promise<{blocks: Block[] | null; unresolved: Bbox[]}> {
    signal?.throwIfAborted();
    const plans = (blocks ?? []).flatMap(block => (block.paragraphs ?? []).flatMap(paragraph => (paragraph.lines ?? []).flatMap(line => {
        const plan = planLine(line); return plan ? [plan] : [];
    })));
    const changed = new Map<Line, Line>(), unresolved: Bbox[] = [];
    let attempted = 0;
    for (const {line, offsets, groups} of plans) {
        const replacements = new Map<Word, Map<number, {end: number; value: string; confidence: number}>>();
        for (const group of groups) {
            signal?.throwIfAborted();
            if (attempted++ >= maximumGroups) {unresolved.push(group.box); continue;}
            const original = group.word.symbols.slice(group.first, group.end).map(symbol => symbol.text).join('');
            // 字母脚标可能是合法变量，不能凭数字识别偏好把 n/o 等变成数字。
            if (!/^[0-9%°º*+\-−–—]+$/u.test(original)) {unresolved.push(group.box); continue;}
            const first = await recognize({...group.box}, 2);
            signal?.throwIfAborted();
            const second = await recognize({...group.box}, 4);
            signal?.throwIfAborted();
            const value = confirmedValue(first, second, group.kind);
            // 圆形度数与数字零的局部像素可能相同；一致读成零也不足以证明它是指数。
            if (!value || /^[°º]+$/u.test(original) && /^[⁰₀]+$/u.test(value)) {unresolved.push(group.box); continue;}
            let wordChanges = replacements.get(group.word);
            if (!wordChanges) replacements.set(group.word, wordChanges = new Map());
            wordChanges.set(group.first, {end: group.end, value, confidence: Math.min(first.confidence, second.confidence)});
        }
        if (!replacements.size) continue;
        let cursor = 0, text = '';
        const words = line.words.map((word, index) => {
            text += line.text.slice(cursor, offsets[index]); cursor = offsets[index] + word.text.length;
            const edits = replacements.get(word);
            if (!edits) {text += word.text; return word;}
            let value = '', confidence = 100;
            for (let symbol = 0; symbol < word.symbols.length; symbol++) {
                const edit = edits.get(symbol);
                if (edit) {value += edit.value; confidence = Math.min(confidence, edit.confidence); symbol = edit.end - 1;}
                else {value += word.symbols[symbol].text; confidence = Math.min(confidence, word.symbols[symbol].confidence);}
            }
            // 当引擎把一个含指数的整词判为低分时，只有全部字形都已有可信证据才提升可用性。
            const allConfirmed = groups.filter(group => group.word === word).every(group => edits.has(group.first));
            const next = {...word, text: value, confidence: allConfirmed && Number.isFinite(confidence) && confidence >= 85 ? Math.max(word.confidence, confidence) : word.confidence};
            if (!Number.isFinite(next.confidence) || next.confidence < 25) unresolved.push({...word.bbox});
            text += value; return next;
        });
        text += line.text.slice(cursor);
        changed.set(line, {...line, text, words});
    }
    signal?.throwIfAborted();
    return {blocks: changed.size ? blocks!.map(block => ({...block, paragraphs: (block.paragraphs ?? []).map(paragraph => ({...paragraph,
        lines: (paragraph.lines ?? []).map(line => changed.get(line) ?? line),
    }))})) : blocks, unresolved};
}
