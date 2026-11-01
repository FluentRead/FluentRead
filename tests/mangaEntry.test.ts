import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
    config: {on: true, disableImageTranslator: true, disableFloatingBall: true, floatingBallDisabledDomains: [] as string[], imageTranslationMangaEnabled: true,
        imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false,
        imageTranslationMangaSites: [] as unknown[], imageTranslationMangaPrefetchPages:3, animations:false, from: 'auto', to: 'zh-Hans', imageTranslationService: '',theme:'auto'},
    create: vi.fn(), status: vi.fn(), toggle: vi.fn(), subscribe: vi.fn(), persist: vi.fn(), send: vi.fn(),
    stopStatus: vi.fn(), stopConfig: vi.fn(), listReading:vi.fn(), readReading:vi.fn(), observeReading:vi.fn(), registerHost:vi.fn(), releaseHost:vi.fn(),
}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.create}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, subscribeConfig: mocks.subscribe, requestConfigPatch: mocks.persist}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: mocks.send}}}));
vi.mock('@/src/features/image-translation/content/runtime', () => ({subscribeMangaTranslation: mocks.status, toggleMangaTranslation: mocks.toggle,
    getMangaReadingCandidates:mocks.listReading,readMangaReadingCandidate:mocks.readReading,observeMangaReadingCandidate:mocks.observeReading,registerMangaReadingOverlayHost:mocks.registerHost,registerMangaReadingOpener:()=>()=>{}}));
vi.mock('@/src/features/image-translation/ui/MangaEntry.vue', () => ({default: {name: 'MangaEntry'}}));
import {isImageTranslatorNeeded, isMangaReaderPage, mountMangaEntry, openMangaEntry, openMangaReading, subscribeMangaReading, unmountMangaEntry} from '@/src/features/image-translation/content/mangaEntry';

const href = 'https://mangaplus.shueisha.co.jp/viewer/1024050';
const deferred = () => {let resolve!: (value: any) => void, reject!: (reason:unknown)=>void;const promise = new Promise<any>((yes,no) => {resolve = yes;reject=no;});return {promise, resolve,reject};};
const props = () => mocks.create.mock.calls.at(-1)![1].props;
beforeEach(() => {
    vi.clearAllMocks();
    const dom = parseHTML('<html><body></body></html>');vi.stubGlobal('document', dom.document);vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('location', {href});
    Object.assign(mocks.config, {on: true, disableImageTranslator: true, disableFloatingBall: true, floatingBallDisabledDomains: [], imageTranslationMangaEnabled: true,
        imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false, imageTranslationMangaSites: [], from: 'auto', to: 'zh-Hans', imageTranslationService: '',theme:'auto'});
    mocks.subscribe.mockReturnValue(mocks.stopConfig);mocks.status.mockReturnValue(mocks.stopStatus);
    mocks.registerHost.mockReturnValue(mocks.releaseHost);
    mocks.create.mockResolvedValue({remove: vi.fn(), mounted: {instance: {open: vi.fn()}}});
    mocks.send.mockResolvedValue({success: true, ready: true, inpaintingReady: true});
});
afterEach(() => {unmountMangaEntry();vi.unstubAllGlobals();});

