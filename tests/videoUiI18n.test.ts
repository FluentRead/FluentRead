import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

import {
  createVideoPlayerMenu,
  handleVideoMenuNavigation,
  renderVideoSourceStatus,
  setVideoMenuToolsOpen,
  isVideoModelPromptOpen,
  renderVideoAiMenu,
  renderVideoAiModelSelection,
  focusVideoModelPromptReturn,
  renderVideoMenuMode,
  renderVideoModelPrompt,
  renderVideoSubtitleTiming,
  setVideoMenuDownloadStatus,
  syncVideoPlayerMenuLayout,
  type VideoAiMenuState,
} from '@/src/features/video-subtitle/content/playerMenu';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';
import {refreshVideoUiAccessibility, refreshVideoUiText} from '@/src/features/video-subtitle/content/ui';
import {VIDEO_LOCAL_TRANSCRIPTION_MODELS} from '@/src/features/video-subtitle/transcription';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

describe('player subtitle timing', () => {
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
    running: false,
    requested: false,
    fullActive: false,
    phase: 'idle',
    progress: progress(0),
    error: '',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('video player menu composition', () => {
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
    expect(menu.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(1);
    expect([...menu.querySelectorAll<HTMLElement>('.fluent-read-video-menu-mode-group [data-mode]')].map(item => [item.dataset.mode, item.textContent]))
      .toEqual([['bilingual', '双语'], ['translation-only', '译文'], ['original-only', '原文'], ['off', '关闭']]);
    const display = menu.querySelector('.fluent-read-video-menu-watch')!;
    expect(display.querySelector('.fluent-read-video-menu-mode-group')).toBeTruthy();
    expect(display.querySelector('[data-timing-row]')).toBeNull();
    const tools = menu.querySelector<HTMLElement>('.fluent-read-video-menu-tools')!;
    expect(tools.hidden).toBe(true);
    expect(tools.querySelector('[data-timing-row]')).toBeTruthy();
    const timingControls = menu.querySelector('.fluent-read-video-menu-timing-controls');
    expect([...timingControls!.children].map(element => element.getAttribute('data-action') || element.getAttribute('data-subtitle-offset')))
      .toEqual(['reset-subtitle-timing', 'subtitle-earlier', 'true', 'subtitle-later']);
    const actions = tools;
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
    renderVideoModelPrompt(menu, null, 'zh-CN');
    expect(model.getAttribute('aria-expanded')).toBe('false');
    renderVideoModelPrompt(menu, {...choice, purpose: 'setup'}, 'zh-CN');
    expect(menu.querySelector('.fluent-read-video-model-prompt-title')?.textContent).toBe('下载 AI 字幕模型');
    expect(model.getAttribute('aria-expanded')).toBe('false');
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

  it('opens a model confirmation view with recommendation, sizes and downloaded state, then returns to the menu', () => {
    const {document} = parseHTML('<!doctype html><body></body>');
    vi.stubGlobal('document', document);
    const menu = createVideoPlayerMenu('zh-CN', true);
    const main = menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!;
    const prompt = menu.querySelector<HTMLElement>('[data-model-prompt]')!;

    renderVideoModelPrompt(menu, {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, downloaded: [], recommended: 'base', selected: 'base'}, 'zh-CN');
    expect(isVideoModelPromptOpen(menu)).toBe(true);
    expect(main.hidden).toBe(true);
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
    size(280, 200, 172);
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('stack');
    size(0, 0, 172);
    menu.dataset.layout = 'wide';
    syncVideoPlayerMenuLayout(menu);
    expect(menu.dataset.layout).toBe('wide');
    player.removeChild(menu);
    syncVideoPlayerMenuLayout(menu);
  });

  it('renders idle, checking, running, waiting, error, and unsupported states accessibly', () => {
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

    renderVideoAiMenu(menu, state({active: true, running: true}), 'zh-CN');
    expect(button.textContent).toContain('停止生成');
    expect(button.querySelector('[data-state]')?.textContent).toBe('生成中…');
    expect(button.getAttribute('aria-checked')).toBe('true');

    renderVideoAiMenu(menu, state({requested: true}), 'zh-CN');
    expect(button.textContent).toContain('生成 AI 字幕');
    expect(button.querySelector('[data-state]')?.textContent).toBe('等待播放');

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
