/**
 * @file src/features/vocabulary/repository.ts
 * 文件职责：实现 FluentRead 本地单词与句子收藏的 Dexie 持久化仓库，协调事务内增删查改、复习日志裁剪、删除撤销恢复及导入导出落库。
 * 主要内容：定义 IndexedDB 表结构与 VocabularyBookRepository 仓储方法，组合清洗与导入合并子模块确保所有外部输入重建规范身份并在单事务内提交。
 * 模块边界：仓库只拥有本地 IndexedDB 事务与持久化边界，不处理 runtime 消息或渲染界面；输入清洗归 repositorySanitize，导入归并归 repositoryImportMerge。
 */
import Dexie, {type Table} from 'dexie';
import {
  VOCABULARY_BOOK_EXPORT_FORMAT,
  VOCABULARY_BOOK_EXPORT_VERSION,
  VOCABULARY_BOOK_MAX_ENTRIES,
  VOCABULARY_ENTRY_SCHEMA_VERSION,
  VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY,
  type VocabularyBookExport,
  type VocabularyEntry,
  type VocabularyExportEntry,
  type VocabularyExportOptions,
  type VocabularyImportResult,
  type VocabularyListOptions,
  type VocabularyRemovalSnapshot,
  type VocabularyReviewLog,
  type VocabularyReviewRating,
  type VocabularyReviewResult,
  type VocabularyScheduledReviewRating,
  type VocabularyUndoRecord,
  type VocabularyUpsertInput,
} from './learningModel';
import {
  MAX_TRANSLATION_LENGTH,
  VOCABULARY_REVIEW_AGAIN_DELAY_MS,
  VOCABULARY_REVIEW_GOOD_INTERVALS_MS,
  VocabularyBookError,
  buildVocabularyIdentityKey,
  cloneContext,
  cloneEntry,
  createUniqueUuid,
  createUuid,
  isPlainRecord,
  mergeTranslations,
  mergeVocabularyContexts,
  normalizeComparableText,
  normalizeVocabularyLanguage,
  normalizeVocabularyTerm,
  prepareUpsert,
  sanitizeCount,
  sanitizeText,
  sanitizeTimestamp,
  sanitizeVocabularyContext,
  sanitizeVocabularySourceUrl,
  scheduleVocabularyReview,
  vocabularyStatusForLevel,
  type VocabularyReviewSchedule,
} from './repositorySanitize';
import {
  mergeImportCandidates,
  mergeImportedEntry,
  sanitizeImportEntry,
  sanitizeImportReviewLog,
  type SanitizedImportEntry,
} from './repositoryImportMerge';

export * from './learningModel';
export {
  VOCABULARY_REVIEW_AGAIN_DELAY_MS,
  VOCABULARY_REVIEW_GOOD_INTERVALS_MS,
  VocabularyBookError,
  buildVocabularyIdentityKey,
  cloneEntry,
  createUuid,
  mergeVocabularyContexts,
  normalizeVocabularyLanguage,
  normalizeVocabularyTerm,
  sanitizeVocabularyContext,
  sanitizeVocabularySourceUrl,
  scheduleVocabularyReview,
  vocabularyStatusForLevel,
  type VocabularyReviewSchedule,
};

export class FluentReadVocabularyBookDatabase extends Dexie {
  entries!: Table<VocabularyEntry, string>;
  reviewLogs!: Table<VocabularyReviewLog, string>;
  undo!: Table<VocabularyUndoRecord, string>;

  constructor(name = 'FluentReadVocabularyBook') {
    super(name);
    this.version(1).stores({
      entries:
        '&id, &identityKey, sourceLanguage, createdAt, updatedAt, lastSeenAt, masteryLevel, status, nextReviewAt',
      reviewLogs: '&id, entryId, reviewedAt, [entryId+reviewedAt]',
    });
    if (import.meta.env.BROWSER !== 'userscript') this.version(2).stores({undo: '&id, state, expiresAt'});
  }
}

export const vocabularyBookDb = new FluentReadVocabularyBookDatabase();

