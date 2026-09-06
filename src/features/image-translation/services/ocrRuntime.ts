/**
 * @file src/features/image-translation/services/ocrRuntime.ts
 * 文件职责：将 Tesseract.js Worker 适配为图片翻译可调用的 OCR 服务，配置扩展内 worker/core 资源并按源语言串行执行识别或语言包预下载。
 * 主要内容：配置扩展语言资源、转发引擎任务进度与图片/圈选识别策略；对图片解码设置超时并释放像素，圈选小图有界放大加边且仅空结果重试单块分割；坐标映回原图并按策略隔离有界缓存。
 * 模块边界：该文件是 Tesseract 基础设施边界，不保存下载状态、不翻译识别文本也不绘制图片；并发所有权由 ocrWorkerRuntime 管理，持久化由后台 repository 负责。
 */
import { createWorker, PSM, type Worker } from 'tesseract.js';
import {
    getAreaOcrImageSize,
    getOcrImageSize,
    getOcrLanguages,
    normalizeOcrLines,
    restoreOcrLineCoordinates,
    type OcrLine,
} from '@/src/features/image-translation/core';
import type { ImageOcrLanguageCode } from '@/src/features/image-translation/ocrLanguages';
import {removeOcrModelFiles} from './ocrModelCache';
import { createOcrWorkerRuntime, type OcrWorkerPort } from './ocrWorkerRuntime';

function extensionAsset(path: string): string {
    const getRuntimeUrl = chrome.runtime.getURL as (assetPath: string) => string;
    return getRuntimeUrl(`/fluent-read-ocr/${path}`);
}

type TesseractRecognitionResult = Awaited<ReturnType<Worker['recognize']>>;
// 6.1.2 内置 core 在遍历语言 vector 时追加 CJK 模型声明的竖排子语言，会使迭代器失效并误读为「;」。
// 所需语言已由 getOcrLanguages 显式传入；初始化时关闭隐式子语言，保留这些已下载主模型。
// 上游同类修复：https://github.com/tesseract-ocr/tesseract/issues/4002；JS 类型未列出此 core 初始化参数。
const OCR_INIT_CONFIG = {tessedit_load_sublangs: ''} as unknown as Parameters<typeof createWorker>[3];

const ocrWorkerRuntime = createOcrWorkerRuntime<TesseractRecognitionResult>({
    sparseTextMode: PSM.SPARSE_TEXT,
    createWorker: async (languages, onProgress) => createWorker(languages.split('+'), 1, {
        workerPath: extensionAsset('worker/worker.min.js'),
        corePath: extensionAsset('core'),
        cachePath: 'fluent-read-image-ocr',
        // 不再把 traineddata 打进扩展；Tesseract.js 会从 jsDelivr 按需下载，
        // 并将解压后的语言包缓存到 Offscreen Document 的 IndexedDB。
        // Offscreen 页面拥有扩展源，直接加载本地 worker 可避免 Blob Worker 的 CSP/源限制。
        workerBlobURL: false,
        logger: message => {
            if (message.status === 'recognizing text') onProgress(message.progress, message.userJobId);
        },
    }, OCR_INIT_CONFIG) as unknown as Promise<OcrWorkerPort<TesseractRecognitionResult>>,
});

const MAX_CACHED_OCR_IMAGES = 3;
const MAX_CACHED_OCR_BYTES = 12 * 1024 * 1024;
const OCR_IMAGE_DECODE_TIMEOUT_MS = 15_000;
export type OcrRecognitionOptions = {profile?: 'image' | 'area'; onProgress?: (percent: number) => void};
const completedRecognitionCache = new Map<string, {lines: OcrLine[]; bytes: number}>();
let cachedRecognitionBytes = 0;

function abortRecognition(): Error {
    const error = new Error('图片 OCR 请求已取消');
    error.name = 'AbortError';
    return error;
}

function copyOcrLines(lines: OcrLine[]): OcrLine[] {
    return lines.map(line => ({...line, bbox: {...line.bbox}}));
}

