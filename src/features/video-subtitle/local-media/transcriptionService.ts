/**
 * @file src/features/video-subtitle/local-media/transcriptionService.ts
 * 文件职责：编排本地音视频离线转写、字幕时间轴整理、批量双语翻译与 SRT/WebVTT/Markdown 导出会话。
 * 主要内容：复用后台 Whisper 与本机 Qwen3 ASR 协议逐窗推理并实时推送字幕，支持可取消并发翻译、失败重试与防迟到回写，最终复用既有导出器生成多格式双语字幕文件。
 * 模块边界：不直接操作 DOM 或持有 Object URL，后台消息、解码与翻译能力均通过端口注入，销毁或取消时主动通知后台释放推理流。
 */
import type {VideoTranscriptionProvider} from '@/src/core/config/model';
import {NATIVE_QWEN_ASR_MODEL} from '@/src/core/messaging/video';
import {normalizeVideoLocalTranscriptionModel, type VideoLocalTranscriptionModel} from '../transcription';
import {sendVideoSubtitleRequest} from '../content/backgroundClient';
import {requestDownloadedLocalVideoModels} from '../content/localModelReadiness';
import {encodeVideoAiPcm16Base64} from '../content/video-ai/audioWindow';
import {VideoAiRequestSession} from '../content/video-ai/requestSession';
import {alignVideoAiSegmentsToSpeech} from '../content/video-ai/speechAlignment';
import {VideoAiTranscriptStabilizer, type VideoAiStabilizedCue} from '../content/video-ai/streamingTranscript';
import {mergeVideoAiSubtitleCues, normalizeVideoAiSubtitleTimeline} from '../content/video-ai/cueTimeline';
import {consolidateVideoAiFullCues} from '../content/video-ai/fullCapture';
import {isVideoSubtitleInTargetLanguage} from '../content/subtitleLanguage';
import {serializeSubtitleFile, type SubtitleExportFormat} from '../content/subtitleExport';
import {sanitizeSubtitleFilename, type VideoSubtitleCue} from '../content/youtubeSubtitleData';
import {decodeLocalMediaToPcm16k, sliceLocalMediaWindows, type LocalMediaAudioSource, type LocalMediaDecodePorts} from './audioDecoder';

export type LocalMediaTranscriptionPhase =
    | 'idle'
    | 'checking'
    | 'decoding'
    | 'transcribing'
    | 'translating'
    | 'ready'
    | 'error';

export type LocalMediaExportMode = 'original' | 'translated' | 'bilingual';

export interface LocalMediaCue extends VideoSubtitleCue {
    translation?: string;
    translationError?: string;
}

export interface LocalMediaSessionSnapshot {
    readonly phase: LocalMediaTranscriptionPhase;
    readonly progress: number;
    readonly windowIndex: number;
    readonly windowCount: number;
    readonly translatedCount: number;
    readonly failedTranslationCount: number;
    readonly totalCues: number;
    readonly durationMs: number;
    readonly cues: readonly LocalMediaCue[];
    readonly error: string;
}

export interface LocalMediaTranscriptionPorts {
    send(message: unknown): Promise<unknown>;
    translate(text: string, signal: AbortSignal, sourceLanguage?: string): Promise<string>;
    getModel(): VideoLocalTranscriptionModel;
    getSourceLanguage(): string;
    getTargetLanguage(): string;
    getProvider(): VideoTranscriptionProvider;
    getNativeBaseUrl(): string;
    decode?: LocalMediaDecodePorts;
    onUpdate(snapshot: LocalMediaSessionSnapshot): void;
}

const TRANSLATION_CONCURRENCY = 3;

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function finalizeTranscriptCues(rawCues: readonly VideoAiStabilizedCue[], includePartial: boolean): VideoSubtitleCue[] {
    const filtered = includePartial
        ? rawCues.map(cue => ({...cue, partial: false, availableAtMs: 0, translationAvailableAtMs: 0}))
        : rawCues.filter(cue => !cue.partial).map(cue => ({...cue}));
    const merged = mergeVideoAiSubtitleCues(filtered) as VideoAiStabilizedCue[];
    const consolidated = consolidateVideoAiFullCues(merged);
    return normalizeVideoAiSubtitleTimeline(consolidated).map(({startMs, durationMs, text}) => ({
        startMs,
        durationMs,
        text,
    }));
}

export function buildLocalMediaExport(
    baseName: string,
    cues: readonly LocalMediaCue[],
    mode: LocalMediaExportMode,
    format: SubtitleExportFormat,
): {filename: string; text: string; mime: string} {
    const prepared: VideoSubtitleCue[] = [];
    for (const cue of cues) {
        const translation = cue.translation?.trim() || '';
        if (mode === 'original') {
            prepared.push({startMs: cue.startMs, durationMs: cue.durationMs, text: cue.text});
        } else if (mode === 'translated') {
            if (translation) prepared.push({startMs: cue.startMs, durationMs: cue.durationMs, text: translation});
        } else {
            const text = translation && translation !== cue.text ? `${cue.text}\n${translation}` : cue.text;
            prepared.push({startMs: cue.startMs, durationMs: cue.durationMs, text});
        }
    }
    const serialized = serializeSubtitleFile(prepared, format);
    const safeName = sanitizeSubtitleFilename(baseName);
    return {
        filename: `${safeName}-${mode}.${serialized.extension}`,
        text: serialized.text,
        mime: serialized.mime,
    };
}

