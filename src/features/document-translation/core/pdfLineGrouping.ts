/**
 * @file src/features/document-translation/core/pdfLineGrouping.ts
 *
 * 文件职责：实现 PDF 原始字形的同位重描去重、数学上下标/大算符/根号基线关联及按栏间距切分的版面成行算法。
 * 主要内容：导出 pdfLayoutLines 及其内部同位重描去重器 uniquePaintAtoms，结合相邻行共同留白带和显式分隔线产出排序后的 LayoutLine 列表。
 * 模块边界：仅依赖 pdfLayoutGeometry 纯几何工具，不处理插图、表格或公式区域识别，也不访问 DOM 或 PDF.js。
 */

import {
    bottom,
    joinRuns,
    largeOperator,
    median,
    right,
    union,
    type LayoutLine,
    type PdfLayoutAtom,
    type Rectangle,
} from './pdfLayoutGeometry';

/** 同位重描可以换字体或拆成不同文字项；完整文字和两端几何均相符时才去除。 */
function uniquePaintAtoms(atoms: readonly PdfLayoutAtom[]): PdfLayoutAtom[] {
    // 同级网格使用固定物理距离；跨级查询覆盖字号容差，巨大字体的邻域也保持有限桶数。
    const cellFor = (slack: number) => 2 ** Math.floor(Math.log2(Math.max(1, slack)));
    const metrics = new Map(atoms.map(atom => [atom, {fontSize: atom.fontSize, baseline: atom.baseline}]));
    const compact = new Map(atoms.map(atom => [atom, atom.text.replace(/\s/gu, '')]));
    const near = (index: Map<string, PdfLayoutAtom[]>, x: number, baseline: number, slack: number, forward = slack, text = '') => {
        const result: PdfLayoutAtom[] = [];
        for (const cell of new Set([cellFor(slack - .05), cellFor(slack + .05)])) {
            const firstColumn = Math.floor((x - slack) / cell);
            const lastColumn = Math.floor((x + forward) / cell);
            const firstRow = Math.floor((baseline - slack) / cell);
            const lastRow = Math.floor((baseline + slack) / cell);
            // 超出安全整数的绝对桶号不能逐一递增；不确定的坐标不做去重，保全原文字项。
            if (![firstColumn, lastColumn, firstRow, lastRow].every(Number.isSafeInteger)) continue;
            for (let dx = 0; dx <= lastColumn - firstColumn; dx++) {
                for (let dy = 0; dy <= lastRow - firstRow; dy++) {
                    for (const atom of index.get(`${cell}:${firstColumn + dx}:${firstRow + dy}:${text}`) ?? []) result.push(atom);
                }
            }
        }
        return result;
    };
    const add = (index: Map<string, PdfLayoutAtom[]>, atom: PdfLayoutAtom, text = '') => {
        const metric = metrics.get(atom)!;
        const cell = cellFor(Math.max(1, metric.fontSize * .1));
        const key = `${cell}:${Math.floor(atom.x / cell)}:${Math.floor(metric.baseline / cell)}:${text}`;
        const bucket = index.get(key);
        if (bucket) bucket.push(atom);
        else index.set(key, [atom]);
    };
    const slackFor = (atom: PdfLayoutAtom) => Math.max(1, metrics.get(atom)!.fontSize * .1);
    const sameBaseline = (a: PdfLayoutAtom, b: PdfLayoutAtom, slack: number) => {
        const first = metrics.get(a)!;
        const next = metrics.get(b)!;
        return Math.abs(first.baseline - next.baseline) <= slack && Math.abs(first.fontSize - next.fontSize) <= .5;
    };
    const sameDrawing = (index: Map<string, PdfLayoutAtom[]>, atom: PdfLayoutAtom, text: string) => {
        const slack = slackFor(atom);
        return near(index, atom.x, metrics.get(atom)!.baseline, slack, slack, text).some(other =>
            Math.abs(other.x - atom.x) <= Math.min(slack, atom.width / 2, other.width / 2)
            && Math.abs(other.width - atom.width) <= slack
            && sameBaseline(atom, other, slack));
    };
    const drawn = new Map<string, PdfLayoutAtom[]>();
    const unique = atoms.filter(atom => {
        const text = compact.get(atom)!;
        if (!text) return true;
        if (sameDrawing(drawn, atom, text)) return false;
        add(drawn, atom, text);
        return true;
    });
    // 两次绘制都可能拆成不同片段，完全没有“整句”文字项。只把按绘制顺序物理连续的片段
    // 组成分析用候选；输出仍保留原字形对象，候选自身的片段绝不能被自己当作重描删除。
    const composites = new Map<PdfLayoutAtom, PdfLayoutAtom[]>();
    let pieces: PdfLayoutAtom[] = [];
    const finish = () => {
        if (pieces.length > 1) {
            const first = pieces[0];
            const bounds = pieces.slice(1).reduce<Rectangle>(union, first);
            const candidate = {...first, ...bounds, text: joinRuns(pieces)};
            composites.set(candidate, pieces);
            metrics.set(candidate, metrics.get(first)!);
            compact.set(candidate, candidate.text.replace(/\s/gu, ''));
        }
        pieces = [];
    };
    for (const atom of unique) {
        if (!compact.get(atom)) {finish(); continue;}
        const first = pieces[0];
        const last = pieces.at(-1);
        if (last && (!sameBaseline(first, atom, slackFor(first)) || atom.x <= last.x
            || atom.x < right(last) - Math.min(slackFor(first), last.width * .25)
            || atom.x - right(last) > metrics.get(first)!.fontSize * .6)) finish();
        pieces.push(atom);
    }
    finish();
    const starts = new Map<string, PdfLayoutAtom[]>();
    const compositeDrawn = new Map<string, PdfLayoutAtom[]>();
    const removed = new Set<PdfLayoutAtom>();
    for (const [candidate, parts] of composites) {
        const text = compact.get(candidate)!;
        if (sameDrawing(compositeDrawn, candidate, text)) parts.forEach(part => removed.add(part));
        else add(compositeDrawn, candidate, text);
    }
    unique.forEach(atom => {if (compact.get(atom) && !removed.has(atom)) add(starts, atom);});
    // 先考察宽项，使“整句 + 若干不同字体片段”的保留结果不依赖 PDF 绘制顺序。
    for (const whole of [...unique].sort((a, b) => b.width - a.width)) {
        const text = compact.get(whole)!;
        if (removed.has(whole) || text.length < 2 || whole.width <= 0) continue;
        const slack = slackFor(whole);
        const visited = new Map<PdfLayoutAtom, Set<number>>();
        interface ChainState {offset: number; end: number; part?: PdfLayoutAtom; previous?: ChainState}
        const pending: ChainState[] = [{offset: 0, end: whole.x}];
        while (pending.length) {
            const current = pending.pop()!;
            const {offset, end} = current;
            if (offset === text.length) {
                if (Math.abs(end - right(whole)) > slack) continue;
                for (let state: ChainState | undefined = current; state?.part; state = state.previous) removed.add(state.part);
                break;
            }
            const candidates = near(starts, end, metrics.get(whole)!.baseline, slack, offset ? metrics.get(whole)!.fontSize * .6 : slack).filter(part => {
                const value = compact.get(part)!;
                return !(part === whole || removed.has(part) || value.length >= text.length || !text.startsWith(value, offset)
                    || part.width <= 0 || !sameBaseline(whole, part, slack) || part.x < end - slack
                    || part.x > end + (offset ? metrics.get(whole)!.fontSize * .6 : slack) || right(part) <= end || right(part) > right(whole) + slack
                    || visited.get(part)?.has(offset));
            });
            const closest = candidates.reduce((distance, part) => Math.min(distance, Math.abs(part.x - end)), Infinity);
            for (const part of candidates) {
                // 连续绘制必须接上最近的同字串片段；不能跳过邻近的相同字形再用远处字形拼出重复文字。
                if (Math.abs(part.x - end) > closest + Math.min(slack, part.width * .25)) continue;
                const positions = visited.get(part) ?? new Set<number>();
                positions.add(offset);
                visited.set(part, positions);
                pending.push({offset: offset + compact.get(part)!.length, end: right(part), part, previous: current});
            }
        }
    }
    return unique.filter(atom => !removed.has(atom));
}

