import 'fake-indexeddb/auto';
import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeDocumentMaterialReference, DOCUMENT_MATERIAL_REFERENCE_LIMITS} from '@/src/features/document-translation/material/public';
import type {ParsedDocument} from '@/src/features/document-translation/public';
import {captureDocumentMaterialLocator, resolveMaterialDocumentResume} from '@/src/app/document-translation/materialResume';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {normalizeMaterialLocator} from '@/src/features/vocabulary/materialModel';
import type {MaterialSource} from '@/src/features/vocabulary/materialProtocol';

const fingerprint = 'a'.repeat(32), otherFingerprint = 'b'.repeat(32);
const source: MaterialSource = {kind: 'document', fingerprint, title: 'same.pdf'};
const databases: MaterialDatabase[] = [];
function repository(): MaterialRepository {
    const db = new MaterialDatabase(`DocumentMaterialIntegration-${crypto.randomUUID()}`);
    databases.push(db); return new MaterialRepository(db);
}
function pdf(entries: Array<[string, number, number]>, pageCount = 2): ParsedDocument {
    return {fileName: 'same.pdf', format: 'pdf', label: 'PDF', parts: [], segments: entries.map(([source], id) => ({id, source})),
        binary: {kind: 'pdf', bytes: new Uint8Array([1]), pages: Array.from({length: pageCount}, (_, at) => ({
            pageNumber: at + 1, width: 600, height: 800,
            segmentIndexes: entries.flatMap((entry, index) => entry[1] === at + 1 ? [index] : []),
            blocks: entries.flatMap((entry, index) => entry[1] === at + 1 ? [{segmentIndex: index, x: 10, y: entry[2], width: 300, height: 12, fontSize: 12, lineHeight: 14, lineCount: 1, fontFamily: 'sans', fontWeight: 400, textAlign: 'left',
                lines: [{x: 10, y: entry[2], baseline: entry[2] + 10, width: 300, height: 12, text: entry[0]}]}] : []),
        }))}} as ParsedDocument;
}
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    if (!globalThis.CustomEvent) vi.stubGlobal('CustomEvent', class extends Event {detail: unknown; constructor(type: string, options: {detail?: unknown} = {}) {super(type); this.detail = options.detail;}});
});
afterEach(async () => {for (const db of databases.splice(0)) {db.close(); await db.delete();} vi.unstubAllGlobals();});

