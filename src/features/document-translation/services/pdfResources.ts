/**
 * @file src/features/document-translation/services/pdfResources.ts
 * 文件职责：为文档解析和页面渲染提供同一份 PDF.js 静态资源地址。
 * 主要内容：浏览器扩展沿用自有 origin 下的 pdfjs 目录；独立桌面应用可在组合根显式指定 worker、字形映射与标准字体的资源根，不让 chrome 协议的空 origin 破坏 PDF 加载。
 * 模块边界：只保存应用可信组合根安装的资源端口，不读取用户文件或网络配置，不加载脚本、不创建 PDF.js 实例。
 */
import defaultWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export interface PdfRuntimeResources {
    assetRoot: string;
    workerUrl: string;
}
let installed: Readonly<PdfRuntimeResources> | undefined;

/** 在独立应用启动时设置；不传参数时恢复浏览器扩展默认资源。 */
export function configurePdfResources(resources?: PdfRuntimeResources): void {
    installed = resources
        ? Object.freeze({assetRoot: resources.assetRoot.replace(/\/+$/u, ''), workerUrl: resources.workerUrl})
        : undefined;
}

export function hasCustomPdfAssetRoot(): boolean {
    return installed !== undefined;
}

export function getPdfResources(): PdfRuntimeResources {
    return installed ?? {
        assetRoot: typeof window === 'undefined' ? '' : `${window.location.origin}/pdfjs`,
        workerUrl: defaultWorkerUrl,
    };
}
