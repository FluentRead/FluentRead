import {afterEach, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    createHtmlMediaHost,
    htmlMediaForPlayer,
    isEligibleHtmlMedia,
    isExcludedHtmlMediaHost,
    isExcludedHtmlMediaUrl,
    mountWhenHtmlMediaPresent,
    playerOwnsMedia,
} from '@/src/features/video-subtitle/content/htmlMedia';

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
        cancelAnimationFrame: (id: number) => frames.delete(id),
        getComputedStyle: (element: HTMLElement) => ({
            display: element.style.display || 'block',
            visibility: element.style.visibility || 'visible',
            opacity: element.style.opacity || '1',
            overflow: element.style.overflow || '',
            overflowX: element.style.overflowX || '',
            overflowY: element.style.overflowY || '',
        }),
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

it('discovers open Shadow DOM media, handles webkit fullscreen and guards ResizeObserver availability', () => {
    const f = fixture();
    const mount = vi.fn(() => vi.fn());
    const dispose = mountWhenHtmlMediaPresent(mount, f.document);
    expect(mount).not.toHaveBeenCalled();
    const shadowHost = f.document.createElement('div');
    const shadow = shadowHost.attachShadow({mode: 'open'});
    const shadowVideo = f.document.createElement('video') as unknown as HTMLMediaElement;
    Object.defineProperty(shadowVideo, 'getBoundingClientRect', {value: () => ({left: 10, top: 20, right: 310, bottom: 200, width: 300, height: 180})});
    shadow.appendChild(shadowVideo);
    f.document.body.appendChild(shadowHost);
    f.notify([shadowHost]); f.flush();
    expect(mount).toHaveBeenCalledOnce();
    dispose();

    // 1) view.ResizeObserver 存在时优先使用并响应 webkitfullscreenchange
    const observe = vi.fn(), roDisconnect = vi.fn();
    let viewResize!: () => void;
    Object.defineProperty(f.window, 'ResizeObserver', {
        configurable: true,
        value: class {
            constructor(cb: () => void) { viewResize = cb; }
            observe = observe;
            disconnect = roDisconnect;
        },
    });
    const layout = vi.fn();
    const video = f.media('video');
    const fsWrap = f.document.createElement('section');
    f.document.body.appendChild(fsWrap);
    fsWrap.appendChild(video.node);
    const owner = createHtmlMediaHost(layout, f.document);
    const host = owner.getPlayer(video.node);
    expect(observe).toHaveBeenCalledWith(video.node);
    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: fsWrap});
    f.document.dispatchEvent(new f.window.Event('webkitfullscreenchange'));
    f.flush();
    expect(host.parentElement).toBe(fsWrap);
    viewResize(); f.flush();
    expect(layout).toHaveBeenCalledTimes(2);
    owner.destroy();
    expect(roDisconnect).toHaveBeenCalled();

    // 2) 容器全屏包裹开放 Shadow DOM 媒体时通过 containsDeep 挂载浮层并判定归属
    const shadowFsWrap = f.document.createElement('section');
    const shadowFsHost = f.document.createElement('div');
    const shadowFsRoot = shadowFsHost.attachShadow({mode: 'open'});
    const shadowFsVideo = f.document.createElement('video') as unknown as HTMLMediaElement;
    Object.defineProperty(shadowFsVideo, 'getBoundingClientRect', {value: () => ({left: 10, top: 20, right: 310, bottom: 200, width: 300, height: 180})});
    shadowFsRoot.appendChild(shadowFsVideo);
    shadowFsWrap.appendChild(shadowFsHost);
    f.document.body.appendChild(shadowFsWrap);
    expect(playerOwnsMedia(shadowFsWrap, shadowFsVideo)).toBe(true);
    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: shadowFsWrap});
    const shadowOwner = createHtmlMediaHost(vi.fn(), f.document);
    expect(shadowOwner.getPlayer(shadowFsVideo).parentElement).toBe(shadowFsWrap);
    shadowOwner.destroy();

    // 3) view 与 globalThis 均缺少 ResizeObserver 时安全降级不抛错
    Object.defineProperty(f.window, 'ResizeObserver', {configurable: true, value: undefined});
    vi.stubGlobal('ResizeObserver', undefined);
    const fallbackOwner = createHtmlMediaHost(vi.fn(), f.document);
    expect(fallbackOwner.getPlayer(video.node).dataset.mediaKind).toBe('video');
    fallbackOwner.destroy();
});

