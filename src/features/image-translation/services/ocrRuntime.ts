/**
 * @file src/features/image-translation/services/ocrRuntime.ts
 * 文件职责：将 Tesseract.js Worker 适配为图片翻译可调用的 OCR 服务，配置扩展内 worker/core 资源并按源语言串行执行识别或语言包预下载。
 * 主要内容：配置扩展语言资源、转发引擎任务进度与图片/圈选识别策略；保持竖排检测和空结果一次布局重试，坐标映回原图并按策略隔离有界缓存；合并同图在途任务并独立取消，预处理检查独占像素并为透明前景合成对比底色，不透明原尺寸 PNG 复用原编码，其他输入共用可取消的异步 PNG 编码，JPEG 以浏览器已应用 EXIF 的像素识别；整图借用预检已解码图片，其他路径限时解码，绘制后立即释放自有源像素；公开离屏页面销毁时的 Worker 与结果缓存清理入口。
 * 模块边界：该文件是 Tesseract 基础设施边界，不保存下载状态、不翻译识别文本也不绘制图片；并发所有权由 ocrWorkerRuntime 管理，持久化由后台 repository 负责。
 */
import { createWorker, PSM, type Worker } from 'tesseract.js';
import {
    getAreaOcrImageSize,
    getOcrImageSize,
    getOcrLanguages,
    normalizeOcrLineViews,
    collectRawNumericGuards,
    restoreOcrLineCoordinates,
    type OcrLine,
    type NumericEvidenceOcrLine,
} from '@/src/features/image-translation/core';
import { getImageOcrModelLanguages, type ImageOcrLanguageCode } from '@/src/features/image-translation/ocrLanguages';
import type {DownloadProgress} from '@/src/core/download/progress';
import {removeOcrModelFiles} from './ocrModelCache';
import {prefetchOcrModelFiles} from './ocrModelDownload';
import { createOcrWorkerRuntime, type OcrWorkerPort } from './ocrWorkerRuntime';
import {createSharedOcrTasks} from './sharedOcrTasks';
import {encodeImageCanvas} from './imageEncoding';
import {flattenOcrAlpha} from './ocrPixels';

function extensionAsset(path: string): string {
    const getRuntimeUrl = chrome.runtime.getURL as (assetPath: string) => string;
    return getRuntimeUrl(`/fluent-read-ocr/${path}`);
}

type TesseractRecognitionResult = Awaited<ReturnType<Worker['recognize']>>;
// 6.1.2 内置 core 在遍历语言 vector 时追加 CJK 模型声明的竖排子语言，会使迭代器失效并误读为「;」。
// 所需语言（含 jpn_vert 等竖排模型）已由 getImageOcrModelLanguages 显式传入；初始化时关闭隐式子语言。
// 上游同类修复：https://github.com/tesseract-ocr/tesseract/issues/4002；JS 类型未列出此 core 初始化参数。
const OCR_INIT_CONFIG = {tessedit_load_sublangs: ''} as unknown as Parameters<typeof createWorker>[3];

const ocrWorkerRuntime = createOcrWorkerRuntime<TesseractRecognitionResult>({
    sparseTextMode: PSM.SPARSE_TEXT,
    createWorker: async (languages, onProgress) => createWorker(languages.split('+'), 1, {
        workerPath: extensionAsset('worker/worker.min.js'),
        // 直接指向 SIMD + LSTM 内核：扩展支持的 Chrome/Edge（Offscreen 需 109+）与 Firefox 140+
        // 均支持 WASM SIMD，且只使用 LSTM 引擎；不再打包永远不会被选中的非 SIMD 变体。
        corePath: extensionAsset('core/tesseract-core-simd-lstm.wasm.js'),
        cachePath: 'fluent-read-image-ocr',
        // 不再把 traineddata 打进扩展；Tesseract.js 会从 jsDelivr 按需下载，
        // 并将解压后的语言包缓存到 Offscreen Document 的 IndexedDB。
        // Offscreen 页面拥有扩展源，直接加载本地 worker 可避免 Blob Worker 的 CSP/源限制。
        workerBlobURL: false,
        // SDK 已用原始原因拒绝对应任务 Promise；交由 runtime/调用者处理，避免消息回调再抛全局错误。
        errorHandler: () => {},
        logger: message => {
            if (message.status === 'recognizing text') onProgress(message.progress, message.userJobId);
        },
    }, OCR_INIT_CONFIG) as unknown as Promise<OcrWorkerPort<TesseractRecognitionResult>>,
});

const MAX_CACHED_OCR_IMAGES = 3;
const MAX_CACHED_OCR_BYTES = 12 * 1024 * 1024;
const OCR_IMAGE_DECODE_TIMEOUT_MS = 15_000;
export type OcrRecognitionOptions = {profile?: 'image' | 'area'; onProgress?: (percent: number) => void; decodedImage?: HTMLImageElement; includeMangaNumericConfidence?: boolean};
type RecognitionViews = {ordinary: OcrLine[]; manga: NumericEvidenceOcrLine[]};
const sharedRecognition = createSharedOcrTasks<RecognitionViews>();
const completedRecognitionCache = new Map<string, {views: RecognitionViews; bytes: number}>();
let cachedRecognitionBytes = 0;

