/**
 * @file src/features/image-translation/content/imagePreview.ts
 * 文件职责：在宿主图片查看器内识别用户刚打开的原图。
 * 主要内容：匹配已加载图片的实际资源，允许 X 同一媒体的非裁切尺寸变体，并排除隐藏或歧义候选。
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

export function samePreviewImage(source: PreviewImageSource, candidate: HTMLImageElement): boolean {
    if (!candidate.complete || !candidate.naturalWidth || !candidate.naturalHeight) return false;
    const enlarged = candidate.currentSrc || candidate.src;
    if (source.url === enlarged) return Boolean(source.url);
    if (!X_HOST.test(candidate.ownerDocument.location?.hostname || '')) return false;
    const identity = xMediaIdentity(source.url);
    if (!identity || identity !== xMediaIdentity(enlarged) || !source.width || !source.height) return false;
    // 容许 CDN 缩放时的整数舍入。即使媒体 ID 相同，裁切后的像素也不能套用整图译文。
    const {width, height} = source;
    return Math.abs(width * candidate.naturalHeight - height * candidate.naturalWidth)
        <= Math.max(width, height, candidate.naturalWidth, candidate.naturalHeight);
}

export function visibleImageViewers(document: Document): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(VIEWER_SELECTOR)).filter(isOpenImageViewer);
}

export function isOpenImageViewer(viewer: HTMLElement): boolean {
    if (!viewer.isConnected || !viewer.matches(VIEWER_SELECTOR) || viewer.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(viewer);
    const rect = viewer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && Number.parseFloat(style.opacity || '1') > 0;
}

export function isNativeModal(viewer: HTMLElement): boolean {
    return viewer.tagName === 'DIALOG' && CSS.supports('selector(:modal)') && viewer.matches(':modal');
}
