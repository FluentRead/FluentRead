/**
 * @file tests/videoSentenceLearningComponent.test.ts
 * 文件职责：执行完整句视频学习组件的真实 setup，验证调度、收藏、问答与材料关联的异步归属。
 * 主要内容：保留播放器操作、翻译与草稿回归；材料通过真实公开 begin/complete/client 验证来源、时间、代次冻结与成功引用，失败和旧播放器卸载不会误关联；真实错误输出边界使用六语词典且不会改写字幕、译文或模型回答。
 * 模块边界：仅替换媒体、模型及浏览器消息传输，不替换材料采集逻辑；DOM 布局与真实平台由独立生产验收覆盖。
 */
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {parseHTML} from 'linkedom';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import {translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {VideoReadingAnnotationSession} from '@/src/features/video-subtitle/content/readingAnnotationSession';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();
const errorLocale = vi.hoisted(() => ({language: null as unknown as vue.Ref<UiLanguage>}));

const materialTransport = vi.hoisted(() => ({sendMessage: vi.fn(), extension: {inIncognitoContext: false}}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: materialTransport.sendMessage}, extension: materialTransport.extension}}));

import VideoSentenceLearning from '@/src/features/video-subtitle/ui/VideoSentenceLearning.vue';
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (value: string) => translateLegacyText(value, errorLocale.language.value)})}));
vi.mock('@/src/services/config/store', () => ({
  get config() {return config;}, configReady: Promise.resolve(),
  subscribeConfig: (fn: () => void) => {subscription = fn; fn(); return unsubscribe;},
}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: (...args: unknown[]) => sendRuntimeMessage(...args)}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {props: ['text'], setup: (props: {text: string}) => () => vue.h('output', {'data-reading-answer': ''}, props.text)}}));
vi.mock('@/src/features/reading-assistant/public', () => ({streamReading: (...args: unknown[]) => streamReading(...args)}));
vi.mock('@/src/features/video-subtitle/content/readingAnnotationClient', () => ({annotateVideoReading: (...args: unknown[]) => annotateVideoReading(...args)}));
const first = 'First sentence.';
const second = 'Second sentence.';
const third = 'Third sentence.';
const jaFirst = '今日はいい天気です。';
const jaSecond = '明日も晴れます。';
const jaThird = 'おはようございます。';
const jaCues = () => [jaFirst, jaSecond, jaThird].map((text, i) => ({text, startMs: i * 2000, durationMs: 1000}));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
};
let state: Record<string, any>, config: Config;
let video: HTMLVideoElement, props: Record<string, any>;
let subscription: () => void;
let translate: Mock, sendRuntimeMessage: Mock, streamReading: Mock;
let cancelReading: Mock, unsubscribe: Mock, emit: Mock;
let annotateVideoReading: Mock;
let readingCallbacks: {progress: (value: any) => void; result: (value: any) => void; error: (cause: Error) => void};
let renderedUnmount: (() => void) | undefined;

