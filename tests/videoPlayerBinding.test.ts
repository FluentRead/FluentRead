/**
 * @file tests/videoPlayerBinding.test.ts
 * 文件职责：验证播放器入口绑定在原生控制栏、信息流 fallback、禁用和视频切换时的节点所有权。
 * 主要内容：覆盖进度徽标、悬浮/聚焦可见性、原生控件重挂载和清理行为；包含无桌面挂载端口的移动 YouTube 同视频兄弟控制层，以及观察器处理副本和卸载的所有权边界。
 * 模块边界：使用注入的定位器与按钮工厂，不启动 content runtime 或字幕识别。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

vi.mock('@wxt-dev/storage', () => ({storage: {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), watch: vi.fn(() => () => undefined)}}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), watch: vi.fn(() => () => undefined)}}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn(), getURL: vi.fn(() => 'icon.png')}}}));

import {createVideoPlayerBinding} from '@/src/features/video-subtitle/content/videoPlayerBinding';
import type {VideoPlayerLocator, VideoPlayerTarget} from '@/src/features/video-subtitle/content/videoPlayerLocator';
import {createVideoPlayerMenu, syncVideoPlayerMenuLayout} from '@/src/features/video-subtitle/content/playerMenu';

function createFixture(markup = '<div class="player"><video></video><div class="ytp-right-controls"><button>settings</button><button>other</button></div></div>', fullDocument = false) {
  const parsed = parseHTML(fullDocument ? `<!doctype html><html><head></head><body>${markup}</body></html>` : `<!doctype html><body>${markup}</body>`);
  const view = parsed.window;
  vi.stubGlobal('window', view);
  vi.stubGlobal('document', parsed.document);
  vi.stubGlobal('Element', view.Element);
  vi.stubGlobal('Node', view.Node);
  vi.stubGlobal('HTMLButtonElement', view.HTMLButtonElement);
  vi.stubGlobal('MutationObserver', class {
    observe() {}
    disconnect() {}
  });
  const player = parsed.document.querySelector<HTMLElement>('.player')!;
  const video = player.querySelector<HTMLVideoElement>('video')!;
  Object.defineProperty(video, 'getBoundingClientRect', {value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
  Object.defineProperty(video, 'offsetWidth', {value: 640});
  Object.defineProperty(video, 'offsetHeight', {value: 360});
  const target: VideoPlayerTarget = {video, player, key: 'video:one', fullscreen: false, interacting: false};
  let current: VideoPlayerTarget | null = target;
  let listener: ((value: VideoPlayerTarget | null) => void) | undefined;
  const locator: VideoPlayerLocator = {
    getTarget: () => current,
    sync: () => current,
    subscribe: (next) => { listener = next; return () => undefined; },
    destroy: vi.fn(),
  };
  return {
    document: parsed.document,
    window: view,
    player,
    video,
    target,
    locator,
    setTarget: (next: VideoPlayerTarget | null) => {current = next; listener?.(next);},
    emit: (next: VideoPlayerTarget | null) => listener?.(next),
  };
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

/** 仅使用已知 mweb 同视频拓扑；不保留桌面 .ytp-right-controls，也不模拟像素层叠或浏览器命中。 */
function createMobileYoutubeFixture() {
  const fixture = createFixture('<div id="player-container-id" class="player-container sticky-player">'
    + '<div id="movie_player" class="player html5-video-player ytp-mweb-player"><video></video></div>'
    + '<ytm-custom-control><ytm-watch-player-controls><div id="player-control-overlay">'
    + '<div class="player-controls-content"><div class="player-controls-top">'
    + '<button aria-label="Settings">settings</button><button aria-label="Subtitles">CC</button></div>'
    + '<div class="player-controls-bottom player-controls-bottom-right">'
    + '<button aria-label="Full screen">fullscreen</button>'
    + '</div></div></div></ytm-watch-player-controls></ytm-custom-control></div>');
  const scope = fixture.document.querySelector<HTMLElement>('#player-container-id')!;
  Object.defineProperty(fixture.window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=entry-ownership')});
  const controls = scope.querySelector<HTMLElement>('.player-controls-bottom-right')!;
  const observerCallbacks: MutationCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: MutationCallback) {observerCallbacks.push(callback);}
    observe() {}
    disconnect = disconnect;
  });
  const changed = (target: Node, addedNodes: Node[] = [], removedNodes: Node[] = []) => {
    const records = [{type: 'childList', target, addedNodes, removedNodes}] as unknown as MutationRecord[];
    for (const callback of observerCallbacks) callback(records, {} as MutationObserver);
  };
  const createButton = vi.fn(() => {
    const button = fixture.document.createElement('button');
    button.id = 'fluent-read-video-subtitle-button';
    return button;
  });
  return {...fixture, scope, controls, changed, createButton, disconnect};
}

/** 用显式浏览器布局端口消费宿主样式；不声称 linkedom 可验证真实层叠命中。 */
function mobileMenuGeometry(f: ReturnType<typeof createMobileYoutubeFixture>) {
  const geometry = {
    player: {left: 40, top: 80, width: 402, height: 226},
    base: {left: 20, top: 30, width: 804, height: 452},
    width: 402, height: 226,
  };
  const bounds = (value: typeof geometry.player) => ({...value, right: value.left + value.width,
    bottom: value.top + value.height, x: value.left, y: value.top, toJSON: () => ({})});
  Object.defineProperties(f.player, {
    getBoundingClientRect: {configurable: true, value: () => bounds(geometry.player)},
    clientWidth: {configurable: true, get: () => geometry.width},
    clientHeight: {configurable: true, get: () => geometry.height},
  });
  const nativeRect = f.window.HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(f.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('fluent-read-video-menu-host')) {
      Object.defineProperties(this, {
        clientWidth: {configurable: true, get: () => Number.parseFloat(this.style.width)},
        clientHeight: {configurable: true, get: () => Number.parseFloat(this.style.height)},
      });
      return bounds(geometry.base) as DOMRect;
    }
    return nativeRect.call(this);
  });
  return geometry;
}

/** 保留真实菜单与样式序列化，仅补 linkedom 尚缺的标准 CSS priority 接口。 */
function ownedMenu() {
  const menu = createVideoPlayerMenu('en-US', false), actual = menu.style, priorities = new Map<string, string>();
  Object.defineProperty(menu, 'style', {configurable: true, value: new Proxy(actual, {
    get(target, property) {
      if (property === 'getPropertyPriority') return (name: string) => priorities.get(name) || '';
      if (property === 'setProperty') return (name: string, value: string, priority = '') => {priorities.set(name, priority); actual.setProperty(name, value);};
      if (property === 'removeProperty') return (name: string) => {priorities.delete(name); return actual.removeProperty(name);};
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    },
  })});
  return menu;
}