export class LocalMediaTranscriptionSession {
    private phase: LocalMediaTranscriptionPhase = 'idle';
    private progress = 0;
    private windowIndex = 0;
    private windowCount = 0;
    private durationMs = 0;
    private cues: LocalMediaCue[] = [];
    private error = '';
    private revision = 0;
    private disposed = false;
    private controller: AbortController | null = null;
    private readonly requests = new VideoAiRequestSession(`local-media:${crypto.randomUUID()}`);

    constructor(private readonly ports: LocalMediaTranscriptionPorts) {}

    getSnapshot(): LocalMediaSessionSnapshot {
        let translatedCount = 0;
        let failedTranslationCount = 0;
        for (const cue of this.cues) {
            if (cue.translation) translatedCount += 1;
            else if (cue.translationError) failedTranslationCount += 1;
        }
        return {
            phase: this.phase,
            progress: this.progress,
            windowIndex: this.windowIndex,
            windowCount: this.windowCount,
            translatedCount,
            failedTranslationCount,
            totalCues: this.cues.length,
            durationMs: this.durationMs,
            cues: this.cues.map(cue => ({...cue})),
            error: this.error,
        };
    }

    async transcribe(source: LocalMediaAudioSource, translateAfter = true): Promise<boolean> {
        if (this.disposed) return false;
        this.abortActive('cancel');
        const revision = ++this.revision;
        const controller = new AbortController();
        this.controller = controller;
        this.cues = [];
        this.error = '';
        this.windowIndex = 0;
        this.windowCount = 0;
        this.durationMs = 0;
        this.phase = 'checking';
        this.progress = 0;
        this.emit();

        try {
            const provider = this.ports.getProvider();
            const model = normalizeVideoLocalTranscriptionModel(this.ports.getModel());
            if (provider !== 'native-qwen') {
                const downloaded = await requestDownloadedLocalVideoModels(this.ports.send);
                if (!this.isCurrent(revision, controller.signal)) return false;
                if (!downloaded.includes(model)) {
                    throw new Error('请先在上方本地模型管理中下载所选 Whisper 模型，再开始离线转写');
                }
            }

            this.phase = 'decoding';
            this.progress = 0.08;
            this.emit();

            const decoded = await decodeLocalMediaToPcm16k(source, controller.signal, this.ports.decode);
            this.durationMs = decoded.durationMs;

            const windows = sliceLocalMediaWindows(decoded.pcm, model);
            this.windowCount = windows.length;
            this.phase = 'transcribing';
            this.progress = 0.2;
            this.emit();

            const identity = this.requests.start(
                revision,
                provider === 'native-qwen' ? NATIVE_QWEN_ASR_MODEL : model,
                this.ports.getSourceLanguage(),
                {provider, nativeBaseUrl: this.ports.getNativeBaseUrl()},
            )!;

            const stabilizer = new VideoAiTranscriptStabilizer({mode: 'complete'});
            const cueMap = new Map<string, VideoAiStabilizedCue>();
            let attributedEndMs = 0;

            const absorb = (incoming: VideoAiStabilizedCue[]) => {
                for (const cue of incoming) {
                    cueMap.set(cue.cueId!, {...cue, availableAtMs: 0});
                }
            };

            for (let index = 0; index < windows.length; index += 1) {
                if (!this.isCurrent(revision, controller.signal)) return false;
                const item = windows[index];
                if (item.overlapMs === 0 && index > 0) {
                    absorb(stabilizer.flush(0, true));
                    stabilizer.reset(true);
                }
                const response = await sendVideoSubtitleRequest(this.ports.send, {
                    type: 'fluentReadTranscribeLocalVideoAudio',
                    ...identity,
                    audioPcm16Base64: encodeVideoAiPcm16Base64(item.pcm),
                });
                if (!this.isCurrent(revision, controller.signal)) return false;
                if (!response.success) throw new Error(response.error || '本地离线识别失败');
                if (response.skipped) throw new Error('本地识别请求被新任务打断，请重试');

                const durationMs = item.endMs - item.startMs;
                const segments = alignVideoAiSegmentsToSpeech(
                    item.pcm,
                    response.segments?.length
                        ? response.segments
                        : [{startMs: 0, endMs: durationMs, text: response.text}],
                    attributedEndMs - item.startMs,
                );
                attributedEndMs = item.startMs + Math.max(0, ...segments.map(segment => segment.endMs!));
                absorb(stabilizer.ingest({
                    startMs: item.startMs,
                    durationMs,
                    availableAtMs: 0,
                    text: response.text,
                    segments,
                }));

                this.windowIndex = index + 1;
                this.progress = 0.2 + (this.windowIndex / Math.max(1, windows.length)) * 0.55;
                const stable = finalizeTranscriptCues([...cueMap.values()], false);
                if (stable.length > 0) this.cues = stable;
                this.emit();
            }

            absorb(stabilizer.flush(0, true));
            const finalCues = finalizeTranscriptCues([...cueMap.values()], true);
            this.cancelBackendStream(revision, 'complete');
            if (finalCues.length === 0) {
                throw new Error('未识别出可读字幕，请确认媒体包含清晰人声或切换更大的本地模型后重试');
            }
            this.cues = finalCues;

            if (translateAfter) {
                await this.runTranslationPass(revision, controller.signal);
                if (!this.isCurrent(revision, controller.signal)) return false;
            }

            this.phase = 'ready';
            this.progress = 1;
            this.controller = null;
            this.emit();
            return true;
        } catch (error) {
            if (!this.isCurrent(revision, controller.signal) || isAbortError(error)) return false;
            this.cancelBackendStream(revision, 'cancel');
            this.controller = null;
            this.phase = 'error';
            this.progress = 0;
            this.error = error instanceof Error ? error.message : '本地音视频转写失败';
            this.emit();
            return false;
        }
    }

