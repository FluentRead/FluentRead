import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {describe, expect, it} from 'vitest';

import {
    DOCUMENT_MAX_BYTES,
    PPTX_MAX_BYTES,
    getDocumentAcceptAttribute,
    getDocumentFormat,
    getDocumentFormatLabel,
    getDocumentMaxBytes,
    getDocumentMimeType,
    parseDocument,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';
import {documentSourceLocators} from '@/src/features/document-translation/core/materialLocator';
import {
    isTranslatablePptxText,
    parsePptxPartXml,
    parsePptxPresentationSlides,
    parsePptxSlideNotesTarget,
    renderPptxPartXml,
    resolveOpcTargetPath,
} from '@/src/features/document-translation/core/pptxXml';
import {
    appendXlsxSharedStringsXml,
    isTranslatableXlsxText,
    parseXlsxSharedStrings,
    parseXlsxWorkbookSheets,
    parseXlsxWorksheetXml,
    renderXlsxWorksheetXml,
    resolveXlsxTargetPath,
} from '@/src/features/document-translation/core/xlsxXml';
import {
    createDocumentDownload,
    isBinaryDocumentFormat,
    parseBinaryDocument,
    parseDocumentFile,
} from '@/src/features/document-translation/services/binary';

function assertValidXml(xml: string): void {
    const parser = new SaxesParser({xmlns: false});
    parser.write(xml).close();
}

async function buildZipBytes(entries: Record<string, string | Uint8Array>, storePaths: ReadonlySet<string> = new Set()): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(entries)) {
        zip.file(path, content, storePaths.has(path) ? {compression: 'STORE'} : undefined);
    }
    return zip.generateAsync({type: 'uint8array'});
}

async function buildSamplePptx(): Promise<Uint8Array> {
    const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="3600" b="1"/><a:t>Quarterly Review</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr/></p:nvSpPr>
      <p:txBody>
        <a:p><a:r><a:rPr sz="1800"/><a:t>Revenue grew steadily</a:t></a:r><a:br/><a:r><a:rPr sz="1800"/><a:t>across all regions.</a:t></a:r></a:p>
        <a:p><a:r><a:t>2026.01</a:t></a:r></a:p>
        <a:p><a:r><a:t>https://example.com</a:t></a:r></a:p>
        <a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p>
        <a:p><a:r><a:rPr sz="1400"/><a:t>Slide label </a:t></a:r><a:fld id="{2}" type="slidenum"><a:t>1</a:t></a:fld></a:p>
        <a:p/>
      </p:txBody>
    </p:sp>
    <p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Table Cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;

    const slide1Rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

    const notes1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:rPr sz="1200"/><a:t>Remember to thank the engineering team.</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;

    const slide2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:rPr sz="2800"/><a:t>Large Font Heading</a:t></a:r></a:p>
    <a:p><a:r><a:t>Second slide body</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

    const notes2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Fallback notes for slide two.</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;

    const slide10 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Tenth slide summary</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

    const orphanNotes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Orphan note text</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;

    return buildZipBytes({
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
        'ppt/slides/slide10.xml': slide10,
        'ppt/slides/_rels/slide10.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
        'ppt/slides/slide1.xml': slide1,
        'ppt/slides/_rels/slide1.xml.rels': slide1Rels,
        'ppt/notesSlides/notesSlide1.xml': notes1,
        'ppt/slides/slide2.xml': slide2,
        'ppt/notesSlides/notesSlide2.xml': notes2,
        'ppt/notesSlides/notesSlide99.xml': orphanNotes,
        'ppt/notesSlides/notesSlide98.xml': orphanNotes.replace('Orphan note text', 'Earlier orphan note'),
        'ppt/media/image1.png': new Uint8Array([137, 80, 78, 71]),
    }, new Set(['ppt/media/image1.png']));
}

