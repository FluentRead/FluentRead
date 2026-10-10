/**
 * @file src/features/video-subtitle/content/runtime.ts
 * 文件职责：装配视频及会议字幕运行时，并协调 YouTube/X 原生字幕、目标语言人工轨、逐条翻译、校时、菜单和下载。
 * 主要内容：相同译文保留原文且不重复展示；协调字幕校时、预翻译与补译导出确认；X 分片加载尊重原生轨道优先级，播放器内换模型必须确认且保留取消焦点，完整 AI 识别提前展示稳定句，完成后才缓存和导出。
 * 模块边界：本文件只在 content 页面编排，不拦截 fetch/XHR 也不实现翻译 provider；MAIN-world bridge 在独立模块捕获 timedtext，解析算法在 youtubeSubtitleData，翻译经 app client。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import browser from 'webextension-polyfill';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {
  VIDEO_AI_CAPTION_CONTAINER_ID,
  VIDEO_CAPTION_CONTAINER_SELECTOR,
  VIDEO_TRANSLATION_OVERLAY_ID,
  VIDEO_SUBTITLE_PANEL_ID,
  VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS,
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
  VIDEO_CAPTION_STABILITY_MS,
  VIDEO_CAPTION_MAX_WAIT_MS,
  normalizeVideoSubtitleDisplayMode,
  renderHumanVideoCaption,
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
import {VideoPretranslationController} from './pretranslationController';
import {getVideoTranslationConfigFingerprint, normalizeVideoCaptionText, revealVideoSubtitleTranslation, selectYoutubeCaptionCue, selectVideoSubtitleCueAtOffset, findProgressiveVideoCaptionCue} from './subtitleLogic';
export {translateVideoSubtitleCues, getVideoTranslationConfigFingerprint, normalizeVideoCaptionText, revealVideoSubtitleTranslation} from './subtitleLogic';
export {getVideoSubtitleDownloadErrorMessage} from './ui';
import { config, requestConfigPatch, subscribeConfig } from '@/src/services/config/store';
import {getVideoUiLanguage, localizeVideoUiText, refreshVideoUiAccessibility, refreshVideoUiText, getVideoSubtitleDownloadErrorMessage} from './ui';
import {
  type Config,
  normalizeVideoSubtitleOffsetMs,
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
} from './serviceProfile';
import {parseXVideoBridgeMessage} from './xVideoSubtitleData';
import {
  normalizeVideoLocalTranscriptionModel,
  normalizeVideoAiRecognitionMetadata,
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
} from '@/src/features/video-subtitle/transcription';
import {
  finalizeVideoAiCuesForPlayback,
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
import {
  createVideoPlayerMenu, isVideoModelPromptOpen, renderVideoAiMenu, renderVideoAiModelSelection, renderVideoMenuMode, renderVideoModelPrompt,
  renderVideoSubtitleTiming, renderVideoSourceStatus, handleVideoMenuNavigation, setVideoMenuToolsOpen, setVideoMenuDownloadStatus, syncVideoPlayerMenuLayout, type VideoMenuMode,
} from './playerMenu';
import {createVideoAiModelSetup} from './video-ai/modelSetup';
import {createVideoAiModelMenu} from './video-ai/modelMenu';
import {videoModelDownloadId} from '@/src/core/download/progress';
import {watchContentDownloadProgress} from '@/src/platform/storage/downloadProgress';
import {isVideoSubtitleInTargetLanguage} from './subtitleLanguage';
import {createVideoPlayerLocator} from './videoPlayerLocator';
import {createVideoPlayerBinding, type VideoPlayerBinding} from './videoPlayerBinding';
import {getVideoTranscriptionCacheRequest, getVideoTranscriptionMediaKey, getVideoTranscriptionMediaTransition, VideoTranscriptionCacheClient} from './transcriptionCacheClient';
import type {VideoAiSubtitleCacheRequest, VideoAiSubtitleCacheSource} from '../transcriptionCache';
import {getCaptionPlatform} from './platforms';
import {mountPlatformCaptions} from './platformRuntime';
import {YoutubeHumanCaptions} from './youtubeHumanCaptions';
import {createVideoSubtitleDownloads} from './downloads';
import {confirmVideoSubtitleExport} from './exportPrompt';

// 兼容既有测试与外部调用方；AI 时间轴的实现位于 video-ai 目录。
export {
    getVisibleVideoAiCue,
    mergeVideoAiSubtitleCues,
    upsertVideoAiSubtitleCue,
} from './video-ai/cueTimeline';

type VideoConfigPatch = Partial<Pick<Config, 'videoTranslationEnabled' | 'videoSubtitleVisible' | 'videoSubtitleDisplayMode' | 'videoSubtitleFontSize' | 'videoSubtitleOffsetMs' | 'videoLocalModel'>>;

/**
 * 挂载 YouTube / X 播放器内的字幕翻译入口和字幕监听器。
 * X 的 AI 字幕是用户主动点击后，先完整采集视频音频，再交给扩展 offscreen
 * 页面内的本地 Whisper 模型和翻译服务；默认不会采集音频，音频不会离开浏览器。
 */
