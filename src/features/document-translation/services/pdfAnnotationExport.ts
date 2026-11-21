/**
 * @file src/features/document-translation/services/pdfAnnotationExport.ts
 * 文件职责：把本地阅读批注写入原始 PDF 的标准注释数组，输出可在其他阅读器继续使用的副本。
 * 主要内容：保留原页和既有注释，以 CropBox 与 MediaBox 交集和页面旋转还原选区坐标；生成高亮/下划线的透明外观及 Unicode 备注，不改写源字节，不依赖网络字体。
 * 模块边界：只编码原文件副本，不读取 UI 或历史、不下载文件、不把批注发送到服务。
 */
import {PDFDocument, PDFHexString} from 'pdf-lib';
import {normalizePdfAnnotations, PDF_ANNOTATION_COLORS, type PdfAnnotation} from '../core/pdfAnnotations';

export async function exportPdfAnnotations(bytes: Uint8Array, input: readonly PdfAnnotation[]): Promise<Uint8Array> {
    const document = await PDFDocument.load(bytes.slice());
    const pages = document.getPages();
    const annotations = normalizePdfAnnotations(input, pages.length);
    for (const annotation of annotations) {
        const page = pages[annotation.page - 1];
        const media = page.getMediaBox(), crop = page.getCropBox();
        const left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
        const right = Math.min(media.x + media.width, crop.x + crop.width), top = Math.min(media.y + media.height, crop.y + crop.height);
        const box = right > left && top > bottom ? {x: left, y: bottom, width: right - left, height: top - bottom} : media;
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;
        const point = (u: number, v: number) => {
            const [x, y] = rotation === 90 ? [v, u] : rotation === 180 ? [1 - u, v] : rotation === 270 ? [1 - v, 1 - u] : [u, 1 - v];
            return [box.x + x * box.width, box.y + y * box.height];
        };
        const quads = annotation.rects.map(rect => [point(rect.x, rect.y), point(rect.x + rect.width, rect.y), point(rect.x, rect.y + rect.height), point(rect.x + rect.width, rect.y + rect.height)]);
        const xs = quads.flat().map(p => p[0]), ys = quads.flat().map(p => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
        const hex = PDF_ANNOTATION_COLORS[annotation.color];
        const color = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
        const path = quads.map(([tl, tr, bl, br]) => annotation.kind === 'highlight'
            ? `${tl[0] - x} ${tl[1] - y} m ${tr[0] - x} ${tr[1] - y} l ${br[0] - x} ${br[1] - y} l ${bl[0] - x} ${bl[1] - y} l h f`
            : `${bl[0] - x} ${bl[1] - y} m ${br[0] - x} ${br[1] - y} l S`).join('\n');
        const appearance = document.context.register(document.context.flateStream(`q /GS0 gs ${color.join(' ')} rg ${color.join(' ')} RG 1.2 w\n${path}\nQ`, {
            Type: 'XObject', Subtype: 'Form', BBox: [-1, -1, width + 1, height + 1],
            Resources: {ExtGState: {GS0: {Type: 'ExtGState', ca: annotation.kind === 'highlight' ? 0.3 : 1, CA: 1, BM: 'Multiply'}}},
        }));
        const object = document.context.obj({Type: 'Annot', Subtype: annotation.kind === 'highlight' ? 'Highlight' : 'Underline',
            Rect: [x - 1, y - 1, x + width + 1, y + height + 1], QuadPoints: quads.flat(2), C: color, F: 4,
            NM: PDFHexString.fromText(annotation.id), T: PDFHexString.fromText('FluentRead'),
            Contents: PDFHexString.fromText(`${annotation.quote}${annotation.note ? `\n\n${annotation.note}` : ''}`),
            AP: {N: appearance}, P: page.ref});
        // PDFPageLeaf.addAnnot 复用原 Annots 数组，不能覆盖其他工具已经写入的注释。
        page.node.addAnnot(document.context.register(object));
    }
    return document.save();
}