/** 调用方持有词条和日志写事务；冲突时保留已有数据与原快照。 */
export async function restoreVocabularySnapshot(db: FluentReadVocabularyBookDatabase, snapshot: VocabularyRemovalSnapshot): Promise<void> {
  const {entry, reviewLogs} = snapshot;
  if (await db.entries.get(entry.id) || await db.entries.where('identityKey').equals(entry.identityKey).first()
    || (await db.reviewLogs.bulkGet(reviewLogs.map(log => log.id))).some(Boolean)) {
    throw new VocabularyBookError('invalid-input', '已有相同收藏或复习记录，请先检查现有数据。');
  }
  if (await db.entries.count() >= VOCABULARY_BOOK_MAX_ENTRIES) throw new VocabularyBookError('limit-exceeded', '收藏已达上限，无法恢复删除记录。');
  await db.entries.add(entry);
  if (reviewLogs.length) await db.reviewLogs.bulkAdd(reviewLogs);
}

export class VocabularyBookRepository {
  constructor(private readonly db: FluentReadVocabularyBookDatabase = vocabularyBookDb) {}

  async list(options: VocabularyListOptions = {}): Promise<VocabularyEntry[]> {
    return this.db.transaction('r', this.db.entries, async () => {
      let entries = await this.db.entries.toArray();
      const statuses = options.status
        ? new Set(Array.isArray(options.status) ? options.status : [options.status])
        : null;
      const sourceLanguage = options.sourceLanguage
        ? normalizeVocabularyLanguage(options.sourceLanguage)
        : '';
      const targetLanguage = options.targetLanguage
        ? normalizeVocabularyLanguage(options.targetLanguage)
        : '';
      const search = options.search ? normalizeComparableText(options.search, MAX_TRANSLATION_LENGTH) : '';
      const now = sanitizeTimestamp(options.now, Date.now());

      entries = entries.filter((entry) => {
        if (statuses && !statuses.has(entry.status)) return false;
        if (sourceLanguage && entry.sourceLanguage !== sourceLanguage) return false;
        if (targetLanguage && !entry.translations[targetLanguage]) return false;
        if (options.dueOnly && (entry.nextReviewAt === null || entry.nextReviewAt > now)) return false;
        if (
          search &&
          !entry.normalizedTerm.includes(search) &&
          !Object.values(entry.translations).some((item) =>
            normalizeComparableText(item.text, MAX_TRANSLATION_LENGTH).includes(search),
          )
        ) {
          return false;
        }
        return true;
      });

      const order = options.order ?? 'recent';
      entries.sort((left, right) => {
        if (order === 'term') return left.normalizedTerm.localeCompare(right.normalizedTerm);
        if (order === 'due') {
          if (left.nextReviewAt === null) return right.nextReviewAt === null ? 0 : 1;
          if (right.nextReviewAt === null) return -1;
          return left.nextReviewAt - right.nextReviewAt;
        }
        return right.lastSeenAt - left.lastSeenAt;
      });

      const offset = sanitizeCount(options.offset, 0);
      const limit = Math.min(sanitizeCount(options.limit, VOCABULARY_BOOK_MAX_ENTRIES, 1), VOCABULARY_BOOK_MAX_ENTRIES);
      return entries.slice(offset, offset + limit).map(cloneEntry);
    });
  }

  async get(entryId: string): Promise<VocabularyEntry | null> {
    return this.db.transaction('r', this.db.entries, async () => {
      const entry = await this.db.entries.get(entryId);
      return entry ? cloneEntry(entry) : null;
    });
  }

  async getByTerm(sourceLanguage: string, term: string): Promise<VocabularyEntry | null> {
    const identityKey = buildVocabularyIdentityKey(sourceLanguage, term);
    if (!identityKey) return null;
    return this.db.transaction('r', this.db.entries, async () => {
      const entry = await this.db.entries.where('identityKey').equals(identityKey).first();
      return entry ? cloneEntry(entry) : null;
    });
  }

