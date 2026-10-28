/**
 * @file tests/selectionTranslatorLifecycle.test.ts
 * 文件职责：执行划词组件的实际挂载与卸载回调，验证两点选取入口可用性、开放 Shadow DOM 编辑边界及完成首帧与延迟滚动的竞态、扩展消息端口撤销、Safari 自有追问焦点的有限键盘/旋转平移窗口与主动滚动收卡边界。
 * 主要内容：覆盖注销清理、原生右键菜单选区恢复与重复翻译复用、免费讲解明确启用及保存确认、用户 AI 偏好保护、关闭/换区/卸载后的迟到保存隔离、朗读生成与降级、取消、迟到响应、进度隔离和富文本 trim 后的 UTF-16 跟读偏移、顶栏菜单外点/焦点关闭边界、导航空白拖动、按配置与显式反向请求确定翻译语言和窗口尺寸变化清理、鉴权配置动作归属；可选真实 SFC 模板模式验证两处错误入口与极矮视口下同一卡片的滚动退化及关闭，并组合实际 selection runtime 验证 Safari 已消费选区的 host 恢复、正文失效及离开清理。
 * 模块边界：默认从正常 Vite 管线导入真实 SFC setup 并使用原有空渲染；材料捕获使用真实代次冻结与完成逻辑，只替换来源提取和后台客户端；入口可选原始客户端模板和独立 Linkedom 节点树；不再运行匿名编译的组件副本；组合模式将真实组件交给原始 runtime 的平台挂载端口，浏览器、子组件与语言是受控 ports，不声称 CSS、原生焦点或真实浏览器验证。
 */
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {parseHTML} from 'linkedom';
import ts from 'typescript';
import * as Vue from 'vue';
import SelectionTranslator from '@/src/features/selection-translation/ui/SelectionTranslator.vue';
import {Config} from '@/src/core/config/model';
import * as selectionCore from '@/src/features/selection-translation/core';
import * as translationErrors from '@/src/services/translation/errors';
import * as harness from '@/src/core/config/harness';
import * as clickSelectionConfig from '@/src/core/config/clickSelection';
import * as clickSelectionRuntime from '@/src/features/selection-translation/content/clickSelection';
import {services} from '@/src/core/config/catalog';
import * as vocabularyProtocol from '@/src/features/vocabulary/protocol';
import * as visualViewport from '@/src/platform/dom/visualViewport';
import * as modalDialogHost from '@/src/features/selection-translation/content/modalDialogHost';
import {beginMaterialCapture as beginCapture, completeMaterialCapture as completeCapture, type MaterialSelection} from '@/src/features/vocabulary/materialCapture';
import {observeNativePdfSelectionCard} from '@/src/app/selection/cardVisibility';

