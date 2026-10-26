/**
 * @file src/features/image-translation/services/mangaRecognitionInput.ts
 * 文件职责：在锁定的 PaddleOCR 批处理输入中保留三个颜色通道，同时复用原裁切、缩放、排序和解码。
 * 主要内容：借用 SDK 一次读回的独占像素，和旧红通道增强共享每页两百万像素准入；按原读回索引关联稳定宽度排序的批次，完整校验原 RRR 与边缘补齐后才原地改写既有张量；每批进入原生推理前释放像素引用，未知关联保守失败并保存同一异常首因。
 * 模块边界：纯输入适配，不导入 SDK 私有函数、不访问模型或全局 Tensor，不新增画布、读回、会话或重试；BGR 为依据上游配置的候选，导出模型的语义和实际质量须独立验证。
 */
import {createMangaOcrColorAdapter, createMangaOcrColorAdmission, type MangaOcrColorAdapter, type MangaOcrColorImage} from './mangaOcrColor';

export const MANGA_RECOGNITION_INPUT_RECORDS = 8192;
export interface MangaRecognitionRun {cropCount: number; batchSize: number; enabled: boolean}
interface Crop {width: number; index: number; data?: Uint8ClampedArray}
interface Run {enabled: boolean; count: number; batchSize: number; crops: Crop[]; ordered?: Crop[]; offset: number}

/** 一个实例仅用于串行识别；RGB 参数供固定对照，产品调用使用默认 BGR，不按识别输出选通道。 */
export function createMangaRecognitionInput(order: 'bgr' | 'rgb' = 'bgr') {
    const admission = createMangaOcrColorAdmission(), legacy = createMangaOcrColorAdapter(admission);
    let run: Run | undefined, failure: {error: unknown} | undefined;
    let signal: AbortSignal | undefined, active = false, retainedPixels = 0;
    const fail = (error: unknown) => {failure ??= {error};};
    const mismatch = () => {
        const error = new Error('漫画识别输入批次不匹配，已保留原图');fail(error);throw error;
    };
    const clear = () => {
        if (run) for (const crop of run.crops) crop.data = undefined;
        run = undefined;retainedPixels = 0;
    };
    const adapter: MangaOcrColorAdapter = {
        beginPage(pageSignal) {clear();failure = undefined;signal = pageSignal;active = true;legacy.beginPage(pageSignal);},
        endPage() {clear();failure = undefined;signal = undefined;active = false;legacy.endPage();},
        transform<Image extends MangaOcrColorImage, Result>(width: number, height: number,
            read: () => Image, replace: (image: Image) => Result): Result | undefined {
            const scope = run;
            if (!scope?.enabled) return legacy.transform(width, height, read, replace);
            if (scope.ordered || scope.crops.length >= scope.count || !Number.isSafeInteger(width) || width < 8 || height !== 48) return mismatch();
            const crop: Crop = {width, index: scope.crops.length};scope.crops.push(crop);
            // 未准入行仍保留原序尺寸；预算拒绝时旧流程也不会增强，不能再扣第二份账本。
            const page = admission.take(width, height);
            if (page === undefined) return;
            try {
                const image = read(), data = image.data;
                if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) return mismatch();
                if (scope !== run || !admission.current(page)) return;
                crop.data = data;retainedPixels += width * height;
                // 原读回保持完整 RGB，不能先运行只改变 R 的旧增强。
                return replace(image);
            } catch (error) {fail(error);throw error;}
        },
    };
    return {
        adapter,
        fail,
        get retainedPixels() {return retainedPixels;},
        get pendingReads() {return run?.crops.filter(crop => crop.data !== undefined).length ?? 0;},
        beginRun(options: MangaRecognitionRun) {
            if (run) return mismatch();
            failure = undefined;
            run = {enabled: active && options.enabled && Number.isSafeInteger(options.cropCount)
                && options.cropCount > 0 && options.cropCount <= MANGA_RECOGNITION_INPUT_RECORDS
                && Number.isSafeInteger(options.batchSize) && options.batchSize > 0,
                count: options.cropCount, batchSize: options.batchSize, crops: [], offset: 0};
        },
        /** 只接收原 Tensor 构造参数；先验证整批，绝不在失败后留下半批三通道数据。 */
        patchInput(args: readonly unknown[]) {
            const scope = run;
            if (!scope?.enabled) return;
            if (signal?.aborted) {
                const error = new DOMException('漫画识别已取消', 'AbortError');fail(error);throw error;
            }
            if (failure) throw failure.error;
            const [type, data, dimensions] = args;
            if (args.length !== 3 || type !== 'float32' || !(data instanceof Float32Array) || !Array.isArray(dimensions)
                || dimensions.length !== 4 || !dimensions.every(value => Number.isSafeInteger(value) && value > 0)) return mismatch();
            const [count, channels, height, width] = dimensions;
            if (channels !== 3 || height !== 48 || data.length !== count * channels * height * width
                || scope.crops.length !== scope.count) return mismatch();
            // 6.6 的 preprocessImage 在 await 前同步 resize/read；同宽行以原 read index 保持稳定身份。
            scope.ordered ??= [...scope.crops].sort((a, b) => a.width - b.width || a.index - b.index);
            const chunk = scope.ordered.slice(scope.offset, scope.offset + scope.batchSize);
            if (count !== chunk.length || !chunk.length || width !== Math.max(...chunk.map(crop => crop.width))) return mismatch();
            const plane = height * width;
            if (chunk.some(crop => crop.data !== undefined)) {
                // RRR 相等仅是完整性校验；同 R 异 G/B 的身份来自稳定原索引，而非像素相似。
                for (let row = 0; row < count; row++) {
                    const crop = chunk[row], source = crop.data, base = row * 3 * plane;
                    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                        const offset = y * width + x, value = data[base + offset];
                        if (!(value >= -1 && value <= 1) || value !== data[base + plane + offset] || value !== data[base + plane * 2 + offset]) return mismatch();
                        if (source && value !== Math.fround(source[(y * crop.width + Math.min(x, crop.width - 1)) * 4] * (1 / 127.5) - 1)) return mismatch();
                    }
                }
                for (let row = 0; row < count; row++) {
                    const crop = chunk[row], source = crop.data;
                    if (!source) continue;
                    const base = row * 3 * plane;
                    for (let channel = 0; channel < 3; channel++) {
                        const color = order === 'bgr' ? 2 - channel : channel;
                        for (let y = 0; y < height; y++) {
                            const target = base + channel * plane + y * width;
                            for (let x = 0; x < crop.width; x++) data[target + x] = source[(y * crop.width + x) * 4 + color] * (1 / 127.5) - 1;
                            data.fill(data[target + crop.width - 1], target + crop.width, target + width);
                        }
                    }
                }
            }
            for (const crop of chunk) {
                if (crop.data) retainedPixels -= crop.width * height;
                crop.data = undefined;
            }
            scope.offset += count;
        },
        /** SDK 可吞预处理错误；保存的首因须在 super.run 收尾后以同一对象重抛。 */
        endRun(completed = true) {
            if (completed && !failure && run?.enabled && run.crops.some(crop => crop.data !== undefined)) {
                fail(new Error('漫画识别输入批次不完整，已保留原图'));
            }
            const first = failure;clear();failure = undefined;
            if (first) throw first.error;
        },
    };
}
