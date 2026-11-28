/**
 * @file src/features/video-subtitle/content/platformRuntime.ts
 * 文件职责：在会议、B 站（普通/分 P/番剧）、Udemy、edX、Coursera、Disney+、Netflix、Prime Video、TED 与 Vimeo 网页中挂载隔离的双语字幕，复用现有视频配置及翻译缓存。
 * 课程字幕：复用 YouTube/X 的品牌图标与紧凑菜单，按原生按钮可见内容对齐并做安全视口翻转与 Popover 能力降级；B 站绑定主播放器，推荐预览不能抢占；完整原文轨道动态读取当前路由，在空/错误态优雅回退到 TextTrack 与原生字幕节点；按服务档案动态选择预取窗口，并在片头静默、空档与长句期间持续预取。
 * 主要内容：穿透开放 Shadow DOM 观察原生字幕与视频，O(1) 优先读取 activeCues、TED 演讲稿当前句并通过 seeked/timeupdate/cuechange 即时同步；为主流流媒体提供安全控制栏挂载入口，同步命中翻译缓存消除空闪与二次排版，处理独立读音、失败重试、跨浏览器全屏、可视视口滚动跟踪以及后台页/暂停态轮询节流。
 * 模块边界：只通过注入端口读取配置、翻译和保存设置；布局记录与事件监听仅属于当前挂载，卸载与切换完整释放观察器、帧与监听器，通过独立音轨适配器支持 B 站本地识别，不修改网站播放器实现。
 */
import type {Config} from '@/src/core/config/model';
import {translate, hasUiLanguageBundle} from '@/src/core/i18n';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getFullscreenElement, onFullscreenChange} from '@/src/platform/dom/fullscreen';
import {getSafeVisualViewportRect, observeVisualViewport, type VisualViewportRect} from '@/src/platform/dom/visualViewport';
import {hasSelectorDeep, querySelectorAllDeep} from '@/src/shared/dom/shadowQuery';
import {getVideoSubtitleAppearanceCssVars} from '@/src/core/config/videoSubtitleAppearance';
import {selectVideoSubtitleCueAtOffset, getVideoTranslationConfigFingerprint, normalizeVideoCaptionText} from './subtitleLogic';
import {VIDEO_COURSE_PLATFORMS, type VideoCoursePlatform} from '@/src/core/config/videoCourse';
import {CourseCaptionSource, type CourseCaptionSourcePorts} from './courseCaptionSource';
import {getCourseCaptionRequest, hasBilibiliCaptionHint} from './courseCaptionData';
import {requestBilibiliCaptionManifest} from './bilibiliCaptionBridge';
import {cuesToSrt} from './youtubeSubtitleData';
import {VideoTranslationCache} from './translationCache';
import {fitVideoSubtitleFontSize} from './subtitleLayout';
import {setSubtitlePanelScrollable, resetSubtitlePanelLayout} from './subtitleControlLayout';
import {isVideoSubtitleInTargetLanguage} from './subtitleLanguage';
import {chooseTargetHumanCaptionTrack, getCaptionPlatform, isMeetingCaptionPlatform, PLATFORM_CAPTION_SELECTORS, findCaptionEnableButton, findTeamsCaptionMenuStep, captionLanguageMatch} from './platforms';
import {findPlatformControlMount, findPlatformPlayerRoot, hasStreamingControlBar, readPlatformTranscriptCue} from './platformProfiles';
import {VideoReadingAnnotationSession} from './readingAnnotationSession';
import {annotateVideoReading} from './readingAnnotationClient';
import {createVideoPlayerMenu, renderVideoMenuMode, renderVideoSubtitleOrder, renderVideoSubtitleTiming, handleVideoMenuNavigation, handleVideoMenuDisclosure, closeVideoMenuDisclosure, resetVideoMenuDisclosures, setVideoMenuToolsOpen} from './playerMenu';
import {createVideoSubtitleStyle, refreshVideoUiText, VIDEO_TRANSLATION_BUTTON_ID, VIDEO_TRANSLATION_MENU_ID, VIDEO_TRANSLATION_ACTIVE_CLASS} from './ui';
import {getVideoPretranslationWindowMs, getVideoServiceLabel} from './serviceProfile';
import {createCourseSubtitleTools} from './courseSubtitleTools';
import type {SubtitleExportFormat} from './subtitleExport';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import type {BilibiliAiSource} from './bilibiliAiSource';
import {clearVideoSubtitleModeNotice, handleVideoSubtitleModeShortcutKeydown, notifyVideoSubtitleModeSwitch} from './modeShortcut';

interface PlatformCaptionPorts {
    document: Document;
    window: Window;
    config: Config;
    subscribe(listener: (config: Config) => void): () => void;
    translate(text: string, signal: AbortSignal, sourceLanguage?: string): Promise<string>;
    patch(patch: Partial<Config>): void;
    label(text: string): string;
    download?(srt: string, language: string, cues?: readonly VideoSubtitleCue[], format?: SubtitleExportFormat): void;
    createBilibiliAi?(getVideo: () => HTMLVideoElement | null, changed: () => void): BilibiliAiSource;
    iconUrl?: string;
    learningStyleUrl?: string;
    openSettings?(): void;
    captionSource?: Partial<Omit<CourseCaptionSourcePorts, 'base' | 'changed'>>;
}

const CAPTION_DISABLE_LABEL = /^(?:(?:turn off|hide|disable)\s+(?:closed\s+|live\s+)?(?:captions|subtitles)|(?:关闭|隐藏|關閉|隱藏)(?:实时|即時|隐藏式|隱藏式)?字幕|(?:ライブ)?字幕を(?:オフにする|オフ|無効にする|非表示にする|非表示)|(?:실시간\s*)?자막\s*(?:끄기|숨기기)|(?:d[ée]sactiver|masquer)\s+les\s+sous-titres(?:\s+en\s+direct)?|(?:live[- ]?)?untertitel\s+(?:deaktivieren|ausschalten|ausblenden)|(?:desactivar|ocultar)\s+(?:los\s+)?subt[ií]tulos(?:\s+en\s+(?:directo|vivo))?|(?:desativar|ocultar)\s+(?:as\s+)?legendas(?:\s+ao\s+vivo)?)/i;

function formatTrackCues(cues: ArrayLike<TextTrackCue>): string {
    return Array.from(cues)
        .map(cue => (cue as VTTCue).text || '')
        .join(' ')
        .replace(/<[^>]*>/g, '')
        .trim();
}

function trackTextAt(track: TextTrack | null, time: number, offsetMs = 0): string {
    if (!track || !Number.isFinite(time)) return '';
    if (offsetMs === 0 && track.activeCues?.length) {
        return formatTrackCues(track.activeCues);
    }
    if (!track.cues?.length) return '';
    return formatTrackCues(Array.from(track.cues).filter(cue => time >= cue.startTime && time < cue.endTime));
}

function setStyleIfChanged(style: CSSStyleDeclaration, property: string, value: string, priority = ''): void {
    if (style.getPropertyValue(property) !== value || style.getPropertyPriority(property) !== priority) {
        style.setProperty(property, value, priority);
    }
}

const OWNED_SELECTOR = '[data-fluent-read-owned="true"], [data-fluent-read-ui], .fluent-read-video-ui';

function queryLightThenDeep<T extends Element>(root: ParentNode, selector: string): T[] {
    const light = Array.from(root.querySelectorAll<T>(selector))
        .filter(node => !node.closest(OWNED_SELECTOR));
    return light.length ? light : querySelectorAllDeep<T>(root, selector);
}

