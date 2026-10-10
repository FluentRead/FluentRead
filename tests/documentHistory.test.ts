/**
 * @file tests/documentHistory.test.ts
 * 文件职责：验证“最近翻译”的本地存取与解析迁移：稳定标识、摘要列表、按原文恢复独立校订、淘汰与存储不可用时的安静降级。
 * 主要内容：使用内存 IndexedDB 真实执行读写；检查解析版本和分段位置变化时只复用未变化原文，重复片段逐次恢复而不跳过空译文，没有旧原文时仅采用同版本同数量的兼容恢复；检查列表不含文件字节并按最近更新时间排序，保存的是调用方数据的副本，条数与总字节超限时淘汰最旧记录，过大或没有标识的记录不保存，数据库缺失或出错时返回空结果而不抛出。
 * 模块边界：只测试历史存储服务，不挂载页面、不解析文档、不发起翻译。
 */
import {IDBFactory} from 'fake-indexeddb';
import {describe, expect, it} from 'vitest';
import {parseDocument} from '@/src/features/document-translation/core/document';
import {createDocumentHistory, documentHistoryId, restoreDocumentHistoryPdfOcr, restoreDocumentHistoryTranslations, DOCUMENT_HISTORY_MAX_BYTES, DOCUMENT_HISTORY_MAX_ENTRIES, type DocumentHistoryRecord} from '@/src/features/document-translation/services/history';

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

