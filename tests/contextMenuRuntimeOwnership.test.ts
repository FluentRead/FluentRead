/**
 * @file tests/contextMenuRuntimeOwnership.test.ts
 * 文件职责：验证原生右键菜单异步查询、结构重建和点击的归属及写入次序。
 * 主要内容：使用真实菜单快照与后台 runtime，延迟浏览器 API 回复以覆盖切换标签页、配置关闭、状态乱序和原生写入交错。
 * 模块边界：浏览器 API、语言加载与翻译动作是受控端口；不表示操作系统菜单或真实翻译服务验证。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({config: {} as Record<string, any>, listeners: [] as Array<() => void>,
    ready: Promise.resolve(), language: vi.fn(), action: vi.fn(), feedback: vi.fn(), capabilities: {browser: 'chrome', imageTranslation: true, areaTranslation: true}}));
vi.mock('@/src/services/config/store', () => ({config: state.config, configReady: {then: (fn: () => void) => state.ready.then(fn)}, subscribeConfig: (fn: () => void) => {state.listeners.push(fn);return () => {};}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: state.capabilities}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: state.language}));
vi.mock('@/src/app/background/contextMenuActions', () => ({runContextMenuAction: state.action}));
vi.mock('@/src/app/background/contextMenuFeedback', () => ({reportContextMenuFailure: state.feedback}));
function deferred<T = unknown>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
const neutral = {status: 'success', isTranslated: false, isSiteDisabled: false};
const pageId = 'fluent-read:page:translatePage';
let active: number, api: any;
async function settle() {for (let i = 0; i < 100; i++) await Promise.resolve();}
function change(values: Record<string, unknown>) {Object.assign(state.config, values);state.listeners.at(-1)!();}
async function install() {const {installBackgroundContextMenus} = await import('@/src/app/background/contextMenuRuntime');const {TabTranslationStateStore} = await import('@/src/app/background/tabTranslationState');return installBackgroundContextMenus(new TabTranslationStateStore());}
async function start() {const runtime = await install();await settle();api.contextMenus.update.mockClear();api.contextMenus.create.mockClear();api.contextMenus.removeAll.mockClear();api.tabs.sendMessage.mockClear();return runtime;}
function pageTitles() {return api.contextMenus.update.mock.calls.filter(([id]: any[]) => id === pageId).map(([, value]: any[]) => value.title);}
beforeEach(() => {
    vi.resetModules();vi.clearAllMocks();state.listeners.length = 0;state.ready = Promise.resolve();active = 9;
    for (const key of Reflect.ownKeys(state.config)) delete state.config[key as string];
    Object.assign(state.config, {on: true, uiLanguage: 'zh-CN', contextMenuEnabled: true, contextMenuEntries: {}, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, disableImageTranslator: false, selectionAreaEnabled: true, imageTranslationContextMenuEnabled: true, disabledExtensionDomains: []});
    state.language.mockResolvedValue(undefined);state.action.mockResolvedValue({handled: false});
    const event = () => ({addListener: vi.fn()});
    api = {contextMenus: {create: vi.fn().mockResolvedValue(undefined), removeAll: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined), onClicked: event()},
        tabs: {query: vi.fn(async () => [{id: active}]), sendMessage: vi.fn().mockResolvedValue(neutral), onActivated: event(), onUpdated: event(), onRemoved: event()}};
    vi.stubGlobal('browser', api);
});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('右键菜单原生写入的异步归属', () => {
    it('结构创建后的活动页查询遇到配置变化时不回源，也不拖住菜单关闭', async () => {
        const query = deferred();
        api.tabs.query.mockReturnValueOnce(query.promise);
        await install();await settle();
        change({contextMenuEnabled:false});await settle();
        expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(2);
        query.resolve([{id:9}]);await settle();
        expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it('翻译动作完成后不等展示刷新，刷新挂起或失败都不阻塞下次点击', async () => {
        const {createContextMenuClickHandler} = await import('@/src/app/background/contextMenuClicks');
        const {readContextMenuSettings} = await import('@/src/app/background/contextMenuPreferences');
        const {buildContextMenuPlan} = await import('@/src/core/context-menu/domain');
        const {TabTranslationStateStore} = await import('@/src/app/background/tabTranslationState');
        const settings = readContextMenuSettings(), plan = buildContextMenuPlan(settings.toggles);
        const update = vi.fn().mockReturnValueOnce(deferred().promise).mockRejectedValueOnce(new Error('native display unavailable'));
        state.action.mockResolvedValue({handled:true,isTranslated:true});
        const {handleClick} = createContextMenuClickHandler({ready: async () => {}, getSettings: () => settings,
            getPlan: () => plan, tabTranslationStates: new TabTranslationStateStore(),
            readTabTranslationState: vi.fn().mockResolvedValue({isTranslated:false,isSiteDisabled:false}), update});
        await handleClick({menuItemId:pageId},{id:9});
        await handleClick({menuItemId:pageId},{id:9});await settle();
        expect(state.action).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(2);
        expect(state.feedback).not.toHaveBeenCalled();
    });

    it('后台冷启动时到达的原生点击等待配置和菜单初始化后执行', async () => {
        const ready = deferred<void>();state.ready = ready.promise;await install();
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];
        click({menuItemId:pageId},{id:9});await settle();expect(state.action).not.toHaveBeenCalled();
        ready.resolve(undefined);await settle();expect(state.action).toHaveBeenCalledTimes(1);
    });

    it.each(['loading', 'removed'])('冷启动等待期间目标页 %s 后丢弃旧点击', async event => {
        const ready = deferred<void>();state.ready = ready.promise;await install();
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});
        if (event === 'loading') api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});
        else api.tabs.onRemoved.addListener.mock.calls[0][0](9);
        ready.resolve(undefined);await settle();expect(state.action).not.toHaveBeenCalled();
    });
    it('冷启动等待期间关闭菜单不执行排队点击', async () => {
        const ready = deferred<void>();state.ready = ready.promise;await install();
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});
        state.config.contextMenuEnabled = false;ready.resolve(undefined);await settle();
        expect(state.action).not.toHaveBeenCalled();
    });
    it('冷启动首击失败后可重试并继续执行恢复与再次翻译', async () => {
        const ready = deferred<void>();state.ready = ready.promise;await install();
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];
        state.action.mockRejectedValueOnce(new Error('temporary action failure'));
        click({menuItemId:pageId},{id:9});ready.resolve(undefined);await settle();expect(state.feedback).toHaveBeenCalledWith(9,expect.any(Object),'unavailable',expect.any(Function));
        for (const translated of [true, false, true]) {
            state.action.mockResolvedValueOnce({handled:true,isTranslated:translated});
            click({menuItemId:pageId},{id:9});await settle();
            api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:translated});
        }
        expect(state.action.mock.calls.map(([action, , , , translated]) => [action, translated]))
            .toEqual([['translatePage',false],['translatePage',false],['translatePage',true],['translatePage',false]]);
    });
    it('启动菜单创建完成后的活动页查询失败不清空点击路由', async () => {
        const error = vi.spyOn(console,'error').mockImplementation(() => {});
        api.tabs.query.mockRejectedValueOnce(new Error('active tab temporarily unavailable'));
        await start();expect(error).toHaveBeenCalled();
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});
        await settle();expect(state.action).toHaveBeenCalledTimes(1);
    });

    it('回复期间活动页改变时旧页面不写全局标题', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();active = 10;reply.resolve({...neutral, isTranslated: true});await old;
        expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
    it('回复期间菜单关闭时旧查询不写已删除的菜单', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();change({contextMenuEnabled: false});await settle();reply.resolve({...neutral, isTranslated: true});await old;
        expect(api.contextMenus.update).not.toHaveBeenCalled();expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    });
    it('同一活动页较早查询晚返回时不能覆盖较新查询', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();await runtime.update(9);reply.resolve({...neutral, isTranslated: true});await old;
        expect(pageTitles()).toEqual([]);
    });
    it('已发出的原生写入完成后再写最新状态，不能让旧写入最后落地', async () => {
        const runtime = await start(), write = deferred();let pending = false, overlap = false;
        api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:true});
        api.contextMenus.update.mockImplementationOnce(async () => {pending = true;await write.promise;pending = false;});
        api.contextMenus.update.mockImplementation(() => {if (pending) overlap = true;return Promise.resolve();});
        const old = runtime.update(9);await settle();api.tabs.sendMessage.mockResolvedValue(neutral);const next = runtime.update(9);await settle();
        write.resolve(undefined);await Promise.all([old, next]);expect(overlap).toBe(false);expect(pageTitles()).toEqual(['显示页面原文','翻译全文']);
    });
    it('原生更新未完成时重建等待它结束，再创建新结构', async () => {
        const runtime = await start(), write = deferred();api.contextMenus.update.mockReturnValueOnce(write.promise);
        api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:true});
        const old = runtime.update(9);await settle();change({contextMenuEntries: {translateSelection: false}});await settle();
        const removalsWhilePending = api.contextMenus.removeAll.mock.calls.length;write.resolve(undefined);await old;await settle();expect(removalsWhilePending).toBe(0);
        expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);expect(api.contextMenus.create.mock.calls.map(([item]: any[]) => item.id)).toEqual([pageId,'fluent-read:image:translateImage']);
    });
    it('结构创建期间配置关闭，停止余下条目并撤回本轮', async () => {
        const create = deferred();api.contextMenus.create.mockReturnValueOnce(create.promise);await install();await settle();
        change({contextMenuEnabled: false});create.resolve(undefined);await settle();
        expect(api.contextMenus.create).toHaveBeenCalledTimes(1);expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(3);
    });
    it('点击等待状态时菜单被关闭，不再执行旧动作', async () => {
        await start();const reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId: pageId}, {id: 9});await settle();change({contextMenuEnabled: false});await settle();reply.resolve(neutral);await settle();
        expect(state.action).not.toHaveBeenCalled();
    });
    it('点击等待状态时同 ID 菜单已重建，不借用新菜单的动作', async () => {
        await start();const reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId: pageId}, {id: 9});await settle();change({uiLanguage: 'en-US'});await settle();reply.resolve(neutral);await settle();
        expect(state.action).not.toHaveBeenCalled();
    });
    it('目标语言、快捷键和旧附加显示偏好改变不重建菜单', async () => {
        await start();change({to: 'en', floatingBallHotkey: 'Alt+P', contextMenuShowTargetLanguage: false, contextMenuShowShortcut: false});await settle();
        expect(api.contextMenus.create).not.toHaveBeenCalled();expect(api.contextMenus.removeAll).not.toHaveBeenCalled();
    });
    it('状态不变只查询一次页面真值且不重复原生写入，变化只写对应项', async () => {
        const runtime = await start();api.tabs.query.mockClear();await runtime.update(9);
        expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);expect(api.contextMenus.update).not.toHaveBeenCalled();expect(api.tabs.query).toHaveBeenCalledTimes(1);
        api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:true});await runtime.update(9);
        expect(api.contextMenus.update).toHaveBeenCalledTimes(1);expect(pageTitles()).toEqual(['显示页面原文']);
        await runtime.update(9);expect(api.contextMenus.update).toHaveBeenCalledTimes(1);
    });
    it('活动页查询失败通过事件路径受控结束，后续更新仍可执行', async () => {
        await start();const error = vi.spyOn(console,'error').mockImplementation(() => {});api.tabs.query.mockRejectedValueOnce(new Error('query unavailable'));
        api.tabs.onActivated.addListener.mock.calls[0][0]({tabId: 9});await settle();expect(error).toHaveBeenCalled();
        api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:true});api.tabs.onActivated.addListener.mock.calls[0][0]({tabId: 9});await settle();expect(pageTitles()).toEqual(['显示页面原文']);
    });
    it('外部快照的图片配置不混入全局配置', async () => {
        const {readContextMenuSettings} = await import('@/src/app/background/contextMenuPreferences');
        const source = {...state.config, disableImageTranslator: true};expect(readContextMenuSettings(source as any).toggles.translateImage).toBe(false);
        state.config.disableImageTranslator = true;source.disableImageTranslator = false;expect(readContextMenuSettings(source as any).toggles.translateImage).toBe(true);
    });
    it('不读取菜单不展示的目标语言与快捷键字段', async () => {
        const {readContextMenuSettings} = await import('@/src/app/background/contextMenuPreferences');let reads = 0;
        for(const key of ['to','floatingBallHotkey','customFloatingBallHotkey']) Object.defineProperty(state.config,key,{configurable:true,get:()=>{reads++;return 'Alt+T';}});
        readContextMenuSettings();expect(reads).toBe(0);
    });
    it('配置就绪失败被接住，不订阅、不创建菜单', async () => {
        const ready = deferred<void>();state.ready = ready.promise;const error = vi.spyOn(console,'error').mockImplementation(() => {});await install();ready.reject(new Error('config unavailable'));await settle();expect(error).toHaveBeenCalled();expect(state.listeners).toHaveLength(0);expect(api.contextMenus.create).not.toHaveBeenCalled();
    });
    it('后台页请求不覆盖也不取消正在等待的活动页更新，非法 ID 不查询', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);const old = runtime.update(9);await settle();await runtime.update(10);await runtime.update(-1);reply.resolve({...neutral,isTranslated:true});await old;expect(pageTitles()).toEqual(['显示页面原文']);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('活动页查询乱序时只接受较新的请求', async () => {
        const runtime = await start(), query = deferred();api.tabs.query.mockReturnValueOnce(query.promise);const old = runtime.update(9);await settle();await runtime.update(9);query.resolve([{id:9}]);await old;expect(pageTitles()).toEqual([]);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('配置在活动页查询中改变时不读取旧页，当前原生更新失败仍继续其他条目', async () => {
        const runtime = await start(), query = deferred();api.tabs.query.mockReturnValueOnce(query.promise);const old = runtime.update(9);await settle();change({contextMenuEnabled:false});await settle();query.resolve([{id:9}]);await old;expect(api.tabs.sendMessage).not.toHaveBeenCalled();
        change({contextMenuEnabled:true});await settle();api.contextMenus.update.mockClear();const error = vi.spyOn(console,'error').mockImplementation(() => {});api.contextMenus.update.mockRejectedValueOnce(new Error('native unavailable'));
        api.tabs.sendMessage.mockResolvedValue({...neutral,isSiteDisabled:true});await runtime.update(9);expect(error).toHaveBeenCalled();expect(api.contextMenus.update).toHaveBeenCalledTimes(3);
        api.contextMenus.update.mockClear();await runtime.update(9);expect(api.contextMenus.update).toHaveBeenCalledTimes(1);expect(pageTitles()).toEqual([]);
    });
    it('排队的更新失效时跳过它，新查询失败后队列仍可重试', async () => {
        const runtime = await start(), write = deferred();api.tabs.sendMessage.mockResolvedValue({...neutral,isSiteDisabled:true});api.contextMenus.update.mockReturnValueOnce(write.promise);const first = runtime.update(9);await settle();const second = runtime.update(9);await settle();const third = runtime.update(9);await settle();write.resolve(undefined);await Promise.all([first,second,third]);expect(pageTitles()).toEqual(['恢复在此网站使用']);
        api.tabs.sendMessage.mockResolvedValue(neutral);const error = vi.spyOn(console,'error').mockImplementation(() => {});api.tabs.query.mockResolvedValueOnce([{id:9}]).mockRejectedValueOnce(new Error('queued query failed'));await runtime.update(9);await runtime.update(9);expect(error).toHaveBeenCalled();expect(pageTitles()).toHaveLength(2);
    });
    it('设置突发变化只构建最后一份快照，语言加载期间改变也失效', async () => {
        await start();change({uiLanguage:'en-US'});change({uiLanguage:'ja-JP'});await settle();expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);
        const language = deferred();state.language.mockReturnValueOnce(language.promise);api.contextMenus.create.mockClear();change({uiLanguage:'fr-FR'});await settle();change({contextMenuEnabled:false});language.resolve(undefined);await settle();expect(api.contextMenus.create).not.toHaveBeenCalled();
    });
    it('等待原生队列的重建失效时不创建，后续创建失败仍可重建', async () => {
        const runtime = await start(), write = deferred();api.tabs.sendMessage.mockResolvedValue({...neutral,isTranslated:true});api.contextMenus.update.mockReturnValueOnce(write.promise);const old = runtime.update(9);await settle();change({uiLanguage:'en-US'});await settle();change({contextMenuEnabled:false});write.resolve(undefined);await old;await settle();expect(api.contextMenus.create).not.toHaveBeenCalled();
        const error = vi.spyOn(console,'error').mockImplementation(() => {});api.contextMenus.create.mockRejectedValueOnce(new Error('native create failed'));change({contextMenuEnabled:true});await settle();expect(error).toHaveBeenCalled();api.contextMenus.create.mockClear();change({uiLanguage:'zh-CN'});await settle();expect(api.contextMenus.create).toHaveBeenCalledTimes(3);
    });
    it('没有活动页时只建结构，导航和关闭维护状态，缺失点击目标不会发消息', async () => {
        api.tabs.query.mockResolvedValue([]);const runtime = await start();expect(api.contextMenus.update).not.toHaveBeenCalled();api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'complete'});api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});api.tabs.onRemoved.addListener.mock.calls[0][0](9);
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];click({menuItemId:pageId},undefined);click({menuItemId:'missing'},{id:9});await settle();await runtime.update(9);expect(state.action).not.toHaveBeenCalled();expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('图片隐藏时点击不执行，可见动作失败受控，成功按回复更新网站状态', async () => {
        const runtime = await start();const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];api.tabs.sendMessage.mockResolvedValue({...neutral,isSiteDisabled:true});await runtime.update(9);click({menuItemId:'fluent-read:image:translateImage'},{id:9});await settle();expect(state.action).not.toHaveBeenCalled();
        state.action.mockRejectedValueOnce(new Error('action failed'));click({menuItemId:pageId},{id:9});await settle();expect(state.feedback).toHaveBeenCalled();
        state.action.mockResolvedValueOnce({handled:true,isSiteDisabled:false});click({menuItemId:pageId},{id:9});await settle();expect(pageTitles().at(-1)).toBe('翻译全文');
        state.action.mockResolvedValueOnce({handled:true,isTranslated:true});click({menuItemId:pageId},{id:9});await settle();expect(pageTitles().at(-1)).toBe('恢复在此网站使用');
    });
    it('可见动作返回未处理时保留当前状态且不刷新菜单', async () => {
        await start();api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});await settle();expect(state.action).toHaveBeenCalledTimes(1);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
    it.each([['loading','query'],['removed','query'],['loading','action'],['removed','action']])('%s 在 %s 等待期间发生时旧点击和动作结果不借用新文档', async (event, phase) => {
        await start();const pending = deferred();if(phase==='query') api.tabs.sendMessage.mockReturnValueOnce(pending.promise);else state.action.mockReturnValueOnce(pending.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});await settle();if(event==='loading') api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});else api.tabs.onRemoved.addListener.mock.calls[0][0](9);await settle();api.contextMenus.update.mockClear();
        pending.resolve(phase==='query' ? neutral : {handled:true,isTranslated:true});await settle();expect(state.action).toHaveBeenCalledTimes(phase==='query' ? 0 : 1);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });

    it.each([
        ['translateSelection','fluent-read:selection:translateSelection','https://example.com/'],
        ['translateImage','fluent-read:image:translateImage','https://example.com/'],
        ['translateArea','fluent-read:page:translateArea','https://example.com/'],
        ['translatePage',pageId,'https://example.com/document.pdf'],
    ])('冷启动活动页查询未回复时 %s 仍直接执行，且不再查询顶层状态', async (action, menuItemId, url) => {
        if (action === 'translateArea') state.config.contextMenuEntries = {translatePage:false,translateArea:true};
        api.tabs.sendMessage.mockReturnValue(deferred().promise);state.action.mockResolvedValue({handled:true});
        await install();await settle();const queries = api.tabs.sendMessage.mock.calls.length;
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId,frameId:7},{id:9,url});await settle();
        expect(state.action).toHaveBeenCalledWith(action,9,expect.objectContaining({frameId:7}),{id:9,url},false);
        expect(api.tabs.sendMessage).toHaveBeenCalledTimes(queries);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });

    it('轻量动作直接使用目标 frame，成功后不做无关菜单刷新', async () => {
        await start();state.action.mockResolvedValue({handled:true});api.tabs.query.mockClear();
        const info = {menuItemId:'fluent-read:selection:translateSelection',frameId:7,pageUrl:'https://example.com/'};
        api.contextMenus.onClicked.addListener.mock.calls[0][0](info,{id:9,url:'https://example.com/'});await settle();
        expect(state.action).toHaveBeenCalledWith('translateSelection',9,info,expect.any(Object),false);
        expect(api.tabs.sendMessage).not.toHaveBeenCalled();expect(api.tabs.query).not.toHaveBeenCalled();expect(api.contextMenus.update).not.toHaveBeenCalled();
    });

    it('轻量动作实时按顶层网站配置恢复禁用站点，图片入口隐藏且不等页面查询', async () => {
        await start();state.config.disabledExtensionDomains = ['example.com'];
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];
        click({menuItemId:'fluent-read:selection:translateSelection',pageUrl:'https://sub.example.com/'},{id:9,url:'https://sub.example.com/'});await settle();
        expect(state.action).toHaveBeenCalledWith('toggleSite',9,expect.any(Object),expect.any(Object),false);expect(api.tabs.sendMessage).not.toHaveBeenCalled();
        click({menuItemId:'fluent-read:image:translateImage',pageUrl:'https://sub.example.com/'},{id:9,url:'https://sub.example.com/'});await settle();expect(state.action).toHaveBeenCalledTimes(1);
    });

    it('重复全文点击串行读取前一动作后的状态，选区动作可同时执行', async () => {
        await start();const first = deferred();let translated = false;
        api.tabs.sendMessage.mockImplementation(async()=>({...neutral,isTranslated:translated}));
        state.action.mockImplementationOnce(async()=>{await first.promise;translated=true;return {handled:true,isTranslated:true};});
        state.action.mockImplementation(async(action: string,_tab: number,_info: unknown,_clickTab: unknown,wasTranslated: boolean)=> {
            if (action === 'translateSelection') return {handled:true};
            translated=!wasTranslated;return {handled:true,isTranslated:translated};
        });
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];
        click({menuItemId:pageId},{id:9});click({menuItemId:pageId},{id:9});click({menuItemId:pageId},{id:9});await settle();
        expect(state.action).toHaveBeenCalledTimes(1);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
        click({menuItemId:'fluent-read:selection:translateSelection'},{id:9});await settle();expect(state.action).toHaveBeenCalledTimes(2);
        first.resolve(undefined);await settle();expect(state.action.mock.calls.filter(([action])=>action==='translatePage').map(([, , , ,wasTranslated])=>wasTranslated)).toEqual([false,true,false]);
        expect(pageTitles()).toEqual(['显示页面原文','翻译全文','显示页面原文']);
    });

    it('排队全文点击在导航后失效，首次动作失败后的下一次点击仍可重试', async () => {
        await start();const pending = deferred();state.action.mockReturnValueOnce(pending.promise);
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];click({menuItemId:pageId},{id:9});click({menuItemId:pageId},{id:9});await settle();
        api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});pending.reject(new Error('old document closed'));await settle();
        expect(state.action).toHaveBeenCalledTimes(1);expect(state.feedback).not.toHaveBeenCalled();
        state.action.mockRejectedValueOnce(new Error('retryable transport error'));click({menuItemId:pageId},{id:9});click({menuItemId:pageId},{id:9});await settle();
        expect(state.action).toHaveBeenCalledTimes(3);expect(state.feedback).toHaveBeenCalledTimes(2);
    });

    it('未处理动作按明确原因提示，导航后的动作失败不显示旧文档提示', async () => {
        await start();state.action.mockResolvedValueOnce({handled:false,reason:'selectionUnavailable'});
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];const info={menuItemId:'fluent-read:selection:translateSelection',frameId:4};
        click(info,{id:9});await settle();expect(state.feedback).toHaveBeenCalledWith(9,info,'selectionUnavailable',expect.any(Function));
        const pending=deferred();state.action.mockReturnValueOnce(pending.promise);click(info,{id:9});await settle();api.tabs.onRemoved.addListener.mock.calls[0][0](9);pending.reject(new Error('stale failure'));await settle();expect(state.feedback).toHaveBeenCalledTimes(1);
    });

    it.each(['loading','removed'])('%s 清除旧文档队列，旧动作挂起也不阻塞新文档点击', async event => {
        await start();const pending=deferred();state.action.mockReturnValueOnce(pending.promise);
        const click=api.contextMenus.onClicked.addListener.mock.calls[0][0];click({menuItemId:pageId},{id:9});click({menuItemId:pageId},{id:9});await settle();
        if(event==='loading') api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});else api.tabs.onRemoved.addListener.mock.calls[0][0](9);
        click({menuItemId:pageId},{id:9});await settle();expect(state.action).toHaveBeenCalledTimes(2);
        pending.resolve({handled:true,isTranslated:true});await settle();expect(state.action).toHaveBeenCalledTimes(2);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });

    it.each(['query','action'])('%s 超时受控提示且不自动重发，之后点击可重试，迟到结果不写菜单', async phase => {
        vi.useFakeTimers();await start();const pending=deferred();
        if(phase==='query') api.tabs.sendMessage.mockReturnValueOnce(pending.promise);else state.action.mockReturnValueOnce(pending.promise);
        const click=api.contextMenus.onClicked.addListener.mock.calls[0][0];click({menuItemId:pageId},{id:9});await settle();
        await vi.advanceTimersByTimeAsync(phase==='query'?3_000:5_000);await settle();
        expect(state.feedback).toHaveBeenCalledWith(9,expect.any(Object),'unavailable',expect.any(Function));
        expect(state.action).toHaveBeenCalledTimes(phase==='query'?0:1);expect(vi.getTimerCount()).toBe(0);
        click({menuItemId:pageId},{id:9});await settle();expect(state.action).toHaveBeenCalledTimes(phase==='query'?1:2);
        pending.resolve(phase==='query'?{...neutral,isTranslated:true}:{handled:true,isTranslated:true});await settle();expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
});
