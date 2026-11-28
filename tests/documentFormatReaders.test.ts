/**
 * @file tests/documentFormatReaders.test.ts
 * 文件职责：全面覆盖多格式阅读器辅助模块、ePub 资源与嵌套目录解析、升级后的富文档预览以及增量 DOM 补丁与滚动目录追踪。
 * 主要内容：覆盖 CSV/TSV 二维表格重建与按行分页、DOCX 行内格式/标题层级/列表/合并表头与表感知分页和目录、JSON 大纲/插值高亮分组/可折叠树、字幕时长与 CPS/LRC 元数据/ASS 样式角色/时间轴导航、ePub 样式净化/图片 blob URL/nav.xhtml 与 toc.ncx 嵌套目录、preview.ts 的 TXT/Markdown/HTML 外观与布局升级，以及 richPreviewSync.ts 的增量补丁和滚动高亮。
 * 模块边界：只做确定性离线单测，不依赖真实浏览器或网络；真实 JSZip 实例在内存中构造最小归档以验证 ePub 路径。
 */
import JSZip from 'jszip';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseDocument, type DocxDocumentPart, type DocumentSegment, type EpubDocumentChapter, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {
    buildDelimitedGrid,
    buildDocxOutline,
    buildDocxRichBlocks,
    buildJsonGroupedRows,
    buildJsonOutline,
    buildJsonTreeNodes,
    buildSubtitleTimelineOutline,
    delimitedColumnLetter,
    extractSubtitleMetadata,
    findDocxBlockPage,
    formatSubtitleDuration,
    paginateDelimitedRows,
    paginateDocxBlocks,
    parseDocxOrderedNumberingXml,
    parseDocxRelationshipsXml,
    parseSubtitleTimestampMs,
    tokenizeJsonInterpolation,
} from '@/src/features/document-translation/ui/formatReaders';
import {loadDocxPartMetadata} from '@/src/features/document-translation/ui/docxPreviewAssets';
import {
    buildEpubTocItems,
    loadEpubNestedToc,
    loadEpubZip,
    readEpubTocLevels,
    resolveEpubChapterAssets,
    sanitizeEpubCss,
} from '@/src/features/document-translation/ui/epubPreviewAssets';
import {
    findActiveRichHeadingId,
    findActiveRichOutlineIndex,
    patchRichPreviewSegments,
} from '@/src/features/document-translation/ui/richPreviewSync';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('formatReaders: CSV / TSV 2D spreadsheet grid', () => {
    it('reconstructs all columns including IDs, numbers, formulas, short rows and row-based pagination', () => {
        expect(delimitedColumnLetter(0)).toBe('A');
        expect(delimitedColumnLetter(25)).toBe('Z');
        expect(delimitedColumnLetter(26)).toBe('AA');
        expect(delimitedColumnLetter(-2)).toBe('A');

        const csv = [
            'ID,Name,Price,Formula,Notes',
            '101,Apple,"$1,250.50",=SUM(A1:A2),Fresh fruit',
            '-42,Banana,42%,=A2+1',
        ].join('\n');
        const doc = parseDocument('items.csv', csv);
        const translations = doc.segments.map((segment) => `ZH:${segment.source}`);
        const grid = buildDelimitedGrid(doc, translations, {selectedColumns: [1, 4]});

        expect(grid.delimiter).toBe(',');
        expect(grid.hasHeader).toBe(true);
        expect(grid.totalColumns).toBe(5);
        expect(grid.totalRows).toBe(2);
        expect(grid.headerRow?.isHeader).toBe(true);
        expect(grid.columns.map((c) => ({letter: c.letter, label: c.label, translatable: c.translatable, selected: c.selected}))).toEqual([
            {letter: 'A', label: 'ID', translatable: true, selected: false},
            {letter: 'B', label: 'Name', translatable: true, selected: true},
            {letter: 'C', label: 'Price', translatable: true, selected: false},
            {letter: 'D', label: 'Formula', translatable: true, selected: false},
            {letter: 'E', label: 'Notes', translatable: true, selected: true},
        ]);

        const firstRow = grid.rows[0];
        expect(firstRow.cells[0]).toMatchObject({raw: '101', isNumeric: true, translatable: false, translation: ''});
        expect(firstRow.cells[1]).toMatchObject({raw: 'Apple', translation: 'ZH:Apple', selected: true});
        expect(firstRow.cells[2]).toMatchObject({raw: '$1,250.50', isNumeric: true, translation: ''});
        expect(firstRow.cells[3]).toMatchObject({raw: '=SUM(A1:A2)', isFormula: true, translatable: false});
        expect(firstRow.cells[4]).toMatchObject({raw: 'Fresh fruit', translation: 'ZH:Fresh fruit'});
        // 负数只归类为数值，不同时标记为公式；短行自动补齐空单元格
        expect(grid.rows[1].cells[0]).toMatchObject({raw: '-42', isNumeric: true, isFormula: false});
        expect(grid.rows[1].cells[4]).toMatchObject({raw: '', translatable: false, translation: ''});

        const page1 = paginateDelimitedRows(grid, 1, 1);
        expect(page1).toMatchObject({page: 1, pageSize: 1, totalPages: 2, totalRows: 2, startRow: 0, endRow: 1});
        expect(page1.rows).toHaveLength(1);
        const pageClamped = paginateDelimitedRows(grid, 99, 1);
        expect(pageClamped.page).toBe(2);
        expect(pageClamped.rows[0].cells[1].raw).toBe('Banana');
        expect(paginateDelimitedRows(grid, Number.NaN, Number.POSITIVE_INFINITY)).toMatchObject({page: 1, pageSize: 50, totalRows: 2});
    });

    it('handles TSV without header, blank column labels, and sparse segments', () => {
        const tsv = '10\t20\n30\t40';
        const doc = parseDocument('nums.tsv', tsv);
        const grid = buildDelimitedGrid(doc, [], {hasHeader: false});
        expect(grid.delimiter).toBe('\t');
        expect(grid.hasHeader).toBe(false);
        expect(grid.headerRow).toBeNull();
        expect(grid.columns.map((c) => c.label)).toEqual(['Col A', 'Col B']);
        expect(grid.rows).toHaveLength(2);

        const singleRow = parseDocument('one.csv', ',Title');
        const autoNoHeader = buildDelimitedGrid(singleRow, []);
        expect(autoNoHeader.hasHeader).toBe(false);
        expect(autoNoHeader.columns[0].label).toBe('Col A');

        const manualHeaderBlank = buildDelimitedGrid(parseDocument('h.csv', ',Desc\n1,Hello,Extra'), [], {hasHeader: true});
        expect(manualHeaderBlank.columns[0].label).toBe('Col A');
        expect(manualHeaderBlank.columns[1].label).toBe('Desc');
        expect(manualHeaderBlank.columns[2].label).toBe('Col C');

        const customDoc: ParsedDocument = {
            ...singleRow,
            segments: [{id: 0, source: 'orphan'}],
        };
        expect(buildDelimitedGrid(customDoc, []).totalRows).toBe(1);

        const emptyGrid = buildDelimitedGrid(parseDocument('empty.csv', ''), []);
        expect(emptyGrid.headerRow).toBeNull();
        expect(paginateDelimitedRows(emptyGrid, 0, 0)).toMatchObject({page: 1, pageSize: 1, totalPages: 1, rows: []});

        // 显式 hasHeader: true 但文档为空时覆盖 headerRow 空回退
        const emptyWithHeader = buildDelimitedGrid(parseDocument('empty2.csv', ''), [], {hasHeader: true});
        expect(emptyWithHeader.headerRow).toBeNull();
        // 空行后的非连续行号（例如空白行）仍安全补齐
        const blankRowDoc = parseDocument('gap.csv', 'A,B\n\n1,Hello');
        expect(buildDelimitedGrid(blankRowDoc, []).allRows.length).toBeGreaterThanOrEqual(2);
    });
});