describe('mobile YouTube owned menu rendering scope', () => {
  it('observer repairs a site-moved menu host within the same scope while retaining content, listeners and focus', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(), item = menu.querySelector<HTMLButtonElement>('button')!;
    menu.hidden = false;
    let active: Element = f.document.body;
    Object.defineProperty(f.document, 'activeElement', {configurable: true, get: () => active});
    const focus = vi.spyOn(item, 'focus').mockImplementation(() => {active = item;});
    const menuClick = vi.fn(), buttonClick = vi.fn(); menu.addEventListener('click', menuClick);
    const factory = vi.fn(() => menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory, onButtonClick: buttonClick});
    const host = menu.parentElement!, button = f.createButton.mock.results[0].value;
    expect(host.classList.contains('fluent-read-video-menu-host')).toBe(true);
    expect(host.parentElement).toBe(f.scope); expect(host.clientWidth).toBe(402); expect(host.clientHeight).toBe(226);
    const wrongParent = f.document.createElement('div'); f.scope.appendChild(wrongParent);
    wrongParent.appendChild(host); active = item;
    const append = f.scope.appendChild.bind(f.scope);
    Object.defineProperty(f.scope, 'appendChild', {configurable: true, value: (node: Node) => {
      if (node === host) active = f.document.body;
      return append(node);
    }});
    // Target, sole video, scope and button host stay valid; only the menu host's direct parent is wrong.
    expect(f.scope.querySelectorAll('video')).toHaveLength(1);
    expect(f.scope.contains(f.controls)).toBe(true); expect(button.parentElement).toBe(f.controls);
    expect(host.parentElement).toBe(wrongParent); expect(focus).not.toHaveBeenCalled();
    f.changed(wrongParent, [host]); // Actual binding observer notification; no explicit sync or scope transition.
    expect(host.parentElement).toBe(f.scope); expect(menu.parentElement).toBe(host); expect(menu.hidden).toBe(false);
    expect(button.parentElement).toBe(f.controls); expect(binding.getTarget()).toBe(f.target);
    expect(factory).toHaveBeenCalledOnce(); expect(f.createButton).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith({preventScroll: true}); expect(active).toBe(item);
    item.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(menuClick).toHaveBeenCalledOnce();
    button.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(buttonClick).toHaveBeenCalledOnce();
    binding.destroy();
    expect(menu.isConnected).toBe(false); expect(host.isConnected).toBe(false); expect(button.isConnected).toBe(false);
    expect(wrongParent.isConnected).toBe(true);
  });

  it('calibrates the existing menu through its layout port without scanning the locator or recreating entry/menu', () => {
    const f = createMobileYoutubeFixture(), geometry = mobileMenuGeometry(f), menu = ownedMenu();
    const factory = vi.fn(() => menu), scans = vi.spyOn(f.locator, 'sync');
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const host = menu.parentElement!, button = f.createButton.mock.results[0].value; scans.mockClear();
    geometry.width = 240; geometry.height = 320; Object.assign(geometry.player, {left: 60, top: 100, width: 240, height: 320});
    binding.syncMenuHost();
    expect(menu.parentElement).toBe(host); expect(host.clientWidth).toBe(240); expect(host.clientHeight).toBe(320);
    expect(scans).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledOnce(); expect(f.createButton).toHaveBeenCalledOnce();
    expect(button.parentElement).toBe(f.controls);
    binding.destroy(); binding.syncMenuHost(); expect(host.isConnected).toBe(false); expect(scans).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'no-menu', 'detached-menu', 'detached-player', 'moved-video'] as const)('layout-only notifications cannot create/revive a menu after %s', state => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(), factory = vi.fn(() => state === 'no-menu' ? null : menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: state !== 'disabled'}), createButton: f.createButton, createMenu: factory});
    const parent = menu.parentElement;
    if (state === 'detached-menu') menu.remove();
    if (state === 'detached-player') f.player.remove();
    if (state === 'moved-video') f.document.body.appendChild(f.video);
    const scans = vi.spyOn(f.locator, 'sync'); scans.mockClear(); const before = factory.mock.calls.length;
    binding.syncMenuHost();
    expect(scans).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(before);
    if (state === 'detached-menu') expect(menu.isConnected).toBe(false);
    else expect(menu.parentElement).toBe(parent);
    binding.destroy();
  });

  it('keeps the media factory target while the real menu layout consumes a player-sized transparent sibling host', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    f.player.style.position = 'relative'; f.player.style.zIndex = '0';
    const overlay = f.scope.querySelector<HTMLElement>('#player-control-overlay')!;
    overlay.style.zIndex = '6'; overlay.style.pointerEvents = 'auto';
    const original = [f.player, f.scope, f.controls, overlay].map(node => node.getAttribute('style'));
    const menu = ownedMenu(); menu.hidden = false;
    Object.defineProperty(menu, 'scrollHeight', {value: 600});
    const factory = vi.fn(() => menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const host = menu.parentElement!;
    expect(host.classList.contains('fluent-read-video-menu-host')).toBe(true);
    expect(host.parentElement).toBe(f.scope);
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(menu.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(host.clientWidth).toBe(402); expect(host.clientHeight).toBe(226);
    expect(host.style.transform).toBe('translate(10px, 25px) scale(0.5, 0.5)');
    expect(host.style.getPropertyValue('transform-origin')).toBe('0 0');
    syncVideoPlayerMenuLayout(menu); expect(menu.dataset.layout).toBe('wide');
    binding.sync(); binding.sync();
    expect(factory).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledWith(f.target);
    expect(f.document.querySelectorAll('#fluent-read-video-subtitle-menu')).toHaveLength(1);
    expect([f.player, f.scope, f.controls, overlay].map(node => node.getAttribute('style'))).toEqual(original);
    binding.destroy();
    expect(host.isConnected).toBe(false); expect(menu.isConnected).toBe(false);
    expect(menu.style.getPropertyValue('pointer-events')).toBeFalsy();
  });

  it('reuses the same menu across player-only fullscreen, exit and scope fullscreen, restoring its prior pointer declaration', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(); menu.style.setProperty('pointer-events', 'all');
    const factory = vi.fn(() => menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const previous = menu.parentElement!;
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.player});
    f.setTarget({...f.target, fullscreen: true});
    expect(menu.parentElement).toBe(f.player); expect(previous.isConnected).toBe(false);
    expect(menu.style.getPropertyValue('pointer-events')).toBe('all');
    expect(menu.style.getPropertyPriority('pointer-events')).toBeFalsy();
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null}); f.setTarget(f.target);
    const restored = menu.parentElement!; expect(restored.parentElement).toBe(f.scope);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.scope});
    f.setTarget({...f.target, fullscreen: true});
    expect(menu.parentElement).toBe(restored); expect(factory).toHaveBeenCalledOnce();
    binding.destroy(); expect(menu.style.getPropertyValue('pointer-events')).toBe('all');
  });

  it('reparents the owned menu host to a replacement known scope without rebuilding menu content', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(), factory = vi.fn(() => menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const host = menu.parentElement!, next = f.document.createElement('div');
    next.id = 'player-container-id'; next.className = 'player-container';
    f.scope.id = 'old-player-container'; f.scope.after(next);
    const native = f.scope.querySelector('ytm-custom-control')!; next.append(f.player, native);
    f.changed(f.scope, [], [f.player, native]);
    expect(host.parentElement).toBe(next); expect(menu.parentElement).toBe(host);
    expect(factory).toHaveBeenCalledOnce(); expect(f.document.querySelectorAll('.fluent-read-video-menu-host')).toHaveLength(1);
    binding.destroy(); expect(host.isConnected).toBe(false);
  });

  it('preserves only an existing menu focus when moving it and does not take external focus', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(), item = menu.querySelector<HTMLButtonElement>('button')!;
    let active: Element = f.document.body;
    Object.defineProperty(f.document, 'activeElement', {configurable: true, get: () => active});
    const focus = vi.spyOn(item, 'focus').mockImplementation(() => {active = item;});
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: () => menu});
    expect(focus).not.toHaveBeenCalled();
    active = item;
    const append = f.player.appendChild.bind(f.player);
    Object.defineProperty(f.player, 'appendChild', {value: (node: Node) => {if (node === menu) active = f.document.body; return append(node);}});
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.player}); f.setTarget({...f.target, fullscreen: true});
    expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith({preventScroll: true}); expect(active).toBe(item);
    const external = f.document.createElement('input'); f.document.body.appendChild(external); active = external;
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null}); f.setTarget(f.target);
    expect(active).toBe(external); expect(focus).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it('Off removes menu and host, re-enable owns one fresh menu and late callbacks after destroy stay inert', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    let enabled = true;
    const factory = vi.fn(() => ownedMenu());
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled}), createButton: f.createButton, createMenu: factory});
    const menu = factory.mock.results[0].value, host = menu.parentElement!;
    enabled = false; binding.sync();
    expect(menu.isConnected).toBe(false); expect(host.isConnected).toBe(false);
    enabled = true; binding.sync();
    expect(factory).toHaveBeenCalledTimes(2); expect(f.document.querySelectorAll('#fluent-read-video-subtitle-menu')).toHaveLength(1);
    binding.destroy(); f.changed(f.scope, [f.document.createElement('div')]); binding.sync();
    expect(f.document.querySelector('.fluent-read-video-menu-host')).toBeNull(); expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps an open menu in the player when the external scope becomes ambiguous and recovers the same menu', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(); menu.hidden = false;
    const factory = vi.fn(() => menu);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const host = menu.parentElement!, other = f.document.createElement('video'); f.scope.appendChild(other);
    f.changed(f.scope, [other]);
    expect(menu.parentElement).toBe(f.player); expect(menu.hidden).toBe(false);
    expect(host.isConnected).toBe(false); expect(menu.style.getPropertyValue('pointer-events')).toBeFalsy();
    other.remove(); f.changed(f.scope, [], [other]);
    expect(menu.parentElement?.parentElement).toBe(f.scope); expect(factory).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it('releases an empty owned host when a replacement optional menu factory returns null', () => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu(), factory = vi.fn<() => HTMLElement | null>().mockReturnValueOnce(menu).mockReturnValue(null);
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: factory});
    const host = menu.parentElement!; f.document.body.appendChild(menu);
    binding.sync();
    expect(factory).toHaveBeenCalledTimes(2); expect(menu.isConnected).toBe(false); expect(host.isConnected).toBe(false);
    expect(menu.style.getPropertyValue('pointer-events')).toBeFalsy();
    binding.destroy();
  });

  it.each(['player-size', 'host-size'] as const)('uses the original player when %s geometry is unavailable and recovers when measurable', missing => {
    const f = createMobileYoutubeFixture(), geometry = mobileMenuGeometry(f);
    if (missing === 'player-size') {geometry.player.width = 0; geometry.width = 0;}
    else geometry.base.height = 0;
    const menu = ownedMenu();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: () => menu});
    expect(menu.parentElement).toBe(f.player); expect(f.scope.querySelector('.fluent-read-video-menu-host')).toBeNull();
    geometry.player.width = 402; geometry.width = 402; geometry.base.height = 452;
    binding.sync(); expect(menu.parentElement?.parentElement).toBe(f.scope);
    binding.destroy();
  });

  it.each(['value', 'priority'] as const)('does not overwrite a changed menu pointer %s during release', change => {
    const f = createMobileYoutubeFixture(); mobileMenuGeometry(f);
    const menu = ownedMenu();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu: () => menu});
    const value = change === 'value' ? 'none' : 'auto', priority = change === 'value' ? 'important' : '';
    menu.style.setProperty('pointer-events', value, priority);
    binding.destroy(); expect(menu.style.getPropertyValue('pointer-events')).toBe(value);
    expect(menu.style.getPropertyPriority('pointer-events')).toBe(priority);
  });
});

