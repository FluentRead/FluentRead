/**
 * @file src/features/image-translation/content/mangaBackground.ts
 * 文件职责：读取已适配阅读器公开展示的同源背景图片，复用漫画画布的翻译、压缩缓存与隔离译图。
 * 主要内容：串行探测附近页的尺寸和可读性，探测后立即释放解码图片；按 contain 与背景位置计算真实绘制范围；完整译图只编码一次有界 PNG，在可见时借用 background-image 原绘制层，不盖住宿主底色、子内容及交互；来源与样式接管归还单属性租约，取消、撤层和卸载释放编码与对象地址。
 * 模块边界：只支持单层、无重复、无边框内距的同源 blob 正文；不访问章节接口、不隐藏宿主、不读取额外全页像素、不扩大模型与会话预算；逻辑来源与自有译图地址分离，无法读取或呈现的页面保留原文。
 */
import {createMangaCanvas} from './mangaCanvas';

interface BackgroundPresentation {
    show: () => boolean;
    hide: () => void;
    dispose: () => void;
    reconcile: () => void;
    logicalImage: () => string | null;
    /** 只读检查租约，按需阅读不能触发样式归还或来源探测。 */
    readable: () => boolean;
}
interface BackgroundPage {url: string; width: number; height: number; ready: boolean; cancel: (() => void) | null; presentation?: BackgroundPresentation}
interface ImageReceipt {value: string; priority: string; originalStyle: string | null; ownedValue: string; ownedPriority: string; ownedStyle: string | null; className: string | null}
const validSize = (width: number, height: number) => width >= 80 && height >= 40 && width <= 8192 && height <= 8192 && width * height <= 16_000_000;
const imageUrl = (value: string) => /^url\(["']?(blob:[^"')]+)["']?\)$/.exec(value)?.[1];

/** 只编码当前已合成画布；迟到回调不创建地址，不把 PNG 再转成 base64。 */
function encodePresentation(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('背景译图编码超时')), 30_000);
        const abort = () => finish(new DOMException('已取消', 'AbortError'));
        function finish(error?: unknown, blob?: Blob): void {
            if (settled) return;
            settled = true;clearTimeout(timeout);signal.removeEventListener('abort', abort);
            if (blob) resolve(blob);else reject(error);
        }
        signal.addEventListener('abort', abort, {once: true});
        try {
            canvas.toBlob(blob => {
                if (!blob || blob.size === 0 || blob.size > 64 * 1024 * 1024) {finish(new Error('背景译图数据无效'));return;}
                finish(undefined, blob);
            }, 'image/png');
        } catch (error) {finish(error);}
    });
}

