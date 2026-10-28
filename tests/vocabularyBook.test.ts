import 'fake-indexeddb/auto';
import {VocabularyPersistentUndo, VOCABULARY_UNDO_TTL_MS, VOCABULARY_UNDO_MAX_PENDING} from '@/src/features/vocabulary/background/persistentUndo';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOCABULARY_BOOK_EXPORT_FORMAT,
  VOCABULARY_BOOK_EXPORT_VERSION,
  VOCABULARY_BOOK_MAX_ENTRIES,
  VOCABULARY_ENTRY_SCHEMA_VERSION,
  VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY,
  VOCABULARY_REVIEW_AGAIN_DELAY_MS,
  VOCABULARY_REVIEW_GOOD_INTERVALS_MS,
  FluentReadVocabularyBookDatabase,
  VocabularyBookRepository,
  advanceVocabularyReviewSession,
  buildAnkiTsv,
  vocabularyReviewCloze,
  buildVocabularyIdentityKey,
  createVocabularyLifecycleGuard,
  createVocabularyReviewSession,
  normalizeVocabularyTerm,
  reconcileVocabularyReviewQueue,
  reconcileVocabularyReviewSession,
  sanitizeVocabularySourceUrl,
  vocabularyReviewSessionProgress,
  vocabularyImportNeedsConfirmation,
  type VocabularyBookExport,
} from '@/src/features/vocabulary/repository';

const NOW = 1_000_000;
let databaseSequence = 0;
let db: FluentReadVocabularyBookDatabase;
let repository: VocabularyBookRepository;
let undo: VocabularyPersistentUndo;

beforeEach(() => {
  databaseSequence += 1;
  db = new FluentReadVocabularyBookDatabase(`FluentReadVocabularyBookTest-${databaseSequence}`);
  repository = new VocabularyBookRepository(db);
  undo = new VocabularyPersistentUndo(db);
});

