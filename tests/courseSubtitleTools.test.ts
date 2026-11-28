import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createCourseSubtitleTools} from '@/src/features/video-subtitle/content/courseSubtitleTools';
import {createVideoPlayerMenu} from '@/src/features/video-subtitle/content/playerMenu';
import type {MutableVideoSentenceLearningProps} from '@/src/features/video-subtitle/content/sentenceLearningHost';

const viewPort = vi.hoisted(() => ({mount: vi.fn(), unmount: vi.fn(), place: vi.fn(), dispose: vi.fn(), move: vi.fn()}));
vi.mock('vue', () => ({
    createApp: (instance: {render(): unknown}) => ({
        mount: (host: HTMLElement) => viewPort.mount(host, instance.render()),
        unmount: () => viewPort.unmount(),
    }),
    h: (_view: unknown, props: MutableVideoSentenceLearningProps) => props,
    shallowReactive: <T>(value: T) => value,
}));
vi.mock('@/src/features/video-subtitle/ui/VideoSentenceLearning.vue', () => ({default: {name: 'LessonView'}}));
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));
vi.mock('@/src/features/video-subtitle/content/sentenceLearningPlacement', () => ({
    createVideoLearningPlacementOwner: () => ({
        place: viewPort.place.mockImplementation(() => ({syncPlayer: viewPort.move, isConnected: () => true, destroy: vi.fn()})),
        dispose: viewPort.dispose,
    }),
}));

const cues = [{startMs: 200, durationMs: 900, text: 'A complete first sentence.'},
    {startMs: 1100, durationMs: 1100, text: 'A new sentence follows.'}];

