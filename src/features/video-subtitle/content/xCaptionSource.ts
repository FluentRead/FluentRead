/**
 * @file src/features/video-subtitle/content/xCaptionSource.ts
 * 文件职责：把 X 与 HTML 音视频中的原生轨道、sidecar 与本地识别时间轴映射到唯一合成字幕容器，并遵循 X 原生 CC 开关状态。
 * 主要内容：清理原生 cue 的时间标记后按播放时间选择正文，排除 FluentRead 自建原生全屏/画中画轨道避免自读循环，并对 Firefox/Safari 下 activeCues 为空但 track.cues 有内容的情况按 currentTime 回退读取；缓存原生 CC 开关按钮与合成容器/字幕段节点引用以消除 60 FPS querySelectorAll；为已排序的 sidecarCues 建立二分索引实现 O(log n) 查句；保持宿主 showing 轨道模式以同步原生 CC 按钮，通过视频级 CSS 隐藏原生绘制，并在禁用或换媒体时恢复轨道模式、样式与缓存。
 * 模块边界：不读取配置存储、不识别或翻译音频，也不发起网络请求；运行时注入当前媒体及字幕状态，负责挂载和卸载时序。
 */
import {getFullscreenElement, isElementInPictureInPicture} from '@/src/platform/dom/fullscreen';
import {VIDEO_AI_CAPTION_CONTAINER_ID, VIDEO_CAPTION_SEGMENT_SELECTOR, VIDEO_NATIVE_CUE_HIDDEN_CLASS, VIDEO_PLAYER_SELECTOR, findVideoPlayer, isXVideoPage, isHtmlMediaPage} from './ui';
import {normalizeVideoCaptionText} from './subtitleLogic';
import {getVisibleVideoAiCue} from './video-ai/cueTimeline';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import {cleanSubtitleText, selectXSubtitleLanguageResources} from './xVideoSubtitleData';

const X_CAPTION_CONTROL_LABEL = /\b(?:closed\s+captions?|captions?|subtitles?|cc)\b|字幕|자막|subt[ií]tulos|sous-titres|untertitel|субтитры/i;
const X_CAPTION_CONTROL_TESTID = /caption|subtitle|closed[-_]?caption/i;
const X_CAPTION_CONTROL_NON_TOGGLE = /\b(?:settings?|options?|quality|speed|playback|audio|volume|mute|unmute|fullscreen|full\s+screen|play|pause)\b|设置|画质|倍速|音量|静音|全屏|播放|暂停/i;
const X_CAPTION_CONTROL_TURN_OFF = /(?:turn\s+off|hide|disable)\s+(?:closed\s+|live\s+|auto[- ]?generated\s+)?(?:captions?|subtitles?|cc)\b|\b(?:closed\s+captions?|captions?|subtitles?|cc)\s*(?::|-)?\s*on\b|关闭.*字幕|隐藏.*字幕|字幕.*(?:已开启|已打开|オフ|非表示|解除)|자막\s*(?:끄기|숨기기)|desactivar\s+(?:los\s+)?subt[ií]tulos|d[ée]sactiver\s+les\s+sous-titres|untertitel\s+(?:deaktivieren|ausblenden)|отключить\s+субтитры/i;
const X_CAPTION_CONTROL_TURN_ON = /(?:turn\s+on|show|enable)\s+(?:closed\s+|live\s+|auto[- ]?generated\s+)?(?:captions?|subtitles?|cc)\b|\b(?:closed\s+captions?|captions?|subtitles?|cc)\s*(?::|-)?\s*off\b|(?:开启|打开|显示).*字幕|字幕.*(?:已关闭|オン|表示)|자막\s*(?:켜기|표시)|activar\s+(?:los\s+)?subt[ií]tulos|activer\s+les\s+sous-titres|untertitel\s+(?:aktivieren|einblenden)|включить\s+субтитры/i;

