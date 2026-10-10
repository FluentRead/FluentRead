/**
 * @file src/features/video-subtitle/content/platformRuntime.ts
 * 文件职责：在会议、Udemy 与 Disney+ 网页中挂载隔离的双语字幕，复用现有视频配置及翻译缓存。
 * 主要内容：观察原生字幕、读取浏览器字幕轨、自动开启明确的会议字幕按钮、优先目标语言人工轨；处理显示切换、失败重试、全屏、动态页面、大字号高度适配与所有权恢复。
 * 模块边界：只通过注入端口读取配置、翻译和保存设置，不采集音频、不访问账号接口，不修改网站播放器实现。
 */
import type {Config} from '@/src/core/config/model';
import {getVideoSubtitleAppearanceCssVars} from '@/src/core/config/videoSubtitleAppearance';
import {getVideoTranslationConfigFingerprint, normalizeVideoCaptionText} from './subtitleLogic';
import {VideoTranslationCache} from './translationCache';
import {fitVideoSubtitleFontSize} from './subtitleLayout';
import {isVideoSubtitleInTargetLanguage} from './subtitleLanguage';
import {chooseTargetHumanCaptionTrack, getCaptionPlatform, isMeetingCaptionPlatform, PLATFORM_CAPTION_SELECTORS, findCaptionEnableButton, findTeamsCaptionMenuStep, captionLanguageMatch} from './platforms';

interface PlatformCaptionPorts {
    document: Document;
    window: Window;
    config: Config;
    subscribe(listener: (config: Config) => void): () => void;
    translate(text: string, signal: AbortSignal): Promise<string>;
    patch(patch: Partial<Config>): void;
    label(text: string): string;
}

function trackTextAt(track: TextTrack | null, time: number): string {
    if (!track?.cues || !Number.isFinite(time)) return '';
    return Array.from(track.cues).filter(cue => time >= cue.startTime && time < cue.endTime)
        .map(cue => (cue as VTTCue).text || '').join(' ').replace(/<[^>]*>/g, '').trim();
}

