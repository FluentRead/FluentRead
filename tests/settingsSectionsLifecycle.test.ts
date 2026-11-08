import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import {customModelString, defaultOption, models} from '@/src/core/config/catalog';
import {getApiKeyRequirementKey} from '@/src/core/config/validation';
import {afterEach, describe, expect, it, vi, type Mock} from 'vitest';

const key = '__frSettingsSectionsLifecycle';
let app: import('vue').App | undefined;
afterEach(async () => {app?.unmount(); app = undefined;
    delete (globalThis as Record<string, unknown>)[key];vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
async function settle() {await runtime.nextTick();for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick();}
// 实际父/子 SFC 模板使用 LinkeDOM 节点和事件；Element Plus 弹窗动画、浏览器焦点由根任务真实浏览器复验。
function createDomRenderer(document: Document, focus: Mock<HTMLElement['focus']>) {
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

/** Import the real SFC with the same external/display ports as the previous SSR fixture. */
function configureSectionPorts(data: Record<string, any>, {template = false, requestLimits = false,
    repairReturn = false, development = false, browserName = 'chrome', failureDisplay = false, serviceEvents = false, uiEvents = false}: {
    template?: boolean; requestLimits?: boolean; serviceSelectors?: boolean; repairReturn?: boolean;
    development?: boolean; browserName?: string; failureDisplay?: boolean; serviceEvents?: boolean; uiEvents?: boolean} = {}) {
    vi.resetModules();
    const empty = {render: () => null};
    const slots = {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()]);}};
    const componentPort = (path: string, component: import('vue').Component = empty) => vi.doMock(path, () => ({__esModule: true, default: component}));
    vi.doMock('@/src/services/config/store', () => data);
    vi.doMock('webextension-polyfill', () => ({default: data.browser}));
    vi.doMock('@/src/ui/interfaceAppearance', () => ({applyInterfaceTheme: data.theme}));
    vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: runtime.ref('zh-CN'), bundleRevision: runtime.ref(0),
        t: (name: string) => failureDisplay ? ({'common.loading': '加载中…', 'learning.panelLoadError': '此栏目暂时无法打开，请重新加载页面后再试。',
            'learning.reloadPage': '重新加载页面', 'common.close': '关闭'} as Record<string, string>)[name] ?? name : name,
        translateLegacy: (text: string) => text}), localizeServiceOptions: (options: unknown) => options}));
    vi.doMock('element-plus', () => ({ElMessage: Object.assign(() => {}, {warning: () => {}})}));
    vi.doMock('@element-plus/icons-vue', () => ({ArrowRight: {}, InfoFilled: {}, Edit: {}}));
    vi.doMock('@/src/platform/chatgpt-plan/buildMode', () => ({chatGPTPlanDevelopmentEnabled: development}));
    vi.doMock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {browser: browserName, extensionDom: true, imageTranslation: true}}));
    for (const path of [
        '@/src/ui/components/FeatureEnableCard.vue', '@/src/ui/components/GlossaryLibrarySelect.vue',
        '@/src/ui/components/CustomHotkeyInput.vue', '@/src/ui/components/ServiceIcon.vue', '@/src/ui/components/UiLanguageSelector.vue',
        '@/src/features/settings/ui/FeatureServiceSettings.vue', '@/src/features/settings/ui/services/ServiceConfiguration.vue',
        '@/src/features/settings/ui/WritingSettings.vue', '@/src/features/settings/ui/InformationHighlightSettings.vue',
        '@/src/features/settings/ui/SelectionSettings.vue', '@/src/features/settings/ui/FloatingBallSettings.vue',
        '@/src/features/settings/ui/SiteAdaptationSettings.vue', '@/src/features/settings/ui/SitePreferencesSettings.vue',
        '@/src/features/settings/ui/SiteRulePreview.vue', '@/src/features/settings/ui/VideoLocalModelSettings.vue',
        '@/src/features/settings/ui/LocalTtsSettings.vue', '@/src/features/settings/ui/VideoSubtitleAppearanceSettings.vue',
        '@/src/features/settings/ui/InterfaceSettings.vue', '@/src/features/settings/ui/AreaTranslationSettings.vue',
        '@/src/features/settings/ui/InputTranslationSettings.vue', '@/src/features/settings/ui/ParagraphCopySettings.vue',
        '@/src/features/settings/ui/SectionTranslationSettings.vue', '@/src/features/settings/ui/ParagraphHandlingSettings.vue',
        '@/src/features/settings/ui/TranslationCacheSettings.vue', '@/src/features/settings/ui/ExcludedLanguageSettings.vue',
        '@/src/features/settings/ui/ReadingAssistanceSettings.vue', '@/src/features/settings/ui/ConfigManagement.vue',
        '@/src/features/settings/ui/QuickTranslationProfiles.vue', '@/src/features/settings/ui/ContextMenuSettings.vue',
        '@/src/features/settings/ui/components/FieldHelp.vue',
    ]) componentPort(path);
    componentPort('@/src/features/settings/ui/TranslationCacheSettings.vue', {props: ['active', 'config'],
        setup(props: any) {data.cacheSettings = props;return () => null;}});
    vi.doMock('@/src/features/translation-center/public', () => ({TranslationCenter: empty}));
    vi.doMock('@/src/features/glossary/public', () => ({GlossarySettings: {props: ['active'],
        setup(props: any) {data.glossarySettings = props;runtime.onMounted(data.glossaryMounted);return () => null;}}}));
    vi.doMock('@/src/features/image-translation/ui/public', () => ({ImageOcrSettings: empty, MangaSettings: empty}));
    vi.doMock('@/src/features/model-usage/public', () => ({ModelUsageDashboard: empty}));
    vi.doMock('@/src/features/translation-stats/public', () => ({TranslationStatsDashboard: empty}));
    componentPort('@/src/features/settings/ui/components/SettingsGroup.vue', {setup(_: unknown, {slots}: any) {
        return () => runtime.h('div', null, [slots['heading-extra']?.(), slots.default?.()]);
    }});
    componentPort('@/src/features/settings/ui/components/SettingsItem.vue', slots);
    vi.doMock('@/src/features/settings/ui/components/SettingsPanel.vue', () => repairReturn
        ? vi.importActual('@/src/features/settings/ui/components/SettingsPanel.vue') : {default: slots});
    vi.doMock('@/src/features/settings/ui/services/ServiceRepairReturn.vue', () => repairReturn
        ? vi.importActual('@/src/features/settings/ui/services/ServiceRepairReturn.vue') : {default: empty});
    vi.doMock('@/src/features/settings/ui/services/RequestLimitFields.vue', () => requestLimits
        ? vi.importActual('@/src/features/settings/ui/services/RequestLimitFields.vue') : {default: empty});
    vi.doMock('@/src/features/settings/ui/components/SettingsNumberInput.vue', () => requestLimits
        ? vi.importActual('@/src/features/settings/ui/components/SettingsNumberInput.vue') : {default: empty});
    vi.doMock('@/src/features/settings/ui/services/CompositeTranslationFields.vue', () => template && !failureDisplay
        ? vi.importActual('@/src/features/settings/ui/services/CompositeTranslationFields.vue') : {default: empty});
    vi.doMock('@/src/features/settings/ui/components/SegmentedControl.vue', () => template && !failureDisplay
        ? vi.importActual('@/src/features/settings/ui/components/SegmentedControl.vue') : {default: empty});
    vi.doMock('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue', async () =>
        ({__esModule: true, default: template ? await data.loadProvider() : empty}));
    componentPort('@/src/features/settings/ui/services/ServiceCatalog.vue', template ? {props: ['active','service','modelOptions','selectedModel'], emits: ['add:service','update:service','update:default-service','toggle-availability','update:model','add:model','remove:model'],
        setup(props: any, {emit, slots}: any) {
            if (serviceEvents) data.serviceCatalog = {props, emit};
            if (!failureDisplay) runtime.onMounted(data.catalogMounted);
            return () => {
                if (!props.active) return null;
                const button = runtime.h('button', {'data-testid': 'fixture-add-service', onClick: () => emit('add:service')}, '添加服务');
                return failureDisplay ? runtime.h('section', {'data-fixture-catalog-display': ''},
                    [runtime.h('div', {'data-fixture-add-service-row': ''}, [button, slots['add-service-status']?.()])]) : serviceEvents ? runtime.h('section', null, [button,slots.configuration?.({connectionActionTarget:undefined})]) : button;
            };
        }} : empty);
    if (uiEvents) {
        componentPort('@/src/features/settings/ui/components/SettingsItem.vue', {setup(_, {slots}) {return () => runtime.h('div', null, [slots.copy?.(),slots.description?.(),slots.default?.()]);}});
        // 仅替换已单独测试的子组件边界，保留真实父模板及其 v-model/事件处理器。
        for (const [name, path] of Object.entries({
            feature: '@/src/ui/components/FeatureEnableCard.vue',
            hotkey: '@/src/ui/components/CustomHotkeyInput.vue',
            assignment: '@/src/features/settings/ui/FeatureServiceSettings.vue',
            writing: '@/src/features/settings/ui/WritingSettings.vue',
            selection: '@/src/features/settings/ui/SelectionSettings.vue',
            adaptation: '@/src/features/settings/ui/SiteAdaptationSettings.vue',
            reading: '@/src/features/settings/ui/ReadingAssistanceSettings.vue',
            profiles: '@/src/features/settings/ui/QuickTranslationProfiles.vue',
            excluded: '@/src/features/settings/ui/ExcludedLanguageSettings.vue',
            glossary: '@/src/ui/components/GlossaryLibrarySelect.vue',
            area: '@/src/features/settings/ui/AreaTranslationSettings.vue',
        })) componentPort(path, childEventPort(name, data.uiPorts));
        vi.doMock('@/src/features/image-translation/ui/public', () => ({
            MangaSettings: childEventPort('manga', data.uiPorts), ImageOcrSettings: childEventPort('ocr', data.uiPorts),
        }));
    }
    if (serviceEvents) componentPort('@/src/features/settings/ui/services/ServiceConfiguration.vue', {
        props:['active','config','service','compute','selectedModelThinking','customProvider'],
        emits:['update:model-thinking','update:custom-provider','delete:custom-provider','remove:service'],
        setup(props, {emit}) {data.serviceConfiguration={props,emit};return()=>runtime.h('div',{'data-configuration-port':props.service});},
    });
}

