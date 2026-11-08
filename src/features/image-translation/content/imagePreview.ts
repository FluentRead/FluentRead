/**
 * @file src/features/image-translation/content/imagePreview.ts
 * 文件职责：在宿主图片查看器内识别用户刚打开的原图。
 * 主要内容：匹配已加载图片的实际资源，允许 X 同一媒体的非裁切尺寸变体，并识别保留节点的 CSS 隐藏和裁切。
 * 模块边界：只读页面结构和图片属性；译图复用、显示权和清理由 runtime 管理。
 */

const VIEWER_SELECTOR = 'dialog[open], [role="dialog"]:not(dialog), [aria-modal="true"]:not(dialog)';
const X_HOST = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/u;
const X_FULL_SIZE = /^(?:orig|small|medium|large|\d+x\d+)$/u;

export interface PreviewImageSource {
    url: string;
    width: number;
    height: number;
}

function xMediaIdentity(source: string): string | undefined {
    // 只归一化同一个媒体 ID 的 CDN 尺寸和编码格式，保留其他所有参数。
    if (!source.startsWith('https://pbs.twimg.com/media/')) return;
    const url = new URL(source);
    if (!/^\/media\/[\w-]+$/u.test(url.pathname)) return;
    const sizes = url.searchParams.getAll('name');
    if (sizes.length !== 1 || !X_FULL_SIZE.test(sizes[0])) return;
    url.searchParams.delete('name');
    url.searchParams.delete('format');
    url.searchParams.sort();
    return url.href;
}

export function samePreviewResource(source: PreviewImageSource, enlarged: string, hostname: string): boolean {
    if (source.url === enlarged) return Boolean(source.url);
    if (!X_HOST.test(hostname)) return false;
    const identity = xMediaIdentity(source.url);
    return Boolean(identity && identity === xMediaIdentity(enlarged));
}

export function samePreviewImage(source: PreviewImageSource, candidate: HTMLImageElement): boolean {
    if (!candidate.complete || !candidate.naturalWidth || !candidate.naturalHeight) return false;
    const enlarged = candidate.currentSrc || candidate.src;
    if (!samePreviewResource(source, enlarged, candidate.ownerDocument.location?.hostname || '')) return false;
    if (source.url === enlarged) return true;
    if (!source.width || !source.height) return false;
    // 容许 CDN 缩放时的整数舍入。即使媒体 ID 相同，裁切后的像素也不能套用整图译文。
    const {width, height} = source;
    return Math.abs(width * candidate.naturalHeight - height * candidate.naturalWidth)
        <= Math.max(width, height, candidate.naturalWidth, candidate.naturalHeight);
}

export function visibleImageViewers(document: Document): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(VIEWER_SELECTOR)).filter(isOpenImageViewer);
}

function clippedViewerCanBeHit(viewer: HTMLElement, rect: DOMRect): boolean {
    const document = viewer.ownerDocument;
    if (typeof document.elementsFromPoint !== 'function') return true;
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    // 离开视口由常规定位逻辑处理，不能仅凭滚动就认定查看器已关闭。
    if (right <= left || bottom <= top) return true;
    const samples = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
    return samples.some(([x, y]) => document.elementsFromPoint(left + (right - left) * x, top + (bottom - top) * y)
        .some(element => viewer.contains(element)));
}

export function isOpenImageViewer(viewer: HTMLElement): boolean {
    if (!viewer.isConnected || !viewer.matches(VIEWER_SELECTOR) || viewer.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(viewer);
    const rect = viewer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    let clipped = false;
    for (let element: HTMLElement | null = viewer; element; element = element.parentElement) {
        const current = element === viewer ? style : getComputedStyle(element);
        if (Number.parseFloat(current.opacity || '1') <= 0 || current.contentVisibility === 'hidden') return false;
        clipped ||= Boolean(current.clipPath && current.clipPath !== 'none');
    }
    // clip-path 可以完全隐藏原图而不改变它的边框矩形；页面祖先命中不能证明查看器仍可见。
    return !clipped || clippedViewerCanBeHit(viewer, rect);
}

export function isNativeModal(viewer: HTMLElement): boolean {
    return viewer.tagName === 'DIALOG' && CSS.supports('selector(:modal)') && viewer.matches(':modal');
}
