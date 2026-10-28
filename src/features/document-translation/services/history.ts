/**
 * @file src/features/document-translation/services/history.ts
 * 文件职责：在浏览器本地保存最近翻译过的文档及其译文，使文档翻译首页可以列出记录并一键恢复阅读。
 * 主要内容：以文件内容摘要为稳定标识，在独立的 IndexedDB 库中保存原始文件字节、解析结果快照、译文、进度与设置指纹；解析规则变化后按原文与双向唯一的原生位置或邻文恢复未变化片段的独立校订，歧义校订独立保留，复用同文件中页号、展示尺寸与旋转一致的已识别扫描页；原文件、逐行及逐项稳定几何均一致时，保留因字体指标修正而合并的连续普通文字段，使用新字形重建边界而不拼接译文；其余文字页保持新解析结果，统一重编号全文片段；本次复用的旧索引保留独立校订与空槽并从原文匹配池排除，不写入解析快照；列表与淘汰使用游标逐条提取摘要和原始字节数，不聚合持有所有原文件及解析快照，按事务内保存序列排序（旧记录按更新时间排序），并在超过条数或总字节上限时淘汰最旧的记录；普通查询在数据库不可用时降级为默认值，受检读取则明确报告不可用；其他标签页需要升级或删除时让出连接，不影响打开和翻译文档。
 * 保存生命周期：提供可区分读取失败与确实没有记录的检查接口；超时撤销后续写入资格并取消活跃写事务，只有真实事务提交后才确认保存成功；放弃的数据库打开请求迟到成功时关闭旧连接，旧连接事件不能重置已恢复连接；重译跳过缓存只接受并保存显式 true，刷新后继续当前重译不会恢复旧缓存。
 * 模块边界：只负责本地存取与已有译文匹配，不解析文档、不发起翻译、不读取配置，也不把任何内容发送到网络；页面状态、解析版本与何时保存由文档页面组合根决定。
 */
import {documentSourceLocators, matchDocumentSourceLocators} from '../core/materialLocator';
import type {DocumentSegment, ParsedDocument, PdfDocumentBlock, PdfDocumentLine, PdfDocumentPage, PdfDocumentRun} from '../core/document';

export const DOCUMENT_HISTORY_MAX_ENTRIES = 20;
export const DOCUMENT_HISTORY_MAX_BYTES = 80 * 1024 * 1024;
const DATABASE = 'FluentReadDocumentHistory';
const STORE = 'documents';
const META = 'metadata';
const GENERATION = 'generation';
const SEQUENCE = 'sequence';

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
    /** 列表读取时观察到的本地写入身份，用于安全删除。 */
    historyVersion?: string;
}
export interface DocumentHistoryRecord extends DocumentHistorySummary {
    bytes: Uint8Array;
    mimeType: string;
    translations: string[];
    /** 生成这些译文时的语言、服务与术语设置；恢复后据此判断设置是否已经改变。 */
    fingerprint: string;
    /** 用户确认重译后持续跳过旧译文缓存；旧记录和未开启的任务不保存该字段。 */
    bypassCache?: boolean;
    /** 解析结果的快照与产生它的解析版本：版本一致时刷新可以直接还原，不必重新解析文件。 */
    parsed?: unknown;
    parsedVersion?: number;
    /** 解析变化后无法安全套用的旧校订，只作为可复制资料保留，不计入当前译文或进度。 */
    retainedRevisions?: DocumentRetainedRevision[];
    /** 本地存储写入身份；旧记录未携带该字段。 */
    storageVersion?: string;
    /** 单调保存次序，用于淘汰排序，独立于展示时间。 */
    storageOrder?: number;
}
export interface DocumentRetainedRevision {source: string; translation: string; contextLabel?: string;}
export type DocumentHistoryVersion = string | null;
export function documentHistoryVersion(record: DocumentHistoryRecord | null): DocumentHistoryVersion {
    return record ? typeof record.storageVersion === 'string' && record.storageVersion.startsWith('v:') ? record.storageVersion : 'legacy' : null;
}
export interface DocumentHistory {
    list(): Promise<DocumentHistorySummary[]>;
    listChecked(): Promise<{status: 'ok'; entries: DocumentHistorySummary[]} | {status: 'unavailable'}>;
    load(id: string): Promise<DocumentHistoryRecord | null>;
    /** 明确区分没有记录与读取不可用，供后续可能写回同一标识的导入使用。 */
    loadChecked(id: string): Promise<{status: 'ok'; record: DocumentHistoryRecord | null; version: string} | {status: 'unavailable'}>;
    save(record: DocumentHistoryRecord): Promise<boolean>;
    saveChecked(record: DocumentHistoryRecord, expected: DocumentHistoryVersion): Promise<{status: 'saved'; version: string} | {status: 'conflict' | 'unavailable'}>;
    remove(id: string): Promise<boolean>;
    removeChecked(id: string, expected: string): Promise<{status: 'removed' | 'conflict' | 'unavailable'}>;
    clear(): Promise<boolean>;
}

