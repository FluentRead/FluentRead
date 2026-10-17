/**
 * @file tests/videoSentenceLearningComponent.test.ts
 * 文件职责：执行完整句视频学习组件的真实 setup，验证调度、收藏、问答与材料关联的异步归属。
 * 主要内容：保留播放器操作、翻译与草稿回归；材料通过真实公开 begin/complete/client 验证来源、时间、代次冻结与成功引用，失败和旧播放器卸载不会误关联。
 * 模块边界：仅替换媒体、模型及浏览器消息传输，不替换材料采集逻辑；DOM 布局与真实平台由独立生产验收覆盖。
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileScript, parse} from 'vue/compiler-sfc';
import {parseHTML} from 'linkedom';
import ts from 'typescript';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import * as learningAppearance from '@/src/core/config/videoSentenceLearningAppearance';
import * as timeline from '@/src/features/video-subtitle/content/sentenceTimeline';
import * as playback from '@/src/features/video-subtitle/content/sentencePlayback';
import * as youtubeControlsScope from '@/src/features/video-subtitle/content/youtubeControlsScope';
import {getVideoTranslationConfigFingerprint} from '@/src/features/video-subtitle/content/subtitleLogic';
import * as vocabulary from '@/src/features/vocabulary/public';
import {beginMaterialCapture, completeMaterialCapture} from '@/src/features/vocabulary/material/public';

const materialTransport = vi.hoisted(() => ({sendMessage: vi.fn(), extension: {inIncognitoContext: false}}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: materialTransport.sendMessage}, extension: materialTransport.extension}}));

// 执行实际 SFC setup；媒体、服务和存储是边界替身，DOM 操作另由生产浏览器专项验证。
const filename = 'src/features/video-subtitle/ui/VideoSentenceLearning.vue';
const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
const compiled = ts.transpileModule(compileScript(descriptor, {id: 'video-sentence-learning-test'}).content, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
}).outputText;
const require = createRequire(import.meta.url);
const first = 'First sentence.';
const second = 'Second sentence.';
const third = 'Third sentence.';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
};
let state: Record<string, any>, scope: vue.EffectScope | undefined, config: Config;
let video: HTMLVideoElement, props: Record<string, any>, unmounted: Array<() => void>;
let subscription: () => void;
let translate: ReturnType<typeof vi.fn>, sendRuntimeMessage: ReturnType<typeof vi.fn>, streamReading: ReturnType<typeof vi.fn>;
let cancelReading: ReturnType<typeof vi.fn>, unsubscribe: ReturnType<typeof vi.fn>, emit: ReturnType<typeof vi.fn>;
let readingCallbacks: {progress: (value: any) => void; result: (value: any) => void; error: (cause: Error) => void};

async function flush(): Promise<void> {
  await Promise.resolve(); await vue.nextTick(); await Promise.resolve(); await vue.nextTick();
}
function close(): void {
  unmounted.splice(0).forEach(fn => fn()); scope?.stop(); scope = undefined;
}
async function mount(): Promise<void> {
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((id: string) => {
    if (id === 'vue') return {...vue, onBeforeUnmount: (fn: () => void) => unmounted.push(fn)};
    if (id === '@/src/ui/i18n') return {useUiI18n: () => ({t: (key: string) => key})};
    if (id === '@/src/services/config/store') return {config, subscribeConfig: (fn: () => void) => {subscription = fn; fn(); return unsubscribe;}};
    if (id === '@/src/core/config/videoSentenceLearningAppearance') return learningAppearance;
    if (id === '@/src/platform/browser/runtimeMessages') return {sendRuntimeMessage};
    if (id === '@/src/features/reading-assistant/ui/answer/public') return {ReadingAnswer: {}};
    if (id === '@/src/features/reading-assistant/public') return {streamReading};
    if (id === '@/src/features/vocabulary/public') return vocabulary;
    if (id === 'webextension-polyfill') return {extension: materialTransport.extension};
    if (id === '@/src/features/vocabulary/material/public') return {beginMaterialCapture, completeMaterialCapture};
    if (id === '../content/sentenceTimeline') return timeline;
    if (id === '../content/sentencePlayback') return playback;
    if (id === '../content/youtubeControlsScope') return youtubeControlsScope;
    if (id === '../content/subtitleLogic') return {getVideoTranslationConfigFingerprint};
    return require(id);
  }, exports);
  scope = vue.effectScope();
  state = scope.run(() => vue.proxyRefs(exports.default.setup(props, {expose: () => {}, emit})))!;
  await flush();
}
async function advance(ms: number): Promise<void> {await vi.advanceTimersByTimeAsync(ms); await flush();}
async function step(direction: number): Promise<void> {state.step(direction); await flush();}
function changeTranslationConfig(kind: 'service' | 'model' | 'glossary'): void {
  if (kind === 'service') config.videoService = 'openai';
  else if (kind === 'model') config.model.google = 'updated-fixture-model';
  else config.glossaryLibraries[0].entries[0].target = '新的译名';
  subscription();
}

/** 实际 SFC setup 注册在窗口上的监听消费 DOM target；显式媒体端口不把 portal 父链伪装为 player。 */
function portalKeyboardFixture() {
  const {document} = parseHTML('<html><body><div id="player-container-id" class="player-container">'
    + '<div id="movie_player" class="html5-video-player ytp-mweb-player"><video></video><button id="native"></button></div>'
    + '<ytm-custom-control><button id="external-native"></button></ytm-custom-control>'
    + '<div class="fluent-read-video-learning-frame"><div id="learning-host"><section><button id="panel-button"></button><textarea></textarea></section></div></div>'
    + '</div><button id="outside"></button><div id="other-player"></div></body></html>');
  const keyboardWindow = new EventTarget(); Object.defineProperty(document, 'defaultView', {value: keyboardWindow});
  video = Object.assign(document.querySelector('video')!, {currentTime: 0, paused: true, seeking: false, ended: false,
    play: vi.fn().mockResolvedValue(undefined), pause: vi.fn()});
  const player = document.getElementById('movie_player')!, panel = document.querySelector('section')!;
  props.video = video; props.player = player;
  const key = (name: string, target: Element) => {
    const event = new Event('keydown', {cancelable: true});
    Object.defineProperties(event, {key: {value: name}, target: {value: target}});
    keyboardWindow.dispatchEvent(event); return event;
  };
  return {document, keyboardWindow, player, panel, scope: document.getElementById('player-container-id')!, key};
}