async function flush(): Promise<void> {
  await Promise.resolve(); await vue.nextTick(); await Promise.resolve(); await vue.nextTick();
}
function close(): void {renderedUnmount?.(); renderedUnmount = undefined;}
async function mount(parent?: HTMLElement): Promise<void> {await mountRendered(parent);}
/** 使用真实模板与 DOM renderer 验证错误提示及点击重试，避免仅检查 setup 状态而遗漏控件绑定。 */
async function mountRendered(parent?: HTMLElement): Promise<HTMLElement> {
  const document = parent?.ownerDocument ?? globalThis.document;
  const renderer = vue.createRenderer<Node, Element>({
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null),
    remove: node => node.parentNode?.removeChild(node),
    createElement: (tag, namespace) => vue.markRaw(namespace === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    parentNode: node => node.parentElement, nextSibling: node => node.nextSibling,
    patchProp: (node, key, previous, next) => {
      if (/^on[A-Z]/.test(key)) {
        const event = key.slice(2).toLowerCase();
        if (previous) node.removeEventListener(event, previous);
        if (next) node.addEventListener(event, next);
      } else if (key === 'style') Object.assign((node as HTMLElement).style, next || {});
      else if (next == null || next === false && !/^(aria-|data-)/.test(key)) node.removeAttribute(key);
      else node.setAttribute(key, next === true && !/^(aria-|data-)/.test(key) ? '' : String(next));
    },
  });
  const host = document.createElement('div'); (parent ?? document.body).appendChild(host);
  const app = renderer.createApp({setup: () => () => vue.h(VideoSentenceLearning, {...props as InstanceType<typeof VideoSentenceLearning>['$props'], onClose: () => emit('close')})});
  app.mount(host); state = (app as any)._instance.subTree.component.setupState;
  renderedUnmount = () => {app.unmount(); host.remove();};
  await flush(); return host;
}
function placePanel(fixture: {panel: HTMLElement}): void {
  const placeholder = fixture.panel;
  fixture.panel = state.panel;
  fixture.panel.append(...Array.from(placeholder.childNodes));
  placeholder.replaceWith(fixture.panel);
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
  errorLocale.language = vue.ref<UiLanguage>('zh-CN');
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
  unsubscribe = vi.fn(); emit = vi.fn(); cancelReading = vi.fn();
  translate = vi.fn(async (text: string) => `Translated: ${text}`);
  annotateVideoReading = vi.fn(async (text: string, language: string) => ({text: `Reading: ${text}`, language, scheme: 'fixture'}));
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
  it('真实浮出和停靠按钮同步标签及高度把手，面板手势不泄漏给播放器', async () => {
    const host = await mountRendered(), parentClick = vi.fn(), parentPointer = vi.fn();
    host.addEventListener('click', parentClick); host.addEventListener('pointerdown', parentPointer);
    const section = host.querySelector('.fr-video-learning')!;
    section.dispatchEvent(new document.defaultView!.Event('pointerdown', {bubbles: true}));
    host.querySelector('[data-learning-action="float"]')!.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await flush();
    expect(host.querySelector('[data-learning-action="dock"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((host.querySelector('[data-learning-resize-handle]') as HTMLElement).style.display).not.toBe('none');
    host.querySelector('[data-learning-action="dock"]')!.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await flush();
    expect(host.querySelector('[data-learning-action="float"]')?.getAttribute('aria-pressed')).toBe('false');
    expect((host.querySelector('[data-learning-resize-handle]') as HTMLElement).style.display).toBe('none');
    expect(parentClick).not.toHaveBeenCalled(); expect(parentPointer).not.toHaveBeenCalled();
  });

  it('打开外观、词书和讲解设置失败时不产生未处理拒绝，也不破坏当前句', async () => {
    const host = await mountRendered();
    sendRuntimeMessage.mockRejectedValueOnce(new Error('Options unavailable'));
    state.openAppearance(); await flush();
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-video', target: 'video-sentence-learning-appearance'});
    sendRuntimeMessage.mockRejectedValueOnce(new Error('Library unavailable'));
    state.openLibrary(); await flush();
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-vocabulary'});
    config.harness.enabled = false; sendRuntimeMessage.mockRejectedValueOnce(new Error('Reading settings unavailable'));
    state.explain(); await flush();
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-selection'});
    expect(host.querySelector('[data-learning-original]')?.textContent).toBe(first);
    expect(streamReading).not.toHaveBeenCalled();
  });

  it('快速取消编辑不会执行迟到聚焦，同一句切换目标语言保留阅读滚动', async () => {
    const host = await mountRendered();
    state.editTranslation(); state.editTranslation(); state.editExplanation(); state.editExplanation(); await flush();
    expect(host.querySelector('[data-learning-translation-editor]')).toBeNull();
    expect(host.querySelector('[data-learning-explanation-editor]')).toBeNull();
    state.body.scrollTop = 123; props.targetLanguage = 'ja'; await flush();
    expect(state.body.scrollTop).toBe(123); expect(state.sentence.text).toBe(first);
  });

  it('换句后迟到的翻译拒绝和讲解错误不能覆盖新一句的状态', async () => {
    const pending = deferred<string>(); translate.mockImplementationOnce(() => pending.promise);
    await mount(); await advance(0); state.explain(); const stale = readingCallbacks;
    await step(1); await advance(120);
    pending.reject(new Error('Old translation failed')); stale.error(new Error('Old explanation failed')); await flush();
    expect(state.sentence.text).toBe(second); expect(state.translation).toBe(`Translated: ${second}`);
    expect(state.translationError).toBe(''); expect(state.error).toBe('');
  });
  it.each([new Error('service unavailable'), 'unexpected rejection', '   '])('翻译失败 %s 显示实际重试控件，重试恢复且保留原句', async result => {
    if (typeof result === 'string' && !result.trim()) translate.mockResolvedValueOnce(result);
    else translate.mockRejectedValueOnce(result);
    const host = await mountRendered();
    const error = host.querySelector('.fr-video-learning-inline-error')!;
    expect(error.textContent).toContain(result instanceof Error ? result.message : 'video.learning.translationFailed');
    expect(host.querySelector('[data-learning-action="save"]')?.hasAttribute('disabled')).toBe(true);
    error.querySelector('button')!.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await flush();
    expect(host.querySelector('.fr-video-learning-inline-error')).toBeNull();
    expect(state.translation).toBe(`Translated: ${first}`); expect(state.sentence.text).toBe(first);
    const pending = deferred<string>(); translate.mockReturnValueOnce(pending.promise);
    error.querySelector('button')!.dispatchEvent(new document.defaultView!.Event('click')); await flush();
    expect(host.querySelector('[data-learning-action="save"]')?.hasAttribute('disabled')).toBe(true);
    pending.resolve('Refreshed translation'); await flush();
    expect(host.querySelector('[data-learning-action="save"]')?.hasAttribute('disabled')).toBe(false);
  });

  it.each(['translation', 'result', 'stream', 'startup', 'save'] as const)('六语错误展示边界本地化 %s，原始状态保留可随界面语言更新', async kind => {
    const source = '理解请求未完成，请重试';
    if (kind === 'translation') translate.mockRejectedValueOnce(new Error(source));
    if (kind === 'startup') streamReading.mockImplementationOnce(() => {throw new Error(source);});
    const host = await mountRendered();
    if (kind === 'save') {
      sendRuntimeMessage.mockResolvedValueOnce({success: false, error: {message: source}});
      await state.save();
    } else if (kind !== 'translation') {
      state.explain();
      if (kind === 'result') readingCallbacks.result({success: false, error: source});
      if (kind === 'stream') readingCallbacks.error(new Error(source));
    }
    await flush();
    expect(kind === 'translation' ? state.translationError : state.error).toBe(source);
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      errorLocale.language.value = language;await flush();
      const translated = translateLegacyText(source, language);
      expect(translated).not.toBe(source);
      expect(host.querySelector('[role="alert"]')!.textContent).toContain(translated);
      expect(kind === 'translation' ? state.translationError : state.error).toBe(source);
      expect(host.querySelector('[data-learning-original]')?.textContent).toBe(first);
    }
  });

  it('与已登记错误同文的字幕、译文和模型正文保持原样，未知错误也不猜译', async () => {
    const source = '理解请求未完成，请重试';
    props.cues = [{text: source, startMs: 0, durationMs: 1000}];
    translate.mockResolvedValueOnce(source);errorLocale.language.value = 'en-US';
    const host = await mountRendered();
    expect(host.querySelector('[data-learning-original]')?.textContent).toBe(source);
    expect(host.querySelector('[data-learning-translation-display]')?.textContent).toBe(source);
    state.explain();readingCallbacks.progress({kind: 'text', text: source});await flush();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe(source);
    readingCallbacks.result({success: true, text: source});await flush();
    expect(host.querySelector('[data-reading-answer]')?.textContent).toBe(source);
    state.explain();readingCallbacks.error(new Error('Custom provider detail: 原始内容'));await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Custom provider detail: 原始内容');
    expect(host.querySelector('[data-learning-translation-display]')?.textContent).toBe(source);
  });

  it.each(['ja', ''])('读音无来源语言时回退配置 %s，空结果不显示错误，不支持的语言不请求，换句后的归顶任务可安全卸载', async source => {
    props.cues = jaCues();
    props.sourceLanguage = ''; config.from = source; config.videoSubtitleAppearance.readingAnnotation = true;
    annotateVideoReading.mockResolvedValue(null); await mount(); await advance(0);
    expect(annotateVideoReading).toHaveBeenCalledWith(jaFirst, 'ja', expect.any(AbortSignal));
    expect(state.readingText).toBe(''); expect(state.readingError).toBe(false);
    // 英语文本无法解析为支持的读音语言，直接清空并不调用读音引擎。
    annotateVideoReading.mockClear();
    props.cues = [{text: first, startMs: 0, durationMs: 1000}]; props.sourceLanguage = 'en'; await flush();
    expect(annotateVideoReading).not.toHaveBeenCalled();
    expect(state.readingText).toBe(''); expect(state.readingError).toBe(false);
    props.cues = []; await vue.nextTick(); close(); await flush();
    expect(state.body).toBeNull();
  });

  it.each(['disabled', 'action absent'] as const)('未开启讲解能力 %s 时引导设置，不发送模型或材料请求', async reason => {
    if (reason === 'disabled') config.harness.enabled = false; else config.harness.actions = [];
    const host = await mountRendered();
    host.querySelector('[data-learning-action="explain"]')!.dispatchEvent(new document.defaultView!.Event('click')); await flush();
    expect(host.textContent).toContain('video.learning.enableExplain');
    expect(sendRuntimeMessage).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-selection'});
    expect(streamReading).not.toHaveBeenCalled(); expect(materialTransport.sendMessage).not.toHaveBeenCalled();
  });

  it.each([new Error('startup failed'), 'startup rejected'])('讲解启动同步失败 %s 可重试，关闭上下文和缺失来源不伪造引用', async cause => {
    config.harness.contextMode = 'selection'; props.sourceUrl = undefined;
    streamReading.mockImplementationOnce(() => {throw cause;}); await mount();
    state.explain(); await flush(); expect(state.explaining).toBe(false);
    expect(state.error).toBe(cause instanceof Error ? cause.message : 'video.learning.explainFailed');
    state.explain(); expect(streamReading.mock.calls.at(-1)![0].selection.context).toBe('');
    state.explain(); expect(streamReading).toHaveBeenCalledTimes(2);
    readingCallbacks.result({success: true, text: 'Recovered', sessionId: 'unlinked'}); await flush();
    expect(state.explanation).toBe('Recovered'); expect(materialTransport.sendMessage).not.toHaveBeenCalled();
  });

  it('字幕列表增量更新保留所选句，清空列表安全停播且不消费失效按钮', async () => {
    const host = await mountRendered(); await step(1); await advance(120);
    const selected = state.sentence.id;
    props.cues = [...props.cues, {text: 'Fourth sentence.', startMs: 8000, durationMs: 1000}]; await flush();
    expect(state.sentence.id).toBe(selected); expect(state.index).toBe(1);
    const play = host.querySelector('[data-learning-action="play"]')!, explain = host.querySelector('[data-learning-action="explain"]')!, save = host.querySelector('[data-learning-action="save"]')!;
    props.cues = []; await flush();
    const calls = [translate.mock.calls.length, streamReading.mock.calls.length, sendRuntimeMessage.mock.calls.length];
    expect(host.textContent).toContain('video.learning.empty'); expect(state.timeLabel).toBe('');
    for (const button of [play, explain, save]) button.dispatchEvent(new document.defaultView!.Event('click'));
    state.toggleMode('loop'); state.step(1); await state.loadTranslation();
    video.dispatchEvent(new Event('seeking')); await flush();
    expect(state.mode).toBe('off'); expect(state.pinned).toBe(false);
    expect([translate.mock.calls.length, streamReading.mock.calls.length, sendRuntimeMessage.mock.calls.length]).toEqual(calls);
    props.cues = [{text: 'Unfinished fragment', startMs: 0, durationMs: 1000}]; await flush();
    expect(host.querySelector('.fr-video-learning-badge')?.textContent).toBe('video.learning.fragment');
    state.step(-1); expect(state.index).toBe(0);
  });

  it('播放器拒绝重播给出反馈，换句后的迟到拒绝不污染新句', async () => {
    const late = deferred<void>(); await mount();
    (video.play as Mock).mockRejectedValueOnce(new Error('autoplay denied'));
    await state.replay(); expect(state.error).toBe('video.learning.playFailed');
    (video.play as Mock).mockReturnValueOnce(late.promise);
    const pending = state.replay(); await step(1); late.reject(new Error('old playback')); await pending;
    expect(state.error).toBe('');
    state.returnToCurrent(); Object.assign(video, {seeking: true, currentTime: 4}); video.dispatchEvent(new Event('timeupdate')); await flush();
    expect(state.index).toBe(1);
  });

  it('收藏拒绝空译文和过长讲解，未知语言使用auto且非Error失败可恢复', async () => {
    props.sourceLanguage = ''; await mount(); state.translation = ''; state.onTranslationInput();
    await state.save(); expect(state.error).toBe('video.learning.editPlaceholder'); expect(sendRuntimeMessage).not.toHaveBeenCalled();
    state.translation = 'Reviewed'; state.explanation = 'x'.repeat(2001); await state.save();
    expect(state.error).toBe('video.learning.tooLong'); expect(sendRuntimeMessage).not.toHaveBeenCalled();
    state.explanation = 'Short note'; sendRuntimeMessage.mockRejectedValueOnce('unexpected transport failure'); await state.save();
    expect(state.error).toBe('video.learning.saveFailed'); expect(state.saving).toBe(false);
    expect(sendRuntimeMessage.mock.calls.at(-1)![0].input.sourceLanguage).toBe('auto');
    await state.save(); expect(state.saved).toBe(true);
  });

  it('百条草稿容量淘汰最早记录，后续人工草稿与正在生成的讲解互不覆盖', async () => {
    props.cues = Array.from({length: 103}, (_, index) => ({text: `Sentence ${index}.`, startMs: index * 2000, durationMs: 1000}));
    await mount(); state.translation = 'Oldest edit'; state.onTranslationInput(); state.explain(); readingCallbacks.progress({kind: 'text', text: 'Unfinished'});
    for (let index = 1; index <= 102; index++) {await step(1); state.translation = `Edit ${index}`; state.onTranslationInput();}
    await step(-1); expect(state.translation).toBe('Edit 101');
    state.step(-101); await advance(120);
    expect(state.translation).toBe('Translated: Sentence 0.'); expect(state.explanation).toBe('');
    expect(cancelReading).toHaveBeenCalled();
  });

  it('真实模板串联导航、重播、编辑、讲解、收藏、外观与收起恢复', async () => {
    const host = await mountRendered();
    const click = async (action: string) => {const button = host.querySelector(`[data-learning-action="${action}"]`) as HTMLButtonElement; expect(button).toBeTruthy(); expect(button.hasAttribute('disabled')).toBe(false); button.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await flush();};
    await click('help'); expect(host.querySelector('[data-learning-help]')).toBeTruthy();
    await click('appearance'); expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-video', target: 'video-sentence-learning-appearance'});
    await click('collapse'); expect(host.querySelector('[data-learning-peek]')?.textContent).toBe(first);
    host.querySelector('[data-learning-peek]')!.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await flush(); expect(state.expanded).toBe(true);
    await click('next'); await advance(120); expect(state.sentence.text).toBe(second);
    await click('previous'); await advance(120); expect(state.sentence.text).toBe(first);
    await click('play'); expect(video.play).toHaveBeenCalled(); expect(video.currentTime).toBe(0);
    await click('loop'); expect(state.mode).toBe('loop'); await click('pause-at-end'); expect(state.mode).toBe('pause'); await click('normal'); expect(state.mode).toBe('off');
    await click('follow'); expect(state.pinned).toBe(false);
    const context = host.querySelector('details') as HTMLDetailsElement; context.open = true; context.dispatchEvent(new document.defaultView!.Event('toggle')); await flush(); expect(state.pinned).toBe(true);
    context.open = false; context.dispatchEvent(new document.defaultView!.Event('toggle'));
    await click('edit-translation');
    const translationEditor = host.querySelector('[data-learning-translation]') as HTMLTextAreaElement;
    translationEditor.dispatchEvent(new document.defaultView!.Event('focus')); translationEditor.value = 'Reviewed translation'; translationEditor.dispatchEvent(new document.defaultView!.Event('input')); await flush();
    expect(state.translation).toBe('Reviewed translation'); expect(state.translationEdited).toBe(true);
    await click('done-translation'); expect(host.querySelector('[data-learning-translation-display]')?.textContent).toBe('Reviewed translation');
    await click('explain'); readingCallbacks.progress({kind: 'text', text: 'Initial explanation'}); await flush();
    await click('stop-explanation'); expect(host.querySelector('.fr-video-learning-explanation')?.textContent).toContain('video.learning.stoppedShort');
    await click('edit-explanation');
    const explanationEditor = host.querySelector('[data-learning-explanation]') as HTMLTextAreaElement;
    explanationEditor.dispatchEvent(new document.defaultView!.Event('focus')); explanationEditor.value = 'Reviewed explanation'; explanationEditor.dispatchEvent(new document.defaultView!.Event('input')); await flush();
    await click('done-explanation'); expect(state.explanation).toBe('Reviewed explanation');
    await click('save'); await flush(); expect(host.querySelector('[data-learning-saved="true"]')).toBeTruthy();
    await click('library'); expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-vocabulary'});
    await click('close'); expect(emit).toHaveBeenCalledWith('close');
  });

  it('读音默认关闭，单独开关不打断人工草稿、固定句和循环，面板原句不跟播放器模式隐藏', async () => {
    props.cues = jaCues();
    props.sourceLanguage = 'ja'; await mount();
    expect(annotateVideoReading).not.toHaveBeenCalled();
    state.translation = '人工译文'; state.onTranslationInput(); state.toggleMode('loop');
    const requests = translate.mock.calls.length;
    config.videoSubtitleDisplayMode = 'translation-only'; config.videoSubtitleAppearance.readingAnnotation = true; subscription();
    await advance(0);
    expect(state.readingText).toBe(`Reading: ${jaFirst}`);
    expect(state.readingLanguage).toBe('ja');
    expect(annotateVideoReading).toHaveBeenCalledWith(jaFirst, 'ja', expect.any(AbortSignal));
    expect(state.translation).toBe('人工译文'); expect(state.pinned).toBe(true); expect(state.mode).toBe('loop');
    expect(translate).toHaveBeenCalledTimes(requests);
    config.videoSubtitleAppearance.readingAnnotation = false; subscription(); await flush();
    expect(state.readingText).toBe(''); expect(state.translation).toBe('人工译文'); expect(state.mode).toBe('loop');
  });

  it('实际模板显示紧凑读音错误与可点击重试，成功后移除错误且保留原句', async () => {
    props.cues = jaCues();
    annotateVideoReading.mockRejectedValueOnce(new Error('dictionary unavailable'));
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    const host = await mountRendered(); await advance(0);
    const error = host.querySelector('[data-learning-reading-error]')!;
    expect(error.getAttribute('role')).toBe('status'); expect(error.textContent).toContain('video.readingAnnotation.error');
    const retry = error.querySelector('button')!; expect(retry.textContent).toBe('video.readingAnnotation.retry');
    retry.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await advance(0);
    expect(host.querySelector('[data-learning-reading-error]')).toBeNull();
    expect(host.querySelector('[data-learning-reading]')?.textContent).toBe(`Reading: ${jaFirst}`);
    expect(host.querySelector('[data-learning-original]')?.textContent).toBe(jaFirst);
    expect(annotateVideoReading).toHaveBeenCalledTimes(2);
  });

  it('读音失败独立重试，不改变人工译文、已保存快照、固定状态或循环', async () => {
    props.cues = jaCues();
    annotateVideoReading.mockRejectedValueOnce(new Error('dictionary unavailable'));
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); await advance(0); expect(state.readingError).toBe(true);
    state.translation = '人工译文'; state.onTranslationInput(); state.toggleMode('loop'); await state.save();
    const saved = state.savedSnapshot, translationRequests = translate.mock.calls.length, savedRequests = sendRuntimeMessage.mock.calls.length;
    expect(state.saved).toBe(true); state.loadReadingAnnotation(); await advance(0);
    expect(state.readingError).toBe(false); expect(state.readingText).toBe(`Reading: ${jaFirst}`);
    expect(state.translation).toBe('人工译文'); expect(state.saved).toBe(true); expect(state.savedSnapshot).toBe(saved);
    expect(state.pinned).toBe(true); expect(state.mode).toBe('loop');
    expect(translate).toHaveBeenCalledTimes(translationRequests); expect(sendRuntimeMessage).toHaveBeenCalledTimes(savedRequests);
  });

  it('换句、收起、停用与关闭清除读音错误，旧代次AbortError不能误报当前句', async () => {
    props.cues = jaCues();
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); await step(1); await advance(0);
    late.reject(new DOMException('old sentence cancelled', 'AbortError')); await advance(0);
    expect(state.readingError).toBe(false); expect(state.readingText).toBe(`Reading: ${jaSecond}`);
    annotateVideoReading.mockRejectedValueOnce(new Error('failed'));
    await step(1); await advance(0); expect(state.readingError).toBe(true);
    await step(-1); await advance(0); expect(state.readingError).toBe(false);
    await step(1); await advance(0); annotateVideoReading.mockRejectedValueOnce(new Error('retry failed'));
    props.sourceUrl = 'https://www.youtube.com/watch?v=retry-media'; await advance(0); expect(state.readingError).toBe(true);
    const requests = annotateVideoReading.mock.calls.length; state.expanded = false; await flush();
    expect(state.readingError).toBe(false); await advance(500); expect(annotateVideoReading).toHaveBeenCalledTimes(requests);
    annotateVideoReading.mockRejectedValueOnce(new Error('failed again')); state.expanded = true; await advance(0);
    expect(state.readingError).toBe(true); config.videoSubtitleAppearance.readingAnnotation = false; subscription(); await flush();
    expect(state.readingError).toBe(false);
    annotateVideoReading.mockRejectedValueOnce(new Error('failed before close')); config.videoSubtitleAppearance.readingAnnotation = true; subscription(); await advance(0);
    expect(state.readingError).toBe(true); close(); expect(state.readingError).toBe(false);
  });

  it('读音跟随当前固定或历史句，快速换句与关闭拒绝迟到响应', async () => {
    props.cues = jaCues();
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); const signal = annotateVideoReading.mock.calls[0][2] as AbortSignal;
    await step(1); await advance(0);
    expect(signal.aborted).toBe(true); expect(state.readingText).toBe(`Reading: ${jaSecond}`);
    late.resolve({text: '古い読み', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).toBe(`Reading: ${jaSecond}`);
    await step(-1); await advance(0); expect(state.readingText).toBe(`Reading: ${jaFirst}`);
    const afterClose = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(afterClose.promise);
    await step(1); await step(1); await flush();
    const closingSignal = annotateVideoReading.mock.calls.at(-1)![2] as AbortSignal;
    close(); expect(closingSignal.aborted).toBe(true);
    afterClose.resolve({text: '关闭后的读音', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).not.toBe('关闭后的读音');
  });

  it('收起面板取消读音，隐藏换句不发请求，展开当前句再读取；换媒体不复用旧会话缓存', async () => {
    props.cues = jaCues();
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); const signal = annotateVideoReading.mock.calls[0][2] as AbortSignal;
    state.expanded = false; await flush(); expect(signal.aborted).toBe(true);
    await step(1); await advance(500); expect(annotateVideoReading).toHaveBeenCalledOnce();
    late.resolve({text: '已收起的读音', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).toBe('');
    state.expanded = true; await advance(0); expect(state.readingText).toBe(`Reading: ${jaSecond}`);
    const count = annotateVideoReading.mock.calls.length;
    props.sourceUrl = 'https://www.youtube.com/watch?v=another-video'; await advance(0);
    expect(annotateVideoReading).toHaveBeenCalledTimes(count + 1);
  });

  it.each([false, true])('换句只归顶当前owned滚动区，短高整卡=%s，页面与外层portal滚动不变', async short => {
    const f = portalKeyboardFixture(), host = f.panel.parentElement!;
    host.id = 'fluent-read-video-learning-panel'; host.dataset.shortHeight = String(short);
    await mount(f.panel.parentElement!); placePanel(f);
    const body = state.body as HTMLElement;
    body.scrollTop = 42; f.panel.scrollTop = 180; host.scrollTop = 200; f.document.documentElement.scrollTop = 2720;
    f.key('ArrowRight', video); await flush();
    expect(state.index).toBe(1); expect(body.scrollTop).toBe(0); expect(f.panel.scrollTop).toBe(short ? 0 : 180);
    expect(host.scrollTop).toBe(200); expect(f.document.documentElement.scrollTop).toBe(2720);
  });

  it('portal面板以显式媒体player消费真实窗口学习键，并让位同视频兄弟菜单', async () => {
    const f = portalKeyboardFixture(); await mount(f.panel.parentElement!); placePanel(f);
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
    await mount(f.panel.parentElement!); placePanel(f);
    expect(f.key('ArrowRight', video).defaultPrevented).toBe(false); expect(state.index).toBe(0);
    expect(f.key('r', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); expect(state.mode).toBe('loop');
    expect(f.key('Escape', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true); expect(emit).toHaveBeenCalledWith('close');
  });

  it('同媒体重挂后拒绝旧player并立即消费更新后的显式player，不依赖portal位置', async () => {
    const f = portalKeyboardFixture(); await mount(f.panel.parentElement!); placePanel(f);
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
    await mount(document.querySelector('section')!.parentElement!); placePanel({panel: document.querySelector('section')!});
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
    const body = state.body as HTMLElement; body.scrollTop = 42;
    state.step(1); expect(state.sentence.text).toBe(second);
    await flush(); expect(body.scrollTop).toBe(0); expect(state.translation).toBe('');
    await advance(60); expect(translate).toHaveBeenCalledOnce();
    body.scrollTop = 31; state.step(1); expect(state.sentence.text).toBe(third);
    await flush(); expect(body.scrollTop).toBe(0);
    await advance(119); expect(translate).toHaveBeenCalledOnce();
    await advance(1); expect(translate.mock.calls.map(call => call[0])).toEqual([first, third]);
    expect(state.translation).toBe(`Translated: ${third}`);
  });

  it('初次打开立即请求，自然播放跟句合并 120ms 防抖并保留输入边界的浅身份', async () => {
    await mount(); expect(translate).toHaveBeenCalledOnce();
    expect(state.props.video).toBe(video); expect(state.props.cues).toBe(props.cues);
    const body = state.body as HTMLElement; body.scrollTop = 50;
    video.currentTime = 2.2; video.dispatchEvent(new Event('timeupdate'));
    await flush(); expect(state.sentence.text).toBe(second); expect(body.scrollTop).toBe(0);
    expect(translate).toHaveBeenCalledOnce();
    await advance(120);
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

it('切换同一来源 cue 内语义句不重复跳回播放起点，显式重播仍使用来源范围', async () => {
  props.cues = [{text: 'First sentence. Second sentence!', startMs: 0, durationMs: 9000}];
  const host = await mountRendered();
  expect(host.querySelector('[data-learning-timing-precision]')?.textContent).toBe('video.learning.cueEnvelope');
  expect(host.querySelector('[data-learning-action="play"]')?.textContent).toBe('video.learning.replaySource');
  video.currentTime = 4; await step(1);
  expect(state.sentence.text).toBe('Second sentence!'); expect(video.currentTime).toBe(4);
  await state.replay(); expect(video.currentTime).toBe(0);
});

it('跨 cue 的原句显示与翻译沿用原有空格拼接', async () => {
  props.cues = [
    {text: 'Sea  otters', startMs: 0, durationMs: 1500},
    {text: 'have strong teeth.', startMs: 1500, durationMs: 1500},
  ];
  const host = await mountRendered();
  expect(host.querySelector('[data-learning-original]')?.textContent).toBe('Sea otters have strong teeth.');
  expect(host.querySelector('[data-learning-timing-precision]')).toBeNull();
  expect(host.querySelector('[data-learning-action="play"]')?.textContent).toBe('video.learning.replay');
  expect(translate.mock.calls.map(([text]) => text)).toEqual(['Sea otters have strong teeth.']);
});
it('同一来源范围内快速切句仍认领重播尚未完成的跳转', async () => {
  props.cues = [{text: 'First sentence. Second sentence!', startMs: 1000, durationMs: 8000}];
  let mediaTime = 4;
  let seeking = false;
  const seek = vi.fn((time: number) => {mediaTime = time; seeking = true;});
  Object.defineProperties(video, {
    currentTime: {get: () => mediaTime, set: seek},
    seeking: {get: () => seeking},
  });
  await mount();
  state.toggleMode('loop');
  await state.replay();
  await step(1);
  expect(state.sentence.text).toBe('Second sentence!');
  video.dispatchEvent(new Event('seeking'));
  seeking = false;
  video.dispatchEvent(new Event('seeked'));
  expect(state.mode).toBe('loop');
  expect(seek.mock.calls).toEqual([[1]]);

  mediaTime = 6;
  video.dispatchEvent(new Event('seeking'));
  expect(state.mode).toBe('off');
});

it('HTML transcript renders a bounded window and line clicks seek the original media', async () => {
  props.platform = 'html'; props.sourceUrl = 'https://podcast.example/episode';
  props.cues = Array.from({length: 1000}, (_, n) => ({text: `Sentence ${n}.`, startMs: n * 2000, durationMs: 1000}));
  const host = await mountRendered();
  state.onTranscriptToggle({target: {open: true}}); await flush();
  expect(host.querySelectorAll('.fr-video-learning-transcript-scroll button').length).toBeLessThanOrEqual(14);
  const list = host.querySelector<HTMLElement>('.fr-video-learning-transcript-scroll')!;
  list.scrollTop = 5600;
  list.dispatchEvent(new list.ownerDocument.defaultView!.Event('scroll'));
  list.dispatchEvent(new list.ownerDocument.defaultView!.Event('scroll'));
  await advance(20);
  expect(state.visibleTranscript[0].text).toBe('Sentence 97.');
  const row = host.querySelectorAll('.fr-video-learning-transcript-scroll button')[3];
  row.dispatchEvent(new row.ownerDocument.defaultView!.Event('click', {bubbles: true})); await flush(); expect(video.currentTime).toBe(200);
  expect(host.querySelector('.fr-video-learning-transcript-scroll [aria-current="true"]')?.textContent).toContain('Sentence 100.');
  state.pinned = false; video.currentTime = 202; video.dispatchEvent(new Event('timeupdate')); await flush();
  expect(state.transcriptList.scrollTop).toBe(101 * 56);
  state.onTranscriptToggle({target: {open: false}}); await flush();
  expect(host.querySelector('.fr-video-learning-transcript-scroll')).toBeNull();
});

it('HTML word lookup reuses dictionary and translation ports, bounds definitions and closes on Escape', async () => {
  props.platform = 'html';
  sendRuntimeMessage.mockResolvedValue({success: true, data: {meanings: [{definitions: ['one', 'two', 'three', 'four'].map(definition => ({definition}))}]}});
  const host = await mountRendered();
  await state.lookupWord('browser.'); await flush();
  expect(sendRuntimeMessage).toHaveBeenCalledWith({type: 'selectionWordLookup', word: 'browser', targetLanguage: 'zh-CN', translateFields: false});
  expect(state.wordLookup).toMatchObject({word: 'browser', text: 'Translated: browser', definitions: ['one', 'two', 'three']});
  expect(host.querySelector('[data-learning-word-popup]')).not.toBeNull();
  const event = new Event('keydown', {cancelable: true}); Object.defineProperty(event, 'key', {value: 'Escape'});
  state.onKeydown(event); await flush(); expect(event.defaultPrevented).toBe(true); expect(state.wordLookup).toBeNull();
  const calls = translate.mock.calls.length; await state.lookupWord('...'); expect(translate).toHaveBeenCalledTimes(calls);
});

it('HTML word lookup discards old results and keeps failures local to the word popup', async () => {
  props.platform = 'html'; await mount();
  const oldDictionary = deferred<unknown>(), oldTranslation = deferred<string>();
  sendRuntimeMessage.mockReturnValueOnce(oldDictionary.promise).mockResolvedValue({success: true});
  translate.mockReturnValueOnce(oldTranslation.promise).mockResolvedValue('New word');
  const old = state.lookupWord('old'); const signal = translate.mock.calls.at(-1)![1] as AbortSignal;
  await state.lookupWord('new'); await flush(); expect(signal.aborted).toBe(true);
  oldDictionary.resolve({success: true, data: {meanings: []}}); oldTranslation.resolve('Late word'); await old;
  expect(state.wordLookup).toMatchObject({word: 'new', text: 'New word', definitions: []});
  translate.mockRejectedValueOnce(new Error('fixture word translation failed')); sendRuntimeMessage.mockRejectedValueOnce(new Error('fixture dictionary unavailable'));
  await state.lookupWord('retry'); await flush(); expect(state.wordLookup.text).toBe('video.learning.translationFailed');
  state.onTranscriptToggle({target: {open: true}}); close(); await flush();
});


it('HTML empty captions and queued transcript following remain safe when the panel closes', async () => {
  props.platform = 'html'; props.cues = []; await mount(); expect(state.wordParts).toEqual([]); close();
  props.cues = [{text: first, startMs: 0, durationMs: 1000}, {text: second, startMs: 2000, durationMs: 1000}];
  await mount(); state.onTranscriptToggle({target: {open: true}}); await flush();
  video.currentTime = 2; video.dispatchEvent(new Event('timeupdate')); await vue.nextTick(); close(); await flush();
});

it('HTML sentence saving retains its web source without claiming a platform-specific deep link', async () => {
  props.platform = 'html'; props.sourceUrl = 'https://podcast.example/episode'; await mount();
  await state.save();
  const input = sendRuntimeMessage.mock.calls.find(([message]) => message.action === 'upsert')![0].input;
  expect(input.context).toMatchObject({sourceUrl: 'https://podcast.example/episode'}); expect(input.context.video).toBeUndefined();
});

describe('学习面板韧性、快捷键与共享读音会话', () => {
  it('重新讲解失败保留原讲解并提供内联重试，45 秒停滞看门狗释放保存按钮', async () => {
    const host = await mountRendered();
    state.explain();
    readingCallbacks.result({success: true, text: 'Initial valid explanation'});
    await flush();
    expect(state.explanation).toBe('Initial valid explanation');

    // 重新讲解返回失败时，恢复旧讲解并展示内联重试按钮。
    state.explain();
    readingCallbacks.result({success: false, error: 'temporary explain error'});
    await flush();
    expect(state.explanation).toBe('Initial valid explanation');
    expect(state.error).toBe('temporary explain error');
    const retryBtn = host.querySelector<HTMLButtonElement>('[data-learning-action="retry-explanation"]')!;
    expect(retryBtn).toBeTruthy();

    // 点击重试后任意进度（包括非文本进度）均刷新看门狗；超时时 cancel 同步回调 error 不重复覆盖超时错误。
    cancelReading.mockImplementationOnce(() => { readingCallbacks.error(new Error('sync abort from cancel')); });
    retryBtn.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true}));
    await flush();
    expect(state.explaining).toBe(true);
    await advance(30_000);
    readingCallbacks.progress({kind: 'status', text: 'thinking'});
    expect(state.explanation).toBe('');
    await advance(30_000);
    expect(state.explaining).toBe(true);
    readingCallbacks.progress({kind: 'text', text: 'Partial retry'});
    await advance(30_000);
    expect(state.explaining).toBe(true);
    await advance(15_000);
    expect(state.explaining).toBe(false);
    expect(cancelReading).toHaveBeenCalled();
    expect(state.explanation).toBe('Initial valid explanation');
    expect(state.error).toBe('video.learning.explainFailed');
    expect(host.querySelector('[data-learning-action="save"]')?.hasAttribute('disabled')).toBe(false);

    // 已经排队的旧看门狗回调在停止讲解后触发时必须安全忽略。
    state.explain();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => undefined);
    state.stopExplanation();
    clearSpy.mockRestore();
    await advance(45_000);
    expect(state.explanationFailed).toBe(false);
    expect(state.error).toBe('');
  });

  it('翻译瞬态失败后自动重试一次并可恢复，鉴权失败不自动重试，收起取消重试计时器', async () => {
    translate.mockRejectedValueOnce(new Error('503 service unavailable')).mockResolvedValueOnce('Recovered translation');
    await mount();
    expect(state.translationError).toBe('503 service unavailable');
    await advance(1200);
    expect(state.translation).toBe('Recovered translation');
    expect(state.translationError).toBe('');
    expect(translate).toHaveBeenCalledTimes(2);

    // 连续瞬态失败仅自动重试一次，不无限循环。
    translate.mockRejectedValueOnce(new Error('network timeout')).mockRejectedValueOnce(new Error('network timeout'));
    await step(1);
    await advance(120);
    expect(state.translationError).toBe('network timeout');
    await advance(1200);
    await advance(3600);
    expect(translate).toHaveBeenCalledTimes(4);

    // 401 非瞬态错误不触发自动重试。
    translate.mockRejectedValueOnce(new Error('401 unauthorized'));
    await step(1);
    await advance(120);
    await advance(2400);
    expect(translate).toHaveBeenCalledTimes(5);

    // 收起面板取消排队的重试计时器。
    translate.mockRejectedValueOnce(new Error('429 rate limit'));
    await step(-1);
    await advance(120);
    state.expanded = false;
    await advance(2400);
    expect(translate).toHaveBeenCalledTimes(6);
  });

  it('查词翻译失败展示内联重试按钮并可重新查词，初次挂载位于中间句直接翻译', async () => {
    props.platform = 'html';
    video.currentTime = 2.2;
    translate.mockResolvedValueOnce('Sentence translation').mockRejectedValueOnce(new Error('word failed')).mockResolvedValueOnce('Word ok');
    const host = await mountRendered();
    expect(state.sentence.text).toBe(second);
    expect(state.translation).toBe('Sentence translation');
    host.querySelector<HTMLButtonElement>('.fr-video-learning-word')!.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true}));
    await flush();
    const retryWord = host.querySelector<HTMLButtonElement>('[data-learning-action="retry-word"]')!;
    expect(retryWord).toBeTruthy();
    retryWord.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true}));
    await flush();
    expect(state.wordLookup).toMatchObject({word: 'Second', text: 'Word ok', failed: false});
  });

  it('快捷键跳过 slider，支持 s 重播、f 跟随与面板根部 Space 启停播放', async () => {
    const f = portalKeyboardFixture();
    await mount(f.panel.parentElement!);
    placePanel(f);
    const slider = f.document.createElement('div');
    slider.setAttribute('role', 'slider');
    f.player.appendChild(slider);
    expect(f.key('ArrowRight', slider).defaultPrevented).toBe(false);
    expect(state.index).toBe(0);

    // s 键重播当前句；f 键仅在焦点位于学习面板内部时返回跟随，不劫持播放器原生全屏热键。
    await step(1);
    expect(state.pinned).toBe(true);
    expect(f.key('s', video).defaultPrevented).toBe(true);
    expect(video.play).toHaveBeenCalledOnce();
    video.currentTime = 4.2;
    expect(f.key('f', video).defaultPrevented).toBe(false);
    expect(state.pinned).toBe(true);
    expect(state.index).toBe(1);
    expect(f.key('f', f.document.getElementById('panel-button')!).defaultPrevented).toBe(true);
    await flush();
    expect(state.pinned).toBe(false);
    expect(state.index).toBe(2);

    // Safari webkitFullscreenElement 同样在播放器全屏时支持 body 焦点学习键与 Escape 退出全屏。
    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: f.player});
    expect(f.key('r', f.document.body).defaultPrevented).toBe(true);
    expect(state.mode).toBe('loop');
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(f.document, 'exitFullscreen', {configurable: true, value: exitFullscreen});
    expect(f.key('Escape', f.document.body).defaultPrevented).toBe(false);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: null});

    // Space 仅在焦点直接位于面板根部时切换播放/暂停，子按钮和播放器保留默认行为。
    expect(f.key(' ', f.document.getElementById('panel-button')!).defaultPrevented).toBe(false);
    expect(f.key(' ', video).defaultPrevented).toBe(false);
    Object.assign(video, {paused: true});
    expect(f.key(' ', state.panel).defaultPrevented).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);
    Object.assign(video, {paused: false});
    expect(f.key(' ', state.panel).defaultPrevented).toBe(true);
    expect(video.pause).toHaveBeenCalledOnce();
    Object.assign(video, {paused: true});
    (video.play as Mock).mockRejectedValueOnce(new Error('blocked'));
    expect(f.key(' ', state.panel).defaultPrevented).toBe(true);
    await flush();
    expect(state.error).toBe('video.learning.playFailed');
    // 关闭面板后异步拒绝不写入错误。
    const latePlay = deferred<void>();
    (video.play as Mock).mockReturnValueOnce(latePlay.promise);
    expect(f.key(' ', state.panel).defaultPrevented).toBe(true);
    close();
    latePlay.reject(new Error('closed'));
    await flush();
  });

  it('注入共享 readingSession 复用规范化语言缓存且与面板本地请求互不取消', async () => {
    const sharedPending = deferred<{text: string; language: string; scheme: string} | null>();
    const sharedAnnotate = vi.fn(async (text: string, language: string) => {
      if (text === jaSecond) return null;
      if (text === jaThird) return sharedPending.promise;
      return {text: `Shared: ${text}`, language, scheme: 'shared'};
    });
    const shared = new VideoReadingAnnotationSession(sharedAnnotate);
    await shared.request(jaFirst, 'ja');
    await shared.request(jaSecond, 'ja');
    expect(sharedAnnotate).toHaveBeenCalledTimes(2);

    config.videoSubtitleAppearance.readingAnnotation = true;
    props.cues = jaCues();
    props.sourceLanguage = 'ja-JP';
    props.readingSession = shared;
    await mount();
    await flush();
    expect(state.readingText).toBe(`Shared: ${jaFirst}`);
    expect(state.readingLanguage).toBe('ja');
    expect(annotateVideoReading).not.toHaveBeenCalled();

    // 共享会话缓存 null（无适用读音）时直接跳过本地请求且不报错。
    await step(1);
    await flush();
    expect(state.readingText).toBe('');
    expect(state.readingError).toBe(false);
    expect(annotateVideoReading).not.toHaveBeenCalled();

    // 共享会话正在进行前台任务时，面板未命中缓存应使用本地会话，互不取消也不误报错误。
    const playerJob = shared.request(jaThird, 'ja');
    const localPending = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(localPending.promise);
    await step(1);
    await flush();
    expect(annotateVideoReading).toHaveBeenCalledWith(jaThird, 'ja', expect.any(AbortSignal));
    sharedPending.resolve({text: 'Player shared result', language: 'ja', scheme: 'shared'});
    await expect(playerJob).resolves.toEqual({text: 'Player shared result', language: 'ja', scheme: 'shared'});
    localPending.resolve({text: 'Local panel result', language: 'ja', scheme: 'local'});
    await flush();
    expect(state.readingText).toBe('Local panel result');
    expect(state.readingError).toBe(false);

    props.sourceUrl = 'https://www.youtube.com/watch?v=other';
    await flush();
    expect(shared.peek(jaFirst, 'ja')).toEqual({text: `Shared: ${jaFirst}`, language: 'ja', scheme: 'shared'});
    close();
    expect(shared.peek(jaFirst, 'ja')).toEqual({text: `Shared: ${jaFirst}`, language: 'ja', scheme: 'shared'});
    shared.destroy();
  });

  it('关闭面板与空目标滚动安全清理待执行字幕滚动帧，同帧多次滚动合并', async () => {
    const callbacks: Array<() => void> = [];
    let nextFrameId = 0;
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => { callbacks.push(cb); return ++nextFrameId; }));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    props.platform = 'html';
    props.cues = Array.from({length: 30}, (_, n) => ({text: `Line ${n}.`, startMs: n * 1000, durationMs: 800}));
    const host = await mountRendered();
    state.onTranscriptScroll({target: null});
    state.onTranscriptToggle({target: {open: true}});
    await flush();
    const list = host.querySelector<HTMLElement>('.fr-video-learning-transcript-scroll')!;
    list.scrollTop = 280;
    list.dispatchEvent(new list.ownerDocument.defaultView!.Event('scroll'));
    list.scrollTop = 560;
    list.dispatchEvent(new list.ownerDocument.defaultView!.Event('scroll'));
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await flush();
    expect(state.transcriptScroll).toBe(560);

    list.scrollTop = 840;
    list.dispatchEvent(new list.ownerDocument.defaultView!.Event('scroll'));
    expect(callbacks).toHaveLength(1);
    close();
    expect(cancel).toHaveBeenCalledWith(2);
  });
});
