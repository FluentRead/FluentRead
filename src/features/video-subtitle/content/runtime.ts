/**
 * @file src/features/video-subtitle/content/runtime.ts
 * 文件职责：装配视频及会议字幕运行时，并协调 YouTube/X 原生字幕、目标语言人工轨、逐条翻译、校时、菜单、完整句学习与下载。
 * 主要内容：挂载原句学习与独立本地读音控制器，原文变化立即作废旧读音，字幕隐藏或关闭取消请求；读音开关复用既有配置与菜单并保持仅译文模式语义，说明与下载可独立展开，Escape 逐层关闭且菜单关闭重置临时展开状态；双语顺序复用现有外观配置即时保存与重排，不重发翻译；显示模式变化重新授予同句翻译资格并复用已有缓存，不混入字幕原文及导出；媒体切换和配置变化取消有界字幕预取并清理控制，协调字幕校时、预翻译与补译导出确认，并为可选逐字高亮提供当前句时间；X 分片加载尊重原生轨道优先级和原译文成对显示，播放器内换模型保留取消焦点，完整 AI 识别提前展示稳定句，完成后才缓存和导出。
 * 模块边界：本文件只在 content 页面编排，同视频底控的局部显隐订阅与字幕布局共用帧调度，帧内先校准自有菜单宿主再测菜单，并随关闭、重绑和销毁清理；完整 AI 字幕缓存请求与提交身份由 subtitleSession 拥有，requestSession 将完整采集映射为后台单流的唯一请求代际；采集资源仍归 fullCapture，不拦截 fetch/XHR 也不实现翻译 provider，翻译经统一 service client。
 */
import {createApp, h, shallowReactive} from 'vue';
import {createNativeFullscreenSubtitles, supportsNativeVideoFullscreen} from './nativeFullscreen';
import {createSavedVideoPositionRestorer, getVideoLearningSource, type MutableVideoSentenceLearningProps} from './sentenceLearningHost';
import {createVideoSentenceLearningSession} from './sentenceLearningSession';
import {createVideoLearningPlacementOwner} from './sentenceLearningPlacement';
import sentenceLearningStyles from '../ui/videoSentenceLearning.css?inline';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import browser from 'webextension-polyfill';
import {sendVideoSubtitleRequest} from './backgroundClient';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {
  VIDEO_AI_CAPTION_CONTAINER_ID,
  VIDEO_CAPTION_CONTAINER_SELECTOR,
  VIDEO_SUBTITLE_PANEL_ID,
  VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS,
  VIDEO_TRANSLATION_BUTTON_ID,
  VIDEO_TRANSLATION_MENU_ID,
  VIDEO_TRANSLATION_ACTIVE_CLASS,
  VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS,
  VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS,
  VIDEO_DISPLAY_HIDDEN_CLASS,
  VIDEO_NORMALIZED_CAPTION_CLASS,
  VIDEO_CAPTION_STABILITY_MS,
  VIDEO_CAPTION_MAX_WAIT_MS,
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
  removeTranslationOverlay, clearRenderedVideoTranslation, deactivateNormalizedVideoCaption, readVideoPlaybackTimeMs,
  syncTranslationOverlayPosition,
  applyVideoDisplayState,
  installVideoSubtitleStyle
} from './ui';
import {XCaptionSource} from './xCaptionSource';
import {XHlsAudioReader} from './hlsAudioRuntime';
import {XSubtitleLoader} from './xSubtitleLoader';
import {VideoTranslationCache} from './translationCache';
import {createVideoReadingPlayer} from './readingAnnotationPlayer';
import {VideoPretranslationController} from './pretranslationController';
import {getVideoTranslationConfigFingerprint, normalizeVideoCaptionText, revealVideoSubtitleTranslation, selectYoutubeCaptionCue, selectVideoSubtitleCueAtOffset, findProgressiveVideoCaptionCue, findActiveVideoCaptionCue, selectProgressiveVideoCaptionCue, type YoutubeCueSelection} from './subtitleLogic';
import { config, requestConfigPatch, subscribeConfig } from '@/src/services/config/store';
import {getVideoUiLanguage, localizeVideoUiText, refreshVideoUiAccessibility, refreshVideoUiText, getVideoSubtitleDownloadErrorMessage, writeVideoCaptionText, createVideoSubtitleKaraoke} from './ui';
import {
  type Config,
  normalizeVideoSubtitleOffsetMs,
} from '@/src/core/config/model';
import { translateVideoText } from '@/src/services/translation/client';
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
import {parseXVideoBridgeMessage} from './xVideoSubtitleData';
import {
  normalizeVideoLocalTranscriptionModel,
  normalizeVideoAiRecognitionMetadata,
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
} from '@/src/features/video-subtitle/transcription';
import {
  finalizeVideoAiCuesForPlayback,
} from './video-ai/cueTimeline';
import {
  VideoAiFullCaptureController,
  type VideoAiAudioChunk,
  type VideoAiTranscriptionResult,
  type VideoAiFullCapturePhase,
  type VideoAiFullCaptureProgress,
} from './video-ai/fullCapture';
import { encodeVideoAiPcm16Base64 } from './video-ai/audioWindow';
import type { VideoAiStabilizedCue } from './video-ai/streamingTranscript';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {
  createVideoPlayerMenu, isVideoModelPromptOpen, renderVideoAiMenu, renderVideoAiModelSelection, renderVideoMenuMode, renderVideoSubtitleOrder, renderVideoModelPrompt,
  renderVideoSubtitleTiming, renderVideoSourceStatus, handleVideoMenuNavigation, handleVideoMenuDisclosure, closeVideoMenuDisclosure, resetVideoMenuDisclosures, setVideoMenuToolsOpen, setVideoMenuDownloadStatus, syncVideoPlayerMenuLayout, revealVideoMenuBodyControl, type VideoMenuMode,
} from './playerMenu';
import {createVideoAiModelSetup} from './video-ai/modelSetup';
import {VideoAiSubtitleSession} from './video-ai/subtitleSession';
import {VideoAiRequestSession} from './video-ai/requestSession';
import {createVideoAiModelMenu} from './video-ai/modelMenu';
import {videoModelDownloadId} from '@/src/core/download/progress';
import {watchContentDownloadProgress} from '@/src/platform/storage/downloadProgress';
import {isVideoSubtitleInTargetLanguage} from './subtitleLanguage';
import {createVideoPlayerLocator} from './videoPlayerLocator';
import {createVideoPlayerBinding, type VideoPlayerBinding} from './videoPlayerBinding';
import {getVideoTranscriptionCacheRequest, getVideoTranscriptionMediaTransition, VideoTranscriptionCacheClient} from './transcriptionCacheClient';
import type {VideoAiSubtitleCacheSource} from '../transcriptionCache';
import {getCaptionPlatform} from './platforms';
import {mountPlatformCaptions} from './platformRuntime';
import {YoutubeHumanCaptions} from './youtubeHumanCaptions';
import {readVideoCaptionText} from './subtitleTransport';
import {TimedTextTrackCache} from './timedTextTrackCache';
import {createVideoSubtitleDownloads} from './downloads';
import {confirmVideoSubtitleExport} from './exportPrompt';
import {createSubtitleLayoutObserver} from './subtitleLayoutObserver';

