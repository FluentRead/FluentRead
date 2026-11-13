/**
 * @file src/features/image-translation/services/ocrRuntime.ts
 * 文件职责：将 Tesseract.js Worker 适配为图片翻译可调用的 OCR 服务，配置扩展内 worker/core 资源并按源语言串行执行识别或语言包预下载。
 * 主要内容：配置扩展语言资源和真实进度；文档页使用自动分栏与独立的九百万像素预算、空结果退回稀疏分割；表格等已定位区域可直接稀疏复核，布局模式独立缓存且不重复空回退；数字上下标候选从同一识别图像中按两种倍率裁剪重读，按需复用解码源和有界画布，无法确认的框携带核对标记且不进入完成缓存；图片/圈选保持原策略，缓存按用途隔离；保留竖排检测、坐标回映、在途合并与独立取消；透明前景只在 OCR 独占像素上合成底色，PNG 以外格式统一异步编码，借用或释放解码源并及时清理画布；公开 Worker 与缓存清理入口；显式重新识别跳过已完成缓存及在途合并，并保留独立取消身份。
 * 文档源文保真：低置信度数字词在字形和出现位置完整对应时保留原读数，并附原页核对框；列表圆点须经重复缩进与原像素确认，再独立交给 PDF 段落分析；两者都复用按需解码源，未确认候选不缓存为可靠结果。
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
import {numericEvidenceKey} from './mangaNumeric';
import {recoverDocumentOcrScripts} from './documentOcrScripts';
import {retainDocumentOcrNumbers} from './documentOcrNumbers';
import {recoverDocumentOcrBullets} from './documentOcrBullets';

function extensionAsset(path: string): string {
    const getRuntimeUrl = chrome.runtime.getURL as (assetPath: string) => string;
    return getRuntimeUrl(`/fluent-read-ocr/${path}`);
}

type TesseractRecognitionResult = Awaited<ReturnType<Worker['recognize']>>;
// 原内置 core 在遍历语言 vector 时追加 CJK 模型声明的竖排子语言，会使迭代器失效并误读为「;」。
// 所需语言（含 jpn_vert 等竖排模型）已由 getImageOcrModelLanguages 显式传入；初始化时关闭隐式子语言。
// 上游同类修复：https://github.com/tesseract-ocr/tesseract/issues/4002；JS 类型未列出此 core 初始化参数。
const OCR_INIT_CONFIG = {tessedit_load_sublangs: ''} as unknown as Parameters<typeof createWorker>[3];

const ocrWorkerRuntime = createOcrWorkerRuntime<TesseractRecognitionResult>({
    sparseTextMode: PSM.SPARSE_TEXT,
    createWorker: async (languages, onProgress) => createWorker(languages.split('+'), 1, {
        workerPath: extensionAsset('worker/worker.min.js'),
        // 直接指向 SIMD + LSTM 内核：扩展支持的 Chrome/Edge（Offscreen 需 109+）与 Firefox 140+
        // 均支持 WASM SIMD，且只使用 LSTM 引擎。只打包这一内核，维持已支持浏览器的同一资源路径。
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
export type OcrRecognitionOptions = {useCache?: boolean; profile?: 'image' | 'area' | 'document'; documentLayout?: 'auto' | 'sparse'; onProgress?: (percent: number) => void; decodedImage?: HTMLImageElement; includeMangaNumericConfidence?: boolean};
type RecognitionViews = {ordinary: OcrLine[]; manga: NumericEvidenceOcrLine[]};
const sharedRecognition = createSharedOcrTasks<RecognitionViews>();
const completedRecognitionCache = new Map<string, {views: RecognitionViews; bytes: number}>();
/** 识别框只包住实际墨迹，缺少 g/p/y 的末行会偏矮；文档分段使用引擎行指标，不能据框高误判小字。 */
function documentLineMetrics(lines: OcrLine[], result: TesseractRecognitionResult): OcrLine[] {
    const rows: Array<{bbox: OcrLine['bbox']; baseline: number; fontSize: number}> = [];
    for (const block of result.data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
        const row = line.rowAttributes?.rowHeight, baseline = line.baseline;
        if (!row || !baseline || ![row, baseline.y0, baseline.y1].every(Number.isFinite)) continue;
        const height = line.bbox.y1 - line.bbox.y0;
        if (row < height * .7 || row > height * 2.5 || Math.abs(baseline.y1 - baseline.y0) > row * .3
            || baseline.y0 < line.bbox.y0 || baseline.y0 > line.bbox.y1 + height * .3) continue;
        rows.push({bbox: line.bbox, baseline: (baseline.y0 + baseline.y1) / 2, fontSize: row * .85});
    }
    return lines.map(line => {
        if (line.vertical) return line;
        // 同一引擎行可能横跨两栏；规范化会按词间距拆开，子行仍使用唯一包含它的原始行指标。
        const candidates = rows.filter(row => row.bbox.x0 <= line.bbox.x0 && row.bbox.x1 >= line.bbox.x1
            && row.bbox.y0 <= line.bbox.y0 && row.bbox.y1 >= line.bbox.y1);
        return candidates.length === 1 ? {...line, baseline: candidates[0].baseline, fontSize: candidates[0].fontSize} : line;
    });
}

