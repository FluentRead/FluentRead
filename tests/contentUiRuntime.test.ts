import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
  subscribeMangaTranslation: vi.fn(),
  openMangaEntry: vi.fn(),
  unsubscribeMangaTranslation: vi.fn(),
  config: {
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
  requestConfigPatch: vi.fn(),
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
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.createVueShadowUi}));
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      getURL: (path: string) => `chrome-extension://fixture${path}`,
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
  return {
    mounted: {instance},
    remove: vi.fn(),
    shadowHost: document.createElement('div'),
    uiContainer: document.createElement('body'),
  };
}

function pendingUi(): {promise: Promise<MockUi>; resolve: (value: MockUi) => void} {
  let resolve!: (value: MockUi) => void;
  return {
    promise: new Promise<MockUi>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

beforeEach(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', parsed.window);
  vi.stubGlobal('document', parsed.document);
  vi.stubGlobal('Event', parsed.window.Event);
  vi.resetModules();
  Object.assign(mocks.config, {
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
    mocks.openMangaEntry,
    mocks.unsubscribeMangaTranslation,
    mocks.createVueShadowUi,
    mocks.requestConfigPatch,
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
  mocks.autoTranslateEnglishPage.mockResolvedValue(undefined);
  mocks.isFullPageTranslationActive.mockReturnValue(false);
  mocks.getTranslationToolbarStatus.mockReturnValue('idle');
  mocks.subscribeTranslationToolbarStatus.mockReturnValue(mocks.unsubscribeTranslationToolbarStatus);
  mocks.subscribeFullPageTranslationProgress.mockReturnValue(mocks.unsubscribeFullPageTranslationProgress);
  mocks.subscribeConfig.mockReturnValue(mocks.unsubscribeConfig);
});

afterEach(() => vi.unstubAllGlobals());

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

    options.props.onSettingsClick();
    options.props.onPositionChanged('left', 0.25);
    await Promise.resolve();
    expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
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

  it('隔离设置、保存和挂载失败，并允许重试', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.createVueShadowUi
      .mockRejectedValueOnce(new Error('mount failed'))
      .mockResolvedValueOnce(ui({toggleTranslation: vi.fn()}));
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    await expect(runtime.mountFloatingBall({} as never)).resolves.toBeNull();
    await expect(runtime.mountFloatingBall()).resolves.toEqual(expect.objectContaining({toggleTranslation: expect.any(Function)}));
    const [, options] = mocks.createVueShadowUi.mock.calls[1];

    mocks.sendMessage.mockRejectedValueOnce(new Error('settings failed'));
    mocks.requestConfigPatch.mockRejectedValueOnce(new Error('save failed'));
    options.props.onSettingsClick();
    options.props.onPositionChanged('right', 0.8);
    mocks.isFullPageTranslationActive.mockReturnValueOnce(false);
    options.props.onTranslationToggle(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 悬浮球挂载失败', expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error));
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

  it('没有 exposed instance 时仍防止重复挂载并可完整清理', async () => {
    const mountedUi = {
      remove: vi.fn(),
      shadowHost: document.createElement('div'),
      uiContainer: document.createElement('body'),
    };
    mocks.createVueShadowUi.mockResolvedValue(mountedUi);
    const runtime = await import('@/src/features/floating-ball/content/runtime');

    await expect(runtime.mountFloatingBall({} as never)).resolves.toBeNull();
    expect(runtime.mountFloatingBall()).toBeNull();
    expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    runtime.unmountFloatingBall();
    expect(mountedUi.remove).toHaveBeenCalledOnce();
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
    expect(runtime.mountTranslationProgressPanel()).toBe(request);
    pending.resolve(staleUi);
    await expect(request).resolves.toBeNull();
    await vi.waitFor(() => expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2));

    expect(staleUi.remove).toHaveBeenCalledOnce();
    runtime.unmountTranslationProgressPanel();
    expect(currentUi.remove).toHaveBeenCalledOnce();
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
