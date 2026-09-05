/**
 * @file src/features/image-translation/content/runtime.ts
 * 文件职责：实现网页图片翻译的悬浮入口、异步请求所有权和原图/译图切换，保持宿主图片与响应式图片资源不变。
 * 主要内容：在封闭 Shadow DOM 中挂载原生译图，跟随图片盒模型与祖先裁切；合并布局更新，限制像素读取和结果缓存，换图、取消与卸载时停止旧请求并释放资源。
 * 模块边界：本运行时只读取页面允许访问的 Canvas 像素并调用既有图片客户端；识别、文本翻译、图像修复与语言包管理位于 background/services，控件交互由 controls 模块提供。
 */
import { config } from '@/src/services/config/store';
import {watch, watchEffect} from 'vue';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {
    fetchImageInExtension,
    prepareImageOcrLanguages,
    translateImageInExtension,
} from '@/src/features/image-translation/services/client';
import type { OcrLine } from '@/src/features/image-translation/core';
import {imageBufferToDataUrl, MAX_REMOTE_IMAGE_BYTES, normalizeRemoteImageMimeType} from '@/src/features/image-translation/services/remoteImage';
import {createImageControls, IMAGE_CONTROLS_CSS, type ImageControlPhase} from './controls';

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

type ImageTranslationLine = OcrLine & {backgroundColor: string};
type ImageControls = ReturnType<typeof createImageControls>;

interface ImageTranslationState {
    image: HTMLImageElement;
    overlay: HTMLDivElement;
    controls: ImageControls;
    phase: ImageControlPhase;
    abortController: AbortController | null;
    hovered: boolean;
    hoverTimer: number | null;
    resizeObserver: ResizeObserver | null;
    imageLoadHandler: (() => void) | null;
    sourceIdentity: string;
    waitingForImage: boolean;
    lines: ImageTranslationLine[];
    translatedImage: HTMLImageElement | null;
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
    translatedImage: HTMLImageElement;
    lines: ImageTranslationLine[];
    pixels: number;
    invalidate: () => void;
}

let mounted = false;
let removeListeners: (() => void) | null = null;
let imageOverlayHost: HTMLDivElement | null = null;
let imageOverlayContainer: HTMLDivElement | null = null;
let layoutObserver: MutationObserver | null = null;
let positionFrame: number | null = null;
let configurationRevision = 0;
let stopConfigurationWatch: (() => void) | null = null;
const states = new WeakMap<HTMLImageElement, ImageTranslationState>();
const activeStates = new Set<ImageTranslationState>();
// Map 有明确数量/像素上限；缓存监听原图 load，悬浮状态卸载期间同 URL 重载也不能复用旧位图。
const resultCache = new Map<HTMLImageElement, CachedImageTranslation>();

function sourceIdentity(image: HTMLImageElement): string {
    return JSON.stringify([
        image.currentSrc || image.src,
        image.getAttribute('src'), image.getAttribute('srcset'), image.getAttribute('sizes'),
        Array.from(image.closest('picture')?.querySelectorAll('source') || []).map(source => [
            source.getAttribute('srcset'), source.getAttribute('sizes'),
            source.getAttribute('media'), source.getAttribute('type'),
        ]),
    ]);
}

function configurationIdentity(): string {
    const service = config.service;
    // 只保留公开翻译语义；端点、请求体、凭据与完整 provider 对象不进入位图缓存键。
    return JSON.stringify([
        configurationRevision,
        config.from, config.to, service, config.model?.[service], config.customModel?.[service],
        config.modelThinking?.[service], config.system_role?.[service], config.user_role?.[service],
        config.enableAIContext,
        config.minimaxBillingPlan, config.minimaxRegion, config.mimoBillingPlan, config.mimoRegion,
        document.title,
    ]);
}

function watchTranslationConfiguration(): () => void {
    return watchEffect(() => {
        const service = config.service;
        const selectedModel = config.model?.[service];
        const customModel = config.customModel?.[service];
        // 只建立响应式依赖，不序列化、不保留原始参数副本；结果仅保存单调递增修订号。
        void config.from;
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
        configurationRevision += 1;
        Array.from(resultCache.keys()).forEach(deleteCachedResult);
    }, {flush: 'sync'});
}

function deleteCachedResult(image: HTMLImageElement): void {
    const cached = resultCache.get(image);
    if (!cached) return;
    image.removeEventListener('load', cached.invalidate);
    resultCache.delete(image);
}

