/**
 * @file src/features/vocabulary/materialSummary.ts
 * 文件职责：生成材料列表摘要并保持工作区的原有全文搜索语义。
 * 主要内容：提取显示字段、精确预览及引用数量，对完整拼接文本执行大小写搜索。
 * 模块边界：不访问数据库、消息或界面；不将全部引用正文放入列表摘要。
 */
import type {MaterialKind, MaterialRecord} from './materialProtocol';

export interface MaterialSummary {
    id: string;
    kind: MaterialKind;
    title: string;
    sourceUrl?: string;
    topics: string[];
    lastReadAt: number;
    updatedAt: number;
    archivedAt: number | null;
    preview: string;
    referenceCount: number;
}
export interface MaterialSummaryQuery {archived?: boolean; topic?: string; search?: string}

export function summarizeMaterial(record: MaterialRecord): MaterialSummary {
    return {
        id: record.id,
        kind: record.kind,
        title: record.title,
        sourceUrl: record.source.url,
        topics: [...record.topics],
        lastReadAt: record.lastReadAt,
        updatedAt: record.updatedAt,
        archivedAt: record.archivedAt,
        preview: record.locator?.quote || record.references.find(reference => reference.excerpt || reference.note)?.excerpt
            || record.references.find(reference => reference.note)?.note || '',
        referenceCount: record.references.length,
    };
}
/** Match the workspace's original whole-string search, including field spaces. */
export function normalizeMaterialSearch(query: string): string {return query.trim().toLocaleLowerCase();}

/** `search` must already be normalized with normalizeMaterialSearch. */
export function matchesNormalizedMaterialSearch(record: MaterialRecord, search: string): boolean {
    if (!search) return true;
    return [record.title, record.source.url, ...record.topics,
        ...record.references.flatMap(reference => [reference.excerpt, reference.note])]
        .join(' ').toLocaleLowerCase().includes(search);
}
