/**
 * @file src/features/document-translation/services/pdfReadingFont.ts
 * 文件职责：仅在导出可读 PDF 时加载随扩展提供的开放字体，嵌入可见文字及 Unicode 映射。
 * 主要内容：按需读取固定 Noto CJK 字体，使用 pdf-lib 官方 fontkit 子集机制；提前拒绝缺字，避免生成外观方框、复制乱码的下载文件。不保存字体解析器或导出文档的全局引用。
 * 模块边界：属于文档二进制服务，不进入内容脚本字体或界面字体下载链路，不请求第三方网络。
 */
import type {PDFDocument, PDFFont} from 'pdf-lib';

export const PDF_READING_FONT_PATH = '/pdf-fonts/FluentReadNotoSansSC-Regular.woff2';
export const PDF_READING_FONT_BYTES = 4_977_684;

export async function loadPdfReadingFontBytes(signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const response = await fetch(PDF_READING_FONT_PATH, {signal, cache: 'force-cache'});
    if (!response.ok) throw new Error('PDF 导出字体加载失败，请重新打开文档后重试');
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength !== PDF_READING_FONT_BYTES) throw new Error('PDF 导出字体不完整，请重新安装正式扩展后重试');
    return bytes;
}

export interface PdfReadingEmbeddedFont {font: PDFFont; assertSupported(text: string): void}

export async function embedPdfReadingFont(pdf: PDFDocument, bytes: Uint8Array, signal?: AbortSignal): Promise<PdfReadingEmbeddedFont> {
    signal?.throwIfAborted();
    const {default: fontkit} = await import('@pdf-lib/fontkit');
    signal?.throwIfAborted();
    pdf.registerFontkit(fontkit);
    // 不依赖字体默认启用的拉丁连字；测量和输出都使用同一套可见字形。
    const font = await pdf.embedFont(bytes, {subset: true, features: {liga: false}});
    const supported = new Set(font.getCharacterSet());
    signal?.throwIfAborted();
    return {font, assertSupported(text) {
        for (const character of text) {
            if (/^[\n\r\t]$/u.test(character)) continue;
            const code = character.codePointAt(0)!;
            if (!supported.has(code)) {
                throw new Error(`PDF 导出字体缺少字符 ${character} (U+${code.toString(16).toUpperCase()})，请校订该字符后重试；没有生成缺字的 PDF`);
            }
        }
    }};
}
