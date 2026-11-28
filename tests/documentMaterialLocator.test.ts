/**
 * @file tests/documentMaterialLocator.test.ts
 * 文件职责：检验本地材料引用与重解析校订的安全位置契约。
 * 主要内容：覆盖重复文本跨页/跨路径/跨时间定位、首行字形度量变化、重复插删和歧义保留，以及身份隔离与脏快照拒绝。
 * 模块边界：使用受控模型及仓库真实 DOCX/EPUB 文件经生产解析器与内存 IndexedDB 验证匹配，不读取网络、不导出文件，也不把算法通过当成真实浏览器验收。
 */
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {describe, expect, it} from 'vitest';
import {parseDocument, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {createDocumentMaterialReference, documentSourceLocators, matchDocumentSourceLocators, resolveDocumentMaterialReference} from '@/src/features/document-translation/core/materialLocator';
import {parseDocumentFile} from '@/src/features/document-translation/services/binary';
import {createDocumentHistory, restoreDocumentHistoryRevisions, type DocumentHistoryRecord} from '@/src/features/document-translation/services/history';
const materialId = '1234567890abcdef1234567890abcdef';
const text = (sources: string[]): ParsedDocument => ({...parseDocument('paper.txt', ''), segments: sources.map((source, id) => ({id, source}))});
const pdf = (entries: Array<[string, number, number]>): ParsedDocument => {
    const document = text(entries.map(entry => entry[0]));
    document.format = 'pdf';
    document.binary = {kind: 'pdf', bytes: new Uint8Array([1]), pages: [...new Set(entries.map(entry => entry[1]))].map(pageNumber => ({
        pageNumber, width: 600, height: 800, segmentIndexes: [], blocks: entries.flatMap((entry, segmentIndex) => entry[1] !== pageNumber ? [] : [{
            segmentIndex, x: 10, y: entry[2], width: 100, height: 12, fontSize: 10, lineHeight: 12, lineCount: 1,
            fontFamily: 'sans-serif', fontWeight: 400, textAlign: 'left',
            lines: [{x: 10, y: entry[2], baseline: entry[2] + 10, width: 100, height: 12, text: entry[0]}],
        }]),
    }))};
    return document;
};
const saved = (document: ParsedDocument, translations = document.segments.map((_, index) => `Reviewed ${index}`)) => ({parsed: document, total: document.segments.length, translations});

describe('document source location recovery', () => {
    it('keeps duplicate corrections on their exact page and baseline after reorder and removal', () => {
        const previous = pdf([['Repeat', 1, 10], ['Repeat', 2, 10], ['Repeat', 2, 40]]);
        const current = pdf([['Repeat', 2, 40], ['Repeat', 1, 10]]);
        expect(restoreDocumentHistoryRevisions(saved(previous), current, 17)).toEqual({translations: ['Reviewed 2', 'Reviewed 0'], retainedRevisions: [{source: 'Repeat', translation: 'Reviewed 1'}]});
    });
    it('does not apply a unique source correction to a different native page or changed source', () => {
        expect(restoreDocumentHistoryRevisions(saved(pdf([['Same', 1, 10]])), pdf([['Same', 2, 10], ['Same ', 1, 10]]), 17).translations).toEqual(['', '']);
    });
    it('uses baseline rather than font ascent to keep locations stable', () => {
        const old = pdf([['Repeat', 1, 10], ['Repeat', 1, 40]]), current = pdf([['New', 1, 0], ['Repeat', 1, 10], ['Repeat', 1, 40]]);
        if (current.binary?.kind === 'pdf') current.binary.pages[0].blocks.forEach(block => {block.y -= 3; block.lines![0].y -= 3;});
        expect(restoreDocumentHistoryRevisions(saved(old, ['', 'Second']), current, 17).translations).toEqual(['', '', 'Second']);
    });
    it('matches duplicate text only with unique context and retains ambiguous old revisions', () => {
        const old = text(['A', 'Repeat', 'B', 'Repeat', 'C']);
        const current = text(['Inserted', 'A', 'Repeat', 'B', 'Repeat', 'C', 'Repeat']);
        const restored = restoreDocumentHistoryRevisions(saved(old), current, 17);
        expect(restored.translations).toEqual(['', 'Reviewed 0', 'Reviewed 1', 'Reviewed 2', 'Reviewed 3', 'Reviewed 4', '']);
        expect(restoreDocumentHistoryRevisions(saved(text(['Repeat', 'Repeat'])), text(['Repeat']), 17).retainedRevisions).toHaveLength(2);
    });
    it('does not trust unchanged duplicate order across parser versions without native location evidence', () => {
        const previous = text(['Repeat', 'Repeat']);
        const record = {...saved(previous), parsedVersion: 16};
        expect(restoreDocumentHistoryRevisions(record, text(['Repeat', 'Repeat']), 17).translations).toEqual(['', '']);
        expect(restoreDocumentHistoryRevisions(record, text(['Repeat', 'Repeat']), 16).translations).toEqual(['Reviewed 0', 'Reviewed 1']);
        expect(restoreDocumentHistoryRevisions(record, previous, 17).translations).toEqual(['Reviewed 0', 'Reviewed 1']);
        expect(restoreDocumentHistoryRevisions(record, previous, 16, [undefined, undefined]).translations).toEqual(['Reviewed 0', 'Reviewed 1']);
        expect(restoreDocumentHistoryRevisions(record, previous, 16, [1, 0]).translations).toEqual(['Reviewed 1', 'Reviewed 0']);
    });
    it('requires bidirectional uniqueness and never copies one slot to two identical targets', () => {
        expect(matchDocumentSourceLocators(documentSourceLocators(text(['A', 'R', 'B'])), documentSourceLocators(text(['A', 'R', 'B', 'A', 'R', 'B'])))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
        expect(matchDocumentSourceLocators(documentSourceLocators(text(['R'])), documentSourceLocators(text(['R', 'R'])), [0, 0])).toEqual([undefined, undefined]);
    });
    it('refuses direct origins with an explicit conflicting native page while allowing legacy missing scope', () => {
        const previous = pdf([['Same', 1, 10]]), current = pdf([['Same', 2, 10]]);
        expect(restoreDocumentHistoryRevisions(saved(previous), current, 17, [0]).translations).toEqual(['']);
        expect(restoreDocumentHistoryRevisions(saved(text(['Same'])), current, 17, [0]).translations).toEqual(['Reviewed 0']);
    });
    it('uses JSON paths and subtitle timestamps to keep repeated strings distinct', () => {
        const old = text(['Value', 'Value', 'Caption', 'Caption']); old.format = 'json';
        Object.assign(old.segments[0], {pathLabel: '$.left'}); Object.assign(old.segments[1], {pathLabel: '$.right'});
        Object.assign(old.segments[2], {timeStart: '00:01', timeEnd: '00:02'}); Object.assign(old.segments[3], {timeStart: '00:03', timeEnd: '00:04'});
        const current = {...old, segments: [old.segments[3], old.segments[1], old.segments[2], old.segments[0]].map((segment, id) => ({...segment, id}))};
        // path/time scopes alone are full native positions.
        expect(restoreDocumentHistoryRevisions(saved(old), current, 17).translations).toEqual(['Reviewed 3', 'Reviewed 1', 'Reviewed 2', 'Reviewed 0']);
    });
    it('uses only real JSON path labels and ignores display labels in unstructured text', () => {
        const json = {...text(['Empty path', 'Invalid path']), format: 'json' as const};
        Object.assign(json.segments[0], {pathLabel: ''}); Object.assign(json.segments[1], {pathLabel: 12});
        expect(documentSourceLocators(json).map(locator => locator?.scope)).toEqual([undefined, undefined]);
        const displayed = text(['Body']); Object.assign(displayed.segments[0], {pathLabel: '正文'});
        expect(documentSourceLocators(displayed)[0]?.scope).toBeUndefined();
    });
    it('extracts chapter and paragraph scopes without borrowing display labels', () => {
        const epub = text(['Same', 'Same']); epub.binary = {kind: 'epub', bytes: new Uint8Array(), chapters: [
            {path: 'one.xhtml', source: '', title: '', segmentOffset: 0, segmentCount: 1}, {path: 'two.xhtml', source: '', title: '', segmentOffset: 1, segmentCount: 1}]};
        expect(documentSourceLocators(epub).map(locator => locator?.scope)).toEqual(['epub:one.xhtml', 'epub:two.xhtml']);
        const docx = text(['Same', 'Same']); docx.binary = {kind: 'docx', bytes: new Uint8Array(), parts: [{path: 'word/document.xml', source: '', paragraphSegments: [{paragraphIndex: 10, segmentIndex: 0}, {paragraphIndex: 20, segmentIndex: 1}]}]};
        expect(documentSourceLocators(docx).map(locator => locator?.position)).toEqual(['paragraph:10', 'paragraph:20']);
    });
    it('does not turn malformed native geometry, ranges or structural metadata into location evidence', () => {
        expect(documentSourceLocators({segments: null})).toEqual([]);
        const malformed = {segments: [{source: 'Source', pathLabel: '$.conflict'}, {source: 'Other'}], binary: {kind: 'pdf', pages: [{pageNumber: 1, blocks: [
            null, {segmentIndex: 0, x: 10, lines: [{x: 10, y: 5}]}, {segmentIndex: 1, x: Infinity, y: 10}, {segmentIndex: 99, x: 0, y: 0},
        ]}]}};
        const locations = documentSourceLocators(malformed);
        expect(locations[0]).toMatchObject({scope: 'pdf:1', position: '[10,5]'});
        expect(locations[1]).toMatchObject({scope: 'pdf:1'});
        expect(locations[1]?.position).toBeUndefined();
        expect(documentSourceLocators({segments: [{source: 'Source'}], binary: {kind: 'epub', chapters: [null, {path: 'one', segmentOffset: 0, segmentCount: -1}]}})[0]?.scope).toBeUndefined();
        expect(documentSourceLocators({segments: [{source: 'Source'}], binary: {kind: 'docx', parts: [null, {path: 'part', paragraphSegments: [null, {paragraphIndex: -1, segmentIndex: 0}]}]}})[0]?.scope).toBeUndefined();
    });
    it('rejects duplicate native assignments and ignores invalid snapshot entries', () => {
        const document = pdf([['Repeat', 1, 10]]);
        if (document.binary?.kind === 'pdf') document.binary.pages[0].blocks.push({...document.binary.pages[0].blocks[0], y: 40});
        expect(documentSourceLocators(document)[0]?.scope).toBe('ambiguous');
        expect(documentSourceLocators({segments: [null, 12, {source: 3}, {source: ''}], binary: {kind: 'pdf', pages: [null, {pageNumber: -1}]}})).toEqual([undefined, undefined, undefined, {version: 1, source: '', before: undefined, after: undefined}]);
    });
});

async function parsedSample(name: 'sample.docx' | 'sample.epub') {
    const bytes = Uint8Array.from(readFileSync(new URL(`./fixtures/document-translation/${name}`, import.meta.url)));
    const document = await parseDocumentFile({name, arrayBuffer: async () => bytes.slice().buffer, text: async () => {throw new Error('Binary fixture must use its actual bytes');}});
    return {bytes, document};
}

describe('real parsed binary document locations', () => {
    it.each([['sample.docx', 17], ['sample.docx', 18], ['sample.epub', 17], ['sample.epub', 18]] as const)('restores real parsed %s corrections through IndexedDB at parser version %s', async (name, currentVersion) => {
        const {bytes, document} = await parsedSample(name);
        const history = createDocumentHistory(new IDBFactory());
        const translations = document.segments.map((segment, index) => `真实校订${index}：${segment.source}`);
        const record: DocumentHistoryRecord = {id: materialId, name, format: document.format, size: bytes.length, total: translations.length,
            completed: translations.length, updatedAt: 1, bytes, mimeType: name.endsWith('docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/epub+zip',
            translations, fingerprint: '', parsed: document, parsedVersion: 17};
        expect(await history.save(record)).toBe(true);
        const stored = (await history.load(materialId))!;
        const current = (await parsedSample(name)).document;
        expect(restoreDocumentHistoryRevisions(stored, current, currentVersion)).toEqual({translations, retainedRevisions: []});
    });
    it.each(['sample.docx', 'sample.epub'] as const)('resolves a self-reference in real parsed %s despite human-readable location labels', async name => {
        const {document} = await parsedSample(name);
        if (name === 'sample.docx') expect(document.segments.some(segment => segment.pathLabel === '正文')).toBe(true);
        expect(document.segments.length).toBeGreaterThan(1);
        document.segments.forEach((_segment, index) => {
            const reference = createDocumentMaterialReference(materialId, document, index)!;
            expect(resolveDocumentMaterialReference(reference, materialId, document)).toBe(index);
        });
    });
});

describe('local document material references', () => {
    it('resolves repeated text after reordering only in the same material and exact position', () => {
        const previous = pdf([['Same', 1, 10], ['Same', 2, 10]]);
        const reference = createDocumentMaterialReference(materialId, previous, 1)!;
        expect(reference).not.toHaveProperty('fileName');
        expect(resolveDocumentMaterialReference(reference, materialId, pdf([['Same', 2, 10], ['Same', 1, 10]]))).toBe(0);
        expect(resolveDocumentMaterialReference(reference, materialId, pdf([['Same', 1, 10]]))).toBeUndefined();
        expect(resolveDocumentMaterialReference(reference, 'another-material', previous)).toBeUndefined();
        expect(createDocumentMaterialReference('file-name.pdf', previous, 0)).toBeUndefined();
        expect(resolveDocumentMaterialReference({...reference, materialId: ''}, '', previous)).toBeUndefined();
        expect(createDocumentMaterialReference(materialId, previous, 99)).toBeUndefined();
    });
    it.each([null, undefined, {}, {version: 1}, {version: 1, locator: null},
        {version: 1, materialId, locator: {version: 1, source: 12}},
        {version: 1, materialId, locator: {version: 2, source: 'Same'}},
        {version: 1, materialId, locator: {version: 1, source: 'Same', before: {unsafe: true}}}])('refuses malformed persisted references: %j', reference => {
        expect(resolveDocumentMaterialReference(reference as any, materialId, text(['Same']))).toBeUndefined();
    });
    it('refuses a deleted original duplicate even when a different occurrence becomes the only current candidate', () => {
        const reference = createDocumentMaterialReference(materialId, text(['A', 'Same', 'B', 'C', 'Same', 'D']), 1)!;
        expect(resolveDocumentMaterialReference(reference, materialId, text(['A', 'B', 'C', 'Same', 'D']))).toBeUndefined();
        expect(resolveDocumentMaterialReference(reference, materialId, text(['A', 'Same', 'B', 'C', 'D']))).toBe(1);
    });
    it('does not create recoverable references when source and neighboring context are both ambiguous already', () => {
        const repeatedContexts = text(['A', 'Same', 'B', 'A', 'Same', 'B']);
        expect(createDocumentMaterialReference(materialId, repeatedContexts, 1)).toBeUndefined();
        expect(createDocumentMaterialReference(materialId, repeatedContexts, 4)).toBeUndefined();
        const malformed = pdf([['Same', 1, 10]]);
        if (malformed.binary?.kind === 'pdf') malformed.binary.pages[0].blocks.push({...malformed.binary.pages[0].blocks[0]});
        expect(createDocumentMaterialReference(materialId, malformed, 0)).toBeUndefined();
    });
    it('keeps an originally unique exact source usable after neighboring text changes while refusing changed source and new ambiguity', () => {
        const reference = createDocumentMaterialReference(materialId, text(['A', 'Unique', 'B']), 1)!;
        expect(resolveDocumentMaterialReference(reference, materialId, text(['Changed A', 'Unique', 'Changed B']))).toBe(1);
        expect(resolveDocumentMaterialReference(reference, materialId, text(['Changed A', 'unique', 'Changed B']))).toBeUndefined();
        expect(resolveDocumentMaterialReference(reference, materialId, text(['X', 'Unique', 'Y', 'Z', 'Unique', 'W']))).toBeUndefined();
    });
    it('keeps legacy exact native positions but requires saved context for unstructured references without occurrence evidence', () => {
        const native = createDocumentMaterialReference(materialId, pdf([['Same', 1, 10], ['Same', 2, 10]]), 1)!;
        delete native.locatorOccurrences;
        expect(resolveDocumentMaterialReference(native, materialId, pdf([['Same', 2, 10], ['Same', 1, 10]]))).toBe(0);
        const json = parseDocument('source.json', '{"left":"Same","right":"Same"}');
        const structured = createDocumentMaterialReference(materialId, json, 0)!; delete structured.locatorOccurrences;
        expect(resolveDocumentMaterialReference(structured, materialId, parseDocument('source.json', '{"right":"Same","left":"Same"}'))).toBe(1);
        const contextual = createDocumentMaterialReference(materialId, text(['A', 'Same', 'B']), 1)!; delete contextual.locatorOccurrences;
        expect(resolveDocumentMaterialReference(contextual, materialId, text(['A', 'Same', 'B']))).toBe(1);
        expect(resolveDocumentMaterialReference(contextual, materialId, text(['Changed A', 'Same', 'Changed B']))).toBeUndefined();
        const single = createDocumentMaterialReference(materialId, text(['Same']), 0)!; delete single.locatorOccurrences;
        expect(resolveDocumentMaterialReference(single, materialId, text(['Same']))).toBe(0);
    });
    it('keeps document-edge context significant when an original duplicate becomes unique', () => {
        const reference = createDocumentMaterialReference(materialId, text(['Same', 'B', 'Same', 'D']), 0)!;
        expect(resolveDocumentMaterialReference(reference, materialId, text(['Same', 'B', 'C']))).toBe(0);
        expect(resolveDocumentMaterialReference(reference, materialId, text(['B', 'Same', 'D']))).toBeUndefined();
    });
    it.each([0, -1, 1.5, Infinity, '2'])('rejects corrupt persisted occurrence counts: %s', locatorOccurrences => {
        const reference = createDocumentMaterialReference(materialId, text(['Same']), 0)!;
        expect(resolveDocumentMaterialReference({...reference, locatorOccurrences} as any, materialId, text(['Same']))).toBeUndefined();
    });
    it('counts only valid locator candidates in a partially corrupt source snapshot', () => {
        const document = {...text(['Same']), segments: [null, {id: 1, source: 'Same'}]} as unknown as ParsedDocument;
        const reference = createDocumentMaterialReference(materialId, document, 1)!;
        expect(reference.locatorOccurrences).toBe(1);
        expect(resolveDocumentMaterialReference(reference, materialId, document)).toBe(1);
    });
    it('uses two-sided context for repeated unstructured text and refuses ambiguous references', () => {
        const reference = createDocumentMaterialReference(materialId, text(['A', 'Same', 'B']), 1)!;
        expect(resolveDocumentMaterialReference(reference, materialId, text(['Same', 'A', 'Same', 'B']))).toBe(2);
        expect(resolveDocumentMaterialReference(reference, materialId, text(['Same', 'Same']))).toBeUndefined();
        expect(resolveDocumentMaterialReference({...reference, version: 2 as any}, materialId, text(['Same']))).toBeUndefined();
    });

    it('caches documentSourceLocators per snapshot and invalidates on format, segment, or binary structure changes', () => {
        const doc = pdf([['First', 1, 10], ['Second', 1, 40]]);
        const first = documentSourceLocators(doc);
        expect(Object.isFrozen(first)).toBe(true);
        expect(documentSourceLocators(doc)).toBe(first);

        // In-place push to binary.pages invalidates via binaryStructureLength.
        if (doc.binary?.kind !== 'pdf') throw new Error('expected pdf');
        doc.binary.pages.push({...doc.binary.pages[0], pageNumber: 3, blocks: []});
        const afterPagePush = documentSourceLocators(doc);
        expect(afterPagePush).not.toBe(first);
        expect(documentSourceLocators(doc)).toBe(afterPagePush);

        // Replacing pages reference invalidates PDF cache.
        doc.binary.pages = [{...doc.binary.pages[0], pageNumber: 2}];
        const afterPages = documentSourceLocators(doc);
        expect(afterPages).not.toBe(afterPagePush);
        expect(afterPages[0]?.scope).toBe('pdf:2');
        expect(documentSourceLocators(doc)).toBe(afterPages);

        // Pushing to segments invalidates via segmentCount.
        (doc.segments as Array<{id: number; source: string}>).push({id: 2, source: 'Third'});
        const afterPush = documentSourceLocators(doc);
        expect(afterPush).not.toBe(afterPages);
        expect(afterPush).toHaveLength(3);

        // Replacing segments reference invalidates.
        doc.segments = [{id: 0, source: 'Replaced'}];
        const afterSegments = documentSourceLocators(doc);
        expect(afterSegments).not.toBe(afterPush);
        expect(afterSegments[0]?.source).toBe('Replaced');

        // Replacing binary and format invalidates.
        delete doc.binary;
        doc.format = 'json';
        doc.segments[0].pathLabel = '$.root';
        const afterFormat = documentSourceLocators(doc);
        expect(afterFormat).not.toBe(afterSegments);
        expect(afterFormat[0]?.scope).toBe('path:$.root');
        doc.format = 'txt';
        const afterTxt = documentSourceLocators(doc);
        expect(afterTxt).not.toBe(afterFormat);
        expect(afterTxt[0]?.scope).toBeUndefined();
    });
});
