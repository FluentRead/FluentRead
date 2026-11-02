/** 构建时从锁定 PDF.js 提取的静态纯模块；仅做隐藏搜索层的读回兼容性检查。 */
declare module 'virtual:fluentread-pdfjs-bidi' {
    export function projectPdfReaderBidi(text: string): Readonly<{str: string; dir: 'ltr' | 'rtl'}> | undefined;
}
