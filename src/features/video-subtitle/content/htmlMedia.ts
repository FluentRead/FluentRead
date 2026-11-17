/**
 * @file src/features/video-subtitle/content/htmlMedia.ts
 * 文件职责：为普通网页的 HTML 音视频按需启停字幕运行时，维护独立于宿主播放器布局的字幕宿主。
 * 主要内容：仅在媒体增删时合并检测；无媒体不启动字幕轮询、模型或音频采集；以原媒体的可见矩形定位单个自有浮层，音频使用控件下方的紧凑字幕区，滚动、缩放及全屏时统一校准。
 * 模块边界：不移动或改写原媒体、不请求音频、不选择模型；WeakMap 仅授予当前媒体的学习面板归属，取消与页面卸载时释放观察器、帧和节点。
 */

const owners = new WeakMap<HTMLElement, HTMLMediaElement>();
const MEDIA_SELECTOR = 'audio, video';

export function htmlMediaForPlayer(player: HTMLElement): HTMLMediaElement | undefined {
    return owners.get(player);
}

export function playerOwnsMedia(player: HTMLElement, media: HTMLMediaElement): boolean {
    return player.contains(media) || owners.get(player) === media;
}

/** 普通页面只监听结构，不监听字幕文字及属性，也不对每次正文更新扫描全页。 */
export function mountWhenHtmlMediaPresent(mount: () => () => void, doc: Document = document): () => void {
    let dispose: (() => void) | undefined;
    let frame: number | undefined;
    let destroyed = false;
    const view = doc.defaultView!;
    const sync = () => {
        frame = undefined;
        if (destroyed) return;
        const present = Array.from(doc.querySelectorAll(MEDIA_SELECTOR)).some(node => !node.closest('.fluent-read-video-ui'));
        if (present && !dispose) dispose = mount();
        else if (!present && dispose) {const previous = dispose; dispose = undefined; previous();}
    };
    const containsMedia = (node: Node): boolean => (node.nodeType === 1 || node.nodeType === 11)
        && !(node as Element).closest?.('.fluent-read-video-ui')
        && ((node as Element).matches?.(MEDIA_SELECTOR) || Boolean((node as ParentNode).querySelector(MEDIA_SELECTOR)));
    const observer = new MutationObserver(records => {
        if (frame !== undefined || !records.some(record => [...record.addedNodes, ...record.removedNodes].some(containsMedia))) return;
        frame = view.requestAnimationFrame(sync);
    });
    observer.observe(doc.documentElement, {subtree: true, childList: true});
    sync();
    return () => {
        destroyed = true;
        observer.disconnect();
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        const previous = dispose; dispose = undefined; previous?.();
    };
}

export function createHtmlMediaHost(onLayout: () => void, doc: Document = document) {
    const view = doc.defaultView!;
    const host = doc.createElement('div');
    host.className = 'fluent-read-html-media-host fluent-read-video-ui notranslate';
    host.setAttribute('data-fluent-read-ui', 'video-subtitle');
    host.setAttribute('translate', 'no');
    let media: HTMLMediaElement | undefined;
    let frame: number | undefined;
    let destroyed = false;
    const sync = () => {
        frame = undefined;
        if (destroyed || !media) return false;
        const rect = media.getBoundingClientRect();
        const audio = media.tagName === 'AUDIO';
        const viewport = view.visualViewport;
        const left = Math.max(viewport?.offsetLeft || 0, rect.left);
        const right = Math.min((viewport?.offsetLeft || 0) + (viewport?.width || view.innerWidth), rect.right);
        const top = audio ? rect.bottom + 4 : rect.top;
        host.hidden = !media.isConnected || rect.width <= 0 || rect.height <= 0 || right <= left
            || rect.bottom <= 0 || rect.top >= view.innerHeight || view.getComputedStyle(media).visibility === 'hidden';
        // 元素自身的原生全屏只能显示浏览器字幕；容器全屏允许自有浮层随同进入。
        const fullscreen = doc.fullscreenElement;
        const parent = fullscreen && fullscreen !== media && fullscreen.contains(media) ? fullscreen : doc.documentElement;
        if (host.parentElement !== parent) parent.appendChild(host);
        host.dataset.mediaKind = audio ? 'audio' : 'video';
        host.style.cssText = `position:fixed!important;left:${left}px!important;top:${top}px!important;width:${Math.max(0, right - left)}px!important;height:${audio ? 120 : rect.height}px!important;pointer-events:none!important;z-index:2147483645!important;`;
        return true;
    };
    const schedule = () => {
        if (destroyed || frame !== undefined) return;
        frame = view.requestAnimationFrame(() => {if (sync()) onLayout();});
    };
    const resize = new ResizeObserver(schedule);
    doc.addEventListener('scroll', schedule, true);
    doc.addEventListener('fullscreenchange', schedule);
    view.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('scroll', schedule);
    view.visualViewport?.addEventListener('resize', schedule);
    return {
        getPlayer(next: HTMLMediaElement): HTMLElement {
            if (media !== next) {
                resize.disconnect(); media = next; owners.set(host, next); resize.observe(next);
            }
            sync();
            return host;
        },
        destroy() {
            destroyed = true;
            resize.disconnect();
            doc.removeEventListener('scroll', schedule, true);
            doc.removeEventListener('fullscreenchange', schedule);
            view.removeEventListener('resize', schedule);
            view.visualViewport?.removeEventListener('scroll', schedule);
            view.visualViewport?.removeEventListener('resize', schedule);
            if (frame !== undefined) view.cancelAnimationFrame(frame);
            owners.delete(host); media = undefined; host.remove();
        },
    };
}
