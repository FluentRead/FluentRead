/**
 * @file src/features/video-subtitle/content/runtime.ts
 * 文件职责：实现 YouTube 与 X 页面视频字幕翻译运行时，协调原生字幕读取、timedtext 预取、逐条翻译、播放时间追赶、显示模式、设置菜单和字幕下载。
 * 主要内容：协调当前视频与全屏宿主、原生轨道、独立识别语言、完整字幕持久缓存恢复、预翻译、菜单进度和取消生命周期，并在切换视频或禁用后清理旧状态。
 * 模块边界：本文件只在 content 页面编排，不拦截 fetch/XHR 也不实现翻译 provider；MAIN-world bridge 在独立模块捕获 timedtext，解析算法在 youtubeSubtitleData，翻译经 app client。
 */
import browser from 'webextension-polyfill';
import {
  VIDEO_AI_CAPTION_CONTAINER_ID,
  VIDEO_CAPTION_CONTAINER_SELECTOR,
  VIDEO_TRANSLATION_OVERLAY_ID,
  VIDEO_NORMALIZED_CAPTION_OVERLAY_ID,
  VIDEO_TRANSLATION_LAYER_ID,
  VIDEO_TRANSLATION_BUTTON_ID,
  VIDEO_TRANSLATION_MENU_ID,
  VIDEO_TRANSLATION_ACTIVE_CLASS,
  VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS,
  VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS,
  VIDEO_DISPLAY_HIDDEN_CLASS,
  VIDEO_NORMALIZED_CAPTION_CLASS,
  VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS,
  X_SUBTITLE_RESOURCE_MESSAGE,
  VIDEO_CAPTION_EMPTY_GRACE_MS,
  VIDEO_SUBTITLE_DOWNLOAD_CONCURRENCY,
  VIDEO_CAPTION_STABILITY_MS,
  normalizeVideoSubtitleDisplayMode,
  getTimedTextCacheKey,
  isOriginalTimedTextUrl,
  downloadSubtitleSrt,
  isYouTubeVideoPage,
  isXVideoPage,
  isXHostPage,
  isSupportedVideoPage,
  readVisibleCaptionText,
  findCaptionContainer,
  findVideoPlayer,
  getVideoPageKey,
  markVideoUi,
  videoUi,
  getOrCreateTranslationOverlay,
  getOrCreateNormalizedCaptionOverlay,
  removeTranslationOverlay,
  syncTranslationOverlayPosition,
  applyVideoDisplayState,
  installVideoSubtitleStyle
} from './ui';
export {isYouTubeVideoPage, isXVideoPage, isXHostPage, isSupportedVideoPage, normalizeVideoSubtitleDisplayMode, readVisibleCaptionText, VIDEO_CAPTION_SEGMENT_SELECTOR} from './ui';
import {XCaptionSource} from './xCaptionSource';
import {XHlsAudioReader} from './hlsAudioRuntime';
import {XSubtitleLoader} from './xSubtitleLoader';
import {VideoTranslationCache} from './translationCache';
import {createVideoSubtitleAbortError, translateVideoSubtitleCues, getVideoTranslationConfigFingerprint, normalizeVideoCaptionText, revealVideoSubtitleTranslation} from './subtitleLogic';
export {translateVideoSubtitleCues, getVideoTranslationConfigFingerprint, normalizeVideoCaptionText, isIncrementalVideoCaption, revealVideoSubtitleTranslation} from './subtitleLogic';
export {getVideoSubtitleDownloadErrorMessage} from './ui';
import { config, requestConfigPatch, subscribeConfig } from '@/src/services/config/store';
import {getVideoUiLanguage, localizeVideoUiText, refreshVideoUiAccessibility, refreshVideoUiText, getVideoSubtitleDownloadErrorMessage} from './ui';
import {
  type Config,
} from '@/src/core/config/model';
import { translateVideoText } from '@/src/app/translation/client';
import {
  buildYoutubeTimedTextUrl,
  chooseYoutubeCaptionTrackForLocation,
  finalizeVideoSubtitleCues,
  parseYoutubeTimedTextResponse,
  type VideoSubtitleCue,
} from './youtubeSubtitleData';
import {validateYoutubeTimedTextMessage} from './youtubeTimedTextMessage';
import {YOUTUBE_BRIDGE_REPLAY_EVENT} from './youtubeTimedTextBridgeCore';
import {getVideoPretranslationWindowMs, getVideoServiceLabel} from './serviceProfile';
export {
  getVideoPretranslationWindowMs,
  getVideoServiceLabel,
  VIDEO_PRETRANSLATION_AI_WINDOW_MS,
  VIDEO_PRETRANSLATION_MACHINE_WINDOW_MS,
} from './serviceProfile';
import {
  isXSubtitleResourceUrl,
} from './xVideoSubtitleData';
import {
  normalizeVideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/transcription';
import {
  upsertVideoAiSubtitleCue,
  VIDEO_AI_CUE_MIN_DURATION_MS,
} from './video-ai/cueTimeline';
import {
  VideoAiCaptureController,
  type VideoAiAudioChunk,
  type VideoAiTranscriptionResult,
} from './video-ai/capture';
import {
  VideoAiFullCaptureController,
  type VideoAiFullCapturePhase,
  type VideoAiFullCaptureProgress,
} from './video-ai/fullCapture';
import { encodeVideoAiPcm16Base64 } from './video-ai/audioWindow';
import type { VideoAiStabilizedCue } from './video-ai/streamingTranscript';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {createVideoPlayerMenu, renderVideoAiMenu} from './playerMenu';
import {requestLocalVideoModelReadiness} from './localModelReadiness';
import {createVideoPlayerLocator} from './videoPlayerLocator';
import {createVideoPlayerBinding, type VideoPlayerBinding} from './videoPlayerBinding';
import {getVideoTranscriptionCacheRequest, VideoTranscriptionCacheClient} from './transcriptionCacheClient';
import {buildVideoAiSubtitleVideoKey, type VideoAiSubtitleCacheRequest} from '../transcriptionCache';

// 兼容既有测试与外部调用方；AI 时间轴的实现位于 video-ai 目录。
export {
  getVisibleVideoAiCue,
  mergeVideoAiSubtitleCues,
  upsertVideoAiSubtitleCue,
  VIDEO_AI_CUE_EARLY_TOLERANCE_MS,
  VIDEO_AI_CUE_LATE_GRACE_MS,
} from './video-ai/cueTimeline';

type VideoConfigPatch = Partial<Pick<Config, 'videoTranslationEnabled' | 'videoSubtitleVisible' | 'videoSubtitleDisplayMode' | 'videoSubtitleFontSize' | 'videoLocalModel'>>;

/**
 * 挂载 YouTube / X 播放器内的字幕翻译入口和字幕监听器。
 * X 的 AI 字幕是用户主动点击后，先完整采集视频音频，再交给扩展 offscreen
 * 页面内的本地 Whisper 模型和翻译服务；默认不会采集音频，音频不会离开浏览器。
 */
export function mountVideoSubtitleTranslation(): () => void {
  // X 是 SPA：内容脚本可能先在 /home 加载，之后才无刷新进入 /status。
  // 在 X 域常驻控制器，信息流、个人主页和帖子共用当前视频定位。
  if (!isSupportedVideoPage() && !isXHostPage()) return () => undefined;

  const style = installVideoSubtitleStyle();
  let destroyed = false;
  let generation = 0;
  let lastSource = '';
  let lastTranslatedSource = '';
  let lastTranslatedText = '';
  let videoPageKey = getVideoPageKey();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let emptyCaptionTimer: ReturnType<typeof setTimeout> | undefined;
  let uiSyncTimer: number | undefined;
  let captionObserver: MutationObserver | undefined;
  let observedContainer: HTMLElement | null = null;
  let menuElement: HTMLElement | null = null;
  let buttonElement: HTMLButtonElement | null = null;
  let pendingTranslationSource = '';
  let pendingTranslationOverlay: HTMLElement | null = null;
  let translationLoopRunning = false;
  let stableCaptionTimer: ReturnType<typeof setTimeout> | undefined;
  let stableCaptionSource = '';
  let stableCaptionOverlay: HTMLElement | null = null;
  const capturedSubtitleTracks = new Map<string, { url: string; cues: VideoSubtitleCue[] }>();
  const videoTranslator = new VideoTranslationCache((text, signal) => translateVideoText(text, signal, isXVideoPage() ? config.videoSourceLanguage : undefined));
  let observedVideo: HTMLVideoElement | null = null;
  let pretranslationTimer: ReturnType<typeof setTimeout> | undefined;
  let pretranslationTrackRequest: Promise<void> | undefined;
  let pretranslationTrackRequestKey = '';
  let pretranslationTrackRetryAt = 0;
  let pretranslationTrackKey = '';
  let pretranslationCues: VideoSubtitleCue[] = [];
  let pretranslationCacheVersion = 0;
  let pretranslationConfigKey = getVideoTranslationConfigFingerprint(config);
  let progressiveCueKey = '';
  let progressiveCue: VideoSubtitleCue | null = null;
  let progressiveTranslation = '';
  let normalizedCaptionCueKey = '';
  let normalizedCaptionActive = false;
  let subtitleDownloadAbortController: AbortController | undefined;
  let aiCapture: VideoAiCaptureController | null = null;
  let aiFullCapture: VideoAiFullCaptureController | null = null;
  let aiFullPhase: VideoAiFullCapturePhase = 'idle';
  let aiModelChecking = false;
  let aiFullProgress: VideoAiFullCaptureProgress = {
    phase: 'idle',
    captureMode: undefined,
    progress: 0,
    capturedMs: 0,
    durationMs: 0,
    transcribedMs: 0,
    windowIndex: 0,
    windowCount: 0,
  };
  // 模型缺失和采集错误都在播放器菜单中以同一份状态展示。
  let aiCaptureError = '';
  let aiCues: VideoSubtitleCue[] = [];
  let activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
  const aiStreamId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `video-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let observedMediaSource = '';
  let observedStableMediaKey = '';
  let mediaMissingTimer: ReturnType<typeof setTimeout> | undefined;
  let activeVideoLanguage = config.videoSourceLanguage;
  const playerLocator = createVideoPlayerLocator();
  let playerBinding: VideoPlayerBinding | undefined;
  let cacheEpoch = 0;
  let subtitlesPreviouslyEnabled = config.on && config.videoTranslationEnabled;
  let cacheLookup: Promise<boolean> | undefined;
  let activeAiCacheRequest: VideoAiSubtitleCacheRequest | null = null;
  const transcriptCache = new VideoTranscriptionCacheClient(browser.runtime.sendMessage.bind(browser.runtime));
  const currentCacheRequest = () => getVideoTranscriptionCacheRequest(observedVideo, activeAiModel, activeVideoLanguage, window.location.href);
  const stableMediaKey = (video: HTMLVideoElement | null) => {
    const request = getVideoTranscriptionCacheRequest(video, activeAiModel, activeVideoLanguage, window.location.href);
    const source = request?.source;
    return source ? buildVideoAiSubtitleVideoKey(source) || String(source.directSource || '') : '';
  };
  const hlsAudio = new XHlsAudioReader();
  const xSubtitleLoader = new XSubtitleLoader({
    fetch: (url, options) => fetch(url, {...options, credentials: 'omit'}),
    language: () => config.videoSourceLanguage,
    onCues: (url, cues) => appendXSubtitleCues(url, cues),
  });
  const xSubtitleTrackKey = 'x:captions';
  let xSubtitleCues: VideoSubtitleCue[] = [];

  const isAiCaptureRunning = () => aiCapture?.isRunning() === true;
  const isAiFullActive = () => aiFullCapture?.isActive() === true;
  const isAiCaptureRequested = () => aiCapture?.isRequested() === true || aiFullCapture?.isRequested() === true;
  const isAiCaptureActive = () => isAiCaptureRunning() || isAiCaptureRequested();

  const xCaptionSource = new XCaptionSource(() => ({
    video: observedVideo, player: playerLocator.getTarget()?.player, aiActive: isAiCaptureActive(), aiCues,
    enabled: config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false,
    sidecarCues: pretranslationTrackKey.startsWith('x:') ? pretranslationCues : [], language: config.videoSourceLanguage,
  }));
  const syncXVideoCaptionSource = () => xCaptionSource.sync();

  const clearRenderedTranslation = () => {
    document.querySelectorAll(`#${VIDEO_TRANSLATION_OVERLAY_ID}`).forEach((node) => {
      node.textContent = '';
    });
  };

  const deactivateNormalizedCaption = () => {
    document.querySelectorAll(VIDEO_CAPTION_CONTAINER_SELECTOR).forEach((node) => {
      node.classList.remove(VIDEO_NORMALIZED_CAPTION_CLASS);
    });
    document.querySelectorAll(`#${VIDEO_TRANSLATION_LAYER_ID}`).forEach((node) => {
      node.classList.remove(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
    });
    document.querySelectorAll(`#${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}`).forEach((node) => {
      node.textContent = '';
    });
    normalizedCaptionCueKey = '';
    normalizedCaptionActive = false;
  };

  const clearProgressiveCaption = () => {
    progressiveCueKey = '';
    progressiveCue = null;
    progressiveTranslation = '';
    deactivateNormalizedCaption();
  };

  const cancelCaptionEmptyClear = () => {
    if (!emptyCaptionTimer) return;
    clearTimeout(emptyCaptionTimer);
    emptyCaptionTimer = undefined;
  };

  const cancelStableCaption = () => {
    if (stableCaptionTimer) clearTimeout(stableCaptionTimer);
    stableCaptionTimer = undefined;
    stableCaptionSource = '';
    stableCaptionOverlay = null;
  };

  const resetTranslationState = () => {
    cancelCaptionEmptyClear();
    cancelStableCaption();
    generation += 1;
    lastSource = '';
    lastTranslatedSource = '';
    lastTranslatedText = '';
    pendingTranslationSource = '';
    pendingTranslationOverlay = null;
    clearProgressiveCaption();
    clearRenderedTranslation();
  };

  const canTranslateVideo = () => {
    const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
    return config.on
      && config.videoTranslationEnabled
      && config.videoSubtitleVisible !== false
      && displayMode !== 'original-only';
  };

  const clearPretranslationState = (clearTrack = false) => {
    if (pretranslationTimer) {
      clearTimeout(pretranslationTimer);
      pretranslationTimer = undefined;
    }
    pretranslationCacheVersion += 1;
    videoTranslator.clear();
    resetTranslationState();
    if (clearTrack) {
      pretranslationTrackRequest = undefined;
      pretranslationTrackRequestKey = '';
      pretranslationTrackRetryAt = 0;
      pretranslationTrackKey = '';
      pretranslationCues = [];
    }
  };

  const normalizeVideoSourceKey = (source: string): string => source.replace(/[\s\u3000]+/g, ' ').trim();

  const getCachedVideoTranslation = (source: string, prefetch = false) => videoTranslator.request(source, prefetch);

  const getCurrentVideoTimeMs = (): number => {
    const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
    const currentVideo = player?.querySelector<HTMLVideoElement>('video.html5-main-video, video') || observedVideo;
    const currentTime = currentVideo?.currentTime;
    return typeof currentTime === 'number' && Number.isFinite(currentTime)
      ? currentTime * 1000
      : Number.NaN;
  };

  const findProgressiveCue = (source: string): VideoSubtitleCue | null => {
    const normalizedSource = normalizeVideoCaptionText(source);
    if (!normalizedSource || pretranslationCues.length === 0) return null;

    const foldedSource = normalizedSource.toLocaleLowerCase();
    const currentMs = getCurrentVideoTimeMs();
    const sourceLength = Array.from(normalizedSource).length;
    const getTimeDistance = (cue: VideoSubtitleCue): number => {
      const endMs = cue.startMs + Math.max(cue.durationMs, 500);
      return Number.isFinite(currentMs)
        ? currentMs < cue.startMs
          ? cue.startMs - currentMs
          : currentMs > endMs
            ? currentMs - endMs
            : 0
        : 0;
    };
    const score = (cue: VideoSubtitleCue): number[] => {
      const fullSource = normalizeVideoCaptionText(cue.text);
      const exact = fullSource.toLocaleLowerCase() === foldedSource ? 0 : 1;
      return [
        getTimeDistance(cue),
        exact,
        Math.abs(Array.from(fullSource).length - sourceLength),
        cue.startMs,
      ];
    };

    const pickBest = (predicate: (cue: VideoSubtitleCue, foldedText: string) => boolean): VideoSubtitleCue | null => {
      let best: VideoSubtitleCue | null = null;
      let bestScore: number[] | null = null;
      for (const cue of pretranslationCues) {
        const foldedText = normalizeVideoCaptionText(cue.text).toLocaleLowerCase();
        if (!predicate(cue, foldedText)) continue;
        const nextScore = score(cue);
        let isBetter = bestScore === null;
        if (bestScore) {
          for (let index = 0; index < nextScore.length; index += 1) {
            if (nextScore[index] === bestScore[index]) continue;
            isBetter = nextScore[index] < bestScore[index];
            break;
          }
        }
        if (isBetter) {
          best = cue;
          bestScore = nextScore;
        }
      }
      return best;
    };

    const matched = pickBest((_cue, fullSource) =>
      fullSource === foldedSource || fullSource.startsWith(foldedSource));
    if (matched) return matched;

    // 部分 YouTube 版本只把“当前词”写入 DOM，而不是写入完整前缀。
    // 此时用播放器时间轴和当前词反查完整 cue，避免一直等不到稳定句子。
    if (!Number.isFinite(currentMs) || normalizedSource.length < 3) return null;
    return pickBest((cue, fullSource) => {
      if (getTimeDistance(cue) > 1200) return false;
      return fullSource.includes(foldedSource) || foldedSource.includes(fullSource);
    });
  };

  const getProgressiveCueKey = (cue: VideoSubtitleCue): string =>
    `${(cue as VideoSubtitleCue & { cueId?: string }).cueId || cue.startMs}:${normalizeVideoCaptionText(cue.text)}`;

  const isCueActiveAtTime = (cue: VideoSubtitleCue, currentMs: number): boolean => {
    const endMs = cue.startMs + Math.max(cue.durationMs, 500);
    return currentMs >= cue.startMs && currentMs < endMs;
  };

  const findActiveProgressiveCue = (): VideoSubtitleCue | null => {
    const currentMs = getCurrentVideoTimeMs();
    if (!Number.isFinite(currentMs) || pretranslationCues.length === 0) return null;

    let active: VideoSubtitleCue | null = null;
    for (const cue of pretranslationCues) {
      if (!isCueActiveAtTime(cue, currentMs)) continue;
      if (!active || cue.startMs > active.startMs) active = cue;
    }
    return active;
  };

  const selectProgressiveCue = (source: string): VideoSubtitleCue | null => {
    const matchedCue = findProgressiveCue(source);
    const activeCue = findActiveProgressiveCue();
    const currentMs = getCurrentVideoTimeMs();
    if (!activeCue) return matchedCue;
    // 没有任何文本匹配时不要凭时间轴猜测原生字幕内容；YouTube 可能刚切换
    // 字幕轨道，而 DOM 已经先显示了新文本，此时应回退到普通实时翻译。
    if (!matchedCue) return null;

    // 原生字幕 DOM 可能还停在上一条 cue，但播放器时间已经进入下一条。
    // 时间轴是此时唯一稳定的“当前字幕”信号，优先切换到 active cue，避免译文落后一整句。
    if (Number.isFinite(currentMs)
      && activeCue.startMs > matchedCue.startMs
      && !isCueActiveAtTime(matchedCue, currentMs)) {
      return activeCue;
    }
    if (activeCue.startMs > matchedCue.startMs && Number.isFinite(currentMs)) return activeCue;
    return matchedCue;
  };

  const renderProgressiveCaption = (source: string, overlay: HTMLElement, container: HTMLElement) => {
    if (!progressiveCue || !progressiveTranslation) return;

    const revealed = normalizedCaptionActive
      ? progressiveTranslation.trim()
      : revealVideoSubtitleTranslation(progressiveTranslation, source, progressiveCue.text);
    if (!revealed) return;
    overlay.textContent = revealed;
    syncTranslationOverlayPosition(container);
  };

  const updateProgressiveCaption = (source: string, overlay: HTMLElement, container: HTMLElement): boolean => {
    const cue = selectProgressiveCue(source);
    if (!cue) return false;

    cancelStableCaption();
    const cueKey = getProgressiveCueKey(cue);
    if (cueKey !== progressiveCueKey) {
      deactivateNormalizedCaption();
      progressiveCueKey = cueKey;
      progressiveCue = cue;
      progressiveTranslation = '';
      ++generation;
      lastTranslatedSource = '';
      lastTranslatedText = '';
      overlay.textContent = '';
    } else {
      progressiveCue = cue;
    }

    const syntheticCaptionActive = container.id === VIDEO_AI_CAPTION_CONTAINER_ID;
    const captionDiffersFromCue = normalizeVideoCaptionText(source) !== normalizeVideoCaptionText(cue.text);
    if (cueKey === normalizedCaptionCueKey || captionDiffersFromCue || syntheticCaptionActive) {
      normalizedCaptionActive = normalizedCaptionActive || captionDiffersFromCue;
      normalizedCaptionActive = normalizedCaptionActive || syntheticCaptionActive;
    }
    if (normalizedCaptionActive) {
      normalizedCaptionCueKey = cueKey;
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      const normalizedOverlay = player ? getOrCreateNormalizedCaptionOverlay(player) : null;
      const layer = player?.querySelector<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`);
      if (normalizedOverlay && layer) {
        normalizedOverlay.textContent = cue.text;
        layer.classList.add(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
        container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
      }
    }
    lastSource = source;

    if (progressiveTranslation) {
      renderProgressiveCaption(source, overlay, container);
    }

    const requestGeneration = generation;
    const requestCueKey = cueKey;
    const requestTrackVersion = pretranslationCacheVersion;
    void getCachedVideoTranslation(cue.text).then((translated) => {
      const result = typeof translated === 'string' ? translated.trim() : '';
      if (!result || normalizeVideoCaptionText(result) === normalizeVideoCaptionText(cue.text)) return;
      if (destroyed || requestTrackVersion !== pretranslationCacheVersion) return;

      if (requestGeneration !== generation || requestCueKey !== progressiveCueKey) return;
      progressiveTranslation = result;

      const currentContainer = findCaptionContainer();
      const currentSource = readVisibleCaptionText(currentContainer);
      const currentCue = currentSource ? selectProgressiveCue(currentSource) : findActiveProgressiveCue();
      const currentCueKey = currentCue ? getProgressiveCueKey(currentCue) : '';
      if (!currentContainer || !currentSource || currentCueKey !== requestCueKey) return;
      lastSource = currentSource;
      renderProgressiveCaption(currentSource, overlay, currentContainer);
    }).catch((error) => {
      if (!destroyed && requestGeneration === generation) {
        console.warn('[FluentRead] 视频字幕前置翻译失败', error);
      }
    });

    return true;
  };

  const primeUpcomingVideoCaptions = () => {
    if (destroyed || !canTranslateVideo() || !observedVideo || pretranslationCues.length === 0) return;
    const currentMs = observedVideo.currentTime * 1000;
    if (!Number.isFinite(currentMs)) return;

    const windowMs = getVideoPretranslationWindowMs(config.videoService);
    let queued = 0;
    for (const cue of pretranslationCues) {
      const endMs = cue.startMs + Math.max(cue.durationMs, 500);
      if (cue.startMs > currentMs + windowMs || endMs < currentMs - 500) continue;
      void getCachedVideoTranslation(cue.text, true).catch(() => undefined);
      queued += 1;
      if (queued >= 8) break;
    }
  };

  const schedulePretranslation = () => {
    if (pretranslationTimer || destroyed) return;
    pretranslationTimer = setTimeout(() => {
      pretranslationTimer = undefined;
      primeUpcomingVideoCaptions();
    }, 120);
  };

  const setPretranslationTrack = (key: string, entry: { url: string; cues: VideoSubtitleCue[] }) => {
    if (key === pretranslationTrackKey) {
      pretranslationCues = entry.cues;
      schedulePretranslation();
      return;
    }
    pretranslationTrackKey = key;
    pretranslationCues = entry.cues;
    pretranslationCacheVersion += 1;
    videoTranslator.clear();
    resetTranslationState();
    schedulePretranslation();
  };

  const getPreferredCapturedTrack = () => {
    const active = pretranslationTrackKey ? capturedSubtitleTracks.get(pretranslationTrackKey) : undefined;
    if (active) return [pretranslationTrackKey, active] as const;
    const captured = Array.from(capturedSubtitleTracks.entries());
    const original = captured.find(([, entry]) => isOriginalTimedTextUrl(entry.url));
    return original || captured[0] || null;
  };

  const appendXSubtitleCues = (url: string, cues: VideoSubtitleCue[]) => {
    if (cues.length === 0) return;
    xSubtitleCues = finalizeVideoSubtitleCues([...xSubtitleCues, ...cues]).slice(0, 4000);
    const entry = { url, cues: xSubtitleCues };
    capturedSubtitleTracks.set(xSubtitleTrackKey, entry);
    if (canTranslateVideo() && !isAiCaptureActive()) {
      setPretranslationTrack(xSubtitleTrackKey, entry);
      scheduleUpdate();
    }
  };

  const handleXSubtitleResourceMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin || !isXVideoPage()) return;
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      url?: unknown;
      responseText?: unknown;
      pageHref?: unknown;
    } | null;
    if (data?.source !== 'fluent-read' || data.type !== X_SUBTITLE_RESOURCE_MESSAGE) return;
    if (typeof data.url !== 'string' || typeof data.responseText !== 'string'
      || data.responseText.length > 1_000_000 || !isXSubtitleResourceUrl(data.url)) return;
    if (typeof data.pageHref === 'string' && getVideoPageKey(data.pageHref) !== videoPageKey) return;
    // 音轨读取器按媒体 ID 选择候选；MSE 使用海报的媒体 ID 关联，避免混入推荐视频。
    hlsAudio.remember(data.url, data.responseText);
    const source = `${observedMediaSource} ${observedVideo?.poster || ''}`;
    const mediaId = source.match(/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)/)?.[1];
    if (mediaId ? !data.url.includes(`/${mediaId}/`) : document.querySelectorAll('video').length > 1) return;
    if (/WEBVTT|TYPE=SUBTITLES/i.test(data.responseText)) {
      xSubtitleLoader.load({ url: data.url, offsetMs: 0 }, data.responseText);
    }
  };

  const ensurePretranslationTrack = () => {
    if (destroyed || !canTranslateVideo()) return;

    // AI 请求期间只允许 ai:capture 驱动翻译。X 的 sidecar 捕获会持续到达；
    // 若每秒把 track 切回 x:captions，就会反复清空 AI 翻译缓存，表现为
    // “识别有文字但译文不出现”或译文闪烁。
    if (isXVideoPage() && isAiCaptureActive()) {
      setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: aiCues });
      return;
    }

    const native = isXVideoPage() ? xCaptionSource.readNativeTrack() : null;
    if (native) {
      setPretranslationTrack(`x:native:${native.languageCode}`, {url: 'x:native', cues: native.cues});
      return;
    }
    const captured = getPreferredCapturedTrack();
    if (captured) {
      setPretranslationTrack(captured[0], captured[1]);
      return;
    }

    if (isXVideoPage()) return;
    const track = chooseYoutubeCaptionTrackForLocation(document, window.location, config.from);
    if (!track) return;
    const url = buildYoutubeTimedTextUrl(track);
    const key = getTimedTextCacheKey(url);
    if (key === pretranslationTrackKey && pretranslationCues.length > 0) return;
    if (pretranslationTrackRequest) return;
    if (pretranslationTrackRequestKey === key && Date.now() < pretranslationTrackRetryAt) return;

    pretranslationTrackRequestKey = key;
    const requestVersion = pretranslationCacheVersion;
    const request = (async () => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`字幕轨道请求失败（${response.status}）`);
        const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(await response.text()));
        if (cues.length === 0) {
          pretranslationTrackRetryAt = Date.now() + 5000;
          return;
        }
        if (destroyed || requestVersion !== pretranslationCacheVersion) return;
        const entry = { url, cues };
        capturedSubtitleTracks.set(key, entry);
        setPretranslationTrack(key, entry);
        pretranslationTrackRetryAt = 0;
        scheduleUpdate();
      } catch {
        // 页面尚未准备好字幕轨道时，保留 DOM 实时翻译回退，并降低重试频率。
        pretranslationTrackRetryAt = Date.now() + 5000;
      }
    })();
    pretranslationTrackRequest = request;
    void request.then(
      () => {
        if (pretranslationTrackRequest === request) pretranslationTrackRequest = undefined;
      },
      () => {
        if (pretranslationTrackRequest === request) pretranslationTrackRequest = undefined;
      },
    );
  };

  const syncVideoElement = (confirmMissing = false) => {
    const nextVideo = playerLocator.sync()?.video || null;
    // 展开播放器时 React 可能先卸载旧 video，再挂载同一媒体副本；短暂空窗保留识别会话。
    if (!nextVideo && observedVideo && isXVideoPage() && !confirmMissing) {
      mediaMissingTimer ??= setTimeout(() => { mediaMissingTimer = undefined; syncVideoElement(true); }, 1500);
      return;
    }
    if (mediaMissingTimer) clearTimeout(mediaMissingTimer);
    mediaMissingTimer = undefined;
    const nextSource = nextVideo?.currentSrc || nextVideo?.src || '';
    const nextStableMediaKey = stableMediaKey(nextVideo);
    if (nextVideo === observedVideo && nextSource === observedMediaSource && nextStableMediaKey === observedStableMediaKey) return;
    const previousVideo = observedVideo;
    const identityEnriched = previousVideo === nextVideo && nextSource === observedMediaSource
      && (!observedStableMediaKey || observedStableMediaKey.startsWith('blob:'));
    const sameMedia = previousVideo && nextVideo && (identityEnriched || observedStableMediaKey === nextStableMediaKey);
    xCaptionSource.restoreTracks();
    stopCaptionClock();
    observedVideo = nextVideo || null;
    observedMediaSource = nextSource;
    observedStableMediaKey = nextStableMediaKey;
    if (identityEnriched && activeAiCacheRequest) activeAiCacheRequest = currentCacheRequest();
    if (previousVideo && isXVideoPage() && !sameMedia) {
      stopFullAiSubtitleGeneration();
      stopAiSubtitleCapture(true);
      xSubtitleLoader.reset();
      hlsAudio.reset();
      xSubtitleCues = [];
      aiCues = [];
      capturedSubtitleTracks.clear();
      subtitleDownloadAbortController?.abort();
      clearPretranslationState(true);
    }
    if (!observedVideo) return;
    if (isXVideoPage()) document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
    startCaptionClock();
    schedulePretranslation();
    if (isXVideoPage() && !sameMedia) void restoreCachedAiSubtitles();
  };

  const appendAiSubtitleCue = (cue: VideoAiStabilizedCue) => {
    const cleaned = normalizeVideoCaptionText(cue.text);
    if (!cleaned) return;
    aiCues = upsertVideoAiSubtitleCue(aiCues, {
      ...cue,
      startMs: Math.max(0, cue.startMs),
      durationMs: Math.max(cue.durationMs, VIDEO_AI_CUE_MIN_DURATION_MS),
      text: cleaned,
    });
    setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: aiCues });
    aiCaptureError = '';
    syncXVideoCaptionSource();
    scheduleUpdate();
  };

  const transcribeAiAudioChunk = async (chunk: VideoAiAudioChunk): Promise<VideoAiTranscriptionResult> => {
    if (destroyed || chunk.pcm.length === 0) return { skipped: true };
    const response = await browser.runtime.sendMessage({
      type: 'fluentReadTranscribeLocalVideoAudio',
      streamId: aiStreamId,
      generation: chunk.sessionId,
      audioPcm16Base64: encodeVideoAiPcm16Base64(chunk.pcm),
      model: activeAiModel,
      sourceLanguage: activeVideoLanguage,
    }) as {
      success?: boolean;
      text?: string;
      segments?: Array<{ startMs?: number; endMs?: number; text?: string }>;
      skipped?: boolean;
      model?: string;
      backend?: 'webgpu' | 'wasm';
      gpuInfo?: string;
      decodeMs?: number;
      inferenceMs?: number;
      audioDurationMs?: number;
      threads?: number;
      dtype?: 'q4' | 'q8';
      error?: string;
    } | undefined;
    if (!response?.success) {
      throw new Error(response?.error || 'AI 字幕接口没有返回文字');
    }
    return {
      text: response.text,
      segments: response.segments,
      skipped: response.skipped,
      model: response.model,
      backend: response.backend,
      gpuInfo: response.gpuInfo,
      decodeMs: response.decodeMs,
      inferenceMs: response.inferenceMs,
      audioDurationMs: response.audioDurationMs,
      threads: response.threads,
      dtype: response.dtype,
    };
  };

  const setAiFullProgress = (progress: Partial<VideoAiFullCaptureProgress>) => {
    aiFullProgress = { ...aiFullProgress, ...progress };
    aiFullPhase = aiFullProgress.phase;
    updatePlayerUiState();
  };

  const resetAiSubtitleCues = () => {
    aiCues = [];
    // AI 完整生成是一轮新的字幕时间轴；旧一轮的翻译不能因为 cue 文本
    // 偶然相同而混入新视频/新模型。
    pretranslationCacheVersion += 1;
    videoTranslator.clear();
    resetTranslationState();
    setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: aiCues });
  };

  const shouldTranslateFullAiCues = () => config.on
    && config.videoSubtitleVisible !== false
    && normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) !== 'original-only';

  const translateFullAiCues = async (
    cues: VideoAiStabilizedCue[],
    sessionId: number,
  ): Promise<void> => {
    if (!shouldTranslateFullAiCues()) return;
    const uniqueSources = [...new Set(cues
      .map((cue) => normalizeVideoSourceKey(cue.text))
      .filter(Boolean))];
    if (uniqueSources.length === 0) return;

    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
      while (nextIndex < uniqueSources.length) {
        if (destroyed || !aiFullCapture?.isRequested() || aiFullCapture.getSessionId() !== sessionId) {
          throw new Error('本地视频完整 AI 字幕已取消');
        }
        const source = uniqueSources[nextIndex++];
        await getCachedVideoTranslation(source);
        completed += 1;
        setAiFullProgress({
          phase: 'translating',
          progress: 0.85 + completed / uniqueSources.length * 0.15,
          windowIndex: completed,
          windowCount: uniqueSources.length,
        });
      }
    };
    // 翻译请求限为 2 路，避免“完整生成”把翻译服务和浏览器请求队列打满。
    await Promise.all([worker(), worker()]);
  };

  const prepareFullAiCues = async (cues: VideoAiStabilizedCue[], sessionId: number): Promise<void> => {
    const normalizedCues = cues
      .map((cue) => ({
        ...cue,
        startMs: Math.max(0, cue.startMs),
        durationMs: Math.max(1, cue.spokenEndMs - cue.startMs),
        text: normalizeVideoCaptionText(cue.text),
        availableAtMs: 0,
        translationAvailableAtMs: 0,
      }))
      .filter((cue) => cue.text);
    if (activeAiCacheRequest) void transcriptCache.set(activeAiCacheRequest, normalizedCues);
    await translateFullAiCues(normalizedCues, sessionId);
    if (destroyed || !aiFullCapture?.isRequested() || aiFullCapture.getSessionId() !== sessionId) {
      throw new Error('本地视频完整 AI 字幕已取消');
    }
    aiCues = normalizedCues;
    setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: aiCues });
    aiCaptureError = '';
    syncXVideoCaptionSource();
    scheduleUpdate();
  };

  aiFullCapture = new VideoAiFullCaptureController({
    getAudio: (video, signal) => hlsAudio.read(video, signal),
    getVideo: () => observedVideo,
    getModel: () => activeAiModel,
    isSupported: () => !destroyed && isXVideoPage(),
    transcribe: transcribeAiAudioChunk,
    onTranscriptionComplete: prepareFullAiCues,
    onError: (error) => {
      aiFullPhase = 'error';
      aiFullProgress = { ...aiFullProgress, phase: 'error', progress: 0 };
      aiCaptureError = /decode|解码|audio data/i.test(error.message)
        ? '当前视频音频格式暂不支持，请重试或使用桌面版 Chrome/Edge'
        : error.message;
      console.warn('[FluentRead] X AI 完整字幕请求失败', error);
      syncXVideoCaptionSource();
      updatePlayerUiState();
    },
    onStateChange: () => {
      syncXVideoCaptionSource();
      scheduleUpdate();
      updatePlayerUiState();
    },
    onProgress: (progress) => {
      setAiFullProgress(progress);
      if (progress.phase === 'ready') void browser.runtime.sendMessage({
        type: 'fluentReadCancelLocalVideoTranscription', streamId: aiStreamId,
        generation: aiFullCapture!.getSessionId(), reason: 'complete',
      }).catch(() => undefined);
    },
    onSessionStart: (sessionId) => {
      void browser.runtime.sendMessage({
        type: 'fluentReadPrepareLocalVideoModel',
        model: activeAiModel,
        keepWarm: true,
        streamId: aiStreamId,
        generation: sessionId,
      }).catch(() => undefined);
    },
    onInvalidate: (reason, sessionId) => {
      void browser.runtime.sendMessage({
        type: 'fluentReadCancelLocalVideoTranscription',
        streamId: aiStreamId,
        generation: sessionId,
        reason,
      }).catch(() => undefined);
    },
  });

  aiCapture = new VideoAiCaptureController({
    getVideo: () => observedVideo,
    getModel: () => activeAiModel,
    isSupported: () => !destroyed && isXVideoPage(),
    transcribe: transcribeAiAudioChunk,
    onCue: appendAiSubtitleCue,
    onReset: () => {
      resetAiSubtitleCues();
    },
    onError: (error) => {
      const message = error.message;
      aiCaptureError = /decode|解码|audio data/i.test(message)
        ? '当前视频音频格式暂不支持，请重试或使用桌面版 Chrome/Edge'
        : message;
      console.warn('[FluentRead] X AI 字幕请求失败', error);
    },
    onStateChange: () => {
      syncXVideoCaptionSource();
      scheduleUpdate();
      updatePlayerUiState();
    },
    onSessionStart: (generation) => {
      // 模型初始化与首个 2.4 秒音频窗口并行；不等待预热结果，首个真实
      // 转写请求仍是最终兜底。stream + generation 让暂停/停止可精确终止
      // 尚未完成的冷启动，避免后台 Worker 在用户停止后继续吃满 CPU。
      void browser.runtime.sendMessage({
        type: 'fluentReadPrepareLocalVideoModel',
        model: activeAiModel,
        keepWarm: true,
        streamId: aiStreamId,
        generation,
      }).catch(() => undefined);
    },
    onDiagnostic: (diagnostic) => {
      const container = syncXVideoCaptionSource();
      if (container) {
        container.dataset.fluentReadVideoAiDiagnostic = JSON.stringify({
          sessionId: diagnostic.sessionId,
          sequence: diagnostic.sequence,
          model: diagnostic.model,
          backend: diagnostic.backend,
          threads: diagnostic.threads,
          dtype: diagnostic.dtype,
          skipped: diagnostic.skipped === true,
          decodeMs: Math.round(diagnostic.decodeMs || 0),
          inferenceMs: Math.round(diagnostic.inferenceMs || 0),
          audioDurationMs: Math.round(diagnostic.audioDurationMs || diagnostic.capturedAudioMs),
          realtimeFactor: typeof diagnostic.realtimeFactor === 'number'
            ? Number(diagnostic.realtimeFactor.toFixed(3))
            : undefined,
          effectiveSubmitStepMs: Math.round(diagnostic.effectiveSubmitStepMs),
          windowStartMs: Math.round(diagnostic.windowStartMs),
          windowEndMs: Math.round(diagnostic.windowEndMs),
          submittedAtWallMs: Math.round(diagnostic.submittedAtWallMs),
          completedAtWallMs: Math.round(diagnostic.completedAtWallMs),
          resultAvailableAtMs: Math.round(diagnostic.resultAvailableAtMs),
          emittedCueCount: diagnostic.emittedCueCount,
          droppedAudioMs: Math.round(diagnostic.droppedAudioMs),
        });
      }
      if (import.meta.env.DEV) console.debug('[FluentRead] X AI 字幕窗口完成', diagnostic);
    },
    onInvalidate: (reason, generation) => {
      void browser.runtime.sendMessage({
        type: 'fluentReadCancelLocalVideoTranscription',
        streamId: aiStreamId,
        generation,
        reason,
      }).catch(() => undefined);
    },
  });

  const startAiSubtitleCapture = (clearExistingCues = true): boolean => {
    if (!aiCapture) return false;
    activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
    const started = aiCapture.start(clearExistingCues);
    if (started) persistVideoConfig({ videoTranslationEnabled: true, videoSubtitleVisible: true });
    return started;
  };

  const startFullAiSubtitleGeneration = (): boolean => {
    if (!aiFullCapture) return false;
    activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
    cacheEpoch += 1;
    activeAiCacheRequest = currentCacheRequest();
    resetAiSubtitleCues();
    aiFullPhase = 'capturing';
    aiFullProgress = {
      phase: 'capturing',
      captureMode: 'realtime-scan',
      progress: 0,
      capturedMs: 0,
      durationMs: 0,
      transcribedMs: 0,
      windowIndex: 0,
      windowCount: 0,
    };
    aiCaptureError = '';
    persistVideoConfig({ videoTranslationEnabled: true, videoSubtitleVisible: true });
    const started = aiFullCapture.start();
    if (!started) {
      syncXVideoCaptionSource();
      updatePlayerUiState();
    }
    return started;
  };

  const stopAiSubtitleCapture = (invalidatePending = false) => {
    if (!aiCapture) return;
    if (invalidatePending) aiCapture.cancel();
    else aiCapture.pause();
  };

  const stopFullAiSubtitleGeneration = () => {
    cacheEpoch += 1;
    cacheLookup = undefined;
    activeAiCacheRequest = null;
    aiFullCapture?.cancel();
    resetAiSubtitleCues();
    aiFullPhase = 'idle';
    aiFullProgress = {
      phase: 'idle',
      captureMode: undefined,
      progress: 0,
      capturedMs: 0,
      durationMs: 0,
      transcribedMs: 0,
      windowIndex: 0,
      windowCount: 0,
    };
    syncXVideoCaptionSource();
    scheduleUpdate();
    updatePlayerUiState();
  };

  const restoreCachedAiSubtitles = (): Promise<boolean> => {
    if (cacheLookup) return cacheLookup;
    if (destroyed || !config.on || !config.videoTranslationEnabled || isAiCaptureActive()) return Promise.resolve(false);
    const request = currentCacheRequest();
    if (!request) return Promise.resolve(false);
    const epoch = ++cacheEpoch;
    const source = stableMediaKey(observedVideo);
    const pending = transcriptCache.get(request).then(cues => {
      if (!cues || destroyed || epoch !== cacheEpoch || source !== stableMediaKey(observedVideo)
        || !config.on || !config.videoTranslationEnabled || isAiCaptureActive()) return false;
      activeAiCacheRequest = request;
      resetAiSubtitleCues();
      aiCaptureError = '';
      return aiFullCapture!.restore(cues);
    }).finally(() => { if (cacheLookup === pending) cacheLookup = undefined; });
    cacheLookup = pending;
    return pending;
  };

  const resetAiSubtitleAfterSeek = () => {
    aiCapture?.resetAfterSeek();
  };

  const scheduleCaptionEmptyClear = () => {
    if (isXVideoPage()) { resetTranslationState(); return; }
    if (emptyCaptionTimer) return;
    emptyCaptionTimer = setTimeout(() => {
      emptyCaptionTimer = undefined;
      if (destroyed || readVisibleCaptionText(findCaptionContainer())) return;
      resetTranslationState();
    }, VIDEO_CAPTION_EMPTY_GRACE_MS);
  };

  const closeMenu = () => {
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
    if (menu) menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
    syncTranslationOverlayPosition(findCaptionContainer());
  };

  const updatePlayerUiState = () => {
    playerBinding?.sync();
    const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    if (!button || !menu) return;
    if (button instanceof HTMLButtonElement) buttonElement = button;
    if (menu instanceof HTMLElement) menuElement = menu;

    const enabled = config.on && config.videoTranslationEnabled;
    const mode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
    const visible = config.videoSubtitleVisible !== false;
    const status = config.on
      ? (config.videoTranslationEnabled ? videoUi('video.enabled') : videoUi('video.disabled'))
      : videoUi('video.globalDisabled');
    button.classList.toggle(VIDEO_TRANSLATION_ACTIVE_CLASS, enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-expanded', String(!menu.hidden));

    const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-translation"]');
    if (toggle) {
      toggle.disabled = !config.on;
      toggle.setAttribute('aria-checked', String(enabled));
      toggle.querySelector<HTMLElement>('[data-check]')!.textContent = enabled ? '✓' : '';
      toggle.querySelector<HTMLElement>('[data-state]')!.textContent = config.on
        ? (enabled ? videoUi('video.enabled') : videoUi('video.turnOnNow'))
        : status;
    }
    const service = menu.querySelector<HTMLElement>('[data-service-label]');
    if (service) service.textContent = localizeVideoUiText(getVideoServiceLabel(config.videoService), getVideoUiLanguage(config.uiLanguage));
    const visibility = menu.querySelector<HTMLButtonElement>('[data-action="toggle-visible"]');
    if (visibility) {
      visibility.setAttribute('aria-checked', String(visible));
      visibility.querySelector<HTMLElement>('[data-check]')!.textContent = visible ? '✓' : '';
      visibility.querySelector<HTMLElement>('[data-state]')!.textContent = visible
        ? videoUi('video.showing')
        : videoUi('video.hidden');
    }
    const language = getVideoUiLanguage(config.uiLanguage);
    refreshVideoUiText(menu, language);
    refreshVideoUiAccessibility(menu, button, document, language, status);
    renderVideoAiMenu(menu, {
      available: isXVideoPage() && browserCapabilities.extensionDom,
      checking: aiModelChecking,
      active: isAiCaptureActive(), running: isAiCaptureRunning(), requested: isAiCaptureRequested(),
      fullActive: isAiFullActive(), phase: aiFullPhase, progress: aiFullProgress, error: aiCaptureError,
    }, language);
    menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((item) => {
      const selected = item.dataset.mode === mode;
      item.setAttribute('aria-checked', String(selected));
    });
  };

  const persistVideoConfig = (patch: VideoConfigPatch) => {
    // requestConfigPatch 会在返回 Promise 前乐观更新共享 config；连续点击会读取
    // 用户刚看到的状态，同时后台只在最新权威配置上合并这几个视频字段。
    void requestConfigPatch(
      patch,
      browser.runtime.sendMessage.bind(browser.runtime),
    ).catch((error) => {
      console.warn('[FluentRead] 视频字幕设置保存失败', error);
    });
  };

  const ensureNativeCaptions = () => {
    if (!isYouTubeVideoPage()) return;
    const nativeButton = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
    if (nativeButton && nativeButton.getAttribute('aria-pressed') !== 'true') {
      nativeButton.click();
    }
  };

  const handleTimedTextMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const validated = validateYoutubeTimedTextMessage(event.data, window.location.href);
    if (!validated) return;
    const key = getTimedTextCacheKey(validated.url);
    const entry = validated;
    capturedSubtitleTracks.delete(key);
    capturedSubtitleTracks.set(key, entry);
    if (canTranslateVideo()) {
      setPretranslationTrack(key, entry);
      scheduleUpdate();
    }
  };

  const resolveDownloadTrack = async (): Promise<{ languageCode: string; cues: VideoSubtitleCue[] }> => {
    // YouTube 切换视频或字幕语言时可能连续请求多个轨道；优先使用最近捕获的
    // 原始轨道，避免下载到进入页面时已经失效的旧字幕。
    const captured = Array.from(capturedSubtitleTracks.values()).reverse();
    if (isXVideoPage()) {
      if (isAiCaptureActive() && aiCues.length > 0) return { languageCode: 'ai', cues: aiCues };
      const nativeTrack = xCaptionSource.readNativeTrack();
      if (nativeTrack?.cues.length) return nativeTrack;
      const xTrack = captured.find((entry) => entry.cues.length > 0);
      if (xTrack) return { languageCode: 'original', cues: xTrack.cues };
      if (aiCues.length > 0) return { languageCode: 'ai', cues: aiCues };
      throw new Error('当前 X 视频还没有可下载的字幕，请先打开原生字幕或请求 AI 字幕');
    }
    const originalCaptured = captured.find((entry) => isOriginalTimedTextUrl(entry.url));
    if (originalCaptured) {
      const url = new URL(originalCaptured.url, window.location.href);
      return { languageCode: url.searchParams.get('lang') || 'original', cues: originalCaptured.cues };
    }
    if (captured[0]) {
      const url = new URL(captured[0].url, window.location.href);
      return { languageCode: url.searchParams.get('lang') || 'original', cues: captured[0].cues };
    }

    const track = chooseYoutubeCaptionTrackForLocation(document, window.location, config.from);
    if (!track) throw new Error('当前视频没有可用的 YouTube 字幕轨道');
    const url = buildYoutubeTimedTextUrl(track);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`字幕轨道请求失败（${response.status}）`);
    const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(await response.text()));
    if (cues.length === 0) {
      throw new Error('YouTube 未返回完整字幕数据，请先打开原生字幕后重试');
    }
    const key = getTimedTextCacheKey(url);
    const entry = { url, cues };
    capturedSubtitleTracks.delete(key);
    capturedSubtitleTracks.set(key, entry);
    if (canTranslateVideo()) setPretranslationTrack(key, entry);
    return { languageCode: track.languageCode, cues };
  };

  const ensureLocalVideoModelReady = async (): Promise<boolean> => {
    if (aiModelChecking) return false;
    if (!browserCapabilities.extensionDom) {
      aiCaptureError = '当前浏览器不支持本地 AI 字幕'; updatePlayerUiState(); return false;
    }
    const model = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
    const pageKey = getVideoPageKey();
    const translationEnabled = config.videoTranslationEnabled;
    const video = observedVideo;
    const source = video?.currentSrc;
    const stillCurrent = () => !destroyed && pageKey === getVideoPageKey()
      && model === normalizeVideoLocalTranscriptionModel(config.videoLocalModel)
      && video === observedVideo && source === video?.currentSrc
      && config.on && translationEnabled === config.videoTranslationEnabled;
    aiModelChecking = true;
    aiCaptureError = '';
    updatePlayerUiState();
    try {
      const state = await requestLocalVideoModelReadiness(model, browser.runtime.sendMessage.bind(browser.runtime));
      // 查询期间可能换视频、切换模型或关闭翻译，旧结果不能启动新一轮识别。
      if (!stillCurrent()) return false;
      if (state === 'ready') return true;
      aiCaptureError = `Whisper ${model === 'base' ? 'Base' : 'Tiny'} 尚未下载，请在设置中下载`;
      void browser.runtime.sendMessage({ type: 'openOptionsPage', section: 'settings-video' }).catch(() => undefined);
      return false;
    } catch {
      if (stillCurrent()) aiCaptureError = '无法读取模型状态，请重试';
      return false;
    } finally {
      aiModelChecking = false;
      if (!destroyed) updatePlayerUiState();
    }
  };

  const handleMenuClick = async (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const menu = menuElement;
    if (!menu || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>('[data-action], [data-mode]');
    if (!target || !menu.contains(target) || (target instanceof HTMLButtonElement && target.disabled)) return;

    event.preventDefault();
    event.stopPropagation();

    if (target.dataset.action === 'toggle-translation') {
      const nextEnabled = !config.videoTranslationEnabled;
      persistVideoConfig({ videoTranslationEnabled: nextEnabled });
      if (!nextEnabled && isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
      }
      if (nextEnabled) { ensureNativeCaptions(); void restoreCachedAiSubtitles(); }
      return;
    }
    if (target.dataset.action === 'toggle-ai-subtitle') {
      if (isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
      } else {
        const requestedMedia = stableMediaKey(observedVideo);
        const requestedModel = activeAiModel;
        const requestedLanguage = activeVideoLanguage;
        persistVideoConfig({videoTranslationEnabled: true, videoSubtitleVisible: true});
        if (!(await restoreCachedAiSubtitles()) && await ensureLocalVideoModelReady()
          && !destroyed && config.on && config.videoTranslationEnabled && !isAiCaptureActive()
          && requestedMedia === stableMediaKey(observedVideo)
          && requestedModel === activeAiModel && requestedLanguage === activeVideoLanguage) {
          // 在独立音轨上识别并预翻译；就绪后依当前播放头展示，保留用户播放状态。
          startFullAiSubtitleGeneration();
        }
      }
      updatePlayerUiState();
      return;
    }
    if (target.dataset.action === 'regenerate-ai-subtitle') {
      const requestedMedia = stableMediaKey(observedVideo);
      const requestedModel = activeAiModel;
      const requestedLanguage = activeVideoLanguage;
      if (await ensureLocalVideoModelReady() && !destroyed && config.on && config.videoTranslationEnabled
        && requestedMedia === stableMediaKey(observedVideo)
        && requestedModel === activeAiModel && requestedLanguage === activeVideoLanguage) {
        stopFullAiSubtitleGeneration();
        startFullAiSubtitleGeneration();
      }
      return;
    }
    if (target.dataset.action === 'toggle-visible') {
      persistVideoConfig({ videoSubtitleVisible: config.videoSubtitleVisible === false });
      return;
    }
    if (target.dataset.action === 'download-subtitles') {
      const downloadButton = target as HTMLButtonElement;
      const state = downloadButton.querySelector<HTMLElement>('[data-state]');
      downloadButton.disabled = true;
      downloadButton.setAttribute('aria-busy', 'true');
      if (state) state.textContent = videoUi('video.fetching');
      const slowFeedbackTimer = window.setTimeout(() => {
        if (downloadButton.getAttribute('aria-busy') === 'true' && state) {
          state.textContent = videoUi('video.reading');
        }
      }, 2000);
      let feedbackDelay = 2400;
      try {
        const result = await resolveDownloadTrack();
        downloadSubtitleSrt(result.cues, result.languageCode);
        if (state) state.textContent = videoUi('video.downloaded', {count: result.cues.length});
      } catch (error) {
        const message = getVideoSubtitleDownloadErrorMessage(error, getVideoUiLanguage(config.uiLanguage));
        if (state) state.textContent = message;
        downloadButton.title = message;
        feedbackDelay = 3200;
        console.warn('[FluentRead] 字幕下载失败', error);
      } finally {
        window.clearTimeout(slowFeedbackTimer);
        downloadButton.removeAttribute('aria-busy');
        window.setTimeout(() => {
          downloadButton.disabled = false;
          downloadButton.removeAttribute('title');
          if (state) state.textContent = '';
        }, feedbackDelay);
      }
      return;
    }
    if (target.dataset.action === 'download-translated-subtitles') {
      const downloadButton = target as HTMLButtonElement;
      const state = downloadButton.querySelector<HTMLElement>('[data-state]');
      downloadButton.disabled = true;
      if (!config.on || !config.videoTranslationEnabled) {
        if (state) state.textContent = videoUi('video.enableFirst');
        window.setTimeout(() => {
          downloadButton.disabled = false;
          if (state) state.textContent = '';
        }, 2200);
        return;
      }

      const controller = new AbortController();
      subtitleDownloadAbortController?.abort();
      subtitleDownloadAbortController = controller;
      const targetLanguage = config.to || 'translated';
      downloadButton.setAttribute('aria-busy', 'true');
      if (state) state.textContent = videoUi('video.fetching');
      try {
        const result = await resolveDownloadTrack();
        const translatedCues = await translateVideoSubtitleCues(result.cues, getCachedVideoTranslation, {
          concurrency: VIDEO_SUBTITLE_DOWNLOAD_CONCURRENCY,
          signal: controller.signal,
          onProgress: (completed, total) => {
            if (state) state.textContent = videoUi('video.translating', {completed, total});
          },
        });
        if (destroyed || controller.signal.aborted) throw createVideoSubtitleAbortError();
        downloadSubtitleSrt(translatedCues, `${targetLanguage}-translated`);
        if (state) state.textContent = videoUi('video.downloaded', {count: translatedCues.length});
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (state) state.textContent = aborted
          ? videoUi('video.cancelled')
          : videoUi('video.downloadFailed');
        if (!aborted) console.warn('[FluentRead] 译文字幕下载失败', error);
      } finally {
        if (subtitleDownloadAbortController === controller) subtitleDownloadAbortController = undefined;
        downloadButton.removeAttribute('aria-busy');
        window.setTimeout(() => {
          downloadButton.disabled = false;
          if (state) state.textContent = '';
        }, 2200);
      }
      return;
    }
    if (target.dataset.action === 'open-settings') {
      closeMenu();
      void browser.runtime.sendMessage({ type: 'openOptionsPage', section: 'settings-video' }).catch(() => undefined);
      return;
    }
    if (target.dataset.mode) {
      persistVideoConfig({ videoSubtitleDisplayMode: normalizeVideoSubtitleDisplayMode(target.dataset.mode) });
    }
  };

  const createPlayerMenu = (player: HTMLElement): HTMLElement => {
    const menu = createVideoPlayerMenu(getVideoUiLanguage(config.uiLanguage), isXVideoPage());
    player.appendChild(menu);
    bindMenuClick(menu);
    menuElement = menu;
    return menu;
  };

  const handleButtonClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    if (!(menu instanceof HTMLElement)) return;
    menuElement = menu;
    menu.hidden = !menu.hidden;
    updatePlayerUiState();
    syncTranslationOverlayPosition(findCaptionContainer());
    if (!menu.hidden) {
      menu.querySelector<HTMLButtonElement>('[data-action="toggle-translation"]')?.focus();
    }
  };

  const bindButtonClick = (button: HTMLButtonElement) => {
    if (button.dataset.fluentReadClickBound === 'true') return;
    button.dataset.fluentReadClickBound = 'true';
    button.addEventListener('click', handleButtonClick);
  };

  const bindMenuClick = (menu: HTMLElement) => {
    if (menu.dataset.fluentReadClickBound === 'true') return;
    menu.dataset.fluentReadClickBound = 'true';
    menu.addEventListener('click', handleMenuClick);
  };

  const createPlayerButton = (): HTMLButtonElement => {
    const button = document.createElement('button');
    button.id = VIDEO_TRANSLATION_BUTTON_ID;
    button.className = 'ytp-button fluent-read-video-subtitle-button fluent-read-video-ui notranslate';
    button.type = 'button';
    button.setAttribute('role', 'button');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-expanded', 'false');
    const initialLabel = videoUi('video.buttonAriaLabel', {status: videoUi('video.disabled')});
    button.setAttribute('aria-label', initialLabel);
    button.title = initialLabel;
    const icon = document.createElement('img');
    icon.className = 'fluent-read-video-subtitle-button-icon';
    icon.src = browser.runtime.getURL('icon/128.png');
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    markVideoUi(button);
    bindButtonClick(button);
    button.classList.toggle('fluent-read-video-subtitle-x-button', isXVideoPage());
    buttonElement = button;
    return button;
  };

  const ensurePlayerUi = () => {
    playerBinding?.sync();
    updatePlayerUiState();
  };


  const handleDocumentClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (buttonElement?.contains(target) || menuElement?.contains(target)) return;
    closeMenu();
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') closeMenu();
  };

  const startTranslationLoop = () => {
    if (translationLoopRunning) return;

    translationLoopRunning = true;
    void (async () => {
      try {
        while (!destroyed && pendingTranslationSource) {
          const nextSource = pendingTranslationSource;
          const nextOverlay = pendingTranslationOverlay;
          pendingTranslationSource = '';
          pendingTranslationOverlay = null;
          const requestGeneration = generation;
          try {
            const translated = await getCachedVideoTranslation(nextSource);
            if (!nextOverlay || destroyed || requestGeneration !== generation || nextSource !== lastSource) continue;
            const result = typeof translated === 'string' ? translated.trim() : '';
            lastTranslatedSource = nextSource;
            lastTranslatedText = result && result !== nextSource ? result : '';
            const currentContainer = findCaptionContainer();
            if (!lastTranslatedText || !currentContainer || readVisibleCaptionText(currentContainer) !== nextSource) continue;
            nextOverlay.textContent = lastTranslatedText;
            syncTranslationOverlayPosition(currentContainer);
          } catch (error) {
            if (!destroyed && requestGeneration === generation) {
              console.warn('[FluentRead] 视频字幕翻译失败', error);
            }
          }
        }
      } finally {
        translationLoopRunning = false;
      }
    })();
  };

  const commitStableCaption = (source: string, overlay: HTMLElement, container: HTMLElement) => {
    if (destroyed || readVisibleCaptionText(container) !== source || source === lastSource) return;

    lastSource = source;
    ++generation;
    lastTranslatedSource = '';
    lastTranslatedText = '';
    overlay.textContent = '';
    if (container.id === VIDEO_AI_CAPTION_CONTAINER_ID) {
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      const normalizedOverlay = player ? getOrCreateNormalizedCaptionOverlay(player) : null;
      const layer = player?.querySelector<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`);
      if (normalizedOverlay && layer) {
        normalizedOverlay.textContent = source;
        layer.classList.add(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
        container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
        normalizedCaptionActive = true;
        normalizedCaptionCueKey = `synthetic:${source}`;
      }
    }
    syncTranslationOverlayPosition(container);

    pendingTranslationSource = source;
    pendingTranslationOverlay = overlay;
    startTranslationLoop();
  };

  const scheduleStableCaption = (source: string, overlay: HTMLElement) => {
    if (stableCaptionTimer && stableCaptionSource === source) return;

    cancelStableCaption();
    stableCaptionSource = source;
    stableCaptionOverlay = overlay;
    stableCaptionTimer = setTimeout(() => {
      stableCaptionTimer = undefined;
      const nextSource = stableCaptionSource;
      const nextOverlay = stableCaptionOverlay;
      stableCaptionSource = '';
      stableCaptionOverlay = null;
      if (destroyed || !nextSource) return;

      const container = findCaptionContainer();
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (!container || !player || readVisibleCaptionText(container) !== nextSource) return;
      const currentOverlay = nextOverlay?.isConnected ? nextOverlay : getOrCreateTranslationOverlay(player);
      commitStableCaption(nextSource, currentOverlay, container);
    }, VIDEO_CAPTION_STABILITY_MS);
  };

  const updateCaption = () => {
    if (destroyed) return;

    if (isXVideoPage()) syncXVideoCaptionSource();
    const container = findCaptionContainer();
    if (!container) {
      captionObserver?.disconnect();
      captionObserver = undefined;
      observedContainer = null;
      scheduleCaptionEmptyClear();
      return;
    }

    container.classList.add('notranslate');
    applyVideoDisplayState(container);
    const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
    const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
    if (!player) return;
    const source = readVisibleCaptionText(container);
    const canTranslate = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false && displayMode !== 'original-only';
    if (!canTranslate) {
      if (config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
        && displayMode === 'original-only' && container.id === VIDEO_AI_CAPTION_CONTAINER_ID) {
        if (!source) {
          scheduleCaptionEmptyClear();
          return;
        }
        cancelCaptionEmptyClear();
        cancelStableCaption();
        if (source !== lastSource) {
          generation += 1;
          lastSource = source;
          lastTranslatedSource = '';
          lastTranslatedText = '';
          pendingTranslationSource = '';
          pendingTranslationOverlay = null;
          progressiveCueKey = '';
          progressiveCue = null;
          progressiveTranslation = '';
        }
        const normalizedOverlay = getOrCreateNormalizedCaptionOverlay(player);
        const layer = player.querySelector<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`);
        normalizedOverlay.textContent = source;
        layer?.classList.add(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
        container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
        normalizedCaptionActive = true;
        normalizedCaptionCueKey = `original-only:${source}`;
        getOrCreateTranslationOverlay(player).textContent = '';
        syncTranslationOverlayPosition(container);
        return;
      }
      resetTranslationState();
      return;
    }

    const overlay = getOrCreateTranslationOverlay(player);

    if (!source) {
      scheduleCaptionEmptyClear();
      return;
    }

    cancelCaptionEmptyClear();
    if (updateProgressiveCaption(source, overlay, container)) return;

    if (progressiveCueKey) {
      clearProgressiveCaption();
      lastSource = '';
      lastTranslatedSource = '';
      lastTranslatedText = '';
      overlay.textContent = '';
    }

    if (source === lastSource) {
      syncTranslationOverlayPosition(container);
      if (lastTranslatedSource === source && lastTranslatedText && overlay.textContent !== lastTranslatedText) {
        overlay.textContent = lastTranslatedText;
        syncTranslationOverlayPosition(container);
      }
      return;
    }

    // 自动字幕会先逐词写入 DOM；只有连续稳定一小段时间后才提交翻译请求。
    // 在等待期间保留原生字幕，避免每个半句都触发译文闪烁。
    if (isXVideoPage()) commitStableCaption(source, overlay, container);
    else scheduleStableCaption(source, overlay);
  };

  const scheduleUpdate = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    if (isXVideoPage()) updateCaption();
    else debounceTimer = setTimeout(updateCaption, 120);
  };

  let captionFrame: number | undefined;
  let captionFrameVideo: HTMLVideoElement | null = null;
  const stopCaptionClock = () => {
    if (captionFrame !== undefined) captionFrameVideo?.cancelVideoFrameCallback(captionFrame);
    captionFrame = undefined;
    captionFrameVideo = null;
  };
  const startCaptionClock = () => {
    const video = observedVideo;
    if (!config.on || !config.videoTranslationEnabled || config.videoSubtitleVisible === false
      || !isXVideoPage() || !video || video.paused || video.ended || captionFrame !== undefined
      || typeof video.requestVideoFrameCallback !== 'function') return;
    captionFrameVideo = video;
    captionFrame = video.requestVideoFrameCallback(() => {
      captionFrame = undefined;
      if (destroyed || observedVideo !== video || !video.isConnected) return;
      const previous = readVisibleCaptionText(findCaptionContainer());
      const container = syncXVideoCaptionSource();
      if (readVisibleCaptionText(container) !== previous) updateCaption();
      startCaptionClock();
    });
  };

  const videoTimelineEventNames = ['timeupdate', 'seeking', 'seeked', 'emptied', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'ratechange'];
  const handleVideoTimelineEvent = (event: Event) => {
    const target = event.target as HTMLVideoElement | null;
    if (!target || target.tagName !== 'VIDEO') return;
    if (target !== observedVideo || event.type === 'loadedmetadata' || event.type === 'emptied') syncVideoElement();
    if (target !== observedVideo) return;
    if (isXVideoPage()) {
      if (event.type === 'seeking' && aiCapture?.isRequested()) {
        // seek 会让当前 PCM 窗口跨越两个位置；彻底重建采集图，避免旧
        // 时间轴在新位置闪回或字幕停止更新。
        resetAiSubtitleAfterSeek();
      }
      if (event.type === 'seeked') aiCapture?.resumeAfterSeek();
      if (event.type === 'ratechange' && isAiCaptureRunning()) {
        aiCapture?.resetAfterPlaybackRateChange();
      }
      if (event.type === 'pause' && !target.ended && isAiCaptureRunning()) {
        // 暂停期间不能把墙钟 PCM 写进播放器时间轴。保留 requested 状态，
        // play 时从新的 currentTime 建立独立滚动窗口。
        stopAiSubtitleCapture(false);
      }
      if (event.type === 'ended' && isAiCaptureRunning()) {
        // 已提交到 Worker 的最后一个窗口最多再等待几秒，避免 30 秒视频
        // 总是丢掉最后一句；时间轴保留，重播/下载字幕仍可使用。
        aiCapture?.end(false);
      }
      if (event.type === 'play' && isAiCaptureRequested() && !isAiCaptureRunning() && !isAiFullActive()) {
        startAiSubtitleCapture(false);
      }
      syncXVideoCaptionSource();
      if (target.paused || target.ended) stopCaptionClock();
      else startCaptionClock();
    }
    schedulePretranslation();
    scheduleUpdate();
  };

  const handleVideoVisibilityChange = () => {
    if (!isXVideoPage()) return;
    if (document.visibilityState === 'hidden') {
      if (isAiCaptureRunning()) stopAiSubtitleCapture(false);
      return;
    }
    const video = observedVideo;
    if (isAiCaptureRequested() && !isAiCaptureRunning() && !isAiFullActive() && video && !video.paused && !video.ended) {
      startAiSubtitleCapture(false);
    }
  };

  const observeCaptionContainer = () => {
    const container = findCaptionContainer();
    if (!container) {
      captionObserver?.disconnect();
      captionObserver = undefined;
      observedContainer = null;
      scheduleCaptionEmptyClear();
      return;
    }
    if (container === observedContainer && container.isConnected) {
      applyVideoDisplayState(container);
      return;
    }

    captionObserver?.disconnect();
    observedContainer = container;
    container.classList.add('notranslate');
    applyVideoDisplayState(container);
    // 合成 AI 容器由 cue 和播放器时间事件直接驱动；观察并改写自己的
    // textContent 会形成约 120ms 一次的自触发循环。
    if (container.id !== VIDEO_AI_CAPTION_CONTAINER_ID) {
      captionObserver = new MutationObserver(scheduleUpdate);
      captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
    }
    scheduleUpdate();
  };

  const syncPretranslationConfig = () => {
    const nextPretranslationConfigKey = getVideoTranslationConfigFingerprint(config);
    if (nextPretranslationConfigKey === pretranslationConfigKey) return;
    pretranslationConfigKey = nextPretranslationConfigKey;
    subtitleDownloadAbortController?.abort();
    clearPretranslationState(false);
  };

  const syncPlayerUi = () => {
    if (destroyed) return;
    const nextVideoPageKey = getVideoPageKey();
    if (nextVideoPageKey !== videoPageKey && !isXVideoPage()) {
      videoPageKey = nextVideoPageKey;
      subtitleDownloadAbortController?.abort();
      captionObserver?.disconnect();
      captionObserver = undefined;
      observedContainer = null;
      capturedSubtitleTracks.clear();
      xSubtitleLoader.reset();
      hlsAudio.reset();
      xSubtitleCues = [];
      aiCues = [];
      if (isAiFullActive()) stopFullAiSubtitleGeneration();
      else stopAiSubtitleCapture(true);
      clearPretranslationState(true);
      resetTranslationState();
    }
    videoPageKey = nextVideoPageKey;
    if (!isSupportedVideoPage() || !config.on) {
      playerBinding?.sync();
      stopCaptionClock();
      xCaptionSource.restoreTracks();
      closeMenu();
      buttonElement = null;
      menuElement = null;
      removeTranslationOverlay();
      return;
    }
    syncPretranslationConfig();
    syncVideoElement();
    ensurePlayerUi();
    syncXVideoCaptionSource();
    observeCaptionContainer();
    ensurePretranslationTrack();
    // 某些播放器实现不会稳定派发 timeupdate；复用已有的播放器同步
    // 周期校正当前 cue，避免原生字幕 DOM 落后一整句时译文一直停留在旧句。
    scheduleUpdate();
    schedulePretranslation();
    syncTranslationOverlayPosition(observedContainer);
  };

  playerBinding = createVideoPlayerBinding({
    locator: playerLocator,
    getState: () => ({enabled: !destroyed && config.on && isSupportedVideoPage(),
      progress: isAiFullActive() && aiFullPhase !== 'ready' ? aiFullProgress.progress : null}),
    createButton: createPlayerButton,
    createMenu: target => createPlayerMenu(target.player),
  });
  const unsubscribePlayer = playerLocator.subscribe(() => syncPlayerUi());
  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('keydown', handleDocumentKeydown, true);
  document.addEventListener('visibilitychange', handleVideoVisibilityChange);
  videoTimelineEventNames.forEach((eventName) => document.addEventListener(eventName, handleVideoTimelineEvent, true));
  window.addEventListener('message', handleTimedTextMessage);
  window.addEventListener('message', handleXSubtitleResourceMessage);
  syncPlayerUi();
  uiSyncTimer = window.setInterval(syncPlayerUi, 1000);

  const unsubscribeConfig = subscribeConfig((nextConfig) => {
    const subtitlesEnabled = nextConfig.on && nextConfig.videoTranslationEnabled;
    const newlyEnabled = subtitlesEnabled && !subtitlesPreviouslyEnabled;
    subtitlesPreviouslyEnabled = subtitlesEnabled;
    if (!subtitlesEnabled) { cacheEpoch += 1; cacheLookup = undefined; }
    const nextAiModel = normalizeVideoLocalTranscriptionModel(nextConfig.videoLocalModel);
    if (nextAiModel !== activeAiModel || nextConfig.videoSourceLanguage !== activeVideoLanguage) {
      cacheEpoch += 1;
      cacheLookup = undefined;
      activeVideoLanguage = nextConfig.videoSourceLanguage;
      const captureWasActive = isAiCaptureActive();
      activeAiModel = nextAiModel;
      if (captureWasActive) {
        // 模型切换会改变 Worker session；旧模型结果必须立刻作废，不能与
        // 新模型的滑窗混进同一条稳定时间轴。
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
        aiCues = [];
        setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: [] });
        aiCaptureError = '模型已切换，请重新请求 AI 字幕';
        resetTranslationState();
      }
    }
    syncPretranslationConfig();
    syncPlayerUi();
    updatePlayerUiState();
    if (observedContainer) {
      applyVideoDisplayState(observedContainer);
      syncTranslationOverlayPosition(observedContainer);
    }
    if (!nextConfig.on || !nextConfig.videoTranslationEnabled || nextConfig.videoSubtitleVisible === false || normalizeVideoSubtitleDisplayMode(nextConfig.videoSubtitleDisplayMode) === 'original-only') {
      if (!nextConfig.on || !nextConfig.videoTranslationEnabled) subtitleDownloadAbortController?.abort();
      if ((!nextConfig.on || !nextConfig.videoTranslationEnabled) && isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
      }
      clearPretranslationState(false);
      resetTranslationState();
      return;
    }
    observeCaptionContainer();
    if (newlyEnabled && isXVideoPage()) void restoreCachedAiSubtitles();
    scheduleUpdate();
  });

  return () => {
    destroyed = true;
    cacheEpoch += 1;
    unsubscribePlayer();
    playerBinding?.destroy();
    playerLocator.destroy();
    xSubtitleLoader.reset();
    hlsAudio.reset();
    videoTranslator.clear();
    generation += 1;
    pendingTranslationSource = '';
    pendingTranslationOverlay = null;
    subtitleDownloadAbortController?.abort();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (mediaMissingTimer) clearTimeout(mediaMissingTimer);
    cancelCaptionEmptyClear();
    cancelStableCaption();
    clearPretranslationState(true);
    stopCaptionClock();
    xCaptionSource.restoreTracks();
    observedVideo = null;
    if (uiSyncTimer !== undefined) window.clearInterval(uiSyncTimer);
    captionObserver?.disconnect();
    unsubscribeConfig();
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('keydown', handleDocumentKeydown, true);
    document.removeEventListener('visibilitychange', handleVideoVisibilityChange);
    videoTimelineEventNames.forEach((eventName) => document.removeEventListener(eventName, handleVideoTimelineEvent, true));
    window.removeEventListener('message', handleTimedTextMessage);
    window.removeEventListener('message', handleXSubtitleResourceMessage);
    aiCapture?.destroy();
    aiFullCapture?.destroy();
    document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID)?.remove();
    closeMenu();
    document.querySelectorAll(`#${VIDEO_TRANSLATION_BUTTON_ID}, #${VIDEO_TRANSLATION_MENU_ID}`).forEach((node) => node.remove());
    removeTranslationOverlay();
    document.querySelectorAll(VIDEO_CAPTION_CONTAINER_SELECTOR).forEach((node) => {
      node.classList.remove('notranslate', VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS, VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS, VIDEO_DISPLAY_HIDDEN_CLASS, VIDEO_NORMALIZED_CAPTION_CLASS);
      node.removeAttribute('data-fluent-read-video-display-mode');
    });
    style.remove();
  };
}