describe('formatReaders: DOCX rich blocks, table pagination & nested outline', () => {
    it('extracts heading levels, lists, rich inline runs, hyperlinks, colspans, headers and table-aware pagination', () => {
        const xml = [
            '<w:document><w:body>',
            '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Book Title</w:t></w:r></w:p>',
            '<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>Sub Title</w:t></w:r></w:p>',
            '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Section Three</w:t></w:r></w:p>',
            '<w:p><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:r><w:t>Outline H4</w:t></w:r></w:p>',
            '<w:p><w:pPr><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>Ignored Outline</w:t></w:r></w:p>',
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:rPr><w:b/><w:i w:val="false"/><w:u w:val="single"/><w:strike/><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>Styled</w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/><w:u w:val="none"/><w:rStyle w:val="InlineCode"/></w:rPr><w:t> item</w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="sec1"><w:r><w:t>jump</w:t></w:r></w:hyperlink><w:hyperlink r:id="rIdBad"><w:r><w:t>unsafe</w:t></w:r></w:hyperlink></w:p>',
            '<w:p><w:pPr><w:pStyle w:val="ListNumber"/><w:numPr/></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>',
            '<w:p><w:fldSimple w:instr="PAGE"/><w:r><w:t>Complex paragraph</w:t></w:r></w:p>',
            '<w:tbl>',
            '<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged Head</w:t></w:r></w:p></w:tc></w:tr>',
            '<w:tr><w:tc><w:tcPr><w:gridSpan/></w:tcPr><w:p><w:r><w:t>Cell A</w:t></w:r></w:p><w:p><w:r><w:t>Cell A2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr>',
            '<w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:tbl/></w:tc></w:tr>',
            '</w:tbl>',
            '<w:tbl>',
            '<w:tr><w:tc><w:p><w:r><w:t>Auto Head</w:t></w:r></w:p></w:tc></w:tr>',
            '<w:tr><w:tc><w:p><w:r><w:t>Auto Body</w:t></w:r></w:p></w:tc></w:tr>',
            '</w:tbl>',
            '<w:p><w:pPr><w:pStyle w:val=\'TOC1\'/></w:pPr><w:r><w:t>TOC Entry</w:t></w:r></w:p>',
            '<w:tbl/>',
            '<w:tbl><w:tr><w:trPr><w:tblHeader w:val="0"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val=\'999\'/></w:tcPr><w:p><w:r><w:t>Clamped Span</w:t></w:r></w:p></w:tc></w:tr></w:tbl >',
            '</w:body></w:document>',
        ].join('');

        const segments: DocumentSegment[] = [
            {id: 0, source: 'Book Title', role: 'title'},
            {id: 1, source: 'Sub Title', role: 'paragraph'},
            {id: 2, source: 'Section Three', role: 'heading'},
            {id: 3, source: 'Outline H4', role: 'paragraph'},
            {id: 4, source: 'Ignored Outline', role: 'paragraph'},
            {id: 5, source: 'Styled<g1> item</g1><g2>link</g2><g3>jump</g3><g4>unsafe</g4>', role: 'list-item', docxInline: true},
            {id: 6, source: 'Step one', role: 'list-item'},
            {id: 7, source: 'Complex paragraph', role: 'paragraph'},
            {id: 8, source: 'Merged Head', role: 'paragraph'},
            {id: 9, source: 'Cell A', role: 'paragraph'},
            {id: 10, source: 'Cell A2', role: 'paragraph'},
            {id: 11, source: 'Cell B', role: 'paragraph'},
            {id: 12, source: 'Auto Head', role: 'paragraph'},
            {id: 13, source: 'Auto Body', role: 'paragraph'},
            {id: 14, source: 'No XML heading', role: 'heading'},
            {id: 15, source: 'No XML title', role: 'title'},
            {id: 16, source: '   '},
        ];
        const part: DocxDocumentPart = {
            path: 'word/document.xml',
            source: xml,
            paragraphSegments: [
                {paragraphIndex: 0, segmentIndex: 0},
                {paragraphIndex: 1, segmentIndex: 1},
                {paragraphIndex: 2, segmentIndex: 2},
                {paragraphIndex: 3, segmentIndex: 3},
                {paragraphIndex: 4, segmentIndex: 4},
                {paragraphIndex: 5, segmentIndex: 5},
                {paragraphIndex: 6, segmentIndex: 6},
                {paragraphIndex: 7, segmentIndex: 7},
                {paragraphIndex: 8, segmentIndex: 8, table: {table: 0, row: 0, cell: 0}},
                {paragraphIndex: 9, segmentIndex: 9, table: {table: 0, row: 1, cell: 0}},
                {paragraphIndex: 10, segmentIndex: 10, table: {table: 0, row: 1, cell: 0}},
                {paragraphIndex: 11, segmentIndex: 11, table: {table: 0, row: 1, cell: 2}},
                {paragraphIndex: 13, segmentIndex: 12, table: {table: 1, row: 0, cell: 0}},
                {paragraphIndex: 14, segmentIndex: 13, table: {table: 1, row: 1, cell: 0}},
                {paragraphIndex: 99, segmentIndex: 14},
                {paragraphIndex: 100, segmentIndex: 15},
                {paragraphIndex: 101, segmentIndex: 16},
                {paragraphIndex: 102, segmentIndex: 999},
            ],
        };
        const translations: string[] = [];
        translations[0] = '书名';
        translations[2] = '第三节';
        translations[5] = '样式<g1>条目</g1><g2>链接</g2><g3>跳转</g3><g4>忽略</g4>';
        translations[6] = '第一步';
        translations[7] = '复杂段落';
        translations[8] = '合并表头';

        const rels = new Map([['rId1', 'https://example.com/doc'], ['rIdBad', 'javascript:alert(1)']]);
        const blocks = buildDocxRichBlocks(part, segments, translations, {rels, orderedNumIds: new Set(['5'])});

        expect(blocks[0]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 1, sourceText: 'Book Title', translationText: '书名'}});
        expect(blocks[1]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 2}});
        expect(blocks[2]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 3}});
        expect(blocks[3]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 4}});
        expect(blocks[4].kind === 'paragraph' && blocks[4].paragraph.headingLevel).toBeUndefined();

        const styledBlock = blocks[5];
        expect(styledBlock.kind).toBe('paragraph');
        if (styledBlock.kind === 'paragraph') {
            expect(styledBlock.paragraph.listLevel).toBe(1);
            expect(styledBlock.paragraph.listOrdered).toBe(true);
            expect(styledBlock.paragraph.sourceRuns).toEqual([
                {text: 'Styled', bold: true, underline: true, strike: true, code: true},
                {text: ' item', italic: true, code: true},
                {text: 'link', bold: true, underline: true, strike: true, code: true, href: 'https://example.com/doc'},
                {text: 'jump', bold: true, underline: true, strike: true, code: true, href: '#sec1'},
                {text: 'unsafe', bold: true, underline: true, strike: true, code: true},
            ]);
            expect(styledBlock.paragraph.translationRuns[2]).toMatchObject({text: '链接', href: 'https://example.com/doc'});
        }

        const listStep = blocks[6];
        expect(listStep.kind === 'paragraph' && listStep.paragraph.listLevel).toBe(0);
        expect(listStep.kind === 'paragraph' && listStep.paragraph.listOrdered).toBe(true);
        // 复杂段落（含 fldSimple）退回纯文本 run
        expect(blocks[7]).toMatchObject({kind: 'paragraph', paragraph: {sourceRuns: [{text: 'Complex paragraph'}], translationRuns: [{text: '复杂段落'}]}});

        // 表格块：显式 tblHeader + gridSpan + 空单元格补齐
        const table0 = blocks[8];
        expect(table0.kind).toBe('table');
        if (table0.kind === 'table') {
            expect(table0.segmentCount).toBe(4);
            expect(table0.rows[0].isHeader).toBe(true);
            expect(table0.rows[0].cells[0].colspan).toBe(2);
            expect(table0.rows[1].isHeader).toBe(false);
            expect(table0.rows[1].cells[1].paragraphs).toEqual([]);
            expect(table0.rows[1].cells[2].paragraphs[0].sourceText).toBe('Cell B');
        }

        // 第二张表无显式 tblHeader 时自动把首行标记为表头
        const table1 = blocks[9];
        expect(table1.kind === 'table' && table1.rows[0].isHeader).toBe(true);
        expect(table1.kind === 'table' && table1.rows[1].isHeader).toBe(false);

        // 无 XML 段落按 role 回退 headingLevel，空白段落产出空 runs
        expect(blocks[10]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 2}});
        expect(blocks[11]).toMatchObject({kind: 'paragraph', paragraph: {headingLevel: 1}});
        expect(blocks[12]).toMatchObject({kind: 'paragraph', paragraph: {sourceRuns: []}});

        // 翻译中丢失标记时安全退回纯文本 run
        const brokenTranslations = [...translations];
        brokenTranslations[5] = '丢失占位符的译文';
        const brokenBlocks = buildDocxRichBlocks(part, segments, brokenTranslations, {rels});
        expect(brokenBlocks[5]).toMatchObject({
            kind: 'paragraph',
            paragraph: {translationRuns: [{text: '丢失占位符的译文', bold: true, underline: true, strike: true, code: true}]},
        });

        // 相同样式相邻 runs 自动合并，且缺少属性样式的 span 回退到段属性
        const mergeXml = '<w:p><w:r><w:t>A</w:t></w:r><w:hyperlink w:anchor="a"><w:r><w:t>B</w:t></w:r></w:hyperlink><w:r><w:t>C</w:t></w:r></w:p>';
        const mergePart: DocxDocumentPart = {path: 'word/document.xml', source: mergeXml, paragraphSegments: [{paragraphIndex: 0, segmentIndex: 0}]};
        const mergeSegs: DocumentSegment[] = [{id: 0, source: 'A<g1>B</g1>C', docxInline: true}];
        const mergeBlocks = buildDocxRichBlocks(mergePart, mergeSegs, ['甲<g1>乙</g1>丙']);
        expect(mergeBlocks[0]).toMatchObject({
            kind: 'paragraph',
            paragraph: {
                sourceRuns: [{text: 'A'}, {text: 'B', href: '#a'}, {text: 'C'}],
                translationRuns: [{text: '甲'}, {text: '乙', href: '#a'}, {text: '丙'}],
            },
        });
        // 相邻空 href 的 link + 普通段触发 sameDocxRunStyle 合并分支
        const mergeSameXml = '<w:p><w:r><w:t>A</w:t></w:r><w:hyperlink><w:r><w:t>B</w:t></w:r></w:hyperlink></w:p>';
        const mergeSamePart: DocxDocumentPart = {path: 'word/document.xml', source: mergeSameXml, paragraphSegments: [{paragraphIndex: 0, segmentIndex: 0}]};
        const mergeSameBlocks = buildDocxRichBlocks(mergeSamePart, [{id: 0, source: 'A<g1>B</g1>', docxInline: true}], []);
        expect(mergeSameBlocks[0]).toMatchObject({kind: 'paragraph', paragraph: {sourceRuns: [{text: 'AB'}]}});

        // 表格感知分页：表格完整留在同一页，绝不拆表；非有限页码安全兜底
        expect(paginateDocxBlocks(blocks, Number.NaN, Number.NaN)).toMatchObject({page: 1, pageSize: 50});
        // TOC1 不应被误判为标题；自闭合 <w:tbl/>、tblHeader w:val="0"、超大 gridSpan 限幅 100 及同表拆分块不互相覆盖
        const edgeXml = '<w:body><w:p><w:pPr><w:pStyle w:val=\'TOC1\'/></w:pPr><w:r><w:t>TOC Entry</w:t></w:r></w:p><w:tbl/><w:tbl><w:tr><w:trPr><w:tblHeader w:val="0"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val=\'999\'/></w:tcPr><w:p><w:r><w:t>Row A</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Row B</w:t></w:r></w:p></w:tc></w:tr></w:tbl ><w:p><w:r><w:t>Middle</w:t></w:r></w:p></w:body>';
        const edgePart: DocxDocumentPart = {
            path: 'word/document.xml',
            source: edgeXml,
            paragraphSegments: [
                {paragraphIndex: 0, segmentIndex: 0},
                {paragraphIndex: 1, segmentIndex: 1, table: {table: 1, row: 0, cell: 0}},
                {paragraphIndex: 3, segmentIndex: 2},
                {paragraphIndex: 2, segmentIndex: 3, table: {table: 1, row: 1, cell: 0}},
            ],
        };
        const edgeSegs: DocumentSegment[] = [
            {id: 0, source: 'TOC Entry', role: 'paragraph'},
            {id: 1, source: 'Row A', role: 'paragraph'},
            {id: 2, source: 'Middle', role: 'paragraph'},
            {id: 3, source: 'Row B', role: 'paragraph'},
        ];
        const edgeBlocks = buildDocxRichBlocks(edgePart, edgeSegs, []);
        expect(edgeBlocks[0].kind === 'paragraph' && edgeBlocks[0].paragraph.headingLevel).toBeUndefined();
        expect(edgeBlocks[1].kind === 'table' && edgeBlocks[1].rows[0].cells[0].colspan).toBe(100);
        expect(edgeBlocks[1].kind === 'table' && edgeBlocks[1].rows[0].isHeader).toBe(false);
        expect(edgeBlocks[3].kind === 'table' && edgeBlocks[3].rows[0].cells[0].paragraphs[0].sourceText).toBe('Row B');

        const paged = paginateDocxBlocks(blocks, 2, 3);
        expect(paged.totalPages).toBeGreaterThan(2);
        const tablePage = findDocxBlockPage(blocks, 9, 3);
        const tablePageResult = paginateDocxBlocks(blocks, tablePage, 3);
        expect(tablePageResult.blocks.some((b) => b.kind === 'table' && b.tableIndex === 0)).toBe(true);
        expect(findDocxBlockPage(blocks, 0, 3)).toBe(1);
        expect(findDocxBlockPage(blocks, 9999, 3)).toBe(1);
        expect(paginateDocxBlocks([], 1, 10)).toMatchObject({page: 1, totalPages: 1, blocks: []});

        // 多级嵌套 DOCX 目录
        const outline = buildDocxOutline([part], segments, translations);
        expect(outline).toEqual([
            {partIndex: 0, segmentIndex: 0, level: 1, source: 'Book Title', translation: '书名'},
            {partIndex: 0, segmentIndex: 1, level: 2, source: 'Sub Title', translation: ''},
            {partIndex: 0, segmentIndex: 2, level: 3, source: 'Section Three', translation: '第三节'},
            {partIndex: 0, segmentIndex: 3, level: 4, source: 'Outline H4', translation: ''},
            {partIndex: 0, segmentIndex: 14, level: 2, source: 'No XML heading', translation: ''},
            {partIndex: 0, segmentIndex: 15, level: 1, source: 'No XML title', translation: ''},
        ]);
    });
});

