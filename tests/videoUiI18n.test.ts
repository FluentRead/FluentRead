import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

// Node 夹具没有扩展存储；替换浏览器边界，配置迁移与字幕 UI 仍执行实际实现。
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {
  getItem: vi.fn().mockResolvedValue(null), setItem: vi.fn().mockResolvedValue(undefined),
  removeItem: vi.fn().mockResolvedValue(undefined), watch: vi.fn().mockReturnValue(() => undefined),
}}));

import {
  createVideoPlayerMenu,
  handleVideoMenuDisclosure,
  closeVideoMenuDisclosure,
  handleVideoMenuNavigation,
  renderVideoSourceStatus,
  setVideoMenuToolsOpen,
  isVideoModelPromptOpen,
  renderVideoAiMenu,
  renderVideoAiModelSelection,
  focusVideoModelPromptReturn,
  renderVideoMenuMode,
  renderVideoSubtitleOrder,
  renderVideoModelPrompt,
  renderVideoSubtitleTiming,
  setVideoMenuDownloadStatus,
  syncVideoPlayerMenuLayout,
  revealVideoMenuBodyControl,
  type VideoAiMenuState,
} from '@/src/features/video-subtitle/content/playerMenu';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {refreshVideoUiAccessibility, refreshVideoUiText, clearRenderedVideoTranslation, deactivateNormalizedVideoCaption, readVideoPlaybackTimeMs} from '@/src/features/video-subtitle/content/ui';
import {VIDEO_LOCAL_TRANSCRIPTION_MODELS} from '@/src/features/video-subtitle/transcription';
import {confirmVideoSubtitleExport} from '@/src/features/video-subtitle/content/exportPrompt';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

/** LinkeDOM 不实现顶层提示；只替换浏览器端口，状态由 matches(':popover-open') 实时报告。 */
function mockReadingHelpPopover(menu: HTMLElement, options: {
  bounds?: {left: number; right: number; top: number; bottom: number};
  viewport?: {offsetLeft: number; offsetTop: number; width: number; height: number};
} = {}) {
  const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
  const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
  let open = false;
  let toggleHovered = false, helpHovered = false;
  const show = vi.fn(() => {open = true;});
  const hide = vi.fn(() => {open = false;});
  help.setAttribute('popover', 'manual');
  Object.defineProperties(help, {
    showPopover: {configurable: true, value: show},
    hidePopover: {configurable: true, value: hide},
    getBoundingClientRect: {configurable: true, value: () => ({height: 180})},
  });
  Object.defineProperty(toggle, 'getBoundingClientRect', {
    configurable: true, value: () => options.bounds || ({left: 350, right: 380, top: 300, bottom: 330}),
  });
  const matches = help.matches.bind(help);
  const toggleMatches = toggle.matches.bind(toggle);
  vi.spyOn(help, 'matches').mockImplementation(selector => selector === ':popover-open' ? open
    : selector === ':hover' ? helpHovered : matches(selector));
  vi.spyOn(toggle, 'matches').mockImplementation(selector => selector === ':hover' ? toggleHovered : toggleMatches(selector));
  vi.stubGlobal('window', {innerWidth: 800, innerHeight: 600, visualViewport: options.viewport});
  return {show, hide, browserAutoClose: () => {open = false;},
    hover: (icon: boolean, card: boolean) => {toggleHovered = icon; helpHovered = card;}};
}

describe('player subtitle timing', () => {
  it('清理自有字幕层并读取原媒体时钟，空播放器不伪造位置', () => {
    const {document} = parseHTML('<body><div id="movie_player"><video class="html5-main-video"></video></div><div id="ytp-caption-window-container" class="fluent-read-video-normalized-caption"></div><div id="fluent-read-video-subtitle-layer" class="fluent-read-video-normalized-caption-active"></div><div id="fluent-read-video-subtitle">Translated</div><div id="fluent-read-video-subtitle-original">Original</div><p id="host">Host content</p></body>');
    const player = document.querySelector<HTMLElement>('#movie_player')!;
    const video = player.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperty(video, 'currentTime', {value: 1.25, configurable: true});
    expect(readVideoPlaybackTimeMs(player, null)).toBe(1250);
    expect(readVideoPlaybackTimeMs(null, video)).toBe(1250);
    expect(readVideoPlaybackTimeMs(null, null)).toBeNaN();
    Object.defineProperty(video, 'currentTime', {value: Infinity});
    expect(readVideoPlaybackTimeMs(player, null)).toBeNaN();
    clearRenderedVideoTranslation(document); deactivateNormalizedVideoCaption(document);
    expect(document.querySelector('#fluent-read-video-subtitle')?.textContent).toBe('');
    expect(document.querySelector('#fluent-read-video-subtitle-original')?.textContent).toBe('');
    expect(document.querySelector('#host')?.textContent).toBe('Host content');
    expect(document.querySelector('#ytp-caption-window-container')?.classList.contains('fluent-read-video-normalized-caption')).toBe(false);
    expect(document.querySelector('#fluent-read-video-subtitle-layer')?.classList.contains('fluent-read-video-normalized-caption-active')).toBe(false);
  });

  it('renders a single-row stepper, hides the row without a timeline and keeps reset for saved offsets', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    const row = menu.querySelector<HTMLElement>('[data-timing-row]')!;
    const earlier = menu.querySelector<HTMLButtonElement>('[data-action="subtitle-earlier"]')!;
    const later = menu.querySelector<HTMLButtonElement>('[data-action="subtitle-later"]')!;
    const reset = menu.querySelector<HTMLButtonElement>('[data-action="reset-subtitle-timing"]')!;
    expect(row.textContent).toContain('Timing');
    renderVideoSubtitleTiming(menu, -500, true, 'en-US');
    expect(earlier.getAttribute('aria-label')).toBe('0.5 s earlier');
    expect(later.title).toBe('0.5 s later');
    expect(menu.querySelector('[data-subtitle-offset]')?.textContent).toBe('-0.5 s');
    expect(row.hidden).toBe(false);
    expect(earlier.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
    renderVideoSubtitleTiming(menu, -10000, true, 'en-US');
    expect(earlier.disabled).toBe(true);
    renderVideoSubtitleTiming(menu, 10000, true, 'en-US');
    expect(later.disabled).toBe(true);
    expect(menu.querySelector('[data-subtitle-offset]')?.textContent).toBe('+10.0 s');
    renderVideoSubtitleTiming(menu, 500, false, 'en-US');
    expect(earlier.disabled && later.disabled).toBe(true);
    expect(reset.disabled).toBe(false);
    expect(row.hidden).toBe(false);
    expect(row.title).toBe('Timing adjustment is unavailable for these captions');
    renderVideoSubtitleTiming(menu, 0, false, 'en-US');
    expect(row.hidden).toBe(true);
    renderVideoSubtitleTiming(menu, 0, true, 'en-US');
    expect(row.hidden).toBe(false);
    expect(reset.disabled).toBe(true);
    expect(menu.querySelector('[data-action="subtitle-earlier"]')).toBe(earlier);
  });
});

const progress = (value: number): VideoAiMenuState['progress'] => ({
  phase: 'transcribing',
  progress: value,
  capturedMs: 2_000,
  durationMs: 4_000,
  transcribedMs: 1_000,
  windowIndex: 1,
  windowCount: 2,
});