function cacheResult(state: ImageTranslationState, identity: string): void {
    deleteCachedResult(state.image);
    const translatedImage = state.translatedImage!;
    const pixels = translatedImage.naturalWidth * translatedImage.naturalHeight;
    if (!config.useCache || pixels > MAX_CACHED_PIXELS) return;
    const invalidate = () => deleteCachedResult(state.image);
    resultCache.set(state.image, {
        sourceIdentity: state.sourceIdentity,
        configurationIdentity: identity,
        translatedImage,
        lines: state.lines,
        pixels,
        invalidate,
    });
    state.image.addEventListener('load', invalidate, {once: true});
    let totalPixels = Array.from(resultCache.values()).reduce((sum, cached) => sum + cached.pixels, 0);
    while (resultCache.size > MAX_CACHED_IMAGES || totalPixels > MAX_CACHED_PIXELS) {
        const oldestImage = resultCache.keys().next().value!;
        totalPixels -= resultCache.get(oldestImage)!.pixels;
        deleteCachedResult(oldestImage);
    }
}

function ensureImageOverlayRoot(): HTMLDivElement {
    if (imageOverlayContainer) return imageOverlayContainer;
    const host = document.createElement('div');
    host.id = IMAGE_TRANSLATION_ROOT;
    host.setAttribute('data-fluent-read-ui', 'image-translation');
    host.style.cssText = [
        'all: initial !important', 'position: fixed !important', 'inset: 0 !important',
        'width: 100vw !important', 'height: 100vh !important',
        'pointer-events: none !important', 'z-index: 2147483646 !important',
    ].join(';');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483646; }
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
    if ((state.phase !== 'idle' && state.phase !== 'error') || state.hovered) return;
    state.hoverTimer = window.setTimeout(() => {
        state.hoverTimer = null;
        if ((state.phase === 'idle' || state.phase === 'error') && !state.hovered) removeState(state);
    }, 180);
}

function setStateHovered(state: ImageTranslationState, hovered: boolean): void {
    state.hovered = hovered;
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
    if (states.get(state.image) === state) states.delete(state.image);
    if (!state.image.isConnected) deleteCachedResult(state.image);
}

function invalidateSource(state: ImageTranslationState): void {
    deleteCachedResult(state.image);
    state.sourceIdentity = sourceIdentity(state.image);
    state.abortController?.abort();
    state.abortController = null;
    state.waitingForImage = false;
    restoreOriginalImage(state);
    state.translatedImage?.remove();
    state.translatedImage = null;
    state.lines = [];
    state.controls.setLines([]);
    setButtonState(state, 'idle', '翻译图片');
    scheduleIdleStateRemoval(state);
}

