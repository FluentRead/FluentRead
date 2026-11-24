/**
 * @file src/features/document-translation/services/pdfExportLinks.ts
 * 文件职责：把源 PDF 原文侧的网页链接放回导出页上实际嵌入的原稿位置。
 * 主要内容：从标准 Link 注释读取 HTTP(S) 目标，裁剪热区后按源页面角度投影；只重建链接自身的 URI 动作。
 * 模块边界：操作已有 pdf-lib 页面，不访问目标网址，不加载源文件，不复制原稿的附加动作或其他注释对象。
 */
import {PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, type PDFPage} from 'pdf-lib';

interface SourceBox {left: number; bottom: number; right: number; top: number}
interface PdfWebLink {url: string; rect: [number, number, number, number]}

export function readPdfWebLinks(page: PDFPage, box: SourceBox): PdfWebLink[] {
    const name = PDFName.of;
    const annotations = page.doc.context.lookup(page.node.get(name('Annots')));
    if (!(annotations instanceof PDFArray)) return [];
    const links: PdfWebLink[] = [];
    for (let index = 0; index < annotations.size(); index += 1) {
        const annotation = annotations.lookup(index);
        if (!(annotation instanceof PDFDict) || annotation.lookup(name('Subtype')) !== name('Link')) continue;
        const flags = annotation.lookup(name('F'));
        if (flags instanceof PDFNumber && (flags.asNumber() & 35)) continue; // Invisible, Hidden, NoView
        const action = annotation.lookup(name('A'));
        if (!(action instanceof PDFDict) || action.lookup(name('S')) !== name('URI')) continue;
        const target = action.lookup(name('URI'));
        if (!(target instanceof PDFString || target instanceof PDFHexString)) continue;
        let url: URL;
        try {url = new URL(target.decodeText().trim());}
        catch {continue;}
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        const rectangle = annotation.lookup(name('Rect'));
        if (!(rectangle instanceof PDFArray) || rectangle.size() !== 4) continue;
        const coordinates = rectangle.asArray().map(entry => {
            const value = page.doc.context.lookup(entry);
            return value instanceof PDFNumber ? value.asNumber() : NaN;
        });
        if (!coordinates.every(Number.isFinite)) continue;
        const [x, y, endX, endY] = coordinates;
        const left = Math.max(box.left, Math.min(x, endX));
        const right = Math.min(box.right, Math.max(x, endX));
        const bottom = Math.max(box.bottom, Math.min(y, endY));
        const top = Math.min(box.top, Math.max(y, endY));
        if (right <= left || top <= bottom) continue;
        const width = box.right - box.left, height = box.top - box.bottom;
        links.push({url: url.href, rect: [(left - box.left) / width, (bottom - box.bottom) / height,
            (right - box.left) / width, (top - box.bottom) / height]});
    }
    return links;
}

/** 源热区已经裁剪并归一化为从左下出发的坐标；使用与原页内容流相同的旋转和缩放。 */
export function drawPdfWebLinks(page: PDFPage, links: readonly PdfWebLink[], width: number, height: number, rotation: number, offsetX: number): void {
    const point = (x: number, y: number) => rotation === 90 ? [y, 1 - x] : rotation === 180 ? [1 - x, 1 - y]
        : rotation === 270 ? [1 - y, x] : [x, y];
    for (const {rect, url} of links) {
        const [x, y] = point(rect[0], rect[1]), [endX, endY] = point(rect[2], rect[3]);
        const object = page.doc.context.obj({Type: 'Annot', Subtype: 'Link',
            Rect: [offsetX + Math.min(x, endX) * width, Math.min(y, endY) * height,
                offsetX + Math.max(x, endX) * width, Math.max(y, endY) * height],
            // PDF URI 字节串沿用 URL 的 ASCII 序列，不能用带 UTF-16 BOM 的显示文字编码。
            Border: [0, 0, 0], A: {S: 'URI', URI: PDFString.of(url.replace(/[\\()]/gu, '\\$&'))}});
        page.node.addAnnot(page.doc.context.register(object));
    }
}
