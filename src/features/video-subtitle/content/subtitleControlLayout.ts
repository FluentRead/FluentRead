/**
 * @file src/features/video-subtitle/content/subtitleControlLayout.ts
 * 文件职责：移动 YouTube 字幕在同视频可见控件之间选择可读空区，拥有外部控件遮罩之上的临时宿主与极长句滚动卡片的局部交互。
 * 主要内容：读取顶部、中部、底部和进度控件几何，保留字号并有限调整卡片宽度；普通避让字幕保持点击穿透，仅极长句在自有节点处理滚动，不添加全页输入监听。
 * 模块边界：不读取或保存配置、不改变播放器/菜单/媒体/宿主样式；显示层通过显式调用更新、还原与清理，几何切分复用 subtitleLayout。
 */
import {getVideoSubtitleFreeRegions, videoSubtitleRectsOverlap, type VideoSubtitleRect} from './subtitleLayout';
import {getYoutubeSubtitleControlsScope, YOUTUBE_SUBTITLE_CONTROLS_SELECTOR} from './youtubeControlsScope';

export const VIDEO_SUBTITLE_SCROLL_HOST_ID = 'fluent-read-video-subtitle-scroll-host';
const scrollHosts = new WeakMap<HTMLElement, {host: HTMLElement; layer: HTMLElement}>();

/** 显示状态仍由原 layer 拥有，滚动宿主只镜像自有 class 与裁切，不另建字幕模式状态。 */
export function syncSubtitleScrollHostState(layer: HTMLElement): void {
  const host = layer.ownerDocument.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID);
  if (!host) return;
  host.className = layer.className;
  host.style.setProperty('clip-path', layer.style.getPropertyValue('clip-path'), 'important');
}

export function findOwnedSubtitlePanel(layer: HTMLElement, panelId: string): HTMLElement | null {
  const panel = layer.ownerDocument.getElementById(panelId);
  if (!panel) return null;
  const owned = scrollHosts.get(panel);
  if (owned && owned.layer !== layer) {restoreScrollHost(panel, layer); resetSubtitlePanelLayout(panel, true);}
  return panel.parentElement === layer || owned?.layer === layer ? panel : null;
}

/** DOM重挂可能清掉焦点；只恢复重挂前卡片内的同一焦点，绝不聚焦原本未聚焦的字幕。 */
function moveSubtitlePanel(panel: HTMLElement, parent: HTMLElement): void {
  const active = panel.ownerDocument.activeElement;
  const restoreFocus = active instanceof HTMLElement && panel.contains(active);
  const tabIndex = panel.getAttribute('tabindex');
  parent.appendChild(panel);
  if (restoreFocus && active.isConnected && panel.ownerDocument.activeElement !== active) {
    if (active === panel && tabIndex === null) panel.tabIndex = -1;
    active.focus({preventScroll: true});
    if (active === panel && tabIndex === null) panel.removeAttribute('tabindex');
  }
}

function restoreScrollHost(panel: HTMLElement, destination?: HTMLElement): void {
  const owned = scrollHosts.get(panel);
  if (!owned) return;
  moveSubtitlePanel(panel, destination || owned.layer);
  owned.host.remove(); scrollHosts.delete(panel);
}

