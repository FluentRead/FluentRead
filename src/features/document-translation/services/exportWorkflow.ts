/**
 * @file src/features/document-translation/services/exportWorkflow.ts
 * 文件职责：拥有单文档与批量文档导出的操作资格、取消和下载资源生命周期。
 * 主要内容：调用时捕获任务、原文、译文和修订；编码与归档结束后再次检查任务身份，取消或切换后拒绝下载旧内容；仅确认已导出的修订，集中清理对象 URL 与成功提示计时器。
 * 模块边界：不保存第二份任务状态、不实现格式编码或历史提交；任务资格、编码、展示事件与浏览器下载通过显式端口连接。
 */
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import type JSZip from 'jszip';
import type {DocumentRenderMode} from '../core/document';
import type {PdfReadingPresentation} from '../core/pdfReadingPlan';
import type {createDocumentDownload, PdfExportProgress} from './binary';
import type {generateDocumentArchive} from './archive';
import type {DocumentQueueItem} from '../ui/useDocumentTasks';

type ExportKind = 'single' | 'batch';
export type DocumentExportProgress = {kind: ExportKind; name?: string} & (
    {pdf: PdfExportProgress} | {percent: number} | {saving: true}
);
export interface DocumentExportPorts {
    createDownload: typeof createDocumentDownload;
    createArchive(): Promise<JSZip>;
    generateArchive: typeof generateDocumentArchive;
    isActiveTask(task: DocumentQueueItem): boolean;
    containsTask(task: DocumentQueueItem): boolean;
    createUrl(blob: Blob): string;
    revokeUrl(url: string): void;
    triggerDownload(url: string, fileName: string): void;
    onState(state: {busy: boolean; canceling: boolean}): void;
    onStart(kind: ExportKind): void;
    onProgress(progress: DocumentExportProgress): void;
    onComplete(kind: ExportKind, count: number): void;
    onError(kind: ExportKind, error: unknown, canceled: boolean): void;
    onNoticeExpired(): void;
}

export function createDocumentExportWorkflow(ports: DocumentExportPorts) {
    let generation = 0;
    let active: AbortController | null = null;
    let disposed = false;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const urls = new Map<string, ReturnType<typeof setTimeout>>();

    function clearResources(): void {
        if (noticeTimer !== undefined) {clearTimeout(noticeTimer);noticeTimer = undefined;}
        for (const [url, timer] of urls) {clearTimeout(timer);ports.revokeUrl(url);}
        urls.clear();
    }
    function reset(): void {
        generation += 1;
        active?.abort();
        active = null;
        clearResources();
        if (!disposed) ports.onState({busy: false, canceling: false});
    }
    function saveBlob(blob: Blob, fileName: string): void {
        if (disposed) return;
        const request = generation;
        const url = ports.createUrl(blob);
        try {
            ports.triggerDownload(url, fileName);
            // 下载交接可同步触发 pagehide/reset，已经失去生命周期时立即释放。
            if (disposed || request !== generation) {ports.revokeUrl(url);return;}
            // 浏览器接收下载后才释放 URL；reset/dispose 会取消尚未触发的回收计时器。
            const timer = setTimeout(() => {urls.delete(url);ports.revokeUrl(url);}, 1000);
            urls.set(url, timer);
        } catch (error) {
            ports.revokeUrl(url);
            throw error;
        }
    }
    function snapshot(task: DocumentQueueItem) {
        return {task, document: task.document!, translations: [...task.translations], revision: task.revision};
    }
    type Snapshot = ReturnType<typeof snapshot>;
    function validSnapshot(value: Snapshot, kind: ExportKind): boolean {
        return value.document === value.task.document && (kind === 'single' ? ports.isActiveTask(value.task) : ports.containsTask(value.task));
    }
    async function run(kind: ExportKind, values: Snapshot[], build: (signal: AbortSignal, current: () => boolean) => Promise<{blob: Blob; fileName: string} | null>): Promise<void> {
        if (disposed || active || !values.length) return;
        const controller = new AbortController(), request = ++generation;
        active = controller;
        const owned = () => !disposed && request === generation && active === controller && values.every(value => validSnapshot(value, kind));
        const current = () => owned() && !controller.signal.aborted;
        ports.onState({busy: true, canceling: false});
        ports.onStart(kind);
        try {
            const result = await build(controller.signal, current);
            controller.signal.throwIfAborted();
            if (!current() || !result) return;
            saveBlob(result.blob, result.fileName);
            if (!current()) return;
            for (const value of values) value.task.downloaded = value.revision;
            ports.onComplete(kind, values.length);
            if (kind === 'single' && current()) {
                if (noticeTimer !== undefined) clearTimeout(noticeTimer);
                noticeTimer = setTimeout(() => {noticeTimer = undefined;if (!disposed) ports.onNoticeExpired();}, 5000);
            }
        } catch (error) {
            if (owned()) ports.onError(kind, error, controller.signal.aborted);
        } finally {
            if (active === controller) {
                active = null;
                if (!disposed) ports.onState({busy: false, canceling: false});
            }
        }
    }

    return {
        single(task: DocumentQueueItem, mode: DocumentRenderMode, presentation: PdfReadingPresentation): Promise<void> {
            if (!task.document) return Promise.resolve();
            const value = snapshot(task);
            return run('single', [value], async (signal, current) => {
                const download = await ports.createDownload(value.document, value.translations, mode, {signal, pdfPresentation: presentation,
                    onPdfProgress: pdf => {if (current()) ports.onProgress({kind: 'single', pdf});},
                    onArchiveProgress: percent => {if (current()) ports.onProgress({kind: 'single', percent});},
                });
                return {blob: new Blob([typeof download.data === 'string' ? download.data : asArrayBufferBytes(download.data)], {type: download.mimeType}), fileName: download.fileName};
            });
        },
        batch(tasks: readonly DocumentQueueItem[], mode: DocumentRenderMode): Promise<void> {
            const values = tasks.filter(task => task.document).map(snapshot);
            return run('batch', values, async (signal, current) => {
                const zip = await ports.createArchive();
                for (const [index, value] of values.entries()) {
                    if (!current()) return null;
                    const download = await ports.createDownload(value.document, value.translations, mode, {signal, pdfPresentation: 'layout',
                        onPdfProgress: pdf => {if (current()) ports.onProgress({kind: 'batch', name: value.task.name, pdf});},
                        onArchiveProgress: percent => {if (current()) ports.onProgress({kind: 'batch', name: value.task.name, percent});},
                    });
                    if (!current()) return null;
                    const name = download.fileName.replace(/[\\/\x00-\x1f]/g, '_');
                    zip.file(`${index + 1}/${name}`, download.data);
                }
                ports.onProgress({kind: 'batch', saving: true});
                const bytes = await ports.generateArchive(zip, {streamFiles: true}, {signal,
                    onProgress: percent => {if (current()) ports.onProgress({kind: 'batch', percent});},
                });
                return {blob: new Blob([asArrayBufferBytes(bytes)], {type: 'application/zip'}), fileName: 'FluentRead-documents.zip'};
            });
        },
        saveBlob,
        cancel: () => {if (active && !disposed) {ports.onState({busy: true, canceling: true});active.abort();}},
        reset,
        dispose: () => {disposed = true;reset();},
    };
}
