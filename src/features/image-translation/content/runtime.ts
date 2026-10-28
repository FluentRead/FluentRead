/**
 * @file src/features/image-translation/content/runtime.ts
 * 文件职责：实现网页图片翻译的独立悬浮/右键入口、可信目标快照、异步请求所有权和单图及漫画连续模式的原图/译图切换，保持宿主图片与响应式图片资源不变。
 * 主要内容：单图失败提供模型与服务导航，译图操作条随指针隐藏并保留键盘入口；指针局部检查仅在本次调用内复用同图几何与样式读取，第二个重叠命中立即停止，下一帧重新定位；单图识别方式纳入缓存身份，切换后不复用旧结果；在封闭 Shadow DOM 中挂载原生译图，跟随图片盒模型与祖先裁切；合并布局更新，默认 12 张可配置的快速缓存和 100 页/16 MiB 二进制局部结果，靠近视口时直接预合成画布，无文字页只保留轻量完成标记；返页不复用已经取消的预合成，旧任务结束不能删除新任务；漫画状态以订阅快照发送并隔离同步异常，避免订阅变化重复递送或阻断请求和卸载；图片重载、独立服务及模型变化使结果失效；组合按所选成员的安全连接摘要建立响应式依赖，成员变更撤销旧任务与缓存，漫画返页复用结果不等待其他页推理；预合成不得撤下当前译图，单页反馈展示真实阶段与进度，漫画错误恢复跟随图片可见边缘，正常处理与完成隐藏操作条，换图、取消与卸载时释放资源。
 * 模块边界：本运行时在读取预算内异步编码页面允许访问的 Canvas，污染画布先走网页 CORS，再按剩余预算授权后台读取当前任务图片；共用 PNG 编码器处理取消/迟到结果，识别、文本翻译、图像修复与语言包管理位于 background/services，控件交互由 controls 模块提供。
 */
