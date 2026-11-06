/**
 * @file tests/popupKeyInformation.test.ts
 * 文件职责：执行真实 Popup 客户端模板，验证首页默认服务、配置模型与原有抽屉入口。
 * 主要内容：覆盖模型能力、请求体覆盖、自定义接口、外部同步、中英文无障碍名称，以及模块排序、PDF 主入口与迟到标签页查询的模板边界；全局字体真值来自配置，页面状态读取失败或关闭后的迟到响应不能覆盖偏好。
 * 模块边界：浏览器、配置存储和展示组件为受控端口；不读取源码私有状态，不将 DOM 测试视为真实几何或在线服务证明。
 */
import * as runtime from 'vue';
import PopupApp from '@/src/app/popup/PopupApp.vue';
import {parseHTML} from 'linkedom';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {App, Plugin} from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {customModelString} from '@/src/core/config/catalog';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import {translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import type {PopupActiveTab} from '@/src/app/popup/pageActions';

const language = runtime.ref<UiLanguage>('zh-CN');
const bundleRevision = runtime.ref(0);
const config = new Config();
const listeners = new Set<(value: Config) => void>();
const patches = vi.fn(), openOptions = vi.fn(), createTab = vi.fn();
const queryTabs = vi.fn<() => Promise<PopupActiveTab[]>>();
const send = vi.fn<(id: number, message: {type: string; action?: string}) => Promise<unknown>>();
const tabUpdated = new Set<(id: number, change: {url?: string; status?: string}, tab: PopupActiveTab & {active?: boolean}) => void>();
let app: App | undefined, document: Document;
let window: ReturnType<typeof parseHTML>['window'];

async function settle() {for (let index = 0; index < 12; index++) {await Promise.resolve();await runtime.nextTick();}}
function publish(update: (draft: Config) => void) {
  const next = normalizeConfig(config);
  update(next);
  Object.assign(config, next);
  for (const listener of listeners) listener(next);
}
function summary() {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="popup-feature-services"]');
  expect(button).not.toBeNull();
  return button!;
}
function model() {return summary().querySelector('.provider-summary-model');}

beforeAll(() => {registerAllUiLanguageBundles();});
vi.mock('vue', async importOriginal => {
  const actual = await importOriginal<typeof import('vue')>();
  return {...actual, Transition: actual.defineComponent({setup: (_, {slots}) => () => slots.default?.()})};
});
vi.mock('webextension-polyfill', () => {
  const event = {addListener() {}, removeListener() {}};
  return {default: {tabs: {query: () => queryTabs(), sendMessage: (...args: Parameters<typeof send>) => send(...args),
    create: (...args: unknown[]) => createTab(...args), onUpdated: {addListener: (fn: any) => tabUpdated.add(fn), removeListener: (fn: any) => tabUpdated.delete(fn)},
    onActivated: event, onRemoved: event}, runtime: {id: 'fixture-extension', onMessage: event, getManifest: () => ({version: '0.0.35'}),
      getURL: (path: string) => 'extension://' + path, sendMessage: async () => ({success: true}), openOptionsPage: () => openOptions()}}};
});
vi.mock('@/src/services/config/store', () => ({get config() {return config;}, configReady: Promise.resolve(),
  subscribeConfig: (fn: (value: Config) => void) => {listeners.add(fn);return () => listeners.delete(fn);},
  requestConfigPatch: async (value: unknown) => patches(value), handoffPendingConfigPatches: async () => {}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language, bundleRevision,
  t: (key: string, params?: Parameters<typeof translate>[2]) => translate(key, language.value, params),
  translateLegacy: (text: string) => translateLegacyText(text, language.value)})}));
vi.mock('@/src/ui/interfaceAppearance', () => ({applyInterfaceFont() {}, applyInterfaceSkin() {}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {browser: 'chrome', areaTranslation: true, imageTranslation: true}}));
vi.mock('@element-plus/icons-vue', () => ({Setting: {render: () => null}}));
vi.mock('element-plus/es/components/tooltip/index', () => ({ElTooltip: {inheritAttrs: false,
  setup(_: unknown, {slots, expose}: any) {expose({onClose() {}, hide() {}});return () => slots.default?.();}}}));
