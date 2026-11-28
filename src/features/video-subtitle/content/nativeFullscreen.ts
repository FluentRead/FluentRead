/**
 * @file src/features/video-subtitle/content/nativeFullscreen.ts
 * 文件职责：将已有字幕时间轴映射到 Safari 系统视频全屏、Picture-in-Picture 及原生 <video> 元素全屏可选择的 TextTrack。
 * 主要内容：区分 Safari AVKit（预备原生轨道供系统菜单选择）与非 Safari 浏览器（仅在进入画中画或 <video> 元素全屏时按需懒挂载轨道，避免正常内联播放注入额外轨道）；按显示方式和双语顺序组合已缓存译文、原文与读音，采用增量脏 cue 差量更新与读音原地补丁；在画中画/元素全屏展示自有轨道期间临时移除并退出后恢复 fluent-read-video-native-cue-hidden，同时保守恢复让位的站点原轨道。
 * 模块边界：只持有自己创建的 track 节点与 cue，仅支持 <video> 元素（拒绝 <audio>），运行时注入媒体、配置和缓存读取；系统字幕样式和后台脚本调度由浏览器负责。
 */
import {getFullscreenElement, isElementInPictureInPicture, onFullscreenChange} from '@/src/platform/dom/fullscreen';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import type {VideoSubtitleDisplayMode} from '@/src/core/config/model';
import type {VideoSubtitleBilingualOrder} from '@/src/core/config/videoSubtitleAppearance';

const NATIVE_CUE_HIDDEN_CLASS = 'fluent-read-video-native-cue-hidden';

export interface NativeFullscreenSubtitleState {
  video: HTMLVideoElement | null;
  enabled: boolean;
  cues: readonly VideoSubtitleCue[];
  mode: VideoSubtitleDisplayMode;
  /** 省略时保留原文在上的既有顺序。 */
  bilingualOrder?: VideoSubtitleBilingualOrder;
  offsetMs: number;
  language: string;
  /** 提供时必须随 translation 的可见缓存变化；省略时每轮重读。 */
  revision?: string | number;
  /** 仅提供当前句结果；空读音是等待态，不能删除同媒体已经完成的读音。 */
  reading?: {enabled: boolean; source: string; text: string};
  translation: (source: string, cue: VideoSubtitleCue) => string | undefined;
}

type NativeVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
  requestFullscreen?: () => Promise<void>;
};

const escapeCueText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const readingKey = (text: string) => text.replace(/[\s\u3000]+/g, ' ').trim();

