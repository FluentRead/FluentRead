/**
 * @file src/features/image-translation/paragraphs.ts
 * 文件职责：将普通图片的 OCR 物理行恢复成可整段翻译与回填的文本区域。
 * 主要内容：按行距、字号、对齐和遮挡关系合并连续正文，按纵向邻域扫描候选并增量维护对齐范围，减少候选全图扫描和重复统计；保留标题、列表、栏位及竖排边界、原始擦除框与字号上限。
 * 模块边界：只处理原图坐标与识别文本，不运行 OCR、不调用翻译或 Canvas；漫画仍使用其气泡分组策略。
 */
import type { OcrLine } from '@/src/shared/image/types';
export interface ImageTextRegion extends OcrLine {
    sourceBoxes?: OcrLine['bbox'][];
    /** 典型源行字形高度，用于限制译文字号；不是合并段落的总高度。 */
    fontSize?: number;
    textAlign?: 'left' | 'center' | 'right';
}
const height = (line: ImageTextRegion) => line.fontSize ?? line.bbox.y1 - line.bbox.y0;
const listStart = /^(?:[•●▪‣]|\d+[.)、]\s*|[-–—]\s|[A-Za-z][.)]\s)/u;
function union(a: OcrLine['bbox'], b: OcrLine['bbox']): OcrLine['bbox'] {
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
interface Metrics {
    minHeight: number;
    maxHeight: number;
    minLeft: number;
    maxLeft: number;
    minRight: number;
    maxRight: number;
    minCenter: number;
    maxCenter: number;
}
function metrics(line: ImageTextRegion): Metrics {
    const center = (line.bbox.x0 + line.bbox.x1) / 2, size = height(line);
    return { minHeight: size, maxHeight: size, minLeft: line.bbox.x0, maxLeft: line.bbox.x0,
        minRight: line.bbox.x1, maxRight: line.bbox.x1, minCenter: center, maxCenter: center };
}
function extend(current: Metrics, line: ImageTextRegion): Metrics {
    const next = metrics(line);
    return { minHeight: Math.min(current.minHeight, next.minHeight), maxHeight: Math.max(current.maxHeight, next.maxHeight),
        minLeft: Math.min(current.minLeft, next.minLeft), maxLeft: Math.max(current.maxLeft, next.maxLeft),
        minRight: Math.min(current.minRight, next.minRight), maxRight: Math.max(current.maxRight, next.maxRight),
        minCenter: Math.min(current.minCenter, next.minCenter), maxCenter: Math.max(current.maxCenter, next.maxCenter) };
}
function alignment(state: Metrics): ImageTextRegion['textAlign'] | undefined {
    const tolerance = state.minHeight * 0.8;
    if (state.maxLeft - state.minLeft <= tolerance)
        return 'left';
    if (state.maxRight - state.minRight <= tolerance)
        return 'right';
    if (state.maxCenter - state.minCenter <= tolerance)
        return 'center';
    return undefined;
}
function continues(previous: ImageTextRegion, state: Metrics, next: ImageTextRegion): Metrics | undefined {
    if (next.vertical || next.sourceBoxes || listStart.test(next.text))
        return;
    const proposed = extend(state, next), small = proposed.minHeight;
    if (proposed.maxHeight > small * 1.3)
        return;
    const gap = next.bbox.y0 - previous.bbox.y1;
    // 只连接下一物理行；同一行的控件、明显段间空白和重叠识别不参与合段。
    if (gap < -small * 0.15 || gap > small * 0.65
        || next.bbox.y0 - previous.bbox.y0 < small * 0.7)
        return;
    return alignment(proposed) === undefined ? undefined : proposed;
}
function joinLines(previous: string, next: string): string {
    if (!previous)
        return next;
    if (previous.endsWith('\u00ad'))
        return previous.slice(0, -1) + next;
    // 硬连字符可能属于复合词，保留它；只有明确的软连字符才可删除。
    if (/\p{L}-$/u.test(previous) && /^\p{L}/u.test(next))
        return previous + next;
    const cjk = /[\u2e80-\u9fff\uac00-\ud7af]$/u.test(previous) && /^[\u2e80-\u9fff\uac00-\ud7af]/u.test(next);
    const punctuation = /^[,.;:!?%。，、！？：；)\]}’”]/u.test(next) || /[([{‘“]$/u.test(previous);
    return previous + (cjk || punctuation ? '' : ' ') + next;
}
/** 未合并区域保持原契约；合并区域只扩大排版范围，擦除仍使用逐行源框。 */
export function groupImageParagraphs(input: ImageTextRegion[]): ImageTextRegion[] {
    const lines = [...input].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const used = new Set<ImageTextRegion>();
    const result: ImageTextRegion[] = [];
    for (let index = 0; index < lines.length; index++) {
        const first = lines[index];
        if (used.has(first))
            continue;
        used.add(first);
        const members = [first];
        const memberSet = new Set(members);
        let state = metrics(first), bbox = first.bbox;
        if (!first.vertical && !first.sourceBoxes) {
            for (let cursor = index + 1; cursor < lines.length; cursor++) {
                const next = lines[cursor], previous = members[members.length - 1];
                // 已按 y0 排序，超过当前段落最远行距后所有后续行都不可能连续。
                if (next.bbox.y0 > previous.bbox.y1 + state.minHeight * 0.65)
                    break;
                if (used.has(next))
                    continue;
                const proposed = continues(previous, state, next);
                if (!proposed)
                    continue;
                const candidateBox = union(bbox, next.bbox);
                // 合并矩形内存在其他栏、标签或识别片段时，不跨过它回填正文。
                const obstructed = lines.some(other => other !== next && !memberSet.has(other)
                    && other.bbox.x0 < candidateBox.x1 && other.bbox.x1 > candidateBox.x0
                    && other.bbox.y0 < candidateBox.y1 && other.bbox.y1 > candidateBox.y0);
                if (obstructed)
                    continue;
                state = proposed;
                bbox = candidateBox;
                used.add(next);
                members.push(next);
                memberSet.add(next);
            }
        }
        if (members.length === 1) {
            result.push(first);
            continue;
        }
        const sizes = members.map(height).sort((a, b) => a - b);
        result.push({ text: members.map(line => line.text).reduce(joinLines, ''),
            bbox, sourceBoxes: members.map(line => ({ ...line.bbox })),
            fontSize: sizes[Math.floor(sizes.length / 2)], textAlign: alignment(state) });
    }
    return result;
}
