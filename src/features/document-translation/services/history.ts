/**
 * @file src/features/document-translation/services/history.ts
 * 文件职责：在浏览器本地保存最近翻译过的文档及其译文，使文档翻译首页可以列出记录并一键恢复阅读。
 * 主要内容：以文件内容摘要为稳定标识，在独立的 IndexedDB 库中保存原始文件字节、解析结果快照、译文、进度与设置指纹；解析规则变化后按原文和重复出现次序恢复未变化片段的独立校订，复用同文件中页号、展示尺寸与旋转一致的已识别扫描页，同时保留新解析的文字页并重新编号全文片段，避免空扫描快照覆盖旧 OCR 校订；列表只返回不含文件字节的摘要并按最近更新时间排序；超过条数或总字节上限时淘汰最旧的记录；数据库不可用、被其他标签页占用而超时或读写失败时安静降级为“没有记录”，并在其他标签页需要升级或删除时让出连接，不影响打开和翻译文档。
 * 模块边界：只负责本地存取与已有译文匹配，不解析文档、不发起翻译、不读取配置，也不把任何内容发送到网络；页面状态、解析版本与何时保存由文档页面组合根决定。
 */
import type {DocumentSegment, ParsedDocument} from '../core/document';

export const DOCUMENT_HISTORY_MAX_ENTRIES = 20;
export const DOCUMENT_HISTORY_MAX_BYTES = 80 * 1024 * 1024;
const DATABASE = 'FluentReadDocumentHistory';
const STORE = 'documents';

export interface DocumentHistorySummary {
    id: string;
    name: string;
    format: string;
    size: number;
    sourceUrl?: string;
    /** 片段总数与已有译文的片段数，用于在首页显示进度。 */
    total: number;
    completed: number;
    updatedAt: number;
}
export interface DocumentHistoryRecord extends DocumentHistorySummary {
    bytes: Uint8Array;
    mimeType: string;
    translations: string[];
    /** 生成这些译文时的语言、服务与术语设置；恢复后据此判断设置是否已经改变。 */
    fingerprint: string;
    /** 解析结果的快照与产生它的解析版本：版本一致时刷新可以直接还原，不必重新解析文件。 */
    parsed?: unknown;
    parsedVersion?: number;
}
export interface DocumentHistory {
    list(): Promise<DocumentHistorySummary[]>;
    load(id: string): Promise<DocumentHistoryRecord | null>;
    save(record: DocumentHistoryRecord): Promise<boolean>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
}

/**
 * 重新解析时只复用原文完全相同的片段；重复原文逐次消费，空译文也占据自己的出现位置。
 * 没有原文快照的旧记录仅在解析版本已知且一致、片段总数一致时按索引恢复。
 */
export function restoreDocumentHistoryTranslations(
    record: Pick<DocumentHistoryRecord, 'parsed' | 'parsedVersion' | 'total' | 'translations'>,
    document: ParsedDocument,
    currentVersion: number,
): string[] {
    const snapshot = record.parsed && typeof record.parsed === 'object'
        ? record.parsed as {segments?: unknown} : undefined;
    const previous = Array.isArray(snapshot?.segments) ? snapshot.segments : [];
    const bySource = new Map<string, {translations: string[]; next: number}>();
    previous.forEach((segment: unknown, index: number) => {
        if (!segment || typeof segment !== 'object') return;
        const candidate = segment as {source?: unknown; id?: unknown};
        if (typeof candidate.source !== 'string') return;
        const slot = typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id >= 0
            ? candidate.id : index;
        const translation = record.translations[slot];
        let occurrences = bySource.get(candidate.source);
        if (!occurrences) {
            occurrences = {translations: [], next: 0};
            bySource.set(candidate.source, occurrences);
        }
        occurrences.translations.push(typeof translation === 'string' ? translation : '');
    });
    if (bySource.size) {
        return document.segments.map(segment => {
            const occurrences = bySource.get(segment.source);
            return occurrences ? occurrences.translations[occurrences.next++] ?? '' : '';
        });
    }
    const compatible = Number.isInteger(currentVersion) && currentVersion >= 0
        && record.parsedVersion === currentVersion && record.total === document.segments.length;
    return document.segments.map((_segment, index) => {
        const translation = compatible ? record.translations[index] : undefined;
        return typeof translation === 'string' ? translation : '';
    });
}

