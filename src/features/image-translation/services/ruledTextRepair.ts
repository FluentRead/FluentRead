/**
 * @file src/features/image-translation/services/ruledTextRepair.ts
 * 文件职责：在既有清字蒙版内验证并延续有源像素支持的细线背景，减少矩形扩散把纸面横线拖成色带。
 * 主要内容：完整不透明邻边须符合单一低对比色轴；候选背景还须通过连通线段、同向直线、边缘支持与实测横截面核对。
 * 颜色相同不足以证明背景，无法解释的浅字、弯曲纹理与交叉线均不生成计划；组件、点数、线数和观察面积分别有界，失败也消耗预付面积。
 * 模块边界：只读调用方已有RGBA和物理蒙版，不读取无字参考、不运行模型、不猜字，也不证明OCR框内的图案一定是文字。
 * 返回计划只拥有局部数组，不保留源图；调用方验证完成后才在原蒙版内保留源像素或填充预测颜色，少量不受观测跨度支持的点继续原扩散。
 */
import { getImageRgbContrast } from './rendering';
export const IMAGE_RULED_REPAIR_LIMITS = Object.freeze({ area: 262144, pagePixels: 2097152, colors: 512, components: 256, points: 16384, lines: 8 });
export interface ImageRuledRepairFrame {
    left: number;
    top: number;
    width: number;
    height: number;
    mask: Uint8Array;
}
export interface ImageRuledRepairPlan {
    kind: Uint8Array;
    colors: Uint8ClampedArray;
}
interface Geometry {
    tx: number;
    ty: number;
    nx: number;
    ny: number;
    offset: number;
}
interface Line extends Geometry {
    left: number;
    right: number;
    distances: number[];
    values: number[];
}
function fitLine(points: readonly number[], width: number, levels: Float64Array, orientation?: Geometry): Geometry {
    let weight = 0, mx = 0, my = 0;
    for (const p of points) {
        const w = levels[p] ** 2;
        weight += w;
        mx += (p % width) * w;
        my += Math.floor(p / width) * w;
    }
    mx /= weight;
    my /= weight;
    let xx = 0, xy = 0, yy = 0;
    for (const p of points) {
        const dx = p % width - mx, dy = Math.floor(p / width) - my, w = levels[p] ** 2;
        xx += dx * dx * w;
        xy += dx * dy * w;
        yy += dy * dy * w;
    }
    // Callers supply at least thirty distinct positive-weight image points.
    // Their centered covariance therefore cannot be the zero matrix.
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    let tx = Math.cos(angle), ty = Math.sin(angle);
    if (orientation && tx * orientation.tx + ty * orientation.ty < 0) {
        tx = -tx;
        ty = -ty;
    }
    const nx = -ty, ny = tx;
    return { tx, ty, nx, ny, offset: mx * nx + my * ny };
}
function profileValue(line: Line, distance: number): number {
    const xs = line.distances, ys = line.values;
    let i = 0;
    while (i < xs.length && xs[i] < distance)
        i++;
    return i === 0 ? ys[0] : i === xs.length ? ys.at(-1)! : ys[i - 1] + (ys[i] - ys[i - 1]) * (distance - xs[i - 1]) / (xs[i] - xs[i - 1]);
}
/** 计划失败不写源像素或输入蒙版；kind1保留原像素，kind2使用已核对的背景，kind0沿用原算法。 */
export function planImageRuledTextRepair(pixels: Uint8ClampedArray, imageWidth: number, imageHeight: number, frame: ImageRuledRepairFrame, budget: {
    remaining: number;
}): ImageRuledRepairPlan | undefined {
    const { left, top, width, height, mask } = frame, L = IMAGE_RULED_REPAIR_LIMITS, area = width * height;
    if (!(pixels instanceof Uint8ClampedArray) || !(mask instanceof Uint8Array)
        || ![imageWidth, imageHeight, left, top, width, height].every(Number.isSafeInteger) || imageWidth <= 0 || imageHeight <= 0
        || !Number.isSafeInteger(imageWidth * imageHeight) || pixels.length < imageWidth * imageHeight * 4
        || left < 0 || top < 0 || width < 3 || height < 3 || left + width > imageWidth || top + height > imageHeight
        || area > L.area || mask.length !== area || !Number.isSafeInteger(budget.remaining) || budget.remaining < area)
        return;
    budget.remaining -= area;
    const offset = (p: number) => ((Math.floor(p / width) + top) * imageWidth + p % width + left) * 4;
    const adjacent = (p: number, visit: (index: number) => void) => {
        const x = p % width, y = Math.floor(p / width);
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
            for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++)
                visit(yy * width + xx);
    };
    const edge = new Uint8Array(area), palette = new Map<number, number>();
    let owned = 0, boundaryCount = 0;
    for (let p = 0; p < area; p++) {
        if (mask[p] > 1 || pixels[offset(p) + 3] !== 255)
            return;
        const x = p % width, y = Math.floor(p / width);
        if (mask[p]) {
            if (!x || !y || x === width - 1 || y === height - 1)
                return;
            owned++;
            continue;
        }
        let touches = false;
        adjacent(p, n => { if (mask[n])
            touches = true; });
        if (!touches)
            continue;
        edge[p] = 1;
        boundaryCount++;
        const i = offset(p), key = pixels[i] | pixels[i + 1] << 8 | pixels[i + 2] << 16;
        palette.set(key, (palette.get(key) ?? 0) + 1);
        if (palette.size > L.colors)
            return;
    }
    if (!owned || boundaryCount < 16)
        return;
    const rgb = (key: number) => [key & 255, key >>> 8 & 255, key >>> 16 & 255];
    let mode = 0, modeCount = 0;
    for (const [key, count] of palette)
        if (count > modeCount) {
            mode = key;
            modeCount = count;
        }
    if (modeCount < boundaryCount * .5)
        return;
    const base = rgb(mode);
    let extreme = base, length = 0;
    for (const key of palette.keys()) {
        const color = rgb(key), distance = color.reduce((sum, v, c) => sum + (v - base[c]) ** 2, 0);
        if (distance > length) {
            extreme = color;
            length = distance;
        }
    }
    if (length < 64 || getImageRgbContrast(base, extreme) > 2.5)
        return;
    const direction = extreme.map((v, c) => v - base[c]), levels = new Float64Array(area), residual = new Float64Array(area);
    let low = Infinity, high = -Infinity;
    for (let p = 0; p < area; p++) {
        const i = offset(p);
        let dot = 0;
        for (let c = 0; c < 3; c++)
            dot += (pixels[i + c] - base[c]) * direction[c];
        const t = dot / length;
        levels[p] = t;
        for (let c = 0; c < 3; c++)
            residual[p] = Math.max(residual[p], Math.abs(pixels[i + c] - base[c] - t * direction[c]));
        if (edge[p]) {
            if (residual[p] > 1)
                return;
            low = Math.min(low, t);
            high = Math.max(high, t);
        }
    }
    if (low < -.2)
        return;
    const expanded = new Uint8Array(area);
    for (let p = 0; p < area; p++)
        if (mask[p] && (residual[p] > 1 || levels[p] < low || levels[p] > high)) {
            const x = p % width, y = Math.floor(p / width);
            for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++)
                for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++)
                    expanded[yy * width + xx] = 1;
        }
    const known = new Uint8Array(area), points: number[] = [];
    let kept = 0;
    for (let p = 0; p < area; p++) {
        if (edge[p] || mask[p] && !expanded[p]) {
            known[p] = 1;
            if (mask[p])
                kept++;
            if (levels[p] > .1) {
                points.push(p);
                if (points.length > L.points)
                    return;
            }
        }
    }
    if (kept < owned * .35 || kept >= owned || points.length < 30)
        return;
    const pointMask = new Uint8Array(area), seen = new Uint8Array(area), queue = new Uint32Array(points.length);
    for (const p of points)
        pointMask[p] = 1;
    let components = 0, longest: number[] | undefined, longestSpan = 0;
    for (const first of points) {
        if (seen[first])
            continue;
        if (++components > L.components)
            return;
        let head = 0, tail = 1, minX = width, maxX = -1, minY = height, maxY = -1;
        queue[0] = first;
        seen[first] = 1;
        const part: number[] = [];
        while (head < tail) {
            const p = queue[head++], x = p % width, y = Math.floor(p / width);
            part.push(p);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            adjacent(p, n => { if (pointMask[n] && !seen[n]) {
                seen[n] = 1;
                queue[tail++] = n;
            } });
        }
        const span = Math.hypot(maxX - minX, maxY - minY);
        if (span > longestSpan) {
            longest = part;
            longestSpan = span;
        }
    }
    if (!longest || longestSpan < 64)
        return;
    const orientation = fitLine(longest, width, levels);
    const ordinate = (p: number) => orientation.nx * (p % width) + orientation.ny * Math.floor(p / width);
    points.sort((a, b) => ordinate(a) - ordinate(b) || a - b);
    const groups: number[][] = [];
    for (const p of points) {
        const last = groups.at(-1);
        if (!last || ordinate(p) - ordinate(last.at(-1)!) > 4)
            groups.push([p]);
        else
            last.push(p);
    }
    if (groups.length > L.lines)
        return;
    const lines: Line[] = [];
    let anchored = 0;
    for (const group of groups) {
        if (group.length < 30)
            return;
        const fit = fitLine(group, width, levels, orientation);
        if (Math.abs(fit.tx * orientation.ty - fit.ty * orientation.tx) > .025)
            return;
        let min = Infinity, max = -Infinity, edgeMin = Infinity, edgeMax = -Infinity;
        for (const p of group) {
            const x = p % width, y = Math.floor(p / width), along = fit.tx * x + fit.ty * y;
            min = Math.min(min, along);
            max = Math.max(max, along);
            if (Math.abs(fit.nx * x + fit.ny * y - fit.offset) >= 2.5)
                return;
            if (edge[p]) {
                edgeMin = Math.min(edgeMin, along);
                edgeMax = Math.max(edgeMax, along);
            }
        }
        if (max - min < 64)
            return;
        if (edgeMax - edgeMin >= 64)
            anchored++;
        const counts = new Uint32Array(60), sums = new Float64Array(60), distances = new Float64Array(60);
        let samples = 0;
        const acrossX = Math.abs(fit.nx) > Math.abs(fit.ny), major = acrossX ? height : width, minor = acrossX ? width : height;
        const coefficient = acrossX ? fit.nx : fit.ny, other = acrossX ? fit.ny : fit.nx, radius = 3 / Math.abs(coefficient);
        for (let a = 0; a < major; a++) {
            const center = (fit.offset - other * a) / coefficient;
            for (let b = Math.max(0, Math.ceil(center - radius)); b <= Math.min(minor - 1, Math.floor(center + radius)); b++) {
                const x = acrossX ? b : a, y = acrossX ? a : b, p = y * width + x, d = fit.nx * x + fit.ny * y - fit.offset, along = fit.tx * x + fit.ty * y;
                if (!known[p] || Math.abs(d) >= 3 || along < min || along > max)
                    continue;
                const bin = Math.min(59, Math.floor((d + 3) * 10));
                counts[bin]++;
                sums[bin] += levels[p];
                distances[bin] += d;
                samples++;
            }
        }
        const xs: number[] = [], ys: number[] = [];
        for (let i = 0; i < 60; i++)
            if (counts[i]) {
                xs.push(distances[i] / counts[i]);
                ys.push(sums[i] / counts[i]);
            }
        if (samples < 32 || xs.length < 4 || xs[0] > -1 || xs.at(-1)! < 1 || Math.abs(ys[0]) > .05 || Math.abs(ys.at(-1)!) > .05)
            return;
        lines.push({ ...fit, left: min, right: max, distances: xs, values: ys });
    }
    if (anchored < 2)
        return;
    const corners = [0, orientation.tx * (width - 1), orientation.ty * (height - 1), orientation.tx * (width - 1) + orientation.ty * (height - 1)];
    for (const t of [Math.min(...corners), Math.max(...corners)]) {
        const positions = lines.map(line => (line.offset - (line.nx * orientation.tx + line.ny * orientation.ty) * t) / (line.nx * orientation.nx + line.ny * orientation.ny));
        const gaps = positions.slice(1).map((value, i) => value - positions[i]);
        if (gaps.some(gap => gap <= 6))
            return;
        const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        if (gaps.some(gap => Math.abs(gap - median) > Math.max(2, median * .1)))
            return;
    }
    const kind = new Uint8Array(area), colors = new Uint8ClampedArray(area * 3), used = new Set<Line>();
    let unsupported = 0;
    for (let p = 0; p < area; p++) {
        if (!mask[p])
            continue;
        const x = p % width, y = Math.floor(p / width);
        if (known[p]) {
            // The point threshold only estimates geometry. It cannot authorize
            // preserving faint strokes away from every observed rule.
            if (!lines.some(line => Math.abs(line.nx * x + line.ny * y - line.offset) < 3)) {
                const at = offset(p);
                for (let c = 0; c < 3; c++)
                    if (Math.abs(base[c] - pixels[at + c]) > 2)
                        return;
            }
            kind[p] = 1;
            continue;
        }
        let value = 0, supported = true;
        for (const line of lines) {
            const d = line.nx * x + line.ny * y - line.offset, along = line.tx * x + line.ty * y;
            if (Math.abs(d) >= 3)
                continue;
            if (along < line.left || along > line.right) {
                supported = false;
                break;
            }
            value = profileValue(line, d);
            used.add(line);
            break;
        }
        if (!supported) {
            if (++unsupported > Math.max(64, owned * .01))
                return;
            continue;
        }
        kind[p] = 2;
        for (let c = 0; c < 3; c++)
            colors[p * 3 + c] = Math.round(base[c] + value * direction[c]);
    }
    // Only a profile actually used to fill a gap needs to explain every observed
    // cross-section along its span. Dashed or varying rules must not become solid.
    for (const line of used)
        for (let p = 0; p < area; p++) {
            if (!known[p])
                continue;
            const x = p % width, y = Math.floor(p / width), d = line.nx * x + line.ny * y - line.offset, along = line.tx * x + line.ty * y;
            if (Math.abs(d) >= 3 || along < line.left || along > line.right)
                continue;
            const value = profileValue(line, d), at = offset(p);
            for (let c = 0; c < 3; c++)
                if (Math.abs(Math.round(base[c] + value * direction[c]) - pixels[at + c]) > 2)
                    return;
        }
    return { kind, colors };
}