/**
 * 重新解析时只复用原文完全相同且位置明确的片段；重复原文不猜测出现次序，空译文也占据自己的已确认位置。
 * 没有原文快照的旧记录仅在解析版本已知且一致、片段总数一致时按索引恢复。
 */
function matchDocumentHistoryTranslations(
    record: Pick<DocumentHistoryRecord, 'parsed' | 'parsedVersion' | 'total' | 'translations'>,
    document: ParsedDocument,
    currentVersion: number,
    segmentOrigins?: readonly (number | undefined)[],
): {translations: string[]; consumed: Set<number>} {
    const consumed = new Set<number>();
    const snapshot = record.parsed && typeof record.parsed === 'object'
        ? record.parsed as {segments?: unknown} : undefined;
    const previous = Array.isArray(snapshot?.segments) ? snapshot.segments : [];
    const slots = new Map<number, string>();
    previous.forEach((segment: unknown, index: number) => {
        if (!segment || typeof segment !== 'object') return;
        const candidate = segment as {source?: unknown; id?: unknown};
        if (typeof candidate.source !== 'string') return;
        const slot = typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id >= 0 ? candidate.id : index;
        slots.set(index, typeof record.translations[slot] === 'string' ? record.translations[slot] : '');
    });
    if (slots.size) {
        const origins = matchDocumentSourceLocators(documentSourceLocators(snapshot!), documentSourceLocators(document), segmentOrigins,
            record.parsed === document || Number.isInteger(currentVersion) && currentVersion >= 0 && record.parsedVersion === currentVersion);
        return {translations: origins.map(origin => {
            if (origin === undefined) return '';
            consumed.add(origin);
            // matcher 只返回已归一的旧槽索引；IndexedDB 快照是稳定的普通数据。
            return slots.get(origin)!;
        }), consumed};
    }
    const compatible = Number.isInteger(currentVersion) && currentVersion >= 0
        && record.parsedVersion === currentVersion && record.total === document.segments.length;
    const translations = document.segments.map((_segment, index) => {
        const translation = compatible ? record.translations[index] : undefined;
        return typeof translation === 'string' ? translation : '';
    });
    return {translations, consumed};
}

/** 对已存资料和本次未消费的旧校订统一校验、复制并去重，不丢弃有效原文或译文中的空白。 */
function retainedDocumentRevisions(values: readonly unknown[]): DocumentRetainedRevision[] {
    const retained: DocumentRetainedRevision[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const revision = value as Partial<DocumentRetainedRevision>;
        if (typeof revision.source !== 'string' || !revision.source.trim()
            || typeof revision.translation !== 'string' || !revision.translation.trim()) continue;
        const contextLabel = typeof revision.contextLabel === 'string' ? revision.contextLabel.trim() : '';
        const key = JSON.stringify([revision.source, revision.translation, contextLabel]);
        if (seen.has(key)) continue;
        seen.add(key);
        retained.push({source: revision.source, translation: revision.translation, ...(contextLabel ? {contextLabel} : {})});
    }
    return retained;
}

