/**
 * @file src/features/video-subtitle/content/video-ai/requestSession.ts
 * 文件职责：把完整音频采集的当前会话映射到后台流的唯一识别请求代际。
 * 主要内容：为每次采集开始分配单调增长的后台 generation，冻结模型和来源语言，只交付与当前本地会话匹配的请求身份，销毁后禁止创建请求但保留终止资源所需的身份。
 * 模块边界：不发送消息、不终止 Worker、不提前释放真实传输；runtime 用身份调用既有后台协议，采集器继续拥有音轨、音频上下文和本地结果提交资格。
 */
import type {VideoTranscriptionProvider} from '@/src/core/config/model';

export interface VideoAiRequestIdentity {
    readonly streamId: string;
    readonly generation: number;
    readonly model: string;
    readonly sourceLanguage: string;
    readonly provider?: VideoTranscriptionProvider;
    readonly nativeBaseUrl?: string;
}

export class VideoAiRequestSession {
    private disposed = false;
    private generation = 0;
    private request: {localGeneration: number; identity: VideoAiRequestIdentity} | undefined;

    constructor(private readonly streamId: string) {}

    start(localGeneration: number, model: string, sourceLanguage: string,
        selection?: {provider: VideoTranscriptionProvider; nativeBaseUrl: string}): VideoAiRequestIdentity | null {
        if (this.disposed) return null;
        const identity = Object.freeze({streamId: this.streamId, generation: ++this.generation, model, sourceLanguage,
            ...(selection ? {provider: selection.provider, nativeBaseUrl: selection.nativeBaseUrl} : {})});
        this.request = {localGeneration, identity};
        return identity;
    }

    read(localGeneration: number): VideoAiRequestIdentity | null {
        return this.request?.localGeneration === localGeneration ? this.request.identity : null;
    }

    dispose(): void {
        this.disposed = true;
        // 采集器 destroy 的最后一次取消仍需读到当前 generation；记录随 runtime 一起释放。
    }
}
