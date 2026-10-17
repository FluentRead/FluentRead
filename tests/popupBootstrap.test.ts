import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const ports = vi.hoisted(() => ({
    config: {uiLanguageSetupCompleted: false, uiLanguage: 'en-US', interfaceFont: 'system'},
    ready: Promise.resolve() as Promise<void>, hydration: 'ready' as 'loading' | 'ready' | 'blocked',
    mainGate: undefined as Promise<void> | undefined, onboardingGate: undefined as Promise<void> | undefined,
    mainLoaded: vi.fn(), onboardingLoaded: vi.fn(), ensureBundle: vi.fn(async (_language: unknown) => {}), font: vi.fn(async (_font: unknown) => {}),
    browser: 'chrome', platform: vi.fn(), unmountCallbacks: [] as Array<()=>void>,
    createApp: vi.fn(), plugin: vi.fn(() => ({kind: 'i18n'})), use: vi.fn(), component: vi.fn(), mount: vi.fn(),
}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {getPlatformInfo: ports.platform}}}));
vi.mock('../src/platform/browser/capabilities', () => ({browserCapabilities: {get browser() {return ports.browser;}}}));
vi.mock('vue', () => ({createApp: ports.createApp}));
vi.mock('element-plus/es/components/base/style/css', () => ({}));
vi.mock('@element-plus/icons-vue', () => ({Coffee: {kind: 'coffee'}}));
vi.mock('../src/services/config/store', () => ({config: ports.config, get configReady() {return ports.ready;}, getConfigHydrationStatus: () => ports.hydration}));
vi.mock('../src/ui/i18n', () => ({createUiI18nPlugin: ports.plugin}));
vi.mock('../src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: ports.ensureBundle}));
vi.mock('../src/ui/interfaceAppearance', () => ({prepareInterfaceFont: ports.font}));
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}
type Bootstrap = typeof import('../src/app/popup/mount');
let bootstrap: Bootstrap;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); ports.ready = Promise.resolve(); ports.hydration = 'ready'; ports.mainGate = undefined; ports.onboardingGate = undefined;
    Object.assign(ports.config, {uiLanguageSetupCompleted: false, uiLanguage: 'en-US', interfaceFont: 'system'});
    ports.font.mockReset().mockResolvedValue(undefined); ports.ensureBundle.mockReset().mockResolvedValue(undefined);
    ports.browser='chrome';ports.platform.mockReset().mockResolvedValue({os:'mac'});ports.unmountCallbacks=[];
    ports.mount.mockReset();ports.createApp.mockReturnValue({use: ports.use, component: ports.component, mount: ports.mount,onUnmount: (fn:()=>void)=>ports.unmountCallbacks.push(fn)});
    vi.stubGlobal('document', parseHTML('<html><body></body></html>').document);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', {language: 'zh-CN'});
    vi.doMock('../src/app/popup/PopupApp.vue', async () => {ports.mainLoaded(); await ports.mainGate; return {default: {kind: 'main'}};});
    vi.doMock('../src/app/popup/PopupOnboarding.vue', async () => {ports.onboardingLoaded(); await ports.onboardingGate; return {default: {kind: 'onboarding'}};});
    bootstrap = await import('../src/app/popup/mount');
});
afterEach(() => {ports.unmountCallbacks.forEach(fn=>fn());vi.unstubAllGlobals();});