/** 基线而非字形顶边决定同一行，上下标仍保留自己的矩形和文字。 */
export function pdfLayoutLines(
    atoms: readonly PdfLayoutAtom[],
    verticalDividers: readonly Rectangle[] = [],
    horizontalCellDividers: readonly Rectangle[] = [],
): LayoutLine[] {
    // 行内根号等细笔画不覆盖整行高度，不能当作单元格分隔线。
    const divided = (start: number, end: number, baseline: number, font: number) => verticalDividers.some(
        divider => divider.height >= font && divider.x >= start - 0.5 && right(divider) <= end + 0.5
            && baseline >= divider.y - 2 && baseline <= bottom(divider) + 2,
    );

    const rows: Array<{runs: PdfLayoutAtom[]; font: number; baseline: number; samples: number; first: number}> = [];
    const rowMembership = new Map<PdfLayoutAtom, (typeof rows)[number]>();
    const unique = uniquePaintAtoms(atoms);
    // TeX 根号字形的基线可能抬高到上一行；被开方字形紧贴根号右端，按它的基线归行。
    const associated = unique.map(atom => {
        // 向量箭头、单位向量帽号与主字形重叠且位于其上方，先归到主字形基线。
        // 否则一排重音符会成为稀疏的独立行，并被误用作正文中的栏间留白证据。
        if (/^[→^]$/u.test(atom.text)) {
            const base = unique.find(other => /^[\p{L}]$/u.test(other.text) && other.fontSize >= atom.fontSize * 0.85 && other.fontSize <= atom.fontSize * 1.2
                && other.baseline - atom.baseline >= atom.fontSize * 0.4 && other.baseline - atom.baseline <= atom.fontSize
                && Math.abs(other.x + other.width / 2 - atom.x - atom.width / 2) <= atom.fontSize * 0.25);
            if (base) return {...atom, baseline: base.baseline};
        }
        if (atom.text !== '√') return atom;
        const next = unique.filter(other => other !== atom && /^[\p{L}\d(]/u.test(other.text)
            && Math.abs(other.x - right(atom)) <= atom.fontSize * 0.35 && other.fontSize >= atom.fontSize * 0.8
            && other.baseline - atom.baseline > atom.fontSize * 0.35 && other.baseline - atom.baseline <= atom.fontSize)
            .sort((a, b) => Math.abs(a.x - right(atom)) - Math.abs(b.x - right(atom)) || a.baseline - b.baseline)[0];
        // 字体的通用 ascent 会低估根号下伸笔画；只在已有相邻字符证据时扩展底边，不移动原字形。
        return next ? {...atom, baseline: next.baseline, height: Math.max(bottom(atom), bottom(next)) - atom.y} : atom;
    });
    // 上下标先按物理相邻且字号更大的局部字形归行，再参与全页基线分组。
    // 不能借用其它表格列的居中基线，把“×10”的上标归到上一行表头。
    const layoutFont = (atom: PdfLayoutAtom) => atom.layoutFontSize ?? atom.fontSize;
    const groupingBases = new Map<PdfLayoutAtom, PdfLayoutAtom>();
    const confirmedRoots = new Set<PdfLayoutAtom>();
    const largestFont = associated.reduce((size, atom) => Math.max(size, layoutFont(atom)), 0);
    const endpoints = new Map<string, PdfLayoutAtom[]>();
    const proseStarts = new Map<string, PdfLayoutAtom[]>();
    const scale = Math.max(1, largestFont);
    for (const atom of associated) {
        const key = `${Math.floor(right(atom) / scale)}:${Math.floor(atom.baseline / scale)}`;
        const bucket = endpoints.get(key);
        if (bucket) bucket.push(atom);
        else endpoints.set(key, [atom]);
        if (atom.text.length > 5) {
            const startKey = `${Math.floor(atom.x / scale)}:${Math.floor(atom.baseline / scale)}`;
            const startBucket = proseStarts.get(startKey);
            if (startBucket) startBucket.push(atom);
            else proseStarts.set(startKey, [atom]);
        }
    }
    const localBases = (atom: PdfLayoutAtom, x = atom.x, buckets = endpoints) => {
        const column = Math.floor(x / scale);
        const row = Math.floor(atom.baseline / scale);
        const candidates: PdfLayoutAtom[] = [];
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                candidates.push(...buckets.get(`${column + dx}:${row + dy}`) || []);
            }
        }
        return candidates;
    };
    // 仅在已经找到脚标候选时检查正文邻居；普通短词不必额外分配和扫描第二组空间桶。
    const inlineProse = (atom: PdfLayoutAtom, nearby: readonly PdfLayoutAtom[]) => {
        const sameProse = (other: PdfLayoutAtom) => other.text.length > 5 && Math.abs(layoutFont(other) - layoutFont(atom)) <= layoutFont(atom) * 0.15
            && Math.abs(other.baseline - atom.baseline) <= Math.max(1, layoutFont(atom) * 0.15)
            && (atom.x >= right(other) && atom.x - right(other) <= layoutFont(atom) * 0.6 || other.x >= right(atom) && other.x - right(atom) <= layoutFont(atom) * 0.6);
        return nearby.some(sameProse) || localBases(atom, right(atom), proseStarts).some(sameProse);
    };
    // 拉伸分隔符的绘制基线偏移不代表另一行；以实际字框中心和同横向字号的紧邻字形定位正文基线。
    for (const atom of associated) {
        if (!atom.layoutFontSize) continue;
        const center = atom.y + atom.height / 2;
        const base = localBases(atom).filter(other => other !== atom && !other.layoutFontSize
            && Math.abs(layoutFont(other) - layoutFont(atom)) <= layoutFont(atom) * .15
            && Math.max(other.x - right(atom), atom.x - right(other)) <= layoutFont(atom) * 1.5
            && Math.abs(other.y + other.height / 2 - center) <= layoutFont(atom) * .5)
            .sort((a, b) => Math.abs(a.y + a.height / 2 - center) - Math.abs(b.y + b.height / 2 - center))[0];
        if (base) groupingBases.set(atom, base);
    }
    // TeX 大算符的提取基线可能靠近上一行正文；实际字框需伸入下方主体，并有同单元格的紧邻关系符与右侧数学字形。
    // 只改分组依据，源字框与提取基线保留；行内正文中的同类符号仍使用自己的基线。
    for (const atom of associated) {
        if (!largeOperator.test(atom.text) || groupingBases.has(atom)) continue;
        const size = layoutFont(atom);
        const nearby = localBases(atom);
        if (inlineProse(atom, nearby)) continue;
        const below = {...atom, baseline: atom.baseline + size};
        const bases = localBases(below).filter(other => /^[=≔≈≃≅≡≤≥≠]$/u.test(other.text)
            && other.x < atom.x && atom.x - right(other) >= -size * .15 && atom.x - right(other) <= size * .6
            && Math.abs(layoutFont(other) - size) <= size * .15
            && other.baseline - atom.baseline > size * .6 && other.baseline - atom.baseline <= size * 1.8
            && bottom(atom) > other.y && atom.y < bottom(other) && !divided(right(other), atom.x, other.baseline, size)
            && !horizontalCellDividers.some(divider => divider.x <= atom.x + atom.width / 2 && right(divider) >= atom.x + atom.width / 2
                && divider.y > atom.baseline + .5 && bottom(divider) < other.baseline - .5));
        const base = bases.find(other => localBases({...atom, baseline: other.baseline}, right(atom) + size).some(peer => peer !== atom
            && peer.x >= right(atom) && peer.x - right(atom) <= size * 2
            && Math.abs(peer.baseline - other.baseline) <= size * .2 && Math.abs(layoutFont(peer) - size) <= size * .15
            && /^(?:[\p{Sm}()[\]{}|]|\p{L}\p{M}*)$/u.test(peer.text) && !divided(right(atom), peer.x, other.baseline, size)));
        if (base) {
            // 关系符与右侧主体共同确认真实公式基线；撤销其先前可能借大算符中心建立的临时关联，避免相互指向。
            groupingBases.delete(base);
            confirmedRoots.add(base);
            groupingBases.set(atom, base);
        }
    }
    for (const atom of [...associated].sort((a, b) => layoutFont(b) - layoutFont(a))) {
        if (groupingBases.has(atom) || confirmedRoots.has(atom) || layoutFont(atom) > largestFont * 0.8 || atom.text.length > 24) continue;
        const nearby = localBases(atom);
        const bases = nearby.filter(other => other.x < atom.x && layoutFont(atom) <= layoutFont(other) * 0.8
            && (atom.text.length <= 5 && atom.width <= layoutFont(other) * 2
                || /^[\p{L}\d]$/u.test(other.text) && atom.width <= layoutFont(other) * 6 && Math.abs(atom.baseline - other.baseline) <= layoutFont(other) * .5)
            && Math.abs(atom.x - right(other)) <= layoutFont(other) * 0.5
            && Math.abs(atom.baseline - other.baseline) <= layoutFont(other) * 0.8);
        const base = bases.sort((a, b) => Math.abs(atom.baseline - a.baseline) - Math.abs(atom.baseline - b.baseline))[0];
        // 拉伸数学括号可能比下一行正文大得多；紧贴同字号、同基线长正文的短词不能吸成上一行下标。
        if (base && !inlineProse(atom, nearby)) groupingBases.set(atom, base);
    }
    const groupingRoot = (atom: PdfLayoutAtom) => {
        while (groupingBases.has(atom)) atom = groupingBases.get(atom)!;
        return atom;
    };
    // 同一上标可由多个字形及其嵌套下标组成；已确认的局部基行沿紧邻脚标延续，不能留下半个脚标成为另一行。
    for (const atom of [...associated].sort((a, b) => a.x - b.x)) {
        if (groupingBases.has(atom) || confirmedRoots.has(atom) || layoutFont(atom) > largestFont * 0.8 || atom.text.length > 5) continue;
        const nearby = localBases(atom);
        const peer = nearby.find(other => other.x < atom.x && groupingBases.has(other) && layoutFont(atom) <= layoutFont(groupingRoot(other)) * 0.8
            && Math.abs(atom.x - right(other)) <= Math.max(layoutFont(atom), layoutFont(other)) * 0.5
            && Math.abs(atom.baseline - other.baseline) <= Math.max(layoutFont(atom), layoutFont(other)) * 0.35);
        if (peer && !inlineProse(atom, nearby)) groupingBases.set(atom, peer);
    }
    const groupingBaseline = (atom: PdfLayoutAtom) => groupingRoot(atom).baseline;
    for (const atom of associated.sort((a, b) => groupingBaseline(a) - groupingBaseline(b) || a.x - b.x)) {
        const row = rows.at(-1);
        const baseline = groupingBaseline(atom);
        const tolerance = row ? Math.max(2, Math.max(row.font, layoutFont(atom)) * 0.5) : 0;
        // 同一行同时含抬高的上标与降低的下标时，二者跨度稍大；下标仍须贴近主行基线，不能单凭早来的上标将它切成下一行。
        const firstTolerance = row && layoutFont(atom) <= row.font * 0.8 ? Math.max(tolerance, row.font * 0.8) : tolerance;
        // 另一栏较高的公式不应切断本栏相邻的正文；只在越过首基线时查已入行的局部正文端点，避免全行扫描。
        const localContinuation = row && baseline - row.first > firstTolerance
            && localBases(atom, right(atom), proseStarts).some(other => rowMembership.get(other) === row
                && Math.abs(groupingBaseline(other) - baseline) <= layoutFont(atom) * .25
                && Math.abs(other.x - right(atom)) <= layoutFont(atom) * 2);
        // 双栏行距不同时，一栏的基线会落在另一栏两行之间；只与行首基线比较，避免它把上下两行接力串成一行。
        if (!row || Math.abs(baseline - row.baseline) > tolerance || baseline - row.first > firstTolerance && !localContinuation) {
            rows.push({runs: [atom], font: layoutFont(atom), baseline, samples: 1, first: baseline});
        } else {
            row.runs.push(atom);
            if (layoutFont(atom) > row.font * 1.15) {row.font = layoutFont(atom); row.baseline = baseline; row.samples = 1;}
            else if (layoutFont(atom) >= row.font * 0.85) {row.baseline = (row.baseline * row.samples + baseline) / (row.samples + 1); row.samples += 1;}
        }
        if (atom.text.length > 5) rowMembership.set(atom, rows.at(-1)!);
    }
    const result: LayoutLine[] = [];
    const ordered = rows.map(row => [...row.runs].sort((a, b) => a.x - b.x));
    const clearAt = (row: readonly PdfLayoutAtom[], x: number) => !row.some(run => run.x < x + 1.5 && right(run) > x - 1.5);
    const adjacent = (at: number, from: number, font: number) => Boolean(rows[at]) && Math.abs(rows[at].baseline - rows[from].baseline) <= font * 2.2;
    /**
     * 真实栏间距会被相邻行在同一竖带上共同让出：1 表示某一侧连续两行（或该侧仅有的一行）留白，0 表示上下邻行都占用，-1 表示至少一侧没有邻行可供比较。
     * 松散对齐的词间距即使偶尔与一行邻行对齐，也难以连续两行落在同一竖带。
     */
    const gutterSupport = (rowIndex: number, start: number, end: number, font: number): -1 | 0 | 1 => {
        for (let x = start + 1.5; x <= end - 1.5; x += 2) {
            for (const step of [-1, 1]) {
                if (!adjacent(rowIndex + step, rowIndex, font) || !clearAt(ordered[rowIndex + step], x)) continue;
                if (!adjacent(rowIndex + step * 2, rowIndex + step, font) || clearAt(ordered[rowIndex + step * 2], x)) return 1;
            }
        }
        return adjacent(rowIndex - 1, rowIndex, font) && adjacent(rowIndex + 1, rowIndex, font) ? 0 : -1;
    };
    // 两侧排版基线不一致时，数学项的词距可能接近窄栏间距；另外两排独立
    // 的长正文在相同左右端点停靠，才允许绕过单排词距比例，不能凭一条空白拆行。
    const alignedGutter = (rowIndex: number, start: number, end: number, font: number): boolean => {
        let support = 0;
        for (const direction of [-1, 1]) for (let distance = 1; distance <= 32; distance++) {
            const index = rowIndex + direction * distance;
            if (index < 0 || index >= rows.length) break;
            const row = ordered[index];
            // 栏内段落行距可不同；在连续留白带内找边界，遇到跨栏正文即停止，每侧最多检查32行。
            if (!clearAt(row, (start + end) / 2)) break;
            const left = row.filter(run => right(run) <= start + Math.max(1.5, font * .3));
            if (!left.length || start - right(left.at(-1)!) > font * 2 || right(left.at(-1)!) - left[0].x < font * 6) continue;
            const rightIndex = row.findIndex(run => Math.abs(run.x - end) <= Math.max(1.5, font * .3));
            if (rightIndex < 0) continue;
            let rightEdge = right(row[rightIndex]);
            let hasProse = /\p{L}{3}/u.test(row[rightIndex].text);
            // 三栏索引的数字、逗号是同一栏的连续片段；不能借用再下一栏的宽度作证据。
            for (let cursor = rightIndex + 1; cursor < row.length && row[cursor].x - rightEdge <= font * 1.2; cursor++) {
                rightEdge = Math.max(rightEdge, right(row[cursor]));
                hasProse ||= /\p{L}{3}/u.test(row[cursor].text);
            }
            if (hasProse && rightEdge - end >= font * (start - right(left.at(-1)!) > 1.5 ? 8 : 6) && ++support >= 2) return true;
        }
        return false;
    };
    for (const [rowIndex, row] of ordered.entries()) {
        const bodyFont = median(row.map(run => layoutFont(run)));
        const groups: PdfLayoutAtom[][] = [];
        // 两端对齐的松散行会把每个词间距都拉到接近一个字宽；只有明显大于本行词距、且被邻行让出的空白才是栏间距。
        const gaps: number[] = [];
        let end = -Infinity;
        for (const run of row) {
            if (run.x - end > bodyFont * 0.15 && end > -Infinity) gaps.push(run.x - end);
            end = Math.max(end, right(run));
        }
        end = -Infinity;
        for (const [runIndex, run] of row.entries()) {
            const gap = run.x - end;
            let split = !groups.length || divided(end, run.x, rows[rowIndex].baseline, bodyFont);
            if (!split && (gap > Math.max(6, bodyFont * 0.9) || gap > bodyFont * .4 && run.width >= bodyFont * 10 && end - groups.at(-1)![0].x >= bodyFont * 10 && alignedGutter(rowIndex, end, run.x, bodyFont))) {
                const others = [...gaps];
                others.splice(others.indexOf(gap), 1);
                const support = gutterSupport(rowIndex, end, run.x, bodyFont);
                const next = row[runIndex + 1];
                const previous = groups.at(-1)!.at(-1)!;
                const inlineOperator = /^[=<>≤≥≠∝≈±×÷]$/u.test(run.text) && next && /\p{L}{3}/u.test(previous.text)
                    && /\p{L}{3}/u.test(next.text) && next.x - right(run) <= bodyFont * 1.2;
                if (gap < bodyFont * 1.2 && (inlineOperator || run.text.length >= 6 && /[a-z]{3}|[\p{Script=Han}]{3}/iu.test(run.text))
                    && !alignedGutter(rowIndex, end, run.x, bodyFont)) {
                    groups.at(-1)!.push(run);
                    end = Math.max(end, right(run));
                    continue;
                }
                split = (support < 0 ? gap >= bodyFont * 2.5 : support === 1) && (!others.length || gap >= bodyFont * 2.5 || gap >= median(others) * 1.8 || alignedGutter(rowIndex, end, run.x, bodyFont));
            }
            if (split) groups.push([run]);
            else groups.at(-1)!.push(run);
            end = Math.max(end, right(run));
        }
        for (let index = 0; index < groups.length - 1; index += 1) {
            const previous = groups[index];
            const next = groups[index + 1];
            // Word 的显式项目符号常被稳定窄空白带拆成一列；它与同基线文字是一个条目，不能把全部符号留作一栏公式。
            const marker = previous.length === 1 && /^[•◦▪■□◆◇●○▶►➢➤❖·§Ø\uE000-\uF8FF]$/u.test(previous[0].text.trim());
            if ((marker || /^\d+(?:\.\d+)*$/u.test(joinRuns(previous)) && /^[A-Z]/u.test(joinRuns(next))) && next[0].x - right(previous.at(-1)!) <= bodyFont * 2.5
                && !divided(right(previous.at(-1)!), next[0].x, rows[rowIndex].baseline, bodyFont)) {
                previous.push(...next);
                groups.splice(index + 1, 1);
            }
        }
        for (const runs of groups) {
            const bounds = runs.reduce<Rectangle>((box, run) => union(box, run), runs[0]);
            const dominant = [...runs].sort((a, b) => b.width - a.width)[0];
            const fontSize = median(runs.filter(run => layoutFont(run) >= layoutFont(dominant) * 0.85).map(run => layoutFont(run)));
            result.push({
                ...bounds,
                text: joinRuns(runs),
                baseline: median(runs.filter(run => layoutFont(run) >= fontSize * 0.85).map(run => run.baseline)),
                fontSize,
                fontFamily: dominant.fontFamily,
                runs: runs.map(run => ({...run})),
            });
        }
    }
    return result.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
}
