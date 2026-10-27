import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaSession, type MangaSnapshot} from '@/src/features/image-translation/content/mangaSession';
import {createMangaReader, mangaReaderSelector} from '@/src/features/image-translation/content/mangaReader';
import {normalizeConfig} from '@/src/core/config/model';
import * as mangaConfig from '@/src/core/config/manga';

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
afterEach(() => {vi.useRealTimers();vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('漫画会话所有权与可见页调度', () => {
    it('按需列表只复制可见保留页，按章节序号排序并保留第 65 项作超预算标记',()=>{
        const pages=Array.from({length:66},(_,index)=>({image:{} as HTMLImageElement,identity:String(index),visible:true,ordinal:66-index}));
        const ports={translate:vi.fn().mockResolvedValue(undefined),restore:vi.fn(),release:vi.fn(),failed:()=>false,changed:vi.fn()};
        const session=createMangaSession(ports),snapshot={route:'chapter',available:true,pages};session.refresh(snapshot);session.toggle();session.refresh(snapshot);
        const visible=session.readingPages();expect(visible).toHaveLength(65);expect(visible[0].ordinal).toBe(2);expect(visible.at(-1)?.ordinal).toBe(66);
        session.refresh({...snapshot,suspended:true});expect(session.readingPages()).toEqual([]);
        session.dispose();expect(session.readingPages()).toEqual([]);
    });
    it.each([
        {ordinals:[5,undefined,1], expected:0},
        {ordinals:[5,3,undefined], expected:0},
        {ordinals:[5,3,1], expected:2},
    ])('同优先级序号缺失时整体保持进入顺序，完整时按最小序号调度 $ordinals',async({ordinals,expected})=>{
        const pages=ordinals.map((ordinal,index)=>({image:{id:index} as unknown as HTMLImageElement,identity:String(index),visible:true,ordinal}));
        const ports={translate:vi.fn().mockResolvedValue(undefined),restore:vi.fn(),release:vi.fn(),failed:()=>false,changed:vi.fn()};
        const session=createMangaSession(ports),snapshot={route:'chapter',available:true,pages};session.refresh(snapshot);session.toggle();session.refresh(snapshot);await flush();
        expect(ports.translate.mock.calls[0][0]).toBe(pages[expected].image);session.dispose();
    });
    it('离屏预译缺少序号不影响可见页按有效序号选择',async()=>{
        const pages=[{image:{} as HTMLImageElement,identity:'ahead',visible:false,prefetch:true},
            {image:{} as HTMLImageElement,identity:'visible-later',visible:true,ordinal:3},
            {image:{} as HTMLImageElement,identity:'visible-first',visible:true,ordinal:1}];
        const ports={translate:vi.fn().mockResolvedValue(undefined),restore:vi.fn(),release:vi.fn(),failed:()=>false,changed:vi.fn()};
        const session=createMangaSession(ports),snapshot={route:'chapter',available:true,pages};session.refresh(snapshot);session.toggle();session.refresh(snapshot);await flush();
        expect(ports.translate.mock.calls[0][0]).toBe(pages[2].image);session.dispose();
    });
    it('页面暂缓后仍保留在串行队列，可再次完成而不伪造失败',async()=>{
        const image={} as HTMLImageElement,ports={translate:vi.fn().mockResolvedValueOnce('deferred').mockResolvedValueOnce(undefined),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),changed:vi.fn()};
        const session=createMangaSession(ports),snapshot={route:'chapter',available:true,pages:[{image,identity:'one',visible:true}]};
        session.refresh(snapshot);session.toggle();session.refresh(snapshot);await flush();
        expect(ports.translate).toHaveBeenCalledTimes(2);expect(session.status()).toMatchObject({completed:1,errors:0,pending:false});session.dispose();
    });
    it('移动关闸同步阻止下一页启动，停留后按最新可见页继续；缓存交接仍立即执行', async () => {
        const reuse = vi.fn().mockReturnValue(false), f = sessionFixture({reuse}), pending = deferred();
        f.snapshot.pages[1].prefetch = true;
        f.ports.translate.mockReturnValueOnce(pending.promise);f.start();await flush();
        f.session.deferScheduling();pending.resolve();await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.snapshot.deferNewWork = true;f.snapshot.pages[0].visible = false;f.snapshot.pages[1].visible = true;
        f.session.refresh(f.snapshot);await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);
        reuse.mockImplementation(image => image === f.one);f.snapshot.pages[0].visible = true;
        f.session.refresh(f.snapshot);
        expect(reuse).toHaveBeenCalledWith(f.one);expect(f.session.status()).toMatchObject({completed:1,pending:false});
        f.snapshot.deferNewWork = false;f.session.refresh(f.snapshot);await flush();
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([f.one,f.two]);f.session.dispose();
        f.session.deferScheduling();
    });
    it('首个请求的微任务前开始移动不会识别或虚报完成，显式开关和重试立即恢复调度', async () => {
        const f = sessionFixture();f.start();f.session.deferScheduling();await flush();
        expect(f.ports.translate).not.toHaveBeenCalled();expect(f.session.status().completed).toBe(0);
        f.snapshot.deferNewWork = true;f.session.refresh(f.snapshot);await flush();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.session.toggle();f.session.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.session.deferScheduling();f.session.refresh(f.snapshot);
        expect(f.session.retry(f.one)).toBe(true);await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.session.dispose();
    });
    it('远距离跳页停稳后取消旧识别，移动、后台隐藏和附近保留期间不抢占串行槽', async () => {
        const f = sessionFixture();let cancel!: (error: Error) => void;
        f.ports.translate.mockReturnValueOnce(new Promise<void>((_, reject) => {cancel = reject;}));
        f.ports.release.mockImplementation(image => {if (image === f.one) cancel(new Error('aborted'));});
        f.start();await flush();f.snapshot.pages[0].visible = false;f.snapshot.pages[1].visible = true;
        f.snapshot.deferNewWork = true;f.session.refresh(f.snapshot);expect(f.ports.release).not.toHaveBeenCalled();
        f.snapshot.deferNewWork = false;f.snapshot.suspended = true;f.session.refresh(f.snapshot);
        expect(f.ports.release).not.toHaveBeenCalled();
        f.snapshot.suspended = false;f.snapshot.pages[0].retain = true;f.session.refresh(f.snapshot);
        expect(f.ports.release).not.toHaveBeenCalled();
        f.snapshot.pages[0].retain = false;f.session.refresh(f.snapshot);
        expect(f.ports.release).toHaveBeenCalledWith(f.one);expect(f.ports.translate).toHaveBeenCalledTimes(1);
        expect(f.session.status().pending).toBe(true);await flush();
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([f.one,f.two]);
        expect(f.session.status()).toMatchObject({errors:0,completed:1,pending:false});f.session.dispose();
    });
    it('返回已译缓存立即显示，不取消远处在途任务；取消后的迟到结果不能复活旧页', async () => {
        const reuse = vi.fn().mockReturnValue(false), f = sessionFixture({reuse}), pending = deferred();
        f.ports.translate.mockReturnValueOnce(pending.promise);f.start();await flush();
        reuse.mockImplementation(image => image === f.two);
        f.snapshot.pages[0].visible = false;f.snapshot.pages[1].visible = true;f.session.refresh(f.snapshot);
        expect(f.ports.release).not.toHaveBeenCalled();expect(f.session.status()).toMatchObject({completed:1,pending:true});
        pending.resolve();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);f.session.dispose();
        const late = sessionFixture(), stale = deferred();late.ports.translate.mockReturnValueOnce(stale.promise);
        late.ports.failed.mockImplementation(image => image === late.one);late.start();await flush();
        late.snapshot.pages[0].visible = false;late.snapshot.pages[1].visible = true;late.session.refresh(late.snapshot);
        expect(late.ports.release).toHaveBeenCalledTimes(1);expect(late.ports.translate).toHaveBeenCalledTimes(1);
        stale.resolve();await flush();expect(late.ports.translate.mock.calls.map(c => c[0])).toEqual([late.one,late.two]);
        expect(late.ports.release).toHaveBeenCalledTimes(1);expect(late.session.status()).toMatchObject({errors:0,completed:1});late.session.dispose();
    });
    it('失败不自动循环请求，显式单页重试发布进度并在成功后清除会话错误',async()=>{
        const reuse=vi.fn().mockReturnValue(false),f=sessionFixture({reuse});f.ports.failed.mockReturnValue(true);
        f.start();await flush();expect(f.session.status().errors).toBe(1);
        reuse.mockReturnValue(true);f.session.refresh(f.snapshot);expect(f.session.status().errors).toBe(1);
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        const pending=deferred();f.ports.translate.mockReturnValueOnce(pending.promise);f.ports.failed.mockReturnValue(false);
        expect(f.session.retry(f.one)).toBe(true);await flush();
        expect(f.session.status()).toMatchObject({errors:0,completed:0,pending:true});
        expect(f.session.retry(f.one)).toBe(false);expect(f.ports.translate).toHaveBeenCalledTimes(2);
        pending.resolve();await flush();
        expect(f.session.status()).toMatchObject({errors:0,completed:1,pending:false});f.session.dispose();
    });
    it('重试排在已经运行的另一页之后，不并发抢占；暂停后不会复活迟到结果',async()=>{
        const f=sessionFixture();f.ports.failed.mockReturnValue(true);f.start();await flush();
        const other=deferred();f.ports.translate.mockReturnValueOnce(other.promise);f.ports.failed.mockReturnValue(false);
        f.snapshot.pages[0].retain=true;f.snapshot.pages[0].visible=false;f.snapshot.pages[1].visible=true;
        f.session.refresh(f.snapshot);await flush();
        f.snapshot.pages[0].visible=true;f.session.refresh(f.snapshot);
        expect(f.session.retry(f.one)).toBe(true);await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        const retry=deferred();f.ports.translate.mockReturnValueOnce(retry.promise);
        other.resolve();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([f.one,f.two,f.one]);
        expect(f.session.status()).toMatchObject({pending:true,errors:0});f.session.toggle();retry.resolve();await flush();
        expect(f.session.status()).toMatchObject({active:false,pending:false,completed:1});f.session.dispose();
    });
    it('未开启、隐藏、仅附近保留、已离开窗口和卸载的页面不能绕过会话重试',async()=>{
        const f=sessionFixture();expect(f.session.retry(f.one)).toBe(false);
        f.snapshot.pages[1].retain=true;const pending=deferred();f.ports.translate.mockReturnValueOnce(pending.promise);f.start();await flush();
        expect(f.session.retry({} as HTMLImageElement)).toBe(false);expect(f.session.retry(f.two)).toBe(false);
        f.snapshot.suspended=true;f.session.refresh(f.snapshot);expect(f.session.retry(f.one)).toBe(false);
        f.snapshot.suspended=false;f.snapshot.pages[0].visible=false;f.session.refresh(f.snapshot);
        expect(f.session.retry(f.one)).toBe(false);f.session.dispose();expect(f.session.retry(f.one)).toBe(false);
        pending.resolve();await flush();
    });
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
    it('附近在途页不取消、不重做，完成后保留；离开保留窗口与真实移除仍及时释放', async () => {
        const f=sessionFixture(),pending=deferred();f.ports.translate.mockReturnValueOnce(pending.promise);
        f.start();await flush();f.snapshot.pages[0].visible=false;f.snapshot.pages[0].retain=true;f.snapshot.pages[1].visible=true;
        f.session.refresh(f.snapshot);expect(f.ports.release).not.toHaveBeenCalled();
        expect(f.session.status().prefetching).toBe(true);pending.resolve();await flush();
        expect(f.ports.release).not.toHaveBeenCalled();f.snapshot.pages[0].retain=false;f.session.refresh(f.snapshot);
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
    it.each(['resolve', 'reject'] as const)('重复卸载且旧任务迟到 %s，不重复通知关闭或释放页面', async outcome => {
        const f = sessionFixture();
        let resolve!: () => void, reject!: (reason: Error) => void;
        const pending = new Promise<void>((yes, no) => {resolve = yes;reject = no;});
        f.ports.translate.mockReturnValueOnce(pending);f.start();await flush();
        f.ports.changed.mockClear();f.session.dispose();
        const closed = f.ports.changed.mock.calls.length;
        expect(f.ports.changed.mock.calls.filter(([status]) => !status.available)).toHaveLength(1);
        expect(f.ports.changed).toHaveBeenLastCalledWith(expect.objectContaining({available: false, active: false}));
        expect(f.ports.release).toHaveBeenCalledOnce();
        f.session.dispose();
        if (outcome === 'resolve') resolve(); else reject(new Error('late failure'));
        await flush();
        expect(f.ports.changed).toHaveBeenCalledTimes(closed);
        expect(f.ports.release).toHaveBeenCalledOnce();
        expect(f.ports.translate).toHaveBeenCalledOnce();
    });
    it('页面移除后的拒绝不会计入当前会话', async () => {
        const f = sessionFixture(); let reject!: (error: Error) => void;
        f.ports.translate.mockReturnValueOnce(new Promise<void>((_, no) => {reject = no;}));
        f.start(); await flush(); f.snapshot.pages = []; f.session.refresh(f.snapshot);
        reject(new Error('cancelled')); await flush(); expect(f.session.status().errors).toBe(0);
    });
});

function readerFixture(withIntersection = true, initialUrl = 'https://mangaplus.shueisha.co.jp/viewer/1024050', siteRules?: () => import('@/src/core/config/manga').MangaSiteRule[], prefetchPages?: () => number, warm?: (images:HTMLImageElement[])=>void, canvas?: Parameters<typeof createMangaReader>[0]['canvas'], cachePorts?: Pick<Parameters<typeof createMangaReader>[0], 'resetCache' | 'cachePages' | 'reuse' | 'background' | 'segments' | 'reading'>) {
    const {document, window: dom} = parseHTML('<html><body><div class="zao-image-container"><img class="zao-image" src="blob:page-1"></div><img id="logo" src="https://site/logo.png"></body></html>');
    const image = document.querySelector('img')! as HTMLImageElement;
    Object.defineProperties(image, {complete: {writable: true, value: true}, naturalWidth: {writable: true, value: 800}, naturalHeight: {value: 1200}, currentSrc: {get: () => image.src}});
    let bounds = {left: 0, top: 0, right: 800, bottom: 1200, width: 800, height: 1200};
    image.getBoundingClientRect = () => bounds as DOMRect;
    let style = {visibility: 'visible', display: 'block', opacity:'1'};
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
    const reader = createMangaReader({...ports, siteRules, prefetchPages, warm, canvas, ...cachePorts});
    const run = () => {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(c => c(0));};
    const intersect = (yes: boolean) => {io.callback([{target: image, isIntersecting: yes} as unknown as IntersectionObserverEntry], {} as IntersectionObserver); run();};
    const scroll = () => {events.get('scroll')!();run();};
    return {reader, ports, image, io, mo, window, dom, document, run, intersect, scroll, scrollPending:()=>events.get('scroll')!(),
        setRect: (v: Partial<typeof bounds>) => Object.assign(bounds, v), setStyle: (v: Partial<typeof style>) => Object.assign(style, v),
        setHidden: (v: boolean) => {hidden = v;}};
}
describe('漫画站点适配与 DOM 生命周期', () => {
    it('地址突然不可用时撤销已打开的结果',async()=>{
        const version={},reading={live:()=>true,version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');const invalid=vi.fn();
        f.reader.observeReadingCandidate(list.items[0].token,invalid);f.window.location.href='';f.reader.schedule();
        expect(invalid).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('读取端口暂时没有返回任务时报告不可用，不触发额外翻译',async()=>{
        const reading={live:()=>true,load:vi.fn().mockReturnValue(undefined)},f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});
        f.reader.toggle();await flush();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        const count=f.ports.translate.mock.calls.length;expect(await f.reader.readReadingCandidate(list.items[0].token,new AbortController().signal)).toEqual({status:'unavailable'});
        expect(f.ports.translate).toHaveBeenCalledTimes(count);f.reader.dispose();
    });
    it('观察候选需要可用来源与版本；旧观察者抛错和释放不能影响后续观察或重试',async()=>{
        const version={},reading={live:vi.fn(()=>true),version:vi.fn(()=>version),load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');const token=list.items[0].token;
        expect(f.reader.observeReadingCandidate({},vi.fn())).toBeUndefined();
        reading.live.mockReturnValueOnce(false);expect(f.reader.observeReadingCandidate(token,vi.fn())).toBeUndefined();
        reading.version.mockImplementationOnce(()=>{throw Error('stale version');});expect(f.reader.observeReadingCandidate(token,vi.fn())).toBeUndefined();
        reading.version.mockReturnValueOnce(undefined as never);expect(f.reader.observeReadingCandidate(token,vi.fn())).toBeUndefined();
        const first=vi.fn(()=>{throw Error('broken UI');}),stop=f.reader.observeReadingCandidate(token,first)!;const second=vi.fn(()=>{throw Error('broken UI on retry');});
        expect(f.reader.observeReadingCandidate(token,second)).toBeTypeOf('function');expect(first).toHaveBeenCalledOnce();stop();
        expect(f.reader.retry(f.image)).toBe(true);expect(second).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('来源检查异常与观察者异常不会阻断会话失效和卸载',async()=>{
        const version={},reading={live:vi.fn(()=>true),version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        const invalid=vi.fn(()=>{throw Error('broken observer');});f.reader.observeReadingCandidate(list.items[0].token,invalid);
        reading.live.mockImplementationOnce(()=>{throw Error('detached source');});f.reader.schedule();
        expect(invalid).toHaveBeenCalledOnce();expect(()=>f.reader.dispose()).not.toThrow();
    });
    it('其他布局任务合并或卸载时取消待执行的观察帧',async()=>{
        for(const action of ['schedule','dispose'] as const){
            const version={},reading={live:()=>true,version:()=>version,load:async()=>({status:'empty' as const})};
            const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();f.run();
            const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');f.reader.observeReadingCandidate(list.items[0].token,vi.fn());
            const unrelated=f.document.createElement('div');unrelated.setAttribute('data-fluent-read-ui','');f.document.body.append(unrelated);
            f.mo.callback([{target:unrelated,type:'attributes',attributeName:'style'} as unknown as MutationRecord],{} as MutationObserver);
            if(action==='schedule')f.reader.schedule();else f.reader.dispose();
            expect(f.window.cancelAnimationFrame).toHaveBeenCalled();f.run();f.reader.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();
        }
    });
    it('伪造扩展标记的兄弟层变化会按帧重验已打开快照，重复变化不会重复测量',async()=>{
        let valid=true;const version={},reading={live:vi.fn(()=>valid),version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});
        const overlay=f.document.createElement('aside');overlay.setAttribute('data-fluent-read-ui','');f.document.body.append(overlay);
        f.reader.toggle();await flush();f.run();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        const invalid=vi.fn();f.reader.observeReadingCandidate(list.items[0].token,invalid);reading.live.mockClear();valid=false;
        for(let i=0;i<30;i++)f.mo.callback([{target:overlay,type:'attributes',attributeName:'style'} as unknown as MutationRecord],{} as MutationObserver);
        expect(reading.live).not.toHaveBeenCalled();expect(invalid).not.toHaveBeenCalled();f.run();
        expect(reading.live).toHaveBeenCalledOnce();expect(invalid).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('已选长图片段的宿主图片发生变化时撤销对应阅读快照',async()=>{
        const values=new Map<HTMLImageElement,import('@/src/features/image-translation/content/mangaImageSegments').MangaImageSegment[]>();
        const segments={identity:vi.fn(s=>s.source),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),prepare:vi.fn(()=>values),pixels:vi.fn(()=>1_800_000),bounds:vi.fn(()=>({left:0,top:0,right:800,bottom:600,width:800,height:600}) as DOMRect)};
        let valid=true;const version={},reading={live:()=>valid,version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{segments,reading});
        values.set(f.image,[{image:f.image,top:0,height:600,width:800,contextTop:0,contextHeight:600,source:'one'}]);
        f.reader.schedule();f.run();f.reader.toggle();await flush();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items[0].kind).toBe('segment');const invalid=vi.fn();f.reader.observeReadingCandidate(list.items[0].token,invalid);
        valid=false;f.mo.callback([{target:f.image,type:'attributes',attributeName:'src'} as unknown as MutationRecord],{} as MutationObserver);
        expect(invalid).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it.each(['hide','source'] as const)('伪造扩展标记的宿主祖先 %s 仍立即使已打开快照失效',async change=>{
        let valid=true;const version={},reading={live:vi.fn(()=>valid),version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');const invalid=vi.fn();
        expect(f.reader.observeReadingCandidate(list.items[0].token,invalid)).toBeTypeOf('function');
        const parent=f.image.parentElement!;parent.setAttribute('data-fluent-read-ui','');
        if(change==='hide')parent.setAttribute('hidden','');else f.image.src='blob:changed';valid=false;
        f.mo.callback([{target:change==='hide'?parent:f.image,type:'attributes',attributeName:change==='hide'?'hidden':'src'} as unknown as MutationRecord],{} as MutationObserver);
        expect(invalid).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('已读快照观察独立于候选令牌：轻微滚动保留，换源或版本更新立即通知一次',async()=>{
        let valid=true,version:object={};const reading={live:vi.fn(()=>valid),version:vi.fn(()=>version),load:vi.fn(async()=>({status:'empty' as const}))};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        let list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        const invalid=vi.fn(),stop=f.reader.observeReadingCandidate(list.items[0].token,invalid);expect(stop).toBeTypeOf('function');
        reading.live.mockClear();for(let i=0;i<30;i++)f.scrollPending();expect(reading.live).not.toHaveBeenCalled();
        expect(invalid).not.toHaveBeenCalled();expect(await f.reader.readReadingCandidate(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});
        f.run();expect(reading.live).toHaveBeenCalledOnce();list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');version={};f.scrollPending();f.run();
        expect(invalid).toHaveBeenCalledOnce();f.scrollPending();expect(invalid).toHaveBeenCalledOnce();stop!();
        f.reader.schedule();f.run();list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');const second=vi.fn();
        expect(f.reader.observeReadingCandidate(list.items[0].token,second)).toBeTypeOf('function');valid=false;f.scrollPending();f.run();expect(second).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('观察关闭后不再通知；暂停和卸载会通知活动快照',async()=>{
        const version={},reading={live:()=>true,version:()=>version,load:async()=>({status:'empty' as const})};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});f.reader.toggle();await flush();
        let list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');const invalid=vi.fn();
        const stop=f.reader.observeReadingCandidate(list.items[0].token,invalid)!;stop();f.reader.toggle();expect(invalid).not.toHaveBeenCalled();
        f.reader.toggle();await flush();list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        f.reader.observeReadingCandidate(list.items[0].token,invalid);f.reader.toggle();expect(invalid).toHaveBeenCalledOnce();
        f.reader.toggle();await flush();list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        f.reader.observeReadingCandidate(list.items[0].token,invalid);f.reader.dispose();expect(invalid).toHaveBeenCalledTimes(2);
    });
    it('按需枚举复用已有可见候选，滚动在下一帧前同步撤销旧目标且不额外识别',async()=>{
        const reading={live:vi.fn(()=>true),load:vi.fn(async()=>({status:'empty' as const}))};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading});
        expect(f.reader.readingCandidates()).toEqual({status:'unavailable'});f.reader.toggle();await flush();
        const list=f.reader.readingCandidates();expect(list.status).toBe('ready');if(list.status!=='ready')throw Error('unexpected');
        expect(list.items).toHaveLength(1);expect(list.items[0]).toMatchObject({kind:'image',ordinal:1});
        const before=f.ports.translate.mock.calls.length;expect(reading.load).not.toHaveBeenCalled();
        f.scrollPending();expect(await f.reader.readReadingCandidate(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});
        expect(f.reader.readingCandidates()).toEqual({status:'unavailable'});expect(f.ports.translate).toHaveBeenCalledTimes(before);
        f.reader.dispose();
    });
    it('同时可见的多个页面各有独立 token，暂停与卸载后不能读取',async()=>{
        const reading={live:vi.fn(()=>true),load:vi.fn(async()=>({status:'empty' as const}))};
        const f=readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reading}),second=f.document.createElement('img') as HTMLImageElement;
        second.className='zao-image';second.src='blob:page-2';Object.defineProperties(second,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
        second.getBoundingClientRect=()=>({left:500,right:1200,top:0,bottom:900,width:700,height:900}) as DOMRect;f.image.parentElement!.append(second);
        f.reader.toggle();await flush();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(item=>item.ordinal)).toEqual([1,2]);expect(list.items[0].token).not.toBe(list.items[1].token);
        f.reader.toggle();expect(await f.reader.readReadingCandidate(list.items[1].token,new AbortController().signal)).toEqual({status:'stale'});
        f.reader.dispose();expect(f.reader.readingCandidates()).toEqual({status:'unavailable'});
    });
    it('快速掠过页面不启动识别或预译，在途完成不穿过关闸，停下才处理最终视口', async () => {
        vi.useFakeTimers();let ahead = 0, anchor = 0;
        const f = readerFixture(true,undefined,undefined,() => ahead), images = [f.image], pending = deferred();
        for (let index = 1; index < 4; index++) {
            const image = f.document.createElement('img') as HTMLImageElement;image.className = 'zao-image';image.src = `blob:skip-${index}`;
            Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
            image.getBoundingClientRect = () => ({left:0,right:800,top:(index-anchor)*1300,bottom:(index-anchor)*1300+1200,width:800,height:1200}) as DOMRect;
            f.image.parentElement!.append(image);images.push(image);
        }
        f.image.getBoundingClientRect = () => ({left:0,right:800,top:-anchor*1300,bottom:-anchor*1300+1200,width:800,height:1200}) as DOMRect;
        f.ports.translate.mockReturnValueOnce(pending.promise);f.reader.toggle();await flush();ahead = 1;
        anchor = 1;f.scroll();pending.resolve();await flush();
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([images[0]]);
        vi.advanceTimersByTime(120);anchor = 2;f.scroll();f.io.callback([],{} as IntersectionObserver);f.run();await flush();
        vi.advanceTimersByTime(179);f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);f.run();await flush();
        expect(f.ports.translate.mock.calls.map(c => c[0])).toEqual([images[0],images[2],images[3]]);
        expect(f.reader.status()).toMatchObject({completed:3,ahead:1});f.reader.dispose();
    });
    it('IO 翻页也需停留；已有位图进入视口立即复用，不等停留或另一页 OCR', async () => {
        vi.useFakeTimers();let anchor = 0;
        const reuse = vi.fn().mockReturnValue(false), f = readerFixture(true,undefined,undefined,undefined,undefined,undefined,{reuse});
        const next = f.document.createElement('img') as HTMLImageElement;next.className = 'zao-image';next.src = 'blob:cached-next';
        Object.defineProperties(next,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
        next.getBoundingClientRect = () => ({left:0,right:800,top:(1-anchor)*1300,bottom:(1-anchor)*1300+1200,width:800,height:1200}) as DOMRect;
        f.image.getBoundingClientRect = () => ({left:0,right:800,top:-anchor*1300,bottom:-anchor*1300+1200,width:800,height:1200}) as DOMRect;
        f.image.parentElement!.append(next);f.reader.toggle();await flush();
        anchor = 1;f.io.callback([],{} as IntersectionObserver);f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);
        reuse.mockImplementation(image => image === next);f.io.callback([],{} as IntersectionObserver);f.run();
        expect(reuse).toHaveBeenCalledWith(next);expect(f.reader.status().completed).toBe(2);
        vi.advanceTimersByTime(180);f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);f.reader.dispose();
    });
    it('普通图片的持续滚动复用 IO 通知，不逐帧遍历正文；停留测量不被无关样式变更延后', async () => {
        vi.useFakeTimers();const f = readerFixture(), bounds = vi.fn(f.image.getBoundingClientRect);
        f.image.getBoundingClientRect = bounds;f.reader.toggle();await flush();bounds.mockClear();
        f.scroll();const first = bounds.mock.calls.length;expect(first).toBeGreaterThan(0);
        for (let index = 0; index < 5; index++) f.scroll();
        expect(bounds).toHaveBeenCalledTimes(first);
        expect(f.window.addEventListener).toHaveBeenCalledWith('scroll',expect.any(Function),true);
        vi.advanceTimersByTime(120);
        f.mo.callback([{target:f.image.parentElement,type:'attributes',attributeName:'style'} as unknown as MutationRecord],{} as MutationObserver);f.run();
        bounds.mockClear();vi.advanceTimersByTime(59);f.run();expect(bounds).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);f.run();expect(bounds).toHaveBeenCalled();f.reader.dispose();
    });
    it('没有 IO 时仍随滚动更新位置，单页重试和重新开启绕过停留，卸载清理停留计时器', async () => {
        vi.useFakeTimers();const f = readerFixture(false), bounds = vi.fn(f.image.getBoundingClientRect);
        f.image.getBoundingClientRect = bounds;f.ports.failed.mockReturnValue(true);f.reader.toggle();await flush();
        f.scroll();bounds.mockClear();f.scroll();expect(bounds).toHaveBeenCalled();
        f.ports.failed.mockReturnValue(false);expect(f.reader.retry(f.image)).toBe(true);await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
        f.scroll();f.reader.toggle();f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);f.scroll();expect(vi.getTimerCount()).toBe(1);
        f.reader.dispose();bounds.mockClear();vi.advanceTimersByTime(200);f.run();
        expect(vi.getTimerCount()).toBe(0);expect(bounds).not.toHaveBeenCalled();f.scroll();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('后台隐藏时取消停留并停止新页请求，回到页面才恢复最终视口', async () => {
        vi.useFakeTimers();const f = readerFixture();f.reader.toggle();await flush();
        f.image.src = 'blob:after-scroll';f.scroll();expect(vi.getTimerCount()).toBe(1);
        f.setHidden(true);f.document.dispatchEvent(new f.dom.Event('visibilitychange'));f.run();
        expect(vi.getTimerCount()).toBe(0);vi.advanceTimersByTime(200);f.run();await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.setHidden(false);f.document.dispatchEvent(new f.dom.Event('visibilitychange'));f.run();await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);f.reader.dispose();
    });
    it.each(['chapter', 'query'])('Hentaizap 逐页替换保留阅读，%s 变化结束旧章并释放缓存', async change => {
        const resetCache = vi.fn(), reuse = vi.fn().mockReturnValue(false);
        const f = readerFixture(false, 'https://hentaizap.com/g/1655925/1', undefined, undefined, undefined, undefined, {resetCache, reuse});
        const root = f.document.createElement('main');root.id = 'readerApp';root.innerHTML = '<div id="readerAnchor" class="reader_img"></div>';
        f.image.id = 'readerImg';root.firstElementChild!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, pageCount: 1});f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();resetCache.mockClear();
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();reuse.mockReturnValue(false);
        f.image.src = 'blob:page-two';f.window.location.href = 'https://hentaizap.com/g/1655925/2/';f.document.dispatchEvent(new f.dom.Event('fluentread-route-change'));f.run();await flush();
        expect(f.reader.status().active).toBe(true);expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(resetCache).not.toHaveBeenCalled();
        f.window.location.href = change === 'chapter' ? 'https://hentaizap.com/g/1655926/1' : 'https://hentaizap.com/g/1655925/2?chapter=other';f.reader.schedule();f.run();
        expect(f.reader.status().active).toBe(false);expect(resetCache).toHaveBeenCalledOnce();root.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it.each([
        ['yaoimangaonline.com', '<article class="herald-single"><div class="entry-content herald-entry-content"><p></p></div></article>', 'p', 'alignnone wp-image-123'],
        ['nhentaiyaoi.net', '<div class="post-box listaImagens"><ul class="post-fotos"><li><a></a></li></ul></div>', 'a', ''],
    ])('%s 单帖正文加入、懒加载换源、暂停与换帖清理', async (host, html, parent, imageClass) => {
        const resetCache = vi.fn(), f = readerFixture(false, `https://${host}/public-post`, undefined, undefined, undefined, undefined, {resetCache});
        f.document.body.className = 'single-post';expect(f.reader.status().available).toBe(false);
        const root = f.document.createElement('div');root.innerHTML = html;f.image.className = imageClass;root.querySelector(parent)!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, pageCount: 1});f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.image.src = 'blob:lazy-loaded-body';f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);
        f.window.location.href = `https://${host}/another-post`;f.reader.schedule();f.run();expect(f.reader.status().active).toBe(false);expect(resetCache).toHaveBeenCalled();
        root.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);expect(f.ports.release).toHaveBeenCalledWith(f.image);f.reader.dispose();
    });
    it.each(['chapter', 'slug', 'query'])('GANMA 路径页码续译，暂停复用与 %s 身份变化清理保持独立', async change => {
        const chapter = '/web/reader/chiharasan/a64d24f0-c9d6-11eb-ba7d-2e06529e3f5f';
        const resetCache = vi.fn(), reuse = vi.fn().mockReturnValue(false);
        const f = readerFixture(false, `https://ganma.jp${chapter}/0`, undefined, undefined, undefined, undefined, {resetCache, reuse});
        const root = f.document.createElement('div');root.className = 'h-full-container w-full-container';root.innerHTML = '<div class="flex select-none"><div class="relative flex-1"></div></div>';
        const parent = root.querySelector('.relative')!;f.image.className = 'pointer-events-none object-contain';f.image.alt = '1ページ目の原稿画像';parent.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);resetCache.mockClear();
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();reuse.mockReturnValue(false);
        f.image.src = 'blob:page-5';f.image.alt = '5ページ目の原稿画像';f.window.location.href = `https://ganma.jp${chapter}/4/`;
        f.document.dispatchEvent(new f.dom.Event('fluentread-route-change'));f.run();await flush();
        expect(f.reader.status().active).toBe(true);expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(resetCache).not.toHaveBeenCalled();
        const next = change === 'chapter' ? chapter.replace('a64d24f0', 'fe704630') : change === 'slug' ? chapter.replace('chiharasan', 'other') : chapter;
        f.window.location.href = `https://ganma.jp${next}/4${change === 'query' ? '?chapter=2' : ''}`;f.reader.schedule();f.run();
        expect(f.reader.status().active).toBe(false);expect(resetCache).toHaveBeenCalledOnce();
        root.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it('Novelpia 已展示的受限图片只提供圈选，不请求识别，移除与关闭清理', () => {
        const f = readerFixture(false, 'https://novelpia.com/comic_viewer/18735');
        expect(f.reader.status().available).toBe(false);
        const root = f.document.createElement('div');root.id = 'viewer_wrap';root.innerHTML = '<div class="viewer_content"><div><div class="viewer_content_box"><div class="comic-content"></div></div></div></div>';
        root.querySelector('.comic-content')!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, areaFallback: true, pageCount: 0});expect(f.reader.toggle()).toBe(false);
        expect(f.ports.translate).not.toHaveBeenCalled();f.image.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);
        root.querySelector('.comic-content')!.append(f.image);f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it.each(['image', 'canvas'])('TOPTOON 可见 %s 正文只发布圈选，移除和关闭清理，不读取像素', kind => {
        const f = readerFixture(false, 'https://toptoon.com/comic/ep_view/Legendary_Hunter/1/rent');
        expect(f.reader.status().available).toBe(false);
        const root = f.document.createElement('div');root.id = 'viewerContentsWrap';root.innerHTML = '<div class="comic_img"><div class="canvas-wrapper document_img"></div></div>';
        const body = kind === 'image' ? f.image : f.document.createElement('canvas');body.className = 'document_img';body.getBoundingClientRect = f.image.getBoundingClientRect;
        const readPixels = vi.fn();if (kind === 'canvas') (body as HTMLCanvasElement).getContext = readPixels;
        root.querySelector(kind === 'image' ? '.comic_img' : '.canvas-wrapper')!.append(body);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, areaFallback: true, pageCount: 0});expect(f.reader.toggle()).toBe(false);
        expect(readPixels).not.toHaveBeenCalled();expect(f.ports.translate).not.toHaveBeenCalled();
        body.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);
        root.querySelector('.canvas-wrapper')!.append(body);f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it.each(['repaint','pause','chapter','removed','zero-width','zero-height','outside','hidden','invisible','transparent','disabled'])('哔哩哔哩同章加载等待 %s：首次加载不发入口，旧页取消，新页仍按用户意图调度',async mode=>{
        const canvasPorts={identity:vi.fn<() => string | null>().mockReturnValue(null),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn().mockReturnValue(false),restore:vi.fn(),release:vi.fn(),failed:vi.fn().mockReturnValue(false),update:vi.fn()};
        const f=readerFixture(false,'https://manga.bilibili.com/mc30124/595886',undefined,undefined,undefined,canvasPorts);
        const root=f.document.createElement('div');root.className='images-container';root.innerHTML='<div class="view-container"><div class="image-container"><canvas></canvas></div><div class="loading-hinter"></div></div>';
        const canvas=root.querySelector('canvas')!,loading=root.querySelector('.loading-hinter')!;
        const bounds={left:90,top:0,right:633,bottom:816,width:543,height:816};canvas.width=1099;canvas.height=1649;canvas.getBoundingClientRect=()=>bounds as DOMRect;loading.getBoundingClientRect=()=>bounds as DOMRect;
        f.document.body.append(root);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,active:false});
        canvasPorts.identity.mockReturnValue('ready-1');f.reader.schedule();f.run();f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();
        canvasPorts.identity.mockReturnValue(null);f.reader.schedule();f.run();await flush();expect(f.reader.status()).toMatchObject({available:true,active:true,pageCount:0});expect(canvasPorts.release).toHaveBeenCalledWith(canvas);expect(canvasPorts.translate).toHaveBeenCalledOnce();
        if(mode==='repaint'){canvasPorts.identity.mockReturnValue('ready-2');f.reader.schedule();f.run();await flush();expect(f.reader.status()).toMatchObject({available:true,active:true,pageCount:1});expect(canvasPorts.translate).toHaveBeenCalledTimes(2);}
        if(mode==='pause')f.reader.toggle();
        if(mode==='chapter')f.window.location.href='https://manga.bilibili.com/mc30124/999999';
        if(mode==='removed')loading.remove();
        if(mode==='zero-width')bounds.width=0;
        if(mode==='zero-height')bounds.height=0;
        if(mode==='outside'){bounds.left=1300;bounds.right=1843;}
        if(mode==='hidden')f.setStyle({display:'none'});
        if(mode==='invisible')f.setStyle({visibility:'hidden'});
        if(mode==='transparent')f.setStyle({opacity:'0'});
        if(mode==='disabled')f.ports.enabled.mockReturnValue(false);
        if(mode!=='repaint'){f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,active:false});expect(canvasPorts.translate).toHaveBeenCalledOnce();}
        root.remove();f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,active:false});f.reader.dispose();
    });
    it.each([
        ['https://ranfren.neocities.org/lucid/lucid2/need1','https://ranfren.neocities.org/lucid/lucid22/lucid22thattimei','<center></center>','center','https://ranfren.neocities.org/lucid/lucid2/lucid2-1.jpg'],
        ['https://www.manhuazhan.com/chapter/235990-51809.html','https://www.manhuazhan.com/chapter/235990-51810.html','<div id="ChapterContent"><p class="chapterpic"></p></div>','p','blob:body'],
        ['https://poipiku.com/2/13202427.html','https://poipiku.com/2/13202425.html','<section id="IllustItemList"><div class="IllustItem"><a class="IllustItemThumb"></a></div></section>','a','blob:body'],
    ])('%s 正文动态加入，暂停复用，换章清理；来源消失后移除入口',async(href,nextHref,html,parent,source)=>{
        const resetCache=vi.fn(),f=readerFixture(false,href,undefined,undefined,undefined,undefined,{resetCache});expect(f.reader.status().available).toBe(false);
        const root=f.document.createElement('div');root.innerHTML=html;f.image.className='lazy IllustItemThumbImg';f.image.src=source;root.querySelector(parent)!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available:true,pageCount:1,areaFallback:false});f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);f.reader.toggle();await flush();
        f.window.location.href=nextHref;f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({active:false,available:true});expect(resetCache).toHaveBeenCalled();
        root.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);expect(f.ports.release).toHaveBeenCalledWith(f.image);f.reader.dispose();
    });
    it('哔哩哔哩正文动态加入后串行识别，暂停复用，原画布重绘失效后重新处理并清理',async()=>{
        const canvasPorts={identity:vi.fn().mockReturnValue('spread-1'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn().mockReturnValue(false),restore:vi.fn(),release:vi.fn(),failed:vi.fn().mockReturnValue(false),update:vi.fn()};
        const f=readerFixture(false,'https://manga.bilibili.com/mc30124/595886',undefined,undefined,undefined,canvasPorts);expect(f.reader.status().available).toBe(false);
        const root=f.document.createElement('div');root.className='images-container';root.innerHTML='<div class="view-container"><div class="image-container"></div></div>';
        const canvas=f.document.createElement('canvas');canvas.width=1099;canvas.height=1649;
        canvas.getBoundingClientRect=()=>({left:93,top:0,right:636,bottom:816,width:543,height:816}) as DOMRect;root.querySelector('.image-container')!.append(canvas);f.document.body.append(root);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available:true,areaFallback:false,pageCount:1});f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledWith(canvas);
        f.reader.toggle();expect(canvasPorts.restore).toHaveBeenCalledWith(canvas);canvasPorts.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();
        canvasPorts.identity.mockReturnValue('spread-2');canvasPorts.reuse.mockReturnValue(false);f.reader.schedule();f.run();await flush();expect(canvasPorts.release).toHaveBeenCalledWith(canvas);expect(canvasPorts.translate).toHaveBeenCalledTimes(2);
        root.remove();f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,areaFallback:false});expect(canvasPorts.release).toHaveBeenCalledWith(canvas);f.reader.dispose();
    });
    it('PASH UP 当前屏动态加载后调度画布，暂停恢复和移除清理不处理缓冲屏', async () => {
        const canvasPorts = {identity: vi.fn().mockReturnValue('current-page'), translate: vi.fn().mockResolvedValue(undefined), reuse: vi.fn().mockReturnValue(false), restore: vi.fn(), release: vi.fn(), failed: vi.fn().mockReturnValue(false), update: vi.fn()};
        const f = readerFixture(false, 'https://pash-up.jp/viewer/viewer.html?cid=public-chapter', undefined, undefined, undefined, canvasPorts);
        expect(f.reader.status().available).toBe(false);
        const viewer = f.document.createElement('div');viewer.id = 'viewer';viewer.innerHTML = '<div id="renderer"><div id="viewport0"></div><div id="viewport1" class="currentScreen"></div></div>';
        for (const id of ['viewport0', 'viewport1']) {const canvas = f.document.createElement('canvas');canvas.width = 2544;canvas.height = 1632;canvas.getBoundingClientRect = () => ({left: 0, right: 1272, top: 0, bottom: 816, width: 1272, height: 816}) as DOMRect;viewer.querySelector(`#${id}`)!.append(canvas);}
        f.document.body.append(viewer);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available: true, pageCount: 1, areaFallback: false});
        const body = viewer.querySelector('#viewport1 canvas')!;f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();expect(canvasPorts.translate).toHaveBeenCalledWith(body);
        f.reader.toggle();expect(canvasPorts.restore).toHaveBeenCalledWith(body);canvasPorts.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();
        viewer.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);expect(canvasPorts.release).toHaveBeenCalledWith(body);f.reader.dispose();
    });
    it.each(['https://ctccomic.com/', 'https://www.ctccomic.com/comic/000'])('Countdown %s 正文加载后可连续翻译，主页标识不发布漫画入口', async href => {
        const f = readerFixture(false, href);expect(f.reader.status().available).toBe(false);
        const root = f.document.createElement('div');root.id = 'cc-comicbody';const link = f.document.createElement('a');f.image.id = 'cc-comic';link.append(f.image);root.append(link);f.document.body.append(root);
        f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available: true, pageCount: 1});
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);
        f.image.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it.each([
        ['https://mangamillion.shueisha.co.jp/zh-CN/title/1/chapter/66193', '<div class="eAvsta_slide_container"><div class="-KWKsa_spread"><div class="_b9ZNa_page_container"><div class="__wfZG_placeholder"></div></div></div></div>', 'div.__wfZG_placeholder'],
        ['https://www.orchisasia.org/comic/story/0001-chapter-1', '<div class="read-container"><div class="reading-content"><div class="page-break"></div></div></div>', '.page-break'],
        ['https://qimanga.com/series/the-otherworld-general-store/chapter-1', '<app-reader><div class="r-strip"><div class="r-page" data-page="1"></div></div></app-reader>', '.r-page'],
        ['https://nyxscans.com/series/press-play-sami/chapter-96', '<div class="comic-body-container"><div class="comic-images-wrapper"><figure class="image-container"></figure></div></div>', 'figure'],
        ['https://omegascans.org/series/little-miss-delinquent/chapter-53', '<div class="lg:container"><div class="flex flex-col items-center justify-center overflow-hidden"><div class="relative flex w-full justify-center"></div></div></div>', 'div.relative'],
    ])('%s 动态正文加入同一会话，暂停恢复，移除与换章清理', async (href, html, parentSelector) => {
        const f = readerFixture(false, href);expect(f.reader.status().available).toBe(false);
        const root = f.document.createElement('section');root.innerHTML = html;f.document.body.append(root);
        root.querySelector(parentSelector)!.append(f.image);f.image.className = 'r-page-img wp-manga-chapter-img block object-contain G54Y0W_page';f.image.alt = 'page_0';f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, pageCount: 1, areaFallback: false});
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);f.reader.toggle();await flush();
        f.image.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);expect(f.ports.release).toHaveBeenCalledWith(f.image);
        f.window.location.href = href.replace(/chapter-\d+$/, 'chapter-97');f.reader.schedule();f.run();expect(f.reader.status().active).toBe(false);f.reader.dispose();
    });
    it('MangaLove 不可读正文只提供圈选，像素读取和连续图片请求不启动', () => {
        const f = readerFixture(false, 'https://mangalove.me/viewer/79762');expect(f.reader.status().available).toBe(false);
        f.document.body.id = 'viewerBody';
        const viewer = f.document.createElement('div'), wrap = f.document.createElement('div');viewer.className = 'viewer vertical';wrap.className = 'imgWrap';
        const canvas = f.document.createElement('canvas');canvas.width = 760;canvas.height = 1100;
        canvas.getBoundingClientRect = () => ({left: 0, right: 600, top: 0, bottom: 850, width: 600, height: 850}) as DOMRect;
        const readPixels = vi.fn();canvas.getContext = readPixels;wrap.append(canvas);viewer.append(wrap);f.document.body.append(viewer);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available: true, areaFallback: true, pageCount: 0});expect(f.reader.toggle()).toBe(false);
        expect(readPixels).not.toHaveBeenCalled();expect(f.ports.translate).not.toHaveBeenCalled();
        canvas.remove();f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available: false, areaFallback: false});f.reader.dispose();
    });
    it('MangaLib 原站 p 页码更新继续同章并识别新页，换章后结束会话和清缓存', async () => {
        const resetCache = vi.fn(), f = readerFixture(false, 'https://mangalib.me/ru/3172--kakegurui/read/v22/c129?p=1&bid=1', undefined, undefined, undefined, undefined, {resetCache});
        const root=f.document.createElement('div');root.innerHTML='<div data-reader-mode="horizontal"><main data-reader-info-visible="false"><div><div data-page="1"></div></div></main></div>';
        root.querySelector('[data-page]')!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();f.reader.toggle();await flush();resetCache.mockClear();
        const next=f.image.cloneNode() as HTMLImageElement;next.src='https://cdn.example.com/mangalib-page-2.jpg';
        Object.defineProperties(next,{complete:{value:true},naturalWidth:{value:1337},naturalHeight:{value:1920}});
        next.getBoundingClientRect=()=>({left:0,right:800,top:0,bottom:1200,width:800,height:1200}) as DOMRect;
        const holder=f.document.createElement('div');holder.setAttribute('data-page','2');holder.append(next);root.querySelector('main > div')!.append(holder);
        f.setRect({top:-3000,bottom:-1800});f.window.location.href='https://mangalib.me/ru/3172--kakegurui/read/v22/c129?p=2&bid=1';f.document.dispatchEvent(new f.dom.Event('fluentread-route-change'));f.run();await flush();
        expect(f.reader.status().active).toBe(true);expect(f.ports.translate).toHaveBeenCalledWith(next);expect(resetCache).not.toHaveBeenCalled();
        f.reader.toggle();expect(f.reader.status().active).toBe(false);expect(f.ports.restore).toHaveBeenCalledWith(next);f.reader.toggle();await flush();expect(f.reader.status().active).toBe(true);
        f.window.location.href='https://mangalib.me/ru/3172--kakegurui/read/v22/c130?p=2&bid=1';f.reader.schedule();f.run();expect(f.reader.status().active).toBe(false);expect(resetCache).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it.each(['?p=0&bid=1','?p=01&bid=1','?p=abc&bid=1','?p=10000&bid=1','?p=2&p=3&bid=1','?p=2&bid=2'])('MangaLib 异常页码或译组身份变化 %s 清理旧会话', async search => {
        const f=readerFixture(false,'https://mangalib.me/ru/3172--kakegurui/read/v22/c129?p=1&bid=1');
        const root=f.document.createElement('div');root.innerHTML='<div data-reader-mode="vertical"><main data-reader-info-visible="false"><div><div data-page="1"></div></div></main></div>';root.querySelector('[data-page]')!.append(f.image);f.document.body.append(root);f.reader.schedule();f.run();f.reader.toggle();await flush();
        f.window.location.href=`https://mangalib.me/ru/3172--kakegurui/read/v22/c129${search}`;f.reader.schedule();f.run();expect(f.reader.status().active).toBe(false);f.reader.dispose();
    });
    it('Mangahub 正常页码变化继续同一会话，下一正文入队；章节路径改变才暂停和清缓存', async () => {
        const resetCache = vi.fn();
        const f = readerFixture(false, 'https://mangahub.ru/read/962303?page=1', undefined, undefined, undefined, undefined, {resetCache});
        const root = f.document.createElement('reader-viewer'), scan = f.document.createElement('reader-scan');scan.className = 'reader-viewer-scan';
        f.image.className = 'reader-viewer-img';scan.append(f.image);root.append(scan);f.document.body.append(root);f.reader.schedule();f.run();
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);resetCache.mockClear();
        const next = f.image.cloneNode() as HTMLImageElement;next.src = 'https://cdn.example.com/next.jpg';
        Object.defineProperties(next, {complete: {value: true}, naturalWidth: {value: 760}, naturalHeight: {value: 1200}});
        next.getBoundingClientRect = () => ({left: 0, right: 760, top: 0, bottom: 1200, width: 760, height: 1200}) as DOMRect;
        const nextScan = f.document.createElement('reader-scan');nextScan.className = 'reader-viewer-scan';nextScan.append(next);root.append(nextScan);
        f.setRect({top: -3000, bottom: -1800});f.window.location.href = 'https://mangahub.ru/read/962303?page=2';
        f.document.dispatchEvent(new f.dom.Event('fluentread-route-change'));f.run();await flush();
        expect(f.reader.status().active).toBe(true);expect(f.ports.translate).toHaveBeenCalledWith(next);expect(resetCache).not.toHaveBeenCalled();
        f.window.location.href = 'https://mangahub.ru/read/962304?page=2';f.reader.schedule();f.run();
        expect(f.reader.status().active).toBe(false);expect(resetCache).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it.each(['?page=0', '?page=abc', '?page=10000', '?page=2&page=3', '?page=2&chapter=8'])('Mangahub 非法页码或其他章节参数 %s 仍使旧会话失效', async search => {
        const f = readerFixture(false, 'https://mangahub.ru/read/962303?page=1');
        const root = f.document.createElement('reader-viewer'), scan = f.document.createElement('reader-scan');scan.className = 'reader-viewer-scan';
        f.image.className = 'reader-viewer-img';scan.append(f.image);root.append(scan);f.document.body.append(root);f.reader.schedule();f.run();f.reader.toggle();await flush();
        f.window.location.href = `https://mangahub.ru/read/962303${search}`;f.reader.schedule();f.run();expect(f.reader.status().active).toBe(false);f.reader.dispose();
    });
    it('GlobalComix 受限正文只发布圈选入口，封面、移除和总开关不启动图片请求',()=>{
        const f=readerFixture(false,'https://globalcomix.com/read/be3701bf-70cc-43e8-b16d-3f168abaf799/1/1');
        expect(f.reader.status()).toMatchObject({available:false,areaFallback:false});
        const root=f.document.createElement('div');root.id='readerReleasePages';const horizontal=f.document.createElement('div');horizontal.id='horizontalReader';
        horizontal.append(f.image);root.append(horizontal);f.document.body.append(root);f.image.className='chakra-image';f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available:true,areaFallback:true,pageCount:0});expect(f.reader.toggle()).toBe(false);expect(f.ports.translate).not.toHaveBeenCalled();
        f.image.remove();f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,areaFallback:false});
        horizontal.append(f.image);f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it('长图分段与普通图片共用可见优先串行队列，暂停、失败重试和清理不走整图 OCR',async()=>{
        const values=new Map<HTMLImageElement,import('@/src/features/image-translation/content/mangaImageSegments').MangaImageSegment[]>(),warm=vi.fn();
        const segments={identity:vi.fn(s=>s.source),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),prepare:vi.fn(()=>values),pixels:vi.fn(()=>1_800_000),bounds:vi.fn(s=>({left:0,top:s.top,right:800,bottom:s.top+600,width:800,height:600}) as DOMRect)};
        let ahead=1;const f=readerFixture(true,undefined,undefined,()=>ahead,warm,undefined,{segments});
        const first={image:f.image,top:0,height:600,width:800,contextTop:0,contextHeight:600,source:'one'},second={...first,top:1200,source:'two'};
        values.set(f.image,[first,second]);f.reader.schedule();f.run();
        const pending=deferred();segments.translate.mockReturnValueOnce(pending.promise);f.reader.toggle();await flush();
        expect(segments.translate.mock.calls.map(c=>c[0])).toEqual([first]);expect(f.ports.translate).not.toHaveBeenCalled();expect(warm).toHaveBeenLastCalledWith([]);
        pending.resolve();await flush();expect(segments.translate.mock.calls.map(c=>c[0])).toEqual([first,second]);
        ahead=0;f.reader.toggle();expect(segments.restore).toHaveBeenCalledWith(first);segments.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(segments.translate).toHaveBeenCalledTimes(2);
        segments.failed.mockReturnValue(true);f.reader.retry(first);await flush();expect(f.reader.status().errors).toBe(1);
        segments.identity.mockReturnValue(null);f.reader.schedule();f.run();expect(segments.release).toHaveBeenCalledWith(first);
        values.clear();f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(segments.prepare).toHaveBeenLastCalledWith([]);
        f.reader.dispose();expect(segments.prepare).toHaveBeenLastCalledWith([]);expect(segments.update).toHaveBeenCalled();
    });
    it('背景正文加入同一串行会话，CSS 换页、暂停复用、失败重试和关闭都清理所有权',async()=>{
        const background={identity:vi.fn().mockReturnValue('bg-1'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn().mockReturnValue(false),restore:vi.fn(),release:vi.fn(),failed:vi.fn().mockReturnValue(false),update:vi.fn(),prepare:vi.fn(),pixels:vi.fn(()=>713*1024),bounds:vi.fn((element:HTMLElement)=>element.getBoundingClientRect())};
        const warm=vi.fn(),f=readerFixture(true,'https://palcy.jp/comics/554',undefined,()=>0,warm,undefined,{background});
        const page=f.document.createElement('div') as HTMLElement;page.id='page-1';page.style.backgroundImage='url(blob:https://palcy.jp/one)';
        page.getBoundingClientRect=()=>({left:14,top:0,right:640,bottom:900,width:626,height:900}) as DOMRect;f.document.body.append(page);
        const own=page.cloneNode() as HTMLElement;own.setAttribute('data-fluent-read-ui','probe');f.document.body.append(own);
        f.reader.schedule();f.run();expect(background.prepare).toHaveBeenLastCalledWith([page]);expect(f.reader.status()).toMatchObject({pageCount:1,areaFallback:false});
        f.reader.toggle();await flush();expect(background.translate).toHaveBeenCalledWith(page);expect(f.ports.translate).not.toHaveBeenCalled();expect(warm).toHaveBeenLastCalledWith([]);
        f.reader.toggle();expect(background.restore).toHaveBeenCalledWith(page);background.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(background.translate).toHaveBeenCalledOnce();
        background.failed.mockReturnValue(true);f.reader.retry(page);await flush();expect(f.reader.status().errors).toBe(1);background.failed.mockReturnValue(false);
        background.identity.mockReturnValue('bg-2');page.style.backgroundImage='url(blob:https://palcy.jp/two)';
        f.mo.callback([{type:'attributes',attributeName:'style',target:page} as unknown as MutationRecord],{} as MutationObserver);f.run();await flush();expect(background.release).toHaveBeenCalledWith(page);
        background.identity.mockReturnValue(null);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({pageCount:0,areaFallback:true});
        page.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);
        f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(background.prepare).toHaveBeenLastCalledWith([]);f.reader.dispose();expect(background.prepare).toHaveBeenLastCalledWith([]);
    });
    it.each([{display:'none'},{visibility:'hidden'},{visibility:'collapse'},{}])('背景正文就绪判断尊重 CSS 可见性 %j',async style=>{
        const background={identity:vi.fn(()=> 'bg'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),prepare:vi.fn(),pixels:vi.fn(()=>1),bounds:vi.fn(()=>({left:0,top:0,right:640,bottom:900,width:640,height:900}) as DOMRect)};
        const f=readerFixture(false,'https://comic.pixiv.net/viewer/stories/249534',undefined,undefined,undefined,undefined,{background});
        const page=f.document.createElement('div');page.id='page-2';page.style.backgroundImage='url(blob:page)';f.document.body.append(page);f.setStyle(style);f.reader.schedule();f.run();
        expect(background.prepare).toHaveBeenLastCalledWith([page]);
        expect(f.reader.status()).toMatchObject({available:true,active:false,pageCount:1,areaFallback:false,completed:0});
        expect(f.reader.toggle()).toBe(true);await flush();
        const visible=Object.keys(style).length===0;
        if(visible)expect(background.translate.mock.calls.map(([element])=>element)).toEqual([page]);
        else expect(background.translate).not.toHaveBeenCalled();
        expect(f.ports.translate).not.toHaveBeenCalled();
        expect(f.reader.status()).toMatchObject({active:true,pending:false,errors:0,completed:visible?1:0});
        f.reader.dispose();
        expect(background.prepare).toHaveBeenLastCalledWith([]);
        expect(f.reader.status()).toMatchObject({available:false,active:false,pending:false,pageCount:0,completed:0});
        if(visible)expect(background.release.mock.calls.map(([element])=>element)).toEqual([page]);
        else expect(background.release).not.toHaveBeenCalled();
    });
    it('无背景处理端口时仅提供正文圈选，尺寸不足不启动正文翻译',()=>{
        const f=readerFixture(false,'https://palcy.jp/comics/554');const page=f.document.createElement('div');page.id='page-1';page.style.backgroundImage='url(blob:page)';
        page.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:900,width:640,height:900}) as DOMRect;f.document.body.append(page);f.reader.schedule();f.run();expect(f.reader.status().areaFallback).toBe(true);f.reader.dispose();
    });
    it.each([
        'https://rimacomiplus.jp/digitalmargaret/episodes/4a895d1d5884a',
        'https://heros-web.com/episodes/a806742880560',
        'https://younganimal.com/episodes/ff98f6eba590d',
        'https://youngchampion.jp/episodes/c35433f99f53d',
    ])('新增 Comici 实页等待正文画布，复用暂停结果且不调度宣传封面 %s', async href => {
        const canvasPorts={identity:vi.fn().mockReturnValue('page-1'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn().mockReturnValue(false),restore:vi.fn(),release:vi.fn(),failed:vi.fn().mockReturnValue(false),update:vi.fn()};
        const f=readerFixture(false,href,undefined,undefined,undefined,canvasPorts);
        expect(f.reader.status().available).toBe(false);
        const container=f.document.createElement('div');container.id='comici-viewer';container.innerHTML='<div class="-cv-page-canvas"></div>';f.document.body.append(container);
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.width=844;canvas.height=1200;
        canvas.getBoundingClientRect=()=>({left:0,right:563,top:0,bottom:800,width:563,height:800}) as DOMRect;
        container.firstElementChild!.append(canvas);f.reader.schedule();f.run();
        expect(f.reader.status()).toMatchObject({available:true,pageCount:1,areaFallback:false});f.reader.toggle();await flush();
        expect(canvasPorts.translate).toHaveBeenCalledWith(canvas);expect(f.ports.translate).not.toHaveBeenCalled();
        f.reader.toggle();expect(canvasPorts.restore).toHaveBeenCalledWith(canvas);
        canvasPorts.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();
        canvasPorts.identity.mockReturnValue(null);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({areaFallback:true,pageCount:0});
        canvas.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it('另页正在识别时同步复用可见缓存页，不把其显示排在识别队列之后', async () => {
        let cached:HTMLImageElement;
        const reuse=vi.fn((image:HTMLImageElement)=>image===cached),pending=deferred();
        const f=readerFixture(false,undefined,undefined,undefined,undefined,undefined,{reuse});
        cached=f.image.cloneNode() as HTMLImageElement;cached.src='blob:cached';
        Object.defineProperties(cached,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
        cached.getBoundingClientRect=()=>({left:800,right:1600,top:0,bottom:1200,width:800,height:1200}) as DOMRect;
        f.image.parentElement!.append(cached);f.ports.translate.mockReturnValueOnce(pending.promise);
        f.reader.schedule();f.run();f.reader.toggle();await flush();
        expect(reuse).toHaveBeenCalledWith(cached);expect(f.ports.translate).toHaveBeenCalledOnce();
        expect(f.reader.status()).toMatchObject({pending:true,completed:1});
        pending.resolve();await flush();expect(f.reader.status()).toMatchObject({pending:false,completed:2});f.reader.dispose();
    });
    it.each(['image', 'canvas'] as const)('混合图片和画布按照正文顺序预译 %s 页后的最近页', async current => {
        const order: string[] = [];
        const canvasPorts = {identity: vi.fn(() => 'canvas-b'), translate: vi.fn(async () => {order.push('canvas-b');}),
            reuse: vi.fn(() => false), restore: vi.fn(), release: vi.fn(), failed: vi.fn(() => false), update: vi.fn()};
        const f = readerFixture(false, 'https://comic-zenon.com/episode/12207421983509986288', undefined, () => 1, undefined, canvasPorts);
        const parent = f.image.parentElement!;parent.className = 'page-area';f.image.className = 'page-image';
        const canvas = f.document.createElement('canvas') as HTMLCanvasElement;canvas.className = 'js-page-image';canvas.width = 400;canvas.height = 300;
        const last = f.image.cloneNode() as HTMLImageElement;last.src = 'blob:page-c';
        Object.defineProperties(last, {complete:{value:true}, naturalWidth:{value:800}, naturalHeight:{value:1200}});
        parent.append(canvas, last);
        const rect = (top:number, width:number, height:number) => ({left:0,right:width,top,bottom:top+height,width,height}) as DOMRect;
        f.image.getBoundingClientRect = () => rect(current === 'image' ? 0 : -1300, 800, 1200);
        canvas.getBoundingClientRect = () => rect(current === 'image' ? 1000 : 0, 400, 300);
        last.getBoundingClientRect = () => rect(current === 'image' ? 1500 : 1000, 800, 1200);
        f.ports.translate.mockImplementation(async image => {order.push(image === f.image ? 'image-a' : 'image-c');});
        f.reader.schedule();f.run();f.reader.toggle();await flush();
        expect(order).toEqual(current === 'image' ? ['image-a','canvas-b'] : ['canvas-b','image-c']);
        f.reader.dispose();
    });
    it('模拟规则中的图片、背景和画布按 DOM 次序列出，而不是按载体类型列出', async () => {
        vi.spyOn(mangaConfig,'resolveMangaSite').mockReturnValue({name:'fixture',selector:'.page-area img',canvasSelector:'.page-area canvas',backgroundSelector:'.page-area .page-background',custom:false});
        const reading={live:()=>true,load:vi.fn(async()=>({status:'empty' as const}))};
        const canvasPorts={identity:vi.fn(()=>'canvas-c'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn()};
        const background={identity:vi.fn(()=> 'background-b'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),prepare:vi.fn(),pixels:vi.fn(()=>300000),bounds:vi.fn((node:HTMLElement)=>node.getBoundingClientRect())};
        const f=readerFixture(false,undefined,undefined,()=>0,undefined,canvasPorts,{background,reading});
        const parent=f.image.parentElement!;parent.className='page-area';
        const backgroundNode=f.document.createElement('div') as HTMLElement;backgroundNode.className='page-background';backgroundNode.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=backgroundNode.getBoundingClientRect;parent.append(backgroundNode,canvas);
        f.reader.schedule();f.run();f.reader.toggle();await flush();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(({kind,ordinal})=>[kind,ordinal])).toEqual([['image',1],['background',2],['canvas',3]]);
        expect(reading.load).not.toHaveBeenCalled();f.reader.dispose();
    });
    it('混合载体阅读序号跟随 DOM 重排，原有结果不重跑 OCR 或释放', async () => {
        const reading = {live:()=>true, load:vi.fn(async()=>({status:'empty' as const}))};
        const canvasPorts = {identity: vi.fn(()=>'canvas-b'), translate: vi.fn().mockResolvedValue(undefined),
            reuse: vi.fn(()=>false), restore:vi.fn(), release:vi.fn(), failed:vi.fn(()=>false), update:vi.fn()};
        const f = readerFixture(false, 'https://comic-zenon.com/episode/12207421983509986288', undefined, () => 0, undefined, canvasPorts, {reading});
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='page-image';canvas.width=400;canvas.height=300;
        canvas.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;
        const last=f.image.cloneNode() as HTMLImageElement;last.src='blob:page-c';Object.defineProperties(last,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
        last.getBoundingClientRect=()=>({left:0,right:800,top:0,bottom:1200,width:800,height:1200}) as DOMRect;parent.append(canvas,last);
        f.reader.schedule();f.run();f.reader.toggle();await flush();
        let list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(({kind,ordinal})=>[kind,ordinal])).toEqual([['image',1],['canvas',2],['image',3]]);
        const images=f.ports.translate.mock.calls.length, canvases=canvasPorts.translate.mock.calls.length;
        parent.insertBefore(canvas,f.image);f.mo.callback([{type:'childList',target:parent} as unknown as MutationRecord],{} as MutationObserver);f.run();await flush();
        list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(({kind,ordinal})=>[kind,ordinal])).toEqual([['canvas',1],['image',2],['image',3]]);
        expect(f.ports.translate).toHaveBeenCalledTimes(images);expect(canvasPorts.translate).toHaveBeenCalledTimes(canvases);
        expect(f.ports.release).not.toHaveBeenCalled();expect(canvasPorts.release).not.toHaveBeenCalled();expect(reading.load).not.toHaveBeenCalled();
        f.reader.dispose();
    });
    it('当前页识别期间正文重排后，后续可见页按新次序启动且不重复处理',async()=>{
        const order:string[]=[],pending=deferred();
        const canvasPorts={identity:vi.fn(()=>'canvas-b'),translate:vi.fn(async()=>{order.push('canvas-b');}),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn()};
        const f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,()=>0,undefined,canvasPorts);
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='page-image';canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;
        const last=f.image.cloneNode() as HTMLImageElement;last.src='blob:page-c';Object.defineProperties(last,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});last.getBoundingClientRect=()=>({left:0,right:800,top:0,bottom:1200,width:800,height:1200}) as DOMRect;parent.append(canvas,last);
        f.ports.translate.mockImplementation(async image=>{if(image===f.image){order.push('image-a');await pending.promise;}else order.push('image-c');});
        f.reader.schedule();f.run();f.reader.toggle();await flush();expect(order).toEqual(['image-a']);
        parent.append(canvas);f.mo.callback([{type:'childList',target:parent} as unknown as MutationRecord],{} as MutationObserver);f.run();
        pending.resolve();await flush();expect(order).toEqual(['image-a','image-c','canvas-b']);
        expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(canvasPorts.translate).toHaveBeenCalledOnce();expect(f.ports.release).not.toHaveBeenCalled();expect(canvasPorts.release).not.toHaveBeenCalled();f.reader.dispose();
    });
    it('长图各分段保持页内顺序，并与中间画布及下一张图片按正文顺序排列', async()=>{
        const values=new Map<HTMLImageElement,import('@/src/features/image-translation/content/mangaImageSegments').MangaImageSegment[]>();
        const segments={identity:vi.fn(s=>s.source),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),prepare:vi.fn(()=>values),pixels:vi.fn(()=>1_800_000),bounds:vi.fn(()=>({left:0,top:0,right:800,bottom:600,width:800,height:600}) as DOMRect)};
        const reading={live:()=>true,load:vi.fn(async()=>({status:'empty' as const}))};
        const canvasPorts={identity:vi.fn(()=>'canvas-b'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn()};
        const f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,()=>0,undefined,canvasPorts,{segments,reading});
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const first={image:f.image,top:0,height:600,width:800,contextTop:0,contextHeight:600,source:'one'},second={...first,top:600,source:'two'};values.set(f.image,[first,second]);
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='page-image';canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;
        const last=f.image.cloneNode() as HTMLImageElement;last.src='blob:page-c';Object.defineProperties(last,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});last.getBoundingClientRect=()=>({left:0,right:800,top:0,bottom:1200,width:800,height:1200}) as DOMRect;parent.append(canvas,last);
        f.reader.schedule();f.run();f.reader.toggle();await flush();const list=f.reader.readingCandidates();if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(({kind,ordinal,segment})=>[kind,ordinal,segment?.top])).toEqual([['segment',1,0],['segment',2,600],['canvas',3,undefined],['image',4,undefined]]);
        f.reader.dispose();
    });
    it('混合正文滚动复用发现结果，合并比较次数随页数线性增长',()=>{
        const canvasPorts={identity:vi.fn((node:HTMLCanvasElement)=>node.id),translate:vi.fn(),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn()};
        const f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,undefined,undefined,canvasPorts);
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const images=[f.image],rect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;
        for(let i=0;i<20;i++){
            const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.id=`canvas-${i}`;canvas.className='page-image';canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=rect;parent.append(canvas);
            if(i<19){const image=f.image.cloneNode() as HTMLImageElement;image.src=`blob:page-${i}`;Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});image.getBoundingClientRect=rect;parent.append(image);images.push(image);}
        }
        const comparisons=images.map(image=>vi.spyOn(image,'compareDocumentPosition'));
        f.reader.schedule();f.run();comparisons.forEach(spy=>spy.mockClear());const query=vi.spyOn(f.document,'querySelectorAll');
        f.scroll();expect(query).not.toHaveBeenCalled();expect(comparisons.reduce((sum,spy)=>sum+spy.mock.calls.length,0)).toBeLessThanOrEqual(39);
        expect(f.ports.translate).not.toHaveBeenCalled();expect(canvasPorts.translate).not.toHaveBeenCalled();f.reader.dispose();
    });
    it('发现期间载体被移出时稳定退化并在下一次 DOM 更新清除，不启动离线画布识别',async()=>{
        let remove=false;
        const canvasPorts={identity:vi.fn((node:HTMLCanvasElement)=>{if(remove)node.remove();return 'detached';}),translate:vi.fn(),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn()};
        const f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,undefined,undefined,canvasPorts);
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='page-image';canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;parent.append(canvas);
        const compare=vi.spyOn(f.image,'compareDocumentPosition');remove=true;f.reader.schedule();expect(()=>f.run()).not.toThrow();
        expect(compare).toHaveBeenCalledWith(canvas);expect(canvas.isConnected).toBe(false);
        remove=false;f.mo.callback([{type:'childList',target:parent} as unknown as MutationRecord],{} as MutationObserver);f.run();f.reader.toggle();await flush();
        expect(f.reader.status().pageCount).toBe(1);expect(canvasPorts.translate).not.toHaveBeenCalled();expect(f.ports.translate).toHaveBeenCalledTimes(1);f.reader.dispose();
    });
    it('刷新关闸后等待新布局，旧任务结束不会先启动其他可见页',async()=>{
        const f=readerFixture(false),pending=deferred(),last=f.image.cloneNode() as HTMLImageElement;last.src='blob:page-c';
        Object.defineProperties(last,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});last.getBoundingClientRect=()=>({left:0,right:800,top:0,bottom:1200,width:800,height:1200}) as DOMRect;f.image.parentElement!.append(last);
        f.ports.translate.mockReturnValueOnce(pending.promise);f.reader.schedule();f.run();f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.reader.deferForRefresh();pending.resolve();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);f.reader.dispose();
    });
    it('显式重试可见画布时重新验证来源，原有图片不重复识别',async()=>{
        const canvasPorts={identity:vi.fn(()=>'canvas'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn(()=>false),restore:vi.fn(),release:vi.fn(),failed:vi.fn(()=>false),update:vi.fn(),invalidate:vi.fn()};
        const f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,()=>0,undefined,canvasPorts);
        const parent=f.image.parentElement!;parent.className='page-area';f.image.className='page-image';
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='page-image';canvas.width=400;canvas.height=300;canvas.getBoundingClientRect=()=>({left:0,right:400,top:0,bottom:300,width:400,height:300}) as DOMRect;parent.append(canvas);
        f.reader.schedule();f.run();f.reader.toggle();await flush();canvasPorts.invalidate.mockClear();
        expect(f.reader.retry(canvas)).toBe(true);await flush();expect(canvasPorts.invalidate).toHaveBeenCalledOnce();expect(canvasPorts.invalidate).toHaveBeenCalledWith(canvas);
        expect(canvasPorts.translate).toHaveBeenCalledTimes(2);expect(f.ports.translate).toHaveBeenCalledOnce();f.reader.dispose();
    });
    it('附近离屏画布停稳后进入预译队列，不作为当前可见页', async () => {
        vi.useFakeTimers();
        const current = deferred(), ahead = deferred();
        const canvasPorts = {identity: vi.fn().mockReturnValue('canvas-ahead'), translate: vi.fn().mockReturnValue(ahead.promise),
            reuse: vi.fn().mockReturnValue(false), restore: vi.fn(), release: vi.fn(), failed: vi.fn().mockReturnValue(false),
            update: vi.fn(), invalidate: vi.fn()};
        const f = readerFixture(false, 'https://comic-zenon.com/episode/12207421983509986288', undefined, () => 1, undefined, canvasPorts);
        f.image.className = 'page-image';f.image.parentElement!.className = 'page-area';
        const canvas = f.document.createElement('canvas') as HTMLCanvasElement;
        canvas.className = 'js-page-image';canvas.width = 400;canvas.height = 300;
        canvas.getBoundingClientRect = () => ({left: 0, right: 400, top: 1000, bottom: 1300, width: 400, height: 300}) as DOMRect;
        f.image.parentElement!.append(canvas);f.ports.translate.mockReturnValueOnce(current.promise);
        f.reader.schedule();f.run();f.reader.toggle();await flush();
        expect(canvasPorts.invalidate).toHaveBeenCalledWith(canvas);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(canvasPorts.translate).not.toHaveBeenCalled();
        f.scroll();current.resolve();await flush();
        expect(canvasPorts.translate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(180);f.run();await flush();
        expect(canvasPorts.translate).toHaveBeenCalledOnce();expect(canvasPorts.translate).toHaveBeenCalledWith(canvas);
        expect(f.reader.status()).toMatchObject({pending: true, prefetching: true, ahead: 0});
        ahead.resolve();await flush();expect(f.reader.status()).toMatchObject({pending: false, prefetching: false, ahead: 1, completed: 2});
        f.reader.dispose();
    });
    it('可读画布与正文图片共用串行队列，重绘失效、暂停恢复和不可读降级不选推广图', async () => {
        const pending=deferred(), canvasPorts={identity:vi.fn().mockReturnValue('canvas-1'),translate:vi.fn().mockResolvedValue(undefined),reuse:vi.fn().mockReturnValue(false),restore:vi.fn(),release:vi.fn(),failed:vi.fn().mockReturnValue(false),update:vi.fn()};
        const warm=vi.fn(),f=readerFixture(false,'https://comic-zenon.com/episode/12207421983509986288',undefined,undefined,warm,canvasPorts,{cachePages:()=>2});
        f.image.className='page-image';f.image.parentElement!.className='page-area';
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.className='js-page-image';canvas.width=400;canvas.height=300;
        canvas.getBoundingClientRect=()=>({left:800,right:1200,top:0,bottom:300,width:400,height:300}) as DOMRect;f.image.parentElement!.append(canvas);
        f.ports.translate.mockReturnValueOnce(pending.promise);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,pageCount:2,areaFallback:false});
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();expect(canvasPorts.translate).not.toHaveBeenCalled();
        pending.resolve();await flush();expect(canvasPorts.translate).toHaveBeenCalledWith(canvas);expect(canvasPorts.failed).toHaveBeenCalledWith(canvas);expect(warm).toHaveBeenLastCalledWith([f.image]);
        f.reader.toggle();expect(canvasPorts.restore).toHaveBeenCalledWith(canvas);expect(f.ports.restore).toHaveBeenCalledWith(f.image);
        canvasPorts.reuse.mockReturnValue(true);f.reader.toggle();await flush();expect(canvasPorts.translate).toHaveBeenCalledOnce();
        canvasPorts.failed.mockReturnValue(true);expect(f.reader.retry(canvas)).toBe(true);await flush();expect(f.reader.status().errors).toBe(1);
        canvasPorts.identity.mockReturnValue('canvas-2');f.reader.schedule();f.run();await flush();expect(canvasPorts.release).toHaveBeenCalledWith(canvas);
        f.image.remove();canvasPorts.identity.mockReturnValue(null);f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,areaFallback:true,pageCount:0});
        expect(f.reader.toggle()).toBe(false);
        canvasPorts.identity.mockReturnValue('canvas-3');canvasPorts.reuse.mockReturnValue(false);
        let canvasQueries=0;const read=f.document.querySelectorAll.bind(f.document);const blocked=vi.spyOn(f.document,'querySelectorAll').mockImplementation(((selector:string)=>{if(selector.includes('canvas') && ++canvasQueries===2)throw new Error('host DOM query unavailable');return read(selector);}) as typeof f.document.querySelectorAll);
        // 像素不可读时，圈选回退的独立 DOM 查询异常也不能中断网页。
        canvasPorts.identity.mockReturnValue(null);f.reader.schedule();expect(()=>f.run()).not.toThrow();expect(f.reader.status().areaFallback).toBe(false);blocked.mockRestore();
        f.reader.dispose();expect(canvasPorts.update).toHaveBeenCalled();
    });
    it.each([
        ['https://dynasty-scans.com/chapters/the_nth_encore', 'reader', 'image', 'thumbnail'],
        ['https://weebcentral.com/chapters/01M43Q7CFX4XXN7WBVZH1MTEFS', 'chapter-images', '', ''],
    ])('正文专用规则接受 %s，翻译后仍可暂停恢复', async (href, parentId, imageId, imageClass) => {
        const f=readerFixture(false, href), parent=f.image.parentElement!;
        parent.id=parentId;
        if (imageId) {const wrapper=f.document.createElement('div');wrapper.id=imageId;wrapper.className=imageClass;parent.append(wrapper);wrapper.append(f.image);}
        f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,pageCount:1,areaFallback:false});
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);f.reader.dispose();
    });
    it.each(['https://comic-days.com/episode/10834108156634732370', 'https://comic-zenon.com/episode/12207421983509986288', 'https://ichicomi.com/episode/2551460909671541131', 'https://jumptoon.com/series/JT00064/episodes/14436/'])('画布正文只发布圈选入口，推荐图不进入队列，离屏和关闭后入口消失 %s', async href => {
        const f=readerFixture(false,href);
        f.image.parentElement!.className='link-page-content';
        const page=f.document.createElement('div');page.className='page-area';
        if(href.includes('jumptoon.com'))page.id='1';
        const canvas=f.document.createElement('canvas');canvas.className='js-page-image';page.append(canvas);f.document.body.append(page);
        let top=0;canvas.getBoundingClientRect=()=>({left:0,right:688,top,bottom:top+1024,width:688,height:1024}) as DOMRect;
        const pixels=vi.fn();canvas.getContext=pixels;
        f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,areaFallback:true,pageCount:0});
        expect(f.ports.changed).toHaveBeenLastCalledWith(expect.objectContaining({areaFallback:true}));
        expect(f.reader.toggle()).toBe(false);await flush();expect(f.ports.translate).not.toHaveBeenCalled();expect(pixels).not.toHaveBeenCalled();
        top=1500;f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:false,areaFallback:false});
        top=0;page.setAttribute('data-fluent-read-ui','owned');f.reader.schedule();f.run();expect(f.reader.status().areaFallback).toBe(false);
        page.removeAttribute('data-fluent-read-ui');f.reader.schedule();f.run();expect(f.reader.status().areaFallback).toBe(true);
        f.ports.enabled.mockReturnValue(false);f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
        expect(f.reader.status().areaFallback).toBe(false);
    });
    it('MangaDNA 动态正文进入连续队列，正文外的封面不翻译，暂停恢复原图', async () => {
        const resetCache=vi.fn(),f=readerFixture(false,'https://mangadna.com/manga/omniscient-readers-viewpoint/chapter-311',undefined,undefined,undefined,undefined,{resetCache});
        expect(f.reader.status().available).toBe(false);
        f.image.parentElement!.className='read-content';
        const reader=f.document.createElement('div');reader.className='read-manga';reader.append(f.image.parentElement!);f.document.body.append(reader);
        const cover=f.image.cloneNode() as HTMLImageElement;cover.className='cover';cover.src='blob:cover';f.document.body.append(cover);
        f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,pageCount:1});
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(call=>call[0])).toEqual([f.image]);
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);
        f.window.location.href='https://mangadna.com/manga/omniscient-readers-viewpoint/chapter-312';f.reader.schedule();f.run();expect(resetCache).toHaveBeenCalledTimes(2);
        f.image.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });
    it.each([
        ['https://asurascans.com/comics/title/chapter/8', '<div class="select-none"><div data-page="0"></div></div>', '[data-page]'],
        ['https://arenascan.com/like-a-fiery-flame-chapter-98/', '<article><div id="readerarea"></div></article>', '#readerarea'],
        ['https://kingofshojo.com/ill-save-a-decent-family-chapter-199/', '<article><div id="readerarea"><p></p></div></article>', '#readerarea p'],
        ['https://violetmanga.com/a-portrait-of-pride-chapter-12/', '<article><div id="readerarea"></div></article>', '#readerarea'],
        ['https://www.mangaread.org/manga/title/chapter-17/', '<div class="reading-content"><div class="page-break"></div></div>', '.page-break'],
        ['https://mangaforfree.net/manga/title/chapter-14-raw/', '<div class="reading-content"><div class="page-break"></div></div>', '.page-break'],
        ['https://manhwabuddy.com/manhwa/title/chapter-157/', '<div class="reading-chapter"><div class="reading-content"><p></p></div></div>', '.reading-content p'],
        ['https://vortexscans.org/series/title/chapter-7', '<div class="comic-images-wrapper"><figure class="image-container"></figure></div>', 'figure'],
        ['https://rookie.shonenjump.com/series/TWpXKpYkRIE/TWpXKpYkRIM', '<div class="page-area"></div>', '.page-area'],
        ['https://www.webtoons.com/en/romance/title/episode-1/viewer?title_no=1&episode_no=1', '<div id="_imageList"></div>', '#_imageList'],
        ['https://mgeko.cc/reader/en/title-chapter-1-eng-li/', '<div id="chapter-reader"></div>', '#chapter-reader'],
        ['https://roliascan.com/read/title/ch28-123/', '<div id="chapter-images-container"><a class="comic-image-container"></a></div>', '.comic-image-container'],
        ['https://mangadex.org/chapter/80da5ab1-b615-4564-9a19-0f1502dbde05', '<div class="md--reader-pages"><div class="md--page"></div></div>', '.md--page'],
        ['https://twicomi.com/manga/author/2077704742067904960', '<div class="tweet-images"><div class="image"></div></div>', '.image'],
        ['https://comic-fuz.com/manga/4018', '<div data-testid="placeholder"></div>', '[data-testid]'],
        ['https://manga-one.com/manga/28579/chapter/360007', '<div data-testid="placeholder"></div>', '[data-testid]'],
        ['https://comic.mf-fleur.jp/manga/cb245_01.html', '<div class="manga-content"><div class="manga-content__image"></div></div>', '.manga-content__image'],
        ['https://ac.qq.com/ComicView/index/id/656723/cid/105748', '<ul id="comicContain"><li></li></ul>', 'li'],
        ['https://www.corocoro.jp/chapter/10580/viewer', '<div data-testid="placeholder"></div>', '[data-testid]'],
        ['https://ww3.mangafreak.me/Read1_One_Piece_1', '<div class="slideshow-container"><div class="mySlides"></div></div>', '.mySlides'],
        ['https://mn4u.net/2360/296144/', '<div class="chapter-content"><div id="list-imga"></div></div>', '#list-imga'],
        ['https://mgread.io/manga/title/chapter-1/', '<main id="init-manga-single-chapter"><div id="chapter-content"></div></main>', '#chapter-content'],
        ['https://yymanhua.com/m7261/', '<div id="showimage"><div id="cp_img"></div></div>', '#cp_img'],
        ['https://mangarawjp.me/manga/blue-lock/363-wa', '<div id="TopPage" class="ImageGallery"></div>', '#TopPage'],
        ['https://www.antbyw.com/plugin.php?id=jameson_manhua&a=read&kuid=189309&zjid=1435867', '<div id="img_list"><div></div></div>', '#img_list > div'],
        ['https://speed-manga.net/the-mirror-legacy-0/', '<article><div id="readerarea"></div></article>', '#readerarea'],
        ['https://w9.smokingbehindthesupermarket.com/manga/title-chapter-1/', '<article><div id="content"><div class="separator"></div></div></article>', '.separator'],
    ])('公开章节只调度正文而不选择正文容器外的封面 %s', async (href, markup, mount) => {
        const f=readerFixture(false,href);
        f.image.className='js-page-image _images comic-image chapter-img img-fluid ts-main-image';
        f.image.alt='page_0';
        if(href.includes('yymanhua.com'))f.image.id='cp_image';
        if(href.includes('antbyw.com'))f.image.id='img_0';
        const wrapper=f.document.createElement('div');wrapper.innerHTML=markup;f.document.body.append(wrapper);
        const cover=f.image.cloneNode() as HTMLImageElement;cover.src='blob:cover';wrapper.append(cover);
        wrapper.querySelector(mount)!.append(f.image);
        f.reader.schedule();f.run();expect(f.reader.status()).toMatchObject({available:true,pageCount:1});
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(call=>call[0])).toEqual([f.image]);
        f.reader.toggle();expect(f.ports.restore).toHaveBeenCalledWith(f.image);
        f.image.remove();f.reader.schedule();f.run();expect(f.reader.status().available).toBe(false);f.reader.dispose();
    });

    it('附近页排序每页只测量一次，不在比较器中重复读取布局', () => {
        const warm = vi.fn(), f = readerFixture(false, undefined, undefined, undefined, warm);
        const images = [f.image]; const measure = vi.fn();
        for (let index = 1; index < 240; index++) {
            const image = f.document.createElement('img') as HTMLImageElement;
            image.className = 'zao-image'; image.src = `blob:layout-${index}`;
            Object.defineProperties(image, {complete: {value: true}, naturalWidth: {value: 800}, naturalHeight: {value: 1200}});
            f.image.parentElement!.append(image); images.push(image);
        }
        images.forEach((image, index) => {
            const top = (239 - index) * 3;
            image.getBoundingClientRect = () => {
                measure(image);
                return {left: 0, right: 800, top, bottom: top + 1200, width: 800, height: 1200} as DOMRect;
            };
        });
        f.reader.schedule(); f.run();
        expect(warm).toHaveBeenLastCalledWith(images.slice(-12).reverse());
        // 发现后的正文快照和会话回调后的预合成各读一次；排序不读 DOM。
        expect(measure).toHaveBeenCalledTimes(480); expect(f.ports.translate).not.toHaveBeenCalled();
        f.reader.dispose();
    });

    it('未就绪页不为预合成再读一次布局，也不强制加载原图', () => {
        const warm = vi.fn(), f = readerFixture(false, undefined, undefined, undefined, warm);
        Object.defineProperty(f.image, 'complete', {value: false});
        const measure = vi.spyOn(f.image, 'getBoundingClientRect');
        f.reader.schedule(); f.run();
        expect(measure).toHaveBeenCalledOnce(); expect(warm).toHaveBeenLastCalledWith([]);
        expect(f.image.src).toBe('blob:page-1'); expect(f.ports.translate).not.toHaveBeenCalled(); f.reader.dispose();
    });

    it('会话通知改变宿主几何后使用新位置挑选预合成页，下一帧再次测量', () => {
        const warm = vi.fn(), f = readerFixture(false, undefined, undefined, undefined, warm);
        f.ports.changed.mockImplementationOnce(() => f.setRect({left: 4000, right: 4800}));
        f.reader.schedule(); f.run(); expect(warm).toHaveBeenLastCalledWith([]);
        f.setRect({left: 0, right: 800}); f.reader.schedule(); f.run();
        expect(warm).toHaveBeenLastCalledWith([f.image]); f.reader.dispose();
    });
    it('预合成按可见优先与几何距离排序，左右一屏和容量都有边界',()=>{
        const warm=vi.fn(),f=readerFixture(true,undefined,undefined,undefined,warm);
        const near=f.document.createElement('img'),far=f.document.createElement('img');
        for(const [image,top] of [[far,1700],[near,1200]] as const){image.className='zao-image';image.src=`blob:${top}`;Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});image.getBoundingClientRect=()=>({left:0,right:800,top,bottom:top+1200,width:800,height:1200}) as DOMRect;f.image.parentElement!.append(image);}
        f.reader.schedule();f.run();expect(warm).toHaveBeenLastCalledWith([f.image,near,far]);f.reader.dispose();
    });
    it('同地址原图重新加载也重新识别，其他图片加载不能失效当前译图', async () => {
        const f=readerFixture();f.reader.toggle();await flush();
        f.document.querySelector('#logo')!.dispatchEvent(new f.dom.Event('load',{bubbles:true}));f.run();await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.image.dispatchEvent(new f.dom.Event('load',{bubbles:true}));f.run();await flush();
        expect(f.ports.release).toHaveBeenCalledWith(f.image);
        expect(f.ports.translate).toHaveBeenCalledTimes(2);f.reader.dispose();
    });
    it('新地址已就绪先处理后收到 load 不重复识别，再次同地址重载仍失效',async()=>{
        const f=readerFixture();f.reader.toggle();await flush();
        f.image.src='blob:new-source';f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.image.dispatchEvent(new f.dom.Event('load',{bubbles:true}));f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.image.dispatchEvent(new f.dom.Event('load',{bubbles:true}));f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(3);
        f.reader.dispose();
    });
    it('上下左右移动只更新几何，宿主正文变化和显式配置刷新才重新发现图片', async () => {
        const f=readerFixture(false),query=vi.spyOn(f.document,'querySelectorAll');
        f.reader.toggle();await flush();query.mockClear();
        const scroll=f.window.addEventListener.mock.calls.find(([name])=>name==='scroll')![1];
        const resize=f.window.addEventListener.mock.calls.find(([name])=>name==='resize')![1];
        for(let i=0;i<8;i++) {
            f.setRect(i%2 ? {left:0,right:800,top:0,bottom:1200} : {left:1400,right:2200,top:-1300,bottom:-100});
            scroll();resize();f.run();await flush();
        }
        expect(query).not.toHaveBeenCalled();
        f.setRect({left:1400,right:2200});f.mo.callback([{target:f.image.parentElement,attributeName:'style',type:'attributes'} as unknown as MutationRecord],{} as MutationObserver);f.run();await flush();
        expect(query).not.toHaveBeenCalled();expect(f.ports.release).toHaveBeenCalledWith(f.image);
        f.mo.callback([{target:f.image} as unknown as MutationRecord],{} as MutationObserver);f.run();
        expect(query).toHaveBeenCalledTimes(1);
        f.reader.schedule();f.run();expect(query).toHaveBeenCalledTimes(2);f.reader.dispose();
    });
    it('通用站点的正文 id 与 data 标记变化仍重新发现，自定义状态选择器保留动态查询',async()=>{
        const f=readerFixture(false,'https://example.com/reader/chapter'),parent=f.image.parentElement!;
        expect(f.reader.status().available).toBe(false);
        const options=f.mo.observe.mock.calls[0][1];expect(options.attributeFilter).toEqual(expect.arrayContaining(['id','data-manga-reader']));
        parent.id='reader';f.mo.callback([{target:parent,attributeName:'id'} as unknown as MutationRecord],{} as MutationObserver);f.run();
        f.reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(1);
        parent.removeAttribute('id');parent.setAttribute('data-manga-reader','');f.mo.callback([{target:parent} as unknown as MutationRecord],{} as MutationObserver);f.run();
        expect(f.reader.status().available).toBe(true);parent.removeAttribute('data-manga-reader');f.mo.callback([{target:parent} as unknown as MutationRecord],{} as MutationObserver);f.run();
        expect(f.reader.status().available).toBe(false);f.reader.dispose();
        const custom=readerFixture(false,'https://example.com/custom/',()=>[{hostname:'example.com',pathPrefix:'/custom/',selector:'img[data-page="shown"]'}]);
        expect(custom.ports.changed).toHaveBeenLastCalledWith(expect.objectContaining({pageCount:0}));custom.image.setAttribute('data-page','shown');
        custom.window.addEventListener.mock.calls.find(([name])=>name==='scroll')![1]();custom.run();custom.reader.toggle();await flush();
        expect(custom.ports.translate).toHaveBeenCalledTimes(1);custom.reader.dispose();
    });
    it('下页在返回前页期间完成仍保留，关闭预译也不重复识别或启动第三页',async()=>{
        const f=readerFixture(false,undefined,undefined,()=>0),images=[f.image];let anchor=0;
        for(let index=1;index<=2;index++) {
            const image=f.document.createElement('img') as HTMLImageElement;image.className='zao-image';image.src=`blob:page-${index}`;
            Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
            image.getBoundingClientRect=()=>({left:0,right:800,top:(index-anchor)*1300,bottom:(index-anchor)*1300+1200,width:800,height:1200}) as DOMRect;
            f.image.parentElement!.append(image);images.push(image);
        }
        f.image.getBoundingClientRect=()=>({left:0,right:800,top:-anchor*1300,bottom:-anchor*1300+1200,width:800,height:1200}) as DOMRect;
        f.reader.toggle();await flush();const pending=deferred();f.ports.translate.mockReturnValueOnce(pending.promise);
        anchor=1;f.reader.schedule();f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
        anchor=0;f.reader.schedule();f.run();pending.resolve();await flush();
        expect(f.ports.release).not.toHaveBeenCalled();
        for(let i=0;i<3;i++){anchor=1;f.reader.schedule();f.run();await flush();anchor=0;f.reader.schedule();f.run();await flush();}
        expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual(images.slice(0,2));expect(f.reader.status().ahead).toBe(0);f.reader.dispose();
    });
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
    it('提前页与附近历史页共用八百万像素预算，超预算页进入视口仍正常翻译',async()=>{
        const f=readerFixture(false,undefined,undefined,()=>5),images=[f.image];let anchor=0;
        for(let i=1;i<6;i++) {
            const image=f.document.createElement('img') as HTMLImageElement;image.className='zao-image';image.src=`blob:budget-${i}`;
            Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:2000},naturalHeight:{value:1500}});
            image.getBoundingClientRect=()=>({left:0,right:800,top:(i-anchor)*1300,bottom:(i-anchor)*1300+1200,width:800,height:1200}) as DOMRect;
            f.image.parentElement!.append(image);images.push(image);
        }
        f.image.getBoundingClientRect=()=>({left:0,right:800,top:-anchor*1300,bottom:-anchor*1300+1200,width:800,height:1200}) as DOMRect;
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual(images.slice(0,3));
        expect(f.reader.status().ahead).toBe(2);
        anchor=3;f.reader.schedule();f.run();await flush();
        expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual(images);expect(f.ports.release).toHaveBeenCalledWith(images[1]);
        f.reader.dispose();
    });
    it('后续窗口中的未加载页不阻塞其他已加载页，完成加载后仍只识别一次',async()=>{
        const f=readerFixture(false,undefined,undefined,()=>3),images=[f.image];
        for(let i=1;i<4;i++) {
            const image=f.document.createElement('img') as HTMLImageElement;image.className='zao-image';image.src=`blob:loading-${i}`;
            Object.defineProperties(image,{complete:{value:i!==1,writable:true},naturalWidth:{value:800},naturalHeight:{value:1200}});
            image.getBoundingClientRect=()=>({left:0,right:800,top:i*1300,bottom:i*1300+1200,width:800,height:1200}) as DOMRect;
            f.image.parentElement!.append(image);images.push(image);
        }
        f.reader.toggle();await flush();expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([images[0],images[2],images[3]]);
        Object.defineProperty(images[1],'complete',{value:true});images[1].dispatchEvent(new f.dom.Event('load',{bubbles:true}));f.run();await flush();
        expect(f.ports.translate.mock.calls.map(c=>c[0])).toEqual([images[0],images[2],images[3],images[1]]);f.reader.dispose();
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
        // 0 只停止准备新页；附近两张已完成结果仍可供返页复用，第三张超出保留窗口才释放。
        expect(f.ports.release.mock.calls.map(c=>c[0])).toEqual(images.slice(3,4));f.reader.dispose();
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
        vi.useFakeTimers();
        const f = readerFixture(); expect(f.io.observe).toHaveBeenCalledWith(f.image);
        f.reader.toggle(); await flush(); expect(f.ports.translate).toHaveBeenCalledTimes(1);
        f.intersect(true); await flush(); expect(f.ports.translate).toHaveBeenCalledWith(f.image);
        f.setRect({top:-1200,bottom:0});f.intersect(false); expect(f.ports.release).toHaveBeenCalledWith(f.image);
        f.setRect({top:0,bottom:1200});f.intersect(true);vi.advanceTimersByTime(180);f.run();await flush();expect(f.ports.translate).toHaveBeenCalledTimes(2);
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
