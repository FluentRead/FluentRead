import {describe, expect, it} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaSiteRule, normalizeMangaSiteRules, normalizeMangaPrefetchPages, resolveMangaSite, resolveMangaSourceLanguage} from '@/src/core/config/manga';
import {isLocalMangaHost} from '@/src/core/config/mangaNormalization';
import {isCatalogMangaHost, MANGA_SITE_DOMAINS, MANGA_SITE_CATALOG} from '@/src/core/config/mangaSiteCatalog';
import {resolveMangaReaderProfile} from '@/src/core/config/mangaReaderProfiles';
import {normalizeConfig} from '@/src/core/config/model';

describe('漫画阅读规则与持久偏好', () => {
    it('Komiic 官方 .cc 线路保留原站名称，仅绑定域名且不虚构登录页正文规则', () => {
        expect(MANGA_SITE_CATALOG.find(site => site.name === 'komiic.com')?.hosts).toEqual(['komiic.com','komiic.cc']);
        for (const host of ['komiic.com','komiic.cc']) {
            expect(isCatalogMangaHost(`www.${host}`)).toBe(true);
            expect(resolveMangaSite(`https://${host}/comics/category/`)).toMatchObject({generic:true,custom:false});
            expect(resolveMangaReaderProfile(host,'/login')).toBeNull();
            expect(resolveMangaSite(`https://${host}/`)).toBeNull();
            expect(isCatalogMangaHost(`${host}.attacker.test`)).toBe(false);
        }
    });
    it.each(['/serie/the-beginning-after-the-end-54f5cb7c/chapter-255/', '/serie/the-beginning-after-the-end-54f5cb7c/chapter-254'])('Toonily 公开章节 %s 只选择直系阅读页图片，排除封面、嵌套推广和异常路径', path => {
        const site = resolveMangaSite(`https://toonily.com${path}`)!;
        expect(site).toMatchObject({name: 'Toonily', requireContent: true});
        const {document} = parseHTML('<div class="entry-content_wrap"><div class="read-container"><div class="reading-content"><div class="page-break no-gaps"><img id="body" class="wp-manga-chapter-img"><a><img id="nested" class="wp-manga-chapter-img"></a></div><aside class="page-break"><div><img id="promotion" class="wp-manga-chapter-img"></div></aside><img id="cover" class="wp-manga-chapter-img"></div><div class="recommendations"><img id="recommended" class="wp-manga-chapter-img"></div></div></div><div class="reading-content"><div class="page-break"><img id="outside" class="wp-manga-chapter-img"></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile('www.toonily.com', path)).toMatchObject({name: 'Toonily'});
        for (const invalid of ['/', '/serie/title', '/serie/title/chapter-0', '/serie/title/chapter-01', '/serie/title/chapter-text', '/serie/title/chapter-1.5', '/serie/title/chapter-1/extra', '/serie/-title/chapter-1']) expect(resolveMangaReaderProfile('toonily.com', invalid)).toBeNull();
        expect(resolveMangaReaderProfile('toonily.com.attacker.test', path)).toBeNull();
    });
    it('Ridi 公开试读只选择语义阅读容器的整页 blob，商品推广、嵌套链接和外部图片保持原样', () => {
        const site=resolveMangaSite('https://ridibooks.com/books/1690002642/preview')!;
        expect(site).toMatchObject({name:'Ridi',requireContent:true});
        const {document}=parseHTML('<div id="root"><div class="pre_reading"><div class="contents_comics"><div class="reading_body"><div class="viewer"><div class="viewer_viewport"><div class="simplebar-content"><div><div><div><div><img id="one" src="blob:https://ridibooks.com/page-one"><img id="two" src="blob:https://ridibooks.com/page-two"><img id="remote" src="https://cdn.test/promo"><img id="spoof" src="blob:https://ridibooks.com.attacker.test/page"><a><img id="nested" src="blob:https://ridibooks.com/ad"></a></div></div></div></div><aside><img id="ad" src="blob:https://ridibooks.com/ad"></aside></div></div></div></div><img id="cover" src="blob:https://ridibooks.com/cover"></div></div><div class="book-detail"><img id="product-promo" src="blob:https://ridibooks.com/promo"></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['one','two']);
        expect(resolveMangaReaderProfile('www.ridibooks.com','/books/505062803/preview/')).toMatchObject({name:'Ridi'});
        for(const path of ['/','/comics/ebook','/books/1690002642','/books/0/preview','/books/01/preview','/books/text/preview','/books/1/preview/extra'])expect(resolveMangaReaderProfile('ridibooks.com',path)).toBeNull();
        expect(resolveMangaReaderProfile('ridibooks.com.attacker.test','/books/1690002642/preview')).toBeNull();
    });
    it.each(['/title/13810', '/title/1077/'])('Ynjn 公开阅读页 %s 仅接入直系正文画布', path => {
        const site = resolveMangaSite(`https://ynjn.jp${path}`)!;
        expect(site).toMatchObject({name:'ヤンジャン＋',requireContent:true,selector:':not(*)'});
        const {document} = parseHTML('<div id="__nuxt"><div class="swiper swiper-horizontal"><div class="swiper-wrapper"><div class="swiper-slide"><div class="max-h-full max-w-full"><canvas id="body" class="max-h-full max-w-full"></canvas><aside><canvas id="nested" class="max-h-full max-w-full"></canvas></aside></div><canvas id="outside-holder" class="max-h-full max-w-full"></canvas></div><aside><canvas id="ad" class="max-h-full max-w-full"></canvas></aside></div><img id="cover"></div><div class="recommendations"><canvas id="recommendation" class="max-h-full max-w-full"></canvas></div></div><div class="swiper-horizontal"><div class="swiper-wrapper"><div class="swiper-slide"><div class="max-h-full max-w-full"><canvas id="outside-root" class="max-h-full max-w-full"></canvas></div></div></div></div>');
        expect([...document.querySelectorAll(site.canvasSelector!)].map(canvas=>canvas.id)).toEqual(['body']);
        expect(site.areaSelector).toBe(site.canvasSelector);
        for(const path of ['/','/allEpisodeList/13810','/title/0','/title/01','/title/text','/title/1/extra'])expect(resolveMangaReaderProfile('ynjn.jp',path)).toBeNull();
        expect(resolveMangaReaderProfile('ynjn.jp.attacker.test',path)).toBeNull();
    });
    it.each(['?episode=1&cid=10487', '?cid=10502&episode=2&source=home'])('Yomonga 明确章节 %s 圈选完整分片页，排除封面与嵌套推广', search => {
        const site = resolveMangaSite(`https://www.yomonga.com/titles/2553/${search}`)!;
        expect(site).toMatchObject({name:'マンガよもんが',requireContent:true,selector:':not(*)'});
        expect(site.canvasSelector).toBeUndefined();
        const {document} = parseHTML('<div id="contents" class="cst_info"><div id="content_base"><div id="content" class="pages"><div id="content-p1"><div id="whole-page" class="pt-img"><div><img id="fragment-one"></div><div><img id="fragment-two"></div><div><img id="fragment-three"></div></div><aside><div id="nested" class="pt-img"><img></div></aside></div><aside><div id="content-p2"><div id="ad" class="pt-img"><img></div></div></aside></div></div><main><img id="cover"></main></div><div id="content_base"><div id="content" class="pages"><div id="content-p1"><div id="outside" class="pt-img"><img></div></div></div></div>');
        expect([...document.querySelectorAll(site.areaSelector!)].map(page=>page.id)).toEqual(['whole-page']);
        expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        for(const query of ['', '?episode=1', '?cid=1', '?episode=&cid=1', '?episode=0&cid=1', '?episode=01&cid=1', '?episode=text&cid=1', '?episode=1&episode=2&cid=1', '?episode=1&cid=', '?episode=1&cid=0', '?episode=1&cid=01', '?episode=1&cid=text', '?episode=1&cid=1&cid=2'])expect(resolveMangaReaderProfile('yomonga.com','/titles/2553',query)).toBeNull();
        for(const path of ['/','/titles','/titles/0','/titles/01','/titles/text','/titles/1/extra'])expect(resolveMangaReaderProfile('yomonga.com',path,search)).toBeNull();
        expect(resolveMangaReaderProfile('yomonga.com.attacker.test','/titles/2553',search)).toBeNull();
        expect(resolveMangaReaderProfile('yomonga.com','/titles/2553',search)).not.toBeNull();
    });
    it.each([
        ['https://mangalib.me/ru/1--title/read/v22/c129?p=2', 'ru'],
        ['https://www.mangahub.ru/read/123?page=2', 'ru'],
        ['https://comic.naver.com/webtoon/detail?titleId=855297&no=1&week=mon', 'ko'],
        ['https://ridibooks.com/books/1690002642/preview', 'ko'],
        ['https://www.bomtoon.com/viewer/PAYBACK/p1', 'ko'],
        ['https://novelpia.com/comic_viewer/18735', 'ko'],
        ['https://toptoon.com/comic/ep_view/Legendary_Hunter/1/rent', 'ko'],
        ['https://page.kakao.com/content/12345/viewer/67890', 'ko'],
    ])('自动漫画语言只在已确认的内置正文路径 %s 使用 %s 提示', (href, source) => {
        expect(resolveMangaSourceLanguage(href, 'auto')).toBe(source);
        for (const manual of ['en','ru-RU','ko-KR','ja']) expect(resolveMangaSourceLanguage(href,manual)).toBe(manual);
        const custom = createMangaSiteRule(href,'main img')!;
        expect(resolveMangaSourceLanguage(href,'auto',[custom])).toBe('auto');
        expect(resolveMangaSourceLanguage(href.replace(new URL(href).hostname,new URL(href).hostname+'.attacker.test'),'auto')).toBe('auto');
    });
    it.each(['https://mangalib.me/ru','https://mangalib.me/en/1--title/read/v22/c129','https://mangahub.ru/catalog/123','https://comic.naver.com/webtoon/detail?titleId=855297','https://mangaplus.shueisha.co.jp/viewer/1028732','https://unknown.test/reader/1','not a URL'])('目录、其他语言区或未知阅读器 %s 不猜测原文语言', href => {
        expect(resolveMangaSourceLanguage(href,'auto')).toBe('auto');
    });
    it.each(['/comic/high-society/chapter-99','/comic/i-thought-its-a-common-possession/95958-chapter-1'])('Templetoons 章节路径 %s 只选择直接正文长图', path => {
        const site=resolveMangaSite(`https://templetoons.com${path}`)!;
        expect(site).toMatchObject({name:'Templetoons',requireContent:true});
        const {document}=parseHTML('<main><div class="protected-content"><div class="protected-content relative"><div class="relative"><img id="body" class="select-none"><a><img id="nested" class="select-none"></a></div></div><a class="protected-content"><div class="relative"><img id="promotion" class="select-none"></div></a><div class="cover"><img id="cover" class="select-none"></div></div><div class="protected-content"><img id="outside" class="select-none"></div></main>');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['body']);
        for(const path of ['/','/comic/high-society','/comic/title/chapter-0','/comic/title/chapter-01','/comic/title/0-chapter-1','/comic/title/01-chapter-1','/comic/title/chapter-1/extra'])expect(resolveMangaReaderProfile('templetoons.com',path)).toBeNull();
        expect(resolveMangaReaderProfile('templetoons.com.attacker.test',path)).toBeNull();
    });
    it('MangaOI 只检测直系章节列表，排除列表推荐与异常阅读路径', () => {
        const site = resolveMangaSite('https://mangaoi.net/read-manga/colorist/chapter-50')!;
        expect(site).toMatchObject({name: 'MangaOI', requireContent: true});
        const {document} = parseHTML('<div class="inner chapter-wapper"><div class="chapter-content"><div class="item-chapter"><img id="body"><a><img id="nested"></a></div><aside><img id="ad"></aside></div><div class="recommendations"><img id="cover"></div></div><div class="chapter-content"><div class="item-chapter"><img id="outside"></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile('www.mangaoi.net', '/read-manga/Colorist/chapter-50.5/')).toMatchObject({name: 'MangaOI'});
        for (const path of ['/', '/read-manga/title', '/read-manga/title/chapter-0', '/read-manga/title/chapter-01', '/read-manga/title/chapter-1/extra', '/read-manga/title/chapter-1.']) expect(resolveMangaReaderProfile('mangaoi.net', path)).toBeNull();
        expect(resolveMangaReaderProfile('mangaoi.net.attacker.test', '/read-manga/title/chapter-1')).toBeNull();
    });
    it.each(['/ru/3172--kakegurui/read/v22/c129', '/ru/55743--debby-the-corsifa-wa-make-sukirai/read/v8/c75.5'])('MangaLib 语义阅读容器 %s 排除外部图片且不依赖生成类名', path => {
        const site = resolveMangaSite(`https://mangalib.me${path}`)!;
        expect(site).toMatchObject({name: 'MangaLib', requireContent: true, pageQueryParameter: 'p'});
        const {document} = parseHTML('<div data-reader-mode="horizontal"><main data-reader-info-visible="false"><img id="header"><div><div data-page="1"><img id="one"><a><img id="nested"></a></div><div data-page="2"><img id="two"></div><div><img id="ad"></div></div></main></div><div><main data-reader-info-visible="false"><div><div data-page="1"><img id="outside"></div></div></main></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['one', 'two']);
        for (const path of ['/', '/ru?section=home-updates', '/ru/manga/3172--kakegurui', '/ru/0--title/read/v1/c1', '/ru/01--title/read/v1/c1', '/ru/1--/read/v1/c1', '/ru/1--title/read/v0/c1', '/ru/1--title/read/v01/c1', '/ru/1--title/read/v1/c0', '/ru/1--title/read/v1/c01', '/ru/1--title/read/v1/c1.', '/ru/1--title/read/v1/c1/extra']) expect(resolveMangaReaderProfile('mangalib.me', path)).toBeNull();
        expect(resolveMangaReaderProfile('mangalib.me.attacker.test', '/ru/1--title/read/v1/c1')).toBeNull();
    });
    it.each(['', '-2', '-9999'])('ACG 当前站编号页 %s 只选正文，保留作品身份与域名边界', page => {
        const site = resolveMangaSite(`https://acgmhn.com/h/886372${page}.html`)!;
        expect(site).toMatchObject({name: 'ACG 漫画网', requireContent: true, chapterPath: '/h/886372.html'});
        const {document} = parseHTML('<div class="content"><div class="acg-manga"><div class="manga-page"><p class="manga-picture"><img id="body"><a><img id="nested"></a></p><aside><img id="ad"></aside></div></div><dl class="other"><dd><a><img id="recommendation"></a></dd></dl></div><div class="acg-manga"><div class="manga-page"><p class="manga-picture"><img id="outside"></p></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(MANGA_SITE_CATALOG.find(s => s.name === 'acgmhh.com')?.hosts).toEqual(['acgmhh.com', 'acgmhn.com']);
        expect(isCatalogMangaHost('www.acgmhn.com')).toBe(true);
        for (const path of ['/', '/tags/full-color.html', '/language/english.html', '/h/0.html', '/h/01.html', '/h/word.html', '/h/1-0.html', '/h/1-01.html', '/h/1-10000.html', '/h/1.html/extra']) expect(resolveMangaReaderProfile('acgmhn.com', path)).toBeNull();
        for (const host of ['fakeacgmhn.com', 'acgmhn.com.attacker.test']) {
            expect(resolveMangaReaderProfile(host, '/h/1.html')).toBeNull();
            expect(isCatalogMangaHost(host)).toBe(false);
        }
    });
    it.each(['', '&page=1', '&page=2'])('Yamibo 正文主图及同章分页 %s 排除头像、推荐与异常参数', paging => {
        const site = resolveMangaSite(`https://www.yamibo.com/manga/view-chapter?id=1751${paging}`)!;
        expect(site).toMatchObject({name: 'Yamibo', requireContent: true, pageQueryParameter: 'page'});
        const {document} = parseHTML('<section><div class="row"><div class="col-md-12"><div class="thumbnail"><img id="imgPic" class="img-responsive"><aside><img id="ad" class="img-responsive"></aside></div><img id="cover" class="img-responsive"></div></div><div class="post"><img id="avatar" class="cmt-avatar"></div></section><div class="row"><div class="col-md-12"><div class="thumbnail"><img id="outside" class="img-responsive"></div></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['imgPic']);
        for (const query of ['', '?id=', '?id=0', '?id=01', '?id=word', '?id=1&id=2', '?id=1&page=', '?id=1&page=0', '?id=1&page=01', '?id=1&page=word', '?id=1&page=10000', '?id=1&page=2&page=3']) expect(resolveMangaReaderProfile('yamibo.com', '/manga/view-chapter', query)).toBeNull();
        for (const path of ['/', '/site/manga', '/manga/335', '/novel/view-chapter', '/manga/view-chapter/extra']) expect(resolveMangaReaderProfile('yamibo.com', path, '?id=1751')).toBeNull();
        expect(resolveMangaReaderProfile('yamibo.com.attacker.test', '/manga/view-chapter', '?id=1751')).toBeNull();
    });
    it.each(['p0', 'p1'])('Bomtoon 正文画布 %s 排除版权图片、封面、推广和目录', episode => {
        const site = resolveMangaSite(`https://www.bomtoon.com/viewer/PAYBACK/${episode}`)!;
        expect(site).toMatchObject({name: 'Bomtoon', requireContent: true});
        const {document} = parseHTML('<div class="printView"><div class="sc-gHLcSH"><div class="sc-jvLaUc"><div class="sc-edUIhV"><div class="sc-hjQCSK"><canvas id="body" class="sc-bSakgD" width="1440" height="1440"></canvas><canvas id="other"></canvas><aside><canvas id="nested" class="sc-bSakgD"></canvas></aside></div></div></div><img id="copyright" class="sc-jSMfEi"><canvas id="ad" class="sc-bSakgD"></canvas></div></div><div class="sc-gHLcSH"><div class="sc-jvLaUc"><div class="sc-edUIhV"><div class="sc-hjQCSK"><canvas id="outside" class="sc-bSakgD"></canvas></div></div></div></div>');
        expect([...document.querySelectorAll(site.canvasSelector!)].map(canvas => canvas.id)).toEqual(['body']);
        const {document: rehashed} = parseHTML('<div class="printView"><div class="sc-aaaa"><div class="sc-bbbb"><div class="sc-cccc"><div class="sc-dddd"><canvas id="rehashed-body" class="sc-eeee"></canvas><canvas id="plain"></canvas><aside><canvas id="nested" class="sc-eeee"></canvas></aside></div></div></div><canvas id="ad" class="sc-eeee"></canvas></div></div>');
        expect([...rehashed.querySelectorAll(site.canvasSelector!)].map(canvas => canvas.id)).toEqual(['rehashed-body']);
        expect(site.areaSelector).toBe(site.canvasSelector);
        expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        expect(site.canvasInteractionSelector).toBeUndefined();
        for (const path of ['/', '/bom/comic/main', '/detail/PAYBACK', '/user/login', '/viewer/PAYBACK/p01', '/viewer/PAYBACK/pword', '/viewer/PAYBACK/p1/extra']) expect(resolveMangaReaderProfile('bomtoon.com', path)).toBeNull();
        expect(resolveMangaReaderProfile('bomtoon.com.attacker.test', '/viewer/PAYBACK/p0')).toBeNull();
    });
    it('公开图书库仅为单个合法档案编号选择当前页，隐藏概览与其他图片排除', () => {
        const id = 'a'.repeat(40), site = resolveMangaSite(`https://lrr.tvc-16.science/reader?id=${id}`)!;
        expect(site).toMatchObject({name: 'LANraragi public demo', requireContent: true});
        const {document} = parseHTML('<div id="i1"><div id="i3"><a id="display"><img id="img" class="reader-image"></a></div><div id="archivePagesOverlay"><img id="reader-overview-thumbnail"><img id="ad" class="reader-image"></div></div><img id="outside" class="reader-image">');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['img']);
        for (const query of ['', '?id=', '?id=one', `?id=${'g'.repeat(40)}`, `?id=${'a'.repeat(39)}`, `?id=${id}&id=${id}`]) expect(resolveMangaReaderProfile('lrr.tvc-16.science', '/reader', query)).toBeNull();
        expect(resolveMangaReaderProfile('lrr.tvc-16.science', '/reader/extra', `?id=${id}`)).toBeNull();
        expect(resolveMangaReaderProfile('lrr.tvc-16.science.attacker.test', '/reader', `?id=${id}`)).toBeNull();
    });
    it('BeLTOON 作品章节正文只选阅读容器的同源 blob 长图，推荐与封面排除', () => {
        const site = resolveMangaSite('https://www.beltoon.jp/viewer/digging/p1')!;
        expect(site).toMatchObject({name: 'BeLTOON', requireContent: true});
        const {document} = parseHTML('<div class="printView"><div class="sc-iXxrte eWYGf"><div class="sc-jhzXDd vufrE"><img id="body" class="sc-jSMfEi izegLd" src="blob:https://www.beltoon.jp/body"><img id="cover" class="sc-jSMfEi" src="https://www.beltoon.jp/cover.jpg"><img id="foreign" class="sc-jSMfEi" src="blob:https://other.example/body"><aside><img id="nested" class="sc-jSMfEi" src="blob:https://www.beltoon.jp/ad"></aside></div></div></div><div class="sc-iXxrte"><div class="sc-jhzXDd"><img id="outside" class="sc-jSMfEi" src="blob:https://www.beltoon.jp/recommended"></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        const {document: rehashed} = parseHTML('<div class="printView"><div class="sc-aaaa"><div class="sc-bbbb"><img id="rehashed-body" class="sc-cccc" src="blob:https://www.beltoon.jp/page"><img id="cover" src="https://www.beltoon.jp/cover.jpg"><aside><img id="nested" src="blob:https://www.beltoon.jp/ad"></aside></div></div></div>');
        expect([...rehashed.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['rehashed-body']);
        for (const path of ['/', '/app/all/main', '/detail/digging', '/user/login', '/viewer/digging/p0', '/viewer/digging/p01', '/viewer/digging/pword', '/viewer/digging/p1/extra']) expect(resolveMangaReaderProfile('beltoon.jp', path)).toBeNull();
        expect(resolveMangaReaderProfile('beltoon.jp.attacker.test', '/viewer/digging/p1')).toBeNull();
    });
    it('comipo 公开免费书号只选已展示同源 blob 正文，排除目录、指南和外源', () => {
        const site = resolveMangaSite('https://play.comipo.app/viewer/free/BJ03026230')!;
        expect(site).toMatchObject({name: 'comipo', requireContent: true});
        const {document} = parseHTML('<div class="_slide_container_1"><div class="_spread_2"><div class="_page_container_3"><div class="_placeholder_4"><img id="body" class="_page_5" src="blob:https://play.comipo.app/page"><img id="guide" class="_page_5" src="https://play.comipo.app/guide.png"><img id="foreign" class="_page_5" src="blob:https://other.example/page"></div><aside><img id="ad" class="_page_5" src="blob:https://play.comipo.app/ad"></aside></div></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        for (const path of ['/', '/login', '/free/BJ03026230', '/viewer/free/BJword', '/viewer/free/RJ03026230', '/viewer/free/BJ03026230/extra']) expect(resolveMangaReaderProfile('play.comipo.app', path)).toBeNull();
        expect(resolveMangaReaderProfile('play.comipo.app.attacker.test', '/viewer/free/BJ1')).toBeNull();
    });
    it('JComic 编码标题单帖只选直系正文图，目录缩略图、作者目录和嵌套广告排除', () => {
        const site = resolveMangaSite('https://jcomic.net/page/Title%20With%20Spaces')!;
        expect(site).toMatchObject({name: 'JComic', requireContent: true});
        const {document} = parseHTML('<html><body><div class="container"><div class="row col-lg-12 col-md-12 col-xs-12"><img id="body" class="img-responsive comic-thumb jcomic-img"><a><img id="cover" class="comic-thumb jcomic-img"></a><aside><img id="ad" class="comic-thumb jcomic-img"></aside></div></div><img id="outside" class="comic-thumb jcomic-img"></body></html>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        for (const path of ['/', '/cat/recent', '/eps/artist', '/author/artist', '/page/', '/page/title/extra']) expect(resolveMangaReaderProfile('jcomic.net', path)).toBeNull();
        expect(resolveMangaReaderProfile('jcomic.net.attacker.test', '/page/title')).toBeNull();
    });
    it.each(['1', '12'])('Hentaizap 正整数页码 %s 保持同一章节，封面及推荐排除', page => {
        const site = resolveMangaSite(`https://www.hentaizap.com/g/1655925/${page}/`)!;
        expect(site).toMatchObject({name: 'Hentaizap', chapterPath: '/g/1655925', requireContent: true});
        const {document} = parseHTML('<div class="hz-gallery-cover"><img id="cover"></div><main id="readerApp"><div id="readerAnchor" class="reader_img hz-media-load"><img id="readerImg"><a><img id="nested"></a></div><aside><img id="ad"></aside></main>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['readerImg']);
        for (const path of ['/', '/gallery/1655925', '/g/1655925', '/g/0/1', '/g/1/0', '/g/01/1', '/g/1/01', '/g/1/-1', '/g/1/one', '/g/1/2/extra']) expect(resolveMangaReaderProfile('hentaizap.com', path)).toBeNull();
        expect(resolveMangaReaderProfile('hentaizap.com.attacker.test', '/g/1/1')).toBeNull();
    });
    it.each([
        ['yaoimangaonline.com', '<body class="single-post"><img id="logo"><article class="herald-single"><div class="herald-post-thumbnail"><img id="cover"></div><div class="entry-content herald-entry-content"><p><img id="body" class="alignnone size-medium wp-image-123" loading="lazy"><a><img id="nested" class="alignnone wp-image-124"></a><img id="ad" class="alignnone"></p></div></article><aside><img id="outside" class="alignnone wp-image-125"></aside></body>'],
        ['nhentaiyaoi.net', '<body class="single-post"><div class="post-capa"><img id="cover"></div><div class="post-box listaImagens"><ul class="post-fotos"><li><a><img id="body" loading="lazy"></a><aside><a><img id="nested"></a></aside></li></ul></div><aside><ul class="post-fotos"><li><a><img id="outside"></a></li></ul></aside></body>'],
    ])('%s 单帖正文排除封面、嵌套广告与目录推荐', (host, html) => {
        const site = resolveMangaSite(`https://${host}/public-post-2/`)!;
        expect(site).toMatchObject({custom: false, requireContent: true});
        const {document} = parseHTML(`<html>${html}</html>`);
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        document.body.className = 'archive';expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        for (const path of ['/', '/category/work', '/public-post-2/extra', '/public_post', '/post%20name']) expect(resolveMangaReaderProfile(host, path)).toBeNull();
        expect(resolveMangaReaderProfile(`${host}.attacker.test`, '/public-post-2')).toBeNull();
    });
    it.each([
        ['ravenscans.org', '/the-counts-youngest-son-is-a-player-chapter-178', '<article><div id="readerarea"><img id="body" class="ts-main-image lazy loaded"><img id="ad"><aside><img id="nested" class="ts-main-image"></aside></div></article><img id="outside" class="ts-main-image">', ['/', '/manga/story', '/story-chapter-one', '/story-chapter-1/extra']],
        ['novelpia.com', '/comic_viewer/18735', '<div id="viewer_wrap"><div class="viewer_content"><div><div class="viewer_content_box"><div class="comic-content"><img id="body"></div><img id="ad"></div></div></div></div><div id="tab-preview"><img id="preview"></div>', ['/', '/comic_episode/1024', '/comic_viewer/0', '/comic_viewer/18735/extra']],
        ['manga-shinchan.com', '/new-shinchan-saimaru/episode/070-new-shinchan-saimaru', '<article id="ep_blog"><div class="item__list-lists"><figure><img id="body" src="/book_data/article_data/chapter/01.jpg"><img id="cover" src="/asset_data/episode_thumbnail/cover.jpg"></figure><div class="box"><img id="promo" src="/book_data/article_data/promo.jpg"></div></div></article><figure><img id="outside" src="/book_data/article_data/chapter/02.jpg"></figure>', ['/', '/new-shinchan-saimaru', '/new-shinchan/episode/', '/new-shinchan/episode/one/extra']],
        ['lezhinus.com', '/en/comic/poison_taster/1', '<div class="scroll-view"><div class="mx-auto overflow-hidden max-w-720 w-full"><img id="body" class="w-full h-full select-none pointer-events-none" src="blob:https://www.lezhinus.com/page"><img id="cover" class="w-full h-full select-none pointer-events-none" src="https://www.lezhinus.com/cover.jpg"><img id="foreign" class="w-full h-full select-none pointer-events-none" src="blob:https://other.example/page"><aside><img id="nested" class="w-full h-full select-none pointer-events-none" src="blob:https://www.lezhinus.com/page2"></aside></div></div>', ['/en', '/en/comic/poison_taster', '/en/comic/poison_taster/comments', '/en/comic/poison_taster/0', '/ko/comic/poison_taster/1', '/en/comic/poison_taster/1/extra']],
    ])('免费阅读页 %s 限定正文，排除作品预览、推广和相似域名', (host, path, html, invalidPaths) => {
        const site = resolveMangaSite(`https://www.${host}${path}/`)!;
        expect(site).toMatchObject({custom: false, requireContent: true});
        const {document} = parseHTML(html as string);
        expect([...document.querySelectorAll(site.areaSelector ?? site.selector)].map(image => image.id)).toEqual(['body']);
        if (host === 'novelpia.com') expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        for (const invalid of invalidPaths as string[]) expect(resolveMangaReaderProfile(host as string, invalid)).toBeNull();
        expect(resolveMangaReaderProfile(`${host}.attacker.test`, path as string)).toBeNull();
    });
    it('Ameba 只为单个合法书号的试读画布提供圈选，排除透明占位图和阅读器外画布', () => {
        const site = resolveMangaSite('https://dokusho-ojikan.jp/reader/index.html?cid=3747694&ref=seriesDetail')!;
        expect(site).toMatchObject({name: 'Amebaマンガ', selector: ':not(*)', requireContent: true});
        const {document} = parseHTML('<canvas id="outside"></canvas><div class="view-sheet-container"><div class="view-sheet"><div class="content zoomable"><canvas id="body"></canvas><img id="blank" class="blank-img"></div></div><canvas id="buffer"></canvas></div>');
        expect([...document.querySelectorAll(site.areaSelector!)].map(surface => surface.id)).toEqual(['body']);
        expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        for (const query of ['', '?cid=', '?cid=0', '?cid=one', '?cid=3747694/extra', '?cid=1&cid=2']) expect(resolveMangaReaderProfile('dokusho-ojikan.jp', '/reader/index.html', query)).toBeNull();
        expect(resolveMangaReaderProfile('dokusho-ojikan.jp', '/reader/index.html/extra', '?cid=1')).toBeNull();
        expect(resolveMangaReaderProfile('dokusho-ojikan.jp.attacker.test', '/reader/index.html', '?cid=1')).toBeNull();
    });
    it.each(['0', '4', '9999'])('GANMA 路径内合法页码 %s 保留稳定章节身份，只选择编号原稿', page => {
        const chapter = '/web/reader/chiharasan/a64d24f0-c9d6-11eb-ba7d-2e06529e3f5f';
        const site = resolveMangaSite(`https://ganma.jp${chapter}/${page}/`)!;
        expect(site).toMatchObject({name: 'GANMA!', requireContent: true, chapterPath: chapter});
        const {document} = parseHTML('<img id="cover" alt="1ページ目の原稿画像"><div class="h-full-container w-full-container"><div class="flex select-none flex-row-reverse"><div class="relative w-0 flex-1"><img id="body" class="pointer-events-none object-contain object-right" alt="1ページ目の原稿画像"><img id="blank" class="pointer-events-none object-contain" alt="余白用の画像"></div><aside><img id="ad" class="pointer-events-none object-contain" alt="2ページ目の原稿画像"></aside></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        for (const path of ['/', '/web/magazine/chiharasan', `${chapter}/-1`, `${chapter}/01`, `${chapter}/10000`, `${chapter}/4/extra`, '/web/reader/chiharasan/not-a-chapter/0']) expect(resolveMangaReaderProfile('ganma.jp', path)).toBeNull();
        expect(resolveMangaReaderProfile('ganma.jp.attacker.test', `${chapter}/0`)).toBeNull();
    });
    it('TOPTOON 的公开租阅路径只为首张正文与不可读画布提供圈选，推荐和提示排除', () => {
        const site = resolveMangaSite('https://toptoon.com/comic/ep_view/Legendary_Hunter/1/rent')!;
        expect(site).toMatchObject({name: 'TOPTOON', selector: ':not(*)', requireContent: true});
        expect(site.canvasSelector).toBeUndefined();
        const {document} = parseHTML('<img id="notice"><div id="viewerContentsWrap"><div class="comic_img c_img"><img id="first" class="document_img"><div class="canvas-wrapper last_image document_img"><canvas id="body"></canvas></div><canvas id="ad"></canvas></div><aside><div class="canvas-wrapper document_img"><canvas id="recommendation"></canvas></div></aside></div><div class="comic_img"><img id="outside" class="document_img"></div>');
        expect([...document.querySelectorAll(site.areaSelector!)].map(element => element.id)).toEqual(['first', 'body']);
        for (const path of ['/', '/comic/ep_list/Legendary_Hunter', '/comic/ep_view/Legendary_Hunter/0/rent', '/comic/ep_view/Legendary_Hunter/1/buy', '/comic/ep_view/Legendary_Hunter/1/rent/extra']) expect(resolveMangaReaderProfile('toptoon.com', path)).toBeNull();
        expect(resolveMangaReaderProfile('toptoon.com.attacker.test', '/comic/ep_view/Legendary_Hunter/1/rent')).toBeNull();
    });
    it('哔哩哔哩数字章节只接入内容脚本可读的正文画布，排除二维码与其他容器', () => {
        const site=resolveMangaSite('https://manga.bilibili.com/mc30124/595886')!;
        expect(site).toMatchObject({name:'哔哩哔哩漫画',requireContent:true,selector:':not(*)'});expect(site.areaSelector).toBeUndefined();
        const {document}=parseHTML('<canvas id="qr" class="qr-code"></canvas><div class="images-container double-page"><div class="view-container primary-image"><div class="image-container"><div class="bullet-screen"><div class="bullet-container" id="turn"></div></div><canvas id="body"></canvas><dialog class="bullet-container" id="dialog"></dialog></div><div class="loading-hinter" id="loading"></div></div><div><canvas id="outside"></canvas></div></div><div class="bullet-screen"><div class="bullet-container" id="unrelated"></div></div><div class="loading-hinter" id="unrelated-loading"></div>');
        expect([...document.querySelectorAll(site.canvasSelector!)].map(canvas=>canvas.id)).toEqual(['body']);
        expect([...document.querySelectorAll(site.canvasInteractionSelector!)].map(element=>element.id)).toEqual(['turn']);
        expect([...document.querySelectorAll(site.loadingSelector!)].map(element=>element.id)).toEqual(['loading']);
        for(const path of ['/','/detail/mc30124','/mcword/595886','/mc30124/word','/mc30124/595886/extra'])expect(resolveMangaReaderProfile('manga.bilibili.com',path)).toBeNull();
        expect(resolveMangaReaderProfile('bilibili.com','/mc30124/595886')).toBeNull();expect(resolveMangaReaderProfile('manga.bilibili.com.attacker.test','/mc30124/595886')).toBeNull();
    });
    it('漫画站编号章节正文排除加载图与推荐，src 改为实际正文后加入选择', () => {
        const site=resolveMangaSite('https://www.manhuazhan.com/chapter/235990-51809.html')!;
        const {document}=parseHTML('<img id="banner" class="lazy" src="banner.jpg"><div id="ChapterContent"><p class="chapter chapterpic"><img id="body" class="lazy" src="https://s2.bzcdn.net/scomic/body.jpg"><img id="loading" class="lazy" src="/template/images/lazyload.gif"></p><aside><img id="ad" class="lazy" src="ad.jpg"></aside></div>');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['body']);document.querySelector('#loading')!.setAttribute('src','body-2.jpg');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['body','loading']);
        for(const path of ['/','/comic/235990','/chapter/235990.html','/chapter/word-1.html','/chapter/1-2.html/extra'])expect(resolveMangaReaderProfile('manhuazhan.com',path)).toBeNull();
        expect(resolveMangaReaderProfile('manhuazhan.com.attacker.test','/chapter/1-2.html')).toBeNull();
    });
    it('POIPIKU 数字单帖只接入主图片，推荐、头像和活动图不进入漫画队列', () => {
        const site=resolveMangaSite('https://poipiku.com/2/13202427.html')!;
        const {document}=parseHTML('<img id="avatar" class="IllustItemThumbImg"><section id="IllustItemList"><div class="IllustItem Upload"><a class="IllustItemThumb"><img id="body" class="IllustItemThumbImg"></a></div><div class="RelatedItemList"><a class="IllustItemThumb"><img id="related" class="IllustItemThumbImg"></a></div><div class="IllustItem"><aside><img id="event" class="IllustItemThumbImg"></aside></div></section>');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['body']);
        for(const path of ['/','/2/','/comic/','/word/13202427.html','/2/word.html','/2/13202427.html/extra'])expect(resolveMangaReaderProfile('poipiku.com',path)).toBeNull();
        expect(resolveMangaReaderProfile('poipiku.com.attacker.test','/2/13202427.html')).toBeNull();
    });
    it.each(['/lucid/lucid2/need1','/lucid/lucid22/lucid22thattimei.html','/lucid/lucid24.88/lucid24.88','/lucid/extra/gettingstronger.html'])('Ranfren 静态路径 %s 仅选直接显示的正文，封面和预览链接排除',path=>{
        const site=resolveMangaSite(`https://ranfren.neocities.org${path}`)!;
        const {document}=parseHTML('<table><tr><td><img id="cover" src="https://ranfren.neocities.org/lucid/cover.jpg"></td></tr></table><center><img id="body" src="https://ranfren.neocities.org/lucid/lucid2/lucid2-1.jpg"><a><img id="preview" src="https://ranfren.neocities.org/lucid/lucid2/preview.jpg"></a><img id="logo" src="https://ranfren.neocities.org/art/logo.png"></center>');
        expect([...document.querySelectorAll(site.selector)].map(image=>image.id)).toEqual(['body']);
        for(const invalid of ['/','/comics','/lucid/vol1lucid','/lucid/extra/unconfirmed','/lucid/lucid2/need1/extra','/lucid/lucidword/need1','/lucid/lucid2/need1.png'])expect(resolveMangaReaderProfile('ranfren.neocities.org',invalid)).toBeNull();
        expect(resolveMangaReaderProfile('other.neocities.org',path)).toBeNull();
    });
    it('MANGA Million 语言路径与编号章节仅选择正文页，排除阅读指南、推荐封面与无编号图片', () => {
        const site = resolveMangaSite('https://mangamillion.shueisha.co.jp/zh-CN/title/1/chapter/66193')!;
        expect(site).toMatchObject({name: 'MANGA Million', requireContent: true});
        const {document} = parseHTML('<img id="guide" class="G54Y0W_page" alt="page_0"><div class="eAvsta_slide_container"><div class="-KWKsa_spread"><div class="_b9ZNa_page_container"><div class="__wfZG_placeholder"><img id="body" class="G54Y0W_page" alt="page_1" width="694" height="1080"><img id="ad" class="G54Y0W_page" alt="advertisement"></div><img id="outside" class="G54Y0W_page" alt="page_2"></div></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile('mangamillion.shueisha.co.jp', '/en/title/1/chapter/2/')).toBeTruthy();
        for (const path of ['/', '/zh-CN', '/zh-CN/title/1', '/zh-CN/title/one/chapter/2', '/zh-CN/title/1/chapter/2/extra']) expect(resolveMangaReaderProfile('mangamillion.shueisha.co.jp', path)).toBeNull();
        expect(resolveMangaReaderProfile('mangamillion.shueisha.co.jp.attacker.test', '/zh-CN/title/1/chapter/2')).toBeNull();
    });
    it('PASH UP 仅选择当前屏的公开正文画布，排除离屏缓冲、加载图与交互层', () => {
        const site = resolveMangaSite('https://pash-up.jp/viewer/viewer.html?cid=public-chapter')!;
        expect(site).toMatchObject({name: 'PASH UP', selector: ':not(*)', requireContent: true});
        const {document} = parseHTML('<div id="viewer"><div id="renderer"><canvas id="dummy"></canvas><div id="viewport0"><canvas id="buffer"></canvas></div><div id="viewport1" class="currentScreen"><canvas id="body"></canvas></div><div id="frontScreen"><canvas id="front"></canvas></div></div><img class="loadingImage"></div><div class="currentScreen"><canvas id="outside"></canvas></div>');
        expect([...document.querySelectorAll(site.canvasSelector!)].map(canvas => canvas.id)).toEqual(['body']);
        document.querySelector('#viewport1')!.className = '';document.querySelector('#viewport0')!.className = 'currentScreen';
        expect([...document.querySelectorAll(site.canvasSelector!)].map(canvas => canvas.id)).toEqual(['buffer']);
        expect(site.areaSelector).toBe(site.canvasSelector);expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        for (const path of ['/', '/content/00000001', '/viewer/other.html', '/viewer/viewer.html/extra']) expect(resolveMangaReaderProfile('pash-up.jp', path)).toBeNull();
        expect(resolveMangaReaderProfile('pash-up.jp.attacker.test', '/viewer/viewer.html')).toBeNull();
    });
    it.each(['/', '/comic/000', '/comic/742/'])('Countdown 主页及数字阅读页 %s 只接入正文，排除 logo 与赞助图', path => {
        const site = resolveMangaSite(`https://www.ctccomic.com${path}`)!;
        expect(site).toMatchObject({name: 'Countdown to Countdown', custom: false, requireContent: true});
        const {document} = parseHTML('<header><a id="logo"><img id="site-logo" width="645" height="565"></a></header><div id="middle-left"><div id="cc-comicbody"><a><img id="cc-comic" width="900" height="1331"></a><aside><img id="sponsor"></aside></div></div><img id="other" width="900" height="1331">');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['cc-comic']);
        for (const invalid of ['/comic/archive', '/comic/rss', '/about', '/comic/word', '/comic/000/extra']) expect(resolveMangaReaderProfile('ctccomic.com', invalid)).toBeNull();
        for (const fake of ['ctccomic.com.attacker.test', 'fakectccomic.com']) expect(resolveMangaReaderProfile(fake, path)).toBeNull();
    });
    it('Orchisasia 编号章节正文规则排除导航与推荐，保留作者后记与小数章节边界', () => {
        const site = resolveMangaSite('https://www.orchisasia.org/comic/story/0166-chapter-163-5-creators-note/')!;
        expect(site).toMatchObject({name: 'Orchisasia', custom: false, requireContent: true});
        const {document} = parseHTML('<header><img id="logo"></header><div class="read-container"><div class="reading-content"><div class="page-break no-gaps"><img id="body" class="wp-manga-chapter-img" width="720" height="5120"></div><aside><img id="ad" class="wp-manga-chapter-img"></aside></div></div><div class="page-break"><img id="outside" class="wp-manga-chapter-img"></div>');
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile('orchisasia.org', '/comic/story/0001-chapter-1.5')).toBeTruthy();
        for (const path of ['/', '/comic/story', '/comic/story/chapter-1', '/comic/story/0001-chapter-word', '/comic/story/0001-chapter-1/extra']) expect(resolveMangaReaderProfile('orchisasia.org', path)).toBeNull();
        expect(resolveMangaReaderProfile('orchisasia.org.attacker.test', '/comic/story/0001-chapter-1')).toBeNull();
    });
    it.each([
        ['qimanga.com', 'Qi Manga', '<header><img id="logo" class="r-page-img"></header><app-reader><div class="r-strip"><div class="r-page" data-page="1"><img id="body" class="r-page-img" width="800" height="15525"></div><div class="r-page"><img id="placeholder" class="r-page-img"></div><aside><img id="ad" class="r-page-img"></aside></div></app-reader><div class="r-page" data-page="2"><img id="cover" class="r-page-img"></div>'],
        ['nyxscans.com', 'Nyx Scans', '<header><img id="cover"></header><div class="comic-body-container"><div class="comic-images-wrapper reader-mode-strip"><figure class="image-container"><img id="body" width="800" height="10000"></figure><aside><img id="ad"></aside></div></div><figure class="image-container"><img id="outside"></figure>'],
        ['omegascans.org', 'Omega Scans', '<div class="lg:container"><a><img id="banner" class="block object-contain"></a><div class="flex flex-col items-center justify-center overflow-hidden lg:px-0"><div class="relative flex w-full justify-center"><img id="body" class="block object-contain" width="720" height="12565"></div><aside><img id="ad" class="block object-contain"></aside></div></div><div class="relative flex w-full justify-center"><img id="outside" class="block object-contain"></div>'],
    ])('%s 已显示长条正文规则排除广告、外部推荐并限制章节边界', (host, name, html) => {
        const site = resolveMangaSite(`https://${host}/series/work/chapter-96`)!;
        expect(site).toMatchObject({name, requireContent: true, custom: false});
        const {document} = parseHTML(html);
        expect([...document.querySelectorAll(site.selector)].map(image => image.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile(`www.${host}`, '/series/work/chapter-1.5/')).toBeTruthy();
        for (const path of ['/', '/series/work', '/series/work/chapter-one', '/series/work/chapter-96/extra']) expect(resolveMangaReaderProfile(host, path)).toBeNull();
        for (const fake of [`${host}.attacker.test`, `fake${host}`]) expect(resolveMangaReaderProfile(fake, '/series/work/chapter-96')).toBeNull();
    });
    it('MangaLove 已显示不可读画布仅提供圈选，排除商店标识、广告画布和作品封面', () => {
        const site = resolveMangaSite('https://mangalove.me/viewer/79762')!;
        expect(site).toMatchObject({name: 'MangaLove', selector: ':not(*)', requireContent: true, custom: false});
        const {document} = parseHTML('<body id="viewerBody"><div class="topMenu"><canvas id="ad"><img id="logo"></canvas></div><div class="viewer vertical"><div class="imgWrap"><canvas id="body" width="760" height="1100"></canvas></div><aside><canvas id="other"></canvas></aside></div><div class="imgWrap"><canvas id="outside"></canvas></div></body>');
        expect([...document.querySelectorAll(site.areaSelector!)].map(canvas => canvas.id)).toEqual(['body']);
        expect([...document.querySelectorAll(site.selector)]).toEqual([]);
        expect(resolveMangaReaderProfile('www.mangalove.me', '/viewer/79762/')).toBeTruthy();
        for (const path of ['/', '/comic/3333', '/viewer/word', '/viewer/79762/extra']) expect(resolveMangaReaderProfile('mangalove.me', path)).toBeNull();
        expect(resolveMangaReaderProfile('mangalove.me.attacker.test', '/viewer/79762')).toBeNull();
    });
    it('MangaYun 正文排除加载吉祥物、背景搜索封面与章节广告',()=>{
        const site=resolveMangaSite('https://mangayun.com/read/Book_A/Chapter-1')!;
        expect(site).toMatchObject({name:'MangaYun',requireContent:true,custom:false});
        const {document}=parseHTML('<main><img id="search-cover" class="reader-page"></main><div class="reader" role="dialog"><div class="reader-scroll"><div class="reader-page-wrap"><div class="reader-hold"><img id="mascot" class="reader-hold-mascot"></div><img id="body" class="reader-page"></div><aside><img id="ad" class="reader-page"></aside></div></div><div class="reader"><div class="reader-scroll"><div class="reader-page-wrap"><img id="unrelated" class="reader-page"></div></div></div>');
        expect([...document.querySelectorAll(site.selector)].map(e=>e.id)).toEqual(['body']);
        expect(resolveMangaReaderProfile('www.mangayun.com','/read/Book_A/Chapter-1/')).toBeTruthy();
    });
    it('MangaYun 只接受公开阅读路由的两段标识和精确域名',()=>{
        for(const path of ['/','/s/keyword','/read/Book_A','/read/Book_A/Chapter-1/extra','/read/Book.A/Chapter-1'])expect(resolveMangaReaderProfile('mangayun.com',path)).toBeNull();
        for(const host of ['mangayun.com.attacker.test','fakemangayun.com'])expect(resolveMangaReaderProfile(host,'/read/Book_A/Chapter-1')).toBeNull();
    });
    it('Booklive 公开试读分片仅提供圈选并排除说明、广告与商店标识',()=>{
        const url='https://booklive.jp/bviewer/s/';
        const site=resolveMangaSite(url)!;
        expect(site).toMatchObject({name:'Booklive',selector:':not(*)',requireContent:true,custom:false});
        const {document}=parseHTML('<img id="store"><div id="tips"><img id="manual"></div><div id="content" class="pages"><div id="content-p1"><div class="pt-img"><div><img id="slice-1"></div><div><img id="slice-2"></div></div></div><aside><div class="pt-img"><img id="ad"></div></aside></div><div class="pt-img"><img id="cover"></div>');
        expect([...document.querySelectorAll(site.areaSelector!)].map(e=>e.id)).toEqual(['slice-1','slice-2']);
        expect([...document.querySelectorAll(site.selector)]).toEqual([]);
        expect(resolveMangaReaderProfile('www.booklive.jp','/bviewer/s')).toBeTruthy();
        for(const host of ['booklive.jp.attacker.test','fakebooklive.jp'])expect(resolveMangaReaderProfile(host,'/bviewer/s/')).toBeNull();
        for(const path of ['/','/product/index/title_id/20017284/vol_no/001','/bviewer/','/bviewer/s/core/manual.html'])expect(resolveMangaReaderProfile('booklive.jp',path)).toBeNull();
    });
    it.each([
        ['mangahub.ru','/read/962303','reader-viewer reader-scan.reader-viewer-scan > img.reader-viewer-img',
            '<header><img id="logo" class="reader-viewer-img"></header><reader-viewer><reader-scan class="reader-viewer-scan"><img id="body" class="reader-viewer-img"></reader-scan><aside><img id="cover" class="reader-viewer-img"></aside></reader-viewer>',
            ['/','/manga/title','/read/title','/read/962303/extra']],
        ['rinkocomics.com','/chapter/the-crazy-young-masters-daily-life-is-a-scheme-chapter-5/','.chapter-images-section .images-flow > img.chapter-image[data-page]',
            '<header><img id="logo" class="chapter-image" data-page="1"></header><div class="chapter-images-section"><div class="images-flow"><img id="body" class="chapter-image" data-page="1"><img id="ad"><a><img id="linked" class="chapter-image" data-page="2"></a></div></div>',
            ['/','/comic/title','/chapter/title','/chapter/title-chapter-one','/chapter/title-chapter-5/extra']],
        ['rawdex.net','/manga/keep-likes-private/4/','section.rdx-reader .rdx-reader-content img.wp-manga-chapter-img',
            '<header><img id="logo" class="wp-manga-chapter-img"></header><section class="rdx-reader"><div class="rdx-reader-content"><figure><img id="body" class="wp-manga-chapter-img"></figure><img id="ad"></div><aside><img id="cover" class="wp-manga-chapter-img"></aside></section>',
            ['/','/manga/title','/manga/title/latest','/manga/title/4/extra']],
        ['raw1001.net','/manga/zhou-shu-hui-zhan001/di271hua','#chapterContent .separator > a.readImg > img',
            '<header><img id="logo"></header><div id="chapterContent"><div class="separator"><a class="readImg"><img id="body"></a><img id="ad"></div></div><aside><div class="separator"><a class="readImg"><img id="cover"></a></div></aside>',
            ['/','/home','/manga/title','/manga/title/diwordhua','/manga/title/di271hua/extra']],
    ])('%s 已显示正文规则排除封面与广告并限制章节边界', (host,path,selector,html,invalidPaths)=>{
        expect(resolveMangaSite(`https://${host}${path}`)).toMatchObject({selector,requireContent:true,custom:false});
        const {document}=parseHTML(html as string);
        expect([...document.querySelectorAll(selector as string)].map(e=>e.id)).toEqual(['body']);
        for(const invalidPath of invalidPaths as string[])expect(resolveMangaReaderProfile(host as string,invalidPath)).toBeNull();
        for(const invalidHost of [`${host}.attacker.test`,`fake${host}`])expect(resolveMangaReaderProfile(invalidHost,path as string)).toBeNull();
    });
    it('小数章节仍限定已核对阅读路径',()=>{
        expect(resolveMangaReaderProfile('www.mangahub.ru','/read/123/')).toBeTruthy();
        expect(resolveMangaReaderProfile('rinkocomics.com','/chapter/title-chapter-1.5')).toBeTruthy();
        expect(resolveMangaReaderProfile('rawdex.net','/manga/title/1.5')).toBeTruthy();
        expect(resolveMangaReaderProfile('raw1001.net','/manga/title/di1.5hua')).toBeTruthy();
    });
    it.each([
        ['v5.luvyaa.co','/i-shall-master-this-family-chapter-236/','article #readerarea > img.ts-main-image',
            '<article><a><img id="ad" class="ts-main-image"></a><div id="readerarea"><img id="body" class="ts-main-image"><img id="other"></div></article>',
            ['/','/top-reader/','/i-shall-master-this-family/','/title-chapter-one/','/title-chapter-236/extra']],
        ['manhwaweb.com','/leer/el-rey-caballero-de-cabello-negro_1786828095885-1_01','div[class~="md:max-w-3xl"].m-auto > img.w-full',
            '<header><img id="music" class="w-full"></header><div class="md:max-w-3xl m-auto"><img id="body" class="w-full"><a><img id="ad" class="w-full"></a></div><aside><img id="cover" class="w-full"></aside>',
            ['/','/manhwa/title_1786828095885','/leer/title','/leer/title_1786828095885-1','/leer/title_1786828095885-1_01/extra']],
        ['klz9.com','/the-exiled-reincarnated-heavy-knight-is-unrivaled-in-game-knowledge-chapter-181.html','main .select-none div.transition-all > img.max-w-3xl',
            '<header><img id="logo" class="max-w-3xl"></header><main><div class="select-none"><div class="transition-all"><img id="body" class="max-w-3xl"><a><img id="ad" class="max-w-3xl"></a></div></div></main><aside><img id="cover" class="max-w-3xl"></aside>',
            ['/','/title.html','/title-chapter-one.html','/title-chapter-181','/title-chapter-181.html/extra']],
    ])('公开章节 %s 只匹配正文容器并保持域名、章节边界', (host,path,selector,html,invalidPaths) => {
        expect(resolveMangaSite(`https://${host}${path}`)).toMatchObject({selector,requireContent:true,custom:false});
        const {document}=parseHTML(html as string);
        expect([...document.querySelectorAll(selector as string)].map(e=>e.id)).toEqual(['body']);
        for(const invalidPath of invalidPaths as string[])expect(resolveMangaReaderProfile(host as string,invalidPath)).toBeNull();
        for(const invalidHost of [`${host}.attacker.test`,`fake${host}`])expect(resolveMangaReaderProfile(invalidHost,path as string)).toBeNull();
    });
    it('Luvyaa 显式公开阅读链接与正常跳转登记到原目录名称',()=>{
        expect(MANGA_SITE_CATALOG.find(site=>site.name==='luvyaa.my.id')?.hosts).toEqual(['luvyaa.my.id','luvyaa.co','v5.luvyaa.co']);
        expect(isCatalogMangaHost('v5.luvyaa.co')).toBe(true);
        expect(isCatalogMangaHost('luvyaa.co.attacker.test')).toBe(false);
        expect(resolveMangaReaderProfile('v5.luvyaa.co','/title-chapter-1.5')).toBeTruthy();
        expect(resolveMangaReaderProfile('manhwaweb.com','/leer/title_123-1.5_01/')).toBeTruthy();
        expect(resolveMangaReaderProfile('klz9.com','/title-chapter-1.5.html')).toBeTruthy();
    });
    it('GlobalComix 受限图片提供圈选并限定公开章节路径与正文容器', () => {
        const release='be3701bf-70cc-43e8-b16d-3f168abaf799', base=`/read/${release}`;
        for(const path of [base,`${base}/`,`${base}/1`,`${base}/2/`,`${base}/1/2`])expect(resolveMangaSite(`https://www.globalcomix.com${path}`)).toMatchObject({selector:':not(*)',areaSelector:'#readerReleasePages #horizontalReader img.chakra-image',requireContent:true,custom:false});
        const {document}=parseHTML('<img id="cover" class="chakra-image"><div id="readerReleasePages"><div id="horizontalReader"><div><img id="full" class="chakra-image"></div><div id="p2pReader"><div><div><img id="panel" class="chakra-image"></div></div></div></div><img id="recommended" class="chakra-image"></div>');
        expect([...document.querySelectorAll(resolveMangaSite(`https://globalcomix.com${base}`)!.areaSelector!)].map(e=>e.id)).toEqual(['full','panel']);
        expect(resolveMangaReaderProfile('globalcomix.com.attacker.test',`${base}/1`)).toBeNull();
        for(const path of ['/c/title','/read/title',`${base}/0`,`${base}/1/0`,`${base}/1/2/3`,`${base}/extra`])expect(resolveMangaReaderProfile('globalcomix.com',path)).toBeNull();
    });
    it('Manhuaplus 章节正文排除站点标识、关联推荐和非章节路径', () => {
        const href='https://www.manhuaplus.org/manga/apotheosis/chapter-1';
        const profile=resolveMangaSite(href)!;
        expect(profile).toMatchObject({selector:'#chapterContent .separator > a.readImg > img',requireContent:true,custom:false});
        const {document}=parseHTML('<header><img id="logo"></header><div id="chapterContent"><div class="separator"><a class="readImg"><img id="page"></a><img id="ad"></div></div><aside><div class="separator"><a class="readImg"><img id="recommend"></a></div></aside>');
        expect([...document.querySelectorAll(profile.selector)].map(e=>e.id)).toEqual(['page']);
        expect(resolveMangaReaderProfile('manhuaplus.org.attacker.test','/manga/apotheosis/chapter-1')).toBeNull();
        for(const path of ['/manga/apotheosis','/manga/apotheosis/trailer','/manga/apotheosis/chapter-1/extra'])expect(resolveMangaReaderProfile('manhuaplus.org',path)).toBeNull();
    });
    it('MangaBall 正常跳转现用域名保留目录名称且限制域名边界', () => {
        expect(MANGA_SITE_CATALOG.find(site=>site.name==='mangaball.net')?.hosts).toEqual(['mangaball.net','mangaball.com']);
        expect(isCatalogMangaHost('mangaball.com')).toBe(true);
        expect(isCatalogMangaHost('mangaball.com.attacker.test')).toBe(false);
        expect(isCatalogMangaHost('fakemangaball.com')).toBe(false);
    });
    it.each([
        ['https://rawotaku.com/read/%E3%83%96%E3%83%AB%E3%83%BC%E3%83%AD%E3%83%83%E3%82%AF/ja/chapter-1-raw/', '#vertical-content .iv-card > img.image-vertical'],
        ['https://www.manhwaden.com/manga/portrait-of-pride/chapter-15/', '.reading-content .text-left > p > img'],
        ['https://manhwato.com/manhwa/i-want-to-work-quietly-raw/chapter-42-ch282329', '.chapter-content .page-chapter > img'],
        ['https://toondex.co/comics/stop-smoking-frgsok/chapter-1/', '.max-w-5xl > .my-6 > img[id^="row-"]'],
        ['https://mechacomic.jp/viewer/index.html?ver=1&viewer=vertical', '[class*="VerticalViewerstyles__PageList-"] [class*="PageContainer__ImageOrigin-"] > img[class*="PageContainer__Image-"]'],
    ])('新增章节规则在已确认路径限定正文，仍拒绝冒充域名和额外路径 %s',(href,selector)=>{
        expect(resolveMangaSite(href)).toMatchObject({selector,requireContent:true,custom:false});
        const url=new URL(href);
        expect(resolveMangaReaderProfile(`${url.hostname}.attacker.test`,url.pathname,url.search)).toBeNull();
        expect(resolveMangaReaderProfile(url.hostname,`${url.pathname}/extra`,url.search)).toBeNull();
    });
    it.each([
        ['rawotaku.com','/read/title/',''], ['rawotaku.com','/read/title/ja/',''],
        ['rawotaku.com','/read/title/japanese/chapter-1-raw/',''],
        ['manhwaden.com','/manga/title/',''], ['manhwato.com','/manhwa/title/',''],
        ['toondex.co','/comics/title/',''], ['toondex.co','/comics/title/trailer/',''],
        ['mechacomic.jp','/books/245496','?viewer=vertical'],
        ['mechacomic.jp','/viewer/index.html',''], ['mechacomic.jp','/viewer/index.html','?viewer=raster'],
        ['mechacomic.jp','/viewer/','?viewer=vertical'],
    ])('章节目录、其他阅读模式和缺参不套用新正文规则 %s%s%s',(host,path,search)=>{
        expect(resolveMangaReaderProfile(host,path,search)).toBeNull();
    });
    it('新增正文容器排除封面、同容器广告链接、透明交互图和阅读器外的图片',()=>{
        const {document}=parseHTML(`<img id="cover">
            <div id="vertical-content"><div class="iv-card"><img id="raw" class="image-vertical"><a><img id="raw-ad" class="image-vertical"></a></div></div><img class="image-vertical" id="outside-raw">
            <div class="reading-content"><div class="text-left"><p><img id="den"><a><img id="den-ad"></a></p></div><img id="den-cover"></div>
            <div class="chapter-content"><div class="page-chapter"><img id="to"><a><img id="to-ad"></a></div><img id="to-cover"></div>
            <div class="max-w-5xl"><div class="my-6"><img id="row-1"><img id="dex-ad"><a><img id="row-ad"></a></div></div><img id="row-outside">
            <div class="VerticalViewerstyles__PageList-sc-list"><div class="PageContainer__ImageOrigin-sc-origin"><img id="mecha" class="PageContainer__Image-sc-body"><img id="dummy" class="DummyImage__StyledDummyImage-sc-overlay"><a><img id="mecha-ad" class="PageContainer__Image-sc-body"></a></div></div><div class="PageContainer__ImageOrigin-sc-origin"><img id="outside-mecha" class="PageContainer__Image-sc-body"></div>`);
        for(const [href,ids] of [
            ['https://rawotaku.com/read/title/ja/chapter-1-raw/',['raw']],
            ['https://manhwaden.com/manga/title/chapter-1/',['den']],
            ['https://manhwato.com/manhwa/title/chapter-1/',['to']],
            ['https://toondex.co/comics/title/chapter-1/',['row-1']],
            ['https://mechacomic.jp/viewer/index.html?viewer=vertical',['mecha']],
        ] as const)expect([...document.querySelectorAll(resolveMangaSite(href)!.selector)].map(e=>e.id)).toEqual(ids);
    });
    it('两种长条正文规则排除阅读器外的封面与同容器广告链接',()=>{
        const {document}=parseHTML('<img id="cover"><div id="reader-scroll-inner"><div><img id="atsu-page"><a><img id="atsu-ad"></a></div></div><div class="reading-chapter"><div class="reading-img"><div class="reading-content"><p><img id="toon-page"><a><img id="toon-ad"></a></p></div></div></div><div class="reading-content"><p><img id="outside"></p></div>');
        expect([...document.querySelectorAll(resolveMangaSite('https://atsu.moe/read/9x6iM/KAXiwn')!.selector)].map(e=>e.id)).toEqual(['atsu-page']);
        expect([...document.querySelectorAll(resolveMangaSite('https://toongod.cc/webtoon/title/chapter-1/')!.selector)].map(e=>e.id)).toEqual(['toon-page']);
    });
    it.each([
        ['https://atsu.moe/read/9x6iM/KAXiwn', '#reader-scroll-inner > div > img'],
        ['https://toongod.cc/webtoon/chronicles-of-the-demon-faction/chapter-191/', '.reading-chapter .reading-img .reading-content > p > img'],
        ['https://www.animatebookstore.com/viewer/?product_id=2108124', ':not(*)'],
        ['https://www.cmoa.jp/bib/speedreader/?cid=0000068502_jp_0001&u0=1', ':not(*)'],
        ['https://tapas.io/episode/3958118', '[id^="episode-"].episode-unit .viewer__body img.content__img'],
        ['https://tapas.io/series/the-little-spy-who-kidnapped-the-villain/', '[id^="episode-"].episode-unit .viewer__body img.content__img'],
        ['https://page.kakao.com/content/56566288/viewer/56605697/', '.image-container > img[src^="https://page-edge.kakao.com/sdownload/resource?"]'],
        ['https://manhwaclub.net/manga/i-want-to-work-quietly-02/chapter-42-raw/', '.reading-content .page-break > img.wp-manga-chapter-img'],
        ['https://www.twbzmg.com/comic/chapter/title/0_271.html', '.chapter-main .comic-contain amp-img[id^="chapter-img-"] > img'],
        ['https://www.twmanga.com/comic/chapter/title/0_271.html', '.chapter-main .comic-contain amp-img[id^="chapter-img-"] > img'],
        ['https://cn.twbzmg.com/comic/chapter/title/0_271.html', '.chapter-main .comic-contain amp-img[id^="chapter-img-"] > img'],
        ['https://global.manga-up.com/manga/164/14826/', '[data-testid="placeholder"] > img[alt^="page_"]'],
    ])('公开试读和章节匹配正文而非商品封面 %s', (href, selector) => {
        expect(resolveMangaSite(href)).toMatchObject({selector, requireContent:true});
        const url=new URL(href);
        expect(resolveMangaReaderProfile(`${url.hostname}.attacker.test`,url.pathname,url.search)).toBeNull();
        expect(resolveMangaReaderProfile(url.hostname,`${url.pathname}/extra`,url.search)).toBeNull();
    });
    it.each([
        ['atsu.moe','/manga/9x6iM',''], ['atsu.moe','/read/name/',''],
        ['toongod.cc','/webtoon/title/',''], ['toongod.cc','/webtoon/title/trailer/',''],
        ['animatebookstore.com','/viewer/',''], ['animatebookstore.com','/viewer/','?product_id=sample'],
        ['animatebookstore.com','/products/detail.php','?product_id=2108124'],
        ['cmoa.jp','/bib/speedreader/',''], ['cmoa.jp','/bib/speedreader/','?cid=0001_jp_title'],
        ['cmoa.jp','/title/68502/','?cid=0000068502_jp_0001'],
        ['tapas.io','/episode/title',''], ['tapas.io','/series/title/info',''],
        ['page.kakao.com','/content/56566288/',''], ['page.kakao.com','/content/56566288/viewer/trailer/',''],
        ['manhwaclub.net','/manga/title/',''], ['twmanga.com','/comic/title/',''],
        ['twbzmg.com','/comic/chapter/title/0_name.html',''], ['global.manga-up.com','/manga/164/',''],
    ])('不匹配试读缺参、目录及相似章节路径 %s%s%s', (host,path,search) => {
        expect(resolveMangaReaderProfile(host,path,search)).toBeNull();
    });
    it('公开正文选择器排除试读透明占位、推荐封面、广告和无关下载图片', () => {
        const {document}=parseHTML(`<img id="logo"><img class="blank-img" id="placeholder">
          <div class="view-sheet-container"><div class="view-sheet"><div class="content zoomable"><canvas id="animate-body"></canvas><img class="blank-img" id="animate-interaction"></div></div><canvas id="outside-canvas"></canvas></div>
          <div id="content"><div class="pt-img"><img id="fragment"></div></div><div class="pt-img"><img id="ad-fragment"></div>
          <div id="episode-1" class="episode-unit"><article class="viewer__body"><img class="content__img" id="tapas-body"></article><img class="content__img" id="tapas-cover"></div>
          <div class="image-container"><img id="kakao-body" src="https://page-edge.kakao.com/sdownload/resource?filename=public.jpeg"><img id="kakao-ad" src="https://advert.example/promotion.jpeg"></div>
          <div class="reading-content"><div class="page-break"><img id="manhwa-body" class="wp-manga-chapter-img"><img id="manhwa-ad"></div></div>
          <div class="chapter-main"><div class="comic-contain"><amp-img id="chapter-img-0-0"><img id="baozi-body"></amp-img><amp-img id="recommend"><img id="baozi-cover"></amp-img></div></div>
          <div data-testid="placeholder"><img id="manga-up-body" alt="page_0"><img id="manga-up-ad" alt="App promotion"></div>`);
        const matched=(href:string,key:'selector'|'canvasSelector'|'areaSelector'='selector') => [...document.querySelectorAll(resolveMangaSite(href)![key]!)].map(e=>e.id);
        expect(matched('https://www.animatebookstore.com/viewer/?product_id=2108124','canvasSelector')).toEqual(['animate-body']);
        expect([...document.querySelectorAll(resolveMangaSite('https://www.animatebookstore.com/viewer/?product_id=2108124')!.canvasInteractionSelector!)].map(e=>e.id)).toEqual(['animate-interaction']);
        expect(matched('https://www.animatebookstore.com/viewer/?product_id=2108124')).toEqual([]);
        expect(matched('https://www.cmoa.jp/bib/speedreader/?cid=0000068502_jp_0001','areaSelector')).toEqual(['fragment']);
        expect(matched('https://www.cmoa.jp/bib/speedreader/?cid=0000068502_jp_0001')).toEqual([]);
        expect(matched('https://tapas.io/episode/3958118')).toEqual(['tapas-body']);
        expect(matched('https://page.kakao.com/content/56566288/viewer/56605697/')).toEqual(['kakao-body']);
        expect(matched('https://manhwaclub.net/manga/title/chapter-1/')).toEqual(['manhwa-body']);
        expect(matched('https://www.twbzmg.com/comic/chapter/title/0_271.html')).toEqual(['baozi-body']);
        expect(matched('https://global.manga-up.com/manga/164/14826')).toEqual(['manga-up-body']);
        expect(MANGA_SITE_CATALOG.find(site=>site.name==='Lezhin Comics')?.hosts).toContain('lezhinus.com');
        expect(isCatalogMangaHost('www.twbzmg.com')).toBe(true);
    });
    it.each([
        ['https://www.ganganonline.com/title/2322/chapter/132575','img[src^="blob:https://www.ganganonline.com/"]'],
        ['https://zebrack-comic.shueisha.co.jp/title/5554/chapter/75530/viewer', 'img[src^="blob:https://zebrack-comic.shueisha.co.jp/"]'],
        ['https://palcy.jp/comics/554', ':not(*)'],['https://comic.pixiv.net/viewer/stories/249534', ':not(*)'],
        ['https://pocket.shonenmagazine.com/title/01915/episode/360275', ':not(*)'],
        ['https://www.sunday-webry.com/episode/3269754496551508487','.page-area img.page-image, .page-area img.js-page-image'],
    ])('新核对阅读页保持正文范围与路径边界 %s',(href,selector)=>{
        expect(resolveMangaSite(href)).toMatchObject({selector,requireContent:true});
        const url=new URL(href);url.pathname+='/unrelated';expect(resolveMangaReaderProfile(url.hostname,url.pathname)).toBeNull();
        expect(resolveMangaReaderProfile('attacker.test',new URL(href).pathname)).toBeNull();
    });
    it('背景正文和受污染画布排除空白广告、封面及应用推广图',()=>{
        const {document}=parseHTML('<div id="page-0" style="background-image:url(blank.png)"></div><div id="page-1" style="background-image:url(blob:one)"></div><img id="app-icon"><div class="c-viewer__comic-item-image"><canvas id="body"></canvas><img id="ad"></div>');
        const background=resolveMangaSite('https://comic.pixiv.net/viewer/stories/249534')!;
        expect([...document.querySelectorAll(background.backgroundSelector!)].map(e=>e.id)).toEqual(['page-1']);expect(background.selector).toBe(':not(*)');
        const pocket=resolveMangaSite('https://pocket.shonenmagazine.com/title/01915/episode/360275')!;
        expect([...document.querySelectorAll(pocket.areaSelector!)].map(e=>e.id)).toEqual(['body']);expect(pocket.selector).toBe(':not(*)');
    });
    it('完整清单保留全部名称，已确认的别名进入域名匹配，未确认名称不虚构地址', () => {
        expect(MANGA_SITE_CATALOG).toHaveLength(235);
        expect(new Set(MANGA_SITE_CATALOG.map(site => site.name)).size).toBe(235);
        for (const site of MANGA_SITE_CATALOG) for (const host of site.hosts) {
            if (['pixiv.net','mangaplus.shueisha.co.jp'].includes(host)) continue;
            expect(isCatalogMangaHost(new URL(`https://${host}`).hostname)).toBe(true);
        }
        expect(MANGA_SITE_CATALOG.find(site => site.name === 'JinMangas')?.hosts).toEqual(['jinmangas.com','mangafree.info']);
        for (const host of ['jinmangas.com','mangafree.info']) {
            expect(isCatalogMangaHost(host)).toBe(true);
            expect(resolveMangaSite(`https://${host}/manga/title/chapter-1/`)).toMatchObject({generic:true,custom:false});
            expect(resolveMangaSite(`https://${host}/`)).toBeNull();
            expect(isCatalogMangaHost(`${host}.attacker.test`)).toBe(false);
        }
        expect(MANGA_SITE_CATALOG.find(site => site.name === 'KLMANGA')?.hosts).toContain('klmanga.my');
        expect(MANGA_SITE_CATALOG.find(site => site.name === 'Manga4u')?.hosts).toContain('mn4u.net');
    });
    it('核对后的图片和画布结构使用正文规则，复数章节路径也可自动检测', () => {
        expect(resolveMangaSite('https://weebcentral.com/chapters/01M43Q7CFX4XXN7WBVZH1MTEFS')).toMatchObject({selector:'#chapter-images img', requireContent:true});
        expect(resolveMangaSite('https://dynasty-scans.com/chapters/the_nth_encore')).toMatchObject({selector:'#reader #image img', requireContent:true});
        expect(resolveMangaSite('https://comic-days.com/episode/10834108156634732370')?.areaSelector).toContain('canvas.js-page-image');
        expect(resolveMangaSite('https://yanmaga.jp/viewer/comics/title')?.selector).toBe(':not(*)');
        expect(resolveMangaSite('https://unknown.example/chapters/2')?.selector).toContain('main img');
        expect(resolveMangaSite('https://comic-days.com.attacker.test/episode/2')?.areaSelector).not.toContain('.page-area');
    });
    it.each([
        ['https://www.comic-days.com/episode/10834108156634732370/', '.page-area img.page-image, .page-area img.js-page-image'],
        ['https://televikun-super-hero-comics.com/rensai/gokumonnadeshiko/episode-001', ':not(*)'],
        ['https://ww2.uzakichanmanga.com/manga/uzaki-chan-wa-asobitai-chapter-1/', 'article .entry-content img'],
        ['https://w9.kaijimanga.com/manga/kaiji-chapter-461/', 'article .entry-content img'],
        ['https://w9.smokingbehindthesupermarket.com/manga/title-chapter-1/', 'article #content .separator > img'],
        ['https://rawkuma.net/manga/bad-boys/chapter-13.413433/', 'section.mx-auto > section > img'],
        ['https://rawkuma.com/manga/bad-boys/chapter-1/', 'section.mx-auto > section > img'],
        ['https://mangadna.com/manga/omniscient-readers-viewpoint/chapter-311', '.read-manga .read-content > img'],
        ['https://comic-zenon.com/episode/12207421983509986288', '.page-area img.page-image, .page-area img.js-page-image'],
        ['https://championcross.jp/episodes/0a8f0118f1839', ':not(*)'],
        ['https://comic-ryu.jp/episodes/877cb803dd415', ':not(*)'],
        ['https://comic-growl.com/episodes/59451af9ac2bf', ':not(*)'],
        ['https://ichicomi.com/episode/2551460909671541131', '.page-area img.page-image, .page-area img.js-page-image'],
        ['https://asurascans.com/comics/copying-skills-with-affinity-3ec3b16f/chapter/8', '.select-none [data-page] > img'],
        ['https://asuracomic.net/comics/copying-skills-with-affinity-3ec3b16f/chapter/8/', '.select-none [data-page] > img'],
        ['https://arenascan.com/like-a-fiery-flame-chapter-98/', 'article #readerarea img'],
        ['https://kingofshojo.com/ill-save-a-decent-family-chapter-199/', 'article #readerarea img'],
        ['https://violetmanga.com/a-portrait-of-pride-chapter-12/', 'article #readerarea img'],
        ['https://violetscans.org/a-portrait-of-pride-chapter-12/', 'article #readerarea img'],
        ['https://www.mangaread.org/manga/title/chapter-17/', '.reading-content .page-break > img'],
        ['https://mangaforfree.net/manga/the-hero-is-the-secretary/chapter-14-raw/', '.reading-content .page-break > img'],
        ['https://manhwabuddy.com/manhwa/title/chapter-157/', '.reading-chapter .reading-content img'],
        ['https://vortexscans.org/series/got-a-gallery-in-the-wild/chapter-7', '.comic-images-wrapper > .image-container img'],
        ['https://rookie.shonenjump.com/series/TWpXKpYkRIE/TWpXKpYkRIM', '.page-area img.js-page-image'],
        ['https://www.webtoons.com/en/romance/chocolate-snow/s2-episode-58/viewer?title_no=6022&episode_no=58', '#_imageList > img._images'],
        ['https://www.mgeko.cc/reader/en/3qcf-title-chapter-1-eng-li/', '#chapter-reader > img'],
        ['https://roliascan.com/read/one-day-i-became-a-hatchling/ch28-327187/', '#chapter-images-container .comic-image-container img.comic-image'],
        ['https://mangadex.org/chapter/80da5ab1-b615-4564-9a19-0f1502dbde05', '.md--reader-pages .md--page img'],
        ['https://twicomi.com/manga/ngnchiikawa/2077704742067904960', '.tweet-images .image img'],
        ['https://rimacomiplus.jp/digitalmargaret/episodes/4a895d1d5884a', ':not(*)'],
        ['https://rimacomiplus.jp/episodes/fb291b54b795b', ':not(*)'],
        ['https://heros-web.com/episodes/a806742880560', ':not(*)'],
        ['https://younganimal.com/episodes/ff98f6eba590d', ':not(*)'],
        ['https://comic-fuz.com/manga/4018', '[data-testid="placeholder"] > img[alt^="page_"]'],
        ['https://manga-one.com/manga/28579/chapter/360007', '[data-testid="placeholder"] > img[alt^="page_"]'],
        ['https://comic.mf-fleur.jp/manga/cb245_01.html', '.manga-content .manga-content__image img'],
        ['https://ac.qq.com/ComicView/index/id/656723/cid/105748', '#comicContain > li > img'],
        ['https://jumptoon.com/series/JT00064/episodes/14436/', ':not(*)'],
        ['https://www.corocoro.jp/chapter/10580/viewer', '[data-testid="placeholder"] > img[alt^="page_"]'],
        ['https://youngchampion.jp/episodes/c35433f99f53d', ':not(*)'],
        ['https://www.antbyw.com/plugin.php?id=jameson_manhua&a=read&kuid=189309&zjid=1435867', '#img_list > div > img[id^="img_"]'],
        ['https://ww3.mangafreak.me/Read1_One_Piece_1', '.slideshow-container .mySlides img'],
        ['https://mangafreak.net/Read2_One_Piece_1/', '.slideshow-container .mySlides img'],
        ['https://mn4u.net/2360/296144/', '.chapter-content #list-imga > img.chapter-img'],
        ['https://mgread.io/manga/revenge-of-the-iron-blooded-sword-hound/chapter-1/', '#init-manga-single-chapter #chapter-content > img'],
        ['https://yymanhua.com/m7261/', '#showimage #cp_img > img#cp_image'],
        ['https://mangarawjp.me/manga/blue-lock/363-wa', '#TopPage.ImageGallery img.img-fluid'],
        ['https://mangarawjp.me/manga/blue-lock/346-5-wa/', '#TopPage.ImageGallery img.img-fluid'],
        ['https://speed-manga.net/the-mirror-legacy-0/', 'article #readerarea img.ts-main-image'],
        ['https://speed-manga.com/the-mirror-legacy-0-5/', 'article #readerarea img.ts-main-image'],
        ['https://comic-walker.com/detail/KC_020020_S/episodes/KC_0200200000200011_E?episodeType=first', ':not(*)'],
        ['https://www.comic-walker.com/detail/KC_020020_S/episodes/KC_0200200000200011_E/', ':not(*)'],
        ['https://comic.naver.com/webtoon/detail?titleId=855297&no=1&week=mon', '#sectionContWide > img[id^="content_image_"]'],
        ['https://a-i-manga.com/work/45WoWxwi/', 'main img[alt^="Page "][src^="https://images.a-i-manga.com/comics/"]'],
        ['https://mangafire.to/title/ro8ro-all-class-awakening-god-slayer/chapter/9468411/', '.reader__strip > .reader__page > img.reader-img'],
        ['https://kirapo.jp/pt/meteor/currylevel/2022519/viewer/', ':not(*)'],
        ['https://vw.mangaz.com/virgo/view/135831/i:2', '#viewer #book .page_unit.page_image > img.image'],
        ['https://manga-park.com/title/53371/', '.viewer #minobi .manga-page-image > img.manga-image'],
    ])('新增公开样本限定正文选择器 %s', (href, selector) => {
        expect(resolveMangaSite(href)).toMatchObject({selector,custom:false,requireContent:true});
    });
    it.each([
        ['asurascans.com','/comics/title'], ['asurascans.com','/comics/title/chapter/8/extra'],
        ['arenascan.com','/series/title'], ['kingofshojo.com','/title-chapter-1/extra'],
        ['mangaread.org','/manga/title'], ['mangaforfree.net','/manga/title/chapter-1/extra'],
        ['manhwabuddy.com','/manhwa/title'], ['vortexscans.org','/series/title'], ['ichicomi.com','/episode/123/extra'],
        ['asurascans.com.attacker.test','/comics/title/chapter/8'],
        ['rookie.shonenjump.com','/series/TWpXKpYkRIE'], ['webtoons.com','/en/romance/chocolate-snow/list'],
        ['mgeko.cc','/manga/title/'], ['roliascan.com','/read/title/ch28/extra'],
        ['mangadex.org','/chapter/name'], ['twicomi.com','/manga/author'],
        ['rimacomiplus.jp','/digitalmargaret/episodes/abc/extra'], ['younganimal.com','/magazine/episodes/abc'],
        ['comic-fuz.com','/manga/4018/extra'], ['manga-one.com','/manga/28579'],
        ['comic.mf-fleur.jp','/lineup_comic/'], ['ac.qq.com','/Comic/ComicInfo/id/656723'],
        ['jumptoon.com','/series/JT00064/'],
        ['corocoro.jp','/title/62'],
        ['youngchampion.jp','/episodes/c35433f99f53d/extra'],
        ['antbyw.com','/plugin.php'], ['antbyw.com','/other.php'],
        ['mangafreak.me','/Manga/One_Piece'], ['mangafreak.me.attacker.test','/Read1_One_Piece_1'],
        ['mn4u.net','/2360/'], ['mn4u.net','/2360/296144/extra'],
        ['mgread.io','/manga/title/'], ['yymanhua.com','/38yy/'], ['yymanhua.com','/m7261/extra'],
        ['mangarawjp.me','/manga/blue-lock'], ['mangarawjp.me','/manga/blue-lock/363-wa/extra'],
        ['speed-manga.net','/manga/the-mirror-legacy/'], ['speed-manga.net.attacker.test','/the-mirror-legacy-0/'],
        ['smokingbehindthesupermarket.com','/manga/title/'],
        ['comic-walker.com','/detail/KC_020020_S/'], ['comic-walker.com','/detail/KC_020020_S/episodes/KC_0200200000200011_E/extra'],
        ['comic-walker.com','/episodes/abc'], ['comic-walker.com.attacker.test','/detail/KC_020020_S/episodes/KC_0200200000200011_E'],
        ['comic.naver.com','/webtoon/list'], ['comic.naver.com','/webtoon/detail/extra'],
        ['a-i-manga.com','/work/'], ['a-i-manga.com','/work/45WoWxwi/extra'],
        ['mangafire.to','/title/slug'], ['mangafire.to','/title/slug/chapter/name'],
        ['kirapo.jp','/meteor/titles/currylevel'], ['kirapo.jp','/pt/other/currylevel/2022519/viewer'],
        ['kirapo.jp','/pt/meteor/currylevel/2022519/viewer/extra'],
        ['vw.mangaz.com','/navi/135831/i:0'], ['vw.mangaz.com','/virgo/view/135831/i:2/extra'],
        ['vw.mangaz.com','/virgo/view/135831/i:page'], ['mangaz.com','/virgo/view/135831/i:2'],
        ['manga-park.com','/title/53371/extra'], ['manga-park.com','/chapter/494311'], ['manga-park.com','/title/name'],
    ])('正文规则不将目录、相似域名和额外路径识别成章节 %s%s', (host,path) => {
        expect(resolveMangaReaderProfile(host,path)).toBeNull();
    });
    it('Antbyw 仅将指定漫画插件的数字章节查询识别成阅读页，参数次序和额外分页不影响匹配', () => {
        const query='?zjid=1435867&kuid=189309&a=read&id=jameson_manhua&page=2';
        expect(resolveMangaReaderProfile('antbyw.com','/plugin.php',query)?.name).toBe('Antbyw');
        for(const search of ['?id=other&a=read&kuid=1&zjid=2','?id=jameson_manhua&a=bofang&kuid=1&zjid=2',
            '?id=jameson_manhua&a=read&zjid=2','?id=jameson_manhua&a=read&kuid=1',
            '?id=jameson_manhua&a=read&kuid=title&zjid=2','?id=jameson_manhua&a=read&kuid=1&zjid=2/extra']) {
            expect(resolveMangaReaderProfile('antbyw.com','/plugin.php',search)).toBeNull();
        }
        expect(resolveMangaReaderProfile('antbyw.com.attacker.test','/plugin.php',query)).toBeNull();
    });
    it('Naver 必须有数字作品和章节查询，不将缺参、目录或相似域名识别成正文', () => {
        expect(resolveMangaReaderProfile('comic.naver.com','/webtoon/detail','?no=1&week=mon&titleId=855297')?.name).toBe('ComicNaver');
        for (const query of ['', '?no=1', '?titleId=855297', '?titleId=story&no=1', '?titleId=855297&no=1/extra']) {
            expect(resolveMangaReaderProfile('comic.naver.com','/webtoon/detail',query)).toBeNull();
        }
        expect(resolveMangaReaderProfile('comic.naver.com.attacker.test','/webtoon/detail','?titleId=855297&no=1')).toBeNull();
    });
    it('ComicWalker 保留首张和后续页两种正文标记，排除结束推荐图、站外画布和非翻页遮罩', () => {
        const site=resolveMangaSite('https://comic-walker.com/detail/KC_020020_S/episodes/KC_0200200000200011_E')!;
        const {document}=parseHTML('<main><canvas id="decoy"></canvas><div data-viewer-full-screen-helper="true"><canvas id="first" data-type="contents"></canvas><div id="first-cover" class="_cover_bx4cr_11"></div><div data-type="contents"><canvas id="second"></canvas><div id="second-cover" class="_cover_bx4cr_11"></div></div><div class="_cover_unrelated"></div><div data-type="end"><canvas id="end"></canvas><img id="promo"></div></div></main>');
        expect([...document.querySelectorAll(site.canvasSelector!)].map(c=>c.id)).toEqual(['first','second']);
        expect([...document.querySelectorAll(site.canvasInteractionSelector!)].map(c=>c.id)).toEqual(['first-cover','second-cover']);
        expect(document.querySelectorAll(site.selector)).toHaveLength(0);
        expect(site.areaSelector).toBe(site.canvasSelector);
    });
    it('新图片正文规则排除年龄提示、导航封面与未标明正文的同源图片', () => {
        const {document}=parseHTML('<div id="sectionContWide"><img id="age"><img id="content_image_0"></div><aside><img id="content_image_1"></aside><main><img id="ai" alt="Page 1" src="https://images.a-i-manga.com/comics/story/000.webp"><img id="cover" alt="Cover" src="https://images.a-i-manga.com/comics/story/cover.webp"><img id="outside" alt="Page 2" src="https://example.com/page.webp"></main><div class="reader__strip"><div class="reader__page"><img id="fire" class="reader-img"></div></div><aside><img class="reader-img"></aside><div id="viewer"><div id="book"><img class="loading-back"><div class="page_unit page_image"><img id="mangaz" class="image protect" src="blob:https://vw.mangaz.com/page"></div></div></div>');
        for (const [url,ids] of [
            ['https://comic.naver.com/webtoon/detail?titleId=855297&no=1',['content_image_0']],
            ['https://a-i-manga.com/work/45WoWxwi',['ai']],
            ['https://mangafire.to/title/story/chapter/123',['fire']],
            ['https://vw.mangaz.com/virgo/view/135831/i:2',['mangaz']],
        ] as const) expect([...document.querySelectorAll(resolveMangaSite(url)!.selector)].map(i=>i.id)).toEqual(ids);
    });
    it('MangaPark 在作品页打开阅读器后仅处理 minobi 正文，不处理试阅片段和作品目录', () => {
        const {document}=parseHTML('<main><div id="chiramiseDiv"><img id="preview"></div><img class="chapterThumb"><div class="viewer"><div id="minobi"><div class="manga-face"><div class="manga-page manga-page-image"><img id="page" class="manga-image" src="blob:https://manga-park.com/page"></div></div></div><img id="promo" class="manga-image"></div></main>');
        const site=resolveMangaSite('https://manga-park.com/title/53371')!;
        expect([...document.querySelectorAll(site.selector)].map(i=>i.id)).toEqual(['page']);
        document.querySelector('.viewer')!.remove();expect(document.querySelectorAll(site.selector)).toHaveLength(0);
    });
    it('提前翻译默认三页，显式零保留，限制窗口并拒绝损坏或旧类型', () => {
        for (const invalid of [undefined, null, '3', NaN, Infinity, {}, true]) expect(normalizeMangaPrefetchPages(invalid)).toBe(3);
        for (const [input, output] of [[0,0],[-1,0],[2.9,2],[5,5],[100,5]]) {
            expect(normalizeMangaPrefetchPages(input)).toBe(output);
            expect(normalizeConfig({imageTranslationMangaPrefetchPages:input}).imageTranslationMangaPrefetchPages).toBe(output);
        }
        expect(normalizeConfig({}).imageTranslationMangaPrefetchPages).toBe(3);
    });
    it('快速容量默认十二张且导入配置按一至二十四规范化',()=>{
        expect(normalizeConfig({}).imageTranslationMangaCachePages).toBe(12);
        for(const [input,output] of [[0,1],[3.9,3],[24,24],[999,24]])expect(normalizeConfig({imageTranslationMangaCachePages:input}).imageTranslationMangaCachePages).toBe(output);
    });
    it('网站目录精确匹配含国际化域名；除已核对有正文的 Countdown 主页外，不把首页当成阅读页', () => {
        expect(new Set(MANGA_SITE_DOMAINS).size).toBe(MANGA_SITE_DOMAINS.length);
        for (const hostname of MANGA_SITE_DOMAINS) {
            expect(isCatalogMangaHost(hostname)).toBe(true);
            expect(isCatalogMangaHost(`reader.${hostname}`)).toBe(true);
            expect(isCatalogMangaHost(`${hostname}.attacker.test`)).toBe(false);
            if (hostname === 'ctccomic.com') expect(resolveMangaSite(`https://${hostname}/`)).toMatchObject({requireContent: true, selector: '#cc-comicbody > a > img#cc-comic'});
            else expect(resolveMangaSite(`https://${hostname}/`)).toBeNull();
            expect(resolveMangaSite(`https://${hostname}/catalogue/123`)).toMatchObject({generic:true});
        }
        expect(isCatalogMangaHost('localhost')).toBe(false);
        expect(isCatalogMangaHost('unrelated.example')).toBe(false);
    });
    it('Pixiv 作品 ID 限定正文图，支持语言路径与页码 hash；通用阅读页不需要手动配置', () => {
        for (const href of ['https://www.pixiv.net/artworks/150354216#1','https://pixiv.net/en/artworks/150354216/']) {
            const site=resolveMangaSite(href)!;expect(site.name).toBe('Pixiv');
            expect(site.selector).toContain('/150354216_p');expect(site.selector).not.toContain('img-thumbnail');
        }
        for (const href of ['https://pixiv.net/','http://pixiv.net/artworks/1','https://www.pixiv.net/artworks/name','https://pixiv.net.attacker.test/chapter/1']) expect(resolveMangaSite(href)).toBeNull();
        expect(resolveMangaSite('https://new-manga.example/chapter/123')?.selector).toContain('main img');
        for (const path of ['/manga/solo-leveling/1', '/manhwa/title/2', '/manhua/title/3', '/webtoon/title/4', '/webtoons/title/5']) {
            expect(resolveMangaSite(`https://generic-reader.example${path}`)).toMatchObject({generic: true, custom: false});
        }
        expect(resolveMangaSite('https://example.com/article/123')).toBeNull();
    });
    it('旧配置保留普通图片关闭，同时启用漫画提示；永久关闭不会被归一化重开', () => {
        const old = normalizeConfig({});
        expect(old.disableImageTranslator).toBe(true);
        expect(old.imageTranslationMangaEnabled).toBe(true);
        expect(old.imageTranslationMangaPromptEnabled).toBe(true);
        expect(old.imageTranslationMangaDownloadConfirmed).toBe(false);
        expect(old.imageTranslationMangaSites).toEqual([]);
        expect(normalizeConfig({imageTranslationMangaPromptEnabled: false, imageTranslationMangaDownloadConfirmed: true})).toMatchObject({imageTranslationMangaPromptEnabled: false, imageTranslationMangaDownloadConfirmed: true});
        expect(normalizeConfig({imageTranslationMangaPromptEnabled: 'false', imageTranslationMangaDownloadConfirmed: 'true'} as never)).toMatchObject({imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false});
    });
    it.each(['https://mangaplus.shueisha.co.jp/viewer/1024050', 'https://mangaplus.shueisha.co.jp/viewer/1/?lang=en'])('内置阅读页识别 %s', href => {
        expect(resolveMangaSite(href)).toMatchObject({name: 'MANGA Plus', custom: false});
    });
    it.each(['invalid', 'file:///viewer/1', 'http://mangaplus.shueisha.co.jp/viewer/1', 'https://mangaplus.shueisha.co.jp/', 'https://u@mg.example/read', 'https://:p@mg.example/read', 'https://mangaplus.shueisha.co.jp:8888/viewer/1', 'https://mangaplus.shueisha.co.jp.attacker.test/viewer/1'])('拒绝无关地址 %s', href => expect(resolveMangaSite(href)).toBeNull());
    it.each(['invalid', 'file:///chapter/', 'https://u:p@example.com/chapter/', 'https://example.com:4321/chapter/'])('规则拒绝非网页或含凭据与端口 %s', href => expect(createMangaSiteRule(href, 'main img')).toBeNull());
    it.each(['', ' '.repeat(3), 'img'.repeat(100), 'div:has(img)'])('拒绝空或过重选择器 %s', selector => expect(createMangaSiteRule('https://example.com/read/', selector)).toBeNull());
    it('保留精确路径边界，允许手动 HTTP 阅读页，拒绝相似域名和路径', () => {
        const rule = createMangaSiteRule('https://example.com/read?lang=en#page2', ' main img ' )!;
        expect(rule).toEqual({hostname: 'example.com', pathPrefix: '/read', selector: 'main img'});
        expect(resolveMangaSite('https://example.com/read', [rule])?.custom).toBe(true);
        expect(resolveMangaSite('http://example.com/read/123', [rule])?.selector).toBe('main img');
        expect(resolveMangaSite('https://example.com/reader', [rule])).toBeNull();
        expect(resolveMangaSite('https://example.com.attacker/read', [rule])).toBeNull();
        const prefix = {...rule, pathPrefix: '/read/'};
        expect(resolveMangaSite('https://example.com/read/4', [prefix])?.custom).toBe(true);
    });
    it('允许本机与局域网自托管漫画阅读器的显式端口，仍拒绝公网端口、零端口与非内网段', () => {
        for (const href of [
            'http://localhost:25600/read/1',
            'http://127.0.0.1:8080/manga/1',
            'http://[::1]:4567/reader/1',
            'http://192.168.1.50:25600/book/1',
            'http://10.0.0.8:3000/series/1',
            'http://172.16.0.5:8080/read/1',
            'http://172.31.255.1:8080/read/1',
            'http://nas.local:5000/viewer/1',
            'http://localhost:443/read/1',
        ]) {
            const rule = createMangaSiteRule(href, 'main img')!;
            expect(rule, href).not.toBeNull();
            expect(normalizeMangaSiteRules([rule]), href).toEqual([rule]);
            expect(resolveMangaSite(href, [rule]), href).toMatchObject({custom: true, selector: 'main img'});
        }
        expect(resolveMangaSite('http://localhost:25600/reader/42')).toMatchObject({name: 'localhost:25600', generic: true, custom: false});
        for (const rejected of [
            'http://localhost:0/read/1',
            'http://172.15.0.1:8080/read/1',
            'http://172.32.0.1:8080/read/1',
            'http://192.169.1.1:8080/read/1',
            'http://8.8.8.8:8080/read/1',
            'http://.local:8080/read/1',
            'https://example.com:8080/read/1',
            'http://u:p@localhost:25600/read/1',
        ]) {
            expect(createMangaSiteRule(rejected, 'main img'), rejected).toBeNull();
            expect(resolveMangaSite(rejected), rejected).toBeNull();
        }
    });
    it('过滤损坏规则、限定二十项、同域同路径去重并保留显式选择器覆盖', () => {
        const rule = {hostname: 'example.com', pathPrefix: '/read/', selector: 'article img'};
        expect(normalizeMangaSiteRules(null)).toEqual([]);
        expect(normalizeMangaSiteRules([null, 1, {}, {...rule, hostname: 2}, {...rule, pathPrefix: 2}, {...rule, pathPrefix: 'read'}, {...rule, selector: 2}, {...rule, hostname: 'example.com/evil'}, {...rule,pathPrefix:'/read/../evil/'}, {...rule, selector: ':has(img)'}, rule, rule])).toEqual([rule]);
        expect(normalizeMangaSiteRules(Array.from({length: 21}, (_, i) => ({...rule, pathPrefix: `/chapter/${i}/`})))).toHaveLength(20);
        const override = {hostname: 'mangaplus.shueisha.co.jp', pathPrefix: '/viewer/', selector: 'main img'};
        expect(resolveMangaSite('https://mangaplus.shueisha.co.jp/viewer/1024050', [override])).toMatchObject({custom: true, selector: 'main img'});
    });
});

// 漫画偏好归一化与正文目录的依赖边界；原 suite 与静态 imports 保持不变。
import {vi} from 'vitest';

type MangaNormalizationContract = Pick<typeof import('@/src/core/config/manga'),
    'normalizeMangaPrefetchPages' | 'createMangaSiteRule' | 'normalizeMangaSiteRules'
    | 'normalizeMangaCachePages' | 'mangaCachePixelBudget'>;

describe('漫画归一化的轻量配置入口', () => {
    it.each(['catalog', 'profiles'] as const)('真实配置归一化不求值 %s 资源', async resource => {
        const resourceId = resource === 'catalog'
            ? '@/src/core/config/mangaSiteCatalog'
            : '@/src/core/config/mangaReaderProfiles';
        let reached = 0;
        vi.resetModules();
        vi.doMock(resourceId, () => {
            reached += 1;
            throw new Error(`配置入口不应求值漫画 ${resource} 资源`);
        });
        try {
            const actualModel = await import('@/src/core/config/model');
            const normalized = actualModel.normalizeConfig({
                imageTranslationMangaSites: [{hostname: 'custom.example', pathPrefix: '/read/', selector: ' main img '}],
                imageTranslationMangaPrefetchPages: 0,
                imageTranslationMangaCachePages: 3.9,
            });
            expect(normalized.imageTranslationMangaSites).toEqual([
                {hostname: 'custom.example', pathPrefix: '/read/', selector: 'main img'},
            ]);
            expect(normalized.imageTranslationMangaPrefetchPages).toBe(0);
            expect(normalized.imageTranslationMangaCachePages).toBe(3);
            expect(reached).toBe(0);
        } catch (error) {
            expect(reached, `真实 model 导入失败时的 ${resource} 哨兵调用数`).toBe(0);
            throw error;
        } finally {
            vi.doUnmock(resourceId);
            vi.resetModules();
        }
    });

    it('旧公开入口直接导出同一归一化函数引用', async () => {
        vi.resetModules();
        try {
            const legacy = await import('@/src/core/config/manga');
            // importActual 在 case 内解析新路径；旧源缺新文件不会破坏原 suite 的收集。
            const shared = await vi.importActual<MangaNormalizationContract>('@/src/core/config/mangaNormalization');
            for (const key of ['normalizeMangaPrefetchPages', 'createMangaSiteRule', 'normalizeMangaSiteRules',
                'normalizeMangaCachePages', 'mangaCachePixelBudget'] as const) {
                expect(legacy[key], key).toBe(shared[key]);
            }
        } finally {
            vi.resetModules();
        }
    });

    it('真实 URL 归一化保留 IDN、构造先后与原异常空结果', async () => {
        vi.resetModules();
        try {
            const actual = await import('@/src/core/config/manga');
            const NativeURL = globalThis.URL;
            const idn = 'https://뉴토끼대피소.com/read?lang=en#page2';
            const expectedHostname = new NativeURL(idn).hostname;
            const calls: string[] = [];
            const order: string[] = [];
            const rejectedUrl = 'https://controlled-rejected.example/read/';
            class RecordingURL extends NativeURL {
                constructor(input: string | URL, base?: string | URL) {
                    const text = String(input);
                    calls.push(text);
                    order.push('url:' + text);
                    if (text === rejectedUrl) throw new TypeError('controlled URL constructor rejection');
                    super(input, base);
                }
            }
            vi.stubGlobal('URL', RecordingURL);
            expect(actual.createMangaSiteRule(idn, ' main img ')).toEqual({
                hostname: expectedHostname, pathPrefix: '/read', selector: 'main img',
            });
            expect(expectedHostname).toMatch(/^xn--/u);
            expect(actual.createMangaSiteRule('not a URL', 'img')).toBeNull();
            const selector = {trim: vi.fn(() => 'img')};
            expect(actual.createMangaSiteRule(rejectedUrl, selector as unknown as string)).toBeNull();
            expect(selector.trim).not.toHaveBeenCalled();
            order.length = 0;
            const throwingSelector = {trim() {
                order.push('selector');
                throw new Error('controlled selector rejection');
            }};
            expect(actual.createMangaSiteRule('https://selector.example/read/', throwingSelector as unknown as string)).toBeNull();
            expect(order).toEqual(['url:https://selector.example/read/', 'selector']);
            expect(calls).toEqual([idn, 'not a URL', rejectedUrl, 'https://selector.example/read/']);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });

    it('每条自定义规则真实校验 URL，保留去重顺序与字段读取异常', async () => {
        vi.resetModules();
        try {
            const actual = await import('@/src/core/config/manga');
            const NativeURL = globalThis.URL;
            const idnHostname = new NativeURL('https://뉴토끼대피소.com/').hostname;
            const calls: string[] = [];
            class RecordingURL extends NativeURL {
                constructor(input: string | URL, base?: string | URL) {
                    calls.push(String(input));
                    super(input, base);
                }
            }
            vi.stubGlobal('URL', RecordingURL);
            const rules = [
                {hostname: 'first.example', pathPrefix: '/read/', selector: ' img '},
                {hostname: 'first.example', pathPrefix: '/read/', selector: 'article img'},
                {hostname: 'first.example', pathPrefix: '/read/../else/', selector: 'img'},
                {hostname: idnHostname, pathPrefix: '/reader/', selector: 'figure > img'},
            ];
            const before = rules.map(rule => ({...rule}));
            expect(actual.normalizeMangaSiteRules(rules)).toEqual([
                {hostname: 'first.example', pathPrefix: '/read/', selector: 'img'},
                {hostname: idnHostname, pathPrefix: '/reader/', selector: 'figure > img'},
            ]);
            expect(calls).toEqual(['https://first.example/read/', 'https://first.example/read/',
                'https://first.example/read/../else/', `https://${idnHostname}/reader/`]);
            expect(rules).toEqual(before);
            const getterFailure = new Error('controlled hostname getter failure');
            const inaccessible = {get hostname(): string {throw getterFailure;}, pathPrefix: '/read/', selector: 'img'};
            expect(() => actual.normalizeMangaSiteRules([inaccessible])).toThrow(getterFailure);
            expect(calls).toHaveLength(4);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });

    it('快速缓存容量的损坏值和总像素预算保留原默认、下限与上限', async () => {
        vi.resetModules();
        try {
            const actual = await import('@/src/core/config/manga');
            for (const value of [undefined, Infinity]) {
                expect(actual.normalizeMangaCachePages(value)).toBe(12);
                expect(actual.mangaCachePixelBudget(value)).toBe(24_000_000);
            }
            for (const [value, pages, pixels] of [[0, 1, 2_000_000], [3.9, 3, 6_000_000], [999, 24, 48_000_000]]) {
                expect(actual.normalizeMangaCachePages(value)).toBe(pages);
                expect(actual.mangaCachePixelBudget(value)).toBe(pixels);
            }
        } finally {
            vi.resetModules();
        }
    });

    it('isLocalMangaHost 严格校验 .local 主机标签和 IPv4 八位段上限', () => {
        for (const host of ['localhost', '[::1]', 'nas.local', 'a.local', 'my-nas.home.local', 'NAS.LOCAL', '127.0.0.1', '10.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.254']) {
            expect(isLocalMangaHost(host), host).toBe(true);
        }
        for (const host of ['.local', 'a..local', '-foo.local', 'foo-.local', 'foo.-bar.local', 'foo_bar.local', '127.0.0.999', '10.256.0.1', '192.168.1.300', '172.16.999.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', 'example.com']) {
            expect(isLocalMangaHost(host), host).toBe(false);
        }
        expect(createMangaSiteRule('http://nas.local:8080/read/', 'img')).toEqual({
            hostname: 'nas.local:8080', pathPrefix: '/read/', selector: 'img',
        });
        expect(createMangaSiteRule('http://-foo.local:8080/read/', 'img')).toBeNull();
        expect(createMangaSiteRule('http://a..local:8080/read/', 'img')).toBeNull();
    });
});
