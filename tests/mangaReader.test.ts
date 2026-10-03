import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaSession, type MangaSnapshot} from '@/src/features/image-translation/content/mangaSession';
import {createMangaReader, mangaReaderSelector} from '@/src/features/image-translation/content/mangaReader';
import {normalizeConfig} from '@/src/core/config/model';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve}; }
function sessionFixture(extra: {reuse?: (image: HTMLImageElement) => boolean} = {}) {
    const one = {} as HTMLImageElement, two = {} as HTMLImageElement;
    const ports = {translate: vi.fn().mockResolvedValue(undefined), restore: vi.fn(), release: vi.fn(), failed: vi.fn().mockReturnValue(false), changed: vi.fn(), ...extra};
    const session = createMangaSession(ports);
    const snapshot: MangaSnapshot = {route: 'chapter-1', available: true, pages: [
        {image: one, identity: '1', visible: true}, {image: two, identity: '2', visible: false},
    ]};
    session.refresh(snapshot);
    const start = () => {session.toggle(); session.refresh(snapshot);};
    return {session, ports, one, two, snapshot, start};
}
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('漫画会话所有权与可见页调度', () => {
    it('上一张已完成译图立即复用，不等待另一张识别结束', async () => {
        const reuse=vi.fn().mockReturnValue(false),f=sessionFixture({reuse}),pending=deferred();
        f.start();await flush();f.ports.translate.mockReturnValueOnce(pending.promise);
        f.snapshot.pages[0].visible=false;f.snapshot.pages[1].visible=true;f.session.refresh(f.snapshot);await flush();
        reuse.mockImplementation(image=>image===f.one);
        f.snapshot.pages[0].visible=true;f.session.refresh(f.snapshot);
        expect(reuse).toHaveBeenCalledWith(f.one);expect(f.session.status()).toMatchObject({completed:1,pending:true});
        expect(f.ports.translate).toHaveBeenCalledTimes(2);pending.resolve();await flush();f.session.dispose();
    });
    it('可见页优先于排队预译页，已经准备好的页进入视口不会再识别', async () => {
        const f=sessionFixture(),pending=deferred(),three={} as HTMLImageElement;
        f.snapshot.pages[1].prefetch=true;f.ports.translate.mockReturnValueOnce(pending.promise);
        f.start();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([f.one]);
        f.snapshot.pages.push({image:three,identity:'3',visible:true});f.session.refresh(f.snapshot);
        pending.resolve();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([f.one,three,f.two]);
        expect(f.session.status()).toMatchObject({ahead:1,completed:3,prefetching:false});
        f.snapshot.pages[1].visible=true;f.session.refresh(f.snapshot);await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(3);expect(f.session.status().ahead).toBe(0);
        f.session.toggle();expect(f.ports.restore).toHaveBeenCalledTimes(3);
    });
    it('滚动离开窗口的在途页不取消、不重做；最终释放，真实移除仍及时取消', async () => {
        const f=sessionFixture(),pending=deferred();f.ports.translate.mockReturnValueOnce(pending.promise);
        f.start();await flush();f.snapshot.pages[0].visible=false;f.snapshot.pages[1].visible=true;
        f.session.refresh(f.snapshot);expect(f.ports.release).not.toHaveBeenCalled();
        expect(f.session.status().prefetching).toBe(true);pending.resolve();await flush();
        expect(f.ports.release).toHaveBeenCalledWith(f.one);expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([f.one,f.two]);
        const again=deferred();f.snapshot.pages[0].visible=true;f.ports.translate.mockReturnValueOnce(again.promise);
        f.session.refresh(f.snapshot);await flush();f.snapshot.pages.shift();f.session.refresh(f.snapshot);
        expect(f.ports.release).toHaveBeenCalledTimes(2);again.resolve();await flush();expect(f.session.status().errors).toBe(0);
    });
    it('快速返回在途页继续复用；隐藏页完成在途任务后暂停后续，恢复时再继续', async () => {
        const f=sessionFixture(),pending=deferred();f.snapshot.pages[1].prefetch=true;
        f.ports.translate.mockReturnValueOnce(pending.promise);f.start();await flush();
        f.snapshot.pages[0].visible=false;f.session.refresh(f.snapshot);
        f.snapshot.pages[0].visible=true;f.snapshot.suspended=true;f.session.refresh(f.snapshot);
        pending.resolve();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);expect(f.ports.release).not.toHaveBeenCalled();
        f.snapshot.suspended=false;f.session.refresh(f.snapshot);await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.snapshot.pages[1].prefetch=false;f.session.refresh(f.snapshot);expect(f.ports.release).toHaveBeenCalledWith(f.two);
    });
    it('旧配置启用入口但保留图片总开关和用户明确关闭的入口', () => {
        expect(normalizeConfig({}).imageTranslationMangaEnabled).toBe(true);
        expect(normalizeConfig({}).disableImageTranslator).toBe(true);
        expect(normalizeConfig({imageTranslationMangaEnabled: false}).imageTranslationMangaEnabled).toBe(false);
        expect(normalizeConfig({imageTranslationMangaEnabled: 'false'} as never).imageTranslationMangaEnabled).toBe(true);
    });
    it('只有开启后的可见页面会翻译，滚动继续且同一页不会重复入队', async () => {
        const f = sessionFixture(); await flush(); expect(f.ports.translate).not.toHaveBeenCalled();
        f.start(); expect(f.session.status().pending).toBe(true);expect(f.session.status().completed).toBe(0); await flush();
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([f.one]);
        f.session.refresh(f.snapshot); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.snapshot.pages[0].visible = false; f.snapshot.pages[1].visible = true;
        f.session.refresh(f.snapshot); await flush();
        expect(f.ports.release).toHaveBeenCalledWith(f.one);
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([f.one, f.two]);
    });
    it('两个可见页面严格串行，原图暂停后重开可继续', async () => {
        const f = sessionFixture(), pending = deferred();
        f.ports.translate.mockReturnValueOnce(pending.promise);
        f.snapshot.pages[1].visible = true; f.start(); await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.session.toggle(); expect(f.session.status().active).toBe(false);
        expect(f.ports.restore).toHaveBeenCalledTimes(2);
        f.session.refresh(f.snapshot); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.session.toggle(); f.session.refresh(f.snapshot); await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        pending.resolve(); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(3);
        expect(f.session.status()).toEqual({available: true, active: true, pending: false, errors: 0, completed: 2, prefetching: false, ahead: 0});
    });
    it('尚未执行的旧任务取消后不会发送请求', async () => {
        const f = sessionFixture(); f.start(); f.session.toggle(); await flush();
        expect(f.ports.translate).not.toHaveBeenCalled();
    });
    it('资源替换立即释放旧结果，迟到结果不能归属新页面', async () => {
        const f = sessionFixture(), pending = deferred(); f.ports.translate.mockReturnValueOnce(pending.promise);
        f.start(); await flush(); f.snapshot.pages[0].identity = 'new-source'; f.session.refresh(f.snapshot);
        expect(f.ports.release).toHaveBeenCalledWith(f.one);
        pending.resolve(); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(2);
    });
    it('换章与关闭功能停止会话，失败页不会自动无限重试', async () => {
        const f = sessionFixture(); f.ports.translate.mockRejectedValueOnce(new Error('network')); f.start(); await flush();
        expect(f.session.status().errors).toBe(1);
        f.session.refresh(f.snapshot); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.session.toggle(); f.session.toggle(); f.session.refresh(f.snapshot); await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(2); expect(f.session.status().errors).toBe(0);
        f.snapshot.route = 'chapter-2'; f.session.refresh(f.snapshot);
        expect(f.session.status().active).toBe(false);
        f.start(); await flush(); f.snapshot.available = false; f.session.refresh(f.snapshot);
        expect(f.session.toggle()).toBe(false); expect(f.session.status().active).toBe(false);
    });
    it('翻译端口报告错误与卸载后迟到拒绝均被安全消费', async () => {
        const f = sessionFixture(); f.ports.failed.mockReturnValue(true); f.start(); await flush();
        expect(f.session.status().errors).toBe(1);
        const pending = deferred(); f.session.toggle(); f.ports.translate.mockReturnValueOnce(pending.promise);
        f.session.toggle(); f.session.refresh(f.snapshot); await flush();
        f.session.dispose(); pending.resolve(); await flush();
        expect(f.session.toggle()).toBe(false); f.session.refresh(f.snapshot);
        expect(f.session.status()).toEqual({available: false, active: false, pending: false, errors: 0, completed: 0, prefetching: false, ahead: 0});
    });
    it('页面移除后的拒绝不会计入当前会话', async () => {
        const f = sessionFixture(); let reject!: (error: Error) => void;
        f.ports.translate.mockReturnValueOnce(new Promise<void>((_, no) => {reject = no;}));
        f.start(); await flush(); f.snapshot.pages = []; f.session.refresh(f.snapshot);
        reject(new Error('cancelled')); await flush(); expect(f.session.status().errors).toBe(0);
    });
});

