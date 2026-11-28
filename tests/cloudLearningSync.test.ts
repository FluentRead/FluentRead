import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {driveSyncPayload, parseDriveSyncSnapshot, toDriveSyncConfig} from '@/src/core/config/driveSync';
import {
    buildLearningSyncDiff,
    DEFAULT_LEARNING_SYNC_SCOPE,
    hasAnyLearningSyncScope,
    hasLearningBundleContent,
    LEARNING_SYNC_FORMAT,
    LEARNING_SYNC_MAX_BYTES,
    LEARNING_SYNC_MAX_MATERIALS,
    LEARNING_SYNC_MAX_VOCABULARY,
    LEARNING_SYNC_VERSION,
    LearningSyncError,
    mergeLearningPersonalCorrections,
    mergeLearningReadingMaterials,
    mergeLearningVocabulary,
    normalizeLearningSyncScope,
    validateLearningSyncBundle,
    type LearningSyncBundle,
    type LearningSyncCorrectionEntry,
    type LearningSyncPersonalCorrections,
    type LearningSyncReadingMaterial,
    type LearningSyncVocabularyEntry,
} from '@/src/core/config/learningSync';
import {createLearningCloudSync} from '@/src/services/config/learningCloudSync';
import {createGoogleDriveSync, type DriveSyncPorts} from '@/src/services/config/googleDriveSync';
import {createWebDavBackup, type WebDavBackupPorts} from '@/src/services/config/webDavBackup';
import {createWebDavConnectionStore} from '@/src/platform/webdav/connection';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {decryptDriveConfig} from '@/src/platform/google-drive/encryption';
import {initialDriveDirection} from '@/src/features/settings/model/googleDrivePreview';
import type {VocabularyBookExport} from '@/src/features/vocabulary/learningModel';
import type {MaterialBackup, MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {PersonalCorrectionRepository} from '@/src/platform/storage/personalCorrectionRepository';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import type {PersonalCorrectionSnapshot} from '@/src/services/personal-corrections/store';
import type {CloudSyncRemote} from '@/src/core/config/cloudSync';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const PROJ_1 = '33333333-3333-4333-8333-333333333333';
const PROJ_2 = '44444444-4444-4444-8444-444444444444';
const MAT_ID_1 = `material-${'a'.repeat(64)}`;
const MAT_ID_2 = `material-${'b'.repeat(64)}`;

function vocabEntry(patch: Partial<LearningSyncVocabularyEntry> = {}): LearningSyncVocabularyEntry {
    return {
        id: UUID_1,
        identityKey: 'en\u0000serendipity',
        sourceLanguage: 'en',
        term: 'serendipity',
        normalizedTerm: 'serendipity',
        translations: {'zh-CN': {text: '意外发现', updatedAt: 100}},
        phonetic: '/ˌser.ənˈdɪp.ə.ti/',
        partOfSpeech: 'noun',
        contexts: [{capturedAt: 100, text: 'A moment of serendipity.', sourceUrl: 'https://example.test/post', pageTitle: 'Example'}],
        createdAt: 100,
        updatedAt: 100,
        lastSeenAt: 100,
        encounterCount: 1,
        masteryLevel: 1,
        status: 'learning',
        nextReviewAt: 200,
        lastReviewedAt: 100,
        reviewCount: 1,
        lapseCount: 0,
        schemaVersion: 1,
        ...patch,
    };
}

function correctionEntry(patch: Partial<LearningSyncCorrectionEntry> = {}): LearningSyncCorrectionEntry {
    return {
        id: UUID_1,
        scope: {kind: 'material', id: MAT_ID_1, label: 'Doc A'},
        source: 'transformer',
        translation: '变换器',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        context: 'attention mechanism',
        revision: 1,
        ...patch,
    };
}

function readingMaterial(patch: Partial<LearningSyncReadingMaterial> = {}): LearningSyncReadingMaterial {
    return {
        id: 'mat-1',
        identityKey: 'article:https://example.test/paper',
        kind: 'article',
        title: 'Attention Paper',
        source: {kind: 'article', url: 'https://example.test/paper', title: 'Attention Paper'},
        locator: {kind: 'text', quote: 'Attention is all you need'},
        topics: ['ai'],
        notes: [{id: 'note-1', excerpt: 'quote', note: 'initial note', createdAt: 100, updatedAt: 100}],
        createdAt: 100,
        updatedAt: 100,
        lastReadAt: 100,
        archivedAt: null,
        ...patch,
    };
}

function sampleConfig(patch: Record<string, unknown> = {}) {
    return toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, ...patch}));
}

function createInMemoryLearningPorts(seed?: {
    vocabulary?: VocabularyBookExport;
    corrections?: PersonalCorrectionSnapshot;
    materials?: MaterialBackup;
}) {
    let vocab: VocabularyBookExport = seed?.vocabulary ?? {
        format: 'fluentread-vocabulary-book',
        version: 1,
        exportedAt: 100,
        includesPrivateContext: true,
        entries: [],
        reviewLogs: [],
    };
    let corrections: PersonalCorrectionSnapshot = seed?.corrections ?? {
        state: {version: 1, revision: 0, entries: [], projects: [], memberships: []},
        undo: [],
    };
    let materials: MaterialBackup = seed?.materials ?? {
        format: 'fluentread-learning-materials',
        version: 1,
        exportedAt: 100,
        materials: [],
    };
    const service = createLearningCloudSync({
        vocabulary: {
            exportData: vi.fn(async options => ({
                ...structuredClone(vocab),
                includesPrivateContext: options?.includePrivateContext === true,
                entries: vocab.entries.map(entry => ({
                    ...structuredClone(entry),
                    contexts: entry.contexts.map(ctx => options?.includePrivateContext ? {...ctx} : {capturedAt: ctx.capturedAt}),
                })),
            })),
            importData: vi.fn(async (data: unknown) => {
                const incoming = data as VocabularyBookExport;
                const byKey = new Map(vocab.entries.map(e => [e.identityKey, e]));
                for (const entry of incoming.entries) byKey.set(entry.identityKey, structuredClone(entry));
                vocab = {...incoming, entries: [...byKey.values()]};
            }),
        },
        personalCorrections: {
            read: vi.fn(async () => ({value: structuredClone(corrections), expected: corrections})),
            write: vi.fn(async (expected, next) => {
                if (expected !== corrections) return false;
                corrections = structuredClone(next);
                return true;
            }),
        },
        materials: {
            exportData: vi.fn(async () => structuredClone(materials)),
            importData: vi.fn(async (data: unknown) => {
                const incoming = data as MaterialBackup;
                const byKey = new Map(materials.materials.map(m => [m.identityKey, m]));
                for (const m of incoming.materials) byKey.set(m.identityKey, structuredClone(m));
                materials = {...incoming, materials: [...byKey.values()]};
            }),
        },
        now: () => 500,
    });
    return {
        service,
        get vocab() {return vocab;},
        get corrections() {return corrections;},
        get materials() {return materials;},
        setCorrections(next: PersonalCorrectionSnapshot) {corrections = next;},
    };
}