vi.mock('@/src/app/popup/PopupDrawer', () => ({__esModule: true, default: {setup(_: unknown, {attrs, slots}: any) {
  return () => attrs.modelValue || attrs['model-value'] ? runtime.h('div', {class: 'drawer-port'}, slots.default?.()) : null;}}}));
vi.mock('@/src/app/popup/PopupServices.vue', () => ({__esModule: true, default: {emits: ['close'], setup(_: unknown, {emit}: any) {
  return () => runtime.h('button', {class: 'service-panel-close', onClick: () => emit('close')}, 'Close');}}}));

beforeEach(() => {
  vi.clearAllMocks();listeners.clear();tabUpdated.clear();language.value = 'zh-CN';bundleRevision.value = 0;
  queryTabs.mockReset().mockResolvedValue([{id: 7, windowId: 3, url: 'https://example.test/a'}]);
  send.mockReset().mockImplementation(async (_id, message) => {
    return message.type === 'getFullPageTranslationState'
      ? {isTranslated: false} : {status: 'success', isTranslated: message.action === 'fullPage'};
  });
  Object.assign(config, normalizeConfig({...new Config(), uiLanguageSetupCompleted: true, on: true,
    service: 'openai', model: {...new Config().model, openai: 'saved-model'}, token: {openai: 'test-only-key'}}));
  const dom = parseHTML('<html><body><div id="app"></div></body></html>');
  document = dom.document;window = dom.window;
  vi.stubGlobal('matchMedia', () => ({matches: false, onchange: null}));
  vi.stubGlobal('close', vi.fn());
  for (const [name, value] of Object.entries({document, window, HTMLElement: window.HTMLElement, Event: window.Event,
    Node: window.Node, MutationObserver: window.MutationObserver, NodeFilter: {SHOW_TEXT: 4}, navigator: {languages: ['zh-CN'], platform: 'Win32'}})) vi.stubGlobal(name, value);
});

afterEach(async () => {app?.unmount();app = undefined;await settle();});
afterAll(() => {vi.unstubAllGlobals();});

