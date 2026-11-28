import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
import {toolbarActionChineseMessages, toolbarActionMessages} from '@/src/core/i18n/messages/toolbarAction';
import {UI_LANGUAGE_OPTIONS} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
const env = vi.hoisted(() => ({config: {} as Record<string, any>, listeners: [] as Array<() => void>,
    ready: Promise.resolve(), feedback: vi.fn(), ensureBundle: vi.fn()}));
vi.mock('@/src/services/config/store', () => ({config: env.config,
    configReady: {then: (fn: () => void) => env.ready.then(fn)},
    subscribeConfig: (fn: () => void) => {env.listeners.push(fn);}}));
vi.mock('@/src/app/background/contextMenuFeedback', () => ({reportContextMenuFailure: env.feedback}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: env.ensureBundle}));
import {installToolbarActionRuntime, openToolbarQuickPanel} from '@/src/app/background/toolbarActionRuntime';
registerAllUiLanguageBundles();
function event() {const listeners: Function[] = [];return {addListener: (fn: Function) => listeners.push(fn), emit: (...args: unknown[]) => listeners.forEach(fn => fn(...args)), listeners};}
function deferred<T>() {let resolve!: (value: T) => void;const promise = new Promise<T>(yes => {resolve = yes;});return {promise, resolve};}
async function settle() {for (let i = 0; i < 100; i++) await Promise.resolve();}
function change(values: Record<string, unknown>) {Object.assign(env.config, values);for (const listener of env.listeners) listener();}
let api: any, action: any, states: TabTranslationStateStore, pageStates: Map<number, boolean>;
beforeEach(() => {
    env.listeners.length = 0;env.ready = Promise.resolve();env.feedback.mockReset();
    env.ensureBundle.mockReset().mockResolvedValue(true);
    for (const key of Object.keys(env.config)) delete env.config[key];
    Object.assign(env.config, {on: true, toolbarClickAction: 'translate', uiLanguage: 'zh-CN', disabledExtensionDomains: []});
    states = new TabTranslationStateStore();pageStates = new Map();
    action = {setPopup: vi.fn().mockResolvedValue(undefined), onClicked: event()};
    api = {action, runtime: {getManifest: vi.fn(() => ({action: {default_popup: 'popup.html'}})),
        getURL: (path: string) => `chrome-extension://fixture${path}`}, tabs: {
        create: vi.fn().mockResolvedValue({id: 100}), onUpdated: event(), onRemoved: event(),
        sendMessage: vi.fn(async (id: number, message: {type: string; action?: string}) => {
            if (message.type === 'getFullPageTranslationState') return {status: 'success', isTranslated: pageStates.get(id) === true};
            pageStates.set(id, message.action === 'fullPage');return {status: 'success', isTranslated: pageStates.get(id)};
        }),
    }};
    // 共享仓库的导航失效由先安装的 contextMenuRuntime 拥有。
    api.tabs.onUpdated.addListener((id: number, change: any) => {if (change.status === 'loading') states.reset(id);});
    api.tabs.onRemoved.addListener((id: number) => states.delete(id));
    vi.stubGlobal('browser', api);
});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const click = (id: unknown = 9, url = 'https://example.com/article') => action.onClicked.emit({id, url});
const commands = () => api.tabs.sendMessage.mock.calls.filter(([, message]: any[]) => message.type === 'contextMenuTranslate');
describe('工具栏一键翻译', () => {
    it('opens the translation window from its browser shortcut and releases a failed opening', async () => {
        const command = event();
        api.commands = {onCommand: command};
        const opening = deferred<void>();
        api.windows = {create: vi.fn().mockReturnValueOnce(opening.promise)};
        api.runtime.getManifest.mockReturnValue({commands: {'open-translation-window': {description: 'Open translation window'}}});
        delete api.action;
        const error = new Error('native window failed');
        api.windows.create.mockRejectedValueOnce(error);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        installToolbarActionRuntime(states);
        command.emit('other');
        command.emit('open-translation-window');
        command.emit('open-translation-window');
        expect(api.windows.create).toHaveBeenCalledExactlyOnceWith({
            url: 'chrome-extension://fixture/sidepanel.html', type: 'popup', width: 520, height: 680,
        });
        opening.resolve();
        await settle();
        command.emit('open-translation-window');
        await settle();
        expect(log).toHaveBeenCalledExactlyOnceWith('[FluentRead] 翻译窗口打开失败', error);
        command.emit('open-translation-window');
        expect(api.windows.create).toHaveBeenCalledTimes(3);
        expect(api.tabs.create).not.toHaveBeenCalled();
    });
    it('兼容 action 与 browserAction，缺少能力或默认面板时保持原入口', async () => {
        for (const mode of ['missing', 'no-setPopup', 'no-onClicked', 'no-popup', 'browserAction']) {
            delete api.action;delete api.browserAction;
            if (mode === 'no-setPopup') api.action = {onClicked: event()};
            if (mode === 'no-onClicked') api.action = {setPopup: action.setPopup};
            if (mode === 'no-popup') {api.action = action;api.runtime.getManifest.mockReturnValue({});}
            if (mode === 'browserAction') {api.browserAction = action;api.runtime.getManifest.mockReturnValue({browser_action: {default_popup: 'legacy.html'}});}
            installToolbarActionRuntime(states);await settle();
        }
        expect(action.onClicked.listeners).toHaveLength(1);
        expect(action.setPopup).toHaveBeenCalledExactlyOnceWith({popup: ''});
        change({toolbarClickAction: 'popup'});await settle();
        expect(action.setPopup).toHaveBeenLastCalledWith({popup: 'legacy.html'});
    });
    it('等待配置水合再处理首击，非翻译模式和无效标签不发翻译', async () => {
        const hydration = deferred<void>();env.ready = hydration.promise;env.config.toolbarClickAction = 'popup';
        installToolbarActionRuntime(states);click();await settle();expect(api.tabs.sendMessage).not.toHaveBeenCalled();
        env.config.toolbarClickAction = 'translate';hydration.resolve();await settle();expect(commands()).toHaveLength(1);
        for (const id of [undefined, -1, 1.5, '9']) action.onClicked.emit({id, url: 'https://example.com/article'});
        await settle();expect(commands()).toHaveLength(1);
        change({toolbarClickAction: 'popup'});click();await settle();expect(commands()).toHaveLength(1);
    });
    it('设置写入串行，最后选择胜出，无关配置变动不重写；失败可重试', async () => {
        const write = deferred<void>();action.setPopup.mockReturnValueOnce(write.promise);
        installToolbarActionRuntime(states);await settle();
        change({to: 'en'});change({toolbarClickAction: 'popup'});change({toolbarClickAction: 'translate'});
        expect(action.setPopup).toHaveBeenCalledTimes(1);write.resolve();await settle();
        expect(action.setPopup.mock.calls).toEqual([[{popup: ''}], [{popup: 'popup.html'}], [{popup: ''}]]);
        const error = new Error('native popup failed'), log = vi.spyOn(console, 'error').mockImplementation(() => {});
        action.setPopup.mockRejectedValueOnce(error);change({toolbarClickAction: 'popup'});await settle();
        expect(log).toHaveBeenCalledExactlyOnceWith('[FluentRead] 工具栏点击设置同步失败', error);
        change({toolbarClickAction: 'translate'});await settle();expect(action.setPopup).toHaveBeenLastCalledWith({popup: ''});
    });
    it('同页连续点击按真实状态翻译、恢复、再翻译，其他页互不阻塞', async () => {
        installToolbarActionRuntime(states);await settle();
        const read = deferred<any>();api.tabs.sendMessage.mockReturnValueOnce(read.promise);
        click();click();click();click(10);await settle();
        expect(commands().map(([id]: any[]) => id)).toEqual([10]);
        read.resolve({status: 'success', isTranslated: false});await settle();
        expect(commands().map(([id, message]: any[]) => [id, message.action])).toEqual([[10, 'fullPage'], [9, 'fullPage'], [9, 'restore'], [9, 'fullPage']]);
        expect(api.tabs.sendMessage.mock.calls.every(([, , target]: any[]) => target.frameId === 0)).toBe(true);
    });
    it('冷 worker 不依赖缓存，已翻译页面首击恢复', async () => {
        pageStates.set(9, true);installToolbarActionRuntime(states);click();await settle();
        expect(commands()[0][1].action).toBe('restore');expect(states.get(9).isTranslated).toBe(false);
    });
    it('标签页尚未提供 URL 时仍回源查询，不把未知页面当成 PDF', async () => {
        installToolbarActionRuntime(states);action.onClicked.emit({id: 9});await settle();
        expect(commands()).toHaveLength(1);expect(commands()[0][1].action).toBe('fullPage');
    });
    it('扩展关闭打开来源固定的面板，站点停用只给出提示且不改配置', async () => {
        env.config.on = false;installToolbarActionRuntime(states);click();await settle();
        expect(api.tabs.create).toHaveBeenCalledExactlyOnceWith({url: 'chrome-extension://fixture/popup.html?sourceTabId=9'});
        change({on: true, disabledExtensionDomains: ['example.com']});click();await settle();
        expect(env.feedback).toHaveBeenCalledWith(9, {}, 'disabled', expect.any(Function));
        expect(api.tabs.sendMessage).not.toHaveBeenCalled();expect(env.config.disabledExtensionDomains).toEqual(['example.com']);
    });
    it('PDF 复用阅读器入口，不等待不存在的内容脚本', async () => {
        installToolbarActionRuntime(states);click(9, 'https://example.com/paper.pdf');await settle();
        expect(api.tabs.sendMessage).not.toHaveBeenCalled();expect(api.tabs.create.mock.calls[0][0].url).toContain('/document.html#pdf=');
        expect(api.tabs.create.mock.calls[0][0].url).toContain('paper.pdf');
    });
    it.each([undefined, {status: 'failed'}, {status: 'disabled'}])('不成功的状态回复 %j 不启动翻译', async response => {
        installToolbarActionRuntime(states);api.tabs.sendMessage.mockResolvedValueOnce(response);click();await settle();
        expect(commands()).toHaveLength(0);expect(env.feedback).toHaveBeenCalledWith(9, {}, response?.status === 'disabled' ? 'disabled' : 'unavailable', expect.any(Function));
    });
    it('动作拒绝显示失败反馈，后续点击仍可重试', async () => {
        installToolbarActionRuntime(states);api.tabs.sendMessage.mockResolvedValueOnce({status: 'success'}).mockResolvedValueOnce({status: 'failed'});
        click();await settle();expect(env.feedback).toHaveBeenCalledWith(9, {}, 'failed', expect.any(Function));
        click();await settle();expect(commands()).toHaveLength(2);
    });
    it('无接收者打开面板，面板创建失败保留诊断，下一次仍可使用', async () => {
        const error = new Error('tab unavailable'), log = vi.spyOn(console, 'error').mockImplementation(() => {});
        installToolbarActionRuntime(states);api.tabs.sendMessage.mockRejectedValueOnce(error);api.tabs.create.mockRejectedValueOnce(error);
        click();await settle();expect(log).toHaveBeenCalledExactlyOnceWith('[FluentRead] 快捷面板打开失败', error);
        click();await settle();expect(commands()).toHaveLength(1);
    });
    it.each(['navigate', 'close', 'mode'])('%s 期间迟到的查询或拒绝不向其他文档发命令或打开面板', async mode => {
        installToolbarActionRuntime(states);const read = deferred<any>();api.tabs.sendMessage.mockReturnValueOnce(read.promise);
        click();click();await settle();
        if (mode === 'navigate') api.tabs.onUpdated.emit(9, {status: 'loading'});
        if (mode === 'close') api.tabs.onRemoved.emit(9);
        if (mode === 'mode') change({toolbarClickAction: 'popup'});
        read.resolve({status: 'success', isTranslated: false});await settle();
        expect(commands()).toHaveLength(0);expect(api.tabs.create).not.toHaveBeenCalled();
    });
    it('导航后的新页不等旧页查询，非加载更新保留原队列', async () => {
        installToolbarActionRuntime(states);const read = deferred<any>();api.tabs.sendMessage.mockReturnValueOnce(read.promise);
        click();await settle();api.tabs.onUpdated.emit(9, {status: 'complete'});click();await settle();expect(commands()).toHaveLength(0);
        api.tabs.onUpdated.emit(9, {status: 'loading'});click();await settle();expect(commands()).toHaveLength(1);
        read.resolve({status: 'success'});await settle();expect(commands()).toHaveLength(1);
    });
    it('动作开始后的导航抑制迟到失败反馈', async () => {
        installToolbarActionRuntime(states);const actionReply = deferred<any>();
        api.tabs.sendMessage.mockResolvedValueOnce({status: 'success'}).mockReturnValueOnce(actionReply.promise);
        click();await settle();api.tabs.onUpdated.emit(9, {status: 'loading'});actionReply.resolve({status: 'failed'});await settle();
        expect(env.feedback).not.toHaveBeenCalled();
    });
    it('导航时的消息拒绝不打开新面板', async () => {
        installToolbarActionRuntime(states);let reject!: (error: Error) => void;
        api.tabs.sendMessage.mockReturnValueOnce(new Promise((_, no) => {reject = no;}));
        click();await settle();api.tabs.onRemoved.emit(9);reject(new Error('closed'));await settle();
        expect(api.tabs.create).not.toHaveBeenCalled();
    });
    it.each(['query', 'action'])('%s 超时释放队列，不自动重发翻译', async phase => {
        vi.useFakeTimers();installToolbarActionRuntime(states);
        if (phase === 'action') api.tabs.sendMessage.mockResolvedValueOnce({status: 'success'});
        api.tabs.sendMessage.mockReturnValueOnce(new Promise(() => {}));click();await settle();
        await vi.advanceTimersByTimeAsync(phase === 'query' ? 3000 : 5000);await settle();
        expect(api.tabs.create).toHaveBeenCalledOnce();expect(commands()).toHaveLength(phase === 'query' ? 0 : 1);
        click();await settle();expect(commands()).toHaveLength(phase === 'query' ? 1 : 2);expect(vi.getTimerCount()).toBe(0);
    });
    it('面板 URL 绑定原网页而非新标签页', async () => {
        await openToolbarQuickPanel(123);expect(api.tabs.create).toHaveBeenCalledWith({url: 'chrome-extension://fixture/popup.html?sourceTabId=123'});
    });
    it('一键翻译模式下同步悬停提示，切回快捷面板恢复默认提示并响应界面语言切换', async () => {
        action.setTitle = vi.fn().mockResolvedValue(undefined);
        api.runtime.getManifest.mockReturnValue({action: {default_popup: 'popup.html', default_title: '流畅阅读 · 网页翻译、划词翻译'}});
        installToolbarActionRuntime(states);await settle();
        expect(action.setTitle).toHaveBeenLastCalledWith({title: '流畅阅读 · 单击翻译 / 原文，右键可打开快捷面板和菜单栏'});
        expect(action.setPopup).toHaveBeenCalledTimes(1);

        change({uiLanguage: 'en-US'});await settle();
        expect(action.setPopup).toHaveBeenCalledTimes(1);
        expect(action.setTitle).toHaveBeenLastCalledWith({title: 'FluentRead · Click to translate / restore, right-click for quick panel and menu'});

        change({toolbarClickAction: 'popup'});await settle();
        expect(action.setTitle).toHaveBeenLastCalledWith({title: '流畅阅读 · 网页翻译、划词翻译'});

        const titleCalls = action.setTitle.mock.calls.length;
        change({uiLanguage: 'ja-JP'});await settle();
        expect(action.setTitle).toHaveBeenCalledTimes(titleCalls);
    });
    it('未解析的 manifest 占位符和 MV2 browser_action 默认提示均可正确回退并响应语言切换', async () => {
        action.setTitle = vi.fn().mockResolvedValue(undefined);
        env.config.toolbarClickAction = 'popup';
        api.runtime.getManifest.mockReturnValue({action: {default_popup: 'popup.html', default_title: '__MSG_extensionToolbarTitle__'}});
        installToolbarActionRuntime(states);await settle();
        expect(action.setTitle).toHaveBeenLastCalledWith({title: '流畅阅读 · 网页翻译、划词翻译'});

        change({uiLanguage: 'en-US'});await settle();
        expect(action.setTitle).toHaveBeenLastCalledWith({title: 'FluentRead · Translate pages and selected text'});

        delete api.action;
        const legacySetTitle = vi.fn().mockResolvedValue(undefined);
        api.browserAction = {setPopup: vi.fn().mockResolvedValue(undefined), setTitle: legacySetTitle, onClicked: event()};
        api.runtime.getManifest.mockReturnValue({browser_action: {default_popup: 'legacy.html', default_title: 'Legacy Title'}});
        installToolbarActionRuntime(states);await settle();
        expect(legacySetTitle).toHaveBeenLastCalledWith({title: 'Legacy Title'});
    });
    it('悬停提示同步丢弃过期更新，写入失败记录诊断且后续切换仍可恢复', async () => {
        const firstWrite = deferred<void>();
        const bundleLoad = deferred<boolean>();
        action.setTitle = vi.fn().mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        api.runtime.getManifest.mockReturnValue({action: {default_popup: 'popup.html', default_title: 'Default Title'}});
        installToolbarActionRuntime(states);await settle();

        change({toolbarClickAction: 'popup'});
        change({toolbarClickAction: 'translate', uiLanguage: 'ja-JP'});
        env.ensureBundle.mockReturnValueOnce(bundleLoad.promise);
        firstWrite.resolve();await settle();
        change({toolbarClickAction: 'popup'});
        bundleLoad.resolve(true);await settle();
        expect(action.setTitle.mock.calls).toEqual([
            [{title: '流畅阅读 · 单击翻译 / 原文，右键可打开快捷面板和菜单栏'}],
            [{title: 'Default Title'}],
        ]);

        const error = new Error('native title failed'), log = vi.spyOn(console, 'error').mockImplementation(() => {});
        action.setTitle.mockRejectedValueOnce(error);
        change({toolbarClickAction: 'translate', uiLanguage: 'zh-CN'});await settle();
        expect(log).toHaveBeenCalledExactlyOnceWith('[FluentRead] 工具栏提示同步失败', error);

        change({toolbarClickAction: 'popup'});await settle();
        expect(action.setTitle).toHaveBeenLastCalledWith({title: 'Default Title'});
    });
    it('工具栏提示八语言目录保持键集完整且不包含换行符', () => {
        expect(toolbarActionMessages['zh-CN']).toBe(toolbarActionChineseMessages);
        expect(Object.keys(toolbarActionMessages).sort()).toEqual(UI_LANGUAGE_OPTIONS.map(({value}) => value).sort());
        for (const catalog of Object.values(toolbarActionMessages)) {
            expect(Object.keys(catalog).sort()).toEqual(['toolbar.title.default', 'toolbar.title.translate']);
            for (const text of Object.values(catalog)) {
                expect(text.trim()).toBe(text);
                expect(text.length).toBeGreaterThan(0);
                expect(text).not.toMatch(/[\r\n]/u);
            }
        }
    });
});
