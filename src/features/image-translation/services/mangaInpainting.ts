/**
 * @file src/features/image-translation/services/mangaInpainting.ts
 * 文件职责：用按需加载的本地 LaMa 漫画模型修补复杂背景上的原字形，保留气泡之外和蒙版之外的原始像素。
 * 主要内容：共享本次原图背景分类，完整确认均匀的页面不等待其他页面的模型修补队列；默认返回独立像素副本，仅显式持有独占像素的调用方可在均匀页及纯确定性简单修补页复用原缓冲，复杂页始终保留原图与输出分离；按识别行及其有界描边余量建立局部蒙版，按面积相交投影为补丁行段，避免每个补丁像素遍历全部文字行；截取有上下文且最长边不超过 512 的有界补丁，归一化 ONNX 张量并仅回写蒙版区域；所有区域共同跳过原图阶段冻结的低 alpha 行段并保留其四通道，透明保护按区域检查以允许同页其他不透明区域继续使用确定性快路径；透明补丁仅在完整外周透明度一致时压低 source-over 字形增加的 alpha，不把 RGB 模型当作 alpha 预测器；融合 ONNX 执行图，兼容的硬件 GPU 加速修补、设备失效有界切换 CPU；独立 Worker 串行推理、70% 计算时间预算、滚动取消保留模型端口并由 owner 有界收尾，三分钟空闲释放约束资源。
 * 几何与采样：小补丁保留原像素网格，大补丁等比例面积缩小，随后仅镜像 RGB 上下文补齐 64 倍数模型尺寸并将补齐区蒙版置零，防止边缘幻觉；输出只从有效内容区按像素中心双线性回填，并在蒙版内侧 2 像素边界对色差温和的接缝做保边羽化，既消除模型块边缘接缝，又保持恒等往返零误差且不跨硬边渗色。
 * 渐变、纯色与近纯色气泡重建：在原始帧上完整验证每个物理清字框，按渐变重建、纯色字形重建及容忍 JPEG 轻微压缩噪声的近纯色气泡快路径（伴随 1 像素内边界羽化）依次判定；纯确定性修补页不等待模型队列或初始化模型，混合页仅将其余复杂区域交给 LaMa，现有透明保护路径保持。
 * 旋转短标签：先在原图上尝试逐列恢复。实际写入成功才告知绘制方保留这个修补结果，避免后续均匀填色覆盖书脊底纹。
 * 模块边界：不读取网页 DOM、不上传图像、不翻译文字；均匀气泡无需加载模型，最后的译文排版由 mangaRendering 处理，模型生成内容始终局限于检测文字蒙版。
 */
import {localWasmThreads, paceLocalInference} from '@/src/shared/onnx/resources';
import {mangaInferenceClient, mangaExtensionUrl, type MangaPatch} from './mangaInferenceClient';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {protectMangaSession} from './mangaSessionFallback';
import {assertOnnxWasmRuntimeSupported, configureOnnxWasmBackend, resolveOnnxWasmAssetPaths} from '@/src/shared/onnx/wasmBinary';
import {assertMangaOcrActive, loadMangaInpaintAsset, MANGA_INPAINT_ASSET, withMangaModelAdmission} from './mangaOcrAssets';
import {mangaRegionBackground, type MangaBackground} from './mangaRendering';
import type {MangaRegion} from './mangaRegions';
import {mangaMaskBoxes as maskBoxes,createMangaMaskFontResolver} from '../mangaPatchResult';
import {isMangaAlphaProtected,type MangaAlphaProtection} from './mangaAlphaProtection';
import {planImageGradientRepair} from './inpainting';
import {planImageFlatTextRepair} from './flatTextRepair';

export type {MangaPatch} from './mangaInferenceClient';
interface PatchMapping {patch: MangaPatch; left: number; top: number; sourceWidth: number; sourceHeight: number; contentWidth: number; contentHeight: number; alpha?: number; protection?:MangaAlphaProtection}
interface InpaintPort {run(patch: MangaPatch, signal?:AbortSignal, progress?:(percent?:number,initializing?:boolean)=>void): Promise<Float32Array>; release(): Promise<void>}

