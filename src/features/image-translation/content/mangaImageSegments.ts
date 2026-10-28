/**
 * @file src/features/image-translation/content/mangaImageSegments.ts
 * 文件职责：把已展示的超长漫画图片按稳定的原始像素位置分段，接入现有漫画会话与译图合成。
 * 主要内容：每段保留上下文并裁去重叠显示区，正文身份包含来源、重载与尺寸；默认填充无需测量未使用的宽高比，contain 仍按实时几何校验；只在会话调度时读取该段，跨域读取沿用当前图片授权，取消、换图和卸载释放快照与解码资源。
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
    const fingerprint = (image: HTMLImageElement) => `${ports.imageIdentity(image)}:${image.naturalWidth}:${image.naturalHeight}`;

    function supported(image: HTMLImageElement): boolean {
        if (!image.complete || image.naturalWidth < 80 || image.naturalWidth > 4096 || image.naturalHeight <= 4096
            || image.naturalHeight > 100_000 || image.naturalWidth * image.naturalHeight > 80_000_000) return false;
        const style = getComputedStyle(image);
        if ([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
            style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(value => parseFloat(value) > 0)) return false;
        if (style.objectFit && style.objectFit !== 'fill' && style.objectFit !== 'contain') return false;
        if (style.objectFit !== 'contain') return true;
        const rect = image.getBoundingClientRect();
        return Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) < .001;
    }

    function identity(segment: MangaImageSegment): string | null {
        return !disposed && segment.image.isConnected && pages.get(segment.image)?.includes(segment)
            && supported(segment.image) && segment.source === fingerprint(segment.image)
            ? `${segment.source}:${segment.top}:${segment.height}` : null;
    }

    function bounds(segment: MangaImageSegment): DOMRect {
        const rect = segment.image.getBoundingClientRect(), scale = rect.height / segment.image.naturalHeight;
        return new DOMRect(rect.left, rect.top + segment.top * scale, rect.width, segment.height * scale);
    }

    function draw(segment: MangaImageSegment, source: HTMLImageElement, target: HTMLCanvasElement): void {
        if (source.naturalWidth !== segment.width || source.naturalHeight !== segment.image.naturalHeight) throw new Error('漫画图片来源已更换');
        target.width = segment.width;target.height = segment.contextHeight;
        const context = target.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');
        context.drawImage(source, 0, segment.contextTop, segment.width, segment.contextHeight, 0, 0, segment.width, segment.contextHeight);
        context.getImageData(0, 0, 1, 1);
    }

    async function capture(segment: MangaImageSegment, target: HTMLCanvasElement, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        try {draw(segment, segment.image, target);return;}
        catch (error) {
            if (!(error instanceof Error) || error.name !== 'SecurityError') throw error;
            // 重置受污染快照，只在现有授权读取成功后解码；不创建整张长图画布。
            target.width = target.height = 0;
        }
        const data = await ports.readSource(segment.image, signal);
        signal.throwIfAborted();
        if (!identity(segment)) throw new Error('漫画图片来源已更换');
        await new Promise<void>((resolve, reject) => {
            const image = new Image();
            let settled = false;
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);signal.removeEventListener('abort', abort);
                image.onload = image.onerror = null;image.src = '';
                if (error) reject(error);else resolve();
            };
            const abort = () => finish(new DOMException('已取消', 'AbortError'));
            const timeout = setTimeout(() => finish(new Error('漫画图片加载超时')), 15_000);
            image.onload = () => {
                if (settled) return;
                try {
                    signal.throwIfAborted();
                    if (!identity(segment)) throw new Error('漫画图片来源已更换');
                    draw(segment, image, target);finish();
                } catch (error) {finish(error);}
            };
            image.onerror = () => finish(new Error('漫画图片无法读取'));
            signal.addEventListener('abort', abort, {once: true});image.src = data;
        });
    }

    const surface = createMangaCanvas<MangaImageSegment>({...ports, hostId: 'fluent-read-manga-segment-container', source: {
        anchor: segment => segment.image, identity, capture, bounds,
        viewport: segment => ({x: 0, y: segment.top - segment.contextTop, width: segment.width, height: segment.height}),
    }});
    return {...surface, bounds,
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
            pages = next;return pages;
        },
        resetCache() {pages.clear();surface.resetCache();},
        dispose() {disposed = true;pages.clear();surface.dispose();},
    };
}