describe('mobile YouTube same-video external controls without a desktop mount port', () => {
  it('mounts one live entry beside external native fullscreen while retaining the media target', () => {
    const f = createMobileYoutubeFixture();
    const onButtonClick = vi.fn();
    const createMenu = vi.fn(() => f.document.createElement('div'));
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, createMenu, onButtonClick});
    expect(f.player.querySelector('.ytp-right-controls')).toBeNull();
    expect(f.player.contains(f.controls)).toBe(false);
    expect(f.controls.querySelectorAll('button:not(#fluent-read-video-subtitle-button)')).toHaveLength(1);
    expect(f.scope.querySelector('.player-controls-top [aria-label="Settings"]')).not.toBeNull();
    expect(f.scope.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    const button = f.scope.querySelector<HTMLButtonElement>('#fluent-read-video-subtitle-button')!;
    expect(button.parentElement).toBe(f.controls);
    expect(button.nextElementSibling).toBe(f.controls.querySelector('[aria-label="Full screen"]'));
    expect(binding.getTarget()).toBe(f.target);
    expect(createMenu).toHaveBeenCalledWith(f.target);
    binding.sync();
    expect(f.createButton).toHaveBeenCalledOnce();
    expect(createMenu).toHaveBeenCalledOnce();
    // 这里只验证绑定回调与实际节点身份；真实可信点击和覆盖层命中由生产浏览器专项验证。
    button.dispatchEvent(new f.window.Event('click', {bubbles: true}));
    expect(onButtonClick).toHaveBeenCalledOnce();
    expect(onButtonClick.mock.calls[0][1]).toBe(f.target);
    binding.destroy();
  });

  it.each(['pointerdown', 'focusin'])('associates external %s with only its current player and releases on leaving', type => {
    const f = createMobileYoutubeFixture();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const native = f.controls.querySelector('button')!;
    native.dispatchEvent(new f.window.Event(type, {bubbles: true}));
    expect(f.player.getAttribute('data-fluent-read-video-active')).toBe('true');
    const outside = f.document.createElement('button'); f.document.body.appendChild(outside);
    const leaving = new f.window.Event(type === 'focusin' ? 'focusout' : 'pointerout', {bubbles: true});
    Object.defineProperty(leaving, 'relatedTarget', {value: outside});
    native.dispatchEvent(leaving);
    expect(f.player.getAttribute('data-fluent-read-video-active')).toBe('false');
    outside.dispatchEvent(new f.window.Event(type, {bubbles: true}));
    expect(f.player.getAttribute('data-fluent-read-video-active')).toBe('false');
    binding.destroy();
  });

  it('preserves interaction when pointer and focus move between media and its external controls', () => {
    const f = createMobileYoutubeFixture();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const native = f.controls.querySelector('button')!;
    f.video.dispatchEvent(new f.window.Event('pointerover', {bubbles: true}));
    for (const type of ['pointerout', 'focusout']) {
      const leaving = new f.window.Event(type, {bubbles: true});
      Object.defineProperty(leaving, 'relatedTarget', {value: native});
      f.video.dispatchEvent(leaving);
      expect(f.player.getAttribute('data-fluent-read-video-active')).toBe('true');
    }
    native.dispatchEvent(new f.window.Event('focusin', {bubbles: true}));
    expect(f.scope.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    expect(f.createButton).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it.each(['empty', 'deep-clone'] as const)('observer repairs an external %s replacement with the same live listener', replacementKind => {
    const f = createMobileYoutubeFixture(), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0]?.value;
    expect(live?.parentElement).toBe(f.controls);
    const replacement = f.controls.cloneNode(true) as HTMLElement;
    const copy = replacement.querySelector<HTMLButtonElement>('#fluent-read-video-subtitle-button')!;
    if (replacementKind === 'empty') copy.remove();
    else {
      copy.dispatchEvent(new f.window.Event('click', {bubbles: true}));
      expect(click).not.toHaveBeenCalled();
    }
    const parent = f.controls.parentElement!;
    f.controls.replaceWith(replacement);
    f.changed(parent, [replacement], [f.controls]);
    expect(replacement.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    expect(live?.parentElement).toBe(replacement);
    expect(copy.isConnected).toBe(false);
    expect(f.createButton).toHaveBeenCalledOnce();
    live!.dispatchEvent(new f.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it('observer removes a same-host copied entry without replacing the live entry or claiming another owner', () => {
    const f = createMobileYoutubeFixture(), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0]?.value;
    expect(live?.parentElement).toBe(f.controls);
    const copy = live!.cloneNode(true) as HTMLButtonElement;
    const foreign = live!.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute('data-fluent-read-video-binding-owner', 'another-binding');
    f.controls.insertBefore(copy, live!); f.controls.appendChild(foreign);
    f.changed(f.controls, [copy, foreign]);
    expect(copy.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true);
    expect(live!.parentElement).toBe(f.controls);
    expect(f.createButton).toHaveBeenCalledOnce();
    live!.dispatchEvent(new f.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce();
    binding.destroy();
    expect(foreign.isConnected).toBe(true);
  });

  it('keeps the entry inside player-only fullscreen and restores the external group on exit', () => {
    const f = createMobileYoutubeFixture();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const live = f.createButton.mock.results[0].value;
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.player});
    f.setTarget({...f.target, fullscreen: true});
    expect(f.controls.contains(live)).toBe(false);
    expect(f.player.contains(live)).toBe(true);
    expect(live.parentElement?.classList.contains('fluent-read-video-controls')).toBe(true);
    expect(binding.getTarget()?.player).toBe(f.player);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null});
    f.setTarget(f.target);
    expect(live.parentElement).toBe(f.controls);
    expect(f.createButton).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it('retains the external group when the fullscreen element contains the whole same-video scope', () => {
    const f = createMobileYoutubeFixture();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const live = f.createButton.mock.results[0].value;
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.scope});
    f.setTarget({...f.target, fullscreen: true});
    expect(live.parentElement).toBe(f.controls);
    expect(f.player.querySelector('.fluent-read-video-controls')).toBeNull();
    expect(f.createButton).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it.each(['second-video', 'player-reparent'] as const)('observer immediately releases an external host whose ownership becomes invalid: %s', mutation => {
    const f = createMobileYoutubeFixture();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const live = f.createButton.mock.results[0].value;
    const copy = live.cloneNode(true); f.controls.appendChild(copy);
    let added: Node[] = [], removed: Node[] = [];
    if (mutation === 'second-video') {
      const otherVideo = f.document.createElement('video'); f.scope.appendChild(otherVideo); added = [otherVideo];
    } else {
      const outside = f.document.createElement('div'); f.document.body.appendChild(outside);
      outside.appendChild(f.player); removed = [f.player];
    }
    // 记录发生在原 scope，不能因重新查询范围退回 player 就丢弃这次结构变更。
    f.changed(f.scope, added, removed);
    expect(live.isConnected).toBe(false);
    expect(copy.isConnected).toBe(false);
    expect(f.controls.querySelector('#fluent-read-video-subtitle-button')).toBeNull();
    expect(f.createButton).toHaveBeenCalledOnce();
    binding.destroy();
    f.changed(f.scope, [f.document.createElement('button')]);
    expect(f.createButton).toHaveBeenCalledOnce();
    expect(f.document.querySelector('#fluent-read-video-subtitle-button')).toBeNull();
  });

  it('Off removes held external entries and copies, re-enable creates a live entry, and late work cannot resurrect after destroy', () => {
    const f = createMobileYoutubeFixture();
    let enabled = true;
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled}), createButton: f.createButton});
    const first = f.createButton.mock.results[0]?.value;
    expect(first?.parentElement).toBe(f.controls);
    const copy = first!.cloneNode(true) as HTMLButtonElement; f.controls.appendChild(copy);
    const foreign = first!.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute('data-fluent-read-video-binding-owner', 'another-binding'); f.controls.appendChild(foreign);
    enabled = false; binding.sync();
    expect(first!.isConnected).toBe(false);
    expect(copy.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true);
    expect(f.player.hasAttribute('data-fluent-read-video-active')).toBe(false);
    foreign.remove();
    enabled = true; binding.sync();
    expect(f.createButton).toHaveBeenCalledTimes(2);
    const second = f.createButton.mock.results[1].value;
    expect(second).not.toBe(first);
    expect(second.parentElement).toBe(f.controls);
    binding.destroy();
    f.changed(f.controls, [f.document.createElement('button')]);
    f.controls.dispatchEvent(new f.window.Event('pointerdown', {bubbles: true}));
    f.controls.dispatchEvent(new f.window.Event('focusin', {bubbles: true}));
    binding.sync();
    expect(f.scope.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(0);
    expect(f.createButton).toHaveBeenCalledTimes(2);
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['second-video', 'unknown-container'] as const)('does not adopt sibling controls when same-video ownership is ambiguous: %s', ambiguity => {
    const f = createMobileYoutubeFixture();
    if (ambiguity === 'second-video') f.scope.appendChild(f.document.createElement('video'));
    else f.scope.id = 'unrelated-container';
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    f.controls.dispatchEvent(new f.window.Event('pointerdown', {bubbles: true}));
    f.controls.dispatchEvent(new f.window.Event('focusin', {bubbles: true}));
    expect(f.controls.querySelector('#fluent-read-video-subtitle-button')).toBeNull();
    expect(f.player.getAttribute('data-fluent-read-video-active')).not.toBe('true');
    expect(f.createButton).not.toHaveBeenCalled();
    binding.destroy();
  });
});

describe('native picture-in-picture and fullscreen anchors', () => {
  it.each(['before-live', 'after-live'] as const)('observer removes a same-host copied entry %s without a manual sync', placement => {
    const fixture = createFixture('<div class="player"><video></video><div class="ytp-right-controls"><button>settings</button><button class="ytp-fullscreen-button">full</button></div></div>');
    let notify!: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {notify = callback;}
      observe() {}
      disconnect() {}
    });
    const click = vi.fn();
    const createButton = vi.fn(() => {
      const button = fixture.document.createElement('button');
      button.id = 'fluent-read-video-subtitle-button';button.addEventListener('click', click);return button;
    });
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton});
    const live = createButton.mock.results[0].value, host = live.parentElement!;
    const clone = live.cloneNode(true) as HTMLButtonElement;
    clone.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).not.toHaveBeenCalled();
    // 追加在 fullscreen 之后同样不改变 live 的 nextElementSibling，两个分支都须由副本身份触发。
    if (placement === 'before-live') host.insertBefore(clone, live); else host.appendChild(clone);
    const scans = vi.spyOn(fixture.locator, 'sync');
    notify([{type: 'childList', target: host, addedNodes: [clone], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce();expect(createButton).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    expect(clone.isConnected).toBe(false);expect(live.parentElement).toBe(host);
    live.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));expect(click).toHaveBeenCalledOnce();
    binding.destroy();scans.mockRestore();
  });

  it('observer repairs an entire copied control host with the live listener intact', () => {
    const fixture = createFixture();
    let notify!: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {notify = callback;}
      observe() {}
      disconnect() {}
    });
    const click = vi.fn(), live = fixture.document.createElement('button');
    live.id = 'fluent-read-video-subtitle-button';live.addEventListener('click', click);
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => live});
    const previous = live.parentElement!, replacement = previous.cloneNode(true) as HTMLElement;
    previous.replaceWith(replacement);
    notify([{type: 'childList', target: fixture.player, addedNodes: [replacement], removedNodes: [previous]}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(replacement.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    expect(live.parentElement).toBe(replacement);live.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce();binding.destroy();
  });

  it('observer ignores other-owner and tooltip updates, and is inert after destroy', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="ytp-right-controls"><button>settings</button><button class="ytp-fullscreen-button">full</button></div></div>');
    let notify!: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {notify = callback;}
      observe() {}
      disconnect() {}
    });
    const live = fixture.document.createElement('button');live.id = 'fluent-read-video-subtitle-button';
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => live});
    const host = live.parentElement!, foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute('data-fluent-read-video-binding-owner', 'another-binding');host.insertBefore(foreign, live);
    const tooltip = fixture.document.createElement('span');live.appendChild(tooltip);
    const scans = vi.spyOn(fixture.locator, 'sync');
    notify([
      {type: 'childList', target: host, addedNodes: [foreign], removedNodes: []},
      {type: 'childList', target: live, addedNodes: [tooltip], removedNodes: []},
    ] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).not.toHaveBeenCalled();expect(foreign.isConnected).toBe(true);
    const lateCopy = live.cloneNode(true) as HTMLButtonElement;
    binding.destroy();host.appendChild(lateCopy);
    notify([{type: 'childList', target: host, addedNodes: [lateCopy], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).not.toHaveBeenCalled();expect(lateCopy.isConnected).toBe(true);expect(foreign.isConnected).toBe(true);
    scans.mockRestore();
  });

  it.each([false, true])('keeps only the live button after a controls deep clone (new media: %s)', newMedia => {
    const fixture = createFixture();
    const click = vi.fn();
    const created: HTMLButtonElement[] = [];
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => {
        const button = fixture.document.createElement('button');
        button.id = 'fluent-read-video-subtitle-button';
        button.dataset.fluentReadClickBound = 'true';
        button.addEventListener('click', click);
        created.push(button);
        return button;
      }});
    const original = created[0];
    const controls = original.parentElement!;
    const replacement = controls.cloneNode(true) as HTMLElement;
    const copiedButton = replacement.querySelector<HTMLButtonElement>('#fluent-read-video-subtitle-button')!;
    expect(copiedButton.dataset.fluentReadClickBound).toBe('true');
    copiedButton.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).not.toHaveBeenCalled();
    controls.replaceWith(replacement);
    if (newMedia) fixture.setTarget({...fixture.target, key: 'video:ad'});
    else binding.sync();
    expect(replacement.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    const live = created[created.length - 1];
    expect(live.parentElement).toBe(replacement);
    expect(copiedButton.isConnected).toBe(false);
    live.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce();
    expect(created).toHaveLength(newMedia ? 2 : 1);
    if (newMedia) expect(live).not.toBe(original);
    binding.destroy();
    expect(replacement.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(0);
  });

  it.each(['move', 'empty-replacement'] as const)('retains the same live button for a controls %s', change => {
    const fixture = createFixture();
    const click = vi.fn();
    const createButton = vi.fn(() => {
      const button = fixture.document.createElement('button');
      button.id = 'fluent-read-video-subtitle-button';
      button.addEventListener('click', click);
      return button;
    });
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton});
    const button = createButton.mock.results[0].value;
    const previous = button.parentElement!;
    let host = previous;
    if (change === 'move') {
      const wrapper = fixture.document.createElement('div');
      fixture.player.appendChild(wrapper); wrapper.appendChild(previous);
    } else {
      host = fixture.document.createElement('div'); host.className = 'ytp-right-controls';
      previous.replaceWith(host);
    }
    binding.sync();
    expect(host.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(1);
    expect(button.parentElement).toBe(host);
    expect(createButton).toHaveBeenCalledOnce();
    button.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce();
    binding.destroy();
    expect(host.querySelectorAll('#fluent-read-video-subtitle-button')).toHaveLength(0);
  });

  it('cleans its held host on destroy without deleting another binding or same-id page nodes', () => {
    const fixture = createFixture();
    const createButton = () => {
      const button = fixture.document.createElement('button');
      button.id = 'fluent-read-video-subtitle-button';
      return button;
    };
    const first = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton});
    const second = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton});
    const host = fixture.player.querySelector<HTMLElement>('.ytp-right-controls')!;
    const [firstButton, secondButton] = Array.from(host.querySelectorAll<HTMLButtonElement>('#fluent-read-video-subtitle-button'));
    const clone = firstButton.cloneNode(true) as HTMLButtonElement;
    host.appendChild(clone);
    const pageButton = createButton(); host.appendChild(pageButton);
    const outside = firstButton.cloneNode(true) as HTMLButtonElement;
    fixture.document.body.appendChild(outside);
    first.destroy();
    expect(firstButton.isConnected).toBe(false);
    expect(clone.isConnected).toBe(false);
    expect(secondButton.isConnected).toBe(true);
    expect(pageButton.isConnected).toBe(true);
    expect(outside.isConnected).toBe(true);
    second.destroy();
    expect(secondButton.isConnected).toBe(false);
  });

  it('cleans copies left in the previous held host while moving to new native controls', () => {
    const fixture = createFixture('<div class="player"><video></video></div>');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => {
        const button = fixture.document.createElement('button');
        button.id = 'fluent-read-video-subtitle-button'; return button;
      }});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const previous = fixture.player.querySelector<HTMLElement>('.fluent-read-video-controls')!;
    const button = previous.querySelector<HTMLButtonElement>('button')!;
    const clone = button.cloneNode(true) as HTMLButtonElement; previous.appendChild(clone);
    const controls = fixture.document.createElement('div'); controls.className = 'ytp-right-controls';
    fixture.player.appendChild(controls);
    binding.sync();
    expect(clone.isConnected).toBe(false);
    expect(button.parentElement).toBe(controls);
    expect(previous.querySelectorAll('button')).toHaveLength(0);
    binding.destroy();
  });

  it('ignores caption element and icon churn while rebinding native button and host structure', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="captions"></div><div class="ytp-right-controls"><button aria-label="Settings"><span>icon</span></button><button aria-label="Full screen">full</button></div></div>');
    let notify!: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { notify = callback; }
      observe() {}
      disconnect() {}
    });
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => button});
    const scans = vi.spyOn(fixture.locator, 'sync'); scans.mockClear();
    const caption = fixture.player.querySelector('.captions')!;
    const native = fixture.player.querySelector('[aria-label="Settings"]')!;
    for (let index = 0; index < 180; index += 1) {
      notify([
        {type: 'childList', target: caption, addedNodes: [fixture.document.createElement('span')], removedNodes: []},
        {type: 'childList', target: native, addedNodes: [fixture.document.createElement('svg')], removedNodes: []},
        {type: 'attributes', target: caption, attributeName: 'title', addedNodes: [], removedNodes: []},
      ] as unknown as MutationRecord[], {} as MutationObserver);
    }
    expect(scans).not.toHaveBeenCalled();
    const host = button.parentElement!;
    const control = fixture.document.createElement('button'); control.setAttribute('aria-label', 'Picture in picture');
    host.insertBefore(control, button);
    notify([{type: 'childList', target: host, addedNodes: [control], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce(); scans.mockClear();
    const nestedButton = fixture.document.createElement('div'); nestedButton.appendChild(fixture.document.createElement('button'));
    host.insertBefore(nestedButton, button);
    notify([{type: 'childList', target: host, addedNodes: [nestedButton], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce(); scans.mockClear();
    const unlabeled = fixture.document.createElement('button');
    host.insertBefore(unlabeled, button);
    notify([{type: 'childList', target: host, addedNodes: [unlabeled], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce(); scans.mockClear();
    const wrapper = fixture.document.createElement('div'); fixture.player.appendChild(wrapper); wrapper.appendChild(host);
    notify([{type: 'childList', target: fixture.player, addedNodes: [wrapper], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce(); scans.mockClear();
    notify([{type: 'attributes', target: native, attributeName: 'aria-label', addedNodes: [], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce(); scans.mockClear();
    button.remove();
    notify([{type: 'childList', target: host, addedNodes: [], removedNodes: [button]}] as unknown as MutationRecord[], {} as MutationObserver);
    expect(scans).toHaveBeenCalledOnce();
    expect(button.parentElement).toBe(host);
    binding.destroy(); scans.mockRestore();
  });

  it.each([false, true])('restores a static containing block across the optional CSS priority boundary (%s)', withPriority => {
    const fixture = createFixture();
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true,
      value: {...fixture.window, getComputedStyle: () => ({position: 'static'})}});
    let priority = '';
    const style = {position: '', setProperty(_name: string, value: string, nextPriority: string) {this.position = value; priority = nextPriority;}};
    if (withPriority) Object.assign(style, {getPropertyPriority: () => priority});
    Object.defineProperty(fixture.player, 'style', {configurable: true, value: style});
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => fixture.document.createElement('button')});
    expect(style.position).toBe('relative');
    binding.destroy();
    expect(style.position).toBe('');
  });

  it('keeps player interaction stable when pointer and focus cross sibling controls', () => {
    const fixture = createFixture();
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
      getState: () => ({enabled: true}), createButton: () => fixture.document.createElement('button')});
    const controls = fixture.player.querySelectorAll('button');
    controls[0].dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const scans = vi.spyOn(fixture.locator, 'sync'); scans.mockClear();
    for (const type of ['pointerout', 'focusout']) {
      const event = new fixture.window.Event(type, {bubbles: true});
      Object.defineProperty(event, 'relatedTarget', {value: controls[1]});
      controls[0].dispatchEvent(event);
    }
    controls[1].dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    controls[1].dispatchEvent(new fixture.window.Event('focusin', {bubbles: true}));
    expect(scans).not.toHaveBeenCalled();
    expect(fixture.player.getAttribute('data-fluent-read-video-active')).toBe('true');
    binding.destroy(); scans.mockRestore();
  });

  it.each([
    ['aria-label="Full screen"', 'aria-label="Picture in picture"'],
    ['aria-label="Exit fullscreen"', 'aria-label="Picture-in-picture"'],
    ['aria-label="退出全屏"', 'aria-label="画中画"'],
    ['title="全螢幕"', 'aria-label="子母畫面"'],
    ['data-testid="videoFullscreenButton"', 'data-testid="videoPictureInPictureButton"'],
  ])('keeps the icon between wrapped controls using %s', (fullscreen, pip) => {
    const fixture = createFixture(`<div class="player" data-testid="videoPlayer"><video></video>
      <div class="bar"><button aria-label="Settings"></button><div class="actions">
        <div id="pip"><button ${pip}></button></div><div id="fullscreen"><button ${fullscreen}></button></div>
      </div></div></div>`);
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(button.parentElement?.className).toBe('actions');
    expect(button.previousElementSibling?.id).toBe('pip');
    expect(button.nextElementSibling?.id).toBe('fullscreen');
    const insert = vi.spyOn(button.parentElement!, 'insertBefore');
    binding.sync();
    fixture.setTarget({...fixture.target, fullscreen: true});
    fixture.setTarget({...fixture.target, fullscreen: false});
    expect(insert).not.toHaveBeenCalled();
    binding.destroy();
    expect(fixture.player.querySelector('.actions')?.children).toHaveLength(2);
  });

  it('anchors YouTube before its fullscreen button', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="ytp-right-controls"><button class="ytp-size-button"></button><button class="ytp-fullscreen-button"></button></div></div>');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(button.nextElementSibling?.className).toBe('ytp-fullscreen-button');
    binding.destroy();
  });

  it.each([false, true])('stays after picture-in-picture while fullscreen is absent (trailing control: %s)', trailing => {
    const fixture = createFixture(`<div class="player"><video></video><div class="bar"><button aria-label="Settings"></button><button id="pip" aria-label="画中画"></button>${trailing ? '<button id="other"></button>' : ''}</div></div>`);
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    binding.sync();
    expect(button.previousElementSibling?.id).toBe('pip');
    expect(button.nextElementSibling?.id || null).toBe(trailing ? 'other' : null);
    binding.destroy();
  });

  it('never treats buttons inside the FluentRead menu as the X control bar', () => {
    const fixture = createFixture('<div class="player" data-testid="videoPlayer"><video></video></div>');
    const button = fixture.document.createElement('button');
    const menu = fixture.document.createElement('div');
    menu.className = 'fluent-read-video-ui';
    menu.innerHTML = '<div class="title"><button aria-label="打开视频翻译设置"></button></div><button></button><button aria-label="Settings"></button>';
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, createMenu: () => menu});
    fixture.player.insertAdjacentHTML('beforeend', '<div class="bar"><button aria-label="Settings"></button><button id="pip" aria-label="Picture in picture"></button><button id="fullscreen" aria-label="Full screen"></button></div>');
    binding.sync();
    expect(menu.parentElement).toBe(fixture.player);
    expect(button.parentElement).toBe(fixture.player.querySelector('.bar'));
    fixture.player.querySelector('.bar')!.remove();
    menu.hidden = false;
    binding.sync();
    expect(button.isConnected).toBe(false);
    expect(menu.contains(button)).toBe(false);
    binding.destroy();
  });

  it('repairs host moves, late labels, and replacement controls through the observer without looping', () => {
    const fixture = createFixture('<div class="player" data-testid="videoPlayer"><video></video><div class="bar"><button aria-label="Settings"></button><button id="pip"></button><button id="fullscreen"></button></div></div>');
    let notify!: MutationCallback;
    const disconnect = vi.fn();
    vi.stubGlobal('MutationObserver', class {constructor(callback: MutationCallback) {notify = callback;} observe() {} disconnect = disconnect;});
    const button = fixture.document.createElement('button');
    const createMenu = vi.fn(() => fixture.document.createElement('div'));
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, createMenu});
    const bar = fixture.player.querySelector('.bar')!;
    const fullscreen = fixture.player.querySelector('#fullscreen')!;
    const changed = (target: Node, addedNodes: Node[] = [], removedNodes: Node[] = [], type = 'childList') =>
      notify([{target, addedNodes, removedNodes, type} as unknown as MutationRecord], {} as MutationObserver);
    fullscreen.setAttribute('aria-label', 'Full screen');
    changed(fullscreen, [], [], 'attributes');
    expect(button.nextElementSibling).toBe(fullscreen);
    for (const move of [() => bar.appendChild(button), () => button.remove(), () => bar.appendChild(fullscreen)]) {
      move();
      changed(bar, [button], [button]);
      expect(button.nextElementSibling).toBe(fullscreen);
      expect(button.parentElement).toBe(bar);
    }
    const insert = vi.spyOn(bar, 'insertBefore');
    changed(bar, [button], [button]);
    button.title = 'progress';
    changed(button, [], [], 'attributes');
    expect(insert).not.toHaveBeenCalled();
    const replacement = fixture.document.createElement('div');
    replacement.innerHTML = '<button aria-label="Settings"></button><button id="new-pip" aria-label="Picture in picture"></button><button id="new-fullscreen" aria-label="Full screen"></button>';
    bar.replaceWith(replacement);
    changed(fixture.player, [replacement], [bar]);
    expect(button.previousElementSibling?.id).toBe('new-pip');
    expect(button.nextElementSibling?.id).toBe('new-fullscreen');
    expect(createMenu).toHaveBeenCalledTimes(1);
    binding.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    changed(replacement, [button]);
    expect(button.isConnected).toBe(false);
  });
});