/** 数字脚标和圆点列表按需复用一个页面解码源；局部画布在结束、失败和取消时释放。 */
async function readDocumentLines(image: string, result: TesseractRecognitionResult, languages: string, signal: AbortSignal): Promise<RecognitionViews> {
    let source: HTMLImageElement | undefined;
    let canvas: HTMLCanvasElement | undefined;
    try {
        const recovered = await recoverDocumentOcrScripts(result.data.blocks, async (box, scale) => {
            signal.throwIfAborted();
            source ??= await loadOcrImage(image, signal);
            signal.throwIfAborted();
            const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
            const x = Math.max(0, box.x0 - 2), y = Math.max(0, box.y0 - 2);
            const cropWidth = Math.min(width, box.x1 + 2) - x, cropHeight = Math.min(height, box.y1 + 2) - y;
            if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height || cropWidth * scale > 992 || cropHeight * scale > 992) return {text: '', confidence: 0};
            canvas ??= document.createElement('canvas');
            canvas.width = Math.ceil(cropWidth * scale) + 32; canvas.height = Math.ceil(cropHeight * scale) + 32;
            const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
            if (!context) throw new Error('浏览器不支持图片处理');
            context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
            context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
            context.drawImage(source, x, y, cropWidth, cropHeight, 16, 16, cropWidth * scale, cropHeight * scale);
            const crop = await encodeImageCanvas(canvas, signal);
            const recognized = await ocrWorkerRuntime.recognize(crop, languages, signal, PSM.SINGLE_WORD);
            return {text: recognized.data.text, confidence: recognized.data.confidence};
        }, signal);
        const views = normalizeOcrLineViews(recovered.blocks);
        const ordinary = documentLineMetrics(retainDocumentOcrNumbers(recovered.blocks, views.ordinary), result);
        views.ordinary = await recoverDocumentOcrBullets(recovered.blocks, ordinary, async box => {
            signal.throwIfAborted();
            source ??= await loadOcrImage(image, signal);
            signal.throwIfAborted();
            const x = Math.floor(box.x0), y = Math.floor(box.y0), width = Math.ceil(box.x1) - x, height = Math.ceil(box.y1) - y;
            const sourceWidth = source.naturalWidth || source.width, sourceHeight = source.naturalHeight || source.height;
            const outside = x < 0 || y < 0 || box.x1 > sourceWidth || box.y1 > sourceHeight;
            if (outside || width > 64 || height > 64) return {width: 0, height: 0, data: new Uint8ClampedArray()};
            canvas ??= document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
            if (!context) throw new Error('浏览器不支持图片处理');
            context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.imageSmoothingEnabled = false;
            context.drawImage(source, x, y, width, height, 0, 0, width, height);
            return context.getImageData(0, 0, width, height);
        }, signal);
        for (const bbox of recovered.unresolved) views.ordinary.push({text: '', bbox, documentReview: true});
        return views;
    } finally {
        if (source) source.src = '';
        if (canvas) canvas.width = canvas.height = 0;
    }
}
let cachedRecognitionBytes = 0;
let uncachedRecognitionSequence = 0;

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
    const seen=new Map<string,{line:NumericEvidenceOcrLine;key:string}>();
    return lines.filter(line=>{
        if(!line.guardOnly)return true;
        // 唯一生产者 collectRawNumericGuards 保证每个守卫均带原始证据；缺失时抛错，保留原图。
        const value=numericEvidenceKey(line.numericGuardText!);
        const b=line.bbox,key=[b.x0,b.y0,b.x1,b.y1].join(',');
        const previous=seen.get(key);
        if(previous){
            if(line.numericGuardConflict || previous.key!==value)previous.line.numericGuardConflict=true;
            return false;
        }
        seen.set(key,{line,key:value});return true;
    });
}

