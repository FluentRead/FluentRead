/**
 * @file src/features/video-subtitle/content/videoPlayerLocator.ts
 * 文件职责：在 X/YouTube 及普通 HTML 音视频 DOM（含开放 Shadow DOM）中选择当前媒体，并维护稳定的视频身份。
 * 主要内容：按跨浏览器全屏、用户悬浮/聚焦、当前帖子和可见性排序候选；普通 HTML 媒体模式过滤静音自动播放/循环装饰预览及过小视频，忽略宿主原生播放器内部进度与文字更新，外层 class 变更在当前媒体有效时降频重扫，避免独立浮层抖动。
 * 模块边界：只读取播放器 DOM 与页面事件，不创建 FluentRead 节点、不处理字幕或配置；绑定和生命周期由上层负责。
 */
import {getFullscreenElement, onFullscreenChange} from '@/src/platform/dom/fullscreen';
import {containsDeep, hasSelectorDeep, querySelectorAllDeep} from '@/src/shared/dom/shadowQuery';
import {isEligibleHtmlMedia} from './htmlMedia';

export interface VideoPlayerTarget {
  readonly video: HTMLMediaElement;
  readonly player: HTMLElement;
  readonly key: string;
  readonly fullscreen: boolean;
  readonly interacting: boolean;
}

export interface VideoPlayerLocatorOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly isXPage?: () => boolean;
  readonly includeAudio?: boolean;
  readonly getPlayer?: (media: HTMLMediaElement) => HTMLElement;
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

function safeCurrentSource(video: HTMLMediaElement): string {
  return video.currentSrc || video.src || video.getAttribute('src') || video.querySelector<HTMLSourceElement>('source[src]')?.src || '';
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
  return style?.display === 'none' || style?.visibility === 'hidden' || style?.contentVisibility === 'hidden' || style?.opacity === '0';
}

