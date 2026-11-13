/**
 * @file src/features/document-translation/core/pdfBorderlessTable.ts
 * 文件职责：在已有整行文字几何中识别带表题、重复数值列的无边框数据表。
 * 主要内容：要求独立表题、至少三列文字表头与三行完整记录、稳定列对齐和至少两列连续数字；仅为确认的空白间隔推导逻辑单元格，不添加或改写文字。候选数量、行列数和搜索高度均有界，已有图形、正文和不完整结构不参与推断。
 * 模块边界：纯数据分析，不进行 OCR、不绘制表线、不访问文件或网络；推导框只供既有 PDF 布局、阅读与导出使用，原页像素保持不变。
 */
interface Rectangle {x: number; y: number; width: number; height: number}
interface Line extends Rectangle {text: string; fontSize: number; baseline: number}
export interface BorderlessTable {bounds: Rectangle; dividers: Rectangle[]; caption: Line}
const right = (box: Rectangle) => box.x + box.width;
const bottom = (box: Rectangle) => box.y + box.height;
const numeric = (text: string) => /^[+−-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][+−-]?\d+)?%?$/u.test(text.trim());
const caption = (text: string) => /^(?:表\s*\d+(?:[.．-]\d+)*[\s:：.．\p{Script=Han}]|Table\s+\d+(?:[.．-]\d+)*[\s:：.．])/iu.test(text);

export function findBorderlessTables(atoms: readonly Line[], graphics: readonly Rectangle[], pageWidth: number): BorderlessTable[] {
    const captions = atoms.filter(line => caption(line.text)).slice(0, 16);
    const result: BorderlessTable[] = [];
    for (const title of captions) {
        const font = title.fontSize;
        if (!(font > 0) || !Number.isFinite(font)) continue;
        const nearby = atoms.filter(line => line !== title && line.y > bottom(title) && line.y < bottom(title) + font * 48
            && line.x >= title.x - font && right(line) <= pageWidth && line.text.trim())
            .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
        if (!nearby.length || nearby.length > 512 || nearby[0].y - bottom(title) > font * 6) continue;
        const rows: Line[][] = [];
        for (const line of nearby) {
            const row = rows.at(-1);
            if (row && line.baseline - row[0].baseline <= font * .8) row.push(line); else rows.push([line]);
        }
        rows.forEach(row => row.sort((a, b) => a.x - b.x));
        const header = rows[0];
        if (header.length < 3 || header.length > 8 || !header.every(line => /\p{L}/u.test(line.text) && line.text.length <= 50)) continue;
        const data: Line[][] = [];
        for (const row of rows.slice(1)) {
            const previous = data.at(-1) ?? header;
            const gap = row[0].baseline - previous[0].baseline;
            if (row.length !== header.length || gap < font || gap > font * 4.5 || caption(row[0].text)
                || !row.every((line, index) => line.text.length <= 50 && line.fontSize >= font * .55 && line.fontSize <= font * 1.35
                    && Math.abs(line.x - header[index].x) <= font * .8)
                || !/\p{L}/u.test(row[0].text)) break;
            data.push(row);
        }
        if (data.length < 3 || data.length > 64 || header.filter((_, index) => data.every(row => numeric(row[index].text))).length < 2) continue;
        const all = [header, ...data];
        const starts = header.map((_, index) => Math.min(...all.map(row => row[index].x)));
        const ends = header.map((_, index) => Math.max(...all.map(row => right(row[index]))));
        if (starts.some((start, index) => index > 0 && start - ends[index - 1] < font * 2)) continue;
        const padding = font * .5;
        const x = Math.max(0, starts[0] - padding), y = Math.min(...header.map(line => line.y)) - padding;
        const endX = Math.min(pageWidth, ends.at(-1)! + padding), endY = Math.max(...data.at(-1)!.map(bottom)) + padding;
        const bounds = {x, y, width: endX - x, height: endY - y};
        if (captions.some(other => other !== title && Math.abs(other.y - title.y) < font * 2 && other.x > title.x + font && other.x < endX)
            || graphics.some(shape => shape.x < endX && right(shape) > x && shape.y < endY && bottom(shape) > y)
            || result.some(table => table.bounds.x < endX && right(table.bounds) > x && table.bounds.y < endY && bottom(table.bounds) > y)) continue;
        const xs = starts.slice(1).map((start, index) => (start + ends[index]) / 2);
        const ys = [y, ...all.slice(1).map((row, index) => (Math.min(...row.map(line => line.y)) + Math.max(...all[index].map(bottom))) / 2), endY];
        const dividers = [...xs.map(x => ({x, y, width: 0, height: bounds.height})), ...ys.map(y => ({x, y, width: bounds.width, height: 0}))];
        result.push({bounds, dividers, caption: title});
    }
    return result;
}
