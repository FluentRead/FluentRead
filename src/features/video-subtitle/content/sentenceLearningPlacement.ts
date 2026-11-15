/**
 * @file src/features/video-subtitle/content/sentenceLearningPlacement.ts
 * 文件职责：管理学习卡的播放器内定位与独立浮动层，避免小播放器挤压阅读和收藏操作。
 * 主要内容：浮动层保持原组件状态与焦点，支持在可见窗口内拖动及通过底部把手调整高度，提交抬手时的最终坐标；迁移期间串行处理焦点回调和销毁，视口缩小时使用实际可见高度，位置和高度仅记在当前页面会话。
 * 模块边界：只操作自有面板和绘制层，不选择媒体、不更改媒体时间/速度、不保存学习数据或全局配置；host负责创建、同媒体迁移与最终销毁。
 */
import {normalizeVideoSentenceLearningAppearance, type VideoSentenceLearningAppearance} from '@/src/core/config/videoSentenceLearningAppearance';
import {getYoutubeSubtitleControlsScope} from './youtubeControlsScope';

export type VideoLearningDragPosition = {x: number; y: number};
const GAP = 8;
const CONTROLS = 56;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** 比例只描述剩余可移动空间；大/小播放器与不同角落都保证整个面板在可见范围内。 */
export function getVideoLearningPlacement(input: {
    playerWidth: number; playerHeight: number; panelWidth: number; panelHeight: number;
    position: VideoSentenceLearningAppearance['position']; dragged?: VideoLearningDragPosition;
}): {left: number; top: number; maxHeight: number; compact: boolean} {
    const maxHeight = Math.max(0, input.playerHeight - GAP - CONTROLS);
    const travelX = Math.max(0, input.playerWidth - GAP * 2 - input.panelWidth);
    const travelY = Math.max(0, maxHeight - input.panelHeight);
    const x = input.dragged ? clamp(input.dragged.x, 0, 1) : input.position.endsWith('right') ? 1 : 0;
    const y = input.dragged ? clamp(input.dragged.y, 0, 1) : input.position.startsWith('bottom') ? 1 : 0;
    return {left: GAP + travelX * x, top: GAP + travelY * y, maxHeight, compact: maxHeight <= 340};
}

export function getVideoLearningViewportPlacement(input: {
    viewportWidth: number; viewportHeight: number; panelWidth: number; panelHeight: number; maxPanelHeight: number;
    position: VideoSentenceLearningAppearance['position']; dragged?: VideoLearningDragPosition;
}): {left: number; top: number; maxHeight: number; compact: boolean} {
    const maxHeight = Math.max(0, Math.min(input.maxPanelHeight, input.viewportHeight - GAP * 2));
    const travelX = Math.max(0, input.viewportWidth - GAP * 2 - input.panelWidth);
    const travelY = Math.max(0, input.viewportHeight - GAP * 2 - input.panelHeight);
    const x = input.dragged ? clamp(input.dragged.x, 0, 1) : input.position.endsWith('right') ? 1 : 0;
    const y = input.dragged ? clamp(input.dragged.y, 0, 1) : input.position.startsWith('bottom') ? 1 : 0;
    return {left: GAP + travelX * x, top: GAP + travelY * y, maxHeight, compact: maxHeight <= 340};
}

const MIN_FLOATING_HEIGHT = 180;
const DEFAULT_FLOATING_HEIGHT = 640;

type LearningPlacementMode = 'player' | 'floating';