const selectionPorts = vi.hoisted(() => ({modules: {} as Record<string, any>, readingControls:false, evidence:undefined as any, shareMounted:false, share:vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {
    get runtime() {return selectionPorts.modules['webextension-polyfill']?.runtime;},
    get extension() {return selectionPorts.modules['webextension-polyfill']?.extension;},
}}));
vi.mock('vue', async original => {const vue = await original<typeof import('vue')>(); return {...vue, useTemplateRef: () => vue.ref(null)};});
vi.mock('@/src/services/config/store', () => ({
    get config() {return selectionPorts.modules['@/src/services/config/store'].config;},
    get configReady() {return selectionPorts.modules['@/src/services/config/store'].configReady;},
    requestConfigPatch: (...args: unknown[]) => selectionPorts.modules['@/src/services/config/store'].requestConfigPatch(...args),
    subscribeConfig: (...args: unknown[]) => selectionPorts.modules['@/src/services/config/store'].subscribeConfig(...args),
}));
vi.mock('@/src/services/translation/client', () => ({
    translateText: (...args: unknown[]) => selectionPorts.modules['@/src/services/translation/client'].translateText(...args),
    translateTextBatch: (...args: unknown[]) => selectionPorts.modules['@/src/services/translation/client'].translateTextBatch(...args),
}));
vi.mock('@/src/features/reading-assistant/public', () => ({createReadingEvidenceAnchor: (_range:unknown,_selection:unknown,options:any) => {const anchor={locate:vi.fn(()=>'located'),check:vi.fn(()=>'available'),suspend:vi.fn(),clear:vi.fn(),dispose:vi.fn(),invalidate:options.onInvalidate};selectionPorts.evidence=anchor;return anchor}, captureReadingSelection: () => undefined}));
vi.mock('@/src/features/reading-assistant/ui/panel/public', () => ({ReadingPanel: {
    props:['initialAction','historyOnly','sourceTranslation','clearEvidence','checkEvidence','locateEvidence','sourceRevision'],emits:['view-change','play-source','source-change'],
    setup:(props:any,{emit}:any)=>()=>selectionPorts.readingControls?Vue.h('div',{'data-reading-port':'','data-history':String(props.historyOnly),'data-revision':props.sourceRevision},[
        Vue.h('button',{'data-reading-check':'',onClick:()=>props.checkEvidence()},'Check source'),
        Vue.h('button',{'data-reading-locate':'',onClick:()=>props.locateEvidence('source quote')},'Locate source'),
        Vue.h('button',{'data-reading-clear':'',onClick:()=>props.clearEvidence()},'Clear source'),
        Vue.h('button',{'data-reading-view':'',onClick:()=>emit('view-change',{action:'grammar',history:false})},'Grammar view'),
        Vue.h('button',{'data-reading-play':'',onClick:()=>emit('play-source',props.sourceTranslation.source)},'Play source'),
        Vue.h('button',{'data-reading-change':'',onClick:()=>emit('source-change')},'Source changed'),
    ]):null,
}}));
vi.mock('@/src/features/selection-translation/ui/SpeechFollowText.vue', () => ({default: {props: ['text'], setup: (props: {text: string}) => () => Vue.h('span', props.text)}}));
vi.mock('@/src/features/vocabulary/material/public', () => ({
    captureMaterialSelection: (...args: unknown[]) => selectionPorts.modules['@/src/features/vocabulary/material/public'].captureMaterialSelection(...args),
    beginMaterialCapture: (...args: unknown[]) => selectionPorts.modules['@/src/features/vocabulary/material/public'].beginMaterialCapture(...args),
    completeMaterialCapture: (...args: unknown[]) => selectionPorts.modules['@/src/features/vocabulary/material/public'].completeMaterialCapture(...args),
}));
vi.mock('@/src/features/share-card/public', () => ({isShareCardMounted: () => selectionPorts.shareMounted, openShareCard:selectionPorts.share}));
vi.mock('@/src/features/selection-translation/content/selectionTtsContentController', () => ({createSelectionTtsContentController: (...args: unknown[]) => selectionPorts.modules['@/src/features/selection-translation/content/selectionTtsContentController'].createSelectionTtsContentController(...args)}));
vi.mock('@/src/features/selection-translation/content/contextMenuBridge', () => ({setSelectionContextMenuHandler: (...args: unknown[]) => selectionPorts.modules['@/src/features/selection-translation/content/contextMenuBridge'].setSelectionContextMenuHandler(...args)}));
vi.mock('@/src/features/selection-translation/pageZoom', async original => ({...await original<typeof import('@/src/features/selection-translation/pageZoom')>(), normalizeSelectionPageZoom: () => 1}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
const materialPorts = vi.hoisted(() => ({generation: vi.fn(), capture: vi.fn()}));
vi.mock('@/src/features/vocabulary/materialClient', () => ({materialGeneration: materialPorts.generation, materialCapture: materialPorts.capture}));
const {createSelectionTtsContentController} = await vi.importActual<typeof import('@/src/features/selection-translation/content/selectionTtsContentController')>('@/src/features/selection-translation/content/selectionTtsContentController');
const {setSelectionContextMenuHandler, translateSelectionFromContextMenu: translateSelectionThroughBridge} = await vi.importActual<typeof import('@/src/features/selection-translation/content/contextMenuBridge')>('@/src/features/selection-translation/content/contextMenuBridge');
type SelectionBuildTarget = 'chrome' | 'userscript' | 'safari' | 'firefox';
// 官方 SFC render 使用独立 DOM 节点树；不替换现有浏览器事件 port，
// 不验证 CSS 布局、原生焦点、禁用控件的浏览器事件策略或真实语言切换。
function createSelectionTemplatePort() {
    const parsed = parseHTML('<html><body></body></html>');
    const document = parsed.document;
    const listeners = new WeakMap<Element, Map<string, EventListener>>();
    let clickResult: unknown;
    const renderer = Vue.createRenderer<Node, Element>({
        createElement: (tag, namespace) => namespace === 'svg'
            ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag),
        createText: text => document.createTextNode(text),
        createComment: text => document.createComment(text),
        insert: (node, parent, anchor) => {parent.insertBefore(node, anchor ?? null);},
        remove: node => {node.parentNode?.removeChild(node);},
        setText: (node, text) => {node.nodeValue = text;},
        setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode as Element | null,
        nextSibling: node => node.nextSibling,
        patchProp(element, key, previous, value) {
            if (/^on[A-Z]/.test(key)) {
                const event = key.slice(2).toLowerCase();
                const registered = listeners.get(element) ?? new Map<string, EventListener>();
                listeners.set(element, registered);
                const old = registered.get(key);
                if (old) element.removeEventListener(event, old);
                registered.delete(key);
                if (value) {
                    const listener: EventListener = event => {
                        for (const handler of Array.isArray(value) ? value : [value]) {
                            const result = handler(event);
                            if (event.type === 'click') clickResult = result;
                        }
                    };
                    registered.set(key, listener);
                    element.addEventListener(event, listener);
                }
            } else if (key === 'style') {
                const style = (element as HTMLElement).style;
                if (typeof value === 'string') style.cssText = value;
                else {
                    for (const name of Object.keys(previous && typeof previous === 'object' ? previous : {})) {
                        if (!(name in (value ?? {}))) style.removeProperty(name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
                    }
                    for (const [name, raw] of Object.entries(value ?? {})) {
                        style.setProperty(name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), String(raw ?? ''));
                    }
                }
            } else if (value == null || (key === 'disabled' && value === false)) element.removeAttribute(key);
            else element.setAttribute(key, value === true ? '' : String(value));
        },
    });
    return {renderer, root: document.body, document, domWindow: parsed.window,
        click(element: Element) {
            clickResult = undefined;
            element.dispatchEvent(new parsed.window.Event('click', {bubbles: true}));
            return Promise.resolve(clickResult);
        }};
}

let app: Vue.App | undefined;
afterEach(() => { app?.unmount(); app = undefined; selectionPorts.readingControls=false;selectionPorts.shareMounted=false;selectionPorts.share.mockClear();vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function mountSelection(privateContext = false, selectionAdapter?: Record<string, unknown>,
    targetOrProps: SelectionBuildTarget | Record<string, unknown> = 'chrome', readyOrTemplate: Promise<void> | boolean = Promise.resolve(),
    runtimeIntegration = false) {
    // 保留两侧原调用：主线 target/configReady 与本地 componentProps/可选完整模板。
    const browserTarget = typeof targetOrProps === 'string' ? targetOrProps : 'chrome';
    vi.stubEnv('BROWSER', browserTarget);
    const componentProps = typeof targetOrProps === 'string' ? {} : targetOrProps;
    const configReady = typeof readyOrTemplate === 'boolean' ? Promise.resolve() : readyOrTemplate;
    const renderTemplate = typeof readyOrTemplate === 'boolean' ? readyOrTemplate : false;
    const renderPort = renderTemplate ? createSelectionTemplatePort() : null;
    vi.useFakeTimers();
    const config = Object.assign(new Config(), {
        disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual', theme: 'light',
    });
    const listeners = new Map<string, Set<(...args: any[]) => any>>();
    const eventTarget = (prefix: string) => ({
        addEventListener: vi.fn((type: string, listener: (...args: any[]) => any) => {
            const key = `${prefix}:${type}`;
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key)!.add(listener);
        }),
        removeEventListener: vi.fn((type: string, listener: (...args: any[]) => any) => {
            listeners.get(`${prefix}:${type}`)?.delete(listener);
        }),
    });
    const media = eventTarget('media');
    const documentPort = {...eventTarget('document'), getElementById: vi.fn(() => null), dispatchEvent: vi.fn()};
    // 选区来源与挂载组件共享真实节点树；事件可信度和几何仍为受控端口。
    const sourcePort = renderPort ? {document: renderPort.document, window: renderPort.domWindow} : parseHTML('<html><body></body></html>');
    const document = runtimeIntegration
        ? Object.assign(sourcePort.document, eventTarget('document')) as unknown as typeof documentPort
        : Object.assign(sourcePort.document, documentPort);
    const window = {
        ...eventTarget('window'), innerWidth: 1000, innerHeight: 800, document,
        matchMedia: () => ({matches: false, ...media}),
        setTimeout, clearTimeout,
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
        cancelAnimationFrame: vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id)),
        speechSynthesis: {cancel: vi.fn()},
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('Node', sourcePort.window.Node);
    vi.stubGlobal('Element', sourcePort.window.Element);
    const event = {addListener: vi.fn(), removeListener: vi.fn()};
    const browser = {
        runtime: {onMessage: event, getURL: (path: string) => path,
            sendMessage: vi.fn().mockResolvedValue({success: true, zoom: 1})},
        extension: {inIncognitoContext: privateContext},
    };
    const unsubscribeConfig = vi.fn(), releaseContextMenu = vi.fn();
    let configListener: (() => void) | undefined;
    const notifyConfig = () => configListener?.();
    const requestConfigPatch = vi.fn().mockImplementation(async patch => { Object.assign(config, patch); notifyConfig(); });
    let contextMenuHandler = (_selectionText?: string): boolean => false;
    const registerContextMenu = vi.fn((handler: typeof contextMenuHandler) => {
        contextMenuHandler = handler;
        return releaseContextMenu;
    });
    const translateText = vi.fn().mockResolvedValue('这是译文'), translateTextBatch = vi.fn();
    // 来源提取用受控 Range 端口；冻结代次及完成关联运行真实公共逻辑。
    materialPorts.generation.mockReset().mockResolvedValue(17);
    materialPorts.capture.mockReset().mockResolvedValue({id: 'material-fixture'});
    const captureMaterialSelection = vi.fn((_range: Range, quote: string): MaterialSelection => ({
        source: {kind: 'article', url: 'https://example.test/article', title: 'Selected article'}, locator: {kind: 'text', quote},
    }));
    const beginMaterialCapture = vi.fn(beginCapture), completeMaterialCapture = vi.fn(completeCapture);
    const material = {captureMaterialSelection, beginMaterialCapture, completeMaterialCapture};
    let stopTts: MockInstance<(notifyRemote?: boolean) => void>;
    let ttsRequestId = 0;
    const modules: Record<string, unknown> = {
        'webextension-polyfill': browser,
        '@/src/services/config/store': {config, configReady, requestConfigPatch, subscribeConfig: (listener: () => void) => { configListener = listener; return unsubscribeConfig; }},
        '@/src/services/translation/client': {translateText, translateTextBatch},
        '@/src/features/vocabulary/material/public': material,
        '@/src/features/selection-translation/content/selectionTtsContentController': {
            createSelectionTtsContentController: (dependencies: Parameters<typeof createSelectionTtsContentController>[0]) => {
                const controller = createSelectionTtsContentController({
                    ...dependencies,
                    createClientRequestId: () => `tts-client-${++ttsRequestId}`,
                });
                stopTts = vi.spyOn(controller, 'stop');
                return controller;
            },
        },
        '@/src/features/selection-translation/content/contextMenuBridge': {
            setSelectionContextMenuHandler: registerContextMenu,
        },
    };
    selectionPorts.modules = modules;
    const component = renderPort ? SelectionTranslator : {...SelectionTranslator, render: () => null};
    const renderer = renderPort?.renderer ?? Vue.createRenderer<Record<string, unknown>, Record<string, unknown>>({
        patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
        createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {},
        parentNode: () => null, nextSibling: () => null,
    });
    let currentApp: Vue.App | undefined;
    let state: Record<string, any>;
    const lifecycleErrors = vi.fn();
    const mountActual = (props: Record<string, unknown> = {}, root = renderPort?.root ?? {}) => {
        if (currentApp) throw new Error('The same component must not be mounted twice');
        currentApp = renderer.createApp(component, {selectionAdapter, ...componentProps, ...props});
        currentApp.config.errorHandler = lifecycleErrors;
        app = currentApp;
        if (renderPort) currentApp.directive('ui-i18n', {});
        const vm = currentApp.mount(root);
        state = (vm.$ as any).setupState as Record<string, any>;
        return vm;
    };
    if (!runtimeIntegration) mountActual();
    const selectedSnapshot = (text: string, setupSource?: (parent: HTMLElement, source: Text) => void) => {
        const parent = sourcePort.document.createElement('p');
        parent.textContent = text;
        sourcePort.document.body.appendChild(parent);
        const source = parent.firstChild! as Text;
        setupSource?.(parent as unknown as HTMLElement, source);
        const rect = {left: 20, right: 310, top: 150, bottom: 174, width: 290, height: 24};
        const range = Vue.markRaw({startContainer: source, endContainer: source, commonAncestorContainer: source,
            startOffset: 0, endOffset: text.length, collapsed: false, getClientRects: () => [rect],
            getBoundingClientRect: () => rect, cloneRange: () => range, toString: () => source.textContent || ''});
        const selection = {rangeCount: 1, isCollapsed: false, anchorNode: source, anchorOffset: 0,
            getRangeAt: () => range, toString: () => text, containsNode: () => false};
        Object.assign(window, {getSelection: () => selection});
        const result = state.readSelectionSnapshot();
        if (!result) throw new Error('Test source must create a real selection snapshot');
        return result;
    };
    return {get state() {return state;}, event, browser, config, listeners, window, document, material, unsubscribeConfig, requestConfigPatch, notifyConfig, releaseContextMenu, translateText, translateTextBatch, stopTts: stopTts!, selectedSnapshot,
        component, mountActual,
        registerContextMenu, get contextMenuHandler() {return contextMenuHandler;},
        captureMaterialSelection, beginMaterialCapture, completeMaterialCapture, materialGeneration: materialPorts.generation, materialCapture: materialPorts.capture,
        lifecycleErrors, renderPort, unmount: () => { currentApp?.unmount(); app = undefined; }};
}

describe('two-click selection entry availability', () => {
    it.each(['disabled', 'document adapter'] as const)('skips shortcut conflict work for %s across unrelated config notifications', async reason => {
        const conflict = vi.spyOn(clickSelectionConfig, 'findClickSelectionHotkeyConflict');
        const fixture = mountSelection(false, reason === 'document adapter' ? {acceptsRange: () => true} : undefined);
        fixture.config.selectionClickSelectEnabled = reason === 'document adapter';
        fixture.notifyConfig(); await Vue.nextTick();
        fixture.config.theme = 'dark'; fixture.notifyConfig(); await Vue.nextTick();
        fixture.config.selectionClickSelectHotkey = 'Alt+J'; fixture.notifyConfig(); await Vue.nextTick();
        expect(conflict).not.toHaveBeenCalled();
        expect(fixture.state.clickSelectionState).toBe('idle');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('cancels a running session when its shortcut becomes occupied or its feature is disabled', async () => {
        const fixture = mountSelection();
        fixture.config.selectionClickSelectEnabled = true; fixture.notifyConfig(); await Vue.nextTick();
        fixture.state.clickSelection.toggle(); expect(fixture.state.clickSelectionState).toBe('start');
        fixture.config.floatingBallHotkey = 'custom';
        fixture.config.customFloatingBallHotkey = fixture.config.selectionClickSelectHotkey;
        fixture.notifyConfig(); await Vue.nextTick();
        expect(fixture.state.clickSelectionState).toBe('idle');
        fixture.config.customFloatingBallHotkey = 'Alt+J'; fixture.notifyConfig(); await Vue.nextTick();
        fixture.state.clickSelection.toggle(); expect(fixture.state.clickSelectionState).toBe('start');
        fixture.config.selectionClickSelectEnabled = false; fixture.notifyConfig(); await Vue.nextTick();
        expect(fixture.state.clickSelectionState).toBe('idle');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['input', 'textarea', 'select', 'contenteditable'] as const)('preserves the startup shortcut inside an open-shadow %s', async kind => {
        const fixture = mountSelection(false, undefined, 'chrome', true), port = fixture.renderPort!;
        vi.stubGlobal('Node', port.domWindow.Node); vi.stubGlobal('Element', port.domWindow.Element);
        const host = port.document.createElement('custom-editor'), shadow = host.attachShadow({mode: 'open'});
        const editor = port.document.createElement(kind === 'contenteditable' ? 'div' : kind);
        if (kind === 'contenteditable') editor.setAttribute('contenteditable', 'true');
        const origin = kind === 'contenteditable' ? editor.appendChild(port.document.createElement('span')) : editor;
        shadow.appendChild(editor); port.root.appendChild(host);
        fixture.config.selectionClickSelectEnabled = true; fixture.notifyConfig(); await Vue.nextTick();
        const event = {isTrusted: true, target: host, key: 's', code: 'KeyS', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
            composedPath: () => [origin, editor, shadow, host], preventDefault: vi.fn(), stopPropagation: vi.fn()};
        for (const handler of fixture.listeners.get('document:keydown')!) handler(event);
        await Vue.nextTick();
        expect(fixture.state.clickSelectionState).toBe('idle');
        expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('still starts from non-editable shadow text and a document event without a composed path', async () => {
        const fixture = mountSelection(false, undefined, 'chrome', true), port = fixture.renderPort!;
        vi.stubGlobal('Node', port.domWindow.Node); vi.stubGlobal('Element', port.domWindow.Element);
        const host = port.document.createElement('reading-text'), shadow = host.attachShadow({mode: 'open'});
        const text = shadow.appendChild(port.document.createElement('p'));
        fixture.config.selectionClickSelectEnabled = true; fixture.notifyConfig(); await Vue.nextTick();
        const key = (path: boolean) => ({isTrusted: true, target: host, key: 's', code: 'KeyS', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
            ...(path ? {composedPath: () => [text, shadow, host]} : {}), preventDefault: vi.fn(), stopPropagation: vi.fn()});
        for (const path of [true, false]) {
            const event = key(path);
            for (const handler of fixture.listeners.get('document:keydown')!) handler(event);
            await Vue.nextTick();
            expect(fixture.state.clickSelectionState).toBe(path ? 'start' : 'idle');
            expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
        }
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('completed two-click selection first-frame scroll ordering', () => {
    async function prepare() {
        const factory = clickSelectionRuntime.createClickSelectionController;
        let complete!: () => void;
        vi.spyOn(clickSelectionRuntime, 'createClickSelectionController').mockImplementation(options => {
            complete = options.onComplete;
            return factory(options);
        });
        const fixture = mountSelection(false, undefined, 'chrome', true, true), port = fixture.renderPort!;
        vi.stubGlobal('Node', port.domWindow.Node); vi.stubGlobal('Element', port.domWindow.Element);
        vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
        fixture.mountActual();
        const paragraph = port.document.createElement('p');
        paragraph.textContent = 'Good ideas deserve careful attention.'; port.root.appendChild(paragraph);
        const source = paragraph.firstChild!, text = paragraph.textContent;
        const rect = {left: 20, right: 310, top: 150, bottom: 174, width: 290, height: 24};
        const range = Vue.markRaw({startContainer: source, endContainer: source, commonAncestorContainer: source,
            startOffset: 0, endOffset: text.length, collapsed: false, getClientRects: () => [rect],
            getBoundingClientRect: () => rect, cloneRange: () => range, toString: () => source.textContent || ''});
        const selection = {rangeCount: 1, isCollapsed: false, anchorNode: source, anchorOffset: 0,
            getRangeAt: () => range, toString: () => text, containsNode: () => false};
        Object.assign(fixture.window, {getSelection: () => selection});
        Object.assign(fixture.config, {selectionClickSelectEnabled: true, selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0});
        fixture.notifyConfig(); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick();
        const send = (prefix: string, type: string, properties: Record<string, unknown> = {}) => {
            const event = {isTrusted: true, target: fixture.document, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...properties};
            for (const handler of fixture.listeners.get(`${prefix}:${type}`) ?? []) handler(event);
            return event;
        };
        return {...fixture, complete, send, text, paragraph};
    }

    it('retains the completed selection read when a queued page scroll arrives before its first frame', async () => {
        const fixture = await prepare();
        fixture.complete();
        expect(fixture.state.readSelectionSnapshot()?.text).toBe(fixture.text);
        expect(fixture.state.snapshot).toBeNull(); expect(fixture.state.selectionFrame).not.toBeNull();
        const scheduled = fixture.state.selectionFrame;
        fixture.send('window', 'scroll');
        expect(fixture.window.cancelAnimationFrame).not.toHaveBeenCalledWith(scheduled);
        await vi.advanceTimersByTimeAsync(50); await Vue.nextTick();
        expect(fixture.state.snapshot?.text).toBe(fixture.text);
        expect(fixture.state.showIndicator).toBe(true);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('restores ordinary scroll dismissal immediately after the first completed-selection read', async () => {
        const fixture = await prepare(); fixture.complete();
        await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
        expect(fixture.state.snapshot?.text).toBe(fixture.text);
        fixture.send('window', 'scroll');
        await vi.advanceTimersByTimeAsync(50); await Vue.nextTick();
        expect(fixture.state.snapshot).toBeNull(); expect(fixture.state.showIndicator).toBe(false);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['text changed', 'source removed'])('discards an asynchronous answer if the original selection %s without an event', async change => {
        const fixture = await prepare();
        let resolve!: (value: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise<string>(done => {resolve = done;}));
        fixture.complete();
        await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
        fixture.state.openTooltip();
        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.showTooltip).toBe(true);
        if (change === 'text changed') fixture.paragraph.firstChild!.nodeValue = 'This source has changed.';
        else fixture.paragraph.remove();
        resolve('A late translation.');
        await Promise.resolve(); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('keeps the explicitly opened card when native selection is cleared but the source remains valid', async () => {
        const fixture = await prepare();
        let resolve!: (value: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise<string>(done => {resolve = done;}));
        fixture.complete();
        await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
        fixture.state.openTooltip();
        Object.assign(fixture.window, {getSelection: () => null});
        resolve('Still current.');
        await Promise.resolve(); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('Still current.');
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each([false, true])('checks a long cross-node selection on delivery when a source node changes=%s', async changed => {
        const fixture = await prepare();
        const first = fixture.paragraph.firstChild!;
        first.nodeValue = 'First passage. '.repeat(130);
        const last = fixture.renderPort!.document.createTextNode('Second passage. '.repeat(125));
        fixture.paragraph.appendChild(last);
        const text = first.textContent! + last.textContent!;
        expect(text.length).toBeGreaterThan(3500);
        expect(text.length).toBeLessThanOrEqual(4096);
        const rect = {left: 20, right: 310, top: 150, bottom: 174, width: 290, height: 24};
        const range = Vue.markRaw({startContainer: first, endContainer: last, commonAncestorContainer: fixture.paragraph,
            startOffset: 0, endOffset: last.textContent!.length, collapsed: false,
            getClientRects: () => [rect], getBoundingClientRect: () => rect, cloneRange: () => range,
            toString: () => (first.textContent || '') + (last.textContent || '')});
        Object.assign(fixture.window, {getSelection: () => ({rangeCount: 1, isCollapsed: false,
            anchorNode: first, anchorOffset: 0, getRangeAt: () => range, toString: () => text, containsNode: () => false})});
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        expect(fixture.state.snapshot?.text).toBe(text.trim());
        fixture.state.selectedText = fixture.state.snapshot.text;
        fixture.state.showTooltip = true;
        let resolve!: (value: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise<string>(done => {resolve = done;}));
        fixture.state.requestSelectionContent(fixture.state.selectedText);
        if (changed) last.nodeValue = 'Changed last node.';
        resolve('Long answer.');
        await Promise.resolve(); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe(changed ? '' : 'Long answer.');
        expect(fixture.state.showTooltip).toBe(!changed);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['Escape', 'editing input', 'shadow editing input', 'new pointer', 'explicit hide', 'suppression', 'unmount'] as const)(
        'does not reveal a cancelled first read after %s', async reason => {
            const fixture = await prepare(); fixture.complete();
            expect(fixture.state.selectionFrame).not.toBeNull();
            if (reason === 'Escape') fixture.send('document', 'keydown', {target: fixture.paragraph, key: 'Escape'});
            if (reason === 'editing input' || reason === 'shadow editing input') {
                const input = fixture.renderPort!.document.createElement('input');
                let target: Element = input, path: EventTarget[] = [input];
                if (reason === 'shadow editing input') {
                    const host = fixture.renderPort!.document.createElement('editable-host'), shadow = host.attachShadow({mode: 'open'});
                    shadow.appendChild(input); target = host; path = [input, shadow, host];
                }
                fixture.send('document', 'keydown', {target, key: 'a', composedPath: () => path});
            }
            if (reason === 'new pointer') {
                fixture.send('document', 'pointerdown', {target: fixture.paragraph, pointerType: 'mouse', button: 0});
                expect(fixture.state.selectionFrame).toBeNull();
                fixture.send('document', 'pointercancel', {target: fixture.paragraph, pointerType: 'mouse'});
            }
            if (reason === 'explicit hide') fixture.state.hideAll();
            if (reason === 'suppression') fixture.state.suppressSelectionRead();
            if (reason === 'unmount') fixture.unmount();
            await vi.advanceTimersByTimeAsync(500); await Vue.nextTick();
            expect(fixture.state.snapshot).toBeNull(); expect(fixture.state.showIndicator).toBe(false);
            if (reason === 'unmount') expect([...fixture.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
            else {
                // 后续普通选区的首帧继续遵循原有滚动收起规则，取消不能遗留豁免状态。
                fixture.state.scheduleSelectionRead(); const nextFrame = fixture.state.selectionFrame;
                expect(nextFrame).not.toBeNull(); fixture.send('window', 'scroll');
                expect(fixture.window.cancelAnimationFrame).toHaveBeenCalledWith(nextFrame);
                await vi.advanceTimersByTimeAsync(50); await Vue.nextTick();
                expect(fixture.state.showIndicator).toBe(false);
            }
            expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        },
    );

    it('keeps ordinary pending selection reads subject to immediate scroll dismissal', async () => {
        const fixture = await prepare(); fixture.state.scheduleSelectionRead();
        const scheduled = fixture.state.selectionFrame; expect(scheduled).not.toBeNull();
        fixture.send('window', 'scroll');
        expect(fixture.window.cancelAnimationFrame).toHaveBeenCalledWith(scheduled);
        await vi.advanceTimersByTimeAsync(50); await Vue.nextTick();
        expect(fixture.state.snapshot).toBeNull(); expect(fixture.state.showIndicator).toBe(false);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('native PDF result window follows shared card dismissal', () => {
    it.each(['Control', 'contextMenu'])('closes the result owner when the real shared card hides after switching to %s', async trigger => {
        const focusedDismiss = vi.fn();
        const fixture = mountSelection(false, {acceptsRange: () => true}, {onFocusedCardDismiss: focusedDismiss}, true);
        const port = fixture.renderPort!;
        vi.stubGlobal('MutationObserver', port.domWindow.MutationObserver);
        const root = port.root.querySelector<HTMLElement>('.fr-selection-translator-root')!;
        let stop = () => {};
        const dismiss = vi.fn(() => {stop(); fixture.unmount();});
        stop = observeNativePdfSelectionCard(root, dismiss);
        const text = 'Selected native PDF passage.';
        fixture.state.snapshot = {text, parts: [{kind: 'text', text}], range: {}};
        fixture.state.selectedText = text;
        fixture.state.manuallyRequestedSelection = true;
        fixture.state.translationResult = 'A completed translation';
        fixture.state.showTooltip = true;
        await Vue.nextTick(); await Promise.resolve();
        expect(root.querySelector('.fr-translation-tooltip')).not.toBeNull();
        expect(dismiss).not.toHaveBeenCalled();
        fixture.config.selectionTranslatorTrigger = trigger;
        fixture.notifyConfig();
        await Vue.nextTick(); await Promise.resolve();
        expect(dismiss).toHaveBeenCalledOnce();
        expect(focusedDismiss).not.toHaveBeenCalled();
        expect(port.root.querySelector('.fr-translation-tooltip')).toBeNull();
        expect(fixture.unsubscribeConfig).toHaveBeenCalledOnce();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('explicit free selection explanation', () => {
    function prepare(configReady?: Promise<void>, browserTarget: SelectionBuildTarget = 'chrome') {
        const text = 'Practice makes progress.';
        const captureReading = vi.fn(() => ({text, context: text, sentence: text}));
        const fixture = mountSelection(false, {acceptsRange: () => true, captureReading}, browserTarget, configReady);
        const select = () => {
            fixture.state.snapshot = fixture.selectedSnapshot(text);
            fixture.state.selectedText = text;
            fixture.state.showTooltip = true;
            fixture.state.translationResult = '练习带来进步。';
            fixture.state.activeContentRequest = {text, generation: 1, sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};
        };
        select();
        return {...fixture, text, captureReading, select};
    }

    it.each([
        ['chrome', services.microsoft], ['chrome', services.bilibili],
        ['userscript', services.microsoft], ['userscript', services.bilibili],
    ] as const)('offers free enablement only with an extension stream port (%s, %s)', async (target, service) => {
        const fixture = prepare(undefined, target);
        fixture.config.service = service;
        fixture.notifyConfig();
        expect(fixture.state.canEnableFreeReading).toBe(target === 'chrome');
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).toHaveBeenCalledTimes(target === 'chrome' ? 1 : 0);
        expect(fixture.captureReading).toHaveBeenCalledTimes(target === 'chrome' ? 1 : 0);
        expect(fixture.config.harness.enabled).toBe(target === 'chrome');
        expect(fixture.state.readingMode).toBe(target === 'chrome');
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.config.service).toBe(service);
    });

    it.each([services.deepseek, services.bilibili])('keeps existing enabled userscript reading preferences and UI (%s)', async service => {
        const fixture = prepare(undefined, 'userscript');
        fixture.config.harness = {...fixture.config.harness, enabled: true, service, defaultAction: 'grammar'};
        const stored = JSON.stringify(fixture.config.harness);
        fixture.notifyConfig();
        expect(fixture.state.canEnableFreeReading).toBe(false);
        expect(fixture.state.readingEnabled).toBe(true);
        expect(fixture.state.readingActions.map((action: any) => action.id)).toEqual(service === services.bilibili
            ? ['meaning', 'usage'] : ['meaning', 'grammar', 'usage', 'practice']);
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        expect(JSON.stringify(fixture.config.harness)).toBe(stored);
        // 外部配置更新仍关闭旧选区；下一次选区继续使用已有阅读界面与偏好。
        fixture.select();
        fixture.state.openReading();
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.captureReading).toHaveBeenCalledOnce();
        expect(fixture.state.readingInitialAction).toBe(service === services.bilibili ? 'meaning' : 'grammar');
    });

    it('leaves explanation disabled until clicked, preserves selection on its own config echo, and opens meaning after confirmed save', async () => {
        const fixture = prepare();
        let confirm!: () => void;
        fixture.requestConfigPatch.mockImplementation(patch => {
            Object.assign(fixture.config, patch);
            fixture.notifyConfig();
            return new Promise<void>(resolve => { confirm = resolve; });
        });
        const selection = fixture.state.snapshot;
        expect(fixture.state.canEnableFreeReading).toBe(true);
        expect(fixture.config.harness.enabled).toBe(false);
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        expect(fixture.state.snapshot).toBe(selection);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.freeReadingPending).toBe(true);
        expect(fixture.state.readingEnabled).toBe(false);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).toHaveBeenCalledTimes(1);
        expect(fixture.requestConfigPatch.mock.calls[0][0].harness).toMatchObject({enabled: true, service: services.bilibili, model: ''});
        confirm();
        await pending;
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.state.readingInitialAction).toBe('meaning');
        expect(fixture.captureReading).toHaveBeenCalledTimes(1);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['service', 'model', 'inherited', 'enabled', 'disabled-selection'] as const)('protects existing choice: %s', async kind => {
        const fixture = prepare();
        if (kind === 'service') fixture.config.harness.service = services.deepseek;
        if (kind === 'model') fixture.config.harness.model = 'chosen-model';
        if (kind === 'inherited') fixture.config.service = services.deepseek;
        if (kind === 'enabled') fixture.config.harness.enabled = true;
        if (kind === 'disabled-selection') fixture.config.selectionTranslatorMode = 'disabled';
        fixture.notifyConfig();
        expect(fixture.state.canEnableFreeReading).toBe(false);
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        expect(fixture.captureReading).not.toHaveBeenCalled();
    });

    it('allows one-click explanation when translation already defaults to Bilibili without changing translation preferences', async () => {
        const fixture = prepare();
        fixture.config.service = services.bilibili;
        const selectionService = fixture.config.selectionTranslationService;
        const translationModel = fixture.config.model[services.bilibili];
        fixture.notifyConfig();
        await Vue.nextTick();
        expect(fixture.state.canEnableFreeReading).toBe(true);
        expect(fixture.config.harness.enabled).toBe(false);
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).toHaveBeenCalledTimes(1);
        expect(Object.keys(fixture.requestConfigPatch.mock.calls[0][0])).toEqual(['harness']);
        expect(fixture.config.harness).toMatchObject({enabled: true, service: services.bilibili, model: ''});
        expect(fixture.config.service).toBe(services.bilibili);
        expect(fixture.config.selectionTranslationService).toBe(selectionService);
        expect(fixture.config.model[services.bilibili]).toBe(translationModel);
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.state.readingInitialAction).toBe('meaning');
        expect(fixture.captureReading).toHaveBeenCalledTimes(1);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('does not open or request an explanation after a failed save', async () => {
        const fixture = prepare();
        fixture.requestConfigPatch.mockRejectedValue(new Error('storage failed'));
        await fixture.state.enableFreeReading();
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        expect(fixture.state.noticeMessage).toContain('失败');
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('opens usage from usage-only preferences and preserves the normalized user action choices', async () => {
        const fixture = prepare();
        fixture.config.harness.actions = ['usage'];
        fixture.config.harness.defaultAction = 'usage';
        const {actions, defaultAction} = harness.normalizeHarnessPreferences(fixture.config.harness);
        fixture.notifyConfig();
        await Vue.nextTick();
        fixture.state.snapshot = {text: fixture.text, range: {}, parts: [{kind: 'text', text: fixture.text}]};
        fixture.state.selectedText = fixture.text;
        fixture.state.showTooltip = true;
        fixture.state.translationResult = '练习带来进步。';
        fixture.state.activeContentRequest = {text: fixture.text, generation: 1, sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};
        await fixture.state.enableFreeReading();
        expect(fixture.requestConfigPatch).toHaveBeenCalledTimes(1);
        expect(fixture.requestConfigPatch.mock.calls[0][0].harness).toMatchObject({actions, defaultAction});
        expect(fixture.config.harness.actions).toEqual(actions);
        expect(fixture.config.harness.defaultAction).toBe(defaultAction);
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.state.readingInitialAction).toBe('usage');
        expect(fixture.captureReading).toHaveBeenCalledTimes(1);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('temporarily falls back from grammar when free explanation is enabled without changing saved actions or default', async () => {
        const fixture = prepare();
        fixture.config.harness.defaultAction = 'grammar';
        const storedActions = [...fixture.config.harness.actions];
        fixture.notifyConfig();
        await Vue.nextTick();
        fixture.state.snapshot = {text: fixture.text, range: {}, parts: [{kind: 'text', text: fixture.text}]};
        fixture.state.selectedText = fixture.text;
        fixture.state.showTooltip = true;
        fixture.state.translationResult = '练习带来进步。';
        fixture.state.activeContentRequest = {text: fixture.text, generation: 1, sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};
        await fixture.state.enableFreeReading();
        expect(fixture.config.harness.defaultAction).toBe('grammar');
        expect(fixture.config.harness.actions).toEqual(storedActions);
        expect(fixture.state.readingActions.map((action: {id: string}) => action.id)).toEqual(['meaning', 'usage']);
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.state.readingInitialAction).toBe('meaning');
        expect(fixture.captureReading).toHaveBeenCalledTimes(1);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('filters an inherited Bilibili service and restores all saved actions and default after switching to a general AI', async () => {
        const fixture = prepare();
        fixture.config.service = services.bilibili;
        fixture.config.harness.enabled = true;
        fixture.config.harness.defaultAction = 'grammar';
        const storedActions = [...fixture.config.harness.actions];
        fixture.notifyConfig();
        await Vue.nextTick();
        expect(fixture.state.readingService).toBe(services.bilibili);
        expect(fixture.state.readingActions.map((action: {id: string}) => action.id)).toEqual(['meaning', 'usage']);
        expect(fixture.state.readingDefaultAction).toBe('meaning');
        fixture.state.snapshot = {text: fixture.text, range: {}, parts: [{kind: 'text', text: fixture.text}]};
        fixture.state.selectedText = fixture.text;
        fixture.state.showTooltip = true;
        fixture.state.openReading('grammar');
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        fixture.config.service = services.deepseek;
        fixture.notifyConfig();
        await Vue.nextTick();
        expect(fixture.state.readingActions.map((action: {id: string}) => action.id)).toEqual(['meaning', 'grammar', 'usage', 'practice']);
        expect(fixture.state.readingDefaultAction).toBe('grammar');
        expect(fixture.config.harness.defaultAction).toBe('grammar');
        expect(fixture.config.harness.actions).toEqual(storedActions);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('preserves the selected card and reports failure after its optimistic config is rolled back before rejection', async () => {
        const fixture = prepare();
        const originalPreferences = fixture.config.harness;
        const selection = fixture.state.snapshot;
        let reject!: (error: Error) => void;
        fixture.requestConfigPatch.mockImplementation(patch => {
            Object.assign(fixture.config, patch);
            fixture.notifyConfig();
            return new Promise<void>((_resolve, fail) => { reject = fail; });
        });
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        expect(fixture.config.harness.enabled).toBe(true);
        expect(fixture.state.freeReadingPending).toBe(true);
        fixture.config.harness = originalPreferences;
        fixture.notifyConfig();
        await Vue.nextTick();
        expect(fixture.state.snapshot).toBe(selection);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.readingMode).toBe(false);
        reject(new Error('storage failed'));
        await pending;
        expect(fixture.config.harness.enabled).toBe(false);
        expect(fixture.state.snapshot).toBe(selection);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.state.noticeMessage).toContain('失败');
        expect(fixture.captureReading).not.toHaveBeenCalled();
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('waits for initial config hydration and keeps the restored inherited AI service', async () => {
        let hydrate!: () => void;
        const fixture = prepare(new Promise<void>(resolve => { hydrate = resolve; }));
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        fixture.config.service = services.deepseek;
        fixture.notifyConfig();
        hydrate();
        await pending;
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        expect(fixture.config.service).toBe(services.deepseek);
        expect(fixture.config.harness.enabled).toBe(false);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        expect(fixture.state.freeReadingPending).toBe(false);
    });

    it.each([false, true])('builds the patch from restored preferences and keeps selection whether the hydration echo flushes first (%s)', async echoBeforeReady => {
        let hydrate!: () => void;
        const fixture = prepare(new Promise<void>(resolve => { hydrate = resolve; }));
        const selection = fixture.state.snapshot;
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        const restored = harness.normalizeHarnessPreferences({...fixture.config.harness,
            actions: ['meaning', 'usage'], defaultAction: 'usage', contextMode: 'selection', learningLevel: 'advanced',
            explanationDepth: 'detailed', systemPrompt: 'Restored system prompt', actionPrompts: {...fixture.config.harness.actionPrompts, usage: 'Restored usage prompt'},
        });
        fixture.config.harness = restored;
        fixture.notifyConfig();
        if (echoBeforeReady) await Vue.nextTick();
        expect(fixture.state.snapshot).toBe(selection);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.freeReadingPending).toBe(true);
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        expect(fixture.captureReading).not.toHaveBeenCalled();
        hydrate();
        await pending;
        expect(fixture.requestConfigPatch).toHaveBeenCalledTimes(1);
        expect(fixture.requestConfigPatch.mock.calls[0][0].harness).toEqual({...restored, enabled: true, service: services.bilibili, model: ''});
        expect(fixture.config.harness).toEqual({...restored, enabled: true, service: services.bilibili, model: ''});
        expect(fixture.state.snapshot).toBe(selection);
        expect(fixture.state.readingMode).toBe(true);
        expect(fixture.state.readingInitialAction).toBe('usage');
        expect(fixture.captureReading).toHaveBeenCalledTimes(1);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['service', 'model', 'enabled'] as const)('does not overwrite a protected %s choice restored during hydration', async kind => {
        let hydrate!: () => void;
        const fixture = prepare(new Promise<void>(resolve => { hydrate = resolve; }));
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        if (kind === 'service') fixture.config.harness.service = services.deepseek;
        if (kind === 'model') fixture.config.harness.model = 'Restored paid model';
        if (kind === 'enabled') fixture.config.harness.enabled = true;
        fixture.notifyConfig();
        const restored = JSON.stringify(fixture.config.harness);
        await Vue.nextTick();
        hydrate();
        await pending;
        expect(fixture.requestConfigPatch).not.toHaveBeenCalled();
        expect(JSON.stringify(fixture.config.harness)).toBe(restored);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['close', 'selection', 'unmount', 'external-preference'] as const)('rejects a delayed save after %s', async reason => {
        const fixture = prepare();
        let confirm!: () => void;
        fixture.requestConfigPatch.mockImplementation(patch => {
            Object.assign(fixture.config, patch);
            fixture.notifyConfig();
            return new Promise<void>(resolve => { confirm = resolve; });
        });
        const pending = fixture.state.enableFreeReading();
        await Vue.nextTick();
        if (reason === 'close') fixture.state.hideAll();
        if (reason === 'selection') {
            fixture.state.snapshot = {...fixture.state.snapshot, text: 'A new selected sentence.'};
            fixture.state.selectedText = 'A new selected sentence.';
        }
        if (reason === 'unmount') fixture.unmount();
        if (reason === 'external-preference') {
            fixture.config.harness.explanationDepth = 'detailed';
            fixture.notifyConfig();
            await Vue.nextTick();
        }
        expect(fixture.state.freeReadingPending).toBe(true);
        if (reason === 'selection') {
            fixture.state.openReading('meaning');
            expect(fixture.state.readingMode).toBe(false);
            expect(fixture.captureReading).not.toHaveBeenCalled();
        }
        confirm();
        await pending;
        expect(fixture.state.freeReadingPending).toBe(false);
        expect(fixture.state.readingMode).toBe(false);
        expect(fixture.captureReading).not.toHaveBeenCalled();
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('selection card language configuration without header switches', () => {
    it.each([
        ['Ceci est une phrase française complète.', 'fr', 'de', false, false, 'fr', 'de'],
        ['这是完整的中文选文。', 'auto', 'zh-Hans', true, false, 'zh-Hans', 'en'],
        ['This is a clear English sentence for reverse translation.', 'zh-Hant', 'en', true, false, 'en', 'zh-Hant'],
        ['这是完整的中文选文。', 'auto', 'zh-Hans', false, true, 'zh-Hans', 'en'],
        ['This is a clear English sentence for translation.', 'auto', 'zh-Hans', false, false, 'auto', 'zh-Hans'],
    ] as const)('uses configuration and explicit reverse entry for %s', (text, from, to, bidirectional, manual, expectedSource, expectedTarget) => {
        const fixture = mountSelection();
        fixture.config.from = from;
        fixture.config.to = to;
        fixture.config.selectionTranslatorBidirectional = bidirectional;
        fixture.state.selectionConfigVersion += 1;
        fixture.state.selectedText = text;
        fixture.state.manuallyRequestedSelection = manual;
        expect(fixture.state.effectiveSourceLanguage).toBe(expectedSource);
        expect(fixture.state.effectiveTargetLanguage).toBe(expectedTarget);
        expect(fixture.state.beginSelectionContentRequest(text)).toMatchObject({text, sourceLanguage: expectedSource, targetLanguage: expectedTarget});
    });

    it('cancels an old direction request and rejects its delayed answer after the language setting changes', async () => {
        const fixture = mountSelection();
        const text = 'Ceci est une phrase française complète.';
        let resolveOld!: (value: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise<string>(resolve => {resolveOld = resolve;}));
        fixture.translateText.mockResolvedValueOnce('A fresh English answer.');
        fixture.state.snapshot = fixture.selectedSnapshot(text);
        fixture.state.selectedText = text;
        fixture.state.showTooltip = true;
        fixture.state.requestSelectionContent(text);
        const oldOptions = fixture.translateText.mock.calls[0][2];
        expect(oldOptions.targetLanguage).toBe('zh-Hans');
        fixture.config.to = 'en';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        await Promise.resolve();
        expect(oldOptions.signal.aborted).toBe(true);
        expect(fixture.translateText).toHaveBeenLastCalledWith(text, '', expect.objectContaining({sourceLanguage: 'auto', targetLanguage: 'en'}));
        expect(fixture.state.translationResult).toBe('A fresh English answer.');
        resolveOld('An obsolete Chinese answer.');
        await Promise.resolve();
        await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('A fresh English answer.');
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('explicit selection sentence collection', () => {
    function prepare(text: string, sourceLanguage = 'en', privateContext = false) {
        const fixture = mountSelection(privateContext);
        fixture.config.vocabularyBookEnabled = true;
        const request = {text, generation: 1, sourceLanguage, targetLanguage: 'zh-Hans'};
        fixture.state.snapshot = {text};
        fixture.state.selectedText = text;
        fixture.state.activeContentRequest = request;
        fixture.state.translationAnswer = {...request, answer: '这是一句译文。'};
        fixture.browser.runtime.sendMessage.mockResolvedValue({success: true, data: {id: 'saved-sentence'}});
        return {...fixture, request};
    }

    it('saves a complete selected sentence through the existing card without requiring an English word selection', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        expect(fixture.state.isWordSelection).toBe(false);
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'upsert', input: expect.objectContaining({
                term: fixture.request.text, sourceLanguage: 'en', translation: '这是一句译文。',
            }),
        }));
        expect(fixture.state.isVocabularySaved).toBe(true);
        expect(fixture.completeMaterialCapture).toHaveBeenCalledWith(expect.objectContaining({generation: 17}),
            {kind: 'vocabulary', id: 'saved-sentence', excerpt: fixture.request.text}, expect.any(Function));
        expect(fixture.materialCapture).toHaveBeenCalledWith(expect.objectContaining({
            source: {kind: 'article', url: 'https://example.test/article', title: 'Selected article'},
            locator: {kind: 'text', quote: fixture.request.text}, generation: 17,
            reference: {kind: 'vocabulary', id: 'saved-sentence', excerpt: fixture.request.text},
        }));
    });
    it('J1 saves only original DOM context while retaining privacy-stripped wordbook URLs and independent material identity', async () => {
        const text = 'Use getUserID to load the original passage.';
        const fixture = prepare(text);
        const parsed = parseHTML('<html><body><p>Before. <span>Use <code>getUserID</code> to load the original passage.</span><span class="fluent-read-bilingual-content">受控译文不应保存</span> After.</p></body></html>');
        const node = parsed.document.querySelector('span')!;
        const range = {startContainer:node.firstChild!,startOffset:0,endContainer:node.lastChild!,endOffset:node.lastChild!.textContent!.length} as unknown as Range;
        vi.stubGlobal('Node',parsed.window.Node);vi.stubGlobal('location',new URL('https://example.test/read?id=7&token=private#part'));
        fixture.state.snapshot = {text,range};
        fixture.material.captureMaterialSelection.mockReturnValue({source:{kind:'article',url:'https://example.test/read?id=7'},locator:{kind:'text',quote:text}});
        await fixture.state.saveVocabularyEntry({isTrusted:true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action:'upsert',input:expect.objectContaining({context:expect.objectContaining({text:'Before. Use getUserID to load the original passage. After.',sourceUrl:'https://example.test/read'})})}));
        expect(fixture.materialCapture).toHaveBeenCalledWith(expect.objectContaining({source:{kind:'article',url:'https://example.test/read?id=7'},locator:{kind:'text',quote:text}}));
    });
    it.each(['over-budget','detached'] as const)('J1 retains only selected text when original context is %s', async condition => {
        const text='Selected original sentence.';const fixture=prepare(text);
        const parsed=parseHTML(`<html><body><p><span>${text}</span>${'b'.repeat(13000)}<span class="fluent-read-bilingual-content">译文不应保存</span></p></body></html>`);
        const node=parsed.document.querySelector('span')!.firstChild!;
        fixture.state.snapshot={text,range:{startContainer:node,startOffset:0,endContainer:node,endOffset:text.length}};
        vi.stubGlobal('Node',parsed.window.Node);
        if(condition==='detached')parsed.document.querySelector('p')!.remove();
        await fixture.state.saveVocabularyEntry({isTrusted:true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action:'upsert',input:expect.objectContaining({context:expect.objectContaining({text})})}));
    });
    it('J1 freezes original context before asynchronous material generation rather than rereading a mutated page', async () => {
        const text='Selected original sentence.';const fixture=prepare(text);
        const parsed=parseHTML(`<html><body><p>Before. <span>${text}</span> After.</p></body></html>`),node=parsed.document.querySelector('span')!.firstChild!;
        fixture.state.snapshot={text,range:{startContainer:node,startOffset:0,endContainer:node,endOffset:text.length}};
        vi.stubGlobal('Node',parsed.window.Node);vi.stubGlobal('location',new URL('https://example.test/first?private=1'));
        let release!: (value:number)=>void;fixture.materialGeneration.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
        const pending=fixture.state.saveVocabularyEntry({isTrusted:true});
        parsed.document.querySelector('p')!.textContent='Replacement page context';vi.stubGlobal('location',new URL('https://other.test/replaced'));
        release(17);await pending;
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action:'upsert',input:expect.objectContaining({context:expect.objectContaining({text:`Before. ${text} After.`,sourceUrl:'https://example.test/first'})})}));
    });

    it('uses the captured language for other-language sentences and retrieves saved state after explicit card requests', async () => {
        const fixture = prepare('Les idées méritent notre attention.', 'fr');
        await fixture.state.refreshVocabularySaved(fixture.request);
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'getByTerm', sourceLanguage: 'fr', term: fixture.request.text,
        }));
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'upsert', input: expect.objectContaining({sourceLanguage: 'fr'}),
        }));
    });

    it('does not query or save a selected sentence in a private context', async () => {
        const fixture = prepare('Good ideas deserve attention.', 'en', true);
        fixture.browser.runtime.sendMessage.mockClear();
        await fixture.state.refreshVocabularySaved(fixture.request);
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.type === vocabularyProtocol.VOCABULARY_BOOK_MESSAGE)).toBe(false);
        expect(fixture.material.captureMaterialSelection).not.toHaveBeenCalled();
        expect(fixture.material.beginMaterialCapture).not.toHaveBeenCalled();
        expect(fixture.materialCapture).not.toHaveBeenCalled();
    });

    it('still saves the vocabulary record when optional material DOM capture throws', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        fixture.material.captureMaterialSelection.mockImplementation(() => {throw new Error('Source DOM detached');});
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action: 'upsert'}));
        expect(fixture.state.isVocabularySaved).toBe(true);
        expect(fixture.state.vocabularyBusy).toBe(false);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('does not save a stale selection while the material generation read is pending', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        fixture.browser.runtime.sendMessage.mockClear();
        const selection: MaterialSelection = {source: {kind: 'article', url: 'https://example.com/article'}, locator: {kind: 'text', quote: fixture.request.text}};
        fixture.material.captureMaterialSelection.mockReturnValue(selection);
        let finish!: (value: Awaited<ReturnType<typeof beginCapture>>) => void;
        fixture.material.beginMaterialCapture.mockImplementation(() => new Promise<Awaited<ReturnType<typeof beginCapture>>>(resolve => {finish = resolve;}));
        const pending = fixture.state.saveVocabularyEntry({isTrusted: true});
        fixture.state.closeTooltip();
        finish({selection, generation: 1, capturedAt: Date.now()});await pending;
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'upsert')).toBe(false);
        expect(fixture.material.completeMaterialCapture).not.toHaveBeenCalled();
        expect(fixture.state.vocabularyBusy).toBe(false);
    });

    it('does not mark a new selection saved when the previous sentence save finishes late', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        let finish!: (response: unknown) => void;
        fixture.browser.runtime.sendMessage.mockImplementation(message => message.action === 'upsert'
            ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({success: true}));
        const pending = fixture.state.saveVocabularyEntry({isTrusted: true});
        // 材料代次读取先完成，才进入已有词书的异步保存；确认实际请求已开始后测试迟到响应。
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const text = 'Practice makes progress.';
        fixture.state.snapshot = {text};
        fixture.state.selectedText = text;
        fixture.state.beginSelectionContentRequest(text);
        finish({success: true, data: {id: 'old-sentence'}});
        await pending;
        expect(fixture.state.isVocabularySaved).toBe(false);
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.completeMaterialCapture).not.toHaveBeenCalled();
        expect(fixture.materialCapture).not.toHaveBeenCalled();
    });

    it('freezes source and generation before awaiting save, then links only the actual successful entry id', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        const selected: MaterialSelection = {source: {kind: 'article', url: 'https://example.test/original'},
            locator: {kind: 'text', quote: fixture.request.text}};
        fixture.captureMaterialSelection.mockReturnValueOnce(selected);
        let generation!: (value: number) => void, finish!: (value: unknown) => void;
        fixture.materialGeneration.mockReturnValueOnce(new Promise<number>(resolve => {generation = resolve;}));
        fixture.browser.runtime.sendMessage.mockImplementation(message => message.action === 'upsert'
            ? new Promise(resolve => {finish = resolve;}) : Promise.resolve({success: true}));
        const capturedAt = Date.now(), pending = fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.beginMaterialCapture).toHaveBeenCalledWith(selected, false);
        expect(fixture.materialGeneration).toHaveBeenCalledOnce();
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'upsert')).toBe(false);
        selected.source.url = 'https://example.test/replacement'; selected.locator!.quote = 'Changed source';
        generation(29); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(fixture.completeMaterialCapture).not.toHaveBeenCalled();
        expect(fixture.materialCapture).not.toHaveBeenCalled();
        finish({success: true, data: {id: 'real-entry-29'}}); await pending;
        expect(fixture.materialCapture).toHaveBeenCalledOnce();
        expect(fixture.materialCapture).toHaveBeenCalledWith({
            source: {kind: 'article', url: 'https://example.test/original'}, locator: {kind: 'text', quote: fixture.request.text},
            generation: 29, capturedAt, reference: {kind: 'vocabulary', id: 'real-entry-29', excerpt: fixture.request.text},
        });
        expect(fixture.state.isVocabularySaved).toBe(true); expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('does not upsert or link an obsolete selection while its material generation is pending', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        let generation!: (value: number) => void;
        fixture.materialGeneration.mockReturnValueOnce(new Promise<number>(resolve => {generation = resolve;}));
        const pending = fixture.state.saveVocabularyEntry({isTrusted: true});
        const text = 'Practice makes progress.';
        fixture.state.snapshot = {text}; fixture.state.selectedText = text; fixture.state.beginSelectionContentRequest(text);
        generation(31); await pending;
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'upsert')).toBe(false);
        expect(fixture.completeMaterialCapture).not.toHaveBeenCalled(); expect(fixture.materialCapture).not.toHaveBeenCalled();
        expect(fixture.state.isVocabularySaved).toBe(false);
    });

    it.each([
        ['failed save', {success: false, error: {message: 'Controlled save failure'}}],
        ['missing saved data', {success: true}], ['missing entry id', {success: true, data: {}}],
    ] as const)('does not associate a material after %s', async (_label, response) => {
        const fixture = prepare('Good ideas deserve attention.');
        fixture.browser.runtime.sendMessage.mockResolvedValue(response);
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.completeMaterialCapture).not.toHaveBeenCalled(); expect(fixture.materialCapture).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['untrusted', 'disabled', 'missing-answer'] as const)('does not save when %s', async condition => {
        const fixture = prepare('Good ideas deserve attention.');
        if (condition === 'disabled') fixture.config.vocabularyBookEnabled = false;
        if (condition === 'missing-answer') fixture.state.translationAnswer = null;
        fixture.browser.runtime.sendMessage.mockClear();
        await fixture.state.saveVocabularyEntry({isTrusted: condition !== 'untrusted'});
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'upsert')).toBe(false);
    });
});

describe('selection action notice viewport ownership', () => {
    it.each([
        ['open-vocabulary', '查看', 'settings-vocabulary'],
        ['open-local-tts', '设置', 'settings-selection'],
    ] as const)('reserves the %s action in short visible viewports and dispatches only its existing action', async (action, label, section) => {
        const fixture = mountSelection(false, undefined, 'safari', true);
        const port = fixture.renderPort!;
        const notice = 'A long notice that may wrap in the narrow visible viewport. '.repeat(100);
        fixture.state.showNotice(notice, action);
        await Vue.nextTick();
        let toast = port.root.querySelector('.fr-action-toast') as HTMLElement;
        expect(toast.style.getPropertyValue('left')).toBe('982px');
        expect(toast.style.getPropertyValue('top')).toBe('782px');
        const viewport = {width: 296, height: 200, offsetLeft: 80, offsetTop: 240};
        // innerHeight may already shrink while VisualViewport retains a nonzero layout offset.
        Object.assign(fixture.window, {innerWidth: 390, innerHeight: 200, visualViewport: viewport});
        fixture.state.touchInteraction = true;
        const resize = [...fixture.listeners.get('window:resize')!];
        expect(resize).toHaveLength(1); // reuse the component's existing viewport observer
        resize.forEach(listener => listener({}));
        await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
        toast = port.root.querySelector('.fr-action-toast') as HTMLElement;
        expect(toast.style.getPropertyValue('left')).toBe('364px');
        expect(toast.style.getPropertyValue('top')).toBe('428px');
        expect(toast.style.getPropertyValue('max-width')).toBe('272px');
        expect(toast.style.getPropertyValue('max-height')).toBe('176px');
        expect(toast.style.getPropertyValue('padding-block')).toBe('9px');
        expect(toast.style.getPropertyValue('--fr-notice-content-height')).toBe('158px');
        for (const [height, padding, contentHeight, alignment] of [
            [32, 0, 32, 'flex-start'], [44, 0, 44, 'center'], [58, 7, 44, 'center'],
        ] as const) {
            Object.assign(viewport, {height, offsetTop: 320});
            resize.forEach(listener => listener({}));
            await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
            expect(toast.style.getPropertyValue('top')).toBe(`${320 + height}px`);
            expect(toast.style.getPropertyValue('max-height')).toBe(`${height}px`);
            expect(toast.style.getPropertyValue('padding-block')).toBe(`${padding}px`);
            expect(toast.style.getPropertyValue('--fr-notice-content-height')).toBe(`${contentHeight}px`);
            expect(toast.style.getPropertyValue('align-items')).toBe(alignment);
            expect(toast.querySelector('span')!.textContent).toBe(notice);
        }
        expect(fixture.browser.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'openOptionsPage')).toHaveLength(0);
        const button = toast.querySelector('button')!;
        expect(button.textContent).toBe(label);
        await port.click(button); await Vue.nextTick();
        expect(fixture.browser.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'openOptionsPage'))
            .toEqual([[{type: 'openOptionsPage', section}]]);
        expect(port.root.querySelector('.fr-action-toast')).toBeNull();
        expect(fixture.translateText).not.toHaveBeenCalled();
        fixture.state.showNotice('Another notice.', action); await Vue.nextTick();
        const lastViewport = fixture.state.viewportSize;
        fixture.unmount();
        expect([...fixture.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
        Object.assign(viewport, {height: 100, offsetTop: 300});
        resize.forEach(listener => listener({}));
        await vi.advanceTimersByTimeAsync(2601);
        expect(fixture.state.viewportSize).toBe(lastViewport);
        expect(vi.getTimerCount()).toBe(0);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('SelectionTranslator lifecycle after extension reload', () => {
    it.each(['normal', 'runtime removed', 'event removed', 'removeListener throws'] as const)(
        'cleans up all selection resources when %s', async failure => {
            const fixture = mountSelection();
            const {state, event, browser, window, listeners} = fixture;
            await Vue.nextTick();
            expect(fixture.config.disableSelectionTranslator).toBe(false);
            expect(fixture.config.selectionTranslatorMode).toBe('bilingual');
            const registered = event.addListener.mock.calls.map(([listener]) => listener);
            expect(registered).toHaveLength(4);
            const onTimer = vi.fn();
            for (const timer of ['readingHoverTimer', 'selectionLossTimer', 'selectionPresentationTimer', 'copyTimer', 'noticeTimer']) {
                state[timer] = setTimeout(onTimer, 50);
            }
            state.selectionFrame = window.requestAnimationFrame(onTimer);
            state.positionFrame = window.requestAnimationFrame(onTimer);
            const pendingTranslation = new AbortController();
            state.translationAbortController = pendingTranslation;
            const pendingWordLookup = new AbortController();
            state.wordLookupAbortController = pendingWordLookup;
            state.isWordCardSupportLoading = true;
            state.translationResult = '译文';
            state.isLoading = true;
            if (failure === 'runtime removed') Reflect.deleteProperty(browser, 'runtime');
            else if (failure === 'event removed') Reflect.deleteProperty(browser.runtime, 'onMessage');
            else if (failure === 'removeListener throws') {
                event.removeListener.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
            }

            expect(() => fixture.unmount()).not.toThrow();
            expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
            expect(event.removeListener.mock.calls.map(([listener]) => listener)).toEqual(registered);
            expect(fixture.unsubscribeConfig).toHaveBeenCalledOnce();
            expect(fixture.releaseContextMenu).toHaveBeenCalledOnce();
            expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
            expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2);
            expect(pendingTranslation.signal.aborted).toBe(true);
            expect(pendingWordLookup.signal.aborted).toBe(true);
            expect(state.isWordCardSupportLoading).toBe(false);
            expect(fixture.stopTts).toHaveBeenCalledWith(true);
            expect(window.speechSynthesis.cancel).toHaveBeenCalledOnce();
            expect(state.translationResult).toBe('');
            expect(state.isLoading).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(100);
            expect(onTimer).not.toHaveBeenCalled();
        },
    );

    const card = (word: string) => ({word, normalizedWord: word, phonetics: [], sources: [],
        meanings: [{partOfSpeech: '名词', definitions: [{definition: 'an English definition'}]}]});
    function beginWord(fixture: ReturnType<typeof mountSelection>, word: string) {
        fixture.state.snapshot = fixture.selectedSnapshot(word);
        fixture.state.selectedText = word;
        return fixture.state.beginSelectionContentRequest(word);
    }

    it('shows the first word card while auxiliary translation is pending and cancels that wait on unmount', async () => {
        const fixture = mountSelection();
        const {state, browser} = fixture;
        browser.runtime.sendMessage.mockImplementation((message: any) => message.type !== 'selectionWordLookup'
            ? Promise.resolve({success: true, zoom: 1})
            : message.translateFields ? new Promise(() => {}) : Promise.resolve({success: true, data: card(message.word)}));
        const pending = state.requestWordCard(beginWord(fixture, 'read'));
        await vi.advanceTimersByTimeAsync(0);
        expect(state.wordCard.word).toBe('read');
        expect(state.isWordCardLoading).toBe(false);
        expect(state.isWordCardSupportLoading).toBe(true);
        fixture.unmount();
        await pending;
        expect(vi.getTimerCount()).toBe(0);
        expect(state.wordCard).toBeNull();
    });

    it('ends an unresponsive message after 3.5 seconds while keeping the ordinary translation', async () => {
        const fixture = mountSelection();
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionWordLookup'
            ? new Promise(() => {}) : Promise.resolve({success: true, zoom: 1}));
        const request = beginWord(fixture, 'missing');
        fixture.state.translationResult = '已有译文';
        const pending = fixture.state.requestWordCard(request);
        await vi.advanceTimersByTimeAsync(3_500);
        await pending;
        expect(fixture.state.isWordCardLoading).toBe(false);
        expect(fixture.state.wordCardError).toContain('可稍后重查');
        expect(fixture.state.translationResult).toBe('已有译文');
    });

    it('ignores an old word response after the user selects a new word', async () => {
        const fixture = mountSelection();
        let release!: (response: any) => void;
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type !== 'selectionWordLookup'
            ? Promise.resolve({success: true, zoom: 1}) : message.word === 'old'
                ? new Promise(resolve => { release = resolve; }) : Promise.resolve({success: true, data: card(message.word)}));
        const old = fixture.state.requestWordCard(beginWord(fixture, 'old'));
        const current = fixture.state.requestWordCard(beginWord(fixture, 'new'));
        await vi.advanceTimersByTimeAsync(0);
        await current;
        release({success: true, data: card('old')});
        await old;
        expect(fixture.state.wordCard.word).toBe('new');
        expect(fixture.state.wordCardError).toBe('');
        expect(fixture.state.isWordCardSupportLoading).toBe(false);
    });
});

function deferredTts() {
    let resolve!: (response: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function ttsMessages(fixture: ReturnType<typeof mountSelection>, type: string) {
    return fixture.browser.runtime.sendMessage.mock.calls
        .map(([message]) => message as {type: string; text?: string; clientRequestId: string})
        .filter(message => message.type === type);
}

function prepareTts(fixture: ReturnType<typeof mountSelection>, responses: Promise<Record<string, unknown>>[]) {
    fixture.config.selectionTtsMode = 'local-only';
    fixture.browser.runtime.sendMessage.mockImplementation((message: any) => {
        if (message.type === 'selectionTts') {
            const response = responses.shift();
            if (!response) throw new Error('Unexpected TTS request');
            return response;
        }
        return Promise.resolve({success: true, zoom: 1});
    });
}

function emitTtsState(fixture: ReturnType<typeof mountSelection>, clientRequestId: string, state: string, extra = {}) {
    return fixture.event.addListener.mock.calls.map(([listener]) =>
        listener({type: 'selectionTtsState', clientRequestId, state, ...extra}));
}

function expectAudioReset(state: Record<string, any>) {
    expect(state.isPreparingAudio).toBe(false);
    expect(state.isPlaying).toBe(false);
    expect(state.audioProgress).toBeNull();
    expect(state.currentAudioKind).toBeNull();
    expect(state.currentAudioText).toBe('');
    expect(state.currentAudioKey).toBe('');
}

describe('SelectionTranslator TTS generation and progress ownership', () => {
    it('5 second controls use the active route, reject unavailable playback and ignore late seek failures', async () => {
        const fixture=mountSelection();const response=deferredTts();prepareTts(fixture,[response.promise]);
        const pending=fixture.state.toggleAudio('Hello world','source');
        await fixture.state.seekAudio(5);expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        response.resolve({success:true,transport:'offscreen'});await pending;
        await fixture.state.seekAudio(5);expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        emitTtsState(fixture,'tts-client-1','progress',{progress:{start:0,end:5,fraction:0,estimated:true},position:{currentTime:2,duration:12}});
        fixture.browser.runtime.sendMessage.mockResolvedValue({success:true});
        await fixture.state.seekAudio(5);await fixture.state.seekAudio(-5);
        expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([
            {type:'selectionTtsSeek',clientRequestId:'tts-client-1',offsetSeconds:5},
            {type:'selectionTtsSeek',clientRequestId:'tts-client-1',offsetSeconds:-5},
        ]);
        expect(fixture.state.audioPosition).toEqual({currentTime:2,duration:12});
        const delayed=deferredTts();fixture.browser.runtime.sendMessage.mockImplementation(message=>message.type==='selectionTtsSeek'?delayed.promise:Promise.resolve({success:true}));
        const jump=fixture.state.seekAudio(5);fixture.state.stopAudio();delayed.resolve({success:false});await jump;
        expect(fixture.state.audioPosition).toBeNull();expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.state.playbackTime(65.9)).toBe('1:05');
    });

    it('page audio jumps by 5 seconds, updates text immediately and clears its sampling timer on stop', async () => {
        const fixture=mountSelection();const audios:FakeSeekAudio[]=[];
        class FakeSeekAudio {
            currentTime=2;duration=12;ontimeupdate:((event?:Event)=>void)|null=null;
            play=vi.fn(async()=>undefined);pause=vi.fn();removeAttribute=vi.fn();
            constructor(public src:string){audios.push(this);}
        }
        vi.stubGlobal('Audio',FakeSeekAudio);
        await fixture.state.playExternalAudio('https://audio','Hello world','source','Hello world',0);
        await fixture.state.seekAudio(5);expect(audios[0].currentTime).toBe(7);
        expect(fixture.state.audioPosition).toEqual({currentTime:7,duration:12});expect(fixture.state.audioProgress.start).toBe(6);
        await fixture.state.seekAudio(-5);await fixture.state.seekAudio(-5);expect(audios[0].currentTime).toBe(0);
        expect(fixture.state.audioProgress.start).toBe(0);
        await fixture.state.seekAudio(5);await fixture.state.seekAudio(5);await fixture.state.seekAudio(5);expect(audios[0].currentTime).toBe(12);
        expect(audios[0].play).toHaveBeenCalledOnce();expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        fixture.state.stopAudio();expect(fixture.state.audioPosition).toBeNull();
        const stopped=fixture.state.audioProgress;await vi.advanceTimersByTimeAsync(500);expect(fixture.state.audioProgress).toBe(stopped);
    });
    it.each(['source', 'translation'] as const)('keeps %s in preparation until synthesis succeeds', async kind => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('  Practice helps.  ', kind);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.audioProgress).toBeNull();
        expect(fixture.state.currentAudioKind).toBe(kind);
        expect(fixture.state.currentAudioText).toBe('Practice helps.');
        expect(ttsMessages(fixture, 'selectionTts')).toEqual([
            expect.objectContaining({text: 'Practice helps.', clientRequestId: 'tts-client-1'}),
        ]);
        await vi.advanceTimersByTimeAsync(500);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe(kind);
        expect(fixture.state.currentAudioKey).toBe('Practice helps.');
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['response', 'rejection'] as const)('resets preparation and displays an error after synthesis %s', async failure => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.isPreparingAudio).toBe(true);
        if (failure === 'response') response.resolve({success: false, error: '模型推理失败'});
        else response.reject(new Error('worker disconnected'));
        await pending;
        expectAudioReset(fixture.state);
        expect(fixture.state.noticeMessage).toBe(failure === 'response' ? '模型推理失败' : '本地语音生成失败，请重试');
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([]);
        if (failure === 'rejection') expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({message: 'worker disconnected'}));
    });

    it.each(['stop button', 'same text toggle', 'unmount'] as const)('cancels pending synthesis via %s and discards late success', async action => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        if (action === 'stop button') fixture.state.stopAudioFromUi();
        else if (action === 'same text toggle') await fixture.state.toggleAudio('Practice helps.', 'source');
        else fixture.unmount();
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(true);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId}]);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        // STOP 可以先于远端 PLAY 生效；迟到成功须再次精确停止旧请求。
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([
            {type: 'selectionTtsStop', clientRequestId}, {type: 'selectionTtsStop', clientRequestId},
        ]);
        expect(fixture.state.noticeMessage).toBe('');
    });

    it.each(['success', 'failure', 'rejection'] as const)('ignores old synthesis %s while the replacement is playing', async outcome => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('新句子。', 'translation');
        const [oldRequest, newRequest] = ttsMessages(fixture, 'selectionTts');
        expect(oldRequest.clientRequestId).not.toBe(newRequest.clientRequestId);
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        const progress = {start: 0, end: 4, fraction: 0.5, estimated: true};
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).toContain(true);
        if (outcome === 'success') oldResponse.resolve({success: true, transport: 'offscreen'});
        else if (outcome === 'failure') oldResponse.resolve({success: false, error: 'old model failed'});
        else oldResponse.reject(new Error('old worker disconnected'));
        await oldPending;
        await Vue.nextTick();
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.currentAudioKind).toBe('translation');
        expect(fixture.state.currentAudioText).toBe('新句子。');
        expect(fixture.state.audioProgress).toEqual(progress);
        expect(fixture.state.noticeMessage).toBe('');
        expect(ttsMessages(fixture, 'selectionTtsStop').every(message => message.clientRequestId === oldRequest.clientRequestId)).toBe(true);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toHaveLength(outcome === 'success' ? 2 : 1);
    });

    it('does not clear replacement preparation when old synthesis completes first', async () => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('New sentence.', 'source');
        oldResponse.resolve({success: true, transport: 'offscreen'});
        await oldPending;
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.currentAudioText).toBe('New sentence.');
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
    });

    it('routes progress to the pending or active request and rejects old, unrelated and malformed progress', async () => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        oldResponse.resolve({success: true, transport: 'offscreen'});
        await oldPending;
        const newPending = fixture.state.toggleAudio('新句子。', 'translation');
        const [oldRequest, newRequest] = ttsMessages(fixture, 'selectionTts');
        const progress = {start: 0, end: 4, fraction: 0.25, estimated: true};
        expect(emitTtsState(fixture, oldRequest.clientRequestId, 'progress', {progress})).not.toContain(true);
        expect(emitTtsState(fixture, 'another-card', 'progress', {progress})).not.toContain(true);
        expect(fixture.state.audioProgress).toBeNull();
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).toContain(true);
        expect(fixture.state.audioProgress).toEqual(progress);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.audioProgressFor('translation')).toBeNull();
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        expect(fixture.state.audioProgressFor('translation')).toEqual(progress);
        expect(fixture.state.audioProgressFor('source')).toBeNull();
        emitTtsState(fixture, oldRequest.clientRequestId, 'progress', {progress: {...progress, fraction: 0.9}});
        expect(fixture.state.audioProgress).toEqual(progress);
        emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress: {...progress, fraction: Number.NaN}});
        expect(fixture.state.audioProgress).toBeNull();
        fixture.state.stopAudioFromUi();
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).not.toContain(true);
        expectAudioReset(fixture.state);
    });

    it.each(['ended', 'stopped', 'error'] as const)('resets playback on matching %s without stopping the remote again', async terminal => {
        const fixture = mountSelection();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        emitTtsState(fixture, clientRequestId, 'progress', {progress: {start: 0, end: 15, fraction: 0.5, estimated: true}});
        expect(emitTtsState(fixture, 'another-card', terminal, {error: '其他卡片错误'})).not.toContain(true);
        expect(fixture.state.isPlaying).toBe(true);
        expect(emitTtsState(fixture, clientRequestId, terminal, {error: '音频解码失败'})).toContain(true);
        expectAudioReset(fixture.state);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        await Vue.nextTick();
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([]);
        expect(fixture.state.noticeMessage).toBe(terminal === 'error' ? '音频解码失败' : '');
    });
});