function updateOverlayPosition(state: ImageTranslationState): void {
    if (!state.image.isConnected) {
        removeState(state);
        return;
    }
    if (sourceIdentity(state.image) !== state.sourceIdentity) invalidateSource(state);
    if (state.sourceStyleLease && !ownsHiddenImage(state)) {
        // 宿主重新设置 opacity 后不继续覆盖它；恢复显示权，并保留宿主刚写入的样式。
        restoreImageTranslation(state);
        return;
    }
    const rect = state.image.getBoundingClientRect();
    const style = getComputedStyle(state.image);
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    let opacity = Number.parseFloat(state.sourceStyleLease?.computedOpacity || style.opacity || '1');
    for (let ancestor = state.image.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        opacity *= Number.parseFloat(ancestorStyle.opacity || '1');
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
    const visible = config.on && !config.disableImageTranslator
        && rect.width >= MIN_IMAGE_WIDTH && rect.height >= MIN_IMAGE_HEIGHT
        && right > left && bottom > top && style.visibility !== 'hidden'
        && style.visibility !== 'collapse' && style.display !== 'none' && opacity > 0;
    state.overlay.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    state.overlay.style.left = `${rect.left}px`;
    state.overlay.style.top = `${rect.top}px`;
    state.overlay.style.width = `${rect.width}px`;
    state.overlay.style.height = `${rect.height}px`;
    state.overlay.style.clipPath = `inset(${top - rect.top}px ${rect.right - right}px ${rect.bottom - bottom}px ${left - rect.left}px)`;
    state.controls.element.style.setProperty('left', `${left - rect.left + 8}px`, 'important');
    state.controls.element.style.setProperty('bottom', `${rect.bottom - bottom + 8}px`, 'important');
    if (!state.translatedImage || state.phase !== 'translated') return;
    const bitmap = state.translatedImage;
    const scaleX = state.image.offsetWidth ? rect.width / state.image.offsetWidth : 1;
    const scaleY = state.image.offsetHeight ? rect.height / state.image.offsetHeight : 1;
    // 原生 replaced element 负责 object-fit 与完整 object-position 语法；滚动仅移动层，不重复解码或绘制整幅 Canvas。
    bitmap.style.objectFit = style.objectFit || 'fill';
    bitmap.style.objectPosition = style.objectPosition || '50% 50%';
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
}

function createState(image: HTMLImageElement): ImageTranslationState {
    const overlay = document.createElement('div');
    overlay.className = IMAGE_TRANSLATION_OVERLAY;
    overlay.dataset.fluentReadImageTranslation = 'true';
    const controls = createImageControls({
        translate: (source) => translateLegacyText(source, normalizeUiLanguage(config.uiLanguage)),
        onAction: () => {
            const state = states.get(image);
            if (!state || !config.on || config.disableImageTranslator) return;
            if (state.phase === 'translated' || state.phase === 'loading') restoreImageTranslation(state);
            else void translateImage(state);
        },
        onPrepare: () => {
            const state = states.get(image);
            if (state) void translateImage(state, true);
        },
    });
    overlay.append(controls.element);
    ensureImageOverlayRoot().appendChild(overlay);
    const state: ImageTranslationState = {
        image, overlay, controls, phase: 'idle', abortController: null, hovered: true,
        hoverTimer: null, resizeObserver: null, imageLoadHandler: null,
        sourceIdentity: sourceIdentity(image), waitingForImage: false,
        lines: [], translatedImage: null, sourceStyleLease: null,
    };
    state.imageLoadHandler = () => {
        // 第一次等待图片加载属于本次请求；其余 load（含同 URL 重载）一律视作新像素版本。
        if (state.waitingForImage) state.sourceIdentity = sourceIdentity(image);
        else invalidateSource(state);
        scheduleViewportChange();
    };
    state.resizeObserver = typeof ResizeObserver === 'undefined'
        ? null : new ResizeObserver(scheduleViewportChange);
    state.resizeObserver?.observe(image);
    image.addEventListener('load', state.imageLoadHandler);
    states.set(image, state);
    activeStates.add(state);
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
    const rect = image.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_WIDTH || rect.height < MIN_IMAGE_HEIGHT) return;
    const state = states.get(image) || createState(image);
    setStateHovered(state, true);
    updateOverlayPosition(state);
}

function hideImageButton(image: HTMLImageElement): void {
    const state = states.get(image);
    if (!state) return;
    setStateHovered(state, false);
}

/** 以网页自己的 CORS 权限重读未设置 crossOrigin 的图片，不赋予任意站点扩展网络权限。 */
export async function readPageImageInCors(source: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw createImageAbortError();
    const response = await fetch(source, {mode: 'cors', credentials: 'omit', signal});
    const discard = () => { void response.body?.cancel().catch(() => undefined); };
    if (!response.ok) { discard(); throw new Error(`图片服务器返回 ${response.status}`); }
    const contentType = response.headers.get('content-type') || '';
    try {
        normalizeRemoteImageMimeType(contentType);
        if (Number(response.headers.get('content-length')) > MAX_REMOTE_IMAGE_BYTES) throw new Error('图片文件过大');
    } catch (error) {
        discard();
        throw error;
    }
    if (!response.body) return imageBufferToDataUrl(await response.arrayBuffer(), contentType);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            if (signal?.aborted) throw createImageAbortError();
            const {done, value} = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_REMOTE_IMAGE_BYTES) throw new Error('图片文件过大');
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return imageBufferToDataUrl(buffer.buffer, contentType);
}

