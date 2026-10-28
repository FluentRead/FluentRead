/**
 * @file src/features/vocabulary/repository.ts
 * 文件职责：实现 FluentRead 本地单词与句子收藏的 Dexie 持久化仓库，负责多语种记录清洗、兼容旧词条的唯一身份、上下文合并、复习调度、删除撤销以及安全导入导出。
 * 主要内容：定义数据库 schema、语言和 URL 规范化、掌握状态/间隔算法，提供收藏增删查改、独立解释更新、review、按解释时间合并的 JSON 导入和导出；视频语境校验平台与原始时间，片段参与去重，私密导出才携带来源；候选保留八条，避免无界排序与实参。
 * 模块边界：仓库只拥有本地 IndexedDB 数据与领域不变量，不处理 runtime 消息或渲染界面；后台 handler 负责权限和广播，learningModel 提供纯会话模型，敏感上下文默认不导出。
 */
import Dexie, { type Table } from 'dexie';
import {sanitizeVocabularyVideoSource, sanitizeVocabularyVideoUrl} from './source';
import {
  VOCABULARY_BOOK_EXPORT_FORMAT,
  VOCABULARY_BOOK_EXPORT_VERSION,
  VOCABULARY_BOOK_MAX_ENTRIES,
  VOCABULARY_ENTRY_MAX_CONTEXTS,
  VOCABULARY_ENTRY_SCHEMA_VERSION,
  VOCABULARY_REVIEW_LOG_MAX_PER_ENTRY,
  VOCABULARY_SOURCE_TEXT_MAX,
  normalizeLearningSourceText,
  mergeVocabularyNotes,
  type VocabularyBookErrorCode,
  type VocabularyBookExport,
  type VocabularyContext,
  type VocabularyContextInput,
  type VocabularyEntry,
  type VocabularyExportEntry,
  type VocabularyExportOptions,
  type VocabularyImportResult,
  type VocabularyListOptions,
  type VocabularyMasteryLevel,
  type VocabularyReviewLog,
  type VocabularyReviewRating,
  type VocabularyReviewResult,
  type VocabularyRemovalSnapshot,
  type VocabularyUndoRecord,
  type VocabularyScheduledReviewRating,
  type VocabularyStatus,
  type VocabularyTranslationSnapshot,
  type VocabularyTranslations,
  type VocabularyUpsertInput,
} from './learningModel';

export * from './learningModel';

/**
 * 词汇本垂直切片的领域规则与 IndexedDB 仓储。
 *
 * 步骤 1：所有外部输入先在本模块归一化并重建 identity，绝不信任导入文件里的派生字段。
 * 步骤 2：词条、复习进度与日志在同一 Dexie 事务中更新，避免 MV3 worker 中途休眠留下半状态。
 * 步骤 3：导出默认移除页面正文和地址；只有调用方明确选择时才携带私密上下文。
 */

export const VOCABULARY_REVIEW_AGAIN_DELAY_MS = 10 * 60 * 1000;
export const VOCABULARY_REVIEW_GOOD_INTERVALS_MS = [
  1 * 24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
] as const;

const MAX_TRANSLATION_LENGTH = 8_000;
const MAX_CONTEXT_LENGTH = 500;
const MAX_VIDEO_CONTEXT_LENGTH = 6_000;
const MAX_PAGE_TITLE_LENGTH = 200;
const MAX_PHONETIC_LENGTH = 256;
const MAX_PART_OF_SPEECH_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_REVIEW_RATINGS = new Set<VocabularyReviewRating>([
  'again',
  'good',
  'manual-mastered',
  'relearn',
]);

type PlainRecord = Record<string, unknown>;

interface SanitizedImportEntry {
  entry: VocabularyEntry;
  sourceIds: string[];
}

export interface VocabularyReviewSchedule {
  masteryLevel: VocabularyMasteryLevel;
  status: VocabularyStatus;
  nextReviewAt: number | null;
  lapseDelta: 0 | 1;
}

export class VocabularyBookError extends Error {
  constructor(
    readonly code: VocabularyBookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VocabularyBookError';
  }
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : fallback;
}

function sanitizeNullableTimestamp(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : fallback;
}

function sanitizeCount(value: unknown, fallback: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(value, Number.MAX_SAFE_INTEGER));
}

function sanitizeMasteryLevel(value: unknown): VocabularyMasteryLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
    ? (value as VocabularyMasteryLevel)
    : 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createUniqueUuid(usedIds: Set<string>): string {
  let id = createUuid();
  while (usedIds.has(id)) id = createUuid();
  usedIds.add(id);
  return id;
}

export function normalizeVocabularyLanguage(value: unknown): string {
  const normalized = sanitizeText(value, MAX_LANGUAGE_LENGTH).replaceAll('_', '-').toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : '';
}

function normalizeComparableText(value: unknown, maxLength: number): string {
  return sanitizeText(value, maxLength)
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .toLocaleLowerCase('en-US');
}

