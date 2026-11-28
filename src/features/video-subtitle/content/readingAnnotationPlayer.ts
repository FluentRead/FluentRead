/**
 * @file src/features/video-subtitle/content/readingAnnotationPlayer.ts
 * 文件职责：拥有播放器当前原句的读音显示、即将到来字幕预取、菜单交互与配置切换生命周期。
 * 主要内容：装配可共享的读音控制器和本地请求端，关闭时跳过语言解析，按轨道标识、来源 URL 与语言偏好缓存语言元数据，换句不重复扫描页面脚本并按需预取后续 2–3 条字幕；为完整句学习提供始终可用的原轨上下文与共享读音会话，更新稳定读音节点，仅在读音状态变化时同步菜单；页面重新可见时恢复暂停画面的读音，仅译文时保留偏好并就近提供双语入口，在显示模式切换时请求宿主重置当前句翻译资格，隐藏及销毁时清理自有任务与监听。
 * 模块边界：只操作视频 feature 自有 UI 并通过既有入口读写共享配置；播放器定位、翻译状态与字幕布局由宿主注入，原轨上下文不依赖读音开关，不访问词典、创建 Worker 或管理视频采集。
 */
import type {Config} from '@/src/core/config/model';
import {config, requestConfigPatch} from '@/src/services/config/store';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {createVideoReadingController} from './readingAnnotationController';
import {annotateVideoReading} from './readingAnnotationClient';
import type {VideoReadingAnnotationSession} from './readingAnnotationSession';
import {isOriginalTimedTextUrl, isYouTubeVideoPage, normalizeVideoSubtitleDisplayMode, renderHumanVideoCaption, renderVideoReadingAnnotation, videoUi} from './ui';
import {chooseYoutubeCaptionTrackForLocation, type VideoSubtitleCue} from './youtubeSubtitleData';

interface ReadingSourceContext {key: string; captured?: {url: string}; cues: VideoSubtitleCue[]}

interface ReadingPlayerPorts {
  getPlayer(): HTMLElement | null;
  canRead(): boolean;
  getSourceContext(): ReadingSourceContext;
  nativeSync(): void;
  scheduleLayout(): void;
  updateMenu(): void;
  updateCaption(): void;
  resetCaption(): void;
  session?: VideoReadingAnnotationSession;
}

const PREFETCH_COUNT = 3;
const normalizeCaptionText = (text: string) => text.replace(/[\s\u3000]+/gu, ' ').trim();

