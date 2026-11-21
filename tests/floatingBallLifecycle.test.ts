/**
 * @file tests/floatingBallLifecycle.test.ts
 * 文件职责：执行悬浮球真实 Vue SFC 的 setup、模板、watch 与挂载/卸载逻辑。
 * 主要内容：覆盖原生点击与拖动后续 click 去重、辅助激活、拖动合帧和取消不保存、视口变化、props/翻译状态和事件资源释放。
 * 模块边界：直接导入生产 SFC 并使用 Vue 自定义 DOM renderer；仅把语言、视口订阅和元素几何作为受控平台端口，不以此代替真实浏览器 CSS/触摸或焦点验收。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as Vue from 'vue';
import {parseHTML} from 'linkedom';
import FloatingBall from '@/src/features/floating-ball/ui/FloatingBall.vue';

const platform = vi.hoisted(() => ({viewport: () => ({}), observe: (_callback: () => void): (() => void) => () => {}}));
vi.mock('@/src/platform/dom/visualViewport', () => ({getSafeVisualViewportRect: () => platform.viewport(), observeVisualViewport: (callback: () => void) => platform.observe(callback)}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text,
  t: (key: string) => ({'common.brand': '流畅阅读', 'fullPage.progress.title': '翻译中', 'fullPage.progress.failuresTitle': '翻译失败', 'fullPage.progress.completed': '已完成'}[key] || key)})}));
let app: Vue.App | undefined;
let componentErrors: ReturnType<typeof vi.fn> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined;
  expect(componentErrors).not.toHaveBeenCalled(); componentErrors = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

type BallApi = {setTranslationState(value: boolean): void; setTranslationStatus(value: string): void;
  setPosition(side: 'left' | 'right', vertical: number | null): void; setPopupOpen(open: boolean): void};

function mountBall(initial: Record<string, unknown> = {}, navigatorPort: {maxTouchPoints?: number} | null = {maxTouchPoints: 0}) {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  const parsed = parseHTML('<html><body></body></html>');
  const {document} = parsed;
  const windowListeners = new Map<string, Set<EventListener>>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  const window = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
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
  let focusVisible: Element | null = null;
  const registered = new WeakMap<Element, Map<string, EventListener>>();
  const renderer = Vue.createRenderer<Node, Element>({
    // 真实浏览器DOM不会成为Vue响应式对象；Linkedom的元素需显式markRaw保持事件composedPath身份。
    createElement: (tag, namespace) => {
      const element = Vue.markRaw(namespace === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag));
      if (tag === 'button') {
        const matches = element.matches.bind(element);
        Object.defineProperty(element, 'matches', {
          value: (selector: string) => selector === ':focus-visible' ? element === focusVisible : matches(selector),
        });
      }
      return element;
    },
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    insert: (node, parent, anchor) => {parent.insertBefore(node, anchor ?? null);}, remove: node => {node.parentNode?.removeChild(node);},
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling,
    setScopeId: (element, id) => element.setAttribute(id, ''), cloneNode: node => Vue.markRaw(node.cloneNode(true)),
    insertStaticContent: (html, parent, anchor) => {const box = document.createElement('div');box.innerHTML = html;
      const first = box.firstChild!, last = box.lastChild!;while (box.firstChild) parent.insertBefore(box.firstChild, anchor ?? null);return [first, last];},
    patchProp(element, key, previous, value) {
      if (/^on[A-Z]/.test(key)) {
        const name = key.slice(2).replace(/Capture$/, '').toLowerCase(); const listeners = registered.get(element) || new Map<string, EventListener>(); registered.set(element, listeners);
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
  const style = (name: string) => Number.parseFloat(ball().style.getPropertyValue(name));
  const rect = () => {
    const left = style('--fr-drag-x') || style('--fr-ball-x') || 0;
    const top = style('--fr-drag-y') || style('--fr-ball-y') || 0;
    const size = style('--fr-ball-size');
    return {left, top, width: size, height: size, right: left + size, bottom: top + size};
  };
  const readMainRect = vi.fn(rect);
  Object.defineProperty(main(), 'getBoundingClientRect', {value: readMainRect});
  const event = (type: string, values: Record<string, unknown> = {}) => {
    const next = new parsed.window.Event(type, {bubbles: true, cancelable: true});
    for (const [name, value] of Object.entries(values)) Object.defineProperty(next, name, {value, configurable: true});
    return next;
  };
  const dispatchWindow = (next: Event) => {for (const handler of [...windowListeners.get(next.type) || []]) handler(next);};
  const pointer = (type: string, values: Record<string, unknown> = {}, target: Element | 'window' = main()) => {
    const next = event(type, {pointerId: 1, pointerType: 'touch', button: 0, clientX: 983, clientY: 400, ...values});
    if (target !== 'window') target.dispatchEvent(next); dispatchWindow(next); return next;
  };
  const click = (target: Element = main(), detail = 1) => target.dispatchEvent(event('click', {detail}));
  const over = () => ball().dispatchEvent(event('pointerenter', {pointerType: 'mouse'}));
  const leave = () => ball().dispatchEvent(event('pointerleave', {pointerType: 'mouse'}));
  const focus = (target: Element | null = main()) => {
    const previous = focusVisible;
    focusVisible = target;
    previous?.dispatchEvent(event('focusout', {relatedTarget: target}));
    target?.dispatchEvent(event('focusin', {relatedTarget: previous}));
  };
  const frame = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(performance.now());
    }
  };
  return {ball, main, props, document, window, windowListeners, translate, savePosition, settings, mangaToggle, errors, exposed,
    over, leave, focus, style, frame, readMainRect,
    addDocument, removeDocument, stopViewport, observeViewport, event, dispatchWindow, pointer, click,
    viewport: (next: typeof viewport) => {viewport = next; viewportCallback!();},
    unmount: () => {current.unmount(); app = undefined;}};
}

async function flush() {await Vue.nextTick(); await Vue.nextTick();}

describe('FloatingBall actual SFC lifecycle', () => {
  it.each(['left', 'right'] as const)('tucks the desktop button and retains its click corridor at the %s edge', async side => {
    const port = mountBall({position: side});
    const left = side === 'left';
    const x = () => port.style('--fr-ball-x');
    await flush();
    expect(x()).toBe(left ? -17 : 983);
    port.over();
    await flush();
    expect(x()).toBe(left ? 20 : 946);
    expect(port.style(left ? '--fr-ball-hit-left' : '--fr-ball-hit-right')).toBe(37);
    port.leave();
    vi.advanceTimersByTime(140);
    await flush();
    expect(x()).toBe(left ? -17 : 983);
    port.props.presentation = {defaultMargin: 0, popoutMargin: 32};
    await flush();
    expect(x()).toBe(left ? -17 : 983);
    port.focus();
    await flush();
    expect(x()).toBe(left ? 32 : 934);
  });

  it.each([0, 20])('keeps equal nonnegative margins at %d px while idle and expanded', async margin => {
    const port = mountBall({presentation: {defaultMargin: margin, popoutMargin: margin}});
    await flush();
    expect(port.style('--fr-ball-x')).toBe(966 - margin);
    port.over();
    await flush();
    expect(port.style('--fr-ball-x')).toBe(966 - margin);
  });

  it('centers settings above and hide below without moving the main button vertically', async () => {
    const port = mountBall({onHide: vi.fn()});
    const y = port.style('--fr-ball-y');
    port.over();
    await flush();
    const above = port.ball().querySelector<HTMLElement>('[data-stack="above"]')!;
    const below = port.ball().querySelector<HTMLElement>('[data-stack="below"]')!;
    expect(above.querySelector('.floating-ball-settings')).not.toBeNull();
    expect(below.querySelector('.floating-ball-hide')).not.toBeNull();
    expect(above.style.left).toBe('2px');
    expect(below.style.left).toBe('2px');
    expect(above.style.top).toBe('-34px');
    expect(below.style.top).toBe('38px');
    expect(port.style('--fr-ball-y')).toBe(y);
  });

  it.each([[0, 'below', '38px'], [1, 'above', '-68px']] as const)(
    'keeps both desktop controls in view with the main button at position %d', async (verticalPosition, stack, top) => {
      const port = mountBall({verticalPosition, onHide: vi.fn()});
      port.over();
      await flush();
      const groups = port.ball().querySelectorAll<HTMLElement>('.floating-ball-tools');
      expect(groups).toHaveLength(1);
      expect(groups[0].getAttribute('data-stack')).toBe(stack);
      expect(groups[0].style.top).toBe(top);
      expect(groups[0].querySelector('.floating-ball-settings')).not.toBeNull();
      expect(groups[0].querySelector('.floating-ball-hide')).not.toBeNull();
    },
  );

  it('keeps the manga target in place and makes the vertical stack scroll in a short touch viewport', async () => {
    const port = mountBall({
      presentation: {clickAction: 'none'},
      manga: {available: true, active: true, pending: false, errors: 0},
      onMangaReading: vi.fn(),
      onHide: vi.fn(),
    }, {maxTouchPoints: 5});
    port.viewport({left: 0, top: 0, right: 390, bottom: 170, width: 390, height: 170});
    await flush();
    const mangaOffset = port.style('--fr-manga-y');
    expect(mangaOffset).toBe(48);
    port.focus();
    await flush();
    const above = port.ball().querySelector<HTMLElement>('[data-stack="above"]')!;
    expect(above.style.top).toBe('-63px');
    expect(above.style.maxHeight).toBe('59px');
    expect(above.classList.contains('is-scrollable')).toBe(true);
    expect(above.querySelectorAll('button')).toHaveLength(4);
    expect(port.style('--fr-tool-size')).toBe(44);
    expect(port.style('--fr-manga-y')).toBe(mangaOffset);
  });

  it.each(['left', 'right'] as const)('keeps equal signed margins stationary and clamps inaccessible values on the %s edge', async side => {
    const port = mountBall({position: side, presentation: {defaultMargin: -4, popoutMargin: -4}});
    const x = () => port.style('--fr-ball-x');
    await flush();
    const initial = side === 'left' ? -4 : 970;
    expect(x()).toBe(initial);
    port.over();
    await flush();
    expect(x()).toBe(initial);
    port.props.presentation = {...port.props.presentation, popoutMargin: -200};
    await flush();
    expect(x()).toBe(side === 'left' ? -6 : 972);
    port.leave();
    vi.advanceTimersByTime(140);
    await flush();
    expect(x()).toBe(initial);
  });

  it.each(['always', 'hidden'])('uses only the default margin outside hover mode: %s', async toolsDisplay => {
    const port = mountBall({position: 'right', presentation: {toolsDisplay, defaultMargin: 12, popoutMargin: 80}});
    port.over();
    await flush();
    expect(port.style('--fr-ball-x')).toBe(954);
    port.props.presentation = {...port.props.presentation, popoutMargin: -80};
    await flush();
    expect(port.style('--fr-ball-x')).toBe(954);
  });

  it('retains margin values when docking and uses the panned visible viewport origin', async () => {
    const port = mountBall({position: 'right', presentation: {defaultMargin: 15, popoutMargin: 30}});
    port.viewport({left: 80, top: 160, right: 470, bottom: 560, width: 390, height: 400});
    await flush();
    expect(port.style('--fr-ball-x')).toBe(421);
    expect(port.style('--fr-ball-y')).toBe(343);
    expect(port.ball().classList.contains('viewport-sync')).toBe(true);
    port.frame();
    await flush();
    expect(port.ball().classList.contains('viewport-sync')).toBe(false);
    port.exposed.value!.setPosition('left', 0.5);
    await flush();
    expect(port.style('--fr-ball-x')).toBe(95);
  });

  it('offers the injected secondary manga reading action without changing the main toggle', async () => {
    const read=vi.fn();const port=mountBall({manga:{available:true,active:true,pending:false,errors:0},onMangaReading:read,presentation:{toolsDisplay:'hover',hoverDelay:0}});await flush();
    port.over();await flush();const button=port.document.querySelector<HTMLElement>('.floating-ball-reading')!;
    expect(button.getAttribute('aria-label')).toBe('查看漫画文字');expect(button.getAttribute('aria-expanded')).toBe('false');port.click(button,0);expect(read).toHaveBeenCalledOnce();expect(port.mangaToggle).not.toHaveBeenCalled();
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');expect(button.textContent?.trim()).toBe('');
    port.props.mangaReadingOpen=true;await flush();port.leave();vi.advanceTimersByTime(3000);await flush();expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);expect(button.getAttribute('aria-expanded')).toBe('true');expect(button.getAttribute('aria-label')).toBe('关闭漫画文字');
    port.props.manga.areaFallback=true;await flush();expect(port.document.querySelector('.floating-ball-reading')).toBeNull();
  });
  it('keeps the hover tool expanded while shared reading state is open and collapses after it closes',async()=>{
    const port=mountBall({manga:{available:true,active:true,pending:false,errors:0},onMangaReading:vi.fn(),mangaReadingState:{open:true},presentation:{toolsDisplay:'hover',hoverDelay:0}});await flush();
    port.over();await flush();port.leave();vi.advanceTimersByTime(3000);await flush();
    const button=port.document.querySelector<HTMLElement>('.floating-ball-reading')!;
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);expect(button.getAttribute('aria-expanded')).toBe('true');
    port.props.mangaReadingState.open=false;await flush();port.leave();vi.advanceTimersByTime(3000);await flush();
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

  it.each(['touch', 'mouse'])('uses the native %s click as the only activation', async pointerType => {
    const port = mountBall({}, {maxTouchPoints: pointerType === 'touch' ? 5 : 0});
    await flush();
    port.pointer('pointerdown', {pointerType});
    port.pointer('pointerup', {pointerType});
    await flush();
    expect(port.translate).not.toHaveBeenCalled();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    port.click();
    await flush();
    expect(port.translate).toHaveBeenCalledExactlyOnceWith(true);
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(pointerType === 'touch');
    expect(port.style('--fr-ball-x')).toBe(pointerType === 'touch' ? 956 : 983);
    expect(port.savePosition).not.toHaveBeenCalled();
    expect([...port.windowListeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    port.click(port.main(), 0);
    expect(port.translate).toHaveBeenCalledTimes(2);
  });

  it('uses a native button, blocks keyboard repeats and preserves a focus target when the main action is disabled', async () => {
    const port = mountBall();
    await flush();
    expect(port.main().tagName).toBe('BUTTON');
    port.click(port.main(), 0);
    expect(port.translate).toHaveBeenCalledExactlyOnceWith(true);
    const repeatedEnter = port.event('keydown', {key: 'Enter', repeat: true});
    port.main().dispatchEvent(repeatedEnter);
    expect(repeatedEnter.defaultPrevented).toBe(true);
    port.props.presentation = {clickAction: 'none'};
    await flush();
    expect(port.main().getAttribute('aria-disabled')).toBe('true');
    port.click(port.main(), 0);
    expect(port.translate).toHaveBeenCalledTimes(1);
  });

  it('coalesces drag from the visible half into one frame and saves the release point without a click', async () => {
    const port = mountBall();
    await flush();
    port.pointer('pointerdown', {clientX: 993});
    port.pointer('pointermove', {clientX: 304, clientY: 330}, 'window');
    port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window');
    expect(port.window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(Number.isNaN(port.style('--fr-drag-x'))).toBe(true);
    port.frame();
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(true);
    expect(port.style('--fr-drag-x')).toBe(290);
    expect(port.style('--fr-drag-y')).toBe(323);
    expect(port.readMainRect).toHaveBeenCalledOnce();
    port.pointer('pointermove', {clientX: 310, clientY: 344}, 'window');
    port.pointer('pointerup', {clientX: 315, clientY: 350});
    port.click();
    await flush();
    expect(port.window.cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(port.savePosition).toHaveBeenCalledExactlyOnceWith('left', .4375);
    expect(port.ball().getAttribute('data-position')).toBe('left');
    expect(port.ball().classList.contains('dragging')).toBe(false);
    expect(port.translate).not.toHaveBeenCalled();
    port.click(port.main(), 0);
    expect(port.translate).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['pointercancel', 'blur', 'viewport'])('cancels drag on %s and restores the dock without saving', async reason => {
    const port = mountBall();
    port.pointer('pointerdown');
    port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window');
    port.frame();
    if (reason === 'viewport') port.viewport({left: 20, top: 100, right: 370, bottom: 500, width: 350, height: 400});
    else if (reason === 'blur') port.dispatchWindow(port.event('blur'));
    else port.pointer('pointercancel', {}, 'window');
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(false);
    expect(port.style('--fr-ball-y')).toBe(reason === 'viewport' ? 283 : 383);
    port.pointer('pointerup', {clientX: 300, clientY: 340}, 'window');
    port.click();
    expect(port.savePosition).not.toHaveBeenCalled();
    expect(port.translate).not.toHaveBeenCalled();
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

  it('shows translation state on the current action and avoids duplicate toolbar buttons', async () => {
    const port = mountBall({initialTranslating: true, initialTranslationStatus: 'translating'});
    await flush();
    const translation = () => port.ball().querySelector<HTMLButtonElement>('.floating-ball-translate')!;
    expect(translation()).toBeNull();
    expect(port.main().getAttribute('aria-busy')).toBe('true');
    expect(port.main().getAttribute('aria-label')).toContain('恢复网页原文');
    expect(port.main().querySelector('[data-status="translating"]')).not.toBeNull();
    port.props.initialTranslationStatus = 'translated';
    await flush();
    expect(port.main().querySelector('[data-status="translated"]')).not.toBeNull();
    port.props.presentation = {clickAction: 'settings', theme: 'dark'};
    port.props.initialTranslationStatus = 'error';
    await flush();
    expect(port.ball().getAttribute('data-theme')).toBe('dark');
    expect(port.ball().querySelector('.floating-ball-settings')).toBeNull();
    expect(translation().querySelector('[data-status="error"]')?.textContent).toBe('!');
    port.click(translation());
    expect(port.translate).toHaveBeenLastCalledWith(false);
    port.exposed.value!.setTranslationState(false);
    port.exposed.value!.setTranslationStatus('idle');
    await flush();
    expect(port.ball().getAttribute('data-translation-status')).toBe('idle');
    expect(translation().getAttribute('aria-label')).toBe('翻译整个网页');
    port.exposed.value!.setPopupOpen(true);
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    port.exposed.value!.setPopupOpen(false);
    port.props.position = 'left';
    port.props.verticalPosition = .25;
    port.props.presentation = {clickAction: 'settings', compact: true, settingsEntryVisible: false};
    await flush();
    expect(port.ball().getAttribute('data-position')).toBe('left');
    expect(port.style('--fr-ball-y')).toBe(185);
    expect(port.style('--fr-ball-size')).toBe(30);
    port.click(port.main(), 0);
    expect(port.settings).toHaveBeenCalledOnce();
    port.props.showMenu = false;
    await flush();
    expect(translation()).toBeNull();
  });

  it('opens after the configured hover delay, cancels a departing hover, and gives keyboard focus immediate access', async () => {
    const port = mountBall({presentation: {hoverDelay: 200}});await flush();
    const expanded = () => port.ball().classList.contains('floating-ball-expanded');
    port.over();vi.advanceTimersByTime(100);await flush();expect(expanded()).toBe(false);
    port.leave();vi.advanceTimersByTime(200);await flush();expect(expanded()).toBe(false);
    port.over();vi.advanceTimersByTime(200);await flush();expect(expanded()).toBe(true);
    port.leave();vi.advanceTimersByTime(140);await flush();expect(expanded()).toBe(false);
    port.over();port.focus();await flush();expect(expanded()).toBe(true);expect(vi.getTimerCount()).toBe(0);
    port.document.dispatchEvent(port.event('keydown', {key: 'Escape'}));await flush();expect(expanded()).toBe(false);
    port.props.presentation = {toolsDisplay: 'always'};await flush();expect(expanded()).toBe(true);
    port.over();port.leave();port.focus();await flush();expect(expanded()).toBe(true);expect(vi.getTimerCount()).toBe(0);
    port.props.presentation = {toolsDisplay: 'hover', hoverDelay: 0};await flush();port.over();await flush();expect(expanded()).toBe(true);
  });

  it('keeps hide choices open while moving into the panel and dismisses them without hiding the ball', async () => {
    const onHide = vi.fn();
    const port = mountBall({onHide, canHideOnSite: true, presentation: {toolsDisplay: 'hidden', clickAction: 'none'}});
    await flush();
    const hide = port.ball().querySelector<HTMLButtonElement>('.floating-ball-hide')!;
    const panel = () => port.ball().querySelector('.floating-ball-hide-panel');
    port.over();
    port.click(hide);
    await flush();
    port.leave();
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    expect(panel()?.querySelectorAll('button')).toHaveLength(3);
    port.document.dispatchEvent(port.event('keydown', {key: 'Escape'}));
    await flush();
    expect(panel()).toBeNull();
    expect(onHide).not.toHaveBeenCalled();

    port.click(hide);
    await flush();
    port.click(panel()!.querySelectorAll('button')[1]);
    await flush();
    expect(panel()).toBeNull();
    expect(onHide).toHaveBeenCalledExactlyOnceWith('site', expect.anything());
    expect(port.translate).not.toHaveBeenCalled();
    expect(port.savePosition).not.toHaveBeenCalled();
  });

  it('releases touch expansion when the quick panel closes', async () => {
    const port = mountBall({presentation: {clickAction: 'settings'}});
    port.pointer('pointerdown');
    port.pointer('pointerup');
    port.click();
    port.exposed.value!.setPopupOpen(true);
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    port.exposed.value!.setPopupOpen(false);
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
  });

  it('hides until reload directly in the userscript', async () => {
    vi.stubEnv('BROWSER', 'userscript');
    const onHide = vi.fn();
    const port = mountBall({onHide, canHideOnSite: true});
    await flush();
    const button = port.ball().querySelector<HTMLButtonElement>('.floating-ball-hide')!;
    expect(button.getAttribute('aria-label')).toBe('floatingBall.hide.page');
    port.click(button);
    await flush();
    expect(onHide).toHaveBeenCalledExactlyOnceWith('page', expect.anything());
    expect(port.ball().querySelector('.floating-ball-hide-panel')).toBeNull();
  });
  it('keeps manga controls available to keyboard users and preserves their status and anchor', async () => {
    const port = mountBall({manga: {available: true, active: false, pending: false, errors: 0}, onMangaReading: vi.fn()});
    const expanded = () => port.ball().classList.contains('floating-ball-expanded');
    const manga = () => port.ball().querySelector<HTMLElement>('.floating-ball-manga')!;
    port.over();
    await flush();
    expect(expanded()).toBe(true);
    const anchorY = port.style('--fr-ball-y');
    vi.advanceTimersByTime(2000);
    port.ball().dispatchEvent(port.event('pointermove', {pointerType: 'mouse'}));
    vi.advanceTimersByTime(2000);
    await flush();
    expect(expanded()).toBe(true);
    port.focus();
    vi.advanceTimersByTime(2500);
    await flush();
    expect(expanded()).toBe(true);
    port.focus(null);
    port.click(manga());
    vi.advanceTimersByTime(2500);
    await flush();
    expect(expanded()).toBe(false);
    expect(port.mangaToggle).toHaveBeenCalledOnce();

    port.props.manga = {available: true, active: true, pending: true, errors: 0, message: '正在识别'};
    await flush();
    expect(manga().getAttribute('title')).toContain('正在识别');
    expect(manga().getAttribute('aria-busy')).toBe('true');
    expect(port.ball().querySelector('.floating-ball-reading')).not.toBeNull();
    expect(port.style('--fr-ball-y')).toBe(anchorY);
    port.props.manga.pending = false;
    port.props.manga.errors = 1;
    await flush();
    expect(manga().querySelector('[data-status="error"]')).not.toBeNull();
    port.props.manga.errors = 0;
    port.props.manga.completed = 2;
    await flush();
    expect(manga().querySelector('[data-status="translated"]')).not.toBeNull();
    port.props.manga.areaFallback = true;
    await flush();
    expect(manga().getAttribute('aria-label')).toBe('圈选漫画翻译');
    expect(port.translate).not.toHaveBeenCalled();
  });

  it('routes the settings tool and keeps an unchanged external position from interrupting a drag', async () => {
    const port = mountBall({position: 'right', verticalPosition: .5});
    port.over();
    await flush();
    const settings = port.ball().querySelector<HTMLButtonElement>('.floating-ball-settings')!;
    port.click(settings);
    expect(port.settings).toHaveBeenCalledOnce();
    port.exposed.value!.setPosition('left', .2);
    await flush();
    expect(port.ball().getAttribute('data-position')).toBe('left');
    expect(port.style('--fr-ball-y')).toBe(143);
    port.pointer('pointerdown');
    port.pointer('pointermove', {clientX: 300, clientY: 340}, 'window');
    port.frame();
    await flush();
    const draggedTop = port.style('--fr-drag-y');
    port.exposed.value!.setPosition('left', .2);
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(true);
    expect(port.style('--fr-drag-y')).toBe(draggedTop);
    port.pointer('pointercancel', {pointerId: 2}, 'window');
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(true);
    port.pointer('pointercancel', {pointerId: 1}, 'window');
    await flush();
    expect(port.ball().classList.contains('dragging')).toBe(false);
    expect(port.savePosition).not.toHaveBeenCalled();
  });

  it('releases touch expansion outside the ball and ignores a secondary mouse button or finger', async () => {
    const port = mountBall({}, {maxTouchPoints: 5});
    await flush();
    expect(port.style('--fr-ball-size')).toBe(44);
    port.pointer('pointerdown', {pointerType: 'mouse', button: 2});
    port.pointer('pointerdown', {isPrimary: false});
    expect(port.windowListeners.get('pointerup')?.size ?? 0).toBe(0);
    port.pointer('pointerdown');
    port.pointer('pointerup');
    port.click();
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(true);
    port.document.body.dispatchEvent(port.event('pointerdown'));
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    port.pointer('pointerdown');
    port.pointer('pointercancel');
    port.click();
    await flush();
    expect(port.ball().classList.contains('floating-ball-expanded')).toBe(false);
    expect(port.translate).toHaveBeenCalledTimes(1);
  });

  it('releases viewport subscription, document/window listeners and pending hover timers on unmount', async () => {
    const port = mountBall({presentation: {hoverDelay: 200}}); await flush();
    expect(port.observeViewport).toHaveBeenCalledOnce();
    port.over(); port.pointer('pointerdown');
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
