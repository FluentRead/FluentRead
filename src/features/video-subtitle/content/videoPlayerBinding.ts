/**
 * @file src/features/video-subtitle/content/videoPlayerBinding.ts
 * 文件职责：把字幕入口和菜单绑定到定位器选中的视频播放器，并在信息流、全屏及原生控件重挂载时保持稳定。
 * 主要内容：以画中画和全屏控件为锚点维护入口顺序，移动 YouTube 仅在已验证同视频容器中认领外部底部右控制组和交互；自有菜单宿主按媒体播放器坐标校准并隔离原生控制层，重挂仅恢复菜单原有焦点；在已认领的局部播放器范围清理自身入口副本，管理 fallback、进度徽标和禁用清理。
 * 模块边界：只管理 FluentRead 播放器节点的挂载位置与事件；公开菜单宿主校准供既有布局帧调用，不重扫播放器或重建入口；按钮行为、菜单内容和字幕业务由调用方注入。
 */

import {
  markVideoUi,
  VIDEO_FALLBACK_CONTROLS_CLASS,
  VIDEO_PLAYER_ACTIVE_ATTRIBUTE,
  VIDEO_PLAYER_HOST_CLASS,
  VIDEO_PLAYER_PROGRESS_ATTRIBUTE,
  VIDEO_RIGHT_CONTROLS_SELECTOR,
  VIDEO_X_SETTINGS_CONTROL_SELECTOR,
} from './ui';
import type {VideoPlayerLocator, VideoPlayerTarget} from './videoPlayerLocator';
import {getYoutubeSubtitleControlsScope} from './youtubeControlsScope';

export interface VideoPlayerBindingState {
  readonly enabled: boolean;
  readonly progress?: number | null;
  readonly progressLabel?: string;
}

export interface VideoPlayerBindingOptions {
  readonly locator: VideoPlayerLocator;
  readonly document?: Document;
  readonly getState: () => VideoPlayerBindingState;
  readonly createButton: () => HTMLButtonElement;
  readonly createMenu?: (target: VideoPlayerTarget) => HTMLElement | null;
  readonly onButtonClick?: (event: MouseEvent, target: VideoPlayerTarget) => void;
}

export interface VideoPlayerBinding {
  sync(): void;
  syncMenuHost(): void;
  getTarget(): VideoPlayerTarget | null;
  destroy(): void;
}

const VIDEO_PLAYER_FULLSCREEN_ATTRIBUTE = 'data-fluent-read-video-fullscreen';
const FULLSCREEN_CONTROL_SELECTOR = [
  '.ytp-fullscreen-button', '[data-testid*="fullscreen" i]',
  '[aria-label*="Full screen" i]', '[aria-label*="Fullscreen" i]',
  '[aria-label*="全屏"]', '[aria-label*="全螢幕"]',
  '[title*="Full screen" i]', '[title*="Fullscreen" i]', '[title*="全屏"]', '[title*="全螢幕"]',
].join(', ');
const PICTURE_IN_PICTURE_CONTROL_SELECTOR = [
  '[data-testid*="pictureInPicture" i]', '[data-testid*="pipButton" i]',
  '[aria-label*="Picture in picture" i]', '[aria-label*="Picture-in-picture" i]',
  '[aria-label*="画中画"]', '[aria-label*="子母畫面"]',
  '[title*="Picture in picture" i]', '[title*="Picture-in-picture" i]', '[title*="画中画"]',
].join(', ');

function isConnected(element: Element | null): element is Element {
  return Boolean(element && element.isConnected !== false);
}

/** 只匹配站点自己的控件；FluentRead 菜单里的“设置”等按钮不能被当作原生控制栏。 */
function nativeControl(root: HTMLElement, selector: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(control => !control.closest('.fluent-read-video-ui')) || null;
}

function nativeControls(player: HTMLElement, scope: HTMLElement): HTMLElement | null {
  const youtube = player.querySelector<HTMLElement>(VIDEO_RIGHT_CONTROLS_SELECTOR);
  if (youtube) return youtube;
  if (scope !== player) {
    // mweb 的右组可能只有一个全屏按钮；不能按“至少两个按钮”向上选中包含顶部设置的整层 overlay。
    const mobile = scope.querySelector<HTMLElement>('ytm-custom-control ytm-watch-player-controls #player-control-overlay .player-controls-bottom-right');
    if (mobile && nativeControl(mobile, FULLSCREEN_CONTROL_SELECTOR)) return mobile;
  }
  const anchor = nativeControl(player, FULLSCREEN_CONTROL_SELECTOR)
    || nativeControl(player, PICTURE_IN_PICTURE_CONTROL_SELECTOR) || nativeControl(player, VIDEO_X_SETTINGS_CONTROL_SELECTOR);
  if (!anchor) return null;
  let current = anchor.parentElement;
  while (current && current !== player) {
    // 自己的入口不能让单按钮 tooltip 包装层被误识别为完整控制栏。
    if (Array.from(current.querySelectorAll('button, [role="button"]'))
      .filter(control => !control.closest('.fluent-read-video-ui')).length >= 2) return current;
    current = current.parentElement;
  }
  return anchor.parentElement;
}