describe('video player binding', () => {
  it('uses native controls and exposes generation progress beside the icon', () => {
    const {document, locator, target, player} = createFixture();
    const button = document.createElement('button');
    const binding = createVideoPlayerBinding({
      document,
      locator,
      getState: () => ({enabled: true, progress: .42}),
      createButton: () => button,
    });
    expect(button.parentElement?.className).toBe('ytp-right-controls');
    expect(button.parentElement?.lastElementChild).toBe(button);
    expect(button.getAttribute('data-fluent-read-video-progress')).toBe('42%');
    expect(player.classList.contains('fluent-read-video-player-host')).toBe(true);
    expect(binding.getTarget()).toBe(target);
    button.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true}));
    binding.destroy();
    expect(button.isConnected).toBe(false);
    expect(player.classList.contains('fluent-read-video-player-host')).toBe(false);
  });

  it('invokes the injected button callback and observes a focused player', () => {
    const fixture = createFixture();
    const button = fixture.document.createElement('button');
    const onButtonClick = vi.fn();
    Object.defineProperty(fixture.document, 'activeElement', {configurable: true, value: fixture.player});
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, onButtonClick});
    binding.sync();
    button.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    binding.destroy();
  });

  it('recognizes a focused descendant when the player itself is not activeElement', () => {
    const fixture = createFixture();
    const focused = fixture.player.querySelector('.ytp-right-controls')!.querySelector('button')!;
    Object.defineProperty(fixture.document, 'activeElement', {configurable: true, value: focused});
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(fixture.player.getAttribute('data-fluent-read-video-active')).toBe('true');
    binding.destroy();
  });

  it('keeps zero and one hundred percent visible and accepts a custom progress label', () => {
    const fixture = createFixture();
    let progress: number | null = 0;
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({
      document: fixture.document,
      locator: fixture.locator,
      getState: () => ({enabled: true, progress, progressLabel: progress === 0 ? '0%' : undefined}),
      createButton: () => button,
    });
    expect(button.getAttribute('data-fluent-read-video-progress')).toBe('0%');
    progress = 1;
    binding.sync();
    expect(button.getAttribute('data-fluent-read-video-progress')).toBe('100%');
    progress = -1;
    binding.sync();
    expect(button.hasAttribute('data-fluent-read-video-progress')).toBe(false);
    binding.destroy();
  });

  it('uses X settings groups when YouTube controls are absent and handles focused control events', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="x-controls"><button aria-label="Settings"></button><button>other</button></div></div>');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(button.parentElement?.className).toBe('x-controls');
    expect(button.parentElement?.lastElementChild).toBe(button);
    const settings = fixture.player.querySelector('button')!;
    settings.dispatchEvent(new fixture.window.Event('focusin', {bubbles: true}));
    settings.dispatchEvent(new fixture.window.Event('focusout', {bubbles: true}));
    binding.destroy();
  });

  it('uses the settings parent when it is the only native X control', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="x-controls"><button aria-label="Settings"></button></div></div>');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(button.parentElement?.className).toBe('x-controls');
    expect(button.parentElement?.lastElementChild).toBe(button);
    binding.destroy();
  });

  it('keeps an existing fallback and tolerates a hostile hover matcher', () => {
    const fixture = createFixture('<div class="player"><video></video><div class="fluent-read-video-controls"></div></div>');
    fixture.player.matches = (() => { throw new Error('hostile selector'); }) as typeof fixture.player.matches;
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    expect(button.parentElement?.className).toContain('fluent-read-video-controls');
    binding.destroy();
  });

  it('reuses an existing fallback after native controls are removed', () => {
    const fixture = createFixture('<div class="player"><video></video></div>');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const fallback = button.parentElement!;
    const native = fixture.document.createElement('div');
    native.className = 'ytp-right-controls';
    native.append(fixture.document.createElement('button'), fixture.document.createElement('button'));
    fixture.player.appendChild(native);
    binding.sync();
    native.remove();
    binding.sync();
    expect(button.parentElement).toBe(fallback);
    binding.destroy();
  });

  it('removes a fallback that was externally moved before reusing it', () => {
    const fixture = createFixture('<div class="player"><video></video></div>');
    const second = fixture.document.createElement('div');
    second.className = 'second';
    fixture.document.body.appendChild(second);
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const fallback = button.parentElement!;
    second.appendChild(fallback);
    binding.sync();
    expect(fallback.isConnected).toBe(false);
    expect(button.parentElement?.parentElement).toBe(fixture.player);
    binding.destroy();
  });

  it('replaces a fallback when the selected player changes and accepts a null menu', () => {
    const fixture = createFixture('<div class="player"><video></video></div>');
    const secondPlayer = fixture.document.createElement('div');
    secondPlayer.className = 'second';
    const secondVideo = fixture.document.createElement('video');
    secondPlayer.appendChild(secondVideo);
    fixture.document.body.appendChild(secondPlayer);
    const second: VideoPlayerTarget = {video: secondVideo, player: secondPlayer, key: 'video:two', fullscreen: false, interacting: true};
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, createMenu: () => null});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    fixture.setTarget(second);
    expect(button.parentElement?.className).toContain('fluent-read-video-controls');
    binding.destroy();
  });

  it('removes a previously created menu before recreating the target binding', () => {
    const fixture = createFixture();
    const secondPlayer = fixture.document.createElement('div');
    const secondVideo = fixture.document.createElement('video');
    const secondControls = fixture.document.createElement('div');
    secondControls.className = 'ytp-right-controls';
    secondControls.append(fixture.document.createElement('button'), fixture.document.createElement('button'));
    secondPlayer.append(secondVideo, secondControls);
    fixture.document.body.append(secondPlayer);
    const second: VideoPlayerTarget = {video: secondVideo, player: secondPlayer, key: 'video:two', fullscreen: false, interacting: true};
    const firstMenu = fixture.document.createElement('div');
    const secondMenu = fixture.document.createElement('div');
    let calls = 0;
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({
      document: fixture.document,
      locator: fixture.locator,
      getState: () => ({enabled: true}),
      createButton: () => button,
      createMenu: () => { calls += 1; return calls === 1 ? firstMenu : secondMenu; },
    });
    fixture.setTarget(second);
    expect(firstMenu.isConnected).toBe(false);
    expect(secondMenu.parentElement).toBe(secondPlayer);
    binding.destroy();
  });

  it('removes an externally moved menu before restoring it to the selected player', () => {
    const fixture = createFixture();
    const other = fixture.document.createElement('div');
    fixture.document.body.appendChild(other);
    const menu = fixture.document.createElement('div');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, createMenu: () => menu});
    other.appendChild(menu);
    binding.sync();
    expect(menu.parentElement).toBe(fixture.player);
    binding.destroy();
  });

  it('creates and moves an optional menu, preserves static positioning, and cleans after a disconnect', () => {
    const fixture = createFixture();
    const originalView = fixture.document.defaultView;
    fixture.player.style.position = 'absolute';
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: {
      ...fixture.window,
      getComputedStyle: () => ({position: 'static'}),
    }});
    const button = fixture.document.createElement('button');
    const menu = fixture.document.createElement('div');
    let menuCalls = 0;
    const binding = createVideoPlayerBinding({
      document: fixture.document,
      locator: fixture.locator,
      getState: () => ({enabled: true}),
      createButton: () => button,
      createMenu: () => { menuCalls += 1; return menu; },
    });
    expect(menuCalls).toBe(1);
    expect(menu.parentElement).toBe(fixture.player);
    expect(fixture.player.style.position).toBe('relative');
    binding.sync();
    expect(menuCalls).toBe(1);
    fixture.player.remove();
    binding.sync();
    expect(button.isConnected).toBe(false);
    expect(fixture.player.style.position).toBe('absolute');
    binding.destroy();
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: originalView});
  });

  it('falls back to the global document and survives a throwing computed-style boundary', () => {
    const fixture = createFixture();
    const originalView = fixture.document.defaultView;
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: null});
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(button.isConnected).toBe(true);
    binding.destroy();

    const second = createFixture();
    Object.defineProperty(second.document, 'defaultView', {configurable: true, value: {getComputedStyle: () => { throw new Error('style unavailable'); }}});
    const secondButton = second.document.createElement('button');
    const secondBinding = createVideoPlayerBinding({document: second.document, locator: second.locator, getState: () => ({enabled: true}), createButton: () => secondButton});
    expect(secondButton.isConnected).toBe(true);
    secondBinding.destroy();
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: originalView});
  });

  it('restores an empty inline position after making a static player a containing block', () => {
    const fixture = createFixture();
    const originalView = fixture.document.defaultView;
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: {...fixture.window, getComputedStyle: () => ({position: 'static'})}});
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    fixture.player.remove();
    binding.sync();
    expect(fixture.player.style.position).toBe('');
    binding.destroy();
    Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: originalView});
  });

  it('does not react after destruction and handles unrelated pointer events', () => {
    const fixture = createFixture();
    const button = fixture.document.createElement('button');
    const click = vi.fn();
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button, onButtonClick: click});
    fixture.document.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    fixture.document.dispatchEvent(new fixture.window.Event('pointerout', {bubbles: true}));
    const unrelated = fixture.document.createElement('div');
    fixture.document.body.appendChild(unrelated);
    unrelated.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const containedOut = new fixture.window.Event('pointerout', {bubbles: true});
    Object.defineProperty(containedOut, 'relatedTarget', {value: fixture.player.querySelector('video')});
    fixture.player.dispatchEvent(containedOut);
    binding.destroy();
    binding.destroy();
    fixture.emit(fixture.target);
    binding.sync();
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps the fallback host until a native host is actually mounted', () => {
    const fixture = createFixture('<div class="player"><video></video></div>');
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    fixture.video.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    const fallback = button.parentElement;
    const native = fixture.document.createElement('div');
    native.className = 'ytp-right-controls';
    native.append(fixture.document.createElement('button'), fixture.document.createElement('button'));
    fixture.player.appendChild(native);
    binding.sync();
    expect(button.parentElement).toBe(native);
    expect(button.parentElement).not.toBe(fallback);
    binding.destroy();
  });

  it('creates fallback only while the selected player is interacted with', () => {
    const {document, window, locator, video, player} = createFixture('<div class="player"><video></video></div>');
    const button = document.createElement('button');
    const binding = createVideoPlayerBinding({
      document,
      locator,
      getState: () => ({enabled: true}),
      createButton: () => button,
    });
    expect(button.isConnected).toBe(false);
    video.dispatchEvent(new window.Event('pointerover', {bubbles: true}));
    expect(button.parentElement?.className).toContain('fluent-read-video-controls');
    expect(player.getAttribute('data-fluent-read-video-active')).toBe('true');
    video.dispatchEvent(new window.Event('pointerout', {bubbles: true}));
    expect(player.getAttribute('data-fluent-read-video-active')).toBe('false');
    binding.destroy();
    expect(player.querySelector('.fluent-read-video-controls')).toBeNull();
  });

  it('does not move the button when native controls merely change visibility', () => {
    const {document, locator, player} = createFixture();
    const button = document.createElement('button');
    const binding = createVideoPlayerBinding({document, locator, getState: () => ({enabled: true}), createButton: () => button});
    const native = player.querySelector('.ytp-right-controls');
    native?.setAttribute('style', 'display:none');
    binding.sync();
    expect(button.parentElement).toBe(native);
    binding.destroy();
  });

  it('moves ownership on a real target change and removes everything when disabled', () => {
    const fixture = createFixture();
    const secondPlayer = fixture.document.createElement('div');
    secondPlayer.className = 'second';
    const secondVideo = fixture.document.createElement('video');
    const secondControls = fixture.document.createElement('div');
    secondControls.className = 'ytp-right-controls';
    secondControls.append(fixture.document.createElement('button'), fixture.document.createElement('button'));
    secondPlayer.append(secondVideo, secondControls);
    fixture.document.body.appendChild(secondPlayer);
    const second: VideoPlayerTarget = {video: secondVideo, player: secondPlayer, key: 'video:two', fullscreen: false, interacting: true};
    let enabled = true;
    const button = fixture.document.createElement('button');
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled}), createButton: () => button});
    fixture.setTarget(second);
    expect(button.parentElement?.parentElement).toBe(secondPlayer);
    enabled = false;
    binding.sync();
    expect(button.isConnected).toBe(false);
    binding.destroy();
  });

  it('guards cleanup against a synchronous focusout reentry during button removal', () => {
    const fixture = createFixture();
    const button = fixture.document.createElement('button');
    const originalRemove = button.remove.bind(button);
    button.remove = () => {
      button.dispatchEvent(new fixture.window.Event('focusout', {bubbles: true}));
      originalRemove();
    };
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton: () => button});
    expect(() => binding.destroy()).not.toThrow();
    expect(button.isConnected).toBe(false);
  });
});