export async function getImageData(
    image: HTMLImageElement,
    options: {readonly signal?: AbortSignal; readonly timeoutMs?: number} = {},
): Promise<string> {
    if (options.signal?.aborted) throw createImageAbortError();
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
        context.getImageData(0, 0, 1, 1);
        return canvas.toDataURL('image/png');
    } catch {
        canvas.width = 0;
        canvas.height = 0;
        const source = image.currentSrc || image.src;
        if (!source) throw new Error('图片地址不可用');
        try {
            return await readPageImageInCors(source, options.signal);
        } catch {
            if (options.signal?.aborted) throw createImageAbortError();
            // 网页 CORS 不允许读取时，继续只交给现有 Offscreen 白名单。
            return fetchImageInExtension(source, options);
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

function setButtonState(state: ImageTranslationState, phase: ImageControlPhase, message: string): void {
    state.phase = phase;
    state.controls.update(phase, message, {
        prepare: phase === 'error' && message.includes('语言包'), animations: config.animations,
    });
}

function ownsHiddenImage(state: ImageTranslationState): boolean {
    return state.image.style.getPropertyValue('opacity') === '0'
        && state.image.style.getPropertyPriority('opacity') === 'important';
}

function hideOriginalImage(state: ImageTranslationState): void {
    if (state.sourceStyleLease) return;
    const style = state.image.style;
    state.sourceStyleLease = {
        opacity: {value: style.getPropertyValue('opacity'), priority: style.getPropertyPriority('opacity')},
        transition: ['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior']
            .map(property => ({property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)}))
            .filter(property => Boolean(property.value)),
        computedOpacity: getComputedStyle(state.image).opacity || '1',
        hadStyleAttribute: state.image.hasAttribute('style'),
    };
    // 在同一帧关闭过渡并隐藏原图，透明译图的擦除区域不会透出下层原文字。
    style.setProperty('transition', 'none', 'important');
    style.setProperty('opacity', '0', 'important');
}

function restoreOriginalImage(state: ImageTranslationState): void {
    const lease = state.sourceStyleLease;
    if (!lease) return;
    const style = state.image.style;
    const ownsOpacity = ownsHiddenImage(state);
    const ownsTransition = style.getPropertyValue('transition') === 'none'
        && style.getPropertyPriority('transition') === 'important';
    if (ownsOpacity) {
        if (lease.opacity.value) style.setProperty('opacity', lease.opacity.value, lease.opacity.priority);
        else style.removeProperty('opacity');
        // 先在过渡关闭时结算原透明度，再归还 transition，避免恢复原图时发生意外淡入。
        if (ownsTransition) void getComputedStyle(state.image).opacity;
    }
    if (ownsTransition) {
        style.removeProperty('transition');
        lease.transition.forEach(property => style.setProperty(property.property, property.value, property.priority));
    }
    if (ownsOpacity && ownsTransition && !lease.hadStyleAttribute && style.length === 0) state.image.removeAttribute('style');
    state.sourceStyleLease = null;
}

function showTranslatedImage(state: ImageTranslationState): void {
    const image = state.translatedImage!;
    image.className = 'fluent-read-image-translation-bitmap';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    hideOriginalImage(state);
    state.overlay.prepend(image);
    state.controls.setLines(state.lines);
    setButtonState(state, 'translated', '已翻译 · 点击恢复原图');
    updateOverlayPosition(state);
}

function restoreImageTranslation(state: ImageTranslationState): void {
    state.abortController?.abort();
    state.abortController = null;
    state.waitingForImage = false;
    restoreOriginalImage(state);
    state.translatedImage?.remove();
    state.translatedImage = null;
    state.lines = [];
    state.controls.setLines([]);
    setButtonState(state, 'idle', resultCache.has(state.image) ? '查看译图' : '翻译图片');
    updateOverlayPosition(state);
    scheduleIdleStateRemoval(state);
}

function requestIsCurrent(state: ImageTranslationState, controller: AbortController): boolean {
    if (controller.signal.aborted || state.abortController !== controller || states.get(state.image) !== state) return false;
    if (!state.image.isConnected) { removeState(state); return false; }
    if (sourceIdentity(state.image) !== state.sourceIdentity) { invalidateSource(state); return false; }
    return true;
}

async function translateImage(state: ImageTranslationState, prepareLanguages = false): Promise<void> {
    if (state.phase === 'loading' || !state.image.isConnected || !config.on || config.disableImageTranslator) return;
    if (sourceIdentity(state.image) !== state.sourceIdentity) invalidateSource(state);
    clearHoverTimer(state);
    const identity = configurationIdentity();
    const cached = resultCache.get(state.image);
    if (!prepareLanguages && config.useCache && cached?.sourceIdentity === state.sourceIdentity && cached.configurationIdentity === identity) {
        resultCache.delete(state.image);
        resultCache.set(state.image, cached);
        state.translatedImage = cached.translatedImage;
        state.lines = cached.lines;
        showTranslatedImage(state);
        return;
    }
    deleteCachedResult(state.image);
    const controller = new AbortController();
    const sourceLanguage = config.from;
    state.abortController = controller;
    setButtonState(state, 'loading', prepareLanguages ? '正在准备识别语言包…' : '正在读取图片…');
    try {
        if (prepareLanguages) {
            await prepareImageOcrLanguages(sourceLanguage, controller.signal);
            if (!requestIsCurrent(state, controller)) return;
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
            signal: controller.signal,
            timeoutMs: IMAGE_TRANSLATION_TIMEOUT_MS,
            onProgress: stage => {
                if (!requestIsCurrent(state, controller)) return;
                setButtonState(state, 'loading', stage === 'recognizing' ? '正在识别图片文字…'
                    : stage === 'translating' ? '正在翻译文字…' : '正在生成译图…');
            },
        });
        if (!requestIsCurrent(state, controller)) return;
        setButtonState(state, 'loading', '正在生成译图…');
        const translatedImage = await withTimeout(loadImage(result.image, controller.signal), IMAGE_READ_TIMEOUT_MS, '译图加载超时', controller.signal);
        if (!requestIsCurrent(state, controller)) return;
        // 设置在途中变化时不能将旧请求当成新配置的结果；保留原图并让用户直接重试。
        if (configurationIdentity() !== identity) {
            throw new Error('翻译设置已更改，请重试');
        }
        state.translatedImage = translatedImage;
        state.lines = result.lines;
        cacheResult(state, identity);
        showTranslatedImage(state);
    } catch (error) {
        if (!requestIsCurrent(state, controller)) return;
        controller.abort();
        const message = error instanceof Error ? error.message : String(error);
        const missingLanguages = /^图片文字识别需要先下载.+语言包/u.test(message) || message === '请先下载语言包';
        setButtonState(state, 'error', missingLanguages
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

function handlePointerOver(event: PointerEvent): void {
    if (!event.isTrusted || event.pointerType === 'touch') return;
    if (event.target instanceof HTMLImageElement) showImageButton(event.target);
}

function handlePointerOut(event: PointerEvent): void {
    if (!event.isTrusted) return;
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    if (image && event.relatedTarget instanceof Node && image.contains(event.relatedTarget)) return;
    if (image) hideImageButton(image);
}

function scheduleViewportChange(): void {
    if (!mounted || activeStates.size === 0 || positionFrame !== null) return;
    positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        activeStates.forEach(updateOverlayPosition);
    });
}

function handleLayoutMutations(records: MutationRecord[]): void {
    // 资源替换必须在下一次绘制之前撤下旧译图；一般布局变化合并到一帧。
    const sourceChanged = records.some(record => record.type === 'childList'
        || ['src', 'srcset', 'sizes', 'media', 'type'].includes(record.attributeName || ''));
    if (sourceChanged) {
        activeStates.forEach(state => {
            if (!state.image.isConnected) removeState(state);
            else if (sourceIdentity(state.image) !== state.sourceIdentity) invalidateSource(state);
        });
        resultCache.forEach((_cached, image) => {
            if (!image.isConnected) deleteCachedResult(image);
        });
    }
    scheduleViewportChange();
}

export function mountImageTranslator(): void {
    if (mounted) return;
    mounted = true;
    stopConfigurationWatch = watchTranslationConfiguration();
    const stopLanguageWatch = watch(() => config.uiLanguage, () => {
        activeStates.forEach(state => state.controls.refreshLanguage());
    });
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    window.addEventListener('scroll', scheduleViewportChange, true);
    window.addEventListener('resize', scheduleViewportChange);
    layoutObserver = new MutationObserver(handleLayoutMutations);
    layoutObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'src', 'srcset', 'sizes', 'media', 'type', 'width', 'height', 'hidden'],
        childList: true, subtree: true,
    });
    removeListeners = () => {
        stopLanguageWatch();
        stopConfigurationWatch?.();
        stopConfigurationWatch = null;
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
    removeListeners?.();
    removeListeners = null;
    Array.from(activeStates).forEach(removeState);
    Array.from(resultCache.keys()).forEach(deleteCachedResult);
    removeImageOverlayRoot();
}