type ChildEventPort = {attrs: Record<string, any>; emit: (event: string, ...args: unknown[]) => void};
function childEventPort(name: string, ports: Map<string, ChildEventPort>) {
    return runtime.defineComponent({inheritAttrs: false, setup(_, {attrs, emit, slots}) {
        return () => {
            const id = `${name}:${attrs.action ?? attrs.title ?? attrs['aria-label'] ?? ''}`;
            ports.set(id, {attrs, emit});
            return runtime.h('div', {'data-child-event-port': id}, [slots.default?.(), slots.description?.(), slots.resources?.()]);
        };
    }});
}

type NumericChange = (value: number | undefined) => void;
type NumericPort = {disabled: boolean; change: NumericChange; update: NumericChange};

async function mountSections({ready = Promise.resolve(), configSnapshot, template = false, providerGate = Promise.resolve(), activeSection = 'settings-translation', requestLimits = false, development = false, serviceSelectors = false, search = '', repairReturn = false, browserName = 'chrome', serviceEvents = false, uiEvents = false}:
    {ready?: Promise<void>; configSnapshot?: Record<string, unknown>; template?: boolean; providerGate?: Promise<void>; activeSection?: string; requestLimits?: boolean; development?: boolean; serviceSelectors?: boolean; search?: string; repairReturn?: boolean; browserName?: string; serviceEvents?: boolean; uiEvents?: boolean} = {}) {
    const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
    const query = vi.fn((_options: Record<string, unknown>) => Promise.resolve([] as {id?: number}[]));
    const send = vi.fn((_id: number, _message: {type: string; isEnabled?: boolean; mode?: string}) => Promise.resolve());
    const patch = vi.fn((_value: unknown) => Promise.resolve());const theme = vi.fn();const unsubscribe = vi.fn();
    const media = {matches: false, onchange: null as (() => void) | null};
    const location = {hash: '', search, protocol: 'chrome-extension:'};
    if (repairReturn) vi.stubGlobal('location', {href: `chrome-extension://fixture/options.html${search}`});
    const pageWindow = Object.assign(new EventTarget(), {location, navigator: {userAgent: ''}, matchMedia: () => media,
        requestAnimationFrame: (fn: FrameRequestCallback) => {frames.set(++nextFrame, fn);return nextFrame;},
        cancelAnimationFrame: (id: number) => frames.delete(id)});
    vi.stubGlobal('window', pageWindow);
    const dom = parseHTML('<html><body><main id="fixture"></main></body></html>');
    const findTarget = vi.spyOn(dom.document, 'querySelector');
    let pageVisibility: 'visible' | 'hidden' = 'visible';
    const ownerDocument = dom.document;
    Object.defineProperty(ownerDocument, 'visibilityState', {configurable: true, get: () => pageVisibility});
    vi.stubGlobal('document', ownerDocument);
    const setVisibility = (value: 'visible' | 'hidden') => {pageVisibility = value;
        dom.document.dispatchEvent(new dom.window.Event('visibilitychange'));};
    // window 使用原生 EventTarget；DOM 使用 LinkeDOM 事件，不能混用两个事件实现。
    const pageEvent = (type: 'pagehide' | 'pageshow') => pageWindow.dispatchEvent(new Event(type));
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    const focus = vi.fn(), providerMounted = vi.fn(), providerUnmounted = vi.fn();
    const numericPorts = new Map<string, NumericPort>();
    let providerState: Record<string, any> | undefined;
    const providerReady = deferred<void>();
    const catalogReady = deferred<void>();
    const glossaryReady = deferred<void>();
    const loadProvider = vi.fn(async () => {
        await providerGate;
        const component = (await vi.importActual<typeof import('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')>('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')).default;
        providerReady.resolve();return component;
    });
    let notifyConfig: (value: unknown) => void = () => {};
    const data = {glossaryMounted: () => glossaryReady.resolve(), glossarySettings: undefined as undefined | Record<string, any>, cacheSettings: {} as Record<string, any>, uiPorts: new Map<string, ChildEventPort>(), serviceCatalog:undefined as undefined | {props:Record<string,any>;emit:(event:string,...args:any[])=>void},serviceConfiguration:undefined as undefined | {props:Record<string,any>;emit:(event:string,...args:any[])=>void},loadProvider, catalogMounted: () => catalogReady.resolve(), config: configSnapshot ?? {}, configReady: ready,
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
    configureSectionPorts(data, {template, requestLimits, serviceSelectors, repairReturn, development, browserName, serviceEvents, uiEvents});
    const imported = (await import('@/src/features/settings/ui/SettingsSections.vue')).default;
    const component = imported;
    const renderer = createDomRenderer(dom.document as unknown as Document, focus);
    const visible = runtime.ref(true);const props = runtime.reactive({activeSection, activePanel: undefined as string | undefined, onNavigateSection: undefined as undefined | ((section: string, target?: string) => void)});
    let state!: Record<string, any>;
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component as runtime.Component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
        : runtime.h({render: () => null}, {key: 'other'})})});
    let dialogPort: Record<string, any> | undefined;
    if (requestLimits) {
        // Only the numeric widget is a public port; parent/child templates, validation and action context stay real.
        app.component('el-input-number', runtime.defineComponent({inheritAttrs: false, emits:['update:modelValue'],
            props: {modelValue: Number, disabled: Boolean,
                onChange: Function as import('vue').PropType<NumericChange>},
            setup(numberProps, {attrs, emit}) {
                return () => {
                    const change = numberProps.onChange ?? (() => {}), update: NumericChange = value => emit('update:modelValue', value);
                    numericPorts.set(String(attrs['aria-label']), {disabled: numberProps.disabled, change, update});
                    return runtime.h('input', {...attrs, type: 'number', value: numberProps.modelValue, disabled: numberProps.disabled,
                        onChange: (event: Event) => change(Number((event.target as HTMLInputElement).value))});
                };
            }}));
    }
    if (uiEvents) {
        for (const name of ['el-select', 'el-switch']) app.component(name, childEventPort(name, data.uiPorts));
    }
    if (template) {
        app.mixin({mounted() {
            if (this.$options.__name === 'CustomOpenAIProviderDialog') {providerState = (this as any).$.setupState;providerMounted();}
        }, unmounted() {if (this.$options.__name === 'CustomOpenAIProviderDialog') providerUnmounted();}});
        app.component('el-dialog', runtime.defineComponent({props: ['modelValue'], setup(props, {attrs, slots}) {
            return () => {dialogPort = {open: props.modelValue, opened: attrs.onOpened};
                return runtime.h('div', {...attrs, 'data-fixture-open': String(props.modelValue)}, [slots.default?.(), slots.footer?.()]);};
        }}));
    }
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};
    app.mount(dom.document.querySelector('#fixture')!);await settle();
    // 等实际异步目录组件挂载；静态表单仅需 Vue 更新队列，不为每例固定等待 60 ms。
    if (template && activeSection === 'settings-services') {await catalogReady.promise;await settle();}
    return {state, props, visible, document: dom?.document, domWindow: dom?.window, setVisibility, pageEvent, numericPorts, loadProvider, focus, providerMounted, providerUnmounted,
        get providerState() {return providerState;}, get dialogPort() {return dialogPort;},
        async finishGlossaryLoad() {await glossaryReady.promise;await settle();},
        async finishProviderLoad() {await providerReady.promise;await new Promise(resolve => setTimeout(resolve, 0));await settle();}, query, send, patch, theme, media, unsubscribe, frames, findTarget, location, data,
        notifyConfig: (value: unknown) => notifyConfig(value)};
}