export function buildVocabularyIdentityKey(sourceLanguage: unknown, term: unknown): string {
  const language = normalizeVocabularyLanguage(sourceLanguage);
  const normalizedTerm = normalizeVocabularyTerm(term);
  if (!language || !normalizedTerm) return '';
  return `${language}\u0000${normalizedTerm}`;
}

/** 词与句子共用旧 identity 规则，保留旧英文词条 ID，不另建数据库或批量改写历史。 */
export function normalizeVocabularyTerm(value: unknown): string {
  const text = normalizeLearningSourceText(value);
  const normalized = normalizeComparableText(text, VOCABULARY_SOURCE_TEXT_MAX + 1);
  return normalized.length <= VOCABULARY_SOURCE_TEXT_MAX ? normalized : '';
}

export function sanitizeVocabularySourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const sanitized = url.toString();
    return sanitized.length <= 2_048 ? sanitized : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeVocabularyContext(
  value: VocabularyContextInput | unknown,
  now = Date.now(),
): VocabularyContext | null {
  if (!isPlainRecord(value)) return null;
  const video = sanitizeVocabularyVideoSource(value.video);
  const text = sanitizeText(value.text, video ? MAX_VIDEO_CONTEXT_LENGTH : MAX_CONTEXT_LENGTH);
  if (!text) return null;

  const sourceUrl = value.video === undefined ? sanitizeVocabularySourceUrl(value.sourceUrl)
    : video ? sanitizeVocabularyVideoUrl(value.sourceUrl, video.platform) : undefined;
  const pageTitle = sanitizeText(value.pageTitle, MAX_PAGE_TITLE_LENGTH) || undefined;
  return {
    text,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(video ? {video} : {}),
    capturedAt: sanitizeTimestamp(value.capturedAt, now),
  };
}

function contextIdentity(context: VocabularyContext): string {
  const videoIdentity = context.video ? `\u0000${context.video.platform}:${context.video.startMs}:${context.video.endMs}` : '';
  return `${normalizeComparableText(context.text, context.video ? MAX_VIDEO_CONTEXT_LENGTH : MAX_CONTEXT_LENGTH)}\u0000${context.sourceUrl ?? ''}${videoIdentity}`;
}

function cloneContext(context: VocabularyContext): VocabularyContext {
  return {...context, ...(context.video ? {video: {...context.video}} : {})};
}

export function mergeVocabularyContexts(
  existing: readonly VocabularyContext[],
  incoming: readonly VocabularyContext[],
): VocabularyContext[] {
  const byIdentity = new Map<string, VocabularyContext>();

  for (const contexts of [existing, incoming]) {
    for (const context of contexts) {
      const identity = contextIdentity(context);
      const previous = byIdentity.get(identity);
      if (!previous || context.capturedAt >= previous.capturedAt) {
        byIdentity.set(identity, cloneContext(context));
      }
    }
  }

  // Map 保留身份的首次出现位置；只维护八条候选，并列时仍选后出现的身份。
  const newest: VocabularyContext[] = [];
  for (const context of byIdentity.values()) {
    // 仓库输入已经清洗；公开 helper 对未清洗时间继续保持旧排序行为。
    if (!Number.isFinite(context.capturedAt)) {
      return [...byIdentity.values()]
        .sort((left, right) => left.capturedAt - right.capturedAt)
        .slice(-VOCABULARY_ENTRY_MAX_CONTEXTS);
    }
    if (newest.length === VOCABULARY_ENTRY_MAX_CONTEXTS && context.capturedAt < newest[0].capturedAt) continue;
    let position = newest.length;
    while (position > 0 && newest[position - 1].capturedAt > context.capturedAt) position -= 1;
    newest.splice(position, 0, context);
    if (newest.length > VOCABULARY_ENTRY_MAX_CONTEXTS) newest.shift();
  }
  return newest;
}

function mergeTranslations(
  existing: VocabularyTranslations,
  incoming: VocabularyTranslations,
): VocabularyTranslations {
  const merged = new Map<string, VocabularyTranslationSnapshot>();
  for (const [language, snapshot] of [...Object.entries(existing), ...Object.entries(incoming)]) {
    const previous = merged.get(language);
    if (!previous || snapshot.updatedAt >= previous.updatedAt) {
      merged.set(language, { ...snapshot });
    }
  }
  return Object.fromEntries(merged);
}

export function vocabularyStatusForLevel(
  masteryLevel: VocabularyMasteryLevel,
  reviewCount: number,
): VocabularyStatus {
  if (masteryLevel === 5) return 'mastered';
  if (masteryLevel >= 3) return 'familiar';
  if (masteryLevel === 0 && reviewCount === 0) return 'new';
  return 'learning';
}