function isVisibleVideo(video: HTMLMediaElement, view: Window, includeAudio = false): boolean {
  if (!isConnected(video) || video.closest('.fluent-read-video-ui') || computedIsHidden(video, view) || !rectIsVisible(video)) return false;
  if (!includeAudio) return true;
  if (!isEligibleHtmlMedia(video)) return false;
  if (video.tagName === 'VIDEO') {
    const rect = video.getBoundingClientRect();
    const width = rect.width || video.offsetWidth;
    const height = rect.height || video.offsetHeight;
    if (width < 120 || height < 48) return false;
  }
  return true;
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

function linkCoversVideo(anchor: HTMLAnchorElement, video: HTMLMediaElement): boolean {
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

function hasXVideoLinkIn(scope: Element, video: HTMLMediaElement, view: Window, status = ''): boolean {
  return Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .some((anchor) => isXMediaVideoLink(anchor, view, status) && linkCoversVideo(anchor, video));
}

function findXVideoScope(video: HTMLMediaElement, view: Window, status = ''): HTMLElement | null {
  const post = video.closest('article');
  if (!post) return null;
  let current: HTMLElement | null = video.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
    const videos = Array.from(current.querySelectorAll('video, audio'));
    if (videos.length === 1 && videos[0] === video && hasXVideoLinkIn(current, video, view, status)) return current;
    if (current === post) break;
  }
  return null;
}

function hasCurrentXVideoLink(video: HTMLMediaElement, view: Window): boolean {
  const status = currentStatusId(view);
  return Boolean(status && findXVideoScope(video, view, status));
}

function queryMediaElements(root: ParentNode, selector: string): HTMLMediaElement[] {
  const light = Array.from(root.querySelectorAll<HTMLMediaElement>(selector));
  return light.length ? light : querySelectorAllDeep<HTMLMediaElement>(root, selector);
}

export function getVideoPlayerForVideo(video: HTMLMediaElement, view: Window = window): HTMLElement {
  const fullscreen = getFullscreenElement(view.document);
  const youtubePlayer = video.closest<HTMLElement>('#movie_player, .html5-video-player');
  // YouTube 可以将 html 设为全屏，再用 fixed 撑满实际播放器；html 此时可能
  // 高度为 0。只有播放器在全屏子树之外时才需要改用更内层的全屏容器。
  if (youtubePlayer && (!fullscreen || containsDeep(fullscreen, youtubePlayer))) return youtubePlayer;
  if (fullscreen && fullscreen !== video && containsDeep(fullscreen, video)
    && queryMediaElements(fullscreen, 'video, audio').length === 1) {
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

function videoKey(video: HTMLMediaElement): string {
  return `${objectId(video)}:${video.srcObject ? objectId(video.srcObject) : safeCurrentSource(video)}`;
}

function isFullscreenVideo(video: HTMLMediaElement, document: Document): boolean {
  const fullscreen = getFullscreenElement(document);
  return Boolean(fullscreen && containsDeep(fullscreen, video))
    || Boolean((video as HTMLMediaElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen);
}

function isInteractionVideo(candidate: VideoPlayerTarget, document: Document, activeInteraction: HTMLMediaElement | null): boolean {
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
): HTMLMediaElement | null {
  const direct = target.closest('video, audio');
  if (direct && ['VIDEO', 'AUDIO'].includes(direct.tagName)) return direct as HTMLMediaElement;
  if (selected?.player.contains(target)) return selected.video;

  const fullscreen = getFullscreenElement(document);
  if (fullscreen && fullscreen.contains(target)) {
    const videos = fullscreen.querySelectorAll('video, audio');
    if (videos.length === 1) return videos[0] as HTMLMediaElement;
  }

  const known = target.closest<HTMLElement>(PLAYER_SELECTOR);
  if (known) {
    const videos = known.querySelectorAll('video, audio');
    if (videos.length === 1) return videos[0] as HTMLMediaElement;
  }

  // X 的部分播放器没有旧 data-testid，指针会落在 video 的兄弟覆盖层。
  // 只在有限祖先中找唯一视频，且目标必须属于其实际播放器；相邻帖子文字不能选中视频。
  let scope: Element | null = target;
  for (let depth = 0; scope && scope !== document.body && scope !== document.documentElement && depth < 8;
    depth += 1, scope = scope.parentElement) {
    const videos = scope.querySelectorAll<HTMLMediaElement>('video, audio');
    if (videos.length > 1) break;
    if (videos.length === 1 && getVideoPlayerForVideo(videos[0], view).contains(target)) return videos[0];
  }

  const post = target.closest('article');
  if (post) {
    const videos = post.querySelectorAll('video, audio');
    const owned = Array.from(videos).map((candidate) => {
      const video = candidate as HTMLMediaElement;
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
  lastInteraction: HTMLMediaElement | null,
  selected: VideoPlayerTarget | null,
): VideoPlayerTarget | null {
  const connected = candidates.filter((candidate) => isConnected(candidate.video) && isConnected(candidate.player));
  if (connected.length === 0) return null;

  const fullscreen = connected.find((candidate) => isFullscreenVideo(candidate.video, document));
  if (fullscreen) return fullscreen;

  // 新视频上的指针/焦点交互优先于旧菜单残留的 document.activeElement。
  const interacted = connected.find((candidate) => candidate.video === lastInteraction)
    || connected.find((candidate) => isInteractionVideo(candidate, document, null));
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
  return connected.find(candidate => candidate.video.paused === false && !candidate.video.ended) || connected[0];
}

export function createVideoPlayerLocator(options: VideoPlayerLocatorOptions = {}): VideoPlayerLocator {
  const document = options.document || window.document;
  const view = options.window || window;
  const isXPage = options.isXPage?.() ?? /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(view.location.hostname);
  let lastInteraction: HTMLMediaElement | null = null;
  let activeInteraction: HTMLMediaElement | null = null;
  let selected: VideoPlayerTarget | null = null;
  let selectedNativePlayer: HTMLElement | null = null;
  const listeners = new Set<(target: VideoPlayerTarget | null) => void>();

  const sync = (): VideoPlayerTarget | null => {
    const candidate = selectVideoPlayerTarget(document, {window: view, isXPage, selected, lastInteraction, activeInteraction, includeAudio: options.includeAudio});
    selectedNativePlayer = candidate?.player || null;
    const next = candidate && options.getPlayer ? {...candidate, player: options.getPlayer(candidate.video)} : candidate;
    const changed = next?.key !== selected?.key || next?.player !== selected?.player
      || next?.fullscreen !== selected?.fullscreen || next?.interacting !== selected?.interacting;
    selected = next;
    if (changed) listeners.forEach((listener) => listener(selected));
    return selected;
  };

  const onPointer = (event: Event) => {
    // 普通媒体的浮层可能位于另一播放器上方；关闭浮层产生的 hover 不能切走当前学习会话。
    if (options.includeAudio && event.type !== 'pointerdown') return;
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (video && (lastInteraction !== video || activeInteraction !== video)) {
      lastInteraction = video as HTMLMediaElement;
      activeInteraction = video as HTMLMediaElement;
      sync();
    }
  };
  const onPointerOut = (event: Event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const video = interactionVideo(target, document, view, selected);
    if (!video || activeInteraction !== video) return;
    const related = (event as MouseEvent).relatedTarget;
    const player = getVideoPlayerForVideo(video, view);
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
    const player = getVideoPlayerForVideo(video, view);
    if (related && player.contains(related as Node)) return;
    activeInteraction = null;
    sync();
  };
  const onFullscreen = () => sync();
  let domSyncPending = false;
  let domSyncHandle: number | undefined;
  let deferredDomSyncHandle: number | undefined;
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
  const scheduleDeferredDomSync = () => {
    if (domSyncPending || deferredDomSyncHandle !== undefined) return;
    // 信息流持续插入文字和计数时，按帧全页查询视频会产生大量布局读取。
    // 保留定期重扫以捕获未直接改动 video 节点的可见性和路由变化。
    deferredDomSyncHandle = view.setTimeout(() => {
      deferredDomSyncHandle = undefined;
      scheduleDomSync();
    }, 250);
  };
  const isOwnedNode = (node: Node): boolean => {
    if (!(node instanceof Element)) return false;
    return node.classList.contains('fluent-read-video-ui') || Boolean(node.closest('.fluent-read-video-ui'));
  };
  const containsVideo = (node: Node): boolean => {
    if (node.nodeType !== 1 && node.nodeType !== 11) return false;
    const element = node as Element;
    return ['video', 'audio'].includes(element.tagName?.toLowerCase()) || hasSelectorDeep(node as ParentNode, 'video, audio');
  };
  const isVideoContent = (node: Node): boolean => isElement(node)
    && (['video', 'audio'].includes(node.tagName.toLowerCase())
      || (['source', 'track'].includes(node.tagName.toLowerCase()) && Boolean(node.closest('video, audio'))));
  const onDom = (records: MutationRecord[]) => {
    if (records.length > 0 && records.every((record) => {
      if (isOwnedNode(record.target)) return true;
      return record.type !== 'attributes' && [...record.addedNodes, ...record.removedNodes].every(isOwnedNode);
    })) return;
    const relevant = records.filter(record => {
      if (record.type === 'attributes') {
        if (isOwnedNode(record.target) || !isElement(record.target)) return false;
        // classList.add 等同值写入也能产生记录，不能让入口标记自触发定位循环。
        if (record.target.getAttribute(record.attributeName!) === record.oldValue) return false;
        return containsVideo(record.target) || isVideoContent(record.target);
      }
      if (isVideoContent(record.target) || [...record.addedNodes, ...record.removedNodes].some(containsVideo)) return true;
      // 原生字幕逐词替换 Text/span、进度文字和 tooltip 不改变视频身份。
      // 控件结构另由 binding 观察；独立浮层宿主不包裹原视频，同时忽略原播放器内部子树更新。
      return !(selected?.player.contains(record.target) || (selectedNativePlayer !== null && containsDeep(selectedNativePlayer, record.target)));
    });
    if (records.length && !relevant.length) return;
    const hasConnectedSelected = Boolean(selected && isConnected(selected.video));
    const playerChanged = relevant.some((record) => {
      if (record.type === 'attributes') {
        return !options.includeAudio || isVideoContent(record.target) || record.attributeName !== 'class' || !hasConnectedSelected;
      }
      return isVideoContent(record.target)
        || [...record.addedNodes, ...record.removedNodes].some(containsVideo);
    });
    if (playerChanged) {
      if (deferredDomSyncHandle !== undefined) view.clearTimeout(deferredDomSyncHandle);
      deferredDomSyncHandle = undefined;
      scheduleDomSync();
    } else scheduleDeferredDomSync();
  };
  const onPlay = (event: Event) => {
    const media = event.target as HTMLMediaElement | null;
    if (!options.includeAudio || !media || !['AUDIO', 'VIDEO'].includes(media.tagName) || !isEligibleHtmlMedia(media)) return;
    // 正在学习的播放不能被网页自动播放的广告抢占；明确点击/聚焦新媒体仍可切换。
    if (selected && selected.video !== media && selected.video.paused === false && !selected.video.ended) return;
    lastInteraction = media; sync();
  };
  document.addEventListener('play', onPlay, true);
  document.addEventListener('pointerover', onPointer, true);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('mouseover', onPointer, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onFocusOut, true);
  const stopFullscreen = onFullscreenChange(document, onFullscreen, true);
  document.addEventListener('webkitbeginfullscreen', onFullscreen, true);
  document.addEventListener('webkitendfullscreen', onFullscreen, true);
  view.addEventListener('resize', onFullscreen, true);
  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(onDom)
    : null;
  observer?.observe(document.documentElement || document, {childList: true, subtree: true,
    attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'src']});

  return {
    getTarget: () => selected,
    sync,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      observer?.disconnect();
      if (deferredDomSyncHandle !== undefined) view.clearTimeout(deferredDomSyncHandle);
      if (domSyncHandle !== undefined) {
        if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(domSyncHandle);
        else view.clearTimeout(domSyncHandle);
      }
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('pointerover', onPointer, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('mouseover', onPointer, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onFocusOut, true);
      stopFullscreen();
      document.removeEventListener('webkitbeginfullscreen', onFullscreen, true);
      document.removeEventListener('webkitendfullscreen', onFullscreen, true);
      view.removeEventListener('resize', onFullscreen, true);
      listeners.clear();
      selected = null;
      selectedNativePlayer = null;
      lastInteraction = null;
      activeInteraction = null;
    },
  };
}

function collectVisibleMedia(document: Document, selector: string, view: Window, includeAudio = false): HTMLMediaElement[] {
  const light = Array.from(document.querySelectorAll<HTMLMediaElement>(selector))
    .filter((video) => isVisibleVideo(video, view, includeAudio));
  if (light.length === 0) {
    return querySelectorAllDeep<HTMLMediaElement>(document, selector)
      .filter((video) => isVisibleVideo(video, view, includeAudio));
  }
  const fullscreen = getFullscreenElement(document);
  if (fullscreen && !light.some((video) => containsDeep(fullscreen, video))) {
    const extra = fullscreen.matches(selector)
      ? [fullscreen as HTMLMediaElement]
      : querySelectorAllDeep<HTMLMediaElement>(fullscreen, selector);
    for (const video of extra) {
      if (isVisibleVideo(video, view, includeAudio)) light.push(video);
    }
  }
  return light;
}

export function selectVideoPlayerTarget(
  document: Document,
  options: {window?: Window; isXPage?: boolean; selected?: VideoPlayerTarget | null;
    lastInteraction?: HTMLMediaElement | null; activeInteraction?: HTMLMediaElement | null; includeAudio?: boolean} = {},
): VideoPlayerTarget | null {
  const view = options.window || window;
  const isXPage = options.isXPage ?? /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(view.location.hostname);
  const selector = options.includeAudio ? 'video, audio' : 'video';
  const candidates = collectVisibleMedia(document, selector, view, options.includeAudio)
    .map((video) => {
      const player = getVideoPlayerForVideo(video, view);
      const candidate = {video, player, key: videoKey(video), fullscreen: isFullscreenVideo(video, document), interacting: false};
      return {...candidate, interacting: isInteractionVideo(candidate, document, options.activeInteraction || null)};
    });
  return chooseCandidate(candidates, document, view, isXPage, options.lastInteraction || null, options.selected || null);
}
