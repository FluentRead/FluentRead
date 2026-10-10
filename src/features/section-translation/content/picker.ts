/**
 * @file src/features/section-translation/content/picker.ts
 * 文件职责：实现局部翻译的区域选择模式，稳定预览鼠标下的内容块，点击锁定后用可见按钮调整并确认翻译或恢复的区域，并在选择期间拦截网页自身的点击与悬停反应。
 * 主要内容：在封闭 Shadow Root 中创建高亮框、自然语言范围标签与固定操作条；用边界容差和短暂稳定窗口消除选区抖动，点击锁定后保持区域，按钮与方向键调整范围；识别封闭组件重定向到宿主的按键，操作条焦点不经过网页输入保护；按每帧 150 步预算发现开放 ShadowRoot，动态插入只扫描新增子树，换选与退出取消扫描；原文预览仅在换区或正文变更时重新读取，区域盘点延迟合并；观察正文及布局、保护属性，布局变化时立即按静止指针刷新预览而锁定范围保持不变，隐藏或失效选区解除锁定，排除自身浮层避免观察反馈；确认前刷新区域状态与可见盒子；确认按钮或 Enter 执行、Esc/右键/关闭按钮/页面隐藏退出；确认后短暂收束动画再移除界面。
 * 模块边界：本模块只处理手势、高亮和选择生命周期，所有事件先校验 isTrusted；区域判定规则来自 ../core，区域盘点、翻译和提示文案由调用方注入，不直接发起翻译、不读取配置存储。
 */
import pickerStyles from './picker.css?inline';
import {getComposedParent} from '@/src/core/translation/public';
import {
    describeSectionScope,
    sectionSourcePreview,
    expandSectionElement,
    isSectionPickerUi,
    resolveSectionElement,
    resolveSectionLabel,
    type SectionGeometry,
    type SectionLabelSummary,
    type SectionRect,
} from '../core';

export interface SectionPickerPoint {
    readonly x: number;
    readonly y: number;
}

export interface SectionPickerOptions {
    /** 进入选择模式时已知的指针位置；快捷键进入时可立即高亮鼠标下的区域。 */
    initialPoint?: SectionPickerPoint | null;
    /** 盘点区域状态，决定标签显示翻译、恢复原文还是无可翻译内容。 */
    inspect(element: Element): SectionLabelSummary;
    /** 用户确认区域后调用；此时选择模式已经退出，网页恢复正常交互。 */
    onPick(element: Element): void;
    /** 界面文案解析，按当前界面语言返回文字。 */
    text(key: string, params?: Readonly<Record<string, string | number>>): string;
    /** 选择期间再次按下进入快捷键即退出。 */
    isExitHotkey?(event: KeyboardEvent): boolean;
    /** 焦点在输入场景时方向键与 Enter 留给网页。 */
    isEditing?(event: KeyboardEvent): boolean;
}

export const SECTION_PICKER_HOST_ATTRIBUTE = 'section-picker';
const INSPECT_DELAY_MS = 90;
const TARGET_SETTLE_MS = 80;
const POINTER_TOLERANCE = 6;
const CONFIRM_ANIMATION_MS = 320;
const TOPMOST_NOTICE_MS = 1200;
const LABEL_GAP = 6;
/** 高亮框向外留出的距离，避免边框压在区域边缘的文字上。 */
const BOX_OUTSET = 3;
const VIEWPORT_MARGIN = 4;
const MAX_SHADOW_DEPTH = 16;
const SHADOW_SCAN_STEPS_PER_FRAME = 150;
const RECT_KEYS = ['left', 'top', 'width', 'height'] as const;
/** 只监听会改变布局、可见性或原文保护的属性，避免任意 data-* 计数驱动整页重绘。 */
const TARGET_OBSERVATION: MutationObserverInit = {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'translate', 'contenteditable', 'lang', 'dir', 'slot'],
};