function alignScrollHost(panel: HTMLElement, layer: HTMLElement, player: HTMLElement): void {
  const scope = getYoutubeSubtitleControlsScope(player);
  const fullscreen = layer.ownerDocument.fullscreenElement;
  if (scope === player || (fullscreen && !fullscreen.contains(scope))) {restoreScrollHost(panel); return;}
  let owned = scrollHosts.get(panel);
  if (owned && (owned.layer !== layer || owned.host.parentElement !== scope)) {restoreScrollHost(panel, layer); owned = undefined;}
  if (!owned) {
    const host = layer.ownerDocument.createElement('div'); host.id = VIDEO_SUBTITLE_SCROLL_HOST_ID;
    host.className = layer.className; host.setAttribute('data-fluent-read-ui', 'video-subtitle');
    scope.appendChild(host); owned = {host, layer}; scrollHosts.set(panel, owned);
  }
  const {host} = owned, rect = layer.getBoundingClientRect();
  const width = layer.clientWidth || rect.width, height = layer.clientHeight || rect.height;
  host.style.setProperty('width', `${width}px`, 'important'); host.style.setProperty('height', `${height}px`, 'important');
  host.style.setProperty('transform', 'none', 'important');
  const base = host.getBoundingClientRect();
  if (base.width <= 0 || base.height <= 0 || width <= 0 || height <= 0) {restoreScrollHost(panel); return;}
  // 校准为原 layer 的轴向坐标；不要求 scope 是 offsetParent，也不修改其 position。
  const sx = base.width / width, sy = base.height / height;
  host.style.setProperty('transform', `translate(${(rect.left - base.left) / sx}px, ${(rect.top - base.top) / sy}px) scale(${rect.width / base.width}, ${rect.height / base.height})`, 'important');
  syncSubtitleScrollHostState(layer);
  if (panel.parentElement !== host) moveSubtitlePanel(panel, host);
}

export function prepareSubtitlePanelLayout(panel: HTMLElement, layer: HTMLElement, player: HTMLElement): void {
  const scrolling = subtitleScrollOwners.get(panel);
  if (scrolling?.enabled) scrolling.savedScrollTop = panel.scrollTop;
  delete panel.dataset.fluentReadSubtitleLayout;
  panel.style.removeProperty('--fluent-read-video-subtitle-padding'); panel.style.removeProperty('--fluent-read-video-subtitle-gap');
  if (scrollHosts.has(panel)) alignScrollHost(panel, layer, player);
}

// 滚动交互只归自有字幕节点所有；普通字幕不接收指针，不添加 document 级拦截。
const subtitleScrollOwners = new WeakMap<HTMLElement, {enabled: boolean; source: string; savedScrollTop?: number; dispose: () => void}>();
function setSubtitlePanelScrollable(panel: HTMLElement, enabled: boolean): void {
  let owner = subtitleScrollOwners.get(panel);
  if (enabled && !owner) {
    const heldKeys = new Set<string>();
    let pressed = false, tailUntil = 0;
    const handle = (event: Event) => {
      if (event.type === 'keydown' || event.type === 'keyup') {
        const key = (event as KeyboardEvent).key;
        if (!owner!.enabled && !heldKeys.has(key)) return;
        event.stopPropagation();
        if (event.type === 'keyup') {heldKeys.delete(key); return;}
        heldKeys.add(key);
        const end = Math.max(0, panel.scrollHeight - panel.clientHeight);
        const page = Math.max(1, panel.clientHeight * .8);
        const next = key === 'Home' ? 0 : key === 'End' ? end : key === 'ArrowDown' ? panel.scrollTop + 40
          : key === 'ArrowUp' ? panel.scrollTop - 40 : key === 'PageDown' ? panel.scrollTop + page
          : key === 'PageUp' ? panel.scrollTop - page : key === ' ' ? panel.scrollTop + ((event as KeyboardEvent).shiftKey ? -page : page) : null;
        if (next !== null) {event.preventDefault(); panel.scrollTop = Math.max(0, Math.min(end, next));}
        else if (key === 'Enter') event.preventDefault();
        // Tab / Escape / 浏览器快捷键保留默认动作；只隔离页面播放器的冒泡快捷键。
        return;
      }
      const start = ['pointerdown', 'mousedown', 'touchstart'].includes(event.type);
      const finish = ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel'].includes(event.type);
      if (!owner!.enabled && !(finish && pressed) && !(['click', 'dblclick', 'touchend', 'mouseup'].includes(event.type) && Date.now() <= tailUntil)) return;
      event.stopPropagation();
      if (start) pressed = true;
      if (finish) {pressed = false; tailUntil = Date.now() + 750;}
      // passive 触摸/滚轮监听不取消原生滚动；尾随 click 在控件刚隐藏时仍不落到宿主播放按钮。
    };
    const events = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'keydown', 'keyup'];
    events.forEach(name => panel.addEventListener(name, handle, {passive: !name.startsWith('key')}));
    owner = {enabled: false, source: '', dispose: () => events.forEach(name => panel.removeEventListener(name, handle))};
    subtitleScrollOwners.set(panel, owner);
  }
  // 先恢复滚动样式（含子项不收缩），再消费保存位置，避免浏览器按旧滚动范围钳制。
  if (enabled) {panel.dataset.fluentReadSubtitleScrollable = 'true'; panel.tabIndex = 0; panel.setAttribute('role', 'region');}
  else {delete panel.dataset.fluentReadSubtitleScrollable; panel.removeAttribute('tabindex'); panel.removeAttribute('role');}
  if (owner) {
    const source = panel.querySelector('.fluent-read-video-subtitle-original')?.textContent?.trim()
      || panel.querySelector('.fluent-read-video-subtitle')?.textContent?.trim() || '';
    if (!enabled || (owner.source && source !== owner.source && !source.startsWith(owner.source))) panel.scrollTop = 0;
    else if (owner.savedScrollTop !== undefined) panel.scrollTop = owner.savedScrollTop;
    owner.savedScrollTop = undefined;
    owner.enabled = enabled; owner.source = enabled ? source : '';
  }
}

