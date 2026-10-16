import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {compileVueFixture} from './helpers/compiledVueFixture';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const key = '__frSettingsSectionsLifecycle';
let server: ViteDevServer | undefined, app: import('vue').App | undefined;
afterEach(async () => {app?.unmount(); app = undefined; await server?.close();server = undefined;
    delete (globalThis as Record<string, unknown>)[key];vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
async function settle() {await runtime.nextTick();for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick();}
function compileClientTemplate(component: any, relative: string) {
    const filename = resolve(process.cwd(), relative);
    const {renderCode} = compileVueFixture(filename, {id: 'sections-lifecycle-template', cacheHandlers: true});
    component.ssrRender = undefined;
    component.render = new Function('Vue', renderCode)(runtime);
}

// 实际父/子 SFC 模板使用 LinkeDOM 节点和事件；Element Plus 弹窗动画、浏览器焦点由根任务真实浏览器复验。
function createDomRenderer(document: Document, focus: ReturnType<typeof vi.fn>) {
    return runtime.createRenderer({patchProp(element: any, name: string, previous: any, next: any) {
        if (name === 'class') {element.className = String(next ?? '');return;}
        if (name === 'value') {element.value = next ?? '';return;}
        if (name === 'style') {Object.assign(element.style, next ?? {});return;}
        if (/^on[A-Z]/u.test(name)) {
            const event = name.slice(2).toLowerCase();
            if (previous) element.removeEventListener(event, previous);
            if (next) element.addEventListener(event, next);
        } else if (next === undefined || next === null || next === false) element.removeAttribute(name);
        else element.setAttribute(name, String(next));
    }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
    remove: (node: any) => node.parentNode?.removeChild(node), createElement: (name: string) => {
        const node = document.createElement(name);if (name === 'input') node.focus = focus;
        // LinkeDOM 的 select.value 只有 getter；在 DOM 端口补齐浏览器的可写选值契约。
        if (name === 'select') Object.defineProperty(node, 'value', {configurable: true,
            get: () => node.querySelector('option[selected]')?.getAttribute('value') ?? '',
            set: (value: string) => node.querySelectorAll('option').forEach(option => option.toggleAttribute('selected', option.getAttribute('value') === String(value)))});
        if (name === 'details') Object.defineProperty(node, 'open', {configurable: true,
            get: () => node.hasAttribute('open'), set: (value: boolean) => node.toggleAttribute('open', value)});
        return node;
    }, createText: (value: string) => document.createTextNode(value), createComment: (value: string) => document.createComment(value),
    setText: (node: any, value: string) => {node.nodeValue = value;}, setElementText: (node: any, value: string) => {node.textContent = value;},
    parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
    querySelector: (value: string) => document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (content: string, parent: any, anchor: any) => {
        const template = document.createElement('template');template.innerHTML = content;
        const first = template.content.firstChild, last = template.content.lastChild;
        parent.insertBefore(template.content, anchor);return [first, last];
    }});
}

type NumericChange = (value: number | undefined) => void;
type NumericPort = {disabled: boolean; change: NumericChange};

async function mountSections({ready = Promise.resolve(), configSnapshot, template = false, providerGate = Promise.resolve(), activeSection = 'settings-translation', requestLimits = false, development = false, serviceSelectors = false, search = '', repairReturn = false, browserName = 'chrome'}:
    {ready?: Promise<void>; configSnapshot?: Record<string, unknown>; template?: boolean; providerGate?: Promise<void>; activeSection?: string; requestLimits?: boolean; development?: boolean; serviceSelectors?: boolean; search?: string; repairReturn?: boolean; browserName?: string} = {}) {
    const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
    const query = vi.fn((_options: Record<string, unknown>) => Promise.resolve([] as {id?: number}[]));
    const send = vi.fn((_id: number, _message: {type: string; isEnabled?: boolean; mode?: string}) => Promise.resolve());
    const patch = vi.fn(() => Promise.resolve());const theme = vi.fn();const unsubscribe = vi.fn();
    const media = {matches: false, onchange: null as (() => void) | null};
    const location = {hash: '', search, protocol: 'chrome-extension:'};
    if (repairReturn) vi.stubGlobal('location', {href: `chrome-extension://fixture/options.html${search}`});
    vi.stubGlobal('window', Object.assign(new EventTarget(), {location, navigator: {userAgent: ''}, matchMedia: () => media,
        requestAnimationFrame: (fn: FrameRequestCallback) => {frames.set(++nextFrame, fn);return nextFrame;},
        cancelAnimationFrame: (id: number) => frames.delete(id)}));
    const findTarget = vi.fn(() => null as HTMLElement | null);
    const dom = template ? parseHTML('<html><body><main id="fixture"></main></body></html>') : undefined;
    vi.stubGlobal('document', dom?.document ?? {querySelector: findTarget});
    if (dom) vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    const focus = vi.fn(), providerMounted = vi.fn(), providerUnmounted = vi.fn();
    const numericPorts = new Map<string, NumericPort>();
    let providerState: Record<string, any> | undefined;
    const providerReady = deferred<void>();
    const catalogReady = deferred<void>();
    const loadProvider = vi.fn(async () => {
        await providerGate;
        const component = (await server!.ssrLoadModule('/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')).default;
        for (const relative of ['src/features/settings/ui/components/SegmentedControl.vue', 'src/features/settings/ui/services/CompositeTranslationFields.vue']) {
            const child = (await server!.ssrLoadModule(`/${relative}`)).default;
            compileClientTemplate(child, relative);
        }
        compileClientTemplate(component, 'src/features/settings/ui/services/CustomOpenAIProviderDialog.vue');
        providerReady.resolve();return component;
    });
    let notifyConfig: (value: unknown) => void = () => {};
    const data = {loadProvider, catalogMounted: () => catalogReady.resolve(), config: configSnapshot ?? {}, configReady: ready,
        subscribeConfig: (listener: (value: unknown) => void) => {
            notifyConfig = listener;
            if (configSnapshot) listener(configSnapshot);
            return unsubscribe;
        },
        requestConfigPatch: patch,
        handoffPendingConfigPatches: vi.fn(() => Promise.resolve()), theme,
        browser: {runtime: {sendMessage: vi.fn(() => Promise.resolve())}, tabs: {query, sendMessage: send,
            get: vi.fn(async () => ({id: 7, url: 'https://example.test/'})), update: vi.fn(async () => ({id: 7}))}}};
    (globalThis as Record<string, unknown>)[key] = data;
    const mocks: Plugin = {name: 'settings-sections-lifecycle-mocks', enforce: 'pre', resolveId(id, importer) {
        if (repairReturn && /\/(?:ServiceRepairReturn|SettingsPanel)\.vue$/u.test(id)) return null;
        if (requestLimits && id.endsWith('/RequestLimitFields.vue')) return null;
        if (requestLimits && id.endsWith('/SettingsNumberInput.vue')) return null;
        if ((requestLimits || serviceSelectors) && (id.endsWith('/SettingsGroup.vue') || id.endsWith('/SettingsItem.vue'))) return '\0sections-slots';
        if (template && id.endsWith('/CustomOpenAIProviderDialog.vue')) {
            // 只替换父模板的动态模块加载端口；真正的子组件在首次请求后由 Vite 编译，测试不重写其 watch/草稿行为。
            if (importer?.includes('SettingsSections.vue')) return '\0sections-provider-loader';
            return null;
        }
        if (template && /\/(?:CompositeTranslationFields|SegmentedControl)\.vue$/u.test(id)) return null;
        if (template && id.endsWith('/SettingsPanel.vue')) return '\0sections-panel';
        if (template && id.endsWith('/ServiceCatalog.vue')) return '\0sections-service-catalog';
        if (id.endsWith('.vue') && !id.endsWith('/SettingsSections.vue')) return '\0sections-child';
        if (id.endsWith('/src/ui/i18n')) return '\0sections-i18n';
        if (id.endsWith('/src/services/config/store')) return '\0sections-config';
        if (id.endsWith('/src/ui/interfaceAppearance')) return '\0sections-appearance';
        if (id === 'webextension-polyfill') return '\0sections-browser';
        if (id === 'element-plus') return '\0sections-element';
        if (id === '@element-plus/icons-vue') return '\0sections-icons';
        if (/\/src\/platform\/chatgpt-plan\/buildMode(?:\.ts)?$/u.test(id)) return '\0sections-build-mode';
        if (id.endsWith('/src/platform/browser/capabilities')) return '\0sections-capabilities';return null;
    }, load(id) {
        if (id === '\0sections-slots') return `import {h} from 'vue';export default {setup(_, {slots}) {return () => h('div', null, slots.default?.());}};`;
        if (id === '\0sections-panel') return `import {h} from 'vue';export default {setup(_, {slots}) {return () => h('div', null, slots.default?.());}};`;
        if (id === '\0sections-provider-loader') return `export default await globalThis.${key}.loadProvider();`;
        if (id === '\0sections-service-catalog') return `import {h, onMounted} from 'vue';export default {props: ['active'], emits: ['add:service'], setup(props, {emit}) {onMounted(globalThis.${key}.catalogMounted);return () => props.active ? h('button', {'data-testid': 'fixture-add-service', onClick: () => emit('add:service')}, '添加服务') : null}};`;
        if (id === '\0sections-child') return 'export default {render: () => null};';
        if (id === '\0sections-i18n') return `import {ref} from 'vue';export const useUiI18n = () => ({language: ref('zh-CN'), bundleRevision: ref(0), t: k => k, translateLegacy: t => t}); export const localizeServiceOptions = options => options;`;
        if (id === '\0sections-config') return `export const {config, configReady, subscribeConfig, requestConfigPatch, handoffPendingConfigPatches} = globalThis.${key};`;
        if (id === '\0sections-appearance') return `export const applyInterfaceTheme = globalThis.${key}.theme;`;
        if (id === '\0sections-browser') return `export default globalThis.${key}.browser;`;
        if (id === '\0sections-element') return 'export const ElMessage = Object.assign(() => {}, {warning: () => {}});';
        if (id === '\0sections-icons') return 'export const ArrowRight = {};export const InfoFilled = {};export const Edit = {};';
        if (id === '\0sections-build-mode') return `export const chatGPTPlanDevelopmentEnabled = ${development};`;
        if (id === '\0sections-capabilities') return `export const browserCapabilities = {browser: ${JSON.stringify(browserName)}};`;return null;
    }};
    server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
        plugins: [mocks, vue()], resolve: {alias: {'@': resolve(process.cwd())}},
        // 实际表单、键盘与异步归属测试不使用文件观察或热更新。
        ssr: {noExternal: ['element-plus', '@element-plus/icons-vue', 'webextension-polyfill']},server: {hmr: false, middlewareMode: true, watch: null}});
    if (requestLimits) {
        const child = (await server.ssrLoadModule('/src/features/settings/ui/services/RequestLimitFields.vue')).default;
        compileClientTemplate(child, 'src/features/settings/ui/services/RequestLimitFields.vue');
        const numberInput = (await server.ssrLoadModule('/src/features/settings/ui/components/SettingsNumberInput.vue')).default;
        compileClientTemplate(numberInput, 'src/features/settings/ui/components/SettingsNumberInput.vue');
    }
    if (repairReturn) {
        for (const file of ['src/features/settings/ui/services/ServiceRepairReturn.vue', 'src/features/settings/ui/components/SettingsPanel.vue']) {
            compileClientTemplate((await server.ssrLoadModule(`/${file}`)).default, file);
        }
    }
    const component = (await server.ssrLoadModule('/src/features/settings/ui/SettingsSections.vue')).default;
    component.ssrRender = undefined;component.render = () => null;
    if (template) compileClientTemplate(component, 'src/features/settings/ui/SettingsSections.vue');
    const renderer = dom ? createDomRenderer(dom.document as unknown as Document, focus) : runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
        remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
        setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
        setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
    const visible = runtime.ref(true);const props = runtime.reactive({activeSection, onNavigateSection: undefined as undefined | ((section: string, target?: string) => void)});
    let state!: Record<string, any>;
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
        : runtime.h({render: () => null}, {key: 'other'})})});
    let dialogPort: Record<string, any> | undefined;
    if (requestLimits) {
        // Only the numeric widget is a public port; parent/child templates, validation and action context stay real.
        app.component('el-input-number', runtime.defineComponent({inheritAttrs: false,
            props: {modelValue: Number, disabled: Boolean,
                onChange: {type: Function as import('vue').PropType<NumericChange>, required: true}},
            setup(numberProps, {attrs}) {
                return () => {
                    const change = numberProps.onChange;
                    numericPorts.set(String(attrs['aria-label']), {disabled: numberProps.disabled, change});
                    return runtime.h('input', {...attrs, type: 'number', value: numberProps.modelValue, disabled: numberProps.disabled,
                        onChange: (event: Event) => change(Number((event.target as HTMLInputElement).value))});
                };
            }}));
    }
    if (template) {
        app.mixin({mounted() {
            if (this.$options.__name === 'CustomOpenAIProviderDialog') {providerState = (this as any).$.setupState;providerMounted();}
        }, unmounted() {if (this.$options.__name === 'CustomOpenAIProviderDialog') providerUnmounted();}});
        app.component('el-dialog', runtime.defineComponent({props: ['modelValue'], setup(props, {attrs, slots}) {
            return () => {dialogPort = {open: props.modelValue, opened: attrs.onOpened};
                return runtime.h('div', {...attrs, 'data-fixture-open': String(props.modelValue)}, slots.default?.());};
        }}));
    }
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};
    app.mount(dom ? dom.document.querySelector('#fixture')! : {});await settle();
    // 等实际异步目录组件挂载；静态表单仅需 Vue 更新队列，不为每例固定等待 60 ms。
    if (template && activeSection === 'settings-services') {await catalogReady.promise;await settle();}
    return {state, props, visible, document: dom?.document, domWindow: dom?.window, numericPorts, loadProvider, focus, providerMounted, providerUnmounted,
        get providerState() {return providerState;}, get dialogPort() {return dialogPort;},
        async finishProviderLoad() {await providerReady.promise;await new Promise(resolve => setTimeout(resolve, 0));await settle();}, query, send, patch, theme, unsubscribe, frames, findTarget, location, data,
        notifyConfig: (value: unknown) => notifyConfig(value)};
}

