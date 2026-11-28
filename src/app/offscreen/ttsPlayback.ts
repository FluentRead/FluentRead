/**
 * @file src/app/offscreen/ttsPlayback.ts
 * 文件职责：管理 Offscreen 中划词 TTS 的单播放所有权，确保新旧请求、暂停/继续、调速、停止、结束、错误和 Blob URL 释放按精确 route 隔离。
 * 主要内容：解析路由、可选倍速及音频输入，为每次播放预分词并绑定独立回调与可选 object URL；支持播放、暂停、继续、实时调速、停止和按秒跳转，按真实媒体时钟发送跟读进度与时长，启动失败只由 PLAY 响应返回，已开始播放的终态通过通知回传；释放时清理计时器。
 * 模块边界：播放器不合成语音、不发送后台请求，也不决定默认 voice/rate；音频构造和状态传输由依赖注入，网络 TTS 与跨上下文路由属于 selection-translation feature。
 */
import {
    parseSelectionTtsRoute,
    sameSelectionTtsRoute,
    type SelectionTtsPlaybackRequest,
    type SelectionTtsPlaybackState,
} from '@/src/features/selection-translation/protocol';
import {
    audioSpeechProgress,
    parseSpeechCues,
    parseSpeechPlaybackPosition,
    seekSpeechTime,
    speechTextTokens,
    type SpeechPlaybackPosition,
    type SpeechProgress,
    type SpeechTextToken,
} from '@/src/core/tts/speechProgress';

export type {
    SelectionTtsPlaybackRequest,
    SelectionTtsPlaybackState,
} from '@/src/features/selection-translation/protocol';

export interface SelectionAudioPort {
    currentTime?: number;
    readonly duration?: number;
    playbackRate?: number;
    readonly paused?: boolean;
    preload: string;
    src: string;
    onended: ((event: Event) => void) | null;
    onerror: ((event: Event | string) => void) | null;
    pause(): void;
    load(): void;
    play(): Promise<void>;
    removeAttribute(name: string): void;
}

export interface SelectionTtsPlayerDependencies {
    readonly createAudio: () => SelectionAudioPort;
    readonly decodeBase64: (encoded: string) => Uint8Array;
    readonly createObjectUrl: (bytes: Uint8Array, contentType: string) => string;
    readonly revokeObjectUrl: (url: string) => void;
    readonly notify: (
        request: SelectionTtsPlaybackRequest,
        state: SelectionTtsPlaybackState,
        error?: unknown,
    ) => void;
    readonly notifyProgress?: (request: SelectionTtsPlaybackRequest, progress: SpeechProgress, position: SpeechPlaybackPosition) => void;
}

interface PreparedPlayback {
    readonly request: SelectionTtsPlaybackRequest;
    readonly audio: SelectionAudioPort;
    readonly objectUrl: string;
    readonly tokens?: readonly SpeechTextToken[];
    stateVersion: number;
    timer?: ReturnType<typeof setInterval>;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`TTS ${field} 必须是非空字符串`);
    return value;
}

function parseSelectionTtsRate(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) {
        throw new TypeError('TTS rate 无效');
    }
    return value;
}

export function parseSelectionTtsPlaybackRequest(value: unknown): SelectionTtsPlaybackRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('TTS 播放请求必须是对象');
    }
    const record = value as Record<string, unknown>;
    const route = parseSelectionTtsRoute(record);
    const sourceUrl = parseOptionalString(record.sourceUrl, 'sourceUrl');
    const audioBase64 = parseOptionalString(record.audioBase64, 'audioBase64');
    if (Boolean(sourceUrl) === Boolean(audioBase64)) {
        throw new TypeError('TTS 播放请求必须且只能提供一种音频来源');
    }
    return {
        sourceUrl,
        audioBase64,
        ...(record.text === undefined ? {} : {text: parseOptionalString(record.text, 'text'), timings: parseSpeechCues(record.timings)}),
        ...(record.rate === undefined ? {} : {rate: parseSelectionTtsRate(record.rate)}),
        contentType: parseOptionalString(record.contentType, 'contentType'),
        ...route,
    };
}

/**
 * Offscreen 音频状态机。每一轮播放独占自己的 Audio 与 Blob URL，旧请求的
 * play() 延迟失败不会清理或通知新请求，从根源上避免竞态和 URL 泄漏。
 */
export class SelectionTtsPlayer {
    private active: PreparedPlayback | null = null;

    constructor(private readonly dependencies: SelectionTtsPlayerDependencies) {}

    private release(playback: PreparedPlayback): void {
        clearInterval(playback.timer);
        playback.audio.onended = null;
        playback.audio.onerror = null;
        playback.audio.pause();
        playback.audio.removeAttribute('src');
        playback.audio.load();
        if (playback.objectUrl) this.dependencies.revokeObjectUrl(playback.objectUrl);
    }

    private stopActive(notify: boolean): boolean {
        const active = this.active;
        if (!active) return false;
        this.active = null;
        this.release(active);
        if (notify) this.dependencies.notify(active.request, 'stopped');
        return true;
    }

