import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {parseDocument, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {
    assertArchiveSafety,
    chapterTitle,
    createDocumentDownload,
    docxParagraphRole,
    docxParagraphText,
    docxPartTitle,
    docxTextNodes,
    median,
    normalizeZipPath,
    parseBinaryDocument,
    parseDocumentFile,
    parseXmlAttributes,
    pdfTextAtoms,
    pdfTextBlocks,
    pdfTextLines,
    renderDocxPart,
    resolveZipPath,
    xmlDecode,
    xmlEscape,
    type PdfTextAtom,
    type PdfTextItem,
    type PdfTextLine,
} from '@/src/features/document-translation/services/binary';

async function zipBytes(files: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    Object.entries(files).forEach(([path, value]) => zip.file(path, value));
    return zip.generateAsync({type: 'uint8array'});
}

afterEach(() => {
    vi.unstubAllGlobals();
});

function pdfItem(overrides: Partial<PdfTextItem> = {}): PdfTextItem {
    return {
        str: 'Hello',
        dir: 'ltr',
        transform: [1, 0, 0, 10, 10, 20],
        width: 30,
        height: 10,
        fontName: 'body',
        hasEOL: false,
        ...overrides,
    };
}

function atom(text: string, x: number, y: number, width = 20, height = 10): PdfTextAtom {
    return {text, x, y, width, height, fontFamily: 'sans-serif'};
}

function line(text: string, x: number, y: number, width = 80, height = 10): PdfTextLine {
    return {text, x, y, width, height, fontFamily: 'sans-serif'};
}

describe('binary document low-level contracts', () => {
    it('限制压缩项数量、单项大小和解压总量', () => {
        const tooMany = Object.fromEntries(Array.from({length: 4_001}, (_, index) => [
            `entry-${index}`,
            {_data: {uncompressedSize: 1}},
        ]));
        expect(() => assertArchiveSafety({files: tooMany} as unknown as JSZip, 'ePub')).toThrow('过多压缩项');

        expect(() => assertArchiveSafety({
            files: {large: {_data: {uncompressedSize: 24 * 1024 * 1024 + 1}}},
        } as unknown as JSZip, 'DOCX')).toThrow('单个内容项过大');

        const total = Object.fromEntries(Array.from({length: 5}, (_, index) => [
            `entry-${index}`,
            {_data: {uncompressedSize: 20 * 1024 * 1024}},
        ]));
        expect(() => assertArchiveSafety({files: total} as unknown as JSZip, 'ePub')).toThrow('解压后内容过大');
        expect(() => assertArchiveSafety({files: {safe: {}}} as unknown as JSZip, 'DOCX')).not.toThrow();
    });

    it('规范化 XML 实体、属性和 ZIP 相对路径', () => {
        expect(xmlDecode('&#x41;&#65;&quot;&apos;&lt;&gt;&amp;')).toBe("AA\"'<>&");
        expect(xmlEscape('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
        expect(parseXmlAttributes('id="chapter" href=\'part.xhtml\' disabled')).toEqual({
            id: 'chapter',
            href: 'part.xhtml',
        });
        expect(normalizeZipPath('./OEBPS/chapters/../part.xhtml')).toBe('OEBPS/part.xhtml');
        expect(resolveZipPath('OEBPS/content.opf', 'chapters/part.xhtml?x=1#top')).toBe('OEBPS/chapters/part.xhtml');
        expect(resolveZipPath('content.opf', '%E0%A4%A')).toBe('%E0%A4%A');
        expect(median([])).toBe(1);
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 2])).toBe(3);
    });

    it('缩放、反转和旋转视口保持 PDF 文本坐标', () => {
        const scaled = pdfTextAtoms([pdfItem({transform: [1, 0, 0, 10, 70, 20]})],
            {body: {ascent: 0.8}}, {width: 500, height: 500, transform: [2, 0, 0, -2, 5, 400]});
        expect(scaled[0]).toMatchObject({x: 145, y: 344, height: 20});
        const rotated = pdfTextAtoms([pdfItem({transform: [0, -1, 10, 0, 20, 30]})],
            {body: {ascent: 0.8}}, {width: 500, height: 500, transform: [0, 1, -1, 0, 200, 0]});
        expect(rotated[0]).toMatchObject({x: 170, y: 12, height: 10});
    });

    it('将 PDF.js 文本项过滤并转换为页面原子', () => {
        const viewport = {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]};
        const atoms = pdfTextAtoms([
            pdfItem(),
            pdfItem({str: 'Descent', fontName: 'descent', transform: [1, 0, 0, 0, 10, 40], height: 8, width: 0}),
            pdfItem({str: 'Fallback', fontName: 'missing', transform: [1, 0, 0, 0, 10, 60], height: 0}),
            pdfItem({str: 'Rotated', transform: [0, 1, -10, 0, 10, 20]}),
            pdfItem({str: '   '}),
            pdfItem({str: 'Outside', transform: [1, 0, 0, 10, 200, 200]}),
        ], {
            body: {ascent: 0.8, fontFamily: 'Body'},
            descent: {descent: -0.2},
        }, viewport);

        expect(atoms.map(({text}) => text)).toEqual(['Hello', 'Descent', 'Fallback']);
        expect(atoms[0].fontFamily).toBe('Body');
        expect(atoms[1].width).toBeGreaterThan(0);
        expect(atoms[2].fontFamily).toBe('sans-serif');
    });

    it('将同一行原子按标点、连字符和栏间距组合', () => {
        expect(pdfTextLines([], 300)).toEqual([]);
        const lines = pdfTextLines([
            atom('well-', 0, 10),
            atom('known', 22, 10),
            atom(',', 44, 10, 4),
            atom('right-column', 220, 10, 50),
            atom('next', 0, 30),
            atom('Hello', 0, 50),
            atom('world', 25, 50),
        ], 300);

        expect(lines.map(({text}) => text)).toEqual(['well-known,', 'right-column', 'next', 'Hello world']);
    });

    it('把 PDF 文本行组合为标题、段落、断词和多栏块', () => {
        expect(pdfTextBlocks([], 400)).toEqual([]);
        const blocks = pdfTextBlocks([
            line('Centered title', 120, 0, 160, 18),
            line('A para-', 0, 30),
            line('graph continues', 0, 39),
            line('New sentence.', 0, 65),
            line('Indented paragraph', 20, 72),
            line('Right column', 250, 30),
            line('', 0, 100, 1, 1),
        ], 400);

        expect(blocks.some((block) => block.source === 'Centered title' && block.fontWeight === 700)).toBe(true);
        expect(blocks.some((block) => block.source.includes('A paragraph continues'))).toBe(true);
        expect(blocks.some((block) => block.source === 'Right column')).toBe(true);
        expect(blocks.every((block) => block.source.length > 0)).toBe(true);

        const separated = pdfTextBlocks([
            line('Sentence.', 0, 0),
            line('Next paragraph', 0, 18),
        ], 400);
        expect(separated).toHaveLength(2);
    });

    it('识别 ePub 章节标题与 DOCX 部件、段落角色和文本控制符', () => {
        expect(chapterTitle('<html><head><title> A &amp; <b>book</b> </title></head></html>', 'Fallback')).toBe('A & book');
        expect(chapterTitle('<html></html>', 'Fallback')).toBe('Fallback');
        expect(chapterTitle('<title>   </title>', 'Fallback')).toBe('Fallback');

        expect(docxParagraphText('<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/></w:r></w:p>'))
            .toBe('A&B\tC');
        expect(docxPartTitle('word/document.xml')).toBe('正文');
        expect(docxPartTitle('word/header2.xml')).toBe('页眉');
        expect(docxPartTitle('word/footer2.xml')).toBe('页脚');
        expect(docxPartTitle('word/footnotes.xml')).toBe('脚注');
        expect(docxPartTitle('word/endnotes.xml')).toBe('尾注');
        expect(docxPartTitle('word/comments.xml')).toBe('文档内容');

        expect(docxParagraphRole('', 'word/header1.xml')).toBe('header');
        expect(docxParagraphRole('', 'word/footer1.xml')).toBe('footer');
        expect(docxParagraphRole('', 'word/footnotes.xml')).toBe('note');
        expect(docxParagraphRole('<w:pStyle w:val="Title"/>', 'word/document.xml')).toBe('title');
        expect(docxParagraphRole('<w:pStyle w:val="Heading1"/>', 'word/document.xml')).toBe('heading');
        expect(docxParagraphRole('<w:numPr/>', 'word/document.xml')).toBe('list-item');
        expect(docxParagraphRole('<w:p/>', 'word/document.xml')).toBe('paragraph');

        expect(docxTextNodes('A\r\nB\tC')).toContain('<w:br/>');
        expect(docxTextNodes('A\r\nB\tC')).toContain('<w:tab/>');
        expect(docxTextNodes('')).toBe('<w:t></w:t>');
    });

    it('DOCX 部件渲染保留未映射段落并支持译文回退', () => {
        const source = '<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Keep</w:t></w:r></w:p>';
        const document: ParsedDocument = {
            fileName: 'sample.docx',
            format: 'docx',
            label: 'DOCX 文档',
            parts: [],
            segments: [{id: 0, source: 'One'}],
        };
        const part = {path: 'word/document.xml', source, paragraphSegments: [{paragraphIndex: 0, segmentIndex: 0}]};

        expect(renderDocxPart(document, part, [], 'translated')).toContain('One');
        expect(renderDocxPart(document, part, ['译文'], 'bilingual')).toContain('E83B6B');
        expect(renderDocxPart({...document, segments: []}, part, [], 'translated')).toBe(part.source);
        expect(renderDocxPart(document, part, ['译文'], 'translated')).toContain('Keep');
    });

    it('公共入口拒绝错误格式，并覆盖文本下载与二进制状态不变量', async () => {
        const bytes = new Uint8Array();
        await expect(parseBinaryDocument('notes.txt', bytes)).rejects.toThrow('不是 PDF、ePub 或 DOCX');
        await expect(parseBinaryDocument('unknown.bin', bytes)).rejects.toThrow('不是 PDF、ePub 或 DOCX');
        await expect(parseDocumentFile({
            name: 'unknown.bin',
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        })).rejects.toThrow('暂不支持该文件格式');
        await expect(parseDocumentFile({
            name: 'notes.txt',
            text: async () => 'Hello',
            arrayBuffer: async () => new ArrayBuffer(0),
        })).resolves.toMatchObject({format: 'txt'});

        const text = parseDocument('notes.txt', 'Hello');
        await expect(createDocumentDownload(text, ['你好'], 'translated')).resolves.toMatchObject({
            data: '你好',
            fileName: 'notes.translated.txt',
        });
        await expect(createDocumentDownload({...text, format: 'pdf'}, [], 'translated'))
            .rejects.toThrow('PDF 文档状态无效');
        await expect(createDocumentDownload({...text, format: 'epub'}, [], 'translated'))
            .rejects.toThrow('ePub 文档状态无效');
        await expect(createDocumentDownload({...text, format: 'docx'}, [], 'translated'))
            .rejects.toThrow('DOCX 文档状态无效');

        vi.stubGlobal('window', {location: {origin: 'chrome-extension://fluentread'}});
        await expect(parseBinaryDocument('broken.pdf', new TextEncoder().encode('%PDF-broken')))
            .rejects.toThrow('PDF 解析失败');
    });

    it('拒绝 ePub 缺失结构、错误签名、缺失 OPF 和空章节', async () => {
        await expect(parseBinaryDocument('missing.epub', await zipBytes({mimetype: 'application/epub+zip'})))
            .rejects.toThrow('缺少 mimetype');
        await expect(parseBinaryDocument('wrong.epub', await zipBytes({
            mimetype: 'application/zip',
            'META-INF/container.xml': '<container/>',
        }))).rejects.toThrow('签名无效');
        await expect(parseBinaryDocument('opf.epub', await zipBytes({
            mimetype: 'application/epub+zip',
            'META-INF/container.xml': '<container/>',
        }))).rejects.toThrow('找不到内容清单 OPF');
        await expect(parseBinaryDocument('empty.epub', await zipBytes({
            mimetype: 'application/epub+zip',
            'META-INF/container.xml': '<rootfile full-path="content.opf"/>',
            'content.opf': '<package><manifest><item id="missing" href="missing.xhtml" media-type="application/xhtml+xml"/></manifest></package>',
        }))).rejects.toThrow('没有找到可翻译的章节文字');

        await expect(parseBinaryDocument('empty-chapter.epub', await zipBytes({
            mimetype: 'application/epub+zip',
            'META-INF/container.xml': '<rootfile full-path="content.opf"/>',
            'content.opf': [
                '<package><manifest>',
                '<item id="chapter" href="chapter.xhtml"/>',
                '<item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/>',
                '</manifest><spine><itemref/><itemref idref="chapter"/><itemref idref="empty"/></spine></package>',
            ].join(''),
            'chapter.xhtml': '<html><body><p>Ignored without media type</p></body></html>',
            'empty.xhtml': '<html><body><script>only protected text</script></body></html>',
        }))).rejects.toThrow('没有找到可翻译的章节文字');
    });

    it('拒绝 DOCX 缺失结构或空正文，并按部件等级稳定排序', async () => {
        await expect(parseBinaryDocument('missing-document.docx', await zipBytes({
            '[Content_Types].xml': '<Types/>',
        }))).rejects.toThrow('DOCX 文件结构无效');
        await expect(parseBinaryDocument('empty.docx', await zipBytes({
            '[Content_Types].xml': '<Types/>',
            'word/document.xml': '<w:document><w:body/></w:document>',
        }))).rejects.toThrow('没有找到可翻译的段落文字');

        const paragraph = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
        const parsed = await parseBinaryDocument('parts.docx', await zipBytes({
            '[Content_Types].xml': '<Types/>',
            'word/document.xml': paragraph('Body'),
            'word/header2.xml': paragraph('Header two'),
            'word/header1.xml': paragraph('Header one'),
            'word/footer1.xml': paragraph('Footer'),
            'word/footnotes.xml': paragraph('Footnote'),
            'word/endnotes.xml': paragraph('Endnote'),
        }));
        expect(parsed.binary?.kind === 'docx' && parsed.binary.parts.map(({path}) => path)).toEqual([
            'word/document.xml',
            'word/header1.xml',
            'word/header2.xml',
            'word/footer1.xml',
            'word/footnotes.xml',
            'word/endnotes.xml',
        ]);
    });

    it('PDF 下载在缺少译文时回退原文', async () => {
        const sourcePdf = await PDFDocument.create();
        sourcePdf.addPage([200, 300]);
        const bytes = await sourcePdf.save();
        const document: ParsedDocument = {
            fileName: 'sample.pdf',
            format: 'pdf',
            label: 'PDF 文件',
            parts: [],
            segments: [{id: 0, source: 'Source'}],
            binary: {
                kind: 'pdf',
                bytes,
                pages: [{pageNumber: 1, width: 200, height: 300, segmentIndexes: [0], blocks: []}],
            },
        };
        await expect(createDocumentDownload(document, [], 'translated'))
            .rejects.toThrow('未提供 PDF 页面渲染器');
        const raster = vi.fn(async (input) => {
            expect(input.translations).toEqual(['']);
            return Uint8Array.from(Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=',
                'base64',
            ));
        });

        await expect(createDocumentDownload(document, [], 'translated', {pdfPageRasterizer: raster}))
            .resolves.toMatchObject({fileName: 'sample.translated.pdf'});
        expect(raster).not.toHaveBeenCalled();
    });
});