async function mount(plugin?: Plugin) {
  const renderer = runtime.createRenderer<Node, HTMLElement>({
    patchProp(node, key, previous, value) {
      if (/^on[A-Z]/u.test(key)) {
        const event = key.slice(2).toLowerCase();
        if (previous) node.removeEventListener(event, previous);
        if (value) node.addEventListener(event, value);
      } else if (value == null || (value === false && !/^(?:aria-|data-)/u.test(key))) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.parentNode?.removeChild(node),
    createElement: tag => runtime.markRaw(document.createElement(tag)), createText: text => document.createTextNode(text),
    createComment: text => document.createComment(text), setText: (node, text) => {node.nodeValue = text;},
    setElementText: (node, text) => {node.textContent = text;}, parentNode: node => node.parentNode as HTMLElement | null,
    nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
    insertStaticContent: (content, parent, anchor) => {
      const template = document.createElement('template');template.innerHTML = content;
      const first = template.content.firstChild!, last = template.content.lastChild!;
      parent.insertBefore(template.content, anchor || null);return [first, last];
    },
  });
  app = renderer.createApp(PopupApp);
  if (plugin) app.use(plugin);
  app.config.warnHandler = () => undefined;
  app.mount(document.getElementById('app')!);
  await settle();
}

describe('Popup 首页关键信息', () => {
  it('无论是否已有翻译记录，首页都不占用一行展示首次提示', async () => {
    config.count = 0;const before = {service: config.service, from: config.from, to: config.to, model: config.model.openai};
    await mount();expect(document.querySelector('[data-testid="first-translation-hint"]')).toBeNull();
    publish(next => {next.count = 20});await settle();
    expect(document.querySelector('[data-testid="first-translation-hint"]')).toBeNull();
    expect({service: config.service, from: config.from, to: config.to, model: config.model.openai}).toEqual(before);
    expect(patches).not.toHaveBeenCalled();
  });
  it.each([['zh-CN', '打开 PDF 阅读器'], ['en-US', 'Open PDF reader']] as const)('%s PDF 主入口保留服务摘要并只打开携带原文地址的阅读器', async (locale, label) => {
    language.value = locale;
    queryTabs.mockResolvedValue([{id: 7, windowId: 3, url: 'https://example.test/docs/research.pdf?edition=2#page=5'}]);
    const before = JSON.stringify(config);
    await mount();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="page-translation"]')!;
    expect(summary().querySelector('strong')?.textContent).toBe('OpenAI');
    expect(model()?.textContent).toBe('saved-model');
    expect(summary().getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.querySelector('.translate-label')?.textContent).toBe(label);
    expect(button.getAttribute('title')).toBe(label);
    expect(button.querySelector('kbd, .translate-hotkey')).toBeNull();
    expect(button.getAttribute('title')).not.toMatch(/Alt\+T|⌥\+T/u);
    expect(document.querySelector('[data-testid="section-translation"]')).toBeNull();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(send).not.toHaveBeenCalled();

    button.dispatchEvent(new window.Event('click'));await settle();
    expect(createTab.mock.calls).toEqual([[{url: 'extension://document.html#pdf=https%3A%2F%2Fexample.test%2Fdocs%2Fresearch.pdf%3Fedition%3D2'}]]);
    expect(send).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(JSON.stringify(config)).toBe(before);expect(patches).not.toHaveBeenCalled();
  });

  it.each([
    ['Win32', 'Alt+T', 'Ctrl+Alt+Shift+Arrowright'],
    ['MacIntel', '⌥+T', '⌃+⌥+⇧+Arrowright'],
  ] as const)('%s PDF 导航回普通页恢复紧凑主按钮与快捷键，旧 PDF 查询晚到不改写模板或创建阅读器', async (platform, shortcut, longShortcut) => {
    vi.stubGlobal('navigator', {languages: ['en-US'], platform});
    language.value = 'en-US';
    config.browserDefaultTranslationFont = true;
    queryTabs.mockResolvedValue([{id: 7, windowId: 3, url: 'https://example.test/first.pdf'}]);
    await mount();
    expect(document.querySelector('.translate-label')?.textContent).toBe('Open PDF reader');
    expect(document.querySelector('[data-testid="page-font-entry"]')).toBeNull();
    expect(config.browserDefaultTranslationFont).toBe(true);
    expect(tabUpdated.size).toBe(1);

    let resolveOld!: (tabs: PopupActiveTab[]) => void;
    queryTabs.mockReturnValueOnce(new Promise(resolve => {resolveOld = resolve;}));
    const latePdf = {id: 7, windowId: 3, active: true, url: 'https://example.test/late.pdf'};
    for (const listener of tabUpdated) listener(7, {url: latePdf.url}, latePdf);
    const article = {id: 7, windowId: 3, active: true, url: 'https://example.test/article'};
    queryTabs.mockResolvedValue([article]);
    for (const listener of tabUpdated) listener(7, {url: article.url}, article);
    await settle();

    const button = document.querySelector<HTMLButtonElement>('[data-testid="page-translation"]')!;
    expect(button.querySelector('.translate-label')?.textContent).toBe(`Translate (${shortcut})`);
    expect(button.querySelector('kbd, .translate-hotkey')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Translate this page');
    expect(document.querySelector('[data-testid="section-translation"]')).not.toBeNull();
    expect(summary().querySelector('strong')?.textContent).toBe('OpenAI');
    expect(model()?.textContent).toBe('saved-model');
    resolveOld([latePdf]);await settle();
    expect(button.getAttribute('title')).toBe(`Translate this page · ${shortcut}`);
    expect(button.querySelector('.translate-label')?.textContent).toBe(`Translate (${shortcut})`);
    expect(document.querySelector('[data-testid="section-translation"]')).not.toBeNull();
    expect(createTab).not.toHaveBeenCalled();
    const articleReads = [[7, {type: 'getFullPageTranslationState'}, {frameId: 0}]];
    expect(send.mock.calls).toEqual(articleReads);
    const font = document.querySelector('[data-testid="page-font-entry"]')!;
    expect(font.getAttribute('aria-pressed')).toBe('true');
    expect(font.getAttribute('data-font-state')).toBe('browser-default');
    expect(font.querySelector('svg')?.getAttribute('data-font-style')).toBe('sans');
    expect(config.browserDefaultTranslationFont).toBe(true);

    button.dispatchEvent(new window.Event('click'));await settle();
    expect(createTab).not.toHaveBeenCalled();
    expect(send.mock.calls).toEqual([...articleReads, [7, {type: 'contextMenuTranslate', action: 'fullPage'}, {frameId: 0}]]);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('.translate-label')?.textContent).toBe(`Restore (${shortcut})`);
    expect(button.getAttribute('title')).toBe(`Restore this page · ${shortcut}`);
    publish(next => {next.floatingBallHotkey = 'custom';next.customFloatingBallHotkey = 'Control+Alt+Shift+ArrowRight';next.browserDefaultTranslationFont = false;});await settle();
    expect(button.querySelector('.translate-label')?.textContent).toBe('Restore');
    expect(button.getAttribute('title')).toBe(`Restore this page · ${longShortcut}`);
    expect(button.querySelector('kbd, .translate-hotkey')).toBeNull();
    expect(font.getAttribute('aria-pressed')).toBe('false');
    expect(font.getAttribute('data-font-state')).toBe('host');
    expect(font.querySelector('svg')?.getAttribute('data-font-style')).toBe('serif');
    expect(send.mock.calls).toEqual([...articleReads, [7, {type: 'contextMenuTranslate', action: 'fullPage'}, {frameId: 0}]]);
    expect(model()?.textContent).toBe('saved-model');expect(patches).not.toHaveBeenCalled();
  });

  it('当前网页状态读取失败仍按全局配置显示字体，外部偏好更新不依赖页内字体查询', async () => {
    config.browserDefaultTranslationFont = true;
    send.mockRejectedValueOnce(new Error('The content frame was removed'));
    await mount();
    const font = document.querySelector('[data-testid="page-font-entry"]')!;
    const main = document.querySelector('[data-testid="page-translation"]')!;
    expect(main.getAttribute('aria-pressed')).toBe('false');
    expect(font.getAttribute('aria-pressed')).toBe('true');
    expect(font.getAttribute('data-font-state')).toBe('browser-default');
    expect(font.hasAttribute('disabled')).toBe(false);
    publish(next => {next.browserDefaultTranslationFont = false;});await settle();
    expect(font.getAttribute('aria-pressed')).toBe('false');
    expect(font.getAttribute('data-font-state')).toBe('host');
    expect(font.getAttribute('aria-description')).toBeNull();
    expect(document.querySelector('[data-testid="page-font-error"]')).toBeNull();
    expect(send.mock.calls).toEqual([[7, {type: 'getFullPageTranslationState'}, {frameId: 0}]]);
    expect(patches).not.toHaveBeenCalled();
  });

  it('读取网页状态期间快速关闭后迟到回复不改字体或翻译状态，恢复弹窗仍读取已保存的全局偏好', async () => {
    config.browserDefaultTranslationFont = true;
    let resolveState!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => {resolveState = resolve;}));
    await mount();
    const font = document.querySelector('[data-testid="page-font-entry"]')!;
    const main = document.querySelector('[data-testid="page-translation"]')!;
    expect(font.getAttribute('aria-pressed')).toBe('true');
    window.dispatchEvent(new window.Event('pagehide'));await settle();
    resolveState({isTranslated: true});await settle();
    expect(main.getAttribute('aria-pressed')).toBe('false');
    expect(font.getAttribute('aria-pressed')).toBe('true');
    expect(font.hasAttribute('disabled')).toBe(true);
    expect(config.browserDefaultTranslationFont).toBe(true);
    expect(patches).toHaveBeenCalledOnce();
    expect(patches).toHaveBeenLastCalledWith(expect.objectContaining({browserDefaultTranslationFont: true}));
    window.dispatchEvent(new window.Event('pageshow'));await settle();
    const reopenedFont = document.querySelector('[data-testid="page-font-entry"]')!;
    expect(reopenedFont.getAttribute('aria-pressed')).toBe('true');
    expect(reopenedFont.getAttribute('data-font-state')).toBe('browser-default');
    expect(reopenedFont.hasAttribute('disabled')).toBe(false);
    expect(send.mock.calls).toEqual([
      [7, {type: 'getFullPageTranslationState'}, {frameId: 0}],
      [7, {type: 'getFullPageTranslationState'}, {frameId: 0}],
    ]);
    expect(patches).toHaveBeenCalledOnce();
  });

  it('首页直接显示网页默认服务和配置模型，完整信息进入无障碍名称', async () => {
    await mount();
    const main = document.querySelector<HTMLButtonElement>('[data-testid="page-translation"]')!;
    expect(main.querySelector('.translate-label')?.textContent).toBe('翻译（Alt+T）');
    expect(main.getAttribute('title')).toBe('翻译当前网页 · Alt+T');
    expect(main.getAttribute('aria-label')).toBe('翻译当前网页');
    expect(main.querySelector('kbd, .translate-hotkey')).toBeNull();
    expect([...document.querySelectorAll('.translate-action > button')].map(button => button.getAttribute('data-testid')))
      .toEqual(['page-translation', 'section-translation']);
    expect(summary().querySelector('strong')?.textContent).toBe('OpenAI');
    expect(model()?.textContent).toBe('saved-model');
    expect(model()?.getAttribute('title')).toBe('配置模型：saved-model');
    expect(summary().getAttribute('aria-label')).toBe('按功能选择服务 · 网页默认服务 · OpenAI · 配置模型：saved-model');
    expect(summary().getAttribute('aria-haspopup')).toBe('dialog');
    expect(patches).not.toHaveBeenCalled();
  });

  it('自定义模型仍标为配置模型，请求体覆盖不被误报为最终模型', async () => {
    config.model.openai = customModelString;config.customModel.openai = 'custom/active';
    config.customBody.openai = '{"model":"body-override"}';
    const before = JSON.stringify(config);
    await mount();
    expect(model()?.textContent).toBe('custom/active');
    expect(summary().getAttribute('title')).toContain('custom/active');
    expect(summary().textContent).not.toContain('body-override');
    expect(summary().textContent).not.toContain('当前模型');
    expect(JSON.stringify(config)).toBe(before);expect(patches).not.toHaveBeenCalled();
  });

  it('自定义接口显示保存名称及模型，缺省模型沿用已有首个模型回退', async () => {
    config.service = 'custom:private';
    config.customOpenAIProviders = [{id: 'custom:private', name: 'Private endpoint', endpoint: 'https://example.test/v1', models: ['private-first', 'private-second']}];
    await mount();
    expect(summary().querySelector('strong')?.textContent).toBe('Private endpoint');
    expect(model()?.textContent).toBe('private-first');
    publish(next => {next.model['custom:private'] = 'private-second';});await settle();
    expect(model()?.textContent).toBe('private-second');
  });

  it.each(['google', 'microsoft', 'deepL', 'freeTranslation'])('%s 不显示遗留的 AI 模型，外部切回模型服务恢复摘要', async service => {
    await mount();
    publish(next => {next.service = service;next.model[service] = 'stale-ai-model';});await settle();
    expect(model()).toBeNull();expect(summary().textContent).not.toContain('stale-ai-model');
    expect(summary().getAttribute('aria-label')).not.toContain('配置模型');
    publish(next => {next.service = 'openai';next.model.openai = 'next-model';});await settle();
    expect(model()?.textContent).toBe('next-model');
  });

  it('本地模型服务支持配置模型，显示本地选择而非上一项 AI 模型', async () => {
    config.service = 'localTranslation';config.model.localTranslation = LOCAL_TRANSLATION_MODEL_IDS.hunyuan;
    await mount();
    expect(model()?.textContent).toBe(LOCAL_TRANSLATION_MODEL_IDS.hunyuan);
    expect(summary().textContent).not.toContain('saved-model');
    publish(next => {next.model.localTranslation = LOCAL_TRANSLATION_MODEL_IDS.opusJaEn;});await settle();
    expect(model()?.textContent).toBe(LOCAL_TRANSLATION_MODEL_IDS.opusJaEn);
  });

  it('翻译专用模型不支持 AI 上下文时，仍展示其适用配置模型', async () => {
    config.service = 'tongyi';config.model.tongyi = 'qwen-mt-turbo';config.token.tongyi = 'test-only-key';
    await mount();expect(model()?.textContent).toBe('qwen-mt-turbo');
  });

  it('英文摘要和外部语言同步使用现有配置模型文案', async () => {
    language.value = 'en-US';await mount();
    expect(model()?.textContent).toBe('saved-model');
    expect(model()?.getAttribute('title')).toBe('Configured model: saved-model');
    expect(summary().getAttribute('aria-label')).toBe('Services by feature · Default page service · OpenAI · Configured model: saved-model');
    language.value = 'zh-CN';await settle();expect(model()?.getAttribute('title')).toBe('配置模型：saved-model');
  });

  it('多个功能服务仍只展示网页默认服务，其余分配保留在完整提示中', async () => {
    config.hoverTranslationService = 'deepseek';config.selectionTranslationService = 'google';config.documentService = 'google';
    config.quickTranslationProfiles = [];
    await mount();
    expect(summary().querySelectorAll('.provider-avatar')).toHaveLength(1);
    expect(summary().querySelector('.provider-overflow')).toBeNull();
    expect(summary().querySelector('strong')?.textContent).toBe('OpenAI');
    expect(summary().getAttribute('title')).toContain('DeepSeek');
    expect(model()?.textContent).toBe('saved-model');
  });

  it('长自定义名称和模型保留完整文本和完整无障碍信息', async () => {
    const name = 'Private endpoint with a deliberately long descriptive name';
    const saved = 'organization/very-long-configured-model-name-with-variant-and-version';
    config.service = 'custom:private';config.customOpenAIProviders = [{id: 'custom:private', name, endpoint: 'https://example.test/v1', models: [saved]}];
    config.model['custom:private'] = saved;
    await mount();
    expect(summary().querySelector('strong')?.textContent).toBe(name);expect(model()?.textContent).toBe(saved);
    expect(model()?.getAttribute('title')).toBe(`配置模型：${saved}`);
    expect(summary().getAttribute('aria-label')).toContain(`${name} · 配置模型：${saved}`);
  });

  it('自定义服务名称属于保存内容，不被内置服务的旧 UI 词典转换', async () => {
    language.value = 'en-US';config.service = 'custom:private';
    config.customOpenAIProviders = [{id: 'custom:private', name: '文', endpoint: 'https://example.test/v1', models: ['saved-model']}];
    await mount();
    // 真资源中“文”用于另一个 UI 缩写；名称不能借用它的英文 D。
    expect(translateLegacyText('文', 'en-US')).not.toBe('文');
    expect(summary().querySelector('strong')?.textContent).toBe('文');
    expect(summary().getAttribute('aria-label')).toContain(' · 文 · ');
  });

  it('真实英文 document observer 本地化 UI，同时保留摘要中用户的名称和模型', async () => {
    language.value = 'en-US';config.uiLanguage = 'en-US';config.service = 'custom:private';
    config.customOpenAIProviders = [{id: 'custom:private', name: '文', endpoint: 'https://example.test/v1', models: ['文']}];
    config.model['custom:private'] = '文';
    const before = JSON.stringify(config);
    // 使用实际 i18n 插件和资源，只替换它的配置/浏览器/语言资源加载端口。
    vi.doMock('@/src/services/config/store', () => ({config, configReady: Promise.resolve(), getConfigRevision: () => 0,
      subscribeConfig: (listener: (value: Config) => void) => {listeners.add(listener);return () => listeners.delete(listener);},
      requestConfigPatch: patches}));
    vi.doMock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn()}}}));
    vi.doMock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: async () => true}));
    try {
      const {createUiI18nPlugin} = await vi.importActual<typeof import('@/src/ui/i18n')>('@/src/ui/i18n');
      await mount(createUiI18nPlugin({documentRoot: document.body}));
      // 固定旧中文按钮确实被 observer 转换，不能靠 scanner 没执行掩盖正文污染。
      await vi.waitFor(() => expect(document.querySelector('.settings-button > span')?.textContent).toBe('Settings'));
      expect(model()?.textContent).toBe('文');
      expect(summary().querySelector('strong')?.textContent).toBe('文');
      expect(model()?.getAttribute('title')).toBe('Configured model: 文');
      expect(summary().getAttribute('aria-label')).toContain(' · 文 · Configured model: 文');
      expect(JSON.stringify(config)).toBe(before);expect(patches).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/src/services/config/store');vi.doUnmock('webextension-polyfill');vi.doUnmock('@/src/platform/i18n/uiLanguageBundles');
    }
  });

  it('凭据提醒仍保留提醒内容和当前服务设置入口', async () => {
    config.token.openai = '';config.apiKeys.openai = [];
    await mount();
    const warning = document.querySelector('.credential-warning[role="alert"]');expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('配置提醒');
    warning!.querySelector('button')!.dispatchEvent(new window.Event('click'));await settle();
    expect(createTab).toHaveBeenCalledWith({url: 'extension://options.html?service=openai&returnTabId=7#settings-services'});
  });

  it('摘要沿用同一个服务抽屉入口，浏览不会改配置', async () => {
    await mount();const before = JSON.stringify(config);
    summary().dispatchEvent(new window.Event('click'));await settle();
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    for (let attempt = 0; attempt < 50 && !document.querySelector('.service-panel-close'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2));await settle();
    }
    const close = document.querySelector('.service-panel-close');expect(close).not.toBeNull();
    close!.dispatchEvent(new window.Event('click'));await settle();
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(JSON.stringify(config)).toBe(before);expect(patches).not.toHaveBeenCalled();
  });

  it('模块排序与隐藏保留原有站点规则相邻嵌套边界', async () => {
    config.popupModuleOrder = ['quickFeatures', 'footer', 'translation', 'siteRule'];
    config.interfaceVisibility.popupQuickFeatures = false;config.interfaceVisibility.popupFooter = false;
    await mount();
    const order = () => [...document.querySelectorAll('[data-popup-module]')].map(node => node.getAttribute('data-popup-module'));
    expect(order()).toEqual(['translation', 'siteRule']);
    expect(document.querySelector('[data-popup-module="siteRule"]')?.closest('.hero-card')).not.toBeNull();
    publish(next => {next.popupModuleOrder = ['siteRule', 'translation', 'quickFeatures', 'footer'];next.interfaceVisibility.popupQuickFeatures = true;next.interfaceVisibility.popupFooter = true;});
    await settle();expect(order()).toEqual(['siteRule', 'translation', 'quickFeatures', 'footer']);
    expect(document.querySelector('[data-popup-module="siteRule"]')?.closest('.hero-card')).toBeNull();
    expect(document.querySelectorAll('[data-testid="page-translation"]')).toHaveLength(1);
  });
});

vi.mock('@/src/app/popup/PopupLanguageSelect.vue', () => ({default: {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('div', attrs, slots.default?.());}}}));

vi.mock('@/src/features/self-help/ui/DiagnosticNotice.vue', () => ({default: {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('div', attrs, slots.default?.());}}}));

vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('div', attrs, slots.default?.());}}}));

vi.mock('@/src/ui/components/UiLanguageOnboarding.vue', () => ({default: {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('div', attrs, slots.default?.());}}}));
