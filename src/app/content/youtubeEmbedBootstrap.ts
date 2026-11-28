/**
 * @file src/app/content/youtubeEmbedBootstrap.ts
 * 文件职责：作为所有 HTTP/HTTPS 页面与子 frame 在 document_start 运行的超轻量引导入口，仅在确认 YouTube 内嵌或真实 HTML 音视频后按需请求后台注入完整字幕运行时。
 * 主要内容：在顶层页面、无效上下文、非 HTTP 协议与排除站点立即退出；YouTube /embed/ 直接请求注入，普通子 frame 等待基础文档后轻量观察音视频出现，遵循 BFCache 暂停恢复与销毁清理并在注入成功后自我卸载。
 * 模块边界：严禁静态或动态导入完整视频字幕运行时、配置 store、语言包、Vue 或翻译客户端；按需注入目标脚本由 videoSubtitleFrame 入口与后台处理器负责。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {isYouTubeEmbedPage, YOUTUBE_HOST_PATTERN} from '@/src/features/video-subtitle/content/youtubeEmbedUrl';
import {isExcludedHtmlMediaHost, isExcludedHtmlMediaUrl, mountWhenHtmlMediaPresent} from '@/src/features/video-subtitle/content/htmlMedia';
import {getCaptionPlatform} from '@/src/features/video-subtitle/content/platforms';
import {
    VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE,
    VIDEO_SUBTITLE_FRAME_STARTED_KEY,
    type VideoSubtitleFrameInjectResponse,
} from '@/src/features/video-subtitle/frameProtocol';
import {installContentPageLifecycle, waitForContentDocument} from './pageLifecycle';

const MAX_INJECT_RETRIES = 2;
const RETRY_DELAY_MS = 250;

function isVideoSubtitleFrameStarted(): boolean {
    return (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY] === true;
}

async function sendInjectRequest(): Promise<VideoSubtitleFrameInjectResponse | undefined> {
    return browser.runtime.sendMessage({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}) as Promise<VideoSubtitleFrameInjectResponse | undefined>;
}

export async function startYoutubeEmbedBootstrap(ctx: ContentScriptContext): Promise<void> {
    if (window.top === window || ctx.isInvalid || !/^https?:$/.test(window.location.protocol) || isVideoSubtitleFrameStarted()) return;

    const youtubeEmbed = isYouTubeEmbedPage(window.location);
    if (!youtubeEmbed) {
        const platform = getCaptionPlatform(window.location);
        if (YOUTUBE_HOST_PATTERN.test(window.location.hostname)
            || /(^|\.)(x\.com|twitter\.com)$/i.test(window.location.hostname)
            || isExcludedHtmlMediaHost(window.location.hostname)
            || isExcludedHtmlMediaUrl(document.referrer)
            || (platform && platform !== 'coursera' && platform !== 'vimeo')) return;
    }

    let disposed = false;
    let injected = false;
    let documentReady = document.readyState !== 'loading';
    let inFlight: Promise<void> | undefined;
    let stopWatcher: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retriesUsed = 0;
    let lifecycle: {isSuspended(): boolean} | undefined;
    const lifetime = new AbortController();
    const clearRetryTimer = () => {
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
    };
    const stopMediaWatcher = () => {
        clearRetryTimer();
        const previous = stopWatcher;
        stopWatcher = undefined;
        previous?.();
    };
    const cleanup = () => {
        disposed = true;
        stopMediaWatcher();
        lifetime.abort();
    };
    const markStartedAndCleanup = (): boolean => {
        if (!isVideoSubtitleFrameStarted()) return false;
        injected = true;
        cleanup();
        return true;
    };
    const scheduleRetry = () => {
        if (disposed || injected || ctx.isInvalid
            || retriesUsed >= MAX_INJECT_RETRIES || retryTimer !== undefined) return;
        retriesUsed += 1;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void requestInjection();
        }, RETRY_DELAY_MS);
    };
    const requestInjection = (): Promise<void> => {
        if (markStartedAndCleanup()) return Promise.resolve();
        if (disposed || injected || ctx.isInvalid) return Promise.resolve();
        if (inFlight) return inFlight;
        clearRetryTimer();
        inFlight = sendInjectRequest()
            .then((response) => {
                if (response?.injected || isVideoSubtitleFrameStarted()) {
                    injected = true;
                    cleanup();
                    return;
                }
                if (!disposed && !ctx.isInvalid) {
                    console.warn('[FluentRead] 视频字幕子 frame 注入失败', response?.error ?? response);
                    if (response?.retryable === false) {
                        cleanup();
                    } else {
                        scheduleRetry();
                    }
                }
            })
            .catch((error) => {
                if (markStartedAndCleanup()) return;
                if (!disposed && !ctx.isInvalid) {
                    console.warn('[FluentRead] 视频字幕子 frame 注入失败', error);
                    scheduleRetry();
                }
            })
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };
    const startMediaWatcher = () => {
        if (markStartedAndCleanup()) return;
        if (disposed || injected || ctx.isInvalid || !documentReady || lifecycle?.isSuspended() || stopWatcher) return;
        stopWatcher = mountWhenHtmlMediaPresent(() => {
            void requestInjection();
            return () => undefined;
        });
    };

    // 引导入口不挂载 UI 或 MAIN 桥，关闭周期性上下文轮询以避免在无关 iframe 常驻定时器。
    lifecycle = installContentPageLifecycle(window, lifetime.signal, {
        suspend: stopMediaWatcher,
        resume: () => {
            if (youtubeEmbed) void requestInjection();
            else startMediaWatcher();
        },
        dispose: cleanup,
    }, ctx, document, false);

    if (youtubeEmbed) {
        await requestInjection();
        return;
    }

    if (!documentReady) {
        if (!await waitForContentDocument(document, lifetime.signal)) {
            cleanup();
            return;
        }
        documentReady = true;
    }
    if (disposed || ctx.isInvalid) {
        cleanup();
        return;
    }
    startMediaWatcher();
}
