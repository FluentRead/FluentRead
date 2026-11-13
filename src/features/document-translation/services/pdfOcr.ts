/**
 * @file src/features/document-translation/services/pdfOcr.ts
 * 文件职责：让没有文字层的扫描版 PDF 也能进入同一套版面分析与翻译流程：把逐页文字识别的结果换算成版面分析所需的字形，重建各页的段落与待翻译片段。
 * 主要内容：按阅读位置逐页识别扫描页，校验有限且位于页内的文字框，再复用论文版面分析；同源扫描图形与经文字单元格确认的网格交回既有图表规则，保留插图、继续翻译题注与表格文字；区域复核只补遗漏单元格，跨格文字或读数冲突保留原结果并提示核对；每完成一页可提交不可变检查点，暂停或后续页失败时保留已完成页，空结果仍可重试；按未识别页的页码、块位置及原文迁移已有译文和人工确认；旋转页在展示坐标识别，原角度另记给导出。输入文档始终不被修改。
 * 模块边界：不渲染页面、不加载识别引擎、不发起翻译；应用层注入展示方向的识别结果，此处适配文字框、逐页检查点和扫描页脚注顺序，通用版面规则归 core/pdfLayoutAnalysis。
 */
import type {DocumentSegment, ParsedDocument, PdfDocumentPage} from '../core/document';
import {analyzePdfPageLayout, type PdfLayoutAtom} from '../core/pdfLayoutAnalysis';
import {pdfPageSegments} from './binary';
import {pdfScanLayoutGraphics, type PdfScanGraphic} from '../core/pdfScanGraphics';

/** 一行识别出的文字及其在页面上的位置（PDF 点，原点在页面左上角）。 */
export interface PdfOcrLine {text: string; x: number; y: number; width: number; height: number; baseline?: number; fontSize?: number; needsReview?: boolean}
export interface PdfPageRecognitionInput {bytes: Uint8Array; pageNumber: number; width: number; height: number; signal?: AbortSignal; useCache?: boolean}
export interface PdfRegionRecognition {graphicIndex: number; lines?: readonly PdfOcrLine[]}
export interface PdfPageRecognition {lines: readonly PdfOcrLine[]; graphics: readonly PdfScanGraphic[]; regions?: readonly PdfRegionRecognition[]}
/** 纯文字识别端口仍可返回行数组；扫描页适配器同时提交同一原图的图形边界。 */
export type PdfPageRecognizer = (input: PdfPageRecognitionInput) => Promise<readonly PdfOcrLine[] | PdfPageRecognition>;
export interface RecognizePdfOptions {
    signal?: AbortSignal;
    /** 用户显式重新识别的页下标；只处理这些页，空结果、取消或失败不覆盖已有内容。 */
    pageIndexes?: readonly number[];
    /** 希望先识别的页（从 0 开始），例如正在阅读的那一页；其余页按原顺序接在后面。 */
    startPage?: number;
    onProgress?: (progress: {completed: number; total: number}) => void;
    /** 已完成页的不可变快照；调用者负责检查任务身份后持久化，迟到结果不发布。 */
    onCheckpoint?: (document: ParsedDocument) => void;
}

/** 需要文字识别的页：解析时标记为扫描页（整页图像、没有文字）。文字 PDF 里夹着的扫描页和旋转的扫描页同样在内，空白页不在内。 */
export function pdfPagesNeedingOcr(document: ParsedDocument | null | undefined): number[] {
    if (document?.binary?.kind !== 'pdf') return [];
    return document.binary.pages.flatMap((page, index) => page.scanned ? [index] : []);
}

