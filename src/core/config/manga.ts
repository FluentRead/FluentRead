/**
 * @file src/core/config/manga.ts
 * 文件职责：定义漫画阅读页的内置匹配与用户扩展规则，使网站识别独立于普通图片和悬浮球开关。
 * 主要内容：精确适配 MANGA Plus、Pixiv，并接入经过结构核对的正文规则及 GANMA 路径、MangaLib p 与既有 page 页码的稳定章节身份；仅自动源语言使用已核对的俄语和韩语阅读路径提示，手动源语言与自定义规则优先；网站目录与通用路径（含 manga/manhwa/manhua/webtoon 等）配合 DOM 检测，Countdown 主页须有正文才发布入口；可读背景接入连续模式，无法读取的画布和分片走圈选入口；校验用户规则与提前翻译窗口，允许本机和局域网自托管阅读器显式端口，拒绝无正文首页、冒充内置站点的域名、公网端口和非网页协议。
 * 模块边界：纯配置领域匹配，用户规则与数值归一化由同一轻量模块实现并保留本文件公开导出；不读取 DOM、不保存配置、不请求图片，正文图片是否可处理由漫画阅读器判断。
 */
import {isCatalogMangaHost, MANGA_READER_SELECTORS} from './mangaSiteCatalog';
import {resolveMangaReaderProfile} from './mangaReaderProfiles';
import {isLocalMangaHost, normalizeMangaSiteRules, type MangaSiteRule} from './mangaNormalization';
export {createMangaSiteRule, normalizeMangaSiteRules, normalizeMangaPrefetchPages, normalizeMangaCachePages, mangaCachePixelBudget, type MangaSiteRule} from './mangaNormalization';
export interface MangaSite {name: string; selector: string; custom: boolean; generic?: boolean; requireContent?: boolean; sourceLanguage?: 'ru' | 'ko'; chapterPath?: string; pageQueryParameter?: 'page' | 'p'; canvasSelector?: string; canvasInteractionSelector?: string; loadingSelector?: string; backgroundSelector?: string; areaSelector?: string}

export function resolveMangaSite(href: string, rules: MangaSiteRule[] = []): MangaSite | null {
    try {
        const url = new URL(href);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || (url.port && (!isLocalMangaHost(url.hostname) || url.port === '0'))) return null;
        const host = url.port ? url.host : url.hostname;
        const custom = normalizeMangaSiteRules(rules).find(rule => rule.hostname === host
            && (url.pathname === rule.pathPrefix || url.pathname.startsWith(rule.pathPrefix.endsWith('/') ? rule.pathPrefix : `${rule.pathPrefix}/`)));
        if (custom) return {name: host, selector: custom.selector, custom: true};
        if (/^(?:mangaplus\.shueisha\.co\.jp|(?:www\.)?pixiv\.net)\./.test(url.hostname)) return null;
        if (url.hostname === 'mangaplus.shueisha.co.jp') return url.protocol === 'https:' && /^\/viewer\/\d+\/?$/.test(url.pathname)
            ? {name: 'MANGA Plus', selector: '.zao-image-container img.zao-image', custom: false} : null;
        if (['pixiv.net','www.pixiv.net'].includes(url.hostname)) {
            const id = /^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/.exec(url.pathname)?.[1];
            return url.protocol === 'https:' && id ? {name:'Pixiv',custom:false,
                selector:`img[src*="/img-master/"][src*="/${id}_p"], img[src*="/img-original/"][src*="/${id}_p"]`} : null;
        }
        const profile = resolveMangaReaderProfile(url.hostname, url.pathname, url.search);
        if (profile) return {...profile, custom: false, requireContent: true};
        const readingPath = /(?:^|[\/-])(?:read(?:er)?|viewer|chapters?|episodes?|comics?|manga|manhwa|manhua|webtoons?)(?:[\/-]|\d)/i.test(url.pathname);
        if (url.pathname !== '/' && (isCatalogMangaHost(url.hostname) || readingPath)) return {name:host,custom:false,generic:true,
            selector:MANGA_READER_SELECTORS + (readingPath ? ', main img, article img' : ''),
            areaSelector:'#reader canvas, #viewer canvas, #manga-reader canvas, .reader-area canvas, .reading-content canvas, [data-manga-reader] canvas'};
        return null;
    } catch { return null; }
}

/** 只在自动模式使用内置阅读路径的已确认语言；不猜测页面文本，不写回全局偏好。 */
export function resolveMangaSourceLanguage(href: string, sourceLanguage: string, rules: MangaSiteRule[] = []): string {
    return sourceLanguage === 'auto' ? resolveMangaSite(href, rules)?.sourceLanguage ?? sourceLanguage : sourceLanguage;
}