describe('document reference persistence and material resume integration', () => {
    it('round-trips exact decomposed source through capture, IndexedDB, JSON export and import', async () => {
        const original = '  Cafe\u0301\nResult  ';
        const locator = captureDocumentMaterialLocator(fingerprint, pdf([[original, 2, 40]]), 0)!;
        const first = repository(), second = repository();
        const saved = await first.capture({source, locator, reference: {kind: 'note', id: 'note', note: 'Keep this note'}}, 100);
        expect((await first.get(saved.id))?.locator?.documentReference?.locator.source).toBe(original);
        const backup = JSON.parse(JSON.stringify(await first.exportData(200)));
        expect(await second.importData(backup, 300)).toMatchObject({inserted: 1, skipped: 0});
        const restored = (await second.list())[0];
        expect(restored.locator?.quote).toBe('Café\nResult');
        expect(restored.locator?.documentReference?.locator.source).toBe(original);
        expect(restored.references[0].note).toBe('Keep this note');
    });
    it('rejects cross-file captures and atomically rolls back a locator update', async () => {
        const repo = repository(), locator = captureDocumentMaterialLocator(fingerprint, pdf([['Original', 2, 40]]), 0)!;
        await expect(repo.capture({source: {...source, fingerprint: otherFingerprint}, locator}, 100)).rejects.toThrow('文档');
        expect(await repo.list()).toEqual([]);
        const saved = await repo.capture({source, locator}, 101);
        const wrong = {...locator, documentReference: {...locator.documentReference!, materialId: otherFingerprint}};
        await expect(repo.update(saved.id, {title: 'Should roll back', locator: wrong}, 102)).rejects.toThrow('文档');
        expect((await repo.get(saved.id))?.title).toBe('same.pdf');
    });
    it('validates all optional fields and refuses total-budget excess instead of truncating exact source', () => {
        const locator = captureDocumentMaterialLocator(fingerprint, pdf([['Original', 2, 40]]), 0)!;
        const reference = locator.documentReference!;
        expect(normalizeDocumentMaterialReference({...reference, version: 2}, fingerprint)).toBeUndefined();
        expect(normalizeDocumentMaterialReference({...reference, locator: []}, fingerprint)).toBeUndefined();
        for (const key of ['scope', 'position', 'before', 'after']) expect(normalizeDocumentMaterialReference({...reference, locator: {...reference.locator, [key]: 7}}, fingerprint)).toBeUndefined();
        expect(normalizeDocumentMaterialReference({...reference, locator: {...reference.locator, source: 'x'.repeat(DOCUMENT_MATERIAL_REFERENCE_LIMITS.source + 1)}}, fingerprint)).toBeUndefined();
        expect(normalizeDocumentMaterialReference({...reference, locator: {...reference.locator, source: 'x'.repeat(12000), before: 'b'.repeat(12000), after: 'a'.repeat(12000)}}, fingerprint)).toBeUndefined();
        expect(() => normalizeMaterialLocator({...locator, kind: 'text'}, source)).toThrow('文档');
    });
    it('keeps same-page duplicate source positions distinct after parser reorders segments', () => {
        const previous = pdf([['Repeat', 2, 10], ['Repeat', 2, 100]]), current = pdf([['Repeat', 2, 100], ['Repeat', 2, 10]]);
        const first = captureDocumentMaterialLocator(fingerprint, previous, 0)!;
        const second = captureDocumentMaterialLocator(fingerprint, previous, 1)!;
        expect(first.documentReference?.locator.position).not.toBe(second.documentReference?.locator.position);
        expect(resolveMaterialDocumentResume(second, fingerprint, current)).toMatchObject({status: 'exact', page: 2, segmentIndex: 0});
    });
    it('does not jump to another page when the original exact source disappears during reparse', () => {
        const previous = pdf([['Same', 1, 10], ['Same', 2, 30]]), current = pdf([['Same', 1, 10], ['Changed paragraph', 2, 30]]);
        const saved = captureDocumentMaterialLocator(fingerprint, previous, 1)!;
        expect(resolveMaterialDocumentResume(saved, fingerprint, current)).toEqual({status: 'unresolved', reason: 'source-changed-or-ambiguous', allowAutomaticPositionCapture: false});
        expect(saved.page).toBe(2);
    });
    it('retains separate coarse and unlocated states for old records without guessing from a repeated quote', () => {
        const document = pdf([['Same', 1, 10], ['Same', 2, 30]]);
        expect(resolveMaterialDocumentResume({kind: 'document', page: 2, quote: 'Same'}, fingerprint, document)).toMatchObject({status: 'coarse', page: 2, allowAutomaticPositionCapture: false});
        expect(resolveMaterialDocumentResume({kind: 'document', quote: 'Same'}, fingerprint, document)).toMatchObject({status: 'unlocated', reason: 'no-position'});
        expect(resolveMaterialDocumentResume({kind: 'document', page: 3}, fingerprint, document)).toMatchObject({status: 'unlocated', reason: 'invalid-position'});
    });
    it('prevents a coarse automatic update from erasing a saved exact reference', async () => {
        const repo = repository(), locator = captureDocumentMaterialLocator(fingerprint, pdf([['Original', 2, 40]]), 0)!;
        const saved = await repo.capture({source, locator}, 100);
        await repo.capture({source, locator: {kind: 'document', page: 1}, positionOnly: true}, 101);
        expect((await repo.get(saved.id))?.locator).toEqual(saved.locator);
    });
    it('retains additive-schema legacy backups and skips a mismatched imported reference', async () => {
        const first = repository(), second = repository();
        await first.capture({source, locator: captureDocumentMaterialLocator(fingerprint, pdf([['Original', 2, 40]]), 0)!}, 100);
        const backup = JSON.parse(JSON.stringify(await first.exportData(200)));
        backup.materials[0].locator.documentReference.materialId = otherFingerprint;
        expect(await second.importData(backup, 300)).toMatchObject({inserted: 0, skipped: 1});
        delete backup.materials[0].locator.documentReference;
        expect(await second.importData(backup, 301)).toMatchObject({inserted: 1, skipped: 0});
        expect((await second.list())[0].locator?.page).toBe(2);
    });
    it('never treats a translation configuration fingerprint as the file content id', () => {
        const document = pdf([['Original', 2, 40]]), locator = captureDocumentMaterialLocator(fingerprint, document, 0)!;
        expect(resolveMaterialDocumentResume(locator, 'google:zh-Hans', document)).toMatchObject({status: 'unresolved', reason: 'file-identity'});
        expect(resolveMaterialDocumentResume(locator, otherFingerprint, document)).toMatchObject({status: 'unresolved', reason: 'file-identity'});
        expect(resolveMaterialDocumentResume(locator, fingerprint, {...document, fileName: 'renamed.pdf'})).toMatchObject({status: 'exact'});
    });
});