import {imageTranslationFailureCode, imageLocalFailureMessage, type ImageLocalFailure} from '../failure';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import type {ImageTranslationStage} from '../progress';
import { config, subscribeConfig } from '@/src/services/config/store';
import {watch} from 'vue';
import {getCompositeTranslationConfigFingerprint} from '@/src/core/config/compositeTranslation';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {renderWithUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {
    fetchImageInExtension,
    prepareImageOcrLanguages,
    translateImageInExtension,
} from '@/src/features/image-translation/services/client';
import type { OcrLine } from '@/src/features/image-translation/core';
import {fetchPageImageForOcr} from '@/src/features/image-translation/services/remoteImage';
import {encodeImageCanvas} from '@/src/features/image-translation/services/imageEncoding';
import {withImageSourceAuthorization} from './sourceAuthorization';
import {resolveImagePresentation, surfaceStyleToBitmap, presentationMatchesSource, isImagePresentationOccluded, type ImagePresentation} from './presentation';
import {createImageControls, IMAGE_CONTROLS_CSS, type ImageControlPhase, type ImageSettingsSection} from './controls';
import {isImageHoverEligible} from './hoverEligibility';
import {createMangaReader} from './mangaReader';
import type {MangaTranslationStatus} from './mangaSession';
import {imageLoadTracker} from './imageLoads';
import {normalizeMangaCachePages, mangaCachePixelBudget, resolveMangaSite, resolveMangaSourceLanguage} from '@/src/core/config/manga';
import {compressMangaPage, createMangaLightCache, type MangaCompressedPage} from '../mangaPatchResult';
import {composeMangaPage} from './mangaCompositor';
import {createMangaCanvas} from './mangaCanvas';
import {createMangaBackground} from './mangaBackground';
import {createMangaImageSegments, type MangaImageSegment} from './mangaImageSegments';
import {getMangaOcrEngine} from '../ocrLanguages';

const IMAGE_TRANSLATION_OVERLAY = 'fluent-read-image-translation-overlay';
const IMAGE_TRANSLATION_ROOT = 'fluent-read-image-translation-root';
const MIN_IMAGE_WIDTH = 80;
const MIN_IMAGE_HEIGHT = 40;
const IMAGE_READ_TIMEOUT_MS = 15_000;
const IMAGE_TRANSLATION_TIMEOUT_MS = 180_000;
const MAX_IMAGE_READ_PIXELS = 16_000_000;
const MAX_IMAGE_READ_EDGE = 8192;
const MAX_CACHED_IMAGES = 6;
const MAX_CACHED_PIXELS = 8_000_000;

type TranslatedSurface = HTMLImageElement | HTMLCanvasElement;

function surfacePixels(surface: TranslatedSurface): number {
    return surface.tagName === 'CANVAS' ? (surface as HTMLCanvasElement).width * (surface as HTMLCanvasElement).height
        : (surface as HTMLImageElement).naturalWidth * (surface as HTMLImageElement).naturalHeight;
}

type ImageTranslationLine = OcrLine & {backgroundColor: string; sourceText?: string};
type ImageControls = ReturnType<typeof createImageControls>;

interface ImageTranslationState {
    manga?: boolean;
    image: HTMLImageElement;
    presentation: ImagePresentation;
    needsPreparation: boolean;
    localFailure?: ImageLocalFailure;
    errorDetails?: string;
    overlay: HTMLDivElement;
    controls: ImageControls;
    phase: ImageControlPhase;
    abortController: AbortController | null;
    hovered: boolean;
    hoverEntry: boolean;
    hoverTimer: number | null;
    resizeObserver: ResizeObserver | null;
    imageLoadHandler: ((event: Event) => void) | null;
    sourceIdentity: string;
    waitingForImage: boolean;
    lines: ImageTranslationLine[];
    translatedImage: TranslatedSurface | null;
    resultIdentity: string | null;
    sourceStyleLease: {
        opacity: {value: string; priority: string};
        transition: Array<{property: string; value: string; priority: string}>;
        computedOpacity: string;
        hadStyleAttribute: boolean;
    } | null;
}

interface CachedImageTranslation {
    sourceIdentity: string;
    configurationIdentity: string;
    translatedImage: TranslatedSurface | null;
    lines: ImageTranslationLine[];
    pixels: number;
    manga: boolean;
    invalidate: (event: Event) => void;
}

let mounted = false;
let removeListeners: (() => void) | null = null;
let imageOverlayHost: HTMLDivElement | null = null;
let imageOverlayContainer: HTMLDivElement | null = null;
let overlayRecoveryAttempts = 0;
let layoutObserver: MutationObserver | null = null;
let positionFrame: number | null = null;
let configurationRevision = 0;
let stopConfigurationWatch: (() => void) | null = null;
const states = new WeakMap<HTMLImageElement, ImageTranslationState>();
const activeStates = new Set<ImageTranslationState>();
// Map 有明确数量/像素上限；缓存监听原图 load，悬浮状态卸载期间同 URL 重载也不能复用旧位图。
const resultCache = new Map<HTMLImageElement, CachedImageTranslation>();
const lightCache = createMangaLightCache();
let lightKeys = new WeakMap<HTMLImageElement, {key: string; source: string; identity: string}>();
let lightSequence = 0;
const warming = new Map<HTMLImageElement, {controller: AbortController; promise: Promise<void>}>();
let warmTail: Promise<void> = Promise.resolve();

function clearWarmTasks(): void {warming.forEach(task => task.controller.abort()); warming.clear();}
function clearMangaCache(): void {
    clearWarmTasks(); lightCache.clear(); lightKeys = new WeakMap();
    Array.from(resultCache.keys()).forEach(deleteCachedResult);
    mangaCanvas?.resetCache();
    mangaBackground?.resetCache();
    mangaSegments?.resetCache();
}
function forgetLightResult(image: HTMLImageElement): void {
    const key = lightKeys.get(image); if (key) lightCache.remove(key.key);
    lightKeys.delete(image); warming.get(image)?.controller.abort();
}
function lightResult(image: HTMLImageElement): MangaCompressedPage | undefined {
    if (!config.useCache) return;
    const key = lightKeys.get(image);
    if (!key || key.source !== sourceIdentity(image) || key.identity !== configurationIdentity(true)) return;
    return lightCache.get(key.key);
}
function releaseSurface(state: ImageTranslationState): void {
    const surface = state.translatedImage; surface?.remove(); state.translatedImage = null;
    if (surface?.tagName === 'CANVAS' && resultCache.get(state.image)?.translatedImage !== surface) {
        (surface as HTMLCanvasElement).width = 0; (surface as HTMLCanvasElement).height = 0;
    }
}
function saveLightResult(state: ImageTranslationState, page: MangaCompressedPage, identity: string): void {
    forgetLightResult(state.image);
    const key = String(++lightSequence);
    if (lightCache.put(key, page)) lightKeys.set(state.image, {key, source: state.sourceIdentity, identity});
}
/** 独立的单任务合成队列只复用成品，不占用或绕过 OCR 队列。 */
function warmMangaPage(image: HTMLImageElement): Promise<void> {
    const existing = warming.get(image);
    // 移出附近窗口后会立即取消，但 finally 可能尚未清槽；同一检查点返页要串行创建新任务。
    if (existing && !existing.controller.signal.aborted) return existing.promise;
    const page = lightResult(image); if (!page) return Promise.resolve();
    const source = sourceIdentity(image), identity = configurationIdentity(true);
    const controller = new AbortController();
    const task = {controller, promise: Promise.resolve()};
    task.promise = warmTail.catch(() => undefined).then(async () => {
        if (controller.signal.aborted) return;
        // 快速缓存淘汰不代表显示层失效；当前页的显示所有权独立于缓存槽。
        if (states.get(image)?.resultIdentity === identity) return;
        let surface: HTMLCanvasElement | undefined;
        try {
            surface = page.patches.length ? await composeMangaPage(image, page, controller.signal) : undefined;
            if (!mounted || controller.signal.aborted || !image.isConnected || !imageTranslationAllowed(true)
                || !mangaStatus.active || document.hidden || !config.useCache || sourceIdentity(image) !== source
                || configurationIdentity(true) !== identity) {
                if (surface) {surface.width = 0; surface.height = 0;} return;
            }
            // 排队期间也可能已由同步返页接管；丢弃重复合成，不能撤下仍在阅读的译图。
            if (states.get(image)?.resultIdentity === identity) {
                if (surface) {surface.width = 0; surface.height = 0;} return;
            }
            const current = states.get(image) || createState(image); current.manga = true;
            releaseSurface(current);
            current.translatedImage = surface || null; current.lines = page.lines; current.resultIdentity = identity;
            cacheResult(current, identity);
            // 隐藏页只进入快速缓存；真正可见时由同一会话完成显示交接。
            if (current.phase === 'loading') showTranslatedImage(current);
            else removeState(current);
            mangaReader?.schedule();
        } catch (error) {
            if (!controller.signal.aborted) {
                forgetLightResult(image);
                const current = states.get(image);
                if (current) setButtonState(current, 'error', `图片翻译失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }).finally(() => {if (warming.get(image) === task) warming.delete(image);});
    warming.set(image, task); warmTail = task.promise;
    return task.promise;
}
function prepareMangaCachedImages(images: HTMLImageElement[]): void {
    if (!mangaStatus.active || document.hidden || !config.useCache) {clearWarmTasks();return;}
    const nearby = new Set(images);
    warming.forEach((task, image) => {if (!nearby.has(image)) task.controller.abort();});
    for (const image of images) {
        const page = lightResult(image);
        if (!resultCache.has(image) && states.get(image)?.phase !== 'loading'
            && states.get(image)?.resultIdentity !== configurationIdentity(true) && page
            && page.width * page.height <= mangaCachePixelBudget(config.imageTranslationMangaCachePages)) void warmMangaPage(image);
    }
}

let mangaReader: ReturnType<typeof createMangaReader> | null = null;
let mangaCanvas: ReturnType<typeof createMangaCanvas<HTMLCanvasElement>> | null = null;
let mangaBackground: ReturnType<typeof createMangaBackground> | null = null;
let mangaSegments: ReturnType<typeof createMangaImageSegments> | null = null;
let mangaStatus: MangaTranslationStatus = {available: false, active: false, pending: false, errors: 0};
const mangaListeners = new Set<(status: MangaTranslationStatus) => void>();

function notifyMangaListener(listener: (status: MangaTranslationStatus) => void, status: MangaTranslationStatus): void {
    try {listener({...status});}
    catch { /* 界面订阅失败不能阻止其他订阅、翻译调度或原图归还。 */ }
}

export function subscribeMangaTranslation(listener: (status: MangaTranslationStatus) => void): () => void {
    mangaListeners.add(listener);
    notifyMangaListener(listener, mangaStatus);
    return () => { mangaListeners.delete(listener); };
}

export function toggleMangaTranslation(): boolean {
    return mangaReader?.toggle() ?? false;
}

function publishMangaStatus(status: MangaTranslationStatus): void {
    if (!status.active || !status.available) clearWarmTasks();
    mangaStatus = {...status, message: status.pending ? ('message' in status ? status.message : mangaStatus.message) : undefined,
        progress: status.pending ? ('progress' in status ? status.progress : mangaStatus.progress) : undefined,
        stage: status.pending ? ('stage' in status ? status.stage : mangaStatus.stage) : undefined};
    const snapshot = mangaStatus;
    for (const listener of Array.from(mangaListeners)) {
        if (mangaListeners.has(listener)) notifyMangaListener(listener, snapshot);
    }
}

function imageTranslationAllowed(manga: boolean): boolean {
    return config.on && (manga ? config.imageTranslationMangaEnabled !== false : !config.disableImageTranslator);
}

/** 原文对照保留当前可见页的已解码结果；离屏和卸载仍由有界缓存/状态释放负责。 */
function restoreMangaImage(image: HTMLImageElement): void {
    const state = states.get(image);
    if (!state) return;
    if (state.phase === 'loading' || state.resultIdentity === null) { restoreImageTranslation(state); return; }
    restoreOriginalImage(state);
    state.translatedImage?.remove();
    state.controls.hideReader();
    setButtonState(state, 'idle', '查看译图');
    updateOverlayPosition(state);
}

async function translateMangaImage(image: HTMLImageElement): Promise<void> {
    const state = states.get(image) || createState(image);
    state.manga = true;
    await translateImage(state);
}

/** 漫画中的显式单页操作也由会话排队，重试进度、错误和暂停保持同一所有权。 */
function requestImageTranslation(state: ImageTranslationState): void {
    if (state.manga && mangaReader?.status().active) {mangaReader.retry(state.image);return;}
    void translateImage(state);
}

/** 同步交接已完成的漫画结果；不能因其他页在推理而让用户等待或重新识别。 */
function reuseMangaImage(image: HTMLImageElement): boolean {
    const state=states.get(image);
    if (state?.phase==='loading' || !image.isConnected || !imageTranslationAllowed(true)) return false;
    if (state && (sourceIdentity(image)!==state.sourceIdentity || !presentationMatchesSource(image,state.presentation))) return false;
    const identity=configurationIdentity(true);
    if (state && sourceIdentity(image)===state.sourceIdentity && presentationMatchesSource(image,state.presentation) && state.resultIdentity===identity) {
        showTranslatedImage(state);
        return true;
    }
    const cached=resultCache.get(image);
    if (!config.useCache || !cached || cached.sourceIdentity!==sourceIdentity(image) || cached.configurationIdentity!==identity) return false;
    const current=state || createState(image);current.manga=true;
    current.resultIdentity=identity;current.translatedImage=cached.translatedImage;current.lines=cached.lines;
    resultCache.delete(image);resultCache.set(image,cached);
    showTranslatedImage(current);
    return true;
}

function sourceIdentity(image: HTMLImageElement): string {
    return JSON.stringify([
        image.currentSrc || image.src,
        image.getAttribute('src'), image.getAttribute('srcset'), image.getAttribute('sizes'),
        Array.from(image.closest('picture')?.querySelectorAll('source') || []).map(source => [
            source.getAttribute('srcset'), source.getAttribute('sizes'),
            source.getAttribute('media'), source.getAttribute('type'),
        ]),
        imageLoadTracker.revision(image),
    ]);
}

function mangaSourceLanguage(): string {
    return resolveMangaSourceLanguage(window.location?.href || '', config.from, config.imageTranslationMangaSites);
}

function configurationIdentity(manga = false): string {
    const service = config.imageTranslationService || config.service;
    const sourceLanguage = manga ? mangaSourceLanguage() : config.from;
    // 只保留公开翻译语义；端点、请求体、凭据与完整 provider 对象不进入位图缓存键。
    return JSON.stringify([
        configurationRevision,
        sourceLanguage, config.to, service, config.model?.[service], config.customModel?.[service],
        config.modelThinking?.[service], config.system_role?.[service], config.user_role?.[service],
        config.enableAIContext,
        config.minimaxBillingPlan, config.minimaxRegion, config.mimoBillingPlan, config.mimoRegion,
        document.title,
        manga,
        manga ? getMangaOcrEngine(sourceLanguage) : config.imageTranslationOcrEngine,
    ]);
}

function watchTranslationConfiguration(): () => void {
    return watch(() => {
        const service = config.imageTranslationService || config.service;
        const selectedModel = config.model?.[service];
        const customModel = config.customModel?.[service];
        // 组合按成员连接摘要建立依赖；缓存仅保存修订号，不保留原始凭据。
        void getCompositeTranslationConfigFingerprint(config, service);
        // 只建立响应式依赖，不序列化、不保留原始参数副本；结果仅保存单调递增修订号。
        void config.from;
        void config.imageTranslationOcrEngine;
        void config.to;
        void config.useCache;
        void config.system_role?.[service];
        void config.user_role?.[service];
        void config.modelThinking?.[service]?.[selectedModel];
        void config.modelThinking?.[service]?.[customModel];
        void config.customBody?.[service];
        void config.proxy?.[service];
        void config.customOpenAIProviders?.find(provider => provider.id === service)?.endpoint;
        void config.enableAIContext;
        void config.custom;
        void config.newApiUrl;
        void config.deeplx;
        void config.azureOpenaiEndpoint;
        void config.deepseekApiType;
        void config.deepseekThinkingMode;
        void config.minimaxBillingPlan;
        void config.minimaxRegion;
        void config.mimoBillingPlan;
        void config.mimoRegion;
        // 回调中的 UI 文案/动效读取不能反向成为翻译身份依赖。
        return {};
    }, () => {
        configurationRevision += 1;
        clearMangaCache();
        for (const state of activeStates) {
            if (!state.abortController) continue;
            state.abortController.abort();
            state.abortController = null;
            state.waitingForImage = false;
            state.needsPreparation = false;
            setButtonState(state, 'error', '翻译设置已更改，请重试');
        }
        mangaReader?.schedule();
    }, {flush: 'sync', immediate: true});
}

function deleteCachedResult(image: HTMLImageElement): void {
    const cached = resultCache.get(image);
    if (!cached) return;
    image.removeEventListener('load', cached.invalidate);
    resultCache.delete(image);
    const surface = cached.translatedImage;
    if (surface?.tagName === 'CANVAS' && !Array.from(activeStates).some(state => state.translatedImage === surface)) {
        (surface as HTMLCanvasElement).width = 0; (surface as HTMLCanvasElement).height = 0;
    }
}

function trimFastCache(): void {
    const manga = Array.from(resultCache.values()).some(cached => cached.manga);
    const capacity = manga ? normalizeMangaCachePages(config.imageTranslationMangaCachePages) : MAX_CACHED_IMAGES;
    const budget = manga ? mangaCachePixelBudget(config.imageTranslationMangaCachePages) : MAX_CACHED_PIXELS;
    let pixels = Array.from(resultCache.values()).reduce((sum, cached) => sum + cached.pixels, 0);
    while (resultCache.size > capacity || pixels > budget) {
        const oldest = resultCache.keys().next().value!; pixels -= resultCache.get(oldest)!.pixels; deleteCachedResult(oldest);
    }
}

function cacheResult(state: ImageTranslationState, identity: string): void {
    deleteCachedResult(state.image);
    const translatedImage = state.translatedImage;
    const pixels = translatedImage ? surfacePixels(translatedImage) : 0;
    const budget = state.manga ? mangaCachePixelBudget(config.imageTranslationMangaCachePages) : MAX_CACHED_PIXELS;
    if (!config.useCache || pixels > budget) return;
    const cachedSourceIdentity = state.sourceIdentity;
    const invalidate = (event: Event) => {
        imageLoadTracker.loaded(event);
        if (sourceIdentity(state.image) !== cachedSourceIdentity) {deleteCachedResult(state.image); forgetLightResult(state.image);}
    };
    resultCache.set(state.image, {
        sourceIdentity: state.sourceIdentity,
        configurationIdentity: identity,
        translatedImage,
        lines: state.lines,
        pixels,
        manga: state.manga === true,
        invalidate,
    });
    state.image.addEventListener('load', invalidate);
    trimFastCache();
}

function ensureImageOverlayRoot(): HTMLDivElement {
    if (imageOverlayContainer && imageOverlayHost) {
        if (!imageOverlayHost.isConnected) document.documentElement.appendChild(imageOverlayHost);
        return imageOverlayContainer;
    }
    const host = document.createElement('div');
    host.id = IMAGE_TRANSLATION_ROOT;
    host.setAttribute('data-fluent-read-ui', 'image-translation');
    host.style.cssText = [
        'all: initial !important', 'position: fixed !important', 'inset: 0 !important',
        'width: 100vw !important', 'height: 100vh !important',
        'pointer-events: none !important', 'z-index: 2147483645 !important',
    ].join(';');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483645; }
      .${IMAGE_TRANSLATION_OVERLAY} { position: fixed !important; overflow: hidden !important; pointer-events: none !important; box-sizing: border-box !important; }
      .fluent-read-image-translation-bitmap { position: absolute !important; inset: 0 !important; display: block !important; box-sizing: border-box !important; width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; pointer-events: none !important; }
      ${IMAGE_CONTROLS_CSS}
    `;
    const container = document.createElement('div');
    shadow.append(style, container);
    document.documentElement.appendChild(host);
    imageOverlayHost = host;
    imageOverlayContainer = container;
    return container;
}

function removeImageOverlayRoot(): void {
    imageOverlayHost?.remove();
    imageOverlayHost = null;
    imageOverlayContainer = null;
    overlayRecoveryAttempts = 0;
}

function createImageAbortError(): Error {
    const error = new Error('图片翻译已取消');
    error.name = 'AbortError';
    return error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', handleAbort);
        };
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const handleAbort = () => finish(() => reject(createImageAbortError()));
        const timer = window.setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
        // 无论信号是否已经取消，都消费传入 promise 的拒绝，避免并行取消产生 unhandled rejection。
        void promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        if (signal?.aborted) handleAbort();
        else signal?.addEventListener('abort', handleAbort, {once: true});
    });
}

function clearHoverTimer(state: ImageTranslationState): void {
    if (state.hoverTimer !== null) {
        window.clearTimeout(state.hoverTimer);
        state.hoverTimer = null;
    }
}

function scheduleIdleStateRemoval(state: ImageTranslationState): void {
    clearHoverTimer(state);
    if (state.phase !== 'idle' || state.hovered || state.translatedImage) return;
    state.hoverTimer = window.setTimeout(() => {
        state.hoverTimer = null;
        if (state.phase === 'idle' && !state.hovered) removeState(state);
    }, 180);
}

function setStateHovered(state: ImageTranslationState, hovered: boolean): void {
    state.hovered = hovered;
    state.controls.setHovered(hovered);
    if (hovered) clearHoverTimer(state);
    else scheduleIdleStateRemoval(state);
}

function removeState(state: ImageTranslationState): void {
    clearHoverTimer(state);
    state.abortController?.abort();
    state.abortController = null;
    restoreOriginalImage(state);
    state.resizeObserver?.disconnect();
    if (state.imageLoadHandler) state.image.removeEventListener('load', state.imageLoadHandler);
    state.controls.dispose();
    state.overlay.remove();
    activeStates.delete(state);
    syncLayoutObservation();
    if (states.get(state.image) === state) states.delete(state.image);
    if (!state.image.isConnected) {deleteCachedResult(state.image); forgetLightResult(state.image);}
    const surface = state.translatedImage;
    state.translatedImage = null;
    if (surface?.tagName === 'CANVAS' && resultCache.get(state.image)?.translatedImage !== surface) {
        (surface as HTMLCanvasElement).width = 0; (surface as HTMLCanvasElement).height = 0;
    }
}

function setPresentation(state: ImageTranslationState, presentation: ImagePresentation): void {
    const previous = state.presentation;
    if (previous.element !== presentation.element && state.resizeObserver) {
        state.resizeObserver.unobserve?.(previous.element);
        state.resizeObserver.observe(presentation.element);
    }
    state.presentation = presentation;
}

function invalidateSource(state: ImageTranslationState): void {
    forgetLightResult(state.image);
    deleteCachedResult(state.image);
    state.sourceIdentity = sourceIdentity(state.image);
    warming.get(state.image)?.controller.abort();
    state.abortController?.abort();
    state.abortController = null;
    state.waitingForImage = false;
    restoreOriginalImage(state);
    if (!state.sourceStyleLease) setPresentation(state, resolveImagePresentation(state.image));
    releaseSurface(state);
    state.lines = [];
    state.resultIdentity = null;
    state.controls.setLines([]);
    state.needsPreparation = false;
    setButtonState(state, 'idle', '翻译图片');
    scheduleIdleStateRemoval(state);
}

function updateOverlayPosition(state: ImageTranslationState): void {
    if (!state.image.isConnected) {
        removeState(state);
        return;
    }
    if (imageOverlayHost && !imageOverlayHost.isConnected && ++overlayRecoveryAttempts > 2) {
        // 宿主持续拒绝覆盖层时停止自动重挂，恢复原图并释放观察器；下次主动悬停可重试。
        Array.from(activeStates).forEach(removeState);
        removeImageOverlayRoot();
        return;
    }
    ensureImageOverlayRoot();
    state.controls.reader.dataset.theme = config.theme === 'dark' || (config.theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    if (sourceIdentity(state.image) !== state.sourceIdentity || !presentationMatchesSource(state.image, state.presentation)) invalidateSource(state);
    if (state.hoverEntry && state.phase === 'idle' && !isImageHoverEligible(state.image)) {
        removeState(state);
        return;
    }
    if (state.sourceStyleLease && !ownsHiddenImage(state)) {
        // 宿主重新设置 opacity 后不继续覆盖它；恢复显示权，并保留宿主刚写入的样式。
        restoreImageTranslation(state);
        return;
    }
    if (!state.sourceStyleLease) setPresentation(state, resolveImagePresentation(state.image));
    const surface = state.presentation.element;
    if (!surface.isConnected) { invalidateSource(state); return; }
    const rect = surface.getBoundingClientRect();
    const style = getComputedStyle(surface);
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    let opacity = Number.parseFloat(state.sourceStyleLease?.computedOpacity || style.opacity || '1');
    for (let ancestor = surface.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        opacity *= Number.parseFloat(ancestorStyle.opacity || '1');
        // 根节点的 overflow 作用于视口，其 rect 会随整页滚动移走，不能再次作为普通容器裁切。
        // body 在 quirks 模式或根 overflow 为 visible 时也可能把滚动交给视口。
        if (ancestor === document.documentElement || ancestor === document.scrollingElement) continue;
        if (ancestor === document.body) {
            const rootStyle = getComputedStyle(document.documentElement);
            if (rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible') continue;
        }
        const clipsX = /^(hidden|clip|auto|scroll)$/.test(ancestorStyle.overflowX);
        const clipsY = /^(hidden|clip|auto|scroll)$/.test(ancestorStyle.overflowY);
        if (!clipsX && !clipsY) continue;
        const clip = ancestor.getBoundingClientRect();
        const scaleX = ancestor.offsetWidth ? clip.width / ancestor.offsetWidth : 1;
        const scaleY = ancestor.offsetHeight ? clip.height / ancestor.offsetHeight : 1;
        if (clipsX) {
            const clipLeft = clip.left + ancestor.clientLeft * scaleX;
            left = Math.max(left, clipLeft);
            right = Math.min(right, clipLeft + ancestor.clientWidth * scaleX);
        }
        if (clipsY) {
            const clipTop = clip.top + ancestor.clientTop * scaleY;
            top = Math.max(top, clipTop);
            bottom = Math.min(bottom, clipTop + ancestor.clientHeight * scaleY);
        }
    }
    const visible = imageTranslationAllowed(state.manga === true)
        && rect.width >= MIN_IMAGE_WIDTH && rect.height >= MIN_IMAGE_HEIGHT
        && right > left && bottom > top && style.visibility !== 'hidden'
        && style.visibility !== 'collapse' && style.display !== 'none' && opacity > 0;
    const occluded = visible && isImagePresentationOccluded(surface, {left, top, right, bottom}, imageOverlayHost, state.image);
    state.overlay.style.display = visible && !occluded ? 'block' : 'none';
    if (!visible || occluded) {
        // 译层不可见时释放原图，避免移出视口、宿主裁切或布局变化留下空白。
        restoreOriginalImage(state);
        if (occluded) state.controls.hideReader();
        return;
    }
    state.overlay.style.left = `${rect.left}px`;
    state.overlay.style.top = `${rect.top}px`;
    state.overlay.style.width = `${rect.width}px`;
    state.overlay.style.height = `${rect.height}px`;
    state.overlay.style.clipPath = `inset(${top - rect.top}px ${rect.right - right}px ${rect.bottom - bottom}px ${left - rect.left}px)`;
    state.controls.element.style.setProperty('left', `${left - rect.left + 8}px`, 'important');
    state.controls.element.style.setProperty('bottom', `${rect.bottom - bottom + 8}px`, 'important');
    const edgeFeedback = state.manga && (state.phase === 'loading' || state.phase === 'error');
    state.controls.feedback.style.left = `${edgeFeedback ? left - rect.left + 8 : (left + right) / 2 - rect.left}px`;
    state.controls.feedback.style.top = `${edgeFeedback ? top - rect.top + 8 : (top + bottom) / 2 - rect.top}px`;
    state.controls.feedback.style.maxHeight = `${Math.max(0, bottom - top - 16)}px`;
    state.controls.feedback.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
    if (!state.translatedImage || state.phase !== 'translated') return;
    const bitmap = state.translatedImage;
    const scaleX = surface.offsetWidth ? rect.width / surface.offsetWidth : 1;
    const scaleY = surface.offsetHeight ? rect.height / surface.offsetHeight : 1;
    // 原生 replaced element 负责 object-fit 与完整 object-position 语法；滚动仅移动层，不重复解码或绘制整幅 Canvas。
    const fitting = state.presentation.kind === 'background' ? surfaceStyleToBitmap(style)
        : {objectFit: style.objectFit || 'fill', objectPosition: style.objectPosition || '50% 50%'};
    bitmap.style.objectFit = fitting.objectFit;
    bitmap.style.objectPosition = fitting.objectPosition;
    bitmap.style.borderRadius = style.borderRadius;
    bitmap.style.backgroundColor = style.backgroundColor;
    bitmap.style.opacity = String(opacity);
    bitmap.style.filter = style.filter;
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const scale = side === 'Left' || side === 'Right' ? scaleX : scaleY;
        bitmap.style[`padding${side}`] = `${(Number.parseFloat(style[`padding${side}`]) || 0) * scale}px`;
        bitmap.style[`border${side}Width`] = `${(Number.parseFloat(style[`border${side}Width`]) || 0) * scale}px`;
        bitmap.style[`border${side}Style`] = style[`border${side}Style`];
        bitmap.style[`border${side}Color`] = style[`border${side}Color`];
    }
    // 先挂载并布置已解码的译图，再在同一帧交接显示权；加载和不可见状态不隐藏原图。
    if (bitmap.isConnected && state.overlay.isConnected) hideOriginalImage(state);
}

async function openImageTranslationSettings(section: ImageSettingsSection): Promise<void> {
    const response = await sendRuntimeMessage({type: 'openOptionsPage', section,
        ...(section === 'settings-services' ? {service: 'localTranslation'} : {})});
    if (response?.success !== true) throw new Error('无法打开设置，请从扩展菜单打开设置后重试');
}

function createState(image: HTMLImageElement, hoverEntry = false): ImageTranslationState {
    const overlay = document.createElement('div');
    overlay.className = IMAGE_TRANSLATION_OVERLAY;
    overlay.dataset.fluentReadImageTranslation = 'true';
    const controls = createImageControls({
        translate: (source) => translateLegacyText(source, normalizeUiLanguage(config.uiLanguage)),
        onAction: () => {
            const state = states.get(image);
            if (!state || !imageTranslationAllowed(state.manga === true)) return;
            if (state.phase === 'translated' || state.phase === 'loading') restoreImageTranslation(state);
            else requestImageTranslation(state);
        },
        onDismiss: () => { const state = states.get(image); if (state) removeState(state); },
        onInspect: () => {
            const current = states.get(image);
            if (current && !current.controls.reader.hidden) activeStates.forEach(state => {if (state !== current) state.controls.hideReader();});
        },
        onSettings: (section) => {
            const state = states.get(image);
            if (!state) return;
            void openImageTranslationSettings(section).catch(() => {
                if (states.get(image) === state) setButtonState(state, 'error', '无法打开设置，请从扩展菜单打开设置后重试');
            });
        },
        onPrepare: () => {
            const state = states.get(image);
            if (state) void translateImage(state, true);
        },
    });
    overlay.append(controls.feedback, controls.element);
    ensureImageOverlayRoot().append(overlay, controls.reader);
    const state: ImageTranslationState = {
        image, presentation: resolveImagePresentation(image), needsPreparation: false, overlay, controls, phase: 'idle', abortController: null, hovered: true, hoverEntry,
        hoverTimer: null, resizeObserver: null, imageLoadHandler: null,
        sourceIdentity: sourceIdentity(image), waitingForImage: false,
        lines: [], translatedImage: null, resultIdentity: null, sourceStyleLease: null,
    };
    state.imageLoadHandler = (event: Event) => {
        imageLoadTracker.loaded(event);
        // 新源的首次 load 可能晚于 ready 和处理；共享版本只让真正重载或来源变化撤下结果。
        if (state.waitingForImage) state.sourceIdentity = sourceIdentity(image);
        else if (state.sourceIdentity !== sourceIdentity(image)) invalidateSource(state);
        scheduleViewportChange();
    };
    state.resizeObserver = typeof ResizeObserver === 'undefined'
        ? null : new ResizeObserver(scheduleViewportChange);
    state.resizeObserver?.observe(image);
    if (state.presentation.element !== image) state.resizeObserver?.observe(state.presentation.element);
    image.addEventListener('load', state.imageLoadHandler);
    states.set(image, state);
    activeStates.add(state);
    syncLayoutObservation();
    overlay.addEventListener('pointerenter', () => setStateHovered(state, true));
    overlay.addEventListener('pointerleave', () => setStateHovered(state, false));
    overlay.addEventListener('focusin', () => setStateHovered(state, true));
    overlay.addEventListener('focusout', event => {
        if (!(event.relatedTarget instanceof Node) || !overlay.contains(event.relatedTarget)) {
            setStateHovered(state, false);
        }
    });
    setButtonState(state, 'idle', '翻译图片');
    updateOverlayPosition(state);
    return state;
}

function showImageButton(image: HTMLImageElement): void {
    if (!mounted || !config.on || config.disableImageTranslator || image.closest('[data-fluent-read-ui]') || image.closest('video')) return;
    const existing = states.get(image);
    if ((!existing || existing.phase === 'idle') && !isImageHoverEligible(image)) return;
    const rect = image.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_WIDTH || rect.height < MIN_IMAGE_HEIGHT) return;
    const state = states.get(image) || createState(image, true);
    setStateHovered(state, true);
    updateOverlayPosition(state);
}

function hideImageButton(image: HTMLImageElement): void {
    const state = states.get(image);
    if (!state) return;
    setStateHovered(state, false);
}

/** 先使用网页自己的 CORS 权限读取，整个网络与响应体阶段都可取消且有时限。 */
export function readPageImageInCors(source: string, signal?: AbortSignal, timeoutMs = IMAGE_READ_TIMEOUT_MS): Promise<string> {
    return fetchPageImageForOcr(source, signal, timeoutMs);
}

async function readAuthorizedImage(image: HTMLImageElement, options: {readonly signal?: AbortSignal; readonly timeoutMs?: number}): Promise<string> {
    const source = image.currentSrc || image.src;
    if (!source) throw new Error('图片地址不可用');
    const budget = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(options.timeoutMs, IMAGE_READ_TIMEOUT_MS)) : IMAGE_READ_TIMEOUT_MS;
    const deadline = performance.now() + budget;
    try {return await readPageImageInCors(source, options.signal, budget);}
    catch (readError) {
        if (options.signal?.aborted) throw createImageAbortError();
        // 只有未取得响应的网络/CORS 失败可以改走扩展权限，保留状态、超限、解码和流错误。
        if (!(readError instanceof TypeError)) throw readError;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('图片读取超时');
        return withImageSourceAuthorization(image, source, options.signal, requestId =>
            fetchImageInExtension(source, {...options, requestId, timeoutMs: remaining}));
    }
}

export async function getImageData(
    image: HTMLImageElement,
    options: {readonly signal?: AbortSignal; readonly timeoutMs?: number} = {},
): Promise<string> {
    if (options.signal?.aborted) throw createImageAbortError();
    const budget = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(options.timeoutMs, IMAGE_READ_TIMEOUT_MS)) : IMAGE_READ_TIMEOUT_MS;
    const deadline = performance.now() + budget;
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    if (!originalWidth || !originalHeight) throw new Error('图片尚未加载完成');
    const scale = Math.min(1, MAX_IMAGE_READ_EDGE / Math.max(originalWidth, originalHeight),
        Math.sqrt(MAX_IMAGE_READ_PIXELS / (originalWidth * originalHeight)));
    const width = Math.max(1, Math.floor(originalWidth * scale));
    const height = Math.max(1, Math.floor(originalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        canvas.width = 0;
        canvas.height = 0;
        throw new Error('浏览器不支持图片读取');
    }
    try {
        context.drawImage(image, 0, 0, width, height);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('图片读取超时');
        // PNG 编码本身检查画布污染，省去额外像素回读；等待期间仍保留独占画布。
        return await encodeImageCanvas(canvas, options.signal, {timeoutMs: remaining, message: '图片读取超时'});
    } catch (error) {
        if (!(error instanceof Error) || error.name !== 'SecurityError') throw error;
        canvas.width = 0;
        canvas.height = 0;
        const source = image.currentSrc || image.src;
        if (!source) throw new Error('图片地址不可用');
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('图片读取超时');
        try {
            return await fetchPageImageForOcr(source, options.signal, remaining);
        } catch (readError) {
            if (options.signal?.aborted) throw createImageAbortError();
            // 只有未取得响应的网络/CORS 失败可以改走扩展权限，保留状态、超限、解码和流错误。
            if (!(readError instanceof TypeError)) throw readError;
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error('图片读取超时');
            return withImageSourceAuthorization(image, source, options.signal, requestId =>
                fetchImageInExtension(source, {...options, requestId, timeoutMs: remaining}));
        }
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

async function waitForImageReady(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw createImageAbortError();
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return;
    if (image.complete) throw new Error('图片尚未加载完成');
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            image.removeEventListener('load', onLoad);
            image.removeEventListener('error', onError);
            signal.removeEventListener('abort', onAbort);
        };
        const onLoad = () => {
            cleanup();
            if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
            else reject(new Error('图片尚未加载完成'));
        };
        const onError = () => { cleanup(); reject(new Error('图片加载失败')); };
        const onAbort = () => { cleanup(); reject(createImageAbortError()); };
        image.addEventListener('load', onLoad, {once: true});
        image.addEventListener('error', onError, {once: true});
        signal.addEventListener('abort', onAbort, {once: true});
    });
}

function loadImage(dataUrl: string, signal: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const cleanup = () => {
            image.onload = null;
            image.onerror = null;
            signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            image.src = '';
            reject(createImageAbortError());
        };
        if (signal.aborted) { onAbort(); return; }
        image.onload = () => { cleanup(); resolve(image); };
        image.onerror = () => { cleanup(); reject(new Error('图片数据无法解码')); };
        signal.addEventListener('abort', onAbort, {once: true});
        image.src = dataUrl;
    });
}

