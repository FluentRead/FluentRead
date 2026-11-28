/**
 * @file src/core/config/mangaReaderProfiles.ts
 * 文件职责：保存经公开阅读页结构核对的正文规则，避免通用图片过滤漏掉正文或误选推荐封面。
 * 主要内容：Ridi 公开试读语义容器的 blob 整页与商品推广排除、Ynjn 公开正文的直系 Swiper 画布与 Yomonga 明确章节参数的整页分片圈选、已核对的 MangaLib、Mangahub 俄语与 ComicNaver、Ridi、Bomtoon、Novelpia、TOPTOON、Kakao 韩语阅读路径语言提示、Templetoons 免费章直系长图与链接推广排除、MangaLib 原站语义阅读容器的编号页面与 MangaOI 直系章节图片、ACG 当前域名编号页的直接正文与推荐排除、Yamibo 公开单章主图与同章分页、Bomtoon 公开可读的正文画布结构兜底与版权图片排除、公开图书库当前页与合法档案编号边界、BeLTOON 免费正文及结构兜底、comipo 公开免费 blob 正文与 JComic 单帖直系正文，Hentaizap 路径翻页主图及 Yaoi Manga Online、NHentaiYaoi 单帖正文列表，Raven 正文长图、Novelpia 受限首话圈选、蜡笔小新正文、Lezhin 英语 blob 正文和 Ameba 受限试读画布圈选、已核对章节站与 GANMA 编号原稿及路径页码、TOPTOON 不可读画布和首图的圈选规则、Ranfren 静态正文、漫画站懒加载正文、POIPIKU 单帖主图、Countdown 的主页正文、MANGA Million 编号图片、Orchisasia、Qi Manga、Nyx、Omega、MangaYun、Mangahub、Rinko、RawDEX、Raw1001 等正文规则，GlobalComix 跨域正文提供圈选入口，MechaComic 完整图与 Palcy、Comic Pixiv 背景正文规则，查询参数章节边界与 Mangahub 正整数翻页参数，哔哩哔哩在内容脚本中可读的正文画布及透明弹幕交互层、PASH UP 当前屏与 GigaViewer、Comici、ComicWalker、Animate 正文画布规则，MangaLove 不可读画布和 Booklive、CMOA 分片的圈选入口；路径与域名均保留边界。
 * 正文补充：Toonily 正整数章节路径只选择直系阅读页图片，排除封面、推荐和嵌套推广。
 * 模块边界：纯匹配，不执行站点脚本、不读取私有接口、不截图；可访问的图片由 content 阅读器检测。
 */
const gigaHosts = new Set(['comic-action.com', 'comic-days.com', 'comic-gardo.com', 'comic-trail.com',
    'kuragebunch.com', 'shonenjumpplus.com', 'tonarinoyj.jp', 'comic-zenon.com', 'ichicomi.com', 'sunday-webry.com']);
export const MANGA_AREA_READER_HOSTS = [...gigaHosts, 'yanmaga.jp', 'televikun-super-hero-comics.com', 'jumptoon.com', 'comic-meteor.jp', 'kirapo.jp', 'pocket.shonenmagazine.com', 'cmoa.jp', 'globalcomix.com', 'mangalove.me', 'toptoon.com', 'dokusho-ojikan.jp', 'novelpia.com', 'yomonga.com'];
export const MANGA_BACKGROUND_READER_HOSTS = ['palcy.jp', 'comic.pixiv.net'];
const comiciHosts = ['championcross.jp', 'comic-ryu.jp', 'comic-growl.com',
    'rimacomiplus.jp', 'heros-web.com', 'younganimal.com', 'youngchampion.jp'];
