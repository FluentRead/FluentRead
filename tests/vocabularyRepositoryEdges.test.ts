import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  VOCABULARY_BOOK_EXPORT_FORMAT,
  VOCABULARY_BOOK_EXPORT_VERSION,
  VOCABULARY_BOOK_MAX_ENTRIES,
  FluentReadVocabularyBookDatabase,
  VocabularyBookRepository,
  buildVocabularyIdentityKey,
  mergeVocabularyContexts,
  normalizeVocabularyLanguage,
  sanitizeVocabularyContext,
  sanitizeVocabularySourceUrl,
  scheduleVocabularyReview,
  type VocabularyBookExport,
  type VocabularyEntry,
  type VocabularyReviewLog,
} from '@/src/features/vocabulary/repository';

const NOW = 2_000_000;
let databaseSequence = 0;
let db: FluentReadVocabularyBookDatabase;
let repository: VocabularyBookRepository;

beforeEach(() => {
  databaseSequence += 1;
  db = new FluentReadVocabularyBookDatabase(`FluentReadVocabularyRepositoryEdges-${databaseSequence}`);
  repository = new VocabularyBookRepository(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  await db.delete();
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    term: 'Common',
    translation: '常见',
    phonetic: '/ˈkɒmən/',
    partOfSpeech: 'adjective',
    ...overrides,
  };
}

function alphabeticIndex(value: number): string {
  let result = '';
  let remaining = value;
  do {
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return result;
}

function cloneEntry(entry: VocabularyEntry, overrides: Partial<VocabularyEntry>): VocabularyEntry {
  return {
    ...entry,
    translations: Object.fromEntries(
      Object.entries(entry.translations).map(([language, snapshot]) => [language, {...snapshot}]),
    ),
    contexts: entry.contexts.map((context) => ({...context})),
    ...overrides,
  };
}

it('preserves a newer translation snapshot when the imported entry has newer unrelated metadata',async()=>{
  const local=await repository.upsert(baseInput({translation:'newer local translation'}),NOW+100);
  const incoming=cloneEntry(local,{id:'60000000-0000-4000-8000-000000000001',updatedAt:NOW+200,phonetic:'newer metadata',translations:{'zh-cn':{text:'older imported translation',updatedAt:NOW}}});
  await repository.importData({format:VOCABULARY_BOOK_EXPORT_FORMAT,version:VOCABULARY_BOOK_EXPORT_VERSION,entries:[incoming],reviewLogs:[]},NOW+300);
  expect((await repository.get(local.id))?.translations['zh-cn'].text).toBe('newer local translation');
});
it('does not attach ambiguous imported review IDs to an already existing entry',async()=>{
  const local=await repository.upsert(baseInput(),NOW),id='60000000-0000-4000-8000-000000000002';
  const common=cloneEntry(local,{id}),other=cloneEntry(local,{id,term:'Different',normalizedTerm:'Different',identityKey:'ignored'});
  const result=await repository.importData({format:VOCABULARY_BOOK_EXPORT_FORMAT,version:VOCABULARY_BOOK_EXPORT_VERSION,entries:[common,other],reviewLogs:[]},NOW+100);
  expect(result.inserted).toBe(1);expect((await repository.get(local.id))?.term).toBe('Common');
});

function reviewLog(
  id: string,
  entryId: string,
  reviewedAt = NOW,
): VocabularyReviewLog {
  return {
    id,
    entryId,
    rating: 'again',
    reviewedAt,
    beforeLevel: 0,
    afterLevel: 0,
    nextReviewAt: reviewedAt,
  };
}

describe('large vocabulary import and bounded context selection', () => {
  it('imports a below-warning-size collection with 150000 contexts without overflowing the call stack', async () => {
    const original = await repository.upsert(baseInput(), NOW);
    const exported = await repository.exportData({includePrivateContext:true,now:NOW});
    exported.entries[0].contexts = Array.from({length:150_000},(_,i)=>({text:`Synthetic context ${i}.`,capturedAt:NOW+i}));
    const raw = JSON.stringify(exported); expect(Buffer.byteLength(raw)).toBeLessThan(20*1024*1024);
    await repository.clear();
    await expect(repository.importData(JSON.parse(raw),NOW)).resolves.toMatchObject({inserted:1,updated:0});
    const restored = await repository.get(original.id);
    expect(restored?.contexts.map(context=>context.text)).toEqual(Array.from({length:8},(_,i)=>`Synthetic context ${149_992+i}.`));
    expect(restored?.updatedAt).toBe(NOW+149_999);
  });
  it('retains stable timestamp ties, first-identity order and last equal-time snapshots without mutating inputs', () => {
    const contexts = Array.from({length:12},(_,i)=>Object.freeze({text:`Context ${i}.`,capturedAt:NOW,sourceUrl:`https://example.test/${i}`}));
    const replacement = Object.freeze({...contexts[5],pageTitle:'Updated snapshot'});
    const incoming = Object.freeze([replacement,Object.freeze({...contexts[1],capturedAt:NOW+1})]);
    const result = mergeVocabularyContexts(Object.freeze(contexts),incoming);
    expect(result.map(context=>context.text)).toEqual(['Context 5.','Context 6.','Context 7.','Context 8.','Context 9.','Context 10.','Context 11.','Context 1.']);
    expect(result[0].pageTitle).toBe('Updated snapshot'); expect(result[0]).not.toBe(replacement);
    result[0].text='Detached result';expect(replacement.text).toBe('Context 5.');
  });
  it('preserves the public merge helper ordering for uncleaned nonfinite timestamps', () => {
    const contexts = Array.from({length:12},(_,i)=>({text:`Raw context ${i}.`,capturedAt:i===5 ? Number.NaN : i===9 ? Infinity : i}));
    expect(mergeVocabularyContexts([],contexts)).toEqual([...contexts].sort((a,b)=>a.capturedAt-b.capturedAt).slice(-8));
  });
  it('does not perform a full-array sort to retain eight of 5000 sanitized contexts', () => {
    const contexts = Object.freeze(Array.from({length:5000},(_,i)=>Object.freeze({text:`Context ${i}.`,capturedAt:NOW+(i*2879+197)%5000})));
    const expected = [...contexts].sort((a,b)=>a.capturedAt-b.capturedAt).slice(-8);
    const sort = vi.spyOn(Array.prototype,'sort');
    expect(mergeVocabularyContexts([],contexts)).toEqual(expected);
    expect(sort).not.toHaveBeenCalled();sort.mockRestore();
  });
});

describe('vocabulary repository sanitizer edges', () => {
  it('accepts null-prototype records and rejects malformed context, language, and URL values', () => {
    const nullPrototypeContext = Object.assign(Object.create(null) as Record<string, unknown>, {
      text: ' Null prototype context ',
      capturedAt: -1,
    });

    expect(sanitizeVocabularyContext(nullPrototypeContext, NOW)).toEqual({
      text: 'Null prototype context',
      capturedAt: NOW,
    });
    expect(sanitizeVocabularyContext([], NOW)).toBeNull();
    expect(sanitizeVocabularyContext({text: '\u0000'}, NOW)).toBeNull();
    expect(normalizeVocabularyLanguage('invalid language!')).toBe('');
    expect(buildVocabularyIdentityKey('invalid!', 'common')).toBe('');
    expect(sanitizeVocabularySourceUrl(undefined)).toBeUndefined();
    expect(sanitizeVocabularySourceUrl('   ')).toBeUndefined();
    expect(sanitizeVocabularySourceUrl('not a url')).toBeUndefined();
    expect(sanitizeVocabularySourceUrl(`https://example.com/${'x'.repeat(2_100)}`)).toBeUndefined();

    const newer = {text: 'Same context', capturedAt: NOW};
    const older = {text: 'same context', capturedAt: NOW - 1};
    expect(mergeVocabularyContexts([newer], [older])).toEqual([newer]);
    expect(scheduleVocabularyReview(5, 'good', NOW)).toMatchObject({
      masteryLevel: 5,
      status: 'mastered',
    });
  });

  it('generates a standards-compliant fallback UUID and retries an import collision', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        return bytes;
      },
    });
    const fallbackEntry = await repository.upsert(baseInput(), NOW);
    expect(fallbackEntry.id).toBe('00000000-0000-4000-8000-000000000000');

    const exported = await repository.exportData({includePrivateContext: true, now: NOW + 1});
    const duplicateId = '00000000-0000-4000-8000-000000000000';
    const replacementId = '99999999-9999-4999-8999-999999999999';
    exported.entries.push(cloneEntry(fallbackEntry, {
      identityKey: 'ignored',
      term: 'Rare',
      normalizedTerm: 'ignored',
      translations: {'zh-cn': {text: '罕见', updatedAt: NOW + 1}},
    }));
    await repository.clear();

    const randomUUID = vi.fn()
      .mockReturnValueOnce(duplicateId)
      .mockReturnValueOnce(replacementId);
    vi.stubGlobal('crypto', {randomUUID});
    const result = await repository.importData(exported, NOW + 2);

    expect(result.inserted).toBe(2);
    await expect(repository.getByTerm('en', 'common')).resolves.toMatchObject({id: duplicateId});
    await expect(repository.getByTerm('en', 'rare')).resolves.toMatchObject({id: replacementId});
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});