function nativeCue(state: NativeFullscreenSubtitleState, cue: VideoSubtitleCue) {
  const original = cue.text.trim();
  const translated = state.mode === 'original-only' ? '' : state.translation(original, cue)?.trim() || '';
  const base = state.mode === 'translation-only' ? translated
    : state.mode === 'original-only' || !translated || translated === original ? original
      : state.bilingualOrder === 'translation-first' ? `${translated}\n${original}` : `${original}\n${translated}`;
  const startMs = Math.max(0, cue.startMs + state.offsetMs);
  const endMs = cue.startMs + cue.durationMs + state.offsetMs;
  if (!base || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {source: original, cue: {startMs, durationMs: endMs - startMs, text: escapeCueText(base)}};
}

function withReading(base: string, original: string, reading: string, translationFirst: boolean): string {
  // 译文在上时原文位于末尾；读音仍紧跟原文，不依据字幕正文中的相同词句猜测插入位置。
  if (translationFirst) return `${base}\n${escapeCueText(reading)}`;
  const escapedOriginal = escapeCueText(original);
  return `${escapedOriginal}\n${escapeCueText(reading)}${base.slice(escapedOriginal.length)}`;
}

/** 仅判定 Safari AVKit 系统视频全屏能力（webkitEnterFullscreen），供运行时决定是否展示 Safari 菜单提示与预挂载轨道。 */
export function supportsSafariNativeVideoFullscreen(video: HTMLVideoElement | null | undefined): boolean {
  return Boolean(video && video.tagName === 'VIDEO' && typeof (video as NativeVideo).webkitEnterFullscreen === 'function');
}

/** 判定 <video> 是否支持 Safari 系统全屏、Picture-in-Picture 或元素级全屏原生轨道桥接（拒绝 <audio>）。 */
export function supportsNativeVideoFullscreen(video: HTMLVideoElement | null | undefined): boolean {
  if (!video || video.tagName !== 'VIDEO') return false;
  const candidate = video as NativeVideo;
  return typeof candidate.webkitEnterFullscreen === 'function'
    || typeof candidate.requestPictureInPicture === 'function'
    || typeof candidate.requestFullscreen === 'function';
}

export function createNativeFullscreenSubtitles(read: () => NativeFullscreenSubtitleState) {
  let video: NativeVideo | null = null;
  let node: HTMLTrackElement | null = null;
  let trackList: TextTrackList | null = null;
  let stopFullscreen: (() => void) | null = null;
  let active = false;
  let disposed = false;
  let syncing = false;
  let trackDirty = false;
  let removedNativeCueHidden = false;
  let ownedCues: VTTCue[] = [];
  let prepared: VideoSubtitleCue[] = [];
  let preparedCues: readonly VideoSubtitleCue[] | undefined;
  let preparedKey = '';
  let baseTexts: string[] = [];
  let preparedSources: string[] = [];
  const sourceIndices = new Map<string, number[]>();
  const readings = new Map<string, string>();
  const dirtyReadings = new Set<string>();
  let readingCharacters = 0;
  const previousShowing = new Set<TextTrack>();
  const isAutoShowPresentation = (target: NativeVideo): boolean => {
    const doc = target.ownerDocument;
    return isElementInPictureInPicture(doc, target) || getFullscreenElement(doc) === target;
  };
  const isNativePresentationActive = (target: NativeVideo | null): boolean =>
    Boolean(target && (target.webkitDisplayingFullscreen === true || isAutoShowPresentation(target)));
  const syncNativeCueHiddenClass = (target: NativeVideo, showingOwned: boolean) => {
    if (showingOwned) {
      if (target.classList.contains(NATIVE_CUE_HIDDEN_CLASS)) {
        target.classList.remove(NATIVE_CUE_HIDDEN_CLASS);
        removedNativeCueHidden = true;
      }
    } else if (removedNativeCueHidden) {
      target.classList.add(NATIVE_CUE_HIDDEN_CLASS);
      removedNativeCueHidden = false;
    }
  };
  const onTrackResource = () => sync();
  const onTrackChange = () => {
    // 只由当前列表的选择变化更新归属；内部 cue/模式写入不重新认领用户源轨。
    if (active && !syncing) {
      const sources = showingSources();
      if (ownedMode() !== 'showing' || sources.length) {
        previousShowing.clear();
        for (const source of sources) previousShowing.add(source);
      }
    }
    sync();
  };
  const tracks = (): TextTrack[] => {
    try { return Array.from(trackList || []); } catch { return []; }
  };
  const ownedMode = () => {
    try { return node?.track.mode; } catch { return undefined; }
  };
  const showingSources = (): TextTrack[] => tracks().filter(track => {
    try { return track !== node?.track && ['subtitles', 'captions'].includes(track.kind) && track.mode === 'showing'; }
    catch { return false; }
  });
  const snapshotSources = () => {
    previousShowing.clear();
    for (const track of showingSources()) previousShowing.add(track);
  };
  const restoreSources = () => {
    const current = tracks();
    // 用户另选的站点轨优先；不能把之前观察到的源轨叠加到新选择上。
    const anotherShowing = showingSources().length > 0;
    if (anotherShowing) return;
    for (const track of previousShowing) {
      try { if (current.includes(track) && track.mode === 'disabled') track.mode = 'showing'; }
      catch { /* 单条宿主轨道失效不能中断其余清理。 */ }
    }
  };
  const removeTrackNode = () => {
    const previous = node;
    node = null;
    ownedCues = [];
    if (!previous) return;
    previous.removeEventListener('load', onTrackResource);
    previous.removeEventListener('error', onTrackResource);
    try { previous.track.mode = 'disabled'; } catch { /* 失效的 TextTrack 不能阻止 DOM 回收。 */ }
    previous.remove();
  };
  const leave = () => {
    // Off 或用户另选源轨后不恢复旧源，避免退出再进入时重新开启字幕。
    const restore = active && ownedMode() === 'showing';
    active = false;
    if (video) syncNativeCueHiddenClass(video, false);
    try { if (node) node.track.mode = 'hidden'; } catch { /* 原生轨道可能已销毁。 */ }
    if (restore) restoreSources();
    previousShowing.clear();
  };
  const handleLeave = () => {
    if (!isNativePresentationActive(video)) leave();
  };
  const enter = () => {
    if (!active) {
      snapshotSources();
      active = true;
    }
    sync();
  };
  const handleFullscreenChange = () => {
    if (!video) return;
    if (getFullscreenElement(video.ownerDocument) === video) enter();
    else if (active && !isNativePresentationActive(video)) leave();
  };
  const detach = () => {
    leave();
    video?.removeEventListener('webkitbeginfullscreen', enter);
    video?.removeEventListener('webkitendfullscreen', handleLeave);
    video?.removeEventListener('enterpictureinpicture', enter);
    video?.removeEventListener('leavepictureinpicture', handleLeave);
    stopFullscreen?.();
    stopFullscreen = null;
    trackList?.removeEventListener('change', onTrackChange);
    trackList = null;
    removeTrackNode();
    video = null;
    trackDirty = false;
    prepared = [];
    preparedCues = undefined;
    preparedKey = '';
    baseTexts = []; preparedSources = []; sourceIndices.clear(); readings.clear(); dirtyReadings.clear(); readingCharacters = 0;
  };
  const sync = () => {
    if (disposed || syncing) return;
    syncing = true;
    try {
      const state = read();
      const next = state.enabled && supportsNativeVideoFullscreen(state.video) ? state.video as NativeVideo : null;
      if (video !== next) {
        detach();
        video = next;
        if (video) {
          video.addEventListener('webkitbeginfullscreen', enter);
          video.addEventListener('webkitendfullscreen', handleLeave);
          video.addEventListener('enterpictureinpicture', enter);
          video.addEventListener('leavepictureinpicture', handleLeave);
          stopFullscreen = onFullscreenChange(video.ownerDocument, handleFullscreenChange);
          try { trackList = video.textTracks || null; } catch { trackList = null; }
          trackList?.addEventListener('change', onTrackChange);
          // 已在全屏/画中画才挂载时没有进入前快照，不能猜测并恢复过去的源轨选择。
          active = isNativePresentationActive(video);
        }
      }
      if (!video) return;
      // 非 Safari 浏览器正常内联播放不提前注入 <track>，仅在进入 PiP 或元素级全屏时懒挂载。
      if (!supportsSafariNativeVideoFullscreen(video) && !active) return;
      const Cue = (video.ownerDocument.defaultView as (Window & {VTTCue?: typeof VTTCue}) | null)?.VTTCue;
      if (typeof Cue !== 'function') return;
      const readingEnabled = state.reading?.enabled === true;
      if (state.cues !== preparedCues) { readings.clear(); dirtyReadings.clear(); readingCharacters = 0; trackDirty = true; }
      else if (!readingEnabled) { readings.clear(); dirtyReadings.clear(); readingCharacters = 0; }
      const readingSource = readingKey(state.reading?.source || ''), readingText = state.reading?.text.trim() || '';
      if (readingEnabled && readingSource && readingText && readings.get(readingSource) !== readingText) {
        const previous = readings.get(readingSource);
        if (previous) readingCharacters -= readingSource.length + previous.length;
        readings.delete(readingSource); readings.set(readingSource, readingText);
        readingCharacters += readingSource.length + readingText.length; dirtyReadings.add(readingSource);
        while (readings.size > 160 || readingCharacters > 64_000) {
          const oldest = readings.keys().next().value!;
          readingCharacters -= oldest.length + readings.get(oldest)!.length;
          readings.delete(oldest); dirtyReadings.add(oldest);
        }
      }
      const preparationKey = JSON.stringify([state.revision, state.mode, state.bilingualOrder === 'translation-first', state.offsetMs, state.language, readingEnabled]);
      if (state.revision === undefined || state.cues !== preparedCues || preparationKey !== preparedKey) {
        prepared = []; baseTexts = []; preparedSources = [];
        sourceIndices.clear();
        for (const cue of state.cues) {
          const item = nativeCue(state, cue);
          if (!item) continue;
          const index = prepared.push(item.cue) - 1;
          // 默认关闭时不建立读音索引或原文副本，保留原轨道准备的线性开销。
          if (readingEnabled) {
            baseTexts.push(item.cue.text); preparedSources.push(item.source);
            const key = readingKey(item.source);
            const indices = sourceIndices.get(key) || []; indices.push(index); sourceIndices.set(key, indices);
          }
        }
        for (const source of readings.keys()) dirtyReadings.add(source);
        trackDirty = true;
        preparedCues = state.cues;
        preparedKey = preparationKey;
      }
      for (const source of dirtyReadings) for (const index of sourceIndices.get(source) || []) {
        const reading = state.mode === 'translation-only' ? '' : readings.get(source);
        prepared[index].text = reading ? withReading(baseTexts[index], preparedSources[index], reading, state.bilingualOrder === 'translation-first') : baseTexts[index];
      }
      if (node && node.parentElement !== video) { removeTrackNode(); trackDirty = true; }
      if (!node) {
        // 首次没有内容不占用系统菜单；已有轨暂时无译文则保留身份和用户选择。
        if (!prepared.length) return;
        node = video.ownerDocument.createElement('track');
        node.kind = 'subtitles';
        node.label = 'FluentRead';
        node.setAttribute('data-fluent-read-native-subtitles', 'true');
        node.srclang = state.language;
        node.addEventListener('load', onTrackResource);
        node.addEventListener('error', onTrackResource);
        video.appendChild(node);
        node.track.mode = 'hidden';
        ownedCues = [];
        trackDirty = true;
      }
      const track = node.track;
      // 画中画和原生 <video> 元素全屏没有系统字幕选择器，从 hidden 自动激活显示并避让站点原轨；不覆盖用户显式关闭（disabled）。
      if (active && isAutoShowPresentation(video) && track.mode === 'hidden') {
        for (const source of showingSources()) {
          try { source.mode = 'disabled'; } catch { /* 宿主原轨不可写时继续展示自有轨道。 */ }
        }
        track.mode = 'showing';
      }
      syncNativeCueHiddenClass(video, active && isAutoShowPresentation(video) && track.mode === 'showing');
      // disabled.cues 为 null 是系统 Off；只准备缓存，不借补 cue 之名改写用户选择。
      if (track.mode === 'disabled') return;
      if (node.srclang !== state.language) node.srclang = state.language;
      // 资源任务可能清空动态 cue；只有模式允许时恢复，不切换轨道、不重置选中状态。
      const cuesIntact = track.cues !== null && track.cues.length === ownedCues.length;
      if (!cuesIntact || ownedCues.length !== prepared.length) {
        for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
        ownedCues = [];
        for (const cue of prepared) {
          const created = new Cue(cue.startMs / 1000, (cue.startMs + cue.durationMs) / 1000, cue.text);
          track.addCue(created);
          ownedCues.push(created);
        }
      } else if (trackDirty) {
        // 仅差量替换变化的 cue，使 WebKit AVPlayer 立即重绘且避免长视频全量重建。
        for (let index = 0; index < prepared.length; index += 1) {
          const nextCue = prepared[index];
          const existing = ownedCues[index];
          const startTime = nextCue.startMs / 1000;
          const endTime = (nextCue.startMs + nextCue.durationMs) / 1000;
          if (existing.startTime === startTime && existing.endTime === endTime && existing.text === nextCue.text) continue;
          track.removeCue(existing);
          const created = new Cue(startTime, endTime, nextCue.text);
          track.addCue(created);
          ownedCues[index] = created;
        }
      } else if (dirtyReadings.size > 0) {
        for (const source of dirtyReadings) for (const index of sourceIndices.get(source) || []) {
          const cue = ownedCues[index];
          if (cue.text !== prepared[index].text) cue.text = prepared[index].text;
        }
      }
      trackDirty = false;
      dirtyReadings.clear();
    } catch {
      // 动态 cue 失败只等待下一次补齐，不能暗改用户模式或替其重新选择站点轨。
      trackDirty = true;
      ownedCues = [];
    } finally {
      syncing = false;
    }
  };
  return {sync, destroy: () => { disposed = true; detach(); }};
}