/** OCR 只重建扫描页；已有文字页的块顺序与几何保持不变，重复原文也按所在页和块区分。 */
export function remapPdfTranslationState(
    previous: ParsedDocument,
    recognized: ParsedDocument,
    translations: readonly string[],
    confirmedTranslationIds: readonly number[],
): {translations: string[]; confirmedTranslationIds: number[]} {
    const result = {translations: [] as string[], confirmedTranslationIds: [] as number[]};
    if (previous.binary?.kind !== 'pdf' || recognized.binary?.kind !== 'pdf') return result;
    result.translations = Array<string>(recognized.segments.length).fill('');
    const nextPages = new Map(recognized.binary.pages.map(page => [page.pageNumber, page]));
    const confirmed = new Set(confirmedTranslationIds);
    for (const page of previous.binary.pages) {
        const nextPage = nextPages.get(page.pageNumber);
        if (!nextPage || (page.scanned && !nextPage.scanned)) continue;
        page.blocks.forEach((block, index) => {
            const nextBlock = nextPage.blocks[index];
            if (block.segmentIndex < 0 || !nextBlock || nextBlock.segmentIndex < 0) return;
            const source = previous.segments[block.segmentIndex];
            const target = recognized.segments[nextBlock.segmentIndex];
            if (!source || !target || source.source !== target.source
                || !(['x', 'y', 'width', 'height'] as const).every(key => block[key] === nextBlock[key])) return;
            const translation = translations[block.segmentIndex] ?? '';
            result.translations[nextBlock.segmentIndex] = translation;
            if (translation.trim() && confirmed.has(block.segmentIndex)) result.confirmedTranslationIds.push(nextBlock.segmentIndex);
        });
    }
    return result;
}

/** 优先保留引擎行指标；缺失时才用框高估计字号与基线，文字框本身始终按原页裁剪。 */
function ocrAtoms(lines: readonly PdfOcrLine[], width: number, height: number): PdfLayoutAtom[] {
    return lines.flatMap(line => {
        const text = line.text.replace(/\s+/gu, ' ').trim();
        if (!text || ![line.x, line.y, line.width, line.height].every(Number.isFinite) || !(line.width > 0) || !(line.height > 0)) return [];
        const x = Math.max(0, line.x), y = Math.max(0, line.y);
        const right = Math.min(width, line.x + line.width), bottom = Math.min(height, line.y + line.height);
        if (right <= x || bottom <= y) return [];
        return [{text, x, y, width: right - x, height: bottom - y,
            baseline: Number.isFinite(line.baseline) && line.baseline! >= y && line.baseline! <= bottom ? line.baseline! : y + (bottom - y) * 0.8,
            fontSize: Number.isFinite(line.fontSize) && line.fontSize! > 0 ? line.fontSize! : (bottom - y) * 0.85, fontFamily: 'sans-serif'}];
    });
}

/** 扫描图没有原生分隔线：只把字号更小、与所有正文栏明显分离的页底注释放到正文之后。 */
function orderOcrFootnotes(layout: ReturnType<typeof analyzePdfPageLayout>, height: number): void {
    const body = layout.blocks.filter(block => block.kind === 'text' && block.lineCount > 1);
    if (new Set(body.map(block => block.column)).size < 2) return;
    const fonts = body.map(block => block.fontSize).sort((a, b) => a - b);
    const font = fonts[Math.floor(fonts.length / 2)];
    const bodyBottom = Math.max(...body.filter(block => block.fontSize >= font * .95).map(block => block.y + block.height));
    const notes = new Set(layout.blocks.filter(block => block.kind === 'text' && block.fontSize < font * .9
        && block.y > height * .7 && block.y > bodyBottom + font * 2));
    if (!notes.size) return;
    layout.blocks = [...layout.blocks.filter(block => !notes.has(block) && block.kind !== 'footer'),
        ...layout.blocks.filter(block => notes.has(block)), ...layout.blocks.filter(block => block.kind === 'footer')];
    layout.blocks.forEach((block, index) => {block.readingOrder = index;});
}