/** 生命周期完全属于当前内容 feature；配置停用时取消请求并恢复本功能修改的原生显示。 */
export function mountPlatformCaptions(ports: PlatformCaptionPorts): () => void {
    const {document, window, config} = ports;
    const platform = getCaptionPlatform(window.location);
    if (!platform) return () => undefined;
    const meeting = isMeetingCaptionPlatform(platform);
    const cache = new VideoTranslationCache((text, signal) => isVideoSubtitleInTargetLanguage(text, config.to)
        ? Promise.resolve(text) : ports.translate(text, signal));
    const trackModes = new Map<TextTrack, {previous: TextTrackMode; applied: TextTrackMode}>();
    const captionVisibility = new Map<HTMLElement, {value: string; priority: string}>();
    let clickedButtons = new WeakSet<HTMLElement>();
    const menuButtons = new Set<HTMLElement>();
    let autoButton: HTMLElement | null = null;
    let host: HTMLElement | null = null;
    let sourceLine: HTMLElement | null = null;
    let translatedLine: HTMLElement | null = null;
    let retry: HTMLButtonElement | null = null;
    let mode: HTMLSelectElement | null = null;
    let generation = 0;
    let disposed = false;
    let signature = '';
    let route = window.location.href;
    let video: HTMLVideoElement | null = null;
    let sourceTrack: TextTrack | null = null;
    let targetTrack: TextTrack | null = null;
    let mediaKey = '';
    let fingerprint = getVideoTranslationConfigFingerprint(config);
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

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
        cache.cancelPending();
        if (sourceLine) sourceLine.textContent = '';
        if (translatedLine) translatedLine.textContent = '';
        if (retry) retry.hidden = true;
        if (host) host.hidden = true;
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
        if (host) { if (host.parentElement !== parent) parent.appendChild(host); return; }
        host = document.createElement('div');
        host.id = 'fluent-read-platform-captions';
        host.className = 'notranslate';
        host.setAttribute('translate', 'no');
        host.setAttribute('data-fluent-read-owned', 'true');
        host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483646!important;pointer-events:none!important;box-sizing:border-box!important;';
        const shadow = host.attachShadow({mode: 'open'});
        const style = document.createElement('style');
        style.textContent = `:host([hidden]){display:none!important}*{box-sizing:border-box}.panel{font-family:var(--fluent-read-video-subtitle-font-family);text-align:center;line-height:var(--fluent-read-video-subtitle-line-spacing);font-size:20px;text-shadow:var(--fluent-read-video-subtitle-text-shadow);background:var(--fluent-read-video-subtitle-background);border-radius:8px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:hidden}.source{color:var(--fluent-read-video-subtitle-text-color)}.translation{color:var(--fluent-read-video-subtitle-translation-color)}.tools{display:flex;justify-content:center;gap:8px;margin-top:4px;opacity:.8;pointer-events:auto}select,button{font:12px system-ui;color:#fff;background:#17222e;border:1px solid #8c98a5;border-radius:5px;padding:3px 7px}select:focus-visible,button:focus-visible{outline:2px solid #ffe45c}[hidden]{display:none!important}`;
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', ports.label('双语字幕'));
        sourceLine = document.createElement('div'); sourceLine.className = 'source';
        translatedLine = document.createElement('div'); translatedLine.className = 'translation';
        const tools = document.createElement('div'); tools.className = 'tools';
        mode = document.createElement('select'); mode.setAttribute('aria-label', ports.label('字幕显示模式'));
        for (const [value, label] of [['bilingual', '双语'], ['translation-only', '仅译文'], ['original-only', '仅原文'], ['off', '关闭']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = ports.label(label); mode.appendChild(option);
        }
        mode.addEventListener('change', () => ports.patch(mode!.value === 'off' ? {videoSubtitleVisible: false}
            : {videoSubtitleDisplayMode: mode!.value as Config['videoSubtitleDisplayMode']}));
        retry = document.createElement('button'); retry.type = 'button'; retry.textContent = ports.label('重试'); retry.hidden = true;
        retry.addEventListener('click', () => { cache.retryFailures(); signature = ''; schedule(); });
        tools.append(mode, retry); panel.append(sourceLine, translatedLine, tools); shadow.append(style, panel); parent.appendChild(host);
    };

    const selectVideo = () => {
        const candidates = Array.from(document.querySelectorAll<HTMLVideoElement>('video')).filter(node => {
            const bounds = node.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0 && !node.closest('[hidden], [aria-hidden="true"]');
        });
        return candidates.sort((a, b) => Number(a.paused) - Number(b.paused)
            || b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || null;
    };
    const nativeNodes = () => {
        let root: ParentNode = document;
        if (!meeting) {
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
        const enabled = config.on && config.videoTranslationEnabled && config.videoSubtitleVisible !== false
            && getCaptionPlatform(window.location) === platform;
        if (!enabled) { clear(); restoreCaptions(); restoreAutoButton(); return; }
        if (route !== window.location.href) {
            route = window.location.href; clear(); restoreCaptions(); restoreAutoButton(); cache.clear();
            clickedButtons = new WeakSet();
            sourceTrack = null; targetTrack = null; mediaKey = '';
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
        const nextVideo = meeting ? null : selectVideo();
        const nextKey = nextVideo ? `${route}:${nextVideo.currentSrc || nextVideo.getAttribute('src') || ''}` : '';
        if (nextVideo !== video || nextKey !== mediaKey) {
            clear(); restoreCaptions(); cache.clear(); video = nextVideo; mediaKey = nextKey; sourceTrack = null; targetTrack = null;
        }
        if (!meeting && (!video || video.seeking || video.ended || video.readyState === 0)) { clear(); restoreCaptions(); return; }
        syncTracks();
        const nodes = nativeNodes();
        const time = video ? video.currentTime - config.videoSubtitleOffsetMs / 1000 : 0;
        const source = normalizeVideoCaptionText(sourceTrack?.cues?.length ? trackTextAt(sourceTrack, time)
            : nodes.map(node => node.textContent || '').slice(-3).join(' ')).slice(0, 3000);
        const human = trackTextAt(targetTrack, time);
        if (!source) { clear(); restoreCaptions(); return; }
        ensureUi();
        if (!host || !sourceLine || !translatedLine || !mode) return;
        for (const [key, value] of Object.entries(getVideoSubtitleAppearanceCssVars(config.videoSubtitleAppearance))) host.style.setProperty(key, value);
        const bounds = video?.getBoundingClientRect();
        const width = (bounds?.width || window.innerWidth) * config.videoSubtitleAppearance.maxWidth / 100;
        const left = (bounds?.left || 0) + ((bounds?.width || window.innerWidth) - width) / 2;
        const top = bounds?.top || 0, height = bounds?.height || window.innerHeight;
        host.style.setProperty('left', `${left}px`, 'important'); host.style.setProperty('width', `${width}px`, 'important');
        const position = config.videoSubtitleAppearance.position;
        host.style.setProperty('top', `${top + height * (position === 'top' ? .08 : position === 'center' ? .5 : 1 - Math.max(.08, config.videoSubtitleAppearance.bottomOffset / 100))}px`, 'important');
        host.style.setProperty('transform', position === 'top' ? 'none' : position === 'center' ? 'translateY(-50%)' : 'translateY(-100%)', 'important');
        host.hidden = false;
        mode.value = config.videoSubtitleDisplayMode;
        sourceLine.hidden = config.videoSubtitleDisplayMode === 'translation-only';
        const panel = sourceLine.parentElement!;
        const maximumHeight = Math.max(24, height * (position === 'center' ? .9 : .84));
        panel.style.maxHeight = `${maximumHeight}px`;
        const fit = () => fitVideoSubtitleFontSize(20 * config.videoSubtitleAppearance.fontScale / 100, maximumHeight,
            size => { panel.style.fontSize = `${size}px`; }, () => panel.scrollHeight);
        sourceLine.textContent = source;
        fit();
        nodes.forEach(node => {
            if (!captionVisibility.has(node)) captionVisibility.set(node, {value: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility')});
            node.style.setProperty('visibility', 'hidden', 'important');
        });
        for (const node of captionVisibility.keys()) if (!node.isConnected) captionVisibility.delete(node);
        const nextSignature = `${fingerprint}:${config.videoSubtitleDisplayMode}:${source}:${human}`;
        if (nextSignature === signature) return;
        signature = nextSignature;
        const current = ++generation;
        translatedLine.textContent = ''; retry!.hidden = true;
        if (config.videoSubtitleDisplayMode === 'original-only') { cache.cancelPending(); return; }
        const show = (text: string) => {
            if (disposed || current !== generation || !translatedLine) return;
            translatedLine.textContent = text === source && config.videoSubtitleDisplayMode === 'bilingual' ? '' : text;
            fit();
        };
        if (human) { show(human); return; }
        void cache.request(source).then(show).catch(() => {
            if (disposed || current !== generation || !translatedLine || !retry) return;
            translatedLine.textContent = ports.label('这句翻译失败'); retry.hidden = false;
        });
    };

    const schedule = () => { if (!disposed && pendingTimer === undefined) pendingTimer = setTimeout(() => { pendingTimer = undefined; sync(); }, 80); };
    const releaseUserControls = (event: MouseEvent) => {
        if (!event.isTrusted) return;
        const target = event.target as Node | null;
        if (target && autoButton?.contains(target)) autoButton = null;
        for (const button of menuButtons) if (target && button.contains(target)) menuButtons.delete(button);
    };
    const observer = new MutationObserver(records => {
        if (records.some(record => !(record.target as Element).closest?.('#fluent-read-platform-captions'))) schedule();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
    const timer = setInterval(sync, 250);
    const unsubscribe = ports.subscribe(() => {
        const next = getVideoTranslationConfigFingerprint(config);
        if (next !== fingerprint) { fingerprint = next; cache.clear(); clear(); }
        sync();
    });
    document.addEventListener('fullscreenchange', schedule);
    document.addEventListener('seeking', schedule, true);
    document.addEventListener('click', releaseUserControls, true);
    window.addEventListener('resize', schedule);
    sync();
    return () => {
        disposed = true; clear(); cache.clear(); restoreCaptions(); restoreAutoButton();
        observer.disconnect(); clearInterval(timer); if (pendingTimer !== undefined) clearTimeout(pendingTimer);
        unsubscribe(); document.removeEventListener('fullscreenchange', schedule); document.removeEventListener('seeking', schedule, true);
        document.removeEventListener('click', releaseUserControls, true);
        window.removeEventListener('resize', schedule); host?.remove(); host = null;
    };
}