describe('SelectionTranslator word TTS generation and fallback', () => {
    const pronunciation = {text: 'American pronunciation', label: '美式'};

    it.each([
        ['local-only', 'ready'], ['local-only', 'missing-model'], ['local-first', 'ready'], ['online-only', 'ready'],
    ] as const)('[word-audio-policy] the actual pronunciation button respects %s with %s', async (mode, outcome) => {
        const fixture = mountSelection(false, undefined, 'chrome', true), port = fixture.renderPort!;
        const urls: string[] = [], pause = vi.fn();
        vi.stubGlobal('Audio', class {
            currentTime = 0;duration = 1;preload = '';play = vi.fn(async () => undefined);pause = pause;removeAttribute = vi.fn();
            constructor(src: string) {urls.push(src);}
        });
        const response = deferredTts();prepareTts(fixture, [response.promise]);fixture.config.selectionTtsMode = mode;
        fixture.state.selectedText = 'hello';fixture.state.showTooltip = true;
        fixture.state.wordCard = {word: 'hello', normalizedWord: 'hello', phonetics: [{text: '/həˈləʊ/', label: '美式', audio: 'https://dictionary.test/hello.mp3'}], meanings: [], sources: []};
        await Vue.nextTick();
        const trigger = port.root.querySelector('button[aria-label="播放美式"]');expect(trigger).not.toBeNull();
        const pending = port.click(trigger!);
        response.resolve(outcome === 'missing-model' ? {success: false, errorCode: 'local-tts-model-not-downloaded'} : {success: true, transport: 'offscreen'});
        await pending;await Vue.nextTick();
        if (mode === 'local-only') {
            expect.soft(urls).toEqual([]);
            expect.soft(ttsMessages(fixture, 'selectionTts')).toEqual([expect.objectContaining({text: 'hello', language: 'en-US'})]);
            expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([]);
            if (outcome === 'missing-model') expect(port.root.textContent).toContain('selectionTts.localModelNotDownloaded');
        } else {
            expect(urls).toEqual(['https://dictionary.test/hello.mp3']);expect(ttsMessages(fixture, 'selectionTts')).toEqual([]);
        }
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        if (outcome === 'ready') {
            expect(trigger!.getAttribute('aria-label')).toBe('停止播放美式');await port.click(trigger!);await Vue.nextTick();
            expect(trigger!.getAttribute('aria-label')).toBe('播放美式');
            if (mode === 'local-only') expect(ttsMessages(fixture, 'selectionTtsStop')).toHaveLength(1);else expect(pause).toHaveBeenCalledOnce();
        }
    });

    function beginWordTts(fixture: ReturnType<typeof mountSelection>, response: ReturnType<typeof deferredTts>) {
        fixture.state.wordCard = {word: 'hello'};
        prepareTts(fixture, [response.promise]);
        return fixture.state.toggleWordAudio(pronunciation);
    }

    function browserSpeech(fixture: ReturnType<typeof mountSelection>) {
        const speak = vi.fn();
        Object.assign(fixture.window.speechSynthesis, {getVoices: () => [], speak});
        vi.stubGlobal('SpeechSynthesisUtterance', class {
            constructor(public text: string) {}
        });
        return speak;
    }

    it.each(['offscreen', 'page'] as const)('keeps word generation pending then restores the pronunciation key after %s playback', async transport => {
        const fixture = mountSelection();
        const response = deferredTts();
        const audios: Array<{play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>}> = [];
        vi.stubGlobal('Audio', class {
            preload = '';
            play = vi.fn(async () => undefined);
            pause = vi.fn();
            removeAttribute = vi.fn();
            constructor() { audios.push(this); }
        });
        const pending = beginWordTts(fixture, response);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.currentAudioText).toBe('hello');
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        await vi.advanceTimersByTimeAsync(500);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        response.resolve({success: true, transport, ...(transport === 'page' ? {audioBase64: 'YQ==', contentType: 'audio/mpeg'} : {})});
        await pending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        expect(fixture.state.isCurrentWordAudio(pronunciation)).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual(transport === 'offscreen'
            ? [{type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}] : []);
        if (transport === 'page') {
            expect(audios[0].play).toHaveBeenCalledOnce();
            expect(audios[0].pause).toHaveBeenCalledOnce();
        }
    });

    it('cancels the same pronunciation key during generation and never adopts its late result', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const pending = beginWordTts(fixture, response);
        expect(fixture.state.isPreparingAudio).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}]);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([
            {type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}, {type: 'selectionTtsStop', clientRequestId: 'tts-client-1'},
        ]);
    });

    it.each([
        ['inference failure', {success: false, error: '单词推理失败'}, '单词推理失败', null],
        ['model missing', {success: false, errorCode: 'local-tts-model-not-downloaded'}, 'selectionTts.localModelNotDownloaded', 'open-local-tts'],
        ['language unsupported', {success: false, errorCode: 'local-tts-language-unsupported'}, 'selectionTts.languageUnsupported', null],
    ])('clears local-only word ownership and displays the notice for %s', async (_kind, failure, notice, action) => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        const pending = beginWordTts(fixture, response);
        const generation = fixture.state.ttsContentController.currentGeneration();
        response.resolve(failure as Record<string, unknown>);
        await pending;
        expectAudioReset(fixture.state);
        expect(fixture.state.ttsContentController.currentGeneration()).toBeGreaterThan(generation);
        expect(fixture.state.noticeMessage).toBe(notice);
        expect(fixture.state.noticeAction).toBe(action);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        expect(speak).not.toHaveBeenCalled();
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([]);
    });

    it('continues to browser speech when the EdgeSpeechResult object has handled=false', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        fixture.state.wordCard = {word: 'hello'};
        prepareTts(fixture, [response.promise]);
        fixture.config.selectionTtsMode = 'online-only';
        const pending = fixture.state.toggleWordAudio({text: 'hello'});
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(speak).toHaveBeenCalledOnce();
        expect(speak).toHaveBeenCalledWith(expect.objectContaining({text: 'hello', lang: 'en-US'}));
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.isCurrentWordAudio({text: 'hello'})).toBe(true);
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([]);
    });

    it('preserves the selected pronunciation key after browser fallback so the next click stops playback', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        const pending = beginWordTts(fixture, response);
        fixture.config.selectionTtsMode = 'online-only';
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(speak).toHaveBeenCalledOnce();
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        expect(fixture.state.isCurrentWordAudio(pronunciation)).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
    });

    it('continues to Google offscreen fallback and keeps a distinct pronunciation key cancellable', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        fixture.state.wordCard = {word: 'hello'};
        fixture.config.selectionTtsMode = 'online-only';
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionTts'
            ? response.promise : Promise.resolve({success: true, transport: 'offscreen'}));
        const pending = fixture.state.toggleWordAudio(pronunciation);
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([
            expect.objectContaining({text: 'hello', language: 'en-US', clientRequestId: 'tts-client-2'}),
        ]);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId: 'tts-client-2'}]);
    });

    it('follows external word pronunciation using actual media time and ignores timeupdate after stop', async () => {
        const fixture = mountSelection();
        const audios: PronunciationAudio[] = [];
        class PronunciationAudio {
            currentTime = 0;
            duration = 4;
            ontimeupdate: (() => void) | null = null;
            play = vi.fn(async () => undefined);
            pause = vi.fn();
            removeAttribute = vi.fn();
            constructor(public src: string) { audios.push(this); }
        }
        vi.stubGlobal('Audio', PronunciationAudio);
        fixture.state.wordCard = {word: 'hello'};
        const pronunciation = {audio: 'https://dictionary.test/hello.mp3', label: '美式'};
        await fixture.state.toggleWordAudio(pronunciation);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.currentAudioKey).toBe(pronunciation.audio);
        expect(fixture.state.audioProgress).toEqual({start:0,end:5,fraction:0,estimated:true});
        expect(fixture.state.audioPosition).toEqual({currentTime:0,duration:4});
        expect(ttsMessages(fixture, 'selectionTts')).toEqual([]);
        const audio = audios[0];
        expect(audio.src).toBe(pronunciation.audio);
        expect(audio.play).toHaveBeenCalledOnce();
        expect(audio.ontimeupdate).toBeTypeOf('function');
        audio.currentTime = 2;
        audio.ontimeupdate?.();
        expect(fixture.state.audioProgressFor('word')).toEqual({start: 0, end: 5, fraction: 0.5, estimated: true});
        expect(fixture.state.audioProgressFor('source')).toBeNull();
        audio.currentTime = 1;
        audio.ontimeupdate?.();
        expect(fixture.state.audioProgressFor('word')).toEqual({start: 0, end: 5, fraction: 0.25, estimated: true});
        const staleTimeupdate = audio.ontimeupdate;
        await fixture.state.toggleWordAudio(pronunciation);
        expectAudioReset(fixture.state);
        expect(audio.pause).toHaveBeenCalledOnce();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        audio.currentTime = 3;
        staleTimeupdate?.();
        expectAudioReset(fixture.state);
        expect(audios).toHaveLength(1);
    });
});

describe('SelectionTranslator trimmed speech offsets in rich text', () => {
    it.each([
        ['source', '  ', 'x', ''],
        ['translation', '\t\uFEFF', 'x', '  '],
        ['source', '  ', '😀x', '\t'],
        ['translation', '', 'x', '  '],
    ] as const)('maps %s trimmed speech into the original code/text parts (%j, %j)', async (kind, leading, code, trailing) => {
        const fixture = mountSelection();
        const parts = [{kind: 'code', text: leading + code}, {kind: 'text', text: ' hello' + trailing}];
        const text = parts.map(part => part.text).join('');
        if (kind === 'source') {
            fixture.state.selectedText = text;
            fixture.state.snapshot = {text, parts};
        } else {
            fixture.state.translationResult = text;
            fixture.state.translationParts = parts;
        }
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio(text, kind);
        expect(ttsMessages(fixture, 'selectionTts')[0].text).toBe(text.trim());
        const trimmedStart = text.trim().indexOf('hello');
        const rawProgress = {start: trimmedStart, end: trimmedStart + 5, fraction: 0.5, estimated: true};
        emitTtsState(fixture, 'tts-client-1', 'progress', {progress: rawProgress});
        expect(fixture.state.audioProgress).toEqual(rawProgress);
        const displayed = fixture.state.audioProgressFor(kind);
        expect(displayed).toEqual({...rawProgress, start: text.indexOf('hello'), end: text.indexOf('hello') + 5});
        expect(fixture.state.audioTextOffset).toBe(leading.length);
        expect(fixture.state.audioProgressFor(kind === 'source' ? 'translation' : 'source')).toBeNull();
        const displayedParts = kind === 'source' ? fixture.state.sourceTextParts : fixture.state.translatedTextParts;
        const offset = displayedParts[1].offset;
        expect(offset).toBe(leading.length + code.length);
        expect(displayedParts[0].text).toBe(leading + code);
        expect(displayedParts.map((part: {text: string}) => part.text).join('')).toBe(text);
        fixture.state.stopAudioFromUi();
        expect(fixture.state.audioTextOffset).toBe(0);
        expect(fixture.state.audioProgressFor(kind)).toBeNull();
        expectAudioReset(fixture.state);
    });

    it.each(['source', 'translation'] as const)('preserves the %s trim offset when remote error falls back to browser word boundaries', async kind => {
        const fixture = mountSelection();
        const text = '  x hello';
        const parts = [{kind: 'code', text: '  x'}, {kind: 'text', text: ' hello'}];
        if (kind === 'source') {
            fixture.state.selectedText = text;
            fixture.state.snapshot = {text, parts};
        } else {
            fixture.state.translationResult = text;
            fixture.state.translationParts = parts;
        }
        const speak = vi.fn();
        Object.assign(fixture.window.speechSynthesis, {getVoices: () => [], speak});
        vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        fixture.config.selectionTtsMode = 'online-only';
        await fixture.state.toggleAudio(text, kind);
        expect(fixture.state.audioTextOffset).toBe(2);
        expect(emitTtsState(fixture, 'tts-client-1', 'error', {error: 'decode failed'})).toContain(true);
        expect(speak).toHaveBeenCalledOnce();
        const utterance = speak.mock.calls[0][0];
        expect(utterance.text).toBe('x hello');
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.audioTextOffset).toBe(2);
        utterance.onboundary({charIndex: 2, charLength: 5});
        const displayed = fixture.state.audioProgressFor(kind);
        expect(displayed).toEqual({start: 4, end: 9, fraction: 1, estimated: false});
        expect((kind === 'source' ? fixture.state.sourceTextParts : fixture.state.translatedTextParts)[1]).toMatchObject({text: ' hello', offset: 3});
        fixture.state.stopAudioFromUi();
        expect(fixture.state.audioTextOffset).toBe(0);
        expectAudioReset(fixture.state);
    });
});

it('preserves the reading card during its evidence scroll, then resumes ordinary auto dismissal and clears frames on close', async () => {
    const fixture = mountSelection();
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('Node', class {});
    const {state} = fixture;
    fixture.config.selectionTranslatorAutoDismiss = true;
    state.snapshot = {text: 'Practice helps.', range: {getClientRects: () => []}, parts: [{kind: 'text', text: 'Practice helps.'}]};
    state.readingSelection = {text: 'Practice helps.', context: '', sentence: 'Practice helps.'};
    state.readingMode = true;
    state.showTooltip = true;
    const disposeAnchor = vi.fn();
    state.readingEvidenceAnchor = {locate: () => 'located', check: () => 'located', dispose: disposeAnchor, suspend: vi.fn()};
    const citation = {quote: 'Practice helps.', sourceText: 'Practice helps.'};
    expect(state.locateReadingEvidence(citation)).toBe('located');
    state.handleScroll({target: null});
    expect(state.showTooltip).toBe(true);
    expect(disposeAnchor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    state.handleScroll({target: null});
    expect(state.showTooltip).toBe(false);
    expect(disposeAnchor).toHaveBeenCalledOnce();
    expect(state.readingEvidenceScrollFrame).toBeUndefined();

    state.showTooltip = true;
    state.readingMode = true;
    state.readingEvidenceAnchor = {locate: () => 'unavailable'};
    expect(state.locateReadingEvidence(citation)).toBe('unavailable');
    expect(state.readingEvidenceScrollFrame).toBeUndefined();
    state.readingEvidenceAnchor = {locate: () => 'located', dispose: disposeAnchor};
    state.readingSelection = {text: 'Practice helps.', context: '', sentence: 'Practice helps.'};
    expect(state.locateReadingEvidence(citation)).toBe('located');
    fixture.unmount();
    expect(state.readingEvidenceScrollFrame).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
});

it('keeps an existing ordinary translation running when opening the learning view', async () => {
    const fixture = mountSelection();
    fixture.config.harness.enabled = true;
    fixture.state.selectionConfigVersion += 1;
    await Vue.nextTick();
    const pending = new AbortController();
    fixture.state.snapshot = {text: 'Practice helps.', range: {}, parts: [{kind: 'text', text: 'Practice helps.'}]};
    fixture.state.readingSelection = {text: 'Practice helps.', context: '', sentence: 'Practice helps.'};
    fixture.state.activeContentRequest = {text: 'Practice helps.', generation: 1, sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};
    fixture.state.translationAbortController = pending;
    fixture.state.isLoading = true;
    fixture.state.openReadingCard();
    expect(fixture.state.readingMode).toBe(true);
    expect(pending.signal.aborted).toBe(false);
    fixture.unmount();
    expect(pending.signal.aborted).toBe(true);
});


describe('selection card geometry across content changes', () => {
    it('keeps the same card scrollable and its close action owned in a 58px visible viewport', async () => {
        const fixture = mountSelection(false, undefined, 'safari', true);
        const port = fixture.renderPort!;
        vi.stubGlobal('Element', port.domWindow.Element);
        const text = 'Keep the selected source and its answer while the keyboard reduces the viewport.';
        const selected = Vue.markRaw({text, range: {getClientRects: () => []}, parts: [{kind: 'text', text}],
            anchor: {left: 40, right: 280, top: 400, bottom: 424}, isForward: true});
        const controller = new AbortController();
        Object.assign(fixture.state, {snapshot: selected, selectedText: text, showTooltip: true, touchInteraction: true,
            translationResult: '保留已有译文。'.repeat(40), translationAbortController: controller});
        fixture.config.selectionTranslatorAutoDismiss = false;
        await Vue.nextTick();
        const card = port.root.querySelector('.fr-translation-tooltip') as HTMLElement;
        const close = card.querySelector('[aria-label="关闭翻译结果"]')!;
        card.getBoundingClientRect = () => ({left: 12, top: 400, right: 390, bottom: 640, width: 378, height: 240}) as DOMRect;
        fixture.state.tooltipRef = Vue.markRaw(card);
        fixture.state.manualPopupPosition = {left: 12, top: 400};
        Object.assign(fixture.window, {visualViewport: {width: 402, height: 58, offsetLeft: 0, offsetTop: 320}});
        const resize = [...fixture.listeners.get('window:resize')!];
        resize.forEach(listener => listener({}));
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        // Linkedom proves the bounded same-card fallback and actual close action.
        // CSS scrolling and 44px hit geometry require production-browser evidence.
        expect(card.style.getPropertyValue('max-height')).toBe('58px');
        expect(card.classList.contains('fr-short-viewport')).toBe(true);
        expect(card.style.getPropertyValue('top')).toBe('320px');
        expect(port.root.querySelector('.fr-translation-tooltip')).toBe(card);
        expect(card.querySelector('[aria-label="关闭翻译结果"]')).toBe(close);
        expect(card.textContent).toContain(text);
        expect(fixture.state.snapshot).toBe(selected);
        expect(controller.signal.aborted).toBe(false);
        await port.click(close); await Vue.nextTick();
        expect(fixture.state.showTooltip).toBe(false);
        expect(controller.signal.aborted).toBe(true);
        expect(port.root.querySelector('.fr-translation-tooltip')).toBeNull();
        fixture.unmount();
        expect([...fixture.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each([{height: 32, zoom: 1}, {height: 44, zoom: 1}, {height: 58, zoom: 2}])(
        'temporarily bounds a user card without consuming its size or position: %j', async ({height, zoom}) => {
            const fixture = mountSelection();
            await Vue.nextTick();
            const {state, window} = fixture;
            state.tooltipRef = {getBoundingClientRect: () => ({width: 450, height: 240})};
            state.manualPopupPosition = {left: 510, top: 490};
            state.manualPopupSize = {width: 450, height: 240};
            state.pageZoom = zoom;
            Object.assign(window, {visualViewport: {width: 402, height, offsetLeft: 80, offsetTop: 320}});
            state.viewportSize = visualViewport.getSafeVisualViewportRect(window as unknown as Window);
            state.applyManualPopupGeometry();
            expect(state.isShortViewport()).toBe(true);
            expect(parseFloat(state.tooltipStyle.top)).toBe(320);
            expect(parseFloat(state.tooltipStyle.height) * state.popupScale).toBe(height);
            expect(parseFloat(state.tooltipStyle.maxHeight) * state.popupScale).toBe(height);
            // A 32px viewport remains a physical limitation; the action is not reduced to fit.
            expect(state.manualPopupPosition).toEqual({left: 510, top: 490});
            expect(state.manualPopupSize).toEqual({width: 450, height: 240});
            Object.assign(window, {visualViewport: undefined});
            state.viewportSize = visualViewport.getSafeVisualViewportRect(window as unknown as Window);
            state.applyManualPopupGeometry(); await Vue.nextTick();
            expect(state.isShortViewport()).toBe(false);
            expect(state.tooltipStyle).toMatchObject({left: '510px', top: '490px', width: `${450 * zoom}px`, height: `${240 * zoom}px`});
            fixture.unmount();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each([
        {isForward: true, left: 100, right: 150, expected: 222},
        {isForward: false, left: 100, right: 150, expected: 28},
        {isForward: true, left: 350, right: 380, expected: 278},
        {isForward: false, left: 10, right: 100, expected: 172},
        {isForward: true, left: 134, right: 184.85, expected: 256.85},
    ])('leaves Firefox touch caret clearance independently of viewport margin: %j', scenario => {
        const {state, window} = mountSelection(false, undefined, 'firefox');
        Object.assign(window, {visualViewport: {width: 390, height: 500, offsetLeft: 0, offsetTop: 0}});
        state.handleViewportResize();state.touchInteraction = true;
        state.snapshot = {text: 'Selected text.', anchor: {left: scenario.left, right: scenario.right, top: 150, bottom: 174}, isForward: scenario.isForward};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: `${scenario.expected}px`, top: '162px'});
    });
    it.each([true, false])('keeps full-line Firefox touch targets away from both handles for direction %s', isForward => {
        const {state, window} = mountSelection(false, undefined, 'firefox');
        Object.assign(window, {visualViewport: {width: 390, height: 300, offsetLeft: 80, offsetTop: 160}});
        state.handleViewportResize();state.touchInteraction = true;
        state.snapshot = {text: 'Full selected line.', anchor: {left: 80, right: 470, top: 160, bottom: 184}, isForward};
        state.updatePosition(false);
        const x = Number.parseFloat(state.indicatorStyle.left);
        expect(x - 80).toBeGreaterThanOrEqual(72);expect(470 - x).toBeGreaterThanOrEqual(72);
        expect(x - 22).toBeGreaterThanOrEqual(80);expect(x + 22).toBeLessThanOrEqual(470);
        expect(state.indicatorStyle.top).toBe('188px');
    });
    it.each([true, false])('uses the actual Firefox touch endpoint line and scales its gap for direction %s', isForward => {
        const {state} = mountSelection(false, undefined, 'firefox');
        const rects = [{left: 100, right: 230, top: 100, bottom: 124, width: 130, height: 24},
            {left: 100, right: 160, top: 124, bottom: 148, width: 60, height: 24}];
        state.touchInteraction = true;state.pageZoom = 2;
        state.snapshot = {text: 'Two selected lines.', range: {getClientRects: () => rects}, anchor: rects[0], isForward};
        state.updatePosition();
        expect(state.snapshot.anchor).toEqual(isForward ? rects[1] : rects[0]);
        expect(state.indicatorStyle).toEqual(isForward ? {left: '196px', top: '136px'} : {left: '64px', top: '112px'});
    });
    it.each([true, false])('keeps the Firefox mouse entry at its existing offset for direction %s', isForward => {
        const {state} = mountSelection(false, undefined, 'firefox');
        state.snapshot = {text: 'Desktop selection.', anchor: {left: 100, right: 230, top: 100, bottom: 124}, isForward};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: isForward ? '244px' : '86px', top: '138px'});
    });
    it.each([true, false])('preserves visibility without claiming caret clearance in an extremely narrow Firefox viewport: %s', isForward => {
        const {state, window} = mountSelection(false, undefined, 'firefox');
        Object.assign(window, {visualViewport: {width: 96, height: 300, offsetLeft: 0, offsetTop: 0}});
        state.handleViewportResize();state.touchInteraction = true;
        state.snapshot = {text: 'Full selected line.', anchor: {left: 0, right: 96, top: 150, bottom: 174}, isForward};
        state.updatePosition(false);
        const x = Number.parseFloat(state.indicatorStyle.left);
        expect(x).toBe(isForward ? 68 : 28);
        expect(x - 22).toBeGreaterThanOrEqual(0);expect(x + 22).toBeLessThanOrEqual(96);
        // Neither outside side nor a 72px-safe interior exists: visibility is the explicit fallback only.
        expect(Math.min(x, 96 - x)).toBeLessThan(72);
    });
    it('keeps Firefox touch vertical inset independent of its gap above a panned keyboard', () => {
        const {state, window} = mountSelection(false, undefined, 'firefox');
        Object.assign(window, {visualViewport: {width: 390, height: 300, offsetLeft: 80, offsetTop: 160}});
        state.handleViewportResize();state.touchInteraction = true;
        state.snapshot = {text: 'Selected text.', anchor: {left: 210, right: 260, top: 440, bottom: 464}, isForward: true};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: '332px', top: '432px'});
    });
    it.each(['chrome', 'safari', 'userscript'] as const)('preserves the existing %s touch entry gap and viewport inset', target => {
        const {state, window} = mountSelection(false, undefined, target);
        Object.assign(window, {visualViewport: {width: 390, height: 300, offsetLeft: 80, offsetTop: 160}});
        state.handleViewportResize();state.touchInteraction = true;
        state.snapshot = {text: 'Selected text.', anchor: {left: 210, right: 260, top: 440, bottom: 464}, isForward: true};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: '288px', top: '432px'});
    });
    it('keeps a card and its entry within the panned visual viewport above a software keyboard', () => {
        const {state, window} = mountSelection();
        Object.assign(window, {visualViewport: {width: 390, height: 300, offsetLeft: 80, offsetTop: 160}});
        state.handleViewportResize();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 388, height: 240})};
        state.manualPopupPosition = {left: 20, top: 700};
        state.manualPopupSize = {width: 388, height: 240};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '92px', top: '308px', width: '366px', height: '140px', maxHeight: '140px'});
        state.touchInteraction = true;
        state.snapshot = {text: 'A selection.', anchor: {left: 0, top: 0, right: 5, bottom: 5}, isForward: true};
        state.showTooltip = false;
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: '108px', top: '188px'});
    });
    it.each([true, false])('keeps a multiline touch entry beside the actual %s selection endpoint line', isForward => {
        const {state} = mountSelection();
        const rects = [{left: 100, right: 230, top: 100, bottom: 124, width: 130, height: 24},
            {left: 100, right: 160, top: 124, bottom: 148, width: 60, height: 24}];
        state.touchInteraction = true;
        state.snapshot = {text: 'Two selected lines.', range: {getClientRects: () => rects}, anchor: rects[0], isForward};
        state.updatePosition();
        expect(state.snapshot.anchor).toEqual(isForward ? rects[1] : rects[0]);
        expect(state.indicatorStyle).toEqual(isForward ? {left: '188px', top: '136px'} : {left: '72px', top: '112px'});
        // A 44px entry stays beside this line rather than in the native menu band above/below it.
        const x = Number.parseFloat(state.indicatorStyle.left), y = Number.parseFloat(state.indicatorStyle.top);
        const endpoint = state.snapshot.anchor;
        expect(y).toBeGreaterThan(endpoint.top);
        expect(y).toBeLessThan(endpoint.bottom);
        expect(isForward ? x - 22 >= endpoint.right : x + 22 <= endpoint.left).toBe(true);
    });
    it.each([
        {isForward: true, left: 350, right: 380, expectedLeft: '322px'},
        {isForward: false, left: 10, right: 100, expectedLeft: '128px'},
        {isForward: true, left: 100, right: 150, expectedLeft: '178px'},
        {isForward: false, left: 100, right: 150, expectedLeft: '72px'},
        {isForward: true, left: 0, right: 390, expectedLeft: '362px'},
        {isForward: false, left: 0, right: 390, expectedLeft: '28px'},
    ])('uses available line-side space and keeps a full-width selection entry visible: %j', scenario => {
        const {state, window} = mountSelection();
        Object.assign(window, {visualViewport: {width: 390, height: 500, offsetLeft: 0, offsetTop: 0}});
        state.handleViewportResize();
        state.touchInteraction = true;
        state.snapshot = {text: 'Selected text.', anchor: {left: scenario.left, right: scenario.right, top: 150, bottom: 174}, isForward: scenario.isForward};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: scenario.expectedLeft, top: '162px'});
    });
    it.each([
        {anchor: {left: 80, right: 470, top: 160, bottom: 184}, expectedLeft: '442px', expectedTop: '188px'},
        {anchor: {left: 210, right: 260, top: 440, bottom: 464}, expectedLeft: '288px', expectedTop: '432px'},
    ])('clamps a touch entry inside a panned keyboard viewport at vertical edges: %j', scenario => {
        const {state, window} = mountSelection();
        Object.assign(window, {visualViewport: {width: 390, height: 300, offsetLeft: 80, offsetTop: 160}});
        state.handleViewportResize();
        state.touchInteraction = true;
        state.snapshot = {text: 'Selected text.', anchor: scenario.anchor, isForward: true};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: scenario.expectedLeft, top: scenario.expectedTop});
    });
    it.each([true, false])('preserves desktop indicator offset for selection direction %s', isForward => {
        const {state} = mountSelection();
        state.snapshot = {text: 'Desktop selection.', anchor: {left: 100, right: 230, top: 100, bottom: 124}, isForward};
        state.updatePosition(false);
        expect(state.indicatorStyle).toEqual({left: isForward ? '244px' : '86px', top: '138px'});
    });
    it('preserves the opening position across learning tabs and expanding content', async () => {
        const {state} = mountSelection();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 388, height: 180})};
        state.manualPopupPosition = {left: 220, top: 410};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px', maxHeight: '378px'});
        state.readingMode = true;
        await Vue.nextTick();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 388, height: 520})};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px', maxHeight: '378px'});
        state.readingMode = false;
        await Vue.nextTick();
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px'});
    });
    it('preserves a resized card and clamps it only when the viewport shrinks', () => {
        const {state, window} = mountSelection();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 450, height: 240})};
        state.manualPopupPosition = {left: 510, top: 490};
        state.manualPopupSize = {width: 450, height: 240};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '510px', top: '490px', width: '450px', height: '240px'});
        window.innerWidth = 390; window.innerHeight = 400;
        state.handleViewportResize();
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '12px', top: '248px', width: '366px', height: '140px'});
    });
});

