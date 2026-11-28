/**
 * @file src/features/vocabulary/repositorySanitize.ts
 * 文件职责：封装词书仓储的输入清洗、语言与词形身份归一化、URL 脱敏、上下文/译文合并及艾宾浩斯复习调度纯算法。
 * 主要内容：提供文本控制字符清理、安全时间戳/计数/UUID 工具、视频与网页上下文去重合并、掌握等级与复习间隔计算、词条深拷贝及 upsert 参数预处理。
 * 模块边界：纯数据校验与领域计算模块，不接触 Dexie 数据库事务、扩展消息或前端界面状态。
 */
import {sanitizeVocabularyVideoSource, sanitizeVocabularyVideoUrl} from './source';
import {
  VOCABULARY_ENTRY_MAX_CONTEXTS,
  VOCABULARY_SOURCE_TEXT_MAX,
  normalizeLearningSourceText,
  type VocabularyBookErrorCode,
  type VocabularyContext,
  type VocabularyContextInput,
  type VocabularyEntry,
  type VocabularyMasteryLevel,
  type VocabularyReviewRating,
  type VocabularyScheduledReviewRating,
  type VocabularyStatus,
  type VocabularyTranslationSnapshot,
  type VocabularyTranslations,
  type VocabularyUpsertInput,
} from './learningModel';

export const VOCABULARY_REVIEW_AGAIN_DELAY_MS = 10 * 60 * 1000;
export const VOCABULARY_REVIEW_GOOD_INTERVALS_MS = [
  1 * 24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
] as const;

export const MAX_TRANSLATION_LENGTH = 8_000;
export const MAX_PHONETIC_LENGTH = 256;
export const MAX_PART_OF_SPEECH_LENGTH = 128;
const MAX_CONTEXT_LENGTH = 500;
const MAX_VIDEO_CONTEXT_LENGTH = 6_000;
const MAX_PAGE_TITLE_LENGTH = 200;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VALID_REVIEW_RATINGS = new Set<VocabularyReviewRating>([
  'again',
  'good',
  'manual-mastered',
  'relearn',
]);

export type PlainRecord = Record<string, unknown>;

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

export function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : fallback;
}

export function sanitizeNullableTimestamp(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : fallback;
}

export function sanitizeCount(value: unknown, fallback: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(value, Number.MAX_SAFE_INTEGER));
}

export function sanitizeMasteryLevel(value: unknown): VocabularyMasteryLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
    ? (value as VocabularyMasteryLevel)
    : 0;
}

export function isUuid(value: unknown): value is string {
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

export function createUniqueUuid(usedIds: Set<string>): string {
  let id = createUuid();
  while (usedIds.has(id)) id = createUuid();
  usedIds.add(id);
  return id;
}

export function normalizeVocabularyLanguage(value: unknown): string {
  const normalized = sanitizeText(value, MAX_LANGUAGE_LENGTH).replaceAll('_', '-').toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : '';
}

export function normalizeComparableText(value: unknown, maxLength: number): string {
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
    ...(sourceUrl ? {sourceUrl} : {}),
    ...(pageTitle ? {pageTitle} : {}),
    ...(video ? {video} : {}),
    capturedAt: sanitizeTimestamp(value.capturedAt, now),
  };
}

function contextIdentity(context: VocabularyContext): string {
  const videoIdentity = context.video ? `\u0000${context.video.platform}:${context.video.startMs}:${context.video.endMs}` : '';
  return `${normalizeComparableText(context.text, context.video ? MAX_VIDEO_CONTEXT_LENGTH : MAX_CONTEXT_LENGTH)}\u0000${context.sourceUrl ?? ''}${videoIdentity}`;
}

export function cloneContext(context: VocabularyContext): VocabularyContext {
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

export function mergeTranslations(
  existing: VocabularyTranslations,
  incoming: VocabularyTranslations,
): VocabularyTranslations {
  const merged = new Map<string, VocabularyTranslationSnapshot>();
  for (const [language, snapshot] of [...Object.entries(existing), ...Object.entries(incoming)]) {
    const previous = merged.get(language);
    if (!previous || snapshot.updatedAt >= previous.updatedAt) {
      merged.set(language, {...snapshot});
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
    Object.entries(translations).map(([language, snapshot]) => [language, {...snapshot}]),
  );
}

export function cloneEntry(entry: VocabularyEntry): VocabularyEntry {
  return {
    ...entry,
    translations: cloneTranslations(entry.translations),
    contexts: entry.contexts.map(cloneContext),
  };
}

export function prepareUpsert(input: VocabularyUpsertInput, now: number) {
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