    private startProgressTimer(playback: PreparedPlayback): void {
        clearInterval(playback.timer);
        playback.timer = undefined;
        if (!playback.request.text || !this.dependencies.notifyProgress) return;
        const tick = () => this.publishProgress(playback);
        playback.timer = setInterval(tick, 100);
        tick();
    }

    stop(value: unknown, notify = true): boolean {
        const route = parseSelectionTtsRoute(value);
        if (!this.active || !sameSelectionTtsRoute(this.active.request, route)) {
            return false;
        }
        return this.stopActive(notify);
    }

    pause(value: unknown): boolean {
        const route = parseSelectionTtsRoute(value);
        const active = this.active;
        if (!active || !sameSelectionTtsRoute(active.request, route)) return false;
        active.stateVersion += 1;
        clearInterval(active.timer);
        active.timer = undefined;
        active.audio.pause();
        return true;
    }

    async resume(value: unknown): Promise<boolean> {
        const route = parseSelectionTtsRoute(value);
        const active = this.active;
        if (!active || !sameSelectionTtsRoute(active.request, route)) return false;
        const version = ++active.stateVersion;
        await active.audio.play();
        if (this.active !== active || active.stateVersion !== version || active.audio.paused === true) return false;
        this.startProgressTimer(active);
        return true;
    }

    setRate(value: unknown): boolean {
        const route = parseSelectionTtsRoute(value);
        const rate = parseSelectionTtsRate((value as {rate?: unknown}).rate);
        const active = this.active;
        if (!active || !sameSelectionTtsRoute(active.request, route)) return false;
        active.audio.playbackRate = rate;
        return true;
    }

    private publishProgress(playback: PreparedPlayback): void {
        if (this.active !== playback || !playback.request.text || !this.dependencies.notifyProgress) return;
        const {audio, request} = playback;
        const position = parseSpeechPlaybackPosition({currentTime: audio.currentTime, duration: audio.duration});
        const progress = audioSpeechProgress(request.text!, audio.currentTime ?? NaN, audio.duration ?? NaN, request.timings, playback.tokens);
        if (position && progress) this.dependencies.notifyProgress(request, progress, position);
    }

    seek(value: unknown): boolean {
        const route = parseSelectionTtsRoute(value);
        const offset = (value as {offsetSeconds?: unknown}).offsetSeconds;
        if (offset !== -5 && offset !== 5) throw new TypeError('TTS 跳转必须为前进或后退 5 秒');
        const active = this.active;
        if (!active || !sameSelectionTtsRoute(active.request, route)) return false;
        const time = seekSpeechTime(active.audio.currentTime ?? NaN, active.audio.duration ?? NaN, offset);
        if (time === null) return false;
        active.audio.currentTime = time;
        this.publishProgress(active);
        return true;
    }

    dispose(): void {
        this.stopActive(false);
    }

    async play(value: unknown): Promise<void> {
        const request = parseSelectionTtsPlaybackRequest(value);
        const audio = this.dependencies.createAudio();
        audio.preload = 'auto';
        let objectUrl = '';
        try {
            if (request.sourceUrl) {
                audio.src = request.sourceUrl;
            } else {
                const bytes = this.dependencies.decodeBase64(request.audioBase64 as string);
                objectUrl = this.dependencies.createObjectUrl(bytes, request.contentType ?? 'audio/mpeg');
                audio.src = objectUrl;
            }
        } catch (error) {
            if (objectUrl) this.dependencies.revokeObjectUrl(objectUrl);
            throw error;
        }
        if (request.rate !== undefined) audio.playbackRate = request.rate;

        // 步骤 1：新资源完整准备成功后才停止旧播放，非法 payload 不打断用户当前语音。
        this.stopActive(true);
        const tokens = request.text ? speechTextTokens(request.text) : undefined;
        const playback: PreparedPlayback = {request, audio, objectUrl, tokens, stateVersion: 0};
        this.active = playback;

        // 步骤 2：回调只允许结束创建它的那一轮，过期事件不能污染当前状态。
        audio.onended = () => {
            if (this.active !== playback) return;
            this.active = null;
            this.release(playback);
            this.dependencies.notify(request, 'ended');
        };
        try {
            // 启动失败由 PLAY 的 rejected Promise 返回；后台仍拥有请求并决定页面回退。
            // 在启动成功前不另发 error 终态，否则它会抢先释放所有权、被误判为 STOP。
            const version = playback.stateVersion;
            await audio.play();
            if (this.active === playback) {
                audio.onerror = () => {
                    if (this.active !== playback) return;
                    this.active = null;
                    this.release(playback);
                    this.dependencies.notify(request, 'error', new Error('扩展音频解码或播放失败'));
                };
                if (playback.stateVersion === version && playback.audio.paused !== true) {
                    this.startProgressTimer(playback);
                }
            }
        } catch (error) {
            // 步骤 3：启动失败只走 PLAY 响应；被替换/停止的迟到失败不能释放新资源。
            if (this.active === playback) {
                this.active = null;
                this.release(playback);
            }
            throw error;
        }
    }
}

export function createSelectionTtsPlayer(dependencies: SelectionTtsPlayerDependencies): SelectionTtsPlayer {
    return new SelectionTtsPlayer(dependencies);
}
