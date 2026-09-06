import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));
import {XCaptionSource} from '@/src/features/video-subtitle/content/xCaptionSource';
import {getXSubtitleBottomInset, VIDEO_AI_CAPTION_CONTAINER_ID} from '@/src/features/video-subtitle/content/ui';

afterEach(() => vi.unstubAllGlobals());
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
  const state = {video, player: video.parentElement!, enabled: true, aiActive: false, aiCues: [], sidecarCues: [], language: 'auto'};
  const source = new XCaptionSource(() => state);
  return {source, state, document, korean, english};
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

  it('主页直接读取宿主已选韩语原字幕，并导出完整韩语轨道', () => {
    const {source, korean, english} = fixture();
    const container = source.sync()!;
    expect(container.textContent).toBe('오늘은 좋은 날입니다.');
    expect(container.dataset.fluentReadCaptionSource).toBe('native');
    expect(korean.mode).toBe('hidden');
    expect(english.mode).toBe('hidden');
    expect(source.readNativeTrack()).toEqual({languageCode: 'ko', cues: [{startMs: 0, durationMs: 2000, text: '오늘은 좋은 날입니다.'}]});
    source.restoreTracks();
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('disabled');
  });
  it('显式视频原语言切换可选择另一轨道，关闭后恢复宿主状态', () => {
    const {source, state, korean, english} = fixture();
    state.language = 'en';
    expect(source.sync()!.textContent).toBe('This is a good day.');
    state.enabled = false;
    expect(source.sync()!.textContent).toBe('');
    expect(korean.mode).toBe('showing');
    expect(english.mode).toBe('disabled');
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
});
