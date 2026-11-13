/**
 * @file src/features/document-translation/ui/pdfSourcePreview.ts
 * 文件职责：为逐行原文校订提供对应段落的原图裁剪，不使用已翻译或已编辑的文字重绘原图。
 * 主要内容：复用 PDF 原页渲染和可取消编码，按已识别的页面坐标裁剪并留少量核对边距；裁剪限制三百万像素与 2048 长边，成功、错误或取消后释放两张画布。
 * 模块边界：仅生成临时预览图，不执行 OCR、不保存文档、不创建 URL；界面负责预览 URL 和操作代次，原始 bytes 始终只读。
 */
import type {ParsedDocument} from '../core/document';
import {pdfSourceEditTarget} from '../services/pdfSourceEdits';
import {canvasToImageBytes, renderPdfSourceCanvas} from './pdfPreview';

export async function createPdfSourcePreview(document: ParsedDocument, pageNumber: number, blockIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const target = pdfSourceEditTarget(document, pageNumber, blockIndex);
    if (!target || document.binary?.kind !== 'pdf') throw new Error('PDF 原文校订位置无效');
    const {page, block} = target;
    const left = Math.max(0, block.x - 4), top = Math.max(0, block.y - 4);
    const right = Math.min(page.width, block.x + block.width + 4), bottom = Math.min(page.height, block.y + block.height + 4);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) throw new Error('PDF 原文校订位置无效');
    const source = await renderPdfSourceCanvas(document.binary.bytes, pageNumber, page.width, signal, true);
    let canvas: HTMLCanvasElement | undefined;
    try {
        signal?.throwIfAborted();
        const x = left * source.width / page.width, y = top * source.height / page.height;
        const width = (right - left) * source.width / page.width, height = (bottom - top) * source.height / page.height;
        const ratio = Math.min(1, 2048 / Math.max(width, height), Math.sqrt(3_000_000 / width / height));
        canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(width * ratio)); canvas.height = Math.max(1, Math.floor(height * ratio));
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) throw new Error('浏览器不支持原图预览');
        context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
        return await canvasToImageBytes(canvas, signal);
    } finally {
        source.width = source.height = 0;
        if (canvas) canvas.width = canvas.height = 0;
    }
}
