import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {VideoSubtitleCue} from '@/src/features/video-subtitle/content/youtubeSubtitleData';
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));
import {XCaptionSource, isXNativeCaptionControl, readXNativeCaptionControlState} from '@/src/features/video-subtitle/content/xCaptionSource';
import {getXSubtitleBottomInset, VIDEO_AI_CAPTION_CONTAINER_ID, VIDEO_NATIVE_CUE_HIDDEN_CLASS} from '@/src/features/video-subtitle/content/ui';

afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture() {
  const {document, window} = parseHTML('<!doctype html><html><body><article><div data-testid="videoPlayer"><video></video></div><div id="fullscreen"><video></video></div></article></body></html>');
  vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('window', {location: {hostname: 'x.com', pathname: '/profile', href: 'https://x.com/profile'}});
  const video = document.querySelector('video') as HTMLVideoElement;
  const koreanCue = {startTime: 0, endTime: 2, text: '오늘은 좋은 날입니다.'};
  const englishCue = {startTime: 0, endTime: 2, text: 'This is a good day.'};
  const korean = {kind: 'subtitles', mode: 'showing', language: 'ko', activeCues: [koreanCue], cues: [koreanCue]};
  const english = {kind: 'subtitles', mode: 'disabled', language: 'en', activeCues: [englishCue], cues: [englishCue]};
  Object.assign(video, {currentTime: 1, textTracks: [english, korean]});
  const state = {video, player: video.parentElement!, enabled: true, aiActive: false, aiCues: [] as VideoSubtitleCue[], sidecarCues: [] as VideoSubtitleCue[], language: 'auto'};
  const source = new XCaptionSource(() => state);
  return {source, state, document, korean, english};
}

// 统计真实选轨方法和浏览器 live 列表读取，保留生产选择/排序算法。
function measuredNativeSelection(f: ReturnType<typeof fixture>) {
  const tracks = [f.english, f.korean];
  let trackListReads = 0;
  Object.defineProperty(f.state.video, 'textTracks', {configurable: true, get() {trackListReads += 1;return tracks;}});
  const selection = vi.spyOn(f.source as unknown as {selectedNativeTracks(): TextTrack[]}, 'selectedNativeTracks');
  return {tracks, selection, reads: () => trackListReads};
}

