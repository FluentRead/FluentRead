/**
 * @file src/app/background/handlers/videoSubtitleFrame.ts
 * 文件职责：在后台校验子 frame 来源并按需注入视频字幕完整内容脚本，同时兼容 MV3 scripting 与 MV2 tabs 执行接口。
 * 主要内容：核验发送方扩展身份、有效标签页、非顶层子 frame 标识与 HTTP/HTTPS 来源，再向精确目标 frame 注入 videoSubtitleFrame.js；提供可独立单测的跨浏览器脚本执行适配器。
 * 模块边界：只负责受控单帧注入，不注入顶层页面、不操作配置存储，也不接受调用方传入任意脚本路径。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {
    VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE,
    VIDEO_SUBTITLE_FRAME_SCRIPT,
    type VideoSubtitleFrameInjectRequest,
    type VideoSubtitleFrameInjectResponse,
} from '@/src/features/video-subtitle/frameProtocol';

export interface VideoSubtitleFrameBackgroundContext {
    readonly sender?: {
        readonly id?: unknown;
        readonly url?: unknown;
        readonly frameId?: unknown;
        readonly tab?: {readonly id?: unknown};
    };
}

export interface VideoSubtitleFrameScriptApi {
    readonly scripting?: {
        executeScript?: (injection: {
            target: {tabId: number; frameIds: number[]};
            files: string[];
            injectImmediately?: boolean;
        }) => Promise<unknown>;
    };
    readonly tabs?: {
        executeScript?: (
            tabId: number,
            details: {file: string; frameId: number; runAt?: 'document_start' | 'document_end' | 'document_idle'},
        ) => Promise<unknown>;
    };
}

export interface VideoSubtitleFrameHandlerDependencies {
    readonly runtimeId: string;
    readonly isTabId: (tabId: unknown) => tabId is number;
    readonly executeScript: (tabId: number, frameId: number, file: string) => Promise<void>;
}

/** 优先使用 MV3 scripting.executeScript，在 Firefox/Safari MV2 下自动回退到 tabs.executeScript。 */
export function createBrowserVideoSubtitleFrameExecutor(
    api: VideoSubtitleFrameScriptApi,
): (tabId: number, frameId: number, file: string) => Promise<void> {
    return async (tabId, frameId, file) => {
        if (typeof api.scripting?.executeScript === 'function') {
            await api.scripting.executeScript({
                target: {tabId, frameIds: [frameId]},
                files: [file],
                injectImmediately: true,
            });
            return;
        }
        if (typeof api.tabs?.executeScript === 'function') {
            await api.tabs.executeScript(tabId, {
                file: `/${file.replace(/^\/+/u, '')}`,
                frameId,
                runAt: 'document_start',
            });
            return;
        }
        throw new Error('当前浏览器不支持向子 frame 注入视频字幕脚本');
    };
}

export function createVideoSubtitleFrameHandler(
    dependencies: VideoSubtitleFrameHandlerDependencies,
): BackgroundMessageHandler<VideoSubtitleFrameBackgroundContext, VideoSubtitleFrameInjectRequest, VideoSubtitleFrameInjectResponse> {
    return {
        type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE,
        async handle(_message, context) {
            const sender = context?.sender;
            if (sender?.id !== dependencies.runtimeId) {
                return {injected: false, error: '当前上下文无权注入视频字幕脚本', retryable: false};
            }
            const tabId = sender.tab?.id;
            if (!dependencies.isTabId(tabId)) {
                return {injected: false, error: '缺少有效标签页标识', retryable: false};
            }
            const frameId = sender.frameId;
            if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId <= 0) {
                return {injected: false, error: '仅允许向子 frame 按需注入视频字幕脚本', retryable: false};
            }
            if (typeof sender.url !== 'string' || !/^https?:\/\//iu.test(sender.url)) {
                return {injected: false, error: '仅支持向 HTTP/HTTPS 子 frame 注入视频字幕脚本', retryable: false};
            }
            try {
                await dependencies.executeScript(tabId, frameId, VIDEO_SUBTITLE_FRAME_SCRIPT);
                return {injected: true};
            } catch (error) {
                return {
                    injected: false,
                    error: error instanceof Error ? error.message : String(error),
                    retryable: true,
                };
            }
        },
    };
}
