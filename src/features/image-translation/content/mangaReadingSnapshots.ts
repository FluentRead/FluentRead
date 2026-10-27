/**
 * @file src/features/image-translation/content/mangaReadingSnapshots.ts
 * 文件职责：为仍在阅读会话中的漫画载体临时保存有界的可读文字快照，不持有宿主 DOM 或图片像素。
 * 主要内容：以同一模块实例内单调生成的正整数身份隔离条目；校验并复制必要的文字与坐标，按 UTF-16 内容和固定结构费计量，按条数、行数与字节预算拒绝超大结果，支持 LRU、原子替换、显式释放及清空，不截断内容。
 * 模块边界：纯内存数据结构，不读取来源、配置、DOM、持久存储或缓存开关；调用方负责仅在活动页持有、校验来源及及时释放。计费严格受限，但不是 JS 堆或系统内存硬上限。
 */
import type {OcrLine} from '@/src/shared/image/types';

export interface MangaReadingLine extends OcrLine {
    sourceText?: string;
    backgroundColor?: string;
}

export interface MangaReadingSnapshotOptions {
    maxEntries?: number;
    maxBytes?: number;
    maxLines?: number;
}

export type MangaReadingSnapshotPutResult = 'stored' | 'invalid' | 'overBudget';
export type MangaReadingLinesResult = {status: 'ready'; lines: MangaReadingLine[]; bytes: number}
    | {status: 'invalid' | 'overBudget'};

// 这是活动页文字的保守计费限额，不改变或替代既有译图缓存。
const MAX_ENTRIES = 64, MAX_BYTES = 1024 * 1024, MAX_LINES = 512;
const ENTRY_CHARGE = 64, LINE_CHARGE = 96;

/** 独立数字序列；共享存储只使用模块内唯一实例，耗尽后显式拒绝。 */
export function createMangaReadingKeyAllocator(previous = 0): () => number | undefined {
    if (!Number.isSafeInteger(previous) || previous < 0) throw new RangeError('漫画阅读身份无效');
    let last = previous;
    return () => {
        if (last >= Number.MAX_SAFE_INTEGER) return;
        last += 1;return last;
    };
}
const allocateGlobalKey = createMangaReadingKeyAllocator();

function limit(value: number | undefined, maximum: number): number {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError('漫画文字快照预算无效');
    return value;
}

function validKey(key: number): boolean {return Number.isSafeInteger(key) && key > 0;}

function copyLine(value: unknown): MangaReadingLine | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    const {text, sourceText, backgroundColor, vertical, bbox: box} = item;
    if (typeof text !== 'string' || (sourceText !== undefined && typeof sourceText !== 'string')
        || (backgroundColor !== undefined && typeof backgroundColor !== 'string')
        || (vertical !== undefined && vertical !== true)) return;
    if (!box || typeof box !== 'object' || Array.isArray(box)) return;
    const {x0, y0, x1, y1} = box as Record<string, unknown>;
    if (typeof x0 !== 'number' || typeof y0 !== 'number' || typeof x1 !== 'number' || typeof y1 !== 'number'
        || ![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return;
    return {text, bbox: {x0, y0, x1, y1},
        ...(sourceText !== undefined ? {sourceText} : {}),
        ...(backgroundColor !== undefined ? {backgroundColor} : {}),
        ...(vertical === true ? {vertical: true as const} : {})};
}

/** 只复制指定页的可读字段；适用于现有缓存命中，不将结果额外驻留。 */
export function prepareMangaReadingLines(input: unknown, options: Pick<MangaReadingSnapshotOptions, 'maxBytes' | 'maxLines'> = {}): MangaReadingLinesResult {
    const maxBytes = limit(options.maxBytes, MAX_BYTES), maxLines = limit(options.maxLines, MAX_LINES);
    try {
        if (!Array.isArray(input)) return {status: 'invalid'};
        if (input.length > maxLines) return {status: 'overBudget'};
        let bytes = ENTRY_CHARGE;
        const lines: MangaReadingLine[] = [];
        for (const value of input) {
            const line = copyLine(value);
            if (!line) return {status: 'invalid'};
            bytes += LINE_CHARGE + 2 * (line.text.length + (line.sourceText?.length ?? 0) + (line.backgroundColor?.length ?? 0));
            if (bytes > maxBytes) return {status: 'overBudget'};
            lines.push(line);
        }
        if (bytes > maxBytes) return {status: 'overBudget'};
        return {status: 'ready', lines, bytes};
    } catch {return {status: 'invalid'};}
}

/** 数据复制与预算计算先于 LRU 变更；失败不会撤销原有结果。 */
export function createMangaReadingSnapshots(options: MangaReadingSnapshotOptions = {}) {
    const maxEntries = limit(options.maxEntries, MAX_ENTRIES), maxBytes = limit(options.maxBytes, MAX_BYTES), maxLines = limit(options.maxLines, MAX_LINES);
    const entries = new Map<number, {lines: MangaReadingLine[]; bytes: number}>();
    let bytes = 0;
    function remove(key: number): void {
        const previous = entries.get(key);
        if (!previous) return;
        entries.delete(key);bytes -= previous.bytes;
    }
    return {
        allocateKey: allocateGlobalKey,
        put(key: number, input: readonly MangaReadingLine[]): MangaReadingSnapshotPutResult {
            if (!validKey(key)) return 'invalid';
            if (maxEntries === 0) return 'overBudget';
            const prepared = prepareMangaReadingLines(input, {maxBytes, maxLines});
            if (prepared.status !== 'ready') return prepared.status;
            remove(key);
            while (entries.size >= maxEntries || bytes + prepared.bytes > maxBytes) remove(entries.keys().next().value!);
            entries.set(key, {lines: prepared.lines, bytes: prepared.bytes});bytes += prepared.bytes;
            return 'stored';
        },
        get(key: number): MangaReadingLine[] | undefined {
            if (!validKey(key)) return;
            const entry = entries.get(key);
            if (!entry) return;
            entries.delete(key);entries.set(key, entry);
            return entry.lines.map(line => ({...line, bbox: {...line.bbox}}));
        },
        remove,
        clear() {entries.clear();bytes = 0;},
        stats() {return {entries: entries.size, bytes};},
    };
}
