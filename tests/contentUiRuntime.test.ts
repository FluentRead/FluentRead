import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
  subscribeMangaTranslation: vi.fn(),
  showPageNotice: vi.fn(),
  dismissPageNotice: vi.fn(),
  openMangaEntry: vi.fn(),
  unsubscribeMangaTranslation: vi.fn(),
  config: {
    on: true,
    disableFloatingBall: false,
    floatingBallPosition: '' as '' | 'left' | 'right',
    floatingBallVerticalPosition: null as number | null,
    floatingBallToolsDisplay: 'hover',
    floatingBallHoverDelay: 0,
    floatingBallClickAction: 'translate',
    floatingBallCompact: false,
    floatingBallSettingsEntryVisible: true,
    floatingBallCollapsedOpacity: 52,
    floatingBallDisabledDomains: [] as string[],
    translationProgressPanelEnabled: true,
  },
  createVueShadowUi: vi.fn(),
  createAnchoredPopup: vi.fn(),
  togglePopup: vi.fn(),
  closePopup: vi.fn(),
  requestConfigPatch: vi.fn(),
  getURL: vi.fn(),
  subscribeConfig: vi.fn(),
  unsubscribeConfig: vi.fn(),
  sendMessage: vi.fn(),
  autoTranslateEnglishPage: vi.fn(),
  isFullPageTranslationActive: vi.fn(),
  getTranslationToolbarStatus: vi.fn(),
  subscribeTranslationToolbarStatus: vi.fn(),
  unsubscribeTranslationToolbarStatus: vi.fn(),
  restoreOriginalContent: vi.fn(),
  subscribeFullPageTranslationProgress: vi.fn(),
  unsubscribeFullPageTranslationProgress: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({
  config: mocks.config,
  requestConfigPatch: mocks.requestConfigPatch,
  subscribeConfig: mocks.subscribeConfig,
}));
vi.mock('@/src/features/floating-ball/content/anchoredPopup', () => ({createAnchoredPopup: mocks.createAnchoredPopup}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.createVueShadowUi}));
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      getURL: mocks.getURL,
      sendMessage: mocks.sendMessage,
    },
  },
}));
vi.mock('@/src/features/full-page-translation/public', () => ({
  autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
  isFullPageTranslationActive: mocks.isFullPageTranslationActive,
  getTranslationToolbarStatus: mocks.getTranslationToolbarStatus,
  subscribeTranslationToolbarStatus: mocks.subscribeTranslationToolbarStatus,
  restoreOriginalContent: mocks.restoreOriginalContent,
  subscribeFullPageTranslationProgress: mocks.subscribeFullPageTranslationProgress,
}));
vi.mock('@/src/features/image-translation/public', () => ({subscribeMangaTranslation: mocks.subscribeMangaTranslation, openMangaEntry: mocks.openMangaEntry}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice:mocks.showPageNotice,dismissPageNotice:mocks.dismissPageNotice}));
vi.mock('@/src/features/floating-ball/ui/FloatingBall.vue', () => ({default: {name: 'FloatingBall'}}));
vi.mock('@/src/features/full-page-translation/ui/TranslationProgressPanel.vue', () => ({
  default: {name: 'TranslationProgressPanel'},
}));

interface MockUi {
  mounted?: {instance?: unknown};
  remove: ReturnType<typeof vi.fn>;
  shadowHost: HTMLElement;
  uiContainer: HTMLElement;
}

function ui(instance: unknown = {mounted: true}): MockUi {
  const shadowHost = document.createElement('div');
  document.documentElement.append(shadowHost);
  return {
    mounted: {instance},
    remove: vi.fn(() => shadowHost.remove()),
    shadowHost,
    uiContainer: document.createElement('body'),
  };
}

function pendingUi(): {promise: Promise<MockUi>; resolve: (value: MockUi) => void; reject: (error: unknown) => void} {
  let resolve!: (value: MockUi) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<MockUi>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve,
    reject,
  };
}

beforeEach(() => {
  vi.stubEnv('BROWSER', 'chrome');
  const parsed = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', parsed.window);
  vi.stubGlobal('document', parsed.document);
  vi.stubGlobal('Event', parsed.window.Event);
  vi.stubGlobal('HTMLElement', parsed.window.HTMLElement);
  vi.resetModules();
  Object.assign(mocks.config, {
    on: true,
    disableFloatingBall: false,
    floatingBallPosition: '',
    floatingBallVerticalPosition: null,
    floatingBallToolsDisplay: 'hover',
    floatingBallHoverDelay: 0,
    floatingBallClickAction: 'translate',
    floatingBallCompact: false,
    floatingBallSettingsEntryVisible: true,
    floatingBallCollapsedOpacity: 52,
    floatingBallDisabledDomains: [],
    translationProgressPanelEnabled: true,
  });
  for (const mock of [
    mocks.subscribeMangaTranslation,
    mocks.showPageNotice,
    mocks.dismissPageNotice,
    mocks.openMangaEntry,
    mocks.unsubscribeMangaTranslation,
    mocks.createVueShadowUi,
    mocks.createAnchoredPopup,
    mocks.togglePopup,
    mocks.closePopup,
    mocks.requestConfigPatch,
    mocks.getURL,
    mocks.sendMessage,
    mocks.autoTranslateEnglishPage,
    mocks.isFullPageTranslationActive,
    mocks.getTranslationToolbarStatus,
    mocks.subscribeTranslationToolbarStatus,
    mocks.unsubscribeTranslationToolbarStatus,
    mocks.restoreOriginalContent,
    mocks.subscribeFullPageTranslationProgress,
    mocks.unsubscribeFullPageTranslationProgress,
    mocks.subscribeConfig,
    mocks.unsubscribeConfig,
  ]) mock.mockReset();
  mocks.requestConfigPatch.mockImplementation(async (patch: Record<string, unknown>) => {
    Object.assign(mocks.config, patch);
  });
  mocks.subscribeMangaTranslation.mockImplementation(listener => {listener({available: false, active: false, pending: false, errors: 0}); return mocks.unsubscribeMangaTranslation;});
  mocks.sendMessage.mockResolvedValue({success: true});
  mocks.getURL.mockImplementation((path:string)=>`chrome-extension://fixture${path}`);
  mocks.autoTranslateEnglishPage.mockResolvedValue(undefined);
  mocks.isFullPageTranslationActive.mockReturnValue(false);
  mocks.getTranslationToolbarStatus.mockReturnValue('idle');
  mocks.subscribeTranslationToolbarStatus.mockReturnValue(mocks.unsubscribeTranslationToolbarStatus);
  mocks.subscribeFullPageTranslationProgress.mockReturnValue(mocks.unsubscribeFullPageTranslationProgress);
  mocks.subscribeConfig.mockReturnValue(mocks.unsubscribeConfig);
  mocks.createAnchoredPopup.mockReturnValue({toggle: mocks.togglePopup.mockResolvedValue(undefined), close: mocks.closePopup});
});

afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

describe('悬浮球 content runtime', () => {
  it('在没有上下文或功能被禁用时不创建 UI', async () => {
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    expect(runtime.mountFloatingBall()).toBeUndefined();
    mocks.config.disableFloatingBall = true;
    expect(runtime.mountFloatingBall({} as never)).toBeNull();
    expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    expect(runtime.toggleFloatingBallTranslation()).toBe(false);
  });

  it('通过关闭 Shadow DOM 组装交互，卸载只清理入口并保留全文会话', async () => {
    const toggleTranslation = vi.fn();
    const setTranslationState = vi.fn();
    const setTranslationStatus = vi.fn();
    const setPosition = vi.fn();
    const mountedUi = ui({toggleTranslation, setTranslationState, setTranslationStatus, setPosition});
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    const context = {name: 'content'} as never;

    await expect(runtime.mountFloatingBall(context)).resolves.toEqual({toggleTranslation, setTranslationState, setTranslationStatus, setPosition});
    const [, options] = mocks.createVueShadowUi.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({
      name: 'fluent-read-floating-ball-ui',
      hostId: 'fluent-read-floating-ball-container',
      mode: 'closed',
    }));
    expect(options.props).toEqual(expect.objectContaining({
      position: 'right',
      verticalPosition: null,
      logoUrl: 'chrome-extension://fixture/icon/128.png',
      initialTranslating: false,
      initialTranslationStatus: 'idle',
    }));
    expect(options.props.presentation).toEqual({
      toolsDisplay: 'hover',
      hoverDelay: 0,
      clickAction: 'translate',
      compact: false,
      settingsEntryVisible: true,
      collapsedOpacity: 52,
    });
    expect(runtime.mountFloatingBall()).toBeNull();
    expect(mocks.subscribeFullPageTranslationProgress).toHaveBeenCalledOnce();
    const progressListener = mocks.subscribeFullPageTranslationProgress.mock.calls[0][0];
    progressListener({active: true});
    progressListener({active: false});
    expect(setTranslationState).toHaveBeenNthCalledWith(1, true);
    expect(setTranslationState).toHaveBeenNthCalledWith(2, false);
    const statusListener = mocks.subscribeTranslationToolbarStatus.mock.calls[0][0];
    statusListener('translating');
    statusListener('error');
    statusListener('translated');
    expect(setTranslationStatus.mock.calls).toEqual([['translating'], ['error'], ['translated']]);
    expect(runtime.toggleFloatingBallTranslation()).toBe(true);
    expect(toggleTranslation).toHaveBeenCalledOnce();

    options.props.onSettingsClick({isTrusted: true, currentTarget: document.createElement('button')});
    options.props.onPositionChanged('left', 0.25);
    await Promise.resolve();
    expect(mocks.togglePopup).toHaveBeenCalledWith(expect.any(HTMLElement));
    expect(mocks.config.floatingBallPosition).toBe('left');
    expect(mocks.config.floatingBallVerticalPosition).toBe(0.25);
    expect(mocks.requestConfigPatch).toHaveBeenCalledWith({
      floatingBallPosition: 'left', floatingBallVerticalPosition: 0.25,
    }, expect.any(Function));
    const configListener = mocks.subscribeConfig.mock.calls[0][0];
    configListener({...mocks.config, floatingBallPosition: 'right', floatingBallVerticalPosition: 0.75});
    expect(setPosition).toHaveBeenCalledWith('right', 0.75);

    mocks.isFullPageTranslationActive.mockReturnValueOnce(true);
    options.props.onTranslationToggle(true);
    expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
    mocks.isFullPageTranslationActive.mockReturnValueOnce(false);
    options.props.onTranslationToggle(true);
    expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    mocks.isFullPageTranslationActive.mockReturnValueOnce(true);
    options.props.onTranslationToggle(false);
    expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();

    mocks.isFullPageTranslationActive.mockReturnValueOnce(true);
    runtime.unmountFloatingBall();
    runtime.unmountFloatingBall();
    expect(mountedUi.remove).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeFullPageTranslationProgress).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeTranslationToolbarStatus).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeConfig).toHaveBeenCalledOnce();
    expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
  });

  it.each(['setting', 'site-rule'] as const)('隐藏浮球保留译文会话，重新挂载使用当前结果状态 (%s)', async (reason) => {
    vi.stubGlobal('location', {href: 'https://news.example.com/article'});
    mocks.isFullPageTranslationActive.mockReturnValue(true);
    mocks.getTranslationToolbarStatus.mockReturnValue('error');
    const first = ui({setTranslationState: vi.fn(), setTranslationStatus: vi.fn()});
    const second = ui({setTranslationState: vi.fn(), setTranslationStatus: vi.fn()});
    mocks.createVueShadowUi.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    await runtime.mountFloatingBall({} as never);
    const staleProgress = mocks.subscribeFullPageTranslationProgress.mock.calls[0][0];
    const staleStatus = mocks.subscribeTranslationToolbarStatus.mock.calls[0][0];
    if (reason === 'setting') mocks.config.disableFloatingBall = true;
    else mocks.config.floatingBallDisabledDomains = ['example.com'];
    runtime.unmountFloatingBall();
    await runtime.mountFloatingBall();
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    expect(mocks.isFullPageTranslationActive()).toBe(true);
    mocks.config.disableFloatingBall = false;
    mocks.config.floatingBallDisabledDomains = [];
    mocks.getTranslationToolbarStatus.mockReturnValue('translated');
    await runtime.mountFloatingBall();
    expect(mocks.createVueShadowUi.mock.calls[1][1].props).toMatchObject({
      initialTranslating: true, initialTranslationStatus: 'translated',
    });
    staleProgress({active: false}); staleStatus('idle');
    expect((second.mounted!.instance as any).setTranslationState).not.toHaveBeenCalled();
    expect((second.mounted!.instance as any).setTranslationStatus).not.toHaveBeenCalled();
    runtime.unmountFloatingBall();
    expect(first.remove).toHaveBeenCalledOnce();
    expect(second.remove).toHaveBeenCalledOnce();
    expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
  });

  it('异步挂载中新增的浮球站点禁用规则拦住迟到入口', async () => {
    vi.stubGlobal('location', {href: 'https://news.example.com/article'});
    const deferred = pendingUi();
    mocks.createVueShadowUi.mockReturnValue(deferred.promise);
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    const request = runtime.mountFloatingBall({} as never);
    mocks.config.floatingBallDisabledDomains = ['example.com'];
    const stale = ui(); deferred.resolve(stale);
    await expect(request).resolves.toBeNull();
    expect(stale.remove).toHaveBeenCalledOnce();
    expect(mocks.subscribeTranslationToolbarStatus).not.toHaveBeenCalled();
    expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
  });

  it('设置页改动高级外观后不重新挂载即同步展示契约', async () => {
    const mountedUi = ui({toggleTranslation: vi.fn(), setTranslationState: vi.fn()});
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    await runtime.mountFloatingBall({} as never);
    const [, options] = mocks.createVueShadowUi.mock.calls[0];
    const presentation = options.props.presentation;
    const listener = mocks.subscribeConfig.mock.calls[0][0];

    listener({
      floatingBallToolsDisplay: 'always',
      floatingBallHoverDelay: 500,
      floatingBallClickAction: 'none',
      floatingBallCompact: true,
      floatingBallSettingsEntryVisible: false,
      floatingBallCollapsedOpacity: 20,
    });

    expect(presentation).toEqual({
      toolsDisplay: 'always',
      hoverDelay: 500,
      clickAction: 'none',
      compact: true,
      settingsEntryVisible: false,
      collapsedOpacity: 20,
    });
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();

    // 卸载后到达的配置广播不得继续写回已经释放的展示契约。
    runtime.unmountFloatingBall();
    listener({...mocks.config, floatingBallCompact: false, floatingBallToolsDisplay: 'hidden'});
    expect(presentation.toolsDisplay).toBe('always');
  });

  it('仅视频全屏时隐藏悬浮球，普通元素全屏不隐藏，退出后恢复并在卸载时清理监听', async () => {
    const mountedUi = ui({toggleTranslation: vi.fn(), setTranslationState: vi.fn()});
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    const fullscreenElement = document.createElement('video');

    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: fullscreenElement});
    await runtime.mountFloatingBall({} as never);
    // Shadow 内的 :host display:block!important 会覆盖宿主行内样式，必须隐藏内部挂载容器。
    expect(mountedUi.uiContainer.style.getPropertyValue('display')).toBe('none');
    expect(mountedUi.shadowHost.style.getPropertyValue('display')).toBeFalsy();

    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(mountedUi.uiContainer.style.getPropertyValue('display')).toBeFalsy();

    // 图片/文档等普通内容全屏时，即使页面其他位置存在视频，也不能误判为视频全屏。
    const nonVideoFullscreenElement = document.createElement('div');
    nonVideoFullscreenElement.append(document.createElement('img'));
    document.body.append(document.createElement('video'));
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: nonVideoFullscreenElement});
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(mountedUi.uiContainer.style.getPropertyValue('display')).toBeFalsy();

    // YouTube 等站点通常让播放器容器进入全屏，而不是让 video 元素本身进入全屏。
    const videoPlayer = document.createElement('div');
    const nestedPlayer = document.createElement('div');
    nestedPlayer.append(document.createElement('video'));
    videoPlayer.append(nestedPlayer);
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: videoPlayer});
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(mountedUi.uiContainer.style.getPropertyValue('display')).toBe('none');

    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: fullscreenElement});
    runtime.unmountFloatingBall();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(mountedUi.uiContainer.style.getPropertyValue('display')).toBeFalsy();
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
  });

  it('站点在悬浮球禁用名单中时不挂载，移出名单后恢复', async () => {
    const originalLocation = Reflect.get(globalThis, 'location');
    Reflect.set(globalThis, 'location', {href: 'https://mail.example.com/inbox'});
    mocks.config.floatingBallDisabledDomains = ['example.com'];
    const mountedUi = ui({toggleTranslation: vi.fn()});
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    expect(runtime.isFloatingBallAllowedOnPage()).toBe(false);
    expect(runtime.mountFloatingBall({} as never)).toBeNull();
    expect(mocks.createVueShadowUi).not.toHaveBeenCalled();

    mocks.config.floatingBallDisabledDomains = [];
    expect(runtime.isFloatingBallAllowedOnPage('https://mail.example.com/inbox')).toBe(true);
    await expect(runtime.mountFloatingBall({} as never)).resolves.toEqual(expect.objectContaining({
      toggleTranslation: expect.any(Function),
    }));
    runtime.unmountFloatingBall();
    if (originalLocation === undefined) Reflect.deleteProperty(globalThis, 'location');
    else Reflect.set(globalThis, 'location', originalLocation);
  });

  it('userscript 悬浮球继续打开脚本设置入口', async () => {
    vi.stubEnv('BROWSER', 'userscript');
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: document.createElement('video')});
    mocks.createVueShadowUi.mockResolvedValueOnce(ui({toggleTranslation: vi.fn()}));
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    await runtime.mountFloatingBall({} as never);
    mocks.createVueShadowUi.mock.calls[0][1].props.onSettingsClick({isTrusted: true, currentTarget: document.createElement('button')});
    await Promise.resolve();
    expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.sendMessage.mockRejectedValueOnce(new Error('settings unavailable'));
    mocks.createVueShadowUi.mock.calls[0][1].props.onSettingsClick({isTrusted: true});
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error)); consoleError.mockRestore();
    runtime.unmountFloatingBall();
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
  });

  it('uses the main control as a popup anchor when the event port has no current target and handles hidden tools', async () => {
    const runtime = await import('@/src/features/floating-ball/content/runtime'), mounted = ui();
    mocks.createVueShadowUi.mockResolvedValue(mounted); await runtime.mountFloatingBall({} as never);
    const click = mocks.createVueShadowUi.mock.calls[0][1].props.onSettingsClick;
    click(undefined); click({isTrusted: true, currentTarget: null}); expect(mocks.togglePopup).not.toHaveBeenCalled();
    const main = document.createElement('div'); main.className = 'floating-ball-main'; mounted.uiContainer.append(main);
    click({isTrusted: true, currentTarget: null}); expect(mocks.togglePopup).toHaveBeenCalledWith(main);
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: document.createElement('video')}); document.dispatchEvent(new Event('fullscreenchange'));
    expect(mocks.closePopup).toHaveBeenCalledOnce(); expect(mounted.uiContainer.style.getPropertyValue('display')).toBe('none');
    Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null}); document.dispatchEvent(new Event('fullscreenchange'));
    expect(mounted.uiContainer.style.getPropertyValue('display')).toBeFalsy();
    mocks.subscribeConfig.mock.calls[0][0]({...mocks.config, floatingBallToolsDisplay: 'hidden'}); expect(mocks.closePopup).toHaveBeenCalled();
    runtime.unmountFloatingBall(); click({isTrusted: true, currentTarget: main}); expect(mocks.togglePopup).toHaveBeenCalledOnce();
  });

  it('仅可信设置事件打开页内面板，失败后可重试并在卸载时清理', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setPopupOpen = vi.fn();
    mocks.createVueShadowUi.mockResolvedValueOnce(ui({toggleTranslation: vi.fn(), setPopupOpen}));
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    await runtime.mountFloatingBall({} as never);
    const click = mocks.createVueShadowUi.mock.calls[0][1].props.onSettingsClick;
    const button = document.createElement('button');
    click({isTrusted: false, currentTarget: button});
    expect(mocks.createAnchoredPopup).not.toHaveBeenCalled();
    mocks.togglePopup.mockRejectedValueOnce(new Error('popup denied'));
    click({isTrusted: true, currentTarget: button});
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开扩展快捷面板失败', expect.any(Error));
    click({isTrusted: true, currentTarget: button});
    await Promise.resolve();
    expect(mocks.createAnchoredPopup).toHaveBeenCalledOnce();
    const ports = mocks.createAnchoredPopup.mock.calls[0][2];
    expect(ports.getUrl()).toBe('chrome-extension://fixture/popup.html');
    await ports.request();
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({type: 'requestFloatingPopup'});
    ports.onOpenChange(true);
    expect(setPopupOpen).toHaveBeenCalledWith(true);
    runtime.unmountFloatingBall();
    expect(mocks.closePopup).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('隔离设置、保存和挂载失败，并允许重试', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.createVueShadowUi
      .mockRejectedValueOnce(new Error('mount failed'))
      .mockResolvedValueOnce(ui({toggleTranslation: vi.fn()}));
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    await expect(runtime.mountFloatingBall({} as never)).resolves.toBeNull();
    await expect(runtime.mountFloatingBall()).resolves.toEqual(expect.objectContaining({toggleTranslation: expect.any(Function)}));
    const [, options] = mocks.createVueShadowUi.mock.calls[1];

    mocks.togglePopup.mockRejectedValueOnce(new Error('settings failed'));
    mocks.requestConfigPatch.mockRejectedValueOnce(new Error('save failed'));
    options.props.onSettingsClick({isTrusted: true, currentTarget: document.createElement('button')});
    options.props.onPositionChanged('right', 0.8);
    mocks.isFullPageTranslationActive.mockReturnValueOnce(false);
    options.props.onTranslationToggle(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球挂载失败', expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开扩展快捷面板失败', expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith('Failed to save config:', expect.any(Error));
    runtime.unmountFloatingBall();
    consoleError.mockRestore();
  });

  it('丢弃卸载或禁用后才到达的挂载结果', async () => {
    const pending = pendingUi();
    const staleUi = ui({toggleTranslation: vi.fn()});
    mocks.createVueShadowUi.mockReturnValue(pending.promise);
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    const request = runtime.mountFloatingBall({} as never)!;
    expect(runtime.mountFloatingBall()).toBe(request);
    runtime.unmountFloatingBall();
    mocks.config.disableFloatingBall = true;
    pending.resolve(staleUi);

    await expect(request).resolves.toBeNull();
    expect(staleUi.remove).toHaveBeenCalledOnce();
  });

  it.each(['old-first','new-first'] as const)('reopens after enable-disable-enable while mounts resolve %s', async order => {
    const first=pendingUi(),second=pendingUi();const stale=ui(),live=ui({toggleTranslation:vi.fn()});
    const stopOld=vi.fn(),stopNew=vi.fn();mocks.subscribeMangaTranslation.mockReturnValueOnce(stopOld).mockReturnValueOnce(stopNew);
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');
    vi.doMock('@/src/app/content/features',()=>({mountFloatingBall:runtime.mountFloatingBall,unmountFloatingBall:runtime.unmountFloatingBall}));
    const {createContentRuntimeMessageHandler}=await import('@/src/app/content/messageRuntime');
    const handler=createContentRuntimeMessageHandler({} as never,{isSiteDisabled:()=>false,updateSiteDisabled:async()=>undefined} as never);
    try {
      const respond=vi.fn();
      handler({type:'toggleFloatingBall',isEnabled:true},{},respond);
      handler({type:'toggleFloatingBall',isEnabled:false},{},respond);
      handler({type:'toggleFloatingBall',isEnabled:true},{},respond);
      expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);expect(stopOld).toHaveBeenCalledOnce();
      const current=runtime.mountFloatingBall();
      if(order==='old-first') {
        first.resolve(stale);await vi.waitFor(()=>expect(stale.remove).toHaveBeenCalledOnce());
        expect(runtime.mountFloatingBall()).toBe(current);second.resolve(live);await current;
      } else {
        second.resolve(live);await current;first.resolve(stale);
        await vi.waitFor(()=>expect(stale.remove).toHaveBeenCalledOnce());
      }
      expect(runtime.toggleFloatingBallTranslation()).toBe(true);expect(live.remove).not.toHaveBeenCalled();
      expect(stopOld).toHaveBeenCalledOnce();expect(stopNew).not.toHaveBeenCalled();
    } finally {runtime.unmountFloatingBall();vi.doUnmock('@/src/app/content/features');}
    expect(stopNew).toHaveBeenCalledOnce();
  });

  it('keeps the current mount owned when a canceled earlier mount fails late', async () => {
    const first=pendingUi(),second=pendingUi();const live=ui({toggleTranslation:vi.fn()});
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const consoleError=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const runtime=await import('@/src/features/floating-ball/content/runtime');
    try {
      const old=runtime.mountFloatingBall({} as never);runtime.unmountFloatingBall();const current=runtime.mountFloatingBall();
      first.reject(new Error('old mount failed'));await expect(old).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球挂载失败',expect.any(Error));
      expect(runtime.mountFloatingBall()).toBe(current);second.resolve(live);await current;
      expect(runtime.toggleFloatingBallTranslation()).toBe(true);expect(live.remove).not.toHaveBeenCalled();
    } finally {runtime.unmountFloatingBall();consoleError.mockRestore();}
  });

  it('does not let a synchronously reentered old creation replace the newer mount promise', async () => {
    const first=pendingUi(),second=pendingUi();const stale=ui(),live=ui({toggleTranslation:vi.fn()});
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    let newer:ReturnType<typeof runtime.mountFloatingBall>;
    mocks.createVueShadowUi.mockImplementationOnce(()=>{runtime.unmountFloatingBall();newer=runtime.mountFloatingBall(ctx);return first.promise;})
      .mockReturnValueOnce(second.promise);
    const older=runtime.mountFloatingBall(ctx);
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);expect(runtime.mountFloatingBall()).toBe(newer!);
    first.resolve(stale);await older;expect(stale.remove).toHaveBeenCalledOnce();expect(runtime.mountFloatingBall()).toBe(newer!);
    second.resolve(live);await newer!;expect(runtime.toggleFloatingBallTranslation()).toBe(true);runtime.unmountFloatingBall();
  });

  it('bounds synchronously reentered creation and resumes the latest intent when a slot frees', async () => {
    const first=pendingUi(),second=pendingUi(),third=pendingUi();
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    const reenter=(pending:ReturnType<typeof pendingUi>)=>{runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);return pending.promise;};
    mocks.createVueShadowUi.mockImplementationOnce(()=>reenter(first)).mockImplementationOnce(()=>reenter(second)).mockReturnValueOnce(third.promise);
    const older=runtime.mountFloatingBall(ctx);expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);
    expect(mocks.showPageNotice).toHaveBeenCalledOnce();const stale=ui();first.resolve(stale);await older;
    await vi.waitFor(()=>expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3));
    const live=ui({toggleTranslation:vi.fn()});third.resolve(live);await vi.waitFor(()=>expect(runtime.toggleFloatingBallTranslation()).toBe(true));
    const other=ui();second.resolve(other);await vi.waitFor(()=>expect(other.remove).toHaveBeenCalledOnce());runtime.unmountFloatingBall();
  });

  it.each(['getURL','create'] as const)('cleans synchronous %s failures without consuming mount slots', async failure => {
    const stopFirst=vi.fn(),stopSecond=vi.fn(),stopLive=vi.fn();
    mocks.subscribeMangaTranslation.mockReturnValueOnce(stopFirst).mockReturnValueOnce(stopSecond).mockReturnValueOnce(stopLive);
    const error=new Error('context unavailable');
    if(failure==='getURL')mocks.getURL.mockImplementationOnce(()=>{throw error;}).mockImplementationOnce(()=>{throw error;});
    else mocks.createVueShadowUi.mockImplementationOnce(()=>{throw error;}).mockImplementationOnce(()=>{throw error;});
    const live=ui({toggleTranslation:vi.fn()});mocks.createVueShadowUi.mockResolvedValue(live);
    const consoleError=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const runtime=await import('@/src/features/floating-ball/content/runtime');
    try {
      await expect(runtime.mountFloatingBall({} as never)).resolves.toBeNull();
      await expect(runtime.mountFloatingBall()).resolves.toBeNull();
      expect(stopFirst).toHaveBeenCalledOnce();expect(stopSecond).toHaveBeenCalledOnce();
      await runtime.mountFloatingBall();expect(runtime.toggleFloatingBallTranslation()).toBe(true);
      expect(mocks.showPageNotice).not.toHaveBeenCalled();expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {runtime.unmountFloatingBall();consoleError.mockRestore();}
    expect(stopLive).toHaveBeenCalledOnce();
  });

  it('bounds hung WXT creations during rapid toggles and retries only the latest enabled request', async () => {
    const first=pendingUi(),second=pendingUi(),third=pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');
    const ctx={} as never;
    for(let i=0;i<100;i++) {mocks.config.disableFloatingBall=false;runtime.mountFloatingBall(ctx);mocks.config.disableFloatingBall=true;runtime.unmountFloatingBall();}
    mocks.showPageNotice.mockClear();mocks.config.disableFloatingBall=false;runtime.mountFloatingBall(ctx);runtime.mountFloatingBall(ctx);
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);
    expect(mocks.showPageNotice).toHaveBeenCalledOnce();
    expect(mocks.showPageNotice).toHaveBeenCalledWith(expect.stringContaining('刷新'), 'error', expect.objectContaining({key:'floating-ball-mount-wait'}));
    const staleFirst=ui(),staleSecond=ui(),live=ui({toggleTranslation:vi.fn()});
    first.resolve(staleFirst);await vi.waitFor(()=>expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3));
    third.resolve(live);await vi.waitFor(()=>expect(runtime.toggleFloatingBallTranslation()).toBe(true));
    expect(mocks.dismissPageNotice).toHaveBeenCalledWith('floating-ball-mount-wait');
    second.resolve(staleSecond);await vi.waitFor(()=>expect(staleSecond.remove).toHaveBeenCalledOnce());
    expect(staleFirst.remove).toHaveBeenCalledOnce();expect(live.remove).not.toHaveBeenCalled();runtime.unmountFloatingBall();
  });

  it.each(['show','listen'] as const)('keeps the pending retry and logs an error when the notice %s fails', async failure => {
    const first=pendingUi(),second=pendingUi(),third=pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const consoleError=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    try {
      runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();
      if(failure==='show')mocks.showPageNotice.mockImplementationOnce(()=>{throw new Error('notice unavailable');});
      else {Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});vi.spyOn(document,'addEventListener').mockImplementationOnce(()=>{throw new Error('listener unavailable');});}
      runtime.mountFloatingBall(ctx);
      expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球恢复提示失败',expect.any(Error));
      const stale=ui(),live=ui({toggleTranslation:vi.fn()});first.resolve(stale);
      await vi.waitFor(()=>expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3));third.resolve(live);
      await vi.waitFor(()=>expect(runtime.toggleFloatingBallTranslation()).toBe(true));
      const old=ui();second.resolve(old);await vi.waitFor(()=>expect(old.remove).toHaveBeenCalledOnce());
    } finally {runtime.unmountFloatingBall();vi.restoreAllMocks();}
  });

  it('does not retry a delayed mount after the user disables the feature', async () => {
    const first=pendingUi(),second=pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();
    runtime.mountFloatingBall(ctx);mocks.config.disableFloatingBall=true;runtime.unmountFloatingBall();
    const old=ui();first.resolve(old);await vi.waitFor(()=>expect(old.remove).toHaveBeenCalledOnce());
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);second.resolve(ui());await second.promise;
  });

  it('does not restart a delayed mount while the entire extension is off', async () => {
    const first=pendingUi(),second=pendingUi(),third=pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);
    mocks.config.on=false;const old=ui();first.resolve(old);await vi.waitFor(()=>expect(old.remove).toHaveBeenCalledOnce());
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);mocks.config.on=true;
    const current=runtime.mountFloatingBall(ctx);expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3);
    const live=ui({toggleTranslation:vi.fn()});third.resolve(live);await current;
    expect(runtime.toggleFloatingBallTranslation()).toBe(true);const older=ui();second.resolve(older);
    await vi.waitFor(()=>expect(older.remove).toHaveBeenCalledOnce());runtime.unmountFloatingBall();
  });

  it.each(['show','disable','off','fail'] as const)('defers the bounded-mount recovery notice until visible and handles %s', async mode => {
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    const first=pendingUi(),second=pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);
    expect(mocks.showPageNotice).not.toHaveBeenCalled();document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.showPageNotice).not.toHaveBeenCalled();
    if(mode==='disable'){mocks.config.disableFloatingBall=true;runtime.unmountFloatingBall();}
    if(mode==='off')Object.assign(mocks.config,{on:false});
    const consoleError=mode==='fail'?vi.spyOn(console,'error').mockImplementation(()=>undefined):undefined;
    if(mode==='fail')mocks.showPageNotice.mockImplementationOnce(()=>{throw new Error('notice unavailable');});
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.showPageNotice).toHaveBeenCalledTimes(mode==='show'||mode==='fail'?1:0);
    if(mode==='fail')expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球恢复提示失败',expect.any(Error));
    runtime.unmountFloatingBall();const one=ui(),two=ui();first.resolve(one);second.resolve(two);
    await vi.waitFor(()=>{expect(one.remove).toHaveBeenCalledOnce();expect(two.remove).toHaveBeenCalledOnce();});
    if(mode==='off')Object.assign(mocks.config,{on:true});
    consoleError?.mockRestore();
  });

  it.each(['mount','unmount'] as const)('preserves floating ball ownership if notice dismissal fails during %s', async phase => {
    const live=ui({toggleTranslation:vi.fn()});mocks.createVueShadowUi.mockResolvedValue(live);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const consoleError=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try {
      if(phase==='mount')mocks.dismissPageNotice.mockImplementationOnce(()=>{throw new Error('dismiss failed');});
      await runtime.mountFloatingBall({} as never);expect(runtime.toggleFloatingBallTranslation()).toBe(true);
      if(phase==='unmount')mocks.dismissPageNotice.mockImplementationOnce(()=>{throw new Error('dismiss failed');});
      runtime.unmountFloatingBall();expect(live.remove).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球恢复提示清理失败',expect.any(Error));
    } finally {runtime.unmountFloatingBall();consoleError.mockRestore();}
  });

  it('invalidates a visibility callback even if removing its listener throws', async () => {
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    const first=pendingUi(),second=pendingUi();mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime=await import('@/src/features/floating-ball/content/runtime');const ctx={} as never;
    const consoleError=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try {
      runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);runtime.unmountFloatingBall();runtime.mountFloatingBall(ctx);
      vi.spyOn(document,'removeEventListener').mockImplementationOnce(()=>{throw new Error('remove failed');});runtime.unmountFloatingBall();
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));
      expect(mocks.showPageNotice).not.toHaveBeenCalled();expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球恢复提示清理失败',expect.any(Error));
      const one=ui(),two=ui();first.resolve(one);second.resolve(two);await vi.waitFor(()=>{expect(one.remove).toHaveBeenCalledOnce();expect(two.remove).toHaveBeenCalledOnce();});
    } finally {runtime.unmountFloatingBall();vi.restoreAllMocks();}
  });

  it('没有 exposed instance 时仍防止重复挂载并可完整清理', async () => {
    const mountedUi = {
      remove: vi.fn(),
      shadowHost: document.createElement('div'),
      uiContainer: document.createElement('body'),
    };
    document.documentElement.append(mountedUi.shadowHost);
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    await expect(runtime.mountFloatingBall({} as never)).resolves.toBeNull();
    expect(runtime.mountFloatingBall()).toBeNull();
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    runtime.unmountFloatingBall();
    expect(mountedUi.remove).toHaveBeenCalledOnce();
  });
  it('reconciles a removed floating-ball host through the actual registry, releasing old subscriptions and callbacks', async () => {
    const {createContentFeatureRegistry} = await import('@/src/app/content/featureRegistry');
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    const first = ui({setTranslationState: vi.fn(), setTranslationStatus: vi.fn(), setPosition: vi.fn()});
    const secondInstance = {setTranslationState: vi.fn(), setTranslationStatus: vi.fn(), setPosition: vi.fn()}, second = ui(secondInstance);
    const id = 'fluent-read-floating-ball-container';
    mocks.createVueShadowUi.mockImplementationOnce(async () => {first.shadowHost.id = id; return first;})
      .mockImplementationOnce(async () => {second.shadowHost.id = id; return second;});
    const context = {isInvalid: false} as never, activation = new AbortController();
    const registry = createContentFeatureRegistry([{id: 'floating-ball', isEnabled: () => true, mount: () => runtime.mountFloatingBall(context),
      unmount: runtime.unmountFloatingBall, isMounted: () => Boolean(document.getElementById(id))}]);
    await registry.mountEnabled({ctx: context, signal: activation.signal, isCurrent: () => true});
    const staleProgress = mocks.subscribeFullPageTranslationProgress.mock.calls[0][0], staleStatus = mocks.subscribeTranslationToolbarStatus.mock.calls[0][0], staleConfig = mocks.subscribeConfig.mock.calls[0][0];
    document.body.replaceWith(document.createElement('body')); await registry.reconcileEnabled(); expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    first.shadowHost.remove(); await expect(registry.reconcileEnabled()).resolves.toEqual([{id: 'floating-ball', status: 'mounted'}]);
    expect(document.getElementById(id)).toBe(second.shadowHost); expect(first.remove).toHaveBeenCalledOnce();
    for (const unsubscribe of [mocks.unsubscribeMangaTranslation, mocks.unsubscribeFullPageTranslationProgress, mocks.unsubscribeTranslationToolbarStatus, mocks.unsubscribeConfig]) expect(unsubscribe).toHaveBeenCalledOnce();
    staleProgress({active: true}); staleStatus('error'); staleConfig({...mocks.config, floatingBallPosition: 'left'});
    expect(secondInstance.setTranslationState).not.toHaveBeenCalled(); expect(secondInstance.setTranslationStatus).not.toHaveBeenCalled(); expect(secondInstance.setPosition).not.toHaveBeenCalled();
    mocks.subscribeFullPageTranslationProgress.mock.calls[1][0]({active: true}); expect(secondInstance.setTranslationState).toHaveBeenCalledWith(true);
    registry.unmountAll(); expect(second.remove).toHaveBeenCalledOnce(); expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
  });
  it('rejects a late replacement mount after deactivation and lets the next registry activation recover', async () => {
    const {createContentFeatureRegistry} = await import('@/src/app/content/featureRegistry');
    const runtime = await import('@/src/features/floating-ball/content/runtime'), pending = pendingUi(), id = 'fluent-read-floating-ball-container';
    const first = ui(), late = ui(), fresh = ui(), context = {isInvalid: false} as never, old = new AbortController();
    mocks.createVueShadowUi.mockImplementationOnce(async () => {first.shadowHost.id = id; return first;}).mockReturnValueOnce(pending.promise)
      .mockImplementationOnce(async () => {fresh.shadowHost.id = id; return fresh;});
    const feature = {id: 'floating-ball', isEnabled: () => true, mount: () => runtime.mountFloatingBall(context), unmount: runtime.unmountFloatingBall, isMounted: () => Boolean(document.getElementById(id))};
    const registry = createContentFeatureRegistry([feature]); await registry.mountEnabled({ctx: context, signal: old.signal, isCurrent: () => !old.signal.aborted});
    first.shadowHost.remove(); const replacing = registry.reconcileEnabled(); await Promise.resolve(); await Promise.resolve();
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2); old.abort(); registry.unmountAll();
    const next = createContentFeatureRegistry([feature]), activating = next.mountEnabled({ctx: context, signal: new AbortController().signal, isCurrent: () => true});
    late.shadowHost.id = id; pending.resolve(late);
    await expect(replacing).resolves.toEqual([{id: 'floating-ball', status: 'skipped'}]);
    await expect(activating).resolves.toEqual([{id: 'floating-ball', status: 'mounted'}]);
    expect(first.remove).toHaveBeenCalledOnce(); expect(late.remove).toHaveBeenCalledOnce(); expect(document.getElementById(id)).toBe(fresh.shadowHost); expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3);
    next.unmountAll(); expect(fresh.remove).toHaveBeenCalledOnce();
  });
  it.each(['disabled', 'invalid-context'] as const)('cleans detached ownership without recreating it when %s', async reason => {
    const runtime = await import('@/src/features/floating-ball/content/runtime'), mounted = ui(), context = {isInvalid: false};
    mocks.createVueShadowUi.mockResolvedValue(mounted); await runtime.mountFloatingBall(context as never); mounted.shadowHost.remove();
    if (reason === 'disabled') mocks.config.disableFloatingBall = true; else context.isInvalid = true;
    await runtime.mountFloatingBall(context as never); expect(mounted.remove).toHaveBeenCalledOnce(); expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeConfig).toHaveBeenCalledOnce(); runtime.unmountFloatingBall();
  });
});

