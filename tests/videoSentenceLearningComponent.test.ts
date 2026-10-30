/**
 * @file tests/videoSentenceLearningComponent.test.ts
 * 文件职责：执行完整句视频学习组件的真实 setup，验证调度、收藏、问答与材料关联的异步归属。
 * 主要内容：保留播放器操作、翻译与草稿回归；材料通过真实公开 begin/complete/client 验证来源、时间、代次冻结与成功引用，失败和旧播放器卸载不会误关联；真实错误输出边界使用六语词典且不会改写字幕、译文或模型回答。
 * 模块边界：仅替换媒体、模型及浏览器消息传输，不替换材料采集逻辑；DOM 布局与真实平台由独立生产验收覆盖。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {translateLegacyText, type UiLanguage} from '@/src/core/i18n';
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
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
};
let state: Record<string, any>, config: Config;
let video: HTMLVideoElement, props: Record<string, any>;
let subscription: () => void;
let translate: ReturnType<typeof vi.fn>, sendRuntimeMessage: ReturnType<typeof vi.fn>, streamReading: ReturnType<typeof vi.fn>;
let cancelReading: ReturnType<typeof vi.fn>, unsubscribe: ReturnType<typeof vi.fn>, emit: ReturnType<typeof vi.fn>;
let annotateVideoReading: ReturnType<typeof vi.fn>;
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
  (browserCapabilities as {extensionDom: boolean}).extensionDom = true;
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

  it.each(['ja', ''])('读音无来源语言时回退配置 %s，空结果不显示错误，换句后的归顶任务可安全卸载', async source => {
    props.sourceLanguage = ''; config.from = source; config.videoSubtitleAppearance.readingAnnotation = true;
    annotateVideoReading.mockResolvedValue(null); await mount(); await advance(0);
    expect(annotateVideoReading).toHaveBeenCalledWith(first, source || 'auto', expect.any(AbortSignal));
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
    (video.play as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('autoplay denied'));
    await state.replay(); expect(state.error).toBe('video.learning.playFailed');
    (video.play as ReturnType<typeof vi.fn>).mockReturnValueOnce(late.promise);
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
    await click('appearance'); expect(sendRuntimeMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-interface', target: 'video-sentence-learning-appearance'});
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
    props.sourceLanguage = 'ja'; await mount();
    expect(annotateVideoReading).not.toHaveBeenCalled();
    state.translation = '人工译文'; state.onTranslationInput(); state.toggleMode('loop');
    const requests = translate.mock.calls.length;
    config.videoSubtitleDisplayMode = 'translation-only'; config.videoSubtitleAppearance.readingAnnotation = true; subscription();
    await advance(0);
    expect(state.readingText).toBe(`Reading: ${first}`);
    expect(state.readingLanguage).toBe('ja');
    expect(annotateVideoReading).toHaveBeenCalledWith(first, 'ja', expect.any(AbortSignal));
    expect(state.translation).toBe('人工译文'); expect(state.pinned).toBe(true); expect(state.mode).toBe('loop');
    expect(translate).toHaveBeenCalledTimes(requests);
    config.videoSubtitleAppearance.readingAnnotation = false; subscription(); await flush();
    expect(state.readingText).toBe(''); expect(state.translation).toBe('人工译文'); expect(state.mode).toBe('loop');
  });

  it('实际模板显示紧凑读音错误与可点击重试，成功后移除错误且保留原句', async () => {
    annotateVideoReading.mockRejectedValueOnce(new Error('dictionary unavailable'));
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    const host = await mountRendered(); await advance(0);
    const error = host.querySelector('[data-learning-reading-error]')!;
    expect(error.getAttribute('role')).toBe('status'); expect(error.textContent).toContain('video.readingAnnotation.error');
    const retry = error.querySelector('button')!; expect(retry.textContent).toBe('video.readingAnnotation.retry');
    retry.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await advance(0);
    expect(host.querySelector('[data-learning-reading-error]')).toBeNull();
    expect(host.querySelector('[data-learning-reading]')?.textContent).toBe(`Reading: ${first}`);
    expect(host.querySelector('[data-learning-original]')?.textContent).toBe(first);
    expect(annotateVideoReading).toHaveBeenCalledTimes(2);
  });

  it('读音失败独立重试，不改变人工译文、已保存快照、固定状态或循环', async () => {
    annotateVideoReading.mockRejectedValueOnce(new Error('dictionary unavailable'));
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); await advance(0); expect(state.readingError).toBe(true);
    state.translation = '人工译文'; state.onTranslationInput(); state.toggleMode('loop'); await state.save();
    const saved = state.savedSnapshot, translationRequests = translate.mock.calls.length, savedRequests = sendRuntimeMessage.mock.calls.length;
    expect(state.saved).toBe(true); state.loadReadingAnnotation(); await advance(0);
    expect(state.readingError).toBe(false); expect(state.readingText).toBe(`Reading: ${first}`);
    expect(state.translation).toBe('人工译文'); expect(state.saved).toBe(true); expect(state.savedSnapshot).toBe(saved);
    expect(state.pinned).toBe(true); expect(state.mode).toBe('loop');
    expect(translate).toHaveBeenCalledTimes(translationRequests); expect(sendRuntimeMessage).toHaveBeenCalledTimes(savedRequests);
  });

  it('换句、收起、停用与关闭清除读音错误，旧代次AbortError不能误报当前句', async () => {
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); await step(1); await advance(0);
    late.reject(new DOMException('old sentence cancelled', 'AbortError')); await advance(0);
    expect(state.readingError).toBe(false); expect(state.readingText).toBe(`Reading: ${second}`);
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
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); const signal = annotateVideoReading.mock.calls[0][2] as AbortSignal;
    await step(1); await advance(0);
    expect(signal.aborted).toBe(true); expect(state.readingText).toBe(`Reading: ${second}`);
    late.resolve({text: '古い読み', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).toBe(`Reading: ${second}`);
    await step(-1); await advance(0); expect(state.readingText).toBe(`Reading: ${first}`);
    const afterClose = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(afterClose.promise);
    await step(1); await step(1); await flush();
    const closingSignal = annotateVideoReading.mock.calls.at(-1)![2] as AbortSignal;
    close(); expect(closingSignal.aborted).toBe(true);
    afterClose.resolve({text: '关闭后的读音', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).not.toBe('关闭后的读音');
  });

  it('收起面板取消读音，隐藏换句不发请求，展开当前句再读取；换媒体不复用旧会话缓存', async () => {
    const late = deferred<{text: string; language: string; scheme: string}>();
    annotateVideoReading.mockReturnValueOnce(late.promise);
    config.videoSubtitleAppearance.readingAnnotation = true; props.sourceLanguage = 'ja';
    await mount(); const signal = annotateVideoReading.mock.calls[0][2] as AbortSignal;
    state.expanded = false; await flush(); expect(signal.aborted).toBe(true);
    await step(1); await advance(500); expect(annotateVideoReading).toHaveBeenCalledOnce();
    late.resolve({text: '已收起的读音', language: 'ja', scheme: 'fixture'}); await advance(0);
    expect(state.readingText).toBe('');
    state.expanded = true; await advance(0); expect(state.readingText).toBe(`Reading: ${second}`);
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

  it('初次打开与自然播放跟句立即请求，并保留输入边界的浅身份', async () => {
    await mount(); expect(translate).toHaveBeenCalledOnce();
    expect(state.props.video).toBe(video); expect(state.props.cues).toBe(props.cues);
    const body = state.body as HTMLElement; body.scrollTop = 50;
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

describe('语义断句真实组件接线', () => {
  it('默认无 AI 请求；规则句内切分保留相同回放包络及当前选择', async () => {
    props.cues = [{text: 'First sentence. Second sentence!', startMs: 0, durationMs: 9000}];
    await mount(); expect(state.sentences).toHaveLength(2);
    expect(state.sentences.map((item: any) => [item.startMs, item.endMs])).toEqual([[0, 9000], [0, 9000]]);
    expect(state.index).toBe(0); video.currentTime = 4; video.dispatchEvent(new Event('timeupdate')); await flush();
    expect(state.index).toBe(0); await state.segmentCurrentGroup(); expect(sendRuntimeMessage).not.toHaveBeenCalled();
  });
  it('AI 改变 B 段边界后保留用户固定材料，不跳回正在播放的 A 段', async () => {
    config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model';
    props.cues = [{text: first, startMs: 0, durationMs: 1000}, {text: 'one two three four.', startMs: 2000, durationMs: 1000}];
    sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: ['b8', 'b19']}}));
    await mount(); state.step(1); await flush(); video.currentTime = 0;
    await state.segmentCurrentGroup(); await flush();
    expect(state.pinned).toBe(true); expect(state.sentence.text).toBe('one two ');
    expect(state.sentence.startMs).toBe(2000); expect(state.sentence.endMs).toBe(3000);
    expect(video.currentTime).toBe(0);
    expect(sendRuntimeMessage.mock.calls.filter(([message]) => message.type === 'fluentReadSegmentVideoSemantics')).toHaveLength(1);
  });
  it('错误模型边界保留规则结果并显示错误，不改写源字幕', async () => {
    config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model'; await mount();
    const original = state.sentence.text;
    sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: ['b999']}}));
    await state.segmentCurrentGroup(); await flush();
    expect(state.sentence.text).toBe(original); expect(state.error).toBe('video.learning.segmentationFailed');
    expect(props.cues[0].text).toBe(first);
  });
  it.each(['close', 'collapse', 'source', 'config'])('在 %s 时取消模型请求，迟到结果不进入界面', async mode => {
    config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model'; await mount();
    const pending = deferred<unknown>(); let id = '';
    sendRuntimeMessage.mockImplementation(message => {
      if (message.type === 'fluentReadSegmentVideoSemantics') {id = message.requestId; return pending.promise;}
      return Promise.resolve({success: true});
    });
    const request = state.segmentCurrentGroup(); await flush();
    if (mode === 'close') close();
    if (mode === 'collapse') state.expanded = false;
    if (mode === 'source') props.sourceUrl = 'https://www.youtube.com/watch?v=changed';
    if (mode === 'config') {config.videoSemanticSegmentationEnabled = false; subscription();}
    await flush(); pending.resolve({success: true, requestId: id, algorithmVersion: 2, result: {boundaries: ['b15']}}); await request; await flush();
    expect(sendRuntimeMessage.mock.calls.some(([message]) => message.type === 'fluentReadCancelVideoSemantics')).toBe(true);
    expect(state.semanticOverrides.size).toBe(0);
  });
});

it('显式点击经过真实客户端、后台边界校验和假模型，结果进入学习面板', async () => {
  const {createVideoSemanticHandlers} = await import('@/src/features/video-subtitle/background/semanticSegmentation');
  const generate = vi.fn(async (_document: {text: string}, _signal: AbortSignal) => ({boundaries: ['b8', 'b19']}));
  const handlers = createVideoSemanticHandlers({runtimeId: 'ext', privateContext: () => false,
    settings: () => ({enabled: true, revision: 'configured'}), generate});
  const sender = {id: 'ext', tab: {id: 42, incognito: false}, frameId: 0, documentId: 'test-document'};
  sendRuntimeMessage.mockImplementation(message => handlers.find(handler => handler.type === message.type)!.handle(message, {sender}));
  config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model';
  props.cues = [{text: 'one two three four.', startMs: 100, durationMs: 3000}];
  const host = await mountRendered();
  host.querySelector('[data-learning-action="segment"]')!.dispatchEvent(new document.defaultView!.Event('click'));
  await flush(); await flush();
  expect(generate).toHaveBeenCalledTimes(1); expect(generate.mock.calls[0][0].text).toBe('one two three four.');
  expect(state.sentences.map((item: any) => item.text).join('')).toBe('one two three four.');
  expect(host.querySelector('[data-learning-original]')?.textContent).toBe('one two ');
  expect(host.querySelector('[data-learning-timing-precision]')?.textContent).toBe('video.learning.cueEnvelope');
  expect(state.sentences.every((item: any) => item.startMs === 100 && item.endMs === 3100)).toBe(true);
});

it('切换同一来源 cue 内语义句不重复跳回播放起点，显式重播仍使用来源范围', async () => {
  props.cues = [{text: 'First sentence. Second sentence!', startMs: 0, durationMs: 9000}];
  await mount(); video.currentTime = 4; await step(1);
  expect(state.sentence.text).toBe('Second sentence!'); expect(video.currentTime).toBe(4);
  await state.replay(); expect(video.currentTime).toBe(0);
});

it('过期的回放组引用不会发出语义断句请求', async () => {
  config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model'; await mount();
  state.sentence.playbackGroupId = 'retired-playback-group';
  await state.segmentCurrentGroup();
  expect(sendRuntimeMessage).not.toHaveBeenCalled();
  expect(state.semanticBusy).toBe(false);
});

it.each(['unmount', 'revision'])('会话已返回但组件提交前 %s 时不接受结果', async mode => {
  config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model'; await mount();
  sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: ['b15']}}));
  const original = state.semanticSession.request.bind(state.semanticSession);
  vi.spyOn(state.semanticSession, 'request').mockImplementation(async (cues: any) => {
    const units = await original(cues);
    // 保留真实 transport、校验和会话；仅在两个异步 owner 之间制造卸载/来源更新。
    if (mode === 'unmount') close();
    else props.sourceUrl = 'https://www.youtube.com/watch?v=next-owner';
    return units;
  });
  await state.segmentCurrentGroup(); await flush();
  expect(state.semanticOverrides.size).toBe(0);
});

it('第101个片段结果淘汰最旧覆盖记录并保留当前结果', async () => {
  config.videoSemanticSegmentationEnabled = true; config.videoSemanticSegmentationService = 'openai'; config.videoSemanticSegmentationModel = 'fixture-model'; await mount();
  const entries = Array.from({length: 100}, (_, i) => [`previous-source-${i}`, []] as const);
  state.semanticOverrides = new Map(entries);
  sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: ['b15']}}));
  await state.segmentCurrentGroup(); await flush();
  expect(state.semanticOverrides.size).toBe(100);
  expect(state.semanticOverrides.has('previous-source-0')).toBe(false);
  expect(state.semanticOverrides.has('previous-source-1')).toBe(true);
  expect([...state.semanticOverrides.values()].at(-1)[0].text).toBe(first);
  expect(state.sentence.text).toBe(first);
});

function enableReadySemantics(): void {
  config.videoSemanticSegmentationEnabled = true;
  config.videoSemanticSegmentationService = 'openai';
  config.videoSemanticSegmentationModel = 'fixture-model';
}
it.each(['disabled', 'service', 'model', 'unsupported'] as const)('AI setup %s exposes a configuration route without sending material', async missing => {
  enableReadySemantics();
  if (missing === 'disabled') config.videoSemanticSegmentationEnabled = false;
  if (missing === 'service') config.videoSemanticSegmentationService = '';
  if (missing === 'model') config.videoSemanticSegmentationModel = '';
  if (missing === 'unsupported') config.videoSemanticSegmentationService = 'google';
  const host = await mountRendered();
  expect(host.querySelector('[data-learning-action="segment"]')).toBeNull();
  const setup = host.querySelector<HTMLButtonElement>('[data-learning-action="segment-configure"]')!;
  expect(setup.textContent).toContain('video.learning.configureSegmentation');
  setup.click(); await flush();
  expect(sendRuntimeMessage).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-video', target: 'video-semantic-segmentation'});
  await state.segmentCurrentGroup();
  expect(sendRuntimeMessage.mock.calls.filter(([m]) => m.type === 'fluentReadSegmentVideoSemantics')).toHaveLength(0);
});
it('AI cancellation is reachable while waiting and an old request cannot clear a new busy state', async () => {
  enableReadySemantics();
  const pending = deferred<any>(); const fresh = deferred<any>();
  let count = 0;
  sendRuntimeMessage.mockImplementation(message => message.type === 'fluentReadSegmentVideoSemantics'
    ? (++count === 1 ? pending.promise : fresh.promise) : Promise.resolve({success: true}));
  const host = await mountRendered();
  const old = state.segmentCurrentGroup(); await flush();
  expect(host.querySelector('[data-learning-semantic-status]')?.getAttribute('role')).toBe('status');
  host.querySelector<HTMLButtonElement>('[data-learning-action="segment-cancel"]')!.click();
  expect(state.semanticBusy).toBe(false);
  const next = state.segmentCurrentGroup(); await old; await flush();
  expect(state.semanticBusy).toBe(true); expect(state.error).toBe('');
  expect(host.querySelector('[data-learning-action="segment-cancel"]')).not.toBeNull();
  state.cancelSemanticRequest(); await next; await flush();
  expect(state.semanticStatus).toBe('video.learning.segmentationCancelled');
  expect(state.semanticBusy).toBe(false); expect(state.semanticOverrides.size).toBe(0);
});
it('AI timeout explains retained current segmentation and permits another attempt', async () => {
  enableReadySemantics();
  sendRuntimeMessage.mockImplementation(message => message.type === 'fluentReadSegmentVideoSemantics'
    ? new Promise(() => {}) : Promise.resolve({success: true}));
  const host = await mountRendered(); const pending = state.segmentCurrentGroup();
  await advance(30_000); await pending; await flush();
  expect(state.error).toBe('video.learning.segmentationTimeout');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('video.learning.segmentationTimeout');
  expect(host.querySelector('[data-learning-action="segment"]')?.hasAttribute('disabled')).toBe(false);
  expect(state.semanticOverrides.size).toBe(0);
});
it('unchanged AI results visibly complete and label subsequent requests as reanalysis', async () => {
  enableReadySemantics(); props.cues = [{text: first, startMs: 0, durationMs: 1000}];
  sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: [`b${first.length}`]}}));
  const host = await mountRendered(); await state.segmentCurrentGroup(); await flush();
  expect(state.semanticStatus).toBe('video.learning.segmentationUnchanged');
  expect(host.querySelector('[data-learning-action="segment"]')?.textContent).toContain('video.learning.resegment');
  expect(host.querySelector('[data-learning-semantic-status]')?.textContent).toContain('video.learning.segmentationUnchanged');
});
it('updated AI feedback survives sentence identity changes and failed reanalysis retains that result', async () => {
  enableReadySemantics(); props.cues = [{text: 'one two three four', startMs: 0, durationMs: 4000}];
  sendRuntimeMessage.mockImplementation(async message => ({success: true, requestId: message.requestId, algorithmVersion: 2, result: {boundaries: ['b8', 'b18']}}));
  const host = await mountRendered(); await state.segmentCurrentGroup(); await flush();
  expect(state.semanticStatus).toBe('video.learning.segmentationUpdated');
  expect(host.querySelector('[data-learning-semantic-status]')?.textContent).toContain('video.learning.segmentationUpdated');
  const before = state.sentences.map((s: any) => s.text);
  sendRuntimeMessage.mockResolvedValue({success: false});
  await state.segmentCurrentGroup(); await flush();
  expect(state.sentences.map((s: any) => s.text)).toEqual(before);
  expect(state.error).toBe('video.learning.segmentationFailed');
});

it('non-extension hosts expose no AI setup or request controls', async () => {
  (browserCapabilities as {extensionDom: boolean}).extensionDom = false;
  enableReadySemantics(); const host = await mountRendered();
  expect(host.querySelector('[data-learning-action="segment-configure"]')).toBeNull();
  expect(host.querySelector('[data-learning-action="segment"]')).toBeNull();
  await state.segmentCurrentGroup(); expect(sendRuntimeMessage).not.toHaveBeenCalled();
});
it('cancelling with no current source remains harmless', async () => {
  props.cues = []; await mount(); state.cancelSemanticRequest(); await flush();
  expect(state.semanticBusy).toBe(false); expect(state.semanticFeedback).toBeUndefined();
});


it.each([true, undefined])('private or unknown privacy %s explains unavailability without a request', async privacy => {
  (materialTransport.extension as {inIncognitoContext: boolean | undefined}).inIncognitoContext = privacy;
  enableReadySemantics(); const host = await mountRendered();
  expect(host.querySelector('[data-learning-action="segment"]')).toBeNull();
  expect(host.querySelector('[data-learning-action="segment-configure"]')).toBeNull();
  expect(host.querySelector('[data-learning-semantic-privacy]')?.textContent).toContain(privacy === true
    ? 'video.learning.segmentationPrivate' : 'video.learning.segmentationPrivacyUnknown');
  expect(host.querySelector('[data-learning-original]')?.textContent).toBe(first);
  await state.segmentCurrentGroup(); expect(sendRuntimeMessage).not.toHaveBeenCalled();
});
