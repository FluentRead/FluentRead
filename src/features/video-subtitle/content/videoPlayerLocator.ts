/**
 * @file src/features/video-subtitle/content/videoPlayerLocator.ts
 * 文件职责：在 X/YouTube 的单页播放器和信息流 DOM 中选择当前视频，并维护稳定的视频身份。
 * 主要内容：按全屏、用户悬浮/聚焦、当前帖子和可见性排序候选，跟踪 DOM 重挂载与媒体源变化。
 * 模块边界：只读取播放器 DOM 与页面事件，不创建 FluentRead 节点、不处理字幕或配置；绑定和生命周期由上层负责。
 */

export interface VideoPlayerTarget {
  readonly video: HTMLVideoElement;
  readonly player: HTMLElement;
  readonly key: string;
  readonly fullscreen: boolean;
  readonly interacting: boolean;
}

export interface VideoPlayerLocatorOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly isXPage?: () => boolean;
}

export interface VideoPlayerLocator {
  getTarget(): VideoPlayerTarget | null;
  sync(): VideoPlayerTarget | null;
  subscribe(listener: (target: VideoPlayerTarget | null) => void): () => void;
  destroy(): void;
}

const PLAYER_SELECTOR = '#movie_player, .html5-video-player, [data-testid="videoPlayer"]';
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing) return existing;
  const id = nextObjectId++;
  objectIds.set(value, id);
  return id;
}

function safeCurrentSource(video: HTMLVideoElement): string {
  return video.currentSrc || video.src || video.getAttribute('src') || '';
}

function isConnected(element: Element | null): element is Element {
  return Boolean(element && element.isConnected !== false);
}

function isElement(value: unknown): value is Element {
  return Boolean(value && typeof (value as {tagName?: unknown}).tagName === 'string');
}

function rectIsVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  return Boolean(element.offsetWidth > 0 && element.offsetHeight > 0);
}

function computedIsHidden(element: HTMLElement, view: Window): boolean {
  const style = view.getComputedStyle?.(element);
  return style?.display === 'none' || style?.visibility === 'hidden' || style?.contentVisibility === 'hidden';
}

function isVisibleVideo(video: HTMLVideoElement, view: Window): boolean {
  return isConnected(video) && !computedIsHidden(video, view) && rectIsVisible(video);
}

function currentStatusId(view: Window): string {
  return view.location.pathname.match(/\/status\/(\d+)/i)?.[1] || '';
}

function isXMediaVideoLink(anchor: HTMLAnchorElement, view: Window, status = ''): boolean {
  try {
    const href = new URL(anchor.getAttribute('href') || '', view.location.href);
    if (href.origin !== view.location.origin) return false;
    const match = href.pathname.match(/\/status\/(\d+)\/video\/\d+\/?$/i);
    return Boolean(match && (!status || match[1] === status));
  } catch {
    return false;
  }
}

function linkCoversVideo(anchor: HTMLAnchorElement, video: HTMLVideoElement): boolean {
  if (anchor.contains(video) || video.contains(anchor)) return true;
  const anchorRect = anchor.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  if (anchorRect.width <= 0 || anchorRect.height <= 0 || videoRect.width <= 0 || videoRect.height <= 0) {
    return false;
  }
  const left = Math.max(anchorRect.left, videoRect.left);
  const right = Math.min(anchorRect.right, videoRect.right);
  const top = Math.max(anchorRect.top, videoRect.top);
  const bottom = Math.min(anchorRect.bottom, videoRect.bottom);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  return overlap >= videoRect.width * videoRect.height * .5;
}

function hasXVideoLinkIn(scope: Element, video: HTMLVideoElement, view: Window, status = ''): boolean {
  return Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .some((anchor) => isXMediaVideoLink(anchor, view, status) && linkCoversVideo(anchor, video));
}

function findXVideoScope(video: HTMLVideoElement, view: Window, status = ''): HTMLElement | null {
  const post = video.closest('article');
  if (!post) return null;
  let current: HTMLElement | null = video.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
    const videos = Array.from(current.querySelectorAll('video'));
    if (videos.length === 1 && videos[0] === video && hasXVideoLinkIn(current, video, view, status)) return current;
    if (current === post) break;
  }
  return null;
}

function hasCurrentXVideoLink(video: HTMLVideoElement, view: Window): boolean {
  const status = currentStatusId(view);
  return Boolean(status && findXVideoScope(video, view, status));
}

