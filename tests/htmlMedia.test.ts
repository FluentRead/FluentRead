import {afterEach, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createHtmlMediaHost, htmlMediaForPlayer, mountWhenHtmlMediaPresent, playerOwnsMedia} from '@/src/features/video-subtitle/content/htmlMedia';

afterEach(() => vi.unstubAllGlobals());

function fixture(markup = '') {
    const {document, window} = parseHTML(`<!doctype html><html><body>${markup}</body></html>`);
    let mutation!: MutationCallback;
    let resize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    Object.assign(window, {innerWidth: 900, innerHeight: 700,
        requestAnimationFrame: (callback: FrameRequestCallback) => {frames.set(++sequence, callback); return sequence;},
        cancelAnimationFrame: (id: number) => frames.delete(id), getComputedStyle: (element: HTMLElement) => ({visibility: element.style.visibility || 'visible'}),
    });
    vi.stubGlobal('MutationObserver', class {constructor(callback: MutationCallback) {mutation = callback;} observe() {} disconnect = disconnect;});
    vi.stubGlobal('ResizeObserver', class {constructor(callback: ResizeObserverCallback) {resize = callback;} observe() {} disconnect() {}});
    const flush = () => {const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(0));};
    const notify = (addedNodes: Node[] = [], removedNodes: Node[] = []) => mutation([{addedNodes, removedNodes}] as unknown as MutationRecord[], {} as MutationObserver);
    const media = (tag: 'audio' | 'video' = 'audio') => {
        const node = document.createElement(tag) as HTMLMediaElement;
        let rect = {left: 20, top: 50, right: 420, bottom: 104, width: 400, height: 54};
        Object.defineProperty(node, 'getBoundingClientRect', {value: () => rect});
        document.body.appendChild(node);
        return {node, bounds: (next: Partial<typeof rect>) => {rect = {...rect, ...next};}};
    };
    return {document, window, frames, disconnect, flush, notify, media, resize: () => resize([], {} as ResizeObserver)};
}

it('mounts once on media insertion, ignores unrelated text and owned scans, and unmounts on removal', () => {
    const f = fixture(); const unmount = vi.fn(), mount = vi.fn(() => unmount);
    const dispose = mountWhenHtmlMediaPresent(mount, f.document);
    const text = f.document.createTextNode('unrelated'); f.notify([text]); expect(f.frames.size).toBe(0);
    const scan = f.document.createElement('video'); scan.className = 'fluent-read-video-ui'; f.document.body.appendChild(scan);
    f.notify([scan]); expect(f.frames.size).toBe(0);
    const {node} = f.media(); f.notify([node]); f.notify([node]); expect(f.frames.size).toBe(1);
    f.flush(); expect(mount).toHaveBeenCalledOnce();
    f.notify([node]); f.flush(); expect(mount).toHaveBeenCalledOnce();
    node.remove(); f.notify([], [node]); f.flush(); expect(unmount).toHaveBeenCalledOnce();
    dispose(); expect(unmount).toHaveBeenCalledOnce(); expect(f.disconnect).toHaveBeenCalledOnce();
});

it('finds nested media on initial mount and cancels pending work when destroyed', () => {
    const f = fixture('<section><video></video></section>'); const unmount = vi.fn(), mount = vi.fn(() => unmount);
    const dispose = mountWhenHtmlMediaPresent(mount, f.document); expect(mount).toHaveBeenCalledOnce();
    f.notify([f.document.body]); expect(f.frames.size).toBe(1);
    dispose(); expect(f.frames.size).toBe(0); expect(unmount).toHaveBeenCalledOnce();
    f.flush(); expect(mount).toHaveBeenCalledOnce();
});

