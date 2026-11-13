/**
 * @file src/features/document-translation/ui/pdfOcrTextLayer.ts
 * 文件职责：在已识别扫描页的原图上提供透明 OCR 文字层，使原文可以选择、复制并沿用文档划词能力。
 * 主要内容：消费现有版面行及阅读顺序，按原页坐标定位、以实际字体测量匹配行宽；扫描内容已摆正，因此清除原生文字层的旋转变换；只在文字或几何改变时更新节点，缩放、翻译和其他页检查点保留原有 Range 与画布。未知、空白或越界行不进入选择层，测量画布在使用后释放。
 * 模块边界：只更新阅读器已经拥有的文字层节点，不识别文字、不修改源 PDF 或文档模型；挂载、选择交互、离屏回收与文档切换继续使用现有阅读器生命周期。
 */
import type {PdfDocumentPage} from '@/src/features/document-translation/core/document';

const installed = new WeakMap<HTMLElement, string>();

export function updatePdfOcrTextLayer(element: HTMLElement, page: PdfDocumentPage): void {
    // ocrReviewRegions 也兼容此前已经保存、尚未带显式 OCR 来源标记的识别结果。
    if (page.scanned || !page.ocrRecognized && page.ocrReviewRegions === undefined) return;
    const lines = page.blocks.flatMap(block => (block.lines ?? []).flatMap(line => {
        const size = line.fontSize ?? block.fontSize;
        if (!line.text.trim() || ![line.x, line.y, line.width, line.height, size].every(Number.isFinite)
            || size <= 0 || line.width <= 0 || line.height <= 0 || line.x < 0 || line.y < 0
            || line.x + line.width > page.width + 1 || line.y + line.height > page.height + 1) return [];
        return [{text: line.text, x: line.x, y: line.y, width: line.width, height: line.height, size,
            family: line.fontFamily || block.fontFamily || 'sans-serif', weight: block.fontWeight}];
    }));
    if (!lines.length) return;
    const identity = JSON.stringify([page.pageNumber, page.width, page.height, lines]);
    if (installed.get(element) === identity) return;
    const document = element.ownerDocument, fragment = document.createDocumentFragment();
    const canvas = document.createElement('canvas');
    try {
        const context = canvas.getContext('2d');
        for (const line of lines) {
            if (context) context.font = `${line.weight} ${line.size}px ${line.family}`;
            const measured = context?.measureText(line.text).width;
            const naturalWidth = measured !== undefined && Number.isFinite(measured) && measured > 0 ? measured : Math.max(1, line.text.length * line.size * .6);
            const span = document.createElement('span');
            span.textContent = line.text;
            span.dir = 'auto';
            span.setAttribute('data-pdf-ocr-line', '');
            Object.assign(span.style, {left: `${line.x}px`, top: `${line.y}px`, fontFamily: line.family,
                fontWeight: String(line.weight), fontSize: `${line.size}px`, lineHeight: `${line.height}px`,
                height: `${line.height}px`, transform: `scaleX(${line.width / naturalWidth})`});
            const end = document.createElement('br');
            Object.assign(end.style, {left: `${line.x + line.width}px`, top: `${line.y}px`, height: `${line.height}px`});
            fragment.append(span, end);
        }
        element.replaceChildren(fragment);
        element.removeAttribute('data-main-rotation');
        element.style.width = `${page.width}px`; element.style.height = `${page.height}px`;
        element.setAttribute('data-pdf-ocr-text', '');
        element.setAttribute('data-pdf-page-number', String(page.pageNumber));
        element.setAttribute('data-fluentread-pdf-page-text', lines.map(line => line.text).join(' '));
        installed.set(element, identity);
    } finally {
        canvas.width = canvas.height = 0;
    }
}
