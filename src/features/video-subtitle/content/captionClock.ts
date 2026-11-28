/**
 * @file src/features/video-subtitle/content/captionClock.ts
 * 文件职责：封装视频字幕播放帧时钟（rVFC 与 rAF 回退）、跳转预取保留窗口计算与翻译状态映射。
 * 主要内容：在支持 requestVideoFrameCallback 的视频上按视频帧驱动字幕检查，在音频元素或缺少 rVFC 的浏览器上平滑回退至 requestAnimationFrame 并对称清理；按播放倍速下限 1 计算 seek 预取保留集合；将缓存故障状态映射为菜单与按钮的非侵入状态模型。
 * 模块边界：不直接访问全局配置、翻译客户端或业务 DOM；仅通过注入回调与只读参数运行，供视频字幕 runtime 复用。
 */
import type {VideoTranslationFailureStatus} from './translationCache';
import type {VideoTranslationStatusState} from './playerMenu';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export interface VideoCaptionClockPorts {
    getVideo(): HTMLMediaElement | null;
    isActive(): boolean;
    onTick(video: HTMLMediaElement): void;
}

export interface VideoCaptionClock {
    start(): void;
    stop(): void;
}

/** 驱动播放态字幕时钟：优先使用 requestVideoFrameCallback，缺失时回退至 requestAnimationFrame。 */
export function createVideoCaptionClock(ports: VideoCaptionClockPorts): VideoCaptionClock {
    let frameId: number | undefined;
    let frameKind: 'vfc' | 'raf' | undefined;
    let frameVideo: HTMLMediaElement | null = null;

    const stop = (): void => {
        if (frameId !== undefined) {
            if (frameKind === 'vfc') {
                (frameVideo as HTMLVideoElement | null)?.cancelVideoFrameCallback?.(frameId);
            } else if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frameId);
            }
        }
        frameId = undefined;
        frameKind = undefined;
        frameVideo = null;
    };

    const start = (): void => {
        const video = ports.getVideo();
        if (!video || video.paused || video.ended || frameId !== undefined || !ports.isActive()) return;
        const handleTick = (): void => {
            frameId = undefined;
            frameKind = undefined;
            if (ports.getVideo() !== video || !video.isConnected || !ports.isActive()) return;
            ports.onTick(video);
            start();
        };
        const videoWithVfc = video as HTMLVideoElement;
        if (typeof videoWithVfc.requestVideoFrameCallback === 'function') {
            frameVideo = video;
            frameKind = 'vfc';
            frameId = videoWithVfc.requestVideoFrameCallback(handleTick);
        } else if (typeof requestAnimationFrame === 'function') {
            frameVideo = video;
            frameKind = 'raf';
            frameId = requestAnimationFrame(handleTick);
        }
    };

    return {start, stop};
}

/** 与 VideoSubtitlePretranslationWindow 对齐倍速下限（>= 1），计算 seek 后应保留的预取原文集合。 */
export function computeSeekKeepSources(
    cues: readonly VideoSubtitleCue[],
    currentMs: number,
    windowMs: number,
    playbackRate: number,
): string[] {
    if (!Number.isFinite(currentMs) || cues.length === 0) return [];
    const rate = Number.isFinite(playbackRate) && playbackRate > 1 ? playbackRate : 1;
    const endMs = currentMs + Math.max(0, windowMs) * rate;
    const keep: string[] = [];
    for (const cue of cues) {
        if (cue.startMs + cue.durationMs > currentMs && cue.startMs <= endMs) keep.push(cue.text);
    }
    return keep;
}

/** 将视频翻译缓存故障状态映射为播放器入口与菜单的非侵入状态提示。 */
export function resolveVideoTranslationUiStatus(
    active: boolean,
    failureStatus: VideoTranslationFailureStatus,
    hasActiveCueFailure: () => boolean,
): VideoTranslationStatusState {
    if (!active) return {status: 'idle'};
    if (failureStatus.state === 'permanent') {
        return {status: 'error', message: failureStatus.message, canRetry: true};
    }
    if (failureStatus.state === 'cooldown') {
        return {status: 'retrying', message: failureStatus.message, canRetry: true};
    }
    if (failureStatus.state === 'retrying' && hasActiveCueFailure()) {
        return {status: 'error', message: failureStatus.message, canRetry: true};
    }
    return {status: 'idle'};
}