/** 完整一像素外周包含并集的真实边界；重叠内周也要求一致，只会更保守，不读取图外像素。 */
function uniformMaskAlpha(pixels: Uint8ClampedArray, width: number, height: number, boxes: ReturnType<typeof maskBoxes>): number | undefined {
    let alpha: number | undefined;
    const matches = (x: number, y: number) => {
        const value = pixels[(y * width + x) * 4 + 3];
        if (alpha === undefined) alpha = value;
        return alpha === value;
    };
    for (const box of boxes) {
        if (box.x0 <= 0 || box.y0 <= 0 || box.x1 >= width || box.y1 >= height || box.x1 <= box.x0 || box.y1 <= box.y0) return;
        for (let x = box.x0 - 1; x <= box.x1; x += 1) {
            if (!matches(x, box.y0 - 1) || !matches(x, box.y1)) return;
        }
        for (let y = box.y0; y < box.y1; y += 1) {
            if (!matches(box.x0 - 1, y) || !matches(box.x1, y)) return;
        }
    }
    return alpha;
}

/** 识别框已有字形留白，蒙版按原始行分别构造，避免把整个段落之间的画面也擦除。 */
export function createMangaPatch(pixels: Uint8ClampedArray, width: number, height: number, region: MangaRegion, protection?:MangaAlphaProtection): PatchMapping {
    const box = region.bbox, padding = Math.max(24, Math.round(region.fontSize));
    const left = Math.max(0, Math.floor(box.x0) - padding), top = Math.max(0, Math.floor(box.y0) - padding);
    const sourceWidth = Math.min(width, Math.ceil(box.x1) + padding) - left;
    const sourceHeight = Math.min(height, Math.ceil(box.y1) + padding) - top;
    const scale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
    const contentWidth = Math.max(1, Math.round(sourceWidth * scale)), contentHeight = Math.max(1, Math.round(sourceHeight * scale));
    const patchWidth = Math.ceil(contentWidth / 64) * 64;
    const patchHeight = Math.ceil(contentHeight / 64) * 64;
    const count = patchWidth * patchHeight;
    const image = new Float32Array(count * 3), mask = new Float32Array(count);
    let transparent = false;
    for (let y = 0; y < contentHeight; y += 1) {
        const y0 = y * sourceHeight / contentHeight, y1 = (y + 1) * sourceHeight / contentHeight;
        for (let x = 0; x < contentWidth; x += 1) {
            const output = y * patchWidth + x;
            if (scale === 1) {
                const input = ((top + y) * width + left + x) * 4;
                for (let channel = 0; channel < 3; channel++) image[channel * count + output] = pixels[input + channel] / 255;
                transparent ||= pixels[input + 3] !== 255;
                continue;
            }
            // 面积平均抑制缩小后的条纹/棋盘混叠；每个源像素只参与相邻的有界输出格，不分配整页前缀表。
            const x0 = x * sourceWidth / contentWidth, x1 = (x + 1) * sourceWidth / contentWidth;
            let red = 0, green = 0, blue = 0;
            for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
                const weight = (Math.min(sy + 1, y1) - Math.max(sy, y0)) * (Math.min(sx + 1, x1) - Math.max(sx, x0));
                const input = ((top + sy) * width + left + sx) * 4;
                red += pixels[input] * weight; green += pixels[input + 1] * weight; blue += pixels[input + 2] * weight;
                transparent ||= pixels[input + 3] !== 255;
            }
            const divisor = (x1 - x0) * (y1 - y0) * 255;
            image[output] = red / divisor; image[count + output] = green / divisor; image[count * 2 + output] = blue / divisor;
        }
    }
    // 面积格只要与原字形框相交就进入蒙版；小于一个缩小像素的笔画也不能遗漏。
    const boxes = maskBoxes(region,width,height);
    for (const box of boxes) {
        const x0 = Math.min(contentWidth, Math.max(0, Math.floor((box.x0-left)*contentWidth/sourceWidth)));
        const x1 = Math.min(contentWidth, Math.max(0, Math.ceil((box.x1-left)*contentWidth/sourceWidth)));
        const y0 = Math.min(contentHeight, Math.max(0, Math.floor((box.y0-top)*contentHeight/sourceHeight)));
        const y1 = Math.min(contentHeight, Math.max(0, Math.ceil((box.y1-top)*contentHeight/sourceHeight)));
        for (let y = y0; y < y1; y += 1) mask.fill(1,y*patchWidth+x0,y*patchWidth+x1);
    }
    const mirror = (position: number, size: number) => {const value = position % (size * 2); return Math.min(value, size * 2 - 1 - value);};
    for (let y = 0; y < patchHeight; y++) for (let x = 0; x < patchWidth; x++) {
        if (y < contentHeight && x < contentWidth) continue;
        const input = mirror(y, contentHeight) * patchWidth + mirror(x, contentWidth), output = y * patchWidth + x;
        for (let channel = 0; channel < 3; channel++) image[channel * count + output] = image[channel * count + input];
        // 补齐区仅镜像 RGB 上下文；mask 保持 0，避免把洞镜像进模型边缘造成幻觉。
    }
    // 不增加整页扫描或像素数组；采样已确认不透明的补丁沿用原路径。
    const alpha = transparent ? uniformMaskAlpha(pixels,width,height,boxes) : undefined;
    return {patch:{image,mask,width:patchWidth,height:patchHeight},left,top,sourceWidth,sourceHeight,contentWidth,contentHeight,alpha,protection};
}