describe('document reference input boundaries and non-PDF migration', () => {
    it('preserves duplicate-origin evidence through the whitelist and refuses corrupt occurrence counts', () => {
        const reference = {version: 1, materialId: fingerprint, locatorOccurrences: 2, locator: {version: 1, source: 'Same', before: 'A', after: 'B'}};
        expect(normalizeDocumentMaterialReference(reference, fingerprint)?.locatorOccurrences).toBe(2);
        for (const value of [0, -1, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) expect(normalizeDocumentMaterialReference({...reference, locatorOccurrences: value}, fingerprint)).toBeUndefined();
        const inherited = Object.assign(Object.create({locatorOccurrences: 2}), {version: 1, materialId: fingerprint, locator: reference.locator});
        expect(normalizeDocumentMaterialReference(inherited, fingerprint)).toBeUndefined();
        const original = {fileName: 'duplicate.txt', format: 'txt', label: 'TXT', parts: [], segments: ['A', 'Same', 'B', 'C', 'Same', 'D'].map((source, id) => ({id, source}))} as ParsedDocument;
        const captured = captureDocumentMaterialLocator(fingerprint, original, 1)!;
        const normalized = normalizeMaterialLocator(captured, source)!;
        expect(normalized.documentReference?.locatorOccurrences).toBe(2);
        const removed = {...original, segments: ['A', 'B', 'C', 'Same', 'D'].map((source, id) => ({id, source}))};
        expect(resolveMaterialDocumentResume(normalized, fingerprint, removed)).toMatchObject({status: 'unresolved'});
    });
    it('requires owned fields and exact field budgets without mutating or truncating the supplied reference', () => {
        const base = {version: 1 as const, materialId: fingerprint, locator: {version: 1 as const, source: 'S'}};
        for (const input of [null, [], {}, {...base, locator: null}, {...base, locator: []}, {...base, locator: {version: 1, source: ''}}, Object.create(base)]) expect(normalizeDocumentMaterialReference(input, fingerprint)).toBeUndefined();
        expect(normalizeDocumentMaterialReference(base, 'config-fingerprint')).toBeUndefined();
        const inherited = Object.assign(Object.create({scope: 'pdf:1'}), {version: 1, source: 'S'});
        expect(normalizeDocumentMaterialReference({...base, locator: inherited}, fingerprint)).toBeUndefined();
        for (const [key, count] of [['scope', 2049], ['position', 513], ['before', 12001], ['after', 12001]] as const) expect(normalizeDocumentMaterialReference({...base, locator: {...base.locator, [key]: 'x'.repeat(count)}}, fingerprint)).toBeUndefined();
        expect(normalizeMaterialLocator({kind: 'document', documentReference: base}, source)?.fingerprint).toBe(fingerprint);
        expect(normalizeMaterialLocator({kind: 'document', fingerprint, documentReference: base})?.documentReference).toEqual(base);
        expect(() => normalizeMaterialLocator({kind: 'document', documentReference: base})).toThrow('文档');
        expect(() => normalizeMaterialLocator({kind: 'document', documentReference: base}, {kind: 'article'})).toThrow('文档');
        expect(() => normalizeMaterialLocator({kind: 'document', fingerprint: otherFingerprint, documentReference: base})).toThrow('文档');
    });
    it('maps EPUB paths and DOCX native paragraphs after parser reorders parts', () => {
        const epub: ParsedDocument = {fileName: 'book.epub', format: 'epub', label: 'EPUB', parts: [], segments: [{id: 0, source: 'Same'}, {id: 1, source: 'Same'}], binary: {kind: 'epub', bytes: new Uint8Array(), chapters: [{path: 'one', source: '<p>Same</p>', title: 'One', segmentOffset: 0, segmentCount: 1}, {path: 'two', source: '<p>Same</p>', title: 'Two', segmentOffset: 1, segmentCount: 1}]}};
        const epubLocator = captureDocumentMaterialLocator(fingerprint, epub, 1)!;
        expect(resolveMaterialDocumentResume(epubLocator, fingerprint, epub)).toMatchObject({status: 'exact', page: 1, section: 'epub:1'});
        for (const section of ['epub:2', 'epub:-1', 'x', undefined]) expect(resolveMaterialDocumentResume({kind: 'document', section, page: 1}, fingerprint, epub)).toMatchObject({status: 'unlocated'});
        expect(resolveMaterialDocumentResume({kind: 'document', section: '1'}, fingerprint, epub)).toMatchObject({status: 'coarse', page: 1, section: 'epub:1'});
        const segments = Array.from({length: 81}, (_, id) => ({id, source: `Paragraph ${id}`}));
        const docx: ParsedDocument = {fileName: 'book.docx', format: 'docx', label: 'DOCX', parts: [], segments, binary: {kind: 'docx', bytes: new Uint8Array(), parts: [{path: 'word/document.xml', source: '<w:document/>', paragraphSegments: segments.map(({id}) => ({segmentIndex: id, paragraphIndex: id * 2}))}]}};
        const locator = captureDocumentMaterialLocator(fingerprint, docx, 80)!;
        expect(locator.documentReference?.locator.position).toBe('paragraph:160');
        expect(resolveMaterialDocumentResume(locator, fingerprint, docx)).toMatchObject({status: 'exact', section: 'docx:0', page: 2});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'docx:0', page: 2}, fingerprint, docx)).toMatchObject({status: 'coarse', page: 2});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'docx:0', page: 3}, fingerprint, docx)).toMatchObject({status: 'unlocated'});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'docx:1', page: 1}, fingerprint, docx)).toMatchObject({status: 'unlocated'});

        const xlsxSegments = Array.from({length: 82}, (_, id) => ({id, source: `Cell ${id}`}));
        const xlsx: ParsedDocument = {
            fileName: 'sheets.xlsx', format: 'xlsx', label: 'XLSX', parts: [], segments: xlsxSegments,
            binary: {
                kind: 'xlsx', bytes: new Uint8Array(),
                sheets: [
                    {name: 'First', path: 'xl/worksheets/sheet1.xml', source: '<worksheet/>', cellSegments: [{cellRef: 'A1', kind: 'inline', segmentIndex: 0}]},
                    {name: 'Second', path: 'xl/worksheets/sheet2.xml', source: '<worksheet/>', cellSegments: xlsxSegments.slice(1).map(({id}, idx) => ({cellRef: `A${idx + 1}`, kind: 'inline' as const, segmentIndex: id}))},
                ],
            },
        };
        const xlsxLocator = captureDocumentMaterialLocator(fingerprint, xlsx, 81)!;
        expect(xlsxLocator.documentReference?.locator.position).toBe('cell:A81');
        expect(resolveMaterialDocumentResume(xlsxLocator, fingerprint, xlsx)).toMatchObject({status: 'exact', section: 'xlsx:1', page: 2});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'xlsx:1', page: 2}, fingerprint, xlsx)).toMatchObject({status: 'coarse', section: 'xlsx:1', page: 2});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'xlsx:1', page: 3}, fingerprint, xlsx)).toMatchObject({status: 'unlocated'});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'xlsx:2', page: 1}, fingerprint, xlsx)).toMatchObject({status: 'unlocated'});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'bad', page: 1}, fingerprint, xlsx)).toMatchObject({status: 'unlocated'});
    });
    it('rejects invalid capture indexes, missing model membership and broken exact references without page fallback', () => {
        const doc = pdf([['Original', 1, 40]]);
        for (const index of [-1, 1.2, 99]) expect(captureDocumentMaterialLocator(fingerprint, doc, index)).toBeUndefined();
        for (const size of [0, 1.5]) expect(captureDocumentMaterialLocator(fingerprint, doc, 0, size)).toBeUndefined();
        expect(captureDocumentMaterialLocator('config', doc, 0)).toBeUndefined();
        (doc.binary as any).pages[0].segmentIndexes = [];
        expect(captureDocumentMaterialLocator(fingerprint, doc, 0)).toBeUndefined();
        expect(resolveMaterialDocumentResume({kind: 'document', page: 1, documentReference: {version: 2} as any}, fingerprint, doc)).toMatchObject({status: 'unresolved', reason: 'invalid-reference'});
        expect(resolveMaterialDocumentResume({kind: 'document'}, fingerprint, doc, 0)).toMatchObject({reason: 'invalid-position'});
        expect(resolveMaterialDocumentResume({kind: 'text'}, fingerprint, doc)).toMatchObject({reason: 'invalid-position'});
        expect(resolveMaterialDocumentResume(undefined, fingerprint, doc)).toMatchObject({reason: 'no-position'});
        expect(resolveMaterialDocumentResume({kind: 'document', section: 'bad', page: 1}, fingerprint, doc)).toMatchObject({reason: 'invalid-position'});
        for (const page of [0, -1, 1.2, 4]) expect(resolveMaterialDocumentResume({kind: 'document', page}, fingerprint, doc)).toMatchObject({reason: 'invalid-position'});
    });
    it('records oversized explicit source as coarse while exact selection may safely refuse it, and maps plain text pages', () => {
        const doc = pdf([['x'.repeat(12001), 1, 40]]), locator = captureDocumentMaterialLocator(fingerprint, doc, 0)!;
        expect(locator.documentReference).toBeUndefined(); expect(locator.quote).toHaveLength(6000);
        const text = {fileName: 'text.txt', format: 'txt', label: 'TXT', parts: [], segments: Array.from({length: 81}, (_, id) => ({id, source: `Source ${id}`}))} as ParsedDocument;
        expect(resolveMaterialDocumentResume(captureDocumentMaterialLocator(fingerprint, text, 80), fingerprint, text)).toMatchObject({status: 'exact', page: 2});
        expect(resolveMaterialDocumentResume({kind: 'document', page: 2}, fingerprint, text)).toMatchObject({status: 'coarse', page: 2});
    });
});