describe('X controls delayed mounting', () => {
  it('waits for native controls on hover and remount without ever creating a corner fallback', () => {
    const fixture = createFixture('<div class="player" data-testid="videoPlayer"><video></video></div>');
    const createButton = vi.fn(() => fixture.document.createElement('button'));
    const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled: true}), createButton});
    fixture.player.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
    expect(createButton).not.toHaveBeenCalled();
    expect(fixture.player.querySelector('.fluent-read-video-fallback-controls')).toBeNull();
    const controls = fixture.document.createElement('div');
    controls.innerHTML = '<button aria-label="Settings"></button><button>fullscreen</button>';
    fixture.player.appendChild(controls);
    binding.sync();
    expect(createButton).toHaveBeenCalledTimes(1);
    expect(controls.lastElementChild).toBe(createButton.mock.results[0].value);
    controls.remove(); binding.sync();
    expect(fixture.player.querySelector('.fluent-read-video-fallback-controls')).toBeNull();
    expect(createButton.mock.results[0].value.isConnected).toBe(false);
    fixture.player.appendChild(controls); binding.sync();
    expect(controls.lastElementChild).toBe(createButton.mock.results[1].value);
    binding.destroy();
    expect(controls.querySelectorAll('button')).toHaveLength(2);
  });
});

