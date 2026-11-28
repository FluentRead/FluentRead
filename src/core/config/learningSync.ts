/**
 * @file src/core/config/learningSync.ts
 * 文件职责：定义云备份学习资产的纯领域数据协议、严格容量边界、确定性合并算法与差异预览统计。
 * 主要内容：覆盖单词本、个人校订与阅读材料元数据三类可选同步范围，执行防原型污染与体积校验、按身份和时间戳无损合并复习进度与笔记，并计算每类新增和更新数量供确认预览。
 * 模块边界：只处理纯数据结构与确定性算法，不依赖 IndexedDB、浏览器存储、网络请求或上层业务特性模块。
 */
export const LEARNING_SYNC_FORMAT = 'fluentread-learning-sync' as const;
export const LEARNING_SYNC_VERSION = 1 as const;
export const LEARNING_SYNC_MAX_BYTES = 12 * 1024 * 1024;
export const LEARNING_SYNC_MAX_TREE_NODES = 50_000;
export const LEARNING_SYNC_MAX_VOCABULARY = 5_000;
export const LEARNING_SYNC_MAX_VOCABULARY_CONTEXTS = 8;
export const LEARNING_SYNC_MAX_VOCABULARY_TRANSLATIONS = 64;
export const LEARNING_SYNC_MAX_CORRECTIONS = 1_000;
export const LEARNING_SYNC_MAX_CORRECTION_PROJECTS = 100;
export const LEARNING_SYNC_MAX_CORRECTIONS_BYTES = 4 * 1024 * 1024;
export const LEARNING_SYNC_MAX_MATERIALS = 2_000;
export const LEARNING_SYNC_MAX_MATERIAL_URL = 8_192 * 16 + 16;
export const LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT = 256;
export const LEARNING_SYNC_MAX_MATERIAL_TOPICS = 30;
export const LEARNING_SYNC_MAX_MATERIAL_NOTES = 200;

const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CORRECTION_MATERIAL_ID_PATTERN = /^material-[a-f0-9]{64}$/;
const CORRECTION_LANGUAGE_PATTERN = /^(?:auto|[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*)$/;

export class LearningSyncError extends Error {}

export interface LearningSyncScope {
    includeVocabulary: boolean;
    includeVocabularyContext: boolean;
    includePersonalCorrections: boolean;
    includeReadingMaterials: boolean;
}

export const DEFAULT_LEARNING_SYNC_SCOPE: Readonly<LearningSyncScope> = Object.freeze({
    includeVocabulary: false,
    includeVocabularyContext: false,
    includePersonalCorrections: false,
    includeReadingMaterials: false,
});

export interface LearningSyncVocabularyContext {
    capturedAt: number;
    text?: string;
    sourceUrl?: string;
    pageTitle?: string;
}

export interface LearningSyncVocabularyTranslation {
    text: string;
    updatedAt: number;
}

export interface LearningSyncVocabularyEntry {
    id: string;
    identityKey: string;
    sourceLanguage: string;
    term: string;
    normalizedTerm: string;
    kind?: 'sentence' | 'expression';
    note?: string;
    noteUpdatedAt?: number;
    translations: Record<string, LearningSyncVocabularyTranslation>;
    phonetic: string;
    partOfSpeech: string;
    contexts: LearningSyncVocabularyContext[];
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    encounterCount: number;
    masteryLevel: 0 | 1 | 2 | 3 | 4 | 5;
    status: 'new' | 'learning' | 'familiar' | 'mastered';
    nextReviewAt: number | null;
    lastReviewedAt: number | null;
    reviewCount: number;
    lapseCount: number;
    schemaVersion: 1;
}

export interface LearningSyncVocabularySection {
    includesContext: boolean;
    entries: LearningSyncVocabularyEntry[];
}

export interface LearningSyncCorrectionScope {
    kind: 'material' | 'project';
    id: string;
    label: string;
}

export interface LearningSyncCorrectionEntry {
    id: string;
    scope: LearningSyncCorrectionScope;
    source: string;
    translation: string;
    sourceLanguage: string;
    targetLanguage: string;
    context: string;
    revision: number;
    updatedAt?: number;
}

export interface LearningSyncCorrectionProject {
    id: string;
    label: string;
}

export interface LearningSyncCorrectionMembership {
    materialId: string;
    projectId: string;
}

export interface LearningSyncPersonalCorrections {
    version: 1;
    revision: number;
    entries: LearningSyncCorrectionEntry[];
    projects: LearningSyncCorrectionProject[];
    memberships: LearningSyncCorrectionMembership[];
}

export interface LearningSyncMaterialNote {
    id: string;
    excerpt?: string;
    note?: string;
    createdAt?: number;
    updatedAt?: number;
}

export interface LearningSyncMaterialLocator {
    kind: 'text' | 'document' | 'video';
    quote?: string;
    page?: number;
    section?: string;
    startMs?: number;
    endMs?: number;
    fingerprint?: string;
}

export interface LearningSyncMaterialSource {
    kind: 'article' | 'document' | 'video';
    url?: string;
    title?: string;
    fingerprint?: string;
}

export interface LearningSyncReadingMaterial {
    id: string;
    identityKey: string;
    aliases?: string[];
    kind: 'article' | 'document' | 'video';
    title: string;
    source: LearningSyncMaterialSource;
    locator?: LearningSyncMaterialLocator;
    topics: string[];
    notes: LearningSyncMaterialNote[];
    createdAt: number;
    updatedAt: number;
    lastReadAt: number;
    archivedAt: number | null;
}

export interface LearningSyncBundle {
    format: typeof LEARNING_SYNC_FORMAT;
    version: typeof LEARNING_SYNC_VERSION;
    vocabulary?: LearningSyncVocabularySection;
    personalCorrections?: LearningSyncPersonalCorrections;
    readingMaterials?: LearningSyncReadingMaterial[];
}

export interface LearningCategoryDiffSummary {
    enabled: boolean;
    remoteAvailable: boolean;
    localCount: number;
    remoteCount: number;
    addedFromRemote: number;
    updatedFromRemote: number;
    addedToRemote: number;
    updatedToRemote: number;
    hasChanges: boolean;
}

export interface LearningSyncPreviewSummary {
    vocabulary: LearningCategoryDiffSummary;
    personalCorrections: LearningCategoryDiffSummary;
    readingMaterials: LearningCategoryDiffSummary;
    hasAnyChanges: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeTree(value: unknown, depth = 0, budget = {nodes: 0}): void {
    if (depth > 20) throw new LearningSyncError('学习同步数据结构过深');
    if (!value || typeof value !== 'object') return;
    if (++budget.nodes > LEARNING_SYNC_MAX_TREE_NODES) throw new LearningSyncError('学习同步数据结构节点过多');
    for (const [key, child] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            throw new LearningSyncError('学习同步数据包含无效字段');
        }
        assertSafeTree(child, depth + 1, budget);
    }
}

function assertUuidV4(value: unknown, label: string): string {
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
        throw new LearningSyncError(`学习同步字段「${label}」无效`);
    }
    return value.toLowerCase();
}