beforeEach(() => {
  vi.useFakeTimers();
  materialTransport.extension.inIncognitoContext = false;
  materialTransport.sendMessage.mockReset().mockImplementation(async message => ({success: true, data: message.action === 'generation' ? 7 : {id: 'video-material'}}));
  const {document, window} = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('CustomEvent', window.CustomEvent);
  config = new Config(); config.on = true; config.videoTranslationEnabled = true; config.videoSubtitleVisible = true;
  config.service = 'google'; config.videoService = ''; config.harness.enabled = true; config.harness.actions = ['usage'];
  config.glossaryEnabled = true;
  config.glossaryLibraries = [{id: 'fixture', name: 'Fixture glossary', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-CN',
    domains: [], entries: [{id: 'term', source: 'sentence', target: '句子', caseSensitive: false}]}];
  unmounted = []; unsubscribe = vi.fn(); emit = vi.fn(); cancelReading = vi.fn();
  translate = vi.fn(async (text: string) => `Translated: ${text}`);
  sendRuntimeMessage = vi.fn().mockResolvedValue({success: true});
  streamReading = vi.fn((_request, callbacks) => {readingCallbacks = callbacks; return {cancel: cancelReading};});
  vi.stubGlobal('crypto', {randomUUID: () => 'video-learning-test-request'});
  video = Object.assign(new EventTarget(), {currentTime: 0, paused: true, seeking: false, ended: false, isConnected: true,
    play: vi.fn().mockResolvedValue(undefined), pause: vi.fn()}) as unknown as HTMLVideoElement;
  props = vue.shallowReactive({video, cues: [first, second, third].map((text, i) => ({text, startMs: i * 2000, durationMs: 1000})),
    platform: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=frSentence1', title: 'Fixture title',
    sourceLanguage: 'en', targetLanguage: 'zh-CN', translate});
});
afterEach(() => {close(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('完整句学习组件的调度与异步归属回归', () => {
  it.each([false, true])('换句只归顶当前owned滚动区，短高整卡=%s，页面与外层portal滚动不变', async short => {
    const f = portalKeyboardFixture(), host = f.panel.parentElement!;
    host.id = 'fluent-read-video-learning-panel'; host.dataset.shortHeight = String(short);
    await mount(); state.panel = vue.markRaw(f.panel);
    const body = f.document.createElement('div'); f.panel.appendChild(body); state.body = vue.markRaw(body);
    body.scrollTop = 42; f.panel.scrollTop = 180; host.scrollTop = 200; f.document.documentElement.scrollTop = 2720;
    f.key('ArrowRight', video); await flush();
    expect(state.index).toBe(1); expect(body.scrollTop).toBe(0); expect(f.panel.scrollTop).toBe(short ? 0 : 180);
    expect(host.scrollTop).toBe(200); expect(f.document.documentElement.scrollTop).toBe(2720);
  });

  it('portal面板以显式媒体player消费真实窗口学习键，并让位同视频兄弟菜单', async () => {
    const f = portalKeyboardFixture(); await mount(); state.panel = vue.markRaw(f.panel);
    expect(f.panel.parentElement!.parentElement).not.toBe(f.player);
    const next = f.key('ArrowRight', video); await flush();
    expect(next.defaultPrevented).toBe(true); expect(state.index).toBe(1); expect(video.currentTime).toBe(2);
    expect(f.key('r', video).defaultPrevented).toBe(true); expect(state.mode).toBe('loop');
    expect(f.key('q', video).defaultPrevented).toBe(true); expect(state.mode).toBe('pause');
    expect(f.key('ArrowLeft', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); await flush();
    expect(state.index).toBe(0);
    for (const target of [f.document.getElementById('outside')!, f.document.getElementById('external-native')!, f.panel.querySelector('textarea')!]) {
      expect(f.key('r', target).defaultPrevented).toBe(false); expect(state.mode).toBe('pause');
    }
    const menuHost = f.document.createElement('div'), menu = f.document.createElement('div'), item = f.document.createElement('button');
    menu.id = 'fluent-read-video-subtitle-menu'; menu.hidden = false; menu.appendChild(item); menuHost.appendChild(menu); f.scope.appendChild(menuHost);
    const before = [state.index, state.mode, video.currentTime];
    for (const name of ['ArrowLeft', 'ArrowRight', 'r', 'q', 'Escape']) {
      expect(f.key(name, item).defaultPrevented).toBe(false); expect([state.index, state.mode, video.currentTime]).toEqual(before);
    }
    expect(f.key('Escape', video).defaultPrevented).toBe(false); expect(emit).not.toHaveBeenCalled();
    // 同名菜单移出已验证同视频范围后，不再阻止当前学习面板关闭。
    f.document.getElementById('other-player')!.appendChild(menuHost);
    expect(f.key('Escape', video).defaultPrevented).toBe(true); expect(emit).toHaveBeenCalledWith('close');
    close(); expect(f.key('ArrowRight', video).defaultPrevented).toBe(false);
  });

  it.each(['missing', 'mismatched'] as const)('没有可靠logical player（%s）时不猜portal父链，但保留面板内部学习键', async condition => {
    const f = portalKeyboardFixture();
    props.player = condition === 'missing' ? undefined : f.document.getElementById('other-player');
    await mount(); state.panel = vue.markRaw(f.panel);
    expect(f.key('ArrowRight', video).defaultPrevented).toBe(false); expect(state.index).toBe(0);
    expect(f.key('r', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); expect(state.mode).toBe('loop');
    expect(f.key('Escape', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); expect(emit).toHaveBeenCalledWith('close');
  });

  it('同媒体重挂后拒绝旧player并立即消费更新后的显式player，不依赖portal位置', async () => {
    const f = portalKeyboardFixture(); await mount(); state.panel = vue.markRaw(f.panel);
    const next = f.document.getElementById('other-player')!; next.appendChild(video);
    expect(f.key('ArrowRight', video).defaultPrevented).toBe(false); expect(state.index).toBe(0);
    props.player = next; await flush();
    expect(f.key('ArrowRight', video).defaultPrevented).toBe(true); await flush(); expect(state.index).toBe(1);
    expect(f.key('r', f.document.getElementById('native')!).defaultPrevented).toBe(false);
    expect(f.panel.parentElement!.parentElement!.contains(video)).toBe(false);
    expect(f.key('q', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); expect(state.mode).toBe('pause');
  });

  it('播放器焦点下在捕获阶段接管学习键，编辑、修饰、组合输入与页面外区域保留原操作', async () => {
    const {document} = parseHTML('<html><body><div id="player"><video></video><button id="native"></button><div id="host"><section><input/><textarea/><div contenteditable><span id="editable"></span></div></section></div></div><button id="outside"></button></body></html>');
    const keyboardWindow = new EventTarget();
    Object.defineProperty(document, 'defaultView', {value: keyboardWindow});
    video = Object.assign(document.querySelector('video')!, {currentTime: 0, paused: true, seeking: false, ended: false,
      play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), playbackRate: 1.25});
    props.video = video; props.player = document.getElementById('player')!;
    const add = vi.spyOn(keyboardWindow, 'addEventListener'); const remove = vi.spyOn(keyboardWindow, 'removeEventListener');
    await mount(); state.panel = vue.markRaw(document.querySelector('section')!);
    expect(add).toHaveBeenCalledWith('keydown', state.onPlayerKeydown, true);
    const keyboard = (key: string, target = document.getElementById('native')!, options: Record<string, unknown> = {}) => ({key, target,
      repeat: false, defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...options}) as unknown as KeyboardEvent;
    const next = keyboard('ArrowRight'); state.onPlayerKeydown(next); await flush();
    expect(state.index).toBe(1); expect(video.currentTime).toBe(2);
    expect(next.preventDefault).toHaveBeenCalledOnce(); expect(next.stopImmediatePropagation).toHaveBeenCalledOnce();
    const loop = keyboard('r'); state.onPlayerKeydown(loop); expect(state.mode).toBe('loop');
    const repeated = keyboard('r', undefined, {repeat: true}); state.onPlayerKeydown(repeated);
    expect(state.mode).toBe('loop'); expect(repeated.preventDefault).toHaveBeenCalledOnce();
    const repeatedArrow = keyboard('ArrowRight', undefined, {repeat: true}); state.onPlayerKeydown(repeatedArrow); expect(state.index).toBe(1);
    const pause = keyboard('q'); state.onPlayerKeydown(pause); expect(state.mode).toBe('pause');
    expect((video as HTMLVideoElement).playbackRate).toBe(1.25);
    for (const options of [{altKey: true}, {ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {isComposing: true}, {defaultPrevented: true}]) {
      const event = keyboard('r', undefined, options); state.onPlayerKeydown(event); expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const target of [document.querySelector('input')!, document.querySelector('textarea')!, document.getElementById('editable')!, document.getElementById('outside')!]) {
      const event = keyboard('ArrowLeft', target); state.onPlayerKeydown(event); expect(event.preventDefault).not.toHaveBeenCalled();
    }
    const unowned = keyboard('k'); state.onPlayerKeydown(unowned); expect(unowned.preventDefault).not.toHaveBeenCalled();
    const menu = document.createElement('div'); menu.id = 'fluent-read-video-subtitle-menu';
    document.getElementById('player')!.appendChild(menu);
    const menuEscape = keyboard('Escape'); state.onPlayerKeydown(menuEscape);
    expect(menuEscape.preventDefault).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    const menuButton = document.createElement('button'); menu.appendChild(menuButton);
    const menuState = [state.index, state.mode, video.currentTime];
    for (const key of ['ArrowLeft', 'ArrowRight', 'r', 'q', 'Escape']) {
      const event = keyboard(key, menuButton); state.onPlayerKeydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
      expect([state.index, state.mode, video.currentTime]).toEqual(menuState);
    }
    menu.remove();
    Object.defineProperty(document, 'fullscreenElement', {value: document.getElementById('player'), configurable: true});
    const realMedia = document.createElement('video'); document.getElementById('player')!.appendChild(realMedia);
    Object.assign(realMedia, {currentTime: video.currentTime, paused: true, seeking: false, ended: false, play: vi.fn(), pause: vi.fn()});
    props.video = realMedia;
    await flush();
    const fullscreenBody = keyboard('r', document.body); state.onPlayerKeydown(fullscreenBody);
    expect(fullscreenBody.preventDefault).toHaveBeenCalledOnce(); expect(state.mode).toBe('loop');
    const fullscreenHtml = keyboard('q', document.documentElement); state.onPlayerKeydown(fullscreenHtml);
    expect(fullscreenHtml.preventDefault).toHaveBeenCalledOnce(); expect(state.mode).toBe('pause');
    const outsideFullscreen = keyboard('r', document.getElementById('outside')!); state.onPlayerKeydown(outsideFullscreen);
    expect(outsideFullscreen.preventDefault).not.toHaveBeenCalled();
    const fullscreenEscape = keyboard('Escape'); state.onPlayerKeydown(fullscreenEscape);
    expect(fullscreenEscape.preventDefault).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'exitFullscreen', {value: exitFullscreen, configurable: true});
    state.onPlayerKeydown(keyboard('Escape')); expect(exitFullscreen).toHaveBeenCalledOnce();
    state.onPlayerKeydown(keyboard('Escape', undefined, {repeat: true})); expect(exitFullscreen).toHaveBeenCalledOnce();
    exitFullscreen.mockRejectedValue(new Error('Native exit already completed'));
    state.onPlayerKeydown(keyboard('Escape')); await flush(); expect(exitFullscreen).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'fullscreenElement', {value: null, configurable: true});
    const normalBody = keyboard('r', document.body); state.onPlayerKeydown(normalBody);
    expect(normalBody.preventDefault).not.toHaveBeenCalled();
    const escape = keyboard('Escape'); state.onPlayerKeydown(escape); expect(emit).toHaveBeenCalledWith('close');
    close(); expect(remove).toHaveBeenCalledWith('keydown', state.onPlayerKeydown, true);
    const afterClose = keyboard('ArrowRight'); state.onKeydown(afterClose); expect(afterClose.preventDefault).not.toHaveBeenCalled();
  });

  it('视频实例更换和关闭释放原 document 学习键监听，面板节点暂不可用时不接管站点按键', async () => {
    const original = new EventTarget(); const next = new EventTarget();
    Object.assign(video, {ownerDocument: original});
    const remove = vi.spyOn(original, 'removeEventListener'); const add = vi.spyOn(next, 'addEventListener');
    await mount();
    const event = {key: 'ArrowRight', target: null, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn()} as unknown as KeyboardEvent;
    state.onPlayerKeydown(event); expect(event.preventDefault).not.toHaveBeenCalled();
    props.video = Object.assign(new EventTarget(), {ownerDocument: next, currentTime: 4, paused: true, seeking: false, ended: false, isConnected: true, play: vi.fn(), pause: vi.fn()});
    await flush(); expect(remove).toHaveBeenCalledWith('keydown', state.onPlayerKeydown, true); expect(add).toHaveBeenCalledWith('keydown', state.onPlayerKeydown, true);
    const removeNext = vi.spyOn(next, 'removeEventListener'); close(); expect(removeNext).toHaveBeenCalledWith('keydown', state.onPlayerKeydown, true);
  });

  it('换句后的异步 seek 尚未落地时立即切模式保留自身 seek 归属', async () => {
    let time = 0;
    const write = vi.fn(); Object.defineProperty(video, 'currentTime', {get: () => time, set: write});
    await mount(); await step(1); state.toggleMode('loop');
    expect(state.mode).toBe('loop'); expect(write).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledWith(2);
    time = 2; Object.assign(video, {seeking: true}); video.dispatchEvent(new Event('seeking'));
    expect(state.mode).toBe('loop');
    Object.assign(video, {seeking: false}); video.dispatchEvent(new Event('seeked'));
    state.toggleMode('pause'); expect(state.mode).toBe('pause'); expect(write).toHaveBeenCalledOnce();
    state.toggleMode('pause'); expect(state.mode).toBe('off'); expect(write).toHaveBeenCalledOnce();
  });

  it('只调整学习外观立即更新样式而保留当前句、人工草稿和辅助模式', async () => {
    await mount(); await step(1); await advance(120);
    state.translation = 'My manual translation'; state.onTranslationInput(); state.toggleMode('loop');
    const requests = translate.mock.calls.length;
    config.videoSentenceLearningAppearance = {...config.videoSentenceLearningAppearance, layout: 'comfortable', backgroundOpacity: 70, width: 420};
    subscription(); await flush();
    expect(state.appearance.layout).toBe('comfortable'); expect(state.appearance.backgroundOpacity).toBe(70);
    expect(state.appearance.width).toBe(420); expect(state.mode).toBe('loop'); expect(state.index).toBe(1);
    expect(state.translation).toBe('My manual translation'); expect(state.translationEdited).toBe(true); expect(state.pinned).toBe(true);
    expect(translate).toHaveBeenCalledTimes(requests); expect(state.notice).toBe('');
  });

  it('立即换原句和归顶，只在最后一次显式换句停留120毫秒后翻译', async () => {
    await mount(); expect(translate.mock.calls.map(call => call[0])).toEqual([first]);
    const body = {scrollTop: 42}; state.body = body;
    state.step(1); expect(state.sentence.text).toBe(second);
    await flush(); expect(body.scrollTop).toBe(0); expect(state.translation).toBe('');
    await advance(60); expect(translate).toHaveBeenCalledOnce();
    body.scrollTop = 31; state.step(1); expect(state.sentence.text).toBe(third);
    await flush(); expect(body.scrollTop).toBe(0);
    await advance(119); expect(translate).toHaveBeenCalledOnce();
    await advance(1); expect(translate.mock.calls.map(call => call[0])).toEqual([first, third]);
    expect(state.translation).toBe(`Translated: ${third}`);
  });

  it('初次打开与自然播放跟句立即请求，并保留输入边界的浅身份', async () => {
    await mount(); expect(translate).toHaveBeenCalledOnce();
    expect(state.props.video).toBe(video); expect(state.props.cues).toBe(props.cues);
    const body = {scrollTop: 50}; state.body = body;
    video.currentTime = 2.2; video.dispatchEvent(new Event('timeupdate'));
    await flush(); expect(state.sentence.text).toBe(second); expect(body.scrollTop).toBe(0);
    expect(translate.mock.calls.map(call => call[0])).toEqual([first, second]);
    expect(state.pinned).toBe(false);
  });

  it('收起取消排队请求，隐藏期间换句不新请求，展开当前句立即翻译', async () => {
    await mount(); await step(1); expect(state.translating).toBe(true);
    state.expanded = false; await flush(); expect(state.translating).toBe(false);
    await advance(500); expect(translate).toHaveBeenCalledOnce();
    video.currentTime = 4.2; state.returnToCurrent(); await flush();
    expect(state.sentence.text).toBe(third); expect(translate).toHaveBeenCalledOnce();
    state.expanded = true; await flush();
    expect(translate.mock.calls.map(call => call[0])).toEqual([first, third]);
  });

  it('同句已有请求在收起展开间继续，不重发且不取消有效响应', async () => {
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    await mount(); const signal = translate.mock.calls[0][1] as AbortSignal;
    state.expanded = false; await flush(); expect(signal.aborted).toBe(false);
    state.expanded = true; await flush(); expect(signal.aborted).toBe(false); expect(translate).toHaveBeenCalledOnce();
    pending.resolve('Kept response'); await flush(); expect(state.translation).toBe('Kept response');
  });

  it('隐藏期间切到其他句取消旧请求，展开只请求当前句且拒绝迟到旧译文', async () => {
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    await mount(); const signal = translate.mock.calls[0][1] as AbortSignal;
    state.expanded = false; await flush(); await step(1);
    expect(signal.aborted).toBe(true); await advance(500); expect(translate).toHaveBeenCalledOnce();
    pending.resolve('Hidden old translation'); await flush(); expect(state.translation).toBe('');
    state.expanded = true; await flush();
    expect(translate.mock.calls.map(call => call[0])).toEqual([first, second]);
    expect(state.translation).toBe(`Translated: ${second}`);
  });

  it('关闭清理尚未启动的换句计时器和媒体跟随监听', async () => {
    await mount(); await step(1); close(); await advance(500);
    expect(translate).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce();
    video.currentTime = 4.2; video.dispatchEvent(new Event('timeupdate')); await flush();
    expect(state.sentence.text).toBe(second);
  });

  it('关闭取消服务与讲解归属，迟到响应不再写回', async () => {
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    await mount(); state.explain(); readingCallbacks.progress({kind: 'text', text: 'Partial explanation'});
    const signal = translate.mock.calls[0][1] as AbortSignal;
    close(); expect(signal.aborted).toBe(true); expect(cancelReading).toHaveBeenCalledOnce();
    pending.resolve('Late translation'); readingCallbacks.result({success: true, text: 'Late explanation'});
    readingCallbacks.progress({kind: 'text', text: 'Later progress'}); await flush();
    expect(state.translation).toBe(''); expect(state.explanation).toBe('Partial explanation');
    expect(state.explaining).toBe(false); expect(state.translating).toBe(false);
  });

  it('统计同步保留首句请求和循环，配置变化终止旧归属但不自动重发讲解', async () => {
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    await mount(); state.toggleMode('loop'); state.explain();
    const signal = translate.mock.calls[0][1] as AbortSignal;
    config.count += 1; subscription(); await flush();
    expect(signal.aborted).toBe(false); expect(cancelReading).not.toHaveBeenCalled();
    expect(state.mode).toBe('loop'); expect(translate).toHaveBeenCalledOnce();
    changeTranslationConfig('service'); await flush();
    expect(signal.aborted).toBe(true); expect(state.mode).toBe('off'); expect(cancelReading).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledTimes(2); expect(streamReading).toHaveBeenCalledOnce();
    readingCallbacks.result({success: true, text: 'Obsolete explanation'}); pending.resolve('Obsolete translation'); await flush();
    expect(state.translation).toBe(`Translated: ${first}`); expect(state.explanation).toBe(''); expect(state.explanationStopped).toBe(true);
  });

  it.each(['service', 'model', 'glossary'] as const)('%s指纹变化重译当前自动译文，并使其他句的自动草稿失效', async kind => {
    await mount(); await step(1); await advance(120);
    expect(state.translation).toBe(`Translated: ${second}`);
    await step(-1); expect(state.translation).toBe(`Translated: ${first}`); expect(translate).toHaveBeenCalledTimes(2);
    changeTranslationConfig(kind); await flush(); expect(translate).toHaveBeenCalledTimes(3);
    await step(1); expect(state.translation).toBe(''); await advance(120);
    expect(translate.mock.calls.map(call => call[0])).toEqual([first, second, first, second]);
    expect(streamReading).not.toHaveBeenCalled();
  });

  it.each(['Human translation', ''])('保留人工译文%j，包括清空后的编辑意图和跨句草稿', async text => {
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    await mount(); state.translation = text; state.onTranslationInput();
    expect((translate.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    changeTranslationConfig('model'); await flush();
    expect(state.translation).toBe(text); expect(state.translationEdited).toBe(true); expect(translate).toHaveBeenCalledOnce();
    pending.resolve('Late automatic translation'); await flush(); expect(state.translation).toBe(text);
    await step(1); await advance(120); await step(-1); await advance(200);
    expect(state.translation).toBe(text); expect(state.translationEdited).toBe(true); expect(translate).toHaveBeenCalledTimes(2);
  });

  it('A的迟到收藏成功只归属A，回到A显示已保存，重复保存跳过，编辑后可更新', async () => {
    const pending = deferred<{success: boolean}>(); sendRuntimeMessage.mockReturnValueOnce(pending.promise);
    await mount(); const saving = state.save();
    expect(sendRuntimeMessage.mock.calls[0][0].input).toMatchObject({term: first, translation: `Translated: ${first}`, sourceLanguage: 'en', targetLanguage: 'zh-CN'});
    await step(1); await advance(120); const secondTranslation = state.translation;
    expect(state.saved).toBe(false); pending.resolve({success: true}); await saving; await flush();
    expect(state.sentence.text).toBe(second); expect(state.translation).toBe(secondTranslation); expect(state.savedSnapshot).toBe(''); expect(state.saved).toBe(false);
    await step(-1); expect(state.saved).toBe(true);
    await state.save(); expect(sendRuntimeMessage).toHaveBeenCalledOnce();
    state.translation = 'Corrected translation'; state.onTranslationInput();
    expect(state.saved).toBe(false); expect(state.savedSnapshot).not.toBe('');
    await state.save(); expect(sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(sendRuntimeMessage.mock.calls[1][0].input.translation).toBe('Corrected translation'); expect(state.saved).toBe(true);
  });

  it('保存期间的编辑不会被旧成功覆盖，显示待更新并以新内容保存', async () => {
    const pending = deferred<{success: boolean}>(); sendRuntimeMessage.mockReturnValueOnce(pending.promise);
    await mount(); const saving = state.save();
    state.translation = 'Changed while saving'; state.onTranslationInput(); await state.save();
    expect(sendRuntimeMessage).toHaveBeenCalledOnce();
    pending.resolve({success: true}); await saving; await flush();
    expect(state.translation).toBe('Changed while saving'); expect(state.saved).toBe(false); expect(state.savedSnapshot).not.toBe('');
    await state.save(); expect(sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(sendRuntimeMessage.mock.calls[1][0].input.translation).toBe('Changed while saving'); expect(state.saved).toBe(true);
  });

  it('换句后的旧收藏失败不污染新句，关闭后的收藏成功不写回', async () => {
    const failed = deferred<{success: boolean; error: {message: string}}>(); sendRuntimeMessage.mockReturnValueOnce(failed.promise);
    await mount(); const savingFirst = state.save(); await step(1); await advance(120);
    failed.resolve({success: false, error: {message: 'A failed'}}); await savingFirst; await flush();
    expect(state.error).toBe(''); expect(state.savedSnapshot).toBe(''); expect(state.saving).toBe(false);
    const late = deferred<{success: boolean}>(); sendRuntimeMessage.mockReturnValueOnce(late.promise);
    const savingSecond = state.save(); close(); late.resolve({success: true}); await savingSecond; await flush();
    expect(state.savedSnapshot).toBe(''); expect(state.saved).toBe(false);
  });
});

const materialCaptures = () => materialTransport.sendMessage.mock.calls.filter(([message]) => message.action === 'capture').map(([message]) => message.input);
describe('视频句子通过真实公开客户端关联材料', () => {
  it('收藏在异步代次前冻结原视频与句子时间，A迟到成功只关联实际A条目而不误绑当前B', async () => {
    await mount(); await step(1); await advance(120);
    const generation = deferred<{success: true; data: number}>(), saved = deferred<{success: true; data: {id: string}}>();
    materialTransport.sendMessage.mockReturnValueOnce(generation.promise); sendRuntimeMessage.mockReturnValueOnce(saved.promise);
    vi.setSystemTime(10000); const source = props.sourceUrl, title = props.title;
    const saving = state.save();
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({action: 'upsert', input: expect.objectContaining({term: second})}));
    expect(materialTransport.sendMessage).toHaveBeenCalledWith({type: 'fluentReadMaterials', action: 'generation'});
    expect(materialCaptures()).toEqual([]);
    await step(1); await advance(120); expect(state.sentence.text).toBe(third);
    vi.setSystemTime(20000); saved.resolve({success: true, data: {id: 'actual-saved-A'}}); await flush();
    expect(materialCaptures()).toEqual([]); generation.resolve({success: true, data: 23}); await saving;
    expect(materialCaptures()).toEqual([{
      source: {kind: 'video', url: source, title}, locator: {kind: 'video', quote: second, startMs: 2000, endMs: 3000},
      capturedAt: 10000, generation: 23, reference: {kind: 'vocabulary', id: 'actual-saved-A', excerpt: second},
    }]);
    expect(state.sentence.text).toBe(third); expect(state.saved).toBe(false);
    await step(-1); expect(state.saved).toBe(true);
  });

  it('X多视频问答只在成功sessionId后关联冻结的具体媒体与时间，来源不进入模型请求', async () => {
    props.platform = 'x'; props.sourceUrl = 'https://x.com/example/status/123456/video/2';
    props.cues = [{text: first, startMs: 1250.5, durationMs: 1000.25}]; video.currentTime = 1.3;
    await mount();
    const generation = deferred<{success: true; data: number}>(); materialTransport.sendMessage.mockReturnValueOnce(generation.promise);
    vi.setSystemTime(30000); state.explain();
    const request = streamReading.mock.calls[0][0];
    expect(request.selection.text).toBe(first); expect(JSON.stringify(request)).not.toContain('x.com'); expect(JSON.stringify(request)).not.toContain('material');
    readingCallbacks.result({success: true, text: 'Saved explanation', sessionId: 'actual-session-X'});
    await flush(); expect(materialCaptures()).toEqual([]);
    vi.setSystemTime(40000); generation.resolve({success: true, data: 31}); await flush();
    expect(materialCaptures()).toEqual([{
      source: {kind: 'video', url: 'https://x.com/example/status/123456/video/2', title: 'Fixture title'},
      locator: {kind: 'video', quote: first, startMs: 1250, endMs: 2251}, capturedAt: 30000, generation: 31,
      reference: {kind: 'session', id: 'actual-session-X', excerpt: first},
    }]);
    expect(materialCaptures()[0].reference.note).toBeUndefined();
  });

  it.each([
    ['failure', {success: false, error: {message: 'Save failed'}}],
    ['missing data', {success: true}], ['missing entryId', {success: true, data: {}}],
  ] as const)('收藏%s不创建材料引用', async (_reason, response) => {
    await mount(); sendRuntimeMessage.mockResolvedValueOnce(response); await state.save(); await flush();
    expect(sendRuntimeMessage).toHaveBeenCalledOnce(); expect(materialCaptures()).toEqual([]);
  });

  it.each(['failure', 'missing sessionId', 'error'] as const)('问答%s不创建材料引用', async reason => {
    await mount(); state.explain();
    if (reason === 'error') readingCallbacks.error(new Error('Stream failed'));
    else readingCallbacks.result(reason === 'failure' ? {success: false, error: 'Answer failed'} : {success: true, text: 'Unpersisted answer'});
    await flush(); expect(materialCaptures()).toEqual([]);
  });

  it('原播放器卸载后迟到收藏不能关联到新播放器材料', async () => {
    await mount(); const saved = deferred<{success: true; data: {id: string}}>(); sendRuntimeMessage.mockReturnValueOnce(saved.promise);
    const saving = state.save(); close(); props.sourceUrl = 'https://www.youtube.com/watch?v=frSentence2';
    props.video = Object.assign(new EventTarget(), {currentTime: 0, paused: true, seeking: false, ended: false, isConnected: true, play: vi.fn(), pause: vi.fn()});
    await mount(); saved.resolve({success: true, data: {id: 'old-player-entry'}}); await saving; await flush();
    expect(materialCaptures()).toEqual([]); expect(state.saved).toBe(false);
  });

  it.each(['next sentence', 'stop', 'close'] as const)('成功会话等待代次期间%s撤销材料关联归属', async boundary => {
    await mount(); const generation = deferred<{success: true; data: number}>(); materialTransport.sendMessage.mockReturnValueOnce(generation.promise);
    state.explain(); readingCallbacks.result({success: true, text: 'Persisted old explanation', sessionId: 'old-session'});
    if (boundary === 'next sentence') await step(1);
    else if (boundary === 'stop') state.stopExplanation();
    else close();
    generation.resolve({success: true, data: 41}); await flush(); expect(materialCaptures()).toEqual([]);
  });

  it('无痕材料客户端在传输前拒绝关联，原收藏成功不会绕过隐私门控', async () => {
    materialTransport.extension.inIncognitoContext = true; await mount();
    sendRuntimeMessage.mockResolvedValueOnce({success: true, data: {id: 'private-entry'}}); await state.save();
    state.explain(); readingCallbacks.result({success: true, text: 'Private answer', sessionId: 'private-session'}); await flush();
    expect(materialTransport.sendMessage).not.toHaveBeenCalled(); expect(materialCaptures()).toEqual([]);
  });
});
