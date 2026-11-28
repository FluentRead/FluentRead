/**
 * @file src/features/image-translation/labelContext.ts
 * 文件职责：用原图行框判断普通图片短标签能否借用前后同栏或同弹窗相邻标签的文字语境。
 * 主要内容：识别两类安全语境——夹在连续同栏横排行之间的三至八词短标签，以及界面对话框中同列、同行或双栏表单连续的一至八词短标签组，返回标签在待翻译数组中的位置。
 * 模块边界：不改变 OCR 文本、排版区域或翻译请求；坐标只在本地参与判断。
 */
import type {ImageTextRegion} from './paragraphs';

const MAX_SHORT_LABEL_LENGTH = 52;
const PROSE_FLANKED_LABEL_PATTERN = /^(?:\p{L}+ ){2,7}\p{L}+$/u;
const UI_SHORT_LABEL_PATTERN = /^\p{L}+(?: \p{L}+){0,7}$/u;

function isIndependentHorizontalLine(line: ImageTextRegion): boolean {
    return !line.vertical && !line.quarterTurn && (line.sourceBoxes?.length ?? 0) <= 1;
}

function hasValidBox(line: ImageTextRegion): boolean {
    const {x0, y0, x1, y1} = line.bbox;
    return Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)
        && x1 > x0 && y1 > y0;
}

function isShortUiLabel(line: ImageTextRegion): boolean {
    return isIndependentHorizontalLine(line) && hasValidBox(line)
        && line.text.length <= MAX_SHORT_LABEL_LENGTH && UI_SHORT_LABEL_PATTERN.test(line.text);
}

function compatibleHeight(first: ImageTextRegion, second: ImageTextRegion): number {
    const a = first.bbox.y1 - first.bbox.y0;
    const b = second.bbox.y1 - second.bbox.y0;
    const size = Math.min(a, b);
    return Math.max(a, b) <= size * 1.6 ? size : 0;
}

function isStackedColumnPair(above: ImageTextRegion, below: ImageTextRegion): boolean {
    const size = compatibleHeight(above, below);
    if (!size) return false;
    const gapY = below.bbox.y0 - above.bbox.y1;
    if (gapY < 0 || gapY > size * 2.5) return false;
    return Math.abs(above.bbox.x0 - below.bbox.x0) <= size * 0.6
        || Math.abs(above.bbox.x1 - below.bbox.x1) <= size * 0.6;
}

function isSameRowPair(first: ImageTextRegion, second: ImageTextRegion): boolean {
    const size = compatibleHeight(first, second);
    if (!size) return false;
    const midA = (first.bbox.y0 + first.bbox.y1) / 2;
    const midB = (second.bbox.y0 + second.bbox.y1) / 2;
    if (Math.abs(midA - midB) > size * 0.5) return false;
    const gapX = Math.max(second.bbox.x0 - first.bbox.x1, first.bbox.x0 - second.bbox.x1);
    return gapX >= 0 && gapX <= size * 20;
}

export function getAlignedImageLabelSlots(
    regions: readonly {line: ImageTextRegion; index: number}[],
): number[] {
    const slotSet = new Set<number>();
    for (let slot = 1; slot < regions.length - 1; slot++) {
        const {line: label, index} = regions[slot];
        if (label.text.length > MAX_SHORT_LABEL_LENGTH || !PROSE_FLANKED_LABEL_PATTERN.test(label.text)) continue;
        const {line: previous, index: previousIndex} = regions[slot - 1];
        const {line: next, index: nextIndex} = regions[slot + 1];
        if (previousIndex !== index - 1 || nextIndex !== index + 1) continue;
        if ([previous, label, next].some(line => !isIndependentHorizontalLine(line))) continue;
        const boxes = [previous.bbox, label.bbox, next.bbox];
        const heights = boxes.map(box => box.y1 - box.y0);
        const size = Math.min(...heights);
        const lefts = boxes.map(box => box.x0);
        const gaps = [label.bbox.y0 - previous.bbox.y1, next.bbox.y0 - label.bbox.y1];
        if (Number.isFinite(size) && size > 0 && Math.max(...heights) <= size * 1.45
            && Math.max(...lefts) - Math.min(...lefts) <= size * 0.4
            && gaps.every(gap => gap >= 0 && gap <= size * 1.8)) {
            slotSet.add(slot);
        }
    }
    for (let slot = 0; slot < regions.length - 1; slot++) {
        const current = regions[slot];
        const next = regions[slot + 1];
        if (next.index !== current.index + 1) continue;
        if (!isShortUiLabel(current.line) || !isShortUiLabel(next.line)) continue;
        const sameRow = isSameRowPair(current.line, next.line);
        const stacked = !sameRow && isStackedColumnPair(current.line, next.line);
        const previous = slot > 0 ? regions[slot - 1] : undefined;
        const continuesTwoColumnForm = !sameRow && !stacked && previous !== undefined
            && current.index === previous.index + 1
            && isShortUiLabel(previous.line)
            && isSameRowPair(previous.line, current.line)
            && isStackedColumnPair(previous.line, next.line);
        if (sameRow || stacked || continuesTwoColumnForm) {
            slotSet.add(slot);
            slotSet.add(slot + 1);
        }
    }
    return [...slotSet].sort((a, b) => a - b);
}
