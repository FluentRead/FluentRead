/**
 * @file src/features/document-translation/services/importWorkflow.ts
 * 文件职责：拥有文档文件、在线 PDF 与本地历史重新打开的导入生命周期。
 * 主要内容：在同一取消代次中校验格式和大小、读取格式、恢复 OCR 与人工校订历史以及当前任务的重译缓存策略；历史不可读取时标记任务以阻止旧记录被自动覆盖；取消后丢弃迟到读取，失败文件独立入队，不改写已有文档的译文或翻译错误。
 * 模块边界：不持有任务队列、当前选择、进度或历史提交副本；读取、任务提交和展示均经显式端口，历史保存仍由页面的 historyCommitter 负责。
 */
import {getDocumentFormat, getDocumentMaxBytes, type ParsedDocument} from '../core/document';
import type {parseDocumentFile} from './binary';
import type {fetchOnlinePdf, PdfDownloadProgress} from './pdfSource';
import {documentHistoryId, restoreDocumentHistoryPdfOcr, restoreDocumentHistoryRevisions, type DocumentHistory} from './history';
import type {DocumentQueueItem} from '../ui/useDocumentTasks';

export interface DocumentImportPorts {
    parseFile: typeof parseDocumentFile;
    fetchPdf: typeof fetchOnlinePdf;
    history: Pick<DocumentHistory, 'loadChecked'> | null;
    parsedVersion: number;
    createTask(file: File, sourceUrl?: string): DocumentQueueItem;
    appendTask(task: DocumentQueueItem, select: boolean): void;
    releaseDocument(document: ParsedDocument): void;
    onStart(): void;
    onPhase(phase: 'reading' | 'downloading' | 'idle'): void;
    onReadProgress(progress: {completed: number; total: number}): void;
    onDownloadProgress(progress: PdfDownloadProgress): void;
    onOnlineError(error: unknown): void;
    onHistoryUnavailable(): void;
    onFinished(): void;
    onHistoryMissing(): Promise<void>;
}

export function createDocumentImportWorkflow(ports: DocumentImportPorts) {
    let generation = 0;
    let active: AbortController | null = null;
    let disposed = false;

    function cancel(): void {
        generation += 1;
        active?.abort();
        active = null;
        if (!disposed) ports.onPhase('idle');
    }

    function begin() {
        cancel();
        const controller = new AbortController();
        const request = generation;
        active = controller;
        ports.onStart();
        return {controller, current: () => !disposed && request === generation && active === controller && !controller.signal.aborted};
    }
    type Operation = ReturnType<typeof begin>;

    async function readFiles(files: readonly File[], sourceUrl: string | undefined, operation: Operation): Promise<void> {
        ports.onPhase('reading');
        let selected = false;
        for (const file of files) {
            if (!operation.current()) return;
            const task = ports.createTask(file, sourceUrl);
            let parsed: ParsedDocument | undefined;
            try {
                if (!getDocumentFormat(file.name)) throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件。');
                const maximum = getDocumentMaxBytes(file.name);
                if (file.size > maximum) throw new Error(`文件大小超过 ${Math.round(maximum / 1024 / 1024)} MB，请先拆分文件后再翻译。`);
                parsed = await ports.parseFile(file, {signal: operation.controller.signal,
                    onPdfProgress: progress => {if (operation.current()) ports.onReadProgress(progress);}});
                if (!operation.current()) return;
                if (!parsed.segments.length && parsed.binary?.kind !== 'pdf') throw new Error('文件中没有找到可翻译的文本片段。');
                task.document = parsed;
                task.originalFile = file;
                if (ports.history) {
                    const bytes = parsed.binary?.bytes ?? new Uint8Array(await file.arrayBuffer());
                    if (!operation.current()) return;
                    const historyId = await documentHistoryId(bytes);
                    if (!operation.current()) return;
                    const result = historyId ? await ports.history.loadChecked(historyId) : {status: 'unavailable' as const};
                    if (!operation.current()) return;
                    Object.assign(task, {historyId, bytes, mimeType: file.type});
                    if (!historyId || result.status === 'unavailable') task.historyReadUnavailable = true;
                    const saved = result.status === 'ok' ? result.record : null;
                    if (result.status === 'ok') task.historyVersion = result.version;
                    if (saved) {
                        const restored = restoreDocumentHistoryPdfOcr(saved, parsed);
                        task.document = restored.document;
                        Object.assign(task, restoreDocumentHistoryRevisions(saved, restored.document, ports.parsedVersion, restored.segmentOrigins),
                            {fingerprint: saved.fingerprint, bypassCache: saved.bypassCache === true});
                        // 同版本记录刚被读取，未经编辑不应立刻生成新写入身份干扰其他页面。
                        if (saved.parsedVersion === ports.parsedVersion) task.savedRevision = 0;
                    }
                }
            } catch (error) {
                if (!operation.current()) return;
                task.error = error instanceof Error ? error.message : String(error);
            } finally {
                // 未交给任务模型的解析结果没有新的所有者，迟到 PDF 资源必须在此释放。
                if (parsed && !operation.current()) ports.releaseDocument(parsed);
            }
            const select = Boolean(task.document && !selected);
            if (select) selected = true;
            ports.appendTask(task, select);
        }
    }

    async function run(action: (operation: Operation) => Promise<void>): Promise<void> {
        if (disposed) return;
        const operation = begin();
        try {await action(operation);}
        catch (error) {if (operation.current()) ports.onOnlineError(error);}
        finally {
            if (operation.current()) {
                active = null;
                ports.onPhase('idle');
                ports.onFinished();
            }
        }
    }

    return {
        loadFiles: (files: readonly File[], sourceUrl?: string) => !files.length ? Promise.resolve() : run(operation => readFiles(files, sourceUrl, operation)),
        openOnlinePdf: (sourceUrl: string) => run(async operation => {
            ports.onPhase('downloading');
            const file = await ports.fetchPdf(sourceUrl, {signal: operation.controller.signal,
                onProgress: progress => {if (operation.current()) ports.onDownloadProgress(progress);}});
            if (operation.current()) await readFiles([file], sourceUrl, operation);
        }),
        openHistory: (id: string) => run(async operation => {
            ports.onPhase('reading');
            const result = await ports.history?.loadChecked(id);
            if (!operation.current()) return;
            if (result?.status === 'unavailable') {ports.onHistoryUnavailable();return;}
            if (!result || result.status !== 'ok') {await ports.onHistoryMissing();return;}
            const record = result.record;
            if (!record) {await ports.onHistoryMissing();return;}
            const snapshot = record.parsedVersion === ports.parsedVersion ? record.parsed as ParsedDocument | undefined : undefined;
            const file = new File([record.bytes], record.name, {type: record.mimeType});
            if (!snapshot?.segments) {await readFiles([file], record.sourceUrl, operation);return;}
            const task = ports.createTask(file, record.sourceUrl);
            Object.assign(task, {document: snapshot, historyId: record.id, historyVersion: result.version, bytes: record.bytes, mimeType: record.mimeType,
                ...restoreDocumentHistoryRevisions(record, snapshot, ports.parsedVersion), fingerprint: record.fingerprint,
                bypassCache: record.bypassCache === true,
                savedRevision: 0});
            ports.appendTask(task, true);
        }),
        cancel,
        dispose: () => {disposed = true;cancel();},
    };
}
