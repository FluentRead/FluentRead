/**
 * @file src/features/image-translation/content/mangaImageSegments.ts
 * 文件职责：把已展示的超长漫画图片按稳定的原始像素位置分段，接入现有漫画会话与译图合成。
 * 主要内容：每段保留上下文并裁去重叠显示区，正文身份包含来源、重载与尺寸；默认填充无需测量未使用的宽高比，contain 仍按实时几何校验；支持帧级缓存将同一长图多段的样式、指纹与几何查询降为 O(1)；跨域受污染长图按指纹保留单条有界引用计数解码源缓存并按指纹表去重和取消并发读取，确保多图并发、换图、重置与卸载时不泄漏或提前关闭在用位图。
 * 模块边界：不抓取章节、不修改原图和样式、不建立另一条 OCR 队列；仅支持无边框内距的纵向正文，所有译图和压缩缓存复用 mangaCanvas。
 */
import {createMangaCanvas} from './mangaCanvas';

export interface MangaImageSegment {
    readonly image: HTMLImageElement;
    readonly top: number;
    readonly height: number;
    readonly width: number;
    readonly contextTop: number;
    readonly contextHeight: number;
    readonly source: string;
}

export function createMangaImageSegments(ports: Omit<Parameters<typeof createMangaCanvas<MangaImageSegment>>[0], 'source'> & {
    imageIdentity: (image: HTMLImageElement) => string;
    readSource: (image: HTMLImageElement, signal: AbortSignal) => Promise<string>;
}) {
    let pages = new Map<HTMLImageElement, MangaImageSegment[]>();
    let disposed = false;
    type DecodedStrip = {fingerprint: string; bitmap?: ImageBitmap; data?: string; users: number; evicted: boolean};
    type StripWaiter = {resolve: (strip: DecodedStrip) => void; reject: (error: unknown) => void};
    type PendingStrip = {fingerprint: string; controller: AbortController; waiters: Set<StripWaiter>};
    let decodedStrip: DecodedStrip | null = null;
    const pendingStrips = new Map<string, PendingStrip>();
    let frameCache: {rects: Map<HTMLImageElement, DOMRect>; supported: Map<HTMLImageElement, boolean>; fingerprints: Map<HTMLImageElement, string>} | null = null;

    function closeIfUnused(strip: DecodedStrip): void {
        if (strip.evicted && strip.users === 0) strip.bitmap?.close();
    }

    function evictDecodedStrip(): void {
        if (decodedStrip) {
            const current = decodedStrip;
            decodedStrip = null;
            current.evicted = true;
            closeIfUnused(current);
        }
    }

    function abortPendingStrips(): void {
        for (const entry of pendingStrips.values()) entry.controller.abort();
        pendingStrips.clear();
    }

    function withFrame<R>(operation: () => R): R {
        if (frameCache) return operation();
        frameCache = {rects: new Map(), supported: new Map(), fingerprints: new Map()};
        try { return operation(); }
        finally { frameCache = null; }
    }

    const fingerprint = (image: HTMLImageElement): string => {
        if (frameCache) {
            let value = frameCache.fingerprints.get(image);
            if (value === undefined) {
                value = `${ports.imageIdentity(image)}:${image.naturalWidth}:${image.naturalHeight}`;
                frameCache.fingerprints.set(image, value);
            }
            return value;
        }
        return `${ports.imageIdentity(image)}:${image.naturalWidth}:${image.naturalHeight}`;
    };

    const rectOf = (image: HTMLImageElement): DOMRect => {
        if (frameCache) {
            let rect = frameCache.rects.get(image);
            if (!rect) { rect = image.getBoundingClientRect(); frameCache.rects.set(image, rect); }
            return rect;
        }
        return image.getBoundingClientRect();
    };

    function supported(image: HTMLImageElement): boolean {
        if (frameCache?.supported.has(image)) return frameCache.supported.get(image)!;
        const result = (() => {
            if (!image.complete || image.naturalWidth < 80 || image.naturalWidth > 4096 || image.naturalHeight <= 4096
                || image.naturalHeight > 100_000 || image.naturalWidth * image.naturalHeight > 80_000_000) return false;
            const style = getComputedStyle(image);
            if ([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
                style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(value => parseFloat(value) > 0)) return false;
            if (style.objectFit && style.objectFit !== 'fill' && style.objectFit !== 'contain') return false;
            if (style.objectFit !== 'contain') return true;
            const rect = rectOf(image);
            return Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) < .001;
        })();
        frameCache?.supported.set(image, result);
        return result;
    }

    function identity(segment: MangaImageSegment): string | null {
        return !disposed && segment.image.isConnected && pages.get(segment.image)?.includes(segment)
            && supported(segment.image) && segment.source === fingerprint(segment.image)
            ? `${segment.source}:${segment.top}:${segment.height}` : null;
    }

    function bounds(segment: MangaImageSegment): DOMRect {
        const rect = rectOf(segment.image), scale = rect.height / segment.image.naturalHeight;
        return new DOMRect(rect.left, rect.top + segment.top * scale, rect.width, segment.height * scale);
    }

    function draw(segment: MangaImageSegment, source: HTMLImageElement | ImageBitmap, target: HTMLCanvasElement): void {
        const sourceWidth = 'naturalWidth' in source ? source.naturalWidth : source.width;
        const sourceHeight = 'naturalHeight' in source ? source.naturalHeight : source.height;
        if (sourceWidth !== segment.width || sourceHeight !== segment.image.naturalHeight) throw new Error('漫画图片来源已更换');
        target.width = segment.width;target.height = segment.contextHeight;
        const context = target.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');
        context.drawImage(source, 0, segment.contextTop, segment.width, segment.contextHeight, 0, 0, segment.width, segment.contextHeight);
        context.getImageData(0, 0, 1, 1);
    }

    function decodeImageData(segment: MangaImageSegment, data: string, signal: AbortSignal, onLoaded: (image: HTMLImageElement) => Promise<void> | void): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const image = new Image();
            let settled = false;
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout); signal.removeEventListener('abort', abort);
                image.onload = image.onerror = null; image.src = '';
                if (error) reject(error); else resolve();
            };
            const abort = () => finish(new DOMException('已取消', 'AbortError'));
            const timeout = setTimeout(() => finish(new Error('漫画图片加载超时')), 15_000);
            image.onload = () => {
                if (settled) return;
                try {
                    signal.throwIfAborted();
                    if (!identity(segment)) throw new Error('漫画图片来源已更换');
                    Promise.resolve(onLoaded(image)).then(() => finish(), error => finish(error));
                } catch (error) { finish(error); }
            };
            image.onerror = () => finish(new Error('漫画图片无法读取'));
            signal.addEventListener('abort', abort, {once: true});
            image.src = data;
        });
    }

    function loadDecodedStrip(segment: MangaImageSegment, signal: AbortSignal): Promise<DecodedStrip> {
        const key = segment.source;
        if (decodedStrip) {
            if (decodedStrip.fingerprint === key) {
                const hit = decodedStrip;
                hit.users++;
                return Promise.resolve(hit);
            }
            evictDecodedStrip();
        }
        let entry = pendingStrips.get(key) ?? null;
        let startLoader: (() => void) | undefined;
        if (!entry) {
            const controller = new AbortController();
            const current: PendingStrip = {fingerprint: key, controller, waiters: new Set()};
            pendingStrips.set(key, current);
            entry = current;
            const rejectAll = (error: unknown) => {
                for (const waiter of Array.from(current.waiters)) waiter.reject(error);
            };
            startLoader = () => {
                void (async (): Promise<DecodedStrip> => {
                    const data = await ports.readSource(segment.image, controller.signal);
                    controller.signal.throwIfAborted();
                    if (!identity(segment)) throw new Error('漫画图片来源已更换');
                    if (typeof createImageBitmap !== 'function') return {fingerprint: key, data, users: 0, evicted: false};
                    let bitmap: ImageBitmap | undefined;
                    await decodeImageData(segment, data, controller.signal, async image => {
                        const created = await createImageBitmap(image);
                        if (controller.signal.aborted || !identity(segment)) { created.close(); throw new Error('漫画图片来源已更换'); }
                        bitmap = created;
                    });
                    return {fingerprint: key, bitmap: bitmap!, users: 0, evicted: false};
                })().then(strip => {
                    if (pendingStrips.get(key) === current) pendingStrips.delete(key);
                    if (disposed || current.controller.signal.aborted) {
                        strip.bitmap?.close();
                        rejectAll(new DOMException('已取消', 'AbortError'));
                        return;
                    }
                    evictDecodedStrip();
                    decodedStrip = strip;
                    for (const waiter of Array.from(current.waiters)) {
                        strip.users++;
                        waiter.resolve(strip);
                    }
                }, error => {
                    if (pendingStrips.get(key) === current) pendingStrips.delete(key);
                    rejectAll(error);
                });
            };
        }
        return new Promise<DecodedStrip>((resolve, reject) => {
            const target = entry!;
            const onAbort = () => {
                target.waiters.delete(waiter);
                signal.removeEventListener('abort', onAbort);
                if (target.waiters.size === 0) {
                    if (pendingStrips.get(key) === target) pendingStrips.delete(key);
                    target.controller.abort();
                }
                reject(new DOMException('已取消', 'AbortError'));
            };
            const waiter: StripWaiter = {
                resolve(strip) {
                    target.waiters.delete(waiter);
                    signal.removeEventListener('abort', onAbort);
                    resolve(strip);
                },
                reject(error) {
                    target.waiters.delete(waiter);
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            };
            target.waiters.add(waiter);
            signal.addEventListener('abort', onAbort, {once: true});
            startLoader?.();
        });
    }

    async function capture(segment: MangaImageSegment, target: HTMLCanvasElement, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        try {draw(segment, segment.image, target);return;}
        catch (error) {
            if (!(error instanceof Error) || error.name !== 'SecurityError') throw error;
            // 重置受污染快照，只在现有授权读取成功后解码；不创建整张长图画布。
            target.width = target.height = 0;
        }
        const strip = await loadDecodedStrip(segment, signal);
        try {
            signal.throwIfAborted();
            try {
                if (strip.bitmap) draw(segment, strip.bitmap, target);
                else await decodeImageData(segment, strip.data!, signal, image => draw(segment, image, target));
            } catch (error) {
                if (decodedStrip === strip) evictDecodedStrip();
                throw error;
            }
        } finally {
            strip.users--;
            closeIfUnused(strip);
        }
    }

    const surface = createMangaCanvas<MangaImageSegment>({...ports, hostId: 'fluent-read-manga-segment-container', source: {
        anchor: segment => segment.image, identity, readingIdentity: identity, readingBounds: bounds, capture, bounds,
        viewport: segment => ({x: 0, y: segment.top - segment.contextTop, width: segment.width, height: segment.height}),
    }});
    return {...surface, bounds, withFrame,
        update(knownIdentities?: ReadonlyMap<MangaImageSegment, string | null>) {
            withFrame(() => surface.update(knownIdentities));
        },
        pixels: (segment: MangaImageSegment) => segment.width * segment.contextHeight,
        prepare(images: HTMLImageElement[]): ReadonlyMap<HTMLImageElement, MangaImageSegment[]> {
            const next = new Map<HTMLImageElement, MangaImageSegment[]>();
            if (!disposed) for (const image of images) {
                if (!supported(image)) continue;
                const source = fingerprint(image), previous = pages.get(image);
                if (previous?.[0].source === source) {next.set(image, previous);continue;}
                const segments: MangaImageSegment[] = [];
                const step = Math.min(2048, Math.floor(6_000_000 / image.naturalWidth) - 512);
                for (let top = 0; top < image.naturalHeight; top += step) {
                    const height = Math.min(step, image.naturalHeight - top), contextTop = Math.max(0, top - 256);
                    segments.push({image, source, top, height, width: image.naturalWidth, contextTop,
                        contextHeight: Math.min(image.naturalHeight, top + height + 256) - contextTop});
                }
                next.set(image, segments);
            }
            pages = next;
            if (decodedStrip && !Array.from(next.values()).some(list => list[0].source === decodedStrip!.fingerprint)) evictDecodedStrip();
            return pages;
        },
        resetCache() {pages.clear();evictDecodedStrip();abortPendingStrips();surface.resetCache();},
        dispose() {disposed = true;pages.clear();evictDecodedStrip();abortPendingStrips();surface.dispose();},
    };
}
