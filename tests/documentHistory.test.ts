/**
 * @file tests/documentHistory.test.ts
 * 文件职责：验证“最近翻译”的本地存取与解析迁移：稳定标识、摘要列表、按原文恢复独立校订、淘汰与存储不可用时的安静降级。
 * 主要内容：使用内存 IndexedDB 真实执行读写；检查解析版本和分段位置变化时只复用未变化原文，重复片段仅凭唯一位置或邻文恢复而不跳过空译文，没有旧原文时仅采用同版本同数量的兼容恢复；检查列表不含文件字节并按最近更新时间排序，保存的是调用方数据的副本，重译缓存策略只保留显式 true，条数与总字节超限时淘汰最旧记录，过大或没有标识的记录不保存，数据库缺失或出错时返回空结果而不抛出。
 * 模块边界：只测试历史存储服务，不挂载页面、不解析文档、不发起翻译。
 */
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';
import {describe, expect, it, vi} from 'vitest';
import {parseDocument, type ParsedDocument, type PdfDocumentBlock, type PdfDocumentLine} from '@/src/features/document-translation/core/document';
import {createDocumentHistory, documentHistoryId, documentHistoryVersion, restoreDocumentHistoryPdfOcr, restoreDocumentHistoryRevisions, DOCUMENT_HISTORY_MAX_BYTES, DOCUMENT_HISTORY_MAX_ENTRIES, type DocumentHistoryRecord} from '@/src/features/document-translation/services/history';