it('excludes domestic short-video/streaming hosts and ambient muted preview videos', () => {
    expect(isExcludedHtmlMediaHost('')).toBe(false);
    expect(isExcludedHtmlMediaHost('douyin.com')).toBe(true);
    expect(isExcludedHtmlMediaHost('www.douyin.com.')).toBe(true);
    expect(isExcludedHtmlMediaHost('live.bilibili.com')).toBe(true);
    expect(isExcludedHtmlMediaHost('www.xiaohongshu.com')).toBe(true);
    expect(isExcludedHtmlMediaHost('notdouyin.com')).toBe(false);
    expect(isExcludedHtmlMediaUrl('')).toBe(false);
    expect(isExcludedHtmlMediaUrl('not-a-valid-url')).toBe(false);
    expect(isExcludedHtmlMediaUrl('https://www.douyin.com/jingxuan/search/demo')).toBe(true);
    expect(isExcludedHtmlMediaUrl('https://podcast.example/episode')).toBe(false);

    const f = fixture('<div id="plain"></div><video id="preview" muted autoplay></video><video id="loop" muted loop></video><video id="controlled" controls muted autoplay></video><video id="tracked" muted autoplay><track kind="subtitles"></video><video id="texttrack" muted loop></video><video id="subtrack" muted loop></video><video id="normal" autoplay></video><audio id="podcast"></audio><div class="fluent-read-video-ui"><audio id="owned"></audio></div>');
    const textTrackVideo = f.document.getElementById('texttrack') as HTMLVideoElement;
    Object.defineProperty(textTrackVideo, 'textTracks', {configurable: true, value: [{kind: 'captions'}]});
    const subTrackVideo = f.document.getElementById('subtrack') as HTMLVideoElement;
    Object.defineProperty(subTrackVideo, 'textTracks', {configurable: true, value: [{kind: 'subtitles'}]});
    expect(isEligibleHtmlMedia(f.document.getElementById('plain')!)).toBe(false);
    expect(isEligibleHtmlMedia(f.document.getElementById('owned')!)).toBe(false);
    expect(isEligibleHtmlMedia(f.document.getElementById('podcast')!)).toBe(true);
    expect(isEligibleHtmlMedia(f.document.getElementById('preview')!)).toBe(false);
    expect(isEligibleHtmlMedia(f.document.getElementById('loop')!)).toBe(false);
    expect(isEligibleHtmlMedia(f.document.getElementById('controlled')!)).toBe(true);
    expect(isEligibleHtmlMedia(f.document.getElementById('tracked')!)).toBe(true);
    expect(isEligibleHtmlMedia(textTrackVideo)).toBe(true);
    expect(isEligibleHtmlMedia(subTrackVideo)).toBe(true);
    expect(isEligibleHtmlMedia(f.document.getElementById('normal')!)).toBe(true);

    const ambientOnly = fixture('<video muted autoplay></video>');
    const mount = vi.fn(() => vi.fn());
    const dispose = mountWhenHtmlMediaPresent(mount, ambientOnly.document);
    expect(mount).not.toHaveBeenCalled();
    dispose();
});

it('clips video host to overflow ancestors and visual viewport, hides transparent media, and skips redundant cssText writes', () => {
    const f = fixture('<div id="zero" style="overflow:hidden"><div id="clip-x" style="overflow-x:hidden"><div id="clip-y" style="overflow-y:auto"><div id="wrap"><video></video></div></div></div></div>');
    const zero = f.document.getElementById('zero')!;
    const clipX = f.document.getElementById('clip-x')!;
    const clipY = f.document.getElementById('clip-y')!;
    const video = f.document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(zero, 'getBoundingClientRect', {configurable: true, value: () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0})});
    Object.defineProperty(clipX, 'getBoundingClientRect', {configurable: true, value: () => ({left: 40, top: 0, right: 360, bottom: 500, width: 320, height: 500})});
    Object.defineProperty(clipY, 'getBoundingClientRect', {configurable: true, value: () => ({left: 0, top: 100, right: 500, bottom: 300, width: 500, height: 200})});
    let rect = {left: 20.4, top: 60.2, right: 420.6, bottom: 340.8, width: 400.2, height: 280.6};
    Object.defineProperty(video, 'getBoundingClientRect', {configurable: true, value: () => rect});
    const viewport = new f.window.EventTarget();
    Object.assign(viewport, {offsetLeft: 10, offsetTop: 20, width: 800, height: 600});
    Object.defineProperty(f.window, 'visualViewport', {configurable: true, value: viewport});

    const owner = createHtmlMediaHost(vi.fn(), f.document);
    const host = owner.getPlayer(video);
    expect(host.hidden).toBe(false);
    expect(Number.parseFloat(host.style.left)).toBe(40);
    expect(Number.parseFloat(host.style.top)).toBe(100);
    expect(Number.parseFloat(host.style.width)).toBe(320);
    expect(Number.parseFloat(host.style.height)).toBe(200);

    const setAttr = vi.spyOn(host, 'setAttribute');
    owner.getPlayer(video);
    expect(setAttr.mock.calls.filter(([name]) => name === 'style')).toHaveLength(0);

    video.style.opacity = '0';
    owner.getPlayer(video);
    expect(host.hidden).toBe(true);
    video.style.opacity = '1';
    video.style.display = 'none';
    owner.getPlayer(video);
    expect(host.hidden).toBe(true);
    video.style.display = 'block';
    rect = {left: 500, top: 500, right: 700, bottom: 650, width: 200, height: 150};
    owner.getPlayer(video);
    expect(host.hidden).toBe(true);
    expect(setAttr.mock.calls.filter(([name]) => name === 'style')).toHaveLength(1);
    owner.destroy();
});
