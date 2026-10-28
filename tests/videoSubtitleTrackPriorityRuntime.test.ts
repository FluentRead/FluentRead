/**
 * @file tests/videoSubtitleTrackPriorityRuntime.test.ts
 * 文件职责：从实际 mountVideoSubtitleTranslation 公共入口验证 X 轨道优先与 YouTube 同轮选择、人工字幕回退及卸载后的异步资格。
 * 主要内容：真实桥消息、video、TextTrack 与配置订阅驱动播放器、轨道 loader、缓存和 DOM；覆盖移动端兄弟底控显隐与字幕布局自动同步、重绑和清理、菜单入口展开语义、两站初始禁用与 Off 清理、媒体事件后不复活、重复外部启用重建、真实模式项保存、同句调用预算、实际服务线路或套餐变化后的缓存失效、时钟漂移、NaN、seek、偏移、人工轨空档与迟到结果。
 * 模块边界：linkedom 补齐缺失的浏览器媒体/几何接口并按观察器订阅过滤记录；只 mock 外部端口，命名 selector spy 保留真实实现，不替换业务算法或修改全局数组原型。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const ports = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  subscribers: new Set<(value: unknown) => void>(),
  translate: vi.fn(), annotate: vi.fn(), send: vi.fn(), fetch: vi.fn(), patch: vi.fn(), watchProgress: vi.fn(), stopProgress: vi.fn(),
}));
vi.mock('@/src/services/config/store', () => ({
  config: ports.config,
  subscribeConfig: (listener: (value: unknown) => void) => {
    ports.subscribers.add(listener);
    return () => ports.subscribers.delete(listener);
  },
  requestConfigPatch: async (patch: Record<string, unknown>) => {
    ports.patch(patch);
    Object.assign(ports.config, patch);
    for (const listener of [...ports.subscribers]) listener(ports.config);
  },
}));
vi.mock('@/src/services/translation/client', () => ({translateVideoText: ports.translate}));
vi.mock('@/src/features/video-subtitle/content/readingAnnotationClient', () => ({annotateVideoReading: ports.annotate}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: ports.send}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {getURL: (path: string) => 'chrome-extension://fixture/' + path}}}));
vi.mock('@/src/platform/storage/downloadProgress', () => ({watchContentDownloadProgress: ports.watchProgress}));
vi.mock('@/src/platform/browser/capabilities', async original => ({
  ...await original<typeof import('@/src/platform/browser/capabilities')>(),
  browserCapabilities: {extensionDom: true},
}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {render: () => null}}));
vi.mock('@/src/features/reading-assistant/public', () => ({streamReading: vi.fn()}));
vi.mock('vue', async original => {
  const vue = await original<typeof import('vue')>();
  // Node 没有预先存在的 document；只适配 DOM renderer，真实 SFC setup、模板与事件照常执行。
  return {...vue, createApp: (...args: Parameters<typeof vue.createApp>) => {
    const doc = globalThis.document;
    return vue.createRenderer<Node, Element>({
      insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.parentNode?.removeChild(node),
      createElement: (tag, namespace) => vue.markRaw(namespace === 'svg' ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag)),
      createText: value => doc.createTextNode(value), createComment: value => doc.createComment(value),
      setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
      parentNode: node => node.parentElement, nextSibling: node => node.nextSibling,
      patchProp: (node, key, previous, next) => {
        if (/^on[A-Z]/.test(key)) {const event = key.slice(2).toLowerCase();if (previous) node.removeEventListener(event, previous);if (next) node.addEventListener(event, next);}
        else if (key === 'style') Object.assign((node as HTMLElement).style, next || {});
        else if (next == null || next === false && !/^(aria-|data-)/.test(key)) node.removeAttribute(key);
        else node.setAttribute(key, next === true && !/^(aria-|data-)/.test(key) ? '' : String(next));
      },
    }).createApp(...args);
  }};
});

import {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
// 唯一 runtime import：移入 repo 后默认消费真实源码；私有 runner 可 alias 两份完整字节快照做同一测试对照。
import {mountVideoSubtitleTranslation} from '@/src/features/video-subtitle/public';
import {
  VIDEO_AI_CAPTION_CONTAINER_ID, VIDEO_NORMALIZED_CAPTION_OVERLAY_ID,
  VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS, VIDEO_SUBTITLE_PANEL_ID,
  VIDEO_TRANSLATION_ACTIVE_CLASS, VIDEO_TRANSLATION_BUTTON_ID, VIDEO_TRANSLATION_LAYER_ID, VIDEO_TRANSLATION_MENU_ID,
  VIDEO_TRANSLATION_OVERLAY_ID, X_SUBTITLE_RESOURCE_MESSAGE,
  markVideoUi,
} from '@/src/features/video-subtitle/content/ui';
import {audioInit} from './fixtures/hlsAudio';
import {YOUTUBE_TIMED_TEXT_MESSAGE} from '@/src/features/video-subtitle/content/youtubeTimedTextBridgeCore';
import * as subtitleLogic from '@/src/features/video-subtitle/content/subtitleLogic';
import {createSubtitleLayoutObserver} from '@/src/features/video-subtitle/content/subtitleLayoutObserver';
import {VIDEO_SUBTITLE_SCROLL_HOST_ID} from '@/src/features/video-subtitle/content/subtitleControlLayout';
import {createVideoSentenceLearningHost} from '@/src/features/video-subtitle/content/sentenceLearningHost';
import {createVideoSentenceLearningPlacement} from '@/src/features/video-subtitle/content/sentenceLearningPlacement';
import {normalizeVideoSentenceLearningAppearance} from '@/src/core/config/videoSentenceLearningAppearance';

// 英文状态刷新依赖运行时已加载的资源包；测试注册真实文案，生产仍按当前语言加载。
registerAllUiLanguageBundles();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}
const translation = (source: string) => '测试译文：' + source;
const disposers = new Set<() => void>();
const browserPortRestores: Array<() => void> = [];
const observerDiagnosticBudgets = new Set<{maxDeliveries: number; exceeded: boolean}>();
function defineBrowserPort(target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, descriptor);
  browserPortRestores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  ports.subscribers.clear();
  for (const key of Object.keys(ports.config)) delete ports.config[key];
  Object.assign(ports.config, new Config(), {
    on: true, to: 'zh-Hans', videoTranslationEnabled: true, videoSubtitleVisible: true,
    videoSubtitleDisplayMode: 'bilingual', videoSourceLanguage: 'auto', videoLocalModel: 'tiny',
  });
  ports.translate.mockReset().mockImplementation((source: string) => Promise.resolve(translation(source)));
  ports.annotate.mockReset().mockImplementation(async (text: string, language: string) => ({text: `Reading: ${text}`, language, scheme: 'fixture'}));
  ports.send.mockReset().mockImplementation(async (message: {type: string}) => {
    if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {success: true, hit: false};
    if (message.type === 'fluentReadCancelLocalVideoTranscription' || message.type === 'fluentReadSetVideoAiSubtitleCache') return {success: true};
    throw new Error('Unexpected model/runtime boundary: ' + message.type);
  });
  ports.fetch.mockReset().mockRejectedValue(new Error('Unexpected network request in subtitle fixture'));
  ports.patch.mockReset();
  ports.stopProgress.mockReset(); ports.watchProgress.mockReset().mockReturnValue(ports.stopProgress);
});
afterEach(async () => {
  try {
    for (const dispose of [...disposers]) dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const budget of observerDiagnosticBudgets) {expect(budget.exceeded).toBe(false); expect(budget.maxDeliveries).toBeLessThanOrEqual(1000);}
  } finally {
    observerDiagnosticBudgets.clear();
    // 失败路径也恢复测试端口；计时器/订阅泄漏仍由上面的断言报告，不能影响后续文件。
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    browserPortRestores.splice(0).reverse().forEach(restore => restore());
  }
});

function fixture(nativeText?: string, platform: 'x' | 'youtube' = 'x') {
  const markup = platform === 'youtube'
    ? '<!doctype html><html><head></head><body><div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true">Subtitles</button></div><div id="ytp-caption-window-container"><span class="ytp-caption-segment"></span></div></div><p id="host">host original</p></body></html>'
    : '<!doctype html><html><head></head><body><div data-testid="videoPlayer"><video></video><div><button aria-label="Play">Play</button><button aria-label="Settings">Settings</button></div></div><p id="host">host original</p></body></html>';
  const {document, window} = parseHTML(markup);
  const player = document.querySelector<HTMLElement>(platform === 'youtube' ? '#movie_player' : '[data-testid="videoPlayer"]')!;
  const video = player.querySelector<HTMLVideoElement>('video')!;
  const bounds = {left: 20, top: 20, width: 640, height: 360, right: 660, bottom: 380, x: 20, y: 20, toJSON: () => ({})};
  // linkedom 无布局引擎；标准媒体属性由 fixture 提供，产品选择/渲染仍使用实际实现。
  defineBrowserPort(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true, value: () => bounds});
  defineBrowserPort(window, 'location', {configurable: true, value: new URL(platform === 'youtube' ? 'https://www.youtube.com/watch?v=cue-proof' : 'https://x.com/example/status/100')});
  defineBrowserPort(window, 'innerWidth', {configurable: true, value: 1280});
  defineBrowserPort(window, 'innerHeight', {configurable: true, value: 900});
  const selectValues = new WeakMap<object, string>();
  defineBrowserPort(window.HTMLSelectElement.prototype, 'value', {
    configurable: true, get() { return selectValues.get(this) || ''; },
    set(value: string) { selectValues.set(this, value); },
  });
  const computed = (element: Element) => ({display: (element as HTMLElement).style.display || 'block',
    visibility: (element as HTMLElement).style.visibility || 'visible', opacity: (element as HTMLElement).style.opacity || '1',
    position: 'relative', objectFit: 'contain', objectPosition: '50% 50%'});
  defineBrowserPort(window, 'getComputedStyle', {configurable: true, writable: true, value: computed});
  const trackEvents = new window.EventTarget();
  const tracks = Object.assign([] as TextTrack[], {
    addEventListener: trackEvents.addEventListener.bind(trackEvents),
    removeEventListener: trackEvents.removeEventListener.bind(trackEvents),
    dispatchEvent: trackEvents.dispatchEvent.bind(trackEvents),
  });
  const makeTrack = (text: string, language = 'en') => {
    const cue = {startTime: 0, endTime: 20, text};
    // TextTrack 缺失于 linkedom；activeCues 是浏览器边界的显式输入，不复制产品轨道选择逻辑。
    return Object.assign(new window.EventTarget(), {kind: 'subtitles', language, mode: 'showing', cues: [cue], activeCues: [cue]}) as unknown as TextTrack;
  };
  const native = nativeText ? makeTrack(nativeText) : undefined;
  if (native) tracks.push(native);
  video.setAttribute('src', platform === 'youtube' ? 'https://www.youtube.com/fixture.mp4' : 'https://video.twimg.com/ext_tw_video/123/pu/vid/fixture.mp4');
  Object.defineProperties(video, {
    src: {configurable: true, get: () => video.getAttribute('src') || '', set: (value: string) => video.setAttribute('src', value)},
    currentSrc: {configurable: true, get: () => video.src},
    poster: {configurable: true, writable: true, value: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/poster.jpg'},
    currentTime: {configurable: true, writable: true, value: 1},
    duration: {configurable: true, value: 60},
    paused: {configurable: true, writable: true, value: true},
    ended: {configurable: true, value: false},
    seeking: {configurable: true, value: false},
    playbackRate: {configurable: true, value: 1},
    videoWidth: {configurable: true, value: 640}, videoHeight: {configurable: true, value: 360},
    offsetWidth: {configurable: true, value: 640}, offsetHeight: {configurable: true, value: 360},
    textTracks: {configurable: true, value: tracks},
  });
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLVideoElement', 'HTMLStyleElement', 'MutationObserver', 'CustomEvent']) {
    vi.stubGlobal(name, window[name as keyof typeof window]);
  }
  const observerRegistrations = new Set<Map<Node, MutationObserverInit>>();
  {
    // linkedom 会错发未订阅 attributes，disconnect 后也可能派发旧批次；按浏览器订阅与断开契约过滤。
    const NativeObserver = window.MutationObserver;
    const budget = {maxDeliveries: 0, exceeded: false}; observerDiagnosticBudgets.add(budget);
    class SubscribedObserver {
      private readonly registrations = new Map<Node, MutationObserverInit>();
      private readonly observer: MutationObserver;
      private deliveries = 0;
      private connected = false;
      constructor(callback: MutationCallback) {
        observerRegistrations.add(this.registrations);
        this.observer = new NativeObserver(records => {
          if (!this.connected) return;
          const delivered = records.filter(record => record.type !== 'attributes' || [...this.registrations].some(([target, options]) =>
            options.attributes && (target === record.target || options.subtree && target.contains(record.target))
            && (!options.attributeFilter || options.attributeFilter.includes(record.attributeName!))));
          if (!delivered.length) return;
          this.deliveries += 1; budget.maxDeliveries = Math.max(budget.maxDeliveries, this.deliveries);
          if (this.deliveries > 1000) {budget.exceeded = true; this.disconnect(); throw new Error('subtitle fixture observer delivery exceeded the diagnostic budget');}
          callback(delivered, this as unknown as MutationObserver);
        });
      }
      observe(target: Node, options: MutationObserverInit) {this.connected = true;this.registrations.set(target, {...options}); this.observer.observe(target, {...options});}
      disconnect() {this.connected = false;this.registrations.clear(); this.observer.disconnect();}
      takeRecords() {return this.observer.takeRecords();}
    }
    vi.stubGlobal('MutationObserver', SubscribedObserver);
  }
  vi.stubGlobal('getComputedStyle', computed);
  vi.stubGlobal('fetch', ports.fetch);
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const start = () => {
    const runtimeDispose = mountVideoSubtitleTranslation();
    const dispose = () => { if (!disposers.delete(dispose)) return; runtimeDispose(); };
    disposers.add(dispose); return dispose;
  };
  const emitResource = (name: string, responseText: string, mediaId = '123') => {
    // linkedom 无 MessageEvent；为实际 window message listener 提供标准消息字段。
    const event = new window.Event('message');
    Object.defineProperties(event, {
      source: {value: window}, origin: {value: window.location.origin},
      data: {value: {source: 'fluent-read', type: X_SUBTITLE_RESOURCE_MESSAGE,
        url: `https://video.twimg.com/ext_tw_video/${mediaId}/captions/${name}`,
        responseText, pageHref: window.location.href}},
    });
    window.dispatchEvent(event);
  };
  const emitCue = (name: string, text: string, start = 0, end = 20, mediaId = '123') =>
    emitResource(name + '.vtt', `WEBVTT\n\n00:00:${String(start).padStart(2, '0')}.000 --> 00:00:${String(end).padStart(2, '0')}.000\n${text}\n`, mediaId);
  const emitVideo = (type: string) => video.dispatchEvent(new window.Event(type, {bubbles: true}));
  const changeTracks = () => tracks.dispatchEvent(new window.Event('change'));
  const changeConfig = (patch: Partial<Config>) => {
    Object.assign(ports.config, patch);
    for (const listener of [...ports.subscribers]) listener(ports.config);
  };
  const displayed = () => ({
    source: document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID)?.textContent,
    translated: document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID)?.textContent,
    active: document.getElementById(VIDEO_SUBTITLE_PANEL_ID)?.classList.contains(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS),
    kind: document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID)?.dataset.fluentReadCaptionSource,
  });
  const callsFor = (text: string) => ports.translate.mock.calls.filter(([source]) => source === text).length;
  const setCaption = (text: string) => {document.querySelector('.ytp-caption-segment')!.textContent = text;};
  const emitTimedText = (cues: readonly {startMs: number; durationMs: number; text: string}[], url = 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en&fmt=json3') => {
    const event = new window.Event('message');
    Object.defineProperties(event, {
      source: {value: window}, origin: {value: window.location.origin},
      data: {value: {source: 'fluent-read', type: YOUTUBE_TIMED_TEXT_MESSAGE,
        url,
        responseText: JSON.stringify({events: cues.map(cue => ({tStartMs: cue.startMs, dDurationMs: cue.durationMs, segs: [{utf8: cue.text}]}))})}},
    });
    window.dispatchEvent(event);
  };
  return {document, window, player, video, tracks, native, makeTrack, start, emitResource, emitCue, emitVideo, changeTracks, changeConfig, displayed, callsFor, setCaption, emitTimedText, observerRegistrations};
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const nativeSource = 'The native caption remains visible.';

describe('public mounted reading annotation integration', () => {
  it('retries a failed reading from the actual menu without translating again', async () => {
    Object.assign(ports.config, {from: 'ja', videoSubtitleDisplayMode: 'original-only'});
    (ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation = true;
    ports.annotate.mockRejectedValueOnce(new Error('reading worker unavailable'));
    const f = fixture(undefined, 'youtube');f.setCaption('今日も勉強します。');f.start();await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;menu.hidden = false;
    const retry = menu.querySelector<HTMLButtonElement>('[data-action="retry-reading-annotation"]')!;expect(retry.hidden).toBe(false);
    clickMenu(f, '[data-action="retry-reading-annotation"]');await settle();
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 今日も勉強します。');
    expect(ports.annotate).toHaveBeenCalledTimes(2);expect(ports.translate).not.toHaveBeenCalled();expect(retry.hidden).toBe(true);
  });

  it('双语字幕切换界面语言时同步更新已有读音的可访问名称且不重新计算', async () => {
    Object.assign(ports.config, {from: 'ja', uiLanguage: 'zh-CN'});
    (ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation = true;
    const f = fixture(undefined, 'youtube'); f.setCaption('今日はいい天気です。'); f.start(); await vi.advanceTimersByTimeAsync(300);
    const reading = f.document.getElementById('fluent-read-video-subtitle-reading')!;
    expect(reading.getAttribute('aria-label')).toBe('日语罗马音');
    const count = ports.annotate.mock.calls.length;
    f.changeConfig({uiLanguage: 'en-US'}); await vi.advanceTimersByTimeAsync(100);
    expect(reading.getAttribute('aria-label')).toBe('Japanese romaji');
    expect(ports.annotate).toHaveBeenCalledTimes(count);
  });

  it('默认关闭不请求读音，启用日语仅原文模式后显示独立读音并保持原文正文', async () => {
    Object.assign(ports.config, {from: 'ja', videoSubtitleDisplayMode: 'original-only'});
    const f = fixture(undefined, 'youtube'); f.setCaption('今日はいい天気です。'); f.start(); await vi.advanceTimersByTimeAsync(100);
    expect(ports.annotate).not.toHaveBeenCalled();
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')).toBeNull();
    const appearance = (ports.config as unknown as Config).videoSubtitleAppearance;
    f.changeConfig({videoSubtitleAppearance: {...appearance, readingAnnotation: true}}); await vi.advanceTimersByTimeAsync(100);
    expect(ports.annotate).toHaveBeenCalledWith('今日はいい天気です。', 'ja', expect.any(AbortSignal));
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 今日はいい天気です。');
    expect(f.displayed().source).toBe('今日はいい天気です。');
    expect(f.document.querySelector('.ytp-caption-segment')?.textContent).toBe('今日はいい天気です。');
    expect(ports.translate).not.toHaveBeenCalled();
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadAnnotateVideoReading')).toBe(false);
    await vi.advanceTimersByTimeAsync(1200); expect(ports.annotate).toHaveBeenCalledOnce();
  });

  it('仅原文带读音切回双语时同一cue立即开始翻译，保留原句与缓存读音', async () => {
    const source = '今日はいい天気です。';
    Object.assign(ports.config, {from: 'ja', videoSubtitleDisplayMode: 'original-only', videoPreferHumanSubtitles: false});
    (ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation = true;
    const f = fixture(undefined, 'youtube'); f.setCaption(source); f.start(); await vi.advanceTimersByTimeAsync(300);
    const reading = f.document.getElementById('fluent-read-video-subtitle-reading')!;
    expect(f.displayed().source).toBe(source); expect(reading.textContent).toBe('Reading: ' + source);
    expect(ports.translate).not.toHaveBeenCalled(); expect(ports.annotate).toHaveBeenCalledOnce();
    f.changeConfig({videoSubtitleDisplayMode: 'bilingual'}); await vi.advanceTimersByTimeAsync(300);
    expect(ports.translate).toHaveBeenCalledWith(source, expect.any(AbortSignal), undefined);
    expect(f.callsFor(source)).toBe(1); expect(f.displayed()).toMatchObject({source, translated: translation(source), active: true});
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')).toBe(reading);
    expect(reading.textContent).toBe('Reading: ' + source); expect(ports.annotate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1200); expect(f.callsFor(source)).toBe(1); expect(ports.annotate).toHaveBeenCalledOnce();
  });

  it('换句、仅译文与关闭作废旧读音，恢复原文模式复用当前句结果', async () => {
    Object.assign(ports.config, {from: 'ja', videoSubtitleDisplayMode: 'original-only'});
    (ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation = true;
    const old = deferred<{text: string; language: string; scheme: string}>(); ports.annotate.mockReturnValueOnce(old.promise);
    const f = fixture(undefined, 'youtube'); f.setCaption('最初の文。'); const dispose = f.start(); await vi.advanceTimersByTimeAsync(100);
    const firstSignal = ports.annotate.mock.calls[0][2] as AbortSignal;
    f.setCaption('次の文。'); await vi.advanceTimersByTimeAsync(100);
    expect(firstSignal.aborted).toBe(true);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 次の文。');
    old.resolve({text: '古い読み', language: 'ja', scheme: 'fixture'}); await settle();
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 次の文。');
    f.changeConfig({videoSubtitleDisplayMode: 'translation-only'}); await vi.advanceTimersByTimeAsync(100);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent || '').toBe('');
    expect((ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation).toBe(true);
    f.changeConfig({videoSubtitleDisplayMode: 'original-only'}); await vi.advanceTimersByTimeAsync(100);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 次の文。');
    const late = deferred<{text: string; language: string; scheme: string}>(); ports.annotate.mockReturnValueOnce(late.promise);
    f.setCaption('最後の文。'); await vi.advanceTimersByTimeAsync(100);
    const finalSignal = ports.annotate.mock.calls.at(-1)![2] as AbortSignal;
    f.changeConfig({videoSubtitleVisible: false}); expect(finalSignal.aborted).toBe(true);
    late.resolve({text: '非表示後の読み', language: 'ja', scheme: 'fixture'}); await vi.advanceTimersByTimeAsync(100);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent || '').toBe('');
    dispose(); expect(f.document.getElementById('fluent-read-video-subtitle-reading')).toBeNull();
  });

  it('真实菜单开关保存偏好、更新ARIA且保留菜单节点和焦点', async () => {
    Object.assign(ports.config, {from: 'ja', videoSubtitleDisplayMode: 'original-only'});
    const f = fixture(undefined, 'youtube'); f.setCaption('今日はいい天気です。'); f.start(); await vi.advanceTimersByTimeAsync(100);
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    const entry = f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!;
    const open = new f.window.Event('click', {bubbles: true}); Object.defineProperty(open, 'isTrusted', {value: true}); entry.dispatchEvent(open); await settle();
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    let focused: HTMLElement | null = null;
    defineBrowserPort(f.document, 'activeElement', {configurable: true, get: () => focused?.isConnected ? focused : f.document.body});
    defineBrowserPort(toggle, 'focus', {configurable: true, value: () => {focused = toggle;}}); toggle.focus();
    clickMenu(f, '[data-action="toggle-reading-annotation"]'); await vi.advanceTimersByTimeAsync(100);
    expect((ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true'); expect(menu.hidden).toBe(false);
    expect(menu.querySelector('[data-action="toggle-reading-annotation"]')).toBe(toggle); expect(f.document.activeElement).toBe(toggle);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent).toBe('Reading: 今日はいい天気です。');
    clickMenu(f, '[data-action="toggle-reading-annotation"]'); await vi.advanceTimersByTimeAsync(100);
    expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(f.document.activeElement).toBe(toggle);
    expect(f.document.getElementById('fluent-read-video-subtitle-reading')?.textContent || '').toBe('');
  });
});

function mobileYoutubeLayoutFixture() {
  const f = fixture(undefined, 'youtube');
  // linkedom 缺标准 CSS priority 接口；保留实际 style 序列化，只补浏览器单属性优先级端口。
  const stylePrototype = Object.getPrototypeOf(f.player.style);
  const priorities = new WeakMap<object, Map<string, string>>();
  const set = stylePrototype.setProperty, remove = stylePrototype.removeProperty;
  defineBrowserPort(stylePrototype, 'getPropertyPriority', {configurable: true, value: function (this: object, name: string) {return priorities.get(this)?.get(name) || '';}});
  defineBrowserPort(stylePrototype, 'setProperty', {configurable: true, value: function (this: object, name: string, value: string, priority = '') {
    if (!priorities.has(this)) priorities.set(this, new Map());
    priorities.get(this)!.set(name, priority); return set.call(this, name, value);
  }});
  defineBrowserPort(stylePrototype, 'removeProperty', {configurable: true, value: function (this: object, name: string) {priorities.get(this)?.delete(name); return remove.call(this, name);}});
  defineBrowserPort(f.window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=cue-proof')});
  const bounds = {left: 0, top: 48, width: 402, height: 226, right: 402, bottom: 274, x: 0, y: 48, toJSON: () => ({})};
  defineBrowserPort(f.window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true, value: () => bounds});
  defineBrowserPort(f.video, 'videoWidth', {configurable: true, value: 400});
  defineBrowserPort(f.video, 'videoHeight', {configurable: true, value: 300});
  defineBrowserPort(f.video, 'offsetWidth', {configurable: true, value: 402});
  defineBrowserPort(f.video, 'offsetHeight', {configurable: true, value: 226});
  f.player.classList.add('ytp-mweb-player');
  // 继承的桌面入口端口只供按钮挂载；移动几何没有这条桌面控件，不给它虚构整个播放器的障碍矩形。
  defineBrowserPort(f.player.querySelector('.ytp-right-controls')!, 'getBoundingClientRect', {value: () => ({...bounds, width: 0, height: 0, right: 0, bottom: 48})});
  const scope = f.document.createElement('div'); scope.id = 'player-container-id'; scope.className = 'player-container sticky-player';
  f.player.before(scope); scope.appendChild(f.player);
  const root = f.document.createElement('ytm-custom-control');
  root.innerHTML = '<ytm-watch-player-controls><div id="player-control-overlay"><div class="player-controls-content"><div class="player-controls-bottom player-controls-bottom-left"></div><div class="player-controls-bottom player-controls-bottom-right"></div></div></div></ytm-watch-player-controls>';
  scope.appendChild(root);
  const controls = root.querySelectorAll<HTMLElement>('.player-controls-bottom');
  for (const [index, control] of [...controls].entries()) {
    const left = index === 0 ? 12 : 324, width = index === 0 ? 312 : 66;
    defineBrowserPort(control, 'getBoundingClientRect', {configurable: true, value: () => ({...bounds, left, width, right: left + width, top: 200, y: 200, height: 44, bottom: 244})});
  }
  const bottom = () => f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)?.style.getPropertyValue('--fluent-read-video-subtitle-bottom');
  const layoutSubscriptions = (target: Node) => [...f.observerRegistrations].filter(registrations => registrations.get(target)?.attributeFilter?.includes('hidden')).length;
  return {...f, scope, root, controls, bottom, layoutSubscriptions};
}

describe('public mounted mobile YouTube subtitle control layout', () => {
  it.each(['resize', 'orientationchange', 'visualViewport-resize', 'visualViewport-scroll'] as const)('calibrates the mobile viewport menu host before real menu measurement in the next %s frame', async eventName => {
    const f = mobileYoutubeLayoutFixture();
    const viewport = f.document.createElement('div');
    Object.assign(viewport, {width: 402, height: 720, offsetLeft: 0, offsetTop: 0, scale: 1});
    defineBrowserPort(f.window, 'visualViewport', {configurable: true, value: viewport});
    const geometry = {left: 0, top: 48, width: 402, height: 226};
    const rect = (left: number, top: number, width: number, height: number) => ({left, top, width, height,
      right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({})});
    defineBrowserPort(f.player, 'getBoundingClientRect', {configurable: true, value: () => rect(geometry.left, geometry.top, geometry.width, geometry.height)});
    defineBrowserPort(f.player, 'clientWidth', {configurable: true, get: () => geometry.width});
    defineBrowserPort(f.player, 'clientHeight', {configurable: true, get: () => geometry.height});
    const nativeRect = f.window.HTMLElement.prototype.getBoundingClientRect;
    defineBrowserPort(f.window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true, value: function (this: HTMLElement) {
      return this.classList.contains('fluent-read-video-menu-host')
        ? rect(0, 0, Number.parseFloat(this.style.width), Number.parseFloat(this.style.height)) : nativeRect.call(this);
    }});
    const dispose = f.start(); await vi.advanceTimersByTimeAsync(32);
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!, host = menu.parentElement!;
    defineBrowserPort(host, 'clientWidth', {configurable: true, get: () => Number.parseFloat(host.style.width)});
    defineBrowserPort(host, 'clientHeight', {configurable: true, get: () => Number.parseFloat(host.style.height)});
    defineBrowserPort(menu, 'scrollHeight', {configurable: true, get: () => 250});
    const button = f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!;
    const click = new f.window.Event('click', {bubbles: true}); Object.defineProperty(click, 'isTrusted', {value: true}); button.dispatchEvent(click);
    expect(menu.hidden).toBe(false); expect(menu.dataset.layout).toBe('wide'); expect(host.clientWidth).toBe(402);
    expect(host.parentElement).toBe(f.document.documentElement); expect(host.clientHeight).toBe(720);
    // 手机菜单随实际可见视口缩放和平移，播放器可保持独立的尺寸与位置。
    Object.assign(geometry, {left: 40, top: 70, width: 320, height: 180});
    Object.assign(viewport, {width: 240, height: 320, offsetLeft: 12, offsetTop: 36});
    if (eventName.startsWith('visualViewport-')) viewport.dispatchEvent(new f.window.Event(eventName.slice('visualViewport-'.length)));
    else f.window.dispatchEvent(new f.window.Event(eventName));
    // 只推进实际事件调度的一帧，远短于1秒播放器同步；不调用 binding.sync 或媒体/配置刷新。
    await vi.advanceTimersByTimeAsync(16);
    expect(menu.parentElement).toBe(host); expect(host.clientWidth).toBe(240); expect(host.clientHeight).toBe(320);
    expect(host.style.transform).toBe('translate(12px, 36px) scale(1, 1)'); expect(menu.dataset.layout).toBe('stack');
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBe(button);
    expect(f.document.querySelectorAll('#' + VIDEO_TRANSLATION_MENU_ID)).toHaveLength(1);
    f.window.dispatchEvent(new f.window.Event('resize')); dispose(); await vi.advanceTimersByTimeAsync(16);
    expect(f.document.querySelector('.fluent-read-video-menu-host')).toBeNull();
  });

  it.each([false, true])('学习宿主增删在一帧内撤回/恢复字幕host，scroll=%s，模式与Off保持正确', async scrolling => {
    ports.config.videoPreferHumanSubtitles = false;
    const f = mobileYoutubeLayoutFixture();
    for (const [className, left, top, width, height] of [
      ['player-controls-middle-core-buttons', 91, 133, 220, 56], ['player-controls-top', 234, 48, 144, 48],
    ] as const) {
      const node = f.document.createElement('div'); node.className = className; f.root.appendChild(node);
      defineBrowserPort(node, 'getBoundingClientRect', {value: () => ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {return {};}})});
    }
    const text = scrolling ? 'A long paused caption. '.repeat(40) : 'Good morning. How are you?';
    f.start(); f.emitTimedText([{startMs: 0, durationMs: 20000, text}]); f.setCaption(text); await vi.advanceTimersByTimeAsync(32);
    const panel = f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)!, layer = f.document.getElementById(VIDEO_TRANSLATION_LAYER_ID)!;
    // 浏览器测量端口区分普通卡片与极长卡片；学习宿主的真实增删由实际host实现负责。
    const height = () => Math.min(scrolling ? 600 : 60, Number.parseFloat(panel.style.maxHeight) || 600);
    defineBrowserPort(panel, 'getBoundingClientRect', {value: () => {
      const width = Math.min(153, Number.parseFloat(panel.style.maxWidth) || 153), h = height();
      const left = Number.parseFloat(panel.style.left) || 56, explicitTop = Number.parseFloat(panel.style.top);
      const top = 48 + (Number.isFinite(explicitTop) ? explicitTop : 226 - Number.parseFloat(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')) - h);
      return {left, top, width, height: h, right: left + width, bottom: top + h, x: left, y: top, toJSON() {return {};}};
    }});
    defineBrowserPort(panel, 'scrollHeight', {get: () => scrolling ? 600 : 60}); defineBrowserPort(panel, 'clientHeight', {get: height});
    f.emitVideo('timeupdate'); await vi.advanceTimersByTimeAsync(32);
    expect(panel.dataset.fluentReadSubtitleLayout).toBe(scrolling ? 'scroll' : 'free'); expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID);
    panel.scrollTop = scrolling ? 120 : 0;
    const learning = createVideoSentenceLearningHost({markUi: markVideoUi, mount: host => {
      const view = f.document.createElement('section'); host.appendChild(view); return () => view.remove();
    }, place: (host, player) => createVideoSentenceLearningPlacement({host, player,
      appearance: normalizeVideoSentenceLearningAppearance(ports.config.videoSentenceLearningAppearance), onDragPosition() {}})});
    const open = () => learning.open(f.player, {video: f.video, cues: [], platform: 'youtube', title: 'Learning', sourceLanguage: 'en', targetLanguage: 'zh-CN', translate: async value => value});
    try {
      open(); await vi.advanceTimersByTimeAsync(16);
      const learningPanel = f.document.getElementById('fluent-read-video-learning-panel')!;
      const learningFrame = learningPanel.parentElement!;
      expect(learningFrame.classList.contains('fluent-read-video-learning-frame')).toBe(true); expect(learningFrame.parentElement).toBe(f.scope);
      expect(learning.isConnected(f.player)).toBe(true); expect(panel.parentElement).toBe(layer);
      expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(panel.hasAttribute('tabindex')).toBe(false);
      // 整块frame变更也要通知真实字幕runtime；此视图端口不负责自动修复第三方DOM删除。
      learningFrame.remove(); await vi.advanceTimersByTimeAsync(16);
      expect(learning.isConnected(f.player)).toBe(false); expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID);
      f.scope.appendChild(learningFrame); await vi.advanceTimersByTimeAsync(16); expect(panel.parentElement).toBe(layer);
      const frame = vi.spyOn(f.window, 'requestAnimationFrame');
      learningPanel.setAttribute('style', learningPanel.getAttribute('style') + ';max-height:170px'); learningPanel.firstElementChild!.append('Learning content');
      learningFrame.setAttribute('style', learningFrame.getAttribute('style') + ';transform:translate(0px,0px)');
      panel.setAttribute('style', panel.getAttribute('style') + ';opacity:1'); await settle(); expect(frame).not.toHaveBeenCalled(); frame.mockRestore();
      learning.close(); await vi.advanceTimersByTimeAsync(16);
      expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID); expect(panel.scrollTop).toBe(scrolling ? 120 : 0);
      open(); await vi.advanceTimersByTimeAsync(16);
      // 切换仅原文按既有runtime契约清空翻译会话；同句滚动保留已在未换模式的关闭路径独立验证。
      f.changeConfig({videoSubtitleDisplayMode: 'original-only'}); await settle();
      expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(layer.classList.contains('fluent-read-video-display-original-only')).toBe(true);
      learning.close(); await vi.advanceTimersByTimeAsync(16);
      expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID);
      expect(panel.parentElement?.classList.contains('fluent-read-video-display-original-only')).toBe(true);
      open(); await vi.advanceTimersByTimeAsync(16); f.changeConfig({videoTranslationEnabled: false}); await settle();
      learning.close(); await vi.advanceTimersByTimeAsync(1100);
      expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(panel.hasAttribute('tabindex')).toBe(false);
    } finally {learning.close();}
  });

  it('滚动字幕通过真实入口开菜单时撤回兄弟host，关闭恢复同句位置，Off彻底清理', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const f = mobileYoutubeLayoutFixture();
    for (const [className, left, top, width, height] of [
      ['player-controls-middle-core-buttons', 91, 133, 220, 56], ['player-controls-top', 234, 48, 144, 48],
    ] as const) {
      const node = f.document.createElement('div'); node.className = className; f.root.appendChild(node);
      defineBrowserPort(node, 'getBoundingClientRect', {value: () => ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {return {};}})});
    }
    const text = 'This unusually long caption remains paused while the menu opens. '.repeat(10);
    f.start(); f.emitTimedText([{startMs: 0, durationMs: 20000, text}]); f.setCaption(text); await vi.advanceTimersByTimeAsync(32);
    const panel = f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)!;
    defineBrowserPort(panel, 'scrollHeight', {get: () => 600}); defineBrowserPort(panel, 'clientHeight', {get: () => 75});
    panel.scrollTop = 120;
    const layer = f.document.getElementById(VIDEO_TRANSLATION_LAYER_ID)!, menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID); expect(layer.parentElement).toBe(f.player);
    const toggleMenu = async () => {
      const event = new f.window.Event('click', {bubbles: true}); Object.defineProperty(event, 'isTrusted', {value: true});
      f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!.dispatchEvent(event); await settle();
    };
    await toggleMenu();
    expect(menu.hidden).toBe(false); expect(menu.parentElement?.classList.contains('fluent-read-video-menu-host')).toBe(true);
    expect(menu.parentElement?.parentElement).toBe(f.scope);
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(panel.parentElement).toBe(layer);
    expect(panel.hasAttribute('data-fluent-read-subtitle-scrollable')).toBe(false); expect(panel.hasAttribute('tabindex')).toBe(false);
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-padding')).toBeFalsy();
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(f.displayed().source).toBe(text.trim());
    await toggleMenu();
    expect(menu.hidden).toBe(true); expect(panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID); expect(panel.scrollTop).toBe(120);
    expect(f.document.querySelectorAll('#' + VIDEO_SUBTITLE_PANEL_ID)).toHaveLength(1);
    await toggleMenu(); clickMenu(f, '[data-mode="off"]'); await settle();
    expect(ports.config.videoTranslationEnabled).toBe(false); expect(menu.isConnected).toBe(false);
    expect(f.scope.querySelector('.fluent-read-video-menu-host')).toBeNull();
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(panel.hasAttribute('tabindex')).toBe(false);
  });

  it('中部和顶部控件单独显隐也触发空区重排，不依赖媒体或周期同步', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const f = mobileYoutubeLayoutFixture();
    const middle = f.document.createElement('div'); middle.className = 'player-controls-middle-core-buttons';
    const top = f.document.createElement('div'); top.className = 'player-controls-top';
    const bounds = (left: number, y: number, width: number, height: number) => ({left, top: y, width, height, right: left + width, bottom: y + height, x: left, y, toJSON() {return {};}});
    defineBrowserPort(middle, 'getBoundingClientRect', {value: () => bounds(91, 133, 220, 56)});
    defineBrowserPort(top, 'getBoundingClientRect', {value: () => bounds(234, 48, 144, 48)});
    middle.setAttribute('style', 'visibility:hidden'); top.setAttribute('style', 'visibility:hidden'); f.root.append(middle, top);
    const text = 'The controls change while this caption remains paused.';
    f.start(); f.emitTimedText([{startMs: 0, durationMs: 20000, text}]); f.setCaption(text); await vi.advanceTimersByTimeAsync(32);
    expect(f.displayed().active).toBe(true); expect(f.displayed().source).toBe(text);
    const panel = f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)!;
    expect(Number.parseFloat(panel.style.maxWidth)).toBeGreaterThan(250);
    middle.setAttribute('style', 'visibility:visible'); top.setAttribute('style', 'visibility:visible'); await vi.advanceTimersByTimeAsync(16);
    expect(Number.parseFloat(panel.style.maxWidth)).toBeLessThan(180); expect(Number.parseFloat(panel.style.maxHeight)).toBeLessThan(80);
    middle.setAttribute('style', 'visibility:hidden'); top.setAttribute('style', 'visibility:hidden'); await vi.advanceTimersByTimeAsync(16);
    expect(Number.parseFloat(panel.style.maxWidth)).toBeGreaterThan(250);
  });

  it('没有ResizeObserver的环境仍可调度，销毁后迟到帧与控件记录不能重新布局', () => {
    const f = fixture(undefined, 'youtube');
    const callbacks: MutationCallback[] = [], frames: FrameRequestCallback[] = [];
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('MutationObserver', class {constructor(callback: MutationCallback) {callbacks.push(callback);} observe() {} disconnect() {}});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.push(callback); return frames.length;});
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const layout = vi.fn(), observer = createSubtitleLayoutObserver(layout, () => true);
    callbacks[0]([], {} as MutationObserver);
    observer.observe(f.player, f.video); frames[0](0); expect(layout).toHaveBeenCalledOnce();
    observer.schedule(); observer.destroy(); frames[1](16); callbacks[0]([], {} as MutationObserver); observer.schedule();
    expect(layout).toHaveBeenCalledOnce(); expect(frames).toHaveLength(2);
  });

  it('updates sibling control visibility and replacement within one layout frame without a manual subtitle sync', async () => {
    const f = mobileYoutubeLayoutFixture(); f.root.style.visibility = 'hidden';
    f.start(); f.setCaption('Mobile sibling control caption.');
    await vi.advanceTimersByTimeAsync(32);
    expect(f.bottom()).toBe('12px'); expect(f.layoutSubscriptions(f.scope)).toBe(1);
    const requestFrame = vi.spyOn(f.window, 'requestAnimationFrame');
    try {
      const panel = f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)!;
      panel.setAttribute('style', panel.getAttribute('style') + ';max-width:280px');
      f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.classList.add('fixture-menu-state');
      await settle(); expect(requestFrame).not.toHaveBeenCalled();
      // linkedom 的 CSSStyleDeclaration 不派发 style 记录；setAttribute 保留原生 DOM 记录与实际订阅回调。
      f.root.setAttribute('style', 'visibility:visible'); f.root.setAttribute('style', 'visibility:visible;opacity:1');
      await settle(); expect(requestFrame).toHaveBeenCalledTimes(1);
    } finally {requestFrame.mockRestore();}
    // 只推进一帧，短于播放器周期同步；不手动触发字幕/媒体/resize 更新。
    await vi.advanceTimersByTimeAsync(16);
    expect(f.bottom()).toBe('82px');
    f.root.setAttribute('style', 'opacity:0'); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('12px');
    f.root.setAttribute('style', 'opacity:1'); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('82px');
    f.root.hidden = true; await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('12px');
    f.root.hidden = false; await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('82px');
    // class 改变后的 computed visibility 来自宿主 CSS；保留真实 MutationObserver 和布局消费者。
    const computed = f.window.getComputedStyle;
    const hiddenByClass = (element: Element) => ({...computed(element), visibility: element.classList.contains('controls-hidden') ? 'hidden' : computed(element).visibility});
    defineBrowserPort(f.window, 'getComputedStyle', {configurable: true, value: hiddenByClass});
    vi.stubGlobal('getComputedStyle', hiddenByClass);
    const ancestor = f.root.querySelector<HTMLElement>('#player-control-overlay')!;
    ancestor.classList.add('controls-hidden'); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('12px');
    ancestor.classList.remove('controls-hidden'); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('82px');
    f.root.remove(); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('12px');
    f.scope.appendChild(f.root); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('82px');
  });

  it('rebinds the same video to its new scope and releases subscriptions on Off and destroy', async () => {
    const f = mobileYoutubeLayoutFixture(); const dispose = f.start();
    f.setCaption('The same mobile video keeps its caption.'); await vi.advanceTimersByTimeAsync(32);
    expect(f.bottom()).toBe('82px');
    const nextScope = f.document.createElement('div'); nextScope.id = 'player-container-id'; nextScope.className = 'player-container';
    f.scope.id = 'old-player-container'; f.scope.after(nextScope); nextScope.appendChild(f.player);
    await vi.advanceTimersByTimeAsync(32);
    expect(f.bottom()).toBe('12px'); expect(f.layoutSubscriptions(f.scope)).toBe(0); expect(f.layoutSubscriptions(nextScope)).toBe(1);
    nextScope.appendChild(f.root); await vi.advanceTimersByTimeAsync(16); expect(f.bottom()).toBe('82px');
    const secondVideo = f.document.createElement('video'); nextScope.appendChild(secondVideo);
    await vi.advanceTimersByTimeAsync(32);
    expect(f.bottom()).toBe('12px'); expect(f.layoutSubscriptions(nextScope)).toBe(0);
    secondVideo.remove(); f.changeConfig({videoSubtitleVisible: false}); await settle();
    expect(f.layoutSubscriptions(f.player)).toBe(0);
    f.changeConfig({videoSubtitleVisible: true}); await vi.advanceTimersByTimeAsync(16);
    expect(f.bottom()).toBe('82px'); expect(f.layoutSubscriptions(nextScope)).toBe(1);
    f.changeConfig({videoTranslationEnabled: false}); await settle();
    expect(f.layoutSubscriptions(nextScope)).toBe(0);
    const disabledBottom = f.bottom();
    f.root.setAttribute('style', 'visibility:hidden'); await vi.advanceTimersByTimeAsync(16);
    expect(f.bottom()).toBe(disabledBottom); expect(f.displayed().active).toBe(false);
    f.changeConfig({videoTranslationEnabled: true}); await vi.advanceTimersByTimeAsync(16);
    expect(f.layoutSubscriptions(nextScope)).toBe(1);
    dispose(); await settle();
    expect([...f.observerRegistrations].every(registrations => registrations.size === 0)).toBe(true);
    f.root.setAttribute('style', 'visibility:visible'); await vi.advanceTimersByTimeAsync(32);
    expect(f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)).toBeNull();
  });
});

function clickMenu(f: ReturnType<typeof fixture>, selector: string) {
  const event = new f.window.Event('click', {bubbles: true});
  Object.defineProperty(event, 'isTrusted', {value: true});
  f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.querySelector(selector)!.dispatchEvent(event);
}

describe('public mounted player menu entry semantics', () => {
  it.each(['youtube', 'x'] as const)('双语顺序从 %s 实际菜单保存并立即重排，保留节点与翻译缓存', async platform => {
    const f = fixture(platform === 'x' ? nativeSource : undefined, platform);
    if (platform === 'youtube') f.setCaption(nativeSource);
    f.start(); await vi.advanceTimersByTimeAsync(300);
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    const source = f.document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID)!;
    const translated = f.document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID)!;
    const panel = f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)!;
    const initial = f.displayed(), calls = ports.translate.mock.calls.length;
    const appearance = {...(ports.config as unknown as Config).videoSubtitleAppearance};
    expect(initial.source).toBeTruthy(); expect(initial.translated).toBeTruthy();
    for (const order of ['translation-first', 'original-first', 'translation-first'] as const) {
      clickMenu(f, `[data-subtitle-order="${order}"]`); await settle();
      expect(ports.patch).toHaveBeenLastCalledWith({videoSubtitleAppearance: {...appearance, bilingualOrder: order}});
      expect(menu.querySelector(`[data-subtitle-order="${order}"]`)?.getAttribute('aria-checked')).toBe('true');
      expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-translation-order')).toBe(order === 'translation-first' ? '0' : '3');
      expect(f.displayed()).toEqual(initial);
      expect(f.document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID)).toBe(source);
      expect(f.document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID)).toBe(translated);
      expect(ports.translate).toHaveBeenCalledTimes(calls);
    }
    // 外部设置更新走同一订阅，单语显示方式和其偏好均保持。
    f.changeConfig({videoSubtitleDisplayMode: 'original-only', videoSubtitleAppearance: {...appearance, bilingualOrder: 'original-first'}});
    await settle();
    expect((ports.config as unknown as Config).videoSubtitleDisplayMode).toBe('original-only');
    expect(menu.querySelector('[data-subtitle-order="original-first"]')?.getAttribute('aria-checked')).toBe('true');
    expect([...menu.querySelectorAll<HTMLButtonElement>('[data-subtitle-order]')].every(button => button.disabled)).toBe(true);
    expect(menu.querySelector<HTMLElement>('[data-subtitle-order-hint]')?.hidden).toBe(false);
    const savedPatches = ports.patch.mock.calls.length;
    clickMenu(f, '[data-subtitle-order="translation-first"]'); await settle();
    expect(ports.patch).toHaveBeenCalledTimes(savedPatches);
    clickMenu(f, '.fluent-read-video-menu-mode-group [data-mode="bilingual"]'); await settle();
    expect([...menu.querySelectorAll<HTMLButtonElement>('[data-subtitle-order]')].every(button => !button.disabled)).toBe(true);
    expect(menu.querySelector<HTMLElement>('[data-subtitle-order-hint]')?.hidden).toBe(true);
    expect(menu.querySelector('[data-subtitle-order="original-first"]')?.getAttribute('aria-checked')).toBe('true');
    f.changeConfig({videoSubtitleDisplayMode: 'translation-only', videoSubtitleAppearance: {...appearance, readingAnnotation: true}});
    await settle();
    expect(menu.querySelector<HTMLButtonElement>('[data-reading-bilingual]')?.hidden).toBe(false);
    expect((ports.config as unknown as Config).videoSubtitleDisplayMode).toBe('translation-only');
    clickMenu(f, '[data-action="show-reading-original"]'); await settle();
    expect((ports.config as unknown as Config).videoSubtitleDisplayMode).toBe('bilingual');
    expect((ports.config as unknown as Config).videoSubtitleAppearance.readingAnnotation).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>('[data-reading-bilingual]')?.hidden).toBe(true);
  });

  it('fetches an uncaptured YouTube track for export while hidden and reuses that captured track when captions reopen', async () => {
    const f = fixture(undefined, 'youtube');Object.assign(ports.config, {videoSubtitleVisible: false});
    const track = {baseUrl: 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en', languageCode: 'en'};
    const script = f.document.createElement('script');script.textContent = `var ytInitialPlayerResponse=${JSON.stringify({videoDetails: {videoId: 'cue-proof'}, captions: {playerCaptionsTracklistRenderer: {captionTracks: [track]}}})};`;
    f.document.body.append(script);const blobs: Blob[] = [];
    defineBrowserPort(URL, 'createObjectURL', {configurable: true, value: (blob: Blob) => {blobs.push(blob);return 'blob:youtube-export';}});
    defineBrowserPort(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()});
    ports.fetch.mockImplementation(async () => new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 6000, segs: [{utf8: 'The original exported sentence.'}]}]})));
    f.start();await settle();expect(ports.fetch).not.toHaveBeenCalled();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;menu.hidden = false;
    clickMenu(f, '[data-action="download-subtitles"]');await settle();
    expect(ports.fetch).toHaveBeenCalledOnce();expect(await blobs[0].text()).toContain('The original exported sentence.');
    f.setCaption('The original exported sentence.');clickMenu(f, '[data-mode="bilingual"]');await vi.advanceTimersByTimeAsync(1000);
    expect(ports.config.videoSubtitleVisible).toBe(true);expect(ports.fetch).toHaveBeenCalledOnce();
    expect(f.displayed().source).toBe('The original exported sentence.');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:youtube-export');
  });

  it('exports a native X track with explicit missing-translation confirmation and cancels a later export cleanly', async () => {
    const f = fixture('Current native sentence.');
    Object.defineProperty(f.native!, 'cues', {configurable: true, value: [
      {startTime: 0, endTime: 10, text: 'Current native sentence.'}, {startTime: 40, endTime: 45, text: 'A future native sentence.'},
    ]});
    const blobs: Blob[] = [];
    defineBrowserPort(URL, 'createObjectURL', {configurable: true, value: (blob: Blob) => {blobs.push(blob);return `blob:download-${blobs.length}`;}});
    defineBrowserPort(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()});
    f.start();f.emitVideo('loadedmetadata');await vi.advanceTimersByTimeAsync(1000);const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;menu.hidden = false;
    clickMenu(f, '[data-action="open-subtitle-tools"]');clickMenu(f, '[data-action="download-subtitles"]');await settle();
    expect(await blobs[0].text()).toContain('00:00:40,000 --> 00:00:45,000\nA future native sentence.');
    clickMenu(f, '[data-action="download-bilingual-subtitles"]');await settle();
    expect(menu.querySelector('[data-export-prompt]')).not.toBeNull();expect(f.callsFor('A future native sentence.')).toBe(0);
    clickMenu(f, '[data-export-choice="complete"]');await settle();
    expect(f.callsFor('A future native sentence.')).toBe(1);
    expect(await blobs[1].text()).toContain('A future native sentence.\n测试译文：A future native sentence.');
    clickMenu(f, '[data-action="download-translated-subtitles"]');await settle();
    clickMenu(f, '[data-export-choice="cancel"]');await settle();
    expect(blobs).toHaveLength(2);expect(menu.querySelector('[data-download-status]')?.textContent).toContain('取消');
    await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('prepares the real native fullscreen text track from the runtime translation cache and removes it on Off', async () => {
    const f = fixture(undefined, 'youtube');f.setCaption('A native fullscreen sentence.');
    Object.assign(ports.config, {videoPreferHumanSubtitles: false});Object.assign(f.video, {webkitEnterFullscreen: vi.fn()});
    class CuePort {constructor(readonly startTime: number, readonly endTime: number, public text: string) {}}
    defineBrowserPort(f.window, 'VTTCue', {configurable: true, value: CuePort});
    const createElement = f.document.createElement.bind(f.document), created: any[] = [];
    defineBrowserPort(f.document, 'createElement', {configurable: true, value: (tag: string, options?: ElementCreationOptions) => {
      const node = createElement(tag, options);
      if (tag === 'track') {
        const track = Object.assign(new f.window.EventTarget(), {mode: 'disabled', kind: 'subtitles', cues: [] as CuePort[], addCue(cue: CuePort) {this.cues.push(cue);}, removeCue(cue: CuePort) {this.cues.splice(this.cues.indexOf(cue), 1);}});
        Object.defineProperty(node, 'track', {value: track});created.push({node, track});f.tracks.push(track as unknown as TextTrack);
      }
      return node;
    }});
    f.start();f.emitTimedText([{startMs: 0, durationMs: 6000, text: 'A native fullscreen sentence.'}]);await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(1);expect(created[0].track.cues[0].text).toBe('A native fullscreen sentence.\n' + translation('A native fullscreen sentence.'));
    f.video.dispatchEvent(new f.window.Event('webkitbeginfullscreen'));expect(created[0].track.mode).toBe('hidden');
    created[0].track.mode = 'showing';f.changeTracks();
    f.changeConfig({videoSubtitleDisplayMode: 'original-only'});await settle();expect(created[0].track.cues[0].text).toBe('A native fullscreen sentence.');
    f.changeConfig({videoTranslationEnabled: false});await settle();expect(created[0].node.isConnected).toBe(false);
  });

  it('opens the actual sentence learning SFC with the current timeline, enables native captions, and closes through its control', async () => {
    // Vue 开发构建的 devtools 等待属于框架；显式提供端口，便于严格检查 feature 计时器清理。
    vi.stubGlobal('__VUE_DEVTOOLS_GLOBAL_HOOK__', {emit: vi.fn()});
    const f = fixture(undefined, 'youtube');Object.assign(ports.config, {from: 'en'});
    f.setCaption('A complete sentence to learn.');
    Object.assign(f.video, {pause: vi.fn(), play: vi.fn(async () => undefined)});
    const native = f.document.querySelector('.ytp-subtitles-button')!;native.setAttribute('aria-pressed', 'false');
    const nativeClick = vi.fn(() => native.setAttribute('aria-pressed', 'true'));native.addEventListener('click', nativeClick);
    f.start();f.emitTimedText([{startMs: 0, durationMs: 6000, text: 'A complete sentence to learn.'}]);await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;menu.hidden = false;
    clickMenu(f, '[data-action="open-sentence-learning"]');
    await vi.dynamicImportSettled();await settle();await vi.advanceTimersByTimeAsync(20);
    const panel = f.document.getElementById('fluent-read-video-learning-panel');
    expect(panel).not.toBeNull();expect(menu.hidden).toBe(true);expect(nativeClick).toHaveBeenCalledOnce();
    expect(panel!.querySelector('[data-learning-original]')?.textContent).toBe('A complete sentence to learn.');
    expect(ports.translate).toHaveBeenCalledWith('A complete sentence to learn.', expect.any(AbortSignal), 'en');
    panel!.querySelector('[data-learning-action="close"]')!.dispatchEvent(new f.window.Event('click', {bubbles: true}));await settle();
    expect(panel!.isConnected).toBe(false);
    menu.hidden = false;clickMenu(f, '[data-action="open-sentence-learning"]');await vi.dynamicImportSettled();await settle();
    expect(f.document.getElementById('fluent-read-video-learning-panel')).not.toBeNull();expect(nativeClick).toHaveBeenCalledOnce();
    f.changeConfig({videoTranslationEnabled: false});await settle();expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
  });

  it('routes the public entry to meeting captions and persists the actual platform display control', async () => {
    const f = fixture();
    defineBrowserPort(f.window, 'location', {configurable: true, value: new URL('https://meet.google.com/abc-defg-hij')});
    const stylePrototype = Object.getPrototypeOf(f.player.style), priorities = new WeakMap<object, Map<string, string>>();
    const set = stylePrototype.setProperty, remove = stylePrototype.removeProperty;
    defineBrowserPort(stylePrototype, 'getPropertyPriority', {configurable: true, value: function(this: object, key: string) {return priorities.get(this)?.get(key) || '';}});
    defineBrowserPort(stylePrototype, 'setProperty', {configurable: true, value: function(this: object, key: string, value: string, priority = '') {if (!priorities.has(this)) priorities.set(this, new Map());priorities.get(this)!.set(key, priority);return set.call(this, key, value);}});
    defineBrowserPort(stylePrototype, 'removeProperty', {configurable: true, value: function(this: object, key: string) {priorities.get(this)?.delete(key);return remove.call(this, key);}});
    const caption = f.document.createElement('div');caption.setAttribute('data-caption-text', '');caption.textContent = 'A meeting caption to translate.';f.player.append(caption);
    const dispose = f.start();await vi.advanceTimersByTimeAsync(30);
    const host = f.document.getElementById('fluent-read-platform-captions')!, root = host.shadowRoot!;
    expect(root.querySelector('.source')?.textContent).toBe(caption.textContent);
    expect(root.querySelector('.translation')?.textContent).toBe(translation(caption.textContent!));
    expect(root.querySelector('.panel')?.getAttribute('aria-label')).toBe('双语字幕');
    const mode = root.querySelector('select')!;mode.value = 'original-only';mode.dispatchEvent(new f.window.Event('change'));await vi.advanceTimersByTimeAsync(30);
    expect(ports.patch).toHaveBeenCalledWith({videoSubtitleDisplayMode: 'original-only'});
    expect(root.querySelector('.translation')!.textContent).toBe('');
    mode.value = 'off';mode.dispatchEvent(new f.window.Event('change'));await vi.advanceTimersByTimeAsync(30);
    expect(ports.patch).toHaveBeenLastCalledWith({videoSubtitleVisible: false});expect(host.hidden).toBe(true);
    dispose();expect(host.isConnected).toBe(false);
  });

  it.each(['x', 'youtube'] as const)('%s 入口只展开菜单，字幕模式与本机字幕开关保留各自语义', async platform => {
    Object.assign(ports.config, {uiLanguage: 'zh-CN'});
    const f = fixture(undefined, platform); const dispose = f.start(); await settle();
    const button = f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!;
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    const selectedMode = () => menu.querySelector<HTMLElement>('[data-mode][aria-checked="true"]')?.dataset.mode;
    const subtitleSettings = () => ({enabled: ports.config.videoTranslationEnabled,
      visible: ports.config.videoSubtitleVisible, mode: ports.config.videoSubtitleDisplayMode});
    const clickEntry = async (trusted = true, entry = button) => {
      const event = new f.window.Event('click', {bubbles: true});
      Object.defineProperty(event, 'isTrusted', {value: trusted});
      entry.dispatchEvent(event); await settle();
    };
    const expectMenuButton = (expanded: boolean, entry = button, currentMenu = menu) => {
      expect(entry.getAttribute('role')).toBe('button');
      expect(entry.getAttribute('aria-haspopup')).toBe('menu');
      expect(entry.getAttribute('aria-controls')).toBe(VIDEO_TRANSLATION_MENU_ID);
      expect(entry.hasAttribute('aria-pressed')).toBe(false);
      expect(entry.getAttribute('aria-expanded')).toBe(String(expanded));
      expect(currentMenu.hidden).toBe(!expanded);
      expect(entry.title).toBe(entry.getAttribute('aria-label'));
    };
    expectMenuButton(false);
    expect(button.getAttribute('aria-label')).toContain('已开启');
    expect(button.classList.contains(VIDEO_TRANSLATION_ACTIVE_CLASS)).toBe(true);
    expect(selectedMode()).toBe('bilingual');
    const initialSettings = subtitleSettings(), initialRequests = ports.translate.mock.calls.length;
    await clickEntry(false); expectMenuButton(false);
    await clickEntry(); expectMenuButton(true);
    await clickEntry(); expectMenuButton(false);
    expect(subtitleSettings()).toEqual(initialSettings);
    expect(ports.patch).not.toHaveBeenCalled();
    expect(ports.translate).toHaveBeenCalledTimes(initialRequests);

    // 启用时刷新同一入口会清理旧 pressed；语言刷新不改变字幕或菜单状态。
    button.setAttribute('aria-pressed', 'true');
    f.changeConfig({uiLanguage: 'en-US'}); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBe(button);
    expectMenuButton(false);
    expect(button.getAttribute('aria-label')).toContain('Enabled');
    expect(button.classList.contains(VIDEO_TRANSLATION_ACTIVE_CLASS)).toBe(true);
    expect(selectedMode()).toBe('bilingual');
    expect(subtitleSettings()).toEqual(initialSettings);
    expect(ports.patch).not.toHaveBeenCalled();
    expect(ports.translate).toHaveBeenCalledTimes(initialRequests);

    await clickEntry(); expectMenuButton(true);
    clickMenu(f, '[data-mode="off"]'); await settle();
    expect(ports.patch).toHaveBeenCalledOnce();
    expect(ports.patch).toHaveBeenLastCalledWith({videoTranslationEnabled: false});
    expect(subtitleSettings()).toEqual({...initialSettings, enabled: false});
    // #1004：Off 关闭视频功能后移除入口和菜单，不从已卸载菜单内重新启用。
    expect(button.isConnected).toBe(false); expect(menu.isConnected).toBe(false);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    if (platform === 'youtube') {
      expect(f.document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')).toBe('true');
    }
    f.changeConfig({uiLanguage: 'zh-CN'}); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    dispose(); await settle();

    // 禁用时重新挂载仍不创建播放器 UI；外部配置重新启用才创建全新节点。
    const disposeRemounted = f.start(); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    f.changeConfig({videoTranslationEnabled: true, uiLanguage: 'en-US'}); await settle();
    const replacement = f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!;
    const replacementMenu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    expect(replacement).not.toBe(button); expect(replacementMenu).not.toBe(menu);
    expect(f.document.querySelectorAll(`#${VIDEO_TRANSLATION_BUTTON_ID}`)).toHaveLength(1);
    expect(f.document.querySelectorAll(`#${VIDEO_TRANSLATION_MENU_ID}`)).toHaveLength(1);
    expectMenuButton(false, replacement, replacementMenu);
    expect(replacement.getAttribute('aria-label')).toContain('Enabled');
    expect(replacement.classList.contains(VIDEO_TRANSLATION_ACTIVE_CLASS)).toBe(true);
    expect(subtitleSettings()).toEqual(initialSettings);
    const enabledRequests = ports.translate.mock.calls.length;
    await clickEntry(true, replacement); expectMenuButton(true, replacement, replacementMenu);
    clickMenu(f, '[data-action="close-menu"]'); await settle();
    expectMenuButton(false, replacement, replacementMenu);
    expect(ports.patch).toHaveBeenCalledOnce();
    expect(ports.translate).toHaveBeenCalledTimes(enabledRequests);
    disposeRemounted(); await settle();
    expect(replacement.isConnected).toBe(false); expect(replacementMenu.isConnected).toBe(false);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();

    // 已启用时重新挂载也使用新节点及新监听，不复活旧入口或旧菜单。
    const disposeEnabledRemount = f.start(); await settle();
    const freshButton = f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)!;
    const freshMenu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    expect(freshButton).not.toBe(replacement); expect(freshMenu).not.toBe(replacementMenu);
    expectMenuButton(false, freshButton, freshMenu);
    expect(freshButton.getAttribute('aria-label')).toContain('Enabled');
    const remountRequests = ports.translate.mock.calls.length;
    await clickEntry(true, freshButton); expectMenuButton(true, freshButton, freshMenu);
    expect(ports.patch).toHaveBeenCalledOnce();
    expect(ports.translate).toHaveBeenCalledTimes(remountRequests);
    disposeEnabledRemount(); await settle();
    expect(freshButton.isConnected).toBe(false); expect(freshMenu.isConnected).toBe(false);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
  });
});

describe('public mounted X subtitle track priority and lifecycle', () => {
  it('reports a model download failure in the actual menu and releases its progress subscription before retry', async () => {
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {success: true, hit: false};
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: []};
      if (message.type === 'fluentReadPrepareLocalVideoModel') return {success: false, error: '模型镜像暂时不可用'};
      return {success: true};
    });
    const f = fixture();f.start();await settle();const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;menu.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]');await settle();clickMenu(f, '[data-action="model-prompt-confirm"]');await settle();
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;
    expect(button.disabled).toBe(false);expect(button.dataset.error).toBe('true');expect(button.title).toContain('模型下载失败，请检查网络后重试');
    expect(ports.stopProgress).toHaveBeenCalledOnce();expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadTranscribeLocalVideoAudio')).toBe(false);
    clickMenu(f, '[data-action="toggle-ai-subtitle"]');await settle();expect(menu.dataset.view).toBe('model-prompt');
  });

  it('accepts a sidecar for a single anonymous blob player but does not attach a later ambiguous resource', async () => {
    const f = fixture();f.video.src = 'blob:anonymous-player';f.video.poster = '';
    f.start();await settle();f.emitCue('single', 'A single-player sidecar sentence.');await settle();
    expect(f.displayed().source).toBe('A single-player sidecar sentence.');
    f.player.append(f.document.createElement('video'));
    f.emitCue('ambiguous', 'An unrelated second-player sentence.');await settle();
    expect(f.callsFor('An unrelated second-player sentence.')).toBe(0);
    expect(f.displayed().source).toBe('A single-player sidecar sentence.');
  });

  it.each(['complete', 'cancel'] as const)('the actual AI menu keeps hidden scan fallback independent of visible playback and cleans it on %s', async outcome => {
    const text = 'The hidden scan preserved visible playback.';
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {success: true, hit: false};
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny']};
      if (message.type === 'fluentReadTranscribeLocalVideoAudio') return {success: true, text, segments: [{startMs: 0, endMs: 3000, text}]};
      return {success: true};
    });
    const f = fixture();f.video.src = 'blob:hidden-scan';f.video.poster = '';
    Object.defineProperties(f.video, {duration: {configurable: true, value: 3}, playbackRate: {configurable: true, value: 1.5}, muted: {configurable: true, value: false}, volume: {configurable: true, value: .4}});
    const mainPlay = vi.fn(async () => {Object.defineProperty(f.video, 'paused', {configurable: true, writable: true, value: false});f.emitVideo('play');}), mainPause = vi.fn(() => {Object.defineProperty(f.video, 'paused', {configurable: true, writable: true, value: true});f.emitVideo('pause');});
    Object.assign(f.video, {play: mainPlay, pause: mainPause});f.video.currentTime = 1.2;
    const scans: Array<HTMLVideoElement & {play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>}> = [];
    const createElement = f.document.createElement.bind(f.document);
    defineBrowserPort(f.document, 'createElement', {configurable: true, value: (tag: string, options?: ElementCreationOptions) => {
      const node = createElement(tag, options);
      if (tag === 'video') {
        Object.defineProperties(node, {readyState: {configurable: true, value: 4}, duration: {configurable: true, value: 3}, currentTime: {configurable: true, writable: true, value: 0}, ended: {configurable: true, writable: true, value: false}});
        Object.assign(node, {load: vi.fn(), play: vi.fn(async () => undefined), pause: vi.fn()});
        scans.push(node as typeof scans[number]);
      }
      return node;
    }});
    const contexts: ScanAudioContext[] = [];
    class ScanAudioContext {
      state = 'running';destination = {};source = {connect: vi.fn(), disconnect: vi.fn()};
      processor = {connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as null | ((event: any) => void)};
      gain = {gain: {value: 1}, connect: vi.fn(), disconnect: vi.fn()};
      close = vi.fn(async () => {this.state = 'closed';});resume = vi.fn(async () => undefined);
      constructor() {contexts.push(this);}
      createMediaElementSource(video: HTMLVideoElement) {expect(video).toBe(scans[0]);return this.source;}
      createScriptProcessor() {return this.processor;}
      createGain() {return this.gain;}
    }
    vi.stubGlobal('AudioContext', ScanAudioContext);defineBrowserPort(f.window, 'AudioContext', {configurable: true, value: ScanAudioContext});
    ports.fetch.mockRejectedValue(new Error('MSE blob cannot be fetched'));
    f.start();await settle();f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]');await settle();
    expect(scans).toHaveLength(1);expect(contexts).toHaveLength(1);expect(scans[0].play).toHaveBeenCalledOnce();
    expect(scans[0].getAttribute('aria-hidden')).toBe('true');expect(contexts[0].gain.gain.value).toBe(0);
    expect(mainPlay).not.toHaveBeenCalled();expect(mainPause).not.toHaveBeenCalled();
    expect(f.video.currentTime).toBe(1.2);expect(f.video.playbackRate).toBe(1.5);expect(f.video.volume).toBe(.4);
    await mainPlay();mainPause();await mainPlay();await settle();
    expect(contexts).toHaveLength(1);expect(scans[0].pause).not.toHaveBeenCalled();
    if (outcome === 'complete') {
      scans[0].currentTime = 3;
      contexts[0].processor.onaudioprocess!({inputBuffer: {numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(48000).fill(.1)}});
      Object.defineProperty(scans[0], 'ended', {configurable: true, value: true});scans[0].dispatchEvent(new f.window.Event('ended'));
      await vi.advanceTimersByTimeAsync(500);
      expect(f.displayed()).toMatchObject({source: text, translated: translation(text), kind: 'ai'});
      expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadSetVideoAiSubtitleCache')).toBe(true);
      f.video.currentTime = 2;f.emitVideo('pause');f.emitVideo('play');await settle();
      expect(f.displayed().source).toBe(text);expect(contexts).toHaveLength(1);
    } else {
      clickMenu(f, '[data-action="toggle-ai-subtitle"]');await settle();
      expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadTranscribeLocalVideoAudio')).toBe(false);
      expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadSetVideoAiSubtitleCache')).toBe(false);
    }
    expect(contexts[0].close).toHaveBeenCalledOnce();expect(contexts[0].processor.onaudioprocess).toBeNull();
    expect(scans[0].isConnected).toBe(false);expect(scans[0].pause).toHaveBeenCalledOnce();
    expect(mainPlay).toHaveBeenCalledTimes(2);expect(mainPause).toHaveBeenCalledOnce();
    expect(f.video.playbackRate).toBe(1.5);expect(f.video.volume).toBe(.4);
  });

  it('suspends the caption frame in background and restores the same timeline on visibility/pageshow', async () => {
    const f = fixture('A visible original caption.');let frameId = 0;
    const requestFrame = vi.fn(() => ++frameId), cancelFrame = vi.fn();
    Object.assign(f.video, {requestVideoFrameCallback: requestFrame, cancelVideoFrameCallback: cancelFrame});Object.defineProperty(f.video, 'paused', {configurable: true, writable: true, value: false});
    defineBrowserPort(f.document, 'visibilityState', {configurable: true, value: 'visible'});
    const dispose = f.start();await settle();expect(requestFrame).toHaveBeenCalledOnce();
    const displayed = f.displayed();
    defineBrowserPort(f.document, 'visibilityState', {configurable: true, value: 'hidden'});
    f.document.dispatchEvent(new f.window.Event('visibilitychange'));expect(cancelFrame).toHaveBeenCalledWith(1);
    defineBrowserPort(f.document, 'visibilityState', {configurable: true, value: 'visible'});
    f.document.dispatchEvent(new f.window.Event('visibilitychange'));f.window.dispatchEvent(new f.window.Event('pageshow'));await vi.advanceTimersByTimeAsync(20);
    expect(f.displayed()).toEqual(displayed);expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(f.callsFor('A visible original caption.')).toBe(1);
    dispose();f.window.dispatchEvent(new f.window.Event('pageshow'));f.document.dispatchEvent(new f.window.Event('visibilitychange'));
    await settle();expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();expect(requestFrame).toHaveBeenCalledTimes(2);
  });
  const requestChanges: Array<{label: string; before: Partial<Config>; after: Partial<Config>}> = [
    {label: '免费线路顺序', before: {videoService: services.freeTranslation, freeTranslationOrder: ['microsoft', 'google']}, after: {freeTranslationOrder: ['google', 'microsoft']}},
    {label: '免费线路模式', before: {videoService: services.freeTranslation, freeTranslationMode: 'balanced'}, after: {freeTranslationMode: 'sequential'}},
    {label: 'DeepL API 套餐', before: {videoService: services.deepL, deeplApiPlan: 'free'}, after: {deeplApiPlan: 'pro'}},
  ];
  it.each(requestChanges)('$label 改变后，同源字幕清除旧成功缓存并重新翻译，同值回声不重复请求', async ({before, after}) => {
    Object.assign(ports.config, before);
    ports.translate.mockResolvedValueOnce('旧配置的译文').mockResolvedValueOnce('新配置的译文');
    const f = fixture(); f.start(); await settle();
    const source = 'The same subtitle after a real service setting changes.';
    f.emitCue('settings', source); await settle();
    expect(f.displayed()).toMatchObject({source, translated: '旧配置的译文', active: true});
    f.emitVideo('timeupdate'); await settle();
    expect(f.callsFor(source)).toBe(1);

    f.changeConfig(after); await settle();
    expect(f.callsFor(source)).toBe(2);
    expect(f.displayed()).toMatchObject({source, translated: '新配置的译文', active: true});
    f.changeConfig(after); await settle();
    expect(f.callsFor(source)).toBe(2);
  });
  it.each(requestChanges)('$label 改变后取消旧同源请求，迟到旧结果不写回新缓存或播放器', async ({before, after}) => {
    Object.assign(ports.config, before);
    const old = deferred<string>();
    let oldSignal!: AbortSignal;
    ports.translate.mockImplementationOnce((_text: string, signal: AbortSignal) => {oldSignal = signal; return old.promise;})
      .mockResolvedValueOnce('新配置的有效译文');
    const f = fixture(); f.start(); await settle();
    const source = 'An identical subtitle with an obsolete translation in flight.';
    f.emitCue('late-settings', source); await settle();
    expect(f.callsFor(source)).toBe(1);

    f.changeConfig(after); await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(f.callsFor(source)).toBe(2);
    expect(f.displayed()).toMatchObject({source, translated: '新配置的有效译文', active: true});
    old.resolve('旧配置的迟到译文'); await settle();
    f.emitVideo('timeupdate'); await settle();
    expect(f.callsFor(source)).toBe(2);
    expect(f.displayed()).toMatchObject({source, translated: '新配置的有效译文', active: true});
  });
  it('does not run an empty frame clock on ordinary YouTube; a later progressive cue starts and releases the clock at its boundary', async () => {
    const f = fixture();
    // 本例只验证媒体帧调度；原生字幕由下面的真实消息/媒体事件驱动。
    // linkedom 的 observer 与浏览器对样式 DOM 的通知不同，避免混入无关的模拟微任务循环。
    vi.stubGlobal('MutationObserver', class {observe() {} disconnect() {}});
    defineBrowserPort(f.window, 'location', {configurable: true, value: new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')});
    f.player.id = 'movie_player';
    f.player.insertAdjacentHTML('beforeend', '<button class="ytp-subtitles-button" aria-pressed="true"></button><div id="ytp-caption-window-container"><span class="ytp-caption-segment">A bounded caption sentence.</span></div>');
    Object.assign(f.video, {paused: false});
    let callback: (() => void) | undefined;
    const request = vi.fn((next: () => void) => {callback = next; return request.mock.calls.length;});
    const cancel = vi.fn();
    Object.assign(f.video, {requestVideoFrameCallback: request, cancelVideoFrameCallback: cancel});
    const dispose = f.start(); await settle();
    expect(request).not.toHaveBeenCalled();
    f.emitVideo('timeupdate'); f.emitVideo('play'); await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    const message = new f.window.Event('message');
    Object.defineProperties(message, {source: {value: f.window}, origin: {value: f.window.location.origin},
      data: {value: {source: 'fluent-read', type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=json3',
        responseText: JSON.stringify({events: [{tStartMs: 0, dDurationMs: 3000, segs: [{utf8: 'A bounded caption sentence.'}]}]})}}});
    f.window.dispatchEvent(message); await settle();
    expect(request).toHaveBeenCalledOnce();
    f.video.currentTime = 2; callback!(); expect(request).toHaveBeenCalledTimes(2);
    f.video.currentTime = 3.5; callback!(); expect(request).toHaveBeenCalledTimes(2);
    f.emitVideo('timeupdate'); expect(request).toHaveBeenCalledTimes(2);
    expect(f.video.playbackRate).toBe(1);
    dispose();
  });

  it('opens the model selector with the configured cached model and cancels without replacing ready captions', async () => {
    const saved = 'Ready captions should remain until confirmation.';
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {
        success: true, hit: true, cues: [{startMs: 0, durationMs: 20000, text: saved}],
      };
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny', 'small']};
      return {success: true};
    });
    const f = fixture(); f.start(); await settle();
    const before = f.displayed();
    expect(before.source).toBe(saved);
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    clickMenu(f, '[data-action="open-subtitle-tools"]');
    clickMenu(f, '[data-action="select-ai-model"]'); await settle();
    expect(menu.dataset.view).toBe('model-prompt');
    expect(menu.querySelector('[data-model-choice="tiny"]')?.getAttribute('aria-checked')).toBe('true');
    expect(f.displayed()).toEqual(before);
    clickMenu(f, '[data-model-choice="small"]');
    expect(ports.config.videoLocalModel).toBe('tiny');
    clickMenu(f, '[data-action="model-prompt-cancel"]'); await settle();
    expect(menu.dataset.view).toBe('main');
    expect(menu.dataset.panel).toBe('tools');
    expect(f.displayed()).toEqual(before);
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadPrepareLocalVideoModel'
      || message.type === 'fluentReadTranscribeLocalVideoAudio')).toBe(false);
  });

  it('confirms a cached Small model in the player and generates with automatic language without another download', async () => {
    const oldText = 'The old cached subtitle.';
    const newText = 'The newly recognized subtitle.';
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {
        success: true, hit: true, cues: [{startMs: 0, durationMs: 20000, text: oldText}],
      };
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny', 'small']};
      if (message.type === 'fluentReadTranscribeLocalVideoAudio') return {
        success: true, text: newText, segments: [{startMs: 0, endMs: 4000, text: newText}],
      };
      return {success: true};
    });
    const f = fixture();
    class DecodeContext {
      state = 'running';
      async close() { this.state = 'closed'; }
      async decodeAudioData() { return {duration: 20, numberOfChannels: 1, sampleRate: 16000,
        getChannelData: () => new Float32Array(320000).fill(.08)}; }
    }
    vi.stubGlobal('AudioContext', DecodeContext);
    defineBrowserPort(f.window, 'AudioContext', {configurable: true, value: DecodeContext});
    Object.defineProperty(f.video, 'duration', {configurable: true, value: 20});
    ports.fetch.mockResolvedValue(new Response(audioInit));
    f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    clickMenu(f, '[data-action="open-subtitle-tools"]');
    clickMenu(f, '[data-action="select-ai-model"]'); await settle();
    clickMenu(f, '[data-model-choice="small"]');
    clickMenu(f, '[data-action="model-prompt-confirm"]'); await settle();
    expect(ports.config.videoLocalModel).toBe('small');
    expect(ports.config.videoSourceLanguage).toBe('auto');
    const transcriptions = ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadTranscribeLocalVideoAudio');
    expect(transcriptions.length).toBeGreaterThan(0);
    for (const [message] of transcriptions) expect(message).toMatchObject({model: 'small', sourceLanguage: 'auto'});
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadPrepareLocalVideoModel' && !message.keepWarm)).toBe(false);
    expect(f.displayed().source).toBe(newText);
    expect(menu.querySelector('[data-action="select-ai-model"]')?.getAttribute('data-model')).toBe('small');
  });

  it('offers the model selector before any subtitle exists without starting recognition', async () => {
    ports.send.mockImplementation(async (message: {type: string}) => message.type === 'fluentReadGetLocalVideoModelState'
      ? {success: true, models: ['tiny']} : {success: true, hit: false});
    const f = fixture(); f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    expect((menu.querySelector('[data-action="open-subtitle-tools"]') as HTMLButtonElement).hidden).toBe(false);
    clickMenu(f, '[data-action="open-subtitle-tools"]');
    clickMenu(f, '[data-action="select-ai-model"]'); await settle();
    expect(menu.dataset.view).toBe('model-prompt');
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadTranscribeLocalVideoAudio')).toBe(false);
  });

  it('ignores a late old-model subtitle cache when the user explicitly opens model selection', async () => {
    const cached = deferred<unknown>();
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return cached.promise;
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny', 'small']};
      return {success: true};
    });
    const f = fixture(); f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    clickMenu(f, '[data-action="open-subtitle-tools"]');
    clickMenu(f, '[data-action="select-ai-model"]'); await settle();
    expect(menu.dataset.view).toBe('model-prompt');
    cached.resolve({success: true, hit: true, cues: [{startMs: 0, durationMs: 20000, text: 'Late old-model subtitle.'}]});
    await settle();
    expect(f.displayed().source || '').toBe('');
    expect(menu.dataset.view).toBe('model-prompt');
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadTranscribeLocalVideoAudio')).toBe(false);
    const escape = new f.window.Event('keydown', {bubbles: true});
    Object.defineProperties(escape, {isTrusted: {value: true}, key: {value: 'Escape'}});
    f.document.dispatchEvent(escape); await settle();
    expect(menu.dataset.view).toBe('main');
    expect(menu.dataset.panel).toBe('tools');
    expect(ports.config.videoLocalModel).toBe('tiny');
  });

  it.each([false, true])('keeps a pending model request across same-video metadata enrichment (download: %s)', async download => {
    const status = deferred<unknown>(), prepared = deferred<unknown>();
    ports.send.mockImplementation(async (message: {type: string; keepWarm?: boolean}) => {
      if (message.type === 'fluentReadGetLocalVideoModelState') return status.promise;
      if (message.type === 'fluentReadPrepareLocalVideoModel') return message.keepWarm ? {success: true} : prepared.promise;
      return {success: true, hit: false};
    });
    const f = fixture();
    f.video.src = 'blob:same-media'; f.video.poster = '';
    f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    menu.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]'); await settle();
    if (download) {
      status.resolve({success: true, models: []}); await settle();
      clickMenu(f, '[data-action="model-prompt-confirm"]'); await settle();
    }
    f.video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/poster.jpg';
    f.emitVideo('loadedmetadata'); await settle();
    if (download) prepared.resolve({success: true, models: ['tiny']});
    else status.resolve({success: true, models: ['tiny']});
    await settle();
    expect(ports.send.mock.calls.filter(([message]) => message.type === 'fluentReadPrepareLocalVideoModel' && message.keepWarm)).toHaveLength(1);
  });

  it.each(['media', 'language', 'off', 'dispose'])('rejects a late downloaded-model status after %s invalidates the request', async change => {
    const status = deferred<unknown>();
    ports.send.mockImplementation(async (message: {type: string}) => message.type === 'fluentReadGetLocalVideoModelState'
      ? status.promise : {success: true, hit: false});
    const f = fixture(); const dispose = f.start(); await settle();
    f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]'); await settle();
    if (change === 'media') {
      f.video.src = 'https://video.twimg.com/ext_tw_video/456/pu/vid/new.mp4';
      f.video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/new.jpg';
      f.emitVideo('loadedmetadata');
    } else if (change === 'language') f.changeConfig({videoSourceLanguage: 'zh'});
    else if (change === 'off') f.changeConfig({videoTranslationEnabled: false});
    else dispose();
    await settle(); status.resolve({success: true, models: ['tiny']}); await settle();
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadPrepareLocalVideoModel')).toBe(false);
  });

  it.each(['media', 'off', 'dispose'])('stops pending download progress immediately after %s invalidates the player', async change => {
    const prepared = deferred<unknown>();
    ports.send.mockImplementation(async (message: {type: string; keepWarm?: boolean}) => {
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: []};
      if (message.type === 'fluentReadPrepareLocalVideoModel') return prepared.promise;
      return {success: true, hit: false};
    });
    const f = fixture(); const dispose = f.start(); await settle();
    f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]'); await settle();
    clickMenu(f, '[data-action="model-prompt-confirm"]'); await settle();
    expect(ports.watchProgress).toHaveBeenCalledWith('video-model:tiny', expect.any(Function));
    expect(ports.stopProgress).not.toHaveBeenCalled();
    if (change === 'media') {
      f.video.src = 'https://video.twimg.com/ext_tw_video/456/pu/vid/new.mp4';
      f.video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/new.jpg';
      f.emitVideo('loadedmetadata');
    } else if (change === 'off') f.changeConfig({videoTranslationEnabled: false});
    else dispose();
    await settle(); expect(ports.stopProgress).toHaveBeenCalledOnce();
    prepared.resolve({success: true, models: ['tiny']}); await settle();
    expect(ports.stopProgress).toHaveBeenCalledOnce();
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadPrepareLocalVideoModel' && message.keepWarm)).toBe(false);
  });

  it.each(['download-subtitles', 'download-translated-subtitles', 'download-bilingual-subtitles'])('keeps preview exports disabled after an old %s feedback timer ends', async action => {
    const nextWindow = deferred<unknown>();
    let count = 0;
    const saved = 'The previously completed subtitle.';
    const preview = 'A new completed preview sentence.';
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetVideoAiSubtitleCache') return {success: true, hit: true,
        cues: [{startMs: 0, durationMs: 20000, text: saved}]};
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny']};
      if (message.type === 'fluentReadTranscribeLocalVideoAudio') return ++count === 1
        ? {success: true, text: preview, segments: [{startMs: 0, endMs: 4000, text: preview}]} : nextWindow.promise;
      return {success: true};
    });
    const f = fixture();
    class DecodeContext {
      state = 'running';
      async close() { this.state = 'closed'; }
      async decodeAudioData() { return {duration: 20, numberOfChannels: 1, sampleRate: 16000,
        getChannelData: () => new Float32Array(320000).fill(.08)}; }
    }
    vi.stubGlobal('AudioContext', DecodeContext);
    defineBrowserPort(f.window, 'AudioContext', {configurable: true, value: DecodeContext});
    Object.defineProperty(f.video, 'duration', {configurable: true, value: 20});
    ports.fetch.mockResolvedValue(new Response(audioInit));
    f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    clickMenu(f, '[data-action="open-subtitle-tools"]');
    const download = menu.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    expect(download.disabled).toBe(false);
    clickMenu(f, `[data-action="${action}"]`); await settle();
    if (action !== 'download-subtitles') {
      expect(menu.querySelector('[data-export-prompt]')).not.toBeNull();
      clickMenu(f, '[data-export-choice="complete"]'); await settle();
    }
    expect(menu.querySelector('[data-download-status]')?.textContent).toContain('已下载');
    clickMenu(f, '[data-action="regenerate-ai-subtitle"]'); await settle();
    expect(count).toBe(2);
    expect(f.displayed().source).toBe(preview);
    await vi.advanceTimersByTimeAsync(2450);
    expect(count).toBe(2);
    for (const button of menu.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')) expect(button.disabled).toBe(true);
    nextWindow.resolve({success: false, error: 'fixture stops after timer proof'}); await settle();
  });

  it('displays completed AI sentences before the final window and clears an incomplete preview after failure', async () => {
    const nextWindow = deferred<unknown>();
    let count = 0;
    const preview = 'The first completed AI sentence.';
    ports.send.mockImplementation(async (message: {type: string}) => {
      if (message.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['tiny']};
      if (message.type === 'fluentReadTranscribeLocalVideoAudio') return ++count === 1
        ? {success: true, text: preview, segments: [{startMs: 0, endMs: 4000, text: preview}]} : nextWindow.promise;
      return {success: true, hit: false};
    });
    const f = fixture();
    // 本例验证真实运行时接线；音频解码和模型消息是显式浏览器边界夹具。
    class DecodeContext {
      state = 'running';
      async close() { this.state = 'closed'; }
      async decodeAudioData() { return {duration: 20, numberOfChannels: 1, sampleRate: 16000,
        getChannelData: () => new Float32Array(320000).fill(.08)}; }
    }
    vi.stubGlobal('AudioContext', DecodeContext);
    defineBrowserPort(f.window, 'AudioContext', {configurable: true, value: DecodeContext});
    Object.defineProperty(f.video, 'duration', {configurable: true, value: 20});
    ports.fetch.mockResolvedValue(new Response(audioInit));
    f.start(); await settle();
    const menu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!; menu.hidden = false;
    clickMenu(f, '[data-action="toggle-ai-subtitle"]'); await settle();
    expect(count).toBe(2);
    expect(f.displayed()).toMatchObject({source: preview, translated: translation(preview), active: true, kind: 'ai'});
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadSetVideoAiSubtitleCache')).toBe(false);
    for (const button of menu.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')) expect(button.disabled).toBe(true);
    expect((menu.querySelector('[data-action="select-ai-model"]') as HTMLButtonElement).disabled).toBe(true);
    clickMenu(f, '[data-action="download-subtitles"]'); await settle();
    expect(menu.querySelector('[data-download-status]')?.textContent).toBe('');
    nextWindow.resolve({success: false, error: 'fixture later window failed'}); await settle();
    expect(f.displayed().source || '').toBe('');
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadSetVideoAiSubtitleCache')).toBe(false);
    expect(menu.querySelector('[data-action="toggle-ai-subtitle"]')?.getAttribute('data-error')).toBe('true');
  });

  it('RT1: retains the already displayed native pair immediately across interleaved sidecar and cuechange', async () => {
    const f = fixture(nativeSource); f.start(); await settle();
    const initial = f.displayed();
    expect(initial).toEqual({source: nativeSource, translated: translation(nativeSource), active: true, kind: 'native'});
    expect(f.callsFor(nativeSource)).toBe(1);
    for (let index = 0; index < 2; index++) {
      f.emitCue('fragment-' + index, 'A different captured sidecar sentence.');
      // 同步断言：若回调先清空再重译，最终 settle 的 DOM 会掩盖闪烁。
      expect(f.displayed()).toEqual(initial);
      f.native!.dispatchEvent(new f.window.Event('cuechange'));
      expect(f.displayed()).toEqual(initial);
      f.emitVideo('seeked'); await settle();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.displayed()).toEqual(initial);
    expect(f.callsFor(nativeSource)).toBe(1);
    expect(f.callsFor('A different captured sidecar sentence.')).toBe(0);
    expect(ports.fetch).not.toHaveBeenCalled();
    // 删除 native 后，真实 track-list 事件应消费保留的 sidecar，而非丢弃分片。
    f.tracks.splice(0); f.changeTracks(); await settle();
    expect(f.displayed()).toMatchObject({source: 'A different captured sidecar sentence.', translated: translation('A different captured sidecar sentence.'), kind: 'sidecar'});
  });

  it('RT1: does not translate the same native cue again after sidecar/polling alternation', async () => {
    const f = fixture(nativeSource); f.start(); await settle();
    for (let index = 0; index < 3; index++) {
      f.emitCue('counts-' + index, 'Captured text must not replace the native timeline.');
      await settle(); f.native!.dispatchEvent(new f.window.Event('cuechange')); await settle();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(f.displayed()).toMatchObject({source: nativeSource, translated: translation(nativeSource), kind: 'native'});
    expect(f.callsFor(nativeSource)).toBe(1);
    expect(f.callsFor('Captured text must not replace the native timeline.')).toBe(0);
  });

  it('RT2: appends sidecar cues without native, keeps the current pair and falls forward at the video playhead', async () => {
    const f = fixture(); f.start(); await settle();
    const first = 'First sidecar sentence.'; const second = 'Second sidecar sentence.';
    f.emitCue('first', first, 0, 10); await settle();
    expect(f.displayed()).toMatchObject({source: first, translated: translation(first), active: true, kind: 'sidecar'});
    const initial = f.displayed();
    f.emitCue('second', second, 10, 20);
    expect(f.displayed()).toEqual(initial);
    await vi.advanceTimersByTimeAsync(120);
    f.video.currentTime = 12; f.emitVideo('seeked'); await settle();
    expect(f.displayed()).toMatchObject({source: second, translated: translation(second), kind: 'sidecar'});
    expect(f.callsFor(first)).toBe(1); expect(f.callsFor(second)).toBe(1);
  });

  it('逐字高亮：X 字幕默认保持纯文本，开启后原文与译文按当前句时间一起点亮，拖动后跟随，关闭即还原', async () => {
    const f = fixture(); f.start(); await settle();
    const source = 'First sidecar sentence.';
    f.emitCue('first', source, 0, 10); await settle();
    const lines = () => [VIDEO_NORMALIZED_CAPTION_OVERLAY_ID, VIDEO_TRANSLATION_OVERLAY_ID].map(id => f.document.getElementById(id)!);
    const states = () => lines().map(line => Array.from(line.querySelectorAll('.fluent-read-video-karaoke-unit'))
      .map(unit => unit.getAttribute('data-fluent-read-karaoke-state')));
    expect(states()).toEqual([[], []]);

    f.changeConfig({videoSubtitleAppearance: {karaoke: true}} as unknown as Partial<Config>);
    await vi.advanceTimersByTimeAsync(40);
    expect(f.displayed()).toMatchObject({source, translated: translation(source), active: true, kind: 'sidecar'});
    // 播放头在 1s，句子为 0–10s：两行都只点亮到第一个单元。
    const started = states();
    expect(started[0]).toEqual(['active', null, null]);
    expect(started[1].filter(state => state === 'active')).toHaveLength(1);
    expect(started[1].at(-1)).toBeNull();

    f.video.currentTime = 4; f.emitVideo('seeked'); await vi.advanceTimersByTimeAsync(40);
    const middle = states();
    expect(middle[0]).toEqual(['sung', 'active', null]);
    expect(middle[1].filter(state => state === 'sung').length).toBeGreaterThan(0);
    expect(middle[1].filter(state => state === 'active')).toHaveLength(1);

    f.changeConfig({videoSubtitleAppearance: {karaoke: false}} as unknown as Partial<Config>);
    await settle();
    expect(states()).toEqual([[], []]);
    expect(f.displayed()).toMatchObject({source, translated: translation(source), active: true, kind: 'sidecar'});
  });

  it('RT2: a real source-language configuration change invalidates late translation even for identical cue text', async () => {
    const old = deferred<string>(); let oldSignal!: AbortSignal;
    ports.translate.mockImplementationOnce((_text: string, signal: AbortSignal) => {oldSignal = signal; return old.promise;});
    const f = fixture(); f.start(); await settle(); const source = 'Repeated words across language tracks.';
    f.emitCue('language', source); await settle(); expect(f.callsFor(source)).toBe(1);
    f.changeConfig({videoSourceLanguage: 'fr'});
    expect(oldSignal.aborted).toBe(true);
    // reset 必须允许相同资源 URL 在新语言中重新消费。
    f.emitCue('language', source); await settle();
    expect(f.displayed()).toMatchObject({source, translated: translation(source), kind: 'sidecar'});
    expect(f.callsFor(source)).toBe(2);
    old.resolve('旧语言的迟到译文'); await settle();
    expect(f.displayed()).toMatchObject({source, translated: translation(source), kind: 'sidecar'});
  });

  it('RT2: changing the actual video media source aborts old resource/translation and rejects their late results', async () => {
    const oldText = deferred<string>(), oldResource = deferred<Response>(); let translateSignal!: AbortSignal, resourceSignal!: AbortSignal;
    ports.translate.mockImplementationOnce((_text: string, signal: AbortSignal) => {translateSignal = signal; return oldText.promise;});
    ports.fetch.mockImplementationOnce((_url: string, options: {signal: AbortSignal}) => {resourceSignal = options.signal; return oldResource.promise;});
    const f = fixture(); f.start(); await settle();
    f.emitCue('old-cue', 'Old media subtitle.'); await settle();
    f.emitResource('old-master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="old-late.vtt"'); await settle();
    expect(ports.fetch).toHaveBeenCalledTimes(1);
    f.video.src = 'https://video.twimg.com/ext_tw_video/456/pu/vid/new.mp4';
    f.video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/new.jpg';
    f.emitVideo('loadedmetadata'); await settle();
    expect(translateSignal.aborted).toBe(true); expect(resourceSignal.aborted).toBe(true);
    f.emitCue('new-cue', 'New media subtitle.', 0, 20, '456'); await settle();
    const expected = f.displayed();
    expect(expected).toMatchObject({source: 'New media subtitle.', translated: translation('New media subtitle.'), kind: 'sidecar'});
    oldText.resolve('旧媒体迟到译文'); oldResource.resolve(new Response('WEBVTT\n\n00:00:00.000 --> 00:00:20.000\nOld late resource.\n'));
    await settle(); f.emitVideo('timeupdate'); await settle();
    expect(f.displayed()).toEqual(expected);
    expect(f.callsFor('Old late resource.')).toBe(0);
  });

  it('RT8: dispose/remount excludes old translation, resource, cache and track callbacks from the new mounted DOM', async () => {
    const oldText = deferred<string>(), oldResource = deferred<Response>(), oldCache = deferred<unknown>();
    let translateSignal!: AbortSignal, resourceSignal!: AbortSignal;
    ports.send.mockImplementationOnce(() => oldCache.promise);
    ports.translate.mockImplementationOnce((_text: string, signal: AbortSignal) => {translateSignal = signal; return oldText.promise;});
    ports.fetch.mockImplementationOnce((_url: string, options: {signal: AbortSignal}) => {resourceSignal = options.signal; return oldResource.promise;});
    const f = fixture(); const dispose = f.start(); await settle();
    expect(ports.send.mock.calls.some(([message]) => message.type === 'fluentReadGetVideoAiSubtitleCache')).toBe(true);
    const oldTrack = f.makeTrack('Old mounted native cue.'); f.tracks.push(oldTrack); f.changeTracks(); await settle();
    expect(oldTrack.mode).toBe('hidden');
    f.emitResource('dispose-master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="dispose-late.vtt"'); await settle();
    expect(ports.fetch).toHaveBeenCalledTimes(1);
    dispose(); await settle();
    expect(translateSignal.aborted).toBe(true); expect(resourceSignal.aborted).toBe(true);
    expect(oldTrack.mode).toBe('showing'); expect(ports.subscribers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    for (const id of [VIDEO_AI_CAPTION_CONTAINER_ID, VIDEO_TRANSLATION_LAYER_ID, VIDEO_TRANSLATION_BUTTON_ID, VIDEO_TRANSLATION_MENU_ID]) expect(f.document.getElementById(id)).toBeNull();
    const requests = ports.translate.mock.calls.length;
    f.emitCue('after-dispose', 'No runtime is mounted.'); f.emitVideo('seeked'); oldTrack.dispatchEvent(new f.window.Event('cuechange')); await settle();
    expect(ports.translate).toHaveBeenCalledTimes(requests); expect(ports.fetch).toHaveBeenCalledTimes(1);
    expect(f.document.getElementById(VIDEO_TRANSLATION_LAYER_ID)).toBeNull();
    const newTrack = f.makeTrack('New mounted native cue.'); f.tracks.splice(0, f.tracks.length, newTrack); f.start(); await settle();
    const expected = f.displayed();
    expect(expected).toMatchObject({source: 'New mounted native cue.', translated: translation('New mounted native cue.'), kind: 'native'});
    oldText.resolve('旧实例译文'); oldResource.resolve(new Response('WEBVTT\n\n00:00:00.000 --> 00:00:20.000\nOld instance resource.\n'));
    oldCache.resolve({success: true, hit: true, cues: [{startMs: 0, durationMs: 20000, text: 'Old instance cached cue.'}]});
    oldTrack.dispatchEvent(new f.window.Event('cuechange')); await settle(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.displayed()).toEqual(expected);
    expect(f.callsFor('Old instance resource.')).toBe(0); expect(f.callsFor('Old instance cached cue.')).toBe(0);
    expect(f.callsFor('New mounted native cue.')).toBe(1);
    expect(f.document.querySelectorAll('#' + VIDEO_TRANSLATION_LAYER_ID)).toHaveLength(1);
    // 当前 runtime 与独立学习外观 owner 各一条；前面已验证旧实例全部解除到零。
    expect(ports.subscribers.size).toBe(2); expect(f.document.getElementById('host')?.textContent).toBe('host original');
  });
});


// YouTube 由真实 timedtext 桥消息与媒体事件驱动；仅同步调用窗口计数，异步结果仍由原有资格校验处理。
describe('public mounted YouTube timed cue selection and lifecycle', () => {
  it('rejects a late progressive translation when the media clock crosses the offset cue before its next event', async () => {
    Object.assign(ports.config, {videoSubtitleOffsetMs: 500});const pending = deferred<string>();ports.translate.mockReturnValue(pending.promise);
    const f = fixture(undefined, 'youtube');f.setCaption('A short timed caption.');f.start();
    f.emitTimedText([{startMs: 0, durationMs: 2500, text: 'A short timed caption.'}]);await settle();
    expect(ports.translate).toHaveBeenCalledOnce();
    // 媒体时钟先前进，timeupdate 在稍后的浏览器任务派发；中间到达的旧响应也不能上屏。
    f.video.currentTime = 5;pending.resolve('迟到的旧字幕译文');await settle();
    expect(f.displayed().translated || '').not.toContain('迟到的旧字幕译文');
    f.emitVideo('timeupdate');await settle();expect(f.displayed().translated || '').toBe('');
  });

  it('普通当前句100次媒体更新只整理一次cue，保留译文与provider次数', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const text = 'The current subtitle sentence.';
    const f = fixture(undefined, 'youtube'); f.start();
    f.emitTimedText([{startMs: 0, durationMs: 20000, text}]); f.setCaption(text);
    await settle(); f.emitVideo('timeupdate'); await settle();
    const initial = f.displayed(); expect(initial.source).toBe(text);
    expect(initial.translated).toBe(translation(text)); expect(f.callsFor(text)).toBe(1);
    const spy = vi.spyOn(subtitleLogic, 'selectYoutubeCaptionCue');
    let selections: number;
    try {for (let index = 0; index < 100; index += 1) f.emitVideo('timeupdate'); selections = spy.mock.calls.length;}
    finally {spy.mockRestore();}
    expect(f.displayed()).toEqual(initial); expect(f.callsFor(text)).toBe(1);
    expect(selections).toBe(100);
  });

  it('两次时间读跨边界仍选择后一cue，而非复用旧前缀cue', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const first = 'Caption first complete sentence.', second = 'Caption second complete sentence.';
    const f = fixture(undefined, 'youtube'); f.video.currentTime = .5; f.start();
    f.emitTimedText([{startMs: 0, durationMs: 1000, text: first}, {startMs: 1000, durationMs: 1000, text: second}]);
    f.setCaption('Caption'); await settle(); f.emitVideo('timeupdate'); await settle();
    expect(f.displayed().source).toBe(first);
    let reads = 0;
    defineBrowserPort(f.video, 'currentTime', {configurable: true, get: () => ++reads === 1 ? .999 : 1});
    f.emitVideo('timeupdate');
    expect(reads).toBe(2); expect(f.displayed().source).toBe(second);
    expect(f.displayed().translated).toBe(translation(second));
  });

  it('seek、新timedtext与偏移更新每轮重新选择，不泄漏未偏移原生句', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const first = 'First native sentence.', second = 'Second native sentence.', changed = 'New track sentence.';
    const f = fixture(undefined, 'youtube'); f.video.currentTime = .5; f.start();
    f.emitTimedText([{startMs: 0, durationMs: 1000, text: first}, {startMs: 1000, durationMs: 1000, text: second}]);
    f.setCaption(first); await settle();
    f.video.currentTime = 1.5; f.setCaption(second); f.emitVideo('seeked'); await settle();
    expect(f.displayed().source).toBe(second);
    f.changeConfig({videoSubtitleOffsetMs: 1000}); await settle(); expect(f.displayed().source).toBe(first);
    f.changeConfig({videoSubtitleOffsetMs: 2000}); await settle(); expect(f.displayed().source || '').toBe('');
    f.changeConfig({videoSubtitleOffsetMs: 0}); f.video.currentTime = .5;
    f.emitTimedText([{startMs: 0, durationMs: 2000, text: changed}]); f.setCaption(changed); f.emitVideo('seeked'); await settle();
    expect(f.displayed()).toMatchObject({source: changed, translated: translation(changed)});
  });

  it('迟到前句不覆盖seek后的当前句，dispose清理入口和全部计时器', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const first = 'Delayed first native sentence.', second = 'Ready second native sentence.';
    const old = deferred<string>();
    ports.translate.mockImplementationOnce(() => old.promise);
    const f = fixture(undefined, 'youtube'); f.video.currentTime = .5; const dispose = f.start();
    try {
      f.emitTimedText([{startMs: 0, durationMs: 1000, text: first}, {startMs: 1000, durationMs: 1000, text: second}]);
      f.setCaption(first); await settle();
      f.video.currentTime = 1.5; f.setCaption(second); f.emitVideo('seeked'); await settle();
      const current = f.displayed(); expect(current.source).toBe(second);
      old.resolve('旧位置的迟到译文'); await settle(); expect(f.displayed()).toEqual(current);
      const count = ports.translate.mock.calls.length; dispose(); await settle();
      expect(ports.subscribers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
      expect(f.document.getElementById(VIDEO_TRANSLATION_LAYER_ID)).toBeNull();
      f.emitTimedText([{startMs: 0, durationMs: 3000, text: 'Unmounted caption.'}]); f.emitVideo('timeupdate'); await settle();
      expect(ports.translate.mock.calls.length).toBe(count);
    } finally {old.resolve('cleanup'); dispose(); await settle();}
  });
});


describe('public mounted video player button follows the video translation switch', () => {
  it.each(['x', 'youtube'] as const)('%s：关闭视频字幕翻译后移除已打开的菜单，重复开启只恢复一份入口', async platform => {
    const f = fixture(undefined, platform); f.start(); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).not.toBeNull();
    const oldMenu = f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!;
    oldMenu.hidden = false;

    f.changeConfig({videoTranslationEnabled: false}); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    expect(oldMenu.isConnected).toBe(false);
    f.emitVideo('loadedmetadata'); await vi.advanceTimersByTimeAsync(1100);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();

    f.changeConfig({videoTranslationEnabled: true}); await settle();
    f.changeConfig({videoTranslationEnabled: true}); await settle();
    expect(f.document.querySelectorAll('#' + VIDEO_TRANSLATION_BUTTON_ID)).toHaveLength(1);
    expect(f.document.querySelectorAll('#' + VIDEO_TRANSLATION_MENU_ID)).toHaveLength(1);
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).not.toBe(oldMenu);
  });

  it.each(['x', 'youtube'] as const)('%s：初始关闭时不挂载入口，菜单关闭后仍保持扩展总开关开启', async platform => {
    ports.config.videoTranslationEnabled = false;
    const f = fixture(undefined, platform); f.start(); await vi.advanceTimersByTimeAsync(1100);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    expect(ports.translate).not.toHaveBeenCalled();

    f.changeConfig({videoTranslationEnabled: true, videoSubtitleVisible: false}); await settle();
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).not.toBeNull();
    f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)!.hidden = false;
    clickMenu(f, '[data-mode="off"]'); await settle();
    expect(ports.config.videoTranslationEnabled).toBe(false);
    expect(ports.config.on).toBe(true);
    expect(f.document.getElementById(VIDEO_TRANSLATION_BUTTON_ID)).toBeNull();
    expect(f.document.getElementById(VIDEO_TRANSLATION_MENU_ID)).toBeNull();
    expect(f.document.getElementById('host')?.textContent).toBe('host original');
  });
});

// 人工轨通过实际页面发现与 loader 请求就绪；媒体输入非有限时仍走原 fresh 选择边界。
describe('public mounted YouTube nonfinite time and human track fallback', () => {
  it('NaN媒体时间保留两次真实选择且不猜测时间轴', async () => {
    ports.config.videoPreferHumanSubtitles = false;
    const text = 'The complete native sentence.';
    const f = fixture(undefined, 'youtube'); f.video.currentTime = .5; f.start();
    f.emitTimedText([{startMs: 0, durationMs: 20000, text}]); f.setCaption(text); await settle();
    expect(f.displayed()).toMatchObject({source: text, translated: translation(text)});
    f.video.currentTime = Number.NaN;
    const spy = vi.spyOn(subtitleLogic, 'selectYoutubeCaptionCue');
    try {
      f.emitVideo('timeupdate');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.every(([, source, time]) => source === text && Number.isNaN(time))).toBe(true);
      expect(spy.mock.calls[0][0]).toBe(spy.mock.calls[1][0]);
      expect(spy.mock.results.map(result => result.value)).toEqual([{cue: null, stale: false}, {cue: null, stale: false}]);
    } finally {spy.mockRestore();}
    await settle();
    expect(f.displayed()).toMatchObject({source: text, translated: translation(text)});
    expect(f.callsFor(text)).toBe(1);
  });

  it('原文轨道请求超时后可重试，卸载时取消未结束正文并拒绝迟到提交', async () => {
    Object.assign(ports.config, {from: 'en', videoPreferHumanSubtitles: false});
    const f = fixture(undefined, 'youtube');
    const script = f.document.createElement('script');
    script.textContent = 'var ytInitialPlayerResponse=' + JSON.stringify({videoDetails: {videoId: 'cue-proof'}, captions: {
      playerCaptionsTracklistRenderer: {captionTracks: [{baseUrl: 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en', languageCode: 'en'}]},
    }}) + ';';
    f.document.head.appendChild(script);
    const signals: AbortSignal[] = [];
    const late: ((response: Response) => void)[] = [];
    ports.fetch.mockImplementation((_input: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>(resolve => late.push(resolve));
    });
    const dispose = f.start(); await settle();
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(signals).toHaveLength(2);
    const cancel = vi.fn(() => Promise.reject(new Error('late cancel failure')));
    const body = new ReadableStream<Uint8Array>({cancel});
    late[1](new Response(body)); await settle();
    expect(body.locked).toBe(true);
    dispose(); await settle();
    expect(signals[1].aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    const cancelOld = vi.fn();
    late[0](new Response(new ReadableStream({cancel: cancelOld}))); await settle();
    expect(cancelOld).toHaveBeenCalledOnce();
    expect(ports.translate).not.toHaveBeenCalled();
  });

  it('实际人工目标轨loader命中后进入空档，下一轮仍回退原文cue和缓存译文', async () => {
    Object.assign(ports.config, {from: 'en', videoPreferHumanSubtitles: true});
    const first = 'First source sentence.', second = 'Second source sentence.', human = '第一句人工字幕。';
    const f = fixture(undefined, 'youtube'); f.video.currentTime = .5;
    const script = f.document.createElement('script');
    script.textContent = 'var ytInitialPlayerResponse=' + JSON.stringify({videoDetails: {videoId: 'cue-proof'}, captions: {
      playerCaptionsTracklistRenderer: {captionTracks: [
        {baseUrl: 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en', languageCode: 'en', name: {simpleText: 'English'}},
        {baseUrl: 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=zh-Hans', languageCode: 'zh-Hans', name: {simpleText: '简体中文'}},
      ]},
    }}) + ';';
    f.document.head.appendChild(script);
    const json3 = (events: {tStartMs: number; dDurationMs: number; segs: {utf8: string}[]}[]) => JSON.stringify({events});
    ports.fetch.mockImplementation(async (input: string, options: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://www.youtube.com'); expect(url.pathname).toBe('/api/timedtext');
      expect(url.searchParams.get('v')).toBe('cue-proof'); expect(url.searchParams.get('fmt')).toBe('json3');
      expect(options.credentials).toBe('include');
      const language = url.searchParams.get('lang');
      if (language === 'zh-Hans') {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return new Response(json3([{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: human}]}]));
      }
      if (language === 'en') return new Response(json3([
        {tStartMs: 0, dDurationMs: 1000, segs: [{utf8: first}]},
        {tStartMs: 1000, dDurationMs: 1000, segs: [{utf8: second}]},
      ]));
      throw new Error('Unexpected human fixture timedtext language: ' + language);
    });
    f.setCaption(first); f.start(); await settle();
    expect(f.displayed()).toMatchObject({source: first, translated: human});
    expect(f.callsFor(first)).toBe(0);
    const spy = vi.spyOn(subtitleLogic, 'selectYoutubeCaptionCue');
    let missSelections = 0;
    try {
      f.emitVideo('timeupdate');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(first);
      spy.mockClear();
      f.video.currentTime = 1.5; f.setCaption(second); f.emitVideo('timeupdate');
      missSelections = spy.mock.calls.length;
      expect(spy.mock.calls.every(([, source, time]) => source === second && time === 1500)).toBe(true);
      expect(spy.mock.results.every(result => result.value.cue?.text === second && result.value.stale === false)).toBe(true);
    } finally {spy.mockRestore();}
    await settle();
    expect(f.displayed()).toMatchObject({source: second, translated: translation(second)});
    expect(f.callsFor(first)).toBe(0); expect(f.callsFor(second)).toBe(1);
    expect(ports.fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('lang')).sort()).toEqual(['en', 'zh-Hans']);
    expect(missSelections).toBe(1);
  });
});


it('YouTube 同语言切换命名字幕轨时撤销旧翻译，签名刷新不误触发切轨', async () => {
  const tasks: Array<{source: string; signal: AbortSignal; resolve: (text: string) => void}> = [];
  ports.translate.mockImplementation((source: string, signal: AbortSignal) => {
    const task = deferred<string>(); tasks.push({source, signal, resolve: task.resolve}); return task.promise;
  });
  Object.assign(ports.config, {videoPreferHumanSubtitles: false});
  const f = fixture(undefined, 'youtube'); f.setCaption('Shared caption'); f.start();
  const cues = [{startMs: 0, durationMs: 6000, text: 'Shared caption'}];
  const trackA = 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en&name=Speaker+A&sig=old';
  f.emitTimedText(cues, trackA); await vi.advanceTimersByTimeAsync(300);
  const first = tasks.at(-1)!; expect(first.source).toBe('Shared caption'); expect(first.signal.aborted).toBe(false);
  f.emitTimedText(cues, trackA.replace('sig=old', 'sig=new')); await vi.advanceTimersByTimeAsync(100);
  expect(first.signal.aborted).toBe(false); expect(tasks.at(-1)).toBe(first);
  f.emitTimedText(cues, trackA.replace('Speaker+A', 'Speaker+B')); await vi.advanceTimersByTimeAsync(300);
  expect(first.signal.aborted).toBe(true);
  const second = tasks.at(-1)!; expect(second).not.toBe(first); expect(second.signal.aborted).toBe(false);
  first.resolve('Obsolete track translation'); second.resolve('Current track translation'); await vi.advanceTimersByTimeAsync(200);
  expect(f.displayed().translated).toBe('Current track translation');
});

it('原文模式收到大量新命名轨时保留当前轨，恢复双语仍使用当前轨', async () => {
  Object.assign(ports.config, {videoPreferHumanSubtitles: false});
  const f = fixture(undefined, 'youtube'); f.setCaption('Original active sentence.'); f.start();
  const active = [{startMs: 0, durationMs: 6000, text: 'Original active sentence.'}];
  f.emitTimedText(active, 'https://www.youtube.com/api/timedtext?v=cue-proof&lang=en&name=active');
  await vi.advanceTimersByTimeAsync(300);
  expect(f.displayed().source).toBe('Original active sentence.');
  f.changeConfig({videoSubtitleDisplayMode: 'original-only'}); await settle();
  for (let i = 0; i < 30; i++) {
    f.emitTimedText([{startMs: 0, durationMs: 6000, text: `Other track ${i}.`}], `https://www.youtube.com/api/timedtext?v=cue-proof&lang=en&name=other-${i}`);
  }
  f.changeConfig({videoSubtitleDisplayMode: 'bilingual'}); f.emitVideo('timeupdate'); await vi.advanceTimersByTimeAsync(300);
  expect(f.displayed()).toMatchObject({source: 'Original active sentence.', translated: translation('Original active sentence.')});
});
