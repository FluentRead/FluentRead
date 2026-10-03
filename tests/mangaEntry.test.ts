import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
    config: {on: true, disableImageTranslator: true, disableFloatingBall: true, floatingBallDisabledDomains: [] as string[], imageTranslationMangaEnabled: true,
        imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false,
        imageTranslationMangaSites: [] as unknown[], imageTranslationMangaPrefetchPages:3, animations:false, to: 'zh-Hans', imageTranslationService: ''},
    create: vi.fn(), status: vi.fn(), toggle: vi.fn(), subscribe: vi.fn(), persist: vi.fn(), send: vi.fn(),
    stopStatus: vi.fn(), stopConfig: vi.fn(),
}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.create}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, subscribeConfig: mocks.subscribe, requestConfigPatch: mocks.persist}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: mocks.send}}}));
vi.mock('@/src/features/image-translation/content/runtime', () => ({subscribeMangaTranslation: mocks.status, toggleMangaTranslation: mocks.toggle}));
vi.mock('@/src/features/image-translation/ui/MangaEntry.vue', () => ({default: {name: 'MangaEntry'}}));
import {isImageTranslatorNeeded, isMangaReaderPage, mountMangaEntry, openMangaEntry, unmountMangaEntry} from '@/src/features/image-translation/content/mangaEntry';

const href = 'https://mangaplus.shueisha.co.jp/viewer/1024050';
const deferred = () => {let resolve!: (value: any) => void;const promise = new Promise<any>(yes => {resolve = yes;});return {promise, resolve};};
const props = () => mocks.create.mock.calls.at(-1)![1].props;
beforeEach(() => {
    vi.clearAllMocks();
    const dom = parseHTML('<html><body></body></html>');vi.stubGlobal('document', dom.document);vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('location', {href});
    Object.assign(mocks.config, {on: true, disableImageTranslator: true, disableFloatingBall: true, floatingBallDisabledDomains: [], imageTranslationMangaEnabled: true,
        imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false, imageTranslationMangaSites: [], to: 'zh-Hans', imageTranslationService: ''});
    mocks.subscribe.mockReturnValue(mocks.stopConfig);mocks.status.mockReturnValue(mocks.stopStatus);
    mocks.create.mockResolvedValue({remove: vi.fn(), mounted: {instance: {open: vi.fn()}}});
    mocks.send.mockResolvedValue({success: true, ready: true, inpaintingReady: true});
});
afterEach(() => {unmountMangaEntry();vi.unstubAllGlobals();});

describe('独立漫画入口所有权和配置端口', () => {
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
        mocks.subscribe.mock.calls[0][0]();expect(props().settings).toEqual({promptEnabled: false, floatingBallVisible: false, to: 'en', downloadConfirmed: true, service: 'google', animations:false, prefetchPages:0});
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