function state(overrides: Partial<VideoAiMenuState> = {}): VideoAiMenuState {
  return {
    available: true,
    checking: false,
    active: false,
    fullActive: false,
    phase: 'idle',
    progress: progress(0),
    error: '',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('video player menu composition', () => {
  it.each([false, true])('双语顺序按钮独立保存选中态，语言刷新保留节点（紧凑菜单：%s）', compact => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', compact);
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('[data-subtitle-order]')];
    expect(choices.map(button => button.textContent)).toEqual(['原文在上', '译文在上']);
    expect(choices.map(button => [...button.querySelectorAll('.fluent-read-video-menu-order-diagram > span')].map(line => line.className)))
      .toEqual([['fluent-read-video-menu-order-original', 'fluent-read-video-menu-order-translation'], ['fluent-read-video-menu-order-translation', 'fluent-read-video-menu-order-original']]);
    expect(choices.every(button => button.querySelector('.fluent-read-video-menu-order-diagram')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    renderVideoSubtitleOrder(menu, 'original-first', false);
    expect(choices.map(button => button.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    renderVideoSubtitleOrder(menu, 'translation-first', false);
    expect(choices.map(button => button.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    const attributeWrites = choices.map(button => vi.spyOn(button, 'setAttribute'));
    renderVideoSubtitleOrder(menu, 'translation-first', false);
    expect(attributeWrites.every(spy => spy.mock.calls.length === 0)).toBe(true);
    attributeWrites.forEach(spy => spy.mockRestore());
    expect(choices.every(button => button.getAttribute('role') === 'menuitemradio')).toBe(true);
    refreshVideoUiText(menu, 'en-US');
    expect(choices.map(button => button.textContent)).toEqual(['Original above', 'Translation above']);
    expect(menu.querySelector('[data-subtitle-order]')).toBe(choices[0]);
    expect(menu.querySelector('.fluent-read-video-menu-order-controls')?.getAttribute('aria-label')).toBe('Bilingual order');
    renderVideoSubtitleOrder(menu, 'translation-first', false, false);
    expect(choices.every(button => button.disabled)).toBe(true);
    const hint = menu.querySelector<HTMLElement>('[data-subtitle-order-hint]')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Applies to bilingual subtitles; your chosen order is kept');
    expect(choices.map(button => button.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(menu.querySelector('.fluent-read-video-menu-order-setting')?.getAttribute('data-active')).toBe('false');
    renderVideoSubtitleOrder(menu, 'translation-first', false, true);
    expect(choices.every(button => !button.disabled)).toBe(true);
    expect(hint.hidden).toBe(true);
    renderVideoSubtitleOrder(menu, 'translation-first', true);
    expect(choices.every(button => button.disabled)).toBe(true);
    expect(hint.hidden).toBe(true);
    const showOriginal = menu.querySelector<HTMLButtonElement>('[data-reading-bilingual]')!;
    expect(showOriginal.dataset.action).toBe('show-reading-original');
    expect(showOriginal.hasAttribute('data-mode')).toBe(false);
    expect(showOriginal.getAttribute('role')).toBe('menuitem');
    renderVideoMenuMode(menu, 'translation-only', false, '');
    expect(showOriginal.hasAttribute('aria-checked')).toBe(false);
  });

  it.each([false, true])('keeps subtitle downloads collapsed until requested (local generation: %s)', withLocalGeneration => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', withLocalGeneration);
    menu.hidden = false;
    const disclosure = menu.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!;
    const choices = menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!;
    const status = menu.querySelector<HTMLElement>('[data-download-status]')!;
    const group = choices.closest<HTMLElement>('[data-download-group]')!;
    const actions = [...choices.querySelectorAll<HTMLButtonElement>('button')];
    expect(disclosure.textContent).toBe('');
    expect(disclosure.getAttribute('aria-label')).toBe('下载字幕');
    expect(disclosure.closest('.fluent-read-video-menu-title')).toBeTruthy();
    expect(menu.querySelector('.fluent-read-video-menu-body [data-action="toggle-subtitle-downloads"]')).toBeNull();
    expect(disclosure.getAttribute('aria-controls')).toBe(choices.id);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(choices.hidden).toBe(true);
    expect(group.hidden).toBe(true);
    expect(actions.map(button => button.dataset.action)).toEqual([
      'download-subtitles', 'download-translated-subtitles', 'download-bilingual-subtitles',
    ]);
    expect(choices.contains(status)).toBe(false);
    expect(handleVideoMenuDisclosure(menu, undefined)).toBe(false);
    expect(handleVideoMenuDisclosure(menu, 'download-subtitles')).toBe(false);
    expect(handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads')).toBe(true);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(choices.hidden).toBe(false);
    expect(group.hidden).toBe(false);
    setVideoMenuDownloadStatus(menu, '下载完成');
    handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(choices.hidden).toBe(true);
    expect(status.closest('[hidden]')).toBeNull();
    expect([...choices.querySelectorAll('button')]).toEqual(actions);
    setVideoMenuDownloadStatus(menu, '');
    expect(group.hidden).toBe(true);
  });

  it('skips collapsed download choices during keyboard navigation and reaches them when expanded', () => {
    const {document, HTMLElement} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', HTMLElement);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    const lastChoice = menu.querySelector<HTMLButtonElement>('[data-action="download-bilingual-subtitles"]')!;
    const learning = menu.querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!;
    const timing = menu.querySelector<HTMLButtonElement>('[data-action="subtitle-later"]')!;
    const choiceFocus = vi.spyOn(lastChoice, 'focus');
    const timingFocus = vi.spyOn(timing, 'focus');
    const navigate = () => handleVideoMenuNavigation({key: 'ArrowUp', target: learning, currentTarget: menu,
      isTrusted: true, stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
    navigate();
    expect(choiceFocus).not.toHaveBeenCalled();
    expect(timingFocus).toHaveBeenCalledOnce();
    handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
    navigate();
    expect(choiceFocus).toHaveBeenCalledOnce();
  });

  it('uses a header reading icon and reveals its help on hover or focus without changing the preference', () => {
    vi.useFakeTimers();
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', false);
    menu.hidden = false;
    const popover = mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const details = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    expect(toggle.closest('.fluent-read-video-menu-title')).toBeTruthy();
    expect(menu.querySelector('.fluent-read-video-menu-body [data-action="toggle-reading-annotation"]')).toBeNull();
    expect(menu.querySelector('.fluent-read-video-menu-playback-controls')).toBeNull();
    expect(toggle.textContent).toBe('');
    expect(toggle.querySelector('svg')).toBeTruthy();
    expect(toggle.getAttribute('aria-label')).toBe('读音标注');
    expect(toggle.getAttribute('aria-describedby')).toBe(details.id);
    expect(menu.querySelector('[data-action="toggle-reading-help"]')).toBeNull();
    expect(menu.querySelector('.fluent-read-video-menu-switch')).toBeNull();
    expect(details.hidden).toBe(true);
    toggle.dispatchEvent(new window.Event('pointerenter'));
    expect(details.hidden).toBe(false);
    expect(popover.show).toHaveBeenCalledOnce();
    expect(details.textContent).toContain('在原文字幕下显示拼音或罗马音，帮助你跟读。');
    expect(details.querySelector('[lang="ja"]')?.textContent).toBe('今日はいい天気ですね。');
    expect(details.querySelector('[lang="ja-Latn"]')?.textContent).toBe('kyō wa ii tenki desu ne.');
    menu.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(120);
    expect(details.hidden).toBe(true);
    toggle.dispatchEvent(new window.Event('focus'));
    expect(details.hidden).toBe(false);
    // 点击交由读音设置处理，不应再把同一图标当作帮助展开按钮。
    expect(handleVideoMenuDisclosure(menu, 'toggle-reading-annotation')).toBe(false);
    toggle.dispatchEvent(new window.Event('click'));
    expect(details.hidden).toBe(true);
    expect(popover.hide).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps native title help without expanding a header card when Popover is unavailable', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    expect(help.hasAttribute('popover')).toBe(false);
    expect(toggle.title).toContain('Show pinyin or romanized readings below the original subtitles');
    expect(toggle.getAttribute('aria-describedby')).toBe(help.id);
    toggle.dispatchEvent(new window.Event('pointerenter'));
    toggle.dispatchEvent(new window.Event('focus'));
    expect(help.hidden).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('detects native Popover when building the menu and ignores help requests while hidden or inert', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const prototype = window.HTMLElement.prototype;
    const previous = Object.getOwnPropertyDescriptor(prototype, 'showPopover');
    Object.defineProperty(prototype, 'showPopover', {configurable: true, value: vi.fn()});
    try {
      const menu = createVideoPlayerMenu('en-US', false);
      const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
      const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
      expect(help.getAttribute('popover')).toBe('manual');
      const popover = mockReadingHelpPopover(menu);
      toggle.dispatchEvent(new window.Event('pointerenter'));
      expect(popover.show).not.toHaveBeenCalled();
      expect(help.hidden).toBe(true);
      menu.hidden = false;
      menu.setAttribute('inert', '');
      toggle.dispatchEvent(new window.Event('focus'));
      expect(popover.show).not.toHaveBeenCalled();
      expect(help.hidden).toBe(true);
      menu.removeAttribute('inert');
      toggle.dispatchEvent(new window.Event('pointerenter'));
      expect(popover.show).toHaveBeenCalledOnce();
      expect(help.hidden).toBe(false);
    } finally {
      if (previous) Object.defineProperty(prototype, 'showPopover', previous);
      else Reflect.deleteProperty(prototype, 'showPopover');
    }
  });

  it('keeps help during pointer transfers and retained focus, then closes when both leave', () => {
    vi.useFakeTimers();
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('Node', window.Node);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    const popover = mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    let active: Element | null = null;
    Object.defineProperty(document, 'activeElement', {configurable: true, get: () => active});
    const leave = (element: HTMLElement, relatedTarget?: Node) => {
      const event = new window.Event('pointerleave');
      if (relatedTarget) Object.defineProperty(event, 'relatedTarget', {value: relatedTarget});
      element.dispatchEvent(event);
    };
    const open = () => toggle.dispatchEvent(new window.Event('pointerenter'));
    open();
    leave(toggle, help);
    leave(menu, help.querySelector('p')!);
    leave(help, toggle);
    expect(help.hidden).toBe(false);
    expect(popover.hide).not.toHaveBeenCalled();
    active = toggle;
    leave(toggle, document.body);
    leave(help, document.body);
    menu.dispatchEvent(new window.Event('pointerleave'));
    expect(help.hidden).toBe(false);
    active = null;
    leave(toggle);
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(true);
    open();
    leave(help);
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(true);
    open();
    popover.hover(true, false);
    toggle.dispatchEvent(new window.Event('blur'));
    expect(help.hidden).toBe(false);
    popover.hover(false, true);
    toggle.dispatchEvent(new window.Event('blur'));
    expect(help.hidden).toBe(false);
    popover.hover(false, false);
    toggle.dispatchEvent(new window.Event('blur'));
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(true);
    expect(popover.hide).toHaveBeenCalledTimes(3);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('opens and closes the top-layer reading help without measuring the player menu', () => {
    vi.useFakeTimers();
    const {document, window} = parseHTML('<!doctype html><body><div id="player"></div></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    const player = document.getElementById('player')!;
    player.appendChild(menu);
    Object.defineProperties(player, {clientWidth: {value: 800}, clientHeight: {value: 450}});
    const measureMenu = vi.fn(() => 300);
    Object.defineProperty(menu, 'scrollHeight', {get: measureMenu});
    menu.hidden = false;
    mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    toggle.dispatchEvent(new window.Event('pointerenter'));
    menu.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(120);
    expect(measureMenu).not.toHaveBeenCalled();
    expect(menu.querySelector<HTMLElement>('[data-reading-help]')!.hidden).toBe(true);
  });

  it('keeps reading help across the pointer gap and cancels pending dismissal on explicit close', () => {
    vi.useFakeTimers();
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('Node', window.Node);
    const menu = createVideoPlayerMenu('en-US', false); menu.hidden = false;
    const popover = mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    toggle.dispatchEvent(new window.Event('pointerenter'));
    toggle.dispatchEvent(new window.Event('pointerleave'));
    menu.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(60);
    expect(help.hidden).toBe(false);
    help.dispatchEvent(new window.Event('pointerenter'));
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(false);
    expect(popover.hide).not.toHaveBeenCalled();
    help.dispatchEvent(new window.Event('pointerleave'));
    expect(closeVideoMenuDisclosure(menu)).toBe(true);
    expect(help.hidden).toBe(true);
    toggle.dispatchEvent(new window.Event('pointerenter'));
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(false);
    toggle.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(120);
    expect(help.hidden).toBe(true);
  });

  it('fits help inside a panned narrow visual viewport and places it below an icon near the top', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    const viewport = {offsetLeft: 120, offsetTop: 80, width: 240, height: 300};
    const bounds = {left: 125, right: 153, top: 86, bottom: 114};
    mockReadingHelpPopover(menu, {viewport, bounds});
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    toggle.dispatchEvent(new window.Event('focus'));
    const metric = (name: string) => Number.parseFloat(help.style.getPropertyValue(`--fr-reading-help-${name}`));
    expect(help.hidden).toBe(false);
    expect(metric('width')).toBeLessThanOrEqual(viewport.width - 16);
    expect(metric('left')).toBeGreaterThanOrEqual(viewport.offsetLeft + 8);
    expect(metric('left') + metric('width')).toBeLessThanOrEqual(viewport.offsetLeft + viewport.width - 8);
    expect(metric('top')).toBeGreaterThanOrEqual(bounds.bottom);
    expect(metric('top') + help.getBoundingClientRect().height).toBeLessThanOrEqual(viewport.offsetTop + viewport.height - 8);
    expect(metric('max-height')).toBeLessThanOrEqual(viewport.height - 16);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reopens help after the browser closes its native popover during a menu move', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    const popover = mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    toggle.dispatchEvent(new window.Event('pointerenter'));
    expect(popover.show).toHaveBeenCalledOnce();
    popover.browserAutoClose();
    expect(closeVideoMenuDisclosure(menu)).toBe(false);
    toggle.dispatchEvent(new window.Event('pointerenter'));
    expect(popover.show).toHaveBeenCalledTimes(2);
  });

  it('Escape closes reading help before downloads and returns focus to their disclosure', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    mockReadingHelpPopover(menu);
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const downloads = menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!;
    const disclosure = menu.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!;
    const focus = vi.spyOn(disclosure, 'focus');
    handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
    toggle.dispatchEvent(new window.Event('pointerenter'));
    expect(closeVideoMenuDisclosure(menu)).toBe(true);
    expect(help.hidden).toBe(true);
    expect(downloads.hidden).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(closeVideoMenuDisclosure(menu)).toBe(true);
    expect(downloads.hidden).toBe(true);
    expect(focus).toHaveBeenCalledWith({preventScroll: true});
    expect(closeVideoMenuDisclosure(menu)).toBe(false);
  });

  it('resets tools disclosures on Back and does not consume Escape for invisible content', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', true);
    menu.hidden = false;
    mockReadingHelpPopover(menu);
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const downloads = menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!;
    setVideoMenuToolsOpen(menu, true);
    toggle.dispatchEvent(new window.Event('pointerenter'));
    handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
    // 极矮视口会临时隔离控件，不可见或不可交互内容不得抢走 Escape。
    menu.setAttribute('inert', '');
    expect(closeVideoMenuDisclosure(menu)).toBe(false);
    menu.removeAttribute('inert');
    setVideoMenuToolsOpen(menu, false);
    expect(help.hidden).toBe(true);
    expect(downloads.hidden).toBe(true);
    expect(menu.querySelector('[data-action="toggle-subtitle-downloads"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(closeVideoMenuDisclosure(menu)).toBe(false);
    setVideoMenuToolsOpen(menu, true);
    expect(help.hidden).toBe(true);
    expect(downloads.hidden).toBe(true);
    expect(closeVideoMenuDisclosure(menu)).toBe(false);
  });

  it('relocalizes reading icon help while preserving the icon, checked state and fixed sample', () => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', false);
    menu.hidden = false;
    mockReadingHelpPopover(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const icon = toggle.querySelector('svg')!;
    const downloads = menu.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!;
    const downloadIcon = downloads.querySelector('svg')!;
    toggle.setAttribute('aria-checked', 'true');
    toggle.dispatchEvent(new window.Event('pointerenter'));
    refreshVideoUiText(menu, 'en-US');
    expect(toggle.getAttribute('aria-label')).toBe('Reading annotations');
    expect(toggle.title).toContain('Show pinyin or romanized readings below the original subtitles');
    expect(toggle.textContent).toBe('');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-reading-help]')?.textContent).toContain('Show pinyin or romanized readings below the original subtitles');
    expect(menu.querySelector('[data-reading-help]')?.hasAttribute('hidden')).toBe(false);
    expect(toggle.querySelector('svg')).toBe(icon);
    expect(downloads.querySelector('svg')).toBe(downloadIcon);
    expect(menu.querySelector('[data-reading-help] [lang="ja"]')?.textContent).toBe('今日はいい天気ですね。');
    expect(menu.querySelector('[data-reading-help] [lang="ja-Latn"]')?.textContent).toBe('kyō wa ii tenki desu ne.');
  });

  it.each(['model', 'export'])('clears reading help on entering a %s prompt while retaining expanded downloads', async promptKind => {
    const {document, window} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', true);
    menu.hidden = false;
    const popover = mockReadingHelpPopover(menu);
    document.body.appendChild(menu);
    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
    const help = menu.querySelector<HTMLElement>('[data-reading-help]')!;
    const choices = menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!;
    const disclosure = menu.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!;
    toggle.dispatchEvent(new window.Event('pointerenter'));
    handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
    expect(help.hidden).toBe(false);
    expect(choices.hidden).toBe(false);
    const controller = new AbortController();
    let result: Promise<unknown> | undefined;
    try {
      if (promptKind === 'model') renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS,
        downloaded: [], recommended: 'base', selected: 'base'}, 'en-US');
      else result = confirmVideoSubtitleExport(menu, {total: 4, ready: 2, missing: 2, requests: 1,
        human: 1, cached: 1, startMs: 4000, endMs: 7000}, true, controller.signal, key => key);
      expect(help.hidden).toBe(true);
      expect(popover.hide).toHaveBeenCalledOnce();
      expect(choices.hidden).toBe(false);
      expect(disclosure.getAttribute('aria-expanded')).toBe('true');
      expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden).toBe(true);
      expect(toggle.closest('[hidden]')).toBeTruthy();
      expect(disclosure.hidden).toBe(true);
    } finally {
      if (promptKind === 'model') renderVideoModelPrompt(menu, null, 'en-US');
      else {controller.abort(); await result;}
    }
  });

  it('updates menu and subtitle accessibility while the player entry button is unmounted', () => {
    const {document} = parseHTML('<!doctype html><body><div id="fluent-read-video-subtitle-panel"></div><div id="fluent-read-video-subtitle"></div><div id="fluent-read-video-subtitle-original"></div></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const button = document.createElement('button');
    refreshVideoUiAccessibility(menu, button, document, 'zh-CN', '已开启');
    const chineseLabel = menu.getAttribute('aria-label');
    refreshVideoUiAccessibility(menu, null, document, 'en-US', 'Enabled');
    expect(menu.getAttribute('aria-label')).not.toBe(chineseLabel);
    expect(menu.querySelector('.fluent-read-video-menu-mode-group')?.getAttribute('aria-label')).toBeTruthy();
    for (const element of document.querySelectorAll('[id]')) {
      expect(element.getAttribute('aria-label')).toBeTruthy();
    }
    refreshVideoUiAccessibility(menu, button, document, 'en-US', 'Enabled');
    expect(button.getAttribute('aria-label')).toContain('Enabled');
    expect(button.title).toBe(button.getAttribute('aria-label'));
  });

  it('keeps viewing controls primary and places timing, export and regeneration in a returnable options page', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);

    const menu = createVideoPlayerMenu('zh-CN', true);
    expect(menu.id).toBe('fluent-read-video-subtitle-menu');
    expect(menu.hidden).toBe(true);
    expect(menu.dataset.layout).toBe('stack');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBeTruthy();
    expect(menu.getAttribute('data-fluent-read-ui')).toBe('video-subtitle');
    expect(menu.getAttribute('translate')).toBe('no');
    expect(menu.querySelector('[data-action="toggle-translation"], [data-action="toggle-visible"]')).toBeNull();
    expect([...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].map(button => [
      button.tagName, button.dataset.action, button.getAttribute('aria-label') ?? button.textContent?.trim(), button.getAttribute('aria-checked'),
    ])).toEqual([
      ['BUTTON', 'toggle-reading-annotation', '读音标注', 'false'],
      ['BUTTON', 'toggle-ai-subtitle', '生成 AI 字幕', 'false'],
    ]);
    expect([...menu.querySelectorAll<HTMLElement>('.fluent-read-video-menu-mode-group [data-mode]')].map(item => [item.dataset.mode, item.textContent]))
      .toEqual([['bilingual', '双语'], ['translation-only', '译文'], ['original-only', '原文'], ['off', '关闭']]);
    const display = menu.querySelector('.fluent-read-video-menu-watch')!;
    expect(display.querySelector('.fluent-read-video-menu-mode-group')).toBeTruthy();
    expect(display.querySelector('[data-timing-row]')).toBeNull();
    const tools = menu.querySelector<HTMLElement>('.fluent-read-video-menu-tools')!;
    expect(tools.hidden).toBe(true);
    expect(display.querySelector('[data-action="toggle-reading-annotation"]')).toBeNull();
    expect(tools.querySelector('[data-action="toggle-reading-annotation"]')).toBeNull();
    expect(menu.querySelector('.fluent-read-video-menu-title [data-action="toggle-reading-annotation"]')).toBeTruthy();
    expect(menu.querySelector('.fluent-read-video-menu-title [data-action="toggle-subtitle-downloads"]')).toBeTruthy();
    expect(tools.querySelector('[data-timing-row]')).toBeTruthy();
    const timingControls = menu.querySelector('.fluent-read-video-menu-timing-controls');
    expect([...timingControls!.children].map(element => element.getAttribute('data-action') || element.getAttribute('data-subtitle-offset')))
      .toEqual(['reset-subtitle-timing', 'subtitle-earlier', 'true', 'subtitle-later']);
    const actions = menu.querySelector('.fluent-read-video-menu-body')!;
    expect(display.querySelector('.fluent-read-video-menu-ai-group [data-action="toggle-ai-subtitle"]')).toBeTruthy();
    expect([...actions.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')].map(button => [button.dataset.action, button.textContent, button.getAttribute('aria-label')]))
      .toEqual([
        ['download-subtitles', '原文', '下载原文字幕'],
        ['download-translated-subtitles', '译文', '下载译文字幕'],
        ['download-bilingual-subtitles', '双语', '下载双语字幕'],
      ]);
    expect(actions.querySelector('[data-download-status]')?.getAttribute('aria-live')).toBe('polite');
    expect(menu.querySelector<HTMLElement>('[data-model-prompt]')?.hidden).toBe(true);
    setVideoMenuToolsOpen(menu, true);
    expect(display.hasAttribute('hidden')).toBe(true);
    expect(tools.hidden).toBe(false);
    expect(menu.querySelector('[data-action="open-subtitle-tools"]')?.getAttribute('aria-expanded')).toBe('true');
    setVideoMenuToolsOpen(menu, false);
    expect(tools.hidden).toBe(true);

    const withoutLocalGeneration = createVideoPlayerMenu('en-US', false);
    expect(withoutLocalGeneration.querySelector('[data-action="toggle-ai-subtitle"]')).toBeNull();
    expect(withoutLocalGeneration.querySelector('[data-model-prompt]')).toBeNull();
    expect(withoutLocalGeneration.querySelector('.fluent-read-video-menu-mode-group')?.textContent).toBe('BothTranslatedOriginalOff');
  });

  it('renders the selected display choice, disables it when FluentRead is globally off and relocalizes keyed labels', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const checked = () => [...menu.querySelectorAll<HTMLElement>('[data-mode][aria-checked="true"]')].map(item => item.dataset.mode);

    renderVideoMenuMode(menu, 'translation-only', false, '');
    expect(checked()).toEqual(['translation-only']);
    renderVideoMenuMode(menu, 'off', true, 'FluentRead 总开关已关闭');
    expect(checked()).toEqual(['off']);
    expect([...menu.querySelectorAll<HTMLButtonElement>('[data-mode]')].every(item => item.disabled)).toBe(true);
    expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-mode-group')?.title).toBe('FluentRead 总开关已关闭');

    refreshVideoUiText(menu, 'ja-JP');
    expect(menu.querySelector('[data-mode="off"]')?.textContent).toBe('オフ');
    expect(menu.querySelector('[data-mode="off"]')?.getAttribute('title')).toContain('FluentRead');
    expect(menu.querySelector('[data-action="download-translated-subtitles"]')?.getAttribute('aria-label')).toBe(
      menu.querySelector('[data-action="download-translated-subtitles"]')?.getAttribute('title'),
    );
  });

  it('explains missing, cached, native and failed captions with only relevant recovery actions', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const state = {enabled: true, source: 'none' as const, cueCount: 0, checking: false,
      generating: false, translationFailed: false, canRegenerate: false};
    const status = menu.querySelector('[data-source-status]')!;
    const retry = menu.querySelector<HTMLButtonElement>('[data-action="retry-subtitle-translation"]')!;
    const regenerate = menu.querySelector<HTMLButtonElement>('[data-action="regenerate-ai-subtitle"]')!;
    renderVideoSourceStatus(menu, state, 'zh-CN');
    expect(status.textContent).toBe('暂未检测到字幕');
    expect(menu.querySelector('[data-source-hint]')?.textContent).toContain('本地 AI');
    expect(retry.hidden && regenerate.hidden).toBe(true);
    expect([...menu.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')].every(button => button.disabled)).toBe(true);
    renderVideoSourceStatus(menu, {...state, checking: true}, 'en-US');
    expect(status.textContent).toBe('Checking saved subtitles…');
    renderVideoSourceStatus(menu, {...state, source: 'cache', cueCount: 12, canRegenerate: true, translationFailed: true}, 'zh-CN');
    expect(status.textContent).toBe('本地字幕 · 12 条');
    expect(retry.hidden || regenerate.hidden).toBe(false);
    expect(menu.querySelector('[data-source-hint]')?.textContent).toBe('这句翻译失败');
    expect(menu.querySelector('[data-action="toggle-ai-subtitle"]')?.closest('.fluent-read-video-menu-tools')).toBeTruthy();
    expect(regenerate.closest('.fluent-read-video-menu-tools')).toBeTruthy();
    setVideoMenuToolsOpen(menu, true);
    const download = menu.querySelector<HTMLButtonElement>('.fluent-read-video-menu-download')!;
    download.disabled = true;
    download.setAttribute('aria-busy', 'true');
    renderVideoSourceStatus(menu, {...state, source: 'native', cueCount: 2}, 'en-US');
    expect(status.textContent).toBe('Loaded subtitles · 2 cues');
    expect(menu.dataset.panel).toBe('tools');
    expect(download.disabled).toBe(true);
    expect(retry.hidden && regenerate.hidden).toBe(true);
    renderVideoSourceStatus(menu, {...state, generating: true}, 'zh-CN');
    expect(menu.dataset.panel).toBe('watch');
    expect(menu.querySelector('[data-action="toggle-ai-subtitle"]')?.closest('.fluent-read-video-menu-primary-ai')).toBeTruthy();
    renderVideoSubtitleTiming(menu, 500, false, 'zh-CN');
    renderVideoSourceStatus(menu, state, 'zh-CN');
    expect(menu.querySelector<HTMLElement>('[data-action="open-subtitle-tools"]')?.hidden).toBe(false);
    renderVideoSubtitleTiming(menu, 0, false, 'zh-CN');
    renderVideoSourceStatus(menu, state, 'zh-CN');
    expect(menu.querySelector<HTMLElement>('[data-action="open-subtitle-tools"]')?.hidden).toBe(true);
    renderVideoSourceStatus(menu, {...state, enabled: false}, 'zh-CN');
    expect(status.textContent).toBe('字幕已关闭');
  });

  it('reveals the localized Base failure after regeneration clears a cached source in the tools pane', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', true);
    const source = {enabled: true, source: 'cache' as const, cueCount: 1, checking: false,
      generating: false, translationFailed: false, canRegenerate: true};
    renderVideoSourceStatus(menu, source, 'en-US');
    setVideoMenuToolsOpen(menu, true);
    // startGeneration stops the previous session before the new capture begins.
    renderVideoSourceStatus(menu, {...source, source: 'none', cueCount: 0, canRegenerate: false}, 'en-US');
    renderVideoAiMenu(menu, state({phase: 'error', error: '本地 AI 没有识别出可读字幕，请确认视频有清晰人声并检查视频原语言后重试'}), 'en-US');
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;
    expect(menu.dataset.panel).toBe('watch');
    expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-watch')?.hidden).toBe(false);
    expect(button.closest('.fluent-read-video-menu-primary-ai')?.hasAttribute('hidden')).toBe(false);
    expect(button.querySelector('[data-state]')?.textContent).toContain('clear speech');
    expect(button.title).toBe(button.querySelector('[data-state]')?.textContent);
    expect(button.textContent).not.toContain('Base');
  });

  it('keeps model selection reachable before captions exist and preserves the chosen tools view', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const source = {enabled: true, source: 'none' as const, cueCount: 0, checking: false,
      generating: false, translationFailed: false, canRegenerate: false, canChooseModel: true};
    renderVideoAiModelSelection(menu, {model: 'base', available: true, disabled: false}, 'zh-CN');
    renderVideoSourceStatus(menu, source, 'zh-CN');
    const model = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]')!;
    expect(model.textContent).toBe('识别模型：Base · 标准');
    expect(model.hidden || model.disabled).toBe(false);
    expect(model.dataset.model).toBe('base');
    expect(model.getAttribute('aria-controls')).toBe('fluent-read-video-model-prompt');
    expect(model.hasAttribute('aria-haspopup')).toBe(false);
    expect(menu.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]')!.hidden).toBe(false);
    setVideoMenuToolsOpen(menu, true);
    renderVideoSourceStatus(menu, source, 'zh-CN');
    expect(menu.dataset.panel).toBe('tools');
    expect(model.closest('.fluent-read-video-menu-tools')?.hasAttribute('hidden')).toBe(false);
    renderVideoAiModelSelection(menu, {model: 'small', available: true, disabled: true}, 'en-US');
    expect(menu.querySelector('[data-action="select-ai-model"]')).toBe(model);
    expect(model.disabled).toBe(true);
    expect(model.textContent).toContain('Recognition model: Small');
    expect(model.getAttribute('aria-label')).toContain('currently Small');
    renderVideoAiModelSelection(menu, {model: 'small', available: false, disabled: false}, 'en-US');
    expect(model.hidden && model.disabled).toBe(true);
    renderVideoSubtitleTiming(menu, 0, false, 'en-US');
    renderVideoSourceStatus(menu, {...source, canChooseModel: false}, 'en-US');
    expect(menu.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]')!.hidden).toBe(true);
    expect(() => renderVideoAiModelSelection(createVideoPlayerMenu('en-US', false), {model: 'tiny', available: true, disabled: false}, 'en-US')).not.toThrow();
  });

  it('disables complete exports during AI previews and releases them only when ready, without blocking native captions', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const source = {enabled: true, source: 'ai' as const, cueCount: 1, checking: false,
      generating: true, translationFailed: false, canRegenerate: false};
    const downloads = [...menu.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')];
    renderVideoSourceStatus(menu, source, 'zh-CN');
    expect(downloads.every(button => button.disabled)).toBe(true);
    renderVideoSourceStatus(menu, {...source, generating: false}, 'zh-CN');
    expect(downloads.every(button => !button.disabled)).toBe(true);
    renderVideoSourceStatus(menu, {...source, source: 'native'}, 'zh-CN');
    expect(downloads.every(button => !button.disabled)).toBe(true);
    renderVideoSourceStatus(menu, {...source, source: 'none', cueCount: 0}, 'zh-CN');
    expect(downloads.every(button => button.disabled)).toBe(true);
  });

  it('reuses the model prompt for voluntary selection without claiming downloaded choices need another download', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const model = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]')!;
    const choice = {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: ['base'] as const, recommended: 'small' as const, selected: 'base' as const, purpose: 'selection' as const};
    renderVideoAiModelSelection(menu, {model: 'base', available: true, disabled: false}, 'zh-CN');
    renderVideoModelPrompt(menu, choice, 'zh-CN');
    expect(menu.querySelector('.fluent-read-video-model-prompt-title')?.textContent).toBe('选择 AI 字幕模型');
    expect(menu.querySelector('.fluent-read-video-model-prompt-description')?.textContent).toBe('选择模型后重新识别当前视频。');
    expect(menu.querySelector('[data-action="model-prompt-confirm"]')?.textContent).toBe('开始生成');
    expect(model.getAttribute('aria-expanded')).toBe('true');
    renderVideoAiModelSelection(menu, {model: 'base', available: true, disabled: false}, 'en-US');
    expect(model.getAttribute('aria-expanded')).toBe('true');
    const modelLabel = model.getAttribute('aria-label');
    const modelText = model.querySelector('.fluent-read-video-menu-label')!.firstChild;
    refreshVideoUiText(menu, 'en-US');
    expect(model.getAttribute('aria-label')).toBe(modelLabel);
    expect(model.querySelector('.fluent-read-video-menu-label')!.firstChild).toBe(modelText);
    renderVideoModelPrompt(menu, null, 'zh-CN');
    expect(model.getAttribute('aria-expanded')).toBe('false');
    renderVideoModelPrompt(menu, {...choice, purpose: 'setup'}, 'zh-CN');
    expect(menu.querySelector('.fluent-read-video-model-prompt-title')?.textContent).toBe('下载 AI 字幕模型');
    expect(model.getAttribute('aria-expanded')).toBe('false');
  });

  it('preserves an active subtitle export confirmation when the model prompt refresh has no selection', async () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    menu.hidden = false;
    document.body.appendChild(menu);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const choice = confirmVideoSubtitleExport(menu, {total: 4, ready: 2, missing: 2, requests: 1,
      human: 1, cached: 1, startMs: 4000, endMs: 7000}, true, controller.signal, key => key);
    let settled = false;
    void choice.then(() => {settled = true;});
    try {
      const panel = menu.querySelector('[data-export-prompt]');
      expect(panel).not.toBeNull();
      expect(menu.dataset.view).toBe('export-prompt');
      const before = menu.innerHTML;
      renderVideoModelPrompt(menu, null, 'zh-CN');
      renderVideoModelPrompt(menu, null, 'en-US');
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(menu.innerHTML).toBe(before);
      expect(menu.querySelector('[data-export-prompt]')).toBe(panel);
      expect(menu.dataset.view).toBe('export-prompt');
      expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden).toBe(true);
      expect(menu.querySelector('[data-action="close-menu"]')!.closest('[hidden]')).toBeNull();
      controller.abort();
      await expect(choice).resolves.toBe('cancel');
      expect(menu.querySelector('[data-export-prompt]')).toBeNull();
      expect(menu.dataset.view).toBe('main');
      expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden).toBe(false);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls.find(([type]) => type === 'abort')![1]);
    } finally {controller.abort(); await choice; menu.remove();}
  });

  it('returns selection focus to a visible enabled model row, then uses visible controls during download or generation', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    menu.hidden = false;
    document.body.appendChild(menu);
    renderVideoMenuMode(menu, 'bilingual', false, '');
    renderVideoAiModelSelection(menu, {model: 'base', available: true, disabled: false}, 'zh-CN');
    const model = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]')!;
    const ai = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;
    const back = menu.querySelector<HTMLButtonElement>('[data-action="close-subtitle-tools"]')!;
    const mode = menu.querySelector<HTMLButtonElement>('[data-mode="bilingual"]')!;
    const focused = [model, ai, back, mode].map(button => vi.spyOn(button, 'focus'));
    setVideoMenuToolsOpen(menu, true);
    focusVideoModelPromptReturn(menu, 'selection');
    expect(focused[0]).toHaveBeenCalledOnce();
    focused.forEach(spy => spy.mockClear());
    model.disabled = true;
    focusVideoModelPromptReturn(menu, 'selection');
    expect(focused[2]).toHaveBeenCalledOnce();
    expect(menu.dataset.panel).toBe('tools');
    focused.forEach(spy => spy.mockClear());
    setVideoMenuToolsOpen(menu, false);
    focusVideoModelPromptReturn(menu, 'selection');
    expect(focused[1]).toHaveBeenCalledOnce();
    focused.forEach(spy => spy.mockClear());
    ai.disabled = true;
    focusVideoModelPromptReturn(menu, 'selection');
    expect(focused[3]).toHaveBeenCalledOnce();
    focused.forEach(spy => spy.mockClear());
    ai.disabled = false;
    focusVideoModelPromptReturn(menu);
    expect(focused[1]).toHaveBeenCalledOnce();
    focused.forEach(spy => spy.mockClear());
    menu.hidden = true;
    focusVideoModelPromptReturn(menu, 'selection');
    expect(focused.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(() => focusVideoModelPromptReturn(createVideoPlayerMenu('en-US', false), 'selection')).not.toThrow();
  });

  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'ru-RU'] as const)('localizes the current-model row and selection prompt in %s', language => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu(language, true);
    renderVideoAiModelSelection(menu, {model: 'tiny', available: true, disabled: false}, language);
    renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: ['tiny'], recommended: 'small', selected: 'tiny', purpose: 'selection'}, language);
    const model = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]')!;
    const title = menu.querySelector<HTMLElement>('.fluent-read-video-model-prompt-title')!;
    const description = menu.querySelector<HTMLElement>('.fluent-read-video-model-prompt-description')!;
    expect(model.textContent).toContain('Tiny');
    expect(model.getAttribute('aria-label')).toContain('Tiny');
    expect([model.textContent, model.getAttribute('aria-label'), title.textContent, description.textContent].every(text => text && !/video\.(?:modelSelection|modelPrompt)/.test(text) && !text.includes('{model}'))).toBe(true);
    if (language !== 'zh-CN') expect(title.textContent).not.toBe('选择 AI 字幕模型');
  });

  it('keeps keyboard focus in the viewing controls when a completed AI action moves to tools', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('en-US', true);
    renderVideoMenuMode(menu, 'bilingual', false, '');
    const ai = menu.querySelector('[data-action="toggle-ai-subtitle"]')!;
    Object.defineProperty(document, 'activeElement', {configurable: true, value: ai});
    const mode = menu.querySelector<HTMLButtonElement>('[data-mode="bilingual"]')!;
    const focus = vi.spyOn(mode, 'focus');
    const source = {enabled: true, source: 'none' as const, cueCount: 0, checking: false,
      generating: false, translationFailed: false, canRegenerate: false};
    focus.mockImplementation(() => renderVideoSourceStatus(menu, source, 'en-US'));
    renderVideoSourceStatus(menu, source, 'en-US');
    renderVideoSourceStatus(menu, {...source, source: 'ai', cueCount: 1}, 'en-US');
    expect(focus).toHaveBeenCalledOnce();
    expect(menu.querySelector('[data-source-status]')?.textContent).toContain('AI subtitles');
    expect(menu.dataset.panel).toBe('watch');
    expect(ai.closest('.fluent-read-video-menu-tools')).toBeTruthy();
  });

  it('navigates visible enabled menu controls without sending playback keys to the host', () => {
    const {document, HTMLElement} = parseHTML('<!doctype html><body><div id="menu"><div class="fluent-read-video-menu-mode-group"><button>双语</button><button>译文</button><button>原文</button><button>关闭</button></div></div></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', HTMLElement);
    const menu = document.getElementById('menu')!;
    const group = menu.querySelector<HTMLElement>('.fluent-read-video-menu-mode-group')!;
    const modes = [...group.querySelectorAll<HTMLButtonElement>('button')];
    const focused = modes.map(button => vi.spyOn(button, 'focus'));
    const dispatch = (key: string, target: EventTarget | null = modes[0], trusted = true) => {
      const event = {key, target, currentTarget: menu, isTrusted: trusted,
        stopPropagation: vi.fn(), preventDefault: vi.fn()};
      handleVideoMenuNavigation(event as unknown as KeyboardEvent);
      return event;
    };
    expect(dispatch('ArrowRight', null).stopPropagation).not.toHaveBeenCalled();
    expect(dispatch('ArrowRight', document.body).stopPropagation).not.toHaveBeenCalled();
    expect(dispatch('ArrowRight', modes[0], false).stopPropagation).not.toHaveBeenCalled();
    expect(dispatch(' ', modes[0]).preventDefault).not.toHaveBeenCalled();
    modes[1].disabled = true;
    modes[2].hidden = true;
    expect(dispatch('ArrowRight').preventDefault).toHaveBeenCalledOnce();
    expect(focused[3]).toHaveBeenCalledOnce();
    focused.forEach(spy => spy.mockClear());
    dispatch('ArrowLeft');
    expect(focused[3]).toHaveBeenCalledOnce();
    dispatch('Home', modes[3]);
    expect(focused[0]).toHaveBeenCalledOnce();
    dispatch('End');
    expect(focused[3]).toHaveBeenCalledTimes(2);
    modes[1].disabled = false;
    modes[2].hidden = false;
    dispatch('ArrowDown');
    expect(focused[1]).toHaveBeenCalledOnce();
    dispatch('ArrowUp', modes[1]);
    expect(focused[0]).toHaveBeenCalledTimes(2);
    expect(dispatch('ArrowRight', menu).preventDefault).not.toHaveBeenCalled();
    group.remove();
    expect(dispatch('ArrowDown', menu).preventDefault).not.toHaveBeenCalled();
  });

  it.each(['main', 'model-prompt', 'export-prompt'])('keeps keyboard navigation away from the hidden tools Back in %s', view => {
    const {document, HTMLElement} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', HTMLElement);
    const menu = createVideoPlayerMenu('en-US', true);
    menu.hidden = false;
    setVideoMenuToolsOpen(menu, true);
    menu.dataset.view = view;
    menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden = view !== 'main';
    const back = menu.querySelector<HTMLButtonElement>('[data-action="close-subtitle-tools"]')!;
    const settings = menu.querySelector<HTMLButtonElement>('[data-action="open-settings"]')!;
    const close = menu.querySelector<HTMLButtonElement>('[data-action="close-menu"]')!;
    const backFocus = vi.spyOn(back, 'focus');
    const settingsFocus = vi.spyOn(settings, 'focus');
    handleVideoMenuNavigation({key: 'Home', target: close, currentTarget: menu, isTrusted: true,
      stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
    expect(backFocus).toHaveBeenCalledTimes(view === 'main' ? 1 : 0);
    expect(settingsFocus).toHaveBeenCalledTimes(view === 'main' ? 0 : 1);
  });

  it('opens a model confirmation view with recommendation, sizes and downloaded state, then returns to the menu', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const main = menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!;
    const prompt = menu.querySelector<HTMLElement>('[data-model-prompt]')!;

    renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: [], recommended: 'base', selected: 'base'}, 'zh-CN');
    expect(isVideoModelPromptOpen(menu)).toBe(true);
    expect(main.hidden).toBe(true);
    expect(menu.querySelector('[data-action="close-menu"]')!.closest('[hidden]')).toBe(menu);
    expect(main.contains(menu.querySelector('[data-action="close-menu"]'))).toBe(false);
    expect(prompt.hidden).toBe(false);
    expect(prompt.dataset.selectedModel).toBe('base');
    const options = [...prompt.querySelectorAll<HTMLElement>('[data-model-choice]')];
    expect(options.map(option => [option.dataset.modelChoice, option.getAttribute('aria-checked')])).toEqual([['tiny', 'false'], ['base', 'true'], ['small', 'false']]);
    expect(options[0].textContent).toContain('约 100 MB');
    expect(options[1].textContent).toContain('推荐');
    expect(options[1].textContent).toContain('约 150 MB');
    expect(options[2].textContent).toContain('约 590 MB');
    expect(options[2].textContent).toContain('多语种');
    expect(prompt.querySelector('[data-action="model-prompt-confirm"]')?.textContent).toBe('下载并生成');

    const focusedOption = prompt.querySelector<HTMLElement>('[data-model-choice="tiny"]');
    renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: [], recommended: 'base', selected: 'tiny'}, 'zh-CN');
    expect(prompt.querySelector('[data-model-choice="tiny"]')).toBe(focusedOption);
    expect(focusedOption?.getAttribute('aria-checked')).toBe('true');
    renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: ['tiny'], recommended: 'base', selected: 'tiny'}, 'zh-CN');
    expect(prompt.querySelector('[data-model-choice="tiny"]')).not.toBe(focusedOption);
    expect(prompt.querySelector('[data-model-choice="tiny"]')?.textContent).toContain('已下载');
    expect(prompt.querySelector('[data-action="model-prompt-confirm"]')?.textContent).toBe('开始生成');
    refreshVideoUiText(menu, 'en-US');
    expect(prompt.querySelector('[data-model-choice="base"]')?.textContent).toContain('~150 MB');
    expect(prompt.querySelector('[data-model-choice="small"]')?.textContent).toContain('Small · Quality');
    expect(prompt.querySelector('[data-action="model-prompt-confirm"]')?.textContent).toBe('Generate');

    renderVideoModelPrompt(menu, null, 'zh-CN');
    expect(isVideoModelPromptOpen(menu)).toBe(false);
    const youtubeMenu = createVideoPlayerMenu('zh-CN', false);
    expect(() => renderVideoModelPrompt(youtubeMenu, null, 'zh-CN')).not.toThrow();
    expect(() => renderVideoModelPrompt(youtubeMenu, {
      options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: [], recommended: 'base', selected: 'base',
    }, 'zh-CN')).not.toThrow();
    expect(isVideoModelPromptOpen(youtubeMenu)).toBe(false);
    expect(main.hidden).toBe(false);
    expect(prompt.hidden).toBe(true);
  });

  it('shares one download status line and only clears feedback that was not replaced', () => {
    vi.useFakeTimers();
    try {
      const {document} = parseHTML('<!doctype html><body></body>');
      vi.stubGlobal('document', document);
      const menu = createVideoPlayerMenu('zh-CN', false);
      const status = menu.querySelector<HTMLElement>('[data-download-status]')!;
      setVideoMenuDownloadStatus(menu, '已下载 · 2 条', 2400);
      expect(status.textContent).toBe('已下载 · 2 条');
      vi.advanceTimersByTime(1000);
      setVideoMenuDownloadStatus(menu, '正在获取…');
      vi.advanceTimersByTime(2000);
      expect(status.textContent).toBe('正在获取…');
      setVideoMenuDownloadStatus(menu, '已下载 · 2 条', 2200);
      vi.advanceTimersByTime(2200);
      expect(status.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps primary controls before learning in DOM order and sizes the viewport menu without measuring the short player', () => {
    const {document} = parseHTML('<!doctype html><body><div id="host"></div></body>');
    vi.stubGlobal('document', document);
    const host = document.getElementById('host')!;
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    menu.dataset.presentation = 'viewport';
    host.appendChild(menu);
    const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body')!;
    expect([...body.querySelectorAll('button')].filter(button => !button.closest('[hidden], [inert]'))
      .map(button => button.dataset.mode || button.dataset.action).slice(0, 4))
      .toEqual(['bilingual', 'translation-only', 'original-only', 'off']);
    const actions = [...body.querySelectorAll('button')].map(button => button.dataset.action);
    expect(actions.indexOf('subtitle-later')).toBeLessThan(actions.indexOf('open-sentence-learning'));
    expect(menu.querySelector('.fluent-read-video-menu-title')!.parentElement).toBe(menu);
    Object.defineProperty(menu, 'scrollHeight', {get() {throw new Error('viewport layout must not measure player overflow');}});
    Object.defineProperty(host, 'clientHeight', {value: 180});
    for (const [width, layout] of [[320, 'stack'], [402, 'wide'], [844, 'wide']] as const) {
      Object.defineProperty(host, 'clientWidth', {configurable: true, value: width});
      syncVideoPlayerMenuLayout(menu);
      expect(menu.dataset.layout).toBe(layout);
      expect(menu.dataset.measuring).toBeUndefined();
    }
  });

  it('switches to the short layout only when a wide player cannot fit the single column comfortably', () => {
    const {document} = parseHTML('<!doctype html><body><div id="player"></div></body>');
    vi.stubGlobal('document', document);
    const player = document.getElementById('player')!;
    const menu = createVideoPlayerMenu('zh-CN', true);
    player.appendChild(menu);
    const size = (width: number, height: number, contentHeight: number) => {
      Object.defineProperty(player, 'clientWidth', {configurable: true, value: width});
      Object.defineProperty(player, 'clientHeight', {configurable: true, value: height});
      Object.defineProperty(menu, 'scrollHeight', {configurable: true, value: contentHeight});
    };

    size(390, 220, 172);
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('stack');
    menu.hidden = false;
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('stack');
    setVideoMenuToolsOpen(menu, true);
    expect(menu.dataset.layout).toBe('wide');
    expect(menu.dataset.measuring).toBeUndefined();
    size(640, 360, 172);
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('stack');
    const measureFeedback = vi.fn(() => {
      expect(menu.dataset.measuring).toBe('true');
      return 172;
    });
    Object.defineProperty(menu, 'scrollHeight', {configurable: true, get: measureFeedback});
    setVideoMenuDownloadStatus(menu, '已下载 · 2 条');
    expect(measureFeedback).toHaveBeenCalledOnce();
    expect(menu.dataset.measuring).toBeUndefined();
    size(280, 200, 172);
    menu.dataset.layout = 'wide';
    const measureContent = vi.fn(() => 172);
    Object.defineProperty(menu, 'scrollHeight', {configurable: true, get: measureContent});
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('stack');
    expect(measureContent).not.toHaveBeenCalled();
    size(640, 220, 172);
    const measurePlayer = vi.fn(() => 640);
    Object.defineProperty(player, 'clientWidth', {configurable: true, get: measurePlayer});
    renderVideoModelPrompt(menu, null, 'zh-CN');
    expect(measurePlayer).not.toHaveBeenCalled();
    size(0, 0, 172);
    menu.dataset.layout = 'wide';
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('wide');
    player.removeChild(menu);
    syncVideoPlayerMenuLayout(menu);
  });

  it('isolates collapsed controls below128, moves only their owned focus and restores nodes without restoring focus', () => {
    const {document, HTMLElement} = parseHTML('<!doctype html><body><div id="host"></div><button id="outside">Host control</button></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', HTMLElement);
    const host = document.getElementById('host')!;
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    menu.dataset.presentation = 'viewport';
    host.appendChild(menu);
    const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body')!;
    const main = body.parentElement!;
    const mode = menu.querySelector<HTMLButtonElement>('[data-mode="translation-only"]')!;
    const close = menu.querySelector<HTMLButtonElement>('[data-action="close-menu"]')!;
    const settings = menu.querySelector<HTMLButtonElement>('[data-action="open-settings"]')!;
    const outside = document.getElementById('outside')!;
    renderVideoMenuMode(menu, 'translation-only', false, '');
    body.scrollTop = 19;
    // A pre-existing inert attribute belongs to its caller, not this temporary viewport state.
    settings.setAttribute('inert', 'existing');
    let active: Element = mode;
    Object.defineProperty(document, 'activeElement', {configurable: true, get: () => active});
    const closeFocus = vi.spyOn(close, 'focus').mockImplementation(() => {active = close;});
    const modeFocus = vi.spyOn(mode, 'focus');
    let height = 58;
    Object.defineProperties(host, {clientWidth: {value: 378}, clientHeight: {get: () => height}});

    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.viewportState).toBe('close-only');
    expect(main.hasAttribute('inert')).toBe(true);
    expect(mode.closest('[inert]')).toBe(main);
    expect(close.closest('[inert]')).toBeNull();
    expect(closeFocus).toHaveBeenCalledOnce();
    expect(closeFocus).toHaveBeenCalledWith({preventScroll: true});
    for (const key of ['Home', 'End', 'ArrowDown']) {
      handleVideoMenuNavigation({key, target: close, currentTarget: menu, isTrusted: true,
        stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
      expect(active).toBe(close);
    }
    expect(modeFocus).not.toHaveBeenCalled();
    const before = closeFocus.mock.calls.length;
    syncVideoPlayerMenuLayout(menu); // Repeated frame synchronization does not steal focus.
    expect(closeFocus).toHaveBeenCalledTimes(before);
    active = outside;
    for (height of [80, 83, 84, 127]) {
      syncVideoPlayerMenuLayout(menu);
      expect(menu.dataset.viewportState).toBe('close-only');
      expect(active).toBe(outside);
      expect(closeFocus).toHaveBeenCalledTimes(before);
    }
    for (height of [128, 280]) {
      syncVideoPlayerMenuLayout(menu);
      expect(menu.dataset.viewportState).toBeUndefined();
      expect(main.hasAttribute('inert')).toBe(false);
      expect(main.dataset.viewportInert).toBeUndefined();
      expect(settings.getAttribute('inert')).toBe('existing');
      expect(menu.querySelector('.fluent-read-video-menu-body')).toBe(body);
      expect(menu.querySelector('[data-mode="translation-only"]')).toBe(mode);
      expect(mode.getAttribute('aria-checked')).toBe('true');
      expect(body.scrollTop).toBe(19);
      expect(active).toBe(outside);
    }
    height = 58;
    syncVideoPlayerMenuLayout(menu);
    menu.dataset.presentation = 'player';
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.viewportState).toBeUndefined();
    expect(main.hasAttribute('inert')).toBe(false);
    expect(active).toBe(outside);
  });

  it('reveals only the owned body target in either direction and only resizes once without stealing page scroll', () => {
    const {document, HTMLElement} = parseHTML('<!doctype html><body><div id="host"></div><button id="outside">Page</button></body>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', HTMLElement);
    const host = document.getElementById('host')!;
    const outside = document.getElementById('outside')!;
    const menu = createVideoPlayerMenu('en-US', false);
    menu.hidden = false;
    menu.dataset.presentation = 'viewport';
    host.appendChild(menu);
    const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body')!;
    const control = menu.querySelector<HTMLButtonElement>('[data-mode="bilingual"]')!;
    const close = menu.querySelector<HTMLButtonElement>('[data-action="close-menu"]')!;
    let width = 378, height = 128, scrollTop = 0, controlTop = 108;
    let active: Element = control;
    const writes: number[] = [];
    Object.defineProperty(document, 'activeElement', {get: () => active});
    Object.defineProperties(host, {clientWidth: {get: () => width}, clientHeight: {get: () => height}});
    // A 2x transformed body with a 1px border: its 44px client window is y102..190, not the outer y100..192.
    Object.defineProperties(body, {clientTop: {value: 1}, clientHeight: {value: 44}, offsetHeight: {value: 46},
      getBoundingClientRect: {value: () => ({top: 100, bottom: 192, height: 92})},
      scrollTop: {get: () => scrollTop, set: (value: number) => {writes.push(value); scrollTop = value;}}});
    Object.defineProperty(control, 'getBoundingClientRect', {value: () => ({top: controlTop - scrollTop * 2, bottom: controlTop - scrollTop * 2 + 88, height: 88})});
    host.scrollTop = 23;
    document.body.scrollTop = 41;
    syncVideoPlayerMenuLayout(menu);
    expect(writes).toEqual([3]); // Bottom reveal accounts for border and converts transformed pixels to scrollTop.
    writes.length = 0;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([]); // Already completely visible: no setter write.
    scrollTop = 20;
    controlTop = 132;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([15]); // Top reveal, without scrolling another ancestor.
    expect(host.scrollTop).toBe(23);
    expect(document.body.scrollTop).toBe(41);
    writes.length = 0;
    scrollTop = 25;
    syncVideoPlayerMenuLayout(menu);
    expect(writes).toEqual([]); // Same-size periodic updates preserve deliberate manual scrolling.
    width++;
    syncVideoPlayerMenuLayout(menu);
    expect(writes).toEqual([15]);
    writes.length = 0;
    active = outside;
    height++;
    syncVideoPlayerMenuLayout(menu);
    revealVideoMenuBodyControl(menu, outside);
    revealVideoMenuBodyControl(menu, null);
    expect(writes).toEqual([]);
    controlTop = Infinity;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([]);
    controlTop = 132;
    const focus = vi.spyOn(control, 'focus').mockImplementation(() => {active = control;});
    scrollTop = 0;
    handleVideoMenuNavigation({key: 'ArrowDown', target: close, currentTarget: menu, isTrusted: true,
      stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
    expect(focus).toHaveBeenCalledWith({preventScroll: true});
    expect(writes).toEqual([15]);
    writes.length = 0;
    const settings = menu.querySelector<HTMLButtonElement>('[data-action="open-settings"]')!;
    const settingsFocus = vi.spyOn(settings, 'focus');
    handleVideoMenuNavigation({key: 'Home', target: control, currentTarget: menu, isTrusted: true,
      stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
    expect(settingsFocus).toHaveBeenCalledOnce();
    expect(settingsFocus).toHaveBeenCalledWith(); // Non-body viewport controls retain the original native focus/scroll behavior.
    expect(writes).toEqual([]);
    menu.dataset.presentation = 'player';
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([]);
    focus.mockClear();
    handleVideoMenuNavigation({key: 'ArrowDown', target: close, currentTarget: menu, isTrusted: true,
      stopPropagation: vi.fn(), preventDefault: vi.fn()} as unknown as KeyboardEvent);
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith();
    expect(writes).toEqual([]);
  });

  it('reveals the owned body control when the layout height measurement is unavailable', () => {
    const {document} = parseHTML('<!doctype html><body><div id="host"></div><button id="outside">Page</button></body>');
    vi.stubGlobal('document', document);
    const host = document.getElementById('host')!;
    const outside = document.getElementById('outside')!;
    const menu = createVideoPlayerMenu('en-US', false);
    host.appendChild(menu);
    menu.hidden = false;
    menu.dataset.presentation = 'viewport';
    const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body')!;
    const control = menu.querySelector<HTMLButtonElement>('[data-mode="bilingual"]')!;
    let scrollTop = 0, controlTop = 108, controlHeight = 44;
    const writes: number[] = [];
    // Defensive measurement fixture: a missing layout height falls back to a 1x rectangle scale.
    Object.defineProperties(body, {clientTop: {value: 1}, clientHeight: {value: 44}, offsetHeight: {value: 0},
      getBoundingClientRect: {value: () => ({top: 100, bottom: 146, height: 46})},
      scrollTop: {get: () => scrollTop, set: (value: number) => {writes.push(value); scrollTop = value;}}});
    Object.defineProperty(control, 'getBoundingClientRect', {value: () => ({top: controlTop - scrollTop, bottom: controlTop - scrollTop + controlHeight, height: controlHeight})});
    Object.defineProperty(document, 'activeElement', {get: () => outside});
    const focus = vi.spyOn(control, 'focus');
    host.scrollTop = 23;
    document.body.scrollTop = 41;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([7]); // The bordered client window is y101..145; the target ends at y152.
    expect(control.getBoundingClientRect()).toMatchObject({top: 101, bottom: 145});
    writes.length = 0;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([]);
    controlTop = 200;
    controlHeight = 0;
    revealVideoMenuBodyControl(menu, control);
    expect(writes).toEqual([]); // A target without measurable height must not move the body toward its empty rectangle.
    expect(scrollTop).toBe(7);
    expect(host.scrollTop).toBe(23);
    expect(document.body.scrollTop).toBe(41);
    expect(document.activeElement).toBe(outside);
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps an open prompt and its original hidden state while the viewport temporarily offers only Close', () => {
    const {document} = parseHTML('<!doctype html><body><div id="host"></div></body>');
    vi.stubGlobal('document', document);
    const host = document.getElementById('host')!;
    const menu = createVideoPlayerMenu('en-US', true);
    host.appendChild(menu);
    menu.hidden = false;
    menu.dataset.presentation = 'viewport';
    menu.dataset.view = 'model-prompt';
    const main = menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!;
    const prompt = menu.querySelector<HTMLElement>('[data-model-prompt]')!;
    main.hidden = true;
    prompt.hidden = false;
    const confirm = prompt.querySelector<HTMLButtonElement>('[data-action="model-prompt-confirm"]')!;
    let active: Element = confirm;
    Object.defineProperty(document, 'activeElement', {configurable: true, get: () => active});
    const close = menu.querySelector<HTMLButtonElement>('[data-action="close-menu"]')!;
    const closeFocus = vi.spyOn(close, 'focus').mockImplementation(() => {active = close;});
    let height = 58;
    Object.defineProperties(host, {clientWidth: {value: 378}, clientHeight: {get: () => height}});
    syncVideoPlayerMenuLayout(menu);
    expect(prompt.hasAttribute('inert')).toBe(true);
    expect(closeFocus).toHaveBeenCalledOnce();
    expect(closeFocus).toHaveBeenCalledWith({preventScroll: true});
    height = 280;
    syncVideoPlayerMenuLayout(menu);
    expect(prompt.hasAttribute('inert')).toBe(false);
    expect(menu.dataset.view).toBe('model-prompt');
    expect(main.hidden).toBe(true);
    expect(prompt.hidden).toBe(false);
    expect(active).toBe(close);
    expect(closeFocus).toHaveBeenCalledTimes(1);
  });

  it('renders idle, checking, error, and unsupported states accessibly', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;

    renderVideoAiMenu(menu, state(), 'zh-CN');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('生成 AI 字幕');
    expect(button.dataset.processing).toBe('false');
    expect(button.dataset.error).toBe('false');

    renderVideoAiMenu(menu, state({checking: true}), 'zh-CN');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('检查模型中');
    expect(button.dataset.processing).toBe('true');

    renderVideoAiMenu(menu, state({error: '模型下载失败'}), 'zh-CN');
    expect(button.textContent).toContain('重试生成 AI 字幕');
    expect(button.dataset.error).toBe('true');
    expect(button.title).toBe('模型下载失败');

    renderVideoAiMenu(menu, state({available: false, error: '本地模型不可用'}), 'zh-CN');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('本地 AI 暂不可用');
    expect(button.dataset.error).toBe('true');
  });

  it('renders full capture lifecycle details and progress without replacing the menu node', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;

    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'capturing',
      progress: {...progress(0), capturedMs: 0, transcribedMs: 0}}), 'zh-CN');
    expect(button.textContent).toContain('读取音频中');
    expect(button.dataset.progress).toBe('indeterminate');

    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'capturing',
      progress: {...progress(0.2), capturedMs: 4000, durationMs: 10000, transcribedMs: 0}}), 'zh-CN');
    expect(button.textContent).toContain('20%');
    expect(button.dataset.progress).toBe('determinate');
    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'capturing',
      progress: {...progress(0.3), capturedMs: 7000, durationMs: 10000, transcribedMs: 4000}}), 'zh-CN');
    expect(button.textContent).toContain('识别 30%');

    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'transcribing', progress: progress(0.42)}), 'zh-CN');
    expect(button.textContent).toContain('识别 42%');

    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'translating', progress: progress(0.875)}), 'zh-CN');
    expect(button.textContent).toContain('翻译 88%');

    expect(button.dataset.progress).toBe('determinate');
    expect(button.style.getPropertyValue('--fluent-read-video-ai-progress')).toBe('88%');

    renderVideoAiMenu(menu, state({active: true, fullActive: true, phase: 'ready'}), 'zh-CN');
    expect(button.querySelector('.fluent-read-video-menu-label')?.textContent).toBe('关闭 AI 字幕');
    expect(button.querySelector('[data-state]')?.textContent).toBe('已就绪');
    expect(button.dataset.processing).toBe('false');
    expect(button.dataset.ready).toBe('true');
    expect(button.dataset.progress).toBe('none');

    renderVideoAiMenu(menu, state({fullActive: true, phase: 'idle'}), 'zh-CN');
    expect(button.querySelector('[data-state]')?.textContent).toBe('准备中…');
    expect(button.dataset.ready).toBe('false');
    expect(menu.querySelector('[data-action="toggle-ai-subtitle"]')).toBe(button);
  });

  it('shows model downloads as an indeterminate, non-cancellable step and hides stale errors meanwhile', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;

    renderVideoAiMenu(menu, state({downloading: true, error: '旧错误'}), 'zh-CN');
    expect(button.querySelector('.fluent-read-video-menu-label')?.textContent).toBe('正在下载模型…');
    expect(button.disabled).toBe(true);
    expect(button.dataset.processing).toBe('true');
    expect(button.dataset.progress).toBe('indeterminate');
    expect(button.dataset.error).toBe('false');
    expect(button.querySelector('[data-state]')?.textContent).toBe('');
  });

  it('shows real model download progress as a determinate bar with the percentage and full sizes in the tooltip', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]')!;

    renderVideoAiMenu(menu, state({downloading: true, downloadProgress: {loaded: 41_000_000, total: 100_000_000}, error: '旧错误'}), 'zh-CN');
    expect(button.dataset.progress).toBe('determinate');
    expect(button.style.getPropertyValue('--fluent-read-video-ai-progress')).toBe('41%');
    expect(button.querySelector('[data-state]')?.textContent).toBe('41%');
    expect(button.title).toBe('41% · 41 MB / 100 MB');
    expect(button.disabled).toBe(true);

    // 来源没有给出总量：保持循环动画，只写真实已下载体积。
    renderVideoAiMenu(menu, state({downloading: true, downloadProgress: {loaded: 2_500_000, total: 0}}), 'zh-CN');
    expect(button.dataset.progress).toBe('indeterminate');
    expect(button.querySelector('[data-state]')?.textContent).toBe('2.5 MB');
    expect(button.title).toBe('2.5 MB');

    // 下载结束后残留的进度不再显示。
    renderVideoAiMenu(menu, state({downloadProgress: {loaded: 1, total: 2}, error: '下载失败'}), 'zh-CN');
    expect(button.dataset.progress).toBe('none');
    expect(button.title).toBe('下载失败');
  });

  it('returns safely when the optional AI action is absent', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', false);
    expect(() => renderVideoAiMenu(menu, state(), 'zh-CN')).not.toThrow();
    expect(() => setVideoMenuToolsOpen(menu, true)).not.toThrow();
    expect(() => renderVideoSourceStatus(menu, {enabled: true, source: 'none', cueCount: 0,
      checking: false, generating: false, translationFailed: false, canRegenerate: false}, 'zh-CN')).not.toThrow();
    const xMenu = createVideoPlayerMenu('zh-CN', true);
    xMenu.querySelector('.fluent-read-video-menu-tools')!.remove();
    expect(() => setVideoMenuToolsOpen(xMenu, true)).not.toThrow();
  });
});
