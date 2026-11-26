/**
 * @file scripts/testing/pdfjs-assets.mjs
 * 文件职责：声明 PDF.js 本地图像解码器及其许可证的打包白名单。
 * 主要内容：保留 JPEG 2000、JBIG2 的预编译 WASM 及其许可证；所有受支持浏览器（Chrome 87+、Edge 88+、Firefox 140+、Safari 26+）均原生支持 WASM，不再打包无 WASM JS 回退。
 * 模块边界：构建和产物校验共享此清单，不包含未启用的 PDF 脚本沙箱与色彩资源。
 */
export const PDFJS_DECODER_FILES = Object.freeze([
    'openjpeg.wasm', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG',
    'jbig2.wasm', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2',
]);