const record = (id: string, updatedAt: number, extra: Partial<DocumentHistoryRecord> = {}): DocumentHistoryRecord => ({id, name: `${id}.pdf`, format: 'pdf', size: 3, total: 4, completed: 2, updatedAt,
    bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', translations: ['甲', '', '丙', ''], fingerprint: 'fp', ...extra});
const parsed = (sources: string[]) => ({...parseDocument('restored.txt', ''), segments: sources.map((source, id) => ({id, source}))});
const pdf = (pageSources: Array<string[] | null>) => {
    const segments: Array<{id: number; source: string}> = [];
    const pages = pageSources.map((sources, index) => {
        const blocks = (sources ?? []).map((source, position) => {
            const id = segments.length;
            segments.push({id, source});
            return {segmentIndex: id, x: 10, y: 10 + position * 30, width: 80, height: 12, fontSize: 11, lineHeight: 12,
                lineCount: 1, fontFamily: 'sans-serif', fontWeight: 400 as const, textAlign: 'left' as const};
        });
        return {pageNumber: index + 1, width: 100, height: 100, blocks, segmentIndexes: blocks.map(block => block.segmentIndex), ...(sources === null ? {scanned: true} : {})};
    });
    return {...parsed([]), format: 'pdf' as const, segments, binary: {kind: 'pdf' as const, bytes: new Uint8Array([1, 2, 3]), pages}};
};

const pdfTextSplit = () => {
    const previous = pdf([['Left', 'Middle', 'Right', 'End']]), current = pdf([['Left Middle Right End']]);
    const oldBlocks = previous.binary.pages[0].blocks as PdfDocumentBlock[];
    const freshBlock = current.binary.pages[0].blocks[0] as PdfDocumentBlock;
    const lines = oldBlocks.map((block, index): PdfDocumentLine => {
        const run = {x: block.x, y: 24 + index * 14 - 8.8, width: 80, height: 11,
            baseline: 24 + index * 14, fontSize: 11, fontFamily: 'sans-serif', text: previous.segments[index].source};
        return {...run, runs: [{...run}]};
    });
    oldBlocks.forEach((block, index) => Object.assign(block, {kind: 'text', y: lines[index].baseline,
        lines: [{...lines[index], y: lines[index].baseline!, runs: [{...lines[index].runs![0], y: lines[index].baseline!}]}]}));
    Object.assign(freshBlock, {kind: 'text', y: lines[0].y, height: lines[3].y + lines[3].height - lines[0].y,
        lines, lineCount: lines.length, lineHeight: 14, readingOrder: 2});
    const saved = record('geometry', 1, {parsed: previous, translations: ['左段校订', '', '右段校订', '末段校订']});
    return {previous, current, oldBlocks, freshBlock, saved};
};

describe('document history translation migration', () => {
    it('restores by source after a reorder even when the version and segment count still match', () => {
        const saved = record('reordered', 1, {parsed: parsed(['First', 'Second']), parsedVersion: 7, total: 2, translations: ['第一段校订', '第二段校订']});
        const before = JSON.stringify(saved);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Second', 'First']), 7).translations).toEqual(['第二段校订', '第一段校订']);
        expect(JSON.stringify(saved)).toBe(before);
    });
    it('keeps unchanged sources across inserted, removed and changed segments without synthesizing a merged translation', () => {
        const saved = record('changed', 1, {parsed: parsed(['Left', 'Right', 'Case', ' Spaced ']), parsedVersion: 6, total: 4,
            translations: ['左侧校订', '右侧校订', '大小写校订', '空格校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Inserted', 'Right', 'Left Right', 'case', 'Spaced', 'Left']), 7).translations)
            .toEqual(['', '右侧校订', '', '', '', '左侧校订']);
    });
    it('retains ambiguous duplicate revisions instead of guessing occurrence order after insertion or removal', () => {
        const saved = record('duplicates', 1, {parsed: parsed(['Repeat', 'Between', 'Repeat', 'Repeat']), total: 4,
            translations: ['第一次校订', '中间校订', '第二次校订', '第三次校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'Repeat']), 7).translations).toEqual(['', '']);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'New', 'Repeat', 'Between', 'Repeat', 'Repeat']), 7).translations)
            .toEqual(['', '', '', '中间校订', '第二次校订', '']);
    });
    it('consumes empty and whitespace duplicate slots without borrowing later completed revisions', () => {
        const saved = record('empty-duplicates', 1, {parsed: parsed(['Repeat', 'Repeat', 'Repeat', 'Sparse']), parsedVersion: 7, total: 4,
            translations: ['', ' \n ', '第三次校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'Repeat', 'Repeat', 'Sparse']), 7).translations)
            .toEqual(['', ' \n ', '第三次校订', '']);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat']), 7).translations).toEqual(['']);
    });
    it.each([NaN, Infinity, -1, 1.5])('refuses order compatibility for unlocated duplicates with an invalid parser version: %s', currentVersion => {
        const saved = record('invalid-source-order-version', 1, {parsed: parsed(['Repeat', 'Repeat']), parsedVersion: currentVersion,
            total: 2, translations: ['第一页独立校订', '第二页独立校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'Repeat']), currentVersion)).toEqual({translations: ['', ''], retainedRevisions: [
            {source: 'Repeat', translation: '第一页独立校订'}, {source: 'Repeat', translation: '第二页独立校订'},
        ]});
    });
    it('uses stored segment identifiers and tolerates legacy source snapshots without identifiers', () => {
        const saved = record('identifiers', 1, {parsed: {segments: [{id: 2, source: 'Third slot'}, {id: 0, source: 'First slot'}, {id: 99, source: 'Missing slot'}]},
            total: 3, translations: ['第一槽校订', '', '第三槽校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['First slot', 'Third slot', 'Missing slot']), 7).translations)
            .toEqual(['第一槽校订', '第三槽校订', '']);
        const legacy = record('legacy-identifiers', 1, {parsed: {segments: [{source: 'Legacy slot'}, {id: -1, source: 'Invalid id'}, {id: 1.5, source: 'Fractional id'}]},
            total: 3, translations: ['旧索引校订', '负标识校订', '非整数标识校订']});
        expect(restoreDocumentHistoryRevisions(legacy, parsed(['Invalid id', 'Fractional id', 'Legacy slot']), 7).translations)
            .toEqual(['负标识校订', '非整数标识校订', '旧索引校订']);
    });
    it('does not fall back to indexes when only part of the old source snapshot is usable', () => {
        const saved = record('partial-snapshot', 1, {parsed: {segments: [null, 12, {source: 'Known'}, {source: ''}]},
            parsedVersion: 7, total: 4, translations: ['错位旧译文', '另一错位旧译文', '已知校订', '空原文校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Unknown', '', 'Known', 'Different']), 7).translations)
            .toEqual(['', '空原文校订', '已知校订', '']);
        expect(restoreDocumentHistoryRevisions(saved, parsed([]), 7).translations).toEqual([]);
    });
    it('reserves reused OCR occurrences before native matching, including empty revisions and non-contiguous legacy identifiers', () => {
        const saved = record('direct-duplicates', 1, {parsed: {segments: [{id: 2, source: 'Repeat'}, {id: 0, source: 'Repeat'}, {id: 1, source: 'Repeat'}]},
            translations: ['', '第二扫描页独立校订', '文字页校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'Repeat', 'Repeat']), 7, [undefined, 1, 2]).translations)
            .toEqual(['文字页校订', '', '第二扫描页独立校订']);
    });
    it('ignores invalid or mismatched direct origins rather than assigning another source revision', () => {
        const saved = record('invalid-origins', 1, {parsed: {segments: [null, 12, {source: 'Different'}, {source: 'Same'}]},
            translations: ['空对象不能套译文', '数字不能套译文', '另一原文校订', '同原文校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Same', 'Same', 'Same', 'Same', 'Same', 'Same', 'Same', 'Same']), 7,
            [-1, 1.5, NaN, 99, 0, 1, 2, '3' as any]).translations).toEqual(['', '', '', '', '', '', '', '']);
    });
    it.each([undefined, null, 12, 'old snapshot', {}, {segments: null}, {segments: []}, {segments: [null, {source: 12}]}])
        ('allows index compatibility only for missing sources from the same known parsing version: %j', snapshot => {
            const saved = record('legacy', 1, {parsed: snapshot, parsedVersion: 7, total: 2, translations: ['第一槽校订']});
            expect(restoreDocumentHistoryRevisions(saved, parsed(['First', 'Second']), 7).translations).toEqual(['第一槽校订', '']);
        });
    it.each([
        {parsedVersion: undefined, currentVersion: 7, total: 2},
        {parsedVersion: 6, currentVersion: 7, total: 2},
        {parsedVersion: 7, currentVersion: 7, total: 3},
        {parsedVersion: Infinity, currentVersion: Infinity, total: 2},
        {parsedVersion: -1, currentVersion: -1, total: 2},
        {parsedVersion: 1.5, currentVersion: 1.5, total: 2},
    ])('refuses unsafe index recovery with unknown versions or mismatched counts: %j', ({parsedVersion, currentVersion, total}) => {
        const saved = record('unsafe', 1, {parsedVersion, total, translations: ['错位旧译文', '另一错位旧译文']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['First', 'Second']), currentVersion).translations).toEqual(['', '']);
    });
});

describe('document history retained revisions', () => {
    it('archives only unconsumed independent slots and reserves direct origins including empty revisions', () => {
        const saved = record('unmatched', 1, {parsed: parsed(['Left', 'Right', 'Repeat', 'Repeat']), parsedVersion: 16,
            translations: ['左侧校订', '右侧校订', '', '第二次独立校订']});
        const result = restoreDocumentHistoryRevisions(saved, parsed(['Repeat', 'Right']), 16, [2, undefined]);
        expect(result.translations).toEqual(['', '右侧校订']);
        expect(result.retainedRevisions).toEqual([{source: 'Left', translation: '左侧校订'}, {source: 'Repeat', translation: '第二次独立校订'}]);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Repeat']), 16).retainedRevisions)
            .toEqual([{source: 'Left', translation: '左侧校订'}, {source: 'Right', translation: '右侧校订'}, {source: 'Repeat', translation: '第二次独立校订'}]);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Left', 'Right', 'Repeat', 'Repeat']), 16).retainedRevisions).toEqual([]);
    });

    it('keeps removed revisions as separate source pairs without synthesizing a merged translation', () => {
        const previous = {segments: [{id: 2, source: 'Left', contextLabel: '第 3 页'}, {id: 0, source: 'Right'}, {source: 'Legacy'}]};
        const saved = record('separate', 1, {parsed: previous, translations: ['右侧校订', '', '左侧校订']});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Left Right']), 16)).toEqual({translations: [''], retainedRevisions: [
            {source: 'Left', translation: '左侧校订', contextLabel: '第 3 页'}, {source: 'Right', translation: '右侧校订'}, {source: 'Legacy', translation: '左侧校订'},
        ]});
    });

    it('merges existing retained material, validates dirty data and deduplicates complete source/translation/context pairs', () => {
        const saved = record('dirty', 1, {parsed: {segments: [null, 12, {source: 12}, {source: '  '}, {source: 'Missing'},
            {source: 'Duplicate', contextLabel: '  第 2 页  '}, {source: 'Empty'}, {source: 'Other', contextLabel: 9}]},
            translations: ['skip', 'skip', 'skip', 'skip', undefined as any, '独立校订', ' \n ', '其它校订'],
            retainedRevisions: [null, 12, {source: 'Duplicate', translation: '独立校订', contextLabel: '第 2 页'},
                {source: 'Duplicate', translation: '独立校订', contextLabel: '第 2 页'}, {source: '', translation: 'skip'},
                {source: 'Invalid', translation: 12}, {source: ' Spaced ', translation: '  保留换行\n '}, {source: 'No translation', translation: '  '}] as any});
        const before = JSON.stringify(saved);
        const result = restoreDocumentHistoryRevisions(saved, parsed(['Fresh']), 16);
        expect(result).toEqual({translations: [''], retainedRevisions: [
            {source: 'Duplicate', translation: '独立校订', contextLabel: '第 2 页'},
            {source: ' Spaced ', translation: '  保留换行\n '}, {source: 'Other', translation: '其它校订'},
        ]});
        result.retainedRevisions[0].translation = 'changed';
        expect(JSON.stringify(saved)).toBe(before);
    });

    it.each([undefined, null, 12, {}, {segments: null}])('does not fabricate source material for unavailable or corrupt snapshots: %j', snapshot => {
        const saved = record('no-source', 1, {parsed: snapshot, translations: null as any, retainedRevisions: 12 as any});
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Fresh']), 16)).toEqual({translations: [''], retainedRevisions: []});
    });

    it('keeps already saved revisions through reopening without duplicating normal matching translations', async () => {
        const history = createDocumentHistory(new IDBFactory());
        const retained = [{source: 'otherwise.', translation: '否则。', contextLabel: '第 16 页'}];
        const pending = history.save(record('retained', 1, {parsed: parsed(['Normal']), translations: ['正常校订'], retainedRevisions: retained}));
        retained[0].translation = 'changed'; retained.push({source: 'late', translation: 'late', contextLabel: ''});
        expect(await pending).toBe(true);
        const saved = (await history.load('retained'))!;
        expect(saved.retainedRevisions).toEqual([{source: 'otherwise.', translation: '否则。', contextLabel: '第 16 页'}]);
        expect(restoreDocumentHistoryRevisions(saved, parsed(['Normal']), 16)).toEqual({translations: ['正常校订'], retainedRevisions: saved.retainedRevisions});
        await history.save(record('empty-retained', 2));
        expect((await history.load('empty-retained'))!.retainedRevisions).toEqual([]);
    });
});

describe('document history PDF geometry migration', () => {
    it('keeps independent old slots using only corrected fresh lines and bounds', () => {
        const {previous, current, oldBlocks, freshBlock, saved} = pdfTextSplit();
        const before = JSON.stringify({previous, current, saved});
        const {document, segmentOrigins} = restoreDocumentHistoryPdfOcr(saved, current);
        expect(document.segments.map(segment => segment.source)).toEqual(previous.segments.map(segment => segment.source));
        expect(segmentOrigins).toEqual([0, 1, 2, 3]);
        expect(restoreDocumentHistoryRevisions(saved, document, 16, segmentOrigins).translations).toEqual(saved.translations);
        if (document.binary?.kind !== 'pdf') throw new Error('expected PDF');
        expect(document.binary.bytes).toBe(current.binary.bytes);
        expect(document.binary.pages[0].segmentIndexes).toEqual([0, 1, 2, 3]);
        document.binary.pages[0].blocks.forEach((block, index) => {
            expect(block.lines![0]).toBe(freshBlock.lines![index]);
            expect(block.y).toBe(freshBlock.lines![index].y);
            expect(block.y).not.toBe(oldBlocks[index].y);
            expect(block.height).toBeCloseTo(11, 10);
            expect(block.lineCount).toBe(1);
            expect(block.lineHeight).toBe(11);
            expect(block.readingOrder).toBe(2 + index / 4);
        });
        expect(JSON.stringify({previous, current, saved})).toBe(before);
    });

    it('rebuilds multiline old paragraphs and leaves unrelated fresh blocks untouched', () => {
        const {previous, current, oldBlocks, freshBlock, saved} = pdfTextSplit();
        oldBlocks[1].lines!.push(...oldBlocks[2].lines!);
        oldBlocks[1].lineCount = 2;
        previous.segments[1].source = 'Middle Right';
        previous.binary.pages[0].blocks.splice(2, 1);
        current.binary.pages[0].blocks.push({...freshBlock, kind: 'heading', segmentIndex: 1, lines: undefined, lineCount: 1} as any);
        current.segments.push({id: 1, source: 'New heading'});
        delete freshBlock.readingOrder;
        const {document, segmentOrigins} = restoreDocumentHistoryPdfOcr(saved, current);
        expect(document.segments.map(segment => segment.source)).toEqual(['Left', 'Middle Right', 'End', 'New heading']);
        expect(segmentOrigins).toEqual([0, 1, 3, undefined]);
        if (document.binary?.kind !== 'pdf') throw new Error('expected PDF');
        expect(document.binary.pages[0].blocks[1]).toMatchObject({lineCount: 2, lineHeight: 14});
        expect(document.binary.pages[0].blocks[1].lines).toEqual(freshBlock.lines!.slice(1, 3));
        expect(document.binary.pages[0].blocks[0]).not.toHaveProperty('readingOrder');
        expect(restoreDocumentHistoryRevisions(saved, document, 16, segmentOrigins).translations).toEqual(['左段校订', '', '末段校订', '']);
    });

    it.each([
        ['changed record bytes', (f: ReturnType<typeof pdfTextSplit>) => {f.saved.bytes[0] = 9;}],
        ['changed snapshot bytes', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.bytes[0] = 9;}],
        ['different page', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.pages[0].pageNumber = 2;}],
        ['different width', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.pages[0].width += 1;}],
        ['different rotation', (f: ReturnType<typeof pdfTextSplit>) => {Object.assign(f.previous.binary.pages[0], {rotation: 90});}],
        ['unrecognized scan', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.pages[0].scanned = true;}],
        ['old formula', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].kind = 'formula';}],
        ['old table', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].kind = 'table';}],
        ['old preservation', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].preserveSource = true;}],
        ['old cell', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].cellBounds = {x: 0, y: 0, width: 100, height: 100};}],
        ['intervening formula', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.pages[0].blocks.splice(1, 0, {...f.oldBlocks[0], kind: 'formula', segmentIndex: -1} as any);}],
        ['fresh caption', (f: ReturnType<typeof pdfTextSplit>) => {f.freshBlock.kind = 'caption';}],
        ['missing old lines', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines = undefined;}],
        ['empty old lines', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines = [];}],
        ['wrong line count', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lineCount = 2;}],
        ['missing old runs', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].runs = undefined;}],
        ['empty old runs', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].runs = [];}],
        ['changed old run text', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].runs![0].text = 'Changed';}],
        ['invalid old run height', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].runs![0].height = 0;}],
        ['changed old baseline', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].baseline! += 1;}],
        ['changed old advance', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].width += 1;}],
        ['changed first-line x', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[0].lines![0].x += 1;}],
        ['changed old font size', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].lines![0].fontSize! += 1;}],
        ['changed column', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].column = 1;}],
        ['changed font family', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].fontFamily = 'serif';}],
        ['changed alignment', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks[1].textAlign = 'right';}],
        ['changed source', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.segments[1].source = 'MIDDLE';}],
        ['unknown old ID', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.segments[1].id = 9;}],
        ['unknown fresh ID', (f: ReturnType<typeof pdfTextSplit>) => {f.current.segments[0].id = 9;}],
        ['missing fresh line', (f: ReturnType<typeof pdfTextSplit>) => {f.freshBlock.lines![1] = null as any;}],
        ['invalid fresh geometry', (f: ReturnType<typeof pdfTextSplit>) => {f.freshBlock.lines![1].height = NaN;}],
        ['missing fresh baseline', (f: ReturnType<typeof pdfTextSplit>) => {f.freshBlock.lines![1].baseline = undefined;}],
        ['incomplete coverage', (f: ReturnType<typeof pdfTextSplit>) => {f.previous.binary.pages[0].blocks.pop();}],
        ['source-only concatenation', (f: ReturnType<typeof pdfTextSplit>) => {f.freshBlock.lines![1].runs![0].x += 1;}],
        ['ambiguous geometry', (f: ReturnType<typeof pdfTextSplit>) => {f.oldBlocks.push(...structuredClone(f.oldBlocks));}],
    ])('refuses unsafe ordinary-text geometry migration: %s', (_name, change) => {
        const fixture = pdfTextSplit();
        change(fixture);
        expect(restoreDocumentHistoryPdfOcr(fixture.saved, fixture.current).document).toBe(fixture.current);
    });

    it.runIf(Boolean(process.env.FLUENTREAD_HARNESS_PDF && process.env.FLUENTREAD_HARNESS_LAYOUT_OLD && process.env.FLUENTREAD_HARNESS_LAYOUT_FIXED))('retains the independent Harness revisions without reviving changed formula sources', async () => {
        const {readFileSync} = await import('node:fs');
        const previous = JSON.parse(readFileSync(process.env.FLUENTREAD_HARNESS_LAYOUT_OLD!, 'utf8')) as ParsedDocument;
        const current = JSON.parse(readFileSync(process.env.FLUENTREAD_HARNESS_LAYOUT_FIXED!, 'utf8')) as ParsedDocument;
        if (previous.binary?.kind !== 'pdf' || current.binary?.kind !== 'pdf') throw new Error('expected PDF');
        const bytes = new Uint8Array(readFileSync(process.env.FLUENTREAD_HARNESS_PDF!));
        previous.binary.bytes = bytes.slice(); current.binary.bytes = bytes.slice();
        const translations = previous.segments.map((_segment, index) => index === 104 ? '' : `Reviewed ${index}`);
        const saved = record('harness', 1, {bytes, parsed: previous, total: previous.segments.length, translations});
        const {document, segmentOrigins} = restoreDocumentHistoryPdfOcr(saved, current);
        const expectedBySource = new Map<string, string[]>();
        previous.segments.forEach((segment, index) => {const slots = expectedBySource.get(segment.source) ?? []; slots.push(translations[index]); expectedBySource.set(segment.source, slots);});
        const restoredTranslations = restoreDocumentHistoryRevisions(saved, document, 16, segmentOrigins).translations;
        expect(restoredTranslations).toEqual(document.segments.map(segment => expectedBySource.get(segment.source)?.shift() ?? ''));
        for (const origin of [103, 104, 105, 106]) {
            const index = segmentOrigins!.indexOf(origin);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(document.segments[index].source).toBe(previous.segments[origin].source);
            expect(restoredTranslations[index]).toBe(translations[origin]);
        }
        if (document.binary?.kind !== 'pdf') throw new Error('expected PDF');
        const repaired = document.binary.pages[7].blocks.filter(block => [103, 104, 105, 106].includes(segmentOrigins![block.segmentIndex]!));
        expect(repaired.map(block => block.lineCount)).toEqual([1, 7, 1, 1]);
        expect(repaired.flatMap(block => block.lines)).toEqual(current.binary.pages[7].blocks.find(block => block.segmentIndex === 103)!.lines);
        expect(repaired.every(block => block.y < block.lines![0].baseline!)).toBe(true);
        const recovery = restoreDocumentHistoryRevisions(saved, document, 16, segmentOrigins);
        expect(recovery.translations).toEqual(restoredTranslations);
        expect(recovery.retainedRevisions).toEqual([{source: 'otherwise.', translation: 'Reviewed 213'}]);
        expect(restoredTranslations.filter(value => value.trim()).length + recovery.retainedRevisions.length).toBe(translations.filter(value => value.trim()).length);
    });
});