/** 只回写字形及描边蒙版内的像素，蒙版以外始终使用原图；内侧 2 像素边界按色差门禁做保边羽化。 */
export function applyMangaPatch(pixels: Uint8ClampedArray, width: number, region: MangaRegion, mapping: PatchMapping, output: Float32Array): void {
    const {patch,left,top,sourceWidth,sourceHeight,contentWidth,contentHeight,alpha,protection} = mapping, count = patch.width * patch.height;
    if (output.length !== count * 3) throw new Error('漫画背景修补结果无效');
    for (let index = 0; index < output.length; index++) {
        if (!Number.isFinite(output[index])) throw new Error('漫画背景修补结果无效');
    }
    const height = pixels.length / (width * 4), boxes = maskBoxes(region, width, height);
    const insideAny = (px: number, py: number) => boxes.some(b => px >= b.x0 && px < b.x1 && py >= b.y0 && py < b.y1);
    for (const box of boxes) {
        for (let y = Math.floor(box.y0); y < box.y1; y += 1) for (let x = Math.floor(box.x0); x < box.x1; x += 1) {
            if(protection&&isMangaAlphaProtected(protection,x,y))continue;
            const px = Math.max(0, Math.min(contentWidth - 1, (x - left + .5) * contentWidth / sourceWidth - .5));
            const py = Math.max(0, Math.min(contentHeight - 1, (y - top + .5) * contentHeight / sourceHeight - .5));
            const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(contentWidth - 1, x0 + 1), y1 = Math.min(contentHeight - 1, y0 + 1);
            const tx = px - x0, ty = py - y0, destination = (y * width + x) * 4;
            const sampleChannel = (channel: number) => {
                const row0 = channel * count + y0 * patch.width, row1 = channel * count + y1 * patch.width;
                const upper = output[row0 + x0] * (1 - tx) + output[row0 + x1] * tx;
                const lower = output[row1 + x0] * (1 - tx) + output[row1 + x1] * tx;
                return Math.max(0, Math.min(1, upper * (1 - ty) + lower * ty)) * 255;
            };
            let red = sampleChannel(0), green = sampleChannel(1), blue = sampleChannel(2);
            const dLeft = x - box.x0, dRight = box.x1 - 1 - x, dTop = y - box.y0, dBottom = box.y1 - 1 - y;
            if (Math.min(dLeft, dRight, dTop, dBottom) < 2) {
                let bestDist = 3, borderR = 0, borderG = 0, borderB = 0, hits = 0;
                const probe = (bx: number, by: number, dist: number) => {
                    if (dist > bestDist || bx < 0 || bx >= width || by < 0 || by >= height) return;
                    if (protection && isMangaAlphaProtected(protection, bx, by)) return;
                    if (boxes.length > 1 && insideAny(bx, by)) return;
                    const offset = (by * width + bx) * 4;
                    if (pixels[offset + 3] === 0) return;
                    if (dist < bestDist) { bestDist = dist; borderR = borderG = borderB = hits = 0; }
                    borderR += pixels[offset]; borderG += pixels[offset + 1]; borderB += pixels[offset + 2]; hits++;
                };
                if (dLeft < 2) probe(box.x0 - 1, y, dLeft + 1);
                if (dRight < 2) probe(box.x1, y, dRight + 1);
                if (dTop < 2) probe(x, box.y0 - 1, dTop + 1);
                if (dBottom < 2) probe(x, box.y1, dBottom + 1);
                if (hits > 0) {
                    borderR /= hits; borderG /= hits; borderB /= hits;
                    // 仅对温和色差接缝羽化；硬边（如黑框/角色轮廓）不向内渗色，恒等往返保持零误差。
                    if (Math.max(Math.abs(red - borderR), Math.abs(green - borderG), Math.abs(blue - borderB)) <= 48) {
                        const weight = bestDist === 1 ? .65 : .85;
                        red = red * weight + borderR * (1 - weight);
                        green = green * weight + borderG * (1 - weight);
                        blue = blue * weight + borderB * (1 - weight);
                    }
                }
            }
            pixels[destination] = Math.round(red);
            pixels[destination + 1] = Math.round(green);
            pixels[destination + 2] = Math.round(blue);
            if (alpha !== undefined) pixels[destination+3] = Math.min(pixels[destination+3],alpha);
        }
    }
}

