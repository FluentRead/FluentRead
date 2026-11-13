/**
 * @file src/features/video-subtitle/content/platformRuntime.ts
 * 文件职责：在会议、B 站、Udemy、edX 与 Disney+ 网页中挂载隔离的双语字幕，复用现有视频配置及翻译缓存。
 * 课程字幕：完整原文轨道绑定分 P、小节及所选语言，按站点自动开启；播放器菜单保留关闭后的入口，最近播放的视频暂停后仍保持归属，原文导出与有界预取复用已读取时间轴。
 * 主要内容：观察原生字幕、读取浏览器字幕轨、自动开启明确的会议字幕按钮、优先目标语言人工轨，按保存的双语顺序排列稳定节点并让读音紧跟原文；可选读音行独立请求与取消，不等待译文，每轮只测量各视频一次，按当前文本、读音、顺序、尺寸和字体输入去重布局；长读音保留可读字号并在自有区域提供键盘和触摸滚动，失败句在退避期再次出现仍保留重试入口，处理全屏、动态页面与所有权恢复。
 * 模块边界：只通过注入端口读取配置、翻译和保存设置；布局记录仅属于当前挂载，位置每轮重新读取，字体加载与卸载清除适配状态，不采集音频、不访问账号接口，不修改网站播放器实现。
 */
import type {Config} from '@/src/core/config/model';
import {translate} from '@/src/core/i18n';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getVideoSubtitleAppearanceCssVars} from '@/src/core/config/videoSubtitleAppearance';
import {selectVideoSubtitleCueAtOffset, getVideoTranslationConfigFingerprint, normalizeVideoCaptionText} from './subtitleLogic';
import {VIDEO_COURSE_PLATFORMS, type VideoCoursePlatform} from '@/src/core/config/videoCourse';
import {CourseCaptionSource, type CourseCaptionSourcePorts} from './courseCaptionSource';
import {getCourseCaptionRequest} from './courseCaptionData';
import {requestBilibiliCaptionManifest} from './bilibiliCaptionBridge';
import {cuesToSrt} from './youtubeSubtitleData';
import {VideoTranslationCache} from './translationCache';
import {fitVideoSubtitleFontSize} from './subtitleLayout';
import {setSubtitlePanelScrollable, resetSubtitlePanelLayout} from './subtitleControlLayout';
import {isVideoSubtitleInTargetLanguage} from './subtitleLanguage';
import {chooseTargetHumanCaptionTrack, getCaptionPlatform, isMeetingCaptionPlatform, PLATFORM_CAPTION_SELECTORS, findCaptionEnableButton, findTeamsCaptionMenuStep, captionLanguageMatch} from './platforms';
import {VideoReadingAnnotationSession} from './readingAnnotationSession';
import {annotateVideoReading} from './readingAnnotationClient';

interface PlatformCaptionPorts {
    document: Document;
    window: Window;
    config: Config;
    subscribe(listener: (config: Config) => void): () => void;
    translate(text: string, signal: AbortSignal): Promise<string>;
    patch(patch: Partial<Config>): void;
    label(text: string): string;
    download?(srt: string, language: string): void;
    captionSource?: Partial<Omit<CourseCaptionSourcePorts, 'base' | 'changed'>>;
}

function trackTextAt(track: TextTrack | null, time: number): string {
    if (!track?.cues || !Number.isFinite(time)) return '';
    return Array.from(track.cues).filter(cue => time >= cue.startTime && time < cue.endTime)
        .map(cue => (cue as VTTCue).text || '').join(' ').replace(/<[^>]*>/g, '').trim();
}

function setStyleIfChanged(style: CSSStyleDeclaration, property: string, value: string, priority = ''): void {
    if (style.getPropertyValue(property) !== value || style.getPropertyPriority(property) !== priority) {
        style.setProperty(property, value, priority);
    }
}

