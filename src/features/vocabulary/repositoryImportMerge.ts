/**
 * @file src/features/vocabulary/repositoryImportMerge.ts
 * 文件职责：封装词书 JSON 导入时的记录清洗、同词条候选归并、本地与导入学习进度合并及复习日志校验重映射。
 * 主要内容：重建导入词条的规范身份键并过滤异常译文与上下文，按最新复习状态与解释更新时间合并重复或已有词条，并将复习日志的源 ID 安全映射到目标词条。
 * 模块边界：纯导入清洗与合并策略模块，不直接操作 IndexedDB 事务，基础清洗函数复用 repositorySanitize。
 */
import {
  VOCABULARY_ENTRY_SCHEMA_VERSION,
  mergeVocabularyNotes,
  normalizeLearningSourceText,
  type VocabularyContext,
  type VocabularyEntry,
  type VocabularyReviewLog,
  type VocabularyReviewRating,
  type VocabularyTranslationSnapshot,
  type VocabularyTranslations,
} from './learningModel';
import {
  MAX_PART_OF_SPEECH_LENGTH,
  MAX_PHONETIC_LENGTH,
  MAX_TRANSLATION_LENGTH,
  VALID_REVIEW_RATINGS,
  buildVocabularyIdentityKey,
  cloneEntry,
  createUuid,
  isPlainRecord,
  isUuid,
  mergeTranslations,
  mergeVocabularyContexts,
  normalizeVocabularyLanguage,
  normalizeVocabularyTerm,
  sanitizeCount,
  sanitizeMasteryLevel,
  sanitizeNullableTimestamp,
  sanitizeText,
  sanitizeTimestamp,
  sanitizeVocabularyContext,
  vocabularyStatusForLevel,
} from './repositorySanitize';

export interface SanitizedImportEntry {
  entry: VocabularyEntry;
  sourceIds: string[];
}

function sanitizeImportTranslations(
  value: unknown,
  fallbackUpdatedAt: number,
): VocabularyTranslations {
  if (!isPlainRecord(value)) return {};
  const translations = new Map<string, VocabularyTranslationSnapshot>();

  for (const [rawLanguage, rawSnapshot] of Object.entries(value)) {
    const language = normalizeVocabularyLanguage(rawLanguage);
    if (!language || !isPlainRecord(rawSnapshot)) continue;
    const text = sanitizeText(rawSnapshot.text, MAX_TRANSLATION_LENGTH);
    if (!text) continue;
    const snapshot = {
      text,
      updatedAt: sanitizeTimestamp(rawSnapshot.updatedAt, fallbackUpdatedAt),
    };
    const previous = translations.get(language);
    if (!previous || snapshot.updatedAt >= previous.updatedAt) translations.set(language, snapshot);
  }

  return Object.fromEntries(translations);
}

export function sanitizeImportEntry(value: unknown, now: number): SanitizedImportEntry | null {
  if (!isPlainRecord(value)) return null;
  const sourceLanguage = normalizeVocabularyLanguage(value.sourceLanguage);
  const term = normalizeLearningSourceText(value.term);
  const normalizedTerm = normalizeVocabularyTerm(term);
  const identityKey = buildVocabularyIdentityKey(sourceLanguage, normalizedTerm);
  if (!sourceLanguage || !term || !normalizedTerm || !identityKey) return null;

  const initialCreatedAt = sanitizeTimestamp(value.createdAt, now);
  const initialUpdatedAt = sanitizeTimestamp(value.updatedAt, initialCreatedAt);
  const translations = sanitizeImportTranslations(value.translations, initialUpdatedAt);
  if (Object.keys(translations).length === 0 && (!isPlainRecord(value.translations) || Object.keys(value.translations).length > 0)) return null;
  const contexts = Array.isArray(value.contexts)
    ? value.contexts
        .map((context) => sanitizeVocabularyContext(context, initialUpdatedAt))
        .filter((context): context is VocabularyContext => context !== null)
    : [];
  const masteryLevel = sanitizeMasteryLevel(value.masteryLevel);
  const reviewCount = sanitizeCount(value.reviewCount, 0);
  // 导入文件里的子记录数可能很大，逐个归约避免展开为无界函数实参。
  let latestChildUpdate = initialUpdatedAt;
  for (const snapshot of Object.values(translations)) latestChildUpdate = Math.max(latestChildUpdate, snapshot.updatedAt);
  for (const context of contexts) latestChildUpdate = Math.max(latestChildUpdate, context.capturedAt);
  const createdAt = Math.min(initialCreatedAt, latestChildUpdate);
  const updatedAt = latestChildUpdate;
  const id = isUuid(value.id) ? value.id : createUuid();
  const sourceIds = isUuid(value.id) ? [value.id] : [];
  const fallbackNextReviewAt = masteryLevel === 5 ? null : updatedAt;
  const importedNextReviewAt = sanitizeNullableTimestamp(value.nextReviewAt, fallbackNextReviewAt);

  return {
    sourceIds,
    entry: {
      id,
      identityKey,
      sourceLanguage,
      term,
      normalizedTerm,
      translations,
      ...(value.kind === 'sentence' || value.kind === 'expression' ? {kind: value.kind} : {}),
      ...(typeof value.note === 'string' ? {note: sanitizeText(value.note, 2_000), noteUpdatedAt: sanitizeTimestamp(value.noteUpdatedAt, initialUpdatedAt)} : {}),
      phonetic: sanitizeText(value.phonetic, MAX_PHONETIC_LENGTH),
      partOfSpeech: sanitizeText(value.partOfSpeech, MAX_PART_OF_SPEECH_LENGTH),
      contexts: mergeVocabularyContexts([], contexts),
      createdAt,
      updatedAt,
      lastSeenAt: Math.max(createdAt, sanitizeTimestamp(value.lastSeenAt, updatedAt)),
      encounterCount: sanitizeCount(value.encounterCount, 1, 1),
      masteryLevel,
      status: vocabularyStatusForLevel(masteryLevel, reviewCount),
      nextReviewAt:
        masteryLevel === 5 ? importedNextReviewAt : (importedNextReviewAt ?? updatedAt),
      lastReviewedAt: sanitizeNullableTimestamp(value.lastReviewedAt, null),
      reviewCount,
      lapseCount: Math.min(reviewCount, sanitizeCount(value.lapseCount, 0)),
      schemaVersion: VOCABULARY_ENTRY_SCHEMA_VERSION,
    },
  };
}