function regionTouchesProtection(protection: MangaAlphaProtection | undefined, boxes: ReturnType<typeof maskBoxes>, border: number): boolean {
    if (!protection) return false;
    return boxes.some(box => protection.rectangles.some(hole =>
        hole.x0 < box.x1 + border && box.x0 - border < hole.x1
        && hole.y0 < box.y1 + border && box.y0 - border < hole.y1));
}

/** 容忍轻微 JPEG 压缩噪声的近纯色气泡快路径；要求完整不透明外周极差在 1..14、无明显梯度/纹理且内部含真实墨迹。 */
function planNearFlatBubbleRepair(pixels: Uint8ClampedArray, width: number, height: number,
    boxes: ReturnType<typeof maskBoxes>, budget: {remaining: number}): ((target: Uint8ClampedArray) => void) | undefined {
    const plans: Array<{
        box: ReturnType<typeof maskBoxes>[number];
        mean: [number, number, number];
        top: Uint8Array; bottom: Uint8Array; left: Uint8Array; right: Uint8Array;
    }> = [];
    for (const box of boxes) {
        const w = box.x1 - box.x0, h = box.y1 - box.y0, area = (w + 2) * (h + 2);
        if (box.x0 < 1 || box.y0 < 1 || box.x1 >= width || box.y1 >= height || area > 262_144 || budget.remaining < area) return undefined;
        budget.remaining -= area;
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        let sumR = 0, sumG = 0, sumB = 0, sqR = 0, sqG = 0, sqB = 0, count = 0;
        const sideSum = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
        const visit = (x: number, y: number, side: number) => {
            const o = (y * width + x) * 4;
            if (pixels[o + 3] !== 255) return false;
            const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
            minR = Math.min(minR, r); maxR = Math.max(maxR, r);
            minG = Math.min(minG, g); maxG = Math.max(maxG, g);
            minB = Math.min(minB, b); maxB = Math.max(maxB, b);
            sumR += r; sumG += g; sumB += b; sqR += r * r; sqG += g * g; sqB += b * b; count++;
            sideSum[side][0] += r; sideSum[side][1] += g; sideSum[side][2] += b; sideSum[side][3]++;
            return true;
        };
        const topStrip = new Uint8Array(w * 3), bottomStrip = new Uint8Array(w * 3);
        const leftStrip = new Uint8Array(h * 3), rightStrip = new Uint8Array(h * 3);
        for (let x = box.x0; x < box.x1; x++) {
            if (!visit(x, box.y0 - 1, 0) || !visit(x, box.y1, 1)) return undefined;
            const idx = (x - box.x0) * 3, to = ((box.y0 - 1) * width + x) * 4, bo = (box.y1 * width + x) * 4;
            topStrip[idx] = pixels[to]; topStrip[idx + 1] = pixels[to + 1]; topStrip[idx + 2] = pixels[to + 2];
            bottomStrip[idx] = pixels[bo]; bottomStrip[idx + 1] = pixels[bo + 1]; bottomStrip[idx + 2] = pixels[bo + 2];
        }
        for (let y = box.y0; y < box.y1; y++) {
            if (!visit(box.x0 - 1, y, 2) || !visit(box.x1, y, 3)) return undefined;
            const idx = (y - box.y0) * 3, lo = (y * width + box.x0 - 1) * 4, ro = (y * width + box.x1) * 4;
            leftStrip[idx] = pixels[lo]; leftStrip[idx + 1] = pixels[lo + 1]; leftStrip[idx + 2] = pixels[lo + 2];
            rightStrip[idx] = pixels[ro]; rightStrip[idx + 1] = pixels[ro + 1]; rightStrip[idx + 2] = pixels[ro + 2];
        }
        // 检查四角透明度和色域，防止角落带孔或突变边。
        if (!visit(box.x0 - 1, box.y0 - 1, 0) || !visit(box.x1, box.y0 - 1, 0)
            || !visit(box.x0 - 1, box.y1, 1) || !visit(box.x1, box.y1, 1)) return undefined;
        const spread = Math.max(maxR - minR, maxG - minG, maxB - minB);
        if (spread < 1 || spread > 14) return undefined;
        const meanR = sumR / count, meanG = sumG / count, meanB = sumB / count;
        if (Math.max(sqR / count - meanR * meanR, sqG / count - meanG * meanG, sqB / count - meanB * meanB) > 16) return undefined;
        for (let c = 0; c < 3; c++) {
            const diff = Math.max(
                Math.abs(sideSum[0][c] / sideSum[0][3] - sideSum[1][c] / sideSum[1][3]),
                Math.abs(sideSum[2][c] / sideSum[2][3] - sideSum[3][c] / sideSum[3][3]),
            );
            if (diff > 6) return undefined;
        }
        let hasInk = false;
        for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
            const o = (y * width + x) * 4;
            if (pixels[o + 3] !== 255) return undefined;
            if (Math.max(Math.abs(pixels[o] - meanR), Math.abs(pixels[o + 1] - meanG), Math.abs(pixels[o + 2] - meanB)) >= 24) hasInk = true;
        }
        if (!hasInk) return undefined;
        plans.push({box, mean: [Math.round(meanR), Math.round(meanG), Math.round(meanB)], top: topStrip, bottom: bottomStrip, left: leftStrip, right: rightStrip});
    }
    return target => {
        for (const {box, mean, top, bottom, left, right} of plans) {
            const [mr, mg, mb] = mean;
            for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
                const o = (y * width + x) * 4;
                const onTop = y === box.y0, onBottom = y === box.y1 - 1, onLeft = x === box.x0, onRight = x === box.x1 - 1;
                if (onTop || onBottom || onLeft || onRight) {
                    let br = 0, bg = 0, bb = 0, hits = 0;
                    if (onTop) { const i = (x - box.x0) * 3; br += top[i]; bg += top[i + 1]; bb += top[i + 2]; hits++; }
                    if (onBottom) { const i = (x - box.x0) * 3; br += bottom[i]; bg += bottom[i + 1]; bb += bottom[i + 2]; hits++; }
                    if (onLeft) { const i = (y - box.y0) * 3; br += left[i]; bg += left[i + 1]; bb += left[i + 2]; hits++; }
                    if (onRight) { const i = (y - box.y0) * 3; br += right[i]; bg += right[i + 1]; bb += right[i + 2]; hits++; }
                    target[o] = Math.round(mr * .65 + (br / hits) * .35);
                    target[o + 1] = Math.round(mg * .65 + (bg / hits) * .35);
                    target[o + 2] = Math.round(mb * .65 + (bb / hits) * .35);
                } else {
                    target[o] = mr; target[o + 1] = mg; target[o + 2] = mb;
                }
                target[o + 3] = 255;
            }
        }
    };
}

