/**
 * @file src/features/image-translation/paragraphs.ts
 * 文件职责：将普通图片的 OCR 物理行恢复成可整段翻译与回填的文本区域。
 * 主要内容：按行距、字号、对齐和遮挡关系合并连续正文；竖排以从右到左的列序复用相同的邻接与遮挡约束，保留逐列擦除框；大输入首次尝试合段时建立有界深度的遮挡索引，暂时排除当前段成员并在结束后恢复，跳过无关区域及成员子树；保留标题、列表、栏位边界、原始擦除框与字号上限，并按完整 Unicode 码点衔接两侧 CJK 续行。
 * 模块边界：只处理原图坐标与识别文本，不运行 OCR、不调用翻译或 Canvas；漫画仍使用其气泡分组策略。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {endsEastAsianText, startsEastAsianText} from './textBoundary';
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
function extend(current: Metrics, line: ImageTextRegion, size: number): Metrics {
    const left = line.bbox.x0, right = line.bbox.x1, center = (left + right) / 2;
    return { minHeight: Math.min(current.minHeight, size), maxHeight: Math.max(current.maxHeight, size),
        minLeft: Math.min(current.minLeft, left), maxLeft: Math.max(current.maxLeft, left),
        minRight: Math.min(current.minRight, right), maxRight: Math.max(current.maxRight, right),
        minCenter: Math.min(current.minCenter, center), maxCenter: Math.max(current.maxCenter, center) };
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
    const size = height(next), small = Math.min(state.minHeight, size);
    if (Math.max(state.maxHeight, size) > small * 1.3)
        return;
    const gap = next.bbox.y0 - previous.bbox.y1;
    // 只连接下一物理行；同一行的控件、明显段间空白和重叠识别不参与合段。
    if (gap < -small * 0.15 || gap > small * 0.65
        || next.bbox.y0 - previous.bbox.y0 < small * 0.7)
        return;
    // 同行控件和不连续行先退出，不为无法合段的标签分配对齐统计对象。
    const proposed = extend(state, next, size);
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
    const cjk = endsEastAsianText(previous) && startsEastAsianText(next);
    const punctuation = /^[,.;:!?%。，、！？：；)\]}’”]/u.test(next) || /[([{‘“]$/u.test(previous);
    return previous + (cjk || punctuation ? '' : ' ') + next;
}

interface ObstructionNode {
    bbox: OcrLine['bbox'];
    count: number;
    parent?: ObstructionNode;
    left?: ObstructionNode;
    right?: ObstructionNode;
}

/** 叶子保持源框，父框只包围参与遮挡的区域；已使用的其他段和重复对象仍保留原语义。 */
function createObstructionIndex(lines: ImageTextRegion[]) {
    const leaves = new Map<ImageTextRegion, ObstructionNode[]>();
    function build(start: number, end: number): ObstructionNode {
        if (end - start === 1) {
            const region = lines[start];
            const node = {bbox: region.bbox, count: 1};
            const occurrences = leaves.get(region) ?? [];
            occurrences.push(node);
            leaves.set(region, occurrences);
            return node;
        }
        const middle = Math.floor((start + end) / 2);
        const left = build(start, middle), right = build(middle, end);
        const node = {bbox: union(left.bbox, right.bbox), count: left.count + right.count, left, right};
        left.parent = right.parent = node;
        return node;
    }
    const root = build(0, lines.length);
    function setIncluded(region: ImageTextRegion, included: boolean): void {
        for (const leaf of leaves.get(region)!) {
            if (leaf.count === Number(included)) continue;
            for (let node: ObstructionNode | undefined = leaf; node; node = node.parent) {
                node.count += included ? 1 : -1;
                if (node.left) {
                    // 暂时排除的一栏不能继续扩大父框，否则相邻栏会让查询仍遍历全部成员。
                    const a = node.left.count ? node.left.bbox : node.right!.bbox;
                    const b = node.right!.count ? node.right!.bbox : a;
                    node.bbox.x0 = Math.min(a.x0, b.x0);
                    node.bbox.y0 = Math.min(a.y0, b.y0);
                    node.bbox.x1 = Math.max(a.x1, b.x1);
                    node.bbox.y1 = Math.max(a.y1, b.y1);
                }
            }
        }
    }
    function intersects(node: ObstructionNode, box: OcrLine['bbox']): boolean {
        const b = node.bbox;
        if (!node.count || b.x0 >= box.x1 || b.x1 <= box.x0 || b.y0 >= box.y1 || b.y1 <= box.y0) return false;
        if (node.left) return intersects(node.left, box) || intersects(node.right!, box);
        // 叶子保留严格比较，非有限坐标不能因父节点剪枝失效而成为有效遮挡。
        return b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0;
    }
    return {setIncluded, intersects: (box: OcrLine['bbox']) => intersects(root, box)};
}