describe('X 原生字幕来源', () => {
  it('自动贴底只避让下方可见控件，失焦隐藏后回到底边', () => {
    const {state, document} = fixture();
    const player = state.player;
    player.getBoundingClientRect = () => ({top: 100, bottom: 680, height: 580}) as DOMRect;
    vi.stubGlobal('getComputedStyle', (node: HTMLElement) => ({display: node.style.display || 'block', visibility: node.style.visibility || 'visible', opacity: node.style.opacity || '1'}));
    expect(getXSubtitleBottomInset(player)).toBe(12);
    const bar = document.createElement('div');
    bar.innerHTML = '<button aria-label="Settings"></button><button>Play</button>';
    bar.getBoundingClientRect = () => ({top: 628, bottom: 672, height: 44, width: 900}) as DOMRect;
    player.appendChild(bar);
    expect(getXSubtitleBottomInset(player)).toBe(60);
    bar.style.opacity = '0';
    expect(getXSubtitleBottomInset(player)).toBe(12);
    bar.style.opacity = '1';
    player.style.visibility = 'hidden';
    expect(getXSubtitleBottomInset(player)).toBe(12);
    player.style.visibility = 'visible';
    bar.getBoundingClientRect = () => ({top: 110, bottom: 150, height: 40, width: 900}) as DOMRect;
    expect(getXSubtitleBottomInset(player)).toBe(12);
    bar.remove();
    const ownMenu = document.createElement('div');
    ownMenu.className = 'fluent-read-video-ui';
    ownMenu.innerHTML = '<button aria-label="Settings">Options</button><button>Close</button>';
    player.appendChild(ownMenu);
    const fallback = document.createElement('div');
    fallback.className = 'fluent-read-video-controls';
    fallback.getBoundingClientRect = () => ({top: 636, height: 36, width: 36}) as DOMRect;
    player.appendChild(fallback);
    expect(getXSubtitleBottomInset(player)).toBe(52);
    fallback.style.opacity = '0';
    state.video.controls = true;
    Object.assign(state.video, {paused: true});
    expect(getXSubtitleBottomInset(player)).toBe(56);
  });
  it('原生轨道显示与完整导出只保留正文，不泄漏 X 逐词时间标记', () => {
    const {source, korean} = fixture();
    korean.activeCues[0].text = '<X-word-ms ms=419,60,340 index=1 character_ranges=0-7,8-10,11-13>Teleport to SF</X-word-ms>';
    expect(source.sync()!.textContent).toBe('Teleport to SF');
    expect(source.readNativeTrack()!.cues).toEqual([{startMs: 0, durationMs: 2000, text: 'Teleport to SF'}]);
    korean.activeCues[0].text = '<X-word-ms ms=419 index=1> </X-word-ms>';
    expect(source.readNativeTrack()).toBeNull();
    expect(source.sync()!.textContent).toBe('');
  });

  it('主页直接读取宿主已选韩语原字幕，保留宿主 showing 状态并由视频级样式隐藏原生绘制', () => {
    const {source, state, korean, english} = fixture();
    const container = source.sync()!;
    expect(container.textContent).toBe('오늘은 좋은 날입니다.');
    expect(container.dataset.fluentReadCaptionSource).toBe('native');
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('disabled');
    expect(state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(true);
    expect(source.readNativeTrack()).toEqual({languageCode: 'ko', cues: [{startMs: 0, durationMs: 2000, text: '오늘은 좋은 날입니다.'}]});
    source.restoreTracks();
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('disabled');
    expect(state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(false);
  });
  it('显式视频原语言切换可选择另一轨道，关闭或原生 CC 关掉后恢复宿主状态', () => {
    const {source, state, korean, english} = fixture();
    state.language = 'en';
    expect(source.sync()!.textContent).toBe('This is a good day.');
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('hidden');
    expect(state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(true);
    korean.mode = 'disabled';
    expect(source.sync()!.textContent).toBe('');
    expect(korean.mode).toBe('disabled');
    expect(english.mode).toBe('disabled');
    expect(state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(false);
    korean.mode = 'showing';
    expect(source.sync()!.textContent).toBe('This is a good day.');
    state.enabled = false;
    expect(source.sync()!.textContent).toBe('');
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('disabled');
    expect(state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(false);
  });
  it('原生时间轴的静音空档不混入缓存或 sidecar 的旧字幕', () => {
    const {source, state, korean, english} = fixture();
    Object.assign(korean, {activeCues: []});
    Object.assign(english, {activeCues: []});
    state.aiCues = [{startMs: 0, durationMs: 5000, text: 'Old AI subtitle'}];
    state.sidecarCues = [{startMs: 0, durationMs: 5000, text: 'Other subtitle track'}];
    expect(source.sync()!.textContent).toBe('');
    state.aiActive = true;
    expect(source.sync()!.textContent).toBe('Old AI subtitle');
  });
  it('展开播放器后把唯一字幕容器移入新宿主，不留在旧播放器', () => {
    const {source, state, document} = fixture();
    const container = source.sync()!;
    const original = state.player;
    state.player = document.querySelector('#fullscreen') as HTMLElement;
    source.sync();
    expect(container.parentElement).toBe(state.player);
    expect(original.querySelector(`#${VIDEO_AI_CAPTION_CONTAINER_ID}`)).toBeNull();
    expect(document.querySelectorAll(`#${VIDEO_AI_CAPTION_CONTAINER_ID}`)).toHaveLength(1);
  });

  it('100 次原生 sync 每轮仅选轨一次，完整导出仍独立读取当前轨道', () => {
    const f = fixture();
    const measured = measuredNativeSelection(f);
    for (let index = 0; index < 100; index += 1) {
      const container = f.source.sync()!;
      expect(container.textContent).toBe('오늘은 좋은 날입니다.');
      expect(container.dataset.fluentReadCaptionSource).toBe('native');
    }
    console.info(JSON.stringify({xNativeSelectionEvidence: 'native', syncCalls: 100,
      selectionCalls: measured.selection.mock.calls.length, trackListReads: measured.reads()}));
    expect(measured.selection).toHaveBeenCalledTimes(100);
    expect(measured.reads()).toBe(200);
    expect(measured.selection.mock.results[0].value).toEqual([f.korean]);
    f.korean.cues[0].text = '更新后的完整轨道';
    expect(f.source.readNativeTrack()).toEqual({languageCode: 'ko', cues: [{startMs: 0, durationMs: 2000, text: '更新后的完整轨道'}]});
    expect(measured.selection).toHaveBeenCalledTimes(101);
    expect(measured.reads()).toBe(201);
  });

  it('隐藏模式写完后才选择 live 轨道和语言，不沿用隐藏前列表', () => {
    const f = fixture();
    const measured = measuredNativeSelection(f);
    f.state.language = 'en';
    const cue = {startTime: 0, endTime: 2, text: 'Nouvelle piste française.'};
    const french = {kind: 'subtitles', mode: 'showing', language: 'fr', activeCues: [cue], cues: [cue]};
    let englishMode = f.english.mode;
    Object.defineProperty(f.english, 'mode', {configurable: true, get: () => englishMode, set(value: string) {
      englishMode = value;
      if (value === 'hidden' && !measured.tracks.includes(french)) {
        measured.tracks.push(french);
        f.state.language = 'fr';
      }
    }});
    const container = f.source.sync()!;
    expect(f.korean.mode).toBe('showing');
    expect(f.english.mode).toBe('hidden');
    expect(container.textContent).toBe('Nouvelle piste française.');
    expect(container.dataset.fluentReadCaptionSource).toBe('native');
    expect(measured.selection.mock.results[0].value).toEqual([french]);
    expect(measured.selection).toHaveBeenCalledOnce();
    expect(measured.reads()).toBe(2);
    f.state.enabled = false;
    f.source.sync();
    expect(f.english.mode).toBe('disabled');
    expect(f.korean.mode).toBe('showing');
    expect(french.mode).toBe('showing');
  });

  it('下一 sync 重新读取语言、动态轨道、宿主 mode 与 seek 后的可变 cue', () => {
    const f = fixture();
    const measured = measuredNativeSelection(f);
    let syncCalls = 0;
    const display = (text: string) => {syncCalls += 1;expect(f.source.sync()!.textContent).toBe(text);};
    display('오늘은 좋은 날입니다.');
    f.state.language = 'en';
    display('This is a good day.');
    f.english.activeCues[0].text = 'Updated English cue.';
    display('Updated English cue.');
    f.state.language = 'auto';f.english.mode = 'showing';f.korean.mode = 'disabled';
    display('Updated English cue.');
    const cue = {startTime: 0, endTime: 2, text: 'La piste ajoutée.'};
    const french = {kind: 'subtitles', mode: 'showing', language: 'fr', activeCues: [cue], cues: [cue]};
    measured.tracks.splice(0, measured.tracks.length, french);
    display('La piste ajoutée.');
    measured.tracks.splice(0);
    display('');
    measured.tracks.push(french);f.state.language = 'fr';
    display('La piste ajoutée.');
    f.state.video.currentTime = 4;french.activeCues.splice(0);
    display('');
    Object.assign(cue, {startTime: 3, endTime: 5, text: 'Après la recherche.'});
    french.activeCues.push(cue);
    display('Après la recherche.');
    expect(measured.selection).toHaveBeenCalledTimes(syncCalls);
    expect(measured.reads()).toBe(syncCalls * 2);
    expect(f.source.readNativeTrack()).toEqual({languageCode: 'fr', cues: [{startMs: 3000, durationMs: 2000, text: 'Après la recherche.'}]});
    f.source.restoreTracks();
    expect(f.english.mode).toBe('showing');expect(f.korean.mode).toBe('disabled');expect(french.mode).toBe('showing');
  });

  it('原生空档及 cues 增删每轮重新判定 timeline，保留 sidecar 和 AI 回退顺序', () => {
    const f = fixture();
    const measured = measuredNativeSelection(f);
    f.korean.activeCues.splice(0);
    f.state.aiCues = [{startMs: 0, durationMs: 5000, text: 'AI fallback'}];
    f.state.sidecarCues = [{startMs: 0, durationMs: 5000, text: 'Sidecar fallback'}];
    let container = f.source.sync()!;
    expect(container.textContent).toBe('');expect(container.dataset.fluentReadCaptionSource).toBe('none');
    f.korean.cues.splice(0);
    container = f.source.sync()!;
    expect(container.textContent).toBe('Sidecar fallback');expect(container.dataset.fluentReadCaptionSource).toBe('sidecar');
    f.state.sidecarCues.splice(0);
    container = f.source.sync()!;
    expect(container.textContent).toBe('AI fallback');expect(container.dataset.fluentReadCaptionSource).toBe('ai');
    f.state.video.currentTime = 6;
    expect(f.source.sync()!.textContent).toBe('');
    const cue = {startTime: 5, endTime: 7, text: '새로운 원어 자막'};
    f.korean.cues.push(cue);f.korean.activeCues.push(cue);
    container = f.source.sync()!;
    expect(container.textContent).toBe('새로운 원어 자막');expect(container.dataset.fluentReadCaptionSource).toBe('native');
    expect(measured.selection).toHaveBeenCalledTimes(5);
    expect(measured.reads()).toBe(10);
  });

  it('AI 接管期间仍每轮选择一次，等待时不回退，关闭不读取轨道并恢复模式', () => {
    const f = fixture();
    const measured = measuredNativeSelection(f);
    f.state.aiActive = true;
    f.state.sidecarCues = [{startMs: 0, durationMs: 5000, text: 'Ignored sidecar'}];
    expect(f.source.sync()!.textContent).toBe('');
    f.state.aiCues.push(Object.assign({startMs: 0, durationMs: 5000, text: 'Active AI caption'}, {cueId: 'active-ai'}));
    for (let index = 0; index < 100; index += 1) {
      const container = f.source.sync()!;
      expect(container.textContent).toBe('Active AI caption');
      expect(container.dataset.fluentReadCaptionSource).toBe('ai');
      expect(container.dataset.fluentReadCueId).toBe('active-ai');
    }
    expect(measured.selection).toHaveBeenCalledTimes(101);
    expect(measured.reads()).toBe(202);
    f.state.enabled = false;
    const container = f.source.sync()!;
    expect(container.textContent).toBe('');expect(container.dataset.fluentReadCaptionSource).toBe('none');
    expect(measured.selection).toHaveBeenCalledTimes(101);expect(measured.reads()).toBe(202);
    expect(f.korean.mode).toBe('showing');expect(f.english.mode).toBe('disabled');
  });

  it('原生 CC 关闭时不激活 disabled 轨道、不泄漏 sidecar 或未激活 AI 字幕，并在重新开启后恢复', () => {
    const f = fixture();
    f.korean.mode = 'disabled';
    f.english.mode = 'disabled';
    f.state.sidecarCues = [{startMs: 0, durationMs: 5000, text: 'Sidecar caption while CC is off'}];
    f.state.aiCues = [{startMs: 0, durationMs: 5000, text: 'Cached AI caption while CC is off'}];
    const onChange = vi.fn();

    let container = f.source.sync(onChange)!;
    expect(container.textContent).toBe('');
    expect(container.dataset.fluentReadCaptionSource).toBe('none');
    expect(f.korean.mode).toBe('disabled');
    expect(f.english.mode).toBe('disabled');
    expect(f.state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(false);
    expect(f.source.isNativeCaptionActive()).toBe(false);

    // 宿主开启 CC（track.mode = 'showing'）后立即显示，并保留宿主 showing 状态。
    f.korean.mode = 'showing';
    container = f.source.sync(onChange)!;
    expect(container.textContent).toBe('오늘은 좋은 날입니다.');
    expect(container.dataset.fluentReadCaptionSource).toBe('native');
    expect(f.korean.mode).toBe('showing');
    expect(f.state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 宿主再次关闭 CC（track.mode = 'disabled'）后立即清空并通知回调，不回退到 sidecar。
    f.korean.mode = 'disabled';
    container = f.source.sync(onChange)!;
    expect(container.textContent).toBe('');
    expect(container.dataset.fluentReadCaptionSource).toBe('none');
    expect(f.korean.mode).toBe('disabled');
    expect(f.state.video.classList.contains(VIDEO_NATIVE_CUE_HIDDEN_CLASS)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('识别 X 原生 CC 按钮状态并在控制栏卸载后保持关闭记忆，不误认自有按钮或设置按钮', () => {
    const f = fixture();
    Object.assign(f.state.video, {textTracks: []});
    f.state.sidecarCues = [{startMs: 0, durationMs: 5000, text: 'Sidecar caption controlled by CC'}];

    const controls = f.document.createElement('div');
    const settings = f.document.createElement('button');
    settings.setAttribute('aria-label', 'Settings');
    const ownButton = f.document.createElement('button');
    ownButton.className = 'fluent-read-video-ui';
    ownButton.setAttribute('aria-label', 'Turn on captions');
    const ccButton = f.document.createElement('button');
    ccButton.setAttribute('aria-label', 'Closed captions');
    ccButton.setAttribute('aria-pressed', 'false');
    controls.append(settings, ownButton, ccButton);
    f.state.player.appendChild(controls);

    expect(isXNativeCaptionControl(settings)).toBe(false);
    expect(isXNativeCaptionControl(ownButton)).toBe(false);
    expect(isXNativeCaptionControl(ccButton)).toBe(true);
    expect(readXNativeCaptionControlState(f.state.player)).toBe('off');
    expect(f.source.sync()!.textContent).toBe('');

    // 控制栏在鼠标移出后卸载，仍记住最近一次 CC=off 状态，不泄漏 sidecar。
    controls.remove();
    expect(readXNativeCaptionControlState(f.state.player)).toBeNull();
    expect(f.source.sync()!.textContent).toBe('');

    // 重新挂载控制栏并开启 CC（aria-label 语义或 aria-pressed="true"），立即显示字幕。
    f.state.player.appendChild(controls);
    ccButton.removeAttribute('aria-pressed');
    ccButton.setAttribute('aria-label', 'Turn off captions');
    expect(readXNativeCaptionControlState(f.state.player)).toBe('on');
    expect(f.source.sync()!.textContent).toBe('Sidecar caption controlled by CC');

    // 切回 Turn on captions（即当前已关闭），立即隐藏字幕。
    ccButton.setAttribute('aria-label', 'Turn on captions');
    expect(readXNativeCaptionControlState(f.state.player)).toBe('off');
    expect(f.source.sync()!.textContent).toBe('');
  });
});