describe('Safari and Firefox explicit touch selection consumption', () => {
    function prepare(target: SelectionBuildTarget = 'safari', touch = true, initialText = 'Good ideas deserve attention.') {
        const fixture = mountSelection(false, {acceptsRange: () => true, normalizeText: (text: string) => text}, target, true);
        vi.stubGlobal('Element', class {});vi.stubGlobal('Node', class {});
        let text=initialText;
        const source={isConnected:true,ownerDocument:fixture.document};
        const range=Vue.markRaw({startContainer:source,endContainer:source,startOffset:0,endOffset:text.length,collapsed:false,
            getClientRects:()=>[{left:20,right:210,top:150,bottom:174,width:190,height:24}],
            cloneRange:()=>range,toString:()=>text});
        let cleared=false;
        const removeAllRanges=vi.fn(()=>{cleared=true;});
        const selection={get rangeCount(){return cleared?0:1;},get isCollapsed(){return cleared;},anchorNode:source,anchorOffset:0,
            getRangeAt:()=>range,toString:()=>cleared?'':text,removeAllRanges};
        Object.assign(fixture.window,{getSelection:()=>selection});
        Object.assign(fixture.config,{selectionTranslatorTrigger:'icon',selectionTranslatorDelay:0});
        fixture.state.selectionConfigVersion+=1;
        fixture.state.touchInteraction=touch;
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        const snapshot=fixture.state.snapshot;
        return {...fixture,text,source,range,selection,removeAllRanges,snapshot,
            replaceSelection: (next: string) => {text=next;range.endOffset=next.length;cleared=false;}};
    }
    async function clickEntry(fixture: ReturnType<typeof prepare>) {
        await Vue.nextTick();
        const indicator=fixture.renderPort!.root.querySelector('.fr-selection-indicator');
        expect(indicator).not.toBeNull();await fixture.renderPort!.click(indicator!);await Vue.nextTick();
    }
    async function pointerEntry(fixture: ReturnType<typeof prepare>, type: string, patch: Record<string, unknown> = {}, element?: Element) {
        await Vue.nextTick();
        const entry = element ?? fixture.renderPort!.root.querySelector('.fr-selection-indicator')!;
        expect(entry).not.toBeNull();
        const event = new fixture.renderPort!.domWindow.Event(type, {bubbles: true, cancelable: true});
        Object.defineProperties(event, Object.fromEntries(Object.entries({isTrusted: true, pointerId: 17, pointerType: 'touch',
            isPrimary: true, button: 0, clientX: 180, clientY: 248, ...patch}).map(([key, value]) => [key, {value, configurable: true}])));
        entry.dispatchEvent(event);await Vue.nextTick();return entry;
    }
    describe('Firefox pointer-only explicit entry', () => {
        it('opens on trusted entry down/up without click, consumes the same selection and ignores a following compatibility click', async () => {
            const fixture=prepare('firefox');const snapshot=fixture.state.snapshot;
            const entry=await pointerEntry(fixture,'pointerdown');
            expect(fixture.removeAllRanges).not.toHaveBeenCalled();expect(fixture.state.showTooltip).toBe(false);
            await vi.advanceTimersByTimeAsync(105);
            await pointerEntry(fixture,'pointerup',{clientX:183,clientY:249},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.state.snapshot).toBe(snapshot);
            expect(fixture.state.touchOpenedSelection).toBe(snapshot);expect(fixture.removeAllRanges).toHaveBeenCalledOnce();
            expect(fixture.translateText).toHaveBeenCalledOnce();
            await pointerEntry(fixture,'click',{detail:1},entry);
            expect(fixture.translateText).toHaveBeenCalledOnce();expect(fixture.removeAllRanges).toHaveBeenCalledOnce();
        });
        it.each(['move','cancel','leave','secondary','wrong-id','untrusted','no-down','blur','hide','unmount','new-source','source-change-without-notification','hidden'] as const)
        ('rejects %s before a Firefox touch entry can complete', async reason => {
            const fixture=prepare('firefox');
            const entry=await pointerEntry(fixture,reason==='no-down'?'pointerup':'pointerdown',reason==='untrusted'?{isTrusted:false}:{});
            if(reason==='move')await pointerEntry(fixture,'pointermove',{clientX:210},entry);
            if(reason==='cancel')await pointerEntry(fixture,'pointercancel',{},entry);
            if(reason==='leave')await pointerEntry(fixture,'pointerleave',{},entry);
            if(reason==='secondary')await pointerEntry(fixture,'pointerdown',{isPrimary:false,pointerId:18},entry);
            if(reason==='blur')fixture.state.handleWindowBlur();
            if(reason==='hide')fixture.state.hideAll();
            if(reason==='unmount')fixture.unmount();
            if(reason==='new-source') {fixture.replaceSelection('A new selection source.');fixture.state.applySelection(fixture.state.readSelectionSnapshot());}
            if(reason==='source-change-without-notification')fixture.replaceSelection('The source changed without a selection event.');
            if(reason==='hidden') {Object.assign(fixture.document,{visibilityState:'hidden'});fixture.state.handlePageVisibility();}
            await pointerEntry(fixture,'pointerup',reason==='wrong-id'?{pointerId:18}:{},entry);
            expect(fixture.translateText).not.toHaveBeenCalled();expect(fixture.removeAllRanges).not.toHaveBeenCalled();
            expect(fixture.state.showTooltip).toBe(false);
        });
        it.each(['chrome','safari','userscript'] as const)('leaves %s pointer completion on its existing click path', async target => {
            const fixture=prepare(target);const entry=await pointerEntry(fixture,'pointerdown');
            const stopPropagation=vi.fn();
            await pointerEntry(fixture,'pointerup',{stopPropagation},entry);expect(fixture.state.showTooltip).toBe(false);
            expect(stopPropagation).not.toHaveBeenCalled();
            await clickEntry(fixture);expect(fixture.state.showTooltip).toBe(true);
        });
        it('still opens Firefox through a keyboard click after an abandoned touch', async () => {
            const fixture=prepare('firefox');const entry=await pointerEntry(fixture,'pointerdown');
            await pointerEntry(fixture,'pointerleave',{},entry);
            await pointerEntry(fixture,'click',{detail:0,pointerType:''},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.translateText).toHaveBeenCalledOnce();
        });
        it.each(['touch','mouse','keyboard'] as const)('rejects a moved touch and its compatibility click, then accepts a fresh %s entry', async next => {
            const fixture=prepare('firefox');const entry=await pointerEntry(fixture,'pointerdown');
            // Both points stay inside a44px button; movement must invalidate independently of pointerleave.
            await pointerEntry(fixture,'pointermove',{clientX:195},entry);
            await pointerEntry(fixture,'pointerup',{clientX:195},entry);
            await pointerEntry(fixture,'click',{detail:1,clientX:195},entry);
            expect(fixture.state.showTooltip).toBe(false);expect(fixture.translateText).not.toHaveBeenCalled();
            if(next==='touch') {await pointerEntry(fixture,'pointerdown',{},entry);await pointerEntry(fixture,'pointerup',{},entry);}
            if(next==='mouse') {await pointerEntry(fixture,'pointerdown',{pointerType:'mouse'},entry);await pointerEntry(fixture,'click',{pointerType:'mouse',detail:1},entry);}
            if(next==='keyboard')await pointerEntry(fixture,'click',{pointerType:'',detail:0},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.translateText).toHaveBeenCalledOnce();
        });
        it('does not complete the old entry when the live native Range changes without replacing its saved source', async () => {
            const fixture=prepare('firefox');const entry=await pointerEntry(fixture,'pointerdown');
            const source={isConnected:true,ownerDocument:fixture.document};
            const range={...fixture.range,startContainer:source,endContainer:source,cloneRange:()=>range};
            Object.assign(fixture.selection,{anchorNode:source,getRangeAt:()=>range});
            await pointerEntry(fixture,'pointerup',{},entry);
            expect(fixture.state.showTooltip).toBe(false);expect(fixture.translateText).not.toHaveBeenCalled();
            expect(fixture.removeAllRanges).not.toHaveBeenCalled();
        });
        it('keeps a pointer-opened card and its snapshot when only native selection clearing throws', async () => {
            const fixture=prepare('firefox');fixture.removeAllRanges.mockImplementation(()=>{throw Error('native selection unavailable');});
            const entry=await pointerEntry(fixture,'pointerdown');await pointerEntry(fixture,'pointerup',{},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.state.touchOpenedSelection).toBe(fixture.state.snapshot);
            expect(fixture.translateText).toHaveBeenCalledOnce();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        });
        it('accepts a stationary held Firefox touch when released without an actual cancellation', async () => {
            const fixture=prepare('firefox');const entry=await pointerEntry(fixture,'pointerdown');
            await vi.advanceTimersByTimeAsync(1500);
            expect(fixture.state.showTooltip).toBe(false);expect(fixture.removeAllRanges).not.toHaveBeenCalled();
            await pointerEntry(fixture,'pointerup',{},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.translateText).toHaveBeenCalledOnce();
        });
        it('cancels on actual entry contextmenu without preventing the native menu and permits a fresh touch', async () => {
            const fixture=prepare('firefox');const entry=await pointerEntry(fixture,'pointerdown');
            const menu=new fixture.renderPort!.domWindow.Event('contextmenu',{bubbles:true,cancelable:true});
            entry.dispatchEvent(menu);expect(menu.defaultPrevented).toBe(false);
            await pointerEntry(fixture,'pointerup',{},entry);await pointerEntry(fixture,'click',{detail:1},entry);
            expect(fixture.state.showTooltip).toBe(false);expect(fixture.translateText).not.toHaveBeenCalled();
            await pointerEntry(fixture,'pointerdown',{},entry);await pointerEntry(fixture,'pointerup',{},entry);
            expect(fixture.state.showTooltip).toBe(true);expect(fixture.translateText).toHaveBeenCalledOnce();
        });
    });
    it.each(['safari', 'firefox'] as const)('runs the actual %s touch indicator click, retains its snapshot/language and ignores late empty selectionchange',async target=>{
        const fixture=prepare(target);
        const snapshot=fixture.state.snapshot;
        const direction=fixture.state.effectiveTargetLanguage;
        await clickEntry(fixture);
        expect(fixture.removeAllRanges).toHaveBeenCalledOnce();expect(fixture.selection.rangeCount).toBe(0);
        expect(fixture.state.snapshot).toBe(snapshot);expect(fixture.state.selectedText).toBe(fixture.text);
        expect(fixture.state.manuallyRequestedSelection).toBe(false);expect(fixture.state.effectiveTargetLanguage).toBe(direction);
        expect(fixture.state.touchOpenedSelection).toBe(snapshot);expect(fixture.translateText).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(800);
        fixture.state.lastTrustedSelectionInteractionAt=Date.now();fixture.state.handleSelectionChange({isTrusted:true});
        await vi.advanceTimersByTimeAsync(500);
        expect(fixture.state.showTooltip).toBe(true);expect(fixture.state.snapshot).toBe(snapshot);expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['safari', 'firefox'] as const)('respects the %s Chinese target-language gate and preserves configured reverse direction when enabled',async target=>{
        const fixture=prepare(target,true,'这是一段中文。');fixture.state.openTooltipFromIndicator();
        expect(fixture.state.showTooltip).toBe(false);expect(fixture.removeAllRanges).not.toHaveBeenCalled();
        fixture.config.from='en';fixture.config.selectionTranslatorBidirectional=true;fixture.state.selectionConfigVersion+=1;
        fixture.replaceSelection('这是一段新的中文。');
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());await clickEntry(fixture);
        expect(fixture.state.showTooltip).toBe(true);expect(fixture.state.manuallyRequestedSelection).toBe(false);
        expect(fixture.state.effectiveTargetLanguage).toBe('en');expect(fixture.removeAllRanges).toHaveBeenCalledOnce();
    });
    it.each(['chrome','userscript','desktop','automatic','firefox-desktop','firefox-automatic'] as const)('preserves native selection for %s entry',async mode=>{
        const fixture=prepare(mode.startsWith('firefox-')?'firefox':mode==='chrome'||mode==='userscript'?mode:'safari',mode!=='desktop'&&mode!=='firefox-desktop');
        if(mode==='automatic'||mode==='firefox-automatic')fixture.state.openTooltip();else await clickEntry(fixture);
        expect(fixture.state.showTooltip).toBe(true);expect(fixture.removeAllRanges).not.toHaveBeenCalled();expect(fixture.state.touchOpenedSelection).toBeNull();
    });
    it.each(['safari', 'firefox'] as const)('releases %s touch ownership for new selection/hideAll and still closes when the retained source disconnects',async target=>{
        const fixture=prepare(target);await clickEntry(fixture);
        fixture.replaceSelection('New ideas deserve careful attention.');
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        expect(fixture.state.touchOpenedSelection).toBeNull();expect(fixture.state.showTooltip).toBe(false);
        await clickEntry(fixture);expect(fixture.state.touchOpenedSelection).toBe(fixture.state.snapshot);
        fixture.state.hideAll();expect(fixture.state.touchOpenedSelection).toBeNull();
        fixture.replaceSelection('Fresh ideas deserve careful attention.');fixture.state.applySelection(fixture.state.readSelectionSnapshot());await clickEntry(fixture);
        fixture.source.isConnected=false;fixture.state.scheduleSelectionLoss();
        expect(fixture.state.showTooltip).toBe(false);expect(fixture.state.touchOpenedSelection).toBeNull();
    });
    it.each(['safari', 'firefox'] as const)('does not clear a newer native selection when the %s old entry is clicked', async target => {
        const fixture=prepare(target);fixture.selectedSnapshot('A newer native selection.');
        await clickEntry(fixture);
        expect(fixture.state.showTooltip).toBe(true);expect(fixture.removeAllRanges).not.toHaveBeenCalled();
        expect(fixture.state.touchOpenedSelection).toBeNull();
    });
    it.each(['safari', 'firefox'] as const)('keeps the opened %s card when native removeAllRanges throws and releases ownership on unmount',async target=>{
        const fixture=prepare(target);fixture.removeAllRanges.mockImplementation(()=>{throw Error('native selection unavailable');});
        await clickEntry(fixture);expect(fixture.state.showTooltip).toBe(true);expect(fixture.state.touchOpenedSelection).toBe(fixture.state.snapshot);
        fixture.unmount();expect(fixture.state.touchOpenedSelection).toBeNull();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

/**
 * 同一文档上的组合回归：执行原始 runtime.ts、真实 SFC setup/template 与 modal controller。
 * 仅 WXT 创建宿主、浏览器可信事件/Selection 几何及翻译 provider 是受控端口。
 * Linkedom 提供真实父子连接性、closed ShadowRoot 和异步 MutationObserver；不声称 AVKit/系统菜单实测。
 */
describe('Safari consumed selection and actual runtime host recovery', () => {
    async function prepare() {
        const fixture = mountSelection(false, undefined, 'safari', true, true);
        const port = fixture.renderPort!, document = port.document;
        vi.stubGlobal('Element', port.domWindow.Element);
        vi.stubGlobal('Node', port.domWindow.Node);
        vi.stubGlobal('MutationObserver', port.domWindow.MutationObserver);
        Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible', writable: true});
        const paragraph = document.createElement('p');
        paragraph.textContent = '这是一段需要认真阅读的中文。';
        document.body.appendChild(paragraph);
        const source = paragraph.firstChild!;
        const range = Vue.markRaw({startContainer: source, endContainer: source, commonAncestorContainer: source, startOffset: 0,
            endOffset: paragraph.textContent.length, collapsed: false,
            getClientRects: () => [{left: 20, right: 310, top: 150, bottom: 174, width: 290, height: 24}],
            toString: () => source.textContent!,
            cloneRange: () => Vue.markRaw({...range}),
        });
        let cleared = true;
        const removeAllRanges = vi.fn(() => {cleared = true;});
        const selection = {get rangeCount() {return cleared ? 0 : 1;}, get isCollapsed() {return cleared;},
            anchorNode: source, anchorOffset: 0, containsNode: () => false,
            getRangeAt: () => range, toString: () => cleared ? '' : source.textContent!, removeAllRanges};
        Object.assign(fixture.window, {getSelection: () => selection});
        Object.assign(fixture.config, {on: true, from: 'en', to: 'zh-CN', selectionTranslatorBidirectional: true,
            selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0});
        let resolveTranslation!: (text: string) => void;
        fixture.translateText.mockImplementation(() => new Promise<string>(resolve => {resolveTranslation = resolve;}));
        const host = document.createElement('fluent-read-selection-translator-ui');
        const container = document.createElement('div');
        host.id = 'fluent-read-selection-translator-container';
        host.attachShadow({mode: 'closed'}).appendChild(container);
        port.root = container;
        const createUi = vi.fn(async (_context: unknown, options: {component: unknown; props: Record<string, unknown>}) => {
            expect(options.component).toBe(fixture.component);
            document.body.appendChild(host);
            const instance = fixture.mountActual(options.props, container);
            return {shadowHost: host, mounted: {instance}, remove: vi.fn(() => {fixture.unmount(); host.remove();})};
        });
        const runtimeExports: Record<string, any> = {};
        const runtimeFilename = 'src/features/selection-translation/content/runtime.ts';
        const compiledRuntime = ts.transpileModule(readFileSync(runtimeFilename, 'utf8'), {
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
        }).outputText;
        const runtimePorts: Record<string, unknown> = {
            '@/src/features/selection-translation/ui/SelectionTranslator.vue': {__esModule: true, default: fixture.component},
            '@/src/services/config/store': {config: fixture.config},
            '@/src/platform/shadow-ui': {createVueShadowUi: createUi}, './modalDialogHost': modalDialogHost,
        };
        new Function('require', 'exports', compiledRuntime)((id: string) => {
            if (!(id in runtimePorts)) throw new Error(`Unexpected runtime import: ${id}`);
            return runtimePorts[id];
        }, runtimeExports);
        const runtime = runtimeExports as typeof import('@/src/features/selection-translation/content/runtime');
        const instance = await runtime.mountSelectionTranslator({isInvalid: false} as never);
        const dispatch = (prefix: 'document' | 'window', type: string, event: Record<string, unknown>) => {
            for (const listener of [...fixture.listeners.get(`${prefix}:${type}`) ?? []]) listener(event);
        };
        // 使用组件安装的指针监听器建立快照，随后点击官方模板绑定的入口。
        dispatch('document', 'pointerdown', {isTrusted: true, pointerType: 'touch', button: 0, target: paragraph});
        cleared = false; // 浏览器在按下之后才建立此次新的正文选区。
        dispatch('document', 'pointerup', {isTrusted: true, pointerType: 'touch', button: 0, target: paragraph});
        await vi.advanceTimersByTimeAsync(300);
        await Vue.nextTick();
        const indicator = container.querySelector('.fr-selection-indicator');
        expect(indicator).not.toBeNull();
        await port.click(indicator!);
        await Vue.nextTick();
        expect(removeAllRanges).toHaveBeenCalledOnce();
        expect(selection.rangeCount).toBe(0);
        expect(host.shadowRoot).toBeNull();
        expect(fixture.state.touchOpenedSelection).toBe(fixture.state.snapshot);
        expect(fixture.state.effectiveTargetLanguage).toBe('en');
        expect(fixture.translateText).toHaveBeenCalledOnce();
        return {fixture, document, paragraph, source, host, container, runtime, instance, createUi,
            dispatch, resolveTranslation: (text: string) => resolveTranslation(text)};
    }
    async function settle() {await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();}

    it('restores the same consumed-selection card and runtime instance without another request or target change', async () => {
        const x = await prepare();
        try {
            const snapshot = x.fixture.state.snapshot;
            x.host.remove();
            await settle();
            expect(x.host.isConnected).toBe(true);
            expect(x.host.parentNode).toBe(x.document.body);
            expect(await x.runtime.mountSelectionTranslator()).toBeNull(); // 已挂载入口不创建另一实例。
            expect(x.createUi).toHaveBeenCalledOnce();
            await expect(x.createUi.mock.results[0].value).resolves.toMatchObject({mounted: {instance: x.instance}});
            expect(x.fixture.state.snapshot).toBe(snapshot);
            expect(x.fixture.state.showTooltip).toBe(true);
            expect(x.fixture.state.effectiveTargetLanguage).toBe('en');
            x.resolveTranslation('Read this carefully.');
            await settle();
            expect(x.fixture.state.translationResult).toBe('Read this carefully.');
            expect(x.fixture.translateText).toHaveBeenCalledOnce();
            expect(x.fixture.lifecycleErrors).not.toHaveBeenCalled();
        } finally {x.runtime.unmountSelectionTranslator();}
    });

    it('cleans the invalid consumed source after body replacement and rejects its late translation', async () => {
        const x = await prepare();
        try {
            const replacement = x.document.createElement('body');
            replacement.innerHTML = '<p>A different page source.</p>';
            x.document.body.replaceWith(replacement);
            await settle();
            expect(x.source.isConnected).toBe(false);
            expect(x.host.parentNode).toBe(replacement);
            // Selection 已为空：不伪造 selectionchange/pageshow 来替代实际 host 恢复路径。
            expect(x.fixture.state.showTooltip).toBe(false);
            expect(x.fixture.state.snapshot).toBeNull();
            expect(x.fixture.state.touchOpenedSelection).toBeNull();
            expect(x.fixture.translateText.mock.calls[0][2].signal.aborted).toBe(true);
            x.resolveTranslation('A late answer for the removed source.');
            await settle();
            expect(x.fixture.state.translationResult).toBe('');
            expect(x.container.textContent).not.toContain('A late answer');
            expect(x.createUi).toHaveBeenCalledOnce();
        } finally {x.runtime.unmountSelectionTranslator();}
    });

    it.each(['pagehide', 'unmount'] as const)('does not resurrect the consumed card or late answer after %s', async reason => {
        const x = await prepare();
        try {
            x.host.remove(); // 保留待处理的真实 MutationObserver 记录。
            if (reason === 'pagehide') x.dispatch('window', 'pagehide', {isTrusted: true});
            else x.runtime.unmountSelectionTranslator();
            x.resolveTranslation('A late answer after leaving.');
            await settle();
            expect(x.fixture.state.touchOpenedSelection).toBeNull();
            if (reason === 'pagehide') {
                // 即使 runtime 仍保留空的入口宿主，也不能重新显示已由 pagehide 关闭的卡。
                expect(x.fixture.state.showTooltip).toBe(false);
                expect(x.fixture.state.snapshot).toBeNull();
                expect(x.container.querySelector('.fr-translation-tooltip')).toBeNull();
            } else {
                expect(x.host.isConnected).toBe(false);
                expect(x.container.childNodes).toHaveLength(0);
            }
            expect(x.fixture.state.translationResult).toBe('');
            expect(x.fixture.translateText).toHaveBeenCalledOnce();
            expect(x.createUi).toHaveBeenCalledOnce();
            expect(x.fixture.lifecycleErrors).not.toHaveBeenCalled();
        } finally {x.runtime.unmountSelectionTranslator();}
        await settle();
        expect(x.host.isConnected).toBe(false);
    });
});

describe('native mobile selection and page lifecycle', () => {
    function mobileSelection() {
        const fixture = mountSelection(false, {acceptsRange: () => true, normalizeText: (text: string) => text});
        vi.stubGlobal('Element', class {}); vi.stubGlobal('Node', class {});
        let text = 'Good ideas deserve attention.';
        const source = {isConnected: true, ownerDocument: fixture.document};
        const range = Vue.markRaw({startContainer: source, endContainer: source, collapsed: false, startOffset: 0,
            getClientRects: () => [{left: 20, right: 210, top: 150, bottom: 174, width: 190, height: 24}],
            cloneRange: () => range, toString: () => text});
        Object.assign(fixture.window, {getSelection: () => ({rangeCount: 1, isCollapsed: false,
            anchorNode: source, anchorOffset: 0, getRangeAt: () => range, toString: () => text})});
        Object.assign(fixture.config, {selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0});
        fixture.state.selectionConfigVersion += 1;
        const pointer = {isTrusted: true, pointerType: 'touch', button: 0, target: null};
        return {...fixture, pointer, source, range, setText: (next: string) => {text = next;}};
    }

    it('waits for native long-press and handle adjustment to settle after pointercancel without freezing the range at contextmenu', async () => {
        const fixture = mobileSelection();
        fixture.state.handlePointerDown(fixture.pointer);
        await vi.advanceTimersByTimeAsync(1800);
        fixture.state.handleContextMenu({isTrusted: true, target: null});
        // 系统菜单接管后有些浏览器不再向页面发送 pointerup/pointercancel。
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(200);
        fixture.setText('Good ideas deserve careful attention.');
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(249);
        expect(fixture.state.showIndicator).toBe(false);
        await vi.advanceTimersByTimeAsync(32);
        expect(fixture.state.selectedText).toBe('Good ideas deserve careful attention.');
        expect(fixture.state.showIndicator).toBe(true);
        expect(fixture.state.contextMenuSelection).toBeNull();
        expect(fixture.translateText).not.toHaveBeenCalled();
        fixture.state.openTooltip();
        await Vue.nextTick();
        expect(fixture.translateText).toHaveBeenCalledOnce();
    });

    it('preserves the direct trigger preference but never queries while the finger still owns selection', async () => {
        const fixture = mobileSelection();
        fixture.config.selectionTranslatorTrigger = 'direct';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        const nativeSelection = (fixture.window as any).getSelection;
        (fixture.window as any).getSelection = () => null;
        fixture.state.handlePointerDown(fixture.pointer);
        (fixture.window as any).getSelection = nativeSelection;
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(400);
        expect(fixture.translateText).not.toHaveBeenCalled();
        fixture.state.handlePointerUp(fixture.pointer);
        await vi.advanceTimersByTimeAsync(280);
        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.showTooltip).toBe(true);
    });

    it('rejects a touch menu in an input before considering the previous body Range', async () => {
        const fixture = mobileSelection();
        fixture.state.handlePointerDown(fixture.pointer);
        const target = Object.assign(Object.create(Element.prototype), {closest: () => ({}), getAttribute: () => null});
        fixture.state.handleContextMenu({isTrusted: true, target});
        fixture.state.handlePointerUp({...fixture.pointer, target});
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(400);
        expect(fixture.state.contextMenuSourceRejected).toBe(true);
        expect(fixture.state.showIndicator).toBe(false);
        expect(fixture.contextMenuHandler('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it.each(['untrusted', 'expired', 'closed', 'pagehide', 'unmount'] as const)('does not resurrect a touch selection after %s', async reason => {
        const fixture = mobileSelection();
        fixture.state.handlePointerDown({...fixture.pointer, isTrusted: reason !== 'untrusted'});
        fixture.state.handlePointerCancel(fixture.pointer);
        if (reason === 'expired') {
            await vi.advanceTimersByTimeAsync(30_001);
            // 隐藏之前合法出现的入口，但保留过期的触摸 deadline，验证事件本身不能重新武装。
            fixture.state.showIndicator = false; fixture.state.snapshot = null;
        }
        else if (reason === 'closed') fixture.state.closeTooltip();
        else if (reason === 'pagehide') fixture.state.handlePageHide();
        else if (reason === 'unmount') fixture.unmount();
        if (reason !== 'unmount') fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(400);
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.showIndicator).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('cancels queued automatic display when backgrounded and drops a disconnected source on resume', async () => {
        const fixture = mobileSelection();
        fixture.state.handlePointerDown(fixture.pointer);
        fixture.state.handlePointerUp(fixture.pointer);
        Object.assign(fixture.document, {visibilityState: 'hidden'});
        fixture.state.handlePageVisibility();
        await vi.advanceTimersByTimeAsync(400);
        expect(fixture.state.showIndicator).toBe(false);
        Object.assign(fixture.document, {visibilityState: 'visible'});
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.selectedText = fixture.state.snapshot.text;
        fixture.state.showTooltip = true;
        const controller = new AbortController(); fixture.state.translationAbortController = controller;
        fixture.state.restoreSelectionSource();
        expect(fixture.state.showTooltip).toBe(true);
        fixture.source.isConnected = false;
        fixture.state.restoreSelectionSource();
        expect(fixture.state.showTooltip).toBe(false);
        expect(controller.signal.aborted).toBe(true);
        fixture.unmount();
        expect([...fixture.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['rewritten', 'throwing'] as const)('drops a still-connected %s source on resume', reason => {
        const fixture = mobileSelection();
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.showTooltip = true;
        if (reason === 'rewritten') fixture.setText('The source changed in the background.');
        else fixture.range.toString = () => {throw new Error('source invalidated');};
        expect(() => fixture.state.restoreSelectionSource()).not.toThrow();
        expect(fixture.state.showTooltip).toBe(false);
    });

    it('preserves a cross-paragraph Selection with different Range serialization until the actual Range text changes', () => {
        const fixture = mobileSelection();
        const nativeText = 'First paragraph.\n\nSecond paragraph.';
        let rangeText = 'First paragraph.Second paragraph.';
        fixture.setText(nativeText);
        fixture.range.toString = () => rangeText;
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        expect(fixture.state.snapshot).toMatchObject({nativeText, text: nativeText, rangeText});
        fixture.state.showTooltip = true;
        fixture.state.restoreSelectionSource();
        expect(fixture.state.showTooltip).toBe(true);
        rangeText = 'First paragraph.The source changed.';
        fixture.state.restoreSelectionSource();
        expect(fixture.state.showTooltip).toBe(false);
    });
});

describe('automatic card audio layout', () => {
    async function audioCard() {
        const fixture = mountSelection();
        const cardRect = vi.fn(() => ({width: 388, height: 180}));
        fixture.state.tooltipRef = {getBoundingClientRect: cardRect};
        fixture.state.snapshot = {text: 'Practice helps.', range: {getClientRects: vi.fn(() => [])}};
        fixture.state.selectedText = 'Practice helps.';
        fixture.state.manualPopupPosition = {left: 200, top: 100};
        fixture.state.showTooltip = true;
        await Vue.nextTick(); await Vue.nextTick();
        fixture.state.applyManualPopupGeometry();
        return {...fixture, cardRect};
    }

    it.each(['source', 'word'] as const)('keeps the automatic %s card at natural height through preparation playback and stop', async kind => {
        const fixture = await audioCard(), response = deferredTts();
        prepareTts(fixture, [response.promise]);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        const pending = kind === 'word' ? fixture.state.toggleWordAudio({text: 'Practice helps.'})
            : fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px'});
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        const capturedReads = fixture.cardRect.mock.calls.length;
        response.resolve({success: true, transport: 'offscreen'}); await pending;
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        for (let index = 0; index < 20; index++) emitTtsState(fixture, clientRequestId, 'progress', {
            progress: {start: 0, end: 8, fraction: index / 20, estimated: true},
        });
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.cardRect).toHaveBeenCalledTimes(capturedReads);
        fixture.state.stopAudioFromUi();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        expect(fixture.state.manualPopupPosition).toEqual({left: 200, top: 100});
    });

    it.each(['ended', 'stopped', 'error'] as const)('keeps natural height and ignores another audio owner before matching %s', async terminal => {
        const fixture = await audioCard();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        emitTtsState(fixture, 'another-card', terminal, {error: 'Unrelated error'});
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        emitTtsState(fixture, clientRequestId, terminal, {error: 'Controlled decode failure'});
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
    });

    it('keeps replacement speech at natural height when the previous synthesis finishes late', async () => {
        const fixture = await audioCard(), oldResponse = deferredTts(), replacement = deferredTts();
        prepareTts(fixture, [oldResponse.promise, replacement.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('New sentence.', 'source');
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        oldResponse.resolve({success: true, transport: 'offscreen'}); await oldPending;
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        replacement.resolve({success: true, transport: 'offscreen'}); await newPending;
        emitTtsState(fixture, ttsMessages(fixture, 'selectionTts')[0].clientRequestId, 'ended');
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
    });

    it('keeps an existing user size authoritative through preparation playback and stop', async () => {
        const fixture = await audioCard(), response = deferredTts();
        fixture.state.manualPopupSize = {width: 450, height: 240};
        fixture.state.applyManualPopupGeometry();
        fixture.cardRect.mockClear();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.tooltipStyle.height).toBe('240px');
        response.resolve({success: true, transport: 'offscreen'}); await pending;
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '450px', height: '240px'});
        expect(fixture.state.manualPopupSize).toEqual({width: 450, height: 240});
        expect(fixture.cardRect).not.toHaveBeenCalled();
    });

    it.each(['stop', 'hide', 'unmount', 'failure'] as const)('does not fix automatic card height after %s or its late response', async reason => {
        const fixture = await audioCard(), response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        if (reason === 'stop') fixture.state.stopAudio();
        else if (reason === 'hide') fixture.state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        response.resolve(reason === 'failure' ? {success: false, error: 'Controlled synthesis failure', errorCode: 'local-only-error'}
            : {success: true, transport: 'offscreen'});
        await pending; await Vue.nextTick();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        expect(fixture.state.isPlaying).toBe(false);
    });

    it('bounds the automatic audio card by the smaller viewport without fixing its height', async () => {
        const fixture = await audioCard();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        fixture.window.innerHeight = 180;
        fixture.state.handleViewportResize();
        await vi.advanceTimersByTimeAsync(20);
        const top = parseFloat(fixture.state.tooltipStyle.top), maxHeight = parseFloat(fixture.state.tooltipStyle.maxHeight);
        expect(top).toBeGreaterThanOrEqual(12);
        expect(maxHeight).toBeGreaterThan(0);
        expect(top + maxHeight).toBeLessThanOrEqual(168);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
    });

    it.each([false, true])('keeps natural audio height across short viewport entry and recovery (starts short: %s)', async startsShort => {
        const fixture = await audioCard();
        const {state, window} = fixture;
        const short = () => {
            Object.assign(window, {visualViewport: {width: 402, height: 58, offsetLeft: 0, offsetTop: 320}});
            state.handleViewportResize();
        };
        if (startsShort) short();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await state.toggleAudio('Practice helps.', 'source');
        if (!startsShort) short();
        await vi.advanceTimersByTimeAsync(32);
        expect(state.isPlaying).toBe(true);
        expect(state.tooltipStyle.height).toBeUndefined();
        expect(state.manualPopupSize).toBeNull();
        expect(state.tooltipStyle).toMatchObject({top: '320px', maxHeight: '58px'});
        Object.assign(window, {visualViewport: undefined});
        state.handleViewportResize(); await vi.advanceTimersByTimeAsync(32);
        expect(state.manualPopupPosition).toEqual({left: 200, top: 100});
        expect(state.tooltipStyle.height).toBeUndefined();
        state.stopAudio(); fixture.unmount();
        expect(state.tooltipStyle.height).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('context menu selection ownership', () => {
    async function prepareMenu(browserTarget: SelectionBuildTarget = 'chrome') {
        const fixture = mountSelection(false, undefined, browserTarget);
        class FakeElement {}
        class FakeNode {}
        vi.stubGlobal('Element', FakeElement);
        vi.stubGlobal('Node', FakeNode);
        let nativeText = 'Good ideas deserve attention.';
        const paragraph = {nodeType: 1, tagName: 'P', parentElement: null,
            getAttribute: () => null, hasAttribute: () => false, closest: () => null,
            querySelector: () => null, querySelectorAll: () => []};
        const node = {nodeType: 3, parentElement: paragraph, isConnected: true, ownerDocument: fixture.document};
        const range = Vue.markRaw({startContainer: node, endContainer: node, commonAncestorContainer: node,
            startOffset: 0, endOffset: nativeText.length, collapsed: false,
            getClientRects: vi.fn(() => [{left: 200, right: 380, top: 250, bottom: 270, width: 180, height: 20}]),
            cloneRange: () => range, toString: () => nativeText});
        const selection = {rangeCount: 1, isCollapsed: false, anchorNode: node, anchorOffset: 0,
            getRangeAt: () => range, toString: () => nativeText};
        const getSelection = vi.fn((): typeof selection | null => selection);
        Object.assign(fixture.window, {getSelection});
        fixture.config.selectionTranslatorTrigger = 'contextMenu';
        fixture.config.selectionTranslatorDelay = 9000;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        const rightDown = () => fixture.state.handlePointerDown({isTrusted: true, button: 2, target: null});
        const openMenu = () => {rightDown(); fixture.state.handleContextMenu({isTrusted: true, target: null});};
        const inputTarget = Object.assign(new FakeElement(), {closest: () => ({}), getAttribute: () => null});
        const uiTarget = Object.assign(new FakeNode(), {getRootNode: () => fixture.document});
        return {...fixture, node, paragraph, range, getSelection, rightDown, openMenu, selection,
            inputTarget, uiTarget, setText: (text: string) => {nativeText = text;}};
    }

    it('forwards the browser-bound text through the bridge without retaining a replaced handler', () => {
        const first = vi.fn(() => false), second = vi.fn(() => true);
        const releaseFirst = setSelectionContextMenuHandler(first);
        const releaseSecond = setSelectionContextMenuHandler(second);
        releaseFirst();
        expect(translateSelectionThroughBridge('Good ideas deserve attention.')).toBe(true);
        expect(second).toHaveBeenCalledWith('Good ideas deserve attention.');
        expect(first).not.toHaveBeenCalled();
        releaseSecond();
        expect(translateSelectionThroughBridge('Good ideas deserve attention.')).toBe(false);
    });

    it.each(['chrome', 'userscript'] as const)('registers and cleans native listeners only for the extension target %s while keeping its live-selection bridge', browserTarget => {
        const fixture = mountSelection(false, undefined, browserTarget);
        expect(fixture.registerContextMenu).toHaveBeenCalledOnce();
        expect(fixture.listeners.get('document:contextmenu')?.size ?? 0).toBe(browserTarget === 'chrome' ? 1 : 0);
        fixture.unmount();
        expect(fixture.listeners.get('document:contextmenu')?.size ?? 0).toBe(0);
        expect(fixture.document.removeEventListener.mock.calls.some(([type]) => type === 'contextmenu')).toBe(browserTarget === 'chrome');
        expect(fixture.releaseContextMenu).toHaveBeenCalledOnce();
    });

    it('keeps userscript right-click dismissal and its live-selection message bridge without native menu capture or suppressed ownership', async () => {
        const fixture = await prepareMenu('userscript');
        fixture.config.selectionTranslatorTrigger = 'icon';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.translateText.mockImplementation(() => new Promise(() => {}));
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        fixture.state.openTooltip();
        const firstController = fixture.state.translationAbortController;
        fixture.rightDown();
        expect(firstController.signal.aborted).toBe(true);
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.snapshot).toBeNull();
        expect(fixture.state.suppressSelectionUntil).toBe(0);
        expect(fixture.state.contextMenuSelection).toBeNull();
        expect(fixture.contextMenuHandler('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        expect(fixture.state.showTooltip).toBe(true);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.contextMenuHandler('Good ideas deserve attention.')).toBe(false);
        fixture.state.applySelection(null);
        await vi.advanceTimersByTimeAsync(161);
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.contextMenuSourceRejected).toBe(false);
    });

    it('restores only the menu-captured Range after selection collapse and blur, without waiting for configured delay', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        fixture.state.handleWindowBlur();
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(200);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.state.translateSelectionFromContextMenu('  Good  ideas deserve attention.  ')).toBe(true);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('这是译文');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('cancels a pending direct-mode presentation before a native menu collapses Selection', async () => {
        const fixture = await prepareMenu();
        fixture.config.selectionTranslatorTrigger = 'direct';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        expect(fixture.state.selectionPresentationTimer).not.toBeNull();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(9001);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.state.selectionPresentationTimer).toBeNull();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('cancels an existing entry dismissal and rejects new pointer dismissal while the native menu owns Selection', async () => {
        const fixture = await prepareMenu();
        fixture.config.selectionTranslatorTrigger = 'dot';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.config.selectionTranslatorAutoDismiss = true;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        const pointer = {isTrusted: true, pointerType: 'mouse', clientX: 900, clientY: 750, target: null};
        fixture.state.handlePointerMove(pointer);
        expect(fixture.state.entryDismissTimer).not.toBeNull();
        fixture.openMenu();
        expect(fixture.state.entryDismissTimer).toBeNull();
        fixture.state.handlePointerMove(pointer);
        expect(fixture.state.entryDismissTimer).toBeNull();
        fixture.getSelection.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(601);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('keeps an in-flight request intact through repeated right clicks and duplicate menu commands', async () => {
        const fixture = await prepareMenu();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        const controller = fixture.state.translationAbortController;
        const request = fixture.state.activeContentRequest;
        fixture.openMenu();
        expect(controller.signal.aborted).toBe(false);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.state.activeContentRequest).toBe(request);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        finish('好想法值得关注。'); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('好想法值得关注。');
        expect(controller.signal.aborted).toBe(false);
    });

    it('reuses a completed card, then starts a fresh request after explicit dismissal', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        await Vue.nextTick();
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        expect(fixture.state.translationResult).toBe('这是译文');
        fixture.state.closeTooltip();
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
    });

    it('uses the captured geometry at command time instead of measuring the host selection again', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.range.getClientRects.mockClear();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.range.getClientRects).not.toHaveBeenCalled();
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('lets another explicit menu command retry a failed translation without discarding the selected text', async () => {
        const fixture = await prepareMenu();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        fixture.translateText.mockRejectedValueOnce(new Error('fixture request failure'));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        await Vue.nextTick();
        expect(fixture.state.error).toBe('翻译失败，请重试');
        expect(fixture.state.showTooltip).toBe(true);
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        await Vue.nextTick();
        expect(fixture.state.error).toBe('');
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('replaces an old request only when a different menu selection is explicitly translated and ignores its late response', async () => {
        const fixture = await prepareMenu();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        const previousController = fixture.state.translationAbortController;
        fixture.setText('New ideas deserve a chance.');
        fixture.openMenu();
        expect(previousController.signal.aborted).toBe(false);
        fixture.state.translateSelectionFromContextMenu('New ideas deserve a chance.');
        expect(previousController.signal.aborted).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        await Vue.nextTick();
        finish('旧选区的迟到结果'); await Vue.nextTick();
        expect(fixture.state.selectedText).toBe('New ideas deserve a chance.');
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('keeps an explicitly opened card when a later Selection change only clears the page highlight', async () => {
        const fixture = await prepareMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        fixture.getSelection.mockReturnValue(null);
        fixture.state.applySelection(null);
        await vi.advanceTimersByTimeAsync(200);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('rejects a browser text mismatch instead of translating a different live selection or stale menu capture', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('A different sentence.')).toBe(false);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('A different sentence.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('never turns a bare browser text or untrusted contextmenu event into a translatable selection', async () => {
        const fixture = await prepareMenu();
        fixture.state.handleContextMenu({isTrusted: false, target: null});
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('returns a missing selection response when the host Range becomes unreadable instead of throwing from the menu handler', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.range.toString = () => {throw new Error('fixture disposed range');};
        fixture.getSelection.mockImplementation(() => {throw new Error('fixture disposed document');});
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('does not capture protected input text for a later browser text fallback', async () => {
        const fixture = await prepareMenu();
        fixture.paragraph.tagName = 'INPUT';
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('rejects a menu opened in an input even when document Selection retains identical text from the page', async () => {
        const fixture = await prepareMenu();
        fixture.state.handleContextMenu({isTrusted: true, target: fixture.inputTarget});
        fixture.state.handleWindowBlur();
        expect(fixture.state.readSelectionSnapshot()).not.toBeNull();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('invalidates a previous page capture when a trusted menu opens inside the card without cancelling its translation', async () => {
        const fixture = await prepareMenu();
        fixture.translateText.mockImplementation(() => new Promise(() => {}));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        const controller = fixture.state.translationAbortController;
        fixture.document.getElementById.mockReturnValue(fixture.uiTarget as any);
        fixture.state.handleContextMenu({isTrusted: true, target: fixture.uiTarget});
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.state.contextMenuSelection).toBeNull();
        expect(controller.signal.aborted).toBe(false);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('allows a contenteditable=false text island while rejecting inherited editable targets', async () => {
        const fixture = await prepareMenu();
        const editableParent = {getAttribute: () => 'true', parentElement: null};
        const target = Object.assign(Object.create(Object.getPrototypeOf(fixture.inputTarget)), {
            closest: () => null, getAttribute: () => 'false', parentElement: editableParent,
        });
        expect(fixture.state.isContextMenuInputTarget(target)).toBe(false);
        target.getAttribute = () => null;
        expect(fixture.state.isContextMenuInputTarget(target)).toBe(true);
    });

    it.each(['disconnected', 'foreign-document', 'collapsed', 'text-changed', 'protected'] as const)(
        'rechecks captured source ownership and rejects %s ranges', async reason => {
            const fixture = await prepareMenu();
            fixture.openMenu();
            if (reason === 'disconnected') fixture.node.isConnected = false;
            else if (reason === 'foreign-document') fixture.node.ownerDocument = {} as typeof fixture.document;
            else if (reason === 'collapsed') fixture.range.collapsed = true;
            else if (reason === 'text-changed') fixture.setText('A new sentence in the same node.');
            else fixture.paragraph.tagName = 'TEXTAREA';
            expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
            expect(fixture.translateText).not.toHaveBeenCalled();
        },
    );

    it.each(['pointer', 'escape', 'scroll', 'close'] as const)('discards a menu capture after a new %s interaction', async reason => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        if (reason === 'pointer') fixture.state.handlePointerDown({isTrusted: true, button: 0, target: null});
        else if (reason === 'escape') fixture.state.handleKeydown({isTrusted: true, key: 'Escape', target: null});
        else if (reason === 'scroll') fixture.state.handleScroll({target: null});
        else fixture.state.closeTooltip();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });
});

describe('selection card on an extension PDF page', () => {
    it.each([
        ['native', false], ['native', true], ['document', false], ['document', true],
    ] as const)('validates %s PDF source on result delivery when changed=%s', async (kind, changed) => {
        const {createNativePdfSelectionAdapter} = await vi.importActual<typeof import('@/src/app/selection/page')>('@/src/app/selection/page');
        const {createPdfSelectionAdapter} = await vi.importActual<typeof import('@/src/app/document-translation/selectionRuntime')>('@/src/app/document-translation/selectionRuntime');
        let adapter: {acceptsRange(range: Range): boolean};
        const fixture = mountSelection(false, {acceptsRange: (range: Range) => adapter.acceptsRange(range)}, 'chrome', true);
        const text = 'A selected PDF source passage.';
        const selected = fixture.selectedSnapshot(text, (parent, source) => {
            if (kind === 'native') adapter = createNativePdfSelectionAdapter(source,
                {text, sourceUrl: 'https://example.test/file.pdf', title: 'Fixture'}, () => true);
            else {
                parent.setAttribute('data-fluentread-pdf-text', '');
                adapter = createPdfSelectionAdapter((fixture.document as unknown as Document).body);
            }
        });
        fixture.state.snapshot = selected;
        fixture.state.selectedText = text;
        fixture.state.showTooltip = true;
        let resolve!: (value: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise<string>(done => {resolve = done;}));
        fixture.state.requestSelectionContent(text);
        Object.assign(fixture.window, {getSelection: () => null});
        if (changed) selected.range.startContainer.nodeValue = 'The PDF source changed.';
        resolve('PDF translation.');
        await Promise.resolve(); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe(changed ? '' : 'PDF translation.');
        expect(fixture.state.showTooltip).toBe(!changed);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    function preparePdf() {
        const acceptsRange = vi.fn(() => true);
        const context = vi.fn(() => ({text: 'The Transformer uses attention.', title: 'Attention Is All You Need', sourceUrl: 'https://arxiv.org/pdf/1706.03762'}));
        const captureReading = vi.fn(() => ({text: 'Transformer models', context: 'The Transformer uses attention.', sentence: 'The Transformer uses attention.'}));
        const captureMaterial = vi.fn((_range: Range, _quote: string): MaterialSelection | undefined => undefined);
        let invalidate = () => {};
        const unsubscribeSource = vi.fn();
        const extractText = vi.fn((_range: Range, text: string) => text);
        const fixture = mountSelection(false, {acceptsRange, extractText, normalizeText: (text: string) => text.replace(/\s+/g, ' ').trim(), context, captureReading, captureMaterial,
            subscribeInvalidation: (listener: () => void) => {invalidate = listener; return unsubscribeSource;}});
        class FakeElement {}
        class FakeNode {}
        vi.stubGlobal('Element', FakeElement);
        vi.stubGlobal('Node', FakeNode);
        const start = {isConnected: true, ownerDocument: fixture.document}, end = {isConnected: true, ownerDocument: fixture.document};
        const range = {startContainer: start, endContainer: end, startOffset: 0, endOffset: 18,
            getClientRects: () => [{left: 200, right: 380, top: 250, bottom: 270, width: 180, height: 20}],
            cloneRange: () => range};
        Vue.markRaw(range); // 原生 Range 不被 Vue 代理，测试对象也保持相同身份规则。
        Object.assign(fixture.window, {getSelection: () => ({rangeCount: 1, isCollapsed: false,
            anchorNode: start, anchorOffset: 0, getRangeAt: () => range, toString: () => 'Transformer\nmodels'})});
        fixture.config.selectionTranslatorTrigger = 'direct';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.state.selectionConfigVersion += 1;
        return {...fixture, acceptsRange, extractText, context, captureReading, captureMaterialSelection: captureMaterial, range, unsubscribeSource, invalidate: () => invalidate()};
    }

    it('only captures an adapter-approved source range and normalizes PDF wraps in the snapshot', () => {
        const fixture = preparePdf();
        fixture.acceptsRange.mockReturnValue(false);
        expect(fixture.state.readSelectionSnapshot()).toBeNull();
        expect(fixture.extractText).not.toHaveBeenCalled();
        fixture.acceptsRange.mockReturnValue(true);
        expect(fixture.state.readSelectionSnapshot()).toMatchObject({text: 'Transformer models', parts: [{kind: 'text', text: 'Transformer models'}]});
        expect(fixture.extractText).toHaveBeenCalledWith(fixture.range, 'Transformer\nmodels');
        fixture.extractText.mockReturnValue('First page footer.\nSecond page title.');
        expect(fixture.state.readSelectionSnapshot()).toMatchObject({text: 'First page footer. Second page title.'});
    });

    it('waits for pointer release and sends PDF context through the existing translation client', async () => {
        const fixture = preparePdf();
        const getSelection = (fixture.window as any).getSelection;
        (fixture.window as any).getSelection = () => null;
        fixture.state.handlePointerDown({isTrusted: true, button: 0, target: null});
        (fixture.window as any).getSelection = getSelection;
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(100);
        expect(fixture.translateText).not.toHaveBeenCalled();
        fixture.state.handlePointerUp({isTrusted: true, button: 0, target: null});
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(fixture.translateText).toHaveBeenCalledWith('Transformer models', 'Attention Is All You Need', expect.objectContaining({
            pageContext: 'The Transformer uses attention.', signal: expect.any(AbortSignal),
        }));
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('aborts source requests and ignores late translations after the source owner invalidates', async () => {
        const fixture = preparePdf();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.selectedText = 'Transformer models';
        const request = fixture.state.beginSelectionContentRequest('Transformer models');
        const pending = fixture.state.requestTranslation(request);
        const controller = fixture.state.translationAbortController;
        fixture.acceptsRange.mockReturnValue(false);
        fixture.invalidate();
        expect(controller.signal.aborted).toBe(true);
        expect(fixture.state.snapshot).toBeNull();
        finish('旧文件的迟到译文'); await pending;
        expect(fixture.state.translationResult).toBe('');
        fixture.unmount();
        expect(fixture.unsubscribeSource).toHaveBeenCalledOnce();
    });

    it('uses the adapter for PDF reading and vocabulary source metadata', async () => {
        const fixture = preparePdf();
        const selection: MaterialSelection = {source: {kind: 'document', fingerprint: 'raw-file-fingerprint', title: 'Attention Is All You Need'},
            locator: {kind: 'document', page: 3, quote: 'The Transformer uses attention.'}};
        fixture.captureMaterialSelection.mockReturnValue(selection);
        fixture.config.harness.enabled = true;
        fixture.config.vocabularyBookEnabled = true;
        fixture.state.selectionConfigVersion += 1;
        // 浏览器用户操作发生在配置通知和首次挂载更新之后，先等这一轮配置归属稳定。
        await Vue.nextTick();
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.selectedText = 'Transformer models';
        const request = fixture.state.beginSelectionContentRequest('Transformer models');
        fixture.state.translationAnswer = {...request, answer: '模型'};
        fixture.state.translationResult = '模型';
        fixture.state.openReadingCard();
        expect(fixture.captureReading).toHaveBeenCalled();
        expect(fixture.state.readingSelection.context).toBe('The Transformer uses attention.');
        expect(fixture.captureMaterialSelection).toHaveBeenCalledWith(fixture.range, 'The Transformer uses attention.');
        expect(fixture.material.captureMaterialSelection).not.toHaveBeenCalled();
        expect(fixture.state.readingSelection.material).toEqual(selection);
        expect(fixture.materialCapture).not.toHaveBeenCalled();
        fixture.browser.runtime.sendMessage.mockResolvedValue({success: true, data: {id: 'saved'}});
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action: 'upsert', input: expect.objectContaining({context: expect.objectContaining({
            text: 'The Transformer uses attention.', sourceUrl: 'https://arxiv.org/pdf/1706.03762', pageTitle: 'Attention Is All You Need',
        })})}));
        expect(fixture.materialCapture).toHaveBeenCalledWith(expect.objectContaining({...selection, generation: 17,
            reference: {kind: 'vocabulary', id: 'saved', excerpt: 'Transformer models'}}));
    });
});

it('相同译文隐藏后，切换选区与不同结果仍恢复显示', async () => {
    const {state, lifecycleErrors} = mountSelection();
    state.selectedText = 'Café'; state.translationResult = 'Cafe\u0301'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(false);
    state.translationResult = '咖啡馆'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(true);
    state.selectedText = '咖啡馆'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(false);
    expect(lifecycleErrors).not.toHaveBeenCalled();
});


describe('selection card bounded layout work', () => {
    async function gestureFixture(edge = '') {
        const fixture = mountSelection();
        const frames = new Map<number, FrameRequestCallback>();
        let frameId = 0;
        fixture.window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.set(++frameId, callback); return frameId;
        }) as any;
        fixture.window.cancelAnimationFrame = vi.fn((id: any) => {frames.delete(id);});
        class GestureElement {
            dataset = {resizeEdge: edge};
            clientLeft = 0;
            clientWidth = 388;
            captured = false;
            getBoundingClientRect = vi.fn(() => ({left: 200, top: 100, right: 588, bottom: 340, width: 388, height: 240}));
            closest(selector: string) {return selector === '.fr-study-navigation' ? this : null;}
            matches(selector: string) {return selector === '.fr-study-navigation';}
            setPointerCapture() {this.captured = true;}
            hasPointerCapture() {return this.captured;}
            releasePointerCapture() {this.captured = false;}
        }
        vi.stubGlobal('HTMLElement', GestureElement);
        const element = new GestureElement();
        fixture.state.tooltipRef = element;
        fixture.state.snapshot = {text: 'Practice helps.', range: {getClientRects: vi.fn(() => [])}};
        fixture.state.showTooltip = true;
        fixture.state.manualPopupPosition = {left: 200, top: 100};
        await Vue.nextTick();
        const pointer = (type: string, x: number, y: number, pointerId = 1) => ({
            type, isTrusted: true, isPrimary: true, button: 0, pointerId, clientX: x, clientY: y,
            target: element, preventDefault: vi.fn(), stopPropagation: vi.fn(),
        });
        fixture.state.beginPopupGesture(pointer('pointerdown', 205, 110));
        const flush = () => {const pending = [...frames.values()];frames.clear();pending.forEach(callback => callback(0));};
        return {...fixture, element, frames, pointer, flush};
    }

    it('leaves short-card touch pans native instead of capturing a title drag, then restores normal dragging', async () => {
        const {state, window, element, pointer, frames} = await gestureFixture();
        state.stopPopupGesture();
        window.innerHeight = 58;
        state.handleViewportResize();
        const down = {...pointer('pointerdown', 205, 110), pointerType: 'touch'};
        state.beginPopupGesture(down);
        state.movePopupGesture({...pointer('pointermove', 205, 70), pointerType: 'touch'});
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(element.captured).toBe(false);
        expect(state.popupManipulating).toBe(false);
        expect(frames.size).toBe(1); // the viewport update, not a captured gesture
        window.innerHeight = 800;
        state.handleViewportResize();
        const normal = {...pointer('pointerdown', 205, 110), pointerType: 'touch'};
        state.beginPopupGesture(normal);
        expect(normal.preventDefault).toHaveBeenCalledOnce();
        expect(element.captured).toBe(true);
        expect(state.popupManipulating).toBe(true);
    });

    it.each([
        ['horizontal tab scrollbar', 'fr-study-toolbar', 300, 132],
        ['learning menu blank space', 'fr-reading-tool-list', 250, 145],
        ['vertical learning menu scrollbar', 'fr-reading-tool-list', 380, 175],
    ] as const)('keeps native %s pointer handling without dragging the card', async (_label, className, x, y) => {
        const {state, element, frames, pointer} = await gestureFixture();
        state.stopPopupGesture();
        element.getBoundingClientRect.mockClear();
        // 非交互导航后代仍属于顶栏，但滚动条与菜单空白必须保留原生指针行为。
        const target = Object.assign(Object.create(Object.getPrototypeOf(element)), {
            dataset: {},
            matches: (selector: string) => selector.split(',').some(part => part.trim() === `.${className}`),
            closest: (selector: string) => selector === '.fr-study-navigation' ? element : null,
        });
        const down = {...pointer('pointerdown', x, y), target};
        state.beginPopupGesture(down);
        state.movePopupGesture({...pointer('pointermove', x + 30, y + 20), target});
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(element.captured).toBe(false);
        expect(state.popupManipulating).toBe(false);
        expect(state.manualPopupPosition).toEqual({left: 200, top: 100});
        expect(frames.size).toBe(0);
        expect(element.getBoundingClientRect).not.toHaveBeenCalled();
    });

    it('coalesces trusted pointer moves and paints only the last point without re-reading card geometry', async () => {
        const {state, element, frames, pointer, flush} = await gestureFixture();
        for (let i = 1; i <= 30; i++) state.movePopupGesture(pointer('pointermove', 205 + i, 110 + i));
        expect(frames.size).toBe(1);
        expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
        expect(state.manualPopupPosition).toEqual({left: 200, top: 100});
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '230px', top: '130px'});
        expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(0);
    });

    it.each(['fr-tooltip-content', 'fr-text-block', 'fr-popup-resize-handle'])('preserves touch pan on %s without starting card manipulation', async className => {
        const {state, element, pointer} = await gestureFixture();
        state.stopPopupGesture();
        const target = Object.assign(Object.create(Object.getPrototypeOf(element)), {
            dataset: {resizeEdge: className === 'fr-popup-resize-handle' ? 'se' : ''},
            matches: (selector: string) => selector.split(',').some(part => part.trim() === `.${className}`),
            closest: () => null,
        });
        const event = {...pointer('pointerdown', 250, 150), target, pointerType: 'touch'};
        state.beginPopupGesture(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(state.popupManipulating).toBe(false);
        expect(element.captured).toBe(false);
    });

    it('flushes the final accepted pointer point on release and rejects a late cancelled animation frame', async () => {
        const {state, element, frames, pointer} = await gestureFixture('se');
        state.movePopupGesture(pointer('pointermove', 255, 145));
        const lateFrame = [...frames.values()][0];
        state.stopPopupGesture(pointer('pointerup', 255, 145));
        expect(state.manualPopupSize).toEqual({width: 438, height: 275});
        expect(state.tooltipStyle).toMatchObject({width: '438px', height: '275px'});
        expect(element.captured).toBe(false);
        expect(frames.size).toBe(0);
        const settled = {...state.tooltipStyle};
        lateFrame(0);
        expect(state.tooltipStyle).toEqual(settled);
    });

    it('lets a real resize set the user size during audio and preserves it after audio stops', async () => {
        const fixture = await gestureFixture('se');
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        fixture.state.movePopupGesture(fixture.pointer('pointermove', 255, 145));
        fixture.state.stopPopupGesture(fixture.pointer('pointerup', 255, 145));
        expect(fixture.state.manualPopupSize).toEqual({width: 438, height: 275});
        expect(fixture.state.tooltipStyle.height).toBe('275px');
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '438px', height: '275px'});
        expect(fixture.state.manualPopupSize).toEqual({width: 438, height: 275});
    });

    it.each(['pointercancel', 'lostpointercapture', 'blur', 'hide', 'unmount'])('discards pending moves after %s', async reason => {
        const fixture = await gestureFixture();
        const {state, frames, pointer} = fixture;
        state.movePopupGesture(pointer('pointermove', 255, 145));
        const lateFrame = [...frames.values()][0];
        if (reason === 'hide') state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        else if (reason === 'blur') state.handleWindowBlur();
        else state.stopPopupGesture(pointer(reason, 255, 145));
        const settled = {...state.tooltipStyle};
        expect(frames.size).toBe(0);
        expect(state.popupManipulating).toBe(false);
        lateFrame(0);
        expect(state.tooltipStyle).toEqual(settled);
    });

    it('ignores foreign pointer moves and release events while the current gesture remains owned', async () => {
        const {state, frames, pointer} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 255, 145, 2));
        expect(frames.size).toBe(0);
        state.stopPopupGesture(pointer('pointerup', 255, 145, 2));
        expect(state.popupManipulating).toBe(true);
        state.movePopupGesture({...pointer('pointermove', 255, 145), isTrusted: false});
        expect(frames.size).toBe(0);
    });

    it('keeps a new gesture frame intact when a cancelled old callback is delivered late', async () => {
        const {state, frames, pointer, flush} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 215, 120));
        const oldFrame = [...frames.values()][0];
        state.stopPopupGesture(pointer('pointercancel', 215, 120));
        state.beginPopupGesture(pointer('pointerdown', 205, 110));
        state.movePopupGesture(pointer('pointermove', 245, 150));
        oldFrame(0);
        expect(frames.size).toBe(1);
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '240px', top: '140px'});
    });

    it('does not remeasure the host selection for an anchored card, and needs no card read after manual resize', () => {
        const {state} = mountSelection();
        const range = {getClientRects: vi.fn(() => [])};
        const cardRect = vi.fn(() => ({width: 388, height: 240}));
        state.snapshot = {text: 'Practice helps.', range};
        state.tooltipRef = {getBoundingClientRect: cardRect};
        state.showTooltip = true;
        state.manualPopupPosition = {left: 200, top: 100};
        state.manualPopupSize = {width: 388, height: 240};
        for (let i = 0; i < 30; i++) state.updatePosition();
        expect(range.getClientRects).not.toHaveBeenCalled();
        expect(cardRect).not.toHaveBeenCalled();
        expect(state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '388px', height: '240px'});
    });

    it.each(['hide', 'replacement', 'unmount'])('rejects the queued first anchor after %s', async reason => {
        const fixture = mountSelection();
        const {state} = fixture;
        const cardRect = vi.fn(() => ({width: 388, height: 240}));
        state.snapshot = {text: 'Practice helps.', range: {}, anchor: {left: 40, right: 150, top: 100, bottom: 120, width: 110, height: 20}, isForward: true};
        state.tooltipRef = {getBoundingClientRect: cardRect};
        state.showTooltip = true;
        state.updatePosition(false);
        if (reason === 'hide') state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        else state.snapshot = {...state.snapshot, text: 'A new selection.'};
        await Vue.nextTick();
        expect(cardRect).not.toHaveBeenCalled();
        expect(state.manualPopupPosition).toBeNull();
    });

    it('does not let an old position frame clear the new frame after geometry reset', async () => {
        const {state, frames, flush} = await gestureFixture();
        state.stopPopupGesture();
        state.schedulePositionUpdate();
        const oldFrame = [...frames.values()][0];
        state.resetPopupGeometry();
        state.manualPopupPosition = {left: 250, top: 150};
        state.manualPopupSize = {width: 388, height: 240};
        state.schedulePositionUpdate();
        oldFrame(0);
        expect(frames.size).toBe(1);
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '250px', top: '150px'});
    });

    it('cancels a captured drag when the viewport changes its automatic width', async () => {
        const {state, window, frames, pointer, element} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 900, 200));
        const oldMove = [...frames.values()][0];
        window.innerWidth = 390;
        state.handleViewportResize();
        expect(state.popupManipulating).toBe(false);
        expect(element.captured).toBe(false);
        state.movePopupGesture(pointer('pointermove', 905, 200));
        oldMove(0);
        const frameCount = frames.size;
        expect(frameCount).toBe(1); // only the current viewport reposition remains queued
        const current = [...frames.values()];frames.clear();current.forEach(callback => callback(0));
        expect(parseFloat(state.tooltipStyle.left)).toBe(12);
        expect(state.manualPopupPosition).toEqual({left: 12, top: 100});
    });

    it('dismisses the teleported tools on outside focus and viewport changes without stealing focus inside the card', () => {
        const {state} = mountSelection();
        const inside={}, outside={};
        const root={contains:(node:unknown)=>node===inside};
        const closeTools=vi.fn(), dismissToolsOutside=vi.fn();
        state.readingPanelRef={closeTools,dismissToolsOutside};
        const pointer={target:inside};
        state.dismissReadingToolsOutside(pointer);
        expect(dismissToolsOutside).toHaveBeenCalledWith(pointer);
        state.dismissReadingToolsOnFocusOut({currentTarget:root,relatedTarget:inside});
        expect(closeTools).not.toHaveBeenCalled();
        state.dismissReadingToolsOnFocusOut({currentTarget:root,relatedTarget:outside});
        state.dismissReadingToolsOnFocusOut({currentTarget:root,relatedTarget:null});
        expect(closeTools).toHaveBeenCalledTimes(2);
        state.handleViewportResize();
        expect(closeTools).toHaveBeenCalledTimes(3);
    });

    it('leaves the native more summary gesture available without starting a card drag', async () => {
        const {state,element,pointer}=await gestureFixture();
        state.stopPopupGesture();
        element.closest=(selector:string)=>selector.includes('summary') ? element : null;
        const event=pointer('pointerdown',205,110);
        state.beginPopupGesture(event);
        expect(state.popupManipulating).toBe(false);
        expect(element.captured).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('uses an ordinary wheel to scroll only the overflowing one-row navigation', () => {
        const {state} = mountSelection();
        class NavigationElement {
            scrollWidth = 600; clientWidth = 280; scrollLeft = 0;
            matches(selector: string) {return selector === '.fr-study-toolbar';}
        }
        vi.stubGlobal('HTMLElement', NavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({overflowX: 'auto', overflowY: 'auto'}));
        const toolbar = new NavigationElement();
        const preventDefault = vi.fn();
        const event = {ctrlKey: false, deltaX: 0, deltaY: 60, cancelable: true, preventDefault, composedPath: () => [toolbar], currentTarget: toolbar};
        state.handleUiWheel(event);
        expect(toolbar.scrollLeft).toBe(60);
        expect(preventDefault).toHaveBeenCalledOnce();
        state.handleUiWheel({...event, deltaY: -30});
        expect(toolbar.scrollLeft).toBe(30);
        state.handleUiWheel({...event, ctrlKey: true});
        expect(toolbar.scrollLeft).toBe(30);
    });

    it('reveals each focused toolbar action by moving only the owned horizontal strip', () => {
        const {state} = mountSelection();
        class NavigationElement {
            tagName = 'BUTTON'; clientWidth = 278; clientLeft = 0; scrollLeft = 0;
            left = 259; right = 297;
            getBoundingClientRect() {return {left: this.left, right: this.right};}
            contains(element: unknown) {return element === button;}
        }
        vi.stubGlobal('HTMLElement', NavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({paddingLeft: '8px', paddingRight: '8px'}));
        const toolbar = new NavigationElement(), button = new NavigationElement();
        toolbar.left = 13; toolbar.right = 291;
        const event = {currentTarget: toolbar, target: button};
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(14); // reveal the clipped final button and its focus outline
        button.left = 7; button.right = 45;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        button.left = 21; button.right = 59;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        state.handleStudyToolbarFocus({...event, target: new NavigationElement()});
        state.handleStudyToolbarFocus({...event, currentTarget: {}});
        button.tagName = 'SPAN';
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
    });

    it.each([0.5, 2])('reveals focused toolbar actions at popup scale %s using layout scroll units', scale => {
        const {state} = mountSelection();
        state.pageZoom = 1 / scale;
        class ScaledNavigationElement {
            tagName = 'BUTTON'; clientWidth = 278; clientLeft = 1; scrollLeft = 0;
            left = 246; right = 284;
            getBoundingClientRect() {
                if (this === toolbar) return {left:13, right:13 + 280 * scale};
                return {left:13 + (this.left - toolbar.scrollLeft) * scale, right:13 + (this.right - toolbar.scrollLeft) * scale};
            }
            contains(element: unknown) {return element === button;}
        }
        vi.stubGlobal('HTMLElement', ScaledNavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({paddingLeft:'8px',paddingRight:'8px'}));
        const toolbar = new ScaledNavigationElement(), button = new ScaledNavigationElement();
        const event = {currentTarget:toolbar,target:button};
        const visibleLeft = 13 + 9 * scale, visibleRight = 13 + 271 * scale;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(13);
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(visibleRight);
        button.left = 9; button.right = 47;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        expect(button.getBoundingClientRect().left).toBeGreaterThanOrEqual(visibleLeft);
        button.left = 180; button.right = 218;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0); // an already visible action must not jump the strip
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(visibleRight);
    });

    it('computes UTF-16 offsets once and preserves positioned segments through speech progress updates', () => {
        const {state} = mountSelection();
        const parts = [{kind: 'code', text: ' 😀'}, {kind: 'text', text: ' café'}, {kind: 'code', text: '`x`'}, {kind: 'text', text: ' end'}];
        state.snapshot = {parts};
        state.translationParts = parts;
        const source = state.sourceTextParts, translated = state.translatedTextParts;
        expect(source.map((part: {offset: number}) => part.offset)).toEqual([0, 3, 8, 11]);
        expect(source.map((part: {text: string}) => part.text).join('')).toBe(' 😀 café`x` end');
        state.isPlaying = true; state.currentAudioKind = 'source';
        for (let i = 0; i < 30; i++) {
            state.audioProgress = {start: 3, end: 8, fraction: i / 30, estimated: true};
            expect(state.sourceTextParts).toBe(source);
            expect(state.translatedTextParts).toBe(translated);
            expect(state.sourceAudioProgress).toEqual({start: 3, end: 8, fraction: i / 30, estimated: true});
        }
        state.snapshot = {parts: [{kind: 'text', text: 'new'}]};
        expect(state.sourceTextParts).not.toBe(source);
        expect(state.sourceTextParts[0].offset).toBe(0);
    });
});


describe('selection card Escape ownership', () => {
    // These local target/trust ports exercise the real mounted capture listener;
    // they do not reproduce native closed-shadow retargeting or dialog defaults.
    function keyboardFixture() {
        const fixture = mountSelection();
        class KeyboardNode {
            getRootNode() {return fixture.document;}
        }
        class KeyboardElement extends KeyboardNode {
            constructor(readonly id = '') {super();}
            contains(node: unknown) {return node === this;}
        }
        vi.stubGlobal('Node', KeyboardNode);
        vi.stubGlobal('Element', KeyboardElement);
        const host = new KeyboardElement('fluent-read-selection-translator-container');
        const outside = new KeyboardElement('host-page-control');
        const shareCard = new KeyboardElement('fluent-read-share-card-container');
        Object.assign(fixture.document, {
            getElementById: vi.fn((id: string) => id === host.id ? host : null),
        });
        const selected = Vue.markRaw({text: 'Keep the native dialog open.', parts: [], range: {} as Range});
        const request = Vue.markRaw({text: selected.text, generation: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans'});
        const controller = new AbortController();
        const dismissTools = vi.fn(() => false);
        fixture.state.snapshot = selected;
        fixture.state.selectedText = selected.text;
        fixture.state.showTooltip = true;
        fixture.state.isLoading = true;
        fixture.state.activeContentRequest = request;
        fixture.state.translationAbortController = controller;
        fixture.state.readingPanelRef = Vue.markRaw({dismissTools});
        const handlers = [...(fixture.listeners.get('document:keydown') ?? [])];
        expect(handlers).toHaveLength(1);
        const handler = handlers[0];
        if (!handler) throw new Error('Selection keydown capture listener was not mounted.');
        expect(fixture.document.addEventListener).toHaveBeenCalledWith('keydown', handler, true);
        const dispatch = (target = host, flags: Partial<Pick<KeyboardEvent, 'key' | 'isTrusted' | 'repeat' | 'isComposing'>> = {}) => {
            const event = {target, key: 'Escape', isTrusted: true, repeat: false, isComposing: false,
                preventDefault: vi.fn(), stopPropagation: vi.fn(), ...flags};
            handler(event);
            return event;
        };
        return {...fixture, host, outside, shareCard, selected, request, controller, dismissTools, dispatch};
    }

    it.each(['ordinary', 'repeat', 'isComposing'] as const)('consumes an owning card Escape with the existing %s ordering', mode => {
        const fixture = keyboardFixture();
        const event = fixture.dispatch(fixture.host, {repeat: mode === 'repeat', isComposing: mode === 'isComposing'});

        expect(fixture.state.snapshot).toBeNull();
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.activeContentRequest).toBeNull();
        expect(fixture.controller.signal.aborted).toBe(true);
        expect(fixture.state.isLoading).toBe(false);
        expect(fixture.state.dismissedSelection).toBe(fixture.selected);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(fixture.dismissTools).toHaveBeenCalledOnce();
    });

    it('consumes the tools Escape tier without closing the owning card or aborting its request', () => {
        const fixture = keyboardFixture();
        fixture.dismissTools.mockReturnValue(true);
        const event = fixture.dispatch();

        expect(fixture.state.snapshot).toBe(fixture.selected);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.activeContentRequest).toBe(fixture.request);
        expect(fixture.controller.signal.aborted).toBe(false);
        expect(fixture.state.isLoading).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(fixture.dismissTools).toHaveBeenCalledOnce();
    });

    it.each(['outside with snapshot', 'own without snapshot', 'untrusted', 'share card', 'own non-Escape'] as const)(
        'retains host event ownership for %s', condition => {
            const fixture = keyboardFixture();
            const noSnapshot = condition === 'own without snapshot';
            if (noSnapshot) {
                fixture.state.snapshot = null;
                fixture.state.showTooltip = false;
                fixture.state.activeContentRequest = null;
                fixture.state.translationAbortController = null;
                fixture.state.isLoading = false;
            }
            const target = condition === 'outside with snapshot' ? fixture.outside
                : condition === 'share card' ? fixture.shareCard : fixture.host;
            const event = fixture.dispatch(target, {isTrusted: condition !== 'untrusted',
                key: condition === 'own non-Escape' ? 'ArrowLeft' : 'Escape'});
            const closed = condition === 'outside with snapshot';

            expect(fixture.state.snapshot).toBe(closed || noSnapshot ? null : fixture.selected);
            expect(fixture.state.showTooltip).toBe(!closed && !noSnapshot);
            expect(fixture.state.activeContentRequest).toBe(closed || noSnapshot ? null : fixture.request);
            expect(fixture.controller.signal.aborted).toBe(closed);
            expect(fixture.state.isLoading).toBe(!closed && !noSnapshot);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        },
    );
});


describe('focused selection card dismissal requests', () => {
    // The renderer stays null. Root activeElement and retargeted key/trust ports
    // exercise the actual setup handler, not native browser focus behavior.
    function focusedFixture() {
        const dismiss = vi.fn();
        const fixture = mountSelection(false, undefined, {onFocusedCardDismiss: dismiss});
        const root: {activeElement: unknown} = {activeElement: null};
        class FocusNode {
            getRootNode() {return root;}
        }
        class FocusElement extends FocusNode {
            readonly children = new Set<unknown>();
            constructor(readonly id = '') {super();}
            contains(value: unknown) {return this.children.has(value);}
        }
        vi.stubGlobal('Node', FocusNode);
        vi.stubGlobal('Element', FocusElement);
        const host = Vue.markRaw(new FocusElement('fluent-read-selection-translator-container'));
        const card = Vue.markRaw(new FocusElement('card'));
        const button = Vue.markRaw(new FocusElement('close-button'));
        const outside = Vue.markRaw(new FocusElement('host-native-control'));
        host.children.add(card);
        card.children.add(button);
        root.activeElement = button;
        Object.assign(fixture.document, {activeElement: host,
            getElementById: vi.fn((id: string) => id === host.id ? host : null)});
        const selected = Vue.markRaw({text: 'Keep the native dialog open.', parts: [], range: {} as Range});
        const controller = new AbortController();
        const dismissTools = vi.fn(() => false);
        fixture.state.snapshot = selected;
        fixture.state.selectedText = selected.text;
        fixture.state.showTooltip = true;
        fixture.state.tooltipRef = card;
        fixture.state.translationAbortController = controller;
        fixture.state.readingPanelRef = Vue.markRaw({dismissTools});
        const keydown = [...(fixture.listeners.get('document:keydown') ?? [])][0]!;
        expect(keydown).toBeTypeOf('function');
        const escape = (target: unknown = host, isTrusted = true) => {
            const event = {target, key: 'Escape', isTrusted, repeat: false, isComposing: false,
                preventDefault: vi.fn(), stopPropagation: vi.fn()};
            keydown(event);
            return event;
        };
        return {...fixture, dismiss, host, card, button, outside, root, selected, controller, dismissTools, escape};
    }

    it.each(['owned Escape', 'close button handler'] as const)('requests synchronous restoration before hiding for %s', trigger => {
        const fixture = focusedFixture();
        // document.activeElement is only the closed host; the actual card focus
        // decision must read the card's root and not mistake this for no focus.
        fixture.dismiss.mockImplementation(() => {
            expect(fixture.state.snapshot).toBe(fixture.selected);
            expect(fixture.state.showTooltip).toBe(true);
            expect(fixture.controller.signal.aborted).toBe(false);
        });
        if (trigger === 'owned Escape') {
            const event = fixture.escape();
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopPropagation).toHaveBeenCalledOnce();
        } else {
            fixture.root.activeElement = fixture.card;
            fixture.state.closeTooltip();
        }

        expect(fixture.dismiss).toHaveBeenCalledOnce();
        expect(fixture.state.snapshot).toBeNull();
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.controller.signal.aborted).toBe(true);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['outside Escape', 'untrusted Escape', 'no snapshot', 'tools tier', 'plain hideAll',
        'configuration notification', 'unmount', 'focus outside card', 'hidden card', 'missing tooltip'] as const)(
        'does not request focus restoration for %s', async condition => {
            const fixture = focusedFixture();
            if (condition === 'outside Escape') fixture.escape(fixture.outside);
            else if (condition === 'untrusted Escape') fixture.escape(fixture.host, false);
            else if (condition === 'no snapshot') {
                fixture.state.snapshot = null;
                fixture.escape();
            } else if (condition === 'tools tier') {
                fixture.dismissTools.mockReturnValue(true);
                const event = fixture.escape();
                expect(event.preventDefault).toHaveBeenCalledOnce();
                expect(fixture.state.showTooltip).toBe(true);
                expect(fixture.controller.signal.aborted).toBe(false);
            } else if (condition === 'plain hideAll') fixture.state.hideAll();
            else if (condition === 'configuration notification') {
                fixture.config.harness.enabled = !fixture.config.harness.enabled;
                fixture.state.selectionConfigVersion += 1;
                await Vue.nextTick();
                expect(fixture.state.snapshot).toBeNull();
            } else if (condition === 'unmount') fixture.unmount();
            else {
                if (condition === 'focus outside card') fixture.root.activeElement = fixture.outside;
                if (condition === 'hidden card') fixture.state.showTooltip = false;
                if (condition === 'missing tooltip') fixture.state.tooltipRef = null;
                fixture.state.closeTooltip();
                expect(fixture.state.snapshot).toBeNull();
            }

            expect(fixture.dismiss).not.toHaveBeenCalled();
            expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        },
    );
});


describe('selection translation authentication copy and request ownership', () => {
    // Run the actual SFC catch with the real error protocol. Only the translation
    // transport and browser message ports use the existing lifecycle fixture.
    const authenticationCopy = '密钥或权限无效';
    const genericCopy = '翻译失败，请重试';

    function begin(fixture: ReturnType<typeof mountSelection>, text = 'Good ideas deserve attention.') {
        fixture.config.from = 'en';
        fixture.config.to = 'zh-Hans';
        fixture.state.snapshot = fixture.selectedSnapshot(text);
        fixture.state.selectedText = text;
        fixture.state.showTooltip = true;
        return fixture.state.beginSelectionContentRequest(text);
    }

    function deferredTranslation() {
        let resolve!: (text: string) => void;
        let reject!: (cause: Error) => void;
        const promise = new Promise<string>((yes, no) => {resolve = yes; reject = no;});
        return {promise, resolve, reject};
    }

    function structuredAuthentication() {
        const payload = translationErrors.serializeTranslationError({
            message: 'PRIVATE_DIAGNOSTIC_OPAQUE_PROVIDER_DETAIL',
            kind: 'authentication', retryable: false, statusCode: 403,
        });
        try {
            translationErrors.unwrapTranslationResponse<never>(payload);
        } catch (cause) {
            expect(cause).toBeInstanceOf(translationErrors.TranslationRequestError);
            return cause as translationErrors.TranslationRequestError;
        }
        throw new Error('The actual structured error protocol did not reject.');
    }

    it.each([
        {label: 'missing API key', kind: 'authentication', copy: authenticationCopy,
            cause: () => new Error('API key is not configured: PRIVATE_DIAGNOSTIC_MISSING_KEY')},
        {label: 'structured authentication with an opaque message', kind: 'authentication', copy: authenticationCopy,
            cause: structuredAuthentication},
        {label: 'HTTP 401 through TranslationRequestError', kind: 'authentication', copy: authenticationCopy,
            cause: () => new translationErrors.TranslationRequestError(translationErrors.serializeTranslationError({
                message: 'HTTP 401: PRIVATE_DIAGNOSTIC_UNAUTHORIZED', statusCode: 401,
            }))},
        {label: 'HTTP 403', kind: 'authentication', copy: authenticationCopy,
            cause: () => new Error('HTTP 403: PRIVATE_DIAGNOSTIC_FORBIDDEN')},
        {label: 'rate limit mentioning an API key', kind: 'rate-limit', copy: genericCopy,
            cause: () => new Error('429 rate limit for API key: PRIVATE_DIAGNOSTIC_RATE_LIMIT')},
        {label: 'invalid model', kind: 'bad-request', copy: genericCopy,
            cause: () => new Error('Invalid model: PRIVATE_DIAGNOSTIC_MODEL')},
        {label: 'network failure', kind: 'network', copy: genericCopy,
            cause: () => new TypeError('Failed to fetch: PRIVATE_DIAGNOSTIC_NETWORK')},
        {label: 'unknown failure', kind: 'unknown', copy: genericCopy,
            cause: () => new Error('PRIVATE_DIAGNOSTIC_UNKNOWN')},
    ])('uses bounded UI copy for $label', async ({cause: createCause, kind, copy}) => {
        const fixture = mountSelection();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const request = begin(fixture);
        const cause = createCause();
        expect(translationErrors.serializeTranslationError(cause).kind).toBe(kind);
        fixture.translateText.mockRejectedValueOnce(cause);

        await fixture.state.requestTranslation(request);

        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.error).toBe(copy);
        expect(fixture.state.error).not.toContain('PRIVATE_DIAGNOSTIC');
        expect(fixture.state.error).not.toBe(cause.message);
        expect(fixture.state.activeContentRequest).toEqual(request);
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.translationAbortController).toBeNull();
        expect(fixture.state.isLoading).toBe(false);
        expect(logged).toHaveBeenCalledWith('Selection translation error:', cause);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('ignores a late authentication failure while a replacement selection is still loading', async () => {
        const fixture = mountSelection();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const old = deferredTranslation(), replacement = deferredTranslation();
        fixture.translateText.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
        const oldRequest = begin(fixture, 'An earlier sentence.');
        const oldPending = fixture.state.requestTranslation(oldRequest);
        const oldController = fixture.state.translationAbortController;
        const currentRequest = begin(fixture, 'The current sentence.');
        const currentPending = fixture.state.requestTranslation(currentRequest);
        const currentController = fixture.state.translationAbortController;
        const activeRequest = fixture.state.activeContentRequest;

        old.reject(structuredAuthentication());
        await oldPending;

        expect(oldController.signal.aborted).toBe(true);
        expect(currentController.signal.aborted).toBe(false);
        expect(fixture.state.activeContentRequest).toBe(activeRequest);
        expect(fixture.state.translationAbortController).toBe(currentController);
        expect(fixture.state.error).toBe('');
        expect(fixture.state.isLoading).toBe(true);
        expect(fixture.state.translationResult).toBe('');
        expect(logged).not.toHaveBeenCalled();
        replacement.resolve('当前句子的译文。');
        await currentPending;
        expect(fixture.state.translationAnswer).toEqual({...currentRequest, answer: '当前句子的译文。'});
        expect(fixture.state.translationResult).toBe('当前句子的译文。');
        expect(fixture.state.error).toBe('');
        expect(fixture.state.isLoading).toBe(false);
        expect(fixture.state.translationAbortController).toBeNull();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('does not resurrect error copy after the owning selection card closes', async () => {
        const fixture = mountSelection();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const response = deferredTranslation();
        fixture.translateText.mockReturnValueOnce(response.promise);
        const pending = fixture.state.requestTranslation(begin(fixture));
        const controller = fixture.state.translationAbortController;

        fixture.state.hideAll();
        response.reject(structuredAuthentication());
        await pending;

        expect(controller.signal.aborted).toBe(true);
        expect(fixture.state.snapshot).toBeNull();
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.activeContentRequest).toBeNull();
        expect(fixture.state.translationAbortController).toBeNull();
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.error).toBe('');
        expect(fixture.state.isLoading).toBe(false);
        expect(logged).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('keeps AbortError silent even when its diagnostic contains authentication wording', async () => {
        const fixture = mountSelection();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const request = begin(fixture);
        fixture.translateText.mockRejectedValueOnce(new DOMException('API key: PRIVATE_DIAGNOSTIC_ABORT', 'AbortError'));

        await fixture.state.requestTranslation(request);

        expect(fixture.state.activeContentRequest).toEqual(request);
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.error).toBe('');
        expect(fixture.state.isLoading).toBe(false);
        expect(fixture.state.translationAbortController).toBeNull();
        expect(logged).not.toHaveBeenCalled();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('allows an explicit manual retry to replace authentication copy with a successful translation', async () => {
        const fixture = mountSelection();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const request = begin(fixture);
        fixture.translateText.mockRejectedValueOnce(structuredAuthentication());
        await fixture.state.requestTranslation(request);
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.state.error).toBe(authenticationCopy);
        expect(fixture.translateText).toHaveBeenCalledOnce();

        fixture.translateText.mockResolvedValueOnce('好想法值得关注。');
        fixture.state.retryTranslation();
        await vi.advanceTimersByTimeAsync(0);
        await Vue.nextTick();

        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        expect(fixture.state.activeContentRequest.generation).toBeGreaterThan(request.generation);
        expect(fixture.state.translationAnswer).toEqual({...fixture.state.activeContentRequest, answer: '好想法值得关注。'});
        expect(fixture.state.translationResult).toBe('好想法值得关注。');
        expect(fixture.state.error).toBe('');
        expect(fixture.state.isLoading).toBe(false);
        expect(fixture.state.translationAbortController).toBeNull();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('preserves an independently completed dictionary answer when translation authentication later fails', async () => {
        const fixture = mountSelection();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const card = {word: 'read', normalizedWord: 'read', phonetics: [], sources: [],
            meanings: [{partOfSpeech: '动词', definitions: [{definition: 'to understand written words',
                translatedDefinition: '阅读并理解文字'}]}]};
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionWordLookup'
            ? Promise.resolve({success: true, data: card}) : Promise.resolve({success: true, zoom: 1}));
        const response = deferredTranslation();
        fixture.translateText.mockReturnValueOnce(response.promise);
        const request = begin(fixture, 'read');
        const pending = fixture.state.requestTranslation(request);
        await fixture.state.requestWordCard(request);
        const completedCard = fixture.state.wordCard;
        const completedAnswer = fixture.state.dictionaryAnswer;
        expect(completedAnswer).toEqual({...request, answer: '阅读并理解文字'});

        response.reject(structuredAuthentication());
        await pending;

        expect(fixture.state.error).toBe(authenticationCopy);
        expect(fixture.state.wordCard).toBe(completedCard);
        expect(fixture.state.dictionaryAnswer).toBe(completedAnswer);
        expect(fixture.state.vocabularyAnswer).toBe('阅读并理解文字');
        expect(fixture.state.wordCardError).toBe('');
        expect(fixture.state.isWordCardLoading).toBe(false);
        expect(fixture.state.isWordCardSupportLoading).toBe(false);
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.isLoading).toBe(false);
        expect(fixture.browser.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'selectionWordLookup')
            .map(([message]) => message.translateFields)).toEqual([false, true]);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('uses bounded authentication copy after the real mixed code/prose batch request fails', async () => {
        const fixture = mountSelection();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const parts: selectionCore.SelectionTextPart[] = [
            {kind: 'text', text: 'Explain the call '},
            {kind: 'code', text: 'reader.read()'},
            {kind: 'text', text: ' before continuing.'},
        ];
        const text = 'Explain the call reader.read() before continuing.';
        const request = begin(fixture, text);
        const snapshot = Vue.markRaw({...fixture.state.snapshot, parts});
        fixture.state.snapshot = snapshot;
        const activeRequest = fixture.state.activeContentRequest;
        expect(parts.map(part => part.text).join('')).toBe(text);
        let rejectBatch!: (cause: Error) => void;
        fixture.translateTextBatch.mockImplementationOnce(() => new Promise<string[]>((_resolve, reject) => {
            rejectBatch = reject;
        }));
        const cause = structuredAuthentication();

        const pending = fixture.state.requestTranslation(request);
        const controller = fixture.state.translationAbortController;

        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.translateTextBatch).toHaveBeenCalledOnce();
        // The actual core function passes prose to the existing batch port.
        // Code remains in the snapshot; no translation algorithm is copied here.
        expect(fixture.translateTextBatch.mock.calls[0]?.[0]).toEqual(['Explain the call', 'before continuing.']);
        expect(controller).toBeInstanceOf(AbortController);
        expect(fixture.translateTextBatch.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            signal: controller.signal, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
        }));
        expect(controller.signal.aborted).toBe(false);
        expect(fixture.state.isLoading).toBe(true);
        expect(fixture.state.error).toBe('');
        expect(fixture.state.translationParts).toEqual([]);

        rejectBatch(cause);
        await pending;

        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.translateTextBatch).toHaveBeenCalledOnce();
        expect(fixture.state.snapshot).toBe(snapshot);
        expect(fixture.state.snapshot.parts).toBe(parts);
        expect(parts).toEqual([
            {kind: 'text', text: 'Explain the call '},
            {kind: 'code', text: 'reader.read()'},
            {kind: 'text', text: ' before continuing.'},
        ]);
        expect(fixture.state.selectedText).toBe(text);
        expect(fixture.state.activeContentRequest).toBe(activeRequest);
        expect(fixture.state.activeContentRequest).toEqual(request);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.error).toBe(authenticationCopy);
        expect(fixture.state.error).not.toContain('PRIVATE_DIAGNOSTIC');
        expect(fixture.state.error).not.toBe(cause.message);
        expect(fixture.state.translationParts).toEqual([]);
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.translationAbortController).toBeNull();
        expect(controller.signal.aborted).toBe(false);
        expect(fixture.state.isLoading).toBe(false);
        expect(logged).toHaveBeenCalledWith('Selection translation error:', cause);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('selection authentication settings action ownership and rendered entry', () => {
    const settingsMessage = {type: 'openOptionsPage', section: 'settings-general'};
    const failureNotice = '无法打开设置，请从扩展菜单打开设置后重试';
    const privateDetail = 'PRIVATE_SETTINGS_PROVIDER_CAUSE';
    type Fixture = ReturnType<typeof mountSelection>;

    function deferred<T>() {
        let resolve!: (value: T) => void, reject!: (reason: Error) => void;
        const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
        return {promise, resolve, reject};
    }

    function authenticationCause() {
        const response = translationErrors.serializeTranslationError({
            message: privateDetail, kind: 'authentication', retryable: false, statusCode: 403,
        });
        try { translationErrors.unwrapTranslationResponse<never>(response); }
        catch (cause) {
            expect(cause).toBeInstanceOf(translationErrors.TranslationRequestError);
            return cause as translationErrors.TranslationRequestError;
        }
        throw new Error('The real translation error protocol must reject.');
    }

    function begin(fixture: Fixture, text = 'Good ideas deserve attention.') {
        fixture.state.snapshot = fixture.selectedSnapshot(text);
        fixture.state.selectedText = text;
        fixture.state.showTooltip = true;
        return fixture.state.beginSelectionContentRequest(text);
    }

    async function failedSelection(options: {render?: boolean; inline?: boolean; cause?: Error;
        service?: string; selectionService?: string; adapter?: Record<string, unknown>} = {}) {
        const fixture = mountSelection(false, options.adapter, {}, options.render === true);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fixture.config.from = 'en';
        fixture.config.to = 'zh-Hans';
        fixture.config.service = options.service ?? 'google';
        fixture.config.selectionTranslationService = options.selectionService ?? '';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        const card = {word: 'read', normalizedWord: 'read', phonetics: [], sources: [],
            meanings: [{partOfSpeech: '动词', definitions: [{definition: 'to understand written words',
                translatedDefinition: '阅读并理解文字'}]}]};
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionWordLookup'
            ? Promise.resolve({success: true, data: card}) : Promise.resolve({success: true, zoom: 1}));
        const translation = deferred<string>();
        fixture.translateText.mockReturnValueOnce(translation.promise);
        const request = begin(fixture, options.inline ? 'read' : undefined);
        const pending = fixture.state.requestTranslation(request);
        if (options.inline) await fixture.state.requestWordCard(request);
        translation.reject(options.cause ?? authenticationCause());
        await pending;
        await Vue.nextTick();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        return {...fixture, request};
    }

    function settingsCalls(fixture: Fixture) {
        return fixture.browser.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'openOptionsPage');
    }

    function settingsResponse(fixture: Fixture, response: Promise<unknown>) {
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'openOptionsPage'
            ? response : Promise.resolve({success: true, zoom: 1}));
    }

    it.each([
        {label: 'default built-in service', service: 'google', selectionService: '', dispatched: 'google'},
        {label: 'different selected built-in service', service: 'deepseek', selectionService: 'openai', dispatched: 'openai'},
        {label: 'selected custom profile', service: 'google', selectionService: 'custom:settings-owner', dispatched: 'custom:settings-owner'},
    ])('opens only general settings for $label without changing translation or configuration', async options => {
        const fixture = await failedSelection(options);
        const authentication = fixture.state.authenticationError;
        expect(authentication.service).toBe(options.dispatched);
        expect(fixture.translateText.mock.calls[0]?.[2]).toEqual(expect.objectContaining({serviceOverride: options.dispatched}));
        expect(settingsCalls(fixture)).toHaveLength(0);
        const configBefore = JSON.stringify(fixture.config);
        const active = fixture.state.activeContentRequest;
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture).map(([message]) => message)).toEqual([settingsMessage]);
        expect(JSON.stringify(settingsCalls(fixture))).not.toContain('service');
        expect(JSON.stringify(settingsCalls(fixture))).not.toContain(privateDetail);
        expect(JSON.stringify(fixture.config)).toBe(configBefore);
        expect(fixture.state.activeContentRequest).toBe(active);
        expect(fixture.state.authenticationError).toBe(authentication);
        expect(fixture.state.error).toBe('密钥或权限无效');
        expect(fixture.state.translationResult).toBe('');
        expect(fixture.state.translationAnswer).toBeNull();
        expect(fixture.state.dictionaryAnswer).toBeNull();
        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['standalone', 'dictionary inline'] as const)('renders both actions and dispatches the real configure click in the %s surface', async surface => {
        const fixture = await failedSelection({render: true, inline: surface === 'dictionary inline'});
        const port = fixture.renderPort!;
        const selector = surface === 'standalone' ? '.fr-error-state' : '.fr-inline-error';
        const other = surface === 'standalone' ? '.fr-inline-error' : '.fr-error-state';
        expect(port.root.querySelector(other)).toBeNull();
        const buttons = Array.from(port.root.querySelectorAll(`${selector} .fr-error-actions button`));
        expect(buttons.map(button => button.textContent)).toEqual(['重试', '配置服务']);
        expect(buttons).toHaveLength(2);
        expect(buttons.every(button => button.getAttribute('type') === 'button')).toBe(true);
        const dictionary = fixture.state.dictionaryAnswer, card = fixture.state.wordCard;
        const calls = fixture.browser.runtime.sendMessage.mock.calls.length;
        const response = deferred<unknown>();
        settingsResponse(fixture, response.promise);
        const pending = port.click(buttons[1]!);
        const action = fixture.state.openingAuthenticationSettings;
        await Vue.nextTick();
        expect(action.authentication).toBe(fixture.state.authenticationError);
        expect(buttons[1]!.hasAttribute('disabled')).toBe(true);
        expect(buttons[0]!.hasAttribute('disabled')).toBe(false);
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture).map(([message]) => message)).toEqual([settingsMessage]);
        response.resolve({success: true});
        await pending;
        await Vue.nextTick();
        expect(buttons[1]!.hasAttribute('disabled')).toBe(false);
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledTimes(calls + 1);
        expect(fixture.state.dictionaryAnswer).toBe(dictionary);
        expect(fixture.state.wordCard).toBe(card);
        if (surface === 'dictionary inline') {
            expect(dictionary).toEqual({...fixture.request, answer: '阅读并理解文字'});
            expect(port.root.querySelector('.fr-word-learning-card')?.textContent).toContain('阅读并理解文字');
        }
        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.error).toBe('密钥或权限无效');
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
        // Retry is the actual compiled template handler, not a setup-only assertion.
        fixture.translateText.mockResolvedValueOnce('好想法值得关注。');
        await port.click(buttons[0]!);
        await vi.advanceTimersByTimeAsync(0);
        await Vue.nextTick();
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        expect(fixture.state.error).toBe('');
        expect(fixture.state.translationResult).toBe('好想法值得关注。');
        expect(port.root.querySelector(`${selector} .fr-error-actions`)).toBeNull();
        expect(fixture.state.authenticationError).toBeNull();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['standalone', 'dictionary inline'] as const)('renders only retry for an ordinary error in the %s surface', async surface => {
        const fixture = await failedSelection({render: true, inline: surface === 'dictionary inline', cause: new TypeError('Failed to fetch')});
        const selector = surface === 'standalone' ? '.fr-error-state' : '.fr-inline-error';
        const buttons = Array.from(fixture.renderPort!.root.querySelectorAll(`${selector} .fr-error-actions button`));
        expect(buttons.map(button => button.textContent)).toEqual(['重试']);
        expect(fixture.state.authenticationError).toBeNull();
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture)).toHaveLength(0);
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['unsuccessful response', 'non-boolean success', 'missing response', 'rejected response', 'synchronous throw'] as const)('shows bounded feedback for the current action after %s', async outcome => {
        const fixture = await failedSelection({inline: true});
        const authentication = fixture.state.authenticationError;
        const dictionary = fixture.state.dictionaryAnswer, card = fixture.state.wordCard;
        const configBefore = JSON.stringify(fixture.config);
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => {
            if (message.type !== 'openOptionsPage') return Promise.resolve({success: true, zoom: 1});
            if (outcome === 'synchronous throw') throw new Error(privateDetail);
            if (outcome === 'rejected response') return Promise.reject(new Error(privateDetail));
            if (outcome === 'missing response') return Promise.resolve(undefined);
            return Promise.resolve({success: outcome === 'non-boolean success' ? 1 : false, error: privateDetail});
        });
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture).map(([message]) => message)).toEqual([settingsMessage]);
        expect(fixture.state.noticeMessage).toBe(failureNotice);
        expect(fixture.state.noticeMessage).not.toContain(privateDetail);
        expect(fixture.state.authenticationError).toBe(authentication);
        expect(fixture.state.error).toBe('密钥或权限无效');
        expect(fixture.state.dictionaryAnswer).toBe(dictionary);
        expect(fixture.state.wordCard).toBe(card);
        expect(fixture.state.translationResult).toBe('');
        expect(JSON.stringify(fixture.config)).toBe(configBefore);
        expect(fixture.translateText).toHaveBeenCalledOnce();
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['close', 'unmount', 'new selection', 'manual retry', 'provider change', 'target change',
        'adapter invalidation', 'reading then return', 'hidden then return'] as const)('suppresses a late settings rejection after %s', async boundary => {
        const acceptsRange = vi.fn(() => true);
        const fixture = await failedSelection({adapter: {acceptsRange}});
        const response = deferred<unknown>();
        settingsResponse(fixture, response.promise);
        const pending = fixture.state.openAuthenticationSettings();
        expect(fixture.state.openingAuthenticationSettings).not.toBeNull();
        if (boundary === 'close') fixture.state.hideAll();
        else if (boundary === 'unmount') fixture.unmount();
        else if (boundary === 'new selection') begin(fixture, 'A new current sentence.');
        else if (boundary === 'manual retry') {
            fixture.state.retryTranslation();
            await vi.advanceTimersByTimeAsync(0);
        } else if (boundary === 'provider change') fixture.config.service = 'microsoft';
        else if (boundary === 'target change') {
            fixture.config.to = 'fr';
            fixture.notifyConfig();
            expect(fixture.state.effectiveTargetLanguage).toBe('fr');
            expect(fixture.state.authenticationError.request.targetLanguage).toBe('zh-Hans');
        }
        else if (boundary === 'adapter invalidation') acceptsRange.mockReturnValue(false);
        else if (boundary === 'reading then return') {
            fixture.state.readingMode = true;
            expect(fixture.state.openingAuthenticationSettings).toBeNull();
            fixture.state.readingMode = false;
        } else {
            fixture.state.showTooltip = false;
            expect(fixture.state.openingAuthenticationSettings).toBeNull();
            fixture.state.showTooltip = true;
        }
        await Vue.nextTick();
        const current = {authentication: fixture.state.authenticationError, request: fixture.state.activeContentRequest,
            error: fixture.state.error, translation: fixture.state.translationResult, dictionary: fixture.state.dictionaryAnswer};
        if (boundary !== 'reading then return' && boundary !== 'hidden then return') {
            await fixture.state.openAuthenticationSettings();
            expect(settingsCalls(fixture)).toHaveLength(1);
        }
        // Transient reading/hidden revokes the original action even after return.
        // Do not start a second unresolved action in this late-response table.
        response.reject(new Error(privateDetail));
        await pending;
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.state.authenticationError).toBe(current.authentication);
        expect(fixture.state.activeContentRequest).toBe(current.request);
        expect(fixture.state.error).toBe(current.error);
        expect(fixture.state.translationResult).toBe(current.translation);
        expect(fixture.state.dictionaryAnswer).toBe(current.dictionary);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['provider', 'target', 'adapter', 'reading', 'hidden'] as const)('rejects a new settings action when the original authentication loses its %s boundary', async boundary => {
        const acceptsRange = vi.fn(() => true);
        const fixture = await failedSelection({adapter: {acceptsRange}});
        if (boundary === 'provider') fixture.config.service = 'microsoft';
        else if (boundary === 'target') {
            fixture.config.to = 'fr';
            fixture.notifyConfig();
            expect(fixture.state.effectiveTargetLanguage).toBe('fr');
            expect(fixture.state.authenticationError.request.targetLanguage).toBe('zh-Hans');
        }
        else if (boundary === 'adapter') acceptsRange.mockReturnValue(false);
        else if (boundary === 'reading') fixture.state.readingMode = true;
        else fixture.state.showTooltip = false;
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.state.isAuthenticationErrorCurrent(fixture.state.authenticationError)).toBe(false);
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture)).toHaveLength(0);
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('keeps a newer action pending when an older action finishes after reading returns', async () => {
        const fixture = await failedSelection();
        const old = deferred<unknown>(), current = deferred<unknown>();
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => {
            if (message.type !== 'openOptionsPage') return Promise.resolve({success: true, zoom: 1});
            return settingsCalls(fixture).length === 1 ? old.promise : current.promise;
        });
        const oldPending = fixture.state.openAuthenticationSettings();
        const oldAction = fixture.state.openingAuthenticationSettings;
        fixture.state.readingMode = true;
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        fixture.state.readingMode = false;
        const currentPending = fixture.state.openAuthenticationSettings();
        const currentAction = fixture.state.openingAuthenticationSettings;
        expect(currentAction).not.toBe(oldAction);
        expect(currentAction.authentication).toBe(oldAction.authentication);
        old.reject(new Error(privateDetail));
        await oldPending;
        expect(fixture.state.openingAuthenticationSettings).toBe(currentAction);
        expect(fixture.state.noticeMessage).toBe('');
        expect(settingsCalls(fixture).map(([message]) => message)).toEqual([settingsMessage, settingsMessage]);
        current.resolve({success: true});
        await currentPending;
        expect(fixture.state.openingAuthenticationSettings).toBeNull();
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('allows general settings after an adapter authentication failure before service dispatch', async () => {
        const cause = authenticationCause();
        const fixture = mountSelection(false, {acceptsRange: () => true, context: () => {throw cause;}});
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fixture.config.from = 'en';
        fixture.config.to = 'zh-Hans';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        const request = begin(fixture);
        await fixture.state.requestTranslation(request);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.state.authenticationError.service).toBeUndefined();
        expect(fixture.state.authenticationError.request).toEqual(request);
        expect(fixture.state.isAuthenticationErrorCurrent(fixture.state.authenticationError)).toBe(true);
        await fixture.state.openAuthenticationSettings();
        expect(settingsCalls(fixture).map(([message]) => message)).toEqual([settingsMessage]);
        expect(fixture.state.error).toBe('密钥或权限无效');
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

it('captures document materials through the owner adapter and keeps safe optional failure isolated', () => {
    const saved = {source: {kind: 'document', fingerprint: 'a'.repeat(32)}, locator: {kind: 'document', page: 2}};
    const captureMaterial = vi.fn(() => saved);
    const fixture = mountSelection(false, {acceptsRange: () => true, captureMaterial});
    const range = {} as Range;
    expect(fixture.state.captureMaterialSafely(range, 'selected translation')).toBe(saved);
    expect(captureMaterial).toHaveBeenCalledWith(range, 'selected translation');
    expect(fixture.material.captureMaterialSelection).not.toHaveBeenCalled();
    captureMaterial.mockImplementation(() => {throw new Error('document unmounted');});
    expect(fixture.state.captureMaterialSafely(range, 'selected translation')).toBeUndefined();
    expect(fixture.material.captureMaterialSelection).not.toHaveBeenCalled();
});


describe('Safari reading input keyboard transition', () => {
    // Render the actual parent SFC and deliver focus/input through its DOM listeners.
    // A minimal child input and closed-root focus/viewport ports model the native boundary;
    // they do not synthesize a Safari keyboard or claim browser acceptance.
    async function keyboardTransitionFixture(target: SelectionBuildTarget = 'safari') {
        const fixture = mountSelection(false, {acceptsRange: () => true}, target, true);
        const port = fixture.renderPort!;
        vi.stubGlobal('Node', port.domWindow.Node);
        vi.stubGlobal('Element', port.domWindow.Element);
        vi.stubGlobal('HTMLElement', port.domWindow.HTMLElement);
        const host = port.document.createElement('div');
        host.id = 'fluent-read-selection-translator-container';
        const shadow = host.attachShadow({mode: 'closed'});
        const ui = port.root.firstElementChild!;
        shadow.append(ui); port.root.append(host);
        const viewport = {width: 402, height: 754, scale: 1, offsetLeft: 0, offsetTop: 0};
        Object.assign(fixture.window, {innerWidth: 402, innerHeight: 874, visualViewport: viewport});
        let active: Element | null = null;
        Object.defineProperty(shadow, 'activeElement', {get: () => active});
        Object.assign(fixture.document, {activeElement: host,
            getElementById: (id: string) => id === host.id ? host : null});
        const source = {isConnected: true, ownerDocument: fixture.document};
        const range = {startContainer: source, endContainer: source, collapsed: false,
            toString: () => 'Keep the original source.', getClientRects: () => []};
        const selected = Vue.markRaw({text: 'Keep the original source.', rangeText: 'Keep the original source.', range,
            parts: [], anchor: {left: 20, right: 250, top: 400, bottom: 424, width: 230, height: 24}});
        Object.assign(fixture.state, {snapshot: selected, selectedText: selected.text, readingMode: true, showTooltip: true});
        fixture.config.selectionTranslatorAutoDismiss = true;
        await Vue.nextTick();
        const card = shadow.querySelector('.fr-translation-tooltip') as HTMLElement;
        expect(card).not.toBeNull();
        card.getBoundingClientRect = () => ({left: 12, top: 320, right: 390, bottom: 537, width: 378, height: 217}) as DOMRect;
        fixture.state.tooltipRef = Vue.markRaw(card);
        const form = port.document.createElement('form'); form.className = 'fr-reading-followup';
        const input = port.document.createElement('input'); input.setAttribute('aria-label', '继续追问');
        form.append(input); card.append(form);
        const controller = new AbortController(); fixture.state.translationAbortController = controller;
        const send = (where: 'window' | 'document', type: string, fields: Record<string, unknown> = {}) => {
            const event = {type, isTrusted: true, target: fixture.document, ...fields};
            for (const fn of [...(fixture.listeners.get(`${where}:${type}`) ?? [])]) fn(event);
        };
        const domEvent = (type: string, trusted = true) => {
            const event = new port.domWindow.Event(type, {bubbles: true});
            Object.defineProperty(event, 'isTrusted', {value: trusted}); input.dispatchEvent(event);
        };
        const focus = (trusted = true, interaction = true) => {
            if (interaction) send('document', 'pointerdown', {target: host, pointerType: 'touch', button: 0});
            active = input; domEvent('focusin', trusted);
            if (interaction) send('document', 'pointerup', {target: host, pointerType: 'touch', button: 0});
        };
        const keyboardScroll = () => {
            Object.assign(viewport, {height: 376, offsetTop: 284});
            send('window', 'scroll');
        };
        return {...fixture, host, shadow, card, input, viewport, selected, source, controller, focus, domEvent, send,
            keyboardScroll, setActive: (element: Element | null) => {active = element;}};
    }

    async function shortReadingCardFixture() {
        const f = await keyboardTransitionFixture();
        f.focus(); f.keyboardScroll(); await vi.advanceTimersByTimeAsync(801);
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402, scrollY: 557,
            screen: {orientation: {type: 'landscape-primary'}}});
        Object.assign(f.viewport, {width: 874, height: 98, offsetTop: 304});
        f.send('window', 'resize'); await vi.advanceTimersByTimeAsync(832); await Vue.nextTick();
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(0);
        expect(f.card.classList.contains('fr-short-viewport')).toBe(true);
        Object.defineProperties(f.card, {clientHeight: {value: 78, configurable: true},
            scrollHeight: {value: 392, configurable: true}});
        f.card.getBoundingClientRect = () => ({left: 12, top: 304, right: 390, bottom: 382, width: 378, height: 78}) as DOMRect;
        f.card.setPointerCapture = vi.fn();
        const events: Event[] = [];
        const touch = (type: string, fields: Record<string, unknown> = {}, deliverToCard = true) => {
            const values = {isTrusted: true, pointerType: 'touch', isPrimary: true, button: 0,
                pointerId: 7, clientX: 120, clientY: 360, ...fields};
            // Model document capture's closed-shadow retarget, then deliver the real card's SFC listener.
            f.send('document', type, {target: f.host, ...values});
            if (deliverToCard) {
                const event = new f.renderPort!.domWindow.Event(type, {bubbles: true, cancelable: true});
                for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, {value});
                f.card.dispatchEvent(event); events.push(event);
            }
        };
        const scrollHost = (y: number) => { Object.assign(f.window, {scrollY: y}); f.send('window', 'scroll'); };
        return {...f, touch, scrollHost, events};
    }

    async function readingRevealFixture(scale = 1) {
        const f = await keyboardTransitionFixture();
        f.focus(); f.keyboardScroll(); await vi.advanceTimersByTimeAsync(801);
        f.state.pageZoom = 1 / scale;
        f.browser.runtime.sendMessage.mockResolvedValue(undefined);
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402, scrollY: 557,
            screen: {orientation: {type: 'landscape-primary'}}, scroll: vi.fn(), scrollTo: vi.fn(), scrollBy: vi.fn()});
        // This DOM port has no safe-area CSS probe: model the actual78px safe port directly.
        Object.assign(f.viewport, {width: 874, height: 78, offsetTop: 304});
        Object.defineProperties(f.card, {clientTop: {value: 0, configurable: true},
            clientHeight: {value: 78 / scale, configurable: true}, scrollHeight: {value: 392 / scale, configurable: true}});
        f.card.scrollTop = 252 / scale;
        // Actual Safari uses visual-origin BCR here even though VV.offsetTop is304.
        f.card.getBoundingClientRect = () => ({left: 74, top: 0, right: 462, bottom: 78, width: 388, height: 78}) as DOMRect;
        const inputRect = vi.fn(() => {
            const top = 334 - f.card.scrollTop * scale;
            return {left: 100, right: 393, top, bottom: top + 44 * scale, width: 293, height: 44 * scale} as DOMRect;
        });
        f.input.getBoundingClientRect = inputRect;
        f.input.focus = vi.fn(); f.input.scrollIntoView = vi.fn();
        f.input.value = 'draft remains in the original input';
        return {...f, inputRect};
    }

    it.each([1, 0.5])('reveals only the same focused input in its own short-card client port at popup scale%s and nonzero VV offset', async scale => {
        const f = await readingRevealFixture(scale);
        f.send('window', 'orientationchange'); await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(f.card.classList.contains('fr-short-viewport')).toBe(true);
        expect(f.card.scrollTop).toBeCloseTo(260 / scale + 44);
        expect(f.inputRect).toHaveBeenCalledTimes(1);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.input.value).toBe('draft remains in the original input');
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        expect((f.window as typeof f.window & {scrollY: number}).scrollY).toBe(557);
        expect(f.input.focus).not.toHaveBeenCalled(); expect(f.input.scrollIntoView).not.toHaveBeenCalled();
        const win = f.window as typeof f.window & {scroll: ReturnType<typeof vi.fn>; scrollTo: ReturnType<typeof vi.fn>; scrollBy: ReturnType<typeof vi.fn>};
        expect(win.scroll).not.toHaveBeenCalled(); expect(win.scrollTo).not.toHaveBeenCalled(); expect(win.scrollBy).not.toHaveBeenCalled();
        // A later own scroll/content positioning/unchanged viewport must not pull the reader back.
        f.card.scrollTop = 252 / scale; f.send('window', 'scroll', {target: f.host});
        f.state.schedulePositionUpdate(); f.send('window', 'resize');
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(f.card.scrollTop).toBe(252 / scale);
        expect(f.inputRect).toHaveBeenCalledTimes(1);
        expect(f.shadow.activeElement).toBe(f.input);
    });

    it.each(['owned pointer', 'wheel', 'editing key', 'source replaced', 'expired', 'unmount'] as const)(
        'does not execute a cancelled or stale focused reveal: %s', async reason => {
            const f = await readingRevealFixture();
            f.send('window', 'orientationchange'); await vi.advanceTimersByTimeAsync(16);
            expect(f.state.readingKeyboardFocus.reveal).toBe(true);
            if (reason === 'owned pointer') f.send('document', 'pointerdown', {target: f.host, pointerType: 'touch', button: 0});
            if (reason === 'wheel') f.send('window', 'wheel');
            if (reason === 'editing key') f.send('document', 'keydown', {target: f.host, key: ' ', composedPath: () => [f.host], preventDefault: vi.fn(), stopPropagation: vi.fn()});
            if (reason === 'source replaced') f.state.snapshot = {...f.selected, text: 'new source'};
            if (reason === 'expired') vi.setSystemTime(Date.now() + 801);
            if (reason === 'unmount') f.unmount();
            await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
            expect(f.inputRect).not.toHaveBeenCalled();
            expect(f.card.scrollTop).toBe(252);
            expect((f.window as typeof f.window & {scrollY: number}).scrollY).toBe(557);
            expect(f.lifecycleErrors).not.toHaveBeenCalled();
        },
    );

    it.each(['insufficient port', 'source disconnected'] as const)('does not claim or force complete input visibility for %s', async reason => {
        const f = await readingRevealFixture();
        if (reason === 'insufficient port') Object.defineProperty(f.card, 'clientHeight', {value: 32});
        else f.source.isConnected = false;
        f.send('window', 'orientationchange'); await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(f.card.scrollTop).toBe(252);
        expect((f.window as typeof f.window & {scrollY: number}).scrollY).toBe(557);
        expect(f.input.focus).not.toHaveBeenCalled(); expect(f.input.scrollIntoView).not.toHaveBeenCalled();
        if (reason === 'source disconnected') expect(f.state.showTooltip).toBe(false);
        else {
            expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
            expect(f.shadow.activeElement).toBe(f.input);
            expect(f.controller.signal.aborted).toBe(false);
        }
    });

    it.each(['pointerup', 'pointercancel'] as const)('keeps an internal short-card pan and its tiny host tail until its fixed deadline after %s', async end => {
        const f = await shortReadingCardFixture();
        f.input.value = '未提交的追问';
        f.touch('pointerdown'); f.touch('pointermove', {clientY: 340});
        const deadline = f.state.readingCardPan.expiresAt;
        expect(deadline).toBe(Date.now() + 400);
        await vi.advanceTimersByTimeAsync(85);
        f.touch('pointermove', {clientY: 320}); f.touch(end, {clientY: 320});
        await vi.advanceTimersByTimeAsync(15);
        f.scrollHost(558); await Vue.nextTick();
        // The unit port models real card scroll progress; native/browser proof must observe it independently.
        f.card.scrollTop = 72; f.send('window', 'scroll', {target: f.host});
        expect(f.card.scrollTop).toBe(72);
        expect(f.state.readingCardPan.expiresAt).toBe(deadline);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.input.value).toBe('未提交的追问');
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        expect(f.events.every(event => !event.defaultPrevented)).toBe(true);
        expect(f.card.setPointerCapture).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(deadline - Date.now() + 1);
        expect(f.state.readingCardPan).toBeUndefined();
        // A later reverse gesture needs a new local trusted down and movement, never the expired allowance.
        f.touch('pointerdown', {clientY: 320}); f.touch('pointermove', {clientY: 350}); f.touch(end, {clientY: 350});
        const reverseDeadline = f.state.readingCardPan.expiresAt;
        expect(reverseDeadline).toBeGreaterThan(deadline);
        f.card.scrollTop = 0; f.send('window', 'scroll', {target: f.host}); f.scrollHost(557);
        expect(f.card.scrollTop).toBe(0);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(reverseDeadline - Date.now() + 1);
        f.scrollHost(557); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
    });

    it.each(['no local card event', 'no vertical move', 'normal height', 'not overflow', 'mouse', 'untrusted', 'foreign pointer', 'outside card'] as const)(
        'does not exempt host scrolling without a proven short-card touch pan: %s', async reason => {
            const f = await shortReadingCardFixture();
            if (reason === 'normal height') {
                f.viewport.height = 376; f.send('window', 'resize'); await vi.advanceTimersByTimeAsync(32);
            }
            if (reason === 'not overflow') Object.defineProperty(f.card, 'scrollHeight', {value: 78});
            const fields = reason === 'mouse' ? {pointerType: 'mouse'} : reason === 'untrusted' ? {isTrusted: false} : {};
            f.touch('pointerdown', fields, reason !== 'no local card event');
            if (reason !== 'no vertical move') f.touch('pointermove', {...fields,
                clientY: reason === 'outside card' ? 250 : 340, ...(reason === 'foreign pointer' ? {pointerId: 9} : {})});
            f.scrollHost(558); await Vue.nextTick();
            expect(f.state.showTooltip).toBe(false);
            expect(f.controller.signal.aborted).toBe(true);
            expect(f.listeners.get('window:wheel')?.size).toBe(0);
        },
    );

    it.each(['outside touch', 'wheel', 'page key', 'input edit', 'focusout', 'window blur', 'pagehide', 'source changed', 'scale changed', 'width changed', 'nested scroll', 'large host pan', 'cumulative host travel', 'unmount'] as const)(
        'revokes the internal pan for intent, identity loss, excessive host motion or teardown: %s', async reason => {
            const f = await shortReadingCardFixture();
            f.touch('pointerdown'); f.touch('pointermove', {clientY: 340}); f.touch('pointercancel', {clientY: 340});
            expect(f.state.readingCardPan.expiresAt).toBeGreaterThan(Date.now());
            if (reason === 'outside touch') f.send('document', 'pointerdown', {target: f.renderPort!.document.createElement('p'), pointerType: 'touch', button: 0});
            if (reason === 'wheel') f.send('window', 'wheel');
            if (reason === 'page key') f.send('document', 'keydown', {target: f.host, key: 'PageDown'});
            if (reason === 'input edit') f.domEvent('input');
            if (reason === 'focusout') f.domEvent('focusout');
            if (reason === 'window blur') f.send('window', 'blur');
            if (reason === 'pagehide') f.send('window', 'pagehide');
            if (reason === 'source changed') f.source.isConnected = false;
            if (reason === 'scale changed') f.viewport.scale = 1.2;
            if (reason === 'width changed') f.viewport.width = 402;
            if (reason === 'nested scroll') f.send('window', 'scroll', {target: f.renderPort!.document.createElement('div')});
            if (reason === 'large host pan') Object.assign(f.window, {scrollY: 560});
            if (reason === 'cumulative host travel') { f.scrollHost(558); f.scrollHost(557); Object.assign(f.window, {scrollY: 558}); }
            if (reason === 'unmount') f.unmount();
            f.send('window', 'scroll'); await Vue.nextTick();
            expect(f.state.readingCardPan).toBeUndefined();
            if (reason !== 'unmount') expect(f.state.showTooltip).toBe(false);
            else expect(f.shadow.querySelector('.fr-translation-tooltip')).toBeNull();
            expect(f.controller.signal.aborted).toBe(true);
            expect(f.listeners.get('window:wheel')?.size).toBe(0);
            expect(f.lifecycleErrors).not.toHaveBeenCalled();
        },
    );

    it('keeps the rendered owned card and request during the actual stable-scale keyboard document pan', async () => {
        const f = await keyboardTransitionFixture();
        f.focus(); await vi.advanceTimersByTimeAsync(231); f.keyboardScroll(); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(true);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(20);
        expect(f.state.viewportSize).toMatchObject({width: 402, height: 376, top: 284});
        expect(f.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('keeps the same focused reading input and request through short-card fallback and viewport recovery', async () => {
        const f = await keyboardTransitionFixture();
        f.focus();
        Object.assign(f.viewport, {height: 58, offsetTop: 320});
        f.send('window', 'resize');
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(f.card.classList.contains('fr-short-viewport')).toBe(true);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.state.readingKeyboardFocus.input).toBe(f.input);
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        Object.assign(f.viewport, {height: 754, offsetTop: 0});
        f.send('window', 'resize');
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(f.card.classList.contains('fr-short-viewport')).toBe(false);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.controller.signal.aborted).toBe(false);
        f.unmount();
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.lifecycleErrors).not.toHaveBeenCalled();
    });


    it('expires the initial pan window without renewing on scroll and retains only the owned focus identity', async () => {
        const f = await keyboardTransitionFixture(); f.focus();
        expect(f.listeners.get('window:wheel')?.size).toBe(1);
        await vi.advanceTimersByTimeAsync(700); f.keyboardScroll();
        expect(f.state.showTooltip).toBe(true);
        await vi.advanceTimersByTimeAsync(101);
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(0);
        expect(f.listeners.get('window:wheel')?.size).toBe(1);
        f.keyboardScroll(); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBeNull();
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
    });

    it.each(['viewport first', 'scroll first'] as const)('preserves the same edited input during one later rotation pan (%s) without renewing its deadline', async order => {
        const f = await keyboardTransitionFixture(); f.focus();
        await vi.advanceTimersByTimeAsync(231); f.keyboardScroll();
        await vi.advanceTimersByTimeAsync(1000);
        f.input.value = '未提交的追问'; f.domEvent('input');
        expect(f.state.readingKeyboardFocus.input).toBe(f.input);
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(0);
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402});
        Object.assign(f.viewport, {width: 874, height: 58, offsetTop: 338});
        f.send('window', 'orientationchange');
        if (order === 'viewport first') await vi.advanceTimersByTimeAsync(16);
        f.send('window', 'scroll'); await Vue.nextTick();
        const deadline = f.state.readingKeyboardFocus.expiresAt;
        expect(deadline).toBeGreaterThan(Date.now());
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.input.value).toBe('未提交的追问');
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(700);
        f.send('window', 'resize'); f.send('window', 'scroll');
        await vi.advanceTimersByTimeAsync(16);
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(deadline);
        expect(f.state.showTooltip).toBe(true);
        await vi.advanceTimersByTimeAsync(101);
        f.send('window', 'scroll'); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
    });

    it.each(['screen', 'legacy'] as const)('preserves the same focused input when explicit %s rotation precedes visual viewport width without extending the deadline', async api => {
        const f = await keyboardTransitionFixture();
        const orient = (landscape: boolean) => Object.assign(f.window, api === 'screen'
            ? {screen: {orientation: {type: landscape ? 'landscape-primary' : 'portrait-primary'}}}
            : {orientation: landscape ? 90 : 0});
        orient(false);
        Object.assign(f.window, {innerWidth: 402, innerHeight: 714});
        f.viewport.height = 714;
        f.focus();
        await vi.advanceTimersByTimeAsync(311);
        Object.assign(f.viewport, {height: 376, offsetTop: 338});
        f.send('window', 'scroll');
        await vi.advanceTimersByTimeAsync(2106);
        f.input.value = '未提交的追问'; f.domEvent('input');
        // Actual Safari order: orientation changes first; VV is still the portrait keyboard viewport.
        orient(true); f.send('window', 'orientationchange');
        await vi.advanceTimersByTimeAsync(66);
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402});
        f.viewport.offsetTop = 0;
        f.send('window', 'resize'); f.send('window', 'scroll'); await Vue.nextTick();
        const deadline = f.state.readingKeyboardFocus.expiresAt;
        expect(deadline).toBeGreaterThan(Date.now());
        expect(f.viewport.width).toBe(402);
        expect(f.shadow.querySelector('.fr-translation-tooltip')).toBe(f.card);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.input.value).toBe('未提交的追问');
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
        // Later VV catch-up and repeated resize/scroll refresh geometry, never the 800ms deadline.
        await vi.advanceTimersByTimeAsync(100);
        Object.assign(f.viewport, {width: 874, height: 58});
        f.send('window', 'resize'); f.send('window', 'scroll');
        await vi.advanceTimersByTimeAsync(16); await Vue.nextTick();
        expect(f.state.readingKeyboardFocus).toMatchObject({width: 874, height: 58, expiresAt: deadline});
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.controller.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
        f.send('window', 'resize'); f.send('window', 'scroll');
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(deadline);
        expect(f.state.showTooltip).toBe(true);
        await vi.advanceTimersByTimeAsync(2);
        f.send('window', 'scroll'); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
    });

    it.each(['screen', 'legacy'] as const)('uses explicit %s orientation for a return to portrait while the keyboard keeps layout height short', async api => {
        const f = await keyboardTransitionFixture();
        const orient = (landscape: boolean) => Object.assign(f.window, api === 'screen'
            ? {screen: {orientation: {type: landscape ? 'landscape-primary' : 'portrait-primary'}}}
            : {orientation: landscape ? 90 : 0});
        orient(false); f.focus(); f.keyboardScroll();
        await vi.advanceTimersByTimeAsync(801);
        orient(true); Object.assign(f.window, {innerWidth: 874, innerHeight: 58});
        Object.assign(f.viewport, {width: 874, height: 58});
        f.send('window', 'scroll');
        expect(f.state.showTooltip).toBe(true);
        await vi.advanceTimersByTimeAsync(801);
        orient(false); Object.assign(f.window, {innerWidth: 402, innerHeight: 376});
        Object.assign(f.viewport, {width: 402, height: 376});
        f.send('window', 'scroll'); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(true);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.controller.signal.aborted).toBe(false);
        f.unmount();
        expect(f.listeners.get('window:wheel')?.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the current keyboard pan on input without exempting a later ordinary document scroll', async () => {
        const f = await keyboardTransitionFixture(); f.focus(); f.keyboardScroll();
        expect(f.state.showTooltip).toBe(true);
        f.domEvent('input');
        expect(f.state.readingKeyboardFocus.input).toBe(f.input);
        expect(f.state.readingKeyboardFocus.expiresAt).toBe(0);
        f.keyboardScroll(); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.controller.signal.aborted).toBe(true);
    });

    it.each(['direct input', 'closed-shadow retarget'] as const)('keeps edited input rotation eligibility after captured editing keys (%s)', async targetMode => {
        const f = await keyboardTransitionFixture(); f.focus(); f.keyboardScroll();
        expect(f.document.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        const preventDefault = vi.fn(), stopPropagation = vi.fn();
        const inputStop = vi.fn((event: Event) => {
            // The registered document capture port has already ended this pan before the input's bubble stop.
            expect(f.state.readingKeyboardFocus.expiresAt).toBe(0); event.stopPropagation();
        });
        f.input.addEventListener('keydown', inputStop);
        for (const key of [' ', 'Home', 'ArrowDown']) {
            const target = targetMode === 'direct input' ? f.input : f.host;
            const path = targetMode === 'direct input' ? [f.input, f.card, f.shadow, f.host] : [f.host];
            f.send('document', 'keydown', {target, key, composedPath: () => path, preventDefault, stopPropagation});
            f.domEvent('keydown');
            expect(f.state.readingKeyboardFocus.input).toBe(f.input);
        }
        f.input.value = 'draft with spaces'; f.domEvent('input');
        expect(inputStop).toHaveBeenCalledTimes(3);
        expect(preventDefault).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(801);
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402});
        Object.assign(f.viewport, {width: 874, height: 58});
        f.send('window', 'scroll'); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(true);
        expect(f.shadow.activeElement).toBe(f.input);
        expect(f.card.querySelector('.fr-reading-followup input')).toBe(f.input);
        expect(f.input.value).toBe('draft with spaces');
        expect(f.state.snapshot).toBe(f.selected);
        expect(f.controller.signal.aborted).toBe(false);
    });

    it.each(['outside target', 'foreign focus'] as const)('does not retain editing-key eligibility for %s', async reason => {
        const f = await keyboardTransitionFixture(); f.focus();
        const foreign = f.renderPort!.document.createElement('input');
        if (reason === 'foreign focus') f.setActive(foreign);
        const target = reason === 'outside target' ? foreign : f.input;
        f.send('document', 'keydown', {target, key: ' ', composedPath: () => [target]});
        expect(f.state.readingKeyboardFocus).toBeUndefined();
        Object.assign(f.window, {innerWidth: 874, innerHeight: 402});
        Object.assign(f.viewport, {width: 874, height: 58});
        f.send('window', 'scroll'); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
        expect(f.controller.signal.aborted).toBe(true);
    });

    it.each(['untrusted focus', 'no owned gesture', 'stale gesture', 'readonly', 'no viewport', 'no auto-dismiss'] as const)(
        'does not arm keyboard protection for %s', async reason => {
            const f = await keyboardTransitionFixture();
            if (reason === 'readonly') f.input.setAttribute('readonly', '');
            if (reason === 'no viewport') Object.assign(f.window, {visualViewport: undefined});
            if (reason === 'no auto-dismiss') { f.config.selectionTranslatorAutoDismiss = false; f.notifyConfig(); }
            if (reason === 'no owned gesture') vi.setSystemTime(0);
            if (reason === 'stale gesture') {
                f.send('document', 'pointerdown', {target: f.host, pointerType: 'touch', button: 0});
                await vi.advanceTimersByTimeAsync(501);
            }
            f.focus(reason !== 'untrusted focus', reason !== 'no owned gesture' && reason !== 'stale gesture');
            expect(f.listeners.get('window:wheel')?.size ?? 0).toBe(0);
            f.keyboardScroll(); await Vue.nextTick();
            expect(f.state.showTooltip).toBe(reason === 'no auto-dismiss');
        },
    );

    it.each(['ordinary document scroll', 'nested scroll', 'pinch zoom', 'width change', 'layout rotation without viewport width change', 'focus lost', 'readonly after focus', 'detached input', 'changed source', 'disconnected source'] as const)(
        'keeps normal dismissal for %s during the short focus window', async reason => {
            const f = await keyboardTransitionFixture(); f.focus();
            Object.assign(f.viewport, {height: 376, offsetTop: 284});
            let target: unknown = f.document;
            if (reason === 'ordinary document scroll') f.viewport.height = 754;
            if (reason === 'nested scroll') target = f.renderPort!.document.createElement('div');
            if (reason === 'pinch zoom') f.viewport.scale = 1.2;
            if (reason === 'width change') f.viewport.width = 300;
            if (reason === 'layout rotation without viewport width change') { Object.assign(f.window, {innerWidth: 874, innerHeight: 402}); f.viewport.height = 754; }
            if (reason === 'focus lost') f.setActive(null);
            if (reason === 'readonly after focus') f.input.setAttribute('readonly', '');
            if (reason === 'detached input') f.input.remove();
            if (reason === 'changed source') f.state.snapshot = {...f.selected, text: 'A different source.'};
            if (reason === 'disconnected source') f.source.isConnected = false;
            f.send('window', 'scroll', {target}); await Vue.nextTick();
            expect(f.state.showTooltip).toBe(false);
            expect(f.controller.signal.aborted).toBe(true);
            expect(f.listeners.get('window:wheel')?.size).toBe(0);
        },
    );

    it.each(['wheel', 'touch move', 'outside pointer', 'scroll key', 'focusout', 'window blur', 'pagehide'] as const)(
        'revokes the owned rotation identity and temporary window for deliberate intent or teardown: %s', async reason => {
            const f = await keyboardTransitionFixture(); f.focus();
            await vi.advanceTimersByTimeAsync(801);
            Object.assign(f.window, {innerWidth: 874, innerHeight: 402});
            Object.assign(f.viewport, {width: 874, height: 58});
            f.send('window', 'resize'); await vi.advanceTimersByTimeAsync(16);
            expect(f.state.readingKeyboardFocus.rotating).toBe(true);
            const preventDefault = vi.fn(), stopPropagation = vi.fn();
            if (reason === 'wheel') f.send('window', 'wheel', {preventDefault, stopPropagation});
            if (reason === 'touch move') f.send('document', 'pointermove', {pointerType: 'touch'});
            if (reason === 'outside pointer') f.send('document', 'pointerdown', {target: f.renderPort!.document.createElement('p'), pointerType: 'touch', button: 0});
            if (reason === 'scroll key') f.send('document', 'keydown', {target: f.host, key: 'PageDown', preventDefault, stopPropagation});
            if (reason === 'focusout') f.domEvent(reason);
            if (reason === 'window blur') f.send('window', 'blur');
            if (reason === 'pagehide') f.send('window', 'pagehide');
            expect(preventDefault).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
            expect(f.listeners.get('window:wheel')?.size).toBe(0);
            f.keyboardScroll(); await Vue.nextTick();
            expect(f.state.showTooltip).toBe(false);
            expect(f.controller.signal.aborted).toBe(true);
        },
    );

    it('ignores an untrusted wheel, then unregisters the one observer and timer on unmount', async () => {
        const f = await keyboardTransitionFixture(); f.focus();
        f.send('window', 'wheel', {isTrusted: false}); f.keyboardScroll();
        expect(f.state.showTooltip).toBe(true);
        f.unmount(); expect(f.listeners.get('window:wheel')?.size).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.controller.signal.aborted).toBe(true);
        expect(f.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['chrome', 'firefox', 'userscript'] as const)('does not register a page wheel listener or change %s dismissal', async target => {
        const f = await keyboardTransitionFixture(target); f.focus();
        expect(f.listeners.get('window:wheel')?.size ?? 0).toBe(0);
        expect(f.listeners.get('document:wheel')?.size ?? 0).toBe(0);
        f.keyboardScroll(); await Vue.nextTick();
        expect(f.state.showTooltip).toBe(false);
    });
});