/** 生命周期完全属于当前内容 feature；配置停用时取消请求并恢复本功能修改的原生显示。 */
export function mountPlatformCaptions(ports: PlatformCaptionPorts): () => void {
    const {document, window, config} = ports;
    const platform = getCaptionPlatform(window.location);
    if (!platform) return () => undefined;
    const meeting = isMeetingCaptionPlatform(platform);
    const autoCourse = VIDEO_COURSE_PLATFORMS.includes(platform as VideoCoursePlatform) ? platform as VideoCoursePlatform : null;
    const coursera = import.meta.env.BROWSER !== 'userscript' && platform === 'coursera';
    const course = coursera ? 'coursera' : autoCourse;
    const timeline = new CourseCaptionSource({
        base: () => new URL(window.location.href), fetch: ports.captionSource?.fetch || ((input, init) => fetch(input, init)),
        manifest: ports.captionSource?.manifest || ((part, signal) => requestBilibiliCaptionManifest(window, part, signal)),
        resources: ports.captionSource?.resources || (() => window.performance.getEntriesByType('resource').map(entry => entry.name)),
        changed: () => schedule(),
    });
    const ai = course === 'bilibili' ? ports.createBilibiliAi?.(() => video, () => schedule()) || null : null;
    let usingAiCues = false;
    const cache = new VideoTranslationCache((text, signal) => isVideoSubtitleInTargetLanguage(text, config.to)
        ? Promise.resolve(text) : usingAiCues ? ports.translate(text, signal, config.videoSourceLanguage) : ports.translate(text, signal));
    const activeCues = () => timeline.status === 'ready' ? timeline.cues : ai?.cues || [];
    const completeTimeline = () => timeline.status === 'ready' || ai?.status === 'ready';
    const readings = new VideoReadingAnnotationSession(annotateVideoReading);
    const trackModes = new Map<TextTrack, {previous: TextTrackMode; applied: TextTrackMode}>();
    const captionVisibility = new Map<HTMLElement, {value: string; priority: string}>();
    let clickedButtons = new WeakSet<HTMLElement>();
    const menuButtons = new Set<HTMLElement>();
    let autoButton: HTMLElement | null = null;
    let host: HTMLElement | null = null;
    let sourceLine: HTMLElement | null = null;
    let readingLine: HTMLElement | null = null;
    let translatedLine: HTMLElement | null = null;
    let toolsBar: HTMLElement | null = null;
    let retry: HTMLButtonElement | null = null;
    let mode: HTMLSelectElement | null = null;
    let generation = 0;
    let disposed = false;
    let signature = '';
    const routeHref = () => {
        const url = new URL(window.location.href);
        if (course) url.hash = '';
        return url.href;
    };
    let route = routeHref();
    let video: HTMLVideoElement | null = null;
    let sourceTrack: TextTrack | null = null;
    let targetTrack: TextTrack | null = null;
    let mediaKey = '';
    let mediaEpoch = 0;
    let fingerprint = getVideoTranslationConfigFingerprint(config);
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let layoutInputs: {width: number; height: number; maximumHeight: number; fontSize: number; fontFamily: string; lineSpacing: string} | null = null;
    let fittedInputs: readonly unknown[] | null = null;
    let readingSignature = '';
    let readingGeneration = 0;
    let lastPlayedVideo: HTMLVideoElement | null = null;
    let manualEnabled: boolean | null = null;
    let courseIdentity = '';
    let controlsHost: HTMLElement | null = null;
    let courseButton: HTMLButtonElement | null = null;
    let courseMenu: HTMLElement | null = null;
    let courseStatus: HTMLElement | null = null;
    let courseAuto: HTMLButtonElement | null = null;
    let courseRetry: HTMLButtonElement | null = null;
    let courseDownload: HTMLButtonElement | null = null;
    let menuLocale = '';
    let lastMenuStateKey = '';
    let safeViewport: VisualViewportRect | null = null;
    let pollPaused = false;
    let boundVideo: HTMLVideoElement | null = null;
    const boundTracks = new Set<TextTrack>();
    let scrollFrame: number | undefined;
    const readSafeViewport = (): VisualViewportRect => {
        if (!safeViewport) safeViewport = getSafeVisualViewportRect(window);
        return safeViewport;
    };
    const courseText = (key: string) => translate(`video.course.${key}`, config.uiLanguage);
    const captionsEnabled = () => config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
        && (!course || (manualEnabled ?? (autoCourse ? config.videoCourseAutoStart[autoCourse] : false)));

    const streamingControls = hasStreamingControlBar(platform);
    const hasControlBar = Boolean(course || streamingControls);
    const playerRoot = () => findPlatformPlayerRoot(video, platform);
    const courseTools = import.meta.env.BROWSER !== 'userscript' && course && ports.download ? createCourseSubtitleTools({
        platform: course, document, location: window.location, config, subscribe: ports.subscribe, learningStyleUrl: ports.learningStyleUrl,
        readTarget: () => {const player = playerRoot();return player && video ? {player, video} : null;},
        readCompleteTrack: () => {
            if (!video || mediaKey !== `${routeHref()}:${video.currentSrc || video.getAttribute('src') || ''}` ||
                !captionsEnabled() || !completeTimeline()) return null;
            return {
                cues: activeCues(), languageCode: usingAiCues ? 'ai' : timeline.language || 'original',
                sourceLanguage: (usingAiCues ? config.videoSourceLanguage : timeline.language) || config.from,
            };
        },
        readIdentity: () => `${mediaEpoch}:${courseIdentity}:${timeline.language}:${usingAiCues}:${fingerprint}`,
        translate: (text, signal, language) => isVideoSubtitleInTargetLanguage(text, config.to)
            ? Promise.resolve(text) : ports.translate(text, signal, language),
        peek: source => cache.peek(source),
        save: ports.download, updateMenu: () => syncCourseControls(),
    }) : undefined;
    const positionCourseMenu = () => {
        if (!courseMenu || courseMenu.hidden || !courseButton) return;
        const viewport = readSafeViewport();
        const button = courseButton.getBoundingClientRect?.();
        const bounds = courseMenu.getBoundingClientRect?.();
        const width = Math.max(120, Math.min(280, viewport.width - 16)), height = bounds?.height || 150;
        const left = Math.max(viewport.left + 8, Math.min((button?.right || (viewport.left + width)) - width, viewport.right - width - 8));
        const aboveTop = (button?.top ?? viewport.bottom) - height - 8;
        const belowTop = (button?.bottom ?? viewport.top) + 8;
        const top = aboveTop >= viewport.top + 8
            ? aboveTop
            : belowTop + height <= viewport.bottom - 8
                ? belowTop
                : Math.max(viewport.top + 8, Math.min(aboveTop, viewport.bottom - height - 8));
        setStyleIfChanged(courseMenu.style, 'width', `${width}px`, 'important');
        setStyleIfChanged(courseMenu.style, 'max-width', `${width}px`, 'important');
        setStyleIfChanged(courseMenu.style, 'left', `${left}px`, 'important');
        setStyleIfChanged(courseMenu.style, 'top', `${top}px`, 'important');
        setStyleIfChanged(courseMenu.style, 'max-height', `${Math.max(80, viewport.height - 16)}px`, 'important');
    };
    const setCourseMenuOpen = (open: boolean) => {
        if (!courseMenu || !courseButton) return;
        if (open) {
            courseMenu.hidden = false;
            if (typeof courseMenu.showPopover === 'function') {
                try { courseMenu.showPopover(); } catch { /* 不支持或已在顶层时保留 fixed 展示。 */ }
            }
            syncCourseControls();
            courseMenu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus({preventScroll: true});
        } else {
            courseTools?.cancelExports();
            if (courseMenu.isConnected && typeof courseMenu.hidePopover === 'function') {
                try {
                    if (courseMenu.matches(':popover-open')) courseMenu.hidePopover();
                } catch { /* 旧浏览器不支持 :popover-open 或节点不在顶层。 */ }
            }
            resetVideoMenuDisclosures(courseMenu);
            setVideoMenuToolsOpen(courseMenu, false);
            courseMenu.hidden = true;
        }
        courseButton.setAttribute('aria-expanded', String(open));
    };
    const removeCourseControls = () => {
        courseTools?.cancelExports();
        controlsHost?.remove(); controlsHost = null; courseMenu = null; courseButton = null;
        courseStatus = null; courseAuto = null; courseRetry = null; courseDownload = null; menuLocale = ''; lastMenuStateKey = '';
    };
    const syncCourseControls = () => {
        const root = playerRoot();
        if (!hasControlBar || !root || !config.on || !config.videoTranslationEnabled) { removeCourseControls(); return; }
        const mountTarget = findPlatformControlMount(root, platform, video, window, Boolean(course));
        if (!mountTarget) { removeCourseControls(); return; }
        const {controls, anchor, nativeFallback} = mountTarget;
        if (!controlsHost) {
            controlsHost = document.createElement('span');
            controlsHost.id = course ? 'fluent-read-course-controls' : 'fluent-read-platform-controls';
            controlsHost.setAttribute('data-fluent-read-owned', 'true'); controlsHost.setAttribute('translate', 'no');
            const shadow = controlsHost.attachShadow({mode: 'open'});
            // 与 YouTube/X 共用品牌图标、菜单构造器及整份样式，课程与流媒体只适配来源与可用动作。
            const style = document.createElement('style');
            style.textContent = `:host{all:initial;display:inline-flex;position:relative;flex:0 0 auto;align-self:auto;z-index:1000}
                #${VIDEO_TRANSLATION_MENU_ID}[data-original-download-only] .fluent-read-video-menu-downloads{grid-template-columns:minmax(0,1fr)!important}
                #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-course-auto{justify-content:space-between!important;gap:12px!important}
                #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch{width:30px!important;height:18px!important;min-height:18px!important;border-radius:9px!important;position:relative!important;background:var(--fr-video-menu-control-hover)!important;padding:0!important}
                #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch::after{content:'';position:absolute;width:12px;height:12px;top:3px;left:3px;border-radius:50%;background:var(--fr-video-menu-text)}
                #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch[aria-checked="true"]{background:var(--fr-video-menu-brand)!important}
                #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch[aria-checked="true"]::after{left:15px}
                #${VIDEO_TRANSLATION_MENU_ID} [hidden]{display:none!important}`;
            courseButton = document.createElement('button'); courseButton.type = 'button';
            courseButton.id = VIDEO_TRANSLATION_BUTTON_ID;
            courseButton.className = 'fluent-read-video-subtitle-button fluent-read-video-ui notranslate';
            courseButton.setAttribute('aria-haspopup', 'menu'); courseButton.setAttribute('aria-expanded', 'false');
            courseButton.setAttribute('aria-controls', VIDEO_TRANSLATION_MENU_ID);
            const icon = document.createElement('img'); icon.className = 'fluent-read-video-subtitle-button-icon'; icon.alt = ''; icon.setAttribute('aria-hidden', 'true');
            if (ports.iconUrl) icon.src = ports.iconUrl;
            courseButton.appendChild(icon);
            courseMenu = createVideoPlayerMenu(config.uiLanguage, true);
            courseMenu.dataset.course = course || platform;
            courseMenu.toggleAttribute('data-original-download-only', !courseTools);
            if (typeof courseMenu.showPopover === 'function') courseMenu.setAttribute('popover', 'manual');
            courseMenu.querySelector('[data-subtitle-order-hint]')!.remove();
            // 课程与流媒体菜单保留读音开关，不在悬停时展开下载体积、语言清单和示例说明。
            courseMenu.querySelector('[data-reading-help]')!.removeAttribute('popover');
            courseMenu.querySelector('[data-action="toggle-reading-annotation"]')!.removeAttribute('aria-describedby');
            const unavailable = ['.fluent-read-video-menu-primary-ai', '.fluent-read-video-menu-secondary-ai',
                '[data-action="select-ai-model"]', '[data-action="regenerate-ai-subtitle"]', '.fluent-read-video-model-prompt'];
            if (!courseTools) unavailable.push('[data-action="open-sentence-learning"]', '[data-subtitle-format]',
                '[data-action="download-translated-subtitles"]', '[data-action="download-bilingual-subtitles"]');
            for (const selector of unavailable) {
                courseMenu.querySelector(selector)?.remove();
            }
            for (const [property, value] of [['position', 'fixed'], ['inset', 'auto'], ['margin', '0']]) courseMenu.style.setProperty(property, value, 'important');
            const source = courseMenu.querySelector<HTMLElement>('.fluent-read-video-menu-source')!;
            courseStatus = source.querySelector<HTMLElement>('[data-source-status]')!;
            courseStatus.setAttribute('role', 'status');
            source.querySelector('[data-source-hint]')!.remove();
            courseRetry = document.createElement('button'); courseRetry.type = 'button'; courseRetry.dataset.action = 'retry-course-source';
            courseRetry.className = 'fluent-read-video-menu-secondary'; courseRetry.setAttribute('role', 'menuitem');
            source.querySelector('.fluent-read-video-menu-source-actions')!.appendChild(courseRetry);
            const autoRow = document.createElement('div'); autoRow.className = 'fluent-read-video-menu-row fluent-read-video-menu-course-auto';
            if (!autoCourse) autoRow.hidden = true;
            const autoLabel = document.createElement('span'); autoLabel.className = 'fluent-read-video-menu-row-label'; autoLabel.dataset.courseAutoLabel = '';
            courseAuto = document.createElement('button'); courseAuto.type = 'button'; courseAuto.className = 'fluent-read-video-menu-switch';
            courseAuto.dataset.action = 'toggle-course-auto'; courseAuto.setAttribute('role', 'switch');
            autoRow.append(autoLabel, courseAuto);
            courseMenu.querySelector('.fluent-read-video-menu-tools')!.appendChild(autoRow);
            if (ai) {
                const generate = document.createElement('button'); generate.type = 'button';
                generate.dataset.action = 'generate-bilibili-ai'; generate.setAttribute('role', 'menuitem');
                generate.className = 'fluent-read-video-menu-secondary';
                courseMenu.querySelector('.fluent-read-video-menu-tools')!.appendChild(generate);
            }
            courseDownload = courseMenu.querySelector<HTMLButtonElement>('[data-action="download-subtitles"]')!;
            courseButton.addEventListener('click', event => { event.stopPropagation(); setCourseMenuOpen(Boolean(courseMenu!.hidden)); });
            courseMenu.addEventListener('click', event => {
                const target = (event.target as Element).closest<HTMLButtonElement>('button');
                if (!target || target.disabled) return;
                const action = target.dataset.action;
                // B 站开放的 Shadow DOM 可被页面派发合成点击；音轨授权只接受浏览器的真实事件。
                if (ai && !event.isTrusted && (target.dataset.mode || action === 'toggle-course-auto' || action === 'generate-bilibili-ai')) return;
                if (target.dataset.mode) {
                    if (course) {
                        manualEnabled = target.dataset.mode !== 'off';
                        if (manualEnabled) ports.patch({videoSubtitleVisible: true, videoSubtitleDisplayMode: target.dataset.mode as Config['videoSubtitleDisplayMode']});
                    } else if (target.dataset.mode === 'off') {
                        ports.patch({videoSubtitleVisible: false});
                    } else {
                        ports.patch({videoSubtitleVisible: true, videoSubtitleDisplayMode: target.dataset.mode as Config['videoSubtitleDisplayMode']});
                    }
                    sync();
                } else if (target.dataset.subtitleOrder) {
                    ports.patch({videoSubtitleAppearance: {...config.videoSubtitleAppearance, bilingualOrder: target.dataset.subtitleOrder as Config['videoSubtitleAppearance']['bilingualOrder']}});
                } else if (handleVideoMenuDisclosure(courseMenu!, action)) positionCourseMenu();
                else if (action === 'close-menu') { setCourseMenuOpen(false); courseButton!.focus({preventScroll: true}); }
                else if (action === 'open-subtitle-tools' || action === 'close-subtitle-tools') { setVideoMenuToolsOpen(courseMenu!, action === 'open-subtitle-tools'); positionCourseMenu(); }
                else if (action === 'toggle-course-auto' && autoCourse) ports.patch({videoCourseAutoStart: {...config.videoCourseAutoStart, [autoCourse]: !config.videoCourseAutoStart[autoCourse]}});
                else if (action === 'generate-bilibili-ai' && ai) {
                    if (ai.status === 'running' || ai.status === 'checking') ai.stop();
                    else if (timeline.status !== 'ready') {
                        manualEnabled = true;
                        if (config.videoSubtitleVisible === false) ports.patch({videoSubtitleVisible: true});
                        sync();
                        void ai.start();
                    }
                }
                else if (action === 'retry-course-source') { ai?.stop(); timeline.retry(); sync(); }
                else if (action === 'retry-subtitle-translation') { cache.retryFailures(); signature = ''; sync(); }
                else if (action === 'toggle-reading-annotation') ports.patch({videoSubtitleAppearance: {...config.videoSubtitleAppearance, readingAnnotation: !config.videoSubtitleAppearance.readingAnnotation}});
                else if (action === 'subtitle-earlier' || action === 'subtitle-later' || action === 'reset-subtitle-timing') {
                    ports.patch({videoSubtitleOffsetMs: action === 'reset-subtitle-timing' ? 0 : Math.max(-10_000, Math.min(10_000, config.videoSubtitleOffsetMs + (action === 'subtitle-earlier' ? -500 : 500)))});
                } else if (action === 'open-settings') { setCourseMenuOpen(false); ports.openSettings?.(); }
                else if (action === 'open-sentence-learning' && courseTools) {
                    setCourseMenuOpen(false);
                    void courseTools.openLearning().catch(error => console.warn('[FluentRead] 无法打开字幕学习面板', error));
                } else if (courseTools && (action === 'download-subtitles' || action === 'download-translated-subtitles' || action === 'download-bilingual-subtitles')) {
                    const mode = action === 'download-subtitles' ? 'original' : action === 'download-bilingual-subtitles' ? 'bilingual' : 'translated';
                    void courseTools.startDownload(courseMenu!, target as HTMLButtonElement, mode);
                }
                else if (action === 'download-subtitles') {
                    try { ports.download?.(cuesToSrt(activeCues()), timeline.language); }
                    catch { courseStatus!.textContent = courseText('downloadFailed'); source.hidden = false; }
                }
            });
            courseMenu.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation();
                    if (!closeVideoMenuDisclosure(courseMenu!)) {
                        if (courseMenu!.dataset.panel === 'tools') setVideoMenuToolsOpen(courseMenu!, false);
                        else { setCourseMenuOpen(false); courseButton!.focus({preventScroll: true}); }
                    }
                } else handleVideoMenuNavigation(event);
            });
            for (const type of ['keyup', 'click']) courseMenu.addEventListener(type, event => event.stopPropagation());
            shadow.append(createVideoSubtitleStyle(document), style, courseButton, courseMenu);
        }
        if (controlsHost.parentElement !== controls || (anchor && controlsHost.nextSibling !== anchor)) {
            setCourseMenuOpen(false); controls.insertBefore(controlsHost, anchor);
        }
        // B 站按钮悬停后会增加不对称留白；对齐可见文字/SVG，不能用整栏或扩大的命中外框。
        const marker = anchor && Array.from(anchor.querySelectorAll<HTMLElement>('.bpx-player-ctrl-subtitle-result, svg'))
            .find(node => node.getBoundingClientRect().height > 0);
        const anchorStyle = anchor ? window.getComputedStyle(anchor) : null;
        const topInset = (Number.parseFloat(anchorStyle?.paddingTop || '') || 0) + (Number.parseFloat(anchorStyle?.borderTopWidth || '') || 0);
        const bottomInset = (Number.parseFloat(anchorStyle?.paddingBottom || '') || 0) + (Number.parseFloat(anchorStyle?.borderBottomWidth || '') || 0);
        const anchorScale = anchor?.offsetHeight ? anchor.getBoundingClientRect().height / anchor.offsetHeight || 1 : 1;
        const nativeHeight = marker ? marker.getBoundingClientRect().height / anchorScale : (anchor?.offsetHeight || 0) - topInset - bottomInset;
        const controlHeight = Math.max(16, Math.min(48, nativeHeight || (controls !== root ? controls.clientHeight : 32) || 32));
        if (controls === root) {
            setStyleIfChanged(controlsHost.style, 'position', 'absolute');
            setStyleIfChanged(controlsHost.style, 'right', `${nativeFallback ? 152 : 8}px`);
            setStyleIfChanged(controlsHost.style, 'bottom', `${nativeFallback ? 32 : 8}px`);
        } else {
            if (controlsHost.style.getPropertyValue('position')) controlsHost.style.removeProperty('position');
            if (controlsHost.style.getPropertyValue('right')) controlsHost.style.removeProperty('right');
            if (controlsHost.style.getPropertyValue('bottom')) controlsHost.style.removeProperty('bottom');
        }
        setStyleIfChanged(controlsHost.style, 'height', `${controlHeight}px`);
        for (const property of ['width', 'height']) setStyleIfChanged(courseButton!.style, property, `${controlHeight}px`, 'important');
        if (anchor) {
            const nativeBounds = (marker || anchor).getBoundingClientRect(), ownBounds = controlsHost.getBoundingClientRect();
            if (nativeBounds.height && ownBounds.height) {
                const scale = ownBounds.height / controlHeight;
                const nativeCenter = nativeBounds.top + nativeBounds.height / 2 + (marker ? 0 : (topInset - bottomInset) * anchorScale / 2);
                // controlsHost 为 position: relative，ownBounds 已包含当前的 top 偏移，必须相对当前偏移增量修正而非直接覆写。
                const currentTop = Number.parseFloat(controlsHost.style.top) || 0;
                const delta = (nativeCenter - ownBounds.top - ownBounds.height / 2) / scale;
                if (Math.abs(delta) >= 0.5) {
                    const nextTop = Math.round((currentTop + delta) * 2) / 2;
                    setStyleIfChanged(controlsHost.style, 'top', `${nextTop}px`);
                }
            }
        }
        const enabled = captionsEnabled();
        const toggleLabel = courseText('toggle');
        if (courseButton!.getAttribute('aria-label') !== toggleLabel) courseButton!.setAttribute('aria-label', toggleLabel);
        if (courseButton!.title !== toggleLabel) courseButton!.title = toggleLabel;
        const available = activeCues().length > 0 || Boolean(sourceTrack?.cues?.length) || nativeNodes().some(node => node.textContent?.trim());
        courseButton!.classList.toggle(VIDEO_TRANSLATION_ACTIVE_CLASS, enabled && available);
        const locale = `${config.uiLanguage}:${hasUiLanguageBundle(config.uiLanguage)}`;
        const serviceText = ports.label(getVideoServiceLabel(config.videoService || config.service, config.customOpenAIProviders, config.compositeTranslationProviders));
        const status = !enabled ? '' : timeline.status === 'loading' ? 'loading' : timeline.status === 'error' ? 'error'
            : timeline.status === 'empty' ? course === 'bilibili' ? 'bilibiliEmpty' : 'empty' : available ? '' : 'waiting';
        const translationFailed = Boolean(retry && !retry.hidden);
        const aiStatus = ai?.error || (ai?.status === 'checking' ? ports.label('正在检查本地模型')
            : ai?.status === 'running' ? `${ports.label('正在生成 AI 字幕')} ${Math.round(ai.progress * 100)}%` : '');
        const statusText = aiStatus || (translationFailed ? ports.label('这句翻译失败') : status && ai?.status !== 'ready' ? courseText(status) : '');
        const toolsReady = courseTools ? courseTools.canOpen() : completeTimeline();
        const autoChecked = Boolean(autoCourse && config.videoCourseAutoStart[autoCourse]);
        const menuStateKey = [
            enabled, config.videoSubtitleDisplayMode, config.videoSubtitleAppearance.bilingualOrder,
            config.videoSubtitleAppearance.readingAnnotation, config.videoSubtitleOffsetMs, locale,
            serviceText, statusText, timeline.status, translationFailed, ai?.status || '', toolsReady,
            autoChecked, Boolean(ports.download), browserCapabilities.extensionDom,
        ].join('|');
        if (courseMenu!.hidden && menuStateKey === lastMenuStateKey) return;
        lastMenuStateKey = menuStateKey;
        if (menuLocale !== locale) { refreshVideoUiText(courseMenu!, config.uiLanguage); menuLocale = locale; }
        renderVideoMenuMode(courseMenu!, enabled ? config.videoSubtitleDisplayMode : 'off', false, '');
        renderVideoSubtitleOrder(courseMenu!, config.videoSubtitleAppearance.bilingualOrder, !enabled, config.videoSubtitleDisplayMode === 'bilingual');
        courseMenu!.querySelector<HTMLElement>('.fluent-read-video-menu-order-setting')!.hidden = !enabled || config.videoSubtitleDisplayMode !== 'bilingual';
        renderVideoSubtitleTiming(courseMenu!, config.videoSubtitleOffsetMs, enabled && completeTimeline(), config.uiLanguage);
        const service = courseMenu!.querySelector<HTMLElement>('[data-service-label]')!;
        if (service.textContent !== serviceText) service.textContent = serviceText;
        const aiButton = courseMenu!.querySelector<HTMLButtonElement>('[data-action="generate-bilibili-ai"]');
        if (aiButton && ai) {
            aiButton.hidden = timeline.status === 'ready' || ai.status === 'ready';
            const label = ports.label(ai.status === 'running' || ai.status === 'checking' ? '停止生成' : '生成 AI 字幕');
            if (aiButton.textContent !== label) aiButton.textContent = label;
        }
        if (courseStatus!.textContent !== statusText) courseStatus!.textContent = statusText;
        courseStatus!.parentElement!.hidden = !statusText;
        courseRetry!.hidden = !enabled || timeline.status !== 'error'; courseRetry!.textContent = ports.label('重试');
        courseMenu!.querySelector<HTMLButtonElement>('[data-action="retry-subtitle-translation"]')!.hidden = !translationFailed;
        courseAuto!.setAttribute('aria-checked', String(autoChecked));
        courseAuto!.setAttribute('aria-label', courseText('auto'));
        const label = courseMenu!.querySelector('[data-course-auto-label]')!, labelText = courseText('auto');
        if (label.textContent !== labelText) label.textContent = labelText;
        if (courseTools) {
            const study = courseMenu!.querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!;
            study.disabled = !toolsReady;
            for (const button of courseMenu!.querySelectorAll<HTMLButtonElement>('[data-subtitle-downloads] button')) {
                button.disabled = !toolsReady || button.getAttribute('aria-busy') === 'true';
            }
        } else courseDownload!.disabled = !toolsReady;
        courseMenu!.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!.hidden = !course || !ports.download;
        const reading = courseMenu!.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
        reading.hidden = !browserCapabilities.extensionDom;
        reading.setAttribute('aria-pressed', String(config.videoSubtitleAppearance.readingAnnotation));
        reading.title = reading.getAttribute('aria-label') || '';
        positionCourseMenu();
    };

    const fit = () => {
        const panel = sourceLine?.parentElement;
        if (!panel || !sourceLine || !translatedLine || !retry || !mode || !layoutInputs) return;
        const {width, height, maximumHeight, fontSize, fontFamily, lineSpacing} = layoutInputs;
        const inputs = [width, height, maximumHeight, fontSize, fontFamily, lineSpacing, config.videoSubtitleAppearance.bilingualOrder, mode.value, mode.textContent,
            sourceLine.textContent, sourceLine.hidden, readingLine?.textContent, readingLine?.hidden,
            translatedLine.textContent, retry.hidden, retry.textContent];
        if (fittedInputs && inputs.every((value, index) => value === fittedInputs![index])) return;
        const readingVisible = Boolean(readingLine && !readingLine.hidden && readingLine.textContent);
        fitVideoSubtitleFontSize(fontSize, maximumHeight,
            size => setStyleIfChanged(panel.style, 'font-size', `${size}px`), () => panel.scrollHeight, readingVisible ? 16 : 8);
        if (readingVisible) {
            setSubtitlePanelScrollable(panel, panel.scrollHeight > maximumHeight + 1);
            panel.setAttribute('role', 'region');
        } else if (panel.dataset.fluentReadSubtitleScrollable === 'true') {
            setSubtitlePanelScrollable(panel, false); panel.setAttribute('role', 'region');
        }
        fittedInputs = inputs;
    };

    // 读音拥有独立的句子身份，翻译服务切换或失败不能决定读音是否可见。
    const syncReading = (source: string, language: string) => {
        const visible = browserCapabilities.extensionDom && config.videoSubtitleAppearance.readingAnnotation === true && config.videoSubtitleDisplayMode !== 'translation-only';
        const next = visible ? JSON.stringify([source, language]) : '';
        if (next === readingSignature) return;
        readingSignature = next;
        const current = ++readingGeneration;
        readings.cancelPending();
        if (readingLine) { readingLine.textContent = ''; readingLine.hidden = true; }
        if (!visible) return;
        void readings.request(source, language).then(result => {
            if (disposed || current !== readingGeneration || !readingLine || !result?.text || !host || host.hidden) return;
            readingLine.textContent = result.text;
            readingLine.lang = `${result.language.split('-')[0]}-Latn`;
            readingLine.setAttribute('aria-label', translate(`video.readingAnnotation.${result.language.split('-')[0]}`, config.uiLanguage));
            readingLine.hidden = false;
            fit();
        }).catch(() => { /* 注音失败保留原文与译文；切句或重新开启时可再次尝试。 */ });
    };

    const onVideoMediaEvent = () => sync();
    const unbindVideoEvents = () => {
        if (!boundVideo) return;
        boundVideo.removeEventListener('seeked', onVideoMediaEvent);
        boundVideo.removeEventListener('timeupdate', onVideoMediaEvent);
        boundVideo.removeEventListener('seeking', schedule);
        boundVideo.removeEventListener('play', played);
        boundVideo.removeEventListener('pause', paused);
        boundVideo = null;
    };
    const bindVideoEvents = (next: HTMLVideoElement | null) => {
        if (boundVideo === next) return;
        unbindVideoEvents();
        if (!next) return;
        boundVideo = next;
        boundVideo.addEventListener('seeked', onVideoMediaEvent);
        boundVideo.addEventListener('timeupdate', onVideoMediaEvent);
        boundVideo.addEventListener('seeking', schedule);
        boundVideo.addEventListener('play', played);
        boundVideo.addEventListener('pause', paused);
    };
    const onTrackCueChange = () => sync();
    const unbindTrackEvents = () => {
        for (const track of boundTracks) track.removeEventListener?.('cuechange', onTrackCueChange);
        boundTracks.clear();
    };
    const syncTrackEventBindings = () => {
        const desired = new Set<TextTrack>();
        if (sourceTrack) desired.add(sourceTrack);
        if (targetTrack) desired.add(targetTrack);
        for (const track of [...boundTracks]) {
            if (!desired.has(track)) {
                track.removeEventListener?.('cuechange', onTrackCueChange);
                boundTracks.delete(track);
            }
        }
        for (const track of desired) {
            if (!boundTracks.has(track)) {
                track.addEventListener?.('cuechange', onTrackCueChange);
                boundTracks.add(track);
            }
        }
    };
    const primeUpcomingCues = (cues: readonly VideoSubtitleCue[], time: number) => {
        if (!cues.length || !video || video.paused || config.videoSubtitleDisplayMode === 'original-only') return;
        const windowMs = getVideoPretranslationWindowMs(
            config.videoService || config.service,
            config.customOpenAIProviders,
            config.compositeTranslationProviders,
        );
        cache.primeUpcoming(cues, time * 1000, windowMs, video.playbackRate, (text, prefetch) => cache.request(text, prefetch));
    };

    const restoreCaptionVisibility = () => {
        captionVisibility.forEach((previous, node) => {
            if (node.style.getPropertyValue('visibility') === 'hidden' && node.style.getPropertyPriority('visibility') === 'important') {
                if (previous.value) node.style.setProperty('visibility', previous.value, previous.priority);
                else node.style.removeProperty('visibility');
            }
        });
        captionVisibility.clear();
    };
    const restoreTrackModes = () => {
        trackModes.forEach((state, track) => {
            try { if (track.mode === state.applied) track.mode = state.previous; }
            catch { /* 宿主页可能已移除或锁定只读轨道。 */ }
        });
        trackModes.clear();
    };
    const restoreCaptions = () => {
        restoreCaptionVisibility();
        restoreTrackModes();
    };
    const restoreAutoButton = () => {
        if (autoButton?.isConnected
            && CAPTION_DISABLE_LABEL.test((autoButton.getAttribute('aria-label') || autoButton.textContent || '').trim())) {
            autoButton.click();
            clickedButtons.delete(autoButton);
        }
        autoButton = null;
        for (const button of menuButtons) if (button.isConnected && button.getAttribute('aria-expanded') === 'true') button.click();
        menuButtons.clear();
    };
    const clear = (preservePrefetches = false) => {
        generation += 1;
        signature = '';
        layoutInputs = null;
        fittedInputs = null;
        if (!preservePrefetches) cache.cancelPending();
        readingGeneration += 1; readingSignature = ''; readings.cancelPending();
        if (sourceLine?.parentElement) {resetSubtitlePanelLayout(sourceLine.parentElement); sourceLine.parentElement.setAttribute('role', 'region');}
        if (sourceLine?.textContent) sourceLine.textContent = '';
        if (translatedLine?.textContent) translatedLine.textContent = '';
        if (readingLine) { readingLine.textContent = ''; readingLine.hidden = true; }
        if (retry && !retry.hidden) retry.hidden = true;
        if (host && !host.hidden) host.hidden = true;
    };
    const setTrackMode = (track: TextTrack, next: TextTrackMode) => {
        try {
            const owned = trackModes.get(track);
            if (owned && track.mode !== owned.applied) trackModes.delete(track);
            if (track.mode === next) return;
            const previous = trackModes.get(track)?.previous || track.mode;
            trackModes.set(track, {previous, applied: next});
            track.mode = next;
        } catch {
            trackModes.delete(track);
        }
    };
    const ensureUi = () => {
        const parent = getFullscreenElement(document) || document.body;
        if (!parent) return;
        if (host) {
            if (host.parentElement !== parent) { parent.appendChild(host); fittedInputs = null; }
            return;
        }
        host = document.createElement('div');
        host.id = 'fluent-read-platform-captions';
        host.className = 'notranslate';
        host.setAttribute('translate', 'no');
        host.setAttribute('data-fluent-read-owned', 'true');
        if (course) host.dataset.course = course;
        host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483646!important;pointer-events:none!important;box-sizing:border-box!important;';
        if (course) host.style.setProperty('text-align', 'center', 'important');
        const shadow = host.attachShadow({mode: 'open'});
        const style = document.createElement('style');
        style.textContent = `:host([data-course]){text-align:center}:host([data-course]) .panel{display:inline-flex;flex-direction:column;max-width:100%;vertical-align:bottom}:host([hidden]){display:none!important}*{box-sizing:border-box}.panel{font-family:var(--fluent-read-video-subtitle-font-family);text-align:center;line-height:var(--fluent-read-video-subtitle-line-spacing);font-size:20px;text-shadow:var(--fluent-read-video-subtitle-text-shadow);background:var(--fluent-read-video-subtitle-background);border-radius:8px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:hidden}.panel[data-fluent-read-subtitle-scrollable="true"]{overflow-y:auto;overflow-x:hidden;pointer-events:auto;overscroll-behavior:contain;touch-action:pan-y pinch-zoom}.panel[data-fluent-read-subtitle-scrollable="true"]:focus-visible{outline:2px solid currentColor;outline-offset:-2px}.source,.reading{color:var(--fluent-read-video-subtitle-text-color)}.reading{font-size:max(12px,.72em);line-height:1.35}.translation{color:var(--fluent-read-video-subtitle-translation-color)}.source,.translation{-webkit-text-stroke:var(--fluent-read-video-subtitle-text-stroke);paint-order:stroke fill}.tools{display:flex;justify-content:center;gap:8px;margin-top:4px;opacity:.8;pointer-events:auto;text-shadow:none;-webkit-text-stroke:0}select,button{font:12px system-ui;color:#fff;background:#17222e;border:1px solid #8c98a5;border-radius:5px;padding:3px 7px}select:focus-visible,button:focus-visible{outline:2px solid #ffe45c}[hidden]{display:none!important}`;
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', ports.label('双语字幕'));
        sourceLine = document.createElement('div'); sourceLine.className = 'source fluent-read-video-subtitle-original';
        readingLine = document.createElement('div'); readingLine.className = 'reading'; readingLine.hidden = true;
        translatedLine = document.createElement('div'); translatedLine.className = 'translation';
        const tools = document.createElement('div'); tools.className = 'tools';
        toolsBar = tools;
        // 原生选择框与重试按钮保留自身键盘动作，不由长字幕的滚动快捷键接管。
        for (const event of ['keydown', 'keyup']) tools.addEventListener(event, key => key.stopPropagation());
        mode = document.createElement('select'); mode.setAttribute('aria-label', ports.label('字幕显示模式'));
        for (const [value, label] of [['bilingual', '双语'], ['translation-only', '仅译文'], ['original-only', '仅原文'], ['off', '关闭']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = ports.label(label); mode.appendChild(option);
        }
        mode.addEventListener('change', () => ports.patch(mode!.value === 'off' ? {videoSubtitleVisible: false}
            : {videoSubtitleDisplayMode: mode!.value as Config['videoSubtitleDisplayMode']}));
        retry = document.createElement('button'); retry.type = 'button'; retry.textContent = ports.label('重试'); retry.hidden = true;
        retry.addEventListener('click', () => { cache.retryFailures(); signature = ''; schedule(); });
        const hideInlineTools = Boolean(course || controlsHost);
        mode.hidden = hideInlineTools; tools.hidden = hideInlineTools;
        tools.append(mode, retry); panel.append(sourceLine, readingLine, translatedLine, tools); shadow.append(style, panel); parent.appendChild(host);
    };

    const selectVideo = () => {
        let selected: {video: HTMLVideoElement; bounds: DOMRect; paused: boolean; area: number} | null = null;
        const mainBilibiliPlayer = course === 'bilibili' ? document.querySelector('#bilibili-player') : null;
        for (const node of queryLightThenDeep<HTMLVideoElement>(document, 'video')) {
            if (course === 'bilibili' && (node.closest('.v-recommend-inline-player') || (mainBilibiliPlayer && !mainBilibiliPlayer.contains(node)))) continue;
            const bounds = node.getBoundingClientRect();
            if (!(bounds.width > 0 && bounds.height > 0) || node.closest('[hidden], [aria-hidden="true"]')) continue;
            if (course && node === lastPlayedVideo) return {video: node, bounds, paused: node.paused, area: bounds.width * bounds.height};
            const paused = node.paused, area = bounds.width * bounds.height;
            if (!selected || Number(paused) < Number(selected.paused) || (paused === selected.paused && area > selected.area)) {
                selected = {video: node, bounds, paused, area};
            }
        }
        return selected;
    };
    const nativeNodes = () => {
        let root: ParentNode = course && playerRoot() ? playerRoot()! : document;
        if (!meeting && !course) {
            const matchedPlayer = playerRoot();
            if (matchedPlayer && hasSelectorDeep(matchedPlayer, PLATFORM_CAPTION_SELECTORS[platform])) {
                root = matchedPlayer;
            } else {
                let parent: ParentNode | null = video?.parentElement || (video?.getRootNode() as ParentNode | null);
                if (!parent) return [];
                while (parent instanceof Element && parent.parentElement && parent !== document.body
                    && !hasSelectorDeep(parent, PLATFORM_CAPTION_SELECTORS[platform])
                    && queryLightThenDeep(parent.parentElement, 'video').length === 1) {
                    parent = parent.parentElement;
                }
                if (parent instanceof Element && !hasSelectorDeep(parent, PLATFORM_CAPTION_SELECTORS[platform])) {
                    const rootNode = parent.getRootNode();
                    if (rootNode !== document && 'host' in rootNode) parent = (rootNode as ShadowRoot).host;
                }
                root = parent;
            }
        }
        const candidates = queryLightThenDeep<HTMLElement>(root, PLATFORM_CAPTION_SELECTORS[platform]);
        return candidates.filter(node => !node.closest('#fluent-read-platform-captions, #fluent-read-platform-controls, #fluent-read-course-controls, [hidden], [aria-hidden="true"]')
            && !candidates.some(other => other !== node && node.contains(other)));
    };

    const syncTracks = () => {
        if (!video) return;
        const tracks = Array.from(video.textTracks || []).filter(track => track.kind === 'subtitles' || track.kind === 'captions');
        const activeTracks = tracks.filter(track => track.mode === 'showing' || track.mode === 'hidden');
        const showing = activeTracks.find(track => track.mode === 'showing');
        const original = showing
            || (sourceTrack && activeTracks.includes(sourceTrack) ? sourceTrack : null)
            || activeTracks.find(track => !captionLanguageMatch(track.language, config.to))
            || activeTracks[0]
            || null;
        const entries = tracks.map(track => ({track, languageCode: track.language, name: track.label}));
        const human = original && config.videoPreferHumanSubtitles ? chooseTargetHumanCaptionTrack(entries, config.to)?.track || null : null;
        if (original !== sourceTrack || human !== targetTrack) {
            restoreCaptions(); clear(); sourceTrack = original; targetTrack = human;
        }
        syncTrackEventBindings();
        // hidden 会让浏览器加载字幕但不重复绘制；退出或关闭时恢复此前模式，绝不擅自启用已关闭的轨道。
        if (sourceTrack) setTrackMode(sourceTrack, 'hidden');
        if (targetTrack) setTrackMode(targetTrack, 'hidden');
    };

    const sync = () => {
        if (disposed) return;
        const href = routeHref();
        if (route !== href) {
            route = href; clear(); restoreCaptions(); restoreAutoButton(); unbindVideoEvents(); unbindTrackEvents(); cache.clear(); readings.clear();
            clickedButtons = new WeakSet();
            video = null; sourceTrack = null; targetTrack = null; mediaKey = ''; pollPaused = false;
            timeline.clear(); ai?.sync(''); courseIdentity = ''; manualEnabled = null; lastPlayedVideo = null;
        }
        const activePlatform = getCaptionPlatform(window.location) === platform;
        if (!activePlatform || !config.on || !config.videoTranslationEnabled) {
            courseTools?.sync();
            clear(); restoreCaptions(); restoreAutoButton(); unbindVideoEvents(); unbindTrackEvents();
            video = null; sourceTrack = null; targetTrack = null; mediaKey = ''; pollPaused = false;
            timeline.clear(); ai?.sync(''); removeCourseControls(); return;
        }
        if (!hasControlBar && config.videoSubtitleVisible === false) {
            clear(); restoreCaptions(); restoreAutoButton(); unbindVideoEvents(); unbindTrackEvents();
            pollPaused = false;
            return;
        }
        if (meeting && config.videoMeetingAutoEnabled) {
            const button = findCaptionEnableButton(document, platform);
            if (button && !clickedButtons.has(button) && window.getComputedStyle(button).display !== 'none'
                && window.getComputedStyle(button).visibility !== 'hidden') {
                clickedButtons.add(button); autoButton = button; button.click();
            } else if (!button && platform === 'teams' && !document.querySelector(PLATFORM_CAPTION_SELECTORS.teams)) {
                const step = findTeamsCaptionMenuStep(document);
                if (step && !clickedButtons.has(step) && window.getComputedStyle(step).display !== 'none'
                    && window.getComputedStyle(step).visibility !== 'hidden') {
                    clickedButtons.add(step); menuButtons.add(step); step.click();
                }
            }
        } else if (!config.videoMeetingAutoEnabled) restoreAutoButton();
        const selection = meeting ? null : selectVideo();
        const nextVideo = selection?.video || null;
        const nextKey = nextVideo ? `${route}:${nextVideo.currentSrc || nextVideo.getAttribute('src') || ''}` : '';
        if (nextVideo !== video || nextKey !== mediaKey) {
            mediaEpoch++;
            clear(); restoreCaptions(); unbindTrackEvents(); cache.clear(); readings.clear();
            video = nextVideo; mediaKey = nextKey; sourceTrack = null; targetTrack = null; pollPaused = false;
            timeline.clear(); ai?.sync(''); courseIdentity = ''; manualEnabled = null;
        }
        bindVideoEvents(video);
        const enabled = captionsEnabled();
        const request = course && video && enabled ? getCourseCaptionRequest(course, new URL(window.location.href), video, config.from, config.to) : null;
        const identity = request?.key || '';
        if (identity !== courseIdentity) { courseIdentity = identity; clear(); restoreCaptions(); cache.clear(); readings.clear(); }
        timeline.sync(request, mediaKey);
        if (ai) {
            ai.sync(request ? `${mediaKey}:${request.key}:${config.videoLocalModel}:${config.videoSourceLanguage}:${config.videoTranscriptionProvider}:${config.videoNativeAsrBaseUrl}` : '');
            if (timeline.status === 'ready' && ai.status !== 'idle') ai.stop();
            else if (!config.videoCourseAutoStart.bilibili) ai.stopAutomatic();
            else if (timeline.status === 'empty') {
                // 只在当前页面可见且播放器就绪时发起自动识别，迟到的内嵌字幕标记仍可停止旧任务。
                const captionHint = hasBilibiliCaptionHint(document.querySelector('h1')?.textContent?.trim() || document.title || '');
                if (captionHint) ai.stopAutomatic();
                else if (!document.hidden && video && video.readyState > 0 && !video.ended) void ai.start(true);
            }
        }
        const hasAiCues = timeline.status !== 'ready' && Boolean(ai?.cues.length);
        if (hasAiCues !== usingAiCues) { usingAiCues = hasAiCues; cache.clear(); clear(); }
        courseTools?.sync();
        syncCourseControls();
        if (!enabled) { clear(); restoreCaptions(); restoreAutoButton(); return; }
        if (!meeting && (!video || video.seeking || video.ended || video.readyState === 0)) { clear(); restoreCaptions(); return; }
        syncTracks();
        const nodes = nativeNodes();
        const offsetMs = config.videoSubtitleOffsetMs;
        const time = video ? video.currentTime - offsetMs / 1000 : 0;
        const cues = activeCues();
        const cue = cues.length ? selectVideoSubtitleCueAtOffset(cues, time * 1000, 0) : null;
        // 已有完整时间轴时严格遵循时间轴空档；课程源在空/错误态或已有 TextTrack 时优雅回退，加载中避免误译页面自带机翻字幕。
        const rawSource = cues.length
            ? cue?.text || ''
            : sourceTrack?.cues?.length
                ? trackTextAt(sourceTrack, time, offsetMs)
                : (!request || timeline.status !== 'loading')
                    ? nodes.map(node => node.textContent || '').slice(-3).join(' ') || readPlatformTranscriptCue(platform, document, time)
                    : '';
        const source = normalizeVideoCaptionText(rawSource).slice(0, 3000);
        const human = course && timeline.status === 'ready' ? '' : trackTextAt(targetTrack, time, offsetMs);
        if (course && video?.paused) cache.retainPrefetches([]);
        if (!source) {
            const shouldPrimeGap = Boolean(cues.length && video && !video.paused && config.videoSubtitleDisplayMode !== 'original-only');
            clear(shouldPrimeGap);
            restoreCaptionVisibility();
            if (shouldPrimeGap) primeUpcomingCues(cues, time);
            return;
        }
        ensureUi();
        if (!host || !sourceLine || !translatedLine || !mode) return;
        const hideInlineTools = Boolean(course || controlsHost);
        if (mode.hidden !== hideInlineTools) mode.hidden = hideInlineTools;
        if (toolsBar && toolsBar.hidden !== hideInlineTools) toolsBar.hidden = hideInlineTools;
        const appearance = getVideoSubtitleAppearanceCssVars(config.videoSubtitleAppearance);
        for (const [key, value] of Object.entries(appearance)) setStyleIfChanged(host.style, key, value);
        const viewport = readSafeViewport();
        const bounds = selection?.bounds;
        const areaLeft = bounds ? bounds.left : viewport.left;
        const areaTop = bounds ? bounds.top : viewport.top;
        const areaWidth = bounds?.width || viewport.width;
        const areaHeight = bounds?.height || viewport.height;
        const width = areaWidth * config.videoSubtitleAppearance.maxWidth / 100;
        const left = areaLeft + (areaWidth - width) / 2;
        const top = areaTop, height = areaHeight;
        setStyleIfChanged(host.style, 'left', `${left}px`, 'important'); setStyleIfChanged(host.style, 'width', `${width}px`, 'important');
        const position = config.videoSubtitleAppearance.position;
        setStyleIfChanged(host.style, 'top', `${top + height * (position === 'top' ? .08 : position === 'center' ? .5 : 1 - Math.max(.08, config.videoSubtitleAppearance.bottomOffset / 100))}px`, 'important');
        setStyleIfChanged(host.style, 'transform', position === 'top' ? 'none' : position === 'center' ? 'translateY(-50%)' : 'translateY(-100%)', 'important');
        if (host.hidden) host.hidden = false;
        if (mode.value !== config.videoSubtitleDisplayMode) mode.value = config.videoSubtitleDisplayMode;
        const sourceHidden = config.videoSubtitleDisplayMode === 'translation-only';
        if (sourceLine.hidden !== sourceHidden) sourceLine.hidden = sourceHidden;
        const panel = sourceLine.parentElement!;
        // 只移动现有译文节点；翻译、读音请求和工具焦点不随顺序切换重建。
        if (config.videoSubtitleAppearance.bilingualOrder === 'translation-first') {
            if (translatedLine.nextElementSibling !== sourceLine) panel.insertBefore(translatedLine, sourceLine);
        } else if (readingLine && readingLine.nextElementSibling !== translatedLine) {
            panel.insertBefore(translatedLine, readingLine.nextElementSibling);
        }
        const maximumHeight = Math.max(24, height * (position === 'center' ? .9 : .84));
        setStyleIfChanged(panel.style, 'max-height', `${maximumHeight}px`);
        layoutInputs = {width, height, maximumHeight, fontSize: 20 * config.videoSubtitleAppearance.fontScale / 100,
            fontFamily: appearance['--fluent-read-video-subtitle-font-family'], lineSpacing: appearance['--fluent-read-video-subtitle-line-spacing']};
        if (sourceLine.textContent !== source) sourceLine.textContent = source;
        syncReading(source, timeline.language || sourceTrack?.language || config.from || 'auto');
        if (readingLine && !readingLine.hidden) {
            const label = translate(`video.readingAnnotation.${readingLine.lang.split('-')[0]}`, config.uiLanguage);
            if (readingLine.getAttribute('aria-label') !== label) readingLine.setAttribute('aria-label', label);
        }
        nodes.forEach(node => {
            if (!captionVisibility.has(node)) captionVisibility.set(node, {value: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility')});
            setStyleIfChanged(node.style, 'visibility', 'hidden', 'important');
        });
        for (const node of captionVisibility.keys()) if (!node.isConnected) captionVisibility.delete(node);
        const nextSignature = `${fingerprint}:${config.videoSubtitleDisplayMode}:${source}:${human}`;
        if (nextSignature === signature) { fit(); primeUpcomingCues(cues, time); return; }
        signature = nextSignature;
        const current = ++generation;
        if (!retry!.hidden) retry!.hidden = true;
        const show = (text: string) => {
            if (disposed || current !== generation || !translatedLine) return;
            const translation = text === source && config.videoSubtitleDisplayMode === 'bilingual' ? '' : text;
            if (translatedLine.textContent !== translation) translatedLine.textContent = translation;
            fit();
            if (hasControlBar) syncCourseControls();
        };
        if (config.videoSubtitleDisplayMode === 'original-only') {
            if (translatedLine.textContent) translatedLine.textContent = '';
            cache.cancelPending(); fit(); return;
        }
        if (human) { show(human); return; }
        // 同步命中译文缓存，消除空闪和二次 fit 排版抖动。
        const cached = cache.peek(source);
        if (cached !== undefined) {
            show(cached);
            primeUpcomingCues(cues, time);
            return;
        }
        if (translatedLine.textContent) translatedLine.textContent = '';
        fit();
        const showFailure = () => {
            if (disposed || current !== generation || !translatedLine || !retry) return;
            translatedLine.textContent = course || controlsHost ? '' : ports.label('这句翻译失败'); retry.hidden = false; fit();
            if (hasControlBar) syncCourseControls();
        };
        void cache.request(source).then(text => {
            if (!text && cache.hasFailure(source)) showFailure();
            else show(text);
        }).catch(showFailure);
        primeUpcomingCues(cues, time);
    };

    const schedule = () => { if (!disposed && pendingTimer === undefined) pendingTimer = setTimeout(() => { pendingTimer = undefined; sync(); }, 80); };
    const invalidateLayout = () => { fittedInputs = null; schedule(); };
    const onViewportChange = () => { safeViewport = null; invalidateLayout(); };
    const onScroll = () => {
        if (disposed || scrollFrame !== undefined) return;
        if (typeof window.requestAnimationFrame === 'function') {
            scrollFrame = window.requestAnimationFrame(() => {
                scrollFrame = undefined;
                if (!disposed) sync();
            });
        } else {
            schedule();
        }
    };
    const releaseUserControls = (event: MouseEvent) => {
        if (!event.isTrusted) return;
        const target = event.target as Node | null;
        if (target && autoButton?.contains(target)) autoButton = null;
        for (const button of menuButtons) if (target && button.contains(target)) menuButtons.delete(button);
    };
    const isOwnedMutationTarget = (node: Node): boolean => {
        const element = node instanceof Element ? node : node.parentElement;
        return Boolean(element?.closest('#fluent-read-platform-captions, #fluent-read-course-controls, #fluent-read-platform-controls'));
    };
    const isIgnoredMutationNode = (node: Node): boolean =>
        isOwnedMutationTarget(node)
        || (node instanceof Element && node.tagName === 'SPAN' && node.getAttribute('aria-hidden') === 'true'
            && Boolean(node.getAttribute('style')?.includes('safe-area-inset-top')));
    const observer = new MutationObserver(records => {
        if (records.some(record => {
            if (isOwnedMutationTarget(record.target)) return false;
            if (record.type === 'childList') {
                const nodes = [...record.addedNodes, ...record.removedNodes];
                if (nodes.length > 0 && nodes.every(isIgnoredMutationNode)) return false;
            }
            return true;
        })) schedule();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
    const pollTick = () => {
        if (disposed || document.visibilityState === 'hidden' || (pollPaused && video?.paused)) return;
        sync();
    };
    const timer = setInterval(pollTick, 250);
    const handleVisibilityChange = () => {
        if (document.visibilityState !== 'hidden') sync();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubscribe = ports.subscribe(() => {
        const next = getVideoTranslationConfigFingerprint(config);
        if (next !== fingerprint) { fingerprint = next; cache.clear(); clear(); }
        sync();
    });
    const stopFullscreen = onFullscreenChange(document, onViewportChange);
    const stopObserveViewport = typeof window.requestAnimationFrame === 'function'
        ? observeVisualViewport(onViewportChange, window)
        : (() => {
            window.addEventListener('resize', onViewportChange);
            return () => window.removeEventListener('resize', onViewportChange);
        })();
    window.addEventListener('scroll', onScroll, {passive: true, capture: true});
    document.addEventListener('seeking', schedule, true);
    const played = (event: Event) => {
        const target = event.target as Element | null;
        if (target?.tagName !== 'VIDEO') return;
        if (course) lastPlayedVideo = target as HTMLVideoElement;
        pollPaused = false;
        if (target === video || !video) {
            sync();
        } else {
            schedule();
        }
    };
    const onDocumentPlay = (event: Event) => {
        if (event.target !== boundVideo) played(event);
    };
    document.addEventListener('play', onDocumentPlay, true);
    const paused = () => {
        pollPaused = true;
        cache.retainPrefetches([]);
    };
    document.addEventListener('click', releaseUserControls, true);
    const closeCourseOutside = (event: Event) => { if (courseMenu && !courseMenu.hidden && !event.composedPath().includes(controlsHost!)) setCourseMenuOpen(false); };
    document.addEventListener('pointerdown', closeCourseOutside, true);
    const handlePlatformKeydown = (event: KeyboardEvent) => {
        handleVideoSubtitleModeShortcutKeydown(event, {
            document,
            config,
            isActive: () => !disposed && getCaptionPlatform(window.location) === platform
                && config.on && config.videoTranslationEnabled && (meeting || Boolean(video)),
            isVisible: () => captionsEnabled(),
            applyMode: (nextMode) => {
                if (course) {
                    if (nextMode === 'off') {
                        manualEnabled = false;
                        ports.patch({videoSubtitleVisible: false});
                    } else {
                        manualEnabled = true;
                        ports.patch({videoSubtitleVisible: true, videoSubtitleDisplayMode: nextMode});
                    }
                } else if (nextMode === 'off') {
                    ports.patch({videoSubtitleVisible: false});
                } else {
                    ports.patch({videoSubtitleVisible: true, videoSubtitleDisplayMode: nextMode});
                }
                sync();
            },
            notify: (nextMode) => {
                if (typeof globalThis.document === 'undefined' || globalThis.document !== document) return;
                notifyVideoSubtitleModeSwitch(nextMode, (key, params) => translate(key, config.uiLanguage, params));
            },
        });
    };
    document.addEventListener('keydown', handlePlatformKeydown, true);
    document.fonts?.addEventListener('loadingdone', invalidateLayout);
    sync();
    return () => {
        disposed = true;
        if (typeof globalThis.document !== 'undefined' && globalThis.document === document) clearVideoSubtitleModeNotice();
        courseTools?.destroy(); ai?.destroy(); clear(); cache.clear(); readings.destroy(); restoreCaptions(); restoreAutoButton(); unbindVideoEvents(); unbindTrackEvents(); timeline.clear(); removeCourseControls();
        if (sourceLine?.parentElement) resetSubtitlePanelLayout(sourceLine.parentElement, true);
        observer.disconnect(); clearInterval(timer); if (pendingTimer !== undefined) clearTimeout(pendingTimer);
        if (scrollFrame !== undefined) window.cancelAnimationFrame?.(scrollFrame);
        unsubscribe(); stopFullscreen(); stopObserveViewport();
        window.removeEventListener('scroll', onScroll, {capture: true});
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        document.removeEventListener('seeking', schedule, true);
        document.removeEventListener('click', releaseUserControls, true);
        document.removeEventListener('pointerdown', closeCourseOutside, true);
        document.removeEventListener('keydown', handlePlatformKeydown, true);
        document.removeEventListener('play', onDocumentPlay, true);
        document.fonts?.removeEventListener('loadingdone', invalidateLayout);
        host?.remove(); host = null;
    };
}
