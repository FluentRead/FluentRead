/**
 * @file src/features/video-subtitle/content/htmlMedia.ts
 * 文件职责：为普通网页的 HTML 音视频判断站点与媒体资格、按需启停字幕运行时，并维护稳定且受裁剪约束的独立字幕宿主。
 * 主要内容：排除抖音等国内短视频、长视频、直播、社媒与电商站点的通用媒体自动挂载，并忽略无控件无字幕轨的静音循环/自动播放预览视频；仅在符合条件的媒体增删时合并检测并穿透开放 Shadow DOM 发现音视频；以原媒体经视口与溢出祖先裁剪后的取整矩形定位单个自有浮层，仅在几何或状态实际变化时更新样式，避免无意义重绘和角标抖动，安全守护 ResizeObserver，并在滚动、缩放及跨浏览器全屏时统一校准。
 * 模块边界：不移动或改写原媒体、不请求音频、不选择模型；WeakMap 仅授予当前媒体的学习面板归属，取消与页面卸载时释放观察器、帧和节点。
 */
import {getFullscreenElement, onFullscreenChange} from '@/src/platform/dom/fullscreen';
import {containsDeep, hasSelectorDeep, querySelectorAllDeep} from '@/src/shared/dom/shadowQuery';

const owners = new WeakMap<HTMLElement, HTMLMediaElement>();
const MEDIA_SELECTOR = 'audio, video';
const EXCLUDED_HTML_MEDIA_DOMAINS = [
    'douyin.com', 'iesdouyin.com', 'kuaishou.com', 'gifshow.com',
    'xiaohongshu.com', 'weibo.com', 'weibo.cn', 'ixigua.com',
    'tiktok.com', 'bilibili.com', 'iqiyi.com', 'youku.com',
    'mgtv.com', 'v.qq.com', 'weixin.qq.com', 'tv.sohu.com',
    'miguvideo.com', 'cctv.com', 'acfun.cn', 'douyu.com',
    'huya.com', 'haokan.baidu.com', 'baidu.com', 'zhihu.com',
    'toutiao.com', 'taobao.com', 'tmall.com', 'jd.com',
    'pinduoduo.com', 'yangkeduo.com',
] as const;
const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'scroll', 'auto']);

/** 判断站点是否属于不应自动挂载通用 HTML 媒体字幕入口的短视频、影视、直播或社媒平台。 */
export function isExcludedHtmlMediaHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.+$/u, '');
    if (!host) return false;
    return EXCLUDED_HTML_MEDIA_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function isExcludedHtmlMediaUrl(url: string): boolean {
    if (!url) return false;
    try {
        return isExcludedHtmlMediaHost(new URL(url).hostname);
    } catch {
        return false;
    }
}

function hasSubtitleTracks(media: HTMLMediaElement): boolean {
    const tracks = Array.from(media.textTracks || []);
    if (tracks.some(track => track.kind === 'captions' || track.kind === 'subtitles')) return true;
    return Boolean(media.querySelector?.('track[kind="captions"], track[kind="subtitles"]'));
}

/** 排除 FluentRead 自有节点及无控件无字幕轨的静音循环/自动播放装饰或卡片预览视频。 */
export function isEligibleHtmlMedia(node: Element): boolean {
    if (node.closest?.('.fluent-read-video-ui')) return false;
    const tag = node.tagName?.toUpperCase();
    if (tag === 'AUDIO') return true;
    if (tag !== 'VIDEO') return false;
    const video = node as HTMLVideoElement;
    if (video.controls || video.hasAttribute?.('controls') || hasSubtitleTracks(video)) return true;
    const silent = video.muted === true || video.defaultMuted === true || video.hasAttribute?.('muted');
    const ambient = video.loop === true || video.autoplay === true || video.hasAttribute?.('loop') || video.hasAttribute?.('autoplay');
    return !(silent && ambient);
}

export function htmlMediaForPlayer(player: HTMLElement): HTMLMediaElement | undefined {
    return owners.get(player);
}

export function playerOwnsMedia(player: HTMLElement, media: HTMLMediaElement): boolean {
    return containsDeep(player, media) || owners.get(player) === media;
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
        const present = querySelectorAllDeep(doc, MEDIA_SELECTOR).some(isEligibleHtmlMedia);
        if (present && !dispose) dispose = mount();
        else if (!present && dispose) {const previous = dispose; dispose = undefined; previous();}
    };
    const containsMedia = (node: Node): boolean => (node.nodeType === 1 || node.nodeType === 11)
        && !(node as Element).closest?.('.fluent-read-video-ui')
        && ((node as Element).matches?.(MEDIA_SELECTOR) || hasSelectorDeep(node as ParentNode, MEDIA_SELECTOR));
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

