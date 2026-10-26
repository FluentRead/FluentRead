/**
 * @file src/features/image-translation/services/mangaOcrColor.ts
 * 文件职责：在原页有界预算内，为已经裁切并缩到四十八像素高的识别副本补足红通道缺失的颜色对比。
 * 主要内容：完整不透明边缘须共享零或二百五十五的红通道端点，按边缘亮度极值锚定整数亮度，仅增强端点对比；灰阶保持原值，失败、取消或超预算均回原处理；可与三通道输入共享同一页准入账本，一次读回只扣一次预算。
 * 模块边界：不检测文字、不猜原文、不访问模型或全局画布；只装饰指定上下文的一次既有读回并借用独占 ImageData，按原页重置预算，处理器与画布生命周期仍归调用方。
 */
export const MANGA_OCR_COLOR_CROP_PIXELS = 262_144;
export const MANGA_OCR_COLOR_PAGE_PIXELS = 2_000_000;

export interface MangaOcrColorImage {readonly data: Uint8ClampedArray;}
export interface MangaOcrColorAdmission {
    beginPage(signal?: AbortSignal): void;
    endPage(): void;
    take(width: number, height: number): number | undefined;
    current(page: number): boolean;
}
export interface MangaOcrColorAdapter {
    beginPage(signal?: AbortSignal): void;
    endPage(): void;
    /** read 必须返回独占副本；replace 仅在红通道确有变化时执行，undefined 表示使用原识别路径。 */
    transform<Image extends MangaOcrColorImage, Result>(width: number, height: number,
        read: () => Image, replace: (image: Image) => Result): Result | undefined;
}

function luminance(red: number, green: number, blue: number): number {
    return Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1000);
}

/** 只检查完整一像素外边；R255 取最大亮度，R0 取最小亮度，不把边缘颜色当作文字真值。 */
function borderAnchor(data: Uint8ClampedArray, width: number, height: number): {red: number; y: number} | undefined {
    const red = data[0];
    if (red !== 0 && red !== 255) return;
    let minY = 255, maxY = 0;
    const matches = (x: number, y: number) => {
        const offset = (y * width + x) * 4;
        if (data[offset] !== red || data[offset + 3] !== 255) return false;
        const value = luminance(red, data[offset + 1], data[offset + 2]);
        minY = Math.min(minY, value);maxY = Math.max(maxY, value);
        return true;
    };
    for (let x = 0; x < width; x += 1) {
        if (!matches(x, 0) || !matches(x, height - 1)) return;
    }
    for (let y = 1; y < height - 1; y += 1) {
        if (!matches(0, y) || (width > 1 && !matches(width - 1, y))) return;
    }
    return {red, y: red === 255 ? maxY : minY};
}

/** 不保存像素；旧红通道增强与三通道输入二选一地消耗同一页预算。 */
export function createMangaOcrColorAdmission(): MangaOcrColorAdmission {
    let generation = 0, active = false, remaining = 0, signal: AbortSignal | undefined;
    const current = (page: number) => active && page === generation && !signal?.aborted;
    return {
        beginPage(pageSignal) {generation += 1;active = true;remaining = MANGA_OCR_COLOR_PAGE_PIXELS;signal = pageSignal;},
        endPage() {generation += 1;active = false;remaining = 0;signal = undefined;},
        current,
        take(width, height) {
            if (!current(generation) || !Number.isSafeInteger(width) || width <= 0 || height !== 48) return;
            const pixels = width * height;
            if (pixels > MANGA_OCR_COLOR_CROP_PIXELS || pixels > remaining) return;
            remaining -= pixels;
            return generation;
        },
    };
}

