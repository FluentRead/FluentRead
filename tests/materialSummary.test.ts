import {describe, expect, it} from 'vitest';
import {matchesNormalizedMaterialSearch, normalizeMaterialSearch, summarizeMaterial} from '@/src/features/vocabulary/materialSummary';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

function material(overrides: Partial<MaterialRecord> = {}): MaterialRecord {
    return {
        id: 'material', identityKey: 'private identity', aliases: ['private alias'], kind: 'article', title: 'Title',
        source: {kind: 'article', url: 'https://example.test/page'}, topics: ['Topic'], references: [],
        createdAt: 1, updatedAt: 2, lastReadAt: 3, archivedAt: null, ...overrides,
    };
}

function oldSearch(record: MaterialRecord, query: string): boolean {
    const search = query.trim().toLocaleLowerCase();
    return !search || [record.title, record.source.url, ...record.topics,
        ...record.references.flatMap(reference => [reference.excerpt, reference.note])].join(' ').toLocaleLowerCase().includes(search);
}

describe('material summaries', () => {
    it('sends only list fields and the untruncated existing preview', () => {
        const excerpt = 'x'.repeat(5000);
        const record = material({references: [{kind: 'note', id: 'private', excerpt, note: 'private note'}]});
        const summary = summarizeMaterial(record);
        expect(summary).toEqual({
            id: 'material', kind: 'article', title: 'Title', sourceUrl: 'https://example.test/page', topics: ['Topic'],
            lastReadAt: 3, updatedAt: 2, archivedAt: null, preview: excerpt, referenceCount: 1,
        });
        summary.topics.push('new');
        expect(record.topics).toEqual(['Topic']);
        expect(summary).not.toHaveProperty('references');
        expect(summary).not.toHaveProperty('identityKey');
        expect(summary).not.toHaveProperty('aliases');
    });

    it('uses the original preview priority even when the first occupied reference has only a note', () => {
        const refs: MaterialRecord['references'] = [
            {kind: 'note', id: 'a'}, {kind: 'note', id: 'b', note: 'first note'},
            {kind: 'note', id: 'c', excerpt: 'later excerpt', note: 'later note'},
        ];
        expect(summarizeMaterial(material({references: refs})).preview).toBe('first note');
        expect(summarizeMaterial(material({references: refs, locator: {kind: 'text', quote: 'location'}})).preview).toBe('location');
        expect(summarizeMaterial(material({references: [{kind: 'note', id: 'd', excerpt: 'first excerpt'}]})).preview).toBe('first excerpt');
        expect(summarizeMaterial(material()).preview).toBe('');
    });

    it('matches the old joined search for field boundaries, missing values, and contextual Unicode casing', () => {
        const records = [
            material({title: 'A', source: {kind: 'article'}, topics: [], references: [{kind: 'note', id: 'n', note: 'B'}]}),
            material({title: 'ΟΣ', source: {kind: 'article', url: 'ΟΣΑ'}, topics: ['ΘΈΜΑ'], references: [{kind: 'note', id: 'n', excerpt: 'ἈΣ', note: 'Σ'}]}),
            material({title: '', source: {kind: 'article'}, topics: ['', 'İ'], references: [{kind: 'note', id: 'n', excerpt: '', note: ''}]}),
        ];
        const queries = ['', ' ', 'A', 'a   b', 'ΟΣ', 'ος', 'οσα', 'Σ', 'σ', 'ς', 'İ', 'i', 'ΘΈΜΑ', 'note', 'no match'];
        for (const record of records) for (const query of queries) {
            expect(matchesNormalizedMaterialSearch(record, normalizeMaterialSearch(query)), JSON.stringify({record, query})).toBe(oldSearch(record, query));
        }
        expect(matchesNormalizedMaterialSearch(records[0], normalizeMaterialSearch('a   b'))).toBe(true);
    });

});