function assertCorrectionMaterialId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !CORRECTION_MATERIAL_ID_PATTERN.test(value)) {
        throw new LearningSyncError(`学习同步字段「${label}」无效`);
    }
    return value;
}

function assertCorrectionLanguage(value: unknown, label: string): string {
    if (typeof value !== 'string' || !CORRECTION_LANGUAGE_PATTERN.test(value)) {
        throw new LearningSyncError(`学习同步字段「${label}」无效`);
    }
    return value;
}

function createUniqueUuidV4(used: Set<string>): string {
    const candidate = crypto.randomUUID().toLowerCase();
    used.add(candidate);
    return candidate;
}

function assertBoundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
        throw new LearningSyncError(`学习同步字段「${label}」无效`);
    }
    return value;
}

function assertNonNegativeFinite(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new LearningSyncError(`学习同步数值「${label}」无效`);
    }
    return value;
}

function assertNullableTimestamp(value: unknown, label: string): number | null {
    return value === null ? null : assertNonNegativeFinite(value, label);
}

function assertNonNegativeInt(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new LearningSyncError(`学习同步计数「${label}」无效`);
    }
    return value;
}

export function normalizeLearningSyncScope(input?: unknown): LearningSyncScope {
    if (input === undefined || input === null) return {...DEFAULT_LEARNING_SYNC_SCOPE};
    if (!isPlainRecord(input)) throw new LearningSyncError('学习数据同步范围无效');
    const boolField = (name: keyof LearningSyncScope): boolean => {
        const value = input[name];
        if (value === undefined) return false;
        if (typeof value !== 'boolean') throw new LearningSyncError(`学习数据同步选项 ${name} 必须为布尔值`);
        return value;
    };
    const includeVocabulary = boolField('includeVocabulary');
    return {
        includeVocabulary,
        includeVocabularyContext: includeVocabulary && boolField('includeVocabularyContext'),
        includePersonalCorrections: boolField('includePersonalCorrections'),
        includeReadingMaterials: boolField('includeReadingMaterials'),
    };
}

export function hasAnyLearningSyncScope(scope: LearningSyncScope): boolean {
    return scope.includeVocabulary || scope.includePersonalCorrections || scope.includeReadingMaterials;
}