describe('设置主表单实际组件异步归属', () => {
    it('网站修复返回条位于实际adaptation目标面板，只按明确来源返回', async () => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-sites', search: '?target=adaptation&returnTabId=7'});
        const button = h.document!.querySelector('[data-return-source-tab]')!;
        expect(button.closest('[data-settings-panel="adaptation"]')).not.toBeNull();
        expect(h.document!.querySelector('[data-service-repair-return]')!.textContent).toContain('检查配置后');
        expect(h.data.browser.tabs.get).not.toHaveBeenCalled();
        button.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        expect(h.data.browser.tabs.get).toHaveBeenCalledWith(7);expect(h.data.browser.tabs.update).toHaveBeenCalledWith(7, {active: true});
    });
    it('普通网站设置不展示没有来源的返回操作', async () => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-sites'});
        expect(h.document!.querySelector('[data-return-source-tab]')).toBeNull();expect(h.data.browser.tabs.get).not.toHaveBeenCalled();
    });
    it.each(['section', 'cached', 'scope', 'adaptation', 'config'] as const)('网站修复返回等待中 %s 改变后旧查询不能激活网页', async reason => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-sites', search: '?target=adaptation&returnTabId=7'}), gate = deferred<{id: number; url: string}>();
        h.data.browser.tabs.get.mockReturnValueOnce(gate.promise);
        h.document!.querySelector('[data-return-source-tab]')!.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        if (reason === 'section') h.props.activeSection = 'settings-general';
        if (reason === 'cached') h.visible.value = false;
        if (reason === 'scope') h.state.config.translationScope = h.state.config.translationScope === 'all' ? 'body' : 'all';
        if (reason === 'adaptation') h.state.config.siteAdaptation = {...h.state.config.siteAdaptation, enabled: !h.state.config.siteAdaptation.enabled};
        if (reason === 'config') h.state.config = {...h.state.config};
        await settle();gate.resolve({id: 7, url: 'https://example.test/'});await settle();
        expect(h.data.browser.tabs.update).not.toHaveBeenCalled();
    });
    it('离开服务设置关闭新服务对话框，隐藏时既不打开也不提交新服务', async () => {
        const {state, props} = await mountSections();state.openCustomProviderDialog();expect(state.customProviderDialogOpen).toBe(false);
        props.activeSection = 'settings-services';await settle();state.openCustomProviderDialog();expect(state.customProviderDialogOpen).toBe(true);
        props.activeSection = 'settings-translation';await settle();expect(state.customProviderDialogOpen).toBe(false);
        const before = JSON.stringify(state.config);state.createCustomProvider({name: 'stale', endpoint: 'https://fixture.example/v1', apiKey: '', model: 'fixture'});
        state.createCompositeProvider({name: 'stale', services: ['google', 'microsoft'], strategy: 'sequential', timeoutMs: 12000});
        expect(JSON.stringify(state.config)).toBe(before);
    });
    it('缓存离开时关闭全文与悬浮录制，恢复暂选模式，返回后仍可录制', async () => {
        const {state, visible} = await mountSections();vi.useFakeTimers();
        state.config.floatingBallHotkey = 'Shift+Q';state.handleHotkeyChange('custom');
        vi.advanceTimersByTime(100);expect(state.showCustomHotkeyDialog).toBe(true);
        visible.value = false;await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);expect(state.config.floatingBallHotkey).toBe('Shift+Q');
        state.handleCustomHotkeyConfirm('Alt+K');state.openCustomMouseHotkeyDialog();
        expect(state.config.customFloatingBallHotkey).toBe('');expect(state.showCustomMouseHotkeyDialog).toBe(false);
        visible.value = true;await settle();state.openCustomMouseHotkeyDialog();expect(state.showCustomMouseHotkeyDialog).toBe(true);
    });
    it('根组件导航时只委托定位，不再创建另一条逐帧查找链', async () => {
        const {state, props, frames} = await mountSections();const navigate = vi.fn();props.onNavigateSection = navigate;await settle();
        state.openSettingsSection('settings-interface', 'translation-sentence-highlight-style');
        expect(navigate).toHaveBeenCalledWith('settings-interface', 'translation-sentence-highlight-style');expect(frames.size).toBe(0);
    });
    it('独立定位最新操作取代旧操作，离开或卸载后旧帧不能滚动', async () => {
        const {state, frames, findTarget, visible} = await mountSections();const scroll = vi.fn();
        state.openSettingsSection('settings-sites', 'first');const stale = [...frames.values()][0];
        state.openSettingsSection('settings-services', 'second');expect(frames.size).toBe(1);
        findTarget.mockReturnValue({scrollIntoView: scroll} as unknown as HTMLElement);stale(0);expect(scroll).not.toHaveBeenCalled();
        visible.value = false;await settle();expect(frames.size).toBe(0);stale(0);expect(scroll).not.toHaveBeenCalled();
        visible.value = true;await settle();state.openSettingsSection('settings-sites', 'third');
        const late = [...frames.values()][0];app?.unmount();app = undefined;late(0);expect(scroll).not.toHaveBeenCalled();
    });
    it('卸载后到达的配置水合不改主题或提交旧配置', async () => {
        const ready = deferred<void>();const {theme, patch, unsubscribe} = await mountSections({ready: ready.promise});
        app?.unmount();app = undefined;ready.resolve();await settle();
        expect(theme).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it('同步订阅与后续批量水合只重建一次完整草稿观察，随后编辑仍同步保存', async () => {
        const {state, patch, notifyConfig} = await mountSections({configSnapshot: {to: 'en', theme: 'dark'}});
        expect(state.config.to).toBe('en');expect(state.config.theme).toBe('dark');expect(patch).not.toHaveBeenCalled();
        const stringify = JSON.stringify;
        let draftScans = 0;
        vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
            if (value === state.config) draftScans++;
            return stringify(value, replacer, space);
        });
        notifyConfig({...state.config, to: 'ja', theme: 'light', hotkey: 'Shift', customHotkey: 'Alt+J'});
        expect(draftScans).toBe(1);
        expect(patch).not.toHaveBeenCalled();expect(state.config.to).toBe('ja');
        state.config.to = 'fr';
        expect(patch).toHaveBeenCalledOnce();expect(patch).toHaveBeenCalledWith(expect.objectContaining({to: 'fr'}), expect.any(Function));
        state.config.harness.enabled = true;
        expect(patch).toHaveBeenCalledTimes(2);
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({harness: expect.objectContaining({enabled: true})}), expect.any(Function));
    });
    it('水合结束后立即关闭捕获最新编辑，后续编辑仍允许另一轮关闭交接', async () => {
        const {state, patch, data, notifyConfig} = await mountSections({configSnapshot: {to: 'en'}});
        notifyConfig({...state.config, to: 'ja'});expect(patch).not.toHaveBeenCalled();
        state.config.to = 'fr';expect(patch).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event('beforeunload'));
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({to: 'fr'}), expect.any(Function));
        expect(data.handoffPendingConfigPatches).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event('pagehide'));expect(data.handoffPendingConfigPatches).toHaveBeenCalledOnce();
        state.config.to = 'de';window.dispatchEvent(new Event('beforeunload'));
        expect(data.handoffPendingConfigPatches).toHaveBeenCalledTimes(2);
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({to: 'de'}), expect.any(Function));
    });
    it('配置就绪失败仍禁止自动保存和关闭交接，卸载后的订阅通知不能改旧草稿', async () => {
        const ready = deferred<void>();const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {state, patch, data, notifyConfig} = await mountSections({ready: ready.promise, configSnapshot: {to: 'en'}});
        state.config.to = 'ja';window.dispatchEvent(new Event('beforeunload'));
        expect(patch).not.toHaveBeenCalled();expect(data.handoffPendingConfigPatches).not.toHaveBeenCalled();
        ready.reject(new Error('fixture hydration failed'));await settle();
        expect(warning).toHaveBeenCalledWith('[FluentRead] 无法读取本地配置', expect.any(Error));
        app?.unmount();app = undefined;notifyConfig({to: 'de'});
        expect(state.config.to).toBe('ja');expect(patch).not.toHaveBeenCalled();expect(data.handoffPendingConfigPatches).not.toHaveBeenCalled();
    });
    it.each(['normalize', 'serialize'])('批量水合的 %s 失败后释放暂停与水合 guard，下一次编辑仍同步保存', async failure => {
        const {state, patch, notifyConfig} = await mountSections({configSnapshot: {to: 'en'}});
        const error = new Error('fixture draft hydration failure');
        if (failure === 'normalize') {
            const invalid = Object.defineProperty({}, 'to', {enumerable: true, get: () => {throw error;}});
            expect(() => state.configEditor.hydrate(invalid)).toThrow(error);
            expect(state.config.to).toBe('en');
        } else {
            const stringify = JSON.stringify;let rejectDraft = true;
            vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
                if (value === state.config && rejectDraft) {rejectDraft = false;throw error;}
                return stringify(value, replacer, space);
            });
            expect(() => notifyConfig({...state.config, to: 'ja'})).toThrow(error);
            expect(state.config.to).toBe('ja');
        }
        expect(patch).not.toHaveBeenCalled();
        state.config.to = 'fr';expect(patch).toHaveBeenCalledOnce();
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({to: 'fr'}), expect.any(Function));
        state.config.harness.enabled = true;expect(patch).toHaveBeenCalledTimes(2);
    });
    it('快速设置更新共用一次标签页查询，发送最新状态，过滤非法 ID', async () => {
        const {state, query, send} = await mountSections();const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);
        for (let i = 0; i < 100; i++) state.floatingBallEnabled = i % 2 === 0;
        state.imageTranslationEnabled = true;state.config.on = false;state.handlePluginStateChange(false);await settle();
        expect(query).toHaveBeenCalledOnce();tabs.resolve([{id: 0}, {id: -1}, {}, {id: 3}]);await settle();
        expect(send.mock.calls.filter(([id]) => id === 0)).toHaveLength(4);
        expect(send.mock.calls.filter(([id]) => id === 3)).toHaveLength(4);
        expect(send.mock.calls.filter(([id]) => id !== 0 && id !== 3)).toHaveLength(0);
        expect(send.mock.calls.filter(([,message]) => message.type === 'toggleFloatingBall').every(([,message]) => message.isEnabled === false)).toBe(true);
        expect(send.mock.calls.filter(([,message]) => message.type === 'updateSelectionTranslatorMode').every(([,message]) => message.mode === 'disabled')).toBe(true);
    });
    it('拒绝查询后释放任务，随后仍能广播；卸载后的结果不继续发消息', async () => {
        const {state, query, send} = await mountSections();query.mockRejectedValueOnce(new Error('tabs unavailable'));
        state.floatingBallEnabled = true;await settle();expect(send).not.toHaveBeenCalled();
        query.mockResolvedValueOnce([{id: 1}]);state.floatingBallEnabled = false;await settle();expect(send).toHaveBeenCalledOnce();
        const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);state.imageTranslationEnabled = true;await settle();
        app?.unmount();app = undefined;tabs.resolve([{id: 1}]);await settle();expect(send).toHaveBeenCalledOnce();
    });
    it('Safari 快速功能编辑仍保存配置，模式回读不再查询或广播标签页', async () => {
        const {state, query, send, patch, notifyConfig} = await mountSections({browserName: 'safari', configSnapshot: {
            on: true, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false,
        }});
        for (let i = 0; i < 10; i++) {
            state.floatingBallEnabled = i % 2 === 0;
            state.imageTranslationEnabled = i % 2 === 0;
            state.config.translationProgressPanelEnabled = i % 2 === 0;
            state.handleTranslationProgressPanelChange(i % 2 === 0);
        }
        state.selectionAreaTranslationEnabled = true;
        state.config.on = false;state.handlePluginStateChange(false);
        state.config.selectionTranslatorMode = 'disabled';await settle();
        state.config.selectionTranslatorMode = 'bilingual';state.config.selectionTranslatorMode = 'translation-only';await settle();
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({on: false, disableFloatingBall: true,
            disableImageTranslator: true, selectionAreaEnabled: true, translationProgressPanelEnabled: false,
            selectionTranslatorMode: 'translation-only', disableSelectionTranslator: false}), expect.any(Function));
        expect(query).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();

        const saves = patch.mock.calls.length;
        notifyConfig({...state.config, on: true, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false});await settle();
        expect(state.config.on).toBe(true);expect(state.config.selectionTranslatorMode).toBe('bilingual');
        expect(patch).toHaveBeenCalledTimes(saves);
        expect(query).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
    });
    it('Safari 卸载后的配置通知和旧功能回调不保存或广播', async () => {
        const {state, query, send, patch, data, notifyConfig, unsubscribe} = await mountSections({browserName: 'safari',
            configSnapshot: {on: true, selectionTranslatorMode: 'bilingual'}});
        app?.unmount();app = undefined;await settle();
        const saves = patch.mock.calls.length, handoffs = data.handoffPendingConfigPatches.mock.calls.length;
        const previous = JSON.stringify(state.config);
        notifyConfig({...state.config, on: false, selectionTranslatorMode: 'disabled'});
        state.handlePluginStateChange(false);state.handleTranslationProgressPanelChange(false);await settle();
        expect(JSON.stringify(state.config)).toBe(previous);expect(unsubscribe).toHaveBeenCalledOnce();
        expect(patch).toHaveBeenCalledTimes(saves);expect(data.handoffPendingConfigPatches).toHaveBeenCalledTimes(handoffs);
        expect(query).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
    });
    it('服务列表直接复用已筛选能力结果，切换显示模式不会再分配同样的列表', async () => {
        const {state} = await mountSections();const first = state.configurationCompute.filteredServices;
        expect(first).toBe(state.availableServiceOptions);state.config.display = 2;await settle();
        expect(state.configurationCompute.filteredServices).toBe(first);
    });
    it('公开版水合旧套餐默认与slug不改配置，编辑目标回退可用服务且不补回隐藏入口', async () => {
        const {state, patch} = await mountSections({activeSection: 'settings-services', configSnapshot: {
            service: 'chatgptPlan', model: {chatgptPlan: 'saved-account-model'}, documentModel: {chatgptPlan: 'saved-document-model'},
        }});
        const before = JSON.stringify(state.config);
        expect(state.config.service).toBe('chatgptPlan');expect(state.config.model.chatgptPlan).toBe('saved-account-model');
        expect(state.config.documentModel.chatgptPlan).toBe('saved-document-model');expect(state.selectedConfigurationService).toBe('freeTranslation');
        expect(state.availableServiceOptions.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
        expect(state.textServiceGroups.flatMap((group: {options: {value: string}[]}) => group.options).some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
        expect(state.videoServiceOptions.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
        expect(state.configurationCompute.filteredServices.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
        const saved = state.setDefaultConfigurationService;saved('chatgptPlan');state.setDefaultConfigurationService('chatgptPlan');await settle();
        expect(JSON.stringify(state.config)).toBe(before);expect(patch).not.toHaveBeenCalled();
    });
    it.each(['direct', 'deep-link'])('公开版%s打开旧套餐配置不显示登录详情或改动网页默认和账户slug', async method => {
        const {state, patch} = await mountSections({activeSection: 'settings-services', configSnapshot: {
            service: 'microsoft', model: {chatgptPlan: 'saved-account-model'},
        }, search: method === 'deep-link' ? '?service=chatgptPlan' : ''});
        const saved = state.setDefaultConfigurationService;
        if (method === 'direct') state.setConfigurationService('chatgptPlan');await settle();
        expect(state.selectedConfigurationService).toBe('freeTranslation');
        expect(state.configurationCompute.filteredServices.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
        saved('chatgptPlan');state.setDefaultConfigurationService('chatgptPlan');await settle();
        expect(state.config.service).toBe('microsoft');expect(state.config.model.chatgptPlan).toBe('saved-account-model');expect(patch).not.toHaveBeenCalled();
    });
    it('公开版真实默认和视频选项及不可用提示保留套餐名称，不冒充Chrome或自动迁移旧配置', async () => {
        const {state, props, document: displayDocument, patch} = await mountSections({template: true, serviceSelectors: true,
            activeSection: 'settings-general', configSnapshot: {
                service: 'chatgptPlan', videoService: 'chatgptPlan', videoTranslationEnabled: true,
                model: {chatgptPlan: 'saved-account-model'}, documentModel: {chatgptPlan: 'saved-document-model'},
            }});
        const before = JSON.stringify(state.config);
        const general = displayDocument!.querySelector('#settings-general')!;
        const defaultOption = general.querySelector('el-select[aria-label="默认网页翻译服务"] el-option[disabled]');
        expect(defaultOption).not.toBeNull();expect(defaultOption!.getAttribute('label')).toBe('ChatGPT 套餐');
        const warning = general.querySelector('.disabled-section[role="status"]');
        expect(warning?.querySelector('strong')?.textContent).toBe('ChatGPT 套餐');
        expect(warning?.textContent).not.toContain('Chrome');
        expect(warning?.textContent).toContain(state.selectedTextServiceUnavailableMessage);
        props.activeSection = 'settings-video';await settle();
        const video = displayDocument!.querySelector('#settings-video')!;
        const videoOption = video.querySelector('el-select[aria-label="视频字幕翻译服务"] el-option[disabled]');
        expect(videoOption).not.toBeNull();expect(videoOption!.getAttribute('label')).toBe('ChatGPT 套餐');
        expect(videoOption!.getAttribute('label')).not.toContain('Chrome');
        expect(video.querySelector('.capability-warning')?.textContent).toBe(state.selectedVideoServiceUnavailableMessage);
        expect(JSON.stringify(state.config)).toBe(before);expect(patch).not.toHaveBeenCalled();
        expect(state.config.service).toBe('chatgptPlan');expect(state.config.videoService).toBe('chatgptPlan');
        expect(state.config.model.chatgptPlan).toBe('saved-account-model');expect(state.config.documentModel.chatgptPlan).toBe('saved-document-model');
    });
    it('开发版显式套餐夹具保留公共选择和正常设置默认的配置补丁', async () => {
        const {state, patch} = await mountSections({development: true, activeSection: 'settings-services', configSnapshot: {
            service: 'microsoft', model: {chatgptPlan: 'saved-account-model'},
        }});
        expect(state.availableServiceOptions.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(true);
        state.setConfigurationService('chatgptPlan');await settle();state.setDefaultConfigurationService('chatgptPlan');await settle();
        expect(state.config.service).toBe('chatgptPlan');expect(state.config.model.chatgptPlan).toBe('saved-account-model');
        expect(patch).toHaveBeenCalledWith(expect.objectContaining({service: 'chatgptPlan'}), expect.any(Function));
    });
    it('查询完成时采用外部最新模式和进度偏好，单个标签页同步异常不阻止其余消息', async () => {
        const {state, query, send} = await mountSections();const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);
        state.selectionAreaTranslationEnabled = true;state.config.translationProgressPanelEnabled = false;state.handleTranslationProgressPanelChange(false);
        state.config.selectionTranslatorMode = 'bilingual';await settle();
        state.config.selectionTranslatorMode = 'translation-only';state.config.translationProgressPanelEnabled = true;await settle();
        send.mockImplementationOnce(() => {throw new Error('closed tab');});send.mockRejectedValueOnce(new Error('missing content script'));
        tabs.resolve([{id: 1}, {id: 2}]);await settle();expect(query).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledTimes(6);
        expect(send).toHaveBeenCalledWith(2, {type: 'toggleTranslationProgressPanel', isEnabled: true});
        expect(send).toHaveBeenCalledWith(2, {type: 'updateSelectionTranslatorMode', mode: 'translation-only'});
    });
    it('已缓存或卸载时到达的规则检查不会继续导航或打开自定义服务', async () => {
        const {state, visible, props} = await mountSections();const navigate = vi.fn();props.onNavigateSection = navigate;await settle();
        const inspect = state.inspectSiteRule('stale');visible.value = false;await settle();await inspect;
        expect(navigate).not.toHaveBeenCalled();state.openCustomProviderDialog();expect(state.customProviderDialogOpen).toBe(false);
        visible.value = true;await settle();const late = state.inspectSiteRule('closed');app?.unmount();app = undefined;await late;
        expect(navigate).not.toHaveBeenCalled();
    });
});

function addProviderFromTemplate(fixture: Awaited<ReturnType<typeof mountSections>>) {
    const button = fixture.document!.querySelector('[data-testid="fixture-add-service"]')!;
    expect(button).not.toBeNull();button.dispatchEvent(new fixture.domWindow!.Event('click', {bubbles: true}));
}
function inputProvider(fixture: Awaited<ReturnType<typeof mountSections>>, field: string, value: string) {
    const input = fixture.document!.querySelector(`[data-testid="custom-service-${field}"]`)! as unknown as HTMLInputElement;
    input.value = value;input.dispatchEvent(new fixture.domWindow!.Event('input', {bubbles: true}));
}
function submitProviderFromTemplate(fixture: Awaited<ReturnType<typeof mountSections>>) {
    fixture.document!.querySelector('form.custom-provider-form')!.dispatchEvent(new fixture.domWindow!.Event('submit', {bubbles: true, cancelable: true}));
}

describe('新服务对话框实际模板首次挂载与后续实例归属', () => {
    it('唯一添加窗口切换为组合后只保留一个名称与保存按钮，提交不混入隐藏的接口密钥', async () => {
        const fixture = await mountSections({template: true, activeSection: 'settings-services'});
        addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        const document = fixture.document!;
        expect(fixture.providerState!.serviceType).toBe('interface');
        expect(document.querySelectorAll('[data-testid="custom-service-dialog"]')).toHaveLength(1);
        expect(document.querySelector('[data-testid="custom-service-type-interface"]')?.getAttribute('aria-pressed')).toBe('true');
        inputProvider(fixture, 'name', '  Daily combination  ');inputProvider(fixture, 'endpoint', 'https://hidden.example/v1');
        inputProvider(fixture, 'api-key', 'fixture-hidden-secret');inputProvider(fixture, 'model', 'hidden-model');
        const oldInterfaceSubmit = fixture.providerState!.actions.submit;
        document.querySelector('[data-testid="custom-service-type-composite"]')!.dispatchEvent(new fixture.domWindow!.Event('click'));
        await settle();
        expect(fixture.providerState!.serviceType).toBe('composite');
        expect(document.querySelector('[data-testid="custom-service-type-composite"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelectorAll('[data-testid="custom-service-name"]')).toHaveLength(1);
        expect((document.querySelector('[data-testid="custom-service-name"]') as unknown as HTMLInputElement).value).toBe('  Daily combination  ');
        expect(document.querySelector('[data-testid="composite-service-name"]')).toBeNull();
        expect(document.querySelector('[data-testid="custom-service-endpoint"]')).toBeNull();
        expect(document.querySelector('[data-testid="custom-service-api-key"]')).toBeNull();
        expect(document.querySelector('[data-testid="composite-service-save"]')).toBeNull();
        expect(document.querySelectorAll('[data-testid="custom-service-save"]')).toHaveLength(1);
        expect(document.querySelector('[data-testid="composite-member-add"]')).toBeNull();
        expect(document.querySelectorAll('[role="radio"]')).toHaveLength(3);
        expect(document.querySelectorAll('[data-composite-strategy-help]')).toHaveLength(1);
        expect(document.querySelector('[data-composite-strategy-help]')?.textContent).toBe('settings.services.composite.sequentialHelp');
        document.querySelector('[role="radio"][data-option-index="1"]')!.dispatchEvent(new fixture.domWindow!.Event('click'));
        await settle();
        expect(document.querySelectorAll('[data-composite-strategy-help]')).toHaveLength(1);
        expect(document.querySelector('[data-composite-strategy-help]')?.textContent).toBe('settings.services.composite.randomHelp');
        expect(document.querySelector('details[data-composite-advanced]')?.hasAttribute('open')).toBe(false);
        const select = document.querySelector('[data-testid="composite-member-select"]')!;
        function addMember(service: string) {
            const option = select.querySelector(`option[value="${service}"]`)!;
            expect(option).not.toBeNull();(select as unknown as HTMLSelectElement).value = service;
            select.dispatchEvent(new fixture.domWindow!.Event('change', {bubbles: true}));
        }
        addMember('google');await settle();addMember('microsoft');await settle();
        expect(fixture.providerState!.compositeDraft.services).toEqual(['google', 'microsoft']);
        expect(document.querySelectorAll('[data-composite-member]')).toHaveLength(2);
        oldInterfaceSubmit();expect(fixture.state.config.customOpenAIProviders).toEqual([]);expect(fixture.state.config.compositeTranslationProviders).toEqual([]);
        const advanced = document.querySelector('details[data-composite-advanced]')!;
        advanced.setAttribute('open', '');advanced.dispatchEvent(new fixture.domWindow!.Event('toggle'));await settle();
        const timeout = document.querySelector('[data-testid="composite-member-timeout"]')! as unknown as HTMLInputElement;
        timeout.value = '0';timeout.dispatchEvent(new fixture.domWindow!.Event('input', {bubbles: true}));await settle();
        advanced.removeAttribute('open');advanced.dispatchEvent(new fixture.domWindow!.Event('toggle'));await settle();
        submitProviderFromTemplate(fixture);await settle();
        expect(fixture.state.config.compositeTranslationProviders).toEqual([]);expect(fixture.patch).not.toHaveBeenCalled();
        expect(advanced.hasAttribute('open')).toBe(true);
        expect(advanced.querySelector('[role="alert"]')?.textContent).toBe('settings.services.composite.timeoutInvalid');
        timeout.value = '5';timeout.dispatchEvent(new fixture.domWindow!.Event('input', {bubbles: true}));await settle();
        expect(advanced.hasAttribute('open')).toBe(true);
        submitProviderFromTemplate(fixture);await settle();
        expect(fixture.state.config.compositeTranslationProviders).toEqual([expect.objectContaining({name: 'Daily combination', services: ['google', 'microsoft'], strategy: 'random', timeoutMs: 5000})]);
        expect(fixture.state.config.customOpenAIProviders).toEqual([]);
        expect(Object.keys(fixture.state.config.token).some(service => service.startsWith('composite:'))).toBe(false);
        expect(JSON.stringify(fixture.state.config.compositeTranslationProviders)).not.toContain('fixture-hidden-secret');
        expect(fixture.patch).toHaveBeenCalledOnce();expect(fixture.dialogPort!.open).toBe(false);
    });

    it('通用设置和仅访问服务目录均不调用加载器，首次添加才加载一次', async () => {
        const fixture = await mountSections({template: true, activeSection: 'settings-general'});
        expect(fixture.loadProvider).not.toHaveBeenCalled();expect(fixture.providerMounted).not.toHaveBeenCalled();
        expect(fixture.document!.querySelector('[data-testid="custom-service-dialog"]')).toBeNull();
        fixture.state.openCustomProviderDialog();await settle();expect(fixture.loadProvider).not.toHaveBeenCalled();
        fixture.props.activeSection = 'settings-services';await vi.waitFor(() => expect(fixture.document!.querySelector('[data-testid="fixture-add-service"]')).not.toBeNull());
        expect(fixture.loadProvider).not.toHaveBeenCalled();
        addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        expect(fixture.loadProvider).toHaveBeenCalledOnce();expect(fixture.providerMounted).toHaveBeenCalledOnce();
        expect(fixture.dialogPort!.open).toBe(true);
    });

    it('取消后保留同一实例并清空草稿，重开不重新加载或继承旧事件', async () => {
        const fixture = await mountSections({template: true, activeSection: 'settings-services'});
        await settle();addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        const instance = fixture.providerState!;
        inputProvider(fixture, 'name', '旧服务');inputProvider(fixture, 'api-key', 'synthetic-only');await settle();
        const staleSubmit = fixture.document!.querySelector('form.custom-provider-form')!;
        const staleAction = fixture.providerState!.actions.submit;
        fixture.document!.querySelector('button.secondary-button')!.dispatchEvent(new fixture.domWindow!.Event('click'));
        await settle();
        expect(fixture.state.customProviderDialogOpen).toBe(false);expect(fixture.dialogPort!.open).toBe(false);
        expect(fixture.providerUnmounted).not.toHaveBeenCalled();expect(fixture.providerState).toBe(instance);
        expect(instance.draft).toEqual({name: '', endpoint: '', apiKey: '', model: ''});
        addProviderFromTemplate(fixture);await settle();
        expect(fixture.loadProvider).toHaveBeenCalledOnce();expect(fixture.providerMounted).toHaveBeenCalledOnce();
        expect(fixture.providerState).toBe(instance);expect(fixture.dialogPort!.open).toBe(true);
        staleAction();expect(fixture.state.config.customOpenAIProviders).toHaveLength(0);
        expect(staleSubmit.isConnected).toBe(true);
    });

    it.each(['section', 'keepalive'])('首次加载迟到于 %s 失活时保持关闭，返回可再开且不重复加载', async reason => {
        const gate = deferred<void>();const fixture = await mountSections({template: true, activeSection: 'settings-services', providerGate: gate.promise});
        await settle();addProviderFromTemplate(fixture);await vi.waitFor(() => expect(fixture.loadProvider).toHaveBeenCalledOnce());
        if (reason === 'section') fixture.props.activeSection = 'settings-general';else fixture.visible.value = false;
        await settle();expect(fixture.state.customProviderDialogOpen).toBe(false);
        gate.resolve();await fixture.finishProviderLoad();
        expect(fixture.focus).not.toHaveBeenCalled();expect(fixture.state.config.customOpenAIProviders).toHaveLength(0);
        if (reason === 'section') fixture.props.activeSection = 'settings-services';else fixture.visible.value = true;
        await settle();expect(fixture.dialogPort!.open).toBe(false);
        fixture.dialogPort!.opened();expect(fixture.focus).not.toHaveBeenCalled();
        addProviderFromTemplate(fixture);await settle();expect(fixture.dialogPort!.open).toBe(true);
        expect(fixture.loadProvider).toHaveBeenCalledOnce();expect(fixture.providerMounted).toHaveBeenCalledOnce();
        fixture.dialogPort!.opened();expect(fixture.focus).toHaveBeenCalledOnce();
    });

    it('卸载后完成的加载不挂载子实例、聚焦或保存配置', async () => {
        const gate = deferred<void>();const fixture = await mountSections({template: true, activeSection: 'settings-services', providerGate: gate.promise});
        await settle();addProviderFromTemplate(fixture);await vi.waitFor(() => expect(fixture.loadProvider).toHaveBeenCalledOnce());
        app!.unmount();app = undefined;
        const exitSaves = fixture.patch.mock.calls.length;
        gate.resolve();await fixture.finishProviderLoad();
        expect(fixture.providerMounted).not.toHaveBeenCalled();expect(fixture.focus).not.toHaveBeenCalled();
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves);
    });

    it.each(['section', 'keepalive', 'context'])('已加载对话框在 %s 失活后清空草稿，旧焦点/提交不能影响重开', async reason => {
        const fixture = await mountSections({template: true, activeSection: 'settings-services'});
        await settle();addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        const instance = fixture.providerState!;const staleOpened = fixture.dialogPort!.opened, staleSubmit = instance.actions.submit;
        inputProvider(fixture, 'name', '旧草稿');inputProvider(fixture, 'api-key', 'fixture-secret');
        if (reason === 'section') fixture.props.activeSection = 'settings-general';
        else if (reason === 'keepalive') fixture.visible.value = false;
        else fixture.state.updateConfigAtomically((config: {to: string}) => {config.to = 'ja';});
        await settle();expect(fixture.state.customProviderDialogOpen).toBe(false);
        expect(instance.draft).toEqual({name: '', endpoint: '', apiKey: '', model: ''});
        staleOpened();staleSubmit();expect(fixture.focus).not.toHaveBeenCalled();
        expect(fixture.state.config.customOpenAIProviders).toHaveLength(0);
        fixture.props.activeSection = 'settings-services';fixture.visible.value = true;await settle();
        addProviderFromTemplate(fixture);await settle();
        expect(fixture.dialogPort!.open).toBe(true);expect(fixture.providerState).toBe(instance);
        expect(fixture.providerMounted).toHaveBeenCalledOnce();expect(fixture.loadProvider).toHaveBeenCalledOnce();
        staleOpened();staleSubmit();expect(fixture.focus).not.toHaveBeenCalled();
        expect(fixture.state.config.customOpenAIProviders).toHaveLength(0);
    });

    it('真实子模板保持必填校验和关闭后提交流程，服务配置仅写入一次', async () => {
        const fixture = await mountSections({template: true, activeSection: 'settings-services'});
        await settle();addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        submitProviderFromTemplate(fixture);await settle();
        expect(fixture.document!.querySelectorAll('[role="alert"]')).toHaveLength(3);
        expect(fixture.dialogPort!.open).toBe(true);expect(fixture.patch).not.toHaveBeenCalled();
        inputProvider(fixture, 'name', '  Local Fixture  ');inputProvider(fixture, 'endpoint', ' http://localhost:11434/v1 ');
        inputProvider(fixture, 'api-key', ' synthetic-only ');inputProvider(fixture, 'model', ' fixture-model ');await settle();
        submitProviderFromTemplate(fixture);await settle();
        expect(fixture.state.customProviderDialogOpen).toBe(false);expect(fixture.dialogPort!.open).toBe(false);
        expect(fixture.state.config.customOpenAIProviders).toEqual([expect.objectContaining({name: 'Local Fixture', endpoint: 'http://localhost:11434/v1', models: ['fixture-model']})]);
        expect(fixture.patch).toHaveBeenCalledOnce();expect(fixture.providerUnmounted).not.toHaveBeenCalled();
    });
});

describe('高级设置全局请求限制实际父子装配', () => {
    function limitInput(fixture: Awaited<ReturnType<typeof mountSections>>, label: string): HTMLInputElement {
        const input = fixture.document!.querySelector(`[data-testid="translation-scheduler-settings"] input[aria-label="${label}"]`);
        expect(input).not.toBeNull();
        return input as unknown as HTMLInputElement;
    }
    function changeLimit(fixture: Awaited<ReturnType<typeof mountSections>>, label: string, value: number): void {
        const input = limitInput(fixture, label);
        input.value = String(value);
        input.dispatchEvent(new fixture.domWindow!.Event('change', {bubbles: true}));
    }

    it('AI 超时默认显示 120 秒，修改秒数后规范化并交接毫秒配置补丁', async () => {
        const fixture = await mountSections({template: true, requestLimits: true, activeSection: 'settings-advanced'});
        const label = 'settings.requestLimits.aiTimeout';
        expect(limitInput(fixture, label).value).toBe('120');
        expect(limitInput(fixture, label).getAttribute('min')).toBe('10');
        expect(limitInput(fixture, label).getAttribute('max')).toBe('600');
        expect(limitInput(fixture, label).disabled).toBe(false);
        changeLimit(fixture, label, 300);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(300_000);
        expect(fixture.patch).toHaveBeenCalledOnce();
        expect(fixture.patch).toHaveBeenLastCalledWith(expect.objectContaining({aiRequestTimeoutMs: 300_000}), expect.any(Function));
        await settle();
        const change = fixture.numericPorts.get(label)!.change;
        for (const value of [undefined, NaN, Infinity]) change(value);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(300_000);
        expect(fixture.patch).toHaveBeenCalledOnce();
        changeLimit(fixture, label, 5);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(10_000);
        await settle();changeLimit(fixture, label, 900);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(600_000);
        expect(fixture.patch).toHaveBeenCalledTimes(3);
    });

    it.each(['section', 'keepalive', 'unmount'] as const)('AI 超时在 %s 失活后拒绝旧回调，返回时拒绝已过期的输入事件', async reason => {
        const fixture = await mountSections({template: true, requestLimits: true, activeSection: 'settings-advanced'});
        const label = 'settings.requestLimits.aiTimeout';
        const original = fixture.state.config.aiRequestTimeoutMs;
        const staleChange = fixture.numericPorts.get(label)!.change;
        if (reason === 'section') fixture.props.activeSection = 'settings-translation';
        else if (reason === 'keepalive') fixture.visible.value = false;
        else {app!.unmount();app = undefined;}
        await settle();
        const exitSaves = fixture.patch.mock.calls.length;
        staleChange(300);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(original);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves);
        if (reason === 'unmount') return;
        expect(fixture.numericPorts.get(label)!.disabled).toBe(true);
        fixture.props.activeSection = 'settings-advanced';fixture.visible.value = true;await settle();
        staleChange(400);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(original);
        changeLimit(fixture, label, 300);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(300_000);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves + 1);
    });

    it('收到同步后的超时设置时，旧控件回调不能覆盖新值', async () => {
        const fixture = await mountSections({template: true, requestLimits: true, activeSection: 'settings-advanced'});
        const label = 'settings.requestLimits.aiTimeout';
        const staleChange = fixture.numericPorts.get(label)!.change;
        fixture.notifyConfig({...fixture.state.config, aiRequestTimeoutMs: 240_000});
        await settle();
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(240_000);
        expect(fixture.patch).not.toHaveBeenCalled();
        staleChange(300);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(240_000);
        expect(fixture.patch).not.toHaveBeenCalled();
        changeLimit(fixture, label, 300);
        expect(fixture.state.config.aiRequestTimeoutMs).toBe(300_000);
        expect(fixture.patch).toHaveBeenCalledOnce();
    });

    it('高级页三项限制可编辑，合法数值和不限速零值各同步交接一次配置补丁', async () => {
        const fixture = await mountSections({template: true, requestLimits: true, activeSection: 'settings-advanced'});
        const labels = ['翻译并发数', '每秒最多请求数', '每分钟最多请求数'];
        expect(labels.map(label => limitInput(fixture, label).disabled)).toEqual([false, false, false]);
        const original = {maxConcurrentTranslations: fixture.state.config.maxConcurrentTranslations,
            translationRequestsPerSecond: fixture.state.config.translationRequestsPerSecond};
        expect(fixture.patch).not.toHaveBeenCalled();
        changeLimit(fixture, '每分钟最多请求数', 87);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(87);
        expect(fixture.state.config.maxConcurrentTranslations).toBe(original.maxConcurrentTranslations);
        expect(fixture.state.config.translationRequestsPerSecond).toBe(original.translationRequestsPerSecond);
        expect(fixture.patch).toHaveBeenCalledOnce();
        expect(fixture.patch).toHaveBeenLastCalledWith(expect.objectContaining({translationRequestsPerMinute: 87}), expect.any(Function));
        await settle();changeLimit(fixture, '翻译并发数', 3);
        expect(fixture.state.config.maxConcurrentTranslations).toBe(3);
        expect(fixture.patch).toHaveBeenCalledTimes(2);
        expect(fixture.patch).toHaveBeenLastCalledWith(expect.objectContaining({maxConcurrentTranslations: 3}), expect.any(Function));
        await settle();changeLimit(fixture, '每秒最多请求数', 0);
        expect(fixture.state.config.translationRequestsPerSecond).toBe(0);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(87);
        expect(fixture.patch).toHaveBeenCalledTimes(3);
        expect(fixture.patch).toHaveBeenLastCalledWith(expect.objectContaining({translationRequestsPerSecond: 0}), expect.any(Function));
    });

    it.each(['section', 'keepalive', 'unmount'] as const)('%s失活拒绝旧数值事件，返回后仅当前事件能再次保存', async reason => {
        const fixture = await mountSections({template: true, requestLimits: true, activeSection: 'settings-advanced'});
        const original = fixture.state.config.translationRequestsPerMinute;
        const staleChange = fixture.numericPorts.get('每分钟最多请求数')!.change;
        if (reason === 'section') fixture.props.activeSection = 'settings-translation';
        else if (reason === 'keepalive') fixture.visible.value = false;
        else {app!.unmount();app = undefined;}
        await settle();
        const exitSaves = fixture.patch.mock.calls.length;
        staleChange(87);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(original);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves);
        if (reason === 'unmount') return;
        expect(fixture.numericPorts.get('每分钟最多请求数')!.disabled).toBe(true);
        // A controlled widget can retain or deliver a handler after v-show; the real child guard rejects it.
        fixture.numericPorts.get('每分钟最多请求数')!.change(88);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(original);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves);
        fixture.props.activeSection = 'settings-advanced';fixture.visible.value = true;await settle();
        staleChange(89);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(original);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves);
        changeLimit(fixture, '每分钟最多请求数', 90);
        expect(fixture.state.config.translationRequestsPerMinute).toBe(90);
        expect(fixture.patch).toHaveBeenCalledTimes(exitSaves + 1);
        expect(fixture.patch).toHaveBeenLastCalledWith(expect.objectContaining({translationRequestsPerMinute: 90}), expect.any(Function));
    });
});