it.each(['close', 'unmount'] as const)('does not recreate copy feedback after %s while the clipboard is pending', async boundary => {
    const fixture = mountSelection();
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>(done => {resolve = done;}));
    vi.stubGlobal('navigator', {clipboard: {writeText}});
    const copying = fixture.state.copyText('Original source', 'source');
    if (boundary === 'close') fixture.state.hideAll();
    else fixture.unmount();
    const remainingTimers = vi.getTimerCount();
    resolve(); await copying;
    expect(fixture.state.copySuccess).toBe(false);
    expect(fixture.state.copiedTextKind).toBeNull();
    expect(vi.getTimerCount()).toBe(remainingTimers);
});

describe('selection settings link response ownership through the rendered toolbar', () => {
    async function settingsFixture() {
        const fixture = mountSelection(false, {acceptsRange: () => true}, {}, true);
        fixture.config.harness.service = services.openai;
        fixture.config.harness.enabled = false;
        fixture.state.selectionConfigVersion += 1;
        fixture.notifyConfig();
        await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick();
        const text = 'Read this complete source.';
        Object.assign(fixture.state, {snapshot: {text, parts: [{kind: 'text', text}], range: {}}, selectedText: text, translationResult: '完整译文', showTooltip: true});
        await Vue.nextTick();
        const entry = [...fixture.renderPort!.root.querySelectorAll('button')].find(button => button.textContent === '配置 AI 讲解')!;
        expect(entry, fixture.renderPort!.root.innerHTML).toBeDefined();
        return {...fixture, entry};
    }
    it.each(['response', 'rejection'] as const)('shows current %s failures without leaving the source card', async kind => {
        const fixture = await settingsFixture();
        fixture.browser.runtime.sendMessage.mockImplementation(message => message.type !== 'openOptionsPage' ? Promise.resolve({success: true})
            : kind === 'response' ? Promise.resolve({success: false}) : Promise.reject(new Error('extension disconnected')));
        await fixture.renderPort!.click(fixture.entry); await Vue.nextTick();
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith({type:'openOptionsPage',section:'settings-selection'});
        expect(fixture.renderPort!.root.textContent).toContain('请从扩展设置进入划词翻译');
        expect(fixture.state.showTooltip).toBe(true);
    });
    it.each(['close', 'unmount', 'replacement'] as const)('ignores a late settings failure after %s', async boundary => {
        const fixture = await settingsFixture(), response = deferredTts();
        fixture.browser.runtime.sendMessage.mockImplementation(message => message.type === 'openOptionsPage' ? response.promise : Promise.resolve({success: true}));
        const opening = fixture.renderPort!.click(fixture.entry);
        if (boundary === 'close') await fixture.renderPort!.click(fixture.renderPort!.root.querySelector('.fr-close-btn')!);
        else if (boundary === 'unmount') fixture.unmount();
        else {fixture.state.snapshot = {...fixture.state.snapshot,text:'Replacement source'};fixture.state.selectedText='Replacement source';await Vue.nextTick();}
        const timers = vi.getTimerCount();response.resolve({success:false});await opening;await Vue.nextTick();
        expect(fixture.state.noticeMessage).toBe('');expect(vi.getTimerCount()).toBe(timers);
    });
});

