import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

const configStorageMock = vi.hoisted(() => ({
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockReturnValue(() => undefined),
}));

vi.mock('@wxt-dev/storage', () => ({
    storage: configStorageMock,
}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: configStorageMock}));
vi.mock('webextension-polyfill', () => ({
    default: { runtime: { sendMessage: vi.fn() } },
}));
import {
    getVideoSubtitleDownloadErrorMessage,
    getVideoServiceLabel,
    getVideoPretranslationWindowMs,
    getVisibleVideoAiCue,
    mergeVideoAiSubtitleCues,
    isYouTubeVideoPage,
    isXHostPage,
    isXVideoPage,
    isSupportedVideoPage,
    isIncrementalVideoCaption,
    normalizeVideoSubtitleDisplayMode,
    normalizeVideoCaptionText,
    readVisibleCaptionText,
    revealVideoSubtitleTranslation,
    translateVideoSubtitleCues,
    VIDEO_CAPTION_SEGMENT_SELECTOR,
} from '@/src/features/video-subtitle/content/runtime';
import {applyVideoDisplayState, findVideoPlayer, findXSettingsControl} from '@/src/features/video-subtitle/content/ui';
import {validateYoutubeTimedTextMessage} from '@/src/features/video-subtitle/content/youtubeTimedTextMessage';
import {config} from '@/src/services/config/store';
import { normalizeVideoSubtitleFontSize } from '@/src/core/config/model';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('YouTube 视频字幕识别', () => {
    it('只把 YouTube 视频页识别为视频字幕目标', () => {
        expect(isYouTubeVideoPage({ hostname: 'www.youtube.com', pathname: '/watch' })).toBe(true);
        expect(isYouTubeVideoPage({ hostname: 'youtube-nocookie.com', pathname: '/embed/abc123' })).toBe(false);
        expect(isYouTubeVideoPage({ hostname: 'www.youtube.com', pathname: '/shorts/abc123' })).toBe(true);
        expect(isYouTubeVideoPage({ hostname: 'www.youtube.com', pathname: '/shorts' })).toBe(false);
        expect(isYouTubeVideoPage({ hostname: 'www.youtube.com', pathname: '/results' })).toBe(false);
        expect(isYouTubeVideoPage({ hostname: 'example.com', pathname: '/watch' })).toBe(false);
    });

    it('识别 X/Twitter 帖子、个人主页和时间线，播放器由当前交互选择', () => {
        expect(isXVideoPage({ hostname: 'x.com', pathname: '/cerebras/status/2089870131291943228' })).toBe(true);
        expect(isXVideoPage({ hostname: 'twitter.com', pathname: '/cerebras/status/2089870131291943228/' })).toBe(true);
        expect(isXVideoPage({ hostname: 'x.com', pathname: '/home' })).toBe(true);
        expect(isXHostPage({ hostname: 'x.com' })).toBe(true);
        expect(isXHostPage({ hostname: 'twitter.com' })).toBe(true);
        expect(isXHostPage({ hostname: 'example.com' })).toBe(false);
        expect(isSupportedVideoPage({ hostname: 'x.com', pathname: '/cerebras/status/2089870131291943228' })).toBe(true);
    });

    it('X 覆盖链接在 isolate 播放器外时提升到当前 post 的最近共同祖先', () => {
        const {document} = parseHTML(`<!doctype html><article><div class="relative h-full w-full"><div inert><div class="group relative isolate z-0"><video src="blob:https://x.com/mse"></video></div></div><a aria-label="View media" href="/cerebras/status/2089870131291943228/video/1"></a></div></article>`);
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', {location: {origin: 'https://x.com', hostname: 'x.com', href: 'https://x.com/cerebras/status/2089870131291943228', pathname: '/cerebras/status/2089870131291943228'}});

        const player = findVideoPlayer();
        expect(player?.querySelector('a[href*="/status/2089870131291943228/video/1"]')).toBeTruthy();
        expect(player?.className).toBe('relative h-full w-full');
    });

    it('X 多视频或无当前媒体覆盖链接时不跨 post 提升容器', () => {
        const {document} = parseHTML(`<!doctype html><main><article><div class="outer"><div class="group relative isolate"><video src="blob:https://x.com/one"></video><a href="/cerebras/status/2089870131291943228/video/1"></a></div><div class="group relative isolate"><video src="blob:https://x.com/two"></video><a href="/cerebras/status/2089870131291943228/video/2"></a></div></div></article><article><div class="other"><video src="blob:https://x.com/other"></video><a href="/someone/status/999/video/1"></a></div></article></main>`);
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', {location: {origin: 'https://x.com', hostname: 'x.com', href: 'https://x.com/cerebras/status/2089870131291943228', pathname: '/cerebras/status/2089870131291943228'}});

        const player = findVideoPlayer();
        expect(player).toBe(document.querySelector('video')?.parentElement);
    });

    it('提升后的 X 媒体覆盖容器不重新选取内层 settings 控件', () => {
        const {document} = parseHTML(`<!doctype html><article><div class="relative h-full w-full"><div class="group relative isolate"><video></video><button aria-label="Settings"></button></div><a aria-label="View media" href="/cerebras/status/2089870131291943228/video/1"></a></div></article>`);
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', {location: {origin: 'https://x.com', hostname: 'x.com', href: 'https://x.com/cerebras/status/2089870131291943228', pathname: '/cerebras/status/2089870131291943228'}});

        const player = findVideoPlayer();
        expect(player?.className).toBe('relative h-full w-full');
        expect(findXSettingsControl(player!)).toBeNull();
    });

    it('X 只提升当前 post，忽略更早视频、错误 status、外部链接和无 article 页面', () => {
        const {document} = parseHTML(`<!doctype html><main>
          <article><div class="earlier-player"><video src="blob:https://x.com/earlier"></video><a href="/someone/status/999/video/1"></a></div></article>
          <article><div class="current-player"><video src="blob:https://x.com/current"></video><a href="/cerebras/status/2089870131291943228/video/1"></a></div></article>
        </main>`);
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', {location: {origin: 'https://x.com', hostname: 'x.com', href: 'https://x.com/cerebras/status/2089870131291943228', pathname: '/cerebras/status/2089870131291943228'}});
        expect(findVideoPlayer()?.className).toBe('current-player');

        const wrong = parseHTML(`<!doctype html><article><div class="wrong-outer"><div class="wrong-player"><video></video></div><a href="/cerebras/status/111/video/1"></a><a href="https://example.com/cerebras/status/2089870131291943228/video/1"></a></div></article>`).document;
        vi.stubGlobal('document', wrong);
        expect(findVideoPlayer()?.className).toBe('wrong-player');

        const noArticle = parseHTML(`<!doctype html><main><div class="lone-player"><video></video></div><a href="/cerebras/status/2089870131291943228/video/1"></a></main>`).document;
        vi.stubGlobal('document', noArticle);
        expect(findVideoPlayer()?.className).toBe('lone-player');
    });

    it('按播放器中的字幕片段合并文本，并忽略空片段', () => {
        const segments = [
            { textContent: '  This is ', contains: () => false },
            { textContent: 'a test.\n', contains: () => false },
            { textContent: '', contains: () => false },
        ];
        const container = {
            querySelectorAll: (selector: string) => {
                expect(selector).toBe(VIDEO_CAPTION_SEGMENT_SELECTOR);
                return segments;
            },
        } as unknown as Element;

        expect(readVisibleCaptionText(container)).toBe('This is a test.');
        expect(readVisibleCaptionText(null)).toBe('');
    });

    it('优先读取叶子字幕片段，避免 YouTube 嵌套节点重复拼接', () => {
        const child = { textContent: 'A subtitle.', contains: () => false };
        const parent = { textContent: 'A subtitle.', contains: (node: unknown) => node === child };
        const container = {
            querySelectorAll: () => [parent, child],
        } as unknown as Element;

        expect(readVisibleCaptionText(container)).toBe('A subtitle.');
    });

    it('存在原生字幕片段时忽略字幕设置等 captions-text 文本', () => {
        const subtitle = { textContent: 'the axioms and the basics.', contains: () => false };
        const settings = { textContent: '英语（自动生成）点击 查看设置', contains: () => false };
        const container = {
            querySelectorAll: (selector: string) => selector === VIDEO_CAPTION_SEGMENT_SELECTOR ? [subtitle] : [settings],
        } as unknown as Element;

        expect(readVisibleCaptionText(container)).toBe('the axioms and the basics.');
    });

    it('保留播放器菜单需要的三种显示模式，并为服务显示用户可读名称', () => {
        const customProviders = [{
            id: 'custom:team',
            name: '团队视频模型',
            endpoint: 'https://gateway.example/v1',
            models: ['video-model'],
        }];
        expect(normalizeVideoSubtitleDisplayMode('translation-only')).toBe('translation-only');
        expect(normalizeVideoSubtitleDisplayMode('original-only')).toBe('original-only');
        expect(normalizeVideoSubtitleDisplayMode('unknown')).toBe('bilingual');
        expect(getVideoServiceLabel('microsoft')).toBe('微软翻译');
        expect(getVideoServiceLabel('custom-service')).toBe('custom-service');
        expect(getVideoServiceLabel('custom:team', customProviders)).toBe('团队视频模型');
        expect(getVideoPretranslationWindowMs('microsoft')).toBe(10_000);
        expect(getVideoPretranslationWindowMs('openai')).toBe(30_000);
        expect(getVideoPretranslationWindowMs('custom:team', customProviders)).toBe(30_000);
        expect(normalizeVideoSubtitleFontSize(undefined)).toBe(100);
        expect(normalizeVideoSubtitleFontSize(125)).toBe(130);
        expect(normalizeVideoSubtitleFontSize(10)).toBe(80);
        expect(normalizeVideoSubtitleFontSize(200)).toBe(160);
    });

    it('按原生字幕已经显示的前缀揭示完整 cue 的译文，并保留一次性完整字幕的整句结果', () => {
        const fullSource = 'understand from [music] the axioms and the basics.';
        const fullTranslation = '从音乐中理解公理和基础。';

        expect(normalizeVideoCaptionText('  understand\nfrom   [music]  ')).toBe('understand from [music]');
        expect(revealVideoSubtitleTranslation(fullTranslation, 'understand', fullSource)).toBe('从音乐');
        expect(revealVideoSubtitleTranslation(fullTranslation, 'understand from [music] the axioms and', fullSource)).toBe('从音乐中理解公理和基');
        expect(revealVideoSubtitleTranslation(fullTranslation, fullSource, fullSource)).toBe(fullTranslation);
        expect(revealVideoSubtitleTranslation(fullTranslation, 'unrelated subtitle', fullSource)).toBe(fullTranslation);
    });

    it('识别逐词前缀并允许播放器改用完整原文 cue', () => {
        expect(isIncrementalVideoCaption('understand from', 'understand from [music] the axioms and the basics.')).toBe(true);
        expect(isIncrementalVideoCaption('understand from [music] the axioms and the basics.', 'understand from [music] the axioms and the basics.')).toBe(false);
        expect(isIncrementalVideoCaption('unrelated subtitle', 'understand from [music] the axioms and the basics.')).toBe(false);
    });

    it('把原文字幕下载失败转换为用户可操作的提示', () => {
        expect(getVideoSubtitleDownloadErrorMessage(new Error('当前视频没有可用的 YouTube 字幕轨道'))).toBe('当前视频没有字幕');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('YouTube 未返回完整字幕数据，请先打开原生字幕后重试'))).toBe('请先开启 YouTube 字幕');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('字幕轨道请求失败（403）'))).toBe('获取失败，请重试');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('unknown'))).toBe('下载失败，请重试');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('当前视频没有可用的 YouTube 字幕轨道'), 'en-US')).toBe('This video has no subtitles');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('YouTube 未返回完整字幕数据，请先打开原生字幕后重试'), 'en-US')).toBe('Enable YouTube captions first');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('字幕轨道请求失败（403）'), 'en-US')).toBe('Could not fetch subtitles. Try again.');
        expect(getVideoSubtitleDownloadErrorMessage(new Error('unknown'), 'en-US')).toBe('Download failed. Try again.');
    });

    it('下载译文字幕时去重原文、限制并发并保留完整时间轴', async () => {
        let active = 0;
        let maxActive = 0;
        const progress: Array<[number, number]> = [];
        const translate = vi.fn(async (source: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return `译文：${source}`;
        });
        const cues = [
            { startMs: 0, durationMs: 1000, text: 'First subtitle.' },
            { startMs: 1200, durationMs: 900, text: 'Repeated subtitle.' },
            { startMs: 2300, durationMs: 900, text: 'Repeated subtitle.' },
            { startMs: 3500, durationMs: 1200, text: 'Last subtitle.' },
        ];

        const translated = await translateVideoSubtitleCues(cues, translate, {
            concurrency: 2,
            onProgress: (completed, total) => progress.push([completed, total]),
        });

        expect(translate).toHaveBeenCalledTimes(3);
        expect(maxActive).toBe(2);
        expect(progress[0]).toEqual([0, 3]);
        expect(progress.at(-1)).toEqual([3, 3]);
        expect(translated).toEqual(cues.map(cue => ({ ...cue, text: `译文：${cue.text}` })));
    });

    it('完整字幕中任一段翻译失败时拒绝生成残缺译文', async () => {
        const cues = [
            { startMs: 0, durationMs: 1000, text: 'First subtitle.' },
            { startMs: 1200, durationMs: 1000, text: 'Broken subtitle.' },
        ];

        await expect(translateVideoSubtitleCues(cues, async (source) => {
            if (source === 'Broken subtitle.') throw new Error('fixture translation failed');
            return `译文：${source}`;
        }, { concurrency: 1 })).rejects.toThrow('fixture translation failed');
    });
});

