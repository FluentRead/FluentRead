/**
 * @file src/features/document-translation/services/pdfSourceRecoveryWorkflow.ts
 * 文件职责：持有单个 PDF 原文校订窗口的图像渲染与按需文字识别生命周期，阻止取消、切换文档或修订变化后的迟到结果回写。
 * 主要内容：先按调用方选定的原页正文块取得图像，仅在用户显式要求时调用已有 OCR 端口；把识别原文与保守替换建议分别交给界面，所有异步回调都核对操作代次和任务资格。
 * 模块边界：不保存第二份文档任务、不自动接受识别结果、不下载模型或自行解析 PDF；图像、识别、错误呈现及身份检查通过显式端口提供，接受与撤销由同步原文校订事务负责。
 */
import {suggestPdfSourceOcrCorrection, type PdfSourceOcrSuggestion} from './pdfSourceOcrSuggestion';

export interface PdfSourceImage {image: string; width: number; height: number}
export interface PdfSourceRecoveryTarget {source: string; sourceLanguage: string; isCurrent(): boolean}
export interface PdfSourceRecoveryPorts<T extends PdfSourceRecoveryTarget> {
    render(target: T, signal: AbortSignal): Promise<PdfSourceImage>;
    recognize(image: string, language: string, signal: AbortSignal): Promise<readonly {text: string}[]>;
    onImage(image: PdfSourceImage): void;
    onRecognition(result: {recognizedText: string; suggestion?: PdfSourceOcrSuggestion}): void;
    onPhase(phase: 'rendering' | 'ready' | 'recognizing'): void;
    onError(stage: 'render' | 'recognize', error: unknown): void;
}

export function createPdfSourceRecoveryWorkflow<T extends PdfSourceRecoveryTarget>(ports: PdfSourceRecoveryPorts<T>) {
    let generation = 0, disposed = false;
    let active: {target: T; controller: AbortController; generation: number; image?: PdfSourceImage; recognizing: boolean} | undefined;
    const current = (operation: NonNullable<typeof active>) => !disposed && active === operation
        && generation === operation.generation && !operation.controller.signal.aborted && operation.target.isCurrent();
    function cancel(): void {
        generation += 1;
        active?.controller.abort();
        active = undefined;
    }
    return {
        async open(target: T): Promise<void> {
            cancel();
            if (disposed || !target.isCurrent()) return;
            const operation = {target, controller: new AbortController(), generation, recognizing: false, image: undefined as PdfSourceImage | undefined};
            active = operation;
            ports.onPhase('rendering');
            try {
                const image = await ports.render(target, operation.controller.signal);
                if (!current(operation)) return;
                operation.image = image;
                ports.onImage(image);
            } catch (error) {
                if (current(operation)) ports.onError('render', error);
            } finally {
                if (current(operation)) ports.onPhase('ready');
            }
        },
        async recognize(): Promise<void> {
            const operation = active;
            if (!operation?.image || operation.recognizing || !current(operation)) return;
            operation.recognizing = true;
            ports.onPhase('recognizing');
            try {
                const lines = await ports.recognize(operation.image.image, operation.target.sourceLanguage, operation.controller.signal);
                if (!current(operation)) return;
                const recognizedText = lines.map(line => line.text).join('\n');
                ports.onRecognition({recognizedText, suggestion: suggestPdfSourceOcrCorrection(operation.target.source, recognizedText)});
            } catch (error) {
                if (current(operation)) ports.onError('recognize', error);
            } finally {
                operation.recognizing = false;
                if (current(operation)) ports.onPhase('ready');
            }
        },
        cancel,
        dispose(): void {cancel(); disposed = true;},
    };
}
