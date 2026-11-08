/**
 * @file integrations/obsidian/pdf.ts
 * 文件职责：在 Obsidian 内本地提取 PDF 文字，沿用 FluentRead 的行与段落重建规则。
 * 主要内容：按页提取文字；取消立即销毁所属加载任务，失败也清理取得的页面；worker 导入与 blob URL 绑定插件生命周期。
 * 模块边界：不发送翻译请求、不写 vault；原生 PDF.js 异步调用由所属任务销毁，晚到导入不能在卸载后重新分配 worker。
 */
import type {DocumentSegment} from '../../src/features/document-translation/core/document';
import {
    pdfTextAtoms,
    pdfTextBlocks,
    pdfTextLines,
    type PdfTextItem,
    type PdfTextStyle,
} from '../../src/features/document-translation/services/binary';

let workerUrl: string | null = null;
let workerLifetime = 0;
const activeTasks = new Set<() => Promise<void>>();

function assertCurrent(lifetime: number, signal?: AbortSignal): void {
    if (lifetime !== workerLifetime || signal?.aborted) {
        const error = new Error('文档翻译已取消');
        error.name = 'AbortError';
        throw error;
    }
}

async function ensureWorker(lifetime: number, signal?: AbortSignal): Promise<void> {
    assertCurrent(lifetime, signal);
    if (typeof window === 'undefined') return;
    const {GlobalWorkerOptions} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent(lifetime, signal);
    if (!workerUrl) {
        const {default: source} = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw');
        assertCurrent(lifetime, signal);
        if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    }
    GlobalWorkerOptions.workerSrc = workerUrl;
}

export function disposePdfWorker(): void {
    workerLifetime += 1;
    for (const destroy of activeTasks) void destroy().catch(() => {});
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = null;
}

export async function extractPdfSegments(bytes: ArrayBuffer, signal?: AbortSignal): Promise<DocumentSegment[]> {
    const lifetime = workerLifetime;
    assertCurrent(lifetime, signal);
    if (new TextDecoder('latin1').decode(bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('PDF 文件签名无效，文件可能已损坏');
    }
    await ensureWorker(lifetime, signal);
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent(lifetime, signal);
    const loadingTask = getDocument({
        data: new Uint8Array(bytes),
        disableFontFace: true,
        disableWorkerRendering: true,
        useWorkerFetch: false,
    });
    let destruction: Promise<void> | undefined;
    const destroy = () => destruction ??= Promise.resolve().then(() => loadingTask.destroy());
    const onAbort = () => {void destroy().catch(() => {});};
    activeTasks.add(destroy);
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    const segments: DocumentSegment[] = [];
    let failed = false;
    try {
        const pdf = await loadingTask.promise;
        assertCurrent(lifetime, signal);
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            try {
                assertCurrent(lifetime, signal);
                const viewport = page.getViewport({scale: 1});
                const text = await page.getTextContent();
                assertCurrent(lifetime, signal);
                const atoms = pdfTextAtoms(
                    text.items.filter((item): item is PdfTextItem => 'str' in item),
                    text.styles as Record<string, PdfTextStyle>,
                    viewport,
                );
                const blocks = pdfTextBlocks(pdfTextLines(atoms, viewport.width), viewport.width);
                blocks.forEach((block, index) => segments.push({
                    id: segments.length,
                    source: block.source,
                    contextLabel: index === 0 ? `第 ${pageNumber} 页` : undefined,
                    role: block.fontWeight === 700 ? 'heading' : 'paragraph',
                }));
            } finally {
                page.cleanup();
            }
        }
    } catch (error) {
        failed = true;
        assertCurrent(lifetime, signal);
        throw error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        activeTasks.delete(destroy);
        if (failed || signal?.aborted || lifetime !== workerLifetime) await destroy().catch(() => {});
        else await destroy();
    }
    assertCurrent(lifetime, signal);
    if (segments.length === 0) throw new Error('PDF 中没有可提取文字；扫描版 PDF 暂不支持');
    return segments;
}