describe('设置主表单实际组件异步归属', () => {
    it('术语库首次访问才挂载，离开和 KeepAlive 隐藏时失活但保留同一组件实例', async () => {
        const {props, visible, data, finishGlossaryLoad} = await mountSections({activeSection: 'settings-general'});
        expect(data.glossarySettings).toBeUndefined();
        props.activeSection = 'settings-glossary';await finishGlossaryLoad();
        const instance = data.glossarySettings!;expect(instance.active).toBe(true);
        props.activeSection = 'settings-general';await settle();expect(instance.active).toBe(false);
        props.activeSection = 'settings-glossary';await settle();expect(data.glossarySettings).toBe(instance);expect(instance.active).toBe(true);
        visible.value = false;await settle();expect(instance.active).toBe(false);
        visible.value = true;await settle();expect(data.glossarySettings).toBe(instance);expect(instance.active).toBe(true);
    });
    it('缓存面板保留实例并由高级页、页内分类和 KeepAlive 活跃状态共同授权', async () => {
        const {props, visible, data} = await mountSections({activeSection: 'settings-advanced'});await settle();
        expect(data.cacheSettings.active).toBe(true);
        props.activePanel = 'requests';await settle();expect(data.cacheSettings.active).toBe(false);
        props.activePanel = 'cache';await settle();expect(data.cacheSettings.active).toBe(true);
        props.activeSection = 'settings-general';await settle();expect(data.cacheSettings.active).toBe(false);
        props.activeSection = 'settings-advanced';await settle();expect(data.cacheSettings.active).toBe(true);
        const instance = data.cacheSettings;visible.value = false;await settle();expect(instance.active).toBe(false);
        visible.value = true;await settle();expect(data.cacheSettings).toBe(instance);expect(instance.active).toBe(true);
    });
    it('普通划词实际面板仅展示明确来源返回按钮，挂载不请求标签或修复焦点', async () => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-selection', search: '?returnTabId=7'});
        const section = h.document!.querySelector('#settings-selection')!;
        const bar = section.querySelector('[data-service-repair-return]')!;
        expect(bar).not.toBeNull();expect(section.querySelectorAll('[data-return-source-tab]')).toHaveLength(1);
        expect(bar.querySelector('p')).toBeNull();expect(bar.textContent).toContain('返回原网页');expect(bar.textContent).not.toContain('重试翻译');
        expect(h.data.browser.tabs.get).not.toHaveBeenCalled();expect(h.data.browser.tabs.update).not.toHaveBeenCalled();expect(h.focus).not.toHaveBeenCalled();
        bar.querySelector('[data-return-source-tab]')!.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        expect(h.data.browser.tabs.get).toHaveBeenCalledWith(7);expect(h.data.browser.tabs.update).toHaveBeenCalledWith(7, {active: true});
        expect(bar.querySelector('p')).toBeNull();expect(h.patch).not.toHaveBeenCalled();
    });
    it.each(['', '?returnTabId=-1', '?returnTabId=7&returnTabId=8'])('普通划词无有效来源 %s 时不渲染返回动作', async search => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-selection', search});
        expect(h.document!.querySelector('#settings-selection [data-return-source-tab]')).toBeNull();
        expect(h.data.browser.tabs.get).not.toHaveBeenCalled();expect(h.data.browser.tabs.update).not.toHaveBeenCalled();
    });
    it('普通来源返回条只属于已访问的划词面板，v-show 离开后旧节点失活', async () => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-general', search: '?returnTabId=7'});
        expect(h.document!.querySelector('[data-return-source-tab]')).toBeNull();
        h.props.activeSection = 'settings-selection';await settle();
        const sourceButton = h.document!.querySelector('#settings-selection [data-return-source-tab]')!;
        expect(sourceButton).not.toBeNull();h.props.activeSection = 'settings-general';await settle();
        expect(h.document!.querySelector('#settings-general [data-return-source-tab]')).toBeNull();
        // 已访问面板按既有 v-show 保留节点；不把 DOM 存在误当成可操作。
        expect(sourceButton.hasAttribute('disabled')).toBe(true);sourceButton.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        expect(h.data.browser.tabs.get).not.toHaveBeenCalled();
        h.props.activeSection = 'settings-selection';await settle();
        h.document!.querySelector('#settings-selection [data-return-source-tab]')!.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        expect(h.data.browser.tabs.update).toHaveBeenCalledWith(7, {active: true});
    });
    it.each(['section', 'cached', 'config', 'visibility', 'pagehide', 'unmount'] as const)('普通划词返回等待中 %s 变化即使恢复也不复活旧查询', async reason => {
        const h = await mountSections({template: true, repairReturn: true, activeSection: 'settings-selection', search: '?returnTabId=7'}), gate = deferred<{id: number; url: string}>();
        const before = JSON.stringify(h.state.config);
        h.data.browser.tabs.get.mockReturnValueOnce(gate.promise);
        h.document!.querySelector('#settings-selection [data-return-source-tab]')!.dispatchEvent(new h.domWindow!.Event('click'));await settle();
        expect(h.data.browser.tabs.get).toHaveBeenCalledOnce();
        if (reason === 'section') {h.props.activeSection = 'settings-general';await settle();h.props.activeSection = 'settings-selection';}
        if (reason === 'cached') {h.visible.value = false;await settle();h.visible.value = true;}
        if (reason === 'config') h.state.config = {...h.state.config};
        // 这两个用例是真实页面事件；并非 active prop 或 KeepAlive 的别名。
        if (reason === 'visibility') {h.setVisibility('hidden');h.setVisibility('visible');}
        if (reason === 'pagehide') {h.pageEvent('pagehide');h.pageEvent('pageshow');}
        if (reason === 'unmount') {app!.unmount();app = undefined;}
        await settle();expect(h.data.browser.tabs.get).toHaveBeenCalledOnce();gate.resolve({id: 7, url: 'https://example.test/late'});await settle();
        expect(h.data.browser.tabs.update).not.toHaveBeenCalled();
        if (reason !== 'unmount') {
            const current = h.document!.querySelector('#settings-selection [data-return-source-tab]')!;
            expect(current.hasAttribute('disabled')).toBe(false);current.dispatchEvent(new h.domWindow!.Event('click'));await settle();
            expect(h.data.browser.tabs.get).toHaveBeenCalledTimes(2);expect(h.data.browser.tabs.update).toHaveBeenCalledWith(7, {active: true});
        }
        expect(JSON.stringify(h.state.config)).toBe(before);
        // 父表单原有 pagehide/unmount 会交接最终草稿；返回动作不应额外修改或保存配置。
        if (reason === 'pagehide' || reason === 'unmount') {
            expect(h.patch).toHaveBeenCalledOnce();expect(JSON.stringify(h.patch.mock.calls[0][0])).toBe(before);
        } else expect(h.patch).not.toHaveBeenCalled();
    });
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
    it('批量水合重建字段签名，后续编辑只重扫对应分支且仍同步保存', async () => {
        const {state, patch, notifyConfig} = await mountSections({configSnapshot: {to: 'en', theme: 'dark', glossaryLibraries: [{
            id: 'library', name: 'Library', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
            entries: Array.from({length: 500}, (_, index) => ({id: `term-${index}`, source: `term ${index}`, target: `术语${index}`, caseSensitive: false})),
        }]}});
        expect(state.config.to).toBe('en');expect(state.config.theme).toBe('dark');expect(patch).not.toHaveBeenCalled();
        const stringify = JSON.stringify;
        const draftScans: unknown[] = [];
        vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
            if (runtime.isReactive(value)) draftScans.push(value);
            return stringify(value, replacer, space);
        });
        notifyConfig({...state.config, to: 'ja', theme: 'light', hotkey: 'Shift', customHotkey: 'Alt+J'});
        expect(draftScans).not.toContain(state.config);
        expect(draftScans.filter(value => value === state.config.harness)).toHaveLength(1);
        expect(draftScans.filter(value => value === state.config.glossaryLibraries)).toHaveLength(1);
        expect(patch).not.toHaveBeenCalled();expect(state.config.to).toBe('ja');
        draftScans.length = 0;
        state.config.to = 'fr';
        expect(patch).toHaveBeenCalledOnce();expect(patch).toHaveBeenCalledWith(expect.objectContaining({to: 'fr'}), expect.any(Function));
        expect(draftScans).not.toContain(state.config.harness);expect(draftScans).not.toContain(state.config.glossaryLibraries);
        state.config.harness.enabled = true;
        expect(patch).toHaveBeenCalledTimes(2);
        expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({harness: expect.objectContaining({enabled: true})}), expect.any(Function));
        expect(draftScans.filter(value => value === state.config.harness)).toHaveLength(1);
        expect(draftScans).not.toContain(state.config.glossaryLibraries);expect(draftScans).not.toContain(state.config);
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
            const stringify = JSON.stringify, previousHarness = runtime.toRaw(state.config.harness);let rejectDraft = true;
            const warnings = vi.fn();app!.config.warnHandler = warnings;
            vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
                if (value && typeof value === 'object' && runtime.isReactive(value) && runtime.toRaw(value) !== previousHarness
                    && 'hoverDelay' in value && rejectDraft) {rejectDraft = false;throw error;}
                return stringify(value, replacer, space);
            });
            expect(() => notifyConfig({...state.config, to: 'ja'})).toThrow(error);
            expect(state.config.to).toBe('ja');
            expect(warnings.mock.calls.map(([message]) => message)).toEqual(['Unhandled error during execution of watcher getter']);
        }
        expect(state.configEditor.applying).toBe(false);
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
        const {state} = await mountSections();const first = state.platformAvailableServiceOptions;
        expect(first.length).toBeGreaterThan(0);state.config.display = 2;await settle();
        expect(state.platformAvailableServiceOptions).toBe(first);
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
        expect(state.platformAvailableServiceOptions.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
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
        expect(state.platformAvailableServiceOptions.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false);
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
async function switchToServiceRestore(fixture: Awaited<ReturnType<typeof mountSections>>) {
    fixture.document!.querySelector('[data-testid="custom-service-type-restore"]')!.dispatchEvent(new fixture.domWindow!.Event('click'));
    await settle();
}
async function selectServiceToRestore(fixture: Awaited<ReturnType<typeof mountSections>>, service: string) {
    const choice = fixture.document!.querySelector<HTMLInputElement>(`input[data-service-restore="${service}"]`)!;
    choice.checked = true;
    choice.dispatchEvent(new fixture.domWindow!.Event('change', {bubbles: true}));
    await settle();
}

describe('新服务对话框实际模板首次挂载与后续实例归属', () => {
    it('唯一添加窗口切换为组合后只保留一个名称与保存按钮，提交不混入隐藏的接口密钥', async () => {
        const fixture = await mountSections({template: true, activeSection: 'settings-services'});
        addProviderFromTemplate(fixture);await fixture.finishProviderLoad();
        const document = fixture.document!;
        expect(fixture.providerState!.serviceType).toBe('interface');
        expect(document.querySelectorAll('[data-testid="custom-service-dialog"]')).toHaveLength(1);
        expect(document.querySelector('[data-testid="custom-service-type-interface"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-testid="custom-service-type-restore"]')).toBeNull();
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
        const timeout = document.querySelector('[data-testid="composite-member-timeout"]')! as unknown as HTMLInputElement;
        expect(timeout).not.toBeNull();
        expect(timeout.closest('details')).toBeNull();
        const timeoutDescriptionId = timeout.getAttribute('aria-describedby');
        expect(timeoutDescriptionId).toBeTruthy();
        const timeoutDescription = document.getElementById(timeoutDescriptionId!);
        expect(timeoutDescription?.textContent).toBe('settings.services.composite.timeoutBehavior');
        expect(timeoutDescription?.closest('details, [hidden], [aria-hidden="true"]')).toBeNull();
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
        timeout.value = '0';timeout.dispatchEvent(new fixture.domWindow!.Event('input', {bubbles: true}));await settle();
        submitProviderFromTemplate(fixture);await settle();
        expect(fixture.state.config.compositeTranslationProviders).toEqual([]);expect(fixture.patch).not.toHaveBeenCalled();
        expect(timeout.getAttribute('aria-invalid')).toBe('true');
        expect(timeout.closest('.setting-control')?.querySelector('[role="alert"]')?.textContent).toBe('settings.services.composite.timeoutInvalid');
        timeout.value = '5';timeout.dispatchEvent(new fixture.domWindow!.Event('input', {bubbles: true}));await settle();
        expect(timeout.getAttribute('aria-invalid')).not.toBe('true');
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
            return (await vi.importActual<typeof import('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')>('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue')).default;
        } finally {finished.resolve();}
    });
    const data = {loadProvider, config: {}, configReady: Promise.resolve(), subscribeConfig: (_listener: (value: unknown) => void) => unsubscribe,
        requestConfigPatch: patch, handoffPendingConfigPatches: vi.fn(() => Promise.resolve()), theme: vi.fn(),
        browser: {runtime: {sendMessage: vi.fn(() => Promise.resolve())}, tabs: {query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn(() => Promise.resolve())}}};
    (globalThis as Record<string, unknown>)[key] = data;
    configureSectionPorts(data, {template: true, failureDisplay: true});
    const component = (await import('@/src/features/settings/ui/SettingsSections.vue')).default;
    // 每个动态创建节点的 focus 只记录，不影响旧 renderer 或全局 HTMLElement prototype。
    const displayDocument = {createElement(name: string) {const node = dom.document.createElement(name);node.focus = focus;return node;},
        createTextNode: dom.document.createTextNode.bind(dom.document), createComment: dom.document.createComment.bind(dom.document),
        querySelector: dom.document.querySelector.bind(dom.document)} as unknown as Document;
    const renderer = createDomRenderer(displayDocument, focus);
    const props = runtime.reactive({activeSection: 'settings-services'}), visible = runtime.ref(true);
    let state!: Record<string, any>;
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component as runtime.Component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
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

// 通过真实父模板收到子组件 emits；服务目录/配置面板是已单独测试的受控 UI 端口。
async function serviceEditorFixture(configSnapshot: Record<string, unknown> = {}) {
    const fixture = await mountSections({template:true,serviceEvents:true,activeSection:'settings-services',configSnapshot});
    await vi.waitFor(()=>expect(fixture.data.serviceConfiguration).toBeDefined());
    const catalog = async (event: string, ...values: unknown[]) => {fixture.data.serviceCatalog!.emit(event,...values);await settle();};
    const configuration = async (event: string, ...values: unknown[]) => {fixture.data.serviceConfiguration!.emit(event,...values);await settle();};
    const availabilityDialog = () => fixture.document!.querySelector('[data-service-availability-dialog]');
    const availabilityAction = async (action: 'cancel' | 'confirm') => {
        const button = availabilityDialog()?.querySelector(`[data-service-availability-${action}]`);
        expect(button).toBeTruthy();
        button!.dispatchEvent(new fixture.domWindow!.Event('click', {bubbles: true}));await settle();
    };
    return {...fixture,catalog,configuration,availabilityDialog,availabilityAction, get providerState() {return fixture.providerState;}};
}
const customConnection = (id='custom:1', model='model-a') => ({id,name:`连接 ${id}`,endpoint:`https://${id.replace(':','-')}.example/v1`,models:[model]});

describe('设置主表单服务目录与模型事件提交',()=>{
    it('切换编辑目标不改默认服务，只有当前目标的显式默认动作能提交',async()=>{
        const f=await serviceEditorFixture({service:'google'});f.patch.mockClear();
        await f.catalog('update:service','microsoft');expect(f.state.selectedConfigurationService).toBe('microsoft');expect(f.state.config.service).toBe('google');expect(f.patch).not.toHaveBeenCalled();
        await f.catalog('update:default-service','openai');expect(f.patch).not.toHaveBeenCalled();
        await f.catalog('update:default-service','microsoft');expect(f.state.config.service).toBe('microsoft');expect(f.patch).toHaveBeenCalledOnce();
        f.props.activeSection='settings-general';await settle();f.patch.mockClear();await f.catalog('update:default-service','google');expect(f.state.config.service).toBe('microsoft');expect(f.patch).not.toHaveBeenCalled();
    });
    it('取消不保存，确认关闭默认服务后一次保存替代项并保留其他入口原有选择',async()=>{
        const f=await serviceEditorFixture({service:'google',hoverTranslationService:'google'});f.patch.mockClear();
        await f.catalog('toggle-availability','google',false);
        expect(f.availabilityDialog()).not.toBeNull();
        expect(f.state.config.disabledTranslationServices).not.toContain('google');
        expect(f.state.config.service).toBe('google');
        expect(f.patch).not.toHaveBeenCalled();
        await f.availabilityAction('cancel');
        expect(f.availabilityDialog()).toBeNull();
        expect(f.patch).not.toHaveBeenCalled();
        await f.catalog('toggle-availability','google',false);
        await f.availabilityAction('confirm');
        expect(f.state.config.disabledTranslationServices).toContain('google');
        expect(f.state.config.service).not.toBe('google');
        expect(f.state.config.disabledTranslationServices).not.toContain(f.state.config.service);
        expect(f.state.config.hoverTranslationService).toBe('google');
        expect(f.patch).toHaveBeenCalled();
        expect(f.patch.mock.calls.at(-1)?.[0]).toMatchObject({service: f.state.config.service, disabledTranslationServices: ['google']});
        expect(f.patch).toHaveBeenCalledOnce();
    });
    it('最后一个启用服务不能关闭，且重新启用只清除该服务的关闭标记',async()=>{
        const f=await serviceEditorFixture({service:'google'});
        const allExceptDefault=f.state.availableServiceOptions.filter((item: {value:string})=>item.value!=='google').map((item: {value:string})=>item.value);
        f.state.config.disabledTranslationServices=allExceptDefault;await settle();f.patch.mockClear();
        await f.catalog('toggle-availability','google',false);
        expect(f.availabilityDialog()).toBeNull();
        expect(f.state.config.disabledTranslationServices).toEqual(allExceptDefault);
        expect(f.state.config.service).toBe('google');
        addProviderFromTemplate(f);await f.finishProviderLoad();
        await switchToServiceRestore(f);
        await selectServiceToRestore(f, 'microsoft');
        expect(f.state.config.disabledTranslationServices).toContain('microsoft');
        expect(f.patch).not.toHaveBeenCalled();
        submitProviderFromTemplate(f);await settle();
        expect(f.state.config.disabledTranslationServices).toEqual(allExceptDefault.filter((service: string) => service !== 'microsoft'));
        expect(f.patch).toHaveBeenCalledOnce();
    });
    it('配置中的替代服务发生变化时，撤销旧确认而不关闭默认服务',async()=>{
        const f=await serviceEditorFixture({service:'google'});
        await f.catalog('toggle-availability','google',false);
        expect(f.availabilityDialog()).not.toBeNull();
        f.state.config.disabledTranslationServices=['freeTranslation'];await settle();
        expect(f.availabilityDialog()).toBeNull();
        expect(f.state.config.service).toBe('google');
        expect(f.state.config.disabledTranslationServices).toEqual(['freeTranslation']);
    });
    it('从自定义服务搜索并恢复移除项，取消不保存且确认保留原有服务配置',async()=>{
        const f=await serviceEditorFixture({
            service: 'google', documentService: 'custom:1', hoverTranslationService: 'custom:1',
            customOpenAIProviders: [customConnection()], token: {'custom:1': 'fixture-key'},
            model: {'custom:1': 'model-a'}, disabledTranslationServices: ['microsoft'],
        });
        await f.catalog('update:service','custom:1');
        await f.catalog('toggle-availability','custom:1',false);
        expect(f.state.selectedConfigurationService).toBe('custom:1');
        await f.availabilityAction('confirm');
        expect(f.state.selectedConfigurationService).toBe('google');
        f.patch.mockClear();

        addProviderFromTemplate(f);await f.finishProviderLoad();
        await switchToServiceRestore(f);
        const choices = () => [...f.document!.querySelectorAll('[data-service-restore]')].map(choice => choice.getAttribute('data-service-restore'));
        expect(choices()).toEqual(expect.arrayContaining(['microsoft', 'custom:1']));
        expect(choices()).toHaveLength(2);
        expect(f.document!.querySelector('[data-testid="custom-service-name"]')).toBeNull();
        expect(f.document!.querySelector('[data-testid="custom-service-save"]')!.hasAttribute('disabled')).toBe(true);
        submitProviderFromTemplate(f);await settle();
        expect(f.patch).not.toHaveBeenCalled();
        inputProvider(f, 'restore-search', 'ＣＵＳＴＯＭ：１');await settle();
        expect(choices()).toEqual(['custom:1']);
        await selectServiceToRestore(f, 'custom:1');
        const staleSubmit = f.providerState!.actions.submit;
        f.document!.querySelector('button.secondary-button')!.dispatchEvent(new f.domWindow!.Event('click'));
        await settle();
        expect(f.state.customProviderDialogOpen).toBe(false);
        expect(f.patch).not.toHaveBeenCalled();
        expect(f.state.config.disabledTranslationServices).toContain('custom:1');

        addProviderFromTemplate(f);await settle();
        expect(f.providerState!.serviceType).toBe('interface');
        await switchToServiceRestore(f);
        expect(choices()).toHaveLength(2);
        await selectServiceToRestore(f, 'custom:1');
        staleSubmit();expect(f.patch).not.toHaveBeenCalled();
        submitProviderFromTemplate(f);await settle();
        expect(f.patch).toHaveBeenCalledOnce();
        expect(f.state.customProviderDialogOpen).toBe(false);
        expect(f.availabilityDialog()).toBeNull();
        expect(f.state.selectedConfigurationService).toBe('google');
        expect(f.state.config).toMatchObject({
            service: 'google', documentService: 'custom:1', hoverTranslationService: 'custom:1',
            token: {'custom:1': 'fixture-key'}, model: {'custom:1': 'model-a'},
            disabledTranslationServices: ['microsoft'], customOpenAIProviders: [customConnection()],
        });
    });
    it('自定义连接添加/选择/删除模型各只提交完整快照，保留同级服务与文档选择',async()=>{
        const f=await serviceEditorFixture({customOpenAIProviders:[customConnection(),customConnection('custom:2','second')],model:{'custom:1':'model-a'},documentModel:{'custom:1':'model-a'}});
        await f.catalog('update:service','custom:1');f.patch.mockClear();
        await f.catalog('add:model','model-b');expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({model:{'custom:1':'model-b'},documentModel:{'custom:1':'model-a'},customOpenAIProviders:[expect.objectContaining({id:'custom:1',models:['model-a','model-b']}),expect.objectContaining({id:'custom:2',models:['second']})]});
        await f.configuration('update:model-thinking',true);expect(f.data.serviceConfiguration!.props.selectedModelThinking).toBe(true);
        f.patch.mockClear();await f.catalog('update:model','model-a');expect(f.state.config.model['custom:1']).toBe('model-a');expect(f.patch).toHaveBeenCalledOnce();
        f.patch.mockClear();await f.catalog('remove:model','model-a');expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.customOpenAIProviders[0].models).toEqual(['model-b']);expect(f.state.config.model['custom:1']).toBe('model-b');expect(f.state.config.documentModel['custom:1']).toBe('model-b');expect(f.state.config.customOpenAIProviders[1].models).toEqual(['second']);
    });
    it('内置服务手动模型与目录模型切换保持自定义列表，删除时清除关联偏好',async()=>{
        const f=await serviceEditorFixture({service:'openai'});await f.catalog('update:service','openai');f.patch.mockClear();
        await f.catalog('add:model','private-model');expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.customModels.openai).toContain('private-model');expect(f.state.config.model.openai).toBe(customModelString);expect(f.state.config.customModel.openai).toBe('private-model');
        await f.configuration('update:model-thinking',true);expect(f.data.serviceConfiguration!.props.selectedModelThinking).toBe(true);
        const known=models.get('openai')!.find(model=>model!==customModelString)!;await f.catalog('update:model',known);expect(f.state.config.model.openai).toBe(known);expect(f.state.config.customModels.openai).toContain('private-model');
        await f.catalog('update:model','private-model');expect(f.state.config.model.openai).toBe(customModelString);expect(f.state.config.customModel.openai).toBe('private-model');
        f.patch.mockClear();await f.catalog('remove:model','private-model');expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.customModels.openai).toBeUndefined();expect(f.state.config.model.openai).not.toBe(customModelString);expect(f.state.config.modelThinking.openai?.['private-model']).toBeUndefined();
    });
    it('修改当前自定义名称和端点只写该连接，删除后清除各功能引用且保留同前缀连接',async()=>{
        const providers=[customConnection('custom','legacy'),customConnection('custom:1','current')];
        const f=await serviceEditorFixture({customOpenAIProviders:providers,service:'custom',documentService:'custom',videoService:'custom',translationCenterServices:['custom','custom:1'],token:{custom:'old-key','custom:1':'current-key'},model:{custom:'legacy','custom:1':'current'},customBody:{custom:'{"legacy":true}'},customHeaders:{custom:'{"X-Fixture":"old"}'}});
        const retainedKey=getApiKeyRequirementKey('custom:1',f.state.config);f.state.config.requireApiKey[retainedKey]=false;await settle();await f.catalog('update:service','custom');f.patch.mockClear();
        await f.configuration('update:custom-provider',{name:'更名',endpoint:'https://new.example/v1'});expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.customOpenAIProviders.find((item:{id:string})=>item.id==='custom')).toMatchObject({name:'更名',endpoint:'https://new.example/v1'});expect(f.state.config.customOpenAIProviders.find((item:{id:string})=>item.id==='custom:1')).toEqual(providers[1]);
        f.patch.mockClear();await f.configuration('delete:custom-provider');expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.customOpenAIProviders).toEqual([providers[1]]);expect(f.state.config.service).toBe(defaultOption.service);expect(f.state.config.documentService).toBe('');expect(f.state.config.videoService).toBe('');expect(f.state.config.translationCenterServices).toEqual(['custom:1']);expect(f.state.config.token['custom:1']).toBe('current-key');expect(f.state.config.requireApiKey[retainedKey]).toBe(false);
        for(const key of ['token','model','documentModel','customModel','customModels','modelThinking','documentCustomModel','proxy','system_role','user_role','customBody','customHeaders'])expect(f.state.config[key].custom,key).toBeUndefined();
    });
    it('删除组合服务仅允许当前有效连接，清理默认与快捷方案引用且保留成员',async()=>{
        const group={id:'composite:1',name:'组合',services:['google','microsoft'],strategy:'sequential',timeoutMs:12000};
        const f=await serviceEditorFixture({service:'composite:1',compositeTranslationProviders:[group],favoriteServices:['composite:1','google'],quickTranslationProfiles:[{id:'profile',enabled:true,action:'hover',hotkey:'Alt+J',service:'composite:1',model:'',targetLanguage:'',displayMode:'inherit',fullPageMode:'inherit'}]});
        await f.catalog('update:service','composite:1');f.patch.mockClear();await f.configuration('remove:service','composite:missing');expect(f.patch).not.toHaveBeenCalled();
        await f.configuration('remove:service','composite:1');expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.compositeTranslationProviders).toEqual([]);expect(f.state.config.service).toBe(defaultOption.service);expect(f.state.config.favoriteServices).toContain('google');expect(f.state.config.favoriteServices).not.toContain('composite:1');expect(f.state.config.quickTranslationProfiles[0].service).toBe('');
    });
});

