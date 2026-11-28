/**
 * @file src/features/section-translation/content/picker.ts
 * 文件职责：实现局部翻译的区域选择模式，稳定预览鼠标下的内容块，支持单击锁定或按住左键划过多个区域，松开后用可见按钮调整并确认翻译或恢复，并在选择期间拦截网页自身的点击与悬停反应。
 * 主要内容：组合 pickerOverlay 封闭 Shadow UI 与 pickerShadowObserver 分帧影子树观察器，协调指针划选路径、悬停稳定窗、区域扩缩、记忆规则确认与单手势会话交接生命周期。
 * 模块边界：本模块只处理手势、高亮编排和选择生命周期，所有事件先校验 isTrusted；浮层 DOM 构建在 pickerOverlay.ts，ShadowRoot 增量扫描在 pickerShadowObserver.ts，区域判定规则来自 ../core，不直接发起翻译或读取配置存储。
 */

import {getComposedParent} from '@/src/core/translation/public';
import {claimPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';
import {
    describeSectionScope,
    expandSectionElement,
    isSectionPickerUi,
    resolveSectionElement,
    resolveSectionLabel,
    type SectionLabelSummary,
    type SectionRect,
} from '../core';
import {
    cancelFrame,
    containsContent,
    containsPoint,
    createOverlayElement,
    createPickerOverlay,
    elementAtPoint,
    hasVisibleBox,
    positionBox,
    positionLabel,
    RECT_KEYS,
    scheduleFrame,
    SECTION_PICKER_HOST_ATTRIBUTE,
    sectionGeometry as geometry,
    setText,
    toggleClass,
    type SectionPickerPoint,
} from './pickerOverlay';
import {createPickerShadowScanner, TARGET_OBSERVATION} from './pickerShadowObserver';

export {SECTION_PICKER_HOST_ATTRIBUTE, type SectionPickerPoint};

export interface SectionRememberChoice {
    readonly site: string;
    readonly mode: 'auto' | 'remind';
}

export interface SectionPickerOptions {
    /** 进入选择模式时已知的指针位置；快捷键进入时可立即高亮鼠标下的区域。 */
    initialPoint?: SectionPickerPoint | null;
    /** 盘点区域状态，决定标签显示翻译、恢复原文还是无可翻译内容。 */
    inspect(element: Element | readonly Element[]): SectionLabelSummary;
    /** 用户确认区域后调用；此时选择模式已经退出，网页恢复正常交互。 */
    onPick(element: Element | readonly Element[]): void;
    /** 当前地址可记忆的网站及路径范围；无此端口时维持一次性选择。 */
    rememberScopes?: {readonly site: string; readonly path: string};
    /** 仅成功持久化后退出；失败或旧选区结果保留当前选择供重试。 */
    onRemember?(element: Element | readonly Element[], choice: SectionRememberChoice): Promise<boolean>;
    /** 界面文案解析，按当前界面语言返回文字。 */
    text(key: string, params?: Readonly<Record<string, string | number>>): string;
    /** 选择期间再次按下进入快捷键即退出。 */
    isExitHotkey?(event: KeyboardEvent): boolean;
    /** 焦点在输入场景时方向键与 Enter 留给网页。 */
    isEditing?(event: KeyboardEvent): boolean;
}

const INSPECT_DELAY_MS = 90;
const TARGET_SETTLE_MS = 80;
const POINTER_TOLERANCE = 6;
const CONFIRM_ANIMATION_MS = 320;
const TOPMOST_NOTICE_MS = 1200;

/** 选择期间这些指针事件不交给网页，避免链接跳转、按钮触发、拖拽或划词浮层。 */
const INTERCEPTED_MOUSE_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;
/** 悬停卡片、下拉菜单等网页悬停反应会遮挡目标区域，选择期间一并屏蔽。 */
const SUPPRESSED_HOVER_EVENTS = ['pointerover', 'mouseover'] as const;

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

function createPickerSession(options: SectionPickerOptions): PickerSession {
    const controller = new AbortController();
    const {signal} = controller;
    const previousFocus = document.activeElement as HTMLElement | null;

    // Step 1: 创建封闭 Shadow Root 浮层；网页脚本无法读取或改写其中的界面。
    const {
        host, shadow, box, label, labelAction, labelMeta, bar, heading, instruction,
        larger, smaller, reselect, confirm, close, remember, rememberCheckbox,
        rememberFields, rememberScope, rememberMode, rememberAddress, rememberStatus,
    } = createPickerOverlay(options.text);

    let pointer: SectionPickerPoint | null = options.initialPoint ?? null;
    let target: Element | null = null;
    let locked = false;
    /** 划选只保存实际经过的独立区域，不把它们的公共祖先当成隐式选区。 */
    let swept: Element[] = [];
    let sweepExpansion: Element[][] = [];
    let drag: {id: number; start: SectionPickerPoint; last: SectionPickerPoint; points: SectionPickerPoint[]; anchor: Element | null; moved: boolean} | null = null;
    let suppressDragClick = false;
    const extraBoxes: HTMLElement[] = [];
    let pendingTarget: Element | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settleRevision = 0;
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
    let remembering = false;
    let rememberRevision = 0;
    const summaries = new WeakMap<Element, SectionLabelSummary>();

    /** 事件落在本浮层或 FluentRead 其他界面（通知、悬浮球等）上时交还给它们自己处理。 */
    const isExtensionUiEvent = (event: Event): boolean => typeof event.composedPath === 'function'
        && event.composedPath().some((node) => node === host
            || ((node as Node).nodeType === 1 && isSectionPickerUi(node as Element)));

    function consume(event: Event, preventDefault = true): void {
        if (preventDefault) event.preventDefault();
        event.stopImmediatePropagation();
    }

    function setTone(tone: 'translate' | 'restore' | 'muted'): void {
        for (const element of [box, label, ...extraBoxes]) {
            element.classList.toggle('tone-restore', tone === 'restore');
            element.classList.toggle('tone-muted', tone === 'muted');
        }
    }

    function selectedRoots(): Element[] {
        return swept.length ? swept : target ? [target] : [];
    }

    function selection(): Element | readonly Element[] {
        const roots = selectedRoots();
        return roots.length === 1 ? roots[0] : roots;
    }

    const shadowScanner = createPickerShadowScanner({
        getMutationObserver: () => mutationObserver,
        isActive: () => !disposed && locked && Boolean(target?.isConnected),
        getSelectedRoots: selectedRoots,
        onShadowRootDiscovered: () => scheduleInspect(true),
    });

    function setSwept(roots: Element[]): void {
        swept = roots;
        if (target) summaries.delete(target);
        if (roots[0]) summaries.delete(roots[0]);
        setTarget(roots[0] ?? null);
        for (const root of roots.slice(1)) resizeObserver?.observe(root);
    }

    function updateControls(): void {
        const current = target?.isConnected ? target : null;
        const summary = current ? summaries.get(current) : undefined;
        host.setAttribute('data-selection-state', drag?.moved ? 'dragging' : locked && current ? 'locked' : 'preview');
        host.setAttribute('data-selection-count', String(selectedRoots().length));
        const selectionLabel = summary ? resolveSectionLabel(summary) : undefined;
        setText(instruction, locked ? selectionLabel ? options.text(selectionLabel.key, selectionLabel.params)
            : options.text('sectionTranslation.label.inspecting') : options.text(drag?.moved ? 'sectionTranslation.picker.dragging' : 'sectionTranslation.picker.preview'));
        heading.classList.toggle('is-locked', locked && Boolean(current));
        larger.disabled = remembering || !current || (swept.length > 1 ? !swept.some(root => expandSectionElement(root, geometry)) : !expandSectionElement(current, geometry));
        smaller.disabled = remembering || !current || (swept.length > 0 ? sweepExpansion.length === 0 : expansion.length <= 1);
        reselect.disabled = remembering || !locked;
        confirm.disabled = remembering || !locked || !summary || (summary.action !== 'translate' && summary.action !== 'restore');
        const canRemember = Boolean(options.rememberScopes && options.onRemember && locked && summary?.action === 'translate');
        remember.hidden = !canRemember;
        rememberFields.hidden = !rememberCheckbox.checked;
        rememberAddress.hidden = !rememberCheckbox.checked;
        const scopesDiffer = options.rememberScopes?.path !== options.rememberScopes?.site;
        rememberScope.parentElement!.hidden = !scopesDiffer;
        rememberCheckbox.disabled = rememberScope.disabled = rememberMode.disabled = remembering;
        rememberStatus.classList.toggle('is-progress', remembering);
        const address = options.rememberScopes?.[rememberScope.value === 'site' ? 'site' : 'path'] ?? '';
        setText(rememberAddress, address);
        rememberScope.title = address;
        setText(confirm, options.text(remembering ? 'sectionTranslation.rules.saving' : summary?.action === 'restore'
            ? 'sectionTranslation.picker.restore' : canRemember && rememberCheckbox.checked
                ? 'sectionTranslation.rules.confirm' : 'sectionTranslation.picker.confirm'));
        confirm.classList.toggle('tone-restore', summary?.action === 'restore');
    }

    function updateLabel(current: Element): void {
        updateControls();
        const summary = summaries.get(current);
        setText(labelMeta, swept.length > 1
            ? options.text('sectionTranslation.scope.selected', {count: swept.length}) : options.text(describeSectionScope(current)));
        if (!summary) {
            setTone('translate');
            setText(labelAction, options.text(drag?.moved ? 'sectionTranslation.picker.dragging' : 'sectionTranslation.label.inspecting'));
            return;
        }
        const resolved = resolveSectionLabel(summary);
        setText(labelAction, options.text(resolved.key, resolved.params));
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
        // 划选过程中只显示范围与块数；松手后再统一盘点，避免连续改选反复遍历正文和闪换动作标签。
        if (drag?.moved) return;
        if (summaries.has(current) && !refresh) return;
        // 快速划过时只盘点停下来的区域，避免每经过一个元素就遍历一次子树。
        inspectTimer = setTimeout(() => {
            inspectTimer = undefined;
            if (disposed || target !== current || !current.isConnected) return;
            summaries.set(current, options.inspect(selection()));
            // “已是最大范围”提示仍在显示时先保留提示，计时结束后再显示盘点结果。
            if (topmostTimer === undefined) updateLabel(current);
            scheduleRender();
        }, INSPECT_DELAY_MS);
    }

    function setTarget(next: Element | null): void {
        shadowScanner.cancel();
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        rememberRevision += 1;
        remembering = false;
        rememberStatus.textContent = '';
        target = next;
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
        settleRevision += 1;
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        settleTimer = undefined;
        pendingTarget = null;
    }

    function commitBase(base: Element | null): void {
        cancelSettling();
        swept = [];
        sweepExpansion = [];
        expansion = base ? [base] : [];
        setTarget(base);
    }

    function refreshTarget(immediate = false): void {
        targetDirty = false;
        if (locked || drag?.moved || !pointer) return;
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
            const revision = settleRevision;
            settleTimer = setTimeout(() => {
                if (disposed || locked || revision !== settleRevision) return;
                settleTimer = undefined;
                // 指针可能已离开，但对应绘制帧尚未到达；旧稳定窗不能先闪出过时区域。
                const latestHit = pointer && elementAtPoint(pointer);
                if (latestHit === host || (latestHit && isSectionPickerUi(latestHit)) || resolveSectionElement(latestHit, geometry) !== base) {
                    cancelSettling();
                    targetDirty = true;
                    scheduleRender();
                    return;
                }
                commitBase(base?.isConnected ? base : null);
            }, TARGET_SETTLE_MS);
            return;
        }
        commitBase(base);
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
        flushDrag();
        // 校验与绘制共用本帧几何，跨帧仍实测，保留滚动、字体与宿主动画的正确位置。
        const rects = new Map<Element, SectionRect>();
        const rectFor = (element: Element): SectionRect => {
            let rect = rects.get(element);
            if (!rect) { rect = geometry.rect(element); rects.set(element, rect); }
            return rect;
        };
        if (swept.some(root => !root.isConnected || !hasVisibleBox(root, rectFor(root)))) {
            drag = null;
            locked = false;
            commitBase(null);
            targetDirty = true;
        }
        let rect = target?.isConnected ? rectFor(target) : null;
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
            toggleClass(box, 'is-visible', false);
            toggleClass(label, 'is-visible', false);
            extraBoxes.forEach(element => toggleClass(element, 'is-visible', false));
            updateControls();
            return;
        }
        rect = rectFor(target);
        renderedTarget = target;
        renderedRect = rect;
        const others = swept.filter(root => root !== target);
        while (extraBoxes.length < others.length) {
            const extra = createOverlayElement('div', 'fr-section-box');
            shadow.insertBefore(extra, label);
            extraBoxes.push(extra);
        }
        // 标签由 display:none 首次显示时先允许测量；其后全部读在边框写入之前，
        // 多选也不会在写完一个框后再测量下一个区域或标签而触发多次同步布局。
        toggleClass(label, 'is-visible', true);
        const otherRects = others.map(rectFor);
        const labelWidth = label.offsetWidth || 0;
        const labelHeight = label.offsetHeight || 0;
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = window.innerHeight;
        // 只为换选区域过渡颜色；位置和尺寸始终立即贴合真实盒子。
        if (targetChanged || snapNextRender) {
            toggleClass(box, 'is-following', targetChanged && !snapNextRender && box.classList.contains('is-visible'));
        }
        targetChanged = false;
        snapNextRender = false;
        positionBox(box, rect);
        toggleClass(box, 'is-visible', true);
        extraBoxes.forEach((extra, index) => {
            const bounds = otherRects[index];
            toggleClass(extra, 'is-visible', Boolean(bounds));
            if (!bounds) return;
            toggleClass(extra, 'tone-restore', box.classList.contains('tone-restore'));
            toggleClass(extra, 'tone-muted', box.classList.contains('tone-muted'));
            positionBox(extra, bounds);
        });
        positionLabel(label, rect, labelWidth, labelHeight, viewportWidth, viewportHeight);
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
        if (remembering) return;
        if (!target?.isConnected) return;
        cancelSettling();
        if (swept.length > 0) {
            const expanded = swept.map(root => expandSectionElement(root, geometry) ?? root);
            const expandedSet = new Set(expanded);
            const unique = [...expandedSet].filter(root => {
                if (expandedSet.size < 2) return true;
                let current = getComposedParent(root);
                for (let depth = 1; current && depth < 512; depth += 1) {
                    if (current !== root && expandedSet.has(current)) return false;
                    current = getComposedParent(current);
                }
                return true;
            });
            if (unique.length === swept.length) {
                const previous = new Set(swept);
                if (unique.every(root => previous.has(root))) {showTopmostNotice(); return;}
            }
            sweepExpansion.push(swept);
            setSwept(unique);
            return;
        }
        const next = expandSectionElement(target, geometry);
        if (!next) {
            showTopmostNotice();
            return;
        }
        expansion.push(next);
        setTarget(next);
    }

    function shrink(): void {
        if (remembering) return;
        if (sweepExpansion.length) {setSwept(sweepExpansion.pop()!); return;}
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
        if (drag || remembering) return;
        if (selectedRoots().some(root => !root.isConnected || !hasVisibleBox(root, geometry.rect(root)))) {
            locked = false;
            commitBase(null);
            return;
        }
        // 确认时重新盘点，避免页面动态更新后仍执行过时的恢复或翻译提示。
        const picked = selection();
        const summary = options.inspect(picked);
        summaries.set(element, summary);
        updateLabel(element);
        if (summary.action === 'empty' || summary.action === 'settled') return;
        if (summary.action === 'translate' && rememberCheckbox.checked && options.rememberScopes && options.onRemember) {
            const revision = ++rememberRevision;
            const roots = selectedRoots();
            const choice: SectionRememberChoice = {
                site: options.rememberScopes[rememberScope.value === 'site' ? 'site' : 'path'],
                mode: rememberMode.value === 'auto' ? 'auto' : 'remind',
            };
            remembering = true;
            rememberStatus.textContent = options.text('sectionTranslation.rules.saving');
            updateControls();
            const current = (): boolean => !disposed && revision === rememberRevision && locked
                && roots.every(root => root.isConnected && selectedRoots().includes(root));
            void Promise.resolve().then(() => current() ? options.onRemember!(picked, choice) : false).then(saved => {
                if (!current()) return;
                if (saved) { dispose(true); options.onPick(picked); }
                else {
                    remembering = false;
                    rememberStatus.textContent = options.text('sectionTranslation.rules.saveFailed');
                    updateControls();
                }
            }).catch(() => {
                if (!current()) return;
                remembering = false;
                rememberStatus.textContent = options.text('sectionTranslation.rules.saveFailed');
                updateControls();
            });
            return;
        }
        dispose(true);
        options.onPick(picked);
    }

    function dispose(confirmed: boolean): void {
        if (disposed) return;
        disposed = true;
        releasePointerSelection();
        drag = null;
        // 重复退出由 disposed 拒绝；仍可退出的私有会话就是唯一活动实例。
        activeSession = null;
        controller.abort();
        if (shadow.activeElement && previousFocus?.isConnected) previousFocus.focus?.({preventScroll: true});
        mutationObserver?.disconnect();
        resizeObserver?.disconnect();
        shadowScanner.cancel();
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
        extraBoxes.forEach(extra => extra.classList.add('is-confirmed'));
        setTimeout(() => host.remove(), CONFIRM_ANIMATION_MS);
    }

    // Step 2: 在 window 捕获阶段接管指针、键盘和视口事件；所有监听随 signal 一次移除。
    const listen = <K extends keyof WindowEventMap>(
        type: K,
        listener: (event: WindowEventMap[K]) => void,
        passive = false,
    ): void => window.addEventListener(type, listener, {capture: true, passive, signal});

    function collectDrag(point: SectionPickerPoint): void {
        if (!drag || !drag.moved) return;
        const previous = drag.points[drag.points.length - 1] ?? drag.last;
        if (point.x === previous.x && point.y === previous.y) return;
        drag.points.push(point);
        scheduleRender();
    }

    function flushDrag(): void {
        if (!drag?.moved || drag.points.length === 0) return;
        const roots = [...swept];
        const selected = new Set(roots);
        // 同帧保留每一段折线路径，但相同命中只解析一次，整批只提交一次选区。
        // 缓存不跨帧，下一帧重新取布局与父级，避免复用宿主变更前的区域。
        const resolved = new Map<Element | null, Element | null>();
        for (const point of drag.points) {
            const distance = Math.hypot(point.x - drag.last.x, point.y - drag.last.y);
            const steps = Math.max(1, Math.min(64, Math.ceil(distance / 12)));
            for (let step = 1; step <= steps; step += 1) {
                const element = elementAtPoint({
                    x: drag.last.x + (point.x - drag.last.x) * step / steps,
                    y: drag.last.y + (point.y - drag.last.y) * step / steps,
                });
                let hit = resolved.get(element);
                if (hit === undefined) {
                    hit = resolveSectionElement(element, geometry);
                    resolved.set(element, hit);
                }
                // 段落间空隙往往命中文章外壳；保留已选的具体内容块，不因经过间隙扩大。
                if (!hit || selected.has(hit) || roots.some(root => containsContent(hit, root))) continue;
                // 若从空白起划，起点外壳仅作暂存；进入正文后用实际经过的块替换它。
                const ancestorIndex = roots.findIndex(root => containsContent(root, hit));
                if (ancestorIndex >= 0) {
                    selected.delete(roots[ancestorIndex]!);
                    roots.splice(ancestorIndex, 1, hit);
                } else roots.push(hit);
                selected.add(hit);
            }
            drag.last = point;
        }
        drag.points = [];
        if (roots.length !== swept.length || roots.some((root, index) => root !== swept[index])) setSwept(roots);
    }

    function finishDrag(active: NonNullable<typeof drag>): void {
        flushDrag();
        const moved = active.moved;
        drag = null;
        if (moved) {
            suppressDragClick = true;
            lockSelection();
            updateControls();
        }
    }

    listen('pointermove', (event) => {
        if (!event.isTrusted) return;
        pointer = {x: event.clientX, y: event.clientY};
        if (drag && event.pointerId === drag.id) {
            if ((event.buttons & 1) === 0) {finishDrag(drag); return;}
            if (!drag.moved && Math.hypot(pointer.x - drag.start.x, pointer.y - drag.start.y) > POINTER_TOLERANCE) {
                drag.moved = true;
                cancelSettling();
                expansion = [];
                sweepExpansion = [];
                setSwept(drag.anchor ? [drag.anchor] : []);
            }
            collectDrag(pointer);
            event.stopImmediatePropagation();
            return;
        }
        if (locked) return;
        targetDirty = true;
        scheduleRender();
    }, true);
    listen('pointerdown', event => {
        if (!event.isTrusted) return;
        suppressDragClick = false;
        if (isExtensionUiEvent(event)) return;
        consume(event, false);
        if (locked || event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch') return;
        pointer = {x: event.clientX, y: event.clientY};
        drag = {id: event.pointerId, start: pointer, last: pointer, points: [], anchor: resolveSectionElement(elementAtPoint(pointer), geometry), moved: false};
    });
    listen('pointerup', event => {
        if (!event.isTrusted) return;
        if (drag && event.pointerId === drag.id && event.button === 0) {
            collectDrag({x: event.clientX, y: event.clientY});
            finishDrag(drag);
        }
        if (!isExtensionUiEvent(event)) consume(event, false);
    });
    listen('pointercancel', event => {
        if (!event.isTrusted || !drag || event.pointerId !== drag.id) return;
        drag = null;
        commitBase(null);
        targetDirty = true;
        scheduleRender();
    });
    listen('blur', event => {
        // 捕获监听也会收到网页控件及旧选择器的 blur，只有窗口失焦才中止当前划选。
        if (!event.isTrusted || event.target !== window || !drag) return;
        drag = null;
        commitBase(null);
        updateControls();
    });
    for (const type of INTERCEPTED_MOUSE_EVENTS) {
        listen(type, (event) => {
            if (!event.isTrusted) return;
            if (event.type === 'click' && suppressDragClick) {suppressDragClick = false; consume(event); return;}
            if (isExtensionUiEvent(event)) return;
            consume(event);
            if (event.type !== 'click' || event.button !== 0) return;
            if (drag && !drag.moved) drag = null;
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
            // 原生下拉框与复选框保留方向键、Enter 和空格的浏览器语义。
            if (shadow.activeElement === rememberCheckbox || shadow.activeElement === rememberScope || shadow.activeElement === rememberMode) return;
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
        // 仅撤销受影响的旧视口路径；无关侧栏滚动不能丢掉同帧已划过的正文。
        if (drag && pointer) {
            const scroller = event.target as Element | null;
            const bounds = scroller?.nodeType === 1 ? geometry.rect(scroller) : null;
            const points = [drag.last, ...drag.points];
            const affected = event.type === 'resize' || !bounds
                || Boolean(drag.anchor && containsContent(scroller!, drag.anchor))
                || points.some((point, index) => {
                    const previous = points[Math.max(0, index - 1)]!;
                    return Math.max(previous.x, point.x) >= bounds.left && Math.min(previous.x, point.x) <= bounds.left + bounds.width
                        && Math.max(previous.y, point.y) >= bounds.top && Math.min(previous.y, point.y) <= bounds.top + bounds.height;
                });
            if (affected) { drag.points = []; drag.last = pointer; }
        }
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
        drag = null;
        swept = [];
        sweepExpansion = [];
        cancelSettling();
        expansion = [];
        setTarget(null);
        updateControls();
        scheduleRender();
    });
    // onButton 只接收启用控件的可信点击，updateControls 已要求连接的目标与有效摘要。
    onButton(confirm, () => pick(target!));
    for (const control of [rememberCheckbox, rememberScope, rememberMode]) {
        control.addEventListener('change', (event) => {
            if (!event.isTrusted || remembering) return;
            rememberStatus.textContent = '';
            updateControls();
        }, {signal});
    }
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
        if (selectedRoots().some(root => !root.isConnected)) {
            drag = null;
            locked = false;
            commitBase(null);
            targetDirty = true;
            scheduleRender();
        } else if (contentRecords.some(record => selectedRoots().some(root => containsContent(root, record.target)
            || (record.type === 'attributes' && record.target.nodeType === 1 && containsContent(record.target as Element, root))))) {
            if (locked) {
                // 不重新扫描锁定范围；只发现已插入子树中的新宿主和嵌套开放根。
                for (const record of contentRecords) {
                    if (record.type !== 'childList' || !selectedRoots().some(root => containsContent(root, record.target))) continue;
                    for (const added of record.addedNodes) shadowScanner.enqueue(added);
                }
                if (!shadowScanner.isScheduled()) shadowScanner.scan();
            }
            // 保留上一份可执行摘要直到新盘点完成；确认仍会同步复核，动态正文不会让按钮一直禁用。
            scheduleInspect(true);
            scheduleRender();
        }
    }) : null;

    function observeTarget(): void {
        mutationObserver?.observe(document.documentElement, TARGET_OBSERVATION);
        // 文档观察不会穿透 ShadowRoot，额外监听目标所在树，覆盖同尺寸内容替换与祖先移除。
        for (const selected of selectedRoots()) {
            const root = selected.getRootNode();
            if (root.nodeType === 11) mutationObserver?.observe(root, TARGET_OBSERVATION);
        }
        // 锁定后才发现范围内的开放 ShadowRoot；大范围分帧完成，不阻塞一次点击。
        if (locked && target) {
            selectedRoots().forEach(shadowScanner.enqueue);
            shadowScanner.scan();
        }
    }
    observeTarget();
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (disposed) return;
        // observe 后的初始通知不代表网页刚发生布局变化，不能因此跳过正在等待的 hover 稳定窗。
        if (swept.length <= 1 && target?.isConnected && target === renderedTarget && renderedRect) {
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
    // 完成挂载后才接管指针；仅取消尚未确认的另一选择模式，翻译任务保持独立。
    const releasePointerSelection = claimPointerSelectionSession(() => dispose(false));
    return session;
}
