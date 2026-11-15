import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerManpagePreparation, unregisterManpagePreparation} from '@/src/core/translation/manpage';
import {alignManpageTranslation, prepareManpageTranslation} from '@/src/features/full-page-translation/content/manpageLayout';

const registered: {pre: Element; paragraph: Element}[] = [];
afterEach(() => {
    registered.forEach(({pre, paragraph}) => unregisterManpagePreparation(pre, [paragraph]));
    registered.length = 0;
    vi.restoreAllMocks();
});

function fixture(source = '       First source line.\n       Second source line.\n', trusted = true) {
    const {document} = parseHTML(`<html><body><pre><span id="source">${source}</span></pre></body></html>`);
    const paragraph = document.querySelector<HTMLElement>('#source')!;
    paragraph.setAttribute('data-fr-manpage-paragraph', 'true');
    const pre = document.querySelector('pre')!;
    pre.getBoundingClientRect = () => ({left: 10, width: 800, height: 100} as DOMRect);
    if (trusted) {
        registerManpagePreparation(pre, [paragraph]);
        registered.push({pre, paragraph});
    }
    const content = document.createElement('span');
    content.setAttribute('data-fr-translation-owned', 'true');
    content.innerHTML = '第一行<br>第二行';
    const sourceText = paragraph.textContent!;
    const offsets = new Map<Text, number>();
    const walker = document.createTreeWalker(paragraph, 4);
    let cursor = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        offsets.set(node as Text, cursor);
        cursor += node.nodeValue!.length;
    }
    const measure = vi.fn((text: Text, offset: number) => {
        const before = sourceText.slice(0, offsets.get(text)! + offset);
        const column = before.length - before.lastIndexOf('\n') - 1;
        return {left: 12 + column * 10, right: 22 + column * 10, width: 10, height: 16} as DOMRect;
    });
    const createRange = vi.fn(() => {
        let text: Text, offset: number;
        return {setStart: (node: Text, start: number) => {text = node; offset = start;},
            setEnd: vi.fn(), getBoundingClientRect: () => measure(text!, offset!)} as unknown as Range;
    });
    Object.defineProperty(document, 'createRange', {value: createRange, configurable: true});
    const computedStyle = vi.fn(() => ({borderLeftWidth: '2px'} as CSSStyleDeclaration));
    Object.defineProperty(document.defaultView!, 'getComputedStyle', {value: computedStyle, configurable: true});
    const box = vi.fn(() => ({left: 10, width: 800, height: 60} as DOMRect));
    content.getBoundingClientRect = box;
    return {document, pre, paragraph, content, sourceText, measure, createRange, computedStyle, box};
}

function expectAlignment(content: HTMLElement, padding: number, firstIndent: number) {
    expect(content.style.getPropertyValue('padding-left')).toBe(`${padding}px`);
    expect(content.style.getPropertyValue('text-indent')).toBe(`${firstIndent}px`);
}

function expectUnaligned(content: HTMLElement) {
    expect(content.style.getPropertyValue('padding-left')).toBeFalsy();
    expect(content.style.getPropertyValue('text-indent')).toBeFalsy();
}