describe('设置主表单当前连接字段能力',()=>{
    const ai=['showAI','showProxy','showModel','showCustomBody','showToken'];
    const fields=['showAI','showProxy','showModel','showCustomBody','showToken','showYoudao','showTencent','showCloudVendor','showServiceSecret','showServiceRegion','showOllamaEndpoint','showCustomOpenAI','showDeepLX','showMiniMaxRegion','showMiMoRegion','showNewAPI','showAzureOpenaiEndpoint','showDeepseekApiType'];
    it.each([
        {service:'google',visible:[]},
        {service:'openai',visible:ai},
        {service:'youdao',visible:['showYoudao']},
        {service:'tencent',visible:['showProxy','showTencent','showCloudVendor']},
        {service:'aliyunTranslation',visible:['showToken','showCloudVendor','showServiceSecret','showServiceRegion']},
        {service:'ollama',visible:['showAI','showProxy','showModel','showCustomBody','showOllamaEndpoint']},
        {service:'deeplx',visible:['showProxy','showToken','showDeepLX']},
        {service:'minimax',visible:[...ai,'showMiniMaxRegion']},
        {service:'mimo',visible:[...ai,'showMiMoRegion']},
        {service:'newapi',visible:['showAI','showModel','showCustomBody','showToken','showNewAPI']},
        {service:'azureOpenai',visible:['showAI','showModel','showCustomBody','showToken','showAzureOpenaiEndpoint']},
        {service:'deepseek',visible:[...ai,'showDeepseekApiType']},
        {service:'localTranslation',visible:['showModel']},
        {service:'custom:1',visible:[...ai,'showCustomOpenAI']},
    ])('编辑$service时不混入其他厂商字段，也不改网页默认服务',async({service,visible})=>{
        const f=await serviceEditorFixture({service:'microsoft',customOpenAIProviders:[customConnection()]});await f.catalog('update:service',service);
        expect(f.data.serviceConfiguration!.props.service).toBe(service);const compute=f.data.serviceConfiguration!.props.compute;
        expect(Object.fromEntries(fields.map(field=>[field,compute[field]]))).toEqual(Object.fromEntries(fields.map(field=>[field,visible.includes(field)])));
        expect(compute.allowCustomModels).toBe(service!=='localTranslation');expect(f.state.config.service).toBe('microsoft');
        if(service==='aliyunTranslation'){
            expect(compute.cloudCredentialLabels).toEqual({token:'AccessKey ID',secret:'AccessKey Secret'});expect(compute.defaultCloudRegion).toBe('cn-hangzhou');expect(compute.cloudRegionOptions.map((item:{value:string})=>item.value)).toEqual(['cn-hangzhou','ap-southeast-1']);expect(compute.credentialWarning).not.toBe('');
        }else if(service==='google'){
            expect(compute.cloudCredentialLabels).toEqual({token:'API Key'});expect(compute.defaultCloudRegion).toBe('');expect(compute.cloudRegionOptions).toEqual([]);expect(compute.credentialWarning).toBeNull();
        }
    });
    it('密钥要求按当前服务和实际模型保存，切换模型及服务不串写',async()=>{
        const f=await serviceEditorFixture({service:'google',customOpenAIProviders:[{...customConnection(),models:['model-a','model-b']},customConnection('custom:2')]});await f.catalog('update:service','custom:1');
        const first=getApiKeyRequirementKey('custom:1',f.state.config);f.patch.mockClear();expect(f.data.serviceConfiguration!.props.compute.requireApiKey).toBe(true);f.data.serviceConfiguration!.props.compute.requireApiKey=false;await settle();expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.requireApiKey[first]).toBe(false);
        await f.catalog('update:model','model-b');expect(f.data.serviceConfiguration!.props.compute.requireApiKey).toBe(true);await f.catalog('update:model','model-a');expect(f.data.serviceConfiguration!.props.compute.requireApiKey).toBe(false);
        await f.catalog('update:service','custom:2');expect(f.data.serviceConfiguration!.props.compute.requireApiKey).toBe(true);expect(f.state.config.requireApiKey[first]).toBe(false);expect(f.state.config.service).toBe('google');
    });
});

