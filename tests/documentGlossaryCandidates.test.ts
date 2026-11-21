import {describe, expect, it, vi} from 'vitest';
import {getDocumentGlossaryCopy} from '@/src/app/document-translation/glossaryCopy';
import {
    documentGlossaryDestinations, extractDocumentGlossaryCandidates, filterDocumentGlossaryCandidates, planDocumentGlossaryUpdate,
} from '@/src/features/document-translation/core/glossaryCandidates';
import {createDocumentSegmentTranslator} from '@/src/features/document-translation/services/translation';
import type {GlossaryLibrary} from '@/src/core/glossary';

const segments = (...texts: string[]) => texts.map((source, id) => ({id, source}));
const paper = segments(
    'This paper introduces retrieval-augmented generation (RAG). It combines search with generation.',
    'RAG uses the retrieved passages. A Dense Passage Retriever finds candidates.',
    'This paragraph discusses the evaluation dataset.',
    'A Dense Passage Retriever ranks documents. RAG then conditions on those results.',
    'RAGGED and rag are separate spellings.',
);
const library = (properties: Partial<GlossaryLibrary> = {}): GlossaryLibrary => ({
    id: 'academic', name: 'Academic', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-hans',
    domains: [], entries: [], ...properties,
});
const config = (glossaryLibraries: GlossaryLibrary[] = [], documentGlossaryIds: string[] | null = null, glossaryEnabled = true) => ({
    glossaryLibraries, documentGlossaryIds, glossaryEnabled, from: 'en', to: 'zh-Hans',
});
const choice = {source: 'RAG', target: '检索增强生成', evidence: paper[0].source, caseSensitive: true};

