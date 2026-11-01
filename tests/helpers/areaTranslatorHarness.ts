import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import {vi} from 'vitest';
import {translate as translateMessage} from '@/src/core/i18n';
import AreaTranslator from '@/src/features/area-translation/ui/AreaTranslator.vue';

let ports: ReturnType<typeof createPorts>;
function createPorts() {
  return {
    config: {on: true, selectionAreaEnabled: true, animations: true, from: 'auto', theme: 'light', selectionAreaHotkey: 'Shift+Z', customSelectionAreaHotkey: ''} as Record<string, any>,
    capture: vi.fn().mockResolvedValue('data:image/png,capture'),
    translate: vi.fn().mockResolvedValue({image: 'data:image/png,crop', sourceText: 'Source', translatedText: '译文', service: 'microsoft', serviceName: '微软翻译', model: '', mode: 'standard', lines: [], warnings: []}),
    prepare: vi.fn().mockResolvedValue(undefined), copy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({success: true}), stopConfig: vi.fn(), subscription: (() => {}) as () => void,
  };
}
vi.mock('@/src/services/config/store', () => ({get config() {return ports.config;}, subscribeConfig: (callback: () => void) => {ports.subscription = callback; return ports.stopConfig;}}));
vi.mock('@/src/features/area-translation/services/client', () => ({captureVisibleAreaInExtension: (...args: unknown[]) => ports.capture(...args), translateCapturedAreaInExtension: (...args: unknown[]) => ports.translate(...args)}));
vi.mock('@/src/features/image-translation/public', () => ({prepareImageOcrLanguages: (...args: unknown[]) => ports.prepare(...args)}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: unknown[]) => ports.sendMessage(...args)}}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text, t: (key: string, parameters: any) => translateMessage(key, 'zh-CN', parameters)})}));

/** 仅替代扩展通信、剪贴板和可见视口；组件模板、生命周期、几何与配置判断使用生产实现。 */
export function mountAreaTranslator(component: typeof AreaTranslator = AreaTranslator) {
  ports = createPorts();
  const {window, document} = parseHTML('<html><head><title>Area fixture</title></head><body><h1>Title</h1></body></html>');
  Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
  const media = {matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()};
  Object.assign(window, {innerWidth: 1000, innerHeight: 800, matchMedia: () => media});
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('Node', window.Node); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('navigator', {clipboard: {writeText: ports.copy}});
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  let focused: unknown = document.body;
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused});
  const renderer = Vue.createRenderer<any, any>({
    createElement: (tag, namespace) => Vue.markRaw(namespace === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
    patchProp: (node, key, previous, value) => {
      if (key.startsWith('on')) {const event = key.slice(2).toLowerCase(); if (previous) node.removeEventListener(event, previous); if (value) node.addEventListener(event, value);}
      else if (key === 'style') Object.assign(node.style, value || {});
      else if (value == null || value === false && !key.startsWith('aria-')) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
  });
  const host = document.createElement('div'); host.id = 'fluent-read-area-translator-container'; document.body.append(host);
  const app = renderer.createApp(component); app.directive('ui-i18n', {}); app.mount(host);
  const state = (app as any)._instance.setupState;
  const dispatch = (target: EventTarget, type: string, fields: Record<string, unknown> = {}) => {
    const event = new window.Event(type, {bubbles: true, cancelable: true});
    Object.assign(event, fields); target.dispatchEvent(event); return event;
  };
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text);
    if (!button) throw new Error(`Missing visible area button: ${text}`);
    dispatch(button, 'click'); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick();
  };
  return {...ports, state, document, host, media, dispatch, click, focus: (element: unknown) => {focused = element;},
    beginSelection: () => (app as any)._instance.exposed.beginSelection(), unmount: () => {app.unmount(); host.remove();}};
}
