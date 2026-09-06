/**
 * @file src/features/video-subtitle/content/xCaptionSource.ts
 * 文件职责：把 X 播放器中的原生轨道、sidecar 与本地识别时间轴映射到唯一合成字幕容器。
 * 主要内容：清理原生 cue 的时间标记后按播放时间选择正文，仅在内容变化时写入 DOM，保留原生 TextTrack 模式并在媒体离开时恢复。
 * 模块边界：不读取配置存储、不识别或翻译音频，也不发起网络请求；运行时注入当前媒体及字幕状态，负责挂载和卸载时序。
 */
import {VIDEO_AI_CAPTION_CONTAINER_ID, VIDEO_CAPTION_SEGMENT_SELECTOR, VIDEO_PLAYER_SELECTOR, findVideoPlayer, isXVideoPage} from './ui';
import {getVisibleVideoAiCue} from './video-ai/cueTimeline';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import {cleanSubtitleText, selectXSubtitleLanguageResources} from './xVideoSubtitleData';

export class XCaptionSource {
  private readonly changedTracks = new Map<TextTrack, TextTrackMode>();
  constructor(private readonly read: () => {video: HTMLVideoElement | null; player?: HTMLElement; enabled: boolean; aiActive: boolean; aiCues: VideoSubtitleCue[]; sidecarCues: VideoSubtitleCue[]; language: string}) {}
  restoreTracks(): void {
    for (const [track, mode] of this.changedTracks) {
      // 若宿主已主动改变模式，尊重宿主的新选择。
      try { if (track.mode === 'hidden') track.mode = mode; } catch { /* 页面可能已经销毁原生轨道。 */ }
    }
    this.changedTracks.clear();
  }
  private getOrCreateContainer(): HTMLElement | null {
    const video = this.read().video;
    const player = this.read().player || video?.closest<HTMLElement>(VIDEO_PLAYER_SELECTOR) || video?.parentElement || findVideoPlayer();
    if (!player) return null;
    let container = document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID);
    if (!(container instanceof HTMLElement)) {
      container = document.createElement('div');
      container.id = VIDEO_AI_CAPTION_CONTAINER_ID;
      container.className = 'fluent-read-video-ai-caption-container fluent-read-video-ui notranslate';
      container.setAttribute('data-fluent-read-ui', 'video-subtitle');
      container.setAttribute('translate', 'no');
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      container.appendChild(segment);
    }
    if (container.parentElement !== player) player.appendChild(container);
    return container;
  };

  private getActiveCueAtTime(cues: VideoSubtitleCue[], currentMs: number): VideoSubtitleCue | null {
    if (!Number.isFinite(currentMs)) return null;
    let active: VideoSubtitleCue | null = null;
    for (const cue of cues) {
      const endMs = cue.startMs + Math.max(cue.durationMs, 1);
      if (currentMs < cue.startMs || currentMs >= endMs) continue;
      if (!active || cue.startMs > active.startMs) active = cue;
    }
    return active;
  };

  private selectedNativeTracks(): TextTrack[] {
    const tracks = Array.from(this.read().video?.textTracks || [])
      .filter(track => track.kind === 'captions' || track.kind === 'subtitles');
    tracks.sort((left, right) => Number((this.changedTracks.get(right) || right.mode) === 'showing')
      - Number((this.changedTracks.get(left) || left.mode) === 'showing'));
    return selectXSubtitleLanguageResources(tracks.map(track => ({track, languageCode: track.language})), this.read().language)
      .map(({track}) => track);
  }

  /** 可直接导出原生完整轨道，避免把正在播放的一句误当成完整字幕。 */
  readNativeTrack(): {languageCode: string; cues: VideoSubtitleCue[]} | null {
    for (const track of this.selectedNativeTracks()) {
      const cues = Array.from(track.cues || []).map(cue => ({
        startMs: cue.startTime * 1000, durationMs: (cue.endTime - cue.startTime) * 1000,
        text: cleanSubtitleText(String((cue as TextTrackCue & {text?: string}).text || '')),
      })).filter(cue => cue.text && Number.isFinite(cue.startMs) && cue.durationMs > 0);
      if (cues.length) return {languageCode: track.language || 'original', cues};
    }
    return null;
  }

  /** 将 X 的 TextTrack / sidecar / AI cue 统一映射到既有字幕翻译观察器。 */
  sync(): HTMLElement | null {
    const {video, enabled, aiActive, aiCues, sidecarCues} = this.read();
    if (!isXVideoPage()) return null;
    const container = this.getOrCreateContainer();
    if (!container) return null;
    if (!enabled) {
      this.restoreTracks();
      container.querySelector<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR)!.textContent = '';
      container.dataset.fluentReadCaptionSource = 'none';
      return container;
    }
    const tracks = Array.from(video?.textTracks || []).filter(track => track.kind === 'captions' || track.kind === 'subtitles');
    for (const track of tracks) {
      try {
        if (track.mode !== 'hidden') {
          this.changedTracks.set(track, track.mode);
          track.mode = 'hidden';
        }
      } catch { /* 页面包装的只读轨道仍可继续尝试读取。 */ }
    }

    const currentMs = video && Number.isFinite(video.currentTime) ? video.currentTime * 1000 : Number.NaN;
    let text = '';
    let sourceKind = 'none';
    let cueId = '';

    // 用户主动请求 AI 字幕后，整个播放头由 AI 时间轴接管。不要在推理
    // 延迟期间偷偷切回 X 的原生/sidecar 文本，否则原文和译文会来回跳。
    if (aiActive) {
      const activeAiCue = getVisibleVideoAiCue(aiCues, currentMs);
      if (activeAiCue) {
        text = activeAiCue.text;
        sourceKind = 'ai';
        cueId = (activeAiCue as VideoSubtitleCue & { cueId?: string }).cueId || '';
      }
    } else if (video) {
      // auto 尊重宿主选中的轨道；显式语言使用标签匹配，不能把 French 中的 en 当成英语。
      for (const track of this.selectedNativeTracks()) {
        const activeText = Array.from(track.activeCues || [])
          .map((cue) => cleanSubtitleText(String((cue as TextTrackCue & { text?: string }).text || '')))
          .filter(Boolean)
          .join('\n');
        if (activeText) {
          text = activeText;
          sourceKind = 'native';
          break;
        }
      }
    }

    if (!aiActive && !text && sidecarCues.length > 0) {
      const activeCue = this.getActiveCueAtTime(sidecarCues, currentMs);
      if (activeCue) {
        text = activeCue.text;
        sourceKind = 'sidecar';
      }
    }
    if (!aiActive && !text && aiCues.length > 0) {
      const activeCue = getVisibleVideoAiCue(aiCues, currentMs);
      if (activeCue) {
        text = activeCue.text;
        sourceKind = 'ai';
        cueId = (activeCue as VideoSubtitleCue & { cueId?: string }).cueId || '';
      }
    }

    const segment = container.querySelector<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR);
    if (!segment) return container;
    if (segment.textContent !== text) segment.textContent = text;
    const display = text ? 'block' : 'none';
    if (segment.style.display !== display) segment.style.display = display;
    if (container.dataset.fluentReadCaptionSource !== sourceKind) {
      container.dataset.fluentReadCaptionSource = sourceKind;
    }
    if (container.dataset.fluentReadCueId !== cueId) {
      container.dataset.fluentReadCueId = cueId;
    }
    return container;
  };

}