/** 插在原生按钮所属的直接子节点旁，保留站点的 tooltip 包装和点击事件。 */
function insertionAnchor(host: HTMLElement, button: HTMLButtonElement): Element | null {
  const fullscreen = host.querySelector<HTMLElement>(FULLSCREEN_CONTROL_SELECTOR);
  let control: Element | null = fullscreen || host.querySelector<HTMLElement>(PICTURE_IN_PICTURE_CONTROL_SELECTOR);
  if (!control) return null;
  while (control.parentElement !== host) control = control.parentElement!;
  if (fullscreen) return control;
  const next = control.nextElementSibling;
  return next === button ? button.nextElementSibling : next;
}

function playerIsFocused(player: HTMLElement, document: Document): boolean {
  const active = document.activeElement;
  return Boolean(active && (active === player || player.contains(active)));
}

function playerIsHovered(player: HTMLElement): boolean {
  try {
    return player.matches(':hover');
  } catch {
    return false;
  }
}

function setProgress(button: HTMLButtonElement, state: VideoPlayerBindingState): void {
  const value = state.progress;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    button.removeAttribute(VIDEO_PLAYER_PROGRESS_ATTRIBUTE);
    button.removeAttribute('aria-valuenow');
    return;
  }
  const percentage = Math.round(Math.max(0, Math.min(1, value)) * 100);
  button.setAttribute(VIDEO_PLAYER_PROGRESS_ATTRIBUTE, state.progressLabel || `${percentage}%`);
  button.setAttribute('aria-valuenow', String(percentage));
}

