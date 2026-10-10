import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {installDocumentZoomGestures, type DocumentZoomOptions} from '@/src/features/document-translation/ui/documentZoom';

const cleanups: (() => void)[] = [];
afterEach(() => {cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals();});

function reader(initialScale = 1, options: Partial<DocumentZoomOptions> = {}) {
    const {document, window} = parseHTML('<html><body><div data-fluent-read-ui="document-app"><div id="viewport"><span id="text">Document text</span></div></div></body></html>');
    const target = document.querySelector<HTMLElement>('#viewport')!;
    Object.defineProperty(target, 'clientHeight', {value: 800});
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const request = vi.fn((callback: FrameRequestCallback) => {const id = nextFrame++; frames.set(id, callback); return id;});
    const cancel = vi.fn((id: number) => {frames.delete(id);});
    Object.assign(window, {requestAnimationFrame: request, cancelAnimationFrame: cancel});
    let scale = initialScale;
    const setScale = vi.fn((value: number) => {scale = value;});
    const reset = vi.fn(() => {scale = 1;});
    const dispose = installDocumentZoomGestures(target, {getScale: () => scale, setScale, reset, ...options});
    cleanups.push(dispose);
    const dispatch = (type: string, fields: Record<string, unknown>, source: HTMLElement = target) => {
        const event = new window.Event(type, {bubbles: true, cancelable: true});
        Object.assign(event, fields);
        source.dispatchEvent(event);
        return event;
    };
    const wheel = (fields: Record<string, unknown> = {}, source = target) => dispatch('wheel', {ctrlKey: true, metaKey: false, deltaY: -100, deltaMode: 0, clientX: 120, clientY: 230, ...fields}, source);
    const key = (key: string, fields: Record<string, unknown> = {}, source = target) => dispatch('keydown', {key, ctrlKey: true, metaKey: false, altKey: false, ...fields}, source);
    const flush = () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));};
    return {document, window, target, frames, request, cancel, dispose, setScale, reset, wheel, key, flush, scale: () => scale};
}