/** 选择期间这些指针事件不交给网页，避免链接跳转、按钮触发、拖拽或划词浮层。 */
const INTERCEPTED_MOUSE_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;
/** pointerdown 只停止传播、不取消默认行为，让触屏仍能滚动页面。 */
const INTERCEPTED_POINTER_EVENTS = ['pointerdown', 'pointerup'] as const;
/** 悬停卡片、下拉菜单等网页悬停反应会遮挡目标区域，选择期间一并屏蔽。 */
const SUPPRESSED_HOVER_EVENTS = ['pointerover', 'mouseover'] as const;

const geometry: SectionGeometry = {
    display(element) {
        try {
            return element.ownerDocument.defaultView!.getComputedStyle(element).display;
        } catch {
            // 取不到计算样式（例如元素所在文档没有视图）时按块级处理，不因此丢失可选区域。
            return '';
        }
    },
    rect: (element) => element.getBoundingClientRect(),
};

interface PickerSession {
    dispose(confirmed: boolean): void;
}

let activeSession: PickerSession | null = null;

export function isSectionPickerActive(): boolean {
    return activeSession !== null;
}

/** 退出选择模式且不做任何翻译；未处于选择模式时无副作用。 */
export function stopSectionPicker(): void {
    activeSession?.dispose(false);
}

/** 进入选择模式；已在选择中时保持原状态并返回 true。 */
export function startSectionPicker(options: SectionPickerOptions): boolean {
    if (activeSession) return true;
    if (!document.documentElement) return false;
    activeSession = createPickerSession(options);
    return true;
}

function applyHostStyles(host: HTMLElement): void {
    // 宿主页样式不能把浮层放回文档流、截断或让它接收指针；外观细节留在 Shadow Root。
    const importantStyles: Record<string, string> = {
        display: 'block',
        position: 'fixed',
        top: '0',
        left: '0',
        width: '0',
        height: '0',
        margin: '0',
        padding: '0',
        border: '0',
        overflow: 'visible',
        opacity: '1',
        visibility: 'visible',
        transform: 'none',
        'pointer-events': 'none',
        'z-index': '2147483647',
    };
    Object.entries(importantStyles).forEach(([property, value]) => host.style.setProperty(property, value, 'important'));
}

function createElement(tag: string, className: string, text?: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function containsPoint(rect: SectionRect, point: SectionPickerPoint, tolerance = 0): boolean {
    return point.x >= rect.left - tolerance && point.x <= rect.left + rect.width + tolerance
        && point.y >= rect.top - tolerance && point.y <= rect.top + rect.height + tolerance;
}

function hasVisibleBox(element: Element, rect: SectionRect): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
        // visibility 可从祖先继承，而且 hidden/collapse 仍可能保留非零布局盒子。
        const visibility = element.ownerDocument.defaultView!.getComputedStyle(element).visibility;
        return visibility !== 'hidden' && visibility !== 'collapse';
    } catch {
        // 与区域几何端口一致：旧文档无法读取样式时保留有尺寸的选区。
        return true;
    }
}

/** DOM contains 不穿过 ShadowRoot；沿组合祖先判断内容归属，并限制恶意超深树。 */
function containsContent(root: Element, node: Node): boolean {
    let current: Element | null = node.nodeType === 1 ? node as Element
        : node.parentElement ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
    for (let depth = 0; current && depth < 512; depth += 1) {
        if (current === root) return true;
        current = getComposedParent(current);
    }
    return false;
}

const scheduleFrame = (callback: () => void): number => typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);

const cancelFrame = (handle: number): void => {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
};

