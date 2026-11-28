import {describe, expect, it} from 'vitest';
import {parseHTML} from 'linkedom';
import {parseDocument, renderDocument} from '../src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '../src/features/document-translation/core/preview';

describe('document preview protected inline content', () => {
    it('does not mistake literal NUL numbers for its protected code token in Markdown', () => {
        const source = 'Keep \u00000\u0000 and `code`.';
        const output = createDocumentPreviewHtml(parseDocument('source.md', source), [], 'source');
        expect(output).toContain('Keep \u00000\u0000 and <code>code</code>.');
        expect(output.match(/<code>code<\/code>/gu)).toHaveLength(1);
    });
    it('preserves literal NUL numbers without introducing undefined text', () => {
        const source = 'Value \u0000999\u0000 stays literal.';
        expect(createDocumentPreviewHtml(parseDocument('source.txt', source), [], 'source')).toContain(source);
    });
    it('preserves plain text markdown-like characters verbatim in TXT previews', () => {
        const source = 'Keep *asterisks*, _underscores_, `backticks`, and [text](https://example.com) literally.';
        const output = createDocumentPreviewHtml(parseDocument('notes.txt', source), [], 'source');
        const {document} = parseHTML(output);
        expect(document.querySelector('.reader-source')?.textContent).toBe(source);
        expect(document.querySelector('em, strong, code, a')).toBeNull();
    });
    it('keeps translated protected code, safe links, images, soft breaks and markup escaped in Markdown', () => {
        const parsed = parseDocument('source.md', 'Source');
        const output = createDocumentPreviewHtml(parsed, ['\u00000\u0000 `safe <code>` [link](https://example.com) ![](image.png)\n<script>bad</script>'], 'translated');
        expect(output).toContain('\u00000\u0000 <code>safe &lt;code&gt;</code> <a class="reader-link" href="https://example.com" target="_blank" rel="noopener noreferrer">link</a> <span class="reader-link">[image]</span><br>&lt;script&gt;bad&lt;/script&gt;');
        expect(output).not.toContain('<script>');
    });
    it('does not corrupt URLs or image alt text containing underscores, asterisks, or tildes', () => {
        const md = '[init](https://github.com/org/repo/__init__.py) and [glob](https://x.com/a*b*c~d~) and ![__alt__](data:image/png;base64,AA__BB==)';
        const output = createDocumentPreviewHtml(parseDocument('urls.md', md), [], 'source');
        const {document} = parseHTML(output);
        const links = Array.from(document.querySelectorAll('a.reader-link'));
        expect(links.map((a) => a.getAttribute('href'))).toEqual([
            'https://github.com/org/repo/__init__.py',
            'https://x.com/a*b*c~d~',
        ]);
        const img = document.querySelector('img.reader-inline-image')!;
        expect(img.getAttribute('src')).toBe('data:image/png;base64,AA__BB==');
        expect(img.getAttribute('alt')).toBe('__alt__');
        expect(document.querySelector('strong, em, del')).toBeNull();
    });
    it('renders emphasis around protected code and plain text in order in Markdown', () => {
        const output = createDocumentPreviewHtml(parseDocument('source.md', 'A **bold** `code` *em* __strong__ _under_ ~~gone~~ snake_case'), [], 'source');
        expect(output).toContain('A <strong>bold</strong> <code>code</code> <em>em</em> <strong>strong</strong> <em>under</em> <del>gone</del> snake_case');
    });
    it('preserves emphasis spanning a protected code or link without interpreting their markers', () => {
        const output = createDocumentPreviewHtml(parseDocument('source.md', '**A `*literal*` and [__label__](https://example.com)**'), [], 'source');
        const {document} = parseHTML(output);
        const strong = document.querySelector('.reader-source > strong')!;
        expect(strong.textContent).toBe('A *literal* and __label__');
        expect(strong.querySelector('code')?.textContent).toBe('*literal*');
        expect(strong.querySelector('.reader-link')?.textContent).toBe('__label__');
        expect(strong.querySelector('em')).toBeNull();
        expect(strong.querySelector('.reader-link strong')).toBeNull();
    });
    it('keeps a balanced parenthesized URL within its link rather than showing a stray closing marker', () => {
        const output = createDocumentPreviewHtml(parseDocument('source.md', '[entry](https://example.com/wiki/Some_(entry))'), [], 'source');
        const {document} = parseHTML(output);
        const link = document.querySelector('.reader-source > a.reader-link')!;
        expect(link.textContent).toBe('entry');
        expect(link.getAttribute('href')).toBe('https://example.com/wiki/Some_(entry)');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });
    it.each(['![', '[a](https://', '[a](https://(', '[a](https://)'])('keeps repeated incomplete markers readable: %s', marker => {
        const source = marker.repeat(4000);
        const output = createDocumentPreviewHtml(parseDocument('source.md', source), [], 'source');
        expect(output).toContain(source);
    });
    it.each(['source', 'bilingual', 'translated'] as const)('uses parser-owned quote and list code blocks in %s preview', mode => {
        const source = '> ```js\n> const value = "<safe>";\n> ```\n\n- ```txt\n  *code*\n  ```\n\nReadable text';
        const parsed = parseDocument('containers.md', source);
        const {document} = parseHTML(createDocumentPreviewHtml(parsed, ['可读文字'], mode));
        expect(Array.from(document.querySelectorAll('pre code')).map(code => code.textContent)).toEqual(['const value = "<safe>";', '*code*']);
        expect(document.querySelector('pre em')).toBeNull(); expect(document.querySelector('pre safe')).toBeNull();
        expect(document.querySelector('pre .fluentread-translation')).toBeNull();
        expect(document.querySelectorAll('pre')).toHaveLength(2);
        expect(document.querySelector('article')?.textContent).not.toContain('```');
        expect(document.querySelector('article')?.textContent).toContain(mode === 'source' ? 'Readable text' : '可读文字');
    });
    it('resumes normal rendering when an unclosed fenced block leaves its container', () => {
        const source = '> ```js\n> *literal*\nOutside paragraph\n\n- ~~~\n  > code symbol\n- Next item';
        const {document} = parseHTML(createDocumentPreviewHtml(parseDocument('exit.md', source), ['外部段落', '- 下一个项目'], 'bilingual'));
        expect(Array.from(document.querySelectorAll('pre code')).map(code => code.textContent)).toEqual(['*literal*', '> code symbol']);
        expect(document.querySelector('pre em')).toBeNull();
        expect(document.querySelector('.reader-unit.paragraph .reader-translation')?.textContent).toBe('外部段落');
        expect(document.querySelector('.reader-unit.list-item .reader-translation')?.textContent).toBe('下一个项目');
    });
    it('shows empty and EOF-open code blocks without copying their fence syntax', () => {
        const source = '```\n```\n\n> ~~~txt\n>   keep indentation\n> ~~~~ trailing text';
        const {document} = parseHTML(createDocumentPreviewHtml(parseDocument('open.md', source), [], 'source'));
        expect(Array.from(document.querySelectorAll('pre code')).map(code => code.textContent)).toEqual(['', '  keep indentation\n~~~~ trailing text']);
    });
    it('uses nested container prefixes consistently for readable headings and list items', () => {
        const source = '> # A heading\n> - An item\n> > A quote';
        const {document} = parseHTML(createDocumentPreviewHtml(parseDocument('nested.md', source), [], 'source'));
        expect(document.querySelector('.reader-unit.heading h1')?.textContent).toBe('A heading');
        expect(document.querySelector('.reader-unit.list-item p')?.textContent).toBe('An item');
        expect(document.querySelector('.reader-unit.quote blockquote')?.textContent).toBe('A quote');
    });
    it('uses the shared parser when an older constructed model lacks code metadata', () => {
        const parsed = parseDocument('legacy.md', '> ```js\n> const legacy = true;\n> ```\n\nAfter code');
        delete parsed.markdownCodeBlocks;
        const {document} = parseHTML(createDocumentPreviewHtml(parsed, [], 'source'));
        expect(document.querySelector('pre code')?.textContent).toBe('const legacy = true;');
        expect(document.querySelector('.reader-unit.paragraph')?.textContent).toBe('After code');
        expect(parsed.markdownCodeBlocks).toBeUndefined();
    });
    it.each(['txt', 'md', 'html'])('does not read unused translations for a %s source preview', extension => {
        const translations = new Proxy([] as string[], {get() {throw new Error('unused translations were read');}});
        const output = createDocumentPreviewHtml(parseDocument(`source.${extension}`, 'Source text'), translations, 'source');
        expect(output).toContain('Source text');
    });
    it.each([
        '<div title="<html>">Readable</div>',
        '<!-- <html><head> --><article>Readable</article>',
        '<html><!-- <head> --><body>Readable</body></html>',
        '<html data-template="<head>"><body>Readable</body></html>',
        '<!-- lead -->\n<html>\n<!-- before head -->\n<head><title>Original</title></head><body>Readable</body></html>',
        '<html><head data-note="1 > 0"><title>Original</title></head><body>Readable</body></html>',
    ])('puts its reader metadata in the actual head for %s', source => {
        const {document} = parseHTML(createDocumentPreviewHtml(parseDocument('source.html', source), [], 'source'));
        expect(document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
        expect(document.head.querySelector('style')?.textContent).toContain('reader-unit');
        expect(document.body.textContent).toContain('Readable');
        if (source.includes('<title>Original</title>')) expect(document.head.querySelector('title')?.textContent).toBe('Original');
    });
    it.each(['<!-- unfinished <html>', '<html title="unterminated'])('keeps reader metadata before incomplete HTML: %s', source => {
        const {document} = parseHTML(createDocumentPreviewHtml(parseDocument('source.html', source), [], 'source'));
        expect(document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    });
});

describe('document preview HTML5 shell', () => {
    const root = '<html lang="zh-CN" data-reader-root="true"><head><title>Original</title></head><body><p>Readable</p></body></html>';
    const fixtures = [
        {label: 'full HTML without doctype', source: root, fullRoot: true},
        {label: 'full HTML with HTML5 doctype', source: `<!DOCTYPE html>${root}`, fullRoot: true},
        {label: 'full HTML with legacy doctype', source: `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">${root}`, fullRoot: true},
        {label: 'comment with fake doctype and root tags', source: `<!-- <!doctype html> <html><head> -->${root}`, fullRoot: true},
        {label: 'root attribute with fake doctype and head tag', source: '<html lang="zh-CN" data-reader-root="true" data-note="<!doctype html> <head>"><body><p>Readable</p></body></html>', fullRoot: true},
        {label: 'fragment attribute with fake doctype and root tag', source: '<section title="<!doctype html> <html>"><p>Readable</p></section>', fullRoot: false},
    ];
    const cases = fixtures.flatMap(fixture => (['source', 'bilingual', 'translated'] as const).map(mode => ({...fixture, mode})));

    it.each(cases)('provides an HTML5 preview document for $label ($mode)', ({source, fullRoot, mode}) => {
        const parsed = parseDocument('source.html', source);
        const translations = parsed.segments.map(() => '译文');
        const modelBefore = JSON.stringify(parsed);
        const originalExport = renderDocument(parsed, [], 'translated');
        const translatedExport = renderDocument(parsed, translations, 'translated');
        const bilingualExport = renderDocument(parsed, translations, 'bilingual');
        expect(originalExport).toBe(source);

        const output = createDocumentPreviewHtml(parsed, translations, mode);
        expect(output.startsWith('<!doctype html>')).toBe(true);
        const {document} = parseHTML(output);
        expect(document.doctype?.name).toBe('html');
        expect(document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
        expect(document.head.querySelector('style')?.textContent).toContain('reader-unit');
        expect(document.body.textContent).toContain(mode === 'translated' ? '译文' : 'Readable');
        if (fullRoot) {
            expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
            expect(document.documentElement.getAttribute('data-reader-root')).toBe('true');
        } else {
            expect(document.querySelector('main > section')).not.toBeNull();
        }

        expect(JSON.stringify(parsed)).toBe(modelBefore);
        expect(renderDocument(parsed, [], 'translated')).toBe(originalExport);
        expect(renderDocument(parsed, translations, 'translated')).toBe(translatedExport);
        expect(renderDocument(parsed, translations, 'bilingual')).toBe(bilingualExport);
    });
});