/** 调用方先按文件身份选中历史记录；沿用安全匹配，并保留无法消费的独立旧校订供用户查看。 */
export function restoreDocumentHistoryRevisions(
    record: Pick<DocumentHistoryRecord, 'parsed' | 'parsedVersion' | 'total' | 'translations' | 'retainedRevisions'>,
    document: ParsedDocument,
    currentVersion: number,
    segmentOrigins?: readonly (number | undefined)[],
): {translations: string[]; retainedRevisions: DocumentRetainedRevision[]} {
    const normalized = {...record, translations: Array.isArray(record.translations) ? record.translations : []};
    const {translations, consumed} = matchDocumentHistoryTranslations(normalized, document, currentVersion, segmentOrigins);
    const snapshot = record.parsed && typeof record.parsed === 'object' ? record.parsed as {segments?: unknown} : undefined;
    const previous = Array.isArray(snapshot?.segments) ? snapshot.segments : [];
    const unused = previous.flatMap((value, index) => {
        if (consumed.has(index) || !value || typeof value !== 'object') return [];
        const segment = value as {id?: unknown; source?: unknown; contextLabel?: unknown};
        const slot = typeof segment.id === 'number' && Number.isInteger(segment.id) && segment.id >= 0 ? segment.id : index;
        return [{source: segment.source, translation: normalized.translations[slot], contextLabel: segment.contextLabel}];
    });
    return {translations, retainedRevisions: retainedDocumentRevisions([...(Array.isArray(record.retainedRevisions) ? record.retainedRevisions : []), ...unused])};
}

export interface DocumentHistoryPdfOcrRestore {
    document: ParsedDocument;
    /** 本次恢复的 OCR 或几何迁移段所对应的旧片段数组位置；不得写入解析快照。 */
    segmentOrigins?: readonly (number | undefined)[];
}

/** 只比较不受字体 ascent/descent 修正影响的文字和几何，缺少逐字项证据时拒绝迁移。 */
function stablePdfLine(line: PdfDocumentLine): string | undefined {
    const key = (run: PdfDocumentRun) => run && typeof run.text === 'string' && run.text.trim()
        && [run.x, run.width, run.baseline, run.fontSize, run.y, run.height].every(value => typeof value === 'number' && Number.isFinite(value))
        && run.width > 0 && run.height > 0 && run.fontSize! > 0
        ? [run.text, run.x, run.width, run.baseline, run.fontSize, run.fontFamily] : undefined;
    const geometry = key(line);
    if (!geometry || !Array.isArray(line.runs) || !line.runs.length) return undefined;
    const runs = line.runs.map(key);
    return runs.every(Boolean) ? JSON.stringify([geometry, runs]) : undefined;
}

/**
 * 同一 PDF 的字体度量修正可能把相邻普通段落合法合并。只在旧块连续、全部行/run
 * 与新块逐项匹配且原文以单个空格精确相连时保留旧分段；不猜测断词、公式或表格。
 * 译文仍逐槽恢复，矩形和字形必须全部取自新解析，旧的错误 y/height 不能带回来。
 */