function validateVocabularyEntry(raw: unknown): LearningSyncVocabularyEntry {
    if (!isPlainRecord(raw)) throw new LearningSyncError('单词本同步条目无效');
    const id = assertBoundedString(raw.id, 'vocabulary.id', 128);
    const identityKey = assertBoundedString(raw.identityKey, 'vocabulary.identityKey', 4_200);
    const sourceLanguage = assertBoundedString(raw.sourceLanguage, 'vocabulary.sourceLanguage', 64);
    const term = assertBoundedString(raw.term, 'vocabulary.term', 4_096);
    const normalizedTerm = assertBoundedString(raw.normalizedTerm, 'vocabulary.normalizedTerm', 4_096);
    if (raw.kind !== undefined && raw.kind !== 'sentence' && raw.kind !== 'expression') {
        throw new LearningSyncError('单词本条目类型无效');
    }
    if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 2_000)) {
        throw new LearningSyncError('单词本条目笔记无效');
    }
    if (raw.noteUpdatedAt !== undefined) assertNonNegativeFinite(raw.noteUpdatedAt, 'vocabulary.noteUpdatedAt');
    if (!isPlainRecord(raw.translations)) throw new LearningSyncError('单词本译文映射无效');
    const translationEntries = Object.entries(raw.translations);
    if (translationEntries.length > LEARNING_SYNC_MAX_VOCABULARY_TRANSLATIONS) {
        throw new LearningSyncError('单词本译文语言数量超出上限');
    }
    const translations: Record<string, LearningSyncVocabularyTranslation> = {};
    for (const [lang, snapshot] of translationEntries) {
        assertBoundedString(lang, 'vocabulary.translationLang', 64);
        if (!isPlainRecord(snapshot)) throw new LearningSyncError('单词本译文条目无效');
        translations[lang] = {
            text: assertBoundedString(snapshot.text, 'vocabulary.translationText', 8_000, true),
            updatedAt: assertNonNegativeFinite(snapshot.updatedAt, 'vocabulary.translationUpdatedAt'),
        };
    }
    const phonetic = assertBoundedString(raw.phonetic, 'vocabulary.phonetic', 256, true);
    const partOfSpeech = assertBoundedString(raw.partOfSpeech, 'vocabulary.partOfSpeech', 128, true);
    if (!Array.isArray(raw.contexts) || raw.contexts.length > LEARNING_SYNC_MAX_VOCABULARY_CONTEXTS) {
        throw new LearningSyncError('单词本上下文列表无效');
    }
    const contexts: LearningSyncVocabularyContext[] = raw.contexts.map(ctx => {
        if (!isPlainRecord(ctx)) throw new LearningSyncError('单词本上下文条目无效');
        return {
            capturedAt: assertNonNegativeFinite(ctx.capturedAt, 'vocabulary.context.capturedAt'),
            ...(ctx.text !== undefined ? {text: assertBoundedString(ctx.text, 'vocabulary.context.text', 6_000, true)} : {}),
            ...(ctx.sourceUrl !== undefined ? {sourceUrl: assertBoundedString(ctx.sourceUrl, 'vocabulary.context.sourceUrl', 2_048, true)} : {}),
            ...(ctx.pageTitle !== undefined ? {pageTitle: assertBoundedString(ctx.pageTitle, 'vocabulary.context.pageTitle', 200, true)} : {}),
        };
    });
    const masteryLevel = raw.masteryLevel;
    if (typeof masteryLevel !== 'number' || !Number.isInteger(masteryLevel) || masteryLevel < 0 || masteryLevel > 5) {
        throw new LearningSyncError('单词本掌握度无效');
    }
    if (raw.status !== 'new' && raw.status !== 'learning' && raw.status !== 'familiar' && raw.status !== 'mastered') {
        throw new LearningSyncError('单词本学习状态无效');
    }
    if (raw.schemaVersion !== 1) throw new LearningSyncError('单词本条目版本无效');
    return {
        id, identityKey, sourceLanguage, term, normalizedTerm,
        ...(raw.kind ? {kind: raw.kind} : {}),
        ...(raw.note !== undefined ? {note: raw.note} : {}),
        ...(raw.noteUpdatedAt !== undefined ? {noteUpdatedAt: raw.noteUpdatedAt as number} : {}),
        translations, phonetic, partOfSpeech, contexts,
        createdAt: assertNonNegativeFinite(raw.createdAt, 'vocabulary.createdAt'),
        updatedAt: assertNonNegativeFinite(raw.updatedAt, 'vocabulary.updatedAt'),
        lastSeenAt: assertNonNegativeFinite(raw.lastSeenAt, 'vocabulary.lastSeenAt'),
        encounterCount: assertNonNegativeInt(raw.encounterCount, 'vocabulary.encounterCount'),
        masteryLevel: masteryLevel as LearningSyncVocabularyEntry['masteryLevel'],
        status: raw.status,
        nextReviewAt: assertNullableTimestamp(raw.nextReviewAt, 'vocabulary.nextReviewAt'),
        lastReviewedAt: assertNullableTimestamp(raw.lastReviewedAt, 'vocabulary.lastReviewedAt'),
        reviewCount: assertNonNegativeInt(raw.reviewCount, 'vocabulary.reviewCount'),
        lapseCount: assertNonNegativeInt(raw.lapseCount, 'vocabulary.lapseCount'),
        schemaVersion: 1,
    };
}

function validatePersonalCorrections(raw: unknown): LearningSyncPersonalCorrections {
    if (!isPlainRecord(raw) || raw.version !== 1) throw new LearningSyncError('个人校订同步格式无效');
    const revision = assertNonNegativeInt(raw.revision, 'corrections.revision');
    if (!Array.isArray(raw.entries) || raw.entries.length > LEARNING_SYNC_MAX_CORRECTIONS
        || !Array.isArray(raw.projects) || raw.projects.length > LEARNING_SYNC_MAX_CORRECTION_PROJECTS
        || !Array.isArray(raw.memberships) || raw.memberships.length > LEARNING_SYNC_MAX_CORRECTIONS) {
        throw new LearningSyncError('个人校订同步条目超出限制');
    }
    const projects: LearningSyncCorrectionProject[] = raw.projects.map(project => {
        if (!isPlainRecord(project)) throw new LearningSyncError('个人校订项目无效');
        return {
            id: assertUuidV4(project.id, 'corrections.project.id'),
            label: assertBoundedString(project.label, 'corrections.project.label', 80),
        };
    });
    const projectIds = new Set(projects.map(project => project.id));
    if (projectIds.size !== projects.length) throw new LearningSyncError('个人校订项目标识重复');
    const entries: LearningSyncCorrectionEntry[] = raw.entries.map(entry => {
        if (!isPlainRecord(entry) || !isPlainRecord(entry.scope)) throw new LearningSyncError('个人校订记录无效');
        const kind = entry.scope.kind;
        if (kind !== 'material' && kind !== 'project') throw new LearningSyncError('个人校订范围无效');
        const scopeId = kind === 'material'
            ? assertCorrectionMaterialId(entry.scope.id, 'corrections.scope.id')
            : assertUuidV4(entry.scope.id, 'corrections.scope.id');
        if (kind === 'project' && !projectIds.has(scopeId)) throw new LearningSyncError('个人校订引用了不存在的项目');
        const entryRevision = assertNonNegativeInt(entry.revision, 'corrections.entry.revision');
        if (entryRevision < 1 || entryRevision > revision) throw new LearningSyncError('个人校订记录版本无效');
        return {
            id: assertUuidV4(entry.id, 'corrections.entry.id'),
            scope: {kind, id: scopeId, label: assertBoundedString(entry.scope.label, 'corrections.scope.label', 80)},
            source: assertBoundedString(entry.source, 'corrections.source', 20_000),
            translation: assertBoundedString(entry.translation, 'corrections.translation', 20_000),
            sourceLanguage: assertCorrectionLanguage(entry.sourceLanguage, 'corrections.sourceLanguage'),
            targetLanguage: assertCorrectionLanguage(entry.targetLanguage, 'corrections.targetLanguage'),
            context: assertBoundedString(entry.context, 'corrections.context', 4_000, true),
            revision: entryRevision,
            ...(entry.updatedAt !== undefined ? {updatedAt: assertNonNegativeFinite(entry.updatedAt, 'corrections.entry.updatedAt')} : {}),
        };
    });
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new LearningSyncError('个人校订记录标识重复');
    const memberships: LearningSyncCorrectionMembership[] = raw.memberships.map(item => {
        if (!isPlainRecord(item)) throw new LearningSyncError('个人校订归属关系无效');
        const projectId = assertUuidV4(item.projectId, 'corrections.membership.projectId');
        if (!projectIds.has(projectId)) throw new LearningSyncError('个人校订归属引用了不存在的项目');
        return {
            materialId: assertCorrectionMaterialId(item.materialId, 'corrections.membership.materialId'),
            projectId,
        };
    });
    if (new Set(memberships.map(item => item.materialId)).size !== memberships.length) throw new LearningSyncError('个人校订归属材料重复');
    const validated: LearningSyncPersonalCorrections = {version: 1, revision, entries, projects, memberships};
    if (new TextEncoder().encode(JSON.stringify(validated)).length > LEARNING_SYNC_MAX_CORRECTIONS_BYTES) {
        throw new LearningSyncError('个人校订同步数据超过 4 MiB 上限，请清理后再同步');
    }
    return validated;
}