export function createVideoReadingPlayer(ports: ReadingPlayerPorts) {
  let languageKey = '', sourceLanguage = '';
  let lastPrefetchedSource = '';
  let lastMenuStatus = 'idle';
  let displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  const enabled = () => browserCapabilities.extensionDom && config.videoSubtitleAppearance.readingAnnotation === true;
  const controller = createVideoReadingController(annotateVideoReading, state => {
    const player = ports.getPlayer();
    if (player && renderVideoReadingAnnotation(player, state.result?.text || '', state.language)) ports.scheduleLayout();
    ports.nativeSync();
    if (state.status !== lastMenuStatus) {
      lastMenuStatus = state.status;
      ports.updateMenu();
    }
  }, {session: ports.session});
  // 播放器读音与完整句学习读取同一原轨元数据，不能把自动翻译轨当作原句学习材料。
  const getLearningCues = () => {
    const {captured, cues} = ports.getSourceContext();
    return isYouTubeVideoPage() && captured && !isOriginalTimedTextUrl(captured.url) ? [] : cues;
  };
  const resolveContextAndLanguage = () => {
    const context = ports.getSourceContext();
    const nextKey = JSON.stringify([context.key, context.captured?.url || '', config.from, config.videoSourceLanguage, window.location.href]);
    if (nextKey === languageKey) return {context, language: sourceLanguage};
    languageKey = nextKey;
    const {key, captured} = context;
    if (isYouTubeVideoPage()) {
      sourceLanguage = new URL(captured?.url || window.location.href).searchParams.get('lang')
        || chooseYoutubeCaptionTrackForLocation(document, window.location, config.from)?.languageCode || config.from;
    } else {
      const native = key.startsWith('x:native:') ? key.slice('x:native:'.length) : '';
      sourceLanguage = native && native !== 'original' ? native : config.videoSourceLanguage;
    }
    return {context, language: sourceLanguage};
  };
  const getSourceLanguage = () => resolveContextAndLanguage().language;
  const canAnnotateNow = () => enabled() && ports.canRead()
    && normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) !== 'translation-only'
    && document.visibilityState !== 'hidden';
  const scheduleUpcomingPrefetch = (upcoming: readonly string[], language: string) => {
    controller.retainPrefetches(upcoming, language);
    if (upcoming.length) controller.prefetch(upcoming, language);
  };
  const prefetchUpcoming = (cues: readonly VideoSubtitleCue[], currentMs: number): void => {
    if (!canAnnotateNow() || !cues.length || !Number.isFinite(currentMs)) return;
    const upcoming: string[] = [];
    for (const cue of cues) {
      if (cue.startMs > currentMs) {
        upcoming.push(cue.text);
        if (upcoming.length >= PREFETCH_COUNT) break;
      }
    }
    scheduleUpcomingPrefetch(upcoming, getSourceLanguage());
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { lastPrefetchedSource = ''; controller.clear(); }
    else if (canAnnotateNow()) ports.updateCaption();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    enabled,
    session: controller.session,
    sourceContext: {getCues: getLearningCues, getLanguage: getSourceLanguage},
    get state() {return controller.state;},
    clear() {lastPrefetchedSource = ''; controller.clear();},
    reset() {languageKey = ''; sourceLanguage = ''; lastPrefetchedSource = ''; controller.reset();},
    destroy() {document.removeEventListener('visibilitychange', onVisibility); controller.destroy();},
    prefetchUpcoming,
    renderCaption(player: HTMLElement, container: HTMLElement, source: string, translation: string): void {
      renderHumanVideoCaption(player, container, source, translation);
      if (!source || !canAnnotateNow()) {lastPrefetchedSource = ''; controller.clear(); return;}
      // DOM 回退可逐帧刷新；大型 YouTube 脚本中的语言元数据只在实际上下文变化后解析。
      const {context, language} = resolveContextAndLanguage();
      controller.sync(source, language, true);
      const normalized = normalizeCaptionText(source);
      if (normalized && normalized !== lastPrefetchedSource) {
        lastPrefetchedSource = normalized;
        if (context.cues.length > 1) {
          const activeIndex = context.cues.findIndex(cue => normalizeCaptionText(cue.text) === normalized);
          if (activeIndex >= 0) {
            const upcoming = context.cues.slice(activeIndex + 1, activeIndex + 1 + PREFETCH_COUNT).map(cue => cue.text);
            scheduleUpcomingPrefetch(upcoming, language);
          }
        }
      }
    },
    syncMenu(menu: HTMLElement, subtitlesEnabled: boolean, selectedMode: string): void {
      const readingEnabled = enabled() && subtitlesEnabled;
      const toggle = menu.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]');
      if (toggle) {
        const checked = String(config.videoSubtitleAppearance.readingAnnotation === true);
        if (toggle.getAttribute('aria-checked') !== checked) toggle.setAttribute('aria-checked', checked);
        toggle.disabled = !browserCapabilities.extensionDom || !subtitlesEnabled;
        const label = videoUi('video.readingAnnotation.label');
        if (toggle.getAttribute('aria-label') !== label) toggle.setAttribute('aria-label', label);
      }
      const status = menu.querySelector<HTMLElement>('[data-reading-status]');
      if (status) {
        const text = !browserCapabilities.extensionDom ? videoUi('video.readingAnnotation.unavailable')
          : !readingEnabled ? ''
            : selectedMode === 'translation-only' ? videoUi('video.readingAnnotation.originalRequired')
              : controller.state.status === 'error' ? videoUi('video.readingAnnotation.error') : '';
        if (status.textContent !== text) status.textContent = text;
        if (status.hidden !== !text) status.hidden = !text;
      }
      const retry = menu.querySelector<HTMLButtonElement>('[data-action="retry-reading-annotation"]');
      if (retry) retry.hidden = !readingEnabled || selectedMode === 'translation-only' || controller.state.status !== 'error';
      const bilingual = menu.querySelector<HTMLButtonElement>('[data-reading-bilingual]');
      if (bilingual) {
        bilingual.hidden = !readingEnabled || selectedMode !== 'translation-only';
        bilingual.disabled = !subtitlesEnabled;
      }
    },
    handleAction(action: string | undefined): boolean {
      if (action === 'toggle-reading-annotation') {
        void requestConfigPatch({videoSubtitleAppearance: {...config.videoSubtitleAppearance, readingAnnotation: !config.videoSubtitleAppearance.readingAnnotation}}, sendRuntimeMessage)
          .catch(error => {console.warn('[FluentRead] 视频字幕设置保存失败', error);});
        return true;
      }
      if (action === 'retry-reading-annotation') {controller.retry(); ports.updateCaption(); return true;}
      return false;
    },
    syncConfig(nextConfig: Config): void {
      const nextMode = normalizeVideoSubtitleDisplayMode(nextConfig.videoSubtitleDisplayMode);
      if (nextMode !== displayMode) {displayMode = nextMode; ports.resetCaption();}
      if (!browserCapabilities.extensionDom || !nextConfig.videoSubtitleAppearance.readingAnnotation || !nextConfig.on || !nextConfig.videoTranslationEnabled || nextConfig.videoSubtitleVisible === false
        || nextMode === 'translation-only') controller.clear();
    },
  };
}