function restorePdfTextSplits(page: PdfDocumentPage, cached: PdfDocumentPage, oldSegments: readonly DocumentSegment[], freshSegments: readonly DocumentSegment[]): {page: PdfDocumentPage; origins: Array<number | undefined>} | undefined {
    const ordinary = (block: PdfDocumentBlock) => block?.kind === 'text' && !block.preserveSource && !block.cellBounds
        && Number.isInteger(block.segmentIndex) && block.segmentIndex >= 0 && Array.isArray(block.lines)
        && block.lines.length > 0 && block.lineCount === block.lines.length;
    const sameStyle = (old: PdfDocumentBlock, fresh: PdfDocumentBlock) => old.fontSize === fresh.fontSize
        && old.fontFamily === fresh.fontFamily && old.fontWeight === fresh.fontWeight && old.textAlign === fresh.textAlign && old.column === fresh.column;
    const signatures = new WeakMap<PdfDocumentLine, string | undefined>();
    const signature = (line: PdfDocumentLine) => {
        if (!line || typeof line !== 'object') return undefined;
        if (!signatures.has(line)) signatures.set(line, stablePdfLine(line));
        return signatures.get(line);
    };
    const starts = new Map<string, number[]>();
    cached.blocks.forEach((block, index) => {
        if (!ordinary(block)) return;
        const first = signature(block.lines![0]);
        if (first) {const indexes = starts.get(first) ?? []; indexes.push(index); starts.set(first, indexes);}
    });
    const claimed = new Set<number>();
    const origins: Array<number | undefined> = [];
    let changed = false;
    const blocks = page.blocks.flatMap(fresh => {
        const keep = () => {origins.push(undefined); return [fresh];};
        if (!ordinary(fresh) || freshSegments[fresh.segmentIndex]?.id !== fresh.segmentIndex) return keep();
        const keys = fresh.lines!.map(signature);
        if (!keys.every(Boolean) || fresh.lines!.some((line, index) => index > 0 && line.baseline! <= fresh.lines![index - 1].baseline!)) return keep();
        const matches: Array<Array<{block: PdfDocumentBlock; index: number; start: number}>> = [];
        for (const start of starts.get(keys[0]!) ?? []) {
            const parts: Array<{block: PdfDocumentBlock; index: number; start: number}> = [];
            let at = 0;
            for (let index = start; index < cached.blocks.length && at < keys.length; index += 1) {
                const block = cached.blocks[index];
                if (!ordinary(block) || claimed.has(index) || !sameStyle(block, fresh)
                    || oldSegments[block.segmentIndex]?.id !== block.segmentIndex
                    || block.lines!.length + at > keys.length
                    || block.lines!.some((line, offset) => signature(line) !== keys[at + offset])) break;
                parts.push({block, index, start: at});
                at += block.lines!.length;
            }
            if (at === keys.length && parts.length > 1 && new Set(parts.map(({block}) => block.segmentIndex)).size === parts.length
                && parts.map(({block}) => oldSegments[block.segmentIndex].source).join(' ') === freshSegments[fresh.segmentIndex].source) matches.push(parts);
        }
        if (matches.length !== 1) return keep();
        changed = true;
        return matches[0].map(({block, index, start}, part) => {
            claimed.add(index);
            origins.push(block.segmentIndex);
            const lines = fresh.lines!.slice(start, start + block.lines!.length);
            let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
            for (const line of lines) {x = Math.min(x, line.x); y = Math.min(y, line.y); right = Math.max(right, line.x + line.width); bottom = Math.max(bottom, line.y + line.height);}
            const leading = lines.slice(1).map((line, position) => line.baseline! - lines[position].baseline!).sort((a, b) => a - b);
            return {...fresh, x, y, width: right - x, height: bottom - y,
                lines, lineCount: lines.length, lineHeight: leading[Math.floor(leading.length / 2)] || lines[0].fontSize!,
                ...(fresh.readingOrder === undefined ? {} : {readingOrder: fresh.readingOrder + part / matches[0].length})};
        });
    });
    return changed ? {page: {...page, blocks}, origins} : undefined;
}