function readControlAttributes(element: Element): {label: string; testId: string; text: string} {
  const label = [element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ').trim();
  const testId = (element.getAttribute('data-testid') || '').trim();
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  return {label, testId, text};
}

function readControlButtonState(candidate: Element): 'on' | 'off' | null {
  const pressed = candidate.getAttribute('aria-pressed') ?? candidate.getAttribute('aria-checked');
  if (pressed === 'false') return 'off';
  if (pressed === 'true') return 'on';
  const {label} = readControlAttributes(candidate);
  if (X_CAPTION_CONTROL_TURN_ON.test(label)) return 'off';
  if (X_CAPTION_CONTROL_TURN_OFF.test(label)) return 'on';
  return null;
}

/** 识别 X 播放器控制栏中的原生 CC 开关，排除 FluentRead 自有入口与其他播放器菜单按钮。 */
export function isXNativeCaptionControl(element: Element): boolean {
  if (element.closest('.fluent-read-video-ui, [hidden], [aria-hidden="true"]')) return false;
  const tag = element.tagName.toLowerCase();
  if (tag !== 'button' && element.getAttribute('role') !== 'button') return false;
  const {label, testId, text} = readControlAttributes(element);
  const hasToggleState = element.hasAttribute('aria-pressed') || element.hasAttribute('aria-checked');
  const popup = element.getAttribute('aria-haspopup');
  if ((popup === 'menu' || popup === 'listbox') && !hasToggleState) return false;
  if (X_CAPTION_CONTROL_NON_TOGGLE.test(label) && !X_CAPTION_CONTROL_LABEL.test(label)) return false;
  return X_CAPTION_CONTROL_TESTID.test(testId) || X_CAPTION_CONTROL_LABEL.test(label) || /^cc$/i.test(text);
}

/** 读取当前已挂载 X 播放器控制栏的原生 CC 状态；未挂载或语义不明确时返回 null 交由轨道状态判定。 */
export function readXNativeCaptionControlState(player: HTMLElement | null | undefined): 'on' | 'off' | null {
  if (!player) return null;
  let state: 'on' | 'off' | null = null;
  for (const candidate of player.querySelectorAll('button, [role="button"]')) {
    if (!isXNativeCaptionControl(candidate)) continue;
    const candidateState = readControlButtonState(candidate);
    if (candidateState === 'off') return 'off';
    if (candidateState === 'on') state = 'on';
  }
  return state;
}

type SidecarCueIndex =
  | {cues: VideoSubtitleCue[]; length: number; sorted: true; starts: number[]; maxEnds: number[]}
  | {cues: VideoSubtitleCue[]; length: number; sorted: false};

export class XCaptionSource {
  private readonly changedTracks = new Map<TextTrack, TextTrackMode>();
  private hiddenCueVideo: HTMLMediaElement | null = null;
  private rememberedButtonState: 'on' | 'off' | null = null;
  private cachedCcPlayer: HTMLElement | null = null;
  private cachedCcButton: Element | null = null;
  private cachedContainer: HTMLElement | null = null;
  private cachedSegment: HTMLElement | null = null;
  private sidecarIndex: SidecarCueIndex | undefined;

  constructor(private readonly read: () => {video: HTMLMediaElement | null; player?: HTMLElement; enabled: boolean; aiActive: boolean; aiCues: VideoSubtitleCue[]; sidecarCues: VideoSubtitleCue[]; language: string}) {}

  private isShowingOwnedNativeTrack(video: HTMLMediaElement): boolean {
    const doc = video.ownerDocument || document;
    if (!isElementInPictureInPicture(doc, video) && getFullscreenElement(doc) !== video) return false;
    const ownedNodes = video.querySelectorAll<HTMLTrackElement>('track[data-fluent-read-native-subtitles="true"]');
    for (const node of ownedNodes) {
      try {
        if (node.track?.mode === 'showing') return true;
      } catch { /* 页面可能已销毁轨道节点。 */ }
    }
    return false;
  }

  private setNativeCueHidden(video: HTMLMediaElement | null): void {
    const target = video && this.isShowingOwnedNativeTrack(video) ? null : video;
    if (this.hiddenCueVideo === target) {
      target?.classList?.add(VIDEO_NATIVE_CUE_HIDDEN_CLASS);
      return;
    }
    this.hiddenCueVideo?.classList?.remove(VIDEO_NATIVE_CUE_HIDDEN_CLASS);
    this.hiddenCueVideo = target;
    this.hiddenCueVideo?.classList?.add(VIDEO_NATIVE_CUE_HIDDEN_CLASS);
  }

  private hostTrackMode(track: TextTrack): TextTrackMode {
    return track.mode === 'hidden' && this.changedTracks.has(track) ? this.changedTracks.get(track)! : track.mode;
  }

  private restoreTrackModes(keep?: Set<TextTrack>): void {
    for (const [track, mode] of [...this.changedTracks]) {
      if (keep?.has(track)) continue;
      // 若宿主已主动改变模式，尊重宿主的新选择。
      try { if (track.mode === 'hidden') track.mode = mode; } catch { /* 页面可能已经销毁原生轨道。 */ }
      this.changedTracks.delete(track);
    }
  }

  restoreTracks(): void {
    this.restoreTrackModes();
    this.setNativeCueHidden(null);
    this.rememberedButtonState = null;
    this.cachedCcPlayer = null;
    this.cachedCcButton = null;
    this.cachedContainer = null;
    this.cachedSegment = null;
    this.sidecarIndex = undefined;
  }

  private readCachedNativeCaptionControlState(player: HTMLElement | null | undefined): 'on' | 'off' | null {
    if (!player) {
      this.cachedCcPlayer = null;
      this.cachedCcButton = null;
      return null;
    }
    if (
      this.cachedCcPlayer === player
      && this.cachedCcButton
      && this.cachedCcButton.isConnected
      && player.contains(this.cachedCcButton)
      && isXNativeCaptionControl(this.cachedCcButton)
    ) {
      const cachedState = readControlButtonState(this.cachedCcButton);
      if (cachedState !== null) return cachedState;
    }
    this.cachedCcPlayer = null;
    this.cachedCcButton = null;
    let state: 'on' | 'off' | null = null;
    let matchedButton: Element | null = null;
    for (const candidate of player.querySelectorAll('button, [role="button"]')) {
      if (!isXNativeCaptionControl(candidate)) continue;
      const candidateState = readControlButtonState(candidate);
      if (candidateState === 'off') {
        this.cachedCcPlayer = player;
        this.cachedCcButton = candidate;
        return 'off';
      }
      if (candidateState === 'on') {
        state = 'on';
        matchedButton = candidate;
      }
    }
    if (matchedButton) {
      this.cachedCcPlayer = player;
      this.cachedCcButton = matchedButton;
    }
    return state;
  }

  private getOrCreateContainer(video: HTMLMediaElement | null, boundPlayer?: HTMLElement): HTMLElement | null {
    const player = boundPlayer || video?.closest<HTMLElement>(VIDEO_PLAYER_SELECTOR) || video?.parentElement || findVideoPlayer();
    if (!player) return null;
    let container: HTMLElement | null = this.cachedContainer?.isConnected && this.cachedContainer.id === VIDEO_AI_CAPTION_CONTAINER_ID
      ? this.cachedContainer
      : document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID);
    if (!(container instanceof HTMLElement)) {
      container = document.createElement('div');
      container.id = VIDEO_AI_CAPTION_CONTAINER_ID;
      container.className = 'fluent-read-video-ai-caption-container fluent-read-video-ui notranslate';
      container.setAttribute('data-fluent-read-ui', 'video-subtitle');
      container.setAttribute('translate', 'no');
      const segment = document.createElement('span');
      segment.className = 'ytp-caption-segment';
      container.appendChild(segment);
      this.cachedContainer = container;
      this.cachedSegment = segment;
    }
    if (container.parentElement !== player) player.appendChild(container);
    return container;
  }

  private getSegment(container: HTMLElement): HTMLElement | null {
    if (this.cachedContainer === container && this.cachedSegment && this.cachedSegment.parentElement === container) {
      return this.cachedSegment;
    }
    const segment = container.querySelector<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR);
    this.cachedContainer = container;
    this.cachedSegment = segment;
    return segment;
  }

  private getSidecarIndex(cues: VideoSubtitleCue[]): SidecarCueIndex {
    const length = cues.length;
    if (this.sidecarIndex && this.sidecarIndex.cues === cues && this.sidecarIndex.length === length) {
      return this.sidecarIndex;
    }
    const starts = new Array<number>(length);
    const maxEnds = new Array<number>(length);
    let previousStart = -Infinity;
    let runningMaxEnd = -Infinity;
    for (let i = 0; i < length; i += 1) {
      const cue = cues[i]!;
      const startMs = cue.startMs;
      const durationMs = cue.durationMs;
      if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || startMs < previousStart) {
        this.sidecarIndex = {cues, length, sorted: false};
        return this.sidecarIndex;
      }
      previousStart = startMs;
      starts[i] = startMs;
      const endMs = startMs + Math.max(durationMs, 1);
      if (endMs > runningMaxEnd) runningMaxEnd = endMs;
      maxEnds[i] = runningMaxEnd;
    }
    this.sidecarIndex = {cues, length, sorted: true, starts, maxEnds};
    return this.sidecarIndex;
  }

  private getActiveCueAtTime(cues: VideoSubtitleCue[], currentMs: number): VideoSubtitleCue | null {
    if (!Number.isFinite(currentMs)) return null;
    const index = this.getSidecarIndex(cues);
    if (index.sorted) {
      let low = 0;
      let high = index.starts.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (index.starts[mid]! <= currentMs) low = mid + 1;
        else high = mid;
      }
      let active: VideoSubtitleCue | null = null;
      for (let i = low - 1; i >= 0 && index.maxEnds[i]! > currentMs; i -= 1) {
        const startMs = index.starts[i]!;
        if (active && startMs < active.startMs) break;
        const cue = cues[i]!;
        if (currentMs < startMs + Math.max(cue.durationMs, 1)) active = cue;
      }
      return active;
    }
    let active: VideoSubtitleCue | null = null;
    for (const cue of cues) {
      const endMs = cue.startMs + Math.max(cue.durationMs, 1);
      if (currentMs < cue.startMs || currentMs >= endMs) continue;
      if (!active || cue.startMs > active.startMs) active = cue;
    }
    return active;
  }

  private readActiveTrackText(track: TextTrack, currentMs: number): string {
    const activeCues = Array.from(track.activeCues || []);
    if (activeCues.length > 0) {
      return activeCues
        .map((cue) => cleanSubtitleText(String((cue as TextTrackCue & {text?: string}).text || '')))
        .filter(Boolean)
        .join('\n');
    }
    // Firefox/Safari 在 hidden 或 seek 瞬间可能返回空的 activeCues，此时按 currentTime 从 track.cues 回退读取。
    if (!Number.isFinite(currentMs) || !track.cues || track.cues.length === 0) return '';
    const currentSec = currentMs / 1000;
    const matched: string[] = [];
    for (const cue of Array.from(track.cues)) {
      if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime)) continue;
      if (currentSec < cue.startTime || currentSec >= cue.endTime) continue;
      const cleaned = cleanSubtitleText(String((cue as TextTrackCue & {text?: string}).text || ''));
      if (cleaned) matched.push(cleaned);
    }
    return matched.join('\n');
  }

  private getHostSubtitleTracks(video: HTMLMediaElement | null | undefined): TextTrack[] {
    const ownedNodes = video?.querySelectorAll<HTMLTrackElement>('track[data-fluent-read-native-subtitles="true"]');
    const owned = ownedNodes?.length
      ? new Set(Array.from(ownedNodes, node => node.track))
      : null;
    return Array.from(video?.textTracks || []).filter(
      track => (track.kind === 'captions' || track.kind === 'subtitles') && !owned?.has(track),
    );
  }

  private selectTracksFrom(tracks: TextTrack[], language: string): TextTrack[] {
    const sorted = [...tracks];
    sorted.sort((left, right) => Number(this.hostTrackMode(right) === 'showing')
      - Number(this.hostTrackMode(left) === 'showing'));
    return selectXSubtitleLanguageResources(sorted.map(track => ({track, languageCode: track.language})), language)
      .map(({track}) => track);
  }

  private selectedNativeTracks(): TextTrack[] {
    const {video, language} = this.read();
    return this.selectTracksFrom(this.getHostSubtitleTracks(video), language);
  }

  private resolveNativeCaptionActive(tracks: TextTrack[], player: HTMLElement | null | undefined): boolean {
    const hasShowingTrack = tracks.some(track => this.hostTrackMode(track) === 'showing');
    if (!isXVideoPage()) return tracks.length === 0 || hasShowingTrack;
    const liveButtonState = this.readCachedNativeCaptionControlState(player);
    if (liveButtonState !== null) this.rememberedButtonState = liveButtonState;
    if (liveButtonState === 'off') return false;
    if (hasShowingTrack) {
      if (liveButtonState === null && this.rememberedButtonState === 'off') this.rememberedButtonState = null;
      return true;
    }
    if (tracks.length > 0) {
      if (liveButtonState === 'on') return true;
      const hasHostHiddenTrack = tracks.some(track => this.hostTrackMode(track) === 'hidden');
      return this.rememberedButtonState === 'on' && hasHostHiddenTrack;
    }
    return this.rememberedButtonState !== 'off';
  }

  /** 判断当前视频是否带有任何原生字幕轨（含当前被原生 CC 关闭的轨道，排除自有原生字幕轨）。 */
  hasNativeTracks(): boolean {
    const {video} = this.read();
    return this.getHostSubtitleTracks(video).length > 0;
  }

  /** 判断宿主原生 CC 开关当前是否允许显示原生或 sidecar 字幕。 */
  isNativeCaptionActive(): boolean {
    const {video, player} = this.read();
    const tracks = this.getHostSubtitleTracks(video);
    const resolvedPlayer = player || video?.closest<HTMLElement>(VIDEO_PLAYER_SELECTOR) || video?.parentElement || findVideoPlayer();
    return this.resolveNativeCaptionActive(tracks, resolvedPlayer);
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

  /** 映射 TextTrack / sidecar / AI cue，并在帧回调中复用本轮已同步的容器。 */
  sync(onTextChange?: (container: HTMLElement) => void): HTMLElement | null {
    if (!isXVideoPage() && !isHtmlMediaPage()) return null;
    const {video, player, enabled, aiActive, aiCues, sidecarCues, language} = this.read();
    const container = this.getOrCreateContainer(video, player);
    if (!container) return null;
    if (!enabled) {
      this.restoreTracks();
      const segment = this.getSegment(container)!;
      segment.textContent = '';
      segment.style.display = 'none';
      container.dataset.fluentReadCaptionSource = 'none';
      container.dataset.fluentReadCueId = '';
      return container;
    }

    const tracks = this.getHostSubtitleTracks(video);
    const liveTrackSet = new Set(tracks);
    for (const track of [...this.changedTracks.keys()]) {
      if (!liveTrackSet.has(track) || track.mode !== 'hidden') this.changedTracks.delete(track);
    }

    const resolvedPlayer = player || container.parentElement;
    const nativeCaptionsActive = this.resolveNativeCaptionActive(tracks, resolvedPlayer);

    let text = '';
    let sourceKind = 'none';
    let cueId = '';

    if (!aiActive && !nativeCaptionsActive) {
      this.restoreTrackModes();
      this.setNativeCueHidden(null);
    } else {
      // 保留宿主 showing 模式，通过视频级 CSS 隐藏原生绘制，避免破坏 X 原生 CC 按钮状态同步；
      // 仅当用户显式选择了非当前显示轨时，才临时以 hidden 激活目标语言轨读取 cue。
      this.setNativeCueHidden(video);
      if (!aiActive) {
        const requestedTracks = this.selectTracksFrom(tracks, language);
        const activatedTracks = new Set<TextTrack>();
        for (const track of requestedTracks) {
          try {
            if (track.mode === 'disabled') {
              this.changedTracks.set(track, 'disabled');
              track.mode = 'hidden';
              activatedTracks.add(track);
            } else if (this.changedTracks.has(track)) {
              activatedTracks.add(track);
            }
          } catch { /* 页面包装的只读轨道仍可继续尝试读取。 */ }
        }
        this.restoreTrackModes(activatedTracks);
      } else {
        this.restoreTrackModes();
      }

      const currentMs = video && Number.isFinite(video.currentTime) ? video.currentTime * 1000 : Number.NaN;
      // 隐藏写入可能改变 live 轨道；仅在本次同步内复用此后的选轨结果，cue 仍直接读取。
      const selectedTracks = this.selectedNativeTracks();
      const hasNativeTimeline = selectedTracks.some(track => (track.cues?.length || 0) > 0);

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
        for (const track of selectedTracks) {
          if (track.mode === 'disabled') continue;
          const activeText = this.readActiveTrackText(track, currentMs);
          if (activeText) {
            text = activeText;
            sourceKind = 'native';
            break;
          }
        }
      }

      if (!aiActive && !hasNativeTimeline && sidecarCues.length > 0) {
        const activeCue = this.getActiveCueAtTime(sidecarCues, currentMs);
        if (activeCue) {
          text = activeCue.text;
          sourceKind = 'sidecar';
        }
      }
      if (!aiActive && !hasNativeTimeline && sidecarCues.length === 0 && aiCues.length > 0) {
        const activeCue = getVisibleVideoAiCue(aiCues, currentMs);
        if (activeCue) {
          text = activeCue.text;
          sourceKind = 'ai';
          cueId = (activeCue as VideoSubtitleCue & { cueId?: string }).cueId || '';
        }
      }
    }

    const segment = this.getSegment(container);
    if (!segment) return container;
    const previousText = segment.textContent || '';
    if (previousText !== text) segment.textContent = text;
    const display = text ? 'block' : 'none';
    if (segment.style.display !== display) segment.style.display = display;
    if (container.dataset.fluentReadCaptionSource !== sourceKind) {
      container.dataset.fluentReadCaptionSource = sourceKind;
    }
    if (container.dataset.fluentReadCueId !== cueId) {
      container.dataset.fluentReadCueId = cueId;
    }
    if (onTextChange && previousText !== text && normalizeVideoCaptionText(previousText) !== normalizeVideoCaptionText(text)) {
      onTextChange(container);
    }
    return container;
  }
}