/** 新故障场景独立 display port；旧 mountSections/fake Catalog 全文不改，也不声称真实 Catalog CSS/布局。 */
async function mountProviderFailureSections() {
    const gate = deferred<void>(), started = deferred<void>(), finished = deferred<void>();
    const cause = new Error('fixture custom provider loader rejected');
    // 仅给受控 gate 的无人消费清理分支装处理器；实际 loader 仍会收到同一拒绝。
    void gate.promise.catch(() => undefined);
    let requested = false, settled = false;
    const reject = () => {if (!settled) {settled = true;gate.reject(cause);}};
    const focus = vi.fn(), providerMounted = vi.fn(), providerUnmounted = vi.fn();
    const patch = vi.fn(() => Promise.resolve()), unsubscribe = vi.fn();
    const vueErrors: unknown[] = [];
    const dom = parseHTML('<html><body><main id="fixture"></main></body></html>');
    const media = {matches: false, onchange: null as (() => void) | null};
    vi.stubGlobal('window', Object.assign(new EventTarget(), {location: {hash: '', search: '', protocol: 'chrome-extension:'},
        navigator: {userAgent: ''}, matchMedia: () => media, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}}));
    vi.stubGlobal('document', dom.document);vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    const loadProvider = vi.fn(async () => {
        requested = true;started.resolve();
        try {
            await gate.promise;
            const child = (await server!.ssrLoadModule('/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')).default;
            compileClientTemplate(child, 'src/features/settings/ui/services/CustomOpenAIProviderDialog.vue');return child;
        } finally {finished.resolve();}
    });
    const data = {loadProvider, config: {}, configReady: Promise.resolve(), subscribeConfig: (_listener: (value: unknown) => void) => unsubscribe,
        requestConfigPatch: patch, handoffPendingConfigPatches: vi.fn(() => Promise.resolve()), theme: vi.fn(),
        browser: {runtime: {sendMessage: vi.fn(() => Promise.resolve())}, tabs: {query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn(() => Promise.resolve())}}};
    (globalThis as Record<string, unknown>)[key] = data;
    const mocks: Plugin = {name: 'settings-provider-failure-display-ports', enforce: 'pre', resolveId(id, importer) {
        if (id.endsWith('/CustomOpenAIProviderDialog.vue')) {
            if (importer?.includes('SettingsSections.vue')) return '\0provider-failure-loader';return null;
        }
        if (id.endsWith('/SettingsPanel.vue')) return '\0provider-failure-panel';
        if (id.endsWith('/ServiceCatalog.vue')) return '\0provider-failure-catalog';
        if (id.endsWith('.vue') && !id.endsWith('/SettingsSections.vue')) return '\0provider-failure-child';
        if (id.endsWith('/src/ui/i18n')) return '\0provider-failure-i18n';
        if (id.endsWith('/src/services/config/store')) return '\0provider-failure-config';
        if (id.endsWith('/src/ui/interfaceAppearance')) return '\0provider-failure-appearance';
        if (id === 'webextension-polyfill') return '\0provider-failure-browser';
        if (id === 'element-plus') return '\0provider-failure-element';
        if (id === '@element-plus/icons-vue') return '\0provider-failure-icons';
        if (id.endsWith('/src/platform/browser/capabilities')) return '\0provider-failure-capabilities';return null;
    }, load(id) {
        if (id === '\0provider-failure-panel') return `import {h} from 'vue';export default {setup(_, {slots}) {return () => h('div', null, slots.default?.());}};`;
        if (id === '\0provider-failure-loader') return `export default await globalThis.${key}.loadProvider();`;
        if (id === '\0provider-failure-catalog') return `import {h} from 'vue';export default {props: ['active'], emits: ['add:service'], setup(props, {emit, slots}) {return () => props.active ? h('section', {'data-fixture-catalog-display': ''}, [h('div', {'data-fixture-add-service-row': ''}, [h('button', {'data-testid': 'fixture-add-service', onClick: () => emit('add:service')}, '添加服务'), slots['add-service-status']?.()])]) : null}};`;
        if (id === '\0provider-failure-child') return 'export default {render: () => null};';
        // 固定中文 display port；这里只验证父状态，不证明真实本地化资源加载。
        if (id === '\0provider-failure-i18n') return `import {ref} from 'vue';const copy = {'common.loading': '加载中…', 'learning.panelLoadError': '此栏目暂时无法打开，请重新加载页面后再试。', 'learning.reloadPage': '重新加载页面', 'common.close': '关闭'};export const useUiI18n = () => ({language: ref('zh-CN'), t: k => copy[k] ?? k, translateLegacy: t => t});export const localizeServiceOptions = options => options;`;
        if (id === '\0provider-failure-config') return `export const {config, configReady, subscribeConfig, requestConfigPatch, handoffPendingConfigPatches} = globalThis.${key};`;
        if (id === '\0provider-failure-appearance') return `export const applyInterfaceTheme = globalThis.${key}.theme;`;
        if (id === '\0provider-failure-browser') return `export default globalThis.${key}.browser;`;
        if (id === '\0provider-failure-element') return 'export const ElMessage = Object.assign(() => {}, {warning: () => {}});';
        if (id === '\0provider-failure-icons') return 'export const ArrowRight = {};export const InfoFilled = {};export const Edit = {};';
        if (id === '\0provider-failure-capabilities') return "export const browserCapabilities = {browser: 'chrome'};";return null;
    }};
    server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(), plugins: [mocks, vue()],
        resolve: {alias: {'@': resolve(process.cwd())}}, ssr: {noExternal: ['element-plus', '@element-plus/icons-vue', 'webextension-polyfill']},
        server: {hmr: false, middlewareMode: true, watch: null}});
    const component = (await server.ssrLoadModule('/src/features/settings/ui/SettingsSections.vue')).default;
    compileClientTemplate(component, 'src/features/settings/ui/SettingsSections.vue');
    // 每个动态创建节点的 focus 只记录，不影响旧 renderer 或全局 HTMLElement prototype。
    const displayDocument = {createElement(name: string) {const node = dom.document.createElement(name);node.focus = focus;return node;},
        createTextNode: dom.document.createTextNode.bind(dom.document), createComment: dom.document.createComment.bind(dom.document),
        querySelector: dom.document.querySelector.bind(dom.document)} as unknown as Document;
    const renderer = createDomRenderer(displayDocument, focus);
    const props = runtime.reactive({activeSection: 'settings-services'}), visible = runtime.ref(true);
    let state!: Record<string, any>;
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
        : runtime.h({render: () => null}, {key: 'other'})})});
    app.mixin({mounted() {if (this.$options.__name === 'CustomOpenAIProviderDialog') providerMounted();},
        unmounted() {if (this.$options.__name === 'CustomOpenAIProviderDialog') providerUnmounted();}});
    app.component('el-dialog', runtime.defineComponent({props: ['modelValue'], setup(dialogProps, {attrs, slots}) {
        return () => runtime.h('div', {...attrs, 'data-fixture-open': String(dialogProps.modelValue)}, slots.default?.());
    }}));
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};
    app.config.errorHandler = error => {vueErrors.push(error);};
    app.mount(dom.document.querySelector('#fixture')!);await settle();
    await vi.waitFor(() => expect(dom.document.querySelector('[data-testid="fixture-add-service"]')).not.toBeNull());
    const flushRejectedLoader = async () => {
        if (requested) {await finished.promise;await new Promise(resolve => setTimeout(resolve, 0));await settle();}
        expect(vueErrors.filter(error => error !== cause)).toEqual([]);
        expect(vueErrors.filter(error => error === cause).length).toBeLessThanOrEqual(1);
    };
    return {state, props, visible, document: dom.document, domWindow: dom.window, patch, focus, providerMounted, providerUnmounted, loadProvider, cause, vueErrors,
        async add() {const button = dom.document.querySelector('[data-testid="fixture-add-service"]')!;button.dispatchEvent(new dom.window.Event('click', {bubbles: true}));await started.promise;await settle();},
        // 真实父模板事件；允许传入已断开的旧按钮，用于验证旧 callback 的请求归属。
        async feedbackClose(button?: Element | null) {
            const target = button ?? dom.document.querySelector('[data-testid="custom-service-load-close"]');
            expect(target).not.toBeNull();target!.dispatchEvent(new dom.window.Event('click', {bubbles: true}));await settle();
        },
        async reject() {reject();await flushRejectedLoader();}, async close() {reject();await flushRejectedLoader();}};
}