function setButtonState(state: ImageTranslationState, phase: ImageControlPhase, message: string, progress?: number, stage?: ImageTranslationStage): void {
    const phaseChanged = state.phase !== phase;
    state.phase = phase;
    if (state.manga && phase === 'loading') publishMangaStatus({...mangaStatus, message, progress, stage});
    state.controls.update(phase, message, {
        prepare: phase === 'error' && state.needsPreparation, animations: config.animations, progress, quiet: state.manga === true,
        modelSettings: phase === 'error' && Boolean(state.localFailure),
        serviceSettings: phase === 'error' && !state.needsPreparation, errorDetails: state.errorDetails,
    });
    // 状态改变本身未必触发下一帧布局；仅阶段切换时布置边缘提示，进度百分比不重复测量图片。
    if (state.manga && phaseChanged && (phase === 'loading' || phase === 'error')) updateOverlayPosition(state);
}

function ownsHiddenImage(state: ImageTranslationState): boolean {
    return state.presentation.element.style.getPropertyValue('opacity') === '0'
        && state.presentation.element.style.getPropertyPriority('opacity') === 'important';
}

function hideOriginalImage(state: ImageTranslationState): void {
    if (state.sourceStyleLease) return;
    const surface = state.presentation.element;
    const style = surface.style;
    state.sourceStyleLease = {
        opacity: {value: style.getPropertyValue('opacity'), priority: style.getPropertyPriority('opacity')},
        transition: ['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior']
            .map(property => ({property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)}))
            .filter(property => Boolean(property.value)),
        computedOpacity: getComputedStyle(surface).opacity || '1',
        hadStyleAttribute: surface.hasAttribute('style'),
    };
    // 在同一帧关闭过渡并隐藏原图，透明译图的擦除区域不会透出下层原文字。
    style.setProperty('transition', 'none', 'important');
    style.setProperty('opacity', '0', 'important');
}