function validateReadingMaterial(raw: unknown): LearningSyncReadingMaterial {
    if (!isPlainRecord(raw)) throw new LearningSyncError('阅读材料元数据无效');
    if (raw.kind !== 'article' && raw.kind !== 'document' && raw.kind !== 'video') {
        throw new LearningSyncError('阅读材料类型无效');
    }
    if (!isPlainRecord(raw.source) || raw.source.kind !== raw.kind) {
        throw new LearningSyncError('阅读材料来源元数据无效');
    }
    const source: LearningSyncMaterialSource = {
        kind: raw.kind,
        ...(raw.source.url !== undefined ? {url: assertBoundedString(raw.source.url, 'material.source.url', LEARNING_SYNC_MAX_MATERIAL_URL, true)} : {}),
        ...(raw.source.title !== undefined ? {title: assertBoundedString(raw.source.title, 'material.source.title', 240, true)} : {}),
        ...(raw.source.fingerprint !== undefined ? {fingerprint: assertBoundedString(raw.source.fingerprint, 'material.source.fingerprint', LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT, true)} : {}),
    };
    let locator: LearningSyncMaterialLocator | undefined;
    if (raw.locator !== undefined) {
        if (!isPlainRecord(raw.locator) || (raw.locator.kind !== 'text' && raw.locator.kind !== 'document' && raw.locator.kind !== 'video')) {
            throw new LearningSyncError('阅读材料进度位置无效');
        }
        let page: number | undefined;
        if (raw.locator.page !== undefined) {
            page = assertNonNegativeInt(raw.locator.page, 'material.locator.page');
            if (page < 1 || page > 1_000_000) throw new LearningSyncError('学习同步计数「material.locator.page」无效');
        }
        locator = {
            kind: raw.locator.kind,
            ...(raw.locator.quote !== undefined ? {quote: assertBoundedString(raw.locator.quote, 'material.locator.quote', 6_000, true)} : {}),
            ...(page !== undefined ? {page} : {}),
            ...(raw.locator.section !== undefined ? {section: assertBoundedString(raw.locator.section, 'material.locator.section', 240, true)} : {}),
            ...(raw.locator.startMs !== undefined ? {startMs: assertNonNegativeFinite(raw.locator.startMs, 'material.locator.startMs')} : {}),
            ...(raw.locator.endMs !== undefined ? {endMs: assertNonNegativeFinite(raw.locator.endMs, 'material.locator.endMs')} : {}),
            ...(raw.locator.fingerprint !== undefined ? {fingerprint: assertBoundedString(raw.locator.fingerprint, 'material.locator.fingerprint', LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT, true)} : {}),
        };
    }
    if (!Array.isArray(raw.topics) || raw.topics.length > LEARNING_SYNC_MAX_MATERIAL_TOPICS) {
        throw new LearningSyncError('阅读材料主题列表无效');
    }
    const topics = raw.topics.map(topic => assertBoundedString(topic, 'material.topic', 80));
    if (!Array.isArray(raw.notes) || raw.notes.length > LEARNING_SYNC_MAX_MATERIAL_NOTES) {
        throw new LearningSyncError('阅读材料笔记列表无效');
    }
    const notes: LearningSyncMaterialNote[] = raw.notes.map(note => {
        if (!isPlainRecord(note)) throw new LearningSyncError('阅读材料笔记无效');
        return {
            id: assertBoundedString(note.id, 'material.note.id', 256),
            ...(note.excerpt !== undefined ? {excerpt: assertBoundedString(note.excerpt, 'material.note.excerpt', 6_000, true)} : {}),
            ...(note.note !== undefined ? {note: assertBoundedString(note.note, 'material.note.note', 12_000, true)} : {}),
            ...(note.createdAt !== undefined ? {createdAt: assertNonNegativeFinite(note.createdAt, 'material.note.createdAt')} : {}),
            ...(note.updatedAt !== undefined ? {updatedAt: assertNonNegativeFinite(note.updatedAt, 'material.note.updatedAt')} : {}),
        };
    });
    let aliases: string[] | undefined;
    if (raw.aliases !== undefined) {
        if (!Array.isArray(raw.aliases) || raw.aliases.length > 100) throw new LearningSyncError('阅读材料别名无效');
        aliases = raw.aliases.map(alias => assertBoundedString(alias, 'material.alias', LEARNING_SYNC_MAX_MATERIAL_URL + 16));
    }
    return {
        id: assertBoundedString(raw.id, 'material.id', 256),
        identityKey: assertBoundedString(raw.identityKey, 'material.identityKey', LEARNING_SYNC_MAX_MATERIAL_URL + 16),
        ...(aliases ? {aliases} : {}),
        kind: raw.kind,
        title: assertBoundedString(raw.title, 'material.title', 240),
        source,
        ...(locator ? {locator} : {}),
        topics,
        notes,
        createdAt: assertNonNegativeFinite(raw.createdAt, 'material.createdAt'),
        updatedAt: assertNonNegativeFinite(raw.updatedAt, 'material.updatedAt'),
        lastReadAt: assertNonNegativeFinite(raw.lastReadAt, 'material.lastReadAt'),
        archivedAt: assertNullableTimestamp(raw.archivedAt, 'material.archivedAt'),
    };
}

