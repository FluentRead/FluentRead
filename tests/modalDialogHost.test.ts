/**
 * @file tests/modalDialogHost.test.ts
 * 文件职责：验证划词翻译 host 进入原生 modal dialog top layer 时的检测、迁移、校准和恢复。
 * 主要内容：覆盖共同 modal 判定、零尺寸 slot、关闭恢复和卸载清理。
 * 模块边界：测试只覆盖 selection modal controller，不触发 provider、Vue 或浏览器扩展消息。
 */
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ModalDialogHostController} from '@/src/features/selection-translation/content/modalDialogHost';
import {calibrateModalDialogHostSlot, createModalDialogHostController, findSelectionModalDialog} from '@/src/features/selection-translation/content/modalDialogHost';

function installDom(markup = '<html><body></body></html>') {
    const window = parseHTML(markup);
    class TestResizeObserver {
        observe() {}
        disconnect() {}
    }
    Object.assign(globalThis, {
        document: window.document,
        Node: window.Node,
        MutationObserver: window.MutationObserver,
        ResizeObserver: TestResizeObserver,
    });
    window.scrollX = 0;
    window.scrollY = 0;
    window.getComputedStyle = (() => ({transform: 'none'})) as unknown as typeof window.getComputedStyle;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0));
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
    return window;
}