function restoreOriginalImage(state: ImageTranslationState): void {
    const lease = state.sourceStyleLease;
    if (!lease) return;
    const surface = state.presentation.element;
    const style = surface.style;
    const ownsOpacity = ownsHiddenImage(state);
    const ownsTransition = style.getPropertyValue('transition') === 'none'
        && style.getPropertyPriority('transition') === 'important';
    if (ownsOpacity) {
        if (lease.opacity.value) style.setProperty('opacity', lease.opacity.value, lease.opacity.priority);
        else style.removeProperty('opacity');
        // 先在过渡关闭时结算原透明度，再归还 transition，避免恢复原图时发生意外淡入。
        if (ownsTransition) void getComputedStyle(surface).opacity;
    }
    if (ownsTransition) {
        style.removeProperty('transition');
        lease.transition.forEach(property => style.setProperty(property.property, property.value, property.priority));
    }
    if (ownsOpacity && ownsTransition && !lease.hadStyleAttribute && style.length === 0) surface.removeAttribute('style');
    state.sourceStyleLease = null;
}

function showTranslatedImage(state: ImageTranslationState): void {
    const image = state.translatedImage;
    if (image) {
        image.className = 'fluent-read-image-translation-bitmap';
        if (image.tagName === 'IMG') (image as HTMLImageElement).alt = '';
        image.setAttribute('aria-hidden', 'true');
        state.overlay.prepend(image);
    }
    state.controls.setLines(state.lines);
    setButtonState(state, 'translated', image || state.lines.length ? '已翻译 · 点击恢复原图' : '未检测到文字，已保留原图');
    updateOverlayPosition(state);
}

