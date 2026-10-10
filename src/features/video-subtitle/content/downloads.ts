/**
 * @file src/features/video-subtitle/content/downloads.ts
 * 文件职责：协调原文、译文与双语字幕导出，避免播放器运行时继续承载下载与人工轨回退细节。
 * 主要内容：选择 X 原生或完整 AI、YouTube 捕获或初始化轨道，拒绝把识别中的预览导出为完整字幕，优先人工目标时间轴和当前缓存，预览缺失范围与去重请求量，确认后补译或导出明确标记的已有条目；以媒体与配置身份隔离迟到结果，集中管理反馈计时器，结束时由当前状态恢复按钮，销毁后拒绝迟到恢复。
 * 模块边界：网络、配置、界面文案、状态提示和文件下载由注入端口提供，不直接访问全局页面或存储。
 */
import type {Config} from '@/src/core/config/model';
import {buildYoutubeTimedTextUrl, chooseYoutubeCaptionTrackForLocation, finalizeVideoSubtitleCues, parseYoutubeTimedTextResponse, type VideoSubtitleCue} from './youtubeSubtitleData';
import {createVideoSubtitleAbortError, mergeBilingualVideoSubtitleCues, normalizeVideoCaptionText, translateVideoSubtitleCues, getVideoTranslationConfigFingerprint} from './subtitleLogic';

export type VideoSubtitleExportChoice = 'complete' | 'existing' | 'cancel';
export interface VideoSubtitleExportPreview {
    total: number;
    ready: number;
    missing: number;
    requests: number;
    human: number;
    cached: number;
    startMs: number | null;
    endMs: number | null;
}

/** 逐条冻结可导出译文；相同缺失原文只计一个请求，人工轨和缓存不算新增用量。 */
export function planVideoSubtitleExport(cues: readonly VideoSubtitleCue[], human: (cue: VideoSubtitleCue) => string,
    cached: (source: string) => string | undefined) {
    const missing: VideoSubtitleCue[] = [];
    let humanCount = 0, cachedCount = 0;
    const translations = cues.map(cue => {
        const manual = human(cue).trim();
        if (manual) { humanCount += 1; return manual; }
        const saved = cached(cue.text)?.trim();
        if (saved) { cachedCount += 1; return saved; }
        missing.push(cue);
        return '';
    });
    const preview: VideoSubtitleExportPreview = {
        total: cues.length, ready: cues.length - missing.length, missing: missing.length,
        requests: new Set(missing.map(cue => normalizeVideoCaptionText(cue.text)).filter(Boolean)).size,
        human: humanCount, cached: cachedCount,
        startMs: missing.length ? missing.reduce((start, cue) => Math.min(start, cue.startMs), Infinity) : null,
        endMs: missing.length ? missing.reduce((end, cue) => Math.max(end, cue.startMs + cue.durationMs), 0) : null,
    };
    return {preview, translations, missing};
}

interface SubtitleTrack {languageCode: string; cues: VideoSubtitleCue[]}
interface CapturedTrack {url: string; cues: VideoSubtitleCue[]}
interface VideoDownloadPorts {
    config: Config;
    document: ParentNode;
    location: Pick<Location, 'hostname' | 'pathname' | 'search' | 'href'>;
    request: typeof fetch;
    isX(): boolean;
    isDisposed(): boolean;
    isAiActive(): boolean;
    /** 完整识别中的预览只供观看，不能冒充完整 SRT。实时字幕旧入口可省略。 */
    isAiComplete?(): boolean;
    nativeX(): SubtitleTrack | null;
    aiCues(): VideoSubtitleCue[];
    captured(): CapturedTrack[];
    remember(track: CapturedTrack): void;
    human: {ready(): Promise<void>; at(time: number): string};
    translate(source: string): Promise<string>;
    /** 结束失败或取消的补译请求，保留已经完成的同媒体缓存。 */
    cancelTranslations?(): void;
    peek(source: string): string | undefined;
    /** 媒体代际包括同一地址里的播放器切换；只读，不输出或持久化。 */
    contextKey?(): string;
    confirm(menu: HTMLElement, preview: VideoSubtitleExportPreview, bilingual: boolean, signal: AbortSignal): Promise<VideoSubtitleExportChoice>;
    ui(key: string, params?: Record<string, string | number>): string;
    status(menu: HTMLElement, message: string, delay?: number): void;
    save(cues: VideoSubtitleCue[], language: string): void;
    /** 菜单状态拥有者重算当前资格，防止旧反馈把新识别中的导出重新启用。 */
    refreshButtons?(): void;
}

