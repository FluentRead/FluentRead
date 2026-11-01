/**
 * @file src/features/image-translation/services/mangaInference.worker.ts
 * 文件职责：在独立 Worker 中执行 PaddleOCR、气泡分析和 LaMa，保持 Offscreen 音频与消息线程响应。
 * 主要内容：复用两个已校验模型端口，真实下载和初始化阶段转发，CPU 重建锁定后端；输出张量转移所有权；串行会话创建避免同一 Asyncify 运行时交错初始化。
 * 模块边界：不读取网页、不翻译文本、不播放音频；取消和超时由 Worker 外部 owner 硬终止。
 */
import * as ort from 'onnxruntime-web/webgpu';
import {forceSingleThreadInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {createBrowserMangaOcr} from './mangaOcr';
import {createBrowserMangaInpainter} from './mangaInpainting';
import type {MangaInferenceMessage, MangaInferenceResponse} from './mangaInferenceClient';

export function startMangaInferenceWorker(): void {
    let ocr: Awaited<ReturnType<typeof createBrowserMangaOcr>> | undefined;
    let painter: Awaited<ReturnType<typeof createBrowserMangaInpainter>> | undefined;
    let tail: Promise<void> = Promise.resolve(), creating: Promise<void> = Promise.resolve();
    const create = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = ((...args: Parameters<typeof create>) => {
        const result = creating.then(() => paceLocalInitialization(() => create(...args)));
        creating = result.then(() => undefined, () => undefined);
        return result;
    }) as typeof create;
    const scope = self as unknown as {postMessage(message: MangaInferenceResponse, transfer: Transferable[]): void};
    const post = (response: MangaInferenceResponse) => {
        const transfer:Transferable[]=[],result=response.result;
        if(result instanceof Float32Array){if(result.buffer instanceof ArrayBuffer)transfer.push(result.buffer);}
        else {
            const frames=result?.imageDetectionFrames;
            if(frames?.length){
                const seen=new Set<ArrayBuffer>();
                for(const frame of frames)if(frame.bits.buffer instanceof ArrayBuffer&&!seen.has(frame.bits.buffer)){
                    seen.add(frame.bits.buffer);transfer.push(frame.bits.buffer);
                }
            }
        }
        scope.postMessage(response,transfer);
    };
    async function handle(message: MangaInferenceMessage) {
        const requestId = message.requestId;
        try {
            if (message.cpu) {forceSingleThreadInference(); Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true});}
            const progress = (stage: 'preparing' | 'initializing' | 'recognizing', percent?: number) => post({requestId, stage, percent});
            let result: MangaInferenceResponse['result'];
            if (message.type === 'dispose-ocr') { await ocr?.destroy(); ocr = undefined; }
            else if (message.type === 'dispose-inpaint') { await painter?.release(); painter = undefined; }
            else if (message.type === 'prepare-ocr' || message.type === 'recognize') {
                ocr ??= await createBrowserMangaOcr(undefined, progress);
                if (message.type === 'recognize') { progress('recognizing'); result = await ocr.recognize(message.image!, {flatten: true, noCache: true, strategy: 'per-box',...(message.imageDetectionEvidence===true?{imageDetectionEvidence:true as const}:{})}); }
            } else {
                painter ??= await createBrowserMangaInpainter(undefined, (percent, initializing) => progress(initializing ? 'initializing' : 'preparing', percent));
                if (message.type === 'inpaint') { progress('recognizing'); result = await painter.run(message.patch!); }
            }
            post({requestId, success: true, result});
        } catch (error) { post({requestId, success: false, error: error instanceof Error ? error.message : String(error)}); }
    }
    self.onmessage = (event: MessageEvent<MangaInferenceMessage>) => {
        const message = event.data;
        if (!message || !Number.isSafeInteger(message.requestId) || !['prepare-ocr', 'recognize', 'prepare-inpaint', 'inpaint', 'dispose-ocr', 'dispose-inpaint'].includes(message.type)) return;
        tail = tail.then(() => handle(message));
    };
}