export function validateLearningSyncBundle(value: unknown): LearningSyncBundle {
    assertSafeTree(value);
    if (!isPlainRecord(value) || value.format !== LEARNING_SYNC_FORMAT || value.version !== LEARNING_SYNC_VERSION) {
        throw new LearningSyncError('学习同步数据格式或版本不受支持');
    }
    const bundle: LearningSyncBundle = {format: LEARNING_SYNC_FORMAT, version: LEARNING_SYNC_VERSION};
    if (value.vocabulary !== undefined) {
        if (!isPlainRecord(value.vocabulary) || typeof value.vocabulary.includesContext !== 'boolean'
            || !Array.isArray(value.vocabulary.entries) || value.vocabulary.entries.length > LEARNING_SYNC_MAX_VOCABULARY) {
            throw new LearningSyncError('单词本同步数据超出限制或格式无效');
        }
        bundle.vocabulary = {
            includesContext: value.vocabulary.includesContext,
            entries: value.vocabulary.entries.map(validateVocabularyEntry),
        };
    }
    if (value.personalCorrections !== undefined) {
        bundle.personalCorrections = validatePersonalCorrections(value.personalCorrections);
    }
    if (value.readingMaterials !== undefined) {
        if (!Array.isArray(value.readingMaterials) || value.readingMaterials.length > LEARNING_SYNC_MAX_MATERIALS) {
            throw new LearningSyncError('阅读材料同步数据超出限制或格式无效');
        }
        bundle.readingMaterials = value.readingMaterials.map(validateReadingMaterial);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(bundle)).length;
    if (bytes > LEARNING_SYNC_MAX_BYTES) {
        throw new LearningSyncError('学习同步数据超过 12 MiB 上限，请减少同步内容后重试');
    }
    return bundle;
}

function stripContext(context: LearningSyncVocabularyContext, includeContext: boolean): LearningSyncVocabularyContext {
    return includeContext ? {...context} : {capturedAt: context.capturedAt};
}

function mergeVocabularyContexts(
    left: readonly LearningSyncVocabularyContext[],
    right: readonly LearningSyncVocabularyContext[],
    includeLocalContext: boolean,
    preserveRemoteContext: boolean,
): LearningSyncVocabularyContext[] {
    const byKey = new Map<string, LearningSyncVocabularyContext>();
    const add = (ctx: LearningSyncVocabularyContext, keepDetails: boolean) => {
        const sanitized = stripContext(ctx, keepDetails);
        const hasDetails = sanitized.text !== undefined || sanitized.sourceUrl !== undefined;
        const key = hasDetails
            ? `${sanitized.text ?? ''}\u0000${sanitized.sourceUrl ?? ''}`
            : `ts\u0000${sanitized.capturedAt}`;
        const prev = byKey.get(key);
        if (!prev || sanitized.capturedAt >= prev.capturedAt) byKey.set(key, sanitized);
    };
    for (const ctx of left) add(ctx, includeLocalContext);
    for (const ctx of right) add(ctx, preserveRemoteContext);
    return [...byKey.values()]
        .sort((a, b) => a.capturedAt - b.capturedAt)
        .slice(-LEARNING_SYNC_MAX_VOCABULARY_CONTEXTS);
}