describe('document glossary candidates', () => {
    it('keeps evidence for an acronym, its full form and a recurring proper name', () => {
        const result = extractDocumentGlossaryCandidates(paper);
        expect(result.map(item => [item.source, item.caseSensitive])).toEqual([
            ['retrieval-augmented generation', false], ['RAG', true], ['Dense Passage Retriever', true],
        ]);
        expect(result[0].evidence).toBe('This paper introduces retrieval-augmented generation (RAG).');
        expect(result[1].evidence).toBe(result[0].evidence);
        expect(result[2].evidence).toBe('A Dense Passage Retriever finds candidates.');
    });

    it('aligns connector words, handles hyphenated definitions and ignores incidental capitalisation', () => {
        expect(extractDocumentGlossaryCandidates(segments(
            'University of California (UC) and role-based (RB). A Single Name occurs once. One line with (QW).',
            `(XX). A Repeated Phrase and a Repeated Phrase still occur in one paragraph. Excessively ${'L' + 'o'.repeat(200)} Name.`,
        )).map(candidate => candidate.source)).toEqual(['University of California', 'UC', 'role-based', 'RB']);
    });

    it('bounds proposal count, scanned paragraphs and the source excerpt around the term', () => {
        const many = Array.from({length: 18}, (_, index) => {
            const name = String.fromCharCode(66 + index);
            return `${name}eta delta (${name}D)`;
        });
        expect(extractDocumentGlossaryCandidates(segments(...many))).toHaveLength(12);
        const longWords = 'nothing relevant '.repeat(208);
        const long = `${longWords}visible spectrum (VS) ${longWords}`;
        expect(extractDocumentGlossaryCandidates(segments(long))[0].evidence).toMatch(/^….{1,320}visible spectrum \(VS\).+…$/u);
        expect(extractDocumentGlossaryCandidates(segments(
            ...Array.from({length: 33}, () => 'x'.repeat(8100) + ' retrieval-augmented generation (RAG)'),
            'visible spectrum (VS)',
        ))).toEqual([]);
    });

    it('prioritises names found in more paragraphs', () => {
        expect(extractDocumentGlossaryCandidates(segments('Entity Name. Product Name.', 'Entity Name. Product Name.', 'Product Name.'))
            .map(candidate => candidate.source)).toEqual(['Product Name', 'Entity Name']);
    });

    it('filters existing sources on eligible document scopes and lists compatible empty libraries', () => {
        const filled = library({entries: [{id: 't', source: 'rag', target: '', caseSensitive: false}]});
        const empty = library({id: 'empty'});
        const domain = library({id: 'web', domains: ['example.org']});
        const foreign = library({id: 'foreign', targetLanguage: 'es'});
        const disabled = library({id: 'disabled', enabled: false});
        const settings = config([filled, empty, domain, foreign, disabled]);
        expect(documentGlossaryDestinations(settings).map(item => item.id)).toEqual(['academic', 'empty']);
        expect(filterDocumentGlossaryCandidates(settings, [choice])).toEqual([]);
        expect(filterDocumentGlossaryCandidates({...settings, documentGlossaryIds: []}, [choice])).toEqual([choice]);
    });

    it('writes only the chosen terms and matches full-token usages without altering the input library', () => {
        const current = library();
        const unrelated = library({id: 'unrelated'});
        const result = planDocumentGlossaryUpdate(config([current, unrelated]), paper, [choice], current.id, 'New');
        expect(result).toMatchObject({glossaryEnabled: true, documentGlossaryIds: null, affectedIds: new Set([0, 1, 3]),
            glossaryLibraries: [{id: current.id, entries: [{source: 'RAG', target: '检索增强生成', caseSensitive: true}]}, unrelated]});
        expect(current.entries).toEqual([]);
    });

    it('creates a scoped glossary with the real target and adds it to an explicit document selection', () => {
        const result = planDocumentGlossaryUpdate({...config([], [], false), from: 'auto'}, paper, [choice], '', 'Paper terms');
        expect(result).toMatchObject({glossaryEnabled: true, documentGlossaryIds: ['glossary-1'], affectedIds: new Set([0, 1, 3]),
            glossaryLibraries: [{name: 'Paper terms', sourceLanguage: 'en', targetLanguage: 'zh-hans'}]});
        expect(planDocumentGlossaryUpdate(config(), paper, [{...choice, source: 'Absent'}], '', 'Extra')).toMatchObject({affectedIds: new Set()});
    });

    it('takes newly effective terms into account when the global glossary is first enabled', () => {
        const previous = library({entries: [{id: 't', source: 'evaluation dataset', target: '评估数据集', caseSensitive: false}]});
        const result = planDocumentGlossaryUpdate(config([previous], null, false), paper, [choice], 'academic', 'Paper');
        expect(result).toMatchObject({affectedIds: new Set([0, 1, 2, 3])});
    });

    it('skips a match fully covered by a longer effective term', () => {
        const previous = library({entries: [{id: 't', source: 'RAG uses', target: '用旧术语', caseSensitive: false}]});
        const result = planDocumentGlossaryUpdate(config([previous]), paper, [choice], previous.id, 'Paper');
        expect(result).toMatchObject({affectedIds: new Set([0, 3])});
    });

    it('rejects conflicting, blank, invalid or excessive entries without persisting a partial update', () => {
        const existing = library({entries: [{id: 't', source: 'rag', target: '已有术语', caseSensitive: false}]});
        const invalid = [
            {...choice, target: ' '},
            {...choice, source: ''},
            {...choice, source: 'x'.repeat(201)},
            {...choice, target: '😀'.repeat(201)},
        ];
        for (const term of invalid) expect(planDocumentGlossaryUpdate(config(), paper, [term], '', 'Paper')).toEqual({error: 'entry'});
        expect(planDocumentGlossaryUpdate(config(), paper, [], '', 'Paper')).toEqual({error: 'entry'});
        expect(planDocumentGlossaryUpdate(config(), paper, [choice, choice], '', 'Paper')).toEqual({error: 'entry'});
        expect(planDocumentGlossaryUpdate(config([existing]), paper, [choice], '', 'Paper')).toEqual({error: 'entry'});
        expect(planDocumentGlossaryUpdate(config([existing]), paper, [choice], 'missing', 'Paper')).toEqual({error: 'library'});
        expect(planDocumentGlossaryUpdate(config(Array.from({length: 20}, (_, id) => library({id: String(id)}))), paper, [choice], '', 'Paper')).toEqual({error: 'capacity'});
        const entries = Array.from({length: 500}, (_, id) => ({id: `old-${id}`, source: `old ${id}`, target: '旧词', caseSensitive: false}));
        expect(planDocumentGlossaryUpdate(config([library({entries})]), paper, [choice], 'academic', 'Paper')).toEqual({error: 'capacity'});
        const full = Array.from({length: 10}, (_, id) => library({id: String(id), entries}));
        expect(planDocumentGlossaryUpdate(config(full), paper, [choice], '', 'Paper')).toEqual({error: 'capacity'});
    });

    it('keeps unselected translations and sends only explicitly requested paragraphs, including an identical old translation', async () => {
        const translateText = vi.fn(async (text: string) => `New ${text}`);
        const onSegment = vi.fn();
        const translate = createDocumentSegmentTranslator({waitUntilReady: () => {}, getDefaultService: () => 'microsoft',
            supportsBatch: () => false, translateText, translateTextBatch: vi.fn()});
        const result = await translate(segments('same phrase', 'keep this', 'same phrase', 'untranslated'), {
            fileName: 'paper.txt', initialTranslations: ['old', 'manually corrected', 'retained'],
            segmentIds: new Set([0, 2, 3]), retranslateIds: new Set([1, 2]), onSegment,
        });
        expect(translateText).toHaveBeenCalledTimes(1);
        expect(translateText.mock.calls[0][0]).toBe('same phrase');
        expect(onSegment).toHaveBeenCalledExactlyOnceWith({id: 2, translation: 'New same phrase'});
        expect(result).toEqual(['old', 'manually corrected', 'New same phrase', '']);
    });

    it('provides localised document-only copy', () => {
        expect(getDocumentGlossaryCopy('zh-CN').extract).toBe('提取术语候选');
        expect(getDocumentGlossaryCopy('en-US').extract).toBe('Find glossary candidates');
    });
});
