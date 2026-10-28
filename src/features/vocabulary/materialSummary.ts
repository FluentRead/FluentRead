/**
 * Lightweight material list data. Full references remain in the repository and
 * are only used here to compute the existing preview and search semantics.
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

export function matchesMaterialSearch(record: MaterialRecord, query: string): boolean {
    return matchesNormalizedMaterialSearch(record, normalizeMaterialSearch(query));
}

export function compareMaterialSummaries(a: MaterialSummary, b: MaterialSummary): number {
    return b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}