describe('document history scanned-PDF migration', () => {
    it('reuses recognized scans in page order while keeping newly parsed native pages and original current bytes', () => {
        const current = pdf([['New native'], null, null]);
        current.binary.pages[2] = {...current.binary.pages[2], rotation: 90} as any;
        const previous = pdf([['Old native'], ['First OCR'], ['Second OCR']]);
        previous.binary.pages[1].scanned = false;
        previous.binary.pages[1].blocks.push({...previous.binary.pages[1].blocks[0], segmentIndex: -1});
        previous.binary.pages[2] = {...previous.binary.pages[2], scanned: false, sourceRotation: 90} as any;
        const saved = record('mixed', 1, {bytes: previous.binary.bytes, parsed: previous, translations: ['旧文字页校订', '第一页扫描校订', '第二页扫描校订']});
        const before = JSON.stringify(saved);
        const {document: restored, segmentOrigins} = restoreDocumentHistoryPdfOcr(saved, current);
        expect(restored.segments.map(segment => segment.source)).toEqual(['New native', 'First OCR', 'Second OCR']);
        expect(restored.binary?.bytes).toBe(current.binary.bytes);
        if (restored.binary?.kind !== 'pdf') throw new Error('expected PDF');
        expect(restored.binary.pages.map(page => page.segmentIndexes)).toEqual([[0], [1], [2]]);
        expect(restored.binary.pages[1].blocks.map(block => block.segmentIndex)).toEqual([1, -1]);
        expect(restored.binary.pages[2]).toMatchObject({sourceRotation: 90, scanned: false});
        expect(segmentOrigins).toEqual([undefined, 1, 2]);
        expect(restoreDocumentHistoryRevisions(saved, restored, 7, segmentOrigins).translations).toEqual(['', '第一页扫描校订', '第二页扫描校订']);
        expect(JSON.stringify(saved)).toBe(before);
        expect(current.binary.pages[1].scanned).toBe(true);
    });
    it('retains a completed empty OCR result and accepts the equivalent older rotation field without another recognition', () => {
        const current = pdf([null, null]);
        current.binary.pages[1] = {...current.binary.pages[1], sourceRotation: 90} as any;
        const previous = pdf([[], ['Rotated OCR']]);
        previous.binary.pages[0].scanned = false;
        previous.binary.pages[1] = {...previous.binary.pages[1], scanned: false, rotation: 90} as any;
        const {document: restored} = restoreDocumentHistoryPdfOcr(record('rotated', 1, {bytes: previous.binary.bytes, parsed: previous}), current);
        expect(restored.segments.map(segment => segment.source)).toEqual(['Rotated OCR']);
        expect(restored.binary?.kind === 'pdf' && restored.binary.pages.every(page => page.scanned === false)).toBe(true);
    });
    it('leaves non-PDF documents and already parsed native PDFs untouched', () => {
        const text = parsed(['Native']);
        expect(restoreDocumentHistoryPdfOcr(record('text', 1), text)).toEqual({document: text});
        const native = pdf([['Native']]);
        expect(restoreDocumentHistoryPdfOcr(record('native', 1), native).document).toBe(native);
    });
    it.each([
        {native: [], expected: []},
        {native: ['Repeat'], expected: ['文字页校订']},
        {native: ['Inserted', 'Repeat', 'Repeat'], expected: ['', '', '']},
    ])('keeps OCR duplicate revisions when native occurrences change: $native', ({native, expected}) => {
        const current = pdf([native, null, null]);
        const previous = pdf([['Repeat'], ['Repeat'], ['Repeat', 'Repeat']]);
        previous.binary.pages[1].scanned = false;
        previous.binary.pages[2].scanned = false;
        const saved = record('removed-native', 1, {bytes: previous.binary.bytes, parsed: previous,
            translations: ['文字页校订', '第一页扫描独立校订', '', '第二页重复段独立校订']});
        const {document, segmentOrigins} = restoreDocumentHistoryPdfOcr(saved, current);
        expect(restoreDocumentHistoryRevisions(saved, document, 7, segmentOrigins).translations)
            .toEqual([...expected, '第一页扫描独立校订', '', '第二页重复段独立校订']);
        expect(document).not.toHaveProperty('segmentOrigins');
    });
    it.each([
        ['missing snapshot', (saved: any) => {saved.parsed = undefined;}],
        ['null snapshot', (saved: any) => {saved.parsed = null;}],
        ['primitive snapshot', (saved: any) => {saved.parsed = 12;}],
        ['missing PDF', (saved: any) => {saved.parsed = {};}],
        ['different format', (saved: any) => {saved.parsed.binary.kind = 'epub';}],
        ['missing pages', (saved: any) => {saved.parsed.binary.pages = null;}],
        ['missing segments', (saved: any) => {saved.parsed.segments = null;}],
        ['missing record bytes', (saved: any) => {saved.bytes = undefined;}],
        ['changed record length', (saved: any) => {saved.bytes = new Uint8Array([1]);}],
        ['missing snapshot bytes', (saved: any) => {saved.parsed.binary.bytes = undefined;}],
        ['changed snapshot length', (saved: any) => {saved.parsed.binary.bytes = new Uint8Array([1]);}],
        ['different record file', (saved: any) => {saved.bytes = new Uint8Array([1, 2, 4]);}],
        ['different snapshot file', (saved: any) => {saved.parsed.binary.bytes = new Uint8Array([1, 2, 4]);}],
        ['wrong or invalid pages', (saved: any) => {saved.parsed.binary.pages = [null, 12, {...saved.parsed.binary.pages[0], pageNumber: 2}];}],
        ['scan was not recognized', (saved: any) => {saved.parsed.binary.pages[0].scanned = true;}],
        ['different width', (saved: any) => {saved.parsed.binary.pages[0].width = 110;}],
        ['different height', (saved: any) => {saved.parsed.binary.pages[0].height = 110;}],
        ['different rotation', (saved: any) => {saved.parsed.binary.pages[0].sourceRotation = 90;}],
        ['missing blocks', (saved: any) => {saved.parsed.binary.pages[0].blocks = null;}],
        ['null block', (saved: any) => {saved.parsed.binary.pages[0].blocks = [null];}],
        ['primitive block', (saved: any) => {saved.parsed.binary.pages[0].blocks = [12];}],
        ['invalid segment identifier', (saved: any) => {saved.parsed.binary.pages[0].blocks[0].segmentIndex = 1.5;}],
        ['missing source segment', (saved: any) => {saved.parsed.binary.pages[0].blocks[0].segmentIndex = 99;}],
        ['invalid source', (saved: any) => {saved.parsed.segments[0].source = 12;}],
        ['non-finite page size', (_saved: any, current: any) => {current.binary.pages[0].width = NaN;}],
        ['non-positive page size', (_saved: any, current: any) => {current.binary.pages[0].height = 0;}],
    ] as const)('refuses unsafe scan reuse: %s', (_name, change) => {
        const current = pdf([null]);
        const previous = pdf([['OCR']]);
        previous.binary.pages[0].scanned = false;
        const saved = record('unsafe-scan', 1, {bytes: previous.binary.bytes.slice(), parsed: previous});
        change(saved, current);
        expect(restoreDocumentHistoryPdfOcr(saved, current).document).toBe(current);
    });
});