function mergeVocabularyEntry(
    local: LearningSyncVocabularyEntry,
    remote: LearningSyncVocabularyEntry,
    includeLocalContext: boolean,
    preserveRemoteContext: boolean,
): LearningSyncVocabularyEntry {
    const translations: Record<string, LearningSyncVocabularyTranslation> = {};
    for (const [lang, snap] of [...Object.entries(local.translations), ...Object.entries(remote.translations)]) {
        const prev = translations[lang];
        if (!prev || snap.updatedAt >= prev.updatedAt) translations[lang] = {...snap};
    }
    const noteSource = (remote.noteUpdatedAt ?? 0) > (local.noteUpdatedAt ?? 0) ? remote : local;
    const localReviewRank = local.lastReviewedAt ?? -1;
    const remoteReviewRank = remote.lastReviewedAt ?? -1;
    const remoteReviewWins = remoteReviewRank > localReviewRank
        || (remoteReviewRank === localReviewRank && remote.reviewCount > local.reviewCount)
        || (remoteReviewRank === localReviewRank && remote.reviewCount === local.reviewCount && remote.updatedAt > local.updatedAt);
    const reviewSource = remoteReviewWins ? remote : local;
    const newerMeta = remote.updatedAt > local.updatedAt ? remote : local;
    const kind = newerMeta.kind ?? local.kind ?? remote.kind;
    return {
        id: local.id,
        identityKey: local.identityKey,
        sourceLanguage: local.sourceLanguage,
        term: newerMeta.term,
        normalizedTerm: local.normalizedTerm,
        ...(kind ? {kind} : {}),
        ...(noteSource.noteUpdatedAt !== undefined ? {note: noteSource.note ?? '', noteUpdatedAt: noteSource.noteUpdatedAt} : {}),
        translations,
        phonetic: newerMeta.phonetic || local.phonetic || remote.phonetic,
        partOfSpeech: newerMeta.partOfSpeech || local.partOfSpeech || remote.partOfSpeech,
        contexts: mergeVocabularyContexts(local.contexts, remote.contexts, includeLocalContext, preserveRemoteContext),
        createdAt: Math.min(local.createdAt, remote.createdAt),
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
        lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt),
        encounterCount: Math.max(local.encounterCount, remote.encounterCount),
        masteryLevel: reviewSource.masteryLevel,
        status: reviewSource.status,
        nextReviewAt: reviewSource.nextReviewAt,
        lastReviewedAt: reviewSource.lastReviewedAt,
        reviewCount: Math.max(local.reviewCount, remote.reviewCount),
        lapseCount: Math.max(local.lapseCount, remote.lapseCount),
        schemaVersion: 1,
    };
}

export function mergeLearningVocabulary(
    local: LearningSyncVocabularySection | undefined,
    remote: LearningSyncVocabularySection | undefined,
    includeContext: boolean,
): {merged: LearningSyncVocabularySection; diff: Omit<LearningCategoryDiffSummary, 'enabled' | 'remoteAvailable'>} {
    const localEntries = local?.entries ?? [];
    const remoteEntries = remote?.entries ?? [];
    const preserveRemoteContext = includeContext || remote?.includesContext === true;
    const localMap = new Map(localEntries.map(entry => [entry.identityKey, entry]));
    const remoteMap = new Map(remoteEntries.map(entry => [entry.identityKey, entry]));
    const mergedEntries: LearningSyncVocabularyEntry[] = [];
    let addedFromRemote = 0;
    let updatedFromRemote = 0;
    let addedToRemote = 0;
    let updatedToRemote = 0;

    for (const entry of localEntries) {
        const peer = remoteMap.get(entry.identityKey);
        if (!peer) {
            addedToRemote++;
            mergedEntries.push({...entry, contexts: entry.contexts.map(c => stripContext(c, includeContext))});
        } else {
            const combined = mergeVocabularyEntry(entry, peer, includeContext, preserveRemoteContext);
            const localView = {...combined, contexts: combined.contexts.map(c => stripContext(c, includeContext))};
            const normalizedLocal = {...entry, contexts: entry.contexts.map(c => stripContext(c, includeContext))};
            const normalizedRemote = {...peer, id: entry.id, contexts: peer.contexts.map(c => stripContext(c, preserveRemoteContext))};
            if (JSON.stringify(localView) !== JSON.stringify(normalizedLocal)) updatedFromRemote++;
            if (JSON.stringify(combined) !== JSON.stringify(normalizedRemote)) updatedToRemote++;
            mergedEntries.push(combined);
        }
    }
    for (const peer of remoteEntries) {
        if (!localMap.has(peer.identityKey)) {
            addedFromRemote++;
            mergedEntries.push({...peer, contexts: peer.contexts.map(c => stripContext(c, preserveRemoteContext))});
        }
    }
    if (mergedEntries.length > LEARNING_SYNC_MAX_VOCABULARY) {
        throw new LearningSyncError('合并后的单词本超出 5000 条上限，请清理后再同步');
    }
    mergedEntries.sort((a, b) => a.createdAt - b.createdAt || a.identityKey.localeCompare(b.identityKey));
    return {
        merged: {includesContext: preserveRemoteContext, entries: mergedEntries},
        diff: {
            localCount: localEntries.length,
            remoteCount: remoteEntries.length,
            addedFromRemote,
            updatedFromRemote,
            addedToRemote,
            updatedToRemote,
            hasChanges: addedFromRemote > 0 || updatedFromRemote > 0 || addedToRemote > 0 || updatedToRemote > 0,
        },
    };
}

function correctionIdentity(entry: LearningSyncCorrectionEntry): string {
    return `${entry.scope.kind}\u0000${entry.scope.id}\u0000${entry.sourceLanguage}\u0000${entry.targetLanguage}\u0000${entry.source}`;
}

function correctionWins(candidate: LearningSyncCorrectionEntry, current: LearningSyncCorrectionEntry): boolean {
    const candidateTime = candidate.updatedAt ?? 0;
    const currentTime = current.updatedAt ?? 0;
    if (candidateTime !== currentTime) return candidateTime > currentTime;
    if (candidate.revision !== current.revision) return candidate.revision > current.revision;
    return false;
}