export function createVideoSubtitleDownloads(ports: VideoDownloadPorts) {
    let controller: AbortController | undefined;
    let destroyed = false;
    const buttonOwners = new WeakMap<HTMLButtonElement, AbortController>();
    const isDisposed = () => destroyed || ports.isDisposed();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const restoreButton = (button: HTMLButtonElement, delay = 2200) => {
        if (isDisposed()) return;
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (isDisposed()) return;
            if (button.getAttribute('aria-busy') !== 'true') button.disabled = false;
            // 先归还任务禁用，再由当前播放器状态施加资格；YouTube 没有 X 来源状态的重算分支。
            ports.refreshButtons?.();
        }, delay);
        timers.add(timer);
    };
    const wait = <T>(current: AbortController, assertCurrent: () => void, start: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => reject(createVideoSubtitleAbortError());
        try {
            assertCurrent();
            // 先监听再启动端口；同步取消并永不返回的端口也必须释放当前按钮。
            current.signal.addEventListener('abort', abort, {once: true});
            start().then(value => { try { assertCurrent(); resolve(value); } catch (error) { reject(error); } }, reject)
                .finally(() => current.signal.removeEventListener('abort', abort));
        } catch (error) {
            current.signal.removeEventListener('abort', abort);
            reject(error);
        }
    });
    const resolve = async (): Promise<SubtitleTrack> => {
        const requestController = controller, href = ports.location.href, context = ports.contextKey?.();
        const captured = ports.captured();
        const ai = ports.aiCues();
        if (ports.isX()) {
            if (ports.isAiComplete?.() === false) throw new Error(ports.ui('video.sourcePreparing'));
            if (ports.isAiActive() && ai.length) return {languageCode: 'ai', cues: ai};
            const native = ports.nativeX();
            if (native?.cues.length) return native;
            const track = captured.find(entry => entry.cues.length > 0);
            if (track) return {languageCode: 'original', cues: track.cues};
            if (ai.length) return {languageCode: 'ai', cues: ai};
            throw new Error('当前 X 视频还没有可下载的字幕，请先打开原生字幕或请求 AI 字幕');
        }
        const track = captured.find(entry => !new URL(entry.url, ports.location.href).searchParams.get('tlang')) || captured[0];
        if (track) return {languageCode: new URL(track.url, ports.location.href).searchParams.get('lang') || 'original', cues: track.cues};
        const youtube = chooseYoutubeCaptionTrackForLocation(ports.document, ports.location, ports.config.from);
        if (!youtube) throw new Error('当前视频没有可用的 YouTube 字幕轨道');
        const url = buildYoutubeTimedTextUrl(youtube);
        const response = await ports.request(url, {credentials: 'include', signal: requestController?.signal});
        if (!response.ok) throw new Error(`字幕轨道请求失败（${response.status}）`);
        const cues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(await response.text()));
        if (isDisposed() || requestController?.signal.aborted || controller !== requestController
            || ports.location.href !== href || ports.contextKey?.() !== context) throw createVideoSubtitleAbortError();
        if (!cues.length) throw new Error('YouTube 未返回完整字幕数据，请先打开原生字幕后重试');
        ports.remember({url, cues});
        return {languageCode: youtube.languageCode, cues};
    };
    const original = async (menu: HTMLElement, button: HTMLButtonElement, errorMessage: (error: unknown) => string) => {
        controller?.abort();
        const current = new AbortController(); controller = current;
        const href = ports.location.href, context = ports.contextKey?.();
        const sourceLanguage = ports.config.from;
        const assertCurrent = () => {
            if (isDisposed() || controller !== current || current.signal.aborted || ports.location.href !== href
                || ports.contextKey?.() !== context || ports.config.from !== sourceLanguage) throw createVideoSubtitleAbortError();
        };
        buttonOwners.set(button, current);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        ports.status(menu, ports.ui('video.fetching'));
        const slowFeedbackTimer = setTimeout(() => {
            timers.delete(slowFeedbackTimer);
            if (!isDisposed() && controller === current && button.getAttribute('aria-busy') === 'true') ports.status(menu, ports.ui('video.reading'));
        }, 2000);
        timers.add(slowFeedbackTimer);
        let feedback = '', feedbackDelay = 2400;
        try {
            const result = await wait(current, assertCurrent, resolve);
            assertCurrent();
            ports.save(result.cues, result.languageCode);
            feedback = ports.ui('video.downloaded', {count: result.cues.length});
        } catch (error) {
            feedback = errorMessage(error);
            feedbackDelay = 3200;
            console.warn('[FluentRead] 字幕下载失败', error);
        } finally {
            clearTimeout(slowFeedbackTimer); timers.delete(slowFeedbackTimer);
            if (buttonOwners.get(button) === current) {
                buttonOwners.delete(button);
                button.removeAttribute('aria-busy');
                restoreButton(button, feedbackDelay);
            }
            if (controller === current) {
                controller = undefined;
                if (!isDisposed()) ports.status(menu, feedback, feedbackDelay);
            }
        }
    };
    const translated = async (menu: HTMLElement, button: HTMLButtonElement, bilingual: boolean) => {
        button.disabled = true;
        if (!ports.config.on || !ports.config.videoTranslationEnabled) {
            ports.status(menu, ports.ui('video.enableFirst'), 2200); restoreButton(button); return;
        }
        controller?.abort();
        const current = new AbortController(); controller = current;
        const language = ports.config.to || 'translated';
        const href = ports.location.href, context = ports.contextKey?.();
        const fingerprint = getVideoTranslationConfigFingerprint(ports.config);
        const assertCurrent = () => {
            if (isDisposed() || controller !== current || current.signal.aborted || ports.location.href !== href
                || ports.contextKey?.() !== context || !ports.config.on || !ports.config.videoTranslationEnabled
                || getVideoTranslationConfigFingerprint(ports.config) !== fingerprint) throw createVideoSubtitleAbortError();
        };
        buttonOwners.set(button, current);
        button.setAttribute('aria-busy', 'true');
        ports.status(menu, ports.ui('video.fetching'));
        let feedback = '';
        try {
            assertCurrent();
            const result = await wait(current, assertCurrent, resolve);
            assertCurrent();
            await wait(current, assertCurrent, () => ports.human.ready());
            assertCurrent();
            const originals = result.cues.filter(cue => normalizeVideoCaptionText(cue.text)).map(cue => ({...cue}));
            const plan = planVideoSubtitleExport(originals, cue => ports.config.videoPreferHumanSubtitles
                ? ports.human.at(cue.startMs + cue.durationMs / 2) : '', ports.peek);
            const choice = await ports.confirm(menu, plan.preview, bilingual, current.signal);
            assertCurrent();
            if (choice === 'cancel') throw createVideoSubtitleAbortError();
            if (choice === 'complete' && plan.missing.length) {
                const translations = await translateVideoSubtitleCues(plan.missing, async source => {
                    assertCurrent();
                    const cached = ports.peek(source)?.trim();
                    if (cached) return cached;
                    return wait(current, assertCurrent, () => ports.translate(source));
                }, {concurrency: 3, signal: current.signal,
                    onProgress: (completed, total) => { assertCurrent(); ports.status(menu, ports.ui('video.translating', {completed, total})); },
                });
                assertCurrent();
                const byText = new Map(plan.missing.map((cue, index) => [normalizeVideoCaptionText(cue.text), translations[index]!.text]));
                // 每个非空缺失来源都已完成；翻译端口返回空值时上一步已失败，不能默默降级成缺条目的完整文件。
                originals.forEach((cue, index) => { if (!plan.translations[index]) plan.translations[index] = byText.get(normalizeVideoCaptionText(cue.text))!; });
            }
            assertCurrent();
            const retainedOriginals: VideoSubtitleCue[] = [], translatedCues: VideoSubtitleCue[] = [];
            originals.forEach((cue, index) => {
                const text = plan.translations[index];
                if (text) { retainedOriginals.push(cue); translatedCues.push({...cue, text}); }
            });
            if (!translatedCues.length) { feedback = ports.ui('video.exportEmpty'); return; }
            const partial = translatedCues.length !== originals.length;
            // 失败/取消不会下载看似完整的文件；仅已有结果保留原时间轴并明确标为 partial。
            const cues = bilingual ? mergeBilingualVideoSubtitleCues(retainedOriginals, translatedCues) : translatedCues;
            ports.save(cues, `${language}-${bilingual ? 'bilingual' : 'translated'}${partial ? '-partial' : ''}`);
            feedback = ports.ui(partial ? 'video.exportedPartial' : 'video.downloaded',
                {count: cues.length, total: originals.length, missing: originals.length - cues.length});
        } catch (error) {
            const aborted = error instanceof Error && error.name === 'AbortError';
            feedback = ports.ui(aborted ? 'video.cancelled' : 'video.downloadFailed');
            if (controller === current) { current.abort(); ports.cancelTranslations?.(); }
        } finally {
            if (buttonOwners.get(button) === current) {
                buttonOwners.delete(button);
                button.removeAttribute('aria-busy');
                restoreButton(button);
            }
            if (controller === current) {
                controller = undefined;
                if (!isDisposed()) ports.status(menu, feedback, 2200);
            }
        }
    };
    return {resolve, original, translated, restoreButton, cancel: () => controller?.abort(), destroy: () => {
        destroyed = true;
        controller?.abort(); timers.forEach(clearTimeout); timers.clear();
    }};
}
