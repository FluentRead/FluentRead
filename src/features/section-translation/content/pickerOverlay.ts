/**
 * @file src/features/section-translation/content/pickerOverlay.ts
 *
 * 文件职责：封装局部翻译区域选择器的封闭 Shadow DOM 浮层视图构建、高亮框/标签几何定位及基础 DOM/阴影树命中辅助函数。
 * 主要内容：导出 SECTION_PICKER_HOST_ATTRIBUTE、sectionGeometry、createPickerOverlay，以及点命中、可见性判定、组合祖先包含、样式最小化写入与动画帧调度工具。
 * 模块边界：仅操作局部翻译选择器的封闭 Shadow UI 与只读几何测量，不管理选区状态机、拖动路径或翻译回调。
 */

import {getComposedParent} from '@/src/core/translation/public';
import type {SectionGeometry, SectionRect} from '../core';
import pickerStyles from './picker.css?inline';

export interface SectionPickerPoint {
    readonly x: number;
    readonly y: number;
}

export const SECTION_PICKER_HOST_ATTRIBUTE = 'section-picker';
export const BOX_OUTSET = 3;
export const LABEL_GAP = 6;
export const VIEWPORT_MARGIN = 4;
export const MAX_SHADOW_DEPTH = 16;
export const RECT_KEYS = ['left', 'top', 'width', 'height'] as const;

export const sectionGeometry: SectionGeometry = {
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

export function createOverlayElement(tag: string, className: string, text?: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

/** 同值文案不替换文本节点，避免重复布局和辅助技术状态通知。 */
export function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
}

/** 只写实际变化的样式，静止区域中的指针移动不重复使浮层布局失效。 */
export function setStyle(element: HTMLElement, property: 'transform' | 'width' | 'height', value: string): void {
    if (element.style[property] !== value) element.style[property] = value;
}

export function toggleClass(element: HTMLElement, name: string, enabled: boolean): void {
    if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
}

export function containsPoint(rect: SectionRect, point: SectionPickerPoint, tolerance = 0): boolean {
    return point.x >= rect.left - tolerance && point.x <= rect.left + rect.width + tolerance
        && point.y >= rect.top - tolerance && point.y <= rect.top + rect.height + tolerance;
}

export function hasVisibleBox(element: Element, rect: SectionRect): boolean {
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
export function containsContent(root: Element, node: Node): boolean {
    let current: Element | null = node.nodeType === 1 ? node as Element
        : node.parentElement ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
    for (let depth = 0; current && depth < 512; depth += 1) {
        if (current === root) return true;
        current = getComposedParent(current);
    }
    return false;
}

/** 逐层进入可读取的 ShadowRoot，找到指针下最深的网页元素。 */
export function elementAtPoint(point: SectionPickerPoint): Element | null {
    let element = document.elementFromPoint(point.x, point.y);
    for (let depth = 0; element?.shadowRoot && depth < MAX_SHADOW_DEPTH; depth += 1) {
        const inner: Element | null = element.shadowRoot.elementFromPoint(point.x, point.y);
        if (!inner || inner === element) break;
        element = inner;
    }
    return element;
}

export const scheduleFrame = (callback: () => void): number => typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);

export const cancelFrame = (handle: number): void => {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
};

export function positionBox(element: HTMLElement, rect: SectionRect): void {
    setStyle(element, 'transform', `translate(${Math.round(rect.left - BOX_OUTSET)}px, ${Math.round(rect.top - BOX_OUTSET)}px)`);
    setStyle(element, 'width', `${Math.round(rect.width + BOX_OUTSET * 2)}px`);
    setStyle(element, 'height', `${Math.round(rect.height + BOX_OUTSET * 2)}px`);
}

/** 标签尺寸在全部边框写入前统一读取；定位阶段只计算并写入。 */
export function positionLabel(
    label: HTMLElement,
    rect: SectionRect,
    labelWidth: number,
    labelHeight: number,
    viewportWidth: number,
    viewportHeight: number,
): void {
    const above = rect.top - BOX_OUTSET - labelHeight - LABEL_GAP;
    const top = above >= VIEWPORT_MARGIN
        ? above
        : Math.min(Math.max(rect.top + LABEL_GAP, VIEWPORT_MARGIN), viewportHeight - labelHeight - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - labelWidth - VIEWPORT_MARGIN));
    setStyle(label, 'transform', `translate(${Math.round(left)}px, ${Math.round(top)}px)`);
}

export interface PickerOverlayElements {
    readonly host: HTMLElement;
    readonly shadow: ShadowRoot;
    readonly box: HTMLElement;
    readonly label: HTMLElement;
    readonly labelAction: HTMLElement;
    readonly labelMeta: HTMLElement;
    readonly bar: HTMLElement;
    readonly heading: HTMLElement;
    readonly instruction: HTMLElement;
    readonly larger: HTMLButtonElement;
    readonly smaller: HTMLButtonElement;
    readonly reselect: HTMLButtonElement;
    readonly confirm: HTMLButtonElement;
    readonly close: HTMLButtonElement;
    readonly remember: HTMLElement;
    readonly rememberCheckbox: HTMLInputElement;
    readonly rememberFields: HTMLElement;
    readonly rememberScope: HTMLSelectElement;
    readonly rememberMode: HTMLSelectElement;
    readonly rememberAddress: HTMLElement;
    readonly rememberStatus: HTMLElement;
}

