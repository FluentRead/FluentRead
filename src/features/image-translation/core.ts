/**
 * @file src/features/image-translation/core.ts
 * 文件职责：提供图片翻译可复用的纯数据算法，用于选择真正发生变化的译文、确定 OCR 语言组合并清理 OCR 行数据。
 * 主要内容：从 shared/image 复用 OcrLine 类型，筛选有效译文、规划图片与圈选各自的有界 OCR 尺寸及边框，映回原图坐标，规范化词组、标点和置信度，按基线方向区分横竖排并合并同一气泡的竖列，避免噪声进入翻译与绘制。
 * 模块边界：该模块不接触 Canvas、Tesseract、网络或浏览器消息；OCR 执行归 ocrRuntime，像素修补与文本绘制归 services，页面展示归 content/runtime。
 */
import { getRequiredImageOcrLanguages, type ImageOcrLanguageCode } from './ocrLanguages';
import type { OcrLine } from '@/src/shared/image/types';

export type { OcrLine } from '@/src/shared/image/types';

function normalizeTranslationComparison(text: string): string {
    return text
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 只保留实际发生变化的 OCR 行。
 * 这样中文原文、品牌名或微软原样返回的内容不会被重新绘制成一张
 * 看似“已翻译”但实际没有变化的覆盖层。
 */
export function selectChangedTranslations<T extends OcrLine>(lines: T[], translations: string[]): T[] {
    return lines.flatMap((line, index) => {
        const text = translations[index]?.trim() || line.text;
        return normalizeTranslationComparison(text) === normalizeTranslationComparison(line.text)
            ? []
            : [{ ...line, text }];
    });
}

/** 限制识别内存和耗时；只缩小超大图片，不插值放大小字或更改最终图片分辨率。 */
export function getOcrImageSize(width: number, height: number): {width: number; height: number} {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('图片尺寸无效');
    }
    const ratio = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(6_000_000 / width / height));
    return {width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio))};
}

/**
 * 圈选的紧贴文字小图最多放大两倍，并预留 10px 白边供分割识别。
 * 白边计入最长边和像素预算；普通图片继续使用既有的只降采样策略。
 * 这些是有界输入策略，不代表任何语言或图片的准确率保证。
 */
export function getAreaOcrImageSize(width: number, height: number): {width: number; height: number; padding: number} {
    getOcrImageSize(width, height);
    const scale = width <= 1000 && height <= 500 ? 2 : 1;
    const ratio = Math.min(scale, 4076 / Math.max(width, height), Math.sqrt(5_800_000 / width / height));
    return {
        width: Math.max(1, Math.floor(width * ratio)),
        height: Math.max(1, Math.floor(height * ratio)),
        padding: 10,
    };
}

/** 将降采样后的识别框映回原始像素，夹紧边界，避免擦除与文字替换偏移。 */
export function restoreOcrLineCoordinates(
    lines: OcrLine[],
    sourceWidth: number,
    sourceHeight: number,
    ocrWidth: number,
    ocrHeight: number,
    padding = 0,
): OcrLine[] {
    return lines.flatMap(line => {
        const bbox = {
            x0: Math.max(0, Math.floor((line.bbox.x0 - padding) * sourceWidth / ocrWidth)),
            y0: Math.max(0, Math.floor((line.bbox.y0 - padding) * sourceHeight / ocrHeight)),
            x1: Math.min(sourceWidth, Math.ceil((line.bbox.x1 - padding) * sourceWidth / ocrWidth)),
            y1: Math.min(sourceHeight, Math.ceil((line.bbox.y1 - padding) * sourceHeight / ocrHeight)),
        };
        return isValidOcrBox(bbox) ? [{...line, bbox}] : [];
    });
}

