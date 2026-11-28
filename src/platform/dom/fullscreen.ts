/**
 * @file src/platform/dom/fullscreen.ts
 * 文件职责：提供跨浏览器的全屏元素读取、全屏状态变更订阅与画中画状态判定工具。
 * 主要内容：兼容标准 fullscreenElement 与 Safari webkitFullscreenElement，统一订阅 fullscreenchange 与 webkitfullscreenchange 并返回可重复调用的清理函数，同时安全检测媒体元素是否处于标准 Picture-in-Picture 或 Safari webkitPresentationMode 画中画。
 * 模块边界：仅封装 Document 与 HTMLMediaElement 的标准/前缀只读 DOM 能力，不读取业务配置、不操作播放器节点，也不修改全屏或画中画状态。
 */

type PrefixedFullscreenDocument = Document & {
    webkitFullscreenElement?: Element | null;
    pictureInPictureElement?: Element | null;
};

type SafariPresentationMedia = HTMLMediaElement & {
    webkitPresentationMode?: string;
};

/** 读取当前处于全屏状态的元素，兼容 Safari 的 webkitFullscreenElement 前缀属性。 */
export function getFullscreenElement(doc: Document): Element | null {
    return doc.fullscreenElement
        || (doc as PrefixedFullscreenDocument).webkitFullscreenElement
        || null;
}

/** 订阅标准与 WebKit 前缀的全屏变更事件，返回移除全部监听的清理函数。 */
export function onFullscreenChange(
    doc: Document,
    listener: () => void,
    options?: boolean | AddEventListenerOptions,
): () => void {
    doc.addEventListener('fullscreenchange', listener, options);
    doc.addEventListener('webkitfullscreenchange', listener, options);
    return () => {
        doc.removeEventListener('fullscreenchange', listener, options);
        doc.removeEventListener('webkitfullscreenchange', listener, options);
    };
}

/** 判断指定媒体元素当前是否为文档的画中画元素（兼容 Safari webkitPresentationMode）；缺少 API 或元素为空时安全返回 false。 */
export function isElementInPictureInPicture(doc: Document, media: HTMLMediaElement | null): boolean {
    if (!media) return false;
    return (doc as PrefixedFullscreenDocument).pictureInPictureElement === media
        || (media as SafariPresentationMedia).webkitPresentationMode === 'picture-in-picture';
}