export function mergeLearningPersonalCorrections(
    local: LearningSyncPersonalCorrections | undefined,
    remote: LearningSyncPersonalCorrections | undefined,
): {merged: LearningSyncPersonalCorrections; diff: Omit<LearningCategoryDiffSummary, 'enabled' | 'remoteAvailable'>} {
    const empty: LearningSyncPersonalCorrections = {version: 1, revision: 0, entries: [], projects: [], memberships: []};
    const left = local ?? empty;
    const right = remote ?? empty;

    const projectMap = new Map<string, LearningSyncCorrectionProject>();
    for (const project of left.projects) projectMap.set(project.id, {...project});
    for (const project of right.projects) {
        if (!projectMap.has(project.id) && projectMap.size < LEARNING_SYNC_MAX_CORRECTION_PROJECTS) {
            projectMap.set(project.id, {...project});
        }
    }

    const membershipMap = new Map<string, LearningSyncCorrectionMembership>();
    for (const item of left.memberships) {
        if (projectMap.has(item.projectId)) membershipMap.set(item.materialId, {...item});
    }
    for (const item of right.memberships) {
        if (!projectMap.has(item.projectId)) continue;
        if (!membershipMap.has(item.materialId) || right.revision > left.revision) {
            membershipMap.set(item.materialId, {...item});
        }
    }

    const localByKey = new Map(left.entries.map(entry => [correctionIdentity(entry), entry]));
    const remoteByKey = new Map(right.entries.map(entry => [correctionIdentity(entry), entry]));
    const usedEntryIds = new Set<string>();
    const mergedEntries: LearningSyncCorrectionEntry[] = [];
    let addedFromRemote = 0;
    let updatedFromRemote = 0;
    let addedToRemote = 0;
    let updatedToRemote = 0;

    for (const entry of left.entries) {
        const key = correctionIdentity(entry);
        const peer = remoteByKey.get(key);
        usedEntryIds.add(entry.id);
        if (!peer) {
            addedToRemote++;
            mergedEntries.push({...entry, scope: {...entry.scope}});
        } else if (correctionWins(peer, entry)) {
            updatedFromRemote++;
            mergedEntries.push({...peer, id: entry.id, scope: {...peer.scope}});
        } else {
            if (JSON.stringify({...entry, id: peer.id}) !== JSON.stringify(peer)) updatedToRemote++;
            mergedEntries.push({...entry, scope: {...entry.scope}});
        }
    }
    for (const peer of right.entries) {
        const key = correctionIdentity(peer);
        if (!localByKey.has(key) && mergedEntries.length < LEARNING_SYNC_MAX_CORRECTIONS) {
            if (peer.scope.kind === 'project' && !projectMap.has(peer.scope.id)) continue;
            const peerId = usedEntryIds.has(peer.id) ? createUniqueUuidV4(usedEntryIds) : peer.id;
            usedEntryIds.add(peerId);
            addedFromRemote++;
            mergedEntries.push({...peer, id: peerId, scope: {...peer.scope}});
        }
    }

    const maxEntryRevision = mergedEntries.reduce((max, entry) => Math.max(max, entry.revision), 0);
    const revision = Math.max(left.revision, right.revision, maxEntryRevision);
    const projectsChanged = projectMap.size !== left.projects.length || projectMap.size !== right.projects.length;
    const membershipsChanged = membershipMap.size !== left.memberships.length || membershipMap.size !== right.memberships.length;
    return {
        merged: {
            version: 1,
            revision,
            entries: mergedEntries,
            projects: [...projectMap.values()],
            memberships: [...membershipMap.values()].slice(0, LEARNING_SYNC_MAX_CORRECTIONS),
        },
        diff: {
            localCount: left.entries.length,
            remoteCount: right.entries.length,
            addedFromRemote,
            updatedFromRemote,
            addedToRemote,
            updatedToRemote,
            hasChanges: addedFromRemote > 0 || updatedFromRemote > 0 || addedToRemote > 0 || updatedToRemote > 0 || projectsChanged || membershipsChanged,
        },
    };
}

function mergeMaterialNotes(
    left: readonly LearningSyncMaterialNote[],
    right: readonly LearningSyncMaterialNote[],
): LearningSyncMaterialNote[] {
    const byId = new Map<string, LearningSyncMaterialNote>();
    for (const note of [...left, ...right]) {
        const prev = byId.get(note.id);
        const noteTime = note.updatedAt ?? note.createdAt ?? 0;
        const prevTime = prev ? (prev.updatedAt ?? prev.createdAt ?? 0) : -1;
        if (!prev || noteTime >= prevTime) byId.set(note.id, {...note});
    }
    return [...byId.values()].slice(0, LEARNING_SYNC_MAX_MATERIAL_NOTES);
}

function mergeReadingMaterialRecord(
    local: LearningSyncReadingMaterial,
    remote: LearningSyncReadingMaterial,
): LearningSyncReadingMaterial {
    const newer = remote.updatedAt > local.updatedAt ? remote : local;
    const furtherProgress = remote.lastReadAt > local.lastReadAt ? remote : local;
    const topics = [...new Set([...local.topics, ...remote.topics])].slice(0, LEARNING_SYNC_MAX_MATERIAL_TOPICS);
    const aliases = [...new Set([...(local.aliases ?? []), ...(remote.aliases ?? [])])]
        .filter(alias => alias !== local.identityKey)
        .slice(-100);
    const locator = furtherProgress.locator ?? local.locator ?? remote.locator;
    const fingerprint = newer.source.fingerprint ?? local.source.fingerprint ?? remote.source.fingerprint;
    const source: LearningSyncMaterialSource = {
        ...newer.source,
        ...(fingerprint ? {fingerprint} : {}),
    };
    return {
        id: local.id,
        identityKey: local.identityKey,
        ...(aliases.length ? {aliases} : {}),
        kind: local.kind,
        title: newer.title,
        source,
        ...(locator ? {locator: {...locator}} : {}),
        topics,
        notes: mergeMaterialNotes(local.notes, remote.notes),
        createdAt: Math.min(local.createdAt, remote.createdAt),
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
        lastReadAt: Math.max(local.lastReadAt, remote.lastReadAt),
        archivedAt: newer.archivedAt,
    };
}

