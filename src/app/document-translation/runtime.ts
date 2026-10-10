/**
 * @file src/app/document-translation/runtime.ts
 * 文件职责：把通用翻译客户端、配置 store 与文档 feature 的纯服务连接起来，为页面提供可直接调用的分段翻译和文件下载适配器。
 * 主要内容：标记支持原生批量请求的机器服务并按固定服务和模型提供 AI 多段槽能力，不读取或改写全局 AI 多段开关，利用 createDocumentSegmentTranslator 组装本次文档默认批量、可关闭的翻译流程；为扫描版 PDF 组装“渲染页面 → 文字识别 → 换算坐标”的页面识别器；生成下载时注入 PDF 原版排版与阅读续页栅格化器，并持有、释放本次导出的 PDF.js 租约。
 * 模块边界：本文件是 app adapter，不解析源文件、不维护页面进度，也不实现 PDF/EPUB/DOCX 编码；业务算法归 document-translation feature，网络请求归 translation client。
 */
import {translateText, translateTextBatch} from '@/src/app/translation/client';
import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {buildGlossaryRevision} from '@/src/core/glossary';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {
    createDocumentDownload as createDocumentDownloadWithAdapters,
    type CreateDocumentDownloadOptions,
} from '@/src/features/document-translation/services/binary';
import {createDocumentSegmentTranslator} from '@/src/features/document-translation/services/translation';
import {acquirePdfDocument, rasterizePdfReadingPages, rasterizePdfTranslationPage, renderPdfPageImage} from '@/src/features/document-translation/ui/pdfPreview';
import type {PdfPageRecognizer} from '@/src/features/document-translation/services/pdfOcr';
import {config, configReady} from '@/src/services/config/store';
import type {
    DocumentRenderMode,
    ParsedDocument,
} from '@/src/features/document-translation/core/document';

const BATCH_DOCUMENT_SERVICES = new Set<string>([
    services.microsoft,
    services.freeTranslation,
]);

/** WXT 组合根：把运行时配置和翻译 API 注入纯文档业务服务。 */
export const translateDocumentSegments = createDocumentSegmentTranslator({
    getGlossaryOptions: () => ({
        glossaryIds: config.documentGlossaryIds,
        glossaryRevision: buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
    }),
    waitUntilReady: () => configReady,
    getDefaultService: () => config.service,
    getDefaultModel: (service) => resolveConfiguredModel(config.model?.[service], config.customModel?.[service]),
    supportsBatch: (service) => BATCH_DOCUMENT_SERVICES.has(service),
    supportsAIMultiSegment: (service, model) => servicesType.isUseAIContext(service, model),
    translateText,
    translateTextBatch,
});

/**
 * 文档页的失败重试预算：限流或暂时不可用时自动退避，累计最多等两分钟。
 * 作为可替换的组合根设置导出，测试可以把等待换成即时完成而不改变页面逻辑。
 */
export const documentRetryBackoff: {maxWaitMs: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>} = {maxWaitMs: 120_000};

/** 浏览器组合根为 PDF 下载注入 Canvas rasterizer；其他格式仍走同一纯二进制服务。 */
export async function createDocumentDownload(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions = {},
) {
    const usesBrowserRasterizer = options.pdfPresentation === 'readable'
        ? !options.pdfReadingRasterizer : !options.pdfPageRasterizer;
    const lease = document.binary?.kind === 'pdf' && usesBrowserRasterizer
        && translations.some((translation, index) => hasDistinctTranslation(document.segments[index]?.source ?? '', translation))
        ? acquirePdfDocument(document.binary.bytes) : undefined;
    // 源文件编码先失败或取消时，预加载的 PDF.js 也可能随后拒绝；实际栅格化仍会收到原错误。
    void lease?.promise.catch(() => undefined);
    try {
        return await createDocumentDownloadWithAdapters(document, translations, mode, {
            ...options,
            pdfPageRasterizer: options.pdfPageRasterizer ?? rasterizePdfTranslationPage,
            pdfReadingRasterizer: options.pdfReadingRasterizer ?? rasterizePdfReadingPages,
        });
    } finally {
        lease?.release();
    }
}

/**
 * 扫描版 PDF 的页面识别器：把一页渲染成图像，交给图片翻译已有的文字识别运行时，再把识别框从图像像素换算回页面坐标。
 * 识别引擎体积较大，只在真正需要识别时才载入。
 */
export function createPdfPageRecognizer(sourceLanguage: string): PdfPageRecognizer {
    return async ({bytes, pageNumber, width, signal}) => {
        const rendered = await renderPdfPageImage(bytes, pageNumber, width, signal);
        const {recognizeImageText} = await import('@/src/features/image-translation/ocr');
        const lines = await recognizeImageText(rendered.image, sourceLanguage, signal);
        const scale = width / rendered.width;
        return lines.map(line => ({text: line.text, x: line.bbox.x0 * scale, y: line.bbox.y0 * scale, width: (line.bbox.x1 - line.bbox.x0) * scale, height: (line.bbox.y1 - line.bbox.y0) * scale}));
    };
}
