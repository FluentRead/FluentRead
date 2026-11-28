/**
 * @file src/features/document-translation/core/materialLocator.ts
 * 文件职责：为文档校订恢复与材料学习入口提供无副作用的材料身份、原文位置契约。
 * 主要内容：以本地历史的文件内容摘要为材料身份，优先提取 PDF 页及首行、EPUB 章节、DOCX 段落等原生位置，只有结构化 JSON 才使用路径标签；引用保留创建时相同位置候选数，避免目标删除后误指向剩余重复句；原文逐字符一致是恢复的前提，重复片段仅接受双向唯一的位置或邻文证据，歧义位置不按出现次序猜测。
 * 模块边界：只消费解析模型，不读取文件、配置、数据库或网络；引用包含原文，仅供本地使用，不含 URL、令牌或用户配置，调用方不得将其自动上传或写入日志。
 */
import type {DocumentSegment, ParsedDocument} from './document';
import {stripDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';

export interface DocumentSourceLocator {
    version: 1;
    /** 原文必须精确相等；不进行断词、大小写或 Unicode 归一化。 */
    source: string;
    /** 原生位置的稳定范围，展示文本 contextLabel 不参与身份。 */
    scope?: string;
    position?: string;
    before?: string;
    after?: string;
}

export interface DocumentMaterialReference {
    version: 1;
    /** 与 documentHistoryId 一致的本地文件内容摘要；不使用文件名或来源 URL。 */
    materialId: string;
    locator: DocumentSourceLocator;
    /** 创建时共享原文、范围与原生位置的候选数；旧引用缺失时按精确原生位置或上下文保守恢复。 */
    locatorOccurrences?: number;
}

export const DOCUMENT_MATERIAL_REFERENCE_LIMITS = Object.freeze({source: 12000, context: 12000, scope: 2048, position: 512, total: 36000});

/** 持久化边界只保留版本化白名单，并与文件内容摘要绑定；原文及邻文逐字符复制。 */
export function normalizeDocumentMaterialReference(input: unknown, materialId: string): DocumentMaterialReference | undefined {
    if (!/^[a-f\d]{32}$/u.test(materialId) || !input || typeof input !== 'object' || Array.isArray(input)) return;
    const reference = input as Record<string, unknown>;
    if (!Object.hasOwn(reference, 'version') || reference.version !== 1 || !Object.hasOwn(reference, 'materialId') || reference.materialId !== materialId
        || !Object.hasOwn(reference, 'locator') || !reference.locator || typeof reference.locator !== 'object' || Array.isArray(reference.locator)) return;
    const occurrences = reference.locatorOccurrences;
    if (occurrences !== undefined && (!Object.hasOwn(reference, 'locatorOccurrences') || !Number.isSafeInteger(occurrences) || (occurrences as number) < 1)) return;
    const value = reference.locator as Record<string, unknown>;
    if (!Object.hasOwn(value, 'version') || value.version !== 1 || !Object.hasOwn(value, 'source') || typeof value.source !== 'string'
        || value.source.length === 0 || value.source.length > DOCUMENT_MATERIAL_REFERENCE_LIMITS.source) return;
    const locator: DocumentSourceLocator = {version: 1, source: value.source};
    let total = value.source.length;
    for (const key of ['scope', 'position', 'before', 'after'] as const) {
        if (value[key] === undefined) continue;
        const limit = key === 'scope' ? DOCUMENT_MATERIAL_REFERENCE_LIMITS.scope : key === 'position' ? DOCUMENT_MATERIAL_REFERENCE_LIMITS.position : DOCUMENT_MATERIAL_REFERENCE_LIMITS.context;
        if (!Object.hasOwn(value, key) || typeof value[key] !== 'string' || value[key].length > limit) return;
        total += value[key].length;
        if (total > DOCUMENT_MATERIAL_REFERENCE_LIMITS.total) return;
        locator[key] = value[key];
    }
    return {version: 1, materialId, locator, ...(occurrences === undefined ? {} : {locatorOccurrences: occurrences as number})};
}

type SourceSnapshot = {format?: unknown; segments?: unknown; binary?: unknown};

/** 为旧快照容忍缺失结构，但不把脏数据解释为有效位置。 */
export function documentSourceLocators(snapshot: SourceSnapshot): Array<DocumentSourceLocator | undefined> {
    const segments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
    const binary = snapshot.binary as ParsedDocument['binary'];
    const locators = segments.map((value: unknown): DocumentSourceLocator | undefined => {
        if (!value || typeof value !== 'object' || typeof (value as DocumentSegment).source !== 'string') return undefined;
        const segment = value as DocumentSegment;
        const locator: DocumentSourceLocator = {version: 1, source: segment.docxInline ? stripDocumentInlineMarkers(segment.source).trim() : segment.source};
        // DOCX 的 pathLabel 是“正文/页眉”等展示标签，不能与 ZIP 内原生路径竞争身份。
        if (!binary) {
            if ((snapshot.format === 'json' || snapshot.format === 'csv' || snapshot.format === 'tsv')
                && typeof segment.pathLabel === 'string' && segment.pathLabel) locator.scope = `path:${segment.pathLabel}`;
            else if (typeof segment.timeStart === 'string' && segment.timeStart && typeof segment.timeEnd === 'string' && segment.timeEnd) {
                locator.scope = `time:${JSON.stringify([segment.timeStart, segment.timeEnd])}`;
            }
        }
        return locator;
    });
    const assigned = new Set<number>();
    const assign = (index: number, scope: string, position?: string) => {
        const locator = Number.isInteger(index) && index >= 0 ? locators[index] : undefined;
        if (!locator) return;
        // 不合法的重复归属不能生成唯一的原生位置证据。
        if (assigned.has(index)) {locator.scope = 'ambiguous'; delete locator.position; return;}
        assigned.add(index);
        locator.scope = scope;
        if (position) locator.position = position;
    };
    if (binary?.kind === 'pdf' && Array.isArray(binary.pages)) {
        for (const page of binary.pages) {
            if (!page || !Number.isInteger(page.pageNumber) || page.pageNumber < 1 || !Array.isArray(page.blocks)) continue;
            for (const block of page.blocks) {
                if (!block) continue;
                const line = block.lines?.[0];
                const x = line?.x ?? block.x, y = line?.baseline ?? line?.y ?? block.y;
                const position = [x, y].every(value => typeof value === 'number' && Number.isFinite(value))
                    ? JSON.stringify([x, y]) : undefined;
                assign(block.segmentIndex, `pdf:${page.pageNumber}`, position);
            }
        }
    } else if (binary?.kind === 'epub' && Array.isArray(binary.chapters)) {
        for (const chapter of binary.chapters) {
            if (!chapter || typeof chapter.path !== 'string' || !Number.isInteger(chapter.segmentOffset) || !Number.isInteger(chapter.segmentCount)
                || chapter.segmentOffset < 0 || chapter.segmentCount < 0) continue;
            for (let index = chapter.segmentOffset; index < Math.min(segments.length, chapter.segmentOffset + chapter.segmentCount); index += 1) assign(index, `epub:${chapter.path}`);
        }
    } else if (binary?.kind === 'docx' && Array.isArray(binary.parts)) {
        for (const part of binary.parts) {
            if (!part || typeof part.path !== 'string' || !Array.isArray(part.paragraphSegments)) continue;
            for (const paragraph of part.paragraphSegments) {
                if (!paragraph || !Number.isInteger(paragraph.paragraphIndex) || paragraph.paragraphIndex < 0) continue;
                assign(paragraph.segmentIndex, `docx:${part.path}`, `paragraph:${paragraph.paragraphIndex}`);
            }
        }
    } else if (binary?.kind === 'pptx' && Array.isArray(binary.parts)) {
        for (const part of binary.parts) {
            if (!part || typeof part.path !== 'string' || !Array.isArray(part.paragraphSegments)) continue;
            for (const paragraph of part.paragraphSegments) {
                if (!paragraph || !Number.isInteger(paragraph.paragraphIndex) || paragraph.paragraphIndex < 0) continue;
                assign(paragraph.segmentIndex, `pptx:${part.path}`, `paragraph:${paragraph.paragraphIndex}`);
            }
        }
    } else if (binary?.kind === 'xlsx' && Array.isArray(binary.sheets)) {
        for (const sheet of binary.sheets) {
            if (!sheet || typeof sheet.path !== 'string' || !Array.isArray(sheet.cellSegments)) continue;
            for (const cell of sheet.cellSegments) {
                if (!cell || typeof cell.cellRef !== 'string' || !cell.cellRef) continue;
                assign(cell.segmentIndex, `xlsx:${sheet.path}`, `cell:${cell.cellRef}`);
            }
        }
    }
    locators.forEach((locator, index) => {
        if (!locator) return;
        locator.before = locators[index - 1]?.source;
        locator.after = locators[index + 1]?.source;
    });
    return locators;
}

/** 学习工作区可保存此引用并在重新解析后调用 resolveDocumentMaterialReference；片段 id 只是当前模型索引。 */
export function createDocumentMaterialReference(materialId: string, document: ParsedDocument, index: number): DocumentMaterialReference | undefined {
    if (!/^[a-f\d]{32}$/u.test(materialId)) return undefined;
    const locators = documentSourceLocators(document), locator = locators[index];
    if (!locator || locator.scope === 'ambiguous') return undefined;
    const candidates = locators.filter(other => other && other.source === locator.source
        && other.scope === locator.scope && other.position === locator.position);
    // 原文与邻文都重复时，引用在创建当下已经歧义；不能待其他出现位置删除后误判为唯一。
    if (candidates.length > 1 && candidates.filter(other => other!.before === locator.before && other!.after === locator.after).length !== 1) return undefined;
    return {version: 1, materialId, locator, locatorOccurrences: candidates.length};
}

function compatible(left: DocumentSourceLocator, right: DocumentSourceLocator): boolean {
    return left.scope !== 'ambiguous' && right.scope !== 'ambiguous'
        && (!left.scope || !right.scope || left.scope === right.scope);
}

/** 返回旧数组索引；映射双向唯一，重复原文不会通过数组次序、模糊字符串或近似几何套用。 */
export function matchDocumentSourceLocators(previous: readonly (DocumentSourceLocator | undefined)[], current: readonly (DocumentSourceLocator | undefined)[], origins?: readonly (number | undefined)[], unchangedOrder = false): Array<number | undefined> {
    const result: Array<number | undefined> = current.map(() => undefined);
    const claimed = new Set<number>();
    const directCounts = new Map<number, number>();
    origins?.forEach(origin => {if (typeof origin === 'number') directCounts.set(origin, (directCounts.get(origin) ?? 0) + 1);});
    current.forEach((locator, index) => {
        const origin = origins?.[index];
        if (!locator || typeof origin !== 'number' || !Number.isInteger(origin) || origin < 0 || directCounts.get(origin) !== 1
            || previous[origin]?.source !== locator.source || !compatible(previous[origin]!, locator)) return;
        result[index] = origin; claimed.add(origin);
    });
    // 调用方确认解析版本/快照未变时，完整未变序列可以保留独立空槽；不同的原生位置仍然拒绝。
    const unchanged = previous.length === current.length && current.every((locator, index) => locator && previous[index]
        && locator.source === previous[index]!.source && compatible(previous[index]!, locator)
        && previous[index]!.position === locator.position);
    if (unchangedOrder && unchanged && !origins?.some(origin => origin !== undefined)) return current.map((_locator, index) => index);
    const oldGroups = new Map<string, number[]>(), newGroups = new Map<string, number[]>();
    const group = (map: Map<string, number[]>, source: string, index: number) => {const indexes = map.get(source) ?? []; indexes.push(index); map.set(source, indexes);};
    previous.forEach((locator, index) => {if (locator && !claimed.has(index)) group(oldGroups, locator.source, index);});
    current.forEach((locator, index) => {if (locator && result[index] === undefined) group(newGroups, locator.source, index);});
    for (const [source, fresh] of newGroups) {
        const old = oldGroups.get(source) ?? [];
        if (old.length === 1 && fresh.length === 1) {
            if (compatible(previous[old[0]]!, current[fresh[0]]!)) result[fresh[0]] = old[0];
            continue;
        }
        // 唯一原生位置优先；邻文需要前后同时存在且完全一致，页/章节范围仍须相容。
        for (const key of [
            (locator: DocumentSourceLocator) => locator.scope && (locator.position || /^(?:path:|time:|epub:)/u.test(locator.scope)) ? JSON.stringify([locator.scope, locator.position]) : undefined,
            (locator: DocumentSourceLocator) => locator.before !== undefined && locator.after !== undefined
                ? JSON.stringify([locator.scope, locator.before, locator.after]) : undefined,
        ]) {
            const before = new Map<string, number[]>(), after = new Map<string, number[]>();
            old.forEach(index => {if (!claimed.has(index)) {const value = key(previous[index]!); if (value) group(before, value, index);}});
            fresh.forEach(index => {if (result[index] === undefined) {const value = key(current[index]!); if (value) group(after, value, index);}});
            for (const [value, indexes] of after) {
                const candidates = before.get(value);
                if (indexes.length !== 1 || candidates?.length !== 1 || !compatible(previous[candidates[0]]!, current[indexes[0]]!)) continue;
                result[indexes[0]] = candidates[0]; claimed.add(candidates[0]);
            }
        }
    }
    return result;
}

/** 身份和原文位置均匹配时返回当前模型索引；不明确时由调用方展示保留资料。 */
export function resolveDocumentMaterialReference(reference: DocumentMaterialReference, materialId: string, document: ParsedDocument): number | undefined {
    if (!reference || typeof reference !== 'object' || reference.version !== 1 || !reference.locator
        || typeof reference.locator !== 'object' || reference.locator.version !== 1 || typeof reference.locator.source !== 'string'
        || reference.locatorOccurrences !== undefined && (!Number.isInteger(reference.locatorOccurrences) || reference.locatorOccurrences < 1)
        || !/^[a-f\d]{32}$/u.test(materialId) || reference.materialId !== materialId
        || [reference.locator.scope, reference.locator.position, reference.locator.before, reference.locator.after]
            .some(value => value !== undefined && typeof value !== 'string')) return undefined;
    const locators = documentSourceLocators(document);
    const anchor = reference.locator;
    const candidates = locators.flatMap((locator, index) => locator && locator.source === anchor.source && compatible(anchor, locator)
        && (!anchor.scope || locator.scope === anchor.scope)
        && (!anchor.position || locator.position === anchor.position) ? [index] : []);
    const preciseNative = Boolean(anchor.scope && (anchor.position || /^(?:path:|time:)/u.test(anchor.scope)));
    // 只有创建时也唯一的引用，才能在邻文变化后继续按唯一原文定位；旧原生引用保留精确位置兼容。
    if (candidates.length === 1 && (reference.locatorOccurrences === 1 || reference.locatorOccurrences === undefined && preciseNative)) return candidates[0];
    const contextual = candidates.filter(index => locators[index]!.before === anchor.before && locators[index]!.after === anchor.after);
    return contextual.length === 1 ? contextual[0] : undefined;
}