export function mergeLearningReadingMaterials(
    local: readonly LearningSyncReadingMaterial[] | undefined,
    remote: readonly LearningSyncReadingMaterial[] | undefined,
): {merged: LearningSyncReadingMaterial[]; diff: Omit<LearningCategoryDiffSummary, 'enabled' | 'remoteAvailable'>} {
    const localList = local ?? [];
    const remoteList = remote ?? [];
    const localMap = new Map(localList.map(item => [item.identityKey, item]));
    const remoteMap = new Map(remoteList.map(item => [item.identityKey, item]));
    const merged: LearningSyncReadingMaterial[] = [];
    let addedFromRemote = 0;
    let updatedFromRemote = 0;
    let addedToRemote = 0;
    let updatedToRemote = 0;

    for (const item of localList) {
        const peer = remoteMap.get(item.identityKey);
        if (!peer) {
            addedToRemote++;
            merged.push(structuredClone(item));
        } else {
            const combined = mergeReadingMaterialRecord(item, peer);
            if (JSON.stringify(combined) !== JSON.stringify(item)) updatedFromRemote++;
            if (JSON.stringify(combined) !== JSON.stringify({...peer, id: item.id})) updatedToRemote++;
            merged.push(combined);
        }
    }
    for (const peer of remoteList) {
        if (!localMap.has(peer.identityKey)) {
            addedFromRemote++;
            merged.push(structuredClone(peer));
        }
    }
    merged.sort((a, b) => b.lastReadAt - a.lastReadAt || a.identityKey.localeCompare(b.identityKey));
    return {
        merged: merged.slice(0, LEARNING_SYNC_MAX_MATERIALS),
        diff: {
            localCount: localList.length,
            remoteCount: remoteList.length,
            addedFromRemote,
            updatedFromRemote,
            addedToRemote,
            updatedToRemote,
            hasChanges: addedFromRemote > 0 || updatedFromRemote > 0 || addedToRemote > 0 || updatedToRemote > 0,
        },
    };
}

function disabledCategorySummary(remoteCount: number, remoteAvailable: boolean): LearningCategoryDiffSummary {
    return {
        enabled: false,
        remoteAvailable,
        localCount: 0,
        remoteCount,
        addedFromRemote: 0,
        updatedFromRemote: 0,
        addedToRemote: 0,
        updatedToRemote: 0,
        hasChanges: false,
    };
}

export function buildLearningSyncDiff(
    scope: LearningSyncScope,
    local: LearningSyncBundle | null,
    remote: LearningSyncBundle | null,
): {merged: LearningSyncBundle; summary: LearningSyncPreviewSummary} {
    const merged: LearningSyncBundle = {format: LEARNING_SYNC_FORMAT, version: LEARNING_SYNC_VERSION};

    let vocabularySummary: LearningCategoryDiffSummary;
    if (scope.includeVocabulary) {
        const result = mergeLearningVocabulary(local?.vocabulary, remote?.vocabulary, scope.includeVocabularyContext);
        merged.vocabulary = result.merged;
        vocabularySummary = {enabled: true, remoteAvailable: Boolean(remote?.vocabulary), ...result.diff};
    } else {
        if (remote?.vocabulary) merged.vocabulary = structuredClone(remote.vocabulary);
        vocabularySummary = disabledCategorySummary(remote?.vocabulary?.entries.length ?? 0, Boolean(remote?.vocabulary));
    }

    let correctionsSummary: LearningCategoryDiffSummary;
    if (scope.includePersonalCorrections) {
        const result = mergeLearningPersonalCorrections(local?.personalCorrections, remote?.personalCorrections);
        merged.personalCorrections = result.merged;
        correctionsSummary = {enabled: true, remoteAvailable: Boolean(remote?.personalCorrections), ...result.diff};
    } else {
        if (remote?.personalCorrections) merged.personalCorrections = structuredClone(remote.personalCorrections);
        correctionsSummary = disabledCategorySummary(remote?.personalCorrections?.entries.length ?? 0, Boolean(remote?.personalCorrections));
    }

    let materialsSummary: LearningCategoryDiffSummary;
    if (scope.includeReadingMaterials) {
        const result = mergeLearningReadingMaterials(local?.readingMaterials, remote?.readingMaterials);
        merged.readingMaterials = result.merged;
        materialsSummary = {enabled: true, remoteAvailable: Boolean(remote?.readingMaterials), ...result.diff};
    } else {
        if (remote?.readingMaterials) merged.readingMaterials = structuredClone(remote.readingMaterials);
        materialsSummary = disabledCategorySummary(remote?.readingMaterials?.length ?? 0, Boolean(remote?.readingMaterials));
    }

    return {
        merged,
        summary: {
            vocabulary: vocabularySummary,
            personalCorrections: correctionsSummary,
            readingMaterials: materialsSummary,
            hasAnyChanges: vocabularySummary.hasChanges || correctionsSummary.hasChanges || materialsSummary.hasChanges,
        },
    };
}

export function hasLearningBundleContent(bundle: LearningSyncBundle | null | undefined): boolean {
    return Boolean(bundle && (bundle.vocabulary || bundle.personalCorrections || bundle.readingMaterials));
}