function restoreImageTranslation(state: ImageTranslationState): void {
    state.resultIdentity = null;
    warming.get(state.image)?.controller.abort();
    state.abortController?.abort();
    state.abortController = null;
    state.waitingForImage = false;
    restoreOriginalImage(state);
    releaseSurface(state);
    state.lines = [];
    state.controls.setLines([]);
    state.needsPreparation = false;
    setButtonState(state, 'idle', resultCache.has(state.image) ? '查看译图' : '翻译图片');
    updateOverlayPosition(state);
    scheduleIdleStateRemoval(state);
}

function requestIsCurrent(state: ImageTranslationState, controller: AbortController): boolean {
    if (controller.signal.aborted || state.abortController !== controller || states.get(state.image) !== state) return false;
    if (!state.image.isConnected) { removeState(state); return false; }
    if (sourceIdentity(state.image) !== state.sourceIdentity || !presentationMatchesSource(state.image, state.presentation)) { invalidateSource(state); return false; }
    return true;
}

async function translateImage(state: ImageTranslationState, prepareLanguages = false): Promise<void> {
    // 识别方式改变后，不继续下载旧方式的语言包；新方式在用户的翻译任务内准备自己的资源。
    if (!state.manga && config.imageTranslationOcrEngine === 'paddle') prepareLanguages = false;
    if (state.phase === 'loading' || !state.image.isConnected || !imageTranslationAllowed(state.manga === true)) return;
    state.hoverEntry = false;
    if (sourceIdentity(state.image) !== state.sourceIdentity || !presentationMatchesSource(state.image, state.presentation)) invalidateSource(state);
    clearHoverTimer(state);
    const identity = configurationIdentity(state.manga);
    if (!prepareLanguages && state.resultIdentity === identity && (state.translatedImage || state.manga)) {
        showTranslatedImage(state);
        return;
    }
    const cached = resultCache.get(state.image);
    if (!prepareLanguages && config.useCache && cached?.sourceIdentity === state.sourceIdentity && cached.configurationIdentity === identity) {
        resultCache.delete(state.image);
        resultCache.set(state.image, cached);
        state.resultIdentity = identity;
        state.translatedImage = cached.translatedImage;
        state.lines = cached.lines;
        showTranslatedImage(state);
        return;
    }
    if (!prepareLanguages && state.manga && lightResult(state.image)) {
        setButtonState(state, 'loading', '正在生成译图…');
        await warmMangaPage(state.image);
        return;
    }
    deleteCachedResult(state.image);
    const sourceLanguage = state.manga ? mangaSourceLanguage() : config.from;
    if (state.manga && getMangaOcrEngine(sourceLanguage) === 'tesseract' && config.imageTranslationMangaDownloadConfirmed) prepareLanguages = true;
    state.needsPreparation = false;
    state.localFailure = undefined;
    state.errorDetails = undefined;
    const controller = new AbortController();
    state.abortController = controller;
    let preparingLanguages = prepareLanguages;
    setButtonState(state, 'loading', prepareLanguages ? '正在准备识别语言包…' : '正在读取图片…');
    try {
        if (prepareLanguages) {
            await prepareImageOcrLanguages(sourceLanguage, controller.signal, (percent) => {
                if (requestIsCurrent(state, controller)) setButtonState(state, 'loading', '正在准备识别语言包…', percent, 'preparing');
            });
            preparingLanguages = false;
            if (!requestIsCurrent(state, controller)) return;
            if (configurationIdentity(state.manga) !== identity) throw new Error('翻译设置已更改，请重试');
            setButtonState(state, 'loading', '正在读取图片…');
        }
        state.waitingForImage = !state.image.complete;
        await withTimeout(waitForImageReady(state.image, controller.signal), IMAGE_READ_TIMEOUT_MS, '图片加载超时', controller.signal);
        state.waitingForImage = false;
        if (!requestIsCurrent(state, controller)) return;
        const imageData = await withTimeout(
            getImageData(state.image, {signal: controller.signal, timeoutMs: IMAGE_READ_TIMEOUT_MS}),
            IMAGE_READ_TIMEOUT_MS, '图片读取超时', controller.signal,
        );
        if (!requestIsCurrent(state, controller)) return;
        setButtonState(state, 'loading', '正在识别并翻译…');
        const result = await translateImageInExtension(imageData, sourceLanguage, document.title, {
            ...(state.manga ? {manga: true} : {}),
            signal: controller.signal,
            timeoutMs: state.manga ? 300_000 : IMAGE_TRANSLATION_TIMEOUT_MS,
            onProgress: (stage, progress) => {
                if (!requestIsCurrent(state, controller)) return;
                setButtonState(state, 'loading', stage === 'preparing' ? (state.manga ? '正在准备漫画处理模型…' : '正在准备图片识别模型…') : stage === 'initializing' ? '正在初始化本地模型…' : stage === 'recognizing' ? '正在识别图片文字…'
                    : stage === 'cleaning' ? '正在清除原文…'
                    : stage === 'translating' ? '正在翻译文字…' : '正在生成译图…', stage === 'recognizing' || stage === 'preparing' || stage === 'cleaning' ? progress : undefined, stage);
            },
        });
        if (!requestIsCurrent(state, controller)) return;
        if (state.manga && result.lines.length === 0 && configurationIdentity(state.manga) === identity) {
            restoreOriginalImage(state);
            state.translatedImage?.remove();state.translatedImage = null;
            state.resultIdentity = identity;state.lines = [];
            if (config.useCache) saveLightResult(state, {width: 1, height: 1, patches: [], lines: []}, identity);
            cacheResult(state, identity);
            showTranslatedImage(state);
            return;
        }
        setButtonState(state, 'loading', '正在生成译图…');
        const page = state.manga && result.mangaPatches ? compressMangaPage(result.mangaPatches, result.lines) : undefined;
        const translatedImage = page ? (page.patches.length ? await composeMangaPage(state.image, page, controller.signal) : null)
            : await withTimeout(loadImage(result.image, controller.signal), IMAGE_READ_TIMEOUT_MS, '译图加载超时', controller.signal);
        if (!requestIsCurrent(state, controller)) {
            if (translatedImage?.tagName === 'CANVAS') {(translatedImage as HTMLCanvasElement).width = 0; (translatedImage as HTMLCanvasElement).height = 0;}
            return;
        }
        // 设置在途中变化时不能将旧请求当成新配置的结果；保留原图并让用户直接重试。
        if (configurationIdentity(state.manga) !== identity) {
            if (translatedImage?.tagName === 'CANVAS') {(translatedImage as HTMLCanvasElement).width = 0; (translatedImage as HTMLCanvasElement).height = 0;}
            throw new Error('翻译设置已更改，请重试');
        }
        state.resultIdentity = identity;
        state.translatedImage = translatedImage;
        state.lines = result.lines;
        if (page && config.useCache) saveLightResult(state, page, identity);
        cacheResult(state, identity);
        showTranslatedImage(state);
    } catch (error) {
        if (!requestIsCurrent(state, controller)) return;
        controller.abort();
        const message = error instanceof Error ? error.message : String(error);
        const missingLanguages = !state.manga && (/^图片文字识别需要先下载.+语言包/u.test(message) || message === '请先下载语言包');
        state.needsPreparation = missingLanguages || preparingLanguages;
        state.localFailure = imageTranslationFailureCode(error);
        state.errorDetails = state.localFailure ? message : undefined;
        setButtonState(state, 'error', state.localFailure ? imageLocalFailureMessage(state.localFailure) : missingLanguages
            ? '首次使用需准备识别语言包，下载后自动继续'
            : `图片翻译失败：${message}`);
        scheduleIdleStateRemoval(state);
    } finally {
        if (state.abortController === controller) {
            state.waitingForImage = false;
            state.abortController = null;
        }
    }
}

