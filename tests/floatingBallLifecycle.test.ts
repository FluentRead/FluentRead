/**
 * @file tests/floatingBallLifecycle.test.ts
 * 文件职责：执行悬浮球真实 Vue SFC 的 setup、模板、watch 与挂载/卸载逻辑。
 * 主要内容：覆盖触屏/鼠标指针与兼容 click 去重、辅助激活、拖动跟手和取消不保存、视口变化、props/翻译状态和事件资源释放。
 * 模块边界：直接导入生产 SFC 并使用 Vue 自定义 DOM renderer；仅把语言、视口订阅和元素几何作为受控平台端口，不以此代替真实浏览器 CSS/触摸或焦点验收。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as Vue from 'vue';
import {parseHTML} from 'linkedom';
import FloatingBall from '@/src/features/floating-ball/ui/FloatingBall.vue';

const platform = vi.hoisted(() => ({viewport: () => ({}), observe: (_callback: () => void): (() => void) => () => {}}));
vi.mock('@/src/platform/dom/visualViewport', () => ({getVisualViewportRect: () => platform.viewport(), observeVisualViewport: (callback: () => void) => platform.observe(callback)}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text,
  t: (key: string) => ({'common.brand': '流畅阅读', 'fullPage.progress.title': '翻译中', 'fullPage.progress.failuresTitle': '翻译失败', 'fullPage.progress.completed': '已完成'}[key] || key)})}));
let app: Vue.App | undefined;
let componentErrors: ReturnType<typeof vi.fn> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined;
  expect(componentErrors).not.toHaveBeenCalled(); componentErrors = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

type BallApi = {setTranslationState(value: boolean): void; setTranslationStatus(value: string): void;
  setPosition(side: 'left' | 'right', vertical: number | null): void; setPopupOpen(open: boolean): void};

function mountBall(initial: Record<string, unknown> = {}, navigatorPort: {maxTouchPoints?: number} | null = {maxTouchPoints: 0}) {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  const parsed = parseHTML('<html><body></body></html>');
  const {document} = parsed;
  const windowListeners = new Map<string, Set<EventListener>>();
  const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener: vi.fn((type: string, handler: EventListener) => {
      const handlers = windowListeners.get(type) || new Set<EventListener>(); handlers.add(handler); windowListeners.set(type, handlers);
    }),
    removeEventListener: vi.fn((type: string, handler: EventListener) => windowListeners.get(type)?.delete(handler)),
  };
  let viewport = {left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800};
  let viewportCallback: (() => void) | undefined;
  const stopViewport = vi.fn();
  const observeViewport = vi.fn((callback: () => void) => {viewportCallback = callback; return stopViewport;});
  platform.viewport = () => viewport;platform.observe = observeViewport;
  const registered = new WeakMap<Element, Map<string, EventListener>>();
  const renderer = Vue.createRenderer<Node, Element>({
    // 真实浏览器DOM不会成为Vue响应式对象；Linkedom的元素需显式markRaw保持事件composedPath身份。
    createElement: (tag, namespace) => Vue.markRaw(namespace === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    insert: (node, parent, anchor) => {parent.insertBefore(node, anchor ?? null);}, remove: node => {node.parentNode?.removeChild(node);},
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling,
    setScopeId: (element, id) => element.setAttribute(id, ''), cloneNode: node => Vue.markRaw(node.cloneNode(true)),
    insertStaticContent: (html, parent, anchor) => {const box = document.createElement('div');box.innerHTML = html;
      const first = box.firstChild!, last = box.lastChild!;while (box.firstChild) parent.insertBefore(box.firstChild, anchor ?? null);return [first, last];},
    patchProp(element, key, previous, value) {
      if (/^on[A-Z]/.test(key)) {
        const name = key.slice(2).toLowerCase(); const listeners = registered.get(element) || new Map<string, EventListener>(); registered.set(element, listeners);
        const old = listeners.get(key); if (old) element.removeEventListener(name, old);
        listeners.delete(key);
        if (value) {const handler: EventListener = event => {for (const callback of Array.isArray(value) ? value : [value]) callback(event);}; listeners.set(key, handler); element.addEventListener(name, handler);}
      } else if (key === 'style') {
        const style = (element as HTMLElement).style;
        for (const name of Object.keys(previous || {})) if (!(name in (value || {}))) style.removeProperty(name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`));
        for (const [name, raw] of Object.entries(value || {})) style.setProperty(name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`), String(raw ?? ''));
      } else if (value == null) element.removeAttribute(key);
      else element.setAttribute(key, String(value));
    },
  });
  vi.stubGlobal('navigator', navigatorPort ?? undefined);
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('ShadowRoot', parsed.window.ShadowRoot);
  const addDocument = vi.spyOn(document, 'addEventListener'), removeDocument = vi.spyOn(document, 'removeEventListener');
  const translate = vi.fn(), savePosition = vi.fn(), settings = vi.fn(), mangaToggle = vi.fn();
  const props = Vue.reactive<Record<string, any>>({onTranslationToggle: translate, onPositionChanged: savePosition, onSettingsClick: settings, onMangaToggle: mangaToggle, ...initial});
  const exposed = Vue.ref<BallApi>();
  const current = renderer.createApp({render: () => Vue.h(FloatingBall, {...props, ref: exposed})});
  const errors = vi.fn(); componentErrors = errors; current.config.errorHandler = errors; current.directive('ui-i18n', {});
  app = current; current.mount(document.body);
  const ball = () => document.querySelector<HTMLElement>('.fr-floating-ball')!;
  const main = () => document.querySelector<HTMLElement>('.floating-ball-main')!;
  // Linkedom does not implement native focus pseudos; the browser focus port starts empty.
  const query = ball().querySelector.bind(ball());
  Object.defineProperty(ball(), 'querySelector', {configurable: true, value: (selector: string) => selector === ':focus-visible' || selector === ':focus' ? null : query(selector)});

  const numeric = (value: string, fallback: number) => /^-?[\d.]+px$/.test(value) ? Number.parseFloat(value) : fallback;
  // 几何端口仅模拟“容器中主手柄偏移40px”；最终定位仍由真实组件/position算法执行。
  Object.defineProperty(ball(), 'getBoundingClientRect', {value: () => {
    const left = numeric(ball().style.left, 940), top = numeric(ball().style.top, 350);
    return {left, top, width: 40, height: 120, right: left + 40, bottom: top + 120};
  }});
  Object.defineProperties(main(), {offsetLeft: {value: 0}, offsetTop: {value: 40}, getBoundingClientRect: {value: () => {
    const root = ball().getBoundingClientRect(); return {left: root.left, top: root.top + 40, width: 40, height: 40, right: root.left + 40, bottom: root.top + 80};
  }}});
  const event = (type: string, values: Record<string, unknown> = {}) => {
    const next = new parsed.window.Event(type, {bubbles: true, cancelable: true});
    for (const [name, value] of Object.entries(values)) Object.defineProperty(next, name, {value, configurable: true});
    return next;
  };
  const dispatchWindow = (next: Event) => {for (const handler of [...windowListeners.get(next.type) || []]) handler(next);};
  const pointer = (type: string, values: Record<string, unknown> = {}, target: Element | 'window' = main()) => {
    const next = event(type, {pointerId: 1, pointerType: 'touch', button: 0, clientX: 960, clientY: 410, ...values});
    if (target !== 'window') target.dispatchEvent(next); dispatchWindow(next); return next;
  };
  const click = (target: Element = main(), detail = 1) => target.dispatchEvent(event('click', {detail}));
  return {ball, main, props, document, window, windowListeners, translate, savePosition, settings, mangaToggle, errors, exposed,
    addDocument, removeDocument, stopViewport, observeViewport, event, dispatchWindow, pointer, click,
    viewport: (next: typeof viewport) => {viewport = next; viewportCallback!();},
    unmount: () => {current.unmount(); app = undefined;}};
}

async function flush() {await Vue.nextTick(); await Vue.nextTick();}

describe('FloatingBall actual SFC lifecycle', () => {
  it('offers the injected secondary manga reading action without changing the main toggle', async () => {
    const read=vi.fn();const port=mountBall({manga:{available:true,active:true,pending:false,errors:0},onMangaReading:read,presentation:{toolsDisplay:'hover',hoverDelay:0}});await flush();
    port.ball().dispatchEvent(port.event('mouseenter'));await flush();const button=port.document.querySelector<HTMLElement>('.floating-ball-reading')!;
    expect(button.getAttribute('aria-label')).toBe('查看漫画文字');expect(button.getAttribute('aria-expanded')).toBe('false');port.click(button,0);expect(read).toHaveBeenCalledOnce();expect(port.mangaToggle).not.toHaveBeenCalled();
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');expect(button.textContent?.trim()).toBe('');
    port.props.mangaReadingOpen=true;await flush();port.ball().dispatchEvent(port.event('mouseleave'));vi.advanceTimersByTime(3000);await flush();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);expect(button.getAttribute('aria-expanded')).toBe('true');expect(button.getAttribute('aria-label')).toBe('关闭漫画文字');
    port.props.manga.areaFallback=true;await flush();expect(port.document.querySelector('.floating-ball-reading')).toBeNull();
  });
  it('keeps the hover tool expanded while shared reading state is open and collapses after it closes',async()=>{
    const port=mountBall({manga:{available:true,active:true,pending:false,errors:0},onMangaReading:vi.fn(),mangaReadingState:{open:true},presentation:{toolsDisplay:'hover',hoverDelay:0}});await flush();
    port.ball().dispatchEvent(port.event('mouseenter'));await flush();port.ball().dispatchEvent(port.event('mouseleave'));vi.advanceTimersByTime(3000);await flush();
    const button=port.document.querySelector<HTMLElement>('.floating-ball-reading')!;
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);expect(button.getAttribute('aria-expanded')).toBe('true');
    port.props.mangaReadingState.open=false;await flush();port.ball().dispatchEvent(port.event('mouseleave'));vi.advanceTimersByTime(3000);await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  it.each([
    {name: 'navigator missing', navigatorPort: null, expected: false},
    {name: 'maxTouchPoints missing', navigatorPort: {}, expected: false},
    {name: 'no touch contacts', navigatorPort: {maxTouchPoints: 0}, expected: false},
    {name: 'five touch contacts', navigatorPort: {maxTouchPoints: 5}, expected: true},
  ])('selects the first-render hardware touch class with $name', async ({navigatorPort, expected}) => {
    const port = mountBall({}, navigatorPort);
    // 挂载返回时已完成首轮渲染，不需要先触摸、视口变化或异步能力探测。
    expect(port.ball().classList.contains('is-touch-capable')).toBe(expected);
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    await flush();
    expect(port.translate).not.toHaveBeenCalled(); expect(port.savePosition).not.toHaveBeenCalled();
  });

  it('keeps hardware touch capability through compact/manga and display changes without triggering translation or position callbacks', async () => {
    const port = mountBall({}, {maxTouchPoints: 5});
    port.props.presentation = {compact: true, toolsDisplay: 'hidden'};
    port.props.manga = {available: true}; await flush();
    expect(port.ball().classList.contains('is-touch-capable')).toBe(true);
    expect(port.ball().classList.contains('is-compact')).toBe(true);
    expect(port.ball().classList.contains('manga-reader')).toBe(true);
    expect(port.document.querySelector('.floating-ball-translate')).toBeNull();
    expect(port.translate).not.toHaveBeenCalled(); expect(port.savePosition).not.toHaveBeenCalled();
  });

  it.each(['touch', 'mouse'])('performs %s pointerup once and ignores its compatible click', async pointerType => {
    const port = mountBall(); await flush();
    port.pointer('pointerdown', {pointerType}); await flush();
    if (pointerType === 'touch') { expect(port.errors.mock.calls).toEqual([]); expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true); }
    port.pointer('pointerup', {pointerType}); port.click(port.main(), pointerType === 'touch' ? 0 : 1);
    expect(port.translate).toHaveBeenCalledTimes(1); expect(port.translate).toHaveBeenLastCalledWith(true);
    expect(port.savePosition).not.toHaveBeenCalled();
    expect([...port.windowListeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    if (pointerType === 'touch') {
      vi.advanceTimersByTime(1000); port.click(port.main(), 0);
      expect(port.translate).toHaveBeenCalledTimes(2);
    }
  });

  it('accepts click-only assistive activation and keyboard Enter/Space while ignoring repeat and disabled actions', async () => {
    const port = mountBall(); await flush();
    port.click(port.main(), 0); expect(port.translate).toHaveBeenCalledTimes(1); expect(port.translate).toHaveBeenLastCalledWith(true);
    port.main().dispatchEvent(port.event('keydown', {key: 'Enter', repeat: false}));
    port.main().dispatchEvent(port.event('keydown', {key: ' ', repeat: false}));
    port.main().dispatchEvent(port.event('keydown', {key: ' ', repeat: true}));
    expect(port.translate).toHaveBeenCalledTimes(3);
    port.props.presentation = {clickAction: 'none'}; await flush();
    expect(port.main().getAttribute('role')).toBe('img'); expect(port.main().hasAttribute('tabindex')).toBe(false);
    port.click(port.main(), 0); port.main().dispatchEvent(port.event('keydown', {key: 'Enter'}));
    expect(port.translate).toHaveBeenCalledTimes(3);
  });

  it('tracks the pointer with its grab offset and saves a completed drag once without translating', async () => {
    const port = mountBall(); await flush();
    port.pointer('pointerdown');
    port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window'); await flush();
    expect(port.ball().classList.contains('dragging')).toBe(true);
    expect(port.ball().style.left).toBe('280px'); expect(port.ball().style.top).toBe('280px');
    port.pointer('pointerup', {clientX: 300, clientY: 340}); port.click(port.main(), 0); await flush();
    expect(port.savePosition).toHaveBeenCalledTimes(1); expect(port.savePosition).toHaveBeenLastCalledWith('left', .425);
    expect(port.ball().getAttribute('data-position')).toBe('left'); expect(port.ball().classList.contains('dragging')).toBe(false);
    expect(port.translate).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'blur', 'viewport'])('cancels drag on %s, restores docking and never saves cancelled movement', async reason => {
    const port = mountBall(); await flush(); port.pointer('pointerdown');
    port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window'); await flush();
    if (reason === 'viewport') port.viewport({left: 20, top: 100, right: 370, bottom: 500, width: 350, height: 400});
    else if (reason === 'blur') port.dispatchWindow(port.event('blur'));
    else port.pointer('pointercancel', {}, 'window');
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(false); expect(port.ball().style.top).toContain('clamp(');
    if (reason === 'viewport') expect(port.ball().style.top).toContain('300px');
    port.pointer('pointerup', {clientX: 300, clientY: 340}, 'window'); port.click(port.main(), 0);
    expect(port.savePosition).not.toHaveBeenCalled(); expect(port.translate).not.toHaveBeenCalled();
    expect([...port.windowListeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it('ignores another finger and keeps the original gesture cancellable', async () => {
    const port = mountBall(); await flush(); port.pointer('pointerdown', {pointerId: 1});
    port.pointer('pointermove', {pointerId: 2, clientX: 100, clientY: 200}, 'window');
    port.pointer('pointerup', {pointerId: 2}, 'window'); await flush();
    expect(port.ball().classList.contains('dragging')).toBe(false);
    expect(port.windowListeners.get('pointerup')?.size).toBe(1);
    port.pointer('pointercancel', {pointerId: 1}, 'window');
    expect(port.translate).not.toHaveBeenCalled(); expect(port.savePosition).not.toHaveBeenCalled();
    expect(port.windowListeners.get('pointerup')?.size).toBe(0);
  });

  it('reflects props and exposed translation status in the actual template and routes current actions', async () => {
    const port = mountBall({initialTranslating: true, initialTranslationStatus: 'translating'}); await flush();
    const translation = () => port.document.querySelector<HTMLElement>('.floating-ball-translate')!;
    expect(translation().getAttribute('aria-busy')).toBe('true'); expect(translation().getAttribute('aria-label')).toContain('恢复网页原文');
    expect(port.document.querySelector('.translation-progress')).not.toBeNull();
    port.props.initialTranslationStatus = 'translated'; await flush(); expect(port.document.querySelector('.check-mark')).not.toBeNull();
    port.props.initialTranslationStatus = 'error'; await flush(); expect(port.document.querySelector('.translation-error')?.textContent).toBe('!');
    port.click(translation()); expect(port.translate).toHaveBeenLastCalledWith(false);
    port.exposed.value!.setTranslationState(false); port.exposed.value!.setTranslationStatus('idle'); await flush();
    expect(port.ball().getAttribute('data-translation-status')).toBe('idle'); expect(translation().getAttribute('aria-label')).toBe('翻译整个网页');
    port.props.initialTranslating = false; await flush();
    port.props.initialTranslating = true; port.props.initialTranslationStatus = 'translated'; await flush();
    expect(port.ball().getAttribute('data-translation-status')).toBe('translated');
    port.exposed.value!.setPopupOpen(true); await flush(); expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    port.exposed.value!.setPopupOpen(false); await flush();
    port.props.position = 'left'; port.props.verticalPosition = .25; port.props.presentation = {clickAction: 'settings', compact: true, settingsEntryVisible: false}; await flush();
    expect(port.ball().getAttribute('data-position')).toBe('left'); expect(port.ball().style.top).toContain('200px');
    expect(port.ball().classList.contains('is-compact')).toBe(true); expect(port.document.querySelector('.floating-ball-settings')).toBeNull();
    port.click(port.main(), 0); expect(port.settings).toHaveBeenCalledOnce();
    port.props.showMenu = false; await flush(); expect(port.document.querySelector('.floating-ball-translate')).toBeNull();
  });

  it('opens after the configured hover delay, cancels a departing hover, and gives keyboard focus immediate access', async () => {
    const port = mountBall({presentation: {hoverDelay: 200}});await flush();
    const expanded = () => port.ball().classList.contains('floating-ball-expanded');
    port.ball().dispatchEvent(port.event('mouseenter'));vi.advanceTimersByTime(100);await flush();expect(expanded()).toBe(false);
    port.ball().dispatchEvent(port.event('mouseleave'));vi.advanceTimersByTime(200);await flush();expect(expanded()).toBe(false);
    port.ball().dispatchEvent(port.event('mouseenter'));vi.advanceTimersByTime(200);await flush();expect(expanded()).toBe(true);
    port.ball().dispatchEvent(port.event('mouseleave'));await flush();expect(expanded()).toBe(false);
    port.ball().dispatchEvent(port.event('mouseenter'));port.main().dispatchEvent(port.event('focusin'));await flush();expect(expanded()).toBe(true);expect(vi.getTimerCount()).toBe(0);
    port.document.dispatchEvent(port.event('keydown', {key: 'Escape'}));await flush();expect(expanded()).toBe(false);
    port.props.presentation = {toolsDisplay: 'always'};await flush();expect(expanded()).toBe(true);
    port.ball().dispatchEvent(port.event('mouseenter'));port.ball().dispatchEvent(port.event('mouseleave'));port.main().dispatchEvent(port.event('focusin'));await flush();expect(expanded()).toBe(true);expect(vi.getTimerCount()).toBe(0);
    port.props.presentation = {toolsDisplay: 'hover', hoverDelay: 0};await flush();port.ball().dispatchEvent(port.event('mouseenter'));await flush();expect(expanded()).toBe(true);
  });
  it('keeps manga controls available during current keyboard focus, resets mouse idle delay, and reports progress or errors without new translation', async () => {
    const port = mountBall({manga: {available: true, active: false, pending: false, errors: 0}});await flush();
    let focused = false, hovered = false;
    const find = port.ball().querySelector.bind(port.ball()), matches = port.ball().matches.bind(port.ball());
    vi.spyOn(port.ball(), 'querySelector').mockImplementation((selector: string) => selector === ':focus-visible' || selector === ':focus' ? focused ? port.main() : null : find(selector));
    vi.spyOn(port.ball(), 'matches').mockImplementation((selector: string) => selector === ':hover' ? hovered : matches(selector));
    const expanded = () => port.ball().classList.contains('floating-ball-expanded'), manga = () => port.document.querySelector<HTMLElement>('.floating-ball-manga')!;
    port.ball().dispatchEvent(port.event('pointermove', {pointerType: 'touch'}));await flush();expect(expanded()).toBe(false);
    port.ball().dispatchEvent(port.event('pointermove', {pointerType: 'mouse'}));await flush();expect(expanded()).toBe(true);
    vi.advanceTimersByTime(2000);port.ball().dispatchEvent(port.event('pointermove', {pointerType: 'mouse'}));vi.advanceTimersByTime(2000);await flush();expect(expanded()).toBe(true);
    focused = true;vi.advanceTimersByTime(500);await flush();expect(expanded()).toBe(true);
    port.main().dispatchEvent(port.event('focusin'));port.click(manga(), 0);await flush();expect(vi.getTimerCount()).toBe(0);expect(port.mangaToggle).toHaveBeenCalledOnce();
    focused = false;hovered = true;port.ball().dispatchEvent(port.event('focusout'));await flush();expect(expanded()).toBe(true);
    port.click(manga(), 1);vi.advanceTimersByTime(2500);await flush();expect(expanded()).toBe(false);expect(port.mangaToggle).toHaveBeenCalledTimes(2);
    port.props.manga = {available: true, active: true, pending: true, errors: 0, message: '正在识别'};await flush();expect(manga().getAttribute('title')).toContain('正在识别');expect(manga().getAttribute('aria-busy')).toBe('true');
    port.props.manga.message = '';await flush();expect(manga().getAttribute('title')).toContain('正在处理当前漫画页');
    port.props.manga.pending = false;port.props.manga.errors = 1;await flush();expect(port.document.querySelector('.manga-error')).not.toBeNull();expect(manga().getAttribute('title')).toContain('部分页面未完成');
    port.props.manga.errors = 0;port.props.manga.completed = 2;await flush();expect(port.document.querySelector('.manga-check')).not.toBeNull();expect(manga().getAttribute('title')).toContain('连续翻译已开启');
    port.props.manga.areaFallback = true;await flush();expect(manga().getAttribute('aria-label')).toBe('圈选漫画翻译');expect(manga().getAttribute('title')).toContain('拖选可见区域');expect(port.translate).not.toHaveBeenCalled();
    port.props.presentation = {toolsDisplay: 'always'};await flush();port.click(manga(), 0);expect(vi.getTimerCount()).toBe(0);
  });
  it('routes the settings tool and synchronizes public position changes without interrupting an unchanged drag', async () => {
    const port = mountBall({position: 'right', verticalPosition: .5});await flush();
    port.ball().dispatchEvent(port.event('mouseenter'));await flush();const settings = port.document.querySelector<HTMLElement>('.floating-ball-settings')!;
    const blur = vi.spyOn(settings, 'blur');port.click(settings, 1);await flush();expect(blur).toHaveBeenCalledOnce();expect(port.settings).toHaveBeenCalledOnce();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    port.exposed.value!.setPosition('left', .2);await flush();expect(port.ball().getAttribute('data-position')).toBe('left');expect(port.ball().style.top).toContain('160px');
    port.pointer('pointerdown');port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window');await flush();const draggedTop = port.ball().style.top;
    port.exposed.value!.setPosition('left', .2);await flush();expect(port.ball().classList.contains('dragging')).toBe(true);expect(port.ball().style.top).toBe(draggedTop);
    port.pointer('pointercancel', {pointerId: 2}, 'window');await flush();expect(port.ball().classList.contains('dragging')).toBe(true);
    port.pointer('pointercancel', {pointerId: 1}, 'window');await flush();expect(port.ball().classList.contains('dragging')).toBe(false);expect(port.savePosition).not.toHaveBeenCalled();
  });
  it('clears touch expansion on outside interaction and hidden menus, and never starts a secondary mouse button gesture', async () => {
    const port = mountBall();await flush();port.pointer('pointerdown', {pointerType: 'mouse', button: 2});expect(port.windowListeners.get('pointerup')?.size ?? 0).toBe(0);
    port.pointer('pointerdown');port.pointer('pointerup');await flush();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    port.document.body.dispatchEvent(port.event('pointerdown'));await flush();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    port.pointer('pointerdown');port.pointer('pointercancel');await flush();port.props.showMenu = false;await flush();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    port.pointer('pointerup');expect(port.translate).toHaveBeenCalledTimes(1);
  });
  it('releases viewport subscription, document/window listeners and pending hover timers on unmount', async () => {
    const port = mountBall({presentation: {hoverDelay: 200}}); await flush();
    expect(port.observeViewport).toHaveBeenCalledOnce();
    port.ball().dispatchEvent(port.event('mouseenter')); port.pointer('pointerdown');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    port.unmount(); expect(port.stopViewport).toHaveBeenCalledOnce();
    for (const [name, callback, options] of port.addDocument.mock.calls) {
      if (name === 'keydown' || name === 'pointerdown') {
        if (options === undefined) expect(port.removeDocument).toHaveBeenCalledWith(name, callback);
        else expect(port.removeDocument).toHaveBeenCalledWith(name, callback, options);
      }
    }
    expect([...port.windowListeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(port.errors).not.toHaveBeenCalled();
  });
});