/** 每个控制器只供同一串行识别服务使用；无参 API 保留独立的旧准入与输出。 */
export function createMangaOcrColorAdapter(admission: MangaOcrColorAdmission = createMangaOcrColorAdmission()): MangaOcrColorAdapter {
    return {
        beginPage: admission.beginPage,
        endPage: admission.endPage,
        transform<Image extends MangaOcrColorImage, Result>(width: number, height: number,
            read: () => Image, replace: (image: Image) => Result): Result | undefined {
            // 在任何读回、校验或颜色变化前扣除；未命中、异常和取消也不退还本页已经请求的工作。
            const page = admission.take(width, height);
            if (page === undefined) return;
            const pixels = width * height;
            try {
                const image = read(), data = image.data;
                if (!(data instanceof Uint8ClampedArray) || data.length !== pixels * 4) return;
                if (!admission.current(page)) return;
                const anchor = borderAnchor(data, width, height);
                if (anchor === undefined) return;
                // 先验证透明度，不让后部的透明像素使前面的独占副本发生无用变更。
                for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 255) return;
                let changed = false;
                for (let offset = 0; offset < data.length; offset += 4) {
                    const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
                    // 任意有效锚点都保持灰色原值，避免黑白漫画逐像素重复乘除。
                    if (red === green && red === blue) continue;
                    const y = luminance(red, green, blue);
                    // 端点约束保证白分母至少76、黑分母至少76；不对任意底色使用全亮度替换。
                    const mapped = anchor.red === 255 ? Math.round(y * 255 / anchor.y)
                        : Math.round((y - anchor.y) * 255 / (255 - anchor.y));
                    const bounded = Math.max(0, Math.min(255, mapped));
                    const value = anchor.red === 255 ? Math.min(red, bounded) : Math.max(red, bounded);
                    if (value !== red) {data[offset] = value;changed = true;}
                }
                if (!changed || !admission.current(page)) return;
                return replace(image);
            } catch {
                // 颜色增强是可选预处理；原生 resize/模型推理在调用方执行，其错误不能被此处吞掉。
                return;
            }
        },
    };
}

/**
 * 仅装饰本上下文的首次既有读回；先恢复原描述符并通知持有者释放钩子，再调用原方法，原生异常不会进入可选颜色回退。
 * SDK 当前四参数整幅读回才参与颜色处理；部分区域、附加 options、其他 this 均原样传递。
 * 安装失败返回 undefined；onRestore 只在已安装钩子首次恢复时通知，其异常不影响原生读取。
 */
export function withMangaOcrColorRead<Args extends unknown[], Image extends MangaOcrColorImage>(
    context: {getImageData(...args: Args): Image}, width: number, height: number, adapter: MangaOcrColorAdapter,
    onRestore?: (restore: () => void) => void,
    onFailure?: (error: unknown) => void,
): (() => void) | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), native = context.getImageData;
    let installed = false;
    const restore = () => {
        if (!installed) return;
        installed = false;
        if (descriptor) Object.defineProperty(context, 'getImageData', descriptor);
        else Reflect.deleteProperty(context, 'getImageData');
        try {onRestore?.(restore);} catch {
            // 持有者的释放通知不能遮盖随后原生读回的返回值或首因。
        }
    };
    const read = function(this: typeof context, ...args: Args): Image {
        const first = installed;
        restore();
        try {
            const image = native.apply(this, args);
            if (!first || this !== context || args.length !== 4 || args[0] !== 0 || args[1] !== 0
                || args[2] !== width || args[3] !== height || height !== 48) return image;
            return adapter.transform(width, height, () => image, changed => changed) ?? image;
        } catch (error) {
            // 只通知调用方保存首因；原生及适配器异常仍按同一对象向上传播。
            try {onFailure?.(error);} catch { /* 通知错误不能覆盖原生首因。 */ }
            throw error;
        }
    };
    try {
        Object.defineProperty(context, 'getImageData', {value: read, configurable: descriptor?.configurable ?? true,
            enumerable: descriptor?.enumerable ?? false, writable: true});
        installed = true;
    } catch {
        // 无法装饰的冻结上下文仍可由 SDK 原生读取，不修改共享原型或放宽像素预算。
    }
    return installed ? restore : undefined;
}
