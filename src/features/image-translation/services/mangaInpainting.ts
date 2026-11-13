/**
 * @file src/features/image-translation/services/mangaInpainting.ts
 * 文件职责：用按需加载的本地 LaMa 漫画模型修补复杂背景上的原字形，保留气泡之外和蒙版之外的原始像素。
 * 主要内容：共享本次原图背景分类，完整确认均匀的页面不等待其他页面的模型修补队列；默认返回独立像素副本，仅显式持有独占像素的调用方可在均匀页复用原缓冲，复杂页始终保留原图与输出分离；按识别行及其有界描边余量建立局部蒙版，按面积相交投影为补丁行段，避免每个补丁像素遍历全部文字行；截取有上下文且最长边不超过 512 的有界补丁，归一化 ONNX 张量并仅回写蒙版区域；所有区域共同跳过原图阶段冻结的低 alpha 行段并保留其四通道，透明补丁仅在完整外周透明度一致时压低 source-over 字形增加的 alpha，不把 RGB 模型当作 alpha 预测器；融合 ONNX 执行图，兼容的硬件 GPU 加速修补、设备失效有界切换 CPU；独立 Worker 串行推理、70% 计算时间预算、滚动取消保留模型端口并由 owner 有界收尾，三分钟空闲释放约束资源。
 * 几何与采样：小补丁保留原像素网格，大补丁等比例面积缩小，随后对称补齐模型尺寸而非分别拉伸横纵；蒙版覆盖所有参与面积采样的源字形，补齐区镜像相同蒙版；输出只从有效内容区按像素中心双线性回填，避免缩放台阶和补齐像素串入原图。
 * 渐变重建：在原始帧上完整验证每个物理清字框，只有全部边界符合双线性渐变且内部不透明时复用确定性重建；纯渐变页不等待模型队列或初始化模型，混合页仅将其余复杂区域交给 LaMa，现有透明保护路径保持。
 * 模块边界：不读取网页 DOM、不上传图像、不翻译文字；均匀气泡无需加载模型，最后的译文排版由 mangaRendering 处理，模型生成内容始终局限于检测文字蒙版。
 */
import {localWasmThreads, paceLocalInference} from '@/src/shared/onnx/resources';
import {mangaInferenceClient, mangaExtensionUrl, type MangaPatch} from './mangaInferenceClient';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {protectMangaSession} from './mangaSessionFallback';
import {configureOnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {assertMangaOcrActive, loadMangaInpaintAsset, MANGA_INPAINT_ASSET, withMangaModelAdmission} from './mangaOcrAssets';
import {mangaRegionBackground, type MangaBackground} from './mangaRendering';
import type {MangaRegion} from './mangaRegions';
import {mangaMaskBoxes as maskBoxes} from '../mangaPatchResult';
import {isMangaAlphaProtected,type MangaAlphaProtection} from './mangaAlphaProtection';
import {planImageGradientRepair} from './inpainting';

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
        mask[output] = mask[input];
    }
    // 不增加整页扫描或像素数组；采样已确认不透明的补丁沿用原路径。
    const alpha = transparent ? uniformMaskAlpha(pixels,width,height,boxes) : undefined;
    return {patch:{image,mask,width:patchWidth,height:patchHeight},left,top,sourceWidth,sourceHeight,contentWidth,contentHeight,alpha,protection};
}

/** 只回写字形及描边蒙版内的像素，蒙版以外始终使用原图。 */
export function applyMangaPatch(pixels: Uint8ClampedArray, width: number, region: MangaRegion, mapping: PatchMapping, output: Float32Array): void {
    const {patch,left,top,sourceWidth,sourceHeight,contentWidth,contentHeight,alpha,protection} = mapping, count = patch.width * patch.height;
    if (output.length !== count * 3 || !output.every(Number.isFinite)) throw new Error('漫画背景修补结果无效');
    for (const box of maskBoxes(region,width,pixels.length/(width*4))) {
        for (let y = Math.floor(box.y0); y < box.y1; y += 1) for (let x = Math.floor(box.x0); x < box.x1; x += 1) {
            if(protection&&isMangaAlphaProtected(protection,x,y))continue;
            const px = Math.max(0, Math.min(contentWidth - 1, (x - left + .5) * contentWidth / sourceWidth - .5));
            const py = Math.max(0, Math.min(contentHeight - 1, (y - top + .5) * contentHeight / sourceHeight - .5));
            const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(contentWidth - 1, x0 + 1), y1 = Math.min(contentHeight - 1, y0 + 1);
            const tx = px - x0, ty = py - y0, destination = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const row0 = channel * count + y0 * patch.width, row1 = channel * count + y1 * patch.width;
                const upper = output[row0 + x0] * (1 - tx) + output[row0 + x1] * tx;
                const lower = output[row1 + x0] * (1 - tx) + output[row1 + x1] * tx;
                pixels[destination + channel] = Math.round(Math.max(0, Math.min(1, upper * (1 - ty) + lower * ty)) * 255);
            }
            if (alpha !== undefined) pixels[destination+3] = Math.min(pixels[destination+3],alpha);
        }
    }
}

