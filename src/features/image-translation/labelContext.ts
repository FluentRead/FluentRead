/**
 * @file src/features/image-translation/labelContext.ts
 * 文件职责：用原图行框判断普通图片短标签能否借用前后同栏的文字。
 * 主要内容：只选相邻、左对齐、字高相近的三个独立横排区域，返回标签在待翻译数组中的位置。
 * 模块边界：不改变 OCR 文本、排版区域或翻译请求；坐标只在本地参与判断。
 */
import type {ImageTextRegion} from './paragraphs';

export function getAlignedImageLabelSlots(
    regions: readonly {line: ImageTextRegion; index: number}[],
): number[] {
    const slots: number[] = [];
    for (let slot = 1; slot < regions.length - 1; slot++) {
        const {line: label, index} = regions[slot];
        if (label.text.length > 52 || !/^(?:\p{L}+ ){2,7}\p{L}+$/u.test(label.text)) continue;
        const {line: previous, index: previousIndex} = regions[slot - 1];
        const {line: next, index: nextIndex} = regions[slot + 1];
        if (previousIndex !== index - 1 || nextIndex !== index + 1) continue;
        if ([previous, label, next].some(line => line.vertical || line.quarterTurn || (line.sourceBoxes?.length ?? 0) > 1)) continue;
        const boxes = [previous.bbox, label.bbox, next.bbox];
        const heights = boxes.map(box => box.y1 - box.y0);
        const size = Math.min(...heights);
        const lefts = boxes.map(box => box.x0);
        const gaps = [label.bbox.y0 - previous.bbox.y1, next.bbox.y0 - label.bbox.y1];
        if (Number.isFinite(size) && size > 0 && Math.max(...heights) <= size * 1.45
            && Math.max(...lefts) - Math.min(...lefts) <= size * .4
            && gaps.every(gap => gap >= 0 && gap <= size * 1.8)) {
            slots.push(slot);
        }
    }
    return slots;
}
