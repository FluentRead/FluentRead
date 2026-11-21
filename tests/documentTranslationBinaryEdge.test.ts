import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {parseDocument, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {analyzeDocxInlineParagraph, renderDocxInlineRuns} from '@/src/features/document-translation/core/docxInline';
import {stripDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import {readEpubHeadingTranslations, readEpubNavigation, renderEpubNavigation, resolveEpubNavigationTarget} from '@/src/features/document-translation/core/epubNavigation';
import {pdfLayoutLines, type PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
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

describe('DOCX inline run reconstruction', () => {
    const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
    it('uses one reversible marker for a link and retains named styles, text entities and hard breaks', () => {
        const style = '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>';
        const plan = analyzeDocxInlineParagraph(`<w:p><w:pPr/><w:r/><w:hyperlink w:anchor="appendix"><w:r>${style}<w:t><![CDATA[A > B]]></w:t><w:br w:type="textWrapping"/><w:t>&amp; more</w:t></w:r></w:hyperlink><w:r><w:t> &#x2013; see </w:t><w:tab/></w:r></w:p>`);
        expect(plan).toMatchObject({kind: 'free', source: '<g1>A > B\n& more</g1> – see', prefix: '<w:p><w:pPr/>'});
        if (plan.kind !== 'free') throw new Error('Expected ordinary Word paragraph');
        expect(renderDocxInlineRuns(plan, '另见〈ｇ１〉附录 & 参数〈／ｇ１〉', docxTextNodes, '<w:rPr/>')).toBe(
            '<w:r><w:rPr/><w:t xml:space="preserve">另见</w:t></w:r><w:hyperlink w:anchor="appendix"><w:r>'
            + style + '<w:t xml:space="preserve">附录 &amp; 参数</w:t></w:r></w:hyperlink>',
        );
        expect(stripDocumentInlineMarkers('〈ｇ１〉附录〈／ｇ１〉')).toBe('附录');
        expect(renderDocxInlineRuns(plan, '另见<g1> </g1>', docxTextNodes, '')).toBeUndefined();
        expect(renderDocxInlineRuns(plan, '另见<g1/>', docxTextNodes, '')).toBeUndefined();
    });

    it.each([
        ['<w:p><w:r></w:p>', 'invalid'],
        ['<w:p/><w:p/>', 'invalid'],
        [run('Text'), 'invalid'],
        ['<w:p>direct text</w:p>', 'preserve'],
        ['<w:p><w:hyperlink>direct text</w:hyperlink></w:p>', 'preserve'],
        ['<w:p><w:hyperlink><w:bookmarkStart/></w:hyperlink></w:p>', 'preserve'],
        ['<w:p><w:hyperlink><w:r/></w:hyperlink></w:p>', 'preserve'],
        ['<w:p><w:hyperlink><w:r><w:t> </w:t></w:r></w:hyperlink></w:p>', 'preserve'],
        ['<w:p><w:r>direct text</w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:rPr><w:rPrChange w:id="1"/></w:rPr><w:t>Text</w:t></w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:t><w:r/></w:t></w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:br w:type="page"/></w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:br>text</w:br></w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:tab>text</w:tab></w:r></w:p>', 'preserve'],
        ['<w:p><w:r><w:t>&lt;g1&gt; literal</w:t></w:r></w:p>', 'preserve'],
    ])('preserves unsupported structure in %s', (xml, result) => {
        expect(analyzeDocxInlineParagraph(xml).kind).toBe(result);
    });

    it('keeps uniform and whitespace-only runs, handles a single short plain translation, and supports no-run paragraphs', () => {
        const props = '<w:rPr><w:b/></w:rPr>';
        const styleOnly = analyzeDocxInlineParagraph(`<w:p>\n<w:r>${props}<w:t>Use</w:t></w:r><w:r>${props}<w:t> it</w:t></w:r></w:p>`);
        expect(styleOnly).toMatchObject({kind: 'free', source: 'Use it', properties: props, spans: []});
        if (styleOnly.kind !== 'free') throw new Error('Expected ordinary Word paragraph');
        expect(renderDocxInlineRuns(styleOnly, '使用', docxTextNodes, '')).toBe(`<w:r>${props}${docxTextNodes('使用')}</w:r>`);
        expect(analyzeDocxInlineParagraph(' \n<w:p/>')).toMatchObject({kind: 'free', source: '', spans: []});
        expect(analyzeDocxInlineParagraph(`<w:p>${run('One')}<w:r>${props}<w:t> </w:t></w:r>${run('Two')}</w:p>`)).toMatchObject({kind: 'free', source: 'One Two', spans: []});
        expect(docxTextNodes('字\u0000\u000b \ud800🙂')).toBe('<w:t xml:space="preserve">字 🙂</w:t>');
    });
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

describe('EPUB navigation XML', () => {
    it('reads title, section and inline anchors, and skips unsafe chapter matches', () => {
        const source = '<html xmlns="http://www.w3.org/1999/xhtml"><body><aside id="aside"><p>No heading.</p></aside>' +
            '<section id="start"><svg xmlns="http://www.w3.org/2000/svg"><title>Decoration</title></svg>' +
            '<h1 xml:id="heading"><a name="alias"></a><![CDATA[Reading]]>&nbsp;<img alt="guide"/> <img src="ornament.svg"/></h1>' +
            '<h2 id="heading">Duplicate fragment</h2></section></body></html>';
        const translated = source.replace('Reading', '阅读').replace('alt="guide"', 'alt="指南"');
        expect([...readEpubHeadingTranslations(source, translated)]).toEqual([
            ['', '阅读 指南'], ['start', '阅读 指南'], ['heading', '阅读 指南'], ['alias', '阅读 指南'],
        ]);
        expect([...readEpubHeadingTranslations('<h1>Reading</h1>', '<h1>阅读</h1>')]).toEqual([['', '阅读']]);
        for (const [original, output] of [
            [source, source],
            [source, translated.replace('&nbsp;', '&custom;')],
            [source, '<h1>Only one heading</h1>'],
            ['<p>Body text</p>', '<p>正文</p>'],
        ]) expect(readEpubHeadingTranslations(original, output).size).toBe(0);
    });

    it('edits only mapped labels and keeps the content if the label or navigation structure cannot be matched', () => {
        const source = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:e="http://www.idpf.org/2007/ops"><body><nav e:type="toc"><ol>' +
            '<li><a href="chapter.xhtml" title="A > B"><em id="landing">Title</em></a></li>' +
            '<li><a href="next.xhtml"><![CDATA[下一章]]></a></li><li><a href="third.xhtml"> </a></li>' +
            '<li><a>Without a target</a></li></ol></nav></body></html>';
        const entries = readEpubNavigation(source, 'xhtml')!;
        expect(entries.map(entry => entry.href)).toEqual(['chapter.xhtml', 'next.xhtml', 'third.xhtml', '']);
        const results = ['标题', '下一章', '第三章', undefined];
        const rendered = source.replace('<![CDATA[下一章]]>', '早期校订');
        expect(renderEpubNavigation(source, entries, rendered, 'xhtml', 'translated', results)).toBe(source);
        expect(renderEpubNavigation(source, entries, source, 'xhtml', 'bilingual', results)).toBe(source.replace('</em>', '</em> / 标题'));
        for (const incompatible of [
            rendered.replace('</nav>', ''),
            rendered.replace('href="next.xhtml"', 'href="different.xhtml"'),
            rendered.replace('<li><a>Without a target</a></li>', ''),
        ]) expect(renderEpubNavigation(source, entries, incompatible, 'xhtml', 'translated', results)).toBe(incompatible);
        expect(readEpubNavigation('<html><nav>', 'xhtml')).toBeUndefined();
    });

    it('retains legacy labels with absent destinations and ignores invalid archive links', () => {
        const source = '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint>' +
            '<navLabel><text><![CDATA[Label]]></text></navLabel><content/></navPoint></navMap></ncx>';
        expect(readEpubNavigation(source, 'ncx')?.map(({href, text}) => ({href, text}))).toEqual([{href: '', text: 'Label'}]);
        expect(readEpubNavigation(source.replace('</navPoint>', ''), 'ncx')).toBeUndefined();
        expect(resolveEpubNavigationTarget('Book/nav #1.xhtml', '#notes%3A1')).toEqual({path: 'Book/nav #1.xhtml', fragment: 'notes:1'});
        for (const href of ['', '//example.invalid/page.xhtml', 'htt\nps://example.invalid/page.xhtml', '\\other.xhtml']) {
            expect(resolveEpubNavigationTarget('Book/nav.xhtml', href)).toBeUndefined();
        }
    });

    it('exports EPUB chapters when optional navigation entries are missing or malformed', async () => {
        const brokenNav = '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav></body></html>';
        const book = await parseBinaryDocument('broken-navigation.epub', await zipBytes({
            mimetype: 'application/epub+zip',
            'META-INF/container.xml': '<container><rootfile full-path="book.opf"/></container>',
            'book.opf': `<package><manifest>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
<item id="missing" href="missing.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="broken" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest></package>`,
            'chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1></body></html>',
            'nav.xhtml': brokenNav,
        }));
        const translations = book.segments.map(segment => segment.source === 'Chapter One' ? '第一章' : '');
        const {data} = await createDocumentDownload(book, translations, 'translated');
        const output = await JSZip.loadAsync(data as Uint8Array);
        expect(await output.file('chapter.xhtml')!.async('string')).toContain('<h1>第一章</h1>');
        expect(await output.file('nav.xhtml')!.async('string')).toBe(brokenNav);
        expect(output.file('missing.xhtml')).toBeNull();
    });
});

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

    it.each([NaN, Infinity, -Infinity])('keeps prose visible when PDF.js returns a nonfinite font metric: %s', invalid => {
        const viewport = {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]};
        const atoms = pdfTextAtoms([
            pdfItem({str: 'Use finite descent', fontName: 'descent'}),
            pdfItem({str: 'Fallback for both metrics', fontName: 'both'}),
            pdfItem({str: 'Fallback for descent', fontName: 'missing'}),
            pdfItem({str: 'Keep finite ascent', fontName: 'ascent'}),
        ], {
            descent: {ascent: invalid, descent: -0.25, fontFamily: 'serif'},
            both: {ascent: invalid, descent: invalid},
            missing: {descent: invalid},
            ascent: {ascent: 0.6, descent: invalid},
        }, viewport, true);
        expect(atoms.map(atom => atom.text)).toEqual(['Use finite descent', 'Fallback for both metrics', 'Fallback for descent', 'Keep finite ascent']);
        expect(atoms.map(atom => atom.y)).toEqual([12.5, 12, 12, 14]);
        expect(atoms.every(atom => [atom.x, atom.y, atom.width, atom.height].every(Number.isFinite))).toBe(true);
        expect(atoms[0]).toMatchObject({fontFamily: 'serif', baseline: 20, fontSize: 10});
    });

    it('preserves finite negative descenders and the normal metric precedence', () => {
        const atoms = pdfTextAtoms([
            pdfItem({str: 'Finite descent', fontName: 'descent'}),
            pdfItem({str: 'Ascent takes precedence', fontName: 'ascent'}),
            pdfItem({str: 'Missing metrics', fontName: 'missing'}),
        ], {descent: {descent: -0.35}, ascent: {ascent: 0.7, descent: -0.35}},
        {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]});
        expect(atoms.map(atom => atom.y)).toEqual([13.5, 13, 12]);
    });

    it.each([0, -0.2, undefined, NaN, Infinity, -Infinity])('falls back from an invalid ascent %s without accepting zero or unusable descent', ascent => {
        const descents = [0, .25, -1, -1.5, undefined, NaN, Infinity, -Infinity, -.25];
        const atoms = pdfTextAtoms(descents.map((_, index) => pdfItem({fontName: String(index)})),
            Object.fromEntries(descents.map((descent, index) => [String(index), {ascent, descent}])),
            {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]}, true);
        expect(atoms.map(atom => atom.y)).toEqual([12, 12, 12, 12, 12, 12, 12, 12, 12.5]);
        expect(atoms.every(atom => atom.fontSize === 10 && atom.baseline === 20 && atom.width === 30)).toBe(true);
    });

    it('preserves the small positive ascent of actual mathematical brackets', () => {
        const [atom] = pdfTextAtoms([pdfItem({str: '['})], {body: {ascent: .04, descent: -.6}},
            {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]}, true);
        expect(atom).toMatchObject({y: 19.6, height: 10, baseline: 20, fontSize: 10, width: 30});
    });

    it('covers actual LMRoman body ink when PDF.js reports zero ascent and descent', () => {
        // arXiv 2609.35738 page 1: embedded LMRoman10-Regular reports 0/0 despite
        // visible body glyphs. Independently raster-measured first-line ink spans
        // y=294.662..304.133pt; the old run began at its 302.208pt baseline.
        const item = pdfItem({str: 'A language-model agent is jointly defined by its model and its harness, the executable program',
            transform: [10.0721886, 0, 0, 9.9626, 87.496, 539.682], width: 419.90551385856037, height: 9.9626});
        const [atom] = pdfTextAtoms([item], {body: {ascent: 0, descent: 0, fontFamily: 'sans-serif'}},
            {width: 595.276, height: 841.89, transform: [1, 0, 0, -1, 0, 841.89]}, true);
        const [line] = pdfLayoutLines([atom as PdfLayoutAtom]);
        expect(atom.y).toBeCloseTo(294.23792, 8);
        expect(atom.baseline).toBeCloseTo(302.208, 8);
        expect(atom.fontSize).toBe(9.9626);
        expect(atom.width).toBe(item.width);
        expect(line.y).toBeLessThan(294.662);
        expect(line.y + line.height).toBeGreaterThan(304.133);
        expect(line.runs[0].y).toBe(line.y);
        expect(line.runs[0].height).toBeCloseTo(line.height, 10);
        expect(line.text).toBe(item.str);
    });

    it.runIf(Boolean(process.env.FLUENTREAD_HARNESS_PDF))('parses the local Harness paper with the body ink inside both line and run bounds', async () => {
        const {readFileSync} = await import('node:fs');
        const document = await parseBinaryDocument('2609.35738.pdf', new Uint8Array(readFileSync(process.env.FLUENTREAD_HARNESS_PDF!)));
        if (document.binary?.kind !== 'pdf') throw new Error('Expected a PDF document');
        expect(document.binary.pages).toHaveLength(36);
        const abstract = document.binary.pages[0].blocks.find(block => block.segmentIndex >= 0
            && document.segments[block.segmentIndex].source.startsWith('A language-model agent'));
        expect(abstract).toBeDefined();
        const line = abstract!.lines![0];
        expect(line.y).toBeCloseTo(294.23792, 6);
        expect(line.baseline).toBeCloseTo(302.208, 6);
        expect(abstract!.fontSize).toBeCloseTo(9.9626, 6);
        expect(line.y).toBeLessThan(294.662);
        expect(line.y + line.height).toBeGreaterThan(304.133);
        expect(line.runs![0].y).toBe(line.y);
        expect(line.runs![0].height).toBeCloseTo(line.height, 10);
    }, 30_000);

    it('uses finite negative descent for glyph bounds while preserving font size, baseline and advance', () => {
        const items = [pdfItem({str: 'g', fontName: 'tall'}), pdfItem({str: 'p', fontName: 'short'})];
        const before = items.map(item => ({...item, transform: [...item.transform]}));
        const atoms = pdfTextAtoms(items, {tall: {ascent: .95, descent: -.25}, short: {ascent: .7, descent: -.1}},
            {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]}, true);
        expect(atoms[0]).toMatchObject({x: 10, y: 10.5, width: 30, height: 12, baseline: 20, fontSize: 10});
        // A shorter declared span must not shrink the existing one-em rectangle.
        expect(atoms[1]).toMatchObject({x: 10, y: 13, width: 30, height: 10, baseline: 20, fontSize: 10});
        expect(items).toEqual(before);
        const rotated = pdfTextAtoms([pdfItem({transform: [0, -1, 10, 0, 20, 30]})],
            {body: {ascent: .95, descent: -.25}}, {width: 100, height: 100, transform: [0, 2, -2, 0, 100, 0]}, true);
        expect(rotated[0]).toMatchObject({x: 40, y: 21, width: 30, height: 24, baseline: 40, fontSize: 20});
    });

    it.each([undefined, NaN, Infinity, -Infinity, 0, .25])('keeps the existing rectangle for missing, invalid or nonnegative descent: %s', descent => {
        const [atom] = pdfTextAtoms([pdfItem()], {body: {ascent: .95, descent}},
            {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]}, true);
        expect(atom).toMatchObject({x: 10, y: 10.5, width: 30, height: 10, baseline: 20, fontSize: 10});
    });

    it('covers the actual zero-width variation-selector math glyph without increasing erase padding', () => {
        // Public PDF source page 24: PDF.js reports width=0 for V+VS, while its
        // showText outline extends 7.26pt right; the following subscript begins 6.30307pt right.
        const items = [
            pdfItem({str: 'An equivalence on', width: 101.63610058799995, transform: [11, 0, 0, 11, 407.221760196, 634.4063]}),
            pdfItem({str: ' 𝒱︀', width: 0, transform: [11, 0, 0, 11, 512.8165, 634.4063]}),
            pdfItem({str: ' ', width: 10.261709215999929, height: 0, transform: [11, 0, 0, 11, 508.857860784, 634.4063]}),
            pdfItem({str: '𝑘', width: 4.6739, height: 7.7, transform: [7.7, 0, 0, 7.7, 519.11957, 631.68933]}),
        ];
        const before = items.map(item => ({...item, transform: [...item.transform]}));
        const atoms = pdfTextAtoms(items, {body: {ascent: .806}},
            {width: 595.2756, height: 841.8898, transform: [1, 0, 0, -1, 0, 841.8898]}, true);
        expect(atoms.map(atom => atom.text)).toEqual(['An equivalence on', '𝒱︀', '𝑘']);
        expect(items).toEqual(before);
        const letter = atoms[1], subscript = atoms[2], padding = 1.2;
        expect(letter.width).toBeCloseTo(6.30307, 8);
        // These actual outline points remained visible outside the old 2.2pt rectangle.
        for (const ink of [{x: 520.0765, y: 201.2575}, {x: 518.9325, y: 199.9595}]) {
            expect(ink.x).toBeGreaterThanOrEqual(letter.x - padding);
            expect(ink.x).toBeLessThanOrEqual(letter.x + letter.width + padding);
            expect(ink.y).toBeGreaterThanOrEqual(letter.y - padding);
            expect(ink.y).toBeLessThanOrEqual(letter.y + letter.height + padding);
        }
        expect(letter.x + letter.width + padding).toBeLessThan(520.4);
        expect(subscript).toMatchObject({x: 519.11957, y: 203.99427, width: 4.6739, height: 7.7, baseline: 210.20047});
    });

    it.each([0, -0, NaN, Infinity, -Infinity])('estimates only absent/nonfinite PDF advances: %s', width => {
        const atoms = pdfTextAtoms([pdfItem({str: '𝒱︀', width}),
            pdfItem({str: 'k', width: 4, transform: [1, 0, 0, 7, 16.3, 22.7]})], {},
            {width: 500, height: 500, transform: [1, 0, 0, 1, 0, 0]});
        expect(atoms[0]).toMatchObject({text: '𝒱︀', x: 10, y: 12, height: 10});
        expect(atoms[0].width).toBeCloseTo(6.3, 8);
    });

    it.each([.5, -1, 30, -30])('preserves the previous finite nonzero advance semantics: %s', width => {
        const atoms = pdfTextAtoms([pdfItem({width}), pdfItem({transform: [1, 0, 0, 10, 15, 20]})], {},
            {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]});
        expect(atoms[0].width).toBe(Math.max(2, Math.abs(width)));
    });

    it('uses physical positions for RTL order and keeps raised/rotated neighbours in the same coordinate frame', () => {
        const viewport = {width: 500, height: 500, transform: [1, 0, 0, 1, 0, 0]};
        const rtl = pdfTextAtoms([pdfItem({str: 'right', dir: 'rtl', transform: [1, 0, 0, 10, 116.3, 20]}),
            pdfItem({str: 'ש', dir: 'rtl', width: 0, transform: [1, 0, 0, 10, 110, 20]})], {}, viewport);
        expect(rtl[1]).toMatchObject({text: 'ש', x: 110});
        expect(rtl[1].width).toBeCloseTo(6.3, 8);
        const raised = pdfTextAtoms([pdfItem({str: '𝒱︀', width: 0}),
            pdfItem({str: 'i', height: 7, transform: [1, 0, 0, 7, 16, 14.5]})], {}, viewport);
        expect(raised[0].width).toBe(6);
        const rotated = pdfTextAtoms([pdfItem({str: '𝒱︀', width: 0, transform: [0, -1, 10, 0, 20, 30]}),
            pdfItem({str: 'k', width: 4, transform: [0, -1, 7, 0, 22.7, 23.7]})], {},
            {width: 500, height: 500, transform: [0, 1, -1, 0, 200, 0]}, true);
        expect(rotated[0]).toMatchObject({x: 170, y: 12, height: 10, baseline: 20});
        expect(rotated[0].width).toBeCloseTo(6.3, 8);
        expect(rotated[1]).toMatchObject({x: 176.3, height: 7, baseline: 22.7});
    });

    it('does not borrow another line/column, duplicate origin or invalid/vertical/invisible neighbour', () => {
        const origin = pdfItem({str: '𝒱︀', width: 0});
        const rejected = [
            pdfItem({transform: [1, 0, 0, 10, 400, 20]}),
            pdfItem({transform: [1, 0, 0, 10, 16, 30]}),
            pdfItem({transform: [1, 0, 0, 10, 10, 20]}),
            pdfItem({transform: [1, 0, 0, 10, 10.0000000001, 20]}),
            pdfItem({transform: [1, 0, 0, 10, 11.9, 20]}),
            pdfItem({transform: [1, 0, 0, 10, 12, 20]}),
            pdfItem({transform: [0, 1, -10, 0, 16, 20]}),
            pdfItem({transform: [1, 0, 0, 10]}),
            pdfItem({transform: [1, 0, 0, 10, NaN, 20]}),
            pdfItem({transform: [1, 0, 0, 10, 16, '20']}),
            ...['', '\u0301', '\ufe00', '\u200d', '\u0000', ' \u0301 '].map(str => pdfItem({str, transform: [1, 0, 0, 10, 16, 20]})),
        ];
        for (const neighbour of rejected) {
            expect(pdfTextAtoms([origin, neighbour], {}, {width: 500, height: 500, transform: [1, 0, 0, 1, 0, 0]})[0])
                .toMatchObject({text: '𝒱︀', width: 10});
        }
    });

    it('bounds the neighbour window and allows only real space items to locate the next position', () => {
        const viewport = {width: 500, height: 500, transform: [1, 0, 0, 1, 0, 0]};
        const origin = pdfItem({str: '𝒱︀', width: 0});
        expect(pdfTextAtoms([origin, pdfItem({str: ' ', width: 2, transform: [1, 0, 0, 10, 17, 20]})], {}, viewport)[0].width).toBe(7);
        for (const width of [0, NaN, Infinity]) {
            expect(pdfTextAtoms([origin, pdfItem({str: ' ', width, transform: [1, 0, 0, 10, 17, 20]})], {}, viewport)[0].width).toBe(10);
        }
        const duplicates = Array.from({length: 4}, () => pdfItem({transform: [1, 0, 0, 10, 10, 20]}));
        expect(pdfTextAtoms([origin, ...duplicates, pdfItem({transform: [1, 0, 0, 10, 16, 20]})], {}, viewport)[0].width).toBe(10);
    });

    it('counts base codepoints without normalizing source bytes or enlarging isolated marks', () => {
        const source = ['𝒱︀', 'A\u0301', '\u0301', '\ufe00', '\u200d', '中文'];
        const atoms = pdfTextAtoms(source.map(str => pdfItem({str, width: 0})), {},
            {width: 500, height: 500, transform: [1, 0, 0, 1, 0, 0]});
        expect(atoms.map(atom => atom.text)).toEqual(source);
        expect(atoms.map(atom => atom.width)).toEqual([10, 10, 2, 2, 2, 20]);
    });

    it('将同一行原子按标点、连字符和栏间距组合', () => {
        expect(pdfTextLines([], 300)).toEqual([]);
        expect(pdfTextLines([atom(' \t\u00a0 ',0,10)],300)).toEqual([]);
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

    it('DOCX 部件渲染保留未映射段落并支持译文回退', async () => {
        const source = '<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Keep</w:t></w:r></w:p>';
        const document: ParsedDocument = {
            fileName: 'sample.docx',
            format: 'docx',
            label: 'DOCX 文档',
            parts: [],
            segments: [{id: 0, source: 'One'}],
        };
        const part = {path: 'word/document.xml', source, paragraphSegments: [{paragraphIndex: 0, segmentIndex: 0}]};

        expect(await renderDocxPart(document, part, [], 'translated')).toContain('One');
        expect(await renderDocxPart(document, part, ['译文'], 'bilingual')).toContain('E83B6B');
        expect(await renderDocxPart({...document, segments: []}, part, [], 'translated')).toBe(part.source);
        expect(await renderDocxPart(document, part, ['译文'], 'translated')).toContain('Keep');
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
    it('没有 spine 时只回退到有效正文清单，忽略残缺项目和样式资源',async()=>{
        const parsed=await parseBinaryDocument('fallback.epub',await zipBytes({
            mimetype:'application/epub+zip','META-INF/container.xml':'<rootfile full-path="content.opf"/>',
            'content.opf':'<package><manifest><item href="missing-id.xhtml"/><item id="missing-href"/><item id="style" href="style.css" media-type="text/css"/><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest></package>',
            'style.css':'body {color:red}','body.xhtml':'<html><body><p>Preserved book text.</p></body></html>',
        }));
        expect(parsed.segments.map(value=>value.source)).toEqual(['Preserved book text.']);
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