/** 同文件重解析时复用已识别扫描页，受限保留只因字体几何修正而合并的普通段落，重新编号全文。 */
export function restoreDocumentHistoryPdfOcr(
    record: Pick<DocumentHistoryRecord, 'parsed' | 'bytes'>,
    document: ParsedDocument,
): DocumentHistoryPdfOcrRestore {
    const binary = document.binary;
    if (binary?.kind !== 'pdf') return {document};
    const snapshot = record.parsed && typeof record.parsed === 'object'
        ? record.parsed as Partial<ParsedDocument> : undefined;
    const previous = snapshot?.binary;
    if (previous?.kind !== 'pdf' || !Array.isArray(previous.pages) || !Array.isArray(snapshot?.segments)) return {document};
    // 历史条目的原始字节与快照都必须属于当前文件，不能把另一份文件的识别框搬过来。
    if (record.bytes?.length !== binary.bytes.length || previous.bytes?.length !== binary.bytes.length
        || binary.bytes.some((byte, index) => byte !== record.bytes[index] || byte !== previous.bytes[index])) return {document};
    const oldSegments = snapshot.segments;
    const restored = binary.pages.map(page => {
        if (![page.width, page.height].every(value => Number.isFinite(value) && value > 0)) return undefined;
        const cached = previous.pages.find(candidate => candidate && typeof candidate === 'object' && candidate.pageNumber === page.pageNumber);
        if (!cached || cached.width !== page.width || cached.height !== page.height
            || (cached.sourceRotation ?? cached.rotation ?? 0) !== (page.rotation ?? page.sourceRotation ?? 0)
            || !Array.isArray(cached.blocks) || !cached.blocks.every(block => block && typeof block === 'object'
                && Number.isInteger(block.segmentIndex) && (block.segmentIndex < 0 || typeof oldSegments[block.segmentIndex]?.source === 'string'))) return undefined;
        if (page.scanned) return cached.scanned === false ? {page: cached, origins: cached.blocks.map(block => block.segmentIndex >= 0 ? block.segmentIndex : undefined)} : undefined;
        return cached.scanned ? undefined : restorePdfTextSplits(page, cached, oldSegments, document.segments);
    });
    if (!restored.some(Boolean)) return {document};
    const segments: DocumentSegment[] = [];
    const segmentOrigins: Array<number | undefined> = [];
    const pages = binary.pages.map((page, index) => {
        const selected = restored[index]?.page ?? page;
        const segmentIndexes: number[] = [];
        const blocks = selected.blocks.map((block, blockIndex) => {
            if (block.segmentIndex < 0) return block;
            const origin = restored[index]?.origins[blockIndex];
            const source = origin === undefined ? document.segments[block.segmentIndex] : oldSegments[origin];
            const id = segments.length;
            segments.push({...source, id});
            segmentOrigins.push(origin);
            segmentIndexes.push(id);
            return {...block, segmentIndex: id};
        });
        return {...selected, blocks, segmentIndexes};
    });
    return {document: {...document, segments, binary: {...binary, pages}}, segmentOrigins};
}