export function createMangaInpaintingRuntime(create: (signal?: AbortSignal,progress?:(percent?:number,initializing?:boolean)=>void) => Promise<InpaintPort>) {
    let service: InpaintPort | undefined, idle: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<void> = Promise.resolve();
    function queue<T>(operation:()=>Promise<T>) {const result=tail.then(operation);tail=result.then(()=>undefined,()=>undefined);return result;}
    async function release() {clearTimeout(idle);idle=undefined;const current=service;service=undefined;await current?.release();}
    return {
        repair(pixels:Uint8ClampedArray,width:number,height:number,regions:MangaRegion[],signal?:AbortSignal,onPreparing?:(percent?:number,initializing?:boolean)=>void,onRepair?:(done:number,total:number)=>void,backgrounds?:MangaBackground[],options?:{reuseUniformPixels?:boolean;protection?:MangaAlphaProtection}) {
            return withMangaModelAdmission(() => {
                // 不同标签页的图片任务可以并发到达这里。已确认无需模型的页面
                // 默认复制像素；只有独占调用方显式选择时复用完整均匀页。
                // 不访问端口、队列和空闲计时；缺失分类仍按原流程采样。
                if (regions.every((_,index)=>backgrounds?.[index]?.uniform===true)) {
                    return Promise.resolve().then(()=>{assertMangaOcrActive(signal);return options?.reuseUniformPixels===true ? pixels : new Uint8ClampedArray(pixels);});
                }
                // 先在未改变的原图上验证全部物理行框；成功后才执行，不以已修补像素证明后续区域。
                const gradients = options?.protection ? [] : regions.map((region,index) => {
                    if (backgrounds?.[index]?.uniform === true) return null;
                    const repairs = maskBoxes(region,width,height).map(box => planImageGradientRepair(pixels,width,
                        box.x0-1,box.y0-1,box.x1-box.x0+2,box.y1-box.y0+2,true));
                    return repairs.every(Boolean) ? (target:Uint8ClampedArray) => repairs.forEach(repair=>repair!(target)) : undefined;
                });
                if (gradients.length === regions.length && gradients.every(repair => repair !== undefined)) {
                    return Promise.resolve().then(()=>{
                        assertMangaOcrActive(signal);const result=new Uint8ClampedArray(pixels);
                        gradients.forEach(repair=>repair?.(result));return result;
                    });
                }
                return queue(async()=>{
                assertMangaOcrActive(signal); clearTimeout(idle);
                try {
                    return await (async () => {
                        const result = new Uint8ClampedArray(pixels);
                        const pending = regions.filter((region,index) => {
                            if ((backgrounds?.[index] ?? mangaRegionBackground(pixels,width,height,region.bbox)).uniform) return false;
                            const repair=gradients[index];if(repair){repair(result);return false;}return true;
                        });
                        let completed = 0;
                        for (const region of pending) {
                            assertMangaOcrActive(signal);
                            if (!service) {onPreparing?.();service=await create(signal,onPreparing);}
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
                } finally {idle=setTimeout(()=>{void queue(release).catch(()=>undefined);},180000);}
                });
            });
        },
        dispose:()=>queue(release),
    };
}

export async function createBrowserMangaInpainter(signal?:AbortSignal,progress?:(percent?:number,initializing?:boolean)=>void):Promise<InpaintPort> {
    let lastPercent = -1;
    const model=await loadMangaInpaintAsset(signal,bytes=>{
        const percent=Math.min(99,Math.floor(bytes*100/MANGA_INPAINT_ASSET.bytes));
        if(percent!==lastPercent){lastPercent=percent;progress?.(percent);}
    });assertMangaOcrActive(signal);progress?.(undefined,true);
    const ort=await import('onnxruntime-web/webgpu');ort.env.wasm.numThreads=localWasmThreads();
    configureOnnxWasmBackend(ort.env.wasm,{mjs:mangaExtensionUrl('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'),wasm:mangaExtensionUrl('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm')});
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
    },()=>activeSignal);
    try {assertMangaOcrActive(signal);} catch(error) {await Promise.resolve().then(()=>session.release()).catch(()=>undefined);throw error;}
    return {run:async (patch,runSignal)=>{
        activeSignal=runSignal;
        const image=new ort.Tensor('float32',patch.image,[1,3,patch.height,patch.width]);
        const mask=new ort.Tensor('float32',patch.mask,[1,1,patch.height,patch.width]);
        let output:Awaited<ReturnType<typeof session.run>>|undefined;
        try {output=await paceLocalInference(()=>session.run({image,mask}));return new Float32Array(output.inpainted.data as Float32Array);}
        finally {image.dispose();mask.dispose();Object.values(output||{}).forEach(tensor=>tensor.dispose());}
    },release:()=>session.release()};
}

async function createWorkerMangaInpainter(signal?:AbortSignal, progress?:(percent?:number,initializing?:boolean)=>void):Promise<InpaintPort> {
    const notify = (stage: 'preparing' | 'initializing' | 'recognizing', percent?:number) => progress?.(percent,stage==='initializing');
    await mangaInferenceClient.prepare('inpaint',signal,notify);
    return {run:(patch,runSignal,onPreparing)=>mangaInferenceClient.request({type:'inpaint',patch},runSignal,(stage,percent)=>onPreparing?.(percent,stage==='initializing')),release:()=>mangaInferenceClient.release('inpaint')};
}

export const mangaInpaintingRuntime=createMangaInpaintingRuntime(createWorkerMangaInpainter);