type VideoConfigPatch = Partial<Pick<Config, 'videoTranslationEnabled' | 'videoSubtitleVisible' | 'videoSubtitleDisplayMode' | 'videoSubtitleFontSize' | 'videoSubtitleOffsetMs' | 'videoLocalModel' | 'videoSubtitleAppearance'>>;

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
  style.textContent += sentenceLearningStyles;
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
  const capturedSubtitleTracks = new TimedTextTrackCache(() => pretranslationTrackKey);
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
  const learningPlacement = createVideoLearningPlacementOwner(() => config.videoSentenceLearningAppearance, subscribeConfig);
  const restorePosition = createSavedVideoPositionRestorer();
  const restoreSavedVideoPosition = () => { if (isXVideoPage() && observedVideo) restorePosition.restore(observedVideo, window.location, document); };
  const reading = createVideoReadingPlayer({
    getPlayer: () => playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null),
    canRead: () => canReadVideo(),
    getSourceContext: () => ({key: pretranslationTrackKey, captured: capturedSubtitleTracks.get(pretranslationTrackKey), cues: pretranslationCues}),
    nativeSync: () => nativeFullscreen.sync(),
    scheduleLayout: () => scheduleSubtitleLayout(),
    updateMenu: () => updatePlayerUiState(),
    updateCaption: () => scheduleUpdate(),
    resetCaption: () => resetTranslationState(),
  });
  const learning = createVideoSentenceLearningSession({markUi: markVideoUi, place: learningPlacement.place,
    load: async () => (await import('../ui/VideoSentenceLearning.vue')).default,
    mount: (view, host, props) => {const app = createApp({render: () => h(view, props)}); app.mount(host); return () => app.unmount();},
    readTarget: () => {const target = playerLocator.getTarget(); return target?.video === observedVideo ? target : null;},
    canOpen: () => !destroyed && canReadVideo() && (!isAiFullActive() || aiFullPhase === 'ready'),
    readProps: ({video}, onClose) => shallowReactive<MutableVideoSentenceLearningProps>({...getVideoLearningSource(video, window.location, document), video, cues: reading.sourceContext.getCues(),
      sourceLanguage: reading.sourceContext.getLanguage() || config.from, targetLanguage: config.to, onClose,
      translate: (text, signal) => isVideoSubtitleInTargetLanguage(text, config.to)
        ? Promise.resolve(text) : translateVideoText(text, signal, reading.sourceContext.getLanguage() || undefined),
    }),
  });
  const closeSentenceLearning = learning.close;
  const openSentenceLearning = learning.open;
  const subtitleLayout = createSubtitleLayoutObserver(() => {
    const target = playerLocator.getTarget();
    if (learning.isOpen() && target?.video === observedVideo) learning.syncPlayer(target.player, target.video);
    playerBinding?.syncMenuHost();
    if (menuElement?.isConnected) syncVideoPlayerMenuLayout(menuElement);
    syncTranslationOverlayPosition(observedContainer);
  }, isYouTubeVideoPage);
  const scheduleSubtitleLayout = subtitleLayout.schedule;
  const observeSubtitleLayout = subtitleLayout.observe;
  let pretranslationTrackRequest: Promise<void> | undefined;
  let pretranslationTrackAbort: AbortController | undefined;
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
  let regenerateAiRequested = false;
  let activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
  const aiStreamId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `video-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const aiRequests = new VideoAiRequestSession(aiStreamId);
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
  let subtitlesPreviouslyVisible = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false;
  const transcriptCache = new VideoTranscriptionCacheClient(sendRuntimeMessage);
  const currentCacheRequest = () => getVideoTranscriptionCacheRequest(observedVideo, activeAiModel, activeVideoLanguage, window.location.href, observedMediaIdentity);
  const aiSubtitleSession = new VideoAiSubtitleSession({
    readRequest: currentCacheRequest,
    canRestore: () => !destroyed && canReadVideo() && !isAiFullActive() && !xCaptionSource.readNativeTrack() && xSubtitleCues.length === 0,
    get: request => transcriptCache.get(request), set: (request, cues) => transcriptCache.set(request, cues),
    restore: cues => { resetAiSubtitleCues(); aiCaptureError = ''; return aiFullCapture!.restore(cues); },
  });
  const hlsAudio = new XHlsAudioReader();
  const xSubtitleLoader = new XSubtitleLoader({
    fetch: (url, options) => fetch(url, {...options, credentials: 'omit'}),
    language: () => config.videoSourceLanguage,
    onCues: (url, cues) => appendXSubtitleCues(url, cues),
  });
  const xSubtitleTrackKey = 'x:captions';
  let xSubtitleCues: VideoSubtitleCue[] = [];

  const isAiFullActive = () => aiFullCapture?.isActive() === true;

  const xCaptionSource = new XCaptionSource(() => ({
    video: observedVideo, player: playerLocator.getTarget()?.player, aiActive: isAiFullActive(), aiCues,
    enabled: config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false,
    sidecarCues: pretranslationTrackKey.startsWith('x:') ? pretranslationCues : [], language: config.videoSourceLanguage,
  }));
  const syncXVideoCaptionSource = () => xCaptionSource.sync();

  const clearRenderedTranslation = () => clearRenderedVideoTranslation(document);
  const deactivateNormalizedCaption = () => { deactivateNormalizedVideoCaption(document); normalizedCaptionActive = false; };

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
    reading.clear();
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
    reading.renderCaption(player, container, result || videoTranslator.hasFailure(source) ? source : '', visibleTranslation(result, source));
  };

  const canReadVideo = () => config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false;

  const canTranslateVideo = () => canReadVideo() && normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) !== 'original-only';

  const clearPretranslationState = (clearTrack = false, preserveTranslations = false) => {
    pretranslationController.clear();
    pretranslationTrackAbort?.abort();
    pretranslationTrackAbort = undefined;
    pretranslationTrackRequest = undefined;
    pretranslationCacheVersion += 1;
    if (preserveTranslations) videoTranslator.cancelPending();
    else videoTranslator.clear();
    resetTranslationState();
    if (clearTrack) {
      reading.reset();
      pretranslationTrackRequest = undefined;
      pretranslationTrackRequestKey = '';
      pretranslationTrackRetryAt = 0;
      pretranslationTrackKey = '';
      pretranslationCues = [];
      learning.updateCues(reading.sourceContext.getCues(), reading.sourceContext.getLanguage());
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

  const nativeFullscreen = createNativeFullscreenSubtitles(() => ({
    video: observedVideo, enabled: canReadVideo() && isYouTubeVideoPage(),
    cues: pretranslationCues, mode: normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode),
    offsetMs: subtitleOffsetMs, language: config.to, bilingualOrder: config.videoSubtitleAppearance.bilingualOrder,
    revision: `${videoTranslator.revision}:${humanCaptions.revision}:${config.to}:${config.videoPreferHumanSubtitles}`,
    translation: (source, cue) => (config.videoPreferHumanSubtitles ? humanCaptions.at(cue.startMs + cue.durationMs / 2) : '')
      || (isVideoSubtitleInTargetLanguage(source, config.to) ? source : videoTranslator.peek(source)),
    reading: {enabled: reading.enabled(), source: reading.state.source, text: reading.state.result?.text || ''},
  }));

  const getCurrentVideoTimeMs = () => readVideoPlaybackTimeMs(
    playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null), observedVideo);

  const hasAdjustedTimeline = () => subtitleOffsetMs !== 0 && pretranslationCues.length > 0;
  const getAdjustedCaptionCue = () => selectVideoSubtitleCueAtOffset(pretranslationCues, getCurrentVideoTimeMs(), subtitleOffsetMs);
  // 逐字高亮默认关闭；开启后原文与译文按当前句的时间一起扫光，手动校时同样生效。
  const karaoke = createVideoSubtitleKaraoke(() => canReadVideo() ? observedVideo : null,
    () => progressiveCue || getAdjustedCaptionCue(), () => subtitleOffsetMs);
  const readCurrentCaptionText = (container: Element | null): string => {
    if (!container) return '';
    if (!hasAdjustedTimeline()) return readVisibleCaptionText(container);
    if (isYouTubeVideoPage() && document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false') return '';
    return getAdjustedCaptionCue()?.text || '';
  };

  const getProgressiveCueKey = (cue: VideoSubtitleCue): string =>
    `${(cue as VideoSubtitleCue & { cueId?: string }).cueId || cue.startMs}:${normalizeVideoCaptionText(cue.text)}`;

  const findActiveProgressiveCue = () => findActiveVideoCaptionCue(pretranslationCues, getCurrentVideoTimeMs());
  const selectProgressiveCue = (source: string, selection?: YoutubeCueSelection): VideoSubtitleCue | null => {
    if (hasAdjustedTimeline()) return getAdjustedCaptionCue();
    if (isYouTubeVideoPage()) {
      // 播放时钟可能在同轮跨过句界；输入全同才复用，不保留跨帧或异步结果。
      const cues = pretranslationCues, currentMs = getCurrentVideoTimeMs();
      if (selection && selection.cues === cues && selection.source === source && selection.currentMs === currentMs) return selection.cue;
      return selectYoutubeCaptionCue(cues, source, currentMs).cue;
    }
    return selectProgressiveVideoCaptionCue(pretranslationCues, source, getCurrentVideoTimeMs());
  };

  const renderProgressiveCaption = (source: string, overlay: HTMLElement, container: HTMLElement) => {
    if (!progressiveCue) return;
    if (isXVideoPage()) {
      renderSynchronizedXCaption(container, progressiveCue.text, progressiveTranslation);
      return;
    }
    if (!progressiveTranslation) return;
    if (!visibleTranslation(progressiveTranslation, progressiveCue.text)) {
      writeVideoCaptionText(overlay, '');
      syncTranslationOverlayPosition(container);
      return;
    }

    const revealed = normalizedCaptionActive
      ? progressiveTranslation.trim()
      : revealVideoSubtitleTranslation(progressiveTranslation, source, progressiveCue.text);
    if (!revealed) return;
    writeVideoCaptionText(overlay, revealed);
    syncTranslationOverlayPosition(container);
  };

  const updateProgressiveCaption = (source: string, overlay: HTMLElement, container: HTMLElement, selection?: YoutubeCueSelection): boolean => {
    const cue = selectProgressiveCue(source, selection);
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
      writeVideoCaptionText(overlay, '');
    } else {
      progressiveCue = cue;
    }
    startCaptionClock();

    const syntheticCaptionActive = container.id === VIDEO_AI_CAPTION_CONTAINER_ID;
    const captionDiffersFromCue = normalizeVideoCaptionText(source) !== normalizeVideoCaptionText(cue.text);
    // YouTube 的整句与逐词字幕都使用同一个双语面板；避免每次换句在
    // 原生定位和归一化定位之间跳动，播放控件动画也不再分别移动两行。
    normalizedCaptionActive ||= captionDiffersFromCue || syntheticCaptionActive || isYouTubeVideoPage();
    if (normalizedCaptionActive) {
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (player) reading.renderCaption(player, container, isXVideoPage() ? '' : cue.text, overlay.textContent || '');
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
      learning.updateCues(reading.sourceContext.getCues(), reading.sourceContext.getLanguage());
      schedulePretranslation();
      return;
    }
    const replacingLoadedTrack = learning.hasCues();
    pretranslationTrackAbort?.abort();
    pretranslationTrackKey = key;
    pretranslationCues = entry.cues;
    if (replacingLoadedTrack) closeSentenceLearning();
    else learning.updateCues(reading.sourceContext.getCues(), reading.sourceContext.getLanguage());
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
    if (canReadVideo() && !isAiFullActive()) {
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
    if (aiSubtitleSession.isRestored && (native || xSubtitleCues.length > 0)) stopFullAiSubtitleGeneration();

    // AI 请求期间只允许 ai:capture 驱动翻译。X 的 sidecar 捕获会持续到达；
    // 若每秒把 track 切回 x:captions，就会反复清空 AI 翻译缓存，表现为
    // “识别有文字但译文不出现”或译文闪烁。
    if (isXVideoPage() && isAiFullActive()) {
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
    const controller = new AbortController();
    pretranslationTrackAbort = controller;
    const request = (async () => {
      try {
        const text = await readVideoCaptionText(url, fetch, {credentials: 'include', signal: controller.signal});
        if (destroyed || controller.signal.aborted || requestVersion !== pretranslationCacheVersion) return;
        const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(text));
        if (cues.length === 0) {
          pretranslationTrackRetryAt = Date.now() + 5000;
          return;
        }
        const entry = { url, cues };
        capturedSubtitleTracks.set(key, entry);
        setPretranslationTrack(key, entry);
        pretranslationTrackRetryAt = 0;
        scheduleUpdate();
      } catch {
        // 页面尚未准备好字幕轨道时，保留 DOM 实时翻译回退，并降低重试频率。
        if (!controller.signal.aborted && requestVersion === pretranslationCacheVersion) pretranslationTrackRetryAt = Date.now() + 5000;
      } finally {
        if (pretranslationTrackAbort === controller) pretranslationTrackAbort = undefined;
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
    if (!nextVideo && observedVideo && (observedVideo.isConnected || !confirmMissing)) {
      // 全屏切换和布局动画可能暂时隐藏仍连接的播放器；候选不可见不等于换媒体。
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
    if (previousVideo !== nextVideo || !sameMedia) closeSentenceLearning();
    if (!sameMedia) { observedMediaEpoch += 1; if (previousVideo) downloads.cancel(); }
    const identityChanged = nextObservedKey !== observedStableMediaKey;
    if (sameMedia && identityChanged && !isAiFullActive()) aiSubtitleSession.invalidate();
    xCaptionSource.restoreTracks();
    stopCaptionClock();
    pretranslationController.observe(null);
    observedVideo = nextVideo || null;
    observedMediaSource = nextSource;
    observedMediaIdentity = nextObservedIdentity;
    observedStableMediaKey = nextObservedKey;
    if (sameMedia && identityChanged) {
      aiSubtitleSession.updateMediaIdentity();
      if (aiFullPhase === 'ready') aiSubtitleSession.persistCompleted(aiCues);
    }
    if (previousVideo && isXVideoPage() && !sameMedia) {
      aiModelSetup.reset();
      regenerateAiRequested = false;
      stopFullAiSubtitleGeneration();
      xSubtitleLoader.reset();
      hlsAudio.reset();
      xSubtitleCues = [];
      aiCues = [];
      capturedSubtitleTracks.clear();
      clearPretranslationState(true);
    }
    if (!observedVideo) return;
    restoreSavedVideoPosition();
    pretranslationController.observe(observedVideo);
    if (isXVideoPage()) document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
    startCaptionClock();
    schedulePretranslation();
    if (isXVideoPage() && (!sameMedia || identityChanged)) void restoreCachedAiSubtitles();
  };

  const transcribeAiAudioChunk = async (chunk: VideoAiAudioChunk): Promise<VideoAiTranscriptionResult> => {
    const identity = aiRequests.read(chunk.sessionId);
    if (destroyed || chunk.pcm.length === 0 || !identity) return { skipped: true };
    const response = await sendVideoSubtitleRequest(sendRuntimeMessage, {
      type: 'fluentReadTranscribeLocalVideoAudio',
      ...identity,
      audioPcm16Base64: encodeVideoAiPcm16Base64(chunk.pcm),

    });
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

  const prepareAiTranscription = (sessionId: number) => {
    const identity = aiRequests.start(sessionId, activeAiModel, activeVideoLanguage);
    if (identity) void sendVideoSubtitleRequest(sendRuntimeMessage, {type: 'fluentReadPrepareLocalVideoModel', ...identity, keepWarm: true}).catch(() => undefined);
  };
  const cancelAiTranscription = (sessionId: number, reason: string) => {
    const identity = aiRequests.read(sessionId);
    if (identity) void sendVideoSubtitleRequest(sendRuntimeMessage, {type: 'fluentReadCancelLocalVideoTranscription', ...identity, reason}).catch(() => undefined);
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
    aiSubtitleSession.persistCompleted(normalizedCues);
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
      aiSubtitleSession.reset();
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
      if (progress.phase === 'ready') cancelAiTranscription(aiFullCapture!.getSessionId(), 'complete');
    },
    onSessionStart: (sessionId) => {
      prepareAiTranscription(sessionId);
    },
    onInvalidate: (reason, sessionId) => {
      cancelAiTranscription(sessionId, reason);
    },
  });

  const startFullAiSubtitleGeneration = (): boolean => {
    if (!aiFullCapture) return false;
    activeAiModel = normalizeVideoLocalTranscriptionModel(config.videoLocalModel);
    aiSubtitleSession.beginGeneration();
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

  const stopFullAiSubtitleGeneration = () => {
    aiSubtitleSession.reset();
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

  const restoreCachedAiSubtitles = () => aiSubtitleSession.restoreCached();

  const closeMenu = () => {
    const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
    const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
    const heldFocus = menu?.contains(document.activeElement);
    aiModelSetup.cancel();
    downloads.cancel();
    if (menu) { resetVideoMenuDisclosures(menu); menu.hidden = true; setVideoMenuToolsOpen(menu, false); }
    button?.setAttribute('aria-expanded', 'false');
    playerBinding?.syncMenuHost();
    if (heldFocus && button?.isConnected) button.focus({preventScroll: true});
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
    // 入口只开关菜单；清理复用节点上的旧 toggle 语义，不把字幕状态冒充点击动作。
    button?.removeAttribute('aria-pressed');
    button?.setAttribute('aria-expanded', String(!menu.hidden));

    const language = getVideoUiLanguage(config.uiLanguage);
    const choice = aiModelSetup.choice;
    renderVideoModelPrompt(menu, choice && {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, ...choice}, language);
    const selectedMode: VideoMenuMode = enabled && visible ? normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) : 'off';
    renderVideoMenuMode(menu, selectedMode, !config.on, status);
    renderVideoSubtitleOrder(menu, config.videoSubtitleAppearance.bilingualOrder, !enabled || !visible, selectedMode === 'bilingual');
    const service = menu.querySelector<HTMLElement>('[data-service-label]');
    if (service) service.textContent = localizeVideoUiText(getVideoServiceLabel(config.videoService || config.service), language);
    refreshVideoUiText(menu, language);
    refreshVideoUiAccessibility(menu, button, document, language, status);
    reading.syncMenu(menu, enabled, selectedMode);
    const learningButton = menu.querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]');
    if (learningButton) {
      learningButton.disabled = isAiFullActive() && aiFullPhase !== 'ready';
      learningButton.title = learningButton.disabled ? videoUi('video.sourcePreparing') : videoUi('video.learning.title');
    }
    renderVideoSubtitleTiming(menu, subtitleOffsetMs, enabled && pretranslationCues.length > 0, language);
    renderVideoAiMenu(menu, {
      available: isXVideoPage() && browserCapabilities.extensionDom,
      checking: aiModelSetup.checking, downloading: aiModelSetup.downloading, downloadProgress: aiModelSetup.downloadProgress,
      active: isAiFullActive(),
      fullActive: isAiFullActive(), phase: aiFullPhase, progress: aiFullProgress, error: aiCaptureError,
    }, language);
    const canChooseAiModel = enabled && visible && isXVideoPage() && browserCapabilities.extensionDom;
    renderVideoAiModelSelection(menu, {
      model: activeAiModel, available: canChooseAiModel,
      disabled: aiModelSetup.checking || aiModelSetup.downloading
        || (isAiFullActive() && aiFullPhase !== 'ready'),
    }, language);
    if (isXVideoPage()) {
      const original = readCurrentCaptionText(findCaptionContainer());
      const source = isAiFullActive() && aiCues.length > 0 ? (aiSubtitleSession.isRestored ? 'cache' : 'ai')
        : pretranslationTrackKey.startsWith('x:') && pretranslationCues.length > 0 ? 'native' : 'none';
      renderVideoSourceStatus(menu, {
        enabled: enabled && visible, source,
        cueCount: source === 'none' ? 0 : pretranslationCues.length,
        checking: aiSubtitleSession.isRestoring,
        generating: isAiFullActive() && aiFullPhase !== 'ready',
        translationFailed: canTranslateVideo() && videoTranslator.hasFailure(progressiveCue?.text || original),
        canRegenerate: enabled && visible && aiCues.length > 0 && aiFullPhase === 'ready',
        canChooseModel: canChooseAiModel,
      }, language);
    }
    const nativeHint = menu.querySelector<HTMLElement>('[data-native-fullscreen-hint]');
    if (nativeHint) nativeHint.hidden = !isYouTubeVideoPage() || !supportsNativeVideoFullscreen(observedVideo) || !enabled || !visible;
    playerBinding?.syncMenuHost();
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
    capturedSubtitleTracks.set(key, entry);
    if (canTranslateVideo()) {
      setPretranslationTrack(key, entry);
      scheduleUpdate();
    }
  };

  const downloads = createVideoSubtitleDownloads({
    config, document, location: window.location, request: (input, init) => fetch(input, init), isX: isXVideoPage, isDisposed: () => destroyed,
    isAiActive: isAiFullActive,
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
    remember: entry => { const key = getTimedTextCacheKey(entry.url); capturedSubtitleTracks.set(key, entry);
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
        && (!isAiFullActive() || (regenerating && aiFullPhase === 'ready'))
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
    restoreCache: restoreCachedAiSubtitles, invalidateCache: () => aiSubtitleSession.invalidate(),
    setRegenerating: regenerate => { regenerateAiRequested = regenerate; },
    ensureEnabled: () => persistVideoConfig({videoTranslationEnabled: true, videoSubtitleVisible: true}),
    supportsLocal: () => browserCapabilities.extensionDom, setError: message => { aiCaptureError = message; },
    canSelect: () => !isAiFullActive() || aiFullPhase === 'ready',
  });
  const selectMenuMode = (mode: VideoMenuMode) => {
    if (mode === 'off') {
      if (!config.videoTranslationEnabled) return;
      persistVideoConfig({ videoTranslationEnabled: false });
      if (isAiFullActive()) {
        stopFullAiSubtitleGeneration();
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
    const target = event.target.closest<HTMLElement>('[data-action], [data-mode], [data-model-choice], [data-subtitle-order]');
    if (!target || !menu.contains(target) || (target instanceof HTMLButtonElement && target.disabled)) return;

    event.preventDefault();
    event.stopPropagation();

    if (handleVideoMenuDisclosure(menu, target.dataset.action)) return;
    if (target.dataset.action === 'show-reading-original') {selectMenuMode('bilingual'); return;}
    if (reading.handleAction(target.dataset.action)) return;

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
    if (target.dataset.subtitleOrder === 'original-first' || target.dataset.subtitleOrder === 'translation-first') {
      persistVideoConfig({videoSubtitleAppearance: {...config.videoSubtitleAppearance, bilingualOrder: target.dataset.subtitleOrder}});
      return;
    }
    if (target.dataset.mode) {
      selectMenuMode(target.dataset.mode as VideoMenuMode);
      return;
    }
    if (target.dataset.action === 'open-sentence-learning') {
      if (!canReadVideo()) selectMenuMode('bilingual');
      ensureNativeCaptions(); ensurePretranslationTrack(); closeMenu(); void openSentenceLearning().catch(() => closeSentenceLearning()); return;
    }
    if (target.dataset.action === 'close-menu') {
      closeMenu();
      buttonElement?.focus({preventScroll: true});
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
      if (isAiFullActive()) {
        stopFullAiSubtitleGeneration();
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
      // 新一次打开回到主要操作；只重置自有正文，不滚动网页，状态刷新/旋转保留原位置。
      const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body');
      if (body) body.scrollTop = 0;
      syncVideoPlayerMenuLayout(menu);
      // 这是用户明确打开菜单的初始焦点；极矮态不能把焦点交给已隔离的正文。
      const initialFocus = menu.dataset.viewportState === 'close-only' ? '[data-action="close-menu"]' : '[data-mode][aria-checked="true"]';
      const control = menu.querySelector<HTMLButtonElement>(initialFocus);
      control?.focus({preventScroll: true});
      revealVideoMenuBodyControl(menu, control);
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
    // 全屏 Escape 属于浏览器；菜单可以同时收尾，但不能阻止退出全屏。
    if (!document.fullscreenElement) event.preventDefault();
    event.stopPropagation();
    // 导出/模型确认先退回原菜单，再按一次才关闭整个菜单。
    if (menuElement.dataset.view === 'export-prompt') { downloads.cancel(); return; }
    if (menuElement.dataset.view === 'main' && closeVideoMenuDisclosure(menuElement)) return;
    if (menuElement && !menuElement.hidden && isVideoModelPromptOpen(menuElement)) {
      aiModelMenu.finish(menuElement, false);
    } else if (menuElement.dataset.panel === 'tools') {
      setVideoMenuToolsOpen(menuElement, false);
      const destination = menuElement.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]');
      if (destination && !destination.hidden) destination.focus();
      else menuElement.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
    } else { closeMenu(); buttonElement?.focus({preventScroll: true}); }
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
            writeVideoCaptionText(nextOverlay, shown);
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
    writeVideoCaptionText(overlay, '');
    if (container.id === VIDEO_AI_CAPTION_CONTAINER_ID || isYouTubeVideoPage()) {
      const player = playerLocator.getTarget()?.player || (isYouTubeVideoPage() ? findVideoPlayer() : null);
      if (player) {
        reading.renderCaption(player, container, isXVideoPage() ? '' : source, '');
        normalizedCaptionActive = true;
      }
    }
    const cached = videoTranslator.peek(source);
    if (cached !== undefined) {
      lastTranslatedSource = source;
      lastTranslatedText = cached;
      writeVideoCaptionText(overlay, visibleTranslation(cached, source));
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
    const compactYoutube = isYouTubeVideoPage() && (reading.enabled() || player.getBoundingClientRect().width <= 600 || window.matchMedia?.('(pointer: coarse)').matches === true);
    const canTranslate = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false && displayMode !== 'original-only';
    if (!canTranslate) {
      if (config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
        && displayMode === 'original-only' && (container.id === VIDEO_AI_CAPTION_CONTAINER_ID || hasAdjustedTimeline() || compactYoutube)) {
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
        reading.renderCaption(player, container, source, '');
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

    let youtubeSelection: YoutubeCueSelection | undefined;
    if (isYouTubeVideoPage() && !hasAdjustedTimeline()) {
      const cues = pretranslationCues, currentMs = getCurrentVideoTimeMs();
      youtubeSelection = {...selectYoutubeCaptionCue(cues, source, currentMs), cues, source, currentMs};
    }
    if (youtubeSelection?.stale) return resetTranslationState();
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
      reading.renderCaption(player, container, source, visibleTranslation(human, source));
      return;
    }
    if (humanCaptionKey) resetTranslationState();
    if (updateProgressiveCaption(source, overlay, container, youtubeSelection)) return;

    if (progressiveCueKey) {
      clearProgressiveCaption();
      lastSource = '';
      lastTranslatedSource = '';
      lastTranslatedText = '';
      writeVideoCaptionText(overlay, '');
    }

    if (compactYoutube) {
      normalizedCaptionActive = true;
      reading.renderCaption(player, container, source, lastTranslatedSource === source ? visibleTranslation(lastTranslatedText, source) : '');
    }
    if (source === lastSource) {
      syncTranslationOverlayPosition(container);
      const shown = lastTranslatedSource === source ? visibleTranslation(lastTranslatedText, source) : '';
      if (lastTranslatedSource === source && overlay.textContent !== shown) {
        writeVideoCaptionText(overlay, shown);
        syncTranslationOverlayPosition(container);
      }
      return;
    }

    if (isYouTubeVideoPage() && source !== stableCaptionSource) {
      // 新原文一出现就撤下上一句译文及其异步资格；请求仍可合并/预取，
      // 但不能在稳定等待期间让两种语言分别显示前后两句。
      resetTranslationState(true);
      reading.renderCaption(player, container, source, '');
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
    if (document.visibilityState === 'hidden' || !config.on || !config.videoTranslationEnabled || config.videoSubtitleVisible === false
      || !video || video.paused || video.ended || captionFrame !== undefined
      || (!isXVideoPage() && !hasAdjustedTimeline() && !progressiveCue)
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
    if (event.type === 'loadedmetadata') restoreSavedVideoPosition();
    if (isYouTubeVideoPage() && ['seeking', 'emptied', 'ended'].includes(event.type)) resetTranslationState();
    if (isXVideoPage()) syncXVideoCaptionSource();
    if (target.paused || target.ended) stopCaptionClock();
    else startCaptionClock();
    if (['loadedmetadata', 'seeked', 'play', 'ratechange'].includes(event.type)) ensurePretranslationTrack();
    schedulePretranslation(['loadedmetadata', 'seeked', 'play', 'ratechange'].includes(event.type));
    scheduleUpdate();
  };

  const handleVideoVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      stopCaptionClock();
      return;
    }
    // Safari 可能挂起后台页的时钟；回来时重读媒体身份、cue、画幅及菜单位置。
    syncPlayerUi();
    scheduleSubtitleLayout();

  };
  const handlePageShow = () => { syncPlayerUi(); scheduleSubtitleLayout(); };

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
    closeSentenceLearning();
    humanCaptions.clear();
    downloads.cancel();
    clearPretranslationState(false);
  };

  const syncPlayerUi = () => {
    if (destroyed) return;
    const nextVideoPageKey = getVideoPageKey();
    if (nextVideoPageKey !== videoPageKey && !isXVideoPage()) {
      closeSentenceLearning();
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
      stopFullAiSubtitleGeneration();
      clearPretranslationState(true);
      resetTranslationState();
    }
    videoPageKey = nextVideoPageKey;
    if (!canReadVideo()) closeSentenceLearning();
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
      nativeFullscreen.sync();
      return;
    }
    syncPretranslationConfig();
    syncVideoElement();
    nativeFullscreen.sync();
    const learningTarget = playerLocator.getTarget();
    if (learning.isOpen() && (learningTarget ? !learning.syncPlayer(learningTarget.player, learningTarget.video) : !learning.isConnected())) closeSentenceLearning();
    restoreSavedVideoPosition();
    startCaptionClock();
    updatePlayerUiState();
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
    getState: () => ({enabled: !destroyed && config.on && config.videoTranslationEnabled && isSupportedVideoPage(),
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
  window.addEventListener('orientationchange', scheduleSubtitleLayout);
  window.addEventListener('pageshow', handlePageShow);
  window.visualViewport?.addEventListener('resize', scheduleSubtitleLayout);
  window.visualViewport?.addEventListener('scroll', scheduleSubtitleLayout);
  videoTimelineEventNames.forEach((eventName) => document.addEventListener(eventName, handleVideoTimelineEvent, true));
  window.addEventListener('message', handleTimedTextMessage);
  window.addEventListener('message', handleXSubtitleResourceMessage);
  syncPlayerUi();
  uiSyncTimer = window.setInterval(syncPlayerUi, 1000);

  const unsubscribeConfig = subscribeConfig((nextConfig) => {
    reading.syncConfig(nextConfig);
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
    if (!subtitlesEnabled) aiSubtitleSession.invalidate();
    const nextAiModel = normalizeVideoLocalTranscriptionModel(nextConfig.videoLocalModel);
    if (nextAiModel !== activeAiModel || nextConfig.videoSourceLanguage !== activeVideoLanguage) {
      aiSubtitleSession.invalidate();
      if (activeVideoLanguage !== nextConfig.videoSourceLanguage) {
        // 新语言必须重新选择 HLS 字幕资源，不能复用上一语言的 visited 集合或混合时间轴。
        xSubtitleLoader.reset();
        xSubtitleCues = [];
        capturedSubtitleTracks.clear();
        clearPretranslationState(true);
        if (isXVideoPage()) document.dispatchEvent(new CustomEvent(YOUTUBE_BRIDGE_REPLAY_EVENT));
      }
      activeVideoLanguage = nextConfig.videoSourceLanguage;
      const captureWasActive = isAiFullActive();
      activeAiModel = nextAiModel;
      if (captureWasActive) {
        // 模型切换会改变 Worker session；旧模型结果必须立刻作废，不能与
        // 新模型的滑窗混进同一条稳定时间轴。
        stopFullAiSubtitleGeneration();
        aiCues = [];
        setPretranslationTrack('ai:capture', { url: 'ai:capture', cues: [] });
        aiCaptureError = '模型已切换，请重新请求 AI 字幕';
        resetTranslationState();
      }
    }
    syncPretranslationConfig();
    syncPlayerUi();
    updatePlayerUiState();
    karaoke.sync();
    if (observedContainer) {
      applyVideoDisplayState(observedContainer);
      syncTranslationOverlayPosition(observedContainer);
    }
    if (newlyEnabled && isXVideoPage()) void restoreCachedAiSubtitles();
    if (!nextConfig.on || !nextConfig.videoTranslationEnabled || nextConfig.videoSubtitleVisible === false || normalizeVideoSubtitleDisplayMode(nextConfig.videoSubtitleDisplayMode) === 'original-only') {
      humanCaptions.clear();
      if (!nextConfig.on || !nextConfig.videoTranslationEnabled) { downloads.cancel(); aiModelSetup.reset(); }
      if ((!nextConfig.on || !nextConfig.videoTranslationEnabled) && isAiFullActive()) {
        stopFullAiSubtitleGeneration();
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
    reading.destroy();
    learning.destroy();
    learningPlacement.dispose();
    destroyed = true; aiModelSetup.reset(); karaoke.destroy();
    humanCaptions.clear();
    downloads.destroy();
    nativeFullscreen.destroy();
    aiSubtitleSession.dispose();
    aiRequests.dispose();
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
    subtitleLayout.destroy();
    unsubscribeConfig();
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('keydown', handleDocumentKeydown, true);
    document.removeEventListener('visibilitychange', handleVideoVisibilityChange);
    document.removeEventListener('fullscreenchange', scheduleSubtitleLayout);
    window.removeEventListener('resize', scheduleSubtitleLayout);
    window.removeEventListener('orientationchange', scheduleSubtitleLayout);
    window.removeEventListener('pageshow', handlePageShow);
    window.visualViewport?.removeEventListener('resize', scheduleSubtitleLayout);
    window.visualViewport?.removeEventListener('scroll', scheduleSubtitleLayout);
    videoTimelineEventNames.forEach((eventName) => document.removeEventListener(eventName, handleVideoTimelineEvent, true));
    window.removeEventListener('message', handleTimedTextMessage);
    window.removeEventListener('message', handleXSubtitleResourceMessage);
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