afterEach(async () => {
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

describe('Anki export', () => {
  it('round trips sentence identity, translation and independently saved explanations without changing review state', async () => {
    const first = await repository.upsert(baseInput({term:'Good ideas deserve attention.', kind:'sentence', translation:'好想法值得关注。', note:'deserve 表示值得。'}), NOW);
    expect(first).toMatchObject({kind:'sentence', note:'deserve 表示值得。', noteUpdatedAt:NOW});
    const explained = await repository.updateNote(first.id, '值得留意的表达：deserve attention。', NOW + 1);
    expect(explained.encounterCount).toBe(1);
    expect(explained.nextReviewAt).toBe(first.nextReviewAt);
    expect(explained.translations).toEqual(first.translations);
    const exported = await repository.exportData();
    await repository.clear();
    await repository.importData(exported, NOW + 2);
    expect(await repository.get(first.id)).toMatchObject({kind:'sentence', note:explained.note, noteUpdatedAt:NOW+1});
    await repository.updateNote(first.id, '', NOW + 3);
    await repository.importData(exported, NOW + 4);
    expect((await repository.get(first.id))?.note).toBe('');
    await repository.remove(first.id);
    await expect(repository.updateNote(first.id, 'late', NOW + 5)).rejects.toThrow('收藏已不存在');
    await expect(repository.updateNote(first.id, 'x'.repeat(2001))).rejects.toThrow('2000');
    await expect(repository.updateNote(first.id, null as unknown as string)).rejects.toThrow('2000');
  });
  it('preserves explanations on repeated saves and safely merges legacy and duplicate imported sentences', async () => {
    const first = await repository.upsert(baseInput({term:'A sentence worth keeping.', kind:'sentence', note:'初次解释'}), NOW);
    const updated = await repository.upsert(baseInput({term:first.term, kind:'sentence', note:'第二次解释'}), NOW+1);
    expect(updated.note).toBe('第二次解释');
    expect((await repository.upsert(baseInput({term:first.term}), NOW+2)).note).toBe('第二次解释');
    const exported = await repository.exportData();
    exported.entries.push({...exported.entries[0], note:'最新解释', noteUpdatedAt:NOW+4, updatedAt:NOW+4});
    delete exported.entries[1].kind;
    await repository.importData(exported, NOW+5);
    expect((await repository.get(first.id))?.note).toBe('最新解释');
    const legacy = await repository.exportData();
    delete legacy.entries[0].kind;
    legacy.entries[0].updatedAt = NOW + 6;
    await repository.importData(legacy, NOW+7);
    expect((await repository.get(first.id))?.kind).toBe('sentence');
  });
  it('declares column names as metadata instead of emitting a fake header card', () => {
    const output = buildAnkiTsv(
      ['Term', 'Meaning', 'Context', 'Source', 'Tags'],
      [['common', '常见', 'A\ncommon example.', '', 'fluentread new']],
    );

    expect(output.split('\n')).toEqual([
      '#separator:tab',
      '#html:false',
      '#columns:Term\tMeaning\tContext\tSource\tTags',
      'common\t常见\tA common example.\t\tfluentread new',
    ]);
    expect(output).not.toContain('\nTerm\tMeaning\t');
  });
});

describe('review and import presentation helpers', () => {
  it.each([
    ['The article discusses art.', 'art', 'The article discusses ____.'],
    ["Don't forget don’t.", "don't", '____ forget ____.'],
    ['A well-known example stays known.', 'known', 'A well-known example stays ____.'],
    ['A well-known example.', 'well-known', 'A ____ example.'],
    ['No matching answer is present.', 'common', ''],
  ])('builds real review cloze prompts only from complete occurrences: %s', (text, term, cloze) => {
    expect(vocabularyReviewCloze({term, contexts: [{text, capturedAt: NOW}]})).toBe(cloze);
  });

  it('warns instead of rejecting exports above the former hard size limit', () => {
    expect(vocabularyImportNeedsConfirmation(20 * 1024 * 1024)).toBe(false);
    expect(vocabularyImportNeedsConfirmation(20 * 1024 * 1024 + 1)).toBe(true);
    expect(vocabularyImportNeedsConfirmation(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('advances and reconciles review-session position after an external review or deletion', async () => {
    const common = await repository.upsert(baseInput(), NOW);
    const rare = await repository.upsert(
      baseInput({ term: 'Rare', translation: '罕见' }),
      NOW + 1,
    );
    const stable = await repository.upsert(
      baseInput({ term: 'Stable', translation: '稳定' }),
      NOW + 2,
    );
    const unrelated = await repository.upsert(
      baseInput({ term: 'Other', translation: '其他' }),
      NOW + 3,
    );

    const started = { ...createVocabularyReviewSession([common, rare, stable]), answerVisible: true };
    const afterCommon = advanceVocabularyReviewSession(started, common.id);
    expect(vocabularyReviewSessionProgress(afterCommon)).toMatchObject({
      current: rare,
      position: 2,
      total: 3,
    });
    expect(afterCommon.answerVisible).toBe(false);

    const withRareAnswer = { ...afterCommon, answerVisible: true };
    await repository.review(rare.id, 'good', NOW + 10);
    const afterExternalReview = reconcileVocabularyReviewSession(
      withRareAnswer,
      await repository.list(),
      NOW + 20,
    );
    expect(afterExternalReview.queue.map((entry) => entry.id)).toEqual([stable.id]);
    expect(afterExternalReview.answerVisible).toBe(false);
    expect(vocabularyReviewSessionProgress(afterExternalReview)).toMatchObject({
      current: stable,
      position: 2,
      total: 2,
    });
    expect(afterExternalReview.queue.some((entry) => entry.id === unrelated.id)).toBe(false);

    await repository.remove(rare.id);
    const afterExternalDelete = reconcileVocabularyReviewSession(
      withRareAnswer,
      await repository.list(),
      NOW + 20,
    );
    expect(afterExternalDelete.queue.map((entry) => entry.id)).toEqual([stable.id]);
    expect(afterExternalDelete.answerVisible).toBe(false);
    expect(vocabularyReviewSessionProgress(afterExternalDelete)).toMatchObject({
      current: stable,
      position: 2,
      total: 2,
    });
    expect(reconcileVocabularyReviewQueue([stable], [], NOW + 20)).toEqual([]);
  });

  it('does not initialize an async component lifecycle after it was disposed', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const lifecycle = createVocabularyLifecycleGuard();
    let initialized = false;
    const initialization = lifecycle.runAfterReady(ready, () => { initialized = true; });

    lifecycle.dispose();
    resolveReady();

    await expect(initialization).resolves.toBe(false);
    expect(initialized).toBe(false);
    expect(lifecycle.isActive()).toBe(false);
  });
});

describe('vocabulary identity and upsert', () => {
  it('normalizes English presentation and keeps target languages on one entry', async () => {
    expect(normalizeVocabularyTerm('  Don’t—Panic  ')).toBe("don't-panic");
    expect(buildVocabularyIdentityKey('EN_us', ' COMMON ')).toBe(
      buildVocabularyIdentityKey('en-US', 'common'),
    );

    const first = await repository.upsert(baseInput(), NOW);
    const second = await repository.upsert(
      baseInput({
        targetLanguage: 'ja',
        term: ' common ',
        translation: '一般的',
        partOfSpeech: ['adjective', 'noun', 'adjective'],
      }),
      NOW + 1,
    );

    expect(second.id).toBe(first.id);
    expect(second.identityKey).toBe('en\u0000common');
    expect(second.normalizedTerm).toBe('common');
    expect(second.encounterCount).toBe(2);
    expect(second.partOfSpeech).toBe('adjective, noun');
    expect(second.translations).toEqual({
      'zh-cn': { text: '常见', updatedAt: NOW },
      ja: { text: '一般的', updatedAt: NOW + 1 },
    });
    await expect(repository.list()).resolves.toHaveLength(1);
    await expect(repository.getByTerm('EN', 'COMMON')).resolves.toMatchObject({ id: first.id });
  });

  it('rejects empty or overlong source texts without creating truncated identities', async () => {
    await expect(repository.upsert(baseInput({ term: '   ' }), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.upsert(baseInput({ term: '…!?！' }), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.upsert(baseInput({ term: 'a'.repeat(4097) }), NOW)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('saves multilingual sentences and round-trips them with existing word review records', async () => {
    const word = await repository.upsert(baseInput(), NOW);
    await repository.review(word.id, 'good', NOW + 1);
    const sentence = await repository.upsert(baseInput({term: 'Although it was late, she kept reading.'}), NOW + 2);
    const repeated = await repository.upsert(baseInput({term: '  Although it was late,\n she kept reading.  '}), NOW + 3);
    expect(repeated.id).toBe(sentence.id);
    const japanese = await repository.upsert(baseInput({sourceLanguage: 'ja', term: 'この本をもう一度読みたいです。'}), NOW + 4);
    await repository.upsert(baseInput({sourceLanguage: 'fr', term: 'Même tard, elle continuait à lire.'}), NOW + 5);
    const exported = await repository.exportData({includePrivateContext: true, now: NOW + 6});
    await repository.clear();
    expect(await repository.importData(exported, NOW + 7)).toMatchObject({inserted: 4, skipped: 0, reviewLogsImported: 1});
    expect(await repository.get(word.id)).toMatchObject({id: word.id, reviewCount: 1, masteryLevel: 1});
    expect(await repository.getByTerm('JA', japanese.term)).toMatchObject({id: japanese.id, term: japanese.term});
    expect(await repository.get(sentence.id)).toMatchObject({term: 'Although it was late, she kept reading.', encounterCount: 2});
  });

  it('retains the old English word identity and accepts bounded source texts without a schema migration', async () => {
    expect(normalizeVocabularyTerm('  Two   Words  ')).toBe('two words');
    expect(normalizeVocabularyTerm('ﬀ'.repeat(4096))).toBe('');
    const full = await repository.upsert(baseInput({term: '句'.repeat(4096)}), NOW);
    expect(full.term).toHaveLength(4096);
    expect(full.schemaVersion).toBe(1);
  });

  it('preserves source-only favorites through export and import without inventing or erasing translations', async () => {
    const sourceOnly = await repository.upsert(baseInput({term: '原文也值得收藏。', sourceLanguage: 'zh', translation: ''}), NOW);
    expect(sourceOnly.translations).toEqual({});
    const data = await repository.exportData({now: NOW + 1});
    await repository.clear();
    expect(await repository.importData(data, NOW + 2)).toMatchObject({inserted: 1, skipped: 0});
    expect(await repository.get(sourceOnly.id)).toMatchObject({term: sourceOnly.term, translations: {}});
    const explained = await repository.upsert(baseInput({term: sourceOnly.term, sourceLanguage: 'zh', translation: 'Useful source text.'}), NOW + 3);
    const recaptured = await repository.upsert(baseInput({term: sourceOnly.term, sourceLanguage: 'zh', translation: ''}), NOW + 4);
    expect(recaptured.translations).toEqual(explained.translations);
  });

  it('keeps learning progress when a repeated encounter refreshes snapshots', async () => {
    const original = await repository.upsert(baseInput(), NOW);
    const reviewed = await repository.review(original.id, 'good', NOW + 100);
    const repeated = await repository.upsert(
      baseInput({
        targetLanguage: 'fr',
        translation: 'commun',
        phonetic: undefined,
        partOfSpeech: undefined,
      }),
      NOW + 200,
    );

    expect(repeated.id).toBe(original.id);
    expect(repeated.masteryLevel).toBe(1);
    expect(repeated.status).toBe('learning');
    expect(repeated.reviewCount).toBe(1);
    expect(repeated.nextReviewAt).toBe(reviewed.entry.nextReviewAt);
    expect(repeated.phonetic).toBe('/ˈkɒmən/');
    expect(repeated.partOfSpeech).toBe('adjective');
    expect(repeated.translations.fr.text).toBe('commun');
  });

  it('allows updates at the five-thousand-entry limit but rejects a new identity', async () => {
    const template = await repository.upsert(baseInput(), NOW);
    const seeded = Array.from({ length: VOCABULARY_BOOK_MAX_ENTRIES - 1 }, (_, index) => {
      const term = `seed${alphabeticIndex(index)}`;
      return {
        ...template,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        identityKey: `en\u0000${term}`,
        term,
        normalizedTerm: term,
        translations: { 'zh-cn': { text: `种子${index}`, updatedAt: NOW } },
      };
    });
    await db.entries.bulkAdd(seeded);
    await expect(db.entries.count()).resolves.toBe(VOCABULARY_BOOK_MAX_ENTRIES);

    await expect(
      repository.upsert(baseInput({ targetLanguage: 'ja', translation: '一般的' }), NOW + 1),
    ).resolves.toMatchObject({ id: template.id });
    await expect(
      repository.upsert(baseInput({ term: 'Unseen', translation: '未见过' }), NOW + 2),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(db.entries.count()).resolves.toBe(VOCABULARY_BOOK_MAX_ENTRIES);
    const ticket=(await undo.removeWithUndo(template.id,NOW+3))!;
    await repository.upsert(baseInput({term:'Unseen'}),NOW+4);
    await expect(undo.restoreUndo(ticket.id,NOW+5)).rejects.toMatchObject({code:'limit-exceeded'});
    expect(await undo.listUndo(NOW+5)).toEqual([ticket]);
  });
});

describe('context cleaning and retention', () => {
  it('strips private URL components, rejects unsafe schemes and deduplicates contexts', async () => {
    expect(sanitizeVocabularySourceUrl('https://user:pass@example.com/a?token=secret#part')).toBe(
      'https://example.com/a',
    );
    expect(sanitizeVocabularySourceUrl('javascript:alert(1)')).toBeUndefined();

    const first = await repository.upsert(
      baseInput({
        context: {
          text: 'It is a common pattern.',
          sourceUrl: 'https://example.com/article?token=secret#section',
          pageTitle: ' First page ',
          capturedAt: NOW,
        },
      }),
      NOW,
    );
    const repeated = await repository.upsert(
      baseInput({
        context: {
          text: 'it is a common pattern.',
          sourceUrl: 'https://example.com/article?different=1#other',
          pageTitle: 'Updated page',
          capturedAt: NOW + 10,
        },
      }),
      NOW + 10,
    );

    expect(first.contexts).toHaveLength(1);
    expect(repeated.contexts).toEqual([
      {
        text: 'it is a common pattern.',
        sourceUrl: 'https://example.com/article',
        pageTitle: 'Updated page',
        capturedAt: NOW + 10,
      },
    ]);
  });

  it('retains only the eight newest unique contexts', async () => {
    const contexts = Array.from({ length: 10 }, (_, index) => ({
      text: `Context ${index}`,
      sourceUrl: `https://example.com/${index}?private=yes`,
      capturedAt: NOW + index,
    }));

    const entry = await repository.upsert(baseInput({ contexts }), NOW);
    expect(entry.contexts).toHaveLength(8);
    expect(entry.contexts.map((context) => context.text)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Context ${index + 2}`),
    );
  });

  it('bounds stored context and page-title snapshots', async () => {
    const entry = await repository.upsert(
      baseInput({ context: { text: 'x'.repeat(600), pageTitle: 'y'.repeat(250) } }),
      NOW,
    );
    expect(entry.contexts[0]?.text).toHaveLength(500);
    expect(entry.contexts[0]?.pageTitle).toHaveLength(200);
  });
});

describe('review scheduling and logs', () => {
  it('makes new cards due immediately and advances good reviews through five intervals', async () => {
    let entry = await repository.upsert(baseInput(), NOW);
    expect(entry.nextReviewAt).toBe(NOW);
    expect(entry.status).toBe('new');

    const statuses = ['learning', 'learning', 'familiar', 'familiar', 'mastered'];
    for (let index = 0; index < VOCABULARY_REVIEW_GOOD_INTERVALS_MS.length; index += 1) {
      const reviewedAt = NOW + 100 + index;
      const result = await repository.review(entry.id, 'good', reviewedAt);
      entry = result.entry;
      expect(entry.masteryLevel).toBe(index + 1);
      expect(entry.status).toBe(statuses[index]);
      expect(entry.nextReviewAt).toBe(reviewedAt + VOCABULARY_REVIEW_GOOD_INTERVALS_MS[index]!);
      expect(result.log).toMatchObject({
        rating: 'good',
        beforeLevel: index,
        afterLevel: index + 1,
      });
    }

    const failedAt = NOW + 1_000;
    const failed = await repository.review(entry.id, 'again', failedAt);
    expect(failed.entry).toMatchObject({
      masteryLevel: 0,
      status: 'learning',
      lapseCount: 1,
      nextReviewAt: failedAt + VOCABULARY_REVIEW_AGAIN_DELAY_MS,
    });
    await expect(repository.getReviewLogs(entry.id)).resolves.toHaveLength(6);
  });

  it('records manual mastery and relearn as explicit review events', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    const mastered = await repository.setMastery(entry.id, NOW + 1);
    expect(mastered.entry).toMatchObject({
      masteryLevel: 5,
      status: 'mastered',
      nextReviewAt: NOW + 1 + VOCABULARY_REVIEW_GOOD_INTERVALS_MS.at(-1)!,
    });
    expect(mastered.log.rating).toBe('manual-mastered');

    const relearned = await repository.relearn(entry.id, NOW + 2);
    expect(relearned.entry).toMatchObject({
      masteryLevel: 0,
      status: 'learning',
      nextReviewAt: NOW + 2,
    });
    expect(relearned.log.rating).toBe('relearn');
  });

  it('caps review history at one hundred logs per entry', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    for (let index = 0; index < 105; index += 1) {
      await repository.review(entry.id, 'again', NOW + index + 1);
    }

    const logs = await repository.getReviewLogs(entry.id);
    expect(logs).toHaveLength(100);
    expect(logs[0]?.reviewedAt).toBe(NOW + 6);
    expect(logs.at(-1)?.reviewedAt).toBe(NOW + 105);
  });
});

describe('repository transactions', () => {
  it('refuses to merge an in-memory undo snapshot into a newly saved same-identity entry',async()=>{
    const old=await repository.upsert(baseInput({translation:'old private'}),NOW);
    await repository.review(old.id,'good',NOW+1);const snapshot=(await repository.removeWithSnapshot(old.id))!;
    const newer=await repository.upsert(baseInput({translation:'newer',note:'new note'}),NOW+2);
    await expect(repository.restoreSnapshot(snapshot,Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({code:'invalid-input'});
    expect(await repository.get(newer.id)).toMatchObject({note:'new note',translations:{'zh-cn':{text:'newer'}}});
    expect(await repository.getReviewLogs(newer.id)).toEqual([]);
    expect(snapshot.entry.translations['zh-cn'].text).toBe('old private');
  });
  it('migrates a v1 database without losing entries before enabling persistent undo', async () => {
    const name = `FluentReadVocabularyMigration-${++databaseSequence}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({entries:'&id, &identityKey, sourceLanguage, createdAt, updatedAt, lastSeenAt, masteryLevel, status, nextReviewAt',reviewLogs:'&id, entryId, reviewedAt, [entryId+reviewedAt]'});
    await legacy.table('entries').add({id:'legacy-id',identityKey:'en\u0000legacy',term:'legacy'});
    legacy.close();
    const migrated = new FluentReadVocabularyBookDatabase(name);
    expect(await migrated.entries.get('legacy-id')).toMatchObject({term:'legacy'});
    expect(await migrated.undo.count()).toBe(0);
    migrated.close(); await migrated.delete();
  });

  it('persists deletion and logs atomically across database reopen, then restores exactly once', async () => {
    const entry = await repository.upsert(baseInput({note:'private note',context:{text:'private context',capturedAt:NOW}}), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    const previous = await repository.get(entry.id), logs = await repository.getReviewLogs(entry.id);
    const ticket = (await undo.removeWithUndo(entry.id, NOW + 2))!;
    expect(ticket).toMatchObject({term:entry.term,expiresAt:NOW + 2 + VOCABULARY_UNDO_TTL_MS});
    expect(JSON.stringify(ticket)).not.toContain('private context');
    expect(await repository.get(entry.id)).toBeNull();
    expect(await repository.getReviewLogs(entry.id)).toEqual([]);
    const name = db.name;
    db.close(); db = new FluentReadVocabularyBookDatabase(name); repository = new VocabularyBookRepository(db); undo = new VocabularyPersistentUndo(db);
    expect(await undo.listUndo(NOW+3)).toEqual([ticket]);
    expect(await undo.restoreUndo(ticket.id, NOW+4)).toBe('restored');
    db.close(); db = new FluentReadVocabularyBookDatabase(name); repository = new VocabularyBookRepository(db); undo = new VocabularyPersistentUndo(db);
    expect(await undo.restoreUndo(ticket.id, NOW+5)).toBe('previously-restored');
    expect(await repository.get(entry.id)).toEqual(previous);
    expect(await repository.getReviewLogs(entry.id)).toEqual(logs);
    expect(await undo.listUndo(NOW+6)).toEqual([]);
    expect(JSON.stringify(await db.undo.get(ticket.id))).not.toContain('private');
  });

  it('serializes concurrent removal and restoration and keeps deleted data out of exports', async () => {
    const entry=await repository.upsert(baseInput({term:'private unique term',note:'private unique note'}),NOW);
    await repository.review(entry.id,'good',NOW+1);
    const deletions=await Promise.all([undo.removeWithUndo(entry.id,NOW+2),undo.removeWithUndo(entry.id,NOW+2)]);
    const ticket=deletions.find(Boolean)!;
    expect(deletions.filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify(await repository.exportData({includePrivateContext:true}))).not.toContain('private unique');
    expect(await Promise.all([undo.restoreUndo(ticket.id,NOW+3),undo.restoreUndo(ticket.id,NOW+3)])).toEqual(['restored','previously-restored']);
    expect(await repository.getReviewLogs(entry.id)).toHaveLength(1);
  });
  it('does not claim a stale successful restore means the item is still present',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);const old=(await undo.removeWithUndo(entry.id,NOW+1))!;
    expect(await undo.restoreUndo(old.id,NOW+2)).toBe('restored');
    const newer=(await undo.removeWithUndo(entry.id,NOW+3))!;
    db.close();db=new FluentReadVocabularyBookDatabase(db.name);repository=new VocabularyBookRepository(db);undo=new VocabularyPersistentUndo(db);
    expect(await undo.restoreUndo(old.id,NOW+4)).toBe('previously-restored');
    expect(await repository.get(entry.id)).toBeNull();expect(await undo.listUndo(NOW+4)).toEqual([newer]);
  });
  it('rejects a restore that expires while waiting for the write transaction',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);const ticket=(await undo.removeWithUndo(entry.id,NOW))!;
    let clock=NOW+1;const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let locked=false;
    const hold=db.transaction('rw',db.entries,db.reviewLogs,db.undo,async()=>{locked=true;await Dexie.waitFor(gate);});
    await vi.waitFor(()=>expect(locked).toBe(true));const restoring=undo.restoreUndo(ticket.id);
    clock=ticket.expiresAt;release();await hold;expect(await restoring).toBe('expired');expect(await repository.get(entry.id)).toBeNull();date.mockRestore();
  });
  it('starts the retention period when a queued deletion obtains its write lock',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);let clock=NOW;const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let locked=false;
    const hold=db.transaction('rw',db.entries,db.reviewLogs,db.undo,async()=>{locked=true;await Dexie.waitFor(gate);});
    await vi.waitFor(()=>expect(locked).toBe(true));const removing=undo.removeWithUndo(entry.id);
    clock=NOW+VOCABULARY_UNDO_TTL_MS;release();await hold;const ticket=(await removing)!;
    expect(ticket.createdAt).toBe(clock);expect(ticket.expiresAt).toBe(clock+VOCABULARY_UNDO_TTL_MS);date.mockRestore();
  });
  it('rolls back deletion if its undo ticket expires before the transaction completes',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);let clock=NOW;const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    const remove=db.entries.delete.bind(db.entries);
    const spy=vi.spyOn(db.entries,'delete').mockImplementationOnce(id=>remove(id).then(()=>{clock=NOW+VOCABULARY_UNDO_TTL_MS;}));
    await expect(undo.removeWithUndo(entry.id)).rejects.toMatchObject({code:'storage-error'});
    expect(await repository.get(entry.id)).toMatchObject({id:entry.id});expect(await db.undo.count()).toBe(0);spy.mockRestore();date.mockRestore();
  });
  it('rolls back a restore that reaches expiry during the transaction',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);const ticket=(await undo.removeWithUndo(entry.id,NOW))!;
    let clock=NOW+1;const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);const put=db.undo.put.bind(db.undo);
    const spy=vi.spyOn(db.undo,'put').mockImplementationOnce(record=>put(record).then(result=>{clock=ticket.expiresAt;return result;}));
    expect(await undo.restoreUndo(ticket.id)).toBe('expired');expect(await repository.get(entry.id)).toBeNull();expect(await db.undo.get(ticket.id)).toBeUndefined();spy.mockRestore();date.mockRestore();
  });
  it('rejects an in-memory restore that expires while queued',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);const snapshot=(await repository.removeWithSnapshot(entry.id))!;
    let clock=NOW+1;const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let locked=false;
    const hold=db.transaction('rw',db.entries,db.reviewLogs,async()=>{locked=true;await Dexie.waitFor(gate);});
    await vi.waitFor(()=>expect(locked).toBe(true));const restoring=repository.restoreSnapshot(snapshot,NOW+10);
    const rejected=expect(restoring).rejects.toMatchObject({code:'not-found'});clock=NOW+10;release();await hold;await rejected;
    expect(await repository.get(entry.id)).toBeNull();date.mockRestore();
  });
  it('rolls back an in-memory restore when it expires during the transaction', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    const snapshot = (await repository.removeWithSnapshot(entry.id))!;
    let clock = NOW + 2;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const add = db.entries.add.bind(db.entries);
    const entryAdd = vi.spyOn(db.entries, 'add').mockImplementationOnce((...args) => add(...args).then(result => {clock = NOW + 10; return result;}));
    try {
      await expect(repository.restoreSnapshot(snapshot, NOW + 10)).rejects.toMatchObject({code: 'not-found'});
      expect(await repository.get(entry.id)).toBeNull();
      expect(await repository.getReviewLogs(entry.id)).toEqual([]);
    } finally {entryAdd.mockRestore(); date.mockRestore();}
  });
  it('restores an in-memory snapshot and its review history before expiry', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    const snapshot = (await repository.removeWithSnapshot(entry.id))!;
    await repository.restoreSnapshot(snapshot, Number.MAX_SAFE_INTEGER);
    expect(await repository.get(entry.id)).toEqual(snapshot.entry);
    expect(await repository.getReviewLogs(entry.id)).toEqual(snapshot.reviewLogs);
  });
  it('clears a userscript vocabulary database without requiring the extension undo table', async () => {
    vi.stubEnv('BROWSER', 'userscript');
    const scriptDb = new FluentReadVocabularyBookDatabase(`FluentReadVocabularyScriptTest-${++databaseSequence}`);
    const scriptRepository = new VocabularyBookRepository(scriptDb);
    try {
      const entry = await scriptRepository.upsert(baseInput(), NOW);
      await scriptRepository.review(entry.id, 'good', NOW + 1);
      await scriptRepository.clear();
      expect(await scriptRepository.get(entry.id)).toBeNull();
      expect(await scriptRepository.getReviewLogs(entry.id)).toEqual([]);
      expect(scriptDb.tables.map(table => table.name)).not.toContain('undo');
    } finally {scriptDb.close(); await scriptDb.delete(); vi.unstubAllEnvs();}
  });
  it('rolls back a restore if its receipt cannot be written',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);await repository.review(entry.id,'good',NOW+1);
    const ticket=(await undo.removeWithUndo(entry.id,NOW+2))!;
    const failure=vi.spyOn(db.undo,'put').mockRejectedValueOnce(new Error('failure'));
    await expect(undo.restoreUndo(ticket.id,NOW+3)).rejects.toThrow();failure.mockRestore();
    expect(await repository.get(entry.id)).toBeNull();expect(await repository.getReviewLogs(entry.id)).toEqual([]);
    expect(await undo.listUndo(NOW+3)).toEqual([ticket]);
    expect(await undo.restoreUndo(ticket.id,NOW+4)).toBe('restored');
  });
  it('refuses to retain oversized legacy data without deleting it',async()=>{
    const entry=await repository.upsert(baseInput(),NOW);
    await db.entries.update(entry.id,{note:'x'.repeat(9*1024*1024)});
    await expect(undo.removeWithUndo(entry.id,NOW+1)).rejects.toMatchObject({code:'limit-exceeded'});
    expect(await repository.get(entry.id)).not.toBeNull();expect(await undo.listUndo(NOW+2)).toEqual([]);
  });
  it('rolls back deletion if writing its durable undo snapshot fails', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    await repository.review(entry.id, 'good', NOW+1);
    const failure = vi.spyOn(db.undo, 'add').mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(undo.removeWithUndo(entry.id, NOW+2)).rejects.toThrow('synthetic write failure');
    failure.mockRestore();
    expect(await repository.get(entry.id)).not.toBeNull();
    expect(await repository.getReviewLogs(entry.id)).toHaveLength(1);
    expect(await undo.listUndo(NOW+3)).toEqual([]);
  });

  it('prunes expired records without touching a newer pending deletion',async()=>{
    const first=await repository.upsert(baseInput(),NOW);const old=(await undo.removeWithUndo(first.id,NOW))!;
    const next=await repository.upsert(baseInput({term:'later'}),NOW+1);const recent=(await undo.removeWithUndo(next.id,NOW+1))!;
    await undo.pruneUndo(NOW+VOCABULARY_UNDO_TTL_MS);
    expect(await db.undo.get(old.id)).toBeUndefined();expect(await undo.listUndo(NOW+VOCABULARY_UNDO_TTL_MS)).toEqual([recent]);
  });
  it('refuses expired, explicitly discarded and cleared tickets without reviving data', async () => {
    const first = await repository.upsert(baseInput(), NOW);
    const expired = (await undo.removeWithUndo(first.id, NOW))!;
    expect(await undo.restoreUndo(expired.id, NOW + VOCABULARY_UNDO_TTL_MS)).toBe('expired');
    expect(await undo.restoreUndo(expired.id, NOW + VOCABULARY_UNDO_TTL_MS)).toBe('missing');
    const second = await repository.upsert(baseInput({term:'second'}), NOW);
    const discarded = (await undo.removeWithUndo(second.id, NOW))!;
    await undo.discardUndo(discarded.id);
    expect(await undo.restoreUndo(discarded.id, NOW+1)).toBe('missing');
    const third = await repository.upsert(baseInput({term:'third'}), NOW);
    const cleared = (await undo.removeWithUndo(third.id, NOW))!;
    await repository.clear();
    expect(await undo.restoreUndo(cleared.id, NOW+1)).toBe('missing');
  });

  it('preserves snapshots on identity conflicts and limits simultaneous pending deletes', async () => {
    const old = await repository.upsert(baseInput(), NOW);
    const ticket = (await undo.removeWithUndo(old.id, NOW))!;
    const newer = await repository.upsert(baseInput({translation:'newer'}), NOW+1);
    await expect(undo.restoreUndo(ticket.id, NOW+2)).rejects.toThrow('相同收藏');
    expect(await repository.get(newer.id)).toMatchObject({translations:{'zh-cn':{text:'newer'}}});
    expect(await undo.listUndo(NOW+2)).toContainEqual(ticket);
    for (let index=1; index<VOCABULARY_UNDO_MAX_PENDING; index++) {
      const next = await repository.upsert(baseInput({term:`term ${index}`}), NOW+index);
      await undo.removeWithUndo(next.id, NOW+index);
    }
    const overflow = await repository.upsert(baseInput({term:'overflow'}), NOW+100);
    await expect(undo.removeWithUndo(overflow.id, NOW+101)).rejects.toMatchObject({code:'limit-exceeded'});
    expect(await repository.get(overflow.id)).not.toBeNull();
  });

  it('atomically returns a plain snapshot while deleting an entry and its review logs', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    await repository.review(entry.id, 'again', NOW + 2);
    const storedEntry = await repository.get(entry.id);
    const logs = await repository.getReviewLogs(entry.id);

    const snapshot = await repository.removeWithSnapshot(entry.id);
    expect(snapshot).toEqual({ entry: storedEntry, reviewLogs: logs });
    expect(snapshot?.entry).toEqual(expect.objectContaining({ id: entry.id, term: 'Common' }));
    expect(Object.getPrototypeOf(snapshot?.entry)).toBe(Object.prototype);
    expect(snapshot?.reviewLogs.every((log) => Object.getPrototypeOf(log) === Object.prototype)).toBe(
      true,
    );
    await expect(repository.get(entry.id)).resolves.toBeNull();
    await expect(repository.getReviewLogs(entry.id)).resolves.toEqual([]);
    await expect(repository.removeWithSnapshot(entry.id)).resolves.toBeNull();
    await expect(repository.remove(entry.id)).resolves.toBe(false);
  });

  it('restores a deletion snapshot and its reviews; a repeated import is explicitly idempotent', async () => {
    const entry = await repository.upsert(baseInput({note:'saved note', context:{text:'Context for this word.',capturedAt:NOW}}), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    await repository.review(entry.id, 'again', NOW + 2);
    const snapshot = (await repository.removeWithSnapshot(entry.id))!;
    const backup: VocabularyBookExport = {format:VOCABULARY_BOOK_EXPORT_FORMAT,version:VOCABULARY_BOOK_EXPORT_VERSION,
      exportedAt:NOW+3,includesPrivateContext:true,entries:[snapshot.entry],reviewLogs:snapshot.reviewLogs};
    expect(await repository.importData(backup, NOW+4)).toMatchObject({inserted:1,updated:0,reviewLogsImported:2});
    expect(await repository.get(entry.id)).toEqual(snapshot.entry);
    expect(await repository.getReviewLogs(entry.id)).toEqual(snapshot.reviewLogs);
    expect(await repository.importData(backup, NOW+5)).toMatchObject({inserted:0,updated:0,reviewLogsImported:0});
    expect(await repository.get(entry.id)).toEqual(snapshot.entry);
    expect(await repository.getReviewLogs(entry.id)).toEqual(snapshot.reviewLogs);
  });
});