it('controls observer ignores unrelated and owned mutations and rebinds host controls', () => {
 const fixture=createFixture('<div class="player" data-testid="videoPlayer"><video></video></div>');
 let notify!:MutationCallback;vi.stubGlobal('MutationObserver',class {constructor(callback:MutationCallback){notify=callback} observe(){} disconnect(){}});
 const binding=createVideoPlayerBinding({document:fixture.document,locator:fixture.locator,getState:()=>({enabled:true}),createButton:()=>fixture.document.createElement('button')});
 const external=fixture.document.createElement('div');
 notify([{target:external,addedNodes:[],removedNodes:[]} as unknown as MutationRecord],{} as MutationObserver);
 const owned=fixture.document.createElement('div');owned.className='fluent-read-video-ui';fixture.player.appendChild(owned);
 notify([{target:fixture.player,addedNodes:[owned],removedNodes:[]} as unknown as MutationRecord],{} as MutationObserver);
 const controls=fixture.document.createElement('div');controls.innerHTML='<button aria-label="Settings"></button>';fixture.player.appendChild(controls);
 notify([{target:fixture.player,addedNodes:[controls],removedNodes:[]} as unknown as MutationRecord],{} as MutationObserver);
 expect(controls.children.length).toBe(2);binding.destroy();
 notify([{target:fixture.player,addedNodes:[controls],removedNodes:[]} as unknown as MutationRecord],{} as MutationObserver);
});

