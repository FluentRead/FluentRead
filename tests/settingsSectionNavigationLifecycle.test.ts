import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseHTML} from 'linkedom';
import * as ts from 'typescript';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {settingsPagePanels} from '@/src/features/settings/model/navigation';

// 执行真实 SFC setup/watch 和编译模板；DOM 事件真实，几何与 RAF/ResizeObserver 是受控夹具。
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
type Anchor = {id: string; label: string; labelKey?: string; element: HTMLElement};
let server: ViteDevServer | undefined, app: import('vue').App | undefined;
let stopAnchorWatch: (() => void) | undefined;
let restoreGeometry: (() => void) | undefined;
afterEach(async () => {
  stopAnchorWatch?.();stopAnchorWatch = undefined;app?.unmount();app = undefined;
  restoreGeometry?.();restoreGeometry = undefined;
  await server?.close();server = undefined;vi.restoreAllMocks();vi.unstubAllGlobals();
});

function createDomRenderer(document: Document) {
  return runtime.createRenderer({patchProp(element: any, key: string, previous: unknown, next: unknown) {
    if (key === 'class') {element.className = String(next ?? '');return;}
    if (/^on[A-Z]/u.test(key)) {
      const name = key.slice(2).toLowerCase();
      if (previous) element.removeEventListener(name, previous);
      if (next) element.addEventListener(name, next);
    } else if (next === undefined || next === null || next === false) element.removeAttribute(key);
    else element.setAttribute(key, String(next));
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
  remove: (node: any) => node.parentNode?.removeChild(node), createElement: (name: string) => document.createElement(name),
  createText: (value: string) => document.createTextNode(value), createComment: (value: string) => document.createComment(value),
  setText: (node: any, value: string) => {node.nodeValue = value;}, setElementText: (node: any, value: string) => {node.textContent = value;},
  parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
  querySelector: (value: string) => document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
  insertStaticContent: (content: string, parent: any, anchor: any) => {
    const template = document.createElement('template');template.innerHTML = content;
    const first = template.content.firstChild, last = template.content.lastChild;
    parent.insertBefore(template.content, anchor);return [first, last];
  }});
}

async function mountNavigation() {
  const {window, document} = parseHTML('<html><body><div id="navigation"></div><div id="content"></div></body></html>');
  const container = document.querySelector('#content')! as unknown as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>();let frameId = 0, layoutShift = 0;
  const resizeObservers: FixtureResizeObserver[] = [];
  class FixtureResizeObserver {
    readonly elements = new Set<Element>();
    readonly disconnect = vi.fn(() => this.elements.clear());
    constructor(readonly callback: ResizeObserverCallback) {resizeObservers.push(this);}
    observe(element: Element) {this.elements.add(element);}
    deliver() {if (this.elements.size) this.callback([], this as unknown as ResizeObserver);}
  }
  for (const [key, value] of Object.entries({window, document, HTMLElement: window.HTMLElement,
    HTMLDetailsElement: window.HTMLDetailsElement, MutationObserver: window.MutationObserver,
    ResizeObserver: FixtureResizeObserver, requestAnimationFrame: (callback: FrameRequestCallback) => {frames.set(++frameId, callback);return frameId;},
    cancelAnimationFrame: (id: number) => frames.delete(id)})) vi.stubGlobal(key, value);
  (window as any).matchMedia = () => ({matches: true});
  const selector = '[data-settings-panel], [data-settings-anchor]';
  const geometryDescriptors = ['getClientRects', 'getBoundingClientRect', 'scrollTo'].map(name => (
    [name, Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, name)] as const
  ));
  restoreGeometry = () => {
    for (const [name, descriptor] of geometryDescriptors) {
      if (descriptor) Object.defineProperty(window.HTMLElement.prototype, name, descriptor);
      else delete (window.HTMLElement.prototype as any)[name];
    }
  };
  const clientRects = vi.fn(), boundingRects = vi.fn();
  const visible = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element;current && current !== (document.body as unknown as HTMLElement);current = current.parentElement) {
      if (current.style.display === 'none' || current.classList.contains('fixture-hidden')) return false;
      if (current !== element && current.tagName === 'DETAILS' && !current.hasAttribute('open')) return false;
    }
    return true;
  };
  const rect = (element: HTMLElement) => {
    const index = (element as any).fixtureIndex || 0;
    const top = element === container ? 0 : index * 100 - container.scrollTop + (index > 0 ? layoutShift : 0);
    return {top, bottom: top + 80, left: 0, right: 500, height: 80, width: 500, x: 0, y: top};
  };
  (window.HTMLElement.prototype as any).getClientRects = function (this: HTMLElement) {
    if (this.matches(selector)) clientRects();return visible(this) ? [rect(this)] : [];
  };
  (window.HTMLElement.prototype as any).getBoundingClientRect = function (this: HTMLElement) {
    if (this.matches(selector)) boundingRects();return rect(this);
  };
  (window.HTMLElement.prototype as any).scrollTo = function (this: HTMLElement, options: ScrollToOptions) {
    if (options.top !== undefined) this.scrollTop = options.top;
    if (options.left !== undefined) this.scrollLeft = options.left;
  };
  Object.defineProperties(container, {scrollHeight: {value: 2000}, clientHeight: {value: 250}, clientTop: {value: 0}});
  container.scrollTop = 0;
  const panels = settingsPagePanels['settings-translation'].map(panel => ({...panel}));
  const elements = panels.map((panel, index) => {
    const element = document.createElement('section') as unknown as HTMLElement;
    element.dataset.settingsPanel = panel.id;(element as any).fixtureIndex = index;
    element.appendChild(document.createElement('button') as unknown as Node);container.appendChild(element);return element;
  });
  const query = vi.spyOn(container, 'querySelectorAll');
  const mocks: Plugin = {name: 'section-navigation-i18n-display-port', enforce: 'pre', resolveId(id) {
    return /\/src\/ui\/i18n(?:\.ts)?$/u.test(id) ? '\0section-navigation-i18n' : null;
  }, load(id) {return id === '\0section-navigation-i18n' ? 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text});' : null;}};
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent',
    plugins: [mocks, vue()], resolve: {alias: {'@': process.cwd()}}, server: {hmr: false, middlewareMode: true}});
  const filename = resolve(process.cwd(), 'src/features/settings/ui/components/SettingsSectionNavigation.vue');
  const compiler = createRequire(require.resolve('@vitejs/plugin-vue'))('@vue/compiler-sfc');
  const descriptor = compiler.parse(readFileSync(filename, 'utf8'), {filename}).descriptor;
  const script = compiler.compileScript(descriptor, {id: 'section-navigation-lifecycle'});
  const template = compiler.compileTemplate({source: descriptor.template.content, filename, id: 'section-navigation-lifecycle',
    compilerOptions: {mode: 'function', bindingMetadata: script.bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  const component = (await server.ssrLoadModule('/src/features/settings/ui/components/SettingsSectionNavigation.vue')).default;
  const compiledRender = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime);
  const render = vi.fn(function (this: unknown, ...args: unknown[]) {return compiledRender.apply(this, args);});
  component.ssrRender = undefined;component.render = render;
  let state!: {anchors: Anchor[]; activeAnchor: string};
  app = createDomRenderer(document as unknown as Document).createApp({setup: () => () => runtime.h(component, {container, sectionId: 'settings-translation', panels,
    ref: (vm: any) => {if (vm) state = vm.$.setupState;}})});
  app.provide(runtime.ssrContextKey, {modules: new Set()});app.config.warnHandler = () => {};
  app.mount(document.querySelector('#navigation'));
  const settle = async () => {await runtime.nextTick();for (let step = 0;step < 8;step++) await Promise.resolve();await runtime.nextTick();};
  const flushFrame = async () => {await settle();const callbacks = [...frames.values()];frames.clear();for (const callback of callbacks) callback(0);await settle();};
  await flushFrame();
  const arrayChanges = vi.fn();stopAnchorWatch = runtime.watch(() => state.anchors, arrayChanges, {flush: 'sync'});
  render.mockClear();query.mockClear();clientRects.mockClear();boundingRects.mockClear();
  return {state, document, window, container, elements, panels, render, query, clientRects, boundingRects, arrayChanges, frames,
    settle, flushFrame, resizeObservers, shiftLayout: (pixels: number) => {layoutShift = pixels;}};
}

describe('设置分区导航实际组件列表与几何更新', () => {
  it('无关子控件逐帧 class/style 变化保留锚点数组、不重绘导航，同时保留完整测量', async () => {
    const fixture = await mountNavigation();const previous = fixture.state.anchors;
    const button = fixture.elements[0].firstElementChild!;
    for (const attribute of ['class', 'style']) for (let step = 0;step < 3;step++) {
      // LinkeDOM 的连续 CSSOM 属性赋值不完整触发观察器；属性写入提供真实 attributes:style 记录。
      button.setAttribute(attribute, attribute === 'class' ? `fixture-status-${step}` : `opacity: ${(step + 1) / 4}`);
      await fixture.flushFrame();
    }
    expect(fixture.query).toHaveBeenCalledTimes(6);
    expect(fixture.clientRects).toHaveBeenCalledTimes(fixture.panels.length * 6);expect(fixture.boundingRects).toHaveBeenCalledTimes(fixture.panels.length * 12);
    expect(fixture.state.anchors).toBe(previous);expect(fixture.arrayChanges).not.toHaveBeenCalled();expect(fixture.render).not.toHaveBeenCalled();
  });

  it('同帧无关 mutation 合并一次刷新，结构懒加载、标签更新与重排仍替换列表和按钮', async () => {
    const fixture = await mountNavigation();const button = fixture.elements[0].firstElementChild!;
    for (let step = 0;step < 100;step++) button.className = `fixture-burst-${step}`;
    await fixture.flushFrame();expect(fixture.query).toHaveBeenCalledOnce();expect(fixture.render).not.toHaveBeenCalled();
    const lazy = fixture.document.createElement('article');lazy.dataset.settingsAnchor = 'fixture-lazy';lazy.dataset.settingsAnchorLabel = 'Lazy heading';
    fixture.container.appendChild(lazy as unknown as Node);await fixture.flushFrame();
    expect(fixture.state.anchors.at(-1)?.id).toBe('fixture-lazy');expect(fixture.render).toHaveBeenCalledOnce();
    lazy.dataset.settingsAnchorLabel = 'Updated heading';await fixture.flushFrame();
    expect(fixture.state.anchors.at(-1)?.label).toBe('Updated heading');
    expect(fixture.document.querySelector('[data-settings-anchor-link="fixture-lazy"]')?.textContent).toBe('Updated heading');
    fixture.container.insertBefore(fixture.elements[1], fixture.elements[0]);await fixture.flushFrame();
    expect(fixture.state.anchors[0].id).toBe(fixture.panels[1].id);expect(fixture.render).toHaveBeenCalledTimes(3);
  });

  it('同一元素的锚点 id 与注册表 labelKey 更新仍刷新元数据', async () => {
    const fixture = await mountNavigation();const lazy = fixture.document.createElement('article');
    lazy.dataset.settingsAnchor = 'fixture-id';lazy.dataset.settingsAnchorLabel = 'Fixture heading';
    fixture.container.appendChild(lazy as unknown as Node);await fixture.flushFrame();
    lazy.dataset.settingsAnchor = 'fixture-new-id';fixture.resizeObservers.forEach(observer => observer.deliver());await fixture.flushFrame();
    expect(fixture.state.anchors.at(-1)?.id).toBe('fixture-new-id');
    fixture.panels[0].labelKey = 'fixture.updated.label';fixture.resizeObservers.forEach(observer => observer.deliver());await fixture.flushFrame();
    expect(fixture.state.anchors[0].labelKey).toBe('fixture.updated.label');expect(fixture.render).toHaveBeenCalledTimes(3);
  });

  it('锚点 style 隐藏、祖先 class 隐藏及 details 展开折叠更新可见集合', async () => {
    const fixture = await mountNavigation();const panel = fixture.elements[1];const total = fixture.panels.length;
    panel.setAttribute('style', 'display: none');await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total - 1);
    panel.setAttribute('style', '');await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total);
    const wrapper = fixture.document.createElement('div');fixture.container.appendChild(wrapper as unknown as Node);
    wrapper.appendChild(panel as unknown as Node);await fixture.flushFrame();
    wrapper.className = 'fixture-hidden';await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total - 1);
    wrapper.className = '';await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total);
    const details = fixture.document.createElement('details'), nested = fixture.document.createElement('article');
    nested.dataset.settingsAnchor = 'fixture-nested';nested.dataset.settingsAnchorLabel = 'Nested heading';details.appendChild(nested);
    fixture.container.appendChild(details as unknown as Node);await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total);
    details.setAttribute('open', '');await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total + 1);
    details.removeAttribute('open');await fixture.flushFrame();expect(fixture.state.anchors).toHaveLength(total);
  });

  it('子控件布局改变时保留锚点数组但更新当前位置与导航高亮', async () => {
    const fixture = await mountNavigation();fixture.container.scrollTop = 130;
    fixture.container.dispatchEvent(new fixture.window.Event('scroll'));await fixture.settle();
    expect(fixture.state.activeAnchor).toBe(fixture.panels[1].id);
    fixture.render.mockClear();const previous = fixture.state.anchors;
    fixture.shiftLayout(200);fixture.elements[0].firstElementChild!.className = 'fixture-expanded-control';await fixture.flushFrame();
    expect(fixture.state.anchors).toBe(previous);expect(fixture.arrayChanges).not.toHaveBeenCalled();
    expect(fixture.state.activeAnchor).toBe(fixture.panels[0].id);expect(fixture.render).toHaveBeenCalledOnce();
    expect(fixture.document.querySelector('[aria-current]')?.getAttribute('data-settings-anchor-link')).toBe(fixture.panels[0].id);
  });

  it('卸载取消待执行刷新并清理观察器，后续 mutation 不再重绘或读取几何', async () => {
    const fixture = await mountNavigation();fixture.elements[0].firstElementChild!.className = 'fixture-pending';await fixture.settle();
    expect(fixture.frames.size).toBe(1);fixture.resizeObservers.forEach(observer => observer.disconnect.mockClear());
    app!.unmount();app = undefined;expect(fixture.frames.size).toBe(0);
    for (const observer of fixture.resizeObservers) {expect(observer.disconnect).toHaveBeenCalledOnce();expect(observer.elements.size).toBe(0);}
    fixture.elements[0].firstElementChild!.className = 'fixture-after-unmount';await fixture.flushFrame();
    expect(fixture.query).not.toHaveBeenCalled();expect(fixture.boundingRects).not.toHaveBeenCalled();expect(fixture.render).not.toHaveBeenCalled();
  });
});
