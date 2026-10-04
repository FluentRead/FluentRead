/**
 * @file src/features/image-translation/paragraphs.ts
 * 文件职责：将普通图片的 OCR 物理行恢复成可整段翻译与回填的文本区域。
 * 主要内容：按行距、字号、对齐和遮挡关系合并连续正文，保留标题、列表、栏位及竖排边界；连接换行文字并保留原始擦除框、字号上限和对齐方式。
 * 模块边界：只处理原图坐标与识别文本，不运行 OCR、不调用翻译或 Canvas；漫画仍使用其气泡分组策略。
 */
import type {OcrLine} from '@/src/shared/image/types';

export interface ImageTextRegion extends OcrLine {
    sourceBoxes?: OcrLine['bbox'][];
    /** 典型源行字形高度，用于限制译文字号；不是合并段落的总高度。 */
    fontSize?: number;
    textAlign?: 'left' | 'center' | 'right';
}

const height = (line: ImageTextRegion) => line.fontSize ?? line.bbox.y1 - line.bbox.y0;
const listStart = /^(?:[•●▪‣]|\d+[.)、]\s*|[-–—]\s|[A-Za-z][.)]\s)/u;

function union(boxes: OcrLine['bbox'][]): OcrLine['bbox'] {
    return {x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
        x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1))};
}

function alignment(lines: ImageTextRegion[]): ImageTextRegion['textAlign'] | undefined {
    const tolerance = Math.min(...lines.map(height)) * 0.8;
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    if (spread(lines.map(line => line.bbox.x0)) <= tolerance) return 'left';
    if (spread(lines.map(line => line.bbox.x1)) <= tolerance) return 'right';
    if (spread(lines.map(line => (line.bbox.x0 + line.bbox.x1) / 2)) <= tolerance) return 'center';
    return undefined;
}

function continues(members: ImageTextRegion[], next: ImageTextRegion): boolean {
    const previous = members[members.length - 1];
    if (next.vertical || next.sourceBoxes || listStart.test(next.text)) return false;
    const sizes = [...members, next].map(height), small = Math.min(...sizes);
    if (Math.max(...sizes) > small * 1.3) return false;
    const gap = next.bbox.y0 - previous.bbox.y1;
    // 只连接下一物理行；同一行的控件、明显段间空白和重叠识别不参与合段。
    if (gap < -small * 0.15 || gap > small * 0.65
        || next.bbox.y0 - previous.bbox.y0 < small * 0.7) return false;
    return alignment([...members, next]) !== undefined;
}

function joinLines(previous: string, next: string): string {
    if (!previous) return next;
    if (previous.endsWith('\u00ad')) return previous.slice(0, -1) + next;
    // 硬连字符可能属于复合词，保留它；只有明确的软连字符才可删除。
    if (/\p{L}-$/u.test(previous) && /^\p{L}/u.test(next)) return previous + next;
    const cjk = /[\u2e80-\u9fff\uac00-\ud7af]$/u.test(previous) && /^[\u2e80-\u9fff\uac00-\ud7af]/u.test(next);
    const punctuation = /^[,.;:!?%。，、！？：；)\]}’”]/u.test(next) || /[([{‘“]$/u.test(previous);
    return previous + (cjk || punctuation ? '' : ' ') + next;
}

/** 未合并区域保持原契约；合并区域只扩大排版范围，擦除仍使用逐行源框。 */
export function groupImageParagraphs(input: ImageTextRegion[]): ImageTextRegion[] {
    const lines = [...input].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const used = new Set<ImageTextRegion>();
    const result: ImageTextRegion[] = [];
    for (const first of lines) {
        if (used.has(first)) continue;
        used.add(first);
        const members = [first];
        const memberSet = new Set(members);
        if (!first.vertical && !first.sourceBoxes) {
            for (const next of lines) {
                if (used.has(next) || !continues(members, next)) continue;
                const bbox = union([...members, next].map(line => line.bbox));
                // 合并矩形内存在其他栏、标签或识别片段时，不跨过它回填正文。
                const obstructed = lines.some(other => other !== next && !memberSet.has(other)
                    && other.bbox.x0 < bbox.x1 && other.bbox.x1 > bbox.x0
                    && other.bbox.y0 < bbox.y1 && other.bbox.y1 > bbox.y0);
                if (obstructed) continue;
                used.add(next); members.push(next); memberSet.add(next);
            }
        }
        if (members.length === 1) {result.push(first); continue;}
        const sizes = members.map(height).sort((a, b) => a - b);
        result.push({text: members.map(line => line.text).reduce(joinLines, ''),
            bbox: union(members.map(line => line.bbox)), sourceBoxes: members.map(line => ({...line.bbox})),
            fontSize: sizes[Math.floor(sizes.length / 2)], textAlign: alignment(members)});
    }
    return result;
}