describe('man7 translation source alignment', () => {
    it('requires the runtime paragraph identity and ignores forged attributes', () => {
        const {paragraph, content, createRange} = fixture(undefined, false);
        paragraph.setAttribute('data-fr-manpage-paragraph', 'true');
        const html = content.innerHTML;
        prepareManpageTranslation(paragraph, content);
        alignManpageTranslation(paragraph, content);
        expect(content.innerHTML).toBe(html);
        expect(content.style.getPropertyValue('white-space')).toBeFalsy();
        expect(createRange).not.toHaveBeenCalled();
        expectUnaligned(content);
    });

    it('reflows copied manual line breaks without changing original text, nodes or links', () => {
        const {paragraph, content} = fixture('       Read <a href="https://example.test/">this link</a>.\n       More source.\n');
        const html = paragraph.innerHTML, children = [...paragraph.childNodes], link = paragraph.querySelector('a');
        content.innerHTML = '第一行\n<a href="https://example.test/">链接<br>后续文字</a><br>末行';
        prepareManpageTranslation(paragraph, content);
        expect(content.textContent).toBe('第一行\n链接 后续文字 末行');
        expect(content.querySelector('br')).toBeNull();
        expect(content.querySelector('a')?.getAttribute('href')).toBe('https://example.test/');
        expect(content.style.getPropertyValue('white-space')).toBe('normal');
        expect(paragraph.innerHTML).toBe(html);
        expect([...paragraph.childNodes]).toEqual(children);
        expect(paragraph.querySelector('a')).toBe(link);
    });

    it('aligns ordinary paragraphs using source glyph geometry across inline elements and empty lines', () => {
        const {paragraph, content, measure} = fixture('\n  \n       <i>First source</i> line.\n       <a>Second</a> source line.\n');
        const html = paragraph.innerHTML;
        paragraph.appendChild(content);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, 70, 0);
        expect(measure.mock.calls.slice(0, 2).map(([text, offset]) => text.data[offset])).toEqual(['F', 'S']);
        expect(paragraph.innerHTML.replace(content.outerHTML, '')).toBe(html);
    });

    it.each([
        ['       •  First list item.\n          Continued item.\n', 100, -30],
        ['           %c  Core file size limit\n               (since Linux 2.6.24).\n', 150, -40],
        ['   Small heading\n', 30, 0],
        ['\tA single source line', 10, 0],
    ])('preserves hanging or single-line offsets for %j', (source, padding, indent) => {
        const {paragraph, content} = fixture(source);
        paragraph.appendChild(content);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, padding, indent);
    });

    it('ignores preceding translations and loading/retry artifacts when measuring a refreshed paragraph', () => {
        const {paragraph, content, document, measure} = fixture();
        for (const [attribute, value] of [['data-fr-translation-owned', 'true'], ['class', 'fluent-read-loading'], ['class', 'fluent-read-retry-wrapper']]) {
            const artifact = document.createElement('span');
            artifact.setAttribute(attribute!, value!);
            artifact.innerHTML = '<b>  伪造首行\n        伪造续行</b>';
            paragraph.insertBefore(artifact, paragraph.firstChild);
        }
        paragraph.insertBefore(content, paragraph.firstChild);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, 70, 0);
        expect(measure.mock.calls.slice(0, 2).map(([text, offset]) => text.data[offset])).toEqual(['F', 'S']);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, 70, 0);
    });

    it('does not rewrite unchanged layout properties and restores a missing important priority', () => {
        const {paragraph, content} = fixture();
        const priorities = new Map<string, string>();
        const values = new Map<string, string>();
        const setProperty = vi.fn((name: string, value: string, priority?: string) => {
            priorities.set(name, priority ?? '');
            values.set(name, value);
        });
        Object.defineProperty(content, 'style', {
            configurable: true, value: {
                getPropertyValue: (name: string) => values.get(name) ?? '',
                getPropertyPriority: (name: string) => priorities.get(name) ?? '', setProperty,
            },
        });
        paragraph.appendChild(content);
        alignManpageTranslation(paragraph, content);
        expect(setProperty).toHaveBeenCalledTimes(5);
        alignManpageTranslation(paragraph, content);
        expect(setProperty).toHaveBeenCalledTimes(5);
        priorities.delete('padding-left');
        alignManpageTranslation(paragraph, content);
        expect(setProperty).toHaveBeenCalledTimes(6);
        expect(priorities.get('padding-left')).toBe('important');
    });

    it.each([
        ['       First source line.\n       Second source line.\n', 8, 62, 0],
        ['       •  First list item.\n          Continued item.\n', 8, 92, -30],
        ['           %c  Core limit\n               Continued definition.\n', 8, 142, -40],
        ['       First source line.\n       Second source line.\n', 0, 70, 0],
    ])('compensates per-line marker padding while preserving its decoration for %j', (source, padding, outerPadding, indent) => {
        const {paragraph, content, document, computedStyle} = fixture(source);
        const markedText = document.createElement('span');
        markedText.className = 'fluent-read-translation-text';
        markedText.style.padding = '0.12em 0.5em';
        markedText.style.setProperty('box-decoration-break', 'clone');
        markedText.textContent = '带有逐行底色的译文';
        content.replaceChildren(markedText);
        content.className = 'fluent-read-bilingual-content fluent-display-line-pill';
        const decoration = markedText.getAttribute('style');
        computedStyle.mockImplementation((target?: Element) => target === markedText
            ? {paddingLeft: `${padding}px`} as CSSStyleDeclaration : {borderLeftWidth: '2px'} as CSSStyleDeclaration);
        paragraph.appendChild(content);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, outerPadding, indent);
        expect(markedText.getAttribute('style')).toBe(decoration);
    });

    it('uses zero marker padding when that style is unavailable', () => {
        const {paragraph, content, document, computedStyle} = fixture();
        const markedText = document.createElement('span');
        markedText.className = 'fluent-read-translation-text';
        content.appendChild(markedText);
        computedStyle.mockImplementation((target?: Element) => target === markedText
            ? {} as CSSStyleDeclaration : {borderLeftWidth: '2px'} as CSSStyleDeclaration);
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, 70, 0);
        Object.defineProperty(document, 'defaultView', {value: null, configurable: true});
        alignManpageTranslation(paragraph, content);
        expectAlignment(content, 72, 0);
    });

    it.each(['', ' \n\t\n  '])('leaves empty source geometry alone: %j', source => {
        const {paragraph, content, createRange} = fixture(source);
        paragraph.appendChild(content);
        alignManpageTranslation(paragraph, content);
        expect(createRange).not.toHaveBeenCalled();
        expectUnaligned(content);
    });

    it('bounds scans of long whitespace and excessive source nodes', () => {
        const long = fixture(' '.repeat(16_384) + 'A source beyond the safe scan limit.');
        alignManpageTranslation(long.paragraph, long.content);
        expectUnaligned(long.content);
        const many = fixture('<i> </i>'.repeat(2048) + 'A source beyond the safe node limit.');
        alignManpageTranslation(many.paragraph, many.content);
        expectUnaligned(many.content);
    });

    it.each([
        {left: 10, width: 0, height: 20},
        {left: 10, width: 100, height: 0},
        {left: Number.NaN, width: 100, height: 20},
    ])('preserves the fallback if translation geometry is unavailable: %j', rect => {
        const {paragraph, content, box} = fixture();
        box.mockReturnValue(rect as DOMRect);
        alignManpageTranslation(paragraph, content);
        expectUnaligned(content);
    });

    it('preserves the fallback for hidden source glyphs or source/translation layout exceptions', () => {
        const hidden = fixture();
        hidden.measure.mockReturnValue({left: 82, width: 0, height: 16} as DOMRect);
        alignManpageTranslation(hidden.paragraph, hidden.content);
        expectUnaligned(hidden.content);
        const missingRange = fixture();
        missingRange.createRange.mockImplementation(() => {throw new Error('No layout');});
        alignManpageTranslation(missingRange.paragraph, missingRange.content);
        expectUnaligned(missingRange.content);
        const missingStyle = fixture();
        missingStyle.computedStyle.mockImplementation(() => {throw new Error('Detached view');});
        alignManpageTranslation(missingStyle.paragraph, missingStyle.content);
        expectUnaligned(missingStyle.content);
    });

    it.each([
        [8, 82],
        [82, 8],
    ])('declines negative source offsets instead of shifting text outside the translation box', (first, second) => {
        const {paragraph, content, measure} = fixture();
        measure.mockReturnValueOnce({left: first, width: 10, height: 16} as DOMRect)
            .mockReturnValueOnce({left: second, width: 10, height: 16} as DOMRect);
        alignManpageTranslation(paragraph, content);
        expectUnaligned(content);
    });

    it('treats unavailable border widths as zero and declines nonfinite computed geometry', () => {
        const unset = fixture();
        unset.computedStyle.mockReturnValue({borderLeftWidth: 'medium'} as CSSStyleDeclaration);
        alignManpageTranslation(unset.paragraph, unset.content);
        expectAlignment(unset.content, 72, 0);
        const noView = fixture();
        Object.defineProperty(noView.document, 'defaultView', {value: null, configurable: true});
        alignManpageTranslation(noView.paragraph, noView.content);
        expectAlignment(noView.content, 72, 0);
        const infinite = fixture();
        infinite.computedStyle.mockReturnValue({borderLeftWidth: '-Infinity'} as CSSStyleDeclaration);
        alignManpageTranslation(infinite.paragraph, infinite.content);
        expectUnaligned(infinite.content);
    });
});