function clipVideoBounds(
    media: HTMLMediaElement,
    rect: DOMRect,
    view: Window,
    doc: Document,
    stopAt: Element | null,
): {left: number; top: number; right: number; bottom: number} {
    const viewport = view.visualViewport;
    const vpLeft = viewport?.offsetLeft || 0;
    const vpTop = viewport?.offsetTop || 0;
    const vpRight = vpLeft + (viewport?.width || view.innerWidth);
    const vpBottom = vpTop + (viewport?.height || view.innerHeight);
    let left = Math.max(vpLeft, rect.left);
    let right = Math.min(vpRight, rect.right);
    let top = Math.max(vpTop, rect.top);
    let bottom = Math.min(vpBottom, rect.bottom);
    for (let current = media.parentElement; current && current !== stopAt && current !== doc.body && current !== doc.documentElement;
        current = current.parentElement) {
        const style = view.getComputedStyle(current);
        const overflow = style.overflow || '';
        const clipX = CLIPPING_OVERFLOW.has(style.overflowX || overflow);
        const clipY = CLIPPING_OVERFLOW.has(style.overflowY || overflow);
        if (!clipX && !clipY) continue;
        const bounds = current.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) continue;
        if (clipX) {left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);}
        if (clipY) {top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);}
    }
    return {left, top, right, bottom};
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
    let lastCssText = '';
    const sync = () => {
        frame = undefined;
        if (destroyed || !media) return false;
        const rect = media.getBoundingClientRect();
        const audio = media.tagName === 'AUDIO';
        const style = view.getComputedStyle(media);
        const hiddenStyle = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
        // 元素自身的原生全屏只能显示浏览器字幕；容器全屏允许自有浮层随同进入（穿透 Shadow DOM 判定包含关系）。
        const fullscreen = getFullscreenElement(doc);
        const parent = fullscreen && fullscreen !== media && containsDeep(fullscreen, media) ? fullscreen : doc.documentElement;
        const viewport = view.visualViewport;
        let left: number;
        let top: number;
        let width: number;
        let height: number;
        let hidden: boolean;
        if (audio) {
            const vpLeft = viewport?.offsetLeft || 0;
            const vpRight = vpLeft + (viewport?.width || view.innerWidth);
            left = Math.max(vpLeft, rect.left);
            const right = Math.min(vpRight, rect.right);
            top = rect.bottom + 4;
            width = Math.max(0, right - left);
            height = 120;
            hidden = !media.isConnected || rect.width <= 0 || rect.height <= 0 || right <= left
                || rect.bottom <= 0 || rect.top >= view.innerHeight || hiddenStyle;
        } else {
            const clipped = clipVideoBounds(media, rect, view, doc, fullscreen && containsDeep(fullscreen, media) ? fullscreen : null);
            left = clipped.left;
            top = clipped.top;
            width = Math.max(0, clipped.right - clipped.left);
            height = Math.max(0, clipped.bottom - clipped.top);
            hidden = !media.isConnected || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0 || hiddenStyle;
        }
        if (host.hidden !== hidden) host.hidden = hidden;
        if (host.parentElement !== parent) parent.appendChild(host);
        const mediaKind = audio ? 'audio' : 'video';
        if (host.dataset.mediaKind !== mediaKind) host.dataset.mediaKind = mediaKind;
        const nextCssText = `position:fixed!important;left:${Math.round(left)}px!important;top:${Math.round(top)}px!important;width:${Math.round(width)}px!important;height:${Math.round(height)}px!important;pointer-events:none!important;z-index:2147483645!important;`;
        if (nextCssText !== lastCssText) {
            lastCssText = nextCssText;
            host.style.cssText = nextCssText;
        }
        return true;
    };
    const schedule = () => {
        if (destroyed || frame !== undefined) return;
        frame = view.requestAnimationFrame(() => {if (sync()) onLayout();});
    };
    const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
    const stopFullscreen = onFullscreenChange(doc, schedule);
    doc.addEventListener('scroll', schedule, true);
    view.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('scroll', schedule);
    view.visualViewport?.addEventListener('resize', schedule);
    return {
        getPlayer(next: HTMLMediaElement): HTMLElement {
            if (media !== next) {
                resize?.disconnect(); media = next; owners.set(host, next); resize?.observe(next);
            }
            sync();
            return host;
        },
        destroy() {
            destroyed = true;
            resize?.disconnect();
            stopFullscreen();
            doc.removeEventListener('scroll', schedule, true);
            view.removeEventListener('resize', schedule);
            view.visualViewport?.removeEventListener('scroll', schedule);
            view.visualViewport?.removeEventListener('resize', schedule);
            if (frame !== undefined) view.cancelAnimationFrame(frame);
            owners.delete(host); media = undefined; lastCssText = ''; host.remove();
        },
    };
}
