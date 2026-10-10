import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

// DOM、指针、浏览器消息均是受控外部端口；SFC 模板与业务模块由 Vite 原样加载。
const dom = await vi.hoisted(async () => {
  const {parseHTML} = await import('linkedom');
  const page = parseHTML('<html><body></body></html>');
  Object.defineProperty(page.window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
  for (const key of ['document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (page.window as any)[key]});
  }
  const events = page.document.createElement('window-port');
  const windowPort = {innerWidth: 1000, innerHeight: 800,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events)};
  Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: windowPort});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, writable: true, value: {platform: 'Win32'}});
  Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, writable: true, value: (fn: () => void) => setTimeout(fn, 0)});
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {configurable: true, writable: true, value: clearTimeout});
  return {document: page.document, window: page.window, windowPort};
});
const ports = vi.hoisted(() => ({sendMessage: vi.fn(), domainCalls: 0, config: {on: true, selectionAreaEnabled: true, animations: true, from: 'auto', theme: 'light', floatingBallHotkey: 'custom', customFloatingBallHotkey: 'Ctrl+Shift++'}}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.sendMessage, onMessage: {addListener() {}, removeListener() {}}}}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text, t: (text: string) => text})}));
vi.mock('@/src/features/image-translation/public', () => ({prepareImageOcrLanguages: vi.fn()}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, subscribeConfig: () => () => undefined}));
vi.mock('@/src/features/full-page-translation/public', () => ({autoTranslateEnglishPage() {}, restoreOriginalContent() {}, isFullPageTranslationActive: () => false}));
vi.mock('tldts', async importOriginal => {
  const actual = await importOriginal<typeof import('tldts')>();
  return {...actual, getDomain: (...args: Parameters<typeof actual.getDomain>) => {ports.domainCalls++; return actual.getDomain(...args);}};
});

import {createApp, h, nextTick, reactive, ref, type App} from 'vue';
import FloatingBall from '@/src/features/floating-ball/ui/FloatingBall.vue';
import AreaTranslator from '@/src/features/area-translation/ui/AreaTranslator.vue';
import {canonicalizeHotkey, matchesConfiguredHotkey, normalizeHotkeyEventKey, parseHotkey} from '@/src/core/hotkey';
import {getSiteBaseDomain, isAlwaysTranslateSite, isExtensionDisabledOnSite, normalizeSiteDomains} from '@/src/core/site-rules/domain';
import {createInputTranslationContentFeature, setInputBoxText} from '@/src/features/input-translation/content';
import {replaceEditableText} from '@/src/features/input-translation/content/editableHost';
import {captureVisibleAreaInExtension, translateCapturedAreaInExtension} from '@/src/features/area-translation/services/client';
import {createContentHotkeyRuntime} from '@/src/app/content/hotkeyRuntime';
import {parseHTML} from 'linkedom';
import browser from 'webextension-polyfill';
import {createAreaTranslationOffscreenAdapter} from '@/src/features/area-translation/background/offscreenAdapter';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import type {FloatingBallPresentation} from '@/src/features/floating-ball/types';