// 仅保存可信右键产生的 DOM 身份；不按 URL 扫描全页，避免同源多图和菜单打开后换图误命中。
let contextImage: {image: HTMLImageElement; source: string} | null = null;
let pointerImage: HTMLImageElement | null = null;
let pointerMoveFrame: number | null = null;
let pendingPointerMove: {
    target: EventTarget | null;
    clientX: number;
    clientY: number;
    isTrusted: boolean;
    pointerType: string;
} | null = null;
let pointerRevealTimer: number | null = null;
let pointerRevealPoint: {x: number; y: number} | null = null;

function clearPointerRevealTimer(): void {
    if (pointerRevealTimer !== null) window.clearTimeout(pointerRevealTimer);
    pointerRevealTimer = null;
    pointerRevealPoint = null;
}

type PointerHitEvent = Pick<PointerEvent, 'target' | 'clientX' | 'clientY' | 'isTrusted' | 'pointerType'>;

function imageAtPointer(event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): HTMLImageElement | null {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return null;
    // 封闭 Shadow DOM 会把译图指针重定向到 host；按当前图片范围归还所属状态，避免 pointermove 又把操作条隐藏。
    if (target === imageOverlayHost) {
        for (const state of activeStates) {
            const rect = state.image.getBoundingClientRect();
            if (event.clientX >= rect.left && event.clientX < rect.right
                && event.clientY >= rect.top && event.clientY < rect.bottom) return state.image;
        }
        return null;
    }
    if (target.closest('[data-fluent-read-ui]')) return null;
    if (target instanceof HTMLImageElement) return target;
    for (const state of activeStates) {
        if (state.overlay === target || state.overlay.contains(target) || state.controls.reader.contains(target)) return state.image;
    }
    // 只在局部媒体容器里查找覆盖层下的图片；不穿透弹窗，也不扫描整个页面。
    // 嵌套容器会再次包含同图，只在本次命中检查内复用几何与显隐判定；下一帧仍重新读取，避免换图或叠图后沿用旧结果。
    const pointerHits = new Map<HTMLImageElement, boolean>();
    for (let container: Element | null = target, depth = 0; container && depth < 4; container = container.parentElement, depth++) {
        if (container === document.body || container === document.documentElement) break;
        if (container.matches('button, [role="button"], [role="dialog"]')) break;
        let candidate: HTMLImageElement | null = null;
        for (const image of container.querySelectorAll('img')) {
            const cached = pointerHits.get(image);
            let hit = cached;
            if (hit === undefined) {
                const rect = image.getBoundingClientRect();
                hit = rect.width >= MIN_IMAGE_WIDTH && rect.height >= MIN_IMAGE_HEIGHT
                    && event.clientX >= rect.left && event.clientX < rect.right
                    && event.clientY >= rect.top && event.clientY < rect.bottom;
                // 指针每帧都会扫描容器内图片；只有覆盖指针的图片才需要读取计算样式。
                if (hit) {
                    const style = getComputedStyle(image);
                    hit = style.visibility !== 'hidden' && style.display !== 'none';
                }
                pointerHits.set(image, hit);
            }
            if (!hit) continue;
            if (candidate) return null;
            candidate = image;
        }
        if (candidate) return candidate;
    }
    return null;
}