export function resetSubtitlePanelLayout(panel: HTMLElement, dispose = false): void {
  delete panel.dataset.fluentReadSubtitleLayout;
  panel.style.removeProperty('--fluent-read-video-subtitle-padding');
  panel.style.removeProperty('--fluent-read-video-subtitle-gap');
  setSubtitlePanelScrollable(panel, false);
  restoreScrollHost(panel);
  if (dispose) {subtitleScrollOwners.get(panel)?.dispose(); subtitleScrollOwners.delete(panel);}
}

/** 菜单暂时占用交互层时仅保留同句滚动位置；正常退出与关闭仍彻底还原。 */
export function finishSubtitlePanelLayout(panel: HTMLElement, menuOpen = false): void {
  const owner = subtitleScrollOwners.get(panel);
  const source = owner?.source, position = owner?.savedScrollTop ?? panel.scrollTop;
  setSubtitlePanelScrollable(panel, false);
  if (menuOpen && owner) {owner.source = source!; owner.savedScrollTop = position;}
  restoreScrollHost(panel);
}

type VisibleSubtitleControl = {element: HTMLElement; rect: DOMRect};

/** 同视频范围内读取实际可见控件与所属分支；不把覆盖整面的控制根节点当成障碍物。 */
function getVisibleSubtitleControlEntries(player: HTMLElement): VisibleSubtitleControl[] {
  const scope = getYoutubeSubtitleControlsScope(player);
  const fullscreen = player.ownerDocument.fullscreenElement;
  const entries: VisibleSubtitleControl[] = [];
  for (const controls of scope.querySelectorAll<HTMLElement>(YOUTUBE_SUBTITLE_CONTROLS_SELECTOR)) {
    if (controls.closest('.fluent-read-video-ui')) continue;
    if (fullscreen?.contains(player) && !fullscreen.contains(controls)) continue;
    const rect = controls.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let visible = true;
    for (let current: HTMLElement | null = controls; current && visible; current = current.parentElement) {
      const style = getComputedStyle(current);
      visible = !current.hidden && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
      if (current === scope) break;
    }
    if (visible) {
      const duplicate = entries.findIndex(({rect: other}) => other.left === rect.left && other.top === rect.top && other.width === rect.width && other.height === rect.height);
      if (duplicate < 0) entries.push({element: controls, rect});
      // 同矩形优先保留外部分支的代表，去重后仍能识别播放器外的暗色控件遮罩。
      else if (!player.contains(controls)) entries[duplicate] = {element: controls, rect};
    }
    if (entries.length >= 16) break;
  }
  return entries;
}

export function getVisibleYoutubeSubtitleControls(player: HTMLElement): DOMRect[] {
  return getVisibleSubtitleControlEntries(player).map(({rect}) => rect);
}