function abortRecognition(): Error {
    const error = new Error('图片 OCR 请求已取消');
    error.name = 'AbortError';
    return error;
}

function copyOcrLines(lines: NumericEvidenceOcrLine[], includeEvidence = true): NumericEvidenceOcrLine[] {
    return lines.map(({numericConfidence, ...line}) => ({...line, bbox: {...line.bbox},
        ...(includeEvidence && numericConfidence !== undefined ? {numericConfidence} : {})}));
}

/** 源坐标回映后相同物理框只计一次，避免缩放和 fallback 的重复消耗保护预算。 */
function deduplicateOcrGuards(lines:NumericEvidenceOcrLine[]):NumericEvidenceOcrLine[] {
    const seen=new Set<string>();
    return lines.filter(line=>{
        if(!line.guardOnly)return true;
        const b=line.bbox,key=[b.x0,b.y0,b.x1,b.y1].join(',');
        if(seen.has(key))return false;seen.add(key);return true;
    });
}

function cacheRecognition(key: string, views: RecognitionViews): void {
    const bytes = key.length * 2 + [...views.ordinary, ...views.manga].reduce((total, line) => total + line.text.length * 2 + 64, 0);
    if (bytes > MAX_CACHED_OCR_BYTES) return;
    // 同键在途任务已合并，完成缓存命中直接返回，因此这里只会写入新条目。
    completedRecognitionCache.set(key, {views: {ordinary: copyOcrLines(views.ordinary), manga: copyOcrLines(views.manga)}, bytes});
    cachedRecognitionBytes += bytes;
    while (completedRecognitionCache.size > MAX_CACHED_OCR_IMAGES || cachedRecognitionBytes > MAX_CACHED_OCR_BYTES) {
        const oldestKey = completedRecognitionCache.keys().next().value!;
        cachedRecognitionBytes -= completedRecognitionCache.get(oldestKey)!.bytes;
        completedRecognitionCache.delete(oldestKey);
    }
}

function loadOcrImage(image: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const source = new Image();
        const cleanup = () => {
            clearTimeout(timeout);
            source.onload = null;
            source.onerror = null;
            signal?.removeEventListener('abort', handleAbort);
        };
        const fail = (error: Error) => {
            cleanup();
            source.src = '';
            reject(error);
        };
        const handleAbort = () => fail(abortRecognition());
        const timeout = setTimeout(() => fail(new Error('图片解码超时，请重新圈选或重试')), OCR_IMAGE_DECODE_TIMEOUT_MS);
        source.onload = () => {
            cleanup();
            resolve(source);
        };
        source.onerror = () => fail(new Error('图片数据无法解码'));
        if (signal?.aborted) {
            handleAbort();
            return;
        }
        signal?.addEventListener('abort', handleAbort, {once: true});
        source.src = image;
    });
}

async function prepareOcrImage(image: string, profile: 'image' | 'area', signal?: AbortSignal, decodedImage?: HTMLImageElement) {
    const source = decodedImage ?? await loadOcrImage(image, signal);
    try {
        if (signal?.aborted) throw abortRecognition();
        const sourceWidth = source.naturalWidth || source.width;
        const sourceHeight = source.naturalHeight || source.height;
        const size = profile === 'area'
            ? getAreaOcrImageSize(sourceWidth, sourceHeight)
            : {...getOcrImageSize(sourceWidth, sourceHeight), padding: 0};
        let recognitionImage = image;
        // AVIF/WebP 等格式不一定被内核支持；JPEG 的 EXIF 解析也可能与浏览器不同。
        // PNG 之外复用已解码像素，统一格式并保持识别方向、尺寸和重绘坐标一致。
        const needsRasterEncoding = /^data:image\//iu.test(image) && !/^data:image\/png[;,]/iu.test(image);
        const canvas = document.createElement('canvas');
        try {
            canvas.width = size.width + size.padding * 2;
            canvas.height = size.height + size.padding * 2;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('浏览器不支持图片处理');
            if (size.padding) {
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
            }
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(source, size.padding, size.padding, size.width, size.height);
            // 同源网页也会把透明 WebP/GIF/AVIF 读取为 PNG，不能仅凭 MIME 跳过 alpha。
            // 只修改 OCR 画布独占的像素；源图继续用于保留透明度的译图重绘。
            let flattened = false;
            // 已铺满不透明留白的圈选画布无需额外回读；整图的透明度仍须逐像素检查。
            if (!size.padding) {
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                flattened = flattenOcrAlpha(pixels.data);
                if (flattened) context.putImageData(pixels, 0, 0);
            }
            if (needsRasterEncoding || size.padding || size.width !== sourceWidth || size.height !== sourceHeight || flattened) {
                // 本次画布已拥有像素；只释放自己解码的源，调用方借出的源仍用于后续重绘。
                if (!decodedImage) source.src = '';
                recognitionImage = await encodeImageCanvas(canvas, signal);
            }
        } finally {
            // 绘制、像素检查或编码失败也释放像素；不与 OCR WebAssembly 长期并存。
            canvas.width = 0;
            canvas.height = 0;
        }
        return {recognitionImage, sourceWidth, sourceHeight, size};
    } finally {
        // drawImage 和编码完成后即可释放解码源，不等远端/Worker 识别结束。
        if (!decodedImage) source.src = '';
    }
}