async function buildSampleXlsx(): Promise<Uint8Array> {
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId2"/>
    <sheet name="Details" sheetId="2" r:id="rId1"/>
    <sheet name="EmptySheet" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
</Relationships>`;

    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="10" uniqueCount="6">
  <si><t>Hello</t></si>
  <si><r><rPr><b/></rPr><t>Rich </t></r><r><t>Title</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si>
  <si><t>https://example.com</t></si>
  <si><t>- Bullet item</t></si>
  <si><t>+15% YoY growth</t></si>
  <si><t>@alice review</t></si>
</sst>`;

    const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" s="1" t="s"><v>0</v></c>
      <c r="B1" s="2" t="s"><v>0</v></c>
      <c r="C1" t="s"><v>1</v></c>
      <c r="D1" t="n"><v>42.5</v></c>
      <c r="E1" t="b"><v>1</v></c>
      <c r="F1" t="s"><v>2</v></c>
      <c r="G1" t="s"><v>3</v></c>
      <c r="H1" t="str"><f>CONCAT(A1,B1)</f><v>HelloHello</v></c>
      <c r="I1" t="s"><f>A1</f><v>0</v></c>
      <c r="J1" t="s"><v>4</v></c>
      <c r="K1" t="s"><v>5</v></c>
    </row>
  </sheetData>
</worksheet>`;

    const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" s="3" t="inlineStr"><is><t>Inline Note</t><rPh sb="0" eb="1"><t>NO</t></rPh></is></c>
      <c r="B1" t="inlineStr"><is><t>12345</t></is></c>
      <c r="C1" t="s"><v>0</v></c>
    </row>
  </sheetData>
</worksheet>`;

    const sheet3 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>100</v></c></row></sheetData></worksheet>`;

    return buildZipBytes({
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'xl/workbook.xml': workbook,
        'xl/_rels/workbook.xml.rels': rels,
        'xl/sharedStrings.xml': sharedStrings,
        'xl/worksheets/sheet1.xml': sheet1,
        'xl/worksheets/sheet2.xml': sheet2,
        'xl/worksheets/sheet3.xml': sheet3,
    });
}

describe('PowerPoint (.pptx) and Excel (.xlsx) document translation', () => {
    it('registers format metadata, accept attribute, MIME types, and size limits for pptx and xlsx', () => {
        expect(getDocumentFormat('deck.PPTX')).toBe('pptx');
        expect(getDocumentFormat('report.XLSX')).toBe('xlsx');
        expect(getDocumentFormatLabel('pptx')).toBe('PPTX 演示文稿');
        expect(getDocumentFormatLabel('xlsx')).toBe('XLSX 电子表格');
        expect(getDocumentMimeType('pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
        expect(getDocumentMimeType('xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(getDocumentMaxBytes('deck.pptx')).toBe(PPTX_MAX_BYTES);
        expect(getDocumentMaxBytes('report.xlsx')).toBe(DOCUMENT_MAX_BYTES);
        expect(getDocumentAcceptAttribute()).toContain('.pptx');
        expect(getDocumentAcceptAttribute()).toContain('.xlsx');
        expect(isBinaryDocumentFormat('pptx')).toBe(true);
        expect(isBinaryDocumentFormat('xlsx')).toBe(true);
        expect(() => parseDocument('deck.pptx', '')).toThrow('需要按二进制文件解析');
        expect(() => parseDocument('report.xlsx', '')).toThrow('需要按二进制文件解析');
    });

    it('parses slides numerically with speaker notes, preserves formatting/fields, and round-trips bilingual & translated PPTX', async () => {
        const bytes = await buildSamplePptx();
        const parsed = await parseBinaryDocument('deck.pptx', bytes);

        expect(parsed.format).toBe('pptx');
        expect(parsed.binary?.kind).toBe('pptx');
        expect(parsed.segments.map(s => [s.contextLabel, s.pathLabel, s.role, s.source])).toEqual([
            ['Slide 1', 'Slide 1', 'heading', 'Quarterly Review'],
            [undefined, 'Slide 1', 'paragraph', 'Revenue grew steadily\nacross all regions.'],
            [undefined, 'Slide 1', 'paragraph', 'Slide label'],
            [undefined, 'Slide 1', 'paragraph', 'Table Cell'],
            ['Slide 1 Notes', 'Slide 1 Notes', 'paragraph', 'Remember to thank the engineering team.'],
            ['Slide 2', 'Slide 2', 'heading', 'Large Font Heading'],
            [undefined, 'Slide 2', 'paragraph', 'Second slide body'],
            ['Slide 2 Notes', 'Slide 2 Notes', 'paragraph', 'Fallback notes for slide two.'],
            ['Slide 10', 'Slide 10', 'paragraph', 'Tenth slide summary'],
            ['Slide 98 Notes', 'Slide 98 Notes', 'paragraph', 'Earlier orphan note'],
            ['Slide 99 Notes', 'Slide 99 Notes', 'paragraph', 'Orphan note text'],
        ]);

        const translations = [
            '季度回顾',
            '收入稳步增长\n覆盖所有地区。',
            '幻灯片标签',
            '表格单元格',
            '记得感谢工程团队。',
            '大字号标题',
            '第二页正文',
            '第二页回退备注。',
            '第十页总结',
            '更早独立备注',
            '独立备注文字',
        ];

        const bilingual = await createDocumentDownload(parsed, translations, 'bilingual');
        expect(bilingual.fileName).toBe('deck.bilingual.pptx');
        expect(bilingual.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
        const biZip = await JSZip.loadAsync(bilingual.data as Uint8Array);
        const biSlide1 = await biZip.file('ppt/slides/slide1.xml')!.async('string');
        assertValidXml(biSlide1);
        expect(biSlide1).toContain('Quarterly Review');
        expect(biSlide1).toContain('季度回顾');
        expect(biSlide1).toContain('sz="3600"');
        expect(biSlide1).toContain('<a:br/>');
        expect(biSlide1).toContain('<a:fld id="{1}" type="slidenum">');
        expect(biSlide1).toContain('2026.01');
        expect(biSlide1).toContain('https://example.com');
        const biReparsed = await parseBinaryDocument('deck.bilingual.pptx', bilingual.data as Uint8Array);
        expect(biReparsed.segments.some(s => s.source === '季度回顾')).toBe(true);
        expect(biReparsed.segments.some(s => s.source === 'Quarterly Review')).toBe(true);

        const translatedOnly = await createDocumentDownload(parsed, translations, 'translated');
        expect(translatedOnly.fileName).toBe('deck.translated.pptx');
        const trZip = await JSZip.loadAsync(translatedOnly.data as Uint8Array);
        const trSlide1 = await trZip.file('ppt/slides/slide1.xml')!.async('string');
        assertValidXml(trSlide1);
        expect(trSlide1).not.toContain('Quarterly Review');
        expect(trSlide1).toContain('季度回顾');
        expect(trSlide1).toContain('<a:fld id="{2}" type="slidenum"><a:t>1</a:t></a:fld>');
        const trNotes1 = await trZip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
        assertValidXml(trNotes1);
        expect(trNotes1).toContain('记得感谢工程团队。');
        expect(trNotes1).not.toContain('Remember to thank');

        // Material locators for PPTX
        const locators = documentSourceLocators(parsed);
        expect(locators[0]?.scope).toBe('pptx:ppt/slides/slide1.xml');
        expect(locators[0]?.position).toBe('paragraph:0');
    });

    it('handles PPTX errors, empty slides, cancellation, and XML helper edge cases', async () => {
        await expect(parseBinaryDocument('bad.pptx', new Uint8Array([1, 2, 3]))).rejects.toThrow('PPTX 解析失败');
        const noTypes = await buildZipBytes({'ppt/presentation.xml': '<p:presentation/>'});
        await expect(parseBinaryDocument('invalid.pptx', noTypes)).rejects.toThrow('PPTX 文件结构无效');
        const emptySlide = await buildZipBytes({
            '[Content_Types].xml': '<Types/>',
            'ppt/presentation.xml': '<p:presentation/>',
            'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>12345</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        });
        await expect(parseBinaryDocument('empty.pptx', emptySlide)).rejects.toThrow('PPTX 中没有找到可翻译的幻灯片文字');

        // Abort during parse & download
        const controller = new AbortController();
        controller.abort(new Error('canceled pptx'));
        await expect(parseBinaryDocument('deck.pptx', await buildSamplePptx(), {signal: controller.signal})).rejects.toThrow('canceled pptx');

        // Invalid binary kind on download
        const fakePptx: ParsedDocument = {fileName: 'x.pptx', format: 'pptx', label: 'PPTX', parts: [], segments: [{id: 0, source: 'Hi'}]};
        await expect(createDocumentDownload(fakePptx, ['你好'], 'translated')).rejects.toThrow('PPTX 文档状态无效');

        // Direct unit edge cases for pptxXml
        expect(isTranslatablePptxText('v1.2.3')).toBe(false);
        expect(isTranslatablePptxText('user@example.com')).toBe(false);
        expect(parsePptxSlideNotesTarget('<bad xml')).toBeUndefined();
        expect(parsePptxSlideNotesTarget('<Relationships><Relationship Id="r1"/><Relationship Id="r2" Type="http://other" Target="x.xml"/></Relationships>')).toBeUndefined();
        expect(parsePptxPartXml('<a:p><a:extLst/><a:r><a:rPr sz="bad"/></a:r><a:r><a:t/></a:r></a:p><a:p><unclosed></a:p>', 'slide')).toEqual([]);
        // Unchanged / missing translation / invalid XML paragraph on render
        expect(renderPptxPartXml('<a:p><a:r><a:t>Hello</a:t></a:r></a:p>', [{paragraphIndex: 0, segmentIndex: 0}], [{source: 'Hello'}], [], 'translated')).toBe('<a:p><a:r><a:t>Hello</a:t></a:r></a:p>');
        expect(renderPptxPartXml('<a:p><a:r><a:t>Hello</a:t></a:r></a:p>', [{paragraphIndex: 0, segmentIndex: 0}], [{source: 'Hello'}], ['Hello'], 'translated')).toBe('<a:p><a:r><a:t>Hello</a:t></a:r></a:p>');
        expect(renderPptxPartXml('<a:p><bad></a:p>', [{paragraphIndex: 0, segmentIndex: 0}], [{source: 'Hello'}], ['你好'], 'translated')).toBe('<a:p><bad></a:p>');
        // Slide rels pointing to missing notes file does not crash
        const missingNotes = await buildZipBytes({
            '[Content_Types].xml': '<Types/>',
            'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
            'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/missing.xml"/></Relationships>',
        });
        expect((await parseBinaryDocument('ok.pptx', missingNotes)).segments).toHaveLength(1);

        // Root-relative OPC notes target (/ppt/notesSlides/...), mixed-case slide basename rels, custom slide filename without rels, presentation.xml sldIdLst ordering, and bilingual bullet suppression
        const orderedDeck = await buildZipBytes({
            '[Content_Types].xml': '<Types/>',
            'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>',
            'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/Slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/intro.xml"/></Relationships>',
            'ppt/slides/Slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:pPr lvl="0"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>Numbered item</a:t></a:r></a:p><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Bulleted item</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
            'ppt/slides/_rels/Slide1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="/ppt/notesSlides/notesSlide1.xml"/></Relationships>',
            'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Root relative note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
            'ppt/slides/slide2.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Ordered first slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
            'ppt/slides/intro.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Custom named slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        });
        const parsedOrdered = await parseBinaryDocument('ordered.pptx', orderedDeck);
        expect(parsedOrdered.segments.map(s => [s.contextLabel, s.source])).toEqual([
            ['Slide 1', 'Ordered first slide'],
            ['Slide 2', 'Numbered item'],
            [undefined, 'Bulleted item'],
            ['Slide 2 Notes', 'Root relative note'],
            ['Slide 3', 'Custom named slide'],
        ]);
        const biOrdered = await createDocumentDownload(parsedOrdered, ['第一张排序幻灯片', '编号条目', '圆点条目', '根路径备注', '自定义命名幻灯片'], 'bilingual');
        const biOrderedZip = await JSZip.loadAsync(biOrdered.data as Uint8Array);
        const biOrderedSlide1 = await biOrderedZip.file('ppt/slides/Slide1.xml')!.async('string');
        assertValidXml(biOrderedSlide1);
        // Original paragraphs keep bullets; appended bilingual paragraphs replace buAutoNum/buChar with buNone
        expect(biOrderedSlide1.match(/<a:buAutoNum\b/gu)).toHaveLength(1);
        expect(biOrderedSlide1.match(/<a:buChar\b/gu)).toHaveLength(1);
        expect(biOrderedSlide1.match(/<a:buNone\/>/gu)).toHaveLength(2);

        // Direct unit edge cases for resolveOpcTargetPath & parsePptxPresentationSlides
        expect(resolveOpcTargetPath('presentation.xml', 'slides/./slide1.xml#frag')).toBe('slides/slide1.xml');
        expect(parsePptxPresentationSlides('<p:presentation><p:sldIdLst><p:sldId/><p:sldId r:id="r1"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>', '<Relationships><Relationship Id="r1" Target="/ppt/slides/slide1.xml"/></Relationships>', ['ppt/slides/slide1.xml']))
            .toEqual([{path: 'ppt/slides/slide1.xml', slideNumber: 1}]);
        expect(parsePptxPresentationSlides('<bad', '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>', ['ppt/slides/slide1.xml']))
            .toEqual([{path: 'ppt/slides/slide1.xml', slideNumber: 1}]);
        expect(parsePptxPresentationSlides('<p:presentation/>', '<bad', ['ppt/slides/slide1.xml']))
            .toEqual([{path: 'ppt/slides/slide1.xml', slideNumber: 1}]);
    });

    it('parses multi-sheet XLSX in workbook order, preserves formulas & shared strings, deduplicates appended strings, and round-trips cleanly', async () => {
        const bytes = await buildSampleXlsx();
        const parsed = await parseDocumentFile({
            name: 'budget.xlsx',
            size: bytes.byteLength,
            text: async () => '',
            arrayBuffer: async () => bytes.slice().buffer,
        });

        expect(parsed.format).toBe('xlsx');
        expect(parsed.binary?.kind).toBe('xlsx');
        expect(parsed.segments.map(s => [s.contextLabel, s.source])).toEqual([
            ['Summary!A1', 'Hello'],
            ['Summary!B1', 'Hello'],
            ['Summary!C1', 'Rich Title'],
            ['Summary!G1', '- Bullet item'],
            ['Summary!J1', '+15% YoY growth'],
            ['Summary!K1', '@alice review'],
            ['Details!A1', 'Inline Note'],
            ['Details!C1', 'Hello'],
        ]);

        // Translate A1 and Details!C1 to same string (tests deduplication), B1 left untranslated (must keep original sharedIndex 0!), preserve legitimate -/+/@ text cells, and keep sst/@count uninflated (10 >= 8)
        const translations = ['你好', '', '富文本标题', '- 项目要点', '+15% 同比增长', '@alice 复核', '行内备注', '你好'];
        const translated = await createDocumentDownload(parsed, translations, 'translated');
        expect(translated.fileName).toBe('budget.translated.xlsx');
        expect(translated.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        const trZip = await JSZip.loadAsync(translated.data as Uint8Array);
        const trSharedXml = await trZip.file('xl/sharedStrings.xml')!.async('string');
        assertValidXml(trSharedXml);
        const trShared = parseXlsxSharedStrings(trSharedXml);
        // Original 6 entries preserved at 0..5; 5 unique new strings appended ('你好' deduplicated + 4 others)
        expect(trShared).toEqual([
            'Hello', 'Rich Title', 'https://example.com', '- Bullet item', '+15% YoY growth', '@alice review',
            '你好', '富文本标题', '- 项目要点', '+15% 同比增长', '@alice 复核',
        ]);
        expect(trSharedXml).toContain('uniqueCount="11"');
        // count was 10, uniqueCount grew to 11 so count raises only to uniqueCount floor 11 (not inflated to 15!)
        expect(trSharedXml).toContain('count="11"');

        // Verify sst/@count is NOT inflated when original count already exceeds newUniqueCount
        expect(appendXlsxSharedStringsXml('<sst count="50" uniqueCount="2"><si><t>A</t></si><si><t>B</t></si></sst>', ['C'], 2))
            .toContain('count="50" uniqueCount="3"');
        expect(isTranslatableXlsxText('- Note')).toBe(true);
        expect(isTranslatableXlsxText('+15% growth')).toBe(true);
        expect(isTranslatableXlsxText('@handle check')).toBe(true);

        const trSheet1 = await trZip.file('xl/worksheets/sheet1.xml')!.async('string');
        assertValidXml(trSheet1);
        // A1 updated to new shared index 6, B1 STILL points to original 0, formula cells untouched!
        expect(trSheet1).toContain('<c r="A1" s="1" t="s"><v>6</v></c>');
        expect(trSheet1).toContain('<c r="B1" s="2" t="s"><v>0</v></c>');
        expect(trSheet1).toContain('<c r="C1" t="s"><v>7</v></c>');
        expect(trSheet1).toContain('<c r="H1" t="str"><f>CONCAT(A1,B1)</f><v>HelloHello</v></c>');
        expect(trSheet1).toContain('<c r="I1" t="s"><f>A1</f><v>0</v></c>');

        const trSheet2 = await trZip.file('xl/worksheets/sheet2.xml')!.async('string');
        assertValidXml(trSheet2);
        expect(trSheet2).toContain('<c r="A1" s="3" t="inlineStr"><is><t xml:space="preserve">行内备注</t></is></c>');
        expect(trSheet2).toContain('<c r="C1" t="s"><v>6</v></c>');

        // Round-trip re-parse
        const trReparsed = await parseBinaryDocument('budget.translated.xlsx', translated.data as Uint8Array);
        expect(trReparsed.segments.map(s => [s.contextLabel, s.source])).toEqual([
            ['Summary!A1', '你好'],
            ['Summary!B1', 'Hello'],
            ['Summary!C1', '富文本标题'],
            ['Summary!G1', '- 项目要点'],
            ['Summary!J1', '+15% 同比增长'],
            ['Summary!K1', '@alice 复核'],
            ['Details!A1', '行内备注'],
            ['Details!C1', '你好'],
        ]);

        // Bilingual mode puts original + \n + translation
        const bilingual = await createDocumentDownload(parsed, ['你好', '您好', '富文本标题', '', '', '', '行内备注', ''], 'bilingual');
        const biReparsed = await parseBinaryDocument('budget.bilingual.xlsx', bilingual.data as Uint8Array);
        expect(biReparsed.segments.map(s => [s.contextLabel, s.source])).toEqual([
            ['Summary!A1', 'Hello\n你好'],
            ['Summary!B1', 'Hello\n您好'],
            ['Summary!C1', 'Rich Title\n富文本标题'],
            ['Summary!G1', '- Bullet item'],
            ['Summary!J1', '+15% YoY growth'],
            ['Summary!K1', '@alice review'],
            ['Details!A1', 'Inline Note\n行内备注'],
            ['Details!C1', 'Hello'],
        ]);

        // Untranslated XLSX export preserves all sheets & sharedStrings untouched
        const unchanged = await createDocumentDownload(parsed, [], 'translated');
        expect((await parseBinaryDocument('unchanged.xlsx', unchanged.data as Uint8Array)).segments.map(s => s.source))
            .toEqual(parsed.segments.map(s => s.source));

        // Material locators for XLSX
        const locators = documentSourceLocators(parsed);
        expect(locators[0]?.scope).toBe('xlsx:xl/worksheets/sheet1.xml');
        expect(locators[0]?.position).toBe('cell:A1');
    });

    it('handles XLSX fallback sheet discovery, inline-only workbooks, errors, cancellation, and XML edge cases', async () => {
        // Inline-only workbook without workbook.xml or sharedStrings.xml
        const inlineOnly = await buildZipBytes({
            '[Content_Types].xml': '<Types/>',
            'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second Sheet</t></is></c></row></sheetData></worksheet>',
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>First Sheet</t></is></c></row></sheetData></worksheet>',
        });
        const parsedInline = await parseBinaryDocument('inline.xlsx', inlineOnly);
        expect(parsedInline.segments.map(s => [s.contextLabel, s.source])).toEqual([
            ['Sheet 1!A1', 'First Sheet'],
            ['Sheet 2!A1', 'Second Sheet'],
        ]);
        const inlineExport = await createDocumentDownload(parsedInline, ['第一张表', '第二张表'], 'translated');
        expect((await parseBinaryDocument('inline.translated.xlsx', inlineExport.data as Uint8Array)).segments.map(s => s.source))
            .toEqual(['第一张表', '第二张表']);

        // Errors & cancellation
        await expect(parseBinaryDocument('bad.xlsx', new Uint8Array([1, 2, 3]))).rejects.toThrow('XLSX 解析失败');
        await expect(parseBinaryDocument('bad.txt', new Uint8Array([1, 2, 3]))).rejects.toThrow('该文件不是 PDF、ePub、DOCX、PPTX 或 XLSX 二进制文档');
        const noTypes = await buildZipBytes({'xl/workbook.xml': '<workbook/>'});
        await expect(parseBinaryDocument('invalid.xlsx', noTypes)).rejects.toThrow('XLSX 文件结构无效');
        const emptySheet = await buildZipBytes({
            '[Content_Types].xml': '<Types/>',
            'xl/workbook.xml': '<workbook><sheets><sheet name="" sheetId="1" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>123</v></c></row></sheetData></worksheet>',
        });
        await expect(parseBinaryDocument('empty.xlsx', emptySheet)).rejects.toThrow('XLSX 中没有找到可翻译的单元格文字');

        const controller = new AbortController();
        controller.abort(new Error('canceled xlsx'));
        await expect(parseBinaryDocument('budget.xlsx', await buildSampleXlsx(), {signal: controller.signal})).rejects.toThrow('canceled xlsx');

        const fakeXlsx: ParsedDocument = {fileName: 'x.xlsx', format: 'xlsx', label: 'XLSX', parts: [], segments: [{id: 0, source: 'Hi'}]};
        await expect(createDocumentDownload(fakeXlsx, ['你好'], 'translated')).rejects.toThrow('XLSX 文档状态无效');

        // Direct unit edge cases for xlsxXml
        expect(resolveXlsxTargetPath('workbook.xml', '../xl/./worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
        expect(parseXlsxWorkbookSheets('<workbook><sheets><sheet id="r1"/><sheet name="NoId"/><sheet name="Missing" r:id="r2"/></sheets></workbook>', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>', ['xl/worksheets/sheet1.xml']))
            .toEqual([{name: 'Sheet 1', path: 'xl/worksheets/sheet1.xml'}]);
        expect(parseXlsxWorkbookSheets('<bad', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>', ['xl/worksheets/sheet1.xml']))
            .toEqual([{name: 'Sheet 1', path: 'xl/worksheets/sheet1.xml'}]);
        expect(parseXlsxWorkbookSheets('<bad', '<bad', ['xl/worksheets/sheet1.xml']))
            .toEqual([{name: 'Sheet 1', path: 'xl/worksheets/sheet1.xml'}]);
        expect(parseXlsxSharedStrings('<bad')).toEqual([]);
        expect(parseXlsxWorksheetXml('<bad', [])).toEqual([]);
        expect(parseXlsxWorksheetXml('<worksheet><sheetData><row><c t="s"><v>0</v></c><c r="A1" t="s"><v>99</v></c><c r="B1" t="s"><v>NaN</v></c></row></sheetData></worksheet>', ['Hi'])).toEqual([]);
        expect(renderXlsxWorksheetXml('<bad', [{cellRef: 'A1', kind: 'inline', segmentIndex: 0}], [{source: 'Hi'}], ['你好'], [], 'translated', () => 0)).toBe('<bad');
        expect(renderXlsxWorksheetXml('<worksheet><sheetData><row><c t="s"><v>0</v></c><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>', [{cellRef: 'A1', kind: 'shared', sharedIndex: 0, segmentIndex: 0}], [{source: 'Hi'}], [], ['Hi'], 'translated', () => 1))
            .toContain('<v>0</v>');
        expect(renderXlsxWorksheetXml('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>', [{cellRef: 'A1', kind: 'shared', sharedIndex: 99, segmentIndex: 0}], [{source: 'Fallback'}], ['回退'], [], 'bilingual', () => 1))
            .toContain('<v>1</v>');
        expect(appendXlsxSharedStringsXml('<sst/>', [], 0)).toBe('<sst/>');
        expect(appendXlsxSharedStringsXml('<sst/>', ['A & B'], 0)).toBe('<sst uniqueCount="1" count="1"><si><t xml:space="preserve">A &amp; B</t></si></sst>');
        expect(appendXlsxSharedStringsXml('<sst><si><t>Old</t></si></sst>', ['New'], 1)).toBe('<sst uniqueCount="2" count="2"><si><t>Old</t></si><si><t xml:space="preserve">New</t></si></sst>');
        expect(appendXlsxSharedStringsXml('<other/>', ['New'], 0)).toBe('<other/>');
        expect(appendXlsxSharedStringsXml('<sst><si><t>Unclosed', ['New'], 1)).toBe('<sst><si><t>Unclosed');

        // Defensive materialLocator checks for invalid pptx/xlsx snapshots
        expect(documentSourceLocators({
            format: 'pptx',
            segments: [{id: 0, source: 'A'}],
            binary: {kind: 'pptx', bytes: new Uint8Array(), parts: [null as any, {path: 'p', source: '', kind: 'slide', slideNumber: 1, paragraphSegments: [null as any, {paragraphIndex: -1, segmentIndex: 0}]}]},
        })[0]?.scope).toBeUndefined();
        expect(documentSourceLocators({
            format: 'xlsx',
            segments: [{id: 0, source: 'A'}],
            binary: {kind: 'xlsx', bytes: new Uint8Array(), sheets: [null as any, {name: 'S', path: 's', source: '', cellSegments: [null as any, {cellRef: '', kind: 'inline', segmentIndex: 0}]}]},
        })[0]?.scope).toBeUndefined();
    });
});