describe('formatReaders: JSON outline, grouped interpolation rows & collapsible tree', () => {
    it('builds namespace outline, grouped rows with interpolation tokens, and collapsible syntax tree', () => {
        const payload = {
            settings: {
                notifications: {
                    title: 'Hello {{name}}, %d items\nleft',
                    subtitle: 'Saved {count} files',
                },
                color: '#ff00aa',
                count: 42,
                enabled: true,
                empty: null,
            },
            items: ['First item', 'https://example.com'],
        };
        const doc = parseDocument('locale.json', JSON.stringify(payload));
        const translations = ['你好 {{name}}，还剩 %d 项\n结束', '', ''];
        const outlinePartial = buildJsonOutline(doc, translations, 2);
        expect(outlinePartial[0]).toMatchObject({key: 'settings', total: 2, completed: 1});
        translations[1] = '已保存 {count} 个文件';

        expect(tokenizeJsonInterpolation('')).toEqual([]);
        expect(tokenizeJsonInterpolation('{{only}}')).toEqual([{kind: 'placeholder', text: '{{only}}'}]);
        expect(tokenizeJsonInterpolation('Plain text')).toEqual([{kind: 'text', text: 'Plain text'}]);
        expect(tokenizeJsonInterpolation('Hi {{user}} {id} %1$s\n\\t!')).toEqual([
            {kind: 'text', text: 'Hi '},
            {kind: 'placeholder', text: '{{user}}'},
            {kind: 'text', text: ' '},
            {kind: 'placeholder', text: '{id}'},
            {kind: 'text', text: ' '},
            {kind: 'placeholder', text: '%1$s'},
            {kind: 'placeholder', text: '\\n'},
            {kind: 'placeholder', text: '\\t'},
            {kind: 'text', text: '!'},
        ]);

        const outline = buildJsonOutline(doc, translations, 2);
        expect(outline).toEqual([
            {key: 'settings', path: '$.settings', startSegmentIndex: 0, endSegmentIndex: 1, page: 1, total: 2, completed: 2},
            {key: 'items', path: '$.items', startSegmentIndex: 2, endSegmentIndex: 2, page: 2, total: 1, completed: 0},
        ]);

        const grouped = buildJsonGroupedRows(doc, translations, 1, 10);
        expect(grouped.totalPages).toBe(1);
        expect(grouped.groups).toHaveLength(2);
        expect(grouped.groups[0].parentPath).toBe('$.settings.notifications');
        expect(grouped.groups[0].rows.map((r) => r.leafKey)).toEqual(['title', 'subtitle']);
        expect(grouped.groups[0].rows[0].translationTokens.some((t) => t.kind === 'placeholder' && t.text === '{{name}}')).toBe(true);
        expect(grouped.groups[1].parentPath).toBe('$.items');
        expect(grouped.groups[1].rows[0].leafKey).toBe('[0]');

        // 顶层数组与标量根路径
        const arrayDoc = parseDocument('arr.json', JSON.stringify(['Alpha', 'Beta']));
        expect(buildJsonOutline(arrayDoc, ['甲'])).toEqual([
            {key: '[0]', path: '$[0]', startSegmentIndex: 0, endSegmentIndex: 0, page: 1, total: 1, completed: 1},
            {key: '[1]', path: '$[1]', startSegmentIndex: 1, endSegmentIndex: 1, page: 1, total: 1, completed: 0},
        ]);
        const scalarDoc = parseDocument('root.json', JSON.stringify('Root label'));
        expect(buildJsonOutline(scalarDoc, [])[0]).toMatchObject({key: '$', path: '$'});
        expect(buildJsonGroupedRows({...scalarDoc, segments: [{id: 0, source: 'Root label'}]}, [], 1, 10).groups[0].rows[0]).toMatchObject({
            parentPath: '$',
            leafKey: '$',
        });
        expect(buildJsonGroupedRows({...scalarDoc, segments: [{id: 0, source: 'A', pathLabel: '[0]'}]}, [], 1, 10).groups[0].rows[0]).toMatchObject({
            parentPath: '$',
            leafKey: '[0]',
        });
        expect(buildJsonGroupedRows({...scalarDoc, segments: [{id: 0, source: 'A', pathLabel: 'plain'}]}, [], 1, 10).groups[0].rows[0]).toMatchObject({
            parentPath: '$',
            leafKey: 'plain',
        });
        expect(buildJsonGroupedRows({...scalarDoc, segments: [{id: 0, source: 'A', pathLabel: '.leading'}]}, [], 1, 10).groups[0].rows[0]).toMatchObject({
            parentPath: '$',
            leafKey: 'leading',
        });
        // 带点号/方括号/转义引号的 JSON 键名通过 jsonEntries 和引号感知 splitJsonPathLabel 准确拆分
        const trickyJson = parseDocument('tricky.json', JSON.stringify({section: {'a[0].b': 'Nested value'}}));
        expect(buildJsonGroupedRows(trickyJson, [], 1, 10).groups[0].rows[0]).toMatchObject({
            parentPath: '$.section',
            leafKey: 'a[0].b',
        });
        const legacyTricky = {
            ...trickyJson,
            jsonEntries: undefined,
            segments: [
                {id: 0, source: 'Nested value', pathLabel: '$.section["a[0].b"]'},
                {id: 1, source: 'Escaped', pathLabel: '$.section["x\\"y.z"]'},
            ],
        };
        const legacyGrouped = buildJsonGroupedRows(legacyTricky, [], Number.NaN, Number.POSITIVE_INFINITY);
        expect(legacyGrouped.page).toBe(1);
        expect(legacyGrouped.groups[0].rows.map((r) => ({parentPath: r.parentPath, leafKey: r.leafKey}))).toEqual([
            {parentPath: '$.section', leafKey: '["a[0].b"]'},
            {parentPath: '$.section', leafKey: '["x\\"y.z"]'},
        ]);
        expect(buildJsonOutline({...scalarDoc, jsonEntries: undefined}, [])[0].key).toBe('$');

        // 树视图：折叠与展开
        const collapsed = buildJsonTreeNodes(doc, translations, new Set());
        expect(collapsed).toHaveLength(1);
        expect(collapsed[0]).toMatchObject({path: '$', kind: 'object', childCount: 2, expanded: false});

        const expanded = buildJsonTreeNodes(doc, translations, new Set(['$', '$.settings', '$.settings.notifications', '$.items']));
        expect(expanded.find((n) => n.path === '$.settings.color')).toMatchObject({kind: 'string', translatable: false, muted: true});
        expect(expanded.find((n) => n.path === '$.settings.count')).toMatchObject({kind: 'number', valueText: '42', muted: false});
        expect(expanded.find((n) => n.path === '$.settings.enabled')).toMatchObject({kind: 'boolean', valueText: 'true'});
        expect(expanded.find((n) => n.path === '$.settings.empty')).toMatchObject({kind: 'null', valueText: 'null'});
        expect(expanded.find((n) => n.path === '$.settings.notifications.title')).toMatchObject({
            translatable: true,
            segmentId: 0,
            translation: translations[0],
        });
        expect(expanded.find((n) => n.path === '$.items')).toMatchObject({kind: 'array', valueText: '[2]'});
        expect(expanded.find((n) => n.path === '$.items[1]')).toMatchObject({muted: true});
        expect(buildJsonTreeNodes({...doc, jsonValue: undefined}, [], new Set())).toEqual([]);
        expect(buildJsonTreeNodes({...doc, jsonEntries: undefined}, [], new Set(['$'])).length).toBeGreaterThan(1);
        // maxNodes 限制返回节点数且支持非有限值兜底
        expect(buildJsonTreeNodes(doc, translations, new Set(['$', '$.settings', '$.settings.notifications', '$.items']), {maxNodes: 3})).toHaveLength(3);
        expect(buildJsonTreeNodes(doc, translations, new Set(['$', '$.settings']), {maxNodes: Number.NaN}).length).toBeGreaterThan(3);
    });
});

