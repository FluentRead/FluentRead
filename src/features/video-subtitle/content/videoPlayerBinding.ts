/**
 * @file src/features/video-subtitle/content/videoPlayerBinding.ts
 * 文件职责：把字幕入口和菜单绑定到定位器选中的视频播放器，并在信息流、全屏及原生控件重挂载时保持稳定。
 * 主要内容：管理原生控制栏优先、悬浮/聚焦时的 fallback 控件、进度徽标和禁用状态下的节点清理。
 * 模块边界：只管理 FluentRead 播放器节点的挂载位置与事件；按钮行为、菜单内容和字幕业务由调用方注入。
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
  getTarget(): VideoPlayerTarget | null;
  destroy(): void;
}

const VIDEO_PLAYER_FULLSCREEN_ATTRIBUTE = 'data-fluent-read-video-fullscreen';

function isConnected(element: Element | null): element is Element {
  return Boolean(element && element.isConnected !== false);
}

function settingsControl(player: HTMLElement): HTMLElement | null {
  return player.querySelector<HTMLElement>(VIDEO_X_SETTINGS_CONTROL_SELECTOR);
}

function nativeControls(player: HTMLElement): HTMLElement | null {
  const youtube = player.querySelector<HTMLElement>(VIDEO_RIGHT_CONTROLS_SELECTOR);
  if (youtube) return youtube;
  const settings = settingsControl(player);
  if (!settings) return null;
  let current = settings.parentElement;
  while (current && current !== player) {
    if (current.querySelectorAll('button, [role="button"]').length >= 2) return current;
    current = current.parentElement;
  }
  return settings.parentElement;
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
  let host: HTMLElement | null = null;
  let fallback: HTMLElement | null = null;
  let destroyed = false;
  let cleaningNodes = false;
  const activePlayers = new WeakSet<HTMLElement>();
  const positionedPlayers = new WeakSet<HTMLElement>();
  const previousPositions = new WeakMap<HTMLElement, string>();

  const cleanNodes = () => {
    cleaningNodes = true;
    const buttonToRemove = button;
    const menuToRemove = menu;
    const fallbackToRemove = fallback;
    button = null;
    menu = null;
    fallback = null;
    host = null;
    try {
      buttonToRemove?.remove();
      menuToRemove?.remove();
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
      player.style.position = previousPositions.get(player) || '';
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
    previousPositions.set(player, player.style.position);
    player.style.setProperty('position', 'relative', 'important');
    positionedPlayers.add(player);
  };

  const isInteractive = (next: VideoPlayerTarget): boolean =>
    next.fullscreen || activePlayers.has(next.player) || playerIsHovered(next.player) || playerIsFocused(next.player, document);

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
    const preferred = nativeControls(next.player);
    // X 的控制栏在悬浮后才挂载。等待真实控制栏，避免右下角 fallback 首帧闪现后跳到进度左侧。
    if (!preferred && next.player.getAttribute('data-testid') === 'videoPlayer') {
      cleanNodes();
      removePlayerMark(next.player);
      return;
    }
    const currentHostBelongs = host && host.parentElement && next.player.contains(host);
    if (!currentHostBelongs) host = null;

    if (!host) {
      if (preferred) host = preferred;
      else if (isInteractive(next)) host = ensureFallback(next.player);
      else {
        cleanNodes();
        return;
      }
    } else if (host.classList.contains(VIDEO_FALLBACK_CONTROLS_CLASS) && preferred && preferred !== host) {
      // 原生控件真正重挂载后才换宿主；仅 display/opacity 变化不会触发此分支。
      host = preferred;
    }

    ensureContainingBlock(next.player);
    if (!button) {
      button = options.createButton();
      markVideoUi(button);
      button.addEventListener('click', (event) => {
        if (target) options.onButtonClick?.(event, target);
      });
    }
    setProgress(button, options.getState());
    if (button.parentElement !== host) host.insertBefore(button, host.firstElementChild);

    if (options.createMenu) {
      if (!menu || menu.parentElement !== next.player) {
        menu?.remove();
        menu = options.createMenu(next);
      }
      if (menu && menu.parentElement !== next.player) next.player.appendChild(menu);
      if (menu) markVideoUi(menu);
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
    if (!selected || (element !== selected.player && !selected.player.contains(element as Node))) return;
    if (active) activePlayers.add(selected.player);
    else activePlayers.delete(selected.player);
    sync();
  };

  const onPointerOver = (event: Event) => markInteraction(event, true);
  const onPointerOut = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget;
    if (related && typeof (event.target as {contains?: unknown})?.contains === 'function'
      && (event.target as Node).contains(related as Node)) return;
    markInteraction(event, false);
  };
  const onFocusIn = (event: Event) => markInteraction(event, true);
  const onFocusOut = (event: Event) => markInteraction(event, false);

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  const unsubscribe = options.locator.subscribe((next) => {
    if (destroyed) return;
    if (next?.interacting) activePlayers.add(next.player);
    sync();
  });
  const controlsObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(records => {
    if (!target || !records.some(record => target!.player.contains(record.target)) || records.every(record => [...record.addedNodes, ...record.removedNodes].every(node =>
      node instanceof Element && (node.classList.contains('fluent-read-video-ui') || node.closest('.fluent-read-video-ui'))))) return;
    sync();
  }) : null;
  controlsObserver?.observe(document, {childList: true, subtree: true});
  sync();

  return {
    sync,
    getTarget: () => target,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      controlsObserver?.disconnect();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      removePlayerMark(target?.player || null);
      cleanNodes();
      target = null;
    },
  };
}