describe('selection modal dialog host', () => {
    it('lets a rejecting host keep its dialog instead of repeatedly reinserting the overlay', () => {
        const window = installDom('<html><body><div id="origin"><div id="host"></div></div><dialog><p>Selected text</p></dialog></body></html>');
        const host = window.document.querySelector('#host') as HTMLElement;
        const origin = host.parentNode;
        const dialog = window.document.querySelector('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: () => true});
        const text = dialog.querySelector('p')!.firstChild!;
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        const controller = createModalDialogHostController(host);
        expect(controller.placeForRange(range)).toBe(true);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            host.parentElement!.remove();
            expect(controller.placeForRange(range)).toBe(attempt < 2);
        }
        expect(host.parentNode).toBe(origin);
        for (let attempt = 0; attempt < 20; attempt += 1) expect(controller.placeForRange(range)).toBe(false);
        expect(dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]')).toBeNull();
        dialog.dispatchEvent(new window.Event('close'));
        expect(controller.placeForRange(range)).toBe(false);
        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
        dialog.open = true;
        expect(controller.placeForRange(range)).toBe(true);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            host.parentElement!.remove();
            controller.placeForRange(range);
        }
        // 浏览器 close 通知可能在同节点重新 showModal 后才送达。
        const trustedClose = new window.Event('close');
        Object.defineProperty(trustedClose, 'isTrusted', {value: true});
        dialog.dispatchEvent(trustedClose);
        expect(controller.placeForRange(range)).toBe(true);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            host.parentElement!.remove();
            controller.placeForRange(range);
        }
        controller.placeForRange(null);
        expect(controller.placeForRange(range)).toBe(true);
        controller.dispose();
    });
    it('handles null and detached selection boundaries defensively', () => {
        expect(findSelectionModalDialog(null)).toBeNull();

        const detached = {
            nodeType: 3,
            parentNode: null,
            getRootNode: () => null,
        } as unknown as Node;
        expect(findSelectionModalDialog({startContainer: detached, endContainer: detached} as unknown as Range)).toBeNull();

        const rootWithoutHost = {nodeType: 11} as unknown as Node;
        const shadowBoundary = {
            nodeType: 3,
            parentNode: null,
            getRootNode: () => rootWithoutHost,
        } as unknown as Node;
        expect(findSelectionModalDialog({startContainer: shadowBoundary, endContainer: shadowBoundary} as unknown as Range)).toBeNull();

        const window = installDom('<html><body><dialog id="dialog"></dialog></body></html>');
        const dialog = window.document.querySelector('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        const shadowHost = window.document.createElement('div');
        const shadow = shadowHost.attachShadow({mode: 'open'});
        const shadowText = window.document.createTextNode('shadow selection');
        shadow.appendChild(shadowText);
        dialog.appendChild(shadowHost);
        expect(findSelectionModalDialog({startContainer: shadowText, endContainer: shadowText} as unknown as Range)).toBe(dialog);
    });

    it('requires one common native modal dialog for both range boundaries', () => {
        const window = installDom('<html><body><dialog id="dialog"><p id="text">Hello world</p></dialog></body></html>');
        const dialog = window.document.querySelector('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        const text = window.document.querySelector('#text')!.firstChild!;
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        expect(findSelectionModalDialog(range)).toBe(dialog);
    });

    it('rejects a dialog when the modal pseudo-class check throws', () => {
        const window = installDom('<html><body><dialog id="dialog"><p id="text">Hello</p></dialog></body></html>');
        const dialog = window.document.querySelector('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: () => { throw new Error('unsupported'); }});
        const text = window.document.querySelector('#text')!.firstChild!;
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        expect(findSelectionModalDialog(range)).toBeNull();
    });

    it('moves and restores the same host around dialog close and unmount', () => {
        const window = installDom();
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        original.appendChild(host);
        window.document.body.appendChild(original);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        const controller = createModalDialogHostController(host);

        expect(controller.placeForRange(range)).toBe(true);
        expect(controller.placeForRange(range)).toBe(true);
        const slot = dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]') as HTMLElement;
        expect(slot).not.toBeNull();
        expect(host.parentElement).toBe(slot);
        expect(slot.style.getPropertyValue('pointer-events')).toBe('none');

        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
        expect(host.parentElement).toBe(original);

        controller.dispose();
        expect(host.parentElement).toBe(original);
        controller.dispose();
    });

    it('restores the host when the dialog or an ancestor is removed', async () => {
        const window = installDom();
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        original.appendChild(host);
        window.document.body.appendChild(original);
        const section = window.document.createElement('section');
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        section.appendChild(dialog);
        window.document.body.appendChild(section);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        const controller = createModalDialogHostController(host);
        controller.placeForRange(range);

        dialog.remove();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(host.parentElement).toBe(original);

        controller.placeForRange(range);
        section.appendChild(dialog);
        dialog.appendChild(text);
        controller.placeForRange(range);
        section.remove();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(host.parentElement).toBe(original);
        controller.dispose();
    });

    it('calibrates a slot to the document origin', () => {
        const window = installDom();
        const slot = window.document.createElement('div');
        window.document.body.appendChild(slot);
        vi.spyOn(slot, 'getBoundingClientRect')
            .mockReturnValueOnce({left: 20, top: 30, width: 0, height: 0} as DOMRect)
            .mockReturnValueOnce({left: 0, top: 0, width: 0, height: 0} as DOMRect);
        expect(calibrateModalDialogHostSlot(slot).aligned).toBe(true);
        expect(slot.style.left).toBe('-20px');
        expect(slot.style.top).toBe('-30px');
    });

    it('calibrates through a transformed containing block', () => {
        const window = installDom();
        const slot = window.document.createElement('div');
        window.document.body.appendChild(slot);
        vi.spyOn(slot, 'getBoundingClientRect').mockImplementation(() => {
            const left = Number.parseFloat(slot.style.left) || 0;
            const top = Number.parseFloat(slot.style.top) || 0;
            return {left: 100 + left * 2, top: 180 + top * 3, width: 0, height: 0} as DOMRect;
        });
        const result = calibrateModalDialogHostSlot(slot);
        expect(result.aligned).toBe(true);
        expect(Number.parseFloat(slot.style.left)).toBeCloseTo(-50, 5);
        expect(Number.parseFloat(slot.style.top)).toBeCloseTo(-60, 5);
    });

    it('cancels a modal scale transform for the nested selection UI', () => {
        const window = installDom();
        window.getComputedStyle = (() => ({transform: 'matrix(2, 0, 0, 2, 0, 0)'})) as unknown as typeof window.getComputedStyle;
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        original.appendChild(host);
        window.document.body.appendChild(original);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const controller = createModalDialogHostController(host);
        controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        const slot = dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]') as HTMLElement;
        expect(slot.style.transform).toBe('scale(0.5, 0.5)');
        controller.dispose();
    });

    it('supports matrix3d scale compensation and a style-read failure fallback', () => {
        const window = installDom();
        window.getComputedStyle = (() => ({transform: 'matrix3d(2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)'})) as unknown as typeof window.getComputedStyle;
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        original.appendChild(host);
        window.document.body.appendChild(original);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const controller = createModalDialogHostController(host);
        controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        const slot = dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]') as HTMLElement;
        expect(slot.style.transform).toBe('scale(0.5, 0.25)');
        controller.dispose();

        window.getComputedStyle = (() => { throw new Error('style unavailable'); }) as unknown as typeof window.getComputedStyle;
        const secondHost = window.document.createElement('div');
        original.appendChild(secondHost);
        const secondController = createModalDialogHostController(secondHost);
        secondController.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        const secondSlot = dialog.querySelectorAll('[data-fluent-read-modal-dialog-host-slot]')[0] as HTMLElement;
        expect(secondSlot.style.transform || '').toBe('');
        secondController.dispose();
    });

    it('falls back safely for zero scale components and an empty transform value', () => {
        const window = installDom();
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        original.appendChild(host);
        window.document.body.appendChild(original);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);

        window.getComputedStyle = (() => ({transform: 'matrix(0, 0, 0, 0, 0, 0)'})) as unknown as typeof window.getComputedStyle;
        const controller = createModalDialogHostController(host);
        controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        const slot = dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]') as HTMLElement;
        expect(slot.style.transform || '').toBe('');
        controller.dispose();

        window.getComputedStyle = (() => ({transform: 'matrix3d(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)'})) as unknown as typeof window.getComputedStyle;
        const secondHost = window.document.createElement('div');
        original.appendChild(secondHost);
        const secondController = createModalDialogHostController(secondHost);
        secondController.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        const secondSlot = dialog.querySelectorAll('[data-fluent-read-modal-dialog-host-slot]')[0] as HTMLElement;
        expect(secondSlot.style.transform || '').toBe('');
        secondController.dispose();

        window.getComputedStyle = (() => ({})) as unknown as typeof window.getComputedStyle;
        const thirdHost = window.document.createElement('div');
        original.appendChild(thirdHost);
        const thirdController = createModalDialogHostController(thirdHost);
        thirdController.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        expect(dialog.querySelectorAll('[data-fluent-read-modal-dialog-host-slot]')).toHaveLength(1);
        thirdController.dispose();
    });

    it('covers missing document views and the final calibration result', () => {
        const window = installDom();
        const slot = window.document.createElement('div');
        Object.defineProperty(slot.ownerDocument, 'defaultView', {configurable: true, value: undefined});
        expect(calibrateModalDialogHostSlot(slot).aligned).toBe(false);

        const finalWindow = installDom();
        const finalSlot = finalWindow.document.createElement('div');
        let calls = 0;
        vi.spyOn(finalSlot, 'getBoundingClientRect').mockImplementation(() => {
            calls += 1;
            return (calls <= 6 ? {left: 100, top: 180} : {left: 0, top: 0}) as DOMRect;
        });
        expect(calibrateModalDialogHostSlot(finalSlot).aligned).toBe(true);
    });

    it('covers modal listener fallbacks and does not schedule after disposal', () => {
        const window = installDom();
        const originalParent = window.document.createElement('div');
        const host = window.document.createElement('div');
        originalParent.appendChild(host);
        window.document.body.appendChild(originalParent);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {configurable: true, value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);

        Object.defineProperty(window.document, 'defaultView', {configurable: true, value: undefined});
        const noViewController = createModalDialogHostController(host);
        expect(noViewController.placeForRange({startContainer: text, endContainer: text} as unknown as Range)).toBe(true);
        noViewController.restore();
        noViewController.dispose();
        expect(noViewController.placeForRange({startContainer: text, endContainer: text} as unknown as Range)).toBe(false);

        const view = window;
        Object.defineProperty(window.document, 'defaultView', {configurable: true, value: view});
        const secondHost = window.document.createElement('div');
        originalParent.appendChild(secondHost);
        let matches = 0;
        Object.defineProperty(dialog, 'matches', {configurable: true, value: (selector: string) => selector === ':modal' && ++matches <= 2});
        const inactiveController = createModalDialogHostController(secondHost);
        expect(inactiveController.placeForRange({startContainer: text, endContainer: text} as unknown as Range)).toBe(true);
        inactiveController.dispose();

        const viewport = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        Object.defineProperty(view, 'visualViewport', {configurable: true, value: viewport});
        const previousResizeObserver = globalThis.ResizeObserver;
        try {
            globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
            Object.defineProperty(dialog, 'matches', {configurable: true, value: (selector: string) => selector === ':modal'});
            const thirdHost = window.document.createElement('div');
            originalParent.appendChild(thirdHost);
            const controller = createModalDialogHostController(thirdHost);
            controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
            controller.dispose();
        } finally {
            globalThis.ResizeObserver = previousResizeObserver;
        }
    });

    it('uses documentElement when the original parent and body are gone, and preserves sibling order', () => {
        const window = installDom();
        const original = window.document.createElement('div');
        const host = window.document.createElement('div');
        const marker = window.document.createElement('span');
        original.append(host, marker);
        window.document.body.appendChild(original);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const controller = createModalDialogHostController(host);
        controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
        expect(host.nextSibling).toBe(marker);

        const fallbackParent = window.document.createElement('div');
        const fallbackHost = window.document.createElement('div');
        fallbackParent.appendChild(fallbackHost);
        const fallbackDialog = window.document.createElement('dialog') as HTMLDialogElement;
        fallbackDialog.open = true;
        Object.defineProperty(fallbackDialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.documentElement.appendChild(fallbackDialog);
        const fallbackText = window.document.createTextNode('selected');
        fallbackDialog.appendChild(fallbackText);
        const fallbackController = createModalDialogHostController(fallbackHost);
        fallbackController.placeForRange({startContainer: fallbackText, endContainer: fallbackText} as unknown as Range);
        fallbackParent.remove();
        Object.defineProperty(window.document, 'body', {configurable: true, value: null});
        fallbackDialog.open = false;
        fallbackDialog.dispatchEvent(new window.Event('close'));
        expect(fallbackHost.parentNode).toBe(window.document.documentElement);
        fallbackController.dispose();

        const noParent = window.document.createElement('div');
        const noParentHost = window.document.createElement('div');
        noParent.appendChild(noParentHost);
        const noParentDialog = window.document.createElement('dialog') as HTMLDialogElement;
        noParentDialog.open = true;
        Object.defineProperty(noParentDialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.documentElement.appendChild(noParentDialog);
        const noParentText = window.document.createTextNode('selected');
        noParentDialog.appendChild(noParentText);
        const noParentController = createModalDialogHostController(noParentHost);
        noParentController.placeForRange({startContainer: noParentText, endContainer: noParentText} as unknown as Range);
        noParent.remove();
        Object.defineProperty(window.document, 'documentElement', {configurable: true, value: null});
        noParentDialog.open = false;
        noParentDialog.dispatchEvent(new window.Event('close'));
        noParentController.dispose();
    });

    it('self-heals removed slot and host nodes while ignoring owned style mutations', () => {
        const window = installDom();
        const observers: Array<{emit: (records: MutationRecord[]) => void}> = [];
        class TestMutationObserver {
            private readonly callback: MutationCallback;
            constructor(callback: MutationCallback) {
                this.callback = callback;
                observers.push({emit: (records) => this.callback(records, this as unknown as MutationObserver)});
            }
            observe() {}
            disconnect() {}
        }
        const previousMutationObserver = globalThis.MutationObserver;
        const previousRequestAnimationFrame = window.requestAnimationFrame;
        const previousCancelAnimationFrame = window.cancelAnimationFrame;
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 1;
        globalThis.MutationObserver = TestMutationObserver as unknown as typeof MutationObserver;
        window.requestAnimationFrame = (callback) => {
            const id = nextFrame++;
            frames.set(id, callback);
            return id;
        };
        window.cancelAnimationFrame = (id) => { frames.delete(id); };
        try {
            const original = window.document.createElement('div');
            const host = window.document.createElement('div');
            original.appendChild(host);
            window.document.body.appendChild(original);
            const dialog = window.document.createElement('dialog') as HTMLDialogElement;
            dialog.open = true;
            Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
            window.document.body.appendChild(dialog);
            const text = window.document.createTextNode('selected');
            dialog.appendChild(text);
            vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 0, height: 0} as DOMRect);
            const controller = createModalDialogHostController(host);
            controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range);
            const observer = observers[0]!;
            const slot = dialog.querySelector('[data-fluent-read-modal-dialog-host-slot]') as HTMLElement;

            observer.emit([]);
            expect(frames.size).toBe(0);
            observer.emit([{type: 'attributes', target: original} as unknown as MutationRecord]);
            expect(frames.size).toBe(0);
            observer.emit([{type: 'attributes', target: dialog} as unknown as MutationRecord]);
            expect(frames.size).toBe(1);
            frames.get(1)!(0);
            frames.clear();

            slot.remove();
            observer.emit([{type: 'childList', target: dialog, addedNodes: [], removedNodes: [slot]} as unknown as MutationRecord]);
            expect(frames.size).toBe(1);
            frames.get(2)!(0);
            frames.clear();
            expect(dialog.contains(host)).toBe(true);

            host.remove();
            observer.emit([{type: 'childList', target: slot, addedNodes: [], removedNodes: [host]} as unknown as MutationRecord]);
            expect(frames.size).toBe(1);
            frames.get(3)!(0);
            frames.clear();
            expect(slot.contains(host)).toBe(true);

            observer.emit([{type: 'attributes', target: slot} as unknown as MutationRecord]);
            expect(frames.size).toBe(0);
            observer.emit([{type: 'childList', target: slot, addedNodes: [host], removedNodes: []} as unknown as MutationRecord]);
            expect(frames.size).toBe(0);
            observer.emit([{type: 'childList', target: window.document.body, addedNodes: [], removedNodes: []} as unknown as MutationRecord]);
            expect(frames.size).toBe(0);
            observer.emit([{type: 'attributes', target: dialog} as unknown as MutationRecord]);
            const staleFrame = frames.get(4);
            expect(staleFrame).toBeDefined();
            controller.restore();
            staleFrame?.(0);
            frames.clear();
            controller.dispose();
        } finally {
            globalThis.MutationObserver = previousMutationObserver;
            window.requestAnimationFrame = previousRequestAnimationFrame;
            window.cancelAnimationFrame = previousCancelAnimationFrame;
        }
    });

    it('reports an unaligned result when the containing block cannot respond', () => {
        const window = installDom();
        const slot = window.document.createElement('div');
        window.document.body.appendChild(slot);
        vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({left: 100, top: 180, width: 0, height: 0} as DOMRect);
        expect(calibrateModalDialogHostSlot(slot).aligned).toBe(false);
    });

    it('bounds calibration retries and restores into body after the original parent is removed', async () => {
        const window = installDom();
        const detachedParent = window.document.createElement('div');
        const host = window.document.createElement('div');
        detachedParent.appendChild(host);
        const dialog = window.document.createElement('dialog') as HTMLDialogElement;
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {value: (selector: string) => selector === ':modal'});
        window.document.body.appendChild(dialog);
        const text = window.document.createTextNode('selected');
        dialog.appendChild(text);
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        const controller = createModalDialogHostController(host);
        const rectSpy = vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue({left: 100, top: 180, width: 0, height: 0} as DOMRect);
        expect(controller.placeForRange(range)).toBe(true);
        // 模态框保持打开，实际经历两次校准重试之后停止排帧。
        await new Promise(resolve=>setTimeout(resolve,100));const reads=rectSpy.mock.calls.length;
        await new Promise(resolve=>setTimeout(resolve,60));expect(rectSpy).toHaveBeenCalledTimes(reads);
        detachedParent.remove();
        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
        expect(host.parentElement).toBe(window.document.body);
        await new Promise((resolve) => setTimeout(resolve, 20));
        rectSpy.mockRestore();
        controller.dispose();
    });
});