export function createMangaBackground(ports: Parameters<typeof createMangaCanvas<HTMLElement>>[0] & {ready: () => void}) {
    let pages = new WeakMap<HTMLElement, BackgroundPage>();
    let disposed = false, probing: HTMLElement | null = null;

    function descriptor(element: HTMLElement, readonly = false): {url: string; x: number; y: number} | null {
        const presentation = pages.get(element)?.presentation;
        if(readonly && presentation && !presentation.readable())return null;
        if(!readonly)presentation?.reconcile();
        const style = getComputedStyle(element);
        if (style.backgroundSize !== 'contain' || style.backgroundRepeat !== 'no-repeat' || style.backgroundOrigin !== 'padding-box') return null;
        if ([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
            style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(value => parseFloat(value) > 0)) return null;
        const url = imageUrl(presentation?.logicalImage() ?? style.backgroundImage);
        if (!url || new URL(url).origin !== window.location.origin) return null;
        const positions = style.backgroundPosition.split(' ');
        if (positions.length !== 2 || positions.some(value => !/^(?:0px|\d+(?:\.\d+)?%)$/.test(value) || parseFloat(value) > 100)) return null;
        return {url, x: parseFloat(positions[0]) / 100, y: parseFloat(positions[1]) / 100};
    }

    function preparePresentation(element: HTMLElement, page: BackgroundPage, url: string): BackgroundPresentation {
        let receipt: ImageReceipt | undefined;
        let released = false, interrupted = false;
        const owns = (saved: ImageReceipt) => element.style.getPropertyValue('background-image') === saved.ownedValue
            && element.style.getPropertyPriority('background-image') === saved.ownedPriority;
        function hide(): void {
            const saved = receipt;
            if (!saved) return;
            receipt = undefined;
            if (imageUrl(element.style.getPropertyValue('background-image')) !== url) return;
            const priority = element.style.getPropertyPriority('background-image');
            if (priority !== saved.ownedPriority) {
                // 宿主只改优先级时仍不能留下将被撤销的自有地址；归还原图并保留新优先级。
                element.style.setProperty('background-image', saved.value || `url("${page.url}")`, priority);
                return;
            }
            if (element.getAttribute('style') === saved.ownedStyle) {
                if (saved.originalStyle === null) element.removeAttribute('style');
                else element.setAttribute('style', saved.originalStyle);
            } else if (saved.value) element.style.setProperty('background-image', saved.value, saved.priority);
            else element.style.removeProperty('background-image');
        }
        function reconcile(): void {
            if (receipt && (!owns(receipt) || element.getAttribute('class') !== receipt.className || element.getAttribute('style') !== receipt.ownedStyle)) {
                hide();interrupted = true;
            }
        }
        const presentation: BackgroundPresentation = {
            reconcile,
            logicalImage: () => receipt ? `url("${page.url}")` : null,
            readable: () => !released && !disposed && !interrupted && (!receipt || (owns(receipt)
                && element.getAttribute('class')===receipt.className && element.getAttribute('style')===receipt.ownedStyle)),
            show() {
                if (released || disposed || !element.isConnected || pages.get(element) !== page) return false;
                const current = descriptor(element);
                if (interrupted) {interrupted = false;return false;}
                if (!current || current.url !== page.url) return false;
                if (receipt) return true;
                const style = element.style;
                const saved = {value: style.getPropertyValue('background-image'), priority: style.getPropertyPriority('background-image'),
                    originalStyle: element.getAttribute('style'), className: element.getAttribute('class')};
                style.setProperty('background-image', `url("${url}")`, 'important');
                receipt = {...saved, ownedValue: style.getPropertyValue('background-image'), ownedPriority: style.getPropertyPriority('background-image'), ownedStyle: element.getAttribute('style')};
                if (imageUrl(getComputedStyle(element).backgroundImage) !== url) {hide();return false;}
                return true;
            },
            hide,
            dispose() {
                if (released) return;
                released = true;hide();URL.revokeObjectURL(url);
                if (page.presentation === presentation) page.presentation = undefined;
            },
        };
        page.presentation?.dispose();page.presentation = presentation;
        return presentation;
    }

    function load(url: string, signal: AbortSignal, use: (image: HTMLImageElement) => void): Promise<void> {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const image = new Image();
            const finish = (error?: unknown) => {
                clearTimeout(timeout);signal.removeEventListener('abort', abort);
                image.onload = image.onerror = null;image.src = '';
                if (error) reject(error);else resolve();
            };
            const abort = () => finish(new DOMException('已取消', 'AbortError'));
            const timeout = setTimeout(() => finish(new Error('背景图片加载超时')), 15_000);
            image.onload = () => {try {use(image);finish();} catch (error) {finish(error);}};
            image.onerror = () => finish(new Error('背景图片无法读取'));
            signal.addEventListener('abort', abort, {once: true});
            image.src = url;
        });
    }

    function probe(element: HTMLElement, url: string): void {
        const page: BackgroundPage = {url, width: 0, height: 0, ready: false, cancel: null};
        const controller = new AbortController();
        pages.set(element, page);probing = element;page.cancel = () => controller.abort();
        void load(url, controller.signal, image => {
            if (!validSize(image.naturalWidth, image.naturalHeight)) throw new Error('背景图片尺寸超出范围');
            const sample = document.createElement('canvas');sample.width = sample.height = 8;
            try {
                const context = sample.getContext('2d', {willReadFrequently: true});
                if (!context) throw new Error('浏览器不支持图片处理');
                context.drawImage(image, 0, 0, 8, 8);context.getImageData(0, 0, 8, 8);
                page.width = image.naturalWidth;page.height = image.naturalHeight;page.ready = true;
            } finally {sample.width = sample.height = 0;}
        }).catch(() => { /* 已失效、受污染或失败的来源不重试循环，保留原文和圈选入口。 */ }).finally(() => {
            page.cancel = null;
            if (probing === element && pages.get(element) === page) probing = null;
            if (!disposed && pages.get(element) === page) ports.ready();
        });
    }

    function forget(element: HTMLElement): void {
        const page = pages.get(element);
        if (!page) return;
        page.presentation?.dispose();pages.delete(element);page.cancel?.();
        if (probing === element) probing = null;
    }
    function identity(element: HTMLElement): string | null {
        if (disposed || !element.isConnected) return null;
        const value = descriptor(element);
        if (!value) {forget(element);return null;}
        if (pages.get(element)?.url !== value.url) forget(element);
        let page = pages.get(element);
        if (!page && !probing) {
            const rect = element.getBoundingClientRect();
            if (rect.width >= 80 && rect.height >= 40 && rect.right > -window.innerWidth && rect.left < 2 * window.innerWidth
                && rect.bottom > -window.innerHeight && rect.top < 2 * window.innerHeight) {
                probe(element, value.url);page = pages.get(element);
            }
        }
        return page?.ready ? `${page.url}:${page.width}:${page.height}` : null;
    }
    function readingIdentity(element:HTMLElement):string|null {
        if(disposed||!element.isConnected)return null;
        const page=pages.get(element),value=descriptor(element,true);
        return page?.ready&&value?.url===page.url?`${page.url}:${page.width}:${page.height}`:null;
    }
    function bounds(element: HTMLElement): DOMRect {
        const rect = element.getBoundingClientRect(), page = pages.get(element)!, position = descriptor(element)!;
        const scale = Math.min(rect.width / page.width, rect.height / page.height);
        const width = page.width * scale, height = page.height * scale;
        return new DOMRect(rect.left + (rect.width - width) * position.x, rect.top + (rect.height - height) * position.y, width, height);
    }
    function readingBounds(element:HTMLElement):DOMRect|null {
        const page=pages.get(element),position=descriptor(element,true);
        if(!page?.ready||!position||position.url!==page.url)return null;
        const rect=element.getBoundingClientRect(),scale=Math.min(rect.width/page.width,rect.height/page.height);
        const width=page.width*scale,height=page.height*scale;
        return new DOMRect(rect.left+(rect.width-width)*position.x,rect.top+(rect.height-height)*position.y,width,height);
    }
    const surface = createMangaCanvas<HTMLElement>({...ports,
        acceptsInteractionLayer: (element, hit) => element.contains(hit) || ports.acceptsInteractionLayer?.(element, hit) === true,
        source: {
        identity, readingIdentity, readingBounds, bounds,
        presentation: async (element, canvas, signal) => {
            signal.throwIfAborted();
            const page = pages.get(element);
            if (!page?.ready || canvas.width !== page.width || canvas.height !== page.height) throw new Error('背景译图尺寸无效');
            const blob = await encodePresentation(canvas, signal);
            signal.throwIfAborted();
            const current = () => !disposed && element.isConnected && pages.get(element) === page && descriptor(element)?.url === page.url;
            if (!current()) throw new DOMException('背景图片来源已更换', 'AbortError');
            const url = URL.createObjectURL(blob);
            try {
                // 先用公开 Image 加载校验，再借背景绘制层；清空探测 Image 不承诺 CSS 解码缓存一定复用。
                await load(url, signal, image => {
                    if (image.naturalWidth !== page.width || image.naturalHeight !== page.height) throw new Error('背景译图尺寸无效');
                });
                signal.throwIfAborted();
                if (!current()) throw new DOMException('背景图片来源已更换', 'AbortError');
                return preparePresentation(element, page, url);
            } catch (error) {URL.revokeObjectURL(url);throw error;}
        },
        capture: (element, target, signal) => {
            const page = pages.get(element)!;
            return load(page.url, signal, image => {
                if (image.naturalWidth !== page.width || image.naturalHeight !== page.height) throw new Error('背景图片来源已更换');
                target.width = page.width;target.height = page.height;
                const context = target.getContext('2d');
                if (!context) throw new Error('浏览器不支持图片处理');
                context.drawImage(image, 0, 0);
            });
        },
    }});
    const clear = () => {if (probing) forget(probing);pages = new WeakMap();surface.resetCache();};
    return {...surface, bounds,
        pixels: (element: HTMLElement) => {const page = pages.get(element)!;return page.width * page.height;},
        prepare(elements: HTMLElement[]) {
            if (probing && !elements.includes(probing)) forget(probing);
        },
        resetCache: clear,
        dispose() {disposed = true;clear();surface.dispose();},
    };
}