function handlePointerOver(event: PointerHitEvent): void {
    if (!event.isTrusted || event.pointerType === 'touch' || config.imageTranslationHoverEnabled === false) return;
    const image = imageAtPointer(event);
    // 在安排计时器之前过滤；明确发起的翻译仍保留进度、取消和恢复入口。
    const existing = image && states.get(image);
    if (image && (!existing || existing.phase === 'idle') && !isImageHoverEligible(image)) {
        clearPointerRevealTimer();
        if (pointerImage) hideImageButton(pointerImage);
        pointerImage = null;
        return;
    }
    if (pointerImage === image && image && (pointerRevealTimer !== null || states.has(image))) {
        if (pointerRevealTimer !== null) pointerRevealPoint = {x: event.clientX, y: event.clientY};
        return;
    }
    clearPointerRevealTimer();
    if (pointerImage && pointerImage !== image) hideImageButton(pointerImage);
    pointerImage = image;
    if (!image) return;
    if (states.has(image)) {
        showImageButton(image);
        return;
    }
    const source = sourceIdentity(image);
    pointerRevealPoint = {x: event.clientX, y: event.clientY};
    // 同一张图片停留后再显示；快速扫过不创建 DOM、观察器或请求。
    pointerRevealTimer = window.setTimeout(() => {
        const pointer = pointerRevealPoint;
        pointerRevealTimer = null;
        pointerRevealPoint = null;
        if (mounted && pointerImage === image && image.isConnected && sourceIdentity(image) === source
            && config.on && !config.disableImageTranslator && config.imageTranslationHoverEnabled !== false) {
            const rect = image.getBoundingClientRect();
            const pointerStillInside = !pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)
                || (pointer.x >= rect.left && pointer.x < rect.right && pointer.y >= rect.top && pointer.y < rect.bottom);
            const style = getComputedStyle(image);
            if (pointerStillInside && style.display !== 'none' && style.visibility !== 'hidden'
                && isImageHoverEligible(image)) showImageButton(image);
        }
    }, 600);
}

function handlePointerOut(event: PointerEvent): void {
    if (!event.isTrusted) return;
    cancelPointerMoveFrame();
    clearPointerRevealTimer();
    if (pointerImage) hideImageButton(pointerImage);
    pointerImage = null;
}

function cancelPointerMoveFrame(): void {
    if (pointerMoveFrame !== null) window.cancelAnimationFrame(pointerMoveFrame);
    pointerMoveFrame = null;
    pendingPointerMove = null;
}

function handlePointerMove(event: PointerEvent): void {
    if (!event.isTrusted || event.pointerType === 'touch') return;
    if (config.imageTranslationHoverEnabled === false) {
        cancelPointerMoveFrame();
        return;
    }
    pendingPointerMove = {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
        isTrusted: event.isTrusted,
        pointerType: event.pointerType,
    };
    if (pointerMoveFrame !== null) return;
    pointerMoveFrame = window.requestAnimationFrame(() => {
        pointerMoveFrame = null;
        const pending = pendingPointerMove;
        pendingPointerMove = null;
        if (pending) handlePointerOver(pending);
    });
}

function handleImageContextMenu(event: MouseEvent): void {
    if (!event.isTrusted) return;
    const image = config.imageTranslationContextMenuEnabled !== false ? imageAtPointer(event) : null;
    contextImage = image ? {image, source: sourceIdentity(image)} : null;
}

/** 后台只传递原生菜单动作；目标必须匹配本 document 最近一次可信右键的图片快照。 */
export function toggleContextMenuImage(srcUrl?: unknown): boolean {
    const target = contextImage;
    contextImage = null;
    if (!mounted || !config.on || config.disableImageTranslator || config.imageTranslationContextMenuEnabled === false
        || !target?.image.isConnected || sourceIdentity(target.image) !== target.source) return false;
    const image = target.image;
    if (typeof srcUrl === 'string' && srcUrl !== image.currentSrc && srcUrl !== image.src) return false;
    const state = states.get(image) || createState(image);
    if (state.phase === 'translated') restoreImageTranslation(state);
    else requestImageTranslation(state);
    return true;
}

function scheduleOverlayPositionUpdate(): void {
    if (!mounted || activeStates.size === 0 || positionFrame !== null) return;
    positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        activeStates.forEach(updateOverlayPosition);
    });
}

function scheduleViewportChange(): void {
    if (pointerRevealTimer !== null) {
        clearPointerRevealTimer();
        pointerImage = null;
    }
    scheduleOverlayPositionUpdate();
}