export function createMangaInpaintingRuntime(create: (signal?: AbortSignal,progress?:(percent?:number,initializing?:boolean)=>void) => Promise<InpaintPort>) {
    let service: InpaintPort | undefined, idle: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<void> = Promise.resolve();
    let lastPreparing: [percent?: number, initializing?: boolean] | undefined;
    const preparingListeners = new Set<(percent?: number, initializing?: boolean) => void>();
    function emitPreparing(...args: [percent?: number, initializing?: boolean]) {
        lastPreparing = args;
        for (const listener of preparingListeners) listener(...args);
    }
    function queue<T>(operation:()=>Promise<T>) {const result=tail.then(operation);tail=result.then(()=>undefined,()=>undefined);return result;}
    async function release() {clearTimeout(idle);idle=undefined;const current=service;service=undefined;await current?.release();}
    return {
        repair(pixels:Uint8ClampedArray,width:number,height:number,regions:MangaRegion[],signal?:AbortSignal,onPreparing?:(percent?:number,initializing?:boolean)=>void,onRepair?:(done:number,total:number)=>void,backgrounds?:MangaBackground[],options?:{
            reuseUniformPixels?:boolean;protection?:MangaAlphaProtection;onRotatedLabelRestored?:(index:number)=>void;
        }) {
            return withMangaModelAdmission(() => {
                const flatBudget={remaining:2_097_152}, nearFlatBudget={remaining:2_097_152};
                const rotatedRepairs=regions.some(region=>region.quarterTurn)?regions.map((region,index)=>{
                    const sources=region.sourceBoxes??[region.bbox];
                    if(!region.quarterTurn||sources.length!==1)return;
                    const boxes=maskBoxes(region,width,height);
                    if(regionTouchesProtection(options?.protection,boxes,2))return;
                    const [mask]=boxes;
                    const repair=planImageFlatTextRepair(pixels,width,height,{mask,source:sources[0],fontSize:region.fontSize,rotatedLabel:true},flatBudget);
                    if(repair)return(target:Uint8ClampedArray)=>{repair(target);options?.onRotatedLabelRestored?.(index);};
                }):[];
                // 不同标签页的图片任务可以并发到达这里。已确认无需模型的页面
                // 默认复制像素；只有独占调用方显式选择时复用完整均匀页。
                // 不访问端口、队列和空闲计时；缺失分类仍按原流程采样。
                if (regions.every((_,index)=>backgrounds?.[index]?.uniform===true&&!rotatedRepairs[index])) {
                    return Promise.resolve().then(()=>{assertMangaOcrActive(signal);return options?.reuseUniformPixels===true ? pixels : new Uint8ClampedArray(pixels);});
                }
                // 先在未改变的原图上按区域验证透明保护与确定性修补；成功后才执行，不以已修补像素证明后续区域。
                const simpleRepairs = regions.map((region,index) => {
                    if (rotatedRepairs[index]) return rotatedRepairs[index];
                    if (backgrounds?.[index]?.uniform === true) return null;
                    const boxes = maskBoxes(region,width,height);
                    if (regionTouchesProtection(options?.protection, boxes, 1)) return undefined;
                    const sources=region.sourceBoxes??[region.bbox],sourceSize=createMangaMaskFontResolver(region);
                    const repairs = boxes.map((box,sourceIndex) => planImageGradientRepair(pixels,width,
                        box.x0-1,box.y0-1,box.x1-box.x0+2,box.y1-box.y0+2,true)
                        ??planImageFlatTextRepair(pixels,width,height,{mask:box,source:sources[sourceIndex],fontSize:sourceSize(sources[sourceIndex]),vertical:region.vertical},flatBudget));
                    if (repairs.every(Boolean)) return (target:Uint8ClampedArray) => repairs.forEach(repair=>repair!(target));
                    return planNearFlatBubbleRepair(pixels,width,height,boxes,nearFlatBudget);
                });
                if (simpleRepairs.length === regions.length && simpleRepairs.every(repair => repair !== undefined)) {
                    return Promise.resolve().then(()=>{
                        assertMangaOcrActive(signal);
                        const result=options?.reuseUniformPixels===true ? pixels : new Uint8ClampedArray(pixels);
                        simpleRepairs.forEach(repair=>repair?.(result));return result;
                    });
                }
                const stopListening = onPreparing ? (() => {
                    preparingListeners.add(onPreparing);
                    if (lastPreparing) onPreparing(...lastPreparing);
                    const remove = () => { preparingListeners.delete(onPreparing); };
                    signal?.addEventListener('abort', remove, {once: true});
                    return () => { remove(); signal?.removeEventListener('abort', remove); };
                })() : undefined;
                return queue(async()=>{
                assertMangaOcrActive(signal); clearTimeout(idle);
                try {
                    return await (async () => {
                        const result = new Uint8ClampedArray(pixels);
                        const pending = regions.filter((region,index) => {
                            if (!rotatedRepairs[index]&&(backgrounds?.[index] ?? mangaRegionBackground(pixels,width,height,region.bbox)).uniform) return false;
                            const repair=simpleRepairs[index];if(repair){repair(result);return false;}return true;
                        });
                        let completed = 0;
                        for (const region of pending) {
                            assertMangaOcrActive(signal);
                            if (!service) {
                                emitPreparing();
                                try { service = await create(signal, emitPreparing); }
                                finally { lastPreparing = undefined; }
                            }
                            stopListening?.();
                            assertMangaOcrActive(signal);
                            onRepair?.(completed,pending.length);
                            const mapping=createMangaPatch(pixels,width,height,region,options?.protection);
                            const output=await service.run(mapping.patch,signal,onPreparing);
                            assertMangaOcrActive(signal);applyMangaPatch(result,width,region,mapping,output);
                            completed++;onRepair?.(completed,pending.length);
                        }
                        return result;
                    })().catch(async error => {
                        if (signal?.aborted && (error as Error | undefined)?.name === 'AbortError') throw error;
                        const current=service;service=undefined;
                        await Promise.resolve().then(()=>current?.release()).catch(()=>undefined);
                        throw error;
                    });
                } finally {stopListening?.();idle=setTimeout(()=>{void queue(release).catch(()=>undefined);},180000);}
                });
            });
        },
        dispose:()=>queue(release),
    };
}

