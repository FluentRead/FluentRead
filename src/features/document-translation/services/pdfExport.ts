/**
 * @file src/features/document-translation/services/pdfExport.ts
 * 文件职责：负责已翻译 PDF 文档的导出拼装，支持原版左右对照、光栅译页、可搜索不可见 Unicode 文字层、溢出全文续页、阅读重排导出与目录书签写入。
 * 主要内容：按需加载 pdf-lib 嵌入原页与图像资源，构建独立 ToUnicode CID 字体以保全复制搜索，按页缓存源文本 run 加速跨续页投影，并在渲染与保存阶段持续响应进度和取消信号。
 * 模块边界：仅承担 PDF 二进制输出生成，不执行 PDF.js 解析或浏览器 Canvas 光栅化；光栅与字体加载端口由调用方注入。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {pdfFallbackBidiLine} from '../core/pdfFallbackBidi';
import type {PDFDict, PDFDocument, PDFEmbeddedPage} from 'pdf-lib';
import {buildPdfReadingPlan, type PdfReadingPlan} from '../core/pdfReadingPlan';
import {paginatePdfReadingPlan, type PdfReadingOutputPage} from '../core/pdfTextLayout';
import type {PdfReadingTextEntry} from '../core/pdfReadingRegions';
import type {
    DocumentRenderMode,
    ParsedDocument,
    PdfDocumentPage,
} from '@/src/features/document-translation/core/document';
import {
    awaitDocumentRead,
    type CreateDocumentDownloadOptions,
    type PdfOverflowNote,
    type PdfRasterTextItem,
} from './binaryShared';

export async function renderPdf(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    const binary = document.binary as Extract<NonNullable<ParsedDocument['binary']>, {kind: 'pdf'}>;
    const {
        PDFDocument, PDFDict, EncryptedPDFError, PDFHexString, PDFString, PDFName, degrees, rgb,
        pushGraphicsState, popGraphicsState, concatTransformationMatrix, setTextRenderingMode,
        TextRenderingMode, beginText, endText, setFontAndSize, showText,
    } = await import('pdf-lib');
    options.signal?.throwIfAborted();
    const outputPdf = await PDFDocument.create();
    outputPdf.setTitle(`${document.fileName} - FluentRead`);
    outputPdf.setProducer('FluentRead document translation');

    const totalPages = binary.pages.length;
    options.onPdfProgress?.({phase: 'rendering', completedPages: 0, totalPages});
    // 让浏览器绘制进度并处理取消，避免仅等待已解决的 Promise 连续占用主线程。
    const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    await yieldToBrowser();
    options.signal?.throwIfAborted();
    // 一次复制共享资源；逐页 embedPage 会反复复制同一套字体与图片。
    const sourcePages = new Map<number, PDFEmbeddedPage>();
    const drawSourcePage = (target: ReturnType<typeof outputPdf.addPage>, source: PDFEmbeddedPage, pageData: PdfDocumentPage, offsetX = 0) => {
        const rotation = pageData.rotation ?? pageData.sourceRotation ?? 0;
        if (!rotation) {target.drawPage(source, {x: offsetX, y: 0, width: pageData.width, height: pageData.height}); return;}
        const quarterTurn = rotation === 90 || rotation === 270;
        // embedPage 只包含内容流，/Rotate 不会被嵌入；在 PDF 底部向上的坐标系中顺时针旋转并移回正象限。
        target.drawPage(source, {
            x: offsetX + (rotation === 180 || rotation === 270 ? pageData.width : 0),
            y: rotation === 90 || rotation === 180 ? pageData.height : 0,
            width: quarterTurn ? pageData.height : pageData.width,
            height: quarterTurn ? pageData.width : pageData.height,
            rotate: degrees(-rotation),
        });
    };
    // 默认下载与原版对照阅读一致，一张原页对应一张译页；重排续页仅供显式阅读导出端口使用。
    const readingExport = Boolean((options.pdfReadingRenderer || options.pdfReadingRasterizer)
        && (options.pdfPresentation === 'readable' || !options.pdfPageRasterizer));
    // 标准 PDF 页标签把新增续页与原文页关联；查看器导航与外部验收都无需猜测插页后的物理页码。
    const layoutPageLabels: Array<number | PDFDict> = [];
    const labelLayoutPage = (label: string) => layoutPageLabels.push(outputPdf.getPageCount() - 1, outputPdf.context.obj({P: PDFHexString.fromText(label)}));
    const changedPages = binary.pages.map(page => page.segmentIndexes.some(segmentIndex =>
        hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translations[segmentIndex])));
    const needsSource = mode === 'bilingual' || changedPages.some(changed => !changed);
    let sourcePdf: PDFDocument | undefined;
    try {sourcePdf = await awaitDocumentRead(PDFDocument.load(binary.bytes), options.signal);}
    catch (error) {
        options.signal?.throwIfAborted();
        // 纯译文光栅原本无需 pdf-lib 读取原页；已由 PDF.js 打开的受保护文件不能因可选目录提取而失去下载能力。
        // 锁定的 pdf-lib 1.17.1 用 ES5 Error 继承，EncryptedPDFError 的 instanceof 不成立；只匹配该构造器的完整固定消息。
        if (needsSource || !(error instanceof Error) || error.message !== new EncryptedPDFError().message) throw error;
    }
    options.signal?.throwIfAborted();
    const {createPdfExportOutline} = await import('./pdfOutline');
    const outline = createPdfExportOutline(sourcePdf, outputPdf, document, translations);
    if (sourcePdf && needsSource) {
        const required = new Set(binary.pages.filter((_page, index) => mode === 'bilingual' || !changedPages[index]).map(page => page.pageNumber));
        const pages = sourcePdf.getPages().map((page, index) => ({page, pageNumber: index + 1}))
            .filter(({page, pageNumber}) => required.has(pageNumber) && page.node.Contents());
        // 无内容流的空白页不需要嵌入；pdf-lib 会拒绝嵌入这类页。
        const normalizedBox = (box: {x: number; y: number; width: number; height: number}) => ({
            left: Math.min(box.x, box.x + box.width), bottom: Math.min(box.y, box.y + box.height),
            right: Math.max(box.x, box.x + box.width), top: Math.max(box.y, box.y + box.height),
        });
        const boundingBoxes = pages.map(({page}) => {
            const media = normalizedBox(page.getMediaBox()), crop = normalizedBox(page.getCropBox());
            const intersection = {left: Math.max(media.left, crop.left), bottom: Math.max(media.bottom, crop.bottom), right: Math.min(media.right, crop.right), top: Math.min(media.top, crop.top)};
            // 与 PDF.js Page.view 一致：使用 CropBox∩MediaBox，空交集退回 MediaBox。
            // pdf-lib 的默认嵌入矩阵已经将左下角移到原点，无需再次偏移绘制坐标。
            return intersection.right > intersection.left && intersection.top > intersection.bottom ? intersection : media;
        });
        const embedded = await awaitDocumentRead(outputPdf.embedPages(pages.map(({page}) => page), boundingBoxes), options.signal);
        pages.forEach(({pageNumber}, index) => sourcePages.set(pageNumber, embedded[index]));
    }
    const embedImage = async (data: Uint8Array, format?: 'png' | 'jpeg') => {
        options.signal?.throwIfAborted();
        const jpeg = format === 'jpeg' || (data[0] === 0xff && data[1] === 0xd8);
        // pdf-lib 的 JPEG 读取器按整个 buffer 建 DataView；只在外部端口传入切片时复制。
        const bytes = jpeg && (data.byteOffset || data.byteLength !== data.buffer.byteLength) ? data.slice() : data;
        const image = await (jpeg ? outputPdf.embedJpg(bytes) : outputPdf.embedPng(bytes));
        options.signal?.throwIfAborted();
        // PNG 兼容端口也逐页释放解码像素；JPEG 直接引用浏览器编码数据，不再解码并压缩 RGB。
        await image.embed();
        options.signal?.throwIfAborted();
        return image;
    };
    const addOverflowNotes = (target: ReturnType<typeof outputPdf.addPage>, pageData: PdfDocumentPage, notes: PdfOverflowNote[], offsetX: number) => {
        const rotation = pageData.rotation ?? 0;
        const displayRect = (rect: {x: number; y: number; width: number; height: number}) =>
            rotation === 90 ? {x: pageData.width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width}
                : rotation === 180 ? {x: pageData.width - rect.x - rect.width, y: pageData.height - rect.y - rect.height, width: rect.width, height: rect.height}
                    : rotation === 270 ? {x: rect.y, y: pageData.height - rect.x - rect.width, width: rect.height, height: rect.width} : rect;
        const occupied = [...pageData.blocks, ...(pageData.preservedRegions ?? []), ...(pageData.layoutBoundaries ?? [])].map(displayRect);
        const markers: Array<{x: number; y: number; width: number; height: number}> = [];
        const intersects = (left: typeof markers[number], right: typeof markers[number]) =>
            left.x < right.x + right.width + 2 && left.x + left.width + 2 > right.x && left.y < right.y + right.height + 2 && left.y + left.height + 2 > right.y;
        for (const note of notes) {
            const rect = displayRect(note);
            const top = Math.max(4, Math.min(pageData.height - 18, rect.y));
            // 批注入口放在页边空白，保持与段落相近；多个短块同高时分散图标，不遮表格数字或正文。
            const candidates = [];
            for (let step = 0; step <= Math.ceil(pageData.height / 18); step += 1) {
                for (const direction of step ? [1, -1] : [1]) {
                    const y = top + step * 18 * direction;
                    if (y < 4 || y > pageData.height - 18) continue;
                    candidates.push({x: pageData.width - 18, y, width: 14, height: 14}, {x: 4, y, width: 14, height: 14});
                }
            }
            let marker = candidates.find(candidate => !occupied.some(other => intersects(candidate, other))
                && !markers.some(other => intersects(candidate, other)));
            const gutter = offsetX - pageData.width;
            if (!marker && gutter > 2) marker = candidates.map(candidate => ({x: -gutter + 1, y: candidate.y, width: Math.min(14, gutter - 2), height: 14}))
                .find(candidate => !markers.some(other => intersects(candidate, other)));
            // 满幅单页没有留白时保留批注列表和段落处的点击区域，使用透明外观而非压住原图的图标。
            const visible = Boolean(marker);
            marker ??= {x: Math.max(0, Math.min(pageData.width - 14, rect.x)), y: top, width: 14, height: 14};
            markers.push(marker);
            const x = offsetX + marker.x, y = pageData.height - marker.y - marker.height;
            // PDF.js 等阅读器在没有外观流时会把 /Text 的图标强制扩大到 22pt；明确 14pt 外观才真正守住留白边界。
            const appearance = outputPdf.context.register(outputPdf.context.stream(visible
                ? 'q 1 .78 .18 rg 1 1 12 12 re f .45 .3 .08 RG 1 w 1 1 12 12 re S 3 9 m 11 9 l S 3 6 m 11 6 l S 3 3 m 8 3 l S Q' : '',
            {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 14, 14], Resources: {}}));
            target.node.addAnnot(outputPdf.context.register(outputPdf.context.obj({
                Type: 'Annot', Subtype: 'Text', Rect: [x, y, x + marker.width, y + marker.height], Name: 'Comment', AP: {N: appearance},
                Contents: PDFHexString.fromText(note.text), T: PDFHexString.fromText('FluentRead'),
                C: [1, 0.78, 0.18], F: 0, Open: false,
            })));
        }
    };
    // 导出进行中页面可能释放已解析的片段；找不到片段时按“没有原文”处理，不能让下载中断。
    const visibleTranslations = translations.map((translation, segmentIndex) =>
        hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translation) ? translation : '');
    // 延迟到需要文字页时加载；没有变化的双语文档只复制原页，不准备字体。
    let readingFont: Awaited<ReturnType<typeof import('./pdfReadingFont')['embedPdfReadingFont']>> | undefined;
    let readingFontLoadFailed = false;
    let readingFontLoadError: unknown;
    const prepareReadingFont = async () => {
        if (readingFontLoadFailed) throw readingFontLoadError;
        if (!readingFont) {
            try {
                const {embedPdfReadingFont, loadPdfReadingFontBytes} = await import('./pdfReadingFont');
                const bytes = await awaitDocumentRead((options.pdfFontLoader ?? loadPdfReadingFontBytes)(options.signal), options.signal);
                options.signal?.throwIfAborted();
                readingFont = await awaitDocumentRead(embedPdfReadingFont(outputPdf, bytes, options.signal), options.signal);
                await yieldToBrowser();
                options.signal?.throwIfAborted();
            } catch (error) {
                // 一份离线导出只尝试一次字体；后续原页直接复用 Canvas 降级，不能逐页重复等待全部 CDN。
                readingFontLoadFailed = true;
                readingFontLoadError = error;
                throw error;
            }
        }
        return readingFont;
    };
    // 光栅层已经承载真实字形；不可见层使用独立 ToUnicode 映射保全任何 Unicode，普通原版导出不必联网下载字体。
    // 这个 CID 字体只能用于 Invisible 模式；可见全文续页仍使用经过字形校验的真实开放字体。
    type SelectableFont = {font: ReturnType<typeof outputPdf.context.register>; unicode: ReturnType<typeof outputPdf.context.register>; descendant: ReturnType<typeof outputPdf.context.register>;
        defaultWidth: number; characters: Map<string, number>; names: WeakMap<ReturnType<typeof outputPdf.addPage>, ReturnType<ReturnType<typeof outputPdf.addPage>['node']['newFontDictionary']>>};
    const selectableFonts = new Map<boolean, SelectableFont>();
    const fallbackText = (text: string, bidi = false) => {
        let resource = selectableFonts.get(bidi);
        if (!resource) {
            const fontName = bidi ? 'FluentReadBidiSourceText' : 'FluentReadSourceText', defaultWidth = bidi ? 500 : 1000;
            const unicode = outputPdf.context.register(outputPdf.context.flateStream(''));
            const descriptor = outputPdf.context.register(outputPdf.context.obj({Type: 'FontDescriptor', FontName: fontName,
                Flags: 4, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80}));
            const descendant = outputPdf.context.register(outputPdf.context.obj({Type: 'Font', Subtype: 'CIDFontType2', BaseFont: fontName,
                CIDSystemInfo: {Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0}, FontDescriptor: descriptor, CIDToGIDMap: 'Identity', DW: defaultWidth}));
            const font = outputPdf.context.register(outputPdf.context.obj({Type: 'Font', Subtype: 'Type0', BaseFont: fontName,
                Encoding: 'Identity-H', DescendantFonts: [descendant], ToUnicode: unicode}));
            resource = {font, unicode, descendant, defaultWidth, characters: new Map(), names: new WeakMap()}; selectableFonts.set(bidi, resource);
        }
        let hex = '';
        // PDF.js 会过滤独立 Cf 字形；将连接符等格式字符与相邻字符放入同一个 CID，保全组合表情及文字语义。
        for (const character of text.match(/\p{Cf}*[\s\S]\p{Cf}*/gu)!) {
            let code = resource.characters.get(character);
            if (code === undefined) {
                if (resource.characters.size >= 65_535) throw new Error('PDF 原文包含过多独立字形，无法保全搜索文字');
                code = resource.characters.size + 1; resource.characters.set(character, code);
            }
            hex += code.toString(16).padStart(4, '0');
        }
        return {encoded: PDFHexString.of(hex), resource};
    };
    const validRasterTextItem = (item: PdfRasterTextItem, width: number, height: number) => typeof item.text === 'string' && Boolean(item.text.trim())
        && [item.x, item.y, item.width, item.fontSize].every(Number.isFinite) && item.width > 0 && item.fontSize > 0
        && item.x >= 0 && item.y >= 0 && item.x < width && item.y < height;
    const drawSelectableLayout = async (target: ReturnType<typeof outputPdf.addPage>, pageData: PdfDocumentPage, painted: PdfRasterTextItem[], offsetX: number) => {
        const rotation = pageData.rotation ?? 0;
        const contentHeight = rotation === 90 || rotation === 270 ? pageData.width : pageData.height;
        const contentWidth = rotation === 90 || rotation === 270 ? pageData.height : pageData.width;
        const validPainted = painted.filter(item => validRasterTextItem(item, contentWidth, contentHeight));
        // 只排除光栅端口实际擦除并绘制过的源块；非法几何或无绘制行的块仍保留原字符。
        const paintedBySegment = new Map<number, PdfRasterTextItem[]>();
        for (const item of validPainted) {
            const lines = paintedBySegment.get(item.segmentIndex);
            if (lines) lines.push(item); else paintedBySegment.set(item.segmentIndex, [item]);
        }
        const ordered = pageData.blocks.map((block, index) => {
            const translated = block.segmentIndex >= 0 ? paintedBySegment.get(block.segmentIndex) : undefined;
            const source = document.segments[block.segmentIndex]?.source ?? block.source ?? '';
            const sourceItems: PdfRasterTextItem[] = (block.lines?.length ? block.lines : [{...block, text: source}])
                .map(line => ({segmentIndex: block.segmentIndex, text: line.text, x: line.x, y: line.y, width: line.width, fontSize: line.fontSize ?? block.fontSize}));
            return {order: block.readingOrder ?? index, items: translated ?? sourceItems};
        }).sort((left, right) => left.order - right.order).flatMap(value => value.items);
        const knownIndexes = new Set(pageData.blocks.map(block => block.segmentIndex));
        ordered.push(...validPainted.filter(item => !knownIndexes.has(item.segmentIndex)));
        let processed = 0;
        for (const item of ordered) {
            options.signal?.throwIfAborted();
            if (!validRasterTextItem(item, contentWidth, contentHeight)) continue;
            const text = item.text.replace(/[\r\n\t]/gu, ' ');
            // CID 字形为 1pt 计量；分别缩放行宽和行高，避免极端字号先乘字符数而溢出。
            const candidate = item.direction && paintedBySegment.get(item.segmentIndex)?.length === 1
                ? pdfFallbackBidiLine(item.text, visibleTranslations[item.segmentIndex] ?? '') : undefined;
            const baseScale = item.width / Array.from(text).length;
            const bidi = candidate?.direction === item.direction && candidate && Number.isFinite(baseScale / candidate.advance) ? candidate : undefined;
            // 新半 em 字宽与 X 轴逆缩放共同保留原有均匀槽起点及总 advance；不声称真实 Canvas 逐字形几何。
            const scale = baseScale / (bidi?.advance ?? 1);
            const baseline = contentHeight - item.y - item.fontSize * 0.9;
            // 先将该行的真实左上角映射到旋转后的页，再沿行方向精确匹配光栅绘制宽度。
            const matrix = rotation === 90 ? [0, -scale, item.fontSize, 0, offsetX + baseline, pageData.height - item.x]
                : rotation === 180 ? [-scale, 0, 0, -item.fontSize, offsetX + pageData.width - item.x, pageData.height - baseline]
                    : rotation === 270 ? [0, scale, -item.fontSize, 0, offsetX + pageData.width - baseline, item.x]
                        : [scale, 0, 0, item.fontSize, offsetX + item.x, baseline];
            target.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix as [number, number, number, number, number, number]),
                setTextRenderingMode(TextRenderingMode.Invisible));
            const {encoded, resource} = fallbackText(bidi?.visualText ?? text, Boolean(bidi));
            let name = resource.names.get(target);
            if (!name) {name = target.node.newFontDictionary(bidi ? 'FluentReadBidiSourceText' : 'FluentReadSourceText', resource.font); resource.names.set(target, name);}
            target.pushOperators(beginText(), setFontAndSize(name, 1), showText(encoded), endText());
            target.pushOperators(popGraphicsState());
            if (++processed % 32 === 0) {await yieldToBrowser(); options.signal?.throwIfAborted();}
        }
    };
    // 按原页缓存已排序的源文本 run，避免一页拆分多张重排续页时重复排序与展平 blocks。
    type SourceRun = {segmentIndex: number; text: string; x: number; y: number; width: number; height: number; fontSize: number};
    const sourceRunsByPage = new WeakMap<PdfDocumentPage, SourceRun[]>();
    const getPageSourceRuns = (pageData: PdfDocumentPage): SourceRun[] => {
        let runs = sourceRunsByPage.get(pageData);
        if (!runs) {
            runs = pageData.blocks.map((block, index) => ({block, order: block.readingOrder ?? index}))
                .sort((left, right) => left.order - right.order).flatMap(({block}) => (block.lines?.length
                ? block.lines.flatMap(line => (line.runs?.length ? line.runs : [line]).map(run => ({...run, fontSize: run.fontSize ?? line.fontSize ?? block.fontSize})))
                : [{...block, text: document.segments[block.segmentIndex]?.source ?? block.source ?? ''}])
                .map(run => ({...run, segmentIndex: block.segmentIndex})));
            sourceRunsByPage.set(pageData, runs);
        }
        return runs;
    };
    const readingRegionText = (pageData: PdfDocumentPage, items: PdfReadingOutputPage['items']): PdfRasterTextItem[] => {
        const sourceRuns = getPageSourceRuns(pageData);
        const projected: PdfRasterTextItem[] = [];
        for (const item of items) {
            if (item.kind !== 'region') continue;
            const rect = item.sourceRect;
            if (!(rect.width > 0) || !(rect.height > 0)) continue;
            const scaleX = item.width / rect.width, scaleY = item.height / rect.height;
            for (const run of sourceRuns) {
                if (!run.text || ![run.x, run.y, run.width, run.height, run.fontSize].every(Number.isFinite) || run.width <= 0 || run.height <= 0) continue;
                // 一个字形只归属于包含其中心的条带；跨页边界采用半开区间，既不重复也不丢掉压线文字。
                const centerY = run.y + run.height / 2;
                if (centerY < rect.y || centerY >= rect.y + rect.height) continue;
                const characters = Array.from(run.text), advance = run.width / characters.length;
                const selected = characters.map((text, index) => ({text, index})).filter(({index}) => {
                    const centerX = run.x + (index + 0.5) * advance;
                    return centerX >= rect.x && centerX < rect.x + rect.width;
                });
                if (!selected.length) continue;
                projected.push({segmentIndex: run.segmentIndex, text: selected.map(value => value.text).join(''),
                    x: item.x + (run.x + selected[0].index * advance - rect.x) * scaleX,
                    y: item.y + (run.y - rect.y) * scaleY,
                    width: selected.length * advance * scaleX, fontSize: run.fontSize * scaleY});
            }
        }
        return projected;
    };
    const addReadingReturnLink = (page: ReturnType<typeof outputPdf.addPage>, source: ReturnType<typeof outputPdf.addPage>, width: number) =>
        page.node.addAnnot(outputPdf.context.register(outputPdf.context.obj({Type: 'Annot', Subtype: 'Link',
            Rect: [42, 17, 42 + width, 31], Border: [0, 0, 0], Dest: [source.ref, PDFName.of('Fit')]})));
    const appendRasterReadingPages = async (pageData: PdfDocumentPage, plan: PdfReadingPlan,
        settings: {requireText?: boolean; footerLabel?: string; layoutPage?: ReturnType<typeof outputPdf.addPage>} = {}) => {
        let generatedPages = 0;
        for await (const rendered of options.pdfReadingRasterizer!({...pageData, sourceBytes: binary.bytes, translations: visibleTranslations,
            signal: options.signal, plan, imageFormat: 'png', footerLabel: settings.footerLabel})) {
            options.signal?.throwIfAborted();
            const text = [...(rendered.textItems ?? []), ...readingRegionText(pageData, rendered.items ?? [])];
            if (settings.requireText) {
                const reported = (rendered.textItems ?? []).filter(item => validRasterTextItem(item, rendered.width, rendered.height));
                const missingText = rendered.items?.some(item => item.kind === 'text' && item.text.trim()
                    && !reported.some(value => value.text === item.text));
                // 完整公式/插图可以独占一页且没有字符；只有真实阅读计划中的有效原图条带才能作为纯图页。
                const imageOnly = rendered.items?.some(item => item.kind === 'region' && item.width > 0 && item.height > 0
                    && item.sourceRect.width > 0 && item.sourceRect.height > 0 && plan.entries.some(entry => entry.kind === 'region'
                        && item.sourceRect.x >= entry.sourceRect.x - 0.000001 && item.sourceRect.y >= entry.sourceRect.y - 0.000001
                        && item.sourceRect.x + item.sourceRect.width <= entry.sourceRect.x + entry.sourceRect.width + 0.000001
                        && item.sourceRect.y + item.sourceRect.height <= entry.sourceRect.y + entry.sourceRect.height + 0.000001));
                if (missingText || (!reported.some(item => item.text.trim()) && !imageOnly)) throw new Error('PDF 续页光栅端口未提供可搜索文字，已停止不完整导出');
            }
            const image = await embedImage(rendered.bytes, rendered.format);
            const page = outputPdf.addPage([rendered.width, rendered.height]);
            if (!settings.layoutPage) outline.readingPage(pageData, page, rendered.items?.filter(item => item.kind === 'text') ?? rendered.textItems ?? []);
            if (settings.layoutPage) labelLayoutPage(`${pageData.pageNumber} · 译文续页 ${generatedPages + 1}`);
            page.drawImage(image, {x: 0, y: 0, width: rendered.width, height: rendered.height});
            if (text.length) await drawSelectableLayout(page, {...pageData, rotation: 0, width: rendered.width, height: rendered.height, blocks: []}, text, 0);
            if (settings.layoutPage) addReadingReturnLink(page, settings.layoutPage, rendered.width - 84);
            generatedPages += 1;
            await yieldToBrowser();
            options.signal?.throwIfAborted();
        }
        if (settings.requireText && !generatedPages) throw new Error('PDF 光栅端口没有生成完整译文续页，已停止不完整导出');
    };
    const appendOverflowPages = async (pageData: PdfDocumentPage, notes: PdfOverflowNote[], layoutPage: ReturnType<typeof outputPdf.addPage>) => {
        const entries: PdfReadingTextEntry[] = [];
        const seen = new Set<number>();
        for (const note of notes) {
            if (seen.has(note.segmentIndex)) continue;
            seen.add(note.segmentIndex);
            const ordinal = pageData.blocks.findIndex(block => block.segmentIndex === note.segmentIndex) + 1;
            const sourceRect = {x: note.x, y: note.y, width: note.width, height: note.height};
            for (const [suffix, text, role] of [['heading', `第 ${pageData.pageNumber} 页 · 段落 ${ordinal || note.segmentIndex + 1} · 完整译文`, 'heading'],
                ['body', note.text, 'paragraph']] as const) {
                entries.push({kind: 'text', id: `overflow-${pageData.pageNumber}-${note.segmentIndex}-${suffix}`, pageNumber: pageData.pageNumber,
                    segmentIndex: note.segmentIndex, role, source: '', text, translated: true, sourceRect});
            }
        }
        const plan: PdfReadingPlan = {pageNumber: pageData.pageNumber, entries, hasTranslation: true};
        let embedded: Awaited<ReturnType<typeof prepareReadingFont>>;
        try {
            embedded = await prepareReadingFont();
            for (const entry of entries) await embedded.prepareText(entry.text);
        } catch (error) {
            options.signal?.throwIfAborted();
            if (!options.pdfReadingRasterizer) throw error;
            // 操作系统 Canvas 保持缺字的可见外观；逐页图像仍加 CID 文字层，不让 emoji 或字体离线丢掉整份下载。
            await appendRasterReadingPages(pageData, plan, {requireText: true, layoutPage, footerLabel: `原文第 ${pageData.pageNumber} 页 · 译文续页`});
            return;
        }
        const pages = paginatePdfReadingPlan(plan, (text, font) => embedded.measureText(text.replace(/\t/gu, ' '), font.size),
            {compactLastPage: true});
        for (const [index, rendered] of pages.entries()) {
            options.signal?.throwIfAborted();
            const page = outputPdf.addPage([rendered.width, rendered.height]);
            labelLayoutPage(`${pageData.pageNumber} · 译文续页 ${index + 1}`);
            // 此私有计划只含文字；分页器不为其产生区域或空行绘制项。
            for (const item of rendered.items as Array<Extract<PdfReadingOutputPage['items'][number], {kind: 'text'}>>) embedded.drawText(page, item.text.replace(/\t/gu, ' '), {size: item.font.size,
                x: item.x, y: rendered.height - item.y - embedded.font.heightAtSize(item.font.size, {descender: false}), color: rgb(0.094, 0.129, 0.184)});
            const footer = `原文第 ${pageData.pageNumber} 页 · 译文续页 ${index + 1}/${pages.length}`;
            await embedded.prepareText(footer);
            embedded.drawText(page, footer, {size: 9, x: 42, y: 20, color: rgb(0.35, 0.4, 0.48)});
            // 每张续页都可返回对应原版页；点击区域在正文之外，打印不覆盖任何段落。
            addReadingReturnLink(page, layoutPage, embedded.measureText(footer, 9));
            await yieldToBrowser();
            options.signal?.throwIfAborted();
        }
    };
    for (const [index, pageData] of binary.pages.entries()) {
        options.signal?.throwIfAborted();
        const pageChanged = changedPages[index];
        const source = sourcePages.get(pageData.pageNumber);
        // 分散到每页嵌入，避免 save() 一次性解压并重压全部原页内容流，令进度和取消失去响应。
        if (source) await source.embed();
        options.signal?.throwIfAborted();
        const gap = Math.max(8, Math.min(24, pageData.width * 0.025));
        const offsetX = mode === 'bilingual' && !readingExport ? pageData.width + gap : 0;
        if (!pageChanged) {
            const page = outputPdf.addPage([offsetX ? pageData.width * 2 + gap : pageData.width, pageData.height]);
            outline.layoutPage(pageData, page, offsetX);
            if (!readingExport) labelLayoutPage(String(pageData.pageNumber));
            if (source) drawSourcePage(page, source, pageData);
            if (source && offsetX) drawSourcePage(page, source, pageData, offsetX);
            options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
            await yieldToBrowser();
            continue;
        }
        const rasterInput = {
            ...pageData,
            sourceBytes: binary.bytes,
            translations: visibleTranslations,
            signal: options.signal,
            imageFormat: 'jpeg' as const,
        };
        if (readingExport) {
            // 双语下载保留原页内容流，后接固定字号的完整译文续页。
            if (mode === 'bilingual') {
                const page = outputPdf.addPage([pageData.width, pageData.height]);
                if (source) drawSourcePage(page, source, pageData);
            }
            const plan = buildPdfReadingPlan(document, pageData, translations);
            if (options.pdfReadingRenderer) {
                let embedded: Awaited<ReturnType<typeof prepareReadingFont>>;
                try {
                    embedded = await prepareReadingFont();
                    for (const entry of plan.entries) if (entry.kind === 'text') await embedded.prepareText(entry.text);
                } catch (error) {
                    options.signal?.throwIfAborted();
                    if (!options.pdfReadingRasterizer) throw error;
                    await appendRasterReadingPages(pageData, plan, {requireText: true});
                    options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
                    await yieldToBrowser();
                    continue;
                }
                for await (const rendered of options.pdfReadingRenderer({...rasterInput, plan,
                    measureText: (text, font) => embedded.measureText(text.replace(/\t/gu, ' '), font.size),
                })) {
                    options.signal?.throwIfAborted();
                    const page = outputPdf.addPage([rendered.width, rendered.height]);
                    outline.readingPage(pageData, page, rendered.items.filter(item => item.kind === 'text'));
                    if (rendered.regionImage) {
                        const image = await embedImage(rendered.regionImage, 'png');
                        page.drawImage(image, {x: 0, y: 0, width: rendered.width, height: rendered.height});
                    }
                    for (const item of rendered.items) if (item.kind === 'text' && item.text) {
                        options.signal?.throwIfAborted();
                        embedded.drawText(page, item.text.replace(/\t/gu, ' '), {size: item.font.size,
                            x: item.x, y: rendered.height - item.y - embedded.font.heightAtSize(item.font.size, {descender: false}),
                            color: rgb(0.094, 0.129, 0.184),
                        });
                    }
                    const regionText = readingRegionText(pageData, rendered.items);
                    if (regionText.length) await drawSelectableLayout(page, {...pageData, rotation: 0, width: rendered.width, height: rendered.height, blocks: []}, regionText, 0);
                    await yieldToBrowser();
                    options.signal?.throwIfAborted();
                }
                options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
                await yieldToBrowser();
                continue;
            }
            await appendRasterReadingPages(pageData, plan);
            options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
            await yieldToBrowser();
            continue;
        }
        const rendered = await awaitDocumentRead(options.pdfPageRasterizer!(rasterInput), options.signal);
        const encoded = rendered instanceof Uint8Array ? {data: rendered} : rendered;
        const image = await embedImage(encoded.data, 'format' in encoded ? encoded.format : undefined);
        const page = outputPdf.addPage([offsetX ? pageData.width * 2 + gap : pageData.width, pageData.height]);
        outline.layoutPage(pageData, page, offsetX);
        labelLayoutPage(String(pageData.pageNumber));
        if (source && mode === 'bilingual') drawSourcePage(page, source, pageData);
        page.drawImage(image, {x: offsetX, y: 0, width: pageData.width, height: pageData.height});
        if ('overflowNotes' in encoded && encoded.overflowNotes?.length) addOverflowNotes(page, pageData, encoded.overflowNotes, offsetX);
        if ('textItems' in encoded && encoded.textItems) {
            await drawSelectableLayout(page, pageData, encoded.textItems, offsetX);
            if (encoded.overflowNotes?.length) await appendOverflowPages(pageData, encoded.overflowNotes, page);
        }
        options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
        await yieldToBrowser();
    }
    options.signal?.throwIfAborted();
    options.onPdfProgress?.({phase: 'saving', completedPages: totalPages, totalPages});
    await yieldToBrowser();
    options.signal?.throwIfAborted();
    outline.write();
    if (layoutPageLabels.length) outputPdf.catalog.set(PDFName.of('PageLabels'), outputPdf.context.obj({Nums: layoutPageLabels}));
    for (const [bidi, {unicode, descendant, defaultWidth, characters}] of selectableFonts) {
        // 合并 CID 仍使用原先每码点的 advance，避免修复复制文本时挪动搜索/选择的行几何。
        const widths = [...characters].flatMap(([character, code]) => {
            const length = Array.from(character).length;
            return length > 1 ? [code, [defaultWidth * length]] : [];
        });
        if (widths.length) outputPdf.context.lookup(descendant, PDFDict).set(PDFName.of('W'), outputPdf.context.obj(widths));
        const pairs = [...characters].map(([character, code]) => `<${code.toString(16).padStart(4, '0')}> <${PDFHexString.fromText(character).asString().slice(4)}>`);
        const groups: string[] = [];
        for (let index = 0; index < pairs.length; index += 100) {
            const chunk = pairs.slice(index, index + 100);
            groups.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
        }
        outputPdf.context.assign(unicode, outputPdf.context.flateStream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /${bidi ? 'FluentReadBidiSourceUnicode' : 'FluentReadSourceUnicode'} def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${groups.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`));
    }
    const bytes = await awaitDocumentRead(outputPdf.save({useObjectStreams: true, objectsPerTick: 20}), options.signal);
    options.signal?.throwIfAborted();
    return bytes;
}