function handleLayoutMutations(records: MutationRecord[]): void {
    // 资源替换必须在下一次绘制之前撤下旧译图；一般布局变化合并到一帧。
    const sourceChanged = records.some(record => {
        if (record.type !== 'childList') return ['src', 'srcset', 'sizes', 'media', 'type'].includes(record.attributeName || '');
        // 普通正文的纯文本更新不改变 picture 的声明。仍安排一帧更新位置，
        // 其中会复核响应式选源；移除、样式/头部与 picture 内的变化保持同步复核。
        if (record.removedNodes?.length !== 0 || !record.addedNodes?.length || record.addedNodes.length > 8 || record.target.nodeType !== 1) return true;
        const target = record.target as Element;
        try {
            if (target.closest('picture, head, style')) return true;
            for (const node of record.addedNodes) if (node.nodeType !== 3 && node.nodeType !== 8) return true;
            return false;
        } catch {
            // 宿主覆盖 DOM 方法时保守复核，不让观察回调失去布局更新。
            return true;
        }
    });
    if (sourceChanged) {
        activeStates.forEach(state => {
            if (!state.image.isConnected) removeState(state);
            else if (sourceIdentity(state.image) !== state.sourceIdentity) invalidateSource(state);
        });
        resultCache.forEach((_cached, image) => {
            if (!image.isConnected) deleteCachedResult(image);
        });
    }
    // 无关 DOM 更新不应取消仍在指针下的图片；计时器到期时重新检查位置和资格。
    scheduleOverlayPositionUpdate();
}

/** 空闲时不接收整页变更；首个覆盖层出现时恢复观察，最后一个移除时释放。 */
function syncLayoutObservation(): void {
    if (!mounted || activeStates.size === 0) {
        layoutObserver?.disconnect();
        layoutObserver = null;
        if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
        positionFrame = null;
        return;
    }
    if (layoutObserver) return;
    layoutObserver = new MutationObserver(handleLayoutMutations);
    layoutObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'id', 'data-testid', 'itemprop', 'alt', 'aria-label', 'aria-hidden', 'role', 'href', 'style', 'src', 'srcset', 'sizes', 'media', 'type', 'width', 'height', 'hidden', 'open'],
        childList: true, subtree: true,
    });
}

export function mountImageTranslator(): void {
    if (mounted) return;
    mounted = true;
    stopConfigurationWatch = watchTranslationConfiguration();
    const translateSnapshot = async (image: string, signal: AbortSignal) => {
        const identity = configurationIdentity(true);
        const sourceLanguage = mangaSourceLanguage();
        if (getMangaOcrEngine(sourceLanguage) === 'tesseract' && config.imageTranslationMangaDownloadConfirmed) {
            publishMangaStatus({...mangaStatus, stage: 'preparing'});
            await prepareImageOcrLanguages(sourceLanguage, signal, (progress) => {
                if (signal.aborted || identity !== configurationIdentity(true) || !mangaStatus.active) return;
                publishMangaStatus({...mangaStatus, stage: 'preparing', progress});
            });
        }
        if (signal.aborted || identity !== configurationIdentity(true) || !mangaStatus.active) {
            throw Object.assign(new Error('漫画识别请求已取消'), {name: 'AbortError'});
        }
        return translateImageInExtension(image, sourceLanguage, document.title, {manga: true, signal, timeoutMs: 300_000,
            onProgress: (stage, progress) => {
                if (signal.aborted || identity !== configurationIdentity(true) || !mangaStatus.active) return;
                publishMangaStatus({...mangaStatus, stage, progress});
            }});
    };
    const recovery = {
        retry: (surface: HTMLElement | MangaImageSegment) => mangaReader?.retry(surface) ?? false,
        openSettings: openImageTranslationSettings,
        translateUi: (source: string) => translateLegacyText(source, normalizeUiLanguage(config.uiLanguage)),
    };
    mangaCanvas = createMangaCanvas<HTMLCanvasElement>({
        enabled: () => mounted && imageTranslationAllowed(true),
        configurationIdentity: () => configurationIdentity(true),
        cacheEnabled: () => config.useCache,
        recovery,
        acceptsInteractionLayer: (_canvas, hit) => {
            const selector = resolveMangaSite(window.location.href, config.imageTranslationMangaSites)?.canvasInteractionSelector;
            return !!selector && hit.matches(selector);
        },
        translate: translateSnapshot,
    });
    mangaBackground = createMangaBackground({
        enabled: () => mounted && imageTranslationAllowed(true),
        configurationIdentity: () => configurationIdentity(true),
        cacheEnabled: () => config.useCache,
        recovery,
        ready: () => mangaReader?.schedule(),
        translate: translateSnapshot,
    });
    mangaSegments = createMangaImageSegments({
        enabled: () => mounted && imageTranslationAllowed(true),
        configurationIdentity: () => configurationIdentity(true),
        cacheEnabled: () => config.useCache,
        recovery,
        imageIdentity: sourceIdentity,
        readSource: (image, signal) => readAuthorizedImage(image, {signal}),
        translate: translateSnapshot,
    });
    mangaReader = createMangaReader({
        enabled: () => config.on && config.imageTranslationMangaEnabled !== false,
        siteRules: () => config.imageTranslationMangaSites,
        prefetchPages: () => config.imageTranslationMangaPrefetchPages,
        cachePages: () => config.imageTranslationMangaCachePages,
        identity: image => `${sourceIdentity(image)}:${configurationIdentity(true)}`,
        translate: translateMangaImage,
        reuse: reuseMangaImage,
        warm: prepareMangaCachedImages,
        resetCache: clearMangaCache,
        restore: restoreMangaImage,
        release: image => { const state = states.get(image); if (state) removeState(state); },
        failed: image => states.get(image)?.phase === 'error',
        changed: publishMangaStatus,
        canvas: mangaCanvas,
        background: mangaBackground,
        segments: mangaSegments,
    });
    const stopHoverWatch = subscribeConfig(next => {
        if (next.imageTranslationHoverEnabled !== false && !next.disableImageTranslator && next.on) return;
        cancelPointerMoveFrame();
        clearPointerRevealTimer();
        pointerImage = null;
        activeStates.forEach(state => { if (state.phase === 'idle' && state.hoverEntry) removeState(state); });
    });
    let currentCachePages = config.imageTranslationMangaCachePages;
    let currentUiLanguage = config.uiLanguage;
    const stopLanguageWatch = subscribeConfig(next => {
        if (next.imageTranslationMangaCachePages !== currentCachePages) {currentCachePages = next.imageTranslationMangaCachePages; trimFastCache();}
        mangaReader?.schedule();
        scheduleOverlayPositionUpdate();
        if (next.uiLanguage === currentUiLanguage) return;
        const language = currentUiLanguage = next.uiLanguage;
        renderWithUiLanguageBundle(language, () => {
            if (mounted && currentUiLanguage === language) {
                activeStates.forEach(state => state.controls.refreshLanguage());
                mangaCanvas?.refreshLanguage();mangaBackground?.refreshLanguage();mangaSegments?.refreshLanguage();
            }
        });
    });
    document.addEventListener('contextmenu', handleImageContextMenu, true);
    document.addEventListener('load', imageLoadTracker.loaded, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    window.addEventListener('scroll', scheduleViewportChange, true);
    window.addEventListener('resize', scheduleViewportChange);
    removeListeners = () => {
        stopHoverWatch();
        stopLanguageWatch();
        stopConfigurationWatch?.();
        stopConfigurationWatch = null;
        cancelPointerMoveFrame();
        document.removeEventListener('contextmenu', handleImageContextMenu, true);
        document.removeEventListener('load', imageLoadTracker.loaded, true);
        document.removeEventListener('pointermove', handlePointerMove, true);
        document.removeEventListener('pointerover', handlePointerOver, true);
        document.removeEventListener('pointerout', handlePointerOut, true);
        window.removeEventListener('scroll', scheduleViewportChange, true);
        window.removeEventListener('resize', scheduleViewportChange);
        layoutObserver?.disconnect();
        layoutObserver = null;
        if (positionFrame !== null) {
            window.cancelAnimationFrame(positionFrame);
            positionFrame = null;
        }
    };
}

export function unmountImageTranslator(): void {
    if (!mounted) return;
    mounted = false;
    mangaReader?.dispose();
    mangaReader = null;
    mangaCanvas?.dispose();
    mangaCanvas = null;
    mangaBackground?.dispose();
    mangaBackground = null;
    mangaSegments?.dispose();
    mangaSegments = null;
    clearPointerRevealTimer();
    contextImage = null;
    pointerImage = null;
    removeListeners?.();
    removeListeners = null;
    Array.from(activeStates).forEach(removeState);
    clearMangaCache();
    removeImageOverlayRoot();
    imageLoadTracker.reset();
}