function cacheRecognition(key: string, views: RecognitionViews): void {
    const lines:NumericEvidenceOcrLine[]=[...views.ordinary, ...views.manga];
    const bytes = key.length * 2 + lines.reduce((total, line) => total + (line.text.length + (line.numericGuardText?.length ?? 0)) * 2 + 64, 0);
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

async function prepareOcrImage(image: string, profile: 'image' | 'area' | 'document', signal?: AbortSignal, decodedImage?: HTMLImageElement) {
    const source = decodedImage ?? await loadOcrImage(image, signal);
    try {
        if (signal?.aborted) throw abortRecognition();
        const sourceWidth = source.naturalWidth || source.width;
        const sourceHeight = source.naturalHeight || source.height;
        const size = profile === 'area'
            ? getAreaOcrImageSize(sourceWidth, sourceHeight)
            : {...getOcrImageSize(sourceWidth, sourceHeight, profile), padding: 0};
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
    const profile = options.profile ?? 'image';
    const layoutMode = profile === 'document' ? options.documentLayout === 'sparse' ? PSM.SPARSE_TEXT : PSM.AUTO : models.length > packs.length ? PSM.SPARSE_TEXT_OSD : undefined;
    const cacheKey = `${profile}${profile === 'document' ? `:${layoutMode}` : ''}\0${languages}\0${image}`;
    const cached = options.useCache === false ? undefined : completedRecognitionCache.get(cacheKey);
    if (cached) {
        completedRecognitionCache.delete(cacheKey);
        completedRecognitionCache.set(cacheKey, cached);
        return copyOcrLines(options.includeMangaNumericConfidence ? cached.views.manga : cached.views.ordinary, options.includeMangaNumericConfidence === true);
    }

    // 显式重识别拥有独立操作身份，不复用缓存或同图在途任务，也不覆盖正在使用的普通缓存。
    const operationKey = options.useCache === false ? `${cacheKey}\0fresh:${++uncachedRecognitionSequence}` : cacheKey;
    const views = await sharedRecognition.run(operationKey, async (signal, onProgress) => {
        const {recognitionImage, sourceWidth, sourceHeight, size} = await prepareOcrImage(image, profile, signal, options.decodedImage);
        if (signal?.aborted) throw abortRecognition();
        const result = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, layoutMode, onProgress);
        if (signal?.aborted) throw abortRecognition();
        const readLines = async (recognition: TesseractRecognitionResult): Promise<RecognitionViews> => {
            const views = profile === 'document' ? await readDocumentLines(recognitionImage, recognition, languages, signal) : normalizeOcrLineViews(recognition.data.blocks);
            return {
                ordinary: restoreOcrLineCoordinates(views.ordinary, sourceWidth, sourceHeight, size.width, size.height, size.padding),
                // 圈选与文档只读文字，不需要图片擦除用的数字守卫；文档使用独立的原页核对框。
                manga: deduplicateOcrGuards(restoreOcrLineCoordinates([...views.manga,...(profile==='image'?collectRawNumericGuards(recognition.data.blocks,views.manga,{trustedWorkerData:true}):[])], sourceWidth, sourceHeight, size.width, size.height, size.padding)),
            };
        };
        let views = await readLines(result);
        if (!views.ordinary.some(line => line.text.trim()) && (profile === 'document' ? layoutMode !== PSM.SPARSE_TEXT : profile === 'area' || (sourceWidth <= 1000 && sourceHeight <= 500))) {
            // 文档可能只含少量独立标题，自动分栏为空时试一次稀疏文字；其它用途维持原有单块回退。
            const fallback = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, profile === 'document' ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK);
            if (signal?.aborted) throw abortRecognition();
            const firstGuards=views.manga.filter(line=>line.guardOnly);
            views = await readLines(fallback);
            views.manga=deduplicateOcrGuards([...views.manga,...firstGuards]);
            if(views.manga.filter(line=>line.guardOnly).length>4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
        }
        // 空结果不是稳定成功；用户重试时应重新识别，避免暂时失败被负缓存永久复用。
        if (options.useCache !== false && views.ordinary.some(line => line.text.trim()) && !views.ordinary.some(line => line.documentReview)) cacheRecognition(cacheKey, views);
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
