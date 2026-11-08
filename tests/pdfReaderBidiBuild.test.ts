/** 固定上游原字节和真实虚拟模块边界；这里只执行纯字符算法，不加载 PDF 页面或 worker。 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {projectPdfReaderBidi} from 'virtual:fluentread-pdfjs-bidi';
import {createPdfReaderBidiBuildPlugin, createPdfReaderBidiModule, PDF_READER_BIDI_ID} from '../scripts/testing/pdfjs-bidi-build';

const root = resolve(__dirname, '..');
const worker = readFileSync(resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8');
const license = readFileSync(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), 'utf8');
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

describe('pinned PDF.js pure bidi build boundary', () => {
    it('preserves the complete original module and Apache notice in a static export without SDK execution', () => {
        const plugin = createPdfReaderBidiBuildPlugin(root), id = plugin.resolveId(PDF_READER_BIDI_ID)!;
        const built = plugin.load(id)!;
        const start = worker.indexOf(';// ./src/core/bidi.js\n'), end = worker.indexOf(';// ./src/core/font_substitutions.js');
        const kernel = worker.slice(start, end), notice = worker.slice(0, worker.indexOf('*/') + 2);
        expect(sha(kernel)).toBe('03f8324167fd1e03000c7214d4bacc673c56bff97169052f8ce42f450094fcc5');
        expect(sha(notice)).toBe('93db28d6b86557c97d8320d1a317882c5a6f4f9862862412c6676e8a9ef76ca3');
        expect(built.startsWith(notice)).toBe(true); expect(built.split(kernel)).toHaveLength(2);
        expect(built).toContain('export function projectPdfReaderBidi(text)');
        expect(built).not.toMatch(/\b(?:import|Worker|eval|Function)\s*\(/u);
        expect(built).not.toContain('font_substitutions');
    });
    it.each([
        ['version', worker, '6.5.439', license],
        ['worker byte', worker + '\n', '6.5.438', license],
        ['license byte', worker, '6.5.438', license + '\n'],
    ])('refuses an unreviewed %s before delivering any module', (_label, source, version, licenseSource) => {
        expect(() => createPdfReaderBidiModule(source, version, licenseSource)).toThrow('Unsupported PDF.js reader source');
    });
    it('does not intercept dependency resources, query variants or unrelated virtual modules', () => {
        const plugin = createPdfReaderBidiBuildPlugin(root);
        expect(plugin.resolveId(PDF_READER_BIDI_ID + '?raw')).toBeNull();
        expect(plugin.resolveId('pdfjs-dist/legacy/build/pdf.worker.mjs')).toBeNull();
        expect(plugin.load('\0another-virtual-module')).toBeNull();
    });
    it.each([['םולש', 'שלום'], ['English 2026 א', 'English 2026 א'], ['hello world א', 'hello world א']])
    ('exposes the exact pinned reader projection for %s', (visual, projected) => {
        expect(projectPdfReaderBidi(visual)?.str).toBe(projected);
    });
    it.each(['', 'שלום\n', 'שלום\u00a0עולם', 'שלום😀', 'مرحبا', 'A'.repeat(8193)])
    ('refuses input outside the explicit pure-kernel capability: %j', source => {
        expect(projectPdfReaderBidi(source)).toBeUndefined();
    });
    it('keeps the exact supported length without trimming, sorting or adding characters', () => {
        const source = 'A'.repeat(8192);
        expect(projectPdfReaderBidi(source)).toEqual({str: source, dir: 'ltr'});
    });
});