function playerForVideo(video: HTMLVideoElement, view: Window): HTMLElement {
  const fullscreen = view.document.fullscreenElement;
  if (fullscreen && fullscreen !== video && fullscreen.contains(video)
    && fullscreen.querySelectorAll('video').length === 1) {
    return fullscreen as HTMLElement;
  }

  const xPost = video.closest('article');
  if (xPost) {
    const scope = findXVideoScope(video, view);
    if (scope) return scope;
  }

  const known = video.closest<HTMLElement>(PLAYER_SELECTOR);
  if (known) return known;

  let current: HTMLElement | null = video.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    if (rectIsVisible(current)) return current;
  }
  return video.parentElement || video;
}

function videoKey(video: HTMLVideoElement): string {
  return `${objectId(video)}:${safeCurrentSource(video)}`;
}

function isFullscreenVideo(video: HTMLVideoElement, document: Document): boolean {
  const fullscreen = document.fullscreenElement;
  return Boolean(fullscreen && (fullscreen === video || fullscreen.contains(video)))
    || Boolean((video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen);
}

function isInteractionVideo(candidate: VideoPlayerTarget, document: Document, activeInteraction: HTMLVideoElement | null): boolean {
  const video = candidate.video;
  if (activeInteraction === video) return true;
  const active = document.activeElement;
  return Boolean(active && (active === video || video.contains(active) || candidate.player.contains(active)));
}

function interactionVideo(
  target: Element,
  document: Document,
  view: Window,
  selected: VideoPlayerTarget | null,
): HTMLVideoElement | null {
  const direct = target.closest('video');
  if (direct && direct.tagName === 'VIDEO') return direct as HTMLVideoElement;
  if (selected?.player.contains(target)) return selected.video;

  const fullscreen = document.fullscreenElement;
  if (fullscreen && fullscreen.contains(target)) {
    const videos = fullscreen.querySelectorAll('video');
    if (videos.length === 1) return videos[0] as HTMLVideoElement;
  }

  const known = target.closest<HTMLElement>(PLAYER_SELECTOR);
  if (known) {
    const videos = known.querySelectorAll('video');
    if (videos.length === 1) return videos[0] as HTMLVideoElement;
  }

  const post = target.closest('article');
  if (post) {
    const videos = post.querySelectorAll('video');
    const owned = Array.from(videos).map((candidate) => {
      const video = candidate as HTMLVideoElement;
      return {video, scope: findXVideoScope(video, view)};
    }).find(({scope}) => scope?.contains(target));
    if (owned) return owned.video;
  }
  return null;
}

function chooseCandidate(
  candidates: readonly VideoPlayerTarget[],
  document: Document,
  view: Window,
  isXPage: boolean,
  lastInteraction: HTMLVideoElement | null,
  selected: VideoPlayerTarget | null,
): VideoPlayerTarget | null {
  const connected = candidates.filter((candidate) => isConnected(candidate.video) && isConnected(candidate.player));
  if (connected.length === 0) return null;

  const fullscreen = connected.find((candidate) => isFullscreenVideo(candidate.video, document));
  if (fullscreen) return fullscreen;

  const interacted = connected.find((candidate) => isInteractionVideo(candidate, document, lastInteraction));
  if (interacted) return interacted;

  if (selected) {
    const stillSelected = connected.find((candidate) => candidate.key === selected.key);
    if (stillSelected) return stillSelected;
  }

  const status = currentStatusId(view);
  if (isXPage && status) {
    const current = connected.find((candidate) => hasCurrentXVideoLink(candidate.video, view));
    if (current) return current;
  }

  // 信息流中没有用户意图时不猜第一个视频，避免把字幕挂到屏外或其他帖子。
  if (isXPage && connected.length > 1) return null;
  return connected[0];
}

export function createVideoPlayerLocator(options: VideoPlayerLocatorOptions = {}): VideoPlayerLocator {
  const document = options.document || window.document;
  const view = options.window || window;
  const isXPage = options.isXPage?.() ?? /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(view.location.hostname);
  let lastInteraction: HTMLVideoElement | null = null;
  let activeInteraction: HTMLVideoElement | null = null;
  let selected: VideoPlayerTarget | null = null;
  const listeners = new Set<(target: VideoPlayerTarget | null) => void>();

  const candidates = (): VideoPlayerTarget[] => Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
    .filter((video) => isVisibleVideo(video, view))
    .map((video) => {
      const player = playerForVideo(video, view);
      const candidate = {video, player, key: videoKey(video), fullscreen: isFullscreenVideo(video, document), interacting: false};
      return {...candidate, interacting: isInteractionVideo(candidate, document, activeInteraction)};
    });

  const sync = (): VideoPlayerTarget | null => {
    const next = chooseCandidate(candidates(), document, view, isXPage, lastInteraction, selected);
    const changed = next?.key !== selected?.key || next?.player !== selected?.player
      || next?.fullscreen !== selected?.fullscreen || next?.interacting !== selected?.interacting;
    selected = next;
    if (changed) listeners.forEach((listener) => listener(selected));
    return selected;
  };

  const onPointer = (event: Event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (video && (lastInteraction !== video || activeInteraction !== video)) {
      lastInteraction = video as HTMLVideoElement;
      activeInteraction = video as HTMLVideoElement;
      sync();
    }
  };
  const onPointerOut = (event: Event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (!video || activeInteraction !== video) return;
    const related = (event as MouseEvent).relatedTarget;
    const player = playerForVideo(video, view);
    if (related && player.contains(related as Node)) return;
    activeInteraction = null;
    sync();
  };
  const onFocus = (event: Event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (video && (lastInteraction !== video || activeInteraction !== video)) {
      lastInteraction = video;
      activeInteraction = video;
      sync();
    }
  };
  const onFocusOut = (event: Event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (!video || activeInteraction !== video) return;
    const related = (event as FocusEvent).relatedTarget;
    const player = playerForVideo(video, view);
    if (related && player.contains(related as Node)) return;
    activeInteraction = null;
    sync();
  };
  const onFullscreen = () => sync();
  let domSyncPending = false;
  let domSyncHandle: number | undefined;
  const flushDomSync = () => {
    domSyncPending = false;
    domSyncHandle = undefined;
    sync();
  };
  const scheduleDomSync = () => {
    if (domSyncPending) return;
    domSyncPending = true;
    if (typeof view.requestAnimationFrame === 'function') {
      domSyncHandle = view.requestAnimationFrame(flushDomSync);
    } else {
      domSyncHandle = view.setTimeout(flushDomSync, 0);
    }
  };
  const isOwnedNode = (node: Node): boolean => {
    if (!(node instanceof Element)) return false;
    return node.classList.contains('fluent-read-video-ui') || Boolean(node.closest('.fluent-read-video-ui'));
  };
  const onDom = (records: MutationRecord[]) => {
    if (records.length > 0 && records.every((record) => {
      if (isOwnedNode(record.target)) return true;
      return [...record.addedNodes, ...record.removedNodes].every(isOwnedNode);
    })) return;
    scheduleDomSync();
  };
  document.addEventListener('pointerover', onPointer, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('mouseover', onPointer, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('fullscreenchange', onFullscreen, true);
  view.addEventListener('resize', onFullscreen, true);
  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(onDom)
    : null;
  observer?.observe(document.documentElement || document, {childList: true, subtree: true});

  return {
    getTarget: () => selected,
    sync,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      observer?.disconnect();
      if (domSyncHandle !== undefined) {
        if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(domSyncHandle);
        else view.clearTimeout(domSyncHandle);
      }
      document.removeEventListener('pointerover', onPointer, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('mouseover', onPointer, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('fullscreenchange', onFullscreen, true);
      view.removeEventListener('resize', onFullscreen, true);
      listeners.clear();
      selected = null;
      lastInteraction = null;
      activeInteraction = null;
    },
  };
}

export function selectVideoPlayerTarget(
  document: Document,
  options: {window?: Window; isXPage?: boolean; selected?: VideoPlayerTarget | null} = {},
): VideoPlayerTarget | null {
  const view = options.window || window;
  const isXPage = options.isXPage ?? /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(view.location.hostname);
  const candidates = Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
    .filter((video) => isVisibleVideo(video, view))
    .map((video) => {
      const player = playerForVideo(video, view);
      return {video, player, key: videoKey(video), fullscreen: isFullscreenVideo(video, document), interacting: false};
    });
  return chooseCandidate(candidates, document, view, isXPage, null, options.selected || null);
}

export function getVideoPlayerForVideo(video: HTMLVideoElement, view: Window = window): HTMLElement {
  return playerForVideo(video, view);
}
