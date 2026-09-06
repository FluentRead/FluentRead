/**
 * @file src/features/selection-translation/content/modalDialogHost.ts
 * 文件职责：让划词翻译 Shadow host 在原生 showModal() 对话框的 top layer 中保持可见且可交互。
 * 主要内容：按选区 Range 查找共同的 dialog:modal，创建坐标 slot，迁移现有 host；宿主持续移除时停止重插，关闭或卸载时恢复。
 * 模块边界：本文件只管理 selection host 的 DOM 所有权和定位，不创建 Vue 实例、不读取配置、不调用翻译服务。
 */

const MAX_OVERLAY_Z_INDEX = '2147483647';
const CALIBRATION_TOLERANCE = 1;
const CALIBRATION_PASSES = 2;
const MODAL_DIALOG_HOST_SLOT_ATTRIBUTE = 'data-fluent-read-modal-dialog-host-slot';

const SLOT_STYLES: ReadonlyArray<readonly [string, string]> = [
    ['display', 'block'], ['position', 'absolute'], ['top', '0px'], ['right', 'auto'],
    ['bottom', 'auto'], ['left', '0px'], ['box-sizing', 'border-box'], ['width', '0px'],
    ['min-width', '0px'], ['max-width', '0px'], ['height', '0px'], ['min-height', '0px'],
    ['max-height', '0px'], ['margin', '0px'], ['padding', '0px'], ['border', '0px'],
    ['overflow', 'visible'], ['pointer-events', 'none'], ['z-index', MAX_OVERLAY_Z_INDEX],
];

function parentAcrossShadow(node: Node): Node | null {
    if (node.parentNode) return node.parentNode;
    const root = node.getRootNode();
    return root && root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

function isActiveModalDialog(node: Node): node is HTMLDialogElement {
    if (node.nodeType !== 1 || (node as Element).tagName.toLowerCase() !== 'dialog' ||
        !(node as HTMLDialogElement).open || !node.isConnected) return false;
    try {
        return (node as Element).matches(':modal');
    } catch {
        return false;
    }
}

function nearestModalDialog(node: Node): HTMLDialogElement | null {
    let current: Node | null = node;
    while (current) {
        if (isActiveModalDialog(current)) return current;
        current = parentAcrossShadow(current);
    }
    return null;
}

export function findSelectionModalDialog(range: Range | null): HTMLDialogElement | null {
    if (!range) return null;
    const start = nearestModalDialog(range.startContainer);
    const end = nearestModalDialog(range.endContainer);
    return start && start === end ? start : null;
}

function createModalDialogHostSlot(ownerDocument: Document): HTMLElement {
    const slot = ownerDocument.createElement('fluent-read-modal-dialog-host-slot');
    slot.setAttribute(MODAL_DIALOG_HOST_SLOT_ATTRIBUTE, '');
    for (const [property, value] of SLOT_STYLES) slot.style.setProperty(property, value, 'important');
    return slot;
}

function readPixelStyle(element: HTMLElement, property: 'left' | 'top'): number {
    const value = Number.parseFloat(element.style.getPropertyValue(property));
    return Number.isFinite(value) ? value : 0;
}

function compensateDialogScale(dialog: HTMLDialogElement, slot: HTMLElement): void {
    try {
        const transform = dialog.ownerDocument.defaultView?.getComputedStyle(dialog).transform || 'none';
        let scaleX = 1;
        let scaleY = 1;
        const matrix = transform.match(/^matrix\(([^)]+)\)$/u);
        const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/u);
        if (matrix) {
            const values = matrix[1]!.split(',').map(Number);
            scaleX = values[0] || 1;
            scaleY = values[3] || 1;
        } else if (matrix3d) {
            const values = matrix3d[1]!.split(',').map(Number);
            scaleX = values[0] || 1;
            scaleY = values[5] || 1;
        }
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX) < 0.01 || Math.abs(scaleY) < 0.01 ||
            (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001)) {
            slot.style.removeProperty('transform');
            slot.style.removeProperty('transform-origin');
            return;
        }
        slot.style.setProperty('transform', `scale(${1 / scaleX}, ${1 / scaleY})`, 'important');
        slot.style.setProperty('transform-origin', '0 0', 'important');
    } catch {
        slot.style.removeProperty('transform');
        slot.style.removeProperty('transform-origin');
    }
}