it('owns a dock without reparenting media, follows layout and fullscreen, and releases all resources', () => {
    const f = fixture(); const audio = f.media(); const video = f.media('video');
    const layout = vi.fn(); const owner = createHtmlMediaHost(layout, f.document);
    const parent = audio.node.parentElement;
    const host = owner.getPlayer(audio.node);
    expect(host.dataset.mediaKind).toBe('audio'); expect(Number.parseFloat(host.style.top)).toBe(Number.parseFloat('108px'));
    expect(htmlMediaForPlayer(host)).toBe(audio.node); expect(playerOwnsMedia(host, audio.node)).toBe(true);
    expect(playerOwnsMedia(host, video.node)).toBe(false); expect(playerOwnsMedia(f.document.body, audio.node)).toBe(true);
    expect(audio.node.parentElement).toBe(parent);
    audio.bounds({bottom: 204}); f.resize(); f.resize(); expect(f.frames.size).toBe(1);
    f.flush(); expect(Number.parseFloat(host.style.top)).toBe(Number.parseFloat('208px')); expect(layout).toHaveBeenCalledOnce();
    owner.getPlayer(video.node); expect(host.dataset.mediaKind).toBe('video'); expect(Number.parseFloat(host.style.top)).toBe(Number.parseFloat('50px'));
    const fullscreen = f.document.createElement('section'); f.document.body.appendChild(fullscreen); fullscreen.appendChild(video.node);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: fullscreen});
    owner.getPlayer(video.node); expect(host.parentElement).toBe(fullscreen);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: video.node});
    owner.getPlayer(video.node); expect(host.parentElement).toBe(f.document.documentElement);
    video.bounds({right: 0}); owner.getPlayer(video.node); expect(host.hidden).toBe(true);
    f.resize(); owner.destroy(); expect(f.frames.size).toBe(0); expect(host.isConnected).toBe(false);
    expect(htmlMediaForPlayer(host)).toBeUndefined();
    f.document.dispatchEvent(new f.window.Event('scroll')); f.window.dispatchEvent(new f.window.Event('resize'));
    expect(f.frames.size).toBe(0);
});

it('uses visual viewport bounds and hides disconnected, zero-size or invisible media', () => {
    const f = fixture(); const audio = f.media(); const viewport = new f.window.EventTarget();
    Object.assign(viewport, {offsetLeft: 30, width: 300});
    Object.defineProperty(f.window, 'visualViewport', {configurable: true, value: viewport});
    const owner = createHtmlMediaHost(vi.fn(), f.document); const host = owner.getPlayer(audio.node);
    expect(Number.parseFloat(host.style.left)).toBe(Number.parseFloat('30px')); expect(Number.parseFloat(host.style.width)).toBe(Number.parseFloat('300px'));
    audio.node.style.visibility = 'hidden'; owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    audio.node.style.visibility = 'visible'; audio.bounds({width: 0}); owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    audio.bounds({width: 400, height: 0}); owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    audio.bounds({height: 54, bottom: -1}); owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    audio.bounds({bottom: 800, top: 750}); owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    audio.node.remove(); owner.getPlayer(audio.node); expect(host.hidden).toBe(true);
    viewport.dispatchEvent(new f.window.Event('scroll')); expect(f.frames.size).toBe(1);
    f.flush(); owner.destroy(); viewport.dispatchEvent(new f.window.Event('resize')); expect(f.frames.size).toBe(0);
});


it('rejects stale discovery and layout callbacks after disposal, including a host that has not selected media', () => {
    const f = fixture(); const mount = vi.fn(() => vi.fn());
    const dispose = mountWhenHtmlMediaPresent(mount, f.document);
    const {node} = f.media(); f.notify([node]); const discovery = [...f.frames.values()][0]!;
    dispose(); discovery(0); expect(mount).not.toHaveBeenCalled();
    const layout = vi.fn(); const owner = createHtmlMediaHost(layout, f.document);
    f.resize(); f.flush(); expect(layout).not.toHaveBeenCalled();
    owner.getPlayer(node); f.resize(); const late = [...f.frames.values()][0]!;
    owner.destroy(); late(0); expect(layout).not.toHaveBeenCalled();
});
