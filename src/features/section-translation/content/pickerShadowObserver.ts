/**
 * @file src/features/section-translation/content/pickerShadowObserver.ts
 *
 * 文件职责：为局部翻译区域选择器提供按帧预算扫描开放 ShadowRoot 并挂接局部 MutationObserver 的管理器。
 * 主要内容：导出 TARGET_OBSERVATION、createPickerShadowScanner，以每帧 150 步发现锁定区域内嵌套开放 ShadowRoot 并在取消或换选时彻底回收扫描状态。
 * 模块边界：仅负责开放 ShadowRoot 的增量发现与观察绑定，不决定选区高亮、按钮状态或翻译提交。
 */

import {cancelFrame, containsContent, scheduleFrame} from './pickerOverlay';

const SHADOW_SCAN_STEPS_PER_FRAME = 150;

/** 只监听会改变布局、可见性或原文保护的属性，避免任意 data-* 计数驱动整页重绘。 */
export const TARGET_OBSERVATION: MutationObserverInit = {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'translate', 'contenteditable', 'lang', 'dir', 'slot'],
};

export interface PickerShadowScannerOptions {
    getMutationObserver: () => MutationObserver | null;
    isActive: () => boolean;
    getSelectedRoots: () => Element[];
    onShadowRootDiscovered: () => void;
}

export interface PickerShadowScanner {
    cancel: () => void;
    enqueue: (root: Node) => void;
    scan: () => void;
    isScheduled: () => boolean;
}

export function createPickerShadowScanner(options: PickerShadowScannerOptions): PickerShadowScanner {
    let shadowScanFrame = 0;
    let shadowScans: {root: Node; walker: TreeWalker; current: Element | null}[] = [];
    let shadowScanIndex = 0;
    let queuedShadowScans = new WeakSet<Node>();
    let observedShadowRoots = new WeakSet<ShadowRoot>();

    const cancel = (): void => {
        if (shadowScanFrame) cancelFrame(shadowScanFrame);
        shadowScanFrame = 0;
        shadowScans = [];
        shadowScanIndex = 0;
        queuedShadowScans = new WeakSet<Node>();
        observedShadowRoots = new WeakSet<ShadowRoot>();
    };

    const enqueue = (root: Node): void => {
        const observer = options.getMutationObserver();
        const roots = options.getSelectedRoots();
        if (!observer || roots.length === 0 || !roots.some(selected => containsContent(selected, root)) || queuedShadowScans.has(root)) return;
        // 文本变更只刷新摘要，不创建扫描器；遍历器只访问元素，不递归进入影子树。
        if (root.nodeType !== 1 && root.nodeType !== 11) return;
        queuedShadowScans.add(root);
        const walker = document.createTreeWalker(root, 1);
        shadowScans.push({root, walker, current: root.nodeType === 1 ? root as Element : walker.nextNode() as Element | null});
    };

    const scan = (): void => {
        shadowScanFrame = 0;
        const observer = options.getMutationObserver();
        if (!observer || !options.isActive()) return;
        let remaining = SHADOW_SCAN_STEPS_PER_FRAME;
        let found = false;
        let checkedRoot: Node | undefined;
        while (shadowScanIndex < shadowScans.length && remaining > 0) {
            const currentScan = shadowScans[shadowScanIndex]!;
            const element = currentScan.current;
            remaining -= 1;
            // 同一同步批次内只检查一次归属；下一帧继续时仍复核网页是否移走了子树。
            if (!element || (checkedRoot !== currentScan.root && !options.getSelectedRoots().some(root => containsContent(root, currentScan.root)))) {
                queuedShadowScans.delete(currentScan.root);
                shadowScanIndex += 1;
                continue;
            }
            checkedRoot = currentScan.root;
            const root = element.shadowRoot;
            if (root && !observedShadowRoots.has(root)) {
                observedShadowRoots.add(root);
                observer.observe(root, TARGET_OBSERVATION);
                enqueue(root);
                found = true;
            }
            currentScan.current = currentScan.walker.nextNode() as Element | null;
            if (!currentScan.current) {
                queuedShadowScans.delete(currentScan.root);
                shadowScanIndex += 1;
            }
        }
        if (found) options.onShadowRootDiscovered();
        if (shadowScanIndex < shadowScans.length) shadowScanFrame = scheduleFrame(scan);
        else {
            shadowScans = [];
            shadowScanIndex = 0;
        }
    };

    return {
        cancel,
        enqueue,
        scan,
        isScheduled: () => shadowScanFrame !== 0,
    };
}