export function createVideoSentenceLearningPlacement(options: {
    host: HTMLElement; player: HTMLElement; appearance: VideoSentenceLearningAppearance;
    initialPosition?: VideoLearningDragPosition; initialFloatingPosition?: VideoLearningDragPosition; initialFloatingHeight?: number;
    onDragPosition(position: VideoLearningDragPosition | undefined, mode?: LearningPlacementMode): void;
    onFloatingHeight?(height: number): void;
}): {syncPlayer(player: HTMLElement): void; isConnected(player: HTMLElement): boolean; setAppearance(appearance: VideoSentenceLearningAppearance): void; destroy(): void} {
    const {host} = options;
    const doc = host.ownerDocument;
    const win = doc.defaultView!;
    let player = options.player;
    let appearance = options.appearance;
    let dragged = options.initialPosition;
    let floatingDragged = options.initialFloatingPosition;
    let floatingHeight = options.initialFloatingHeight;
    let detached = false;
    let frame: number | undefined;
    let active = true;
    let drag: {id: number; x: number; y: number; left: number; top: number; scaleX: number; scaleY: number} | undefined;
    let pointer: {x: number; y: number} | undefined;
    let resizeDrag: {id: number; y: number; height: number} | undefined;
    let resizePointerY: number | undefined;
    let renderFrame: HTMLElement | undefined;
    let updatingParent = false;
    const scopeForPlayer = () => {
        const scope = getYoutubeSubtitleControlsScope(player);
        return doc.fullscreenElement && !doc.fullscreenElement.contains(scope) ? player : scope;
    };
    const readViewport = () => {
        const viewport = win.visualViewport;
        return {left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
            width: viewport?.width || win.innerWidth || doc.documentElement.clientWidth,
            height: viewport?.height || win.innerHeight || doc.documentElement.clientHeight};
    };
    const floatingParent = () => {
        const fullscreen = doc.fullscreenElement;
        return fullscreen && fullscreen.contains(player) ? fullscreen as HTMLElement : doc.documentElement;
    };
    const moveHost = (parent: HTMLElement) => {
        if (host.parentElement === parent) return;
        const focused = doc.activeElement as HTMLElement | null;
        const inside = focused && host.contains(focused);
        parent.appendChild(host);
        // 只修复DOM重挂造成的失焦；用户/站点已经聚焦外部控件时保留其选择。
        if (inside && focused.isConnected && (!doc.activeElement || doc.activeElement === doc.body)) focused.focus({preventScroll: true});
    };
    const restoreFrameNow = () => {
        if (!renderFrame) return;
        const previous = renderFrame;
        renderFrame = undefined;
        moveHost(player);
        previous.remove();
    };
    const restoreFrame = () => {
        // appendChild 的失焦回调可能同步触发销毁；等当前原生迁移完成再撤回宿主。
        if (updatingParent) return;
        updatingParent = true;
        try {restoreFrameNow();} finally {updatingParent = false;}
    };
    const syncRenderParent = () => {
        // blur/config 回调可以同步再次同步同一播放器，不能在尚未完成的 DOM 迁移中再次移动原节点。
        if (updatingParent) {schedule(); return;}
        updatingParent = true;
        try {
            const viewport = readViewport();
            if (detached && !(viewport.width > 0 && viewport.height > 0)) detached = false;
            const scope = detached ? floatingParent() : scopeForPlayer();
            const rect = player.getBoundingClientRect();
            const width = player.clientWidth || rect.width, height = player.clientHeight || rect.height;
            if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0 || (scope === player && !detached)) {
                restoreFrameNow(); moveHost(player); return;
            }
            if (!renderFrame) {
                renderFrame = doc.createElement('div');
                renderFrame.className = 'fluent-read-video-learning-frame fluent-read-video-ui notranslate';
                renderFrame.setAttribute('data-fluent-read-ui', 'video-subtitle'); renderFrame.setAttribute('translate', 'no');
                // 透明绘制层只接收学习卡自身的指针事件；浮出播放器时固定在可见窗口。
                for (const [name, value] of Object.entries({position: 'absolute', left: '0', top: '0', margin: '0', padding: '0', border: '0',
                    'box-sizing': 'border-box', 'pointer-events': 'none', 'z-index': '2147483645', 'transform-origin': '0 0', overflow: 'visible'})) renderFrame.style.setProperty(name, value, 'important');
            }
            if (renderFrame.parentElement !== scope) {
                // 先撤回宿主再移动空frame，避免整块迁移导致内部输入焦点丢失。
                moveHost(player); scope.appendChild(renderFrame);
            }
            if (detached) {
                renderFrame.style.setProperty('position', 'fixed', 'important');
                renderFrame.style.setProperty('left', '0', 'important'); renderFrame.style.setProperty('top', '0', 'important');
                renderFrame.style.setProperty('width', viewport.width + 'px', 'important'); renderFrame.style.setProperty('height', viewport.height + 'px', 'important');
                renderFrame.style.setProperty('transform', 'translate(' + viewport.left + 'px, ' + viewport.top + 'px)', 'important');
                moveHost(renderFrame);
                return;
            }
            renderFrame.style.setProperty('position', 'absolute', 'important');
            renderFrame.style.setProperty('width', width + 'px', 'important'); renderFrame.style.setProperty('height', height + 'px', 'important');
            renderFrame.style.setProperty('transform', 'none', 'important');
            const base = renderFrame.getBoundingClientRect();
            if (base.width <= 0 || base.height <= 0) {restoreFrameNow(); return;}
            const sx = base.width / width, sy = base.height / height;
            renderFrame.style.setProperty('transform', 'translate(' + ((rect.left - base.left) / sx) + 'px, ' + ((rect.top - base.top) / sy) + 'px) scale(' + (rect.width / base.width) + ', ' + (rect.height / base.height) + ')', 'important');
            moveHost(renderFrame);
        } finally {
            updatingParent = false;
            if (!active) restoreFrame();
        }
    };
    const readPlayerBounds = () => {
        const rect = player.getBoundingClientRect();
        const width = player.clientWidth || rect.width;
        const height = player.clientHeight || rect.height;
        const panelRect = host.getBoundingClientRect();
        const scaleX = rect.width && width ? rect.width / width : 1;
        const scaleY = rect.height && height ? rect.height / height : 1;
        const maxHeight = Math.max(0, height - GAP - CONTROLS);
        return {width, height, panelWidth: Math.min(appearance.width, Math.max(0, width - GAP * 2)),
            panelHeight: Math.min(panelRect.height / scaleY, maxHeight), scaleX, scaleY, maxHeight};
    };
    const getFloatingHeight = (viewportHeight: number) => {
        const available = Math.max(0, viewportHeight - GAP * 2);
        const minimum = Math.min(MIN_FLOATING_HEIGHT, available);
        const requested = floatingHeight ?? Math.min(DEFAULT_FLOATING_HEIGHT, available);
        return clamp(requested, minimum, available);
    };
    const readFloatingBounds = () => {
        const viewport = readViewport();
        const panelRect = host.getBoundingClientRect();
        const maxHeight = getFloatingHeight(viewport.height);
        return {width: viewport.width, height: viewport.height,
            panelWidth: Math.min(appearance.width, Math.max(0, viewport.width - GAP * 2)),
            panelHeight: Math.min(panelRect.height, maxHeight), scaleX: 1, scaleY: 1, maxHeight, viewport};
    };
    const paint = () => {
        frame = undefined;
        if (!active) return;
        if (resizeDrag && resizePointerY !== undefined && detached) {
            const viewport = readViewport();
            const available = Math.max(0, viewport.height - GAP * 2);
            const minimum = Math.min(MIN_FLOATING_HEIGHT, available);
            floatingHeight = clamp(resizeDrag.height + resizePointerY - resizeDrag.y, minimum, available);
            options.onFloatingHeight?.(floatingHeight);
        }
        syncRenderParent();
        const bounds = detached ? readFloatingBounds() : readPlayerBounds();
        if (drag && pointer) {
            const travelX = Math.max(0, bounds.width - GAP * 2 - bounds.panelWidth);
            const travelY = detached ? Math.max(0, bounds.height - GAP * 2 - bounds.panelHeight)
                : Math.max(0, bounds.maxHeight - bounds.panelHeight);
            const position = {
                x: travelX ? clamp((drag.left - GAP + (pointer.x - drag.x) / drag.scaleX) / travelX, 0, 1) : 0,
                y: travelY ? clamp((drag.top - GAP + (pointer.y - drag.y) / drag.scaleY) / travelY, 0, 1) : 0,
            };
            if (detached) floatingDragged = position;
            else dragged = position;
            if (detached) options.onDragPosition(position, 'floating');
            else options.onDragPosition(position);
        }
        const next = detached
            ? getVideoLearningViewportPlacement({viewportWidth: bounds.width, viewportHeight: bounds.height, panelWidth: bounds.panelWidth,
                panelHeight: bounds.panelHeight, maxPanelHeight: bounds.maxHeight, position: appearance.position, dragged: floatingDragged})
            : getVideoLearningPlacement({playerWidth: bounds.width, playerHeight: bounds.height, panelWidth: bounds.panelWidth,
                panelHeight: bounds.panelHeight, position: appearance.position, dragged});
        Object.assign(host.style, {left: next.left + 'px', top: next.top + 'px', right: 'auto', bottom: 'auto', overflow: 'visible',
            width: bounds.panelWidth + 'px', height: detached && floatingHeight !== undefined ? next.maxHeight + 'px' : 'auto', maxHeight: next.maxHeight + 'px'});
        host.style.setProperty('--fluent-read-video-learning-max-height', next.maxHeight + 'px');
        host.dataset.floating = String(detached);
        host.dataset.compact = String(next.compact || appearance.layout === 'compact');
        host.dataset.shortHeight = String(next.maxHeight <= 240);
        const resizeHandle = host.querySelector<HTMLElement>('[data-learning-resize-handle]');
        if (resizeHandle) {
            const available = detached ? Math.max(0, bounds.height - GAP * 2) : DEFAULT_FLOATING_HEIGHT;
            const current = detached ? Math.min(floatingHeight ?? bounds.panelHeight, bounds.maxHeight) : floatingHeight ?? DEFAULT_FLOATING_HEIGHT;
            resizeHandle.setAttribute('aria-valuemin', String(Math.round(detached ? Math.min(MIN_FLOATING_HEIGHT, available) : MIN_FLOATING_HEIGHT)));
            resizeHandle.setAttribute('aria-valuemax', String(Math.round(available)));
            resizeHandle.setAttribute('aria-valuenow', String(Math.round(current)));
        }
    };
    const schedule = () => { if (active && frame === undefined) frame = win.requestAnimationFrame(paint); };
    const stopDrag = () => { drag = undefined; pointer = undefined; delete host.dataset.dragging; };
    const stopResize = () => { resizeDrag = undefined; resizePointerY = undefined; delete host.dataset.resizing; };
    const onDown = (event: PointerEvent) => {
        const target = event.target as Element;
        if (event.button !== 0) return;
        if (target.closest?.('[data-learning-resize-handle]') && detached) {
            const bounds = readFloatingBounds();
            resizeDrag = {id: event.pointerId, y: event.clientY, height: Math.min(floatingHeight ?? bounds.panelHeight, bounds.maxHeight)};
            resizePointerY = event.clientY;
            host.dataset.resizing = 'true';
            event.preventDefault(); event.stopPropagation(); return;
        }
        if (!target.closest?.('[data-learning-drag-handle]') || target.closest('button,input,textarea,select,a,summary')) return;
        const bounds = detached ? readFloatingBounds() : readPlayerBounds();
        const position = detached ? floatingDragged : dragged;
        const current = detached
            ? getVideoLearningViewportPlacement({viewportWidth: bounds.width, viewportHeight: bounds.height, panelWidth: bounds.panelWidth,
                panelHeight: bounds.panelHeight, maxPanelHeight: bounds.maxHeight, position: appearance.position, dragged: position})
            : getVideoLearningPlacement({playerWidth: bounds.width, playerHeight: bounds.height, panelWidth: bounds.panelWidth,
                panelHeight: bounds.panelHeight, position: appearance.position, dragged: position});
        drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: current.left, top: current.top,
            scaleX: bounds.scaleX, scaleY: bounds.scaleY};
        host.dataset.dragging = 'true';
        event.preventDefault(); event.stopPropagation();
    };
    const onMove = (event: PointerEvent) => {
        if (resizeDrag?.id === event.pointerId) {
            resizePointerY = event.clientY; schedule();
            event.preventDefault(); event.stopPropagation(); return;
        }
        if (!drag || drag.id !== event.pointerId) return;
        pointer = {x: event.clientX, y: event.clientY}; schedule();
        event.preventDefault(); event.stopPropagation();
    };
    const onUp = (event: PointerEvent) => {
        if (resizeDrag?.id === event.pointerId) {
            resizePointerY = event.clientY;
            if (frame !== undefined) win.cancelAnimationFrame(frame);
            paint();
            stopResize(); paint(); return;
        }
        if (!drag || drag.id !== event.pointerId) return;
        pointer = {x: event.clientX, y: event.clientY};
        if (frame !== undefined) win.cancelAnimationFrame(frame);
        paint();
        stopDrag();
        paint();
    };
    const onFloatingToggle = (event: Event) => {
        const target = event.target as Element;
        if (!target.closest?.('[data-learning-action="float"], [data-learning-action="dock"]')) return;
        if (detached) {
            detached = false;
        } else {
            const hostRect = host.getBoundingClientRect();
            const viewport = readViewport();
            const maxHeight = getFloatingHeight(viewport.height);
            const panelWidth = Math.min(appearance.width, Math.max(0, viewport.width - GAP * 2));
            const panelHeight = Math.min(hostRect.height, maxHeight);
            const travelX = Math.max(0, viewport.width - GAP * 2 - panelWidth);
            const travelY = Math.max(0, viewport.height - GAP * 2 - panelHeight);
            const left = clamp(hostRect.left - viewport.left, GAP, Math.max(GAP, viewport.width - GAP - panelWidth));
            const top = clamp(hostRect.top - viewport.top, GAP, Math.max(GAP, viewport.height - GAP - panelHeight));
            floatingDragged = {x: travelX ? clamp((left - GAP) / travelX, 0, 1) : 0,
                y: travelY ? clamp((top - GAP) / travelY, 0, 1) : 0};
            options.onDragPosition(floatingDragged, 'floating');
            detached = true;
        }
        schedule();
    };
    const onResizeKey = (event: KeyboardEvent) => {
        const target = event.target as Element;
        if (!detached || !target.closest?.('[data-learning-resize-handle]')) return;
        const bounds = readFloatingBounds();
        const available = Math.max(0, bounds.height - GAP * 2);
        const minimum = Math.min(MIN_FLOATING_HEIGHT, available);
        const current = Math.min(floatingHeight ?? bounds.panelHeight, bounds.maxHeight);
        const step = event.shiftKey ? 96 : 32;
        if (event.key === 'ArrowUp' || event.key === 'PageUp') floatingHeight = clamp(current + step, minimum, available);
        else if (event.key === 'ArrowDown' || event.key === 'PageDown') floatingHeight = clamp(current - step, minimum, available);
        else if (event.key === 'Home') floatingHeight = minimum;
        else if (event.key === 'End') floatingHeight = available;
        else return;
        options.onFloatingHeight?.(floatingHeight);
        schedule(); event.preventDefault(); event.stopPropagation();
    };
    const onViewportChange = () => schedule();
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : undefined;
    observer?.observe(player); observer?.observe(host);
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('click', onFloatingToggle, true);
    host.addEventListener('keydown', onResizeKey, true);
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onUp, true);
    win.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('resize', onViewportChange);
    win.visualViewport?.addEventListener('scroll', onViewportChange);
    const destroy = () => {
        if (!active) return;
        active = false;
        if (frame !== undefined) win.cancelAnimationFrame(frame);
        observer?.disconnect(); stopDrag(); stopResize();
        host.removeEventListener('pointerdown', onDown, true);
        host.removeEventListener('click', onFloatingToggle, true);
        host.removeEventListener('keydown', onResizeKey, true);
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onUp, true);
        win.removeEventListener('resize', schedule);
        win.visualViewport?.removeEventListener('resize', onViewportChange);
        win.visualViewport?.removeEventListener('scroll', onViewportChange);
        restoreFrame();
    };
    try {paint();} catch (cause) {destroy(); throw cause;}
    return {
        syncPlayer(next) {
            if (!active) return;
            if (next !== player) {observer?.unobserve(player); player = next; observer?.observe(player); stopDrag(); stopResize();}
            syncRenderParent(); schedule();
        },
        isConnected(expected) {
            return active && expected === player && player.isConnected && host.isConnected && (host.parentElement === player
                || Boolean(renderFrame && host.parentElement === renderFrame && renderFrame.parentElement === (detached ? floatingParent() : scopeForPlayer())));
        },
        setAppearance(next) {
            if (!active) return;
            if (appearance.position !== next.position) {dragged = undefined; floatingDragged = undefined; options.onDragPosition(undefined); stopDrag();}
            appearance = next; schedule();
        },
        destroy,
    };
}

