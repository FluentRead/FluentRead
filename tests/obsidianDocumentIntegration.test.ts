import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {parseDocument, renderDocument} from '../src/features/document-translation/core/document';
import {translateMicrosoftTextsWithTransport} from '../src/providers/translation/microsoftTransport';
import {bilingualNoteName, renderBilingualPdfNote} from '../integrations/obsidian/output';
import {prepareMarkdownSegments} from '../integrations/obsidian/markdown';
import {extractPdfSegments} from '../integrations/obsidian/pdf';
import {createObsidianTranslator, type ObsidianRequestUrl} from '../integrations/obsidian/translation';
import {createBilingualNote} from '../integrations/obsidian/vault';

describe('Obsidian Markdown document flow', () => {
    it('preserves properties, wiki links, code, and math while translating ordinary text', () => {
        const source = [
            '---',
            'title: Source title',
            'tags: [research]',
            '---',
            '# A note',
            'Read [[Research|the source]] and ![[figure.png]] today.',
            '> [!note] Keep this callout marker',
            '> A quoted explanation with #research.',
            '```js',
            'const secret = "do not translate";',
            '```',
            '$$',
            'E = mc^2',
            '$$',
            'The conclusion.',
        ].join('\n');
        const document = parseDocument('note.md', source);
        const segments = document.segments.map(({source: text}) => text);
        expect(segments[0]).toBe('# A note');
        expect(prepareMarkdownSegments(document.segments)[0].source).toBe('A note');
        expect(segments.some((text) => text.includes('title:') || text.includes('secret') || text.includes('E = mc'))).toBe(false);
        expect(segments.join(' ')).not.toContain('[[Research');
        expect(segments.join(' ')).not.toContain('figure.png');
        expect(segments.join(' ')).not.toContain('[!note]');
        expect(segments.join(' ')).not.toContain('#research');
        const translated = renderDocument(document, segments.map((_, index) => `译文 ${index + 1}`), 'bilingual');
        expect(translated).toContain('title: Source title');
        expect(translated).toContain('[[Research|the source]]');
        expect(translated).toContain('![[figure.png]]');
        expect(translated).toContain('> [!note] Keep this callout marker');
        expect(translated).toContain('#research');
        expect(translated).toContain('const secret = "do not translate";');
        expect(translated).toContain('E = mc^2');
        expect(translated).toContain('> 译文');
        expect(bilingualNoteName('note.md')).toBe('note.bilingual.md');
        expect(bilingualNoteName('paper.pdf')).toBe('paper.pdf.bilingual.md');
    });

    it('keeps PDF pages in the generated bilingual note', () => {
        const result = renderBilingualPdfNote('papers/research.pdf', [
            {id: 0, source: 'First page', contextLabel: '第 1 页'},
            {id: 1, source: 'Another paragraph'},
            {id: 2, source: 'Second page', contextLabel: '第 2 页'},
        ], ['第一页', '另一段', '第二页']);
        expect(result).toContain('[[papers/research.pdf]]');
        expect(result).toContain('## 第 1 页');
        expect(result).toContain('## 第 2 页');
        expect(result.indexOf('另一段')).toBeLessThan(result.indexOf('## 第 2 页'));
    });

    it.each([
        ['> ## A quoted heading', 'A quoted heading'],
        ['> - [x] A completed task', 'A completed task'],
        ['1. > A quoted list item', 'A quoted list item'],
    ])('sends readable text for nested Markdown structure %s and retains the source line', (source, readable) => {
        const document = parseDocument('nested.md', source);
        const before = structuredClone(document.segments);
        const prepared = prepareMarkdownSegments(document.segments);
        expect(prepared.map(({source: text}) => text)).toEqual([readable]);
        expect(document.segments).toEqual(before);
        expect(renderDocument(document, ['结构译文'], 'bilingual')).toBe(`${source}\n> 结构译文`);
    });

    it('retains segment identity and metadata and does not erase structural-only text', () => {
        const segments = [{id: 7, source: '> ', contextLabel: 'Context', role: 'note' as const}];
        expect(prepareMarkdownSegments(segments)).toEqual(segments);
        expect(prepareMarkdownSegments([{...segments[0], source: '> A note'}])[0])
            .toEqual({...segments[0], source: 'A note'});
    });

    it.each(['', '   \n', '---\ntitle: Metadata only\n---', '```js\nconst code = 1;\n```', '$$\nE = mc^2\n$$'])
        ('keeps non-translatable Markdown unchanged: %j', (source) => {
            const document = parseDocument('empty.md', source);
            expect(prepareMarkdownSegments(document.segments)).toEqual([]);
            expect(renderDocument(document, [], 'bilingual')).toBe(source);
        });

    it.each([
        ['UPPER.MD', 'UPPER.bilingual.md'],
        ['long.MARKDOWN', 'long.bilingual.md'],
        ['paper.PDF', 'paper.PDF.bilingual.md'],
    ])('names outputs for case-insensitive source extensions: %s', (source, expected) => {
        expect(bilingualNoteName(source)).toBe(expected);
    });

    it('escapes PDF text markup and keeps multiline translations inside the quote', () => {
        const result = renderBilingualPdfNote('paper.pdf', [{id: 0, source: '[source] *bold*\n> another line'}], ['[translation]\n# heading']);
        expect(result).toContain('> \\[source\\] \\*bold\\*\n> \\> another line');
        expect(result).toContain('> \\[translation\\]\n> \\# heading');
    });

    it('extracts text from a real two-page PDF without changing the fixture', async () => {
        const bytes = readFileSync(new URL('./fixtures/document-translation/sample.pdf', import.meta.url));
        const before = Buffer.from(bytes);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const segments = await extractPdfSegments(buffer);
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.some(({contextLabel}) => contextLabel === '第 1 页')).toBe(true);
        expect(segments.some(({contextLabel}) => contextLabel === '第 2 页')).toBe(true);
        expect(bytes).toEqual(before);
    });

    it('translates parsed Markdown and creates a unique sibling without changing either original note', async () => {
        const source = '---\ntitle: Original title\n---\n> - [x] A task.\nRead [[Reference]] safely.\n```js\nconst code = 1;\n```';
        const document = parseDocument('source.md', source);
        const request = vi.fn(async ({body}: Parameters<ObsidianRequestUrl>[0]) => ({
            status: 200,
            headers: {},
            text: JSON.stringify((JSON.parse(body as string) as string[]).map((text) => ({translations: [{text: `中文 ${text}`}]}))),
        })) as unknown as ObsidianRequestUrl;
        const translations = await createObsidianTranslator(request)(prepareMarkdownSegments(document.segments), {fileName: 'source.md'});
        expect(JSON.parse(vi.mocked(request).mock.calls[0][0].body as string)).toEqual(['A task.', 'Read', 'safely.']);
        const content = renderDocument(document, translations, 'bilingual');
        const file = {
            name: 'source.md', path: 'notes/source.md', parent: {path: 'notes'}, stat: {mtime: 42, size: source.length},
        } as Parameters<typeof createBilingualNote>[1];
        const entries = new Map([['notes/source.md', source], ['notes/source.bilingual.md', 'Earlier translation']]);
        const vault = {
            getAbstractFileByPath: (path: string) => path === file.path ? file : entries.has(path) ? {path} : null,
            create: vi.fn(async (path: string, value: string) => {
                if (entries.has(path)) throw new Error('File already exists');
                entries.set(path, value);
                return {path} as typeof file;
            }),
        } as unknown as Parameters<typeof createBilingualNote>[0];
        const output = await createBilingualNote(vault, file, {mtime: 42, size: source.length}, content, new AbortController().signal);
        expect(output.path).toBe('notes/source.bilingual 2.md');
        expect(entries.get(file.path)).toBe(source);
        expect(entries.get('notes/source.bilingual.md')).toBe('Earlier translation');
        expect(entries.get(output.path)).toBe(content);
        expect(content).toContain('> - [x] A task.\n> 中文 A task.');
        expect(content).toContain('Read [[Reference]] safely.\n> 中文 Read [[Reference]] 中文 safely.');
        expect(content).toContain('const code = 1;');
    });

    it('sends only prose from nested fenced containers and retains inline punctuation in the actual HTTP batch', async () => {
        const source = '> - ```js\n>   const code = "keep local";\n>   ```\nUse [[source]] - retain the dash.';
        const document = parseDocument('nested.md', source);
        const request = vi.fn(async () => ({
            status: 200, headers: {},
            text: JSON.stringify([{translations: [{text: '使用'}]}, {translations: [{text: '- 保留破折号'}]}]),
        })) as unknown as ObsidianRequestUrl;
        const translations = await createObsidianTranslator(request)(prepareMarkdownSegments(document.segments), {fileName: 'nested.md'});
        expect(JSON.parse(vi.mocked(request).mock.calls[0][0].body as string)).toEqual(['Use', '- retain the dash.']);
        const output = renderDocument(document, translations, 'bilingual');
        expect(output).toContain('const code = "keep local";');
        expect(output).toContain('Use [[source]] - retain the dash.\n> 使用 [[source]] - 保留破折号');
    });
});

describe('shared Microsoft transport', () => {
    it('escapes pure text and decodes the matching translated batch', async () => {
        const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify([
                {translations: [{text: '&lt;翻译&gt;'}]},
                {translations: [{text: '第二条'}]},
            ]), {status: 200}));
        const result = await translateMicrosoftTextsWithTransport(transport, ['<input>', 'second'], 'auto', 'zh-Hans');
        expect(result).toEqual(['<翻译>', '第二条']);
        expect(String(transport.mock.calls[0][0])).toContain('to=zh-Hans');
        expect(transport.mock.calls[0][1]?.body).toBe('["&lt;input&gt;","second"]');
    });
});