/** 只按受控 inline display/连接状态判显示；不包含真实 CSS 几何、Element Plus 或原生焦点证明。 */
function providerFeedbackDisplayed(node: Element | null): boolean {
    if (!node?.isConnected) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
        const element = current as HTMLElement;
        if (element.hidden || element.style?.display === 'none' || element.style?.visibility === 'hidden'
            || element.style?.opacity === '0' || element.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
}
function expectProviderFailureHasNoSideEffects(fixture: Awaited<ReturnType<typeof mountProviderFailureSections>>, before: string, patchCalls = 0) {
    expect(fixture.document.querySelector('[data-testid="custom-service-dialog"]')).toBeNull();
    expect(fixture.providerMounted).not.toHaveBeenCalled();expect(fixture.focus).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.state.config)).toBe(before);expect(fixture.patch).toHaveBeenCalledTimes(patchCalls);
}

// 2 个普通声明 + 一个三项参数化声明；仅静态预计5展开，不冒称实际收集/通过。
describe('新服务首次 loader 拒绝的父状态显示端口归属', () => {
    it('首次公开添加 pending 时显示就地中文加载，未挂子实例、保存或聚焦', async () => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();expect(fixture.loadProvider).toHaveBeenCalledOnce();
            const loading = fixture.document.querySelector('[data-testid="custom-service-load-status"]');
            expect(providerFeedbackDisplayed(loading)).toBe(true);expect(loading!.getAttribute('role')).toBe('status');
            expect(loading!.textContent).toMatch(/加载/u);
            const heading = loading!.closest('[data-fixture-add-service-row]');
            expect(heading).not.toBeNull();expect(heading!.querySelector('[data-testid="fixture-add-service"]')).not.toBeNull();
            expect(fixture.document.querySelector('[data-testid="custom-service-load-error"]')).toBeNull();
            expectProviderFailureHasNoSideEffects(fixture, before);
        } finally {await fixture.close();}
    });
    it('同次公开添加 reject 显示邻近中文错误，异常捕获不能替代错误节点', async () => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();await fixture.reject();
            const error = fixture.document.querySelector('[data-testid="custom-service-load-error"]');
            expect(providerFeedbackDisplayed(error)).toBe(true);expect(error!.getAttribute('role')).toBe('alert');
            expect(error!.textContent).toMatch(/无法(?:打开|加载)|加载失败/u);expect(error!.textContent).not.toContain(fixture.cause.message);
            const heading = error!.closest('[data-fixture-add-service-row]');
            expect(heading).not.toBeNull();expect(heading!.querySelector('[data-testid="fixture-add-service"]')).not.toBeNull();
            expect(providerFeedbackDisplayed(fixture.document.querySelector('[data-testid="custom-service-load-status"]'))).toBe(false);
            expectProviderFailureHasNoSideEffects(fixture, before);
        } finally {await fixture.close();}
    });
    it.each(['section', 'keepalive', 'unmount'] as const)('%s之后迟到reject不展示/挂载/聚焦或追加保存，返回不复活旧请求', async reason => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();expect(fixture.loadProvider).toHaveBeenCalledOnce();
            if (reason === 'section') fixture.props.activeSection = 'settings-general';
            else if (reason === 'keepalive') fixture.visible.value = false;
            else {app!.unmount();app = undefined;}
            await settle();const exitSaves = fixture.patch.mock.calls.length;
            await fixture.reject();
            for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
            }
            expectProviderFailureHasNoSideEffects(fixture, before, exitSaves);
            if (reason !== 'unmount') {
                fixture.props.activeSection = 'settings-services';fixture.visible.value = true;await settle();
                for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                    expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
                }
                expectProviderFailureHasNoSideEffects(fixture, before, exitSaves);expect(fixture.loadProvider).toHaveBeenCalledOnce();
            }
        } finally {await fixture.close();}
    });
});