describe('vocabulary repository validation and list branches', () => {
  it('rejects non-object writes, invalid ratings, and missing records without mutating storage', async () => {
    await expect(repository.upsert(null as never, NOW)).rejects.toMatchObject({
      code: 'invalid-input',
      name: 'VocabularyBookError',
    });
    await expect(repository.upsert(baseInput({sourceLanguage: 'bad!'}), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.upsert(baseInput({targetLanguage: 'bad!'}), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.upsert(baseInput({translation: null}), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.getByTerm('bad!', 'common')).resolves.toBeNull();
    await expect(repository.getByTerm('en', 'missing')).resolves.toBeNull();
    await expect(repository.review('missing', 'good', NOW)).rejects.toMatchObject({code: 'not-found'});
    await expect(repository.review('missing', 'perfect' as never, NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('filters each query dimension and exercises every stable list ordering branch', async () => {
    const template = await repository.upsert(baseInput(), NOW);
    await db.entries.clear();
    const entries = [
      cloneEntry(template, {
        id: '00000000-0000-4000-8000-000000000001',
        identityKey: 'en\u0000alpha',
        term: 'Alpha',
        normalizedTerm: 'alpha',
        status: 'mastered',
        masteryLevel: 5,
        nextReviewAt: null,
        lastSeenAt: NOW + 1,
      }),
      cloneEntry(template, {
        id: '00000000-0000-4000-8000-000000000002',
        identityKey: 'en\u0000rare',
        term: 'Rare',
        normalizedTerm: 'rare',
        translations: {
          'zh-cn': {text: '罕见', updatedAt: NOW},
          ja: {text: '珍しい', updatedAt: NOW},
        },
        status: 'learning',
        masteryLevel: 1,
        nextReviewAt: NOW + 100,
        lastSeenAt: NOW + 4,
      }),
      cloneEntry(template, {
        id: '00000000-0000-4000-8000-000000000003',
        identityKey: 'fr\u0000stable',
        sourceLanguage: 'fr',
        term: 'Stable',
        normalizedTerm: 'stable',
        status: 'new',
        nextReviewAt: NOW - 1,
        lastSeenAt: NOW + 3,
      }),
      cloneEntry(template, {
        id: '00000000-0000-4000-8000-000000000004',
        identityKey: 'en\u0000zebra',
        term: 'Zebra',
        normalizedTerm: 'zebra',
        status: 'mastered',
        masteryLevel: 5,
        nextReviewAt: null,
        lastSeenAt: NOW + 2,
      }),
    ];
    await db.entries.bulkAdd(entries);

    await expect(repository.list({status: 'learning'})).resolves.toHaveLength(1);
    await expect(repository.list({status: ['new', 'mastered']})).resolves.toHaveLength(3);
    await expect(repository.list({sourceLanguage: 'EN'})).resolves.toHaveLength(3);
    await expect(repository.list({targetLanguage: 'JA'})).resolves.toMatchObject([{term: 'Rare'}]);
    await expect(repository.list({dueOnly: true, now: NOW})).resolves.toMatchObject([{term: 'Stable'}]);
    await expect(repository.list({search: 'RARE'})).resolves.toMatchObject([{term: 'Rare'}]);
    await expect(repository.list({search: '珍しい'})).resolves.toMatchObject([{term: 'Rare'}]);
    await expect(repository.list({search: 'absent'})).resolves.toEqual([]);
    const termOrdered = await repository.list({order: 'term'});
    expect(termOrdered.map((entry) => entry.term)).toEqual(['Alpha', 'Rare', 'Stable', 'Zebra']);
    const recentOrdered = await repository.list({order: 'recent'});
    expect(recentOrdered[0]?.term).toBe('Rare');

    // 步骤 1：固定主键次序后逐次改变 due 值，确保 null/null、left-null、right-null 与数值比较都执行。
    await expect(repository.list({order: 'due'})).resolves.toHaveLength(4);
    await db.entries.update(entries[0]!.id, {nextReviewAt: NOW + 10});
    await expect(repository.list({order: 'due'})).resolves.toHaveLength(4);
    await db.entries.update(entries[0]!.id, {nextReviewAt: null});
    await db.entries.update(entries[1]!.id, {nextReviewAt: null});
    await expect(repository.list({order: 'due'})).resolves.toHaveLength(4);

    await expect(repository.list({offset: 1.5, limit: -1})).resolves.toHaveLength(1);
    await expect(repository.list({offset: -10, limit: Number.MAX_SAFE_INTEGER})).resolves.toHaveLength(4);
  });
});

describe('vocabulary repository log and export ordering', () => {
  it('uses IDs as deterministic tie-breakers for pruning, listing, removal, and export', async () => {
    const first = await repository.upsert(baseInput({term: 'Alpha'}), NOW);
    const second = await repository.upsert(baseInput({term: 'Beta'}), NOW);
    const logs = Array.from({length: 100}, (_, index) => reviewLog(
      `10000000-0000-4000-8000-${String(99 - index).padStart(12, '0')}`,
      first.id,
      NOW,
    ));
    await db.reviewLogs.bulkAdd(logs);

    await repository.review(first.id, 'again', NOW);
    const retained = await repository.getReviewLogs(first.id);
    expect(retained).toHaveLength(100);
    expect(retained.map((log) => log.id)).toEqual([...retained.map((log) => log.id)].sort());

    await db.reviewLogs.add(reviewLog('20000000-0000-4000-8000-000000000001', second.id, NOW));
    await db.reviewLogs.add(reviewLog('20000000-0000-4000-8000-000000000000', second.id, NOW));
    const exported = await repository.exportData({includePrivateContext: true, now: NOW});
    expect(exported.entries.map((entry) => entry.id)).toEqual(
      [...exported.entries.map((entry) => entry.id)].sort(),
    );
    expect(exported.reviewLogs.map((log) => log.id)).toEqual(
      [...exported.reviewLogs.map((log) => log.id)].sort(),
    );

    const snapshot = await repository.removeWithSnapshot(second.id);
    expect(snapshot?.reviewLogs.map((log) => log.id)).toEqual([
      '20000000-0000-4000-8000-000000000000',
      '20000000-0000-4000-8000-000000000001',
    ]);
  });
});

describe('vocabulary repository untrusted imports', () => {
  it('rejects unsupported envelopes and sanitizes every optional entry and review-log branch', async () => {
    await expect(repository.importData(null, NOW)).rejects.toMatchObject({code: 'invalid-export'});
    await expect(repository.importData({}, NOW)).rejects.toMatchObject({code: 'invalid-export'});

    const commonId = '30000000-0000-4000-8000-000000000001';
    const rareId = '30000000-0000-4000-8000-000000000002';
    const payload = {
      format: VOCABULARY_BOOK_EXPORT_FORMAT,
      version: VOCABULARY_BOOK_EXPORT_VERSION,
      entries: [
        null,
        {sourceLanguage: 'bad!', term: 'Word', translations: {'zh-cn': {text: '词'}}},
        {sourceLanguage: 'en', term: 'Word', translations: null},
        {
          id: commonId,
          sourceLanguage: 'en',
          term: 'Common',
          translations: {
            'bad!': {text: 'invalid language', updatedAt: NOW},
            ZH_CN: null,
            zh_cn: {text: '较新', updatedAt: NOW + 10},
            'zh-cn': {text: '较旧', updatedAt: NOW},
            ja: {text: '   ', updatedAt: NOW},
          },
          contexts: 'not-an-array',
          createdAt: NOW,
          updatedAt: NOW,
          masteryLevel: 5,
          reviewCount: 1,
          nextReviewAt: null,
        },
        {
          id: rareId,
          sourceLanguage: 'en',
          term: 'Rare',
          translations: {'zh-cn': {text: '罕见', updatedAt: NOW}},
          contexts: [],
          createdAt: NOW,
          updatedAt: NOW,
          masteryLevel: 0,
          reviewCount: 0,
          nextReviewAt: null,
        },
      ],
      reviewLogs: [
        null,
        {entryId: 5, rating: 'good', reviewedAt: NOW},
        {entryId: 'missing', rating: 'good', reviewedAt: NOW},
        {entryId: commonId, rating: 'perfect', reviewedAt: NOW},
        {entryId: commonId, rating: 'good', reviewedAt: 'invalid'},
        {
          id: 'invalid-log-id',
          entryId: commonId,
          rating: 'good',
          reviewedAt: NOW,
          beforeLevel: 99,
          afterLevel: -1,
          nextReviewAt: undefined,
        },
      ],
    };

    const result = await repository.importData(payload, NOW + 100);
    expect(result).toMatchObject({inserted: 2, reviewLogsImported: 1});
    await expect(repository.getByTerm('en', 'common')).resolves.toMatchObject({
      translations: {'zh-cn': {text: '较新', updatedAt: NOW + 10}},
      masteryLevel: 5,
      status: 'mastered',
      nextReviewAt: null,
    });
    await expect(repository.getByTerm('en', 'rare')).resolves.toMatchObject({
      status: 'new',
      nextReviewAt: NOW,
    });
    await expect(repository.getReviewLogs(commonId)).resolves.toMatchObject([
      {rating: 'good', beforeLevel: 0, afterLevel: 0, nextReviewAt: null},
    ]);
  });

  it('rolls back an import that would exceed the five-thousand-entry cap', async () => {
    const template = await repository.upsert(baseInput(), NOW);
    await db.entries.clear();
    const existing = Array.from({length: VOCABULARY_BOOK_MAX_ENTRIES - 1}, (_, index) => {
      const term = `seed${alphabeticIndex(index)}`;
      return cloneEntry(template, {
        id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        identityKey: `en\u0000${term}`,
        term,
        normalizedTerm: term,
      });
    });
    await db.entries.bulkAdd(existing);

    const payload: VocabularyBookExport = {
      format: VOCABULARY_BOOK_EXPORT_FORMAT,
      version: VOCABULARY_BOOK_EXPORT_VERSION,
      exportedAt: NOW,
      includesPrivateContext: false,
      entries: [
        cloneEntry(template, {
          id: '40000000-0000-4000-8000-900000000001',
          identityKey: 'ignored',
          term: 'Overflowa',
          normalizedTerm: 'ignored',
        }),
        cloneEntry(template, {
          id: '40000000-0000-4000-8000-900000000002',
          identityKey: 'ignored',
          term: 'Overflowb',
          normalizedTerm: 'ignored',
        }),
      ],
      reviewLogs: [],
    };

    await expect(repository.importData(payload, NOW + 1)).rejects.toMatchObject({
      code: 'limit-exceeded',
    });
    await expect(db.entries.count()).resolves.toBe(VOCABULARY_BOOK_MAX_ENTRIES - 1);
    await expect(repository.getByTerm('en', 'overflowa')).resolves.toBeNull();
  });

  it('merges older duplicate snapshots while selecting review and lapse tie-breakers independently', async () => {
    const template = await repository.upsert(baseInput(), NOW);
    await repository.clear();
    const commonNewer = cloneEntry(template, {
      id: '50000000-0000-4000-8000-000000000001',
      identityKey: 'ignored',
      term: 'Common',
      normalizedTerm: 'ignored',
      updatedAt: NOW + 100,
      lastReviewedAt: NOW + 50,
      reviewCount: 1,
      lapseCount: 0,
      translations: {'zh-cn': {text: '较新快照', updatedAt: NOW + 100}},
    });
    const commonOlderWithMoreReviews = cloneEntry(commonNewer, {
      id: '50000000-0000-4000-8000-000000000002',
      updatedAt: NOW,
      reviewCount: 2,
      translations: {'zh-cn': {text: '较旧快照', updatedAt: NOW}},
    });
    const rareFirst = cloneEntry(template, {
      id: '50000000-0000-4000-8000-000000000003',
      identityKey: 'ignored',
      term: 'Rare',
      normalizedTerm: 'ignored',
      updatedAt: NOW + 20,
      lastReviewedAt: NOW + 10,
      reviewCount: 2,
      lapseCount: 2,
    });
    const rareSecond = cloneEntry(rareFirst, {
      id: '50000000-0000-4000-8000-000000000004',
      updatedAt: NOW + 10,
      lapseCount: 1,
    });
    const stableFirst = cloneEntry(template, {
      id: '50000000-0000-4000-8000-000000000005',
      identityKey: 'ignored',
      term: 'Stable',
      normalizedTerm: 'ignored',
      lastReviewedAt: NOW + 10,
      reviewCount: 2,
    });
    const stableSecond = cloneEntry(stableFirst, {
      id: '50000000-0000-4000-8000-000000000006',
      reviewCount: 1,
    });
    const zebraFirst = cloneEntry(template, {
      id: '50000000-0000-4000-8000-000000000007',
      identityKey: 'ignored',
      term: 'Zebra',
      normalizedTerm: 'ignored',
      lastReviewedAt: NOW + 10,
      reviewCount: 2,
      lapseCount: 1,
    });
    const zebraSecond = cloneEntry(zebraFirst, {
      id: '50000000-0000-4000-8000-000000000008',
      lapseCount: 2,
    });
    const payload: VocabularyBookExport = {
      format: VOCABULARY_BOOK_EXPORT_FORMAT,
      version: VOCABULARY_BOOK_EXPORT_VERSION,
      exportedAt: NOW,
      includesPrivateContext: true,
      entries: [
        commonNewer,
        commonOlderWithMoreReviews,
        rareFirst,
        rareSecond,
        stableFirst,
        stableSecond,
        zebraFirst,
        zebraSecond,
      ],
      reviewLogs: [],
    };

    const result = await repository.importData(payload, NOW + 200);
    expect(result).toMatchObject({inserted: 4, skipped: 4});
    await expect(repository.getByTerm('en', 'common')).resolves.toMatchObject({
      translations: {'zh-cn': {text: '较新快照', updatedAt: NOW + 100}},
      reviewCount: 2,
    });
    await expect(repository.getByTerm('en', 'rare')).resolves.toMatchObject({lapseCount: 2});
    await expect(repository.getByTerm('en', 'stable')).resolves.toMatchObject({reviewCount: 2});
    await expect(repository.getByTerm('en', 'zebra')).resolves.toMatchObject({lapseCount: 2});
  });
});
