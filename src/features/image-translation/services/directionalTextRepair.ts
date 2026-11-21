/**
 * @file src/features/image-translation/services/directionalTextRepair.ts
 * 文件职责：在普通图片的窄横排清字框内延续由原图四边共同确认的斜向背景。
 * 主要内容：用固定范围的上下边缘搜索位移，再用独立列和左右边缘核对。确认后沿相同方向连接两侧已知颜色，减少斜边被扩散抹平。
 * 模块边界：只处理调用方已经确认独占的局部 RGBA 和完整一像素外周。半透明、位移歧义或预算不足时保持输入，成功仅写原蒙版内的不透明像素。
 */
export const IMAGE_DIRECTIONAL_REPAIR_BUDGET = 262_144;

/** left、top、width、height 包含调用方在清字框外保留的一像素边界。 */
export function repairDirectionalImageBackground(pixels: Uint8ClampedArray, imageWidth: number,
    left: number, top: number, width: number, height: number, budget: {remaining: number}): boolean {
    const area = width * height;
    if (width < 48 || height < 9 || height > 56 || width < height * 2 || area > 16_384) return false;
    const stride = imageWidth * 4, right = width - 1, bottom = height - 1;
    const start = top * stride + left * 4;
    const maxShift = Math.min(32, Math.floor(right / 4), Math.floor(bottom * 1.5));
    const work = width * (2 * maxShift + 3) + area * 4;
    if (work > budget.remaining) return false;
    budget.remaining -= work;

    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (pixels[start + y * stride + x * 4 + 3] !== 255) return false;
    }

    // 所有位移用同一跨度搜索，避免靠跳过高对比边缘取得更低误差。
    const compareRows = (shift: number, parity: number) => {
        let error = 0, count = 0;
        for (let x = maxShift + parity; x < width - maxShift; x += 2) {
            const a = start + x * 4, b = start + bottom * stride + (x + shift) * 4;
            for (let c = 0; c < 3; c++) error += Math.abs(pixels[a + c] - pixels[b + c]);
            count++;
        }
        return error / (count * 3);
    };
    const unshifted = compareRows(0, 0);
    const errors = new Float64Array(2 * maxShift + 1);
    let shift = 0, best = unshifted;
    for (let candidate = -maxShift; candidate <= maxShift; candidate++) {
        const error = compareRows(candidate, 0);
        errors[candidate + maxShift] = error;
        if (error < best) { best = error; shift = candidate; }
    }
    if (!shift || best > Math.min(28, unshifted * .7)
        || compareRows(shift, 1) > Math.min(28, compareRows(0, 1) * .7)
        || errors.some((error, index) => Math.abs(index - maxShift - shift) >= 4 && error <= best + .25)) return false;

    // 将负位移映射为从左上到右下，四边读取都来自尚未写入的原图。
    const columnStep = shift < 0 ? -4 : 4;
    const upper = shift < 0 ? start + right * 4 : start;
    const lower = upper + bottom * stride, farSide = upper + right * columnStep;
    const slope = Math.abs(shift) / bottom;
    const sample = (origin: number, step: number, position: number, channel: number) => {
        const index = Math.floor(position), fraction = position - index;
        const offset = origin + index * step + channel, value = pixels[offset];
        return fraction === 0 ? value : value + (pixels[offset + step] - value) * fraction;
    };
    let nearError = 0, farError = 0;
    for (let y = 1; y < bottom; y++) for (let c = 0; c < 3; c++) {
        nearError += Math.abs(pixels[upper + y * stride + c] - sample(lower, columnStep, slope * (bottom - y), c));
        farError += Math.abs(pixels[farSide + y * stride + c] - sample(upper, columnStep, right - slope * y, c));
    }
    const sideLimit = 8 * (bottom - 1) * 3;
    if (nearError > sideLimit || farError > sideLimit) return false;

    for (let y = 1; y < bottom; y++) for (let x = 1; x < right; x++) {
        const before = Math.min(y, x / slope), after = Math.min(bottom - y, (right - x) / slope);
        const weight = before / (before + after);
        const offset = upper + y * stride + x * columnStep;
        for (let c = 0; c < 3; c++) {
            const a = before === y
                ? sample(upper, columnStep, Math.max(0, x - slope * before), c)
                : sample(upper, stride, y - before, c);
            const b = after === bottom - y
                ? sample(lower, columnStep, Math.min(right, x + slope * after), c)
                : sample(farSide, stride, y + after, c);
            pixels[offset + c] = Math.round(a + (b - a) * weight);
        }
    }
    return true;
}