export function calibrateModalDialogHostSlot(slot: HTMLElement): {aligned: boolean; errorX: number; errorY: number} {
    const view = slot.ownerDocument.defaultView;
    if (!view) return {aligned: false, errorX: Infinity, errorY: Infinity};
    // SelectionTranslator.vue renders a viewport-fixed root. The modal slot
    // therefore recreates the viewport origin, independent of document scroll.
    const targetX = 0;
    const targetY = 0;
    for (let pass = 0; pass < CALIBRATION_PASSES; pass += 1) {
        const rect = slot.getBoundingClientRect();
        const errorX = targetX - rect.left;
        const errorY = targetY - rect.top;
        if (Math.abs(errorX) <= CALIBRATION_TOLERANCE && Math.abs(errorY) <= CALIBRATION_TOLERANCE) {
            return {aligned: true, errorX, errorY};
        }
        const left = readPixelStyle(slot, 'left');
        const top = readPixelStyle(slot, 'top');
        slot.style.setProperty('left', String(left + 1) + 'px', 'important');
        const leftRect = slot.getBoundingClientRect();
        slot.style.setProperty('left', String(left) + 'px', 'important');
        slot.style.setProperty('top', String(top + 1) + 'px', 'important');
        const topRect = slot.getBoundingClientRect();
        slot.style.setProperty('top', String(top) + 'px', 'important');
        const a = leftRect.left - rect.left;
        const b = topRect.left - rect.left;
        const c = leftRect.top - rect.top;
        const d = topRect.top - rect.top;
        const determinant = a * d - b * c;
        if (Math.abs(determinant) > 0.01) {
            slot.style.setProperty('left', String(left + (errorX * d - b * errorY) / determinant) + 'px', 'important');
            slot.style.setProperty('top', String(top + (a * errorY - errorX * c) / determinant) + 'px', 'important');
        } else {
            slot.style.setProperty('left', String(left + errorX) + 'px', 'important');
            slot.style.setProperty('top', String(top + errorY) + 'px', 'important');
        }
    }
    const rect = slot.getBoundingClientRect();
    const errorX = targetX - rect.left;
    const errorY = targetY - rect.top;
    return {aligned: Math.abs(errorX) <= CALIBRATION_TOLERANCE && Math.abs(errorY) <= CALIBRATION_TOLERANCE, errorX, errorY};
}

function observerTargets(dialog: HTMLDialogElement): Set<Node> {
    const targets = new Set<Node>();
    let current: Node | null = dialog.parentNode;
    while (current) {
        targets.add(current);
        if (current.nodeType === 9) break;
        current = parentAcrossShadow(current);
    }
    return targets;
}

export interface ModalDialogHostController {
    placeForRange: (range: Range | null) => boolean;
    restore: () => void;
    dispose: () => void;
}