function readerFixture(withIntersection = true, initialUrl = 'https://mangaplus.shueisha.co.jp/viewer/1024050', siteRules?: () => import('@/src/core/config/manga').MangaSiteRule[], prefetchPages?: () => number) {
    const {document, window: dom} = parseHTML('<html><body><div class="zao-image-container"><img class="zao-image" src="blob:page-1"></div><img id="logo" src="https://site/logo.png"></body></html>');
    const image = document.querySelector('img')! as HTMLImageElement;
    Object.defineProperties(image, {complete: {writable: true, value: true}, naturalWidth: {writable: true, value: 800}, naturalHeight: {value: 1200}, currentSrc: {get: () => image.src}});
    let bounds = {left: 0, top: 0, right: 800, bottom: 1200, width: 800, height: 1200};
    image.getBoundingClientRect = () => bounds as DOMRect;
    let style = {visibility: 'visible', display: 'block'};
    let hidden = false; Object.defineProperty(document, 'hidden', {get: () => hidden});
    const events = new Map<string, () => void>(), frames = new Map<number, FrameRequestCallback>(); let id = 0;
    const window = {location: {href: initialUrl}, innerWidth: 1280, innerHeight: 900,
        addEventListener: vi.fn((event, callback) => events.set(event, callback)), removeEventListener: vi.fn(),
        requestAnimationFrame: vi.fn(callback => {frames.set(++id, callback); return id;}), cancelAnimationFrame: vi.fn(i => frames.delete(i))};
    const io = {observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(), callback: null as unknown as IntersectionObserverCallback};
    const mo = {observe: vi.fn(), disconnect: vi.fn(), callback: null as unknown as MutationCallback};
    vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Element', dom.Element);
    vi.stubGlobal('getComputedStyle', () => style);
    vi.stubGlobal('IntersectionObserver', withIntersection ? class {observe = io.observe; unobserve = io.unobserve; disconnect = io.disconnect;
        constructor(callback: IntersectionObserverCallback) {io.callback = callback;} } : undefined);
    vi.stubGlobal('MutationObserver', class {observe = mo.observe; disconnect = mo.disconnect;
        constructor(callback: MutationCallback) {mo.callback = callback;} });
    const ports = {enabled: vi.fn().mockReturnValue(true), identity: (i: HTMLImageElement) => i.src,
        translate: vi.fn().mockResolvedValue(undefined), restore: vi.fn(), release: vi.fn(), failed: vi.fn().mockReturnValue(false), changed: vi.fn()};
    const reader = createMangaReader({...ports, siteRules, prefetchPages});
    const run = () => {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(c => c(0));};
    const intersect = (yes: boolean) => {io.callback([{target: image, isIntersecting: yes} as unknown as IntersectionObserverEntry], {} as IntersectionObserver); run();};
    return {reader, ports, image, io, mo, window, dom, document, run, intersect,
        setRect: (v: Partial<typeof bounds>) => Object.assign(bounds, v), setStyle: (v: Partial<typeof style>) => Object.assign(style, v),
        setHidden: (v: boolean) => {hidden = v;}};
}
describe('漫画站点适配与 DOM 生命周期', () => {
    it('过期可见性通知不能释放屏幕里已完成的译图', async () => {
        const f=readerFixture();f.intersect(true);f.reader.toggle();await flush();
        f.intersect(false);await flush();
        expect(f.ports.release).not.toHaveBeenCalled();expect(f.ports.translate).toHaveBeenCalledTimes(1);f.reader.dispose();
    });
    it.each(['display','visibility','collapse','opacity','clipX','clipY','both'])('祖先隐藏或裁切时不处理不可见正文 %s', async kind => {
        const f=readerFixture(false),parent=f.image.parentElement!,normal={display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'};
        const changed={...normal};
        if (kind==='display') changed.display='none';
        if (kind==='visibility') changed.visibility='hidden';
        if (kind==='collapse') changed.visibility='collapse';
        if (kind==='opacity') changed.opacity='0';
        if (kind==='clipX' || kind==='both') changed.overflowX='hidden';
        if (kind==='clipY' || kind==='both') changed.overflowY='clip';
        parent.getBoundingClientRect=()=>({left:1600,right:2000,top:1600,bottom:2000}) as DOMRect;
        vi.stubGlobal('getComputedStyle',(e:Element)=>e===parent?changed:normal);
        f.reader.toggle();await flush();expect(f.ports.translate).not.toHaveBeenCalled();f.reader.dispose();
    });
    it('历史页只保留不主动识别；像素预算限制长条页，前后视口共享祖先样式', async () => {
        const f=readerFixture(false),parents=f.image.parentElement!,images=[f.image];let anchor=3;
        f.image.getBoundingClientRect=()=>({left:0,right:800,top:-3900,bottom:-2700,width:800,height:1200}) as DOMRect;
        for(let index=1;index<=3;index++) {
            const image=f.document.createElement('img') as HTMLImageElement;image.className='zao-image';image.src=`blob:p${index}`;
            Object.defineProperties(image,{complete:{value:true,writable:true},naturalWidth:{value:index===1?10000:800,writable:true},naturalHeight:{value:1200}});
            image.getBoundingClientRect=()=>({left:0,right:800,top:(index-anchor)*1300,bottom:(index-anchor)*1300+1200,width:800,height:1200}) as DOMRect;
            parents.append(image);images.push(image);
        }
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([images[3]]);
        // 同时可见两张时，父容器样式只读取一次；IO 通知不决定是否保留译图。
        anchor=2.5;const styles=vi.fn((_e:Element)=>({display:'block',visibility:'visible',overflowX:'visible',overflowY:'visible'}));vi.stubGlobal('getComputedStyle',styles);
        f.reader.schedule();f.run();await flush();expect(styles.mock.calls.filter(([e])=>e===parents)).toHaveLength(1);
        f.reader.dispose();
    });
    it('仅历史保留项不启动识别，也不计入后续页准备数量', async () => {
        const f=sessionFixture();f.snapshot.pages[1].retain=true;f.start();await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);expect(f.session.status().ahead).toBe(0);f.session.dispose();
    });
    it('默认窗口翻译当前与随后三张，排除更后页；改变窗口不会重识别当前页', async () => {
        let ahead=3;const f=readerFixture(false,undefined,undefined,()=>ahead),images=[f.image];
        for(let i=1;i<6;i++){
            const image=f.document.createElement('img') as HTMLImageElement;image.className='zao-image';image.src=`blob:page-${i+1}`;
            Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
            image.getBoundingClientRect=()=>({left:0,right:800,top:i*1300,bottom:i*1300+1200,width:800,height:1200}) as DOMRect;
            f.image.parentElement!.append(image);images.push(image);
        }
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual(images.slice(0,4));
        expect(f.reader.status()).toMatchObject({ahead:3,completed:4});
        ahead=0;f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(4);
        expect(f.ports.release.mock.calls.map(c=>c[0])).toEqual(images.slice(1,4));f.reader.dispose();
    });
    it('未加载的后续页不强制加载；Pixiv 点击正文与 presentation 角色不再被当装饰图', async () => {
        const f=readerFixture(false,'https://www.pixiv.net/artworks/150354216#1',undefined,()=>3);
        f.image.src='https://i.pximg.net/img-master/path/150354216_p0_master1200.jpg';f.image.parentElement!.setAttribute('role','presentation');
        const unloaded=f.document.createElement('img') as HTMLImageElement;unloaded.src='https://i.pximg.net/img-original/path/150354216_p1.jpg';
        Object.defineProperties(unloaded,{complete:{value:false},naturalWidth:{value:0},naturalHeight:{value:0}});
        unloaded.getBoundingClientRect=()=>({left:0,right:800,top:1500,bottom:2700,width:800,height:1200}) as DOMRect;f.document.body.append(unloaded);
        const thumbnail=f.image.cloneNode() as HTMLImageElement;thumbnail.src='https://i.pximg.net/custom-thumb/150354216_p0.jpg';f.document.body.append(thumbnail);
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        expect(f.ports.translate).toHaveBeenCalledTimes(1);expect(unloaded.src).toContain('/150354216_p1.jpg');f.reader.dispose();
    });
    it('Pixiv 全屏阅读器存在时不处理背后重复封面，关闭后恢复封面候选', async () => {
        const f=readerFixture(false,'https://www.pixiv.net/artworks/150354216#1');
        f.image.src='https://i.pximg.net/img-master/150354216_p0.jpg';
        const container=f.document.createElement('div');container.className='gtm-expand-full-size-illust';
        const expanded=f.document.createElement('img') as HTMLImageElement;expanded.src=f.image.src;
        Object.defineProperties(expanded,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
        expanded.getBoundingClientRect=f.image.getBoundingClientRect;container.append(expanded);f.document.body.append(container);
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([expanded]);
        container.remove();f.reader.schedule();f.run();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([expanded,f.image]);f.reader.dispose();
    });
    it('通用阅读器先等待正文，不把导航、推荐和小图当漫画；动态加载后出现入口', async () => {
        const f=readerFixture(false,'https://mangadex.org/title/123');expect(f.reader.status().available).toBe(false);
        f.image.parentElement!.id='reader';f.image.parentElement!.setAttribute('class','recommendations');f.reader.schedule();f.run();
        expect(f.reader.status().available).toBe(false);f.image.parentElement!.removeAttribute('class');f.setRect({width:100});f.reader.schedule();f.run();
        expect(f.reader.status().available).toBe(false);f.setRect({width:800});f.reader.schedule();f.run();
        expect(f.reader.status().available).toBe(true);f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);f.reader.dispose();
    });
    it('自定义选择器只识别图片，损坏的选择器不中断页面，规则修改后重新扫描', async () => {
        const rules = [{hostname:'example.com',pathPrefix:'/reader/',selector:'.zao-image-container, .zao-image-container img'}];
        const f = readerFixture(false, 'https://example.com/reader/1', () => rules);
        expect(f.ports.changed).toHaveBeenLastCalledWith(expect.objectContaining({available:true,pageCount:1}));
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        rules[0].selector = '[';f.reader.schedule();f.run();expect(f.io.unobserve).not.toHaveBeenCalled();
        expect(f.ports.changed).toHaveBeenLastCalledWith(expect.objectContaining({pageCount:0}));
        rules[0].selector = '.zao-image';f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();f.reader.schedule();f.run();f.reader.dispose();
    });
    it.each(['https://mangaplus.shueisha.co.jp/viewer/1024050', 'https://mangaplus.shueisha.co.jp/viewer/123/'])('精确识别阅读器 %s', href => {
        expect(mangaReaderSelector(href)).toBe('.zao-image-container img.zao-image');
    });
    it.each(['not a url', 'http://mangaplus.shueisha.co.jp/viewer/123', 'https://mangaplus.shueisha.co.jp/updates', 'https://mangaplus.shueisha.co.jp.attacker.test/viewer/123'])('拒绝首页和相似域名 %s', href => {
        expect(mangaReaderSelector(href)).toBeNull();
    });
    it('观察可见正文、不处理 logo，关闭后释放观察器与事件', async () => {
        const f = readerFixture(); expect(f.io.observe).toHaveBeenCalledWith(f.image);
        f.reader.toggle(); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.intersect(true); await flush(); expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.setRect({top:-1200,bottom:0});f.intersect(false); expect(f.ports.release).toHaveBeenCalledWith(f.image);
        f.setRect({top:0,bottom:1200});f.intersect(true); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.reader.schedule(); f.reader.schedule(); f.reader.dispose(); f.run(); f.reader.schedule();
        expect(f.window.cancelAnimationFrame).toHaveBeenCalled(); expect(f.io.disconnect).toHaveBeenCalled();
        expect(f.mo.disconnect).toHaveBeenCalled(); expect(f.window.removeEventListener).toHaveBeenCalledTimes(2);
        expect(f.reader.toggle()).toBe(false);
    });
    it('Mutation、load、配置和路由变化合并到一帧，UI 内变更不再触发扫描', async () => {
        const f = readerFixture(); f.intersect(true); f.reader.toggle(); await flush();
        const host = f.document.createElement('div'); host.setAttribute('data-fluent-read-ui', 'fixture');
        const before = f.window.requestAnimationFrame.mock.calls.length;
        f.mo.callback([{target: host} as unknown as MutationRecord], {} as MutationObserver);
        expect(f.window.requestAnimationFrame).toHaveBeenCalledTimes(before);
        f.mo.callback([{target: f.image} as unknown as MutationRecord], {} as MutationObserver);
        f.document.dispatchEvent(new f.dom.Event('load')); f.reader.schedule(); f.run();
        expect(f.window.requestAnimationFrame).toHaveBeenCalledTimes(before + 1);
        f.image.remove(); f.reader.schedule(); f.run(); expect(f.io.unobserve).toHaveBeenCalledWith(f.image);
        f.window.location.href = 'https://mangaplus.shueisha.co.jp/viewer/555';
        f.document.dispatchEvent(new f.dom.Event('fluentread-route-change')); f.run();
        expect(f.reader.status().active).toBe(false);
        f.ports.enabled.mockReturnValue(false); f.reader.schedule(); f.run(); expect(f.reader.status().available).toBe(false);
        f.reader.dispose();
    });
    it('没有 IntersectionObserver 时按视口处理；隐藏、未加载和不可见页面不进入队列', async () => {
        const f = readerFixture(false); f.reader.toggle(); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        const cases = [
            () => {f.setHidden(true);}, () => {Object.defineProperty(f.image, 'complete', {value: false});}, () => {Object.defineProperty(f.image, 'naturalWidth', {value: 0});},
            () => {f.setRect({width: 1});}, () => {f.setRect({bottom: 0});}, () => {f.setRect({right: 0});},
            () => {f.setRect({top: 1000});}, () => {f.setRect({left: 2000});},
            () => {f.setStyle({visibility: 'hidden'});}, () => {f.setStyle({visibility: 'collapse'});}, () => {f.setStyle({display: 'none'});},
        ];
        for (const change of cases) {
            f.setHidden(false); Object.defineProperties(f.image, {complete: {value: true}, naturalWidth: {value: 800}});
            f.setRect({left: 0, top: 0, right: 800, bottom: 1200, width: 800}); f.setStyle({visibility: 'visible', display: 'block'});
            change(); f.reader.schedule(); f.run(); await flush();
            expect(f.ports.translate).toHaveBeenCalledTimes(1);
        }
        f.reader.dispose();
    });
    it('扩展自有图片被过滤；非阅读器没有 DOM 观察器，进入阅读器后才挂载', () => {
        const f = readerFixture(false, 'https://example.com'); expect(f.mo.observe).not.toHaveBeenCalled();
        f.reader.schedule(); f.run(); expect(f.window.requestAnimationFrame).not.toHaveBeenCalled();
        Object.assign(f.window, {location: undefined}); f.reader.schedule(); f.run();
        Object.assign(f.window, {location: {href: 'https://example.com'}});
        f.window.location.href = 'https://mangaplus.shueisha.co.jp/viewer/123';
        f.image.parentElement!.setAttribute('data-fluent-read-ui', 'fake'); f.reader.schedule(); f.run();
        expect(f.reader.status().available).toBe(true); expect(f.io.observe).not.toHaveBeenCalled();
        f.reader.dispose();
    });
    it('无页面地址的测试环境安全回退且忽略非元素 mutation', () => {
        const f = readerFixture(false); (f.window as {location?: unknown}).location = undefined;
        f.mo.callback([{target: f.document} as unknown as MutationRecord], {} as MutationObserver); f.run();
        expect(f.reader.status().available).toBe(false); f.reader.dispose();
    });
});