function newerLearningState(left: VocabularyEntry, right: VocabularyEntry): VocabularyEntry {
  const leftReviewedAt = left.lastReviewedAt ?? -1;
  const rightReviewedAt = right.lastReviewedAt ?? -1;
  if (leftReviewedAt !== rightReviewedAt) return rightReviewedAt > leftReviewedAt ? right : left;
  if (left.reviewCount !== right.reviewCount) return right.reviewCount > left.reviewCount ? right : left;
  if (left.lapseCount !== right.lapseCount) return right.lapseCount > left.lapseCount ? right : left;
  return right.updatedAt >= left.updatedAt ? right : left;
}

export function mergeImportCandidates(
  left: SanitizedImportEntry,
  right: SanitizedImportEntry,
): SanitizedImportEntry {
  const newer = right.entry.updatedAt >= left.entry.updatedAt ? right.entry : left.entry;
  const older = newer === right.entry ? left.entry : right.entry;
  const learning = newerLearningState(left.entry, right.entry);
  return {
    sourceIds: [...new Set([...left.sourceIds, ...right.sourceIds])],
    entry: {
      ...cloneEntry(newer),
      ...mergeVocabularyNotes(newer, older),
      ...(newer.kind || older.kind ? {kind: newer.kind || older.kind} : {}),
      createdAt: Math.min(left.entry.createdAt, right.entry.createdAt),
      updatedAt: Math.max(left.entry.updatedAt, right.entry.updatedAt),
      lastSeenAt: Math.max(left.entry.lastSeenAt, right.entry.lastSeenAt),
      encounterCount: Math.max(left.entry.encounterCount, right.entry.encounterCount),
      translations: mergeTranslations(older.translations, newer.translations),
      contexts: mergeVocabularyContexts(older.contexts, newer.contexts),
      phonetic: newer.phonetic || older.phonetic,
      partOfSpeech: newer.partOfSpeech || older.partOfSpeech,
      masteryLevel: learning.masteryLevel,
      status: learning.status,
      nextReviewAt: learning.nextReviewAt,
      lastReviewedAt: learning.lastReviewedAt,
      reviewCount: learning.reviewCount,
      lapseCount: learning.lapseCount,
    },
  };
}

export function mergeImportedEntry(local: VocabularyEntry, incoming: VocabularyEntry): VocabularyEntry {
  const incomingIsNewer = incoming.updatedAt > local.updatedAt;
  const primary = incomingIsNewer ? incoming : local;
  const secondary = incomingIsNewer ? local : incoming;
  const learning = newerLearningState(local, incoming);
  return {
    ...cloneEntry(primary),
    ...mergeVocabularyNotes(primary, secondary),
    ...(primary.kind || secondary.kind ? {kind: primary.kind || secondary.kind} : {}),
    id: local.id,
    identityKey: local.identityKey,
    sourceLanguage: local.sourceLanguage,
    createdAt: Math.min(local.createdAt, incoming.createdAt),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    lastSeenAt: Math.max(local.lastSeenAt, incoming.lastSeenAt),
    encounterCount: Math.max(local.encounterCount, incoming.encounterCount),
    translations: mergeTranslations(secondary.translations, primary.translations),
    contexts: mergeVocabularyContexts(secondary.contexts, primary.contexts),
    phonetic: primary.phonetic || secondary.phonetic,
    partOfSpeech: primary.partOfSpeech || secondary.partOfSpeech,
    masteryLevel: learning.masteryLevel,
    status: learning.status,
    nextReviewAt: learning.nextReviewAt,
    lastReviewedAt: learning.lastReviewedAt,
    reviewCount: learning.reviewCount,
    lapseCount: learning.lapseCount,
    schemaVersion: VOCABULARY_ENTRY_SCHEMA_VERSION,
  };
}

export function sanitizeImportReviewLog(
  value: unknown,
  sourceIdToTargetId: Map<string, string>,
): VocabularyReviewLog | null {
  if (!isPlainRecord(value) || typeof value.entryId !== 'string') return null;
  const entryId = sourceIdToTargetId.get(value.entryId);
  if (!entryId || !VALID_REVIEW_RATINGS.has(value.rating as VocabularyReviewRating)) return null;
  const reviewedAt = sanitizeNullableTimestamp(value.reviewedAt, null);
  if (reviewedAt === null) return null;

  return {
    id: isUuid(value.id) ? value.id : createUuid(),
    entryId,
    rating: value.rating as VocabularyReviewRating,
    reviewedAt,
    beforeLevel: sanitizeMasteryLevel(value.beforeLevel),
    afterLevel: sanitizeMasteryLevel(value.afterLevel),
    nextReviewAt: sanitizeNullableTimestamp(value.nextReviewAt, null),
  };
}