export function createPickerOverlay(
    text: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): PickerOverlayElements {
    const host = document.createElement('fluent-read-section-picker');
    host.setAttribute('data-fluent-read-ui', SECTION_PICKER_HOST_ATTRIBUTE);
    host.setAttribute('translate', 'no');
    applyHostStyles(host);
    const shadow = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = pickerStyles;
    const box = createOverlayElement('div', 'fr-section-box');
    const label = createOverlayElement('div', 'fr-section-label');
    label.setAttribute('aria-hidden', 'true');
    const labelAction = createOverlayElement('span', 'fr-section-label-action');
    const labelMeta = createOverlayElement('span', 'fr-section-label-meta');
    label.append(labelAction, labelMeta);
    const bar = createOverlayElement('div', 'fr-section-bar');
    bar.tabIndex = -1;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', text('sectionTranslation.picker.title'));
    const heading = createOverlayElement('div', 'fr-section-bar-heading');
    const instruction = createOverlayElement('span', 'fr-section-bar-instruction', text('sectionTranslation.picker.preview'));
    instruction.setAttribute('role', 'status');
    instruction.setAttribute('aria-live', 'polite');
    const actions = createOverlayElement('div', 'fr-section-bar-actions');
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', text('sectionTranslation.picker.title'));
    const button = (name: string): HTMLButtonElement => {
        const result = createOverlayElement('button', `fr-section-button fr-section-${name}`, text(`sectionTranslation.picker.${name}`)) as HTMLButtonElement;
        result.type = 'button';
        return result;
    };
    const larger = button('expand');
    const smaller = button('shrink');
    for (const [control, symbol] of [[larger, '＋'], [smaller, '−']] as const) {
        control.setAttribute('aria-label', control.textContent!);
        control.title = control.textContent!;
        control.textContent = symbol;
        control.classList.add('fr-section-size-button');
    }
    const reselect = button('reselect');
    const confirm = button('confirm');
    const close = createOverlayElement('button', 'fr-section-bar-close', '×') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', text('sectionTranslation.picker.close'));
    close.title = text('sectionTranslation.picker.close');
    heading.append(createOverlayElement('strong', 'fr-section-bar-title', text('sectionTranslation.picker.title')), instruction, close);
    actions.append(larger, smaller, reselect, confirm);

    const remember = createOverlayElement('div', 'fr-section-remember');
    const rememberLabel = createOverlayElement('label', 'fr-section-remember-label');
    const rememberCheckbox = document.createElement('input');
    rememberCheckbox.type = 'checkbox';
    rememberCheckbox.className = 'fr-section-remember-checkbox';
    rememberLabel.append(rememberCheckbox, createOverlayElement('span', '', text('sectionTranslation.rules.remember')));
    const rememberFields = createOverlayElement('div', 'fr-section-remember-fields');
    const createChoice = (labelKey: string, className: string, choices: readonly {value: string; label: string}[]): HTMLSelectElement => {
        const field = createOverlayElement('label', 'fr-section-remember-field');
        const select = document.createElement('select');
        select.className = className;
        select.setAttribute('aria-label', text(labelKey));
        for (const choice of choices) {
            const option = document.createElement('option');
            option.value = choice.value;
            option.textContent = text(choice.label);
            select.append(option);
        }
        field.append(select);
        rememberFields.append(field);
        return select;
    };
    const rememberScope = createChoice('sectionTranslation.rules.scope', 'fr-section-remember-scope', [
        {value: 'path', label: 'sectionTranslation.rules.path'}, {value: 'site', label: 'sectionTranslation.rules.site'},
    ]);
    const rememberMode = createChoice('sectionTranslation.rules.nextVisit', 'fr-section-remember-mode', [
        {value: 'remind', label: 'sectionTranslation.rules.remind'}, {value: 'auto', label: 'sectionTranslation.rules.auto'},
    ]);
    const rememberAddress = createOverlayElement('small', 'fr-section-remember-address');
    rememberAddress.id = 'fr-section-remember-address';
    rememberScope.setAttribute('aria-describedby', rememberAddress.id);
    const rememberStatus = createOverlayElement('span', 'fr-section-remember-status');
    rememberStatus.setAttribute('role', 'status');
    rememberStatus.setAttribute('aria-live', 'polite');
    remember.append(rememberLabel, rememberFields, rememberAddress, rememberStatus);
    bar.append(heading, remember, actions);
    shadow.append(style, box, label, bar);
    document.documentElement.appendChild(host);

    return {
        host, shadow, box, label, labelAction, labelMeta, bar, heading, instruction,
        larger, smaller, reselect, confirm, close, remember, rememberCheckbox,
        rememberFields, rememberScope, rememberMode, rememberAddress, rememberStatus,
    };
}