export async function createBrowserMangaInpainter(signal?:AbortSignal,progress?:(percent?:number,initializing?:boolean)=>void,onBroken?:()=>void):Promise<InpaintPort> {
    assertOnnxWasmRuntimeSupported();
    let lastPercent = -1;
    const model=await loadMangaInpaintAsset(signal,bytes=>{
        const percent=Math.min(99,Math.floor(bytes*100/MANGA_INPAINT_ASSET.bytes));
        if(percent!==lastPercent){lastPercent=percent;progress?.(percent);}
    });assertMangaOcrActive(signal);progress?.(undefined,true);
    const ort=await import('onnxruntime-web/webgpu');ort.env.wasm.numThreads=localWasmThreads();
    configureOnnxWasmBackend(ort.env.wasm,resolveOnnxWasmAssetPaths(mangaExtensionUrl,{leadingSlash:true}));
    const gpu=await probeWebGpu();
    let activeSignal=signal;
    let usingGpu=gpu.available;
    const session=await ort.InferenceSession.create(model,{executionProviders:usingGpu?['webgpu','wasm']:['wasm'],graphOptimizationLevel:'all'}).catch(error=>{
        assertMangaOcrActive(signal);
        if(!usingGpu)throw error;
        usingGpu=false;
        return ort.InferenceSession.create(model,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    });
    if(usingGpu)protectMangaSession(session,async()=>{
        assertMangaOcrActive(activeSignal);
        const bytes=await loadMangaInpaintAsset(activeSignal);assertMangaOcrActive(activeSignal);
        const cpu=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
        try {assertMangaOcrActive(activeSignal);}catch(error){await Promise.resolve().then(()=>cpu.release()).catch(()=>undefined);throw error;}
        return cpu;
    },()=>activeSignal,onBroken);
    try {assertMangaOcrActive(signal);} catch(error) {await Promise.resolve().then(()=>session.release()).catch(()=>undefined);throw error;}
    return {run:async (patch,runSignal)=>{
        activeSignal=runSignal;
        const image=new ort.Tensor('float32',patch.image,[1,3,patch.height,patch.width]);
        const mask=new ort.Tensor('float32',patch.mask,[1,1,patch.height,patch.width]);
        let output:Awaited<ReturnType<typeof session.run>>|undefined;
        try {output=await paceLocalInference(()=>{assertMangaOcrActive(runSignal);return session.run({image,mask});});return new Float32Array(output.inpainted.data as Float32Array);}
        finally {image.dispose();mask.dispose();Object.values(output||{}).forEach(tensor=>tensor.dispose());}
    },release:()=>session.release()};
}

async function createWorkerMangaInpainter(signal?:AbortSignal, progress?:(percent?:number,initializing?:boolean)=>void):Promise<InpaintPort> {
    const notify = (stage: 'preparing' | 'initializing' | 'recognizing', percent?:number) => progress?.(percent,stage==='initializing');
    await mangaInferenceClient.prepare('inpaint',signal,notify);
    return {run:(patch,runSignal,onPreparing)=>mangaInferenceClient.request({type:'inpaint',patch},runSignal,(stage,percent)=>onPreparing?.(percent,stage==='initializing')),release:()=>mangaInferenceClient.release('inpaint')};
}

export const mangaInpaintingRuntime=createMangaInpaintingRuntime(createWorkerMangaInpainter);
