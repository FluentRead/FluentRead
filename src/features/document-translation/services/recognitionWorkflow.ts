/**
 * @file src/features/document-translation/services/recognitionWorkflow.ts
 * 文件职责：拥有文档 OCR 操作的取消信号、代次和父翻译会话监听清理。
 * 主要内容：识别使用调用时原文与语言，进度、逐页检查点和最终结果必须同时属于当前识别及捕获的翻译会话；切换、取消和卸载撤销迟到结果的提交资格。
 * 模块边界：不复制或提交任务状态、不启动翻译、不读配置；识别适配、会话资格和显示进度由显式端口注入。
 */
import type {ParsedDocument} from '../core/document';
import type {PdfPageRecognizer, recognizePdfDocument} from './pdfOcr';

export interface DocumentRecognitionPorts {
    recognize: typeof recognizePdfDocument;
    createRecognizer(language: string): PdfPageRecognizer;
    onProgress(progress: {completed: number; total: number} | null): void;
}

export function createDocumentRecognitionWorkflow(ports: DocumentRecognitionPorts) {
    let generation = 0;
    let active: AbortController | null = null;
    let disposed = false;
    function cancel(): void {
        generation += 1;
        active?.abort();
        active = null;
        if (!disposed) ports.onProgress(null);
    }
    return {
        async recognize(document: ParsedDocument, options: {sourceLanguage: string; startPage: number; pageIndexes?: readonly number[]; signal: AbortSignal; isCurrent(): boolean; onCheckpoint?(document: ParsedDocument): void}): Promise<ParsedDocument | null> {
            if (disposed || options.signal.aborted || !options.isCurrent()) return null;
            cancel();
            const controller = new AbortController(), request = generation;
            active = controller;
            const current = () => !disposed && request === generation && active === controller && !controller.signal.aborted && options.isCurrent();
            const abort = () => controller.abort();
            options.signal.addEventListener('abort', abort, {once: true});
            let result: ParsedDocument | null = null;
            let failed = false;
            let failure: unknown;
            try {
                const recognized = await ports.recognize(document, ports.createRecognizer(options.sourceLanguage), {
                    signal: controller.signal, startPage: options.startPage,
                    ...(options.pageIndexes === undefined ? {} : {pageIndexes: [...options.pageIndexes]}),
                    onProgress: progress => {if (current()) ports.onProgress(progress);},
                    onCheckpoint: checkpoint => {if (current()) options.onCheckpoint?.(checkpoint);},
                });
                if (current()) result = recognized;
            } catch (error) {
                failed = current();
                failure = error;
            } finally {
                options.signal.removeEventListener('abort', abort);
                if (active === controller) {
                    active = null;
                    ports.onProgress(null);
                }
            }
            if (failed) throw failure;
            return result;
        },
        cancel,
        dispose: () => {disposed = true;cancel();},
    };
}