export function createModalDialogHostController(host: HTMLElement): ModalDialogHostController {
    const ownerDocument = host.ownerDocument;
    const view = ownerDocument.defaultView;
    const originalParent = host.parentNode;
    const originalNextSibling = host.nextSibling;
    let activeDialog: HTMLDialogElement | null = null;
    let slot: HTMLElement | null = null;
    let mutationObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let frame: number | null = null;
    let disposed = false;
    let calibrationRetries = 0;
    let ownershipRepairs = 0;
    let rejectedDialog: HTMLDialogElement | null = null;
    const clearRejectedDialog = (event?: Event) => {
        if (event && !event.isTrusted && rejectedDialog?.open) return;
        rejectedDialog?.removeEventListener('close', clearRejectedDialog);
        rejectedDialog = null;
    };

    const scheduleSync = () => {
        if (!view || disposed || !activeDialog || frame !== null) return;
        frame = view.requestAnimationFrame(() => {
            frame = null;
            syncPlacement();
        });
    };

    const detachListeners = () => {
        if (frame !== null && view) view.cancelAnimationFrame(frame);
        frame = null;
        mutationObserver?.disconnect();
        mutationObserver = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (!view || !activeDialog) return;
        const visualViewport = view.visualViewport;
        activeDialog.removeEventListener('close', restore);
        activeDialog.removeEventListener('scroll', scheduleSync, true);
        view.removeEventListener('scroll', scheduleSync);
        view.removeEventListener('resize', scheduleSync);
        visualViewport?.removeEventListener('scroll', scheduleSync);
        visualViewport?.removeEventListener('resize', scheduleSync);
    };

    const restoreHost = () => {
        const parent = originalParent?.isConnected
            ? originalParent
            : (ownerDocument.body ?? ownerDocument.documentElement);
        if (!parent) return;
        if (originalNextSibling?.parentNode === parent) parent.insertBefore(host, originalNextSibling);
        else parent.appendChild(host);
    };

    function restore() {
        if (!activeDialog && !slot) return;
        const previousSlot = slot;
        detachListeners();
        activeDialog = null;
        slot = null;
        restoreHost();
        previousSlot?.remove();
    }

    function syncPlacement() {
        if (disposed || !activeDialog || !slot) return;
        if (!isActiveModalDialog(activeDialog)) {
            restore();
            return;
        }
        if (slot.parentNode !== activeDialog || host.parentNode !== slot) {
            // 宿主框架反复拒绝外来子节点时让出 DOM，不能每一帧都与页面争夺所有权。
            if (ownershipRepairs >= 2) {
                clearRejectedDialog();
                rejectedDialog = activeDialog;
                rejectedDialog.addEventListener('close', clearRejectedDialog);
                restore();
                return;
            }
            ownershipRepairs += 1;
        }
        if (slot.parentNode !== activeDialog) activeDialog.appendChild(slot);
        if (host.parentNode !== slot) slot.appendChild(host);
        compensateDialogScale(activeDialog, slot);
        const calibration = calibrateModalDialogHostSlot(slot);
        if (calibration.aligned) calibrationRetries = 0;
        else if (calibrationRetries < 2) {
            calibrationRetries += 1;
            scheduleSync();
        }
    }

    const attachListeners = () => {
        if (!view || !activeDialog) return;
        const visualViewport = view.visualViewport;
        activeDialog.addEventListener('close', restore);
        activeDialog.addEventListener('scroll', scheduleSync, {capture: true, passive: true});
        view.addEventListener('scroll', scheduleSync, {passive: true});
        view.addEventListener('resize', scheduleSync);
        visualViewport?.addEventListener('scroll', scheduleSync, {passive: true});
        visualViewport?.addEventListener('resize', scheduleSync);
        mutationObserver = new MutationObserver((records) => {
            if (slot && (!slot.isConnected || slot.parentNode !== activeDialog || host.parentNode !== slot)) {
                scheduleSync();
                return;
            }
            if (records.some((record) => {
                if (record.type === 'attributes') return record.target === activeDialog;
                const isOwnNode = (node: Node) => node === slot || node === host ||
                    Boolean((slot && slot.contains(node)) || (host && host.contains(node)));
                return !isOwnNode(record.target) &&
                    [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) => !isOwnNode(node));
            })) scheduleSync();
        });
        for (const target of observerTargets(activeDialog)) {
            mutationObserver.observe(target, {childList: true});
        }
        mutationObserver.observe(activeDialog, {
            attributes: true,
            attributeFilter: ['class', 'open', 'style'],
            childList: true,
            subtree: true,
        });
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(scheduleSync);
            resizeObserver.observe(activeDialog);
        }
    };

    const placeForRange = (range: Range | null): boolean => {
        if (disposed) return false;
        const dialog = findSelectionModalDialog(range);
        if (!dialog) {
            clearRejectedDialog();
            restore();
            return false;
        }
        if (dialog === rejectedDialog) return false;
        if (dialog === activeDialog && slot) {
            syncPlacement();
            return dialog !== rejectedDialog;
        }
        restore();
        activeDialog = dialog;
        slot = createModalDialogHostSlot(ownerDocument);
        calibrationRetries = 0;
        ownershipRepairs = 0;
        activeDialog.appendChild(slot);
        slot.appendChild(host);
        syncPlacement();
        attachListeners();
        return true;
    };

    const dispose = () => {
        if (disposed) return;
        clearRejectedDialog();
        restore();
        disposed = true;
    };

    return {placeForRange, restore, dispose};
}