function cacheRecognition(key: string, lines: OcrLine[]): void {
    const bytes = key.length * 2 + lines.reduce((total, line) => total + line.text.length * 2 + 64, 0);
    if (bytes > MAX_CACHED_OCR_BYTES) return;
    const previous = completedRecognitionCache.get(key);
    if (previous) cachedRecognitionBytes -= previous.bytes;
    completedRecognitionCache.delete(key);
    completedRecognitionCache.set(key, {lines: copyOcrLines(lines), bytes});
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

async function prepareOcrImage(image: string, profile: 'image' | 'area', signal?: AbortSignal) {
    const source = await loadOcrImage(image, signal);
    try {
        if (signal?.aborted) throw abortRecognition();
        const sourceWidth = source.naturalWidth || source.width;
        const sourceHeight = source.naturalHeight || source.height;
        const size = profile === 'area'
            ? getAreaOcrImageSize(sourceWidth, sourceHeight)
            : {...getOcrImageSize(sourceWidth, sourceHeight), padding: 0};
        let recognitionImage = image;
        if (size.padding || size.width !== sourceWidth || size.height !== sourceHeight) {
            const canvas = document.createElement('canvas');
            try {
                canvas.width = size.width + size.padding * 2;
                canvas.height = size.height + size.padding * 2;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('浏览器不支持图片处理');
                if (size.padding) {
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                }
                context.imageSmoothingEnabled = true;
                context.imageSmoothingQuality = 'high';
                context.drawImage(source, size.padding, size.padding, size.width, size.height);
                recognitionImage = canvas.toDataURL('image/png');
            } finally {
                // 绘制或编码失败也释放像素；不与 OCR WebAssembly 长期并存。
                canvas.width = 0;
                canvas.height = 0;
            }
        }
        return {recognitionImage, sourceWidth, sourceHeight, size};
    } finally {
        // drawImage 和编码完成后即可释放解码源，不等远端/Worker 识别结束。
        source.src = '';
    }
}

export async function recognizeImage(
    image: string,
    sourceLanguage: string,
    signal?: AbortSignal,
    options: OcrRecognitionOptions = {},
): Promise<OcrLine[]> {
    if (signal?.aborted) throw abortRecognition();
    const languages = getOcrLanguages(sourceLanguage).join('+');
    const profile = options.profile ?? 'image';
    const cacheKey = `${profile}\0${languages}\0${image}`;
    const cached = completedRecognitionCache.get(cacheKey);
    if (cached) {
        completedRecognitionCache.delete(cacheKey);
        completedRecognitionCache.set(cacheKey, cached);
        return copyOcrLines(cached.lines);
    }

    const {recognitionImage, sourceWidth, sourceHeight, size} = await prepareOcrImage(image, profile, signal);
    if (signal?.aborted) throw abortRecognition();
    const result = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, undefined, options.onProgress);
    if (signal?.aborted) throw abortRecognition();
    const readLines = (recognition: TesseractRecognitionResult) => restoreOcrLineCoordinates(
        normalizeOcrLines(recognition.data.blocks), sourceWidth, sourceHeight, size.width, size.height, size.padding,
    );
    let lines = readLines(result);
    if (profile === 'area' && lines.length === 0) {
        // 空结果才尝试另一种布局假设，不为每次圈选翻倍耗时，也不降低噪声阈值。
        const fallback = await ocrWorkerRuntime.recognize(recognitionImage, languages, signal, PSM.SINGLE_BLOCK);
        if (signal?.aborted) throw abortRecognition();
        lines = readLines(fallback);
    }
    cacheRecognition(cacheKey, lines);
    return lines;
}

export async function downloadImageOcrLanguages(
    languages: ImageOcrLanguageCode[],
    signal?: AbortSignal,
): Promise<void> {
    await ocrWorkerRuntime.ensureLanguages(languages, signal);
}

export async function removeImageOcrLanguages(languages: ImageOcrLanguageCode[]): Promise<void> {
    await ocrWorkerRuntime.clearModels(() => removeOcrModelFiles(languages));
    completedRecognitionCache.clear();
    cachedRecognitionBytes = 0;
}