  async upsert(input: VocabularyUpsertInput, now = Date.now()): Promise<VocabularyEntry> {
    const prepared = prepareUpsert(input, now);
    return this.db.transaction('rw', this.db.entries, async () => {
      const existing = await this.db.entries.where('identityKey').equals(prepared.identityKey).first();
      if (!existing) {
        if ((await this.db.entries.count()) >= VOCABULARY_BOOK_MAX_ENTRIES) {
          throw new VocabularyBookError(
            'limit-exceeded',
            `Vocabulary book is limited to ${VOCABULARY_BOOK_MAX_ENTRIES} entries.`,
          );
        }

        const entry: VocabularyEntry = {
          id: createUuid(),
          identityKey: prepared.identityKey,
          sourceLanguage: prepared.sourceLanguage,
          term: prepared.term,
          ...(prepared.kind ? {kind: prepared.kind} : {}),
          ...(prepared.noteUpdatedAt === undefined ? {} : {note: prepared.note, noteUpdatedAt: prepared.noteUpdatedAt}),
          normalizedTerm: prepared.normalizedTerm,
          translations: prepared.translation ? {
            [prepared.targetLanguage]: {text: prepared.translation, updatedAt: now},
          } : {},
          phonetic: prepared.phonetic,
          partOfSpeech: prepared.partOfSpeech,
          contexts: mergeVocabularyContexts([], prepared.contexts),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          encounterCount: 1,
          masteryLevel: 0,
          status: 'new',
          nextReviewAt: now,
          lastReviewedAt: null,
          reviewCount: 0,
          lapseCount: 0,
          schemaVersion: VOCABULARY_ENTRY_SCHEMA_VERSION,
        };
        await this.db.entries.add(entry);
        return cloneEntry(entry);
      }

      const updatedAt = Math.max(existing.updatedAt, now);
      const updated: VocabularyEntry = {
        ...existing,
        term: prepared.term,
        ...(prepared.kind ? {kind: prepared.kind} : {}),
        ...(prepared.noteUpdatedAt === undefined ? {} : {note: prepared.note, noteUpdatedAt: updatedAt}),
        normalizedTerm: prepared.normalizedTerm,
        translations: mergeTranslations(existing.translations, prepared.translation ? {
          [prepared.targetLanguage]: {text: prepared.translation, updatedAt},
        } : {}),
        phonetic: prepared.phonetic || existing.phonetic,
        partOfSpeech: prepared.partOfSpeech || existing.partOfSpeech,
        contexts: mergeVocabularyContexts(existing.contexts, prepared.contexts),
        updatedAt,
        lastSeenAt: Math.max(existing.lastSeenAt, now),
        encounterCount: Math.min(Number.MAX_SAFE_INTEGER, existing.encounterCount + 1),
        schemaVersion: VOCABULARY_ENTRY_SCHEMA_VERSION,
      };
      await this.db.entries.put(updated);
      return cloneEntry(updated);
    });
  }