export const MANGA_CANVAS_READER_HOSTS = [...comiciHosts, 'comic-walker.com', 'animatebookstore.com', 'pash-up.jp', 'manga.bilibili.com', 'bomtoon.com', 'ynjn.jp'];
export function resolveMangaReaderProfile(hostname: string, pathname: string, search = ''): {name: string; selector: string; sourceLanguage?: 'ru' | 'ko'; chapterPath?: string; pageQueryParameter?: 'page' | 'p'; canvasSelector?: string; canvasInteractionSelector?: string; loadingSelector?: string; backgroundSelector?: string; areaSelector?: string} | null {
    const host = hostname.replace(/^www\./, '');
    if (host === 'toonily.com' && /^\/serie\/[a-z\d]+(?:-[a-z\d]+)*\/chapter-[1-9]\d*\/?$/.test(pathname)) return {
        name: 'Toonily', selector: '.entry-content_wrap > .read-container > .reading-content > .page-break > img.wp-manga-chapter-img',
    };
    if (host === 'ridibooks.com' && /^\/books\/[1-9]\d*\/preview\/?$/.test(pathname)) return {
        name: 'Ridi', selector: '#root .pre_reading .contents_comics > .reading_body > .viewer > .viewer_viewport .simplebar-content > div > div > div > div > img[src^="blob:https://ridibooks.com/"]', sourceLanguage: 'ko',
    };
    if (host === 'ynjn.jp' && /^\/title\/[1-9]\d*\/?$/.test(pathname)) return {
        name: 'ヤンジャン＋', selector: ':not(*)',
        canvasSelector: '#__nuxt .swiper-horizontal > .swiper-wrapper > .swiper-slide > div.max-h-full.max-w-full > canvas.max-h-full.max-w-full',
        areaSelector: '#__nuxt .swiper-horizontal > .swiper-wrapper > .swiper-slide > div.max-h-full.max-w-full > canvas.max-h-full.max-w-full',
    };
    if (host === 'yomonga.com' && /^\/titles\/[1-9]\d*\/?$/.test(pathname)) {
        const parameters = new URLSearchParams(search), episodes = parameters.getAll('episode'), contentIds = parameters.getAll('cid');
        if (episodes.length === 1 && /^[1-9]\d*$/.test(episodes[0])
            && contentIds.length === 1 && /^[1-9]\d*$/.test(contentIds[0])) return {
            name: 'マンガよもんが', selector: ':not(*)',
            areaSelector: '#contents.cst_info > #content_base > #content.pages > div[id^="content-p"] > .pt-img',
        };
    }
    if (host === 'templetoons.com' && /^\/comic\/[a-z\d]+(?:-[a-z\d]+)*\/(?:[1-9]\d*-)?chapter-[1-9]\d*\/?$/.test(pathname)) return {
        name: 'Templetoons', selector: 'main > .protected-content > div.protected-content > div.relative > img.select-none',
    };
    if (host === 'mangaoi.net' && /^\/read-manga\/[A-Za-z\d]+(?:-[A-Za-z\d]+)*\/chapter-[1-9]\d*(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'MangaOI', selector: '.inner.chapter-wapper > .chapter-content > .item-chapter > img',
    };
    if (host === 'mangalib.me' && /^\/ru\/[1-9]\d*--[a-z\d][a-z\d-]*\/read\/v[1-9]\d*\/c[1-9]\d*(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'MangaLib', selector: '[data-reader-mode] > main[data-reader-info-visible] > div > div[data-page] > img', pageQueryParameter: 'p', sourceLanguage: 'ru',
    };
    const acgChapter = host === 'acgmhn.com' ? /^\/h\/([1-9]\d*)(?:-([1-9]\d{0,3}))?\.html$/.exec(pathname) : null;
    if (acgChapter) return {
        name: 'ACG 漫画网', selector: '.content > .acg-manga > .manga-page > p.manga-picture > img',
        chapterPath: `/h/${acgChapter[1]}.html`,
    };
    if (host === 'yamibo.com' && /^\/manga\/view-chapter\/?$/.test(pathname)) {
        const parameters = new URLSearchParams(search), ids = parameters.getAll('id'), pages = parameters.getAll('page');
        if (ids.length === 1 && /^[1-9]\d*$/.test(ids[0]) && pages.length <= 1
            && (pages.length === 0 || /^[1-9]\d{0,3}$/.test(pages[0]))) return {
            name: 'Yamibo', selector: 'section > .row > .col-md-12 > .thumbnail > img#imgPic.img-responsive', pageQueryParameter: 'page',
        };
    }
    if (host === 'bomtoon.com' && /^\/viewer\/[A-Za-z\d]+(?:[-_][A-Za-z\d]+)*\/p(?:0|[1-9]\d*)\/?$/.test(pathname)) return {
        name: 'Bomtoon', selector: ':not(*)', sourceLanguage: 'ko',
        canvasSelector: '.printView .sc-gHLcSH > .sc-jvLaUc > .sc-edUIhV > .sc-hjQCSK > canvas.sc-bSakgD, .printView div > div > div > div > canvas[class*="sc-"]',
        areaSelector: '.printView .sc-gHLcSH > .sc-jvLaUc > .sc-edUIhV > .sc-hjQCSK > canvas.sc-bSakgD, .printView div > div > div > div > canvas[class*="sc-"]',
    };
    if (host === 'lrr.tvc-16.science' && /^\/reader\/?$/.test(pathname)
        && new URLSearchParams(search).getAll('id').length === 1
        && /^[a-f\d]{40}$/.test(new URLSearchParams(search).get('id')!)) return {
        name: 'LANraragi public demo', selector: '#i1 > #i3 > a#display > img#img.reader-image',
    };
    if (host === 'beltoon.jp' && /^\/viewer\/[a-z\d]+(?:[-_][a-z\d]+)*\/p[1-9]\d*\/?$/.test(pathname)) return {
        name: 'BeLTOON', selector: '.printView .sc-iXxrte > .sc-jhzXDd > img.sc-jSMfEi[src^="blob:https://www.beltoon.jp/"], .printView div > div > img[src^="blob:https://www.beltoon.jp/"]',
    };
    if (host === 'play.comipo.app' && /^\/viewer\/free\/BJ\d+\/?$/.test(pathname)) return {
        name: 'comipo', selector: 'div[class^="_slide_container_"] > div[class^="_spread_"] > div[class^="_page_container_"] > div[class^="_placeholder_"] > img[class^="_page_"][src^="blob:https://play.comipo.app/"]',
    };
    if (host === 'jcomic.net' && /^\/page\/[^/]+\/?$/.test(pathname)) return {
        name: 'JComic', selector: 'body > .container > .row.col-lg-12.col-md-12.col-xs-12 > img.comic-thumb.jcomic-img',
    };
    if (host === 'hentaizap.com' && /^\/g\/[1-9]\d*\/[1-9]\d*\/?$/.test(pathname)) return {
        name: 'Hentaizap', chapterPath: pathname.replace(/\/\d+\/?$/, ''),
        selector: '#readerApp > #readerAnchor.reader_img > img#readerImg',
    };
    if (host === 'yaoimangaonline.com' && /^\/[a-z\d]+(?:-[a-z\d]+)*\/?$/.test(pathname)) return {
        name: 'Yaoi Manga Online', selector: 'body.single-post article.herald-single .entry-content.herald-entry-content > p > img.alignnone[class*="wp-image-"]',
    };
    if (host === 'nhentaiyaoi.net' && /^\/[a-z\d]+(?:-[a-z\d]+)*\/?$/.test(pathname)) return {
        name: 'NHentaiYaoi', selector: 'body.single-post .post-box.listaImagens > ul.post-fotos > li > a > img',
    };
    if (host === 'ravenscans.org' && /^\/[a-z\d]+(?:-[a-z\d]+)*-chapter-\d+(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'Yaksha / Raven Scans', selector: 'article #readerarea > img.ts-main-image',
    };
    if (host === 'novelpia.com' && /^\/comic_viewer\/[1-9]\d*\/?$/.test(pathname)) return {
        name: 'Novelpia', selector: ':not(*)', sourceLanguage: 'ko', areaSelector: '#viewer_wrap > .viewer_content > div > .viewer_content_box > .comic-content > img',
    };
    if (host === 'manga-shinchan.com' && /^\/[a-z\d]+(?:-[a-z\d]+)*\/episode\/[a-z\d]+(?:-[a-z\d]+)*\/?$/.test(pathname)) return {
        name: 'まんがクレヨンしんちゃん', selector: '#ep_blog .item__list-lists > figure > img[src*="/book_data/article_data/"]',
    };
    if (host === 'lezhinus.com' && /^\/en\/comic\/[a-z\d_]+\/[1-9]\d*\/?$/.test(pathname)) return {
        name: 'Lezhin Comics', selector: '.scroll-view > .mx-auto.overflow-hidden.max-w-720 > img.w-full.h-full.select-none.pointer-events-none[src^="blob:https://www.lezhinus.com/"]',
    };
    if (host === 'dokusho-ojikan.jp' && pathname === '/reader/index.html'
        && new URLSearchParams(search).getAll('cid').length === 1
        && /^[1-9]\d*$/.test(new URLSearchParams(search).get('cid')!)) return {
        name: 'Amebaマンガ', selector: ':not(*)', areaSelector: '.view-sheet-container .view-sheet .content.zoomable > canvas',
    };
    if (host === 'ganma.jp' && /^\/web\/reader\/[a-z\d]+(?:-[a-z\d]+)*\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/(?:0|[1-9]\d{0,3})\/?$/.test(pathname)) return {
        name: 'GANMA!', chapterPath: pathname.replace(/\/\d+\/?$/, ''),
        selector: '.h-full-container.w-full-container > .flex.select-none > .relative.flex-1 > img.pointer-events-none.object-contain[alt$="ページ目の原稿画像"]',
    };
    if (host === 'toptoon.com' && /^\/comic\/ep_view\/[A-Za-z\d_]+\/[1-9]\d*\/rent\/?$/.test(pathname)) return {
        name: 'TOPTOON', selector: ':not(*)', sourceLanguage: 'ko',
        areaSelector: '#viewerContentsWrap > .comic_img > img.document_img, #viewerContentsWrap > .comic_img > .canvas-wrapper.document_img > canvas',
    };
    if (host === 'manga.bilibili.com' && /^\/mc\d+\/\d+\/?$/.test(pathname)) return {
        name: '哔哩哔哩漫画', selector: ':not(*)',
        canvasSelector: '.images-container > .view-container > .image-container > canvas',
        canvasInteractionSelector: '.images-container > .view-container > .image-container > .bullet-screen > .bullet-container',
        loadingSelector: '.images-container > .view-container > .loading-hinter',
    };
    if (host === 'manhuazhan.com' && /^\/chapter\/\d+-\d+\.html$/.test(pathname)) return {
        name: '漫画站', selector: '#ChapterContent > p.chapterpic > img.lazy[src]:not([src*="/lazyload.gif"])',
    };
    if (host === 'poipiku.com' && /^\/\d+\/\d+\.html$/.test(pathname)) return {
        name: 'POIPIKU', selector: '#IllustItemList > .IllustItem > a.IllustItemThumb > img.IllustItemThumbImg',
    };
    if (host === 'ranfren.neocities.org' && /^\/lucid\/(?:lucid\d+(?:\.\d+)?\/[A-Za-z0-9_-]+(?:\.\d+)?|extra\/gettingstronger)(?:\.html)?$/.test(pathname)) return {
        name: 'Ranfren', selector: 'center > img[src*="/lucid/"]',
    };
    if (host === 'ctccomic.com' && (pathname === '/' || /^\/comic\/\d+\/?$/.test(pathname))) return {
        name: 'Countdown to Countdown', selector: '#cc-comicbody > a > img#cc-comic',
    };
    if (host === 'orchisasia.org' && /^\/comic\/[^/]+\/\d+-chapter-\d+(?:\.[0-9]+)?(?:-[A-Za-z0-9_-]+)?\/?$/.test(pathname)) return {
        name: 'Orchisasia', selector: '.read-container .reading-content > .page-break > img.wp-manga-chapter-img',
    };
    if (host === 'pash-up.jp' && pathname === '/viewer/viewer.html') return {
        name: 'PASH UP', selector: ':not(*)',
        canvasSelector: '#viewer > #renderer > :is(#viewport0, #viewport1).currentScreen > canvas',
        areaSelector: '#viewer > #renderer > :is(#viewport0, #viewport1).currentScreen > canvas',
    };
    if (host === 'mangamillion.shueisha.co.jp' && /^\/[a-z]{2}(?:-[A-Z]{2})?\/title\/\d+\/chapter\/\d+\/?$/.test(pathname)) return {
        name: 'MANGA Million', selector: 'div[class$="_slide_container"] > div[class$="_spread"] > div[class$="_page_container"] > div[class$="_placeholder"] > img[class$="_page"][alt^="page_"]',
    };
    if (host === 'mangalove.me' && /^\/viewer\/\d+\/?$/.test(pathname)) return {
        name: 'MangaLove', selector: ':not(*)', areaSelector: '#viewerBody .viewer > .imgWrap > canvas',
    };
    if (host === 'qimanga.com' && /^\/series\/[^/]+\/chapter-\d+(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'Qi Manga', selector: 'app-reader .r-strip > .r-page[data-page] > img.r-page-img',
    };
    if (['nyxscans.com', 'omegascans.org'].includes(host) && /^\/series\/[^/]+\/chapter-\d+(?:\.\d+)?\/?$/.test(pathname)) return host === 'nyxscans.com' ? {
        name: 'Nyx Scans', selector: '.comic-body-container .comic-images-wrapper > figure.image-container > img',
    } : {
        name: 'Omega Scans', selector: 'div[class~="lg:container"] > div[class~="flex-col"][class~="items-center"][class~="overflow-hidden"] > div.relative.flex.w-full.justify-center > img.block.object-contain',
    };
    if (host === 'mangayun.com' && /^\/read\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(pathname)) return {
        name: 'MangaYun', selector: '.reader[role="dialog"] .reader-scroll > .reader-page-wrap > img.reader-page',
    };
    if (host === 'mangahub.ru' && /^\/read\/\d+\/?$/.test(pathname)) return {
        name: 'Mangahub', selector: 'reader-viewer reader-scan.reader-viewer-scan > img.reader-viewer-img', pageQueryParameter: 'page', sourceLanguage: 'ru',
    };
    if (host === 'rinkocomics.com' && /^\/chapter\/[^/]+-chapter-\d+(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'Rinko Comics', selector: '.chapter-images-section .images-flow > img.chapter-image[data-page]',
    };
    if (host === 'rawdex.net' && /^\/manga\/[^/]+\/\d+(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'RawDEX', selector: 'section.rdx-reader .rdx-reader-content img.wp-manga-chapter-img',
    };
    if (host === 'raw1001.net' && /^\/manga\/[^/]+\/di\d+(?:\.\d+)?hua\/?$/.test(pathname)) return {
        name: 'Raw1001', selector: '#chapterContent .separator > a.readImg > img',
    };
    if (host === 'v5.luvyaa.co' && /^\/[^/]+-chapter-\d+(?:\.\d+)?\/?$/.test(pathname)) return {
        name: 'Luvyaa', selector: 'article #readerarea > img.ts-main-image',
    };
    if (host === 'manhwaweb.com' && /^\/leer\/[^/]+_\d+-\d+(?:\.\d+)?_\d+\/?$/.test(pathname)) return {
        name: 'ManhwaWeb', selector: 'div[class~="md:max-w-3xl"].m-auto > img.w-full',
    };
    if (host === 'klz9.com' && /^\/[^/]+-chapter-\d+(?:\.\d+)?\.html$/.test(pathname)) return {
        name: 'KL', selector: 'main .select-none div.transition-all > img.max-w-3xl',
    };
    if (host === 'globalcomix.com') {
        const release = /^\/read\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\/[1-9]\d*(?:\/[1-9]\d*)?)?\/?$/.exec(pathname)?.[1];
        if (release) return {name: 'GlobalComix', selector: ':not(*)', areaSelector: '#readerReleasePages #horizontalReader img.chakra-image'};
    }
    if (host === 'manhuaplus.org' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Manhuaplus', selector: '#chapterContent .separator > a.readImg > img',
    };
    if (host === 'rawotaku.com' && /^\/read\/[^/]+\/[a-z]{2}\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'RawOtaku', selector: '#vertical-content .iv-card > img.image-vertical',
    };
    if (host === 'manhwaden.com' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'ManhwaDen', selector: '.reading-content .text-left > p > img',
    };
    if (host === 'manhwato.com' && /^\/manhwa\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Manhwato', selector: '.chapter-content .page-chapter > img',
    };
    if (host === 'toondex.co' && /^\/comics\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'ToonDex', selector: '.max-w-5xl > .my-6 > img[id^="row-"]',
    };
    if (host === 'mechacomic.jp' && pathname === '/viewer/index.html'
        && new URLSearchParams(search).get('viewer') === 'vertical') return {
        name: 'MechaComic', selector: '[class*="VerticalViewerstyles__PageList-"] [class*="PageContainer__ImageOrigin-"] > img[class*="PageContainer__Image-"]',
    };
    if (host === 'atsu.moe' && /^\/read\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/?$/.test(pathname)) return {
        name: 'Atsumaru', selector: '#reader-scroll-inner > div > img',
    };
    if (host === 'toongod.cc' && /^\/webtoon\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'ToonGod', selector: '.reading-chapter .reading-img .reading-content > p > img',
    };
    if (host === 'animatebookstore.com' && /^\/viewer\/?$/.test(pathname)
        && /^\d+$/.test(new URLSearchParams(search).get('product_id') ?? '')) return {
        name: 'Animatebookstore', selector: ':not(*)',
        canvasSelector: '.view-sheet-container .view-sheet .content.zoomable > canvas',
        canvasInteractionSelector: '.view-sheet-container .view-sheet .content.zoomable > img.blank-img',
        areaSelector: '.view-sheet-container .view-sheet .content.zoomable > canvas',
    };
    if (host === 'cmoa.jp' && /^\/bib\/speedreader\/?$/.test(pathname)
        && /^\d+_jp_\d+$/.test(new URLSearchParams(search).get('cid') ?? '')) return {
        name: 'Comic CMOA', selector: ':not(*)', areaSelector: '#content .pt-img img',
    };
    if (host === 'booklive.jp' && /^\/bviewer\/s\/?$/.test(pathname)) return {
        name: 'Booklive', selector: ':not(*)', areaSelector: '#content.pages > [id^="content-p"] .pt-img img',
    };
    if (host === 'tapas.io' && (/^\/episode\/\d+\/?$/.test(pathname) || /^\/series\/[^/]+\/?$/.test(pathname))) return {
        name: 'Tapas', selector: '[id^="episode-"].episode-unit .viewer__body img.content__img',
    };
    if (host === 'page.kakao.com' && /^\/content\/\d+\/viewer\/\d+\/?$/.test(pathname)) return {
        name: 'Kakao', selector: '.image-container > img[src^="https://page-edge.kakao.com/sdownload/resource?"]', sourceLanguage: 'ko',
    };
    if (host === 'manhwaclub.net' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'ManhwaClub', selector: '.reading-content .page-break > img.wp-manga-chapter-img',
    };
    if (['twmanga.com', 'twbzmg.com', 'cn.twbzmg.com'].includes(host) && /^\/comic\/chapter\/[^/]+\/\d+_\d+\.html$/.test(pathname)) return {
        name: '包子漫画', selector: '.chapter-main .comic-contain amp-img[id^="chapter-img-"] > img',
    };
    if (host === 'global.manga-up.com' && /^\/manga\/\d+\/\d+\/?$/.test(pathname)) return {
        name: 'Manga UP', selector: '[data-testid="placeholder"] > img[alt^="page_"]',
    };
    if (host === 'palcy.jp' && /^\/comics\/\d+\/?$/.test(pathname)
        || host === 'comic.pixiv.net' && /^\/viewer\/stories\/\d+\/?$/.test(pathname)) return {
        name: host, selector: ':not(*)',
        backgroundSelector: 'div[id^="page-"][style*="blob:"]', areaSelector: 'div[id^="page-"][style*="blob:"]',
    };
    if (host === 'pocket.shonenmagazine.com' && /^\/title\/\d+\/episode\/\d+\/?$/.test(pathname)) return {
        name: 'MangaPoke', selector: ':not(*)', areaSelector: '.c-viewer__comic-item-image > canvas',
    };
    if (host === 'ganganonline.com' && /^\/title\/\d+\/chapter\/\d+\/?$/.test(pathname)) return {
        name: 'GANGAN ONLINE', selector: 'img[src^="blob:https://www.ganganonline.com/"]',
    };
    if (host === 'zebrack-comic.shueisha.co.jp' && /^\/title\/\d+\/chapter\/\d+\/viewer\/?$/.test(pathname)) return {
        name: 'Zebrack', selector: 'img[src^="blob:https://zebrack-comic.shueisha.co.jp/"]',
    };
    if (gigaHosts.has(host) && /^\/episode\/\d+\/?$/.test(pathname)) return {
        name: host, selector: '.page-area img.page-image, .page-area img.js-page-image',
        canvasSelector: '.page-area canvas.page-image, .page-area canvas.js-page-image',
        areaSelector: '.page-area canvas.page-image, .page-area canvas.js-page-image',
    };
    if (host === 'comic-walker.com' && /^\/detail\/KC_\d+_S\/episodes\/KC_\d+_E\/?$/.test(pathname)) return {
        name: 'ComicWalker', selector: ':not(*)',
        canvasSelector: '[data-viewer-full-screen-helper] canvas[data-type="contents"], [data-viewer-full-screen-helper] [data-type="contents"] > canvas',
        canvasInteractionSelector: '[data-viewer-full-screen-helper] canvas + div[class^="_cover_"]',
        areaSelector: '[data-viewer-full-screen-helper] canvas[data-type="contents"], [data-viewer-full-screen-helper] [data-type="contents"] > canvas',
    };
    if (comiciHosts.includes(host) && (/^\/episodes\/[a-z0-9]+\/?$/.test(pathname)
        || host === 'rimacomiplus.jp' && /^\/[^/]+\/episodes\/[a-z0-9]+\/?$/.test(pathname))) return {
        name: host, selector: ':not(*)', canvasSelector: '#comici-viewer .-cv-page-canvas canvas',
        canvasInteractionSelector: '#comici-viewer #xCVLeftNav, #comici-viewer #xCVRightNav, #comici-viewer #xCVNavCenter',
        areaSelector: '#comici-viewer .-cv-page-canvas canvas',
    };
    if (host === 'dynasty-scans.com' && /^\/chapters\/[^/]+\/?$/.test(pathname)) return {
        name: 'Dynasty Scans', selector: '#reader #image img',
    };
    if (host === 'weebcentral.com' && /^\/chapters\/[A-Za-z0-9]+\/?$/.test(pathname)) return {
        name: 'WeebCentral', selector: '#chapter-images img',
    };
    if (host === 'mangadna.com' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'MangaDNA', selector: '.read-manga .read-content > img',
    };
    if (['asuracomic.net', 'asurascans.com'].includes(host) && /^\/comics\/[^/]+\/chapter\/\d+\/?$/.test(pathname)) return {
        name: 'Asura Scans', selector: '.select-none [data-page] > img',
    };
    if (['arenascan.com', 'kingofshojo.com', 'violetscans.org', 'violetmanga.com'].includes(host)
        && /^\/[^/]+-chapter-[^/]+\/?$/.test(pathname)) return {
        name: host, selector: 'article #readerarea img',
    };
    if (['mangaread.org', 'mangaforfree.net'].includes(host) && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: host, selector: '.reading-content .page-break > img',
    };
    if (host === 'manhwabuddy.com' && /^\/manhwa\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'ManhwaBuddy', selector: '.reading-chapter .reading-content img',
    };
    if (host === 'vortexscans.org' && /^\/series\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Vortex Scans', selector: '.comic-images-wrapper > .image-container img',
    };
    if (host === 'rookie.shonenjump.com' && /^\/series\/[\w-]+\/[\w-]+\/?$/.test(pathname)) return {
        name: 'Jump Rookie', selector: '.page-area img.js-page-image',
    };
    if (host === 'webtoons.com' && /^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/viewer\/?$/.test(pathname)) return {
        name: 'Webtoons', selector: '#_imageList > img._images',
    };
    if (host === 'comic.naver.com' && pathname === '/webtoon/detail') {
        const query = new URLSearchParams(search);
        if (/^\d+$/.test(query.get('titleId') ?? '') && /^\d+$/.test(query.get('no') ?? '')) return {
            name: 'ComicNaver', selector: '#sectionContWide > img[id^="content_image_"]', sourceLanguage: 'ko',
        };
    }
    if (host === 'a-i-manga.com' && /^\/work\/[A-Za-z0-9]+\/?$/.test(pathname)) return {
        name: 'AIManga', selector: 'main img[alt^="Page "][src^="https://images.a-i-manga.com/comics/"]',
    };
    if (host === 'mangafire.to' && /^\/title\/[^/]+\/chapter\/\d+\/?$/.test(pathname)) return {
        name: 'MangaFire', selector: '.reader__strip > .reader__page > img.reader-img',
    };
    if (host === 'vw.mangaz.com' && /^\/virgo\/view\/\d+\/i:\d+\/?$/.test(pathname)) return {
        name: 'MangaZ', selector: '#viewer #book .page_unit.page_image > img.image',
    };
    if (host === 'manga-park.com' && /^\/title\/\d+\/?$/.test(pathname)) return {
        name: 'MangaPark', selector: '.viewer #minobi .manga-page-image > img.manga-image',
    };
    if (host === 'mgeko.cc' && /^\/reader\/[a-z]{2}\/[^/]+-chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Mgeko', selector: '#chapter-reader > img',
    };
    if (host === 'roliascan.com' && /^\/read\/[^/]+\/[^/]+\/?$/.test(pathname)) return {
        name: 'Rolia Scan', selector: '#chapter-images-container .comic-image-container img.comic-image',
    };
    if (host === 'mangadex.org' && /^\/chapter\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/?$/.test(pathname)) return {
        name: 'MangaDex', selector: '.md--reader-pages .md--page img',
    };
    if (host === 'twicomi.com' && /^\/manga\/[^/]+\/\d+\/?$/.test(pathname)) return {
        name: 'Twitter Comic', selector: '.tweet-images .image img',
    };
    if (host === 'comic-fuz.com' && /^\/manga\/\d+\/?$/.test(pathname)
        || host === 'manga-one.com' && /^\/manga\/\d+\/chapter\/\d+\/?$/.test(pathname)
        || host === 'corocoro.jp' && /^\/chapter\/\d+\/viewer\/?$/.test(pathname)) return {
        name: host, selector: '[data-testid="placeholder"] > img[alt^="page_"]',
    };
    if (host === 'comic.mf-fleur.jp' && /^\/manga\/[^/]+\.html$/.test(pathname)) return {
        name: 'COMIC Fleur', selector: '.manga-content .manga-content__image img',
    };
    if (host === 'ac.qq.com' && /^\/ComicView\/index\/id\/\d+\/cid\/\d+\/?$/.test(pathname)) return {
        name: '腾讯动漫', selector: '#comicContain > li > img',
    };
    if (host === 'antbyw.com' && pathname === '/plugin.php') {
        const query = new URLSearchParams(search);
        if (query.get('id') === 'jameson_manhua' && query.get('a') === 'read'
            && /^\d+$/.test(query.get('kuid') ?? '') && /^\d+$/.test(query.get('zjid') ?? '')) return {
            name: 'Antbyw', selector: '#img_list > div > img[id^="img_"]',
        };
    }
    if (/(?:^|\.)mangafreak\.(?:net|me)$/.test(host) && /^\/Read\d+_[\w-]+_\d+\/?$/.test(pathname)) return {
        name: 'MangaFreak', selector: '.slideshow-container .mySlides img',
    };
    if (host === 'mn4u.net' && /^\/\d+\/\d+\/?$/.test(pathname)) return {
        name: 'Manga4u', selector: '.chapter-content #list-imga > img.chapter-img',
    };
    if (host === 'mgread.io' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'MG Read', selector: '#init-manga-single-chapter #chapter-content > img',
    };
    if (host === 'yymanhua.com' && /^\/m\d+\/?$/.test(pathname)) return {
        name: 'Yymanhua', selector: '#showimage #cp_img > img#cp_image',
    };
    if (host === 'mangarawjp.me' && /^\/manga\/[^/]+\/\d+(?:-\d+)?-wa\/?$/.test(pathname)) return {
        name: 'Mangaraw', selector: '#TopPage.ImageGallery img.img-fluid',
    };
    if (['speed-manga.com', 'speed-manga.net'].includes(host) && /^\/[^/]+-\d+(?:-\d+)?\/?$/.test(pathname)) return {
        name: 'Speed Manga', selector: 'article #readerarea img.ts-main-image',
    };
    if (host === 'jumptoon.com' && /^\/series\/[A-Z\d]+\/episodes\/\d+\/?$/.test(pathname)) return {
        name: 'Jumptoon', selector: ':not(*)', areaSelector: 'div[id] > canvas',
    };
    if (host === 'yanmaga.jp' && /^\/viewer\/comics\//.test(pathname)) return {
        name: 'YanMaga', selector: ':not(*)', areaSelector: '.pt-img img',
    };
    if (host === 'televikun-super-hero-comics.com' && /^\/rensai\/[^/]+\/episode-\d+\/?$/.test(pathname)) return {
        name: 'Televi-Kun Super Hero Comics', selector: ':not(*)', areaSelector: '.pt-img img',
    };
    if (host === 'kirapo.jp' && /^\/pt\/meteor\/[^/]+\/\d+\/viewer\/?$/.test(pathname)) return {
        name: 'Comic Meteor', selector: ':not(*)', areaSelector: '#content .pt-img img',
    };
    if (/(?:^|\.)smokingbehindthesupermarket\.com$/.test(host) && /^\/manga\/[^/]*chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Smoking Behind the Supermarket', selector: 'article #content .separator > img',
    };
    if (/(?:^|\.)(?:uzakichanmanga|kaijimanga)\.com$/.test(host)
        && /^\/manga\/[^/]*chapter-[^/]+\/?$/.test(pathname)) return {
        name: host, selector: 'article .entry-content img',
    };
    if (['rawkuma.net','rawkuma.com'].includes(host) && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(pathname)) return {
        name: 'Rawkuma', selector: 'section.mx-auto > section > img',
    };
    return null;
}