describe('全文翻译进度面板 content runtime', () => {
  it('只在开启且获得上下文后挂载，卸载幂等', async () => {
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    expect(runtime.mountTranslationProgressPanel()).toBeUndefined();
    mocks.config.translationProgressPanelEnabled = false;
    expect(runtime.mountTranslationProgressPanel({} as never)).toBeNull();
    expect(mocks.createVueShadowUi).not.toHaveBeenCalled();

    mocks.config.translationProgressPanelEnabled = true;
    const mountedUi = ui({panel: true});
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    await expect(runtime.mountTranslationProgressPanel()).resolves.toEqual({panel: true});
    expect(mocks.createVueShadowUi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: 'fluent-read-translation-progress-ui',
      hostId: 'fluent-read-translation-status-container',
      zIndex: 2_147_483_645,
    }));
    expect(runtime.mountTranslationProgressPanel()).toBeNull();
    runtime.unmountTranslationProgressPanel();
    runtime.unmountTranslationProgressPanel();
    expect(mountedUi.remove).toHaveBeenCalledOnce();
  });

  it('挂载失败时降级为无面板并允许重试', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.createVueShadowUi
      .mockRejectedValueOnce(new Error('panel failed'))
      .mockResolvedValueOnce(ui({panel: true}));
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');

    await expect(runtime.mountTranslationProgressPanel({} as never)).resolves.toBeNull();
    await expect(runtime.mountTranslationProgressPanel()).resolves.toEqual({panel: true});
    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 翻译进度面板挂载失败', expect.any(Error));
    runtime.unmountTranslationProgressPanel();
    consoleError.mockRestore();
  });

  it('关闭功能时移除迟到面板，且不重试', async () => {
    const pending = pendingUi();
    const staleUi = ui({panel: true});
    mocks.createVueShadowUi.mockReturnValue(pending.promise);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');

    const request = runtime.mountTranslationProgressPanel({} as never)!;
    mocks.config.translationProgressPanelEnabled = false;
    pending.resolve(staleUi);

    await expect(request).resolves.toBeNull();
    expect(staleUi.remove).toHaveBeenCalledOnce();
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
  });

  it('快速关闭再开启时丢弃旧请求并补发最终挂载', async () => {
    const pending = pendingUi();
    const staleUi = ui({panel: 'stale'});
    const currentUi = ui({panel: 'current'});
    mocks.createVueShadowUi.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(currentUi);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');

    const request = runtime.mountTranslationProgressPanel({} as never)!;
    runtime.unmountTranslationProgressPanel();
    mocks.config.translationProgressPanelEnabled = true;
    const fresh = runtime.mountTranslationProgressPanel();
    expect(fresh).not.toBe(request);
    await expect(fresh).resolves.toEqual({panel: 'current'});
    pending.resolve(staleUi);
    await expect(request).resolves.toBeNull();
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);

    expect(staleUi.remove).toHaveBeenCalledOnce();
    runtime.unmountTranslationProgressPanel();
    expect(currentUi.remove).toHaveBeenCalledOnce();
  });

  it('reopens a progress panel without waiting for an old rejected mount', async () => {
    const pending = pendingUi(); const current = ui({panel: 'current'});
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.createVueShadowUi.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    const old = runtime.mountTranslationProgressPanel({isInvalid: false} as never)!;
    runtime.unmountTranslationProgressPanel();
    const fresh = runtime.mountTranslationProgressPanel()!;
    let settled = false;
    void fresh.then(value => {settled = (value as {panel?: string} | null)?.panel === 'current';});
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const prompt = settled;
    if (!prompt) {pending.reject(new Error('old mount failed'));await old;}
    expect(prompt).toBe(true);
    pending.reject(new Error('old mount failed'));await old;
    expect(runtime.mountTranslationProgressPanel()).toBeNull();
    runtime.unmountTranslationProgressPanel();expect(current.remove).toHaveBeenCalledOnce();log.mockRestore();
  });

  it('bounds hung progress panel creations and retries the latest request when a slot opens', async () => {
    const first = pendingUi(), second = pendingUi();
    const staleFirst = ui(), staleSecond = ui(), live = ui({panel: 'latest'});
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(live);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    const old = runtime.mountTranslationProgressPanel({isInvalid: false} as never)!;
    runtime.unmountTranslationProgressPanel();
    const previous = runtime.mountTranslationProgressPanel()!;
    runtime.unmountTranslationProgressPanel();
    expect(runtime.mountTranslationProgressPanel()).toBeNull();
    expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);
    expect(mocks.showPageNotice).toHaveBeenCalledWith(expect.stringContaining('进度面板'), 'error', expect.objectContaining({key: 'translation-progress-mount-wait'}));
    first.resolve(staleFirst);await old;
    await vi.waitFor(() => expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(runtime.mountTranslationProgressPanel()).toBeNull());
    second.resolve(staleSecond);await previous;
    expect(staleFirst.remove).toHaveBeenCalledOnce();expect(staleSecond.remove).toHaveBeenCalledOnce();
    expect(live.remove).not.toHaveBeenCalled();runtime.unmountTranslationProgressPanel();expect(live.remove).toHaveBeenCalledOnce();
    expect(mocks.dismissPageNotice).toHaveBeenCalledWith('translation-progress-mount-wait');
  });

  it('defers the recovery notice until the page is visible and removes it on disable', async () => {
    const first = pendingUi(), second = pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    runtime.mountTranslationProgressPanel({} as never);runtime.unmountTranslationProgressPanel();
    runtime.mountTranslationProgressPanel();runtime.unmountTranslationProgressPanel();
    mocks.showPageNotice.mockClear();runtime.mountTranslationProgressPanel();
    expect(mocks.showPageNotice).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('visibilitychange'));expect(mocks.showPageNotice).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.showPageNotice).toHaveBeenCalledOnce();
    runtime.unmountTranslationProgressPanel();expect(mocks.dismissPageNotice).toHaveBeenCalledWith('translation-progress-mount-wait');
    first.resolve(ui());second.resolve(ui());await Promise.all([first.promise, second.promise]);
  });

  it.each(['show', 'listen', 'dismiss', 'remove'] as const)('keeps the panel lifecycle safe when notice %s fails', async failure => {
    const first = pendingUi(), second = pendingUi(), third = pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    runtime.mountTranslationProgressPanel({} as never);runtime.unmountTranslationProgressPanel();runtime.mountTranslationProgressPanel();runtime.unmountTranslationProgressPanel();
    if (failure === 'show') mocks.showPageNotice.mockImplementationOnce(() => {throw new Error('show');});
    if (failure === 'listen') {Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'});vi.spyOn(document,'addEventListener').mockImplementationOnce(() => {throw new Error('listen');});}
    if (failure === 'remove') {Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'});vi.spyOn(document,'removeEventListener').mockImplementationOnce(() => {throw new Error('remove');});}
    runtime.mountTranslationProgressPanel();
    if (failure === 'dismiss') mocks.dismissPageNotice.mockImplementationOnce(() => {throw new Error('dismiss');});
    if (failure === 'remove') {Object.defineProperty(document, 'visibilityState', {configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));}
    first.resolve(ui());await vi.waitFor(() => expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(3));
    third.resolve(ui());await vi.waitFor(() => expect(mocks.dismissPageNotice).toHaveBeenCalledWith('translation-progress-mount-wait'));
    expect(log).toHaveBeenCalled();runtime.unmountTranslationProgressPanel();second.resolve(ui());await second.promise;vi.restoreAllMocks();
  });

  it.each([false, true])('cleans a hidden recovery listener on disable, even if removal throws: %s', async throws => {
    const first = pendingUi(), second = pendingUi();
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    runtime.mountTranslationProgressPanel({} as never);runtime.unmountTranslationProgressPanel();
    runtime.mountTranslationProgressPanel();runtime.unmountTranslationProgressPanel();runtime.mountTranslationProgressPanel();
    if (throws) vi.spyOn(document, 'removeEventListener').mockImplementationOnce(() => {throw new Error('remove');});
    runtime.unmountTranslationProgressPanel();
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    document.dispatchEvent(new Event('visibilitychange'));expect(mocks.showPageNotice).not.toHaveBeenCalled();
    if (throws) expect(log).toHaveBeenCalled();
    first.resolve(ui());second.resolve(ui());await Promise.all([first.promise, second.promise]);vi.restoreAllMocks();
  });

  it('does not let an older progress creation clear a newer pending mount', async () => {
    const first = pendingUi(), second = pendingUi();const stale = ui(), live = ui({panel: 'new'});
    mocks.createVueShadowUi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    const old = runtime.mountTranslationProgressPanel({isInvalid: false} as never)!;
    runtime.unmountTranslationProgressPanel();const current = runtime.mountTranslationProgressPanel()!;
    first.resolve(stale);await old;
    expect(runtime.mountTranslationProgressPanel()).toBe(current);
    second.resolve(live);await expect(current).resolves.toEqual({panel: 'new'});
    expect(stale.remove).toHaveBeenCalledOnce();expect(live.remove).not.toHaveBeenCalled();
    runtime.unmountTranslationProgressPanel();
  });

  it('preserves the new owner during synchronous unmount and remount from creation', async () => {
    const first = pendingUi(), second = pendingUi();const stale = ui(), live = ui({panel: 'new'});
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    let current: Promise<unknown> | null | undefined;
    mocks.createVueShadowUi.mockImplementationOnce(() => {
      runtime.unmountTranslationProgressPanel();current = runtime.mountTranslationProgressPanel();return first.promise;
    }).mockReturnValueOnce(second.promise);
    const old = runtime.mountTranslationProgressPanel({isInvalid: false} as never)!;
    expect(runtime.mountTranslationProgressPanel()).toBe(current);
    first.resolve(stale);await old;expect(runtime.mountTranslationProgressPanel()).toBe(current);
    second.resolve(live);await expect(current).resolves.toEqual({panel: 'new'});
    expect(stale.remove).toHaveBeenCalledOnce();runtime.unmountTranslationProgressPanel();
  });

  it('releases the progress panel creation slot on synchronous creation failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.createVueShadowUi.mockImplementationOnce(() => {throw new Error('synchronous failure');}).mockResolvedValueOnce(ui({panel: 'retry'}));
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');
    expect(await runtime.mountTranslationProgressPanel({isInvalid: false} as never)).toBeNull();
    await expect(runtime.mountTranslationProgressPanel()).resolves.toEqual({panel: 'retry'});
    expect(error).toHaveBeenCalled();runtime.unmountTranslationProgressPanel();error.mockRestore();
  });

  it('面板没有 exposed instance 时仍保持单例', async () => {
    const mountedUi = {remove: vi.fn()};
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/full-page-translation/content/progressPanel');

    await expect(runtime.mountTranslationProgressPanel({} as never)).resolves.toBeNull();
    expect(runtime.mountTranslationProgressPanel()).toBeNull();
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    runtime.unmountTranslationProgressPanel();
    expect(mountedUi.remove).toHaveBeenCalledOnce();
  });
});

 it('漫画入口订阅当前状态、只接收可信点击，卸载清理订阅', async () => {
    mocks.createVueShadowUi.mockResolvedValue(ui());
    const runtime = await import('@/src/features/floating-ball/content/runtime');
    await runtime.mountFloatingBall({} as never);
    const props = mocks.createVueShadowUi.mock.calls[0][1].props;
    mocks.subscribeMangaTranslation.mock.calls[0][0]({available: true, active: true, pending: true, errors: 0});
    expect(props.manga).toEqual({available: true, active: true, pending: true, errors: 0});
    props.onMangaToggle({isTrusted: false}); expect(mocks.openMangaEntry).not.toHaveBeenCalled();
    props.onMangaToggle({isTrusted: true}); expect(mocks.openMangaEntry).toHaveBeenCalledOnce();
    runtime.unmountFloatingBall(); expect(mocks.unsubscribeMangaTranslation).toHaveBeenCalledOnce();
 });
