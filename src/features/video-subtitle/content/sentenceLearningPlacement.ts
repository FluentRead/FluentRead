/**
 * @file src/features/video-subtitle/content/sentenceLearningPlacement.ts
 * 文件职责：管理学习卡的媒体坐标、物理挂载与本次页面会话拖动位置，避免移动控件遮挡或全屏迁移丢失状态。
 * 主要内容：仅为已验证单视频mweb容器建立自有透明绘制层，整块原学习宿主保持Vue状态与焦点；按原播放器和用户默认角落定位，向自有宿主发布实际短高度滚动布局标记，拖动以剩余空间比例记忆并保留底部控制区。
 * 模块边界：只操作自有面板和frame，以既有player验证同视频范围，不选择媒体、不更改媒体时间/速度、不保存学习数据或全局配置；host负责创建、同媒体迁移与最终销毁。
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

export function createVideoSentenceLearningPlacement(options: {
    host: HTMLElement; player: HTMLElement; appearance: VideoSentenceLearningAppearance;
    initialPosition?: VideoLearningDragPosition;
    onDragPosition(position: VideoLearningDragPosition | undefined): void;
}): {syncPlayer(player: HTMLElement): void; isConnected(player: HTMLElement): boolean; setAppearance(appearance: VideoSentenceLearningAppearance): void; destroy(): void} {
    const {host} = options;
    const doc = host.ownerDocument;
    const win = doc.defaultView!;
    let player = options.player;
    let appearance = options.appearance;
    let dragged = options.initialPosition;
    let frame: number | undefined;
    let active = true;
    let drag: {id: number; x: number; y: number; left: number; top: number; scaleX: number; scaleY: number} | undefined;
    let pointer: {x: number; y: number} | undefined;
    let renderFrame: HTMLElement | undefined;
    const scopeForPlayer = () => {
        const scope = getYoutubeSubtitleControlsScope(player);
        return doc.fullscreenElement && !doc.fullscreenElement.contains(scope) ? player : scope;
    };
    const moveHost = (parent: HTMLElement) => {
        if (host.parentElement === parent) return;
        const focused = doc.activeElement as HTMLElement | null;
        const inside = focused && host.contains(focused);
        parent.appendChild(host);
        // 只修复DOM重挂造成的失焦；用户/站点已经聚焦外部控件时保留其选择。
        if (inside && focused.isConnected && (!doc.activeElement || doc.activeElement === doc.body)) focused.focus({preventScroll: true});
    };
    const restoreFrame = () => {
        if (!renderFrame) return;
        moveHost(player);
        renderFrame.remove(); renderFrame = undefined;
    };
    const syncRenderParent = () => {
        const scope = scopeForPlayer(), rect = player.getBoundingClientRect();
        const width = player.clientWidth || rect.width, height = player.clientHeight || rect.height;
        if (scope === player || width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) {restoreFrame(); moveHost(player); return;}
        if (!renderFrame) {
            renderFrame = doc.createElement('div');
            renderFrame.className = 'fluent-read-video-learning-frame fluent-read-video-ui notranslate';
            renderFrame.setAttribute('data-fluent-read-ui', 'video-subtitle'); renderFrame.setAttribute('translate', 'no');
            // 自有透明frame高于原生控件但低于菜单；只由面板内部现有section接收指针。
            for (const [name, value] of Object.entries({position: 'absolute', left: '0', top: '0', margin: '0', padding: '0', border: '0',
                'box-sizing': 'border-box', 'pointer-events': 'none', 'z-index': '2147483645', 'transform-origin': '0 0', overflow: 'visible'})) renderFrame.style.setProperty(name, value, 'important');
        }
        if (renderFrame.parentElement !== scope) {
            // 先撤回原宿主，移动空frame，避免frame整体迁移让内部输入焦点无证据地丢失。
            moveHost(player); scope.appendChild(renderFrame);
        }
        renderFrame.style.setProperty('width', `${width}px`, 'important'); renderFrame.style.setProperty('height', `${height}px`, 'important');
        renderFrame.style.setProperty('transform', 'none', 'important');
        const base = renderFrame.getBoundingClientRect();
        if (base.width <= 0 || base.height <= 0) {restoreFrame(); return;}
        const sx = base.width / width, sy = base.height / height;
        renderFrame.style.setProperty('transform', `translate(${(rect.left - base.left) / sx}px, ${(rect.top - base.top) / sy}px) scale(${rect.width / base.width}, ${rect.height / base.height})`, 'important');
        moveHost(renderFrame);
    };
    const readBounds = () => {
        const rect = player.getBoundingClientRect();
        const width = player.clientWidth || rect.width;
        const height = player.clientHeight || rect.height;
        const panelRect = host.getBoundingClientRect();
        const scaleX = rect.width && width ? rect.width / width : 1;
        const scaleY = rect.height && height ? rect.height / height : 1;
        return {width, height, panelWidth: Math.min(appearance.width, Math.max(0, width - GAP * 2)),
            panelHeight: Math.min(panelRect.height / scaleY, Math.max(0, height - GAP - CONTROLS)), scaleX, scaleY};
    };
    const paint = () => {
        frame = undefined;
        if (!active) return;
        syncRenderParent();
        const bounds = readBounds();
        if (drag && pointer) {
            const travelX = Math.max(0, bounds.width - GAP * 2 - bounds.panelWidth);
            const travelY = Math.max(0, bounds.height - GAP - CONTROLS - bounds.panelHeight);
            dragged = {
                x: travelX ? clamp((drag.left - GAP + (pointer.x - drag.x) / drag.scaleX) / travelX, 0, 1) : 0,
                y: travelY ? clamp((drag.top - GAP + (pointer.y - drag.y) / drag.scaleY) / travelY, 0, 1) : 0,
            };
            options.onDragPosition(dragged);
        }
        const next = getVideoLearningPlacement({playerWidth: bounds.width, playerHeight: bounds.height,
            panelWidth: bounds.panelWidth, panelHeight: bounds.panelHeight, position: appearance.position, dragged});
        Object.assign(host.style, {left: `${next.left}px`, top: `${next.top}px`, right: 'auto', bottom: 'auto', overflow: 'visible',
            width: `${bounds.panelWidth}px`, maxHeight: `${next.maxHeight}px`});
        host.style.setProperty('--fluent-read-video-learning-max-height', `${next.maxHeight}px`);
        host.dataset.compact = String(next.compact || appearance.layout === 'compact');
        // 固定操作区在此高度内会挤空正文；仅真实可用高度决定整卡滚动，不受用户密度偏好影响。
        host.dataset.shortHeight = String(next.maxHeight <= 240);
    };
    const schedule = () => { if (active && frame === undefined) frame = win.requestAnimationFrame(paint); };
    const stopDrag = () => { drag = undefined; pointer = undefined; delete host.dataset.dragging; };
    const onDown = (event: PointerEvent) => {
        const target = event.target as Element;
        if (event.button !== 0 || !target.closest?.('[data-learning-drag-handle]') || target.closest('button,input,textarea,select,a,summary')) return;
        const bounds = readBounds();
        const current = getVideoLearningPlacement({playerWidth: bounds.width, playerHeight: bounds.height,
            panelWidth: bounds.panelWidth, panelHeight: bounds.panelHeight, position: appearance.position, dragged});
        drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: current.left, top: current.top,
            scaleX: bounds.scaleX, scaleY: bounds.scaleY};
        host.dataset.dragging = 'true';
        event.preventDefault(); event.stopPropagation();
    };
    const onMove = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        pointer = {x: event.clientX, y: event.clientY}; schedule();
        event.preventDefault(); event.stopPropagation();
    };
    const onUp = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        if (frame !== undefined) { win.cancelAnimationFrame(frame); paint(); }
        stopDrag();
    };
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : undefined;
    observer?.observe(player); observer?.observe(host);
    host.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onUp, true);
    win.addEventListener('resize', schedule);
    const destroy = () => {
        if (!active) return;
        active = false;
        if (frame !== undefined) win.cancelAnimationFrame(frame);
        observer?.disconnect(); stopDrag();
        host.removeEventListener('pointerdown', onDown, true);
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onUp, true);
        win.removeEventListener('resize', schedule);
        restoreFrame();
    };
    // 首次测量失败时placement尚未交给host，必须自行回收已创建的frame和订阅。
    try {paint();} catch (cause) {destroy(); throw cause;}
    return {
        syncPlayer(next) {
            if (!active) return;
            if (next !== player) { observer?.unobserve(player); player = next; observer?.observe(player); stopDrag(); }
            syncRenderParent();
            schedule();
        },
        isConnected(expected) {
            return active && expected === player && player.isConnected && host.isConnected && (host.parentElement === player
                || Boolean(renderFrame && host.parentElement === renderFrame && renderFrame.parentElement === scopeForPlayer()));
        },
        setAppearance(next) {
            if (!active) return;
            if (appearance.position !== next.position) { dragged = undefined; options.onDragPosition(undefined); stopDrag(); }
            appearance = next; schedule();
        },
        destroy,
    };
}

/** composition root 注入配置端口；关闭重开仍保留本页拖动位置，配置通知仅在外观变化时触发布局。 */
export function createVideoLearningPlacementOwner(read: () => unknown, subscribe: (listener: () => void) => () => void): {
    place(host: HTMLElement, player: HTMLElement): {syncPlayer(player: HTMLElement): void; isConnected(player: HTMLElement): boolean; destroy(): void};
    dispose(): void;
} {
    let active = true;
    let appearance = normalizeVideoSentenceLearningAppearance(read());
    let dragged: VideoLearningDragPosition | undefined;
    let current: ReturnType<typeof createVideoSentenceLearningPlacement> | undefined;
    const unsubscribe = subscribe(() => {
        if (!active) return;
        const next = normalizeVideoSentenceLearningAppearance(read());
        if (JSON.stringify(next) !== JSON.stringify(appearance)) {
            if (next.position !== appearance.position) dragged = undefined;
            appearance = next; current?.setAppearance(next);
        }
    });
    return {
        place(host, player) {
            if (!active) return {syncPlayer() {}, isConnected: () => false, destroy() {}};
            current?.destroy();
            const placement = createVideoSentenceLearningPlacement({host, player, appearance,
                initialPosition: dragged, onDragPosition: position => { dragged = position; }});
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