describe('高级重试数值控件的配置与页面归属',()=>{
    it.each([
        {key:'translationMaxRetries',label:'失败后最多重试',initial:2,synced:7,stale:4,applied:4},
        {key:'apiKeyRecoveryMs',label:'settings.requestLimits.apiKeyRecovery',initial:60000,synced:300000,stale:10,applied:600000},
        {key:'translationBackoffBaseMs',label:'settings.requestLimits.initialRetryWait',initial:1000,synced:3000,stale:2000,applied:2000},
        {key:'translationBackoffMaxMs',label:'settings.requestLimits.maximumRetryWait',initial:10000,synced:30000,stale:20000,applied:20000},
    ])('$key外部同步后旧change不能覆盖新值，当前控件仍能修改',async row=>{
        const f=await mountSections({template:true,requestLimits:true,activeSection:'settings-advanced',configSnapshot:{[row.key]:row.initial}});
        const old=f.numericPorts.get(row.label)!.change;f.notifyConfig({...f.state.config,[row.key]:row.synced});await settle();f.patch.mockClear();
        old(row.stale);await settle();expect(f.state.config[row.key]).toBe(row.synced);expect(f.patch).not.toHaveBeenCalled();
        f.numericPorts.get(row.label)!.change(row.stale);await settle();expect(f.state.config[row.key]).toBe(row.applied);expect(f.patch).toHaveBeenCalledOnce();
    });
    it.each(['section','keepalive','unmount'] as const)('%s失活撤销旧重试数值事件，恢复不复活原回调',async reason=>{
        const f=await mountSections({template:true,requestLimits:true,activeSection:'settings-advanced',configSnapshot:{translationMaxRetries:2}});
        const old=f.numericPorts.get('失败后最多重试')!.change;
        if(reason==='section')f.props.activeSection='settings-general';else if(reason==='keepalive')f.visible.value=false;else{app!.unmount();app=undefined}
        await settle();f.patch.mockClear();old(4);await settle();expect(f.state.config.translationMaxRetries).toBe(2);expect(f.patch).not.toHaveBeenCalled();
        if(reason==='unmount')return;
        f.props.activeSection='settings-advanced';f.visible.value=true;await settle();old(4);await settle();expect(f.state.config.translationMaxRetries).toBe(2);expect(f.patch).not.toHaveBeenCalled();
        f.numericPorts.get('失败后最多重试')!.change(4);await settle();expect(f.state.config.translationMaxRetries).toBe(4);expect(f.patch).toHaveBeenCalledOnce();
    });
});