describe('YouTube timedtext MAIN bridge 消息边界', () => {
    const responseText = JSON.stringify({
        events: [{tStartMs: 0, dDurationMs: 1200, segs: [{utf8: 'Current subtitle.'}]}],
    });
    const payload = {
        source: 'fluent-read',
        type: 'fluent-read-youtube-timedtext',
        url: 'https://www.youtube.com/api/timedtext?v=current-video&lang=en',
        responseText,
    };

    it('只接收绑定到当前 watch/shorts videoId 的真实 timedtext URL', () => {
        expect(validateYoutubeTimedTextMessage(
            payload,
            'https://www.youtube.com/watch?v=current-video',
        )?.cues).toMatchObject([{text: 'Current subtitle.'}]);
        expect(validateYoutubeTimedTextMessage(
            {...payload, url: 'https://www.youtube.com/api/timedtext?v=stale-video&lang=en'},
            'https://www.youtube.com/watch?v=current-video',
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(
            {...payload, url: 'https://www.youtube.com/api/timedtext?v=short-id&lang=en'},
            'https://www.youtube.com/shorts/short-id',
        )?.cues).toHaveLength(1);
    });

    it('拒绝伪造协议、非 timedtext 资源与非播放页消息', () => {
        expect(validateYoutubeTimedTextMessage(
            {...payload, source: 'page-script'},
            'https://www.youtube.com/watch?v=current-video',
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(
            {...payload, url: 'https://www.youtube.com/watch?v=current-video'},
            'https://www.youtube.com/watch?v=current-video',
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(
            payload,
            'https://www.youtube.com/results?search_query=current-video',
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(payload, 'https://www.youtube-nocookie.com/embed/current-video'))
            .toBeNull();
        expect(validateYoutubeTimedTextMessage(payload, 'https://example.com/watch?v=current-video')).toBeNull();
        expect(validateYoutubeTimedTextMessage(payload, 'https://www.youtube.com/watch')).toBeNull();
        expect(validateYoutubeTimedTextMessage(payload, 'not a valid page URL')).toBeNull();
    });

    it.each([
        null,
        [],
        {},
        {...payload, type: 'forged-type'},
        {...payload, url: 42},
        {...payload, responseText: 42},
        {...payload, responseText: ''},
    ])('拒绝畸形 bridge payload：%j', (invalidPayload) => {
        expect(validateYoutubeTimedTextMessage(
            invalidPayload,
            'https://www.youtube.com/watch?v=current-video',
        )).toBeNull();
    });

    it('在解析和缓存前限制响应体积、cue 数量与单条文本长度', () => {
        const limits = {maxPayloadChars: responseText.length, maxCues: 1, maxCueChars: 20};
        expect(validateYoutubeTimedTextMessage(
            {...payload, responseText: `${responseText} `},
            'https://www.youtube.com/watch?v=current-video',
            limits,
        )).toBeNull();

        const twoCues = JSON.stringify({events: [
            {tStartMs: 0, dDurationMs: 1000, segs: [{utf8: 'First cue.'}]},
            {tStartMs: 10_000, dDurationMs: 1000, segs: [{utf8: 'Second cue.'}]},
        ]});
        expect(validateYoutubeTimedTextMessage(
            {...payload, responseText: twoCues},
            'https://www.youtube.com/watch?v=current-video',
            {...limits, maxPayloadChars: twoCues.length},
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(
            payload,
            'https://www.youtube.com/watch?v=current-video',
            {...limits, maxCueChars: 5},
        )).toBeNull();
        expect(validateYoutubeTimedTextMessage(
            {...payload, responseText: JSON.stringify({events: []})},
            'https://www.youtube.com/watch?v=current-video',
            limits,
        )).toBeNull();
    });

    it('合并 Whisper 分片边界的重复 cue，并在真实时间轴外及时清除', () => {
        const cues = mergeVideoAiSubtitleCues([
            { startMs: 0, durationMs: 1800, text: 'Hello world' },
            { startMs: 1700, durationMs: 800, text: 'Hello world' },
            { startMs: 2400, durationMs: 1000, text: 'Next sentence' },
        ]);

        expect(cues).toHaveLength(2);
        expect(cues[0]).toMatchObject({ startMs: 0, text: 'Hello world' });
        expect(cues[0].durationMs).toBe(2400);
        expect(getVisibleVideoAiCue(cues, 2450)?.text).toBe('Next sentence');
        expect(getVisibleVideoAiCue(cues, 8_000)).toBeNull();
    });

    it('填补短时间戳空隙，并让后一句在重叠处稳定接管', () => {
        const cues = mergeVideoAiSubtitleCues([
            { startMs: 0, durationMs: 900, text: 'First sentence' },
            { startMs: 1_300, durationMs: 900, text: 'Second sentence' },
            { startMs: 1_600, durationMs: 700, text: 'Third sentence' },
        ]);

        expect(cues[0]).toMatchObject({ startMs: 0, durationMs: 1_300, text: 'First sentence' });
        expect(cues[1]).toMatchObject({ startMs: 1_300, durationMs: 500, text: 'Second sentence' });
        expect(getVisibleVideoAiCue(cues, 1_200)?.text).toBe('First sentence');
        expect(getVisibleVideoAiCue(cues, 1_650)?.text).toBe('Third sentence');
    });
});

describe('独立字幕层显示模式', () => {
    it('双语、仅译文、仅原文和隐藏在 X 与 YouTube 字幕层同步且可恢复', () => {
        const {document} = parseHTML('<html><body><div id="fluent-read-video-ai-caption-container"></div><div id="fluent-read-video-subtitle-layer"></div></body></html>');
        vi.stubGlobal('document', document);
        const container = document.getElementById('fluent-read-video-ai-caption-container')!;
        const layer = document.getElementById('fluent-read-video-subtitle-layer')!;
        const previous = {videoSubtitleDisplayMode: config.videoSubtitleDisplayMode, videoSubtitleVisible: config.videoSubtitleVisible};
        try {
            for (const mode of ['translation-only', 'original-only', 'bilingual'] as const) {
                config.videoSubtitleDisplayMode = mode;
                applyVideoDisplayState(container);
                for (const node of [container, layer]) {
                    expect(node.classList.contains('fluent-read-video-display-translation-only')).toBe(mode === 'translation-only');
                    expect(node.classList.contains('fluent-read-video-display-original-only')).toBe(mode === 'original-only');
                }
            }
            config.videoSubtitleVisible = false;
            applyVideoDisplayState(container);
            expect(layer.classList.contains('fluent-read-video-display-hidden')).toBe(true);
        } finally { Object.assign(config, previous); }
    });
});