describe('rendered speech controls consume native completion events', () => {
    it.each(['edge-page', 'google-page', 'dictionary', 'browser'] as const)('releases %s playback on completion and ignores callbacks from an older audio owner', async route => {
        const fixture = mountSelection(false, {acceptsRange: () => true}, {}, true);
        fixture.config.selectionTtsMode = 'online-only';
        fixture.notifyConfig();await Vue.nextTick();await Promise.resolve();await Vue.nextTick();
        const audios: Array<any> = [], utterances: Array<any> = [];
        class AudioPort {
            currentTime=1;duration=4;preload='';onended:(()=>void)|null=null;onerror:(()=>void)|null=null;
            play=vi.fn(async()=>undefined);pause=vi.fn();removeAttribute=vi.fn();
            constructor(public src:string){audios.push(this)}
        }
        vi.stubGlobal('Audio',AudioPort);
        vi.stubGlobal('SpeechSynthesisUtterance',route==='browser'?class {constructor(public text:string){utterances.push(this)}}:undefined);
        Object.assign(fixture.window.speechSynthesis,{getVoices:()=>[],speak:vi.fn()});
        vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:selection-audio');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
        fixture.browser.runtime.sendMessage.mockImplementation(message=>Promise.resolve(message.type==='selectionTts'
            ?route==='edge-page'?{success:true,transport:'page',audioBase64:btoa('audio')}: {success:false}
            :message.type==='selectionTtsGoogle'?{success:false}:{success:true,zoom:1}));
        const text=route==='dictionary'?'hello':'Read this complete source.';
        Object.assign(fixture.state,{snapshot:{text,parts:[{kind:'text',text}],range:{}},selectedText:text,translationResult:'完整译文',showTooltip:true});
        if(route==='dictionary')fixture.state.wordCard={word:'hello',normalizedWord:'hello',meanings:[],sources:[],phonetics:[{text:'/hello/',audio:'https://dictionary.test/hello.mp3',label:'美式'}]};
        await Vue.nextTick();const port=fixture.renderPort!;
        const selector=route==='dictionary'?'.fr-word-pronunciations .fr-text-audio-btn':'.fr-original-text .fr-text-audio-btn';
        const play=()=>port.click(port.root.querySelector(selector)!);
        await play();await Vue.nextTick();expect(fixture.state.isPlaying).toBe(true);
        const first=route==='browser'?utterances[0]:audios[0],oldEnded=first[route==='browser'?'onend':'onended'],oldError=first.onerror;
        if(route!=='browser'){
            await vi.advanceTimersByTimeAsync(100);await Vue.nextTick();const seeks=port.root.querySelectorAll('.fr-seek-btn');
            await port.click(seeks[1]);expect(first.currentTime).toBe(4);await port.click(seeks[0]);expect(first.currentTime).toBe(0);
        }
        await play();await play();await Vue.nextTick();
        expect(fixture.state.isPlaying).toBe(true);const current=route==='browser'?utterances[1]:audios[1];
        oldEnded?.();oldError?.({error:'network'});await Vue.nextTick();
        expect(fixture.state.isPlaying).toBe(true);expect(port.root.querySelector(selector)!.getAttribute('title')).toContain('停止播放');
        current[route==='browser'?'onend':'onended']();await Vue.nextTick();
        expectAudioReset(fixture.state);expect(port.root.querySelector(selector)!.getAttribute('title')).toMatch(/^播放/);
        if(route!=='browser'){expect(current.pause).toHaveBeenCalledOnce();expect(current.removeAttribute).toHaveBeenCalledWith('src');expect(current.onended).toBeNull();expect(current.onerror).toBeNull();}
        if(route==='edge-page')expect(revoke).toHaveBeenCalledTimes(2);
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['edge-page', 'google-page', 'dictionary', 'browser'] as const)('makes %s media errors retryable through the same rendered button and releases progress resources', async route => {
        const fixture=mountSelection(false,{acceptsRange:()=>true},{},true);fixture.config.selectionTtsMode='online-only';await Vue.nextTick();
        const objects:Array<any>=[];
        vi.stubGlobal('Audio',class {currentTime=1;duration=3;play=vi.fn(async()=>undefined);pause=vi.fn();removeAttribute=vi.fn();constructor(public src:string){objects.push(this)}});
        vi.stubGlobal('SpeechSynthesisUtterance',route==='browser'?class {constructor(public text:string){objects.push(this)}}:undefined);
        Object.assign(fixture.window.speechSynthesis,{getVoices:()=>[],speak:vi.fn()});
        vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:selection-error');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
        fixture.browser.runtime.sendMessage.mockImplementation(message=>Promise.resolve(message.type==='selectionTts'&&route==='edge-page'?{success:true,transport:'page',audioBase64:btoa('audio')}:message.type==='selectionTts'||message.type==='selectionTtsGoogle'?{success:false}:{success:true,zoom:1}));
        const text=route==='dictionary'?'hello':'Read this complete source.';
        Object.assign(fixture.state,{snapshot:{text,parts:[{kind:'text',text}],range:{}},selectedText:text,translationResult:'完整译文',showTooltip:true});
        if(route==='dictionary')fixture.state.wordCard={word:'hello',normalizedWord:'hello',meanings:[],sources:[],phonetics:[{text:'/hello/',audio:'https://dictionary.test/hello.mp3',label:'美式'}]};
        await Vue.nextTick();const port=fixture.renderPort!,selector=route==='dictionary'?'.fr-word-pronunciations .fr-text-audio-btn':'.fr-original-text .fr-text-audio-btn';
        await port.click(port.root.querySelector(selector)!);expect(fixture.state.isPlaying).toBe(true);
        objects[0].onerror({error:'network'});await Vue.nextTick();
        expect(fixture.state.isPlaying).toBe(false);expect(fixture.state.audioPosition).toBeNull();expect(fixture.state.sourceAudioProgress).toBeNull();expect(port.root.querySelector(selector)!.getAttribute('title')).toMatch(/^播放/);
        if(route!=='browser'){expect(objects[0].pause).toHaveBeenCalledOnce();expect(objects[0].removeAttribute).toHaveBeenCalledWith('src');}
        if(route==='edge-page')expect(revoke).toHaveBeenCalledOnce();
        await port.click(port.root.querySelector(selector)!);await Vue.nextTick();expect(objects).toHaveLength(2);expect(fixture.state.isPlaying).toBe(true);
        fixture.unmount();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
});


it('connects rendered reading navigation, evidence and source playback to the current selection', async () => {
    selectionPorts.readingControls=true;
    const text='Read this complete source.',captureReading=vi.fn(()=>({text,context:text,sentence:text}));
    const fixture=mountSelection(false,{acceptsRange:()=>true,captureReading},{},true);
    fixture.config.harness={...fixture.config.harness,enabled:true,service:services.openai,actions:['meaning','grammar'],defaultAction:'meaning'};
    fixture.state.selectionConfigVersion+=1;fixture.notifyConfig();await Vue.nextTick();await Promise.resolve();await Vue.nextTick();
    Object.assign(fixture.state,{snapshot:fixture.selectedSnapshot(text),selectedText:text,translationResult:'完整译文',showTooltip:true});await Vue.nextTick();
    const port=fixture.renderPort!;const history=[...port.root.querySelectorAll('button')].find(button=>button.textContent==='记录')!;
    await port.click(history);await Vue.nextTick();expect(captureReading).toHaveBeenCalledOnce();expect(port.root.querySelector('[data-reading-port]')!.getAttribute('data-history')).toBe('true');
    const anchor=selectionPorts.evidence;
    await port.click(port.root.querySelector('[data-reading-check]')!);await port.click(port.root.querySelector('[data-reading-locate]')!);await port.click(port.root.querySelector('[data-reading-clear]')!);
    expect(anchor.check).toHaveBeenCalledOnce();expect(anchor.locate).toHaveBeenCalledWith('source quote');expect(anchor.suspend).toHaveBeenCalledOnce();
    await port.click(port.root.querySelector('[data-reading-view]')!);await Vue.nextTick();expect(port.root.querySelector('[data-reading-port]')!.getAttribute('data-history')).toBe('false');expect([...port.root.querySelectorAll('.fr-study-toolbar button')].find(button=>button.textContent==='词性与句法')!.getAttribute('aria-pressed')).toBe('');
    anchor.invalidate();await Vue.nextTick();expect(anchor.suspend).toHaveBeenCalledTimes(2);expect(port.root.querySelector('[data-reading-port]')!.getAttribute('data-revision')).toBe('1');
    prepareTts(fixture,[Promise.resolve({success:true,transport:'offscreen'})]);await port.click(port.root.querySelector('[data-reading-play]')!);await Promise.resolve();await Vue.nextTick();expect(fixture.state.isPlaying).toBe(true);
    await port.click(port.root.querySelector('[data-reading-change]')!);expectAudioReset(fixture.state);
    await port.click([...port.root.querySelectorAll('.fr-study-toolbar button')].find(button=>button.textContent==='翻译')!);await Vue.nextTick();expect(fixture.state.readingMode).toBe(false);expect(port.root.querySelector('.fr-original-text')).not.toBeNull();
    await port.click([...port.root.querySelectorAll('.fr-study-toolbar button')].find(button=>button.textContent==='词性与句法')!);await Vue.nextTick();expect(fixture.state.readingInitialAction).toBe('grammar');expect(fixture.state.readingMode).toBe(true);
    await port.click(port.root.querySelector('.fr-close-btn')!);expect(anchor.dispose).toHaveBeenCalledOnce();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
});

it('shares only the currently displayed completed translation from the actual toolbar',async()=>{
    selectionPorts.shareMounted=true;const fixture=mountSelection(false,{acceptsRange:()=>true},{},true);await Vue.nextTick();
    const text='Share this selected source.';Object.assign(fixture.state,{snapshot:{text,parts:[{kind:'text',text}],range:{}},selectedText:text,translationResult:'当前已完成的译文',showTooltip:true});await Vue.nextTick();
    const port=fixture.renderPort!;await port.click(port.root.querySelector('.fr-share-card-entry')!);expect(selectionPorts.share).toHaveBeenCalledWith({original:text,translation:'当前已完成的译文'});
    fixture.state.isLoading=true;await Vue.nextTick();expect(port.root.querySelector('.fr-share-card-entry')).toBeNull();
});

it('retries the dictionary from its rendered error, copies the selected word and translation, and toggles Chinese support',async()=>{
    const fixture=mountSelection(false,{acceptsRange:()=>true},{},true);await Vue.nextTick();
    const card={word:'hello',normalizedWord:'hello',phonetics:[],sources:[{id:'fixture',label:'Dictionary',url:'https://dictionary.test/hello'}],meanings:[{partOfSpeech:'感叹词',definitions:[{definition:'A greeting',translatedDefinition:'打招呼',example:'Hello again',translatedExample:'再次问好'}]}]};
    let lookups=0;fixture.browser.runtime.sendMessage.mockImplementation(message=>Promise.resolve(message.type==='selectionWordLookup'?++lookups===1?{success:false}:{success:true,data:card}:message.type==='selectionTts'?{success:true,transport:'offscreen'}:{success:true,zoom:1}));
    vi.spyOn(console,'warn').mockImplementation(()=>{});const writeText=vi.fn(async(_text:string)=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});
    fixture.translateText.mockResolvedValue('你好');const text='hello';Object.assign(fixture.state,{snapshot:fixture.selectedSnapshot(text),selectedText:text,showTooltip:true});fixture.state.requestSelectionContent(text);
    for(let i=0;i<8;i++){await Promise.resolve();await Vue.nextTick()}
    const port=fixture.renderPort!;expect(port.root.textContent).toContain('词典暂时未能返回结果');expect(port.root.textContent).toContain('你好');
    await port.click(port.root.querySelector('.fr-word-fallback-note button')!);for(let i=0;i<8;i++){await Promise.resolve();await Vue.nextTick()}
    expect(lookups).toBe(3);expect(port.root.querySelector('.fr-word-fallback-note')).toBeNull();expect(port.root.querySelector('.fr-word-definition-zh')!.textContent).toBe('打招呼');
    await port.click(port.root.querySelector('.fr-word-meaning-toolbar button')!);await Vue.nextTick();expect(port.root.querySelector('.fr-word-definition-zh')).toBeNull();expect(port.root.querySelector('.fr-word-example-zh')).toBeNull();
    await port.click(port.root.querySelector('.fr-word-meaning-toolbar button')!);await Vue.nextTick();expect(port.root.querySelector('.fr-word-example-zh')!.textContent).toBe('译：再次问好');
    await port.click(port.root.querySelector('[data-copy-kind="source"]')!);await port.click(port.root.querySelector('[data-copy-kind="translation"]')!);await Vue.nextTick();expect(writeText.mock.calls.map(([text])=>text)).toEqual(['hello','你好']);
    await port.click(port.root.querySelector('.fr-word-heading-audio')!);await Vue.nextTick();expect(fixture.state.isPlaying).toBe(true);expect(ttsMessages(fixture,'selectionTts')[0].text).toBe('hello');
    await port.click(port.root.querySelector('.fr-word-heading-audio')!);expectAudioReset(fixture.state);expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
});

it('copies both sentence fields and plays the translated text through the real sentence toolbar',async()=>{
    const fixture=mountSelection(false,{acceptsRange:()=>true},{},true);await Vue.nextTick();const text='Read the entire sentence.';
    Object.assign(fixture.state,{snapshot:{text,parts:[{kind:'text',text}],range:{}},selectedText:text,translationResult:'阅读完整句子。',translationParts:[{kind:'text',text:'阅读完整句子。'}],showTooltip:true});await Vue.nextTick();
    const writeText=vi.fn(async(_text:string)=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});prepareTts(fixture,[Promise.resolve({success:true,transport:'offscreen'})]);const port=fixture.renderPort!;
    await port.click(port.root.querySelector('[data-copy-kind="source"]')!);await port.click(port.root.querySelector('[data-copy-kind="translation"]')!);expect(writeText.mock.calls.map(([text])=>text)).toEqual([text,'阅读完整句子。']);
    await port.click(port.root.querySelector('.fr-translation-result .fr-text-audio-btn')!);await Vue.nextTick();expect(fixture.state.currentAudioKind).toBe('translation');expect(ttsMessages(fixture,'selectionTts')[0].text).toBe('阅读完整句子。');
});

describe('rendered notice settings response ownership', () => {
    it.each(['open-vocabulary','open-local-tts'] as const)('keeps %s retryable when opening settings is refused',async action=>{
        const fixture=mountSelection(false,undefined,'chrome',true);await Vue.nextTick();fixture.state.showNotice('Current notice',action);await Vue.nextTick();
        fixture.browser.runtime.sendMessage.mockResolvedValue({success:false});const port=fixture.renderPort!;
        await port.click(port.root.querySelector('.fr-action-toast button')!);await Vue.nextTick();
        expect(port.root.querySelector('.fr-action-toast')!.textContent).toContain('无法打开设置');
        fixture.browser.runtime.sendMessage.mockResolvedValue({success:true});await port.click(port.root.querySelector('.fr-action-toast button')!);await Vue.nextTick();
        expect(port.root.querySelector('.fr-action-toast')).toBeNull();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['reject','throw'] as const)('contains a %s from its settings transport and retains the action',async failure=>{
        const fixture=mountSelection(false,undefined,'chrome',true);await Vue.nextTick();fixture.state.showNotice('Current notice','open-vocabulary');await Vue.nextTick();
        fixture.browser.runtime.sendMessage.mockImplementation(()=>{if(failure==='throw')throw new Error('Disconnected extension');return Promise.reject(new Error('Disconnected extension'))});
        const port=fixture.renderPort!;await expect(port.click(port.root.querySelector('.fr-action-toast button')!)).resolves.toBeUndefined();await Vue.nextTick();
        expect(port.root.querySelector('.fr-action-toast')!.textContent).toContain('无法打开设置');expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['success','refused','rejected'] as const)('does not overwrite a newer notice after old %s',async outcome=>{
        const fixture=mountSelection(false,undefined,'chrome',true);await Vue.nextTick();fixture.state.showNotice('Old notice','open-vocabulary');await Vue.nextTick();
        const deferred=deferredTts();fixture.browser.runtime.sendMessage.mockReturnValue(deferred.promise);const port=fixture.renderPort!,pending=port.click(port.root.querySelector('.fr-action-toast button')!);
        fixture.state.showNotice('New notice','open-local-tts');await Vue.nextTick();
        if(outcome==='rejected')deferred.reject(new Error('Disconnected extension'));else deferred.resolve({success:outcome==='success'});
        await pending;await Vue.nextTick();expect(port.root.querySelector('.fr-action-toast')!.textContent).toContain('New notice');expect(fixture.state.noticeAction).toBe('open-local-tts');expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['unmount','expiry'] as const)('does not revive a notice after %s while opening settings',async disposal=>{
        const fixture=mountSelection(false,undefined,'chrome',true);await Vue.nextTick();fixture.state.showNotice('Old notice','open-local-tts');await Vue.nextTick();
        const deferred=deferredTts();fixture.browser.runtime.sendMessage.mockReturnValue(deferred.promise);const port=fixture.renderPort!,pending=port.click(port.root.querySelector('.fr-action-toast button')!);
        if(disposal==='unmount')fixture.unmount();else await vi.advanceTimersByTimeAsync(2601);
        deferred.resolve({success:false});await pending;await Vue.nextTick();expect(port.root.querySelector('.fr-action-toast')).toBeNull();expect(vi.getTimerCount()).toBe(0);expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

describe('rendered hover entry and native copy events',()=>{
    async function entry(){
        const fixture=mountSelection(false,{acceptsRange:()=>true},'chrome',true);fixture.config.selectionTranslatorTrigger='hover';fixture.config.harness={...fixture.config.harness,hoverDelay:200};fixture.state.selectionConfigVersion+=1;fixture.notifyConfig();await Vue.nextTick();await Promise.resolve();await Vue.nextTick();
        const text='Read a complete source sentence.';
        Object.assign(fixture.state,{snapshot:fixture.selectedSnapshot(text),selectedText:text,showIndicator:true});await Vue.nextTick();
        const port=fixture.renderPort!;const pointer=(type:string,properties:Record<string,unknown>={})=>{const event=new port.domWindow.Event(type);Object.defineProperties(event,Object.fromEntries(Object.entries({isTrusted:true,pointerType:'mouse',...properties}).map(([key,value])=>[key,{value}])));port.root.querySelector('.fr-selection-indicator')!.dispatchEvent(event)};
        return {...fixture,port,pointer};
    }
    it('opens once after a trusted mouse dwell, with the saved current selection',async()=>{
        const fixture=await entry();fixture.pointer('pointerenter');await vi.advanceTimersByTimeAsync(199);expect(fixture.port.root.querySelector('[role="dialog"]')).toBeNull();expect(fixture.translateText).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);await Vue.nextTick();expect(fixture.port.root.querySelector('[role="dialog"]')).not.toBeNull();expect(fixture.translateText).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(250);expect(fixture.translateText).toHaveBeenCalledOnce();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['leave','replacement','unmount','touch','untrusted'] as const)('does not open a stale or non-mouse hover entry after %s',async reason=>{
        const fixture=await entry();fixture.pointer('pointerenter',reason==='touch'?{pointerType:'touch'}:reason==='untrusted'?{isTrusted:false}:{});
        if(reason==='leave')fixture.pointer('pointerleave');if(reason==='replacement')fixture.state.snapshot={...fixture.state.snapshot,text:'A newly selected sentence.'};if(reason==='unmount')fixture.unmount();
        await vi.advanceTimersByTimeAsync(500);await Vue.nextTick();expect(fixture.port.root.querySelector('[role="dialog"]')).toBeNull();expect(fixture.translateText).not.toHaveBeenCalled();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
    it.each(['page','card','untrusted','disabled'] as const)('keeps native clipboard semantics for a %s copy',async target=>{
        const fixture=await entry(),port=fixture.port;vi.stubGlobal('Node',port.domWindow.Node);vi.stubGlobal('Element',port.domWindow.Element);
        const host=port.root.querySelector('.fr-selection-translator-root')!;fixture.document.getElementById.mockReturnValue(host as never);
        const removeAllRanges=vi.fn();Object.assign(fixture.window,{getSelection:()=>({removeAllRanges})});fixture.config.selectionTranslatorAutoDismiss=target!=='disabled';fixture.state.selectionConfigVersion+=1;await Vue.nextTick();
        const event={isTrusted:target!=='untrusted',target:target==='card'?host:port.document.createElement('p'),preventDefault:vi.fn(),stopPropagation:vi.fn()};
        const handlers=[...fixture.listeners.get('document:copy')!];expect(handlers).toHaveLength(1);handlers[0](event);await Vue.nextTick();
        expect(port.root.querySelector('.fr-selection-indicator')===null).toBe(target==='page');expect(event.preventDefault).not.toHaveBeenCalled();expect(event.stopPropagation).not.toHaveBeenCalled();expect(removeAllRanges).not.toHaveBeenCalled();expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });
});

it('requires a fresh shortcut after native keyup before translating a changed selection',async()=>{
    const fixture=mountSelection(false,{acceptsRange:()=>true,normalizeText:(text:string)=>text},'chrome',true);vi.stubGlobal('Node',class{});vi.stubGlobal('Element',class{});
    fixture.config.selectionTranslatorTrigger='Control';fixture.config.selectionTranslatorDelay=0;fixture.state.selectionConfigVersion+=1;fixture.notifyConfig();await Vue.nextTick();await Promise.resolve();await Vue.nextTick();
    let text='Read the first complete sentence.';const source={isConnected:true,ownerDocument:fixture.document};
    const rect={left:20,right:210,top:150,bottom:174,width:190,height:24};
    const range=Vue.markRaw({startContainer:source,endContainer:source,startOffset:0,endOffset:text.length,collapsed:false,getClientRects:()=>[rect],getBoundingClientRect:()=>rect,cloneRange:()=>range,toString:()=>text});
    Object.assign(fixture.window,{getSelection:()=>({rangeCount:1,isCollapsed:false,anchorNode:source,anchorOffset:0,getRangeAt:()=>range,toString:()=>text})});
    const send=(type:string,event:Record<string,unknown>)=>{for(const handler of fixture.listeners.get(`document:${type}`)??[])handler(event)};
    const key=()=>({isTrusted:true,key:'Control',ctrlKey:true,altKey:false,metaKey:false,shiftKey:false,target:null,preventDefault:vi.fn(),stopPropagation:vi.fn()});
    const first=key();send('keydown',first);await vi.advanceTimersByTimeAsync(100);await Vue.nextTick();expect(first.preventDefault).toHaveBeenCalledOnce();expect(fixture.renderPort!.root.querySelector('[role="dialog"]')).not.toBeNull();expect(fixture.translateText).toHaveBeenCalledOnce();
    send('keyup',{isTrusted:true,key:'Control'});text='Read a different complete sentence.';range.endOffset=text.length;send('selectionchange',{isTrusted:true});await vi.advanceTimersByTimeAsync(100);await Vue.nextTick();
    expect(fixture.state.selectedText).toBe(text);expect(fixture.renderPort!.root.querySelector('[role="dialog"]')).toBeNull();expect(fixture.translateText).toHaveBeenCalledOnce();
    send('keydown',key());await vi.advanceTimersByTimeAsync(100);await Vue.nextTick();expect(fixture.renderPort!.root.querySelector('[role="dialog"]')).not.toBeNull();expect(fixture.translateText).toHaveBeenCalledTimes(2);expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
});