describe('formatReaders & docxPreviewAssets: DOCX rels, ordered numbering & lazy loader', () => {
    it('parses DOCX relationships XML and ordered numbering XML safely', () => {
        const relsXml = [
            '<Relationships>',
            '<Relationship Target="https://example.com/a?x=1&amp;y=2" Id="rId1" TargetMode="External"/>',
            '<Relationship Id=\'rId2\' Target=\'mailto:team@example.com\'/>',
            '<Relationship Id="rId3" Target="#sec-1" TargetMode="External"/>',
            '<Relationship Id="rIdLocalHash" Target="#internal"/>',
            '<Relationship Id="rId4" Target="styles.xml"/>',
            '<Relationship Id="rId5" Target="javascript:alert(1)" TargetMode="External"/>',
            '<Relationship Id="__proto__" Target="https://evil.example" TargetMode="External"/>',
            '<Relationship Target="https://missing-id.example" TargetMode="External"/>',
            '</Relationships>',
        ].join('');
        const rels = parseDocxRelationshipsXml(relsXml);
        expect(rels).toEqual({
            rId1: 'https://example.com/a?x=1&y=2',
            rId2: 'mailto:team@example.com',
            rId3: '#sec-1',
        });

        const numberingXml = [
            '<w:numbering>',
            '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>',
            '<w:abstractNum w:abstractNumId=\'1\'><w:lvl w:ilvl=\'0\'><w:numFmt w:val=\'bullet\'/></w:lvl></w:abstractNum>',
            '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="1"><w:numFmt w:val="upperRoman"/></w:lvl></w:abstractNum>',
            '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="none"/></w:lvl></w:abstractNum>',
            '<w:abstractNum><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>',
            '<w:num w:numId="10"><w:abstractNumId w:val="0"/></w:num>',
            '<w:num w:numId="11"><w:abstractNumId w:val="1"/></w:num>',
            '<w:num w:numId=\'12\'><w:abstractNumId w:val=\'2\'/></w:num>',
            '<w:num w:numId="13"><w:abstractNumId w:val="3"/></w:num>',
            '<w:num><w:abstractNumId w:val="0"/></w:num>',
            '</w:numbering>',
        ].join('');
        expect([...parseDocxOrderedNumberingXml(numberingXml)]).toEqual(['10', '12']);

        // buildDocxRichBlocks 直接接受纯对象 rels（loadDocxPartMetadata 返回值）
        const pXml = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr></w:pPr><w:hyperlink r:id="rId1"><w:r><w:t>Site</w:t></w:r></w:hyperlink></w:p>';
        const part: DocxDocumentPart = {path: 'word/document.xml', source: pXml, paragraphSegments: [{paragraphIndex: 0, segmentIndex: 0}]};
        const blocks = buildDocxRichBlocks(part, [{id: 0, source: '<g1>Site</g1>', docxInline: true}], [], {
            rels,
            orderedNumIds: parseDocxOrderedNumberingXml(numberingXml),
        });
        expect(blocks[0]).toMatchObject({
            kind: 'paragraph',
            paragraph: {
                listOrdered: true,
                sourceRuns: [{text: 'Site', href: 'https://example.com/a?x=1&y=2'}],
            },
        });
    });

    it('lazily loads and caches DOCX part rels and numbering metadata with graceful fallback', async () => {
        const zip = new JSZip();
        zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId1" Target="https://example.com" TargetMode="External"/></Relationships>');
        zip.file('WORD/_RELS/HEADER1.XML.RELS', '<Relationships><Relationship Id="rIdH" Target="mailto:h@example.com" TargetMode="External"/></Relationships>');
        zip.file('_rels/root.xml.rels', '<Relationships><Relationship Id="rIdR" Target="https://root.example" TargetMode="External"/></Relationships>');
        zip.file('word/numbering.xml', '<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
        const bytes = await zip.generateAsync({type: 'uint8array'});

        const p1 = loadDocxPartMetadata(bytes, 'word/document.xml');
        const p2 = loadDocxPartMetadata(bytes, 'word/document.xml');
        expect(p1).toBe(p2);
        const docMeta = await p1;
        expect(docMeta.rels).toEqual({rId1: 'https://example.com'});
        expect([...docMeta.orderedNumIds]).toEqual(['7']);

        const headerMeta = await loadDocxPartMetadata(bytes, 'word\\header1.xml');
        expect(headerMeta.rels).toEqual({rIdH: 'mailto:h@example.com'});

        const rootMeta = await loadDocxPartMetadata(bytes, 'root.xml');
        expect(rootMeta.rels).toEqual({rIdR: 'https://root.example'});

        // 缺少 rels 和 numbering 时优雅回退为空
        const bareZip = new JSZip();
        bareZip.file('word/document.xml', '<w:document/>');
        const bareBytes = await bareZip.generateAsync({type: 'uint8array'});
        const bareMeta = await loadDocxPartMetadata(bareBytes, 'word/document.xml');
        expect(bareMeta.rels).toEqual({});
        expect(bareMeta.orderedNumIds.size).toBe(0);

        // 非法 ZIP 优雅回退为空而不抛错
        const invalidMeta = await loadDocxPartMetadata(new Uint8Array([1, 2, 3]), 'word/document.xml');
        expect(invalidMeta.rels).toEqual({});
        expect(invalidMeta.orderedNumIds.size).toBe(0);
    });
});

describe('formatReaders: subtitle timing, metadata & timeline outline', () => {
    it('parses timestamps, formats duration & CPS, extracts LRC/ASS metadata, and buckets timelines', () => {
        expect(parseSubtitleTimestampMs(undefined)).toBeNull();
        expect(parseSubtitleTimestampMs('invalid')).toBeNull();
        expect(parseSubtitleTimestampMs('00:01:02,345')).toBe(62_345);
        expect(parseSubtitleTimestampMs('0:00:01.25')).toBe(1_250);
        expect(parseSubtitleTimestampMs('0:00:01.5')).toBe(1_500);
        expect(parseSubtitleTimestampMs('0:00:01')).toBe(1_000);
        expect(parseSubtitleTimestampMs('02:05.50')).toBe(125_500);
        expect(parseSubtitleTimestampMs('02:05.5')).toBe(125_500);
        expect(parseSubtitleTimestampMs('02:05')).toBe(125_000);

        expect(formatSubtitleDuration('00:00:01,000', '00:00:03,400', 'Hello world!')).toEqual({
            startMs: 1000,
            endMs: 3400,
            durationMs: 2400,
            durationLabel: '2.4s',
            cps: 4.6,
        });
        expect(formatSubtitleDuration('00:00:00,000', '00:01:05,000')).toEqual({
            startMs: 0,
            endMs: 65_000,
            durationMs: 65_000,
            durationLabel: '1m 5.0s',
            cps: null,
        });
        expect(formatSubtitleDuration('00:00:05,000', '00:00:02,000', 'bad')).toEqual({
            startMs: 5000,
            endMs: 2000,
            durationMs: null,
            durationLabel: '',
            cps: null,
        });

        const lrc = parseDocument('song.lrc', '[ti:Starlight]\n[ar:Luna]\n[al:Night]\n[by:Author]\n[offset:500]\n[ti:Ignored]\n[00:10.00]Shine bright\n');
        expect(extractSubtitleMetadata(lrc).lrc).toEqual({
            title: 'Starlight',
            artist: 'Luna',
            album: 'Night',
            by: 'Author',
            offset: '500',
        });

        const ass = parseDocument('ep.ass', [
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
            'Dialogue: 0,0:00:01.00,0:00:03.00,Default,Hero,0,0,0,,Hello',
            'Dialogue: 0,0:06:00.00,0:06:04.00,Sign,,0,0,0,,Town Square',
            'Dialogue: 0,0:06:05.00,0:06:08.00,,Narrator,0,0,0,,Voiceover',
            'Dialogue: 0,0:06:10.00,0:06:12.00,,,0,0,0,,Plain',
        ].join('\n'));
        const assMeta = extractSubtitleMetadata(ass);
        expect(assMeta.cues.get(0)).toEqual({style: 'Default', actor: 'Hero'});
        expect(assMeta.cues.get(1)).toEqual({style: 'Sign'});
        expect(assMeta.cues.get(2)).toEqual({actor: 'Narrator'});
        expect(assMeta.cues.has(3)).toBe(false);
        expect(extractSubtitleMetadata({
            ...ass,
            parts: [{kind: 'segment', segmentIndex: 0, source: 'x', prefix: '', suffix: ''}, {kind: 'literal', value: 'Comment: x'}, {kind: 'segment', segmentIndex: 1, source: 'y', prefix: '', suffix: ''}],
        }).cues.size).toBe(0);
        expect(extractSubtitleMetadata(parseDocument('sub.srt', '1\n00:00:01,000 --> 00:00:02,000\nHi\n')).cues.size).toBe(0);

        const outlineShort = buildSubtitleTimelineOutline(ass.segments, ['你好', '', '旁白', '普通'], {pageSize: 2});
        expect(outlineShort).toEqual([
            {id: 't-0', label: '00:00 – 05:00', startMs: 0, endMs: 300_000, firstSegmentId: 0, page: 1, total: 1, completed: 1},
            {id: 't-1', label: '05:00 – 10:00', startMs: 300_000, endMs: 600_000, firstSegmentId: 1, page: 1, total: 3, completed: 2},
        ]);

        // 超过 60 分钟自动按 10 分钟分桶
        const longSegments: DocumentSegment[] = [
            {id: 0, source: 'Start', timeStart: '00:00:01,000'},
            {id: 1, source: 'Late', timeStart: '01:05:00,000'},
            {id: 2, source: 'Late 2', timeStart: '01:08:00,000'},
        ];
        const outlineLong = buildSubtitleTimelineOutline(longSegments, ['开始', '', '']);
        expect(outlineLong).toEqual([
            {id: 't-0', label: '00:00 – 10:00', startMs: 0, endMs: 600_000, firstSegmentId: 0, page: 1, total: 1, completed: 1},
            {id: 't-6', label: '1:00:00 – 1:10:00', startMs: 3_600_000, endMs: 4_200_000, firstSegmentId: 1, page: 1, total: 2, completed: 0},
        ]);
        expect(buildSubtitleTimelineOutline(longSegments, [], {bucketMinutes: 15})[0].label).toBe('00:00 – 15:00');
        expect(buildSubtitleTimelineOutline([{id: 0, source: 'No time'}], [])).toEqual([]);
    });
});

describe('epubPreviewAssets: lazy ZIP image blob URLs, sanitized CSS & nested TOC', () => {
    async function buildSampleEpub(options: {navKind?: 'xhtml' | 'ncx' | 'none'; brokenNav?: boolean; missingOpf?: boolean; missingContainer?: boolean; missingNavFile?: boolean} = {}): Promise<Uint8Array> {
        const zip = new JSZip();
        zip.file('mimetype', 'application/epub+zip');
        if (!options.missingContainer) {
            zip.file('META-INF/container.xml', options.missingOpf
                ? '<container><rootfiles></rootfiles></container>'
                : '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
        }
        const navKind = options.navKind ?? 'xhtml';
        const opfItems = [
            '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>',
            '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>',
            '<item id="bad" href="https://evil.example/x" media-type="text/css"/>',
            '<item id="nomime" href="extra.txt"/>',
            '<item id="noid" media-type="text/css"/>',
            navKind === 'xhtml' ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '',
            navKind === 'ncx' ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '',
        ].join('');
        if (!options.missingOpf) {
            zip.file('OEBPS/content.opf', `<package><manifest>${opfItems}</manifest><spine${navKind === 'ncx' ? ' toc="ncx"' : ''}><itemref idref="c1"/></spine></package>`);
        }
        if (navKind === 'xhtml' && !options.missingNavFile) {
            zip.file('OEBPS/nav.xhtml', options.brokenNav
                ? '<html xmlns="http://www.w3.org/1999/xhtml"><nav>broken'
                : `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
                    <nav epub:type="toc"><ol>
                        <li><a href="text/ch1.xhtml">Chapter 1</a>
                            <ol><li><a href="text/CH1.xhtml#s1">Section 1.1</a></li></ol>
                        </li>
                        <li><a href="text/ch2.xhtml#top">Chapter 2</a></li>
                        <li><a href="text/ch2.xhtml">   </a></li>
                        <li><a href="https://external.example/skip">External</a></li>
                    </ol></nav>
                    <nav epub:type="landmarks"><ol><li><a href="text/ch1.xhtml">Ignore</a></li></ol></nav>
                </body></html>`);
        }
        if (navKind === 'ncx' && !options.missingNavFile) {
            zip.file('OEBPS/toc.ncx', `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
                <navPoint id="p1"><navLabel><text>Part One</text></navLabel><content src="text/ch1.xhtml"/>
                    <navPoint id="p1a"><navLabel><text>Sub One</text></navLabel><content src="text/ch1.xhtml#sub"/></navPoint>
                </navPoint>
                <navPoint id="p2"><navLabel><text>Missing Chapter</text></navLabel><content src="text/missing.xhtml"/></navPoint>
            </navMap></ncx>`);
        }
        zip.file('OEBPS/styles/book.css', `
            @import url("https://evil.example/a.css");
            body { color: #222; background: url("https://evil.example/bg.png"); behavior: url(x.htc); -moz-binding: url(y.xml); width: expression(alert(1)); }
            </style><script>alert(1)</script>
        `);
        zip.file('OEBPS/styles/empty.css', '@import "https://evil.example/only.css";');
        zip.file('OEBPS/images/cover.png', new Uint8Array([137, 80, 78, 71]));
        zip.file('OEBPS/images/Logo.SVG', new TextEncoder().encode('<svg/>'));
        zip.file('OEBPS/images/data.bin', new Uint8Array([1, 2, 3]));
        zip.file('OEBPS/images/rawimg', new Uint8Array([4, 5, 6]));
        return zip.generateAsync({type: 'uint8array'});
    }

    it('sanitizes dangerous CSS constructs and resolves chapter stylesheets and image blob URLs with idempotent revoke', async () => {
        const safe = sanitizeEpubCss([
            '/* comment */ @\\69mport "https://evil.example/a;b.css";',
            '@import url("https://evil.example/c.css")\n',
            'p { width: expression(alert("x)")); behavior: url("x;y.htc"); -moz-binding: url(y.xml);',
            '  background: \\75rl(/**/"h\\74tps://evil.example/bg).png");',
            '  mask: url("data:image/svg+xml;base64,AA==");',
            '  content: url(\'vbscript:msgbox(1)\');',
            '  list-style: url(file:///etc/passwd);',
            '  background-image: url("data:image/png;base64,iVBOR");',
            '  src: url(data:font/woff2;base64,AAA);',
            '  cursor: url(blob:https://local/1);',
            '  --bad-hex: "\\ffffff\\z";',
            '} </sty</stylele><script>alert(1)</script>',
        ].join(' '));
        expect(safe).not.toMatch(/@import/iu);
        expect(safe).not.toContain('expression(');
        expect(safe).not.toContain('behavior:');
        expect(safe).not.toContain('-moz-binding');
        expect(safe).not.toContain('evil.example');
        expect(safe).not.toContain('svg+xml');
        expect(safe).not.toContain('vbscript:');
        expect(safe).not.toContain('file://');
        expect(safe).not.toContain('<');
        expect(safe).toContain('url("data:image/png;base64,iVBOR")');
        expect(safe).toContain('url("data:font/woff2;base64,AAA")');
        expect(safe).toContain('url("blob:https://local/1")');

        // 含 $' / $& 的样式和 blob URL 不会触发 String.prototype.replace 特殊替换
        const dollarZip = new JSZip();
        dollarZip.file('OEBPS/styles/d.css', 'body::after { content: "price $& $\' $`"; }');
        dollarZip.file('OEBPS/images/a.png', new Uint8Array([137, 80, 78, 71]));
        const dollarBytes = await dollarZip.generateAsync({type: 'uint8array'});
        vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:safe-$&-$\'');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const dollarResolved = await resolveEpubChapterAssets(dollarBytes, 'OEBPS/text/c.xhtml', '<html><head><link rel="stylesheet" href="../styles/d.css"/></head><body><img src="../images/a.png"/>TAIL</body></html>');
        expect(dollarResolved.html).toContain('price $& $\' $`');
        expect(dollarResolved.html).toContain('src="blob:safe-$&-$\'"');
        expect(dollarResolved.html.match(/TAIL/gu)).toHaveLength(1);
        dollarResolved.revoke();
        vi.restoreAllMocks();

        let counter = 0;
        const created: string[] = [];
        const revoked: string[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            const url = `blob:epub-${++counter}`;
            created.push(url);
            return url;
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {revoked.push(url);});

        const bytes = await buildSampleEpub();
        const zipA = await loadEpubZip(bytes);
        const zipB = await loadEpubZip(bytes);
        expect(zipA).toBe(zipB);

        const chapterHtml = [
            '<html><head>',
            '<link rel=\'stylesheet\' href="../styles/book.css"/>',
            '<link href="../styles/other.css"/>',
            '<link rel="stylesheet" href="../styles/empty.css"/>',
            '<link rel="stylesheet" href="../styles/missing.css"/>',
            '<link rel="stylesheet" href="https://evil.example/remote.css"/>',
            '<link rel="icon" href="../images/cover.png"/>',
            '</head><body>',
            '<img src="../images/cover.png" alt="cover"/>',
            '<img src=\'../images/cover.png\' alt="dup"/>',
            '<img src="data:image/png;base64,AA=="/>',
            '<img src="https://remote.example/a.png"/>',
            '<img src="../images/missing.png"/>',
            '<img alt="no-src"/>',
            '<img src="invalid\\path.png"/>',
            '<svg><image xlink:href="../images/logo.svg"/><image href="../images/data.bin"/><image href="../images/rawimg"/><image width="10"/></svg>',
            '</body></html>',
        ].join('');

        const resolved = await resolveEpubChapterAssets(bytes, 'OEBPS/text/ch1.xhtml', chapterHtml);
        expect(resolved.inlineCss).toContain('color: #222');
        expect(resolved.inlineCss).not.toContain('@import');
        expect(resolved.html).toContain('<style data-epub-stylesheet="true">');
        expect(resolved.html).not.toContain('book.css');
        expect(resolved.html).toContain('src="blob:epub-1"');
        expect(resolved.html).toContain('xlink:href="blob:epub-2"');
        expect(resolved.html).toContain('href="blob:epub-3"');
        // 重复引用同一图片只创建一个 blob URL
        expect(resolved.blobUrls).toEqual(['blob:epub-1', 'blob:epub-2', 'blob:epub-3', 'blob:epub-4']);
        expect(created).toHaveLength(4);

        resolved.revoke();
        resolved.revoke();
        expect(revoked).toEqual(['blob:epub-1', 'blob:epub-2', 'blob:epub-3', 'blob:epub-4']);
        expect(resolved.blobUrls).toEqual([]);

        // 无 </head> 且无图片时也正常前置内联样式；无样式无图片时原样返回
        const noHead = await resolveEpubChapterAssets(bytes, 'OEBPS/text/ch1.xhtml', '<link rel="stylesheet" href="../styles/book.css"><p>Body</p>');
        expect(noHead.html.startsWith('<style data-epub-stylesheet="true">')).toBe(true);
        const plainChapter = await resolveEpubChapterAssets(bytes, 'OEBPS/text/ch1.xhtml', '<p>Plain</p>');
        expect(plainChapter).toMatchObject({html: '<p>Plain</p>', inlineCss: '', blobUrls: []});

        // 后续图片失败时自动释放前面已创建的 blob URL，避免内存泄漏
        const leakedRevoked: string[] = [];
        let failStep = 0;
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            failStep += 1;
            if (failStep === 2) throw new Error('blob quota');
            return 'blob:partial-1';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {leakedRevoked.push(url);});
        await expect(resolveEpubChapterAssets(bytes, 'OEBPS/text/ch1.xhtml', '<img src="../images/cover.png"/><img src="../images/logo.svg"/>')).rejects.toThrow('blob quota');
        expect(leakedRevoked).toEqual(['blob:partial-1']);
    });

    it('clears cache on invalid ZIP bytes and loads nested TOC from both EPUB 3 nav.xhtml and EPUB 2 toc.ncx', async () => {
        const badBytes = new Uint8Array([0, 1, 2, 3]);
        await expect(loadEpubZip(badBytes)).rejects.toThrow();

        const chapters: EpubDocumentChapter[] = [
            {path: 'OEBPS/text/ch1.xhtml', source: '', segmentOffset: 0, segmentCount: 1, title: 'Ch 1'},
            {path: 'OEBPS/text/ch2.xhtml', source: '', segmentOffset: 1, segmentCount: 1, title: 'Ch 2'},
        ];

        const epub3 = await buildSampleEpub({navKind: 'xhtml'});
        expect(await loadEpubNestedToc(epub3, chapters)).toEqual([
            {id: 'toc-0', title: 'Chapter 1', level: 1, chapterIndex: 0, fragment: '', href: 'text/ch1.xhtml'},
            {id: 'toc-1', title: 'Section 1.1', level: 2, chapterIndex: 0, fragment: 's1', href: 'text/CH1.xhtml#s1'},
            {id: 'toc-2', title: 'Chapter 2', level: 1, chapterIndex: 1, fragment: 'top', href: 'text/ch2.xhtml#top'},
            {id: 'toc-4', title: 'External', level: 1, chapterIndex: -1, fragment: '', href: 'https://external.example/skip'},
        ]);

        const epub2 = await buildSampleEpub({navKind: 'ncx'});
        expect(await loadEpubNestedToc(epub2, chapters)).toEqual([
            {id: 'toc-0', title: 'Part One', level: 1, chapterIndex: 0, fragment: '', href: 'text/ch1.xhtml'},
            {id: 'toc-1', title: 'Sub One', level: 2, chapterIndex: 0, fragment: 'sub', href: 'text/ch1.xhtml#sub'},
            {id: 'toc-2', title: 'Missing Chapter', level: 1, chapterIndex: -1, fragment: '', href: 'text/missing.xhtml'},
        ]);

        // 无 spine toc 属性时按 media-type 回退找 NCX
        const ncxFallbackZip = new JSZip();
        ncxFallbackZip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>');
        ncxFallbackZip.file('content.opf', '<package><manifest><item id="t" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine/></package>');
        ncxFallbackZip.file('toc.ncx', '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>Intro</text></navLabel><content src="OEBPS/text/ch1.xhtml"/></navPoint></navMap></ncx>');
        const ncxFallbackBytes = await ncxFallbackZip.generateAsync({type: 'uint8array'});
        expect(await loadEpubNestedToc(ncxFallbackBytes, chapters)).toEqual([
            {id: 'toc-0', title: 'Intro', level: 1, chapterIndex: 0, fragment: '', href: 'OEBPS/text/ch1.xhtml'},
        ]);

        expect(await loadEpubNestedToc(await buildSampleEpub({missingContainer: true}), chapters)).toEqual([]);
        expect(await loadEpubNestedToc(await buildSampleEpub({missingOpf: true}), chapters)).toEqual([]);
        expect(await loadEpubNestedToc(await buildSampleEpub({navKind: 'none'}), chapters)).toEqual([]);
        expect(await loadEpubNestedToc(await buildSampleEpub({missingNavFile: true}), chapters)).toEqual([]);
        expect(await loadEpubNestedToc(await buildSampleEpub({brokenNav: true}), chapters)).toEqual([]);

        // XHTML 命名实体（&nbsp;/&mdash;/&rsquo;/&copy;）正常解析；畸形 XML 与缺失层级安全回退
        const entityNav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
            <nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Part&nbsp;1&mdash;Hero&rsquo;s &copy; Tale</a></li></ol></nav>
        </body></html>`;
        expect(readEpubTocLevels(entityNav, 'xhtml')).toEqual([1]);
        expect(readEpubTocLevels('<html xmlns="http://www.w3.org/1999/xhtml"><nav epub:type="toc">&unknown_ent;</nav>', 'xhtml')).toEqual([]);
        expect(readEpubTocLevels('<ncx><broken', 'ncx')).toEqual([]);
        expect(buildEpubTocItems('OEBPS/nav.xhtml', [{text: 'Fallback', href: 'text/ch1.xhtml'}], [], chapters)).toEqual([
            {id: 'toc-0', title: 'Fallback', level: 1, chapterIndex: 0, fragment: '', href: 'text/ch1.xhtml'},
        ]);
    });
});

describe('preview.ts upgrades: TXT structure, Markdown features & appearance options', () => {
    it('renders TXT scene breaks, divider lines, chapter headings and literal syntax', () => {
        const txt = [
            '第一章 启程',
            '',
            'Keep *stars* _under_ `code` [link](https://example.com).',
            '',
            '',
            '---',
            '',
            'Chapter IV: The Return',
            '',
            'Another paragraph.',
        ].join('\n');
        const doc = parseDocument('novel.txt', txt);
        const translations = ['Chapter 1 Departure', '保留 *stars*。', '---', '第四章 归来', '另一段。'];
        const html = createDocumentPreviewHtml(doc, translations, 'bilingual', {
            bilingualLayout: 'stacked',
            readingTheme: 'sepia',
            fontFamily: 'serif',
            lineHeight: 2.0,
        });
        const {document} = parseHTML(html);

        expect(document.querySelector('article')?.getAttribute('data-bilingual-layout')).toBe('stacked');
        expect(html).toContain('#f6f0e4');
        expect(html).toContain('Noto Serif SC');
        expect(html).toContain('line-height: 2;');
        expect(document.querySelectorAll('h2.reader-heading')).toHaveLength(4);
        expect(document.querySelector('.reader-unit.scene-break')).not.toBeNull();
        expect(document.querySelector('.reader-unit.horizontal-rule')).not.toBeNull();
        expect(document.querySelector('em, code, a')).toBeNull();
    });

    it('renders Markdown frontmatter, display/inline math, code language headers, nested/ordered/task lists, merged quotes, callouts, inline images and scrollable tables', () => {
        const md = [
            '---',
            'title: Guide',
            'author: Team',
            '---',
            '',
            'Inline $E = mc^2$ and ![dot](data:image/png;base64,AA==) and [anchor](#sec) and `~a$`',
            '',
            '$$',
            'x^2 + y^2 = z^2',
            '$$',
            '',
            '$$a + b = c$$',
            '',
            '```python',
            'print("hi")',
            '```',
            '',
            '1. First item',
            '\t- [x] Done task',
            '  - [ ] Todo task',
            '',
            '> [!NOTE] Custom Note',
            '> Stay safe',
            '> Keep reading',
            '',
            '> [!TIP]',
            '> Helpful hint',
            '',
            '> Line one',
            '> Line two',
            '',
            '| Col A | Col B |',
            '| --- | --- |',
            '| Hello | World |',
        ].join('\n');

        const doc = parseDocument('rich.md', md);
        const html = createDocumentPreviewHtml(doc, [], 'bilingual', {
            readingTheme: 'dark',
            bilingualLayout: 'split',
            fontFamily: 'sans',
            lineHeight: 1.85,
        });
        const {document} = parseHTML(html);

        expect(document.querySelector('details.reader-frontmatter summary')?.textContent).toBe('Frontmatter');
        expect(document.querySelector('details.reader-frontmatter code')?.textContent).toContain('title: Guide');
        expect(document.querySelector('code.reader-inline-math')?.textContent).toBe('E = mc^2');
        expect(document.querySelector('img.reader-inline-image')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
        expect(document.querySelector('a.reader-link[href="#sec"]')?.getAttribute('target')).toBeNull();
        expect(document.querySelectorAll('pre.reader-math')).toHaveLength(2);
        expect(document.querySelector('figure.reader-code figcaption')?.textContent).toBe('python');
        expect(document.querySelector('.reader-unit.list-item.ordered-item')?.getAttribute('data-list-marker')).toBe('1.');
        expect(document.querySelectorAll('.reader-unit.list-item.task-item')).toHaveLength(2);
        expect(document.querySelector('.reader-checkbox.is-checked')?.textContent).toBe('✓');
        expect(document.querySelector('.reader-callout-note .reader-callout-title')?.textContent).toBe('Custom Note');
        expect(document.querySelector('.reader-callout-tip .reader-callout-title')?.textContent).toBe('TIP');
        expect(document.querySelector('.reader-unit.quote blockquote')?.innerHTML).toContain('Line one<br>Line two');
        expect(document.querySelector('.reader-table-scroll > table.markdown-preview-table')).not.toBeNull();
        expect(document.querySelector('.reader-unit.is-pending')).not.toBeNull();
        expect(html).toContain('content-visibility: auto');
        expect(html).toContain('#1c212b');

        // 未闭合 frontmatter 退回水平线；多行公式里包含无引用行也保持完整
        const unclosedFrontmatter = parseDocument('hr.md', '---\n\n> $$\nplain math\n> $$\n');
        const unclosedHtml = createDocumentPreviewHtml(unclosedFrontmatter, [], 'source', {readingTheme: 'green'});
        expect(unclosedHtml).toContain('horizontal-rule');
        expect(unclosedHtml).toContain('plain math');
        expect(unclosedHtml).toContain('#e9f3eb');

        // 单行 Markdown 整句含占位符，以及引用紧接代码块与表格
        const quoteBlocksDoc = parseDocument('quote-blocks.md', '> Quote before code\n> ```js\n> const a = 1;\n> ```\n\n> Quote before table\n> | K | V |\n> | --- | --- |\n> | A | B |\n\nRead **bold** now.', {markdownSentences: true});
        const quoteBlocksHtml = createDocumentPreviewHtml(quoteBlocksDoc, [], 'source');
        expect(quoteBlocksHtml).toContain('const a = 1;');
        expect(quoteBlocksHtml).toContain('<table class="markdown-preview-table"');
        expect(quoteBlocksHtml).toContain('<strong>bold</strong>');

        // HTML/EPUB 外观与双语布局选项 + data-segment-id 标注
        const htmlDoc = parseDocument('article.html', '<p>First</p><p>Second</p><span data-fluent-read-document-translation="true">Author</span>');
        const htmlSplit = createDocumentPreviewHtml(htmlDoc, ['第一', '第二'], 'bilingual', {
            bilingualLayout: 'split',
            readingTheme: 'light',
        });
        expect(htmlSplit).toContain('data-segment-id="0"');
        expect(htmlSplit).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
        const htmlStacked = createDocumentPreviewHtml(htmlDoc, ['第一', '第二'], 'bilingual', {
            bilingualLayout: 'stacked',
            readingTheme: 'auto',
        });
        expect(htmlStacked).toContain('border-radius: 6px');
    });
});