it('skips text-only player updates and unrelated mixed records while rebinding replaced controls', () => {
  const fixture = createFixture('<div class="player"><video></video><div class="ytp-right-controls"><button>settings</button><button>other</button></div></div>');
  let notify!: MutationCallback;
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: MutationCallback) { notify = callback; }
    observe() {}
    disconnect() {}
  });
  const button = fixture.document.createElement('button');
  const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
    getState: () => ({enabled: true}), createButton: () => button});
  const scans = vi.spyOn(fixture.locator, 'sync');
  scans.mockClear();
  for (let index = 0; index < 60; index += 1) {
    notify([
      {target: fixture.player, addedNodes: [fixture.document.createTextNode(`time ${index}`)], removedNodes: [], type: 'childList'},
      {target: fixture.document.body, addedNodes: [fixture.document.createElement('div')], removedNodes: [], type: 'childList'},
    ] as unknown as MutationRecord[], {} as MutationObserver);
  }
  expect(scans).not.toHaveBeenCalled();
  const previous = fixture.player.querySelector('.ytp-right-controls')!;
  const replacement = fixture.document.createElement('div');
  replacement.className = 'ytp-right-controls';
  replacement.innerHTML = '<button>new settings</button><button>new other</button>';
  previous.replaceWith(replacement);
  notify([{target: fixture.player, addedNodes: [replacement], removedNodes: [previous], type: 'childList'} as unknown as MutationRecord], {} as MutationObserver);
  expect(scans).toHaveBeenCalledOnce();
  expect(button.parentElement).toBe(replacement);
  binding.destroy();
});

describe('same-player owner copies outside the held control host', () => {
  const ownerAttribute = 'data-fluent-read-video-binding-owner';
  const buttonSelector = '#fluent-read-video-subtitle-button';

  function cloneFixture(layout: 'desktop' | 'mobile', fullDocument = false) {
    if (layout === 'mobile') return createMobileYoutubeFixture();
    const f = createFixture('<div class="player"><video></video><div class="ytp-right-controls">'
      + '<button aria-label="Settings">settings</button><button aria-label="Full screen">fullscreen</button></div></div>', fullDocument);
    const callbacks: MutationCallback[] = [];
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {callbacks.push(callback);}
      observe() {}
      disconnect() {}
    });
    const createButton = vi.fn(() => {
      const button = f.document.createElement('button'); button.id = 'fluent-read-video-subtitle-button'; return button;
    });
    return {...f, scope: f.player, controls: f.player.querySelector<HTMLElement>('.ytp-right-controls')!, createButton,
      changed(target: Node, addedNodes: Node[] = [], removedNodes: Node[] = []) {
        const records = [{type: 'childList', target, addedNodes, removedNodes}] as unknown as MutationRecord[];
        for (const callback of callbacks) callback(records, {} as MutationObserver);
      }};
  }

  function unrelatedCopy(f: ReturnType<typeof cloneFixture>, live: HTMLButtonElement) {
    const player = f.document.createElement('div'); player.className = 'html5-video-player';
    player.appendChild(f.document.createElement('video'));
    const copy = live.cloneNode(true) as HTMLButtonElement;
    player.appendChild(copy); f.document.body.appendChild(player);
    return copy;
  }

  it.each(['desktop', 'mobile'] as const)('observer removes a full sibling host copy in the %s scope without recreating the live entry', layout => {
    const f = cloneFixture(layout), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0].value;
    const sibling = f.controls.cloneNode(true) as HTMLElement;
    const copy = sibling.querySelector<HTMLButtonElement>(buttonSelector)!;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding'); sibling.appendChild(foreign);
    const outside = unrelatedCopy(f, live), parent = f.controls.parentElement!;
    parent.appendChild(sibling); // Keep H first and connected; H2 is an additional group, not a replacement.
    expect(copy.isConnected).toBe(true);
    f.changed(parent, [sibling]); // Deliver one record to the actual binding observer; do not call sync manually.
    expect(copy.isConnected).toBe(false);
    expect(sibling.isConnected).toBe(true);
    expect(sibling.querySelector('[aria-label="Full screen"]')?.isConnected).toBe(true);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    expect(live.parentElement).toBe(f.controls);
    expect(f.scope.querySelectorAll(`button[${ownerAttribute}="${live.getAttribute(ownerAttribute)}"]`)).toHaveLength(1);
    expect(f.createButton).toHaveBeenCalledOnce();
    live.dispatchEvent(new f.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce(); expect(click.mock.calls[0][1]).toBe(f.target);
    binding.destroy();
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
  });

  it.each(['body', 'documentElement'] as const)('does not claim %s for owner-wide scans while cleaning its held host', rootName => {
    const f = cloneFixture('desktop', true), root = f.document[rootName];
    expect(root.tagName).toBe(rootName === 'body' ? 'BODY' : 'HTML');
    expect(root.contains(f.controls)).toBe(true);
    f.setTarget({...f.target, player: root});
    const scans = vi.spyOn(root, 'querySelectorAll');
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton});
    const live = f.createButton.mock.results[0].value;
    const copy = live.cloneNode(true) as HTMLButtonElement;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding');
    f.controls.appendChild(copy); f.controls.appendChild(foreign);
    const outside = unrelatedCopy(f, live);
    binding.sync();
    expect(copy.isConnected).toBe(false); expect(live.parentElement).toBe(f.controls);
    expect(outside.isConnected).toBe(true); expect(foreign.isConnected).toBe(true);
    expect(scans.mock.calls.filter(([selector]) => selector.includes(ownerAttribute))).toHaveLength(0);
    const observedCopy = live.cloneNode(true) as HTMLButtonElement;
    f.controls.appendChild(observedCopy); f.changed(f.controls, [observedCopy]);
    expect(observedCopy.isConnected).toBe(false); expect(live.parentElement).toBe(f.controls);
    expect(outside.isConnected).toBe(true); expect(foreign.isConnected).toBe(true);
    expect(scans.mock.calls.filter(([selector]) => selector.includes(ownerAttribute))).toHaveLength(0);
    const lateCopy = live.cloneNode(true) as HTMLButtonElement;
    f.controls.appendChild(lateCopy);
    binding.destroy();
    expect(live.isConnected).toBe(false); expect(lateCopy.isConnected).toBe(false);
    expect(outside.isConnected).toBe(true); expect(foreign.isConnected).toBe(true);
    expect(scans.mock.calls.filter(([selector]) => selector.includes(ownerAttribute))).toHaveLength(0);
    expect(f.createButton).toHaveBeenCalledOnce();
  });

  it('observes the previous mobile scope when an internal host survives a sibling clone and second video batch', () => {
    const f = cloneFixture('mobile'), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0].value;
    f.controls.classList.add('ytp-right-controls'); f.player.appendChild(f.controls);
    f.changed(f.player, [f.controls]); // Outer scope still contains exactly its original video.
    expect(live.parentElement).toBe(f.controls); expect(f.player.contains(f.controls)).toBe(true);
    expect(f.scope.querySelector('.fluent-read-video-menu-host')).toBeNull();
    const sibling = f.controls.cloneNode(true) as HTMLElement;
    const copy = sibling.querySelector<HTMLButtonElement>(buttonSelector)!;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding'); sibling.appendChild(foreign);
    const outside = unrelatedCopy(f, live), secondVideo = f.document.createElement('video');
    f.scope.appendChild(sibling); f.scope.appendChild(secondVideo);
    expect(f.player.contains(sibling)).toBe(false);
    f.changed(f.scope, [sibling, secondVideo]); // Current scope is now player; this record belongs only to old scope.
    expect(copy.isConnected).toBe(false);
    expect(sibling.isConnected).toBe(true); expect(secondVideo.isConnected).toBe(true);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    expect(live.parentElement).toBe(f.controls); expect(f.createButton).toHaveBeenCalledOnce();
    live.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(click).toHaveBeenCalledOnce();
    binding.destroy();
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
  });

  it('cleans the old player scope before holding a newly created entry in another player', () => {
    const f = cloneFixture('desktop'), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0].value;
    const sibling = f.controls.cloneNode(true) as HTMLElement;
    const copy = sibling.querySelector<HTMLButtonElement>(buttonSelector)!;
    const loose = live.cloneNode(true) as HTMLButtonElement;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding'); sibling.appendChild(foreign);
    f.controls.parentElement!.appendChild(sibling); f.scope.appendChild(loose);
    const outside = unrelatedCopy(f, live), nextPlayer = f.document.createElement('div');
    nextPlayer.className = 'html5-video-player';
    nextPlayer.innerHTML = '<video></video><div class="ytp-right-controls"><button aria-label="Full screen">fullscreen</button></div>';
    f.document.body.appendChild(nextPlayer);
    const nextTarget = {...f.target, player: nextPlayer, video: nextPlayer.querySelector<HTMLVideoElement>('video')!, key: 'video:other-player'};
    f.setTarget(nextTarget); // No observer delivery for old-scope copies before this real locator notification.
    const nextLive = f.createButton.mock.results[1].value;
    expect(live.isConnected).toBe(false); expect(copy.isConnected).toBe(false); expect(loose.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    expect(f.scope.querySelectorAll(`button[${ownerAttribute}="${live.getAttribute(ownerAttribute)}"]`)).toHaveLength(0);
    expect(nextLive.parentElement).toBe(nextPlayer.querySelector('.ytp-right-controls'));
    expect(binding.getTarget()).toBe(nextTarget); expect(f.createButton).toHaveBeenCalledTimes(2);
    nextLive.dispatchEvent(new f.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledOnce(); expect(click.mock.calls[0][1]).toBe(nextTarget);
    binding.destroy();
    expect(nextLive.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
  });

  it.each(['desktop', 'mobile'] as const)('observer removes a loose same-owner entry outside the held host in the %s scope', layout => {
    const f = cloneFixture(layout), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0].value, copy = live.cloneNode(true) as HTMLButtonElement;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding');
    f.scope.appendChild(copy); f.scope.appendChild(foreign);
    const outside = unrelatedCopy(f, live);
    expect(f.controls.contains(copy)).toBe(false);
    f.changed(f.scope, [copy, foreign]);
    expect(copy.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    expect(live.parentElement).toBe(f.controls); expect(f.createButton).toHaveBeenCalledOnce();
    live.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(click).toHaveBeenCalledOnce();
    binding.destroy();
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
  });

  it.each((['desktop', 'mobile'] as const).flatMap(layout =>
    (['disable', 'media-key', 'destroy'] as const).map(action => ({layout, action}))))(
    '$action cleans prior $layout scope copies before any observer delivery', ({layout, action}) => {
      const f = cloneFixture(layout), click = vi.fn(); let enabled = true;
      const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
        getState: () => ({enabled}), createButton: f.createButton, onButtonClick: click});
      const live = f.createButton.mock.results[0].value;
      const sibling = f.controls.cloneNode(true) as HTMLElement;
      const copy = sibling.querySelector<HTMLButtonElement>(buttonSelector)!;
      const loose = live.cloneNode(true) as HTMLButtonElement;
      const foreign = live.cloneNode(true) as HTMLButtonElement;
      foreign.setAttribute(ownerAttribute, 'another-binding'); sibling.appendChild(foreign);
      f.controls.parentElement!.appendChild(sibling); f.scope.appendChild(loose);
      const outside = unrelatedCopy(f, live);
      // No f.changed(): the lifecycle boundary must clean its captured scope itself.
      if (action === 'disable') {enabled = false; binding.sync();}
      else if (action === 'media-key') f.setTarget({...f.target, key: 'video:replacement'});
      else binding.destroy();
      expect(live.isConnected).toBe(false);
      expect(copy.isConnected).toBe(false); expect(loose.isConnected).toBe(false);
      expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
      const own = f.scope.querySelectorAll(`button[${ownerAttribute}="${live.getAttribute(ownerAttribute)}"]`);
      if (action === 'media-key') {
        const replacement = f.createButton.mock.results[1].value;
        expect(f.createButton).toHaveBeenCalledTimes(2); expect(own).toHaveLength(1);
        expect(own[0]).toBe(replacement); expect(replacement.parentElement).toBe(f.controls);
        replacement.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(click).toHaveBeenCalledOnce();
      } else {expect(f.createButton).toHaveBeenCalledOnce(); expect(own).toHaveLength(0);}
      binding.destroy();
      expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    });

  it('cleans the previous mobile controls scope when a second video revokes external ownership', () => {
    const f = cloneFixture('mobile'), click = vi.fn();
    const binding = createVideoPlayerBinding({document: f.document, locator: f.locator,
      getState: () => ({enabled: true}), createButton: f.createButton, onButtonClick: click});
    const live = f.createButton.mock.results[0].value;
    f.video.dispatchEvent(new f.window.Event('pointerover', {bubbles: true}));
    const sibling = f.controls.cloneNode(true) as HTMLElement;
    const copy = sibling.querySelector<HTMLButtonElement>(buttonSelector)!;
    const loose = live.cloneNode(true) as HTMLButtonElement;
    const foreign = live.cloneNode(true) as HTMLButtonElement;
    foreign.setAttribute(ownerAttribute, 'another-binding'); sibling.appendChild(foreign);
    f.controls.parentElement!.appendChild(sibling); f.scope.appendChild(loose);
    const outside = unrelatedCopy(f, live), secondVideo = f.document.createElement('video');
    f.scope.appendChild(secondVideo);
    f.changed(f.scope, [secondVideo]); // The first delivered record observes an already ambiguous old scope.
    expect(copy.isConnected).toBe(false); expect(loose.isConnected).toBe(false);
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
    expect(live.isConnected).toBe(true); expect(f.player.contains(live)).toBe(true);
    expect(live.parentElement?.classList.contains('fluent-read-video-controls')).toBe(true);
    expect(f.createButton).toHaveBeenCalledOnce();
    expect(f.scope.querySelectorAll(`button[${ownerAttribute}="${live.getAttribute(ownerAttribute)}"]`)).toHaveLength(1);
    live.dispatchEvent(new f.window.Event('click', {bubbles: true})); expect(click).toHaveBeenCalledOnce();
    binding.destroy();
    expect(foreign.isConnected).toBe(true); expect(outside.isConnected).toBe(true);
  });
});