/** 同一文件重新解析时复用已识别的扫描页；文字页采用新解析结果，全文片段重新按页顺序编号。 */
export function restoreDocumentHistoryPdfOcr(
    record: Pick<DocumentHistoryRecord, 'parsed' | 'bytes'>,
    document: ParsedDocument,
): ParsedDocument {
    const binary = document.binary;
    if (binary?.kind !== 'pdf' || !binary.pages.some(page => page.scanned)) return document;
    const snapshot = record.parsed && typeof record.parsed === 'object'
        ? record.parsed as Partial<ParsedDocument> : undefined;
    const previous = snapshot?.binary;
    if (previous?.kind !== 'pdf' || !Array.isArray(previous.pages) || !Array.isArray(snapshot?.segments)) return document;
    // 历史条目的原始字节与快照都必须属于当前文件，不能把另一份文件的识别框搬过来。
    if (record.bytes?.length !== binary.bytes.length || previous.bytes?.length !== binary.bytes.length
        || binary.bytes.some((byte, index) => byte !== record.bytes[index] || byte !== previous.bytes[index])) return document;
    const oldSegments = snapshot.segments;
    const restored = binary.pages.map(page => {
        if (!page.scanned || ![page.width, page.height].every(value => Number.isFinite(value) && value > 0)) return undefined;
        const cached = previous.pages.find(candidate => candidate && typeof candidate === 'object' && candidate.pageNumber === page.pageNumber);
        if (cached?.scanned !== false || cached.width !== page.width || cached.height !== page.height
            || (cached.sourceRotation ?? cached.rotation ?? 0) !== (page.rotation ?? page.sourceRotation ?? 0)
            || !Array.isArray(cached.blocks) || !cached.blocks.every(block => block && typeof block === 'object'
                && Number.isInteger(block.segmentIndex) && (block.segmentIndex < 0 || typeof oldSegments[block.segmentIndex]?.source === 'string'))) return undefined;
        return cached;
    });
    if (!restored.some(Boolean)) return document;
    const segments: DocumentSegment[] = [];
    const pages = binary.pages.map((page, index) => {
        const selected = restored[index] ?? page;
        const sources = restored[index] ? oldSegments : document.segments;
        const segmentIndexes: number[] = [];
        const blocks = selected.blocks.map(block => {
            if (block.segmentIndex < 0) return block;
            const id = segments.length;
            segments.push({...sources[block.segmentIndex], id});
            segmentIndexes.push(id);
            return {...block, segmentIndex: id};
        });
        return {...selected, blocks, segmentIndexes};
    });
    return {...document, segments, binary: {...binary, pages}};
}

/** 文件名可以重复，内容摘要不会；同一份文件再次打开时接着上次的译文继续。 */
export async function documentHistoryId(bytes: Uint8Array, subtle: Pick<SubtleCrypto, 'digest'> | undefined = globalThis.crypto?.subtle): Promise<string> {
    if (!subtle) return '';
    try {
        const digest = new Uint8Array(await subtle.digest('SHA-256', bytes.slice()));
        return Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {return '';}
}

function request<T>(target: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        target.onsuccess = () => resolve(target.result);
        target.onerror = () => reject(target.error);
    });
}

function summary(record: DocumentHistoryRecord): DocumentHistorySummary {
    const {id, name, format, size, sourceUrl, total, completed, updatedAt} = record;
    return {id, name, format, size, ...(sourceUrl ? {sourceUrl} : {}), total, completed, updatedAt};
}

export function createDocumentHistory(factory: IDBFactory | undefined = globalThis.indexedDB, timeoutMs = 3000): DocumentHistory {
    let opening: Promise<IDBDatabase> | undefined;
    const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
        const opened = factory!.open(DATABASE, 1);
        opened.onupgradeneeded = () => {opened.result.createObjectStore(STORE, {keyPath: 'id'});};
        opened.onsuccess = () => {
            const database = opened.result;
            // 其他标签页要升级或删除这个库时主动让出连接，下次使用再重新打开。
            database.onversionchange = () => {database.close(); opening = undefined;};
            resolve(database);
        };
        opened.onerror = () => reject(opened.error);
        opened.onblocked = () => reject(new Error('blocked'));
    }).catch(error => {opening = undefined; throw error;});
    const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
    /** 历史记录是锦上添花：任何存储错误都退化为默认值，绝不打断文档流程。 */
    const guarded = async <T>(fallback: T, work: () => Promise<T>): Promise<T> => {
        if (!factory) return fallback;
        // 被其他标签页占用的数据库可能迟迟不响应；超过时限同样按“没有记录”处理，不能卡住打开文件。
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<T>(resolve => {timer = setTimeout(() => {opening = undefined; resolve(fallback);}, timeoutMs);});
        const result = await Promise.race([work().catch(() => fallback), expired]);
        clearTimeout(timer);
        return result;
    };
    const all = async () => (await request((await store('readonly')).getAll()) as DocumentHistoryRecord[]).sort((left, right) => right.updatedAt - left.updatedAt);
    return {
        list: () => guarded<DocumentHistorySummary[]>([], async () => (await all()).map(summary)),
        load: id => guarded<DocumentHistoryRecord | null>(null, async () => (await request((await store('readonly')).get(id)) as DocumentHistoryRecord | undefined) ?? null),
        save: record => guarded(false, async () => {
            if (!record.id || record.bytes.byteLength > DOCUMENT_HISTORY_MAX_BYTES) return false;
            await request((await store('readwrite')).put({...record, bytes: record.bytes.slice(), translations: [...record.translations]}));
            // 先写入再淘汰：保留最近的记录，直到条数与总字节都回到上限以内。
            let bytes = 0;
            const stale = (await all()).filter((entry, index) => {bytes += entry.bytes.byteLength; return index >= DOCUMENT_HISTORY_MAX_ENTRIES || bytes > DOCUMENT_HISTORY_MAX_BYTES;});
            if (stale.length) {const writable = await store('readwrite'); await Promise.all(stale.map(entry => request(writable.delete(entry.id))));}
            return true;
        }),
        remove: id => guarded(undefined, async () => {await request((await store('readwrite')).delete(id));}),
        clear: () => guarded(undefined, async () => {await request((await store('readwrite')).clear());}),
    };
}