/** 生命周期完全属于当前内容 feature；配置停用时取消请求并恢复本功能修改的原生显示。 */
export function mountPlatformCaptions(ports: PlatformCaptionPorts): () => void {
    const {document, window, config} = ports;
    const platform = getCaptionPlatform(window.location);
    if (!platform) return () => undefined;
    const meeting = isMeetingCaptionPlatform(platform);
    const course = VIDEO_COURSE_PLATFORMS.includes(platform as VideoCoursePlatform) ? platform as VideoCoursePlatform : null;
    const timeline = new CourseCaptionSource({
        base: new URL(window.location.href), fetch: ports.captionSource?.fetch || ((input, init) => fetch(input, init)),
        manifest: ports.captionSource?.manifest || ((part, signal) => requestBilibiliCaptionManifest(window, part, signal)),
        resources: ports.captionSource?.resources || (() => window.performance.getEntriesByType('resource').map(entry => entry.name)),
        changed: () => schedule(),
    });
    const cache = new VideoTranslationCache((text, signal) => isVideoSubtitleInTargetLanguage(text, config.to)
        ? Promise.resolve(text) : ports.translate(text, signal));
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
    let courseMode: HTMLSelectElement | null = null;
    let courseStatus: HTMLElement | null = null;
    let courseAuto: HTMLInputElement | null = null;
    let courseRetry: HTMLButtonElement | null = null;
    let courseDownload: HTMLButtonElement | null = null;
    let courseTiming: HTMLElement | null = null;
    const courseText = (key: string) => translate(`video.course.${key}`, config.uiLanguage);
    const captionsEnabled = () => config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
        && (!course || (manualEnabled ?? config.videoCourseAutoStart[course]));

    const playerRoot = () => video?.closest<HTMLElement>(course === 'bilibili' ? '.bpx-player-container'
        : course === 'edx' ? '.video[data-metadata]' : '[data-purpose="shaka-video-player"]') || video?.parentElement || null;
    const positionCourseMenu = () => {
        if (!courseMenu || courseMenu.hidden || !courseButton) return;
        const button = courseButton.getBoundingClientRect?.();
        const bounds = courseMenu.getBoundingClientRect?.();
        const width = bounds?.width || 245, height = bounds?.height || 270;
        setStyleIfChanged(courseMenu.style, 'left', `${Math.max(8, Math.min((button?.right || width) - width, window.innerWidth - width - 8))}px`);
        setStyleIfChanged(courseMenu.style, 'top', `${Math.max(8, (button?.top || height) - height - 8)}px`);
        setStyleIfChanged(courseMenu.style, 'max-height', `${Math.max(80, window.innerHeight - 16)}px`);
    };
    const setCourseMenuOpen = (open: boolean) => {
        if (!courseMenu || !courseButton) return;
        if (open) {
            courseMenu.hidden = false;
            courseMenu.showPopover?.();
            positionCourseMenu();
        } else {
            if (courseMenu.isConnected) courseMenu.hidePopover?.();
            courseMenu.hidden = true;
        }
        courseButton.setAttribute('aria-expanded', String(open));
    };
    const removeCourseControls = () => {
        controlsHost?.remove(); controlsHost = null; courseMenu = null; courseButton = null;
        courseMode = null; courseStatus = null; courseAuto = null; courseRetry = null; courseDownload = null;
        courseTiming = null;
    };
    const syncCourseControls = () => {
        const root = playerRoot();
        if (!course || !root || !config.on || !config.videoTranslationEnabled) { removeCourseControls(); return; }
        const controls = root.querySelector(course === 'bilibili' ? '.bpx-player-control-bottom-right'
            : course === 'edx' ? '.secondary-controls' : '[data-purpose="video-control-bar"]') || root;
        if (!controlsHost) {
            controlsHost = document.createElement('span'); controlsHost.id = 'fluent-read-course-controls';
            controlsHost.setAttribute('data-fluent-read-owned', 'true'); controlsHost.setAttribute('translate', 'no');
            const shadow = controlsHost.attachShadow({mode: 'open'});
            const style = document.createElement('style');
            style.textContent = ':host{all:initial;display:inline-flex;position:relative;flex-shrink:0;align-self:center;z-index:1000;color:#fff;font:13px system-ui}button,select,input{font:inherit}button,select{color:inherit;border:1px solid #8b95a3;background:#15222f;border-radius:6px;padding:5px 8px}button{cursor:pointer}button[aria-pressed="true"]{color:#c6ffe1;border-color:#70d7a5}button:disabled{opacity:.5;cursor:default}.menu{position:absolute;bottom:calc(100% + 8px);right:0;width:245px;max-width:80vw;background:#14202e;border:1px solid #647184;border-radius:10px;padding:12px;box-shadow:0 4px 18px #0008;display:grid;gap:10px;white-space:normal;line-height:1.4}label{display:flex;align-items:center;gap:6px}p{margin:0}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #a4e8ca;outline-offset:2px}[hidden]{display:none!important}';
            courseButton = document.createElement('button'); courseButton.type = 'button'; courseButton.textContent = 'FR';
            courseButton.setAttribute('aria-haspopup', 'true'); courseButton.setAttribute('aria-expanded', 'false');
            courseMenu = document.createElement('div'); courseMenu.className = 'menu'; courseMenu.hidden = true;
            // 顶层 popover 不受播放器 stacking context 约束，避免被字幕或宿主底控遮住。
            courseMenu.setAttribute('popover', 'manual');
            courseMenu.style.cssText = 'position:fixed;inset:auto;margin:0;box-sizing:border-box;overflow:auto;color:#fff';
            courseButton.addEventListener('click', event => {
                event.stopPropagation(); setCourseMenuOpen(Boolean(courseMenu!.hidden));
                if (!courseMenu!.hidden) courseMode!.focus();
            });
            courseMode = document.createElement('select');
            for (const value of ['off', 'bilingual', 'original-only', 'translation-only']) {
                const option = document.createElement('option'); option.value = value; courseMode.appendChild(option);
            }
            courseMode.addEventListener('change', () => {
                manualEnabled = courseMode!.value !== 'off';
                if (manualEnabled) ports.patch({videoSubtitleVisible: true, videoSubtitleDisplayMode: courseMode!.value as Config['videoSubtitleDisplayMode']});
                sync();
            });
            courseStatus = document.createElement('p'); courseStatus.setAttribute('role', 'status');
            const autoLabel = document.createElement('label');
            courseAuto = document.createElement('input'); courseAuto.type = 'checkbox';
            const autoText = document.createElement('span'); autoText.dataset.courseAutoLabel = '';
            autoLabel.append(courseAuto, autoText);
            courseAuto.addEventListener('change', () => ports.patch({videoCourseAutoStart: {...config.videoCourseAutoStart, [course]: courseAuto!.checked}}));
            courseRetry = document.createElement('button'); courseRetry.type = 'button';
            courseRetry.addEventListener('click', () => { timeline.retry(); sync(); });
            courseDownload = document.createElement('button'); courseDownload.type = 'button';
            courseDownload.addEventListener('click', () => {
                try { ports.download?.(cuesToSrt(timeline.cues), timeline.language); }
                catch { courseStatus!.textContent = courseText('downloadFailed'); }
            });
            courseTiming = document.createElement('div'); courseTiming.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
            for (const [step, label] of [[-500, '提前 0.5 秒'], [0, '重置'], [500, '延后 0.5 秒']] as const) {
                const button = document.createElement('button'); button.type = 'button';
                button.dataset.courseTiming = String(step); button.dataset.courseLabel = label;
                button.addEventListener('click', () => ports.patch({videoSubtitleOffsetMs: step === 0 ? 0
                    : Math.max(-10_000, Math.min(10_000, config.videoSubtitleOffsetMs + step))}));
                courseTiming.appendChild(button);
            }
            courseMenu.append(courseMode, courseStatus, autoLabel, courseRetry, courseDownload, courseTiming);
            shadow.append(style, courseButton, courseMenu);
            for (const type of ['keydown', 'keyup', 'click']) courseMenu.addEventListener(type, event => {
                event.stopPropagation();
                if (type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
                    setCourseMenuOpen(false); courseButton!.focus();
                }
            });
        }
        if (controlsHost.parentElement !== controls) { setCourseMenuOpen(false); controls.appendChild(controlsHost); }
        controlsHost.style.cssText = controls === root ? 'position:absolute;right:8px;bottom:8px' : '';
        const enabled = captionsEnabled();
        courseButton!.setAttribute('aria-label', courseText('toggle')); courseButton!.title = courseText('toggle');
        const available = timeline.status === 'ready' || Boolean(sourceTrack?.cues?.length) || nativeNodes().some(node => node.textContent?.trim());
        courseButton!.setAttribute('aria-pressed', String(enabled && available));
        courseMode!.setAttribute('aria-label', ports.label('字幕显示模式'));
        const labels = ['关闭', '双语', '仅原文', '仅译文'];
        Array.from(courseMode!.children).forEach((option, index) => { const text = ports.label(labels[index]); if (option.textContent !== text) option.textContent = text; });
        courseMode!.value = enabled ? config.videoSubtitleDisplayMode : 'off';
        const status = !enabled ? 'off' : timeline.status === 'loading' ? 'loading' : timeline.status === 'error' ? 'error'
            : timeline.status === 'empty' ? course === 'bilibili' ? 'bilibiliEmpty' : 'empty' : available ? 'ready' : 'waiting';
        const statusText = courseText(status); if (courseStatus!.textContent !== statusText) courseStatus!.textContent = statusText;
        courseAuto!.checked = config.videoCourseAutoStart[course];
        const label = courseMenu!.querySelector('[data-course-auto-label]')!, labelText = courseText('auto');
        if (label.textContent !== labelText) label.textContent = labelText;
        courseRetry!.hidden = !enabled || timeline.status !== 'error'; courseRetry!.textContent = ports.label('重试');
        courseDownload!.textContent = courseText('download'); courseDownload!.disabled = timeline.status !== 'ready';
        courseDownload!.hidden = !ports.download;
        courseTiming!.hidden = timeline.status !== 'ready';
        for (const button of courseTiming!.querySelectorAll<HTMLButtonElement>('button')) {
            const step = Number(button.dataset.courseTiming);
            button.setAttribute('aria-label', ports.label(button.dataset.courseLabel!));
            button.textContent = step < 0 ? '−0.5 s' : step > 0 ? '+0.5 s' : `${(config.videoSubtitleOffsetMs / 1000).toFixed(1)} s ↺`;
            button.disabled = step < 0 ? config.videoSubtitleOffsetMs <= -10_000 : step > 0 ? config.videoSubtitleOffsetMs >= 10_000 : config.videoSubtitleOffsetMs === 0;
        }
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

    const restoreCaptions = () => {
        captionVisibility.forEach((previous, node) => {
            if (node.style.getPropertyValue('visibility') === 'hidden' && node.style.getPropertyPriority('visibility') === 'important') {
                if (previous.value) node.style.setProperty('visibility', previous.value, previous.priority);
                else node.style.removeProperty('visibility');
            }
        });
        captionVisibility.clear();
        trackModes.forEach((state, track) => { if (track.mode === state.applied) track.mode = state.previous; });
        trackModes.clear();
    };
    const restoreAutoButton = () => {
        if (autoButton?.isConnected
            && /^(?:turn off (?:live )?captions|hide (?:closed |live )?(?:captions|subtitles)|关闭(?:实时)?字幕|隐藏(?:实时)?字幕)/i.test(autoButton.getAttribute('aria-label') || autoButton.textContent || '')) {
            autoButton.click();
            clickedButtons.delete(autoButton);
        }
        autoButton = null;
        for (const button of menuButtons) if (button.isConnected && button.getAttribute('aria-expanded') === 'true') button.click();
        menuButtons.clear();
    };
    const clear = () => {
        generation += 1;
        signature = '';
        layoutInputs = null;
        fittedInputs = null;
        cache.cancelPending();
        readingGeneration += 1; readingSignature = ''; readings.cancelPending();
        if (sourceLine?.parentElement) {resetSubtitlePanelLayout(sourceLine.parentElement); sourceLine.parentElement.setAttribute('role', 'region');}
        if (sourceLine?.textContent) sourceLine.textContent = '';
        if (translatedLine?.textContent) translatedLine.textContent = '';
        if (readingLine) { readingLine.textContent = ''; readingLine.hidden = true; }
        if (retry && !retry.hidden) retry.hidden = true;
        if (host && !host.hidden) host.hidden = true;
    };
    const setTrackMode = (track: TextTrack, next: TextTrackMode) => {
        const owned = trackModes.get(track);
        if (owned && track.mode !== owned.applied) trackModes.delete(track);
        if (track.mode === next) return;
        const previous = trackModes.get(track)?.previous || track.mode;
        trackModes.set(track, {previous, applied: next});
        track.mode = next;
    };
    const ensureUi = () => {
        const parent = document.fullscreenElement || document.body;
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
        host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483646!important;pointer-events:none!important;box-sizing:border-box!important;';
        const shadow = host.attachShadow({mode: 'open'});
        const style = document.createElement('style');
        style.textContent = `:host([hidden]){display:none!important}*{box-sizing:border-box}.panel{font-family:var(--fluent-read-video-subtitle-font-family);text-align:center;line-height:var(--fluent-read-video-subtitle-line-spacing);font-size:20px;text-shadow:var(--fluent-read-video-subtitle-text-shadow);background:var(--fluent-read-video-subtitle-background);border-radius:8px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:hidden}.panel[data-fluent-read-subtitle-scrollable="true"]{overflow-y:auto;overflow-x:hidden;pointer-events:auto;overscroll-behavior:contain;touch-action:pan-y pinch-zoom}.panel[data-fluent-read-subtitle-scrollable="true"]:focus-visible{outline:2px solid currentColor;outline-offset:-2px}.source,.reading{color:var(--fluent-read-video-subtitle-text-color)}.reading{font-size:max(12px,.72em);line-height:1.35}.translation{color:var(--fluent-read-video-subtitle-translation-color)}.source,.translation{-webkit-text-stroke:var(--fluent-read-video-subtitle-text-stroke);paint-order:stroke fill}.tools{display:flex;justify-content:center;gap:8px;margin-top:4px;opacity:.8;pointer-events:auto;text-shadow:none;-webkit-text-stroke:0}select,button{font:12px system-ui;color:#fff;background:#17222e;border:1px solid #8c98a5;border-radius:5px;padding:3px 7px}select:focus-visible,button:focus-visible{outline:2px solid #ffe45c}[hidden]{display:none!important}`;
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', ports.label('双语字幕'));
        sourceLine = document.createElement('div'); sourceLine.className = 'source fluent-read-video-subtitle-original';
        readingLine = document.createElement('div'); readingLine.className = 'reading'; readingLine.hidden = true;
        translatedLine = document.createElement('div'); translatedLine.className = 'translation';
        const tools = document.createElement('div'); tools.className = 'tools';
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
        if (course) mode.hidden = true;
        tools.append(mode, retry); panel.append(sourceLine, readingLine, translatedLine, tools); shadow.append(style, panel); parent.appendChild(host);
    };

    const selectVideo = () => {
        let selected: {video: HTMLVideoElement; bounds: DOMRect; paused: boolean; area: number} | null = null;
        for (const node of document.querySelectorAll<HTMLVideoElement>('video')) {
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
            let parent = video?.parentElement;
            if (!parent) return [];
            while (parent.parentElement && parent !== document.body && !parent.querySelector(PLATFORM_CAPTION_SELECTORS[platform])
                && parent.parentElement.querySelectorAll('video').length === 1) parent = parent.parentElement;
            root = parent;
        }
        const candidates = Array.from(root.querySelectorAll<HTMLElement>(PLATFORM_CAPTION_SELECTORS[platform]));
        return candidates.filter(node => !node.closest('#fluent-read-platform-captions, [hidden], [aria-hidden="true"]')
            && !candidates.some(other => other !== node && node.contains(other)));
    };

    const syncTracks = () => {
        if (!video) return;
        const tracks = Array.from(video.textTracks || []).filter(track => track.kind === 'subtitles' || track.kind === 'captions');
        const entries = tracks.map(track => ({track, languageCode: track.language, name: track.label}));
        const human = config.videoPreferHumanSubtitles ? chooseTargetHumanCaptionTrack(entries, config.to)?.track || null : null;
        const showing = tracks.find(track => track.mode === 'showing');
        const original = showing || (sourceTrack && tracks.includes(sourceTrack) ? sourceTrack : null)
            || tracks.find(track => !captionLanguageMatch(track.language, config.to)) || tracks[0] || null;
        if (original !== sourceTrack || human !== targetTrack) {
            restoreCaptions(); clear(); sourceTrack = original; targetTrack = human;
        }
        // hidden 会让浏览器加载字幕但不重复绘制；退出或关闭时恢复此前模式。
        if (sourceTrack) setTrackMode(sourceTrack, 'hidden');
        if (targetTrack) setTrackMode(targetTrack, 'hidden');
    };

    const sync = () => {
        if (disposed) return;
        const href = routeHref();
        if (route !== href) {
            route = href; clear(); restoreCaptions(); restoreAutoButton(); cache.clear(); readings.clear();
            clickedButtons = new WeakSet();
            sourceTrack = null; targetTrack = null; mediaKey = '';
            timeline.clear(); courseIdentity = ''; manualEnabled = null; lastPlayedVideo = null;
        }
        const activePlatform = getCaptionPlatform(window.location) === platform;
        if (!activePlatform || !config.on || !config.videoTranslationEnabled) {
            clear(); restoreCaptions(); restoreAutoButton(); timeline.clear(); removeCourseControls(); return;
        }
        if (!course && config.videoSubtitleVisible === false) { clear(); restoreCaptions(); restoreAutoButton(); return; }
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
            clear(); restoreCaptions(); cache.clear(); readings.clear(); video = nextVideo; mediaKey = nextKey; sourceTrack = null; targetTrack = null;
            timeline.clear(); courseIdentity = ''; manualEnabled = null;
        }
        const enabled = captionsEnabled();
        const request = course && video && enabled ? getCourseCaptionRequest(course, new URL(window.location.href), video) : null;
        const identity = request?.key || '';
        if (identity !== courseIdentity) { courseIdentity = identity; clear(); restoreCaptions(); cache.clear(); readings.clear(); }
        timeline.sync(request, mediaKey);
        syncCourseControls();
        if (!enabled) { clear(); restoreCaptions(); restoreAutoButton(); return; }
        if (!meeting && (!video || video.seeking || video.ended || video.readyState === 0)) { clear(); restoreCaptions(); return; }
        syncTracks();
        const nodes = nativeNodes();
        const time = video ? video.currentTime - config.videoSubtitleOffsetMs / 1000 : 0;
        const cue = timeline.status === 'ready' ? selectVideoSubtitleCueAtOffset(timeline.cues, time * 1000, 0) : null;
        const source = normalizeVideoCaptionText(request ? timeline.status === 'ready' ? cue?.text || '' : '' : sourceTrack?.cues?.length ? trackTextAt(sourceTrack, time)
            : nodes.map(node => node.textContent || '').slice(-3).join(' ')).slice(0, 3000);
        const human = course && timeline.status === 'ready' ? '' : trackTextAt(targetTrack, time);
        if (course && video?.paused) cache.retainPrefetches([]);
        if (!source) { clear(); restoreCaptions(); return; }
        ensureUi();
        if (!host || !sourceLine || !translatedLine || !mode) return;
        const appearance = getVideoSubtitleAppearanceCssVars(config.videoSubtitleAppearance);
        for (const [key, value] of Object.entries(appearance)) setStyleIfChanged(host.style, key, value);
        const bounds = selection?.bounds;
        const width = (bounds?.width || window.innerWidth) * config.videoSubtitleAppearance.maxWidth / 100;
        const left = (bounds?.left || 0) + ((bounds?.width || window.innerWidth) - width) / 2;
        const top = bounds?.top || 0, height = bounds?.height || window.innerHeight;
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
        if (nextSignature === signature) { fit(); return; }
        signature = nextSignature;
        const current = ++generation;
        if (translatedLine.textContent) translatedLine.textContent = '';
        if (!retry!.hidden) retry!.hidden = true;
        if (config.videoSubtitleDisplayMode === 'original-only') { cache.cancelPending(); fit(); return; }
        const show = (text: string) => {
            if (disposed || current !== generation || !translatedLine) return;
            const translation = text === source && config.videoSubtitleDisplayMode === 'bilingual' ? '' : text;
            if (translatedLine.textContent !== translation) translatedLine.textContent = translation;
            fit();
        };
        if (human) { show(human); return; }
        fit();
        const showFailure = () => {
            if (disposed || current !== generation || !translatedLine || !retry) return;
            translatedLine.textContent = ports.label('这句翻译失败'); retry.hidden = false; fit();
        };
        void cache.request(source).then(text => {
            if (!text && cache.hasFailure(source)) showFailure();
            else show(text);
        }).catch(showFailure);
        if (timeline.status === 'ready' && video && !video.paused) {
            // 当前句先获得调度资格；只准备接下来十秒，用户暂停或原文模式不产生预取。
            cache.primeUpcoming(timeline.cues, time * 1000, 10_000, video.playbackRate, (text, prefetch) => cache.request(text, prefetch));
        }
    };

    const schedule = () => { if (!disposed && pendingTimer === undefined) pendingTimer = setTimeout(() => { pendingTimer = undefined; sync(); }, 80); };
    const invalidateLayout = () => { fittedInputs = null; schedule(); };
    const releaseUserControls = (event: MouseEvent) => {
        if (!event.isTrusted) return;
        const target = event.target as Node | null;
        if (target && autoButton?.contains(target)) autoButton = null;
        for (const button of menuButtons) if (target && button.contains(target)) menuButtons.delete(button);
    };
    const observer = new MutationObserver(records => {
        if (records.some(record => !(record.target as Element).closest?.('#fluent-read-platform-captions, #fluent-read-course-controls'))) schedule();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
    const timer = setInterval(sync, 250);
    const unsubscribe = ports.subscribe(() => {
        const next = getVideoTranslationConfigFingerprint(config);
        if (next !== fingerprint) { fingerprint = next; cache.clear(); clear(); }
        sync();
    });
    document.addEventListener('fullscreenchange', invalidateLayout);
    document.addEventListener('seeking', schedule, true);
    const played = (event: Event) => {
        if (course && (event.target as Element | null)?.tagName === 'VIDEO') { lastPlayedVideo = event.target as HTMLVideoElement; schedule(); }
    };
    document.addEventListener('play', played, true);
    const paused = (event: Event) => { if (event.target === video) cache.retainPrefetches([]); };
    document.addEventListener('pause', paused, true);
    document.addEventListener('click', releaseUserControls, true);
    window.addEventListener('resize', invalidateLayout);
    document.fonts?.addEventListener('loadingdone', invalidateLayout);
    sync();
    return () => {
        disposed = true; clear(); cache.clear(); readings.destroy(); restoreCaptions(); restoreAutoButton(); timeline.clear(); removeCourseControls();
        if (sourceLine?.parentElement) resetSubtitlePanelLayout(sourceLine.parentElement, true);
        observer.disconnect(); clearInterval(timer); if (pendingTimer !== undefined) clearTimeout(pendingTimer);
        unsubscribe(); document.removeEventListener('fullscreenchange', invalidateLayout); document.removeEventListener('seeking', schedule, true);
        document.removeEventListener('click', releaseUserControls, true);
        document.removeEventListener('play', played, true);
        document.removeEventListener('pause', paused, true);
        window.removeEventListener('resize', invalidateLayout); document.fonts?.removeEventListener('loadingdone', invalidateLayout);
        host?.remove(); host = null;
    };
}