export async function recognizeImage(
    image: string,
    sourceLanguage: string,
    signal?: AbortSignal,
    options: OcrRecognitionOptions = {},
): Promise<NumericEvidenceOcrLine[]> {
    if (signal?.aborted) throw abortRecognition();
    const packs = getOcrLanguages(sourceLanguage);
    const models = getImageOcrModelLanguages(packs);
    const languages = models.join('+');
    // PSM 11 不做竖排判定，会把竖列逐行横读成乱序；PSM 12 在同样的稀疏分割上按版面判定方向，
    // 竖排页交给 *_vert 模型，横排页结果与 PSM 11 一致。缺少 osd 模型只跳过文字方向旋转检测。
    const layoutMode = models.length > packs.length ? PSM.SPARSE_TEXT_OSD : undefined;
    const profile = options.profile ?? 'image';
    const cacheKey = `${profile}\0${languages}\0${image}`;
    const cached = completedRecognitionCache.get(cacheKey);
    if (cached) {
        completedRecognitionCache.delete(cacheKey);
        completedRecognitionCache.set(cacheKey, cached);
        return copyOcrLines(options.includeMangaNumericConfidence ? cached.views.manga : cached.views.ordinary, options.includeMangaNumericConfidence === true);
    }

    const views = await sharedRecognition.run(cacheKey, async (signal, onProgress) => {
        const {recognitionImage, sourceWidth, sourceHeight, size} = await prepareOcrImage(image, profile, signal, options.decodedImage);
        if (signal?.aborted) throw abortRecognition();
        const result = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, layoutMode, onProgress);
        if (signal?.aborted) throw abortRecognition();
        const readLines = (recognition: TesseractRecognitionResult): RecognitionViews => {
            const views = normalizeOcrLineViews(recognition.data.blocks);
            return {
                ordinary: restoreOcrLineCoordinates(views.ordinary, sourceWidth, sourceHeight, size.width, size.height, size.padding),
                // 圈选只读文字不擦图，不需要数字物理保护门禁，避免噪声框阻断合法识别。
                manga: deduplicateOcrGuards(restoreOcrLineCoordinates([...views.manga,...(profile==='area'?[]:collectRawNumericGuards(recognition.data.blocks,views.manga,{trustedWorkerData:true}))], sourceWidth, sourceHeight, size.width, size.height, size.padding)),
            };
        };
        let views = readLines(result);
        if (views.ordinary.length === 0 && (profile === 'area' || (sourceWidth <= 1000 && sourceHeight <= 500))) {
            // 圈选与小图片空结果才尝试单块分割，不给大型整页翻倍耗时，不降低噪声阈值。
            const fallback = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, PSM.SINGLE_BLOCK);
            if (signal?.aborted) throw abortRecognition();
            const firstGuards=views.manga.filter(line=>line.guardOnly);
            views = readLines(fallback);
            views.manga=deduplicateOcrGuards([...views.manga,...firstGuards]);
            if(views.manga.filter(line=>line.guardOnly).length>4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
        }
        // 空结果不是稳定成功；用户重试时应重新识别，避免暂时失败被负缓存永久复用。
        if (views.ordinary.length > 0) cacheRecognition(cacheKey, views);
        return views;
    }, signal, options.onProgress);
    return copyOcrLines(options.includeMangaNumericConfidence ? views.manga : views.ordinary, options.includeMangaNumericConfidence === true);
}

export async function downloadImageOcrLanguages(
    languages: ImageOcrLanguageCode[],
    signal?: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
    const models = getImageOcrModelLanguages(languages);
    // Tesseract.js 自己下载时不回报字节数；先带进度地写好缓存，随后的加载直接命中缓存并验证模型可用。
    await prefetchOcrModelFiles(models, {signal, onProgress});
    await ocrWorkerRuntime.ensureLanguages(models, signal);
}

export async function removeImageOcrLanguages(languages: ImageOcrLanguageCode[]): Promise<void> {
    await ocrWorkerRuntime.clearModels(() => removeOcrModelFiles(getImageOcrModelLanguages(languages)));
    completedRecognitionCache.clear();
    cachedRecognitionBytes = 0;
}

/** 离屏页面退出时终止普通 OCR，取消在途和排队识别并释放完成结果。 */
export function disposeImageOcrWorker(): void {
    ocrWorkerRuntime.dispose();
    completedRecognitionCache.clear();
    cachedRecognitionBytes = 0;
}