describe('独立漫画入口所有权和配置端口', () => {
    it('读取面板沿用界面主题并只在复制操作时访问剪贴板', async () => {
        const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
        await mountMangaEntry({} as never);expect(props().reading.theme).toBe('auto');expect(writeText).not.toHaveBeenCalled();
        mocks.config.theme='dark';mocks.subscribe.mock.calls[0][0]();expect(props().reading.theme).toBe('dark');
        mocks.config.theme='light';mocks.subscribe.mock.calls[0][0]();expect(props().reading.theme).toBe('light');
        await props().reading.copy('译文');expect(writeText).toHaveBeenCalledOnce();expect(writeText).toHaveBeenCalledWith('译文');
        writeText.mockRejectedValueOnce(new Error('clipboard denied'));await expect(props().reading.copy('另一段')).rejects.toThrow('clipboard denied');
    });
    it('单个打开状态监听器抛错或退订不影响其他监听和面板状态', async () => {
        const broken=vi.fn(()=>{throw new Error('listener failed');}), listener=vi.fn(), stopBroken=subscribeMangaReading(broken),stop=subscribeMangaReading(listener);
        expect(broken).toHaveBeenCalledWith(false);expect(listener).toHaveBeenCalledWith(false);await mountMangaEntry({} as never);
        props().readingChanged(true);expect(broken).toHaveBeenLastCalledWith(true);expect(listener).toHaveBeenLastCalledWith(true);
        stopBroken();props().readingChanged(false);expect(listener).toHaveBeenLastCalledWith(false);expect(broken).toHaveBeenCalledTimes(2);stop();
    });
    it('实际宿主插入失败时移除实例和订阅，并可重新挂载', async () => {
        const host=document.createElement('div'), remove=vi.fn();mocks.create.mockResolvedValueOnce({shadowHost:host,remove});
        const oldRoot=document.documentElement;oldRoot.remove();
        await expect(mountMangaEntry({} as never)).rejects.toThrow();expect(remove).toHaveBeenCalledOnce();
        expect(mocks.stopStatus).toHaveBeenCalledOnce();expect(mocks.stopConfig).toHaveBeenCalledOnce();expect(mocks.registerHost).not.toHaveBeenCalled();
        document.appendChild(oldRoot);
        await mountMangaEntry({} as never);expect(mocks.create).toHaveBeenCalledTimes(2);
    });
    it('实例缺少阅读方法或关闭能力时不伪造成功', async () => {
        const target=document.createElement('button');document.body.append(target);const event={isTrusted:true,currentTarget:target} as unknown as MouseEvent;
        mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{}}});await mountMangaEntry({} as never);
        mocks.status.mock.calls[0][0]({available:true,active:true,pending:false,errors:0});expect(openMangaReading(event)).toBe(false);unmountMangaEntry();
        const openReading=vi.fn().mockResolvedValue(true);mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{openReading}}});await mountMangaEntry({} as never);
        mocks.status.mock.calls.at(-1)![0]({available:true,active:true,pending:false,errors:0});props().readingChanged(true);
        expect(openMangaReading(event)).toBe(false);expect(openReading).not.toHaveBeenCalled();props().readingChanged(false);
    });
    it('读取打开失败关闭当前实例；旧实例的迟到失败不影响新实例', async () => {
        const target=document.createElement('button');document.body.append(target);const event={isTrusted:true,currentTarget:target} as unknown as MouseEvent;
        const pending=deferred(),closeReading=vi.fn();mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{openReading:()=>pending.promise,closeReading}}});
        await mountMangaEntry({} as never);mocks.status.mock.calls[0][0]({available:true,active:true,pending:false,errors:0});
        const listener=vi.fn(),stop=subscribeMangaReading(listener);expect(openMangaReading(event)).toBe(true);props().readingChanged(true);
        pending.reject(new Error('panel failed'));await Promise.resolve();await Promise.resolve();expect(closeReading).toHaveBeenCalledOnce();expect(listener).toHaveBeenLastCalledWith(false);stop();
        unmountMangaEntry();const old=deferred(),oldClose=vi.fn();mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{openReading:()=>old.promise,closeReading:oldClose}}});
        await mountMangaEntry({} as never);mocks.status.mock.calls.at(-1)![0]({available:true,active:true,pending:false,errors:0});expect(openMangaReading(event)).toBe(true);unmountMangaEntry();
        const newClose=vi.fn();mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{openReading:vi.fn().mockResolvedValue(true),closeReading:newClose}}});
        await mountMangaEntry({} as never);props().readingChanged(true);old.reject(new Error('late failure'));await Promise.resolve();await Promise.resolve();
        expect(oldClose).not.toHaveBeenCalled();expect(newClose).not.toHaveBeenCalled();expect(props().readingState.open).toBe(true);
    });
    it('两个入口复用唯一实例和打开状态，仅可信事件可携带原始触发目标', async () => {
        const host=document.createElement('div'), target=document.createElement('button');document.body.append(host,target);
        const openReading=vi.fn().mockResolvedValue(true), closeReading=vi.fn(()=>props().readingChanged(false)), instance={open:vi.fn(),openReading,closeReading}, remove=vi.fn();
        mocks.create.mockResolvedValueOnce({shadowHost:host,remove,mounted:{instance}});
        const listener=vi.fn(), stop=subscribeMangaReading(listener);expect(listener).toHaveBeenCalledWith(false);
        await mountMangaEntry({} as never);expect(mocks.registerHost).toHaveBeenCalledWith(host);
        mocks.status.mock.calls[0][0]({available:true,active:true,pending:false,errors:0});
        const event={isTrusted:true,currentTarget:target} as unknown as MouseEvent;
        expect(openMangaReading({isTrusted:false,currentTarget:target} as unknown as MouseEvent)).toBe(false);
        expect(openMangaReading(event)).toBe(true);expect(openReading).toHaveBeenCalledWith(event,target);
        props().readingChanged(true);expect(listener).toHaveBeenLastCalledWith(true);expect(props().readingState.open).toBe(true);
        expect(openMangaReading(event,false)).toBe(true);expect(closeReading).not.toHaveBeenCalled();
        props().readManga(event);expect(closeReading).toHaveBeenCalledOnce();expect(openReading).toHaveBeenCalledOnce();expect(listener).toHaveBeenLastCalledWith(false);
        props().readManga(event);expect(openReading).toHaveBeenCalledTimes(2);expect(mocks.create).toHaveBeenCalledOnce();
        props().readingChanged(true);unmountMangaEntry();expect(listener).toHaveBeenLastCalledWith(false);expect(mocks.releaseHost).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledOnce();
        props().readingChanged(true);expect(listener).toHaveBeenLastCalledWith(false);expect(openMangaReading(event)).toBe(false);stop();
    });
    it('挂载迟到或会话暂停时不打开、不注册过期宿主', async () => {
        const pending=deferred(), host=document.createElement('div');mocks.create.mockReturnValueOnce(pending.promise);
        const request=mountMangaEntry({} as never);unmountMangaEntry();const stale={shadowHost:host,remove:vi.fn()};pending.resolve(stale);await request;
        expect(stale.remove).toHaveBeenCalledOnce();expect(mocks.registerHost).not.toHaveBeenCalled();
        const openReading=vi.fn().mockResolvedValue(true);mocks.create.mockResolvedValueOnce({remove:vi.fn(),mounted:{instance:{openReading}}});await mountMangaEntry({} as never);
        const target=document.createElement('button');document.body.append(target);const event={isTrusted:true,currentTarget:target} as unknown as MouseEvent;
        mocks.status.mock.calls.at(-1)![0]({available:true,active:false,pending:false,errors:0});expect(openMangaReading(event)).toBe(false);expect(openReading).not.toHaveBeenCalled();
    });
    it.each([
        ['https://mangalib.me/ru/1--title/read/v22/c129?p=2', 'ru', 'rus'],
        ['https://mangahub.ru/read/123?page=2', 'ru', 'rus'],
        ['https://comic.naver.com/webtoon/detail?titleId=855297&no=1', 'ko', 'kor'],
    ])('自动源语言的正文 %s 提示并检查 %s 资源，路由和手动语言正常同步', async (href, source, pack) => {
        location.href=href;await mountMangaEntry({} as never);
        expect(props().settings.sourceLanguage).toBe(source);expect(mocks.config.from).toBe('auto');
        mocks.send.mockResolvedValueOnce({success:true,ready:false,inpaintingReady:true}).mockResolvedValueOnce({success:true,languages:[pack,'eng']});
        expect(await props().inspectResources()).toBe(true);
        expect(mocks.send).toHaveBeenLastCalledWith({type:'fluentReadImageOcrStatus'});
        mocks.config.from='en';mocks.subscribe.mock.calls[0][0]();expect(props().settings.sourceLanguage).toBe('en');
        mocks.send.mockResolvedValueOnce({success:true,ready:true,inpaintingReady:true});expect(await props().inspectResources()).toBe(true);
        expect(mocks.send).toHaveBeenLastCalledWith({type:'fluentReadMangaModelStatus'});
        mocks.config.from='auto';location.href='https://mangaplus.shueisha.co.jp/viewer/1024050';document.dispatchEvent(new Event('fluentread-route-change'));
        expect(props().settings.sourceLanguage).toBe('auto');expect(mocks.persist).not.toHaveBeenCalled();
    });
    it.each([['ru', 'rus'], ['ko-KR', 'kor']])('漫画源语言 %s 检查已有语言包与清字模型，不要求无关的专用字表', async (source, language) => {
        mocks.config.from = source;await mountMangaEntry({} as never);
        const inspect = async (languages: unknown, inpaintingReady = true) => {
            mocks.send.mockResolvedValueOnce({success: true, ready: false, inpaintingReady})
                .mockResolvedValueOnce({success: true, languages});
            return props().inspectResources();
        };
        expect(await inspect([language, 'eng'])).toBe(true);
        expect(await inspect([language])).toBe(false);
        expect(await inspect(['eng'])).toBe(false);
        expect(await inspect([language, 'eng'], false)).toBe(false);
        expect(await inspect({language, eng: true})).toBe(false);
        mocks.send.mockResolvedValueOnce({success: true, inpaintingReady: true}).mockResolvedValueOnce({success: false, error: 'language status failed'});
        await expect(props().inspectResources()).rejects.toThrow('language status failed');
        mocks.send.mockResolvedValueOnce({success: true, inpaintingReady: true}).mockResolvedValueOnce(undefined);
        await expect(props().inspectResources()).rejects.toThrow('阅读资源状态读取失败');
        expect(mocks.send.mock.calls.every(([message]) => ['fluentReadMangaModelStatus', 'fluentReadImageOcrStatus'].includes(message.type))).toBe(true);
    });
    it('圈选端口只在启用漫画且确实检测到画布/分片时调用，不触发连续翻译', async () => {
        const startAreaTranslation=vi.fn().mockResolvedValue(true);
        await mountMangaEntry({} as never,{startAreaTranslation});
        expect(await props().startAreaTranslation()).toBe(false);
        mocks.status.mock.calls[0][0]({available:true,active:false,pending:false,errors:0,areaFallback:true});
        expect(await props().startAreaTranslation()).toBe(true);expect(startAreaTranslation).toHaveBeenCalledOnce();
        mocks.status.mock.calls[0][0]({available:false,active:false,pending:false,errors:0,areaFallback:true});
        expect(await props().startAreaTranslation()).toBe(false);expect(startAreaTranslation).toHaveBeenCalledOnce();
        mocks.config.on=false;expect(await props().startAreaTranslation()).toBe(false);
        expect(mocks.toggle).not.toHaveBeenCalled();
        unmountMangaEntry();mocks.config.on = true;
        await mountMangaEntry({} as never);
        mocks.status.mock.calls.at(-1)![0]({available: true, active: false, pending: false, errors: 0, areaFallback: true});
        expect(await props().startAreaTranslation()).toBe(false);
    });
    it('备用按钮依据普通悬浮球和站点名单显隐，不重复显示入口', async () => {
        await mountMangaEntry({} as never);
        expect(props().settings.floatingBallVisible).toBe(false);
        mocks.config.disableFloatingBall = false;mocks.subscribe.mock.calls[0][0]();
        expect(props().settings.floatingBallVisible).toBe(true);
        mocks.config.floatingBallDisabledDomains = ['mangaplus.shueisha.co.jp'];mocks.subscribe.mock.calls[0][0]();
        expect(props().settings.floatingBallVisible).toBe(false);
    });
    it.each([{domains:[] as string[]},{domains:['mangaplus.shueisha.co.jp']}])('初次挂载读取悬浮球站点策略 $domains', async ({domains}) => {
        mocks.config.disableFloatingBall = false;mocks.config.floatingBallDisabledDomains = domains;
        await mountMangaEntry({} as never);expect(props().settings.floatingBallVisible).toBe(domains.length === 0);
    });
    it('提示与译图在 html 同级，宿主 body 堆叠上下文不遮挡漫画操作', async () => {
        const shadowHost=document.createElement('div');document.body.append(shadowHost);
        mocks.create.mockResolvedValueOnce({shadowHost,remove:vi.fn()});await mountMangaEntry({} as never);
        expect(shadowHost.parentElement).toBe(document.documentElement);
    });
    it('漫画阅读页不依赖普通图片开关，插件和漫画开关仍然生效', () => {
        expect(isMangaReaderPage()).toBe(true);expect(isImageTranslatorNeeded()).toBe(true);
        mocks.config.imageTranslationMangaEnabled = false;expect(isImageTranslatorNeeded()).toBe(false);
        mocks.config.disableImageTranslator = false;expect(isImageTranslatorNeeded()).toBe(true);
        mocks.config.on = false;expect(isImageTranslatorNeeded()).toBe(false);
        expect(isMangaReaderPage('https://example.com')).toBe(false);
        vi.stubGlobal('location', undefined);expect(isMangaReaderPage()).toBe(false);
    });
    it('重复挂载共享请求，订阅状态和路由，并且卸载清理全部订阅', async () => {
        const pending = deferred();mocks.create.mockReturnValue(pending.promise);
        const request = mountMangaEntry({} as never);expect(mountMangaEntry({} as never)).toBe(request);
        const value = {remove: vi.fn(), mounted: {instance: {open: vi.fn()}}};pending.resolve(value);await request;
        await mountMangaEntry({} as never);expect(mocks.create).toHaveBeenCalledOnce();
        mocks.status.mock.calls[0][0]({available: true, active: true, pending: true, errors: 0});
        expect(props().status.pending).toBe(true);expect(props().page.site).toBe('MANGA Plus');
        mocks.config.to = 'en';mocks.config.imageTranslationMangaPromptEnabled = false;
        mocks.config.imageTranslationMangaDownloadConfirmed = true;mocks.config.imageTranslationService = 'google';
        mocks.config.imageTranslationMangaPrefetchPages = 0;
        mocks.config.from = 'ru';
        mocks.subscribe.mock.calls[0][0]();expect(props().settings).toEqual({sourceLanguage: 'ru', promptEnabled: false, floatingBallVisible: false, to: 'en', downloadConfirmed: true, service: 'google', animations:false, toolsDisplay:'always', prefetchPages:0});
        location.href = 'https://example.com/';document.dispatchEvent(new Event('fluentread-route-change'));
        expect(props().page).toEqual({site: '', route: location.href});
        expect(openMangaEntry()).toBe(true);expect(value.mounted.instance.open).toHaveBeenCalledOnce();
        unmountMangaEntry();expect(value.remove).toHaveBeenCalledOnce();expect(mocks.stopStatus).toHaveBeenCalledOnce();expect(mocks.stopConfig).toHaveBeenCalledOnce();
        expect(openMangaEntry()).toBe(false);
    });
    it('卸载后的迟到实例被删除，不覆盖重新挂载的实例', async () => {
        const pending = deferred();mocks.create.mockReturnValueOnce(pending.promise);
        const request = mountMangaEntry({} as never);unmountMangaEntry();
        const current = {remove: vi.fn(), mounted: {instance: {open: vi.fn()}}};mocks.create.mockResolvedValue(current);
        await mountMangaEntry({} as never);const stale = {remove: vi.fn()};pending.resolve(stale);await request;
        expect(stale.remove).toHaveBeenCalledOnce();expect(openMangaEntry()).toBe(true);expect(current.mounted.instance.open).toHaveBeenCalledOnce();
        unmountMangaEntry();expect(current.remove).toHaveBeenCalledOnce();
    });
    it('等待 UI 创建时卸载立即退订，迟到实例不能重复退订或覆盖新入口', async () => {
        const pending = deferred(); mocks.create.mockReturnValueOnce(pending.promise);
        const request = mountMangaEntry({} as never), oldPage = props().page;
        unmountMangaEntry(); const immediateStops = [mocks.stopStatus.mock.calls.length, mocks.stopConfig.mock.calls.length];
        location.href = 'https://mangaplus.shueisha.co.jp/viewer/1024051'; document.dispatchEvent(new Event('fluentread-route-change'));
        const oldRouteAfterUnmount = oldPage.route;
        const current = {remove: vi.fn(), mounted: {instance: {open: vi.fn()}}}; mocks.create.mockResolvedValueOnce(current);
        await mountMangaEntry({} as never); const stale = {remove: vi.fn()}; pending.resolve(stale); await request;
        expect(immediateStops).toEqual([1, 1]); expect(oldRouteAfterUnmount).toBe(href);
        expect(mocks.stopStatus).toHaveBeenCalledOnce(); expect(mocks.stopConfig).toHaveBeenCalledOnce();
        expect(stale.remove).toHaveBeenCalledOnce(); expect(openMangaEntry()).toBe(true);
        expect(current.mounted.instance.open).toHaveBeenCalledOnce();
        unmountMangaEntry(); expect(mocks.stopStatus).toHaveBeenCalledTimes(2); expect(mocks.stopConfig).toHaveBeenCalledTimes(2);
    });
    it('不匹配地址不挂载迟到面板且网站名称安全回退', async () => {
        location.href = 'https://example.com';await mountMangaEntry({} as never);expect(props().page.site).toBe('');expect(openMangaEntry()).toBe(false);
    });
    it.each(['master', 'manga', 'route'])('等待挂载期间 %s 失效会删除实例和订阅', async change => {
        const pending = deferred();mocks.create.mockReturnValue(pending.promise);const request = mountMangaEntry({} as never);
        if (change === 'master') mocks.config.on = false;
        if (change === 'manga') mocks.config.imageTranslationMangaEnabled = false;
        if (change === 'route') location.href = 'https://example.com';
        const value = {remove: vi.fn()};pending.resolve(value);await request;
        expect(value.remove).toHaveBeenCalledOnce();expect(openMangaEntry()).toBe(false);expect(mocks.stopConfig).toHaveBeenCalledOnce();
    });
    it('挂载失败也解除订阅，可安全重试；没有 exposed instance 时不执行动作', async () => {
        mocks.create.mockRejectedValueOnce(new Error('mount failed'));
        await expect(mountMangaEntry({} as never)).rejects.toThrow('mount failed');expect(mocks.stopStatus).toHaveBeenCalledOnce();
        mocks.create.mockResolvedValue({remove: vi.fn()});await mountMangaEntry({} as never);expect(openMangaEntry()).toBe(false);
        props().toggle();expect(mocks.toggle).toHaveBeenCalledOnce();mocks.config.imageTranslationMangaEnabled = false;props().toggle();
        mocks.config.on = false;props().toggle();expect(mocks.toggle).toHaveBeenCalledOnce();
    });
    it('模型状态和持久化走既有消息端口，状态失败不会误当资源已经可用', async () => {
        await mountMangaEntry({} as never);expect(await props().inspectResources()).toBe(true);
        mocks.send.mockResolvedValueOnce({success: true, ready: false, inpaintingReady: true});expect(await props().inspectResources()).toBe(false);
        mocks.send.mockResolvedValueOnce({success: true, ready: true, inpaintingReady: false});expect(await props().inspectResources()).toBe(false);
        mocks.send.mockResolvedValueOnce({success: false, error: 'try again'});await expect(props().inspectResources()).rejects.toThrow('try again');
        mocks.send.mockResolvedValueOnce(undefined);await expect(props().inspectResources()).rejects.toThrow('阅读资源状态读取失败');
        props().persist({imageTranslationMangaPromptEnabled: false});const [patch, send] = mocks.persist.mock.calls[0];
        expect(patch).toEqual({imageTranslationMangaPromptEnabled: false});await send({type: 'persistConfig'});expect(mocks.send).toHaveBeenLastCalledWith({type: 'persistConfig'});
        props().openSettings();expect(mocks.send).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-image-translation'});
        mocks.send.mockRejectedValueOnce(new Error('closed'));props().openSettings();await Promise.resolve();
    });
});
