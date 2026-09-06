/**
 * @file tests/modalDialogHost.test.ts
 * 文件职责：验证划词翻译 host 进入原生 modal dialog top layer 时的检测、迁移、校准和恢复。
 * 主要内容：覆盖共同 modal 判定、零尺寸 slot、关闭恢复和卸载清理。
 * 模块边界：测试只覆盖 selection modal controller，不触发 provider、Vue 或浏览器扩展消息。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
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
        detachedParent.remove();
        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
        expect(host.parentElement).toBe(window.document.body);
        await new Promise((resolve) => setTimeout(resolve, 20));
        rectSpy.mockRestore();
        controller.dispose();
    });
});