describe('JSON export and import', () => {
  it('defaults to a privacy-safe export and round-trips private data when requested', async () => {
    const entry = await repository.upsert(
      baseInput({
        context: {
          text: 'A private sentence.',
          sourceUrl: 'https://example.com/private?token=secret#fragment',
          pageTitle: 'Private title',
          capturedAt: NOW,
        },
      }),
      NOW,
    );
    await repository.review(entry.id, 'good', NOW + 1);

    const safeExport = await repository.exportData({ now: NOW + 2 });
    expect(safeExport).toMatchObject({
      format: VOCABULARY_BOOK_EXPORT_FORMAT,
      version: VOCABULARY_BOOK_EXPORT_VERSION,
      includesPrivateContext: false,
    });
    expect(safeExport.entries[0]?.contexts).toEqual([{ capturedAt: NOW }]);
    expect(JSON.stringify(safeExport)).not.toContain('private');
    expect(JSON.stringify(safeExport)).not.toContain('example.com');

    const privateExport = await repository.exportData({ includePrivateContext: true, now: NOW + 3 });
    await repository.clear();
    const imported = await repository.importData(JSON.parse(JSON.stringify(privateExport)), NOW + 4);

    expect(imported).toMatchObject({ inserted: 1, reviewLogsImported: 1 });
    const restored = await repository.getByTerm('en', 'common');
    expect(restored).toMatchObject({
      id: entry.id,
      masteryLevel: 1,
      reviewCount: 1,
      contexts: [
        {
          text: 'A private sentence.',
          sourceUrl: 'https://example.com/private',
          pageTitle: 'Private title',
          capturedAt: NOW,
        },
      ],
    });
    await expect(repository.getReviewLogs(entry.id)).resolves.toHaveLength(1);
  });

  it('merges by recomputed identity and keeps a locally newer record', async () => {
    const local = await repository.upsert(baseInput({ translation: '本地新译文' }), NOW + 1_000);
    await repository.setMastery(local.id, NOW + 1_001);
    const exported = await repository.exportData({ includePrivateContext: true, now: NOW + 1_002 });
    const incoming = JSON.parse(JSON.stringify(exported)) as VocabularyBookExport;
    const incomingEntry = incoming.entries[0]!;
    incomingEntry.id = '11111111-1111-4111-8111-111111111111';
    incomingEntry.identityKey = 'attacker-controlled';
    incomingEntry.normalizedTerm = 'attacker-controlled';
    incomingEntry.updatedAt = NOW;
    incomingEntry.lastSeenAt = NOW;
    incomingEntry.masteryLevel = 0;
    incomingEntry.status = 'new';
    incomingEntry.translations['zh-cn'] = { text: '远端旧译文', updatedAt: NOW };
    incoming.reviewLogs = [];

    await repository.importData(incoming, NOW + 2_000);
    const merged = await repository.getByTerm('en', 'common');
    expect(merged).toMatchObject({
      id: local.id,
      identityKey: 'en\u0000common',
      normalizedTerm: 'common',
      masteryLevel: 5,
      status: 'mastered',
    });
    expect(merged?.translations['zh-cn'].text).toBe('本地新译文');
  });

  it('reports only imported review logs that remain after retention pruning', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    const incoming = await repository.exportData({ includePrivateContext: true, now: NOW + 1 });
    incoming.reviewLogs = Array.from(
      { length: VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY + 1 },
      (_, index) => ({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        entryId: entry.id,
        rating: 'again' as const,
        reviewedAt: NOW + index,
        beforeLevel: 0 as const,
        afterLevel: 0 as const,
        nextReviewAt: NOW + index + VOCABULARY_REVIEW_AGAIN_DELAY_MS,
      }),
    );
    await repository.clear();

    const result = await repository.importData(incoming, NOW + 2);
    const restored = await repository.getByTerm('en', 'common');
    const retainedLogs = await repository.getReviewLogs(restored!.id);

    expect(result).toMatchObject({
      inserted: 1,
      skipped: 1,
      reviewLogsImported: VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY,
    });
    expect(retainedLogs).toHaveLength(VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY);
    expect(retainedLogs[0]?.reviewedAt).toBe(NOW + 1);
    expect(retainedLogs.at(-1)?.reviewedAt).toBe(NOW + VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY);
  });

  it('counts immutable review-log collisions as skipped on idempotent re-import', async () => {
    const entry = await repository.upsert(baseInput(), NOW);
    await repository.review(entry.id, 'good', NOW + 1);
    const incoming = await repository.exportData({ includePrivateContext: true, now: NOW + 2 });

    const result = await repository.importData(incoming, NOW + 3);

    expect(result).toMatchObject({
      inserted: 0,
      updated: 0,
      skipped: 2,
      reviewLogsImported: 0,
    });
    await expect(repository.getReviewLogs(entry.id)).resolves.toHaveLength(1);
  });

  it('merges encounter snapshots independently from the latest reviewed learning state', async () => {
    const original = await repository.upsert(baseInput({ translation: '初始译文' }), NOW);
    await repository.review(original.id, 'good', NOW + 10);
    const reviewedExport = JSON.parse(JSON.stringify(
      await repository.exportData({ includePrivateContext: true, now: NOW + 20 }),
    )) as VocabularyBookExport;

    const laterUnreviewedEncounter = JSON.parse(JSON.stringify(reviewedExport)) as VocabularyBookExport;
    const laterEntry = laterUnreviewedEncounter.entries[0]!;
    laterEntry.updatedAt = NOW + 100;
    laterEntry.lastSeenAt = NOW + 100;
    laterEntry.translations['zh-cn'] = { text: '较晚重复收藏', updatedAt: NOW + 100 };
    laterEntry.phonetic = '';
    laterEntry.partOfSpeech = '';
    laterEntry.masteryLevel = 0;
    laterEntry.status = 'new';
    laterEntry.nextReviewAt = NOW + 100;
    laterEntry.lastReviewedAt = null;
    laterEntry.reviewCount = 0;
    laterEntry.lapseCount = 0;
    laterUnreviewedEncounter.reviewLogs = [];

    await repository.importData(laterUnreviewedEncounter, NOW + 101);
    await expect(repository.getByTerm('en', 'common')).resolves.toMatchObject({
      masteryLevel: 1,
      status: 'learning',
      lastReviewedAt: NOW + 10,
      reviewCount: 1,
      phonetic: '/ˈkɒmən/',
      partOfSpeech: 'adjective',
      translations: { 'zh-cn': { text: '较晚重复收藏', updatedAt: NOW + 100 } },
    });

    await repository.clear();
    await repository.upsert(baseInput({ translation: '本地更晚收藏' }), NOW + 300);
    await repository.importData(reviewedExport, NOW + 301);
    await expect(repository.getByTerm('en', 'common')).resolves.toMatchObject({
      masteryLevel: 1,
      status: 'learning',
      lastReviewedAt: NOW + 10,
      reviewCount: 1,
      translations: { 'zh-cn': { text: '本地更晚收藏', updatedAt: NOW + 300 } },
    });

    await repository.clear();
    const duplicateCandidates = JSON.parse(JSON.stringify(reviewedExport)) as VocabularyBookExport;
    const duplicate = JSON.parse(JSON.stringify(duplicateCandidates.entries[0])) as typeof duplicateCandidates.entries[number];
    duplicate.id = '33333333-3333-4333-8333-333333333333';
    duplicate.updatedAt = NOW + 400;
    duplicate.lastSeenAt = NOW + 400;
    duplicate.translations['zh-cn'] = { text: '导入内较晚收藏', updatedAt: NOW + 400 };
    duplicate.phonetic = '';
    duplicate.partOfSpeech = '';
    duplicate.masteryLevel = 0;
    duplicate.status = 'new';
    duplicate.nextReviewAt = NOW + 400;
    duplicate.lastReviewedAt = null;
    duplicate.reviewCount = 0;
    duplicate.lapseCount = 0;
    duplicateCandidates.entries.push(duplicate);

    const duplicateResult = await repository.importData(duplicateCandidates, NOW + 401);
    expect(duplicateResult).toMatchObject({ inserted: 1, reviewLogsImported: 1 });
    const duplicateMerged = await repository.getByTerm('en', 'common');
    expect(duplicateMerged).toMatchObject({
      masteryLevel: 1,
      status: 'learning',
      lastReviewedAt: NOW + 10,
      reviewCount: 1,
      phonetic: '/ˈkɒmən/',
      partOfSpeech: 'adjective',
      translations: { 'zh-cn': { text: '导入内较晚收藏', updatedAt: NOW + 400 } },
    });
    await expect(repository.getReviewLogs(duplicateMerged!.id)).resolves.toHaveLength(1);
  });

  it('skips logs whose valid source id is reused by different imported entries', async () => {
    const common = await repository.upsert(baseInput(), NOW);
    const rare = await repository.upsert(
      baseInput({ term: 'Rare', translation: '罕见' }),
      NOW + 1,
    );
    const stable = await repository.upsert(
      baseInput({ term: 'Stable', translation: '稳定' }),
      NOW + 2,
    );
    await repository.review(common.id, 'good', NOW + 3);
    await repository.review(rare.id, 'good', NOW + 4);
    await repository.review(stable.id, 'good', NOW + 5);

    const incoming = await repository.exportData({ includePrivateContext: true, now: NOW + 6 });
    const rareEntry = incoming.entries.find((entry) => entry.normalizedTerm === 'rare')!;
    rareEntry.id = common.id;
    const rareLog = incoming.reviewLogs.find((log) => log.entryId === rare.id)!;
    rareLog.entryId = common.id;

    await repository.clear();
    const result = await repository.importData(incoming, NOW + 7);

    expect(result).toMatchObject({ inserted: 3, skipped: 2, reviewLogsImported: 1 });
    const restoredCommon = await repository.getByTerm('en', 'common');
    const restoredRare = await repository.getByTerm('en', 'rare');
    const restoredStable = await repository.getByTerm('en', 'stable');
    await expect(repository.getReviewLogs(restoredCommon!.id)).resolves.toEqual([]);
    await expect(repository.getReviewLogs(restoredRare!.id)).resolves.toEqual([]);
    await expect(repository.getReviewLogs(restoredStable!.id)).resolves.toHaveLength(1);
  });

  it('strictly cleans untrusted fields and ignores invalid logs', async () => {
    const malicious = {
      format: VOCABULARY_BOOK_EXPORT_FORMAT,
      version: VOCABULARY_BOOK_EXPORT_VERSION,
      exportedAt: NOW,
      includesPrivateContext: true,
      entries: [
        {
          id: 'not-a-uuid',
          identityKey: 'forged',
          sourceLanguage: ' EN ',
          term: ' Common ',
          normalizedTerm: 'forged',
          translations: {
            ZH_CN: { text: ' 常见 ', updatedAt: NOW, injected: true },
            invalid: 'not-a-snapshot',
          },
          phonetic: 42,
          partOfSpeech: ' adjective ',
          contexts: [
            {
              text: ' Unsafe location ',
              sourceUrl: 'javascript:alert(1)',
              pageTitle: ' Page ',
              capturedAt: NOW,
              injected: true,
            },
            {
              text: ' Safe location ',
              sourceUrl: 'https://user:pass@example.com/path?token=secret#fragment',
              capturedAt: NOW + 1,
            },
          ],
          createdAt: NOW,
          updatedAt: NOW,
          lastSeenAt: NOW,
          encounterCount: -5,
          masteryLevel: 99,
          status: 'mastered',
          nextReviewAt: 'tomorrow',
          lastReviewedAt: 'yesterday',
          reviewCount: -1,
          lapseCount: -1,
          schemaVersion: 999,
          injected: { script: true },
        },
        {
          sourceLanguage: 'en',
          term: '…!?',
          translations: { 'zh-cn': { text: '无效', updatedAt: NOW } },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      reviewLogs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          entryId: 'not-a-uuid',
          rating: 'perfect',
          reviewedAt: NOW,
          beforeLevel: 0,
          afterLevel: 5,
          nextReviewAt: null,
        },
      ],
      injected: true,
    };

    const result = await repository.importData(malicious, NOW + 100);
    expect(result).toMatchObject({ inserted: 1, reviewLogsImported: 0 });
    await expect(repository.list()).resolves.toHaveLength(1);
    const entry = await repository.getByTerm('en', 'COMMON');
    expect(entry).toMatchObject({
      identityKey: 'en\u0000common',
      normalizedTerm: 'common',
      phonetic: '',
      partOfSpeech: 'adjective',
      encounterCount: 1,
      masteryLevel: 0,
      status: 'new',
      reviewCount: 0,
      lapseCount: 0,
      schemaVersion: VOCABULARY_ENTRY_SCHEMA_VERSION,
      translations: { 'zh-cn': { text: '常见', updatedAt: NOW } },
    });
    expect(entry?.contexts).toEqual([
      { text: 'Unsafe location', pageTitle: 'Page', capturedAt: NOW },
      { text: 'Safe location', sourceUrl: 'https://example.com/path', capturedAt: NOW + 1 },
    ]);
    expect(entry).not.toHaveProperty('injected');
    expect(entry?.contexts[0]).not.toHaveProperty('injected');
    await expect(repository.getReviewLogs(entry!.id)).resolves.toEqual([]);
  });
});
