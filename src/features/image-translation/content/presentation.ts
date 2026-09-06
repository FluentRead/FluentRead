/**
 * @file src/features/image-translation/content/presentation.ts
 * 文件职责：解析网页图片的实际视觉承载面，兼容宿主把 img 设为透明、再由同级背景图绘制原图的实现。
 * 主要内容：在原图被宿主隐藏时，仅接受 URL、同级关系和几何尺寸都明确一致的唯一背景面，并提供背景尺寸到译图 object-fit 的映射。
 * 模块边界：本模块只读取当前 DOM、计算样式和几何，不写入页面、不管理翻译请求；runtime 负责保存返回的 element，避免租约隐藏原图后再次依赖 opacity 重新发现。
 */
export type ImagePresentationKind = 'image' | 'background';

export interface ImagePresentation {
    element: HTMLElement;
    kind: ImagePresentationKind;
}

export interface BitmapSurfaceStyle {
    objectFit: string;
    objectPosition: string;
}

const EPSILON = 0.5;

function imageSources(image: HTMLImageElement): string[] {
    return Array.from(new Set([image.currentSrc, image.getAttribute('src') || '', image.src].filter(Boolean)));
}

function backgroundUrl(backgroundImage: string): string | null {
    if (!backgroundImage || backgroundImage.trim() === 'none') return null;
    let url: string | null = null;
    const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = pattern.exec(backgroundImage))) {
        count += 1;
        const captured = match[1] ?? match[2] ?? match[3];
        url = (captured || '').trim();
    }
    const remainder = backgroundImage.replace(pattern, '').replace(/[\s,]/g, '');
    return count === 1 && !remainder ? url : null;
}

function rectMatches(left: DOMRect, right: DOMRect): boolean {
    return Math.abs(left.left - right.left) <= EPSILON
        && Math.abs(left.top - right.top) <= EPSILON
        && Math.abs(left.width - right.width) <= EPSILON
        && Math.abs(left.height - right.height) <= EPSILON
        && left.width > 0 && left.height > 0;
}

function intersects(left: DOMRect, right: DOMRect): boolean {
    return left.left < right.right - EPSILON && right.left < left.right - EPSILON
        && left.top < right.bottom - EPSILON && right.top < left.bottom - EPSILON;
}

function isVisible(style: CSSStyleDeclaration): boolean {
    return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && Number.parseFloat(style.opacity || '1') > 0;
}

/**
 * Returns the original image unless a hidden image has one unambiguous visual
 * sibling painting the exact same source into the exact same rectangle.
 */
export function resolveImagePresentation(image: HTMLImageElement): ImagePresentation {
    const fallback: ImagePresentation = {element: image, kind: 'image'};
    const imageStyle = getComputedStyle(image);
    if (imageStyle.display === 'none' || imageStyle.visibility === 'hidden' || imageStyle.visibility === 'collapse'
        || Number.parseFloat(imageStyle.opacity || '1') !== 0) return fallback;

    const parent = image.parentElement;
    if (!parent) return fallback;
    const sourceSet = new Set(imageSources(image));
    if (!sourceSet.size) return fallback;
    const imageRect = image.getBoundingClientRect();
    const candidates = Array.from(parent.children).filter((child): child is HTMLElement => {
        if (child === image || child.nodeType !== 1) return false;
        const style = getComputedStyle(child);
        if (!isVisible(style)) return false;
        const url = backgroundUrl(style.backgroundImage || '');
        return Boolean(url && sourceSet.has(url) && rectMatches(child.getBoundingClientRect(), imageRect));
    });
    if (candidates.length !== 1) return fallback;

    const candidate = candidates[0];
    const candidateRect = candidate.getBoundingClientRect();
    // A second painted sibling occupying this surface makes ownership unclear.
    const overlapping = Array.from(parent.children).some(child => {
        if (child === image || child === candidate || child.nodeType !== 1) return false;
        const style = getComputedStyle(child);
        return Boolean(backgroundUrl(style.backgroundImage || ''))
            && intersects(child.getBoundingClientRect(), candidateRect);
    });
    return overlapping ? fallback : {element: candidate, kind: 'background'};
}

/** Verify source ownership after the original img has been hidden by a lease. */
export function presentationMatchesSource(image: HTMLImageElement, presentation: ImagePresentation): boolean {
    if (presentation.kind === 'image') return presentation.element === image;
    const parent = image.parentElement;
    if (!parent || presentation.element === image || presentation.element.parentElement !== parent) return false;
    const sourceSet = new Set(imageSources(image));
    const url = backgroundUrl(getComputedStyle(presentation.element).backgroundImage || '');
    return Boolean(url && sourceSet.has(url));
}

/** Convert a background surface's sizing and position into bitmap properties. */
export function surfaceStyleToBitmap(style: Pick<CSSStyleDeclaration, 'backgroundSize' | 'backgroundPosition'>): BitmapSurfaceStyle {
    const size = (style.backgroundSize || '').trim().toLowerCase();
    const objectFit = size === 'cover' || size === 'contain' ? size : size === 'auto' ? 'none' : 'fill';
    return {
        objectFit,
        objectPosition: (style.backgroundPosition || '50% 50%').trim() || '50% 50%',
    };
}