it('missing MutationObserver still supports explicit sync and clean teardown', () => {
 const fixture=createFixture();vi.stubGlobal('MutationObserver',undefined);
 const button=fixture.document.createElement('button');
 const binding=createVideoPlayerBinding({document:fixture.document,locator:fixture.locator,getState:()=>({enabled:true}),createButton:()=>button});
 binding.sync();
 // 没有观察器时仍靠显式 sync 挂在播放器控件内，销毁后不能遗留图标。
 expect(fixture.player.contains(button)).toBe(true);
 binding.destroy();
 expect(button.isConnected).toBe(false);
});


it.each(['disable', 'destroy'] as const)('cleans copies in detached X controls while retaining the open menu before %s', finish => {
  const fixture = createFixture('<div class="player" data-testid="videoPlayer"><video></video><div class="x-controls"><button aria-label="Settings"></button><button>fullscreen</button></div></div>');
  let enabled = true;
  const live = fixture.document.createElement('button');
  const menu = fixture.document.createElement('div');
  const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator,
    getState: () => ({enabled}), createButton: () => live, createMenu: () => menu});
  const controls = live.parentElement!;
  const clone = live.cloneNode(true) as HTMLButtonElement;
  const foreign = live.cloneNode(true) as HTMLButtonElement;
  foreign.setAttribute('data-fluent-read-video-binding-owner', 'another-binding');
  controls.append(clone, foreign);
  controls.remove();
  binding.sync();
  expect(menu.isConnected).toBe(true);
  expect(live.parentElement).toBeNull();
  if (finish === 'disable') {enabled = false; binding.sync();}
  else binding.destroy();
  expect(menu.isConnected).toBe(false);
  expect(clone.parentElement).toBeNull();
  expect(foreign.parentElement).toBe(controls);
  fixture.player.appendChild(controls);
  expect(controls.querySelectorAll('[data-fluent-read-video-binding-owner]')).toHaveLength(1);
  expect(controls.querySelector('[data-fluent-read-video-binding-owner]')).toBe(foreign);
  binding.destroy();
});

it('keeps an open X menu usable across controls removal and remount, then cleans up on disable', () => {
  const fixture = createFixture('<div class="player" data-testid="videoPlayer"><video></video><div class="x-controls"><button aria-label="Settings"></button><button>fullscreen</button></div></div>');
  let enabled = true;
  const createMenu = vi.fn(() => {
    const menu = fixture.document.createElement('div');
    menu.hidden = true;
    const toggle = fixture.document.createElement('button');
    toggle.addEventListener('click', () => toggle.setAttribute('aria-checked', 'false'));
    menu.appendChild(toggle);
    return menu;
  });
  const binding = createVideoPlayerBinding({document: fixture.document, locator: fixture.locator, getState: () => ({enabled}), createButton: () => fixture.document.createElement('button'), createMenu});
  const menu = createMenu.mock.results[0].value;
  const toggle = menu.querySelector('button')!;
  menu.hidden = false;
  const controls = fixture.player.querySelector('.x-controls')!;
  controls.remove();
  binding.sync();
  toggle.dispatchEvent(new fixture.window.Event('pointerover', {bubbles: true}));
  toggle.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
  expect(menu.isConnected).toBe(true);
  expect(menu.hidden).toBe(false);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(fixture.player.querySelector('.fluent-read-video-controls')).toBeNull();
  fixture.player.appendChild(controls);
  binding.sync();
  expect(createMenu).toHaveBeenCalledTimes(1);
  expect(menu.hidden).toBe(false);
  expect(controls.children).toHaveLength(3);
  controls.remove();
  binding.sync();
  enabled = false;
  binding.sync();
  expect(menu.isConnected).toBe(false);
  binding.destroy();
});