describe('richPreviewSync: incremental segment patching & scrollspy heading tracking', () => {
    it('patches changed segments in O(changed) without touching sibling nodes or running DOMParser', () => {
        const doc = parseDocument('notes.txt', 'Chapter 1\n\nFirst paragraph\n\nSecond paragraph');
        const initialHtml = createDocumentPreviewHtml(doc, ['', '', ''], 'bilingual');
        const dom = parseHTML(initialHtml).document as unknown as Document;
        const frame = {contentDocument: dom};
        const unit0 = dom.querySelector('[data-segment-id="0"]')!;
        const unit1 = dom.querySelector('[data-segment-id="1"]')!;
        const unit2 = dom.querySelector('[data-segment-id="2"]')!;
        expect(unit1.classList.contains('is-pending')).toBe(true);

        // 空更新直接成功
        expect(patchRichPreviewSegments(frame, [], {mode: 'bilingual', format: 'txt'})).toBe(true);
        // 增量补丁只改 0 与 1，不动 2
        expect(patchRichPreviewSegments(frame, [
            {id: 0, translation: '第一章'},
            {id: 1, translation: '第一段\n换行'},
        ], {mode: 'bilingual', format: 'txt'})).toBe(true);
        expect(unit0.classList.contains('is-pending')).toBe(false);
        expect(unit0.querySelector('h2.reader-translation.reader-heading')?.textContent).toBe('第一章');
        expect(unit1.querySelector('p.reader-translation')?.innerHTML).toBe('第一段<br>换行');
        expect(unit2.classList.contains('is-pending')).toBe(true);

        // 再次更新已存在译文节点，以及清空译文恢复等待态
        expect(patchRichPreviewSegments(frame, [{id: 1, translation: '更新译文'}], {mode: 'bilingual', format: 'txt'})).toBe(true);
        expect(unit1.querySelector('p.reader-translation')?.textContent).toBe('更新译文');
        expect(patchRichPreviewSegments(frame, [{id: 1, translation: ''}], {mode: 'bilingual', format: 'txt'})).toBe(true);
        expect(unit1.querySelector('.reader-translation')).toBeNull();
        expect(unit1.classList.contains('is-pending')).toBe(true);

        // translated 模式下移除原文并可在清空时恢复原文
        const transDom = parseHTML(createDocumentPreviewHtml(doc, ['第一章', '第一段', ''], 'translated')).document as unknown as Document;
        const transFrame = {contentDocument: transDom};
        expect(patchRichPreviewSegments(transFrame, [{id: 2, translation: '第二段'}], {mode: 'translated', format: 'txt'})).toBe(true);
        expect(transDom.querySelector('[data-segment-id="2"] .reader-source')).toBeNull();
        expect(transDom.querySelector('[data-segment-id="2"] .reader-translation')?.textContent).toBe('第二段');
        expect(patchRichPreviewSegments(transFrame, [{id: 2, source: 'Second paragraph', translation: ''}], {mode: 'translated', format: 'txt'})).toBe(true);
        expect(transDom.querySelector('[data-segment-id="2"] .reader-source')?.textContent).toBe('Second paragraph');
        // translated 模式下仅含 .reader-translation 且未传 source 时也能直接更新
        expect(patchRichPreviewSegments(transFrame, [{id: 1, translation: '第一段修改'}], {mode: 'translated', format: 'txt'})).toBe(true);
        expect(transDom.querySelector('[data-segment-id="1"] .reader-translation')?.textContent).toBe('第一段修改');

        // HTML/EPUB [data-segment-id] 节点原位补丁
        const htmlDom = parseHTML('<html><body><p>Hi<span data-fluent-read-document-translation="true" data-segment-id="0">旧</span></p><div data-segment-id="1"><span class="fluentread-translation">旧2</span></div><div data-segment-id="2">no-child</div><section class="reader-unit" data-segment-id="3"></section></body></html>').document as unknown as Document;
        expect(patchRichPreviewSegments({contentDocument: htmlDom}, [
            {id: 0, source: 'Hi', translation: '新译文'},
            {id: 1, translation: '新2'},
        ], {mode: 'bilingual', format: 'html'})).toBe(true);
        expect(htmlDom.querySelector('[data-segment-id="0"]')?.textContent).toBe('新译文');
        expect(htmlDom.querySelector('[data-segment-id="1"] .fluentread-translation')?.textContent).toBe('新2');

        // 失败退回分支：空 frame、模式不匹配、Markdown 行内语法、缺失节点、空 reader-unit、非 distinct HTML 译文
        expect(patchRichPreviewSegments(null, [{id: 0, translation: 'x'}], {mode: 'bilingual'})).toBe(false);
        expect(patchRichPreviewSegments(frame, [{id: 0, translation: 'x'}], {mode: 'translated'})).toBe(false);
        expect(patchRichPreviewSegments(frame, [{id: 0, translation: '**bold**'}], {mode: 'bilingual', format: 'markdown'})).toBe(false);
        expect(patchRichPreviewSegments(frame, [{id: 99, translation: 'x'}], {mode: 'bilingual'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: htmlDom}, [{id: 2, translation: 'x'}], {mode: 'bilingual'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: htmlDom}, [{id: 3, translation: 'x'}], {mode: 'bilingual'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: htmlDom}, [{id: 0, source: 'Hi', translation: 'Hi'}], {mode: 'bilingual'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: htmlDom}, [{id: 0, translation: 'x'}], {mode: 'translated'})).toBe(false);
        expect(patchRichPreviewSegments(frame, [{id: 0, translation: 'x'}], {mode: 'translated', format: 'html'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: parseHTML('<html><body><article data-reader-mode="source"><section class="reader-unit" data-segment-id="0"><p class="reader-source">A</p></section></article></body></html>').document as unknown as Document}, [{id: 0, translation: '甲'}], {mode: 'source', format: 'epub'})).toBe(false);

        // 原子性：后一条失败时前一条不产生部分 DOM 修改
        const beforeAtomic = unit0.querySelector('.reader-translation')?.textContent;
        expect(patchRichPreviewSegments(frame, [{id: 0, translation: '不应写入'}, {id: 999, translation: 'missing'}], {mode: 'bilingual', format: 'txt'})).toBe(false);
        expect(unit0.querySelector('.reader-translation')?.textContent).toBe(beforeAtomic);

        // task-item、多段合并 quote 与恢复含 Markdown 行内语法的原文都必须退回整页同步
        const mdGuardDoc = parseDocument('guards.md', '- [x] Check me\n\n> Line 1\n> Line 2\n\nKeep **bold**');
        const mdGuardDom = parseHTML(createDocumentPreviewHtml(mdGuardDoc, ['检查', '一', '二', '保留粗体'], 'translated')).document as unknown as Document;
        expect(patchRichPreviewSegments({contentDocument: mdGuardDom}, [{id: 0, translation: '改写'}], {mode: 'translated', format: 'markdown'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: mdGuardDom}, [{id: 1, translation: '改写引用'}], {mode: 'translated', format: 'markdown'})).toBe(false);
        expect(patchRichPreviewSegments({contentDocument: mdGuardDom}, [{id: 3, source: 'Keep **bold**', translation: ''}], {mode: 'translated', format: 'markdown'})).toBe(false);
    });

    it('tracks active visible heading ID and outline index using getBoundingClientRect or offsetTop', () => {
        expect(findActiveRichHeadingId(null)).toBeNull();
        expect(findActiveRichOutlineIndex(null)).toBe(-1);

        const noHeadingDom = parseHTML('<html><body><p>Just text</p></body></html>').document as unknown as Document;
        expect(findActiveRichHeadingId({contentDocument: noHeadingDom})).toBeNull();

        const dom = parseHTML('<html><body><h1 id="intro">Intro</h1><h2 id="sec-1">One</h2><h2>Two</h2></body></html>').document as unknown as Document;
        const headings = Array.from(dom.querySelectorAll('h1,h2'));
        const tops = [-200, 30, 320];
        headings.forEach((h, idx) => {
            (h as unknown as {getBoundingClientRect: () => {top: number}}).getBoundingClientRect = () => ({top: tops[idx]});
        });
        expect(findActiveRichOutlineIndex({contentDocument: dom}, 80)).toBe(1);
        expect(findActiveRichHeadingId({contentDocument: dom}, 80)).toBe('sec-1');

        // 滚到最底部，无 id 的标题返回 h{index}
        tops[2] = 40;
        expect(findActiveRichHeadingId({contentDocument: dom}, 80)).toBe('h2');

        // 首个标题在偏移下方时回退首个标题
        tops[0] = 150;
        tops[1] = 400;
        tops[2] = 700;
        expect(findActiveRichHeadingId({contentDocument: dom}, 80)).toBe('intro');

        // 无 getBoundingClientRect 时使用 offsetTop 与 scrollingElement.scrollTop
        const offsetDom = parseHTML('<html><body><h1 id="a">A</h1><h2 id="b">B</h2><h2 id="c">C</h2></body></html>').document as unknown as Document;
        const offsetHeadings = Array.from(offsetDom.querySelectorAll('h1,h2'));
        offsetHeadings.forEach((h) => {Object.defineProperty(h, 'getBoundingClientRect', {value: undefined});});
        Object.defineProperty(offsetHeadings[0], 'offsetTop', {value: 0});
        Object.defineProperty(offsetHeadings[1], 'offsetTop', {value: 300});
        Object.defineProperty(offsetHeadings[2], 'offsetTop', {value: 900});
        Object.defineProperty(offsetDom, 'scrollingElement', {value: {scrollTop: 260}});
        expect(findActiveRichHeadingId({contentDocument: offsetDom}, 80)).toBe('b');

        // 无 offsetTop 且无 getBoundingClientRect 时仍安全返回
        const plainDom = parseHTML('<html><body><h1>Only</h1></body></html>').document as unknown as Document;
        Object.defineProperty(plainDom.querySelector('h1')!, 'getBoundingClientRect', {value: undefined});
        expect(findActiveRichHeadingId({contentDocument: plainDom}, 80)).toBe('h0');
    });

    it('lazy-loads epub and docx preview asset helpers through document-translation public barrel', async () => {
        const pub = await import('@/src/features/document-translation/public');
        const zip = new JSZip();
        zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>');
        const bytes = await zip.generateAsync({type: 'uint8array'});
        const docxMeta = await pub.loadDocxPartMetadata(bytes, 'word/document.xml');
        expect(docxMeta.rels.rId1).toBe('https://example.com');
        const epubAssets = await pub.resolveEpubChapterAssets(bytes, 'OEBPS/ch1.xhtml', '<p>Hello</p>');
        expect(epubAssets.html).toContain('Hello');
        epubAssets.revoke();
        expect(await pub.loadEpubNestedToc(bytes, [])).toEqual([]);
    });
});