/** 文件名可以重复，内容摘要不会；同一份文件再次打开时接着上次的译文继续。 */
export async function documentHistoryId(bytes: Uint8Array, subtle: Pick<SubtleCrypto, 'digest'> | undefined = globalThis.crypto?.subtle): Promise<string> {
    if (!subtle) return '';
    try {
        const digest = new Uint8Array(await subtle.digest('SHA-256', bytes.slice()));
        return Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {return '';}
}

function historyOrder(record: DocumentHistoryRecord): number {
    if (record.storageOrder !== undefined && (!Number.isSafeInteger(record.storageOrder) || record.storageOrder <= 0)) throw new Error('Invalid history order');
    return record.storageOrder ?? 0;
}

function summary(record: DocumentHistoryRecord): DocumentHistorySummary {
    const {id, name, format, size, sourceUrl, total, completed, updatedAt} = record;
    return {id, name, format, size, ...(sourceUrl ? {sourceUrl} : {}), total, completed, updatedAt};
}

/** 兼容旧记录；不把字符串、数字或其它 truthy 值当作用户确认的重译策略。 */
function normalizeDocumentHistoryCachePolicy(record: DocumentHistoryRecord): DocumentHistoryRecord {
    const {bypassCache, ...snapshot} = record;
    return bypassCache === true ? {...snapshot, bypassCache: true} : snapshot;
}

export function createDocumentHistory(factory: IDBFactory | undefined = globalThis.indexedDB, timeoutMs = 3000): DocumentHistory {
    let opening: Promise<IDBDatabase> | undefined;
    let connection: IDBDatabase | undefined;
    let openingGeneration = 0;
    const openingOwners = new WeakMap<AbortSignal, number>();
    const releaseOpening = () => {
        openingGeneration++;
        opening = undefined;
        connection?.close();
        connection = undefined;
    };
    const open = (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (opening) {openingOwners.set(signal, openingGeneration); return opening;}
        const generation = ++openingGeneration;
        openingOwners.set(signal, generation);
        return opening = new Promise<IDBDatabase>((resolve, reject) => {
            const opened = factory!.open(DATABASE, 2);
            opened.onupgradeneeded = () => {
                if (generation !== openingGeneration || signal.aborted) {opened.transaction!.abort();return;}
                const db = opened.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, {keyPath: 'id'});
                if (!db.objectStoreNames.contains(META)) {
                    const meta = db.createObjectStore(META, {keyPath: 'key'});
                    meta.put({key: GENERATION, value: `g:${globalThis.crypto.randomUUID()}`});
                    meta.put({key: SEQUENCE, value: 0});
                }
            };
            opened.onsuccess = () => {
                const database = opened.result;
                if (generation !== openingGeneration) {
                    database.close();
                    reject(new Error('文档历史数据库打开请求已失效'));
                    return;
                }
                connection = database;
                // 其他标签页要升级或删除这个库时主动让出连接，下次使用再重新打开。
                database.onversionchange = () => {if (generation === openingGeneration) releaseOpening(); else database.close();};
                resolve(database);
            };
            opened.onerror = () => reject(opened.error);
            opened.onblocked = () => reject(new Error('blocked'));
        }).catch(error => {if (generation === openingGeneration) releaseOpening(); throw error;});
    };
    const readStore = async (signal: AbortSignal) => {
        const database = await open(signal);
        signal.throwIfAborted();
        return database.transaction(STORE, 'readonly').objectStore(STORE);
    };
    /** 撤销资格贯穿数据库打开等待与真实事务；请求成功还不代表事务已经提交。 */
    const write = async (signal: AbortSignal, enqueue: (target: IDBObjectStore, meta: IDBObjectStore) => void): Promise<void> => {
        const database = await open(signal);
        signal.throwIfAborted();
        const transaction = database.transaction([STORE, META], 'readwrite');
        const settled = new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
        });
        const abort = () => {
            try {transaction.abort();} catch { /* 已提交事务无法撤销，也不会在稍后覆盖新写入。 */ }
        };
        signal.addEventListener('abort', abort, {once: true});
        try {
            try {enqueue(transaction.objectStore(STORE), transaction.objectStore(META));} catch {abort();}
            await settled;
        } finally {signal.removeEventListener('abort', abort);}
    };
    /** 历史记录是锦上添花：任何存储错误都退化为默认值，绝不打断文档流程。 */
    const guarded = async <T>(fallback: T, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        if (!factory) return fallback;
        // 被其他标签页占用的数据库可能迟迟不响应；超过时限同样按“没有记录”处理，不能卡住打开文件。
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<T>(resolve => {timer = setTimeout(() => {
            const generation = openingOwners.get(controller.signal);
            controller.abort();
            if (generation === openingGeneration) releaseOpening();
            resolve(fallback);
        }, timeoutMs);});
        const result = await Promise.race([work(controller.signal).catch(() => fallback), expired]);
        clearTimeout(timer);
        return result;
    };
    const all = async (signal: AbortSignal): Promise<Array<{summary: DocumentHistorySummary; bytes: number; order: number; version: DocumentHistoryVersion}>> => {
        const target = await readStore(signal);
        return new Promise((resolve, reject) => {
            const entries: Array<{summary: DocumentHistorySummary; bytes: number; order: number; version: DocumentHistoryVersion}> = [];
            let finished = false;
            target.transaction.oncomplete = () => finished ? resolve(entries.sort((left, right) => right.order - left.order || right.summary.updatedAt - left.summary.updatedAt)) : reject(new Error('Incomplete history scan'));
            target.transaction.onabort = () => reject(target.transaction.error);
            const cursor = target.openCursor();
            cursor.onerror = () => reject(cursor.error);
            cursor.onsuccess = () => {
                try {
                    signal.throwIfAborted();
                    const current = cursor.result;
                    if (!current) {finished = true;return;}
                    const value = current.value as DocumentHistoryRecord;
                    entries.push({summary: summary(value), bytes: value.bytes.byteLength, order: historyOrder(value), version: documentHistoryVersion(value)});
                    current.continue();
                } catch (error) {reject(error);}
            };
        });
    };
    // 保存、限额计算、淘汰及删除世代推进必须在同一事务完成。
    const enforceLimit = (target: IDBObjectStore, meta: IDBObjectStore, protectedId: string, signal: AbortSignal) => {
        const entries: Array<{id: string; updatedAt: number; order: number; bytes: number}> = [];
        const cursor = target.openCursor();
        cursor.onsuccess = () => {
            try {
                signal.throwIfAborted();
                const current = cursor.result;
                if (current) {
                    const value = current.value as DocumentHistoryRecord;
                    entries.push({id: value.id, updatedAt: value.updatedAt, order: historyOrder(value), bytes: value.bytes.byteLength});
                    current.continue();return;
                }
                entries.sort((a, b) => Number(b.id === protectedId) - Number(a.id === protectedId) || b.order - a.order || b.updatedAt - a.updatedAt);
                let bytes = 0, removed = false;
                for (const [index, entry] of entries.entries()) {
                    bytes += entry.bytes;
                    if (index >= DOCUMENT_HISTORY_MAX_ENTRIES || bytes > DOCUMENT_HISTORY_MAX_BYTES) {target.delete(entry.id);removed = true;}
                }
                if (removed) meta.put({key: GENERATION, value: `g:${globalThis.crypto.randomUUID()}`});
            } catch {target.transaction.abort();}
        };
    };
    // 序列与记录写入同事务提交，不受系统时间回拨影响；旧记录保持原来的时间排序。
    const nextOrder = (target: IDBObjectStore, meta: IDBObjectStore, done: (order: number) => void) => {
        const request = meta.get(SEQUENCE);
        request.onsuccess = () => {
            try {
                const previous = request.result?.value;
                if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid history sequence');
                const order = previous + 1;
                meta.put({key: SEQUENCE, value: order});
                done(order);
            } catch {target.transaction.abort();}
        };
    };
    const readVersion = (target: IDBObjectStore, meta: IDBObjectStore, id: string, done: (record: DocumentHistoryRecord | null, version: string) => void) => {
        const recordRequest = target.get(id), generationRequest = meta.get(GENERATION);
        let pending = 2;
        const complete = () => {
            if (--pending) return;
            try {
                const generation = generationRequest.result?.value;
                if (typeof generation !== 'string' || !generation.startsWith('g:')) throw new Error('Invalid history generation');
                let record = (recordRequest.result as DocumentHistoryRecord | undefined) ?? null;
                if (record && documentHistoryVersion(record) === 'legacy') {
                    record = {...record, storageVersion: `v:${globalThis.crypto.randomUUID()}`};
                    target.put(record);
                }
                done(record, record ? record.storageVersion! : generation);
            } catch {target.transaction.abort();}
        };
        recordRequest.onsuccess = complete;
        generationRequest.onsuccess = complete;
    };
    const loadChecked: DocumentHistory['loadChecked'] = id => guarded<Awaited<ReturnType<DocumentHistory['loadChecked']>>>({status: 'unavailable'}, async signal => {
        let result: Awaited<ReturnType<DocumentHistory['loadChecked']>> = {status: 'unavailable'};
        await write(signal, (target, meta) => readVersion(target, meta, id, (record, version) => {
            result = {status: 'ok', record: record ? normalizeDocumentHistoryCachePolicy(record) : null, version};
        }));
        return result;
    });
    type CheckedSave = Awaited<ReturnType<DocumentHistory['saveChecked']>>;
    const saveChecked: DocumentHistory['saveChecked'] = (record, expected) => guarded<CheckedSave>({status: 'unavailable'}, async signal => {
        if (!record.id || record.bytes.byteLength > DOCUMENT_HISTORY_MAX_BYTES) return {status: 'unavailable'};
        const version = `v:${globalThis.crypto.randomUUID()}`;
        const saved = {...normalizeDocumentHistoryCachePolicy(record), storageVersion: version, bytes: record.bytes.slice(), translations: [...record.translations],
            retainedRevisions: retainedDocumentRevisions(Array.isArray(record.retainedRevisions) ? record.retainedRevisions : [])};
        let conflict = false;
        await write(signal, (target, meta) => readVersion(target, meta, record.id, (_current, actual) => {
            if (actual !== expected) {conflict = true;return;}
            nextOrder(target, meta, order => {target.put({...saved, storageOrder: order});enforceLimit(target, meta, record.id, signal);});
        }));
        return conflict ? {status: 'conflict'} : {status: 'saved', version};
    });

    return {
        list: () => guarded<DocumentHistorySummary[]>([], async signal => (await all(signal)).map(entry => entry.summary)),
        listChecked: () => guarded<{status: 'ok'; entries: DocumentHistorySummary[]} | {status: 'unavailable'}>({status: 'unavailable'}, async signal => ({status: 'ok', entries: (await all(signal)).map(entry => ({...entry.summary, historyVersion: entry.version!}))})),
        load: async id => {const result = await loadChecked(id);return result.status === 'ok' ? result.record : null;},
        loadChecked,
        saveChecked,
        save: record => guarded(false, async signal => {
            if (!record.id || record.bytes.byteLength > DOCUMENT_HISTORY_MAX_BYTES) return false;
            const saved = {...normalizeDocumentHistoryCachePolicy(record), storageVersion: `v:${globalThis.crypto.randomUUID()}`, bytes: record.bytes.slice(), translations: [...record.translations],
                retainedRevisions: retainedDocumentRevisions(Array.isArray(record.retainedRevisions) ? record.retainedRevisions : [])};
            await write(signal, (target, meta) => nextOrder(target, meta, order => {target.put({...saved, storageOrder: order});enforceLimit(target, meta, record.id, signal);}));
            return true;
        }),
        removeChecked: (id, expected) => guarded<{status: 'removed' | 'conflict' | 'unavailable'}>({status: 'unavailable'}, async signal => {
            let conflict = false;
            await write(signal, (target, meta) => {
                const read = target.get(id), generation = meta.get(GENERATION);
                let pending = 2;
                const complete = () => {
                    if (--pending) return;
                    try {
                        const value = generation.result?.value;
                        if (typeof value !== 'string' || !value.startsWith('g:')) throw new Error('Invalid history generation');
                        const record = (read.result as DocumentHistoryRecord | undefined) ?? null;
                        if (!record || documentHistoryVersion(record) !== expected) {conflict = true;return;}
                        target.delete(id);
                        meta.put({key: GENERATION, value: `g:${globalThis.crypto.randomUUID()}`});
                    } catch {target.transaction.abort();}
                };
                read.onsuccess = complete;generation.onsuccess = complete;
            });
            return {status: conflict ? 'conflict' : 'removed'};
        }),
        remove: id => guarded(false, async signal => {await write(signal, (target, meta) => {target.delete(id);meta.put({key: GENERATION, value: `g:${globalThis.crypto.randomUUID()}`});});return true;}),
        clear: () => guarded(false, async signal => {await write(signal, (target, meta) => {target.clear();meta.put({key: GENERATION, value: `g:${globalThis.crypto.randomUUID()}`});});return true;}),
    };
}