function isValidOcrBox(bbox: OcrLine['bbox']): boolean {
    return [bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
        && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0;
}

type OcrBox = OcrLine['bbox'];
type OcrAxis = {start: 'x0' | 'y0'; end: 'x1' | 'y1'};
const X_AXIS: OcrAxis = {start: 'x0', end: 'x1'};
const Y_AXIS: OcrAxis = {start: 'y0', end: 'y1'};

function getAxisSize(bbox: OcrBox, axis: OcrAxis): number {
    return bbox[axis.end] - bbox[axis.start];
}

/** 两个框在某一轴上的重叠长度；为负时表示间距。 */
function getAxisOverlap(left: OcrBox, right: OcrBox, axis: OcrAxis): number {
    return Math.min(left[axis.end], right[axis.end]) - Math.max(left[axis.start], right[axis.start]);
}

/** Tesseract 的基线沿书写方向延伸：横排近乎水平，竖排模型识别出的列近乎垂直。 */
function isVerticalOcrLine(baseline: OcrBox | null | undefined): boolean {
    if (!baseline || ![baseline.x0, baseline.y0, baseline.x1, baseline.y1].every(Number.isFinite)) return false;
    return Math.abs(baseline.y1 - baseline.y0) > Math.abs(baseline.x1 - baseline.x0) * 2;
}

function unionOcrBoxes(boxes: OcrBox[]): OcrBox {
    return boxes.reduce((result, bbox) => ({
        x0: Math.min(result.x0, bbox.x0),
        y0: Math.min(result.y0, bbox.y0),
        x1: Math.max(result.x1, bbox.x1),
        y1: Math.max(result.y1, bbox.y1),
    }), {...boxes[0]});
}

/** 同列片段横向重叠且上下相距不超过一个半字宽；相邻列相距不超过一个列宽且纵向有实质重叠。 */
function areAdjacentVerticalColumns(left: OcrBox, right: OcrBox): boolean {
    const thickness = Math.max(getAxisSize(left, X_AXIS), getAxisSize(right, X_AXIS));
    const horizontalOverlap = getAxisOverlap(left, right, X_AXIS);
    const verticalOverlap = getAxisOverlap(left, right, Y_AXIS);
    if (horizontalOverlap >= Math.min(getAxisSize(left, X_AXIS), getAxisSize(right, X_AXIS)) * 0.35) {
        return -verticalOverlap <= thickness * 1.5;
    }
    return -horizontalOverlap <= thickness
        && verticalOverlap >= Math.min(getAxisSize(left, Y_AXIS), getAxisSize(right, Y_AXIS)) * 0.3;
}

function joinVerticalColumns(members: OcrLine[]): OcrLine {
    const columns: OcrLine[][] = [];
    // 从右到左建列：中心更靠右的片段先成列，横向重叠的后续片段并入同一列。
    [...members].sort((left, right) => (right.bbox.x0 + right.bbox.x1) - (left.bbox.x0 + left.bbox.x1)).forEach(member => {
        const column = columns.find(candidate => candidate.some(part => getAxisOverlap(part.bbox, member.bbox, X_AXIS)
            >= Math.min(getAxisSize(part.bbox, X_AXIS), getAxisSize(member.bbox, X_AXIS)) * 0.35));
        if (column) column.push(member);
        else columns.push([member]);
    });
    const ordered = columns.flatMap(column => column.sort((left, right) => left.bbox.y0 - right.bbox.y0));
    return {
        text: ordered.map(line => line.text).reduce(joinOcrWords, ''),
        bbox: unionOcrBoxes(ordered.map(line => line.bbox)),
        vertical: true,
    };
}

/**
 * 漫画气泡的一句话常跨多列；逐列翻译会拆散语义，逐列绘制也只有一个字宽。
 * 相邻竖列与同列片段合成一个区域，放在其首个成员原来的位置，横排行保持原样和顺序。
 */
function mergeVerticalOcrColumns(lines: OcrLine[]): OcrLine[] {
    const vertical = lines.flatMap((line, index) => line.vertical ? [index] : []);
    if (vertical.length < 2) return lines;
    const parent = new Map(vertical.map(index => [index, index]));
    const find = (index: number): number => {
        let root = index;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
    };
    vertical.forEach((left, position) => vertical.slice(position + 1).forEach(right => {
        if (!areAdjacentVerticalColumns(lines[left].bbox, lines[right].bbox)) return;
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
    }));
    const groups = new Map<number, OcrLine[]>();
    vertical.forEach(index => {
        const root = find(index);
        groups.set(root, [...groups.get(root) || [], lines[index]]);
    });
    return lines.flatMap((line, index) => {
        if (!line.vertical) return [line];
        const group = groups.get(index);
        if (!group) return [];
        return [group.length === 1 ? line : joinVerticalColumns(group)];
    });
}

function joinOcrWords(previous: string, next: string): string {
    if (!previous) return next;
    const joinsCjk = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(previous)
        || /^[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(next);
    const joinsPunctuation = /^[,.;:!?%\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b)\]}’”]/u.test(next)
        || /[([{\u2018\u201c]$/u.test(previous);
    return joinsCjk || joinsPunctuation ? `${previous}${next}` : `${previous} ${next}`;
}

export function getOcrLanguages(sourceLanguage: string): ImageOcrLanguageCode[] {
    return getRequiredImageOcrLanguages(sourceLanguage);
}

export function normalizeOcrLines(
    blocks: Array<{
        paragraphs?: Array<{
            lines?: Array<{
                text: string;
                confidence?: number;
                bbox: OcrLine['bbox'];
                baseline?: OcrLine['bbox'] | null;
                words?: Array<{ text: string; confidence?: number; bbox: OcrLine['bbox'] }>;
            }>;
        }>;
    }> | null | undefined,
): OcrLine[] {
    if (!blocks) return [];

    const normalized: OcrLine[] = [];
    blocks.flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []).forEach(line => {
        // 竖排行沿 y 轴书写：词按 y0 排序，并以列宽判断同列与间距；横排保持原有 x 轴规则。
        const vertical = isVerticalOcrLine(line.baseline);
        const [main, cross] = vertical ? [Y_AXIS, X_AXIS] : [X_AXIS, Y_AXIS];
        const orientation = vertical ? {vertical: true as const} : {};
        const words = (line.words || [])
            .map(word => ({
                text: word.text.replace(/[\s\u3000]+/g, ' ').trim(),
                confidence: word.confidence ?? 100,
                bbox: word.bbox,
            }))
            .filter(word => word.text.length > 0 && Number.isFinite(word.confidence) && word.confidence >= 25
                && isValidOcrBox(word.bbox))
            .sort((left, right) => left.bbox[main.start] - right.bbox[main.start]);

        if (words.length === 0) {
            // 有 word 数据却全部被过滤时，整行文本来自同一批噪声，不能再次回退复活。
            if (line.words?.length) return;
            const text = line.text.replace(/[\s\u3000]+/g, ' ').trim();
            const confidence = line.confidence ?? 100;
            if (text && Number.isFinite(confidence) && confidence >= 25 && isValidOcrBox(line.bbox)) {
                normalized.push({ text, bbox: line.bbox, ...orientation });
            }
            return;
        }

        let current = [words[0]];
        const flush = () => {
            const bbox = unionOcrBoxes(current.map(word => word.bbox));
            const text = current.map(word => word.text).reduce(joinOcrWords, '');
            if (text) normalized.push({ text, bbox, ...orientation });
        };

        for (let index = 1; index < words.length; index += 1) {
            const previous = current[current.length - 1];
            const next = words[index];
            const previousThickness = getAxisSize(previous.bbox, cross);
            const crossOverlap = getAxisOverlap(previous.bbox, next.bbox, cross);
            const gap = next.bbox[main.start] - previous.bbox[main.end];
            const sameLine = crossOverlap >= Math.min(previousThickness, getAxisSize(next.bbox, cross)) * 0.35;
            // 英文单词间距可能接近一个字高；同一 OCR 行内合并，跨控件的大间距仍保持分开。
            if (sameLine && gap <= Math.max(6, previousThickness * 4)) {
                current.push(next);
            } else {
                flush();
                current = [next];
            }
        }
        flush();
    });
    // 相同文字且几乎完全重叠才视为重复检测；不同位置的按钮、数字和重复行必须保留。
    const seen = new Map<string, OcrLine[]>();
    const unique = normalized.filter(line => {
        const key = `${line.vertical ? 'vertical' : 'horizontal'}\0${line.text}`;
        const candidates = seen.get(key) ?? [];
        const duplicate = candidates.some(previous => {
            const intersection = Math.max(0, getAxisOverlap(previous.bbox, line.bbox, X_AXIS))
                * Math.max(0, getAxisOverlap(previous.bbox, line.bbox, Y_AXIS));
            const area = (box: OcrBox) => getAxisSize(box, X_AXIS) * getAxisSize(box, Y_AXIS);
            return intersection / (area(previous.bbox) + area(line.bbox) - intersection) >= 0.9;
        });
        if (!duplicate) {candidates.push(line); seen.set(key, candidates);}
        return !duplicate;
    });
    return mergeVerticalOcrColumns(unique);
}