  /** 仅修改既有收藏的解释，不增加收藏次数，不重新创建被删除的句子。 */
  async updateNote(entryId: string, note: string, now = Date.now()): Promise<VocabularyEntry> {
    if (typeof note !== 'string' || note.length > 2_000) throw new VocabularyBookError('invalid-input', '解释最多保存 2000 个字符。');
    return this.db.transaction('rw', this.db.entries, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry) throw new VocabularyBookError('not-found', '收藏已不存在，请刷新列表。');
      const updatedAt = Math.max(entry.updatedAt + 1, now);
      const updated = {...entry, note: sanitizeText(note, 2_000), noteUpdatedAt: updatedAt, updatedAt};
      await this.db.entries.put(updated);
      return cloneEntry(updated);
    });
  }

  private async mutateWithReviewLog(
    entryId: string,
    rating: VocabularyReviewRating,
    now: number,
    mutate: (entry: VocabularyEntry) => VocabularyEntry,
  ): Promise<VocabularyReviewResult> {
    // 词条状态、复习日志和日志裁剪必须在同一读写事务中提交，避免留下无法对应的半状态。
    return this.db.transaction('rw', this.db.entries, this.db.reviewLogs, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry) throw new VocabularyBookError('not-found', 'Vocabulary entry was not found.');

      const updated = mutate(entry);
      const log: VocabularyReviewLog = {
        id: createUuid(),
        entryId,
        rating,
        reviewedAt: now,
        beforeLevel: entry.masteryLevel,
        afterLevel: updated.masteryLevel,
        nextReviewAt: updated.nextReviewAt,
      };
      await this.db.entries.put(updated);
      await this.db.reviewLogs.add(log);
      await this.pruneReviewLogs(entryId);
      return {entry: cloneEntry(updated), log: {...log}};
    });
  }

  private async pruneReviewLogs(entryId: string): Promise<string[]> {
    const logs = await this.db.reviewLogs.where('entryId').equals(entryId).toArray();
    if (logs.length <= VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY) return [];
    logs.sort((left, right) => left.reviewedAt - right.reviewedAt || left.id.localeCompare(right.id));
    const deletedIds = logs
      .slice(0, logs.length - VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY)
      .map((log) => log.id);
    await this.db.reviewLogs.bulkDelete(deletedIds);
    return deletedIds;
  }

  async review(
    entryId: string,
    rating: VocabularyScheduledReviewRating,
    now = Date.now(),
  ): Promise<VocabularyReviewResult> {
    if (rating !== 'again' && rating !== 'good') {
      throw new VocabularyBookError('invalid-input', 'Scheduled review rating must be again or good.');
    }

    return this.mutateWithReviewLog(entryId, rating, now, (entry) => {
      const schedule = scheduleVocabularyReview(entry.masteryLevel, rating, now);
      return {
        ...entry,
        masteryLevel: schedule.masteryLevel,
        status: schedule.status,
        nextReviewAt: schedule.nextReviewAt,
        lastReviewedAt: now,
        reviewCount: Math.min(Number.MAX_SAFE_INTEGER, entry.reviewCount + 1),
        lapseCount: Math.min(Number.MAX_SAFE_INTEGER, entry.lapseCount + schedule.lapseDelta),
        updatedAt: Math.max(entry.updatedAt, now),
      };
    });
  }

  async setMastery(entryId: string, now = Date.now()): Promise<VocabularyReviewResult> {
    return this.mutateWithReviewLog(entryId, 'manual-mastered', now, (entry) => ({
      ...entry,
      masteryLevel: 5,
      status: 'mastered',
      // “已掌握”仍保留低频巩固；手动标记与连续答对达到 5 级保持一致。
      nextReviewAt: now + VOCABULARY_REVIEW_GOOD_INTERVALS_MS.at(-1)!,
      lastReviewedAt: now,
      reviewCount: Math.min(Number.MAX_SAFE_INTEGER, entry.reviewCount + 1),
      updatedAt: Math.max(entry.updatedAt, now),
    }));
  }

  async relearn(entryId: string, now = Date.now()): Promise<VocabularyReviewResult> {
    return this.mutateWithReviewLog(entryId, 'relearn', now, (entry) => ({
      ...entry,
      masteryLevel: 0,
      status: 'learning',
      nextReviewAt: now,
      lastReviewedAt: now,
      reviewCount: Math.min(Number.MAX_SAFE_INTEGER, entry.reviewCount + 1),
      updatedAt: Math.max(entry.updatedAt, now),
    }));
  }

  async getReviewLogs(entryId: string): Promise<VocabularyReviewLog[]> {
    return this.db.transaction('r', this.db.reviewLogs, async () => {
      const logs = await this.db.reviewLogs.where('entryId').equals(entryId).toArray();
      return logs
        .sort((left, right) => left.reviewedAt - right.reviewedAt || left.id.localeCompare(right.id))
        .map((log) => ({...log}));
    });
  }

  async remove(entryId: string): Promise<boolean> {
    return (await this.removeWithSnapshot(entryId)) !== null;
  }

  async removeWithSnapshot(entryId: string): Promise<VocabularyRemovalSnapshot | null> {
    return this.db.transaction('rw', this.db.entries, this.db.reviewLogs, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry) return null;
      const reviewLogs = await this.db.reviewLogs.where('entryId').equals(entryId).toArray();
      await this.db.entries.delete(entryId);
      await this.db.reviewLogs.where('entryId').equals(entryId).delete();
      return {
        entry: cloneEntry(entry),
        reviewLogs: reviewLogs
          .sort((left, right) => left.reviewedAt - right.reviewedAt || left.id.localeCompare(right.id))
          .map((log) => ({...log})),
      };
    });
  }

  async restoreSnapshot(snapshot: VocabularyRemovalSnapshot, expiresAt: number): Promise<void> {
    await this.db.transaction('rw', this.db.entries, this.db.reviewLogs, async () => {
      if (Date.now() >= expiresAt) throw new VocabularyBookError('not-found', '恢复记录已过期');
      await restoreVocabularySnapshot(this.db, snapshot);
      if (Date.now() >= expiresAt) throw new VocabularyBookError('not-found', '恢复记录已过期');
    });
  }

  async clear(): Promise<void> {
    const tables = import.meta.env.BROWSER === 'userscript' ? [this.db.entries, this.db.reviewLogs] : [this.db.entries, this.db.reviewLogs, this.db.undo];
    await this.db.transaction('rw', tables, async () => {
      await this.db.reviewLogs.clear();
      await this.db.entries.clear();
      if (import.meta.env.BROWSER !== 'userscript') await this.db.undo.clear();
    });
  }

  async exportData(options: VocabularyExportOptions = {}): Promise<VocabularyBookExport> {
    return this.db.transaction('r', this.db.entries, this.db.reviewLogs, async () => {
      const includePrivateContext = options.includePrivateContext === true;
      const [entries, reviewLogs] = await Promise.all([
        this.db.entries.toArray(),
        this.db.reviewLogs.toArray(),
      ]);

      entries.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      reviewLogs.sort(
        (left, right) => left.reviewedAt - right.reviewedAt || left.id.localeCompare(right.id),
      );

      return {
        format: VOCABULARY_BOOK_EXPORT_FORMAT,
        version: VOCABULARY_BOOK_EXPORT_VERSION,
        exportedAt: sanitizeTimestamp(options.now, Date.now()),
        includesPrivateContext: includePrivateContext,
        entries: entries.map((entry): VocabularyExportEntry => ({
          ...cloneEntry(entry),
          contexts: entry.contexts.map((context) =>
            includePrivateContext ? cloneContext(context) : {capturedAt: context.capturedAt},
          ),
        })),
        reviewLogs: reviewLogs.map((log) => ({...log})),
      };
    });
  }

  async importData(value: unknown, now = Date.now()): Promise<VocabularyImportResult> {
    if (
      !isPlainRecord(value) ||
      value.format !== VOCABULARY_BOOK_EXPORT_FORMAT ||
      value.version !== VOCABULARY_BOOK_EXPORT_VERSION ||
      !Array.isArray(value.entries) ||
      !Array.isArray(value.reviewLogs)
    ) {
      throw new VocabularyBookError('invalid-export', 'Unsupported vocabulary-book export.');
    }

    const rawReviewLogs = value.reviewLogs;
    const grouped = new Map<string, SanitizedImportEntry>();
    const sourceIdToIdentity = new Map<string, string>();
    const ambiguousSourceIds = new Set<string>();
    let skipped = 0;
    for (const rawEntry of value.entries) {
      const candidate = sanitizeImportEntry(rawEntry, now);
      if (!candidate) {
        skipped += 1;
        continue;
      }

      // 复习日志只携带导出源词条 ID；若同一有效 ID 被复用于不同规范词形，就无法安全确定目标词条。
      for (const sourceId of candidate.sourceIds) {
        const previousIdentity = sourceIdToIdentity.get(sourceId);
        if (previousIdentity && previousIdentity !== candidate.entry.identityKey) {
          ambiguousSourceIds.add(sourceId);
        } else if (!previousIdentity) {
          sourceIdToIdentity.set(sourceId, candidate.entry.identityKey);
        }
      }

      const previous = grouped.get(candidate.entry.identityKey);
      if (!previous) {
        grouped.set(candidate.entry.identityKey, candidate);
      } else {
        grouped.set(candidate.entry.identityKey, mergeImportCandidates(previous, candidate));
        skipped += 1;
      }
    }

    // 清洗和身份聚合已在事务外完成；本地合并、ID 重映射、日志写入与裁剪必须基于同一事务快照提交。
    return this.db.transaction('rw', this.db.entries, this.db.reviewLogs, async () => {
      const existingEntries = await this.db.entries.toArray();
      const existingByIdentity = new Map(existingEntries.map((entry) => [entry.identityKey, entry]));
      const usedEntryIds = new Set(existingEntries.map((entry) => entry.id));
      const sourceIdToTargetId = new Map<string, string>();
      const entriesToPut: VocabularyEntry[] = [];
      let inserted = 0;
      let updated = 0;

      for (const candidate of grouped.values()) {
        const existing = existingByIdentity.get(candidate.entry.identityKey);
        if (existing) {
          const merged = mergeImportedEntry(existing, candidate.entry);
          candidate.sourceIds.forEach((sourceId) => {
            if (!ambiguousSourceIds.has(sourceId)) sourceIdToTargetId.set(sourceId, existing.id);
          });
          if (JSON.stringify(merged) === JSON.stringify(existing)) {
            skipped += 1;
          } else {
            entriesToPut.push(merged);
            existingByIdentity.set(merged.identityKey, merged);
            updated += 1;
          }
          continue;
        }

        let id = candidate.entry.id;
        if (usedEntryIds.has(id)) id = createUniqueUuid(usedEntryIds);
        else usedEntryIds.add(id);
        const insertedEntry = {...candidate.entry, id};
        candidate.sourceIds.forEach((sourceId) => {
          if (!ambiguousSourceIds.has(sourceId)) sourceIdToTargetId.set(sourceId, id);
        });
        entriesToPut.push(insertedEntry);
        existingByIdentity.set(insertedEntry.identityKey, insertedEntry);
        inserted += 1;
      }

      if (existingEntries.length + inserted > VOCABULARY_BOOK_MAX_ENTRIES) {
        throw new VocabularyBookError(
          'limit-exceeded',
          `Import would exceed the ${VOCABULARY_BOOK_MAX_ENTRIES}-entry limit.`,
        );
      }
      if (entriesToPut.length > 0) await this.db.entries.bulkPut(entriesToPut);

      const affectedEntryIds = new Set(sourceIdToTargetId.values());
      const sanitizedLogs: VocabularyReviewLog[] = [];
      for (const rawLog of rawReviewLogs) {
        const log = sanitizeImportReviewLog(rawLog, sourceIdToTargetId);
        if (!log) {
          skipped += 1;
          continue;
        }
        sanitizedLogs.push(log);
      }
      const collidingLogs = sanitizedLogs.length
        ? await this.db.reviewLogs.bulkGet(sanitizedLogs.map((log) => log.id))
        : [];
      const usedLogIds = new Set(
        collidingLogs.filter((log): log is VocabularyReviewLog => Boolean(log)).map((log) => log.id),
      );
      const logsToAdd: VocabularyReviewLog[] = [];
      for (const log of sanitizedLogs) {
        // 复习日志不可变：重复导入同一备份应保持幂等，恶意 ID 冲突也不能覆盖其他词条的日志。
        if (usedLogIds.has(log.id)) {
          skipped += 1;
          continue;
        }
        usedLogIds.add(log.id);
        logsToAdd.push(log);
      }

      if (logsToAdd.length > 0) await this.db.reviewLogs.bulkAdd(logsToAdd);
      const deletedLogIds = new Set<string>();
      for (const entryId of affectedEntryIds) {
        for (const deletedId of await this.pruneReviewLogs(entryId)) deletedLogIds.add(deletedId);
      }
      const retainedImportedLogs = logsToAdd.reduce(
        (count, log) => count + (deletedLogIds.has(log.id) ? 0 : 1),
        0,
      );
      skipped += logsToAdd.length - retainedImportedLogs;

      return {
        inserted,
        updated,
        skipped,
        reviewLogsImported: retainedImportedLogs,
      };
    });
  }
}

export const vocabularyBook = new VocabularyBookRepository();