describe('selection modal focused-card restoration', () => {
    // Linkedom supplies real nodes/slots/listeners. These document focus, rect and
    // trust ports describe controller state; native Tab/focus stays a root check.
    const controllers = new Set<ModalDialogHostController>();
    afterEach(() => {
        for (const controller of controllers) controller.dispose();
        controllers.clear();
        vi.restoreAllMocks();
    });

    function focusedModal() {
        const window = installDom('<html><body><div id="origin"><div id="host"><button id="owned">Card control</button></div><span id="marker"></span></div><dialog><button id="native">Native control</button><button id="next">Next native control</button><p>Selected text</p></dialog><button id="outside">Outside control</button></body></html>');
        const document = window.document;
        const origin = document.querySelector('#origin') as HTMLElement;
        const host = document.querySelector('#host') as HTMLElement;
        const owned = document.querySelector('#owned') as HTMLElement;
        const marker = document.querySelector('#marker')!;
        const dialog = document.querySelector('dialog') as HTMLDialogElement;
        const native = document.querySelector('#native') as HTMLElement;
        const next = document.querySelector('#next') as HTMLElement;
        const outside = document.querySelector('#outside') as HTMLElement;
        const text = dialog.querySelector('p')!.firstChild!;
        let active: Node | null = native, documentFocused = true;
        let afterMove: (() => void) | null = null;
        Object.defineProperties(document, {activeElement: {configurable: true, get: () => active},
            hasFocus: {configurable: true, value: () => documentFocused}});
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {configurable: true, value: (selector: string) => selector === ':modal'});
        for (const element of [native, next, dialog]) {
            Object.defineProperty(element, 'getClientRects', {configurable: true,
                value: () => [{left: 0, top: 0, width: 80, height: 24}]});
        }
        window.getComputedStyle = ((element: Element) => ({transform: 'none',
            display: (element as HTMLElement).style.display || 'block',
            visibility: (element as HTMLElement).style.visibility || 'visible'})) as unknown as typeof window.getComputedStyle;
        const focus = (element: HTMLElement) => {
            const spy = vi.fn(() => {active = element;});
            Object.defineProperty(element, 'focus', {configurable: true, value: spy});
            return spy;
        };
        const nativeFocus = focus(native), nextFocus = focus(next), dialogFocus = focus(dialog);
        focus(host); focus(owned); focus(outside);
        const frames = new Map<number, FrameRequestCallback>();
        let frame = 0;
        window.requestAnimationFrame = callback => {frames.set(++frame, callback); return frame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        const add = vi.spyOn(dialog, 'addEventListener');
        const remove = vi.spyOn(dialog, 'removeEventListener');
        const append = origin.appendChild.bind(origin), insert = origin.insertBefore.bind(origin);
        const moved = (node: Node) => {
            if (node !== host) return;
            if (active === host || (active && host.contains(active))) active = document.body;
            const callback = afterMove;
            afterMove = null;
            callback?.();
        };
        vi.spyOn(origin, 'appendChild').mockImplementation(node => {const result = append(node); moved(node); return result;});
        vi.spyOn(origin, 'insertBefore').mockImplementation((node, before) => {const result = insert(node, before); moved(node); return result;});
        const controller = createModalDialogHostController(host);
        controllers.add(controller);
        const range = {startContainer: text, endContainer: text} as unknown as Range;
        const place = () => {
            expect(controller.placeForRange(range)).toBe(true);
            const slot = host.parentElement!;
            expect(slot.parentElement).toBe(dialog);
            return slot;
        };
        const focusin = (target: Node, trusted = true) => {
            const event = new window.Event('focusin', {bubbles: true});
            Object.defineProperty(event, 'isTrusted', {value: trusted});
            target.dispatchEvent(event);
        };
        return {window, document, origin, host, owned, marker, dialog, native, next, outside, text,
            nativeFocus, nextFocus, dialogFocus, controller, range, place, focusin, add, remove,
            setActive: (element: Node | null) => {active = element;},
            setDocumentFocused: (value: boolean) => {documentFocused = value;},
            setAfterMove: (callback: () => void) => {afterMove = callback;}};
    }

    it.each(['body', 'documentElement', 'host', 'owned descendant'] as const)(
        'synchronously restores the remembered native control after migration leaves focus on %s', destination => {
            const fixture = focusedModal();
            const slot = fixture.place();
            const focusListener = fixture.add.mock.calls.find(([type]) => type === 'focusin')![1] as (event: FocusEvent) => void;
            fixture.setActive(destination === 'owned descendant' ? fixture.owned : fixture.host);
            fixture.setAfterMove(() => fixture.setActive(destination === 'body' ? fixture.document.body
                : destination === 'documentElement' ? fixture.document.documentElement
                    : destination === 'host' ? fixture.host : fixture.owned));

            fixture.controller.restoreFromFocusedCard();

            expect(fixture.host.parentElement).toBe(fixture.origin);
            expect(fixture.host.nextSibling).toBe(fixture.marker);
            expect(slot.isConnected).toBe(false);
            expect(fixture.nativeFocus).toHaveBeenCalledOnce();
            expect(fixture.nativeFocus).toHaveBeenCalledWith({preventScroll: true});
            expect(fixture.document.activeElement).toBe(fixture.native);
            expect(fixture.remove).toHaveBeenCalledWith('focusin', focusListener, true);
            // A queued callback after detach must not retain a target or steal focus.
            fixture.setActive(fixture.next);
            focusListener({isTrusted: true, target: fixture.next} as unknown as FocusEvent);
            fixture.controller.restoreFromFocusedCard();
            expect(fixture.document.activeElement).toBe(fixture.next);
            expect(fixture.nativeFocus).toHaveBeenCalledOnce();
            expect(fixture.nextFocus).not.toHaveBeenCalled();
        },
    );

    it('never focuses during generic restoration, close, rejection or disposal', () => {
        for (const operation of ['restore', 'null range', 'close', 'rejection', 'dispose'] as const) {
            const fixture = focusedModal();
            const slot = fixture.place();
            fixture.setActive(fixture.host);
            if (operation === 'restore') fixture.controller.restore();
            else if (operation === 'null range') fixture.controller.placeForRange(null);
            else if (operation === 'close') {
                fixture.dialog.open = false;
                fixture.dialog.dispatchEvent(new fixture.window.Event('close'));
            } else if (operation === 'rejection') {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    fixture.host.parentElement!.remove();
                    fixture.controller.placeForRange(fixture.range);
                }
                expect(fixture.controller.placeForRange(fixture.range)).toBe(false);
            } else fixture.controller.dispose();
            fixture.controller.restoreFromFocusedCard();
            expect(fixture.host.parentElement).toBe(fixture.origin);
            expect(slot.isConnected).toBe(false);
            expect(fixture.nativeFocus).not.toHaveBeenCalled();
            expect(fixture.dialogFocus).not.toHaveBeenCalled();
        }
    });

    it.each(['no active dialog', 'document unfocused', 'hasFocus unavailable', 'outside focus', 'null focus',
        'closed dialog', 'detached dialog', 'host moved', 'slot moved', 'disposed'] as const)(
        'does not move or focus a card without current focused ownership: %s', condition => {
            const fixture = focusedModal();
            const slot = condition === 'no active dialog' ? null : fixture.place();
            fixture.setActive(fixture.host);
            if (condition === 'document unfocused') fixture.setDocumentFocused(false);
            if (condition === 'hasFocus unavailable') Object.defineProperty(fixture.document, 'hasFocus', {value: undefined});
            if (condition === 'outside focus') fixture.setActive(fixture.outside);
            if (condition === 'null focus') fixture.setActive(null);
            if (condition === 'closed dialog') fixture.dialog.open = false;
            if (condition === 'detached dialog') fixture.dialog.remove();
            if (condition === 'host moved') {fixture.origin.appendChild(fixture.host); fixture.setActive(fixture.host);}
            if (condition === 'slot moved') fixture.origin.appendChild(slot!);
            if (condition === 'disposed') fixture.controller.dispose();
            const parent = fixture.host.parentNode;

            fixture.controller.restoreFromFocusedCard();

            expect(fixture.host.parentNode).toBe(parent);
            expect(fixture.nativeFocus).not.toHaveBeenCalled();
            expect(fixture.dialogFocus).not.toHaveBeenCalled();
        },
    );

    it.each(['external focus', 'document loses focus', 'dialog closes', 'dispose during migration', 'new modal placement'] as const)(
        'completes cleanup without stealing focus when %s takes over during restore', interruption => {
            const fixture = focusedModal();
            const slot = fixture.place();
            fixture.setActive(fixture.host);
            let newDialog: HTMLDialogElement | null = null;
            fixture.setAfterMove(() => {
                if (interruption === 'external focus') fixture.setActive(fixture.next);
                else if (interruption === 'document loses focus') fixture.setDocumentFocused(false);
                else if (interruption === 'dialog closes') fixture.dialog.open = false;
                else if (interruption === 'dispose during migration') fixture.controller.dispose();
                else {
                    newDialog = fixture.document.createElement('dialog') as HTMLDialogElement;
                    newDialog.open = true;
                    Object.defineProperty(newDialog, 'matches', {value: (selector: string) => selector === ':modal'});
                    fixture.document.body.appendChild(newDialog);
                    const text = fixture.document.createTextNode('New owner selection');
                    newDialog.appendChild(text);
                    expect(fixture.controller.placeForRange({startContainer: text, endContainer: text} as unknown as Range)).toBe(true);
                }
            });

            fixture.controller.restoreFromFocusedCard();

            expect(slot.isConnected).toBe(false);
            expect(fixture.nativeFocus).not.toHaveBeenCalled();
            expect(fixture.dialogFocus).not.toHaveBeenCalled();
            if (newDialog) expect(fixture.host.parentElement!.parentElement).toBe(newDialog);
            else expect(fixture.host.parentElement).toBe(fixture.origin);
            if (interruption === 'external focus') expect(fixture.document.activeElement).toBe(fixture.next);
        },
    );

    it.each(['removed', 'foreign document', 'focus unavailable', 'moved into card', 'outside modal', 'nested modal',
        'disabled', 'inert', 'hidden', 'display none', 'visibility hidden', 'visibility collapse', 'empty rects', 'inspection throws'] as const)(
        'falls back only to the active dialog when the remembered control is %s', invalidity => {
            const fixture = focusedModal();
            const slot = fixture.place();
            if (invalidity === 'removed') fixture.native.remove();
            if (invalidity === 'foreign document') Object.defineProperty(fixture.native, 'ownerDocument', {
                value: parseHTML('<html><body></body></html>').document});
            if (invalidity === 'focus unavailable') Object.defineProperty(fixture.native, 'focus', {value: undefined});
            if (invalidity === 'moved into card') fixture.host.appendChild(fixture.native);
            if (invalidity === 'outside modal') fixture.document.body.appendChild(fixture.native);
            if (invalidity === 'nested modal') {
                const nested = fixture.document.createElement('dialog') as HTMLDialogElement;
                nested.open = true;
                Object.defineProperty(nested, 'matches', {value: (selector: string) => selector === ':modal'});
                fixture.dialog.appendChild(nested);
                nested.appendChild(fixture.native);
            }
            if (invalidity === 'disabled') fixture.native.setAttribute('disabled', '');
            if (invalidity === 'inert' || invalidity === 'hidden') fixture.native.setAttribute(invalidity, '');
            if (invalidity === 'display none') fixture.native.style.display = 'none';
            if (invalidity === 'visibility hidden') fixture.native.style.visibility = 'hidden';
            if (invalidity === 'visibility collapse') fixture.native.style.visibility = 'collapse';
            if (invalidity === 'empty rects') Object.defineProperty(fixture.native, 'getClientRects', {value: () => []});
            if (invalidity === 'inspection throws') vi.spyOn(fixture.native, 'matches').mockImplementation(() => {throw new Error('Host inspection failed');});
            fixture.setActive(fixture.host);

            fixture.controller.restoreFromFocusedCard();

            expect(fixture.host.parentElement).toBe(fixture.origin);
            expect(slot.isConnected).toBe(false);
            expect(fixture.nativeFocus).not.toHaveBeenCalled();
            expect(fixture.dialogFocus).toHaveBeenCalledOnce();
            expect(fixture.document.activeElement).toBe(fixture.dialog);
        },
    );

    it.each(['missing view', 'missing rect API'] as const)('keeps a valid actual target with %s', missing => {
        const fixture = focusedModal();
        let controller = fixture.controller;
        if (missing === 'missing view') {
            // The controller reads its document view at construction time.
            fixture.controller.dispose();
            Object.defineProperty(fixture.document, 'defaultView', {configurable: true, value: undefined});
            controller = createModalDialogHostController(fixture.host);
            controllers.add(controller);
        } else Object.defineProperty(fixture.native, 'getClientRects', {value: undefined});
        expect(controller.placeForRange(fixture.range)).toBe(true);
        fixture.setActive(fixture.host);
        controller.restoreFromFocusedCard();
        expect(fixture.nativeFocus).toHaveBeenCalledOnce();
        expect(fixture.document.activeElement).toBe(fixture.native);
        expect(fixture.host.parentElement).toBe(fixture.origin);
    });

    it.each(['document unfocused', 'hasFocus unavailable', 'null active', 'outside active', 'non-element active'] as const)(
        'does not remember a control from an invalid capture state: %s', capture => {
            const fixture = focusedModal();
            if (capture === 'document unfocused') fixture.setDocumentFocused(false);
            if (capture === 'hasFocus unavailable') Object.defineProperty(fixture.document, 'hasFocus', {configurable: true, value: undefined});
            if (capture === 'null active') fixture.setActive(null);
            if (capture === 'outside active') fixture.setActive(fixture.outside);
            if (capture === 'non-element active') fixture.setActive(fixture.text);
            fixture.place();
            if (capture === 'document unfocused') {
                fixture.setActive(fixture.native);
                fixture.focusin(fixture.native);
            }
            fixture.setDocumentFocused(true);
            if (capture === 'hasFocus unavailable') Object.defineProperty(fixture.document, 'hasFocus', {value: () => true});
            fixture.setActive(fixture.host);

            fixture.controller.restoreFromFocusedCard();

            expect(fixture.nativeFocus).not.toHaveBeenCalled();
            expect(fixture.dialogFocus).toHaveBeenCalledOnce();
            expect(fixture.document.activeElement).toBe(fixture.dialog);
        },
    );

    it.each(['trusted native', 'untrusted native', 'different active element', 'owned host'] as const)(
        'updates the remembered target only for valid actual focusin: %s', focusEvent => {
            const fixture = focusedModal();
            fixture.place();
            if (focusEvent === 'owned host') {
                fixture.setActive(fixture.host);
                fixture.focusin(fixture.host);
            } else {
                fixture.setActive(focusEvent === 'different active element' ? fixture.native : fixture.next);
                fixture.focusin(fixture.next, focusEvent !== 'untrusted native');
            }
            fixture.setActive(fixture.host);
            fixture.controller.restoreFromFocusedCard();
            expect(fixture.nativeFocus).toHaveBeenCalledTimes(focusEvent === 'trusted native' ? 0 : 1);
            expect(fixture.nextFocus).toHaveBeenCalledTimes(focusEvent === 'trusted native' ? 1 : 0);
            expect(fixture.document.activeElement).toBe(focusEvent === 'trusted native' ? fixture.next : fixture.native);
        },
    );

    it('remembers a later trusted native focus after an unfocused initial placement', () => {
        const fixture = focusedModal();
        fixture.setDocumentFocused(false);
        fixture.place();
        fixture.setDocumentFocused(true);
        fixture.setActive(fixture.next);
        fixture.focusin(fixture.next);
        fixture.setActive(fixture.host);
        fixture.controller.restoreFromFocusedCard();
        expect(fixture.nativeFocus).not.toHaveBeenCalled();
        expect(fixture.nextFocus).toHaveBeenCalledOnce();
        expect(fixture.document.activeElement).toBe(fixture.next);
    });

    it.each(['unavailable fallback', 'focus throws'] as const)('finishes DOM cleanup safely when %s', failure => {
        const fixture = focusedModal();
        const slot = fixture.place();
        if (failure === 'unavailable fallback') {
            fixture.native.remove();
            fixture.dialog.setAttribute('inert', '');
        } else fixture.nativeFocus.mockImplementation(() => {throw new Error('Host focus failed');});
        fixture.setActive(fixture.host);

        expect(() => fixture.controller.restoreFromFocusedCard()).not.toThrow();

        expect(fixture.host.parentElement).toBe(fixture.origin);
        expect(fixture.host.nextSibling).toBe(fixture.marker);
        expect(slot.isConnected).toBe(false);
        expect(fixture.dialogFocus).not.toHaveBeenCalled();
        expect(fixture.nativeFocus).toHaveBeenCalledTimes(failure === 'focus throws' ? 1 : 0);
    });
});