/** 未合并区域保持原契约；合并区域只扩大排版范围，擦除仍使用逐行源框。 */
function groupHorizontalParagraphs(input: ImageTextRegion[]): ImageTextRegion[] {
    const lines = [...input].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const used = new Set<ImageTextRegion>();
    const result: ImageTextRegion[] = [];
    let obstructionIndex: ReturnType<typeof createObstructionIndex> | undefined;
    for (let index = 0; index < lines.length; index++) {
        const first = lines[index];
        if (used.has(first))
            continue;
        used.add(first);
        const members = [first];
        const memberSet = lines.length < 64 ? new Set(members) : undefined;
        let state = metrics(first), bbox = first.bbox;
        if (!first.vertical && !first.sourceBoxes) {
            obstructionIndex?.setIncluded(first, false);
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
                // 小图直接扫描；分散标签没有合段候选时不构建索引，避免额外分配。
                if (!obstructionIndex && lines.length >= 64) {
                    obstructionIndex = createObstructionIndex(lines);
                    for (const member of members) obstructionIndex.setIncluded(member, false);
                }
                obstructionIndex?.setIncluded(next, false);
                // 合并矩形内存在其他栏、标签或识别片段时，不跨过它回填正文。
                const obstructed = obstructionIndex ? obstructionIndex.intersects(candidateBox)
                    : lines.some(other => other !== next && !memberSet!.has(other)
                    && other.bbox.x0 < candidateBox.x1 && other.bbox.x1 > candidateBox.x0
                    && other.bbox.y0 < candidateBox.y1 && other.bbox.y1 > candidateBox.y0);
                if (obstructed) {
                    obstructionIndex?.setIncluded(next, true);
                    continue;
                }
                state = proposed;
                bbox = candidateBox;
                used.add(next);
                members.push(next);
                memberSet?.add(next);
            }
        }
        if (obstructionIndex) {
            for (const member of members) obstructionIndex.setIncluded(member, true);
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

/** 将竖列投影为从上到下的物理行：列宽成为字号，原始框仍可无损回映。 */
function projectVerticalBox(box: OcrLine['bbox']): OcrLine['bbox'] {
    return {x0: box.y0, y0: -box.x1, x1: box.y1, y1: -box.x0};
}

function restoreVerticalBox(box: OcrLine['bbox']): OcrLine['bbox'] {
    return {x0: -box.y1, y0: box.x0, x1: -box.y0, y1: box.x1};
}

/** 横排按行、东亚竖排按右到左的列整段翻译；不把另一方向或已合并区域当成续行。 */
export function groupImageParagraphs(input: ImageTextRegion[]): ImageTextRegion[] {
    const horizontal = groupHorizontalParagraphs(input);
    if (horizontal.filter(line => line.vertical && !line.sourceBoxes).length < 2) return horizontal;
    const originals = new Map<ImageTextRegion, ImageTextRegion>();
    const projected = horizontal.map(line => {
        const candidate: ImageTextRegion = {...line, bbox: projectVerticalBox(line.bbox),
            fontSize: line.vertical ? line.fontSize ?? line.bbox.x1 - line.bbox.x0 : line.fontSize,
            // 横排和已合并区域仍是遮挡，不能跨过它们连接竖列。
            vertical: line.vertical ? undefined : true};
        originals.set(candidate, line);
        return candidate;
    });
    return groupHorizontalParagraphs(projected).map(line => originals.get(line) ?? {
        ...line, bbox: restoreVerticalBox(line.bbox),
        sourceBoxes: line.sourceBoxes!.map(restoreVerticalBox), vertical: true as const, textAlign: 'center' as const,
    }).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}