let app: App | undefined;
const cleanup: Array<() => void> = [];
beforeEach(() => {ports.sendMessage.mockReset(); vi.stubGlobal('browser', browser); vi.useFakeTimers(); dom.document.body.replaceChildren();});
afterEach(() => {app?.unmount(); app = undefined; cleanup.splice(0).forEach(fn => fn()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();});
function event(type: string, values: Record<string, unknown> = {}) {
  const value = new dom.window.Event(type, {bubbles: true, cancelable: true});
  Object.assign(value, {pointerId: 1, pointerType: 'mouse', button: 0, clientX: 970, clientY: 400, ...values});
  return value;
}
function mountBall(clickAction?: FloatingBallPresentation['clickAction']) {
  const toggle = vi.fn(), position = vi.fn(), settings = vi.fn();
  const props = reactive({onTranslationToggle: toggle, onPositionChanged: position, onSettingsClick: settings, initialTranslating: false,
    initialTranslationStatus: 'idle' as 'idle' | 'translating' | 'translated' | 'error',
    ...(clickAction ? {presentation: {clickAction}} : {})});
  const container = dom.document.createElement('div'); dom.document.body.append(container);
  const instance = ref<{setTranslationState(value: boolean): void; setTranslationStatus(value: 'idle' | 'translating' | 'translated' | 'error'): void} | null>(null);
  app = createApp({setup: () => () => h(FloatingBall, {...props, ref: instance})}); app.directive('ui-i18n', {}); app.mount(container);
  const root = container.querySelector<HTMLElement>('.fr-floating-ball')!;
  const main = container.querySelector<HTMLElement>('.floating-ball-main')!;
  root.getBoundingClientRect = () => ({left: 950, top: 330, width: 40, height: 136}) as DOMRect;
  main.getBoundingClientRect = () => ({left: 950, top: 380, width: 40, height: 40}) as DOMRect;
  return {container, root, main, props, toggle, position, settings, instance: instance.value!};
}

describe('49A production hotkey and site boundaries', () => {
  it.each(['constructor', '__proto__'])('rejects inherited key %s through configuration and runtime entry', key => {
    expect(parseHotkey(`Ctrl+${key}`).isValid).toBe(false);
    expect(canonicalizeHotkey(`Ctrl+${key}`)).toBe('');
    expect(matchesConfiguredHotkey({key: 't', ctrlKey: true} as KeyboardEvent, 'custom', `Ctrl+${key}`)).toBe(false);
  });
  it('does not derive a key from an inherited physical-code property', () => {
    expect(normalizeHotkeyEventKey({key: 'Unidentified', code: 'constructor'})).toBe('unidentified');
  });
  it('rejects inherited configured key without throwing from the runtime matcher', () => {
    expect(() => matchesConfiguredHotkey({key: 't', ctrlKey: true} as KeyboardEvent, 'custom', 'Ctrl+constructor')).not.toThrow();
  });
  it('preserves valid aliases, printable symbols and exact modifiers', () => {
    expect(canonicalizeHotkey('Option+Shift+/')).toBe('Alt+Shift+/');
    expect(matchesConfiguredHotkey({key: '/', code: 'Slash', altKey: true, shiftKey: true} as KeyboardEvent, 'custom', 'Option+Shift+/')).toBe(true);
    expect(matchesConfiguredHotkey({key: '/', altKey: true, shiftKey: true, ctrlKey: true} as KeyboardEvent, 'custom', 'Option+Shift+/')).toBe(false);
  });
  it('parses the plus character emitted by the recorder while rejecting an unfinished modifier', () => {
    expect(canonicalizeHotkey('Ctrl+Shift++')).toBe('Ctrl+Shift++');
    expect(parseHotkey('+')).toMatchObject({key: '+', isValid: true});
    expect(parseHotkey('Ctrl+').isValid).toBe(false);
    expect(parseHotkey('Ctrl+++').isValid).toBe(false);
  });
  it('triggers the real full-page listener for the recorded plus key', () => {
    const toggle = vi.fn(); const controller = new AbortController();
    const listeners: Array<[string, EventListener]> = [];
    const add = dom.document.addEventListener.bind(dom.document);
    const spy = vi.spyOn(dom.document, 'addEventListener').mockImplementation((type, handler, options) => {listeners.push([type, handler as EventListener]); add(type, handler, options);});
    const hotkeys = createContentHotkeyRuntime(() => false, {selectionAvailable: false, toggleFullPage: toggle});
    hotkeys.installFloatingBallHotkey(controller.signal);
    try {
      const press = event('keydown', {isTrusted: true, key: '+', code: 'Equal', ctrlKey: true, shiftKey: true});
      dom.document.dispatchEvent(press); expect(toggle).toHaveBeenCalledOnce(); expect(press.defaultPrevented).toBe(true);
    } finally {controller.abort(); listeners.forEach(([type, handler]) => dom.document.removeEventListener(type, handler)); spy.mockRestore();}
  });
  it('keeps site matching equal while stopping URL parsing at the first match', () => {
    const list = ['https://news.example.com/article', ...Array.from({length: 511}, (_, i) => `https://site${i}.test/path`)];
    const probes = ['https://other.example.com', 'https://site510.test', 'https://absent.test', 'file:///tmp/file'];
    const expected = probes.map(href => normalizeSiteDomains(list).includes(getSiteBaseDomain(href) ?? ''));
    ports.domainCalls = 0;
    const started = performance.now();
    const output = probes.map(href => isExtensionDisabledOnSite(href, list));
    const sampleMs = performance.now() - started;
    expect(output).toEqual(expected);
    ports.domainCalls = 0;
    expect(isAlwaysTranslateSite(probes[0], list)).toBe(true);
    const firstMatchParseCalls = ports.domainCalls;
    const evidenceDirectory = process.env.AUDIT49A_PERFORMANCE_EVIDENCE_DIR;
    if (evidenceDirectory) {
      mkdirSync(evidenceDirectory, {recursive: true});
      writeFileSync(join(evidenceDirectory, `performance-${process.env.AUDIT49A_BASELINE === '1' ? 'old' : 'current'}.json`), JSON.stringify({inputCount: list.length, probes, output, outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'), firstMatchParseCalls, sampleMs}, null, 2));
    }
    expect(firstMatchParseCalls).toBe(2);
  });
  it('rejects non-array rules and preserves private-domain, invalid-entry and IP semantics', () => {
    expect(isAlwaysTranslateSite('https://alice.github.io', ['https://bob.github.io', null, 'https://alice.github.io'])).toBe(true);
    expect(isAlwaysTranslateSite('https://alice.github.io', ['https://bob.github.io'])).toBe(false);
    expect(isAlwaysTranslateSite('http://127.0.0.1:8000', ['127.0.0.1', 'invalid host'])).toBe(true);
    expect(isAlwaysTranslateSite('https://example.com', {})).toBe(false);
    expect(isAlwaysTranslateSite('file:///tmp/a', ['example.com'])).toBe(false);
  });
});

describe('49A real floating-ball client template', () => {
  it('仅真实成功显示勾选，加载和失败可区分且保持恢复原文入口', async () => {
    const f = mountBall();
    const button = f.container.querySelector<HTMLElement>('.floating-ball-translate')!;
    expect(f.root.dataset.translationStatus).toBe('idle');
    expect(f.container.querySelector('.check-mark')).toBeNull();
    f.props.initialTranslating = true; f.props.initialTranslationStatus = 'translating';
    await nextTick();
    expect(f.root.dataset.translationStatus).toBe('translating');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(f.container.querySelector('.translation-progress')).not.toBeNull();
    expect(f.container.querySelector('.check-mark')).toBeNull();
    f.props.initialTranslationStatus = 'error'; await nextTick();
    expect(f.root.dataset.translationStatus).toBe('error');
    expect(f.container.querySelector('.translation-error')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toContain('fullPage.progress.failuresTitle');
    expect(f.container.querySelector('.check-mark')).toBeNull();
    f.props.initialTranslationStatus = 'translated'; await nextTick();
    expect(f.root.dataset.translationStatus).toBe('translated');
    expect(f.container.querySelector('.check-mark')).not.toBeNull();
    button.dispatchEvent(event('click')); await nextTick();
    expect(f.toggle).toHaveBeenCalledWith(false);
    f.props.initialTranslating = false; await nextTick();
    expect(f.root.dataset.translationStatus).toBe('idle');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(f.container.querySelector('.check-mark')).toBeNull();
    f.instance.setTranslationState(true); f.instance.setTranslationStatus('error'); await nextTick();
    expect(f.root.dataset.translationStatus).toBe('error');
    expect(f.container.querySelector('.check-mark')).toBeNull();
    f.instance.setTranslationStatus('translated'); await nextTick();
    expect(f.container.querySelector('.check-mark')).not.toBeNull();
    f.instance.setTranslationState(false); await nextTick();
    expect(f.root.dataset.translationStatus).toBe('idle');
  });
  it('retains the first pointer when a second touch arrives', async () => {
    const f = mountBall();
    f.main.dispatchEvent(event('pointerdown', {pointerId: 1, pointerType: 'touch'}));
    f.main.dispatchEvent(event('pointerdown', {pointerId: 2, pointerType: 'touch'}));
    dom.windowPort.dispatchEvent(event('pointermove', {pointerId: 1, clientX: 20, clientY: 100}));
    await nextTick(); expect(f.root.classList.contains('dragging')).toBe(true);
    dom.windowPort.dispatchEvent(event('pointerup', {pointerId: 1, clientX: 20, clientY: 100}));
    await nextTick(); expect(f.position).toHaveBeenCalledOnce(); expect(f.position.mock.calls[0][0]).toBe('left');
    expect(f.toggle).not.toHaveBeenCalled();
  });
  it('cancels a dragged gesture on window blur and accepts the next independent click', async () => {
    const f = mountBall(); f.main.dispatchEvent(event('pointerdown'));
    dom.windowPort.dispatchEvent(event('pointermove', {clientX: 700})); await nextTick();
    expect(f.root.classList.contains('dragging')).toBe(true);
    dom.windowPort.dispatchEvent(event('blur')); await nextTick(); await nextTick();
    expect(f.root.classList.contains('dragging')).toBe(false);
    dom.windowPort.dispatchEvent(event('pointerup')); expect(f.toggle).not.toHaveBeenCalled();
    f.main.dispatchEvent(event('pointerdown')); f.main.dispatchEvent(event('pointerup'));
    expect(f.toggle).toHaveBeenCalledOnce(); expect(f.position).not.toHaveBeenCalled();
  });
  it('ignores repeated Enter while keeping independent Enter and Space actions', () => {
    const f = mountBall();
    f.main.dispatchEvent(event('keydown', {key: 'Enter', repeat: false}));
    f.main.dispatchEvent(event('keydown', {key: 'Enter', repeat: true}));
    expect(f.toggle).toHaveBeenCalledOnce();
    f.main.dispatchEvent(event('keydown', {key: ' ', repeat: false})); expect(f.toggle).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['translate', ' '], ['translate', 'Enter'], ['settings', ' '], ['settings', 'Enter'],
  ] as const)('prevents repeated activation default without repeating %s action for key %s', (action, key) => {
    const f = mountBall(action);
    expect(f.main.getAttribute('role')).toBe('button'); expect(f.main.getAttribute('tabindex')).toBe('0');
    const first = event('keydown', {key, repeat: false});
    expect(f.main.dispatchEvent(first)).toBe(false); expect(first.defaultPrevented).toBe(true);
    const repeated = event('keydown', {key, repeat: true});
    expect(repeated.cancelable).toBe(true); expect(f.main.dispatchEvent(repeated)).toBe(false);
    expect(repeated.defaultPrevented).toBe(true);
    expect(f.toggle).toHaveBeenCalledTimes(action === 'translate' ? 1 : 0);
    expect(f.settings).toHaveBeenCalledTimes(action === 'settings' ? 1 : 0);
  });
  it('does not claim unrelated keys or Enter/Space on the non-actionable image', async () => {
    const f = mountBall('translate');
    const unrelated = event('keydown', {key: 'ArrowDown', repeat: true});
    expect(f.main.dispatchEvent(unrelated)).toBe(true); expect(unrelated.defaultPrevented).toBe(false);
    f.props.presentation!.clickAction = 'none'; await nextTick();
    expect(f.main.getAttribute('role')).toBe('img'); expect(f.main.hasAttribute('tabindex')).toBe(false);
    for (const key of [' ', 'Enter']) {
      const repeated = event('keydown', {key, repeat: true});
      expect(f.main.dispatchEvent(repeated)).toBe(true); expect(repeated.defaultPrevented).toBe(false);
    }
    expect(f.toggle).not.toHaveBeenCalled(); expect(f.settings).not.toHaveBeenCalled();
  });
  it('unmount removes active pointer listeners and hover timers', async () => {
    const f = mountBall(); f.main.dispatchEvent(event('pointerdown'));
    app!.unmount(); app = undefined;
    dom.windowPort.dispatchEvent(event('pointermove', {clientX: 20})); dom.windowPort.dispatchEvent(event('pointerup'));
    await nextTick(); expect(f.toggle).not.toHaveBeenCalled(); expect(f.position).not.toHaveBeenCalled();
  });
});

function inputFeature(response: unknown) {
  const page = parseHTML('<html><body><textarea>Hello</textarea></body></html>');
  const input = page.document.querySelector('textarea')!;
  Object.defineProperty(page.document, 'activeElement', {value: input, configurable: true});
  input.getBoundingClientRect = () => ({left: 10, top: 20, width: 200, bottom: 60}) as DOMRect;
  const config = {on: true, animations: false, inputBoxTranslationTrigger: 'ctrl_enter', inputBoxTranslationTarget: 'zh-CN'};
  const send = vi.fn().mockResolvedValue(response), logger = {error: vi.fn()};
  const controller = new AbortController();
  const feature = createInputTranslationContentFeature({document: page.document as unknown as Document, context: {} as never,
    config, isSiteDisabled: () => false, readConfigGeneration: () => 0, sendMessage: send, logger,
    createUi: async (_ctx, options) => {
      const host = page.document.createElement('div'); page.document.body.append(host);
      const ui: any = {shadowHost: host, mounted: undefined, mount: () => {ui.mounted = options.onMount(host);}, remove: () => host.remove()}; return ui;
    }});
  feature.mount(controller.signal); cleanup.push(() => {controller.abort(); feature.invalidate();});
  const trigger = () => {
    const value = new page.window.Event('keydown', {bubbles: true, cancelable: true});
    Object.assign(value, {key: 'Enter', ctrlKey: true, isTrusted: true}); input.dispatchEvent(value);
  };
  return {page, input, trigger, send, logger};
}

describe('49A input production public entries', () => {
  it('does not write a stale native-control result or emit host input/change events', async () => {
    const input = dom.document.createElement('textarea'); input.value = 'user edit'; dom.document.body.append(input);
    const changed = vi.fn(); input.addEventListener('input', changed); input.addEventListener('change', changed);
    expect(await setInputBoxText(input, 'late result', () => false)).toBe(false);
    expect(input.value).toBe('user edit'); expect(changed).not.toHaveBeenCalled();
  });
  it.each([{success: true, translatedText: {text: 'bad'}}, {success: 'yes', translatedText: 'bad'}, {success: true, translatedText: '   '}])('rejects malformed runtime result %# at the mounted input feature', async response => {
    const f = inputFeature(response); f.trigger();
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledOnce());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.input.value).toBe('Hello');
    expect(f.page.document.body.textContent).toContain('翻译失败');
  });
  it('writes a valid runtime result through native value setter and host events', async () => {
    const f = inputFeature({success: true, translatedText: '你好'}); const changed = vi.fn(); f.input.addEventListener('input', changed);
    f.trigger(); await vi.waitFor(() => expect(f.input.value).toBe('你好'));
    expect(changed).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledWith({type: 'inputBoxTranslation', text: 'Hello', targetLang: 'zh-CN'});
  });
});

function editablePage(onPaste: (element: HTMLElement, selection: any) => void) {
  const page = parseHTML('<html><body><div contenteditable="true">Original</div><p>Outside</p></body></html>');
  const element = page.document.querySelector('div')! as unknown as HTMLElement;
  element.focus = () => undefined;
  const range = {startContainer: element, endContainer: element, selectNodeContents() {}, toString: () => element.textContent ?? ''};
  const selection: any = {rangeCount: 0, getRangeAt: () => range, toString: () => range.toString(), removeAllRanges() {this.rangeCount = 0;}, addRange() {this.rangeCount = 1; page.document.dispatchEvent(new page.window.Event('selectionchange'));}};
  page.document.getSelection = () => selection;
  page.document.createRange = () => range as never;
  const exec = vi.fn(() => {element.textContent = 'Native write'; return true;}); page.document.execCommand = exec;
  class Transfer {setData() {}}
  Object.assign(page.window, {DataTransfer: Transfer, ClipboardEvent: class extends page.window.Event {constructor(type: string, options: EventInit) {super(type, options);}}});
  element.addEventListener('paste', () => onPaste(element, selection));
  return {element, selection, exec, page};
}
describe('49A editable write reentrancy', () => {
  it('rechecks ownership after an unclaimed paste callback invalidates the request', async () => {
    let current = true; const f = editablePage(() => {current = false;});
    const pending = replaceEditableText(f.element, 'Translation', () => current);
    await vi.runAllTimersAsync(); expect(await pending).toBe('stale'); expect(f.exec).not.toHaveBeenCalled(); expect(f.element.textContent).toBe('Original');
  });
  it('does not execute native insertText if an unclaimed paste moves selection outside', async () => {
    const f = editablePage((_element, selection) => {selection.rangeCount = 0;});
    const pending = replaceEditableText(f.element, 'Translation', () => true);
    await vi.runAllTimersAsync(); expect(await pending).toBe('stale'); expect(f.exec).not.toHaveBeenCalled();
  });
  it('preserves the native fallback for an unchanged unclaimed paste', async () => {
    const f = editablePage(() => {}); const pending = replaceEditableText(f.element, 'Translation', () => true);
    await vi.runAllTimersAsync(); expect(await pending).toBe('replaced'); expect(f.exec).toHaveBeenCalledWith('insertText', false, 'Translation');
  });
});

describe('49A capture response contract', () => {
  it.each([{success: true, image: {}}, {success: 'yes', image: 'data:image/png,x'}, {success: true, image: 'not-an-image'}])('rejects malformed capture response %#', async response => {
    ports.sendMessage.mockResolvedValue(response); await expect(captureVisibleAreaInExtension()).rejects.toThrow('无法读取当前页面区域');
  });
  it('keeps the valid screenshot string unchanged', async () => {
    ports.sendMessage.mockResolvedValue({success: true, image: 'data:image/png;base64,AQID'});
    await expect(captureVisibleAreaInExtension()).resolves.toBe('data:image/png;base64,AQID');
  });
  const selection = {left: 0, top: 0, width: 100, height: 100, viewportWidth: 100, viewportHeight: 100};
  const translated = {image: 'data:image/png,x', service: 'google', serviceName: 'Google', model: '', lines: [], sourceText: 'Hello', translatedText: '你好', mode: 'standard', warnings: ['standard-quality']};
  it('rejects a truthy non-boolean success at the cancellable translation public entry', async () => {
    ports.sendMessage.mockResolvedValue({success: 'yes', ...translated});
    await expect(translateCapturedAreaInExtension('data:image/png,x', selection, 'en', 'fixture')).rejects.toThrow('圈选翻译服务不可用');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the complete valid translation result and cleans the request timer', async () => {
    ports.sendMessage.mockResolvedValue({success: true, ...translated});
    await expect(translateCapturedAreaInExtension('data:image/png,x', selection, 'en', 'fixture')).resolves.toEqual(translated);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cropArea', 'translateArea'] as const)('rejects truthy non-boolean offscreen status through %s', async method => {
    const send = vi.fn().mockResolvedValue({success: 'yes', image: 'data:image/png,x', lines: []});
    const adapter = createAreaTranslationOffscreenAdapter({send} as unknown as OffscreenClient);
    const result = method === 'cropArea' ? adapter.cropArea('data:image/png,x', selection)
      : adapter.translateArea('data:image/png,x', 'en', 'fixture', selection);
    await expect(result).rejects.toThrow(method === 'cropArea' ? '圈选裁剪失败' : '圈选翻译失败');
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('49A real area client settings lifetime', () => {
  it('does not schedule feedback after an outstanding settings request rejects after unmount', async () => {
    let rejectSettings!: (error: Error) => void;
    ports.sendMessage.mockImplementation(message => message.type === 'fluentReadAreaCapture'
      ? Promise.resolve({success: true, image: 'data:image/png,x'})
      : message.type === 'openOptionsPage' ? new Promise((_resolve, reject) => {rejectSettings = reject;})
        : Promise.resolve({success: false, error: 'controlled OCR failure'}));
    const container = dom.document.createElement('div'); dom.document.body.append(container);
    app = createApp(AreaTranslator); app.directive('ui-i18n', {});
    const vm = app.mount(container) as unknown as {beginSelection(): boolean};
    expect(vm.beginSelection()).toBe(true); await nextTick();
    dom.document.dispatchEvent(event('pointerdown', {isTrusted: true, clientX: 10, clientY: 20}));
    dom.document.dispatchEvent(event('pointerup', {isTrusted: true, clientX: 160, clientY: 120}));
    await vi.runAllTimersAsync(); await nextTick();
    expect(container.querySelector('.fr-area-error-body')?.textContent).toContain('controlled OCR failure');
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === '圈选设置')!;
    button.dispatchEvent(event('click')); expect(rejectSettings).toBeTypeOf('function');
    app.unmount(); app = undefined; rejectSettings(new Error('late settings failure'));
    await Promise.resolve(); await nextTick();
    expect(vi.getTimerCount()).toBe(0); expect(container.childNodes.length).toBe(0);
  });
});