describe('document viewport zoom gestures', () => {
    it('leaves normal scrolling alone and batches every pinch delta with the latest document anchor', () => {
        const fixture = reader();
        expect(fixture.wheel({ctrlKey: false, deltaY: 80}).defaultPrevented).toBe(false);
        expect(fixture.frames.size).toBe(0);
        expect(fixture.wheel({deltaY: -20}).defaultPrevented).toBe(true);
        fixture.wheel({ctrlKey: false, metaKey: true, deltaY: -30, clientX: 300, clientY: 420}, fixture.document.querySelector<HTMLElement>('#text')!);
        expect(fixture.frames.size).toBe(1);
        expect(fixture.setScale).not.toHaveBeenCalled();
        fixture.flush();
        expect(fixture.scale()).toBeCloseTo(Math.exp(0.1));
        expect(fixture.setScale).toHaveBeenCalledOnce();
        expect(fixture.setScale).toHaveBeenCalledWith(expect.any(Number), {clientX: 300, clientY: 420});
        fixture.wheel({deltaY: -50});
        fixture.flush();
        expect(fixture.scale()).toBeCloseTo(Math.exp(0.2));
    });

    it('normalizes wheel lines and pages into a consistent zoom distance', () => {
        const pixels = reader();
        const lines = reader();
        pixels.wheel({deltaY: -32}); lines.wheel({deltaY: -2, deltaMode: 1});
        pixels.flush(); lines.flush();
        expect(lines.scale()).toBeCloseTo(pixels.scale());
        const page = reader();
        const equivalent = reader();
        page.wheel({deltaY: 0.25, deltaMode: 2}); equivalent.wheel({deltaY: 200});
        page.flush(); equivalent.flush();
        expect(page.scale()).toBeCloseTo(equivalent.scale());
    });

    it('keeps browser zoom blocked at either limit and responds immediately to a reverse pinch', () => {
        const fixture = reader(3);
        expect(fixture.wheel({deltaY: -5000}).defaultPrevented).toBe(true);
        fixture.wheel({deltaY: 20}); fixture.flush();
        expect(fixture.scale()).toBeCloseTo(3 * Math.exp(-0.04));
        fixture.wheel({deltaY: 5000}); fixture.flush();
        expect(fixture.scale()).toBe(0.25);
        expect(fixture.wheel({deltaY: 100}).defaultPrevented).toBe(true);
        fixture.wheel({deltaY: -20}); fixture.flush();
        expect(fixture.scale()).toBeCloseTo(0.25 * Math.exp(0.04));
        const widerRange = reader(0.1, {minScale: 0.1, maxScale: 2});
        widerRange.wheel({deltaY: 5000}); widerRange.flush();
        expect(widerRange.scale()).toBe(0.1);
        widerRange.wheel({deltaY: -5000}); widerRange.flush();
        expect(widerRange.scale()).toBe(2);
    });

    it('rejects non-finite wheel inputs and omits malformed pointer coordinates', () => {
        const fixture = reader(NaN, {minScale: NaN, maxScale: Infinity});
        for (const deltaY of [NaN, Infinity, -Infinity]) expect(fixture.wheel({deltaY}).defaultPrevented).toBe(false);
        expect(fixture.frames.size).toBe(0);
        fixture.wheel({deltaY: -20, clientX: NaN}); fixture.flush();
        expect(fixture.scale()).toBeCloseTo(Math.exp(0.04));
        expect(fixture.setScale).toHaveBeenCalledWith(expect.any(Number), undefined);
        const negativeScale = reader(-1, {minScale: -1, maxScale: 0});
        negativeScale.wheel({deltaY: 0}); negativeScale.flush();
        expect(negativeScale.scale()).toBe(1);
    });

    it('supports scoped Ctrl and Cmd keys while preserving unmodified and unrelated shortcuts', () => {
        const fixture = reader();
        for (const [key, fields] of [['+', {ctrlKey: false}], ['x', {}], ['+', {altKey: true}]] as const) {
            expect(fixture.key(key, fields).defaultPrevented).toBe(false);
        }
        expect(fixture.key('+').defaultPrevented).toBe(true);
        expect(fixture.scale()).toBeCloseTo(1.1);
        fixture.key('=', {ctrlKey: false, metaKey: true});
        expect(fixture.scale()).toBeCloseTo(1.21);
        fixture.key('-'); fixture.key('_');
        expect(fixture.scale()).toBeCloseTo(1);
        fixture.key('0', {ctrlKey: false, metaKey: true});
        expect(fixture.reset).toHaveBeenCalledOnce();
        const outside = fixture.document.createElement('button'); fixture.document.body.append(outside);
        expect(fixture.key('+', {}, outside).defaultPrevented).toBe(false);
        expect(fixture.scale()).toBe(1);
    });

    it('preserves editing shortcuts and selection card interactions across nested event targets', () => {
        const fixture = reader();
        for (const markup of ['<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"><span>Editable</span></div>', '<div contenteditable=""><span>Editable</span></div>', '<div role="textbox"><span>Editable</span></div>', '<div data-fluent-read-ui="pdf-selection-translator"><button>Card</button></div>']) {
            const holder = fixture.document.createElement('div'); holder.innerHTML = markup; fixture.target.append(holder);
            const child = holder.querySelector<HTMLElement>('span,button,input,textarea,select')!;
            expect(fixture.key('+', {}, child).defaultPrevented).toBe(false);
            expect(fixture.wheel({}, child).defaultPrevented).toBe(false);
        }
        expect(fixture.setScale).not.toHaveBeenCalled();
        expect(fixture.frames.size).toBe(0);
        const card = fixture.target.querySelector<HTMLElement>('[data-fluent-read-ui] button')!;
        expect(fixture.wheel({}, card).defaultPrevented).toBe(false);
        const noneditable = fixture.document.createElement('div'); noneditable.setAttribute('contenteditable', 'false'); fixture.target.append(noneditable);
        expect(fixture.key('+', {}, noneditable).defaultPrevented).toBe(true);
        expect(fixture.wheel({}, noneditable).defaultPrevented).toBe(true);
    });

    it('honors an inner handler that already claimed an event and skips retargeted shadow card paths', () => {
        const fixture = reader();
        const child = fixture.document.querySelector<HTMLElement>('#text')!;
        child.addEventListener('wheel', event => event.preventDefault());
        child.addEventListener('keydown', event => event.preventDefault());
        fixture.wheel({}, child); fixture.key('+', {}, child);
        expect(fixture.setScale).not.toHaveBeenCalled();
        expect(fixture.frames.size).toBe(0);
        const card = fixture.document.createElement('div'); card.setAttribute('data-fluent-read-ui', 'selection-translator');
        const shadowInput = fixture.document.createElement('input');
        const event = new fixture.window.Event('keydown', {bubbles: true, cancelable: true});
        Object.assign(event, {key: '+', ctrlKey: true, composedPath: () => [shadowInput, card, fixture.target]});
        fixture.target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        const wheel = new fixture.window.Event('wheel', {bubbles: true, cancelable: true});
        Object.assign(wheel, {deltaY: -20, ctrlKey: true, composedPath: () => [shadowInput, card, fixture.target]});
        fixture.target.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(false);
    });

    it('combines a pending pinch with a keyboard step and drops it when the reader is reset or disposed', () => {
        const fixture = reader();
        fixture.wheel({deltaY: -50}); fixture.key('+');
        expect(fixture.scale()).toBeCloseTo(Math.exp(0.1) * 1.1);
        expect(fixture.frames.size).toBe(0);
        fixture.flush();
        expect(fixture.setScale).toHaveBeenCalledOnce();
        fixture.wheel(); fixture.key('0');
        expect(fixture.frames.size).toBe(0);
        expect(fixture.scale()).toBe(1);
        fixture.wheel();
        fixture.dispose(); fixture.dispose();
        expect(fixture.frames.size).toBe(0);
        expect(fixture.wheel().defaultPrevented).toBe(false);
        expect(fixture.key('+').defaultPrevented).toBe(false);
        fixture.flush();
        expect(fixture.setScale).toHaveBeenCalledOnce();
        expect(fixture.cancel).toHaveBeenCalledTimes(3);
    });

    it('uses the owner window scheduler and falls back to the page scheduler for a detached document', () => {
        const fixture = reader();
        let fallbackFrame: FrameRequestCallback | undefined;
        const fallbackRequest = vi.fn((callback: FrameRequestCallback) => {fallbackFrame = callback; return 77;});
        const fallbackCancel = vi.fn();
        vi.stubGlobal('window', {requestAnimationFrame: fallbackRequest, cancelAnimationFrame: fallbackCancel});
        fixture.wheel();
        expect(fixture.request).toHaveBeenCalledOnce();
        expect(fallbackRequest).not.toHaveBeenCalled();
        fixture.flush(); fixture.dispose();
        const {document, window} = parseHTML('<html><body><div></div></body></html>');
        Object.defineProperty(document, 'defaultView', {value: null});
        const target = document.querySelector<HTMLElement>('div')!;
        const setScale = vi.fn();
        cleanups.push(installDocumentZoomGestures(target, {getScale: () => 1, setScale, reset: vi.fn()}));
        const event = new window.Event('wheel', {bubbles: true, cancelable: true});
        Object.assign(event, {ctrlKey: true, deltaY: -20, deltaMode: 0}); target.dispatchEvent(event);
        expect(fallbackRequest).toHaveBeenCalledOnce();
        fallbackFrame!(0);
        expect(setScale).toHaveBeenCalledWith(expect.any(Number), undefined);
    });
});
