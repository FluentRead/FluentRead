import {readFileSync} from 'node:fs';

export const exampleRoot = new URL('./fixtures/document-translation/', import.meta.url);

export const DOCUMENT_EXAMPLES = [
    {fileName: 'sample.html', format: 'html', markers: ['<a href="https://example.com">', 'const untouched = true;']},
    {fileName: 'sample.txt', format: 'txt', markers: ['\n\n', 'Keep the line structure intact.']},
    {fileName: 'sample.md', format: 'markdown', markers: ['```js', '[Reference link](https://example.com)']},
    {fileName: 'sample.srt', format: 'srt', markers: ['00:00:01,000 --> 00:00:03,000', '<i>Hello subtitle</i>']},
    {fileName: 'sample.vtt', format: 'vtt', markers: ['WEBVTT', '00:00:01.000 --> 00:00:03.000']},
    {fileName: 'sample.ass', format: 'ass', markers: ['[Events]', 'Dialogue:', '{\\i1}']},
    {fileName: 'sample.ssa', format: 'ass', markers: ['[Events]', 'Dialogue:', '{\\i1}']},
    {fileName: 'sample.lrc', format: 'lrc', markers: ['[ti:Document translation example]', '[00:01.00]']},
    {fileName: 'sample.json', format: 'json', markers: ['"keepNumber": 42']},
    {fileName: 'sample.csv', format: 'csv', markers: ['12.50,https://example.com/guide']},
    {fileName: 'sample.tsv', format: 'tsv', markers: ['\t=SUM(B3)']},
] as const;

export const DOCUMENT_BINARY_EXAMPLES = [
    {fileName: 'sample.pdf', format: 'pdf', marker: 'Document Translation Example'},
    {fileName: 'sample.epub', format: 'epub', marker: 'Fluent reading for local books'},
    {fileName: 'sample.docx', format: 'docx', marker: 'Document Translation Example'},
] as const;

export type DocumentExample = (typeof DOCUMENT_EXAMPLES)[number];

export function loadExample(fileName: string): string {
    return readFileSync(new URL(fileName, exampleRoot), 'utf8');
}

export function loadBinaryExample(fileName: string): Uint8Array {
    return Uint8Array.from(readFileSync(new URL(fileName, exampleRoot)));
}