/** 只补足已由文字单元格确认的表格；两次读数相异或原行跨越多个单元格时保留原文并标记核对。 */
function mergeRegionLines(recognition: PdfPageRecognition, width: number, height: number): readonly PdfOcrLine[] {
    const lines = [...recognition.lines];
    const within = (line: PdfOcrLine, box: {x: number; y: number; width: number; height: number}) =>
        line.x + line.width / 2 > box.x && line.x + line.width / 2 < box.x + box.width
        && line.y + line.height / 2 > box.y && line.y + line.height / 2 < box.y + box.height;
    const normalized = (values: readonly PdfOcrLine[]) => [...values].sort((a,b)=>a.y-b.y||a.x-b.x).map(line=>line.text).join(' ').replace(/\s+/gu,' ').trim();
    for (const region of recognition.regions ?? []) {
        const graphic = recognition.graphics[region.graphicIndex];
        if (!graphic) continue;
        const candidates = region.lines?.filter(line => within(line, graphic)) ?? [];
        const shapes = pdfScanLayoutGraphics([graphic], ocrAtoms([...lines, ...candidates], width, height));
        if (shapes.some(shape => shape.kind !== 'path')) continue;
        if (!candidates.some(line => line.text.trim())) {lines.push({...graphic, text:'', needsReview:true}); continue;}
        lines.push(...candidates.filter(line=>line.needsReview).map(line=>({...line,text:''})));
        const horizontal = graphic.rules.filter(rule=>rule.width>0).map(rule=>rule.y).sort((a,b)=>a-b);
        const vertical = graphic.rules.filter(rule=>rule.height>0).map(rule=>rule.x).sort((a,b)=>a-b);
        // 只遍历实际有识别结果的单元格，不构造稠密网格的行列笛卡尔积。
        const cells=new Map<string,{cell:{x:number;y:number;width:number;height:number};next:PdfOcrLine[]}>();
        for(const line of candidates){
            if(!line.text.trim())continue;
            const x=line.x+line.width/2,y=line.y+line.height/2;
            const row=horizontal.findIndex((edge,index)=>index+1<horizontal.length&&y>edge&&y<horizontal[index+1]);
            const col=vertical.findIndex((edge,index)=>index+1<vertical.length&&x>edge&&x<vertical[index+1]);
            if(row<0||col<0)continue;
            const key=`${row}:${col}`, existing=cells.get(key);
            if(existing)existing.next.push(line);
            else cells.set(key,{cell:{x:vertical[col],y:horizontal[row],width:vertical[col+1]-vertical[col],height:horizontal[row+1]-horizontal[row]},next:[line]});
        }
        for (const {cell,next} of cells.values()) {
            const previous=lines.filter(line=>within(line,cell));
            const previousText=normalized(previous), nextText=normalized(next);
            const crossing=next.some(line=>line.x<cell.x-1||line.x+line.width>cell.x+cell.width+1)||lines.some(line=>line.text.trim()&&within(line,{x:graphic.x,y:cell.y,width:graphic.width,height:cell.height})
                && line.x<cell.x+cell.width&&line.x+line.width>cell.x&&(line.x<cell.x-1||line.x+line.width>cell.x+cell.width+1));
            if (crossing || previousText && previousText!==nextText) {lines.push({...cell,text:'',needsReview:true});continue;}
            if (!previousText) lines.push(...next);
        }
    }
    return lines;
}

/**
 * 逐页识别扫描页并返回带有新片段的文档；原文档对象保持不变。没有需要识别的页时原样返回。
 */