/** composition root 注入配置端口；关闭重开保留本页拖动位置和浮动高度，外观通知只触发布局。 */
export function createVideoLearningPlacementOwner(read: () => unknown, subscribe: (listener: () => void) => () => void): {
    place(host: HTMLElement, player: HTMLElement): {syncPlayer(player: HTMLElement): void; isConnected(player: HTMLElement): boolean; destroy(): void};
    dispose(): void;
} {
    let active = true;
    let appearance = normalizeVideoSentenceLearningAppearance(read());
    let dragged: VideoLearningDragPosition | undefined;
    let floatingDragged: VideoLearningDragPosition | undefined;
    let floatingHeight: number | undefined;
    let current: ReturnType<typeof createVideoSentenceLearningPlacement> | undefined;
    const unsubscribe = subscribe(() => {
        if (!active) return;
        const next = normalizeVideoSentenceLearningAppearance(read());
        if (JSON.stringify(next) !== JSON.stringify(appearance)) {
            if (next.position !== appearance.position) {dragged = undefined; floatingDragged = undefined;}
            appearance = next; current?.setAppearance(next);
        }
    });
    return {
        place(host, player) {
            if (!active) return {syncPlayer() {}, isConnected: () => false, destroy() {}};
            current?.destroy();
            const placement = createVideoSentenceLearningPlacement({host, player, appearance,
                initialPosition: dragged, initialFloatingPosition: floatingDragged, initialFloatingHeight: floatingHeight,
                onDragPosition(position, mode = 'player') {if (mode === 'floating') floatingDragged = position; else dragged = position;},
                onFloatingHeight(height) {floatingHeight = height;}});
            current = placement;
            return {syncPlayer: placement.syncPlayer, isConnected: placement.isConnected, destroy() {
                placement.destroy(); if (current === placement) current = undefined;
            }};
        },
        dispose() {
            if (!active) return;
            active = false; unsubscribe(); current?.destroy(); current = undefined;
        },
    };
}
