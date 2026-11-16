/**
 * @file src/features/video-subtitle/content/bilibiliAiSource.ts
 * 文件职责：编排 B 站无字幕视频的本地识别会话，复用完整采集器及后台推理协议。
 * 主要内容：仅使用已下载模型；媒体、开关、模型或语言变化时取消旧会话，迟到的自带字幕标记仅停止自动任务，逐窗发布字幕并保留明确重试状态。
 * 模块边界：不持有 DOM 或翻译服务，音轨读取和后台传输由端口注入；不自动下载模型或循环重试。
 */
import type {VideoTranscriptionProvider} from '@/src/core/config/model';
import {NATIVE_QWEN_ASR_MODEL} from '@/src/core/messaging/video';
import {VideoAiFullCaptureController} from './video-ai/fullCapture';
import {VideoAiRequestSession} from './video-ai/requestSession';
import {encodeVideoAiPcm16Base64} from './video-ai/audioWindow';
import {requestDownloadedLocalVideoModels} from './localModelReadiness';
import {sendVideoSubtitleRequest} from './backgroundClient';
import type {VideoLocalTranscriptionModel} from '../transcription';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export interface BilibiliAiPorts {
    send(message: unknown): Promise<unknown>;
    getVideo(): HTMLVideoElement | null;
    getAudio(video: HTMLVideoElement, signal: AbortSignal): Promise<Float32Array>;
    getModel(): VideoLocalTranscriptionModel;
    getLanguage(): string;
    getProvider(): VideoTranscriptionProvider;
    getNativeBaseUrl(): string;
    changed(): void;
}

export class BilibiliAiSource {
    cues: VideoSubtitleCue[] = [];
    status: 'idle' | 'checking' | 'running' | 'ready' | 'error' = 'idle';
    error = '';
    progress = 0;
    private key = '';
    private revision = 0;
    private disposed = false;
    private attempted = false;
    private automatic = false;
    private readonly requests = new VideoAiRequestSession(`bilibili:${crypto.randomUUID()}`);
    private readonly capture: VideoAiFullCaptureController;
    constructor(private readonly ports: BilibiliAiPorts) {
        const cancel = (session: number, reason: string) => {
            const identity = this.requests.read(session);
            if (identity) void sendVideoSubtitleRequest(ports.send, {type: 'fluentReadCancelLocalVideoTranscription', ...identity, reason})
                .catch(() => undefined);
        };
        this.capture = new VideoAiFullCaptureController({
            getVideo: ports.getVideo, getAudio: ports.getAudio, getModel: ports.getModel,
            isSupported: () => !this.disposed && Boolean(this.key),
            onSessionStart: session => { this.requests.start(session, ports.getProvider() === 'native-qwen' ? NATIVE_QWEN_ASR_MODEL : ports.getModel(), ports.getLanguage(),
                {provider: ports.getProvider(), nativeBaseUrl: ports.getNativeBaseUrl()}); },
            onInvalidate: (_reason, session) => cancel(session, 'cancel'),
            transcribe: async chunk => {
                const identity = this.requests.read(chunk.sessionId);
                if (!identity || this.disposed) return {skipped: true};
                const response = await sendVideoSubtitleRequest(ports.send, {type: 'fluentReadTranscribeLocalVideoAudio', ...identity,
                    audioPcm16Base64: encodeVideoAiPcm16Base64(chunk.pcm)});
                if (!response.success) throw new Error(response.error || '本地识别失败');
                return response;
            },
            onCuesProgress: cues => { this.cues = cues; ports.changed(); },
            onTranscriptionComplete: async cues => { this.cues = cues; },
            onError: error => { this.cues = []; this.status = 'error'; this.error = error.message; ports.changed(); },
            onStateChange: () => ports.changed(),
            onProgress: progress => {
                this.progress = progress.progress;
                if (progress.phase === 'ready') { this.status = 'ready'; cancel(this.capture.getSessionId(), 'complete'); }
                ports.changed();
            },
        });
    }
    sync(key: string): void {
        if (this.disposed || key === this.key) return;
        this.reset(); this.key = key;
    }
    async start(automatic = false): Promise<void> {
        if (this.disposed || !this.key || this.status === 'checking' || this.status === 'running' || this.status === 'ready'
            || (automatic && this.attempted)) return;
        this.attempted = true; this.automatic = automatic; this.error = ''; this.status = 'checking';
        const revision = ++this.revision;
        const model = this.ports.getModel();
        this.ports.changed();
        try {
            const models = this.ports.getProvider() === 'native-qwen' ? [model] : await requestDownloadedLocalVideoModels(this.ports.send);
            if (revision !== this.revision || this.disposed) return;
            if (!models.includes(model)) throw new Error('请先在视频设置中下载所选本地 AI 模型，再点击生成 AI 字幕');
            this.status = 'running';
            this.capture.start();
        } catch (error) {
            if (revision !== this.revision || this.disposed) return;
            this.status = 'error'; this.error = (error as Error).message;
        }
        this.ports.changed();
    }
    stop(): void {
        this.reset(); this.attempted = true; this.ports.changed();
    }
    stopAutomatic(): void {
        if (this.automatic) this.stop();
    }
    private reset(): void {
        ++this.revision; this.capture.cancel(); this.cues = []; this.status = 'idle'; this.error = ''; this.progress = 0; this.attempted = false; this.automatic = false;
    }
    destroy(): void {
        this.disposed = true; ++this.revision; this.capture.destroy(); this.requests.dispose(); this.cues = [];
    }
}
