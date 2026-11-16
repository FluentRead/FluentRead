import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHypothesisClient, injectHypothesisDocumentScript} from '@/src/features/hypothesis/client';
import {hypothesisSelectionAnchor} from '@/src/features/hypothesis/selection';

let document: Document, window: Window, frame: HTMLIFrameElement, source: object;
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
beforeEach(() => {
    const dom = parseHTML('<html><head></head><body><p>Reading text</p></body></html>');
    document = dom.document; window = dom.window as unknown as Window;
    for (const name of ['Element', 'HTMLIFrameElement', 'MutationObserver', 'Event'] as const) vi.stubGlobal(name, dom.window[name]);
    vi.useFakeTimers(); source = {};
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
function message(data: unknown = {type: 'request', frame1: 'sidebar', frame2: 'host'}, origin = 'https://hypothes.is', sender = source) {
    const event = new Event('message'); Object.assign(event, {data, origin, source: sender}); window.dispatchEvent(event);
}
function ui() {
    const host = document.createElement('hypothesis-sidebar'), shadowHost = document.createElement('div');
    host.append(shadowHost); const root = shadowHost.attachShadow({mode: 'open'});
    frame = document.createElement('iframe'); frame.src = 'https://hypothes.is/app.html';
    Object.defineProperty(frame, 'contentWindow', {value: source}); root.append(frame); document.body.append(host);
    document.querySelector('link[rel=sidebar]')!.addEventListener('destroy', () => host.remove());
    return host;
}
function setup(options: {prepare?: (signal: AbortSignal) => Promise<() => void>; inject?: () => Promise<void>} = {}) {
    const inject = options.inject ?? vi.fn(async () => {ui(); await flush(); message();});
    return {inject, client: createHypothesisClient({document, window, assetUrl: path => `chrome-extension://owned/${path}`, inject, prepare: options.prepare})};
}
describe('Hypothesis document ownership and lifecycle', () => {
    it('loads local assets only on request, accepts the official frame handshake, sandboxes the service and cleans up on repeated toggles', async () => {
        const {client, inject} = setup(); expect(document.head.children.length).toBe(0); expect(client.isActive()).toBe(false);
        expect(await client.toggle()).toEqual({status: 'success', active: true});
        expect(inject).toHaveBeenCalledTimes(1); expect(frame.getAttribute('sandbox')).toContain('allow-scripts'); expect(frame.referrerPolicy).toBe('no-referrer');
        expect((window as any).hypothesisConfig()).toEqual({ignoreOtherConfiguration: true, openSidebar: true, sideBySide: {mode: 'manual'}});
        expect(document.querySelector('[href$="pdfjs-overrides.css"]')).toBeNull();
        expect(await client.setEnabled(true)).toEqual({status: 'success', active: true});
        expect(await client.toggle()).toEqual({status: 'success', active: false});
        expect(document.querySelector('[data-hypothesis-asset]')).toBeNull(); expect(document.querySelector('hypothesis-sidebar')).toBeNull(); expect((window as any).hypothesisConfig).toBeUndefined();
        expect(await client.toggle()).toEqual({status: 'success', active: true}); await client.dispose();
        expect(await client.toggle()).toEqual({status: 'success', active: false}); expect(inject).toHaveBeenCalledTimes(2);
    });
    it.each(['link', 'sidebar'])('preserves an existing %s client and never injects', async type => {
        const foreign = document.createElement(type === 'link' ? 'link' : 'hypothesis-sidebar');
        if (type === 'link') {foreign.setAttribute('type', 'application/annotator+html'); foreign.setAttribute('rel', 'sidebar');}
        document.body.append(foreign); const {client, inject} = setup();
        expect(await client.toggle()).toEqual({status: 'external', active: false}); await client.dispose();
        expect(foreign.isConnected).toBe(true); expect(inject).not.toHaveBeenCalled();
    });
    it('releases prepared PDF resources, restores previous configuration and keeps sandboxing later modal frames', async () => {
        const previous = () => 'previous'; (window as any).hypothesisConfig = previous; (window as any).PDFViewerApplication = {};
        const release = vi.fn(); const {client} = setup({prepare: async () => release});
        await client.setEnabled(true); expect(document.querySelector('[href$="pdfjs-overrides.css"]')).not.toBeNull();
        const modal = document.createElement('hypothesis-profile'), iframe = document.createElement('iframe'); iframe.src = 'https://hypothes.is/user-profile.html'; modal.attachShadow({mode: 'open'}).append(iframe); document.body.append(modal); await flush();
        expect(iframe.getAttribute('sandbox')).toContain('allow-popups');
        await client.setEnabled(false); expect(release).toHaveBeenCalledTimes(1); expect((window as any).hypothesisConfig).toBe(previous);
    });
    it('rejects wrong origins, sources, frame roles and malformed messages until the official sidebar is ready', async () => {
        const original = window; const added = vi.fn(original.addEventListener.bind(original));
        window = {addEventListener: added, removeEventListener: original.removeEventListener.bind(original), dispatchEvent: original.dispatchEvent.bind(original)} as unknown as Window;
        const {client} = setup({inject: async () => {ui(); await flush();}}); const pending = client.toggle(); await flush();
        const queued = added.mock.calls.find(([type]) => type === 'message')![1] as (event: MessageEvent) => void;
        for (const value of [null, {}, {type: 'offer', frame1: 'sidebar', frame2: 'host'}, {type: 'request', frame1: 'notebook', frame2: 'host'}, {type: 'request', frame1: 'sidebar', frame2: 'guest'}]) message(value);
        message(undefined, 'https://attacker.invalid'); message(undefined, undefined, {}); expect(client.isActive()).toBe(false);
        message(); expect(await pending).toEqual({status: 'success', active: true}); queued({origin: 'https://hypothes.is', source, data: {type: 'request', frame1: 'sidebar', frame2: 'host'}} as MessageEvent); await client.dispose();
    });
    it('times out without a ready message and allows a clean retry', async () => {
        const {client} = setup({inject: async () => {ui(); await flush();}}); const pending = client.toggle(); await flush(); await vi.advanceTimersByTimeAsync(15_000);
        expect(await pending).toEqual({status: 'failed', active: false}); expect(document.head.children.length).toBe(0); await client.setEnabled(false);
    });
    it('cleans up failed injection and preparation instead of retaining partial UI', async () => {
        const release = vi.fn(); const first = setup({prepare: async () => release, inject: async () => {throw Error('blocked');}});
        expect(await first.client.toggle()).toEqual({status: 'failed', active: false}); expect(release).toHaveBeenCalledOnce();
        const second = setup({prepare: async () => {throw Error('PDF unavailable');}}); expect(await second.client.toggle()).toEqual({status: 'failed', active: false});
        expect(document.head.children.length).toBe(0);
    });
    it('cancels preparation before late resources can start the SDK', async () => {
        let finish!: (value: () => void) => void; let signal!: AbortSignal; const release = vi.fn();
        const {client, inject} = setup({prepare: value => {signal = value; return new Promise(resolve => {finish = resolve;});}});
        const start = client.toggle(), stop = client.setEnabled(false); expect(signal.aborted).toBe(true); finish(release);
        await start; expect(await stop).toEqual({status: 'success', active: false}); expect(release).toHaveBeenCalledOnce(); expect(inject).not.toHaveBeenCalled();
    });
    it('turns off the document guard while injection is in flight and disposes once it settles', async () => {
        let finish!: () => void; const {client} = setup({inject: () => new Promise<void>(resolve => {finish = resolve;})});
        const start = client.toggle(); await flush(); const stop = client.dispose(); expect(document.querySelector('link[rel=sidebar]')?.getAttribute('data-fluentread-hypothesis')).toBe('off'); finish();
        expect((await start).active).toBe(false); await stop; expect(document.head.children.length).toBe(0);
    });
});
describe('Packaged document injection', () => {
    it.each(['load', 'error'])('removes the script after %s', async event => {
        const operation = injectHypothesisDocumentScript(document, 'chrome-extension://owned/hypothesis/build/scripts/annotator.bundle.js');
        const outcome = operation.then(() => 'ok', () => 'error'); const script = document.querySelector('script')!;
        expect(script.dataset.hypothesisAsset).toBe(''); script.dispatchEvent(new Event(event));
        expect(await outcome).toBe(event === 'load' ? 'ok' : 'error'); expect(script.isConnected).toBe(false);
    });
});
describe('Selection UI coexistence', () => {
    it('reserves a visible Hypothesis toolbar without changing the selected range or mutating third-party UI', () => {
        const anchor = {left: 30, top: 80, bottom: 100}; expect(hypothesisSelectionAnchor(anchor, document)).toBe(anchor);
        const adder = document.createElement('hypothesis-adder'); document.body.append(adder); expect(hypothesisSelectionAnchor(anchor, document)).toBe(anchor);
        const root = adder.attachShadow({mode: 'open'}); expect(hypothesisSelectionAnchor(anchor, document)).toBe(anchor);
        const toolbar = document.createElement('div'); root.append(toolbar);
        toolbar.getBoundingClientRect = () => ({width: 100, height: 0} as DOMRect); expect(hypothesisSelectionAnchor(anchor, document)).toBe(anchor);
        toolbar.getBoundingClientRect = () => ({width: 0, height: 30} as DOMRect); expect(hypothesisSelectionAnchor(anchor, document)).toBe(anchor);
        toolbar.getBoundingClientRect = () => ({top: 40, bottom: 75, width: 100, height: 35} as DOMRect); expect(hypothesisSelectionAnchor(anchor, document)).toEqual({left: 30, top: 40, bottom: 100});
        toolbar.getBoundingClientRect = () => ({top: 105, bottom: 140, width: 100, height: 35} as DOMRect); expect(hypothesisSelectionAnchor(anchor, document)).toEqual({left: 30, top: 80, bottom: 140});
        expect(anchor).toEqual({left: 30, top: 80, bottom: 100}); expect(adder.isConnected).toBe(true);
    });
});