describe('document history identity', () => {
    it('derives the same short identifier from the same bytes and a different one from different bytes', async () => {
        const first = await documentHistoryId(new Uint8Array([1, 2, 3]));
        expect(first).toMatch(/^[0-9a-f]{32}$/u);
        expect(await documentHistoryId(new Uint8Array([1, 2, 3]))).toBe(first);
        expect(await documentHistoryId(new Uint8Array([1, 2, 4]))).not.toBe(first);
    });
    it('returns an empty identifier when hashing is unavailable or fails', async () => {
        expect(await documentHistoryId(new Uint8Array([1]), null as never)).toBe('');
        expect(await documentHistoryId(new Uint8Array([1]), {digest: async () => {throw new Error('blocked');}})).toBe('');
    });
});

describe('document history storage', () => {
    it('does not overwrite another tab after both successfully read the same record', async () => {
        const factory = new IDBFactory(), first = createDocumentHistory(factory), second = createDocumentHistory(factory);
        expect(await first.save(record('shared', 1, {translations: ['Original']}))).toBe(true);
        const a = await first.load('shared'), b = await second.load('shared');
        expect(a?.translations).toEqual(['Original']);expect(b?.translations).toEqual(['Original']);
        expect((await first.saveChecked({...a!, translations: ['First tab edit']}, documentHistoryVersion(a))).status).toBe('saved');
        expect((await second.saveChecked({...b!, translations: ['Second tab edit']}, documentHistoryVersion(b))).status).toBe('conflict');
        expect((await first.load('shared'))?.translations).toEqual(['First tab edit']);
    });
    it('atomically accepts only one simultaneous writer and distinguishes deleted and recreated records', async () => {
        const factory = new IDBFactory(), first = createDocumentHistory(factory), second = createDocumentHistory(factory);
        expect(await first.save(record('shared', 1))).toBe(true);
        const original = (await first.load('shared'))!, version = documentHistoryVersion(original);
        const outcomes = await Promise.all([
            first.saveChecked({...original, translations: ['A']}, version),
            second.saveChecked({...original, translations: ['B']}, version),
        ]);
        expect(outcomes.map(result => result.status).sort()).toEqual(['conflict', 'saved']);
        const current = (await first.load('shared'))!;
        expect(['A', 'B']).toContain(current.translations[0]);
        await second.clear();
        expect((await first.saveChecked(current, documentHistoryVersion(current))).status).toBe('conflict');
        const absent = await second.loadChecked('shared');
        if (absent.status !== 'ok') throw new Error('expected readable');
        const recreated = await second.saveChecked({...original, translations: ['After clear']}, absent.version);
        expect(recreated.status).toBe('saved');
        expect((await first.saveChecked(current, documentHistoryVersion(current))).status).toBe('conflict');
        expect((await first.load('shared'))?.translations).toEqual(['After clear']);
    });
    it('migrates a v1 record and prevents old-version clients from silently writing', async () => {
        expect(documentHistoryVersion(null)).toBeNull();
        const factory = new IDBFactory();
        const old = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('documents', {keyPath: 'id'});
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = old.transaction('documents', 'readwrite');tx.objectStore('documents').put(record('legacy', 1));
            tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);
        });
        old.onversionchange = () => old.close();
        const history = createDocumentHistory(factory), loaded = await history.loadChecked('legacy');
        expect(loaded.status).toBe('ok');
        if (loaded.status !== 'ok') throw new Error('expected readable');
        expect(loaded.version).toMatch(/^v:/u);
        expect((await history.saveChecked({...loaded.record!, translations: ['updated']}, loaded.version)).status).toBe('saved');
        expect((await history.saveChecked(record('legacy', 2), loaded.version)).status).toBe('conflict');
        const oldError = await new Promise<string | undefined>(resolve => {
            const req = factory.open('FluentReadDocumentHistory', 1);
            req.onerror = () => resolve(req.error?.name);req.onsuccess = () => {req.result.close();resolve(undefined);};
        });
        expect(oldError).toBe('VersionError');
    });
    it('compares the displayed version atomically before deleting a record', async () => {
        const factory = new IDBFactory(), first = createDocumentHistory(factory), second = createDocumentHistory(factory);
        expect(await first.save(record('same', 1, {translations: ['before']}))).toBe(true);
        const listed = await first.listChecked(), loaded = await second.loadChecked('same');
        if (listed.status !== 'ok' || loaded.status !== 'ok') throw new Error('expected readable');
        expect((await second.saveChecked(record('same', 2, {translations: ['other tab']}), loaded.version)).status).toBe('saved');
        expect(await first.removeChecked('same', listed.entries[0].historyVersion!)).toEqual({status: 'conflict'});
        expect((await second.load('same'))?.translations).toEqual(['other tab']);
        const refreshed = await first.listChecked();if (refreshed.status !== 'ok') throw new Error('expected readable');
        expect(await first.removeChecked('same', refreshed.entries[0].historyVersion!)).toEqual({status: 'removed'});
        expect(await first.removeChecked('same', refreshed.entries[0].historyVersion!)).toEqual({status: 'conflict'});
        expect(await first.load('same')).toBeNull();
    });
    it('deletes an unchanged legacy entry and reports missing metadata as unavailable', async () => {
        const factory = new IDBFactory();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 1);req.onupgradeneeded = () => req.result.createObjectStore('documents', {keyPath: 'id'});
            req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {const tx = db.transaction('documents', 'readwrite');tx.objectStore('documents').put(record('legacy', 1));tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);});
        db.onversionchange = () => db.close();
        const history = createDocumentHistory(factory), list = await history.listChecked();
        if (list.status !== 'ok') throw new Error('expected readable');
        expect(list.entries[0].historyVersion).toBe('legacy');
        expect(await history.removeChecked('legacy', 'legacy')).toEqual({status: 'removed'});
        const current = await new Promise<IDBDatabase>((resolve, reject) => {const req = factory.open('FluentReadDocumentHistory', 2);req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);});
        await new Promise<void>((resolve, reject) => {const tx = current.transaction('metadata', 'readwrite');tx.objectStore('metadata').clear();tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);});
        expect(await history.removeChecked('legacy', 'legacy')).toEqual({status: 'unavailable'});current.close();
    });
    it('does not confirm a list when its read transaction aborts after the cursor finishes', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        await history.save(record('kept', 1));
        const original = IDBObjectStore.prototype.openCursor;
        let abortRead = true;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
            const cursor = original.apply(this, args);
            if (abortRead && this.transaction.mode === 'readonly') {
                abortRead = false;
                const tx = this.transaction;
                cursor.addEventListener('success', () => {if (!cursor.result) tx.abort();});
            }
            return cursor;
        });
        try {
            expect(await history.listChecked()).toEqual({status: 'unavailable'});
            expect(await history.listChecked()).toMatchObject({status: 'ok', entries: [{id: 'kept'}]});
        } finally {spy.mockRestore();}
    });
    it('reports a cursor request failure and retries the same list successfully', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        await history.save(record('kept', 1));
        const original = IDBObjectStore.prototype.openCursor;
        let failRead = true;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
            if (failRead && this.transaction.mode === 'readonly') {
                failRead = false;
                const failed = {error: new Error('cursor failure')} as unknown as IDBRequest<IDBCursorWithValue | null>;
                queueMicrotask(() => failed.onerror?.call(failed, new Event('error')));
                return failed;
            }
            return original.apply(this, args);
        });
        try {
            expect(await history.listChecked()).toEqual({status: 'unavailable'});
            expect(await history.listChecked()).toMatchObject({status: 'ok', entries: [{id: 'kept'}]});
        } finally {spy.mockRestore();}
    });
    it('reports blocked listing and mutations, preserves old data, then confirms the retried state', async () => {
        const factory = new IDBFactory();
        const old = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('documents', {keyPath: 'id'});
            req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = old.transaction('documents', 'readwrite');tx.objectStore('documents').put(record('kept', 1));
            tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);
        });
        const history = createDocumentHistory(factory, 50);
        expect(await history.listChecked()).toEqual({status: 'unavailable'});
        expect(await history.remove('kept')).toBe(false);
        expect(await history.clear()).toBe(false);
        old.close();
        expect(await history.listChecked()).toMatchObject({status: 'ok', entries: [{id: 'kept'}]});
        expect(await history.remove('kept')).toBe(true);
        expect(await history.listChecked()).toEqual({status: 'ok', entries: []});
        expect(await history.clear()).toBe(true);
    });
    it('fails closed when an old open connection blocks migration and retries after it closes', async () => {
        const factory = new IDBFactory();
        const old = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('documents', {keyPath: 'id'});
            req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);
        });
        const history = createDocumentHistory(factory, 50);
        expect(await history.loadChecked('missing')).toEqual({status: 'unavailable'});
        old.close();
        // A blocked open request may trigger an upgrade late; it must abort before the retry can succeed.
        expect((await history.loadChecked('missing')).status).toBe('ok');
    });
    it('rejects missing-record ABA after deletion or clear and protects the newest save from clock rollback', async () => {
        const factory = new IDBFactory(), a = createDocumentHistory(factory), b = createDocumentHistory(factory);
        for (const operation of ['remove', 'clear'] as const) {
            const missing = await a.loadChecked(operation);
            if (missing.status !== 'ok') throw new Error('expected readable');
            expect((await b.saveChecked(record(operation, 1), missing.version)).status).toBe('saved');
            if (operation === 'remove') await b.remove(operation); else await b.clear();
            expect((await a.saveChecked(record(operation, 2), missing.version)).status).toBe('conflict');
        }
        for (let index = 0; index < DOCUMENT_HISTORY_MAX_ENTRIES; index++) expect(await a.save(record(`old-${index}`, index + 10))).toBe(true);
        const missing = await b.loadChecked('clock-rollback');
        if (missing.status !== 'ok') throw new Error('expected readable');
        expect((await b.saveChecked(record('clock-rollback', -100), missing.version)).status).toBe('saved');
        expect(await a.load('clock-rollback')).not.toBeNull();
        expect(await a.list()).toHaveLength(DOCUMENT_HISTORY_MAX_ENTRIES);
        const subsequent = await b.loadChecked('after-rollback');
        if (subsequent.status !== 'ok') throw new Error('expected readable');
        expect((await b.saveChecked(record('after-rollback', -200), subsequent.version)).status).toBe('saved');
        expect(await a.load('clock-rollback')).not.toBeNull();
        expect(await a.load('old-0')).toBeNull();
        const list = await a.listChecked();if (list.status !== 'ok') throw new Error('expected readable');
        expect(list.entries.slice(0, 2).map(item => [item.id, item.updatedAt])).toEqual([['after-rollback', -200], ['clock-rollback', -100]]);
        expect(await createDocumentHistory(null as never).saveChecked(record('x', 1), missing.version)).toEqual({status: 'unavailable'});
        expect(await a.saveChecked(record('', 1), missing.version)).toEqual({status: 'unavailable'});
        expect(await a.saveChecked(record('huge', 1, {bytes: new Uint8Array(DOCUMENT_HISTORY_MAX_BYTES + 1)}), missing.version)).toEqual({status: 'unavailable'});
    });
    it('invalidates a missing token when a record is created and later evicted', async () => {
        const factory = new IDBFactory(), reader = createDocumentHistory(factory), writer = createDocumentHistory(factory);
        const missing = await reader.loadChecked('evicted');
        if (missing.status !== 'ok') throw new Error('expected readable');
        expect((await writer.saveChecked(record('evicted', 1), missing.version)).status).toBe('saved');
        for (let index = 0; index < DOCUMENT_HISTORY_MAX_ENTRIES; index++) expect(await writer.save(record(`new-${index}`, index + 10))).toBe(true);
        expect(await reader.load('evicted')).toBeNull();
        expect((await reader.saveChecked(record('evicted', 3), missing.version)).status).toBe('conflict');
    });
    it('refuses a checked read and write when generation metadata is missing', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        const initial = await history.loadChecked('missing');
        if (initial.status !== 'ok') throw new Error('expected readable');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 2);req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('metadata', 'readwrite');tx.objectStore('metadata').clear();tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);
        });
        expect(await history.loadChecked('missing')).toEqual({status: 'unavailable'});
        expect((await history.saveChecked(record('missing', 1), initial.version)).status).toBe('unavailable');db.close();
    });
    it('keeps legacy records ordered by their original timestamps when newly saved records use the sequence', async () => {
        const factory = new IDBFactory();
        const old = await new Promise<IDBDatabase>((resolve, reject) => {const req = factory.open('FluentReadDocumentHistory', 1);req.onupgradeneeded = () => req.result.createObjectStore('documents', {keyPath: 'id'});req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);});
        await new Promise<void>((resolve, reject) => {const tx = old.transaction('documents', 'readwrite');for (let i = 0; i < DOCUMENT_HISTORY_MAX_ENTRIES; i++) tx.objectStore('documents').put(record(`legacy-${i}`, i + 10));tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);});
        old.onversionchange = () => old.close();
        const history = createDocumentHistory(factory), absent = await history.loadChecked('new');if (absent.status !== 'ok') throw new Error('expected readable');
        expect((await history.saveChecked(record('new', -100), absent.version)).status).toBe('saved');
        expect(await history.load('legacy-0')).toBeNull();expect(await history.load('legacy-19')).not.toBeNull();
        const list = await history.list();expect(list[0]?.id).toBe('new');expect(list[0]?.updatedAt).toBe(-100);
        expect(list.slice(1).map(item => item.id)).toEqual(Array.from({length: DOCUMENT_HISTORY_MAX_ENTRIES - 1}, (_, index) => `legacy-${DOCUMENT_HISTORY_MAX_ENTRIES - 1 - index}`));
    });
    it('assigns distinct monotonic eviction orders to concurrent checked saves', async () => {
        const factory = new IDBFactory(), a = createDocumentHistory(factory), b = createDocumentHistory(factory);
        const absentA = await a.loadChecked('a'), absentB = await b.loadChecked('b');
        if (absentA.status !== 'ok' || absentB.status !== 'ok') throw new Error('expected readable');
        const outcomes = await Promise.all([a.saveChecked(record('a', 100), absentA.version), b.saveChecked(record('b', -100), absentB.version)]);
        expect(outcomes.map(result => result.status)).toEqual(['saved', 'saved']);
        const first = await a.load('a'), second = await b.load('b');
        expect([first?.storageOrder, second?.storageOrder].sort()).toEqual([1, 2]);
    });
    it('aborts and retries when a metadata request cannot be enqueued', async () => {
        const history = createDocumentHistory(new IDBFactory());
        expect(await history.save(record('kept', 1))).toBe(true);
        const original = IDBObjectStore.prototype.get;let fail = true;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
            if (fail && this.name === 'metadata') {fail = false;throw new Error('metadata request failed');}
            return original.call(this, key);
        });
        try {
            expect(await history.loadChecked('kept')).toEqual({status: 'unavailable'});
            expect(await history.loadChecked('kept')).toMatchObject({status: 'ok', record: {id: 'kept'}});
        } finally {spy.mockRestore();}
    });
    it('fails closed if the durable save sequence is missing or exhausted', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        const initial = await history.loadChecked('missing');if (initial.status !== 'ok') throw new Error('expected readable');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {const req = factory.open('FluentReadDocumentHistory', 2);req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);});
        for (const value of [undefined, Number.MAX_SAFE_INTEGER]) {
            await new Promise<void>((resolve, reject) => {const tx = db.transaction('metadata', 'readwrite'), store = tx.objectStore('metadata');if (value === undefined) store.delete('sequence');else store.put({key: 'sequence', value});tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);});
            expect((await history.saveChecked(record('missing', 1), initial.version)).status).toBe('unavailable');
            expect(await history.load('missing')).toBeNull();
        }
        db.close();
    });
    it('aborts quota enforcement when a stored save order is corrupt', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        const absent = await history.loadChecked('new');if (absent.status !== 'ok') throw new Error('expected readable');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {const req = factory.open('FluentReadDocumentHistory', 2);req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);});
        await new Promise<void>((resolve, reject) => {const tx = db.transaction('documents', 'readwrite');tx.objectStore('documents').put({...record('kept', 1), storageOrder: -1});tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);});
        expect((await history.saveChecked(record('new', 2), absent.version)).status).toBe('unavailable');
        expect(await history.load('kept')).not.toBeNull();expect(await history.load('new')).toBeNull();db.close();
    });
    it('fails safely when a stored entry cannot be scanned for quota or listing', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        const missing = await history.loadChecked('new');
        if (missing.status !== 'ok') throw new Error('expected readable');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open('FluentReadDocumentHistory', 2);req.onsuccess = () => resolve(req.result);req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('documents', 'readwrite');tx.objectStore('documents').put({id: 'broken', bytes: null});tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error);
        });
        expect(await history.list()).toEqual([]);
        expect((await history.saveChecked(record('new', 1), missing.version)).status).toBe('unavailable');
        expect(await history.load('new')).toBeNull();db.close();
    });
    it('distinguishes an absent or deliberately removed record from an unavailable read', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        expect(await history.loadChecked('missing')).toMatchObject({status: 'ok', record: null, version: expect.stringMatching(/^g:/u)});
        expect(await history.save(record('existing', 1))).toBe(true);
        expect(await history.loadChecked('existing')).toMatchObject({status: 'ok', record: {id: 'existing'}});
        await history.clear();
        expect(await history.loadChecked('existing')).toMatchObject({status: 'ok', record: null, version: expect.stringMatching(/^g:/u)});
        expect(await createDocumentHistory(null as never).loadChecked('existing')).toEqual({status: 'unavailable'});
    });
    it.each(['blocked', 'timeout'] as const)('does not publish a late %s history read as missing or invalidate a recovered read', async reason => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const factory = new IDBFactory(), pending = {result: {close: vi.fn()}} as unknown as IDBOpenDBRequest;
            const open = vi.fn().mockReturnValueOnce(pending).mockImplementation((name, version) => factory.open(name, version));
            const history = createDocumentHistory({open} as unknown as IDBFactory, 20);
            const first = history.loadChecked('existing');
            if (reason === 'blocked') pending.onblocked!(new Event('blocked') as IDBVersionChangeEvent);
            else await vi.advanceTimersByTimeAsync(20);
            expect(await first).toEqual({status: 'unavailable'});
            expect(await history.loadChecked('existing')).toMatchObject({status: 'ok', record: null, version: expect.stringMatching(/^g:/u)});
            pending.onsuccess!(new Event('success'));
            expect(pending.result.close).toHaveBeenCalledOnce();
            expect(await history.loadChecked('existing')).toMatchObject({status: 'ok', record: null, version: expect.stringMatching(/^g:/u)});
        } finally {vi.useRealTimers();}
    });
    it('tolerates the restart deadline racing a committed transaction and can safely save the next revision', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const factory = new IDBFactory(), open = factory.open.bind(factory);
            let firstWrite = true;
            vi.spyOn(factory, 'open').mockImplementation((name, version) => {
                const opened = open(name, version);
                opened.addEventListener('success', () => {
                    const database = opened.result, transact = database.transaction.bind(database);
                    vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                        const transaction = transact(stores, mode, options);
                        if (mode === 'readwrite' && firstWrite) {
                            firstWrite = false;
                            // 已提交时 abort 会抛 InvalidStateError；截止边界仍须报告未确认，之后能继续保存。
                            transaction.addEventListener('complete', () => vi.advanceTimersByTime(20));
                        }
                        return transaction;
                    });
                });
                return opened;
            });
            const history = createDocumentHistory(factory, 20);
            const restarted = record('restart', 1, {bypassCache: true, translations: [], completed: 0});
            expect(await history.save(restarted)).toBe(false);
            expect(await history.load('restart')).toMatchObject({bypassCache: true, translations: [], completed: 0});
            expect(await history.save({...restarted, translations: ['新译文'], completed: 1, updatedAt: 2})).toBe(true);
            expect(await history.load('restart')).toMatchObject({bypassCache: true, translations: ['新译文'], completed: 1});
        } finally {vi.useRealTimers();vi.restoreAllMocks();}
    });

    it('aborts an uncloneable restart snapshot without overwriting stored work, then saves the recoverable restart', async () => {
        const history = createDocumentHistory(new IDBFactory());
        expect(await history.save(record('restart', 1))).toBe(true);
        const restarted = record('restart', 2, {bypassCache: true, translations: [], completed: 0});
        expect(await history.save({...restarted, parsed: {callback: () => {}}})).toBe(false);
        expect(await history.load('restart')).toMatchObject({translations: ['甲', '', '丙', ''], completed: 2});
        expect(await history.save(restarted)).toBe(true);
        expect(await history.load('restart')).toMatchObject({bypassCache: true, translations: [], completed: 0});
    });

    it('persists only explicit cache bypass and rejects malformed stored flags without changing the record content', async () => {
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        const values = [true, undefined, false, null, 'true', 1, {}];
        for (const [index, bypassCache] of values.entries()) {
            expect(await history.save(record(`cache-${index}`, index, {bypassCache: bypassCache as boolean}))).toBe(true);
            const saved = await history.load(`cache-${index}`);
            expect(saved?.translations).toEqual(['甲', '', '丙', '']);
            if (bypassCache === true) expect(saved?.bypassCache).toBe(true);
            else expect(saved).not.toHaveProperty('bypassCache');
        }
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const opened = factory.open('FluentReadDocumentHistory', 2);
            opened.onsuccess = () => resolve(opened.result);opened.onerror = () => reject(opened.error);
        });
        const stored = await new Promise<DocumentHistoryRecord[]>((resolve, reject) => {
            const request = database.transaction('documents', 'readonly').objectStore('documents').getAll();
            request.onsuccess = () => resolve(request.result);request.onerror = () => reject(request.error);
        });
        expect(stored.find(value => value.id === 'cache-0')?.bypassCache).toBe(true);
        expect(stored.filter(value => value.id !== 'cache-0').every(value => !('bypassCache' in value))).toBe(true);
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction('documents', 'readwrite');
            values.forEach((bypassCache, index) => transaction.objectStore('documents').put(record(`raw-${index}`, index, {bypassCache: bypassCache as boolean})));
            transaction.oncomplete = () => resolve();transaction.onabort = () => reject(transaction.error);
        });
        for (const [index, bypassCache] of values.entries()) {
            const restored = await history.load(`raw-${index}`);
            if (bypassCache === true) expect(restored?.bypassCache).toBe(true);
            else expect(restored).not.toHaveProperty('bypassCache');
        }
        expect((await history.list()).every(value => !('bypassCache' in value))).toBe(true);
        database.close();
    });

    it('lists summaries newest first without file bytes and restores a full independent copy', async () => {
        const history = createDocumentHistory(new IDBFactory());
        expect(await history.list()).toEqual([]); expect(await history.load('missing')).toBeNull();
        const bytes = new Uint8Array([9, 8, 7]); const translations = ['甲', '乙'];
        expect(await history.save(record('old', 100))).toBe(true);
        expect(await history.save(record('new', 200, {bytes, translations, sourceUrl: 'https://arxiv.org/pdf/1706.03762', total: 2, completed: 2}))).toBe(true);
        bytes[0] = 0; translations[0] = '改';
        const list = await history.list();
        expect(list.map(entry => entry.id)).toEqual(['new', 'old']);
        expect(list[0]).toEqual({id: 'new', name: 'new.pdf', format: 'pdf', size: 3, sourceUrl: 'https://arxiv.org/pdf/1706.03762', total: 2, completed: 2, updatedAt: 200});
        expect(list[1]).not.toHaveProperty('sourceUrl'); expect(list.every(entry => !('bytes' in entry) && !('translations' in entry))).toBe(true);
        const loaded = await history.load('new');
        expect(Array.from(loaded!.bytes)).toEqual([9, 8, 7]); expect(loaded!.translations).toEqual(['甲', '乙']); expect(loaded!.fingerprint).toBe('fp');
    });
    it('列表和保存淘汰逐条读取摘要，不聚合复制全部原文件及解析快照', async () => {
        const aggregateRead = vi.spyOn(IDBObjectStore.prototype, 'getAll');
        const history = createDocumentHistory(new IDBFactory());
        try {
            for (let index = 0; index < 3; index++) {
                expect(await history.save(record(String(index), index, {bytes: new Uint8Array(512_000), parsed: parsed(['完整解析快照'.repeat(10_000)])}))).toBe(true);
            }
            expect((await history.list()).map(item => item.id)).toEqual(['2', '1', '0']);
            expect(aggregateRead).not.toHaveBeenCalled();
            expect((await history.load('1'))?.bytes.byteLength).toBe(512_000);
        } finally { aggregateRead.mockRestore(); }
    });
    it('updates an existing record in place, removes single records and clears everything', async () => {
        const history = createDocumentHistory(new IDBFactory());
        await history.save(record('a', 1)); await history.save(record('b', 2)); await history.save(record('a', 3, {completed: 4}));
        expect((await history.list()).map(entry => [entry.id, entry.completed])).toEqual([['a', 4], ['b', 2]]);
        await history.remove('a'); expect((await history.list()).map(entry => entry.id)).toEqual(['b']);
        await history.clear(); expect(await history.list()).toEqual([]);
    });
    it('evicts the oldest records beyond the entry limit', async () => {
        const history = createDocumentHistory(new IDBFactory());
        for (let index = 0; index < DOCUMENT_HISTORY_MAX_ENTRIES + 3; index += 1) await history.save(record(`doc-${index}`, index));
        const ids = (await history.list()).map(entry => entry.id);
        expect(ids).toHaveLength(DOCUMENT_HISTORY_MAX_ENTRIES);
        expect(ids[0]).toBe(`doc-${DOCUMENT_HISTORY_MAX_ENTRIES + 2}`); expect(ids).not.toContain('doc-0'); expect(ids).not.toContain('doc-2'); expect(ids).toContain('doc-3');
    });
    it('retains the recent prefix when mixed record sizes exceed the byte limit', async () => {
        const history = createDocumentHistory(new IDBFactory()), unit = 1024 * 1024;
        expect(await history.save(record('old-small', 1, {bytes: new Uint8Array(10 * unit)}))).toBe(true);
        expect(await history.save(record('middle-large', 2, {bytes: new Uint8Array(60 * unit)}))).toBe(true);
        expect(await history.save(record('new-small', 3, {bytes: new Uint8Array(30 * unit)}))).toBe(true);
        expect((await history.list()).map(item => item.id)).toEqual(['new-small']);
    });
    it('evicts older records when the total stored bytes exceed the budget and refuses oversized or anonymous records', async () => {
        const history = createDocumentHistory(new IDBFactory());
        const half = Math.floor(DOCUMENT_HISTORY_MAX_BYTES / 2);
        expect(await history.save(record('first', 1, {bytes: new Uint8Array(half)}))).toBe(true);
        expect(await history.save(record('second', 2, {bytes: new Uint8Array(half)}))).toBe(true);
        expect(await history.save(record('third', 3, {bytes: new Uint8Array(half)}))).toBe(true);
        expect((await history.list()).map(entry => entry.id)).toEqual(['third', 'second']);
        expect(await history.save(record('huge', 4, {bytes: new Uint8Array(DOCUMENT_HISTORY_MAX_BYTES + 1)}))).toBe(false);
        expect(await history.save(record('', 5))).toBe(false);
        expect((await history.list()).map(entry => entry.id)).toEqual(['third', 'second']);
    });
    it('releases its connection when another tab upgrades or deletes the database and reopens on the next use', async () => {
        const factory = new IDBFactory(); const history = createDocumentHistory(factory);
        await history.save(record('a', 1));
        // 另一个标签页删除数据库：本连接收到 versionchange 后关闭，删除得以完成而不被阻塞。
        await new Promise<void>((resolve, reject) => {const removal = factory.deleteDatabase('FluentReadDocumentHistory'); removal.onsuccess = () => resolve(); removal.onerror = () => reject(removal.error); removal.onblocked = () => reject(new Error('blocked'));});
        expect(await history.list()).toEqual([]);
        expect(await history.save(record('b', 2))).toBe(true); expect((await history.list()).map(entry => entry.id)).toEqual(['b']);
    });
    it.each(['blocked', 'timeout'] as const)('closes a late %s opening without invalidating the recovered connection', async reason => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const factory = new IDBFactory();
            const lateDatabase = {close: vi.fn()} as unknown as IDBDatabase;
            const pending = {result: lateDatabase} as unknown as IDBOpenDBRequest;
            const open = vi.fn().mockReturnValueOnce(pending).mockImplementation((name, version) => factory.open(name, version));
            const history = createDocumentHistory({open} as unknown as IDBFactory, 20);
            const first = history.list();
            if (reason === 'blocked') pending.onblocked!(new Event('blocked') as IDBVersionChangeEvent);
            else await vi.advanceTimersByTimeAsync(20);
            expect(await first).toEqual([]);
            expect(await history.list()).toEqual([]);
            expect(open).toHaveBeenCalledTimes(2);
            pending.onsuccess!(new Event('success'));
            await Promise.resolve();
            expect(lateDatabase.close).toHaveBeenCalledOnce();
            lateDatabase.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
            expect(await history.list()).toEqual([]);
            expect(open).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it('does not let an invalidated connection versionchange discard the next active connection', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const factory = new IDBFactory(), actualOpen = factory.open.bind(factory);
            let ready!: () => void;
            const reading = new Promise<void>(resolve => {ready = resolve;});
            let previous!: IDBDatabase, previousVersionChange!: IDBDatabase['onversionchange'];
            let delay = true;
            const open = vi.spyOn(factory, 'open').mockImplementation((name, version) => {
                const request = actualOpen(name, version);
                request.addEventListener('success', () => {
                    const database = request.result, transaction = database.transaction.bind(database);
                    vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                        const result = transaction(stores, mode, options);
                        if (delay && mode === 'readonly') {
                            delay = false;
                            Object.defineProperty(result, 'oncomplete', {set: () => {}, configurable: true});
                            const objectStore = result.objectStore.bind(result);
                            vi.spyOn(result, 'objectStore').mockImplementation(store => {
                                const target = objectStore(store);
                                vi.spyOn(target, 'openCursor').mockImplementation(() => {
                                    previous = database; previousVersionChange = database.onversionchange; ready();
                                    return {} as IDBRequest<IDBCursorWithValue | null>;
                                });
                                return target;
                            });
                        }
                        return result;
                    });
                });
                return request;
            });
            const history = createDocumentHistory(factory, 20), first = history.list();
            await reading;
            const close = vi.spyOn(previous, 'close');
            await vi.advanceTimersByTimeAsync(20); expect(await first).toEqual([]);
            expect(close).toHaveBeenCalledOnce();
            expect(await history.list()).toEqual([]); expect(open).toHaveBeenCalledTimes(2);
            previousVersionChange!.call(previous, new Event('versionchange') as IDBVersionChangeEvent);
            expect(close).toHaveBeenCalledTimes(2);
            expect(await history.list()).toEqual([]); expect(open).toHaveBeenCalledTimes(2);
        } finally {vi.useRealTimers();}
    });
    it('does not let another old read deadline close an independently recovered connection', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const factory = new IDBFactory(), actualOpen = factory.open.bind(factory);
            const ready: Array<() => void> = [];
            const started = Array.from({length: 2}, (_, index) => new Promise<void>(resolve => {ready[index] = resolve;}));
            let delayedReads = 0;
            const open = vi.spyOn(factory, 'open').mockImplementation((name, version) => {
                const request = actualOpen(name, version);
                request.addEventListener('success', () => {
                    const database = request.result, transaction = database.transaction.bind(database);
                    vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                        const result = transaction(stores, mode, options);
                        if (mode === 'readonly' && delayedReads < 2) {
                            Object.defineProperty(result, 'oncomplete', {set: () => {}, configurable: true});
                            const objectStore = result.objectStore.bind(result);
                            vi.spyOn(result, 'objectStore').mockImplementation(store => {
                                const target = objectStore(store);
                                vi.spyOn(target, 'openCursor').mockImplementation(() => {
                                    ready[delayedReads++]();
                                    return {} as IDBRequest<IDBCursorWithValue | null>;
                                });
                                return target;
                            });
                        }
                        return result;
                    });
                });
                return request;
            });
            const history = createDocumentHistory(factory, 20), first = history.list();
            await started[0]; await vi.advanceTimersByTimeAsync(10);
            const second = history.list(); await started[1];
            await vi.advanceTimersByTimeAsync(10); expect(await first).toEqual([]);
            expect(await history.list()).toEqual([]); expect(open).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(10); expect(await second).toEqual([]);
            expect(await history.list()).toEqual([]); expect(open).toHaveBeenCalledTimes(2);
        } finally {vi.useRealTimers();}
    });
    it('degrades to empty results when IndexedDB is missing, refuses to open or fails mid-request, and can recover afterwards', async () => {
        const absent = createDocumentHistory(null as never);
        expect(await absent.list()).toEqual([]); expect(await absent.load('a')).toBeNull(); expect(await absent.save(record('a', 1))).toBe(false);
        await expect(absent.remove('a')).resolves.toBe(false); await expect(absent.clear()).resolves.toBe(false);
        const real = new IDBFactory(); let blocked = true;
        const flaky = {open: (name: string, version?: number) => {
            if (!blocked) return real.open(name, version);
            const failed = {error: new Error('denied')} as unknown as IDBOpenDBRequest;
            queueMicrotask(() => failed.onerror?.(new Event('error')));
            return failed;
        }} as unknown as IDBFactory;
        const history = createDocumentHistory(flaky);
        expect(await history.list()).toEqual([]); expect(await history.save(record('a', 1))).toBe(false);
        blocked = false;
        expect(await history.save(record('a', 1))).toBe(true); expect((await history.list()).map(entry => entry.id)).toEqual(['a']);
        // 数据库能打开但单次请求失败（例如配额不足）：同样退化为空结果。
        const failing = () => {const pending = {error: new Error('quota')} as unknown as IDBRequest; queueMicrotask(() => pending.onerror?.(new Event('error'))); return pending;};
        const rejecting = createDocumentHistory({open: () => {
            const opened = {result: {transaction: (_store: string, mode: IDBTransactionMode) => {
                if (mode === 'readwrite') throw new Error('quota');
                return {objectStore: () => ({openCursor: failing, get: failing})};
            }}} as unknown as IDBOpenDBRequest;
            queueMicrotask(() => opened.onsuccess?.(new Event('success')));
            return opened;
        }} as unknown as IDBFactory);
        expect(await rejecting.list()).toEqual([]); expect(await rejecting.load('a')).toBeNull(); expect(await rejecting.save(record('a', 1))).toBe(false);
        await expect(rejecting.remove('a')).resolves.toBe(false); await expect(rejecting.clear()).resolves.toBe(false);
        // 被其他标签页占用：打开请求被阻塞或一直没有结果，都在时限内退化为空结果，之后可以恢复。
        const blockedFactory = {open: () => {const pending = {} as unknown as IDBOpenDBRequest; queueMicrotask(() => pending.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)); return pending;}} as unknown as IDBFactory;
        expect(await createDocumentHistory(blockedFactory).list()).toEqual([]);
        // 只控制超时计时器；fake-indexeddb 仍通过真实任务执行事务，恢复成功不依赖机器恰好空闲20ms。
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            let silent = true; const later = new IDBFactory();
            const hanging = createDocumentHistory({open: (name: string, version?: number) => silent ? {} as IDBOpenDBRequest : later.open(name, version)} as unknown as IDBFactory, 20);
            let settled = false;
            const loading = hanging.load('a').then(value => {settled = true; return value;});
            await vi.advanceTimersByTimeAsync(19); expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(await loading).toBeNull();
            const saving = hanging.save(record('a', 1));
            await vi.advanceTimersByTimeAsync(20); expect(await saving).toBe(false);
            silent = false;
            expect(await hanging.save(record('a', 1))).toBe(true); expect((await hanging.list()).map(entry => entry.id)).toEqual(['a']);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
        const broken = createDocumentHistory({open: () => {throw new Error('unavailable');}} as unknown as IDBFactory);
        expect(await broken.list()).toEqual([]); expect(await broken.load('a')).toBeNull();
    });
});