describe('高级重试数值实际控件的校验与单位',()=>{
    it.each([
        {label:'失败后最多重试',invalid:[undefined,NaN,Infinity,1.5,-1,11]},
        {label:'settings.requestLimits.apiKeyRecovery',invalid:[undefined,NaN,Infinity]},
        {label:'settings.requestLimits.initialRetryWait',invalid:[undefined,NaN,Infinity,1.5]},
        {label:'settings.requestLimits.maximumRetryWait',invalid:[undefined,NaN,Infinity,1.5]},
    ])('$label拒绝未完成或非法数字，不提交配置',async({label,invalid})=>{
        const f=await mountSections({template:true,requestLimits:true,activeSection:'settings-advanced'});const before=JSON.stringify(f.state.config);f.patch.mockClear();
        for(const value of invalid){f.numericPorts.get(label)!.change(value);await settle()}
        expect(JSON.stringify(f.state.config)).toBe(before);expect(f.patch).not.toHaveBeenCalled();
    });
    it('Key恢复以分钟编辑并四舍五入，保存值按毫秒且遵守1到60分钟',async()=>{
        const f=await mountSections({template:true,requestLimits:true,activeSection:'settings-advanced'});const label='settings.requestLimits.apiKeyRecovery';
        for(const[value,expected]of [[1.6,120000],[0,60000],[90,3600000]]){f.patch.mockClear();f.numericPorts.get(label)!.change(value);await settle();expect(f.state.config.apiKeyRecoveryMs).toBe(expected);expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({apiKeyRecoveryMs:expected})}
    });
    it('增大初始等待一次保存两个有序边界，最大等待不能小于初始值',async()=>{
        const f=await mountSections({template:true,requestLimits:true,activeSection:'settings-advanced',configSnapshot:{translationBackoffBaseMs:1000,translationBackoffMaxMs:2000}});const base='settings.requestLimits.initialRetryWait',max='settings.requestLimits.maximumRetryWait';f.patch.mockClear();
        f.numericPorts.get(base)!.change(5000);await settle();expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({translationBackoffBaseMs:5000,translationBackoffMaxMs:5000});
        f.patch.mockClear();f.numericPorts.get(max)!.change(1000);await settle();expect(f.state.config.translationBackoffMaxMs).toBe(5000);expect(f.patch).not.toHaveBeenCalled();
        f.numericPorts.get(max)!.change(20000);await settle();expect(f.state.config.translationBackoffMaxMs).toBe(20000);expect(f.patch).toHaveBeenCalledOnce();
        f.patch.mockClear();f.numericPorts.get(base)!.change(-1);await settle();expect(f.state.config.translationBackoffBaseMs).toBe(100);expect(f.state.config.translationBackoffMaxMs).toBe(20000);expect(f.patch).toHaveBeenCalledOnce();
    });
});

async function settingsUiFixture(activeSection: string, configSnapshot: Record<string, unknown> = {}) {
    const f = await mountSections({template: true, uiEvents: true, requestLimits: true, activeSection, configSnapshot});
    const port = async (id: string) => {await vi.waitFor(() => expect(f.data.uiPorts.has(id), id).toBe(true));return f.data.uiPorts.get(id)!;};
    const emit = async (id: string, event: string, ...values: unknown[]) => {(await port(id)).emit(event, ...values);await settle();};
    const choose = async (label: string, text: string) => {
        const button = [...f.document.querySelectorAll(`[role="radiogroup"][aria-label="${label}"] button`)].find(node => node.textContent?.trim() === text);
        expect(button, `${label}: ${text}`).toBeDefined();button!.dispatchEvent(new f.domWindow.Event('click'));await settle();
    };
    return {...f, port, emit, choose};
}

