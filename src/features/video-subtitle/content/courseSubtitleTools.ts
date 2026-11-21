/**
 * @file src/features/video-subtitle/content/courseSubtitleTools.ts
 * 文件职责：把完整课程字幕轨接入通用逐句学习和双语导出。
 * 主要内容：对当前媒体和字幕轨复用句子面板、播放、词本和用户确认的补译流程；切换视频、字幕或设置时释放旧面板和导出。
 * 模块边界：不探测课程接口、不改变播放器字幕设置；稳定字幕轨、翻译服务和文件保存由课程运行时提供。
 */
import {createApp, h, shallowReactive} from 'vue';
import type {Config} from '@/src/core/config/model';
import type {VideoCoursePlatform} from '@/src/core/config/videoCourse';
import sentenceLearningStyles from '../ui/videoSentenceLearning.css?inline';
import {createVideoSubtitleDownloads} from './downloads';
import {confirmVideoSubtitleExport} from './exportPrompt';
import {setVideoMenuDownloadStatus} from './playerMenu';
import {createVideoLearningPlacementOwner} from './sentenceLearningPlacement';
import {createVideoSentenceLearningSession, type VideoSentenceLearningTarget} from './sentenceLearningSession';
import type {MutableVideoSentenceLearningProps} from './sentenceLearningHost';
import {getVideoUiLanguage, markVideoUi, translateVideoUi} from './ui';
import {createVideoSubtitleAbortError} from './subtitleLogic';
import type {SubtitleExportFormat} from './subtitleExport';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

interface CourseTrack {cues: VideoSubtitleCue[]; languageCode: string; sourceLanguage: string}
interface CourseSubtitleToolsPorts {
    platform: VideoCoursePlatform;
    config: Config;
    document: Document;
    location: Location;
    subscribe(listener: (config: Config) => void): () => void;
    readTarget(): VideoSentenceLearningTarget | null;
    readCompleteTrack(): CourseTrack | null;
    readIdentity(): string;
    translate(text: string, signal: AbortSignal, sourceLanguage: string): Promise<string>;
    peek(source: string): string | undefined;
    save(srt: string, label: string, cues: readonly VideoSubtitleCue[], format: SubtitleExportFormat): void;
    updateMenu(): void;
}

export function createCourseSubtitleTools(ports: CourseSubtitleToolsPorts) {
    const {config, document, location} = ports;
    let disposed = false;
    let exportMenu: HTMLElement | undefined;
    let exportFormat: SubtitleExportFormat = 'srt';
    let identity = ports.readIdentity();
    let style: HTMLStyleElement | undefined;
    const sourceUrl = () => {
        const url = new URL(location.href);
        const part = url.searchParams.get('p');
        url.username = ''; url.password = ''; url.hash = ''; url.search = '';
        if (ports.platform === 'bilibili' && part && /^[1-9]\d*$/u.test(part)) url.searchParams.set('p', part);
        return url.href;
    };
    const ui = (key: string, params?: Record<string, string | number>) =>
        translateVideoUi(key, getVideoUiLanguage(config.uiLanguage), params);
    const placement = createVideoLearningPlacementOwner(() => config.videoSentenceLearningAppearance, ports.subscribe);
    const currentTrack = () => !disposed && config.on && config.videoTranslationEnabled ? ports.readCompleteTrack() : null;
    const canOpen = () => Boolean(currentTrack()?.cues.length);
    const translate = (text: string, signal: AbortSignal) => {
        const track = currentTrack();
        return track ? ports.translate(text, signal, track.sourceLanguage) : Promise.reject(createVideoSubtitleAbortError());
    };
    const learning = createVideoSentenceLearningSession({
        markUi: markVideoUi,
        place: placement.place,
        load: async () => (await import('../ui/VideoSentenceLearning.vue')).default,
        mount(view, host, props) {
            if (!style) {
                style = document.createElement('style');
                style.textContent = sentenceLearningStyles;
                document.documentElement.appendChild(style);
            }
            const app = createApp({render: () => h(view, props)});
            app.mount(host);
            return () => app.unmount();
        },
        readTarget: ports.readTarget,
        canOpen,
        readProps: ({video}, onClose) => {
            // 学习会话在调用读数前同步确认完整轨可读。
            const track = ports.readCompleteTrack()!;
            return shallowReactive<MutableVideoSentenceLearningProps>({
                platform: 'html', sourceUrl: sourceUrl(), title: document.title, video,
                cues: track.cues, sourceLanguage: track.sourceLanguage,
                targetLanguage: config.to, onClose, translate,
            });
        },
    });
    const downloads = createVideoSubtitleDownloads({
        config, location, readCompleteTrack: ports.readCompleteTrack, isDisposed: () => disposed,
        human: {ready: async () => undefined, at: () => ''},
        translate, peek: ports.peek, contextKey: ports.readIdentity, ui,
        confirm: (menu, preview, bilingual, signal) => confirmVideoSubtitleExport(menu, preview, bilingual, signal, ui),
        status: setVideoMenuDownloadStatus,
        save: (srt, label, cues) => ports.save(srt, label, cues, exportFormat),
        refreshButtons: ports.updateMenu,
    });
    const cancelExports = () => {
        downloads.cancel();
        if (exportMenu) setVideoMenuDownloadStatus(exportMenu, '');
        exportMenu = undefined;
    };
    function sync() {
        const current = ports.readIdentity();
        const track = currentTrack();
        if (identity !== current || !track?.cues.length) {
            identity = current;
            cancelExports();
            learning.close();
        } else if (learning.isOpen()) {
            const target = ports.readTarget();
            if (!target || !learning.syncPlayer(target.player, target.video)) learning.close();
            else learning.updateCues(track.cues, track.sourceLanguage);
        }
    }
    return {
        sync,
        canOpen,
        openLearning: () => learning.open(),
        cancelExports,
        async startDownload(menu: HTMLElement, button: HTMLButtonElement, action: 'original' | 'translated' | 'bilingual') {
            const format = menu.querySelector<HTMLSelectElement>('[data-subtitle-format]')?.value;
            exportMenu = menu;
            exportFormat = format === 'vtt' || format === 'md' ? format : 'srt';
            if (action === 'original') await downloads.original(menu, button, error =>
                ui(error instanceof Error && error.name === 'AbortError' ? 'video.cancelled' : 'video.downloadFailed'));
            else await downloads.translated(menu, button, action === 'bilingual');
        },
        destroy() {
            disposed = true;
            cancelExports();
            downloads.destroy();
            learning.destroy();
            placement.dispose();
            style?.remove();
        },
    };
}