it('refuses unassigned chapter/part references and null page hints from malformed stored input', () => {
    const base = {fileName: 'broken.epub', format: 'epub', label: 'EPUB', parts: [], segments: [{id: 0, source: 'Unassigned'}]};
    const epub = {...base, binary: {kind: 'epub', chapters: []}} as unknown as ParsedDocument;
    const docx = {...base, format: 'docx', binary: {kind: 'docx', parts: []}} as unknown as ParsedDocument;
    const xlsx = {...base, format: 'xlsx', binary: {kind: 'xlsx', sheets: []}} as unknown as ParsedDocument;
    expect(captureDocumentMaterialLocator(fingerprint, epub, 0)).toBeUndefined();
    expect(captureDocumentMaterialLocator(fingerprint, docx, 0)).toBeUndefined();
    expect(captureDocumentMaterialLocator(fingerprint, xlsx, 0)).toBeUndefined();
    expect(resolveMaterialDocumentResume({kind: 'document', page: null as any}, fingerprint, pdf([['Source', 1, 40]]))).toMatchObject({reason: 'invalid-position'});
    const malformed = pdf([['Source', 1, 40]]); (malformed.binary as any).pages[0].blocks.push({segmentIndex: -1, x: 0, y: 0});
    expect(captureDocumentMaterialLocator(fingerprint, malformed, 0)?.documentReference?.locator.source).toBe('Source');
});