describe('Learning Sync Core Domain & Deterministic Merge', () => {
    it('normalizes scope with all toggles off by default and enforces boolean validation', () => {
        expect(normalizeLearningSyncScope()).toEqual(DEFAULT_LEARNING_SYNC_SCOPE);
        expect(normalizeLearningSyncScope(null)).toEqual(DEFAULT_LEARNING_SYNC_SCOPE);
        expect(hasAnyLearningSyncScope(DEFAULT_LEARNING_SYNC_SCOPE)).toBe(false);
        expect(normalizeLearningSyncScope({includeVocabulary: false, includeVocabularyContext: true})).toEqual({
            includeVocabulary: false,
            includeVocabularyContext: false,
            includePersonalCorrections: false,
            includeReadingMaterials: false,
        });
        expect(normalizeLearningSyncScope({includeVocabulary: true, includeVocabularyContext: true, includePersonalCorrections: true, includeReadingMaterials: true})).toEqual({
            includeVocabulary: true,
            includeVocabularyContext: true,
            includePersonalCorrections: true,
            includeReadingMaterials: true,
        });
        expect(() => normalizeLearningSyncScope('bad')).toThrow(LearningSyncError);
        expect(() => normalizeLearningSyncScope({includeVocabulary: 'yes'})).toThrow(LearningSyncError);
    });

    it('validates learning bundles strictly and rejects prototype keys, deep trees, invalid fields, and oversized payloads', () => {
        const valid: LearningSyncBundle = {
            format: LEARNING_SYNC_FORMAT,
            version: LEARNING_SYNC_VERSION,
            vocabulary: {includesContext: true, entries: [vocabEntry({kind: 'expression', note: 'my note', noteUpdatedAt: 120})]},
            personalCorrections: {
                version: 1,
                revision: 2,
                projects: [{id: PROJ_1, label: 'ML'}],
                memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}],
                entries: [correctionEntry({scope: {kind: 'project', id: PROJ_1, label: 'ML'}, revision: 2, updatedAt: 200})],
            },
            readingMaterials: [
                readingMaterial({aliases: ['article:https://old.example.test/paper'], source: {kind: 'article', title: 'Attention Paper', fingerprint: 'src-fp'}, locator: {kind: 'document', page: 3, section: 'Intro', startMs: 0, endMs: 10, fingerprint: 'fp-1'}}),
                readingMaterial({id: 'mat-minimal', identityKey: 'article:https://example.test/min', source: {kind: 'article'}, locator: undefined, notes: [{id: 'note-min'}]}),
            ],
        };
        expect(validateLearningSyncBundle(valid)).toEqual(valid);
        expect(hasLearningBundleContent(valid)).toBe(true);
        expect(hasLearningBundleContent(null)).toBe(false);
        expect(hasLearningBundleContent({format: LEARNING_SYNC_FORMAT, version: LEARNING_SYNC_VERSION})).toBe(false);

        // Prototype pollution & depth limit
        const polluted = JSON.parse('{"format":"fluentread-learning-sync","version":1,"__proto__":{"polluted":true}}');
        expect(() => validateLearningSyncBundle(polluted)).toThrow('无效字段');
        let deep: Record<string, unknown> = {leaf: true};
        for (let i = 0; i < 25; i++) deep = {next: deep};
        expect(() => validateLearningSyncBundle(deep)).toThrow('过深');

        // Format/version/section schema errors
        expect(() => validateLearningSyncBundle(null)).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: 'wrong', version: 1})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: 'bad'})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: ['bad']}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({kind: 'bad' as 'sentence'})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({note: 'x'.repeat(2001)})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({translations: null as never})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({translations: {'zh-CN': null as never}})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({contexts: 'bad' as never})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({contexts: [null as never]})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({masteryLevel: 9 as 0})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({status: 'bad' as 'new'})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({schemaVersion: 2 as 1})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({createdAt: -1})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({reviewCount: 1.5})]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: true, entries: [vocabEntry({term: ''})]}})).toThrow(LearningSyncError);

        // Personal corrections strict schema validation errors (UUID v4, material ID, language, uniqueness, 4 MiB)
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: null})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 0, entries: 'bad', projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 0, entries: [], projects: [null], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 0, entries: [], projects: [{id: 'not-a-uuid', label: 'P'}], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 0, entries: [], projects: [{id: PROJ_1, label: 'P1'}, {id: PROJ_1, label: 'P2'}], memberships: []}})).toThrow('项目标识重复');
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [null], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({scope: {kind: 'bad' as 'material', id: MAT_ID_1, label: 'x'}})], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({scope: {kind: 'material', id: 'bad-mat', label: 'x'}})], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({sourceLanguage: 'bad lang!'})], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({id: UUID_1}), correctionEntry({id: UUID_1, source: 'other'})], projects: [], memberships: []}})).toThrow('记录标识重复');
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({scope: {kind: 'project', id: PROJ_1, label: 'x'}})], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry({revision: 5})], projects: [], memberships: []}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [], projects: [], memberships: [null]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [], projects: [], memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}]}})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [], projects: [{id: PROJ_1, label: 'P'}], memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}, {materialId: MAT_ID_1, projectId: PROJ_1}]}})).toThrow('归属材料重复');

        // Vocabulary translations cap & node-count budget
        const tooManyLangs = Object.fromEntries(Array.from({length: 65}, (_, i) => [`l${i}`, {text: 't', updatedAt: 1}]));
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, vocabulary: {includesContext: false, entries: [vocabEntry({translations: tooManyLangs})]}})).toThrow('译文语言数量超出上限');
        const hugeNodes = {format: LEARNING_SYNC_FORMAT, version: 1, extra: Array.from({length: 50_005}, () => ({}))};
        expect(() => validateLearningSyncBundle(hugeNodes)).toThrow('节点过多');

        // Reading materials validation errors (including page < 1 & long URL / 256-char fingerprint acceptance)
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: 'bad'})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [null]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({kind: 'bad' as 'article'})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({source: {kind: 'video'}})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({locator: {kind: 'bad' as 'text'}})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({locator: {kind: 'document', page: 0}})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({topics: 'bad' as never})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({notes: 'bad' as never})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({notes: [null as never]})]})).toThrow(LearningSyncError);
        expect(() => validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [readingMaterial({aliases: 'bad' as never})]})).toThrow(LearningSyncError);
        const longUrlMat = readingMaterial({
            source: {kind: 'article', url: `https://example.test/${'a'.repeat(5_000)}`, fingerprint: 'f'.repeat(256)},
            locator: {kind: 'document', page: 1, fingerprint: 'f'.repeat(256)},
        });
        expect(validateLearningSyncBundle({format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: [longUrlMat]}).readingMaterials?.[0]?.source.fingerprint).toHaveLength(256);

        // 4 MiB personal corrections cap
        const hugeCorrections = Array.from({length: 250}, (_, index) => correctionEntry({
            id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
            source: 'a'.repeat(10_000),
            translation: 'b'.repeat(10_000),
        }));
        expect(() => validateLearningSyncBundle({
            format: LEARNING_SYNC_FORMAT,
            version: 1,
            personalCorrections: {version: 1, revision: 1, entries: hugeCorrections, projects: [], memberships: []},
        })).toThrow('4 MiB');

        // 12 MiB total bundle byte bound enforcement (using reading materials)
        const hugeMaterials = Array.from({length: 1_200}, (_, index) => readingMaterial({
            id: `mat-${index}`,
            identityKey: `article:https://example.test/${index}`,
            notes: [{id: `n-${index}`, note: 'x'.repeat(11_500)}],
        }));
        expect(JSON.stringify(hugeMaterials).length).toBeGreaterThan(LEARNING_SYNC_MAX_BYTES);
        expect(() => validateLearningSyncBundle({
            format: LEARNING_SYNC_FORMAT,
            version: 1,
            readingMaterials: hugeMaterials,
        })).toThrow('12 MiB');
    });

    it('deterministically merges vocabulary entries without losing reviews, edits, or context privacy', () => {
        const local = {
            includesContext: false,
            entries: [
                vocabEntry({
                    identityKey: 'en\u0000shared',
                    term: 'shared',
                    normalizedTerm: 'shared',
                    translations: {'zh-CN': {text: '本地旧译', updatedAt: 100}, ja: {text: 'ローカル', updatedAt: 150}},
                    note: 'local note',
                    noteUpdatedAt: 200,
                    masteryLevel: 2,
                    reviewCount: 2,
                    lastReviewedAt: 150,
                    updatedAt: 200,
                }),
                vocabEntry({id: UUID_2, identityKey: 'en\u0000local-only', term: 'local-only', normalizedTerm: 'local-only', createdAt: 50}),
            ],
        };
        const remote = {
            includesContext: true,
            entries: [
                vocabEntry({
                    id: UUID_2,
                    identityKey: 'en\u0000shared',
                    term: 'Shared',
                    normalizedTerm: 'shared',
                    kind: 'expression',
                    translations: {'zh-CN': {text: '云端新译', updatedAt: 250}},
                    note: 'older remote note',
                    noteUpdatedAt: 120,
                    masteryLevel: 4,
                    status: 'familiar',
                    nextReviewAt: 900,
                    reviewCount: 4,
                    lastReviewedAt: 300,
                    updatedAt: 300,
                    contexts: [{capturedAt: 300, text: 'Private sentence', sourceUrl: 'https://private.invalid/a'}],
                }),
                vocabEntry({id: PROJ_1, identityKey: 'en\u0000remote-only', term: 'remote-only', normalizedTerm: 'remote-only', createdAt: 60}),
            ],
        };

        // Without local context: strips local text & sourceUrl while preserving existing remote cloud contexts, newer review, newer note, and newer per-lang translation!
        const stripped = mergeLearningVocabulary(local, remote, false);
        expect(stripped.diff).toEqual({
            localCount: 2,
            remoteCount: 2,
            addedFromRemote: 1,
            updatedFromRemote: 1,
            addedToRemote: 1,
            updatedToRemote: 1,
            hasChanges: true,
        });
        const shared = stripped.merged.entries.find(e => e.identityKey === 'en\u0000shared')!;
        expect(shared.masteryLevel).toBe(4);
        expect(shared.reviewCount).toBe(4);
        expect(shared.note).toBe('local note');
        expect(shared.translations['zh-CN'].text).toBe('云端新译');
        expect(shared.translations.ja.text).toBe('ローカル');
        // Local-only entry never leaks text/sourceUrl; remote cloud context is preserved in cloud merge bundle
        const localOnly = stripped.merged.entries.find(e => e.identityKey === 'en\u0000local-only')!;
        expect(localOnly.contexts.every(ctx => ctx.text === undefined && ctx.sourceUrl === undefined)).toBe(true);
        expect(shared.contexts.some(ctx => ctx.text === 'Private sentence')).toBe(true);
        expect(shared.contexts.some(ctx => ctx.text === 'A moment of serendipity.')).toBe(false);

        // Merged vocabulary exceeding 5,000 entries throws explicitly instead of dropping words
        const halfA = Array.from({length: 2_600}, (_, i) => vocabEntry({id: UUID_1, identityKey: `en\u0000a${i}`, term: `a${i}`, normalizedTerm: `a${i}`}));
        const halfB = Array.from({length: 2_600}, (_, i) => vocabEntry({id: UUID_2, identityKey: `en\u0000b${i}`, term: `b${i}`, normalizedTerm: `b${i}`}));
        expect(() => mergeLearningVocabulary({includesContext: false, entries: halfA}, {includesContext: false, entries: halfB}, false)).toThrow('5000');

        // With context enabled: preserves deduplicated contexts
        const withCtx = mergeLearningVocabulary(local, remote, true);
        const sharedCtx = withCtx.merged.entries.find(e => e.identityKey === 'en\u0000shared')!;
        expect(sharedCtx.contexts.some(ctx => ctx.text === 'Private sentence')).toBe(true);

        // Remote note newer & equal lastReviewedAt tie-breakers, plus local-winning, identical, and blank phonetic/partOfSpeech/note cases
        const tieLocal = {includesContext: true, entries: [vocabEntry({note: 'old', noteUpdatedAt: 10, lastReviewedAt: null, reviewCount: 1, updatedAt: 10, phonetic: '', partOfSpeech: ''})]};
        const tieRemote = {includesContext: true, entries: [vocabEntry({note: 'new', noteUpdatedAt: 50, lastReviewedAt: null, reviewCount: 1, updatedAt: 20, phonetic: '/p/', partOfSpeech: 'v.'})]};
        const tieMerged = mergeLearningVocabulary(tieLocal, tieRemote, true).merged.entries[0]!;
        expect(tieMerged.note).toBe('new');
        expect(tieMerged.phonetic).toBe('/p/');

        const identicalVocab = mergeLearningVocabulary({includesContext: false, entries: [vocabEntry({phonetic: '', partOfSpeech: ''})]}, {includesContext: false, entries: [vocabEntry({phonetic: '', partOfSpeech: ''})]}, false);
        expect(identicalVocab.diff.hasChanges).toBe(false);

        const localWinsVocab = mergeLearningVocabulary(
            {includesContext: true, entries: [vocabEntry({
                noteUpdatedAt: 300,
                note: undefined,
                lastReviewedAt: 500,
                updatedAt: 500,
                phonetic: '',
                partOfSpeech: '',
                translations: {'zh-CN': {text: '本地最新译', updatedAt: 500}},
                contexts: [{capturedAt: 500, text: 'Same sentence', sourceUrl: 'https://example.test/same'}],
            })]},
            {includesContext: true, entries: [vocabEntry({
                lastReviewedAt: 100,
                updatedAt: 100,
                phonetic: '/r/',
                partOfSpeech: 'adj.',
                translations: {'zh-CN': {text: '云端较旧译', updatedAt: 100}},
                contexts: [
                    {capturedAt: 100, text: 'Same sentence', sourceUrl: 'https://example.test/same'},
                    {capturedAt: 120, text: 'Text only'},
                    {capturedAt: 130, sourceUrl: 'https://example.test/url-only'},
                ],
            })]},
            true,
        );
        expect(localWinsVocab.merged.entries[0]).toMatchObject({note: '', phonetic: '/r/', partOfSpeech: 'adj.'});
        expect(localWinsVocab.merged.entries[0]?.translations['zh-CN']?.text).toBe('本地最新译');
        expect(localWinsVocab.merged.entries[0]?.contexts).toHaveLength(3);
    });

    it('deterministically merges personal corrections and reading materials metadata', () => {
        const localCorr: LearningSyncPersonalCorrections = {
            version: 1,
            revision: 2,
            projects: [{id: PROJ_1, label: 'Project A'}],
            memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}],
            entries: [
                correctionEntry({translation: '局部旧译', revision: 1, updatedAt: 100}),
                correctionEntry({id: UUID_2, source: 'local-term', translation: '本地词', revision: 2, updatedAt: 200}),
            ],
        };
        const remoteCorr: LearningSyncPersonalCorrections = {
            version: 1,
            revision: 4,
            projects: [{id: PROJ_1, label: 'Project A'}, {id: PROJ_2, label: 'Project B'}],
            memberships: [{materialId: MAT_ID_1, projectId: PROJ_2}, {materialId: MAT_ID_2, projectId: PROJ_2}],
            entries: [
                correctionEntry({translation: '云端新译', revision: 3, updatedAt: 300}),
                correctionEntry({id: PROJ_1, scope: {kind: 'project', id: PROJ_2, label: 'Project B'}, source: 'remote-term', translation: '远端词', revision: 4}),
                // Orphan project ref should be skipped safely if project missing
                correctionEntry({id: PROJ_2, scope: {kind: 'project', id: '99999999-9999-4999-8999-999999999999', label: 'Ghost'}, source: 'ghost', translation: '幽灵', revision: 1}),
            ],
        };
        const corrMerged = mergeLearningPersonalCorrections(localCorr, remoteCorr);
        expect(corrMerged.diff.addedFromRemote).toBe(1);
        expect(corrMerged.diff.updatedFromRemote).toBe(1);
        expect(corrMerged.diff.addedToRemote).toBe(1);
        expect(corrMerged.merged.revision).toBe(4);
        expect(corrMerged.merged.entries.find(e => e.source === 'transformer')?.translation).toBe('云端新译');
        expect(corrMerged.merged.projects).toHaveLength(2);
        expect(corrMerged.merged.memberships.find(m => m.materialId === MAT_ID_1)?.projectId).toBe(PROJ_2);

        // Local winning by revision when updatedAt absent, equal tie, orphan membership, project/membership-only changes, and undefined local
        const revWin = mergeLearningPersonalCorrections(
            {version: 1, revision: 5, projects: [], memberships: [], entries: [correctionEntry({revision: 5, translation: 'local-rev5'})]},
            {version: 1, revision: 2, projects: [], memberships: [{materialId: MAT_ID_1, projectId: PROJ_2}], entries: [correctionEntry({revision: 2, translation: 'remote-rev2'})]},
        );
        expect(revWin.merged.entries[0]?.translation).toBe('local-rev5');
        expect(revWin.diff.updatedToRemote).toBe(1);
        expect(revWin.merged.memberships).toEqual([]);

        const equalCorr = mergeLearningPersonalCorrections(
            {version: 1, revision: 2, projects: [{id: PROJ_1, label: 'P1'}], memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}, {materialId: MAT_ID_2, projectId: PROJ_2}], entries: [correctionEntry()]},
            {version: 1, revision: 1, projects: [{id: PROJ_1, label: 'P1'}], memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}], entries: [correctionEntry()]},
        );
        expect(equalCorr.merged.memberships).toEqual([{materialId: MAT_ID_1, projectId: PROJ_1}]);
        const trulyIdenticalCorr = mergeLearningPersonalCorrections(
            {version: 1, revision: 1, projects: [], memberships: [], entries: [correctionEntry()]},
            {version: 1, revision: 1, projects: [], memberships: [], entries: [correctionEntry()]},
        );
        expect(trulyIdenticalCorr.diff.hasChanges).toBe(false);

        const projectOnlyChange = mergeLearningPersonalCorrections(
            {version: 1, revision: 1, projects: [], memberships: [], entries: []},
            {version: 1, revision: 1, projects: [{id: PROJ_1, label: 'P1'}], memberships: [], entries: []},
        );
        expect(projectOnlyChange.diff.hasChanges).toBe(true);

        const membershipOnlyChange = mergeLearningPersonalCorrections(
            {version: 1, revision: 1, projects: [{id: PROJ_1, label: 'P1'}], memberships: [], entries: []},
            {version: 1, revision: 1, projects: [{id: PROJ_1, label: 'P1'}], memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}], entries: []},
        );
        expect(membershipOnlyChange.diff.hasChanges).toBe(true);
        expect(mergeLearningPersonalCorrections(undefined, localCorr).diff.addedFromRemote).toBe(2);

        // Reading materials merge preserves furthest locator, merges notes & topics, respects newer title/archive
        const matLocal = [
            readingMaterial({title: 'Old Title', topics: ['ai'], locator: {kind: 'text', quote: 'p1'}, lastReadAt: 100, updatedAt: 100, notes: [{id: 'n1', note: 'local-n1', updatedAt: 150}]}),
            readingMaterial({id: 'mat-local', identityKey: 'article:https://local.test/1', title: 'Local Only'}),
        ];
        const matRemote = [
            readingMaterial({id: 'mat-remote-id', title: 'New Title', aliases: ['article:https://old.test/paper'], topics: ['ml'], locator: {kind: 'text', quote: 'p9'}, lastReadAt: 400, updatedAt: 400, archivedAt: 400, notes: [{id: 'n1', note: 'older-n1', updatedAt: 100}, {id: 'n2', note: 'remote-n2', createdAt: 200}]}),
            readingMaterial({id: 'mat-r2', identityKey: 'article:https://remote.test/2', title: 'Remote Only', lastReadAt: 500}),
        ];
        const matMerged = mergeLearningReadingMaterials(matLocal, matRemote);
        expect(matMerged.diff).toMatchObject({addedFromRemote: 1, updatedFromRemote: 1, addedToRemote: 1, hasChanges: true});
        const mergedPaper = matMerged.merged.find(m => m.identityKey === 'article:https://example.test/paper')!;
        expect(mergedPaper.title).toBe('New Title');
        expect(mergedPaper.locator?.quote).toBe('p9');
        expect(mergedPaper.topics).toEqual(['ai', 'ml']);
        expect(mergedPaper.archivedAt).toBe(400);
        expect(mergedPaper.notes).toHaveLength(2);
        expect(mergedPaper.notes.find(n => n.id === 'n1')?.note).toBe('local-n1');

        // Material edge cases: local newer, missing locator fallbacks, timeless notes, equal lastReadAt sort tie-breaker, identical, undefined local
        const matLocalNewer = mergeLearningReadingMaterials(
            [
                readingMaterial({id: 'm-a', identityKey: 'article:https://tie.test/b', title: 'Local Newer', updatedAt: 500, lastReadAt: 500, locator: undefined, notes: [{id: 'n-t'}]}),
                readingMaterial({id: 'm-c', identityKey: 'article:https://tie.test/a', title: 'Tie A', updatedAt: 500, lastReadAt: 500, locator: undefined, notes: []}),
            ],
            [
                readingMaterial({id: 'm-b', identityKey: 'article:https://tie.test/b', title: 'Remote Older', updatedAt: 100, lastReadAt: 100, locator: {kind: 'text', quote: 'remote-fallback'}, notes: [{id: 'n-t', note: 'updated'}]}),
                readingMaterial({id: 'm-d', identityKey: 'article:https://tie.test/a', title: 'Tie A', updatedAt: 500, lastReadAt: 500, locator: undefined, notes: []}),
            ],
        );
        expect(matLocalNewer.merged[0]?.identityKey).toBe('article:https://tie.test/a');
        expect(matLocalNewer.merged[1]?.locator?.quote).toBe('remote-fallback');
        expect(mergeLearningReadingMaterials([readingMaterial({locator: undefined})], [readingMaterial({locator: undefined})]).diff.hasChanges).toBe(false);
        expect(mergeLearningReadingMaterials(undefined, matRemote).diff.addedFromRemote).toBe(2);

        // buildLearningSyncDiff preserves untouched remote sections when toggles are disabled, handles null remote, and checks per-category hasAnyChanges
        const remoteBundle: LearningSyncBundle = {
            format: LEARNING_SYNC_FORMAT,
            version: LEARNING_SYNC_VERSION,
            vocabulary: {includesContext: false, entries: [vocabEntry()]},
            personalCorrections: localCorr,
            readingMaterials: matRemote,
        };
        const partial = buildLearningSyncDiff(
            {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false},
            null,
            remoteBundle,
        );
        expect(partial.summary.vocabulary.enabled).toBe(true);
        expect(partial.summary.personalCorrections.enabled).toBe(false);
        expect(partial.summary.readingMaterials.enabled).toBe(false);
        expect(partial.merged.personalCorrections).toEqual(localCorr);
        expect(partial.merged.readingMaterials).toEqual(matRemote);

        const disabledAllWithRemote = buildLearningSyncDiff(DEFAULT_LEARNING_SYNC_SCOPE, null, remoteBundle);
        expect(disabledAllWithRemote.summary.hasAnyChanges).toBe(false);
        expect(disabledAllWithRemote.merged.vocabulary).toEqual(remoteBundle.vocabulary);

        const disabledAllNoRemote = buildLearningSyncDiff(DEFAULT_LEARNING_SYNC_SCOPE, null, null);
        expect(disabledAllNoRemote.summary.hasAnyChanges).toBe(false);
        expect(disabledAllNoRemote.summary.vocabulary.remoteCount).toBe(0);

        const corrOnlyDiff = buildLearningSyncDiff(
            {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: false},
            null,
            {format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: localCorr},
        );
        expect(corrOnlyDiff.summary.hasAnyChanges).toBe(true);

        const matOnlyDiff = buildLearningSyncDiff(
            {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: true},
            null,
            {format: LEARNING_SYNC_FORMAT, version: 1, readingMaterials: matRemote},
        );
        expect(matOnlyDiff.summary.hasAnyChanges).toBe(true);
    });

    it('embeds optional learning bundle in driveSyncPayload without affecting config-only snapshots', () => {
        const cfg = sampleConfig();
        const plain = driveSyncPayload(cfg, false) as Record<string, unknown>;
        expect(plain).not.toHaveProperty('learning');
        expect(parseDriveSyncSnapshot(plain).learning).toBeUndefined();

        const bundle: LearningSyncBundle = {
            format: LEARNING_SYNC_FORMAT,
            version: LEARNING_SYNC_VERSION,
            readingMaterials: [readingMaterial()],
        };
        const withLearningV2 = driveSyncPayload(cfg, false, bundle);
        expect(parseDriveSyncSnapshot(withLearningV2)).toMatchObject({includesSensitive: false, learning: bundle});
        const withLearningV1 = driveSyncPayload(cfg, true, bundle);
        expect(parseDriveSyncSnapshot(withLearningV1)).toMatchObject({includesSensitive: true, learning: bundle});
    });

    it('integrates learning sync end-to-end across both Google Drive and WebDAV flows', async () => {
        // Device A has vocabulary + corrections + materials (including a non-note vocabulary reference that must be preserved on sync)
        const deviceALearning = createInMemoryLearningPorts({
            vocabulary: {
                format: 'fluentread-vocabulary-book',
                version: 1,
                exportedAt: 100,
                includesPrivateContext: true,
                entries: [vocabEntry({term: 'ephemeral', normalizedTerm: 'ephemeral', identityKey: 'en\u0000ephemeral'})],
                reviewLogs: [],
            },
            corrections: {
                state: {version: 1, revision: 1, projects: [], memberships: [], entries: [correctionEntry()]},
                undo: [],
            },
            materials: {
                format: 'fluentread-learning-materials',
                version: 1,
                exportedAt: 100,
                materials: [{
                    id: 'mat-a',
                    identityKey: 'article:https://example.test/paper',
                    aliases: ['article:https://legacy.example.test/paper'],
                    kind: 'article',
                    title: 'Device A Paper',
                    source: {kind: 'article', url: 'https://example.test/paper', title: 'Device A Paper'},
                    locator: {kind: 'text', quote: 'Device A quote', documentReference: {kind: 'pdf', page: 1} as never},
                    topics: ['reading'],
                    references: [
                        {kind: 'vocabulary', id: UUID_1, excerpt: 'keep-me'},
                        {kind: 'note', id: 'note-a', note: 'note from A', createdAt: 100, updatedAt: 100},
                    ],
                    createdAt: 100,
                    updatedAt: 200,
                    lastReadAt: 200,
                    archivedAt: null,
                } as MaterialRecord, {
                    id: 'mat-no-loc',
                    identityKey: 'article:https://example.test/no-loc',
                    kind: 'article',
                    title: 'No Locator Paper',
                    source: {kind: 'article', url: 'https://example.test/no-loc'},
                    topics: [],
                    references: [],
                    createdAt: 100,
                    updatedAt: 150,
                    lastReadAt: 150,
                    archivedAt: null,
                }],
            },
        });
        const deviceBLearning = createInMemoryLearningPorts({
            vocabulary: {
                format: 'fluentread-vocabulary-book',
                version: 1,
                exportedAt: 100,
                includesPrivateContext: true,
                entries: [vocabEntry({id: UUID_2, term: 'ubiquitous', normalizedTerm: 'ubiquitous', identityKey: 'en\u0000ubiquitous'})],
                reviewLogs: [],
            },
            materials: {
                format: 'fluentread-learning-materials',
                version: 1,
                exportedAt: 100,
                materials: [{
                    id: 'mat-b',
                    identityKey: 'article:https://example.test/paper',
                    kind: 'article',
                    title: 'Device B Older Paper',
                    source: {kind: 'article', url: 'https://example.test/paper'},
                    topics: ['local-topic'],
                    references: [{kind: 'vocabulary', id: UUID_2, excerpt: 'keep-b-ref'}],
                    createdAt: 100,
                    updatedAt: 100,
                    lastReadAt: 100,
                    archivedAt: null,
                }],
            },
        });

        // Shared WebDAV remote between Device A and Device B
        const shared: {remote: CloudSyncRemote | null} = {remote: null};
        const makeWebDav = (learning: ReturnType<typeof createInMemoryLearningPorts>['service']) => {
            const records = new Map<string, unknown>();
            let local = sampleConfig();
            let state: unknown = null;
            const connections = createWebDavConnectionStore({
                getItem: async <T>(k: string) => (records.get(k) ?? null) as T | null,
                setItem: async (k, v) => {records.set(k, v);},
                removeItem: async k => {records.delete(k);},
            });
            const ports: WebDavBackupPorts = {
                connections,
                api: {
                    test: vi.fn(async () => undefined),
                    read: vi.fn(async () => shared.remote),
                    remove: vi.fn(async () => {shared.remote = null;}),
                    write: vi.fn(async (_s, content) => {
                        shared.remote = {file: {id: 'f1', version: crypto.randomUUID(), modifiedTime: ''}, content};
                        return shared.remote.file;
                    }),
                },
                snapshot: vi.fn(async () => structuredClone(local)),
                apply: vi.fn(async v => {local = structuredClone(v);}),
                readState: vi.fn(async () => state),
                writeState: vi.fn(async v => {state = v;}),
                removeState: vi.fn(async () => {state = null;}),
                now: () => 1000,
                learning,
            };
            return createWebDavBackup(ports);
        };

        const davInput = {url: 'https://dav.example.test/base/', username: 'u', password: 'p', revision: null};
        const allScope = {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: true};
        const devA = makeWebDav(deviceALearning.service);
        await devA.save(davInput);
        const uploadPreview = await devA.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'a', false, {learningScope: allScope});
        expect(uploadPreview.learningSummary).toMatchObject({
            vocabulary: {enabled: true, localCount: 1, remoteCount: 0, addedToRemote: 1},
            personalCorrections: {enabled: true, localCount: 1, remoteCount: 0},
            readingMaterials: {enabled: true, localCount: 2, remoteCount: 0},
        });
        await devA.commit(uploadPreview.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, 1, 'a');

        // Verify cloud payload excluded private vocabulary contexts & non-note references
        const cloudPayload = await decryptDriveConfig(shared.remote!.content, GOOGLE_DRIVE_APPLICATION_PASSPHRASE) as {learning: LearningSyncBundle};
        expect(cloudPayload.learning.vocabulary?.entries[0]?.contexts[0]).toEqual({capturedAt: 100});
        expect(cloudPayload.learning.readingMaterials?.[0]?.notes).toHaveLength(1);

        // Device B merges with Device A's cloud backup -> gets both words, correction, and preserves Device B's non-note material ref!
        const devB = makeWebDav(deviceBLearning.service);
        await devB.save(davInput);
        const mergePreview = await devB.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 2, 'b', false, {learningScope: allScope});
        expect(mergePreview.learningSummary?.vocabulary).toMatchObject({localCount: 1, remoteCount: 1, addedFromRemote: 1, addedToRemote: 1});
        expect(initialDriveDirection(mergePreview)).toBe('');
        await devB.commit(mergePreview.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'merge', {}, 2, 'b');

        expect(deviceBLearning.vocab.entries.map(e => e.term).sort()).toEqual(['ephemeral', 'ubiquitous']);
        expect(deviceBLearning.corrections.state.entries).toHaveLength(1);
        const mergedMatB = deviceBLearning.materials.materials[0]!;
        expect(mergedMatB.title).toBe('Device A Paper');
        expect(mergedMatB.references.some(r => r.kind === 'vocabulary' && r.id === UUID_2)).toBe(true);
        expect(mergedMatB.references.some(r => r.kind === 'note' && r.id === 'note-a')).toBe(true);

        // Google Drive download path with MV3 restart + learning context enabled
        let driveLocal = sampleConfig();
        let driveState: unknown = null;
        const driveLearning = createInMemoryLearningPorts();
        const drivePorts: DriveSyncPorts = {
            auth: {
                availability: () => ({available: true, reason: ''}),
                open: vi.fn(async () => ({account: {id: 'g1', email: 'g@example.test'}, request: async <T>(op: (t: string) => Promise<T>) => op('tok')})),
                disconnect: vi.fn(async () => undefined),
            },
            api: {
                read: vi.fn(async () => shared.remote),
                remove: vi.fn(async () => undefined),
                write: vi.fn(async (_s, content) => ({id: 'gfile', version: '2', modifiedTime: '', content} as never)),
            },
            snapshot: vi.fn(async () => structuredClone(driveLocal)),
            apply: vi.fn(async v => {driveLocal = structuredClone(v);}),
            readState: vi.fn(async () => driveState),
            writeState: vi.fn(async v => {driveState = v;}),
            now: () => 2000,
            learning: driveLearning.service,
        };
        const driveSvc = createGoogleDriveSync(drivePorts);
        const dlPreview = await driveSvc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 3, 'g', false, {
            learningScope: {includeVocabulary: true, includeVocabularyContext: true, includePersonalCorrections: true, includeReadingMaterials: true},
        });
        await createGoogleDriveSync(drivePorts).commit(dlPreview.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'download', {}, 3, 'g');
        expect(driveLearning.vocab.entries).toHaveLength(2);
        expect(driveLearning.corrections.state.entries).toHaveLength(1);
        expect(driveLearning.materials.materials).toHaveLength(2);

        // Config-only sync when learning port is wired preserves untouched remote learning bundle
        const configOnlyPreview = await devB.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 2, 'b', false);
        await devB.commit(configOnlyPreview.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, 2, 'b');

        // Direct service edge cases: empty scope capture, context-enabled capture, single-category capture/apply, empty upload, concurrent correction conflict
        expect(await driveLearning.service.captureLocal(DEFAULT_LEARNING_SYNC_SCOPE)).toBeNull();
        const withCtxBundle = await driveLearning.service.captureLocal({
            includeVocabulary: true,
            includeVocabularyContext: true,
            includePersonalCorrections: false,
            includeReadingMaterials: false,
        });
        expect(withCtxBundle?.vocabulary?.includesContext).toBe(true);
        expect(withCtxBundle?.personalCorrections).toBeUndefined();
        expect(withCtxBundle?.readingMaterials).toBeUndefined();

        const onlyCorrBundle = await driveLearning.service.captureLocal({
            includeVocabulary: false,
            includeVocabularyContext: false,
            includePersonalCorrections: true,
            includeReadingMaterials: false,
        });
        expect(onlyCorrBundle?.vocabulary).toBeUndefined();
        expect(onlyCorrBundle?.personalCorrections).toBeDefined();

        await driveLearning.service.applyLocal('upload', allScope, null, null);
        await driveLearning.service.applyLocal('download', allScope, null, null);
        await driveLearning.service.applyLocal('merge', allScope, null, null);
        await driveLearning.service.applyLocal(
            'download',
            {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: true},
            {format: LEARNING_SYNC_FORMAT, version: 1},
            null,
        );
        expect(driveLearning.service.selectCloudBundle('download', allScope, null, cloudPayload.learning, null)).toBe(cloudPayload.learning);
        expect(driveLearning.service.selectCloudBundle('merge', allScope, null, null, null)).toBeNull();
        expect(driveLearning.service.selectCloudBundle('upload', DEFAULT_LEARNING_SYNC_SCOPE, null, null, null)).toBeNull();
        const preservedUpload = driveLearning.service.selectCloudBundle(
            'upload',
            {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false},
            null,
            cloudPayload.learning,
            null,
        );
        expect(preservedUpload).toEqual(cloudPayload.learning);

        const conflictService = createLearningCloudSync({
            vocabulary: {exportData: vi.fn(), importData: vi.fn()},
            personalCorrections: {
                read: vi.fn(async () => ({value: {state: {version: 1 as const, revision: 0, entries: [], projects: [], memberships: []}, undo: []}, expected: null})),
                write: vi.fn(async () => false),
            },
            materials: {exportData: vi.fn(), importData: vi.fn()},
        });
        await expect(conflictService.applyLocal(
            'download',
            {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: false},
            {format: LEARNING_SYNC_FORMAT, version: 1, personalCorrections: {version: 1, revision: 1, entries: [correctionEntry()], projects: [], memberships: []}},
            null,
        )).rejects.toThrow(LearningSyncError);
    });

    it('persists authoritative merges in real Dexie MaterialRepository and real PersonalCorrectionRepository while preserving local locator metadata', async () => {
        const DOC_FP = 'a'.repeat(32);
        const db = new MaterialDatabase(`CloudLearningSyncReal-${crypto.randomUUID()}`);
        const materialRepo = new MaterialRepository(db);
        const backing = new Map<string, unknown>();
        const storagePort: ConfigStoragePort = {
            writeOwner: true,
            async getItem<T>(key: string) {return (backing.has(key) ? structuredClone(backing.get(key)) : null) as T | null;},
            async setItem(key: string, value: unknown) {backing.set(key, structuredClone(value));},
            async removeItem(key: string) {backing.delete(key);},
            watch() {return () => undefined;},
            async setItemIfUnchanged(key: string, expected: unknown, value: unknown) {
                const current = backing.has(key) ? backing.get(key) : null;
                if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
                backing.set(key, structuredClone(value));
                return true;
            },
        };
        const correctionRepo = new PersonalCorrectionRepository(storagePort);
        const vocabImported: VocabularyBookExport[] = [];
        let vocabSeed: VocabularyBookExport = {
            format: 'fluentread-vocabulary-book',
            version: 1,
            exportedAt: 100,
            includesPrivateContext: false,
            entries: [],
            reviewLogs: [],
        };
        const service = createLearningCloudSync({
            vocabulary: {
                exportData: vi.fn(async () => structuredClone(vocabSeed)),
                importData: vi.fn(async (data: unknown) => {vocabImported.push(data as VocabularyBookExport);}),
            },
            personalCorrections: correctionRepo,
            materials: materialRepo,
            now: () => 2_000,
        });

        try {
            // 1. Seed real Dexie MaterialRepository with newer local updatedAt (500), non-note ref, exact documentReference + prefix/suffix/paragraphId
            const docRef = {
                version: 1 as const,
                materialId: DOC_FP,
                locator: {version: 1 as const, source: 'Exact PDF sentence.', scope: 'p.3', position: 'line-1'},
            };
            await materialRepo.capture({
                source: {kind: 'document', title: 'Local PDF', fingerprint: DOC_FP},
                locator: {kind: 'document', page: 3, quote: 'Exact PDF sentence.', prefix: 'Before ', suffix: ' After', paragraphId: 'para-3', fingerprint: DOC_FP, documentReference: docRef},
                reference: {kind: 'vocabulary', id: UUID_1, excerpt: 'Exact PDF sentence.'},
                capturedAt: 500,
            }, 500);
            const seededDoc = (await materialRepo.exportData(500)).materials[0]!;
            await materialRepo.update(seededDoc.id, {topics: ['local-topic']}, 500);

            // Seed real PersonalCorrectionRepository with UUID_1, a project, and a membership
            const corrRead = await correctionRepo.read();
            await correctionRepo.write(corrRead.expected, {
                state: {
                    version: 1,
                    revision: 1,
                    projects: [{id: PROJ_1, label: 'Local Project'}],
                    memberships: [{materialId: MAT_ID_1, projectId: PROJ_1}],
                    entries: [correctionEntry({id: UUID_1, source: 'alpha', translation: '阿尔法'})],
                },
                undo: [],
            });

            // 2. Remote has older updatedAt (300) on same document WITHOUT source.fingerprint, plus a remote note & topic, AND a colliding UUID_1 correction!
            const remoteBundle: LearningSyncBundle = {
                format: LEARNING_SYNC_FORMAT,
                version: 1,
                vocabulary: {
                    includesContext: true,
                    entries: [vocabEntry({contexts: [{capturedAt: 300, text: 'Secret Page Sentence', sourceUrl: 'https://secret.invalid/doc', pageTitle: 'Secret'}]})],
                },
                personalCorrections: {
                    version: 1,
                    revision: 2,
                    projects: [{id: PROJ_2, label: 'Remote Project'}],
                    memberships: [{materialId: MAT_ID_2, projectId: PROJ_2}],
                    entries: [correctionEntry({id: UUID_1, source: 'beta', translation: '贝塔', revision: 2})],
                },
                readingMaterials: [{
                    id: 'remote-doc-id',
                    identityKey: seededDoc.identityKey,
                    kind: 'document',
                    title: 'Remote Older Title',
                    source: {kind: 'document', title: 'Remote Older Title'},
                    locator: {kind: 'document', page: 3, quote: 'Exact PDF sentence.'},
                    topics: ['remote-topic'],
                    notes: [{id: 'remote-note-1', note: 'Merged from remote', createdAt: 300, updatedAt: 300}],
                    createdAt: 200,
                    updatedAt: 300,
                    lastReadAt: 300,
                    archivedAt: null,
                }],
            };

            const scope = {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: true};
            const localBundle = await service.captureLocal(scope);
            const {merged} = service.preview(scope, localBundle, remoteBundle);
            await service.validateApply('merge', scope, remoteBundle, merged);
            await service.applyLocal('merge', scope, remoteBundle, merged);

            // Verify Fix 1 & Fix 2: Real Dexie MaterialRepository did NOT skip update despite local.updatedAt (500) >= remote.updatedAt (300),
            // AND preserved non-note vocabulary reference, source.fingerprint, documentReference, prefix, suffix, paragraphId!
            const afterMaterials = (await materialRepo.exportData(2_000)).materials;
            expect(afterMaterials).toHaveLength(1);
            const savedDoc = afterMaterials[0]!;
            expect(savedDoc.topics).toEqual(['local-topic', 'remote-topic']);
            expect(savedDoc.references.some(r => r.kind === 'note' && r.id === 'remote-note-1')).toBe(true);
            expect(savedDoc.references.some(r => r.kind === 'vocabulary' && r.id === UUID_1)).toBe(true);
            expect(savedDoc.source.fingerprint).toBe(DOC_FP);
            expect(savedDoc.locator).toMatchObject({
                kind: 'document',
                page: 3,
                quote: 'Exact PDF sentence.',
                prefix: 'Before',
                suffix: 'After',
                paragraphId: 'para-3',
                fingerprint: DOC_FP,
                documentReference: docRef,
            });

            // Verify Fix 3: Real PersonalCorrectionRepository persisted BOTH distinct entries with resolved unique UUID v4s!
            const afterCorr = (await correctionRepo.read()).value.state;
            expect(afterCorr.entries).toHaveLength(2);
            expect(new Set(afterCorr.entries.map(e => e.id)).size).toBe(2);
            expect(afterCorr.entries.map(e => e.source).sort()).toEqual(['alpha', 'beta']);

            // Verify incompatible locator (different quote/page) drops stale text anchors & documentReference safely
            await service.applyLocal('download', scope, {
                format: LEARNING_SYNC_FORMAT,
                version: 1,
                readingMaterials: [{
                    ...remoteBundle.readingMaterials![0]!,
                    locator: {kind: 'document', page: 9, quote: 'Different PDF sentence.'},
                }],
            }, null);
            const movedDoc = (await materialRepo.exportData(2_000)).materials[0]!;
            expect(movedDoc.locator?.page).toBe(9);
            expect(movedDoc.locator?.prefix).toBeUndefined();
            expect(movedDoc.locator?.documentReference).toBeUndefined();

            // Verify Fix 7: Download with includeVocabularyContext: false stripped private contexts before importing locally!
            await service.applyLocal('download', scope, remoteBundle, null);
            expect(vocabImported.every(imp => !imp.includesPrivateContext && imp.entries[0]?.contexts.every(c => c.text === undefined && c.sourceUrl === undefined && c.pageTitle === undefined))).toBe(true);
            // Also cover includeVocabularyContext: true branch in applyLocal
            await service.applyLocal('download', {...scope, includeVocabularyContext: true}, remoteBundle, null);
            expect(vocabImported.at(-1)?.entries[0]?.contexts[0]?.text).toBe('Secret Page Sentence');

            // Verify validateApply rejects over-capacity vocab, corrections (>1000 / >4MiB), and materials (>10000) BEFORE any write!
            await service.validateApply('upload', scope, remoteBundle, merged);
            await service.validateApply('download', scope, null, null);
            await service.validateApply('download', scope, {format: LEARNING_SYNC_FORMAT, version: 1}, null);
            vocabSeed = {...vocabSeed, entries: Array.from({length: LEARNING_SYNC_MAX_VOCABULARY + 1}, (_, i) => vocabEntry({id: UUID_1, identityKey: `en\u0000cap${i}`, term: `cap${i}`, normalizedTerm: `cap${i}`}))};
            await expect(service.captureLocal({includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false})).rejects.toThrow('5000');
            await expect(service.validateApply('download', {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false}, remoteBundle, null)).rejects.toThrow('5000');
            vocabSeed = {...vocabSeed, entries: []};

            // Over-limit corrections (>4 MiB) & (>1000 entries/projects)
            const bigCorrBundle: LearningSyncBundle = {
                format: LEARNING_SYNC_FORMAT,
                version: 1,
                personalCorrections: {
                    version: 1,
                    revision: 2,
                    projects: Array.from({length: 101}, (_, i) => ({id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, label: `P${i}`})),
                    memberships: [],
                    entries: [],
                },
            };
            await expect(service.validateApply('download', {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: false}, bigCorrBundle, null)).rejects.toThrow('超出条目上限');
            const fourMbCorr: LearningSyncBundle = {
                format: LEARNING_SYNC_FORMAT,
                version: 1,
                personalCorrections: {
                    version: 1,
                    revision: 2,
                    projects: [],
                    memberships: [],
                    entries: Array.from({length: 230}, (_, i) => correctionEntry({
                        id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
                        source: 's'.repeat(10_000),
                        translation: 't'.repeat(10_000),
                    })),
                },
            };
            await expect(service.validateApply('download', {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: true, includeReadingMaterials: false}, fourMbCorr, null)).rejects.toThrow('4 MiB');

            // Over-limit materials (>10,000) & captureLocal sorting/clamping of invalid page/endMs
            const manyMaterialsPort = createLearningCloudSync({
                vocabulary: {exportData: vi.fn(), importData: vi.fn()},
                personalCorrections: correctionRepo,
                materials: {
                    exportData: vi.fn(async () => ({
                        format: 'fluentread-learning-materials' as const,
                        version: 1 as const,
                        exportedAt: 100,
                        materials: Array.from({length: 10_001}, (_, i) => ({
                            id: `m-${i}`,
                            identityKey: `article:https://example.test/m/${i}`,
                            kind: 'article' as const,
                            title: `M${i}`,
                            source: {kind: 'article' as const, url: `https://example.test/m/${i}`},
                            locator: i === 10_000
                                ? {kind: 'video' as const, page: 0, startMs: 100, endMs: 50}
                                : i === 9_999
                                    ? {kind: 'document' as const, page: 2, startMs: 10, endMs: 50}
                                    : i === 9_998
                                        ? {kind: 'video' as const, endMs: 50}
                                        : undefined,
                            topics: [],
                            references: [],
                            createdAt: 100,
                            updatedAt: 100,
                            lastReadAt: i >= 9_998 ? 10_000 : i,
                            archivedAt: null,
                        })),
                    })),
                    importData: vi.fn(),
                },
            });
            await expect(manyMaterialsPort.validateApply('download', {includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: true}, remoteBundle, null)).rejects.toThrow('超出上限');
            const clamped = await manyMaterialsPort.captureLocal({includeVocabulary: false, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: true});
            expect(clamped?.readingMaterials).toHaveLength(LEARNING_SYNC_MAX_MATERIALS);
            expect(clamped?.readingMaterials?.[0]?.lastReadAt).toBe(10_000);
        } finally {
            db.close();
            await db.delete();
        }
    });

    it('detects stale local learning data before commit and rolls back local config when learning applyLocal fails', async () => {
        let localCfg = sampleConfig({to: 'ja'});
        let remote: CloudSyncRemote | null = null;
        let state: unknown = null;
        const localLearning = createInMemoryLearningPorts({
            vocabulary: {
                format: 'fluentread-vocabulary-book',
                version: 1,
                exportedAt: 100,
                includesPrivateContext: false,
                entries: [vocabEntry({term: 'initial', normalizedTerm: 'initial', identityKey: 'en\u0000initial'})],
                reviewLogs: [],
            },
        });
        const makePorts = (learningSvc: ReturnType<typeof createLearningCloudSync>): DriveSyncPorts => ({
            auth: {
                availability: () => ({available: true, reason: ''}),
                open: vi.fn(async () => ({account: {id: 'g-stale', email: 'stale@example.test'}, request: async <T>(op: (t: string) => Promise<T>) => op('tok')})),
                disconnect: vi.fn(async () => undefined),
            },
            api: {
                read: vi.fn(async () => remote),
                remove: vi.fn(async () => {remote = null;}),
                write: vi.fn(async (_s, content) => {
                    const file = {id: 'f-stale', version: String(Number(remote?.file.version ?? 0) + 1), modifiedTime: ''};
                    remote = {file, content};
                    return file;
                }),
            },
            snapshot: vi.fn(async () => structuredClone(localCfg)),
            apply: vi.fn(async v => {localCfg = structuredClone(v);}),
            readState: vi.fn(async () => state),
            writeState: vi.fn(async v => {state = v;}),
            now: () => 5_000,
            learning: learningSvc,
        });

        const vocabScope = {includeVocabulary: true, includeVocabularyContext: false, includePersonalCorrections: false, includeReadingMaterials: false};
        const ports = makePorts(localLearning.service);
        const svc = createGoogleDriveSync(ports);

        // 1. Local learning mutates between prepare and commit -> commit rejects cleanly before api.write!
        const p1 = await svc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'c1', false, {learningScope: vocabScope});
        await localLearning.service.applyLocal('download', vocabScope, {
            format: LEARNING_SYNC_FORMAT,
            version: 1,
            vocabulary: {includesContext: false, entries: [vocabEntry({id: UUID_2, term: 'added-later', normalizedTerm: 'added-later', identityKey: 'en\u0000added-later'})]},
        }, null);
        await expect(svc.commit(p1.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, 1, 'c1')).rejects.toThrow('本机学习数据已变化');
        expect(ports.api.write).not.toHaveBeenCalled();

        // 2. Seed remote with a different config ('fr') + vocab; fail applyLocal on download -> rolls back localCfg to 'ja'!
        const pUpload = await svc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'c1', false, {learningScope: vocabScope});
        await svc.commit(pUpload.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'upload', {}, 1, 'c1');
        localCfg = sampleConfig({to: 'fr'});
        const failingLearning: ReturnType<typeof createLearningCloudSync> = {
            ...localLearning.service,
            applyLocal: vi.fn(async () => {throw new LearningSyncError('disk full');}),
        };
        const rollbackPorts = makePorts(failingLearning);
        const rollbackSvc = createGoogleDriveSync(rollbackPorts);
        const p2 = await rollbackSvc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'c1', false, {learningScope: vocabScope});
        await expect(rollbackSvc.commit(p2.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'download', {}, 1, 'c1')).rejects.toThrow('disk full');
        expect(localCfg.to).toBe('fr');

        // 3. Double failure: applyLocal fails AND rollback apply fails -> surfaces clear recovery error!
        vi.mocked(rollbackPorts.apply)
            .mockImplementationOnce(async v => {localCfg = structuredClone(v);})
            .mockRejectedValueOnce(new Error('rollback failed'));
        const p3 = await rollbackSvc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'c1', false, {learningScope: vocabScope});
        await expect(rollbackSvc.commit(p3.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'download', {}, 1, 'c1')).rejects.toThrow('本机学习数据写入和配置恢复失败');

        // 4. Local config unchanged + applyLocal fails -> rethrows learning error without unnecessary rollback!
        localCfg = sampleConfig({to: 'ja'});
        const p4 = await rollbackSvc.prepare(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 1, 'c1', false, {learningScope: vocabScope});
        await expect(rollbackSvc.commit(p4.id, GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 'download', {}, 1, 'c1')).rejects.toThrow('disk full');
    });
});