// 新增3个普通声明，连同上方原5项静态预计8展开；实际数量和结果待根执行。
describe('服务窗口加载反馈公开关闭与已知失败归属', () => {
    it('pending 重复公开添加仅一次加载，关闭后迟到拒绝无反馈、子实例或副作用', async () => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();await fixture.add();expect(fixture.loadProvider).toHaveBeenCalledOnce();
            expect(providerFeedbackDisplayed(fixture.document.querySelector('[data-testid="custom-service-load-status"]'))).toBe(true);
            const close = fixture.document.querySelector('[data-testid="custom-service-load-close"]');
            expect(providerFeedbackDisplayed(close)).toBe(true);expect(close!.textContent).toBe('关闭');
            await fixture.feedbackClose(close);
            for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
            }
            expectProviderFailureHasNoSideEffects(fixture, before);
            await fixture.reject();
            for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
            }
            expect(fixture.loadProvider).toHaveBeenCalledOnce();expectProviderFailureHasNoSideEffects(fixture, before);expect(fixture.vueErrors).toEqual([]);
        } finally {await fixture.close();}
    });
    it('error 关闭后显式重新添加显示已知失败，不再加载且旧关闭节点不能撤销新反馈', async () => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();await fixture.reject();
            const oldError = fixture.document.querySelector('[data-testid="custom-service-load-error"]');
            expect(providerFeedbackDisplayed(oldError)).toBe(true);expect(oldError!.getAttribute('role')).toBe('alert');
            expect(oldError!.textContent).toContain('此栏目暂时无法打开，请重新加载页面后再试。');
            const oldClose = fixture.document.querySelector('[data-testid="custom-service-load-close"]');
            expect(providerFeedbackDisplayed(oldClose)).toBe(true);expect(oldClose!.textContent).toBe('关闭');
            await fixture.feedbackClose(oldClose);
            expect(providerFeedbackDisplayed(fixture.document.querySelector('[data-testid="custom-service-load-error"]'))).toBe(false);
            expect(oldClose!.isConnected).toBe(false);expectProviderFailureHasNoSideEffects(fixture, before);
            await fixture.add();expect(fixture.loadProvider).toHaveBeenCalledOnce();
            const currentError = fixture.document.querySelector('[data-testid="custom-service-load-error"]');
            const currentClose = fixture.document.querySelector('[data-testid="custom-service-load-close"]');
            expect(providerFeedbackDisplayed(currentError)).toBe(true);expect(currentError).not.toBe(oldError);
            expect(currentError!.getAttribute('role')).toBe('alert');
            expect(currentError!.textContent).toContain('此栏目暂时无法打开，请重新加载页面后再试。');
            expect(providerFeedbackDisplayed(currentClose)).toBe(true);expect(currentClose).not.toBe(oldClose);
            expect(providerFeedbackDisplayed(fixture.document.querySelector('[data-testid="custom-service-load-status"]'))).toBe(false);
            await fixture.feedbackClose(oldClose);
            expect(fixture.document.querySelector('[data-testid="custom-service-load-error"]')).toBe(currentError);
            expect(providerFeedbackDisplayed(currentError)).toBe(true);
            expect(fixture.document.querySelector('[data-testid="custom-service-load-close"]')).toBe(currentClose);
            expect(fixture.loadProvider).toHaveBeenCalledOnce();expect(fixture.vueErrors).toEqual([]);
            expectProviderFailureHasNoSideEffects(fixture, before);
        } finally {await fixture.close();}
    });
    it('section 离开后拒绝不复活，返回仅显式公开添加显示已知失败而不重新导入', async () => {
        const fixture = await mountProviderFailureSections();const before = JSON.stringify(fixture.state.config);
        try {
            await fixture.add();fixture.props.activeSection = 'settings-general';await settle();
            const exitSaves = fixture.patch.mock.calls.length;
            await fixture.reject();
            for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
            }
            fixture.props.activeSection = 'settings-services';await settle();
            for (const selector of ['custom-service-load-status', 'custom-service-load-error']) {
                expect(providerFeedbackDisplayed(fixture.document.querySelector(`[data-testid="${selector}"]`))).toBe(false);
            }
            await fixture.add();expect(fixture.loadProvider).toHaveBeenCalledOnce();
            const error = fixture.document.querySelector('[data-testid="custom-service-load-error"]');
            expect(providerFeedbackDisplayed(error)).toBe(true);expect(error!.getAttribute('role')).toBe('alert');
            expect(error!.textContent).toContain('此栏目暂时无法打开，请重新加载页面后再试。');
            expect(providerFeedbackDisplayed(fixture.document.querySelector('[data-testid="custom-service-load-status"]'))).toBe(false);
            expect(fixture.vueErrors).toEqual([]);expectProviderFailureHasNoSideEffects(fixture, before, exitSaves);
        } finally {await fixture.close();}
    });
});
