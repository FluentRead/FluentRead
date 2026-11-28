/**
 * @file tests/videoPlayerLocator.test.ts
 * 文件职责：验证视频定位器在 X 信息流、当前帖子与全屏切换中的选择和身份稳定性。
 * 主要内容：覆盖用户意图优先、多视频不猜测、源切换刷新身份和销毁监听器。
 * 模块边界：只测试 DOM 定位，不启动字幕、翻译或浏览器扩展运行时。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createVideoPlayerLocator, getVideoPlayerForVideo, selectVideoPlayerTarget} from '@/src/features/video-subtitle/content/videoPlayerLocator';

function setup(markup: string, url = 'https://x.com/cerebras') {
  const parsed = parseHTML(`<!doctype html><body>${markup}</body>`);
  const rawWindow = parsed.window;
  const view = new Proxy(rawWindow, {
    get(target, property, receiver) {
      if (property === 'location') return new URL(url);
      return Reflect.get(target, property, receiver);
    },
  }) as Window;
  vi.stubGlobal('window', view);
  vi.stubGlobal('document', parsed.document);
  vi.stubGlobal('Element', (rawWindow as unknown as {Element: typeof Element}).Element);
  vi.stubGlobal('HTMLVideoElement', (rawWindow as unknown as {HTMLVideoElement: typeof HTMLVideoElement}).HTMLVideoElement);
  vi.stubGlobal('MutationObserver', class {
    observe() {}
    disconnect() {}
  });
  for (const video of Array.from(parsed.document.querySelectorAll('video, audio'))) {
    Object.defineProperty(video, 'getBoundingClientRect', {configurable: true, value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
    Object.defineProperty(video, 'offsetWidth', {configurable: true, value: 640});
    Object.defineProperty(video, 'offsetHeight', {configurable: true, value: 360});
  }
  for (const anchor of Array.from(parsed.document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!/\/status\/\d+\/video\/\d+\/?$/i.test(anchor.getAttribute('href') || '')) continue;
    Object.defineProperty(anchor, 'getBoundingClientRect', {configurable: true, value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
  }
  return {document: parsed.document, window: view, videos: Array.from(parsed.document.querySelectorAll('video, audio')) as HTMLVideoElement[]};
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('does not infer a video from a shared native player control when the known player contains two videos',()=>{
  const f=setup('<div class="html5-video-player"><video></video><video></video><button id="shared-control">Settings</button></div>','https://x.com/home');
  const locator=createVideoPlayerLocator({document:f.document,window:f.window,isXPage:()=>true});
  f.document.querySelector('#shared-control')!.dispatchEvent(new (f.window as unknown as {Event:typeof Event}).Event('pointerover',{bubbles:true}));
  expect(locator.getTarget()).toBeNull();locator.destroy();
});

describe('video player locator', () => {
  it('ignores native caption span churn but observes media visibility, source and reparenting', () => {
    vi.useFakeTimers();
    const fixture = setup('<div id="movie_player"><video></video><div class="captions"><span>Words</span></div></div>', 'https://www.youtube.com/watch?v=fixture');
    let notify!: MutationCallback;
    const frameState: {callback?: () => void} = {};
    const flushFrame = () => {
      frameState.callback?.();
      frameState.callback = undefined;
    };
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true,
      value: (callback: () => void) => { frameState.callback = callback; return 12; }});
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { notify = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window});
    const original = locator.sync()!;
    const scans = vi.spyOn(fixture.document, 'querySelectorAll');
    const caption = fixture.document.querySelector('.captions')!;
    const mutation = (record: object) => notify([record] as MutationRecord[], {} as MutationObserver);
    scans.mockClear();
    for (let index = 0; index < 180; index += 1) {
      mutation({type: 'childList', target: caption, addedNodes: [fixture.document.createElement('span')], removedNodes: []});
      vi.advanceTimersByTime(16);
    }
    expect(frameState.callback).toBeUndefined();
    expect(scans).not.toHaveBeenCalledWith('video');
    // 无关 control 属性和同值 class 写入也不能转为布局重扫。
    mutation({type: 'attributes', target: caption, attributeName: 'class', oldValue: 'captions', addedNodes: [], removedNodes: []});
    caption.setAttribute('class', 'captions-new');
    mutation({type: 'attributes', target: caption, attributeName: 'class', oldValue: 'captions', addedNodes: [], removedNodes: []});
    const owned = fixture.document.createElement('div'); owned.className = 'fluent-read-video-ui';
    mutation({type: 'attributes', target: owned, attributeName: 'style', oldValue: '', addedNodes: [], removedNodes: []});
    notify([
      {type: 'attributes', target: fixture.document.createTextNode('invalid attribute target'), addedNodes: [], removedNodes: []},
      {type: 'attributes', target: owned, attributeName: 'style', oldValue: '', addedNodes: [], removedNodes: []},
    ] as unknown as MutationRecord[], {} as MutationObserver);
    expect(frameState.callback).toBeUndefined();
    fixture.videos[0].setAttribute('src', 'blob:new-source');
    mutation({type: 'attributes', target: fixture.videos[0], attributeName: 'src', oldValue: null, addedNodes: [], removedNodes: []});
    flushFrame();
    expect(locator.getTarget()?.key).not.toBe(original.key);
    const player = fixture.document.getElementById('movie_player')!;
    player.setAttribute('style', 'display:none');
    mutation({type: 'attributes', target: player, attributeName: 'style', oldValue: null, addedNodes: [], removedNodes: []});
    expect(frameState.callback).toBeTypeOf('function'); flushFrame();
    const replacement = fixture.document.createElement('div'); replacement.className = 'html5-video-player';
    fixture.document.body.appendChild(replacement); replacement.appendChild(fixture.videos[0]);
    mutation({type: 'childList', target: player, addedNodes: [], removedNodes: [fixture.videos[0]]});
    flushFrame();
    expect(locator.getTarget()?.player).toBe(replacement);
    locator.destroy(); scans.mockRestore();
  });

  it('refreshes source and track children immediately without treating an unrelated source as video content', () => {
    const fixture = setup('<div id="movie_player"><video><source src="blob:first"><track src="captions-first.vtt"></video></div>', 'https://www.youtube.com/watch?v=fixture');
    let notify!: MutationCallback;
    const frameState: {callback?: () => void} = {};
    const flushFrame = () => { frameState.callback?.(); frameState.callback = undefined; };
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true,
      value: (callback: () => void) => { frameState.callback = callback; return 14; }});
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { notify = callback; }
      observe() {}
      disconnect() {}
    });
    const source = fixture.document.querySelector('source')!;
    Object.defineProperty(fixture.videos[0], 'currentSrc', {configurable: true, get: () => source.isConnected ? source.getAttribute('src') : ''});
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window});
    const original = locator.sync()!;
    const mutation = (record: object) => notify([record] as MutationRecord[], {} as MutationObserver);
    source.setAttribute('src', 'blob:updated');
    mutation({type: 'attributes', target: source, attributeName: 'src', oldValue: 'blob:first', addedNodes: [], removedNodes: []});
    expect(frameState.callback).toBeTypeOf('function'); flushFrame();
    expect(locator.getTarget()?.key).not.toBe(original.key);
    const track = fixture.document.querySelector('track')!;
    track.setAttribute('src', 'captions-updated.vtt');
    mutation({type: 'attributes', target: track, attributeName: 'src', oldValue: 'captions-first.vtt', addedNodes: [], removedNodes: []});
    expect(frameState.callback).toBeTypeOf('function'); flushFrame();
    source.remove();
    mutation({type: 'childList', target: fixture.videos[0], addedNodes: [], removedNodes: [source]});
    expect(frameState.callback).toBeTypeOf('function'); flushFrame();
    mutation({type: 'attributes', target: source, attributeName: 'src', oldValue: null, addedNodes: [], removedNodes: []});
    expect(frameState.callback).toBeUndefined();
    locator.destroy();
  });

  it('resolves deeply nested media overlays while ignoring equally nested adjacent post text', () => {
    const nested = (id: string) => '<span>'.repeat(10) + `<span id="${id}">Media</span>` + '</span>'.repeat(10);
    const {document, window, videos} = setup(`<article><div class="media"><video></video><a href="/proof/status/111/video/1">${nested('media-link')}</a></div><p>${nested('post-text')}</p></article>`);
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    const pointer = (id: string) => document.getElementById(id)!.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    pointer('post-text');
    expect(locator.getTarget()).toBeNull();
    pointer('media-link');
    expect(locator.getTarget()?.video).toBe(videos[0]);
    locator.destroy();
  });

  it('new video interaction overrides keyboard focus left in the previous video menu', () => {
    const {document, window, videos} = setup('<article><div data-testid="videoPlayer"><video></video><button id="old-menu">Retry A</button></div></article><article><div data-testid="videoPlayer"><video></video></div></article>');
    Object.defineProperty(document, 'activeElement', {configurable: true, value: document.getElementById('old-menu')});
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    expect(locator.sync()?.video).toBe(videos[0]);
    videos[1].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(videos[1]);
    expect(locator.sync()?.video).toBe(videos[1]);
    locator.destroy();
  });

  it('keeps the actual YouTube player when the document or an outer wrapper enters fullscreen', () => {
    const {document, window, videos} = setup('<main><div id="movie_player"><video></video><div class="ytp-right-controls"></div></div></main>', 'https://www.youtube.com/watch?v=fixture');
    const locator = createVideoPlayerLocator({document, window});
    const initial = locator.sync()!;
    for (const fullscreen of [document.documentElement, document.querySelector('main'), initial.player, null]) {
      Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: fullscreen});
      document.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('fullscreenchange'));
      expect(locator.getTarget()?.player).toBe(document.getElementById('movie_player'));
      expect(locator.getTarget()?.key).toBe(initial.key);
      expect(locator.getTarget()?.fullscreen).toBe(Boolean(fullscreen));
      expect(getVideoPlayerForVideo(videos[0], window)).toBe(initial.player);
    }
    locator.destroy();
  });

  it('uses an inner fullscreen container when it excludes the outer YouTube player', () => {
    const {document, window, videos} = setup('<div id="movie_player"><div id="inner"><video></video></div></div>', 'https://www.youtube.com/watch?v=fixture');
    const inner = document.getElementById('inner');
    Object.defineProperty(document, 'fullscreenElement', {value: inner});
    expect(getVideoPlayerForVideo(videos[0], window)).toBe(inner);
  });

  it('does not rescan the document for duplicate pointer, mouse and focus events in the same video', () => {
    const {document, window, videos} = setup('<article><div><video></video></div></article><article><div><video></video></div></article>');
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    const scan = vi.spyOn(document, 'querySelectorAll');
    const emit = (video: HTMLVideoElement, type: string) => video.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event(type, {bubbles: true}));
    emit(videos[0], 'pointerover');
    scan.mockClear();
    for (let i = 0; i < 20; i += 1) {
      emit(videos[0], 'pointerover'); emit(videos[0], 'mouseover'); emit(videos[0], 'focusin');
    }
    expect(scan).not.toHaveBeenCalledWith('video');
    emit(videos[1], 'pointerover');
    expect(scan).toHaveBeenCalledWith('video');
    expect(locator.getTarget()?.video).toBe(videos[1]);
    locator.destroy();
    scan.mockRestore();
  });
  it('does not guess the first video in an X feed and selects the hovered video', () => {
    const {document, window, videos} = setup('<article><div class="one"><video></video></div></article><article><div class="two"><video></video></div></article>');
    expect(selectVideoPlayerTarget(document, {window, isXPage: true})).toBeNull();

    videos[1].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    // The event listener is installed by the locator, so a second event records intent.
    videos[1].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(videos[1]);
    locator.destroy();
  });

  it('selects a generic player through its overlay without treating adjacent post text as video intent', () => {
    const {document, window, videos} = setup('<section><p id="text">Post text</p><div id="one"><video></video><button id="overlay-one"><span>Play</span></button></div></section><section><div id="two"><video></video><button id="overlay-two">Play</button></div></section>');
    for (const id of ['one', 'two']) document.getElementById(id)!.getBoundingClientRect = () => ({width: 640, height: 360}) as DOMRect;
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    const emit = (id: string) => document.getElementById(id)!.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    emit('text');
    expect(locator.getTarget()).toBeNull();
    emit('overlay-two');
    expect(locator.getTarget()?.video).toBe(videos[1]);
    emit('text');
    expect(locator.getTarget()?.video).toBe(videos[1]);
    emit('overlay-one');
    expect(locator.getTarget()?.video).toBe(videos[0]);
    locator.destroy();
  });

  it('clears current interaction after leaving while retaining the selected feed video', () => {
    const {document, window, videos} = setup('<article><div class="one"><video></video></div></article>');
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    videos[0].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.interacting).toBe(true);
    const out = new (window as unknown as {Event: typeof Event}).Event('pointerout', {bubbles: true});
    Object.defineProperty(out, 'relatedTarget', {value: document.body});
    videos[0].dispatchEvent(out);
    expect(locator.getTarget()?.video).toBe(videos[0]);
    expect(locator.getTarget()?.interacting).toBe(false);
    locator.destroy();
  });

  it('clears focus interaction after focus leaves while retaining the selected video', () => {
    const {document, window, videos} = setup('<article><div class="one"><video></video><button></button></div></article>');
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    videos[0].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('focusin', {bubbles: true}));
    expect(locator.getTarget()?.interacting).toBe(true);
    const focusOut = new (window as unknown as {Event: typeof Event}).Event('focusout', {bubbles: true});
    Object.defineProperty(focusOut, 'relatedTarget', {value: document.body});
    videos[0].dispatchEvent(focusOut);
    expect(locator.getTarget()?.video).toBe(videos[0]);
    expect(locator.getTarget()?.interacting).toBe(false);
    locator.destroy();
  });

  it('prefers the current status media even when an earlier post is present', () => {
    const {document, window, videos} = setup(
      '<main><article><div><video></video><a href="/someone/status/9/video/1"></a></div></article>'
      + '<article><div class="current"><video></video><a href="/cerebras/status/2089870131291943228/video/1"></a></div></article>',
      'https://x.com/cerebras/status/2089870131291943228',
    );
    const target = selectVideoPlayerTarget(document, {window, isXPage: true});
    expect(target?.video).toBe(videos[1]);
    expect(target?.player.className).toBe('current');
  });

  it('promotes an X overlay container so fullscreen sibling controls share the same host', () => {
    const {document, window, videos} = setup(
      '<article><div class="outer"><div class="inner"><video></video></div><button aria-label="Settings"></button><a href="/cerebras/status/2089870131291943228/video/1"></a></div></article>',
      'https://x.com/cerebras/status/2089870131291943228',
    );
    const outer = document.querySelector('.outer');
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: outer});
    const target = selectVideoPlayerTarget(document, {window, isXPage: true});
    expect(target?.video).toBe(videos[0]);
    expect(target?.player).toBe(outer);
  });

  it('maps overlay and native control interaction back to the owning video', () => {
    const {document, window, videos} = setup(
      '<article><div class="outer"><div class="inner"><video></video></div><button aria-label="Settings"></button><a href="/cerebras/status/2089870131291943228/video/1"></a></div></article>',
      'https://x.com/cerebras/status/2089870131291943228',
    );
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    const settings = document.querySelector('button')!;
    settings.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(videos[0]);
    locator.destroy();
  });

  it('resolves controls in a known player and ignores a fullscreen host with multiple videos', () => {
    const known = setup('<div class="html5-video-player"><video></video><button id="control"></button></div>');
    const locator = createVideoPlayerLocator({document: known.document, window: known.window, isXPage: () => false});
    known.document.querySelector('#control')!.dispatchEvent(new (known.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(known.videos[0]);
    locator.destroy();

    const fullscreen = setup('<div class="fullscreen"><video></video><video></video><span id="control"></span></div>');
    Object.defineProperty(fullscreen.document, 'fullscreenElement', {configurable: true, value: fullscreen.document.querySelector('.fullscreen')});
    Object.defineProperty(fullscreen.videos[0], 'webkitDisplayingFullscreen', {configurable: true, value: true});
    const multi = createVideoPlayerLocator({document: fullscreen.document, window: fullscreen.window, isXPage: () => false});
    expect(multi.sync()?.video).toBe(fullscreen.videos[0]);
    fullscreen.document.querySelector('#control')!.dispatchEvent(new (fullscreen.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(multi.getTarget()?.video).toBe(fullscreen.videos[0]);
    multi.destroy();

    const unselected = createVideoPlayerLocator({document: fullscreen.document, window: fullscreen.window, isXPage: () => false});
    fullscreen.document.querySelector('#control')!.dispatchEvent(new (fullscreen.window as unknown as {Event: typeof Event}).Event('focusin', {bubbles: true}));
    expect(unselected.getTarget()).toBeNull();
    unselected.destroy();

    const single = setup('<div class="single-fullscreen"><video></video><span id="control"></span></div>');
    Object.defineProperty(single.document, 'fullscreenElement', {configurable: true, value: single.document.querySelector('.single-fullscreen')});
    const singleLocator = createVideoPlayerLocator({document: single.document, window: single.window, isXPage: () => false});
    single.document.querySelector('#control')!.dispatchEvent(new (single.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(singleLocator.getTarget()?.video).toBe(single.videos[0]);
    singleLocator.destroy();
  });

  it('keeps the same video identity across fullscreen and refreshes it after source replacement', () => {
    const {document, window, videos} = setup('<div class="player"><video src="blob:https://x.com/one"></video></div>');
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    const first = locator.sync();
    expect(first).not.toBeNull();
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: videos[0].parentElement});
    document.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('fullscreenchange'));
    expect(locator.getTarget()?.video).toBe(videos[0]);
    expect(locator.getTarget()?.fullscreen).toBe(true);

    Object.defineProperty(videos[0], 'currentSrc', {configurable: true, value: 'blob:https://x.com/two'});
    const next = locator.sync();
    expect(next?.video).toBe(videos[0]);
    expect(next?.key).not.toBe(first?.key);
    locator.destroy();
  });

  it('notifies only on selected target changes and detaches cleanly', () => {
    const {document, window, videos} = setup('<div><video></video></div>');
    const locator = createVideoPlayerLocator({document, window, isXPage: () => false});
    const changes: Array<string | null> = [];
    const unsubscribe = locator.subscribe((target) => changes.push(target?.key || null));
    locator.sync();
    locator.sync();
    expect(changes).toHaveLength(1);
    unsubscribe();
    locator.destroy();
    videos[0].dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(changes).toHaveLength(1);
  });

  it('climbs to the first visible containing block when the video wrapper has no geometry', () => {
    const {document, window, videos} = setup('<div class="outer"><div class="inner"><video></video></div></div>');
    const outer = document.querySelector<HTMLElement>('.outer')!;
    const inner = document.querySelector<HTMLElement>('.inner')!;
    Object.defineProperty(videos[0], 'getBoundingClientRect', {configurable: true, value: () => ({width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0})});
    Object.defineProperty(videos[0], 'offsetWidth', {configurable: true, value: 0});
    Object.defineProperty(videos[0], 'offsetHeight', {configurable: true, value: 0});
    Object.defineProperty(inner, 'getBoundingClientRect', {configurable: true, value: () => ({width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0})});
    Object.defineProperty(outer, 'getBoundingClientRect', {configurable: true, value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
    Object.defineProperty(outer, 'offsetWidth', {configurable: true, value: 640});
    Object.defineProperty(outer, 'offsetHeight', {configurable: true, value: 360});
    // The video itself must remain a candidate even though its wrapper is laid out later.
    Object.defineProperty(videos[0], 'offsetWidth', {configurable: true, value: 640});
    Object.defineProperty(videos[0], 'offsetHeight', {configurable: true, value: 360});
    const target = selectVideoPlayerTarget(document, {window, isXPage: false});
    expect(target?.player).toBe(outer);
  });

  it('handles hidden videos, malformed links, and webkit fullscreen without throwing', () => {
    const hidden = setup('<div><video></video></div>', 'https://x.com/cerebras/status/2089870131291943228');
    const hiddenWindow = new Proxy(hidden.window, {
      get(target, property, receiver) {
        if (property === 'getComputedStyle') return () => ({display: 'none', visibility: '', contentVisibility: ''});
        return Reflect.get(target, property, receiver);
      },
    }) as Window;
    expect(selectVideoPlayerTarget(hidden.document, {window: hiddenWindow, isXPage: true})).toBeNull();

    const malformed = setup('<article><div><video></video><a href="%bad"></a><a></a></div></article>', 'https://x.com/cerebras/status/2089870131291943228');
    const malformedLink = malformed.document.querySelector('a')!;
    malformedLink.getAttribute = (() => { throw new Error('invalid href'); }) as typeof malformedLink.getAttribute;
    const malformedTarget = selectVideoPlayerTarget(malformed.document, {window: malformed.window, isXPage: true});
    expect(malformedTarget?.video).toBe(malformed.videos[0]);
    Object.defineProperty(malformed.videos[0], 'webkitDisplayingFullscreen', {configurable: true, value: true});
    expect(selectVideoPlayerTarget(malformed.document, {window: malformed.window, isXPage: true})?.fullscreen).toBe(true);

    const visibility = setup('<div><video></video></div>');
    const hiddenByVisibility = new Proxy(visibility.window, {
      get(target, property, receiver) {
        if (property === 'getComputedStyle') return () => ({display: '', visibility: 'hidden', contentVisibility: ''});
        return Reflect.get(target, property, receiver);
      },
    }) as Window;
    expect(selectVideoPlayerTarget(visibility.document, {window: hiddenByVisibility, isXPage: false})).toBeNull();
    const hiddenByContent = new Proxy(visibility.window, {
      get(target, property, receiver) {
        if (property === 'getComputedStyle') return () => ({display: '', visibility: '', contentVisibility: 'hidden'});
        return Reflect.get(target, property, receiver);
      },
    }) as Window;
    expect(selectVideoPlayerTarget(visibility.document, {window: hiddenByContent, isXPage: false})).toBeNull();
  });

  it('uses focused descendants and focus events to select a feed video', () => {
    const {document, window, videos} = setup('<article><div class="one"><video></video><button></button></div></article><article><div class="two"><video></video><button></button></div></article>');
    const button = document.querySelectorAll('button')[1];
    Object.defineProperty(document, 'activeElement', {configurable: true, value: button});
    const locator = createVideoPlayerLocator({document, window, isXPage: () => true});
    expect(locator.sync()?.video).toBe(videos[1]);
    document.body.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('focusin', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(videos[1]);
    document.querySelector('.two')!.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('focusin', {bubbles: true}));
    locator.destroy();
  });

  it('observes DOM and resize changes, supports absent MutationObserver, and exposes direct player lookup', () => {
    const {document, window, videos} = setup('<div class="player"><video></video></div>');
    const rawObserver = globalThis.MutationObserver;
    let mutation: ((records: MutationRecord[]) => void) | undefined;
    let frame: (() => void) | undefined;
    Object.defineProperty(window, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => { frame = callback; return 3; }});
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document, window, isXPage: () => false});
    const changes: Array<unknown> = [];
    locator.subscribe((value) => changes.push(value));
    locator.sync();
    mutation?.([]);
    mutation?.([]);
    const owned = document.createElement('div');
    owned.className = 'fluent-read-video-ui';
    mutation?.([{target: document.body, addedNodes: [owned], removedNodes: []} as unknown as MutationRecord]);
    mutation?.([{target: owned, addedNodes: [document.createTextNode('owned')], removedNodes: []} as unknown as MutationRecord]);
    mutation?.([{target: document.body, addedNodes: [document.createTextNode('external')], removedNodes: []} as unknown as MutationRecord]);
    frame?.();
    mutation?.([{target: document.body, addedNodes: [document.createElement('span')], removedNodes: []} as unknown as MutationRecord]);
    window.dispatchEvent(new (window as unknown as {Event: typeof Event}).Event('resize'));
    expect(changes.length).toBeGreaterThanOrEqual(1);
    locator.destroy();
    vi.stubGlobal('MutationObserver', undefined);
    const withoutObserver = createVideoPlayerLocator({document, window, isXPage: () => false});
    expect(withoutObserver.sync()?.video).toBe(videos[0]);
    expect(withoutObserver.getTarget()?.player).toBe(document.querySelector('.player'));
    withoutObserver.destroy();
    vi.stubGlobal('MutationObserver', rawObserver);
  });

  it('uses the timeout fallback when requestAnimationFrame is unavailable', async () => {
    const fixture = setup('<div class="player"><video></video></div>');
    const rawObserver = globalThis.MutationObserver;
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true, value: undefined});
    let mutation: ((records: MutationRecord[]) => void) | undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => false});
    mutation?.([{target: fixture.document.body, addedNodes: [fixture.document.createElement('video')], removedNodes: []} as unknown as MutationRecord]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locator.getTarget()?.video).toBe(fixture.videos[0]);
    locator.destroy();
    vi.stubGlobal('MutationObserver', rawObserver);
  });

  it('clears focus and pointer interaction on synthetic delegated leave events', () => {
    const fixture = setup('<article><div><video></video><button></button></div></article>');
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => true});
    fixture.videos[0].dispatchEvent(new (fixture.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    const relatedInside = fixture.document.querySelector('button');
    const pointerInside = new (fixture.window as unknown as {Event: typeof Event}).Event('pointerout', {bubbles: true});
    Object.defineProperty(pointerInside, 'relatedTarget', {value: relatedInside});
    fixture.videos[0].dispatchEvent(pointerInside);
    expect(locator.getTarget()?.interacting).toBe(true);
    const focusOut = new (fixture.window as unknown as {Event: typeof Event}).Event('focusout', {bubbles: true});
    Object.defineProperty(focusOut, 'relatedTarget', {value: fixture.document.body});
    fixture.videos[0].dispatchEvent(focusOut);
    Object.defineProperty(fixture.document, 'activeElement', {configurable: true, value: null});
    const pointerOutside = new (fixture.window as unknown as {Event: typeof Event}).Event('pointerout', {bubbles: true});
    Object.defineProperty(pointerOutside, 'relatedTarget', {value: fixture.document.body});
    fixture.videos[0].dispatchEvent(pointerOutside);
    expect(locator.getTarget()?.interacting).toBe(false);
    locator.destroy();
  });

  it('ignores FluentRead-owned mutation records and coalesces external records into one frame', () => {
    vi.useFakeTimers();
    const fixture = setup('<div class="player"><video></video></div>');
    const rawObserver = globalThis.MutationObserver;
    let mutation: ((records: MutationRecord[]) => void) | undefined;
    let frame: (() => void) | undefined;
    let cancelCount = 0;
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => { frame = callback; return 7; }});
    Object.defineProperty(fixture.window, 'cancelAnimationFrame', {configurable: true, value: () => { cancelCount += 1; }});
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => false});
    const owned = fixture.document.createElement('div');
    owned.className = 'fluent-read-video-ui';
    mutation?.([{target: fixture.document.body, addedNodes: [owned], removedNodes: []} as unknown as MutationRecord]);
    mutation?.([{target: owned, addedNodes: [fixture.document.createTextNode('owned')], removedNodes: []} as unknown as MutationRecord]);
    mutation?.([{target: fixture.document.body, addedNodes: [fixture.document.createTextNode('external')], removedNodes: []} as unknown as MutationRecord]);
    vi.advanceTimersByTime(250);
    expect(frame).toBeTypeOf('function');
    frame?.(); frame = undefined;
    mutation?.([{target: fixture.document.body, addedNodes: [fixture.document.createElement('video')], removedNodes: []} as unknown as MutationRecord]);
    mutation?.([{target: fixture.document.body, addedNodes: [fixture.document.createElement('video')], removedNodes: []} as unknown as MutationRecord]);
    locator.destroy();
    expect(cancelCount).toBe(1);
    vi.stubGlobal('MutationObserver', rawObserver);
  });

  it('bounds full video rescans during a busy X timeline while noticing inserted videos promptly', () => {
    vi.useFakeTimers();
    const fixture = setup('<div class="player"><video></video></div>');
    let mutation!: (records: MutationRecord[]) => void;
    let frame: (() => void) | undefined;
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true,
      value: (callback: () => void) => { frame = callback; return 9; }});
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => true});
    locator.sync();
    const scans = vi.spyOn(fixture.document, 'querySelectorAll');
    scans.mockClear();
    for (let index = 0; index < 60; index += 1) {
      mutation([{target: fixture.document.body, addedNodes: [fixture.document.createTextNode('timeline')],
        removedNodes: []} as unknown as MutationRecord]);
      vi.advanceTimersByTime(16);
      frame?.(); frame = undefined;
    }
    expect(scans.mock.calls.filter(([selector]) => selector === 'video').length).toBeLessThanOrEqual(5);

    const newContainer = fixture.document.createElement('div');
    newContainer.innerHTML = '<video></video>';
    fixture.document.body.append(newContainer);
    mutation([{target: fixture.document.body, addedNodes: [newContainer], removedNodes: []} as unknown as MutationRecord]);
    expect(frame).toBeTypeOf('function');
    const beforeInsertion = scans.mock.calls.filter(([selector]) => selector === 'video').length;
    frame?.(); frame = undefined;
    expect(scans.mock.calls.filter(([selector]) => selector === 'video').length).toBe(beforeInsertion + 1);
    vi.advanceTimersByTime(300);
    expect(frame).toBeUndefined();
    locator.destroy();
  });

  it('cancels a deferred timeline scan when the locator is destroyed', () => {
    vi.useFakeTimers();
    const fixture = setup('<div class="player"><video></video></div>');
    let mutation!: (records: MutationRecord[]) => void;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window});
    const scans = vi.spyOn(fixture.document, 'querySelectorAll');
    mutation([{target: fixture.document.body, addedNodes: [fixture.document.createTextNode('timeline')],
      removedNodes: []} as unknown as MutationRecord]);
    locator.destroy();
    vi.advanceTimersByTime(300);
    expect(scans).not.toHaveBeenCalledWith('video');
  });

  it('clears a pending timeout when requestAnimationFrame is unavailable', () => {
    vi.useFakeTimers();
    const fixture = setup('<div class="player"><video></video></div>');
    let mutation!: (records: MutationRecord[]) => void;
    Object.defineProperty(fixture.window, 'requestAnimationFrame', {configurable: true, value: undefined});
    Object.defineProperty(fixture.window, 'cancelAnimationFrame', {configurable: true, value: undefined});
    const clearTimeout = vi.spyOn(fixture.window, 'clearTimeout');
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: MutationRecord[]) => void) { mutation = callback; }
      observe() {}
      disconnect() {}
    });
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window});
    mutation([{target: fixture.document.body, addedNodes: [fixture.document.createElement('video')],
      removedNodes: []} as unknown as MutationRecord]);
    locator.destroy();
    expect(clearTimeout).toHaveBeenCalled();
  });

  it('handles deep X wrappers and a document without a documentElement', () => {
    let inner = '<video></video>';
    for (let index = 0; index < 15; index += 1) inner = `<div class="deep-${index}">${inner}</div>`;
    const markup = `<article>${inner}<a href="/cerebras/status/2089870131291943228/video/1"></a></article>`;
    const fixture = setup(markup, 'https://x.com/cerebras/status/2089870131291943228');
    expect(selectVideoPlayerTarget(fixture.document, {window: fixture.window, isXPage: true})?.video).toBe(fixture.videos[0]);
    expect(getVideoPlayerForVideo(fixture.videos[0], fixture.window)).toBe(fixture.videos[0].parentElement);
    const originalRoot = fixture.document.documentElement;
    Object.defineProperty(fixture.document, 'documentElement', {configurable: true, value: null});
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => false});
    expect(locator.sync()?.video).toBe(fixture.videos[0]);
    locator.destroy();
    Object.defineProperty(fixture.document, 'documentElement', {configurable: true, value: originalRoot});
  });

  it('covers an empty and a malformed X link while resolving the player directly', () => {
    const fixture = setup('<article><div><video></video><a href=""></a></div></article>', 'https://x.com/cerebras/status/2089870131291943228');
    expect(getVideoPlayerForVideo(fixture.videos[0], fixture.window)).toBe(fixture.videos[0].parentElement);
    const invalid = setup('<article><div><video></video><a></a></div></article>', 'https://x.com/cerebras/status/2089870131291943228');
    const anchor = invalid.document.querySelector('a')!;
    anchor.getAttribute = (() => { throw new Error('broken attribute'); }) as typeof anchor.getAttribute;
    expect(getVideoPlayerForVideo(invalid.videos[0], invalid.window)).toBe(invalid.videos[0].parentElement);
  });

  it('does not associate external or multi-video links with an unrelated video', () => {
    const external = setup('<article><div><video></video><a href="https://example.com/status/1/video/1"></a></div></article>', 'https://x.com/cerebras');
    expect(getVideoPlayerForVideo(external.videos[0], external.window)).toBe(external.videos[0].parentElement);
    const multiple = setup('<article><div class="media"><video></video><video></video><a href="/cerebras/status/1/video/1"></a></div></article>', 'https://x.com/cerebras');
    expect(getVideoPlayerForVideo(multiple.videos[0], multiple.window)).toBe(multiple.videos[0].parentElement);
    const outsideArticle = setup('<div><video></video></div>', 'https://x.com/cerebras');
    expect(getVideoPlayerForVideo(outsideArticle.videos[0], outsideArticle.window)).toBe(outsideArticle.videos[0].parentElement);
    const statusNoArticle = setup('<div><video></video></div>', 'https://x.com/cerebras/status/123');
    expect(selectVideoPlayerTarget(statusNoArticle.document, {window: statusNoArticle.window, isXPage: true})?.video).toBe(statusNoArticle.videos[0]);
  });

  it('accepts synthetic non-element pointer and focus events', () => {
    const fixture = setup('<div><video></video></div>');
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => false});
    for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
      const event = new (fixture.window as unknown as {Event: typeof Event}).Event(type, {bubbles: true});
      Object.defineProperty(event, 'target', {configurable: true, value: {}});
      fixture.document.dispatchEvent(event);
    }
    fixture.document.body.dispatchEvent(new (fixture.window as unknown as {Event: typeof Event}).Event('focusout', {bubbles: true}));
    // 非元素目标不能把播放器误标为交互中，也不能打断后续定位。
    expect(locator.getTarget()?.interacting).not.toBe(true);
    expect(locator.sync()?.video).toBe(fixture.videos[0]);
    locator.destroy();
  });

  it('keeps interaction active when pointer or focus moves within the same player', () => {
    const fixture = setup('<div class="html5-video-player"><video></video><button></button></div>');
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => false});
    const video = fixture.videos[0];
    const control = fixture.document.querySelector('button')!;
    video.dispatchEvent(new (fixture.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    const pointerOut = new (fixture.window as unknown as {Event: typeof Event}).Event('pointerout', {bubbles: true});
    Object.defineProperty(pointerOut, 'relatedTarget', {value: control});
    video.dispatchEvent(pointerOut);
    expect(locator.getTarget()?.interacting).toBe(true);
    const focusOut = new (fixture.window as unknown as {Event: typeof Event}).Event('focusout', {bubbles: true});
    Object.defineProperty(focusOut, 'relatedTarget', {value: control});
    video.dispatchEvent(focusOut);
    expect(locator.getTarget()?.interacting).toBe(true);
    locator.destroy();
  });

  it('promotes a shared ancestor after traversing an inner wrapper without the link', () => {
    const fixture = setup('<article><div class="outer"><div class="inner"><video></video></div><a href="/cerebras/status/2089870131291943228/video/1"></a></div></article>', 'https://x.com/cerebras/status/2089870131291943228');
    const target = selectVideoPlayerTarget(fixture.document, {window: fixture.window, isXPage: true});
    expect(target?.player.className).toBe('outer');
  });

  it('associates profile-feed media by its local status video link without using the current pathname', () => {
    const fixture = setup(
      '<main><article><div class="first"><div class="group relative isolate"><video></video></div><a href="/cerebras/status/101/video/1"></a></div></article>'
      + '<article><div class="second"><div class="group relative isolate"><video></video></div><a href="/cerebras/status/202/video/1"></a></div></article>',
      'https://x.com/cerebras',
    );
    const locator = createVideoPlayerLocator({document: fixture.document, window: fixture.window, isXPage: () => true});
    fixture.document.querySelectorAll('article')[1].querySelector('a')!.dispatchEvent(new (fixture.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
    expect(locator.getTarget()?.video).toBe(fixture.videos[1]);
    expect(locator.getTarget()?.player.className).toBe('second');
    locator.destroy();
  });

  it('keeps a non-overlapping post permalink outside a known video player', () => {
    const fixture = setup(
      '<article><a class="post-link" href="/cerebras/status/303/video/1"></a><div data-testid="videoPlayer"><video></video></div></article>',
      'https://x.com/cerebras',
    );
    const link = fixture.document.querySelector<HTMLAnchorElement>('.post-link')!;
    Object.defineProperty(link, 'getBoundingClientRect', {configurable: true, value: () => ({width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20})});
    const target = selectVideoPlayerTarget(fixture.document, {window: fixture.window, isXPage: true});
    expect(target?.player).toBe(fixture.document.querySelector('[data-testid="videoPlayer"]'));
  });

  it('accepts contained overlay links and pre-layout zero geometry only', () => {
    const contained = setup('<article><div class="outer"><a href="/cerebras/status/404/video/1"><video></video></a></div></article>', 'https://x.com/cerebras');
    expect(selectVideoPlayerTarget(contained.document, {window: contained.window, isXPage: true})?.player.className).toBe('outer');

    const nested = setup('<article><div class="outer"><video></video></div></article>', 'https://x.com/cerebras');
    const video = nested.videos[0];
    const anchor = nested.document.createElement('a');
    anchor.href = '/cerebras/status/405/video/1';
    video.appendChild(anchor);
    expect(selectVideoPlayerTarget(nested.document, {window: nested.window, isXPage: true})?.player.className).toBe('outer');

    const unknown = setup('<article><div><video></video><a href="/cerebras/status/406/video/1"></a></div></article>', 'https://x.com/cerebras');
    const unknownVideo = unknown.videos[0];
    const unknownAnchor = unknown.document.querySelector('a')!;
    Object.defineProperty(unknownVideo, 'getBoundingClientRect', {configurable: true, value: () => ({width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0})});
    Object.defineProperty(unknownAnchor, 'getBoundingClientRect', {configurable: true, value: () => ({width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0})});
    expect(getVideoPlayerForVideo(unknownVideo, unknown.window)).toBe(unknownVideo.parentElement);
  });

  it('accepts default X detection and falls back to a video parent when no known player exists', () => {
    const {document, window, videos} = setup('<div><video></video></div>', 'https://x.com/home');
    expect(selectVideoPlayerTarget(document, {window})?.video).toBe(videos[0]);
    expect(selectVideoPlayerTarget(document)?.video).toBe(videos[0]);
    const locator = createVideoPlayerLocator();
    expect(locator.sync()?.video).toBe(videos[0]);
    locator.destroy();
    const disconnected = document.createElement('video');
    expect(getVideoPlayerForVideo(disconnected, window)).toBe(disconnected);
    expect((() => {
      const player = document.querySelector('div')!;
      return player.contains(videos[0]);
    })()).toBe(true);
  });
});


it('selects standard audio and follows the latest playback without selecting owned scan copies', () => {
  const f = setup('<section><audio id="first"></audio></section><section><audio id="second"></audio></section><video class="fluent-read-video-ui"></video>', 'https://podcast.example/');
  const first = f.document.getElementById('first') as HTMLMediaElement;
  const second = f.document.getElementById('second') as HTMLMediaElement;
  const host = f.document.createElement('div'); f.document.body.appendChild(host);
  const locator = createVideoPlayerLocator({document: f.document, window: f.window, includeAudio: true, getPlayer: () => host});
  expect(locator.sync()!.video).toBe(first); expect(locator.getTarget()!.player).toBe(host);
  second.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('pointerover', {bubbles: true}));
  expect(locator.getTarget()!.video).toBe(first);
  Object.defineProperty(first, 'paused', {configurable: true, value: false});
  second.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('play', {bubbles: true}));
  expect(locator.getTarget()!.video).toBe(first);
  Object.defineProperty(first, 'ended', {configurable: true, value: true});
  second.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('play', {bubbles: true}));
  expect(locator.getTarget()!.video).toBe(second);
  second.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('pointerdown', {bubbles: true}));
  second.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('play', {bubbles: true}));
  expect(locator.getTarget()!.video).toBe(second);
  Object.defineProperty(second, 'srcObject', {configurable: true, value: {}}); const key = locator.sync()!.key;
  Object.defineProperty(second, 'srcObject', {configurable: true, value: {}}); expect(locator.sync()!.key).not.toBe(key);
  locator.destroy();
});


it('adopts a playing HTML audio element before the first scan', () => {
  const f = setup('<section><audio></audio></section>', 'https://podcast.example/');
  const media = f.document.querySelector('audio')!;
  const locator = createVideoPlayerLocator({document: f.document, window: f.window, includeAudio: true});
  media.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('play', {bubbles: true}));
  expect(locator.getTarget()!.video).toBe(media); locator.destroy();
});

it('discovers open Shadow DOM videos, honors webkit fullscreen, prefers playing media, and ignores non-media play events', () => {
  const f = setup('<div id="host"></div><div class="plain"><video id="paused"></video></div><div class="plain"><video id="playing"></video></div>', 'https://example.test/');
  const host = f.document.getElementById('host')!;
  const shadow = host.attachShadow({mode: 'open'});
  const shadowVideo = f.document.createElement('video') as unknown as HTMLVideoElement;
  shadowVideo.id = 'shadow-video';
  Object.defineProperty(shadowVideo, 'getBoundingClientRect', {configurable: true, value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
  shadow.appendChild(shadowVideo);
  const paused = f.document.getElementById('paused') as unknown as HTMLVideoElement;
  const playing = f.document.getElementById('playing') as unknown as HTMLVideoElement;
  Object.defineProperty(paused, 'paused', {configurable: true, value: true});
  Object.defineProperty(playing, 'paused', {configurable: true, value: false});
  Object.defineProperty(playing, 'ended', {configurable: true, value: false});
  Object.defineProperty(shadowVideo, 'paused', {configurable: true, value: true});

  const locator = createVideoPlayerLocator({document: f.document, window: f.window, includeAudio: true});
  expect(locator.sync()?.video).toBe(playing);

  // 非媒体节点派发 play 不应切换选中项
  f.document.body.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('play', {bubbles: true}));
  expect(locator.getTarget()?.video).toBe(playing);

  // webkitFullscreenElement 与 webkitfullscreenchange 切到全屏容器（直指 Shadow DOM video）
  Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: shadowVideo});
  f.document.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('webkitfullscreenchange'));
  expect(locator.getTarget()?.video).toBe(shadowVideo);
  expect(locator.getTarget()?.fullscreen).toBe(true);

  // 容器级全屏包裹 Shadow DOM video：通过 containsDeep 与受限子树深查命中，且忽略不可见的额外全屏视频
  const hiddenShadowVideo = f.document.createElement('video') as unknown as HTMLVideoElement;
  Object.defineProperty(hiddenShadowVideo, 'getBoundingClientRect', {configurable: true, value: () => ({width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0})});
  shadow.appendChild(hiddenShadowVideo);
  Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: host});
  f.document.dispatchEvent(new (f.window as unknown as {Event: typeof Event}).Event('webkitfullscreenchange'));
  expect(locator.getTarget()?.video).toBe(shadowVideo);
  expect(locator.getTarget()?.fullscreen).toBe(true);
  hiddenShadowVideo.remove();
  expect(locator.sync()?.player).toBe(host);
  locator.destroy();

  // 纯 Shadow DOM 页面（无轻 DOM video）回退全页深查命中
  const shadowOnly = setup('<div id="only-host"></div>', 'https://example.test/');
  const onlyHost = shadowOnly.document.getElementById('only-host')!;
  const onlyShadow = onlyHost.attachShadow({mode: 'open'});
  const onlyVideo = shadowOnly.document.createElement('video') as unknown as HTMLVideoElement;
  Object.defineProperty(onlyVideo, 'getBoundingClientRect', {configurable: true, value: () => ({width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360})});
  onlyShadow.appendChild(onlyVideo);
  expect(selectVideoPlayerTarget(shadowOnly.document, {window: shadowOnly.window})?.video).toBe(onlyVideo);
});