describe('man7 shared source column width', () => {
    const body = '       ' + 'Ordinary source prose with enough words to wrap at the column edge.' + '\n       A short final source line.\n';

    function addParagraph(f: ReturnType<typeof fixture>, source: string, pre = f.pre, trusted = true) {
        const paragraph = f.document.createElement('span');
        paragraph.setAttribute('data-fr-manpage-paragraph', 'true');
        paragraph.textContent = source;
        pre.appendChild(paragraph);
        if (trusted) {
            registerManpagePreparation(pre, [paragraph]);
            registered.push({pre, paragraph});
        }
        return paragraph;
    }

    function plainGeometry(f: ReturnType<typeof fixture>) {
        f.measure.mockImplementation((text: Text, offset: number) => {
            const before = text.data.slice(0, offset);
            const column = before.length - before.lastIndexOf('\n') - 1;
            const preLeft = text.parentElement!.closest('pre')?.getBoundingClientRect().left ?? 10;
            const left = preLeft + 2 + column * 10;
            return {left, right: left + 10, width: 10, height: 16} as DOMRect;
        });
    }

    function expectedWidth(source: string) {return source.split('\n')[0]!.trimEnd().length * 10 + 2;}
    function expectWidth(content: HTMLElement, width: number) {
        expect(content.style.getPropertyValue('width')).toBe('100%');
        expect(content.style.getPropertyValue('max-width')).toBe(`${width}px`);
        expect(content.style.getPropertyValue('box-sizing')).toBe('border-box');
    }

    it('gives a short paragraph and heading the shared multiline source column instead of their own text widths', () => {
        const f = fixture(body);
        plainGeometry(f);
        const short = addParagraph(f, '       A short paragraph.\n');
        const heading = addParagraph(f, '   Small heading\n');
        for (const paragraph of [short, heading]) {
            paragraph.appendChild(f.content);
            alignManpageTranslation(paragraph, f.content);
            expectWidth(f.content, expectedWidth(body));
        }
        expect(f.measure).toHaveBeenCalledTimes(4); // 每个单行目标各一个首字形，加一个共享行末字形。
        expect(f.paragraph.textContent).toBe(body);
    });

    it('retains deeper hanging indentation and derives width from source geometry for every target font', () => {
        const f = fixture(body);
        plainGeometry(f);
        const list = addParagraph(f, '       •  A list item.\n          Its continuation.\n');
        const parameter = addParagraph(f, '           %c  A core limit\n               More detail.\n');
        for (const paragraph of [list, parameter]) {
            paragraph.appendChild(f.content);
            for (const font of ['monospace', '"PingFang SC"', 'initial']) {
                f.content.style.fontFamily = font;
                alignManpageTranslation(paragraph, f.content);
                expectWidth(f.content, expectedWidth(body));
                expectAlignment(f.content, paragraph === list ? 100 : 150, paragraph === list ? -30 : -40);
            }
        }
    });

    it('excludes long literal commands, forged paragraph markers and preceding owned translations from the column', () => {
        const f = fixture(body);
        plainGeometry(f);
        addParagraph(f, '       ' + 'Long forged prose '.repeat(30) + '\n       Its continuation.\n', f.pre, false);
        const literal = f.document.createElement('span');
        literal.setAttribute('data-fr-manpage-literal', 'true');
        literal.textContent = '       $ ' + 'long-command-option '.repeat(100) + '\n       terminal output\n';
        f.pre.appendChild(literal);
        const nestedLiteral = literal.cloneNode(true);
        f.paragraph.appendChild(nestedLiteral);
        const oldTranslation = f.document.createElement('span');
        oldTranslation.setAttribute('data-fr-translation-owned', 'true');
        oldTranslation.textContent = '旧译文'.repeat(100) + '\n更多旧译文\n';
        f.paragraph.insertBefore(oldTranslation, f.paragraph.firstChild);
        f.paragraph.insertBefore(f.content, f.paragraph.firstChild);
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(body));
        expect(literal.textContent).toContain('long-command-option');
        expectAlignment(f.content, 70, 0);
    });

    it('recomputes the column after dynamic source changes and constrains a narrow container with percentage width', () => {
        const f = fixture(body);
        plainGeometry(f);
        f.paragraph.insertBefore(f.content, f.paragraph.firstChild);
        f.box.mockReturnValue({left: 10, width: 300, height: 100} as DOMRect);
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(body));
        const updated = '       A newly extended source line with significantly more words than before to define its new column.\n       Continued prose.\n';
        const source = addParagraph(f, updated);
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(updated));
        expect(f.content.style.getPropertyValue('width')).toBe('100%');
        expect(source.textContent).toBe(updated);
    });

    it('borrows a verified multiline column for a short PRE and translates its relative horizontal position', () => {
        const f = fixture('       Small source.\n');
        plainGeometry(f);
        const other = f.document.createElement('pre');
        other.getBoundingClientRect = () => ({left: 100, width: 800, height: 100} as DOMRect);
        f.document.body.appendChild(other);
        addParagraph(f, body, other);
        const wider = f.document.createElement('pre');
        wider.getBoundingClientRect = () => ({left: 100, width: 800, height: 100} as DOMRect);
        f.document.body.appendChild(wider);
        addParagraph(f, body.replace('column edge.', 'much wider column edge.'), wider);
        addParagraph(f, '       Shorter prose.\n       More prose.\n', wider);
        const narrower = f.document.createElement('pre');
        narrower.getBoundingClientRect = () => ({left: 100, width: 800, height: 100} as DOMRect);
        f.document.body.appendChild(narrower);
        addParagraph(f, '       Short verified source.\n       A continuation.\n', narrower);
        const forged = f.document.createElement('pre');
        f.document.body.appendChild(forged);
        addParagraph(f, '       ' + 'Forged huge source '.repeat(100) + '\n       More prose.\n', forged, false);
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(body.replace('column edge.', 'much wider column edge.')));
    });

    it('keeps the local PRE column even when another section contains wider prose', () => {
        const f = fixture(body);
        plainGeometry(f);
        const other = f.document.createElement('pre');
        f.document.body.appendChild(other);
        addParagraph(f, '       ' + 'Wider source words '.repeat(100) + '\n       Continued prose.\n', other);
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(body));
    });

    it('does not infer a narrow column from only short single-line paragraphs', () => {
        const f = fixture('       Short paragraph.\n');
        plainGeometry(f);
        addParagraph(f, '   Another small heading\n');
        alignManpageTranslation(f.paragraph, f.content);
        expect(f.content.style.getPropertyValue('max-width')).toBeFalsy();
    });

    it.each([false, true])('requires a registered containing PRE for width, even if a paragraph is registered: %j', bare => {
        const f = fixture(body);
        plainGeometry(f);
        const parent = bare ? f.document.body : f.document.createElement('pre');
        parent.appendChild(f.paragraph);
        alignManpageTranslation(f.paragraph, f.content);
        expect(f.content.style.getPropertyValue('max-width')).toBeFalsy();
    });

    it.each([
        {right: Number.NaN, width: 10, height: 16},
        {right: 700, width: 0, height: 16},
        {right: 700, width: 10, height: 0},
        {right: 0, width: 10, height: 16},
    ])('keeps existing indentation when the shared right-edge geometry cannot supply width: %j', last => {
        const f = fixture(body);
        plainGeometry(f);
        const measure = f.measure.getMockImplementation()!;
        f.measure.mockImplementation((text, offset) => offset === body.split('\n')[0]!.length - 1
            ? {...measure(text, offset), ...last} as DOMRect : measure(text, offset));
        alignManpageTranslation(f.paragraph, f.content);
        expectAlignment(f.content, 70, 0);
        expect(f.content.style.getPropertyValue('max-width')).toBeFalsy();
    });

    it('does not publish a nonfinite cross-section column shift', () => {
        const f = fixture('       Short paragraph.\n');
        plainGeometry(f);
        const other = f.document.createElement('pre');
        other.getBoundingClientRect = () => ({left: Number.NaN, width: 800, height: 100} as DOMRect);
        f.document.body.appendChild(other);
        const reference = addParagraph(f, body, other);
        const fallback = f.measure.getMockImplementation()!;
        f.measure.mockImplementation((text, offset) => reference.contains(text)
            ? {left: 600, right: 610, width: 10, height: 16} as DOMRect : fallback(text, offset));
        alignManpageTranslation(f.paragraph, f.content);
        expect(f.content.style.getPropertyValue('max-width')).toBeFalsy();
    });

    it('bounds width scanning of enormous trailing whitespace and many source text nodes', () => {
        const f = fixture(body + ' '.repeat(16_384));
        plainGeometry(f);
        addParagraph(f, '       First source line.\n       Second source line.\n' + ' ', f.pre);
        const many = addParagraph(f, '       First source line.\n       Second source line.\n', f.pre);
        for (let index = 0; index < 2048; index++) {
            const inline = f.document.createElement('i');
            inline.textContent = ' ';
            many.appendChild(inline);
        }
        alignManpageTranslation(f.paragraph, f.content);
        expectWidth(f.content, expectedWidth(body));
    });
});