export function mountVideoSubtitleTranslation(): () => void {
  if (getCaptionPlatform(window.location)) return mountPlatformCaptions({
    document, window, config, subscribe: subscribeConfig,
    translate: translateVideoText,
    patch: patch => { void requestConfigPatch(patch, sendRuntimeMessage).catch(() => undefined); },
    label: text => localizeVideoUiText(text, getVideoUiLanguage(config.uiLanguage)),
  });
  // X 是 SPA：内容脚本可能先在 /home 加载，之后才无刷新进入 /status。
  // 在 X 域常驻控制器，信息流、个人主页和帖子共用当前视频定位。
  if (!isSupportedVideoPage() && !isXHostPage()) return () => undefined;

  const style = installVideoSubtitleStyle();
  let destroyed = false;
  let generation = 0;
  let lastSource = '';
  let lastTranslatedSource = '';
  let lastTranslatedText = '';
  let humanCaptionKey = '';
  let videoPageKey = getVideoPageKey();
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
  let stableCaptionStartedAt: number | undefined;
  let subtitleOffsetMs = normalizeVideoSubtitleOffsetMs(config.videoSubtitleOffsetMs);
  const capturedSubtitleTracks = new Map<string, { url: string; cues: VideoSubtitleCue[] }>();
  const humanCaptions = new YoutubeHumanCaptions((input, init) => fetch(input, init), () => {
    if (destroyed) return;
    resetTranslationState();
    scheduleUpdate();
  });
  // 已是目标语言的字幕直接返回原文：不请求翻译服务，渲染层据此只显示原文一行。
  const videoTranslator = new VideoTranslationCache((text, signal) => isVideoSubtitleInTargetLanguage(text, config.to)
    ? Promise.resolve(text)
    : translateVideoText(text, signal, isXVideoPage() ? config.videoSourceLanguage : undefined));
  let observedVideo: HTMLVideoElement | null = null;
  let layoutPlayer: HTMLElement | null = null;
  let layoutVideo: HTMLVideoElement | null = null;
  let layoutFrame: number | undefined;
  const scheduleSubtitleLayout = () => {
    if (destroyed || layoutFrame !== undefined) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = undefined;
      if (destroyed) return;
      if (menuElement?.isConnected) syncVideoPlayerMenuLayout(menuElement);
      syncTranslationOverlayPosition(observedContainer);
    });
  };
  const layoutObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSubtitleLayout) : null;
  const observeSubtitleLayout = (player: HTMLElement | null, video: HTMLVideoElement | null) => {
    if (layoutPlayer === player && layoutVideo === video) return;
    layoutObserver?.disconnect();
    layoutPlayer = player;
    layoutVideo = video;
    if (player) layoutObserver?.observe(player);
    if (video) layoutObserver?.observe(video);
    scheduleSubtitleLayout();
  };
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
  let normalizedCaptionActive = false;
  let aiCapture: VideoAiCaptureController | null = null;
  let aiFullCapture: VideoAiFullCaptureController | null = null;
  let aiFullPhase: VideoAiFullCapturePhase = 'idle';
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
  let aiRestoredFromCache = false;
  let regenerateAiRequested = false;
  let activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
  const aiStreamId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `video-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let observedMediaSource = '';
  let observedStableMediaKey = '';
  let observedMediaIdentity: VideoAiSubtitleCacheSource | null = null;
  // 下载/缓存等待使用真实换媒体的代际；poster 与媒体 ID 的补全只更新缓存
  // 身份，不能让用户刚完成的模型下载失去启动识别的资格。
  let observedMediaEpoch = 0;
  let mediaMissingTimer: ReturnType<typeof setTimeout> | undefined;
  let activeVideoLanguage = config.videoSourceLanguage;
  const playerLocator = createVideoPlayerLocator();
  let playerBinding: VideoPlayerBinding | undefined;
  let cacheEpoch = 0;
  let subtitlesPreviouslyVisible = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false;
  let cacheLookup: Promise<boolean> | undefined;
  let activeAiCacheRequest: VideoAiSubtitleCacheRequest | null = null;
  const transcriptCache = new VideoTranscriptionCacheClient(sendRuntimeMessage);
  const currentCacheRequest = () => getVideoTranscriptionCacheRequest(observedVideo, activeAiModel, activeVideoLanguage, window.location.href, observedMediaIdentity);
  const stableMediaKey = (video: HTMLVideoElement | null) => getVideoTranscriptionMediaKey(video === observedVideo ? currentCacheRequest()?.source : getVideoTranscriptionCacheRequest(video, activeAiModel, activeVideoLanguage, window.location.href)?.source);
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
    normalizedCaptionActive = false;
  };

  const clearProgressiveCaption = () => {
    progressiveCueKey = '';
    progressiveCue = null;
    progressiveTranslation = '';
    deactivateNormalizedCaption();
  };

  const cancelStableCaption = () => {
    if (stableCaptionTimer) clearTimeout(stableCaptionTimer);
    stableCaptionTimer = undefined;
    stableCaptionSource = '';
    stableCaptionOverlay = null;
    stableCaptionStartedAt = undefined;
  };

  const resetTranslationState = (preserveCaptionWait = false) => {
    if (!preserveCaptionWait) cancelStableCaption();
    generation += 1;
    lastSource = '';
    lastTranslatedSource = '';
    lastTranslatedText = '';
    humanCaptionKey = '';
    pendingTranslationSource = '';
    pendingTranslationOverlay = null;
    clearProgressiveCaption();
    clearRenderedTranslation();
    document.getElementById(VIDEO_SUBTITLE_PANEL_ID)?.classList.remove(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS);
  };

  // 译文与原文相同（包括已是目标语言而跳过翻译）时，双语只保留原文一行；仅译文模式隐藏了
  // 原文行，仍需用原文回退显示。结果按原样缓存，每次渲染时按当前显示模式决定，切换模式后立即生效。
  const visibleTranslation = (translation: string, source: string): string =>
    hasDistinctTranslation(normalizeVideoCaptionText(source), normalizeVideoCaptionText(translation)) ? translation
      : normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) === 'translation-only' ? source : '';

  // X 的双语面板以一整对字幕为更新单位。未预取到译文时先收起两行，
  // 返回后一起显示；明确失败时保留原文，让菜单中的重试仍然可用。
  const renderSynchronizedXCaption = (container: HTMLElement, source: string, translation?: string) => {
    const player = playerLocator.getTarget()?.player;
    if (!player) return;
    const result = translation || (isVideoSubtitleInTargetLanguage(source, config.to) ? source : '');
    normalizedCaptionActive = true;
    renderHumanVideoCaption(player, container, result || videoTranslator.hasFailure(source) ? source : '', visibleTranslation(result, source));
  };

  const canReadVideo = () => config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false;

  const canTranslateVideo = () => canReadVideo() && normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) !== 'original-only';

  const clearPretranslationState = (clearTrack = false, preserveTranslations = false) => {
    pretranslationController.clear();
    pretranslationCacheVersion += 1;
    if (preserveTranslations) videoTranslator.cancelPending();
    else videoTranslator.clear();
    resetTranslationState();
    if (clearTrack) {
      pretranslationTrackRequest = undefined;
      pretranslationTrackRequestKey = '';
      pretranslationTrackRetryAt = 0;
      pretranslationTrackKey = '';
      pretranslationCues = [];
    }
  };

  const getCachedVideoTranslation = (source: string, prefetch = false, cue?: VideoSubtitleCue): Promise<string> => {
    if (config.videoPreferHumanSubtitles && isYouTubeVideoPage()) {
      const currentMs = getCurrentVideoTimeMs() - subtitleOffsetMs;
      const active = cue || findProgressiveVideoCaptionCue(pretranslationCues, source, currentMs);
      const time = prefetch && active ? active.startMs + active.durationMs / 2 : currentMs;
      const human = humanCaptions.at(time);
      if (human) return Promise.resolve(human);
    }
    return videoTranslator.request(source, prefetch);
  };

  const getCurrentVideoTimeMs = (): number => {
    const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
    const currentVideo = player?.querySelector<HTMLVideoElement>('video.html5-main-video, video') || observedVideo;
    const currentTime = currentVideo?.currentTime;
    return typeof currentTime === 'number' && Number.isFinite(currentTime)
      ? currentTime * 1000
      : Number.NaN;
  };

  const hasAdjustedTimeline = () => subtitleOffsetMs !== 0 && pretranslationCues.length > 0;
  const getAdjustedCaptionCue = () => selectVideoSubtitleCueAtOffset(pretranslationCues, getCurrentVideoTimeMs(), subtitleOffsetMs);
  const readCurrentCaptionText = (container: Element | null): string => {
    if (!container) return '';
    if (!hasAdjustedTimeline()) return readVisibleCaptionText(container);
    if (isYouTubeVideoPage() && document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false') return '';
    return getAdjustedCaptionCue()?.text || '';
  };

  const findProgressiveCue = (source: string): VideoSubtitleCue | null =>
    findProgressiveVideoCaptionCue(pretranslationCues, source, getCurrentVideoTimeMs());

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
    if (hasAdjustedTimeline()) return getAdjustedCaptionCue();
    if (isYouTubeVideoPage()) return selectYoutubeCaptionCue(pretranslationCues, source, getCurrentVideoTimeMs()).cue;
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
    if (!progressiveCue) return;
    if (isXVideoPage()) {
      renderSynchronizedXCaption(container, progressiveCue.text, progressiveTranslation);
      return;
    }
    if (!progressiveTranslation) return;
    if (!visibleTranslation(progressiveTranslation, progressiveCue.text)) {
      overlay.textContent = '';
      syncTranslationOverlayPosition(container);
      return;
    }

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
      progressiveTranslation = videoTranslator.peek(cue.text) || '';
      ++generation;
      lastTranslatedSource = '';
      lastTranslatedText = '';
      overlay.textContent = '';
    } else {
      progressiveCue = cue;
    }

    const syntheticCaptionActive = container.id === VIDEO_AI_CAPTION_CONTAINER_ID;
    const captionDiffersFromCue = normalizeVideoCaptionText(source) !== normalizeVideoCaptionText(cue.text);
    // YouTube 的整句与逐词字幕都使用同一个双语面板；避免每次换句在
    // 原生定位和归一化定位之间跳动，播放控件动画也不再分别移动两行。
    normalizedCaptionActive ||= captionDiffersFromCue || syntheticCaptionActive || isYouTubeVideoPage();
    if (normalizedCaptionActive) {
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (player) renderHumanVideoCaption(player, container, isXVideoPage() ? '' : cue.text, overlay.textContent || '');
    }
    lastSource = source;
    renderProgressiveCaption(source, overlay, container);
    if (progressiveTranslation) return true;

    const requestGeneration = generation;
    const requestCueKey = cueKey;
    const requestTrackVersion = pretranslationCacheVersion;
    void getCachedVideoTranslation(cue.text, false, cue).then((translated) => {
      const result = typeof translated === 'string' ? translated.trim() : '';
      if (!result) return;
      if (destroyed || requestTrackVersion !== pretranslationCacheVersion) return;

      if (requestGeneration !== generation || requestCueKey !== progressiveCueKey) return;
      if (observedVideo?.seeking || !canTranslateVideo()) return;
      progressiveTranslation = result;

      const currentContainer = findCaptionContainer();
      const currentSource = readCurrentCaptionText(currentContainer);
      const currentCue = currentSource ? selectProgressiveCue(currentSource) : findActiveProgressiveCue();
      const currentCueKey = currentCue ? getProgressiveCueKey(currentCue) : '';
      if (!currentContainer || !currentSource || currentCueKey !== requestCueKey) return;
      lastSource = currentSource;
      renderProgressiveCaption(currentSource, overlay, currentContainer);
    }).catch((error) => {
      if (!destroyed && requestGeneration === generation) {
        if (isXVideoPage()) { scheduleUpdate(); updatePlayerUiState(); }
        console.warn('[FluentRead] 视频字幕前置翻译失败', error);
      }
    });

    return true;
  };

  const primeUpcomingVideoCaptions = () => {
    if (destroyed || !canTranslateVideo() || !observedVideo || pretranslationCues.length === 0) return;
    videoTranslator.primeUpcoming(pretranslationCues, observedVideo.currentTime * 1000 - subtitleOffsetMs,
      getVideoPretranslationWindowMs(config.videoService || config.service), observedVideo.playbackRate, getCachedVideoTranslation);
  };

  const pretranslationController = new VideoPretranslationController(primeUpcomingVideoCaptions, () => {
    ensurePretranslationTrack();
    scheduleUpdate();
  });
  const schedulePretranslation = (immediate = false) => pretranslationController.schedule(immediate);

  const setPretranslationTrack = (key: string, entry: { url: string; cues: VideoSubtitleCue[] }) => {
    // 字幕时间行只在有时间轴时出现；打开的菜单需在轨道到达或清空时立即更新。
    if ((pretranslationCues.length > 0) !== (entry.cues.length > 0) && menuElement && !menuElement.hidden) {
      queueMicrotask(() => { if (!destroyed) updatePlayerUiState(); });
    }
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
    schedulePretranslation(true);
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
    if (canReadVideo() && !isAiCaptureActive()) {
      // 分片到达只补全捕获轨道；与播放器同步共用原生优先的选择入口。
      // 否则每个分片会把 x:native 切成 x:captions，随后 cuechange/定时
      // 同步又切回原生轨道，两次清空译文导致视频开头反复闪烁。
      ensurePretranslationTrack();
      scheduleUpdate();
    }
  };

  const handleXSubtitleResourceMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin || !isXVideoPage()) return;
    const data = parseXVideoBridgeMessage(event.data, {
      matchesPage: href => getVideoPageKey(href) === videoPageKey,
      mediaSource: `${observedMediaSource} ${observedVideo?.poster || ''}`,
      videoCount: () => document.querySelectorAll('video').length,
    });
    if (!data) return;
    if (data.kind === 'media') {
      for (const variant of data.variants) hlsAudio.rememberMedia(variant.url, variant.bitrate);
      return;
    }
    // 音轨读取器按媒体 ID 选择候选；MSE 使用海报的媒体 ID 关联，避免混入推荐视频。
    hlsAudio.remember(data.url, data.responseText);
    if (data.loadCaptions) {
      xSubtitleLoader.load({ url: data.url, offsetMs: 0 }, data.responseText);
    }
  };

  const ensurePretranslationTrack = () => {
    if (destroyed || !canReadVideo()) return;
    if (isYouTubeVideoPage()) humanCaptions.sync(document, window.location, config.to, config.videoPreferHumanSubtitles);

    // 自动恢复的缓存让位于后来到达的原生字幕；用户主动生成的 AI 时间轴保持稳定。
    const native = isXVideoPage() ? xCaptionSource.readNativeTrack() : null;
    if (aiRestoredFromCache && (native || xSubtitleCues.length > 0)) stopFullAiSubtitleGeneration();

    // AI 请求期间只允许 ai:capture 驱动翻译。X 的 sidecar 捕获会持续到达；
    // 若每秒把 track 切回 x:captions，就会反复清空 AI 翻译缓存，表现为
    // “识别有文字但译文不出现”或译文闪烁。
    if (isXVideoPage() && isAiCaptureActive()) {
      setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: aiCues });
      return;
    }

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
    if (!nextVideo && observedVideo && isXVideoPage() && (observedVideo.isConnected || !confirmMissing)) {
      // 悬浮/页面布局可能暂时隐藏仍连接的播放器；候选不可见不等于媒体离开。
      if (observedVideo.isConnected) { if (mediaMissingTimer) clearTimeout(mediaMissingTimer); mediaMissingTimer = undefined; return; }
      mediaMissingTimer ??= setTimeout(() => { mediaMissingTimer = undefined; syncVideoElement(true); }, 1500);
      return;
    }
    if (mediaMissingTimer) clearTimeout(mediaMissingTimer);
    mediaMissingTimer = undefined;
    const nextSource = nextVideo?.currentSrc || nextVideo?.src || '';
    const nextIdentity = getVideoTranscriptionCacheRequest(nextVideo, activeAiModel, activeVideoLanguage, window.location.href)?.source || null;
    const previousVideo = observedVideo;
    const {sameMedia, identity: nextObservedIdentity, key: nextObservedKey} = getVideoTranscriptionMediaTransition(
      observedMediaIdentity, nextIdentity, Boolean(previousVideo && previousVideo === nextVideo), observedMediaSource, nextSource);
    if (nextVideo === observedVideo && nextSource === observedMediaSource && nextObservedKey === observedStableMediaKey) return;
    if (!sameMedia) { observedMediaEpoch += 1; if (previousVideo) downloads.cancel(); }
    const identityChanged = nextObservedKey !== observedStableMediaKey;
    if (sameMedia && identityChanged && !isAiCaptureActive()) { cacheEpoch += 1; cacheLookup = undefined; }
    xCaptionSource.restoreTracks();
    stopCaptionClock();
    pretranslationController.observe(null);
    observedVideo = nextVideo || null;
    observedMediaSource = nextSource;
    observedMediaIdentity = nextObservedIdentity;
    observedStableMediaKey = nextObservedKey;
    if (sameMedia && identityChanged && activeAiCacheRequest) {
      activeAiCacheRequest = currentCacheRequest();
      if (activeAiCacheRequest && aiFullPhase === 'ready' && aiCues.length > 0) void transcriptCache.set(activeAiCacheRequest, aiCues);
    }
    if (previousVideo && isXVideoPage() && !sameMedia) {
      aiModelSetup.reset();
      regenerateAiRequested = false;
      stopFullAiSubtitleGeneration();
      stopAiSubtitleCapture(true);
      xSubtitleLoader.reset();
      hlsAudio.reset();
      xSubtitleCues = [];
      aiCues = [];
      capturedSubtitleTracks.clear();
      clearPretranslationState(true);
    }
    if (!observedVideo) return;
    pretranslationController.observe(observedVideo);
    if (isXVideoPage()) document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
    startCaptionClock();
    schedulePretranslation();
    if (isXVideoPage() && (!sameMedia || identityChanged)) void restoreCachedAiSubtitles();
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
    const response = await sendRuntimeMessage({
      type: 'fluentReadTranscribeLocalVideoAudio',
      streamId: aiStreamId,
      generation: chunk.sessionId,
      audioPcm16Base64: encodeVideoAiPcm16Base64(chunk.pcm),
      model: activeAiModel,
      sourceLanguage: activeVideoLanguage,
    }) as (VideoAiTranscriptionResult & {success?: boolean; error?: string}) | undefined;
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
      ...normalizeVideoAiRecognitionMetadata(response),
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

  const publishAiSubtitleCues = (cues: VideoSubtitleCue[]) => {
    aiCues = cues;
    setPretranslationTrack('ai:capture', {url: 'ai:capture', cues: aiCues});
    aiCaptureError = '';
    syncXVideoCaptionSource();
    scheduleUpdate();
    schedulePretranslation();
    updatePlayerUiState();
  };

  const prepareFullAiCues = async (cues: VideoAiStabilizedCue[], sessionId: number): Promise<void> => {
    const normalizedCues = finalizeVideoAiCuesForPlayback(cues);
    if (destroyed || !aiFullCapture?.isRequested() || aiFullCapture.getSessionId() !== sessionId) {
      throw new Error('本地视频完整 AI 字幕已取消');
    }
    if (activeAiCacheRequest) void transcriptCache.set(activeAiCacheRequest, normalizedCues);
    // 识别就绪或缓存命中立即恢复时间轴；翻译按播放位置预取，失败保留原文。
    publishAiSubtitleCues(normalizedCues);
  };

  aiFullCapture = new VideoAiFullCaptureController({
    getAudio: (video, signal) => {
      // 重放旧清单，并补查 Resource Timing 中未经过页面 Fetch/XHR 的清单。
      document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
      return hlsAudio.read(video, signal, currentCacheRequest()?.source);
    },
    getVideo: () => observedVideo,
    getModel: () => activeAiModel,
    isSupported: () => !destroyed && isXVideoPage(),
    transcribe: transcribeAiAudioChunk,
    onCuesProgress: (cues, sessionId) => {
      if (destroyed || !aiFullCapture?.isRequested() || aiFullCapture.getSessionId() !== sessionId) return;
      // 前面的稳定句可以先看先译；整片完成前不写持久缓存，也不把下载
      // 字幕入口当成完整时间轴。下个窗口的修正沿用 cue 的稳定身份。
      publishAiSubtitleCues(cues.map(cue => ({...cue, availableAtMs: 0, translationAvailableAtMs: 0})));
    },
    onTranscriptionComplete: prepareFullAiCues,
    onError: (error) => {
      // 前段预览不能在后续识别失败后变成“完整字幕”；清理预览与待写
      // 缓存身份，错误和重试入口由本次失败状态继续显示。
      resetAiSubtitleCues();
      activeAiCacheRequest = null;
      aiFullPhase = 'error';
      aiFullProgress = { ...aiFullProgress, phase: 'error', progress: 0 };
      aiCaptureError = /扫描副本.*X 视频音频|没有可复制的音频源/.test(error.message)
        ? '暂时无法生成 AI 字幕，可尝试打开帖子或刷新页面后重试'
        : /decode|解码|audio data/i.test(error.message)
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
      if (progress.phase === 'ready') void sendRuntimeMessage({
        type: 'fluentReadCancelLocalVideoTranscription', streamId: aiStreamId,
        generation: aiFullCapture!.getSessionId(), reason: 'complete',
      }).catch(() => undefined);
    },
    onSessionStart: (sessionId) => {
      void sendRuntimeMessage({
        type: 'fluentReadPrepareLocalVideoModel',
        model: activeAiModel,
        keepWarm: true,
        streamId: aiStreamId,
        generation: sessionId,
      }).catch(() => undefined);
    },
    onInvalidate: (reason, sessionId) => {
      void sendRuntimeMessage({
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
      void sendRuntimeMessage({
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
          ...normalizeVideoAiRecognitionMetadata(diagnostic),
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
      void sendRuntimeMessage({
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
    aiRestoredFromCache = false;
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
    aiRestoredFromCache = false;
    aiCaptureError = '';
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
    if (destroyed || !canReadVideo() || isAiCaptureActive()
      || xCaptionSource.readNativeTrack() || xSubtitleCues.length > 0) return Promise.resolve(false);
    const request = currentCacheRequest();
    if (!request) return Promise.resolve(false);
    const epoch = ++cacheEpoch;
    const source = stableMediaKey(observedVideo);
    const pending = transcriptCache.get(request).then(cues => {
      if (!cues || destroyed || epoch !== cacheEpoch || source !== stableMediaKey(observedVideo)
        || !canReadVideo() || isAiCaptureActive() || xCaptionSource.readNativeTrack() || xSubtitleCues.length > 0) return false;
      activeAiCacheRequest = request;
      aiRestoredFromCache = true;
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

  const closeMenu = () => {
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
    aiModelSetup.cancel();
    downloads.cancel();
    if (menu) { menu.hidden = true; setVideoMenuToolsOpen(menu, false); }
    button?.setAttribute('aria-expanded', 'false');
    syncTranslationOverlayPosition(findCaptionContainer());
  };

  const updatePlayerUiState = () => {
    playerBinding?.sync();
    const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    // X 控制栏收起后入口按钮会卸载，但已打开的菜单仍可操作；
    // 菜单状态不能依赖入口按钮在场，否则功能已生效却仍显示旧状态。
    if (!menu) return;
    if (button instanceof HTMLButtonElement) buttonElement = button;
    if (menu instanceof HTMLElement) menuElement = menu;

    const enabled = config.on && config.videoTranslationEnabled;
    const visible = config.videoSubtitleVisible !== false;
    const status = config.on
      ? (config.videoTranslationEnabled ? videoUi('video.enabled') : videoUi('video.disabled'))
      : videoUi('video.globalDisabled');
    button?.classList.toggle(VIDEO_TRANSLATION_ACTIVE_CLASS, enabled);
    button?.setAttribute('aria-pressed', String(enabled));
    button?.setAttribute('aria-expanded', String(!menu.hidden));

    const language = getVideoUiLanguage(config.uiLanguage);
    const choice = aiModelSetup.choice;
    renderVideoModelPrompt(menu, choice && {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, ...choice}, language);
    const selectedMode: VideoMenuMode = enabled && visible ? normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) : 'off';
    renderVideoMenuMode(menu, selectedMode, !config.on, status);
    const service = menu.querySelector<HTMLElement>('[data-service-label]');
    if (service) service.textContent = localizeVideoUiText(getVideoServiceLabel(config.videoService || config.service), language);
    refreshVideoUiText(menu, language);
    refreshVideoUiAccessibility(menu, button, document, language, status);
    renderVideoSubtitleTiming(menu, subtitleOffsetMs, enabled && pretranslationCues.length > 0, language);
    renderVideoAiMenu(menu, {
      available: isXVideoPage() && browserCapabilities.extensionDom,
      checking: aiModelSetup.checking, downloading: aiModelSetup.downloading, downloadProgress: aiModelSetup.downloadProgress,
      active: isAiCaptureActive(), running: isAiCaptureRunning(), requested: isAiCaptureRequested(),
      fullActive: isAiFullActive(), phase: aiFullPhase, progress: aiFullProgress, error: aiCaptureError,
    }, language);
    const canChooseAiModel = enabled && visible && isXVideoPage() && browserCapabilities.extensionDom;
    renderVideoAiModelSelection(menu, {
      model: activeAiModel, available: canChooseAiModel,
      disabled: aiModelSetup.checking || aiModelSetup.downloading
        || (isAiCaptureActive() && aiFullPhase !== 'ready'),
    }, language);
    if (isXVideoPage()) {
      const original = readCurrentCaptionText(findCaptionContainer());
      const source = isAiCaptureActive() && aiCues.length > 0 ? (aiRestoredFromCache ? 'cache' : 'ai')
        : pretranslationTrackKey.startsWith('x:') && pretranslationCues.length > 0 ? 'native' : 'none';
      renderVideoSourceStatus(menu, {
        enabled: enabled && visible, source,
        cueCount: source === 'none' ? 0 : pretranslationCues.length,
        checking: Boolean(cacheLookup),
        generating: isAiCaptureActive() && aiFullPhase !== 'ready',
        translationFailed: canTranslateVideo() && videoTranslator.hasFailure(progressiveCue?.text || original),
        canRegenerate: enabled && visible && aiCues.length > 0 && aiFullPhase === 'ready',
        canChooseModel: canChooseAiModel,
      }, language);
    }
    if (!menu.hidden) syncVideoPlayerMenuLayout(menu);
  };

  const persistVideoConfig = (patch: VideoConfigPatch) => {
    // requestConfigPatch 会在返回 Promise 前乐观更新共享 config；连续点击会读取
    // 用户刚看到的状态，同时后台只在最新权威配置上合并这几个视频字段。
    void requestConfigPatch(
      patch,
      sendRuntimeMessage,
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
    // 人工目标轨由独立时间轴消费，不能把它当作播放器的原文轨替换。
    if (humanCaptions.ownsUrl(validated.url)) return;
    const key = getTimedTextCacheKey(validated.url);
    const entry = validated;
    capturedSubtitleTracks.delete(key);
    capturedSubtitleTracks.set(key, entry);
    if (canTranslateVideo()) {
      setPretranslationTrack(key, entry);
      scheduleUpdate();
    }
  };

  const downloads = createVideoSubtitleDownloads({
    config, document, location: window.location, request: (input, init) => fetch(input, init), isX: isXVideoPage, isDisposed: () => destroyed,
    isAiActive: isAiCaptureActive,
    isAiComplete: () => aiFullPhase === 'ready' || (!isAiFullActive() && aiCues.length === 0),
    nativeX: () => xCaptionSource.readNativeTrack(), aiCues: () => aiCues,
    captured: () => Array.from(capturedSubtitleTracks.values()).reverse(),
    human: {ready: async () => {
      if (isYouTubeVideoPage()) humanCaptions.sync(document, window.location, config.to, config.videoPreferHumanSubtitles);
      await humanCaptions.ready();
    }, at: time => humanCaptions.at(time)},
    translate: source => videoTranslator.request(source), peek: source => pretranslationConfigKey === getVideoTranslationConfigFingerprint(config) ? videoTranslator.peek(source) : undefined,
    cancelTranslations: () => videoTranslator.cancelPending(),
    contextKey: () => `${getVideoPageKey()}:${observedMediaEpoch}`,
    confirm: (menu, preview, bilingual, signal) => confirmVideoSubtitleExport(menu, preview, bilingual, signal, videoUi), ui: videoUi, status: setVideoMenuDownloadStatus, save: downloadSubtitleSrt, refreshButtons: updatePlayerUiState,
    remember: entry => { const key = getTimedTextCacheKey(entry.url); capturedSubtitleTracks.delete(key); capturedSubtitleTracks.set(key, entry);
      if (canTranslateVideo()) setPretranslationTrack(key, entry); },
  });

  const aiModelSetup = createVideoAiModelSetup({
    sendMessage: sendRuntimeMessage,
    getConfiguredModel: () => normalizeVideoLocalTranscriptionModel(config.videoLocalModel),
    captureRequest: () => {
      // 读取或下载期间换视频、改源语言或关闭翻译时，旧结果不能启动新一轮识别。
      const pageKey = getVideoPageKey();
      const mediaEpoch = observedMediaEpoch;
      const language = activeVideoLanguage;
      const regenerating = regenerateAiRequested;
      return () => !destroyed && config.on && config.videoTranslationEnabled
        && (!isAiCaptureActive() || (regenerating && aiFullPhase === 'ready'))
        && pageKey === getVideoPageKey() && mediaEpoch === observedMediaEpoch && observedVideo !== null && language === activeVideoLanguage;
    },
    persistModel: model => persistVideoConfig({videoLocalModel: model}),
    startGeneration: () => {
      if (isAiFullActive()) stopFullAiSubtitleGeneration();
      regenerateAiRequested = false;
      startFullAiSubtitleGeneration();
    },
    setError: (message) => { aiCaptureError = message; },
    formatDownloadError: message => videoUi('video.aiModelDownloadFailed', {error: localizeVideoUiText(message, getVideoUiLanguage(config.uiLanguage))}),
    watchDownload: (model, listener) => import.meta.env.BROWSER === 'userscript' ? () => undefined : watchContentDownloadProgress(videoModelDownloadId(model), listener),
    onChange: () => { if (!destroyed) updatePlayerUiState(); },
  });
  const aiModelMenu = createVideoAiModelMenu({
    setup: aiModelSetup, isCurrent: () => !destroyed && canReadVideo(), mediaEpoch: () => observedMediaEpoch,
    restoreCache: restoreCachedAiSubtitles, invalidateCache: () => { cacheEpoch += 1; cacheLookup = undefined; },
    setRegenerating: regenerate => { regenerateAiRequested = regenerate; },
    ensureEnabled: () => persistVideoConfig({videoTranslationEnabled: true, videoSubtitleVisible: true}),
    supportsLocal: () => browserCapabilities.extensionDom, setError: message => { aiCaptureError = message; },
    canSelect: () => !isAiCaptureActive() || aiFullPhase === 'ready',
  });
  const selectMenuMode = (mode: VideoMenuMode) => {
    if (mode === 'off') {
      if (!config.videoTranslationEnabled) return;
      persistVideoConfig({ videoTranslationEnabled: false });
      if (isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
      }
      return;
    }
    const wasEnabled = config.videoTranslationEnabled;
    // 弹出式菜单不再单独提供“显示字幕”开关；选择任一显示方式即恢复可见。
    persistVideoConfig({
      videoSubtitleDisplayMode: normalizeVideoSubtitleDisplayMode(mode),
      ...(wasEnabled ? {} : {videoTranslationEnabled: true}),
      ...(config.videoSubtitleVisible === false ? {videoSubtitleVisible: true} : {}),
    });
    if (!wasEnabled) { ensureNativeCaptions(); void restoreCachedAiSubtitles(); }
  };

  const handleMenuClick = async (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const menu = menuElement;
    if (!menu || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>('[data-action], [data-mode], [data-model-choice]');
    if (!target || !menu.contains(target) || (target instanceof HTMLButtonElement && target.disabled)) return;

    event.preventDefault();
    event.stopPropagation();

    if (target.dataset.action?.startsWith('download-') && isAiFullActive() && aiFullPhase !== 'ready') {
      setVideoMenuDownloadStatus(menu, videoUi('video.sourcePreparing'), 2400);
      return;
    }

    if (target.dataset.action === 'open-subtitle-tools' || target.dataset.action === 'close-subtitle-tools') {
      const open = target.dataset.action === 'open-subtitle-tools';
      setVideoMenuToolsOpen(menu, open);
      const destination = menu.querySelector<HTMLButtonElement>(open ? '[data-action="close-subtitle-tools"]' : '[data-action="open-subtitle-tools"]');
      if (destination && !destination.hidden) destination.focus();
      else menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
      return;
    }
    if (['subtitle-earlier', 'subtitle-later', 'reset-subtitle-timing'].includes(target.dataset.action || '')) {
      const nextOffset = target.dataset.action === 'reset-subtitle-timing' ? 0
        : normalizeVideoSubtitleOffsetMs(config.videoSubtitleOffsetMs) + (target.dataset.action === 'subtitle-earlier' ? -500 : 500);
      persistVideoConfig({videoSubtitleOffsetMs: normalizeVideoSubtitleOffsetMs(nextOffset)});
      return;
    }
    if (target.dataset.mode) {
      selectMenuMode(target.dataset.mode as VideoMenuMode);
      return;
    }
    if (target.dataset.action === 'close-menu') {
      closeMenu();
      buttonElement?.focus();
      return;
    }
    if (target.dataset.action === 'retry-subtitle-translation') {
      videoTranslator.retryFailures();
      resetTranslationState();
      scheduleUpdate();
      schedulePretranslation();
      updatePlayerUiState();
      return;
    }
    if (target.dataset.action === 'regenerate-ai-subtitle') {
      await aiModelMenu.request(menu, true);
      updatePlayerUiState();
      return;
    }
    if (target.dataset.action === 'select-ai-model') {
      await aiModelMenu.select(menu);
      updatePlayerUiState();
      return;
    }
    if (target.dataset.action === 'toggle-ai-subtitle') {
      if (isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
        setVideoMenuToolsOpen(menu, false);
        menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
      } else {
        // 识别失败后的“重试”应重跑识别，不能悄悄恢复上一版缓存。
        await aiModelMenu.request(menu, aiFullPhase === 'error');
      }
      updatePlayerUiState();
      return;
    }
    if (target.dataset.modelChoice) {
      aiModelMenu.choose(menu, target.dataset.modelChoice);
      return;
    }
    if (target.dataset.action === 'model-prompt-cancel' || target.dataset.action === 'model-prompt-confirm') {
      aiModelMenu.finish(menu, target.dataset.action === 'model-prompt-confirm');
      return;
    }
    if (target.dataset.action === 'download-subtitles') {
      await downloads.original(menu, target as HTMLButtonElement,
        error => getVideoSubtitleDownloadErrorMessage(error, getVideoUiLanguage(config.uiLanguage)));
      return;
    }
    if (target.dataset.action === 'download-translated-subtitles' || target.dataset.action === 'download-bilingual-subtitles') {
      syncPretranslationConfig();
      await downloads.translated(menu, target as HTMLButtonElement, target.dataset.action === 'download-bilingual-subtitles');
      return;
    }
    if (target.dataset.action === 'open-settings') {
      closeMenu();
      void sendRuntimeMessage({ type: 'openOptionsPage', section: 'settings-video' }).catch(() => undefined);
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
      syncVideoPlayerMenuLayout(menu);
      menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
    } else {
      closeMenu();
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
    menu.addEventListener('keydown', handleVideoMenuNavigation);
  };

  const createPlayerButton = (): HTMLButtonElement => {
    const button = document.createElement('button');
    button.id = VIDEO_TRANSLATION_BUTTON_ID;
    button.className = 'ytp-button fluent-read-video-subtitle-button fluent-read-video-ui notranslate';
    button.type = 'button';
    button.setAttribute('role', 'button');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', VIDEO_TRANSLATION_MENU_ID);
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
    if (event.key !== 'Escape' || !menuElement || menuElement.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    // 导出/模型确认先退回原菜单，再按一次才关闭整个菜单。
    if (menuElement.dataset.view === 'export-prompt') { downloads.cancel(); return; }
    if (menuElement && !menuElement.hidden && isVideoModelPromptOpen(menuElement)) {
      aiModelMenu.finish(menuElement, false);
    } else if (menuElement.dataset.panel === 'tools') {
      setVideoMenuToolsOpen(menuElement, false);
      const destination = menuElement.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]');
      if (destination && !destination.hidden) destination.focus();
      else menuElement.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
    } else { closeMenu(); buttonElement?.focus(); }
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
            if (!nextOverlay || destroyed || observedVideo?.seeking || !canTranslateVideo()
              || requestGeneration !== generation || nextSource !== lastSource) continue;
            const result = typeof translated === 'string' ? translated.trim() : '';
            lastTranslatedSource = nextSource;
            lastTranslatedText = result;
            const shown = visibleTranslation(result, nextSource);
            const currentContainer = findCaptionContainer();
            if (!currentContainer || readCurrentCaptionText(currentContainer) !== nextSource) continue;
            if (isXVideoPage()) { renderSynchronizedXCaption(currentContainer, nextSource, result); continue; }
            if (!shown) continue;
            nextOverlay.textContent = shown;
            syncTranslationOverlayPosition(currentContainer);
          } catch (error) {
            if (!destroyed && requestGeneration === generation) {
              if (isXVideoPage()) {
                const container = findCaptionContainer();
                if (container && readCurrentCaptionText(container) === nextSource) renderSynchronizedXCaption(container, nextSource);
                updatePlayerUiState();
              }
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
    if (destroyed || readCurrentCaptionText(container) !== source || source === lastSource) return;

    lastSource = source;
    ++generation;
    lastTranslatedSource = '';
    lastTranslatedText = '';
    overlay.textContent = '';
    if (container.id === VIDEO_AI_CAPTION_CONTAINER_ID || isYouTubeVideoPage()) {
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (player) {
        renderHumanVideoCaption(player, container, isXVideoPage() ? '' : source, '');
        normalizedCaptionActive = true;
      }
    }
    const cached = videoTranslator.peek(source);
    if (cached !== undefined) {
      lastTranslatedSource = source;
      lastTranslatedText = cached;
      overlay.textContent = visibleTranslation(cached, source);
      if (isXVideoPage()) renderSynchronizedXCaption(container, source, cached);
      pendingTranslationSource = '';
      pendingTranslationOverlay = null;
      syncTranslationOverlayPosition(container);
      return;
    }
    pendingTranslationSource = source;
    pendingTranslationOverlay = overlay;
    if (isXVideoPage()) renderSynchronizedXCaption(container, source);
    startTranslationLoop();
  };

  const scheduleStableCaption = (source: string, overlay: HTMLElement) => {
    if (stableCaptionTimer && stableCaptionSource === source) return;

    const startedAt = stableCaptionStartedAt ?? performance.now();
    cancelStableCaption();
    stableCaptionStartedAt = startedAt;
    stableCaptionSource = source;
    stableCaptionOverlay = overlay;
    stableCaptionTimer = setTimeout(() => {
      stableCaptionTimer = undefined;
      const nextSource = stableCaptionSource;
      const nextOverlay = stableCaptionOverlay;
      stableCaptionSource = '';
      stableCaptionOverlay = null;
      stableCaptionStartedAt = undefined;
      if (destroyed || !nextSource) return;

      const container = findCaptionContainer();
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (!container || !player || readCurrentCaptionText(container) !== nextSource) return;
      const currentOverlay = nextOverlay?.isConnected ? nextOverlay : getOrCreateTranslationOverlay(player);
      commitStableCaption(nextSource, currentOverlay, container);
    }, Math.min(VIDEO_CAPTION_STABILITY_MS, Math.max(0, VIDEO_CAPTION_MAX_WAIT_MS - (performance.now() - startedAt))));
  };

  const updateCaption = () => {
    if (destroyed) return;
    if (isYouTubeVideoPage() && observedVideo?.seeking) { resetTranslationState(); return; }

    if (isXVideoPage()) syncXVideoCaptionSource();
    const container = findCaptionContainer();
    if (!container) {
      captionObserver?.disconnect();
      captionObserver = undefined;
      observedContainer = null;
      resetTranslationState();
      return;
    }

    container.classList.add('notranslate');
    applyVideoDisplayState(container);
    const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
    const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
    if (!player) return;
    const source = readCurrentCaptionText(container);
    const canTranslate = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false && displayMode !== 'original-only';
    if (!canTranslate) {
      if (config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
        && displayMode === 'original-only' && (container.id === VIDEO_AI_CAPTION_CONTAINER_ID || hasAdjustedTimeline())) {
        if (!source) {
          resetTranslationState();
          if (hasAdjustedTimeline()) container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
          return;
        }
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
        renderHumanVideoCaption(player, container, source, '');
        normalizedCaptionActive = true;
        return;
      }
      resetTranslationState();
      return;
    }

    const overlay = getOrCreateTranslationOverlay(player);

    if (!source) {
      resetTranslationState();
      // 手动校时的空档也属于调整后的时间轴，不能漏出未偏移的原生字幕。
      if (hasAdjustedTimeline()) container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
      return;
    }

    if (isYouTubeVideoPage() && !hasAdjustedTimeline() && selectYoutubeCaptionCue(pretranslationCues, source, getCurrentVideoTimeMs()).stale) {
      resetTranslationState();
      return;
    }
    const human = config.videoPreferHumanSubtitles && isYouTubeVideoPage()
      ? humanCaptions.at(getCurrentVideoTimeMs() - subtitleOffsetMs) : '';
    if (human) {
      const key = `${source}:${human}`;
      if (key !== humanCaptionKey) {
        resetTranslationState();
        videoTranslator.cancelPending();
        humanCaptionKey = key;
      }
      normalizedCaptionActive = true;
      renderHumanVideoCaption(player, container, source, visibleTranslation(human, source));
      return;
    }
    if (humanCaptionKey) resetTranslationState();
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
      const shown = lastTranslatedSource === source ? visibleTranslation(lastTranslatedText, source) : '';
      if (lastTranslatedSource === source && overlay.textContent !== shown) {
        overlay.textContent = shown;
        syncTranslationOverlayPosition(container);
      }
      return;
    }

    if (isYouTubeVideoPage() && source !== stableCaptionSource) {
      // 新原文一出现就撤下上一句译文及其异步资格；请求仍可合并/预取，
      // 但不能在稳定等待期间让两种语言分别显示前后两句。
      resetTranslationState(true);
      renderHumanVideoCaption(player, container, source, '');
      normalizedCaptionActive = true;
    }

    // 短暂合并同一批词更新，但连续输出不能无限重置等待。
    // 仍由单个翻译循环合并为最新待译文本，旧请求不得写回新字幕。
    if (isXVideoPage() || videoTranslator.peek(source) !== undefined) commitStableCaption(source, overlay, container);
    else scheduleStableCaption(source, overlay);
  };

  // 原生字幕更新与清理在同一轮 DOM 变更内完成，请求的稳定等待单独处理。
  const scheduleUpdate = updateCaption;

  let captionFrame: number | undefined;
  let captionFrameVideo: HTMLVideoElement | null = null;
  let clockAdjustedCueKey = '';
  const stopCaptionClock = () => {
    if (captionFrame !== undefined) captionFrameVideo?.cancelVideoFrameCallback(captionFrame);
    captionFrame = undefined;
    captionFrameVideo = null;
    clockAdjustedCueKey = '';
  };
  const startCaptionClock = () => {
    const video = observedVideo;
    if (!config.on || !config.videoTranslationEnabled || config.videoSubtitleVisible === false
      || !video || video.paused || video.ended || captionFrame !== undefined
      || typeof video.requestVideoFrameCallback !== 'function') return;
    captionFrameVideo = video;
    captionFrame = video.requestVideoFrameCallback(() => {
      captionFrame = undefined;
      if (destroyed || observedVideo !== video || !video.isConnected) return;
      if (hasAdjustedTimeline()) {
        const cue = getAdjustedCaptionCue();
        const key = cue ? getProgressiveCueKey(cue) : '';
        if (key !== clockAdjustedCueKey) { clockAdjustedCueKey = key; updateCaption(); }
      } else if (isXVideoPage()) {
        const previous = readVisibleCaptionText(findCaptionContainer());
        const container = syncXVideoCaptionSource();
        if (readVisibleCaptionText(container) !== previous) updateCaption();
      } else if (progressiveCue && (video.currentTime * 1000 < progressiveCue.startMs
        || video.currentTime * 1000 >= progressiveCue.startMs + progressiveCue.durationMs)) {
        updateCaption();
      }
      startCaptionClock();
    });
  };

  const videoTimelineEventNames = ['timeupdate', 'seeking', 'seeked', 'emptied', 'loadedmetadata', 'resize', 'durationchange', 'play', 'pause', 'ended', 'ratechange'];
  const handleVideoTimelineEvent = (event: Event) => {
    const target = event.target as HTMLVideoElement | null;
    if (!target || target.tagName !== 'VIDEO') return;
    if (target !== observedVideo || event.type === 'loadedmetadata' || event.type === 'emptied') syncVideoElement();
    if (target !== observedVideo) return;
    if (isYouTubeVideoPage() && ['seeking', 'emptied', 'ended'].includes(event.type)) resetTranslationState();
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
    }
    if (target.paused || target.ended) stopCaptionClock();
    else startCaptionClock();
    if (['loadedmetadata', 'seeked', 'play', 'ratechange'].includes(event.type)) ensurePretranslationTrack();
    schedulePretranslation(['loadedmetadata', 'seeked', 'play', 'ratechange'].includes(event.type));
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
      resetTranslationState();
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
    humanCaptions.clear();
    downloads.cancel();
    clearPretranslationState(false);
  };

  const syncPlayerUi = () => {
    if (destroyed) return;
    const nextVideoPageKey = getVideoPageKey();
    if (nextVideoPageKey !== videoPageKey && !isXVideoPage()) {
      videoPageKey = nextVideoPageKey;
      downloads.cancel();
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
      humanCaptions.clear();
      observeSubtitleLayout(null, null);
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
    startCaptionClock();
    ensurePlayerUi();
    const layoutTarget = config.videoTranslationEnabled && config.videoSubtitleVisible !== false ? playerLocator.getTarget() : null;
    observeSubtitleLayout(layoutTarget?.player || null, layoutTarget?.video || null);
    ensurePretranslationTrack();
    syncXVideoCaptionSource();
    observeCaptionContainer();
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
  document.addEventListener('fullscreenchange', scheduleSubtitleLayout);
  window.addEventListener('resize', scheduleSubtitleLayout);
  videoTimelineEventNames.forEach((eventName) => document.addEventListener(eventName, handleVideoTimelineEvent, true));
  window.addEventListener('message', handleTimedTextMessage);
  window.addEventListener('message', handleXSubtitleResourceMessage);
  syncPlayerUi();
  uiSyncTimer = window.setInterval(syncPlayerUi, 1000);

  const unsubscribeConfig = subscribeConfig((nextConfig) => {
    const nextOffset = normalizeVideoSubtitleOffsetMs(nextConfig.videoSubtitleOffsetMs);
    if (nextOffset !== subtitleOffsetMs) {
      subtitleOffsetMs = nextOffset;
      resetTranslationState();
      schedulePretranslation();
    }
    const subtitlesEnabled = nextConfig.on && nextConfig.videoTranslationEnabled;
    const subtitlesVisible = subtitlesEnabled && nextConfig.videoSubtitleVisible !== false;
    const newlyEnabled = subtitlesVisible && !subtitlesPreviouslyVisible;
    subtitlesPreviouslyVisible = subtitlesVisible;
    if (!subtitlesEnabled) { cacheEpoch += 1; cacheLookup = undefined; }
    const nextAiModel = normalizeVideoLocalTranscriptionModel(nextConfig.videoLocalModel);
    if (nextAiModel !== activeAiModel || nextConfig.videoSourceLanguage !== activeVideoLanguage) {
      cacheEpoch += 1;
      cacheLookup = undefined;
      if (activeVideoLanguage !== nextConfig.videoSourceLanguage) {
        // 新语言必须重新选择 HLS 字幕资源，不能复用上一语言的 visited 集合或混合时间轴。
        xSubtitleLoader.reset();
        xSubtitleCues = [];
        capturedSubtitleTracks.clear();
        clearPretranslationState(true);
        if (isXVideoPage()) document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
      }
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
    if (newlyEnabled && isXVideoPage()) void restoreCachedAiSubtitles();
    if (!nextConfig.on || !nextConfig.videoTranslationEnabled || nextConfig.videoSubtitleVisible === false || normalizeVideoSubtitleDisplayMode(nextConfig.videoSubtitleDisplayMode) === 'original-only') {
      humanCaptions.clear();
      if (!nextConfig.on || !nextConfig.videoTranslationEnabled) { downloads.cancel(); aiModelSetup.reset(); }
      if ((!nextConfig.on || !nextConfig.videoTranslationEnabled) && isAiCaptureActive()) {
        if (isAiFullActive()) stopFullAiSubtitleGeneration();
        else stopAiSubtitleCapture(true);
      }
      clearPretranslationState(false, true);
      resetTranslationState();
      // 切换仅原文后立即重建 X 原文层，不留到下一秒轮询才恢复。
      if (nextConfig.on && nextConfig.videoTranslationEnabled && nextConfig.videoSubtitleVisible !== false) scheduleUpdate();
      return;
    }
    observeCaptionContainer();
    scheduleUpdate();
  });

  return () => {
    destroyed = true; aiModelSetup.reset();
    humanCaptions.clear();
    downloads.destroy();
    cacheEpoch += 1;
    unsubscribePlayer();
    if (menuElement) setVideoMenuDownloadStatus(menuElement, '');
    playerBinding?.destroy();
    playerLocator.destroy();
    xSubtitleLoader.reset();
    hlsAudio.reset();
    pretranslationController.destroy();
    videoTranslator.clear();
    generation += 1;
    pendingTranslationSource = '';
    pendingTranslationOverlay = null;
    if (mediaMissingTimer) clearTimeout(mediaMissingTimer);
    cancelStableCaption();
    clearPretranslationState(true);
    stopCaptionClock();
    xCaptionSource.restoreTracks();
    observedVideo = null;
    if (uiSyncTimer !== undefined) window.clearInterval(uiSyncTimer);
    captionObserver?.disconnect();
    layoutObserver?.disconnect();
    if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame);
    layoutPlayer = null;
    layoutVideo = null;
    unsubscribeConfig();
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('keydown', handleDocumentKeydown, true);
    document.removeEventListener('visibilitychange', handleVideoVisibilityChange);
    document.removeEventListener('fullscreenchange', scheduleSubtitleLayout);
    window.removeEventListener('resize', scheduleSubtitleLayout);
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