export function scheduleVocabularyReview(
  masteryLevel: VocabularyMasteryLevel,
  rating: VocabularyScheduledReviewRating,
  now = Date.now(),
): VocabularyReviewSchedule {
  if (rating === 'again') {
    return {
      masteryLevel: 0,
      status: 'learning',
      nextReviewAt: now + VOCABULARY_REVIEW_AGAIN_DELAY_MS,
      lapseDelta: 1,
    };
  }

  const nextLevel = Math.min(5, masteryLevel + 1) as VocabularyMasteryLevel;
  const intervalIndex = Math.min(masteryLevel, VOCABULARY_REVIEW_GOOD_INTERVALS_MS.length - 1);
  return {
    masteryLevel: nextLevel,
    status: vocabularyStatusForLevel(nextLevel, 1),
    nextReviewAt: now + VOCABULARY_REVIEW_GOOD_INTERVALS_MS[intervalIndex]!,
    lapseDelta: 0,
  };
}

function cloneTranslations(translations: VocabularyTranslations): VocabularyTranslations {
  return Object.fromEntries(
    Object.entries(translations).map(([language, snapshot]) => [language, { ...snapshot }]),
  );
}

export function cloneEntry(entry: VocabularyEntry): VocabularyEntry {
  return {
    ...entry,
    translations: cloneTranslations(entry.translations),
    contexts: entry.contexts.map(cloneContext),
  };
}

function prepareUpsert(input: VocabularyUpsertInput, now: number) {
  if (!isPlainRecord(input)) {
    throw new VocabularyBookError('invalid-input', 'Vocabulary entry must be an object.');
  }

  const sourceLanguage = normalizeVocabularyLanguage(input.sourceLanguage);
  const targetLanguage = normalizeVocabularyLanguage(input.targetLanguage);
  const term = normalizeLearningSourceText(input.term);
  const normalizedTerm = normalizeVocabularyTerm(term);
  const translation = sanitizeText(input.translation, MAX_TRANSLATION_LENGTH);
  const identityKey = buildVocabularyIdentityKey(sourceLanguage, normalizedTerm);
  if (!sourceLanguage || !targetLanguage || !term || !normalizedTerm || typeof input.translation !== 'string' || !identityKey) {
    throw new VocabularyBookError(
      'invalid-input',
      'Source language, target language, valid source text and a translation string are required.',
    );
  }

  const rawContexts = [
    ...(input.context ? [input.context] : []),
    ...(Array.isArray(input.contexts) ? input.contexts : []),
  ];
  const contexts = rawContexts
    .map((context) => sanitizeVocabularyContext(context, now))
    .filter((context): context is VocabularyContext => context !== null);
  const partOfSpeech = Array.isArray(input.partOfSpeech)
    ? [...new Set(input.partOfSpeech.map((item) => sanitizeText(item, MAX_PART_OF_SPEECH_LENGTH)).filter(Boolean))]
        .join(', ')
        .slice(0, MAX_PART_OF_SPEECH_LENGTH)
    : sanitizeText(input.partOfSpeech, MAX_PART_OF_SPEECH_LENGTH);

  return {
    sourceLanguage,
    targetLanguage,
    term,
    normalizedTerm,
    translation,
    ...(input.kind === 'sentence' || input.kind === 'expression' ? {kind: input.kind} : {}),
    ...(typeof input.note === 'string' ? {note: sanitizeText(input.note, 2_000), noteUpdatedAt: now} : {}),
    identityKey,
    phonetic: sanitizeText(input.phonetic, MAX_PHONETIC_LENGTH),
    partOfSpeech,
    contexts,
  };
}

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
            [prepared.targetLanguage]: { text: prepared.translation, updatedAt: now },
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
          [prepared.targetLanguage]: { text: prepared.translation, updatedAt },
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
      return { entry: cloneEntry(updated), log: { ...log } };
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
        .map((log) => ({ ...log }));
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
          .map((log) => ({ ...log })),
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
            includePrivateContext ? cloneContext(context) : { capturedAt: context.capturedAt },
          ),
        })),
        reviewLogs: reviewLogs.map((log) => ({ ...log })),
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
        const insertedEntry = { ...candidate.entry, id };
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

function sanitizeImportEntry(value: unknown, now: number): SanitizedImportEntry | null {
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

function mergeImportCandidates(
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

function newerLearningState(left: VocabularyEntry, right: VocabularyEntry): VocabularyEntry {
  const leftReviewedAt = left.lastReviewedAt ?? -1;
  const rightReviewedAt = right.lastReviewedAt ?? -1;
  if (leftReviewedAt !== rightReviewedAt) return rightReviewedAt > leftReviewedAt ? right : left;
  if (left.reviewCount !== right.reviewCount) return right.reviewCount > left.reviewCount ? right : left;
  if (left.lapseCount !== right.lapseCount) return right.lapseCount > left.lapseCount ? right : left;
  return right.updatedAt >= left.updatedAt ? right : left;
}

function mergeImportedEntry(local: VocabularyEntry, incoming: VocabularyEntry): VocabularyEntry {
  const incomingIsNewer = incoming.updatedAt > local.updatedAt;
  const primary = incomingIsNewer ? incoming : local;
  const secondary = incomingIsNewer ? local : incoming;
  const learning = newerLearningState(local, incoming);
  const merged: VocabularyEntry = {
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
  return merged;
}

function sanitizeImportReviewLog(
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

export const vocabularyBook = new VocabularyBookRepository();