export function createVideoPlayerBinding(options: VideoPlayerBindingOptions): VideoPlayerBinding {
  const document = options.document || window.document;
  const view = document.defaultView || window;
  let target: VideoPlayerTarget | null = null;
  let button: HTMLButtonElement | null = null;
  let menu: HTMLElement | null = null;
  let menuHost: HTMLElement | null = null;
  let menuPointer: {node: HTMLElement; value: string; priority: string} | null = null;
  let host: HTMLElement | null = null;
  let ownedScope: HTMLElement | null = null;
  let before: Element | null = null;
  let fallback: HTMLElement | null = null;
  let destroyed = false;
  let cleaningNodes = false;
  // 属性随 DOM 深复制而保留；只识别本实例入口的副本，不按公共 id 删除其他实例或页面节点。
  const buttonOwner = `${Date.now()}-${Math.random()}`;
  const buttonOwnerAttribute = 'data-fluent-read-video-binding-owner';
  const ownedButtonSelector = `button[${buttonOwnerAttribute}="${buttonOwner}"]`;
  // 通用定位器可能回退到页面根；入口副本修复不能因此扩大为全页查询和清理。
  const scopeForOwnedCopies = (scope: HTMLElement): HTMLElement | null =>
    scope === document.body || scope === document.documentElement ? null : scope;
  const activePlayers = new WeakSet<HTMLElement>();
  const positionedPlayers = new WeakSet<HTMLElement>();
  const previousPositions = new WeakMap<HTMLElement, {value: string; priority: string}>();

  const removeClonedButtons = (scope: HTMLElement | null, liveButton: HTMLButtonElement | null) => {
    if (!scope) return;
    const previouslyCleaning = cleaningNodes;
    cleaningNodes = true;
    try {
      for (const candidate of scope.querySelectorAll<HTMLButtonElement>(ownedButtonSelector)) {
        if (candidate !== liveButton) candidate.remove();
      }
    } finally {
      cleaningNodes = previouslyCleaning;
    }
  };

  const restoreMenuPointer = () => {
    if (!menuPointer) return;
    const {node, value, priority} = menuPointer;
    if (node.style.getPropertyValue('pointer-events') === 'auto' && node.style.getPropertyPriority('pointer-events') === 'important') {
      if (value) node.style.setProperty('pointer-events', value, priority);
      else node.style.removeProperty('pointer-events');
    }
    menuPointer = null;
  };

  const cleanNodes = () => {
    cleaningNodes = true;
    const buttonToRemove = button;
    const menuToRemove = menu;
    const menuHostToRemove = menuHost;
    const fallbackToRemove = fallback;
    const hostToClean = host;
    const scopeToClean = ownedScope;
    button = null;
    menu = null;
    menuHost = null;
    fallback = null;
    host = null;
    ownedScope = null;
    before = null;
    try {
      restoreMenuPointer();
      removeClonedButtons(scopeToClean, buttonToRemove);
      removeClonedButtons(hostToClean, buttonToRemove);
      buttonToRemove?.remove();
      menuToRemove?.remove();
      menuHostToRemove?.remove();
      fallbackToRemove?.remove();
    } finally {
      cleaningNodes = false;
    }
  };

  const removePlayerMark = (player: HTMLElement | null) => {
    if (!player) return;
    player.classList.remove(VIDEO_PLAYER_HOST_CLASS);
    player.removeAttribute(VIDEO_PLAYER_ACTIVE_ATTRIBUTE);
    player.removeAttribute(VIDEO_PLAYER_FULLSCREEN_ATTRIBUTE);
    if (positionedPlayers.has(player)) {
      const previous = previousPositions.get(player)!;
      // 站点可能在挂载后更新自己的定位；只恢复仍由我们持有的声明。
      if (player.style.position === 'relative'
        && (!player.style.getPropertyPriority || player.style.getPropertyPriority('position') === 'important')) {
        if (previous.value) player.style.setProperty('position', previous.value, previous.priority);
        else player.style.position = '';
      }
      positionedPlayers.delete(player);
      previousPositions.delete(player);
    }
  };

  const ensureContainingBlock = (player: HTMLElement) => {
    if (positionedPlayers.has(player)) return;
    let position = '';
    try {
      position = view.getComputedStyle?.(player)?.position || '';
    } catch {
      position = '';
    }
    if (position !== 'static') return;
    previousPositions.set(player, {value: player.style.position, priority: player.style.getPropertyPriority?.('position') || ''});
    player.style.setProperty('position', 'relative', 'important');
    positionedPlayers.add(player);
  };

  const controlsScope = (next: VideoPlayerTarget): HTMLElement => {
    try {
      const scope = getYoutubeSubtitleControlsScope(next.player, next.video);
      const fullscreen = document.fullscreenElement;
      // HTML 全屏可能只带入 movie_player；兄弟控制层不在全屏子树时不得继续持有外部入口。
      return fullscreen && !fullscreen.contains(scope) ? next.player : scope;
    } catch {
      // 宿主页可覆写 matches/closest；无法确认兄弟层身份时保留原播放器边界。
      return next.player;
    }
  };
  const isInteractive = (next: VideoPlayerTarget): boolean =>
    next.fullscreen || activePlayers.has(next.player) || playerIsHovered(controlsScope(next)) || playerIsFocused(controlsScope(next), document);

  const moveWithFocus = (node: HTMLElement, parent: HTMLElement) => {
    if (node.parentElement === parent) return;
    const active = document.activeElement;
    const restoreFocus = active instanceof Element && node.contains(active);
    parent.appendChild(node);
    if (restoreFocus && active.isConnected && document.activeElement !== active) {
      (active as HTMLElement).focus?.({preventScroll: true});
    }
  };

  const menuRenderParent = (next: VideoPlayerTarget, scope: HTMLElement): HTMLElement => {
    if (scope === next.player) return next.player;
    const rect = next.player.getBoundingClientRect();
    const width = next.player.clientWidth || rect.width, height = next.player.clientHeight || rect.height;
    if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return next.player;
    if (!menuHost) {
      menuHost = document.createElement('div');
      menuHost.className = 'fluent-read-video-menu-host';
      markVideoUi(menuHost);
      // 只覆盖自有宿主；空白区域透传原生控件，菜单自己重新开启指针命中。
      for (const [name, value] of Object.entries({position: 'absolute', left: '0', top: '0',
        margin: '0', padding: '0', border: '0', 'box-sizing': 'border-box',
        'pointer-events': 'none', 'z-index': '2147483646', 'transform-origin': '0 0', overflow: 'visible'})) menuHost.style.setProperty(name, value, 'important');
    }
    moveWithFocus(menuHost, scope);
    menuHost.style.setProperty('width', `${width}px`, 'important');
    menuHost.style.setProperty('height', `${height}px`, 'important');
    menuHost.style.setProperty('transform', 'none', 'important');
    const base = menuHost.getBoundingClientRect();
    if (base.width <= 0 || base.height <= 0) return next.player;
    const sx = base.width / width, sy = base.height / height;
    menuHost.style.setProperty('transform', `translate(${(rect.left - base.left) / sx}px, ${(rect.top - base.top) / sy}px) scale(${rect.width / base.width}, ${rect.height / base.height})`, 'important');
    return menuHost;
  };

  const syncOwnedMenuHost = (next: VideoPlayerTarget, scope: HTMLElement) => {
    if (menu) {
      const parent = menuRenderParent(next, scope);
      moveWithFocus(menu, parent);
      if (parent === menuHost) {
        if (!menuPointer) menuPointer = {node: menu, value: menu.style.getPropertyValue('pointer-events'), priority: menu.style.getPropertyPriority('pointer-events')};
        menu.style.setProperty('pointer-events', 'auto', 'important');
      } else restoreMenuPointer();
      markVideoUi(menu);
      if (parent === next.player) {menuHost?.remove(); menuHost = null;}
    } else {menuHost?.remove(); menuHost = null;}
  };

  const ensureFallback = (player: HTMLElement): HTMLElement => {
    if (!fallback || fallback.parentElement !== player) {
      fallback?.remove();
      fallback = player.querySelector<HTMLElement>(`.${VIDEO_FALLBACK_CONTROLS_CLASS}`) || document.createElement('div');
      fallback.className = VIDEO_FALLBACK_CONTROLS_CLASS;
      markVideoUi(fallback);
      if (fallback.parentElement !== player) player.appendChild(fallback);
    }
    return fallback;
  };

  const place = (next: VideoPlayerTarget): void => {
    const scope = controlsScope(next);
    const nextOwnedScope = scopeForOwnedCopies(scope);
    // 站点可保留旧控制组并追加深复制组；只清 host 会漏掉同播放器内无监听的入口。
    // 保留此前认领的局部范围，第二视频或重挂使范围收缩时仍能清除自身旧副本。
    if (ownedScope !== nextOwnedScope) removeClonedButtons(ownedScope, button);
    ownedScope = nextOwnedScope;
    removeClonedButtons(ownedScope, button);
    const preferred = nativeControls(next.player, scope);
    // X 的控制栏在悬浮后才挂载。等待真实控制栏，避免右下角 fallback 首帧闪现后跳到进度左侧。
    if (!preferred && next.player.getAttribute('data-testid') === 'videoPlayer') {
      // 原生控制栏的生命周期不代表用户结束菜单操作；保留已打开的菜单及焦点。
      if (menu && menu.parentElement === next.player && !menu.hidden) {
        removeClonedButtons(host, button);
        button?.remove();
        host = null;
        return;
      }
      cleanNodes();
      removePlayerMark(next.player);
      return;
    }
    const currentHostBelongs = host && host.parentElement && scope.contains(host);
    if (!currentHostBelongs) {
      removeClonedButtons(host, button);
      host = null;
    }

    if (!host) {
      if (preferred) host = preferred;
      else if (isInteractive(next) || (menuHost && menu && !menu.hidden)) host = ensureFallback(next.player);
      else {
        cleanNodes();
        return;
      }
    } else if (preferred && preferred !== host) {
      // 原生控件真正重挂载后才换宿主；仅 display/opacity 变化不会触发此分支。
      removeClonedButtons(host, button);
      host = preferred;
    }

    removeClonedButtons(host, button);
    ensureContainingBlock(next.player);
    if (!button) {
      button = options.createButton();
      button.setAttribute(buttonOwnerAttribute, buttonOwner);
      markVideoUi(button);
      button.addEventListener('click', (event) => {
        if (target) options.onButtonClick?.(event, target);
      });
    }
    setProgress(button, options.getState());
    before = insertionAnchor(host, button);
    if (button.parentElement !== host || button.nextElementSibling !== before) host.insertBefore(button, before);

    if (options.createMenu) {
      if (!menu || (menu.parentElement !== next.player && menu.parentElement !== menuHost)) {
        restoreMenuPointer();
        menu?.remove();
        menu = options.createMenu(next);
      }
      syncOwnedMenuHost(next, scope);
    }
    next.player.classList.add(VIDEO_PLAYER_HOST_CLASS);
    next.player.setAttribute(VIDEO_PLAYER_ACTIVE_ATTRIBUTE, String(isInteractive(next)));
    next.player.setAttribute(VIDEO_PLAYER_FULLSCREEN_ATTRIBUTE, String(next.fullscreen));
  };

  const sync = () => {
    if (destroyed || cleaningNodes) return;
    const state = options.getState();
    const next = state.enabled ? options.locator.sync() : null;
    if (next?.key !== target?.key || next?.player !== target?.player) {
      removePlayerMark(target?.player || null);
      cleanNodes();
      target = next;
    } else if (target && (!isConnected(target.video) || !isConnected(target.player))) {
      removePlayerMark(target.player);
      cleanNodes();
      target = null;
    } else {
      // locator 的全屏/交互元数据可能变化但 key 不变，仍需刷新本地快照。
      target = next;
    }
    if (!target) return;
    place(target);
    if (button) setProgress(button, options.getState());
  };

  const markInteraction = (event: Event, active: boolean) => {
    const element = event.target;
    if (!element || typeof (element as {tagName?: unknown}).tagName !== 'string') return;
    const selected = target;
    if (!selected || !controlsScope(selected).contains(element as Node)) return;
    if (activePlayers.has(selected.player) === active) return;
    if (active) activePlayers.add(selected.player);
    else activePlayers.delete(selected.player);
    sync();
  };

  const onPointerOver = (event: Event) => markInteraction(event, true);
  const onPointerOut = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget;
    if (related && target && controlsScope(target).contains(related as Node)) return;
    markInteraction(event, false);
  };
  const onFocusIn = (event: Event) => markInteraction(event, true);
  const onFocusOut = (event: Event) => {
    const related = (event as FocusEvent).relatedTarget;
    if (related && target && controlsScope(target).contains(related as Node)) return;
    markInteraction(event, false);
  };

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerdown', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  const unsubscribe = options.locator.subscribe((next) => {
    if (destroyed) return;
    if (next?.interacting) activePlayers.add(next.player);
    sync();
  });
  const controlsObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(records => {
    if (!target) return;
    const scope = controlsScope(target);
    // 第二视频/播放器移出会让 scope 退回 player，而变更记录仍属于旧容器；先撤回失效宿主，再按新范围过滤噪声。
    if ((ownedScope && ownedScope !== scopeForOwnedCopies(scope))
      || (host && !scope.contains(host)) || (menuHost && menuHost.parentElement !== scope)) {sync(); return;}
    const playerRecords = records.filter(record => scope.contains(record.target));
    if (playerRecords.length === 0) return;
    const isOwned = (node: Node) => node instanceof Element && Boolean(node.closest('.fluent-read-video-ui'));
    // 原按钮仍在正确锚点时也可能在旁边插入无监听副本；仅检查当前局部范围，页面根仍限于持有 host。
    const addsOwnedButtonCopy = (node: Node): boolean => {
      const copyScope = scopeForOwnedCopies(scope) || host;
      if (!(node instanceof Element) || !copyScope?.contains(node)) return false;
      return (node !== button && node.matches(ownedButtonSelector))
        || Array.from(node.querySelectorAll(ownedButtonSelector)).some(copy => copy !== button);
    };
    const correctlyPlaced = button?.parentElement === host && button?.nextElementSibling === before;
    const controlSelector = [VIDEO_RIGHT_CONTROLS_SELECTOR, FULLSCREEN_CONTROL_SELECTOR,
      PICTURE_IN_PICTURE_CONTROL_SELECTOR, VIDEO_X_SETTINGS_CONTROL_SELECTOR].join(', ');
    const affectsControls = (node: Node): boolean => {
      if (!(node instanceof Element) || isOwned(node)) return false;
      if (node === host || Boolean(host && node.contains(host))) return true;
      if (node.matches(controlSelector) || node.querySelector(controlSelector)) return true;
      return Boolean(host?.contains(node) && (node.matches('button, [role="button"]')
        || node.querySelector('button, [role="button"]')));
    };
    if (playerRecords.every(record => {
      if (record.type === 'childList' && Array.from(record.addedNodes).some(addsOwnedButtonCopy)) return false;
      if (isOwned(record.target)) return true;
      if (record.type === 'attributes') return !affectsControls(record.target);
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (nodes.every(node => node.nodeType === 3)) return true;
      if (!correctlyPlaced && nodes.some(isOwned)) return false;
      return !nodes.some(affectsControls);
    })) return;
    sync();
  }) : null;
  controlsObserver?.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'title', 'data-testid']});
  sync();

  return {
    sync,
    syncMenuHost() {
      // 帧通知只操作仍存活的同媒体菜单；不调用 locator、按钮工厂或完整绑定同步。
      if (destroyed || !target || !menu?.isConnected || !target.player.isConnected || !target.player.contains(target.video)) return;
      syncOwnedMenuHost(target, controlsScope(target));
    },
    getTarget: () => target,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      controlsObserver?.disconnect();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerdown', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      removePlayerMark(target?.player || null);
      cleanNodes();
      target = null;
    },
  };
}