function createPickerSession(options: SectionPickerOptions): PickerSession {
    const controller = new AbortController();
    const {signal} = controller;
    const previousFocus = document.activeElement as HTMLElement | null;

    // Step 1: 创建封闭 Shadow Root 浮层；网页脚本无法读取或改写其中的界面。
    const host = document.createElement('fluent-read-section-picker');
    host.setAttribute('data-fluent-read-ui', SECTION_PICKER_HOST_ATTRIBUTE);
    host.setAttribute('translate', 'no');
    applyHostStyles(host);
    const shadow = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = pickerStyles;
    const box = createElement('div', 'fr-section-box');
    const label = createElement('div', 'fr-section-label');
    label.setAttribute('aria-hidden', 'true');
    const labelAction = createElement('span', 'fr-section-label-action');
    const labelMeta = createElement('span', 'fr-section-label-meta');
    label.append(labelAction, labelMeta);
    const bar = createElement('div', 'fr-section-bar');
    bar.tabIndex = -1;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', options.text('sectionTranslation.picker.title'));
    const heading = createElement('div', 'fr-section-bar-heading');
    const instruction = createElement('span', 'fr-section-bar-instruction', options.text('sectionTranslation.picker.preview'));
    instruction.setAttribute('role', 'status');
    instruction.setAttribute('aria-live', 'polite');
    const preview = createElement('div', 'fr-section-bar-preview');
    const actions = createElement('div', 'fr-section-bar-actions');
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', options.text('sectionTranslation.picker.title'));
    const button = (name: string): HTMLButtonElement => {
        const result = createElement('button', `fr-section-button fr-section-${name}`, options.text(`sectionTranslation.picker.${name}`)) as HTMLButtonElement;
        result.type = 'button';
        return result;
    };
    const larger = button('expand');
    const smaller = button('shrink');
    const reselect = button('reselect');
    const confirm = button('confirm');
    const close = createElement('button', 'fr-section-bar-close', '×') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', options.text('sectionTranslation.picker.close'));
    close.title = options.text('sectionTranslation.picker.close');
    heading.append(createElement('strong', 'fr-section-bar-title', options.text('sectionTranslation.picker.title')), instruction, close);
    actions.append(larger, smaller, reselect, confirm);
    bar.append(heading, preview, actions, createElement('span', 'fr-section-bar-keys', options.text('sectionTranslation.picker.keys')));
    shadow.append(style, box, label, bar);
    document.documentElement.appendChild(host);

    let pointer: SectionPickerPoint | null = options.initialPoint ?? null;
    let target: Element | null = null;
    let locked = false;
    let pendingTarget: Element | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    /** 当前范围链：首项是鼠标下的基础区域，之后每项是一次方向键扩大的结果。 */
    let expansion: Element[] = [];
    let targetChanged = false;
    let targetDirty = pointer !== null;
    /** 滚动或缩放触发的绘制要立即贴合内容，不能沿用换选区域时的过渡动画。 */
    let snapNextRender = false;
    let frame = 0;
    let rendering = false;
    let renderedTarget: Element | null = null;
    let renderedRect: SectionRect | null = null;
    let inspectTimer: ReturnType<typeof setTimeout> | undefined;
    let topmostTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const summaries = new WeakMap<Element, SectionLabelSummary>();
    let previewTarget: Element | null = null;
    let previewDirty = true;
    let shadowScanFrame = 0;
    let shadowScans: {root: Node; walker: TreeWalker; current: Element | null}[] = [];
    let shadowScanIndex = 0;
    let queuedShadowScans = new WeakSet<Node>();
    let observedShadowRoots = new WeakSet<ShadowRoot>();

    /** 事件落在本浮层或 FluentRead 其他界面（通知、悬浮球等）上时交还给它们自己处理。 */
    const isExtensionUiEvent = (event: Event): boolean => typeof event.composedPath === 'function'
        && event.composedPath().some((node) => node === host
            || ((node as Node).nodeType === 1 && isSectionPickerUi(node as Element)));

    function consume(event: Event, preventDefault = true): void {
        if (preventDefault) event.preventDefault();
        event.stopImmediatePropagation();
    }

    /** 逐层进入可读取的 ShadowRoot，找到指针下最深的网页元素。 */
    function elementAtPoint(point: SectionPickerPoint): Element | null {
        let element = document.elementFromPoint(point.x, point.y);
        for (let depth = 0; element?.shadowRoot && depth < MAX_SHADOW_DEPTH; depth += 1) {
            const inner: Element | null = element.shadowRoot.elementFromPoint(point.x, point.y);
            if (!inner || inner === element) break;
            element = inner;
        }
        return element;
    }

    function setTone(tone: 'translate' | 'restore' | 'muted'): void {
        for (const element of [box, label]) {
            element.classList.toggle('tone-restore', tone === 'restore');
            element.classList.toggle('tone-muted', tone === 'muted');
        }
    }

    function updateControls(): void {
        const current = target?.isConnected ? target : null;
        const summary = current ? summaries.get(current) : undefined;
        host.setAttribute('data-selection-state', locked && current ? 'locked' : 'preview');
        instruction.textContent = options.text(locked && current ? 'sectionTranslation.picker.locked' : 'sectionTranslation.picker.preview');
        larger.disabled = !current || !expandSectionElement(current, geometry);
        smaller.disabled = !current || expansion.length <= 1;
        reselect.disabled = !locked;
        confirm.disabled = !locked || !summary || (summary.action !== 'translate' && summary.action !== 'restore');
        confirm.textContent = options.text(summary?.action === 'restore' ? 'sectionTranslation.picker.restore' : 'sectionTranslation.picker.confirm');
        confirm.classList.toggle('tone-restore', summary?.action === 'restore');
        // 锁定和标签计数只改动作，不改原文；避免每次更新控件都重复扫描当前子树。
        if (previewTarget !== current || previewDirty) {
            previewTarget = current;
            previewDirty = false;
            preview.textContent = current ? sectionSourcePreview(current) : '';
        }
        preview.hidden = !current;
    }

    function updateLabel(current: Element): void {
        updateControls();
        const summary = summaries.get(current);
        labelMeta.textContent = options.text(describeSectionScope(current));
        if (!summary) {
            setTone('translate');
            labelAction.textContent = options.text('sectionTranslation.label.inspecting');
            return;
        }
        const resolved = resolveSectionLabel(summary);
        labelAction.textContent = options.text(resolved.key, resolved.params);
        setTone(resolved.tone);
    }

    function scheduleInspect(refresh = false): void {
        // 动态计数等连续更新只合并到已经安排的盘点，不不断延后完成时间。
        if (refresh && inspectTimer !== undefined) return;
        if (inspectTimer !== undefined) clearTimeout(inspectTimer);
        inspectTimer = undefined;
        const current = target;
        if (!current) {
            updateControls();
            return;
        }
        updateLabel(current);
        if (summaries.has(current) && !refresh) return;
        // 快速划过时只盘点停下来的区域，避免每经过一个元素就遍历一次子树。
        inspectTimer = setTimeout(() => {
            inspectTimer = undefined;
            if (disposed || target !== current || !current.isConnected) return;
            summaries.set(current, options.inspect(current));
            // “已是最大范围”提示仍在显示时先保留提示，计时结束后再显示盘点结果。
            if (topmostTimer === undefined) updateLabel(current);
            scheduleRender();
        }, INSPECT_DELAY_MS);
    }

    function setTarget(next: Element | null): void {
        cancelShadowScanning();
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        target = next;
        previewDirty = true;
        if (next) resizeObserver?.observe(next);
        observeTarget();
        targetChanged = true;
        if (topmostTimer !== undefined) clearTimeout(topmostTimer);
        topmostTimer = undefined;
        scheduleInspect();
        // 缓存只负责即时反馈，重新回到旧区域也要刷新，避免旧的 empty 摘要禁用确认。
        if (next && summaries.has(next)) scheduleInspect(true);
        scheduleRender();
    }

    function cancelSettling(): void {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        settleTimer = undefined;
        pendingTarget = null;
    }

    function commitBase(base: Element | null): void {
        cancelSettling();
        expansion = base ? [base] : [];
        setTarget(base);
    }

    function refreshTarget(immediate = false): void {
        targetDirty = false;
        if (locked || !pointer) return;
        const hit = elementAtPoint(pointer);
        // 操作条上的悬停不改变选区，鼠标可以平稳移向范围按钮。
        if (hit === host || (hit && isSectionPickerUi(hit))) {
            cancelSettling();
            return;
        }
        const expanded = expansion.length > 1 ? expansion[expansion.length - 1] : null;
        if (expanded?.isConnected && containsPoint(geometry.rect(expanded), pointer)) {
            cancelSettling();
            return;
        }
        const base = resolveSectionElement(hit, geometry);
        if (base === target) {
            cancelSettling();
            return;
        }
        if (!immediate && target?.isConnected) {
            const rect = geometry.rect(target);
            if ((!base || !containsContent(target, base)) && containsPoint(rect, pointer, POINTER_TOLERANCE)) {
                cancelSettling();
                return;
            }
            // 只在同一新区域持续停留后换选；快速穿过嵌套容器或段落间隙时保留旧框。
            if (settleTimer !== undefined && pendingTarget === base) return;
            cancelSettling();
            pendingTarget = base;
            settleTimer = setTimeout(() => {
                settleTimer = undefined;
                if (disposed || locked) return;
                commitBase(base?.isConnected ? base : null);
            }, TARGET_SETTLE_MS);
            return;
        }
        commitBase(base);
    }

    function positionLabel(rect: SectionRect): void {
        label.classList.add('is-visible');
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const labelWidth = label.offsetWidth || 0;
        const labelHeight = label.offsetHeight || 0;
        const above = rect.top - BOX_OUTSET - labelHeight - LABEL_GAP;
        const top = above >= VIEWPORT_MARGIN
            ? above
            : Math.min(Math.max(rect.top + LABEL_GAP, VIEWPORT_MARGIN), window.innerHeight - labelHeight - VIEWPORT_MARGIN);
        const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - labelWidth - VIEWPORT_MARGIN));
        label.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }

    function render(): void {
        frame = 0;
        if (disposed) return;
        rendering = true;
        try {
            draw();
        } finally {
            rendering = false;
        }
    }

    function draw(): void {
        const previousTarget = target;
        let rect = target?.isConnected ? geometry.rect(target) : null;
        if (target && (!rect || !hasVisibleBox(target, rect))) {
            // 网页替换或隐藏了内容：丢弃失效区域，不能保留 6px 空框或确认不可见内容。
            locked = false;
            commitBase(null);
            targetDirty = true;
        }
        if (targetDirty) refreshTarget(snapNextRender);
        if (!target) {
            renderedTarget = null;
            renderedRect = null;
            box.classList.remove('is-visible');
            label.classList.remove('is-visible');
            updateControls();
            return;
        }
        rect = target === previousTarget && rect ? rect : geometry.rect(target);
        renderedTarget = target;
        renderedRect = rect;
        // 只为换选区域过渡颜色；位置和尺寸始终立即贴合真实盒子。
        if (targetChanged || snapNextRender) {
            box.classList.toggle('is-following', targetChanged && !snapNextRender && box.classList.contains('is-visible'));
        }
        targetChanged = false;
        snapNextRender = false;
        box.style.transform = `translate(${Math.round(rect.left - BOX_OUTSET)}px, ${Math.round(rect.top - BOX_OUTSET)}px)`;
        box.style.width = `${Math.round(rect.width + BOX_OUTSET * 2)}px`;
        box.style.height = `${Math.round(rect.height + BOX_OUTSET * 2)}px`;
        box.classList.add('is-visible');
        positionLabel(rect);
    }

    function scheduleRender(): void {
        // 绘制过程中切换区域会就地完成本帧，不再额外排队一帧。
        if (disposed || frame || rendering) return;
        frame = scheduleFrame(render);
    }

    function showTopmostNotice(): void {
        labelAction.textContent = options.text('sectionTranslation.label.topmost');
        scheduleRender();
        if (topmostTimer !== undefined) clearTimeout(topmostTimer);
        topmostTimer = setTimeout(() => {
            topmostTimer = undefined;
            updateLabel(target!);
            scheduleRender();
        }, TOPMOST_NOTICE_MS);
    }

    function expand(): void {
        if (!target?.isConnected) return;
        cancelSettling();
        const next = expandSectionElement(target, geometry);
        if (!next) {
            showTopmostNotice();
            return;
        }
        expansion.push(next);
        setTarget(next);
    }

    function shrink(): void {
        if (expansion.length <= 1) return;
        cancelSettling();
        expansion.pop();
        setTarget(expansion[expansion.length - 1]!);
    }

    function lockSelection(): void {
        if (!target?.isConnected) return;
        cancelSettling();
        if (!locked) {
            locked = true;
            observeTarget();
        }
        // 明确选中后把键盘留在选择器，避免被此前仍聚焦的网页输入框接管 Enter。
        bar.focus?.({preventScroll: true});
        summaries.delete(target);
        scheduleInspect();
        scheduleRender();
    }

    function pick(element: Element): void {
        if (!element.isConnected || !hasVisibleBox(element, geometry.rect(element))) {
            locked = false;
            commitBase(null);
            return;
        }
        // 确认时重新盘点，避免页面动态更新后仍执行过时的恢复或翻译提示。
        const summary = options.inspect(element);
        summaries.set(element, summary);
        previewDirty = true;
        updateLabel(element);
        if (summary.action === 'empty' || summary.action === 'settled') return;
        dispose(true);
        options.onPick(element);
    }

    function dispose(confirmed: boolean): void {
        if (disposed) return;
        disposed = true;
        if (activeSession === session) activeSession = null;
        controller.abort();
        if (shadow.activeElement && previousFocus?.isConnected) previousFocus.focus?.({preventScroll: true});
        mutationObserver?.disconnect();
        resizeObserver?.disconnect();
        cancelShadowScanning();
        cancelSettling();
        if (frame) cancelFrame(frame);
        if (inspectTimer !== undefined) clearTimeout(inspectTimer);
        if (topmostTimer !== undefined) clearTimeout(topmostTimer);
        if (!confirmed || !box.classList.contains('is-visible')) {
            host.remove();
            return;
        }
        // 确认后保留高亮框做一次短暂收束，让用户看清选中的范围；此时已不再拦截网页事件。
        bar.classList.add('is-hidden');
        label.classList.remove('is-visible');
        box.classList.remove('is-following');
        box.classList.add('is-confirmed');
        setTimeout(() => host.remove(), CONFIRM_ANIMATION_MS);
    }

    // Step 2: 在 window 捕获阶段接管指针、键盘和视口事件；所有监听随 signal 一次移除。
    const listen = <K extends keyof WindowEventMap>(
        type: K,
        listener: (event: WindowEventMap[K]) => void,
        passive = false,
    ): void => window.addEventListener(type, listener, {capture: true, passive, signal});

    listen('pointermove', (event) => {
        if (!event.isTrusted) return;
        pointer = {x: event.clientX, y: event.clientY};
        if (locked) return;
        targetDirty = true;
        scheduleRender();
    }, true);
    for (const type of INTERCEPTED_POINTER_EVENTS) {
        listen(type, (event) => {
            if (!event.isTrusted) return;
            if (!isExtensionUiEvent(event)) consume(event, false);
        });
    }
    for (const type of INTERCEPTED_MOUSE_EVENTS) {
        listen(type, (event) => {
            if (!event.isTrusted) return;
            if (isExtensionUiEvent(event)) return;
            consume(event);
            if (event.type !== 'click' || event.button !== 0) return;
            // 点击当前高亮边缘时锁定用户看到的范围；触屏或远处点击按落点即时解析。
            pointer = {x: event.clientX, y: event.clientY};
            if (locked) return;
            const clicked = resolveSectionElement(elementAtPoint(pointer), geometry);
            if (!target?.isConnected || (clicked !== target && clicked && containsContent(target, clicked))
                || !containsPoint(geometry.rect(target), pointer, POINTER_TOLERANCE)) refreshTarget(true);
            lockSelection();
        });
    }
    for (const type of SUPPRESSED_HOVER_EVENTS) {
        listen(type, (event) => {
            if (!event.isTrusted) return;
            if (!isExtensionUiEvent(event)) event.stopImmediatePropagation();
        });
    }
    listen('contextmenu', (event) => {
        if (!event.isTrusted) return;
        if (isExtensionUiEvent(event)) return;
        consume(event);
        dispose(false);
    });
    listen('keydown', (event) => {
        if (!event.isTrusted) return;
        if (event.key === 'Escape' || options.isExitHotkey?.(event) === true) {
            consume(event);
            dispose(false);
            return;
        }
        // 封闭 ShadowRoot 的按键在 window 上只暴露 host，通用输入保护会把它误判为不透明编辑器。
        // 自己的工具条和按钮都支持范围键；按钮保留原生 Enter 激活，网页及其他扩展界面仍让行。
        const isPickerEvent = typeof event.composedPath === 'function' && event.composedPath().includes(host);
        if (isPickerEvent) {
            if (event.key === 'Enter' && shadow.activeElement !== bar) return;
        } else if (isExtensionUiEvent(event) || options.isEditing?.(event) === true) return;
        if (event.key === 'ArrowUp') {
            consume(event);
            expand();
        } else if (event.key === 'ArrowDown') {
            consume(event);
            shrink();
        } else if (event.key === 'Enter' && target) {
            cancelSettling();
            consume(event);
            pick(target);
        }
    });
    const handleViewportChange = (event: Event): void => {
        if (!event.isTrusted) return;
        targetDirty = true;
        snapNextRender = true;
        scheduleRender();
    };
    listen('scroll', handleViewportChange, true);
    listen('resize', handleViewportChange, true);
    document.addEventListener('visibilitychange', (event) => {
        if (!event.isTrusted) return;
        if (document.visibilityState === 'hidden') dispose(false);
    }, {signal});
    const onButton = (element: HTMLButtonElement, action: () => void): void => {
        element.addEventListener('click', (event) => {
            if (!event.isTrusted || element.disabled) return;
            consume(event);
            action();
        }, {signal});
    };
    onButton(larger, () => {lockSelection(); expand();});
    onButton(smaller, () => {lockSelection(); shrink();});
    onButton(reselect, () => {
        locked = false;
        cancelSettling();
        expansion = [];
        setTarget(null);
        updateControls();
        scheduleRender();
    });
    onButton(confirm, () => {if (target) pick(target);});
    // 锁定后网页仍可能替换选中的节点；立即解除失效选区，禁止把旧节点交给翻译引擎。
    const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
        if (disposed) return;
        // 高亮渲染会改宿主属性；自有节点不可反过来触发下一次渲染或区域盘点。
        const contentRecords = records.filter(record => !containsContent(host, record.target));
        if (contentRecords.length === 0) return;
        // 区域外插入横幅也会移动锁定内容，因此任何文档结构变化都重新贴合高亮。
        targetDirty = !locked;
        snapNextRender = true;
        scheduleRender();
        if (!target) return;
        if (!target.isConnected) {
            locked = false;
            commitBase(null);
            targetDirty = true;
            scheduleRender();
        } else if (contentRecords.some(record => containsContent(target!, record.target)
            || (record.type === 'attributes' && record.target.nodeType === 1 && containsContent(record.target as Element, target!)))) {
            if (locked) {
                // 不重新扫描锁定范围；只发现已插入子树中的新宿主和嵌套开放根。
                for (const record of contentRecords) {
                    if (record.type !== 'childList' || !containsContent(target, record.target)) continue;
                    for (const added of record.addedNodes) enqueueShadowScan(added);
                }
                if (!shadowScanFrame) scanShadowRoots();
            }
            // 保留上一份可执行摘要直到新盘点完成；确认仍会同步复核，动态正文不会让按钮一直禁用。
            previewDirty = true;
            scheduleInspect(true);
            scheduleRender();
        }
    }) : null;

    function cancelShadowScanning(): void {
        if (shadowScanFrame) cancelFrame(shadowScanFrame);
        shadowScanFrame = 0;
        shadowScans = [];
        shadowScanIndex = 0;
        queuedShadowScans = new WeakSet<Node>();
        observedShadowRoots = new WeakSet<ShadowRoot>();
    }

    function enqueueShadowScan(root: Node): void {
        if (!mutationObserver || !target || !containsContent(target, root) || queuedShadowScans.has(root)) return;
        // 文本变更只刷新摘要，不创建扫描器；遍历器只访问元素，不递归进入影子树。
        if (root.nodeType !== 1 && root.nodeType !== 11) return;
        queuedShadowScans.add(root);
        const walker = document.createTreeWalker(root, 1);
        shadowScans.push({root, walker, current: root.nodeType === 1 ? root as Element : walker.nextNode() as Element | null});
    }

    function scanShadowRoots(): void {
        shadowScanFrame = 0;
        if (disposed || !locked || !target?.isConnected) return;
        let remaining = SHADOW_SCAN_STEPS_PER_FRAME;
        let found = false;
        let checkedRoot: Node | undefined;
        while (shadowScanIndex < shadowScans.length && remaining > 0) {
            const scan = shadowScans[shadowScanIndex]!;
            const element = scan.current;
            remaining -= 1;
            // 同一同步批次内只检查一次归属；下一帧继续时仍复核网页是否移走了子树。
            if (!element || (checkedRoot !== scan.root && !containsContent(target, scan.root))) {
                queuedShadowScans.delete(scan.root);
                shadowScanIndex += 1;
                continue;
            }
            checkedRoot = scan.root;
            const root = element.shadowRoot;
            if (root && !observedShadowRoots.has(root)) {
                observedShadowRoots.add(root);
                mutationObserver!.observe(root, TARGET_OBSERVATION);
                enqueueShadowScan(root);
                found = true;
            }
            scan.current = scan.walker.nextNode() as Element | null;
            if (!scan.current) {
                queuedShadowScans.delete(scan.root);
                shadowScanIndex += 1;
            }
        }
        if (found) scheduleInspect(true);
        if (shadowScanIndex < shadowScans.length) shadowScanFrame = scheduleFrame(scanShadowRoots);
        else {
            shadowScans = [];
            shadowScanIndex = 0;
        }
    }

    function observeTarget(): void {
        mutationObserver?.observe(document.documentElement, TARGET_OBSERVATION);
        // 文档观察不会穿透 ShadowRoot，额外监听目标所在树，覆盖同尺寸内容替换与祖先移除。
        const root = target?.getRootNode();
        if (root?.nodeType === 11) mutationObserver?.observe(root, TARGET_OBSERVATION);
        // 锁定后才发现范围内的开放 ShadowRoot；大范围分帧完成，不阻塞一次点击。
        if (locked && target) {
            enqueueShadowScan(target);
            scanShadowRoots();
        }
    }
    observeTarget();
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (disposed) return;
        // observe 后的初始通知不代表网页刚发生布局变化，不能因此跳过正在等待的 hover 稳定窗。
        if (target?.isConnected && target === renderedTarget && renderedRect) {
            const currentRect = geometry.rect(target);
            if (RECT_KEYS.every(key => currentRect[key] === renderedRect![key])) return;
        }
        targetDirty = !locked;
        snapNextRender = true;
        scheduleRender();
    }) : null;
    updateControls();
    close.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        consume(event);
        dispose(false);
    }, {signal});

    const session: PickerSession = {dispose};
    scheduleRender();
    return session;
}