describe('设置父模板实际功能事件', () => {
    it('通用默认服务、目标语和显示模式分别持久化，主题自动追随系统且手动选择不跟随', async () => {
        const f = await settingsUiFixture('settings-general', {service: 'google', to: 'zh-Hans', display: 1, theme: 'auto'});
        f.patch.mockClear();await f.emit('el-select:默认网页翻译服务', 'update:modelValue', 'microsoft');
        expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({service: 'microsoft', to: 'zh-Hans', display: 1});
        f.patch.mockClear();await f.emit('el-select:settings.general.defaultTargetLanguage', 'update:modelValue', 'ja');
        expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({service: 'microsoft', to: 'ja', display: 1});
        f.patch.mockClear();await f.choose('翻译模式', '仅译文模式');expect(f.state.config.display).toBe(0);expect(f.patch).toHaveBeenCalledOnce();
        f.media.matches = true;f.theme.mockClear();f.media.onchange!();expect(f.theme).toHaveBeenLastCalledWith(true, undefined);
        await f.choose('settings.general.theme', '亮色主题');expect(f.state.config.theme).toBe('light');expect(f.theme).toHaveBeenLastCalledWith(false, undefined);
        f.theme.mockClear();f.media.onchange!();expect(f.theme).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
        app!.unmount();app = undefined;expect(f.media.onchange).toBeNull();
    });
    it('全局暂停保留各功能偏好，悬浮球和进度开关仅广播自身状态', async () => {
        const f = await settingsUiFixture('settings-general', {on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual', translationProgressPanelEnabled: true, enableAIContext: false});
        f.query.mockResolvedValue([{id: 8}]);
        await f.emit('el-switch:popup.aiContext.settingsTitle', 'update:modelValue', true);expect(f.state.config.enableAIContext).toBe(true);expect(f.query).not.toHaveBeenCalled();
        expect((await f.port('el-switch:settings.general.floatingBall')).attrs.modelValue).toBe(true);
        await f.emit('el-switch:settings.general.floatingBall', 'update:modelValue', false);expect(f.state.config.disableFloatingBall).toBe(true);expect(f.send).toHaveBeenLastCalledWith(8, {type:'toggleFloatingBall',isEnabled:false});
        f.send.mockClear();await f.emit('el-switch:settings.general.progressPanel','update:modelValue',false);await f.emit('el-switch:settings.general.progressPanel','change',false);
        expect(f.state.config.translationProgressPanelEnabled).toBe(false);expect(f.send).toHaveBeenCalledOnce();expect(f.send).toHaveBeenCalledWith(8,{type:'toggleTranslationProgressPanel',isEnabled:false});
        f.send.mockClear();await f.emit('feature:settings.general.masterTitle','update:modelValue',false);
        expect(f.state.config.on).toBe(false);expect(f.state.config.selectionTranslatorMode).toBe('bilingual');expect(f.state.config.disableFloatingBall).toBe(true);expect(f.send.mock.calls.map(call=>call[1])).toEqual([{type:'toggleFloatingBall',isEnabled:false},{type:'updateSelectionTranslatorMode',mode:'disabled'},{type:'toggleSelectionAreaTranslator',isEnabled:false}]);
    });
    it('当前默认服务和功能分配入口定位编辑连接而不改默认配置', async () => {
        const f = await settingsUiFixture('settings-general', {service:'microsoft'}), navigate = vi.fn();f.props.onNavigateSection=navigate;await settle();f.patch.mockClear();
        f.document.querySelector('[data-testid="configure-default-translation-service"]')!.dispatchEvent(new f.domWindow.Event('click'));await settle();
        expect(navigate).toHaveBeenLastCalledWith('settings-services','connections');expect(f.state.selectedConfigurationService).toBe('microsoft');
        await f.emit('assignment:', 'configure-service', 'openai');expect(f.state.selectedConfigurationService).toBe('openai');expect(f.state.config.service).toBe('microsoft');expect(f.patch).not.toHaveBeenCalled();
        for(const [id,section]of [['open-translation-style-settings','settings-interface'],['open-translation-settings','settings-translation']]){
            f.document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new f.domWindow.Event('click'));await settle();expect(navigate).toHaveBeenLastCalledWith(section,undefined);
        }
        f.document.querySelector('[data-testid="open-floating-ball-settings"]')!.dispatchEvent(new f.domWindow.Event('click'));await settle();expect(navigate).toHaveBeenLastCalledWith('settings-translation','floating-ball-settings');expect(f.patch).not.toHaveBeenCalled();
    });
    it.each(['openai',''])('写作入口根据独立服务 %s 或网页默认定位连接', async service => {
        const f=await settingsUiFixture('settings-writing',{service:'microsoft',writing:{service}}),navigate=vi.fn();f.props.onNavigateSection=navigate;f.patch.mockClear();
        await f.emit('writing:','configure-service');expect(f.state.selectedConfigurationService).toBe(service||'microsoft');expect(navigate).toHaveBeenCalledWith('settings-services','connections');expect(f.patch).not.toHaveBeenCalled();
    });
    it('阅读样式入口定位正确锚点，悬浮与全文方案事件保留同一配置列表',async()=>{
        const f=await settingsUiFixture('settings-translation'),navigate=vi.fn();f.props.onNavigateSection=navigate;
        await f.emit('reading:','configure-style');expect(navigate).toHaveBeenCalledWith('settings-interface','translation-sentence-highlight-style');
        const hover={id:'hover-one',enabled:true,action:'hover',hotkey:'Alt+J',service:'google',model:'',targetLanguage:'',displayMode:'inherit',fullPageMode:'inherit'};
        f.patch.mockClear();await f.emit('profiles:hover','update:profiles',[hover]);expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.quickTranslationProfiles).toEqual([hover]);
        const full={...hover,id:'full-one',action:'full-page',hotkey:'Alt+K'};
        f.patch.mockClear();await f.emit('profiles:full-page','update:profiles',[hover,full]);expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config.quickTranslationProfiles).toEqual([hover,full]);
        await f.emit('el-switch:settings.fullPage.multiSegmentTitle','update:modelValue',false);expect(f.state.config.enableAIMultiSegment).toBe(false);
        await f.choose('全文翻译范围','翻译到页底');expect(f.state.config.fullPageTranslationMode).toBe('all');
        await f.emit('excluded:','update:modelValue',['en','ja']);expect(f.state.config.excludedLanguages).toEqual(['en','ja']);
    });
    it('AI 多段预算实际子组件编辑及恢复默认各原子保存一次，关闭保留两项预算',async()=>{
        const f=await settingsUiFixture('settings-translation',{enableAIMultiSegment:true,aiMultiSegmentMaxSegments:12,aiMultiSegmentMaxCharacters:3500});
        const fragments='settings.fullPage.multiSegmentFragmentsAria';
        await vi.waitFor(()=>expect(f.numericPorts.has(fragments)).toBe(true));f.patch.mockClear();
        f.numericPorts.get(fragments)!.change(24);await settle();
        expect(f.patch).toHaveBeenCalledOnce();expect(f.state.config).toMatchObject({aiMultiSegmentMaxSegments:24,aiMultiSegmentMaxCharacters:3500});
        f.patch.mockClear();f.document.querySelector('[data-testid="ai-multi-segment-reset"]')!.dispatchEvent(new f.domWindow.Event('click'));await settle();
        expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({aiMultiSegmentMaxSegments:8,aiMultiSegmentMaxCharacters:2000});
        expect(f.state.config.enableAIMultiSegment).toBe(true);
        await f.emit('el-switch:settings.fullPage.multiSegmentTitle','update:modelValue',false);
        expect(f.document.querySelector('[data-testid="ai-multi-segment-limits"]')).toBeNull();
        expect(f.state.config).toMatchObject({enableAIMultiSegment:false,aiMultiSegmentMaxSegments:8,aiMultiSegmentMaxCharacters:2000});
    });
    it('网站适配显式保存仅交接适配补丁，并把保存失败留给实际子界面处理',async()=>{
        const f=await settingsUiFixture('settings-sites',{service:'microsoft'}),port=await f.port('adaptation:');
        const save=port.attrs['save-settings'] as (value:unknown)=>Promise<void>;const value={...f.state.config.siteAdaptation,enabled:false};f.patch.mockClear();
        await save(value);expect(f.patch).toHaveBeenCalledOnce();expect(f.patch).toHaveBeenCalledWith({siteAdaptation:value},expect.any(Function));expect(f.state.config.service).toBe('microsoft');
        const error=new Error('fixture save rejected');f.patch.mockRejectedValueOnce(error);await expect(save(value)).rejects.toBe(error);expect(f.state.config.siteAdaptation.enabled).not.toBe(false);
    });
});

describe('交互延迟控件的配置与页面归属',()=>{
    it.each([
        {section:'settings-translation',key:'mouseHoverTranslationDelay',label:'悬浮翻译延迟'},
        {section:'settings-selection',key:'selectionTranslatorDelay',label:'划词翻译显示延迟'},
    ])('$label同步后不让旧输入覆盖新配置，当前输入按步长正常提交',async row=>{
        const f=await settingsUiFixture(row.section,{[row.key]:300,selectionTranslatorMode:'bilingual'});
        await vi.waitFor(()=>expect(f.numericPorts.has(row.label)).toBe(true));const old=f.numericPorts.get(row.label)!.change;
        f.notifyConfig({...f.state.config,[row.key]:800});await settle();f.patch.mockClear();
        old(500);await settle();expect(f.state.config[row.key]).toBe(800);expect(f.patch).not.toHaveBeenCalled();
        f.numericPorts.get(row.label)!.change(500);await settle();expect(f.state.config[row.key]).toBe(500);expect(f.patch).toHaveBeenCalledOnce();
    });
    it.each(['section','keepalive','unmount'] as const)('%s失活拒绝旧延迟change，重新访问仍要求当前控件',async reason=>{
        const f=await settingsUiFixture('settings-selection',{selectionTranslatorMode:'bilingual',selectionTranslatorDelay:300});
        await vi.waitFor(()=>expect(f.numericPorts.has('划词翻译显示延迟')).toBe(true));const old=f.numericPorts.get('划词翻译显示延迟')!.change;
        if(reason==='section')f.props.activeSection='settings-general';else if(reason==='keepalive')f.visible.value=false;else{app!.unmount();app=undefined}
        await settle();f.patch.mockClear();old(500);await settle();expect(f.state.config.selectionTranslatorDelay).toBe(300);expect(f.patch).not.toHaveBeenCalled();
        if(reason==='unmount')return;
        f.props.activeSection='settings-selection';f.visible.value=true;await settle();old(500);await settle();expect(f.state.config.selectionTranslatorDelay).toBe(300);expect(f.patch).not.toHaveBeenCalled();
        f.numericPorts.get('划词翻译显示延迟')!.change(500);await settle();expect(f.state.config.selectionTranslatorDelay).toBe(500);expect(f.patch).toHaveBeenCalledOnce();
    });
});