describe('Popup fresh configuration bootstrap', () => {
    it.each([false,true])('Safari coarse 对首次完成=%s 的根启用自有填宽且卸载释放',async completed=>{
        ports.browser='safari';ports.config.uiLanguageSetupCompleted=completed;
        const matchMedia=vi.fn(()=>({matches:true}));vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia}));
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(matchMedia).toHaveBeenCalledOnce();expect(matchMedia).toHaveBeenCalledWith('(any-pointer: coarse)');expect(ports.platform).not.toHaveBeenCalled();
        expect(document.documentElement.getAttribute('data-fluentread-safari-touch-popup')).toBe('');
        expect(ports.createApp).toHaveBeenCalledWith({kind:completed?'main':'onboarding'});
        ports.unmountCallbacks.forEach(fn=>fn());expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);
    });
    it.each(['chrome','firefox','thunderbird'])('%s coarse 不探测或取得 Safari 填宽标记',async browser=>{
        ports.browser=browser;const matchMedia=vi.fn(()=>({matches:true}));vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia}));
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(matchMedia).not.toHaveBeenCalled();expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);
    });
    it.each(['fine','missing','throws','no-window'])('Safari %s 输入能力保留固有宽度且不阻塞配置挂载',async mode=>{
        ports.browser='safari';const matchMedia=vi.fn(()=>{if(mode==='throws')throw Error('media unavailable');return {matches:false};});
        vi.stubGlobal('window',mode==='no-window'?undefined:mode==='missing'?new EventTarget():Object.assign(new EventTarget(),{matchMedia}));
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.mount).toHaveBeenCalledOnce();expect(ports.platform).not.toHaveBeenCalled();
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);
    });
    it('Safari 标记不等待配置；pending 配置退出后不重新写回或挂载',async()=>{
        ports.browser='safari';const gate=deferred();ports.ready=gate.promise;
        const matchMedia=vi.fn(()=>({matches:true}));const target=Object.assign(new EventTarget(),{matchMedia});vi.stubGlobal('window',target);
        vi.resetModules();bootstrap=await import('../src/app/popup/mount');
        const pending=bootstrap.mountPreparedPopupApp('#owned');
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(true);expect(ports.createApp).not.toHaveBeenCalled();
        target.dispatchEvent(new Event('pagehide'));gate.resolve();await pending;
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);expect(ports.createApp).not.toHaveBeenCalled();expect(matchMedia).toHaveBeenCalledOnce();
    });
    it('Safari 输入能力返回前已退出时不取得过期标记',async()=>{
        ports.browser='safari';const target=new EventTarget();
        vi.stubGlobal('window',Object.assign(target,{matchMedia:vi.fn(()=>{target.dispatchEvent(new Event('pagehide'));return {matches:true};})}));
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);expect(ports.createApp).not.toHaveBeenCalled();
    });
    it.each(['mount-failure','config-failure','hydration-blocked'] as const)('Safari %s 清理已取得的填宽标记',async reason=>{
        ports.browser='safari';vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia:vi.fn(()=>({matches:true}))}));
        if(reason==='mount-failure')ports.mount.mockImplementation(()=>{throw Error('mount failed');});
        if(reason==='config-failure'){ports.ready=Promise.reject(Error('config failed'));ports.ready.catch(()=>{});vi.resetModules();bootstrap=await import('../src/app/popup/mount');}
        if(reason==='hydration-blocked')ports.hydration='blocked';
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toThrow();
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);
    });
    it('Safari pagehide 清理自有标记与监听，随后卸载重复释放安全',async()=>{
        ports.browser='safari';const target=Object.assign(new EventTarget(),{matchMedia:vi.fn(()=>({matches:true}))});vi.stubGlobal('window',target);
        const remove=vi.spyOn(target,'removeEventListener');await bootstrap.mountPreparedPopupApp('#owned');target.dispatchEvent(new Event('pagehide'));
        expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);expect(remove).toHaveBeenCalledWith('pagehide',expect.any(Function));
        ports.unmountCallbacks.forEach(fn=>fn());expect(document.documentElement.hasAttribute('data-fluentread-safari-touch-popup')).toBe(false);
    });
    it.each(['pagehide','unmount','mount-failure'])('Safari %s 不改写或移除预存宿主标记',async reason=>{
        ports.browser='safari';const target=Object.assign(new EventTarget(),{matchMedia:vi.fn(()=>({matches:true}))});vi.stubGlobal('window',target);
        document.documentElement.setAttribute('data-fluentread-safari-touch-popup','external-owner');
        if(reason==='mount-failure')ports.mount.mockImplementation(()=>{throw Error('mount failed');});
        const pending=bootstrap.mountPreparedPopupApp('#owned');
        if(reason==='mount-failure')await expect(pending).rejects.toThrow('mount failed');else await pending;
        if(reason==='pagehide')target.dispatchEvent(new Event('pagehide'));if(reason==='unmount')ports.unmountCallbacks.forEach(fn=>fn());
        expect(document.documentElement.getAttribute('data-fluentread-safari-touch-popup')).toBe('external-owner');
    });

    it.each([false,true])('Android 固定容器对首次完成=%s 的独立根共享一次公开平台判别',async completed=>{
        ports.browser='firefox';ports.platform.mockResolvedValue({os:'android'});ports.config.uiLanguageSetupCompleted=completed;
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.platform).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(true);
        expect(ports.createApp).toHaveBeenCalledWith({kind:completed?'main':'onboarding'});
        ports.unmountCallbacks.forEach(fn=>fn());expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it.each(['mac','win','linux','unknown'])('Firefox %s 平台保持工具栏固有宽度',async os=>{
        ports.browser='firefox';ports.platform.mockResolvedValue({os});await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.platform).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it.each(['chrome','safari','thunderbird'])('%s 不调用额外平台 API 或改变 popup 宽度模式',async browser=>{
        ports.browser=browser;ports.platform.mockResolvedValue({os:'android'});await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.platform).not.toHaveBeenCalled();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it('平台查询不结算不阻塞首启挂载，迟到 Android 回复可在菜单/旋转后启用当前 CSS 视口约束',async()=>{
        ports.browser='firefox';let resolve!: (value:{os:string})=>void;ports.platform.mockReturnValue(new Promise(yes=>{resolve=yes;}));
        await bootstrap.mountPreparedPopupApp('#owned');expect(ports.mount).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
        window.dispatchEvent(new Event('orientationchange'));resolve({os:'android'});await Promise.resolve();
        expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(true);expect(ports.platform).toHaveBeenCalledOnce();
    });
    it('平台查询失败保留首启挂载且不重试',async()=>{
        ports.browser='firefox';ports.platform.mockRejectedValue(Error('platform unavailable'));await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.mount).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);expect(ports.platform).toHaveBeenCalledOnce();
    });
    it.each(['pagehide','unmount','mount-failure','config-failure','hydration-blocked'] as const)('%s 后迟到平台回复不能写回根标记',async reason=>{
        ports.browser='firefox';let resolve!: (value:{os:string})=>void;ports.platform.mockReturnValue(new Promise(yes=>{resolve=yes;}));
        if(reason==='mount-failure')ports.mount.mockImplementation(()=>{throw Error('mount failed');});
        if(reason==='config-failure'){ports.ready=Promise.reject(Error('config failed'));ports.ready.catch(()=>{});vi.resetModules();bootstrap=await import('../src/app/popup/mount');}
        if(reason==='hydration-blocked')ports.hydration='blocked';
        const pending=bootstrap.mountPreparedPopupApp('#owned');if(reason.endsWith('failure')||reason==='hydration-blocked')await expect(pending).rejects.toThrow();else await pending;
        if(reason==='pagehide')window.dispatchEvent(new Event('pagehide'));if(reason==='unmount')ports.unmountCallbacks.forEach(fn=>fn());
        resolve({os:'android'});await Promise.resolve();expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it('pagehide 移除本入口持有的标记与监听，卸载重复释放安全',async()=>{
        ports.browser='firefox';ports.platform.mockResolvedValue({os:'android'});const remove=vi.spyOn(window,'removeEventListener');await bootstrap.mountPreparedPopupApp('#owned');
        window.dispatchEvent(new Event('pagehide'));expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);expect(remove).toHaveBeenCalledWith('pagehide',expect.any(Function));
        ports.unmountCallbacks.forEach(fn=>fn());expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it('挂载失败释放已建立的 Android 标记',async()=>{
        ports.browser='firefox';ports.platform.mockResolvedValue({os:'android'});ports.mount.mockImplementation(()=>{throw Error('mount failed');});
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toThrow('mount failed');expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(false);
    });
    it('卸载不移除其它宿主已经持有的容器标记',async()=>{
        ports.browser='firefox';ports.platform.mockResolvedValue({os:'android'});document.documentElement.setAttribute('data-fluentread-android-popup','');
        await bootstrap.mountPreparedPopupApp('#owned');ports.unmountCallbacks.forEach(fn=>fn());expect(document.documentElement.hasAttribute('data-fluentread-android-popup')).toBe(true);
    });

    it('无 Window 宿主时仍可按配置组装并由 app 卸载释放',async()=>{
        vi.stubGlobal('window',undefined);await bootstrap.mountPreparedPopupApp('#owned');expect(ports.mount).toHaveBeenCalledWith('#owned');
        ports.unmountCallbacks.forEach(fn=>fn());
    });
    it('waits for fresh configuration before importing or creating a root', async () => {
        const gate = deferred(); ports.ready = gate.promise;
        // Re-import the actual module after configuring its hydration port.
        vi.resetModules(); bootstrap = await import('../src/app/popup/mount');
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await Promise.resolve();
        expect(ports.onboardingLoaded).not.toHaveBeenCalled(); expect(ports.createApp).not.toHaveBeenCalled();
        ports.config.uiLanguageSetupCompleted = true; gate.resolve(); await pending;
        expect(ports.createApp).toHaveBeenCalledWith({kind: 'main'});
    });
    it('loads only the onboarding root, prepares its font and registers normal UI ports', async () => {
        await bootstrap.mountPreparedPopupApp('#owned');
        expect(ports.mainLoaded).not.toHaveBeenCalled(); expect(ports.ensureBundle).not.toHaveBeenCalled();
        expect(ports.font).toHaveBeenCalledWith('system'); expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
        expect(ports.plugin).toHaveBeenCalledWith({documentRoot: document.body, documentTitleKey: 'metadata.popupTitle'});
        expect(ports.use).toHaveBeenCalledWith({kind: 'i18n'}); expect(ports.component).toHaveBeenCalledWith('Coffee', {kind: 'coffee'});
        expect(ports.mount).toHaveBeenCalledWith('#owned');
    });
    it.each(['loading', 'blocked'] as const)('rejects resolved configuration with %s hydration before importing a root or preparing assets', async hydration => {
        ports.hydration = hydration;
        const remove = vi.spyOn(window, 'removeEventListener');
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toThrow('Popup configuration is not ready');
        expect(ports.mainLoaded).not.toHaveBeenCalled(); expect(ports.onboardingLoaded).not.toHaveBeenCalled();
        expect(ports.font).not.toHaveBeenCalled(); expect(ports.ensureBundle).not.toHaveBeenCalled(); expect(ports.createApp).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    });
    it.each(['main', 'onboarding', 'font', 'language'] as const)('rechecks blocked hydration after pending %s resources and cleans its exit listener', async resource => {
        ports.config.uiLanguageSetupCompleted = resource !== 'onboarding';
        const gate = deferred(), remove = vi.spyOn(window, 'removeEventListener');
        if (resource === 'main') ports.mainGate = gate.promise;
        if (resource === 'onboarding') ports.onboardingGate = gate.promise;
        if (resource === 'font') ports.font.mockReturnValueOnce(gate.promise);
        if (resource === 'language') ports.ensureBundle.mockReturnValueOnce(gate.promise);
        const pending = bootstrap.mountPreparedPopupApp('#owned');
        const outcome = expect(pending).rejects.toThrow('Popup configuration is not ready');
        const called = resource === 'main' ? ports.mainLoaded : resource === 'onboarding' ? ports.onboardingLoaded : resource === 'font' ? ports.font : ports.ensureBundle;
        await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
        ports.hydration = 'blocked'; gate.resolve(); await outcome;
        expect(ports.createApp).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    });
    it('routes blocked hydration through the actual startup error UI and its explicit reopen button', async () => {
        const dom = parseHTML('<html><body><div id="owned">Original startup</div></body></html>');
        vi.stubGlobal('document', dom.document);
        const reload = vi.fn(); vi.stubGlobal('location', {reload}); ports.hydration = 'blocked';
        const {mountPopupApp} = await import('../src/app/popup/index');
        await mountPopupApp('#owned');
        const root = dom.document.querySelector('#owned')!;
        expect(root.textContent).toContain('暂时无法打开流畅阅读'); expect(root.textContent).toContain('偏好会保留');
        expect(root.textContent).not.toMatch(/Popup configuration|Error|stack/);
        expect(root.querySelectorAll('button')).toHaveLength(1); expect(ports.createApp).not.toHaveBeenCalled();
        root.querySelector('button')!.dispatchEvent(new dom.window.Event('click')); expect(reload).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event('pagehide'));
    });
    it('preserves the no-window lifecycle boundary while mounting a genuinely ready configuration', async () => {
        vi.stubGlobal('window', undefined);
        await bootstrap.mountPreparedPopupApp('#owned'); expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
    });
    it('prepares the selected language and font before mounting the main root', async () => {
        ports.config.uiLanguageSetupCompleted = true; const gate = deferred(); ports.ensureBundle.mockReturnValueOnce(gate.promise);
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.mainLoaded).toHaveBeenCalledOnce());
        expect(ports.createApp).not.toHaveBeenCalled(); gate.resolve(); await pending;
        expect(ports.ensureBundle).toHaveBeenCalledWith('en-US'); expect(ports.createApp).toHaveBeenCalledWith({kind: 'main'});
    });
    it('uses the latest completed setup when hydration changes during module loading', async () => {
        const gate = deferred(); ports.onboardingGate = gate.promise;
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.onboardingLoaded).toHaveBeenCalledOnce());
        ports.config.uiLanguageSetupCompleted = true; gate.resolve(); await pending;
        expect(ports.createApp).toHaveBeenCalledOnce(); expect(ports.createApp).toHaveBeenCalledWith({kind: 'main'});
        expect(ports.ensureBundle).toHaveBeenCalledWith('en-US');
    });
    it('uses onboarding if settings are reset while the main root is loading', async () => {
        ports.config.uiLanguageSetupCompleted = true; const gate = deferred(); ports.mainGate = gate.promise;
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.mainLoaded).toHaveBeenCalledOnce());
        ports.config.uiLanguageSetupCompleted = false; gate.resolve(); await pending;
        expect(ports.createApp).toHaveBeenCalledOnce(); expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
    });
    it('checks a second setup change during the newly required import before mounting once', async () => {
        const onboarding = deferred(); const main = deferred(); ports.onboardingGate = onboarding.promise; ports.mainGate = main.promise;
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.onboardingLoaded).toHaveBeenCalledOnce());
        ports.config.uiLanguageSetupCompleted = true; onboarding.resolve();
        await vi.waitFor(() => expect(ports.mainLoaded).toHaveBeenCalledOnce()); ports.config.uiLanguageSetupCompleted = false; main.resolve();
        await pending; expect(ports.createApp).toHaveBeenCalledOnce(); expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
        expect(ports.onboardingLoaded).toHaveBeenCalledOnce(); expect(ports.mainLoaded).toHaveBeenCalledOnce();
    });
    it('prepares the latest language if it changes while the root is loading', async () => {
        ports.config.uiLanguageSetupCompleted = true; const gate = deferred(); ports.mainGate = gate.promise;
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.mainLoaded).toHaveBeenCalledOnce());
        ports.config.uiLanguage = 'ja-JP'; gate.resolve(); await pending;
        expect(ports.ensureBundle.mock.calls.map(([language]) => language)).toEqual(['en-US', 'ja-JP']);
        expect(ports.font).toHaveBeenCalledOnce(); expect(ports.createApp).toHaveBeenCalledOnce();
    });
    it('waits for a newly selected font without preparing the unchanged language again', async () => {
        ports.config.uiLanguageSetupCompleted = true; const root = deferred(); const font = deferred(); ports.mainGate = root.promise;
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.mainLoaded).toHaveBeenCalledOnce());
        ports.config.interfaceFont = 'inter'; ports.font.mockReturnValueOnce(font.promise); root.resolve();
        await vi.waitFor(() => expect(ports.font).toHaveBeenCalledTimes(2)); expect(ports.createApp).not.toHaveBeenCalled();
        font.resolve(); await pending; expect(ports.font).toHaveBeenLastCalledWith('inter');
        expect(ports.ensureBundle).toHaveBeenCalledOnce(); expect(ports.createApp).toHaveBeenCalledOnce();
    });
    it('does not mount after its page leaves during configuration hydration', async () => {
        const target = new EventTarget(); vi.stubGlobal('window', target); const remove = vi.spyOn(target, 'removeEventListener');
        const gate = deferred(); ports.ready = gate.promise; vi.resetModules(); bootstrap = await import('../src/app/popup/mount');
        const pending = bootstrap.mountPreparedPopupApp('#owned'); target.dispatchEvent(new Event('pagehide')); gate.resolve(); await pending;
        expect(ports.createApp).not.toHaveBeenCalled(); expect(ports.font).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    });
    it('does not mount after its page leaves during asset preparation', async () => {
        const target = new EventTarget(); vi.stubGlobal('window', target); const remove = vi.spyOn(target, 'removeEventListener');
        const gate = deferred(); ports.font.mockReturnValueOnce(gate.promise);
        const pending = bootstrap.mountPreparedPopupApp('#owned'); await vi.waitFor(() => expect(ports.font).toHaveBeenCalledOnce());
        target.dispatchEvent(new Event('pagehide')); ports.hydration = 'blocked'; gate.resolve(); await pending;
        expect(ports.createApp).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    });
    it('does not create an app when configuration hydration fails', async () => {
        ports.ready = Promise.reject(new Error('config failed')); ports.ready.catch(() => {});
        vi.resetModules(); bootstrap = await import('../src/app/popup/mount');
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toThrow('config failed'); expect(ports.createApp).not.toHaveBeenCalled();
    });
    it.each(['font', 'language'])('does not mount before required %s preparation succeeds', async type => {
        ports.config.uiLanguageSetupCompleted = true;
        (type === 'font' ? ports.font : ports.ensureBundle).mockRejectedValueOnce(new Error('asset failed'));
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toThrow('asset failed'); expect(ports.createApp).not.toHaveBeenCalled();
    });
    it('does not mount when its chosen root cannot be loaded', async () => {
        ports.config.uiLanguageSetupCompleted = true; ports.mainGate = Promise.reject(new Error('root import failed')); ports.mainGate.catch(() => {});
        await expect(bootstrap.mountPreparedPopupApp('#owned')).rejects.toMatchObject({cause: {message: 'root import failed'}}); expect(ports.createApp).not.toHaveBeenCalled();
    });
    it('ignores unsuccessful startup hints and still mounts from actual configuration', async () => {
        vi.stubGlobal('__fluentReadPopupWarmup', Promise.resolve({success: false, uiLanguageSetupCompleted: true}));
        const {mountPopupApp} = await import('../src/app/popup/index'); await mountPopupApp('#owned');
        expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'}); expect(ports.mainLoaded).not.toHaveBeenCalled();
    });
    it('consumes a failed startup Promise without preventing the actual root mount', async () => {
        vi.stubGlobal('browser', {runtime: {sendMessage: () => Promise.reject(new Error('startup failed'))}});
        const {mountPopupApp} = await import('../src/app/popup/index'); await mountPopupApp('#owned');
        expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
    });
    it('accepts the successful Chrome callback hint without using it as the mounting configuration', async () => {
        vi.stubGlobal('browser', undefined);
        const sendMessage = vi.fn((_message: unknown, callback: (value: unknown) => void) => callback({success: true, uiLanguageSetupCompleted: true}));
        vi.stubGlobal('chrome', {runtime: {sendMessage}});
        const {mountPopupApp} = await import('../src/app/popup/index'); await mountPopupApp('#owned'); await vi.dynamicImportSettled();
        expect(sendMessage).toHaveBeenCalledOnce(); expect(ports.mainLoaded).toHaveBeenCalledOnce();
        expect(ports.createApp).toHaveBeenCalledWith({kind: 'onboarding'});
    });
});