export async function recognizePdfDocument(document: ParsedDocument, recognize: PdfPageRecognizer, options: RecognizePdfOptions = {}): Promise<ParsedDocument> {
    const pageCount = document.binary?.kind === 'pdf' ? document.binary.pages.length : 0;
    const pending = options.pageIndexes === undefined ? pdfPagesNeedingOcr(document)
        : [...new Set(options.pageIndexes)].filter(index => Number.isInteger(index) && index >= 0 && index < pageCount).sort((a, b) => a - b);
    if (document.binary?.kind !== 'pdf' || !pending.length) return document;
    const binary = document.binary;
    const start = pending.findIndex(index => index >= (options.startPage ?? 0));
    const order = start > 0 ? [...pending.slice(start), ...pending.slice(0, start)] : pending;
    const recognized = new Map<number, ReturnType<typeof analyzePdfPageLayout> & {ocrReviewRegions: NonNullable<PdfDocumentPage['ocrReviewRegions']>}>();
    let result = document;
    options.onProgress?.({completed: 0, total: order.length});
    for (const [attempt, index] of order.entries()) {
        options.signal?.throwIfAborted();
        const page = binary.pages[index];
        const recognition = await recognize({bytes: binary.bytes, pageNumber: page.pageNumber, width: page.width, height: page.height, signal: options.signal, ...(options.pageIndexes === undefined ? {} : {useCache: false})});
        options.signal?.throwIfAborted();
        const lines = 'lines' in recognition ? mergeRegionLines(recognition, page.width, page.height) : recognition;
        const atoms = ocrAtoms(lines, page.width, page.height);
        const graphics = 'lines' in recognition ? pdfScanLayoutGraphics(recognition.graphics, atoms) : [];
        const layout = analyzePdfPageLayout({atoms, graphics, width: page.width, height: page.height});
        orderOcrFootnotes(layout, page.height);
        // 空结果不能把扫描页变成“完成”；保留原页和重试入口，也不删掉原生页眉页脚。
        if (layout.blocks.length) {
            const ocrReviewRegions = lines.filter(line => line.needsReview && [line.x, line.y, line.width, line.height].every(Number.isFinite)
                && line.x >= 0 && line.y >= 0 && line.width > 0 && line.height > 0 && line.x + line.width <= page.width && line.y + line.height <= page.height)
                .map(({x, y, width, height}) => ({x, y, width, height}));
            recognized.set(index, {...layout, ocrReviewRegions});
            if (options.onCheckpoint) {
                result = rebuildRecognizedPdf(document, binary, recognized);
                options.onCheckpoint(result);
            }
        }
        options.onProgress?.({completed: attempt + 1, total: order.length});
    }
    options.signal?.throwIfAborted();
    return recognized.size && !options.onCheckpoint ? rebuildRecognizedPdf(document, binary, recognized) : result;
}

function rebuildRecognizedPdf(document: ParsedDocument, binary: Extract<ParsedDocument['binary'], {kind: 'pdf'}>, recognized: ReadonlyMap<number, ReturnType<typeof analyzePdfPageLayout> & {ocrReviewRegions: NonNullable<PdfDocumentPage['ocrReviewRegions']>}>): ParsedDocument {
    // 已有文字的页保留原来的版面块，只把片段编号按全文顺序重排。
    const segments: DocumentSegment[] = [];
    const pages: PdfDocumentPage[] = binary.pages.map((page, index) => {
        const layout = recognized.get(index);
        // 只有得到有效文字块的页才完成识别。
        if (layout) {
            // 识别在展示方向上进行，版面块已是展示坐标：去掉 rotation，原页的旋转角留给导出。
            const {rotation, ...upright} = page;
            return {...upright, ...(rotation ? {sourceRotation: rotation} : {}), ...pdfPageSegments(layout.blocks, page.pageNumber, segments), preservedRegions: layout.preservedRegions,
                ocrReviewRegions: layout.ocrReviewRegions, ocrRecognized: true, scanned: false};
        }
        const segmentIndexes: number[] = [];
        const blocks = page.blocks.map(block => {
            if (block.segmentIndex < 0) return block;
            const id = segments.length;
            segments.push({...document.segments[block.segmentIndex], id});
            segmentIndexes.push(id);
            return {...block, segmentIndex: id};
        });
        return {...page, blocks, segmentIndexes};
    });
    return {...document, segments, binary: {...binary, pages}};
}