describe('设置父模板分区字段与编辑确认',()=>{
    it('划词展示与触发偏好独立保存，模式切换同步即时页面状态',async()=>{
        const f=await settingsUiFixture('settings-selection',{selectionTranslatorMode:'bilingual',selectionTranslatorTrigger:'hover',to:'en'}),navigate=vi.fn();f.props.onNavigateSection=navigate;
        await f.emit('selection:','navigate','settings-general');expect(navigate).toHaveBeenCalledWith('settings-general',undefined);
        await f.choose('划词显示内容','仅译文');expect(f.state.config.selectionTranslatorMode).toBe('translation-only');expect(f.state.config.disableSelectionTranslator).toBe(false);
        await f.emit('el-switch:继续阅读时自动收起','update:modelValue',false);expect(f.state.config.selectionTranslatorAutoDismiss).toBe(false);
        await f.emit('el-switch:中英双向划词','update:modelValue',false);expect(f.state.config.selectionTranslatorBidirectional).toBe(false);
        // 悬停打开卡片等待与选区稳定等待归属不同字段，互不覆盖。
        const prior=f.state.config.selectionTranslatorDelay;f.numericPorts.get('悬停等待时间')!.update(900);await settle();
        expect(f.state.config.harness.hoverDelay).toBe(900);expect(f.state.config.selectionTranslatorDelay).toBe(prior);
    });
    it('视频关闭保留独立服务、原语种、人工字幕和词库偏好，恢复时继续可编辑',async()=>{
        const f=await settingsUiFixture('settings-video',{service:'google',videoTranslationEnabled:true,glossaryEnabled:true});
        await f.emit('el-select:视频字幕翻译服务','update:modelValue','microsoft');expect(f.state.config.videoService).toBe('microsoft');expect(f.state.config.service).toBe('google');
        await f.emit('el-select:视频原语言','update:modelValue','ja');expect(f.state.config.videoSourceLanguage).toBe('ja');
        await f.emit('el-switch:会议平台自动开启双语字幕','update:modelValue',true);expect(f.state.config.videoMeetingAutoEnabled).toBe(true);
        await f.emit('el-switch:优先使用人工字幕','update:modelValue',false);expect(f.state.config.videoPreferHumanSubtitles).toBe(false);
        await f.emit('glossary:','update:modelValue',[]);expect(f.state.config.videoGlossaryIds).toEqual([]);
        await f.emit('feature:视频字幕翻译','update:modelValue',false);expect(f.state.config.videoTranslationEnabled).toBe(false);expect((await f.port('el-select:视频原语言')).attrs.disabled).toBe(true);
        expect(f.state.config).toMatchObject({videoService:'microsoft',videoSourceLanguage:'ja',videoMeetingAutoEnabled:true,videoPreferHumanSubtitles:false,videoGlossaryIds:[]});
        await f.emit('feature:视频字幕翻译','update:modelValue',true);expect((await f.port('el-select:视频原语言')).attrs.disabled).toBe(false);expect(f.query).not.toHaveBeenCalled();
    });
    it('图片/圈选开关分别广播，OCR源语言回写不改变网页目标语言',async()=>{
        const f=await settingsUiFixture('settings-image-translation',{on:true,disableImageTranslator:false,selectionAreaEnabled:false,to:'en'});f.query.mockResolvedValue([{id:8}]);
        const manga=await f.port('manga:');expect(manga.attrs['image-enabled']).toBe(true);
        await f.emit('manga:','update:imageEnabled',false);expect(f.state.config.disableImageTranslator).toBe(true);expect(f.send).toHaveBeenLastCalledWith(8,{type:'toggleImageTranslator',isEnabled:false});
        await f.emit('area:','update:enabled',true);expect(f.state.config.selectionAreaEnabled).toBe(true);expect(f.send).toHaveBeenLastCalledWith(8,{type:'toggleSelectionAreaTranslator',isEnabled:true});
        await f.emit('ocr:','update:sourceLanguage','ja');expect(f.state.config.from).toBe('ja');expect(f.state.config.to).toBe('en');
    });
    it('圈选真实父模板拒绝占用已启用点选的组合，解除后才保存并广播',async()=>{
        const f=await settingsUiFixture('settings-image-translation',{on:true,selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,
            selectionClickSelectEnabled:true,selectionClickSelectHotkey:'Alt+Shift+S',selectionAreaEnabled:false,
            selectionAreaHotkey:'custom',customSelectionAreaHotkey:'Alt+Shift+S'});f.query.mockResolvedValue([{id:8}]);f.patch.mockClear();
        await f.emit('area:','update:enabled',true);expect(f.state.config.selectionAreaEnabled).toBe(false);
        expect(f.patch).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
        f.state.config.selectionClickSelectEnabled=false;await settle();f.patch.mockClear();
        await f.emit('area:','update:enabled',true);expect(f.state.config.selectionAreaEnabled).toBe(true);expect(f.patch).toHaveBeenCalledOnce();
        expect(f.send).toHaveBeenLastCalledWith(8,{type:'toggleSelectionAreaTranslator',isEnabled:true});
    });
    it('高级识别开关只保存范围、标题和侧栏策略，不立即重新翻译',async()=>{
        const f=await settingsUiFixture('settings-advanced',{translationScope:'content',pageTitleTranslationEnabled:false,sidebarTranslationEnabled:false});
        for(const [label,value,key]of [['settings.pageRecognition.allNodes','all','translationScope'],['settings.pageRecognition.pageTitle',true,'pageTitleTranslationEnabled'],['settings.pageRecognition.sidebar',true,'sidebarTranslationEnabled']] as const){
            f.patch.mockClear();await f.emit(`el-switch:${label}`,'update:modelValue',value);expect(f.state.config[key]).toBe(value);expect(f.patch).toHaveBeenCalledOnce();
        }
        expect(f.query).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
    });
    it.each([
        {label:'鼠标悬浮快捷键',section:'settings-translation',field:'hotkey'},
        {label:'全文翻译快捷键',section:'settings-translation',field:'floatingBallHotkey'},
        {label:'划词翻译触发方式',section:'settings-selection',field:'selectionTranslatorTrigger'},
    ])('$label的自定义弹窗取消仅关闭编辑，不改此前快捷键',async row=>{
        const f=await settingsUiFixture(row.section,{selectionTranslatorMode:'bilingual'}),before=f.state.config[row.field];
        await f.emit(`el-select:${row.label}`,'change','custom');await f.port('hotkey:');f.patch.mockClear();
        const dialog=await f.port('hotkey:');dialog.emit('cancel');dialog.emit('update:modelValue',false);await settle();expect(f.state.config[row.field]).toBe(before);
        if(row.field==='selectionTranslatorTrigger')expect(f.patch).not.toHaveBeenCalled();else{expect(f.patch).toHaveBeenCalledOnce();expect(f.patch.mock.calls[0][0]).toMatchObject({[row.field]:before})}
        expect(f.document.querySelector('[data-child-event-port="hotkey:"]')).toBeNull();
    });
    it('完整表单保存失败会提示且下一次编辑重试最新草稿，适配回调不吞失败',async()=>{
        const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),f=await settingsUiFixture('settings-general');f.patch.mockRejectedValueOnce(Error('fixture persistence failure'));
        await f.emit('el-select:settings.general.defaultTargetLanguage','update:modelValue','ja');expect(warn).toHaveBeenCalledWith('[FluentRead] 保存设置失败',expect.any(Error));
        await f.emit('el-select:settings.general.defaultTargetLanguage','update:modelValue','en');expect(f.patch).toHaveBeenLastCalledWith(expect.objectContaining({to:'en'}),expect.any(Function));
    });
    it.each([
        {section:'settings-translation',key:'mouseHoverTranslationDelay',label:'悬浮翻译延迟',stepInput:317,rounded:320,default:50},
        {section:'settings-selection',key:'selectionTranslatorDelay',label:'划词翻译显示延迟',stepInput:317,rounded:300,default:300},
    ])('$label确认时按步长、范围和空值规则保存',async row=>{
        const f=await settingsUiFixture(row.section,{selectionTranslatorMode:'bilingual'});await vi.waitFor(()=>expect(f.numericPorts.has(row.label)).toBe(true));
        for(const [value,expected]of [[row.stepInput,row.rounded],[-500,0],[3000,2000],[undefined,row.default]] as const){
            f.numericPorts.get(row.label)!.change(value);await settle();expect(f.state.config[row.key]).toBe(expected);
        }
    });
});