    async translatePending(): Promise<boolean> {
        if (this.disposed || this.cues.length === 0) return false;
        this.abortActive('cancel');
        const revision = ++this.revision;
        const controller = new AbortController();
        this.controller = controller;
        this.error = '';
        await this.runTranslationPass(revision, controller.signal);
        if (!this.isCurrent(revision, controller.signal)) return false;
        this.phase = 'ready';
        this.progress = 1;
        this.controller = null;
        this.emit();
        return true;
    }

    cancel(): void {
        if (this.disposed) return;
        this.abortActive('cancel');
        this.phase = this.cues.length > 0 ? 'ready' : 'idle';
        this.progress = this.cues.length > 0 ? 1 : 0;
        this.error = '';
        this.emit();
    }

    reset(): void {
        if (this.disposed) return;
        this.abortActive('cancel');
        this.cues = [];
        this.phase = 'idle';
        this.progress = 0;
        this.windowIndex = 0;
        this.windowCount = 0;
        this.durationMs = 0;
        this.error = '';
        this.emit();
    }

    destroy(): void {
        this.disposed = true;
        this.abortActive('cancel');
        this.requests.dispose();
        this.cues = [];
    }

    private isCurrent(revision: number, signal: AbortSignal): boolean {
        return !this.disposed && revision === this.revision && !signal.aborted;
    }

    private cancelBackendStream(session: number, reason: 'cancel' | 'complete'): void {
        const identity = this.requests.read(session);
        if (identity) {
            void sendVideoSubtitleRequest(this.ports.send, {
                type: 'fluentReadCancelLocalVideoTranscription',
                ...identity,
                reason,
            }).catch(() => undefined);
        }
    }

    private abortActive(reason: 'cancel' | 'complete'): void {
        const activeRevision = this.revision;
        this.revision += 1;
        this.controller?.abort();
        this.controller = null;
        this.cancelBackendStream(activeRevision, reason);
    }

    private async runTranslationPass(revision: number, signal: AbortSignal): Promise<void> {
        const pendingIndices = this.cues
            .map((cue, index) => (!cue.translation ? index : -1))
            .filter(index => index >= 0);
        if (pendingIndices.length === 0) return;

        this.phase = 'translating';
        this.progress = 0.75;
        this.emit();

        const targetLanguage = this.ports.getTargetLanguage();
        const sourceLanguage = this.ports.getSourceLanguage();
        let cursor = 0;
        let completed = 0;

        const worker = async () => {
            while (cursor < pendingIndices.length) {
                if (!this.isCurrent(revision, signal)) return;
                const cueIndex = pendingIndices[cursor++];
                const cue = this.cues[cueIndex];
                try {
                    const translated = isVideoSubtitleInTargetLanguage(cue.text, targetLanguage)
                        ? cue.text
                        : await this.ports.translate(cue.text, signal, sourceLanguage);
                    if (!this.isCurrent(revision, signal)) return;
                    cue.translation = translated;
                    cue.translationError = undefined;
                } catch (error) {
                    if (!this.isCurrent(revision, signal) || isAbortError(error)) return;
                    cue.translationError = error instanceof Error ? error.message : '翻译失败';
                }
                completed += 1;
                this.progress = 0.75 + (completed / pendingIndices.length) * 0.25;
                this.emit();
            }
        };

        const workers = Array.from({length: Math.min(TRANSLATION_CONCURRENCY, pendingIndices.length)}, () => worker());
        await Promise.all(workers);
    }

    private emit(): void {
        this.ports.onUpdate(this.getSnapshot());
    }
}