function fixture(platform: 'bilibili' | 'udemy' | 'edx' = 'bilibili', learningStyleUrl?: string) {
    const {document, window} = parseHTML('<html><body><div id="player"><video></video></div></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const doc = document as unknown as Document;
    const player = doc.getElementById('player')!, video = doc.querySelector('video')!;
    const config = new Config();
    Object.assign(config, {on: true, videoTranslationEnabled: true, from: 'en', to: 'zh-Hans'});
    const location = new URL(platform === 'bilibili' ? 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&utm_medium=inbox#section'
        : platform === 'edx' ? 'https://courses.edx.org/courseware/unit' : 'https://www.udemy.com/course/demo/learn/lecture/123') as unknown as Location;
    let identity = 'lesson:1';
    let active: {player: HTMLElement; video: HTMLVideoElement} | null = {player, video};
    const track = {cues, languageCode: 'en', sourceLanguage: 'en'};
    const readCompleteTrack = vi.fn<() => typeof track | null>(() => track);
    const translate = vi.fn(async (source: string, _signal: AbortSignal, _language: string) => `译文 ${source}`);
    const save = vi.fn();
    const tools = createCourseSubtitleTools({platform, config, document: doc, location, learningStyleUrl,
        subscribe: () => vi.fn(), readTarget: () => active, readCompleteTrack, readIdentity: () => identity,
        peek: () => undefined, translate, save, updateMenu: vi.fn()});
    const replacePlayer = (next: HTMLElement | null) => {active = next ? {player: next, video} : null;};
    const changeLesson = () => {identity = 'lesson:2';tools.sync();};
    return {tools, doc, window, player, config, video, replacePlayer, changeLesson, track, readCompleteTrack, translate, save};
}

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('Course subtitle study and export', () => {
    it('loads the course frame stylesheet once the learner opens and removes it on teardown', async () => {
        const href = 'chrome-extension://fixture/content-scripts/supportedFrame.css';
        const f = fixture('edx', href);
        expect(f.doc.querySelector('link[rel="stylesheet"]')).toBeNull();
        await f.tools.openLearning();
        expect(f.doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe(href);
        f.changeLesson();
        await f.tools.openLearning();
        expect(f.doc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
        f.tools.destroy();
        expect(f.doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    });
    it('reuses the sentence panel and playback owner, keeps the Bilibili part and unmounts on lesson change', async () => {
        const f = fixture();
        await f.tools.openLearning();
        const props = viewPort.mount.mock.calls[0][1] as MutableVideoSentenceLearningProps;
        expect(props.sourceUrl).toBe('https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
        expect(props.cues).toEqual(cues);
        expect(props.sourceLanguage).toBe('en');
        const signal = new AbortController().signal;
        await props.translate!(cues[0].text, signal);
        expect(f.translate).toHaveBeenCalledWith(cues[0].text, signal, 'en');
        expect(f.doc.head.querySelectorAll('style')).toHaveLength(0);
        expect(f.doc.documentElement.querySelectorAll('style')).toHaveLength(1);
        const fullscreen = f.doc.createElement('div');
        f.doc.body.append(fullscreen);
        fullscreen.append(f.video);
        f.replacePlayer(fullscreen);
        f.tools.sync();
        expect(viewPort.move).toHaveBeenCalledWith(fullscreen);
        expect(viewPort.mount).toHaveBeenCalledOnce();
        f.changeLesson();
        expect(viewPort.unmount).toHaveBeenCalledOnce();
        await f.tools.openLearning();
        expect(viewPort.mount).toHaveBeenCalledTimes(2);
        expect(f.doc.documentElement.querySelectorAll('style')).toHaveLength(1);
        f.readCompleteTrack.mockReturnValue(null);
        f.tools.sync();
        expect(f.tools.canOpen()).toBe(false);
        await expect(props.translate!(cues[0].text, signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(viewPort.unmount).toHaveBeenCalledTimes(2);
        f.tools.destroy();
        expect(viewPort.dispose).toHaveBeenCalledOnce();
        expect(f.doc.documentElement.querySelectorAll('style')).toHaveLength(0);
    });

    it('cancels a pending export after switching lessons and only translates the current track after confirmation', async () => {
        vi.useFakeTimers();
        const f = fixture('edx');
        const menu = createVideoPlayerMenu('zh-CN', true);
        f.doc.body.append(menu);
        const button = menu.querySelector<HTMLButtonElement>('[data-action="download-bilingual-subtitles"]')!;
        const pending = f.tools.startDownload(menu, button, 'bilingual');
        await vi.advanceTimersByTimeAsync(0);
        expect(menu.querySelector('[data-export-choice="complete"]')).not.toBeNull();
        f.changeLesson();
        await pending;
        expect(f.translate).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
        const translated = f.tools.startDownload(menu, button, 'translated');
        await vi.advanceTimersByTimeAsync(0);
        const event = Object.assign(new f.window.Event('click', {bubbles: true, cancelable: true}), {isTrusted: true});
        menu.querySelector<HTMLButtonElement>('[data-export-choice="complete"]')!.dispatchEvent(event as unknown as Event);
        await translated;
        expect(f.translate).toHaveBeenCalledTimes(2);
        expect(f.save).toHaveBeenCalledWith(expect.stringContaining('00:00:00,200 --> 00:00:01,100'), 'zh-Hans-translated', expect.any(Array), 'srt');
        f.tools.destroy();
    });

    it('closes the panel when the current video loses its player and rejects missing subtitle exports', async () => {
        const f = fixture('udemy');
        await f.tools.openLearning();
        f.replacePlayer(null);
        f.tools.sync();
        expect(viewPort.unmount).toHaveBeenCalledOnce();
        f.config.videoTranslationEnabled = false;
        expect(f.tools.canOpen()).toBe(false);
        f.config.videoTranslationEnabled = true;
        f.replacePlayer(f.player);
        await f.tools.openLearning();
        f.replacePlayer(f.doc.createElement('div'));
        f.tools.sync();
        expect(viewPort.unmount).toHaveBeenCalledTimes(2);
        const menu = createVideoPlayerMenu('zh-CN', true);
        f.doc.body.append(menu);
        const button = menu.querySelector<HTMLButtonElement>('[data-action="download-subtitles"]')!;
        const format = menu.querySelector<HTMLSelectElement>('[data-subtitle-format]')!;
        Object.defineProperty(format, 'value', {value: 'md'});
        await f.tools.startDownload(menu, button, 'original');
        expect(f.save).toHaveBeenCalledWith(expect.stringContaining(cues[0].text), 'en', expect.any(Array), 'md');
        const operation = f.tools.startDownload(menu, button, 'original');
        f.changeLesson();
        await operation;
        f.readCompleteTrack.mockReturnValue(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await f.tools.startDownload(menu, button, 'original');
            expect(warn).toHaveBeenCalledExactlyOnceWith('[FluentRead] 字幕下载失败', expect.any(Error));
        } finally {
            warn.mockRestore();
            f.tools.destroy();
        }
        expect(f.save).toHaveBeenCalledOnce();
        expect(f.tools.canOpen()).toBe(false);
    });
});
