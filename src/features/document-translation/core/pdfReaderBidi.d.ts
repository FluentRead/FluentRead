/**
 * @file src/features/document-translation/core/pdfReaderBidi.d.ts
 * 文件职责：为构建器注入的锁定 PDF.js 双向文字纯函数模块提供编译期类型契约，供隐藏搜索层核对读回身份。
 * 主要内容：声明精确虚拟模块名称、字符串输入、只读文本与左右方向结果，以及不符合受限输入时返回空结果的类型。
 * 模块边界：此文件只声明类型，不携带内核运行代码、不读取 SDK 文件或启动 worker；真实源码提取和摘要校验由构建插件负责。
 */
declare module 'virtual:fluentread-pdfjs-bidi' {
    export function projectPdfReaderBidi(text: string): Readonly<{str: string; dir: 'ltr' | 'rtl'}> | undefined;
}