describe('document history translation migration', () => {
    it('restores by source after a reorder even when the version and segment count still match', () => {
        const saved = record('reordered', 1, {parsed: parsed(['First', 'Second']), parsedVersion: 7, total: 2, translations: ['第一段校订', '第二段校订']});
        const before = JSON.stringify(saved);
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Second', 'First']), 7)).toEqual(['第二段校订', '第一段校订']);
        expect(JSON.stringify(saved)).toBe(before);
    });
    it('keeps unchanged sources across inserted, removed and changed segments without synthesizing a merged translation', () => {
        const saved = record('changed', 1, {parsed: parsed(['Left', 'Right', 'Case', ' Spaced ']), parsedVersion: 6, total: 4,
            translations: ['左侧校订', '右侧校订', '大小写校订', '空格校订']});
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Inserted', 'Right', 'Left Right', 'case', 'Spaced', 'Left']), 7))
            .toEqual(['', '右侧校订', '', '', '', '左侧校订']);
    });
    it('preserves independent duplicate revisions in occurrence order when repetitions are removed or added', () => {
        const saved = record('duplicates', 1, {parsed: parsed(['Repeat', 'Between', 'Repeat', 'Repeat']), total: 4,
            translations: ['第一次校订', '中间校订', '第二次校订', '第三次校订']});
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Repeat', 'Repeat']), 7)).toEqual(['第一次校订', '第二次校订']);
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Repeat', 'New', 'Repeat', 'Between', 'Repeat', 'Repeat']), 7))
            .toEqual(['第一次校订', '', '第二次校订', '中间校订', '第三次校订', '']);
    });
    it('consumes empty and whitespace duplicate slots without borrowing later completed revisions', () => {
        const saved = record('empty-duplicates', 1, {parsed: parsed(['Repeat', 'Repeat', 'Repeat', 'Sparse']), total: 4,
            translations: ['', ' \n ', '第三次校订']});
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Repeat', 'Repeat', 'Repeat', 'Sparse']), 7))
            .toEqual(['', ' \n ', '第三次校订', '']);
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Repeat']), 7)).toEqual(['']);
    });
    it('uses stored segment identifiers and tolerates legacy source snapshots without identifiers', () => {
        const saved = record('identifiers', 1, {parsed: {segments: [{id: 2, source: 'Third slot'}, {id: 0, source: 'First slot'}, {id: 99, source: 'Missing slot'}]},
            total: 3, translations: ['第一槽校订', '', '第三槽校订']});
        expect(restoreDocumentHistoryTranslations(saved, parsed(['First slot', 'Third slot', 'Missing slot']), 7))
            .toEqual(['第一槽校订', '第三槽校订', '']);
        const legacy = record('legacy-identifiers', 1, {parsed: {segments: [{source: 'Legacy slot'}, {id: -1, source: 'Invalid id'}, {id: 1.5, source: 'Fractional id'}]},
            total: 3, translations: ['旧索引校订', '负标识校订', '非整数标识校订']});
        expect(restoreDocumentHistoryTranslations(legacy, parsed(['Invalid id', 'Fractional id', 'Legacy slot']), 7))
            .toEqual(['负标识校订', '非整数标识校订', '旧索引校订']);
    });
    it('does not fall back to indexes when only part of the old source snapshot is usable', () => {
        const saved = record('partial-snapshot', 1, {parsed: {segments: [null, 12, {source: 'Known'}, {source: ''}]},
            parsedVersion: 7, total: 4, translations: ['错位旧译文', '另一错位旧译文', '已知校订', '空原文校订']});
        expect(restoreDocumentHistoryTranslations(saved, parsed(['Unknown', '', 'Known', 'Different']), 7))
            .toEqual(['', '空原文校订', '已知校订', '']);
        expect(restoreDocumentHistoryTranslations(saved, parsed([]), 7)).toEqual([]);
    });
    it.each([undefined, null, 12, 'old snapshot', {}, {segments: null}, {segments: []}, {segments: [null, {source: 12}]}])
        ('allows index compatibility only for missing sources from the same known parsing version: %j', snapshot => {
            const saved = record('legacy', 1, {parsed: snapshot, parsedVersion: 7, total: 2, translations: ['第一槽校订']});
            expect(restoreDocumentHistoryTranslations(saved, parsed(['First', 'Second']), 7)).toEqual(['第一槽校订', '']);
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
        expect(restoreDocumentHistoryTranslations(saved, parsed(['First', 'Second']), currentVersion)).toEqual(['', '']);
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
        const restored = restoreDocumentHistoryPdfOcr(saved, current);
        expect(restored.segments.map(segment => segment.source)).toEqual(['New native', 'First OCR', 'Second OCR']);
        expect(restored.binary?.bytes).toBe(current.binary.bytes);
        if (restored.binary?.kind !== 'pdf') throw new Error('expected PDF');
        expect(restored.binary.pages.map(page => page.segmentIndexes)).toEqual([[0], [1], [2]]);
        expect(restored.binary.pages[1].blocks.map(block => block.segmentIndex)).toEqual([1, -1]);
        expect(restored.binary.pages[2]).toMatchObject({sourceRotation: 90, scanned: false});
        expect(restoreDocumentHistoryTranslations(saved, restored, 7)).toEqual(['', '第一页扫描校订', '第二页扫描校订']);
        expect(JSON.stringify(saved)).toBe(before);
        expect(current.binary.pages[1].scanned).toBe(true);
    });
    it('retains a completed empty OCR result and accepts the equivalent older rotation field without another recognition', () => {
        const current = pdf([null, null]);
        current.binary.pages[1] = {...current.binary.pages[1], sourceRotation: 90} as any;
        const previous = pdf([[], ['Rotated OCR']]);
        previous.binary.pages[0].scanned = false;
        previous.binary.pages[1] = {...previous.binary.pages[1], scanned: false, rotation: 90} as any;
        const restored = restoreDocumentHistoryPdfOcr(record('rotated', 1, {bytes: previous.binary.bytes, parsed: previous}), current);
        expect(restored.segments.map(segment => segment.source)).toEqual(['Rotated OCR']);
        expect(restored.binary?.kind === 'pdf' && restored.binary.pages.every(page => page.scanned === false)).toBe(true);
    });
    it('leaves non-PDF documents and already parsed native PDFs untouched', () => {
        const text = parsed(['Native']);
        expect(restoreDocumentHistoryPdfOcr(record('text', 1), text)).toBe(text);
        const native = pdf([['Native']]);
        expect(restoreDocumentHistoryPdfOcr(record('native', 1), native)).toBe(native);
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
        expect(restoreDocumentHistoryPdfOcr(saved, current)).toBe(current);
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
    it('degrades to empty results when IndexedDB is missing, refuses to open or fails mid-request, and can recover afterwards', async () => {
        const absent = createDocumentHistory(null as never);
        expect(await absent.list()).toEqual([]); expect(await absent.load('a')).toBeNull(); expect(await absent.save(record('a', 1))).toBe(false);
        await expect(absent.remove('a')).resolves.toBeUndefined(); await expect(absent.clear()).resolves.toBeUndefined();
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
            const opened = {result: {transaction: () => ({objectStore: () => ({getAll: failing, get: failing, put: failing, delete: failing, clear: failing})})}} as unknown as IDBOpenDBRequest;
            queueMicrotask(() => opened.onsuccess?.(new Event('success')));
            return opened;
        }} as unknown as IDBFactory);
        expect(await rejecting.list()).toEqual([]); expect(await rejecting.load('a')).toBeNull(); expect(await rejecting.save(record('a', 1))).toBe(false);
        await expect(rejecting.remove('a')).resolves.toBeUndefined(); await expect(rejecting.clear()).resolves.toBeUndefined();
        // 被其他标签页占用：打开请求被阻塞或一直没有结果，都在时限内退化为空结果，之后可以恢复。
        const blockedFactory = {open: () => {const pending = {} as unknown as IDBOpenDBRequest; queueMicrotask(() => pending.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)); return pending;}} as unknown as IDBFactory;
        expect(await createDocumentHistory(blockedFactory).list()).toEqual([]);
        let silent = true; const later = new IDBFactory();
        const hanging = createDocumentHistory({open: (name: string, version?: number) => silent ? {} as IDBOpenDBRequest : later.open(name, version)} as unknown as IDBFactory, 20);
        const started = Date.now();
        expect(await hanging.load('a')).toBeNull(); expect(await hanging.save(record('a', 1))).toBe(false); expect(Date.now() - started).toBeLessThan(1000);
        silent = false;
        expect(await hanging.save(record('a', 1))).toBe(true); expect((await hanging.list()).map(entry => entry.id)).toEqual(['a']);
        const broken = createDocumentHistory({open: () => {throw new Error('unavailable');}} as unknown as IDBFactory);
        expect(await broken.list()).toEqual([]); expect(await broken.load('a')).toBeNull();
    });
});