/** 仅在移动自动贴底发生碰撞时选择少量空区；先保留字号和宽度，再限宽和压紧卡片内距。 */
export function positionMobileYoutubeSubtitle(panel: HTMLElement, player: HTMLElement, layer: HTMLElement, viewport: VideoSubtitleRect, availableWidth: number): boolean {
  const layerRect = layer.getBoundingClientRect();
  const scaleX = layer.clientWidth > 0 ? layerRect.width / layer.clientWidth : 1;
  const scaleY = layer.clientHeight > 0 ? layerRect.height / layer.clientHeight : 1;
  const toLocal = (rect: DOMRect): VideoSubtitleRect => ({left: (rect.left - layerRect.left) / scaleX, top: (rect.top - layerRect.top) / scaleY,
    width: rect.width / scaleX, height: rect.height / scaleY});
  const controls = getVisibleSubtitleControlEntries(player).map(({element, rect}) => ({element, rect: toLocal(rect)}))
    .filter(({rect}) => videoSubtitleRectsOverlap(rect, viewport));
  const obstacles = controls.map(({rect}) => rect);
  if (!obstacles.length) return false;
  const preferred = toLocal(panel.getBoundingClientRect());
  if (!obstacles.some(rect => videoSubtitleRectsOverlap(preferred, rect))) return false;
  const regions = getVideoSubtitleFreeRegions(viewport, obstacles);
  if (!regions.length) return false;
  const position = (region: VideoSubtitleRect, size: VideoSubtitleRect, scrolling: boolean) => {
    panel.style.setProperty('left', `${Math.max(region.left, Math.min(preferred.left, region.left + region.width - size.width))}px`, 'important');
    panel.style.setProperty('top', `${Math.max(region.top, Math.min(preferred.top, region.top + region.height - size.height))}px`, 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('max-height', `${region.height}px`, 'important');
    panel.dataset.fluentReadSubtitleLayout = scrolling ? 'scroll' : 'free';
    // 普通避让字幕也需绘制在外部暗罩之上；是否滚动仍独立决定指针和键盘交互。
    if (scrolling || controls.some(({element}) => !player.contains(element))) alignScrollHost(panel, layer, player);
    else restoreScrollHost(panel);
    // 重挂会重建真实滚动盒；必须等最终parent、尺寸和滚动CSS齐备后才恢复并消费保存值。
    setSubtitlePanelScrollable(panel, scrolling);
  };
  const distance = (area: VideoSubtitleRect) => Math.abs(Math.max(area.left, Math.min(preferred.left, area.left + area.width - preferred.width)) - preferred.left)
    + Math.abs(Math.max(area.top, Math.min(preferred.top, area.top + area.height - preferred.height)) - preferred.top);
  regions.sort((a, b) => distance(a) - distance(b));
  // 先查原尺寸，避免短句因为候选排序而无故变窄或增加换行。
  const original = regions.find(area => area.width >= preferred.width && area.height >= Math.max(preferred.height, panel.scrollHeight));
  if (original) {position(original, preferred, false); return true;}
  for (const compact of [false, true]) {
    if (compact) {panel.style.setProperty('--fluent-read-video-subtitle-padding', '3px 6px'); panel.style.setProperty('--fluent-read-video-subtitle-gap', '2px');}
    for (const area of regions) {
      panel.style.setProperty('max-width', `${Math.min(availableWidth, area.width)}px`, 'important');
      panel.style.setProperty('max-height', 'none', 'important');
      const measured = toLocal(panel.getBoundingClientRect());
      if (measured.width <= area.width + .1 && measured.height <= area.height + .1) {position(area, measured, false); return true;}
    }
  }
  // 极长句保持用户字号；只让字幕卡本身滚动，不让其高度覆盖原生控件。
  const area = [...regions].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  panel.style.setProperty('max-width', `${Math.min(availableWidth, area.width)}px`, 'important');
  panel.style.setProperty('max-height', `${area.height}px`, 'important');
  position(area, toLocal(panel.getBoundingClientRect()), true);
  return true;
}
